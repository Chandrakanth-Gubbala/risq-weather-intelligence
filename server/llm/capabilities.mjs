import { availableMetricSummary, removedMetrics } from "./domain/metricCatalog.mjs";
import { inferPersona } from "./domain/personaPacks.mjs";

const outOfDomainPattern =
  /\b(fifa|nba|nfl|mlb|nhl|sports|score|movie|song|celebrity|recipe|essay|poem|code|debug|homework|stock|crypto|lawsuit|dating|relationship)\b/i;
const unsafePattern = /\b(self\s*harm|suicide|kill\s+myself|make\s+a\s+weapon|bomb|poison)\b/i;
const weatherPattern =
  /\b(weather|forecast|rain|storm|thunder|lightning|heat|hot|cold|wind|humidity|temperature|temp|cloud|cloudy|clear|sky|stargaz(?:e|ing)?|star[-\s]?gaz(?:e|ing)?|sky[-\s]?watch(?:ing)?|stars?|meteor|astronomy|outdoor|outside|outing|picnic|event|park|risk|alert|warning|advisory|weekend|tomorrow|today|tonight|next\s+\d+\s+days?)\b/i;
const dashboardPattern = /\b(map|layer|score|rank|ranking|red|orange|green|dashboard|region|compare|pinned|selected)\b/i;
const businessPattern =
  /\b(amazon|package|shipment|parcel|deliver|delivery|deliveries|driver|route|last[-\s]?mile|logistics|carrier|dispatch|warehouse|yard|loading|dock|field\s*service|crew|technician|utility|outage|operations?|business|worker|shift|site)\b/i;
const unsupportedBusinessPattern =
  /\b(delay|delayed|late|arriv(?:e|al|ing)|eta|tracking|sla|otif|cost|dollar|revenue|profit|loss|staffing|labor|headcount|throughput|inventory|backlog|churn|miss(?:ed)?\s+delivery|service\s+level)\b/i;

export function evaluateAssistantCapability({ message, interpretation = {}, context = {}, applicationReasoning = null }) {
  const text = String(message ?? "");
  const persona = inferPersona(text, interpretation);
  const removedMetric = removedMetrics.find((metric) => metric.match.test(text));
  const activeLayerId = context?.activeLayer?.id ?? "risk";
  const metrics = availableMetricSummary(activeLayerId);
  const requiredData = [];
  const availableData = [];
  const missingData = [];

  if (unsafePattern.test(text)) {
    return decision({
      scopeClass: "unsafe",
      answerability: "unsafe",
      questionFamily: "unsafe",
      persona,
      metrics,
      requiredData,
      availableData,
      missingData: ["Safety policy handling"],
      reason: "Unsafe content is outside this product."
    });
  }

  if (removedMetric) {
    return decision({
      scopeClass: "unsupported_by_data",
      answerability: "unsupported_by_data",
      questionFamily: "removed_metric",
      persona,
      metrics,
      requiredData: [removedMetric.label],
      availableData,
      missingData: [removedMetric.reason],
      reason: removedMetric.reason
    });
  }

  if (outOfDomainPattern.test(text) && !weatherPattern.test(text) && !dashboardPattern.test(text)) {
    return decision({
      scopeClass: "out_of_domain",
      answerability: "out_of_domain",
      questionFamily: "out_of_domain",
      persona,
      metrics,
      requiredData,
      availableData,
      missingData: ["Question is not about the weather dashboard."],
      reason: "The assistant is scoped to U.S. weather, map context, alerts, and weather-related planning."
    });
  }

  const interpreterBusiness =
    interpretation.questionFamily === "business_weather_exposure" ||
    ["in_scope_business_relevance", "in_scope_partial_business"].includes(interpretation.scopeClass) ||
    ["logistics_last_mile", "warehouse_ops", "field_service", "utility_ops"].includes(interpretation.businessPersona) ||
    ["food_delivery", "package_delivery", "general_delivery", "construction", "field_work", "business_operations"].includes(
      applicationReasoning?.applicationKind
    );
  const interpreterPartial =
    interpretation.answerability === "answerable_partially" ||
    interpretation.scopeClass === "in_scope_partial_business" ||
    (Array.isArray(interpretation.missingData) && interpretation.missingData.length > 0) ||
    (applicationReasoning?.answerabilityRecommendation === "partial" &&
      Array.isArray(applicationReasoning.externalMissingEvidence) &&
      applicationReasoning.externalMissingEvidence.length > 0);
  const asksBusiness = businessPattern.test(text) || interpreterBusiness;
  const asksUnsupportedBusiness = unsupportedBusinessPattern.test(text) || (interpreterBusiness && interpreterPartial);
  const weatherOnlyPartial =
    ["stargazing"].includes(applicationReasoning?.applicationKind) ||
    /\b(stargaz|sky|cloud cover)\b/i.test(`${applicationReasoning?.allowedClaim ?? ""} ${applicationReasoning?.userGoal ?? ""}`);
  const asksWeather =
    weatherPattern.test(text) ||
    Boolean(interpretation.location) ||
    (Array.isArray(applicationReasoning?.locations) && applicationReasoning.locations.length > 0) ||
    (interpretation.intent && interpretation.intent !== "out_of_scope") ||
    ["in_scope_weather", "in_scope_business_relevance", "in_scope_partial_business"].includes(interpretation.scopeClass);
  const asksDashboard = dashboardPattern.test(text) || ["risk_explanation", "map_context", "compare_locations"].includes(interpretation.intent);

  if (asksUnsupportedBusiness && (asksWeather || asksBusiness || asksDashboard)) {
    return decision({
      scopeClass: "in_scope_partial_business",
      answerability: "answerable_partially",
      questionFamily: "business_weather_exposure",
      persona,
      metrics,
      requiredData: ["Weather forecast", "Relevant alerts", "Business outcome data"],
      availableData: ["Weather forecast", "Dashboard layer context", "NWS alert context when available"],
      missingData: [
        ...new Set([
          ...unsupportedBusinessMissing(text, applicationReasoning),
          ...(Array.isArray(interpretation.missingData) ? interpretation.missingData : [])
        ])
      ],
      applicationReasoning,
      reason:
        "The dashboard can answer the weather-exposure part, but it does not have the operational data needed for the requested business outcome."
    });
  }

  if (interpreterPartial && asksWeather) {
    return decision({
      scopeClass: weatherOnlyPartial ? "in_scope_weather" : "in_scope_partial_business",
      answerability: "answerable_partially",
      questionFamily: applicationReasoning?.applicationKind ?? interpretation.questionFamily ?? "weather_application",
      persona,
      metrics,
      requiredData: [...new Set(["Weather forecast", "Relevant alerts", ...(Array.isArray(applicationReasoning?.requiredEvidence) ? applicationReasoning.requiredEvidence : [])])],
      availableData: [...new Set(["Weather forecast", "Dashboard layer context", "NWS alert context when available", ...(Array.isArray(applicationReasoning?.dashboardRelevantEvidence) ? applicationReasoning.dashboardRelevantEvidence : [])])],
      missingData: [...new Set([...(Array.isArray(applicationReasoning?.externalMissingEvidence) ? applicationReasoning.externalMissingEvidence : []), ...(Array.isArray(interpretation.missingData) ? interpretation.missingData : [])])],
      applicationReasoning,
      reason:
        weatherOnlyPartial
          ? "The dashboard can answer from connected weather signals, while naming the missing specialty context."
          : "The dashboard can answer the weather-related part of this application, but some real-world outcome data is not connected."
    });
  }

  if (asksBusiness && (asksWeather || asksDashboard)) {
    return decision({
      scopeClass: "in_scope_business_relevance",
      answerability: "answerable_now",
      questionFamily: "business_weather_exposure",
      persona,
      metrics,
      requiredData: ["Weather forecast", "Relevant alerts", "Persona lens"],
      availableData: ["Weather forecast", "Dashboard layer context", "NWS alert context when available", `${persona.label} lens`],
      missingData,
      applicationReasoning,
      reason: "Weather facts can be interpreted through a business workflow lens without claiming unsupported outcomes."
    });
  }

  if (asksDashboard) {
    return decision({
      scopeClass: "in_scope_dashboard_explainer",
      answerability: "answerable_now",
      questionFamily: "dashboard_explainer",
      persona,
      metrics,
      requiredData: ["Active layer context", "Selected or visible map context"],
      availableData: ["Dashboard layer context", "Current map context"],
      missingData,
      applicationReasoning,
      reason: "The question asks about dashboard signals or map context."
    });
  }

  if (asksWeather) {
    return decision({
      scopeClass: "in_scope_weather",
      answerability: "answerable_now",
      questionFamily: interpretation.intent === "event_planning" ? "event_window_planning" : "weather_summary",
      persona,
      metrics,
      requiredData: ["Weather forecast", "Relevant alerts"],
      availableData: ["Weather forecast", "NWS alert context when available"],
      missingData,
      applicationReasoning,
      reason: "The question is about weather or planning from available forecast signals."
    });
  }

  return decision({
    scopeClass: "out_of_domain",
    answerability: "out_of_domain",
    questionFamily: "out_of_domain",
    persona,
    metrics,
    requiredData,
    availableData,
    missingData: ["Question is not about the weather dashboard."],
    reason: "No supported weather, dashboard, or business-relevance intent was detected."
  });
}

export function capabilityResponse(capability) {
  const base = {
    verdict: "insufficient_data",
    confidence: "high",
    bestWindows: [],
    risks: capability.missingData.length ? capability.missingData : [capability.reason],
    dataUsed: ["Capability guardrail"],
    guardrailNote: capability.reason,
    actions: [],
    answerType: capability.scopeClass,
    persona: capability.persona.label,
    capabilityNote: capability.reason
  };
  if (capability.answerability === "unsafe") {
    return {
      ...base,
      answer:
        "I cannot help with that. I can stay useful on weather, alerts, dashboard layers, and planning questions grounded in this map."
    };
  }
  if (capability.questionFamily === "removed_metric") {
    return {
      ...base,
      answer: `${capability.missingData[0]} I can still help with the live layers we do have: forecast stress, heat, temperature, wind, humidity, fire-weather proxy, cooling demand, and severe-alert context.`
    };
  }
  return {
    ...base,
    answer:
      "I am built for this weather dashboard, so I cannot answer that one cleanly. Ask me about a U.S. location, this map view, alerts, outdoor timing, or weather impacts for events, deliveries, warehouse yards, field crews, or utilities."
  };
}

export function compactCapabilityForPrompt(capability) {
  return {
    scopeClass: capability.scopeClass,
    answerability: capability.answerability,
    questionFamily: capability.questionFamily,
    applicationReasoning: capability.applicationReasoning,
    requiredData: capability.requiredData,
    availableData: capability.availableData,
    missingData: capability.missingData,
    allowedPersonaLens: capability.persona.label,
    reason: capability.reason,
    activeMetric: capability.metrics.active
  };
}

function decision(values) {
  return {
    scopeClass: values.scopeClass,
    answerability: values.answerability,
    questionFamily: values.questionFamily,
    persona: values.persona,
    metrics: values.metrics,
    requiredData: values.requiredData ?? [],
    availableData: values.availableData ?? [],
    missingData: values.missingData ?? [],
    applicationReasoning: values.applicationReasoning ?? null,
    reason: values.reason,
    allowedMapActions: values.answerability === "answerable_now" || values.answerability === "answerable_partially" ? ["flyTo"] : []
  };
}

function unsupportedBusinessMissing(text, applicationReasoning = null) {
  if (Array.isArray(applicationReasoning?.externalMissingEvidence) && applicationReasoning.externalMissingEvidence.length) {
    return applicationReasoning.externalMissingEvidence;
  }
  const missing = [];
  if (/\b(sla|otif|service\s+level)\b/i.test(text)) missing.push("SLA/OTIF/service-level data is not connected.");
  if (/\b(delay|delayed|late|arriv(?:e|al|ing)|eta|tracking|route|stop|amazon|package|shipment|parcel|miss(?:ed)?\s+delivery)\b/i.test(text)) {
    missing.push("Package tracking, carrier route, stop, traffic, and delivery-performance data are not connected.");
  }
  if (/\b(cost|dollar|revenue|profit|loss)\b/i.test(text)) missing.push("Cost, revenue, and financial-impact data are not connected.");
  if (/\b(staffing|labor|headcount|throughput|backlog)\b/i.test(text)) missing.push("Staffing, throughput, labor, and backlog data are not connected.");
  if (!missing.length) missing.push("The requested business outcome data is not connected.");
  return missing;
}
