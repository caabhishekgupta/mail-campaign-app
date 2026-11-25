// Polite website crawler: respects robots.txt, small page budget per site,
// extracts only emails published on the business's own website.
import dns from "node:dns/promises";

const UA = "ConsultGurujiLeadBot/1.0 (+https://consultguruji.com; business contact discovery)";
const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "yahoo.co.in", "hotmail.com", "outlook.com", "live.com", "rediffmail.com",
  "icloud.com", "aol.com", "protonmail.com", "proton.me", "zoho.com", "zohomail.in", "ymail.com", "msn.com", "gmx.com", "mail.com"]);
const ROLE = /^(info|contact|hello|hi|admin|office|sales|support|enquiry|enquiries|inquiry|accounts|business|team|mail|care|help|connect|bd|marketing)[0-9]*@/i;
const JUNK = /(\.(png|jpe?g|gif|webp|svg|css|js|ico)$)|(example\.|domain\.com|email\.com|yourdomain|sentry|wixpress|godaddy|@2x|noreply|no-reply|donotreply|privacy@|abuse@|postmaster@|webmaster@)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const EMAIL_ONE = /^[A-Z0-9._%+-]+@[A-Z0-9-]+(\.[A-Z0-9-]+)*\.[A-Z]{2,24}$/i;

export const rootDomain = (host) => String(host || "").toLowerCase().replace(/^www\./, "");
export function normalizeUrl(u) {
  try { const x = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`); x.hash = ""; return x; } catch { return null; }
}

async function fetchText(url, { timeoutMs = 12000, maxBytes = 1_500_000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,text/plain;q=0.9,*/*;q=0.5" }, redirect: "follow", signal: ctrl.signal });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok || !/text\/(html|plain)/i.test(ct)) return { ok: false, status: res.status, finalUrl: res.url };
    const reader = res.body.getReader(); const chunks = []; let n = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; n += value.length; chunks.push(value); if (n > maxBytes) { ctrl.abort(); break; } }
    return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), finalUrl: res.url };
  } catch (e) { return { ok: false, error: e.message }; } finally { clearTimeout(t); }
}

// --- robots.txt (very small parser: User-agent * and our bot) ---
const robotsCache = new Map();
export function parseRobots(txt) {
  const rules = []; let applies = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const [k, ...rest] = line.split(":"); const v = rest.join(":").trim(); const key = k.toLowerCase();
    if (key === "user-agent") applies = v === "*" || /consultguruji/i.test(v);
    else if (applies && (key === "disallow" || key === "allow")) rules.push({ allow: key === "allow", path: v });
  }
  return rules;
}
export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) if (r.path && path.startsWith(r.path) && (!best || r.path.length > best.path.length)) best = r;
  return !best || best.allow;
}
async function robotsFor(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const r = await fetchText(`${origin}/robots.txt`, { timeoutMs: 6000, maxBytes: 200_000 });
  const rules = r.ok ? parseRobots(r.text) : [];
  robotsCache.set(origin, rules); if (robotsCache.size > 5000) robotsCache.clear();
  return rules;
}

// --- extraction ---
export function decodeCfEmail(hex) {
  try { const k = parseInt(hex.slice(0, 2), 16); let s = ""; for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k); return s; } catch { return ""; }
}
export function extractEmails(html) {
  const out = new Set();
  const h = String(html)
    .replace(/&#64;|&#x40;/gi, "@")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/gi, "@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi, ".");
  for (const m of h.matchAll(/mailto:([^"'?>\s]+)/gi)) out.add(decodeURIComponent(m[1]));
  for (const m of h.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) out.add(decodeCfEmail(m[1]));
  for (const m of h.replace(/<script[\s\S]*?<\/script>/gi, " ").matchAll(EMAIL_RE)) out.add(m[0]);
  return [...out].map((e) => e.trim().toLowerCase().replace(/^[.\-]+|[.\-]+$/g, "")).filter((e) => EMAIL_ONE.test(e) && !JUNK.test(e));
}
export function extractPhones(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/tel:([+0-9\s\-()]{8,20})/gi)) out.add(m[1].replace(/[^\d+]/g, ""));
  return [...out].slice(0, 3);
}
export function classifyEmail(email, siteDomain) {
  const d = email.split("@")[1];
  if (FREE_MAIL.has(d)) return "personal";
  const site = rootDomain(siteDomain);
  if (!(d === site || d.endsWith("." + site) || site.endsWith("." + d))) return null; // third-party address: skip
  return ROLE.test(email) ? "role" : "business";
}
function candidateLinks(html, base) {
  const links = new Set();
  for (const m of String(html).matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const label = (m[2] || "").replace(/<[^>]+>/g, " ").toLowerCase(); const href = m[1];
    if (/contact|about|reach|team|enquir|support|imprint|impressum|get-in-touch|connect/.test(href.toLowerCase() + " " + label)) {
      try { const u = new URL(href, base); if (u.hostname === base.hostname) links.add(u.toString()); } catch {}
    }
  }
  return [...links].slice(0, 4);
}

const mxCache = new Map();
export async function hasMX(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try { const r = await dns.resolveMx(domain); ok = r.some((x) => x.exchange && x.exchange !== "."); } catch { ok = false; }
  mxCache.set(domain, ok); if (mxCache.size > 20000) mxCache.clear();
  return ok;
}

/** Crawl one website (home + up to 4 contact/about pages). */
export async function crawlSite(siteUrl, { delayMs = 1200 } = {}) {
  const u = normalizeUrl(siteUrl); if (!u) return { ok: false, error: "bad url", emails: [] };
  const origin = `${u.protocol}//${u.host}`; const rules = await robotsFor(origin);
  const home = robotsAllows(rules, u.pathname || "/") ? await fetchText(origin + (u.pathname || "/")) : { ok: false, error: "robots" };
  if (!home.ok) return { ok: false, error: home.error || `status ${home.status}`, emails: [] };
  const finalHost = rootDomain(new URL(home.finalUrl || origin).hostname);
  const pages = [{ url: home.finalUrl || origin, html: home.text }];
  for (const link of candidateLinks(home.text, new URL(home.finalUrl || origin))) {
    const p = new URL(link); if (!robotsAllows(rules, p.pathname)) continue;
    await new Promise((r) => setTimeout(r, delayMs));
    const r = await fetchText(link); if (r.ok) pages.push({ url: link, html: r.text });
  }
  const found = new Map(); const phones = new Set();
  for (const p of pages) {
    for (const e of extractEmails(p.html)) { const type = classifyEmail(e, finalHost); if (type && !found.has(e)) found.set(e, { email: e, type, sourceUrl: p.url }); }
    extractPhones(p.html).forEach((x) => phones.add(x));
  }
  const title = (home.text.match(/<title[^>]*>([^<]{1,120})/i)?.[1] || "").trim();
  return { ok: true, domain: finalHost, title, emails: [...found.values()], phones: [...phones], pagesFetched: pages.length };
}
