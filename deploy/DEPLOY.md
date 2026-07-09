# EC2 Deployment

> Local dev needs none of this — `localhost` is a secure context, so camera/mic work over plain HTTP.
> This is only for remote testing on EC2, where browsers require HTTPS.
>
> Prefer containers / AWS ECS + ECR? See [ECS.md](ECS.md) — the ALB replaces nginx
> for TLS there, and you don't need both paths.

## 1. Provision
- Ubuntu 22.04 EC2 instance.
- Security group inbound: 443 (HTTPS), 80 (HTTP → HTTPS redirect + Let's Encrypt validation), 22 (SSH).

## 2. App setup
```bash
sudo apt update && sudo apt install -y python3-venv nginx
git clone <your-repo> interview && cd interview
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt
printf "DEEPGRAM_API_KEY=...\nANTHROPIC_API_KEY=...\n" > .env
```

### Optional: DeepFace emotion analysis
Emotion analysis is off by default. To enable it:
```bash
pip install -r backend/requirements-emotion.txt   # heavy: pulls TensorFlow
```
Add `EMOTION_ANALYSIS=1` to `.env`. First run downloads the ~5 MB emotion model.
Leave it unset to disable (the app and reports work normally without it).

## 3. Run the app (systemd)
Create `/etc/systemd/system/interview.service`:
```ini
[Unit]
Description=Interview app
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/interview
ExecStart=/home/ubuntu/interview/.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
Restart=always
EnvironmentFile=/home/ubuntu/interview/.env
[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now interview
```

## 4. TLS

HTTPS is required for browser camera + mic access. Pick one option.

### Option A — Real domain + trusted cert (recommended)
Example domain: `molave.ai.persolhr.com`. `nginx.conf` already has
`server_name molave.ai.persolhr.com;` — change it if your domain differs.

**Shortcut:** after step 1 (DNS) and step 3 setup, steps 2–4 below are automated by
[`setup-domain.sh`](setup-domain.sh) — run it on the instance from the repo root:
```bash
sudo DOMAIN=molave.ai.persolhr.com bash deploy/setup-domain.sh
```
It is idempotent (safe to re-run). The manual steps follow for reference.

1. **Point DNS at the instance.** Add an A record at your DNS host:
   ```
   A   molave.ai.persolhr.com   →   <ec2-public-ip>
   ```
   Use an Elastic IP so the address survives stop/start. Confirm it resolves before continuing:
   ```bash
   dig +short molave.ai.persolhr.com
   ```
2. **Bootstrap nginx so it can start** (`listen 443 ssl` needs a cert to exist; certbot replaces it next):
   ```bash
   sudo mkdir -p /etc/ssl/interview
   sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -keyout /etc/ssl/interview/key.pem -out /etc/ssl/interview/cert.pem \
     -subj "/CN=molave.ai.persolhr.com"
   sudo cp deploy/nginx.conf /etc/nginx/sites-available/interview
   sudo ln -sf /etc/nginx/sites-available/interview /etc/nginx/sites-enabled/interview
   sudo nginx -t && sudo systemctl restart nginx
   ```
3. **Issue the real cert.** certbot validates over port 80, rewrites the `ssl_certificate` lines, reloads nginx, and installs an auto-renew timer:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d molave.ai.persolhr.com
   ```
4. **Verify.** Open `https://molave.ai.persolhr.com/` (padlock, no warning) and test renewal:
   ```bash
   sudo certbot renew --dry-run
   ```

> Re-copying `deploy/nginx.conf` over the live config later reverts the cert paths to the
> self-signed ones. Re-run `certbot --nginx` (fast — the cert already exists), or point the
> repo config at `/etc/letsencrypt/live/molave.ai.persolhr.com/`.

### Option B — Self-signed (quick test, no domain)
```bash
sudo mkdir -p /etc/ssl/interview
sudo openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/ssl/interview/key.pem -out /etc/ssl/interview/cert.pem -subj "/CN=$(curl -s ifconfig.me)"
sudo cp deploy/nginx.conf /etc/nginx/sites-available/interview
sudo ln -sf /etc/nginx/sites-available/interview /etc/nginx/sites-enabled/interview
sudo nginx -t && sudo systemctl restart nginx
```
Visit `https://<ec2-public-ip>/` and accept the one-time browser warning.

## 5. Re-deploying updates

There is no SSH into this instance — connect over an **AWS SSM Session Manager**
session, then run the committed re-deploy script from the checkout:

```bash
cd /home/ubuntu/interview
sudo bash deploy/redeploy.sh            # deploy latest origin/main
```

The script fetches, `git reset --hard`s the checkout to the target commit,
reinstalls `backend/requirements.txt`, restarts the `interview` service, reloads
nginx, and health-checks `http://127.0.0.1:8000/`. It is idempotent.

- **Commit and push first.** It deploys what is on the remote, not local edits.
- **Roll back / pin a commit:** `sudo bash deploy/redeploy.sh <sha-or-ref>`.
- **`.env` is preserved** — it is git-ignored, so `git reset --hard` never touches it.
- **nginx.conf is not re-synced by default.** Copying it over the live config reverts
  the cert paths to the self-signed bootstrap (see the note under Option A). When
  `nginx.conf` genuinely changed, run `sudo SYNC_NGINX=1 bash deploy/redeploy.sh` —
  it re-copies the config and re-runs certbot to restore the real cert.

> First-run bootstrap: if `redeploy.sh` isn't on the box yet, paste it once, or run
> `cd /home/ubuntu/interview && sudo -u ubuntu git fetch && sudo -u ubuntu git reset --hard origin/main`
> to pull it in, then use the command above.

> This is the manual path. For automated deploy-on-merge over SSM Run Command, see
> [the CI/CD design](../docs/superpowers/specs/2026-07-02-cicd-ssm-deploy-design.md).
