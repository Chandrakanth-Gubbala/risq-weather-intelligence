import { randomUUID } from "node:crypto";

const maxSessions = 500;
const sessionTtlMs = 2 * 60 * 60_000;
const maxTranscriptItems = 6;
const sessions = new Map();

export function getOrCreateSession(sessionId) {
  pruneSessions();
  const existing = typeof sessionId === "string" ? sessions.get(sessionId) : null;
  if (existing) {
    touchSession(existing);
    return existing;
  }
  const session = {
    id: randomUUID(),
    turnCounter: 0,
    transcript: [],
    pendingSlot: null,
    storedPlan: null,
    entities: {
      locations: [],
      lastScope: null,
      lastTimeWindow: null,
      lastApplication: null
    },
    updatedAt: Date.now()
  };
  sessions.set(session.id, session);
  trimLru();
  return session;
}

export function beginSessionTurn(session) {
  session.turnCounter += 1;
  expireSlots(session);
  touchSession(session);
  return session;
}

export function touchSession(session) {
  session.updatedAt = Date.now();
  sessions.delete(session.id);
  sessions.set(session.id, session);
  return session;
}

export function expireSlots(session) {
  if (session.pendingSlot && session.turnCounter - Number(session.pendingSlot.createdTurn ?? 0) > 1) {
    session.pendingSlot = null;
  }
  return session;
}

export function setPendingSlot(session, slotId, plan, questionShown) {
  const planId = plan?.planId || randomUUID();
  const previous = session.pendingSlot?.slotId === slotId && session.pendingSlot?.planId === planId ? session.pendingSlot : null;
  session.pendingSlot = {
    slotId,
    planId,
    questionShown: String(questionShown ?? "").slice(0, 240),
    createdTurn: session.turnCounter,
    attempts: previous ? Math.min(2, Number(previous.attempts ?? 1) + 1) : 1
  };
  session.storedPlan = { ...plan, planId };
  rememberPlanEntities(session, session.storedPlan);
  touchSession(session);
  return session.pendingSlot;
}

export function clearPendingSlot(session) {
  session.pendingSlot = null;
  touchSession(session);
}

export function storeValidatedPlan(session, plan) {
  if (!plan || typeof plan !== "object") return null;
  const planId = plan.planId || randomUUID();
  session.storedPlan = { ...plan, planId };
  rememberPlanEntities(session, session.storedPlan);
  touchSession(session);
  return session.storedPlan;
}

export function appendTranscript(session, userText, response) {
  if (userText) {
    session.transcript.push({
      role: "user",
      text: String(userText).slice(0, 1200),
      summary: null
    });
  }
  if (response?.answer) {
    session.transcript.push({
      role: "assistant",
      text: String(response.answer).slice(0, 1200),
      summary: responseSummary(response)
    });
  }
  if (session.transcript.length > maxTranscriptItems) {
    session.transcript = session.transcript.slice(-maxTranscriptItems);
  }
  touchSession(session);
}

export function conversationStateForClient(session) {
  return { sessionId: session.id };
}

export function compactSessionForPlanner(session) {
  return {
    sessionId: session.id,
    turnCounter: session.turnCounter,
    transcript: session.transcript.slice(-maxTranscriptItems),
    pendingSlot: session.pendingSlot
      ? {
          slotId: session.pendingSlot.slotId,
          questionShown: session.pendingSlot.questionShown,
          attempts: session.pendingSlot.attempts
        }
      : null,
    entities: session.entities
  };
}

function responseSummary(response) {
  return {
    verdict: response?.verdict ?? null,
    place: response?.facts?.location ?? firstActionLabel(response),
    window: Array.isArray(response?.bestWindows) && response.bestWindows[0] ? response.bestWindows[0].label : null
  };
}

function firstActionLabel(response) {
  const action = Array.isArray(response?.actions) ? response.actions[0] : null;
  return typeof action?.label === "string" ? action.label : null;
}

function rememberPlanEntities(session, plan) {
  if (!plan || typeof plan !== "object") return;
  if (plan.lens) session.entities.lastApplication = String(plan.lens).slice(0, 80);
  if (plan.timeWindow?.value) session.entities.lastTimeWindow = plan.timeWindow;
  if (plan.scope) session.entities.lastScope = plan.scope;
  const locations = Array.isArray(plan.locations) ? plan.locations : [];
  for (const location of locations) {
    if (!location?.raw || location.raw === "context") continue;
    const label = String(location.raw).slice(0, 120);
    if (session.entities.locations.some((item) => item.label.toLowerCase() === label.toLowerCase())) continue;
    session.entities.locations.unshift({ label, lat: null, lon: null });
  }
  session.entities.locations = session.entities.locations.slice(0, 6);
}

function pruneSessions() {
  const cutoff = Date.now() - sessionTtlMs;
  for (const [id, session] of sessions) {
    if (Number(session.updatedAt ?? 0) < cutoff) sessions.delete(id);
  }
  trimLru();
}

function trimLru() {
  while (sessions.size > maxSessions) {
    const oldest = sessions.keys().next().value;
    if (!oldest) return;
    sessions.delete(oldest);
  }
}
