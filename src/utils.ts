import type { ForecastTimeMode, LayerDefinition, LayerId, PointData } from "./types";

export const COLORS = {
  bgApp: "#0a0d13",
  bgPanel: "#0e121a",
  bgCard: "#12171f",
  bgActive: "#1a2232",
  border1: "#1c2330",
  border2: "#232c3d",
  borderHover: "#3b4a63",
  text1: "#e8ecf3",
  text2: "#a7b4c9",
  text3: "#7d8aa0",
  text4: "#526078",
  accent: "#f97316",
  accentText: "#fbbf77",
  alertBg: "#1a1210",
  alertBorder: "#4a2a1a",
  blue: "#38bdf8",
  violet: "#a78bfa",
  green: "#22c55e",
  red: "#dc2626"
} as const;

export const RISK_RAMP: [number, number, number][] = [
  [37, 99, 235],
  [34, 197, 94],
  [234, 179, 8],
  [249, 115, 22],
  [220, 38, 38]
];

export const SETTINGS = {
  showAlerts: true,
  rankCount: 12,
  heatOpacity: 0.55,
  showStations: false,
  markerScale: 1.0,
  enableRefinement: true,
  maxRefinementSamples: 500,
  heatCellPx: 7
};

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

export function rampColor(t: number): string {
  const x = clamp01(t) * (RISK_RAMP.length - 1);
  const i = Math.min(RISK_RAMP.length - 2, Math.floor(x));
  const f = x - i;
  const a = RISK_RAMP[i];
  const b = RISK_RAMP[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

export function fmt(v: number | null, digits = 0, suffix = ""): string {
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${suffix}`;
}

export function fmtSigned(v: number | null, digits = 1, suffix = ""): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}${suffix}`;
}

export function valueToT(layer: LayerDefinition, v: number | null): number {
  if (v == null || !Number.isFinite(v)) return 0;
  return clamp01((v - layer.lo) / (layer.hi - layer.lo));
}

export function formatTime(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toUpperCase();
}

export function forecastLabel(dates: string[], timeIdx: number | null, timeMode: ForecastTimeMode = "daily", hourlyTimes: string[] = []): string {
  if (timeIdx == null) return "LIVE · NOW";
  if (timeMode === "hourly") {
    const iso = hourlyTimes[timeIdx];
    const date = iso ? new Date(iso) : new Date(Date.now() + timeIdx * 3600000);
    const label = date.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric" }).toUpperCase();
    return `${label} · +${timeIdx}H FORECAST`;
  }
  const iso = dates[timeIdx];
  const date = iso ? new Date(`${iso}T12:00:00`) : new Date(Date.now() + timeIdx * 86400000);
  const label = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  return `${label} · +${timeIdx}D FORECAST`;
}

export function isNamedPoint(p: PointData): boolean {
  return p.sample.kind === "region";
}

export function normalizeLayerValue(layer: LayerDefinition, p: PointData, timeIdx: number | null, timeMode: ForecastTimeMode = "daily"): number | null {
  const v = layer.value(p, timeIdx, timeMode);
  return v == null || Number.isNaN(v) ? null : v;
}

export function byLayerDesc(layer: LayerDefinition, timeIdx: number | null, timeMode: ForecastTimeMode = "daily") {
  return (a: PointData, b: PointData) => {
    const av = normalizeLayerValue(layer, a, timeIdx, timeMode) ?? -Infinity;
    const bv = normalizeLayerValue(layer, b, timeIdx, timeMode) ?? -Infinity;
    return bv - av;
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function button(className: string, label: string, ariaLabel?: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  if (ariaLabel) node.setAttribute("aria-label", ariaLabel);
  return node;
}

export function safeJsonParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const LAYER_ORDER: LayerId[] = [
  "risk",
  "heat",
  "temp",
  "fire",
  "wind",
  "humidity",
  "cloud",
  "cdd"
];
