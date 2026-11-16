import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ConversationEventEnvelope, RawEngineEventEnvelope, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { createConversationEventAckBuffer } from "../src/diagnostics/conversationEventAckBuffer.js";
import { createRawEventAckBuffer } from "../src/diagnostics/rawEventAckBuffer.js";
import { createThreadTouchBuffer } from "../src/diagnostics/threadTouchBuffer.js";
import { finalizeDanglingTurnsOnStartup } from "../src/startup/danglingTurnReconciler.js";
import { reconcileAssetDraftJobsOnStartup } from "../src/startup/assetDraftJobReconciler.js";
import { logger } from "../src/logger.js";

/** 三个真实工作区提供相同主键，验证原子批次与首错停止。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-startup-buffer-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  for (const name of ["a", "b", "c"]) {
    const workspaceId = `buffer-client:${name}` as WorkspaceId, directory = path.join(root, name);
    fs.mkdirSync(directory);
    db.workspaces.upsert({ id: workspaceId, title: name, path: directory });
    db.forWorkspace(workspaceId).threads.create({ id: "same-thread" as ThreadId, workspaceId, title: name, engine: "codex" });
  }
  const ids = db.workspaces.list().map(workspace => workspace.id);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, ids, threadId: "same-thread" as ThreadId };
}

/** 构造能通过严格回放与父记录校验的 canonical 信封。 */
function envelope(workspaceId: WorkspaceId, seq: number): ConversationEventEnvelope {
  return { schema: 1, workspaceId, threadId: "same-thread" as ThreadId, engine: "codex", seq, ts: seq,
    type: "turn.started", payload: { turnId: "same-turn" as TurnId } };
}

for (const kind of ["canonical", "raw"] as const) {
  test(`${kind} ACK 按工作区原子提交，B失败时保留B/C且不逐条补写`, t => {
    const f = fixture(t), [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
    const buffer = kind === "canonical" ? createConversationEventAckBuffer(f.db, { flushDelayMs: 60_000 })
      : createRawEventAckBuffer(f.db, { flushDelayMs: 60_000 });
    const repo = kind === "canonical" ? f.db.forWorkspace(b).conversationEvents : f.db.forWorkspace(b).rawEvents;
    const append = t.mock.method(repo, "appendEnvelopes", () => { throw new Error("injected-workspace-b-failure"); });
    for (const workspaceId of [a, b, c]) buffer.enqueue(envelope(workspaceId, 100) as ConversationEventEnvelope & RawEngineEventEnvelope);
    assert.throws(() => buffer.flush());
    const table = kind === "canonical" ? "conversation_events" : "raw_engine_events";
    assert.equal(f.db.forWorkspace(a).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1);
    assert.equal(f.db.forWorkspace(b).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    assert.equal(f.db.forWorkspace(c).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    assert.equal(buffer.getPendingCount(), 2);
    append.mock.restore();
    buffer.dispose();
    assert.equal(buffer.getPendingCount(), 0);
    assert.equal(f.db.forWorkspace(c).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 1);
    assert.equal(f.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
  });

  test(`${kind} ACK 同工作区后续事件失败回滚整组，timer交错误边界后保留队列`, async t => {
    const f = fixture(t), workspaceId = f.ids[0]!;
    let deliverFailure!: (error: unknown) => void;
    const failed = new Promise<unknown>(resolve => { deliverFailure = resolve; });
    const options = { flushDelayMs: 5, onError: deliverFailure };
    const buffer = kind === "canonical" ? createConversationEventAckBuffer(f.db, options) : createRawEventAckBuffer(f.db, options);
    buffer.enqueue(envelope(workspaceId, 100) as ConversationEventEnvelope & RawEngineEventEnvelope);
    buffer.enqueue({ ...envelope(workspaceId, 101), threadId: "missing-parent" as ThreadId } as ConversationEventEnvelope & RawEngineEventEnvelope);
    let deadline: ReturnType<typeof setTimeout>;
    try {
      const error = await Promise.race([failed, new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("ACK error boundary was not called")), 2_000);
      })]);
      assert.ok(error instanceof Error);
    } finally { clearTimeout(deadline!); }
    const table = kind === "canonical" ? "conversation_events" : "raw_engine_events";
    assert.equal(f.db.forWorkspace(workspaceId).db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
    assert.equal(buffer.getPendingCount(), 2);
    assert.throws(() => buffer.dispose());
    assert.equal(buffer.getPendingCount(), 2);
  });
}

test("touch 保留工作区维度且B失败停止C，重试保留最新时间", t => {
  const f = fixture(t), [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
  const buffer = createThreadTouchBuffer(f.db, { flushDelayMs: 60_000 });
  const before = f.db.forWorkspace(c).threads.get(f.threadId)!.updatedAt;
  const time = Date.now() + 10_000;
  for (const [index, workspaceId] of [a, b, c].entries()) buffer.enqueue(f.threadId, time + index, { workspaceId });
  assert.equal(buffer.getPendingCount(), 3);
  const fault = t.mock.method(f.db.forWorkspace(b).threads, "touchMany", () => { throw new Error("injected-touch-failure"); });
  assert.throws(() => buffer.flush());
  assert.equal(f.db.forWorkspace(a).threads.get(f.threadId)?.updatedAt, time);
  assert.equal(f.db.forWorkspace(c).threads.get(f.threadId)?.updatedAt, before);
  assert.equal(buffer.getPendingCount(), 2);
  buffer.enqueue(f.threadId, time + 100, { workspaceId: b });
  fault.mock.restore();
  buffer.dispose();
  assert.equal(f.db.forWorkspace(b).threads.get(f.threadId)?.updatedAt, time + 100);
  assert.equal(f.db.forWorkspace(c).threads.get(f.threadId)?.updatedAt, time + 2);
});

test("启动收口逐工作区提交，B失败回滚正文与floor但应用序号永久预留", async t => {
  const f = fixture(t), [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
  for (const workspaceId of [a, b, c]) f.db.forWorkspace(workspaceId).turns.insertStarted({ workspaceId, threadId: f.threadId,
    engine: "codex", turnId: "same-turn" as TurnId, startedAt: 1, startEventSeq: null });
  const fault = t.mock.method(f.db.forWorkspace(b).turns, "setEnded", () => { throw new Error("injected-startup-index-failure"); });
  await assert.rejects(finalizeDanglingTurnsOnStartup({ db: f.db }));
  assert.equal(f.db.forWorkspace(a).turns.get("same-turn" as TurnId)?.status, "error");
  assert.equal(f.db.forWorkspace(b).turns.get("same-turn" as TurnId)?.status, "started");
  assert.equal(f.db.forWorkspace(c).turns.get("same-turn" as TurnId)?.status, "started");
  const aSeq = f.db.forWorkspace(a).conversationEvents.getLatestSeq();
  const reserved = Number((f.db.applicationDb.prepare("SELECT value FROM meta WHERE key = 'event_seq'").get() as { value: string }).value);
  assert.ok(reserved > aSeq);
  assert.equal(f.db.forWorkspace(b).conversationEvents.getLatestSeq(), 0);
  assert.equal(f.db.forWorkspace(b).db.prepare("SELECT value FROM meta WHERE key = 'event_seq_floor'").get(), undefined);
  fault.mock.restore();
  const retried = await finalizeDanglingTurnsOnStartup({ db: f.db });
  assert.equal(retried.scanned, 2);
  assert.ok(retried.events.every(event => event.seq > reserved));
  assert.equal(f.db.applicationDb.prepare("SELECT COUNT(*) AS n FROM conversation_events").get()?.n, 0);
});

test("草案启动清理在同工作区状态事件失败时回滚并停止后续工作区", t => {
  const f = fixture(t), [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
  const jobs = [a, b, c].map(workspaceId => f.db.forWorkspace(workspaceId).orchAssetGenerationJobs.create({ workspaceId,
    assetKind: "role", mode: "create", status: "generating", targetAssetId: null, clientRequestId: null,
    baseVersionId: null, draftId: null, threadId: f.threadId, prompt: "生成", requestJson: null,
    interactionRequest: null, progress: null, failure: null }));
  const fault = t.mock.method(f.db.forWorkspace(b).orchAssetJobEvents, "append", () => { throw new Error("injected-draft-event-failure"); });
  assert.throws(() => reconcileAssetDraftJobsOnStartup(f.db));
  assert.equal(f.db.forWorkspace(a).orchAssetGenerationJobs.get(jobs[0]!.id)?.status, "failed");
  assert.equal(f.db.forWorkspace(b).orchAssetGenerationJobs.get(jobs[1]!.id)?.status, "generating");
  assert.equal(f.db.forWorkspace(c).orchAssetGenerationJobs.get(jobs[2]!.id)?.status, "generating");
  fault.mock.restore();
  assert.equal(reconcileAssetDraftJobsOnStartup(f.db).failed, 2);
});

test("启动收口日志沿可信W真实落盘，不写应用同条", async t => {
  const f = fixture(t);
  const application = t.mock.method(logger, "info", () => {});
  await finalizeDanglingTurnsOnStartup({ db: f.db });
  for (const workspaceId of f.ids) {
    const directory = path.join(f.db.workspaces.get(workspaceId)!.path, ".codeflowai");
    const logs = fs.readdirSync(directory).filter(name => name.endsWith(".log"))
      .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("");
    assert.match(logs, /dangling turns finalized locally/);
    assert.ok(logs.includes(workspaceId));
  }
  assert.equal(application.mock.callCount(), 0);
});

test("启动收口提交后W日志失败不回滚已提交B且不继续C", async t => {
  const f = fixture(t), [a, b, c] = f.ids as [WorkspaceId, WorkspaceId, WorkspaceId];
  for (const workspaceId of f.ids) f.db.forWorkspace(workspaceId).turns.insertStarted({ workspaceId,
    threadId: f.threadId, engine: "codex", turnId: "same-turn" as TurnId, startedAt: 1, startEventSeq: null });
  const failure = { diagnostic: "writer-failed" };
  t.mock.method(f.db.forWorkspace(b), "writeWorkspaceLog", () => { throw failure; });
  await assert.rejects(finalizeDanglingTurnsOnStartup({ db: f.db }), error => error === failure);
  assert.equal(f.db.forWorkspace(a).turns.get("same-turn" as TurnId)?.status, "error");
  assert.equal(f.db.forWorkspace(b).turns.get("same-turn" as TurnId)?.status, "error");
  assert.equal(f.db.forWorkspace(c).turns.get("same-turn" as TurnId)?.status, "started");
});

test("启动事务和W日志双失败保留falsy业务原因与writer原对象", async t => {
  const f = fixture(t), workspaceId = f.ids[0]!, view = f.db.forWorkspace(workspaceId);
  view.turns.insertStarted({ workspaceId, threadId: f.threadId, engine: "codex",
    turnId: "same-turn" as TurnId, startedAt: 1, startEventSeq: null });
  const failure = { diagnostic: "writer-failed" };
  t.mock.method(view.turns, "setEnded", () => { throw undefined; });
  t.mock.method(view, "writeWorkspaceLog", () => { throw failure; });
  await assert.rejects(finalizeDanglingTurnsOnStartup({ db: f.db }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [undefined, failure]);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(view.turns.get("same-turn" as TurnId)?.status, "started");
  assert.equal(view.conversationEvents.getLatestSeq(), 0);
});
