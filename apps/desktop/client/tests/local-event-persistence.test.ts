import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationEventInput, RawEngineEventInput, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { createLocalEventPersistence, createLocalEventPipeline } from "../src/runtime/localEventPersistence.js";
import { createLocalEventRelay } from "../src/runtime/localEventRelay.js";
import { createRollbackEvidenceFence } from "../src/app/rollbackEvidenceFence.js";
import { createLocalEventDatabaseIndex } from "../src/runtime/localEventIndex.js";
import { freezeFileAfterSnapshot, freezeFileBeforeSnapshot } from "../src/eventIndex/fileChangeSnapshots.js";

const workspaceId = "local-events:workspace" as WorkspaceId;
const threadId = "thread-local-events" as ThreadId;
const canonical: ConversationEventInput = {
  ts: 1_800_000_000_000, workspaceId, threadId, engine: "codex",
  type: "turn.started", payload: { turnId: "turn-local-events" as any },
};
const raw: RawEngineEventInput = {
  ts: canonical.ts, workspaceId, threadId, engine: "codex", source: "local-test",
  data: {}, handled: true, action: "mapped", emittedTypes: [],
};

test("文件before冻结跨结构化传输与耐久恢复保持原内容", t => {
  const { db } = setup(t);
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId: canonical.payload.turnId, startedAt: 1, startEventSeq: null });
  const workspacePath = db.workspaces.get(workspaceId)!.path;
  const file = path.join(workspacePath, "before.txt");
  fs.writeFileSync(file, "冻结前内容", "utf8");
  const frozen = freezeFileBeforeSnapshot({ workspacePath, workspaceId, threadId, turnId: canonical.payload.turnId, path: "before.txt", capturedAt: 1 });
  fs.writeFileSync(file, "工具已修改", "utf8");
  const input = { batchId: "frozen-before", workspaceId, ownerGeneration: 1, turnId: canonical.payload.turnId,
    events: [{ t: "conversation.event" as const, event: canonical, beforeSnapshots: [frozen] }] };
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  persistence.commitBatch(structuredClone(input));
  const pending = persistence.readPendingBatch(workspaceId)!;
  assert.deepEqual(pending.events, input.events);
  const row = db.fileChanges.get(threadId, canonical.payload.turnId, "before.txt")!;
  assert.ok(row.beforeBlobId);
  assert.equal(db.blobs.get(row.beforeBlobId)!.data.toString("utf8"), "冻结前内容");
});

test("重启恢复未索引的工具完成事件缺真实after证据时拒绝确认", t => {
  const { db, reader } = setup(t);
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const started = { batchId: "confirmed-tool-started", workspaceId, ownerGeneration: 1, turnId: canonical.payload.turnId,
    events: [{ t: "conversation.event" as const, event: { ...canonical, type: "item.tool.started", payload: {
      itemId: "write-file", toolName: "Write", input: { file_path: "before.txt" },
    } } as ConversationEventInput }] };
  persistence.commitBatch(started);
  persistence.completeBatchIndexes(workspaceId, started.batchId, 1);
  persistence.confirmBatch(workspaceId, started.batchId);
  const completion = { batchId: "pending-tool-completed", workspaceId, ownerGeneration: 1, turnId: canonical.payload.turnId,
    events: [{ t: "conversation.event" as const, event: { ...canonical, type: "item.tool.completed", payload: {
      itemId: "write-file", toolName: "Write", status: "completed",
    } } as ConversationEventInput }] };
  persistence.commitBatch(completion);
  const restarted = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  assert.equal(restarted.readPendingBatch(workspaceId)?.batchId, completion.batchId);
  let applied = 0;
  assert.throws(() => restarted.applyBatchEffects(workspaceId, completion.batchId, () => { applied++; }), /LOCAL_EVENT_FILE_EFFECT_EVIDENCE_MISSING/u);
  assert.equal(applied, 0);
  assert.throws(() => restarted.readReadyThroughSeq(workspaceId), /LOCAL_EVENT_INDEX_PENDING/u);
  assert.equal((reader.prepare("SELECT count(*) AS count FROM conversation_events WHERE type='item.tool.completed'").get() as any).count, 1);
});

test("完成时冻结的after在重启和文件继续变化后仍保存真实内容及精确turn", t => {
  const { db } = setup(t);
  const turnId = canonical.payload.turnId;
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null });
  const workspacePath = db.workspaces.get(workspaceId)!.path;
  const file = path.join(workspacePath, "frozen-after.txt");
  fs.writeFileSync(file, "原始内容", "utf8");
  const before = freezeFileBeforeSnapshot({ workspacePath, workspaceId, threadId, turnId, path: "frozen-after.txt", capturedAt: 1 });
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const started = { batchId: "before-confirmed", workspaceId, ownerGeneration: 1, turnId,
    events: [{ t: "conversation.event" as const, event: canonical, beforeSnapshots: [before] }] };
  persistence.commitBatch(started);
  persistence.completeBatchIndexes(workspaceId, started.batchId, 1);
  persistence.confirmBatch(workspaceId, started.batchId);
  fs.writeFileSync(file, "工具完成的内容", "utf8");
  const after = freezeFileAfterSnapshot({ workspacePath, workspaceId, threadId, turnId, path: "frozen-after.txt", capturedAt: 2,
    itemId: "write-file", changeKind: "modify", diffText: "diff", toolStatus: "completed" });
  const completion = { batchId: "after-pending", workspaceId, ownerGeneration: 1, turnId,
    events: [{ t: "conversation.event" as const, event: { ...canonical, type: "item.tool.completed", payload: {
      itemId: "write-file", toolName: "Write", status: "completed",
    } } as ConversationEventInput, afterSnapshots: [after] }] };
  persistence.commitBatch(completion);
  fs.writeFileSync(file, "重启后其他操作的内容", "utf8");
  const restarted = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  assert.deepEqual(restarted.readPendingBatch(workspaceId)?.events, completion.events);
  restarted.applyBatchEffects(workspaceId, completion.batchId, () => {});
  const row = db.fileChanges.get(threadId, turnId, "frozen-after.txt")!;
  assert.equal(db.blobs.get(row.beforeBlobId!)!.data.toString("utf8"), "原始内容");
  assert.equal(db.blobs.get(row.afterBlobId!)!.data.toString("utf8"), "工具完成的内容");
  assert.notEqual(row.afterBlobId, row.beforeBlobId);
});

test("冻结after的归属冲突或before遗失不会确认或读取重启后的文件", t => {
  const { db } = setup(t);
  const turnId = canonical.payload.turnId;
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null });
  const workspacePath = db.workspaces.get(workspaceId)!.path;
  fs.writeFileSync(path.join(workspacePath, "missing-before.txt"), "完成时的内容", "utf8");
  const after = freezeFileAfterSnapshot({ workspacePath, workspaceId, threadId, turnId, path: "missing-before.txt", capturedAt: 2,
    itemId: "write-file", changeKind: "modify", diffText: null });
  const completion = { ...canonical, type: "item.tool.completed", payload: {
    itemId: "write-file", toolName: "Write", status: "completed",
  } } as ConversationEventInput;
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  persistence.commitBatch({ batchId: "missing-before", workspaceId, ownerGeneration: 1, turnId,
    events: [{ t: "conversation.event", event: completion, afterSnapshots: [after] }] });
  assert.throws(() => persistence.applyBatchEffects(workspaceId, "missing-before", () => {}), /LOCAL_EVENT_FILE_BEFORE_EVIDENCE_MISSING/u);
  assert.throws(() => persistence.readReadyThroughSeq(workspaceId), /LOCAL_EVENT_INDEX_PENDING/u);
  assert.equal(db.fileChanges.get(threadId, turnId, "missing-before.txt"), null);
  const row = db.db.prepare("SELECT value FROM meta WHERE key=?").get("local_event_batch:missing-before") as { value: string };
  const receipt = JSON.parse(row.value);
  receipt.pendingEvents[0].afterSnapshots[0].turnId = "another-turn";
  db.db.prepare("UPDATE meta SET value=? WHERE key=?").run(JSON.stringify(receipt), "local_event_batch:missing-before");
  assert.throws(() => persistence.applyBatchEffects(workspaceId, "missing-before", () => {}), /LOCAL_EVENT_SNAPSHOT_SCOPE_INVALID/u);
});

test("只读完成事件无需文件快照且已索引旧完成批次不会被恢复校验误拒", t => {
  const { db } = setup(t);
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const event = { ...canonical, type: "item.tool.completed", payload: { itemId: "read-file", toolName: "Read", status: "completed" } } as ConversationEventInput;
  persistence.commitBatch({ batchId: "readonly", workspaceId, ownerGeneration: 1,
    events: [{ t: "conversation.event", event, afterSnapshots: [] }] });
  persistence.applyBatchEffects(workspaceId, "readonly", () => {});
  persistence.confirmBatch(workspaceId, "readonly");
  persistence.commitBatch({ batchId: "old-indexed", workspaceId, ownerGeneration: 1,
    events: [{ t: "conversation.event", event }] });
  persistence.completeBatchIndexes(workspaceId, "old-indexed", 1);
  persistence.applyBatchEffects(workspaceId, "old-indexed", () => { assert.fail("已索引批次不应再执行owner"); });
  persistence.confirmBatch(workspaceId, "old-indexed");
  assert.equal(persistence.readPendingBatch(workspaceId), null);
});

test("子工具完成时无法读取after会明确失败且不以旧before假装after", t => {
  const { db } = setup(t);
  const turnId = canonical.payload.turnId;
  db.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null });
  const workspacePath = db.workspaces.get(workspaceId)!.path;
  const file = path.join(workspacePath, "child.txt");
  fs.writeFileSync(file, "子工具之前", "utf8");
  const before = freezeFileBeforeSnapshot({ workspacePath, workspaceId, threadId, turnId, path: "child.txt", capturedAt: 1 });
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const started = { batchId: "child-before", workspaceId, ownerGeneration: 1, turnId,
    events: [{ t: "conversation.event" as const, event: canonical, beforeSnapshots: [before] }] };
  persistence.commitBatch(started);
  persistence.completeBatchIndexes(workspaceId, started.batchId, 1);
  persistence.confirmBatch(workspaceId, started.batchId);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  const after = freezeFileAfterSnapshot({ workspacePath, workspaceId, threadId, turnId, path: "child.txt", capturedAt: 2,
    itemId: "sub_write-file", changeKind: "modify", diffText: null });
  assert.equal(after.result.ok, false);
  const event = { ...canonical, type: "item.subagent.childEvent", payload: {
    innerEventType: "item.tool.completed", innerPayload: { itemId: "write-file", toolName: "Write", status: "completed" },
  } } as ConversationEventInput;
  persistence.commitBatch({ batchId: "child-after", workspaceId, ownerGeneration: 1, turnId,
    events: [{ t: "conversation.event", event, afterSnapshots: [after] }] });
  assert.throws(() => persistence.applyBatchEffects(workspaceId, "child-after", () => {}), /LOCAL_EVENT_FILE_AFTER_EVIDENCE_UNAVAILABLE/u);
  assert.equal(persistence.readPendingBatch(workspaceId)?.batchId, "child-after");
  assert.throws(() => persistence.readReadyThroughSeq(workspaceId), /LOCAL_EVENT_INDEX_PENDING/u);
});

test("跨批次Codex映射在索引owner重启后仍可恢复且事务回滚不丢失", t => {
  const { db } = setup(t);
  const persistence = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  const rawBatch = { batchId: "pending-provider", workspaceId, ownerGeneration: 1, events: [{ t: "raw.event" as const,
    event: { ...raw, clientTurnId: canonical.payload.turnId, source: "codex.app-server.msg",
      data: { method: "turn/started", params: { turn: { id: "provider-pending" } } } } }] };
  persistence.commitBatch(rawBatch);
  persistence.indexDatabase(workspaceId, rawBatch.batchId, createLocalEventDatabaseIndex());
  persistence.completeBatchIndexes(workspaceId, rawBatch.batchId, 1);
  const next = { batchId: "canonical-provider", workspaceId, ownerGeneration: 1, events: [{ t: "conversation.event" as const, event: canonical }] };
  persistence.commitBatch(next);
  const apply = createLocalEventDatabaseIndex();
  assert.throws(() => persistence.indexDatabase(workspaceId, next.batchId, (scoped, event) => {
    apply(scoped, event); throw new Error("INJECTED_INDEX_FAILURE");
  }), /INJECTED_INDEX_FAILURE/u);
  assert.equal(db.turns.get(canonical.payload.turnId), null);
  persistence.indexDatabase(workspaceId, next.batchId, createLocalEventDatabaseIndex());
  assert.equal(JSON.parse(db.turns.get(canonical.payload.turnId)?.engineCheckpointJson ?? "{}").codexProviderTurn?.engineTurnId, "provider-pending");
  persistence.completeBatchIndexes(workspaceId, next.batchId, 1);
});

/** 使用第二个只读连接确认索引看到的是已提交事件，而非事务内临时状态。 */
function setup(t: test.TestContext, localCanonicalEvents = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-local-events-"));
  const dbPath = path.join(directory, "client.db");
  const application = openClientDb({ dbPath, localCanonicalEvents });
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: directory });
  const db = application.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Local" });
  const reader = openSqliteDb(path.join(directory, ".codeflowai", "workspace.db"), { readonly: true });
  t.after(() => { reader.close(); db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { db, reader };
}

test("local canonical and raw commit before their existing index callbacks", (t) => {
  const { db, reader } = setup(t);
  const indexed: number[] = [];
  const writer = createLocalEventPersistence({
    db,
    applyConversation(event) {
      assert.deepEqual(reader.prepare("SELECT seq FROM conversation_events").get(), { seq: event.seq });
      indexed.push(event.seq);
    },
    applyRaw(event) {
      assert.deepEqual(reader.prepare("SELECT seq FROM raw_engine_events").get(), { seq: event.seq });
      indexed.push(event.seq);
    },
  });
  const first = writer.persist({ t: "conversation.event", event: canonical });
  const second = writer.persist({ t: "raw.event", event: raw });
  assert.equal(first.event.schema, 1);
  assert.ok(second.event.seq > first.event.seq);
  assert.deepEqual(indexed, [first.event.seq, second.event.seq]);
});

test("local event commit and post-commit indexing use one short workspace connection", t => {
  const { db, reader } = setup(t);
  const prototype = Object.getPrototypeOf(db.applicationDb), exec = prototype.exec;
  let triggerExecs = 0;
  t.mock.method(prototype, "exec", function (this: typeof db.applicationDb, sql: string) {
    if (/CREATE TEMP TRIGGER/iu.test(sql)) triggerExecs++;
    return exec.call(this, sql);
  });
  const writer = createLocalEventPersistence({ db,
    applyConversation(event) {
      assert.deepEqual(reader.prepare("SELECT seq FROM conversation_events").get(), { seq: event.seq });
      assert.equal(db.threads.get(threadId)?.workspaceId, workspaceId);
      assert.equal(db.conversationEvents.getLatestSeq(), event.seq);
    },
    applyRaw(event) {
      assert.deepEqual(reader.prepare("SELECT seq FROM raw_engine_events").get(), { seq: event.seq });
      assert.equal(db.threads.get(threadId)?.workspaceId, workspaceId);
    },
  });
  writer.persist({ t: "conversation.event", event: canonical });
  assert.equal(triggerExecs, 1);
  writer.persist({ t: "raw.event", event: raw });
  assert.equal(triggerExecs, 2);
});

test("事件提交后的发布归属读取共享同步连接且失败保持已提交证据", t => {
  const { db, reader } = setup(t);
  const prototype = Object.getPrototypeOf(db.applicationDb), close = prototype.close;
  let closes = 0;
  t.mock.method(prototype, "close", function (this: typeof db.applicationDb) { closes++; return close.call(this); });
  const writer = createLocalEventPersistence({ db, applyConversation() {}, applyRaw() {} });
  db.withWorkspaceCoreRepos(workspaceId, () => {
    const committed = writer.persist({ t: "conversation.event", event: canonical });
    assert.equal(db.threads.get(threadId)?.workspaceId, workspaceId);
    assert.deepEqual(reader.prepare("SELECT seq FROM conversation_events").get(), { seq: committed.event.seq });
    assert.equal(closes, 0);
  });
  assert.equal(closes, 1);
  const failure = new Error("publish-failed");
  assert.throws(() => db.withWorkspaceCoreRepos(workspaceId, () => {
    writer.persist({ t: "raw.event", event: raw });
    throw failure;
  }), error => error === failure);
  assert.equal(closes, 2);
  assert.equal((reader.prepare("SELECT count(*) AS count FROM raw_engine_events").get() as any).count, 1);
});

test("unassociated desktop persistence remains local and creates no relay work", (t) => {
  const { db } = setup(t, true);
  let indexed = 0;
  const writer = createLocalEventPersistence({ db, applyConversation() { indexed += 1; }, applyRaw() { indexed += 1; } });
  writer.persist({ t: "conversation.event", event: canonical });
  writer.persist({ t: "raw.event", event: raw });
  db.conversationEvents.deleteByThread(threadId);
  assert.equal(indexed, 2);
  assert.deepEqual(db.db.prepare("SELECT key FROM meta WHERE key LIKE 'conversation_relay:%'").all(), []);
});

test("remote delivery ACK never repeats the existing local index callback", async (t) => {
  const { db } = setup(t, true);
  db.db.prepare("UPDATE threads SET shared_workspace_id = 'shared-a' WHERE id = ?").run(threadId);
  let indexed = 0;
  const writer = createLocalEventPersistence({ db, applyConversation() { indexed += 1; }, applyRaw() {} });
  let delivery: unknown;
  const relay = createLocalEventRelay({ db, serverUrl: "wss://server.test", ackTimeoutMs: 90_000,
    withDatabase: async operation => operation(), readReadyThroughSeq: async () => writer.readReadyThroughSeq(workspaceId),
    onError(error) { throw error; }, send(message) {
    if (message.t !== "conversation.event.relay") throw new Error("unexpected cleanup");
    delivery = message.delivery;
    return { accepted: true };
  } });
  t.after(() => relay.dispose());
  const scope = { userId: "user-a", enterpriseId: "enterprise-a", clientId: "local-events", bindingId: "binding-a",
    workspaceId, sharedWorkspaceId: "shared-a", hostScopeEpoch: 1 };
  relay.activate([scope], 1);
  await relay.setDemand({ requestId: "request", demandId: "demand", generation: 1, scope, kind: "conversation", recipientUserIds: ["user-a"] }, true, 1);
  const committed = writer.persist({ t: "conversation.event", event: canonical });
  await relay.flush();
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery, seqs: [committed.event.seq] }, 1), true);
  assert.equal(indexed, 1);
});

test("failed local event insertion retains its reserved counter and never indexes", (t) => {
  const { db } = setup(t);
  let indexed = 0;
  const writer = createLocalEventPersistence({ db, applyConversation() { indexed += 1; }, applyRaw() { indexed += 1; } });
  const before = db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get();
  db.db.exec("CREATE TRIGGER reject_local_event BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  assert.throws(() => writer.persist({ t: "conversation.event", event: canonical }), /disk failure/);
  assert.equal(indexed, 0);
  assert.equal(db.conversationEvents.getLatestSeq(), 0);
  assert.ok(Number((db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get() as any).value) > Number((before as any).value));
  db.db.exec("DROP TRIGGER reject_local_event");
  assert.equal(writer.persist({ t: "raw.event", event: raw }).t, "raw.event");
  assert.equal(indexed, 1);
});

test("local indexing failure remains explicit and retains the committed evidence", (t) => {
  const { db, reader } = setup(t);
  const failure = new Error("index unavailable");
  const writer = createLocalEventPersistence({ db, applyConversation() { throw failure; }, applyRaw() {} });
  assert.throws(() => writer.persist({ t: "conversation.event", event: canonical }), (error) => error === failure);
  assert.ok((reader.prepare("SELECT COUNT(*) AS count FROM conversation_events").get() as any).count === 1);
  assert.ok(Number((reader.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get() as any).value) > 0);
});

test("同批 raw/canonical 原子保存，提交回执重试不再分配序号或重复索引", t => {
  const { db, reader } = setup(t);
  const indexed: number[] = [];
  const writer = createLocalEventPersistence({ db, applyConversation(event) { indexed.push(event.seq); }, applyRaw(event) { indexed.push(event.seq); } });
  const batch = { batchId: "batch-durable", workspaceId, ownerGeneration: 1, events: [{ t: "raw.event" as const, event: raw }, { t: "conversation.event" as const, event: canonical }] };
  const first = writer.persistBatch(batch);
  assert.equal(first.messages.length, 2);
  assert.ok(first.messages[1]!.event.seq > first.messages[0]!.event.seq);
  assert.equal(first.indexedCount, 2);
  assert.equal(first.indexedThroughSeq, first.messages[1]!.event.seq);
  assert.deepEqual(indexed, first.messages.map(message => message.event.seq));
  const counter = db.applicationDb.prepare("SELECT value FROM meta WHERE key='event_seq'").get();
  assert.deepEqual(writer.persistBatch(batch), first);
  assert.deepEqual(db.applicationDb.prepare("SELECT value FROM meta WHERE key='event_seq'").get(), counter);
  assert.equal(indexed.length, 2);
  assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM raw_engine_events").get() as any).n, 1);
  assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM conversation_events").get() as any).n, 1);
  assert.throws(() => writer.persistBatch({ ...batch, events: [batch.events[0]!] }), /BATCH_CONFLICT/);
});

test("批次正文失败全部回滚但不收回A已预留序号", t => {
  const { db, reader } = setup(t);
  const writer = createLocalEventPersistence({ db, applyConversation() { assert.fail("must not index"); }, applyRaw() { assert.fail("must not index"); } });
  db.db.exec("CREATE TRIGGER reject_batch BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT, 'batch storage failure'); END");
  const before = db.applicationDb.prepare("SELECT value FROM meta WHERE key='event_seq'").get() as { value: string };
  assert.throws(() => writer.persistBatch({ batchId: "batch-failed", workspaceId, ownerGeneration: 1,
    events: [{ t: "raw.event", event: raw }, { t: "conversation.event", event: canonical }] }), /batch storage failure/);
  assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM raw_engine_events").get() as any).n, 0);
  assert.ok(Number((db.applicationDb.prepare("SELECT value FROM meta WHERE key='event_seq'").get() as any).value) > Number(before.value));
});

test("批次后置索引失败保正文且阻止后批，显式重试恢复原进度", t => {
  const { db, reader } = setup(t);
  let fail = true, indexedRaw = 0;
  const writer = createLocalEventPersistence({ db, applyRaw() { indexedRaw++; }, applyConversation() { if (fail) throw new Error("index failure"); } });
  const batch = { batchId: "batch-index", workspaceId, ownerGeneration: 1,
    events: [{ t: "raw.event" as const, event: raw }, { t: "conversation.event" as const, event: canonical }] };
  assert.throws(() => writer.persistBatch(batch), /index failure/);
  assert.equal((reader.prepare("SELECT COUNT(*) AS n FROM conversation_events").get() as any).n, 1);
  assert.throws(() => writer.persistBatch({ ...batch, batchId: "later-batch" }), /INDEX_PENDING/);
  fail = false;
  const receipt = writer.persistBatch(batch);
  assert.equal(receipt.indexedCount, 2);
  assert.equal(indexedRaw, 1, "已经完成的索引阶段不得重复执行");
});

test("提交后进程重建可从唯一pending回执找回正文，已删除正文不得复活", t => {
  const { db } = setup(t);
  const writer = createLocalEventPersistence({ db, applyRaw() {}, applyConversation() {} });
  const batch = { batchId: "recover-pending", workspaceId, ownerGeneration: 4, turnId: "turn-local-events",
    events: [{ t: "raw.event" as const, event: raw }] };
  writer.commitBatch(batch);
  const restarted = createLocalEventPersistence({ db, applyRaw() {}, applyConversation() {} });
  assert.deepEqual(restarted.readPendingBatch(workspaceId), batch);
  restarted.persistBatch(batch);
  assert.equal(restarted.readPendingBatch(workspaceId), null);
  db.rawEvents.deleteByThread(threadId);
  assert.throws(() => restarted.persistBatch(batch), /BATCH_REVOKED/);
});

test("异步提交管线按回合组批，正文确认前不索引或发布", async t => {
  const f = setup(t), calls: string[] = [];
  const core = createLocalEventPersistence({ db: f.db, applyRaw() {}, applyConversation() {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pipeline = createLocalEventPipeline({
    writer: {
      async submit(batch) { calls.push(`commit:${batch.events.length}`); await gate; return core.commitBatch(batch); },
      async completeIndexes(workspace, batchId, count) { calls.push("indexed"); return core.completeBatchIndexes(workspace, batchId, count); },
      async withLegacyDatabase(_requestId, operation) { return operation(); },
      failIndexes() { assert.fail("unexpected index failure"); },
    },
    apply(message) { calls.push(message.t); },
    publish() { calls.push("publish"); },
    onFailure(error) { assert.fail(String(error)); },
  });
  t.after(async () => { release(); await pipeline.close(); });
  pipeline.enqueue({ t: "raw.event", event: raw }, "turn-local-events", 1);
  pipeline.enqueue({ t: "conversation.event", event: canonical }, "turn-local-events", 1);
  const flushing = pipeline.flush(workspaceId, threadId);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["commit:2"]);
  release(); await flushing;
  assert.deepEqual(calls, ["commit:2", "raw.event", "indexed", "conversation.event", "indexed", "publish", "publish"]);
});

test("异步提交失败由原工作区owner显式保留，禁止后续发布", async t => {
  const failure = new Error("synthetic worker storage failure");
  const observed: unknown[] = [];
  const pipeline = createLocalEventPipeline({
    writer: {
      async submit() { throw failure; }, async completeIndexes() { assert.fail("must not index"); },
      async withLegacyDatabase(_requestId, operation) { return operation(); }, failIndexes() {},
    },
    apply() { assert.fail("must not apply"); }, publish() { assert.fail("must not publish"); },
    onFailure(error) { observed.push(error); },
  });
  pipeline.enqueue({ t: "raw.event", event: raw }, "turn-local-events", 1);
  await assert.rejects(pipeline.flush(workspaceId, threadId), error => error === failure);
  assert.deepEqual(observed, [failure]);
  assert.throws(() => pipeline.enqueue({ t: "raw.event", event: raw }, "turn-local-events", 1), error => error === failure);
  await assert.rejects(pipeline.close(), error => error === failure);
});

test("事件管线接近容量时等待慢写入，确认完成后恢复同步准入", async t => {
  const { db } = setup(t);
  const core = createLocalEventPersistence({ db, applyRaw() {}, applyConversation() {} });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let published = 0;
  const pipeline = createLocalEventPipeline({
    writer: {
      async submit(batch) { await gate; return core.commitBatch(batch); },
      async completeIndexes(workspace, batchId, count) { return core.completeBatchIndexes(workspace, batchId, count); },
      async withLegacyDatabase(_requestId, operation) { return operation(); },
      failIndexes() { assert.fail("unexpected index failure"); },
    },
    apply() {}, async applyBatch() {}, publish() { published++; }, onFailure(error) { assert.fail(String(error)); },
  });
  t.after(async () => { release(); await pipeline.close(); });
  assert.equal(pipeline.waitForCapacity(workspaceId), undefined);
  for (let index = 0; index < 2048; index++) pipeline.enqueue({ t: "raw.event", event: raw }, null, 1);
  const waiting = pipeline.waitForCapacity(workspaceId);
  assert.ok(waiting instanceof Promise);
  let settled = false;
  void waiting.then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(published, 0);
  release();
  await waiting;
  assert.equal(published, 2048);
  assert.equal(pipeline.waitForCapacity(workspaceId), undefined);
});

test("容量等待保留所属工作区失败，其他工作区仍可继续", async () => {
  const failure = new Error("capacity-writer-failed");
  const observed: unknown[] = [];
  const pipeline = createLocalEventPipeline({
    writer: {
      async submit() { throw failure; }, async completeIndexes() { assert.fail("must not index"); },
      async withLegacyDatabase(_requestId, operation) { return operation(); }, failIndexes() {},
    },
    apply() { assert.fail("must not apply"); }, publish() { assert.fail("must not publish"); },
    onFailure(error) { observed.push(error); },
  });
  for (let index = 0; index < 2048; index++) pipeline.enqueue({ t: "raw.event", event: raw }, null, 1);
  const ownWait = pipeline.waitForCapacity(workspaceId);
  const healthyWait = pipeline.waitForCapacity("healthy-workspace");
  await assert.rejects(ownWait!, error => error === failure);
  await healthyWait;
  assert.deepEqual(observed, [failure]);
  assert.throws(() => pipeline.waitForCapacity(workspaceId), error => error === failure);
  assert.equal(pipeline.waitForCapacity("healthy-workspace"), undefined);
  await assert.rejects(pipeline.close(), error => error === failure);
});

test("工作区恢复读取失败只冻结所属W且保留首次根因，其他W仍可持久化发布", async () => {
  const failure = new Error("WORKSPACE_RECEIPT_CORRUPT"), published: string[] = [];
  const pipeline = createLocalEventPipeline({
    writer: {
      async submit(batch) { return { batchId: batch.batchId, digest: "test", indexedCount: 0, indexedThroughSeq: 0,
        messages: batch.events.map(message => ({ t: message.t, event: { ...message.event, schema: 1, seq: 1 } })) as any }; },
      async completeIndexes() { return 1; }, async withLegacyDatabase(_requestId, operation) { return operation(); },
      failIndexes() { assert.fail("无批次的恢复错误不能伪造Writer失败批次"); },
    },
    apply() {}, publish(message) { published.push(message.event.workspaceId); },
    onFailure() { assert.fail("恢复读取失败由已有W边界记录，不能伪造batch回调"); },
  });
  pipeline.failWorkspace(workspaceId, failure);
  pipeline.failWorkspace(workspaceId, new Error("later-failure"));
  assert.throws(() => pipeline.assertNoFailure(workspaceId), error => error === failure);
  assert.throws(() => pipeline.enqueue({ t: "raw.event", event: raw }, null, 1), error => error === failure);
  await assert.rejects(pipeline.flush(workspaceId), error => error === failure);
  const healthyWorkspace = "healthy-workspace" as WorkspaceId;
  pipeline.enqueue({ t: "raw.event", event: { ...raw, workspaceId: healthyWorkspace } }, null, 1);
  await pipeline.flush(healthyWorkspace);
  assert.deepEqual(published, [healthyWorkspace]);
  await assert.rejects(pipeline.close(), error => error === failure);
});

test("desktop rollback fence completes from strict local raw persistence without Server ACK", async (t) => {
  const { db, reader } = setup(t);
  const fence = createRollbackEvidenceFence({ send(message) {
    assert.equal(message.t, "raw.event");
    writer.persist(message);
    return { accepted: true };
  } });
  const writer = createLocalEventPersistence({ db, applyConversation() {}, applyRaw(event) { fence.acceptAck(event); } });
  const seq = await fence.request({ workspaceId, threadId, engine: "codex" });
  assert.deepEqual(reader.prepare("SELECT seq FROM raw_engine_events").get(), { seq });
});

test("desktop rollback fence fails immediately when local raw storage fails", async (t) => {
  const { db } = setup(t);
  db.db.exec("CREATE TRIGGER reject_local_raw BEFORE INSERT ON raw_engine_events BEGIN SELECT RAISE(ABORT, 'raw disk failure'); END");
  const fence = createRollbackEvidenceFence({ send(message) {
    assert.equal(message.t, "raw.event");
    writer.persist(message);
    return { accepted: true };
  } });
  const writer = createLocalEventPersistence({ db, applyConversation() {}, applyRaw(event) { fence.acceptAck(event); } });
  await assert.rejects(fence.request({ workspaceId, threadId, engine: "codex" }), /raw disk failure/);
  assert.equal(db.rawEvents.getLatestSeqByThread(threadId), 0);
  assert.ok(Number((db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get() as any).value) > 0);
});
