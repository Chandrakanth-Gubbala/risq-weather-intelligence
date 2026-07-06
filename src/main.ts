import "leaflet/dist/leaflet.css";
import "./styles.css";
import type { LatLngBounds } from "leaflet";
import type {
  AlertFeature,
  AssistantAction,
  AssistantContext,
  AssistantConversationState,
  ForecastTimeMode,
  LayerDefinition,
  LayerId,
  PointData,
  ProviderStatus,
  SamplePoint,
  TrendSeries
} from "./types";
import { fetchAlerts, fetchAssistantResponse, fetchForecast, fetchHistoricalTrends } from "./data/api";
import { cacheHourKey, safeGetSession, safeSetSession } from "./data/cache";
import { LAYERS } from "./data/derived";
import { BASE_SAMPLE_POINTS } from "./data/regions";
import { normalizeBaseData } from "./data/normalize";
import { createMapController, type MapController } from "./map/map";
import { candidateKey, classifyDomain, cosineDistance } from "./map/interpolation";
import { createCompareTray } from "./ui/compareTray";
import { createAssistant } from "./ui/assistant";
import { createDetailPanel, type TrendState } from "./ui/detailPanel";
import { createLegend } from "./ui/legend";
import { createSidebar } from "./ui/sidebar";
import { createTimeline } from "./ui/timeline";
import { installAccessibility } from "./ui/accessibility";
import { formatTime, LAYER_ORDER, SETTINGS, byLayerDesc, isNamedPoint } from "./utils";

type RawCache = {
  forecast: unknown[] | null;
};

const BASE_CACHE_KEY = "crd-base-v8-hourly";
const PLAY_STEPS = [0, 6, 12, 24, 48, 72];

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

installAccessibility();

let activeLayer: LayerDefinition = LAYERS[0];
let timeIdx: number | null = null;
let timeMode: ForecastTimeMode = "daily";
let points: PointData[] = normalizeBaseData(BASE_SAMPLE_POINTS, null);
let alerts: AlertFeature[] = [];
let alertsEnabled = SETTINGS.showAlerts;
let baseStatus: ProviderStatus = "loading";
let forecastStatus: ProviderStatus = "loading";
let alertStatus: ProviderStatus = "loading";
let baseError: string | null = null;
let sourceBadge = "CONNECTING";
let selectedId: string | null = null;
let pinnedIds: string[] = [];
let cursorValue: number | null = null;
let playTimer = 0;
let playbackDelay = 1200;
let activeInspectorTab: "details" | "compare" = "details";
let workspaceWasVisible = false;
const trendCache = new Map<string, TrendState>();
const refinementAttempted = new Set<string>();
let refinementBlockedUntil = 0;
let mapController: MapController;
let rawForecast: unknown[] | null = null;

app.innerHTML = `
  <div class="app-shell">
    <header class="topbar">
      <button class="sidebar-toggle" type="button" aria-label="Collapse sidebar" aria-pressed="false"><span></span><span></span><span></span></button>
      <div class="brand"><div class="logo">US</div><div><h1>Climate Risk Monitor</h1><p>Weather risk intelligence</p></div></div>
      <div class="top-spacer"></div>
      <div class="top-pill layer-pill"></div>
      <div class="top-pill status-pill"></div>
      <button class="top-pill alerts-pill" type="button"></button>
      <div class="top-pill risks-pill"></div>
      <div class="top-pill updated-pill"></div>
      <div class="top-pill source-health" tabindex="0">
        <span>Source health</span>
        <div class="source-popover hidden"></div>
      </div>
    </header>
    <main class="body">
      <div class="sidebar-slot"></div>
      <section class="map-area">
        <div id="map"></div>
        <div class="float-stack"></div>
        <div class="map-bottom-controls"></div>
      </section>
      <aside class="inspector-slot">
        <section class="advisor-pane"></section>
        <section class="workspace-shell">
          <div class="workspace-tabs" role="tablist" aria-label="Inspector workspace">
            <button type="button" data-tab="details" role="tab">Details</button>
            <button type="button" data-tab="compare" role="tab">Compare <span class="compare-count">0</span></button>
          </div>
          <div class="workspace-panel details-pane" role="tabpanel"></div>
          <div class="workspace-panel compare-pane" role="tabpanel"></div>
        </section>
      </aside>
    </main>
  </div>
`;

const sidebarSlot = app.querySelector(".sidebar-slot") as HTMLElement;
const appShell = app.querySelector(".app-shell") as HTMLElement;
const sidebarToggle = app.querySelector(".sidebar-toggle") as HTMLButtonElement;
const mapEl = app.querySelector("#map") as HTMLElement;
const floatStack = app.querySelector(".float-stack") as HTMLElement;
const mapBottomControls = app.querySelector(".map-bottom-controls") as HTMLElement;
const inspectorSlot = app.querySelector(".inspector-slot") as HTMLElement;
const advisorPane = app.querySelector(".advisor-pane") as HTMLElement;
const detailsPane = app.querySelector(".details-pane") as HTMLElement;
const comparePane = app.querySelector(".compare-pane") as HTMLElement;
const workspaceTabs = app.querySelector(".workspace-tabs") as HTMLElement;
const compareCount = app.querySelector(".compare-count") as HTMLElement;
const layerPill = app.querySelector(".layer-pill") as HTMLElement;
const statusPill = app.querySelector(".status-pill") as HTMLElement;
const alertsPill = app.querySelector(".alerts-pill") as HTMLButtonElement;
const risksPill = app.querySelector(".risks-pill") as HTMLElement;
const updatedPill = app.querySelector(".updated-pill") as HTMLElement;
const sourceHealth = app.querySelector(".source-health") as HTMLElement;
const sourcePopover = app.querySelector(".source-popover") as HTMLElement;

sidebarToggle.addEventListener("click", () => {
  const collapsed = !appShell.classList.contains("sidebar-collapsed");
  appShell.classList.toggle("sidebar-collapsed", collapsed);
  sidebarToggle.setAttribute("aria-pressed", collapsed ? "true" : "false");
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  window.setTimeout(() => mapController?.map.invalidateSize(), 80);
});

const sidebar = createSidebar({
  layers: LAYER_ORDER.map((id) => LAYERS.find((l) => l.id === id) as LayerDefinition),
  activeLayer,
  onLayer: (id) => {
    activeLayer = LAYERS.find((l) => l.id === id) ?? activeLayer;
    render();
  },
  onSelect: selectRegion,
  onToggleAlerts: () => {
    alertsEnabled = !alertsEnabled;
    mapController.setAlertsEnabled(alertsEnabled);
    render();
  }
});
sidebarSlot.append(sidebar.el);

const legend = createLegend();
const timeline = createTimeline({
  onTime: (idx, mode) => {
    stopPlayback();
    timeMode = mode;
    timeIdx = idx;
    render();
  },
  onMode: (mode) => {
    stopPlayback();
    timeMode = mode;
    timeIdx = timeIdx == null ? null : 0;
    render();
  },
  onPlay: (playing) => {
    if (playing) startPlayback();
    else stopPlayback();
  },
  onSpeed: (speed) => {
    playbackDelay = speed;
    if (playTimer) startPlayback();
  }
});
const compareTray = createCompareTray(() => {
  pinnedIds = [];
  activeInspectorTab = "details";
  render();
});
const detail = createDetailPanel({
  onClose: () => {
    selectedId = null;
    render();
  },
  onPin: (id) => {
    pinnedIds = pinnedIds.filter((p) => p !== id);
    pinnedIds.push(id);
    while (pinnedIds.length > 3) pinnedIds.shift();
    activeInspectorTab = "compare";
    render();
  }
});
const rankCard = sidebar.el.querySelector(".rank-card");
legend.el.classList.remove("compact");
legend.el.classList.add("sidebar-legend");
if (rankCard) sidebar.el.insertBefore(legend.el, rankCard);
else sidebar.el.append(legend.el);
mapBottomControls.append(timeline.el);
detailsPane.append(detail.el);
comparePane.append(compareTray.el);

mapController = createMapController({
  container: mapEl,
  points,
  layer: activeLayer,
  timeIdx,
  timeMode,
  onSelect: selectRegion,
  onCursor(value) {
    cursorValue = value;
    legend.update(activeLayer, timeIdx, firstDates(), activeLayer.format(value), timeMode, firstHourlyTimes());
  }
});
mapController.map.on("zoomend moveend", () => maybeRefine());

const assistant = createAssistant({
  inline: false,
  async onAsk(message, conversationState) {
    const response = await fetchAssistantResponse(message, assistantContext(conversationState));
    executeAssistantActions(response.actions);
    return response;
  }
});
(app.querySelector(".map-area") as HTMLElement).append(assistant.el);

alertsPill.addEventListener("click", () => {
  alertsEnabled = !alertsEnabled;
  mapController.setAlertsEnabled(alertsEnabled);
  render();
});
sourceHealth.addEventListener("click", () => sourcePopover.classList.toggle("hidden"));
workspaceTabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    activeInspectorTab = button.dataset.tab === "compare" ? "compare" : "details";
    render();
  });
});

render();
void loadBase();
void loadAlerts();

function render(): void {
  const selected = selectedPoint();
  const trend = selected ? (trendCache.get(selected.sample.id) ?? { status: "idle", data: null }) : { status: "idle", data: null };
  sidebar.update({
    points,
    layers: LAYERS,
    activeLayer,
    timeIdx,
    timeMode,
    selectedId,
    alertStatus,
    alerts,
    alertsEnabled,
    baseStatus,
    baseError,
    forecastStatus,
    sourceBadge
  });
  mapController.setLayer(activeLayer, timeIdx, timeMode);
  mapController.setPoints(points);
  mapController.setSelected(selected);
  legend.update(activeLayer, timeIdx, firstDates(), activeLayer.format(cursorValue), timeMode, firstHourlyTimes());
  timeline.update(timeIdx, firstDates(), timeMode, firstHourlyTimes());
  detail.update(selected, selected ? pinnedIds.includes(selected.sample.id) : false, trend as TrendState, points, selected ? selectedAlertsForPoint(selected) : []);
  compareTray.update(pinnedIds.map((id) => points.find((p) => p.sample.id === id)).filter((p): p is PointData => !!p));
  assistant.update(assistantContextLabel(selected));
  renderInspectorWorkspace();
  updateHeader();
}

function renderInspectorWorkspace(): void {
  const selected = selectedPoint();
  const workspaceVisible = Boolean(selected) || pinnedIds.length > 0;
  appShell.classList.toggle("workspace-open", workspaceVisible);
  if (workspaceVisible !== workspaceWasVisible) {
    workspaceWasVisible = workspaceVisible;
    window.setTimeout(() => mapController.map.invalidateSize(), 80);
  }
  if (!workspaceVisible) activeInspectorTab = "details";
  compareCount.textContent = String(pinnedIds.length);
  workspaceTabs.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((button) => {
    const active = button.dataset.tab === activeInspectorTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  detailsPane.classList.toggle("active", activeInspectorTab === "details");
  comparePane.classList.toggle("active", activeInspectorTab === "compare");
}

function updateHeader(): void {
  layerPill.textContent = `${activeLayer.label} · ${activeLayer.subtitle ?? activeLayer.unit}`;
  statusPill.textContent = statusLabel();
  alertsPill.textContent =
    alertStatus === "loading"
      ? "Alerts loading"
      : alertStatus === "unavailable"
        ? "Alerts unavailable"
        : `${alertsEnabled ? "Alerts on" : "Alerts off"} · ${alerts.length}`;
  alertsPill.classList.toggle("off", !alertsEnabled);
  risksPill.textContent = topRiskSummary();
  updatedPill.textContent = baseStatus === "loading" ? "Fetching..." : `Updated ${formatTime()}`;
  sourcePopover.innerHTML = `
    <div><span>Forecast</span><b>${providerText(forecastStatus, sourceBadge)}</b></div>
    <div><span>Alerts</span><b>${providerText(alertStatus, "NOAA/NWS")}</b></div>
    <div><span>Mode</span><b>${timeMode === "hourly" ? "Hourly map" : "Daily map"}</b></div>
    <div><span>Data note</span><b>${sourceBadge === "DEMO DATA" ? "Demo fallback" : "Live provider path"}</b></div>
  `;
  sourceHealth.classList.toggle("demo", sourceBadge === "DEMO DATA");
}

function statusLabel(): string {
  if (baseStatus === "loading") return "Connecting";
  if (baseStatus === "unavailable") return "Degraded";
  return sourceBadge;
}

function topRiskSummary(): string {
  if (!points.length) return "Top risks loading";
  const top = points.filter(isNamedPoint).sort(byLayerDesc(activeLayer, timeIdx, timeMode)).slice(0, 2);
  if (!top.length) return "Top risks unavailable";
  return `Top risks: ${top.map((p) => `${p.sample.name} ${activeLayer.format(activeLayer.value(p, timeIdx, timeMode))}`).join(" · ")}`;
}

function assistantContext(conversationState: AssistantConversationState | null = null): AssistantContext {
  const center = mapController.map.getCenter();
  const bounds = mapController.map.getBounds();
  const visible = points
    .filter((p) => p.sample.kind === "region" && bounds.contains([p.sample.lat, p.sample.lon]))
    .slice(0, 18)
    .map((p) => ({
      id: p.sample.id,
      name: p.sample.name,
      state: p.sample.state,
      lat: p.sample.lat,
      lon: p.sample.lon,
      score: p.derived.score,
      layers: assistantLayers(p)
    }));
  const selected = selectedPoint();
  return {
    conversationState,
    activeLayer: { id: activeLayer.id, label: activeLayer.label },
    timeIdx,
    timeMode,
    sourceBadge,
    forecastStatus,
    alertStatus,
    selected: selected
      ? {
          id: selected.sample.id,
          name: selected.sample.name,
          state: selected.sample.state,
          lat: selected.sample.lat,
          lon: selected.sample.lon,
          domain: selected.sample.domain,
          score: selected.derived.score,
          riskLabel: selected.derived.riskLabel,
          layers: assistantLayers(selected)
        }
      : null,
    map: {
      center: { lat: center.lat, lon: center.lng },
      bounds: {
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest()
      },
      zoom: mapController.map.getZoom()
    },
    visiblePoints: visible,
    pinnedPoints: pinnedIds
      .map((id) => points.find((p) => p.sample.id === id))
      .filter((p): p is PointData => !!p)
      .map((p) => ({ id: p.sample.id, name: p.sample.name, state: p.sample.state, score: p.derived.score, layers: assistantLayers(p) })),
    alerts: alerts
      .filter((alert) => alertIntersectsBounds(alert, bounds))
      .slice(0, 8)
      .map((alert) => ({
        event: alert.event,
        severity: alert.severity,
        areaDesc: alert.areaDesc,
        effective: alert.effective,
        expires: alert.expires,
        bbox: geometryBox(alert.geometry) ?? undefined
      }))
  };
}

function assistantLayers(point: PointData): Partial<Record<LayerId, number | null>> {
  const entries = LAYERS.map((layer) => [layer.id, layer.value(point, timeIdx, timeMode)] as const);
  return Object.fromEntries(entries);
}

function alertIntersectsBounds(alert: AlertFeature, bounds: LatLngBounds): boolean {
  const box = geometryBox(alert.geometry);
  if (!box) return false;
  return box.west <= bounds.getEast() && box.east >= bounds.getWest() && box.south <= bounds.getNorth() && box.north >= bounds.getSouth();
}

function selectedAlertsForPoint(point: PointData): AlertFeature[] {
  return alerts.filter((alert) => {
    const box = geometryBox(alert.geometry);
    if (!box) return false;
    return point.sample.lon >= box.west && point.sample.lon <= box.east && point.sample.lat >= box.south && point.sample.lat <= box.north;
  });
}

function geometryBox(geometry: GeoJSON.Geometry | null | undefined): null | { north: number; south: number; east: number; west: number } {
  if (!geometry || geometry.type === "GeometryCollection") return null;
  const box = { north: -90, south: 90, east: -180, west: 180 };
  let seen = false;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") {
      const lon = value[0];
      const lat = value[1];
      box.north = Math.max(box.north, lat);
      box.south = Math.min(box.south, lat);
      box.east = Math.max(box.east, lon);
      box.west = Math.min(box.west, lon);
      seen = true;
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  return seen ? box : null;
}

function assistantContextLabel(selected: PointData | null): string {
  if (selected) return `Using ${selected.sample.name}, ${selected.sample.state} · ${sourceBadge}`;
  const center = mapController.map.getCenter();
  return `Using map center ${center.lat.toFixed(2)}, ${center.lng.toFixed(2)} · ${sourceBadge}`;
}

function executeAssistantActions(actions: AssistantAction[]): void {
  for (const action of actions.slice(0, 1)) {
    if (action.type !== "flyTo" || !Number.isFinite(action.lat) || !Number.isFinite(action.lon)) continue;
    const zoom = Math.max(5, Math.min(10, Number(action.zoom) || 8));
    mapController.map.flyTo([action.lat, action.lon], zoom, { duration: 0.7 });
    mapController.setAssistantLocation({ lat: action.lat, lon: action.lon, label: action.label });
    const nearest = nearestNamedPoint(action.lat, action.lon);
    if (nearest) {
      selectedId = nearest.sample.id;
      activeInspectorTab = "details";
      if (!trendCache.has(nearest.sample.id)) void loadTrend(nearest);
      render();
    }
  }
}

function nearestNamedPoint(lat: number, lon: number): PointData | null {
  let best: PointData | null = null;
  let bestD = Infinity;
  for (const point of points) {
    if (point.sample.kind !== "region") continue;
    const d = cosineDistance({ lat, lon }, point.sample);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best && bestD <= 2.5 ? best : null;
}

async function loadBase(): Promise<void> {
  const key = cacheHourKey(BASE_CACHE_KEY);
  const cached = safeGetSession<RawCache>(key);
  if (cached && forecastCacheHasCloud(cached.forecast)) {
    rawForecast = cached.forecast;
    forecastStatus = rawForecast ? "ready" : "unavailable";
    refreshPoints();
    baseStatus = "ready";
    render();
    return;
  }
  baseStatus = "loading";
  forecastStatus = "loading";
  render();
  void loadProvider("forecast", fetchForecast(BASE_SAMPLE_POINTS));
}

async function loadProvider(kind: "forecast", promise: Promise<unknown[]>): Promise<void> {
  try {
    const data = await promise;
    if (kind === "forecast") {
      rawForecast = data;
      forecastStatus = "ready";
    }
  } catch (error) {
    if (kind === "forecast") forecastStatus = "unavailable";
    baseError = error instanceof Error ? error.message : String(error);
  }
  refreshPoints();
  render();
}

function refreshPoints(): void {
  points = normalizeBaseData(BASE_SAMPLE_POINTS, rawForecast);
  sourceBadge = sourceSummary(rawForecast);
  if (rawForecast) {
    baseStatus = "ready";
    safeSetSession(cacheHourKey(BASE_CACHE_KEY), { forecast: rawForecast });
  } else if (forecastStatus === "unavailable") {
    baseStatus = "unavailable";
  }
  baseError = forecastStatus === "unavailable" ? "Forecast providers are unavailable." : null;
}

function forecastCacheHasCloud(forecast: unknown[] | null): boolean {
  if (!Array.isArray(forecast) || !forecast.length) return false;
  return forecast.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const daily = (raw as { daily?: { cloud_cover_mean?: unknown } }).daily;
    const values = Array.isArray(daily?.cloud_cover_mean) ? daily.cloud_cover_mean : [];
    return values.some((value) => typeof value === "number" && Number.isFinite(value));
  });
}

function sourceSummary(forecast: unknown[] | null): string {
  const providers = new Set(
    (forecast ?? []).map((raw) =>
      raw && typeof raw === "object" ? String(((raw as { source?: { provider?: unknown } }).source?.provider ?? "")) : ""
    )
  );
  if (providers.has("static-demo")) return "DEMO DATA";
  if (providers.has("open-meteo")) return "LIVE · OPEN-METEO";
  if (providers.has("nws") || providers.has("met.no")) return "LIVE · FALLBACK";
  return "LIVE";
}

function providerText(status: ProviderStatus, readyText = "READY"): string {
  if (status === "loading") return "LOADING";
  if (status === "unavailable") return "UNAVAILABLE";
  return readyText;
}

async function loadAlerts(): Promise<void> {
  const key = cacheHourKey("crd-alerts-v2");
  const cached = safeGetSession<AlertFeature[]>(key);
  if (cached) {
    alerts = cached;
    alertStatus = "ready";
    mapController.setAlerts(alerts, alertsEnabled);
    render();
    return;
  }
  alertStatus = "loading";
  render();
  try {
    alerts = await fetchAlerts();
    alertStatus = "ready";
    safeSetSession(key, alerts);
    mapController.setAlerts(alerts, alertsEnabled);
  } catch {
    alertStatus = "unavailable";
  }
  render();
}

function firstDates(): string[] {
  return points[0]?.forecast.dates ?? [];
}

function firstHourlyTimes(): string[] {
  return points[0]?.forecast.hourly.times ?? [];
}

function selectedPoint(): PointData | null {
  return selectedId ? (points.find((p) => p.sample.id === selectedId) ?? null) : null;
}

function selectRegion(id: string): void {
  selectedId = id;
  activeInspectorTab = "details";
  const p = selectedPoint();
  if (p) {
    const currentZoom = mapController.map.getZoom();
    const contextZoom = currentZoom < 5 ? 5 : Math.min(currentZoom, 6);
    mapController.map.flyTo([p.sample.lat, p.sample.lon], contextZoom, { duration: 0.6 });
    if (!trendCache.has(id)) void loadTrend(p);
  }
  render();
}

async function loadTrend(point: PointData): Promise<void> {
  const key = `crd-trends-v2-${point.sample.id}`;
  const cached = safeGetSession<TrendSeries>(key);
  if (cached) {
    trendCache.set(point.sample.id, { status: "ready", data: cached });
    render();
    return;
  }
  trendCache.set(point.sample.id, { status: "loading", data: null });
  render();
  try {
    const trend = await fetchHistoricalTrends({
      id: point.sample.id,
      name: point.sample.name ?? "",
      state: point.sample.state ?? "",
      lat: point.sample.lat,
      lon: point.sample.lon,
      domain: point.sample.domain
    });
    safeSetSession(key, trend);
    trendCache.set(point.sample.id, { status: "ready", data: trend });
  } catch {
    trendCache.set(point.sample.id, { status: "unavailable", data: null });
  }
  render();
}

function startPlayback(): void {
  stopPlayback();
  timeIdx = timeIdx ?? 0;
  playTimer = window.setInterval(() => {
    if (timeMode === "hourly") {
      const current = timeIdx == null ? -1 : PLAY_STEPS.indexOf(timeIdx);
      const next = PLAY_STEPS[(current + 1) % PLAY_STEPS.length];
      const maxHour = Math.max(0, Math.min(72, firstHourlyTimes().length - 1 || 72));
      timeIdx = Math.min(next, maxHour);
    } else {
      const maxDay = Math.max(1, Math.min(16, firstDates().length || 16));
      timeIdx = timeIdx == null ? 0 : (timeIdx + 1) % maxDay;
    }
    render();
  }, playbackDelay);
}

function stopPlayback(): void {
  if (playTimer) window.clearInterval(playTimer);
  playTimer = 0;
}

async function maybeRefine(): Promise<void> {
  if (!SETTINGS.enableRefinement || baseStatus !== "ready") return;
  if (mapController.map.getZoom() < 6) return;
  if (Date.now() < refinementBlockedUntil) return;
  const existing = points.map((p) => p.sample);
  if (existing.filter((p) => p.kind === "refinement").length >= SETTINGS.maxRefinementSamples) return;
  const bounds = mapController.map.getBounds();
  const candidates: SamplePoint[] = [];
  for (let y = 0; y < 6; y += 1) {
    for (let x = 0; x < 6; x += 1) {
      const lat = bounds.getSouth() + ((y + 0.5) / 6) * (bounds.getNorth() - bounds.getSouth());
      const lon = bounds.getWest() + ((x + 0.5) / 6) * (bounds.getEast() - bounds.getWest());
      const domain = classifyDomain(lat, lon);
      if (!domain) continue;
      if (existing.some((p) => p.domain === domain && cosineDistance({ lat, lon }, p) < 0.25)) continue;
      const key = candidateKey(domain, lat, lon);
      if (refinementAttempted.has(key)) continue;
      refinementAttempted.add(key);
      candidates.push({ id: `refine-${key}`, kind: "refinement", lat, lon, domain });
    }
  }
  if (!candidates.length) return;
  const batch = candidates.slice(0, 36);
  try {
    const forecast = await fetchForecast(batch);
    points = [...points, ...normalizeBaseData(batch, forecast)].slice(0, BASE_SAMPLE_POINTS.length + SETTINGS.maxRefinementSamples);
    render();
  } catch {
    batch.forEach((p) => refinementAttempted.delete(candidateKey(p.domain, p.lat, p.lon)));
    refinementBlockedUntil = Date.now() + 60000;
  }
}
