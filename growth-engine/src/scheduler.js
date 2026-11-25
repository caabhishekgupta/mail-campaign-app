// 24x7 loop. Each tick: (1) read replies/bounces, (2) send due outreach, (3) find new leads.
// Budget exhausted → AI work pauses until next month (or a higher cap); inbox reading continues.
// All keys cooling (rate limit / quota) → waits and retries automatically.
import { db, getSetting, setSetting, log } from "./db.js";
import { budgetLeft, BudgetExceeded, NoKeyAvailable } from "./ai.js";
import { runMissionStep, leadsToday } from "./agents/leadFinder.js";
import { outreachTick } from "./agents/outreach.js";
import { inboxTick } from "./agents/inbox.js";

let running = false, timer = null;
export const state = { status: "stopped", lastTick: null, lastError: null, pausedReason: null, lastSent: 0, lastInbox: 0 };

async function safe(name, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BudgetExceeded || e instanceof NoKeyAvailable) throw e;
    log("scheduler", `${name}: ${e.message}`, "error"); state.lastError = `${name}: ${e.message}`; return 0;
  }
}

export async function tick() {
  if (running) return; running = true; state.lastTick = new Date().toISOString();
  try {
    if (getSetting("engine_on") !== "1") { state.status = "stopped"; return; }
    state.status = "running"; state.pausedReason = null;

    if (db.prepare("SELECT COUNT(*) n FROM mailboxes WHERE active=1").get().n) {
      state.lastInbox = await safe("inbox", inboxTick);
      if (budgetLeft() > 0) state.lastSent = await safe("outreach", outreachTick);
    }

    if (budgetLeft() <= 0) { setPaused("Monthly AI budget reached — auto-resumes next month or when you raise the budget"); return; }
    const missions = db.prepare("SELECT * FROM missions WHERE active=1 ORDER BY id").all();
    const pending = missions.filter((m) => leadsToday(m.id) < m.daily_target);
    if (!pending.length) { if (!missions.length) setPaused("No lead mission switched on"); else setPaused("Daily lead targets reached — continues tomorrow"); return; }
    const last = (id) => db.prepare("SELECT MAX(id) m FROM mission_queries WHERE mission_id=?").get(id).m || 0;
    const m = pending.sort((a, b) => last(a.id) - last(b.id))[0];
    await runMissionStep(m);
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    if (e instanceof BudgetExceeded) setPaused(e.message);
    else if (e instanceof NoKeyAvailable) setPaused(e.message + " — retrying automatically");
    else log("scheduler", e.message, "error");
  } finally { running = false; }
}
function setPaused(reason) {
  if (state.pausedReason !== reason) log("scheduler", `Lead finder paused: ${reason}`, "warn");
  state.status = "paused"; state.pausedReason = reason;
}

export function start() {
  stop();
  const mins = Math.max(1, Number(getSetting("tick_minutes", "3")));
  timer = setInterval(tick, mins * 60e3);
  setTimeout(tick, 5000);
}
export function stop() { if (timer) clearInterval(timer); timer = null; }
export function setEngine(on) { setSetting("engine_on", on ? "1" : "0"); log("scheduler", on ? "Engine switched ON" : "Engine switched OFF"); if (on) setTimeout(tick, 500); }
