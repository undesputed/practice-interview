#!/usr/bin/env bash
#
# Deploy the nginx reverse proxy + trusted TLS cert for the interview app.
#
# Run this ON the EC2 instance (over SSH or an SSM session), from the repo root,
# after the app is running on 127.0.0.1:8000 (see DEPLOY.md steps 1-3):
#
#   sudo bash deploy/setup-domain.sh                     # uses the default domain
#   sudo DOMAIN=molave.ai.persolhr.com bash deploy/setup-domain.sh
#   sudo EMAIL=you@example.com bash deploy/setup-domain.sh   # for renewal notices
#
# It is idempotent — safe to re-run. Each run: installs nginx + certbot, drops a
# bootstrap self-signed cert so `listen 443 ssl` can start, deploys deploy/nginx.conf,
# then issues (or renews) a Let's Encrypt cert and reloads nginx.
#
set -euo pipefail

# Domain resolution order: $1 arg > $DOMAIN env > default.
DOMAIN="${1:-${DOMAIN:-molave.ai.persolhr.com}}"
EMAIL="${EMAIL:-}"                      # optional; blank = register without email

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGINX_CONF="$REPO_DIR/deploy/nginx.conf"
SITE_AVAILABLE="/etc/nginx/sites-available/interview"
SITE_ENABLED="/etc/nginx/sites-enabled/interview"
BOOTSTRAP_DIR="/etc/ssl/interview"

echo "==> Domain: $DOMAIN"

# --- Preconditions -----------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: run with sudo — 'sudo bash deploy/setup-domain.sh'" >&2
  exit 1
fi
if [[ ! -f "$NGINX_CONF" ]]; then
  echo "ERROR: $NGINX_CONF not found — run this from the cloned repo." >&2
  exit 1
fi

# The proxy targets 127.0.0.1:8000; warn (don't block) if the app isn't up yet.
if ! ss -ltn 2>/dev/null | grep -q ':8000'; then
  echo "WARNING: nothing is listening on 127.0.0.1:8000 — start the app first (systemctl start interview)." >&2
fi

# Let's Encrypt validates over the public internet; warn if DNS isn't pointing here.
public_ip="$(curl -fsS --max-time 5 ifconfig.me || true)"
resolved="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || true)"
echo "==> This host public IP : ${public_ip:-unknown}"
echo "==> $DOMAIN resolves to : ${resolved:-<nothing>}"
if [[ -n "$public_ip" && -n "$resolved" && "$public_ip" != "$resolved" ]]; then
  echo "WARNING: DNS does not point to this host yet — certbot will fail until it does." >&2
fi

# --- Install packages --------------------------------------------------------
echo "==> Installing nginx + certbot"
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx

# --- Bootstrap cert ----------------------------------------------------------
# nginx.conf declares `listen 443 ssl`, which refuses to start without a cert.
# Generate a throwaway self-signed pair so nginx boots; certbot replaces it below.
if [[ ! -f "$BOOTSTRAP_DIR/cert.pem" || ! -f "$BOOTSTRAP_DIR/key.pem" ]]; then
  echo "==> Generating bootstrap self-signed cert"
  mkdir -p "$BOOTSTRAP_DIR"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$BOOTSTRAP_DIR/key.pem" -out "$BOOTSTRAP_DIR/cert.pem" \
    -subj "/CN=$DOMAIN"
fi

# --- Deploy nginx config -----------------------------------------------------
echo "==> Installing nginx site config"
cp "$NGINX_CONF" "$SITE_AVAILABLE"
ln -sf "$SITE_AVAILABLE" "$SITE_ENABLED"
rm -f /etc/nginx/sites-enabled/default   # stock default site would fight for port 80
nginx -t
systemctl restart nginx

# --- Issue / renew the trusted cert ------------------------------------------
# --no-redirect: nginx.conf already redirects 80 -> 443, so let certbot only
# install the cert and not add a second redirect block.
echo "==> Requesting Let's Encrypt certificate for $DOMAIN"
certbot_args=(--nginx -d "$DOMAIN" --non-interactive --agree-tos --no-redirect --keep-until-expiring)
if [[ -n "$EMAIL" ]]; then
  certbot_args+=(-m "$EMAIL")
else
  certbot_args+=(--register-unsafely-without-email)
fi
certbot "${certbot_args[@]}"

echo
echo "==> Done. Open: https://$DOMAIN/"
echo "==> Renewal is automatic (systemd timer). Verify with: sudo certbot renew --dry-run"
