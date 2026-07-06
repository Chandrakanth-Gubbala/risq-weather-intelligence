import type { AlertFeature, AssistantContext, AssistantResponse, Region, SamplePoint, TrendSeries } from "../types";
import { normalizeTrend } from "./normalize";

type ProxyResponse<T> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
};

class ProxyError extends Error {
  retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function proxyJson<T>(path: string, body?: unknown, opts: FetchOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 18_000;
  const retries = opts.retries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(path, {
        method: body == null ? "GET" : "POST",
        headers: body == null ? undefined : { "Content-Type": "application/json" },
        body: body == null ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const payload = (await res.json().catch(() => null)) as ProxyResponse<T> | null;
      if (!res.ok) throw new ProxyError(payload?.error ?? `HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      if (!payload?.ok) throw new ProxyError(payload?.error ?? "Proxy request failed", true);
      return payload.data as T;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ProxyError ? error.retryable : true;
      if (!retryable || attempt === retries) break;
      await sleep(700 * 2 ** attempt);
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Proxy request failed");
}

export async function fetchForecast(points: SamplePoint[]): Promise<unknown[]> {
  return proxyJson<unknown[]>("/api/forecast", { points }, { timeoutMs: 120_000, retries: 1 });
}

export async function fetchAlerts(): Promise<AlertFeature[]> {
  return proxyJson<AlertFeature[]>("/api/alerts");
}

export async function fetchHistoricalTrends(region: Region): Promise<TrendSeries> {
  const raw = await proxyJson<unknown>("/api/trends", { region }, { timeoutMs: 24_000, retries: 1 });
  return normalizeTrend(raw);
}

export async function fetchAssistantResponse(message: string, context: AssistantContext): Promise<AssistantResponse> {
  return proxyJson<AssistantResponse>("/api/chat", { message, context }, { timeoutMs: 45_000, retries: 0 });
}
