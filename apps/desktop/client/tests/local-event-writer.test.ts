import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbReaderService } from "../src/db/clientDbReaderService.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";
import { CLIENT_DB_SCHEMA_VERSION } from "../src/db/clientDbSchemaVersion.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { createRawEventAckBuffer } from "../src/diagnostics/rawEventAckBuffer.js";
import { createThreadTouchBuffer } from "../src/diagnostics/threadTouchBuffer.js";
import { ClientDbCleanupService } from "../src/db/clientDbCleanupService.js";
import { createWorkspaceMigrationRuntimeCallbacks } from "../src/workspace-migration/workspaceMigrationRuntimeCallbacks.js";
import { createLocalEventPersistence, createLocalEventPipeline } from "../src/runtime/localEventPersistence.js";
import { logger } from "../src/logger.js";
import { hasLocalEventOwnerEffects } from "../src/runtime/localEventIndex.js";

/** 使用独立临时库验证真实 Worker，禁止连接现有业务数据。 */
function fixture(t: test.TestContext, workspaceOperationGate?: WorkspaceOperationGate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-event-writer-"));
  const dbPath = path.join(root, "app.db");
  const db = openClientDb({ dbPath, localCanonicalEvents: true, workspaceOperationGate });
  const workspaceId = "writer:workspace";
  db.workspaces.upsert({ id: workspaceId, title: "写入验证", path: root });
  db.forWorkspace(workspaceId).threads.create({ id: "thread", workspaceId, engine: "claude", title: "会话" });
  let writer: { close(): Promise<void> } | undefined;
  t.after(async () => { try { await writer?.close(); } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); } });
  return { root, dbPath, db, workspaceId, own(value: { close(): Promise<void> }) { writer = value; } };
}

/** 延迟载入以明确报告能力缺失，而非用模块解析错误充当失败断言。 */
async function writerClass() {
  assert.ok(fs.existsSync(new URL("../src/db/clientDbWriterService.ts", import.meta.url)), "缺少独立写入 Worker 服务");
  return (await import("../src/db/clientDbWriterService.js")).ClientDbWriterService;
}

/** 构造同回合的 raw 事件，正文身份由生产核心校验。 */
function batch(workspaceId: string, batchId = "batch-1", count = 1) {
  return { batchId, workspaceId, ownerGeneration: 1, events: Array.from({ length: count }, (_, index) => ({
    t: "raw.event" as const, event: { workspaceId, threadId: "thread", clientTurnId: "turn", engine: "claude" as const,
      ts: 100 + index, source: "stdout", data: { text: `事件 ${index}` }, handled: true,
      action: "mapped" as const, emittedTypes: [] },
  })) };
}

test("确认回执只保最近128条，回收的旧批次与旧epoch不得再次分号", async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-current", applyRaw() {}, applyConversation() {} });
  let oldest: any;
  for (let ordinal = 1; ordinal <= 132; ordinal++) {
    const input = { ...batch(f.workspaceId, `epoch-current:${ordinal}`), writerEpoch: "epoch-current", batchOrdinal: ordinal };
    if (ordinal === 1) oldest = input;
    core.persistBatch(input);
    core.confirmBatch(f.workspaceId, input.batchId);
  }
  const db = f.db.forWorkspace(f.workspaceId);
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'local_event_batch:%'").get() as any).count, 128);
  assert.throws(() => core.commitBatch(oldest), /LOCAL_EVENT_BATCH_RETIRED/u);
  const restarted = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-next", applyRaw() {}, applyConversation() {} });
  restarted.persistBatch({ ...batch(f.workspaceId, "epoch-next:1"), writerEpoch: "epoch-next", batchOrdinal: 1 });
  assert.throws(() => restarted.commitBatch(oldest), /LOCAL_EVENT_BATCH_RETIRED/u);
  assert.throws(() => core.commitBatch({ ...batch(f.workspaceId, "epoch-current:133"), writerEpoch: "epoch-current", batchOrdinal: 133 }), /LOCAL_EVENT_WRITER_EPOCH_RETIRED/u);
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get() as any).count, 133);
});

test("重启保留旧未确认和无epoch旧回执，确认前不得回收或重复正文", async t => {
  const f = fixture(t);
  const original = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-old", applyRaw() {}, applyConversation() {} });
  const legacy = batch(f.workspaceId, "legacy-pending");
  const first = original.commitBatch(legacy);
  assert.throws(() => original.confirmBatch(f.workspaceId, legacy.batchId), /LOCAL_EVENT_CONFIRM_BEFORE_INDEX/u);
  const restarted = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-new", applyRaw() {}, applyConversation() {} });
  const recovered = restarted.readPendingBatch(f.workspaceId)!;
  assert.equal(recovered.batchId, legacy.batchId);
  assert.deepEqual(restarted.persistBatch(recovered).messages, first.messages);
  restarted.confirmBatch(f.workspaceId, legacy.batchId);
  const pending = { ...batch(f.workspaceId, "epoch-new:1"), writerEpoch: "epoch-new", batchOrdinal: 1 };
  const committed = restarted.commitBatch(pending);
  const again = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-third", applyRaw() {}, applyConversation() {} });
  const originalBatch = again.readPendingBatch(f.workspaceId)!;
  assert.equal(originalBatch.writerEpoch, "epoch-new");
  assert.equal(originalBatch.batchOrdinal, 1);
  assert.deepEqual(again.persistBatch(originalBatch).messages, committed.messages);
});

test("乱序确认回收只拒绝已退休ordinal，尚未提交的低ordinal仍可提交", async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-order", applyRaw() {}, applyConversation() {} });
  const make = (ordinal: number) => ({ ...batch(f.workspaceId, `epoch-order:${ordinal}`), writerEpoch: "epoch-order", batchOrdinal: ordinal });
  f.db.withWorkspaceCoreRepos(f.workspaceId, () => {
    for (let ordinal = 2; ordinal <= 132; ordinal++) {
      const input = make(ordinal);
      core.persistBatch(input); core.confirmBatch(f.workspaceId, input.batchId);
    }
    assert.throws(() => core.commitBatch(make(2)), /LOCAL_EVENT_BATCH_RETIRED/u);
    const first = core.persistBatch(make(1));
    assert.equal(first.messages.length, 1);
    core.confirmBatch(f.workspaceId, "epoch-order:1");
    assert.equal((f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'local_event_batch:%'").get() as any).count, 128);
  });
});

test("同步单条兼容入口同样只保128个已确认回执", async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  f.db.withWorkspaceCoreRepos(f.workspaceId, () => {
    for (let index = 0; index < 130; index++) core.persist(batch(f.workspaceId).events[0]!);
    assert.equal((f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'local_event_batch:%'").get() as any).count, 128);
  });
});

test("真实pipeline只在发布成功后确认回执，发布失败保留原恢复记录", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ db: f.db, dbPath: f.dbPath, onFatalError() {} }); f.own(writer);
  await writer.ready();
  const pipeline = createLocalEventPipeline({ writer, apply() {}, publish() { throw new Error("PUBLISH_FAILED"); }, onFailure() {} });
  pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
  await assert.rejects(pipeline.flush(), /PUBLISH_FAILED/u);
  const rows = await writer.withLegacyDatabase("verify-unconfirmed", () => f.db.forWorkspace(f.workspaceId).db.prepare(
    "SELECT value FROM meta WHERE key LIKE 'local_event_batch:%'").all()) as any[];
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].value).confirmed, false);
});

test("真实pipeline发布完成后确认同一epoch批次并交付batchId", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ db: f.db, dbPath: f.dbPath, onFatalError() {} }); f.own(writer);
  await writer.ready();
  let publishedBatchId: string | undefined;
  const pipeline = createLocalEventPipeline({ writer, apply() {}, publish() {},
    publishBatch: async (_messages, _workspaceId, batchId) => { publishedBatchId = batchId; }, onFailure() {} });
  pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
  await pipeline.flush();
  const rows = await writer.withLegacyDatabase("verify-confirmed", () => f.db.forWorkspace(f.workspaceId).db.prepare(
    "SELECT key,value FROM meta WHERE key LIKE 'local_event_batch:%'").all()) as any[];
  assert.equal(rows.length, 1);
  const receipt = JSON.parse(rows[0].value);
  assert.equal(receipt.confirmed, true);
  assert.equal(rows[0].key, `local_event_batch:${publishedBatchId}`);
  assert.equal(publishedBatchId, `${receipt.writerEpoch}:${receipt.batchOrdinal}`);
});

test("生产副作用准入允许已索引未发布的原批恢复，只发布而不重复owner副作用", async t => {
  const f = fixture(t), Writer = await writerClass();
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  const original = { batchId: "indexed-before-publication", workspaceId: f.workspaceId, ownerGeneration: 1, turnId: "recover-turn", events: [
    { t: "conversation.event" as const, event: { ts: 100, workspaceId: f.workspaceId, threadId: "thread", engine: "claude" as const,
      type: "turn.started" as const, payload: { turnId: "recover-turn" } } },
  ] };
  const before = core.commitBatch(original);
  core.completeBatchIndexes(f.workspaceId, original.batchId, before.messages.length);
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const expression = source.match(/const hasEffects = ([^;\r\n]+);/u)?.[1];
  assert.ok(expression, "使用生产入口实际的回执副作用准入表达式");
  const needsEffects = new Function("receipt", "hasLocalEventOwnerEffects", `return ${expression};`);
  let callbacks = 0, published = 0;
  const pipeline = createLocalEventPipeline({ writer, apply() {}, publish() { published++; },
    onFailure(error) { throw error; },
    async applyBatch(receipt, workspaceId) {
      if (needsEffects(receipt, hasLocalEventOwnerEffects)) await writer.withExclusiveWorkspaceDatabase("recover-owner", workspaceId, () => {
        callbacks++; core.applyBatchEffects(workspaceId, receipt.batchId, () => {}, true);
      }, receipt.batchId);
    },
  });
  const pending = await writer.withLegacyDatabase("read-indexed-pending", () => core.readPendingBatch(f.workspaceId));
  await pipeline.recover(pending!);
  assert.equal(callbacks, 0); assert.equal(published, 1);
  const recovered = await writer.withLegacyDatabase("verify-indexed-recovery", () => ({
    pending: core.readPendingBatch(f.workspaceId),
    latest: f.db.forWorkspace(f.workspaceId).conversationEvents.getLatestSeq(),
  }));
  assert.equal(recovered.pending, null);
  assert.equal(recovered.latest, before.messages[0]!.event.seq);
  await pipeline.close();
});

for (const confirmationFails of [false, true]) test(`同回合发布后允许下一批推进，确认完成前flush与close仍等待：失败=${confirmationFails}`, async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  let acknowledge!: () => void, rejectAcknowledgement!: (error: unknown) => void;
  const acknowledgement = new Promise<void>((resolve, reject) => { acknowledge = resolve; rejectAcknowledgement = reject; });
  let firstPublished!: () => void;
  const publication = new Promise<void>(resolve => { firstPublished = resolve; });
  const published: string[] = [], confirmed: string[] = [], failures: unknown[] = [];
  let firstBatchId = "";
  const failure = new Error("CONFIRMATION_FAILED");
  const pipeline = createLocalEventPipeline({ writer: {
    submit: async input => core.commitBatch(input),
    completeIndexes: async (workspaceId, batchId, count) => core.completeBatchIndexes(workspaceId, batchId, count),
    confirmBatch: async (workspaceId, batchId) => {
      if (batchId === firstBatchId) await acknowledgement;
      core.confirmBatch(workspaceId, batchId); confirmed.push(batchId);
    },
    withLegacyDatabase: async (_requestId, operation) => operation(), failIndexes() {},
  }, apply() {}, publish() {}, publishBatch: async (_messages, _workspaceId, batchId) => {
    if (!firstBatchId) { firstBatchId = batchId; firstPublished(); }
    published.push(batchId);
  }, onFailure(error) { failures.push(error); } });
  pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
  const initialFlush = pipeline.flush().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  try {
    await publication;
    pipeline.enqueue({ ...batch(f.workspaceId).events[0]!, event: { ...batch(f.workspaceId).events[0]!.event, ts: 101 } }, "turn", 1);
    let flushed = false, closed = false;
    const flush = pipeline.flush().then(() => { flushed = true; return { ok: true as const }; }, error => ({ ok: false as const, error }));
    const closing = pipeline.close().then(() => { closed = true; return { ok: true as const }; }, error => ({ ok: false as const, error }));
    for (let index = 0; index < 5; index++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(published.length, 2, "前批确认不能阻止后批按同回合FIFO发布");
    assert.equal(confirmed.length, 1);
    assert.equal(flushed, false); assert.equal(closed, false);
    if (confirmationFails) rejectAcknowledgement(failure); else acknowledge();
    const results = await Promise.all([initialFlush, flush, closing]);
    if (confirmationFails) {
      for (const result of results) assert.equal(!result.ok && result.error, failure);
      assert.deepEqual(failures, [failure]);
      assert.throws(() => pipeline.assertNoFailure(f.workspaceId), error => error === failure);
    } else {
      assert.deepEqual(results.map(result => result.ok), [true, true, true]);
      assert.equal(confirmed.length, 2);
    }
    assert.notEqual(published[0], published[1]);
  } finally { acknowledge(); await initialFlush; await pipeline.close().then(() => {}, () => {}); }
});

test("前批确认失败时阻止尚在提交等待中的后批发布", async t => {
  const f = fixture(t), failure = new Error("EARLIER_CONFIRMATION_FAILED");
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  let rejectFirst!: (error: unknown) => void, releaseSecond!: () => void, publishedFirst!: () => void, submittedSecond!: () => void;
  const firstConfirmation = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const secondCommit = new Promise<void>(resolve => { releaseSecond = resolve; });
  const publication = new Promise<void>(resolve => { publishedFirst = resolve; });
  const submitted = new Promise<void>(resolve => { submittedSecond = resolve; });
  let commits = 0, publications = 0;
  const pipeline = createLocalEventPipeline({ writer: {
    submit: async input => { if (++commits === 2) { submittedSecond(); await secondCommit; } return core.commitBatch(input); },
    completeIndexes: async (workspaceId, batchId, count) => core.completeBatchIndexes(workspaceId, batchId, count),
    confirmBatch: async () => { await firstConfirmation; },
    withLegacyDatabase: async (_requestId, operation) => operation(), failIndexes() {},
  }, apply() {}, publish() { publications += 1; publishedFirst(); }, onFailure() {} });
  pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
  const first = pipeline.flush().then(() => undefined, error => error);
  try {
    await publication;
    pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
    const second = pipeline.flush().then(() => undefined, error => error);
    await submitted;
    rejectFirst(failure);
    assert.equal(await first, failure);
    releaseSecond();
    assert.equal(await second, failure);
    assert.equal(publications, 1);
  } finally { rejectFirst(failure); releaseSecond(); await first; await pipeline.close().then(() => {}, () => {}); }
});

test("索引完成后确认前重启可恢复原载荷并仅发布一次，逐批确认后恢复为空", async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-recover", applyRaw() {}, applyConversation() {} });
  const inputs = [1, 2].map(batchOrdinal => ({ ...batch(f.workspaceId, `epoch-recover:${batchOrdinal}`),
    writerEpoch: "epoch-recover", batchOrdinal }));
  const committed = inputs.map(input => core.persistBatch(input));
  const restarted = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-after-restart", applyRaw() {}, applyConversation() {} });
  const published: string[] = [];
  const pipeline = createLocalEventPipeline({ writer: {
    submit: async input => restarted.commitBatch(input),
    completeIndexes: async (workspaceId, batchId, count) => restarted.completeBatchIndexes(workspaceId, batchId, count),
    confirmBatch: async (workspaceId, batchId) => restarted.confirmBatch(workspaceId, batchId),
    withLegacyDatabase: async (_requestId, operation) => operation(), failIndexes() {},
  }, apply() { assert.fail("已索引批次不能重做业务索引"); }, publish() {},
    publishBatch: async (_messages, _workspaceId, batchId) => { published.push(batchId); }, onFailure() {} });
  const recoveredFirst = restarted.readPendingBatch(f.workspaceId);
  assert.deepEqual(recoveredFirst, inputs[0]);
  await pipeline.recover(recoveredFirst!);
  await pipeline.recover(restarted.readPendingBatch(f.workspaceId)!);
  assert.equal(restarted.readPendingBatch(f.workspaceId), null);
  assert.deepEqual(published, inputs.map(input => input.batchId));
  const rows = f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get() as any;
  assert.equal(rows.count, committed.length);
});

test("发布失败后重启仍从已索引原批次恢复发布并确认", async t => {
  const f = fixture(t);
  const core = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-failed-publish", applyRaw() {}, applyConversation() {} });
  const input = { ...batch(f.workspaceId, "epoch-failed-publish:1"), writerEpoch: "epoch-failed-publish", batchOrdinal: 1 };
  const firstPipeline = createLocalEventPipeline({ writer: {
    submit: async value => core.commitBatch(value),
    completeIndexes: async (workspaceId, batchId, count) => core.completeBatchIndexes(workspaceId, batchId, count),
    confirmBatch: async (workspaceId, batchId) => core.confirmBatch(workspaceId, batchId),
    withLegacyDatabase: async (_requestId, operation) => operation(), failIndexes() {},
  }, apply() {}, publish() { throw new Error("PUBLISH_FAILED_BEFORE_RESTART"); }, onFailure() {} });
  await assert.rejects(firstPipeline.recover(input), /PUBLISH_FAILED_BEFORE_RESTART/u);
  const restarted = createLocalEventPersistence({ db: f.db, writerEpoch: "epoch-retry-publish", applyRaw() {}, applyConversation() {} });
  const recovered = restarted.readPendingBatch(f.workspaceId);
  assert.deepEqual(recovered, input);
  let published = 0;
  const pipeline = createLocalEventPipeline({ writer: {
    submit: async value => restarted.commitBatch(value),
    completeIndexes: async (workspaceId, batchId, count) => restarted.completeBatchIndexes(workspaceId, batchId, count),
    confirmBatch: async (workspaceId, batchId) => restarted.confirmBatch(workspaceId, batchId),
    withLegacyDatabase: async (_requestId, operation) => operation(), failIndexes() {},
  }, apply() { assert.fail("不能重复已完成索引"); }, publish() { published += 1; }, onFailure() {} });
  await pipeline.recover(recovered!);
  assert.equal(published, 1);
  assert.equal(restarted.readPendingBatch(f.workspaceId), null);
});

test("Worker在同W索引后沿既有权限入口回传本机线程集合", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ db: f.db, dbPath: f.dbPath, clientId: "writer", onFatalError() {} }); f.own(writer);
  await writer.ready();
  const input = { ...batch(f.workspaceId), ...writer.createBatchIdentity(f.workspaceId) };
  await writer.submit(input);
  const indexed = await writer.indexDatabase(f.workspaceId, input.batchId);
  await writer.completeIndexes(f.workspaceId, input.batchId, 1);
  await writer.confirmBatch(f.workspaceId, input.batchId);
  assert.deepEqual(indexed?.localThreadIds, ["thread"]);
});

test("同一Writer的各工作区首批身份不同，不能误合并回执", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ db: f.db, dbPath: f.dbPath, onFatalError() {} }); f.own(writer);
  await writer.ready();
  const first = writer.createBatchIdentity(f.workspaceId);
  const second = writer.createBatchIdentity("writer:other");
  assert.notEqual(first.batchId, second.batchId);
  assert.equal(first.batchOrdinal, 1); assert.equal(second.batchOrdinal, 1);
});

test("Worker正文回执只在真实提交后返回，重复batch不追加正文", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError() {} });
  f.own(writer);
  await writer.ready();
  const input = batch(f.workspaceId);
  const first = await writer.submit(input);
  assert.equal(first.messages.length, 1);
  assert.equal(first.indexedCount, 0);
  const again = await writer.submit(input);
  assert.deepEqual(again.messages, first.messages);
  await writer.completeIndexes(f.workspaceId, input.batchId, first.messages.length);
  assert.equal(await writer.completeIndexes(f.workspaceId, input.batchId, first.messages.length), first.messages[0]!.event.seq);
  const count = await writer.withLegacyDatabase("verify-committed", () =>
    f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get());
  assert.deepEqual(count, { count: 1 });
});

test("legacy准入显式保护旧statement且拒绝跨await的同步许可", async t => {
  const f = fixture(t), statement = f.db.applicationDb.prepare("SELECT COUNT(*) AS count FROM workspaces");
  const Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError() {} });
  f.own(writer);
  await writer.ready();
  assert.throws(() => statement.get(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
  assert.deepEqual(await writer.withLegacyDatabase("allowed", () => statement.get()), { count: 1 });
  await assert.rejects(writer.withLegacyDatabase("async-denied", () => Promise.resolve()), /CLIENT_DB_LEGACY_CALLBACK_MUST_BE_SYNCHRONOUS/u);
  assert.throws(() => statement.get(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u);
});

test("容量拒绝不会入队或落库，关闭后拒绝新准入", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, maxPendingEvents: 1, onFatalError() {} });
  f.own(writer);
  await writer.ready();
  await assert.rejects(writer.submit(batch(f.workspaceId, "oversized", 2)), /CLIENT_DB_WRITER_CAPACITY_EXCEEDED/u);
  const count = await writer.withLegacyDatabase("verify-empty", () =>
    f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get());
  assert.deepEqual(count, { count: 0 });
  await writer.close();
  await assert.rejects(writer.submit(batch(f.workspaceId)), /CLIENT_DB_WRITER_CLOSED/u);
});

test("可用水位等待真实索引确认，后继批次不越过未索引正文", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError() {} }); f.own(writer);
  await writer.ready();
  const first = await writer.submit(batch(f.workspaceId, "first"));
  assert.equal(typeof writer.readReadyThroughSeq, "function", "缺少索引可用水位屏障");
  let readDone = false, secondDone = false;
  const read = writer.readReadyThroughSeq(f.workspaceId).then(value => { readDone = true; return value; });
  const second = writer.submit(batch(f.workspaceId, "second")).then(value => { secondDone = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readDone, false); assert.equal(secondDone, false);
  await writer.completeIndexes(f.workspaceId, "first", 1);
  const next = await second;
  await writer.completeIndexes(f.workspaceId, "second", 1);
  assert.ok(await read >= first.messages[0]!.event.seq);
  assert.ok(next.messages[0]!.event.seq > first.messages[0]!.event.seq);
});

test("真实Reader查询与legacy写交替准入，诊断只在读事务退出后写入", async t => {
  const f = fixture(t), Writer = await writerClass();
  const reader = new ClientDbReaderService({ dbPath: f.dbPath,
    acquireWorkspaceSource: id => f.db.acquireWorkspaceReaderSource(id), onFatalError(error) { throw error; },
    onDiagnostic() { f.db.forWorkspace(f.workspaceId).threads.rename("thread", "读后写入"); } });
  await reader.ready();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, reader, onFatalError() {} });
  f.own({ async close() { await reader.close(); await writer.close(); } });
  await writer.ready();
  const result = await reader.listIntakes({ requestId: "reader-coordinated", workspaceId: f.workspaceId });
  assert.equal(result.totalCount, 0);
  assert.equal(await writer.withLegacyDatabase("verify-reader-write", () => f.db.forWorkspace(f.workspaceId).threads.get("thread")?.title), "读后写入");
});

test("迁移预留等待Writer已准入批次并关闭W连接后才授予独占", async t => {
  const gate = new WorkspaceOperationGate(), f = fixture(t, gate), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, workspaceOperationGate: gate, onFatalError() {} }); f.own(writer);
  await writer.ready();
  await writer.submit(batch(f.workspaceId, "migration"));
  const migration = gate.acquireMigration(f.workspaceId, "move");
  await assert.rejects(writer.submit(batch(f.workspaceId, "denied")), /正在迁移/u);
  await writer.completeIndexes(f.workspaceId, "migration", 1);
  const release = await migration;
  assert.equal(gate.hasActiveWrites(), false);
  release();
});

test("锁等待期间迁移预留仍允许原批次排空，新准入与跨工作区凭据继续拒绝", async t => {
  const gate = new WorkspaceOperationGate(), f = fixture(t, gate), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, workspaceOperationGate: gate, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const input = batch(f.workspaceId, "migration-lock-effects");
  const receipt = await writer.submit(input);
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  let waiting!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  t.mock.method(logger, "warn", () => { waiting(); });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM raw_engine_events").get();
  const effects = writer.withExclusiveWorkspaceDatabase("migration-lock-effects", f.workspaceId, () => {
    calls++; core.applyBatchEffects(f.workspaceId, input.batchId, () => {}, true);
  }, input.batchId);
  const effectResult = effects.then(() => null, error => error);
  let migration!: Promise<() => void>;
  try {
    await started;
    migration = gate.acquireMigration(f.workspaceId, "move-during-lock");
    assert.equal(gate.getMigrationOperationId(f.workspaceId), "move-during-lock");
    assert.throws(() => gate.beginWrite(f.workspaceId), { code: "WORKSPACE_MIGRATION_IN_PROGRESS" });
    await assert.rejects(writer.submit(batch(f.workspaceId, "new-during-migration")), /正在迁移/u);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  const completed = await effectResult;
  if (completed) {
    writer.failIndexes(f.workspaceId, input.batchId, completed);
    await assert.rejects(migration, error => error === completed);
    await assert.rejects(writer.close(), error => error === completed);
    f.own({ close: async () => {} });
    assert.fail(String(completed));
  }
  await writer.completeIndexes(f.workspaceId, input.batchId, receipt.messages.length);
  const releaseMigration = await migration;
  assert.equal(calls, 1); assert.equal(gate.hasActiveWrites(), false);
  releaseMigration();
  await assert.rejects(writer.withExclusiveWorkspaceDatabase("stale-batch", f.workspaceId, () => { calls++; }, input.batchId), /CLIENT_DB_WRITER_INDEX_OWNER_INVALID/u);
  assert.equal(calls, 1);
});

test("已提交但未索引的正文仍计入容量，禁止累积无限回执", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, maxPendingEvents: 1, onFatalError() {} }); f.own(writer);
  await writer.ready(); await writer.submit(batch(f.workspaceId, "retained"));
  const overflow = writer.submit(batch(f.workspaceId, "overflow"));
  const result = await Promise.race([overflow.then(() => "accepted", () => "rejected"),
    new Promise<string>(resolve => setImmediate(() => resolve("queued")))]);
  await writer.completeIndexes(f.workspaceId, "retained", 1);
  if (result === "queued") { await overflow; await writer.completeIndexes(f.workspaceId, "overflow", 1); }
  assert.equal(result, "rejected");
});

test("关闭等待已准入批次及其索引而非提前关闭Worker", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError() {} }); f.own(writer);
  await writer.ready();
  const accepted = writer.submit(batch(f.workspaceId, "closing"));
  const indexed = accepted.then(receipt => writer.completeIndexes(f.workspaceId, "closing", receipt.messages.length));
  await Promise.all([indexed, writer.close()]);
  assert.deepEqual(f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get(), { count: 1 });
});

test("同一ClientDb禁止第二个Writer，关闭排空已接收的全部legacy段", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  assert.throws(() => new Writer({ dbPath: f.dbPath, db: f.db, onFatalError() {} }), /CLIENT_DB_WRITER_OWNER_CONFLICT/u);
  const order: number[] = [];
  const reads = [1, 2, 3].map(value => writer.withLegacyDatabase(`accepted:${value}`, () => {
    f.db.workspaces.list(); order.push(value);
  }));
  await Promise.all([...reads, writer.close()]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("同工作区各回合轮转且回合内FIFO，连续积压不会挡住另一回合", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const inputs = ["a1", "a2", "a3", "b1"].map(id => {
    const input = batch(f.workspaceId, id);
    input.events[0]!.event.clientTurnId = id.startsWith("a") ? "turn-a" : "turn-b";
    return input;
  });
  const order: string[] = [];
  await Promise.all(inputs.map(async input => {
    const receipt = await writer.submit(input); order.push(input.batchId);
    await writer.completeIndexes(f.workspaceId, input.batchId, receipt.messages.length);
  }));
  assert.deepEqual(order, ["a1", "b1", "a2", "a3"]);
});

test("提交ACK丢失后新Worker按原batch恢复，不重写正文", async t => {
  const f = fixture(t), Writer = await writerClass();
  const failures: Error[] = [];
  const first = new Writer({ dbPath: f.dbPath, db: f.db, timeoutMs: 3_000, onFatalError(error) { failures.push(error); } });
  await first.ready();
  const onMessage = (first as any).onMessage.bind(first);
  let committedSeq = 0;
  t.mock.method(first as any, "onMessage", (message: any) => {
    if (message.type === "result" && message.receipt) { committedSeq = message.receipt.messages[0].event.seq; return; }
    onMessage(message);
  });
  const input = batch(f.workspaceId, "lost-ack");
  await assert.rejects(first.submit(input), /CLIENT_DB_WRITER_ACK_TIMEOUT/u);
  await assert.rejects(first.close(), /CLIENT_DB_WRITER_ACK_TIMEOUT/u);
  assert.equal(failures.length, 1); assert.ok(committedSeq > 0);
  const recovered = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(recovered);
  await recovered.ready();
  const receipt = await recovered.submit(input);
  assert.equal(receipt.messages[0]!.event.seq, committedSeq);
  await recovered.completeIndexes(f.workspaceId, input.batchId, 1);
  assert.deepEqual(await recovered.withLegacyDatabase("ack-recovery", () =>
    f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get()), { count: 1 });
});

test("Reader真实持有DELETE读事务时legacy异步等待，主线程不进入busy等待", async t => {
  const f = fixture(t), Writer = await writerClass(), marker = path.join(f.root, "read-active");
  const workerPath = path.join(f.root, "reader-hold.cjs");
  fs.writeFileSync(workerPath, `const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite'); const fs=require('node:fs'); const path=require('node:path');
parentPort.on('message', m=>{ if(m.type==='close'){parentPort.postMessage({type:'closed',commandId:m.commandId});parentPort.close();return;}
const db=new DatabaseSync(m.source.dbPath,{readOnly:true}); db.exec('BEGIN'); db.prepare('SELECT id FROM threads').all();
const marker=path.join(path.dirname(workerData.dbPath),'read-active'); fs.writeFileSync(marker,'active');
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200); db.exec('COMMIT');db.close();fs.unlinkSync(marker);
parentPort.postMessage({type:'result',commandId:m.commandId,requestId:m.requestId,timings:{queueMs:0,dbMs:200},result:{intakes:[],hasMore:false,nextCursor:null,statusCounts:[],totalCount:0,listMetaById:{},listPageMeta:{totalCount:0,cursorScope:'test'}}}); });
parentPort.postMessage({type:'ready',schemaVersion:${CLIENT_DB_SCHEMA_VERSION}});`, "utf8");
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, workerPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource: id => f.db.acquireWorkspaceReaderSource(id) });
  await reader.ready();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, reader, onFatalError(error) { throw error; } });
  f.own({ async close() { await reader.close(); await writer.close(); } }); await writer.ready();
  const reading = reader.listIntakes({ requestId: "held-reader", workspaceId: f.workspaceId });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(marker), true);
  await writer.withLegacyDatabase("wait-real-reader", () => {
    assert.equal(fs.existsSync(marker), false);
    assert.equal(f.db.applicationDb.pragma("busy_timeout", { simple: true }), 0);
    f.db.forWorkspace(f.workspaceId).threads.rename("thread", "读事务结束");
  });
  await reading;
});

test("协调范围外的W写锁明确失败并保持原正文，不能同步等待十秒", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const external = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"));
  try {
    external.exec("BEGIN EXCLUSIVE");
    await assert.rejects(writer.withLegacyDatabase("external-write-lock", () => f.db.forWorkspace(f.workspaceId).threads.rename("thread", "不应写入")));
    external.exec("ROLLBACK");
  } finally { external.close(); }
  assert.equal(await writer.withLegacyDatabase("verify-lock-failure", () => f.db.forWorkspace(f.workspaceId).threads.get("thread")?.title), "会话");
});

test("独立reader短暂持锁时原批副作用异步等待且仅执行一次，管线可正常关闭", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  t.after(() => reader.close());
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  let callbacks = 0, published = 0, ticks = 0, released = false, releaseReader: ReturnType<typeof setTimeout> | undefined;
  const failures: unknown[] = [];
  const pulse = setInterval(() => { ticks++; }, 5);
  const pipeline = createLocalEventPipeline({ writer, apply() {}, publish() { published++; }, onFailure(error) { failures.push(error); },
    async applyBatch(receipt) {
      reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM raw_engine_events").get();
      releaseReader = setTimeout(() => { reader.exec("ROLLBACK"); released = true; }, 75);
      await writer.withExclusiveWorkspaceDatabase(`effects:${receipt.batchId}`, f.workspaceId, () => {
        assert.equal(released, true);
        core.applyBatchEffects(f.workspaceId, receipt.batchId, () => { callbacks++; }, true);
      });
    },
  });
  try {
    pipeline.enqueue(batch(f.workspaceId).events[0]!, "turn", 1);
    await pipeline.flush();
    assert.equal(callbacks, 1); assert.equal(published, 1); assert.deepEqual(failures, []); assert.ok(ticks > 1);
    const rows = await writer.withLegacyDatabase("verify-exclusive", () => f.db.forWorkspace(f.workspaceId).db.prepare(
      "SELECT value FROM meta WHERE key LIKE 'local_event_batch:%'").all()) as Array<{ value: string }>;
    assert.equal(rows.length, 1);
    const receipt = JSON.parse(rows[0]!.value);
    assert.equal(receipt.confirmed, true); assert.equal(receipt.indexedCount, 1); assert.equal(receipt.seqs.length, 1);
    await pipeline.close(); await writer.close();
  } finally {
    clearInterval(pulse); clearTimeout(releaseReader);
    if (!released && releaseReader) reader.exec("ROLLBACK");
    reader.close();
  }
});

test("exclusive副作用长锁有界失败，释放后可再准入且不伪造已执行", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, lockTimeoutMs: 60, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  t.after(() => reader.close());
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  let calls = 0;
  try {
    await assert.rejects(writer.withExclusiveWorkspaceDatabase("locked-effects", f.workspaceId, () => { calls++; }), (error: any) => {
      assert.equal(error.code, "CLIENT_DB_LOCK_TIMEOUT"); assert.equal(error.requestId, "locked-effects");
      assert.equal(error.workspaceId, f.workspaceId); assert.equal(error.sqliteCode, 5); assert.equal(error.phase, "exclusive-acquire");
      return true;
    });
    assert.equal(calls, 0);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  await writer.withExclusiveWorkspaceDatabase("after-lock", f.workspaceId, () => { calls++; });
  assert.equal(calls, 1);
});

test("关闭超时终止Writer后，锁等待任务不能迟到执行副作用", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, timeoutMs: 1500, lockTimeoutMs: 5000,
    onFatalError(error) { throw error; } });
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  let waiting!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  t.mock.method(logger, "warn", () => { waiting(); });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  const pending = writer.withExclusiveWorkspaceDatabase("late-after-close", f.workspaceId, () => {
    calls++; f.db.forWorkspace(f.workspaceId).threads.rename("thread", "must-not-run");
  });
  const result = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  try {
    await started;
    await assert.rejects(writer.close(), /CLIENT_DB_WRITER_DRAIN_TIMEOUT/u);
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  const settled = await result;
  assert.equal(settled.ok, false, "关闭结束后旧操作必须拒绝");
  assert.equal(calls, 0);
  assert.equal(f.db.forWorkspace(f.workspaceId).threads.get("thread")?.title, "会话");
});

test("正常关闭仍等待已准入的锁等待任务完成，不把closing当作失败", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  let waiting!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  t.mock.method(logger, "warn", () => { waiting(); });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  const pending = writer.withExclusiveWorkspaceDatabase("drain-accepted-lock-wait", f.workspaceId, () => { calls++; });
  await started;
  const closing = writer.close();
  reader.exec("ROLLBACK"); reader.close();
  await Promise.all([pending, closing]);
  assert.equal(calls, 1);
});

test("Worker故障发生在锁等待期间，释放读锁不能让旧操作继续", async t => {
  const f = fixture(t), Writer = await writerClass(), fatal: Error[] = [];
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { fatal.push(error); } });
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  let waiting!: () => void, calls = 0;
  const started = new Promise<void>(resolve => { waiting = resolve; });
  t.mock.method(logger, "warn", () => { waiting(); });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  const pending = writer.withExclusiveWorkspaceDatabase("late-after-fatal", f.workspaceId, () => { calls++; });
  const result = pending.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  try {
    await started;
    await (writer as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
  } finally { reader.exec("ROLLBACK"); reader.close(); }
  const settled = await result;
  assert.equal(fatal.length, 1);
  assert.equal(settled.ok, false);
  if (!settled.ok) assert.equal(settled.error, fatal[0]);
  assert.equal(calls, 0);
  await assert.rejects(writer.close(), error => error === fatal[0]);
});

test("锁等待预算在唤醒前耗尽时，即使读锁刚释放也不能再执行业务", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, lockTimeoutMs: 60, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  let now = Date.now(), calls = 0, released = false;
  t.mock.method(Date, "now", () => now);
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  let release: ReturnType<typeof setTimeout> | undefined;
  t.mock.method(logger, "warn", () => {
    release = setTimeout(() => { now += 100; reader.exec("ROLLBACK"); released = true; }, 5);
  });
  try {
    await assert.rejects(writer.withExclusiveWorkspaceDatabase("expired-before-retry", f.workspaceId, () => { calls++; }),
      (error: any) => error.code === "CLIENT_DB_LOCK_TIMEOUT");
    assert.equal(calls, 0);
  } finally { clearTimeout(release); if (!released) reader.exec("ROLLBACK"); reader.close(); }
});

test("锁等待诊断失败保留原锁和日志双错，不执行后续副作用", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  const failure = new Error("log failed");
  t.mock.method(logger, "warn", () => { throw failure; });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM threads").get();
  try {
    await assert.rejects(writer.withExclusiveWorkspaceDatabase("lock-diagnostic", f.workspaceId, () => {
      assert.fail("诊断失败后不得执行业务");
    }), (error: any) => {
      assert.ok(error instanceof AggregateError); assert.equal(error.message, "CLIENT_DB_LOCK_DIAGNOSTIC_FAILED");
      assert.equal(error.errors[1], failure);
      const lock = error.errors[0] as { code: string; errcode: number };
      assert.equal(lock.code, "ERR_SQLITE_ERROR"); assert.equal(lock.errcode, 5);
      return true;
    });
  } finally { reader.exec("ROLLBACK"); reader.close(); }
});

test("锁超时保留未完成批次，受控关闭不伪报Worker崩溃，重启沿原回执恢复", async t => {
  const f = fixture(t), Writer = await writerClass(), fatal: Error[] = [];
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, lockTimeoutMs: 40, onFatalError(error) { fatal.push(error); } });
  await writer.ready();
  const input = batch(f.workspaceId, "lock-recovery"), core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  const committed = await writer.submit(input);
  const reader = openSqliteDb(path.join(f.root, ".codeflowai", "workspace.db"), { readonly: true, busyTimeoutMs: 0 });
  reader.exec("BEGIN"); reader.prepare("SELECT COUNT(*) FROM raw_engine_events").get();
  let failure: unknown, calls = 0;
  try {
    await writer.withExclusiveWorkspaceDatabase("lock-recovery-effects", f.workspaceId, () => {
      core.applyBatchEffects(f.workspaceId, input.batchId, () => { calls++; }, true);
    });
    assert.fail("持锁期间不得完成副作用");
  } catch (error) { failure = error; }
  finally { reader.exec("ROLLBACK"); reader.close(); }
  assert.equal((failure as { code: string }).code, "CLIENT_DB_LOCK_TIMEOUT");
  writer.failIndexes(f.workspaceId, input.batchId, failure);
  await assert.rejects(writer.close(), error => error === failure);
  assert.deepEqual(fatal, [], "主动终止清理保留原失败，不追加意外Worker退出");
  const recovered = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(recovered);
  await recovered.ready();
  const original = await recovered.withLegacyDatabase("read-original-receipt", () => core.readPendingBatch(f.workspaceId));
  assert.equal(original?.batchId, input.batchId);
  const replay = await recovered.submit(original!);
  assert.deepEqual(replay.messages, committed.messages);
  await recovered.withExclusiveWorkspaceDatabase("recover-effects", f.workspaceId, () => {
    core.applyBatchEffects(f.workspaceId, input.batchId, () => { calls++; }, true);
  });
  await recovered.completeIndexes(f.workspaceId, input.batchId, replay.messages.length);
  await recovered.confirmBatch(f.workspaceId, input.batchId);
  assert.equal(calls, 1);
  assert.equal(await recovered.withLegacyDatabase("verify-recovered-body", () => f.db.forWorkspace(f.workspaceId).db.prepare("SELECT COUNT(*) AS count FROM raw_engine_events").get().count), 1);
});

for (const failure of [new Error("business failed"), Object.assign(new Error("native callback lock"), { code: "ERR_SQLITE_ERROR", errcode: 5 }),
  new AggregateError([Object.assign(new Error("lock"), { code: "ERR_SQLITE_ERROR", errcode: 5 }), new Error("rollback failed")], "SQLITE_TRANSACTION_ROLLBACK_FAILED")]) {
  test(`exclusive回调开始后的失败不重放：${failure.message}`, async t => {
    const f = fixture(t), Writer = await writerClass();
    const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
    await writer.ready();
    let calls = 0;
    await assert.rejects(writer.withExclusiveWorkspaceDatabase("effects-failure", f.workspaceId, () => {
      calls++; f.db.forWorkspace(f.workspaceId).threads.rename("thread", "rolled-back"); throw failure;
    }), error => error === failure);
    assert.equal(calls, 1);
    assert.equal(await writer.withLegacyDatabase("verify-effects-rollback", () => f.db.forWorkspace(f.workspaceId).threads.get("thread")?.title), "会话");
  });
}

test("ACK与touch后台缓冲通过短许可提交，flush等待真实写入", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const options = { withLegacyDatabase: <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation) };
  const canonical = createConversationEventAckBuffer(f.db, options);
  const raw = createRawEventAckBuffer(f.db, options);
  const touches = createThreadTouchBuffer(f.db, options);
  canonical.enqueue({ schema: 1, seq: 100, ts: 100, workspaceId: f.workspaceId, threadId: "thread", engine: "claude", type: "thread.started", payload: {} });
  raw.enqueue({ ...batch(f.workspaceId).events[0]!.event, schema: 1, seq: 101 });
  touches.enqueue("thread", Date.now() + 1000, { workspaceId: f.workspaceId });
  await canonical.flush(); await raw.flush(); await touches.flush();
  await canonical.dispose(); await raw.dispose(); await touches.dispose();
  assert.equal(await writer.withLegacyDatabase("verify-buffers", () => f.db.forWorkspace(f.workspaceId).conversationEvents.getLatestSeq()), 100);
});

test("清理后台每批取得短许可，迁移快照离开许可后再释放会话", async t => {
  const f = fixture(t), Writer = await writerClass(), gate = new WorkspaceOperationGate();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const withLegacyDatabase = <T>(requestId: string, operation: () => T) => writer.withLegacyDatabase(requestId, operation);
  let disposedThread = false;
  const callbacks = createWorkspaceMigrationRuntimeCallbacks({ db: f.db, gate, withLegacyDatabase,
    sessions: { async disposeThread() { assert.throws(() => f.db.workspaces.list(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/u); disposedThread = true; } },
    pathIndex: { upsertWorkspace() {} }, onWorkspacesChanged() {} });
  await callbacks.disposeWorkspaceSessions(f.workspaceId);
  assert.equal(disposedThread, true);
  const cleanup = new ClientDbCleanupService({ db: f.db, dbPath: f.dbPath, withLegacyDatabase,
    flushEventPersistence() {}, async beginThreadCleanup() { return () => undefined; }, onThreadHistoryCleaned() {}, batchDelayMs: 0 });
  assert.equal(typeof cleanup.startAsync, "function", "缺少协调后的清理启动入口");
  try {
    await cleanup.startAsync({ inactiveBefore: Date.now() - 1, requestId: "coordinated-cleanup" });
    const deadline = Date.now() + 5_000;
    while (cleanup.isRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await cleanup.getStorageSummaryAsync()).cleanup.status, "completed");
  } finally { cleanup.dispose(); }
});

test("Worker后置数据库索引按批原子更新turn与进度，正文失败证据独立保留", async t => {
  const f = fixture(t), Writer = await writerClass();
  const writer = new Writer({ dbPath: f.dbPath, db: f.db, onFatalError(error) { throw error; } }); f.own(writer);
  await writer.ready();
  const input = { batchId: "turn-index-batch", workspaceId: f.workspaceId, ownerGeneration: 1, turnId: "turn-index", events: [
    { t: "conversation.event" as const, event: { ts: 100, workspaceId: f.workspaceId, threadId: "thread", engine: "claude" as const,
      type: "turn.started" as const, payload: { turnId: "turn-index" } } },
    { t: "conversation.event" as const, event: { ts: 101, workspaceId: f.workspaceId, threadId: "thread", engine: "claude" as const,
      type: "item.userMessage.created" as const, payload: { turnId: "turn-index", itemId: "user-index", text: "原始输入" } } },
  ] };
  const receipt = await writer.submit(input);
  assert.equal(await writer.withLegacyDatabase("body-not-indexed", () => f.db.forWorkspace(f.workspaceId).turns.get("turn-index")), null);
  await writer.indexDatabase(f.workspaceId, receipt.batchId);
  const row = await writer.withLegacyDatabase("verify-db-index", () => f.db.forWorkspace(f.workspaceId).turns.get("turn-index"));
  assert.equal(row?.userText, "原始输入");
  await writer.indexDatabase(f.workspaceId, receipt.batchId);
  await writer.completeIndexes(f.workspaceId, receipt.batchId, receipt.messages.length);
});
