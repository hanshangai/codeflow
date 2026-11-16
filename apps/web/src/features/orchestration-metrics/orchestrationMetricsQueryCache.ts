export type OrchestrationMetricCacheState = "fresh" | "stale" | "miss";

export type OrchestrationMetricCacheResolution<T> = {
  state: OrchestrationMetricCacheState;
  value: T | null;
  refresh: Promise<T> | null;
};

type CacheEntry = {
  cachedAt: number;
  value: unknown;
};

type CacheContext = {
  entries: Map<string, CacheEntry>;
};

const FRESH_TTL_MS = 60_000;
const STALE_TTL_MS = 300_000;
const MAX_CONTEXTS = 3;

const contexts = new Map<string, CacheContext>();
const inFlightRequests = new Map<string, Promise<unknown>>();
let activeServerWsOrigin = "";
let activeUserId = "";
let activeSessionToken = "";
let sessionGeneration = 0;

/** Clears cached metric responses when the Server or active account session changes. */
export function synchronizeOrchestrationMetricCacheSession(
  serverWsOrigin: string,
  userId: string,
  sessionToken: string,
): void {
  const nextServerWsOrigin = serverWsOrigin.trim();
  const nextUserId = userId.trim();
  const nextSessionToken = sessionToken.trim();
  if (nextServerWsOrigin === activeServerWsOrigin
    && nextUserId === activeUserId
    && nextSessionToken === activeSessionToken) return;
  activeServerWsOrigin = nextServerWsOrigin;
  activeUserId = nextUserId;
  activeSessionToken = nextSessionToken;
  clearOrchestrationMetricQueryCache();
}

/** Allows successful responses only for mine while retaining conservative privacy suppression. */
export function isOrchestrationMetricQueryResultCacheable(
  scopeKind: string,
  result: { ok: boolean; code?: string },
): boolean {
  return (scopeKind === "mine" && result.ok) || result.code === "ORCH_METRICS_PRIVACY_SUPPRESSED";
}

/** Builds a stable key for one applied business-query context. */
export function createOrchestrationMetricCacheContextKey(input: Record<string, unknown>): string {
  return stableSerialize(input);
}

/** Builds a stable endpoint key from paging and endpoint-specific parameters. */
export function createOrchestrationMetricCacheRequestKey(endpoint: string, input: Record<string, unknown> = {}): string {
  return `${endpoint}|${stableSerialize(input)}`;
}

/** Resolves fresh/stale data synchronously and starts one deduplicated refresh when needed. */
export function resolveOrchestrationMetricCachedQuery<T>(input: {
  contextKey: string;
  requestKey: string;
  load: () => Promise<T>;
  shouldCache: (value: T) => boolean;
  now?: () => number;
}): OrchestrationMetricCacheResolution<T> {
  const now = input.now ?? Date.now;
  const cached = readCacheEntry<T>(input.contextKey, input.requestKey, now());
  if (cached.state === "fresh") return { ...cached, refresh: null };
  return {
    ...cached,
    refresh: loadAndCache(input.contextKey, input.requestKey, input.load, input.shouldCache, now),
  };
}

/** Writes one known-success response, for example a summary returned by manual refresh. */
export function writeOrchestrationMetricQueryCache<T>(
  contextKey: string,
  requestKey: string,
  value: T,
  now = Date.now(),
): void {
  writeCacheEntry(contextKey, requestKey, value, now);
}

/** Clears all in-memory values without cancelling callers already awaiting their network request. */
export function clearOrchestrationMetricQueryCache(): void {
  sessionGeneration += 1;
  contexts.clear();
  inFlightRequests.clear();
}

/** Reads one cache entry and removes it after the stale ceiling. */
function readCacheEntry<T>(contextKey: string, requestKey: string, now: number): {
  state: OrchestrationMetricCacheState;
  value: T | null;
} {
  const context = contexts.get(contextKey);
  const entry = context?.entries.get(requestKey);
  if (!context || !entry) return { state: "miss", value: null };
  const age = Math.max(0, now - entry.cachedAt);
  if (age > STALE_TTL_MS) {
    context.entries.delete(requestKey);
    if (!context.entries.size) contexts.delete(contextKey);
    return { state: "miss", value: null };
  }
  touchContext(contextKey, context);
  return { state: age <= FRESH_TTL_MS ? "fresh" : "stale", value: entry.value as T };
}

/** 合并在途请求；重采失败清理旧成功值，不允许后续读取误用旧轮次。 */
function loadAndCache<T>(
  contextKey: string,
  requestKey: string,
  load: () => Promise<T>,
  shouldCache: (value: T) => boolean,
  now: () => number,
): Promise<T> {
  const inFlightKey = `${contextKey.length}:${contextKey}${requestKey}`;
  const existing = inFlightRequests.get(inFlightKey) as Promise<T> | undefined;
  if (existing) return existing;
  const expectedSessionGeneration = sessionGeneration;
  const request = load().then((value) => {
    if (shouldCache(value) && expectedSessionGeneration === sessionGeneration) {
      writeCacheEntry(contextKey, requestKey, value, now());
    } else if (expectedSessionGeneration === sessionGeneration) {
      contexts.get(contextKey)?.entries.delete(requestKey);
    }
    return value;
  }).catch(error => {
    if (expectedSessionGeneration === sessionGeneration) contexts.get(contextKey)?.entries.delete(requestKey);
    throw error;
  }).finally(() => {
    if (inFlightRequests.get(inFlightKey) === request) inFlightRequests.delete(inFlightKey);
  });
  inFlightRequests.set(inFlightKey, request);
  return request;
}

/** Writes one entry and keeps only the three most recently accessed contexts. */
function writeCacheEntry<T>(contextKey: string, requestKey: string, value: T, cachedAt: number): void {
  const context = contexts.get(contextKey) ?? { entries: new Map<string, CacheEntry>() };
  context.entries.set(requestKey, { cachedAt, value });
  touchContext(contextKey, context);
  while (contexts.size > MAX_CONTEXTS) {
    const oldestKey = contexts.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    contexts.delete(oldestKey);
  }
}

/** Moves a context to the end of the Map so insertion order acts as LRU order. */
function touchContext(contextKey: string, context: CacheContext): void {
  contexts.delete(contextKey);
  contexts.set(contextKey, context);
}

/** Serializes query data with sorted object keys and set-like primitive arrays. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    const normalized = value.every((item) => item == null || ["string", "number", "boolean"].includes(typeof item))
      ? [...value].sort((left, right) => String(left).localeCompare(String(right)))
      : value;
    return `[${normalized.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
