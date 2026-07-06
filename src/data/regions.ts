import type { Domain, Region, SamplePoint } from "../types";

const regionRows = [
  ["Seattle", "WA", 47.61, -122.33],
  ["Portland", "OR", 45.52, -122.68],
  ["Spokane", "WA", 47.66, -117.43],
  ["Boise", "ID", 43.62, -116.21],
  ["Sacramento", "CA", 38.58, -121.49],
  ["San Francisco", "CA", 37.77, -122.42],
  ["Fresno", "CA", 36.74, -119.79],
  ["Los Angeles", "CA", 34.05, -118.24],
  ["San Diego", "CA", 32.72, -117.16],
  ["Las Vegas", "NV", 36.17, -115.14],
  ["Reno", "NV", 39.53, -119.81],
  ["Phoenix", "AZ", 33.45, -112.07],
  ["Tucson", "AZ", 32.22, -110.97],
  ["Albuquerque", "NM", 35.08, -106.65],
  ["Salt Lake City", "UT", 40.76, -111.89],
  ["Denver", "CO", 39.74, -104.99],
  ["Billings", "MT", 45.78, -108.5],
  ["Fargo", "ND", 46.88, -96.79],
  ["Minneapolis", "MN", 44.98, -93.27],
  ["Omaha", "NE", 41.26, -95.94],
  ["Kansas City", "MO", 39.1, -94.58],
  ["Wichita", "KS", 37.69, -97.34],
  ["Oklahoma City", "OK", 35.47, -97.52],
  ["Dallas", "TX", 32.78, -96.8],
  ["Houston", "TX", 29.76, -95.37],
  ["San Antonio", "TX", 29.42, -98.49],
  ["Austin", "TX", 30.27, -97.74],
  ["El Paso", "TX", 31.76, -106.49],
  ["New Orleans", "LA", 29.95, -90.07],
  ["Memphis", "TN", 35.15, -90.05],
  ["St. Louis", "MO", 38.63, -90.2],
  ["Chicago", "IL", 41.88, -87.63],
  ["Milwaukee", "WI", 43.04, -87.91],
  ["Detroit", "MI", 42.33, -83.05],
  ["Indianapolis", "IN", 39.77, -86.16],
  ["Louisville", "KY", 38.25, -85.76],
  ["Nashville", "TN", 36.16, -86.78],
  ["Atlanta", "GA", 33.75, -84.39],
  ["Birmingham", "AL", 33.52, -86.8],
  ["Jackson", "MS", 32.3, -90.18],
  ["Miami", "FL", 25.76, -80.19],
  ["Tampa", "FL", 27.95, -82.46],
  ["Orlando", "FL", 28.54, -81.38],
  ["Jacksonville", "FL", 30.33, -81.66],
  ["Charlotte", "NC", 35.23, -80.84],
  ["Raleigh", "NC", 35.78, -78.64],
  ["Charleston", "SC", 32.78, -79.93],
  ["Richmond", "VA", 37.54, -77.44],
  ["Washington", "DC", 38.9, -77.04],
  ["Philadelphia", "PA", 39.95, -75.17],
  ["New York", "NY", 40.71, -74.01],
  ["Boston", "MA", 42.36, -71.06],
  ["Portland", "ME", 43.66, -70.26],
  ["Buffalo", "NY", 42.89, -78.88],
  ["Pittsburgh", "PA", 40.44, -79.99],
  ["Cleveland", "OH", 41.5, -81.69],
  ["Columbus", "OH", 39.96, -83.0],
  ["Anchorage", "AK", 61.22, -149.9],
  ["Honolulu", "HI", 21.31, -157.86]
] as const;

const fillRows = [
  [44.0, -120.5],
  [42.5, -118.5],
  [41.0, -120.0],
  [35.0, -116.0],
  [40.5, -116.5],
  [38.5, -117.0],
  [48.5, -116.0],
  [45.0, -112.5],
  [47.5, -109.0],
  [43.0, -107.5],
  [41.5, -109.5],
  [39.0, -110.5],
  [37.0, -111.5],
  [33.0, -108.0],
  [31.5, -102.5],
  [34.5, -101.0],
  [30.5, -100.0],
  [27.5, -98.5],
  [38.5, -100.5],
  [41.5, -101.5],
  [44.5, -101.0],
  [47.0, -102.5],
  [47.5, -94.5],
  [45.5, -89.5],
  [46.5, -85.5],
  [46.5, -68.5],
  [44.2, -72.5],
  [42.0, -77.5],
  [38.5, -80.5],
  [35.0, -92.5],
  [31.5, -83.5],
  [31.0, -87.0],
  [36.5, -105.0]
] as const;

function idFor(name: string, state: string): string {
  return `${name}-${state}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function domainFor(state: string): Domain {
  if (state === "AK") return "ak";
  if (state === "HI") return "hi";
  return "conus";
}

export const REGIONS: Region[] = regionRows.map(([name, state, lat, lon]) => ({
  id: idFor(name, state),
  name,
  state,
  lat,
  lon,
  domain: domainFor(state)
}));

export const REGION_SAMPLE_POINTS: SamplePoint[] = REGIONS.map((r) => ({
  ...r,
  kind: "region"
}));

export const FILL_SAMPLE_POINTS: SamplePoint[] = fillRows.map(([lat, lon], i) => ({
  id: `fill-conus-${i + 1}`,
  kind: "fill",
  lat,
  lon,
  domain: "conus"
}));

export const BASE_SAMPLE_POINTS: SamplePoint[] = [...REGION_SAMPLE_POINTS, ...FILL_SAMPLE_POINTS];

export function regionFromPointId(id: string): Region | undefined {
  return REGIONS.find((r) => r.id === id);
}
