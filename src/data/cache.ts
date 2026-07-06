import { safeJsonParse } from "../utils";

const memory = new Map<string, string>();

export function cacheHourKey(prefix: string, date = new Date()): string {
  return `${prefix}-${date.toISOString().slice(0, 13)}`;
}

export function safeGetSession<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return safeJsonParse<T>(raw);
  } catch {
    return safeJsonParse<T>(memory.get(key) ?? null);
  }
}

export function safeSetSession(key: string, value: unknown): void {
  const raw = JSON.stringify(value);
  try {
    sessionStorage.setItem(key, raw);
  } catch {
    memory.set(key, raw);
  }
}
