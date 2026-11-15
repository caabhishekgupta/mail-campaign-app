import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand_color TEXT DEFAULT '#0f766e',
  api_key_enc TEXT NOT NULL,
  default_sender_name TEXT,
  default_sender_email TEXT,
  reply_to TEXT,
  footer TEXT,
  daily_limit INTEGER DEFAULT 300,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  name TEXT,
  subject TEXT,
  preview_text TEXT,
  html TEXT,
  list_ids TEXT,
  brevo_campaign_id INTEGER,
  status TEXT DEFAULT 'draft',
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  brevo_campaign_id INTEGER,
  subject TEXT,
  recipients INTEGER,
  action TEXT,
  at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- encryption for API keys ----------
function masterKey() {
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const f = path.join(DATA_DIR, ".secret");
    if (fs.existsSync(f)) secret = fs.readFileSync(f, "utf8").trim();
    else {
      secret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(f, secret, { mode: 0o600 });
    }
  }
  return crypto.createHash("sha256").update(secret).digest();
}
const KEY = masterKey();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
export function decrypt(blob) {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---------- settings helpers ----------
export const getSetting = (k) => db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value ?? null;
export const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

export const SESSION_SECRET = (() => {
  let s = getSetting("session_secret");
  if (!s) { s = crypto.randomBytes(32).toString("hex"); setSetting("session_secret", s); }
  return s;
})();
