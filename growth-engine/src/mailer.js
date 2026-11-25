// SMTP sending per mailbox, warm-up capacity, send window, unsubscribe tokens, owner alerts.
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { db, decrypt, getSetting, istNow, istDay, log, SESSION_SECRET } from "./db.js";

const transports = new Map();
export function transportFor(mb) {
  const key = `${mb.id}:${mb.pass_enc.slice(-12)}`;
  if (globalThis.__TEST_TRANSPORT__) return globalThis.__TEST_TRANSPORT__;
  if (!transports.has(key)) {
    transports.set(key, nodemailer.createTransport({
      host: mb.smtp_host, port: mb.smtp_port, secure: mb.smtp_port === 465,
      auth: { user: mb.username || mb.email, pass: decrypt(mb.pass_enc) },
      pool: true, maxConnections: 1, connectionTimeout: 20000,
    }));
  }
  return transports.get(key);
}

/** Today's allowed sends for a mailbox: warm-up 10/day, +5 each day, up to daily_cap. */
export function mailboxCapacity(mb) {
  const days = Math.max(0, Math.floor((Date.parse(istDay()) - Date.parse(mb.warmup_start)) / 864e5));
  const allowed = Math.min(mb.daily_cap, 10 + 5 * days);
  const sent = db.prepare("SELECT COUNT(*) n FROM outreach WHERE mailbox_id=? AND status='sent' AND substr(sent_at,1,10)=?").get(mb.id, istDay()).n;
  return { allowed, sent, left: Math.max(0, allowed - sent) };
}

export function inSendWindow(now = istNow()) {
  const [a, b] = String(getSetting("send_window", "10-19")).split("-").map(Number);
  const days = String(getSetting("send_days", "1,2,3,4,5,6")).split(",").map(Number);
  const h = now.getUTCHours(); const d = now.getUTCDay(); // istNow() is shifted, so UTC fields = IST
  return days.includes(d) && h >= a && h < b;
}

// --- unsubscribe tokens (HMAC, no DB lookup needed) ---
const sig = (s) => crypto.createHmac("sha256", SESSION_SECRET).update(s).digest("base64url").slice(0, 16);
export const unsubToken = (leadId) => `${leadId}.${sig("u" + leadId)}`;
export function verifyUnsub(token) {
  const [id, s] = String(token).split(".");
  return id && s && sig("u" + id) === s ? Number(id) : null;
}
export const unsubUrl = (leadId) => `${getSetting("public_base_url", "https://go.taxguruji.cloud").replace(/\/$/, "")}/u/${unsubToken(leadId)}`;

export function suppressLead(leadId, reason) {
  const l = db.prepare("SELECT email FROM leads WHERE id=?").get(leadId); if (!l) return;
  db.prepare("INSERT OR IGNORE INTO suppression(email,reason) VALUES(?,?)").run(l.email, reason);
  db.prepare("UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?").run(reason === "unsubscribed" ? "unsubscribed" : "do_not_contact", leadId);
  db.prepare("UPDATE enrollments SET state='stopped' WHERE lead_id=? AND state='active'").run(leadId);
}

/** Send one plain-text cold email. Returns messageId. */
export async function sendMail(mb, { to, subject, text, leadId, inReplyTo, references }) {
  const domain = mb.email.split("@")[1];
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const unsub = unsubUrl(leadId);
  const footer = `\n\n--\n${mb.from_name}\n${getSetting("sender_address")}\nNot relevant? Reply "no" or unsubscribe: ${unsub}`;
  const info = await transportFor(mb).sendMail({
    from: { name: mb.from_name, address: mb.email }, to, subject, text: text + footer, messageId,
    inReplyTo, references,
    headers: {
      "List-Unsubscribe": `<${unsub}>, <mailto:${mb.email}?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  return info.messageId || messageId;
}

/** Owner alerts: WhatsApp (CallMeBot, free) and/or email to the owner's own inbox. */
export async function notifyOwner(text) {
  const phone = getSetting("notify_whatsapp_phone"); const keyEnc = getSetting("callmebot_key_enc");
  const results = [];
  if (phone && keyEnc) {
    try {
      const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text.slice(0, 900))}&apikey=${encodeURIComponent(decrypt(keyEnc))}`;
      const r = await fetch(u); results.push(`whatsapp:${r.status}`);
    } catch (e) { results.push("whatsapp:fail"); log("notify", `WhatsApp alert failed: ${e.message}`, "warn"); }
  }
  const to = getSetting("notify_email");
  const mb = db.prepare("SELECT * FROM mailboxes WHERE active=1 ORDER BY id LIMIT 1").get();
  if (to && mb) {
    try { await transportFor(mb).sendMail({ from: { name: "Growth Engine", address: mb.email }, to, subject: "🔥 " + text.split("\n")[0].slice(0, 90), text }); results.push("email:ok"); }
    catch (e) { results.push("email:fail"); log("notify", `Email alert failed: ${e.message}`, "warn"); }
  }
  return results;
}
