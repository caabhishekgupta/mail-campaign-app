#!/usr/bin/env bash
# Listmonk (free, open-source newsletter manager) on the VPS.
# Run as root:  bash deploy/listmonk-setup.sh lists.consultguruji.com you@email.com
set -euo pipefail
DOMAIN="${1:?domain required, e.g. lists.consultguruji.com}"
EMAIL="${2:?email for LetsEncrypt SSL}"
DIR=/opt/listmonk
PORT=9100

echo "==> Docker"
if ! command -v docker >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin >/dev/null 2>&1 || true

echo "==> Listmonk files in $DIR"
mkdir -p "$DIR/uploads" && cd "$DIR"
if [ ! -f .env ]; then
  echo "DB_PASSWORD=$(openssl rand -hex 24)" > .env
  chmod 600 .env
fi

cat > docker-compose.yml <<'EOF'
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: listmonk
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: listmonk
    volumes:
      - listmonk-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U listmonk"]
      interval: 10s
      timeout: 5s
      retries: 6

  app:
    image: listmonk/listmonk:latest
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "127.0.0.1:9100:9000"
    environment:
      TZ: Asia/Kolkata
      LISTMONK_app__address: 0.0.0.0:9000
      LISTMONK_db__host: db
      LISTMONK_db__port: 5432
      LISTMONK_db__user: listmonk
      LISTMONK_db__password: ${DB_PASSWORD}
      LISTMONK_db__database: listmonk
      LISTMONK_db__ssl_mode: disable
    command: [sh, -c, "./listmonk --install --idempotent --yes --config '' && ./listmonk --upgrade --yes --config '' && ./listmonk --config ''"]
    volumes:
      - ./uploads:/listmonk/uploads

volumes:
  listmonk-data:
EOF

echo "==> Starting containers"
docker compose up -d
echo -n "   waiting for Listmonk"
for i in $(seq 1 40); do
  if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then echo " ok"; break; fi
  echo -n "."; sleep 3
done

echo "==> Root URL = https://$DOMAIN"
docker compose exec -T db psql -U listmonk -d listmonk -c \
  "UPDATE settings SET value='\"https://$DOMAIN\"' WHERE key='app.root_url';" >/dev/null || true
docker compose restart app >/dev/null

echo "==> nginx for $DOMAIN"
cat > /etc/nginx/sites-available/listmonk <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }
}
EOF
ln -sf /etc/nginx/sites-available/listmonk /etc/nginx/sites-enabled/listmonk
nginx -t && systemctl reload nginx

echo "==> SSL"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || echo "!! certbot failed - check DNS, then: certbot --nginx -d $DOMAIN"

echo
echo "LISTMONK_DONE: open https://$DOMAIN/admin and create the admin user."
