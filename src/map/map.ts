import L from "leaflet";
import type { AlertFeature, ForecastTimeMode, LayerDefinition, PointData } from "../types";
import { STATE_LABELS } from "../data/stateLabels";
import { SETTINGS } from "../utils";
import { createAlertsLayer, updateAlertZoomStyle } from "./alertsLayer";
import { HeatCanvasLayer } from "./heatCanvasLayer";
import { cosineDistance } from "./interpolation";
import { createAssistantLocationLayer, createSelectionLayer, createStationLayer, updateAssistantLocationLayer, updateSelectionLayer } from "./markers";

export type MapController = {
  map: L.Map;
  heat: HeatCanvasLayer;
  setLayer: (layer: LayerDefinition, timeIdx: number | null, timeMode: ForecastTimeMode) => void;
  setPoints: (points: PointData[]) => void;
  setSelected: (point: PointData | null) => void;
  setAssistantLocation: (location: { lat: number; lon: number; label: string } | null) => void;
  setAlerts: (alerts: AlertFeature[], enabled: boolean) => void;
  setAlertsEnabled: (enabled: boolean) => void;
};

export function createMapController(args: {
  container: HTMLElement;
  points: PointData[];
  layer: LayerDefinition;
  timeIdx: number | null;
  timeMode: ForecastTimeMode;
  onSelect: (id: string) => void;
  onCursor: (value: number | null) => void;
}): MapController {
  const map = L.map(args.container, {
    zoomControl: false,
    preferCanvas: true,
    worldCopyJump: false
  }).setView([39.5, -98.35], 4);

  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap © CARTO",
    maxZoom: 18
  }).addTo(map);

  const heat = new HeatCanvasLayer({
    points: args.points,
    layer: args.layer,
    timeIdx: args.timeIdx,
    timeMode: args.timeMode,
    opacity: SETTINGS.heatOpacity,
    onCursor: args.onCursor
  }).addTo(map);

  let points = args.points;
  let activeLayer = args.layer;
  let activeTimeIdx = args.timeIdx;
  let activeTimeMode = args.timeMode;
  let stations = createStationLayer(points, activeLayer, activeTimeIdx, activeTimeMode, args.onSelect).addTo(map);
  const selection = createSelectionLayer().addTo(map);
  const assistantLocation = createAssistantLocationLayer().addTo(map);
  const labels = createStateLabelLayer(map).addTo(map);
  let alertsLayer: L.GeoJSON | null = null;
  let alertEnabled = SETTINGS.showAlerts;

  map.on("click", (event: L.LeafletMouseEvent) => {
    const best = nearestNamedPoint(points, event.latlng.lat, event.latlng.lng, 6);
    if (best) args.onSelect(best.sample.id);
  });
  map.on("zoomend", () => {
    if (alertsLayer) updateAlertZoomStyle(alertsLayer, map.getZoom());
    refreshStateLabels(labels, map);
  });
  addLocateControl(map, (lat, lon) => {
    const best = nearestNamedPoint(points, lat, lon, 6);
    if (best) args.onSelect(best.sample.id);
  });

  function refreshStations(): void {
    map.removeLayer(stations);
    stations = createStationLayer(points, activeLayer, activeTimeIdx, activeTimeMode, args.onSelect).addTo(map);
  }

  return {
    map,
    heat,
    setLayer(layer, timeIdx, timeMode) {
      activeLayer = layer;
      activeTimeIdx = timeIdx;
      activeTimeMode = timeMode;
      heat.setData({ layer, timeIdx, timeMode });
      refreshStations();
    },
    setPoints(next) {
      points = next;
      heat.setData({ points });
      refreshStations();
    },
    setSelected(point) {
      updateSelectionLayer(selection, point);
    },
    setAssistantLocation(location) {
      updateAssistantLocationLayer(assistantLocation, location);
    },
    setAlerts(alerts, enabled) {
      if (alertsLayer) {
        map.removeLayer(alertsLayer);
        alertsLayer = null;
      }
      alertEnabled = enabled;
      if (enabled && alerts.length) {
        alertsLayer = createAlertsLayer(alerts);
        alertsLayer.addTo(map);
        updateAlertZoomStyle(alertsLayer, map.getZoom());
      }
    },
    setAlertsEnabled(enabled) {
      alertEnabled = enabled;
      if (alertsLayer) {
        if (enabled && !map.hasLayer(alertsLayer)) alertsLayer.addTo(map);
        if (!enabled && map.hasLayer(alertsLayer)) map.removeLayer(alertsLayer);
      }
    }
  };
}

function nearestNamedPoint(points: PointData[], lat: number, lon: number, maxDistance: number): PointData | null {
  const named = points.filter((p) => p.sample.kind === "region");
  let best: PointData | null = null;
  let bestD = Infinity;
  for (const point of named) {
    const d = cosineDistance({ lat, lon }, point.sample);
    if (d < bestD) {
      bestD = d;
      best = point;
    }
  }
  return best && bestD <= maxDistance ? best : null;
}

function createStateLabelLayer(map: L.Map): L.LayerGroup {
  const group = L.layerGroup();
  refreshStateLabels(group, map);
  return group;
}

function refreshStateLabels(group: L.LayerGroup, map: L.Map): void {
  group.clearLayers();
  const zoom = map.getZoom();
  STATE_LABELS.filter((item) => zoom >= (item.minZoom ?? 4)).forEach((item) => {
    L.marker([item.lat, item.lon], {
      interactive: false,
      icon: L.divIcon({
        className: "state-label",
        html: item.label,
        iconSize: [34, 16],
        iconAnchor: [17, 8]
      })
    }).addTo(group);
  });
}

function addLocateControl(map: L.Map, onLocated: (lat: number, lon: number) => void): void {
  const Locate = L.Control.extend({
    options: { position: "bottomleft" },
    onAdd() {
      const button = L.DomUtil.create("button", "leaflet-control locate-control");
      button.type = "button";
      button.title = "Locate me";
      button.setAttribute("aria-label", "Locate me");
      button.textContent = "LOC";
      L.DomEvent.disableClickPropagation(button);
      L.DomEvent.on(button, "click", () => {
        map.locate({ setView: true, maxZoom: 7, enableHighAccuracy: false });
      });
      return button;
    }
  });
  map.addControl(new Locate());
  map.on("locationfound", (event: L.LocationEvent) => onLocated(event.latlng.lat, event.latlng.lng));
}
