import type {
  CurrentMetrics,
  ForecastSeries,
  PointData,
  SamplePoint,
  TrendSeries
} from "../types";
import { computeDerived, mean, safeNumber } from "./derived";

function arr(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function get(obj: unknown, key: string): unknown {
  return obj && typeof obj === "object" ? (obj as Record<string, unknown>)[key] : undefined;
}

function numberArray(raw: unknown, len = 16): (number | null)[] {
  const values = arr(raw).map(safeNumber);
  while (values.length < len) values.push(null);
  return values.slice(0, len);
}

function stringArray(raw: unknown, len = 16): string[] {
  const values = arr(raw).map((v) => (typeof v === "string" ? v : ""));
  while (values.length < len) values.push("");
  return values.slice(0, len);
}

function looseNumberArray(raw: unknown, len = 384): (number | null)[] {
  return arr(raw).slice(0, len).map(safeNumber);
}

function looseStringArray(raw: unknown, len = 384): string[] {
  return arr(raw)
    .slice(0, len)
    .map((v) => (typeof v === "string" ? v : ""));
}

function emptyCurrent(): CurrentMetrics {
  return {
    tempF: null,
    apparentF: null,
    rhPct: null,
    precipIn: null,
    wind10Mph: null,
    cloudCoverPct: null
  };
}

function emptyForecast(): ForecastSeries {
  return {
    dates: Array.from({ length: 16 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    }),
    tmaxF: Array(16).fill(null),
    tminF: Array(16).fill(null),
    apparentMaxF: Array(16).fill(null),
    precipIn: Array(16).fill(null),
    wind10MaxMph: Array(16).fill(null),
    cloudCoverPct: Array(16).fill(null),
    hourly: {
      times: [],
      tempF: [],
      apparentF: [],
      precipIn: [],
      wind10Mph: [],
      cloudCoverPct: []
    }
  };
}

function normalizeForecast(raw: unknown): { current: CurrentMetrics; forecast: ForecastSeries } {
  const currentRaw = get(raw, "current");
  const dailyRaw = get(raw, "daily");
  const hourlyRaw = get(raw, "hourly");
  const forecast = emptyForecast();
  forecast.dates = stringArray(get(dailyRaw, "time"));
  forecast.tmaxF = numberArray(get(dailyRaw, "temperature_2m_max"));
  forecast.tminF = numberArray(get(dailyRaw, "temperature_2m_min"));
  forecast.apparentMaxF = numberArray(get(dailyRaw, "apparent_temperature_max"));
  forecast.precipIn = numberArray(get(dailyRaw, "precipitation_sum"));
  forecast.wind10MaxMph = numberArray(get(dailyRaw, "wind_speed_10m_max"));
  forecast.cloudCoverPct = numberArray(get(dailyRaw, "cloud_cover_mean"));
  forecast.hourly = {
    times: looseStringArray(get(hourlyRaw, "time")),
    tempF: looseNumberArray(get(hourlyRaw, "temperature_2m")),
    apparentF: looseNumberArray(get(hourlyRaw, "apparent_temperature")),
    precipIn: looseNumberArray(get(hourlyRaw, "precipitation")),
    wind10Mph: looseNumberArray(get(hourlyRaw, "wind_speed_10m")),
    cloudCoverPct: looseNumberArray(get(hourlyRaw, "cloud_cover"))
  };

  return {
    current: {
      ...emptyCurrent(),
      tempF: safeNumber(get(currentRaw, "temperature_2m")),
      apparentF: safeNumber(get(currentRaw, "apparent_temperature")),
      rhPct: safeNumber(get(currentRaw, "relative_humidity_2m")),
      precipIn: safeNumber(get(currentRaw, "precipitation")),
      wind10Mph: safeNumber(get(currentRaw, "wind_speed_10m")),
      cloudCoverPct: safeNumber(get(currentRaw, "cloud_cover"))
    },
    forecast
  };
}

export function normalizeBaseData(samples: SamplePoint[], forecastRaw: unknown[] | null): PointData[] {
  return samples.map((sample, i) => {
    const fx = forecastRaw?.[i] ? normalizeForecast(forecastRaw[i]) : { current: emptyCurrent(), forecast: emptyForecast() };
    const point = {
      sample,
      current: fx.current,
      forecast: fx.forecast
    };
    return { ...point, derived: computeDerived(point) };
  });
}

export function normalizeRawArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return raw == null ? [] : [raw];
}

export function normalizeTrend(raw: unknown): TrendSeries {
  const daily = get(raw, "daily");
  const dates = arr(get(daily, "time")).map((v) => (typeof v === "string" ? v : ""));
  const temp = arr(get(daily, "temperature_2m_mean")).map(safeNumber);
  const precip = arr(get(daily, "precipitation_sum")).map(safeNumber);
  const wind = arr(get(daily, "wind_speed_10m_max")).map(safeNumber);
  const humidity = arr(get(daily, "relative_humidity_2m_mean")).map(safeNumber);
  const byYear = new Map<number, { t: number[]; p: number[]; w: number[]; h: number[]; valid: number }>();

  dates.forEach((iso, i) => {
    const year = Number(iso.slice(0, 4));
    if (!Number.isFinite(year)) return;
    const bucket = byYear.get(year) ?? { t: [], p: [], w: [], h: [], valid: 0 };
    const vals = [temp[i], precip[i], wind[i], humidity[i]];
    if (vals.some((v) => v != null)) bucket.valid += 1;
    if (temp[i] != null) bucket.t.push(temp[i] as number);
    if (precip[i] != null) bucket.p.push(precip[i] as number);
    if (wind[i] != null) bucket.w.push(wind[i] as number);
    if (humidity[i] != null) bucket.h.push(humidity[i] as number);
    byYear.set(year, bucket);
  });

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const keep = years.filter((y) => (byYear.get(y)?.valid ?? 0) >= 300);
  const annualMeanTempF = keep.map((y) => mean(byYear.get(y)?.t ?? []));
  const annualPrecipIn = keep.map((y) => {
    const xs = byYear.get(y)?.p ?? [];
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  });
  const annualWindMaxAvgMph = keep.map((y) => mean(byYear.get(y)?.w ?? []));
  const annualHumidityPct = keep.map((y) => mean(byYear.get(y)?.h ?? []));

  return {
    years: keep,
    annualMeanTempF,
    annualPrecipIn,
    annualWindMaxAvgMph,
    annualHumidityPct,
    slopesPerDecade: {
      tempF: slopePerDecade(keep, annualMeanTempF),
      precipIn: slopePerDecade(keep, annualPrecipIn),
      windMph: slopePerDecade(keep, annualWindMaxAvgMph),
      humidityPct: slopePerDecade(keep, annualHumidityPct)
    }
  };
}

function slopePerDecade(years: number[], values: (number | null)[]): number | null {
  const pts = years.map((x, i) => ({ x, y: values[i] })).filter((p): p is { x: number; y: number } => p.y != null);
  if (pts.length < 2) return null;
  const mx = mean(pts.map((p) => p.x)) ?? 0;
  const my = mean(pts.map((p) => p.y)) ?? 0;
  const denom = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (denom === 0) return null;
  const slope = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / denom;
  return slope * 10;
}

export function emptyTrend(): TrendSeries {
  return {
    years: [],
    annualMeanTempF: [],
    annualPrecipIn: [],
    annualWindMaxAvgMph: [],
    annualHumidityPct: [],
    slopesPerDecade: { tempF: null, precipIn: null, windMph: null, humidityPct: null }
  };
}

export const TREND_TITLE = `30-YEAR TRENDS · 1995-2026 OPEN-METEO ARCHIVE`;
