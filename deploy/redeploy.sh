#!/usr/bin/env bash
#
# redeploy.sh — manual re-deploy of the interview app on the EC2 instance.
#
# Run this ON the box, over an AWS SSM Session Manager session, as a user with
# sudo (there is no SSH into this instance). It moves the checkout to the latest
# origin/main (or a ref you pass), reinstalls Python deps, restarts the systemd
# service, reloads nginx, and health-checks the app. Safe to re-run.
#
#   sudo bash deploy/redeploy.sh                 # deploy latest origin/main
#   sudo bash deploy/redeploy.sh <sha|ref>       # deploy / roll back to a ref
#   sudo SYNC_NGINX=1 bash deploy/redeploy.sh    # also re-sync nginx.conf (see below)
#
# IMPORTANT: this deploys what is on the REMOTE, so commit AND push your changes
# first. Uncommitted local edits on your laptop are not deployed by this script.
#
# We use `git fetch` + `git reset --hard` (not `git pull`) on purpose: a deploy
# box should match the remote exactly. reset --hard never fails on local drift or
# a force-pushed/diverged history, and it lets you pin to any ref for rollback.
# .env is git-ignored, so runtime secrets survive the reset.
#
# Prereqs (already true per deploy/DEPLOY.md):
#   - checkout at /home/ubuntu/interview owned by user `ubuntu`
#   - venv at .venv, deps in backend/requirements.txt
#   - systemd service `interview`, nginx terminating TLS on 443
#
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/interview}"
APP_USER="${APP_USER:-ubuntu}"
SERVICE="${SERVICE:-interview}"
BRANCH="${BRANCH:-main}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8000/}"
REF="${1:-origin/$BRANCH}"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo — restarting services needs root."
[ -d "$APP_DIR/.git" ] || die "no git checkout at $APP_DIR"

cd "$APP_DIR"

# Run git/pip as the app user so file ownership in the checkout stays correct
# (root-owned files would break the service, which runs as $APP_USER).
run_as_app() { sudo -u "$APP_USER" "$@"; }

log "Fetching latest code"
run_as_app git fetch --all --prune

# Resolve to a concrete sha so the deploy log is unambiguous and rollback is exact.
TARGET_SHA="$(run_as_app git rev-parse --verify "$REF" 2>/dev/null)" \
  || die "cannot resolve ref '$REF' (did you push it?)"
log "Deploying ${TARGET_SHA:0:12}  ($REF)"
run_as_app git reset --hard "$TARGET_SHA"

log "Installing Python dependencies"
run_as_app "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

# nginx.conf is NOT re-synced by default. Copying deploy/nginx.conf over the live
# config reverts ssl_certificate to the self-signed bootstrap paths and breaks the
# Let's Encrypt cert (see deploy/DEPLOY.md). Opt in with SYNC_NGINX=1 only when
# nginx.conf actually changed; we then re-run certbot to restore the real cert.
if [ "${SYNC_NGINX:-0}" = "1" ]; then
  log "Syncing nginx config"
  cp "$APP_DIR/deploy/nginx.conf" /etc/nginx/sites-available/interview
  ln -sf /etc/nginx/sites-available/interview /etc/nginx/sites-enabled/interview
  DOMAIN="$(awk '/server_name/ {print $2; exit}' "$APP_DIR/deploy/nginx.conf" | tr -d ';')"
  if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "_" ] && command -v certbot >/dev/null; then
    log "Restoring real cert for $DOMAIN (certbot)"
    certbot --nginx -d "$DOMAIN" -n --keep-until-expiring \
      || die "certbot failed — live nginx now points at the bootstrap cert; fix before reload."
  fi
  nginx -t || die "nginx config test failed after sync."
fi

log "Restarting $SERVICE"
systemctl restart "$SERVICE"

log "Reloading nginx"
nginx -t && systemctl reload nginx

log "Health check: $HEALTH_URL"
sleep 3
for _ in 1 2 3 4 5; do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    log "Deploy OK — ${TARGET_SHA:0:12} is live and the service is healthy."
    exit 0
  fi
  sleep 2
done

# Health check failed: surface logs so the operator is not left guessing.
printf '\n\033[1;31mHealth check failed.\033[0m Recent service logs:\n' >&2
journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
die "app did not respond at $HEALTH_URL after restart."
