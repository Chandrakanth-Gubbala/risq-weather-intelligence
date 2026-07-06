import type { ForecastTimeMode } from "../types";
import { forecastLabel } from "../utils";
import { icon } from "./icons";

export type TimelineController = {
  el: HTMLElement;
  update: (timeIdx: number | null, dates: string[], timeMode: ForecastTimeMode, hourlyTimes: string[]) => void;
};

export function createTimeline(args: {
  onTime: (idx: number | null, mode: ForecastTimeMode) => void;
  onMode: (mode: ForecastTimeMode) => void;
  onPlay: (playing: boolean) => void;
  onSpeed?: (speed: number) => void;
}): TimelineController {
  const root = document.createElement("div");
  root.className = "timeline";
  root.innerHTML = `
    <div class="timeline-head">
      <span>${icon("activity")} Forecast Timeline</span>
      <button type="button" class="play" aria-label="Play forecast">Play</button>
    </div>
    <div class="timeline-mode" role="group" aria-label="Forecast time mode">
      <button type="button" data-mode="hourly">Hourly</button>
      <button type="button" data-mode="daily">16-day</button>
    </div>
    <div class="timeline-scrubber">
      <input type="range" min="0" max="16" value="0" aria-label="Forecast timeline scrubber" />
      <div class="timeline-scale" aria-hidden="true"><span></span><b></b><span></span></div>
    </div>
    <div class="speed-steps" role="group" aria-label="Playback speed">
      <button type="button" data-speed="1200" class="active">1x</button>
      <button type="button" data-speed="650">2x</button>
      <button type="button" data-speed="360">4x</button>
    </div>
    <b class="timeline-label"></b>
  `;
  const play = root.querySelector(".play") as HTMLButtonElement;
  const range = root.querySelector(".timeline-scrubber input") as HTMLInputElement;
  const scale = root.querySelector(".timeline-scale") as HTMLElement;
  const label = root.querySelector(".timeline-label") as HTMLElement;
  const hourlySteps: (number | null)[] = [null, 6, 12, 24, 48, 72];
  const dailySteps: (number | null)[] = [null, ...Array.from({ length: 16 }, (_, i) => i)];
  let playing = false;
  let lastIdx: number | null = null;
  let mode: ForecastTimeMode = "daily";

  root.querySelectorAll<HTMLButtonElement>(".timeline-mode button").forEach((btn) => {
    btn.addEventListener("click", () => {
      playing = false;
      play.textContent = "Play";
      mode = btn.dataset.mode === "hourly" ? "hourly" : "daily";
      args.onMode(mode);
    });
  });

  function activeSteps(): (number | null)[] {
    return mode === "hourly" ? hourlySteps : dailySteps;
  }

  function renderTicks(dates: string[], hourlyTimes: string[]): void {
    const steps = activeSteps();
    const selectedPosition = Math.max(0, steps.findIndex((step) => step === lastIdx));
    range.max = String(Math.max(0, steps.length - 1));
    range.setAttribute("aria-valuetext", forecastLabel(dates, lastIdx, mode, hourlyTimes));
    range.style.setProperty("--progress", `${progressPct(steps, lastIdx)}%`);
    scale.style.setProperty("--progress", `${progressPct(steps, lastIdx)}%`);
    scale.classList.toggle("current-at-start", selectedPosition === 0);
    scale.classList.toggle("current-at-end", selectedPosition === steps.length - 1);
    const start = scale.children[0] as HTMLElement;
    const current = scale.children[1] as HTMLElement;
    const end = scale.children[2] as HTMLElement;
    start.textContent = stepLabel(steps[0] ?? null, mode, dates, hourlyTimes);
    current.textContent = stepLabel(lastIdx, mode, dates, hourlyTimes);
    end.textContent = stepLabel(steps[steps.length - 1] ?? null, mode, dates, hourlyTimes);
  }

  function selectedPosition(): number {
    const steps = activeSteps();
    const index = steps.findIndex((idx) => idx === lastIdx);
    return Math.max(0, index);
  }

  function selectedStepFromRange(): number | null {
    return activeSteps()[Number(range.value)] ?? null;
  }

  function progressPct(steps: (number | null)[], idx: number | null): number {
    const index = steps.findIndex((step) => step === idx);
    return steps.length <= 1 || index < 0 ? 0 : (index / (steps.length - 1)) * 100;
  }

  function renderSteps(dates: string[], hourlyTimes: string[]): void {
    renderTicks(dates, hourlyTimes);
    range.value = String(selectedPosition());
  }

  play.addEventListener("click", () => {
    playing = !playing;
    play.textContent = playing ? "Pause" : "Play";
    args.onPlay(playing);
  });
  root.querySelectorAll<HTMLButtonElement>(".speed-steps button").forEach((btn) => {
    btn.addEventListener("click", () => {
      root.querySelectorAll<HTMLButtonElement>(".speed-steps button").forEach((item) => item.classList.toggle("active", item === btn));
      args.onSpeed?.(Number(btn.dataset.speed) || 1200);
    });
  });
  range.addEventListener("input", () => {
    playing = false;
    play.textContent = "Play";
    args.onTime(selectedStepFromRange(), mode);
  });
  return {
    el: root,
    update(timeIdx, dates, timeMode, hourlyTimes) {
      mode = timeMode;
      lastIdx = timeIdx;
      renderSteps(dates, hourlyTimes);
      root.querySelectorAll<HTMLButtonElement>(".timeline-mode button").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === timeMode);
      });
      label.textContent = forecastLabel(dates, timeIdx, timeMode, hourlyTimes);
      const numericSteps: readonly number[] = timeMode === "hourly" ? [6, 12, 24, 48, 72] : Array.from({ length: 16 }, (_, i) => i);
      if (lastIdx != null && !numericSteps.includes(lastIdx)) {
        label.textContent += " · CUSTOM HOUR";
      }
    }
  };
}

function stepLabel(idx: number | null, mode: ForecastTimeMode, dates: string[], hourlyTimes: string[]): string {
  if (idx == null) return "Now";
  if (mode === "hourly") return `+${idx}h`;
  const date = dates[idx] ? new Date(`${dates[idx]}T12:00:00`) : new Date(Date.now() + idx * 86400000);
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
