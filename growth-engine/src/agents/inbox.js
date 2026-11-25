// Inbox agent: reads replies & bounces over IMAP, classifies replies with AI,
// stops sequences, suppresses opt-outs, and alerts the owner about hot leads.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db, decrypt, log } from "../db.js";
import { runAI, parseJSON } from "../ai.js";
import { suppressLead, notifyOwner } from "../mailer.js";

const CLASSIFY_SYSTEM = `You triage replies to a chartered accountant's (CA Abhishek Gupta, Mumbai) business outreach emails.
Categories: interested (wants call/details/pricing), question (asks something, open), not_interested (polite no), unsubscribe (asks to stop/remove), angry (complains, calls it spam), out_of_office (auto-reply), wrong_person (refers to someone else), other.
Return ONLY JSON: {"category":"...","summary":"<one line in Hinglish for the owner>","suggested_reply":"<short helpful reply in the sender's language, signed as Abhishek; empty if unsubscribe/angry/out_of_office>"}`;

export function isBounce(parsed) {
  const from = (parsed.from?.value?.[0]?.address || "").toLowerCase();
  const subj = (parsed.subject || "").toLowerCase();
  return /mailer-daemon|postmaster/.test(from) || /undeliver|delivery status notification|returned mail|delivery failure|failure notice/.test(subj);
}
export function bouncedRecipient(raw) {
  const s = String(raw);
  const m = s.match(/Final-Recipient:\s*rfc822;\s*<?([^\s>]+@[^\s>]+)>?/i) || s.match(/X-Failed-Recipients:\s*([^\s,]+@[^\s,]+)/i) || s.match(/<([^\s<>]+@[^\s<>]+)>:\s*\n?\s*(?:host|.*?said|.*?550)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Handle one parsed inbound message for a mailbox. Exported for tests. */
export async function handleMessage(mb, parsed, raw) {
  if (isBounce(parsed)) {
    const rcpt = bouncedRecipient(raw);
    if (!rcpt) return "bounce:unknown";
    const lead = db.prepare("SELECT * FROM leads WHERE email=?").get(rcpt); if (!lead) return "bounce:no-lead";
    db.prepare("UPDATE leads SET status='invalid', updated_at=datetime('now') WHERE id=?").run(lead.id);
    db.prepare("UPDATE enrollments SET state='bounced' WHERE lead_id=? AND state IN ('active','done')").run(lead.id);
    const o = db.prepare("SELECT id FROM outreach WHERE lead_id=? AND status='sent' ORDER BY id DESC LIMIT 1").get(lead.id);
    if (o) db.prepare("UPDATE outreach SET status='bounced' WHERE id=?").run(o.id);
    log("inbox", `Bounce: ${rcpt} marked invalid`, "warn");
    return "bounce";
  }
  const fromEmail = (parsed.from?.value?.[0]?.address || "").toLowerCase();
  const refs = [parsed.inReplyTo, ...(Array.isArray(parsed.references) ? parsed.references : [parsed.references])].filter(Boolean);
  let out = null;
  for (const r of refs) { out = db.prepare("SELECT * FROM outreach WHERE message_id=?").get(r); if (out) break; }
  const lead = out ? db.prepare("SELECT * FROM leads WHERE id=?").get(out.lead_id) : db.prepare("SELECT * FROM leads WHERE email=?").get(fromEmail);
  if (!lead) return "ignored";
  const enr = out ? db.prepare("SELECT * FROM enrollments WHERE id=?").get(out.enrollment_id)
    : db.prepare("SELECT * FROM enrollments WHERE lead_id=? ORDER BY id DESC LIMIT 1").get(lead.id);
  const text = String(parsed.text || "").split(/\n(?:On .{5,120}wrote:|-{2,} ?Original Message|From: )/)[0].trim().slice(0, 4000);

  let cls = { category: "other", summary: text.slice(0, 140), suggested_reply: "" };
  if (/^\s*(no|stop|unsubscribe|remove( me)?|not interested)\s*[.!]?\s*$/i.test(text)) cls = { category: /no|not interested/i.test(text) ? "not_interested" : "unsubscribe", summary: "Mana kar diya", suggested_reply: "" };
  else {
    try { cls = parseJSON((await runAI({ agent: "inbox-classifier", system: CLASSIFY_SYSTEM, prompt: `Company: ${lead.company}\nOur last email subject: ${out?.subject || enr?.first_subject || "-"}\nTheir reply:\n${text}`, maxTokens: 600 })).text); }
    catch (e) { log("inbox", `Classifier unavailable (${e.message}); stored as 'other'`, "warn"); }
  }
  const cat = String(cls.category || "other");
  db.prepare("INSERT INTO replies(enrollment_id,lead_id,mailbox_id,from_email,subject,text,message_id,category,summary,suggested_reply) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(enr?.id || null, lead.id, mb.id, fromEmail, parsed.subject || "", text, parsed.messageId || null, cat, cls.summary || "", cls.suggested_reply || "");

  if (cat === "out_of_office") {
    if (enr) db.prepare("UPDATE enrollments SET next_at=datetime(COALESCE(next_at, datetime('now')), '+5 days') WHERE id=? AND state='active'").run(enr.id);
    return cat;
  }
  if (enr) db.prepare("UPDATE enrollments SET state='replied' WHERE id=?").run(enr.id);
  if (["unsubscribe", "angry", "not_interested"].includes(cat)) { suppressLead(lead.id, cat === "unsubscribe" ? "unsubscribed" : "do_not_contact"); return cat; }
  if (["interested", "question"].includes(cat)) {
    db.prepare("UPDATE leads SET status='hot', updated_at=datetime('now') WHERE id=?").run(lead.id);
    const msg = `🔥 HOT LEAD: ${lead.company || lead.domain}\n${fromEmail}${lead.phone ? " · " + lead.phone : ""}\n${cls.summary || ""}\nReply: https://growth.consultguruji.com (Inbox tab)`;
    const res = await notifyOwner(msg);
    db.prepare("UPDATE replies SET notified=? WHERE message_id IS ? AND lead_id=?").run(res.length ? 1 : 0, parsed.messageId || null, lead.id);
    log("inbox", `Hot lead: ${lead.company} (${cat})`);
  } else db.prepare("UPDATE leads SET status='replied', updated_at=datetime('now') WHERE id=? AND status NOT IN ('hot')").run(lead.id);
  return cat;
}

/** Poll every active mailbox for new mail since last UID. */
export async function inboxTick() {
  let handled = 0;
  for (const mb of db.prepare("SELECT * FROM mailboxes WHERE active=1").all()) {
    const client = new ImapFlow({ host: mb.imap_host, port: mb.imap_port, secure: mb.imap_port === 993,
      auth: { user: mb.username || mb.email, pass: decrypt(mb.pass_enc) }, logger: false, socketTimeout: 60000 });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        let maxUid = mb.last_uid;
        for await (const msg of client.fetch(`${mb.last_uid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (msg.uid <= mb.last_uid) continue;
          maxUid = Math.max(maxUid, msg.uid);
          try { const parsed = await simpleParser(msg.source); await handleMessage(mb, parsed, msg.source.toString("utf8")); handled++; }
          catch (e) { log("inbox", `Parse/handle failed uid ${msg.uid}: ${e.message}`, "warn"); }
        }
        if (maxUid > mb.last_uid) db.prepare("UPDATE mailboxes SET last_uid=?, last_error=NULL WHERE id=?").run(maxUid, mb.id);
      } finally { lock.release(); }
      await client.logout();
    } catch (e) {
      db.prepare("UPDATE mailboxes SET last_error=? WHERE id=?").run(`IMAP: ${String(e.message).slice(0, 250)}`, mb.id);
      log("inbox", `IMAP ${mb.email}: ${e.message}`, "warn");
      try { client.close(); } catch {}
    }
  }
  return handled;
}
