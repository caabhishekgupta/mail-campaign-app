import Anthropic from "@anthropic-ai/sdk";
import { getSetting, decrypt } from "./db.js";

function client() {
  const enc = getSetting("anthropic_key_enc");
  if (!enc) throw new Error("Anthropic API key not set. Add it in Settings.");
  return new Anthropic({ apiKey: decrypt(enc) });
}

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-5";

const SYSTEM = `You are an expert Indian email-marketing copywriter and deliverability specialist working for a Chartered Accountant practice.
You write campaign emails for two brands:
- "ConsultGuruji" – tax, GST, income tax, company/LLP registration, compliance advisory (consultguruji.com, YouTube @consultguruji).
- "CA Abhishek Gupta" – the CA's personal professional brand for existing clients.

Rules:
- Write in the requested language (Hindi in Devanagari, Hinglish, or English). Keep it warm, trustworthy, simple – like a CA talking to a small-business owner.
- Mobile-first: short paragraphs, one clear CTA button, no walls of text.
- Deliverability: avoid spammy ALL CAPS, excessive !!!, "free money" style words, and URL shorteners. Plain, honest subject lines (max ~50 chars) with ONE emoji at most.
- Use Brevo personalization where helpful: {{ contact.FIRSTNAME | default: "Dost" }} (Hindi/Hinglish) or {{ contact.FIRSTNAME | default: "there" }} (English).
- Always include a clear unsubscribe line using {{ unsubscribe }} and the sender's footer/address placeholder {{ footer }} — do NOT invent an address.
- Output must be ONLY valid JSON (no markdown fences) with keys:
  {"subject": "...", "subject_alternatives": ["...","..."], "preview_text": "... (max 90 chars)", "html": "<full responsive email HTML, inline CSS, max width 600px, brand color {{brand_color}}>"}
- The HTML must be a complete <html> document, tables-based layout, inline CSS only, no external images unless the user supplied an image URL. Use the brand name in header text instead of a logo.`;

export async function draftEmail({ brand, brandColor, language, goal, points, cta, ctaUrl, tone, extra }) {
  const c = client();
  const user = `Brand: ${brand}
Brand color: ${brandColor || "#0f766e"}
Language: ${language || "Hinglish"}
Tone: ${tone || "friendly professional"}
Goal of this email: ${goal}
Key points to cover:
${points || "(use your judgment)"}
CTA button text: ${cta || "(choose)"}  | CTA link: ${ctaUrl || "https://consultguruji.com"}
Extra instructions: ${extra || "none"}

Return the JSON now.`;
  const msg = await c.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });
  const text = msg.content.map((b) => b.text || "").join("");
  return parseJson(text);
}

export async function improveEmail({ html, subject, instruction, language }) {
  const c = client();
  const msg = await c.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Improve this email as instructed. Keep language: ${language || "same as original"}.
Instruction: ${instruction}

Current subject: ${subject}
Current HTML:
${html}

Return the JSON now (same schema).` }],
  });
  return parseJson(msg.content.map((b) => b.text || "").join(""));
}

function parseJson(text) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("AI returned no JSON");
  return JSON.parse(text.slice(s, e + 1));
}
