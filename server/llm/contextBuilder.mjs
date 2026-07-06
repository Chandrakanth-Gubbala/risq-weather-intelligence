import { compactCapabilityForPrompt } from "./capabilities.mjs";
import { voiceProfile } from "./domain/personaPacks.mjs";

export function buildAssistantEvidence({ message, interpretation, advisory, capability }) {
  const applicationReasoning = capability?.applicationReasoning ?? null;
  const comfortSummary = buildComfortSummary(advisory?.facts?.days ?? [], advisory?.facts?.current ?? null);
  const skySummary = buildSkySummary(advisory?.facts?.days ?? [], advisory?.facts?.skyCandidates ?? []);
  const claimCards = buildClaimCards({ advisory, capability, applicationReasoning, comfortSummary, skySummary });
  return {
    voiceProfile,
    capability: compactCapabilityForPrompt(capability),
    applicationReasoning,
    persona: capability.persona,
    userGoal: interpretation?.userFriendlyGoal ?? interpretation?.normalizedQuestion ?? message,
    verifiedFacts: {
      location: advisory?.facts?.location ?? null,
      current: advisory?.facts?.current ?? null,
      days: advisory?.facts?.days ?? [],
      comfortSummary,
      skySummary,
      alerts: advisory?.facts?.alerts ?? [],
      skyCandidates: advisory?.facts?.skyCandidates ?? [],
      route: advisory?.facts?.route ?? null,
      activeLayer: advisory?.facts?.activeLayer ?? null,
      timeIdx: advisory?.facts?.timeIdx ?? null
    },
    planningOutput: {
      verdict: advisory?.verdict,
      bestWindows: advisory?.bestWindows ?? [],
      risks: advisory?.risks ?? [],
      confidence: advisory?.confidence
    },
    explicitBoundaries: capability.missingData,
    claimCards,
    mapAction: advisory?.actions?.[0] ?? null
  };
}

function buildClaimCards({ advisory, capability, applicationReasoning, comfortSummary, skySummary }) {
  const cards = [];
  const location = advisory?.facts?.location ?? "the requested area";
  const allowedClaim = applicationReasoning?.allowedClaim ?? "weather-related context";
  const missing = [...new Set([...(capability?.missingData ?? []), ...(applicationReasoning?.externalMissingEvidence ?? [])])];
  const risks = advisory?.risks ?? [];
  cards.push({
    claimClass: allowedClaim,
    assertion: advisory?.answer ?? `Weather context is available for ${location}.`,
    support: [
      advisory?.facts?.provider ? `provider: ${advisory.facts.provider}` : null,
      risks[0] ? `primary weather note: ${risks[0]}` : null,
      advisory?.facts?.days?.[0] ? `first forecast day: ${JSON.stringify(advisory.facts.days[0])}` : null
    ].filter(Boolean),
    requiredCaveat: missing.length ? `Missing external data: ${missing.join(", ")}.` : null
  });
  if (advisory?.facts?.route) {
    cards.push({
      claimClass: "weather_related_travel_practicality",
      assertion: `Weather-wise route context is available for ${advisory.facts.location}.`,
      support: [
        routeSupportLine("origin", advisory.facts.route.origin),
        routeSupportLine("destination", advisory.facts.route.destination),
        routeSupportLine("corridor", advisory.facts.route.corridor)
      ].filter(Boolean),
      requiredCaveat:
        "Traffic, crashes, road closures, construction delays, parking, transit, and border wait times are not connected."
    });
  }
  if (comfortSummary?.clothingSignals?.length) {
    cards.push({
      claimClass: "comfort_or_clothing_guidance",
      assertion: "Comfort or clothing guidance can be inferred from the forecast signals.",
      support: comfortSummary.clothingSignals,
      requiredCaveat: null
    });
  }
  if (skySummary?.signals?.length) {
    cards.push({
      claimClass: "sky_visibility_screening",
      assertion: "Stargazing weather screening can be inferred from cloud cover, rain, wind, and alert signals.",
      support: skySummary.signals,
      requiredCaveat: "Light pollution, moon phase, smoke or haze, local horizon obstruction, and astronomical seeing are not connected."
    });
  }
  return cards;
}

function routeSupportLine(label, point) {
  if (!point) return null;
  const day = point.firstDay ?? point.days?.[0] ?? {};
  return `${label}: ${point.label}; high ${roundOrDash(day.heatIndexF ?? day.tempHighF)}F; rain ${roundOrDash(day.precipIn)} in; wind ${roundOrDash(day.windMaxMph)} mph`;
}

function roundOrDash(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : "--";
}

function buildComfortSummary(days, current) {
  const validDays = Array.isArray(days) ? days : [];
  const highs = validDays.map((day) => numberOrNull(day?.heatIndexF ?? day?.tempHighF)).filter((value) => value != null);
  const lows = validDays.map((day) => numberOrNull(day?.tempLowF)).filter((value) => value != null);
  const rain = validDays.map((day) => numberOrNull(day?.precipIn)).filter((value) => value != null);
  const wind = validDays.map((day) => numberOrNull(day?.windMaxMph)).filter((value) => value != null);
  const maxHeat = highs.length ? Math.max(...highs) : null;
  const minLow = lows.length ? Math.min(...lows) : null;
  const maxRain = rain.length ? Math.max(...rain) : null;
  const maxWind = wind.length ? Math.max(...wind) : null;
  const humid = numberOrNull(current?.humidityPct);
  const guidance = [];
  if (maxHeat != null) {
    if (maxHeat >= 95) guidance.push("Prioritize breathable light clothing, sun protection, and hydration.");
    else if (maxHeat >= 85) guidance.push("Light summer clothing should fit most daytime periods.");
    else if (maxHeat >= 70) guidance.push("Comfortable everyday clothing should work for daytime.");
    else guidance.push("Plan for cooler daytime temperatures and a warmer layer.");
  }
  if (minLow != null && minLow <= 60) guidance.push("A light layer may help in the morning or evening.");
  if (maxRain != null && maxRain >= 0.15) guidance.push("Carry rain protection such as a compact umbrella or light rain jacket.");
  if (maxWind != null && maxWind >= 20) guidance.push("Avoid loose hats or very light outer layers during breezier periods.");
  if (humid != null && humid >= 70 && maxHeat != null && maxHeat >= 80) guidance.push("Humidity may make it feel stickier than the temperature alone suggests.");
  return {
    maxFeelsLikeF: maxHeat,
    minLowF: minLow,
    maxDailyRainIn: maxRain,
    maxWindMph: maxWind,
    humidityPctNow: humid,
    clothingSignals: guidance
  };
}

function buildSkySummary(days, candidates = []) {
  const validDays = Array.isArray(days) ? days : [];
  const candidateRows = Array.isArray(candidates) ? candidates : [];
  const clouds = validDays.map((day) => numberOrNull(day?.cloudCoverPct)).filter((value) => value != null);
  const rain = validDays.map((day) => numberOrNull(day?.precipIn)).filter((value) => value != null);
  const wind = validDays.map((day) => numberOrNull(day?.windMaxMph)).filter((value) => value != null);
  const minCloud = clouds.length ? Math.min(...clouds) : null;
  const maxCloud = clouds.length ? Math.max(...clouds) : null;
  const maxRain = rain.length ? Math.max(...rain) : null;
  const maxWind = wind.length ? Math.max(...wind) : null;
  const signals = [];
  if (minCloud != null) signals.push(`Lowest forecast cloud cover in scope is about ${Math.round(minCloud)}%.`);
  if (maxCloud != null && maxCloud >= 65) signals.push(`Cloud cover may be high at times, reaching about ${Math.round(maxCloud)}%.`);
  if (maxRain != null && maxRain > 0) signals.push(`Rain signal reaches about ${maxRain.toFixed(2)} inches.`);
  if (maxWind != null) signals.push(`Wind signal reaches about ${Math.round(maxWind)} mph.`);
  if (candidateRows.length) {
    const best = candidateRows[0];
    const cloud = numberOrNull(best?.firstDay?.cloudCoverPct);
    signals.push(`Best visible-map candidate is ${best?.label ?? "the top ranked point"}${cloud == null ? "" : ` with about ${Math.round(cloud)}% cloud cover`}.`);
  }
  return {
    minCloudPct: minCloud,
    maxCloudPct: maxCloud,
    maxDailyRainIn: maxRain,
    maxWindMph: maxWind,
    candidates: candidateRows.slice(0, 5).map((candidate) => ({
      label: candidate?.label,
      score: candidate?.score,
      firstDay: candidate?.firstDay
    })),
    signals
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mergeCapabilityIntoResponse(response, capability) {
  const note =
    capability.answerability === "answerable_partially"
      ? `Partial answer: ${capability.missingData.join(" ")}`
      : capability.scopeClass === "in_scope_business_relevance"
        ? `Using a ${capability.persona.label.toLowerCase()} lens; facts still come only from weather/dashboard data.`
        : capability.reason;
  return {
    ...response,
    answerType: capability.scopeClass,
    persona: capability.persona.label,
    capabilityNote: note,
    missingData: capability.missingData,
    dataUsed: [...new Set([...(response.dataUsed ?? []), capability.persona.label])]
  };
}
