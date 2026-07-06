import type { Domain, ForecastTimeMode, LayerDefinition, PointData } from "../types";
import { clamp01 } from "../utils";

export type InterpolationSample = {
  lat: number;
  lon: number;
  domain: Domain;
  value: number;
};

export function classifyDomain(lat: number, lon: number): Domain | null {
  if (lat >= 18 && lat <= 23.5 && lon >= -161.5 && lon <= -154) return "hi";
  if (lat >= 51 && lat <= 72 && lon >= -170 && lon <= -129) return "ak";
  if (lat >= 24 && lat <= 50.5 && lon >= -125.5 && lon <= -66) return "conus";
  return null;
}

export function buildSamples(points: PointData[], layer: LayerDefinition, timeIdx: number | null, timeMode: ForecastTimeMode = "daily"): InterpolationSample[] {
  return points
    .map((p) => {
      const value = layer.value(p, timeIdx, timeMode);
      return value == null || !Number.isFinite(value)
        ? null
        : { lat: p.sample.lat, lon: p.sample.lon, domain: p.sample.domain, value };
    })
    .filter((p): p is InterpolationSample => p != null);
}

export function idwAt(
  samples: InterpolationSample[],
  domain: Domain,
  lat: number,
  lon: number
): { value: number | null; alpha: number; nearestDeg: number } {
  let weighted = 0;
  let weights = 0;
  let minD2 = Infinity;
  const cosLat = Math.cos((lat * Math.PI) / 180);

  for (const sample of samples) {
    if (sample.domain !== domain) continue;
    const dLat = sample.lat - lat;
    const dLon = (sample.lon - lon) * cosLat;
    const d2 = dLat * dLat + dLon * dLon;
    if (d2 < minD2) minD2 = d2;
    if (d2 < 1e-6) return { value: sample.value, alpha: 1, nearestDeg: 0 };
    const weight = 1 / (d2 * d2);
    weighted += weight * sample.value;
    weights += weight;
  }

  if (weights === 0 || minD2 === Infinity) return { value: null, alpha: 0, nearestDeg: Infinity };
  const dmin = Math.sqrt(minD2);
  const alpha = dmin < 2.6 ? 1 : dmin > 4.6 ? 0 : clamp01((4.6 - dmin) / 2);
  return { value: weighted / weights, alpha, nearestDeg: dmin };
}

export function candidateKey(domain: Domain, lat: number, lon: number): string {
  return `${domain}:${(Math.round(lat * 5) / 5).toFixed(1)}:${(Math.round(lon * 5) / 5).toFixed(1)}`;
}

export function cosineDistance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dLat = a.lat - b.lat;
  const dLon = (a.lon - b.lon) * cosLat;
  return Math.sqrt(dLat * dLat + dLon * dLon);
}
