import type { PointData } from "../types";
import { fmt, rampColor } from "../utils";

export type CompareTrayController = {
  el: HTMLElement;
  update: (points: PointData[]) => void;
};

const rows: [string, (p: PointData) => number | null, boolean][] = [
  ["Stress score", (p) => p.derived.score, true],
  ["Heat index", (p) => p.derived.heat7F, false],
  ["Temperature", (p) => p.derived.tmax7F, false],
  ["Fire weather", (p) => p.derived.fireS * 100, true],
  ["Wind max", (p) => p.derived.windMaxMph, false],
  ["Humidity", (p) => p.current.rhPct, false],
  ["Cloud cover", (p) => p.derived.cloudMeanPct, false],
  ["CDD 7d", (p) => p.derived.cdd7, false],
  ["Precip 7d", (p) => p.derived.precip7In, false]
];

export function createCompareTray(onClear: () => void): CompareTrayController {
  const root = document.createElement("section");
  root.className = "compare-panel";
  root.setAttribute("aria-label", "Pinned region comparison");
  return {
    el: root,
    update(points) {
      if (!points.length) {
        root.innerHTML = `
          <div class="compare-empty">
            <h2>Compare pinned regions</h2>
            <p>Pin up to 3 regions from the Details panel to compare stress, heat, wind, cloud cover, cooling demand, and 16-day forecast shape.</p>
          </div>
        `;
        return;
      }
      root.innerHTML = `
        <header class="compare-head">
          <div><h2>Compare pinned regions</h2><p>${points.length}/3 pinned${points.length === 1 ? " · pin another region for side-by-side comparison" : ""}</p></div>
          <button type="button">Clear</button>
        </header>
        <div class="compare-cards"></div>
        <div class="compare-grid" style="grid-template-columns:minmax(92px, .75fr) repeat(${points.length}, minmax(88px, 1fr))"></div>
      `;
      root.querySelector("button")?.addEventListener("click", onClear);
      const cards = root.querySelector(".compare-cards") as HTMLElement;
      points.forEach((p) => cards.append(regionCard(p)));
      const grid = root.querySelector(".compare-grid") as HTMLElement;
      grid.append(cell("", "label"));
      points.forEach((p) => grid.append(cell(`${p.sample.name}<br>${p.sample.state}`, "head")));
      rows.forEach(([label, getter, color]) => {
        grid.append(cell(label, "label"));
        points.forEach((p) => {
          const v = getter(p);
          const text = formatCompareValue(label, v);
          const node = cell(text, "value");
          if (color) node.style.color = rampColor(Math.min(1, (v ?? 0) / 100));
          grid.append(node);
        });
      });
    }
  };
}

function regionCard(point: PointData): HTMLElement {
  const card = document.createElement("article");
  card.className = "compare-region-card";
  card.innerHTML = `
    <div>
      <b>${point.sample.name}</b>
      <span>${point.sample.state} · ${point.derived.riskLabel}</span>
    </div>
    <strong style="color:${rampColor(point.derived.score / 100)}">${point.derived.score}</strong>
    <div class="compare-spark">${sparkBars(point)}</div>
  `;
  return card;
}

function sparkBars(point: PointData): string {
  const values = point.forecast.apparentMaxF.slice(0, 16);
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  const min = nums.length ? Math.min(...nums) : 50;
  const max = nums.length ? Math.max(...nums) : 100;
  const span = max - min || 1;
  return values
    .map((value) => {
      const height = value == null ? 18 : 18 + ((value - min) / span) * 30;
      return `<i style="height:${Math.max(8, height).toFixed(0)}px;background:${rampColor(((value ?? min) - min) / span)}"></i>`;
    })
    .join("");
}

function formatCompareValue(label: string, value: number | null): string {
  if (label.includes("Heat") || label.includes("Temperature")) return fmt(value, 0, "F");
  if (label.includes("Wind")) return fmt(value, 0, " mph");
  if (label.includes("Humidity") || label.includes("Cloud")) return fmt(value, 0, "%");
  if (label.includes("Precip")) return fmt(value, 1, " in");
  if (label.includes("CDD")) return fmt(value, 0, " CDD");
  return fmt(value, 0);
}

function cell(html: string, cls: string): HTMLElement {
  const div = document.createElement("div");
  div.className = cls;
  div.innerHTML = html;
  return div;
}
