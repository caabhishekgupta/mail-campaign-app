// Offline tests: mocks fetch (AI APIs + websites), runs the Lead Finder end to end.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ge-"));

const SITES = {
  "https://acme-traders.in/robots.txt": "User-agent: *\nDisallow: /private",
  "https://acme-traders.in/": `<html><title>Acme Traders Mumbai</title><a href="/contact-us">Contact Us</a><a href="/private/team">Team</a>
     <a href="mailto:info@acme-traders.in">mail</a> logo@2x.png webdev@someagency.com <a href="tel:+91 98200 12345">call</a></html>`,
  "https://acme-traders.in/contact-us": `<p>Write to rahul [at] acme-traders [dot] in or <span data-cfemail="${cf("accounts@acme-traders.in")}"></span>. Owner: acmeowner@gmail.com</p>`,
  "https://acme-traders.in/private/team": `secret@acme-traders.in`,
  "https://blocked.example.org/robots.txt": "User-agent: *\nDisallow: /",
};
function cf(email) { const k = 0x42; return k.toString(16).padStart(2, "0") + [...email].map((c) => (c.charCodeAt(0) ^ k).toString(16).padStart(2, "0")).join(""); }

let aiCalls = 0;
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://api.anthropic.com/")) {
    aiCalls++;
    const body = JSON.parse(opts.body);
    const reply = (text) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 300, output_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
    if (!body.tools && /cold emails/.test(body.system)) return reply('{"subject":"gst setup for acme","body":"Hi Acme team, saw you are a new trading company in Mumbai. We handle GST registration, accounting and ROC filings for new companies. Open to a 10-minute call this week?"}');
    if (!body.tools && /triage replies/.test(body.system)) return reply('{"category":"interested","summary":"Pricing maang rahe hain","suggested_reply":"Thanks! Sharing details. — Abhishek"}');
    assert.ok(body.tools?.[0]?.name === "web_search", "search tool sent");
    return new Response(JSON.stringify({
      content: [
        { type: "server_tool_use", name: "web_search" },
        { type: "web_search_tool_result", content: [{ type: "web_search_result", url: "https://acme-traders.in/", title: "Acme" }] },
        { type: "text", text: 'Here you go: {"angle":"new trading companies Mumbai 2026","businesses":[{"company":"Acme Traders","website":"acme-traders.in","city":"Mumbai","country":"India","category":"Trading","fit_score":8,"fit_reason":"New pvt ltd, needs GST + ROC"},{"company":"Dir","website":"https://www.justdial.com/x","fit_score":5},{"company":"Blocked","website":"https://blocked.example.org"}]}' },
      ],
      usage: { input_tokens: 1200, output_tokens: 400, server_tool_use: { web_search_requests: 2 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url in SITES) return new Response(SITES[url], { status: 200, headers: { "content-type": url.endsWith("robots.txt") ? "text/plain" : "text/html" } });
  return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
};

const { db, encrypt, decrypt, setSetting } = await import("../src/db.js");
const crawler = await import("../src/crawler.js");
const ai = await import("../src/ai.js");
const { runMissionStep, importRows } = await import("../src/agents/leadFinder.js");

// --- crawler units ---
assert.deepEqual(crawler.extractEmails('<a href="mailto:Info@Acme.in?subject=x">x</a> img@2x.png me@example.com').sort(), ["info@acme.in"]);
assert.equal(crawler.decodeCfEmail(cf("a@b.co")), "a@b.co");
assert.equal(crawler.classifyEmail("info@acme.in", "www.acme.in"), "role");
assert.equal(crawler.classifyEmail("rahul@acme.in", "acme.in"), "business");
assert.equal(crawler.classifyEmail("x@gmail.com", "acme.in"), "personal");
assert.equal(crawler.classifyEmail("x@agency.com", "acme.in"), null);
const rules = crawler.parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok");
assert.equal(crawler.robotsAllows(rules, "/private/x"), false);
assert.equal(crawler.robotsAllows(rules, "/private/ok/1"), true);
assert.equal(crawler.robotsAllows(rules, "/"), true);
assert.deepEqual(ai.parseJSON('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
assert.equal(decrypt(encrypt("secret-key")), "secret-key");
console.log("✓ crawler/robots/crypto units");

// --- no key → clear error ---
await assert.rejects(() => ai.runAI({ prompt: "x", search: true }), /No active/);

// --- add a Claude key, run one mission step end-to-end ---
db.prepare("INSERT INTO ai_keys(provider,label,key_enc) VALUES('anthropic','t',?)").run(encrypt("sk-ant-test"));
const mission = db.prepare("SELECT * FROM missions WHERE segment='ca_client' AND source='web' LIMIT 1").get();
const added = await runMissionStep(mission);
const leads = db.prepare("SELECT email,email_type,segment,status,phone,score FROM leads ORDER BY email").all();
console.log(leads);
const emails = leads.map((l) => l.email);
assert.ok(emails.includes("info@acme-traders.in"), "mailto found");
assert.ok(emails.includes("rahul@acme-traders.in"), "obfuscated [at] found");
assert.ok(emails.includes("accounts@acme-traders.in"), "cloudflare-protected found");
assert.ok(emails.includes("acmeowner@gmail.com"), "personal kept but tagged");
assert.equal(leads.find((l) => l.email === "acmeowner@gmail.com").email_type, "personal");
assert.ok(!emails.includes("secret@acme-traders.in"), "robots-disallowed page skipped");
assert.ok(!emails.includes("webdev@someagency.com"), "third-party email skipped");
assert.equal(added, leads.length);
assert.equal(leads[0].phone, "+919820012345");
assert.equal(aiCalls, 1);
const u = db.prepare("SELECT * FROM usage").get();
assert.ok(u.cost_usd > 0 && u.searches === 2, "usage recorded");
console.log("✓ mission step:", added, "leads, cost $" + u.cost_usd.toFixed(4));

// --- recrawl guard: same domain not crawled again ---
const again = await runMissionStep(mission);
assert.equal(again, 0);
console.log("✓ 90-day recrawl guard");

// --- budget cap ---
setSetting("monthly_budget_usd", "0.0001");
await assert.rejects(() => ai.runAI({ prompt: "x" }), ai.BudgetExceeded);
setSetting("monthly_budget_usd", "200");
console.log("✓ budget cap stops AI");

// --- suppression respected on import ---
db.prepare("INSERT INTO suppression(email,reason) VALUES('stop@abc.in','unsubscribed')").run();
const imp = await importRows([{ email: "stop@abc.in" }, { email: "new@xyz.in", company: "XYZ" }, { email: "bad" }]);
assert.deepEqual(imp, { added: 1, skipped: 2 });
console.log("✓ import + suppression");

// ===== Phase 2: outreach =====
const sentMails = [];
globalThis.__TEST_TRANSPORT__ = { sendMail: async (m) => { sentMails.push(m); return { messageId: m.messageId }; }, verify: async () => true };
const { outreachTick, makeSamples } = await import("../src/agents/outreach.js");
const { handleMessage } = await import("../src/agents/inbox.js");
const mailer = await import("../src/mailer.js");
setSetting("send_window", "0-24"); setSetting("send_days", "0,1,2,3,4,5,6");
db.prepare("UPDATE leads SET mx_ok=1, status='verified' WHERE email LIKE '%@acme-traders.in'").run();
db.prepare("INSERT INTO mailboxes(purpose,email,from_name,smtp_host,imap_host,pass_enc) VALUES('ca_client','abhishek@taxguruji.cloud','CA Abhishek Gupta','mail.taxguruji.cloud','mail.taxguruji.cloud',?)").run(encrypt("pw"));
const mb = db.prepare("SELECT * FROM mailboxes").get();
assert.equal(mailer.mailboxCapacity(mb).allowed, 10, "warm-up day 1 = 10");
db.prepare("INSERT INTO campaigns(name,segment,offer,daily_new) VALUES('New cos','ca_client','GST + ROC package for new companies',20)").run();
assert.equal(await outreachTick(), 0, "draft campaign never sends");
const smp = await makeSamples(1); assert.ok(smp.length >= 1 && smp[0].subject);
db.prepare("UPDATE campaigns SET status='approved' WHERE id=1").run();
const n1 = await outreachTick();
assert.equal(n1, 1, "one company domain → one person at a time");
const m1 = sentMails[0];
assert.ok(!/gmail\.com/.test(m1.to), "personal email never cold-mailed");
assert.ok(m1.headers["List-Unsubscribe"].includes("/u/") && m1.headers["List-Unsubscribe-Post"]);
assert.ok(m1.text.includes("unsubscribe: https://taxguruji.cloud/u/"));
console.log("✓ outreach: draft blocked, warm-up cap, 1 per domain, unsubscribe headers →", m1.to, "|", m1.subject);
// follow-up comes in-thread once due
db.prepare("UPDATE enrollments SET next_at=datetime('now','-1 minute')").run();
await outreachTick();
const m2 = sentMails[1]; assert.ok(m2 && m2.subject.startsWith("Re: ") && m2.inReplyTo === m1.messageId, "follow-up threaded");
console.log("✓ follow-up threaded:", m2.subject);
// reply → hot lead
const leadRow = db.prepare("SELECT * FROM leads WHERE email=?").get(m1.to);
let cat = await handleMessage(mb, { from: { value: [{ address: m1.to }] }, subject: "Re: x", text: "Please share your fees for GST and ROC.\n\nOn Mon wrote: ...", inReplyTo: m2.messageId, messageId: "<r1@acme>" }, "");
assert.equal(cat, "interested"); assert.equal(db.prepare("SELECT status FROM leads WHERE id=?").get(leadRow.id).status, "hot");
assert.equal(db.prepare("SELECT state FROM enrollments WHERE lead_id=?").get(leadRow.id).state, "replied", "sequence stops on reply");
console.log("✓ reply → hot lead, sequence stopped");
// short "stop" → suppressed without AI
const other = db.prepare("SELECT * FROM leads WHERE email LIKE '%@acme-traders.in' AND id<>?").get(leadRow.id);
cat = await handleMessage(mb, { from: { value: [{ address: other.email }] }, subject: "Re", text: "stop", messageId: "<r2@acme>" }, "");
assert.equal(cat, "unsubscribe"); assert.ok(db.prepare("SELECT 1 FROM suppression WHERE email=?").get(other.email));
// bounce
db.prepare("INSERT INTO leads(email,email_type,domain,segment,status,mx_ok) VALUES('gone@zz.in','business','zz.in','ca_client','contacted',1)").run();
cat = await handleMessage(mb, { from: { value: [{ address: "MAILER-DAEMON@mail.taxguruji.cloud" }] }, subject: "Undelivered Mail Returned to Sender" }, "Final-Recipient: rfc822; gone@zz.in\nAction: failed");
assert.equal(cat, "bounce"); assert.equal(db.prepare("SELECT status FROM leads WHERE email='gone@zz.in'").get().status, "invalid");
console.log("✓ stop → suppression, bounce → invalid");
// unsubscribe token
const tok = mailer.unsubToken(leadRow.id); assert.equal(mailer.verifyUnsub(tok), leadRow.id); assert.equal(mailer.verifyUnsub(leadRow.id + ".bad"), null);
delete globalThis.__TEST_TRANSPORT__;

// --- HTTP API smoke test ---
const app = (await import("../src/server.js")).default;
const srv = app.listen(0); const port = srv.address().port; const base = `http://127.0.0.1:${port}`;
const realFetch = (await import("node:http")).request; void realFetch;
const http = async (p, o = {}) => {
  const { default: h } = await import("node:http");
  return new Promise((res, rej) => {
    const r = h.request(base + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}) } }, (resp) => {
      let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => res({ status: resp.statusCode, headers: resp.headers, body: d }));
    }); r.on("error", rej); if (o.body) r.write(JSON.stringify(o.body)); r.end();
  });
};
let r = await http("/api/overview"); assert.equal(r.status, 401);
r = await http("/api/setup", { method: "POST", body: { password: "testpass123" } }); assert.equal(r.status, 200);
const cookie = r.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
r = await http("/api/overview", { cookie }); assert.equal(r.status, 200); const ov = JSON.parse(r.body);
assert.ok(ov.total >= 5 && ov.spend > 0);
r = await http("/api/keys", { cookie }); assert.ok(!r.body.includes("sk-ant-test"), "key never returned in clear");
r = await http("/api/leads.csv?segment=ca_client", { cookie }); assert.ok(r.body.startsWith("email,"));
r = await http("/api/missions", { cookie }); assert.equal(JSON.parse(r.body).length, 6);
r = await http("/api/mailboxes", { cookie }); assert.ok(!r.body.includes("pass_enc") && r.body.includes("capacity"));
r = await http("/api/campaigns", { cookie }); assert.equal(JSON.parse(r.body)[0].hot, 1);
r = await http("/api/campaigns/1", { method: "PUT", cookie, body: { offer: "changed offer" } }); assert.equal(JSON.parse(r.body).backToDraft, true);
r = await http("/api/campaigns/1/approve", { method: "POST", cookie }); assert.equal(r.status, 400, "needs fresh samples after edit");
r = await http("/internal/mailboxes", { method: "POST", body: { email: "x@y.z" } }); assert.equal(r.status, 403, "internal endpoint needs token");
// public host: unsubscribe page
const hostReq = async (p, method = "GET") => { const { default: h } = await import("node:http"); return new Promise((res) => { const q = h.request(base + p, { method, headers: { host: "taxguruji.cloud", "content-type": "application/x-www-form-urlencoded" } }, (resp) => { let d = ""; resp.on("data", (c) => (d += c)); resp.on("end", () => res({ status: resp.statusCode, body: d })); }); q.end(method === "POST" ? "List-Unsubscribe=One-Click" : undefined); }); };
r = await hostReq("/"); assert.ok(r.body.includes("CA Abhishek Gupta"));
r = await hostReq("/api/overview"); assert.equal(r.status, 404, "dashboard hidden on public domain");
const lead2 = db.prepare("INSERT INTO leads(email,domain,segment,status) VALUES('bye@q.in','q.in','ca_client','contacted')").run().lastInsertRowid;
r = await hostReq("/u/" + mailer.unsubToken(lead2), "POST"); assert.ok(r.body.includes("unsubscribed"));
assert.ok(db.prepare("SELECT 1 FROM suppression WHERE email='bye@q.in'").get());
srv.close();
console.log("✓ public domain: landing, dashboard hidden, one-click unsubscribe");
console.log("✓ API: auth, overview, masked keys, CSV, missions");
console.log("\nALL TESTS PASSED");
process.exit(0);
