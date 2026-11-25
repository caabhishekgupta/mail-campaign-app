// Outreach agent: enrol leads into APPROVED campaigns, write personalised emails with AI,
// send within warm-up caps and the IST send window, follow up in-thread, stop on bad signals.
import { db, getSetting, istDay, log } from "../db.js";
import { runAI, parseJSON } from "../ai.js";
import { sendMail, mailboxCapacity, inSendWindow, notifyOwner } from "../mailer.js";

const PER_TICK_PER_MAILBOX = 2;      // spread sends across the day
const RECONTACT_DAYS = 90;

const WRITER_SYSTEM = `You write short, personal B2B cold emails for CA Abhishek Gupta (Mumbai chartered accountant, 13+ years; ConsultGuruji Advisory) and his team.
Rules:
- Plain text only. 60-120 words for the first email, 30-60 for follow-ups. No markdown, no emojis, no links except the one CTA if given.
- Open with one specific, true observation about THEIR business taken only from the facts provided (never invent facts, numbers, clients or results).
- One clear, low-friction ask (a reply, a 10-minute call). No pressure, no fake urgency, no "Re:" tricks, no ALL CAPS.
- Sound like a real professional writing one email, not marketing copy. Avoid: delve, leverage, seamless, robust, game-changer, "I hope this email finds you well", "it's not X, it's Y".
- Do NOT add a signature or unsubscribe line (added automatically).
Return ONLY JSON: {"subject":"<max 7 words, lowercase ok, no clickbait>","body":"<email text>"}`;

function gaps(c) { return String(c.step_gaps || "0,3,7").split(",").map((x) => Math.max(0, Number(x) || 0)); }

export async function writeEmail(campaign, lead, step, prevSubject) {
  const facts = { company: lead.company, website: lead.website, city: lead.city, country: lead.country, category: lead.category, why_we_think_they_fit: lead.ai_notes };
  const prompt = `Campaign offer / brief: ${campaign.offer}
Call to action: ${campaign.cta || "ask them to reply"}
Language: ${campaign.language || "English"} (use Hinglish only if asked)
This is email ${step + 1} of ${gaps(campaign).length} ${step === 0 ? "(first contact)" : `(follow-up; previous subject was "${prevSubject}" — keep it short, add one new useful point, don't repeat)`}.
Facts about the recipient's business (use only these): ${JSON.stringify(facts)}`;
  const r = await runAI({ agent: "outreach-writer", system: WRITER_SYSTEM, prompt, maxTokens: 700 });
  const j = parseJSON(r.text);
  if (!j.body || j.body.length < 20) throw new Error("Writer returned empty email");
  return { subject: String(j.subject || prevSubject || "quick question").slice(0, 90), body: String(j.body).trim() };
}

/** AI sample emails for owner approval (3 real leads from the segment). */
export async function makeSamples(campaignId) {
  const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(campaignId);
  const leads = eligibleLeads(c, 3);
  const out = [];
  for (const l of leads) { const e = await writeEmail(c, l, 0); out.push({ to: l.email, company: l.company, ...e }); }
  db.prepare("UPDATE campaigns SET samples=? WHERE id=?").run(JSON.stringify(out), campaignId);
  return out;
}

function eligibleLeads(c, limit) {
  return db.prepare(`SELECT l.* FROM leads l
    WHERE l.segment=? AND l.status='verified' AND l.mx_ok=1 AND l.email_type IN ('business','role')
      AND NOT EXISTS (SELECT 1 FROM suppression s WHERE s.email=l.email)
      AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.lead_id=l.id AND (e.state='active' OR e.created_at > datetime('now', ?)))
      AND NOT EXISTS (SELECT 1 FROM leads l2 JOIN enrollments e2 ON e2.lead_id=l2.id WHERE l2.domain=l.domain AND e2.state='active')
    ORDER BY COALESCE(l.score,5) DESC, l.id ASC LIMIT ?`).all(c.segment, `-${RECONTACT_DAYS} days`, limit);
}

function pickMailbox(purpose) {
  const boxes = db.prepare("SELECT * FROM mailboxes WHERE active=1 AND purpose=?").all(purpose);
  return boxes.map((b) => ({ b, cap: mailboxCapacity(b) })).filter((x) => x.cap.left > 0).sort((a, b) => b.cap.left - a.cap.left)[0]?.b || null;
}

/** Enrol today's quota of new leads into each approved campaign (one company domain at a time). */
export function enrollNew() {
  let total = 0;
  for (const c of db.prepare("SELECT * FROM campaigns WHERE status='approved'").all()) {
    const today = db.prepare("SELECT COUNT(*) n FROM enrollments WHERE campaign_id=? AND substr(created_at,1,10)=?").get(c.id, istDay()).n;
    const room = c.daily_new - today; if (room <= 0) continue;
    const boxes = db.prepare("SELECT id FROM mailboxes WHERE active=1 AND purpose=?").all(c.segment);
    if (!boxes.length) continue;
    const seenDomains = new Set();
    for (const l of eligibleLeads(c, room * 2)) {
      if (seenDomains.has(l.domain)) continue; seenDomains.add(l.domain);
      const mb = boxes[(l.id + c.id) % boxes.length];
      const r = db.prepare("INSERT OR IGNORE INTO enrollments(lead_id,campaign_id,mailbox_id,next_at) VALUES(?,?,?,datetime('now'))").run(l.id, c.id, mb.id);
      total += r.changes; if (seenDomains.size >= room) break;
    }
  }
  return total;
}

/** Bounce-rate guard: pause a campaign if hard bounces > 2% of the last 7 days' sends (min 50 sends). */
export async function guardCampaigns() {
  for (const c of db.prepare("SELECT * FROM campaigns WHERE status='approved'").all()) {
    const s = db.prepare(`SELECT SUM(status IN ('sent','bounced')) sent, SUM(status='bounced') bounced FROM outreach WHERE campaign_id=? AND sent_at > datetime('now','-7 days')`).get(c.id);
    const unsub = db.prepare(`SELECT COUNT(*) n FROM replies r JOIN enrollments e ON e.id=r.enrollment_id WHERE e.campaign_id=? AND r.category IN ('unsubscribe','angry') AND r.received_at > datetime('now','-7 days')`).get(c.id).n;
    let reason = null;
    if ((s.sent || 0) >= 50 && s.bounced / s.sent > 0.02) reason = `Bounce rate ${(100 * s.bounced / s.sent).toFixed(1)}% > 2%`;
    else if ((s.sent || 0) >= 50 && unsub / s.sent > 0.02) reason = `Unsubscribe/angry replies ${(100 * unsub / s.sent).toFixed(1)}% > 2%`;
    if (reason) {
      db.prepare("UPDATE campaigns SET status='paused', paused_reason=? WHERE id=?").run(reason, c.id);
      log("outreach", `Campaign "${c.name}" auto-paused: ${reason}`, "warn");
      await notifyOwner(`⚠️ Campaign paused: ${c.name}\n${reason}\nCheck list quality before resuming.`);
    }
  }
}

/** Send due emails. Returns count sent. */
export async function sendDue() {
  if (!inSendWindow()) return 0;
  let sent = 0;
  for (const mb of db.prepare("SELECT * FROM mailboxes WHERE active=1").all()) {
    let quota = Math.min(PER_TICK_PER_MAILBOX, mailboxCapacity(mb).left);
    if (quota <= 0) continue;
    const due = db.prepare(`SELECT e.*, c.status cstatus FROM enrollments e JOIN campaigns c ON c.id=e.campaign_id
      WHERE e.mailbox_id=? AND e.state='active' AND e.next_at <= datetime('now') AND c.status='approved' ORDER BY e.step_done DESC, e.next_at ASC LIMIT ?`).all(mb.id, quota);
    for (const e of due) {
      const lead = db.prepare("SELECT * FROM leads WHERE id=?").get(e.lead_id);
      const c = db.prepare("SELECT * FROM campaigns WHERE id=?").get(e.campaign_id);
      if (!lead || db.prepare("SELECT 1 FROM suppression WHERE email=?").get(lead.email) || ["unsubscribed", "do_not_contact", "invalid"].includes(lead.status)) {
        db.prepare("UPDATE enrollments SET state='stopped' WHERE id=?").run(e.id); continue;
      }
      const step = e.step_done; const g = gaps(c);
      try {
        const mail = await writeEmail(c, lead, step, e.first_subject);
        const subject = step === 0 ? mail.subject : `Re: ${e.first_subject}`;
        const msgId = await sendMail(mb, { to: lead.email, subject, text: mail.body, leadId: lead.id,
          inReplyTo: step ? e.last_message_id : undefined, references: step ? [e.first_message_id, e.last_message_id].filter(Boolean).join(" ") : undefined });
        db.prepare("INSERT INTO outreach(enrollment_id,lead_id,campaign_id,mailbox_id,step,subject,body,message_id,status) VALUES(?,?,?,?,?,?,?,?, 'sent')")
          .run(e.id, lead.id, c.id, mb.id, step, subject, mail.body, msgId);
        const nextStep = step + 1; const done = nextStep >= g.length;
        db.prepare(`UPDATE enrollments SET step_done=?, state=?, next_at=datetime('now', ?), last_message_id=?, first_message_id=COALESCE(first_message_id, ?), first_subject=COALESCE(first_subject, ?) WHERE id=?`)
          .run(nextStep, done ? "done" : "active", `+${done ? 0 : g[nextStep]} days`, msgId, msgId, subject, e.id);
        if (step === 0) db.prepare("UPDATE leads SET status='contacted', updated_at=datetime('now') WHERE id=? AND status='verified'").run(lead.id);
        db.prepare("UPDATE mailboxes SET last_error=NULL WHERE id=?").run(mb.id);
        sent++;
      } catch (err) {
        db.prepare("INSERT INTO outreach(enrollment_id,lead_id,campaign_id,mailbox_id,step,status,error) VALUES(?,?,?,?,?, 'failed', ?)").run(e.id, e.lead_id, e.campaign_id, mb.id, step, String(err.message).slice(0, 300));
        db.prepare("UPDATE mailboxes SET last_error=? WHERE id=?").run(String(err.message).slice(0, 300), mb.id);
        log("outreach", `Send failed (${mb.email} → lead ${e.lead_id}): ${err.message}`, "error");
        if (/BudgetExceeded|budget|No active/i.test(err.message) || err.constructor?.name === "BudgetExceeded") return sent;
        break; // try this mailbox again next tick
      }
      await new Promise((r) => setTimeout(r, globalThis.__TEST_TRANSPORT__ ? 0 : 20000 + Math.random() * 40000));
    }
  }
  if (sent) log("outreach", `Sent ${sent} email(s)`);
  return sent;
}

export async function outreachTick() {
  await guardCampaigns();
  const enrolled = enrollNew();
  if (enrolled) log("outreach", `Enrolled ${enrolled} new lead(s) into approved campaigns`);
  return sendDue();
}
