import { dataManifest } from "../llm/domain/dataManifest.mjs";
import { contextPacketSchema, contextPacketTurnTypes, decisionTypes, forbiddenClaimIds, requestedLayerIds, scopeKinds, timeKinds } from "./schemas/contextPacket.mjs";
import { interpreterDeveloperPrompt, interpreterUserPayload } from "./prompts/interpreter.mjs";
import { localInterpretContextPacket } from "./localInterpreter.mjs";
import { regionIds } from "./regionCatalog.mjs";

const openAiResponsesUrl = "https://api.openai.com/v1/responses";
const slotIds = new Set(["location", "origin", "destination", "time_window", "search_scope"]);

export async function interpretContextPacket(message, { context = {}, session = null, forceLocal = false } = {}) {
  const fallback = verifyContextPacket(localInterpretContextPacket(message, { context, session }), { context, message });
  if (forceLocal || !process.env.OPENAI_API_KEY) return fallback;
  try {
    const raw = await callOpenAiInterpreter(message, context, session);
    return verifyContextPacket(raw, { context, message, fallback });
  } catch {
    return fallback;
  }
}

export function verifyContextPacket(raw, { context = {}, message = "", fallback = null } = {}) {
  const source = raw && typeof raw === "object" ? raw : fallback && typeof fallback === "object" ? fallback : {};
  let locations = Array.isArray(source.locations)
    ? source.locations
        .filter((item) => item && typeof item === "object" && typeof item.raw === "string" && item.raw.trim())
        .map((item) => ({
          raw: item.raw.trim().slice(0, 120),
          normalized: typeof item.normalized === "string" && item.normalized.trim() ? item.normalized.trim().slice(0, 120) : item.raw.trim().slice(0, 120),
          role: ["single", "origin", "destination", "comparison"].includes(item.role) ? item.role : "single"
        }))
        .slice(0, 4)
    : [];
  let scope = sanitizeScope(source.scope);
  const selected = Boolean(context?.selected);
  const fallbackPacket = fallback && typeof fallback === "object" ? fallback : null;
  const fallbackLocations = Array.isArray(fallbackPacket?.locations) ? fallbackPacket.locations : [];
  const fallbackScope = sanitizeScope(fallbackPacket?.scope);
  const fallbackTimeWindow = sanitizeTimeWindow(fallbackPacket?.timeWindow);
  const deterministicMapReference = userMentionsMapContext(message);
  let userReferencedMapContext = deterministicMapReference || Boolean(source.userReferencedMapContext && deterministicMapReference);
  const decisionType = decisionTypes.includes(source.application?.decisionType) ? source.application.decisionType : "describe_conditions";
  let timeWindow = sanitizeTimeWindow(source.timeWindow);
  let slotProposals = sanitizeSlots(source.slotProposals);
  if (!locations.length && fallbackLocations.length) {
    locations = fallbackLocations
      .filter((item) => item && typeof item.raw === "string" && item.raw.trim())
      .map((item) => ({
        raw: item.raw.trim().slice(0, 120),
        normalized: typeof item.normalized === "string" && item.normalized.trim() ? item.normalized.trim().slice(0, 120) : item.raw.trim().slice(0, 120),
        role: ["single", "origin", "destination", "comparison"].includes(item.role) ? item.role : "single"
      }))
      .slice(0, 4);
  }
  if (
    timeWindowSpecificity(fallbackTimeWindow) > timeWindowSpecificity(timeWindow) ||
    (fallbackTimeWindow.kind === "clock_range" && userMentionsClockTime(message))
  ) {
    timeWindow = fallbackTimeWindow;
  }
  if (
    fallbackScope.kind !== "unresolved" &&
    (scope.kind === "unresolved" || (scope.kind === "current_map" && !userReferencedMapContext && !selected))
  ) {
    scope = fallbackScope;
  }
  if (fallbackPacket?.slotProposals?.includes("search_scope") && !selected && !locations.length && !deterministicMapReference) {
    scope = { kind: "unresolved", regionId: null, stateCode: null };
    slotProposals = ["search_scope"];
  }
  slotProposals = slotProposals.filter((slot) => {
    if (slot === "location") return !locations.length && !selected && !["current_map", "named_region", "named_state", "nationwide"].includes(scope.kind);
    if (slot === "time_window") return timeWindow.kind === "none";
    if (slot === "search_scope") return scope.kind === "unresolved" && !locations.length && !selected && !deterministicMapReference;
    if (slot === "origin") return !locations.some((loc) => loc.role === "origin");
    if (slot === "destination") return !locations.some((loc) => loc.role === "destination");
    return true;
  });
  if (
    ["go_no_go", "advise", "pick_time_window"].includes(decisionType) &&
    scope.kind === "current_map" &&
    !locations.length &&
    !selected &&
    !userReferencedMapContext
  ) {
    slotProposals = unique(["location", ...slotProposals]);
  }
  return {
    turnType: contextPacketTurnTypes.includes(source.turnType) ? source.turnType : "new_question",
    slotAnswer: sanitizeSlotAnswer(source.slotAnswer),
    application: {
      activity: typeof source.application?.activity === "string" ? source.application.activity.slice(0, 120) : "weather question",
      decisionType,
      sensitivities: sanitizeEnumArray(source.application?.sensitivities, ["rain", "wind", "heat", "cold", "humidity", "cloud", "alerts"], ["rain", "wind", "heat", "alerts"]),
      audienceFlags: sanitizeEnumArray(source.application?.audienceFlags, ["elderly", "children", "workers", "pets", "none"], ["none"])
    },
    scope,
    locations,
    timeWindow,
    evidenceRequests: sanitizeEvidenceRequests(source.evidenceRequests),
    externalFactors: sanitizeEnumArray(source.externalFactors, dataManifest.notAvailable, []),
    externalFactorsOther: Array.isArray(source.externalFactorsOther) ? source.externalFactorsOther.filter((item) => typeof item === "string").map((item) => item.slice(0, 80)).slice(0, 6) : [],
    slotProposals,
    claimFrame: {
      allowedClaimLevel: ["weather_conditions", "weather_suitability", "weather_exposure_risk", "dashboard_explanation"].includes(source.claimFrame?.allowedClaimLevel)
        ? source.claimFrame.allowedClaimLevel
        : "weather_conditions",
      forbiddenClaims: sanitizeEnumArray(source.claimFrame?.forbiddenClaims, forbiddenClaimIds, [])
    },
    requestedLayer: requestedLayerIds.includes(source.requestedLayer) ? source.requestedLayer : null,
    confidence: ["low", "medium", "high"].includes(source.confidence) ? source.confidence : "medium",
    userReferencedMapContext
  };
}

async function callOpenAiInterpreter(message, context, session) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        { role: "developer", content: interpreterDeveloperPrompt() },
        { role: "user", content: JSON.stringify(interpreterUserPayload({ message, context, session }), null, 2) }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "skyscout_context_packet",
          strict: true,
          schema: contextPacketSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function parseOpenAiJson(raw) {
  const direct = raw?.output_parsed;
  if (direct && typeof direct === "object") return direct;
  const text =
    raw?.output_text ??
    raw?.output?.flatMap((item) => item.content ?? []).find((item) => item?.type === "output_text" && typeof item.text === "string")?.text ??
    raw?.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI response did not contain JSON text");
  return JSON.parse(text);
}

function sanitizeSlotAnswer(value) {
  if (!value || typeof value !== "object" || !slotIds.has(value.slotId)) return null;
  return {
    slotId: value.slotId,
    location: sanitizeSlotLocation(value.location),
    timeWindow: value.timeWindow ? sanitizeTimeWindow(value.timeWindow) : null,
    scope: value.scope ? sanitizeScope(value.scope) : null
  };
}

function sanitizeSlotLocation(value) {
  if (!value || typeof value !== "object" || typeof value.raw !== "string" || !value.raw.trim()) return null;
  const role = ["single", "origin", "destination"].includes(value.role) ? value.role : "single";
  return {
    raw: value.raw.trim().slice(0, 120),
    normalized: typeof value.normalized === "string" && value.normalized.trim() ? value.normalized.trim().slice(0, 120) : value.raw.trim().slice(0, 120),
    role
  };
}

function sanitizeScope(value) {
  if (!value || typeof value !== "object") return { kind: "unresolved", regionId: null, stateCode: null };
  const kind = scopeKinds.includes(value.kind) ? value.kind : "unresolved";
  const regionId = typeof value.regionId === "string" && regionIds.includes(value.regionId) ? value.regionId : null;
  const stateCode = typeof value.stateCode === "string" && /^[A-Za-z]{2}$/.test(value.stateCode) ? value.stateCode.toUpperCase() : null;
  return { kind, regionId, stateCode };
}

function sanitizeTimeWindow(value) {
  if (!value || typeof value !== "object") return { kind: "none", dayOffset: null, days: null, daypart: null, startHour: null, endHour: null };
  const kind = timeKinds.includes(value.kind) ? value.kind : "none";
  return {
    kind,
    dayOffset: numberOrNull(value.dayOffset),
    days: numberOrNull(value.days),
    daypart: typeof value.daypart === "string" && value.daypart.trim() ? value.daypart.trim().slice(0, 40) : null,
    startHour: numberOrNull(value.startHour),
    endHour: numberOrNull(value.endHour)
  };
}

function sanitizeEvidenceRequests(value) {
  if (!Array.isArray(value)) return [];
  const vars = new Set(Object.keys(dataManifest.variables));
  return value
    .filter((item) => item && typeof item === "object" && vars.has(item.variable))
    .map((item) => ({
      variable: item.variable,
      op: ["mean", "max", "min", "sum", "count", "threshold", "rank_locations", "best_window"].includes(item.op) ? item.op : "max",
      over: ["window", "per_day", "hourly"].includes(item.over) ? item.over : "window",
      threshold:
        item.threshold && typeof item.threshold === "object" && ["gte", "lte"].includes(item.threshold.cmp) && Number.isFinite(Number(item.threshold.value))
          ? { cmp: item.threshold.cmp, value: Number(item.threshold.value) }
          : null,
      appliesTo: ["each_location", "each_candidate", "route_points"].includes(item.appliesTo) ? item.appliesTo : "each_location"
    }))
    .slice(0, 14);
}

function sanitizeSlots(value) {
  return unique(Array.isArray(value) ? value.filter((item) => slotIds.has(item)) : []).slice(0, 3);
}

function sanitizeEnumArray(value, allowed, fallback) {
  const set = new Set(allowed);
  const items = Array.isArray(value) ? value.filter((item) => set.has(item)) : [];
  return unique(items.length ? items : fallback);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function userMentionsMapContext(message) {
  return /\b(this|current|selected)\s+(?:map|view|area|region|location|place)|\bhere\b|\bnearby\b|\bvisible\s+(?:map|areas?|regions?|places?)\b/i.test(
    String(message ?? "")
  );
}

function userMentionsClockTime(message) {
  return /\b(?:around|at|by|about|near)?\s*(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm)\b/i.test(String(message ?? ""));
}

function timeWindowSpecificity(value) {
  const kind = String(value?.kind ?? "none");
  if (kind === "clock_range") return 5;
  if (kind === "daypart") return 4;
  if (kind === "day") return 3;
  if (kind === "multi_day") return 2;
  if (kind === "now") return 1;
  return 0;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
