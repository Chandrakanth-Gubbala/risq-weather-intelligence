import { dataManifest } from "../llm/domain/dataManifest.mjs";
import { max, mean, min, sum } from "./ops.mjs";

const layerIds = ["risk", "fire", "heat", "temp", "wind", "humidity", "cloud", "cdd"];

export function executeEvidence(packet, forecastPoints, context = {}) {
  const rows = forecastPoints.map((entry, index) => {
    const raw = entry.raw ?? {};
    const alerts = resolveAlerts(entry, context);
    const dailyRows = filterDailyRows(dailyForecastRows(raw), packet.timeWindow);
    const hourlyRows = filterHourlyRows(hourlyForecastRows(raw), packet.timeWindow, dailyRows);
    const values = {};
    for (const request of evidenceRequestsForPacket(packet)) {
      const value = computeEvidenceValue(request, raw, dailyRows, hourlyRows, { ...entry, alerts });
      if (value == null) continue;
      const unit = dataManifest.variables[request.variable]?.unit ?? "";
      values[`${request.variable}.${request.op}`] = { v: roundValue(value), unit };
    }
    values["alerts_active.count"] = { v: alerts.length, unit: "alert" };
    const row = {
      place: entry.label ?? `candidate ${index + 1}`,
      role: entry.role ?? null,
      lat: entry.point?.lat ?? null,
      lon: entry.point?.lon ?? null,
      values,
      daily: dailyRows,
      hourly: hourlyRows,
      windows: scoreWindows(packet, dailyRows, hourlyRows, alerts),
      alerts,
      provider: raw?.source?.provider ?? context?.sourceBadge ?? "dashboard"
    };
    return row;
  });
  const unavailable = [
    ...new Set([
      ...(packet.externalFactors ?? []),
      ...(packet.externalFactorsOther ?? []),
      ...missingRequestedVariables(packet, rows)
    ])
  ];
  const table = {
    scopeLabel: context?.evidenceScopeLabel ?? rows[0]?.place ?? "selected area",
    timeWindowLabel: timeWindowLabel(packet.timeWindow),
    rows,
    ranking: rankRows(packet, rows),
    windows: bestWindowsAcrossRows(packet, rows),
    unavailable,
    dataQuality: {
      provider: [...new Set(rows.map((row) => row.provider).filter(Boolean))].join(" + ") || "dashboard",
      degraded: false
    },
    computedAt: new Date().toISOString()
  };
  return table;
}

export function renderDeterministicAnswer(packet, table) {
  const decision = packet?.application?.decisionType;
  const activity = activityName(packet);
  if (decision === "route_assessment") return renderRouteAnswer(packet, table);
  if (decision === "rank_places") return renderRankingAnswer(packet, table);
  if (decision === "pick_time_window") {
    if (table.rows.length > 1) return renderRankingAnswer(packet, table);
    return renderWindowAnswer(packet, table);
  }
  if (/delivery/.test(activity)) return renderDeliveryAnswer(packet, table);
  if (/cooling|thermostat|hvac|a\/c|ac/.test(activity)) return renderHomeCoolingAnswer(packet, table);
  if (/clothing|wear|outfit|packing/.test(activity)) return renderClothingAnswer(packet, table);
  return renderSingleAnswer(packet, table);
}

function renderSingleAnswer(packet, table) {
  const row = table.rows[0];
  if (!row) return null;
  const facts = plainFacts(row.values);
  const activity = packet.application?.activity || "that plan";
  const risks = weatherRisks(row, activity);
  const severe = hasSeriousAlert(row.alerts);
  const verdict = severe || risks.length >= 2 ? "marginal" : "good";
  const missing = table.unavailable.filter(Boolean);
  const answer =
    verdict === "good"
      ? `${row.place} looks workable for ${activity} ${table.timeWindowLabel}. The dashboard weather signals are fairly cooperative${facts ? `: ${facts}` : ""}.`
      : `${row.place} may still be workable for ${activity} ${table.timeWindowLabel}, but I would be cautious because ${risks.join(", ")}.`;
  return advisoryFromTable(packet, table, row, {
    answer: `${answer}${missingText(missing)}${severe ? " Follow NWS/local officials and your site safety plan for safety calls." : ""}`,
    verdict,
    confidence: "medium",
    bestWindows: table.windows.slice(0, 3),
    risks: risks.length ? risks : ["No major rain, wind, heat, or severe-alert signal in the evidence table."],
    capabilityNote: "Uses only verified dashboard weather evidence and names unconnected factors."
  });
}

function renderWindowAnswer(packet, table) {
  const row = table.rows[0];
  if (!row) return null;
  const best = row.windows[0];
  const risks = weatherRisks(row, packet.application?.activity);
  const answer = best
    ? `${row.place}'s best weather window looks like ${best.label.toLowerCase()}: ${best.rationale}.`
    : `${row.place} has limited hourly window detail, so I can only give a broad weather read ${table.timeWindowLabel}.`;
  return advisoryFromTable(packet, table, row, {
    answer: `${answer}${risks.length ? ` Watch-out: ${risks[0]}.` : ""}${missingText(table.unavailable)}`,
    verdict: best ? verdictFromScore(best.score, risks) : "insufficient_data",
    confidence: "medium",
    bestWindows: row.windows.slice(0, 3),
    risks: risks.length ? risks : ["No major rain, wind, heat, or severe-alert signal in the evidence table."],
    capabilityNote: "Window selection uses forecast temperature, rain, wind, humidity/cloud, and alert context."
  });
}

function renderRankingAnswer(packet, table) {
  const ranked = table.ranking.slice(0, 5);
  const best = ranked[0];
  if (!best) {
    return advisoryFromTable(packet, table, null, {
      answer: `I could not rank places across ${table.scopeLabel} with the current dashboard evidence.`,
      verdict: "insufficient_data",
      confidence: "low",
      bestWindows: [],
      risks: ["No comparable candidate rows were available."],
      capabilityNote: "Ranking needs comparable dashboard candidates."
    });
  }
  const activity = activityName(packet);
  const stargazing = /stargaz|sky|stars|astronomy/.test(activity);
  const layer = packet.requestedLayer;
  const topLine = ranked
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${item.place}: ${item.summary}`)
    .join(" ");
  const lead = stargazing
    ? `${best.place} looks like the best stargazing pick across ${table.scopeLabel}.`
    : layer
      ? `${best.place} has the strongest ${layerLabel(layer).toLowerCase()} signal across ${table.scopeLabel}.`
      : `${best.place} looks like the best weather option across ${table.scopeLabel}.`;
  const caveat = stargazing
    ? " I am using cloud cover first, then rain, wind, and alerts. I am not checking light pollution, moon phase, smoke or haze, local obstructions, or astronomical seeing."
    : missingText(table.unavailable);
  const risks = [
    `Top candidate across ${table.scopeLabel}: ${best.place} (${best.summary}).`,
    ...table.unavailable.slice(0, 3).map((item) => `${humanize(item)} is not connected.`)
  ];
  return advisoryFromTable(packet, table, best.row, {
    answer: `${lead} Top options: ${topLine}.${caveat}`,
    verdict: best.score >= 70 ? "good" : best.score >= 45 ? "marginal" : "avoid",
    confidence: "medium",
    bestWindows: ranked.slice(0, 3).map((item) => ({ label: item.place, score: item.score, rationale: item.summary })),
    risks,
    capabilityNote: stargazing
      ? "Weather-only sky screening; dark-sky and astronomy-specific data are not connected."
      : `This ranks only the candidate locations available for ${table.scopeLabel}.`
  });
}

function renderRouteAnswer(packet, table) {
  const origin = table.rows.find((row) => row.role === "origin") ?? table.rows[0];
  const destination = table.rows.find((row) => row.role === "destination") ?? table.rows[1];
  const corridor = table.rows.find((row) => row.role === "midpoint") ?? table.rows[2];
  if (!origin || !destination) return null;
  const points = [origin, destination, corridor].filter(Boolean);
  const risks = dedupeStrings(points.flatMap((row) => weatherRisks(row, "route travel").map((risk) => `${row.place}: ${risk}`))).slice(0, 6);
  const routeWindows = routeWindowsFromRows(points);
  const score = min(points.map((row) => row.windows[0]?.score ?? suitabilityScore(row)).filter(Number.isFinite));
  const location = `${origin.place} to ${destination.place}`;
  const corridorLine = corridor ? ` Mid-route: ${weatherLine(corridor)}.` : "";
  const best = routeWindows[0] ? ` Best weather-only start window: ${routeWindows[0].label.toLowerCase()} (${routeWindows[0].rationale}).` : "";
  const answer = `Weather-wise, ${location} looks ${score >= 70 ? "generally reasonable" : score >= 45 ? "doable but not friction-free" : "pretty risky"} ${table.timeWindowLabel}. ${origin.place}: ${weatherLine(origin)}. ${destination.place}: ${weatherLine(destination)}.${corridorLine}${best} I cannot see traffic, crashes, road closures, construction delays, parking, or transit, so check a live map or 511 before leaving.`;
  return advisoryFromTable(packet, table, destination, {
    answer,
    verdict: verdictFromScore(score, risks),
    confidence: "medium",
    bestWindows: routeWindows,
    risks: risks.length ? risks : ["No major heat, wind, rain, or severe-alert signal appears in the route endpoint weather."],
    answerType: "in_scope_partial_business",
    capabilityNote: "Partial answer: weather can be checked, but live road and traffic operations data are not connected."
  });
}

function renderDeliveryAnswer(packet, table) {
  const row = table.rows[0];
  if (!row) return null;
  const risk = deliveryRisk(row);
  const noun = /food/.test(activityName(packet)) ? "food delivery" : /package|amazon|parcel|shipment/.test(activityName(packet)) ? "package delivery" : "delivery";
  const missing = table.unavailable.length ? table.unavailable : ["traffic_conditions", "courier_assignment"];
  const answer = `For ${table.timeWindowLabel}, weather-related ${noun} disruption risk looks ${risk.level} around ${row.place}. ${risk.reason} I cannot tell whether your actual ${noun} will be delayed because I do not have ${humanList(missing.map(humanize))}.`;
  return advisoryFromTable(packet, table, row, {
    answer,
    verdict: risk.level === "high" ? "avoid" : risk.level === "moderate" ? "marginal" : "good",
    confidence: "medium",
    bestWindows: [],
    risks: risk.risks,
    answerType: "in_scope_partial_business",
    persona: "Logistics / last-mile operations",
    capabilityNote: "Weather-related risk only. Courier route, platform status, tracking, and traffic data are not connected."
  });
}

function renderClothingAnswer(packet, table) {
  const row = table.rows[0];
  if (!row) return null;
  const maxHeat = firstValue(row.values, ["apparent_temp.max", "temp_max.max", "hourly_apparent_temp.max", "hourly_temp.max"]);
  const minTemp = firstValue(row.values, ["temp_min.min", "hourly_temp.min"]);
  const rain = firstValue(row.values, ["precip_sum.sum", "hourly_precip.sum"]);
  const wind = firstValue(row.values, ["wind_speed.max", "hourly_wind.max"]);
  const pieces = [];
  if (maxHeat?.v >= 95) pieces.push("light, breathable clothes, sun protection, and water");
  else if (maxHeat?.v >= 85) pieces.push("light summer clothing");
  else if (maxHeat?.v >= 70) pieces.push("comfortable warm-weather clothing");
  else pieces.push("a warmer layer");
  if (minTemp?.v != null && minTemp.v <= 60) pieces.push("a light jacket for cooler parts of the day");
  if (rain?.v != null && rain.v >= 0.15) pieces.push("a compact umbrella or light rain jacket");
  if (wind?.v != null && wind.v >= 20) pieces.push("less-loose outer layers if it gets breezy");
  const answer = `${row.place} looks roughly ${temperatureRange(row)} ${table.timeWindowLabel}. I would wear ${humanList(pieces)}.`;
  return advisoryFromTable(packet, table, row, {
    answer: `${answer}${weatherRisks(row, "clothing").length ? ` Watch-out: ${weatherRisks(row, "clothing")[0]}.` : ""}`,
    verdict: weatherRisks(row, "clothing").length >= 2 ? "marginal" : "good",
    confidence: "medium",
    bestWindows: table.windows.slice(0, 3),
    risks: weatherRisks(row, "clothing"),
    capabilityNote: "Clothing guidance is inferred from temperature, apparent temperature, rain, wind, humidity, and alerts."
  });
}

function renderHomeCoolingAnswer(packet, table) {
  const row = table.rows[0];
  if (!row) return null;
  const heat = firstValue(row.values, ["apparent_temp.max", "temp_max.max", "hourly_apparent_temp.max", "hourly_temp.max"]);
  const humidity = firstValue(row.values, ["humidity.max", "humidity.mean"]);
  const cdd = firstValue(row.values, ["cooling_degree_days.sum", "cooling_degree_days.max"]);
  const phrase =
    heat?.v >= 100
      ? `cooling demand looks high, with outdoor heat feeling near ${Math.round(heat.v)}F`
      : heat?.v >= 92
        ? `cooling demand looks elevated, with the warmest part near ${Math.round(heat.v)}F`
        : heat?.v >= 84
          ? `cooling demand looks moderate, with the warmest part near ${Math.round(heat.v)}F`
          : `cooling demand does not look especially high${heat?.v != null ? `, with the warmest part near ${Math.round(heat.v)}F` : ""}`;
  const humidityText = humidity?.v >= 70 ? " Humidity also looks sticky, so it may feel warmer." : "";
  const cddText = cdd?.v != null ? ` Cooling-degree demand is around ${Math.round(cdd.v)} CDD in this slice.` : "";
  const answer = `For ${row.place}, ${phrase} ${table.timeWindowLabel}.${humidityText}${cddText} Weather-wise, I would avoid relaxing cooling too aggressively if people, pets, or heat-sensitive equipment are inside. I cannot prescribe an exact thermostat setting or predict your bill because insulation, HVAC performance, occupancy, and utility rates are not connected.`;
  return advisoryFromTable(packet, table, row, {
    answer,
    verdict: heat?.v >= 100 ? "marginal" : "good",
    confidence: "medium",
    bestWindows: [],
    risks: weatherRisks(row, "home cooling"),
    answerType: "in_scope_partial_business",
    capabilityNote: "Home cooling guidance is weather-only; exact setpoints, bills, HVAC performance, and indoor comfort are not inferred."
  });
}

function advisoryFromTable(packet, table, row, fields) {
  const action =
    row?.lat != null && row?.lon != null
      ? [{ type: "flyTo", lat: row.lat, lon: row.lon, zoom: table.rows.length > 1 ? 7 : 8, label: row.place }]
      : [];
  const missing = table.unavailable.filter(Boolean);
  return {
    answer: String(fields.answer ?? "").slice(0, 1600),
    verdict: fields.verdict ?? "insufficient_data",
    confidence: fields.confidence ?? "medium",
    bestWindows: fields.bestWindows ?? [],
    risks: fields.risks?.length ? fields.risks.slice(0, 6) : ["No major dashboard weather risk signal was found."],
    dataUsed: ["ContextPacket evidence table", "Forecast variables", "Dashboard alert context when available"],
    guardrailNote: "Evidence-driven answer; unavailable external factors are named rather than guessed.",
    actions: action,
    answerType: fields.answerType ?? (missing.length ? "in_scope_partial_business" : "in_scope_weather"),
    persona: fields.persona ?? "General planning",
    capabilityNote: fields.capabilityNote ?? "Uses verified dashboard evidence only.",
    missingData: missing,
    facts: {
      evidenceTable: table,
      questionActivity: activityName(packet),
      interpretation: {
        application: packet.application,
        claimFrame: packet.claimFrame,
        requestedLayer: packet.requestedLayer,
        forbiddenClaims: packet.claimFrame?.forbiddenClaims ?? []
      },
      location: row?.place ?? table.scopeLabel,
      provider: table.dataQuality.provider,
      current: row ? currentFromRow(row) : null,
      days: row?.daily ?? [],
      hourly: row?.hourly ?? [],
      alerts: row?.alerts ?? [],
      rankedCandidates: table.ranking,
      route: packet.application?.decisionType === "route_assessment" ? { points: table.rows, externalMissingEvidence: table.unavailable } : null
    }
  };
}

function computeEvidenceValue(request, raw, dailyRows, hourlyRows, meta) {
  const variable = request.variable;
  const values = valuesForVariable(variable, raw, dailyRows, hourlyRows, meta);
  if (!values.length) return null;
  if (request.op === "min") return min(values);
  if (request.op === "mean") return mean(values);
  if (request.op === "sum") return sum(values);
  if (request.op === "count") return values.length;
  if (request.op === "threshold" && request.threshold) {
    return values.some((value) => request.threshold.cmp === "gte" ? value >= request.threshold.value : value <= request.threshold.value) ? 1 : 0;
  }
  return max(values);
}

function valuesForVariable(variable, raw, dailyRows, hourlyRows, meta) {
  if (variable === "temp_max") return dailyRows.map((row) => row.tempHighF);
  if (variable === "temp_min") return dailyRows.map((row) => row.tempLowF);
  if (variable === "apparent_temp") return dailyRows.map((row) => row.apparentF);
  if (variable === "precip_sum") return dailyRows.map((row) => row.precipIn);
  if (variable === "wind_speed") return dailyRows.map((row) => row.windMph);
  if (variable === "humidity") return [numberOrNull(raw?.current?.relative_humidity_2m), ...dailyRows.map((row) => row.humidityPct)];
  if (variable === "cloud_cover") return dailyRows.map((row) => row.cloudPct);
  if (variable === "hourly_temp") return hourlyRows.map((row) => row.tempF);
  if (variable === "hourly_apparent_temp") return hourlyRows.map((row) => row.apparentF);
  if (variable === "hourly_precip") return hourlyRows.map((row) => row.precipIn);
  if (variable === "hourly_wind") return hourlyRows.map((row) => row.windMph);
  if (variable === "hourly_cloud") return hourlyRows.map((row) => row.cloudPct);
  if (variable === "cooling_degree_days") {
    return dailyRows.map((row) => (row.tempHighF == null || row.tempLowF == null ? null : Math.max(0, (row.tempHighF + row.tempLowF) / 2 - 65)));
  }
  if (variable === "alerts_active") return [meta.alerts?.length ?? 0];
  if (variable === "risk_score") return [numberOrNull(meta.layers?.risk ?? meta.score)];
  if (variable.startsWith("layer_")) return [numberOrNull(meta.layers?.[variable.replace(/^layer_/, "")])];
  return [];
}

function dailyForecastRows(raw) {
  const daily = raw?.daily ?? {};
  const current = raw?.current ?? {};
  const times = Array.isArray(daily.time) ? daily.time : [];
  return times.slice(0, 16).map((time, index) => ({
    time,
    label: labelDate(time),
    tempHighF: numberOrNull(daily.temperature_2m_max?.[index]),
    tempLowF: numberOrNull(daily.temperature_2m_min?.[index]),
    apparentF: numberOrNull(daily.apparent_temperature_max?.[index]) ?? numberOrNull(daily.temperature_2m_max?.[index]),
    precipIn: numberOrNull(daily.precipitation_sum?.[index]),
    windMph: numberOrNull(daily.wind_speed_10m_max?.[index]),
    cloudPct: numberOrNull(daily.cloud_cover_mean?.[index]),
    humidityPct: index === 0 ? numberOrNull(current.relative_humidity_2m) : null
  }));
}

function hourlyForecastRows(raw) {
  const hourly = raw?.hourly ?? {};
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  return times.slice(0, 16 * 24).map((time, index) => ({
    time,
    date: String(time).slice(0, 10),
    hour: Number(String(time).slice(11, 13)),
    tempF: numberOrNull(hourly.temperature_2m?.[index]),
    apparentF: numberOrNull(hourly.apparent_temperature?.[index]) ?? numberOrNull(hourly.temperature_2m?.[index]),
    precipIn: numberOrNull(hourly.precipitation?.[index]),
    windMph: numberOrNull(hourly.wind_speed_10m?.[index]),
    cloudPct: numberOrNull(hourly.cloud_cover?.[index])
  }));
}

function filterDailyRows(rows, timeWindow) {
  if (!rows.length) return rows;
  const kind = timeWindow?.kind ?? "none";
  if (kind === "none" || kind === "now") return rows.slice(0, Math.min(4, rows.length));
  const start = Math.max(0, Math.min(rows.length - 1, Number(timeWindow.dayOffset ?? 0)));
  const count = kind === "multi_day" ? Math.max(1, Math.min(16, Number(timeWindow.days ?? 4))) : 1;
  return rows.slice(start, start + count);
}

function filterHourlyRows(rows, timeWindow, dailyRows) {
  if (!rows.length) return rows;
  const kind = timeWindow?.kind ?? "none";
  if (kind === "none" || kind === "multi_day") {
    const dates = new Set(dailyRows.map((row) => row.time));
    return rows.filter((row) => dates.has(row.date)).slice(0, 16 * 24);
  }
  const date = dailyRows[0]?.time;
  if (!date) return rows.slice(0, 24);
  const start = Number(timeWindow.startHour ?? (kind === "daypart" ? daypartHours(timeWindow.daypart).start : 0));
  const end = Number(timeWindow.endHour ?? (kind === "daypart" ? daypartHours(timeWindow.daypart).end : 24));
  if (kind === "clock_range" || kind === "daypart") {
    return rows.filter((row) => row.date === date && row.hour >= start && row.hour < end);
  }
  return rows.filter((row) => row.date === date);
}

function resolveAlerts(entry, context) {
  if (Array.isArray(entry.alerts)) return entry.alerts.slice(0, 5);
  return Array.isArray(context?.alerts) ? context.alerts.slice(0, 5) : [];
}

function scoreWindows(packet, dailyRows, hourlyRows, alerts) {
  if (hourlyRows.length >= 3 && ["clock_range", "daypart"].includes(packet.timeWindow?.kind)) {
    return [scoreHourlyWindow(packet, packet.timeWindow?.daypart ?? "requested window", hourlyRows, alerts)];
  }
  return dailyRows
    .map((day) => ({
      label: day.label,
      score: daySuitabilityScore(packet, day, alerts),
      rationale: windowRationale(packet, day, alerts)
    }))
    .sort((a, b) => b.score - a.score);
}

function scoreHourlyWindow(packet, label, rows, alerts) {
  const precip = sum(rows.map((row) => row.precipIn).filter((value) => value != null));
  const wind = max(rows.map((row) => row.windMph).filter((value) => value != null));
  const heat = max(rows.map((row) => row.apparentF ?? row.tempF).filter((value) => value != null));
  const cloud = mean(rows.map((row) => row.cloudPct).filter((value) => value != null));
  const day = { label, precipIn: precip, windMph: wind, apparentF: heat, tempHighF: heat, cloudPct: cloud };
  return { label, score: daySuitabilityScore(packet, day, alerts), rationale: windowRationale(packet, day, alerts) };
}

function rankRows(packet, rows) {
  return rows
    .map((row) => {
      const score = rankingScore(packet, row);
      return { ...rankingSummary(packet, row), row, score };
    })
    .sort((a, b) => b.score - a.score);
}

function rankingScore(packet, row) {
  const activity = activityName(packet);
  const layer = packet.requestedLayer;
  if (layer) return numberOrNull(row.values[`layer_${layer}.rank_locations`]?.v ?? row.values[`layer_${layer}.max`]?.v ?? row.values[`layer_${layer}.mean`]?.v) ?? suitabilityScore(row);
  if (/stargaz|sky|stars/.test(activity)) {
    const cloud = firstValue(row.values, ["cloud_cover.rank_locations", "cloud_cover.mean", "cloud_cover.max"])?.v;
    const rain = firstValue(row.values, ["precip_sum.sum", "hourly_precip.sum"])?.v;
    const wind = firstValue(row.values, ["wind_speed.max", "hourly_wind.max"])?.v;
    return Math.max(0, Math.min(100, 100 - (cloud ?? 55) - (rain ?? 0) * 90 - Math.max(0, (wind ?? 0) - 12) * 1.2 - row.alerts.length * 18));
  }
  if (packet.requestedLayer === "fire") return firstValue(row.values, ["layer_fire.rank_locations", "layer_fire.max"])?.v ?? suitabilityScore(row);
  if (/highest|risk|fire/.test(`${packet.application?.activity ?? ""} ${packet.requestedLayer ?? ""}`)) {
    return firstValue(row.values, ["risk_score.rank_locations", "risk_score.max", "layer_risk.rank_locations", "layer_risk.max", "layer_fire.rank_locations", "layer_fire.max"])?.v ?? suitabilityScore(row);
  }
  return row.windows[0]?.score ?? suitabilityScore(row);
}

function rankingSummary(packet, row) {
  const activity = activityName(packet);
  const layer = packet.requestedLayer;
  if (layer) {
    const value = firstValue(row.values, [`layer_${layer}.rank_locations`, `layer_${layer}.max`, `layer_${layer}.mean`]);
    return { place: row.place, summary: `${formatValue(value, layerUnit(layer))}`, lat: row.lat, lon: row.lon };
  }
  if (/stargaz|sky|stars/.test(activity)) {
    const cloud = firstValue(row.values, ["cloud_cover.rank_locations", "cloud_cover.mean", "cloud_cover.max"]);
    const rain = firstValue(row.values, ["precip_sum.sum", "hourly_precip.sum"]);
    const wind = firstValue(row.values, ["wind_speed.max", "hourly_wind.max"]);
    return { place: row.place, summary: `${formatValue(cloud, "%")} cloud cover, ${formatValue(rain, "in")} rain, ${formatValue(wind, "mph")} wind`, lat: row.lat, lon: row.lon };
  }
  const best = row.windows[0];
  return { place: row.place, summary: best ? `${best.label}: ${best.rationale}` : plainFacts(row.values) || "limited data", lat: row.lat, lon: row.lon };
}

function bestWindowsAcrossRows(packet, rows) {
  return rows
    .flatMap((row) => row.windows.slice(0, 2).map((window) => ({ ...window, label: rows.length > 1 ? `${row.place}: ${window.label}` : window.label })))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function daySuitabilityScore(packet, day, alerts) {
  let score = 100;
  const heat = day.apparentF ?? day.tempHighF;
  const activity = activityName(packet);
  if (/stargaz|sky|stars/.test(activity)) {
    const cloud = numberOrNull(day.cloudPct);
    if (cloud == null) score -= 18;
    else if (cloud >= 85) score -= 62;
    else if (cloud >= 65) score -= 42;
    else if (cloud >= 45) score -= 24;
    else if (cloud >= 25) score -= 10;
  }
  if (heat != null && heat >= 103) score -= 45;
  else if (heat != null && heat >= 95) score -= 28;
  else if (heat != null && heat >= 88) score -= 12;
  if (day.precipIn != null && day.precipIn >= 0.5) score -= 35;
  else if (day.precipIn != null && day.precipIn >= 0.15) score -= 18;
  if (day.windMph != null && day.windMph >= 35) score -= 32;
  else if (day.windMph != null && day.windMph >= 25) score -= 16;
  if (alerts.length) score -= hasSeriousAlert(alerts) ? 38 : 18;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function suitabilityScore(row) {
  return row.windows[0]?.score ?? daySuitabilityScore({ application: { activity: "" } }, row.daily[0] ?? {}, row.alerts);
}

function windowRationale(packet, day, alerts) {
  const pieces = [];
  const heat = day.apparentF ?? day.tempHighF;
  if (heat != null) pieces.push(describeHeat(heat));
  if (day.precipIn != null) pieces.push(describeRain(day.precipIn));
  if (day.windMph != null) pieces.push(describeWind(day.windMph));
  if (/stargaz|sky|stars/.test(activityName(packet)) && day.cloudPct != null) pieces.push(describeCloud(day.cloudPct));
  if (alerts.length) pieces.push("active alert context needs respect");
  return pieces.join(", ") || "limited forecast detail";
}

function weatherRisks(row, activity = "") {
  const risks = [];
  const heat = firstValue(row.values, ["apparent_temp.max", "hourly_apparent_temp.max", "temp_max.max", "hourly_temp.max"]);
  const rain = firstValue(row.values, ["precip_sum.sum", "hourly_precip.sum"]);
  const wind = firstValue(row.values, ["wind_speed.max", "hourly_wind.max"]);
  const cloud = firstValue(row.values, ["cloud_cover.mean", "hourly_cloud.mean", "cloud_cover.max"]);
  if (rain?.v >= 0.25) risks.push(`rain around ${formatValue(rain, "in")} could interfere`);
  if (wind?.v >= 25) risks.push(`wind near ${formatValue(wind, "mph")} may be a factor`);
  if (heat?.v >= 95) risks.push(`heat could feel high, near ${formatValue(heat, "F")}`);
  if (cloud?.v >= 55 && /stargaz|sky|stars/.test(activity)) risks.push(`cloud cover around ${formatValue(cloud, "%")} matters for sky viewing`);
  if (hasSeriousAlert(row.alerts)) risks.push("active severe alert context is present");
  return risks;
}

function deliveryRisk(row) {
  let score = 0;
  const reasons = [];
  const alerts = row.alerts ?? [];
  if (alerts.length) {
    score += hasSeriousAlert(alerts) ? 55 : 25;
    reasons.push(`there ${alerts.length === 1 ? "is" : "are"} active alert${alerts.length === 1 ? "" : "s"} in the area`);
  }
  const rain = firstValue(row.values, ["hourly_precip.sum", "precip_sum.sum"]);
  if (rain?.v >= 0.5) {
    score += 30;
    reasons.push(`rain looks meaningful, around ${formatValue(rain, "in")}`);
  } else if (rain?.v >= 0.15) {
    score += 15;
    reasons.push("some rain shows up");
  }
  const wind = firstValue(row.values, ["hourly_wind.max", "wind_speed.max"]);
  if (wind?.v >= 35) {
    score += 30;
    reasons.push(`winds may be strong, near ${formatValue(wind, "mph")}`);
  } else if (wind?.v >= 25) {
    score += 15;
    reasons.push(`winds look breezy, near ${formatValue(wind, "mph")}`);
  }
  const heat = firstValue(row.values, ["hourly_apparent_temp.max", "apparent_temp.max", "temp_max.max"]);
  if (heat?.v >= 103) {
    score += 15;
    reasons.push(`heat could stress outdoor delivery work, feeling near ${formatValue(heat, "F")}`);
  } else if (heat?.v >= 95) {
    score += 8;
    reasons.push(`it may feel hot, near ${formatValue(heat, "F")}`);
  }
  const level = score >= 55 ? "high" : score >= 20 ? "moderate" : "low";
  return {
    level,
    reason: reasons.length ? `The main weather signal is that ${humanList(reasons)}.` : "I do not see a major weather alert, rain, wind, or heat signal in that rough window.",
    risks: reasons.length ? reasons : ["No major weather-related delivery disruption signal in that rough window."]
  };
}

function routeWindowsFromRows(rows) {
  const labels = [...new Set(rows.flatMap((row) => row.windows.map((window) => window.label)))];
  return labels
    .map((label) => {
      const windows = rows.map((row) => row.windows.find((window) => window.label === label)).filter(Boolean);
      if (!windows.length) return null;
      const score = min(windows.map((window) => window.score));
      return { label, score, rationale: windows.sort((a, b) => a.score - b.score)[0]?.rationale ?? "lowest route weather friction" };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function weatherLine(row) {
  const heat = firstValue(row.values, ["apparent_temp.max", "temp_max.max", "hourly_apparent_temp.max", "hourly_temp.max"]);
  const rain = firstValue(row.values, ["precip_sum.sum", "hourly_precip.sum"]);
  const wind = firstValue(row.values, ["wind_speed.max", "hourly_wind.max"]);
  return [heat ? formatValue(heat, "F") : null, rain ? `${formatValue(rain, "in")} rain` : null, wind ? `${formatValue(wind, "mph")} wind` : null]
    .filter(Boolean)
    .join(", ") || "forecast details are limited";
}

function currentFromRow(row) {
  return {
    tempF: firstValue(row.values, ["hourly_temp.max", "temp_max.max"])?.v ?? null,
    apparentF: firstValue(row.values, ["hourly_apparent_temp.max", "apparent_temp.max"])?.v ?? null,
    humidityPct: firstValue(row.values, ["humidity.max", "humidity.mean"])?.v ?? null,
    windMph: firstValue(row.values, ["hourly_wind.max", "wind_speed.max"])?.v ?? null,
    precipIn: firstValue(row.values, ["hourly_precip.sum", "precip_sum.sum"])?.v ?? null,
    cloudCoverPct: firstValue(row.values, ["hourly_cloud.mean", "cloud_cover.mean", "cloud_cover.max"])?.v ?? null
  };
}

function missingRequestedVariables(packet, rows) {
  const missing = [];
  for (const request of evidenceRequestsForPacket(packet)) {
    const keyPrefix = `${request.variable}.`;
    if (!rows.some((row) => Object.keys(row.values).some((key) => key.startsWith(keyPrefix)))) missing.push(request.variable);
  }
  return missing;
}

function timeWindowLabel(timeWindow) {
  if (!timeWindow || timeWindow.kind === "none") return "over the next few days";
  if (timeWindow.kind === "now") return "right now";
  if (timeWindow.kind === "day") return timeWindow.dayOffset === 1 ? "tomorrow" : "today";
  if (timeWindow.kind === "daypart") return `${timeWindow.dayOffset === 1 ? "tomorrow " : timeWindow.dayOffset === 0 ? "today " : ""}${timeWindow.daypart ?? "daypart"}`.trim();
  if (timeWindow.kind === "clock_range") return `${timeWindow.dayOffset === 1 ? "tomorrow " : "today "}around ${formatHour(Math.round(((timeWindow.startHour ?? 0) + (timeWindow.endHour ?? 0)) / 2))}`.trim();
  if (timeWindow.kind === "multi_day") return `over the next ${timeWindow.days ?? 4} days`;
  return "for the requested period";
}

function plainFacts(values) {
  return Object.entries(values)
    .slice(0, 4)
    .map(([key, value]) => `${humanize(key.split(".")[0])} ${formatValue(value)}`)
    .join(", ");
}

function firstValue(values, keys) {
  for (const key of keys) {
    if (values[key]) return values[key];
  }
  return null;
}

function formatValue(value, fallbackUnit = "") {
  if (!value || value.v == null) return "limited";
  const unit = value.unit || fallbackUnit;
  const rounded = unit === "in" ? Math.round(Number(value.v) * 100) / 100 : Math.round(Number(value.v));
  if (unit === "0-100") return `${rounded}/100`;
  return `${rounded}${unit ? ` ${unit}` : ""}`;
}

function layerUnit(layer) {
  if (["risk", "fire"].includes(layer)) return "0-100";
  if (["heat", "temp"].includes(layer)) return "F";
  if (layer === "wind") return "mph";
  if (["humidity", "cloud"].includes(layer)) return "%";
  if (layer === "cdd") return "CDD";
  return "";
}

function layerLabel(layer) {
  return (
    {
      risk: "Forecast stress",
      fire: "Fire weather",
      heat: "Heat index",
      temp: "Temperature",
      wind: "Wind",
      humidity: "Humidity",
      cloud: "Cloud cover",
      cdd: "Cooling degree days"
    }[layer] ?? "Dashboard"
  );
}

function temperatureRange(row) {
  const hi = firstValue(row.values, ["apparent_temp.max", "temp_max.max", "hourly_apparent_temp.max", "hourly_temp.max"]);
  const lo = firstValue(row.values, ["temp_min.min", "hourly_temp.min"]);
  if (hi?.v != null && lo?.v != null) return `${Math.round(lo.v)}F to ${Math.round(hi.v)}F`;
  if (hi?.v != null) return `near ${Math.round(hi.v)}F at the warmest point`;
  return "somewhat limited on temperature detail";
}

function describeHeat(value) {
  const rounded = Math.round(value);
  if (rounded >= 103) return `it may feel dangerously hot, around ${rounded}F`;
  if (rounded >= 95) return `it will likely feel hot, around ${rounded}F`;
  if (rounded >= 88) return `it looks warm, around ${rounded}F`;
  if (rounded <= 45) return `it may feel chilly, around ${rounded}F`;
  return `temperatures look comfortable, around ${rounded}F`;
}

function describeRain(inches) {
  if (inches >= 0.5) return "rain could be a real spoiler";
  if (inches >= 0.15) return "some rain is possible";
  if (inches > 0) return "only a little rain shows up";
  return "rain does not show up much";
}

function describeWind(mph) {
  const rounded = Math.round(mph);
  if (rounded >= 35) return `winds could be strong, near ${rounded} mph`;
  if (rounded >= 25) return `winds may be breezy, near ${rounded} mph`;
  if (rounded >= 15) return "there may be a light breeze";
  return "winds look pretty gentle";
}

function describeCloud(percent) {
  const rounded = Math.round(percent);
  if (rounded >= 85) return `the sky looks mostly cloudy, around ${rounded}% cloud cover`;
  if (rounded >= 65) return `clouds may get in the way, around ${rounded}% cloud cover`;
  if (rounded >= 45) return `cloud cover is mixed, around ${rounded}%`;
  if (rounded >= 25) return `there are some clouds, around ${rounded}%`;
  return `cloud cover looks fairly low, around ${rounded}%`;
}

function hasSeriousAlert(alerts) {
  return (alerts ?? []).some((alert) => /warning|tornado|severe|extreme|flash flood|evac/i.test(String(alert?.event ?? alert?.severity ?? "")));
}

function verdictFromScore(score, risks = []) {
  if (score == null) return "insufficient_data";
  if (risks.some((risk) => /alert|lightning|severe|extreme/i.test(risk)) && score < 65) return "avoid";
  if (score >= 78) return "good";
  if (score >= 55) return "marginal";
  return "avoid";
}

function daypartHours(daypart) {
  if (/morning/i.test(daypart ?? "")) return { start: 6, end: 12 };
  if (/afternoon/i.test(daypart ?? "")) return { start: 12, end: 17 };
  if (/evening/i.test(daypart ?? "")) return { start: 17, end: 22 };
  if (/overnight|night/i.test(daypart ?? "")) return { start: 22, end: 24 };
  return { start: 0, end: 24 };
}

function activityName(packet) {
  return String(packet?.application?.activity ?? "weather question").toLowerCase();
}

function missingText(missing) {
  const values = missing.filter(Boolean).map(humanize);
  return values.length ? ` I am not checking ${humanList(values)}.` : "";
}

function humanList(values) {
  const xs = values.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function labelDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function roundValue(value) {
  return Math.round(Number(value) * 100) / 100;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function humanize(value) {
  const text = String(value ?? "").replace(/_/g, " ");
  if (layerIds.includes(text.replace(/^layer /, ""))) return layerLabel(text.replace(/^layer /, ""));
  return text;
}

function formatHour(hour) {
  const h = Math.max(0, Math.min(23, Number(hour) || 12));
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12} ${suffix}`;
}

function evidenceRequestsForPacket(packet) {
  const seen = new Set();
  const requests = [];
  for (const request of [...defaultEvidenceRequests(packet), ...(packet.evidenceRequests ?? [])]) {
    const key = `${request.variable}.${request.op}.${request.appliesTo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(request);
  }
  return requests;
}

function defaultEvidenceRequests(packet) {
  const activity = activityName(packet);
  const appliesTo = packet?.application?.decisionType === "route_assessment" ? "route_points" : packet?.application?.decisionType === "rank_places" ? "each_candidate" : "each_location";
  const variables = /delivery/.test(activity)
    ? ["hourly_precip", "hourly_wind", "hourly_apparent_temp", "hourly_temp", "alerts_active"]
    : /stargaz|sky|stars/.test(activity)
      ? ["cloud_cover", "hourly_cloud", "precip_sum", "wind_speed", "alerts_active"]
      : /cooling|thermostat|hvac|a\/c|ac/.test(activity)
        ? ["apparent_temp", "temp_max", "temp_min", "humidity", "cloud_cover", "cooling_degree_days", "alerts_active"]
        : ["temp_max", "temp_min", "apparent_temp", "precip_sum", "wind_speed", "humidity", "cloud_cover", "alerts_active"];
  if (packet.requestedLayer) variables.unshift(`layer_${packet.requestedLayer}`);
  return [...new Set(variables)].map((variable) => ({
    variable,
    op: defaultOp(variable, packet),
    over: variable.startsWith("hourly_") ? "hourly" : "window",
    threshold: null,
    appliesTo
  }));
}

function defaultOp(variable, packet) {
  if (variable === "temp_min") return "min";
  if (variable === "precip_sum" || variable === "hourly_precip" || variable === "cooling_degree_days") return "sum";
  if (variable === "cloud_cover" || variable === "hourly_cloud" || variable === "humidity") return /stargaz|sky|stars/.test(activityName(packet)) ? "mean" : "max";
  if (variable.startsWith("layer_") && packet?.application?.decisionType === "rank_places") return "rank_locations";
  return "max";
}
