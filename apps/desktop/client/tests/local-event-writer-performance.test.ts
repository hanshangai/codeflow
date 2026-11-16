import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";
import { createLocalEventPersistence, createLocalEventPipeline, type LocalEventInput } from "../src/runtime/localEventPersistence.js";
import { hasLocalEventOwnerEffects } from "../src/runtime/localEventIndex.js";

/** 固定真实SQLite与生产组批/索引路径；长测显式设置600000ms，不连接业务库。 */
test("五回合持续200事件每秒与2000条突发的Writer重放", { timeout: 900_000 }, async t => {
  const durationMs = Number(process.env.CODEFLOWAI_WRITER_PERF_DURATION_MS ?? 1500);
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 1000 && durationMs <= 600_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-writer-performance-"));
  const dbPath = path.join(root, "app.db"), workspaceId = "performance";
  const db = openClientDb({ dbPath, localCanonicalEvents: true });
  db.workspaces.upsert({ id: workspaceId, title: "压测", path: root });
  for (let i = 0; i < 5; i++) db.forWorkspace(workspaceId).threads.create({ id: `thread-${i}`, workspaceId, title: "压测", engine: "claude" });
  const latencies: number[] = [], ordinaryLatencies: number[] = [], controls: number[] = [], heartbeat: number[] = [];
  const admitted = new Map<number, { at: number; burst: boolean }>();
  let accepted = 0, published = 0, peakBacklog = 0, peakRss = process.memoryUsage().rss, burst = false;
  const failures: unknown[] = [];
  const stages: Record<string, number[]> = {};
  /** 测量既有阶段耗时，定位连接、提交与主线程索引的实际成本。 */
  const measure = async <T>(stage: string, run: () => Promise<T>): Promise<T> => {
    const at = performance.now();
    try { return await run(); } finally { (stages[stage] ??= []).push(performance.now() - at); }
  };
  const writer = new ClientDbWriterService({ dbPath, db, clientId: "performance", onFatalError(error) { failures.push(error); } });
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const pipeline = createLocalEventPipeline({ writer: {
    createBatchIdentity: id => writer.createBatchIdentity(id),
    confirmBatch: (id, batchId) => measure("confirmed", () => writer.confirmBatch(id, batchId)),
    submit: batch => measure("commit", () => writer.submit(batch)),
    indexDatabase: (id, batchId) => measure("databaseIndex", () => writer.indexDatabase(id, batchId)),
    completeIndexes: (id, batchId, count) => measure("complete", () => writer.completeIndexes(id, batchId, count)),
    withLegacyDatabase: (id, run) => writer.withLegacyDatabase(id, run),
    failIndexes: (id, batchId, error) => writer.failIndexes(id, batchId, error),
  }, apply() {}, publish() {},
    applyBatch: async (receipt, id) => {
      assert.ok(receipt.localThreadIds);
      if (receipt.messages.some(hasLocalEventOwnerEffects)) await writer.withLegacyDatabase(`perf-effects:${receipt.batchId}`, () => persistence.applyBatchEffects(id, receipt.batchId, () => {}));
    },
    publishBatch: async messages => {
      for (const message of messages) {
        const state = admitted.get(message.event.ts);
        assert.ok(state, "每个准入事件必须只发布一次");
        const elapsed = performance.now() - state.at;
        latencies.push(elapsed); if (!state.burst) ordinaryLatencies.push(elapsed);
        admitted.delete(message.event.ts); published++;
      }
    },
    onFailure(error) { failures.push(error); t.diagnostic(error instanceof Error ? error.stack! : String(error)); },
  });
  t.after(async () => {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [() => pipeline.close(), () => writer.close()]) {
      try { await cleanup(); } catch (error) { cleanupFailures.push(error); }
    }
    db.close(); fs.rmSync(root, { recursive: true, force: true });
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "PERFORMANCE_CLEANUP_FAILED");
  });
  await writer.ready();
  /** 同一回合raw/canonical交替，正文与展示投影都使用真实仓储。 */
  const enqueue = (index: number): void => {
    const lane = index % 5, ts = ++accepted;
    const event = { workspaceId, threadId: `thread-${lane}`, engine: "claude" as const, ts };
    const message: LocalEventInput = index % 2 ? { t: "raw.event", event: { ...event, clientTurnId: `turn-${lane}`, source: "stdout", data: { text: "synthetic output" }, handled: true, action: "mapped", emittedTypes: [] } }
      : { t: "conversation.event", event: { ...event, type: "item.agentMessage.delta", payload: { turnId: `turn-${lane}`, itemId: `item-${lane}`, engineMessageId: `provider-${lane}`, delta: "输出" } } };
    admitted.set(ts, { at: performance.now(), burst });
    pipeline.enqueue(message, `turn-${lane}`, 1);
    peakBacklog = Math.max(peakBacklog, accepted - published);
  };
  const start = performance.now(); let nextHeartbeat = start + 20;
  const timer = setInterval(() => {
    const now = performance.now(); heartbeat.push(Math.max(0, now - nextHeartbeat)); nextHeartbeat = now + 20;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  t.after(() => clearInterval(timer));
  let injected = false, lastControl = start;
  while (performance.now() - start < durationMs) {
    const target = Math.floor(Math.min(durationMs, performance.now() - start) / 5);
    while (accepted - (injected ? 2000 : 0) < target) enqueue(accepted);
    if (!injected && performance.now() - start >= durationMs / 2) {
      burst = true; for (let i = 0; i < 2000; i++) enqueue(accepted); burst = false; injected = true;
    }
    if (performance.now() - lastControl >= 100) {
      const requested = performance.now();
      await new Promise<void>(resolve => setImmediate(() => { controls.push(performance.now() - requested); resolve(); }));
      lastControl = performance.now();
    }
    await delay(5);
  }
  const stopAt = performance.now();
  await pipeline.flush();
  const drainMs = performance.now() - stopAt;
  assert.equal(failures.length, 0, String(failures[0]));
  assert.equal(published, accepted); assert.equal(admitted.size, 0);
  const counts = await writer.withLegacyDatabase("perf-count", () => db.withWorkspaceCoreRepos(workspaceId, () => ({
    raw: (db.forWorkspace(workspaceId).db.prepare("SELECT COUNT(*) AS n FROM raw_engine_events").get() as { n: number }).n,
    canonical: (db.forWorkspace(workspaceId).db.prepare("SELECT COUNT(*) AS n FROM conversation_events").get() as { n: number }).n,
  })));
  assert.equal(counts.raw + counts.canonical, accepted);
  /** 分位数只报告实际测量；setImmediate控制派发不冒充真实provider停止确认。 */
  const quantiles = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return Object.fromEntries([50, 95, 99].map(q => [`p${q}`, Math.round((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q / 100))] ?? 0) * 100) / 100]));
  };
  t.diagnostic(JSON.stringify({ durationMs, actualMs: Math.round(performance.now() - start), accepted, published, counts,
    peakBacklog, endBacklog: admitted.size, drainMs: Math.round(drainMs), peakRssMiB: Math.round(peakRss / 1024 / 1024),
    enqueueToPublishMs: quantiles(latencies), ordinaryEnqueueToPublishMs: quantiles(ordinaryLatencies),
    eventLoopLagMs: quantiles(heartbeat), controlDispatchMs: quantiles(controls),
    stages: Object.fromEntries(Object.entries(stages).map(([name, values]) => [name, { count: values.length, ...quantiles(values) }])),
    limitation: "生产Worker/SQLite组批索引路径；未包含浏览器渲染与真实provider停止" }));
});
