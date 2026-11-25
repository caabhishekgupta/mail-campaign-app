#!/usr/bin/env bash
# Free self-hosted mail server (docker-mailserver) for the outreach domain + public site.
# Run as root:  bash growth-engine/deploy/mail-setup.sh taxguruji.cloud you@email.com
# Creates 4 purpose mailboxes with random passwords that go straight into the Growth Engine
# (encrypted) — passwords are never printed.
set -euo pipefail
DOMAIN="${1:?domain e.g. taxguruji.cloud}"; EMAIL="${2:?email for SSL}"
MAILHOST="mail.$DOMAIN"; DIR=/opt/mailserver; ENGINE=/opt/growth-engine

echo "==> nginx: go.$DOMAIN (landing + unsubscribe → Growth Engine) and $MAILHOST (cert only)"
cat > /etc/nginx/sites-available/outreach-$DOMAIN <<NG
server {
    listen 80;
    server_name go.$DOMAIN;
    location / { proxy_pass http://127.0.0.1:3200; proxy_set_header Host \$host; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }
}
server {
    listen 80;
    server_name $MAILHOST;
    location / { return 200 "mail server\n"; }
}
NG
ln -sf /etc/nginx/sites-available/outreach-$DOMAIN /etc/nginx/sites-enabled/outreach-$DOMAIN
nginx -t && systemctl reload nginx
certbot --nginx -d "go.$DOMAIN" -d "$MAILHOST" --non-interactive --agree-tos -m "$EMAIL" --redirect --expand

echo "==> docker-mailserver"
mkdir -p "$DIR/docker-data/dms/"{mail-data,mail-state,mail-logs,config} && cd "$DIR"
cat > compose.yaml <<EOF
services:
  mailserver:
    image: ghcr.io/docker-mailserver/docker-mailserver:latest
    container_name: mailserver
    hostname: $MAILHOST
    restart: unless-stopped
    ports: ["25:25", "465:465", "587:587", "993:993"]
    volumes:
      - ./docker-data/dms/mail-data/:/var/mail/
      - ./docker-data/dms/mail-state/:/var/mail-state/
      - ./docker-data/dms/mail-logs/:/var/log/mail/
      - ./docker-data/dms/config/:/tmp/docker-mailserver/
      - /etc/letsencrypt:/etc/letsencrypt:ro
      - /etc/localtime:/etc/localtime:ro
    environment:
      - SSL_TYPE=letsencrypt
      - SSL_DOMAIN=$MAILHOST
      - ENABLE_CLAMAV=0
      - ENABLE_SPAMASSASSIN=0
      - ENABLE_FAIL2BAN=1
      - ENABLE_POSTGREY=0
      - ENABLE_OPENDKIM=1
      - ENABLE_OPENDMARC=1
      - SPOOF_PROTECTION=1
      - PERMIT_DOCKER=none
      - ONE_DIR=1
      - POSTMASTER_ADDRESS=postmaster@$DOMAIN
    cap_add: [NET_ADMIN]
    healthcheck:
      test: "ss --listening --tcp | grep -P 'LISTEN.+:smtp' || exit 1"
      timeout: 3s
      retries: 0
EOF
docker compose up -d
sleep 20

TOKEN=$(cd "$ENGINE" && node -e "const D=require('better-sqlite3');const d=new D('data/engine.db',{readonly:true});console.log(d.prepare(\"select value from settings where key='internal_token'\").get().value)")
add_box () { # email "From Name" purpose cap
  local PW; PW=$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 28)
  if docker exec mailserver setup email list 2>/dev/null | grep -q " $1 "; then docker exec mailserver setup email update "$1" "$PW" >/dev/null
  else docker exec mailserver setup email add "$1" "$PW" >/dev/null; fi
  curl -fsS -X POST http://127.0.0.1:3200/internal/mailboxes -H "content-type: application/json" -H "x-internal-token: $TOKEN" \
    -d "{\"email\":\"$1\",\"from_name\":\"$2\",\"purpose\":\"$3\",\"password\":\"$PW\",\"host\":\"$MAILHOST\",\"daily_cap\":$4}" >/dev/null && echo "   mailbox ready: $1 ($3)"
  unset PW
}
echo "==> mailboxes"
add_box "abhishek@$DOMAIN" "CA Abhishek Gupta" ca_client 40
add_box "partners@$DOMAIN" "Abhishek Gupta, CA" partner 30
add_box "web@$DOMAIN" "TaxGuruji Web Studio" web_pitch 30
add_box "demo@$DOMAIN" "TaxGuruji Accounts" software 30
for a in postmaster abuse dmarc unsubscribe; do docker exec mailserver setup alias add "$a@$DOMAIN" "abhishek@$DOMAIN" >/dev/null 2>&1 || true; done

echo "==> DKIM"
docker exec mailserver setup config dkim keysize 2048 domain "$DOMAIN" >/dev/null 2>&1 || true
docker compose restart mailserver >/dev/null; sleep 15
KEYFILE=$(ls "$DIR"/docker-data/dms/config/opendkim/keys/"$DOMAIN"/*.txt 2>/dev/null | head -1)
DKIM=$(tr -d '\n' < "$KEYFILE" | sed -E 's/.*\( *//; s/ *\).*//; s/"[[:space:]]*"//g; s/"//g; s/[[:space:]]+/ /g')
echo "$DKIM" > /root/dkim-$DOMAIN.txt
echo
echo "==> DNS records to add for $DOMAIN (Hostinger DNS):"
echo "A     mail                 $(curl -s https://api.ipify.org || echo VPS_IP)"
echo "MX    @                    $MAILHOST (priority 10)"
echo "TXT   @                    v=spf1 mx ~all"
echo "TXT   _dmarc               v=DMARC1; p=none; rua=mailto:dmarc@$DOMAIN; fo=1"
echo "TXT   mail._domainkey      (value saved in /root/dkim-$DOMAIN.txt)"
echo "MAIL_DONE"
