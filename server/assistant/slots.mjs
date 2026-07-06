import { canonicalSlotId } from "./followupTemplates.mjs";

const regionAliases = new Map([
  ["northeast", "northeast"],
  ["north east", "northeast"],
  ["new england", "new_england"],
  ["mid atlantic", "mid_atlantic"],
  ["mid-atlantic", "mid_atlantic"],
  ["great lakes", "great_lakes"],
  ["southeast", "southeast"],
  ["south east", "southeast"],
  ["midwest", "midwest"],
  ["southwest", "southwest"],
  ["south west", "southwest"],
  ["northwest", "northwest"],
  ["north west", "northwest"],
  ["pacific northwest", "northwest"],
  ["pnw", "northwest"],
  ["west coast", "west_coast"],
  ["east coast", "east_coast"],
  ["gulf coast", "gulf_coast"],
  ["mountain west", "mountain_west"],
  ["rockies", "mountain_west"],
  ["california", "california"],
  ["nationwide", "nationwide"],
  ["anywhere in the us", "nationwide"],
  ["anywhere in the u.s.", "nationwide"],
  ["united states", "nationwide"],
  ["usa", "nationwide"],
  ["us", "nationwide"],
  ["u s", "nationwide"]
]);

const stateCodes = new Set([
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY",
  "DC"
]);

export function classifyPendingSlotTurn(message, session, helpers = {}) {
  const pending = session?.pendingSlot;
  if (!pending?.slotId) return { turnType: "new_question", slotAnswer: null };
  const slotId = canonicalSlotId(pending.slotId);
  if (!slotId) return { turnType: "new_question", slotAnswer: null };
  const text = normalizeText(message);
  if (!text) return { turnType: "slot_answer", slotAnswer: null, reason: "empty" };
  if (/^(?:never mind|nevermind|cancel|forget it|stop|skip|no thanks)$/i.test(text)) {
    return { turnType: "cancel", slotAnswer: null };
  }

  const routeLocations = helpers.extractRouteLocations?.(message) ?? [];
  const location = helpers.extractLocation?.(message) ?? extractBareLocationAnswer(message);
  const timeWindow = helpers.hasExplicitPlanningWindow?.(message) ? helpers.plannerTimeWindowFromMessage?.(message) : null;
  const scope = scopeFromText(message);

  if (looksLikeNewStandaloneQuestion(message, slotId, { location, routeLocations, timeWindow, scope })) {
    return { turnType: "new_question", slotAnswer: null };
  }

  if (slotId === "search_scope" && scope) {
    return {
      turnType: "scope_answer",
      slotAnswer: { slotId, location: null, timeWindow: timeWindow ?? null, scope }
    };
  }
  if (slotId === "location" && location) {
    return {
      turnType: "slot_answer",
      slotAnswer: {
        slotId,
        location: { raw: location, normalized: location, role: "single" },
        timeWindow: timeWindow ?? null,
        scope: null
      }
    };
  }
  if ((slotId === "origin" || slotId === "destination") && routeLocations.length >= 2) {
    const role = slotId;
    const value = role === "origin" ? routeLocations[0] : routeLocations[1];
    return {
      turnType: "slot_answer",
      slotAnswer: {
        slotId,
        location: { raw: value, normalized: value, role },
        timeWindow: timeWindow ?? null,
        scope: null,
        routeLocations
      }
    };
  }
  if (slotId === "time_window" && timeWindow) {
    return {
      turnType: "slot_answer",
      slotAnswer: { slotId, location: location ? { raw: location, normalized: location, role: "single" } : null, timeWindow, scope: null }
    };
  }

  return { turnType: "slot_answer", slotAnswer: null, reason: "unfilled" };
}

export function mergeSlotAnswerIntoPlan(plan, slotAnswer) {
  if (!plan || typeof plan !== "object" || !slotAnswer) return plan;
  const slotId = canonicalSlotId(slotAnswer.slotId);
  if (!slotId) return plan;
  const next = {
    ...plan,
    locations: Array.isArray(plan.locations) ? [...plan.locations] : [],
    pendingFacts: Array.isArray(plan.pendingFacts) ? [...plan.pendingFacts] : []
  };
  if (slotId === "location" && slotAnswer.location?.raw) {
    next.locations = [{ raw: slotAnswer.location.normalized || slotAnswer.location.raw, role: "single" }];
    next.shouldGeocode = true;
    next.geocodeQueries = [slotAnswer.location.normalized || slotAnswer.location.raw];
    if (next.retrievalMode === "ask_followup") next.retrievalMode = "single_location";
  }
  if ((slotId === "origin" || slotId === "destination") && Array.isArray(slotAnswer.routeLocations) && slotAnswer.routeLocations.length >= 2) {
    next.locations = [
      { raw: slotAnswer.routeLocations[0], role: "origin" },
      { raw: slotAnswer.routeLocations[1], role: "destination" }
    ];
    next.shouldGeocode = true;
    next.geocodeQueries = slotAnswer.routeLocations.slice(0, 2);
    next.retrievalMode = "route";
  } else if ((slotId === "origin" || slotId === "destination") && slotAnswer.location?.raw) {
    const existing = next.locations.filter((loc) => loc?.role !== slotId);
    next.locations = [...existing, { raw: slotAnswer.location.normalized || slotAnswer.location.raw, role: slotId }];
    next.shouldGeocode = true;
    next.geocodeQueries = next.locations.filter((loc) => loc.raw !== "context").map((loc) => loc.raw);
    if (next.locations.some((loc) => loc.role === "origin") && next.locations.some((loc) => loc.role === "destination")) {
      next.retrievalMode = "route";
    }
  }
  if (slotId === "search_scope" && slotAnswer.scope) {
    next.scope = slotAnswer.scope;
    next.retrievalMode = "rank_visible_points";
    next.shouldGeocode = false;
    next.geocodeQueries = [];
    next.locations = [];
  }
  if (slotAnswer.timeWindow?.type && slotAnswer.timeWindow.type !== "none") {
    next.timeWindow = slotAnswer.timeWindow;
  }
  next.pendingFacts = next.pendingFacts
    .filter((fact) => fact !== slotId)
    .filter((fact) => !(fact === "time_window" && slotAnswer.timeWindow?.type && slotAnswer.timeWindow.type !== "none"));
  if (!next.pendingFacts.length && next.expectedAnswerMode === "ask_followup") {
    next.expectedAnswerMode = next.expectedAnswerMode === "unsupported_redirect" ? next.expectedAnswerMode : "answer_from_dashboard";
  }
  return next;
}

export function slotProposalFromPlan(plan) {
  const pending = Array.isArray(plan?.pendingFacts) ? plan.pendingFacts.map(canonicalSlotId).filter(Boolean) : [];
  return pending[0] ?? null;
}

export function isClosedSlotId(value) {
  return Boolean(canonicalSlotId(value));
}

function looksLikeNewStandaloneQuestion(message, slotId, filled) {
  if (filled.location || filled.routeLocations?.length >= 2 || filled.timeWindow || (slotId === "search_scope" && filled.scope)) {
    return false;
  }
  const text = normalizeText(message);
  if (!/[?]/.test(String(message)) && text.split(/\s+/).length <= 4) return false;
  return /\b(find|show|explain|compare|rank|where|which|what|weather|forecast|risk|fire|stargaz|outdoor|delivery|travel|drive|route|should|can|do|will|would)\b/i.test(
    text
  );
}

function scopeFromText(message) {
  const text = normalizeText(message).replace(/[.?!]+$/g, "");
  if (/^(?:current|visible|this)\s+(?:map|view|map view|area|region)|^here$|^this area$/.test(text)) {
    return { kind: "current_map", regionId: null, stateCode: null };
  }
  for (const [alias, regionId] of regionAliases) {
    if (text === alias || text.includes(alias)) {
      return { kind: regionId === "nationwide" ? "nationwide" : "named_region", regionId, stateCode: null };
    }
  }
  const state = text.match(/\b([a-z]{2})\b/)?.[1]?.toUpperCase();
  if (state && stateCodes.has(state)) return { kind: "named_state", regionId: null, stateCode: state };
  return null;
}

function extractBareLocationAnswer(message) {
  const original = String(message ?? "").replace(/\s+/g, " ").trim();
  const cleaned = original
    .replace(/\b(next|this|coming)\s+week(?:end)?\b.*$/i, "")
    .replace(/\b(today|tomorrow|tonight|morning|afternoon|evening|overnight)\b.*$/i, "")
    .replace(/\b(?:around|at|by|about|near)\s+\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?\b.*$/i, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 80) return null;
  if (!/[A-Za-z]/.test(cleaned)) return null;
  if (/^(yes|no|maybe|morning|afternoon|evening|night|today|tomorrow)$/i.test(cleaned)) return null;
  if (/^(?:north|south|east|west|northeast|southeast|midwest|southwest|northwest)$/i.test(cleaned)) return null;
  return cleaned;
}

function normalizeText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
