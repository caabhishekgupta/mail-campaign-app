# Mail Campaign App (Brevo + Claude)

Self-hosted campaign manager for **ConsultGuruji** and **CA Abhishek Gupta** Brevo accounts.

- Switch between multiple Brevo accounts (API keys stored AES-encrypted on the server)
- Contacts: lists, CSV import (Email / Name / Mobile columns auto-mapped), view contacts
- ✍️ New Campaign: Claude writes Hindi / Hinglish / English / Gujarati email (subject + preview + responsive HTML), "Improve" with instructions
- Preview (mobile/desktop), test email, create in Brevo, **Send now** (with confirmation + 300/day free-plan warning) or **Schedule**
- Campaign reports: sent / delivered / opens / clicks
- Single admin password login (set on first visit), rate-limited

## Run locally
```bash
npm install
npm start            # http://localhost:3000
```

## Deploy on Hostinger VPS (Ubuntu)
1. Point DNS: `A  mail  →  <VPS IP>` (e.g. mail.consultguruji.com)
2. Copy this folder to the VPS (git clone or scp), then:
```bash
sudo bash deploy/setup-vps.sh mail.consultguruji.com you@consultguruji.com
```
3. Open the site → create admin password → **Settings**:
   - Add Brevo account(s): name, API key (Brevo → Settings → SMTP & API → API Keys → Generate), default verified sender, footer address
   - Add Anthropic API key (Console) for drafting

## Environment (optional)
| var | default | purpose |
|---|---|---|
| `PORT` | 3000 | server port |
| `DATA_DIR` | ./data | sqlite + secret location |
| `APP_SECRET` | auto-generated in data/.secret | encryption key for API keys |
| `CLAUDE_MODEL` | claude-sonnet-4-5 | model for drafting |

## Update
```bash
cd /opt/campaign-app && git pull && npm install --omit=dev && pm2 restart campaign-app
```

## Notes on deliverability
- Verify senders and **authenticate the domain** (SPF/DKIM/DMARC) in Brevo → Senders → Domains. A `@gmail.com` sender will land in spam under Gmail/Yahoo bulk-sender rules.
- Free plan: 300 emails/day per account. The dashboard shows today's usage.
