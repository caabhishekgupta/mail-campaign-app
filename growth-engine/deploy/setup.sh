#!/usr/bin/env bash
# Growth Engine on the VPS. Run as root from the repo:
#   bash growth-engine/deploy/setup.sh growth.consultguruji.com you@email.com
set -euo pipefail
DOMAIN="${1:?domain}"; EMAIL="${2:?email}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DIR=/opt/growth-engine; PORT=3200
mkdir -p "$DIR"; cp -r "$SRC/." "$DIR/"; cd "$DIR"
rm -rf node_modules; npm install --omit=dev --silent
mkdir -p data && chmod 700 data
pm2 delete growth-engine >/dev/null 2>&1 || true
COOKIE_DOMAIN=.consultguruji.com NODE_ENV=production PORT=$PORT pm2 start src/server.js --name growth-engine --update-env
pm2 save >/dev/null
cat > /etc/nginx/sites-available/growth-engine <<NG
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 60m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
NG
ln -sf /etc/nginx/sites-available/growth-engine /etc/nginx/sites-enabled/growth-engine
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || echo "!! certbot failed"
sleep 2; curl -s -o /dev/null -w "GROWTH_DONE https:%{http_code}\n" "https://$DOMAIN/api/status"
