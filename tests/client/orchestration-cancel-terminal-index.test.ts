import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import type { ConversationEventEnvelope, ConversationEventInput } from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { OrchestrationEngine } from "../../apps/desktop/client/src/orchestration/orchestrationEngine.ts";
import { createLocalEventPersistence } from "../../apps/desktop/client/src/runtime/localEventPersistence.ts";
import { clearActiveThreadTurnIfMatches, resolveTurnErrorIndexScope } from "../../apps/desktop/client/src/app/threadRunningState.ts";
import { readTurnExecutionOptionsSnapshot } from "../../apps/desktop/client/src/queue/threadQueueExecutionPolicy.ts";
import { persistOrStageCodexProviderTurn } from "../../apps/desktop/client/src/eventIndex/codexProviderTurnStarted.ts";
import { applyThreadReminderStateEvent } from "../../apps/desktop/client/src/eventIndex/threadReminderStateEvents.ts";
import { logger } from "../../apps/desktop/client/src/logger.ts";
import { ThreadStore } from "../../apps/desktop/client/src/threads/threadStore.ts";

/** 执行既有入口的纯函数，避免测试重写事件索引或证据范围规则。 */
function sourceFunctions(file: string, names: string[], bindings: Record<string, unknown> = {}): Record<string, any> {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wanted = new Set(names);
  const declarations = ast.statements.filter(statement => ts.isFunctionDeclaration(statement) && wanted.has(statement.name?.text ?? ""));
  assert.equal(declarations.length, wanted.size);
  const context: Record<string, any> = { ...bindings };
  const code = declarations.map(statement => statement.getText(ast)).join("\n");
  vm.runInNewContext(ts.transpileModule(`${code}\nglobalThis.functions = { ${names.join(",")} };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context.functions;
}

const index = sourceFunctions("../../apps/desktop/client/src/index.ts", [
  "createEventIndexRuntime", "applyTurnIndexEvent", "applyPendingCodexProviderTurnMapping", "ensureTerminalTurnRow", "cleanupPendingTools",
], { clearActiveThreadTurnIfMatches, resolveTurnErrorIndexScope, readTurnExecutionOptionsSnapshot,
  persistOrStageCodexProviderTurn, applyThreadReminderStateEvent, logger });
const evidence = sourceFunctions("../../apps/desktop/client/src/app/handlers/orchestrationHandlers.ts", ["readTurnScopedEventBodies", "collectTurnScopedEventRefs"]);

/** 只替代外部 session 中断，保留真实 SQLite、持久化、统一索引和取消方法。 */
function createHarness(t: TestContext, delivery: "local" | "remote" = "local") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-terminal-index-"));
  const rootDb = openClientDb({ dbPath: path.join(directory, "client.db"), localCanonicalEvents: true });
  t.after(() => {
    rootDb.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const workspaceId = "workspace-cancel-terminal", threadId = "thread-cancel-terminal", turnId = "turn-cancel-terminal";
  rootDb.workspaces.upsert({ id: workspaceId, title: "终态索引", path: directory });
  const db = rootDb.forWorkspace(workspaceId);
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "终态索引", threadType: "orchestration" });
  const runtime = index.createEventIndexRuntime();
  const ctx = { db, runtime, workspaces: new Map([[workspaceId, directory]]) };
  const persistence = createLocalEventPersistence({ db,
    applyConversation(event) { index.applyTurnIndexEvent(ctx, event); }, applyRaw() {} });
  persistence.persist({ t: "conversation.event", event: { workspaceId, threadId, engine: "codex", type: "turn.started", ts: Date.now() - 100, payload: { turnId } } });
  const pending: ConversationEventInput[] = [];
  let emitted = 0;
  const host = {
    isTurnStillStarted: (OrchestrationEngine.prototype as any).isTurnStillStarted,
    ctx: { db, sessions: { async interrupt(actualThread: string, actualTurn: string) {
      assert.equal(actualThread, threadId); assert.equal(actualTurn, turnId);
    } }, emitConversation(event: ConversationEventInput) {
      emitted += 1;
      if (delivery === "remote") pending.push(event);
      else persistence.persist({ t: "conversation.event", event });
    } },
  };
  return { db, directory, workspaceId, threadId, turnId, runtime, persistence, pending, host,
    emitted: () => emitted,
    cancel() { (OrchestrationEngine.prototype as any).interruptRunningTurnForCancel.call(host, { id: "instance-cancel-terminal", workspaceId }, threadId, turnId); },
    terminal() { return db.conversationEvents.listByThreadType(threadId, "turn.error", { limit: 10 }) as ConversationEventEnvelope[]; },
  };
}

test("实例取消保留同步统一索引的终态序号并清理 active", t => {
  const h = createHarness(t);
  h.cancel();
  const turn = h.db.turns.get(h.turnId)!;
  const terminal = h.terminal();
  assert.equal(terminal.length, 1);
  assert.equal(turn.status, "error");
  assert.equal(turn.endedAt, terminal[0].ts);
  assert.equal(turn.endEventSeq, terminal[0].seq);
  assert.equal((terminal[0].payload as any).code, "turn_interrupted");
  assert.equal((terminal[0].payload as any).terminationKind, "manual_interrupt");
  assert.equal(h.runtime.activeTurnByThreadId.has(h.threadId), false);
});

test("普通 Client 未索引时立即结算 error，延迟 ACK 回填唯一终态序号", t => {
  const h = createHarness(t, "remote");
  h.cancel();
  const beforeAck = h.db.turns.get(h.turnId)!;
  assert.equal(beforeAck.status, "error");
  assert.ok(beforeAck.endedAt! >= beforeAck.startedAt);
  assert.equal(beforeAck.endEventSeq, null);
  assert.deepEqual(h.db.turns.listRunningByWorkspace(h.workspaceId), {});
  assert.equal(h.pending.length, 1);
  const committed = h.persistence.persist({ t: "conversation.event", event: h.pending[0] });
  assert.equal(h.db.turns.get(h.turnId)?.endEventSeq, committed.event.seq);
  assert.equal(h.terminal().length, 1);
  assert.equal(h.runtime.activeTurnByThreadId.has(h.threadId), false);
});

test("取消 emit 失败直接抛出且不执行后续本地终态写入", t => {
  const h = createHarness(t);
  const failure = new Error("controlled terminal emit failed");
  h.host.ctx.emitConversation = () => { throw failure; };
  assert.throws(h.cancel, error => error === failure);
  const turn = h.db.turns.get(h.turnId)!;
  assert.equal(turn.status, "started");
  assert.equal(turn.endedAt, null);
  assert.equal(turn.endEventSeq, null);
  assert.equal(h.terminal().length, 0);
});

test("已存在终态的 turn 不重复发事件或改写序号", t => {
  const h = createHarness(t);
  const terminal = h.persistence.persist({ t: "conversation.event", event: { workspaceId: h.workspaceId, threadId: h.threadId,
    engine: "codex", type: "turn.error", ts: Date.now(), payload: { turnId: h.turnId, error: "turn interrupted", code: "turn_interrupted", terminationKind: "manual_interrupt" } } });
  h.cancel();
  assert.equal(h.emitted(), 0);
  assert.equal(h.terminal().length, 1);
  assert.equal(h.db.turns.get(h.turnId)?.endEventSeq, terminal.event.seq);
});

test("取消 turn 的运行证据不包含同线程后续 turn", t => {
  const h = createHarness(t);
  h.cancel();
  h.persistence.persist({ t: "conversation.event", event: { workspaceId: h.workspaceId, threadId: h.threadId,
    engine: "codex", type: "turn.started", ts: Date.now() + 1, payload: { turnId: "successor-turn" } } });
  const turn = h.db.turns.get(h.turnId)!;
  const trace = evidence.readTurnScopedEventBodies({ db: h.db }, "conversation_events", h.workspaceId, h.threadId, turn, 100);
  const refs = evidence.collectTurnScopedEventRefs({ db: h.db }, "conversation_events", h.workspaceId, h.threadId, [turn], 100);
  assert.equal(trace.count, 2);
  assert.equal(refs.count, 2);
  assert.ok(trace.events.every((event: ConversationEventEnvelope) => (event.payload as any).turnId === h.turnId));
  assert.equal(h.runtime.activeTurnByThreadId.get(h.threadId)?.turnId, "successor-turn");
});

test("实例 cancel 入口对角色和 AI gate 共用终态索引保护", async t => {
  const h = createHarness(t);
  const gateThreadId = "gate-cancel-terminal", gateTurnId = "gate-turn-cancel-terminal";
  h.db.threads.create({ id: gateThreadId, workspaceId: h.workspaceId, engine: "codex", title: "Gate", threadType: "orchestration" });
  h.persistence.persist({ t: "conversation.event", event: { workspaceId: h.workspaceId, threadId: gateThreadId,
    engine: "codex", type: "turn.started", ts: Date.now(), payload: { turnId: gateTurnId } } });
  const instance = h.db.orchInstances.create({ workspaceId: h.workspaceId, workflowId: "workflow-cancel-terminal",
    workflowSnapshot: { id: "workflow-cancel-terminal", workspaceId: h.workspaceId, family: "feature-dev", name: "取消", description: "取消终态索引",
      version: 1, nodes: [{ id: "role", type: "role", roleId: "role-cancel-terminal", label: "角色", position: { x: 0, y: 0 } }], edges: [] },
    intakeSnapshot: { id: "intake-cancel-terminal", workspaceId: h.workspaceId, triggerMode: "manual", taskType: "feature", title: "取消",
      goal: "取消", background: null, acceptanceCriteria: null, workbenchItemRefs: null, seedArtifactRefs: null,
      constraints: null, requester: null, createdAt: 1, updatedAt: 1 },
  });
  instance.nodeStates.role.status = "gate-checking";
  instance.nodeStates.role.threadId = h.threadId;
  instance.nodeStates.role.activeGateEvaluation = { evaluationRunId: "gate-run-cancel-terminal", evaluationCallId: "gate-call-cancel-terminal",
    retryOrdinal: 0, statusVersion: 1, artifactId: "artifact-cancel-terminal", nodeAttemptId: "attempt-cancel-terminal",
    threadId: gateThreadId, turnId: gateTurnId, promptSnapshotId: "snapshot-cancel-terminal", startedAt: Date.now() };
  h.db.orchInstances.updateNodeStates(instance.id, instance.nodeStates);
  const engine = new OrchestrationEngine({ db: h.db, workspaces: new Map([[h.workspaceId, h.directory]]), threads: new ThreadStore(),
    sessions: { async interrupt(threadId: string, turnId: string) {
      assert.ok((threadId === h.threadId && turnId === h.turnId) || (threadId === gateThreadId && turnId === gateTurnId));
    } } as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    emitConversation(event) { h.persistence.persist({ t: "conversation.event", event }); }, emitRaw() {},
  });
  engine.cancel(instance.id);
  await engine.stopAndDrain();
  assert.equal(h.db.orchInstances.get(instance.id)?.status, "cancelled");
  for (const [threadId, turnId] of [[h.threadId, h.turnId], [gateThreadId, gateTurnId]]) {
    const terminal = h.db.conversationEvents.listByThreadType(threadId, "turn.error", { limit: 10 });
    assert.equal(terminal.length, 1);
    assert.equal(h.db.turns.get(turnId)?.endEventSeq, terminal[0].seq);
    assert.equal(h.db.turns.get(turnId)?.status, "error");
  }
});
