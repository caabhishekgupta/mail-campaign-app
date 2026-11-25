import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "engine.db"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS ai_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,            -- anthropic | gemini | openai | google_places
  label TEXT,
  key_enc TEXT NOT NULL,
  model TEXT,                        -- default model for this key
  active INTEGER DEFAULT 1,
  cooldown_until TEXT,               -- ISO; key skipped until then (rate limit / quota)
  last_error TEXT,
  last_used TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT DEFAULT (datetime('now')),
  month TEXT,                        -- YYYY-MM (IST)
  provider TEXT, model TEXT, key_id INTEGER, agent TEXT,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, searches INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,             -- ca_client | web_pitch | software | partner | affiliate
  source TEXT DEFAULT 'web',         -- web (AI search) | maps (Google Places)
  description TEXT NOT NULL,         -- who to find
  daily_target INTEGER DEFAULT 50,   -- new leads per day
  active INTEGER DEFAULT 0,          -- owner switches on (approval)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mission_queries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id INTEGER, at TEXT DEFAULT (datetime('now')), query TEXT, sites INTEGER, leads INTEGER
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  email_type TEXT,                   -- business | role | personal
  name TEXT, company TEXT, website TEXT, domain TEXT, phone TEXT,
  city TEXT, country TEXT, category TEXT,
  segment TEXT, mission_id INTEGER,
  source TEXT, source_url TEXT,
  score INTEGER, ai_notes TEXT,
  mx_ok INTEGER,
  status TEXT DEFAULT 'new',         -- new | verified | invalid | contacted | replied | hot | unsubscribed | do_not_contact
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS leads_seg ON leads(segment, status);
CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at);

CREATE TABLE IF NOT EXISTS domains_seen (
  domain TEXT PRIMARY KEY, last_crawled TEXT, emails_found INTEGER, status TEXT
);

CREATE TABLE IF NOT EXISTS suppression (email TEXT PRIMARY KEY, reason TEXT, at TEXT DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT (datetime('now')), agent TEXT, level TEXT, message TEXT
);

-- ===== Phase 2: outreach =====
CREATE TABLE IF NOT EXISTS mailboxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,             -- ca_client | web_pitch | software | partner | affiliate
  email TEXT UNIQUE NOT NULL, from_name TEXT NOT NULL,
  smtp_host TEXT, smtp_port INTEGER DEFAULT 587, imap_host TEXT, imap_port INTEGER DEFAULT 993,
  username TEXT, pass_enc TEXT NOT NULL,
  daily_cap INTEGER DEFAULT 40,      -- after warm-up
  warmup_start TEXT DEFAULT (date('now','+330 minutes')),   -- IST date
  active INTEGER DEFAULT 1, last_uid INTEGER DEFAULT 0, last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, segment TEXT NOT NULL,
  offer TEXT NOT NULL,               -- what we offer / brief for the AI writer
  language TEXT DEFAULT 'English',
  cta TEXT,                          -- e.g. "Reply or WhatsApp 98xxxx" / booking link
  step_gaps TEXT DEFAULT '0,3,7',    -- days between steps (initial + follow-ups)
  daily_new INTEGER DEFAULT 20,      -- new people started per day
  status TEXT DEFAULT 'draft',       -- draft | approved | paused
  approved_at TEXT, paused_reason TEXT, samples TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL, campaign_id INTEGER NOT NULL, mailbox_id INTEGER NOT NULL,
  step_done INTEGER DEFAULT 0, next_at TEXT, state TEXT DEFAULT 'active', -- active|replied|stopped|done|bounced
  first_message_id TEXT, last_message_id TEXT, first_subject TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(lead_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS enr_due ON enrollments(state, next_at);
CREATE TABLE IF NOT EXISTS outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER, lead_id INTEGER, campaign_id INTEGER, mailbox_id INTEGER, step INTEGER,
  subject TEXT, body TEXT, message_id TEXT, status TEXT, error TEXT,
  sent_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS out_msg ON outreach(message_id);
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enrollment_id INTEGER, lead_id INTEGER, mailbox_id INTEGER,
  from_email TEXT, subject TEXT, text TEXT, message_id TEXT,
  category TEXT, summary TEXT, suggested_reply TEXT, handled INTEGER DEFAULT 0, notified INTEGER DEFAULT 0,
  received_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- encryption (API keys at rest) ----------
function masterKey() {
  let secret = process.env.APP_SECRET;
  if (!secret) {
    const f = path.join(DATA_DIR, ".secret");
    if (fs.existsSync(f)) secret = fs.readFileSync(f, "utf8").trim();
    else { secret = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(f, secret, { mode: 0o600 }); }
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
export const mask = (k) => (k ? k.slice(0, 7) + "…" + k.slice(-4) : null);

// ---------- settings ----------
export const getSetting = (k, dflt = null) => {
  const v = db.prepare("SELECT value FROM settings WHERE key=?").get(k)?.value;
  return v === undefined ? dflt : v;
};
export const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
export const getJSON = (k, dflt) => { try { const v = getSetting(k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } };
export const setJSON = (k, v) => setSetting(k, JSON.stringify(v));

export const SESSION_SECRET = (() => {
  let s = getSetting("session_secret");
  if (!s) { s = crypto.randomBytes(32).toString("hex"); setSetting("session_secret", s); }
  return s;
})();

// IST helpers
export const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
export const istMonth = () => istNow().toISOString().slice(0, 7);
export const istDay = () => istNow().toISOString().slice(0, 10);

export function log(agent, message, level = "info") {
  db.prepare("INSERT INTO activity(agent,level,message) VALUES(?,?,?)").run(agent, level, String(message).slice(0, 1000));
  if (process.env.NODE_ENV !== "test") console.log(`[${agent}] ${level}: ${message}`);
  // keep activity table bounded
  if (Math.random() < 0.02) db.prepare("DELETE FROM activity WHERE id < (SELECT MAX(id) - 5000 FROM activity)").run();
}

// ---------- defaults ----------
const DEFAULT_PRICING = {
  // USD per 1M tokens — ESTIMATES, editable in Settings
  anthropic: { haiku: [1, 5], sonnet: [3, 15], opus: [5, 25], default: [3, 15], search: 0.01 },
  gemini: { flash: [0.3, 2.5], pro: [1.25, 10], default: [0.3, 2.5], search: 0.0 },
  openai: { mini: [0.4, 1.6], default: [2, 8], search: 0.0 },
};
if (!getSetting("pricing")) setJSON("pricing", DEFAULT_PRICING);
if (!getSetting("monthly_budget_usd")) setSetting("monthly_budget_usd", "200");
if (!getSetting("engine_on")) setSetting("engine_on", "0");
if (!getSetting("tick_minutes")) setSetting("tick_minutes", "3");
if (!getSetting("anthropic_search_tool")) setSetting("anthropic_search_tool", "web_search_20250305");
if (!getSetting("public_base_url")) setSetting("public_base_url", "https://go.taxguruji.cloud");
if (!getSetting("send_window")) setSetting("send_window", "10-19");          // IST hours
if (!getSetting("send_days")) setSetting("send_days", "1,2,3,4,5,6");       // Mon..Sat
if (!getSetting("sender_address")) setSetting("sender_address", "ConsultGuruji Advisory, Mumbai, Maharashtra 400009, India");
if (!getSetting("internal_token")) setSetting("internal_token", crypto.randomBytes(24).toString("hex"));

// Preset missions (inactive until owner switches them on)
if (!db.prepare("SELECT COUNT(*) n FROM missions").get().n) {
  const ins = db.prepare("INSERT INTO missions(name,segment,source,description,daily_target,active) VALUES(?,?,?,?,?,0)");
  ins.run("Naye companies India (CA services)", "ca_client", "web",
    "Newly incorporated private limited companies, LLPs and startups in India (especially Mumbai, Maharashtra, Gujarat, Delhi NCR, Bengaluru) that have their own website. They need GST registration, accounting, ROC compliance, income tax and audit services.", 60);
  ins.run("Mumbai MSMEs & traders", "ca_client", "maps",
    "Small and medium businesses in Mumbai and Thane: traders, distributors, manufacturers, clinics, coaching institutes, restaurants, real-estate agents, export-import firms.", 40);
  ins.run("Startups / MSMEs online", "ca_client", "web",
    "Indian startups and growing MSMEs listed on startup directories, incubators and company websites that may need virtual CFO, fundraising compliance, ESOP, GST and tax advisory.", 40);
  ins.run("International firms for work-sharing", "partner", "web",
    "Accounting, bookkeeping, tax and CPA firms in UAE, UK, USA, Canada, Australia, Singapore and New Zealand that outsource bookkeeping/tax preparation or partner with Indian chartered accountants.", 30);
  ins.run("Businesses needing a website (web pitch)", "web_pitch", "maps",
    "Small businesses in India and abroad (restaurants, salons, clinics, contractors, shops, tutors) whose website is missing, outdated or basic and who would benefit from a modern website.", 30);
  ins.run("Accounting software prospects", "software", "web",
    "Indian small traders, distributors, retailers, wholesalers and accountants who need simple GST billing and accounting software.", 30);
}
