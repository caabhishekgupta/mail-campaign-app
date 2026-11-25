import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, encrypt, decrypt, mask, getSetting, setSetting, getJSON, setJSON, SESSION_SECRET, istMonth, istDay, log } from "./db.js";
import { budgetLeft, monthSpend, testKey } from "./ai.js";
import { importRows } from "./agents/leadFinder.js";
import { makeSamples, suggestCampaign } from "./agents/outreach.js";
import { verifyUnsub, suppressLead, mailboxCapacity, notifyOwner, transportFor, sendMail } from "./mailer.js";
import * as scheduler from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3200;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieSession({ name: "growth", secret: SESSION_SECRET, maxAge: 7 * 864e5, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
  domain: process.env.COOKIE_DOMAIN || undefined }));   // ".consultguruji.com" → one login for all office apps
// nginx auth_request target for other apps (Listmonk admin, Brevo campaign app)
app.get("/portal/auth", (req, res) => res.status(req.session?.ok ? 204 : 401).end());

// ---------- public site for the outreach domain (taxguruji.cloud): landing + unsubscribe only ----------
const PUBLIC_HOSTS = (process.env.PUBLIC_HOSTS || "go.taxguruji.cloud,taxguruji.cloud,www.taxguruji.cloud").split(",");
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px;color:#0f172a}h1{font-size:26px}a{color:#0f766e}.btn{background:#0f766e;color:#fff;border:0;padding:12px 20px;border-radius:8px;font-size:16px;cursor:pointer}.muted{color:#64748b;font-size:14px}</style></head><body>${body}</body></html>`;
app.use((req, res, next) => {
  if (!PUBLIC_HOSTS.includes(req.hostname)) return next();
  const m = req.path.match(/^\/u\/([\w.-]+)$/);
  if (m) {
    const leadId = verifyUnsub(m[1]);
    if (!leadId) return res.status(400).send(page("Invalid link", "<h1>Link not valid</h1><p>Please reply to our email with \"unsubscribe\" and we will remove you.</p>"));
    if (req.method === "POST") { suppressLead(leadId, "unsubscribed"); log("unsubscribe", `Lead ${leadId} unsubscribed via link`); return res.send(page("Unsubscribed", "<h1>You're unsubscribed</h1><p>We won't email you again. Sorry for the trouble.</p>")); }
    return res.send(page("Unsubscribe", `<h1>Unsubscribe</h1><p>Click below and we will never email you again.</p><form method="post"><button class="btn">Unsubscribe me</button></form>`));
  }
  if (req.path === "/" ) return res.send(page("TaxGuruji — CA Abhishek Gupta", `<h1>TaxGuruji</h1><p>Business outreach desk of <b>CA Abhishek Gupta</b> (Chartered Accountant, Mumbai, 13+ years) and <a href="https://consultguruji.com">ConsultGuruji Advisory</a> — GST, income tax, company &amp; LLP compliance, accounting, virtual CFO and business websites.</p><p>Contact: <a href="https://consultguruji.com">consultguruji.com</a></p><p class="muted">${getSetting("sender_address")}<br>If you received an email from us and don't want more, use the unsubscribe link in that email or reply "no".</p>`));
  return res.status(404).send(page("Not found", "<h1>Not found</h1>"));
});
app.use(express.urlencoded({ extended: false }));

const hasAdmin = () => !!getSetting("admin_hash");
const auth = (req, res, next) => (req.session?.ok ? next() : res.status(401).json({ error: "Login required" }));
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message }); } };

// ---------- auth ----------
app.get("/api/status", (req, res) => res.json({ setup: hasAdmin(), loggedIn: !!req.session?.ok }));
app.post("/api/setup", wrap(async (req, res) => {
  if (hasAdmin()) return res.status(400).json({ error: "Already set up" });
  const pw = req.body?.password || ""; if (pw.length < 8) return res.status(400).json({ error: "Password must be 8+ characters" });
  setSetting("admin_hash", await bcrypt.hash(pw, 10)); req.session.ok = true; res.json({ ok: true });
}));
const attempts = new Map();
app.post("/api/login", wrap(async (req, res) => {
  const a = attempts.get(req.ip) || { n: 0, t: Date.now() };
  if (a.n >= 8 && Date.now() - a.t < 15 * 60e3) return res.status(429).json({ error: "Too many attempts. Try after 15 min." });
  const ok = hasAdmin() && (await bcrypt.compare(req.body?.password || "", getSetting("admin_hash")));
  if (!ok) { attempts.set(req.ip, { n: a.n + 1, t: Date.now() }); return res.status(401).json({ error: "Wrong password" }); }
  attempts.delete(req.ip); req.session.ok = true; res.json({ ok: true });
}));
app.post("/api/logout", (req, res) => { req.session = null; res.json({ ok: true }); });
app.post("/api/change-password", auth, wrap(async (req, res) => {
  if (!(await bcrypt.compare(req.body?.current || "", getSetting("admin_hash")))) return res.status(400).json({ error: "Current password wrong" });
  if ((req.body?.next || "").length < 8) return res.status(400).json({ error: "New password must be 8+ characters" });
  setSetting("admin_hash", await bcrypt.hash(req.body.next, 10)); res.json({ ok: true });
}));

// ---------- overview ----------
app.get("/api/overview", auth, (req, res) => {
  const budget = Number(getSetting("monthly_budget_usd", "200"));
  const spend = monthSpend();
  const bySeg = db.prepare("SELECT segment, COUNT(*) n, SUM(status='verified') verified FROM leads GROUP BY segment").all();
  const today = db.prepare("SELECT COUNT(*) n FROM leads WHERE substr(created_at,1,10)=?").get(istDay()).n;
  const total = db.prepare("SELECT COUNT(*) n FROM leads").get().n;
  const usageByAgent = db.prepare("SELECT agent, provider, ROUND(SUM(cost_usd),4) cost, SUM(input_tokens) inp, SUM(output_tokens) outp, SUM(searches) searches FROM usage WHERE month=? GROUP BY agent, provider").all(istMonth());
  const activity = db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 40").all();
  const keys = db.prepare("SELECT provider, COUNT(*) n, SUM(active) active FROM ai_keys GROUP BY provider").all();
  const outreach = {
    sentToday: db.prepare("SELECT COUNT(*) n FROM outreach WHERE status='sent' AND substr(sent_at,1,10)=?").get(istDay()).n,
    sentTotal: db.prepare("SELECT COUNT(*) n FROM outreach WHERE status IN ('sent','bounced')").get().n,
    hot: db.prepare("SELECT COUNT(*) n FROM leads WHERE status='hot'").get().n,
    unhandled: db.prepare("SELECT COUNT(*) n FROM replies WHERE handled=0 AND category IN ('interested','question','other','wrong_person')").get().n,
    mailboxes: db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE active=1").get().n,
    campaigns: db.prepare("SELECT COUNT(*) n FROM campaigns WHERE status='approved'").get().n,
  };
  res.json({ engineOn: getSetting("engine_on") === "1", scheduler: scheduler.state, budget, spend, left: budgetLeft(), month: istMonth(), today, total, bySeg, usageByAgent, activity, keys, outreach });
});
app.post("/api/engine", auth, (req, res) => { scheduler.setEngine(!!req.body?.on); res.json({ ok: true }); });
app.post("/api/engine/tick", auth, wrap(async (req, res) => { await scheduler.tick(); res.json({ ok: true, state: scheduler.state }); }));

// ---------- AI keys ----------
const PROVIDERS = ["anthropic", "gemini", "openai", "google_places"];
app.get("/api/keys", auth, (req, res) => {
  res.json(db.prepare("SELECT * FROM ai_keys ORDER BY provider, id").all().map((k) => {
    const spent = db.prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE key_id=? AND month=?").get(k.id, istMonth()).s;
    return { ...k, key_enc: undefined, key: mask(decrypt(k.key_enc)), spent_this_month: spent };
  }));
});
app.post("/api/keys", auth, (req, res) => {
  const { provider, label, key, model } = req.body || {};
  if (!PROVIDERS.includes(provider) || !key) return res.status(400).json({ error: "Provider and key required" });
  const r = db.prepare("INSERT INTO ai_keys(provider,label,key_enc,model) VALUES(?,?,?,?)").run(provider, label || provider, encrypt(String(key).trim()), model || null);
  log("keys", `Added ${provider} key "${label || provider}"`); res.json({ id: r.lastInsertRowid });
});
app.put("/api/keys/:id", auth, (req, res) => {
  const k = db.prepare("SELECT * FROM ai_keys WHERE id=?").get(+req.params.id); if (!k) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  db.prepare("UPDATE ai_keys SET label=?, model=?, active=?, cooldown_until=CASE WHEN ? THEN NULL ELSE cooldown_until END WHERE id=?")
    .run(b.label ?? k.label, b.model ?? k.model, b.active === undefined ? k.active : b.active ? 1 : 0, b.clearCooldown ? 1 : 0, k.id);
  res.json({ ok: true });
});
app.delete("/api/keys/:id", auth, (req, res) => { db.prepare("DELETE FROM ai_keys WHERE id=?").run(+req.params.id); res.json({ ok: true }); });
app.post("/api/keys/:id/test", auth, wrap(async (req, res) => {
  const k = db.prepare("SELECT * FROM ai_keys WHERE id=?").get(+req.params.id); if (!k) return res.status(404).json({ error: "Not found" });
  try { res.json(await testKey(k)); } catch (e) { db.prepare("UPDATE ai_keys SET last_error=? WHERE id=?").run(e.message.slice(0, 300), k.id); res.status(400).json({ error: e.message }); }
}));

// ---------- missions ----------
app.get("/api/missions", auth, (req, res) => {
  res.json(db.prepare(`SELECT m.*, (SELECT COUNT(*) FROM leads l WHERE l.mission_id=m.id) leads_total,
    (SELECT COUNT(*) FROM leads l WHERE l.mission_id=m.id AND substr(l.created_at,1,10)=?) leads_today,
    (SELECT COUNT(*) FROM mission_queries q WHERE q.mission_id=m.id) runs FROM missions m ORDER BY id`).all(istDay()));
});
const SEGMENTS = ["ca_client", "web_pitch", "software", "partner", "affiliate"];
app.post("/api/missions", auth, (req, res) => {
  const b = req.body || {}; if (!b.name || !b.description || !SEGMENTS.includes(b.segment)) return res.status(400).json({ error: "Name, segment and description required" });
  const r = db.prepare("INSERT INTO missions(name,segment,source,description,daily_target,active) VALUES(?,?,?,?,?,0)").run(b.name, b.segment, b.source === "maps" ? "maps" : "web", b.description, Math.min(500, +b.daily_target || 50));
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/missions/:id", auth, (req, res) => {
  const m = db.prepare("SELECT * FROM missions WHERE id=?").get(+req.params.id); if (!m) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  db.prepare("UPDATE missions SET name=?, segment=?, source=?, description=?, daily_target=?, active=? WHERE id=?").run(
    b.name ?? m.name, SEGMENTS.includes(b.segment) ? b.segment : m.segment, b.source ?? m.source, b.description ?? m.description,
    b.daily_target !== undefined ? Math.min(500, +b.daily_target) : m.daily_target, b.active === undefined ? m.active : b.active ? 1 : 0, m.id);
  if (b.active !== undefined) log("missions", `${m.name} switched ${b.active ? "ON" : "OFF"}`);
  res.json({ ok: true });
});
app.delete("/api/missions/:id", auth, (req, res) => { db.prepare("DELETE FROM missions WHERE id=?").run(+req.params.id); res.json({ ok: true }); });
app.get("/api/missions/:id/queries", auth, (req, res) => res.json(db.prepare("SELECT * FROM mission_queries WHERE mission_id=? ORDER BY id DESC LIMIT 50").all(+req.params.id)));

// ---------- leads ----------
function leadWhere(q) {
  const w = [], p = [];
  if (q.segment) { w.push("segment=?"); p.push(q.segment); }
  if (q.status) { w.push("status=?"); p.push(q.status); }
  if (q.type) { w.push("email_type=?"); p.push(q.type); }
  if (q.mission) { w.push("mission_id=?"); p.push(+q.mission); }
  if (q.q) { w.push("(email LIKE ? OR company LIKE ? OR city LIKE ? OR country LIKE ? OR category LIKE ?)"); for (let i = 0; i < 5; i++) p.push(`%${q.q}%`); }
  return { sql: w.length ? "WHERE " + w.join(" AND ") : "", p };
}
app.get("/api/leads", auth, (req, res) => {
  const { sql, p } = leadWhere(req.query); const limit = Math.min(500, +req.query.limit || 100), offset = +req.query.offset || 0;
  res.json({ total: db.prepare(`SELECT COUNT(*) n FROM leads ${sql}`).get(...p).n, rows: db.prepare(`SELECT * FROM leads ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset) });
});
app.get("/api/leads.csv", auth, (req, res) => {
  const { sql, p } = leadWhere(req.query);
  const rows = db.prepare(`SELECT email,email_type,company,website,phone,city,country,category,segment,source,source_url,score,ai_notes,status,created_at FROM leads ${sql} ORDER BY id DESC`).all(...p);
  const cols = rows[0] ? Object.keys(rows[0]) : ["email"]; const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  res.setHeader("content-type", "text/csv; charset=utf-8"); res.setHeader("content-disposition", `attachment; filename="leads-${istDay()}.csv"`);
  res.send([cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n"));
});
app.put("/api/leads/:id", auth, (req, res) => {
  const allowed = ["new", "verified", "invalid", "contacted", "replied", "hot", "unsubscribed", "do_not_contact"];
  if (!allowed.includes(req.body?.status)) return res.status(400).json({ error: "Bad status" });
  const l = db.prepare("SELECT email FROM leads WHERE id=?").get(+req.params.id);
  db.prepare("UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?").run(req.body.status, +req.params.id);
  if (l && ["unsubscribed", "do_not_contact"].includes(req.body.status)) db.prepare("INSERT OR IGNORE INTO suppression(email,reason) VALUES(?,?)").run(l.email, req.body.status);
  res.json({ ok: true });
});

// ---------- import (MCA / any CSV) ----------
function parseCSV(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true; else if (ch === "," || ch === ";" || ch === "\t") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
app.post("/api/import", auth, upload.single("file"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "CSV file required" });
  const rows = parseCSV(req.file.buffer.toString("utf8")); if (rows.length < 2) return res.status(400).json({ error: "Empty CSV" });
  const head = rows[0].map((h) => h.toLowerCase().trim());
  const col = (re) => head.findIndex((h) => re.test(h));
  const ix = { email: col(/e-?mail/), company: col(/company.?name|^name$|company$/), city: col(/city|registered.?office|address|state/), category: col(/activity|industry|category|class/), website: col(/website|url/), phone: col(/phone|mobile/) };
  if (ix.email < 0) return res.status(400).json({ error: "CSV must have an Email column" });
  const data = rows.slice(1).map((r) => ({ email: r[ix.email], company: r[ix.company], city: r[ix.city], category: r[ix.category], website: r[ix.website], phone: r[ix.phone] }));
  const out = await importRows(data, { segment: SEGMENTS.includes(req.body.segment) ? req.body.segment : "ca_client", source: req.body.source || "csv_import" });
  res.json({ rows: data.length, ...out });
}));

// ---------- mailboxes ----------
const safeBox = (b) => ({ ...b, pass_enc: undefined, capacity: mailboxCapacity(b) });
app.get("/api/mailboxes", auth, (req, res) => res.json(db.prepare("SELECT * FROM mailboxes ORDER BY purpose, id").all().map(safeBox)));
function addMailbox(b) {
  if (!SEGMENTS.includes(b.purpose) || !b.email || !b.password || !b.from_name) throw Object.assign(new Error("purpose, email, from_name, password required"), { status: 400 });
  const host = b.host || `mail.${b.email.split("@")[1]}`;
  return db.prepare("INSERT INTO mailboxes(purpose,email,from_name,smtp_host,smtp_port,imap_host,imap_port,username,pass_enc,daily_cap) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(b.purpose, b.email.toLowerCase(), b.from_name, b.smtp_host || host, +b.smtp_port || 587, b.imap_host || host, +b.imap_port || 993, b.username || b.email, encrypt(b.password), Math.min(60, +b.daily_cap || 40)).lastInsertRowid;
}
app.post("/api/mailboxes", auth, wrap(async (req, res) => { const id = addMailbox(req.body || {}); log("mailboxes", `Added ${req.body.email}`); res.json({ id }); }));
// Server-side provisioning (VPS script, localhost only, internal token) — password never leaves the server.
app.post("/internal/mailboxes", wrap(async (req, res) => {
  const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  if (!local || req.get("x-internal-token") !== getSetting("internal_token")) return res.status(403).json({ error: "forbidden" });
  const existing = db.prepare("SELECT id FROM mailboxes WHERE email=?").get(String(req.body.email).toLowerCase());
  if (existing) { db.prepare("UPDATE mailboxes SET pass_enc=?, from_name=?, purpose=? WHERE id=?").run(encrypt(req.body.password), req.body.from_name, req.body.purpose, existing.id); return res.json({ id: existing.id, updated: true }); }
  res.json({ id: addMailbox(req.body || {}) });
}));
app.put("/api/mailboxes/:id", auth, (req, res) => {
  const m = db.prepare("SELECT * FROM mailboxes WHERE id=?").get(+req.params.id); if (!m) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  db.prepare("UPDATE mailboxes SET from_name=?, purpose=?, daily_cap=?, active=? WHERE id=?").run(b.from_name ?? m.from_name, SEGMENTS.includes(b.purpose) ? b.purpose : m.purpose, b.daily_cap ? Math.min(60, +b.daily_cap) : m.daily_cap, b.active === undefined ? m.active : b.active ? 1 : 0, m.id);
  res.json({ ok: true });
});
app.delete("/api/mailboxes/:id", auth, (req, res) => { db.prepare("UPDATE mailboxes SET active=0 WHERE id=?").run(+req.params.id); res.json({ ok: true }); });
app.post("/api/mailboxes/:id/test", auth, wrap(async (req, res) => {
  const m = db.prepare("SELECT * FROM mailboxes WHERE id=?").get(+req.params.id);
  await transportFor(m).verify(); res.json({ ok: true });
}));

// ---------- campaigns ----------
app.get("/api/campaigns", auth, (req, res) => res.json(db.prepare(`SELECT c.*,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id=c.id) enrolled,
  (SELECT COUNT(*) FROM outreach o WHERE o.campaign_id=c.id AND o.status IN ('sent','bounced')) sent,
  (SELECT COUNT(*) FROM outreach o WHERE o.campaign_id=c.id AND o.status='bounced') bounced,
  (SELECT COUNT(*) FROM enrollments e WHERE e.campaign_id=c.id AND e.state='replied') replied,
  (SELECT COUNT(*) FROM replies r JOIN enrollments e ON e.id=r.enrollment_id WHERE e.campaign_id=c.id AND r.category IN ('interested','question')) hot,
  (SELECT COUNT(*) FROM leads l WHERE l.segment=c.segment AND l.status='verified' AND l.email_type IN ('business','role')) ready
  FROM campaigns c ORDER BY id DESC`).all()));
app.post("/api/campaigns", auth, (req, res) => {
  const b = req.body || {}; if (!b.name || !b.offer || !SEGMENTS.includes(b.segment)) return res.status(400).json({ error: "Name, lead type and offer required" });
  const r = db.prepare("INSERT INTO campaigns(name,segment,offer,language,cta,step_gaps,daily_new) VALUES(?,?,?,?,?,?,?)")
    .run(b.name, b.segment, b.offer, b.language || "English", b.cta || null, b.step_gaps || "0,3,7", Math.min(200, +b.daily_new || 20));
  res.json({ id: r.lastInsertRowid });
});
app.put("/api/campaigns/:id", auth, (req, res) => {
  const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(+req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  // Any content change sends the campaign back to draft: the owner must approve again.
  const changed = ["offer", "cta", "language", "step_gaps", "segment"].some((k) => b[k] !== undefined && b[k] !== c[k]);
  db.prepare("UPDATE campaigns SET name=?, offer=?, cta=?, language=?, step_gaps=?, segment=?, daily_new=?, status=?, samples=? WHERE id=?")
    .run(b.name ?? c.name, b.offer ?? c.offer, b.cta ?? c.cta, b.language ?? c.language, b.step_gaps ?? c.step_gaps, SEGMENTS.includes(b.segment) ? b.segment : c.segment,
      b.daily_new ? Math.min(200, +b.daily_new) : c.daily_new, changed ? "draft" : c.status, changed ? null : c.samples, c.id);
  res.json({ ok: true, backToDraft: changed });
});
app.post("/api/campaigns/suggest", auth, wrap(async (req, res) => {
  const b = req.body || {}; if (!SEGMENTS.includes(b.segment)) return res.status(400).json({ error: "Lead type required" });
  res.json(await suggestCampaign({ segment: b.segment, name: String(b.name || "").slice(0, 200), hint: String(b.hint || "").slice(0, 1000), language: b.language }));
}));
app.post("/api/campaigns/:id/samples", auth, wrap(async (req, res) => res.json(await makeSamples(+req.params.id))));
app.post("/api/campaigns/:id/approve", auth, (req, res) => {
  const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(+req.params.id); if (!c) return res.status(404).json({ error: "Not found" });
  if (!c.samples) return res.status(400).json({ error: "Generate and review sample emails first" });
  if (!db.prepare("SELECT 1 FROM mailboxes WHERE active=1 AND purpose=?").get(c.segment)) return res.status(400).json({ error: "No active mailbox for this lead type" });
  db.prepare("UPDATE campaigns SET status='approved', approved_at=datetime('now'), paused_reason=NULL WHERE id=?").run(c.id);
  log("campaigns", `Owner approved campaign "${c.name}" (${c.daily_new} new/day)`); res.json({ ok: true });
});
app.post("/api/campaigns/:id/pause", auth, (req, res) => { db.prepare("UPDATE campaigns SET status='paused', paused_reason='Paused by owner' WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

// ---------- inbox / hot leads ----------
app.get("/api/replies", auth, (req, res) => {
  const cat = req.query.category; const w = cat ? "WHERE r.category=?" : ""; const p = cat ? [cat] : [];
  res.json(db.prepare(`SELECT r.*, l.company, l.website, l.phone, m.email mailbox FROM replies r LEFT JOIN leads l ON l.id=r.lead_id LEFT JOIN mailboxes m ON m.id=r.mailbox_id ${w} ORDER BY r.id DESC LIMIT 200`).all(...p));
});
app.post("/api/replies/:id/send", auth, wrap(async (req, res) => {
  const r = db.prepare("SELECT * FROM replies WHERE id=?").get(+req.params.id); if (!r) return res.status(404).json({ error: "Not found" });
  const text = String(req.body?.text || "").trim(); if (text.length < 5) return res.status(400).json({ error: "Reply text required" });
  const mb = db.prepare("SELECT * FROM mailboxes WHERE id=?").get(r.mailbox_id);
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`;
  const msgId = await sendMail(mb, { to: r.from_email, subject, text, leadId: r.lead_id, inReplyTo: r.message_id || undefined, references: r.message_id || undefined });
  db.prepare("INSERT INTO outreach(enrollment_id,lead_id,campaign_id,mailbox_id,step,subject,body,message_id,status) VALUES(?,?,NULL,?,-1,?,?,?,'sent')").run(r.enrollment_id, r.lead_id, mb.id, subject, text, msgId);
  db.prepare("UPDATE replies SET handled=1 WHERE id=?").run(r.id);
  log("inbox", `Owner replied to ${r.from_email}`); res.json({ ok: true });
}));
app.post("/api/replies/:id/handled", auth, (req, res) => { db.prepare("UPDATE replies SET handled=1 WHERE id=?").run(+req.params.id); res.json({ ok: true }); });

// ---------- settings ----------
app.get("/api/settings", auth, (req, res) => res.json({
  monthly_budget_usd: +getSetting("monthly_budget_usd"), tick_minutes: +getSetting("tick_minutes"),
  anthropic_search_tool: getSetting("anthropic_search_tool"), pricing: getJSON("pricing", {}),
  send_window: getSetting("send_window"), send_days: getSetting("send_days"), sender_address: getSetting("sender_address"), public_base_url: getSetting("public_base_url"),
  notify_whatsapp_phone: getSetting("notify_whatsapp_phone") || "", notify_email: getSetting("notify_email") || "", callmebot_key_set: !!getSetting("callmebot_key_enc"),
}));
app.post("/api/settings", auth, (req, res) => {
  const b = req.body || {};
  if (b.monthly_budget_usd !== undefined) setSetting("monthly_budget_usd", Math.max(0, +b.monthly_budget_usd));
  if (b.tick_minutes !== undefined) { setSetting("tick_minutes", Math.max(1, +b.tick_minutes)); scheduler.start(); }
  if (b.anthropic_search_tool) setSetting("anthropic_search_tool", b.anthropic_search_tool);
  if (b.pricing && typeof b.pricing === "object") setJSON("pricing", b.pricing);
  for (const k of ["send_window", "send_days", "sender_address", "public_base_url", "notify_whatsapp_phone", "notify_email"]) if (b[k] !== undefined) setSetting(k, String(b[k]).trim());
  if (b.callmebot_key) setSetting("callmebot_key_enc", encrypt(String(b.callmebot_key).trim()));
  log("settings", "Settings updated"); res.json({ ok: true });
});
app.post("/api/notify/test", auth, wrap(async (req, res) => res.json({ results: await notifyOwner("✅ Growth Engine test alert — hot leads yahan aayenge.") })));

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "127.0.0.1", () => console.log(`Growth Engine on http://127.0.0.1:${PORT}`));
  scheduler.start();
}
export default app;
