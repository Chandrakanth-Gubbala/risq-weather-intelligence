import type { AlertFeature, PointData, TrendSeries } from "../types";
import { fmt } from "../utils";
import { TREND_TITLE } from "../data/normalize";
import { forecastBars, hourlyForecastStrip, renderTrendCharts, scoreRing } from "./charts";
import { alertIconFor, icon } from "./icons";

export type TrendState =
  | { status: "idle" | "loading"; data?: null }
  | { status: "ready"; data: TrendSeries }
  | { status: "unavailable"; data?: null };

export type DetailController = {
  el: HTMLElement;
  update: (point: PointData | null, pinned: boolean, trend: TrendState, allPoints?: PointData[], selectedAlerts?: AlertFeature[]) => void;
};

export function createDetailPanel(args: {
  onClose: () => void;
  onPin: (id: string) => void;
}): DetailController {
  const root = document.createElement("section");
  root.className = "detail-panel hidden";
  root.setAttribute("aria-label", "Selected region details");

  return {
    el: root,
    update(point, pinned, trend, allPoints = [], selectedAlerts = []) {
      if (!point) {
        root.classList.remove("hidden");
        root.innerHTML = `
          <section class="inspector-empty card">
            <div class="empty-icon">${icon("mapPin")}</div>
            <h2>Select a region</h2>
            <p>Click the map or ask SkyScout about a U.S. place, route, or plan. The inspector will show local risk, forecast, and alerts here.</p>
          </section>
        `;
        return;
      }
      root.classList.remove("hidden");
      const d = point.derived;
      const percentile = stressPercentile(point, allPoints);
      const drivers = topDrivers(point);
      root.innerHTML = `
        <header class="detail-head card">
          <div class="detail-title">
            ${icon("pin")}
            <div><h2>${point.sample.name}, ${point.sample.state}</h2><p>${point.sample.lat.toFixed(2)}, ${point.sample.lon.toFixed(2)}</p></div>
          </div>
          <div class="detail-actions">
            <button type="button" class="pin">${pinned ? "Pinned" : "Compare / Pin"}</button>
            <button type="button" class="ask-advisor">Ask SkyScout</button>
          </div>
          <button type="button" class="close" aria-label="Close detail panel">×</button>
        </header>
        <section class="risk-card card">
          <div class="score-wrap"></div>
          <div class="risk-copy">
            <span class="severity ${severityClass(d.score)}">${d.riskLabel}</span>
            <b>${(d.score / 10).toFixed(1)} / 10</b>
            <p>Forecast stress score</p>
            <small>${percentile == null ? "Percentile unavailable" : `Higher than ${percentile}% of visible named regions`}</small>
          </div>
        </section>
        <section class="driver-card card">
          <div class="section-label">Top drivers</div>
          <div class="driver-list">
            ${drivers.map((driver) => driverRow(driver.label, driver.value, driver.score)).join("")}
          </div>
        </section>
        <section class="metric-card card">
          <div class="metric-grid">
            ${metric("Temp", fmt(point.current.tempF, 0, "F"))}
            ${metric("Feels", fmt(point.current.apparentF, 0, "F"))}
            ${metric("Humidity", fmt(point.current.rhPct, 0, "%"))}
            ${metric("Wind", fmt(point.current.wind10Mph, 0, " mph"))}
            ${metric("Cloud", fmt(point.derived.cloudMeanPct, 0, "%"))}
            ${metric("CDD 7D", fmt(point.derived.cdd7, 0))}
          </div>
        </section>
        <section class="forecast-card card">
          <div class="section-label">Local forecast · next 24h</div>
          <div class="forecast-periods">${forecastPeriods(point)}</div>
          <details>
            <summary>Hourly details</summary>
            <div class="hourly-slot"></div>
          </details>
        </section>
        <section class="alerts-card card">
          <div class="section-label">Active alerts</div>
          <div class="alert-list">${selectedAlerts.length ? selectedAlerts.slice(0, 4).map(alertRow).join("") : `<div class="quiet-note">No severe NWS alert polygon intersects this selected point.</div>`}</div>
        </section>
        <details class="trend-card card">
          <summary>${TREND_TITLE}</summary>
          <div class="trend-slot"></div>
        </details>
        <details class="daily-card card">
          <summary>16-day forecast</summary>
          <div class="forecast-slot"></div>
        </details>
      `;
      const scoreWrap = root.querySelector(".score-wrap") as HTMLElement;
      scoreWrap.append(scoreRing(d.score, d.riskLabel));
      (root.querySelector(".hourly-slot") as HTMLElement).append(hourlyForecastStrip(point.forecast));
      (root.querySelector(".forecast-slot") as HTMLElement).append(forecastBars(point.forecast));
      const trendSlot = root.querySelector(".trend-slot") as HTMLElement;
      if (trend.status === "loading" || trend.status === "idle") {
        trendSlot.innerHTML = `<div class="loading-note">Loading historical archive...</div>`;
      } else if (trend.status === "unavailable") {
        trendSlot.innerHTML = `<div class="error-note">Historical archive unavailable.</div>`;
      } else if (trend.status === "ready") {
        trendSlot.append(renderTrendCharts(trend.data));
      }
      root.querySelector<HTMLButtonElement>(".close")?.addEventListener("click", args.onClose);
      root.querySelector<HTMLButtonElement>(".pin")?.addEventListener("click", () => args.onPin(point.sample.id));
      root.querySelector<HTMLButtonElement>(".ask-advisor")?.addEventListener("click", () => {
        document.querySelector<HTMLInputElement>(".assistant-form input")?.focus();
      });
    }
  };
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span>${label}</span><b>${value}</b></div>`;
}

function stressPercentile(point: PointData, allPoints: PointData[]): number | null {
  const named = allPoints.filter((p) => p.sample.kind === "region");
  if (named.length < 2) return null;
  const below = named.filter((p) => p.derived.score <= point.derived.score).length;
  return Math.round((below / named.length) * 100);
}

function topDrivers(point: PointData): { label: string; value: string; score: number }[] {
  return [
    { label: "Heat", value: fmt(point.derived.heat7F, 0, "F"), score: point.derived.heatS },
    { label: "Fire weather", value: fmt(point.derived.fireS * 100, 0), score: point.derived.fireS },
    { label: "Wind", value: fmt(point.derived.windMaxMph, 0, " mph"), score: point.derived.windS },
    { label: "Cooling demand", value: fmt(point.derived.cdd7, 0, " CDD"), score: point.derived.cddS }
  ].sort((a, b) => b.score - a.score).slice(0, 3);
}

function driverRow(label: string, value: string, score: number): string {
  return `
    <div class="driver-row">
      <span>${label}</span>
      <b>${value}</b>
      <em class="severity ${severityClass(score * 100)}">${severityLabel(score * 100)}</em>
    </div>
  `;
}

function severityLabel(score: number): string {
  if (score >= 70) return "High";
  if (score >= 45) return "Elevated";
  if (score >= 25) return "Moderate";
  return "Low";
}

function severityClass(score: number): string {
  if (score >= 70) return "extreme";
  if (score >= 55) return "high";
  if (score >= 35) return "moderate";
  return "low";
}

function forecastPeriods(point: PointData): string {
  const groups = [
    ["Tonight", 0, 8],
    ["Tomorrow", 8, 16],
    ["Tomorrow Night", 16, 24]
  ] as const;
  return groups
    .map(([label, start, end]) => {
      const temp = average(point.forecast.hourly.apparentF.slice(start, end));
      const rain = sum(point.forecast.hourly.precipIn.slice(start, end));
      const wind = average(point.forecast.hourly.wind10Mph.slice(start, end));
      const cloud = average(point.forecast.hourly.cloudCoverPct.slice(start, end));
      return `<div class="forecast-period"><b>${label}</b><span>${fmt(temp, 0, "F")} · ${fmt(rain, 2, " in")} rain</span><small>${fmt(wind, 0, " mph")} wind · ${fmt(cloud, 0, "%")} cloud</small></div>`;
    })
    .join("");
}

function average(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((sum, v) => sum + v, 0) / xs.length : null;
}

function sum(values: (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((total, v) => total + v, 0) : null;
}

function alertRow(alert: AlertFeature): string {
  const timing = [formatAlertTime(alert.effective), formatAlertTime(alert.expires)].filter(Boolean).join(" to ");
  return `
    <div class="alert-row">
      ${alertIconFor(alert.event)}
      <span><b>${alert.event}</b><small>${timing || alert.areaDesc}</small></span>
    </div>
  `;
}

function formatAlertTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}
