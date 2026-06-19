# Deploy to AWS ECS + ECR (Docker)

The app is a single FastAPI container that serves both the API and the static
frontend. On ECS the only moving parts are: an **ECR** repo for the image, an
**ECS service** running the task, and an **ALB** that terminates TLS (browsers
require HTTPS for camera + mic).

```
Browser ──HTTPS──▶ ALB (ACM cert) ──HTTP:8000──▶ ECS task (this container)
                                                      │
                                       Deepgram / Anthropic APIs (outbound HTTPS)
```

Prerequisites: AWS CLI v2 configured, Docker, and an ECS cluster (Fargate is
simplest). Set these once:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=interview
export IMAGE="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest"
```

## 1. Build and push to ECR

```bash
# Create the repo once
aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION"

# Log Docker in to ECR
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin \
    "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Build for the platform Fargate runs (linux/amd64 — important on Apple Silicon)
docker build --platform linux/amd64 -t "$IMAGE" .
docker push "$IMAGE"
```

### Optional: image with DeepFace emotion analysis
The default image excludes the heavy TensorFlow/OpenCV stack. To bake it in
(image grows to ~3–4 GB), build with the flag and set `EMOTION_ANALYSIS=1` in
the task definition:

```bash
docker build --platform linux/amd64 --build-arg INCLUDE_EMOTION=true -t "$IMAGE" .
```

## 2. Secrets

Do **not** put API keys in the image or the task definition's plain `environment`.
Store them in Secrets Manager and reference them from the task definition:

```bash
aws secretsmanager create-secret --name interview/deepgram --secret-string "YOUR_DEEPGRAM_KEY"
aws secretsmanager create-secret --name interview/anthropic --secret-string "YOUR_ANTHROPIC_KEY"
```

Give the task's **execution role** `secretsmanager:GetSecretValue` on those ARNs.

> The `DEEPGRAM_ALLOW_BROWSER_KEY` fallback is **local-dev only** — never set it
> on a deployment. Use a Deepgram key that has `grant` permission instead.

## 3. Task definition (Fargate)

Minimal `containerDefinitions` (fill in the secret ARNs and your log group):

```jsonc
{
  "family": "interview",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",          // bump to 1024+ if INCLUDE_EMOTION=true (TensorFlow)
  "memory": "1024",      // bump to 4096+ if INCLUDE_EMOTION=true
  "executionRoleArn": "arn:aws:iam::<ACCOUNT>:role/ecsTaskExecutionRole",
  "containerDefinitions": [{
    "name": "interview",
    "image": "<ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com/interview:latest",
    "portMappings": [{ "containerPort": 8000, "protocol": "tcp" }],
    "environment": [
      // { "name": "EMOTION_ANALYSIS", "value": "1" }   // only if built with INCLUDE_EMOTION=true
    ],
    "secrets": [
      { "name": "DEEPGRAM_API_KEY", "valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT>:secret:interview/deepgram" },
      { "name": "ANTHROPIC_API_KEY", "valueFrom": "arn:aws:secretsmanager:<REGION>:<ACCOUNT>:secret:interview/anthropic" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/interview",
        "awslogs-region": "<REGION>",
        "awslogs-stream-prefix": "interview"
      }
    }
  }]
}
```

Register it: `aws ecs register-task-definition --cli-input-json file://taskdef.json`

## 4. Load balancer + service

- Create an **ALB** with an HTTPS:443 listener using an **ACM certificate** for
  your domain. Add an HTTP:80 listener that redirects to 443.
- Target group: protocol HTTP, port **8000**, target type **ip** (Fargate),
  health check path **`/`** (expects 200 — the app serves `index.html` there).
- Create the ECS service attached to that target group:

```bash
aws ecs create-service \
  --cluster <cluster> \
  --service-name interview \
  --task-definition interview \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-...],securityGroups=[sg-...],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=interview,containerPort=8000"
```

Security groups: ALB SG allows inbound 443 from the internet; the task SG allows
inbound 8000 **only from the ALB SG**. Tasks need outbound 443 to reach the
Deepgram and Anthropic APIs (public subnet + `assignPublicIp`, or private subnet
+ NAT gateway).

Point your domain (Route 53) at the ALB and open `https://<your-domain>/`.

## 5. Redeploy a new version

```bash
docker build --platform linux/amd64 -t "$IMAGE" . && docker push "$IMAGE"
aws ecs update-service --cluster <cluster> --service interview --force-new-deployment
```

## Notes & caveats

- **Session reports are ephemeral.** `sessions/` lives on the task's local disk
  and is lost when the task restarts or scales. If you need reports to persist,
  mount an **EFS** volume at `/app/sessions` in the task definition. This also
  matters if you run `--desired-count` > 1: each task has its own `sessions/`, so
  a report written by one task isn't visible from another. Put a single task
  behind the ALB, or use EFS, if cross-task report access is required.
- **WebSocket:** the Deepgram agent socket is opened **browser → Deepgram
  directly**, not through this server, so no special ALB WebSocket config is
  needed here.
- The EC2 + nginx path in [DEPLOY.md](DEPLOY.md) is an alternative to this; you
  don't need both. On ECS the ALB replaces nginx for TLS termination.
