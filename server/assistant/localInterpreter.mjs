import { regionCatalog } from "./regionCatalog.mjs";

const knownLocations = new Map([
  ["boston", "Boston, MA"],
  ["boston ma", "Boston, MA"],
  ["rochester", "Rochester, NY"],
  ["rochester ny", "Rochester, NY"],
  ["new york", "New York, NY"],
  ["new york city", "New York, NY"],
  ["nyc", "New York, NY"],
  ["philadelphia", "Philadelphia, PA"],
  ["philadelphia pa", "Philadelphia, PA"],
  ["portland maine", "Portland, ME"],
  ["portland me", "Portland, ME"],
  ["houston", "Houston, TX"],
  ["houston texas", "Houston, TX"],
  ["houston tx", "Houston, TX"],
  ["dallas", "Dallas, TX"],
  ["dallas tx", "Dallas, TX"],
  ["birmingham", "Birmingham, AL"],
  ["birmingham al", "Birmingham, AL"],
  ["birmingham alabama", "Birmingham, AL"],
  ["birmiingham alabama", "Birmingham, AL"],
  ["birmiingham al", "Birmingham, AL"],
  ["denver", "Denver, CO"],
  ["denver co", "Denver, CO"],
  ["phoenix", "Phoenix, AZ"],
  ["phoenix az", "Phoenix, AZ"],
  ["boise", "Boise, ID"],
  ["boise id", "Boise, ID"],
  ["salt lake city", "Salt Lake City, UT"],
  ["salt lake city utah", "Salt Lake City, UT"]
]);

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
  ["california", "california"]
]);

export function localInterpretContextPacket(message, { context = {}, session = null } = {}) {
  const text = cleanText(message);
  const pendingSlot = session?.pendingSlot?.slotId ?? null;
  if (isUnsafe(text)) return packet({ turnType: "unsafe", decisionType: "describe_conditions", activity: "unsafe request", slotProposals: [] });
  if (isGreeting(text)) return packet({ turnType: "chitchat", decisionType: "describe_conditions", activity: "greeting", slotProposals: [] });
  if (pendingSlot) {
    const pending = pendingSlotPacket(message, pendingSlot);
    if (pending) return pending;
  }
  if (isOutOfScope(text)) return packet({ turnType: "out_of_scope", decisionType: "describe_conditions", activity: "out of scope", slotProposals: [] });

  const route = extractRoute(message);
  const location = extractLocation(message);
  const scope = inferScope(message, context);
  const timeWindow = inferTimeWindow(message);
  const requestedLayer = inferLayer(text);
  const mapContext = referencesMap(text);
  const selected = Boolean(context?.selected);

  if (route.length >= 2) {
    return packet({
      decisionType: "route_assessment",
      activity: "route travel",
      sensitivities: ["rain", "wind", "heat", "alerts"],
      locations: [
        loc(route[0], "origin"),
        loc(route[1], "destination")
      ],
      timeWindow,
      evidenceRequests: evidence(["temp_max", "apparent_temp", "precip_sum", "wind_speed", "alerts_active"], "route_points"),
      externalFactors: ["traffic_conditions", "road_closures"],
      forbiddenClaims: ["traffic_or_road_status", "official_safety_clearance"],
      claimLevel: "weather_exposure_risk"
    });
  }

  if (requestedLayer && /\b(explain|why|what does|this area|area'?s|risk|score)\b/.test(text) && !/\b(which|where|highest|lowest|best|rank)\b/.test(text)) {
    return packet({
      decisionType: "explain_dashboard",
      activity: "dashboard explanation",
      scope: selected ? scopeObj("selected_region") : scopeObj(mapContext ? "current_map" : "current_map"),
      requestedLayer,
      evidenceRequests: evidence([`layer_${requestedLayer}`]),
      claimLevel: "dashboard_explanation"
    });
  }

  if (/\b(stargaz\w*|star gaz\w*|stars?|night sky|meteor|telescope|astronomy)\b/.test(text)) {
    const hasScope = scope.kind !== "unresolved";
    return packet({
      decisionType: "rank_places",
      activity: "stargazing",
      sensitivities: ["cloud", "rain", "wind", "alerts"],
      scope,
      timeWindow: timeWindow.kind === "none" ? daypartWindow("tonight") : timeWindow,
      evidenceRequests: evidence(["cloud_cover", "precip_sum", "wind_speed", "alerts_active"], "each_candidate", "rank_locations"),
      externalFactors: ["light_pollution", "moon_phase", "smoke_haze", "astronomical_seeing"],
      forbiddenClaims: ["dark_sky_guarantee"],
      slotProposals: hasScope ? [] : ["search_scope"],
      claimLevel: "weather_suitability"
    });
  }

  if (/\b(which|where|highest|lowest|best|rank|compare|good)\b/.test(text) && (requestedLayer || /\b(area|place|region|location|spot|outdoor window)\b/.test(text))) {
    const inferredScope = scope.kind !== "unresolved" ? scope : referencesVisible(text) || requestedLayer ? scopeObj("current_map") : scopeObj("unresolved");
    return packet({
      decisionType: /\boutdoor window\b/.test(text) ? "pick_time_window" : "rank_places",
      activity: requestedLayer ? `${requestedLayer} ranking` : "weather ranking",
      sensitivities: requestedLayer === "fire" ? ["wind", "heat", "humidity", "alerts"] : ["rain", "wind", "heat", "alerts"],
      scope: inferredScope,
      requestedLayer,
      timeWindow,
      evidenceRequests: evidence([requestedLayer ? `layer_${requestedLayer}` : "risk_score", "temp_max", "precip_sum", "wind_speed", "alerts_active"], "each_candidate", "rank_locations"),
      slotProposals: inferredScope.kind === "unresolved" ? ["search_scope"] : [],
      claimLevel: "weather_suitability"
    });
  }

  if (/\b(delivery|deliver|delivary|food|restaurant|doordash|uber eats|ubereats|grubhub|amazon|package|parcel|shipment)\b/.test(text)) {
    const slots = [];
    if (!location && !mapContext && !selected) slots.push("location");
    if (timeWindow.kind === "none" || timeWindow.kind === "multi_day") slots.push("time_window");
    const food = /\b(food|restaurant|doordash|uber eats|ubereats|grubhub)\b/.test(text);
    return packet({
      decisionType: "go_no_go",
      activity: food ? "food delivery" : "delivery",
      sensitivities: ["rain", "wind", "heat", "alerts"],
      locations: location ? [loc(location)] : [],
      scope: location ? scopeObj("explicit_locations") : selected ? scopeObj("selected_region") : mapContext ? scopeObj("current_map") : scopeObj("unresolved"),
      timeWindow,
      evidenceRequests: evidence(["hourly_precip", "hourly_wind", "hourly_apparent_temp", "alerts_active"]),
      externalFactors: food ? ["traffic_conditions", "courier_assignment", "restaurant_prep_status"] : ["traffic_conditions", "courier_assignment", "package_tracking_status"],
      forbiddenClaims: ["eta_or_delay_prediction", "traffic_or_road_status"],
      slotProposals: slots,
      claimLevel: "weather_exposure_risk"
    });
  }

  if (/\b(ac|a\/c|air conditioning|thermostat|hvac|cooling|cool my house|cool my home)\b/.test(text)) {
    return packet({
      decisionType: "advise",
      activity: "home cooling",
      sensitivities: ["heat", "humidity", "cloud", "alerts"],
      locations: location ? [loc(location)] : [],
      scope: location ? scopeObj("explicit_locations") : selected ? scopeObj("selected_region") : mapContext ? scopeObj("current_map") : scopeObj("unresolved"),
      timeWindow,
      evidenceRequests: evidence(["apparent_temp", "humidity", "cloud_cover", "cooling_degree_days", "alerts_active"]),
      externalFactors: ["business_financial_metrics"],
      forbiddenClaims: ["exact_setpoint", "outcome_guarantee"],
      slotProposals: location || selected || mapContext ? [] : ["location"],
      claimLevel: "weather_suitability"
    });
  }

  if (/\b(wear|clothing|clothes|dress|outfit|jacket|coat|umbrella|raincoat|packing|pack)\b/.test(text)) {
    return packet({
      decisionType: "advise",
      activity: "clothing guidance",
      sensitivities: ["rain", "wind", "heat", "cold", "humidity", "alerts"],
      locations: location ? [loc(location)] : [],
      scope: location ? scopeObj("explicit_locations") : selected ? scopeObj("selected_region") : mapContext ? scopeObj("current_map") : scopeObj("unresolved"),
      timeWindow,
      evidenceRequests: evidence(["temp_max", "temp_min", "apparent_temp", "precip_sum", "wind_speed", "humidity", "alerts_active"]),
      forbiddenClaims: ["medical_advice", "outcome_guarantee"],
      slotProposals: location || selected || mapContext ? [] : ["location"],
      claimLevel: "weather_suitability"
    });
  }

  if (/\b(repair|repairs|paint|painting|roof|roofing|siding|gutter|ladder|exterior|construction|crew|field|pour concrete|concrete|outdoor|outside|event|picnic|park|festival|concert|wedding)\b/.test(text)) {
    const slots = [];
    if (!location && !selected && !mapContext && scope.kind === "unresolved") slots.push(/\boutdoor window\b/.test(text) ? "search_scope" : "location");
    const concrete = /\bconcrete\b/.test(text);
    return packet({
      decisionType: /\b(find|pick|best|window|when)\b/.test(text) ? "pick_time_window" : "go_no_go",
      activity: concrete ? "concrete work" : "outdoor work",
      sensitivities: ["rain", "wind", "heat", "humidity", "alerts"],
      locations: location ? [loc(location)] : [],
      scope: location ? scopeObj("explicit_locations") : selected ? scopeObj("selected_region") : mapContext ? scopeObj("current_map") : scope,
      timeWindow,
      evidenceRequests: concrete
        ? evidence(["hourly_temp", "hourly_precip", "wind_speed", "temp_min", "alerts_active"])
        : evidence(["temp_max", "apparent_temp", "precip_sum", "wind_speed", "humidity", "alerts_active"]),
      externalFactors: ["local_regulations"],
      forbiddenClaims: ["official_safety_clearance", "business_metric_prediction"],
      slotProposals: slots,
      claimLevel: "weather_suitability"
    });
  }

  if (/\b(weather|forecast|rain|wind|heat|hot|cold|temperature|storm|alert|cloud|humidity)\b/.test(text) || location || mapContext || selected) {
    return packet({
      decisionType: "describe_conditions",
      activity: "weather summary",
      sensitivities: ["rain", "wind", "heat", "cold", "alerts"],
      locations: location ? [loc(location)] : [],
      scope: location ? scopeObj("explicit_locations") : selected ? scopeObj("selected_region") : mapContext ? scopeObj("current_map") : scopeObj("unresolved"),
      timeWindow,
      evidenceRequests: evidence(["temp_max", "temp_min", "apparent_temp", "precip_sum", "wind_speed", "alerts_active"]),
      slotProposals: location || selected || mapContext ? [] : ["location"],
      claimLevel: "weather_conditions"
    });
  }

  return packet({ turnType: "out_of_scope", decisionType: "describe_conditions", activity: "out of scope", slotProposals: [] });
}

function pendingSlotPacket(message, pendingSlot) {
  const text = cleanText(message);
  if (/^(never mind|nevermind|cancel|forget it|stop|skip|no thanks)$/.test(text)) return packet({ turnType: "cancel", slotProposals: [] });
  const route = extractRoute(message);
  const location = extractLocation(message);
  const scope = inferScope(message, {});
  const timeWindow = inferTimeWindow(message);
  const answeredLocation = location && ["location", "origin", "destination"].includes(pendingSlot);
  const answeredRoute = route.length >= 2 && ["origin", "destination"].includes(pendingSlot);
  const answeredTime = timeWindow.kind !== "none" && pendingSlot === "time_window";
  const answeredScope = scope.kind !== "unresolved" && pendingSlot === "search_scope";
  const looksNew = /\b(which|where|what|weather|forecast|risk|fire|stargaz|delivery|travel|route|explain|find|rank)\b/.test(text);
  if (!answeredLocation && !answeredRoute && !answeredTime && !answeredScope && looksNew && text.length > 12) {
    return null;
  }
  if (answeredScope) {
    return packet({
      turnType: "scope_answer",
      slotAnswer: { slotId: "search_scope", location: null, timeWindow: timeWindow.kind === "none" ? null : timeWindow, scope },
      scope,
      timeWindow,
      slotProposals: []
    });
  }
  if (answeredRoute) {
    return packet({
      turnType: "slot_answer",
      slotAnswer: { slotId: pendingSlot, location: loc(route[pendingSlot === "origin" ? 0 : 1], pendingSlot), timeWindow: timeWindow.kind === "none" ? null : timeWindow, scope: null },
      locations: [loc(route[0], "origin"), loc(route[1], "destination")],
      timeWindow,
      slotProposals: []
    });
  }
  if (answeredLocation) {
    return packet({
      turnType: "slot_answer",
      slotAnswer: { slotId: pendingSlot, location: loc(location, pendingSlot === "location" ? "single" : pendingSlot), timeWindow: timeWindow.kind === "none" ? null : timeWindow, scope: null },
      locations: [loc(location)],
      timeWindow,
      slotProposals: []
    });
  }
  if (answeredTime) {
    return packet({
      turnType: "slot_answer",
      slotAnswer: { slotId: "time_window", location: location ? loc(location) : null, timeWindow, scope: null },
      locations: location ? [loc(location)] : [],
      timeWindow,
      slotProposals: []
    });
  }
  return null;
}

function packet(options = {}) {
  const scope = options.scope ?? scopeObj("unresolved");
  return {
    turnType: options.turnType ?? "new_question",
    slotAnswer: options.slotAnswer ?? null,
    application: {
      activity: options.activity ?? "weather question",
      decisionType: options.decisionType ?? "describe_conditions",
      sensitivities: [...new Set(options.sensitivities ?? ["rain", "wind", "heat", "alerts"])],
      audienceFlags: options.audienceFlags ?? ["none"]
    },
    scope,
    locations: options.locations ?? [],
    timeWindow: options.timeWindow ?? noneWindow(),
    evidenceRequests: options.evidenceRequests ?? [],
    externalFactors: options.externalFactors ?? [],
    externalFactorsOther: options.externalFactorsOther ?? [],
    slotProposals: options.slotProposals ?? [],
    claimFrame: {
      allowedClaimLevel: options.claimLevel ?? "weather_conditions",
      forbiddenClaims: [...new Set(options.forbiddenClaims ?? [])]
    },
    requestedLayer: options.requestedLayer ?? null,
    confidence: options.confidence ?? "medium",
    userReferencedMapContext: options.userReferencedMapContext ?? ["current_map", "selected_region"].includes(scope.kind)
  };
}

function evidence(variables, appliesTo = "each_location", op = "max") {
  return [...new Set(variables)].map((variable) => ({
    variable,
    op: variable === "precip_sum" || variable === "hourly_precip" ? "sum" : op,
    over: variable.startsWith("hourly_") ? "hourly" : "window",
    threshold: null,
    appliesTo
  }));
}

function inferTimeWindow(message) {
  const text = cleanText(message);
  const hour = text.match(/\b(?:around|at|by|about|near)?\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  const dayOffset = /\btomorrow\b/.test(text) ? 1 : 0;
  if (hour) {
    let h = Number(hour[1]) % 12;
    if (hour[3] === "pm") h += 12;
    return { kind: "clock_range", dayOffset, days: 1, daypart: daypartForHour(h), startHour: Math.max(0, h - 1), endHour: Math.min(24, h + 1) };
  }
  if (/\btonight\b/.test(text)) return daypartWindow("tonight");
  if (/\bmorning\b/.test(text)) return { kind: "daypart", dayOffset, days: 1, daypart: "morning", startHour: 6, endHour: 12 };
  if (/\bafternoon\b/.test(text)) return { kind: "daypart", dayOffset, days: 1, daypart: "afternoon", startHour: 12, endHour: 17 };
  if (/\bevening\b/.test(text)) return { kind: "daypart", dayOffset, days: 1, daypart: "evening", startHour: 17, endHour: 22 };
  if (/\btomorrow\b/.test(text)) return { kind: "day", dayOffset: 1, days: 1, daypart: null, startHour: null, endHour: null };
  if (/\btoday|now\b/.test(text)) return { kind: /\bnow\b/.test(text) ? "now" : "day", dayOffset: 0, days: 1, daypart: null, startHour: null, endHour: null };
  if (/\bnext week|one week|7 days|seven days\b/.test(text)) return { kind: "multi_day", dayOffset: 0, days: 7, daypart: null, startHour: null, endHour: null };
  const days = text.match(/\bnext\s+(\d{1,2})\s+days?\b/);
  if (days) return { kind: "multi_day", dayOffset: 0, days: Math.max(1, Math.min(16, Number(days[1]))), daypart: null, startHour: null, endHour: null };
  return noneWindow();
}

function daypartWindow(daypart) {
  return { kind: "daypart", dayOffset: daypart === "tomorrow night" ? 1 : 0, days: 1, daypart: "evening", startHour: 18, endHour: 24 };
}

function noneWindow() {
  return { kind: "none", dayOffset: null, days: null, daypart: null, startHour: null, endHour: null };
}

function daypartForHour(hour) {
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "overnight";
}

function inferScope(message, context = {}) {
  const text = cleanText(message);
  if (context?.selected && referencesMap(text)) return scopeObj("selected_region");
  if (/\b(current|visible|this)\s+(map|view|area|region)|\bhere\b|\bthis area\b/.test(text)) return scopeObj("current_map");
  if (/\b(anywhere|nationwide|across the us|across the u s|across the united states|in the us|within the us|united states|usa)\b/.test(text)) {
    return scopeObj("nationwide", "nationwide");
  }
  for (const [alias, regionId] of regionAliases) {
    if (text.includes(alias) && regionCatalog[regionId]) return scopeObj("named_region", regionId);
  }
  return scopeObj("unresolved");
}

function scopeObj(kind, regionId = null, stateCode = null) {
  return { kind, regionId, stateCode };
}

function loc(label, role = "single") {
  return { raw: label, normalized: label, role };
}

function extractRoute(message) {
  const source = String(message ?? "").replace(/\s+/g, " ").trim();
  if (/\b(need|want|going|have|plan|wise|trying|good|ok|okay|safe|whether)\s+to\b/i.test(source) && !/\bfrom\b/i.test(source)) return [];
  const match =
    source.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this|next|at|around|by|leaving|leave)\b|[?.!,]|$)/i) ??
    source.match(/\b(.+?)\s+to\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this|next|at|around|by|leaving|leave)\b|[?.!,]|$)/i);
  if (!match?.[1] || !match?.[2]) return [];
  return [extractLocation(match[1]) ?? cleanLocation(match[1]), extractLocation(match[2]) ?? cleanLocation(match[2])].filter(Boolean);
}

function extractLocation(message) {
  const source = String(message ?? "").replace(/\s+/g, " ").trim();
  const direct = knownLocations.get(cleanText(source).replace(/[?.!,]+$/g, ""));
  if (direct) return direct;
  const patterns = [
    /\b(?:in|near|at|for|around)\s+([A-Za-z '-]+,\s*(?:[A-Za-z]{2}|[A-Za-z '-]+))/i,
    /\b(?:in|near|at|for|around)\s+([A-Za-z '-]{2,40})(?:\s+(?:today|tomorrow|tonight|next|this|around|at|by|for|in)\b|[?.!,]|$)/i,
    /\b(?:house|home|site|property)\s+is\s+in\s+([A-Za-z '-]{2,50})(?:[?.!,]|$)/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      const cleaned = cleanLocation(match[1]);
      const known = knownLocations.get(cleanText(cleaned));
      return known ?? cleaned;
    }
  }
  for (const [alias, label] of knownLocations) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(source)) return label;
  }
  return null;
}

function cleanLocation(value) {
  return String(value ?? "")
    .replace(/\b(today|tomorrow|tonight|next week|this week|around|at|by|for|weather|forecast|delivery|repairs?|stargazing)\b.*$/i, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
}

function inferLayer(text) {
  if (/\bfire\s*risk|firerisk|fire weather|wildfire\b/.test(text)) return "fire";
  if (/\bheat index|feels like|too hot|heat\b/.test(text)) return "heat";
  if (/\btemperature|temp\b/.test(text)) return "temp";
  if (/\bwind\b/.test(text)) return "wind";
  if (/\bhumidity|humid\b/.test(text)) return "humidity";
  if (/\bcloud|cloudy|clear sky\b/.test(text)) return "cloud";
  if (/\bcooling degree|cdd|cooling demand\b/.test(text)) return "cdd";
  if (/\brisk|score|stress\b/.test(text)) return "risk";
  return null;
}

function referencesMap(text) {
  return /\b(current|visible|this|selected)\s+(map|view|area|region|place)|\bhere\b|\bthis area\b/.test(cleanText(text));
}

function referencesVisible(text) {
  return /\bvisible|current map|map view|this area|here\b/.test(cleanText(text));
}

function isGreeting(text) {
  return /^(hi|hello|hey|yo|good morning|good afternoon|good evening)[!.?]*$/.test(text);
}

function isUnsafe(text) {
  return /\b(kill|hurt someone|make a bomb|weapon|poison)\b/.test(text);
}

function isOutOfScope(text) {
  if (/\b(weather|forecast|rain|wind|heat|cold|temperature|storm|alert|cloud|delivery|travel|outdoor|stargaz|fire risk|risk map|dashboard|clothing|ac|thermostat)\b/.test(text)) return false;
  return /\b(ai news|news today|fifa|stock|recipe|movie|coding|write code|politics|election|sports score)\b/.test(text);
}

function cleanText(message) {
  return String(message ?? "")
    .toLowerCase()
    .replace(/\bdelivary\b/g, "delivery")
    .replace(/\bbirmiingham\b/g, "birmingham")
    .replace(/\bniagra\b/g, "niagara")
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
