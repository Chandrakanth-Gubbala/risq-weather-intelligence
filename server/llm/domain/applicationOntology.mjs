export const ontologyVersion = "2026-07-05-v1";

export const applicationFamilies = {
  weather_summary: {
    id: "weather_summary",
    label: "Weather summary",
    goals: ["general_weather"],
    requiredSlots: ["location_or_map_context"],
    optionalSlots: ["time_window"],
    dashboardEvidence: ["forecast_daily", "current_conditions", "alerts", "map_context"],
    externalMissingEvidence: [],
    allowedClaims: ["weather_summary", "weather_risk_summary"],
    forbiddenClaims: ["radar_claim", "exact_storm_arrival", "emergency_clearance"],
    followupSlotPriority: ["location_or_map_context"]
  },
  comfort_and_clothing: {
    id: "comfort_and_clothing",
    label: "Comfort and clothing",
    goals: ["personal_comfort", "clothing_guidance", "travel_packing"],
    requiredSlots: ["location_or_map_context"],
    optionalSlots: ["time_window", "activity"],
    dashboardEvidence: ["forecast_daily", "current_conditions", "temperature", "apparent_temperature", "humidity", "rain", "wind", "alerts"],
    externalMissingEvidence: [],
    allowedClaims: ["comfort_guidance", "clothing_guidance", "packing_hint"],
    forbiddenClaims: ["medical_advice", "guaranteed_comfort", "exact_individual_safety"],
    followupSlotPriority: ["location_or_map_context", "time_window"]
  },
  sky_visibility: {
    id: "sky_visibility",
    label: "Sky visibility and stargazing",
    goals: ["stargazing"],
    requiredSlots: ["location_or_map_context"],
    optionalSlots: ["time_window", "activity"],
    dashboardEvidence: ["forecast_daily", "cloud_cover", "rain", "wind", "alerts", "map_context"],
    externalMissingEvidence: ["light pollution", "moon phase", "smoke or haze", "local horizon obstruction"],
    allowedClaims: ["sky_visibility_screening", "stargazing_weather_hint"],
    forbiddenClaims: ["astronomical seeing forecast", "dark-sky guarantee", "exact cloud timing", "smoke_or_haze_claim", "moon_phase_claim"],
    followupSlotPriority: ["location_or_map_context", "time_window"]
  },
  time_window_planning: {
    id: "time_window_planning",
    label: "Outdoor time-window planning",
    goals: ["outdoor_event", "field_work", "construction"],
    requiredSlots: ["location_or_map_context"],
    optionalSlots: ["time_window", "activity"],
    dashboardEvidence: ["forecast_daily", "alerts", "temperature", "rain", "wind", "humidity"],
    externalMissingEvidence: ["site conditions", "staffing", "permits", "local operational constraints"],
    allowedClaims: ["weather_window_recommendation", "weather_exposure_summary"],
    forbiddenClaims: ["site_safety_clearance", "staffing_decision", "permit_or_code_compliance"],
    followupSlotPriority: ["location_or_map_context", "time_window", "activity"]
  },
  travel_weather_decision: {
    id: "travel_weather_decision",
    label: "Travel weather decision",
    goals: ["route_travel", "commute_travel"],
    requiredSlots: ["origin", "destination"],
    optionalSlots: ["departure_time", "return_time", "mode"],
    dashboardEvidence: ["forecast_daily", "alerts", "route_endpoint_weather", "route_midpoint_weather"],
    externalMissingEvidence: ["traffic", "crashes", "road closures", "construction delays", "parking availability", "transit or border wait times"],
    allowedClaims: ["weather_related_travel_practicality", "route_weather_risk_summary"],
    forbiddenClaims: ["actual_travel_time", "traffic_delay", "road_closure_status", "crash_status", "parking_status", "border_wait_time"],
    followupSlotPriority: ["origin", "destination", "departure_time"]
  },
  weather_sensitive_operations: {
    id: "weather_sensitive_operations",
    label: "Weather-sensitive operations",
    goals: ["food_delivery", "package_delivery", "general_delivery", "business_operations"],
    requiredSlots: ["location_or_map_context"],
    optionalSlots: ["time_window", "operation_type"],
    dashboardEvidence: ["forecast_daily", "alerts", "temperature", "rain", "wind", "heat"],
    externalMissingEvidence: ["operational system status", "routing", "staffing", "traffic", "platform backlog"],
    allowedClaims: ["weather_related_operational_risk", "weather_exposure_summary"],
    forbiddenClaims: ["actual_eta", "actual_delay_prediction", "carrier_status", "platform_status", "business_metric_prediction"],
    followupSlotPriority: ["location_or_map_context", "time_window"]
  },
  dashboard_explanation: {
    id: "dashboard_explanation",
    label: "Dashboard explanation",
    goals: ["dashboard_explainer", "alert_explanation"],
    requiredSlots: [],
    optionalSlots: ["active_layer", "selected_region"],
    dashboardEvidence: ["metric_catalog", "alert_glossary", "map_context"],
    externalMissingEvidence: [],
    allowedClaims: ["dashboard_explanation", "alert_meaning"],
    forbiddenClaims: ["official_safety_instruction", "unconnected_metric_claim"],
    followupSlotPriority: []
  },
  unsupported_or_out_of_scope: {
    id: "unsupported_or_out_of_scope",
    label: "Unsupported or out of scope",
    goals: ["out_of_scope", "unknown"],
    requiredSlots: [],
    optionalSlots: [],
    dashboardEvidence: [],
    externalMissingEvidence: ["unsupported request"],
    allowedClaims: ["scope_redirect"],
    forbiddenClaims: ["unsupported_answer"],
    followupSlotPriority: []
  }
};

export const applicationKindToFamily = Object.fromEntries(
  Object.values(applicationFamilies).flatMap((family) => family.goals.map((goal) => [goal, family.id]))
);

export function familyForApplicationKind(kind) {
  return applicationFamilies[applicationKindToFamily[kind] ?? "unsupported_or_out_of_scope"];
}

export function ontologyContractForKind(kind) {
  const family = familyForApplicationKind(kind);
  return {
    ontologyVersion,
    familyId: family.id,
    familyLabel: family.label,
    requiredSlots: family.requiredSlots,
    optionalSlots: family.optionalSlots,
    dashboardEvidence: family.dashboardEvidence,
    externalMissingEvidence: family.externalMissingEvidence,
    allowedClaims: family.allowedClaims,
    forbiddenClaims: family.forbiddenClaims,
    followupSlotPriority: family.followupSlotPriority
  };
}
