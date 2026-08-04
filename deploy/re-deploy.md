# Re-deploy (EC2 / SSM)

How to ship code updates to the live interview app.

There is no SSH into this instance — connect with **AWS SSM Session Manager**, then update the live checkout and restart services.

For first-time provisioning (TLS, nginx, systemd), see [DEPLOY.md](DEPLOY.md).

---

## Before you start

1. **Commit and push** your changes to GitHub (`main`).
   The server only deploys what is on the remote — laptop-only edits are not deployed.
2. Open an **SSM Session Manager** session to the instance.
3. Confirm the live app directory (do not guess from `~`):

```bash
systemctl show interview -p WorkingDirectory -p ExecStart --no-pager
```

### Live paths (current production)

| What | Path |
| --- | --- |
| App checkout | `/opt/interview/practice-interview` |
| systemd service | `interview` |
| uvicorn | `127.0.0.1:8000` |
| nginx | TLS on 443 → proxies to `:8000` |

> **Important:** As `root`, `~/opt/interview/practice-interview` resolves to
> `/root/opt/interview/practice-interview` — that is a **different** folder from
> `/opt/interview/practice-interview`. Always `cd` with the absolute path above.
> Updating the wrong checkout, then restarting `interview`, leaves the old code live.

---

## Option A — Script (`redeploy.sh`)

From the live checkout:

```bash
cd /opt/interview/practice-interview
sudo APP_DIR=/opt/interview/practice-interview bash deploy/redeploy.sh
```

What the script does:

1. `git fetch` + `git reset --hard` to `origin/main` (or a ref you pass)
2. Reinstalls `backend/requirements.txt` into `.venv`
3. Restarts `interview`
4. Reloads nginx
5. Health-checks `http://127.0.0.1:8000/`

Useful variants:

```bash
# Deploy / roll back to a specific commit
sudo APP_DIR=/opt/interview/practice-interview bash deploy/redeploy.sh <sha-or-ref>

# Also re-sync nginx.conf (only when nginx config actually changed)
sudo APP_DIR=/opt/interview/practice-interview SYNC_NGINX=1 bash deploy/redeploy.sh
```

Notes:

- `.env` is git-ignored and survives `git reset --hard`.
- Do **not** set `SYNC_NGINX=1` unless `deploy/nginx.conf` changed — copying it can briefly point TLS at the bootstrap self-signed cert until certbot restores Let's Encrypt.
- If scoring fails with HTTP **413** (body too large), nginx needs the updated `client_max_body_size` — redeploy with `SYNC_NGINX=1`.
- The script’s default `APP_DIR` is `/home/ubuntu/interview`. On this host, always override with `APP_DIR=/opt/interview/practice-interview`.

---

## Option B — Manual steps

Same outcome as the script. Run as root over SSM is fine; use absolute paths.

```bash
cd /opt/interview/practice-interview

# 1) Pull remote exactly (preferred over git pull)
git fetch --all --prune
git reset --hard origin/main
# Or pin/rollback:
# git reset --hard <sha-or-ref>

# 2) Reinstall Python deps (if requirements changed)
.venv/bin/python -m pip install -r backend/requirements.txt

# 3) Restart the app (this is what loads new frontend + backend code)
systemctl restart interview

# 4) Reload nginx (usually enough; full restart not required)
nginx -t && systemctl reload nginx
```

### Minimal path for most app/frontend updates

If `backend/requirements.txt` and `deploy/nginx.conf` did not change:

```bash
cd /opt/interview/practice-interview
git fetch --all --prune
git reset --hard origin/main
systemctl restart interview
nginx -t && systemctl reload nginx
```

---

## Verify the deploy

```bash
cd /opt/interview/practice-interview

# Commit on disk matches what you pushed
git rev-parse --short HEAD
git log -1 --oneline

# Service is up and pointed at this directory
systemctl status interview --no-pager
systemctl show interview -p WorkingDirectory -p ExecStart --no-pager

# Live process is serving the new frontend
curl -fsS http://127.0.0.1:8000/ | grep -o 'Noto+Sans+JP'
curl -fsS http://127.0.0.1:8000/i18n.js | head -5
```

Then in the browser:

- Hard refresh (`Cmd+Shift+R` / `Ctrl+Shift+R`), or
- Open a private/incognito window

If server `curl` shows the new markers but the browser does not, it is cache — not a failed deploy.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Pulled + restarted, page unchanged | Updated `/root/opt/...` instead of `/opt/interview/...` | `cd /opt/interview/practice-interview`, pull again, restart `interview` |
| `git` says `26b31b2` but `curl` HTML is old | Wrong checkout vs `WorkingDirectory` | Compare `pwd` to `systemctl show interview -p WorkingDirectory` |
| `sudo -u ubuntu git ...` → Permission denied | Checkout owned under a root path | Run git as the owner of that checkout (often root on this host) |
| `.venv/bin/pip: No such file` | pip entrypoint missing in venv | Use `.venv/bin/python -m pip install -r backend/requirements.txt` |
| Health check / app down after restart | Service failed to start | `journalctl -u interview -n 50 --no-pager` |
| nginx TLS broken after copying `nginx.conf` | Self-signed bootstrap paths restored | Re-run certbot for the domain (see [DEPLOY.md](DEPLOY.md)) |

---

## What each restart does

| Action | Needed when |
| --- | --- |
| `systemctl restart interview` | Almost every deploy — loads new Python + static frontend from the checkout |
| `systemctl reload nginx` | Safe every time; required if nginx config changed |
| `pip install -r backend/requirements.txt` | Only if Python dependencies changed |
| `SYNC_NGINX=1` / copy `nginx.conf` | Only if `deploy/nginx.conf` changed |

Nginx only reverse-proxies to uvicorn. Frontend files are served by the FastAPI app from `frontend/` in the live checkout — restarting nginx alone does not deploy new UI code.
