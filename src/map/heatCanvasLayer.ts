import L from "leaflet";
import type { ForecastTimeMode, LayerDefinition, PointData } from "../types";
import { rampColor, SETTINGS, valueToT } from "../utils";
import { buildSamples, classifyDomain, idwAt } from "./interpolation";

type HeatOptions = {
  points: PointData[];
  layer: LayerDefinition;
  timeIdx: number | null;
  timeMode: ForecastTimeMode;
  opacity?: number;
  onCursor?: (value: number | null) => void;
};

export class HeatCanvasLayer extends L.Layer {
  private canvas: HTMLCanvasElement;
  private coarse: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private coarseCtx: CanvasRenderingContext2D;
  private mapRef: L.Map | null = null;
  private frame = 0;
  private optionsData: HeatOptions;

  constructor(options: HeatOptions) {
    super();
    this.optionsData = options;
    this.canvas = L.DomUtil.create("canvas", "crd-heat-canvas") as HTMLCanvasElement;
    this.coarse = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    const coarseCtx = this.coarse.getContext("2d");
    if (!ctx || !coarseCtx) throw new Error("Canvas not available");
    this.ctx = ctx;
    this.coarseCtx = coarseCtx;
  }

  onAdd(map: L.Map): this {
    this.mapRef = map;
    const pane = map.getPane("overlayPane") ?? map.getPanes().overlayPane;
    pane.appendChild(this.canvas);
    map.on("moveend resize zoomend", this.redraw, this);
    map.on("mousemove", this.handleMouseMove, this);
    this.redraw();
    return this;
  }

  onRemove(map: L.Map): this {
    L.DomUtil.remove(this.canvas);
    map.off("moveend resize zoomend", this.redraw, this);
    map.off("mousemove", this.handleMouseMove, this);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.mapRef = null;
    return this;
  }

  setData(options: Partial<HeatOptions>): void {
    this.optionsData = { ...this.optionsData, ...options };
    this.redraw();
  }

  redraw(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw(): void {
    const map = this.mapRef;
    if (!map) return;
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(size.x * dpr));
    this.canvas.height = Math.max(1, Math.round(size.y * dpr));
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.style.opacity = String(this.optionsData.opacity ?? SETTINGS.heatOpacity);

    const cellPx = SETTINGS.heatCellPx;
    const gridW = Math.max(1, Math.ceil(size.x / cellPx));
    const gridH = Math.max(1, Math.ceil(size.y / cellPx));
    this.coarse.width = gridW;
    this.coarse.height = gridH;
    const image = this.coarseCtx.createImageData(gridW, gridH);
    const samples = buildSamples(this.optionsData.points, this.optionsData.layer, this.optionsData.timeIdx, this.optionsData.timeMode);

    for (let y = 0; y < gridH; y += 1) {
      for (let x = 0; x < gridW; x += 1) {
        const point = L.point(x * cellPx + cellPx / 2, y * cellPx + cellPx / 2);
        const ll = map.containerPointToLatLng(point);
        const domain = classifyDomain(ll.lat, ll.lng);
        const idx = (y * gridW + x) * 4;
        if (!domain) {
          image.data[idx + 3] = 0;
          continue;
        }
        const result = idwAt(samples, domain, ll.lat, ll.lng);
        if (result.value == null || result.alpha <= 0) {
          image.data[idx + 3] = 0;
          continue;
        }
        const color = parseRgb(rampColor(valueToT(this.optionsData.layer, result.value)));
        image.data[idx] = color[0];
        image.data[idx + 1] = color[1];
        image.data[idx + 2] = color[2];
        image.data[idx + 3] = Math.round(225 * result.alpha);
      }
    }

    this.coarseCtx.putImageData(image, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.drawImage(this.coarse, 0, 0, this.canvas.width, this.canvas.height);
  }

  private handleMouseMove(event: L.LeafletMouseEvent): void {
    if (!this.optionsData.onCursor) return;
    const samples = buildSamples(this.optionsData.points, this.optionsData.layer, this.optionsData.timeIdx, this.optionsData.timeMode);
    const domain = classifyDomain(event.latlng.lat, event.latlng.lng);
    if (!domain) {
      this.optionsData.onCursor(null);
      return;
    }
    const result = idwAt(samples, domain, event.latlng.lat, event.latlng.lng);
    this.optionsData.onCursor(result.nearestDeg > 4.6 ? null : result.value);
  }
}

function parseRgb(rgb: string): [number, number, number] {
  const nums = rgb.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}
