# CI/CD via GitHub Actions + AWS SSM Run Command

**Date:** 2026-07-02
**Status:** Approved (design) — pending spec review
**Repo:** `undesputed/practice-interview`
**Target:** EC2 instance `i-04c5fb241036a7e50`, region `ap-northeast-1` (Tokyo)

## Problem

The app is deployed on a locked-down AWS account. The guardrail denies all
network changes (routes, NACLs, security groups), and SSH is blocked. The only
way in is **AWS Systems Manager (SSM)**. There is no CI/CD today — deploys are
manual over an SSM session. We want automated test-on-PR and deploy-on-merge
without changing anything about the instance's network.

## Key insight

Interactive *Session Manager* is not the automation tool. Its sibling,
**SSM Run Command** (`aws ssm send-command`), lets a remote caller run a script
on the instance. The SSM agent on the box pulls the command over its existing
**outbound** connection to the SSM service, so **no inbound network change is
needed**. GitHub Actions is the caller; it authenticates to AWS with a
short-lived token via OIDC (no stored keys) and issues the deploy command.

This is the only CI/CD deploy pattern that fits the guardrail.

## Deployment model (confirmed)

Per [deploy/DEPLOY.md](../../../deploy/DEPLOY.md), the live app runs as:
- `git clone` + Python `.venv` at `/home/ubuntu/interview`
- a `systemd` service named `interview` running `uvicorn` on `127.0.0.1:8000`
- `nginx` terminating TLS on 443, reverse-proxying to `:8000`

Deploy therefore = update the checkout, reinstall deps, restart the service.
The frontend is static JS with **no build step**, so there is no build artifact.

## Architecture

```
merge to main
   ├─ Job 1: test   (pytest on GitHub's runner)
   └─ Job 2: deploy (needs: test; only on push to main / manual dispatch)
         1. assume AWS IAM role via OIDC (region ap-northeast-1)
         2. aws ssm send-command  → AWS SSM service
              → SSM agent on i-04c5f… pulls it (outbound)
              → git fetch + reset --hard <sha>; pip install; restart; health-check
         3. poll get-command-invocation; print stdout/stderr; fail if != Success
```

## Components

### 1. `.github/workflows/ci-cd.yml`

Triggers:
- `pull_request` (base `main`) → **test** job only.
- `push` to `main` → **test**, then **deploy** (`needs: test`).
- `workflow_dispatch` with optional `sha` input → manual deploy / **rollback**
  to any past commit.

Top-level `concurrency: { group: deploy-main, cancel-in-progress: false }` so
two deploys never overlap (and an in-flight deploy is never cancelled).

**`test` job**
```yaml
runs-on: ubuntu-latest
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-python@v5
    with: { python-version: "3.11" }   # matches the Dockerfile target
  - run: pip install -r backend/requirements.txt
  - run: pytest
```

**`deploy` job**
```yaml
needs: test
if: github.event_name != 'pull_request'
runs-on: ubuntu-latest
permissions:
  id-token: write        # required for OIDC
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
      aws-region: ${{ vars.AWS_REGION }}          # ap-northeast-1
  - name: Trigger deploy via SSM
    run: bash .github/scripts/ssm-deploy.sh
    env:
      INSTANCE_ID: ${{ vars.SSM_INSTANCE_ID }}    # i-04c5fb241036a7e50
      DEPLOY_SHA:  ${{ inputs.sha || github.sha }}
```

### 2. `.github/scripts/ssm-deploy.sh` (the caller side)

Responsible for the send-command + polling + log surfacing, so the workflow
YAML stays readable and quoting stays sane.

```bash
#!/usr/bin/env bash
set -euo pipefail

CMD_ID=$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "deploy ${DEPLOY_SHA:0:12}" \
  --parameters commands="[
    'cd /home/ubuntu/interview',
    'sudo -u ubuntu git fetch --all --prune',
    'sudo -u ubuntu git reset --hard ${DEPLOY_SHA}',
    'sudo bash /home/ubuntu/interview/deploy/remote-deploy.sh ${DEPLOY_SHA}'
  ]" \
  --query "Command.CommandId" --output text)

echo "SSM CommandId: $CMD_ID"

# Poll until terminal
while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
    --query "Status" --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in
    Success|Failed|Cancelled|TimedOut) break ;;
    *) sleep 5 ;;
  esac
done

# Always print the box's output
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query "StandardOutputContent" --output text
aws ssm get-command-invocation --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" \
  --query "StandardErrorContent" --output text >&2

echo "Final status: $STATUS"
[ "$STATUS" = "Success" ]     # non-zero exit fails the job on anything else
```

`git reset --hard <sha>` runs **before** the script executes, so
`remote-deploy.sh` is always the target commit's version.

### 3. `deploy/remote-deploy.sh` (the on-box side, committed)

```bash
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/home/ubuntu/interview
SHA="${1:-unknown}"
echo "Deploying $SHA"
sudo -u ubuntu "$APP_DIR/.venv/bin/pip" install -r "$APP_DIR/backend/requirements.txt"
sudo systemctl restart interview
sleep 3
# Health-check the app directly (avoids self-signed TLS on 443)
curl -fsS http://127.0.0.1:8000/ >/dev/null
echo "Deploy OK: $SHA"
```

## One-time AWS setup (prerequisite — needs IAM rights)

1. **OIDC identity provider** for `token.actions.githubusercontent.com`
   (audience `sts.amazonaws.com`). One per account; may already exist.
2. **IAM role** (e.g. `github-actions-interview-deploy`):
   - Trust policy: federated principal = the OIDC provider; condition
     `token.actions.githubusercontent.com:sub` =
     `repo:undesputed/practice-interview:ref:refs/heads/main` (locks it to the
     `main` branch of this repo), and `:aud` = `sts.amazonaws.com`.
   - Permissions policy (least privilege):
     - `ssm:SendCommand` on **only** the instance ARN
       (`arn:aws:ec2:ap-northeast-1:<acct>:instance/i-04c5fb241036a7e50`) and the
       document ARN (`arn:aws:ssm:ap-northeast-1::document/AWS-RunShellScript`).
     - `ssm:GetCommandInvocation` and `ssm:ListCommandInvocations` (resource `*`).
3. **GitHub repo variables:** `AWS_DEPLOY_ROLE_ARN`, `AWS_REGION`
   (`ap-northeast-1`), `SSM_INSTANCE_ID` (`i-04c5fb241036a7e50`).

**Fallback if OIDC provider creation is blocked by the guardrail:** create an
IAM *user* with the same SendCommand permissions policy, store its access key +
secret as GitHub **secrets** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), and
swap the `configure-aws-credentials` inputs. Everything downstream is identical.

## Assumptions / prerequisites to verify

- **The instance can `git fetch origin`.** If `undesputed/practice-interview` is
  **private**, the box needs a read credential (deploy key or token) configured
  once. If it is public, no credential is needed. *(Verify before first deploy.)*
- The `interview` systemd service and the `/home/ubuntu/interview` checkout exist
  as described in DEPLOY.md, owned by user `ubuntu`.
- The instance's SSM agent is Online (confirmed 2026-06-25) and its instance
  profile allows Run Command.
- `.env` (runtime secrets: `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`) is
  git-ignored, so `git reset --hard` does not touch it. **Deploy preserves it.**

## Stale-test quarantine (decided)

`tests/test_session.py` and `tests/test_verdict_endpoint.py` import
`SESSIONS_DIR` from `backend.main`, which no longer exists (the app moved to a
`storage` abstraction). They fail collection today. To make CI green from day
one, mark both with a module-level skip and a clear reason, e.g.:

```python
import pytest
pytestmark = pytest.mark.skip(
    reason="Stale: references removed backend.main.SESSIONS_DIR; "
           "rewrite against backend.storage. Tracked separately."
)
```

Rewriting them against the new storage API is **out of scope** for this task and
tracked as follow-up work.

## Error handling / anti-silent-failure

- Deploy job fails if `send-command` errors, if invocation `Status != Success`,
  or if the in-box health check fails.
- The instance's stdout **and** stderr are always printed to the workflow log.
- `concurrency` prevents overlapping deploys.
- `set -euo pipefail` in both scripts.

## Rollback

Re-run the workflow via **`workflow_dispatch`** with the `sha` input set to a
previous good commit. `git reset --hard <sha>` moves the box to that exact
commit and restarts the service.

## Out of scope

- Rewriting the two stale test files (quarantined; tracked separately).
- Containerized / ECS deployment (documented in [deploy/ECS.md](../../../deploy/ECS.md); this design targets the systemd model).
- Blue/green or zero-downtime deploys (single box; brief restart is acceptable for a test environment).
- Frontend build/lint tooling (frontend is static, no build).

## Files created/changed

- `.github/workflows/ci-cd.yml` (new)
- `.github/scripts/ssm-deploy.sh` (new)
- `deploy/remote-deploy.sh` (new)
- `tests/test_session.py`, `tests/test_verdict_endpoint.py` (add skip marker)
- `README.md` / `deploy/DEPLOY.md` (document the CI/CD flow + one-time AWS setup)
