import type { AlertFeature, ForecastTimeMode, LayerDefinition, PointData, ProviderStatus } from "../types";
import { byLayerDesc, isNamedPoint, normalizeLayerValue, rampColor, SETTINGS, valueToT } from "../utils";
import { icon, layerIcon } from "./icons";

export type SidebarController = {
  el: HTMLElement;
  update: (args: {
    points: PointData[];
    layers: LayerDefinition[];
    activeLayer: LayerDefinition;
    timeIdx: number | null;
    timeMode: ForecastTimeMode;
    selectedId: string | null;
    alertStatus: ProviderStatus;
    alerts: AlertFeature[];
    alertsEnabled: boolean;
    baseStatus: ProviderStatus;
    baseError: string | null;
    forecastStatus: ProviderStatus;
    sourceBadge: string;
  }) => void;
};

export function createSidebar(args: {
  layers: LayerDefinition[];
  activeLayer: LayerDefinition;
  onLayer: (id: string) => void;
  onSelect: (id: string) => void;
  onToggleAlerts: () => void;
}): SidebarController {
  const root = document.createElement("aside");
  root.className = "sidebar";
  root.setAttribute("aria-label", "Climate risk controls");
  root.innerHTML = `
    <section class="sidebar-section">
      <div class="section-label">Weather & Climate</div>
      <div class="layer-list weather"></div>
    </section>
    <section class="sidebar-section">
      <div class="section-label">Business Signals</div>
      <div class="layer-list business"></div>
    </section>
    <section class="sidebar-section rank-card">
      <div class="rank-head"><span>Highest risk regions</span><b></b></div>
      <div class="rank-list"></div>
    </section>
    <footer class="sidebar-footer">
      <button type="button" aria-label="Dashboard settings">${icon("settings")}<span>Settings</span></button>
      <button type="button" aria-label="Dashboard help">${icon("info")}<span>Help</span></button>
    </footer>
  `;
  const weather = root.querySelector(".weather") as HTMLElement;
  const business = root.querySelector(".business") as HTMLElement;
  const rankList = root.querySelector(".rank-list") as HTMLElement;
  const rankLabel = root.querySelector(".rank-head b") as HTMLElement;

  for (const layer of args.layers) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "layer-card";
    btn.dataset.layer = layer.id;
    btn.title = layer.caveat ?? `${layer.label} layer`;
    btn.setAttribute("aria-label", layer.caveat ? `${layer.label}. ${layer.caveat}` : layer.label);
    btn.innerHTML = `
      ${layerIcon(layer.id)}
      <span class="layer-copy"><b>${layer.label}</b><small>${layer.subtitle ?? layer.unit}</small></span>
    `;
    btn.addEventListener("click", () => args.onLayer(layer.id));
    (layer.group === "weather" ? weather : business).append(btn);
  }

  function updateLayerButtons(active: LayerDefinition): void {
    root.querySelectorAll<HTMLButtonElement>(".layer-card").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.layer === active.id);
    });
  }

  return {
    el: root,
    update(state) {
      updateLayerButtons(state.activeLayer);
      root.dataset.status = state.baseStatus;
      root.dataset.alerts = state.alertsEnabled ? "on" : "off";
      rankLabel.textContent = state.timeMode === "hourly" && state.timeIdx != null ? `+${state.timeIdx}h` : state.timeIdx == null ? "Now" : `Day ${state.timeIdx + 1}`;
      rankList.innerHTML = "";
      if (state.baseStatus === "loading" && state.forecastStatus !== "ready") {
        rankList.innerHTML = `<div class="loading-note compact">Fetching live forecast data...</div>`;
        return;
      }
      if (state.baseStatus === "unavailable") {
        rankList.innerHTML = `<div class="error-note">Live forecast unavailable.${state.baseError ? `<br>${state.baseError}` : ""}</div>`;
        return;
      }
      state.points
        .filter(isNamedPoint)
        .sort(byLayerDesc(state.activeLayer, state.timeIdx, state.timeMode))
        .slice(0, SETTINGS.rankCount)
        .forEach((point, index) => {
          const value = normalizeLayerValue(state.activeLayer, point, state.timeIdx, state.timeMode);
          const row = document.createElement("button");
          row.type = "button";
          row.className = `rank-row${state.selectedId === point.sample.id ? " selected" : ""}`;
          row.innerHTML = `
            <span class="rank-num">${index + 1}</span>
            <span class="rank-main"><b>${point.sample.name}</b><small>${point.sample.state} · Stress ${point.derived.score} · ${point.derived.riskLabel}</small></span>
            <span class="rank-chip" style="border-color:${rampColor(valueToT(state.activeLayer, value))}">${state.activeLayer.format(value)}</span>
          `;
          row.addEventListener("click", () => args.onSelect(point.sample.id));
          rankList.append(row);
        });
    }
  };
}
