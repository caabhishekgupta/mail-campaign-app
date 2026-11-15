#!/usr/bin/env bash
# One-shot setup on Ubuntu VPS (Hostinger). Run as root:
#   bash deploy/setup-vps.sh mail.consultguruji.com you@email.com
set -euo pipefail
DOMAIN="${1:?domain required, e.g. mail.consultguruji.com}"
EMAIL="${2:?email for LetsEncrypt SSL}"
APP_DIR="/opt/campaign-app"
PORT=3000

echo "==> Installing Node.js 22, nginx, certbot, pm2"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y nginx certbot python3-certbot-nginx build-essential python3
npm i -g pm2 >/dev/null

echo "==> Installing app to $APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/../." "$APP_DIR/"
cd "$APP_DIR"
npm ci --omit=dev || npm install --omit=dev
mkdir -p data && chmod 700 data

echo "==> Starting with pm2"
NODE_ENV=production PORT=$PORT pm2 start src/server.js --name campaign-app --update-env
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null || true

echo "==> nginx reverse proxy for $DOMAIN"
cat > /etc/nginx/sites-available/campaign-app <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/campaign-app /etc/nginx/sites-enabled/campaign-app
nginx -t && systemctl reload nginx

echo "==> SSL via LetsEncrypt (DNS A record for $DOMAIN must already point here)"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || echo "!! certbot failed — check DNS, then run: certbot --nginx -d $DOMAIN"

echo
echo "✅ Done. Open https://$DOMAIN  (first visit asks you to create the admin password)"
echo "   Logs: pm2 logs campaign-app   |  Restart: pm2 restart campaign-app"
