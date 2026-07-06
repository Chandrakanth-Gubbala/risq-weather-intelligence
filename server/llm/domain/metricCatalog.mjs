export const metricCatalog = {
  risk: {
    id: "risk",
    label: "Forecast stress score",
    units: "0-100 relative score",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "current or daily forecast day",
    canSupport: [
      "short-range relative weather stress",
      "plain-language comparison across visible or pinned regions",
      "outdoor planning caveats from heat, wind, rain, and severe alerts"
    ],
    cannotSupport: ["total business risk", "dispatch certainty", "SLA impact", "cost impact", "long-term climate exposure"],
    safeExplanation:
      "A short-range weather stress summary using transmitted heat index/apparent temperature, fire-weather proxy, 10 m wind, and cooling-degree demand.",
    unsafeExplanation:
      "Do not describe this as actual financial, logistics, safety, compliance, or climate-loss risk.",
    businessRelevance:
      "Useful as an early warning signal for where outdoor work or customer-facing plans may need extra attention.",
    caveats: "Prototype score; not an operational safety, emergency, dispatch, financial, or compliance model."
  },
  heat: {
    id: "heat",
    label: "Heat index / apparent temperature",
    units: "deg F",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "current or daily forecast day",
    canSupport: ["worker heat-exposure screening", "outdoor event comfort", "relative heat comparison"],
    cannotSupport: ["medical diagnosis", "OSHA compliance determination", "exact pavement or sun exposure"],
    safeExplanation: "How hot it may feel using forecast apparent-temperature/heat-index style signal.",
    unsafeExplanation: "Do not claim exact illness risk or official compliance status.",
    businessRelevance: "Relevant to delivery work, loading yards, field crews, and outdoor events.",
    caveats: "Site shade, workload, clothing, acclimatization, and hydration are not modeled."
  },
  temp: {
    id: "temp",
    label: "Temperature",
    units: "deg F",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "current or daily forecast day",
    canSupport: ["basic weather summary", "comfort checks", "regional comparison"],
    cannotSupport: ["microclimate certainty", "indoor conditions"],
    safeExplanation: "Forecast near-surface air temperature.",
    unsafeExplanation: "Do not treat it as exact site temperature.",
    businessRelevance: "Useful background for staffing comfort, outdoor plans, and customer-facing activity.",
    caveats: "Local shade, pavement, elevation, and urban heat effects can differ."
  },
  fire: {
    id: "fire",
    label: "Fire weather proxy",
    units: "0-100 relative score",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "current or daily forecast day",
    canSupport: ["relative dry/windy fire-weather concern", "watchpoint for field operations"],
    cannotSupport: ["official fire danger rating", "evacuation decisions", "ignition probability"],
    safeExplanation: "A proxy using forecast heat, humidity, wind, and rain context.",
    unsafeExplanation: "Do not present it as an official wildfire forecast or evacuation signal.",
    businessRelevance: "Useful for outdoor crews and utility work as a watchpoint.",
    caveats: "Fuel moisture, vegetation, terrain, and official fire products are not included."
  },
  wind: {
    id: "wind",
    label: "Wind 7d max",
    units: "mph",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "daily forecast maximum",
    canSupport: ["breezy/strong wind screening", "event setup caution", "field-work caution"],
    cannotSupport: ["gust-level engineering decisions", "aviation or marine decisions"],
    safeExplanation: "Forecast 10 m wind speed maximum from available provider data.",
    unsafeExplanation: "Do not treat as exact gust timing or structural safety guidance.",
    businessRelevance: "Relevant for tents, signage, lifts, utility work, and exposed outdoor tasks.",
    caveats: "Gusts, terrain, and local exposure can differ."
  },
  humidity: {
    id: "humidity",
    label: "Humidity",
    units: "%",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "current provider value",
    canSupport: ["comfort context", "heat/fire proxy context"],
    cannotSupport: ["indoor humidity", "mold risk", "health diagnosis"],
    safeExplanation: "Relative humidity from forecast/provider data.",
    unsafeExplanation: "Do not use as a standalone health or facility-risk metric.",
    businessRelevance: "Adds context for heat stress comfort and fire-weather watchpoints.",
    caveats: "Humidity may be current-only depending on provider fallback."
  },
  cdd: {
    id: "cdd",
    label: "Cooling degree days",
    units: "deg F above 65",
    spatialGrain: "sample point interpolated to map surface",
    temporalGrain: "daily forecast-derived estimate",
    canSupport: ["relative cooling-demand signal", "heat-load comparison"],
    cannotSupport: ["utility load forecast", "energy bill prediction", "grid reliability forecast"],
    safeExplanation: "A simple temperature-derived cooling-demand signal.",
    unsafeExplanation: "Do not claim exact energy usage, cost, or grid impact.",
    businessRelevance: "Useful context for cooling demand and heat-driven operating stress.",
    caveats: "Building type, occupancy, HVAC, and utility load data are not modeled."
  }
};

export const removedMetrics = [
  {
    id: "aqi",
    label: "AQI / air quality",
    match: /\b(aqi|air\s*quality|pm2\.?5|ozone|smoke)\b/i,
    reason: "AQI was removed because there is no reliable keyless fallback in this prototype."
  },
  {
    id: "flood",
    label: "Flood / river discharge",
    match: /\b(flood|flooding|river|discharge|streamflow|water\s*level)\b/i,
    reason: "Flood and river-discharge signals were removed because the live data path was too weak for honest scoring."
  },
  {
    id: "heatstress",
    label: "Heat stress proxy",
    match: /\b(heat\s*stress|wet\s*bulb|wbgt)\b/i,
    reason: "The heat-stress proxy was removed; the dashboard can discuss heat index/apparent temperature instead."
  },
  {
    id: "drought_soil_solar_wpd",
    label: "Removed geophysical layers",
    match: /\b(drought|soil|soil\s*moisture|solar|wind\s*power|wpd|80\s*m)\b/i,
    reason: "That geophysical layer is not currently transmitted or displayed in this prototype."
  }
];

export function availableMetricSummary(activeLayerId) {
  const active = metricCatalog[activeLayerId] ?? metricCatalog.risk;
  return {
    active,
    availableLayerIds: Object.keys(metricCatalog),
    removedLayerIds: removedMetrics.map((metric) => metric.id)
  };
}
