const slotIds = new Set(["location", "origin", "destination", "time_window", "search_scope"]);

export function plannerPlanFromContextPacket(packet, context = {}) {
  const pendingFacts = Array.isArray(packet.slotProposals) ? packet.slotProposals.filter((slot) => slotIds.has(slot)).slice(0, 2) : [];
  const locations = packetLocationsToPlanner(packet.locations);
  const requestedLayer = packet.requestedLayer ? `layer_${packet.requestedLayer}` : null;
  const retrievalMode = inferRetrievalMode(packet, locations, context);
  return {
    domain: packet.turnType === "out_of_scope" ? "not_weather_related" : "weather_related",
    turnType: packet.turnType,
    slotAnswer: plannerSlotAnswerFromPacket(packet.slotAnswer),
    goal: goalFromPacket(packet),
    lens: lensFromPacket(packet),
    activity: packet.application?.activity || null,
    retrievalMode,
    shouldGeocode: locations.some((loc) => loc.raw !== "context"),
    geocodeQueries: locations.filter((loc) => loc.raw !== "context").map((loc) => loc.raw).slice(0, 4),
    locations,
    timeWindow: pendingFacts.includes("time_window") ? { type: "none", value: "" } : plannerTimeWindowFromPacket(packet.timeWindow),
    scope: packet.scope,
    requiredFacts: [
      ...(requestedLayer ? [{ id: requestedLayer, loc: locations.length ? 0 : null, source: "direct", compute: null }] : []),
      ...packet.evidenceRequests.map((request) => ({
        id: request.variable,
        loc: locations.length ? 0 : null,
        source: "direct",
        compute: request.op
          ? {
              op: request.op,
              var: request.variable,
              where: request.threshold ? `${request.threshold.cmp}:${request.threshold.value}` : null,
              over: request.over,
              locs: []
            }
          : null
      })),
      ...packet.externalFactors.map((id) => ({ id, loc: null, source: "external", compute: null })),
      ...packet.externalFactorsOther.map((id) => ({ id, loc: null, source: "external", compute: null }))
    ].slice(0, 12),
    pendingFacts,
    safetyFlags: packet.claimFrame?.forbiddenClaims?.includes("official_safety_clearance") ? ["safety_sensitive"] : [],
    expectedAnswerMode: pendingFacts.length
      ? "ask_followup"
      : packet.claimFrame?.allowedClaimLevel === "weather_exposure_risk" || packet.externalFactors?.length
        ? "answer_with_external_caveat"
        : "answer_from_dashboard"
  };
}

export function plannerSlotAnswerFromPacket(slotAnswer) {
  if (!slotAnswer || typeof slotAnswer !== "object" || !slotIds.has(slotAnswer.slotId)) return null;
  return {
    slotId: slotAnswer.slotId,
    location: slotAnswer.location
      ? {
          raw: slotAnswer.location.raw,
          normalized: slotAnswer.location.normalized || slotAnswer.location.raw,
          role: slotAnswer.location.role === "single" ? "single" : slotAnswer.location.role
        }
      : null,
    timeWindow: slotAnswer.timeWindow ? plannerTimeWindowFromPacket(slotAnswer.timeWindow) : null,
    scope: slotAnswer.scope ?? null
  };
}

export function plannerTimeWindowFromPacket(timeWindow) {
  const kind = String(timeWindow?.kind ?? "none");
  const offset = Number(timeWindow?.dayOffset ?? 0);
  if (kind === "now") return { type: "now", value: "now" };
  if (kind === "day") return { type: "day", value: offset === 1 ? "tomorrow" : "today" };
  if (kind === "daypart") {
    const day = offset === 1 ? "tomorrow " : "";
    return { type: "hour", value: `${day}${timeWindow.daypart ?? "daypart"}`.trim() };
  }
  if (kind === "clock_range") {
    const day = offset === 1 ? "tomorrow " : "";
    const start = Number(timeWindow.startHour);
    const end = Number(timeWindow.endHour);
    const hour = Number.isFinite(start) && Number.isFinite(end) ? Math.round((start + end) / 2) : timeWindow.startHour ?? timeWindow.endHour ?? 12;
    return { type: "hour", value: `${day}${formatHour(hour)}`.trim() };
  }
  if (kind === "multi_day") return { type: "range", value: `next_${Math.max(1, Math.min(16, Number(timeWindow.days ?? 4)))}d` };
  return { type: "range", value: "default_next_4d" };
}

function packetLocationsToPlanner(locations) {
  if (!Array.isArray(locations)) return [];
  return locations
    .filter((loc) => loc?.normalized || loc?.raw)
    .map((loc) => ({
      raw: loc.normalized || loc.raw,
      role: ["single", "origin", "destination", "comparison"].includes(loc.role) ? loc.role : "single"
    }))
    .slice(0, 4);
}

function inferRetrievalMode(packet, locations, context) {
  if (packet.application?.decisionType === "route_assessment") return "route";
  if (packet.application?.decisionType === "compare_places") return "compare_locations";
  if (packet.application?.decisionType === "rank_places" || packet.application?.decisionType === "pick_time_window") return "rank_visible_points";
  if (packet.application?.decisionType === "explain_dashboard") return context?.selected ? "selected_region" : "map_center";
  if (locations.some((loc) => loc.role === "origin" || loc.role === "destination")) return "route";
  if (locations.length > 1) return "compare_locations";
  if (locations.length) return "single_location";
  if (packet.scope?.kind === "selected_region") return "selected_region";
  if (packet.scope?.kind === "current_map") return "map_center";
  return "ask_followup";
}

function lensFromPacket(packet) {
  const activity = String(packet.application?.activity ?? "").toLowerCase().replace(/\s+/g, "_");
  if (/stargaz|night_sky|astronomy/.test(activity)) return "stargazing";
  if (/food_delivery/.test(activity)) return "food_delivery";
  if (/delivery/.test(activity)) return "delivery";
  if (/route|travel/.test(activity)) return "travel";
  if (/clothing|packing/.test(activity)) return "clothing";
  if (/cooling|thermostat|hvac/.test(activity)) return "home_cooling";
  if (/repair|work|construction|concrete|event|outdoor/.test(activity)) return "outdoor_work";
  if (packet.application?.decisionType === "explain_dashboard") return "dashboard_explainer";
  return "generic_weather";
}

function goalFromPacket(packet) {
  const decision = packet.application?.decisionType ?? "describe_conditions";
  const activity = packet.application?.activity ?? "weather question";
  if (decision === "rank_places") return `Rank candidate places for ${activity}.`;
  if (decision === "pick_time_window") return `Find a suitable weather window for ${activity}.`;
  if (decision === "route_assessment") return `Assess route weather for ${activity}.`;
  if (decision === "explain_dashboard") return `Explain the dashboard ${packet.requestedLayer ?? "risk"} signal.`;
  return `Answer the weather-related question for ${activity}.`;
}

function formatHour(hourValue) {
  const hour = Math.max(0, Math.min(23, Number(hourValue) || 12));
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 || 12;
  return `${h12} ${suffix}`;
}
