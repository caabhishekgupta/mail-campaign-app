// Lead Finder agent: AI web search (or Google Places) → business websites → polite crawl → verified business emails.
import { db, decrypt, istDay, log } from "../db.js";
import { runAI, parseJSON } from "../ai.js";
import { crawlSite, hasMX, rootDomain, normalizeUrl } from "../crawler.js";

const SKIP_HOSTS = /(google\.|facebook\.|instagram\.|linkedin\.|twitter\.|x\.com|youtube\.|wikipedia\.|justdial\.|indiamart\.|tradeindia\.|sulekha\.|zaubacorp|tofler|thecompanycheck|crunchbase|yelp\.|tripadvisor|zomato|swiggy|practo|amazon\.|flipkart|naukri|glassdoor|quora|reddit|medium\.com|blogspot|vertexaisearch)/i;
const RECRAWL_DAYS = 90;

export function leadsToday(missionId) {
  return db.prepare("SELECT COUNT(*) n FROM leads WHERE mission_id=? AND substr(created_at,1,10)=?").get(missionId, istDay()).n;
}

function recentQueries(missionId) {
  return db.prepare("SELECT query FROM mission_queries WHERE mission_id=? ORDER BY id DESC LIMIT 40").all(missionId).map((r) => r.query);
}

const SYSTEM = `You are the lead-research agent of an Indian chartered-accountancy and business-services firm (ConsultGuruji / CA Abhishek Gupta, Mumbai).
You find REAL businesses with their OWN websites that match a target description. Use web search. Never invent companies or URLs.
Only include organisations (companies, firms, shops, clinics, startups) — not individuals' social profiles, not directories, not marketplaces, not news articles.
Prefer the business's own domain homepage URL. Return ONLY JSON.`;

/** Ask the AI (with web search) for a batch of matching businesses. */
async function discoverViaAI(mission) {
  const avoid = recentQueries(mission.id);
  const prompt = `Target: ${mission.description}

Step 1: invent ONE new, specific web search angle not in this list of already-used angles (vary city, sub-industry, country, directory type, "newly registered", etc.):
${avoid.slice(0, 25).map((q) => "- " + q).join("\n") || "- (none yet)"}

Step 2: search the web with that angle and return up to 12 matching businesses that have their own website.

Return JSON exactly like:
{"angle":"<the search angle you used>","businesses":[{"company":"","website":"https://...","city":"","country":"","category":"","fit_score":1-10,"fit_reason":"<why they may need our services>"}]}`;
  const r = await runAI({ agent: "lead-finder", system: SYSTEM, prompt, search: true, maxTokens: 3000 });
  let data; try { data = parseJSON(r.text); } catch { data = { angle: "unparsed", businesses: [] }; }
  const list = Array.isArray(data) ? data : data.businesses || [];
  // Gemini grounding gives redirect URLs; prefer AI-stated website
  return { angle: data.angle || "ai search", businesses: list, cost: r.cost };
}

/** Google Places (New) text search — needs a google_places key. */
async function discoverViaPlaces(mission) {
  const key = db.prepare("SELECT * FROM ai_keys WHERE provider='google_places' AND active=1 ORDER BY COALESCE(last_used,'') LIMIT 1").get();
  if (!key) return null;
  // Let AI pick the next query cheaply (no web search)
  const avoid = recentQueries(mission.id);
  let query;
  try {
    const r = await runAI({ agent: "lead-finder", prompt: `Target businesses: ${mission.description}\nGive ONE new Google Maps search query (category + area), different from: ${avoid.slice(0, 30).join(" | ") || "none"}.\nReturn JSON {"query":"..."}`, maxTokens: 200 });
    query = parseJSON(r.text).query;
  } catch { query = null; }
  if (!query) return null;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": decrypt(key.key_enc),
      "X-Goog-FieldMask": "places.displayName,places.websiteUri,places.formattedAddress,places.nationalPhoneNumber,places.primaryTypeDisplayName" },
    body: JSON.stringify({ textQuery: query, pageSize: 20 }),
  });
  db.prepare("UPDATE ai_keys SET last_used=datetime('now') WHERE id=?").run(key.id);
  if (!res.ok) { log("lead-finder", `Places API ${res.status}: ${(await res.text()).slice(0, 150)}`, "warn"); return { angle: query, businesses: [] }; }
  const d = await res.json();
  const businesses = (d.places || []).filter((p) => p.websiteUri).map((p) => ({
    company: p.displayName?.text, website: p.websiteUri, city: p.formattedAddress, country: "", category: p.primaryTypeDisplayName?.text, phone: p.nationalPhoneNumber, fit_score: 6, fit_reason: "Google Maps listing",
  }));
  return { angle: query, businesses };
}

function domainRecentlyCrawled(domain) {
  const r = db.prepare("SELECT last_crawled FROM domains_seen WHERE domain=?").get(domain);
  return r && Date.now() - new Date(r.last_crawled + "Z").getTime() < RECRAWL_DAYS * 864e5;
}

const insertLead = db.prepare(`INSERT OR IGNORE INTO leads(email,email_type,company,website,domain,phone,city,country,category,segment,mission_id,source,source_url,score,ai_notes,mx_ok,status)
  VALUES(@email,@email_type,@company,@website,@domain,@phone,@city,@country,@category,@segment,@mission_id,@source,@source_url,@score,@ai_notes,@mx_ok,@status)`);

/** One work unit for a mission. Returns number of new leads. */
export async function runMissionStep(mission) {
  let batch = mission.source === "maps" ? await discoverViaPlaces(mission) : null;
  if (!batch) batch = await discoverViaAI(mission);
  let sites = 0, added = 0;
  for (const b of batch.businesses.slice(0, 12)) {
    const u = normalizeUrl(b.website || ""); if (!u || SKIP_HOSTS.test(u.hostname)) continue;
    const domain = rootDomain(u.hostname); if (domainRecentlyCrawled(domain)) continue;
    sites++;
    const c = await crawlSite(u.toString());
    db.prepare("INSERT INTO domains_seen(domain,last_crawled,emails_found,status) VALUES(?,datetime('now'),?,?) ON CONFLICT(domain) DO UPDATE SET last_crawled=excluded.last_crawled, emails_found=excluded.emails_found, status=excluded.status")
      .run(domain, c.emails?.length || 0, c.ok ? "ok" : c.error || "fail");
    if (!c.ok) continue;
    for (const e of c.emails) {
      if (db.prepare("SELECT 1 FROM suppression WHERE email=?").get(e.email)) continue;
      const mx = await hasMX(e.email.split("@")[1]);
      const r = insertLead.run({
        email: e.email, email_type: e.type, company: b.company || c.title || domain, website: `https://${c.domain}`, domain: c.domain,
        phone: b.phone || c.phones?.[0] || null, city: b.city || null, country: b.country || null, category: b.category || null,
        segment: mission.segment, mission_id: mission.id, source: mission.source === "maps" ? "google_maps" : "ai_web_search", source_url: e.sourceUrl,
        score: Number(b.fit_score) || null, ai_notes: b.fit_reason || null, mx_ok: mx ? 1 : 0, status: mx ? "verified" : "invalid",
      });
      added += r.changes;
    }
  }
  db.prepare("INSERT INTO mission_queries(mission_id,query,sites,leads) VALUES(?,?,?,?)").run(mission.id, String(batch.angle).slice(0, 300), sites, added);
  log("lead-finder", `${mission.name}: "${String(batch.angle).slice(0, 80)}" → ${batch.businesses.length} businesses, ${sites} sites crawled, ${added} new leads`);
  return added;
}

/** Import rows (e.g. MCA company master CSV already parsed) as leads. */
export async function importRows(rows, { segment = "ca_client", source = "mca_import" } = {}) {
  let added = 0, skipped = 0;
  for (const r of rows) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) || db.prepare("SELECT 1 FROM suppression WHERE email=?").get(email)) { skipped++; continue; }
    const d = email.split("@")[1]; const mx = await hasMX(d);
    const res = insertLead.run({
      email, email_type: /gmail|yahoo|hotmail|outlook|rediff|icloud/.test(d) ? "personal" : "business", company: r.company || null, website: r.website || null, domain: d,
      phone: r.phone || null, city: r.city || null, country: r.country || "India", category: r.category || null, segment, mission_id: null,
      source, source_url: r.source_url || null, score: null, ai_notes: r.notes || null, mx_ok: mx ? 1 : 0, status: mx ? "verified" : "invalid",
    });
    if (res.changes) added++; else skipped++;
  }
  log("import", `${source}: ${added} added, ${skipped} skipped`);
  return { added, skipped };
}
