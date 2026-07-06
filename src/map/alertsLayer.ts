import L from "leaflet";
import type { AlertFeature } from "../types";

export function createAlertsLayer(alerts: AlertFeature[]): L.GeoJSON {
  const collection: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: alerts.slice(0, 300).map((a) => ({
      type: "Feature",
      id: a.id,
      geometry: a.geometry,
      properties: a
    }))
  };
  return L.geoJSON(collection, {
    style: (feature) => {
      const severity = feature?.properties?.severity;
      return {
        color: severity === "Extreme" ? "#dc2626" : "#f97316",
        weight: 2.2,
        fillColor: severity === "Extreme" ? "#dc2626" : "#f97316",
        fillOpacity: 0.18
      };
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties as AlertFeature;
      const area = p.areaDesc.length > 90 ? `${p.areaDesc.slice(0, 90)}...` : p.areaDesc;
      layer.bindTooltip(`<b>${escapeHtml(p.event)}</b><br>${escapeHtml(area)}`, {
        className: "crd-tip",
        sticky: true
      });
    }
  });
}

export function updateAlertZoomStyle(layer: L.GeoJSON, zoom: number): void {
  const style =
    zoom < 6
      ? { weight: 1.5, fillOpacity: 0.2 }
      : zoom < 8
        ? { weight: 2.2, fillOpacity: 0.18 }
        : { weight: 2.8, fillOpacity: 0.14 };
  layer.setStyle(style);
}

export function alertTicker(alerts: AlertFeature[]): string {
  if (!alerts.length) return "";
  const counts = new Map<string, number>();
  alerts.forEach((a) => counts.set(a.event, (counts.get(a.event) ?? 0) + 1));
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([event, count]) => `${event} (${count})`)
    .join(" · ");
  return `${alerts.length} severe alerts${top ? ` · ${top}` : ""}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}
