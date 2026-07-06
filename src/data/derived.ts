import type { DerivedMetrics, ForecastTimeMode, LayerDefinition, PointData } from "../types";
import { clamp01, fmt } from "../utils";

export function safeNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function nonNull(values: (number | null | undefined)[]): number[] {
  return values.filter((v): v is number => v != null && Number.isFinite(v));
}

export function mean(values: (number | null | undefined)[]): number | null {
  const xs = nonNull(values);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function sum(values: (number | null | undefined)[]): number | null {
  const xs = nonNull(values);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

export function max(values: (number | null | undefined)[]): number | null {
  const xs = nonNull(values);
  return xs.length ? Math.max(...xs) : null;
}

function riskLabel(score: number): DerivedMetrics["riskLabel"] {
  if (score >= 70) return "Extreme";
  if (score >= 55) return "High";
  if (score >= 40) return "Elevated";
  if (score >= 25) return "Moderate";
  return "Low";
}

function compositeScore(parts: { weight: number; score: number; include?: boolean }[]): number {
  const active = parts.filter((part) => part.include !== false);
  const totalWeight = active.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight <= 0) return 0;
  return Math.round((100 * active.reduce((sum, part) => sum + part.weight * part.score, 0)) / totalWeight);
}

function cddScore(cdd: number | null, scale = 120): number {
  return cdd == null ? 0 : clamp01(cdd / scale);
}

export function computeForecastDerived(
  p: PointData,
  timeIdx: number
): Pick<DerivedMetrics, "heatS" | "fireS" | "windS" | "cddS" | "score"> {
  const f = p.forecast;
  const heat = f.apparentMaxF[timeIdx] ?? null;
  const tmax = f.tmaxF[timeIdx] ?? null;
  const tmin = f.tminF[timeIdx] ?? null;
  const wind = f.wind10MaxMph[timeIdx] ?? null;
  const rhPct = p.current.rhPct ?? 50;
  const heatS = heat == null ? p.derived.heatS : clamp01((heat - 60) / 52);
  const windS = wind == null ? p.derived.windS : clamp01(wind / 45);
  const fireS =
    tmax == null
      ? p.derived.fireS
      : clamp01(clamp01((tmax - 68) / 42) * (1 - rhPct / 100) * 1.7 * (0.5 + windS));
  const cdd = tmax == null || tmin == null ? null : Math.max(0, (tmax + tmin) / 2 - 65);
  const cddS = cdd == null ? p.derived.cddS : cddScore(cdd, 25);
  const score = compositeScore([
    { weight: 0.38, score: heatS },
    { weight: 0.28, score: fireS },
    { weight: 0.22, score: windS },
    { weight: 0.12, score: cddS }
  ]);
  return { heatS, fireS, windS, cddS, score };
}

export function computeHourlyDerived(
  p: PointData,
  hourIdx: number
): Pick<DerivedMetrics, "heatS" | "fireS" | "windS" | "cddS" | "score"> {
  const h = p.forecast.hourly;
  const heat = h.apparentF[hourIdx] ?? h.tempF[hourIdx] ?? null;
  const temp = h.tempF[hourIdx] ?? null;
  const wind = h.wind10Mph[hourIdx] ?? null;
  const rhPct = p.current.rhPct ?? 50;
  const heatS = heat == null ? p.derived.heatS : clamp01((heat - 60) / 52);
  const windS = wind == null ? p.derived.windS : clamp01(wind / 45);
  const fireS =
    temp == null
      ? p.derived.fireS
      : clamp01(clamp01((temp - 68) / 42) * (1 - rhPct / 100) * 1.7 * (0.5 + windS));
  const cdd = temp == null ? null : Math.max(0, temp - 65) / 24;
  const cddS = cdd == null ? p.derived.cddS : cddScore(cdd, 2);
  const score = compositeScore([
    { weight: 0.38, score: heatS },
    { weight: 0.28, score: fireS },
    { weight: 0.22, score: windS },
    { weight: 0.12, score: cddS }
  ]);
  return { heatS, fireS, windS, cddS, score };
}

function hourlyValue(p: PointData, i: number | null, getter: (idx: number) => number | null): number | null {
  return i == null ? null : getter(i);
}

function isHourly(mode?: ForecastTimeMode): boolean {
  return mode === "hourly";
}

export function computeDerived(p: Omit<PointData, "derived">): DerivedMetrics {
  const f = p.forecast;
  const current = p.current;
  const heat7F = mean(f.apparentMaxF.slice(0, 7));
  const tmax7F = max(f.tmaxF.slice(0, 7));
  const precip7In = sum(f.precipIn.slice(0, 7));
  const windMaxMph = max(f.wind10MaxMph.slice(0, 7));
  const cloudMeanPct = mean(f.cloudCoverPct.slice(0, 7));
  const rhPct = current.rhPct ?? 50;
  const cdd7 = sum(
    f.tmaxF.slice(0, 7).map((hi, i) => {
      const lo = f.tminF[i];
      return hi == null || lo == null ? null : Math.max(0, (hi + lo) / 2 - 65);
    })
  );
  const heatS = heat7F == null ? 0 : clamp01((heat7F - 60) / 52);
  const windS = windMaxMph == null ? 0 : clamp01(windMaxMph / 45);
  const fireS =
    tmax7F == null ? 0 : clamp01(clamp01((tmax7F - 68) / 42) * (1 - rhPct / 100) * 1.7 * (0.5 + windS));
  const cddS = cddScore(cdd7);
  const score = compositeScore([
    { weight: 0.38, score: heatS },
    { weight: 0.28, score: fireS },
    { weight: 0.22, score: windS },
    { weight: 0.12, score: cddS }
  ]);

  return {
    heat7F,
    tmax7F,
    precip7In,
    windMaxMph,
    cloudMeanPct,
    cdd7,
    heatS,
    fireS,
    windS,
    cddS,
    score,
    riskLabel: riskLabel(score)
  };
}

export const LAYERS: LayerDefinition[] = [
  {
    id: "risk",
    label: "Forecast stress score",
    subtitle: "Composite risk",
    group: "weather",
    lo: 0,
    hi: 100,
    unit: "",
    legend: ["Low", "Extreme"],
    value: (p, i, mode) => (i == null ? p.derived.score : isHourly(mode) ? computeHourlyDerived(p, i).score : computeForecastDerived(p, i).score),
    format: (v) => fmt(v, 0),
    caveat: "Uses transmitted forecast heat index, fire-weather proxy, 10 m wind, and cooling-degree demand only."
  },
  {
    id: "heat",
    label: "Heat index",
    subtitle: "Feels like temperature",
    group: "weather",
    lo: 55,
    hi: 112,
    unit: "F",
    legend: ["55F", "112F"],
    value: (p, i, mode) => (i == null ? p.derived.heat7F : isHourly(mode) ? hourlyValue(p, i, (idx) => p.forecast.hourly.apparentF[idx] ?? p.forecast.hourly.tempF[idx] ?? null) : p.forecast.apparentMaxF[i] ?? null),
    format: (v) => fmt(v, 0, "F")
  },
  {
    id: "temp",
    label: "Temperature",
    subtitle: "Observed & forecast",
    group: "weather",
    lo: 30,
    hi: 110,
    unit: "F",
    legend: ["30F", "110F"],
    value: (p, i, mode) => (i == null ? p.current.tempF : isHourly(mode) ? hourlyValue(p, i, (idx) => p.forecast.hourly.tempF[idx] ?? null) : p.forecast.tmaxF[i] ?? null),
    format: (v) => fmt(v, 0, "F")
  },
  {
    id: "fire",
    label: "Fire weather",
    subtitle: "Dryness & winds",
    group: "weather",
    lo: 0,
    hi: 100,
    unit: "",
    legend: ["Low", "Extreme"],
    value: (p, i, mode) => (i == null ? p.derived.fireS * 100 : isHourly(mode) ? computeHourlyDerived(p, i).fireS * 100 : computeForecastDerived(p, i).fireS * 100),
    format: (v) => fmt(v, 0)
  },
  {
    id: "wind",
    label: "Wind 7d max",
    subtitle: "Sustained & gusts",
    group: "weather",
    lo: 0,
    hi: 50,
    unit: "mph",
    legend: ["0", "50 mph"],
    value: (p, i, mode) => (i == null ? p.derived.windMaxMph : isHourly(mode) ? hourlyValue(p, i, (idx) => p.forecast.hourly.wind10Mph[idx] ?? null) : p.forecast.wind10MaxMph[i] ?? null),
    format: (v) => fmt(v, 0, " mph")
  },
  {
    id: "humidity",
    label: "Humidity",
    subtitle: "Relative humidity",
    group: "weather",
    lo: 5,
    hi: 100,
    unit: "%",
    legend: ["5%", "100%"],
    value: (p) => p.current.rhPct,
    format: (v) => fmt(v, 0, "%")
  },
  {
    id: "cloud",
    label: "Cloud cover",
    subtitle: "Sky conditions",
    group: "weather",
    lo: 0,
    hi: 100,
    unit: "%",
    legend: ["Clear", "Overcast"],
    value: (p, i, mode) => (i == null ? p.derived.cloudMeanPct : isHourly(mode) ? hourlyValue(p, i, (idx) => p.forecast.hourly.cloudCoverPct[idx] ?? null) : p.forecast.cloudCoverPct[i] ?? null),
    format: (v) => fmt(v, 0, "%"),
    caveat: "Mean cloud cover from forecast model output. Useful for stargazing screening, but not a full dark-sky, smoke, haze, or moon-phase model."
  },
  {
    id: "cdd",
    label: "Cooling degree days",
    subtitle: "Demand indicator",
    group: "business",
    lo: 0,
    hi: 120,
    unit: "CDD",
    legend: ["0", "120"],
    value: (p) => p.derived.cdd7,
    format: (v) => fmt(v, 0, " CDD")
  },
];
