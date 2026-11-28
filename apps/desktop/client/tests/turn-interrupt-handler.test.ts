import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MANUAL_TURN_INTERRUPT_CODE,
  type ThreadId,
  type WorkspaceId,
} from "@codeflowai/shared";
import { createTurnErrorEventInput } from "../src/errors/turnErrors.ts";

import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { getPendingTurnTerminalFailure, interruptTurnBestEffort, retryPendingTurnTerminal, settleTurnTerminalOnce } from "../src/app/turnInterrupt.ts";
import { trackOrdinaryTurnExecution, waitForOrdinaryTurnExecution } from "../src/app/ordinaryTurnExecution.ts";
import type { ClientToServerMessage } from "../src/protocol/messages.ts";

const WORKSPACE_ID = "client-test:ws-interrupt" as WorkspaceId;
const THREAD_ID = "thread-interrupt-handler" as ThreadId;
const TURN_ID = "turn-interrupt-handler" as any;

/** 创建最小中断测试上下文，避免拉起真实引擎 session。 */
function setupInterruptHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-interrupt-"));
  const application = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  application.workspaces.upsert({ id: WORKSPACE_ID, title: "中断测试工作区", path: workspacePath });
  const db = application.forWorkspace(WORKSPACE_ID);
  const sent: ClientToServerMessage[] = [];
  let seq = 100;
  let interruptFinished = false;

  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "中断测试" });
  db.turns.insertStarted({
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    turnId: TURN_ID,
    startedAt: Date.now() - 1_000,
    startEventSeq: 1,
  });

  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, workspacePath]]),
    clientId: "client-test",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    threads: new ThreadStore(),
    sessions: {
      /** 测试不模拟删除竞态，thread 操作租约立即成功。 */
      beginThreadOperation() { return () => {}; },
      async interrupt() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        interruptFinished = true;
        return true;
      },
      /** 默认夹具不持有真实 provider generation。 */
      detachCodexProviderGeneration() {},
      async disposeThreadWithOptions() {},
    },
    orchEngine: { forWorkspace() { return this; } },
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    onBeforeEmitConversationEvent(event) {
      db.conversationEvents.appendEnvelope({ ...event, seq: ++seq } as any);
    },
  } as unknown as ApiHandlerContext;

  return {
    db,
    ctx,
    sent,
    get interruptFinished() {
      return interruptFinished;
    },
    cleanup() {
      application.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("Claude 未取得 provider 或准备 owner 的停止证明时保留 started 状态", async () => {
  const harness = setupInterruptHarness();
  try {
    harness.db.db.exec("UPDATE threads SET engine = 'claude'; UPDATE thread_turns SET engine = 'claude'");
    (harness.ctx.sessions as any).interrupt = async () => false;
    await assert.rejects(interruptTurnBestEffort(harness.ctx, {
      workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID,
    }, { ensureTerminalEvent: true }), error => (error as { code?: string }).code === "claude_interrupt_unconfirmed");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.sent.some(message => message.t === "conversation.event" && message.event.type === "turn.error"), false);
  } finally { harness.cleanup(); }
});

test("interruptTurnBestEffort 拒绝空 turnId，不伪造已终态成功", async () => {
  const harness = setupInterruptHarness();
  try {
    await assert.rejects(
      interruptTurnBestEffort(harness.ctx, {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: "" as any,
      }),
      /缺少 turnId/,
    );
  } finally {
    harness.cleanup();
  }
});

test("已确认停止后的保存失败不能触发Codex恢复或写入终态", async () => {
  const harness = setupInterruptHarness();
  const failure = new Error("PERSISTENCE_FAILED");
  let confirmed = 0, recovery = 0;
  try {
    (harness.ctx.sessions as any).interrupt = async (_thread: string, _turn: string, options: any) => {
      options.onStopConfirmed(); throw failure;
    };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => { recovery++; throw new Error("unexpected recovery"); };
    await assert.rejects(interruptTurnBestEffort(harness.ctx, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
      { ensureTerminalEvent: true, onStopConfirmed() { confirmed++; } }), error => error === failure);
    assert.equal(confirmed, 1); assert.equal(recovery, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.db.conversationEvents.listByThread(THREAD_ID).length, 0);
  } finally { harness.cleanup(); }
});

test("准确运行owner的终止先于数据库等待，保存失败仍明确返回", async () => {
  const h = setupInterruptHarness(), scope = { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID };
  const failure = new Error("PERSISTENCE_UNAVAILABLE");
  let stopped = false, confirmed = false;
  h.ctx.threads.create({ threadId: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "停止测试" });
  h.ctx.getActiveThreadTurn = () => ({ turnId: TURN_ID, startedAt: 1, source: "runtime" });
  h.ctx.withDatabase = async () => { assert.equal(stopped, true, "数据库失败不得先于停止目标引擎"); throw failure; };
  (h.ctx.sessions as any).interrupt = async (_thread: string, _turn: string, options: any) => {
    stopped = true; options.onStopConfirmed(); throw failure;
  };
  try {
    await assert.rejects(interruptTurnBestEffort(h.ctx, scope, { onStopConfirmed() { confirmed = true; } }), error => error === failure);
    assert.equal(stopped, true); assert.equal(confirmed, true);
    assert.equal(h.db.turns.get(TURN_ID)?.status, "started");
  } finally { h.cleanup(); }
});

test("未完成的终态保存不阻止先中断引擎，失败仍保留原恢复进度", async () => {
  const h = setupInterruptHarness(), scope = { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID };
  const failure = new Error("TERMINAL_SAVE_UNAVAILABLE");
  let calls = 0, confirmed = false;
  h.ctx.flushLocalEvents = async () => { throw failure; };
  try {
    await assert.rejects(settleTurnTerminalOnce(h.ctx, { ...scope, status: "error" }, {
      buildTerminalEvents: async () => [], notifyQueue() {},
    }), error => error === failure);
    (h.ctx.sessions as any).interrupt = async (_thread: string, _turn: string, options: any) => {
      calls++; options.onStopConfirmed(); return true;
    };
    await assert.rejects(interruptTurnBestEffort(h.ctx, scope, { ensureTerminalEvent: true,
      onStopConfirmed() { confirmed = true; } }), error => error === failure);
    await assert.rejects(interruptTurnBestEffort(h.ctx, scope, { ensureTerminalEvent: true }), error => error === failure);
    assert.equal(calls, 1); assert.equal(confirmed, true);
    assert.equal(getPendingTurnTerminalFailure(scope)?.turnId, TURN_ID);
  } finally {
    h.ctx.flushLocalEvents = async () => {};
    await retryPendingTurnTerminal(h.ctx, scope);
    h.cleanup();
  }
});

test("终态保存屏障失败不清active或推进队列，原进度重试不重复终态", async () => {
  const harness = setupInterruptHarness();
  let flushes = 0, cleared = 0, notified = 0;
  try {
    harness.ctx.clearActiveThreadTurn = () => { cleared++; };
    (harness.ctx as any).flushLocalEvents = async () => { if (++flushes === 1) throw new Error("TERMINAL_SAVE_FAILED"); };
    const scope = { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID };
    await assert.rejects(settleTurnTerminalOnce(harness.ctx, { ...scope, status: "error" }, {
      buildTerminalEvents: async () => [createTurnErrorEventInput({ ...scope, ts: Date.now(), engine: "codex",
        error: "interrupted", code: MANUAL_TURN_INTERRUPT_CODE, terminationKind: "manual_interrupt" })],
      notifyQueue: () => { notified++; },
    }), /TERMINAL_SAVE_FAILED/);
    assert.equal(cleared, 0); assert.equal(notified, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.deepEqual(getPendingTurnTerminalFailure(scope), { turnId: TURN_ID, errorCode: "TURN_FINALIZATION_FAILED" });
    await retryPendingTurnTerminal(harness.ctx, scope);
    assert.equal(getPendingTurnTerminalFailure(scope), null);
    assert.equal(cleared, 1); assert.equal(notified, 1);
    assert.equal(harness.db.conversationEvents.listByThread(THREAD_ID).filter(event => event.type === "turn.error").length, 1);
  } finally { harness.cleanup(); }
});

test("终止API在停止证明后返回draining一次，原请求仍持有保存尾链", async () => {
  const harness = setupInterruptHarness();
  let release!: () => void, confirmed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopped = new Promise<void>(resolve => { confirmed = resolve; });
  let completed = false;
  (harness.ctx.sessions as any).interrupt = async (_thread: string, _turn: string, options: { onStopConfirmed?: () => void }) => {
    options?.onStopConfirmed?.(); confirmed(); await gate; return true;
  };
  const work = handleApiRequest(harness.ctx, { t: "api.req", id: "stop-draining", method: "turns.interrupt",
    body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID } } as ApiRequestMessage).finally(() => { completed = true; });
  try {
    await stopped;
    const response = harness.sent.find(message => message.t === "api.res" && message.id === "stop-draining") as any;
    assert.equal(response?.body.phase, "draining");
    assert.equal(response?.body.running?.runningTurnId, TURN_ID);
    assert.equal(completed, false);
  } finally { release(); await work; harness.cleanup(); }
  assert.equal(harness.sent.filter(message => message.t === "api.res" && message.id === "stop-draining").length, 1);
});

test("API工作区准入和同步会话读取在短数据库许可内完成", async () => {
  const harness = setupInterruptHarness();
  let permission = false;
  harness.ctx.withDatabase = async (_requestId, operation) => {
    permission = true;
    try { return operation(); } finally { permission = false; }
  };
  harness.db.configureLegacyAccessGuard(() => { if (!permission) throw new Error("test database access outside permit"); });
  try {
    await handleApiRequest(harness.ctx, { t: "api.req", id: "read-under-permit", method: "threads.groups.list", body: { workspaceId: WORKSPACE_ID } } as ApiRequestMessage);
    const response = harness.sent.find(message => message.t === "api.res" && message.id === "read-under-permit") as any;
    assert.equal(response?.status, 200);
  } finally { harness.db.configureLegacyAccessGuard(null); harness.cleanup(); }
});

test("停止与终态所有数据库段持短许可，provider等待期间释放许可", async () => {
  const harness = setupInterruptHarness();
  let permission = false;
  harness.ctx.withDatabase = async (_requestId, operation) => {
    permission = true;
    try { return operation(); } finally { permission = false; }
  };
  (harness.ctx.sessions as any).interrupt = async () => { assert.equal(permission, false); await Promise.resolve(); return true; };
  harness.db.configureLegacyAccessGuard(() => { if (!permission) throw new Error("interrupt database access outside permit"); });
  try {
    const response = await interruptTurnBestEffort(harness.ctx, { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID }, { ensureTerminalEvent: true });
    assert.equal(response.running, null);
  } finally { harness.db.configureLegacyAccessGuard(null); harness.cleanup(); }
});

/** 为 Client 重启后的直接中断补齐 provider session/turn 历史映射。 */
function seedRestartCodexTurn(harness: ReturnType<typeof setupInterruptHarness>): void {
  harness.db.threads.setSessionId(THREAD_ID, "engine-session-restart" as any);
  harness.db.turns.setUserMessage(TURN_ID, {
    userItemId: "item-user-interrupt-handler" as any,
    userText: "restart recovery",
  });
  harness.db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 2,
    ts: Date.now() - 500,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "turn/start",
      params: {
        threadId: "engine-session-restart",
        turn: { id: "engine-turn-restart" },
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  } as any);
  harness.db.rawEvents.appendEnvelope({
    schema: 1,
    seq: 3,
    ts: Date.now() - 400,
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "item/started",
      params: {
        threadId: "engine-session-restart",
        turnId: "engine-turn-restart",
        item: {
          type: "userMessage",
          id: "provider-user-interrupt-handler",
          clientId: "item-user-interrupt-handler",
        },
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  } as any);
}

/** 创建完整 send -> interrupt 竞态夹具，验证 terminal 与队列通知只有一个 owner。 */
function setupSendInterruptRaceHarness() {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-turn-interrupt-race-"));
  const application = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  application.workspaces.upsert({ id: WORKSPACE_ID, title: "中断竞态工作区", path: workspacePath });
  const db = application.forWorkspace(WORKSPACE_ID);
  const sent: ClientToServerMessage[] = [];
  const queueTerminals: any[] = [];
  const threads = new ThreadStore();
  let seq = 200;
  let activeTurnId: string | null = null;
  let resolveSend: ((result: { responseText: string }) => void) | null = null;
  let rejectSend: ((error: Error) => void) | null = null;
  let resolveCompact: (() => void) | null = null;
  let rejectCompact: ((error: Error) => void) | null = null;
  let compactCalls = 0;
  let sessionGetOrCreateCalls = 0;
  let providerSessionId: string | null = null;
  let signalSendStarted!: () => void;
  const sendStarted = new Promise<void>(resolve => { signalSendStarted = resolve; });
  let releasePrepare!: () => void;
  let prepareCalls = 0;
  const prepareGate = new Promise<void>((resolve) => {
    releasePrepare = resolve;
  });

  db.threads.create({ id: THREAD_ID, workspaceId: WORKSPACE_ID, engine: "codex", title: "中断竞态" });

  const session = {
    engine: "codex",
    workspaceId: WORKSPACE_ID,
    threadId: THREAD_ID,
    getSessionId() { return providerSessionId as any; },
    hasActiveTurn() { return activeTurnId != null; },
    getActiveTurnId() { return activeTurnId as any; },
    resolvePlatformToolTransport() { return "native-dynamic"; },
    async prepareAssistantTerminalEvents() {
      prepareCalls += 1;
      await prepareGate;
      return { events: [], latestAssistantText: null };
    },
    async sendMessage(input: any) {
      activeTurnId = String(input.turnId);
      return await new Promise<{ responseText: string }>((resolve, reject) => {
        resolveSend = resolve;
        rejectSend = reject;
        signalSendStarted();
      });
    },
    async compactThread(input: any) {
      compactCalls += 1;
      activeTurnId = String(input.turnId);
      return await new Promise<void>((resolve, reject) => {
        resolveCompact = resolve;
        rejectCompact = reject;
      });
    },
    async interrupt(turnId: string) {
      const reject = rejectSend ?? rejectCompact;
      if (!activeTurnId || activeTurnId !== String(turnId) || !reject) return false;
      const error = Object.assign(new Error("turn interrupted"), {
        code: MANUAL_TURN_INTERRUPT_CODE,
        terminationKind: "manual_interrupt",
      });
      reject(error);
      rejectSend = null;
      rejectCompact = null;
      activeTurnId = null;
      return true;
    },
  };

  const ctx = {
    db,
    workspaces: new Map([[WORKSPACE_ID, workspacePath]]),
    clientId: "client-test",
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 1_000 },
    threads,
    sessions: {
      /** 测试不模拟删除竞态，thread 操作租约立即成功。 */
      beginThreadOperation() { return () => {}; },
      getOrCreate() {
        sessionGetOrCreateCalls += 1;
        return session;
      },
      hasActiveTurn() { return session.hasActiveTurn(); },
      getActiveTurnId() { return session.getActiveTurnId(); },
      async interrupt(_threadId: ThreadId, turnId: string) { return await session.interrupt(turnId); },
    },
    orchEngine: {
      forWorkspace() { return this; },
      buildManagedServiceToolRegistry() { return null; },
    },
    queueDispatcher: {
      notifyTurnTerminal(input: unknown) { queueTerminals.push(input); },
    },
    getActiveThreadTurn() {
      return activeTurnId ? { turnId: activeTurnId, startedAt: Date.now(), source: "runtime" } : null;
    },
    clearActiveThreadTurn() {
      activeTurnId = null;
    },
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
    onBeforeEmitConversationEvent(event: any) {
      const envelope = { ...event, seq: ++seq };
      db.conversationEvents.appendEnvelope(envelope);
      const turnId = String(event?.payload?.turnId ?? "").trim() as any;
      if (event.type === "turn.started" && turnId && !db.turns.get(turnId)) {
        db.turns.insertStarted({
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          engine: "codex",
          turnId,
          startedAt: Number(event.ts ?? Date.now()),
          startEventSeq: envelope.seq,
        });
      }
      if (event.type === "turn.error" && turnId) {
        db.turns.setEnded(turnId, {
          status: "error",
          endedAt: Number(event.ts ?? Date.now()),
          endEventSeq: envelope.seq,
        });
      }
    },
  } as unknown as ApiHandlerContext;

  /** 模拟 provider 自然完成当前 send，并释放 session active 标记。 */
  const completeSend = (responseText = "completed") => {
    const resolve = resolveSend;
    if (!resolve) throw new Error("send 尚未启动");
    activeTurnId = null;
    resolveSend = null;
    rejectSend = null;
    resolve({ responseText });
  };

  /** 模拟 provider 自然完成 compact，并释放 session active 标记。 */
  const completeCompact = () => {
    const resolve = resolveCompact;
    if (!resolve) throw new Error("compact 尚未启动");
    activeTurnId = null;
    resolveCompact = null;
    rejectCompact = null;
    resolve();
  };

  /** 模拟 provider 以普通错误结束 compact，并释放 session active 标记。 */
  const failCompact = (error: Error) => {
    const reject = rejectCompact;
    if (!reject) throw new Error("compact 尚未启动");
    activeTurnId = null;
    resolveCompact = null;
    rejectCompact = null;
    reject(error);
  };

  return {
    db,
    ctx,
    session,
    sent,
    queueTerminals,
    completeSend,
    sendStarted,
    completeCompact,
    failCompact,
    releasePrepare,
    get prepareCalls() { return prepareCalls; },
    get compactCalls() { return compactCalls; },
    get sessionGetOrCreateCalls() { return sessionGetOrCreateCalls; },
    setProviderSessionId(sessionId: string | null) { providerSessionId = sessionId; },
    cleanup() {
      application.close();
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test("turns.interrupt waits for local terminal event before ack", async () => {
  const harness = setupInterruptHarness();
  try {
    const request = {
      t: "api.req",
      id: "req-interrupt",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage;

    const pending = handleApiRequest(harness.ctx, request);
    assert.equal(harness.sent.some((message) => message.t === "api.res"), false);

    await pending;

    assert.equal(harness.interruptFinished, true);
    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-interrupt") as any;
    assert.equal(response?.status, 200);

    const turn = harness.db.turns.get(TURN_ID);
    assert.equal(turn?.status, "error");
    assert.ok(turn?.endedAt);

    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).at(-1) as any;
    assert.equal(terminal?.type, "turn.error");
    assert.equal(terminal?.payload?.code, MANUAL_TURN_INTERRUPT_CODE);
    assert.equal(terminal?.payload?.terminationKind, "manual_interrupt");
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 拒绝旧标签页停止 A 且保留 runtime active B", async () => {
  const harness = setupInterruptHarness();
  let runtimeTurnId = "turn-runtime-newer" as any;
  let interruptCalls = 0;
  let clearCalls = 0;
  try {
    harness.ctx.getActiveThreadTurn = () => runtimeTurnId
      ? { turnId: runtimeTurnId, startedAt: Date.now(), source: "runtime" }
      : null;
    harness.ctx.clearActiveThreadTurn = () => {
      clearCalls += 1;
      runtimeTurnId = null;
    };
    (harness.ctx.sessions as any).interrupt = async () => {
      interruptCalls += 1;
      return true;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stale-interrupt-target",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stale-interrupt-target",
    ) as any;
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "thread_runtime_stale");
    assert.match(String(response?.body?.message ?? ""), /当前 turnId=turn-runtime-newer/);
    assert.equal(interruptCalls, 0);
    assert.equal(clearCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.ctx.getActiveThreadTurn?.({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    })?.turnId, runtimeTurnId);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 拒绝无 active thread 携带其他 thread 的 Claude turnId", async () => {
  const harness = setupInterruptHarness();
  const requestedThreadId = "thread-interrupt-request-claude" as ThreadId;
  const foreignThreadId = "thread-interrupt-foreign-claude" as ThreadId;
  const foreignTurnId = "turn-interrupt-foreign-claude" as any;
  let interruptCalls = 0;
  try {
    harness.db.threads.create({
      id: requestedThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "claude",
      title: "请求停止的空闲线程",
    });
    harness.db.threads.create({
      id: foreignThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "claude",
      title: "不得被停止的线程",
    });
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: foreignThreadId,
      engine: "claude",
      turnId: foreignTurnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 10,
    });
    (harness.ctx.sessions as any).interrupt = async () => {
      interruptCalls += 1;
      return false;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-foreign-claude-turn",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: requestedThreadId, turnId: foreignTurnId },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-foreign-claude-turn",
    ) as any;
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "thread_runtime_stale");
    assert.equal(interruptCalls, 0);
    assert.equal(harness.db.turns.get(foreignTurnId)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(foreignThreadId).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 拒绝无 active thread 携带其他 workspace 的 Codex turnId", async () => {
  const harness = setupInterruptHarness();
  const requestedThreadId = "thread-interrupt-request-codex" as ThreadId;
  const foreignWorkspaceId = "client-test:ws-interrupt-foreign" as WorkspaceId;
  const foreignThreadId = requestedThreadId;
  const foreignTurnId = "turn-interrupt-foreign-codex" as any;
  const foreignScope = { workspaceId: foreignWorkspaceId, threadId: foreignThreadId, turnId: foreignTurnId };
  let releaseForeign!: () => void;
  const foreignPreparing = new Promise<void>(resolve => { releaseForeign = resolve; });
  let interruptCalls = 0;
  try {
    const workspacePath = path.join(harness.ctx.workspaces.get(WORKSPACE_ID)!, "foreign-workspace");
    fs.mkdirSync(workspacePath);
    harness.db.workspaces.upsert({ id: foreignWorkspaceId, title: "其他工作区", path: workspacePath });
    const foreign = harness.db.forWorkspace(foreignWorkspaceId);
    harness.db.threads.create({
      id: requestedThreadId,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "请求停止的空闲线程",
    });
    foreign.threads.create({
      id: foreignThreadId,
      workspaceId: foreignWorkspaceId,
      engine: "codex",
      title: "其他工作区线程",
    });
    foreign.turns.insertStarted({
      workspaceId: foreignWorkspaceId,
      threadId: foreignThreadId,
      engine: "codex",
      turnId: foreignTurnId,
      startedAt: Date.now() - 1_000,
      startEventSeq: 11,
    });
    trackOrdinaryTurnExecution(harness.ctx.sessions, foreignScope, async control => {
      await foreignPreparing;
      control.assertNotCancelled();
    });
    (harness.ctx.sessions as any).interrupt = async () => {
      interruptCalls += 1;
      return false;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-foreign-codex-turn",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: requestedThreadId, turnId: foreignTurnId },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-foreign-codex-turn",
    ) as any;
    assert.equal(response?.status, 409, JSON.stringify(response));
    assert.equal(response?.body?.code, "thread_runtime_stale");
    assert.equal(interruptCalls, 0);
    assert.equal(foreign.turns.get(foreignTurnId)?.status, "started");
  } finally {
    releaseForeign();
    await waitForOrdinaryTurnExecution(harness.ctx.sessions, foreignScope);
    harness.cleanup();
  }
});

test("未知turn中断的stale诊断失败保留409错误且不调用provider", async t => {
  const harness = setupInterruptHarness(), threadId = "idle-missing-target" as ThreadId;
  let calls = 0;
  try {
    harness.db.threads.create({ id: threadId, workspaceId: WORKSPACE_ID, engine: "codex", title: "空闲" });
    (harness.ctx.sessions as any).interrupt = async () => { calls++; return false; };
    t.mock.method(harness.db, "writeWorkspaceLog", () => { throw undefined; });
    await assert.rejects(interruptTurnBestEffort(harness.ctx, { workspaceId: WORKSPACE_ID, threadId,
      turnId: "missing-turn" as never }), error => {
      assert.equal((error as { code?: string }).code, "thread_runtime_stale");
      return true;
    });
    assert.equal(calls, 0);
  } finally { harness.cleanup(); }
});

test("中断日志失败只告警，缺少精确身份仍保留原业务原因且不猜测停止", async t => {
  const harness = setupInterruptHarness(), writer = { diagnostic: "writer-failed" };
  let recoveryCalls = 0;
  try {
    (harness.ctx.sessions as any).interrupt = async () => { throw undefined; };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => { recoveryCalls++; };
    t.mock.method(harness.db, "writeWorkspaceLog", () => { throw writer; });
    await assert.rejects(interruptTurnBestEffort(harness.ctx, { workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID, turnId: TURN_ID }), error => {
      assert.equal((error as { code?: string }).code, "codex_provider_turn_identity_missing");
      assert.equal((error as Error).cause, undefined);
      return true;
    });
    assert.equal(recoveryCalls, 0);
  } finally { harness.cleanup(); }
});

test("live和精确中断均抛falsy时仍保留两段原始原因", async () => {
  const harness = setupInterruptHarness();
  try {
    seedRestartCodexTurn(harness);
    (harness.ctx.sessions as any).interrupt = async () => { throw undefined; };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => { throw 0; };
    await assert.rejects(interruptTurnBestEffort(harness.ctx, { workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID, turnId: TURN_ID }), (error: any) => {
      assert.equal(error.cause?.liveInterruptCause, undefined);
      assert.equal(Object.hasOwn(error.cause, "liveInterruptCause"), true);
      assert.equal(error.cause.exactInterruptCause, 0);
      assert.equal(error.cause.cause, 0);
      return true;
    });
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
  } finally { harness.cleanup(); }
});

test("send 后立即停止只写一次 terminal 并只通知一次队列", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-race",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "发送后立即停止",
      },
    } as ApiRequestMessage);
    const sendResponse = harness.sent.find((message) => message.t === "api.res" && message.id === "req-send-race") as any;
    assert.equal(sendResponse?.status, 200);

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-race",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.prepareCalls, 1);
    assert.equal(
      harness.sent.some((message) => message.t === "api.res" && message.id === "req-stop-race"),
      true,
    );
    harness.releasePrepare();
    await pendingInterrupt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const terminalErrors = events.filter((event) => event.type === "turn.error");
    assert.equal(terminalErrors.length, 1);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.equal((terminalErrors[0]?.payload as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
    assert.equal((terminalErrors[0]?.payload as any)?.terminationKind, "manual_interrupt");
    assert.equal(harness.queueTerminals.length, 1);
    assert.equal(harness.queueTerminals[0]?.source, "user_send");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");

    const stopResponse = harness.sent.find((message) => message.t === "api.res" && message.id === "req-stop-race") as any;
    assert.equal(stopResponse?.status, 200);
    assert.equal(stopResponse?.body?.running?.phase, "draining");
    assert.equal(harness.sent.filter(message => message.t === "api.res" && message.id === "req-stop-race").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("立即停止使用同步 turn 索引识别普通 send，不依赖 user message 事件落库", async () => {
  const harness = setupSendInterruptRaceHarness();
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event: any) => {
      if (event.type === "item.userMessage.created") {
        harness.db.turns.setUserMessage(event.payload.turnId, {
          userItemId: event.payload.itemId,
          userText: String(event.payload.text ?? ""),
        });
        return;
      }
      originalBefore?.(event);
    };
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-indexed-user-message",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "user message 事件尚未 flush",
      },
    } as ApiRequestMessage);
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "item.userMessage.created"),
      false,
    );

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-indexed-user-message",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.releasePrepare();
    await pendingInterrupt;

    assert.equal(harness.queueTerminals.length, 1);
    assert.equal(harness.queueTerminals[0]?.source, "user_send");
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("terminal 后置动作失败时由同一 owner 重试且不重复 terminal", async () => {
  const harness = setupInterruptHarness();
  let buildCalls = 0;
  let afterTerminalCalls = 0;
  try {
    await assert.rejects(
      settleTurnTerminalOnce(harness.ctx, {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "completed",
      }, {
        buildTerminalEvents: async () => {
          buildCalls += 1;
          return [{
            ts: Date.now(),
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            engine: "codex",
            type: "turn.completed",
            payload: { turnId: TURN_ID, result: { responseText: "compact completed" } },
          }];
        },
        notifyQueue() {},
        afterTerminal: async () => {
          afterTerminalCalls += 1;
          if (afterTerminalCalls === 1) throw new Error("compact recovery unavailable");
        },
      }),
      /compact recovery unavailable/,
    );
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");

    assert.equal(await retryPendingTurnTerminal(harness.ctx, {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    }), "emitted");
    assert.equal(buildCalls, 1);
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.completed").length,
      1,
    );
    assert.equal(afterTerminalCalls, 2);
  } finally {
    harness.cleanup();
  }
});

test("terminal accepted 后 SQLite 索引失败重试不重复投递", async () => {
  const harness = setupInterruptHarness();
  const originalSetEnded = harness.db.turns.setEnded.bind(harness.db.turns);
  let setEndedCalls = 0;
  let queueCalls = 0;
  try {
    (harness.db.turns as any).setEnded = (turnId: any, input: any) => {
      setEndedCalls += 1;
      if (setEndedCalls === 1) throw new Error("sqlite terminal index failed");
      return originalSetEnded(turnId, input);
    };

    await assert.rejects(
      settleTurnTerminalOnce(harness.ctx, {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "completed",
      }, {
        buildTerminalEvents: async () => [{
          ts: Date.now(),
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          engine: "codex",
          type: "turn.completed",
          payload: { turnId: TURN_ID, result: { responseText: "accepted before sqlite failure" } },
        }],
        notifyQueue() {
          queueCalls += 1;
        },
      }),
      /sqlite terminal index failed/,
    );

    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(queueCalls, 0);
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.completed").length,
      1,
    );

    assert.equal(await retryPendingTurnTerminal(harness.ctx, {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    }), "emitted");
    assert.equal(setEndedCalls, 2);
    assert.equal(queueCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.completed").length,
      1,
    );
  } finally {
    harness.cleanup();
  }
});

test("session invalidated 第二条事件失败时重试不重复已 accepted notice", async () => {
  const harness = setupInterruptHarness();
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  const originalSend = harness.ctx.send;
  let rejectErrorDispatch = true;
  let queueCalls = 0;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event) => {
      if (rejectErrorDispatch && event.type === "turn.error") return;
      originalBefore?.(event);
    };
    harness.ctx.send = (message) => {
      originalSend(message);
      if (rejectErrorDispatch && message.t === "conversation.event" && message.event.type === "turn.error") {
        return {
          accepted: false,
          messageType: message.t,
          readyState: 3,
          bufferedAmount: 0,
          bytes: 0,
          reason: "socket not open",
          queuedAt: Date.now(),
          callbackError: null,
        };
      }
    };

    await assert.rejects(
      settleTurnTerminalOnce(harness.ctx, {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "error",
      }, {
        buildTerminalEvents: async () => [
          {
            ts: Date.now(),
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            engine: "codex",
            type: "system.notice",
            payload: { level: "error", text: "session invalidated", action: "session.invalidated" },
          },
          createTurnErrorEventInput({
            ts: Date.now(),
            workspaceId: WORKSPACE_ID,
            threadId: THREAD_ID,
            engine: "codex",
            turnId: TURN_ID,
            error: "session invalidated",
            code: "session_invalidated",
            terminationKind: "error",
          }),
        ],
        notifyQueue() {
          queueCalls += 1;
        },
      }),
      /dispatch rejected/,
    );

    assert.deepEqual(
      harness.sent.filter((message) => message.t === "conversation.event").map((message) => message.event.type),
      ["system.notice", "turn.error"],
    );
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(queueCalls, 0);

    rejectErrorDispatch = false;
    assert.equal(await retryPendingTurnTerminal(harness.ctx, {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    }), "emitted");
    assert.deepEqual(
      harness.sent.filter((message) => message.t === "conversation.event").map((message) => message.event.type),
      ["system.notice", "turn.error", "turn.error"],
    );
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).filter((event) => event.type === "system.notice").length,
      1,
    );
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(queueCalls, 1);
  } finally {
    harness.cleanup();
  }
});

test("recovered assistant 前缀 accepted 后 completed 失败只重发 completed", async () => {
  const harness = setupInterruptHarness();
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  const originalSend = harness.ctx.send;
  let rejectCompletedDispatch = true;
  let buildCalls = 0;
  let queueCalls = 0;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event) => {
      if (rejectCompletedDispatch && event.type === "turn.completed") return;
      originalBefore?.(event);
    };
    harness.ctx.send = (message) => {
      originalSend(message);
      if (rejectCompletedDispatch && message.t === "conversation.event" && message.event.type === "turn.completed") {
        return {
          accepted: false,
          messageType: message.t,
          readyState: 3,
          bufferedAmount: 0,
          bytes: 0,
          reason: "socket not open",
          queuedAt: Date.now(),
          callbackError: null,
        };
      }
    };

    await assert.rejects(
      settleTurnTerminalOnce(harness.ctx, {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        status: "completed",
      }, {
        buildTerminalEvents: async () => {
          buildCalls += 1;
          return [
            {
              ts: Date.now(),
              workspaceId: WORKSPACE_ID,
              threadId: THREAD_ID,
              engine: "codex",
              type: "item.agentMessage.completed",
              payload: {
                itemId: "msg-recovered-prefix",
                engineMessageId: "msg-recovered-prefix",
                turnId: TURN_ID,
                text: "recovered prefix",
                revision: 1,
                phase: "final_answer",
                completionSource: "snapshot_reconcile",
                structuredPayloadJson: null,
              },
            },
            {
              ts: Date.now(),
              workspaceId: WORKSPACE_ID,
              threadId: THREAD_ID,
              engine: "codex",
              type: "turn.completed",
              payload: {
                turnId: TURN_ID,
                result: { responseText: "recovered prefix", recoveredAfterRestart: true },
              },
            },
          ];
        },
        notifyQueue() {
          queueCalls += 1;
        },
      }),
      /dispatch rejected/,
    );

    rejectCompletedDispatch = false;
    assert.equal(await retryPendingTurnTerminal(harness.ctx, {
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
    }), "emitted");
    const attempts = harness.sent.filter((message) => message.t === "conversation.event");
    assert.equal(attempts.filter((message) => message.event.type === "item.agentMessage.completed").length, 1);
    assert.equal(attempts.filter((message) => message.event.type === "turn.completed").length, 2);
    assert.equal(buildCalls, 1);
    assert.equal(queueCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
  } finally {
    harness.cleanup();
  }
});

test("compact 只结算自身且不自动恢复 waiting-feedback 节点", async () => {
  const harness = setupSendInterruptRaceHarness();
  const nodeId = "node-compact-waiting-feedback";
  const providerThreadId = "provider-thread-compact-waiting-feedback";
  let recoveryCalls = 0;
  let submitFeedbackCalls = 0;
  try {
    harness.db.threads.delete(THREAD_ID);
    harness.db.threads.create({
      id: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "等待反馈节点压缩",
      threadType: "orchestration",
      threadSubtype: "node",
    });
    harness.db.threads.setSessionId(THREAD_ID, providerThreadId as any);
    harness.setProviderSessionId(providerThreadId);
    const instance = harness.db.orchInstances.create({
      workspaceId: WORKSPACE_ID,
      workflowId: "workflow-compact-waiting-feedback" as any,
      workflowSnapshot: {
        id: "workflow-compact-waiting-feedback",
        workspaceId: WORKSPACE_ID,
        family: "feature-dev",
        name: "等待反馈节点压缩测试流程",
        description: "验证 compact 不驱动编排恢复",
        workflowKnowledgeBundleIds: [],
        nodes: [{
          id: nodeId,
          type: "role",
          roleId: "role-compact-waiting-feedback",
          label: "实现",
          position: { x: 0, y: 0 },
        }],
        edges: [],
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      intakeSnapshot: {
        id: "intake-compact-waiting-feedback",
        workspaceId: WORKSPACE_ID,
        triggerMode: "manual",
        taskType: "feature",
        title: "等待反馈节点压缩",
        goal: "验证 compact 只完成自身结算",
        background: null,
        acceptanceCriteria: null,
        workbenchItemRefs: null,
        seedArtifactRefs: null,
        constraints: null,
        requester: null,
        createdAt: 1,
        updatedAt: 1,
      },
    } as any);
    harness.db.orchInstances.updateStatus(instance.id, "running");
    const attempt = harness.db.orchNodeAttempts.begin({ instanceId: instance.id, nodeId });
    harness.db.orchNodeAttempts.bindExecution(attempt.id, THREAD_ID, "turn-node-before-compact");
    harness.db.orchNodeAttempts.markTerminal(attempt.id, "waiting-feedback", "历史恢复状态");
    harness.db.orchInstances.updateNodeStates(instance.id, {
      [nodeId]: {
        nodeId,
        status: "waiting-feedback",
        attemptId: attempt.id,
        nodeExecutionId: attempt.id,
        attemptNo: attempt.attemptNo,
        humanActionSource: "execution",
        threadId: THREAD_ID,
        retryCount: 0,
        error: "历史恢复状态",
        errorCode: "codex_thread_resume_unrecoverable",
        providerThreadId,
        recoveryReason: "resume_not_found_and_read_missing",
        preserveBinding: true,
        userChoiceRequired: true,
        recoveryStrategies: ["retry-existing", "new-thread"],
      },
    } as any);

    (harness.ctx.orchEngine as any).retryExistingNodeRecovery = async () => {
      recoveryCalls += 1;
      throw new Error("compact 不应探测或恢复旧 provider turn");
    };
    (harness.ctx.orchEngine as any).submitFeedback = async () => {
      submitFeedbackCalls += 1;
      throw new Error("compact 不应替用户提交反馈");
    };

    const instanceBefore = harness.db.orchInstances.get(instance.id);
    const attemptBefore = harness.db.orchNodeAttempts.getLatestByNode(instance.id, nodeId);
    assert.ok(instanceBefore);
    assert.ok(attemptBefore);
    const nodeBefore = structuredClone(instanceBefore.nodeStates[nodeId]);
    const attemptSnapshot = structuredClone(attemptBefore);
    const threadIdsBefore = harness.db.threads.listByWorkspace(WORKSPACE_ID, { includeArchived: true })
      .threads.map((item) => item.id).sort();

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-compact-waiting-feedback",
      method: "threads.compact",
      path: "/threads/compact",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    harness.completeCompact();
    for (let current = 0; current < 20 && harness.db.turns.get(TURN_ID)?.status === "started"; current += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-compact-waiting-feedback",
    ) as any;
    const completedEvents = harness.db.conversationEvents.listByThread(THREAD_ID).filter(
      (event) => event.type === "turn.completed"
        && String((event.payload as any)?.turnId) === String(TURN_ID),
    );
    const instanceAfter = harness.db.orchInstances.get(instance.id);
    assert.equal(response?.status, 200);
    assert.equal(harness.compactCalls, 1);
    assert.equal(harness.sessionGetOrCreateCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(completedEvents.length, 1);
    assert.equal(recoveryCalls, 0);
    assert.equal(submitFeedbackCalls, 0);
    assert.equal(instanceAfter?.nodeStates[nodeId]?.status, "waiting-feedback");
    assert.deepEqual(instanceAfter?.nodeStates[nodeId], nodeBefore);
    assert.deepEqual(harness.db.orchNodeAttempts.getLatestByNode(instance.id, nodeId), attemptSnapshot);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, providerThreadId);
    assert.equal(harness.session.getSessionId(), providerThreadId);
    assert.deepEqual(
      harness.db.threads.listByWorkspace(WORKSPACE_ID, { includeArchived: true })
        .threads.map((item) => item.id).sort(),
      threadIdsBefore,
    );
  } finally {
    harness.cleanup();
  }
});

test("手动终态队列通知失败后由下一次 send 自动重试且不重复 terminal", async () => {
  const harness = setupSendInterruptRaceHarness();
  let queueNotifyCalls = 0;
  try {
    harness.ctx.queueDispatcher = {
      notifyTurnTerminal() {
        queueNotifyCalls += 1;
        if (queueNotifyCalls === 1) throw new Error("queue terminal failed");
      },
    } as any;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-queue-failure",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "队列终态失败",
      },
    } as ApiRequestMessage);

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-queue-failure",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.prepareCalls, 1);
    harness.releasePrepare();
    await assert.rejects(pendingInterrupt, (error: any) => {
      assert.equal(error.code, "TURN_INTERRUPT_FINALIZATION_FAILED");
      assert.equal(error.cause?.message, "queue terminal failed");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-queue-failure",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.running?.phase, "draining");
    assert.equal(harness.sent.filter(message => message.t === "api.res" && message.id === "req-stop-queue-failure").length, 1);
    assert.equal(queueNotifyCalls, 1);
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(events.filter((event) => event.type === "turn.error").length, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-before-queue-retry",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: "turn-after-queue-failure",
        text: "队列终态未完成前不得发送",
      },
    } as ApiRequestMessage);
    const recoveredSend = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-send-before-queue-retry",
    ) as any;
    assert.equal(recoveredSend?.status, 200);
    assert.equal(queueNotifyCalls, 2);
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).filter((event) => event.type === "turn.error").length,
      1,
    );
  } finally {
    harness.cleanup();
  }
});

test("provider completed 与停止并发时共用同一 terminal owner", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-natural-complete-race",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "自然完成与停止并发",
      },
    } as ApiRequestMessage);
    await harness.sendStarted;
    (harness.session as any).interrupt = async () => {
      harness.completeSend("provider completed");
      for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return true;
    };

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-natural-complete-race",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.prepareCalls, 1);
    harness.releasePrepare();
    await pendingInterrupt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const terminalEvents = events.filter((event) => event.type === "turn.completed" || event.type === "turn.error");
    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0]?.type, "turn.completed");
    assert.equal(harness.queueTerminals.length, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-natural-complete-race",
    ) as any;
    assert.equal(response?.status, 200);
  } finally {
    harness.cleanup();
  }
});

test("provider completed owner 的队列失败会阻止 stop 假成功并由下一次 send 重试", async () => {
  const harness = setupSendInterruptRaceHarness();
  const queueTerminals: any[] = [];
  let releaseProviderInterrupt!: () => void;
  const providerInterruptGate = new Promise<void>((resolve) => {
    releaseProviderInterrupt = resolve;
  });
  try {
    harness.ctx.queueDispatcher = {
      notifyTurnTerminal(input: unknown) {
        queueTerminals.push(input);
        if (queueTerminals.length <= 2) throw new Error("completed queue terminal failed");
      },
    } as any;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-completed-queue-race",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "completed queue 与停止并发",
      },
    } as ApiRequestMessage);
    await harness.sendStarted;
    (harness.session as any).interrupt = async () => {
      harness.completeSend("provider completed before queue failure");
      for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      await providerInterruptGate;
      return true;
    };

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-completed-queue-race",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.releasePrepare();
    for (let attempt = 0; attempt < 20 && queueTerminals.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(queueTerminals.length, 1);
    releaseProviderInterrupt();
    await pendingInterrupt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failedStop = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-completed-queue-race",
    ) as any;
    assert.equal(failedStop?.status, 500);
    assert.match(String(failedStop?.body?.message ?? ""), /completed queue terminal failed/);
    assert.equal(queueTerminals.length, 2);
    assert.equal(queueTerminals[0]?.outcome, "completed");
    assert.equal(queueTerminals[1]?.outcome, "completed");
    const firstEvents = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(firstEvents.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(firstEvents.filter((event) => event.type === "turn.error").length, 0);

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-after-completed-queue-retry",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: "turn-after-completed-queue-retry",
        text: "重试 completed queue 后发送",
      },
    } as ApiRequestMessage);
    const recoveredSend = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-send-after-completed-queue-retry",
    ) as any;
    assert.equal(recoveredSend?.status, 200);
    assert.equal(queueTerminals.length, 3);
    assert.equal(queueTerminals[2]?.outcome, "completed");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).filter((event) => event.type === "turn.completed").length,
      1,
    );
  } finally {
    releaseProviderInterrupt();
    harness.cleanup();
  }
});

test("completed terminal 被 WebSocket 明确拒绝后保留 pending 并在下一次 send 重发", async () => {
  const harness = setupSendInterruptRaceHarness();
  const originalSend = harness.ctx.send;
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  let rejectTerminalDispatch = true;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event) => {
      if (rejectTerminalDispatch && event.type === "turn.completed") return;
      originalBefore?.(event);
    };
    harness.ctx.send = (message) => {
      originalSend(message);
      if (rejectTerminalDispatch && message.t === "conversation.event" && message.event.type === "turn.completed") {
        return {
          accepted: false,
          messageType: message.t,
          readyState: 3,
          bufferedAmount: 0,
          bytes: 0,
          reason: "socket not open",
          queuedAt: Date.now(),
          callbackError: null,
        };
      }
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-terminal-rejected",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "terminal 首次投递失败",
      },
    } as ApiRequestMessage);
    await harness.sendStarted;
    harness.completeSend("provider completed");
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.releasePrepare();
    for (
      let attempt = 0;
      attempt < 20 && !harness.sent.some((message) => message.t === "conversation.event" && message.event.type === "turn.completed");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.queueTerminals.length, 0);
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.completed"),
      false,
    );

    rejectTerminalDispatch = false;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-after-terminal-retry",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: "turn-after-terminal-retry",
        text: "重试终态后继续",
      },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-send-after-terminal-retry",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(harness.queueTerminals.length, 1);
    assert.equal(harness.queueTerminals[0]?.outcome, "completed");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).filter((event) => event.type === "turn.completed").length,
      1,
    );
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("terminal 本地索引已结束但 WebSocket 拒绝时仍保留 emitter 并重发", async () => {
  const harness = setupSendInterruptRaceHarness();
  const originalSend = harness.ctx.send;
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  let rejectTerminalDispatch = true;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event: any) => {
      originalBefore?.(event);
      if (event.type === "turn.completed") {
        harness.db.turns.setEnded(event.payload.turnId, {
          status: "completed",
          endedAt: Number(event.ts ?? Date.now()),
          endEventSeq: null,
        });
      }
    };
    harness.ctx.send = (message) => {
      originalSend(message);
      if (rejectTerminalDispatch && message.t === "conversation.event" && message.event.type === "turn.completed") {
        return {
          accepted: false,
          messageType: message.t,
          readyState: 3,
          bufferedAmount: 0,
          bytes: 0,
          reason: "socket not open",
          queuedAt: Date.now(),
          callbackError: null,
        };
      }
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-terminal-indexed-before-reject",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "本地先索引 terminal",
      },
    } as ApiRequestMessage);
    await harness.sendStarted;
    harness.completeSend("provider completed");
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.releasePrepare();
    for (
      let attempt = 0;
      attempt < 20 && !harness.sent.some((message) => message.t === "conversation.event" && message.event.type === "turn.completed");
      attempt += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(harness.queueTerminals.length, 0);
    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.completed").length,
      1,
    );

    rejectTerminalDispatch = false;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-after-indexed-terminal-retry",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: "turn-after-indexed-terminal-retry",
        text: "重试本地已索引终态",
      },
    } as ApiRequestMessage);

    assert.equal(
      harness.sent.filter((message) => message.t === "conversation.event" && message.event.type === "turn.completed").length,
      2,
    );
    assert.equal(harness.queueTerminals.length, 1);
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("manual terminal 被 WebSocket 明确拒绝后停止失败且可重试", async () => {
  const harness = setupSendInterruptRaceHarness();
  const originalSend = harness.ctx.send;
  const originalBefore = harness.ctx.onBeforeEmitConversationEvent;
  let rejectTerminalDispatch = true;
  try {
    harness.ctx.onBeforeEmitConversationEvent = (event) => {
      if (rejectTerminalDispatch && event.type === "turn.error") return;
      originalBefore?.(event);
    };
    harness.ctx.send = (message) => {
      originalSend(message);
      if (rejectTerminalDispatch && message.t === "conversation.event" && message.event.type === "turn.error") {
        return {
          accepted: false,
          messageType: message.t,
          readyState: 3,
          bufferedAmount: 0,
          bytes: 0,
          reason: "socket not open",
          queuedAt: Date.now(),
          callbackError: null,
        };
      }
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-manual-terminal-rejected",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "manual terminal 首次投递失败",
      },
    } as ApiRequestMessage);
    const firstInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-manual-terminal-rejected",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    harness.releasePrepare();
    await assert.rejects(firstInterrupt, { code: "TURN_INTERRUPT_FINALIZATION_FAILED" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const failedResponse = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-manual-terminal-rejected",
    ) as any;
    assert.equal(failedResponse?.status, 200);
    assert.equal(failedResponse?.body?.running?.phase, "draining");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.queueTerminals.length, 0);

    rejectTerminalDispatch = false;
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-after-manual-terminal-retry",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const recoveredResponse = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-after-manual-terminal-retry",
    ) as any;
    assert.equal(recoveredResponse?.status, 200);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(harness.queueTerminals.length, 1);
    assert.equal(harness.queueTerminals[0]?.source, "user_send");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).filter((event) => event.type === "turn.error").length,
      1,
    );
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("手动终态等待期间 runtime lifecycle 变化仍按 DB started 完成收口", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-lifecycle-change",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "终态期间 lifecycle 变化",
      },
    } as ApiRequestMessage);
    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-lifecycle-change",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.prepareCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    harness.ctx.threads.delete(THREAD_ID);
    harness.releasePrepare();
    await pendingInterrupt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-stop-lifecycle-change",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(events.filter((event) => event.type === "turn.error").length, 1);
    assert.equal(harness.queueTerminals.length, 1);
  } finally {
    harness.cleanup();
  }
});

test("turn/start 未知态只记录日志并保留 DB running", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    (harness.session as any).sendMessage = async () => {
      throw Object.assign(new Error("turn/start state unknown"), {
        code: "codex_turn_start_state_unknown",
        preserveRunningState: true,
      });
    };
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-send-unknown",
      method: "threads.sendMessage",
      path: "/threads/sendMessage",
      body: {
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        text: "模拟启动未知态",
      },
    } as ApiRequestMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
    assert.equal(events.some((event) => event.type === "system.notice"), false);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.queueTerminals.length, 0);
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("compact 使用数据库最新模型且忽略 renderer 伪造的目录模型", async () => {
  const harness = setupSendInterruptRaceHarness();
  let receivedCatalogModel: string | null = null;
  try {
    harness.db.threads.updatePrefs(THREAD_ID, { model: "gpt-6.1-sol" });
    /** 验证 API 与引擎边界的可信模型来源，不执行真实 provider。 */
    harness.session.compactThread = async (input: any) => {
      receivedCatalogModel = input.catalogModel;
    };
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-compact-trusted-model",
      method: "threads.compact",
      path: "/threads/compact",
      body: {
        workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID,
        model: "renderer-model", catalogModel: "renderer-catalog-model",
      },
    } as ApiRequestMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-compact-trusted-model") as any;
    assert.equal(response?.status, 200);
    assert.equal(receivedCatalogModel, "gpt-6.1-sol");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
  } finally {
    harness.cleanup();
  }
});

test("compact 手动停止共用 terminal owner 且不通知消息队列", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-compact-stop",
      method: "threads.compact",
      path: "/threads/compact",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const pendingInterrupt = handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-compact",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    for (let attempt = 0; attempt < 20 && harness.prepareCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(harness.prepareCalls, 1);
    harness.releasePrepare();
    await pendingInterrupt;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(events.filter((event) => event.type === "turn.error").length, 1);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(harness.queueTerminals.length, 0);
    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-stop-compact") as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.running, null);
  } finally {
    harness.releasePrepare();
    harness.cleanup();
  }
});

test("compact completed 与停止并发时只保留 completed 终态", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-compact-completed-race",
      method: "threads.compact",
      path: "/threads/compact",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    (harness.session as any).interrupt = async () => {
      harness.completeCompact();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return true;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-stop-compact-completed-race",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(harness.queueTerminals.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("compact 普通失败只写一次 error 且不通知消息队列", async () => {
  const harness = setupSendInterruptRaceHarness();
  try {
    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-compact-error",
      method: "threads.compact",
      path: "/threads/compact",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);
    harness.failCompact(new Error("compact provider failed"));
    for (let attempt = 0; attempt < 20 && harness.db.turns.get(TURN_ID)?.status === "started"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const terminalErrors = events.filter((event) => event.type === "turn.error");
    assert.equal(terminalErrors.length, 1);
    assert.match(String((terminalErrors[0]?.payload as any)?.error ?? ""), /compact provider failed/);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(harness.queueTerminals.length, 0);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt keeps running state when live and exact provider interrupts fail", async () => {
  const harness = setupInterruptHarness();
  let exactInterruptCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    (harness.ctx.sessions as any).interrupt = async () => {
      throw Object.assign(new Error("provider interrupt failed"), {
        code: "codex_turn_interrupt_state_unknown",
        preserveRunningState: true,
      });
    };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      exactInterruptCalls += 1;
      assert.equal(String(input.engineSessionId), "engine-session-restart");
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      throw new Error("provider exact interrupt failed");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-failed",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-interrupt-failed") as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /provider interrupt failed/);
    assert.match(String(response?.body?.message ?? ""), /provider exact interrupt failed/);
    assert.equal(exactInterruptCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 使用持久化精确 pair 时以 provider interrupt ACK 直接收口", async () => {
  const harness = setupInterruptHarness();
  let interruptByEngineIdCalls = 0;
  let reconcileCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.db.threads.setSessionId(THREAD_ID, "engine-session-new-binding" as any);
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      interruptByEngineIdCalls += 1;
      assert.equal(input.threadId, THREAD_ID);
      assert.equal(String(input.engineSessionId), "engine-session-restart");
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.turnId, TURN_ID);
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      return {
        kind: "ready",
        actualEngineTurnId: "engine-turn-restart",
      };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async (input: any) => {
      reconcileCalls += 1;
      throw new Error(`interrupt ACK 后不得继续对账：${String(input.engineTurnId)}`);
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-restart-pending",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-restart-pending",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.running?.phase, "draining");
    assert.equal(interruptByEngineIdCalls, 1);
    assert.equal(reconcileCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find((event) => event.type === "turn.error") as any;
    assert.equal(terminal?.payload?.code, MANUAL_TURN_INTERRUPT_CODE);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 本地 raw 已清理时仍使用 durable engineBound 精确中断", async () => {
  const harness = setupInterruptHarness();
  let recoveredInterruptCalls = 0;
  let reconcileCalls = 0;
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 4,
      ts: Date.now() - 300,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: TURN_ID,
        engineTurnId: "engine-turn-restart",
        engineSessionId: "engine-session-restart",
        previousEngineTurnId: null,
      },
    } as any);
    harness.db.rawEvents.deleteByThread(THREAD_ID);
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      recoveredInterruptCalls += 1;
      assert.equal(input.engineSessionId, "engine-session-restart");
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.turnId, TURN_ID);
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      return {
        kind: "ready",
        actualEngineTurnId: "engine-turn-restart",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileCalls += 1;
      throw new Error("interrupt ACK 后不得继续对账");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (threadId: string, expectedSessionId: string) => {
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      detachCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-correlation-incomplete",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-correlation-incomplete",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.running?.phase, "draining");
    assert.equal(recoveredInterruptCalls, 1);
    assert.equal(reconcileCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal((events.find((event) => event.type === "turn.error") as any)?.payload?.code, MANUAL_TURN_INTERRUPT_CODE);
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt ownership 未物化时保留旧 generation 与 running", async () => {
  const harness = setupInterruptHarness();
  let reconcileCalls = 0;
  let detachCalls = 0;
  let disposeCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "pending",
      message: "clientUserMessageId 未物化；当前 foreign running turn=goal-turn",
      code: "codex_turn_ownership_unmaterialized",
      dropSessionBinding: false,
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileCalls += 1;
      throw new Error("ownership 丢失后不得对账或中断 foreign Goal");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (
      threadId: string,
      expectedSessionId: string,
      recovery: any,
    ) => {
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      detachCalls += 1;
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };
    (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
      disposeCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-ownership-lost",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-ownership-lost",
    ) as any;
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find((event) => event.type === "turn.error");
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /ownership|未物化/);
    assert.equal(reconcileCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(terminal, undefined);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt ownership 多义时保留旧 generation 且不追停 provider turn", async () => {
  const harness = setupInterruptHarness();
  let reconcileCalls = 0;
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "pending",
      message: "clientUserMessageId 命中多个 provider turn",
      code: "codex_turn_ownership_ambiguous",
      dropSessionBinding: false,
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileCalls += 1;
      throw new Error("ownership 多义后不得追停任一 provider turn");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (
      threadId: string,
      expectedSessionId: string,
      recovery: any,
    ) => {
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      assert.equal(recovery.clientUserMessageId, "item-user-interrupt-handler");
      detachCalls += 1;
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-ownership-ambiguous",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-ownership-ambiguous",
    ) as any;
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find((event) => event.type === "turn.error");
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /ownership|多个 provider turn/);
    assert.equal(reconcileCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(terminal, undefined);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt ownership 扫描不完整时保留旧 generation 且不追停 foreign turn", async () => {
  const harness = setupInterruptHarness();
  let reconcileCalls = 0;
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "pending",
      message: "本地 clientId 仍可能位于更早历史；当前 foreign running turn=goal-turn",
      code: "codex_turn_correlation_scan_incomplete",
      dropSessionBinding: false,
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileCalls += 1;
      throw new Error("ownership 扫描不完整后不得追停 foreign provider turn");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (
      threadId: string,
      expectedSessionId: string,
      recovery: any,
    ) => {
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      assert.equal(recovery.clientTurnId, TURN_ID);
      assert.equal(recovery.clientUserMessageId, "item-user-interrupt-handler");
      assert.equal(recovery.provisionalProviderTurnId, "engine-turn-restart");
      detachCalls += 1;
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-correlation-scan-incomplete",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-correlation-scan-incomplete",
    ) as any;
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find(
      (event) => event.type === "turn.error",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /历史.*未覆盖|扫描不完整|更早历史/);
    assert.equal(reconcileCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(terminal, undefined);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt durable pair 直接中断且保留 provider session binding", async () => {
  const harness = setupInterruptHarness();
  let disposeCalls = 0;
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      return {
        kind: "ready",
        actualEngineTurnId: "engine-turn-restart",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      throw new Error("interrupt ACK 后不得继续对账");
    };
    (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
      disposeCalls += 1;
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (threadId: string, expectedSessionId: string) => {
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      detachCalls += 1;
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };
    (harness.ctx.sessions as any).getOrCreate = () => {
      throw new Error("stale provider turn 不得创建本地 session 读取 assistant");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-recover-actual-turn",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-recover-actual-turn",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(response?.body?.running?.phase, "draining");
    assert.equal(disposeCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find(
      (event) => event.type === "turn.error",
    ) as any;
    assert.equal(terminal?.payload?.code, MANUAL_TURN_INTERRUPT_CODE);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 重启后使用最新 steer provider turn 对应的 clientUserMessageId", async () => {
  const harness = setupInterruptHarness();
  try {
    harness.db.threads.setSessionId(THREAD_ID, "engine-session-steered" as any);
    harness.db.turns.setUserMessage(TURN_ID, {
      userItemId: "item-user-a" as any,
      userText: "initial A",
    });
    for (const event of [
      {
        seq: 2,
        data: {
          method: "turn/started",
          params: { threadId: "engine-session-steered", turn: { id: "engine-turn-a" } },
        },
      },
      {
        seq: 3,
        data: {
          method: "item/started",
          params: {
            threadId: "engine-session-steered",
            turnId: "engine-turn-a",
            item: { type: "userMessage", id: "provider-user-a", clientId: "item-user-a" },
          },
        },
      },
      {
        seq: 4,
        data: {
          method: "turn/started",
          params: { threadId: "engine-session-steered", turn: { id: "engine-turn-b" } },
        },
      },
      {
        seq: 5,
        data: {
          method: "item/started",
          params: {
            threadId: "engine-session-steered",
            turnId: "engine-turn-b",
            item: { type: "userMessage", id: "provider-user-a-steered", clientId: "item-user-a" },
          },
        },
      },
      {
        seq: 6,
        data: {
          method: "item/started",
          params: {
            threadId: "engine-session-steered",
            turnId: "engine-turn-b",
            item: { type: "userMessage", id: "provider-user-b", clientId: "item-user-b" },
          },
        },
      },
    ]) {
      harness.db.rawEvents.appendEnvelope({
        schema: 1,
        seq: event.seq,
        ts: Date.now() - (10 - event.seq),
        workspaceId: WORKSPACE_ID,
        threadId: THREAD_ID,
        engine: "codex",
        source: "codex.app-server.msg",
        data: event.data,
        handled: true,
        action: "mapped",
        emittedTypes: [],
      } as any);
    }
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 2,
      ts: Date.now() - 8,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: TURN_ID,
        engineTurnId: "engine-turn-a",
        engineSessionId: "engine-session-steered",
        previousEngineTurnId: null,
      },
    } as any);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 3,
      ts: Date.now() - 7,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "item.userMessage.created",
      payload: { turnId: TURN_ID, itemId: "item-user-b", text: "steer B" },
    } as any);
    harness.db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 4,
      ts: Date.now() - 6,
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      type: "turn.engineBound",
      payload: {
        turnId: TURN_ID,
        engineTurnId: "engine-turn-b",
        engineSessionId: "engine-session-steered",
        previousEngineTurnId: "engine-turn-a",
      },
    } as any);
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      assert.equal(input.engineTurnId, "engine-turn-b");
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      return { kind: "ready", actualEngineTurnId: "engine-turn-b", allowSiblingRunning: true };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      throw new Error("interrupt ACK 后不得继续对账");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-restart-steered",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-restart-steered",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt provider session 恢复失败时保留绑定与 running", async () => {
  const harness = setupInterruptHarness();
  let detachCalls = 0;
  let reconcileCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "error",
      message: "Codex 引擎会话已失效，client 重启后无法恢复该回合。",
      code: "session_invalidated",
      dropSessionBinding: true,
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileCalls += 1;
      throw new Error("session_invalidated 不应继续对账");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (threadId: string, expectedSessionId: string) => {
      detachCalls += 1;
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-session-invalidated",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-session-invalidated",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /会话已失效|无法恢复/);
    assert.equal(detachCalls, 0);
    assert.equal(reconcileCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find(
      (event) => event.type === "turn.error",
    ) as any;
    const notice = harness.db.conversationEvents.listByThread(THREAD_ID).find(
      (event) => event.type === "system.notice",
    ) as any;
    assert.equal(notice, undefined);
    assert.equal(terminal, undefined);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 旧 generation 结果不清理当前 successor binding", async () => {
  for (const phase of ["interrupt", "reconcile"] as const) {
    const harness = setupInterruptHarness();
    try {
      seedRestartCodexTurn(harness);
      const successorSessionId = `engine-session-successor-${phase}` as any;
      harness.db.threads.setSessionId(THREAD_ID, successorSessionId);
      harness.ctx.threads.create({
        threadId: THREAD_ID,
        workspaceId: WORKSPACE_ID,
        engine: "codex",
        title: "中断测试 successor",
        sessionId: successorSessionId,
      });
      let cleanupCalls = 0;
      (harness.ctx.sessions as any).interrupt = async () => false;
      (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => phase === "interrupt"
        ? {
            kind: "error",
            message: "old provider session invalidated",
            code: "session_invalidated",
            dropSessionBinding: true,
          }
        : {
            kind: "ready",
            actualEngineTurnId: "engine-turn-restart",
            allowSiblingRunning: true,
          };
      (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => ({
        kind: "error",
        message: "old provider session invalidated after interrupt",
        code: "session_invalidated",
        dropSessionBinding: true,
      });
      (harness.ctx.sessions as any).detachCodexProviderGeneration = () => {
        cleanupCalls += 1;
      };
      (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
        cleanupCalls += 1;
      };

      await handleApiRequest(harness.ctx, {
        t: "api.req",
        id: `req-interrupt-invalidated-successor-${phase}`,
        method: "turns.interrupt",
        path: "/turns/interrupt",
        body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
      } as ApiRequestMessage);

      const response = harness.sent.find(
        (message) => message.t === "api.res" && message.id === `req-interrupt-invalidated-successor-${phase}`,
      ) as any;
      const events = harness.db.conversationEvents.listByThread(THREAD_ID);
      assert.equal(response?.status, phase === "interrupt" ? 500 : 200, phase);
      assert.equal(cleanupCalls, 0, phase);
      assert.equal(harness.db.turns.get(TURN_ID)?.status, phase === "interrupt" ? "started" : "error", phase);
      assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, successorSessionId, phase);
      assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, successorSessionId, phase);
      assert.equal(events.some((event) => (event.payload as any)?.action === "session.invalidated"), false, phase);
      assert.equal(events.some((event) => event.type === "turn.error"), phase === "reconcile", phase);
    } finally {
      harness.cleanup();
    }
  }
});

test("turns.interrupt live session 失败后仍用持久化精确 pair 停止", async () => {
  const harness = setupInterruptHarness();
  let disposeCalls = 0;
  let detachCalls = 0;
  let fallbackCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => {
      throw Object.assign(new Error("Codex 引擎会话已失效，无法恢复当前回合。"), {
        code: "session_invalidated",
      });
    };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      fallbackCalls += 1;
      assert.equal(input.engineSessionId, "engine-session-restart");
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.exactProviderTurn, true);
      return {
        kind: "ready",
        actualEngineTurnId: "engine-turn-restart",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = (threadId: string, expectedSessionId: string) => {
      detachCalls += 1;
      assert.equal(threadId, THREAD_ID);
      assert.equal(expectedSessionId, "engine-session-restart");
      harness.db.threads.clearSessionId(THREAD_ID);
      harness.ctx.threads.dropSessionBinding(THREAD_ID);
    };
    (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
      disposeCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-active-session-invalidated",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-active-session-invalidated",
    ) as any;
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(response?.status, 200);
    assert.equal(disposeCalls, 0);
    assert.equal(detachCalls, 0);
    assert.equal(fallbackCalls, 1);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(events.filter((event) => event.type === "system.notice").length, 0);
    assert.equal(events.filter((event) => event.type === "turn.error").length, 1);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt unrecoverable 但无 provider ACK 时保留 binding 与 running", async () => {
  const harness = setupInterruptHarness();
  let detachCalls = 0;
  let disposeCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试 unrecoverable",
      sessionId: "engine-session-restart" as any,
    });
    (harness.ctx.sessions as any).interrupt = async () => {
      throw Object.assign(new Error("resume 与 read 均确认原 provider thread 不存在"), {
        code: "codex_thread_resume_unrecoverable",
        providerThreadId: "engine-session-restart",
        reason: "resume_not_found_and_read_missing",
        preserveBinding: true,
        userChoiceRequired: true,
        recoveryStrategies: ["retry-existing", "new-thread"],
      });
    };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "pending",
      message: "精确 provider interrupt 仍未确认",
      code: "codex_detached_turn_interrupt_state_unknown",
      dropSessionBinding: false,
    });
    (harness.ctx.sessions as any).detachCodexProviderGeneration = () => {
      detachCalls += 1;
    };
    (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
      disposeCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-active-session-unrecoverable",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-active-session-unrecoverable",
    ) as any;
    const terminal = harness.db.conversationEvents.listByThread(THREAD_ID).find(
      (event) => event.type === "turn.error",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认/);
    assert.match(String(response?.body?.message ?? ""), /resume 与 read 均确认原 provider thread 不存在/);
    assert.match(String(response?.body?.message ?? ""), /精确 provider interrupt 仍未确认/);
    assert.equal(detachCalls, 0);
    assert.equal(disposeCalls, 0);
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, "engine-session-restart");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(terminal, undefined);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt provider 已明确 interrupted 时写真实终态", async () => {
  const harness = setupInterruptHarness();
  let reconcileInput: any = null;
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    const successorSessionId = "engine-session-interrupted-successor" as any;
    harness.db.threads.setSessionId(THREAD_ID, successorSessionId);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试 successor",
      sessionId: successorSessionId,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "terminal",
      actualEngineTurnId: "engine-turn-restart",
      allowSiblingRunning: true,
      reconciled: {
        kind: "error",
        message: "Codex turn ended as interrupted",
        code: "codex_interrupted",
        dropSessionBinding: false,
      },
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      reconcileInput = "called";
      throw new Error("明确终态不得继续对账");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = () => {
      detachCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-restart-interrupted",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-restart-interrupted",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(detachCalls, 0);
    assert.equal(reconcileInput, null);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const terminal = events.find((event) => event.type === "turn.error") as any;
    assert.equal(terminal?.payload?.code, "codex_interrupted");
    assert.equal(terminal?.payload?.terminationKind, "transient_cleanup");
    assert.equal(events.some((event) => event.type === "turn.completed"), false);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt provider 已明确 completed 时保留 assistant 快照", async () => {
  const harness = setupInterruptHarness();
  let detachCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    const successorSessionId = "engine-session-completed-successor" as any;
    harness.db.threads.setSessionId(THREAD_ID, successorSessionId);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试 successor",
      sessionId: successorSessionId,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => ({
      kind: "terminal",
      actualEngineTurnId: "engine-turn-restart",
      allowSiblingRunning: true,
      reconciled: {
        kind: "completed",
        responseText: "重启后恢复的最终答复",
        assistantEvents: [{
          ts: Date.now(),
          workspaceId: WORKSPACE_ID,
          threadId: THREAD_ID,
          engine: "codex",
          type: "item.agentMessage.completed",
          payload: {
            itemId: "msg-restart-completed",
            engineMessageId: "msg-restart-completed",
            turnId: TURN_ID,
            text: "重启后恢复的最终答复",
            revision: 1,
            phase: "final_answer",
            completionSource: "snapshot_reconcile",
            structuredPayloadJson: null,
          },
        }],
      },
    });
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      throw new Error("明确终态不得继续对账");
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = () => {
      detachCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-restart-completed",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-restart-completed",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(detachCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const assistant = events.find((event) => event.type === "item.agentMessage.completed") as any;
    const terminal = events.find((event) => event.type === "turn.completed") as any;
    assert.equal(assistant?.payload?.text, "重启后恢复的最终答复");
    assert.equal(terminal?.payload?.result?.responseText, "重启后恢复的最终答复");
    assert.equal(terminal?.payload?.result?.recoveredAfterRestart, true);
    assert.equal(events.some((event) => event.type === "turn.engineBound" && (event.payload as any)?.previousEngineTurnId), false);
    assert.equal(events.some((event) => event.type === "turn.error"), false);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt provider identity 完全丢失时保留本地 pending", async () => {
  const harness = setupInterruptHarness();
  let providerInterruptCalls = 0;
  try {
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => {
      providerInterruptCalls += 1;
      throw new Error("provider identity 完全丢失时不应尝试猜测 provider turn");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-provider-identity-lost-after-restart",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-provider-identity-lost-after-restart",
    ) as any;
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const terminal = events.find((event) => event.type === "turn.error") as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认|sessionId\/turnId/);
    assert.equal(providerInterruptCalls, 0);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(terminal, undefined);
    assert.equal(
      events.some((event) => event.type === "system.notice" && (event.payload as any)?.action === "session.invalidated"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 不得在 provider 未确认且无 engine turn 映射时本地成功", async () => {
  const harness = setupInterruptHarness();
  try {
    harness.db.threads.setSessionId(THREAD_ID, "session-demo" as any);
    (harness.ctx.sessions as any).interrupt = async () => false;

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-unconfirmed",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-unconfirmed",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认/);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 无 sessionId 但 runtime active 时仍不得本地假成功", async () => {
  const harness = setupInterruptHarness();
  try {
    (harness.ctx.sessions as any).interrupt = async () => false;
    harness.ctx.getActiveThreadTurn = ({ includeDb }) => includeDb === false
      ? { turnId: TURN_ID, startedAt: Date.now() - 1_000, source: "runtime" }
      : null;

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-unconfirmed-runtime",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-unconfirmed-runtime",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认/);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 仅有 runtime session binding 时不得按 provider identity 丢失收口", async () => {
  const harness = setupInterruptHarness();
  try {
    (harness.ctx.sessions as any).interrupt = async () => false;
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试 runtime session",
      sessionId: "runtime-session-still-bound" as any,
    });

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-unconfirmed-runtime-session",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-unconfirmed-runtime-session",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认/);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt session manager 仍报告 active 时不得按 provider identity 丢失收口", async () => {
  const harness = setupInterruptHarness();
  try {
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).hasActiveTurn = () => true;

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-unconfirmed-session-active",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-unconfirmed-session-active",
    ) as any;
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /停止状态仍未确认/);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 同一 thread 有多个 started turns 时不得按 provider identity 丢失收口", async () => {
  const harness = setupInterruptHarness();
  const siblingTurnId = "turn-interrupt-handler-sibling" as any;
  try {
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      turnId: siblingTurnId,
      startedAt: Date.now(),
      startEventSeq: 2,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-unconfirmed-multiple-started",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-unconfirmed-multiple-started",
    ) as any;
    assert.equal(response?.status, 409);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
    assert.equal(harness.db.turns.get(siblingTurnId)?.status, "started");
    assert.equal(
      harness.db.conversationEvents.listByThread(THREAD_ID).some((event) => event.type === "turn.error"),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 重启后直接中断 start attempt 的完整 provider pair", async () => {
  const harness = setupInterruptHarness();
  let recoveredInterruptCalls = 0;
  try {
    harness.db.turns.setCodexStartAttempt({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      clientUserMessageId: "item-user-start-attempt-interrupt",
      providerThreadId: "provider-thread-start-attempt-interrupt" as any,
      provisionalProviderTurnId: "provider-turn-ghost-a",
      attemptId: 1,
      observedAt: Date.now() - 500,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      recoveredInterruptCalls += 1;
      assert.equal(String(input.engineSessionId), "provider-thread-start-attempt-interrupt");
      assert.equal(input.engineTurnId, "provider-turn-ghost-a");
      assert.equal(input.exactProviderTurn, true);
      assert.equal(input.clientUserMessageIds, undefined);
      return {
        kind: "ready",
        actualEngineTurnId: "provider-turn-ghost-a",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      throw new Error("interrupt ACK 后不得继续对账");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-start-attempt-recovery",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-start-attempt-recovery",
    ) as any;
    const binding = harness.db.conversationEvents
      .listByThread(THREAD_ID)
      .find((event) => event.type === "turn.engineBound") as any;
    assert.equal(response?.status, 200);
    assert.equal(recoveredInterruptCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(binding?.payload?.engineSessionId, "provider-thread-start-attempt-interrupt");
    assert.equal(binding?.payload?.engineTurnId, "provider-turn-ghost-a");
    assert.equal(binding?.payload?.previousEngineTurnId, null);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 仅保留 thread provider sessionId 时按 clientUserMessageId 恢复后中断", async () => {
  const harness = setupInterruptHarness();
  let recoveredInterruptCalls = 0;
  try {
    harness.db.threads.setSessionId(THREAD_ID, "session-from-turn" as any);
    harness.db.turns.setUserMessage(TURN_ID, {
      userItemId: "item-user-session-only" as any,
      userText: "recover session only",
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      recoveredInterruptCalls += 1;
      assert.equal(String(input.engineSessionId), "session-from-turn");
      assert.equal(input.engineTurnId, null);
      assert.equal(input.exactProviderTurn, false);
      assert.deepEqual(input.clientUserMessageIds, ["item-user-session-only"]);
      return {
        kind: "ready",
        actualEngineTurnId: "provider-turn-recovered",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).reconcileCodexDanglingTurn = async () => {
      throw new Error("interrupt ACK 后不得继续对账");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-turn-session-evidence",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-turn-session-evidence",
    ) as any;
    assert.equal(response?.status, 200);
    assert.equal(recoveredInterruptCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    const binding = events.find((event) => event.type === "turn.engineBound") as any;
    assert.equal(binding?.payload?.engineTurnId, "provider-turn-recovered");
    assert.equal(binding?.payload?.engineSessionId, "session-from-turn");
    assert.equal(binding?.payload?.previousEngineTurnId, null);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt 不把 thread session 弱候选归属给多个 started turns", async () => {
  const harness = setupInterruptHarness();
  let recoveredInterruptCalls = 0;
  try {
    harness.db.threads.setSessionId(THREAD_ID, "session-ambiguous-running" as any);
    harness.db.turns.setUserMessage(TURN_ID, {
      userItemId: "item-user-ambiguous-running" as any,
      userText: "ambiguous running",
    });
    harness.db.turns.insertStarted({
      workspaceId: WORKSPACE_ID,
      threadId: THREAD_ID,
      engine: "codex",
      turnId: "turn-ambiguous-running-sibling" as any,
      startedAt: Date.now() + 1,
      startEventSeq: 2,
    });
    (harness.ctx.sessions as any).interrupt = async () => false;
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async () => {
      recoveredInterruptCalls += 1;
      throw new Error("不应访问 provider");
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-ambiguous-thread-session",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-ambiguous-thread-session",
    ) as any;
    assert.equal(response?.status, 409);
    assert.equal(recoveredInterruptCalls, 0);
    assert.equal(response?.body?.code, "thread_runtime_stale");
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "started");
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt live generation A 失效时不清理等待期间绑定的 successor B", async () => {
  const harness = setupInterruptHarness();
  let cleanupCalls = 0;
  let fallbackCalls = 0;
  try {
    seedRestartCodexTurn(harness);
    harness.db.threads.setSessionId(THREAD_ID, "engine-session-restart" as any);
    harness.ctx.threads.create({
      threadId: THREAD_ID,
      workspaceId: WORKSPACE_ID,
      engine: "codex",
      title: "中断测试 A",
      sessionId: "engine-session-restart" as any,
    });
    const successorSessionId = "engine-session-live-successor" as any;
    (harness.ctx.sessions as any).interrupt = async () => {
      harness.db.threads.setSessionId(THREAD_ID, successorSessionId);
      harness.ctx.threads.create({
        threadId: THREAD_ID,
        workspaceId: WORKSPACE_ID,
        engine: "codex",
        title: "中断测试 B",
        sessionId: successorSessionId,
      });
      throw Object.assign(new Error("old live generation invalidated"), { code: "session_invalidated" });
    };
    (harness.ctx.sessions as any).interruptCodexTurnByEngineIds = async (input: any) => {
      fallbackCalls += 1;
      assert.equal(input.engineSessionId, "engine-session-restart");
      assert.equal(input.engineTurnId, "engine-turn-restart");
      assert.equal(input.exactProviderTurn, true);
      return {
        kind: "ready",
        actualEngineTurnId: "engine-turn-restart",
        allowSiblingRunning: true,
      };
    };
    (harness.ctx.sessions as any).detachCodexProviderGeneration = () => {
      cleanupCalls += 1;
    };
    (harness.ctx.sessions as any).disposeThreadWithOptions = async () => {
      cleanupCalls += 1;
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-live-invalidated-successor",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    const response = harness.sent.find(
      (message) => message.t === "api.res" && message.id === "req-interrupt-live-invalidated-successor",
    ) as any;
    const events = harness.db.conversationEvents.listByThread(THREAD_ID);
    assert.equal(response?.status, 200);
    assert.equal(cleanupCalls, 0);
    assert.equal(fallbackCalls, 1);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "error");
    assert.equal(harness.db.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    assert.equal(harness.ctx.threads.get(THREAD_ID)?.sessionId, successorSessionId);
    assert.equal(events.some((event) => (event.payload as any)?.action === "session.invalidated"), false);
    assert.equal(events.some((event) => event.type === "turn.error"), true);
  } finally {
    harness.cleanup();
  }
});

test("turns.interrupt still stops runtime active turn when DB turn is already terminal", async () => {
  const harness = setupInterruptHarness();
  let clearedTurnId: string | null = null;
  try {
    harness.db.turns.setEnded(TURN_ID, { status: "completed", endedAt: Date.now(), endEventSeq: 2 });
    harness.ctx.getActiveThreadTurn = () => ({ turnId: TURN_ID, startedAt: Date.now() - 1_000, source: "runtime" });
    harness.ctx.clearActiveThreadTurn = ({ turnId }) => {
      clearedTurnId = String(turnId);
    };

    await handleApiRequest(harness.ctx, {
      t: "api.req",
      id: "req-interrupt-terminal-db",
      method: "turns.interrupt",
      path: "/turns/interrupt",
      body: { workspaceId: WORKSPACE_ID, threadId: THREAD_ID, turnId: TURN_ID },
    } as ApiRequestMessage);

    assert.equal(harness.interruptFinished, true);
    assert.equal(clearedTurnId, TURN_ID);
    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-interrupt-terminal-db") as any;
    assert.equal(response?.status, 200);
    assert.equal(harness.db.turns.get(TURN_ID)?.status, "completed");
  } finally {
    harness.cleanup();
  }
});
