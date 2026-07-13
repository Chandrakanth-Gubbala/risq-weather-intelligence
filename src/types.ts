export type Domain = "conus" | "ak" | "hi";
export type SampleKind = "region" | "fill" | "refinement";

export type Region = {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  domain: Domain;
};

export type SamplePoint = {
  id: string;
  kind: SampleKind;
  name?: string;
  state?: string;
  lat: number;
  lon: number;
  domain: Domain;
};

export type CurrentMetrics = {
  tempF: number | null;
  apparentF: number | null;
  rhPct: number | null;
  precipIn: number | null;
  wind10Mph: number | null;
  cloudCoverPct: number | null;
};

export type ForecastSeries = {
  dates: string[];
  tmaxF: (number | null)[];
  tminF: (number | null)[];
  apparentMaxF: (number | null)[];
  precipIn: (number | null)[];
  wind10MaxMph: (number | null)[];
  cloudCoverPct: (number | null)[];
  hourly: {
    times: string[];
    tempF: (number | null)[];
    apparentF: (number | null)[];
    precipIn: (number | null)[];
    wind10Mph: (number | null)[];
    cloudCoverPct: (number | null)[];
  };
};

export type DerivedMetrics = {
  heat7F: number | null;
  tmax7F: number | null;
  precip7In: number | null;
  windMaxMph: number | null;
  cloudMeanPct: number | null;
  cdd7: number | null;
  heatS: number;
  fireS: number;
  windS: number;
  cddS: number;
  score: number;
  riskLabel: "Low" | "Moderate" | "Elevated" | "High" | "Extreme";
};

export type PointData = {
  sample: SamplePoint;
  current: CurrentMetrics;
  forecast: ForecastSeries;
  derived: DerivedMetrics;
};

export type LayerId =
  | "risk"
  | "heat"
  | "temp"
  | "fire"
  | "wind"
  | "humidity"
  | "cloud"
  | "cdd";

export type LayerDefinition = {
  id: LayerId;
  label: string;
  subtitle?: string;
  group: "weather" | "business";
  lo: number;
  hi: number;
  unit: string;
  legend: [string, string];
  value: (p: PointData, timeIdx: number | null, timeMode?: ForecastTimeMode) => number | null;
  format: (v: number | null) => string;
  caveat?: string;
};

export type AlertFeature = {
  id: string;
  event: string;
  severity: "Extreme" | "Severe";
  status: string;
  areaDesc: string;
  geometry: GeoJSON.Geometry;
  effective?: string;
  expires?: string;
};

export type TrendSeries = {
  years: number[];
  annualMeanTempF: (number | null)[];
  annualPrecipIn: (number | null)[];
  annualWindMaxAvgMph: (number | null)[];
  annualHumidityPct: (number | null)[];
  slopesPerDecade: {
    tempF: number | null;
    precipIn: number | null;
    windMph: number | null;
    humidityPct: number | null;
  };
};

export type ProviderStatus = "idle" | "loading" | "ready" | "unavailable";
export type ForecastTimeMode = "daily" | "hourly";

export type AssistantAction = {
  type: "flyTo";
  lat: number;
  lon: number;
  zoom: number;
  label: string;
};

export type AssistantConversationState = { sessionId?: string } & Record<string, unknown>;

export type AssistantResponse = {
  answer: string;
  verdict: "good" | "marginal" | "avoid" | "insufficient_data";
  confidence: "low" | "medium" | "high";
  bestWindows: { label: string; score: number; rationale: string }[];
  risks: string[];
  dataUsed: string[];
  guardrailNote: string;
  actions: AssistantAction[];
  answerType?: string;
  persona?: string;
  capabilityNote?: string;
  missingData?: string[];
  conversationState?: AssistantConversationState | null;
};

export type AssistantContext = {
  conversationState?: AssistantConversationState | null;
  activeLayer: { id: LayerId; label: string };
  timeIdx: number | null;
  timeMode?: ForecastTimeMode;
  sourceBadge: string;
  forecastStatus: ProviderStatus;
  alertStatus: ProviderStatus;
  selected: null | {
    id: string;
    name?: string;
    state?: string;
    lat: number;
    lon: number;
    domain: Domain;
    score: number;
    riskLabel: DerivedMetrics["riskLabel"];
    layers?: Partial<Record<LayerId, number | null>>;
  };
  map: {
    center: { lat: number; lon: number };
    bounds: { north: number; south: number; east: number; west: number };
    zoom: number;
  };
  visiblePoints: {
    id: string;
    name?: string;
    state?: string;
    lat: number;
    lon: number;
    score: number;
    layers?: Partial<Record<LayerId, number | null>>;
  }[];
  pinnedPoints: {
    id: string;
    name?: string;
    state?: string;
    score: number;
    layers?: Partial<Record<LayerId, number | null>>;
  }[];
  assistantLocation?: null | {
    label: string;
    lat: number;
    lon: number;
  };
  alerts: {
    event: string;
    severity: string;
    areaDesc: string;
    effective?: string;
    expires?: string;
    bbox?: { north: number; south: number; east: number; west: number };
  }[];
};
