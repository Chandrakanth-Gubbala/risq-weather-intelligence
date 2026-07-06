import type { LayerId } from "../types";

const icons = {
  activity:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l2-6 4 12 2-6h6"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  cloud:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 18H8a5 5 0 1 1 1.1-9.9A6 6 0 0 1 20 11.7 3.3 3.3 0 0 1 17.5 18Z"/></svg>',
  compass:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z"/></svg>',
  droplet:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.7 6 11a6 6 0 0 1-12 0c0-4.3 6-11 6-11Z"/></svg>',
  flame:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a7 7 0 0 0 7-7c0-3.5-2.2-5.7-4.4-7.7-.7 2.7-2.3 3.7-4.2 5C8.8 13.5 8 15 8 17a4 4 0 0 0 4 5Z"/></svg>',
  gauge:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14a8 8 0 0 1 16 0"/><path d="M12 14l4-4"/><path d="M6.5 18h11"/></svg>',
  info:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>',
  mapPin:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s7-5.2 7-12a7 7 0 0 0-14 0c0 6.8 7 12 7 12Z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  moon:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A8 8 0 0 1 9.5 3 8.7 8.7 0 1 0 21 14.5Z"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5-4 1-4 8-2-2 8-4 1-4Z"/><path d="m4 20 6-6"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="M4 12h2m12 0h2M12 4v2m0 12v2m-5.7-2.3 1.4-1.4m8.6-8.6 1.4-1.4m0 11.4-1.4-1.4M7.7 7.7 6.3 6.3"/></svg>',
  sun:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  thermometer:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/></svg>',
  wind:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>',
  zap:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-9 12h7l-1 8 9-12h-7l1-8Z"/></svg>'
} as const;

export type IconName = keyof typeof icons;

export function icon(name: IconName, className = "ui-icon"): string {
  return `<span class="${className}">${icons[name]}</span>`;
}

export function layerIcon(id: LayerId): string {
  const map: Record<LayerId, IconName> = {
    risk: "gauge",
    heat: "sun",
    temp: "thermometer",
    fire: "flame",
    wind: "wind",
    humidity: "droplet",
    cloud: "cloud",
    cdd: "zap"
  };
  return icon(map[id], "layer-icon");
}

export function alertIconFor(event: string): string {
  const lower = event.toLowerCase();
  if (lower.includes("fire")) return icon("flame", "alert-icon");
  if (lower.includes("wind") || lower.includes("marine")) return icon("wind", "alert-icon");
  if (lower.includes("heat")) return icon("sun", "alert-icon");
  return icon("alert", "alert-icon");
}
