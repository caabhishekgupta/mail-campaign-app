import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, encrypt, decrypt, getSetting, setSetting, SESSION_SECRET } from "./db.js";
import { Brevo } from "./brevo.js";
import { draftEmail, improveEmail } from "./ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "5mb" }));
app.use(cookieSession({
  name: "mailapp",
  secret: SESSION_SECRET,
  maxAge: 7 * 24 * 3600 * 1000,
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
}));

// ---------- auth ----------
const hasAdmin = () => !!getSetting("admin_hash");
const auth = (req, res, next) => (req.session?.ok ? next() : res.status(401).json({ error: "Login required" }));

app.get("/api/status", (req, res) => res.json({ setup: hasAdmin(), loggedIn: !!req.session?.ok, hasAnthropicKey: !!getSetting("anthropic_key_enc") }));

app.post("/api/setup", async (req, res) => {
  if (hasAdmin()) return res.status(400).json({ error: "Already set up" });
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
  setSetting("admin_hash", await bcrypt.hash(password, 10));
  req.session.ok = true;
  res.json({ ok: true });
});

const attempts = new Map();
app.post("/api/login", async (req, res) => {
  const ip = req.ip; const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (a.n >= 8 && Date.now() - a.t < 15 * 60e3) return res.status(429).json({ error: "Too many attempts. Try after 15 min." });
  const ok = hasAdmin() && (await bcrypt.compare(req.body?.password || "", getSetting("admin_hash")));
  if (!ok) { attempts.set(ip, { n: a.n + 1, t: Date.now() }); return res.status(401).json({ error: "Wrong password" }); }
  attempts.delete(ip); req.session.ok = true; res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { req.session = null; res.json({ ok: true }); });

app.post("/api/change-password", auth, async (req, res) => {
  const { current, next } = req.body || {};
  if (!(await bcrypt.compare(current || "", getSetting("admin_hash")))) return res.status(400).json({ error: "Current password wrong" });
  if (!next || next.length < 8) return res.status(400).json({ error: "New password must be 8+ characters" });
  setSetting("admin_hash", await bcrypt.hash(next, 10)); res.json({ ok: true });
});

// ---------- settings ----------
app.get("/api/settings", auth, (req, res) => {
  const enc = getSetting("anthropic_key_enc");
  res.json({ anthropicKey: enc ? mask(decrypt(enc)) : null, model: process.env.CLAUDE_MODEL || "claude-sonnet-4-5" });
});
app.post("/api/settings", auth, (req, res) => {
  const { anthropicKey } = req.body || {};
  if (anthropicKey === "") db.prepare("DELETE FROM settings WHERE key='anthropic_key_enc'").run();
  else if (anthropicKey) setSetting("anthropic_key_enc", encrypt(anthropicKey.trim()));
  res.json({ ok: true });
});
const mask = (k) => (k ? k.slice(0, 8) + "…" + k.slice(-4) : null);

// ---------- accounts ----------
const rowToAccount = (r) => ({ ...r, api_key: mask(decrypt(r.api_key_enc)), api_key_enc: undefined });
app.get("/api/accounts", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM accounts ORDER BY id").all().map(rowToAccount));
});
app.post("/api/accounts", auth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.api_key) return res.status(400).json({ error: "Name and API key required" });
  const r = db.prepare(`INSERT INTO accounts(name,brand_color,api_key_enc,default_sender_name,default_sender_email,reply_to,footer,daily_limit)
    VALUES(?,?,?,?,?,?,?,?)`).run(b.name, b.brand_color || "#0f766e", encrypt(b.api_key.trim()), b.default_sender_name || null,
    b.default_sender_email || null, b.reply_to || null, b.footer || null, b.daily_limit || 300);
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/accounts/:id", auth, (req, res) => {
  const b = req.body || {}; const id = +req.params.id;
  const cur = db.prepare("SELECT * FROM accounts WHERE id=?").get(id);
  if (!cur) return res.status(404).json({ error: "Not found" });
  db.prepare(`UPDATE accounts SET name=?,brand_color=?,api_key_enc=?,default_sender_name=?,default_sender_email=?,reply_to=?,footer=?,daily_limit=? WHERE id=?`)
    .run(b.name ?? cur.name, b.brand_color ?? cur.brand_color, b.api_key ? encrypt(b.api_key.trim()) : cur.api_key_enc,
      b.default_sender_name ?? cur.default_sender_name, b.default_sender_email ?? cur.default_sender_email,
      b.reply_to ?? cur.reply_to, b.footer ?? cur.footer, b.daily_limit ?? cur.daily_limit, id);
  res.json({ ok: true });
});
app.delete("/api/accounts/:id", auth, (req, res) => { db.prepare("DELETE FROM accounts WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

function brevoFor(req, res) {
  const r = db.prepare("SELECT * FROM accounts WHERE id=?").get(+req.params.id);
  if (!r) { res.status(404).json({ error: "Account not found" }); return null; }
  return { acc: r, api: new Brevo(decrypt(r.api_key_enc)) };
}
const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message, detail: e.data }); }
};

app.get("/api/accounts/:id/overview", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  const [account, senders, lists, domains] = await Promise.all([x.api.account(), x.api.senders(), x.api.lists(), x.api.domains().catch(() => ({ domains: [] }))]);
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = db.prepare("SELECT COALESCE(SUM(recipients),0) n FROM send_log WHERE account_id=? AND action='send' AND substr(at,1,10)=?").get(x.acc.id, today).n;
  res.json({ account, senders: senders.senders || [], lists: lists.lists || [], domains: domains.domains || [], sentToday, dailyLimit: x.acc.daily_limit });
}));

app.get("/api/accounts/:id/lists", auth, wrap(async (req, res) => { const x = brevoFor(req, res); if (!x) return; res.json((await x.api.lists()).lists || []); }));
app.post("/api/accounts/:id/lists", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  let folderId = req.body.folderId;
  if (!folderId) { const f = await x.api.folders(); folderId = f.folders?.[0]?.id; if (!folderId) folderId = (await x.api.createFolder("Campaign App")).id; }
  res.json(await x.api.createList(req.body.name, folderId));
}));
app.get("/api/accounts/:id/lists/:lid/contacts", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  res.json(await x.api.listContacts(+req.params.lid, +req.query.limit || 50, +req.query.offset || 0));
}));

// CSV import: accepts file upload (field "file") or raw text {csv}
app.post("/api/accounts/:id/import", auth, upload.single("file"), wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  const csv = req.file ? req.file.buffer.toString("utf8") : req.body.csv;
  const listIds = String(req.body.listIds || "").split(",").map((s) => +s).filter(Boolean);
  if (!csv || !listIds.length) return res.status(400).json({ error: "CSV and list required" });
  const normalized = normalizeCsv(csv);
  const r = await x.api.importContacts(normalized.csv, listIds);
  res.json({ processId: r.processId, rows: normalized.rows, columns: normalized.header });
}));
app.get("/api/accounts/:id/import/:pid", auth, wrap(async (req, res) => { const x = brevoFor(req, res); if (!x) return; res.json(await x.api.importStatus(+req.params.pid)); }));

// Map common Indian-office column names → Brevo attributes (EMAIL, FIRSTNAME, LASTNAME, SMS)
function normalizeCsv(text) {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const split = (l) => l.match(/("([^"]|"")*"|[^,;]*)(?=[,;]|$)/g)?.filter((_, i, a) => i < a.length - 1 || _ !== "").map((s) => s.replace(/^"|"$/g, "").replace(/""/g, '"').trim()) || [];
  const rawHeader = split(lines[0]).map((h) => h.toLowerCase());
  const map = (h) => {
    if (/e-?mail/.test(h)) return "EMAIL";
    if (/^(first ?name|name|client ?name|naam|full ?name)$/.test(h)) return "FIRSTNAME";
    if (/last ?name|surname/.test(h)) return "LASTNAME";
    if (/mobile|phone|whatsapp|sms/.test(h)) return "SMS";
    return h.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  };
  const header = rawHeader.map(map);
  const emailIdx = header.indexOf("EMAIL");
  if (emailIdx < 0) throw new Error("CSV must have an Email column");
  const out = [header.join(";")]; let rows = 0;
  for (const l of lines.slice(1)) {
    const cells = split(l); if (!cells[emailIdx] || !/@/.test(cells[emailIdx])) continue;
    out.push(header.map((_, i) => `"${(cells[i] || "").replace(/"/g, '""')}"`).join(";")); rows++;
  }
  return { csv: out.join("\n"), rows, header };
}

// ---------- campaigns ----------
app.get("/api/accounts/:id/campaigns", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  res.json((await x.api.campaigns(50, req.query.status || undefined)).campaigns || []);
}));
app.get("/api/accounts/:id/campaigns/:cid", auth, wrap(async (req, res) => { const x = brevoFor(req, res); if (!x) return; res.json(await x.api.getCampaign(+req.params.cid)); }));

function campaignPayload(acc, b) {
  const footer = (acc.footer || `${acc.name}, Mumbai, Maharashtra 400009`).replace(/\n/g, "<br>");
  const html = String(b.html || "").replace(/\{\{\s*footer\s*\}\}/g, footer).replace(/\{\{\s*brand_color\s*\}\}/g, acc.brand_color || "#0f766e");
  const p = {
    name: b.name || b.subject,
    subject: b.subject,
    previewText: b.preview_text || undefined,
    sender: { name: b.sender_name || acc.default_sender_name || acc.name, email: b.sender_email || acc.default_sender_email },
    replyTo: b.reply_to || acc.reply_to || undefined,
    htmlContent: html,
    recipients: { listIds: (b.list_ids || []).map(Number) },
    inlineImageActivation: false,
    mirrorActive: true,
    header: "[DEFAULT_HEADER]",
    footer: "[DEFAULT_FOOTER]",
  };
  if (b.scheduled_at) p.scheduledAt = new Date(b.scheduled_at).toISOString();
  return p;
}
app.post("/api/accounts/:id/campaigns", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  const b = req.body; if (!b.subject || !b.html || !b.list_ids?.length) return res.status(400).json({ error: "Subject, content and at least one list required" });
  const payload = campaignPayload(x.acc, b);
  if (!payload.sender.email) return res.status(400).json({ error: "Sender email missing (set default sender in account)" });
  const r = await x.api.createCampaign(payload);
  db.prepare("INSERT INTO send_log(account_id,brevo_campaign_id,subject,recipients,action) VALUES(?,?,?,?,?)").run(x.acc.id, r.id, b.subject, 0, b.scheduled_at ? "schedule" : "draft");
  res.json({ id: r.id });
}));
app.put("/api/accounts/:id/campaigns/:cid", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  await x.api.updateCampaign(+req.params.cid, campaignPayload(x.acc, req.body)); res.json({ ok: true });
}));
app.post("/api/accounts/:id/campaigns/:cid/test", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  const to = String(req.body.emails || "").split(/[,\s]+/).filter(Boolean);
  await x.api.sendTest(+req.params.cid, to); res.json({ ok: true, sent: to });
}));
app.post("/api/accounts/:id/campaigns/:cid/send", auth, wrap(async (req, res) => {
  const x = brevoFor(req, res); if (!x) return;
  const c = await x.api.getCampaign(+req.params.cid);
  const n = c.recipients?.lists?.reduce?.((s, l) => s + (l.totalSubscribers || 0), 0) ?? 0;
  if (req.body.confirm !== true) return res.status(400).json({ error: "Confirmation required", recipients: n });
  await x.api.sendNow(+req.params.cid);
  db.prepare("INSERT INTO send_log(account_id,brevo_campaign_id,subject,recipients,action) VALUES(?,?,?,?,?)").run(x.acc.id, +req.params.cid, c.subject, n, "send");
  res.json({ ok: true, recipients: n });
}));
app.delete("/api/accounts/:id/campaigns/:cid", auth, wrap(async (req, res) => { const x = brevoFor(req, res); if (!x) return; await x.api.deleteCampaign(+req.params.cid); res.json({ ok: true }); }));

// ---------- AI ----------
app.post("/api/ai/draft", auth, wrap(async (req, res) => res.json(await draftEmail(req.body))));
app.post("/api/ai/improve", auth, wrap(async (req, res) => res.json(await improveEmail(req.body))));

// ---------- local drafts ----------
app.get("/api/drafts", auth, (req, res) => res.json(db.prepare("SELECT id,account_id,name,subject,status,updated_at FROM drafts ORDER BY updated_at DESC").all()));
app.get("/api/drafts/:id", auth, (req, res) => res.json(db.prepare("SELECT * FROM drafts WHERE id=?").get(+req.params.id)));
app.post("/api/drafts", auth, (req, res) => {
  const b = req.body;
  if (b.id) { db.prepare("UPDATE drafts SET account_id=?,name=?,subject=?,preview_text=?,html=?,list_ids=?,updated_at=datetime('now') WHERE id=?").run(b.account_id, b.name, b.subject, b.preview_text, b.html, JSON.stringify(b.list_ids || []), b.id); return res.json({ id: b.id }); }
  const r = db.prepare("INSERT INTO drafts(account_id,name,subject,preview_text,html,list_ids) VALUES(?,?,?,?,?,?)").run(b.account_id, b.name, b.subject, b.preview_text, b.html, JSON.stringify(b.list_ids || []));
  res.json({ id: r.lastInsertRowid });
});
app.delete("/api/drafts/:id", auth, (req, res) => { db.prepare("DELETE FROM drafts WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

// ---------- static ----------
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.listen(PORT, () => console.log(`Campaign app running on http://localhost:${PORT}`));
