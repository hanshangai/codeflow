import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { ConversationEventInput, ConversationRelayScope, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { allocateClientEventSeq, conversationRelayScopeKey } from "../src/db/repos/eventRepo.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { createRawEventAckBuffer } from "../src/diagnostics/rawEventAckBuffer.js";
import { createLocalEventPersistence } from "../src/runtime/localEventPersistence.js";
import { createLocalEventRelay } from "../src/runtime/localEventRelay.js";

const NOW = 1_800_000_000_000;
const threadId = "same-thread" as ThreadId;

/** 两个真实工作区共用应用 allocator，但拥有各自同名会话与 SQL 元数据。 */
function setup(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-events-"));
  const appPath = path.join(directory, "application.db");
  let db = openClientDb({ dbPath: appPath, localCanonicalEvents: true });
  const workspaces = ["events:first", "events:second", "events:third"].map((id, index) => {
    const workspaceId = id as WorkspaceId;
    const workspacePath = path.join(directory, String(index));
    fs.mkdirSync(workspacePath);
    db.workspaces.upsert({ id: workspaceId, title: id, path: workspacePath });
    const view = db.forWorkspace(workspaceId);
    view.threads.create({ id: threadId, workspaceId, engine: "codex", title: id });
    view.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run("shared", threadId);
    return { workspaceId, workspacePath };
  });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, workspaces, appPath,
    /** 重开应用 allocator，验证无事件提交的预留也耐久。 */
    reopen() { db.close(); db = openClientDb({ dbPath: appPath, localCanonicalEvents: true }); } };
}

/** 原事件信封保留可信 W，不利用同名 thread 反查物理库。 */
function event(workspaceId: WorkspaceId): ConversationEventInput {
  return { ts: NOW, workspaceId, threadId, engine: "codex", type: "turn.started", payload: { turnId: "same-turn" as any } };
}

/** 各 scope 使用同一共享标识，物理归属仍完全由 workspaceId 区分。 */
function scope(workspaceId: WorkspaceId): ConversationRelayScope {
  return { userId: "user", enterpriseId: "enterprise", clientId: "events", bindingId: workspaceId,
    workspaceId, sharedWorkspaceId: "shared", hostScopeEpoch: 1 };
}

/** 检查真实落库结果，不通过 relay 注册方法制造被测状态。 */
function registered(db: ReturnType<typeof openClientDb>): Array<{ key: string; value: string }> {
  return db.db.prepare("SELECT key, value FROM meta WHERE key LIKE 'conversation_relay:scope:%'").all() as Array<{ key: string; value: string }>;
}

test("事件只写所属 W，跨 W 共用耐久序号且索引在工作区提交后执行", t => {
  const f = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const indexed: number[] = [];
  const writer = createLocalEventPersistence({ db: f.db,
    applyConversation(envelope) {
      const location = f.workspaces.find(value => value.workspaceId === envelope.workspaceId)!;
      const reader = openSqliteDb(path.join(location.workspacePath, ".codeflowai", "workspace.db"), { readonly: true });
      try {
        assert.deepEqual(reader.prepare("SELECT seq FROM conversation_events WHERE seq = ?").get(envelope.seq), { seq: envelope.seq });
        assert.deepEqual(reader.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), { value: String(envelope.seq) });
      } finally { reader.close(); }
      indexed.push(envelope.seq);
    }, applyRaw(envelope) { indexed.push(envelope.seq); } });
  const first = writer.persist({ t: "conversation.event", event: event(f.workspaces[0]!.workspaceId) });
  const second = writer.persist({ t: "conversation.event", event: event(f.workspaces[1]!.workspaceId) });
  const raw = writer.persist({ t: "raw.event", event: { ...event(f.workspaces[0]!.workspaceId), source: "test", data: {}, handled: true, action: "mapped", emittedTypes: [] } });
  assert.deepEqual(indexed, [NOW, NOW + 1, NOW + 2]);
  assert.equal(first.event.seq, NOW);
  assert.equal(second.event.seq, NOW + 1);
  assert.equal(raw.event.seq, NOW + 2);
  assert.equal(f.db.conversationEvents.getLatestSeq(), 0);
  assert.equal(f.db.rawEvents.getLatestSeqByThread(threadId), 0);
  for (const { workspaceId } of f.workspaces) {
    assert.equal(f.db.forWorkspace(workspaceId).db.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), undefined);
  }
});

test("W 事件失败回滚正文与 floor，应用预留永久缺号并在重开后保持", t => {
  const f = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const workspaceId = f.workspaces[0]!.workspaceId;
  const view = f.db.forWorkspace(workspaceId);
  const writer = createLocalEventPersistence({ db: f.db, applyConversation() { assert.fail("不能索引失败事件"); }, applyRaw() {} });
  view.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON conversation_events BEGIN SELECT RAISE(ABORT, 'event disk failure'); END");
  assert.throws(() => writer.persist({ t: "conversation.event", event: event(workspaceId) }));
  assert.equal(view.conversationEvents.getLatestSeq(), 0);
  assert.equal(view.db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), undefined);
  assert.deepEqual(f.db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: String(NOW) });
  f.reopen();
  f.db.forWorkspace(workspaceId).db.exec("DROP TRIGGER reject_event");
  const resumed = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} })
    .persist({ t: "conversation.event", event: event(workspaceId) });
  assert.equal(resumed.event.seq, NOW + 1);
});

test("allocator 拒绝嵌套假预留，W 外层事务已存在时应用序号不前进", t => {
  const f = setup(t);
  t.mock.method(Date, "now", () => NOW);
  assert.throws(() => f.db.applicationDb.transaction(() => allocateClientEventSeq(f.db.applicationDb, { requireOutermost: true }))(), /SQLITE_TRANSACTION_ALREADY_ACTIVE/);
  assert.deepEqual(f.db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: "0" });
  const view = f.db.forWorkspace(f.workspaces[0]!.workspaceId);
  const writer = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
  assert.throws(() => view.db.transaction(() => writer.persist({ t: "conversation.event", event: event(f.workspaces[0]!.workspaceId) }))());
  assert.deepEqual(f.db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: "0" });
});

test("W 写锁竞争期间应用 counter 不先预留，释放后才提交事件", { timeout: 15_000 }, async t => {
  const f = setup(t);
  const workspaceId = f.workspaces[0]!.workspaceId;
  const barrier = new SharedArrayBuffer(4);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const workspace = new DatabaseSync(workerData.workspacePath);
    workspace.exec('BEGIN IMMEDIATE');
    Atomics.store(new Int32Array(workerData.barrier), 0, 1);
    Atomics.notify(new Int32Array(workerData.barrier), 0);
    setTimeout(() => {
      const application = new DatabaseSync(workerData.appPath, { readOnly: true });
      const counter = application.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get().value;
      application.close();
      workspace.exec('ROLLBACK');
      workspace.close();
      parentPort.postMessage(counter);
    }, 200);
  `, { eval: true, workerData: { barrier, appPath: f.appPath,
    workspacePath: path.join(f.workspaces[0]!.workspacePath, ".codeflowai", "workspace.db") } });
  t.after(async () => { await worker.terminate(); });
  const observed = new Promise<string>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  if (Atomics.load(new Int32Array(barrier), 0) === 0) Atomics.wait(new Int32Array(barrier), 0, 0, 5_000);
  assert.equal(Atomics.load(new Int32Array(barrier), 0), 1);
  const result = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} })
    .persist({ t: "conversation.event", event: event(workspaceId) });
  assert.equal(await observed, "0");
  assert.ok(result.event.seq > 0);
  assert.equal(f.db.forWorkspace(workspaceId).conversationEvents.getLatestSeq(), result.event.seq);
});

test("W 历史高水位推动应用 allocator，floor 写入失败同时回滚事件", t => {
  const f = setup(t);
  t.mock.method(Date, "now", () => NOW);
  const workspaceId = f.workspaces[0]!.workspaceId;
  const view = f.db.forWorkspace(workspaceId);
  view.conversationEvents.appendEnvelope({ ...event(workspaceId), schema: 1, seq: NOW + 50 });
  const writer = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
  view.db.exec("CREATE TRIGGER reject_floor BEFORE INSERT ON meta WHEN NEW.key = 'event_seq_floor' BEGIN SELECT RAISE(ABORT, 'floor disk failure'); END");
  assert.throws(() => writer.persist({ t: "conversation.event", event: event(workspaceId) }));
  assert.equal(view.conversationEvents.getLatestSeq(), NOW + 50);
  assert.deepEqual(f.db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get(), { value: String(NOW + 51) });
  view.db.exec("DROP TRIGGER reject_floor");
  assert.equal(writer.persist({ t: "conversation.event", event: event(workspaceId) }).event.seq, NOW + 52);
});

for (const kind of ["canonical", "raw"] as const) {
  test(`${kind} ACK高序号正文删除并重开后，本地事件仍超过已提交下界`, t => {
    const f = setup(t), workspaceId = f.workspaces[0]!.workspaceId;
    t.mock.method(Date, "now", () => NOW);
    if (kind === "canonical") {
      const buffer = createConversationEventAckBuffer(f.db);
      buffer.enqueue({ ...event(workspaceId), schema: 1, seq: NOW + 1_000 });
      buffer.dispose();
    } else {
      const buffer = createRawEventAckBuffer(f.db);
      buffer.enqueue({ schema: 1, seq: NOW + 1_000, ts: NOW, workspaceId, threadId, engine: "codex",
        source: "remote-ack", data: {}, handled: true, action: "mapped", emittedTypes: [] });
      buffer.dispose();
    }
    const view = f.db.forWorkspace(workspaceId);
    assert.equal(view.conversationEvents.deleteByThread(threadId) + view.rawEvents.deleteByThread(threadId), 1);
    f.reopen();
    const committed = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} })
      .persist({ t: "conversation.event", event: event(workspaceId) });
    assert.equal(committed.event.seq, NOW + 1_001);
  });
}

test("relay 同名会话按 W 投递和 ACK，删除屏障也留在所属 W", t => {
  const f = setup(t);
  const sent: any[] = [];
  const writer = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
  const events = f.workspaces.slice(0, 2).map(({ workspaceId }) => writer.persist({ t: "conversation.event", event: event(workspaceId) }));
  const relay = createLocalEventRelay({ db: f.db, serverUrl: "wss://server.test", ackTimeoutMs: 90_000,
    onError(error) { throw error; }, send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  const scopes = f.workspaces.slice(0, 2).map(({ workspaceId }) => scope(workspaceId));
  relay.activate(scopes, 1);
  relay.flush();
  assert.equal(sent[0]?.events[0]?.workspaceId, scopes[0]!.workspaceId);
  assert.equal(relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [events[0]!.event.seq] }, 1), true);
  relay.flush();
  assert.equal(sent[1]?.events[0]?.workspaceId, scopes[1]!.workspaceId);
  assert.equal(relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[1].delivery, seqs: [events[1]!.event.seq] }, 1), true);
  const first = f.db.forWorkspace(scopes[0]!.workspaceId);
  first.conversationEvents.deleteByThread(threadId);
  relay.flush();
  assert.equal(sent[2]?.t, "thread.history.cleaned");
  assert.equal(sent[2]?.workspaceId, scopes[0]!.workspaceId);
  assert.deepEqual(registered(f.db), []);
  assert.equal(registered(first).length, 1);
  assert.equal(registered(f.db.forWorkspace(scopes[1]!.workspaceId)).length, 1);
});

test("relay 登记 A 成功 B 失败停 C，本次范围零激活且重试复用 A", t => {
  const f = setup(t);
  const sent: unknown[] = [];
  const writer = createLocalEventPersistence({ db: f.db, applyConversation() {}, applyRaw() {} });
  writer.persist({ t: "conversation.event", event: event(f.workspaces[0]!.workspaceId) });
  const second = f.db.forWorkspace(f.workspaces[1]!.workspaceId);
  second.db.exec("CREATE TRIGGER reject_scope BEFORE INSERT ON meta WHEN NEW.key LIKE 'conversation_relay:scope:%' BEGIN SELECT RAISE(ABORT, 'scope disk failure'); END");
  const relay = createLocalEventRelay({ db: f.db, serverUrl: "wss://server.test", ackTimeoutMs: 90_000,
    onError(error) { throw error; }, send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  const scopes = f.workspaces.map(({ workspaceId }) => scope(workspaceId));
  assert.throws(() => relay.activate(scopes, 1));
  relay.flush();
  assert.deepEqual(sent, []);
  const first = f.db.forWorkspace(f.workspaces[0]!.workspaceId);
  assert.equal(registered(first).length, 1);
  assert.equal(registered(second).length, 0);
  assert.equal(registered(f.db.forWorkspace(f.workspaces[2]!.workspaceId)).length, 0);
  const key = conversationRelayScopeKey("wss://server.test", scopes[0]!);
  first.conversationEvents.advanceRelayCursor(key, 0, 10);
  second.db.exec("DROP TRIGGER reject_scope");
  relay.activate(scopes, 1);
  assert.equal(first.conversationEvents.readRelayBatch(key).cursor, 10);
  relay.flush();
  assert.equal(sent.length, 1);
});
