export const dataManifest = {
  version: "2026-07-05-v1",
  variables: {
    temp_max: {
      label: "Daily high temperature",
      sourceField: "daily.temperature_2m_max",
      temporal: "daily_16d",
      spatial: "point",
      unit: "F"
    },
    temp_min: {
      label: "Daily low temperature",
      sourceField: "daily.temperature_2m_min",
      temporal: "daily_16d",
      spatial: "point",
      unit: "F"
    },
    apparent_temp: {
      label: "Daily apparent temperature / heat index",
      sourceField: "daily.apparent_temperature_max",
      temporal: "daily_16d",
      spatial: "point",
      unit: "F"
    },
    precip_sum: {
      label: "Daily precipitation sum",
      sourceField: "daily.precipitation_sum",
      temporal: "daily_16d",
      spatial: "point",
      unit: "in"
    },
    wind_speed: {
      label: "Daily maximum 10 m wind speed",
      sourceField: "daily.wind_speed_10m_max",
      temporal: "daily_16d",
      spatial: "point",
      unit: "mph"
    },
    humidity: {
      label: "Current relative humidity",
      sourceField: "current.relative_humidity_2m",
      temporal: "current",
      spatial: "point",
      unit: "%"
    },
    cloud_cover: {
      label: "Daily mean cloud cover",
      sourceField: "daily.cloud_cover_mean",
      temporal: "daily_16d",
      spatial: "point",
      unit: "%"
    },
    hourly_temp: {
      label: "Hourly temperature",
      sourceField: "hourly.temperature_2m",
      temporal: "hourly_16d",
      spatial: "point",
      unit: "F"
    },
    hourly_apparent_temp: {
      label: "Hourly apparent temperature",
      sourceField: "hourly.apparent_temperature",
      temporal: "hourly_16d",
      spatial: "point",
      unit: "F"
    },
    hourly_precip: {
      label: "Hourly precipitation",
      sourceField: "hourly.precipitation",
      temporal: "hourly_16d",
      spatial: "point",
      unit: "in"
    },
    hourly_wind: {
      label: "Hourly 10 m wind speed",
      sourceField: "hourly.wind_speed_10m",
      temporal: "hourly_16d",
      spatial: "point",
      unit: "mph"
    },
    hourly_cloud: {
      label: "Hourly cloud cover",
      sourceField: "hourly.cloud_cover",
      temporal: "hourly_16d",
      spatial: "point",
      unit: "%"
    },
    alerts_active: {
      label: "Active NWS alerts in map/location context",
      sourceField: "context.alerts",
      temporal: "current",
      spatial: "polygon_or_map_context",
      unit: "alert"
    },
    risk_score: {
      label: "Dashboard forecast stress score",
      sourceField: "derived.score",
      temporal: "current_or_daily",
      spatial: "sample_point",
      unit: "0-100"
    },
    cooling_degree_days: {
      label: "Cooling degree days",
      sourceField: "derived.cdd7",
      temporal: "7d_sum",
      spatial: "sample_point",
      unit: "CDD"
    },
    layer_risk: {
      label: "Dashboard forecast stress layer",
      sourceField: "context.visiblePoints[].layers.risk",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "0-100"
    },
    layer_fire: {
      label: "Dashboard fire weather layer",
      sourceField: "context.visiblePoints[].layers.fire",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "0-100"
    },
    layer_heat: {
      label: "Dashboard heat index layer",
      sourceField: "context.visiblePoints[].layers.heat",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "F"
    },
    layer_temp: {
      label: "Dashboard temperature layer",
      sourceField: "context.visiblePoints[].layers.temp",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "F"
    },
    layer_wind: {
      label: "Dashboard wind layer",
      sourceField: "context.visiblePoints[].layers.wind",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "mph"
    },
    layer_humidity: {
      label: "Dashboard humidity layer",
      sourceField: "context.visiblePoints[].layers.humidity",
      temporal: "current",
      spatial: "visible_or_selected_region",
      unit: "%"
    },
    layer_cloud: {
      label: "Dashboard cloud cover layer",
      sourceField: "context.visiblePoints[].layers.cloud",
      temporal: "current_or_timeline",
      spatial: "visible_or_selected_region",
      unit: "%"
    },
    layer_cdd: {
      label: "Dashboard cooling degree days layer",
      sourceField: "context.visiblePoints[].layers.cdd",
      temporal: "7d_sum",
      spatial: "visible_or_selected_region",
      unit: "CDD"
    }
  },
  operations: {
    max: { args: ["var", "over"], description: "Maximum value over a time window." },
    min: { args: ["var", "over"], description: "Minimum value over a time window." },
    mean: { args: ["var", "over"], description: "Average value over a time window." },
    sum: { args: ["var", "over"], description: "Sum over a time window." },
    count: { args: ["var", "where", "over"], description: "Count periods where a threshold is met." },
    threshold: { args: ["var", "where", "over"], description: "Whether a threshold is met." },
    rank_locations: { args: ["var", "locs", "over"], description: "Rank or compare locations by a variable." },
    best_window: { args: ["var", "over"], description: "Find the most suitable day/window from weather variables." }
  },
  retrievalModes: [
    "single_location",
    "rank_visible_points",
    "compare_locations",
    "route",
    "selected_region",
    "map_center",
    "ask_followup",
    "alert_explanation",
    "none"
  ],
  notAvailable: [
    "aqi",
    "river_discharge",
    "live_radar",
    "traffic_conditions",
    "package_tracking_status",
    "restaurant_prep_status",
    "courier_assignment",
    "carrier_route_status",
    "flight_operations_status",
    "airline_schedule",
    "road_closures",
    "light_pollution",
    "moon_phase",
    "smoke_haze",
    "astronomical_seeing",
    "local_regulations",
    "business_financial_metrics"
  ]
};

export const manifestVariableIds = new Set(Object.keys(dataManifest.variables));
export const manifestOperationIds = new Set(Object.keys(dataManifest.operations));
export const manifestRetrievalModes = new Set(dataManifest.retrievalModes);
