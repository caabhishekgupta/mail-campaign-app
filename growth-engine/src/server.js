import express from "express";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, encrypt, decrypt, mask, getSetting, setSetting, getJSON, setJSON, SESSION_SECRET, istMonth, istDay, log } from "./db.js";
import { budgetLeft, monthSpend, testKey } from "./ai.js";
import { importRows } from "./agents/leadFinder.js";
import * as scheduler from "./scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3200;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
app.use(cookieSession({ name: "growth", secret: SESSION_SECRET, maxAge: 7 * 864e5, httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" }));

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
  res.json({ engineOn: getSetting("engine_on") === "1", scheduler: scheduler.state, budget, spend, left: budgetLeft(), month: istMonth(), today, total, bySeg, usageByAgent, activity, keys });
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

// ---------- settings ----------
app.get("/api/settings", auth, (req, res) => res.json({
  monthly_budget_usd: +getSetting("monthly_budget_usd"), tick_minutes: +getSetting("tick_minutes"),
  anthropic_search_tool: getSetting("anthropic_search_tool"), pricing: getJSON("pricing", {}),
}));
app.post("/api/settings", auth, (req, res) => {
  const b = req.body || {};
  if (b.monthly_budget_usd !== undefined) setSetting("monthly_budget_usd", Math.max(0, +b.monthly_budget_usd));
  if (b.tick_minutes !== undefined) { setSetting("tick_minutes", Math.max(1, +b.tick_minutes)); scheduler.start(); }
  if (b.anthropic_search_tool) setSetting("anthropic_search_tool", b.anthropic_search_tool);
  if (b.pricing && typeof b.pricing === "object") setJSON("pricing", b.pricing);
  log("settings", "Settings updated"); res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, "127.0.0.1", () => console.log(`Growth Engine on http://127.0.0.1:${PORT}`));
  scheduler.start();
}
export default app;
