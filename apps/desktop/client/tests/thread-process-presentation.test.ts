import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { syncBuiltinESMExports } from "node:module";
import { applyEngineEventToConversation, createConversationState, getConversationProcessGroups, snapshotConversationState } from "@codeflowai/shared";
import type { ClientToServerMessage, ConversationEventEnvelope, DesktopApiRequest, ItemId, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { ConversationPresentationStore, createConversationPresentationTables } from "../src/db/conversationPresentation.js";

/** 每个用例使用独立本地 SQLite，避免触碰用户工作区。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-presentation-"));
  const db = openClientDb({ dbPath: path.join(directory, "app.db"), localCanonicalEvents: true });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "workspace" as WorkspaceId, threadId = "thread" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "projection", path: directory });
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "projection" });
  let seq = 0;
  /** 沿 canonical 统一入口追加真实事件。 */
  const append = (type: string, payload: unknown) => db.conversationEvents.appendEnvelope({
    schema: 1, seq: ++seq, ts: seq, engine: "codex", workspaceId, threadId, type, payload,
  } as ConversationEventEnvelope);
  append("item.userMessage.created", { itemId: "user", text: "hello" });
  append("turn.started", { turnId: "turn" });
  return { db, threadId, append };
}

/** 用完整历史的 shared reducer 校验局部持久投影，不复用被测增量入口。 */
function assertFullReducerProjection(f: ReturnType<typeof fixture>): void {
  const state = createConversationState(f.threadId);
  const events = f.db.db.prepare("SELECT event_json FROM conversation_events WHERE thread_id = ? ORDER BY seq")
    .all(f.threadId) as Array<{ event_json: string }>;
  for (const event of events) applyEngineEventToConversation(state, JSON.parse(event.event_json) as ConversationEventEnvelope);
  const rows = f.db.db.prepare("SELECT item_json, position, process_id FROM conversation_presentation_items WHERE thread_id = ? ORDER BY position")
    .all(f.threadId) as Array<{ item_json: string; position: number; process_id: string | null }>;
  const processIds = new Map(getConversationProcessGroups(state.items).flatMap(group => group.items.map(item => [String(item.id), group.processId] as const)));
  assert.deepEqual(rows.map(row => JSON.parse(row.item_json)), JSON.parse(JSON.stringify(state.items)));
  assert.deepEqual(rows.map(row => row.position), state.items.map((_, index) => index));
  assert.deepEqual(rows.map(row => row.process_id), state.items.map(item => processIds.get(String(item.id)) ?? null));
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId).state, snapshotConversationState(state));
}

test("首屏展示不读取 canonical 或过程正文，增量只 hydrate 目标条目", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "reason", delta: "private-process-".repeat(100) });
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "visible answer" });
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const queries: string[] = [], prepare = f.db.db.prepare.bind(f.db.db);
  t.mock.method(f.db.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  assert.deepEqual(presentation.items.map(item => item.kind), ["message", "process", "message"]);
  assert.ok(!JSON.stringify(presentation).includes("private-process-".repeat(20)));
  assert.ok(queries.every(sql => !/event_json/i.test(sql) && (!/item_json/i.test(sql) || /process_id IS NULL/i.test(sql))), queries.join("\n"));
  queries.length = 0;
  f.append("item.reasoning.delta", { itemId: "reason", delta: "updated" });
  assert.ok(queries.filter(sql => /SELECT.*item_json/is.test(sql)).every(sql => /item_id\s*=\s*\?/i.test(sql)), queries.join("\n"));
  const details = f.db.conversationEvents.readProcess(f.threadId, "process:reason");
  assert.equal(details.items.length, 1);
  assert.equal((details.items[0] as any).content, "private-process-".repeat(100) + "updated");
});

test("固定版本分页期间修改前页条目不漏后页，并能按版本补读完整快照", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "a", delta: "A" });
  f.append("item.tool.started", { itemId: "b", toolName: "shell", input: { command: "npm test" } });
  f.append("item.reasoning.delta", { itemId: "c", delta: "C" });
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const first = f.db.conversationEvents.readProcess(f.threadId, "process:a", { limit: 1 });
  assert.deepEqual(first.items.map(item => item.id), ["a"]);
  f.append("item.reasoning.delta", { itemId: "a", delta: "2" });
  f.append("item.tool.outputDelta", { itemId: "b", delta: "output" });
  const rest = f.db.conversationEvents.readProcess(f.threadId, "process:a", { cursor: first.nextCursor!, throughSeq: first.version, limit: 10 });
  assert.deepEqual(rest.items.map(item => item.id), ["b", "c"]);
  const changed = f.db.conversationEvents.readProcess(f.threadId, "process:a", { afterSeq: first.version });
  assert.deepEqual(changed.items.map(item => item.id), ["a", "b"]);
  assert.equal((changed.items[0] as any).content, "A2");
});

test("删除、回滚、批量 ACK 和投影失败保持 canonical 一致", async t => {
  const f = fixture(t);
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "answer" });
  f.append("item.reasoning.delta", { itemId: "reason", delta: "reason" });
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  f.db.conversationEvents.deleteMessage(f.threadId, "answer");
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.ok(!f.db.conversationEvents.readPresentation(f.threadId).items.some(item => item.id === "answer" as ItemId));
  f.db.conversationEvents.deleteAfterSeq(f.threadId, 2);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.ok(!f.db.conversationEvents.readPresentation(f.threadId).items.some(item => item.kind === "process"));
  const failure = new Error("projection failure"), prepare = f.db.db.prepare.bind(f.db.db);
  t.mock.method(f.db.db, "prepare", (sql: string) => {
    if (/INSERT INTO conversation_presentation_items/i.test(sql)) throw failure;
    return prepare(sql);
  });
  assert.throws(() => f.append("item.reasoning.delta", { itemId: "fail", delta: "bad" }), failure);
  assert.equal(f.db.conversationEvents.getLatestSeqByThread(f.threadId), 2);
});

test("旧会话分批重建，后续热读复用索引", async t => {
  const f = fixture(t);
  for (let i = 0; i < 270; i++) f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  let yielded = false;
  const pending = f.db.conversationEvents.ensurePresentation(f.threadId);
  await new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  await pending;
  assert.equal(yielded, true);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "x".repeat(270));
});

test("中断重建后从已提交水位续接，不删除已处理的投影", async t => {
  const f = fixture(t);
  for (let i = 0; i < 600; i++) f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  let batches = 0;
  const interrupted = new Error("interrupted between batches");
  await assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId, { withDatabase: async operation => {
    if (++batches === 4) throw interrupted;
    return operation();
  } }), interrupted);
  const checkpoint = f.db.db.prepare("SELECT version, ready FROM conversation_presentations WHERE thread_id = ?").get(f.threadId) as { version: number; ready: number };
  assert.equal(checkpoint.ready, 0);
  assert.ok(checkpoint.version > 0 && checkpoint.version < 602);
  const restored: number[] = [];
  await new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => { restored.push(event.seq); return event; }, () => []);
  assert.equal(restored[0], checkpoint.version + 1);
  assert.equal(restored.length, 602 - checkpoint.version);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "x".repeat(600));
  assertFullReducerProjection(f);
});

test("检查点写入失败原子回滚，重试从提交水位恢复完整正文", async t => {
  const f = fixture(t);
  for (let index = 0; index < 600; index++) f.append("item.tool.outputDelta", { itemId: "tool", toolName: "shell", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  const prepare = f.db.db.prepare.bind(f.db.db), failure = new Error("checkpoint state write failed");
  const fault = t.mock.method(f.db.db, "prepare", (sql: string) => {
    if (/UPDATE conversation_presentations SET version = \?, state_json = \?, ready/i.test(sql)) throw failure;
    return prepare(sql);
  });
  await assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId), error => error === failure);
  fault.mock.restore();
  const checkpoint = f.db.db.prepare("SELECT version,ready FROM conversation_presentations WHERE thread_id = ?").get(f.threadId) as { version: number; ready: number };
  assert.deepEqual(checkpoint, { version: 0, ready: 0 });
  assert.equal((f.db.db.prepare("SELECT count(*) AS n FROM conversation_presentation_items WHERE thread_id = ?").get(f.threadId) as { n: number }).n, 0);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:tool").items[0] as any).output, "x".repeat(600));
  assertFullReducerProjection(f);
});

test("冷归并合并增量仍保留首次时间戳、replace顺序与删除事实", async t => {
  const f = fixture(t);
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "hello" });
  f.append("item.agentMessage.delta", { itemId: "answer", delta: " world" });
  f.append("item.tool.outputDelta", { itemId: "tool", toolName: "shell", delta: "discard" });
  f.append("item.tool.outputDelta", { itemId: "tool", toolName: "shell", delta: "keep", mode: "replace" });
  f.append("item.tool.outputDelta", { itemId: "tool", toolName: "shell", delta: " end" });
  f.append("item.reasoning.started", { itemId: "placeholder" });
  f.append("item.agentMessage.delta", { itemId: "after", delta: "shown" });
  f.append("item.agentMessage.delta", { itemId: "after", delta: " latest" });
  f.db.conversationEvents.deleteMessage(f.threadId, "answer");
  f.append("item.message.deleted", { itemId: "answer" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  assert.ok(!presentation.items.some(item => item.id === "answer" as ItemId));
  const message = presentation.items.find(item => item.id === "after" as ItemId) as any;
  assert.equal(message.text, "shown latest");
  assert.equal(message.createdAt, 9);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:tool").items[0] as any).output, "keep end");
  assertFullReducerProjection(f);
});

test("冷归并不跨增量元数据变化压缩，乱序时间戳仍与逐条归并一致", async t => {
  const f = fixture(t);
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "first", delta: "a" });
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "second", delta: "b" });
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "second", delta: "c" });
  f.append("item.agentMessage.delta", { itemId: "timed", engineMessageId: "timed", delta: "d" });
  f.append("item.agentMessage.delta", { itemId: "timed", engineMessageId: "timed", delta: "e" });
  const row = f.db.db.prepare("SELECT event_json FROM conversation_events WHERE seq = 7").get() as { event_json: string };
  const event = { ...JSON.parse(row.event_json), ts: 1 };
  f.db.db.prepare("UPDATE conversation_events SET event_json = ?, ts = ? WHERE seq = 7").run(JSON.stringify(event), 1);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assertFullReducerProjection(f);
  const message = f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "answer" as ItemId) as any;
  assert.equal(message.text, "a");
  assert.equal(message.engineMessageId, "first");
  assert.equal((f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "timed" as ItemId) as any).createdAt, 1);
});

test("慢事件重建按时间让出，不能等满256条才释放事务", async t => {
  const f = fixture(t);
  for (let i = 0; i < 270; i++) f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  let clock = 0;
  const timer = t.mock.method(performance, "now", () => clock);
  const pending = new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => { clock += 2; return event; }, () => []);
  const firstCheckpoint = await new Promise<number>(resolve => setImmediate(() => {
    const row = f.db.db.prepare("SELECT version FROM conversation_presentations WHERE thread_id = ?").get(f.threadId) as { version: number };
    resolve(row.version);
  }));
  await pending;
  timer.mock.restore();
  assert.ok(firstCheckpoint > 0 && firstCheckpoint <= 16, `首批已模拟消耗 ${firstCheckpoint * 2}ms，必须及时让出`);
  assertFullReducerProjection(f);
});

test("两个重建实例不能重复归并同一提交水位之后的增量", async t => {
  const f = fixture(t);
  for (let i = 0; i < 300; i++) f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  let release!: () => void, claimed!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { claimed = resolve; });
  const first = new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => event, () => [], { withDatabase: async operation => {
    if (++calls === 3) { claimed(); await gate; }
    return operation();
  } });
  const rejected = assert.rejects(first, /THREAD_PRESENTATION_BUILD_INVALIDATED/);
  await ready;
  try { await new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => event, () => []); }
  finally { release(); }
  await rejected;
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "x".repeat(300));
  assertFullReducerProjection(f);
});

test("等待准入时另一实例已完成，直接复用投影而不再次重建", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  let release!: () => void, waiting!: () => void, calls = 0, replayed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { waiting = resolve; });
  const first = new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => { replayed++; return event; }, () => [], { withDatabase: async operation => {
    if (++calls === 2) { waiting(); await gate; }
    return operation();
  } });
  await ready;
  try { await new ConversationPresentationStore(f.db.db).rebuild(f.threadId, event => event, () => []); }
  finally { release(); }
  await first;
  assert.equal(replayed, 0);
  assertFullReducerProjection(f);
});

test("重建连续稳定增量与完整 reducer 保持一致", async t => {
  const f = fixture(t);
  for (let index = 0; index < 620; index++) f.append("item.reasoning.delta", { itemId: "reason", delta: String(index % 10) });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const content = (f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content;
  assert.equal(content, Array.from({ length: 620 }, (_, index) => String(index % 10)).join(""));
  assertFullReducerProjection(f);
});

test("重建跨条目和终态事件保留原 reducer 顺序", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "a", delta: "before" });
  f.append("item.reasoning.delta", { itemId: "b", delta: "middle" });
  f.append("item.reasoning.delta", { itemId: "a", delta: "after" });
  f.append("turn.completed", { turnId: "turn" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assertFullReducerProjection(f);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:a").items[0] as any).content, "beforeafter");
});

test("本机 lazy load 和展开 API 无需登录，热读不执行 Git、DDL 或过程正文读取", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-presentation-api-"));
  const root = path.join(directory, "workspace");
  fs.mkdirSync(root);
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  const db = openClientDb({ dbPath: path.join(directory, "app.db"), localCanonicalEvents: true });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "client:workspace" as WorkspaceId, threadId = "thread" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "workspace", path: root });
  const writer = db.forWorkspace(workspaceId);
  writer.threads.create({ id: threadId, workspaceId, engine: "codex", title: "thread" });
  writer.conversationEvents.appendEnvelopes([
    { schema: 1, seq: 1, ts: 1, workspaceId, threadId, engine: "codex", type: "item.reasoning.delta", payload: { itemId: "reason", delta: "private" } },
    { schema: 1, seq: 2, ts: 2, workspaceId, threadId, engine: "codex", type: "item.agentMessage.delta", payload: { itemId: "answer" as ItemId, delta: "answer" } },
  ]);
  writer.db.exec(`DROP TABLE conversation_presentation_items;
    DROP TABLE conversation_presentations;
    DELETE FROM meta WHERE key = 'conversation_presentation_schema_version';`);
  await db.ensureThreadPresentation(workspaceId, threadId);
  assert.equal(db.forWorkspace(workspaceId, { readonly: true }).conversationEvents.readPresentation(threadId).items[0]!.kind, "process");
  const ctx = { db, clientId: "client", workspaces: new Map([[workspaceId, root]]), threads: new ThreadStore(), send(_message: ClientToServerMessage) {} } as ApiHandlerContext;
  const queries: string[] = [], originalPrepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) { queries.push(sql); return originalPrepare.call(this, sql); });
  const originalSpawn = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof originalSpawn>) => {
    assert.notEqual(args[0], "git", "热读不能执行 Git");
    return (originalSpawn as (...args: any[]) => unknown)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  /** 请求经桌面白名单及可信工作区校验，不构造账号或 Server 会话。 */
  const request = (method: DesktopApiRequest["method"], body: Record<string, unknown> = {}) => executeDesktopApiRequest(ctx,
    { method, body: { workspaceId, threadId, ...body } } as DesktopApiRequest,
    { requestId: "process-api", startedAt: 1, clientVersion: "1.0.0" });
  const loaded = await request("threads.load", { presentation: "lazy" });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.deepEqual((loaded.body as any).events, []);
  assert.equal((loaded.body as any).presentation.items[0].kind, "process");
  assert.ok(queries.every(sql => !/event_json|\bCREATE\b|\bALTER\b/i.test(sql)
    && (!/item_json/i.test(sql) || /process_id IS NULL/i.test(sql))), queries.join("\n"));
  const summary = await request("threads.presentation");
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  const expanded = await request("threads.process", { processId: "process:reason" });
  assert.equal(expanded.status, 200, JSON.stringify(expanded.body));
  assert.equal((expanded.body as any).items[0].content, "private");
});

test("乱序 ACK 使投影失效，重建保留顺序及工具终态完整输出", async t => {
  const f = fixture(t);
  f.append("item.tool.started", { itemId: "tool", toolName: "shell", input: {} });
  f.append("item.tool.outputDelta", { itemId: "tool", delta: "large output".repeat(100) });
  f.append("turn.completed", { turnId: "turn" });
  const terminal = f.db.conversationEvents.readProcess(f.threadId, "process:tool");
  assert.ok((terminal.items[0] as any).output.startsWith("large output".repeat(100)));
  assert.equal((terminal.items[0] as any).status, "incomplete");
  f.db.conversationEvents.appendEnvelopes([
    { schema: 1, seq: 50, ts: 50, workspaceId: "workspace" as WorkspaceId, threadId: f.threadId, engine: "codex", type: "thread.started", payload: { sessionId: "session" } },
    { schema: 1, seq: 40, ts: 40, workspaceId: "workspace" as WorkspaceId, threadId: f.threadId, engine: "codex", type: "thread.started", payload: { sessionId: "earlier" } },
  ]);
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), false);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.equal(f.db.conversationEvents.readPresentation(f.threadId).state.engineSessionId, "session");
});

test("迟到子任务保留 reducer 顺序，分页稳定且返回完整成员顺序", async t => {
  const f = fixture(t);
  f.append("item.tool.started", { itemId: "tool", toolName: "Task", input: {} });
  f.append("item.reasoning.delta", { itemId: "reason", delta: "reason" });
  const first = f.db.conversationEvents.readProcess(f.threadId, "process:tool", { limit: 1 });
  f.append("item.subagent.started", { itemId: "sub", toolUseId: "tool", taskId: "task", description: "child" });
  const rest = f.db.conversationEvents.readProcess(f.threadId, "process:tool", { cursor: first.nextCursor!, throughSeq: first.version });
  assert.deepEqual(rest.items.map(item => item.id), ["reason"]);
  assert.deepEqual(rest.itemOrder, ["tool", "sub", "reason"]);
  const next = f.db.conversationEvents.readProcess(f.threadId, "process:tool", { afterSeq: first.version });
  assert.deepEqual(next.items.map(item => item.id), ["sub", "reason"]);
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:tool").items.map(item => item.id), ["tool", "sub", "reason"]);
});

test("分批构建接续实时追加；期间裁剪显式中止并允许下次重建", async t => {
  const f = fixture(t);
  for (let i = 0; i < 270; i++) f.append("item.reasoning.delta", { itemId: "reason", delta: "x" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  const pending = f.db.conversationEvents.ensurePresentation(f.threadId);
  await new Promise<void>(resolve => setImmediate(() => { f.append("item.reasoning.delta", { itemId: "reason", delta: "live" }); resolve(); }));
  await pending;
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "x".repeat(270) + "live");
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  const invalidated = assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId), /THREAD_PRESENTATION_BUILD_INVALIDATED/);
  await new Promise<void>(resolve => setImmediate(() => { f.db.conversationEvents.deleteAfterSeq(f.threadId, 2); resolve(); }));
  await invalidated;
  assert.throws(() => f.db.conversationEvents.readPresentation(f.threadId), /NOT_READY/);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId).items.map(item => item.kind), ["message"]);
});

test("分页游标成员被裁剪后明确失效，不跳过或伪造成功", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "a", delta: "a" });
  f.append("item.reasoning.delta", { itemId: "b", delta: "b" });
  f.append("item.reasoning.delta", { itemId: "c", delta: "c" });
  const first = f.db.conversationEvents.readProcess(f.threadId, "process:a", { limit: 2 });
  f.db.conversationEvents.deleteAfterSeq(f.threadId, 3);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.throws(() => f.db.conversationEvents.readProcess(f.threadId, "process:a", { cursor: first.nextCursor! }), /THREAD_PROCESS_CURSOR_INVALIDATED/);
});

test("损坏的旧 canonical 事件显式构建失败，不返回空展示", async t => {
  const f = fixture(t);
  f.db.db.prepare("UPDATE conversation_events SET event_json = '{}' WHERE thread_id = ? AND seq = 1").run(f.threadId);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId), /THREAD_PRESENTATION_EVENT_INVALID/);
  assert.throws(() => f.db.conversationEvents.readPresentation(f.threadId), /NOT_READY/);
});

test("删除分隔正文后过程合并，删除事件提升版本以补读新归属成员", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "a", delta: "a" });
  f.append("item.agentMessage.delta", { itemId: "separator", delta: "separator" });
  f.append("item.reasoning.delta", { itemId: "b", delta: "b" });
  f.append("item.reasoning.delta", { itemId: "a", delta: "newer" });
  const previous = f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "process" && item.id === "process:a");
  assert.equal(previous?.kind, "process");
  f.db.conversationEvents.deleteMessage(f.threadId, "separator");
  f.append("item.message.deleted", { itemId: "separator" });
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const current = f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "process" && item.id === "process:a");
  assert.equal(current?.kind, "process");
  assert.ok(current!.kind === "process" && previous!.kind === "process" && current.version > previous.version);
  const expanded = f.db.conversationEvents.readProcess(f.threadId, "process:a", { afterSeq: previous!.kind === "process" ? previous.version : 0 });
  assert.deepEqual(expanded.items.map(item => item.id), ["a", "b"]);
});

test("旧 aggregate diff 允许已替换快照，最新正文完整恢复且缺失时显式失败", async t => {
  const f = fixture(t);
  f.append("item.diff.created", { itemId: "diff", turnId: "turn", title: "changes", diff: "old patch" });
  f.append("item.diff.created", { itemId: "diff", turnId: "turn", title: "changes", diff: "latest patch" });
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:diff").items[0] as any).diff, "latest patch");
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  f.db.db.prepare("UPDATE conversation_diff_snapshots SET diff_text = 'corrupted' WHERE thread_id = ?").run(f.threadId);
  await assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId), /THREAD_PRESENTATION_DIFF_SNAPSHOT_CORRUPTED/);
  f.db.db.prepare("DELETE FROM conversation_diff_snapshots WHERE thread_id = ?").run(f.threadId);
  await assert.rejects(f.db.conversationEvents.ensurePresentation(f.threadId), /THREAD_PRESENTATION_DIFF_SNAPSHOT_MISSING/);
  assert.throws(() => f.db.conversationEvents.readPresentation(f.threadId), /NOT_READY/);
});

test("同轮 aggregate 使用不同 itemId 时实时和重建都只展示最新卡片", async t => {
  const f = fixture(t);
  f.append("item.diff.created", { itemId: "old-diff", turnId: "turn", title: "changes", diff: "old patch" });
  f.append("item.diff.created", { itemId: "new-diff", turnId: "turn", title: "changes", diff: "new patch" });
  const live = f.db.conversationEvents.readProcess(f.threadId, "process:new-diff");
  assert.deepEqual(live.items.map(item => item.id), ["new-diff"]);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const restored = f.db.conversationEvents.readProcess(f.threadId, "process:new-diff");
  assert.deepEqual(restored.items.map(item => item.id), ["new-diff"]);
  assert.equal((restored.items[0] as any).diff, "new patch");
});

test("空助手正文开始输出拆分过程时，两段摘要版本均变化并清除旧成员", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "a", delta: "a" });
  f.append("item.agentMessage.started", { itemId: "separator" });
  f.append("item.reasoning.delta", { itemId: "b", delta: "b" });
  const previous = f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "process");
  f.append("item.agentMessage.delta", { itemId: "separator", delta: "visible" });
  const processes = f.db.conversationEvents.readPresentation(f.threadId).items.filter(item => item.kind === "process");
  assert.deepEqual(processes.map(item => item.id), ["process:a", "process:b"]);
  assert.ok(previous?.kind === "process" && processes.every(item => item.kind === "process" && item.version > previous.version));
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:a").itemOrder, ["a"]);
});

test("稳定推理增量不读取历史 stub，完整重建保留相同正文与过程版本", async t => {
  const f = fixture(t);
  for (let index = 0; index < 80; index++) f.append("item.agentMessage.completed", { itemId: `history-${index}`, text: "history" });
  f.append("item.reasoning.delta", { itemId: "reason", delta: "before" });
  let historyRows = 0;
  const prepare = f.db.db.prepare.bind(f.db.db);
  const monitor = t.mock.method(f.db.db, "prepare", (sql: string) => new Proxy(prepare(sql), {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        if (property === "all" && /SELECT[\s\S]*stub_json/i.test(sql)) historyRows += result.length;
        return result;
      };
    },
  }));
  f.append("item.reasoning.delta", { itemId: "reason", delta: "after" });
  f.append("item.reasoning.summaryDelta", { itemId: "reason", delta: "summary" });
  f.append("item.reasoning.summaryBoundary", { itemId: "reason" });
  assert.ok(historyRows <= 3, `稳定目标增量不应读取历史，实际 ${historyRows} rows`);
  monitor.mock.restore();
  assertFullReducerProjection(f);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  const process = f.db.conversationEvents.readProcess(f.threadId, "process:reason");
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), presentation);
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:reason"), process);
});

test("稳定助手正文增量不读取历史 stub，切换引擎消息和清理占位仍与重建等价", async t => {
  const f = fixture(t);
  for (let index = 0; index < 80; index++) f.append("item.agentMessage.completed", { itemId: `history-${index}`, text: "history" });
  f.append("item.reasoning.delta", { itemId: "before", delta: "reason" });
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "first", delta: "visible" });
  f.append("item.reasoning.delta", { itemId: "after", delta: "reason" });
  const queries: string[] = [], prepare = f.db.db.prepare.bind(f.db.db);
  const monitor = t.mock.method(f.db.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "first", delta: " appended" });
  assert.ok(!queries.some(sql => /SELECT[\s\S]*stub_json[\s\S]*ORDER BY position/i.test(sql)), queries.join("\n"));
  monitor.mock.restore();
  assertFullReducerProjection(f);
  f.append("item.reasoning.started", { itemId: "placeholder" });
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "first", delta: " cleared" });
  assert.equal(prepare("SELECT 1 FROM conversation_presentation_items WHERE item_id = 'placeholder'").get(), undefined);
  f.append("item.agentMessage.delta", { itemId: "answer", engineMessageId: "second", delta: "" });
  assertFullReducerProjection(f);
  f.append("item.agentMessage.started", { itemId: "answer", engineMessageId: "second", phase: "final_answer" });
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId).items.filter(item => item.kind === "process").map(item => item.id), ["process:before"]);
  assertFullReducerProjection(f);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  const process = f.db.conversationEvents.readProcess(f.threadId, "process:before");
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), presentation);
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:before"), process);
});

test("同ID工具转为助手后，后续增量修复过程归属并展示完整正文", async t => {
  const f = fixture(t);
  f.append("item.tool.started", { itemId: "same", toolName: "shell", input: { command: "echo x" } });
  f.append("item.agentMessage.delta", { itemId: "same", engineMessageId: "message", delta: "hello" });
  f.append("item.agentMessage.delta", { itemId: "same", engineMessageId: "message", delta: " world" });
  const row = f.db.db.prepare("SELECT process_id FROM conversation_presentation_items WHERE thread_id = ? AND item_id = ?")
    .get(f.threadId, "same") as { process_id: string | null };
  assert.equal(row.process_id, null);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  const message = presentation.items.find(item => item.kind === "message" && item.id === "same");
  assert.equal(message?.kind === "message" ? message.text : null, "hello world");
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), presentation);
});

test("稳定工具输出只读目标，追加与替换同步完整正文、展示摘要和过程版本", async t => {
  const f = fixture(t);
  for (let index = 0; index < 80; index++) f.append("item.agentMessage.completed", { itemId: `history-${index}`, text: "history" });
  f.append("item.tool.started", { itemId: "tool", toolName: "shell", input: { command: "echo result" } });
  f.append("item.tool.started", { itemId: "review", toolName: "enteredReviewMode", input: {} });
  const initialVersion = f.db.conversationEvents.readPresentation(f.threadId).version;
  const queries: string[] = [], prepare = f.db.db.prepare.bind(f.db.db);
  const monitor = t.mock.method(f.db.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  f.append("item.tool.outputDelta", { itemId: "tool", delta: "first", summary: "working" });
  f.append("item.tool.outputDelta", { itemId: "tool", toolName: "shell", delta: " second" });
  f.append("item.tool.outputDelta", { itemId: "tool", mode: "replace", delta: "final", summary: "finished", changes: [{ path: "a.ts", kind: "modified" }] });
  f.append("item.tool.outputDelta", { itemId: "review", delta: "Review details" });
  assert.ok(!queries.some(sql => /SELECT[\s\S]*stub_json[\s\S]*ORDER BY position/i.test(sql)), queries.join("\n"));
  monitor.mock.restore();
  const process = f.db.conversationEvents.readProcess(f.threadId, "process:tool", { afterSeq: initialVersion });
  assert.deepEqual(process.items.map(item => item.id), ["tool", "review"]);
  assert.equal((process.items[0] as any).output, "final");
  assert.equal((process.items[0] as any).summary, "finished");
  assert.deepEqual((process.items[0] as any).changes, [{ path: "a.ts", kind: "modified" }]);
  assertFullReducerProjection(f);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), presentation);
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:tool", { afterSeq: initialVersion }), process);
});

test("工具增量的迟到创建、类型切换与全局占位删除仍遵循完整 reducer", async t => {
  const f = fixture(t);
  f.append("item.tool.outputDelta", { itemId: "late", delta: "before started" });
  f.append("item.tool.outputDelta", { itemId: "late", delta: " appended" });
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:late").items[0] as any).status, "started");
  f.append("item.tool.started", { itemId: "late", toolName: "shell", input: { command: "cat file" } });
  f.append("item.tool.outputDelta", { itemId: "late", delta: "read" });
  f.append("item.reasoning.started", { itemId: "placeholder" });
  f.append("item.tool.outputDelta", { itemId: "late", delta: "cleared" });
  assert.equal(f.db.db.prepare("SELECT 1 FROM conversation_presentation_items WHERE item_id = 'placeholder'").get(), undefined);
  f.append("item.tool.outputDelta", { itemId: "late", toolName: "update_plan", delta: "todo" });
  assert.equal(f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "late")?.kind, "tool");
  f.append("item.tool.outputDelta", { itemId: "late", delta: " more todo" });
  assert.equal((f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "late") as any).todolistText, "todo more todo");
  f.append("item.tool.outputDelta", { itemId: "late", toolName: "enteredReviewMode", delta: "review" });
  f.append("item.tool.started", { itemId: "dynamic", toolName: "shell", input: {} });
  f.append("item.tool.outputDelta", { itemId: "dynamic", mode: "replace", delta: '{"command":"cat file"}' });
  f.append("item.tool.outputDelta", { itemId: "dynamic", mode: "replace", delta: '{"command":"echo result"}' });
  assertFullReducerProjection(f);
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "answer" });
  const queries: string[] = [], prepare = f.db.db.prepare.bind(f.db.db);
  const monitor = t.mock.method(f.db.db, "prepare", (sql: string) => { queries.push(sql); return prepare(sql); });
  f.append("item.tool.outputDelta", { itemId: "answer", toolName: "shell", delta: "type changed" });
  assert.ok(queries.some(sql => /SELECT[\s\S]*stub_json[\s\S]*ORDER BY position/i.test(sql)));
  monitor.mock.restore();
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), presentation);
});

test("稳定工具增量的写失败和事务回滚不留下正文或过程版本", async t => {
  const f = fixture(t);
  f.append("item.tool.started", { itemId: "tool", toolName: "shell", input: {} });
  f.append("item.tool.outputDelta", { itemId: "tool", delta: "before" });
  const before = f.db.conversationEvents.readPresentation(f.threadId);
  const latestSeq = f.db.conversationEvents.getLatestSeqByThread(f.threadId);
  const failure = new Error("tool projection write failure"), prepare = f.db.db.prepare.bind(f.db.db);
  const monitor = t.mock.method(f.db.db, "prepare", (sql: string) => {
    if (/UPDATE conversation_presentation_items SET updated_seq/i.test(sql)) throw failure;
    return prepare(sql);
  });
  assert.throws(() => f.append("item.tool.outputDelta", { itemId: "tool", delta: "failed" }), error => error === failure);
  monitor.mock.restore();
  assert.equal(f.db.conversationEvents.getLatestSeqByThread(f.threadId), latestSeq);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), before);
  f.db.db.pragma("query_only = ON");
  try { assert.throws(() => f.append("item.tool.outputDelta", { itemId: "tool", delta: "readonly" }), /readonly/i); }
  finally { f.db.db.pragma("query_only = OFF"); }
  assert.equal(f.db.conversationEvents.getLatestSeqByThread(f.threadId), latestSeq);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), before);
  assert.throws(() => f.db.db.transaction(() => {
    f.append("item.tool.outputDelta", { itemId: "tool", mode: "replace", delta: "rolled back", summary: "not committed" });
    throw failure;
  })(), error => error === failure);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), before);
  f.append("item.tool.outputDelta", { itemId: "tool", delta: "committed" });
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:tool").items[0] as any).output, "beforecommitted");
  assertFullReducerProjection(f);
});

test("稳定推理增量在事务回滚后不残留正文或摘要派生状态", async t => {
  const f = fixture(t);
  f.append("item.reasoning.delta", { itemId: "reason", delta: "before" });
  const before = f.db.conversationEvents.readPresentation(f.threadId);
  const failure = new Error("synthetic projection transaction failure");
  assert.throws(() => f.db.db.transaction(() => {
    f.append("item.reasoning.delta", { itemId: "reason", delta: "rolled back" });
    f.append("item.reasoning.summaryDelta", { itemId: "reason", delta: "rolled back summary" });
    throw failure;
  })(), error => error === failure);
  assert.deepEqual(f.db.conversationEvents.readPresentation(f.threadId), before);
  f.append("item.reasoning.delta", { itemId: "reason", delta: "committed" });
  const process = f.db.conversationEvents.readProcess(f.threadId, "process:reason");
  assert.equal((process.items[0] as any).content, "beforecommitted");
  assert.equal((process.items[0] as any).summary, undefined);
  assertFullReducerProjection(f);
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.deepEqual(f.db.conversationEvents.readProcess(f.threadId, "process:reason"), process);
});

test("长正文历史不参与单条过程增量的数据库传输，首屏仍保留完整消息", async t => {
  const f = fixture(t);
  const text = "历史正文".repeat(2500);
  for (let index = 0; index < 20; index++) f.append("item.agentMessage.completed", { itemId: `answer-${index}`, text });
  f.append("item.reasoning.delta", { itemId: "reason", delta: "before" });
  let transferBytes = 0;
  const prepare = f.db.db.prepare.bind(f.db.db);
  t.mock.method(f.db.db, "prepare", (sql: string) => new Proxy(prepare(sql), {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "run") transferBytes += Buffer.byteLength(JSON.stringify(args), "utf8");
        const result = value.apply(target, args);
        if (property === "all" || property === "get") transferBytes += Buffer.byteLength(JSON.stringify(result) ?? "", "utf8");
        return result;
      };
    },
  }));
  f.append("item.reasoning.delta", { itemId: "reason", delta: "after" });
  assert.ok(transferBytes < 64_000, `单条短增量不应传输整段历史，实际 ${transferBytes} bytes`);
  const presentation = f.db.conversationEvents.readPresentation(f.threadId);
  assert.equal(presentation.items.filter(item => item.kind === "message" && item.role === "assistant").length, 20);
  assert.equal((presentation.items.find(item => item.id === "answer-0" as ItemId) as any).text, text);
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "beforeafter");
});

for (const missingBuildId of [true, false]) test(`旧格式投影升级补齐结构并按事实重建，缺失 build_id=${missingBuildId}`, async t => {
  const f = fixture(t);
  f.append("item.agentMessage.completed", { itemId: "answer", text: "完整正文" });
  f.append("item.reasoning.delta", { itemId: "reason", delta: "完整过程" });
  f.db.db.prepare("UPDATE meta SET value = '1' WHERE key = 'conversation_presentation_schema_version'").run();
  f.db.db.prepare("UPDATE conversation_presentations SET schema_version = 1, ready = 1").run();
  if (missingBuildId) f.db.db.exec("ALTER TABLE conversation_presentations DROP COLUMN build_id");
  const canonical = f.db.db.prepare("SELECT * FROM conversation_events ORDER BY seq").all();
  createConversationPresentationTables(f.db.db);
  assert.equal((f.db.db.prepare("SELECT value FROM meta WHERE key = 'conversation_presentation_schema_version'").get() as any).value, "2");
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), false);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.equal((f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "answer" as ItemId) as any).text, "完整正文");
  assert.equal((f.db.conversationEvents.readProcess(f.threadId, "process:reason").items[0] as any).content, "完整过程");
  createConversationPresentationTables(f.db.db);
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), true);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM conversation_events ORDER BY seq").all(), canonical);
});

test("旧展示索引升级失败原子回滚补列、标记和缓存，显式重试后恢复", t => {
  const f = fixture(t);
  f.db.db.prepare("UPDATE meta SET value = '1' WHERE key = 'conversation_presentation_schema_version'").run();
  f.db.db.exec("ALTER TABLE conversation_presentations DROP COLUMN build_id");
  const before = f.db.db.prepare("SELECT * FROM conversation_presentations").all();
  const prepare = f.db.db.prepare.bind(f.db.db), failure = new Error("synthetic schema marker failure");
  const fault = t.mock.method(f.db.db, "prepare", (sql: string) => {
    if (/UPDATE meta SET value = \? WHERE key = 'conversation_presentation_schema_version'/.test(sql)) throw failure;
    return prepare(sql);
  });
  assert.throws(() => createConversationPresentationTables(f.db.db), error => error === failure);
  assert.equal((prepare("SELECT value FROM meta WHERE key = 'conversation_presentation_schema_version'").get() as any).value, "1");
  assert.equal(prepare("PRAGMA table_info(conversation_presentations)").all().some((column: any) => column.name === "build_id"), false);
  assert.deepEqual(prepare("SELECT * FROM conversation_presentations").all(), before);
  fault.mock.restore();
  createConversationPresentationTables(f.db.db);
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), false);
});

test("旧结构补占位索引失败时仍原子回滚结构升级", t => {
  const f = fixture(t);
  f.db.db.exec("DROP INDEX idx_conversation_presentation_placeholder");
  f.db.db.prepare("UPDATE meta SET value = '1' WHERE key = 'conversation_presentation_schema_version'").run();
  f.db.db.exec("ALTER TABLE conversation_presentations DROP COLUMN build_id");
  const before = f.db.db.prepare("SELECT * FROM conversation_presentations").all();
  const exec = f.db.db.exec.bind(f.db.db), failure = new Error("legacy index creation failed");
  const fault = t.mock.method(f.db.db, "exec", (sql: string) => {
    if (/CREATE INDEX.*placeholder/.test(sql)) throw failure;
    exec(sql);
  });
  assert.throws(() => createConversationPresentationTables(f.db.db), error => error === failure);
  assert.equal((f.db.db.prepare("SELECT value FROM meta WHERE key = 'conversation_presentation_schema_version'").get() as any).value, "1");
  assert.equal(f.db.db.prepare("PRAGMA table_info(conversation_presentations)").all().some((column: any) => column.name === "build_id"), false);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM conversation_presentations").all(), before);
  fault.mock.restore();
  createConversationPresentationTables(f.db.db);
  assert.equal(f.db.db.prepare("PRAGMA table_info(conversation_presentations)").all().some((column: any) => column.name === "build_id"), true);
});

for (const terminal of ["turn.completed", "turn.error"]) test(`${terminal} 使待输入项过期，热读和重建都保留完整请求`, async t => {
  const f = fixture(t);
  const questions = [{ id: "choice", header: "处理方式", question: "选择下一步", options: [{ label: "继续", description: "执行后续步骤" }] }];
  f.append("userInput.requested", { request: { requestId: "request", params: {
    workspaceId: "workspace", threadId: f.threadId, turnId: "turn", itemId: "input", questions,
  } } });
  f.append(terminal, { turnId: "turn", message: "interrupted" });
  /** 终态收口必须落到条目正文，重新打开也不能复活待输入卡片。 */
  const assertExpired = () => {
    const item = f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.kind === "userInputRequest");
    assert.ok(item?.kind === "userInputRequest");
    assert.equal(item.state, "expired");
    assert.equal(item.requestId, "request");
    assert.deepEqual(item.questions, questions);
  };
  assertExpired();
  f.db.db.prepare("DELETE FROM conversation_presentations WHERE thread_id = ?").run(f.threadId);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assertExpired();
});

test("展示版本2的错误回答缓存失效重建，编号复用后保留各问题答案", async t => {
  const f = fixture(t);
  for (const [id, question, answer] of [["old", "scope", "旧答案"], ["current", "modal_scope", "新答案"]]) {
    f.append("userInput.requested", { request: { requestId: 0, params: { workspaceId: "workspace", threadId: f.threadId,
      turnId: "turn", itemId: id, questions: [{ id: question, header: "范围", question: "选择范围" }] } } });
    f.append("userInput.resolved", { response: { requestId: 0, answers: { [question!]: { answers: [answer] } } } });
  }
  const canonical = f.db.db.prepare("SELECT * FROM conversation_events ORDER BY seq").all();
  // 模拟旧版本已持久化的错误快照，原始事件保持正确。
  const records = f.db.db.prepare("SELECT item_id, item_json FROM conversation_presentation_items WHERE item_id IN ('old', 'current')").all() as any[];
  for (const row of records) {
    const item = JSON.parse(row.item_json);
    item.state = row.item_id === "current" ? "pending" : "submitted";
    item.submittedAnswers = row.item_id === "current" ? undefined : { modal_scope: { answers: ["新答案"] } };
    f.db.db.prepare("UPDATE conversation_presentation_items SET item_json = ?, stub_json = ? WHERE item_id = ?")
      .run(JSON.stringify(item), JSON.stringify(item), row.item_id);
  }
  f.db.db.prepare("UPDATE meta SET value = '2' WHERE key = 'conversation_presentation_schema_version'").run();
  f.db.db.prepare("UPDATE conversation_presentations SET schema_version = 2, ready = 1").run();
  createConversationPresentationTables(f.db.db);
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), false);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const items = f.db.conversationEvents.readPresentation(f.threadId).items.filter(item => item.kind === "userInputRequest");
  assert.equal(items.length, 2);
  assert.ok(items.every(item => item.state === "submitted"));
  assert.deepEqual(items.find(item => item.id === "old" as ItemId)?.submittedAnswers, { scope: { answers: ["旧答案"] } });
  assert.deepEqual(items.find(item => item.id === "current" as ItemId)?.submittedAnswers, { modal_scope: { answers: ["新答案"] } });
  assert.deepEqual(f.db.db.prepare("SELECT * FROM conversation_events ORDER BY seq").all(), canonical);
  createConversationPresentationTables(f.db.db);
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), true);
});

test("归并缓存升级保持旧Client的结构版本2，旧缓存增量先失效再按原事件重建", async t => {
  const f = fixture(t);
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "升级前" });
  const storageVersion = () => (f.db.db.prepare("SELECT value FROM meta WHERE key='conversation_presentation_schema_version'").get() as any).value;
  assert.equal(storageVersion(), "2", "只更新可重建缓存，不能让同数据库结构版本的旧Client拒绝打开");
  f.db.db.prepare("UPDATE conversation_presentations SET schema_version = 2, ready = 1").run();
  const before = f.db.db.prepare("SELECT item_json FROM conversation_presentation_items WHERE item_id = 'answer'").get();
  f.append("item.agentMessage.delta", { itemId: "answer", delta: "升级后" });
  assert.equal(f.db.conversationEvents.isPresentationReady(f.threadId), false);
  assert.equal((f.db.db.prepare("SELECT ready FROM conversation_presentations WHERE thread_id = ?").get(f.threadId) as any).ready, 0);
  assert.deepEqual(f.db.db.prepare("SELECT item_json FROM conversation_presentation_items WHERE item_id = 'answer'").get(), before,
    "旧归并结果不得继续接受增量，必须从原始事件重建");
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  assert.equal((f.db.conversationEvents.readPresentation(f.threadId).items.find(item => item.id === "answer" as ItemId) as any).text, "升级前升级后");
  assert.equal(storageVersion(), "2");
  const cached = f.db.db.prepare("SELECT * FROM conversation_presentations WHERE thread_id = ?").get(f.threadId);
  createConversationPresentationTables(f.db.db);
  assert.deepEqual(f.db.db.prepare("SELECT * FROM conversation_presentations WHERE thread_id = ?").get(f.threadId), cached,
    "结构版本2不能导致每次初始化都把新缓存失效");
});

test("展示快照按可见消息窗口分页，游标向前补齐不重复", async t => {
  const f = fixture(t);
  for (let i = 0; i < 5; i += 1) {
    f.append("item.userMessage.created", { itemId: `u${i}`, text: `q${i}` });
    f.append("item.agentMessage.delta", { itemId: `a${i}`, delta: `a${i}` });
  }
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const allMessages = f.db.conversationEvents.readPresentation(f.threadId).items
    .filter(item => item.kind === "message").map(item => String(item.id));
  const first = f.db.conversationEvents.readPresentationPage(f.threadId, { messageLimit: 3 });
  assert.deepEqual(first.items.filter(item => item.kind === "message").map(item => String(item.id)), allMessages.slice(-3));
  assert.equal(first.hasMoreOlder, true);
  assert.notEqual(first.oldestPosition, null);
  const second = f.db.conversationEvents.readPresentationPage(f.threadId, { messageLimit: 2, beforePosition: first.oldestPosition });
  assert.deepEqual(second.items.filter(item => item.kind === "message").map(item => String(item.id)), allMessages.slice(-5, -3));
  assert.equal(second.hasMoreOlder, true);
  const rest = f.db.conversationEvents.readPresentationPage(f.threadId, { messageLimit: 50, beforePosition: second.oldestPosition });
  assert.equal(rest.hasMoreOlder, false);
  assert.deepEqual([...rest.items.filter(item => item.kind === "message").map(item => String(item.id)),
    ...second.items.filter(item => item.kind === "message").map(item => String(item.id)),
    ...first.items.filter(item => item.kind === "message").map(item => String(item.id))], allMessages);
});

test("单窗口覆盖全部消息时不标记更早页", async t => {
  const f = fixture(t);
  await f.db.conversationEvents.ensurePresentation(f.threadId);
  const all = f.db.conversationEvents.readPresentation(f.threadId);
  const page = f.db.conversationEvents.readPresentationPage(f.threadId, { messageLimit: 100 });
  assert.equal(page.hasMoreOlder, false);
  assert.equal(page.oldestPosition, 0);
  assert.deepEqual(page.items.map(item => String(item.id)), all.items.map(item => String(item.id)));
});

test("没有消息条目时窗口读取仍返回完整过程投影", async t => {
  const f = fixture(t);
  const threadId = "process-only" as ThreadId;
  f.db.threads.create({ id: threadId, workspaceId: "workspace" as WorkspaceId, engine: "codex", title: "过程" });
  f.db.conversationEvents.appendEnvelope({ schema: 1, seq: 1000, ts: 1000, engine: "codex", workspaceId: "workspace" as WorkspaceId,
    threadId, type: "item.reasoning.delta", payload: { itemId: "r", delta: "思考" } } as ConversationEventEnvelope);
  await f.db.conversationEvents.ensurePresentation(threadId);
  const page = f.db.conversationEvents.readPresentationPage(threadId, { messageLimit: 30 });
  assert.ok(page.items.length > 0);
  assert.equal(page.hasMoreOlder, false);
});
