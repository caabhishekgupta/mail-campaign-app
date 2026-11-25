// Multi-provider AI router: any number of keys (Claude / Gemini / OpenAI),
// monthly USD budget cap, per-key cooldown on rate-limit/quota errors.
import { db, decrypt, getSetting, getJSON, istMonth, log } from "./db.js";

export class BudgetExceeded extends Error {}
export class NoKeyAvailable extends Error {}

const DEFAULT_MODELS = {
  anthropic: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
  gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  openai: process.env.OPENAI_MODEL || "gpt-5-mini",
};

export function monthSpend() {
  return db.prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM usage WHERE month=?").get(istMonth()).s;
}
export function budgetLeft() {
  return Number(getSetting("monthly_budget_usd", "200")) - monthSpend();
}

function priceFor(provider, model) {
  const p = getJSON("pricing", {})[provider] || {};
  const m = String(model || "").toLowerCase();
  const tier = Object.keys(p).find((k) => k !== "default" && k !== "search" && m.includes(k));
  return { io: p[tier] || p.default || [3, 15], search: p.search || 0 };
}
function record({ provider, model, keyId, agent, inTok = 0, outTok = 0, searches = 0 }) {
  const { io, search } = priceFor(provider, model);
  const cost = (inTok * io[0] + outTok * io[1]) / 1e6 + searches * search;
  db.prepare("INSERT INTO usage(month,provider,model,key_id,agent,input_tokens,output_tokens,searches,cost_usd) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(istMonth(), provider, model, keyId, agent, inTok, outTok, searches, cost);
  db.prepare("UPDATE ai_keys SET last_used=datetime('now'), last_error=NULL WHERE id=?").run(keyId);
  return cost;
}

function availableKeys(providers) {
  const now = new Date().toISOString();
  return db.prepare(`SELECT * FROM ai_keys WHERE active=1 AND (cooldown_until IS NULL OR cooldown_until < ?) ORDER BY COALESCE(last_used,'') ASC`)
    .all(now).filter((k) => providers.includes(k.provider));
}
function coolDown(key, err, minutes) {
  const until = new Date(Date.now() + minutes * 60e3).toISOString();
  db.prepare("UPDATE ai_keys SET cooldown_until=?, last_error=? WHERE id=?").run(until, String(err.message || err).slice(0, 300), key.id);
  log("ai", `Key #${key.id} (${key.provider}) paused ${minutes} min: ${String(err.message || err).slice(0, 160)}`, "warn");
}

/**
 * Run an AI task.
 * @param {object} o
 *  - agent: name for usage log
 *  - system, prompt: strings
 *  - search: true → needs live web search (Claude web_search tool or Gemini Google Search grounding)
 *  - maxTokens
 *  - prefer: optional provider order
 * @returns {{text, sources:[{url,title}], provider, model, cost}}
 */
export async function runAI({ agent = "ai", system = "", prompt, search = false, maxTokens = 2500, prefer }) {
  if (budgetLeft() <= 0) throw new BudgetExceeded("Monthly AI budget reached");
  const providers = prefer || (search ? ["anthropic", "gemini"] : ["anthropic", "gemini", "openai"]);
  const keys = availableKeys(providers).sort((a, b) => providers.indexOf(a.provider) - providers.indexOf(b.provider));
  if (!keys.length) throw new NoKeyAvailable(`No active ${providers.join("/")} key available (add one in AI Keys, or all are cooling down)`);
  let lastErr;
  for (const key of keys) {
    try {
      const fn = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI }[key.provider];
      const r = await fn(key, { system, prompt, search, maxTokens });
      const cost = record({ provider: key.provider, model: r.model, keyId: key.id, agent, inTok: r.inTok, outTok: r.outTok, searches: r.searches });
      return { text: r.text, sources: r.sources || [], provider: key.provider, model: r.model, cost };
    } catch (e) {
      lastErr = e;
      const s = e.status || 0;
      if (s === 429 || s === 529 || /rate|quota|overloaded|exhausted|credit/i.test(e.message)) coolDown(key, e, s === 529 ? 5 : 60);
      else if (s === 401 || s === 403) coolDown(key, e, 24 * 60);
      else coolDown(key, e, 10);
    }
  }
  throw lastErr || new NoKeyAvailable("All keys failed");
}

async function httpJSON(url, opts, timeoutMs = 120000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const txt = await res.text(); let data; try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!res.ok) { const e = new Error(`${res.status} ${data?.error?.message || data?.message || txt.slice(0, 200)}`); e.status = res.status; throw e; }
    return data;
  } finally { clearTimeout(t); }
}

async function callAnthropic(key, { system, prompt, search, maxTokens }) {
  const model = key.model || DEFAULT_MODELS.anthropic;
  const body = { model, max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }] };
  if (search) body.tools = [{ type: getSetting("anthropic_search_tool", "web_search_20250305"), name: "web_search", max_uses: 5 }];
  const d = await httpJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": decrypt(key.key_enc), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const sources = [];
  for (const b of d.content || []) if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) sources.push({ url: r.url, title: r.title });
  return { text, sources, model, inTok: d.usage?.input_tokens || 0, outTok: d.usage?.output_tokens || 0, searches: d.usage?.server_tool_use?.web_search_requests || 0 };
}

async function callGemini(key, { system, prompt, search, maxTokens }) {
  const model = key.model || DEFAULT_MODELS.gemini;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, ...(/flash/i.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}), ...(search ? {} : { responseMimeType: "application/json" }) },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (search) body.tools = [{ google_search: {} }];
  const d = await httpJSON(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": decrypt(key.key_enc), "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const cand = d.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
  const sources = (cand?.groundingMetadata?.groundingChunks || []).map((c) => c.web).filter(Boolean).map((w) => ({ url: w.uri, title: w.title }));
  return { text, sources, model, inTok: d.usageMetadata?.promptTokenCount || 0, outTok: d.usageMetadata?.candidatesTokenCount || 0, searches: search ? 1 : 0 };
}

async function callOpenAI(key, { system, prompt, maxTokens }) {
  const model = key.model || DEFAULT_MODELS.openai;
  const d = await httpJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${decrypt(key.key_enc)}`, "content-type": "application/json" },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }] }),
  });
  return { text: d.choices?.[0]?.message?.content || "", sources: [], model, inTok: d.usage?.prompt_tokens || 0, outTok: d.usage?.completion_tokens || 0, searches: 0 };
}

/** Quick key check used by the "Test" button. */
export async function testKey(key) {
  const fn = { anthropic: callAnthropic, gemini: callGemini, openai: callOpenAI }[key.provider];
  if (!fn) return { ok: true, note: "Not an LLM key (no test)" };
  const r = await fn(key, { system: "", prompt: "Reply with the single word: OK", search: false, maxTokens: 10 });
  record({ provider: key.provider, model: r.model, keyId: key.id, agent: "key-test", inTok: r.inTok, outTok: r.outTok });
  db.prepare("UPDATE ai_keys SET cooldown_until=NULL, last_error=NULL WHERE id=?").run(key.id);
  return { ok: true, reply: r.text.trim().slice(0, 40), model: r.model };
}

/** Extract JSON from model text. If the reply was cut off or slightly broken,
 *  salvage every complete {...} object inside it (so 2 of 3 options still work). */
export function parseJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "");
  const starts = [t.indexOf("["), t.indexOf("{")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("AI returned no JSON");
  const s = Math.min(...starts); const open = t[s], close = open === "[" ? "]" : "}";
  const e = t.lastIndexOf(close);
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) {
    const objs = completeObjects(t.slice(s));
    if (!objs.length) throw new Error("AI reply was incomplete — please try again");
    // top-level object parsed fine on its own?
    if (objs.length === 1 && open === "{" && !/\{[^{}]*\{/.test(t.slice(s + 1, s + 400))) return objs[0];
    return { options: objs, businesses: objs, _salvaged: true };
  }
}
function completeObjects(str) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") { depth++; if (depth === 2 || (depth === 1 && str[0] === "[")) start = i; }
    else if (c === "}") {
      if ((depth === 2 || (depth === 1 && str[0] === "[")) && start >= 0) { try { out.push(JSON.parse(str.slice(start, i + 1))); } catch {} start = -1; }
      depth--;
    }
  }
  if (!out.length) { try { out.push(JSON.parse(str.slice(0, str.lastIndexOf("}") + 1))); } catch {} }
  return out;
}
