#!/usr/bin/env bash
# One login for all office apps: Growth Engine login protects
#   mail.consultguruji.com (Brevo campaign app) and lists.consultguruji.com/admin (Listmonk).
# Run as root after growth-engine/deploy/setup.sh:  bash growth-engine/deploy/portal-setup.sh
set -euo pipefail
BK=/root/nginx-backup-$(date +%Y%m%d-%H%M%S); mkdir -p "$BK"
cp /etc/nginx/sites-available/listmonk /etc/nginx/sites-available/campaign-app "$BK"/ 2>/dev/null || true
echo "backup: $BK"

[ -s /etc/portal_secret ] || { openssl rand -hex 32 > /etc/portal_secret; chmod 600 /etc/portal_secret; }
SECRET=$(cat /etc/portal_secret)

cat > /etc/nginx/snippets/portal-auth.conf <<'EOF'
location = /__portal_auth {
    internal;
    proxy_pass http://127.0.0.1:3200/portal/auth;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Host growth.consultguruji.com;
    proxy_set_header X-Forwarded-Proto https;
}
location @portal_login {
    return 302 https://growth.consultguruji.com/?next=https://$host$request_uri;
}
EOF

ssl_block () { # domain
cat <<EOF
    ssl_certificate /etc/letsencrypt/live/$1/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$1/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
EOF
}
PROXY='proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto $scheme; proxy_read_timeout 300s;'

# --- Listmonk: protect /admin and admin API; keep public pages (subscribe, unsubscribe, archive, links) open ---
cat > /etc/nginx/sites-available/listmonk <<EOF
server { listen 80; server_name lists.consultguruji.com; return 301 https://\$host\$request_uri; }
server {
    listen 443 ssl;
    server_name lists.consultguruji.com;
$(ssl_block lists.consultguruji.com)
    client_max_body_size 50m;
    include /etc/nginx/snippets/portal-auth.conf;
    location ^~ /api/public/ { proxy_pass http://127.0.0.1:9100; $PROXY }
    location ~ ^/(admin|api)(/|\$) {
        auth_request /__portal_auth;
        error_page 401 = @portal_login;
        proxy_pass http://127.0.0.1:9100; $PROXY
    }
    location / { proxy_pass http://127.0.0.1:9100; $PROXY }
}
EOF

# --- Brevo campaign app: whole app behind the portal; nginx vouches with a secret header ---
cat > /etc/nginx/sites-available/campaign-app <<EOF
server { listen 80; server_name mail.consultguruji.com; return 301 https://\$host\$request_uri; }
server {
    listen 443 ssl;
    server_name mail.consultguruji.com;
$(ssl_block mail.consultguruji.com)
    client_max_body_size 20m;
    include /etc/nginx/snippets/portal-auth.conf;
    location / {
        auth_request /__portal_auth;
        error_page 401 = @portal_login;
        proxy_pass http://127.0.0.1:3000; $PROXY
        proxy_set_header X-Portal-Auth "$SECRET";
    }
}
EOF

nginx -t
systemctl reload nginx
cd /opt/campaign-app && pm2 restart campaign-app --update-env >/dev/null
sleep 2
echo "lists public:  $(curl -s -o /dev/null -w '%{http_code}' https://lists.consultguruji.com/subscription/form)"
echo "lists admin:   $(curl -s -o /dev/null -w '%{http_code}' https://lists.consultguruji.com/admin/)  (302 = goes to portal login)"
echo "campaign app:  $(curl -s -o /dev/null -w '%{http_code}' https://mail.consultguruji.com/)  (302 = goes to portal login)"
echo "spoof header:  $(curl -s -H 'X-Portal-Auth: x' -o /dev/null -w '%{http_code}' https://mail.consultguruji.com/api/accounts)  (302 expected)"
echo PORTAL_DONE
