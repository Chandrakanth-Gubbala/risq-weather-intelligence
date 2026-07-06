import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { capabilityResponse, evaluateAssistantCapability } from "./llm/capabilities.mjs";
import { buildAssistantEvidence, mergeCapabilityIntoResponse } from "./llm/contextBuilder.mjs";
import { dataManifest, manifestOperationIds, manifestRetrievalModes, manifestVariableIds } from "./llm/domain/dataManifest.mjs";
import { ontologyContractForKind, ontologyVersion } from "./llm/domain/applicationOntology.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = Number(process.env.PORT || 5173);
const prod = process.argv.includes("--prod");
const host = process.env.HOST || (prod ? "0.0.0.0" : "127.0.0.1");
const cache = new Map();
const assistantName = "SkyScout";
const assistantPersona =
  "warm, practical, curious, lightly witty when stakes are low, and serious when safety or severe weather is involved";

const openMeteoForecastUrl = "https://api.open-meteo.com/v1/forecast";
const openMeteoGeocodeUrl = "https://geocoding-api.open-meteo.com/v1/search";
const openAiResponsesUrl = "https://api.openai.com/v1/responses";
const nominatimUrl = "https://nominatim.openstreetmap.org/search";
const censusGeocodeUrl = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const nwsBaseUrl = "https://api.weather.gov";
const metNoUrl = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const alertsUrl = "https://api.weather.gov/alerts/active";
const archiveUrl = "https://archive-api.open-meteo.com/v1/archive";
const nwsHeaders = {
  Accept: "application/geo+json",
  "User-Agent": "RisQ weather risk prototype; local cached proxy"
};
const metNoHeaders = {
  Accept: "application/json",
  "User-Agent": "RisQWeatherRisk/0.1 local prototype contact: local-dev@example.invalid"
};
const geocodeHeaders = {
  Accept: "application/json",
  "User-Agent": "RisQWeatherRisk/0.1 local prototype contact: local-dev@example.invalid"
};

const vite = prod
  ? null
  : await createViteServer({
      root,
      appType: "spa",
      server: { middlewareMode: true }
    });

const server = createHttpServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    if (vite) {
      vite.middlewares(req, res, () => {
        sendJson(res, 404, { ok: false, error: "Not found" });
      });
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : "Server error" });
  }
});

server.listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  console.log(`RisQ running at http://${displayHost}:${port}/`);
});

async function handleApi(req, res) {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true, cacheEntries: cache.size });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/alerts") {
      const data = await cached(`alerts:${hourKey()}`, 55 * 60_000, async () => {
        const raw = await fetchProviderJson(alertsUrl, {
          Accept: "application/geo+json",
          "User-Agent": "RisQ weather risk prototype; local cached proxy"
        });
        const features = Array.isArray(raw.features) ? raw.features : [];
        return features
          .map((feature, i) => {
            const props = feature?.properties ?? {};
            if (props.status !== "Actual") return null;
            if (props.severity !== "Extreme" && props.severity !== "Severe") return null;
            if (!feature?.geometry) return null;
            return {
              id: String(feature.id ?? props.id ?? `alert-${i}`),
              event: String(props.event ?? "Severe weather alert"),
              severity: props.severity,
              status: String(props.status),
              areaDesc: String(props.areaDesc ?? ""),
              geometry: feature.geometry,
              effective: typeof props.effective === "string" ? props.effective : undefined,
              expires: typeof props.expires === "string" ? props.expires : undefined
            };
          })
          .filter(Boolean)
          .slice(0, 500);
      });
      sendJson(res, 200, { ok: true, data });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/forecast") {
      const { points } = await readJson(req);
      const valid = validatePoints(points);
      const data = await cached(`forecast:${hourKey()}:${hashPoints(valid)}`, 55 * 60_000, () => fetchForecast(valid));
      sendJson(res, 200, { ok: true, data });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      const data = await handleAssistantChat(body);
      sendJson(res, 200, { ok: true, data });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/trends") {
      const { region } = await readJson(req);
      const valid = validateRegion(region);
      const data = await cached(`trends:${valid.id}`, 24 * 60 * 60_000, () => fetchTrends(valid));
      sendJson(res, 200, { ok: true, data });
      return;
    }
    sendJson(res, 404, { ok: false, error: "Unknown API route" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider request failed";
    const badRequest = message.startsWith("Invalid") || message.includes("JSON");
    sendJson(res, badRequest ? 400 : 502, { ok: false, error: message });
  }
}

async function fetchForecast(points) {
  try {
    return await fetchOpenMeteoForecast(points);
  } catch {
    return mapLimit(points, 8, async (point) => fetchForecastFallbackPoint(point));
  }
}

async function handleAssistantChat(body) {
  const message = String(body?.message ?? "").trim().slice(0, 1200);
  if (!message) throw new Error("Invalid chat message");
  const context = body?.context && typeof body.context === "object" ? body.context : {};
  const pending = sanitizeConversationState(context?.conversationState);
  if (isGreetingMessage(message)) return conversationalResponse(greetingApplicationPlan());
  const alertExplanation = alertExplanationResponse(message, context);
  if (alertExplanation) return alertExplanation;
  if (pending?.pendingSlot === "delivery_time_window" && extractDeliveryWindow(message)) {
    return handleDeliveryTimeFollowup(message, context, pending);
  }

  const semantic = await normalizeAssistantQuery(message, context, pending);
  const hasPendingPlannerFollowup = Boolean(pending?.plannerPlan?.pendingFacts?.length);
  const planningMessage = normalizedMessageForPlanning(message, semantic);
  if (!hasPendingPlannerFollowup && isSemanticOutOfScope(semantic, planningMessage, context)) return semanticOutOfScopeResponse(semantic);
  const plannerPlan = await planWeatherDashboardRequest(planningMessage, context, pending, semantic);
  if (plannerPlan.domain === "not_weather_related") return plannerOutOfScopeResponse(plannerPlan);
  if (plannerPlan.pendingFacts.length) return plannerFollowupResponse(message, plannerPlan, context);

  const application = applicationFromPlannerPlan(plannerPlan);
  const enrichedInterpretation = interpretationFromPlannerPlan(message, plannerPlan, semantic);
  const capability = evaluateAssistantCapability({ message, interpretation: enrichedInterpretation, context, applicationReasoning: application });
  if (["out_of_domain", "unsupported_by_data", "unsafe"].includes(capability.answerability)) return capabilityResponse(capability);

  const selected = context?.selected && typeof context.selected === "object" ? context.selected : null;
  const center = context?.map?.center && typeof context.map.center === "object" ? context.map.center : null;
  const explicitLocation = plannerPrimaryLocation(plannerPlan);
  const layerExplain = dashboardLayerExplanationResponse(message, context, plannerPlan, semantic, selected, center);
  if (layerExplain) return layerExplain;
  if (plannerPlan.retrievalMode === "route" || isRouteApplication(application)) {
    return handleRouteTravelQuestion(message, context, application, enrichedInterpretation, capability, selected, center, plannerPlan);
  }
  if (plannerPlan.retrievalMode === "rank_visible_points" && isSkyApplication(application)) {
    return handleSkyLocationQuestion(message, context, application, enrichedInterpretation, capability);
  }
  if (plannerPlan.retrievalMode === "rank_visible_points") {
    return handleVisibleRankQuestion(message, context, plannerPlan, application, enrichedInterpretation, capability);
  }

  const target = await resolvePlannerTarget(plannerPlan, explicitLocation, selected, center, context);
  if (explicitLocation && !target) return unresolvedLocationResponse(explicitLocation);
  const deliveryWindow = extractDeliveryWindow(message) ?? deliveryWindowFromPlannerTime(plannerPlan.timeWindow);
  if (isDeliveryOutcomeQuestion(message, enrichedInterpretation, application) && !deliveryWindow) {
    return deliveryTimeFollowupResponse(message, enrichedInterpretation, target, application);
  }
  const forecastRaw = target ? (await fetchForecast([target.point]))[0] : null;
  const advisory = mergeCapabilityIntoResponse(buildAssistantAdvisory(message, context, target, forecastRaw, enrichedInterpretation, capability), capability);
  if (isDeliveryOutcomeQuestion(message, enrichedInterpretation, application) && deliveryWindow) {
    return buildDeliveryRiskResponse(advisory, deliveryWindow, capability);
  }
  const evidence = buildAssistantEvidence({ message, interpretation: enrichedInterpretation, advisory, capability });
  if (!process.env.OPENAI_API_KEY) return advisory;

  try {
    return await callOpenAiAssistant(message, advisory, enrichedInterpretation, evidence);
  } catch (error) {
    return {
      ...advisory,
      answer: `${advisory.answer}\n\nLLM response unavailable, so this answer used the dashboard's deterministic weather rules. ${
        error instanceof Error ? error.message : "OpenAI request failed."
      }`.slice(0, 1600),
      dataUsed: [...new Set([...advisory.dataUsed, "Deterministic fallback"])]
    };
  }
}

async function fetchTrends(region) {
  const p = new URLSearchParams({
    latitude: String(region.lat),
    longitude: String(region.lon),
    start_date: "1995-01-01",
    end_date: "2026-06-20",
    daily: "temperature_2m_mean,precipitation_sum",
    temperature_unit: "fahrenheit",
    precipitation_unit: "inch",
    timezone: "auto"
  });
  return fetchProviderJson(`${archiveUrl}?${p}`, undefined, { timeoutMs: 22_000, retries: 1 });
}

async function fetchOpenMeteoForecast(points) {
  const p = new URLSearchParams({
    latitude: points.map((point) => point.lat).join(","),
    longitude: points.map((point) => point.lon).join(","),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,precipitation",
    hourly: "temperature_2m,apparent_temperature,precipitation,wind_speed_10m,cloud_cover",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    precipitation_unit: "inch",
    forecast_days: "16",
    timezone: "auto"
  });
  return asArray(await fetchProviderJson(`${openMeteoForecastUrl}?${p.toString()}`, undefined, { timeoutMs: 22_000, retries: 1 })).map((raw) =>
    openMeteoForecastCompat(tagRawSource(raw, "open-meteo"))
  );
}

async function fetchForecastFallbackPoint(point) {
  try {
    return await fetchNwsPointForecast(point);
  } catch {
    try {
      return await fetchMetNoPointForecast(point);
    } catch {
      return staticDemoForecastRaw(point);
    }
  }
}

async function fetchNwsPointForecast(point) {
  const pointMeta = await cached(`nws-point:${point.lat.toFixed(3)},${point.lon.toFixed(3)}`, 7 * 24 * 60 * 60_000, () =>
    fetchProviderJson(`${nwsBaseUrl}/points/${point.lat.toFixed(4)},${point.lon.toFixed(4)}`, nwsHeaders, { timeoutMs: 12_000, retries: 1 })
  );
  const gridUrl = pointMeta?.properties?.forecastGridData;
  if (!gridUrl) throw new Error("NWS grid unavailable");
  const grid = await fetchProviderJson(gridUrl, nwsHeaders, { timeoutMs: 14_000, retries: 1 });
  return nwsGridToForecastRaw(grid?.properties ?? {});
}

async function fetchMetNoPointForecast(point) {
  const p = new URLSearchParams({
    lat: String(point.lat),
    lon: String(point.lon)
  });
  const raw = await fetchProviderJson(`${metNoUrl}?${p.toString()}`, metNoHeaders, { timeoutMs: 14_000, retries: 1 });
  return metNoToForecastRaw(raw?.properties?.timeseries ?? []);
}

function nwsGridToForecastRaw(props) {
  const dates = nextDates(16);
  const temp = valuesFor(props.temperature);
  const app = valuesFor(props.apparentTemperature);
  const rh = valuesFor(props.relativeHumidity);
  const wind = valuesFor(props.windSpeed);
  const qpf = valuesFor(props.quantitativePrecipitation);
  const cloud = valuesFor(props.skyCover);
  const maxTemp = valuesFor(props.maxTemperature);
  const minTemp = valuesFor(props.minTemperature);
  return {
    source: { provider: "nws" },
    current: {
      temperature_2m: cToF(firstValue(temp)),
      relative_humidity_2m: firstValue(rh),
      apparent_temperature: cToF(firstValue(app) ?? firstValue(temp)),
      wind_speed_10m: kmhToMph(firstValue(wind)),
      precipitation: mmToIn(firstValue(qpf)),
      cloud_cover: firstValue(cloud)
    },
    daily: {
      time: dates,
      temperature_2m_max: bucketDaily(maxTemp.length ? maxTemp : temp, dates, "max", cToF),
      temperature_2m_min: bucketDaily(minTemp.length ? minTemp : temp, dates, "min", cToF),
      apparent_temperature_max: bucketDaily(app.length ? app : temp, dates, "max", cToF),
      precipitation_sum: bucketDaily(qpf, dates, "sum", mmToIn),
      wind_speed_10m_max: bucketDaily(wind, dates, "max", kmhToMph),
      cloud_cover_mean: bucketDaily(cloud, dates, "mean")
    }
  };
}

function metNoToForecastRaw(timeseries) {
  const dates = nextDates(16);
  const hourly = Array.isArray(timeseries) ? timeseries : [];
  const rows = hourly
    .map((row) => {
      const instant = row?.data?.instant?.details ?? {};
      const next1 = row?.data?.next_1_hours?.details ?? {};
      return {
        validTime: row?.time,
        tempC: numberOrNull(instant.air_temperature),
        rh: numberOrNull(instant.relative_humidity),
        windMs: numberOrNull(instant.wind_speed),
        cloudPct: numberOrNull(instant.cloud_area_fraction),
        precipMm: numberOrNull(next1.precipitation_amount)
      };
    })
    .filter((row) => typeof row.validTime === "string");
  const tempValues = rows.map((row) => ({ validTime: row.validTime, value: row.tempC }));
  const windValues = rows.map((row) => ({ validTime: row.validTime, value: row.windMs == null ? null : row.windMs * 3.6 }));
  const precipValues = rows.map((row) => ({ validTime: row.validTime, value: row.precipMm }));
  const cloudValues = rows.map((row) => ({ validTime: row.validTime, value: row.cloudPct }));
  const first = rows.find((row) => row.tempC != null || row.rh != null || row.windMs != null);
  return {
    source: { provider: "met.no" },
    current: {
      temperature_2m: cToF(first?.tempC ?? null),
      relative_humidity_2m: first?.rh ?? null,
      apparent_temperature: cToF(first?.tempC ?? null),
      wind_speed_10m: first?.windMs == null ? null : first.windMs * 2.23694,
      precipitation: mmToIn(first?.precipMm ?? null),
      cloud_cover: first?.cloudPct ?? null
    },
    daily: {
      time: dates,
      temperature_2m_max: bucketDaily(tempValues, dates, "max", cToF),
      temperature_2m_min: bucketDaily(tempValues, dates, "min", cToF),
      apparent_temperature_max: bucketDaily(tempValues, dates, "max", cToF),
      precipitation_sum: bucketDaily(precipValues, dates, "sum", mmToIn),
      wind_speed_10m_max: bucketDaily(windValues, dates, "max", kmhToMph),
      cloud_cover_mean: bucketDaily(cloudValues, dates, "mean")
    },
    hourly: {
      time: rows.map((row) => row.validTime),
      temperature_2m: rows.map((row) => cToF(row.tempC)),
      apparent_temperature: rows.map((row) => cToF(row.tempC)),
      precipitation: rows.map((row) => mmToIn(row.precipMm)),
      wind_speed_10m: rows.map((row) => (row.windMs == null ? null : row.windMs * 2.23694)),
      cloud_cover: rows.map((row) => row.cloudPct)
    }
  };
}

function emptyForecastRaw() {
  const dates = nextDates(16);
  return {
    source: { provider: "unavailable" },
    current: {
      temperature_2m: null,
      relative_humidity_2m: null,
      apparent_temperature: null,
      wind_speed_10m: null,
      precipitation: null,
      cloud_cover: null
    },
    daily: {
      time: dates,
      temperature_2m_max: Array(16).fill(null),
      temperature_2m_min: Array(16).fill(null),
      apparent_temperature_max: Array(16).fill(null),
      precipitation_sum: Array(16).fill(null),
      wind_speed_10m_max: Array(16).fill(null),
      cloud_cover_mean: Array(16).fill(null)
    },
    hourly: {
      time: [],
      temperature_2m: [],
      apparent_temperature: [],
      precipitation: [],
      wind_speed_10m: [],
      cloud_cover: []
    }
  };
}

function staticDemoForecastRaw(point) {
  const dates = nextDates(16);
  const hours = nextHours(16 * 24);
  const warm = point.lat < 34 ? 88 : point.lat < 40 ? 78 : point.lat > 55 ? 58 : 70;
  const wave = dates.map((_, i) => Math.sin(i / 2) * 4);
  const tmax = wave.map((v) => warm + v);
  const tmin = tmax.map((v) => v - 14);
  const hourlyTemp = hours.map((_, i) => {
    const day = Math.min(15, Math.floor(i / 24));
    const hour = i % 24;
    const diurnal = Math.sin(((hour - 6) / 24) * Math.PI * 2) * 7;
    return (tmax[day] + tmin[day]) / 2 + diurnal;
  });
  return {
    source: { provider: "static-demo" },
    current: {
      temperature_2m: tmax[0] - 5,
      relative_humidity_2m: point.lon < -105 ? 38 : 64,
      apparent_temperature: tmax[0] - 2,
      wind_speed_10m: 9 + Math.abs(Math.sin(point.lon)) * 8,
      precipitation: 0,
      cloud_cover: 35 + Math.abs(Math.sin(point.lat + point.lon)) * 45
    },
    daily: {
      time: dates,
      temperature_2m_max: tmax,
      temperature_2m_min: tmin,
      apparent_temperature_max: tmax.map((v) => v + 2),
      precipitation_sum: dates.map((_, i) => (i % 5 === 0 ? 0.18 : 0)),
      wind_speed_10m_max: dates.map((_, i) => 13 + Math.abs(Math.sin(i + point.lat)) * 16),
      cloud_cover_mean: dates.map((_, i) => 25 + Math.abs(Math.sin(i / 2 + point.lon)) * 60)
    },
    hourly: {
      time: hours,
      temperature_2m: hourlyTemp,
      apparent_temperature: hourlyTemp.map((v) => v + 2),
      precipitation: hours.map((_, i) => (i % 120 === 0 ? 0.04 : 0)),
      wind_speed_10m: hours.map((_, i) => 8 + Math.abs(Math.sin(i / 5 + point.lat)) * 14),
      cloud_cover: hours.map((_, i) => 25 + Math.abs(Math.sin(i / 8 + point.lon)) * 60)
    }
  };
}

function classifyAssistantScope(message, hasLocation) {
  const text = message.toLowerCase();
  const weatherWords =
    /\b(weather|forecast|rain|storm|thunder|lightning|heat|hot|cold|wind|humidity|temperature|temp|cloud|cloudy|clear|sky|stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|stars?|meteor|astronomy|telescope|outdoor|outside|outing|picnic|event|park|risk|fire|firerisk|wildfire|fire[-\s]?risk|fire[-\s]?weather|fire[-\s]?danger|alert|warning|advisory|weekend|tomorrow|today|tonight|next\s+\d+\s+days?|delivery|deliver|package|parcel|travel|drive|commute|repair|repairs|roof|paint|clothing|wear|dress)\b/;
  const explicitWeatherWords =
    /\b(weather|forecast|rain|storm|thunder|lightning|heat|hot|cold|wind|humidity|temperature|temp|cloud|cloudy|clear|sky|stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|stars?|meteor|astronomy|telescope|outdoor|outside|outing|picnic|event|park|risk|fire|firerisk|wildfire|fire[-\s]?risk|fire[-\s]?weather|fire[-\s]?danger|alert|warning|advisory|delivery|deliver|package|parcel|travel|drive|commute|repair|repairs|roof|paint|clothing|wear|dress)\b/;
  const blocked =
    /\b(ai\s+news|news\s+today|recipe|essay|poem|code|homework|stock|crypto|lawsuit|diagnose|medicine|relationship|movie|song|sports score)\b/;
  if (blocked.test(text) && !explicitWeatherWords.test(text)) return "out_of_scope";
  if (weatherWords.test(text)) return "weather";
  if (hasLocation && /\b(look|looks|plan|planning|good|bad|safe|okay|ok|should|when|where|how|what)\b/i.test(text)) return "weather";
  if (blocked.test(text)) return "out_of_scope";
  return "out_of_scope";
}

function isSemanticOutOfScope(semantic, message, context = {}) {
  if (!semantic || typeof semantic !== "object") return false;
  const intent = String(semantic.intent ?? "").toLowerCase();
  if (!["out_of_scope", "not_weather_related", "unsupported"].includes(intent)) return false;
  if (semantic.requestedLayer || semantic.activity || semantic.locations?.length) return false;
  const normalized = String(semantic.normalizedQuestion ?? "");
  if (classifyAssistantScope(normalized, Boolean(context?.selected || context?.map?.center || semantic.locations?.length)) !== "out_of_scope") {
    return false;
  }
  return classifyAssistantScope(message, Boolean(context?.selected || context?.map?.center || semantic.locations?.length)) === "out_of_scope";
}

function normalizedMessageForPlanning(message, semantic) {
  const normalized = typeof semantic?.normalizedQuestion === "string" ? semantic.normalizedQuestion.trim() : "";
  if (!normalized) return message;
  if (/^original:/i.test(normalized)) return message;
  return normalized.slice(0, 800);
}

function outOfScopeAssistantResponse() {
  return {
    answer:
      `${assistantName} is built for this weather dashboard, so I cannot answer that one well. I can help with forecasts, alerts, outdoor timing, clothing, route weather, stargazing, delivery weather risk, or why a map area looks risky.`,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: ["Question is outside the weather dashboard scope."],
    dataUsed: ["Scope guardrail"],
    guardrailNote: `${assistantName} answers only weather-dashboard and weather-impact questions.`,
    actions: [],
    answerType: "out_of_domain",
    persona: "General planning",
    capabilityNote: `${assistantName} is scoped to weather, dashboard, and weather-related planning questions.`,
    missingData: ["Question is outside the weather dashboard scope."]
  };
}

function semanticOutOfScopeResponse(semantic) {
  return {
    ...outOfScopeAssistantResponse(),
    risks: [semantic.normalizedQuestion || "Question is outside the weather dashboard scope."],
    dataUsed: ["Semantic scope guardrail"]
  };
}

function isGreetingMessage(message) {
  return /^\s*(hi|hello|hey|yo|good morning|good afternoon|good evening)\s*[!.?]*\s*$/i.test(String(message ?? ""));
}

function greetingApplicationPlan() {
  return {
    applicationKind: "greeting",
    applicationLabel: "Greeting",
    userGoal: `Start a friendly conversation with ${assistantName}.`,
    locations: [],
    timeWindow: null,
    missingSlots: [],
    requiredEvidence: [],
    dashboardRelevantEvidence: [],
    externalMissingEvidence: [],
    allowedClaim: "The assistant can explain what it can help with.",
    forbiddenClaims: [],
    suggestedFollowup:
      `Hi, I am ${assistantName}. I can help with a place, route, alert, outdoor plan, clothing call, delivery weather risk, or stargazing window. What should we scout first?`,
    answerabilityRecommendation: "answerable"
  };
}

async function normalizeAssistantQuery(message, context, conversationState = null) {
  const fallback = localSemanticNormalization(message, context, conversationState);
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    return sanitizeSemanticNormalization(await callOpenAiSemanticNormalizer(message, context, conversationState), fallback);
  } catch {
    return fallback;
  }
}

async function callOpenAiSemanticNormalizer(message, context, conversationState) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_NORMALIZER_MODEL || process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            "You are the SemanticNormalizer for SkyScout, a bounded U.S. weather dashboard assistant. Clean messy user language into structured fields only. Do not answer. Do not fetch. Do not invent weather. Your normalizedQuestion must be a corrected, planner-ready rewrite of the user's weather/dashboard intent: fix spelling, split run-together terms, expand obvious shorthand, and use canonical dashboard vocabulary. Examples: hte -> the, firerisk/fire-risk -> fire risk, nyc -> New York, NY, niagra -> Niagara, delviery -> delivery, stargaze/stars -> stargazing. First decide whether the message is weather/dashboard/weather-impact related. Use intent out_of_scope only for general news, coding, recipes, finance, entertainment, medical/legal advice, or anything that cannot be reframed as a weather-impact/dashboard question. Correct obvious spelling mistakes in locations and activities, but preserve ambiguity by returning confidence below 0.75 when uncertain. Separate locations from surrounding sentence text; activities like stargazing, food delivery, repairs, travel, and clothing are not locations. For AC, air conditioning, thermostat, HVAC, or home cooling questions, use a home-cooling intent, not outdoor work. Map dashboard-layer requests to one of: risk, fire, heat, temp, wind, humidity, cloud, cdd. For home repairs, exterior work, roofing, painting, ladders, construction, and field work, use an outdoor-work intent. Output JSON only."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              assistantContext: compactPlannerContext(context),
              conversationState: conversationState?.plannerPlan ? conversationState : null,
              availableLayers: ["risk", "fire", "heat", "temp", "wind", "humidity", "cloud", "cdd"]
            },
            null,
            2
          )
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "semantic_normalization",
          strict: true,
          schema: semanticNormalizerSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function semanticNormalizerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "normalizedQuestion",
      "intent",
      "activity",
      "locations",
      "timeWindow",
      "requestedLayer",
      "rankingDirection",
      "needsClarification",
      "clarificationQuestion"
    ],
    properties: {
      normalizedQuestion: { type: "string" },
      intent: { type: "string" },
      activity: { type: ["string", "null"] },
      locations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["raw", "normalized", "role", "confidence"],
          properties: {
            raw: { type: "string" },
            normalized: { type: "string" },
            role: { type: "string", enum: ["single", "origin", "destination", "comparison", "context"] },
            confidence: { type: "number" }
          }
        }
      },
      timeWindow: {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: {
          type: { type: "string", enum: ["none", "now", "day", "range", "hour"] },
          value: { type: "string" }
        }
      },
      requestedLayer: { type: ["string", "null"] },
      rankingDirection: { type: ["string", "null"], enum: ["highest", "lowest", "best", "worst", null] },
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"] }
    }
  };
}

function localSemanticNormalization(message, context = {}, conversationState = null) {
  const text = String(message ?? "");
  const cleanedText = normalizeCommonQueryTypos(text);
  const lower = cleanedText.toLowerCase();
  const scope = classifyAssistantScope(cleanedText, Boolean(context?.selected || context?.map?.center));
  const route = extractRouteLocations(cleanedText);
  const extractedLocation = route.length ? null : extractLocation(cleanedText);
  const locations = route.length
    ? route.slice(0, 2).map((loc, i) => semanticLocation(loc, i === 0 ? "origin" : "destination"))
    : extractedLocation
      ? [semanticLocation(extractedLocation, "single")]
      : [];
  const requestedLayer = inferRequestedLayer(lower, context);
  const intent =
    scope === "out_of_scope" && !requestedLayer
      ? "out_of_scope"
      : /\b(ac|a\/c|air\s*condition(?:er|ing)?|thermostat|hvac|cooling|cooler)\b/.test(lower)
      ? "home_cooling"
      : /\b(repair|repairs|fix|paint|painting|roof|roofing|siding|gutter|ladder|exterior|outside of my house)\b/.test(lower)
      ? "outdoor_work"
      : requestedLayer && /\b(explain|why|area|risk|score|layer)\b/.test(lower)
        ? "dashboard_explainer"
        : requestedLayer
          ? "dashboard_layer_query"
          : "generic_weather";
  const activity =
    intent === "home_cooling"
      ? "home cooling"
      : intent === "outdoor_work"
      ? "exterior home repair"
      : /\bstargaz|star[-\s]?gaz|\bstars?\b|\bnight\s+sky\b/.test(lower)
        ? "stargazing"
        : null;
  const normalizedLocation = locations[0]?.normalized ?? null;
  const normalizedQuestion = buildNormalizedQuestion(cleanedText, normalizedLocation, intent, activity, requestedLayer);
  return sanitizeSemanticNormalization(
    {
      normalizedQuestion,
      intent,
      activity,
      locations,
      timeWindow: plannerTimeWindowFromMessage(cleanedText),
      requestedLayer,
      rankingDirection: /\b(lowest|least)\b/.test(lower)
        ? "lowest"
        : /\b(highest|most|worst)\b/.test(lower)
          ? "highest"
          : /\b(best|which|where|rank|compare)\b/.test(lower)
            ? "best"
            : null,
      needsClarification: false,
      clarificationQuestion: null
    },
    null
  );
}

function semanticLocation(raw, role) {
  const normalized = fuzzyNormalizePlaceCandidate(cleanLocationCandidate(raw));
  return {
    raw: cleanLocationCandidate(raw),
    normalized,
    role,
    confidence: normalized.toLowerCase() === cleanLocationCandidate(raw).toLowerCase() ? 0.82 : 0.9
  };
}

function sanitizeSemanticNormalization(raw, fallback = null) {
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const cleanedLocations = Array.isArray(raw?.locations)
    ? raw.locations
        .filter((loc) => loc && typeof loc === "object")
        .map((loc) => ({
          raw: cleanLocationCandidate(String(loc.raw ?? loc.normalized ?? "")).slice(0, 100),
          normalized: cleanLocationCandidate(String(loc.normalized ?? loc.raw ?? "")).slice(0, 100),
          role: ["single", "origin", "destination", "comparison", "context"].includes(loc.role) ? loc.role : "single",
          confidence: Math.max(0, Math.min(1, Number(loc.confidence) || 0.5))
        }))
        .filter((loc) => loc.normalized && !isBadLocationCandidate(loc.normalized))
        .slice(0, 4)
    : [];
  const locations = cleanedLocations.length ? cleanedLocations : base.locations ?? [];
  const requestedLayer = normalizeLayerId(raw?.requestedLayer) ?? normalizeLayerId(base.requestedLayer);
  const normalizedQuestion = stringOr(raw?.normalizedQuestion, base.normalizedQuestion ?? "", 500);
  return {
    normalizedQuestion,
    intent: stringOr(raw?.intent, base.intent ?? "generic_weather", 80),
    activity: typeof raw?.activity === "string" && raw.activity.trim() ? raw.activity.trim().slice(0, 80) : base.activity ?? null,
    locations,
    timeWindow: sanitizePlannerTimeWindow(raw?.timeWindow ?? base.timeWindow),
    requestedLayer,
    rankingDirection: ["highest", "lowest", "best", "worst"].includes(raw?.rankingDirection) ? raw.rankingDirection : base.rankingDirection ?? null,
    needsClarification: Boolean(raw?.needsClarification ?? base.needsClarification ?? false),
    clarificationQuestion:
      typeof raw?.clarificationQuestion === "string" && raw.clarificationQuestion.trim()
        ? raw.clarificationQuestion.trim().slice(0, 220)
        : base.clarificationQuestion ?? null
  };
}

function primarySemanticLocation(semantic) {
  const loc = Array.isArray(semantic?.locations)
    ? semantic.locations.find((item) => item.role === "single") ?? semantic.locations.find((item) => item.role === "comparison") ?? semantic.locations[0]
    : null;
  return loc?.confidence >= 0.62 ? loc.normalized : null;
}

function applySemanticNormalizationToPlan(plan, semantic, context = {}) {
  if (!semantic || typeof semantic !== "object") return plan;
  const next = { ...plan };
  const semanticLocations = Array.isArray(semantic.locations) ? semantic.locations.filter((loc) => loc.confidence >= 0.62) : [];
  if (semanticLocations.length && !["route"].includes(next.retrievalMode)) {
    next.locations = semanticLocations.map((loc) => ({ raw: loc.normalized, role: loc.role }));
    next.geocodeQueries = semanticLocations.map((loc) => loc.normalized);
    next.shouldGeocode = semanticLocations.some((loc) => loc.role !== "context");
    if (!["rank_visible_points", "compare_locations"].includes(next.retrievalMode)) next.retrievalMode = semanticLocations.length > 1 ? "compare_locations" : "single_location";
  }
  if (semantic.timeWindow?.type && semantic.timeWindow.type !== "none") next.timeWindow = semantic.timeWindow;
  if (semantic.activity) next.activity = semantic.activity;
  if (semantic.intent && semantic.intent !== "generic_weather") next.lens = semantic.intent;
  const layer = normalizeLayerId(semantic.requestedLayer);
  if (layer) {
    next.requiredFacts = [{ id: `layer_${layer}`, loc: null, source: "direct", compute: null }];
    if (/\b(which|where|highest|lowest|worst|best|rank|compare|region|place|location)\b/i.test(String(next.goal ?? "")) || semantic.rankingDirection) {
      next.retrievalMode = "rank_visible_points";
    } else if (!semanticLocations.length && context?.selected) {
      next.retrievalMode = "selected_region";
      next.locations = [{ raw: "context", role: "context" }];
      next.shouldGeocode = false;
    } else if (!semanticLocations.length && context?.map?.center) {
      next.retrievalMode = "map_center";
      next.locations = [{ raw: "context", role: "context" }];
      next.shouldGeocode = false;
    }
  }
  return next;
}

function buildNormalizedQuestion(message, location, intent, activity, requestedLayer) {
  const bits = [];
  if (intent === "home_cooling") bits.push("Assess home cooling demand from weather");
  else if (intent === "outdoor_work") bits.push("Assess outdoor repair work from weather");
  else if (intent === "dashboard_explainer") bits.push("Explain the dashboard risk");
  else if (requestedLayer) bits.push(`Use the ${requestedLayer} dashboard layer`);
  if (activity) bits.push(`activity: ${activity}`);
  if (location) bits.push(`location: ${location}`);
  const time = plannerTimeWindowFromMessage(message);
  if (time.type !== "none") bits.push(`time: ${time.value}`);
  return bits.length ? `${bits.join("; ")}. Original: ${String(message).slice(0, 280)}` : String(message).slice(0, 500);
}

function inferRequestedLayer(text, context = {}) {
  const lower = String(text ?? "").toLowerCase();
  if (/\b(?:fire(?:\s+weather|\s+risk|\s+danger)?|fire[-\s]?risk|fire[-\s]?weather|fire[-\s]?danger|firerisk|wildfire)\b/.test(lower)) return "fire";
  if (/\bheat|hot|temperature stress|heat index\b/.test(lower)) return "heat";
  if (/\btemp|temperature\b/.test(lower)) return "temp";
  if (/\bwind|windy|gust\b/.test(lower)) return "wind";
  if (/\bhumid|humidity\b/.test(lower)) return "humidity";
  if (/\bcloud|cloudy|clear sky|sky cover\b/.test(lower)) return "cloud";
  if (/\bcdd|cooling degree\b/.test(lower)) return "cdd";
  if (/\brisk|stress|score|red|orange|yellow|layer\b/.test(lower)) return normalizeLayerId(context?.activeLayer?.id) ?? "risk";
  return null;
}

function normalizeLayerId(value) {
  const key = String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = {
    risk: "risk",
    stress: "risk",
    score: "risk",
    forecast_stress: "risk",
    fire: "fire",
    fire_weather: "fire",
    fire_risk: "fire",
    firerisk: "fire",
    wildfire: "fire",
    fire_danger: "fire",
    heat: "heat",
    heat_index: "heat",
    temp: "temp",
    temperature: "temp",
    wind: "wind",
    wind_speed: "wind",
    humidity: "humidity",
    humid: "humidity",
    cloud: "cloud",
    cloud_cover: "cloud",
    cdd: "cdd",
    cooling_degree_days: "cdd"
  };
  return aliases[key] ?? null;
}

function normalizeCommonQueryTypos(value) {
  let text = String(value ?? "");
  const replacements = [
    [/\bhte\b/gi, "the"],
    [/\bteh\b/gi, "the"],
    [/\bwaht\b/gi, "what"],
    [/\bwoudl\b/gi, "would"],
    [/\bdoens\b/gi, "does"],
    [/\btomorow\b/gi, "tomorrow"],
    [/\btomm?orrow\b/gi, "tomorrow"],
    [/\btonite\b/gi, "tonight"],
    [/\bdelviery\b/gi, "delivery"],
    [/\bdelvier(?:y|ed)?\b/gi, "deliver"],
    [/\bweather\s*risk\b/gi, "weather risk"],
    [/\bfirerisk\b/gi, "fire risk"],
    [/\bfire[-_]?risk\b/gi, "fire risk"],
    [/\bfire[-_]?weather\b/gi, "fire weather"],
    [/\bfire[-_]?danger\b/gi, "fire danger"],
    [/\bstar\s*gazing\b/gi, "stargazing"],
    [/\bstargazeing\b/gi, "stargazing"],
    [/\bniagra\b/gi, "Niagara"],
    [/\bbirmiingham\b/gi, "Birmingham"]
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text.replace(/\s+/g, " ").trim();
}

function fuzzyNormalizePlaceCandidate(value) {
  const cleaned = cleanLocationCandidate(value);
  const key = cleaned.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const direct = PLACE_ALIASES[key];
  if (direct) return direct;
  const parsed = parseCityState(cleaned);
  const state = parsed.state ? stateNameFor(parsed.state) : null;
  const cityKey = parsed.city.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  let best = null;
  for (const [candidate, canonical] of Object.entries(PLACE_ALIASES)) {
    const candidateCity = candidate.replace(/\s+(al|alabama|ny|new york|id|idaho|ut|utah|tx|texas|ca|california|ga|georgia|fl|florida|co|colorado|wa|washington|il|illinois)$/i, "");
    const score = similarityScore(cityKey, candidateCity);
    if (score >= 0.82 && (!best || score > best.score)) best = { canonical, score };
  }
  if (best?.canonical) {
    if (state && !new RegExp(`\\b${state}\\b|\\b${stateAbbrevFor(state)}\\b`, "i").test(best.canonical)) return cleaned;
    return best.canonical;
  }
  return cleaned;
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[a.length][b.length];
}

const PLACE_ALIASES = {
  birmingham: "Birmingham, AL",
  "birmingham al": "Birmingham, AL",
  "birmingham alabama": "Birmingham, AL",
  "birmiingham alabama": "Birmingham, AL",
  "birmiingham al": "Birmingham, AL",
  nyc: "New York, NY",
  "new york city": "New York, NY",
  slc: "Salt Lake City, UT",
  "salt lake city": "Salt Lake City, UT",
  "salt lake city utah": "Salt Lake City, UT",
  rochester: "Rochester, NY",
  "rochester ny": "Rochester, NY",
  boise: "Boise, ID",
  "boise id": "Boise, ID",
  "boise idaho": "Boise, ID",
  albany: "Albany, NY",
  "albany ny": "Albany, NY"
};

async function planWeatherDashboardRequest(message, context, conversationState = null, semantic = null) {
  const priorPlan =
    conversationState?.plannerPlan && typeof conversationState.plannerPlan === "object" ? conversationState.plannerPlan : null;
  if (priorPlan?.pendingFacts?.length) {
    return verifyPlannerPlan(mergePlannerFollowup(priorPlan, message, context), context);
  }
  if (priorPlan && !priorPlan.pendingFacts?.length && isPlannerContinuationMessage(message, priorPlan)) {
    return verifyPlannerPlan(continuePlannerPlan(priorPlan, message), context);
  }
  const fallback = verifyPlannerPlan(
    applyPlannerContextPolicies(applySemanticNormalizationToPlan(localPlannerPlan(message, context, conversationState, semantic), semantic, context), message, context),
    context
  );
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    return verifyPlannerPlan(
      applyPlannerContextPolicies(
        applySemanticNormalizationToPlan(await callOpenAiDashboardPlanner(message, context, conversationState, semantic), semantic, context),
        message,
        context
      ),
      context
    );
  } catch {
    return fallback;
  }
}

async function callOpenAiDashboardPlanner(message, context, conversationState, semantic = null) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_PLANNER_MODEL || process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            "You are the Planner for SkyScout, a bounded U.S. weather-dashboard assistant. Your ONLY job is to interpret the user's message and produce a structured execution plan that downstream code will validate and execute. You do NOT answer the user. You do NOT fetch, geocode, or invent weather data. First determine whether the request is in scope: weather, alerts, dashboard layers, map-area explanation, or weather-sensitive applications such as stargazing, clothing, delivery, route travel, outdoor events, exterior work, field crews, utilities, or business operations. If it is fully outside that lane, set domain not_weather_related. The data manifest is authoritative: facts listed there are dashboard-available; facts in notAvailable or not listed are external. Separate missing user context such as location, route endpoints, region/search scope, and time window into pendingFacts. Do not use a generic map center for personal/user-situation questions like delivery, clothing, repairs, commute, travel, events, or 'should I' planning unless the user explicitly says here/this area/current map or a selected region is present; ask for location instead. Map-native questions like 'explain this area's risk' or visible-region rankings may use map context. Mark unavailable external evidence as requiredFacts with source external. For broad ranking questions like 'where is best for stargazing?', do not geocode the activity; use rank_visible_points if the current map/visible points can answer, and ask for time_window or search_scope when needed. Output JSON only."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              dataManifest,
              semanticNormalization: semantic,
              assistantContext: compactPlannerContext(context),
              conversationState: conversationState?.plannerPlan ? conversationState : null,
              message
            },
            null,
            2
          )
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "weather_dashboard_plan",
          strict: true,
          schema: plannerSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function plannerSchema() {
  const factSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "loc", "source", "compute"],
    properties: {
      id: { type: "string" },
      loc: { type: ["number", "null"] },
      source: { type: "string", enum: ["direct", "derived", "external"] },
      compute: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["op", "var", "where", "over", "locs"],
        properties: {
          op: { type: ["string", "null"] },
          var: { type: ["string", "null"] },
          where: { type: ["string", "null"] },
          over: { type: ["string", "null"] },
          locs: { type: "array", items: { type: "number" } }
        }
      }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "domain",
      "goal",
      "lens",
      "activity",
      "retrievalMode",
      "shouldGeocode",
      "geocodeQueries",
      "locations",
      "timeWindow",
      "requiredFacts",
      "pendingFacts",
      "safetyFlags",
      "expectedAnswerMode"
    ],
    properties: {
      domain: { type: "string", enum: ["weather_related", "not_weather_related", "ambiguous"] },
      goal: { type: "string" },
      lens: { type: "string" },
      activity: { type: ["string", "null"] },
      retrievalMode: { type: "string", enum: dataManifest.retrievalModes },
      shouldGeocode: { type: "boolean" },
      geocodeQueries: { type: "array", items: { type: "string" } },
      locations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["raw", "role"],
          properties: {
            raw: { type: "string" },
            role: { type: "string", enum: ["single", "origin", "destination", "comparison", "context"] }
          }
        }
      },
      timeWindow: {
        type: "object",
        additionalProperties: false,
        required: ["type", "value"],
        properties: {
          type: { type: "string", enum: ["none", "now", "day", "range", "hour"] },
          value: { type: "string" }
        }
      },
      requiredFacts: { type: "array", items: factSchema },
      pendingFacts: { type: "array", items: { type: "string" } },
      safetyFlags: { type: "array", items: { type: "string" } },
      expectedAnswerMode: {
        type: "string",
        enum: ["answer_from_dashboard", "answer_with_external_caveat", "ask_followup", "not_weather_related", "unsupported_redirect"]
      }
    }
  };
}

function compactPlannerContext(context = {}) {
  return {
    selected: context?.selected
      ? {
          name: context.selected.name,
          state: context.selected.state,
          lat: context.selected.lat,
          lon: context.selected.lon,
          score: context.selected.score,
          layers: context.selected.layers ?? null
        }
      : null,
    map: context?.map
      ? {
          center: context.map.center,
          zoom: context.map.zoom
        }
      : null,
    activeLayer: context?.activeLayer ?? null,
    sourceBadge: context?.sourceBadge ?? null,
    forecastStatus: context?.forecastStatus ?? null,
    alertStatus: context?.alertStatus ?? null,
    visiblePoints: Array.isArray(context?.visiblePoints) ? context.visiblePoints.slice(0, 12) : [],
    alerts: Array.isArray(context?.alerts)
      ? context.alerts.slice(0, 6).map((alert) => ({
          event: alert.event,
          severity: alert.severity,
          effective: alert.effective,
          expires: alert.expires,
          areaDesc: alert.areaDesc
        }))
      : []
  };
}

function verifyPlannerPlan(raw, context = {}) {
  const plan = raw && typeof raw === "object" ? raw : {};
  const selected = context?.selected && typeof context.selected === "object" ? context.selected : null;
  const hasContextLocation = Boolean(selected || context?.map?.center);
  const domain = ["weather_related", "not_weather_related", "ambiguous"].includes(plan.domain) ? plan.domain : "ambiguous";
  const locations = sanitizePlannerLocations(plan.locations);
  let retrievalMode = manifestRetrievalModes.has(plan.retrievalMode) ? plan.retrievalMode : inferRetrievalMode(plan, locations, hasContextLocation);
  const pendingFacts = sanitizePlannerPendingFacts(plan.pendingFacts, { plan, locations, context });
  if (pendingFacts.length) retrievalMode = "ask_followup";
  const verified = {
    domain,
    goal: stringOr(plan.goal, "Understand the user's weather-related question.", 240),
    lens: stringOr(plan.lens, "generic", 80),
    activity: typeof plan.activity === "string" && plan.activity.trim() ? plan.activity.trim().slice(0, 80) : null,
    retrievalMode,
    shouldGeocode: Boolean(plan.shouldGeocode) && locations.some((loc) => loc.raw !== "context"),
    geocodeQueries: sanitizeStringList(plan.geocodeQueries, [], 4, 100),
    locations,
    timeWindow: sanitizePlannerTimeWindow(plan.timeWindow),
    requiredFacts: sanitizePlannerFacts(plan.requiredFacts, locations.length),
    pendingFacts,
    safetyFlags: sanitizeStringList(plan.safetyFlags, [], 5, 80),
    expectedAnswerMode: [
      "answer_from_dashboard",
      "answer_with_external_caveat",
      "ask_followup",
      "not_weather_related",
      "unsupported_redirect"
    ].includes(plan.expectedAnswerMode)
      ? plan.expectedAnswerMode
      : pendingFacts.length
        ? "ask_followup"
        : domain === "not_weather_related"
          ? "not_weather_related"
          : "answer_from_dashboard"
  };
  if (!verified.geocodeQueries.length && verified.shouldGeocode) {
    verified.geocodeQueries = verified.locations.filter((loc) => loc.raw !== "context").map((loc) => loc.raw).slice(0, 4);
  }
  if (verified.retrievalMode === "single_location" && !verified.locations.length && hasContextLocation) {
    verified.locations = [{ raw: "context", role: "context" }];
    verified.shouldGeocode = false;
  }
  return verified;
}

function applyPlannerContextPolicies(plan, message, context = {}) {
  return applyLocationContextPolicy(applySearchScopePolicy(plan, message, context), message, context);
}

function applySearchScopePolicy(plan, message, context = {}) {
  if (!shouldAskSearchScopeForBroadRanking(plan, message, context)) return plan;
  return {
    ...plan,
    retrievalMode: "ask_followup",
    pendingFacts: ["search_scope", ...(Array.isArray(plan.pendingFacts) ? plan.pendingFacts : [])]
      .filter((value, index, arr) => value && arr.indexOf(value) === index)
      .slice(0, 2),
    expectedAnswerMode: "ask_followup"
  };
}

function applyLocationContextPolicy(plan, message, context = {}) {
  if (!shouldAskUserLocationInsteadOfMapCenter(plan, message, context)) return plan;
  return {
    ...plan,
    retrievalMode: "ask_followup",
    shouldGeocode: false,
    geocodeQueries: [],
    locations: (Array.isArray(plan.locations) ? plan.locations : []).filter((loc) => loc?.raw !== "context"),
    pendingFacts: ["location", ...(Array.isArray(plan.pendingFacts) ? plan.pendingFacts : [])]
      .filter((value, index, arr) => value && arr.indexOf(value) === index)
      .slice(0, 2),
    expectedAnswerMode: "ask_followup"
  };
}

function shouldAskSearchScopeForBroadRanking(plan, message, context = {}) {
  if (!plan || plan.domain === "not_weather_related") return false;
  if (context?.selected) return false;
  if (mentionsMapContext(message) || mentionsSearchScope(message)) return false;
  const locations = Array.isArray(plan.locations) ? plan.locations : [];
  if (locations.some((loc) => loc?.raw && loc.raw !== "context")) return false;
  if (String(plan.retrievalMode ?? "") !== "rank_visible_points") return false;
  if (isDashboardNativePlan(plan, message) && !isBroadPlaceRankingQuestion(message)) return false;
  return isBroadPlaceRankingQuestion(message);
}

function shouldAskUserLocationInsteadOfMapCenter(plan, message, context = {}) {
  if (!plan || plan.domain === "not_weather_related") return false;
  if (Array.isArray(plan.pendingFacts) && plan.pendingFacts.includes("search_scope")) return false;
  if (context?.selected) return false;
  if (mentionsMapContext(message)) return false;
  const locations = Array.isArray(plan.locations) ? plan.locations : [];
  if (locations.some((loc) => loc?.raw && loc.raw !== "context")) return false;
  const mode = String(plan.retrievalMode ?? "");
  if (["route", "compare_locations", "rank_visible_points", "alert_explanation", "none"].includes(mode)) return false;
  if (isDashboardNativePlan(plan, message)) return false;
  return usesOnlyGenericMapCenter(plan, context) && isUserSituationWeatherQuestion(plan, message);
}

function usesOnlyGenericMapCenter(plan, context = {}) {
  const locations = Array.isArray(plan.locations) ? plan.locations : [];
  if (locations.length && !locations.some((loc) => loc?.raw === "context")) return false;
  return Boolean(context?.map?.center) || String(plan.retrievalMode ?? "") === "map_center";
}

function isDashboardNativePlan(plan, message) {
  const text = String(message ?? "").toLowerCase();
  const lens = String(plan?.lens ?? "").toLowerCase();
  const goal = String(plan?.goal ?? "").toLowerCase();
  if (lens.includes("dashboard") || /\b(layer|score|risk map|dashboard)\b/.test(`${text} ${goal}`)) return true;
  return /\b(explain|why|what does)\b/.test(text) && /\b(this|current|selected|area|region|map)\b/.test(text);
}

function isBroadPlaceRankingQuestion(message) {
  return /\b(which|where|best|better|good|top|rank|compare|place|places|area|areas|region|regions|spot|spots|location|locations|choice)\b/i.test(
    String(message ?? "")
  );
}

function isUserSituationWeatherQuestion(plan, message) {
  const text = String(message ?? "").toLowerCase();
  const lens = String(plan?.lens ?? "").toLowerCase();
  const activity = String(plan?.activity ?? "").toLowerCase();
  const combined = `${lens} ${activity} ${text}`;
  if (/\b(my|me|i|we|our|us)\b/.test(text)) return true;
  if (/\b(delivery|deliver|package|parcel|shipment|food|restaurant|doordash|uber\s*eats|grubhub)\b/.test(combined)) return true;
  if (/\b(wear|clothing|clothes|dress|outfit|jacket|coat|umbrella|packing|comfort)\b/.test(combined)) return true;
  if (/\b(repair|repairs|paint|painting|roof|roofing|siding|gutter|ladder|exterior|construction|field|crew|jobsite)\b/.test(combined)) return true;
  if (/\b(event|picnic|outing|park|concert|festival|wedding|outdoor)\b/.test(combined)) return true;
  if (/\b(travel|drive|driving|commute|trip|go out|go outside)\b/.test(combined)) return true;
  return ["map_center", "single_location", "ask_followup"].includes(String(plan?.retrievalMode ?? ""));
}

function sanitizePlannerLocations(value) {
  const roles = new Set(["single", "origin", "destination", "comparison", "context"]);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && typeof item.raw === "string" && item.raw.trim())
    .map((item) => ({
      raw: cleanLocationCandidate(item.raw.trim()).slice(0, 100) || item.raw.trim().slice(0, 100),
      role: roles.has(item.role) ? item.role : item.raw === "context" ? "context" : "single"
    }))
    .filter((item) => item.raw === "context" || !isBadLocationCandidate(item.raw))
    .slice(0, 4);
}

function sanitizePlannerTimeWindow(value) {
  const type = ["none", "now", "day", "range", "hour"].includes(value?.type) ? value.type : "none";
  return { type, value: typeof value?.value === "string" ? value.value.trim().slice(0, 80) : "" };
}

function sanitizePlannerPendingFacts(value, { plan = {}, locations = [], context = {} } = {}) {
  const raw = sanitizeStringList(value, [], 6, 120);
  const hasExplicitLocation = locations.some((loc) => loc?.raw && loc.raw !== "context") || Boolean(context?.selected);
  const hasRouteOrigin = locations.some((loc) => loc?.role === "origin");
  const hasRouteDestination = locations.some((loc) => loc?.role === "destination");
  const timeWindow = sanitizePlannerTimeWindow(plan?.timeWindow);
  const hasUsableTime = timeWindow.type !== "none" && Boolean(timeWindow.value);
  const slots = [];
  for (const item of raw) {
    const slot = canonicalPendingFact(item);
    if (!slot) continue;
    if (slot === "location" && hasExplicitLocation) continue;
    if (slot === "origin" && hasRouteOrigin) continue;
    if (slot === "destination" && hasRouteDestination) continue;
    if (slot === "time_window" && hasUsableTime) continue;
    if (!slots.includes(slot)) slots.push(slot);
  }
  return slots.slice(0, 2);
}

function canonicalPendingFact(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  if (/forecast|temperature|temp|humidity|wind|precip|rain|cloud|alert|value|values|data|metric|weather\s+facts?/.test(text)) return null;
  if (/search|scope|region|area preference|map view|visible/.test(text)) return "search_scope";
  if (/origin|start(?:ing)? point|from\b/.test(text)) return "origin";
  if (/destination|endpoint|to\b/.test(text)) return "destination";
  if (/time|window|when|hour|morning|afternoon|evening|tonight|tomorrow|today|date|day/.test(text)) return "time_window";
  if (/location|city|state|place|address|where|map context|selected map/.test(text)) return "location";
  return null;
}

function sanitizePlannerFacts(value, locationCount) {
  if (!Array.isArray(value)) return [];
  return value
    .map((fact) => sanitizePlannerFact(fact, locationCount))
    .filter(Boolean)
    .slice(0, 12);
}

function sanitizePlannerFact(fact, locationCount) {
  if (!fact || typeof fact !== "object") return null;
  const id = stringOr(fact.id, "unknown_fact", 100);
  const source = ["direct", "derived", "external"].includes(fact.source) ? fact.source : "external";
  const loc = Number.isInteger(fact.loc) && fact.loc >= 0 && fact.loc < locationCount ? fact.loc : null;
  if (source === "direct" && manifestVariableIds.has(id)) return { id, loc, source, compute: null };
  if (source === "derived") {
    const compute = fact.compute && typeof fact.compute === "object" ? fact.compute : {};
    const op = manifestOperationIds.has(compute.op) ? compute.op : null;
    const variable = manifestVariableIds.has(compute.var) ? compute.var : null;
    if (op && variable) {
      return {
        id,
        loc,
        source,
        compute: {
          op,
          var: variable,
          where: typeof compute.where === "string" ? compute.where.slice(0, 80) : null,
          over: typeof compute.over === "string" ? compute.over.slice(0, 80) : null,
          locs: Array.isArray(compute.locs) ? compute.locs.filter((n) => Number.isInteger(n)).slice(0, 6) : []
        }
      };
    }
  }
  return { id, loc: null, source: "external", compute: null };
}

function inferRetrievalMode(plan, locations, hasContextLocation) {
  const lens = String(plan?.lens ?? "").toLowerCase();
  const activity = String(plan?.activity ?? "").toLowerCase();
  const goal = String(plan?.goal ?? "").toLowerCase();
  if (locations.some((loc) => loc.role === "origin" || loc.role === "destination")) return "route";
  if (locations.length > 1) return "compare_locations";
  if (/\b(best|which|where|rank|compare)\b/.test(goal) && !locations.length) return "rank_visible_points";
  if (/\bstargaz|star gaz|sky/.test(`${lens} ${activity} ${goal}`) && !locations.length) return "rank_visible_points";
  if (locations.length) return "single_location";
  return hasContextLocation ? "map_center" : "ask_followup";
}

function localPlannerPlan(message, context, conversationState = null, semantic = null) {
  const text = String(message ?? "").toLowerCase();
  const priorPlan = conversationState?.plannerPlan && typeof conversationState.plannerPlan === "object" ? conversationState.plannerPlan : null;
  if (priorPlan?.pendingFacts?.length) return mergePlannerFollowup(priorPlan, message, context);
  if (isGreetingMessage(message)) {
    return {
      domain: "weather_related",
      goal: `Greet ${assistantName}.`,
      lens: "chitchat",
      activity: null,
      retrievalMode: "none",
      shouldGeocode: false,
      geocodeQueries: [],
      locations: [],
      timeWindow: { type: "none", value: "" },
      requiredFacts: [],
      pendingFacts: [],
      safetyFlags: [],
      expectedAnswerMode: "answer_from_dashboard"
    };
  }
  const semanticLocation = primarySemanticLocation(semantic);
  const location = semanticLocation ?? extractLocation(message);
  const routeLocations = extractRouteLocations(message);
  const hasContext = Boolean(context?.selected || context?.map?.center);
  const hasSelectedContext = Boolean(context?.selected);
  const lens = semantic?.intent && semantic.intent !== "generic_weather" ? semantic.intent : inferPlannerLens(text);
  const deliveryNeedsExplicitLocation = lens.includes("delivery") && !location && !hasSelectedContext && !mentionsMapContext(text);
  const removedMetricQuestion = /\b(aqi|air\s*quality|pm2\.?5|ozone|smoke|flood|river|discharge|streamflow|heat\s*stress|wet\s*bulb|wbgt|drought|soil|solar|wind\s*power|wpd)\b/.test(text);
  const weatherish =
    classifyAssistantScope(message, Boolean(location || routeLocations.length || hasContext)) !== "out_of_scope" ||
    lens !== "generic" ||
    removedMetricQuestion;
  const requestedLayer = normalizeLayerId(semantic?.requestedLayer);
  const retrievalMode =
    routeLocations.length >= 2
      ? "route"
      : requestedLayer && /\b(explain|why|this\s+area|area's|risk|score|layer)\b/.test(text) && !location && !/\b(which|where|highest|lowest|worst|best|rank|compare)\b/.test(text)
          ? context?.selected
            ? "selected_region"
            : "map_center"
        : requestedLayer && /\b(which|where|highest|lowest|worst|best|rank|compare|region|place|location)\b/.test(text) && !location
          ? "rank_visible_points"
      : /\b(which|where|best|better|rank|compare|choice|area|spot|place|location)\b/.test(text) && !location
        ? "rank_visible_points"
        : location
          ? "single_location"
          : hasContext && !deliveryNeedsExplicitLocation
            ? "map_center"
            : "ask_followup";
  const locations = routeLocations.length
    ? [
        { raw: routeLocations[0], role: "origin" },
        { raw: routeLocations[1], role: "destination" }
      ]
    : location
      ? [{ raw: location, role: "single" }]
      : hasContext && retrievalMode !== "rank_visible_points" && !deliveryNeedsExplicitLocation
        ? [{ raw: "context", role: "context" }]
        : [];
  const needsLocation = deliveryNeedsExplicitLocation || (["single_location", "route", "compare_locations"].includes(retrievalMode) && !locations.length);
  const needsDeliveryTime = lens.includes("delivery") && !extractDeliveryWindow(message);
  const needsStargazingWindow = lens === "stargazing" && !hasExplicitPlanningWindow(message);
  const requiredFacts = requestedLayer
    ? [{ id: `layer_${requestedLayer}`, loc: locations.length ? 0 : null, source: "direct", compute: null }]
    : localRequiredFacts(lens, retrievalMode, locations.length);
  return {
    domain: weatherish ? "weather_related" : "not_weather_related",
    goal: localPlannerGoal(message, lens, retrievalMode),
    lens,
    activity: semantic?.activity ?? inferPlannerActivity(text),
    retrievalMode,
    shouldGeocode: locations.some((loc) => loc.raw !== "context"),
    geocodeQueries: locations.filter((loc) => loc.raw !== "context").map((loc) => loc.raw),
    locations,
    timeWindow: plannerTimeWindowFromMessage(message),
    requiredFacts,
    pendingFacts: [needsLocation ? "location" : null, needsDeliveryTime ? "time_window" : null, needsStargazingWindow ? "time_window" : null]
      .filter(Boolean)
      .slice(0, 2),
    safetyFlags: /\b(severe|warning|flood|lightning|danger|emergency|heat stroke|tornado)\b/.test(text) ? ["severe_weather_context"] : [],
    expectedAnswerMode: lens.includes("delivery") || retrievalMode === "route" ? "answer_with_external_caveat" : "answer_from_dashboard"
  };
}

function mergePlannerFollowup(priorPlan, message, context) {
  const plan = { ...priorPlan, locations: Array.isArray(priorPlan.locations) ? [...priorPlan.locations] : [] };
  const pending = new Set(Array.isArray(priorPlan.pendingFacts) ? priorPlan.pendingFacts : []);
  const location = extractLocation(message);
  const routeLocations = extractRouteLocations(message);
  const window = hasExplicitPlanningWindow(message) ? plannerTimeWindowFromMessage(message) : { type: "none", value: "" };
  if (pending.has("location") && location) {
    plan.locations = [{ raw: location, role: "single" }];
    plan.shouldGeocode = true;
    plan.geocodeQueries = [location];
    pending.delete("location");
  }
  if ((pending.has("origin") || pending.has("destination")) && routeLocations.length >= 2) {
    plan.locations = [
      { raw: routeLocations[0], role: "origin" },
      { raw: routeLocations[1], role: "destination" }
    ];
    plan.shouldGeocode = true;
    plan.geocodeQueries = routeLocations.slice(0, 2);
    pending.delete("origin");
    pending.delete("destination");
  }
  if (pending.has("time_window") && window.type !== "none") {
    plan.timeWindow = window;
    pending.delete("time_window");
  }
  if (pending.has("search_scope") && String(message ?? "").trim()) {
    plan.goal = `${plan.goal || "Answer the weather question."} Search scope follow-up: ${String(message).slice(0, 120)}`;
    if (location) {
      plan.locations = [{ raw: location, role: "single" }];
      plan.shouldGeocode = true;
      plan.geocodeQueries = [location];
      plan.retrievalMode = "single_location";
    } else {
      plan.locations = [];
      plan.shouldGeocode = false;
      plan.geocodeQueries = [];
      plan.retrievalMode = "rank_visible_points";
    }
    pending.delete("search_scope");
  }
  if (!plan.locations?.length && context?.selected) plan.locations = [{ raw: "context", role: "context" }];
  plan.pendingFacts = [...pending].slice(0, 2);
  plan.expectedAnswerMode = plan.pendingFacts.length ? "ask_followup" : plan.expectedAnswerMode;
  return plan;
}

function isPlannerContinuationMessage(message, priorPlan) {
  const text = String(message ?? "").toLowerCase();
  if (!text.trim()) return false;
  if (extractRouteLocations(message).length >= 2 || extractLocation(message)) return false;
  const priorMode = priorPlan?.retrievalMode;
  const priorLens = String(priorPlan?.lens ?? "").toLowerCase();
  const priorActivity = String(priorPlan?.activity ?? "").toLowerCase();
  const continuation =
    /\b(when|what\s+time|best\s+time|start|leave|depart|timing|how\s+about|what\s+about|that|there|then|same|still|also)\b/.test(text);
  if (!continuation) return false;
  if (priorMode === "route") return /\b(when|what\s+time|best\s+time|start|leave|depart|timing|drive|travel|trip|route)\b/.test(text);
  if (priorLens.includes("delivery")) return /\b(when|what\s+time|delay|delivery|arrive|window|morning|afternoon|evening|\d{1,2}\s*(am|pm))\b/.test(text);
  if (priorLens === "stargazing" || priorActivity === "stargazing") return /\b(still|there|then|best|spot|area|cloud|stars?|sky|tonight)\b/.test(text);
  return continuation && String(priorPlan?.domain ?? "") === "weather_related";
}

function continuePlannerPlan(priorPlan, message) {
  const nextWindow = plannerTimeWindowFromMessage(message);
  const keepPriorWindow = nextWindow.value === "default_next_4d" && priorPlan?.timeWindow?.value;
  return {
    ...priorPlan,
    goal: `${priorPlan.goal || "Continue the weather question."} Follow-up: ${String(message).slice(0, 120)}`,
    timeWindow: keepPriorWindow ? priorPlan.timeWindow : nextWindow,
    pendingFacts: [],
    expectedAnswerMode: priorPlan.expectedAnswerMode === "ask_followup" ? "answer_from_dashboard" : priorPlan.expectedAnswerMode
  };
}

function inferPlannerLens(text) {
  if (/\b(food|restaurant|doordash|uber\s*eats|ubereats|grubhub|takeout|meal|order)\b/.test(text) && /\b(delivery|deliver|delay|late|arriv)/.test(text)) return "food_delivery";
  if (/\b(amazon|package|parcel|shipment|tracking)\b/.test(text)) return "package_delivery";
  if (/\b(delivery|deliver|courier)\b/.test(text)) return "delivery";
  if (/\b(stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|watch(?:ing)?\s+(?:the\s+)?stars?|meteor|night\s+sky|telescope)\b/.test(text)) return "stargazing";
  if (/\b(wear|clothing|clothes|dress|outfit|jacket|coat|sweater|hoodie|shorts|pants|umbrella|raincoat)\b/.test(text)) return "clothing";
  if (/\b(ac|a\/c|air\s*condition(?:er|ing)?|thermostat|hvac|cooling|cooler|cool\s+my\s+house|cool\s+my\s+home)\b/.test(text)) return "home_cooling";
  if (/\b(travel|drive|driving|road\s*trip|commute|trip|flight|fly)\b/.test(text)) return "travel";
  if (/\b(picnic|event|concert|festival|wedding|park|outdoor)\b/.test(text)) return "event";
  if (/\b(repair|repairs|fix|paint|painting|roof|roofing|siding|gutter|ladder|exterior|construction|crane|paving|jobsite|crew|technician|field service)\b/.test(text)) return "outdoor_work";
  return "generic";
}

function inferPlannerActivity(text) {
  if (/\bstargaz|star[-\s]?gaz|\bsky[-\s]?watch|\bstars?\b|\bmeteor\b|\bnight\s+sky\b|\btelescope\b/.test(text)) return "stargazing";
  if (/\bdelivery|deliver|package|parcel|shipment|food order|takeout/.test(text)) return "delivery";
  if (/\bwear|clothing|clothes|outfit|jacket|umbrella/.test(text)) return "clothing";
  if (/\b(ac|a\/c|air\s*condition(?:er|ing)?|thermostat|hvac|cooling)\b/.test(text)) return "home cooling";
  if (/\btravel|drive|trip|commute|flight/.test(text)) return "travel";
  if (/\bpicnic|event|concert|festival|wedding|park|outdoor/.test(text)) return "outdoor_event";
  return null;
}

function localPlannerGoal(message, lens, retrievalMode) {
  if (retrievalMode === "rank_visible_points") return `Find the best visible map area for ${lens === "generic" ? "the user's weather-sensitive goal" : lens}.`;
  if (lens.includes("delivery")) return "Assess weather-related delivery disruption risk.";
  if (lens === "clothing") return "Choose practical clothing from forecast weather.";
  if (lens === "home_cooling") return "Assess weather-related home cooling demand and thermostat tradeoffs.";
  if (lens === "stargazing") return "Screen stargazing conditions from cloud cover, rain, wind, and alerts.";
  if (lens === "outdoor_work" || lens === "home_repair") return "Assess whether weather is suitable for exterior work from rain, wind, heat, humidity, and alerts.";
  return `Answer the weather-related question: ${String(message).slice(0, 160)}`;
}

function plannerTimeWindowFromMessage(message) {
  const text = String(message ?? "").toLowerCase();
  const delivery = extractDeliveryWindow(message);
  if (delivery) return { type: "hour", value: delivery.label.replace(/^today\s+/i, "").replace(/^tomorrow\s+/i, "") };
  if (/\btomorrow\b/.test(text)) return { type: "day", value: "tomorrow" };
  if (/\btoday|tonight|now\b/.test(text)) return { type: /\bnow\b/.test(text) ? "now" : "day", value: /\btonight\b/.test(text) ? "tonight" : "today" };
  if (/\bweekend\b/.test(text)) return { type: "range", value: "weekend" };
  const days = extractDayCount(text);
  if (days) return { type: "range", value: `next_${days}d` };
  return { type: "range", value: "default_next_4d" };
}

function hasExplicitPlanningWindow(message) {
  const text = String(message ?? "").toLowerCase();
  return Boolean(
    extractDeliveryWindow(message) ||
      /\b(now|today|tonight|tomorrow|morning|afternoon|evening|overnight|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(text) ||
      /\bnext\s+\d{1,2}\s+(?:day|days|night|nights|week|weeks)\b/.test(text) ||
      /\b\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)\b/.test(text)
  );
}

function mentionsMapContext(message) {
  return /\b(this|current|selected)\s+(?:map|area|region|location|place)|\bhere\b|\bnearby\b/i.test(String(message ?? ""));
}

function mentionsSearchScope(message) {
  return /\b(visible\s+(?:map|areas?|regions?|places?)|map\s+view|current\s+view|anywhere\s+(?:in\s+)?(?:the\s+)?(?:u\.?s\.?|united states)|nationwide|northeast|north\s*east|southeast|south\s*east|midwest|southwest|south\s*west|northwest|north\s*west|west coast|east coast|gulf coast|pacific northwest|pnw|rockies|mountain west|great lakes|new england|mid-atlantic|mid atlantic|southern california|northern california|socal|norcal)\b/i.test(
    String(message ?? "")
  );
}

function localRequiredFacts(lens, retrievalMode, locationCount) {
  const facts = [];
  const addDirect = (id, loc = locationCount ? 0 : null) => facts.push({ id, loc, source: "direct", compute: null });
  const locs = retrievalMode === "route" || retrievalMode === "compare_locations" ? [0, 1] : locationCount ? [0] : [];
  const perLoc = (id) => (locs.length ? locs.forEach((loc) => addDirect(id, loc)) : addDirect(id, null));
  if (lens === "stargazing") {
    ["cloud_cover", "precip_sum", "wind_speed", "alerts_active"].forEach(perLoc);
    facts.push({ id: "light_pollution", loc: null, source: "external", compute: null });
    facts.push({ id: "moon_phase", loc: null, source: "external", compute: null });
    return facts;
  }
  if (lens.includes("delivery")) {
    ["precip_sum", "wind_speed", "apparent_temp", "alerts_active"].forEach(perLoc);
    ["traffic_conditions", "courier_assignment", lens === "food_delivery" ? "restaurant_prep_status" : "package_tracking_status"].forEach((id) =>
      facts.push({ id, loc: null, source: "external", compute: null })
    );
    return facts;
  }
  if (lens === "clothing") ["temp_max", "temp_min", "apparent_temp", "precip_sum", "wind_speed", "humidity", "alerts_active"].forEach(perLoc);
  else if (lens === "home_cooling") {
    ["temp_max", "temp_min", "apparent_temp", "humidity", "cloud_cover", "cooling_degree_days", "alerts_active"].forEach(perLoc);
    ["home insulation", "HVAC system performance", "occupancy or pet needs", "utility rate plan"].forEach((id) => facts.push({ id, loc: null, source: "external", compute: null }));
  } else if (["outdoor_work", "home_repair", "field_work", "construction"].includes(lens)) ["temp_max", "apparent_temp", "precip_sum", "wind_speed", "humidity", "alerts_active"].forEach(perLoc);
  else ["temp_max", "temp_min", "apparent_temp", "precip_sum", "wind_speed", "alerts_active"].forEach(perLoc);
  return facts;
}

async function planAssistantQuestion(message, context) {
  const fallback = planAssistantQuestionLocally(message, context);
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    return sanitizeUnifiedPlan(await callOpenAiUnifiedPlanner(message, context), fallback);
  } catch {
    return fallback;
  }
}

function planAssistantQuestionLocally(message, context) {
  const application = enrichApplicationWithOntology(reasonAboutApplicationLocally(message, context));
  const interpretation = applyApplicationReasoning(interpretQuestionLocally(message), application);
  return { application, interpretation, answerMode: answerModeForApplication(application) };
}

async function callOpenAiUnifiedPlanner(message, context) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            `You are a strict planner for a bounded U.S. weather-impact dashboard assistant. Return one JSON plan only. Identify the real-world application and the weather query in one pass. Use ontology version ${ontologyVersion}. Keep claims bounded to connected dashboard evidence. For stargazing or sky-viewing requests, use applicationKind "stargazing" and require cloud cover, rain, wind, and alert evidence while marking light pollution, moon phase, smoke/haze, and astronomical seeing as missing. For route travel, extract origin and destination as separate locations. For delivery or operational outcomes, mark missing external systems. Do not answer the user and do not invent forecast facts.`
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              selectedLocation: context?.selected
                ? { name: context.selected.name, state: context.selected.state, lat: context.selected.lat, lon: context.selected.lon }
                : null,
              mapCenter: context?.map?.center ?? null,
              visiblePoints: Array.isArray(context?.visiblePoints) ? context.visiblePoints.slice(0, 8) : [],
              activeLayer: context?.activeLayer ?? null,
              ontology: {
                version: ontologyVersion,
                families: [
                  "weather_summary",
                  "comfort_and_clothing",
                  "sky_visibility",
                  "time_window_planning",
                  "travel_weather_decision",
                  "weather_sensitive_operations",
                  "dashboard_explanation",
                  "unsupported_or_out_of_scope"
                ]
              }
            },
            null,
            2
          )
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "weather_assistant_plan",
          strict: true,
          schema: unifiedPlannerSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function unifiedPlannerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["application", "interpretation", "answerMode"],
    properties: {
      application: applicationReasoningSchema(),
      interpretation: questionInterpretationSchema(),
      answerMode: {
        type: "string",
        enum: ["direct_answer", "partial_with_caveat", "followup_question", "dashboard_explainer", "scope_redirect"]
      }
    }
  };
}

function sanitizeUnifiedPlan(raw, fallback) {
  const application = enrichApplicationWithOntology(sanitizeApplicationReasoning(raw?.application, fallback.application));
  const interpretation = applyApplicationReasoning(sanitizeQuestionInterpretation(raw?.interpretation, fallback.interpretation), application);
  const modes = new Set(["direct_answer", "partial_with_caveat", "followup_question", "dashboard_explainer", "scope_redirect"]);
  return {
    application,
    interpretation,
    answerMode: modes.has(raw?.answerMode) ? raw.answerMode : answerModeForApplication(application)
  };
}

function enrichApplicationWithOntology(application) {
  const contract = ontologyContractForKind(application?.applicationKind);
  return {
    ...application,
    ontology: contract,
    requiredEvidence: [...new Set([...(application?.requiredEvidence ?? []), ...contract.dashboardEvidence])],
    externalMissingEvidence: [...new Set([...(application?.externalMissingEvidence ?? []), ...contract.externalMissingEvidence])],
    forbiddenClaims: [...new Set([...(application?.forbiddenClaims ?? []), ...contract.forbiddenClaims])],
    allowedClaim: application?.allowedClaim || contract.allowedClaims[0] || "weather-related context"
  };
}

function answerModeForApplication(application) {
  if (application?.answerabilityRecommendation === "needs_followup") return "followup_question";
  if (application?.answerabilityRecommendation === "partial" || application?.externalMissingEvidence?.length) return "partial_with_caveat";
  if (application?.applicationKind === "dashboard_explainer") return "dashboard_explainer";
  if (["out_of_scope", "unknown"].includes(application?.applicationKind)) return "scope_redirect";
  return "direct_answer";
}

async function reasonAboutApplication(message, context) {
  const fallback = reasonAboutApplicationLocally(message, context);
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    return sanitizeApplicationReasoning(await callOpenAiApplicationReasoner(message, context), fallback);
  } catch {
    return fallback;
  }
}

async function callOpenAiApplicationReasoner(message, context) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            "You are an application reasoner for a weather-impact dashboard. Identify the real-world application the user is asking about, the user's goal, needed evidence, dashboard-relevant weather evidence, missing external evidence, missing slots, and a concise follow-up if needed. Do not answer the user. Be flexible about applications: route/day-trip travel, food delivery, package delivery, outdoor events, stargazing/sky viewing, clothing/comfort, field crews, construction, retail, campus, commute, utilities, or another label. For stargazing, use cloud cover, rain, wind, and alerts; mark light pollution, moon phase, smoke/haze, and astronomical seeing as missing external evidence. For route travel, extract origin and destination as separate locations and mark traffic, crashes, road closures, construction delays, parking, transit, and border wait times as missing external evidence. Keep claims bounded to weather-related impacts from dashboard evidence."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              selectedLocation: context?.selected
                ? { name: context.selected.name, state: context.selected.state, lat: context.selected.lat, lon: context.selected.lon }
                : null,
              mapCenter: context?.map?.center ?? null,
              activeLayer: context?.activeLayer ?? null
            },
            null,
            2
          )
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "application_reasoning",
          strict: true,
          schema: applicationReasoningSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function applicationReasoningSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "applicationKind",
      "applicationLabel",
      "userGoal",
      "locations",
      "timeWindow",
      "missingSlots",
      "requiredEvidence",
      "dashboardRelevantEvidence",
      "externalMissingEvidence",
      "allowedClaim",
      "forbiddenClaims",
      "suggestedFollowup",
      "answerabilityRecommendation"
    ],
    properties: {
      applicationKind: {
        type: "string",
        enum: [
          "greeting",
          "general_weather",
          "food_delivery",
          "package_delivery",
          "general_delivery",
          "personal_comfort",
          "clothing_guidance",
          "travel_packing",
          "stargazing",
          "route_travel",
          "outdoor_event",
          "field_work",
          "construction",
          "commute_travel",
          "business_operations",
          "dashboard_explainer",
          "out_of_scope",
          "unknown"
        ]
      },
      applicationLabel: { type: "string" },
      userGoal: { type: "string" },
      locations: { type: "array", items: { type: "string" } },
      timeWindow: { type: ["string", "null"] },
      missingSlots: {
        type: "array",
        items: {
          type: "string",
          enum: ["location", "location_or_map_context", "origin", "destination", "time_window", "departure_time", "activity", "none"]
        }
      },
      requiredEvidence: { type: "array", items: { type: "string" } },
      dashboardRelevantEvidence: { type: "array", items: { type: "string" } },
      externalMissingEvidence: { type: "array", items: { type: "string" } },
      allowedClaim: { type: "string" },
      forbiddenClaims: { type: "array", items: { type: "string" } },
      suggestedFollowup: { type: ["string", "null"] },
      answerabilityRecommendation: {
        type: "string",
        enum: ["answerable", "partial", "needs_followup", "unsupported", "out_of_scope"]
      }
    }
  };
}

function reasonAboutApplicationLocally(message, context) {
  const text = String(message ?? "").toLowerCase();
  const location = extractLocation(message);
  const routeLocations = extractRouteLocations(message);
  const hasLocation = Boolean(location);
  const hasTime = Boolean(extractDeliveryWindow(message) || extractDaypart(text) || /\btoday|tomorrow|weekend|next\s+\d+\s+days?\b/.test(text));
  if (/^\s*(hi|hello|hey|yo|good morning|good afternoon|good evening)\s*[!.?]*\s*$/i.test(message)) {
    return {
      applicationKind: "greeting",
      applicationLabel: "Greeting",
      userGoal: `Start a friendly conversation with ${assistantName}.`,
      locations: [],
      timeWindow: null,
      missingSlots: [],
      requiredEvidence: [],
      dashboardRelevantEvidence: [],
      externalMissingEvidence: [],
      allowedClaim: "The assistant can explain what it can help with.",
      forbiddenClaims: [],
      suggestedFollowup:
        `Hi, I am ${assistantName}. I can help with weather for a place, alerts, outdoor plans, route weather, stargazing, clothing, or weather-related delivery risk. What would you like to check?`,
      answerabilityRecommendation: "answerable"
    };
  }
  const kind =
    routeLocations.length >= 2 || (/\b(travel|drive|driving|road\s*trip|commute|trip)\b/.test(text) && /\b(to|from|between)\b/.test(text))
      ? "route_travel"
      : /\b(stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|watch(?:ing)?\s+(?:the\s+)?stars?|stars?|meteor|night\s+sky|astronomy|telescope|clear\s+sky)\b/.test(text)
      ? "stargazing"
      : /\b(wear|clothing|clothes|dress|outfit|jacket|coat|sweater|hoodie|shorts|pants|umbrella|raincoat)\b/.test(text)
      ? "clothing_guidance"
      : /\b(pack|packing|suitcase|luggage)\b/.test(text) && /\b(weather|trip|travel|wear|clothes|rain|hot|cold)\b/.test(text)
        ? "travel_packing"
        : /\b(too hot|too cold|comfortable|comfort|feel like|heat)\b/.test(text) && /\b(weather|forecast|temperature|temp|outside|outdoor|week|today|tomorrow)\b/.test(text)
          ? "personal_comfort"
          : /\b(food|restaurant|doordash|uber\s*eats|ubereats|grubhub|takeout|meal|order)\b/.test(text) && /\b(delivery|deliver|delay|late|arriv)/.test(text)
      ? "food_delivery"
      : /\b(amazon|package|parcel|shipment|tracking)\b/.test(text) && /\b(delivery|deliver|delay|late|arriv|eta|tracking)\b/.test(text)
        ? "package_delivery"
        : /\b(delivery|deliver|courier)\b/.test(text) && /\b(delay|late|arriv|eta|delivered)\b/.test(text)
          ? "general_delivery"
          : /\b(picnic|event|concert|festival|wedding|park|outdoor)\b/.test(text)
            ? "outdoor_event"
            : /\b(construction|roof|roofing|crane|paving|jobsite|site work)\b/.test(text)
              ? "construction"
              : /\b(crew|technician|field service|repair|maintenance)\b/.test(text)
                ? "field_work"
                : /\b(weather|forecast|rain|wind|heat|storm|alert|temperature|today|tomorrow)\b/.test(text)
                  ? "general_weather"
                  : "unknown";
  const delivery = ["food_delivery", "package_delivery", "general_delivery"].includes(kind);
  const routeTravel = kind === "route_travel";
  const missingSlots = [];
  if (delivery && !hasLocation) missingSlots.push("location");
  if (delivery && !hasTime) missingSlots.push("time_window");
  if (routeTravel && routeLocations.length < 2) missingSlots.push("location");
  const labels = {
    food_delivery: "Food delivery weather-delay risk",
    package_delivery: "Package delivery weather-delay risk",
    general_delivery: "Delivery weather-delay risk",
    personal_comfort: "Personal weather comfort",
    clothing_guidance: "Clothing guidance",
    travel_packing: "Weather-aware packing",
    stargazing: "Stargazing weather screening",
    route_travel: "Point-to-point travel weather",
    outdoor_event: "Outdoor planning",
    construction: "Construction weather exposure",
    field_work: "Field work weather exposure",
    general_weather: "General weather",
    unknown: "Unknown application"
  };
  return {
    applicationKind: kind,
    applicationLabel: labels[kind] ?? "Weather-impact question",
    userGoal: delivery
      ? "Understand whether weather could make a delivery more likely to be delayed."
      : kind === "clothing_guidance"
        ? "Choose practical clothing from the forecast temperature, rain, wind, humidity, and alert signals."
        : kind === "travel_packing"
          ? "Choose practical weather-aware packing items from the forecast signals."
          : kind === "stargazing"
            ? "Screen nearby places for stargazing-friendly weather using cloud cover, rain, wind, and alert signals."
          : kind === "route_travel"
            ? "Understand whether weather makes a trip between two places reasonable, while excluding traffic and road operations data."
          : kind === "personal_comfort"
            ? "Understand whether the forecast will feel hot, cold, rainy, windy, or comfortable."
            : "Understand weather impact from dashboard signals.",
    locations: routeLocations.length ? routeLocations : location ? [location] : [],
    timeWindow: hasTime ? "provided or implied" : null,
    missingSlots,
    requiredEvidence: delivery
      ? ["location", "time_window", "rain", "wind", "heat", "active alerts", ...deliveryExternalEvidence(kind)]
      : routeTravel
        ? ["origin", "destination", "weather forecast near route endpoints", "rain", "wind", "heat", "active alerts", ...routeExternalEvidence()]
      : kind === "stargazing"
        ? ["location or map context", "cloud cover", "rain", "wind", "active alerts"]
      : ["location or map context", "temperature high/low", "apparent temperature", "rain", "wind", "humidity when available", "active alerts"],
    dashboardRelevantEvidence:
      kind === "stargazing"
        ? ["cloud cover", "rain", "wind", "active alerts"]
        : ["temperature high/low", "apparent temperature", "rain", "wind", "humidity", "active alerts"],
    externalMissingEvidence:
      delivery
        ? deliveryExternalEvidence(kind)
        : routeTravel
          ? routeExternalEvidence()
          : kind === "stargazing"
            ? ["light pollution", "moon phase", "smoke or haze", "local horizon obstruction"]
            : [],
    allowedClaim: delivery
      ? `${deliveryPhrase(kind)} weather-related delay risk`
      : ["clothing_guidance", "travel_packing", "personal_comfort"].includes(kind)
        ? "practical comfort and clothing guidance from forecast signals"
        : kind === "stargazing"
          ? "stargazing weather screening from cloud cover, rain, wind, and alerts"
        : routeTravel
          ? "weather-related travel practicality for the route endpoints and approximate corridor"
        : "weather-related planning context",
    forbiddenClaims: delivery ? deliveryForbiddenClaims(kind) : routeTravel ? routeForbiddenClaims() : [],
    suggestedFollowup: delivery && !hasLocation
      ? `Sure, I can help with the weather side of that. What city or area is the ${deliveryNoun(kind)} for?`
      : delivery && !hasTime
        ? `What ${deliveryNoun(kind)} window are you expecting: morning, afternoon, evening, or a rough time?`
        : routeTravel && routeLocations.length < 2
          ? "Sure, I can help with the weather side of that trip. What origin and destination should I check?"
        : null,
    answerabilityRecommendation: missingSlots.length ? "needs_followup" : delivery || routeTravel ? "partial" : kind === "unknown" ? "out_of_scope" : "answerable"
  };
}

function sanitizeApplicationReasoning(raw, fallback) {
  const kinds = new Set([
    "greeting",
    "general_weather",
    "food_delivery",
    "package_delivery",
    "general_delivery",
    "personal_comfort",
    "clothing_guidance",
    "travel_packing",
    "stargazing",
    "route_travel",
    "outdoor_event",
    "field_work",
    "construction",
    "commute_travel",
    "business_operations",
    "dashboard_explainer",
    "out_of_scope",
    "unknown"
  ]);
  const recs = new Set(["answerable", "partial", "needs_followup", "unsupported", "out_of_scope"]);
  const slots = new Set(["location", "location_or_map_context", "origin", "destination", "time_window", "departure_time", "activity", "none"]);
  return {
    applicationKind: kinds.has(raw?.applicationKind) ? raw.applicationKind : fallback.applicationKind,
    applicationLabel: stringOr(raw?.applicationLabel, fallback.applicationLabel, 120),
    userGoal: stringOr(raw?.userGoal, fallback.userGoal, 240),
    locations: sanitizeStringList(raw?.locations, fallback.locations, 4, 100).map(cleanLocationCandidate).filter(Boolean),
    timeWindow: typeof raw?.timeWindow === "string" && raw.timeWindow.trim() ? raw.timeWindow.trim().slice(0, 120) : fallback.timeWindow,
    missingSlots: sanitizeStringList(raw?.missingSlots, fallback.missingSlots, 4, 40).filter((slot) => slots.has(slot)),
    requiredEvidence: sanitizeStringList(raw?.requiredEvidence, fallback.requiredEvidence, 10, 100),
    dashboardRelevantEvidence: sanitizeStringList(raw?.dashboardRelevantEvidence, fallback.dashboardRelevantEvidence, 10, 100),
    externalMissingEvidence: sanitizeStringList(raw?.externalMissingEvidence, fallback.externalMissingEvidence, 10, 120),
    allowedClaim: stringOr(raw?.allowedClaim, fallback.allowedClaim, 180),
    forbiddenClaims: sanitizeStringList(raw?.forbiddenClaims, fallback.forbiddenClaims, 10, 120),
    suggestedFollowup: typeof raw?.suggestedFollowup === "string" && raw.suggestedFollowup.trim() ? raw.suggestedFollowup.trim().slice(0, 220) : fallback.suggestedFollowup,
    answerabilityRecommendation: recs.has(raw?.answerabilityRecommendation) ? raw.answerabilityRecommendation : fallback.answerabilityRecommendation
  };
}

function applyApplicationReasoning(interpretation, application) {
  const locations = Array.isArray(application?.locations) ? application.locations.filter(Boolean) : [];
  const location = interpretation.location ?? locations[0] ?? null;
  const delivery = isDeliveryApplication(application);
  const routeTravel = isRouteApplication(application);
  return {
    ...interpretation,
    location,
    locations: routeTravel
      ? locations.slice(0, 4)
      : location
        ? [location, ...(interpretation.locations ?? []).filter((item) => item !== location)].slice(0, 4)
        : interpretation.locations,
    questionFamily: delivery ? "business_weather_exposure" : routeTravel ? "route_travel" : interpretation.questionFamily,
    scopeClass:
      delivery && application?.answerabilityRecommendation === "needs_followup"
        ? "needs_followup"
        : delivery || routeTravel
          ? "in_scope_partial_business"
          : interpretation.scopeClass,
    businessPersona: delivery ? "logistics_last_mile" : interpretation.businessPersona,
    businessObjective: delivery || routeTravel ? application.allowedClaim : interpretation.businessObjective,
    missingData: [...new Set([...(interpretation.missingData ?? []), ...(application?.externalMissingEvidence ?? [])])],
    requiredData: [...new Set([...(interpretation.requiredData ?? []), ...(application?.requiredEvidence ?? [])])],
    availableData: [...new Set([...(interpretation.availableData ?? []), ...(application?.dashboardRelevantEvidence ?? [])])],
    answerability: delivery || routeTravel ? "answerable_partially" : interpretation.answerability,
    requiresFollowup: Boolean(interpretation.requiresFollowup || application?.answerabilityRecommendation === "needs_followup"),
    followupQuestion: interpretation.followupQuestion ?? application?.suggestedFollowup ?? null
  };
}

function conversationalResponse(application) {
  return {
    answer:
      application.suggestedFollowup ||
      `Hi, I am ${assistantName}. I can help with weather for a city, alerts, outdoor plans, route weather, stargazing, clothing, or weather-related delivery risk. What would you like to check?`,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: [],
    dataUsed: ["Conversation"],
    guardrailNote: `Friendly greeting within ${assistantName}'s weather-dashboard scope.`,
    actions: [],
    answerType: "greeting",
    persona: "General planning",
    capabilityNote: "Ask about a place, time window, alert, map area, or weather-sensitive activity.",
    missingData: []
  };
}

function applicationLocationFollowupResponse(application) {
  const question =
    application.suggestedFollowup ||
    (isRouteApplication(application)
      ? "Sure, I can help with the weather side of that trip. What origin and destination should I check?"
      : `Sure, I can help with the weather side of that. What city or area is the ${deliveryNoun(application.applicationKind)} for?`);
  return {
    answer: question,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: [isRouteApplication(application) ? "Origin and destination are needed before I can compare route weather." : "Location is needed before I can check local forecast and alert signals."],
    dataUsed: ["Application reasoner"],
    guardrailNote: "Ask for only the missing information needed to answer from dashboard evidence.",
    actions: [],
    answerType: "needs_followup",
    persona: isDeliveryApplication(application) ? "Logistics / last-mile operations" : "General planning",
    capabilityNote: isRouteApplication(application) ? "I need both endpoints before checking trip weather." : "I need the location before checking weather-related risk.",
    missingData: isRouteApplication(application) ? ["Origin", "Destination"] : ["Location"]
  };
}

function shouldAskApplicationLocation(application, explicitLocation) {
  if (isRouteApplication(application)) return routeLocationsFromApplication(application, "").length < 2;
  return isDeliveryApplication(application) && !explicitLocation && application?.missingSlots?.includes("location");
}

function applicationFromPlannerPlan(plan) {
  const kind = applicationKindFromPlanner(plan);
  const external = [...new Set((plan.requiredFacts ?? []).filter((fact) => fact.source === "external").map((fact) => fact.id))];
  const pending = plan.pendingFacts ?? [];
  return enrichApplicationWithOntology({
    applicationKind: kind,
    applicationLabel: plannerLabelForKind(kind, plan),
    userGoal: plan.goal,
    locations: (plan.locations ?? []).filter((loc) => loc.raw !== "context").map((loc) => loc.raw),
    timeWindow: plan.timeWindow?.value || null,
    missingSlots: pending,
    requiredEvidence: (plan.requiredFacts ?? []).map((fact) => fact.id),
    dashboardRelevantEvidence: (plan.requiredFacts ?? []).filter((fact) => fact.source !== "external").map((fact) => fact.id),
    externalMissingEvidence: external,
    allowedClaim: allowedClaimForPlanner(kind, plan),
    forbiddenClaims: forbiddenClaimsForPlanner(kind),
    suggestedFollowup: followupQuestionForPlan(plan),
    answerabilityRecommendation:
      pending.length ? "needs_followup" : external.length || ["route_travel", "food_delivery", "package_delivery", "general_delivery", "stargazing"].includes(kind) ? "partial" : "answerable"
  });
}

function interpretationFromPlannerPlan(message, plan, semantic = null) {
  const location = plannerPrimaryLocation(plan);
  const locations = (plan.locations ?? []).filter((loc) => loc.raw !== "context").map((loc) => loc.raw);
  const kind = applicationKindFromPlanner(plan);
  const partial = (plan.requiredFacts ?? []).some((fact) => fact.source === "external");
  return {
    intent:
      plan.retrievalMode === "rank_visible_points" || plan.retrievalMode === "compare_locations"
        ? "compare_locations"
        : kind === "dashboard_explainer"
          ? "risk_explanation"
          : plan.activity || plan.lens !== "generic"
            ? "event_planning"
            : "weather_summary",
    questionFamily:
      kind === "route_travel"
        ? "route_travel"
        : isDeliveryApplication(kind)
          ? "business_weather_exposure"
          : kind === "dashboard_explainer"
            ? "dashboard_explainer"
            : "weather_summary",
    inScope: plan.domain !== "not_weather_related",
    scopeClass: partial ? "in_scope_partial_business" : "in_scope_weather",
    location,
    locations,
    timeRangeDays: plannerDayCount(plan.timeWindow),
    startDayOffset: plannerStartDayOffset(plan.timeWindow),
    daypart: plannerDaypart(plan.timeWindow),
    activity: plan.activity ?? semantic?.activity ?? plan.lens,
    businessPersona: isDeliveryApplication(kind) ? "logistics_last_mile" : localBusinessPersona(String(message).toLowerCase()),
    businessObjective: allowedClaimForPlanner(kind, plan),
    asksForComparison: ["rank_visible_points", "compare_locations"].includes(plan.retrievalMode),
    asksForExplanation: /\bwhy|explain|meaning|what\s+does\b/i.test(message),
    asksForPrediction: true,
    requiredData: (plan.requiredFacts ?? []).map((fact) => fact.id),
    availableData: (plan.requiredFacts ?? []).filter((fact) => fact.source !== "external").map((fact) => fact.id),
    missingData: (plan.requiredFacts ?? []).filter((fact) => fact.source === "external").map((fact) => fact.id),
    answerability: partial ? "answerable_partially" : "answerable_now",
    needsMapMove: plan.retrievalMode !== "none",
    safetySensitive: (plan.safetyFlags ?? []).length > 0,
    requiresFollowup: (plan.pendingFacts ?? []).length > 0,
    followupQuestion: followupQuestionForPlan(plan),
    normalizedQuestion: message,
    userFriendlyGoal: plan.goal
  };
}

function applicationKindFromPlanner(plan) {
  const lens = String(plan?.lens ?? "").toLowerCase();
  const activity = String(plan?.activity ?? "").toLowerCase();
  const goal = String(plan?.goal ?? "").toLowerCase();
  const text = `${lens} ${activity} ${goal}`;
  if (plan?.retrievalMode === "route" || /\broute|drive|trip|travel from|commute\b/.test(text)) return "route_travel";
  if (/\bfood.*delivery|restaurant|doordash|ubereats|uber eats|grubhub|takeout\b/.test(text)) return "food_delivery";
  if (/\bpackage|amazon|parcel|shipment|tracking\b/.test(text)) return "package_delivery";
  if (/\bdelivery|courier\b/.test(text)) return "general_delivery";
  if (/\bstargaz|star gaz|sky|meteor|telescope|astronomy\b/.test(text)) return "stargazing";
  if (/\bclothing|wear|outfit|packing\b/.test(text)) return lens.includes("pack") ? "travel_packing" : "clothing_guidance";
  if (/\bhome_cooling|home cooling|ac|a\/c|air conditioning|thermostat|hvac|cooling demand\b/.test(text)) return "home_hvac";
  if (/\boutdoor_work|home_repair|repair|exterior|construction|jobsite|roof|crane|paint|siding|gutter|ladder\b/.test(text)) return "construction";
  if (/\bfield|crew|technician|maintenance\b/.test(text)) return "field_work";
  if (/\bexplain|dashboard|layer|score|alert meaning\b/.test(text)) return "dashboard_explainer";
  if (/\bevent|outdoor|picnic|park|wedding|festival|concert\b/.test(text)) return "outdoor_event";
  return "general_weather";
}

function plannerLabelForKind(kind, plan) {
  const labels = {
    food_delivery: "Food delivery weather-delay risk",
    package_delivery: "Package delivery weather-delay risk",
    general_delivery: "Delivery weather-delay risk",
    stargazing: "Stargazing weather screening",
    clothing_guidance: "Clothing guidance",
    travel_packing: "Weather-aware packing",
    home_hvac: "Home cooling weather guidance",
    route_travel: "Point-to-point travel weather",
    construction: "Construction weather exposure",
    field_work: "Field work weather exposure",
    outdoor_event: "Outdoor planning",
    dashboard_explainer: "Dashboard explanation",
    general_weather: "General weather"
  };
  return labels[kind] ?? plan?.lens ?? "Weather question";
}

function allowedClaimForPlanner(kind, plan) {
  if (isDeliveryApplication(kind)) return `${deliveryPhrase(kind)} weather-related delay risk`;
  if (kind === "route_travel") return "weather-related travel practicality for the route endpoints and approximate corridor";
  if (kind === "stargazing") return "stargazing weather screening from cloud cover, rain, wind, and alerts";
  if (kind === "home_hvac") return "weather-related home cooling demand and thermostat tradeoffs";
  if (["clothing_guidance", "travel_packing", "personal_comfort"].includes(kind)) return "practical comfort and clothing guidance from forecast signals";
  return plan?.goal ?? "weather-related planning context";
}

function forbiddenClaimsForPlanner(kind) {
  if (isDeliveryApplication(kind)) return deliveryForbiddenClaims(kind);
  if (kind === "route_travel") return routeForbiddenClaims();
  if (kind === "stargazing") return ["dark-sky guarantee", "moon phase", "smoke or haze", "astronomical seeing", "exact cloud timing"];
  if (kind === "home_hvac") return ["exact thermostat setting", "energy bill impact", "HVAC performance", "indoor comfort guarantee"];
  return [];
}

function followupQuestionForPlan(plan) {
  const pending = plan?.pendingFacts ?? [];
  if (!pending.length) return null;
  const lens = String(plan?.lens ?? "").toLowerCase();
  if (pending.includes("location") && pending.includes("time_window") && lens.includes("delivery")) {
    return "Sure, I can estimate the weather-related delivery risk. What city and state is it for, and what day/time window should I check?";
  }
  if (pending.includes("location")) return `${assistantName} can help with the weather side of that. What city, state, or map area should I check?`;
  if (pending.includes("origin") || pending.includes("destination")) return `I can help with the weather side of that trip. What origin and destination should I check?`;
  if (pending.includes("search_scope") && pending.includes("time_window")) {
    return "I can scout that. Should I search the current map view, a city/state, or a U.S. region like the Northeast or Southwest? Also, what time window should I use?";
  }
  if (pending.includes("search_scope")) {
    return "Should I search the current map view, a city/state, or a U.S. region like the Northeast or Southwest?";
  }
  if (pending.includes("time_window") && lens === "stargazing") {
    return "I can scout stargazing weather from cloud cover, rain, wind, and alerts. What night should I check: tonight, tomorrow night, this weekend, or a date range?";
  }
  if (pending.includes("time_window") && lens.includes("delivery")) {
    return "Sure, I can estimate the weather-related delivery risk. What day and delivery window should I check: today evening, tomorrow morning, or a rough time like 5 PM?";
  }
  if (pending.includes("time_window")) return "What time window should I check: morning, afternoon, evening, tonight, or a rough time like 5 PM?";
  return `What should I use for ${pending[0].replace(/_/g, " ")}?`;
}

function plannerPrimaryLocation(plan) {
  const candidates = Array.isArray(plan?.locations) ? plan.locations : [];
  const single = candidates.find((loc) => loc.role === "single" && loc.raw !== "context");
  if (single) return single.raw;
  const comparison = candidates.find((loc) => loc.role === "comparison" && loc.raw !== "context");
  if (comparison) return comparison.raw;
  const any = candidates.find((loc) => loc.raw !== "context");
  return any?.raw ?? null;
}

async function resolvePlannerTarget(plan, explicitLocation, selected, center, context) {
  if (plan.retrievalMode === "selected_region" || (plan.locations ?? []).some((loc) => loc.raw === "context" && selected)) {
    return resolveAssistantTarget(null, selected, null, context);
  }
  if (plan.retrievalMode === "map_center" || (plan.locations ?? []).some((loc) => loc.raw === "context")) {
    return resolveAssistantTarget(null, null, center, context);
  }
  if (explicitLocation) return resolveAssistantTarget(explicitLocation, selected, center, context);
  return resolveAssistantTarget(null, selected, center, context);
}

function plannerDayCount(timeWindow) {
  const value = String(timeWindow?.value ?? "").toLowerCase();
  const match = value.match(/next_(\d+)d/);
  if (match) return Math.max(1, Math.min(16, Number(match[1])));
  if (value === "weekend") return 3;
  if (["today", "tomorrow", "tonight"].includes(value)) return 1;
  return null;
}

function plannerStartDayOffset(timeWindow) {
  const value = String(timeWindow?.value ?? "").toLowerCase();
  if (value.includes("tomorrow")) return 1;
  return 0;
}

function plannerDaypart(timeWindow) {
  const value = String(timeWindow?.value ?? "").toLowerCase();
  if (/morning|am/.test(value)) return "morning";
  if (/afternoon|pm/.test(value)) return "afternoon";
  if (/evening|tonight/.test(value)) return "evening";
  if (/overnight|night/.test(value)) return "overnight";
  return null;
}

function isDeliveryApplication(applicationOrKind) {
  const kind = typeof applicationOrKind === "string" ? applicationOrKind : applicationOrKind?.applicationKind;
  return ["food_delivery", "package_delivery", "general_delivery"].includes(kind);
}

function isRouteApplication(applicationOrKind) {
  const kind = typeof applicationOrKind === "string" ? applicationOrKind : applicationOrKind?.applicationKind;
  if (kind === "route_travel") return true;
  return kind === "commute_travel" && Array.isArray(applicationOrKind?.locations) && applicationOrKind.locations.length >= 2;
}

function routeExternalEvidence() {
  return ["traffic", "crashes", "road closures", "construction delays", "parking availability", "transit or border wait times"];
}

function routeForbiddenClaims() {
  return ["actual travel time", "traffic delay", "road closure status", "crash status", "parking availability", "border wait time"];
}

function deliveryExternalEvidence(kind) {
  if (kind === "food_delivery") return ["restaurant prep status", "courier assignment", "platform backlog", "traffic"];
  if (kind === "package_delivery") return ["package tracking", "carrier route", "stop sequence", "traffic", "delivery-network status"];
  return ["courier route", "driver assignment", "traffic", "delivery-platform status"];
}

function deliveryForbiddenClaims(kind) {
  if (kind === "food_delivery") return ["actual food-delivery ETA", "restaurant prep delay", "courier assignment", "platform backlog"];
  if (kind === "package_delivery") return ["actual package ETA", "tracking status", "carrier route status", "delivery-network delay"];
  return ["actual delivery ETA", "driver assignment", "route status", "platform backlog"];
}

function deliveryMissingPlain(kind) {
  if (kind === "food_delivery") return "restaurant prep status, courier assignment, platform backlog, or traffic data";
  if (kind === "package_delivery") return "package tracking, carrier route, stop sequence, traffic, or delivery-network status";
  return "courier route, driver assignment, traffic, or delivery-platform status";
}

function deliveryPhrase(kind) {
  if (kind === "food_delivery") return "food delivery";
  if (kind === "package_delivery") return "package delivery";
  return "delivery";
}

const searchScopeStateGroups = {
  northeast: new Set(["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"]),
  southeast: new Set(["DE", "MD", "DC", "VA", "WV", "KY", "TN", "NC", "SC", "GA", "FL", "AL", "MS", "AR", "LA"]),
  midwest: new Set(["OH", "MI", "IN", "IL", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"]),
  southwest: new Set(["AZ", "NM", "NV", "UT", "CO", "TX", "OK"]),
  northwest: new Set(["WA", "OR", "ID", "MT", "WY"]),
  west_coast: new Set(["CA", "OR", "WA"]),
  east_coast: new Set(["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "DE", "MD", "DC", "VA", "NC", "SC", "GA", "FL"]),
  great_lakes: new Set(["MN", "WI", "IL", "IN", "MI", "OH", "PA", "NY"]),
  new_england: new Set(["ME", "NH", "VT", "MA", "RI", "CT"]),
  mid_atlantic: new Set(["NY", "NJ", "PA", "DE", "MD", "DC", "VA", "WV"]),
  mountain_west: new Set(["MT", "ID", "WY", "NV", "UT", "CO", "AZ", "NM"]),
  gulf_coast: new Set(["TX", "LA", "MS", "AL", "FL"]),
  california: new Set(["CA"])
};

function filterCandidatesBySearchScope(candidates, scopeText) {
  const scope = searchScopeKey(scopeText);
  if (!scope) return candidates;
  const states = searchScopeStateGroups[scope];
  if (!states) return candidates;
  return candidates.filter((candidate) => {
    const state = stateFromCandidateLabel(candidate.label);
    return state ? states.has(state) : false;
  });
}

function searchScopeKey(value) {
  let text = String(value ?? "").toLowerCase();
  const followupMarker = "search scope follow-up:";
  const markerIndex = text.lastIndexOf(followupMarker);
  if (markerIndex >= 0) text = text.slice(markerIndex + followupMarker.length);
  if (/\b(current|visible|map view|this map|anywhere|nationwide|united states|u\.?s\.?)\b/.test(text)) return null;
  if (/\bnew england\b/.test(text)) return "new_england";
  if (/\bmid[-\s]?atlantic\b/.test(text)) return "mid_atlantic";
  if (/\bgreat lakes\b/.test(text)) return "great_lakes";
  if (/\bmountain west|rockies\b/.test(text)) return "mountain_west";
  if (/\bgulf coast\b/.test(text)) return "gulf_coast";
  if (/\bwest coast\b/.test(text)) return "west_coast";
  if (/\beast coast\b/.test(text)) return "east_coast";
  if (/\bpacific northwest|\bpnw\b/.test(text)) return "northwest";
  if (/\bnortheast|north east\b/.test(text)) return "northeast";
  if (/\bsoutheast|south east\b/.test(text)) return "southeast";
  if (/\bmidwest\b/.test(text)) return "midwest";
  if (/\bsouthwest|south west\b/.test(text)) return "southwest";
  if (/\bnorthwest|north west\b/.test(text)) return "northwest";
  if (/\bnorthern california|norcal|southern california|socal|california\b/.test(text)) return "california";
  return null;
}

function stateFromCandidateLabel(label) {
  const match = String(label ?? "").match(/,\s*([A-Z]{2})\b/);
  return match?.[1] ?? null;
}

function deliveryNoun(kind) {
  if (kind === "food_delivery") return "food delivery";
  if (kind === "package_delivery") return "package delivery";
  return "delivery";
}

function capitalize(value) {
  const text = String(value ?? "");
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function lowerFirst(value) {
  const text = String(value ?? "");
  if (/^I\b/.test(text)) return text;
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
}

function stringOr(value, fallback, maxLen) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLen) : fallback;
}

function unresolvedLocationResponse(locationText) {
  return {
    answer: `I can help with that, but I could not confidently resolve "${locationText}" to a U.S. location. Tell me the city and state, like "Houston, TX" or "Seattle, WA", and I will scout the right patch of weather.`,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: ["Location could not be geocoded."],
    dataUsed: ["Geocoding guardrail"],
    guardrailNote: `${assistantName} does not guess at unresolved locations.`,
    actions: [],
    answerType: "needs_followup",
    persona: "General planning",
    capabilityNote: `${assistantName} needs a resolvable U.S. location before it can fetch local forecast facts.`,
    missingData: ["Resolvable U.S. location"]
  };
}

function plannerOutOfScopeResponse(plan) {
  return {
    answer:
      `${assistantName} is built for this weather dashboard, so I cannot answer that one cleanly. I can help with forecasts, alerts, outdoor timing, clothing, route weather, stargazing, delivery weather risk, or map regions.`,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: [plan.goal || "Question is not about the weather dashboard."],
    dataUsed: ["Planner guardrail"],
    guardrailNote: `${assistantName} scope only: weather, dashboard, and weather-impact planning.`,
    actions: [],
    answerType: "out_of_domain",
    persona: "General planning",
    capabilityNote: `${assistantName} is scoped to weather, dashboard, and weather-related planning questions.`,
    missingData: []
  };
}

function plannerFollowupResponse(message, plan, context) {
  const question = followupQuestionForPlan(plan) ?? "I can help with that. What missing detail should I use?";
  return {
    answer: question,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: plan.pendingFacts.map((fact) => `${fact.replace(/_/g, " ")} is needed before ${assistantName} can answer from the dashboard.`),
    dataUsed: ["Planner follow-up"],
    guardrailNote: "Ask for only the missing user-supplied facts needed to answer.",
    actions: [],
    answerType: "needs_followup",
    persona: plan.lens && plan.lens !== "generic" ? plan.lens.replace(/_/g, " ") : "General planning",
    capabilityNote: `${assistantName} needs ${plan.pendingFacts.map((fact) => fact.replace(/_/g, " ")).join(" and ")} before checking the forecast.`,
    missingData: plan.pendingFacts,
    conversationState: {
      plannerPlan: plan,
      pendingFacts: plan.pendingFacts,
      originalQuestion: message,
      questionFamily: plan.lens ?? null,
      persona: plan.lens ?? null,
      businessObjective: plan.goal ?? null
    }
  };
}

function dashboardLayerExplanationResponse(message, context, plan, semantic, selected, center) {
  const text = String(message ?? "").toLowerCase();
  const requestedLayer = normalizeLayerId(semantic?.requestedLayer) ?? layerFromPlan(plan) ?? normalizeLayerId(context?.activeLayer?.id);
  const wantsExplain = /\b(explain|why|what\s+does|risk|score|this area|area's|areas?)\b/.test(text);
  if (!requestedLayer || !wantsExplain) return null;
  if (plan?.retrievalMode === "rank_visible_points" && /\b(which|where|highest|lowest|rank|compare|region|place|location)\b/.test(text)) return null;
  const target = contextLayerPoint(context, selected, center);
  if (!target) return null;
  const layers = target.layers ?? {};
  const value = numberOrNull(layers[requestedLayer]);
  const drivers = layerDriverLines(layers, requestedLayer);
  const label = target.label || "this map area";
  const layerName = layerLabel(requestedLayer);
  const valueText = value == null ? "limited data" : formatLayerValue(requestedLayer, value);
  const answer =
    requestedLayer === "risk"
      ? `${label}'s forecast stress is ${valueText}. The biggest dashboard drivers I can see are ${drivers.join(", ")}. This is a dashboard weather-stress read, not an emergency forecast or business-loss estimate.`
      : `${label}'s ${layerName.toLowerCase()} signal is ${valueText}. I am using the dashboard's transmitted layer value for this area, with nearby drivers like ${drivers.join(", ")}.`;
  return {
    answer,
    verdict: value == null ? "insufficient_data" : value >= 70 ? "avoid" : value >= 45 ? "marginal" : "good",
    confidence: value == null ? "low" : "medium",
    bestWindows: [],
    risks: drivers.map((driver) => capitalize(driver)).slice(0, 3),
    dataUsed: ["Dashboard layer context", "Selected or nearest visible region"],
    guardrailNote: "Dashboard-layer explanation only; not operational safety guidance.",
    actions: target.lat != null && target.lon != null ? [{ type: "flyTo", lat: target.lat, lon: target.lon, zoom: 7, label }] : [],
    answerType: "in_scope_dashboard_explainer",
    persona: "General planning",
    capabilityNote: "This explains the dashboard layer values for the selected/current map area.",
    missingData: []
  };
}

function layerFromPlan(plan) {
  const fact = (plan?.requiredFacts ?? []).find((item) => typeof item?.id === "string" && item.id.startsWith("layer_"));
  return fact ? normalizeLayerId(fact.id.replace(/^layer_/, "")) : null;
}

function contextLayerPoint(context, selected, center) {
  if (selected) {
    return {
      label: [selected.name, selected.state].filter(Boolean).join(", ") || "selected region",
      lat: Number(selected.lat),
      lon: Number(selected.lon),
      layers: coerceLayerValues(selected.layers, { risk: selected.score })
    };
  }
  const nearest = nearestVisiblePoint(context, center ?? context?.map?.center);
  if (nearest) {
    return {
      label: [nearest.name, nearest.state].filter(Boolean).join(", ") || "nearest visible region",
      lat: Number(nearest.lat),
      lon: Number(nearest.lon),
      layers: coerceLayerValues(nearest.layers, { risk: nearest.score })
    };
  }
  return null;
}

function coerceLayerValues(value, fallback = {}) {
  const source = value && typeof value === "object" ? value : fallback;
  const result = {};
  for (const id of ["risk", "fire", "heat", "temp", "wind", "humidity", "cloud", "cdd"]) {
    const direct = numberOrNull(source?.[id]);
    const suffixed = numberOrNull(source?.[`${id}S`]);
    const n = direct ?? (["risk", "fire", "wind"].includes(id) && suffixed != null && suffixed <= 1 ? suffixed * 100 : suffixed);
    if (n != null) result[id] = n;
  }
  if (result.risk == null && numberOrNull(source?.score) != null) result.risk = numberOrNull(source.score);
  if (result.risk == null && numberOrNull(fallback?.risk) != null) result.risk = numberOrNull(fallback.risk);
  if (result.risk == null && numberOrNull(fallback?.score) != null) result.risk = numberOrNull(fallback.score);
  return result;
}

function layerDriverLines(layers, requestedLayer) {
  const candidates = [
    ["fire", "fire weather", layers?.fire],
    ["heat", "heat", layers?.heat],
    ["wind", "wind", layers?.wind],
    ["humidity", "humidity", layers?.humidity],
    ["cloud", "cloud cover", layers?.cloud],
    ["cdd", "cooling demand", layers?.cdd]
  ]
    .filter(([id, , value]) => id !== requestedLayer && numberOrNull(value) != null)
    .sort((a, b) => normalizedLayerPressure(String(b[0]), Number(b[2])) - normalizedLayerPressure(String(a[0]), Number(a[2])))
    .slice(0, 3)
    .map(([id, label, value]) => `${label} ${formatLayerValue(String(id), Number(value))}`);
  return candidates.length ? candidates : ["limited supporting layer data"];
}

function normalizedLayerPressure(id, value) {
  if (["fire", "risk"].includes(id)) return value;
  if (id === "heat" || id === "temp") return Math.max(0, Math.min(100, ((value - 60) / 45) * 100));
  if (id === "wind") return Math.max(0, Math.min(100, (value / 45) * 100));
  if (id === "humidity") return Math.max(0, Math.min(100, 100 - value));
  if (id === "cloud") return value;
  if (id === "cdd") return Math.max(0, Math.min(100, (value / 120) * 100));
  return value;
}

async function handleDeliveryTimeFollowup(message, context, state) {
  const application = reasonAboutApplicationLocally(state.originalQuestion || message, context);
  const window = extractDeliveryWindow(message);
  if (!window) {
    return {
      answer:
        "I can check the weather-related delivery risk, but I still need the expected delivery window. A rough answer is fine: morning, afternoon, evening, or something like 5 PM today.",
      verdict: "insufficient_data",
      confidence: "high",
      bestWindows: [],
      risks: ["Expected delivery window is missing."],
      dataUsed: ["Conversation follow-up"],
      guardrailNote: "The assistant asks for timing only when it changes the weather-risk answer.",
      actions: [],
      answerType: "needs_followup",
      persona: state.persona ?? "Logistics / last-mile operations",
      capabilityNote: "I need a delivery window before comparing weather alerts against the expected delivery time.",
      missingData: ["Expected delivery window"],
      conversationState: state
    };
  }

  const selected = context?.selected && typeof context.selected === "object" ? context.selected : null;
  const center = context?.map?.center && typeof context.map.center === "object" ? context.map.center : null;
  const followupLocation = extractLocation(message);
  const target = followupLocation ? await resolveAssistantTarget(followupLocation, selected, center, context) : targetFromConversationState(state, context);
  if (!target) return unresolvedLocationResponse(state.locationLabel ?? "that delivery location");
  const originalQuestion = state.originalQuestion ?? "Will my delivery be delayed?";
  const interpretation = {
    intent: "weather_summary",
    questionFamily: "business_weather_exposure",
    inScope: true,
    scopeClass: "in_scope_partial_business",
    location: state.locationLabel ?? null,
    locations: state.locationLabel ? [state.locationLabel] : [],
    timeRangeDays: window.dayOffset === 1 ? 1 : null,
    daypart: window.daypart,
    activity: deliveryNoun(application.applicationKind),
    businessPersona: "logistics_last_mile",
    businessObjective: application.allowedClaim ?? "weather-related delivery delay risk",
    asksForComparison: false,
    asksForExplanation: false,
    asksForPrediction: true,
    requiredData: ["Weather forecast", "NWS alert context", "Delivery time window", ...deliveryExternalEvidence(application.applicationKind)],
    availableData: ["Weather forecast", "NWS alert context when available", "Delivery time window"],
    missingData: application.externalMissingEvidence,
    answerability: "answerable_partially",
    needsMapMove: true,
    safetySensitive: false,
    requiresFollowup: false,
    followupQuestion: null,
    normalizedQuestion: `${originalQuestion} Expected delivery window: ${window.label}.`,
    userFriendlyGoal: "Estimate weather-related delivery disruption risk without claiming actual carrier/package status."
  };
  const capability = evaluateAssistantCapability({ message: originalQuestion, interpretation, context, applicationReasoning: application });
  const forecastRaw = (await fetchForecast([target.point]))[0];
  const advisory = mergeCapabilityIntoResponse(buildAssistantAdvisory(originalQuestion, context, target, forecastRaw, interpretation, capability), capability);
  return buildDeliveryRiskResponse(advisory, window, capability);
}

async function handleRouteTravelQuestion(message, context, application, interpretation, capability, selected, center, plannerPlan = null) {
  const locations = routeLocationsFromApplication(application, message);
  if (locations.length < 2) return applicationLocationFollowupResponse(application);
  const targets = [];
  for (const location of locations.slice(0, 2)) {
    const target = await resolveAssistantTarget(location, selected, center, context);
    if (!target) return unresolvedLocationResponse(location);
    targets.push(target);
  }
  const routeTargets = [...targets];
  const midpoint = routeMidpointTarget(targets[0], targets[1]);
  if (midpoint) routeTargets.push(midpoint);
  const forecastRows = await fetchForecast(routeTargets.map((target) => target.point));
  const routePoints = routeTargets.map((target, index) => buildRoutePointEvidence(message, context, target, forecastRows[index], interpretation));
  const routeState = routeConversationState(message, plannerPlan, application, interpretation, routePoints);
  const advisory = {
    ...buildRouteTravelAdvisory(message, application, interpretation, capability, routePoints),
    conversationState: routeState
  };
  const evidence = buildAssistantEvidence({ message, interpretation, advisory, capability });
  if (!process.env.OPENAI_API_KEY) return advisory;
  try {
    return await callOpenAiAssistant(message, advisory, interpretation, evidence);
  } catch (error) {
    return {
      ...advisory,
      answer: `${advisory.answer}\n\nLLM response unavailable, so this answer used the dashboard's deterministic route-weather rules. ${
        error instanceof Error ? error.message : "OpenAI request failed."
      }`.slice(0, 1600),
      dataUsed: [...new Set([...advisory.dataUsed, "Deterministic fallback"])]
    };
  }
}

async function handleSkyLocationQuestion(message, context, application, interpretation, capability) {
  const visible = Array.isArray(context?.visiblePoints) ? context.visiblePoints : [];
  const candidates = filterCandidatesBySearchScope(visible
    .filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)))
    .slice(0, 8)
    .map((point) => ({
      label: [point.name, point.state].filter(Boolean).join(", ") || `map point near ${Number(point.lat).toFixed(2)}, ${Number(point.lon).toFixed(2)}`,
      layers: coerceLayerValues(point.layers, point),
      point: {
        id: `assistant-sky-${slugify([point.name, point.state].filter(Boolean).join("-") || `${point.lat}-${point.lon}`)}`,
        kind: "refinement",
        domain: domainForLatLon(Number(point.lat), Number(point.lon)),
        lat: Number(point.lat),
        lon: Number(point.lon)
      }
    })), interpretation?.userFriendlyGoal ?? message);
  if (!candidates.length) {
    return {
      answer: "Sure, I can help pick a stargazing spot, but I need either a city/region or a map view with a few visible places to compare.",
      verdict: "insufficient_data",
      confidence: "high",
      bestWindows: [],
      risks: ["No comparable map locations were available in the current view."],
      dataUsed: ["Application reasoner"],
      guardrailNote: "Ask for only the missing map or location context needed for sky-visibility screening.",
      actions: [],
      answerType: "needs_followup",
      persona: "General planning",
      capabilityNote: "I need a place or visible map region before comparing stargazing weather.",
      missingData: ["Location or visible map context"]
    };
  }

  const forecastRows = await fetchForecast(candidates.map((candidate) => candidate.point));
  const ranked = candidates
    .map((candidate, index) => buildSkyPointEvidence(message, context, candidate, forecastRows[index], interpretation))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const best = ranked[0];
  const risks = skyComparisonRisks(best, ranked);
  const verdict = best ? verdictFromScore(best.score, risks) : "insufficient_data";
  const answer = best
    ? skyComparisonAnswer(best, ranked)
    : "I could not get enough cloud-cover data to compare stargazing spots confidently.";
  const advisory = {
    answer,
    verdict,
    confidence: "medium",
    bestWindows: ranked.slice(0, 3).map((item) => ({
      label: item.label,
      score: item.score,
      rationale: skyWindowRationale(item.firstDay, item.alerts)
    })),
    risks,
    dataUsed: ["Cloud cover forecast", "Rain and wind forecast", "NWS alert context when available", "Map context"],
    guardrailNote:
      "Stargazing guidance is weather-only. Light pollution, moon phase, smoke or haze, local horizon obstruction, and astronomical seeing are not connected.",
    actions: best ? [{ type: "flyTo", lat: best.point.lat, lon: best.point.lon, zoom: 7, label: best.label }] : [],
    answerType: "in_scope_weather",
    persona: "General planning",
    capabilityNote: "Weather-only sky screening; dark-sky and astronomy-specific data are not connected.",
    missingData: application?.externalMissingEvidence ?? [],
    facts: {
      question: message,
      interpretation,
      location: best?.label ?? "visible map locations",
      provider: [...new Set(ranked.map((item) => item.provider).filter(Boolean))].join(" + ") || "dashboard",
      current: best?.current ?? null,
      days: best?.days ?? [],
      alerts: best?.alerts ?? [],
      skyCandidates: ranked,
      activeLayer: context?.activeLayer ?? null,
      timeIdx: context?.timeIdx ?? null,
      sourceBadge: context?.sourceBadge ?? null
    }
  };
  const evidence = buildAssistantEvidence({ message, interpretation, advisory, capability });
  if (!process.env.OPENAI_API_KEY) return advisory;
  try {
    const response = await callOpenAiAssistant(message, advisory, interpretation, evidence);
    return {
      ...response,
      answerType: "in_scope_weather",
      persona: "General planning",
      capabilityNote: advisory.capabilityNote,
      missingData: advisory.missingData
    };
  } catch (error) {
    return {
      ...advisory,
      answer: `${advisory.answer}\n\nLLM response unavailable, so this answer used the dashboard's deterministic sky-weather rules. ${
        error instanceof Error ? error.message : "OpenAI request failed."
      }`.slice(0, 1600),
      dataUsed: [...new Set([...advisory.dataUsed, "Deterministic fallback"])]
    };
  }
}

async function handleVisibleRankQuestion(message, context, plan, application, interpretation, capability) {
  const visible = Array.isArray(context?.visiblePoints) ? context.visiblePoints : [];
  const candidates = filterCandidatesBySearchScope(visible
    .filter((point) => Number.isFinite(Number(point?.lat)) && Number.isFinite(Number(point?.lon)))
    .slice(0, 8)
    .map((point) => ({
      label: [point.name, point.state].filter(Boolean).join(", ") || `map point near ${Number(point.lat).toFixed(2)}, ${Number(point.lon).toFixed(2)}`,
      point: {
        id: `assistant-rank-${slugify([point.name, point.state].filter(Boolean).join("-") || `${point.lat}-${point.lon}`)}`,
        kind: "refinement",
        domain: domainForLatLon(Number(point.lat), Number(point.lon)),
        lat: Number(point.lat),
        lon: Number(point.lon)
      }
    })), plan?.goal ?? message);
  if (!candidates.length) return plannerFollowupResponse(message, { ...plan, pendingFacts: ["location"] }, context);

  const forecastRows = await fetchForecast(candidates.map((candidate) => candidate.point));
  const variable = rankingVariableFromPlan(plan);
  const rows = candidates
    .map((candidate, index) => {
      const raw = forecastRows[index] ?? {};
      const daily = raw.daily ?? {};
      const current = raw.current ?? {};
      const days = nextAssistantDays(daily, current, interpretation?.timeRangeDays ?? 4, extractStartDayOffset(message));
      const alerts = relevantPlanningAlerts(dedupeAlerts(contextAlertsForTarget(context, candidate)), message);
      const firstDay = days[0] ?? {};
      const value = rankingValue(variable, days, current, alerts, candidate.layers);
      return {
        label: candidate.label,
        point: candidate.point,
        provider: String(raw?.source?.provider ?? context?.sourceBadge ?? "dashboard"),
        days,
        firstDay,
        alerts,
        value,
        score: rankingScore(variable, value, firstDay, alerts)
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const best = rows[0];
  const risks = [
    best ? `Top visible-map candidate: ${best.label} (${rankingFormat(variable, best.value)}).` : "No ranked candidate was available.",
    ...[...new Set((plan.requiredFacts ?? []).filter((fact) => fact.source === "external").map((fact) => fact.id.replace(/_/g, " ")))]
      .slice(0, 3)
      .map((item) => `${capitalize(item)} is not connected.`)
  ].slice(0, 4);
  const answer = best
    ? variable.startsWith("layer_")
      ? `${best.label} has the highest ${rankingLabel(variable).toLowerCase()} value among the visible regions I can compare right now. Top visible regions: ${rows
          .slice(0, 3)
          .map((row) => `${row.label} (${rankingFormat(variable, row.value)})`)
          .join(", ")}.`
      : `${best.label} looks like the best visible-map option for this question. I ranked the visible areas using ${rankingLabel(variable)} from the forecast; the top few are ${rows
          .slice(0, 3)
          .map((row) => `${row.label} (${rankingFormat(variable, row.value)})`)
          .join(", ")}.`
    : "I could not rank the visible areas from the current map context.";
  const advisory = {
    answer,
    verdict: best ? "good" : "insufficient_data",
    confidence: "medium",
    bestWindows: rows.slice(0, 3).map((row) => ({ label: row.label, score: row.score, rationale: `${rankingLabel(variable)}: ${rankingFormat(variable, row.value)}` })),
    risks,
    dataUsed: ["Visible map points", "Forecast ranking", "Dashboard context"],
    guardrailNote: "Visible-area ranking uses dashboard weather signals only.",
    actions: best ? [{ type: "flyTo", lat: best.point.lat, lon: best.point.lon, zoom: 7, label: best.label }] : [],
    answerType: variable.startsWith("layer_") ? "in_scope_dashboard_explainer" : capability?.scopeClass ?? "in_scope_weather",
    persona: capability?.persona?.label ?? "General planning",
    capabilityNote: "This ranks only locations visible in the current map context.",
    missingData: (plan.requiredFacts ?? []).filter((fact) => fact.source === "external").map((fact) => fact.id),
    facts: {
      question: message,
      interpretation,
      location: best?.label ?? "visible map locations",
      provider: [...new Set(rows.map((item) => item.provider).filter(Boolean))].join(" + ") || "dashboard",
      current: null,
      days: best?.days ?? [],
      alerts: best?.alerts ?? [],
      rankedCandidates: rows,
      activeLayer: context?.activeLayer ?? null,
      timeIdx: context?.timeIdx ?? null,
      sourceBadge: context?.sourceBadge ?? null
    }
  };
  const evidence = buildAssistantEvidence({ message, interpretation, advisory, capability });
  if (!process.env.OPENAI_API_KEY) return advisory;
  try {
    return await callOpenAiAssistant(message, advisory, interpretation, evidence);
  } catch (error) {
    return {
      ...advisory,
      answer: `${advisory.answer}\n\nLLM response unavailable, so this answer used the dashboard's deterministic ranking rules. ${
        error instanceof Error ? error.message : "OpenAI request failed."
      }`.slice(0, 1600),
      dataUsed: [...new Set([...advisory.dataUsed, "Deterministic fallback"])]
    };
  }
}

function rankingVariableFromPlan(plan) {
  const ids = (plan.requiredFacts ?? []).map((fact) => fact.compute?.var ?? fact.id);
  const text = `${plan.goal ?? ""} ${plan.lens ?? ""} ${plan.activity ?? ""}`.toLowerCase();
  const layer = ids.find((id) => /^layer_/.test(id));
  if (layer) return layer;
  if (ids.includes("cloud_cover") || /stargaz|cloud|sky/.test(text)) return "cloud_cover_low";
  if (ids.includes("wind_speed") || /wind|windy/.test(text)) return "wind_speed";
  if (ids.includes("precip_sum") || /rain|wet|precip/.test(text)) return "precip_sum_low";
  if (ids.includes("apparent_temp") || ids.includes("temp_max") || /hot|heat|warm|temperature/.test(text)) return "apparent_temp";
  return "suitability";
}

function rankingValue(variable, days, current, alerts, layers = {}) {
  if (variable.startsWith("layer_")) {
    const layer = variable.replace(/^layer_/, "");
    return numberOrNull(coerceLayerValues(layers)[layer]) ?? forecastLayerValue(layer, days, current, alerts);
  }
  if (variable === "cloud_cover_low") return minNumber(days.map((day) => day.cloudCoverPct));
  if (variable === "wind_speed") return maxNumber(days.map((day) => day.windMaxMph));
  if (variable === "precip_sum_low") return sumNumbers(days.map((day) => day.precipIn));
  if (variable === "apparent_temp") return maxNumber(days.map((day) => day.heatIndexF ?? day.tempHighF));
  return maxNumber(days.map((day) => suitabilityScore(day, alerts)));
}

function forecastLayerValue(layer, days, current, alerts) {
  if (!Array.isArray(days) || !days.length) return null;
  if (layer === "heat") return meanNumber(days.slice(0, 7).map((day) => day.heatIndexF ?? day.tempHighF));
  if (layer === "temp") return meanNumber(days.slice(0, 7).map((day) => day.tempHighF));
  if (layer === "wind") return maxNumber(days.slice(0, 7).map((day) => day.windMaxMph));
  if (layer === "humidity") return numberOrNull(current?.relative_humidity_2m) ?? numberOrNull(current?.humidityPct);
  if (layer === "cloud") return meanNumber(days.slice(0, 7).map((day) => day.cloudCoverPct));
  if (layer === "cdd") {
    return sumNumbers(
      days.slice(0, 7).map((day) => {
        const hi = numberOrNull(day.tempHighF);
        const lo = numberOrNull(day.tempLowF);
        return hi == null || lo == null ? null : Math.max(0, (hi + lo) / 2 - 65);
      })
    );
  }
  if (layer === "fire") {
    const tmax = maxNumber(days.slice(0, 7).map((day) => day.tempHighF));
    const wind = maxNumber(days.slice(0, 7).map((day) => day.windMaxMph));
    const rh = numberOrNull(current?.relative_humidity_2m) ?? numberOrNull(current?.humidityPct) ?? 50;
    if (tmax == null) return null;
    const windS = wind == null ? 0 : Math.max(0, Math.min(1, wind / 45));
    return Math.round(100 * Math.max(0, Math.min(1, Math.max(0, Math.min(1, (tmax - 68) / 42)) * (1 - rh / 100) * 1.7 * (0.5 + windS))));
  }
  if (layer === "risk") {
    const heat = forecastLayerValue("heat", days, current, alerts);
    const fire = forecastLayerValue("fire", days, current, alerts);
    const wind = forecastLayerValue("wind", days, current, alerts);
    const cdd = forecastLayerValue("cdd", days, current, alerts);
    const parts = [
      heat == null ? null : { w: 0.38, s: Math.max(0, Math.min(1, (heat - 60) / 52)) },
      fire == null ? null : { w: 0.28, s: fire / 100 },
      wind == null ? null : { w: 0.22, s: Math.max(0, Math.min(1, wind / 45)) },
      cdd == null ? null : { w: 0.12, s: Math.max(0, Math.min(1, cdd / 120)) }
    ].filter(Boolean);
    const total = parts.reduce((sum, part) => sum + part.w, 0);
    return total ? Math.round((100 * parts.reduce((sum, part) => sum + part.w * part.s, 0)) / total) : null;
  }
  return null;
}

function rankingScore(variable, value, firstDay, alerts) {
  const n = numberOrNull(value);
  if (variable.startsWith("layer_")) return n ?? 0;
  if (variable === "cloud_cover_low") return n == null ? 0 : Math.max(0, 100 - n - (alerts.length ? 20 : 0));
  if (variable === "precip_sum_low") return n == null ? 0 : Math.max(0, 100 - n * 80 - (alerts.length ? 20 : 0));
  if (variable === "wind_speed") return n == null ? 0 : n;
  if (variable === "apparent_temp") return n == null ? 0 : n;
  return n ?? suitabilityScore(firstDay, alerts);
}

function rankingLabel(variable) {
  if (variable.startsWith("layer_")) return `${layerLabel(variable.replace(/^layer_/, ""))} layer`;
  if (variable === "cloud_cover_low") return "low cloud cover";
  if (variable === "precip_sum_low") return "low precipitation";
  if (variable === "wind_speed") return "wind speed";
  if (variable === "apparent_temp") return "apparent temperature";
  return "overall weather suitability";
}

function layerLabel(layer) {
  const labels = {
    risk: "Forecast stress",
    fire: "Fire weather",
    heat: "Heat index",
    temp: "Temperature",
    wind: "Wind",
    humidity: "Humidity",
    cloud: "Cloud cover",
    cdd: "Cooling degree days"
  };
  return labels[layer] ?? "Dashboard";
}

function formatLayerValue(layer, value) {
  const n = numberOrNull(value);
  if (n == null) return "limited data";
  if (["risk", "fire"].includes(layer)) return `${Math.round(n)}/100`;
  if (["heat", "temp"].includes(layer)) return `${Math.round(n)}F`;
  if (layer === "wind") return `${Math.round(n)} mph`;
  if (["humidity", "cloud"].includes(layer)) return `${Math.round(n)}%`;
  if (layer === "cdd") return `${Math.round(n)} CDD`;
  return `${Math.round(n)}`;
}

function rankingFormat(variable, value) {
  const n = numberOrNull(value);
  if (n == null) return "limited data";
  if (variable.startsWith("layer_")) return formatLayerValue(variable.replace(/^layer_/, ""), n);
  if (variable === "cloud_cover_low") return `${Math.round(n)}% cloud cover`;
  if (variable === "precip_sum_low") return `${n.toFixed(2)} in rain`;
  if (variable === "wind_speed") return `${Math.round(n)} mph wind`;
  if (variable === "apparent_temp") return `${Math.round(n)}F`;
  return `${Math.round(n)}/100`;
}

function buildSkyPointEvidence(message, context, target, raw, interpretation) {
  const daily = raw?.daily ?? {};
  const current = raw?.current ?? {};
  const days = nextAssistantDays(daily, current, interpretation?.timeRangeDays ?? 3, extractStartDayOffset(message));
  const alerts = relevantPlanningAlerts(dedupeAlerts(contextAlertsForTarget(context, target)), message);
  const firstDay = days[0] ?? {};
  return {
    label: target.label,
    point: target.point,
    provider: String(raw?.source?.provider ?? context?.sourceBadge ?? "dashboard"),
    current: {
      tempF: numberOrNull(current.temperature_2m),
      windMph: numberOrNull(current.wind_speed_10m),
      precipIn: numberOrNull(current.precipitation),
      cloudCoverPct: numberOrNull(current.cloud_cover)
    },
    days,
    firstDay,
    alerts,
    score: skySuitabilityScore(firstDay, alerts)
  };
}

function routeMidpointTarget(origin, destination) {
  const lat1 = Number(origin?.point?.lat);
  const lon1 = Number(origin?.point?.lon);
  const lat2 = Number(destination?.point?.lat);
  const lon2 = Number(destination?.point?.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  if (distanceMiles(lat1, lon1, lat2, lon2) < 45) return null;
  const lat = (lat1 + lat2) / 2;
  const lon = (lon1 + lon2) / 2;
  return {
    label: "route midpoint",
    point: {
      id: `assistant-route-midpoint-${lat.toFixed(2)}-${lon.toFixed(2)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

function buildRoutePointEvidence(message, context, target, raw, interpretation) {
  const daily = raw?.daily ?? {};
  const current = raw?.current ?? {};
  const startOffset = Number.isInteger(interpretation?.startDayOffset) ? interpretation.startDayOffset : extractStartDayOffset(message);
  const days = nextAssistantDays(daily, current, interpretation?.timeRangeDays ?? 1, startOffset);
  const hourlyWindows = routeHourlyWindows(raw?.hourly, startOffset);
  const alerts = relevantPlanningAlerts(dedupeAlerts(contextAlertsForTarget(context, target)), message);
  const risks = riskList(days, alerts, []);
  const firstDay = days[0] ?? {};
  return {
    label: target.label,
    point: target.point,
    provider: String(raw?.source?.provider ?? context?.sourceBadge ?? "dashboard"),
    current: {
      tempF: numberOrNull(current.temperature_2m),
      apparentF: numberOrNull(current.apparent_temperature),
      humidityPct: numberOrNull(current.relative_humidity_2m),
      windMph: numberOrNull(current.wind_speed_10m),
      precipIn: numberOrNull(current.precipitation)
    },
    days,
    hourlyWindows,
    firstDay,
    alerts,
    risks,
    score: suitabilityScore(firstDay, alerts)
  };
}

function routeHourlyWindows(hourly, startOffset = 0) {
  if (!hourly || typeof hourly !== "object" || !Array.isArray(hourly.time)) return [];
  const targetDate = nextDates(Math.max(2, startOffset + 1))[startOffset] ?? String(hourly.time[0] ?? "").slice(0, 10);
  const windows = [
    { label: "early morning", start: 6, end: 9 },
    { label: "late morning", start: 9, end: 12 },
    { label: "early afternoon", start: 12, end: 15 },
    { label: "late afternoon", start: 15, end: 18 },
    { label: "evening", start: 18, end: 21 }
  ];
  return windows
    .map((window) => {
      const indexes = hourly.time
        .map((time, index) => {
          const text = String(time ?? "");
          if (text.slice(0, 10) !== targetDate) return null;
          const hour = Number(text.slice(11, 13));
          return Number.isFinite(hour) && hour >= window.start && hour < window.end ? index : null;
        })
        .filter((index) => index != null);
      if (!indexes.length) return null;
      const precip = sumNumbers(indexes.map((index) => numberOrNull(hourly.precipitation?.[index])));
      const wind = maxNumber(indexes.map((index) => numberOrNull(hourly.wind_speed_10m?.[index])));
      const apparent = meanNumber(indexes.map((index) => numberOrNull(hourly.apparent_temperature?.[index])));
      const temp = meanNumber(indexes.map((index) => numberOrNull(hourly.temperature_2m?.[index])));
      const heat = apparent ?? temp;
      let score = 100;
      if (precip != null) score -= Math.min(55, precip * 140);
      if (wind != null && wind >= 30) score -= 28;
      else if (wind != null && wind >= 20) score -= 14;
      if (heat != null && heat >= 95) score -= 18;
      else if (heat != null && heat <= 35) score -= 12;
      return {
        label: window.label,
        score: Math.max(0, Math.min(100, Math.round(score))),
        precipIn: precip,
        windMph: wind,
        apparentF: apparent,
        tempF: temp
      };
    })
    .filter(Boolean);
}

function buildRouteTravelAdvisory(message, application, interpretation, capability, routePoints) {
  const origin = routePoints[0];
  const destination = routePoints[1];
  const corridor = routePoints[2] ?? null;
  const pointsForRisk = routePoints.filter(Boolean);
  const score = Math.min(...pointsForRisk.map((point) => point.score).filter((value) => Number.isFinite(value)));
  const risks = routeRiskList(pointsForRisk);
  const bestWindows = routeBestStartWindows(pointsForRisk, interpretation);
  const verdict = risks.some((risk) => /active alert|strong|severe|extreme/i.test(risk)) && score < 65 ? "avoid" : verdictFromScore(score, risks);
  const provider = [...new Set(pointsForRisk.map((point) => point.provider).filter(Boolean))].join(" + ") || "dashboard";
  const location = `${origin?.label ?? "origin"} to ${destination?.label ?? "destination"}`;
  const actions = destination
    ? [{ type: "flyTo", lat: destination.point.lat, lon: destination.point.lon, zoom: 8, label: destination.label }]
    : [];
  return {
    answer: routeFallbackAnswer(location, origin, destination, corridor, verdict, risks, interpretation, bestWindows),
    verdict,
    confidence: "medium",
    bestWindows,
    risks,
    dataUsed: [provider, "Route endpoint weather", corridor ? "Route midpoint weather" : null, "Dashboard context"].filter(Boolean),
    guardrailNote:
      "Weather-related travel guidance only. Traffic, crashes, road closures, construction delays, parking, transit, and border wait times are not connected.",
    actions,
    answerType: capability?.scopeClass ?? "in_scope_weather",
    persona: capability?.persona?.label ?? "General planning",
    capabilityNote: "Partial answer: weather can be checked, but live road and traffic operations data are not connected.",
    missingData: routeExternalEvidence(),
    facts: {
      question: message,
      interpretation,
      location,
      provider,
      current: destination?.current ?? null,
      days: destination?.days ?? [],
      alerts: [...new Set(pointsForRisk.flatMap((point) => point.alerts ?? []))],
      informationalAlerts: [],
      route: {
        origin,
        destination,
        corridor,
        externalMissingEvidence: routeExternalEvidence(),
        allowedClaim: application?.allowedClaim ?? "weather-related route practicality",
        forbiddenClaims: routeForbiddenClaims()
      },
      activeLayer: null,
      timeIdx: null,
      sourceBadge: null
    }
  };
}

function routeConversationState(message, plannerPlan, application, interpretation, routePoints) {
  const origin = routePoints?.[0];
  const destination = routePoints?.[1];
  const locations =
    Array.isArray(plannerPlan?.locations) && plannerPlan.locations.length >= 2
      ? plannerPlan.locations
      : [
          origin?.label ? { raw: origin.label, role: "origin" } : null,
          destination?.label ? { raw: destination.label, role: "destination" } : null
        ].filter(Boolean);
  const plan = verifyPlannerPlan(
    plannerPlan && typeof plannerPlan === "object"
      ? { ...plannerPlan, locations, pendingFacts: [] }
      : {
          domain: "weather_related",
          goal: application?.userGoal || interpretation?.userFriendlyGoal || `Continue route-weather planning: ${String(message).slice(0, 120)}`,
          lens: "travel",
          activity: "travel",
          retrievalMode: "route",
          shouldGeocode: true,
          geocodeQueries: locations.map((loc) => loc.raw),
          locations,
          timeWindow: plannerTimeWindowFromMessage(message),
          requiredFacts: localRequiredFacts("travel", "route", locations.length),
          pendingFacts: [],
          safetyFlags: [],
          expectedAnswerMode: "answer_with_external_caveat"
        },
    {}
  );
  return {
    plannerPlan: plan,
    pendingFacts: [],
    originalQuestion: message,
    questionFamily: "route_travel",
    locationLabel: [origin?.label, destination?.label].filter(Boolean).join(" to ") || null,
    lat: destination?.point?.lat ?? null,
    lon: destination?.point?.lon ?? null,
    persona: "Point-to-point travel weather",
    businessObjective: application?.allowedClaim ?? "weather-related route practicality"
  };
}

function routeRiskList(points) {
  const risks = [];
  for (const point of points) {
    const day = point.firstDay ?? {};
    const heat = numberOrNull(day.heatIndexF ?? day.tempHighF);
    const rain = numberOrNull(day.precipIn);
    const wind = numberOrNull(day.windMaxMph);
    if (heat != null && heat >= 95) risks.push(`${point.label}: heat could feel near ${Math.round(heat)}F.`);
    if (rain != null && rain >= 0.15) risks.push(`${point.label}: rain may be a factor, around ${rain.toFixed(2)} inches.`);
    if (wind != null && wind >= 25) risks.push(`${point.label}: winds may be noticeable, near ${Math.round(wind)} mph.`);
    for (const alert of point.alerts ?? []) risks.push(`${point.label}: active alert nearby: ${alert.event ?? "severe weather"}${alertTiming(alert)}.`);
  }
  if (!risks.length) risks.push("No major heat, wind, rain, or severe-alert signal appears in the route endpoint weather.");
  return dedupeStrings(risks).slice(0, 6);
}

function routeBestStartWindows(points, interpretation = {}) {
  const usable = points.filter((point) => Array.isArray(point.hourlyWindows) && point.hourlyWindows.length);
  if (!usable.length) return [];
  const labels = usable[0].hourlyWindows.map((window) => window.label);
  return labels
    .map((label) => {
      const slices = usable.map((point) => point.hourlyWindows.find((window) => window.label === label)).filter(Boolean);
      if (!slices.length) return null;
      const score = Math.min(...slices.map((window) => window.score));
      const rain = Math.max(...slices.map((window) => window.precipIn ?? 0));
      const wind = Math.max(...slices.map((window) => window.windMph ?? 0));
      const heat = Math.max(...slices.map((window) => window.apparentF ?? window.tempF ?? -Infinity));
      const bits = [];
      if (rain >= 0.1) bits.push(`${rain.toFixed(2)} in rain risk`);
      else bits.push("lowest rain signal");
      if (Number.isFinite(wind) && wind >= 20) bits.push(`winds near ${Math.round(wind)} mph`);
      if (Number.isFinite(heat) && heat >= 90) bits.push(`feels near ${Math.round(heat)}F`);
      return {
        label: `${routeWindowDateLabel(usable[0], interpretation)} ${label}`.trim(),
        score,
        rationale: bits.join(", ")
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function routeWindowDateLabel(point, interpretation = {}) {
  if (Number(interpretation?.startDayOffset) === 1) return "Tomorrow";
  const label = point?.firstDay?.label;
  return label ? label : "";
}

function routeFallbackAnswer(location, origin, destination, corridor, verdict, risks, interpretation = {}, bestWindows = []) {
  const originLine = routePointWeatherLine(origin);
  const destinationLine = routePointWeatherLine(destination);
  const corridorLine = corridor ? ` Mid-route looks similar: ${routePointWeatherLine(corridor).replace(/^route midpoint: /i, "")}` : "";
  const time = routeTimePhrase(origin?.firstDay, interpretation);
  const windowLine = bestWindows.length
    ? ` Best weather-only start window: ${bestWindows[0].label.toLowerCase()} (${bestWindows[0].rationale}).`
    : " I do not have enough hourly route detail to pick an exact start time, so use live radar and traffic before leaving.";
  const lead =
    verdict === "avoid"
      ? `Weather-wise, I would be cautious about ${location} ${time}.`
      : verdict === "marginal"
        ? `Weather-wise, ${location} looks doable ${time}, but not totally friction-free.`
        : `Weather-wise, ${location} looks generally reasonable ${time}.`;
  const watch = risks.length ? ` Main weather note: ${risks[0]}` : "";
  return `${lead} ${originLine} ${destinationLine}${corridorLine}${windowLine}${watch} I cannot see traffic, crashes, road closures, construction delays, parking, transit, or border wait times, so check a live map or 511 before leaving.`;
}

function routeTimePhrase(day, interpretation = {}) {
  if (Number(interpretation?.startDayOffset) === 1) return "tomorrow";
  if (String(interpretation?.daypart ?? "").trim()) return `${interpretation.daypart}`;
  if (day?.label) return `for ${day.label}`;
  return "for the requested window";
}

function routePointWeatherLine(point) {
  if (!point) return "";
  const day = point.firstDay ?? {};
  const heat = numberOrNull(day.heatIndexF ?? day.tempHighF);
  const rain = numberOrNull(day.precipIn);
  const wind = numberOrNull(day.windMaxMph);
  const parts = [];
  if (heat != null) parts.push(`${Math.round(heat)}F`);
  if (rain != null && rain >= 0.15) parts.push(`${rain.toFixed(2)} inches of rain possible`);
  else if (rain != null && rain > 0) parts.push("a little rain possible");
  else if (rain != null) parts.push("little rain signal");
  if (wind != null) parts.push(`winds near ${Math.round(wind)} mph`);
  return `${point.label}: ${parts.join(", ") || "forecast details are limited"}.`;
}

function deliveryTimeFollowupResponse(message, interpretation, target, application = reasonAboutApplicationLocally(message, {})) {
  const fallbackQuestion = target?.label
    ? `Sure, I can help with the weather side for ${target.label}. What ${deliveryNoun(application.applicationKind)} window are you expecting: morning, afternoon, evening, or a rough time like 5 PM?`
    : `Sure, I can help with the weather side of that. What city or area and rough ${deliveryNoun(application.applicationKind)} window should I check?`;
  const question = safeFollowupQuestion(interpretation?.followupQuestion, fallbackQuestion);
  const label = target?.label ?? interpretation?.location ?? null;
  return {
    answer: `${question} I can estimate weather-related delay risk, but I cannot see ${deliveryMissingPlain(application.applicationKind)}.`,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: ["Expected delivery window is needed before comparing alert timing."],
    dataUsed: ["Conversation follow-up", "Capability guardrail"],
    guardrailNote: `Weather-related ${deliveryNoun(application.applicationKind)} risk only; actual delivery status requires external data.`,
    actions: target ? [{ type: "flyTo", lat: target.point.lat, lon: target.point.lon, zoom: 8, label: target.label }] : [],
    answerType: "needs_followup",
    persona: "Logistics / last-mile operations",
    capabilityNote: "I can estimate weather-related delay risk after you give the delivery window.",
    missingData: ["Expected delivery window", ...deliveryExternalEvidence(application.applicationKind)],
    conversationState: {
      pendingSlot: "delivery_time_window",
      questionFamily: "business_weather_exposure",
      originalQuestion: message,
      locationLabel: label,
      lat: target?.point?.lat ?? null,
      lon: target?.point?.lon ?? null,
      persona: "Logistics / last-mile operations",
      businessObjective: application.allowedClaim ?? "weather-related delivery delay risk"
    }
  };
}

function buildDeliveryRiskResponse(advisory, window, capability) {
  const risk = weatherDelayRisk(advisory, window);
  const action = advisory.actions ?? [];
  const kind = capability?.applicationReasoning?.applicationKind ?? reasonAboutApplicationLocally(advisory?.facts?.question ?? "", {}).applicationKind;
  const lead =
    risk.level === "high"
      ? `For ${window.label}, weather-related delivery disruption risk looks high around ${advisory.facts?.location ?? "that area"}.`
      : risk.level === "moderate"
        ? `For ${window.label}, weather-related delivery disruption risk looks moderate around ${advisory.facts?.location ?? "that area"}.`
        : `For ${window.label}, weather-related delivery disruption risk looks low around ${advisory.facts?.location ?? "that area"}.`;
  return {
    ...advisory,
    answer:
      `${lead} ${risk.reason} I cannot tell whether your actual ${deliveryNoun(kind)} will be delayed because I do not have ${deliveryMissingPlain(kind)}.`,
    verdict: risk.level === "high" ? "avoid" : risk.level === "moderate" ? "marginal" : "good",
    confidence: "medium",
    bestWindows: [],
    risks: risk.risks,
    dataUsed: [...new Set([...(advisory.dataUsed ?? []), "Delivery time window", "Weather-related delay-risk rules"])],
    guardrailNote: `This is weather-related ${deliveryNoun(kind)} disruption risk, not actual delivery ETA.`,
    actions: action,
    answerType: "in_scope_partial_business",
    persona: capability?.persona?.label ?? "Logistics / last-mile operations",
    capabilityNote:
      `Weather-related risk only. ${capitalize(deliveryMissingPlain(kind))} are not connected.`,
    missingData: deliveryExternalEvidence(kind),
    conversationState: null
  };
}

function alertExplanationResponse(message, context) {
  if (!isAlertExplanationQuestion(message)) return null;
  const term = extractAlertTerm(message, context);
  const explanation = explainAlertTerm(term);
  return {
    answer: explanation.answer,
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: explanation.risks,
    dataUsed: ["NWS alert meaning", "Dashboard alert context"],
    guardrailNote: "Alert explanations are plain-language context, not official safety instructions.",
    actions: [],
    answerType: "in_scope_dashboard_explainer",
    persona: "General planning",
    capabilityNote: explanation.capabilityNote,
    missingData: []
  };
}

function isAlertExplanationQuestion(message) {
  const text = String(message ?? "").toLowerCase();
  return /\b(what\s+(?:does|do|is|are)|explain|mean|meaning)\b/.test(text) && /\b(alert|warning|watch|advisory|marine|thunderstorm|tornado|flood|wind)\b/.test(text);
}

function extractAlertTerm(message, context) {
  const text = String(message ?? "");
  const known = [
    "Special Marine Warning",
    "Severe Thunderstorm Warning",
    "Tornado Warning",
    "Flash Flood Warning",
    "Flood Warning",
    "High Wind Warning",
    "Winter Storm Warning"
  ];
  const hit = known.find((term) => new RegExp(term, "i").test(text));
  if (hit) return hit;
  const alerts = Array.isArray(context?.alerts) ? context.alerts : [];
  const first = alerts.find((alert) => typeof alert?.event === "string" && alert.event.trim());
  return first?.event ?? "weather alert";
}

function explainAlertTerm(term) {
  if (/special marine warning/i.test(term)) {
    return {
      answer:
        "A Special Marine Warning is an NWS warning for hazardous weather over water, such as strong thunderstorms, sudden high winds, waterspouts, or dangerous conditions for boats. For a land-based plan, I should treat it as a nearby water/shoreline hazard, not as automatic proof that the whole city is unsafe. If you are boating, on a lakefront, or running a waterfront event, take it seriously and check the official NWS alert.",
      risks: ["Mainly relevant to boating, marine travel, and waterfront activity unless separate land-based warnings are also active."],
      capabilityNote: "Marine alerts explain water-area hazards; land decisions need land-based warnings and local conditions too."
    };
  }
  if (/severe thunderstorm warning/i.test(term)) {
    return {
      answer:
        "A Severe Thunderstorm Warning means NWS has detected or expects a storm capable of severe hazards, usually damaging wind and/or large hail. For outdoor plans, that is a pause-and-recheck signal, not a casual watch item.",
      risks: ["Follow the official NWS warning window and local safety guidance."],
      capabilityNote: "Warning timing is the official alert window, not an exact storm-arrival forecast."
    };
  }
  if (/flash flood warning/i.test(term)) {
    return {
      answer:
        "A Flash Flood Warning means NWS expects or is observing rapidly developing flooding. That is a serious near-term hazard, especially for low spots, underpasses, poor-drainage roads, creeks, and outdoor sites near water. The dashboard can explain the alert, but it does not model flood depth or road closures, so use NWS/local officials for safety decisions.",
      risks: ["Avoid driving through water-covered roads and follow the official warning text for the affected area."],
      capabilityNote: "Flood alerts are official NWS products; this dashboard does not calculate flood depth or river discharge."
    };
  }
  if (/flood warning/i.test(term)) {
    return {
      answer:
        "A Flood Warning means NWS says flooding is happening or expected in the warned area. It can involve rivers, poor-drainage areas, or ongoing high-water conditions, depending on the local alert text. I can flag the warning and its official window, but I cannot estimate flood depth, road closures, or package delays from this dashboard alone.",
      risks: ["Check the official NWS alert text and local road/safety guidance for the exact affected areas."],
      capabilityNote: "Flood warnings are alert context only here; flood-depth and river-discharge modeling are not connected."
    };
  }
  return {
    answer:
      `${term} is an official weather alert category. I can explain what it generally means, but for safety decisions you should use the official NWS alert text, local officials, and your site plan.`,
    risks: ["Official alert details and local instructions matter more than the dashboard summary."],
    capabilityNote: "Plain-language alert explanation only."
  };
}

async function interpretAssistantQuestion(message, context) {
  const fallback = interpretQuestionLocally(message);
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    return sanitizeQuestionInterpretation(await callOpenAiQuestionInterpreter(message, context), fallback);
  } catch {
    return fallback;
  }
}

async function callOpenAiQuestionInterpreter(message, context) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            "You are a query interpreter for a weather dashboard assistant. Convert the user's message into strict JSON. Do not answer the weather question. Do not invent forecast facts. Extract weather/dashboard/business-planning intent, locations, time horizon, daypart, activity, persona, requested prediction type, required data, and likely missing data. For delivery, package, carrier, route, ETA, or event-window questions, set requiresFollowup true when a time/date/window is missing and provide one concise followupQuestion that asks only for the missing detail. Use null or [] when unknown. Keep normalizedQuestion and userFriendlyGoal short and suitable as internal input to the final response writer."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              message,
              selectedLocation: context?.selected
                ? {
                    name: context.selected.name,
                    state: context.selected.state,
                    lat: context.selected.lat,
                    lon: context.selected.lon
                  }
                : null,
              mapCenter: context?.map?.center ?? null,
              activeLayer: context?.activeLayer ?? null
            },
            null,
            2
          )
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "weather_question_interpretation",
          strict: true,
          schema: questionInterpretationSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  return parseOpenAiJson(raw);
}

function questionInterpretationSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "questionFamily",
      "inScope",
      "scopeClass",
      "location",
      "locations",
      "timeRangeDays",
      "daypart",
      "activity",
      "businessPersona",
      "businessObjective",
      "asksForComparison",
      "asksForExplanation",
      "asksForPrediction",
      "requiredData",
      "availableData",
      "missingData",
      "answerability",
      "needsMapMove",
      "safetySensitive",
      "requiresFollowup",
      "followupQuestion",
      "normalizedQuestion",
      "userFriendlyGoal"
    ],
    properties: {
      intent: {
        type: "string",
        enum: ["weather_summary", "event_planning", "risk_explanation", "compare_locations", "map_context", "out_of_scope"]
      },
      questionFamily: {
        type: "string",
        enum: [
          "weather_summary",
          "event_window_planning",
          "location_comparison",
          "dashboard_explainer",
          "business_weather_exposure",
          "removed_metric",
          "out_of_domain",
          "unknown"
        ]
      },
      inScope: { type: "boolean" },
      scopeClass: {
        type: "string",
        enum: [
          "in_scope_weather",
          "in_scope_dashboard_explainer",
          "in_scope_business_relevance",
          "in_scope_partial_business",
          "needs_followup",
          "unsupported_by_data",
          "out_of_domain",
          "unsafe"
        ]
      },
      location: { type: ["string", "null"] },
      locations: { type: "array", items: { type: "string" } },
      timeRangeDays: { type: ["integer", "null"], minimum: 1, maximum: 16 },
      daypart: { type: ["string", "null"], enum: ["morning", "afternoon", "evening", "overnight", "all_day", null] },
      activity: { type: ["string", "null"] },
      businessPersona: {
        type: ["string", "null"],
        enum: ["general", "event_planning", "logistics_last_mile", "warehouse_ops", "field_service", "utility_ops", null]
      },
      businessObjective: { type: ["string", "null"] },
      asksForComparison: { type: "boolean" },
      asksForExplanation: { type: "boolean" },
      asksForPrediction: { type: "boolean" },
      requiredData: { type: "array", items: { type: "string" } },
      availableData: { type: "array", items: { type: "string" } },
      missingData: { type: "array", items: { type: "string" } },
      answerability: {
        type: "string",
        enum: ["answerable_now", "answerable_partially", "needs_followup", "unsupported_by_data", "out_of_domain", "unsafe"]
      },
      needsMapMove: { type: "boolean" },
      safetySensitive: { type: "boolean" },
      requiresFollowup: { type: "boolean" },
      followupQuestion: { type: ["string", "null"] },
      normalizedQuestion: { type: "string" },
      userFriendlyGoal: { type: "string" }
    }
  };
}

function interpretQuestionLocally(message) {
  const location = extractLocation(message);
  const text = message.toLowerCase();
  const scope = classifyAssistantScope(message, Boolean(location));
  const activity = extractActivity(text);
  const intent =
    scope === "out_of_scope"
      ? "out_of_scope"
      : /compare|versus| vs |better than/.test(text)
        ? "compare_locations"
        : /why|explain|risk|rank/.test(text)
          ? "risk_explanation"
          : activity || /event|picnic|outing|outside|outdoor|park/.test(text)
            ? "event_planning"
            : location
              ? "weather_summary"
              : "map_context";
  const days = extractDayCount(text);
  return {
    intent,
    questionFamily:
      intent === "compare_locations"
        ? "location_comparison"
        : intent === "risk_explanation" || intent === "map_context"
          ? "dashboard_explainer"
          : intent === "event_planning"
            ? "event_window_planning"
            : intent === "out_of_scope"
              ? "out_of_domain"
              : "weather_summary",
    inScope: scope !== "out_of_scope",
    scopeClass: scope === "out_of_scope" ? "out_of_domain" : "in_scope_weather",
    location,
    locations: location ? [location] : [],
    timeRangeDays: days,
    daypart: extractDaypart(text),
    activity,
    businessPersona: localBusinessPersona(text),
    businessObjective: extractBusinessObjective(text),
    asksForComparison: /compare|versus| vs |better than/.test(text),
    asksForExplanation: /\bwhy|explain|meaning|what\s+does\b/.test(text),
    asksForPrediction: /\bwill|forecast|predict|likely|chance|should|when\b/.test(text),
    requiredData: [],
    availableData: [],
    missingData: [],
    answerability: scope === "out_of_scope" ? "out_of_domain" : "answerable_now",
    needsMapMove: Boolean(location),
    safetySensitive: /\b(severe|lightning|thunder|warning|evacuat|emergency|danger|heat illness|heat stroke)\b/.test(text),
    requiresFollowup: false,
    followupQuestion: null,
    normalizedQuestion: message,
    userFriendlyGoal: localUserFriendlyGoal(intent, location, days, activity)
  };
}

function sanitizeQuestionInterpretation(raw, fallback) {
  const allowed = new Set(["weather_summary", "event_planning", "risk_explanation", "compare_locations", "map_context", "out_of_scope"]);
  const intent = allowed.has(raw?.intent) ? raw.intent : fallback.intent;
  const questionFamilies = new Set([
    "weather_summary",
    "event_window_planning",
    "location_comparison",
    "dashboard_explainer",
    "business_weather_exposure",
    "removed_metric",
    "out_of_domain",
    "unknown"
  ]);
  const scopeClasses = new Set([
    "in_scope_weather",
    "in_scope_dashboard_explainer",
    "in_scope_business_relevance",
    "in_scope_partial_business",
    "needs_followup",
    "unsupported_by_data",
    "out_of_domain",
    "unsafe"
  ]);
  const answerabilities = new Set(["answerable_now", "answerable_partially", "needs_followup", "unsupported_by_data", "out_of_domain", "unsafe"]);
  const personas = new Set(["general", "event_planning", "logistics_last_mile", "warehouse_ops", "field_service", "utility_ops"]);
  const location =
    typeof raw?.location === "string" && raw.location.trim()
      ? cleanLocationCandidate(raw.location.trim()).slice(0, 80)
      : fallback.location;
  const days = Number.isInteger(raw?.timeRangeDays) ? Math.max(1, Math.min(16, raw.timeRangeDays)) : fallback.timeRangeDays;
  return {
    intent,
    questionFamily: questionFamilies.has(raw?.questionFamily) ? raw.questionFamily : fallback.questionFamily,
    inScope: typeof raw?.inScope === "boolean" ? raw.inScope : fallback.inScope,
    scopeClass: scopeClasses.has(raw?.scopeClass) ? raw.scopeClass : fallback.scopeClass,
    location,
    locations: sanitizeStringList(raw?.locations, fallback.locations, 4, 80),
    timeRangeDays: days,
    daypart: ["morning", "afternoon", "evening", "overnight", "all_day"].includes(raw?.daypart) ? raw.daypart : fallback.daypart,
    activity: typeof raw?.activity === "string" && raw.activity.trim() ? raw.activity.trim().slice(0, 80) : fallback.activity,
    businessPersona: personas.has(raw?.businessPersona) ? raw.businessPersona : fallback.businessPersona,
    businessObjective:
      typeof raw?.businessObjective === "string" && raw.businessObjective.trim()
        ? raw.businessObjective.trim().slice(0, 160)
        : fallback.businessObjective,
    asksForComparison: typeof raw?.asksForComparison === "boolean" ? raw.asksForComparison : fallback.asksForComparison,
    asksForExplanation: typeof raw?.asksForExplanation === "boolean" ? raw.asksForExplanation : fallback.asksForExplanation,
    asksForPrediction: typeof raw?.asksForPrediction === "boolean" ? raw.asksForPrediction : fallback.asksForPrediction,
    requiredData: sanitizeStringList(raw?.requiredData, fallback.requiredData, 8, 90),
    availableData: sanitizeStringList(raw?.availableData, fallback.availableData, 8, 90),
    missingData: sanitizeStringList(raw?.missingData, fallback.missingData, 8, 120),
    answerability: answerabilities.has(raw?.answerability) ? raw.answerability : fallback.answerability,
    needsMapMove: typeof raw?.needsMapMove === "boolean" ? raw.needsMapMove : Boolean(location),
    safetySensitive: typeof raw?.safetySensitive === "boolean" ? raw.safetySensitive : fallback.safetySensitive,
    requiresFollowup: typeof raw?.requiresFollowup === "boolean" ? raw.requiresFollowup : false,
    followupQuestion:
      typeof raw?.followupQuestion === "string" && raw.followupQuestion.trim() ? raw.followupQuestion.trim().slice(0, 180) : null,
    normalizedQuestion:
      typeof raw?.normalizedQuestion === "string" && raw.normalizedQuestion.trim()
        ? raw.normalizedQuestion.trim().slice(0, 300)
        : fallback.normalizedQuestion,
    userFriendlyGoal:
      typeof raw?.userFriendlyGoal === "string" && raw.userFriendlyGoal.trim()
        ? raw.userFriendlyGoal.trim().slice(0, 300)
        : fallback.userFriendlyGoal
  };
}

function extractDayCount(text) {
  const explicit = text.match(/\bnext\s+(\d{1,2})\s+days?\b/);
  if (explicit) return Math.max(1, Math.min(16, Number(explicit[1])));
  const forDays = text.match(/\bfor\s+(?:the\s+)?(?:next\s+)?(\d{1,2})\s+days?\b/);
  if (forDays) return Math.max(1, Math.min(16, Number(forDays[1])));
  if (/\btomorrow\b/.test(text)) return 1;
  if (/\bweekend\b/.test(text)) return 3;
  if (/\bnext\s+(?:one\s+)?week\b/.test(text) || /\bcoming week\b/.test(text)) return 7;
  return null;
}

function extractStartDayOffset(message) {
  const text = String(message ?? "").toLowerCase();
  if (/\btomorrow\b/.test(text)) return 1;
  return 0;
}

function extractActivity(text) {
  if (/\b(stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|watch(?:ing)?\s+(?:the\s+)?stars?|stars?|meteor|night\s+sky|astronomy|telescope)\b/.test(text)) return "stargazing";
  if (/\bpicnic\b/.test(text)) return "picnic";
  if (/\bpark\b/.test(text)) return "park visit";
  if (/\bevent|festival|concert|wedding|market|activation\b/.test(text)) return "outdoor event";
  if (/\boutdoor|outside|outing\b/.test(text)) return "outdoor plan";
  return null;
}

function extractDaypart(text) {
  if (/\bmorning|am shift|early shift\b/.test(text)) return "morning";
  if (/\bafternoon|pm shift\b/.test(text)) return "afternoon";
  if (/\bevening|night event\b/.test(text)) return "evening";
  if (/\bovernight|night shift\b/.test(text)) return "overnight";
  if (/\ball day|whole day|full day\b/.test(text)) return "all_day";
  return null;
}

function localBusinessPersona(text) {
  if (/\b(amazon|package|shipment|parcel|deliver|delivery|deliveries|driver|route|last[-\s]?mile|logistics|carrier|dispatch)\b/.test(text)) {
    return "logistics_last_mile";
  }
  if (/\b(warehouse|yard|loading|dock|forklift|fulfillment|throughput)\b/.test(text)) return "warehouse_ops";
  if (/\b(field\s*service|crew|technician|maintenance|repair|site\s*visit)\b/.test(text)) return "field_service";
  if (/\b(utility|utilities|line\s*crew|outage|grid|substation|vegetation)\b/.test(text)) return "utility_ops";
  if (/\b(event|picnic|park|festival|concert|wedding|market|outdoor|outing)\b/.test(text)) return "event_planning";
  return "general";
}

function extractBusinessObjective(text) {
  if (/\bsla|otif|service\s+level\b/.test(text)) return "service level risk";
  if (/\bcost|dollar|revenue|profit|loss\b/.test(text)) return "financial impact";
  if (/\bstaffing|labor|headcount\b/.test(text)) return "staffing plan";
  if (/\bthroughput|backlog|loading\b/.test(text)) return "throughput or loading plan";
  if (/\bamazon|package|shipment|parcel|deliver|delivery|deliveries|route|driver\b/.test(text)) return "delivery exposure planning";
  return null;
}

function sanitizeStringList(value, fallback = [], limit = 6, maxLen = 100) {
  const source = Array.isArray(value) ? value : Array.isArray(fallback) ? fallback : [];
  return source
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().slice(0, maxLen))
    .slice(0, limit);
}

function localUserFriendlyGoal(intent, location, days, activity) {
  const place = location ? ` in ${location}` : " for the current map area";
  const time = days ? ` for the next ${days} day${days === 1 ? "" : "s"}` : "";
  if (intent === "event_planning") return `Help the user decide whether ${activity ?? "an outdoor plan"}${place}${time} looks reasonable.`;
  if (intent === "risk_explanation") return `Explain the weather risk${place} in plain language.`;
  if (intent === "compare_locations") return "Compare the requested places or current map context using weather risk signals.";
  if (intent === "map_context") return "Summarize the weather context for the current map view.";
  if (intent === "out_of_scope") return "Redirect the user to weather and dashboard questions.";
  return `Summarize the weather${place}${time} in plain language.`;
}

function extractLocation(message) {
  const cleaned = message.replace(/\s+/g, " ").trim();
  const patterns = [
    /^([A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|[A-Za-z .'-]+))$/i,
    /\b(?:house|home|site|job|work|repair|repairs|project|property)\s+is\s+in\s+([A-Z][A-Za-z .'-]{2,40})(?:[?.!,]|$)/i,
    /\b(?:house|home|site|job|work|repair|repairs|project|property).*?\b(?:in|near|around|at)\s+([A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|[A-Za-z .'-]+))(?:\b|[?.!,]|$)/i,
    /\b(?:amazon|package|shipment|parcel|delivery|deliveries|delivary).*?\b(?:in|near|around|at|for)\s+([A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|[A-Za-z .'-]+))(?:\b|[?.!,]|$)/i,
    /\b(?:amazon|package|shipment|parcel|delivery|deliveries|delivary).*?\b(?:in|near|around|at|for)\s+([A-Z][A-Za-z .'-]{2,40})(?:\s+(?:for|over|on|this|next|today|tomorrow|weekend|in\b)|[?.!,]|$)/i,
    /\b(?:in|near|at|for)\s+([A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|[A-Za-z .'-]+))(?:\b|[?.!,])/,
    /\b(?:in|near|at|for)\s+([A-Z][A-Za-z .'-]{2,40})(?:\s+(?:for|over|on|this|next|today|tomorrow|weekend|in\b)|[?.!,]|$)/i,
    /\bhow\s+does\s+([A-Z][A-Za-z .,'-]{2,60})\s+(?:look|feel|seem)\b/i,
    /\bwhat\s+about\s+([A-Z][A-Za-z .,'-]{2,60})(?:\s+(?:for|over|on|this|next|today|tomorrow|weekend|in\b)|[?.!,]|$)/i,
    /\baround\s+([A-Z][A-Za-z .'-]{2,40})(?:\s+(?:for|over|on|this|next|today|tomorrow|weekend|in\b)|[?.!,]|$)/i
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match?.[1]) {
      const candidate = cleanLocationCandidate(match[1]);
      if (isBadLocationCandidate(candidate)) continue;
      return fuzzyNormalizePlaceCandidate(candidate);
    }
  }
  return null;
}

function extractRouteLocations(message) {
  const cleaned = String(message ?? "").replace(/\s+/g, " ").trim();
  const patterns = [
    /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this|next|at|around|by|leaving|leave)\b|[?.!,]|$)/i,
    /\bbetween\s+(.+?)\s+and\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this|next|at|around|by|leaving|leave)\b|[?.!,]|$)/i,
    /\b(?:travel|drive|driving|trip|commute)\s+(?:from\s+)?(.+?)\s+to\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this|next|at|around|by|leaving|leave)\b|[?.!,]|$)/i
  ];
  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match?.[1] || !match?.[2]) continue;
    const first = cleanLocationCandidate(match[1]);
    const second = cleanLocationCandidate(match[2]);
    const locations = [first, second].filter((candidate) => !isBadLocationCandidate(candidate));
    if (locations.length >= 2) return dedupeStrings(locations).slice(0, 3);
  }
  return [];
}

function routeLocationsFromApplication(application, message) {
  const decoded = Array.isArray(application?.locations)
    ? application.locations.map(cleanLocationCandidate).filter((candidate) => !isBadLocationCandidate(candidate))
    : [];
  const extracted = extractRouteLocations(message);
  return dedupeStrings([...decoded, ...extracted]).slice(0, 3);
}

function dedupeStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function cleanLocationCandidate(value) {
  const text = String(value ?? "");
  const labeledLocation = text.match(/\blocation\s*:\s*([^;|]+)/i);
  return (labeledLocation?.[1] ?? text)
    .replace(/\s+(?:this|next)?\s*weekend\b.*$/i, "")
    .replace(/\s+(?:this|next|coming)\s+week\b.*$/i, "")
    .replace(/\s+(?:today|tomorrow|tonight)\b.*$/i, "")
    .replace(/\s+(?:around|at|by|about|near)\s+\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?\b.*$/i, "")
    .replace(/\s+(?:around|at|by|about|near)\s*$/i, "")
    .replace(/\s+(?:for|over|on)\s+(?:the\s+)?(?:next\s+)?\d{1,2}\s+days?\b.*$/i, "")
    .replace(/\s+(?:for|over|on)\s+(?:this|next|today|tomorrow)\b.*$/i, "")
    .replace(/\s+(?:is|are|was|were|do|does|did|should|would|will|can|could|wise|safe|good)\b.*$/i, "")
    .replace(
      /\s+(?:amazon|packages?|shipments?|parcels?|deliveries|delivery|drivers?|routes?|logistics|warehouse|loading|yard|operations?|field\s*service|utility\s*work|repairs?|repair|exterior|house|home)$/i,
      ""
    )
    .replace(/\b(the|a|an)$/i, "")
    .replace(/[?.!,]+$/g, "")
    .trim();
}

function isBadLocationCandidate(value) {
  const text = String(value ?? "").toLowerCase().trim();
  if (!text) return true;
  if (/^(my|the|a|an)\b/.test(text)) return true;
  if (/\b(ac|a\/c|air\s*condition(?:er|ing)?|thermostat|hvac|cooling|cooler|temperature(?:s)?|increase|decrease|setpoint)\b/.test(text)) return true;
  if (/\b(food|meal|order|delivery|deliveries|delivary|package|parcel|shipment|courier|driver|amazon|doordash|ubereats|uber eats|grubhub)\b/.test(text)) {
    return true;
  }
  if (/\b(watching?\s+stars?|watching\s+star|stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|night\s+sky|meteor|astronomy|telescope)\b/.test(text)) return true;
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)?\s*(ct|et|pt|mt)?$/i.test(text)) return true;
  return false;
}

async function resolveAssistantTarget(locationText, selected, center, context = {}) {
  if (locationText) {
    const geocoded = await geocodeLocation(locationText);
    if (geocoded) return geocoded;
    return null;
  }
  if (selected && Number.isFinite(Number(selected.lat)) && Number.isFinite(Number(selected.lon))) {
    const name = [selected.name, selected.state].filter(Boolean).join(", ") || "Selected region";
    return {
      label: name,
      point: {
        id: `assistant-${slugify(name)}`,
        kind: "refinement",
        domain: typeof selected.domain === "string" ? selected.domain : "conus",
        lat: Number(selected.lat),
        lon: Number(selected.lon)
      }
    };
  }
  if (center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lon))) {
    const nearest = nearestVisiblePoint(context, center);
    if (nearest) {
      const label = [nearest.name, nearest.state].filter(Boolean).join(", ") || "nearby map area";
      return {
        label,
        point: {
          id: `assistant-${slugify(label)}`,
          kind: "refinement",
          domain: domainForLatLon(Number(nearest.lat), Number(nearest.lon)),
          lat: Number(nearest.lat),
          lon: Number(nearest.lon)
        }
      };
    }
    const lat = Number(center.lat);
    const lon = Number(center.lon);
    return {
      label: `map area near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
      point: {
        id: "assistant-map-center",
        kind: "refinement",
        domain: domainForLatLon(lat, lon),
        lat,
        lon
      }
    };
  }
  return null;
}

function nearestVisiblePoint(context, center) {
  const points = Array.isArray(context?.visiblePoints) ? context.visiblePoints : [];
  const lat = Number(center?.lat);
  const lon = Number(center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !points.length) return null;
  let best = null;
  let bestMiles = Infinity;
  for (const point of points) {
    const pLat = Number(point?.lat);
    const pLon = Number(point?.lon);
    if (!Number.isFinite(pLat) || !Number.isFinite(pLon)) continue;
    const miles = distanceMiles(lat, lon, pLat, pLon);
    if (miles < bestMiles) {
      best = point;
      bestMiles = miles;
    }
  }
  const zoom = Number(context?.map?.zoom);
  const limit = Number.isFinite(zoom) && zoom >= 7 ? 90 : Number.isFinite(zoom) && zoom >= 5 ? 160 : 240;
  return best && bestMiles <= limit ? best : null;
}

function distanceMiles(aLat, aLon, bLat, bLon) {
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

async function geocodeLocation(query) {
  const known = knownPlace(fuzzyNormalizePlaceCandidate(query));
  if (known) return known;
  const openMeteo = await geocodeLocationOpenMeteo(query);
  if (openMeteo) return openMeteo;
  const p = new URLSearchParams({
    format: "jsonv2",
    countrycodes: "us",
    limit: "1",
    q: query
  });
  const rows = await cached(`geocode:nominatim:${query.toLowerCase()}`, 24 * 60 * 60_000, () =>
    fetchProviderJson(`${nominatimUrl}?${p.toString()}`, geocodeHeaders, { timeoutMs: 10_000, retries: 1 }).catch(() => null)
  );
  const first = Array.isArray(rows) ? rows[0] : null;
  const lat = Number(first?.lat);
  const lon = Number(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return geocodeLocationCensus(query);
  return {
    label: String(first.display_name ?? query).split(",").slice(0, 3).join(", "),
    point: {
      id: `assistant-${slugify(query)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

async function geocodeLocationOpenMeteo(query) {
  const parsed = parseCityState(query);
  const p = new URLSearchParams({
    name: parsed.city,
    count: "10",
    language: "en",
    format: "json"
  });
  const raw = await cached(`geocode:open-meteo:${query.toLowerCase()}`, 24 * 60 * 60_000, () =>
    fetchProviderJson(`${openMeteoGeocodeUrl}?${p.toString()}`, undefined, { timeoutMs: 10_000, retries: 1 }).catch(() => null)
  );
  const results = Array.isArray(raw?.results) ? raw.results : [];
  const stateName = parsed.state ? stateNameFor(parsed.state) : null;
  const candidates = results
    .filter((row) => row?.country_code === "US")
    .filter((row) => !stateName || String(row?.admin1 ?? "").toLowerCase() === stateName.toLowerCase())
    .sort((a, b) => Number(b?.population ?? 0) - Number(a?.population ?? 0));
  const best = candidates[0];
  const lat = Number(best?.latitude);
  const lon = Number(best?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const label = [best.name, stateAbbrevFor(best.admin1)].filter(Boolean).join(", ");
  return {
    label,
    point: {
      id: `assistant-${slugify(label)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

async function geocodeLocationCensus(query) {
  const p = new URLSearchParams({
    address: query,
    benchmark: "Public_AR_Current",
    format: "json"
  });
  const raw = await cached(`geocode:census:${query.toLowerCase()}`, 24 * 60 * 60_000, () =>
    fetchProviderJson(`${censusGeocodeUrl}?${p.toString()}`, undefined, { timeoutMs: 10_000, retries: 1 }).catch(() => null)
  );
  const match = raw?.result?.addressMatches?.[0];
  const lat = Number(match?.coordinates?.y);
  const lon = Number(match?.coordinates?.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    label: String(match.matchedAddress ?? query).split(",").slice(0, 3).join(", "),
    point: {
      id: `assistant-${slugify(query)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

function parseCityState(query) {
  const cleaned = query.replace(/\s+/g, " ").trim();
  const comma = cleaned.match(/^(.+?),\s*([A-Za-z]{2}|[A-Za-z .'-]+)$/);
  if (comma) return { city: comma[1].trim(), state: comma[2].trim() };
  const tail = cleaned.match(/^(.+?)\s+([A-Za-z]{2})$/);
  if (tail) return { city: tail[1].trim(), state: tail[2].trim() };
  return { city: cleaned, state: null };
}

function stateNameFor(value) {
  const key = value.toLowerCase().replace(/\./g, "").trim();
  return US_STATES[key] ?? value;
}

function stateAbbrevFor(name) {
  const found = Object.entries(US_STATES).find(([, full]) => full.toLowerCase() === String(name ?? "").toLowerCase());
  return found?.[0].toUpperCase() ?? name;
}

const US_STATES = {
  al: "Alabama",
  ak: "Alaska",
  az: "Arizona",
  ar: "Arkansas",
  ca: "California",
  co: "Colorado",
  ct: "Connecticut",
  de: "Delaware",
  fl: "Florida",
  ga: "Georgia",
  hi: "Hawaii",
  ia: "Iowa",
  id: "Idaho",
  il: "Illinois",
  in: "Indiana",
  ks: "Kansas",
  ky: "Kentucky",
  la: "Louisiana",
  ma: "Massachusetts",
  md: "Maryland",
  me: "Maine",
  mi: "Michigan",
  mn: "Minnesota",
  mo: "Missouri",
  ms: "Mississippi",
  mt: "Montana",
  nc: "North Carolina",
  nd: "North Dakota",
  ne: "Nebraska",
  nh: "New Hampshire",
  nj: "New Jersey",
  nm: "New Mexico",
  nv: "Nevada",
  ny: "New York",
  oh: "Ohio",
  ok: "Oklahoma",
  or: "Oregon",
  pa: "Pennsylvania",
  ri: "Rhode Island",
  sc: "South Carolina",
  sd: "South Dakota",
  tn: "Tennessee",
  tx: "Texas",
  ut: "Utah",
  va: "Virginia",
  vt: "Vermont",
  wa: "Washington",
  wi: "Wisconsin",
  wv: "West Virginia",
  wy: "Wyoming",
  dc: "District of Columbia"
};

const US_STATE_CENTROIDS = {
  alabama: ["Alabama", 32.8067, -86.7911],
  alaska: ["Alaska", 64.2008, -149.4937],
  arizona: ["Arizona", 34.0489, -111.0937],
  arkansas: ["Arkansas", 35.201, -91.8318],
  california: ["California", 36.7783, -119.4179],
  colorado: ["Colorado", 39.5501, -105.7821],
  connecticut: ["Connecticut", 41.6032, -73.0877],
  delaware: ["Delaware", 38.9108, -75.5277],
  florida: ["Florida", 27.6648, -81.5158],
  georgia: ["Georgia", 32.1656, -82.9001],
  hawaii: ["Hawaii", 19.8968, -155.5828],
  idaho: ["Idaho", 44.0682, -114.742],
  illinois: ["Illinois", 40.6331, -89.3985],
  indiana: ["Indiana", 40.2672, -86.1349],
  iowa: ["Iowa", 41.878, -93.0977],
  kansas: ["Kansas", 39.0119, -98.4842],
  kentucky: ["Kentucky", 37.8393, -84.27],
  louisiana: ["Louisiana", 30.9843, -91.9623],
  maine: ["Maine", 45.2538, -69.4455],
  maryland: ["Maryland", 39.0458, -76.6413],
  massachusetts: ["Massachusetts", 42.4072, -71.3824],
  michigan: ["Michigan", 44.3148, -85.6024],
  minnesota: ["Minnesota", 46.7296, -94.6859],
  mississippi: ["Mississippi", 32.3547, -89.3985],
  missouri: ["Missouri", 37.9643, -91.8318],
  montana: ["Montana", 46.8797, -110.3626],
  nebraska: ["Nebraska", 41.4925, -99.9018],
  nevada: ["Nevada", 38.8026, -116.4194],
  "new hampshire": ["New Hampshire", 43.1939, -71.5724],
  "new jersey": ["New Jersey", 40.0583, -74.4057],
  "new mexico": ["New Mexico", 34.5199, -105.8701],
  "north carolina": ["North Carolina", 35.7596, -79.0193],
  "north dakota": ["North Dakota", 47.5515, -101.002],
  ohio: ["Ohio", 40.4173, -82.9071],
  oklahoma: ["Oklahoma", 35.0078, -97.0929],
  oregon: ["Oregon", 43.8041, -120.5542],
  pennsylvania: ["Pennsylvania", 41.2033, -77.1945],
  "rhode island": ["Rhode Island", 41.5801, -71.4774],
  "south carolina": ["South Carolina", 33.8361, -81.1637],
  "south dakota": ["South Dakota", 43.9695, -99.9018],
  tennessee: ["Tennessee", 35.5175, -86.5804],
  texas: ["Texas", 31.9686, -99.9018],
  utah: ["Utah", 39.321, -111.0937],
  vermont: ["Vermont", 44.5588, -72.5778],
  virginia: ["Virginia", 37.4316, -78.6569],
  "west virginia": ["West Virginia", 38.5976, -80.4549],
  wisconsin: ["Wisconsin", 43.7844, -88.7879],
  wyoming: ["Wyoming", 43.076, -107.2903]
};

function knownPlace(query) {
  const key = query.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const places = {
    houston: ["Houston, TX", 29.7604, -95.3698],
    "houston tx": ["Houston, TX", 29.7604, -95.3698],
    austin: ["Austin, TX", 30.2672, -97.7431],
    "austin tx": ["Austin, TX", 30.2672, -97.7431],
    dallas: ["Dallas, TX", 32.7767, -96.797],
    "dallas tx": ["Dallas, TX", 32.7767, -96.797],
    phoenix: ["Phoenix, AZ", 33.4484, -112.074],
    seattle: ["Seattle, WA", 47.6062, -122.3321],
    chicago: ["Chicago, IL", 41.8781, -87.6298],
    rochester: ["Rochester, NY", 43.1566, -77.6088],
    "rochester ny": ["Rochester, NY", 43.1566, -77.6088],
    "niagara falls": ["Niagara Falls, NY", 43.0962, -79.0377],
    "niagara falls ny": ["Niagara Falls, NY", 43.0962, -79.0377],
    "niagra falls": ["Niagara Falls, NY", 43.0962, -79.0377],
    "niagra falls ny": ["Niagara Falls, NY", 43.0962, -79.0377],
    buffalo: ["Buffalo, NY", 42.8864, -78.8784],
    "buffalo ny": ["Buffalo, NY", 42.8864, -78.8784],
    "new york": ["New York, NY", 40.7128, -74.006],
    "new york ny": ["New York, NY", 40.7128, -74.006],
    "los angeles": ["Los Angeles, CA", 34.0522, -118.2437],
    "los angeles ca": ["Los Angeles, CA", 34.0522, -118.2437],
    miami: ["Miami, FL", 25.7617, -80.1918],
    denver: ["Denver, CO", 39.7392, -104.9903],
    atlanta: ["Atlanta, GA", 33.749, -84.388],
    birmingham: ["Birmingham, AL", 33.5186, -86.8104],
    "birmingham al": ["Birmingham, AL", 33.5186, -86.8104],
    "birmingham alabama": ["Birmingham, AL", 33.5186, -86.8104],
    boston: ["Boston, MA", 42.3601, -71.0589],
    boise: ["Boise, ID", 43.615, -116.2023],
    "boise id": ["Boise, ID", 43.615, -116.2023],
    "san francisco": ["San Francisco, CA", 37.7749, -122.4194],
    "san diego": ["San Diego, CA", 32.7157, -117.1611]
  };
  const hit = places[key];
  if (!hit) return knownStatePlace(key);
  const [label, lat, lon] = hit;
  return {
    label,
    point: {
      id: `assistant-${slugify(label)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

function knownStatePlace(key) {
  const hit = US_STATE_CENTROIDS[key];
  if (!hit) return null;
  const [label, lat, lon] = hit;
  return {
    label,
    point: {
      id: `assistant-${slugify(label)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

function buildAssistantAdvisory(message, context, target, raw, interpretation, capability = null) {
  const daily = raw?.daily ?? {};
  const current = raw?.current ?? {};
  const provider = String(raw?.source?.provider ?? context?.sourceBadge ?? "dashboard");
  const requestedDays = interpretation?.timeRangeDays ?? 4;
  const days = nextAssistantDays(daily, current, requestedDays, extractStartDayOffset(message));
  const alerts = dedupeAlerts(contextAlertsForTarget(context, target));
  const impactAlerts = relevantPlanningAlerts(alerts, message);
  const informationalAlerts = alerts.filter((alert) => !impactAlerts.includes(alert));
  const seriousAlert = hasSeriousAlert(impactAlerts);
  const applicationKind = capability?.applicationReasoning?.applicationKind ?? null;
  const skyApplication = isSkyApplication(applicationKind);
  const bestWindows = days
    .map((day) => ({
      label: day.label,
      score: skyApplication ? skySuitabilityScore(day, impactAlerts) : suitabilityScore(day, impactAlerts),
      rationale: skyApplication ? skyWindowRationale(day, seriousAlert ? [] : impactAlerts) : windowRationale(day, seriousAlert ? [] : impactAlerts)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const risks = skyApplication ? skyRiskList(days, impactAlerts, informationalAlerts) : riskList(days, impactAlerts, informationalAlerts);
  const verdict = seriousAlert ? "avoid" : verdictFromScore(bestWindows[0]?.score, risks);
  const location = target?.label ?? "the current map area";
  const persona = capability?.persona ?? { label: "General planning" };
  const action = target
    ? [{ type: "flyTo", lat: target.point.lat, lon: target.point.lon, zoom: 8, label: target.label }]
    : [];
  return {
    answer: skyApplication
      ? skyFallbackAnswer(location, verdict, bestWindows, risks, seriousAlert)
      : isHomeCoolingApplication(applicationKind)
        ? homeCoolingFallbackAnswer(location, days, risks, seriousAlert)
      : isComfortApplication(applicationKind)
        ? comfortFallbackAnswer(location, days, risks, applicationKind)
        : fallbackAnswer(location, verdict, bestWindows, risks, provider, seriousAlert, capability),
    verdict,
    confidence: raw ? "medium" : "low",
    bestWindows: seriousAlert ? [] : bestWindows,
    risks,
    dataUsed: [provider, "Dashboard context", persona.label, alerts.length ? "NWS alert context" : "No severe/extreme alerts in context"].filter(
      Boolean
    ),
    guardrailNote:
      "Friendly planning guidance only. For severe weather, lightning, heat illness, evacuation, or emergency decisions, follow NWS/local officials and site safety plans.",
    actions: action,
    answerType: capability?.scopeClass ?? "in_scope_weather",
    persona: persona.label,
    capabilityNote: capability?.reason ?? "Weather and dashboard context only.",
    missingData: capability?.missingData ?? [],
    facts: {
      question: message,
      interpretation,
      location,
      provider,
      current: {
        tempF: numberOrNull(current.temperature_2m),
        apparentF: numberOrNull(current.apparent_temperature),
        humidityPct: numberOrNull(current.relative_humidity_2m),
        windMph: numberOrNull(current.wind_speed_10m),
        precipIn: numberOrNull(current.precipitation),
        cloudCoverPct: numberOrNull(current.cloud_cover)
      },
      days,
      hourly: compactHourlyForecast(raw?.hourly),
      alerts: impactAlerts,
      informationalAlerts,
      activeLayer: context?.activeLayer ?? null,
      timeIdx: context?.timeIdx ?? null,
      sourceBadge: context?.sourceBadge ?? null
    }
  };
}

function nextAssistantDays(daily, current, count = 4, startOffset = 0) {
  const dates = Array.isArray(daily?.time) ? daily.time : nextDates(4);
  const limit = Math.max(1, Math.min(16, Number(count) || 4));
  const start = Math.max(0, Math.min(Math.max(0, dates.length - 1), Number(startOffset) || 0));
  return dates.slice(start, start + limit).map((date, idx) => {
    const i = start + idx;
    const hi = numberOrNull(daily.temperature_2m_max?.[i]);
    const lo = numberOrNull(daily.temperature_2m_min?.[i]);
    const apparent = numberOrNull(daily.apparent_temperature_max?.[i]) ?? hi;
    const precip = numberOrNull(daily.precipitation_sum?.[i]);
    const wind = numberOrNull(daily.wind_speed_10m_max?.[i]);
    const cloud = numberOrNull(daily.cloud_cover_mean?.[i]);
    return {
      date,
      label: labelDate(date),
      tempHighF: hi,
      tempLowF: lo,
      heatIndexF: apparent,
      precipIn: precip,
      windMaxMph: wind,
      cloudCoverPct: cloud,
      humidityPct: start === 0 && idx === 0 ? numberOrNull(current.relative_humidity_2m) : null
    };
  });
}

function suitabilityScore(day, alerts) {
  let score = 100;
  const heat = day.heatIndexF ?? day.tempHighF;
  if (heat != null && heat >= 103) score -= 45;
  else if (heat != null && heat >= 95) score -= 28;
  else if (heat != null && heat >= 88) score -= 14;
  if (day.precipIn != null && day.precipIn >= 0.5) score -= 35;
  else if (day.precipIn != null && day.precipIn >= 0.15) score -= 18;
  if (day.windMaxMph != null && day.windMaxMph >= 35) score -= 32;
  else if (day.windMaxMph != null && day.windMaxMph >= 25) score -= 16;
  if (alerts.length) score -= 28;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function skySuitabilityScore(day, alerts) {
  let score = 100;
  const cloud = numberOrNull(day.cloudCoverPct);
  if (cloud != null && cloud >= 85) score -= 62;
  else if (cloud != null && cloud >= 65) score -= 42;
  else if (cloud != null && cloud >= 45) score -= 24;
  else if (cloud != null && cloud >= 25) score -= 10;
  else if (cloud == null) score -= 18;
  const precip = numberOrNull(day.precipIn);
  if (precip != null && precip >= 0.15) score -= 35;
  else if (precip != null && precip > 0) score -= 14;
  const wind = numberOrNull(day.windMaxMph);
  if (wind != null && wind >= 25) score -= 22;
  else if (wind != null && wind >= 18) score -= 10;
  if (alerts.length) score -= hasSeriousAlert(alerts) ? 45 : 20;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function dedupeAlerts(alerts) {
  const seen = new Set();
  const result = [];
  for (const alert of alerts) {
    const event = String(alert?.event ?? "Severe weather alert");
    const area = String(alert?.areaDesc ?? "");
    const effective = typeof alert?.effective === "string" ? alert.effective : undefined;
    const expires = typeof alert?.expires === "string" ? alert.expires : undefined;
    const key = `${event.toLowerCase()}|${area.slice(0, 80).toLowerCase()}|${effective ?? ""}|${expires ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...alert, event, areaDesc: area, effective, expires });
  }
  return result.slice(0, 3);
}

function contextAlertsForTarget(context, target) {
  const alerts = Array.isArray(context?.alerts) ? context.alerts : [];
  if (!alerts.length) return [];
  if (!target?.point || !context?.map?.bounds) return alerts;
  if (!pointInBounds(target.point, context.map.bounds)) return [];
  const alertsWithBoxes = alerts.filter((alert) => alert?.bbox);
  if (alertsWithBoxes.length) return alertsWithBoxes.filter((alert) => pointInBounds(target.point, alert.bbox));
  return alerts;
}

function pointInBounds(point, bounds) {
  const lat = Number(point?.lat);
  const lon = Number(point?.lon);
  const north = Number(bounds?.north);
  const south = Number(bounds?.south);
  const east = Number(bounds?.east);
  const west = Number(bounds?.west);
  if (![lat, lon, north, south, east, west].every(Number.isFinite)) return false;
  return lat <= north && lat >= south && lon <= east && lon >= west;
}

function sanitizeConversationState(value) {
  if (!value || typeof value !== "object") return null;
  const pendingSlot = value.pendingSlot === "delivery_time_window" ? "delivery_time_window" : null;
  const plannerPlan = value.plannerPlan && typeof value.plannerPlan === "object" ? verifyPlannerPlan(value.plannerPlan, {}) : null;
  const pendingFacts = sanitizeStringList(value.pendingFacts, plannerPlan?.pendingFacts ?? [], 4, 60);
  if (!pendingSlot && !plannerPlan && !pendingFacts.length) return null;
  return {
    pendingSlot,
    questionFamily: typeof value.questionFamily === "string" ? value.questionFamily.slice(0, 80) : null,
    originalQuestion: typeof value.originalQuestion === "string" ? value.originalQuestion.slice(0, 400) : null,
    locationLabel: typeof value.locationLabel === "string" ? value.locationLabel.slice(0, 120) : null,
    lat: Number.isFinite(Number(value.lat)) ? Number(value.lat) : null,
    lon: Number.isFinite(Number(value.lon)) ? Number(value.lon) : null,
    persona: typeof value.persona === "string" ? value.persona.slice(0, 80) : null,
    businessObjective: typeof value.businessObjective === "string" ? value.businessObjective.slice(0, 120) : null,
    plannerPlan,
    pendingFacts
  };
}

function targetFromConversationState(state, context = {}) {
  const lat = Number(state?.lat);
  const lon = Number(state?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const inferred = nearestVisiblePoint(context, { lat, lon });
  const inferredLabel = inferred ? [inferred.name, inferred.state].filter(Boolean).join(", ") : null;
  const generic = !state.locationLabel || /current map center|map area/i.test(state.locationLabel);
  const label = generic ? inferredLabel || `map area near ${lat.toFixed(2)}, ${lon.toFixed(2)}` : state.locationLabel;
  return {
    label,
    point: {
      id: `assistant-${slugify(label)}`,
      kind: "refinement",
      domain: domainForLatLon(lat, lon),
      lat,
      lon
    }
  };
}

function shouldAskDeliveryTime(message, interpretation = {}, application = null) {
  if (!isDeliveryOutcomeQuestion(message, interpretation, application)) return false;
  return !extractDeliveryWindow(message);
}

function isDeliveryOutcomeQuestion(message, interpretation = {}, application = null) {
  const text = `${message} ${interpretation.businessObjective ?? ""} ${interpretation.activity ?? ""}`.toLowerCase();
  if (isDeliveryApplication(application)) return true;
  return (
    /\b(food|meal|order|restaurant|doordash|uber\s*eats|ubereats|grubhub|amazon|package|shipment|parcel|delivery|deliveries|delivary|tracking|eta)\b/.test(text) &&
    /\b(delay|delayed|late|arriv|eta|make it|delivered|tracking)\b/.test(text)
  );
}

function safeFollowupQuestion(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 220) return fallback;
  if (!/\b(time|window|morning|afternoon|evening|when|delivery|expect)/i.test(trimmed)) return fallback;
  return trimmed.replace(/\s+/g, " ");
}

function extractDeliveryWindow(message) {
  const text = String(message ?? "").toLowerCase();
  const dayOffset = /\btomorrow\b/.test(text) ? 1 : 0;
  const explicit = text.match(/\b(?:around|at|by|about|near)?\s*(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (explicit) {
    let hour = Number(explicit[1]) % 12;
    if (explicit[3] === "pm") hour += 12;
    const minute = explicit[2] ?? "00";
    return {
      label: `${dayOffset ? "tomorrow " : "today "}${formatHourLabel(hour, minute)}`,
      dayOffset,
      daypart: daypartForHour(hour),
      startHour: Math.max(0, hour - 1),
      endHour: Math.min(24, hour + 1)
    };
  }
  const military = text.match(/\b(?:around|at|by|about|near)?\s*([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (military) {
    const hour = Number(military[1]);
    return {
      label: `${dayOffset ? "tomorrow " : "today "}${formatHourLabel(hour, military[2])}`,
      dayOffset,
      daypart: daypartForHour(hour),
      startHour: Math.max(0, hour - 1),
      endHour: Math.min(24, hour + 1)
    };
  }
  if (/\bmorning|am shift|early\b/.test(text)) return { label: `${dayOffset ? "tomorrow " : "today "}morning`, dayOffset, daypart: "morning", startHour: 6, endHour: 12 };
  if (/\bafternoon|pm shift\b/.test(text)) return { label: `${dayOffset ? "tomorrow " : "today "}afternoon`, dayOffset, daypart: "afternoon", startHour: 12, endHour: 17 };
  if (/\bevening|tonight\b/.test(text)) return { label: `${dayOffset ? "tomorrow " : "today "}evening`, dayOffset, daypart: "evening", startHour: 17, endHour: 22 };
  if (/\bovernight|night shift\b/.test(text)) return { label: `${dayOffset ? "tomorrow " : "today "}overnight`, dayOffset, daypart: "overnight", startHour: 22, endHour: 24 };
  return null;
}

function deliveryWindowFromPlannerTime(timeWindow) {
  const type = String(timeWindow?.type ?? "");
  const value = String(timeWindow?.value ?? "");
  if (!value || type === "none") return null;
  const synthetic = value === "tomorrow" ? "tomorrow evening" : value;
  return extractDeliveryWindow(synthetic);
}

function compactHourlyForecast(hourly) {
  if (!hourly || typeof hourly !== "object" || !Array.isArray(hourly.time)) return [];
  return hourly.time.slice(0, 16 * 24).map((time, index) => ({
    time: String(time ?? ""),
    tempF: numberOrNull(hourly.temperature_2m?.[index]),
    apparentF: numberOrNull(hourly.apparent_temperature?.[index]),
    precipIn: numberOrNull(hourly.precipitation?.[index]),
    windMph: numberOrNull(hourly.wind_speed_10m?.[index]),
    cloudCoverPct: numberOrNull(hourly.cloud_cover?.[index])
  }));
}

function hourlySummaryForWindow(hourlyRows, window) {
  if (!Array.isArray(hourlyRows) || !hourlyRows.length || !window) return null;
  const targetDate = nextDates(Math.max(2, window.dayOffset + 1))[window.dayOffset];
  if (!targetDate) return null;
  const rows = hourlyRows.filter((row) => {
    const text = String(row?.time ?? "");
    if (text.slice(0, 10) !== targetDate) return false;
    const hour = Number(text.slice(11, 13));
    return Number.isFinite(hour) && hour >= window.startHour && hour < window.endHour;
  });
  if (!rows.length) return null;
  return {
    rows,
    precipIn: sumNumbers(rows.map((row) => row.precipIn)),
    windMph: maxNumber(rows.map((row) => row.windMph)),
    apparentF: maxNumber(rows.map((row) => row.apparentF ?? row.tempF)),
    tempF: maxNumber(rows.map((row) => row.tempF)),
    cloudCoverPct: meanNumber(rows.map((row) => row.cloudCoverPct))
  };
}

function weatherDelayRisk(advisory, window) {
  const days = advisory?.facts?.days ?? [];
  const targetDate = nextDates(Math.max(2, window.dayOffset + 1))[window.dayOffset];
  const day = days.find((item) => item?.date === targetDate) ?? days[Math.min(window.dayOffset, Math.max(0, days.length - 1))] ?? days[0] ?? {};
  const hourly = hourlySummaryForWindow(advisory?.facts?.hourly, window);
  const alerts = Array.isArray(advisory?.facts?.alerts) ? advisory.facts.alerts : [];
  const overlappingAlerts = alerts.filter((alert) => alertOverlapsDeliveryWindow(alert, window));
  let score = 0;
  const reasons = [];
  if (overlappingAlerts.length) {
    score += hasSeriousAlert(overlappingAlerts) ? 60 : 35;
    reasons.push(`there ${overlappingAlerts.length === 1 ? "is" : "are"} active alert${overlappingAlerts.length === 1 ? "" : "s"} overlapping that window`);
  }
  const precip = hourly ? numberOrNull(hourly.precipIn) : numberOrNull(day.precipIn);
  if (precip != null && precip >= 0.5) {
    score += 30;
    reasons.push(`rain looks meaningful, around ${precip.toFixed(2)} inches ${hourly ? "during that window" : "for the day"}`);
  } else if (precip != null && precip >= 0.15) {
    score += 15;
    reasons.push(`some rain is in the forecast ${hourly ? "during that window" : ""}`.trim());
  }
  const wind = hourly ? numberOrNull(hourly.windMph) : numberOrNull(day.windMaxMph);
  if (wind != null && wind >= 35) {
    score += 30;
    reasons.push(`winds may be strong, near ${Math.round(wind)} mph ${hourly ? "during that window" : ""}`.trim());
  } else if (wind != null && wind >= 25) {
    score += 15;
    reasons.push(`winds look breezy, near ${Math.round(wind)} mph ${hourly ? "during that window" : ""}`.trim());
  }
  const heat = hourly ? numberOrNull(hourly.apparentF ?? hourly.tempF) : numberOrNull(day.heatIndexF ?? day.tempHighF);
  if (heat != null && heat >= 103) {
    score += 15;
    reasons.push(`heat could stress outdoor delivery work, feeling near ${Math.round(heat)}F ${hourly ? "during that window" : ""}`.trim());
  } else if (heat != null && heat >= 95) {
    score += 8;
    reasons.push(`it may feel hot, near ${Math.round(heat)}F ${hourly ? "during that window" : ""}`.trim());
  }
  const level = score >= 55 ? "high" : score >= 20 ? "moderate" : "low";
  const risks = [
    ...overlappingAlerts.map((alert) => `Alert overlapping delivery window: ${alert.event ?? "weather alert"}${alertTiming(alert)}.`),
    ...reasons.filter((reason) => !/^there (is|are) active alert/.test(reason))
  ];
  return {
    level,
    reason: reasons.length
      ? `The main weather signal is that ${sentenceList(reasons)}.`
      : hourly
        ? "I do not see a major hourly weather alert, rain, wind, or heat signal in that rough window."
        : "I do not see a major weather alert, rain, wind, or heat signal overlapping that rough window.",
    risks: risks.length ? risks.slice(0, 5) : ["No major weather-related delivery disruption signal in that rough window."]
  };
}

function alertOverlapsDeliveryWindow(alert, window) {
  const start = parseAlertDate(alert?.effective);
  const end = parseAlertDate(alert?.expires);
  if (!start && !end) return true;
  const interval = deliveryWindowDates(window);
  if (!interval) return true;
  const alertStart = start ?? new Date(0);
  const alertEnd = end ?? new Date(8640000000000000);
  return alertStart <= interval.end && alertEnd >= interval.start;
}

function deliveryWindowDates(window) {
  const date = nextDates(Math.max(2, window.dayOffset + 1))[window.dayOffset];
  if (!date) return null;
  const start = new Date(`${date}T${String(window.startHour).padStart(2, "0")}:00:00`);
  const endHour = Math.min(23, window.endHour);
  const endMinute = window.endHour >= 24 ? "59" : "00";
  const end = new Date(`${date}T${String(endHour).padStart(2, "0")}:${endMinute}:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  return { start, end };
}

function daypartForHour(hour) {
  if (hour < 6) return "overnight";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 22) return "evening";
  return "overnight";
}

function formatHourLabel(hour, minute = "00") {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  return `${h}:${minute} ${suffix}`;
}

function hasSeriousAlert(alerts) {
  return alerts.some((alert) => /warning|tornado|severe|extreme|flash flood|evac/i.test(String(alert?.event ?? alert?.severity ?? "")));
}

function relevantPlanningAlerts(alerts, message) {
  const marineQuestion = /\b(marine|boat|boating|lake|waterfront|shore|ferry|harbor|bay)\b/i.test(String(message ?? ""));
  return alerts.filter((alert) => marineQuestion || !isMarineAlert(alert));
}

function isMarineAlert(alert) {
  return /\bmarine|small craft|gale|storm warning|waterspout\b/i.test(String(alert?.event ?? ""));
}

function windowRationale(day, alerts) {
  const parts = [];
  const heat = day.heatIndexF ?? day.tempHighF;
  if (heat != null) parts.push(describeHeat(heat));
  if (day.precipIn != null) parts.push(describeRain(day.precipIn));
  if (day.windMaxMph != null) parts.push(describeWind(day.windMaxMph));
  if (alerts.length) parts.push("there is active weather to keep an eye on");
  return sentenceList(parts) || "the forecast details are limited, so I would keep plans flexible";
}

function skyWindowRationale(day, alerts) {
  const parts = [];
  const cloud = numberOrNull(day.cloudCoverPct);
  if (cloud != null) parts.push(describeCloudCover(cloud));
  if (day.precipIn != null) parts.push(describeRain(day.precipIn));
  if (day.windMaxMph != null) parts.push(describeWind(day.windMaxMph));
  if (alerts.length) parts.push("there is active weather nearby");
  return sentenceList(parts) || "cloud-cover details are limited, so I would treat this as a rough screening only";
}

function riskList(days, alerts, informationalAlerts = []) {
  const risks = [];
  const maxHeat = maxNumber(days.map((d) => d.heatIndexF ?? d.tempHighF));
  const maxWind = maxNumber(days.map((d) => d.windMaxMph));
  const maxRain = maxNumber(days.map((d) => d.precipIn));
  if (maxHeat != null && maxHeat >= 95) risks.push(`It could feel pretty hot, with the warmest stretch near ${Math.round(maxHeat)}F.`);
  if (maxWind != null && maxWind >= 25) risks.push(`Winds may be noticeable, topping out near ${Math.round(maxWind)} mph.`);
  if (maxRain != null && maxRain >= 0.15) risks.push(`Rain could interfere at times, with the wettest day around ${maxRain.toFixed(2)} inches.`);
  for (const alert of alerts) risks.push(`Active alert nearby: ${alert.event ?? "severe weather"}${alertTiming(alert)}.`);
  for (const alert of informationalAlerts.filter(isMarineAlert).slice(0, 1)) {
    risks.push(`Marine alert nearby: ${alert.event ?? "marine weather"}${alertTiming(alert)}. Mainly relevant for boating or waterfront activity.`);
  }
  if (!risks.length) risks.push("I do not see a major heat, wind, rain, or severe-alert problem in the current map context.");
  return risks.slice(0, 6);
}

function skyRiskList(days, alerts, informationalAlerts = []) {
  const risks = [];
  const maxCloud = maxNumber(days.map((day) => day.cloudCoverPct));
  const minCloud = minNumber(days.map((day) => day.cloudCoverPct));
  const maxRain = maxNumber(days.map((day) => day.precipIn));
  const maxWind = maxNumber(days.map((day) => day.windMaxMph));
  if (minCloud == null) risks.push("Cloud-cover data is missing, so this is not a confident stargazing read.");
  else if (maxCloud != null && maxCloud >= 75) risks.push(`Some periods look pretty cloudy, with cloud cover reaching about ${Math.round(maxCloud)}%.`);
  else if (minCloud <= 30) risks.push(`The clearest signal gets down near ${Math.round(minCloud)}% cloud cover.`);
  if (maxRain != null && maxRain >= 0.15) risks.push(`Rain could interfere, with the wettest day around ${maxRain.toFixed(2)} inches.`);
  if (maxWind != null && maxWind >= 18) risks.push(`Winds may make viewing less comfortable, topping out near ${Math.round(maxWind)} mph.`);
  for (const alert of alerts) risks.push(`Active alert nearby: ${alert.event ?? "weather alert"}${alertTiming(alert)}.`);
  for (const alert of informationalAlerts.filter(isMarineAlert).slice(0, 1)) {
    risks.push(`Marine alert nearby: ${alert.event ?? "marine weather"}${alertTiming(alert)}. Mainly relevant near water.`);
  }
  if (!risks.length) risks.push("Clouds, rain, wind, and severe-alert signals look fairly cooperative for a rough sky check.");
  return risks.slice(0, 6);
}

function alertTiming(alert) {
  const start = parseAlertDate(alert?.effective);
  const end = parseAlertDate(alert?.expires);
  if (start && end) return ` from ${formatAlertTime(start)} to ${formatAlertTime(end)}`;
  if (end) return ` until ${formatAlertTime(end)}`;
  if (start) return ` effective ${formatAlertTime(start)}`;
  return "";
}

function parseAlertDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatAlertTime(date) {
  return date.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
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
  if (inches >= 0.5) return `rain could be a real spoiler`;
  if (inches >= 0.15) return `some rain is possible`;
  if (inches > 0) return `only a little rain shows up`;
  return `rain does not show up much`;
}

function describeWind(mph) {
  const rounded = Math.round(mph);
  if (rounded >= 35) return `winds could be strong, near ${rounded} mph`;
  if (rounded >= 25) return `winds may be breezy, near ${rounded} mph`;
  if (rounded >= 15) return `there may be a light breeze`;
  return `winds look pretty gentle`;
}

function describeCloudCover(percent) {
  const rounded = Math.round(percent);
  if (rounded >= 85) return `the sky looks mostly cloudy, around ${rounded}% cloud cover`;
  if (rounded >= 65) return `clouds may get in the way, around ${rounded}% cloud cover`;
  if (rounded >= 45) return `cloud cover is mixed, around ${rounded}%`;
  if (rounded >= 25) return `there are some clouds, around ${rounded}%`;
  return `cloud cover looks fairly low, around ${rounded}%`;
}

function sentenceList(parts) {
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function maxNumber(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  return xs.length ? Math.max(...xs) : null;
}

function minNumber(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  return xs.length ? Math.min(...xs) : null;
}

function meanNumber(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function sumNumbers(values) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) : null;
}

function verdictFromScore(score, risks) {
  if (score == null) return "insufficient_data";
  if (risks.some((risk) => /alert|lightning|severe|extreme/i.test(risk)) && score < 65) return "avoid";
  if (score >= 78) return "good";
  if (score >= 55) return "marginal";
  return "avoid";
}

function fallbackAnswer(location, verdict, bestWindows, risks, provider, seriousAlert = false, capability = null) {
  const top = bestWindows[0];
  const personaLabel = capability?.persona?.label ?? "General planning";
  const partial =
    capability?.answerability === "answerable_partially" && capability?.missingData?.length
      ? ` I can read the weather side, but I do not have ${capability.missingData.join(", ")}.`
      : "";
  const businessScope = capability?.scopeClass === "in_scope_business_relevance" || capability?.scopeClass === "in_scope_partial_business";
  if (seriousAlert) {
    const alertText = risks.find((risk) => /active alert/i.test(risk)) ?? "There is active severe weather nearby.";
    return `${location} does not look like a good weather window right now. ${alertText}${partial} I would wait until the alert window clears, then recheck before committing. For safety decisions, follow NWS/local officials and your site plan.`;
  }
  const lead =
    verdict === "good"
      ? `${location} looks workable weather-wise${businessScope ? ` for ${personaLabel.toLowerCase()}` : ""}.`
      : verdict === "marginal"
        ? `${location} is possible, but I would plan around a few weather wrinkles.`
        : verdict === "avoid"
          ? `${location} looks risky enough that I would be cautious.`
          : `I do not have enough reliable weather data for ${location}, and I refuse to bluff with a forecast.`;
  const best = top ? ` Best window I see: ${top.label}, because ${top.rationale}.` : "";
  const watchRisk = risks.find((risk) => !/do not see a major|no major/i.test(risk));
  const watch = watchRisk ? ` Watch-out: ${watchRisk}` : "";
  return `${lead}${partial}${best}${watch} Recheck close to go-time, especially for safety-sensitive work.`;
}

function isComfortApplication(kind) {
  return ["personal_comfort", "clothing_guidance", "travel_packing"].includes(kind);
}

function isHomeCoolingApplication(kind) {
  return kind === "home_hvac";
}

function isSkyApplication(applicationOrKind) {
  const kind = typeof applicationOrKind === "string" ? applicationOrKind : applicationOrKind?.applicationKind;
  return kind === "stargazing";
}

function shouldCompareSkyLocations(message, interpretation = {}, explicitLocation = null) {
  if (explicitLocation) return false;
  const text = String(message ?? "").toLowerCase();
  return (
    /\b(which|where|best|better|good choice|recommend|pick|choose|location|place|spot)\b/.test(text) ||
    interpretation?.asksForComparison === true
  );
}

function skyComparisonRisks(best, ranked) {
  const risks = [];
  if (best?.firstDay) {
    const cloud = numberOrNull(best.firstDay.cloudCoverPct);
    if (cloud != null) risks.push(`Best visible-map candidate has about ${Math.round(cloud)}% mean cloud cover for the first forecast day.`);
  }
  if (ranked.some((item) => item.alerts?.length)) risks.push("At least one candidate has nearby active weather alerts; treat those as safety-first context.");
  risks.push("This does not include light pollution, moon phase, smoke or haze, or astronomical seeing.");
  return risks.slice(0, 4);
}

function skyComparisonAnswer(best, ranked) {
  const top = ranked.slice(0, 3);
  const lines = top
    .map((item, index) => {
      const day = item.firstDay ?? {};
      const cloud = numberOrNull(day.cloudCoverPct);
      const rain = numberOrNull(day.precipIn);
      const wind = numberOrNull(day.windMaxMph);
      const pieces = [
        cloud == null ? "cloud data limited" : `${Math.round(cloud)}% cloud cover`,
        rain == null ? null : `${rain.toFixed(2)} in rain`,
        wind == null ? null : `${Math.round(wind)} mph wind`
      ].filter(Boolean);
      return `${index + 1}. ${item.label}: ${pieces.join(", ")}`;
    })
    .join(" ");
  const cloud = numberOrNull(best?.firstDay?.cloudCoverPct);
  const lead =
    cloud != null && cloud <= 35
      ? `${best.label} looks like the best stargazing pick in the current map view.`
      : `${best.label} is the best of the visible options, but it is only a rough stargazing pick.`;
  return `${lead} I am mainly using cloud cover, rain, wind, and alerts here. Top options: ${lines} I am not checking light pollution, moon phase, smoke/haze, or true astronomical seeing yet.`;
}

function skyFallbackAnswer(location, verdict, bestWindows, risks, seriousAlert = false) {
  const top = bestWindows[0];
  if (seriousAlert) {
    const alertText = risks.find((risk) => /active alert/i.test(risk)) ?? "There is active weather nearby.";
    return `${location} is not a good stargazing pick right now. ${alertText} I would wait until that alert window clears and then recheck the sky.`;
  }
  if (!top) {
    return `I do not have enough cloud-cover data for ${location} to make a good stargazing call.`;
  }
  const lead =
    verdict === "good"
      ? `${location} looks pretty promising for a rough stargazing check.`
      : verdict === "marginal"
        ? `${location} might work for stargazing, but the sky has a few wrinkles.`
        : `${location} does not look like a great stargazing pick from the current forecast.`;
  const watch = risks.length ? ` Watch-outs: ${risks.slice(0, 2).join(" ")}` : "";
  return `${lead} Best day in this forecast slice is ${top.label}: ${top.rationale}.${watch} This is weather-only: no light pollution, moon phase, smoke/haze, or telescope seeing model yet.`;
}

function comfortFallbackAnswer(location, days, risks, applicationKind) {
  const highs = days.map((day) => numberOrNull(day.heatIndexF ?? day.tempHighF)).filter((value) => value != null);
  const lows = days.map((day) => numberOrNull(day.tempLowF)).filter((value) => value != null);
  const rains = days.map((day) => numberOrNull(day.precipIn)).filter((value) => value != null);
  const winds = days.map((day) => numberOrNull(day.windMaxMph)).filter((value) => value != null);
  const maxHeat = highs.length ? Math.max(...highs) : null;
  const minLow = lows.length ? Math.min(...lows) : null;
  const maxRain = rains.length ? Math.max(...rains) : null;
  const maxWind = winds.length ? Math.max(...winds) : null;
  const range =
    maxHeat != null && minLow != null
      ? `The next stretch in ${location} looks roughly ${Math.round(minLow)}F to ${Math.round(maxHeat)}F.`
      : `I have some forecast signal for ${location}, but the temperature range is incomplete.`;
  const pieces = [];
  if (maxHeat != null && maxHeat >= 95) {
    pieces.push("go with very breathable, light-colored clothing, sunglasses or a hat, and a water bottle");
  } else if (maxHeat != null && maxHeat >= 85) {
    pieces.push("light summer clothing should work best during the day");
  } else if (maxHeat != null && maxHeat >= 70) {
    pieces.push("normal warm-weather clothing should be comfortable");
  } else if (maxHeat != null) {
    pieces.push("bring a warmer layer because it does not look especially hot");
  }
  if (minLow != null && minLow <= 60) pieces.push("add a light jacket or hoodie for mornings and evenings");
  if (maxRain != null && maxRain >= 0.15) pieces.push("keep a compact umbrella or light rain jacket handy");
  if (maxWind != null && maxWind >= 20) pieces.push("skip loose hats or flimsy outer layers when it gets breezy");
  const advice = pieces.length ? sentenceList(pieces) : "dress in flexible layers and check the day-of forecast before heading out";
  const lead =
    applicationKind === "travel_packing"
      ? "For packing, I would keep it practical:"
      : applicationKind === "personal_comfort"
        ? "Comfort-wise, it does not look too extreme:"
        : "For clothing, I would keep it simple:";
  const watch = risks.length ? ` Also, ${lowerFirst(risks.slice(0, 2).join(" "))}` : "";
  return `${range} ${lead} ${advice}.${watch}`;
}

function homeCoolingFallbackAnswer(location, days, risks, seriousAlert = false) {
  const highs = days.map((day) => numberOrNull(day.heatIndexF ?? day.tempHighF)).filter((value) => value != null);
  const lows = days.map((day) => numberOrNull(day.tempLowF)).filter((value) => value != null);
  const humidity = days.map((day) => numberOrNull(day.humidityPct)).filter((value) => value != null);
  const maxHeat = highs.length ? Math.max(...highs) : null;
  const minLow = lows.length ? Math.min(...lows) : null;
  const avgHumidity = humidity.length ? meanNumber(humidity) : null;
  const coolingDegreeSignal = highs.length ? Math.max(0, meanNumber(highs) - 65) : null;
  if (seriousAlert) {
    const alertText = risks.find((risk) => /active alert/i.test(risk)) ?? "There is active weather nearby.";
    return `${location} has a safety-first weather flag before this becomes a thermostat question. ${alertText} Keep an eye on official alerts, and avoid making comfort decisions that put people or pets at risk.`;
  }
  if (maxHeat == null) {
    return `I do not have enough temperature data for ${location} to judge home cooling demand tomorrow. I would recheck once the forecast fills in instead of guessing.`;
  }
  const heatPhrase =
    maxHeat >= 100
      ? `cooling demand looks high, with the heat index near ${Math.round(maxHeat)}F`
      : maxHeat >= 92
        ? `cooling demand looks elevated, with the warmest part near ${Math.round(maxHeat)}F`
        : maxHeat >= 84
          ? `cooling demand looks moderate, with the warmest part near ${Math.round(maxHeat)}F`
          : `cooling demand does not look especially high, with the warmest part near ${Math.round(maxHeat)}F`;
  const overnight =
    minLow != null && minLow >= 76
      ? ` Overnight relief looks limited, with lows around ${Math.round(minLow)}F.`
      : minLow != null
        ? ` Overnight lows around ${Math.round(minLow)}F should give the house at least some recovery time.`
        : "";
  const humidityText = avgHumidity != null && avgHumidity >= 70 ? " Humidity is also on the sticky side, so it may feel warmer indoors." : "";
  const cddText = coolingDegreeSignal != null ? ` The dashboard's cooling-demand signal is roughly ${Math.round(coolingDegreeSignal)} degree-days above a 65F baseline for this slice.` : "";
  const watch = risks.length ? ` Watch-out: ${risks.slice(0, 1).join(" ")}` : "";
  return `For ${location}, ${heatPhrase}.${overnight}${humidityText}${cddText} Weather-wise, tomorrow is a day to avoid relaxing cooling too aggressively, especially if people, pets, or heat-sensitive equipment are inside. I cannot prescribe an exact thermostat setting or predict your bill because insulation, HVAC performance, occupancy, and utility rates are not connected.${watch}`;
}

async function callOpenAiAssistant(message, advisory, interpretation, evidence) {
  const response = await fetch(openAiResponsesUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
      input: [
        {
          role: "developer",
          content:
            `You are ${assistantName}, the assistant inside a U.S. weather risk dashboard. Your persona is ${assistantPersona}: friendly enough to feel human, practical enough for real planning, and bounded enough to be trusted. You receive a structured plan, capability decision, claim cards, and verified evidence. Answer the user's actual application first, not a generic forecast: stargazing/sky viewing, clothing, comfort, packing, route or day-trip travel, outdoor timing, delivery risk, home cooling/thermostat tradeoffs, field work, exterior repairs, business operations, or dashboard explanation. Use only verified facts, claimCards, explicitBoundaries, and the supplied fallbackResponse as truth. If the user needs a follow-up, ask it naturally and briefly. If the dashboard can answer only part of the question, give the useful weather-exposure answer and plainly name what is missing. For stargazing, use cloud cover first, then rain, wind, and alerts; clearly say light pollution, moon phase, smoke/haze, local obstructions, and astronomical seeing are not connected. For route/day-trip travel, answer weather-wise only using origin/destination/corridor forecast and alert facts; say traffic, crashes, road closures, construction delays, parking, transit, and border wait times are not connected. For clothing/comfort/packing, infer practical advice from temperature highs/lows, apparent temperature, rain, wind, humidity, and alerts; be concrete about layers, rain gear, heat protection, or hydration when supported. For home cooling or thermostat questions, answer from heat, apparent temperature, humidity, cloud cover, and cooling-degree demand; do not prescribe an exact setpoint, utility bill outcome, HVAC performance, or indoor comfort guarantee. For delivery or operations, do not claim an actual ETA, delay probability, route status, backlog, staffing effect, or SLA impact; describe only weather-related disruption risk. Do not mention JSON, schemas, internal scores, provider names, API details, source badges, raw confidence labels, or implementation details unless asked. Do not invent weather, alerts, probabilities, radar, exact storm arrival, AQI, flood, river, SLA, ETA, cost, staffing, throughput, travel time, traffic, road closure status, medical advice, business metrics, moon phase, light pollution, smoke/haze, or astronomical seeing. If alert effective/expires times are provided, describe them as the official alert window, not exact storm timing. Keep answers concise and natural: usually 2-5 sentences, and only use lists when the user asks for options or comparisons. If severe alerts, lightning, extreme heat, evacuation, or emergency issues appear, drop the jokes and tell users to follow NWS/local officials and their site safety plan.`
        },
        {
          role: "user",
          content: JSON.stringify({ originalQuestion: message, interpretation, evidence, fallbackResponse: advisory }, null, 2)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "skyscout_response",
          strict: true,
          schema: assistantSchema()
        }
      }
    })
  });
  const raw = await response.json().catch(() => null);
  if (!response.ok) throw new Error(raw?.error?.message ?? `OpenAI HTTP ${response.status}`);
  const parsed = parseOpenAiJson(raw);
  return sanitizeAssistantResponse(parsed, advisory);
}

function assistantSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer", "verdict", "confidence", "bestWindows", "risks", "dataUsed", "guardrailNote", "actions"],
    properties: {
      answer: { type: "string" },
      verdict: { type: "string", enum: ["good", "marginal", "avoid", "insufficient_data"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      bestWindows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "score", "rationale"],
          properties: {
            label: { type: "string" },
            score: { type: "number" },
            rationale: { type: "string" }
          }
        }
      },
      risks: { type: "array", items: { type: "string" } },
      dataUsed: { type: "array", items: { type: "string" } },
      guardrailNote: { type: "string" },
      actions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "lat", "lon", "zoom", "label"],
          properties: {
            type: { type: "string", enum: ["flyTo"] },
            lat: { type: "number" },
            lon: { type: "number" },
            zoom: { type: "number" },
            label: { type: "string" }
          }
        }
      }
    }
  };
}

function parseOpenAiJson(raw) {
  const text =
    raw?.output_text ??
    raw?.output
      ?.flatMap((item) => item?.content ?? [])
      ?.find((content) => content?.type === "output_text" || content?.type === "text")?.text;
  if (!text) throw new Error("OpenAI response did not include text output");
  return JSON.parse(text);
}

function sanitizeAssistantResponse(parsed, fallback) {
  const allowedActions = Array.isArray(parsed?.actions)
    ? parsed.actions
        .filter((action) => action?.type === "flyTo" && Number.isFinite(action.lat) && Number.isFinite(action.lon))
        .slice(0, 1)
    : [];
  return {
    answer: String(parsed?.answer ?? fallback.answer).slice(0, 1800),
    verdict: ["good", "marginal", "avoid", "insufficient_data"].includes(parsed?.verdict) ? parsed.verdict : fallback.verdict,
    confidence: ["low", "medium", "high"].includes(parsed?.confidence) ? parsed.confidence : fallback.confidence,
    bestWindows: Array.isArray(parsed?.bestWindows) ? parsed.bestWindows.slice(0, 3) : fallback.bestWindows,
    risks: Array.isArray(parsed?.risks) ? parsed.risks.slice(0, 6).map(String) : fallback.risks,
    dataUsed: Array.isArray(parsed?.dataUsed)
      ? [...new Set([...parsed.dataUsed.slice(0, 6).map(String), ...(fallback.dataUsed ?? [])])].slice(0, 8)
      : fallback.dataUsed,
    guardrailNote: String(parsed?.guardrailNote ?? fallback.guardrailNote).slice(0, 500),
    actions: allowedActions.length ? allowedActions : fallback.actions,
    answerType: fallback.answerType,
    persona: fallback.persona,
    capabilityNote: fallback.capabilityNote,
    missingData: fallback.missingData ?? [],
    conversationState: fallback.conversationState ?? null
  };
}

function labelDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function domainForLatLon(lat, lon) {
  if (lat > 50 && lon < -130) return "ak";
  if (lat < 23 && lon < -150) return "hi";
  return "conus";
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function fetchProviderJson(url, headers = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 16_000;
  const retries = options.retries ?? 2;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body?.reason ? `${response.status} ${body.reason}` : `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status >= 500;
        throw Object.assign(new Error(message), { retryable });
      }
      if (body?.error) throw Object.assign(new Error(String(body.reason ?? "Provider error")), { retryable: true });
      return body;
    } catch (error) {
      lastError = error;
      const retryable = error?.retryable !== false;
      if (!retryable || attempt === retries) break;
      await sleep(800 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

function valuesFor(prop) {
  return Array.isArray(prop?.values) ? prop.values : [];
}

function tagRawSource(raw, provider) {
  return raw && typeof raw === "object" ? { ...raw, source: { provider } } : raw;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function openMeteoForecastCompat(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const daily = raw.daily && typeof raw.daily === "object" ? raw.daily : {};
  const hourly = raw.hourly && typeof raw.hourly === "object" ? raw.hourly : {};
  const dailyCloud = daily.cloud_cover_mean ?? aggregateHourlyByDaily(hourly.time, hourly.cloud_cover, daily.time, "mean");
  const current = raw.current && typeof raw.current === "object" ? raw.current : {};
  return {
    ...raw,
    current: {
      ...current,
      cloud_cover: current.cloud_cover ?? firstArrayNumber(hourly.cloud_cover)
    },
    daily: {
      ...daily,
      apparent_temperature_max: daily.apparent_temperature_max ?? daily.temperature_2m_max ?? [],
      cloud_cover_mean: dailyCloud ?? []
    }
  };
}

function aggregateHourlyByDaily(times, values, dailyTimes, mode = "mean") {
  if (!Array.isArray(times) || !Array.isArray(values) || !Array.isArray(dailyTimes)) return null;
  const buckets = new Map(dailyTimes.map((date) => [String(date), []]));
  times.forEach((time, i) => {
    const date = String(time ?? "").slice(0, 10);
    const value = Number(values[i]);
    if (!buckets.has(date) || !Number.isFinite(value)) return;
    buckets.get(date).push(value);
  });
  return dailyTimes.map((date) => {
    const xs = buckets.get(String(date)) ?? [];
    if (!xs.length) return null;
    if (mode === "max") return Math.max(...xs);
    if (mode === "min") return Math.min(...xs);
    if (mode === "sum") return xs.reduce((a, b) => a + b, 0);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  });
}

function firstArrayNumber(values) {
  if (!Array.isArray(values)) return null;
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstValue(values) {
  for (const item of values) {
    const value = Number(item?.value);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function bucketDaily(values, dates, mode, convert = (v) => v) {
  const buckets = new Map(dates.map((date) => [date, []]));
  for (const item of values) {
    const value = Number(item?.value);
    if (!Number.isFinite(value)) continue;
    const date = String(item?.validTime ?? "").slice(0, 10);
    if (!buckets.has(date)) continue;
    buckets.get(date).push(convert(value));
  }
  return dates.map((date) => {
    const xs = buckets.get(date)?.filter((v) => v != null && Number.isFinite(v)) ?? [];
    if (!xs.length) return null;
    if (mode === "max") return Math.max(...xs);
    if (mode === "min") return Math.min(...xs);
    if (mode === "sum") return xs.reduce((a, b) => a + b, 0);
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  });
}

function cToF(v) {
  return v == null || !Number.isFinite(v) ? null : (v * 9) / 5 + 32;
}

function kmhToMph(v) {
  return v == null || !Number.isFinite(v) ? null : v * 0.621371;
}

function mmToIn(v) {
  return v == null || !Number.isFinite(v) ? null : v / 25.4;
}

function nextDates(count) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() + i);
    return isoDate(d);
  });
}

function nextHours(count) {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + i);
    return d.toISOString().slice(0, 16);
  });
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function cached(key, ttlMs, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = await load();
  cache.set(key, { value, expires: now + ttlMs });
  return value;
}

function validatePoints(points) {
  if (!Array.isArray(points) || points.length === 0 || points.length > 120) throw new Error("Invalid points payload");
  return points.map((p, i) => {
    const lat = Number(p?.lat);
    const lon = Number(p?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error(`Invalid point at index ${i}`);
    return {
      id: typeof p?.id === "string" ? p.id : `point-${i}`,
      kind: typeof p?.kind === "string" ? p.kind : "unknown",
      domain: typeof p?.domain === "string" ? p.domain : "conus",
      lat,
      lon
    };
  });
}

function validateRegion(region) {
  const id = String(region?.id ?? "");
  const lat = Number(region?.lat);
  const lon = Number(region?.lon);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("Invalid region payload");
  return { id, lat, lon };
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : raw == null ? [] : [raw];
}

function hourKey(date = new Date()) {
  return date.toISOString().slice(0, 13);
}

function hashPoints(points) {
  let hash = 5381;
  const input = points.map((p) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`).join("|");
  for (let i = 0; i < input.length; i += 1) hash = (hash * 33) ^ input.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function serveStatic(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const pathname = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, "dist", pathname === "/" ? "index.html" : pathname);
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(data);
  } catch {
    const data = await readFile(join(root, "dist", "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  }
}

function contentType(path) {
  const ext = extname(path);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
