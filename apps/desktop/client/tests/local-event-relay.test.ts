import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ConversationEventEnvelope, ConversationRelayScope, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { conversationRelayScopeKey } from "../src/db/repos/eventRepo.js";
import { createLocalEventRelay as createRelay } from "../src/runtime/localEventRelay.js";

const workspaceId = "relay-client:workspace" as WorkspaceId;
const threadId = "relay-shared" as ThreadId;
const personalId = "relay-personal" as ThreadId;
const scope: ConversationRelayScope = { userId: "user-a", enterpriseId: "enterprise-a", clientId: "relay-client",
  bindingId: "binding-a", workspaceId, sharedWorkspaceId: "shared-a", hostScopeEpoch: 4 };
const relayPolicy = { ackTimeoutMs: 90_000,
  /** 非超时测试若收到异步失败立即失败，禁止测试吞错。 */
  onError(error: Error): void { throw error; } };

const demandFixtures = new WeakMap<ReturnType<typeof createRelay>, { baseline: number; generation: number; demands: Map<string, any> }>();
let demandSequence = 0;

/** 注入读屏障与异步许可，SQL、投递和 ACK 仍执行生产实现。 */
function createLocalEventRelay(input: Omit<Parameters<typeof createRelay>[0], "withDatabase" | "readReadyThroughSeq">
  & Partial<Pick<Parameters<typeof createRelay>[0], "withDatabase" | "readReadyThroughSeq">>) {
  const fixture = { baseline: Number.MAX_SAFE_INTEGER, generation: 0, demands: new Map<string, any>() };
  const relay = createRelay({ ...input, withDatabase: input.withDatabase ?? (async operation => operation()),
    readReadyThroughSeq: input.readReadyThroughSeq ?? (async () => fixture.baseline) });
  demandFixtures.set(relay, fixture);
  return relay;
}

/** 投递内核用例显式安装 H=0 需求；独立用例覆盖真实 H 跳过历史。 */
async function activateDemand(relay: ReturnType<typeof createRelay>, scopes: ConversationRelayScope[], generation: number): Promise<void> {
  const fixture = demandFixtures.get(relay)!;
  relay.activate(scopes, generation);
  if (fixture.generation !== generation) fixture.demands.clear();
  fixture.generation = generation;
  const activeKeys = new Set(scopes.map(value => JSON.stringify(value)));
  for (const key of fixture.demands.keys()) if (!activeKeys.has(key)) fixture.demands.delete(key);
  fixture.baseline = 0;
  try {
    for (const value of scopes) {
      const key = JSON.stringify(value);
      let demand = fixture.demands.get(key);
      if (!demand) {
        demand = { kind: "conversation", requestId: "test-request", demandId: `test-demand-${++demandSequence}`,
          generation: demandSequence, scope: value, recipientUserIds: [value.userId] };
        fixture.demands.set(key, demand);
      }
      await relay.setDemand(demand, true, generation);
    }
  } finally { fixture.baseline = Number.MAX_SAFE_INTEGER; }
}

/** 每例使用隔离 SQLite，允许关闭后重开以检查耐久投递进度。 */
function setup(t: test.TestContext, localCanonicalEvents = true, onRelayInvalidation?: (scopeKey: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-event-relay-"));
  const dbPath = path.join(directory, "client.db");
  let db = openClientDb({ dbPath, localCanonicalEvents, onRelayInvalidation });
  const workspaceIds: WorkspaceId[] = [];
  /** 每个注册W都有独立物理目录，未知范围不借用用户临时根。 */
  const addWorkspace = (id: WorkspaceId) => {
    if (!workspaceIds.includes(id)) {
      const workspacePath = path.join(directory, id.split(":")[1]!);
      fs.mkdirSync(workspacePath);
      db.workspaces.upsert({ id, title: id, path: workspacePath });
      workspaceIds.push(id);
    }
    return db.forWorkspace(id);
  };
  const view = addWorkspace(workspaceId);
  view.threads.create({ id: threadId, workspaceId, engine: "codex", title: "Shared" });
  view.threads.create({ id: personalId, workspaceId, engine: "codex", title: "Personal" });
  view.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run(scope.sharedWorkspaceId, threadId);
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get db() { return db; }, get view() { return db.forWorkspace(workspaceId); }, workspaceIds, addWorkspace,
    /** 重开同一文件，不依赖运行中的桌面数据库。 */
    reopen() { db.close(); db = openClientDb({ dbPath, localCanonicalEvents, onRelayInvalidation }); return db.forWorkspace(workspaceId); } };
}

/** 固定已分号的 canonical 信封，测试不经过 Server 二次编号。 */
function event(seq: number, id = threadId): ConversationEventEnvelope {
  return { schema: 1, seq, ts: 1_800_000_000_000, workspaceId, threadId: id, engine: "codex",
    type: "thread.started", payload: {} };
}

/** 只读取真实耐久登记，不因断言查询重新创建scope。 */
function registeredScopes(db: ReturnType<typeof openClientDb>, workspaceIds: WorkspaceId[]) {
  return workspaceIds.flatMap(id => db.forWorkspace(id).db.prepare("SELECT key, value FROM meta WHERE key LIKE 'conversation_relay:scope:%' ORDER BY key")
    .all() as Array<{ key: string; value: string }>);
}

/** 等待一个调度批次，按事件循环顺序验证让出，不依赖墙钟耗时。 */
async function nextRelayBatch(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("仅授权没有实际Web需求时不扫描或上传历史", async t => {
  const f = setup(t), sent: unknown[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  relay.activate([scope], 1);
  const read = t.mock.method(f.db, "forWorkspace");
  relay.scheduleFlush();
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(read.mock.calls.length, 0);
  assert.deepEqual(sent, []);
});

test("首需求从已完成索引的H接续，仅发送H之后事件并隔离旧周期ACK", async t => {
  const f = setup(t), sent: any[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  let readyThroughSeq = 10;
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    readReadyThroughSeq: async () => readyThroughSeq, send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  relay.activate([scope], 1);
  const first = { kind: "conversation" as const, requestId: "first", demandId: "first", generation: 1, scope, recipientUserIds: [scope.userId] };
  const oldHistoryRead = t.mock.method(f.view.conversationEvents, "readRelayBatch");
  const ready = await relay.setDemand(first, true, 1);
  assert.equal(ready?.ok && ready.readyThroughSeq, 10);
  assert.equal(oldHistoryRead.mock.calls.length, 0, "安装H仅更新投递元数据，不读取旧正文");
  await relay.flush();
  assert.deepEqual(sent, [], "首订阅不能上传H以前的历史");
  f.view.conversationEvents.appendEnvelope(event(20)); readyThroughSeq = 20;
  await relay.flush();
  assert.deepEqual(sent[0].events.map((row: ConversationEventEnvelope) => row.seq), [20]);
  const oldAck = { t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [20] };
  await relay.setDemand(first, false, 1);
  f.view.conversationEvents.appendEnvelope(event(30)); readyThroughSeq = 30;
  const read = t.mock.method(f.db, "forWorkspace");
  relay.scheduleFlush(); await nextRelayBatch();
  assert.equal(read.mock.calls.length, 0);
  const second = { ...first, requestId: "second", demandId: "second", generation: 2 };
  await relay.setDemand(second, true, 1);
  assert.equal(await relay.acceptAck(oldAck, 1), false);
  await relay.flush();
  assert.equal(sent.length, 1, "重入沿新H读取HTTP快照，不重放无人订阅期间事件");
  f.view.conversationEvents.appendEnvelope(event(40)); readyThroughSeq = 40;
  await relay.flush();
  assert.deepEqual(sent[1].events.map((row: ConversationEventEnvelope) => row.seq), [40]);
  assert.equal(sent[1].delivery.demandId, "second");
});

test("读取屏障期间取消需求后迟到读取结果不登记SQL或复活需求", async t => {
  const f = setup(t);
  let complete!: (value: number) => void;
  const barrier = new Promise<number>(resolve => { complete = resolve; });
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", readReadyThroughSeq: () => barrier,
    send() { assert.fail("cancelled demand cannot send"); } });
  t.after(() => relay.dispose());
  relay.activate([scope], 1);
  const demand = { kind: "conversation" as const, requestId: "cancelled", demandId: "cancelled", generation: 1, scope, recipientUserIds: [] };
  const pending = relay.setDemand(demand, true, 1);
  await relay.setDemand(demand, false, 1);
  complete(10);
  assert.equal(await pending, null);
  assert.equal(await relay.setDemand(demand, true, 1), null, "撤销后同代迟到启动不得复活");
  assert.deepEqual(registeredScopes(f.db, f.workspaceIds), []);
});

test("索引读屏障失败显式拒绝ready，不产生投递副作用", async t => {
  const f = setup(t);
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    readReadyThroughSeq: async () => { throw new Error("INDEX_NOT_READY"); }, send() { assert.fail("failed baseline cannot send"); } });
  t.after(() => relay.dispose());
  relay.activate([scope], 1);
  await assert.rejects(relay.setDemand({ kind: "conversation", requestId: "failure", demandId: "failure", generation: 1,
    scope, recipientUserIds: [] }, true, 1), /INDEX_NOT_READY/);
  assert.deepEqual(registeredScopes(f.db, f.workspaceIds), []);
});

for (const [scheduled, repeatActivation] of [[false, false], [false, true], [true, false], [true, true]] as const) {
  test(`持续积压的工作区跨ACK轮转投递，scheduled=${scheduled},repeatActivation=${repeatActivation}`, async t => {
    const f = setup(t), sent: any[] = [];
    const later: ConversationRelayScope = { ...scope, bindingId: "later", workspaceId: "relay-client:later" as WorkspaceId };
    const view = f.addWorkspace(later.workspaceId);
    view.threads.create({ id: "later-thread", workspaceId: later.workspaceId, engine: "codex", title: "Later" });
    view.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run(scope.sharedWorkspaceId, "later-thread");
    for (let seq = 1; seq <= 5; seq++) {
      f.view.conversationEvents.appendEnvelope(event(seq));
      view.conversationEvents.appendEnvelope({ ...event(seq + 10), workspaceId: later.workspaceId, threadId: "later-thread" });
    }
    const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", batchSize: 1,
      send(message) { sent.push(message); return { accepted: true }; } });
    t.after(() => relay.dispose());
    await activateDemand(relay, [scope, later], 1);
    for (let round = 0; round < 6; round++) {
      if (scheduled) {
        relay.scheduleFlush();
        for (let tick = 0; sent.length <= round && tick < 6; tick++) await nextRelayBatch();
      } else await relay.flush();
      const message = sent[round];
      assert.equal(message?.t, "conversation.event.relay");
      assert.equal(message.events[0].workspaceId, round % 2 === 0 ? workspaceId : later.workspaceId);
      if (repeatActivation) await activateDemand(relay, [scope, later], 1);
      assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: message.delivery,
        seqs: message.events.map((row: ConversationEventEnvelope) => row.seq) }, 1), true);
      if (repeatActivation) await activateDemand(relay, [scope, later], 1);
    }
    assert.deepEqual(sent.map(message => message.events[0].seq), [1, 11, 2, 12, 3, 13]);
  });
}

test("调度投递合并唤醒并逐scope让出，全部屏障先于新增事件", async t => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const later: ConversationRelayScope = { ...scope, bindingId: "later", workspaceId: "relay-client:later" as WorkspaceId };
  f.addWorkspace(later.workspaceId);
  const laterView = f.db.forWorkspace(later.workspaceId);
  laterView.threads.create({ id: "later-thread", workspaceId: later.workspaceId, engine: "codex", title: "Later" });
  laterView.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run(scope.sharedWorkspaceId, "later-thread");
  laterView.conversationEvents.appendEnvelope({ ...event(20), workspaceId: later.workspaceId, threadId: "later-thread" });
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope, later], 1);
  laterView.conversationEvents.deleteByThread("later-thread");
  let connections = 0;
  const forWorkspace = f.db.forWorkspace.bind(f.db);
  t.mock.method(f.db, "forWorkspace", (id, options) => { connections++; return forWorkspace(id, options); });
  relay.scheduleFlush(); relay.scheduleFlush(); relay.scheduleFlush();
  assert.equal(connections, 0, "唤醒不能在调用方同步查询SQLite");
  await nextRelayBatch();
  assert.equal(connections, 1, "每批只检查一个scope");
  assert.equal(sent.length, 0);
  await nextRelayBatch();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "thread.history.cleaned", "后续scope的清理优先于前面scope的事件");
  assert.equal(connections, 2, "重复唤醒不能创建第二个pump");
  assert.equal(await relay.acceptAck({ t: "thread.history.cleanedAck", delivery: sent[0].delivery,
    invalidationId: sent[0].invalidationId, workspaceId: later.workspaceId, threadId: "later-thread", throughSeq: sent[0].throughSeq }, 1), true);
  relay.scheduleFlush();
  for (let index = 0; index < 3; index++) await nextRelayBatch();
  assert.equal(sent[1].t, "conversation.event.relay");
  assert.deepEqual(sent[1].events.map((row: ConversationEventEnvelope) => row.seq), [10]);
});

test("连续屏障唤醒保留未查范围，后续scope有限批次内投递", async t => {
  const f = setup(t), sent: any[] = [];
  const later: ConversationRelayScope = { ...scope, bindingId: "later", workspaceId: "relay-client:later" as WorkspaceId };
  const view = f.addWorkspace(later.workspaceId);
  view.threads.create({ id: "later-thread", workspaceId: later.workspaceId, engine: "codex", title: "Later" });
  view.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run(scope.sharedWorkspaceId, "later-thread");
  view.conversationEvents.appendEnvelope({ ...event(20), workspaceId: later.workspaceId, threadId: "later-thread" });
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope, later], 1);
  view.conversationEvents.deleteByThread("later-thread");
  for (let index = 0; index < 4; index++) { relay.scheduleFlush(true); await nextRelayBatch(); }
  assert.equal(sent[0]?.t, "thread.history.cleaned");
  assert.equal(sent[0].workspaceId, later.workspaceId);
});

test("非活动scope的持久屏障不唤醒当前授权范围", async t => {
  let relay: ReturnType<typeof createLocalEventRelay> | undefined;
  const f = setup(t, true, key => relay?.scheduleFlush(true, key));
  const old: ConversationRelayScope = { ...scope, bindingId: "old", workspaceId: "relay-client:old" as WorkspaceId };
  const view = f.addWorkspace(old.workspaceId);
  view.threads.create({ id: "old-thread", workspaceId: old.workspaceId, engine: "codex", title: "Old" });
  view.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run(scope.sharedWorkspaceId, "old-thread");
  view.conversationEvents.appendEnvelope({ ...event(20), workspaceId: old.workspaceId, threadId: "old-thread" });
  relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send() { assert.fail("非活动范围不能投递"); } });
  t.after(() => relay!.dispose());
  await activateDemand(relay, [old], 1);
  await activateDemand(relay, [scope], 1);
  view.conversationEvents.deleteByThread("old-thread");
  const read = t.mock.method(f.db, "forWorkspace");
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(read.mock.calls.length, 0);
});

test("个人scope清理屏障允许null共享归属并由完整ACK持久确认", async t => {
  const f = setup(t), sent: any[] = [];
  const personalScope: ConversationRelayScope = { kind: "personal", userId: "user-a", enterpriseId: null,
    clientId: "relay-client", workspaceId };
  f.view.conversationEvents.appendEnvelope(event(10, personalId));
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [personalScope], 1);
  f.view.conversationEvents.deleteByThread(personalId);
  await relay.flush();
  const cleaned = sent[0];
  assert.equal(cleaned.t, "thread.history.cleaned");
  assert.equal(cleaned.sharedWorkspaceId, null);
  assert.equal(cleaned.delivery.scope.kind, "personal");
  assert.equal(await relay.acceptAck({ ...cleaned, t: "thread.history.cleanedAck" }, 1), true);
  const key = conversationRelayScopeKey("wss://server.test", personalScope);
  assert.equal(f.view.conversationEvents.readRelayInvalidation(key), null);
});

for (const action of ["disconnect", "dispose", "replace"] as const) {
  test(`已排队投递在${action}后不读取旧scope`, async t => {
    const f = setup(t), sent: unknown[] = [];
    f.view.conversationEvents.appendEnvelope(event(10));
    const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
      send(message) { sent.push(message); return { accepted: true }; } });
    t.after(() => relay.dispose());
    await activateDemand(relay, [scope], 1);
    relay.scheduleFlush();
    if (action === "disconnect") relay.disconnect(1);
    else if (action === "dispose") relay.dispose();
    else await activateDemand(relay, [], 2);
    const read = t.mock.method(f.db, "forWorkspace");
    await nextRelayBatch(); await nextRelayBatch();
    assert.equal(read.mock.calls.length, 0);
    assert.equal(sent.length, 0);
  });
}

test("调度扫描失败显式交原投递owner，停止扫描且不推进耐久游标", async t => {
  const f = setup(t), failures: Error[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  const relay = createLocalEventRelay({ ackTimeoutMs: 90_000, db: f.db, serverUrl: "wss://server.test",
    onError(error) { failures.push(error); }, send() { assert.fail("损坏元数据不得投递"); } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  const key = conversationRelayScopeKey("wss://server.test", scope);
  f.view.db.prepare("UPDATE meta SET value = 'broken' WHERE key = ?").run(`conversation_relay:scope:${key}`);
  relay.scheduleFlush();
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.message, /JSON/);
});

test("分批扫描间新增清理屏障时先重新检查屏障", async t => {
  const f = setup(t), sent: any[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  relay.scheduleFlush();
  await nextRelayBatch();
  assert.equal(sent.length, 0);
  f.view.conversationEvents.deleteByThread(threadId);
  relay.scheduleFlush(true);
  await nextRelayBatch();
  assert.equal(sent[0].t, "thread.history.cleaned");
});

for (const mutation of ["clear", "message", "after", "through", "workspace"] as const) {
  test(`屏障写入owner自行唤醒空闲投递：${mutation}`, async t => {
    let relay: ReturnType<typeof createLocalEventRelay> | undefined;
    const f = setup(t, true, () => relay?.scheduleFlush(true)), sent: any[] = [];
    f.view.conversationEvents.appendEnvelope({ ...event(10), type: "item.userMessage.created", payload: { itemId: "message", text: "hello" } });
    f.view.conversationEvents.appendEnvelope(event(20));
    relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
      send(message) { sent.push(message); return { accepted: true }; } });
    t.after(() => relay!.dispose());
    await activateDemand(relay, [scope], 1);
    if (mutation === "clear") f.view.conversationEvents.deleteByThread(threadId);
    else if (mutation === "message") f.view.conversationEvents.deleteMessage(threadId, "message");
    else if (mutation === "after") f.view.conversationEvents.deleteAfterSeq(threadId, 10);
    else if (mutation === "through") f.view.conversationEvents.deleteByThreadThroughSeq(threadId, 20, 1);
    else f.view.conversationEvents.deleteByWorkspace(workspaceId);
    assert.equal(sent.length, 0, "写事务中只唤醒，不读取未提交事实");
    await nextRelayBatch(); await nextRelayBatch();
    assert.equal(sent[0]?.t, "thread.history.cleaned", "没有API或后续事件也必须推进删除屏障");
  });
}

test("删除消息在两批之间写屏障并发canonical时仍先投递屏障", async t => {
  let relay: ReturnType<typeof createLocalEventRelay> | undefined;
  const f = setup(t, true, () => relay?.scheduleFlush(true)), sent: any[] = [];
  f.view.conversationEvents.appendEnvelope({ ...event(10), type: "item.userMessage.created", payload: { itemId: "message", text: "hello" } });
  relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay!.dispose());
  await activateDemand(relay, [scope], 1);
  relay.scheduleFlush();
  await nextRelayBatch();
  f.view.conversationEvents.deleteMessage(threadId, "message");
  f.view.conversationEvents.appendEnvelope({ ...event(20), type: "item.message.deleted", payload: { itemId: "message" } });
  relay.scheduleFlush();
  await nextRelayBatch();
  assert.equal(sent[0]?.t, "thread.history.cleaned");
});

test("外层事务回滚后只复核SQL，不投递已回滚的屏障", async t => {
  let relay: ReturnType<typeof createLocalEventRelay> | undefined;
  const f = setup(t, true, () => relay?.scheduleFlush(true)), sent: any[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay!.dispose());
  await activateDemand(relay, [scope], 1);
  const failure = new Error("OUTER_ROLLBACK");
  assert.throws(() => f.view.db.transaction(() => { f.view.conversationEvents.deleteByThread(threadId); throw failure; })(), error => error === failure);
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.t, "conversation.event.relay");
  assert.equal(f.view.conversationEvents.readRelayInvalidation(conversationRelayScopeKey("wss://server.test", scope)), null);
});

test("在途期间的删除通知不新增flight，ACK后先投递耐久屏障", async t => {
  let relay: ReturnType<typeof createLocalEventRelay> | undefined;
  const f = setup(t, true, () => relay?.scheduleFlush(true)), sent: any[] = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay!.dispose());
  await activateDemand(relay, [scope], 1);
  relay.scheduleFlush();
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(sent[0]?.t, "conversation.event.relay");
  f.view.conversationEvents.deleteByThread(threadId);
  await nextRelayBatch();
  assert.equal(sent.length, 1);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [10] }, 1), true);
  relay.scheduleFlush();
  await nextRelayBatch();
  assert.equal(sent[1]?.t, "thread.history.cleaned");
});

test("已扫描scope出现新事件时合并补扫，无后续API也可投递", async t => {
  const f = setup(t), sent: any[] = [];
  const later: ConversationRelayScope = { ...scope, bindingId: "later", workspaceId: "relay-client:later" as WorkspaceId };
  f.addWorkspace(later.workspaceId);
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope, later], 1);
  relay.scheduleFlush();
  for (let index = 0; index < 3; index++) await nextRelayBatch();
  f.view.conversationEvents.appendEnvelope(event(10));
  relay.scheduleFlush(); relay.scheduleFlush();
  for (let index = 0; index < 4; index++) await nextRelayBatch();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].events.map((row: ConversationEventEnvelope) => row.seq), [10]);
});

test("调度发送拒绝显式失败，重连前不再扫描且耐久进度不变", async t => {
  const f = setup(t), failures: Array<{ error: Error; context: { generation: number; delivery: { scope: ConversationRelayScope } } }> = [];
  f.view.conversationEvents.appendEnvelope(event(10));
  const relay = createLocalEventRelay({ db: f.db, serverUrl: "wss://server.test", ackTimeoutMs: 90_000,
    onError(error, context) { failures.push({ error, context }); }, send() { return { accepted: false, reason: "offline" }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  relay.scheduleFlush();
  await nextRelayBatch(); await nextRelayBatch();
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.error.message, /SEND_REJECTED: offline/);
  assert.equal(failures[0]!.context.generation, 1);
  assert.deepEqual(failures[0]!.context.delivery.scope, scope);
  const read = t.mock.method(f.db, "forWorkspace");
  relay.scheduleFlush();
  await nextRelayBatch();
  assert.equal(read.mock.calls.length, 0);
  const key = conversationRelayScopeKey("wss://server.test", scope);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 0);
});

test("投递检查只读取快照且不构造 writer，ACK 仍耐久推进原游标", async t => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  const filename = path.join(f.db.workspaces.get(workspaceId)!.path, ".codeflowai", "workspace.db");
  const before = fs.readFileSync(filename);
  const exec = DatabaseSync.prototype.exec;
  let ddl = 0;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (/\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)) ddl++;
    return exec.call(this, sql);
  });
  await relay.flush();
  assert.deepEqual(sent[0].events.map((value: ConversationEventEnvelope) => value.seq), [10]);
  assert.equal(ddl, 0, "投递检查不能执行 writer 的 schema 或 TEMP 触发器初始化");
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [10] }, 1), true);
  ddl = 0;
  await relay.flush();
  assert.equal(sent.length, 1);
  assert.equal(ddl, 0, "空检查同样不能初始化 writer");
  const key = conversationRelayScopeKey("wss://server.test", scope);
  assert.equal(f.reopen().conversationEvents.readRelayBatch(key).cursor, 10);
});

for (const invalid of ["scope", "duplicate", "server"] as const) {
  test(`${invalid} input is rejected before any scope registration`, async (t) => {
    const f = setup(t);
    const second: ConversationRelayScope = { ...scope, workspaceId: "relay-client:second" as WorkspaceId,
      bindingId: "binding-b", ...(invalid === "scope" ? { userId: " invalid " } : {}) };
    f.addWorkspace(second.workspaceId);
    const candidates = invalid === "duplicate" ? [scope, second, { ...scope, hostScopeEpoch: 9 }] : [scope, second];
    let registrations = 0;
    for (const id of f.workspaceIds) {
      const repo = f.db.forWorkspace(id).conversationEvents, register = repo.registerRelayScope.bind(repo);
      /** 观察真实写入口，防止仅靠整批回滚掩盖缺少写前预检。 */
      t.mock.method(repo, "registerRelayScope", (serverUrl: string, value: ConversationRelayScope) => {
        registrations += 1;
        return register(serverUrl, value);
      });
    }
    const relay = createLocalEventRelay({ ...relayPolicy, db: f.db,
      serverUrl: invalid === "server" ? "wss://username:password@server.test" : "wss://server.test",
      send() { assert.fail("invalid activation cannot send"); } });
    t.after(() => relay.dispose());
    assert.throws(() => relay.activate(candidates, 1), new RegExp(invalid === "duplicate"
      ? "CONVERSATION_RELAY_DUPLICATE_SCOPE" : invalid === "server" ? "CONVERSATION_RELAY_SERVER_INVALID" : "CONVERSATION_RELAY_SCOPE_INVALID"));
    assert.equal(registrations, 0);
    assert.deepEqual(registeredScopes(f.db, f.workspaceIds), []);
    await relay.flush();
  });
}

test("grouped registration keeps the original delivery order after all workspace commits", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const secondWorkspace = "relay-client:second" as WorkspaceId;
  const secondThread = "relay-second-thread" as ThreadId;
  const secondDb = f.addWorkspace(secondWorkspace);
  secondDb.threads.create({ id: secondThread, workspaceId: secondWorkspace, engine: "codex", title: "Shared second" });
  secondDb.db.prepare("UPDATE threads SET shared_workspace_id = ? WHERE id = ?").run("shared-b", secondThread);
  secondDb.conversationEvents.appendEnvelope({ ...event(20, secondThread), workspaceId: secondWorkspace });
  const emptyFirst = { ...scope, bindingId: "empty-first", sharedWorkspaceId: "shared-empty" };
  const second: ConversationRelayScope = { ...scope, workspaceId: secondWorkspace, bindingId: "binding-b", sharedWorkspaceId: "shared-b" };
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [emptyFirst, second, scope], 1);
  await relay.flush();
  assert.equal(sent[0].delivery.scope.bindingId, second.bindingId);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [20] }, 1), true);
  await relay.flush();
  assert.equal(sent[1].delivery.scope.bindingId, scope.bindingId);
  assert.deepEqual(sent[1].events.map((value: ConversationEventEnvelope) => value.seq), [10]);
});

test("relay progress belongs to a stable authorized Host scope and excludes personal history", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(11, personalId), event(12)]);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test/ws/client", scope);
  assert.equal(f.view.conversationEvents.registerRelayScope("wss://server.test/other", { ...scope, hostScopeEpoch: 9 }), key);
  assert.notEqual(f.view.conversationEvents.registerRelayScope("wss://other.test/", scope), key);
  assert.notEqual(f.view.conversationEvents.registerRelayScope("wss://server.test/", { ...scope, userId: "user-b" }), key);
  const batch = f.view.conversationEvents.readRelayBatch(key, 2);
  assert.deepEqual(batch.events.map((row) => row.seq), [10, 12]);
  f.view.conversationEvents.advanceRelayCursor(key, 0, batch.throughSeq);
  assert.equal(f.reopen().conversationEvents.readRelayBatch(key, 2).cursor, 12);
});

test("unassociated and ordinary Client deletes do not create remote work", async (t) => {
  const f = setup(t, false);
  f.view.conversationEvents.appendEnvelope(event(10));
  f.view.conversationEvents.deleteByThread(threadId);
  assert.deepEqual(f.view.db.prepare("SELECT key FROM meta WHERE key LIKE 'conversation_relay:%'").all(), []);
  assert.throws(() => f.view.conversationEvents.registerRelayScope("wss://server.test", scope), /LOCAL_CANONICAL_EVENTS_REQUIRED/);
});

for (const operation of ["message", "thread", "workspace", "after", "through"] as const) {
  test(`${operation} deletion rolls back its invalidation and persists it with the successful mutation`, async (t) => {
    const f = setup(t);
    f.view.conversationEvents.appendEnvelopes([event(10), { ...event(20), type: "item.userMessage.created",
      payload: { itemId: "message-a", text: "body" } } as ConversationEventEnvelope]);
    const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
    /** 调用真实仓储删除入口，覆盖回滚、清空、审批续跑及分批清理共用边界。 */
    const remove = () => {
      const repo = f.view.conversationEvents;
      if (operation === "message") return repo.deleteMessage(threadId, "message-a");
      if (operation === "thread") return repo.deleteByThread(threadId);
      if (operation === "workspace") return repo.deleteByWorkspace(workspaceId);
      if (operation === "after") return repo.deleteAfterSeq(threadId, 10);
      return repo.deleteByThreadThroughSeq(threadId, 20, 10);
    };
    assert.throws(() => f.view.db.transaction(() => { remove(); throw new Error("abort mutation"); })(), /abort mutation/);
    assert.equal(f.view.conversationEvents.readRelayInvalidation(key), null);
    assert.deepEqual(f.view.conversationEvents.readRelayBatch(key).events.map((row) => row.seq), [10, 20]);
    remove();
    assert.equal(f.reopen().conversationEvents.readRelayInvalidation(key)?.throughSeq, 20);
    assert.equal(f.view.conversationEvents.readRelayBatch(key).events.some((row) => row.seq === 20), false);
  });
}

test("canonical deletion and pending cache invalidation commit together and survive restart", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(20)]);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  assert.throws(() => f.view.db.transaction(() => {
    f.view.conversationEvents.deleteAfterSeq(threadId, 10);
    throw new Error("outer transaction failed");
  })(), /outer transaction failed/);
  assert.equal(f.view.conversationEvents.readRelayInvalidation(key), null);
  assert.deepEqual(f.view.conversationEvents.readRelayBatch(key, 10).events.map((row) => row.seq), [10, 20]);
  f.view.conversationEvents.deleteAfterSeq(threadId, 10);
  const pending = f.reopen().conversationEvents.readRelayInvalidation(key);
  assert.equal(pending?.threadId, threadId);
  assert.equal(pending?.throughSeq, 20);
  assert.deepEqual(f.view.conversationEvents.readRelayBatch(key, 10).events.map((row) => row.seq), [10]);
});

test("a late invalidation ACK cannot erase a newer deletion or its frozen high water", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(20), event(30)]);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  f.view.conversationEvents.deleteByThreadThroughSeq(threadId, 10, 1);
  const first = f.view.conversationEvents.readRelayInvalidation(key)!;
  assert.equal(first.throughSeq, 10);
  f.view.conversationEvents.deleteByThreadThroughSeq(threadId, 20, 1);
  const second = f.view.conversationEvents.readRelayInvalidation(key)!;
  assert.notEqual(first.invalidationId, second.invalidationId);
  assert.equal(f.view.conversationEvents.acknowledgeRelayInvalidation(key, first.invalidationId), false);
  assert.equal(f.view.conversationEvents.readRelayInvalidation(key)?.throughSeq, 20);
  assert.equal(f.view.conversationEvents.acknowledgeRelayInvalidation(key, second.invalidationId), true);
  assert.equal(f.view.conversationEvents.readRelayInvalidation(key), null);
  assert.deepEqual(f.view.conversationEvents.readRelayBatch(key, 10).events.map((row) => row.seq), [30]);
});

test("message deletion and hard thread removal retain only cache invalidation metadata", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope({ ...event(10), type: "item.userMessage.created",
    payload: { itemId: "message-a", text: "private-body" } } as ConversationEventEnvelope);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  f.view.conversationEvents.deleteMessage(threadId, "message-a");
  f.view.threads.delete(threadId);
  const pending = f.reopen().conversationEvents.readRelayInvalidation(key);
  assert.equal(pending?.throughSeq, 10);
  assert.equal(pending?.sharedWorkspaceId, scope.sharedWorkspaceId);
  const metadata = f.view.db.prepare("SELECT value FROM meta WHERE key LIKE 'conversation_relay:%'").all();
  assert.equal(JSON.stringify(metadata).includes("private-body"), false);
});

test("relay hydrates the latest diff and explicitly fails malformed envelopes or current snapshots", async (t) => {
  const f = setup(t);
  const diff = (seq: number, text: string) => ({ ...event(seq), type: "item.diff.created",
    payload: { itemId: "diff-a", turnId: "turn-a", diff: text } } as ConversationEventEnvelope);
  f.view.conversationEvents.appendEnvelopes([diff(10, "old"), diff(20, "latest")]);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  const batch = f.view.conversationEvents.readRelayBatch(key, 10);
  assert.deepEqual(batch.events.map((row) => [row.seq, (row.payload as { diff: string }).diff]), [[20, "latest"]]);
  f.view.db.prepare("UPDATE conversation_diff_snapshots SET diff_text = 'corrupted'").run();
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key, 10), (error) =>
    error instanceof Error && error.cause instanceof Error && /snapshot body mismatch/.test(error.cause.message));
  f.view.db.prepare("UPDATE conversation_diff_snapshots SET diff_sha256 = 'broken'").run();
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key, 10), (error) =>
    error instanceof Error && error.cause instanceof Error && /snapshot metadata mismatch/.test(error.cause.message));
  f.view.db.prepare("DELETE FROM conversation_diff_snapshots").run();
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key, 10), (error) =>
    error instanceof Error && error.cause instanceof Error && /snapshot missing/.test(error.cause.message));
  f.view.db.prepare("UPDATE conversation_events SET event_json = 'broken'").run();
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key, 10), /relay event read failed/);
});

test("relay rejects corrupt parent identity and progress metadata without silently skipping rows", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  const physicalPath = path.join(f.db.workspaces.get(workspaceId)!.path, ".codeflowai", "workspace.db");
  const corruptor = openSqliteDb(physicalPath);
  try { corruptor.prepare("UPDATE conversation_events SET workspace_id = 'other-workspace'").run(); }
  finally { corruptor.close(); }
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key), /relay event read failed/);
  const metadataKey = `conversation_relay:scope:${key}`;
  const row = f.view.db.prepare("SELECT value FROM meta WHERE key = ?").get(metadataKey) as { value: string };
  const progress = JSON.parse(row.value);
  progress.scope.userId = "another-user";
  f.view.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(progress), metadataKey);
  assert.throws(() => f.view.conversationEvents.readRelayBatch(key), /CONVERSATION_RELAY_SCOPE_METADATA_MISMATCH/);
});

for (const field of ["workspaceId", "sharedWorkspaceId", "threadId"] as const) {
  test(`corrupt invalidation ${field} cannot cross its registered scope or be acknowledged`, async (t) => {
    const f = setup(t);
    f.view.conversationEvents.appendEnvelope(event(10));
    const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
    f.view.conversationEvents.deleteByThread(threadId);
    f.view.threads.delete(threadId);
    const pending = f.view.conversationEvents.readRelayInvalidation(key)!;
    const row = f.view.db.prepare("SELECT key, value FROM meta WHERE key LIKE ?").get(`conversation_relay:invalidation:${key}:%`) as { key: string; value: string };
    const corrupted = { ...JSON.parse(row.value), [field]: "other-target" };
    f.view.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(corrupted), row.key);
    const sent: unknown[] = [];
    const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
      send(message) { sent.push(message); return { accepted: true }; } });
    await activateDemand(relay, [scope], 1);
    await assert.rejects(() => relay.flush(), /CONVERSATION_RELAY_INVALIDATION_SCOPE_MISMATCH/);
    assert.throws(() => f.view.conversationEvents.acknowledgeRelayInvalidation(key, pending.invalidationId), /CONVERSATION_RELAY_INVALIDATION_SCOPE_MISMATCH/);
    assert.deepEqual(sent, []);
    assert.equal((f.view.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key = ?").get(row.key) as { count: number }).count, 1);
    relay.dispose();
  });
}

test("relay stays idle without scopes and advances only the matching complete delivery ACK", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(11, personalId), event(20)]);
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", send(message) { sent.push(message); return { accepted: true }; } });
  await relay.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(f.view.db.prepare("SELECT key FROM meta WHERE key LIKE 'conversation_relay:%'").all(), []);
  await activateDemand(relay, [scope], 1);
  await relay.flush();
  const message = sent[0];
  assert.equal(message.t, "conversation.event.relay");
  assert.deepEqual(message.events.map((row: ConversationEventEnvelope) => row.seq), [10, 20]);
  const ack = { t: "conversation.eventRelayAck", seqs: [10, 20], delivery: message.delivery } as const;
  assert.equal(await relay.acceptAck({ ...ack, delivery: { ...message.delivery, deliveryId: "old" } }, 1), false);
  assert.equal(await relay.acceptAck(ack, 0), false);
  await assert.rejects(() => relay.acceptAck({ ...ack, seqs: [10] }, 1), /CONVERSATION_RELAY_ACK_INCOMPLETE/);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 0);
  assert.equal(await relay.acceptAck(ack, 1), true);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 20);
  await relay.flush();
  assert.equal(sent.length, 1);
});

test("reconnect invalidates the old flight and sends durable cleanup before retained events", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(20)]);
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  await relay.flush();
  const oldFlight = sent[0];
  f.view.conversationEvents.deleteAfterSeq(threadId, 10);
  relay.disconnect(1);
  await activateDemand(relay, [{ ...scope, hostScopeEpoch: 7 }], 2);
  await relay.flush();
  const cleanup = sent[1];
  assert.equal(cleanup.t, "thread.history.cleaned");
  assert.equal(cleanup.throughSeq, 20);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: oldFlight.delivery, seqs: [10, 20] }, 1), false);
  assert.equal(await relay.acceptAck({ ...cleanup, t: "thread.history.cleanedAck" }, 2), true);
  await relay.flush();
  assert.deepEqual(sent[2].events.map((row: ConversationEventEnvelope) => row.seq), [10]);
});

test("cleanup ACK preserves a newer mutation and rejected sends leave SQL progress pending", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelopes([event(10), event(20), event(30)]);
  const sent: any[] = [];
  let accepted = true;
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", send(message) { sent.push(message); return { accepted, reason: "unavailable" }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [scope], 1);
  f.view.conversationEvents.deleteByThreadThroughSeq(threadId, 10, 1);
  await relay.flush();
  const oldCleanup = sent[0];
  f.view.conversationEvents.deleteByThreadThroughSeq(threadId, 20, 1);
  await relay.acceptAck({ ...oldCleanup, t: "thread.history.cleanedAck" }, 1);
  accepted = false;
  await assert.rejects(() => relay.flush(), /CONVERSATION_RELAY_SEND_REJECTED/);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 0);
  assert.equal(f.view.conversationEvents.readRelayInvalidation(key)?.throughSeq, 20);
  accepted = true;
  await relay.flush();
  assert.equal(sent.at(-1).throughSeq, 20);
  assert.notEqual(sent.at(-1).invalidationId, oldCleanup.invalidationId);
});

test("duplicate scope receipts keep one flight and unbinding pauses delivery until authorized reconnect", async (t) => {
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", send(message) { sent.push(message); return { accepted: true }; } });
  await activateDemand(relay, [scope], 1);
  await relay.flush();
  await activateDemand(relay, [{ ...scope }], 1);
  await relay.flush();
  assert.equal(sent.length, 1);
  const first = sent[0];
  await activateDemand(relay, [], 1);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: first.delivery, seqs: [10] }, 1), false);
  await relay.flush();
  assert.equal(sent.length, 1);
  await activateDemand(relay, [{ ...scope, hostScopeEpoch: 7 }], 2);
  await relay.flush();
  const second = sent[1];
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: { ...second.delivery,
    scope: { ...scope, hostScopeEpoch: 4 } }, seqs: [10] }, 2), false);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: second.delivery, seqs: [10] }, 2), true);
});

test("a compacted diff page cannot stall delivery of its later authoritative snapshot", async (t) => {
  const f = setup(t);
  const diff = (seq: number) => ({ ...event(seq), type: "item.diff.created", payload: { itemId: "diff-a", diff: `body-${seq}` } } as ConversationEventEnvelope);
  f.view.conversationEvents.appendEnvelopes([diff(10), diff(20)]);
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test", batchSize: 1,
    send(message) { sent.push(message); return { accepted: true }; } });
  await activateDemand(relay, [scope], 1);
  await relay.flush();
  assert.equal(sent.length, 1);
  await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [] }, 1);
  await relay.flush();
  assert.deepEqual(sent[1].events.map((row: ConversationEventEnvelope) => row.seq), [20]);
  assert.equal(sent[1].events[0].payload.diff, "body-20");
  relay.dispose();
});

test("an unacknowledged flight expires once with context and remains pending for authorized reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = setup(t);
  f.view.conversationEvents.appendEnvelope(event(10));
  const sent: any[] = [];
  const failures: Array<{ error: Error; context: unknown }> = [];
  const relay = createLocalEventRelay({ db: f.db, serverUrl: "wss://server.test", ackTimeoutMs: 100,
    onError(error, context) { failures.push({ error, context }); }, send(message) { sent.push(message); return { accepted: true }; } });
  await activateDemand(relay, [scope], 1);
  await relay.flush();
  t.mock.timers.tick(99);
  assert.equal(failures.length, 0);
  t.mock.timers.tick(1);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.error.message, /CONVERSATION_RELAY_ACK_TIMEOUT/);
  assert.deepEqual(failures[0]!.context, { generation: 1, delivery: sent[0].delivery });
  await relay.flush();
  assert.equal(sent.length, 1);
  const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 0);
  await activateDemand(relay, [{ ...scope, hostScopeEpoch: 9 }], 2);
  await relay.flush();
  await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[1].delivery, seqs: [10] }, 2);
  t.mock.timers.tick(200);
  assert.equal(failures.length, 1);
  relay.dispose();
});

test("personal workspace relay requires demand delivery and advances its own cursor", async (t) => {
  const f = setup(t);
  const personalScope: ConversationRelayScope = { kind: "personal", userId: "user-a", enterpriseId: null,
    clientId: "relay-client", workspaceId };
  f.view.conversationEvents.appendEnvelope(event(1, personalId));
  const sent: any[] = [];
  const relay = createLocalEventRelay({ ...relayPolicy, db: f.db, serverUrl: "wss://server.test",
    send(message) { sent.push(message); return { accepted: true }; } });
  t.after(() => relay.dispose());
  await activateDemand(relay, [personalScope], 1);
  await relay.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].t, "conversation.event.relay");
  assert.equal(sent[0].delivery.scope.kind, "personal");
  assert.deepEqual(sent[0].events.map((item: any) => item.seq), [1]);
  assert.equal(await relay.acceptAck({ t: "conversation.eventRelayAck", delivery: sent[0].delivery, seqs: [1] }, 1), true);
  const key = conversationRelayScopeKey("wss://server.test", personalScope);
  assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 1);
  await relay.flush();
  assert.equal(sent.length, 1);
});

for (const action of ["disconnect", "unbind", "dispose"] as const) {
  test(`${action} clears the ACK timeout without advancing SQL progress`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = setup(t);
    f.view.conversationEvents.appendEnvelope(event(10));
    const failures: Error[] = [];
    const relay = createLocalEventRelay({ db: f.db, serverUrl: "wss://server.test", ackTimeoutMs: 100,
      onError(error) { failures.push(error); }, send() { return { accepted: true }; } });
    await activateDemand(relay, [scope], 1);
    await relay.flush();
    if (action === "disconnect") relay.disconnect(1);
    else if (action === "unbind") await activateDemand(relay, [], 1);
    else relay.dispose();
    t.mock.timers.tick(200);
    assert.deepEqual(failures, []);
    const key = f.view.conversationEvents.registerRelayScope("wss://server.test", scope);
    assert.equal(f.view.conversationEvents.readRelayBatch(key).cursor, 0);
    relay.dispose();
  });
}
