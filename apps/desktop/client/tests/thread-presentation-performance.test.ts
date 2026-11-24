import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConversationState, snapshotConversationState } from "@codeflowai/shared";
import type { ConversationEventEnvelope, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { ConversationPresentationStore, createConversationPresentationTables } from "../src/db/conversationPresentation.js";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.js";
import { openClientDb } from "../src/db/clientDb.js";

const threadId = "performance-thread" as ThreadId, workspaceId = "performance-workspace" as WorkspaceId;

/** 独立内存库仅含合成历史，实际归并和SQLite查询使用生产实现。 */
function fixture(t: test.TestContext) {
  const db = openSqliteDb(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE threads(id TEXT PRIMARY KEY, workspace_id TEXT, engine TEXT);
    CREATE TABLE conversation_events(thread_id TEXT, seq INTEGER, workspace_id TEXT, engine TEXT, event_json TEXT);
    CREATE INDEX events_thread_seq ON conversation_events(thread_id, seq);
    CREATE TABLE conversation_message_deletions(thread_id TEXT, item_id TEXT);`);
  db.prepare("INSERT INTO threads VALUES (?, ?, 'codex')").run(threadId, workspaceId);
  createConversationPresentationTables(db);
  return { db, store: new ConversationPresentationStore(db) };
}

/** 固定无业务内容的事件格式，序号可独立验证恢复水位。 */
function event(seq: number, type: string, payload: unknown): ConversationEventEnvelope {
  return { schema: 1, seq, ts: seq, workspaceId, threadId, engine: "codex", type, payload } as ConversationEventEnvelope;
}

/** 构造大量无占位的历史过程，放大逐增量扫描历史的错误分支。 */
function seedProcessHistory(db: SqliteDb, count: number): void {
  const insert = db.prepare(`INSERT INTO conversation_presentation_items
    (thread_id,item_id,position,created_seq,updated_seq,process_id,stub_json,item_json) VALUES (?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `history-${i}`, item = { kind: "tool", id, toolType: "shell", status: "completed", output: "", summary: "synthetic evidence ".repeat(20) };
      const json = JSON.stringify(item);
      insert.run(threadId, id, i + 1, 1, 1, `process:${id}`, json, json);
    }
  })();
}

test("大量历史过程不会放大每条工具增量的查询耗时", t => {
  const { db, store } = fixture(t);
  store.append(event(1, "item.tool.started", { itemId: "target", toolName: "shell", input: {} }));
  seedProcessHistory(db, 4000);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM conversation_presentation_items
    INDEXED BY idx_conversation_presentation_placeholder
    WHERE thread_id = ? AND process_id IS NOT NULL AND json_extract(stub_json, '$.placeholder') = 1 LIMIT 1`).all(threadId);
  assert.ok(plan.some((row: any) => /SEARCH.*placeholder/.test(row.detail)), JSON.stringify(plan));
  const start = performance.now();
  for (let i = 0; i < 1000; i++) store.append(event(i + 2, "item.tool.outputDelta", { itemId: "target", delta: "x" }));
  const elapsedMs = performance.now() - start;
  t.diagnostic(JSON.stringify({ processItems: 4000, deltas: 1000, elapsedMs: Math.round(elapsedMs) }));
  assert.ok(elapsedMs < 1800, `1000条目标增量耗时${Math.round(elapsedMs)}ms，不应逐条扫描4000份历史`);
  const result = store.readProcess(threadId, "process:target");
  assert.equal((result.items[0] as any).output, "x".repeat(1000));
});

test("旧库补齐占位索引不再次失效投影，DDL失败可显式重试", t => {
  const { db, store } = fixture(t);
  store.append(event(1, "item.reasoning.delta", { itemId: "reason", delta: "before" }));
  const before = store.read(threadId);
  db.exec("DROP INDEX idx_conversation_presentation_placeholder");
  const exec = db.exec.bind(db), failure = new Error("index creation failed");
  const fault = t.mock.method(db, "exec", (sql: string) => {
    if (/CREATE INDEX.*placeholder/.test(sql)) throw failure;
    exec(sql);
  });
  assert.throws(() => createConversationPresentationTables(db), error => error === failure);
  assert.deepEqual(store.read(threadId), before);
  fault.mock.restore();
  createConversationPresentationTables(db);
  assert.deepEqual(store.read(threadId), before);
  store.append(event(2, "item.agentMessage.delta", { itemId: "answer", delta: "visible" }));
  store.append(event(3, "item.reasoning.started", { itemId: "placeholder" }));
  store.append(event(4, "item.agentMessage.delta", { itemId: "answer", delta: " after" }));
  assert.equal(db.prepare("SELECT 1 FROM conversation_presentation_items WHERE item_id = 'placeholder'").get(), undefined);
  assert.equal(store.read(threadId).items.filter(item => item.kind === "message").length, 1);
});

test("旧投影冷重建保持心跳可响应并完整恢复高密度增量", async t => {
  const { db, store } = fixture(t);
  const deltas = process.env.CODEFLOWAI_PRESENTATION_PERF === "1" ? 350_000 : 4000;
  const tools = deltas > 4000 ? 2000 : 200;
  const insert = db.prepare("INSERT INTO conversation_events VALUES (?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < tools + deltas; i++) {
      const item = i < tools ? event(i + 1, "item.tool.started", { itemId: `tool-${i}`, toolName: "shell", input: {} })
        : event(i + 1, "item.tool.outputDelta", { itemId: `tool-${(i - tools) % tools}`, delta: "x" });
      insert.run(threadId, item.seq, workspaceId, "codex", JSON.stringify(item));
    }
    db.prepare("INSERT INTO conversation_presentations VALUES (?,0,1,2,'legacy',?,'{}')")
      .run(threadId, JSON.stringify(snapshotConversationState(createConversationState(threadId))));
  })();
  let heartbeats = 0, maxHeartbeatMs = 0, previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxHeartbeatMs = Math.max(maxHeartbeatMs, now - previous); previous = now; heartbeats++; }, 10);
  const start = performance.now();
  try { await store.rebuild(threadId, item => item, () => []); }
  finally { clearInterval(timer); }
  const elapsedMs = performance.now() - start;
  t.diagnostic(JSON.stringify({ events: tools + deltas, elapsedMs: Math.round(elapsedMs), maxHeartbeatMs: Math.round(maxHeartbeatMs), heartbeats }));
  assert.ok(heartbeats > 0);
  assert.ok(maxHeartbeatMs < 250, `重建阻塞心跳${Math.round(maxHeartbeatMs)}ms`);
  assert.ok(elapsedMs < (deltas > 4000 ? 5000 : 3000), `冷重建耗时${Math.round(elapsedMs)}ms`);
  assert.equal(store.isReady(threadId), true);
  const restored = [];
  let cursor: string | undefined;
  do {
    const page = store.readProcess(threadId, "process:tool-0", { limit: 200, cursor });
    restored.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(restored.length, tools);
  for (let i = 0; i < tools; i++) assert.equal((restored[i] as any).output.length, Math.ceil((deltas - i) / tools));
});

test("磁盘旧库混合diff与长输出冷加载不逐事件扫描历史或落盘", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-cold-mixed-"));
  const client = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => { client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  client.workspaces.upsert({ id: workspaceId, title: "合成性能库", path: directory });
  client.threads.create({ id: threadId, workspaceId, engine: "codex", title: "mixed cold history" });
  const large = process.env.CODEFLOWAI_PRESENTATION_PERF === "1";
  const tools = large ? 2000 : 160, deltasPerTool = large ? 175 : 60;
  let seq = 0;
  const insert = client.db.prepare("INSERT INTO conversation_events(seq,thread_id,workspace_id,engine,type,event_json,ts) VALUES (?,?,?,?,?,?,?)");
  /** 只构造无业务内容的canonical，模拟升级前没有投影的历史磁盘库。 */
  const append = (type: string, payload: unknown): void => {
    const next = event(++seq, type, payload);
    insert.run(seq, threadId, workspaceId, "codex", type, JSON.stringify(next), seq);
  };
  client.db.transaction(() => {
    for (let tool = 0; tool < tools; tool++) {
      const turnId = `turn-${Math.floor(tool / 20)}`;
      if (tool % 20 === 0) {
        append("item.userMessage.created", { itemId: `user-${tool}`, text: `question-${tool}`, turnId });
        append("turn.started", { turnId });
        client.turns.insertStarted({ workspaceId, threadId, engine: "codex", turnId: turnId as any, startedAt: seq, startEventSeq: seq });
      }
      append("item.tool.started", { itemId: `tool-${tool}`, toolName: "shell", input: {} });
      for (let delta = 0; delta < deltasPerTool; delta++) append("item.tool.outputDelta", { itemId: `tool-${tool}`, delta: "synthetic output ".repeat(4) });
      append("item.tool.completed", { itemId: `tool-${tool}`, toolName: "shell", status: "success" });
      append("item.diff.created", { itemId: `diff-${tool}`, turnId, title: "synthetic patch", diff: `patch-${tool}` });
      if (tool % 20 === 19) {
        append("item.agentMessage.delta", { itemId: `answer-${tool}`, turnId, delta: `answer-${tool}` });
        append("turn.completed", { turnId });
      }
    }
  })();
  let historicalDiffScans = 0, projectionWrites = 0;
  const prepare = client.db.prepare.bind(client.db);
  t.mock.method(client.db, "prepare", (sql: string) => {
    if (/FROM conversation_events/i.test(sql) && /json_extract\(event_json/i.test(sql)) historicalDiffScans++;
    if (/^(?:INSERT|UPDATE|DELETE).*conversation_presentation/is.test(sql)) projectionWrites++;
    return prepare(sql);
  });
  let heartbeats = 0, maximumGapMs = 0, previous = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maximumGapMs = Math.max(maximumGapMs, now - previous); previous = now; heartbeats++; }, 10);
  const start = performance.now();
  try { await client.conversationEvents.ensurePresentation(threadId); }
  finally { clearInterval(timer); }
  const presentation = client.conversationEvents.readPresentationPage(threadId, { messageLimit: 40 });
  const elapsedMs = Math.round(performance.now() - start);
  t.diagnostic(JSON.stringify({ events: seq, tools, elapsedMs, maximumGapMs: Math.round(maximumGapMs), historicalDiffScans, projectionWrites }));
  assert.ok(historicalDiffScans <= 2, `历史diff元数据被反复扫描${historicalDiffScans}次`);
  assert.ok(projectionWrites < seq / 4, `投影写入${projectionWrites}次，不应按每条delta落盘`);
  assert.ok(elapsedMs < (large ? 5000 : 1800), `冷首屏${elapsedMs}ms，不能等待历史逐事件重建`);
  assert.ok(heartbeats > 0 && maximumGapMs < 250, `事件循环阻塞${Math.round(maximumGapMs)}ms`);
  assert.ok(presentation.items.some(item => item.kind === "message" && item.text === `answer-${tools - 1}`));
  const first = client.conversationEvents.readProcess(threadId, "process:tool-0", { limit: 200 });
  assert.equal(first.items.find(item => item.id === "tool-0")?.kind, "tool");
  assert.equal((first.items[0] as any).output, "synthetic output ".repeat(4 * deltasPerTool));
  assert.equal(first.items.filter(item => item.kind === "diff").length, 1);
  assert.equal((first.items.find(item => item.kind === "diff") as any).diff, "patch-19");
});
