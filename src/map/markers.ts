import L from "leaflet";
import type { ForecastTimeMode, LayerDefinition, PointData } from "../types";
import { rampColor, SETTINGS, valueToT } from "../utils";

export function createStationLayer(
  points: PointData[],
  layer: LayerDefinition,
  timeIdx: number | null,
  timeMode: ForecastTimeMode,
  onSelect: (id: string) => void
): L.LayerGroup {
  const group = L.layerGroup();
  if (!SETTINGS.showStations) return group;
  points
    .filter((p) => p.sample.kind === "region")
    .forEach((p) => {
      const value = layer.value(p, timeIdx, timeMode);
      const t = valueToT(layer, value);
      const marker = L.circleMarker([p.sample.lat, p.sample.lon], {
        radius: (4 + 3 * t) * SETTINGS.markerScale,
        color: "#0a0d13",
        weight: 1,
        fillColor: rampColor(t),
        fillOpacity: 0.88
      });
      marker.bindTooltip(`${p.sample.name}, ${p.sample.state}<br>${layer.format(value)}`, {
        className: "crd-tip",
        sticky: true
      });
      marker.on("click", () => onSelect(p.sample.id));
      group.addLayer(marker);
    });
  return group;
}

export function createSelectionLayer(): L.LayerGroup {
  return L.layerGroup();
}

export function createAssistantLocationLayer(): L.LayerGroup {
  return L.layerGroup();
}

export function updateAssistantLocationLayer(
  group: L.LayerGroup,
  location: { lat: number; lon: number; label: string } | null
): void {
  group.clearLayers();
  if (!location) return;
  L.circleMarker([location.lat, location.lon], {
    radius: 12,
    color: "#fbbf77",
    weight: 2,
    fillColor: "#f97316",
    fillOpacity: 0.24,
    interactive: false
  }).addTo(group);
  L.circleMarker([location.lat, location.lon], {
    radius: 3,
    color: "#fbbf77",
    weight: 0,
    fillColor: "#fbbf77",
    fillOpacity: 1,
    interactive: false
  })
    .bindTooltip(location.label, { className: "crd-tip", permanent: false })
    .addTo(group);
}

export function updateSelectionLayer(group: L.LayerGroup, point: PointData | null): void {
  group.clearLayers();
  if (!point) return;
  L.circleMarker([point.sample.lat, point.sample.lon], {
    radius: 9,
    color: "#ffffff",
    weight: 2,
    fillOpacity: 0,
    interactive: false
  }).addTo(group);
  L.circleMarker([point.sample.lat, point.sample.lon], {
    radius: 2.5,
    color: "#ffffff",
    weight: 0,
    fillColor: "#ffffff",
    fillOpacity: 1,
    interactive: false
  }).addTo(group);
  L.marker([point.sample.lat, point.sample.lon], {
    interactive: false,
    icon: L.divIcon({
      className: "selection-chip",
      html: `${point.sample.name ?? "Selected"}, ${point.sample.state ?? ""}`,
      iconAnchor: [-12, 38]
    })
  }).addTo(group);
}
