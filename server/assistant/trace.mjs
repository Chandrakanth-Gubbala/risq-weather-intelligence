import { randomUUID } from "node:crypto";

const maxTraceEntries = 100;
const traceBuffer = [];

export function createChatTrace({ message = "", sessionId = null } = {}) {
  return {
    traceId: randomUUID(),
    ts: new Date().toISOString(),
    sessionId,
    message: String(message ?? "").slice(0, 1200),
    stage_outputs: {},
    overridesApplied: [],
    violations: [],
    finalAnswerFirst120Chars: "",
    llmCalls: []
  };
}

export function recordTraceStage(trace, stage, value) {
  if (!trace || !stage) return;
  trace.stage_outputs[stage] = compactForTrace(value);
}

export function recordTraceOverride(trace, value) {
  if (!trace || !value) return;
  trace.overridesApplied.push(String(value).slice(0, 160));
}

export function recordTraceViolation(trace, value) {
  if (!trace || !value) return;
  trace.violations.push(String(value).slice(0, 160));
}

export function recordTraceLlmCall(trace, { stage, model, ms } = {}) {
  if (!trace || !stage) return;
  trace.llmCalls.push({
    stage,
    model: model ? String(model).slice(0, 80) : null,
    ms: Number.isFinite(ms) ? Math.round(ms) : null
  });
}

export function finishChatTrace(trace, response = null) {
  if (!trace) return;
  trace.finalAnswerFirst120Chars = String(response?.answer ?? "").slice(0, 120);
  pushTrace(trace);
  console.log(JSON.stringify(trace));
}

export function getTraceBuffer() {
  return traceBuffer.slice();
}

function pushTrace(trace) {
  traceBuffer.push(trace);
  while (traceBuffer.length > maxTraceEntries) traceBuffer.shift();
}

function compactForTrace(value) {
  if (value == null || typeof value !== "object") return value;
  try {
    return JSON.parse(
      JSON.stringify(value, (key, item) => {
        if (key === "hourly") return Array.isArray(item) ? item.slice(0, 3) : item;
        if (key === "features") return Array.isArray(item) ? `[${item.length} features]` : item;
        if (typeof item === "string") return item.length > 500 ? `${item.slice(0, 500)}...` : item;
        if (Array.isArray(item) && item.length > 12) return item.slice(0, 12);
        return item;
      })
    );
  } catch {
    return { unserializable: true };
  }
}
