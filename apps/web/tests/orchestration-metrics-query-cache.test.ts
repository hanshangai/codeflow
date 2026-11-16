import test from "node:test";
import assert from "node:assert/strict";
import { getOrchestrationMetricSummary } from "../src/api/orchestration-metrics/index.ts";
import { isCancelledRequestError } from "../src/api/request.ts";

import {
  clearOrchestrationMetricQueryCache,
  createOrchestrationMetricCacheContextKey,
  createOrchestrationMetricCacheRequestKey,
  isOrchestrationMetricQueryResultCacheable,
  resolveOrchestrationMetricCachedQuery,
  synchronizeOrchestrationMetricCacheSession,
  writeOrchestrationMetricQueryCache,
} from "../src/features/orchestration-metrics/orchestrationMetricsQueryCache.ts";

type TestResponse = { ok: boolean; value?: string; code?: string };

test("离开指标页后取消请求，不再启动冷采集 HTTP", async (t) => {
  const controller = new AbortController();
  controller.abort();
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => { sent += 1; throw new Error("unexpected network"); });
  await assert.rejects(getOrchestrationMetricSummary({
    serverWsOrigin: "ws://localhost:39280", sessionToken: "session", webSessionId: "web",
    signal: controller.signal,
  }, {}), isCancelledRequestError);
  assert.equal(sent, 0);
});

/** Allows tests to finish deduplicated requests in a controlled order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Starts one cache lookup with the test clock and response policy. */
function query(
  contextKey: string,
  requestKey: string,
  load: () => Promise<TestResponse>,
  now: () => number,
  scopeKind = "mine",
) {
  return resolveOrchestrationMetricCachedQuery({
    contextKey,
    requestKey,
    load,
    shouldCache: (result) => isOrchestrationMetricQueryResultCacheable(scopeKind, result),
    now,
  });
}

test("stable keys normalize object fields and set-like primitive arrays", () => {
  const left = createOrchestrationMetricCacheContextKey({ scope: "mine", workflows: ["b", "a"], nested: { z: 1, a: true } });
  const right = createOrchestrationMetricCacheContextKey({ nested: { a: true, z: 1 }, workflows: ["a", "b"], scope: "mine" });
  assert.equal(left, right);
});

test("fresh hits skip the network, stale hits refresh, and expired entries miss", async () => {
  clearOrchestrationMetricQueryCache();
  let now = 1_000;
  let calls = 0;
  const contextKey = "context-freshness";
  const requestKey = createOrchestrationMetricCacheRequestKey("summary");
  const load = async (): Promise<TestResponse> => ({ ok: true, value: `v${++calls}` });

  const first = query(contextKey, requestKey, load, () => now);
  assert.equal(first.state, "miss");
  assert.equal((await first.refresh)?.value, "v1");

  now += 60_000;
  const fresh = query(contextKey, requestKey, load, () => now);
  assert.equal(fresh.state, "fresh");
  assert.equal(fresh.value?.value, "v1");
  assert.equal(fresh.refresh, null);

  now += 1;
  const stale = query(contextKey, requestKey, load, () => now);
  assert.equal(stale.state, "stale");
  assert.equal(stale.value?.value, "v1");
  assert.equal((await stale.refresh)?.value, "v2");

  now += 300_001;
  const expired = query(contextKey, requestKey, load, () => now);
  assert.equal(expired.state, "miss");
  assert.equal(expired.value, null);
  await expired.refresh;
  assert.equal(calls, 3);
});

test("重新采集失败后移除旧成功缓存，不能把旧数据当本轮成功", async () => {
  clearOrchestrationMetricQueryCache();
  writeOrchestrationMetricQueryCache("round", "summary", { ok: true, value: "old" }, 1);
  const failed = query("round", "summary", async () => ({ ok: false, code: "ORCH_METRICS_COLLECT_FAILED" }), () => 60_002);
  await failed.refresh;
  const retry = query("round", "summary", async () => ({ ok: true, value: "new" }), () => 60_003);
  assert.equal(retry.state, "miss");
  assert.equal(retry.value, null);
  await retry.refresh;
});

test("concurrent misses reuse one in-flight request", async () => {
  clearOrchestrationMetricQueryCache();
  const pending = deferred<TestResponse>();
  let calls = 0;
  const load = (): Promise<TestResponse> => { calls += 1; return pending.promise; };
  const now = () => 5_000;
  const first = query("context-dedupe", "summary|{}", load, now);
  const second = query("context-dedupe", "summary|{}", load, now);

  assert.equal(calls, 1);
  assert.equal(first.refresh, second.refresh);
  pending.resolve({ ok: true, value: "shared" });
  assert.equal((await second.refresh)?.value, "shared");
});

test("business failures are not cached while privacy suppression is cached", async () => {
  clearOrchestrationMetricQueryCache();
  let calls = 0;
  const now = () => 10_000;
  const failedLoad = async (): Promise<TestResponse> => {
    calls += 1;
    return { ok: false, code: "FAILED" };
  };
  await query("context-errors", "details|{}", failedLoad, now).refresh;
  const failedAgain = query("context-errors", "details|{}", failedLoad, now);
  assert.equal(failedAgain.state, "miss");
  await failedAgain.refresh;
  assert.equal(calls, 2);

  const privacy = { ok: false, code: "ORCH_METRICS_PRIVACY_SUPPRESSED" };
  await query("context-errors", "details|{}", async () => privacy, now).refresh;
  const privacyHit = query("context-errors", "details|{}", async () => ({ ok: true }), now);
  assert.equal(privacyHit.state, "fresh");
  assert.equal(privacyHit.value?.code, "ORCH_METRICS_PRIVACY_SUPPRESSED");
});

test("LRU keeps the three most recently used complete contexts", () => {
  clearOrchestrationMetricQueryCache();
  const requestKey = "summary|{}";
  writeOrchestrationMetricQueryCache("a", requestKey, { ok: true, value: "a" }, 1);
  writeOrchestrationMetricQueryCache("b", requestKey, { ok: true, value: "b" }, 1);
  writeOrchestrationMetricQueryCache("c", requestKey, { ok: true, value: "c" }, 1);
  assert.equal(query("a", requestKey, async () => ({ ok: true }), () => 2).state, "fresh");
  writeOrchestrationMetricQueryCache("d", requestKey, { ok: true, value: "d" }, 2);

  assert.equal(query("b", requestKey, async () => ({ ok: true }), () => 2).state, "miss");
  assert.equal(query("a", requestKey, async () => ({ ok: true }), () => 2).state, "fresh");
  assert.equal(query("c", requestKey, async () => ({ ok: true }), () => 2).state, "fresh");
  assert.equal(query("d", requestKey, async () => ({ ok: true }), () => 2).state, "fresh");
});

test("successful responses are cached only for mine while privacy suppression remains cacheable", async () => {
  clearOrchestrationMetricQueryCache();
  const now = () => 1;
  await query("mine", "summary|{}", async () => ({ ok: true, value: "mine" }), now, "mine").refresh;
  assert.equal(query("mine", "summary|{}", async () => ({ ok: true }), now, "mine").state, "fresh");

  await query("enterprise", "summary|{}", async () => ({ ok: true, value: "group" }), now, "enterprise").refresh;
  assert.equal(query("enterprise", "summary|{}", async () => ({ ok: true }), now, "enterprise").state, "miss");

  const privacy = { ok: false, code: "ORCH_METRICS_PRIVACY_SUPPRESSED" };
  await query("enterprise-privacy", "summary|{}", async () => privacy, now, "enterprise").refresh;
  assert.equal(query("enterprise-privacy", "summary|{}", async () => ({ ok: true }), now, "enterprise").state, "fresh");
});

test("session-wide clearing prevents an older in-flight response from restoring stale data", async () => {
  clearOrchestrationMetricQueryCache();
  const pending = deferred<TestResponse>();
  const contextKey = "context-refresh";
  const requestKey = "summary|{}";
  const oldResolution = query(contextKey, requestKey, () => pending.promise, () => 1);

  clearOrchestrationMetricQueryCache();
  pending.resolve({ ok: true, value: "old" });
  await oldResolution.refresh;

  const current = query(contextKey, requestKey, async () => ({ ok: true, value: "new" }), () => 2);
  assert.equal(current.state, "miss");
  assert.equal((await current.refresh)?.value, "new");
});

test("session changes clear values and prevent older requests from repopulating cache", async () => {
  clearOrchestrationMetricQueryCache();
  synchronizeOrchestrationMetricCacheSession("ws://server-a", "user-a", "session-a");
  const oldRequest = deferred<TestResponse>();
  const contextKey = "context-session";
  const requestKey = "summary|{}";
  const oldResolution = query(contextKey, requestKey, () => oldRequest.promise, () => 1);

  synchronizeOrchestrationMetricCacheSession("ws://server-a", "user-a", "session-b");
  const newResolution = query(contextKey, requestKey, async () => ({ ok: true, value: "new" }), () => 2);
  await newResolution.refresh;
  oldRequest.resolve({ ok: true, value: "old" });
  await oldResolution.refresh;

  const current = query(contextKey, requestKey, async () => ({ ok: true, value: "unexpected" }), () => 3);
  assert.equal(current.state, "fresh");
  assert.equal(current.value?.value, "new");
});

test("Server address changes isolate otherwise identical account sessions", () => {
  clearOrchestrationMetricQueryCache();
  synchronizeOrchestrationMetricCacheSession("ws://server-a", "user-a", "session-a");
  const requestKey = "summary|{}";
  writeOrchestrationMetricQueryCache("context-server", requestKey, { ok: true, value: "server-a" }, 1);

  synchronizeOrchestrationMetricCacheSession("ws://server-b", "user-a", "session-a");
  const current = query("context-server", requestKey, async () => ({ ok: true, value: "server-b" }), () => 2);
  assert.equal(current.state, "miss");
});
