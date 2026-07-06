import type { ForecastSeries, TrendSeries } from "../types";
import { fmt, fmtSigned, rampColor } from "../utils";

function points(values: (number | null)[], width: number, height: number): string {
  const nums = values.filter((v): v is number => v != null);
  if (!nums.length) return "";
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      if (v == null) return "";
      const x = (i / Math.max(1, values.length - 1)) * width;
      const y = height - ((v - min) / span) * (height - 8) - 4;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

export function trendChart(label: string, values: (number | null)[], slope: number | null, unit: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "trend-chart";
  const head = document.createElement("div");
  head.className = "trend-head";
  head.innerHTML = `<span>${label}</span><b>${fmtSigned(slope, 2, unit)}/dec</b>`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 292 42");
  svg.innerHTML = `
    <polyline points="${points(values, 292, 42)}" fill="none" stroke="#7d8aa0" stroke-width="1.4" opacity=".9"/>
    <line x1="0" y1="32" x2="292" y2="10" stroke="#f97316" stroke-width="1" stroke-dasharray="4 3" opacity=".75"/>
  `;
  box.append(head, svg);
  return box;
}

export function renderTrendCharts(trend: TrendSeries): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "trend-grid";
  wrap.append(
    trendChart("Annual mean temp", trend.annualMeanTempF, trend.slopesPerDecade.tempF, "F"),
    trendChart("Annual precip", trend.annualPrecipIn, trend.slopesPerDecade.precipIn, " in"),
    trendChart("Daily max wind avg", trend.annualWindMaxAvgMph, trend.slopesPerDecade.windMph, " mph"),
    trendChart("Mean humidity", trend.annualHumidityPct, trend.slopesPerDecade.humidityPct, "%")
  );
  return wrap;
}

export function forecastBars(forecast: ForecastSeries, days = 16): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "forecast-bars";
  const count = Math.min(days, Math.max(forecast.dates.length, forecast.tmaxF.length, forecast.tminF.length, 1));
  const his = forecast.tmaxF.slice(0, count);
  const los = forecast.tminF.slice(0, count);
  const nums = [...his, ...los].filter((v): v is number => v != null);
  const min = nums.length ? Math.min(...nums) : 40;
  const max = nums.length ? Math.max(...nums) : 100;
  const span = max - min || 1;
  for (let i = 0; i < count; i += 1) {
    const hi = his[i];
    const lo = los[i];
    const date = forecast.dates[i] ? new Date(`${forecast.dates[i]}T12:00:00`) : new Date();
    const col = document.createElement("div");
    col.className = "forecast-col";
    const top = hi == null ? 50 : 100 - ((hi - min) / span) * 100;
    const bottom = lo == null ? 15 : ((lo - min) / span) * 100;
    col.innerHTML = `
      <b>${fmt(hi, 0)}</b>
      <div class="forecast-track"><i style="top:${Math.max(2, top)}%;bottom:${Math.max(4, bottom)}%;background:${rampColor(((hi ?? min) - min) / span)}"></i></div>
      <span>${fmt(lo, 0)}</span>
      <small>${forecast.precipIn[i] ? fmt(forecast.precipIn[i], 1) : "·"}</small>
      <em title="${date.toLocaleDateString([], { month: "short", day: "numeric" })}">${date.toLocaleDateString([], { weekday: "short" }).slice(0, 1)}</em>
    `;
    wrap.append(col);
  }
  return wrap;
}

export function hourlyForecastStrip(forecast: ForecastSeries): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "hourly-strip";
  const rows = forecast.hourly.times.slice(0, 24).map((time, i) => ({
    time,
    temp: forecast.hourly.tempF[i] ?? null,
    apparent: forecast.hourly.apparentF[i] ?? forecast.hourly.tempF[i] ?? null,
    rain: forecast.hourly.precipIn[i] ?? null,
    wind: forecast.hourly.wind10Mph[i] ?? null,
    cloud: forecast.hourly.cloudCoverPct[i] ?? null
  }));
  if (!rows.length) {
    wrap.innerHTML = `<div class="loading-note">Hourly forecast unavailable for this provider.</div>`;
    return wrap;
  }
  rows.forEach((row) => {
    const date = row.time ? new Date(row.time) : null;
    const hour = date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "numeric" }) : "—";
    const cloud = row.cloud == null ? "—" : fmt(row.cloud, 0, "%");
    const rain = row.rain == null ? "—" : row.rain > 0 ? fmt(row.rain, 2, " in") : "0";
    const cell = document.createElement("div");
    cell.className = "hourly-cell";
    cell.innerHTML = `
      <b>${hour}</b>
      <span>${fmt(row.apparent, 0, "F")}</span>
      <small>${rain}</small>
      <em>${fmt(row.wind, 0, " mph")}</em>
      <i title="Cloud cover">${cloud}</i>
    `;
    wrap.append(cell);
  });
  return wrap;
}

export function scoreRing(score: number, label: string): SVGSVGElement {
  const c = 207;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 86 86");
  svg.classList.add("score-ring");
  svg.innerHTML = `
    <circle cx="43" cy="43" r="33" stroke="#232c3d" stroke-width="7" fill="none"/>
    <circle cx="43" cy="43" r="33" stroke="${rampColor(score / 100)}" stroke-width="7" fill="none"
      stroke-linecap="round" stroke-dasharray="${(score / 100) * c} ${c}" transform="rotate(-90 43 43)"/>
    <text x="43" y="40" text-anchor="middle">${score}</text>
    <text x="43" y="56" text-anchor="middle">${label}</text>
  `;
  return svg;
}
