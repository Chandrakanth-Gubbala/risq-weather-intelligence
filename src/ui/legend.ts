import type { ForecastTimeMode, LayerDefinition } from "../types";
import { forecastLabel } from "../utils";
import { icon } from "./icons";

export type LegendController = {
  el: HTMLElement;
  update: (layer: LayerDefinition, timeIdx: number | null, dates: string[], cursor: string, timeMode?: ForecastTimeMode, hourlyTimes?: string[]) => void;
};

export function createLegend(): LegendController {
  const root = document.createElement("div");
  root.className = "legend compact";
  root.innerHTML = `
    <button type="button" class="legend-toggle" aria-label="Expand legend">
      <span class="legend-title"></span>
      ${icon("info")}
    </button>
    <div class="legend-body">
      <div class="legend-bar"></div>
      <div class="legend-limits"><span></span><span></span><span></span><span></span></div>
      <p class="legend-caveat"></p>
    </div>
  `;
  const title = root.querySelector(".legend-title") as HTMLElement;
  const limits = root.querySelectorAll(".legend-limits span");
  const caveat = root.querySelector(".legend-caveat") as HTMLElement;
  const toggle = root.querySelector(".legend-toggle") as HTMLButtonElement;
  toggle.addEventListener("click", () => {
    root.classList.toggle("compact");
    toggle.setAttribute("aria-label", root.classList.contains("compact") ? "Expand legend" : "Collapse legend");
  });
  return {
    el: root,
    update(layer, timeIdx, dates, cursor, timeMode = "daily", hourlyTimes = []) {
      title.textContent = `${layer.label}${timeIdx == null ? "" : ` · ${forecastLabel(dates, timeIdx, timeMode, hourlyTimes).split(" · ")[1]}`}`;
      const tooltip = layer.caveat || `${layer.label} legend. ${layer.subtitle ?? layer.unit}`;
      toggle.dataset.tooltip = tooltip;
      toggle.title = tooltip;
      const scoreLike = layer.id === "risk" || layer.id === "fire";
      const labels = scoreLike ? ["Low", "Moderate", "High", "Extreme"] : [layer.legend[0], "", "", layer.legend[1]];
      limits.forEach((item, i) => {
        item.textContent = labels[i] ?? "";
      });
      caveat.textContent = layer.caveat ? `ⓘ ${layer.caveat}` : cursor ? `Current cursor: ${cursor}` : "";
    }
  };
}
