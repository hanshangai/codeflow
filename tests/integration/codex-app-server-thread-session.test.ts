import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { logger } from "../../apps/desktop/client/src/logger.js";
import { ThreadEventFlushError } from "../../apps/desktop/client/src/engines/threadSession.js";
import { testEngineWorkspaceLog } from "../../apps/desktop/client/tests/engine-workspace-log-fixture.js";

import {
  MANUAL_TURN_INTERRUPT_CODE,
  type ExecutableToolRegistry,
} from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { ToolRuntimeService } from "../../apps/desktop/client/src/orchestration/toolRuntimeService.ts";
import { findCodexTurnIdFromHistory } from "../../apps/desktop/client/src/app/utils/codexTurnHistory.ts";
import {
  buildCodexDeveloperInstructions,
  buildCodexTurnStartTraceParams,
  CodexAppServerThreadSession,
  resumeCodexProviderThreadForRead,
} from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerThreadSession.ts";
import { buildCodexSkillId } from "../../apps/desktop/client/src/engines/codex-app-server/codexInputActions.ts";
import {
  CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  CodexAppServerWorkspace,
  isFatalCodexAppServerStderrLine,
} from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerWorkspace.ts";
import { EngineTimeoutError } from "../../apps/desktop/client/src/engines/turnTimeoutController.ts";
import { applyEngineModelCatalogSnapshot } from "../../apps/desktop/client/src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "../../packages/shared/src/engineModelCatalogSeed.ts";
import {
  buildCodexDynamicToolBindingVersion,
  buildCodexDynamicToolNameByToolId,
  buildTurnStartParams,
  resolveApprovalPolicy,
  supportsCodexNativeDynamicToolTransport,
} from "../../apps/desktop/client/src/engines/codex-app-server/codexAppServerProtocol.ts";

/** 传输层断言保留角色规则顺序，同时纳入当前平台的固定执行约束。 */
function withCodexExecutionInstructions(...blocks: Array<string | null>): string | null {
  return [...blocks, buildCodexDeveloperInstructions({
    accessMode: "current", providerNativeToolPolicy: "allow", responseFormat: "text",
  })].filter(Boolean).join("\n\n") || null;
}

test("Codex Windows 执行约束覆盖引号、编码、路径、退出码和测试排障，受原生工具权限控制", () => {
  const options = { accessMode: "current", providerNativeToolPolicy: "allow", responseFormat: "text" } as const;
  const prompt = buildCodexDeveloperInstructions({ ...options, platform: "win32" });
  assert.ok(prompt);
  for (const rule of [
    "PowerShell 5.1", "node -e/python -c", "$OutputEncoding", "UTF8Encoding", "rg --files", "-g", "子包目录",
    "项目根 AGENTS.md", "Bash 花括号", "rg --files apps/web/tests -g 'chat-composer*'",
    "Select-Object -First", "真实退出码", "1 表示无匹配、2 表示执行错误", "$LASTEXITCODE",
    "独立查询分开调用", "不得统一将退出码 1 改为成功", "测试端口被占用先核对所属进程",
    "$ErrorActionPreference = 'Stop'", "不能替代原生程序的退出码检查", "停止依赖它的后续操作",
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.doesNotMatch(buildCodexDeveloperInstructions({ ...options, platform: "linux" }) ?? "", /Windows 命令执行约束/u);
  assert.doesNotMatch(buildCodexDeveloperInstructions({ ...options, platform: "darwin" }) ?? "", /Windows 命令执行约束/u);
  for (const providerNativeToolPolicy of ["deny", "interactive-only"] as const) {
    const restricted = buildCodexDeveloperInstructions({ ...options, platform: "win32", providerNativeToolPolicy });
    assert.ok(restricted);
    assert.doesNotMatch(restricted, /Windows 命令执行约束/u);
  }
  const readOnly = buildCodexDeveloperInstructions({ ...options, platform: "win32", accessMode: "read-only" });
  assert.ok(readOnly);
  assert.match(readOnly, /当前为只读模式/u);
  assert.match(readOnly, /Windows 命令执行约束/u);
});

test("Codex 允许交互时引导使用结构化提问，deny 回合不注入调用指引", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const providerNativeToolPolicy of ["allow", "interactive-only", "deny"] as const) {
      const prompt = buildCodexDeveloperInstructions({
        accessMode: "current", providerNativeToolPolicy, responseFormat: "text", platform,
      }) ?? "";
      if (providerNativeToolPolicy === "deny") {
        assert.doesNotMatch(prompt, /优先调用 request_user_input/u);
      } else {
        assert.match(prompt, /优先调用 request_user_input/u);
        assert.match(prompt, /已有上下文/u);
        assert.match(prompt, /收到回答后继续/u);
      }
    }
  }
});

test.before(() => {
  const rows = INITIAL_ENGINE_MODEL_CATALOG_V1.map((row) => structuredClone(row));
  const codexRows = rows.filter((row) => row.engine === "codex");
  const compatibilityTemplate = codexRows.find((row) => row.modelId === "gpt-5.6-luna") ?? codexRows[0];
  assert.ok(compatibilityTemplate);
  rows.push({
    ...compatibilityTemplate,
    catalogItemId: "test:codex:gpt-5.4",
    modelId: "gpt-5.4",
    displayName: "GPT-5.4（测试兼容项）",
    isDefault: false,
    sortOrder: codexRows.length + 1,
  });
  applyEngineModelCatalogSnapshot({
    schemaVersion: "engine-model-catalog/v1",
    configVersion: 1,
    capturedAt: 1,
    rows,
  });
});

/** 为旧测试夹具补齐 full turn 列表的正式响应结构。 */
async function normalizeProviderFixture(method: string, params: unknown, response: Promise<unknown>): Promise<unknown> {
  const result = await response;
  if (method !== "thread/turns/list" || (params as any)?.itemsView !== "full") return result;
  const data = Array.isArray((result as any)?.data) ? (result as any).data as any[] : null;
  if (!data) {
    if (
      result
      && typeof result === "object"
      && !Object.prototype.hasOwnProperty.call(result, "data")
    ) {
      return { ...(result as Record<string, unknown>), data: [], nextCursor: null };
    }
    return result;
  }
  return {
    ...(result as Record<string, unknown>),
    data: data.map((turn) => (
      turn && typeof turn === "object" && !Object.prototype.hasOwnProperty.call(turn, "itemsView")
        ? { ...turn, itemsView: "full" }
        : turn
    )),
  };
}

function createExplicitTurnStartRejection(message: string, requestId: string): Error {
  return Object.assign(new Error(message), {
    rpcError: true,
    method: "turn/start",
    requestId,
  });
}

test("Codex Skill turn/start trace 使用独立脱敏副本，不改写 Provider 参数", () => {
  const realPath = "Z:\\Users\\tester\\.codex\\skills\\review\\SKILL.md";
  const params = {
    threadId: "provider-thread",
    input: [
      { type: "text", text: "use $review" },
      { type: "skill", name: "review", path: realPath },
    ],
  };
  const prepared = {
    kind: "codex-skills" as const,
    reservationId: "reservation-1",
    turnId: "turn-1" as any,
    userItemId: "item-1" as any,
    processGeneration: 2,
    skills: [{ skillId: `csk_${"a".repeat(43)}`, name: "review", path: realPath }],
  };

  const trace = buildCodexTurnStartTraceParams(params, prepared);
  assert.notStrictEqual(trace, params);
  assert.notStrictEqual(trace.input, params.input);
  assert.equal((params.input[1] as any).path, realPath);
  assert.equal((trace.input as any[])[1]?.path, `[Codex Skill ${prepared.skills[0]!.skillId}]`);
  (trace.input as any[])[1].path = "changed-in-trace";
  assert.equal((params.input[1] as any).path, realPath);
});

/** 构造已绑定回合，显式提供日志依赖并记录中断的 provider 请求与结果。 */
function createSessionHarness(
  threadReadResult: unknown,
  opts?: {
    request?: (
      method: string,
      params: unknown,
      requestOpts?: { timeoutMs?: number; trackLateSettlement?: boolean },
    ) => Promise<unknown>;
    reconnectRecoveryGraceMs?: number;
    reconnectRecoveryPollMs?: number;
    reconnectRecoveryMaxAttempts?: number;
  },
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<{ id: unknown; result: unknown }> = [];
  const rawEvents: any[] = [];
  const workspace = {
    request(
      method: string,
      params: unknown,
      requestOpts?: { timeoutMs?: number; trackLateSettlement?: boolean },
    ) {
      requests.push({ method, params });
      if (opts?.request) {
        return normalizeProviderFixture(method, params, opts.request(method, params, requestOpts));
      }
      if (method === "thread/read") return Promise.resolve(threadReadResult);
      if (method === "turn/interrupt") return Promise.resolve({});
      assert.fail(`createSessionHarness 未声明 RPC：${method}`);
    },
    ensureStarted() {
      return Promise.resolve();
    },
    registerThread() {
      return () => {};
    },
    respond(id: unknown, result: unknown) {
      responses.push({ id, result });
      return Promise.resolve();
    },
    notify() {
      return Promise.resolve();
    },
  };

  let resolved: unknown = null;
  let rejected: Error | null = null;

  const session = new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: { getOrCreate() { return workspace as any; } } as any,
    workspacePath: "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: "session-demo" as any,
    initialSessionCapabilities: null,
    onEngineProcessSnapshot() { return false; },
    onSessionBinding() {},
    onSessionBindingDropped() {},
    onStartAttempt() {},
    supportsNativeDynamicTools() { return true; },
    reconnectRecoveryGraceMs: opts?.reconnectRecoveryGraceMs,
    reconnectRecoveryPollMs: opts?.reconnectRecoveryPollMs,
    reconnectRecoveryMaxAttempts: opts?.reconnectRecoveryMaxAttempts,
  }) as any;

  session.emitters = {
    conversation() {},
    raw(event: unknown) {
      rawEvents.push(event);
    },
  };
  session.active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      resumeAfterTimeout() { return false; },
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    manualInterruptRequested: false,
    manualInterruptError: null,
    providerTerminalStatus: null,
    lastNonRetryableTurnError: null,
    resolve(value: unknown) {
      resolved = value;
    },
    reject(error: Error) {
      rejected = error;
    },
  };

  return {
    session,
    workspace,
    requests,
    responses,
    rawEvents,
    getResolved: () => resolved,
    getRejected: () => rejected,
  };
}

test("Codex已有保存失败仍先停止活动provider，反馈证明后返回原保存错误", async () => {
  const h = createSessionHarness({}), failure = new ThreadEventFlushError([new Error("SAVE_FAILED")]);
  h.session.credentialCallPending = { turnId: "turn-client", phase: "failed", failure };
  let confirmed = 0;
  await assert.rejects(h.session.interrupt("turn-client", { onStopConfirmed() { confirmed++; } }), error => error === failure);
  assert.equal(confirmed, 1);
  assert.equal(h.requests.filter(request => request.method === "turn/interrupt").length, 1);
  assert.equal(h.session.getTurnFailure("turn-client"), "TURN_EVENT_FLUSH_FAILED");
});

test("Codex保存失败且缺少活动owner时不得仅凭owner消失伪造停止证明", async () => {
  const h = createSessionHarness({}), failure = new ThreadEventFlushError([new Error("SAVE_FAILED")]);
  h.session.active = null;
  h.session.credentialCallPending = { turnId: "turn-client", phase: "failed", failure };
  let confirmed = 0;
  await assert.rejects(h.session.interrupt("turn-client", { onStopConfirmed() { confirmed++; } }), error => error === failure);
  assert.equal(confirmed, 0);
});

/** 提取 timeout reconcile 诊断载荷，忽略同回合其他 raw 事件。 */
function listTimeoutReconcileData(rawEvents: any[]): any[] {
  return rawEvents.filter((event) => event?.source === "codex.timeout.reconcile").map((event) => event.data);
}

test("CodexAppServerThreadSession binding reset 注销失败会保留句柄并显式失败", () => {
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } });
  const expectedError = new Error("observer unregister failed");
  harness.session.unregister = () => {
    throw expectedError;
  };

  assert.throws(
    () => harness.session.resetThreadBinding(),
    (error) => error === expectedError,
  );
  assert.equal(typeof harness.session.unregister, "function");
  assert.equal(harness.session.sessionId, "session-demo");
});

test("CodexAppServerThreadSession 进程终止失效会停止旧 session 后台任务并保留 binding", async () => {
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } });
  let activeTimeoutStops = 0;
  let ownershipTimerCalls = 0;
  let lateSettlementReleases = 0;
  let detachedObserverUnregisters = 0;
  let terminalEvents = 0;
  harness.session.active.timeoutController.stop = () => { activeTimeoutStops += 1; };
  harness.session.emitters.conversation = () => { terminalEvents += 1; };

  const currentStartingTurn = {
    ownershipRecoveryTimer: setTimeout(() => { ownershipTimerCalls += 1; }, 10),
    ownershipRecoveryExpiryTimer: setTimeout(() => { ownershipTimerCalls += 1; }, 10),
    releaseLateSettlement: () => { lateSettlementReleases += 1; },
    lateSettlementReleased: false,
    signalPreflightInterrupt() {},
    acknowledgeStartupInterrupt() {},
    resolveInterruptFinalized() {},
    settle() {},
  } as any;
  const detachedStartingTurn = {
    clientTurnId: "turn-detached-invalidated",
    ownershipRecoveryTimer: setTimeout(() => { ownershipTimerCalls += 1; }, 10),
    ownershipRecoveryExpiryTimer: setTimeout(() => { ownershipTimerCalls += 1; }, 10),
    releaseLateSettlement: null,
    lateSettlementReleased: false,
    resolveInterruptFinalized() {},
  } as any;
  harness.session.startingTurn = currentStartingTurn;
  harness.session.active.providerOwnershipStartingTurn = currentStartingTurn;
  harness.session.pendingInterruptedStartingTurns.set(detachedStartingTurn.clientTurnId, detachedStartingTurn);
  harness.session.detachedProviderThreadUnregisterById.set(
    "session-detached-invalidated",
    () => { detachedObserverUnregisters += 1; },
  );

  harness.session.invalidateAfterProcessTermination();
  harness.session.onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(activeTimeoutStops, 1);
  assert.equal(ownershipTimerCalls, 0);
  assert.equal(lateSettlementReleases, 1);
  assert.equal(detachedObserverUnregisters, 1);
  assert.equal(terminalEvents, 0);
  assert.equal((harness.getRejected() as any)?.terminationKind, "manual_interrupt");
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.sessionId, "session-demo");
  assert.equal(harness.session.pendingInterruptedStartingTurns.size, 0);
  assert.equal(harness.session.detachedProviderThreadUnregisterById.size, 0);
});

test("CodexAppServerThreadSession 确认进程终止后唤醒真实 send，保留 binding 且拒绝复用旧 session", async () => {
  const harness = createSendHarness("session-demo");
  const input = {
    turnId: "turn-killed" as any, userItemId: "user-killed" as any,
    text: "work", images: [], assistantItemId: "assistant-killed", reasoningItemId: "reasoning-killed",
  };
  const send = harness.session.sendMessage(input, { conversation() {}, raw() {} });
  const rejected = assert.rejects(send, (error: any) => error.terminationKind === "manual_interrupt" && !error.preserveRunningState);
  await waitForActiveTurn(harness.session);
  harness.session.invalidateAfterProcessTermination();
  await rejected;
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.getSessionId(), "session-demo");
  const requestCount = harness.requests.length;
  await assert.rejects(harness.session.sendMessage(input, { conversation() {}, raw() {} }), /interrupted/);
  assert.equal(harness.requests.length, requestCount);

  const successor = createSendHarness(harness.session.getSessionId());
  const nextSend = successor.session.sendMessage({ ...input, turnId: "turn-after-kill" as any }, { conversation() {}, raw() {} });
  await waitForActiveTurn(successor.session);
  successor.threadHandlers.at(-1)!.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  await nextSend;
  assert.equal(successor.session.hasActiveTurn(), false);
  assert.deepEqual(successor.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
});

test("CodexAppServerThreadSession 实际 unexpected close 立即拒绝普通 active 并释放 timeout，下一轮恢复原 binding", async (t) => {
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaceId: "client-a:ws-demo" as any,
    workspacePath: "Z:/code/codeflowai",
    clientInfo: { name: "test", title: "Test", version: "0.0.0" },
  });
  const child = { pid: 42_424 };
  (workspace as any).child = child;
  (workspace as any).processGeneration = 7;
  const harness = createSendHarness("session-demo", { workspace });
  t.mock.method(workspace, "request", harness.workspace.request);
  const input = {
    turnId: "turn-unexpected-close" as any, userItemId: "user-unexpected-close" as any,
    text: "work", images: [], assistantItemId: "assistant-close", reasoningItemId: "reasoning-close",
  };
  const send = harness.session.sendMessage(input, { conversation() {}, raw() {} });
  let settled = false;
  const outcome = send.then(
    value => { settled = true; return { value, error: null }; },
    error => { settled = true; return { value: null, error }; },
  );
  await waitForActiveTurn(harness.session);
  const active = (harness.session as any).active;
  const stop = t.mock.method(active.timeoutController, "stop");
  try {
    (workspace as any).handleChildClose(child, 7, 1, null);
    await flushMicrotasksUntil(() => settled, "实际 unexpected close 必须立即结算 sendMessage");
    const result = await outcome;
    assert.equal(result.error?.code, "codex_app_server_closed");
    assert.equal(result.error?.terminationKind, "error");
    assert.equal(result.error?.preserveRunningState, undefined);
    assert.deepEqual(result.error?.processExit, { exitCode: 1, signal: null, processGeneration: 7, pid: 42_424 });
    assert.equal(harness.session.hasActiveTurn(), false);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(active.providerTerminalStatus, null, "进程退出不能伪造 provider turn 终态");
    assert.equal(harness.session.getSessionId(), "session-demo");
    assert.deepEqual(harness.requests.map(request => request.method), ["thread/resume", "turn/start"]);
    assert.equal((harness.session as any).resumed, false);

    (workspace as any).child = { pid: 42_425 };
    (workspace as any).processGeneration = 8;
    const next = harness.session.sendMessage({ ...input, turnId: "turn-after-close" as any }, { conversation() {}, raw() {} });
    await waitForActiveTurn(harness.session);
    (workspace as any).onStdoutLine(JSON.stringify({
      method: "turn/completed", params: { threadId: "session-demo", turn: { id: "turn-engine-2", status: "completed" } },
    }));
    await next;
    assert.deepEqual(harness.requests.map(request => request.method), ["thread/resume", "turn/start", "thread/resume", "turn/start"]);
  } finally {
    (harness.session as any).active?.resolve({});
    await outcome;
  }
});

test("CodexAppServerThreadSession 已处理 completed 后 actual close 不覆盖成功", async (t) => {
  const workspace = new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaceId: "client-a:ws-demo" as any, workspacePath: "Z:/code/codeflowai",
    clientInfo: { name: "test", title: "Test", version: "0.0.0" },
  });
  const child = { pid: 42_426 };
  (workspace as any).child = child;
  (workspace as any).processGeneration = 1;
  const harness = createSendHarness("session-demo", { workspace });
  t.mock.method(workspace, "request", harness.workspace.request);
  const events: any[] = [];
  const send = harness.session.sendMessage({
    turnId: "turn-completed-before-close" as any, userItemId: "user-before-close" as any,
    text: "work", images: [], assistantItemId: "assistant-before-close", reasoningItemId: "reasoning-before-close",
  }, { conversation(event) { events.push(event); }, raw() {} });
  await waitForActiveTurn(harness.session);
  (workspace as any).onStdoutLine(JSON.stringify({
    method: "turn/completed", params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  }));
  (workspace as any).handleChildClose(child, 1, 1, null);
  await send;
  assert.equal(harness.session.getObservedTurnTerminalStatus("turn-completed-before-close" as any), "completed");
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(events.some(event => event.type === "turn.error"), false);
  assert.deepEqual(harness.requests.map(request => request.method), ["thread/resume", "turn/start"]);
});

test("CodexAppServerThreadSession 普通 active 不按 closed code 或 message 猜测实际退出", () => {
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } });
  harness.session.onAppServerMessage({ method: "error", params: { error: {
    code: "codex_app_server_closed", message: "Codex app-server closed (code=1)", processGeneration: 1,
  } } });
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.deepEqual(harness.requests, []);
});

test("CodexAppServerThreadSession 独占进程退出只拒绝所属 thread，其他进程的 turn 继续完成", async (t) => {
  const workspaces = ["closed", "healthy"].map(id => new CodexAppServerWorkspace({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaceId: "client-a:ws-demo" as any, workspacePath: "Z:/code/codeflowai",
    clientInfo: { name: id, title: "Test", version: "0.0.0" },
  }));
  const harnesses = workspaces.map((workspace, index) => {
    (workspace as any).child = { pid: 43_000 + index };
    (workspace as any).processGeneration = 1;
    const harness = createSendHarness("session-demo", { workspace });
    t.mock.method(workspace, "request", harness.workspace.request);
    return harness;
  });
  const sends = harnesses.map((harness, index) => harness.session.sendMessage({
    turnId: `turn-isolation-${index}` as any, userItemId: `user-isolation-${index}` as any,
    text: "work", images: [], assistantItemId: `assistant-isolation-${index}`, reasoningItemId: `reasoning-isolation-${index}`,
  }, { conversation() {}, raw() {} }));
  const closed = assert.rejects(sends[0]!, (error: any) => error.code === "codex_app_server_closed");
  await Promise.all(harnesses.map(harness => waitForActiveTurn(harness.session)));
  try {
    (workspaces[0] as any).handleChildClose((workspaces[0] as any).child, 1, 1, null);
    await flushMicrotasksUntil(() => !harnesses[0]!.session.hasActiveTurn(), "所属 thread 必须立即释放 active");
    await closed;
    assert.equal(harnesses[1]!.session.hasActiveTurn(), true);
    assert.equal(workspaces[1]!.isRunning(), true);
    (workspaces[1] as any).onStdoutLine(JSON.stringify({
      method: "turn/completed", params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
    }));
    await sends[1];
    assert.equal(harnesses[1]!.session.hasActiveTurn(), false);
    assert.equal(harnesses[1]!.session.getObservedTurnTerminalStatus("turn-isolation-1" as any), "completed");
  } finally {
    for (const harness of harnesses) (harness.session as any).active?.resolve({});
    await Promise.all([closed, sends[1]]);
  }
});

test("CodexAppServerThreadSession thread/start 在途终止后，迟到的 provider binding 不覆盖后继会话", async () => {
  let resolveStart!: (value: unknown) => void;
  const start = new Promise<unknown>((resolve) => { resolveStart = resolve; });
  let bindingWrites = 0;
  const harness = createSendHarness(null, {
    onSessionBinding() { bindingWrites += 1; },
    async request(method) { assert.equal(method, "thread/start"); return await start; },
  });
  const send = harness.session.sendMessage({
    turnId: "turn-preflight-killed" as any, userItemId: "user-preflight-killed" as any,
    text: "work", images: [], assistantItemId: "assistant-preflight-killed", reasoningItemId: "reasoning-preflight-killed",
  }, { conversation() {}, raw() {} });
  const rejected = assert.rejects(send, (error: any) => error.terminationKind === "manual_interrupt");
  while (!harness.requests.some((request) => request.method === "thread/start")) await new Promise((resolve) => setImmediate(resolve));
  harness.session.invalidateAfterProcessTermination();
  await rejected;
  resolveStart({ thread: { id: "obsolete-provider-thread" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bindingWrites, 0);
  assert.equal(harness.session.getSessionId(), null);
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 启动请求在途终止后，不被迟到 ACK 重新确权或遗留运行态", async () => {
  let resolveStart!: (value: unknown) => void;
  const start = new Promise<unknown>((resolve) => { resolveStart = resolve; });
  let startAttemptWrites = 0;
  const harness = createSendHarness("session-demo", {
    onStartAttempt() { startAttemptWrites += 1; },
    async request(method) {
      if (method === "turn/start") return await start;
      return {};
    },
  });
  const send = harness.session.sendMessage({
    turnId: "turn-starting-killed" as any, userItemId: "user-starting-killed" as any,
    text: "work", images: [], assistantItemId: "assistant-starting-killed", reasoningItemId: "reasoning-starting-killed",
  }, { conversation() {}, raw() {} });
  const rejected = assert.rejects(send, (error: any) => error.terminationKind === "manual_interrupt" && !error.preserveRunningState);
  while (!harness.requests.some((request) => request.method === "turn/start")) await new Promise((resolve) => setImmediate(resolve));
  harness.session.invalidateAfterProcessTermination();
  await rejected;
  resolveStart({ turn: { id: "turn-late-killed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(startAttemptWrites, 0);
  assert.equal(harness.session.getSessionId(), "session-demo");
});

for (const evidence of ["notification", "read"]) {
test(`CodexAppServerThreadSession 终止前已确权 completed，不将完成结果改为中断（${evidence}）`, async () => {
  const harness = createSendHarness("session-demo");
  const turnId = "turn-completed-before-kill" as any;
  const send = harness.session.sendMessage({
    turnId, userItemId: "user-completed-before-kill" as any,
    text: "work", images: [], assistantItemId: "assistant-completed-before-kill", reasoningItemId: "reasoning-completed-before-kill",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  if (evidence === "notification") {
    harness.threadHandlers.at(-1)!.onMessage({
      method: "turn/completed",
      params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
    });
  } else {
    (harness.session as any).settleActiveFromProviderTerminal((harness.session as any).active, "completed", "read", null);
  }
  harness.session.invalidateAfterProcessTermination();
  await send;
  assert.equal(harness.session.getObservedTurnTerminalStatus(turnId), "completed");
  assert.equal(harness.session.getObservedTurnTerminalStatus("unowned-local-turn" as any), null);
  assert.equal(harness.session.hasActiveTurn(), false);
  const requestCount = harness.requests.length;
  await harness.session.prepareAssistantTerminalEvents({ turnId, outcome: "completed" });
  assert.equal(harness.requests.length, requestCount, "旧进程已终止，终态补齐不得重新启动 provider");
});
}

test("CodexAppServerThreadSession compact 请求在途终止后，显式中断且不再恢复旧进程", async () => {
  let rejectCompact!: (cause: Error) => void;
  const compact = new Promise<unknown>((_resolve, reject) => { rejectCompact = reject; });
  const harness = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/compact/start") return await compact;
      return {};
    },
  });
  const send = harness.session.compactThread({ turnId: "compact-killed" as any }, { conversation() {}, raw() {} });
  const rejected = assert.rejects(send, (error: any) => error.terminationKind === "manual_interrupt" && !error.preserveRunningState);
  while (!harness.requests.some((request) => request.method === "thread/compact/start")) await new Promise((resolve) => setImmediate(resolve));
  harness.session.invalidateAfterProcessTermination();
  rejectCompact(Object.assign(new Error("process stopped"), { code: "codex_app_server_closed" }));
  await rejected;
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume", "thread/read", "thread/compact/start"]);
});

test("CodexAppServerThreadSession 失效后忽略 handoff read 的迟到终态", async () => {
  let resolveRead!: (value: unknown) => void;
  const read = new Promise<unknown>((resolve) => { resolveRead = resolve; });
  let readCalls = 0;
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } }, {
    request(method) {
      assert.equal(method, "thread/read");
      readCalls += 1;
      return read;
    },
  });
  let ownershipSignals = 0;
  const startingTurn = {
    clientTurnId: "turn-client",
    terminalEvidenceVersion: 1,
    interruptRequested: false,
    providerLifecycleTurnId: null,
    signalProviderOwnership() { ownershipSignals += 1; },
  } as any;

  const reconcile = harness.session.reconcileStartingTurnHandoffTerminalState(harness.workspace, {
    startingTurn,
    sessionId: "session-demo",
    responseProviderTurnId: "turn-engine",
    reason: "test-invalidated-handoff",
  });
  while (readCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  harness.session.invalidateAfterProcessTermination();
  resolveRead({
    thread: {
      id: "session-demo",
      turns: [{ id: "turn-engine", status: "completed" }],
    },
  });
  await reconcile;

  assert.equal(readCalls, 1);
  assert.equal(ownershipSignals, 0);
  assert.equal(startingTurn.providerLifecycleTurnId, null);
  assert.equal(startingTurn.handoffTerminalSettled, undefined);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.session.sessionId, "session-demo");
});

test("CodexAppServerThreadSession 失效后不重试失败的 handoff read", async () => {
  let rejectRead!: (cause: Error) => void;
  const read = new Promise<unknown>((_resolve, reject) => { rejectRead = reject; });
  let readCalls = 0;
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } }, {
    request(method) {
      assert.equal(method, "thread/read");
      readCalls += 1;
      return read;
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client",
    terminalEvidenceVersion: 1,
    interruptRequested: false,
  } as any;

  const reconcile = harness.session.reconcileStartingTurnHandoffTerminalState(harness.workspace, {
    startingTurn,
    sessionId: "session-demo",
    responseProviderTurnId: "turn-engine",
    reason: "test-invalidated-handoff-failure",
  });
  while (readCalls === 0) await new Promise((resolve) => setImmediate(resolve));
  harness.session.invalidateAfterProcessTermination();
  rejectRead(new Error("old workspace exited"));
  await reconcile;
  await new Promise((resolve) => setTimeout(resolve, 350));

  assert.equal(readCalls, 1);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.session.sessionId, "session-demo");
});

test("CodexAppServerThreadSession detached 关联异常会重新调度 ownership 恢复", () => {
  const harness = createSessionHarness({ thread: { id: "session-demo", turns: [] } });
  const startingTurn = {
    clientTurnId: "turn-detached-retry",
    clientUserMessageId: "client-user-detached-retry",
    providerThreadId: "session-detached-retry",
    providerLifecycleTurnId: "provider-old",
    providerObservedTurnId: null,
  } as any;
  let restartCount = 0;
  harness.session.pendingInterruptedStartingTurns = new Map([[startingTurn.clientTurnId, startingTurn]]);
  harness.session.bindRetiredProviderTurnCorrelation = () => {
    throw new Error("binding persistence failed");
  };
  harness.session.restartStartingTurnOwnershipRecoveryAfterNewEvidence = (candidate: unknown) => {
    assert.equal(candidate, startingTurn);
    restartCount += 1;
  };

  harness.session.onDetachedProviderThreadMessage("session-detached-retry", {
    method: "item/started",
    params: {
      threadId: "session-detached-retry",
      turnId: "provider-new",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId },
    },
  });

  assert.equal(restartCount, 1);
});

test("CodexAppServerThreadSession idle timeout keeps the same turn running after authoritative active state", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "active" },
      turns: [{ id: "turn-engine", status: "in_progress", items: [] }],
    },
  });
  let resumedReason = "";
  harness.session.active.timeoutController.resumeAfterTimeout = (reason: string) => {
    resumedReason = reason;
    return true;
  };

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("idle", {
      code: "engine_idle_timeout",
      idleMs: 600_000,
      phase: "engine",
      timeoutSequence: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lifecycle = listTimeoutReconcileData(harness.rawEvents);
  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 1);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(resumedReason, "provider_turn_in_progress");
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
  assert.deepEqual(lifecycle.map((event) => event.phase), ["started", "resolved"]);
  assert.equal(lifecycle[0]?.decision, "pending");
  assert.equal(lifecycle[0]?.timeoutSequence, 1);
  assert.equal(lifecycle[0]?.requestMethod, "thread/read");
  assert.equal(lifecycle[0]?.requestTimeoutMs, CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS);
  assert.equal(lifecycle[1]?.decision, "monitoring_resumed");
  assert.equal(lifecycle[1]?.providerThreadStatus, "active");
  assert.equal(lifecycle[1]?.providerTurnStatus, "in_progress");
  assert.equal(lifecycle[1]?.providerTurnFound, true);
  assert.equal(lifecycle[1]?.activeTurnMatched, true);
});

test("CodexAppServerThreadSession idle timeout resolves from authoritative completed state", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [{ id: "turn-engine", status: "completed", items: [] }],
    },
  });

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("idle", {
      code: "engine_idle_timeout",
      idleMs: 600_000,
      phase: "engine",
      timeoutSequence: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(listTimeoutReconcileData(harness.rawEvents)[1]?.decision, "completed");
});

test("CodexAppServerThreadSession idle timeout records authoritative terminal failure", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [{ id: "turn-engine", status: "failed", items: [] }],
    },
  });

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("idle", {
      code: "engine_idle_timeout",
      idleMs: 600_000,
      phase: "engine",
      timeoutSequence: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const resolved = listTimeoutReconcileData(harness.rawEvents)[1];
  assert.equal(resolved?.decision, "terminal_failed");
  assert.equal(resolved?.providerThreadStatus, "idle");
  assert.equal(resolved?.providerTurnStatus, "failed");
  assert.match(harness.getRejected()?.message ?? "", /failed/);
});

test("CodexAppServerThreadSession idle timeout 缺少权威 provider turn 时保留 active", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [],
    },
  });
  const timeoutError = new EngineTimeoutError("idle", {
    code: "engine_idle_timeout",
    idleMs: 600_000,
    phase: "engine",
    timeoutSequence: 1,
  });

  (harness.session as any).handleCodexTurnTimeout(harness.workspace, "turn-client", timeoutError);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const resolved = listTimeoutReconcileData(harness.rawEvents)[1];
  assert.equal(resolved?.decision, "unresolved");
  assert.equal(resolved?.providerThreadStatus, "idle");
  assert.equal(resolved?.providerTurnStatus, null);
  assert.equal(resolved?.providerTurnFound, false);
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal((harness.session as any).active.pendingEngineIdleTimeoutError, timeoutError);
});

test("CodexAppServerThreadSession idle timeout closes stale reconcile lifecycle without settling a replacement turn", async () => {
  let resolveRead!: (value: unknown) => void;
  const readResult = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "thread/read") return readResult;
      return {};
    },
  });

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("idle", {
      code: "engine_idle_timeout",
      idleMs: 600_000,
      phase: "engine",
      timeoutSequence: 1,
    }),
  );
  harness.session.active = null;
  resolveRead({
    thread: {
      id: "session-demo",
      status: { type: "active" },
      turns: [{ id: "turn-engine", status: "in_progress", items: [] }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lifecycle = listTimeoutReconcileData(harness.rawEvents);
  assert.deepEqual(lifecycle.map((event) => event.phase), ["started", "resolved"]);
  assert.equal(lifecycle[1]?.decision, "stale_ignored");
  assert.equal(lifecycle[1]?.activeTurnMatched, false);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession idle timeout 的 thread/read 失败不会提前释放 active", async () => {
  const requestError = Object.assign(new Error("app-server unavailable"), {
    code: "codex_app_server_request_timeout",
    method: "thread/read",
    requestId: 17,
    processGeneration: 3,
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "thread/read") throw requestError;
      return {};
    },
  });

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("idle", {
      code: "engine_idle_timeout",
      idleMs: 600_000,
      phase: "engine",
      timeoutSequence: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lifecycle = listTimeoutReconcileData(harness.rawEvents);
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.deepEqual(lifecycle.map((event) => event.phase), ["started", "failed"]);
  assert.equal(lifecycle[1]?.decision, "request_failed");
  assert.equal(lifecycle[1]?.error?.name, "Error");
  assert.equal(lifecycle[1]?.error?.code, "codex_app_server_request_timeout");
  assert.equal(lifecycle[1]?.error?.message, "app-server unavailable");
  assert.equal(lifecycle[1]?.error?.method, "thread/read");
  assert.equal(lifecycle[1]?.error?.requestId, 17);
  assert.equal(lifecycle[1]?.error?.processGeneration, 3);
});

test("CodexAppServerThreadSession legacy timeout 的 interrupt 失败不会提前释放 active", async () => {
  let rejectInterrupt!: (error: Error) => void;
  const interruptResult = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/interrupt") return interruptResult;
      return {};
    },
  });

  (harness.session as any).handleCodexTurnTimeout(
    harness.workspace,
    "turn-client",
    new EngineTimeoutError("hard timeout", {
      code: "legacy_turn_timeout",
      idleMs: 600_000,
      phase: "legacy-turn",
      timeoutSequence: 1,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.getRejected(), null);

  rejectInterrupt(new Error("interrupt transport closed"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.getRejected(), null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal((harness.session as any).active.codexTurnId, "turn-engine");
});

test("CodexAppServerThreadSession compact 专用 item 确权后 legacy timeout 只中断精确 turn", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/compact/start") return {};
      if (method === "turn/interrupt") return {};
      assert.fail(`compact timeout 不得发送额外 RPC：${method}`);
    },
  });
  const timeoutError = new EngineTimeoutError("compact hard timeout", {
    code: "legacy_turn_timeout",
    idleMs: 60_000,
    phase: "legacy-turn",
    timeoutSequence: 1,
  });
  const pendingCompact = session.compactThread({
    turnId: "turn-client" as any,
    timeoutPolicy: { mode: "legacy-turn", timeoutMs: 60_000, startupTimeoutMs: 1_000 },
  }, {
    conversation() {},
    raw() {},
  });
  const compactRejected = assert.rejects(pendingCompact, (error) => error === timeoutError);

  await waitForActiveTurn(session);
  await flushMicrotasksUntil(
    () => (session as any).active?.compactStartState?.phase === "accepted",
    "compact/start 未进入 accepted",
  );
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    },
  });
  assert.equal((session as any).active.codexTurnId, "turn-compact");
  (session as any).handleCodexTurnTimeout((session as any).opts.manager.getOrCreate(), "turn-client", timeoutError);
  await flushMicrotasksUntil(
    () => requests.some((request) => request.method === "turn/interrupt"),
    "compact timeout 未发出精确中断",
  );
  assert.deepEqual(
    requests.find((request) => request.method === "turn/interrupt")?.params,
    { threadId: "session-demo", turnId: "turn-compact" },
  );
  await compactRejected;
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession compact 专用 item 确权后 activity timeout 只恢复监控", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/compact/start") return {};
      if (method === "thread/read") {
        readCount += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [{ id: "turn-compact", status: "inProgress", items: [] }],
          },
        };
      }
      return {};
    },
  });
  const pendingCompact = session.compactThread({
    turnId: "turn-client" as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 60_000 },
  }, {
    conversation() {},
    raw() {},
  });

  await waitForActiveTurn(session);
  await flushMicrotasksUntil(
    () => (session as any).active?.compactStartState?.phase === "accepted",
    "compact/start 未进入 accepted",
  );
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    },
  });
  let resumedReason = "";
  (session as any).active.timeoutController.resumeAfterTimeout = (reason: string) => {
    resumedReason = reason;
    return true;
  };
  const timeoutError = new EngineTimeoutError("compact idle timeout", {
    code: "engine_idle_timeout",
    idleMs: 60_000,
    phase: "engine",
    timeoutSequence: 1,
  });
  (session as any).handleCodexTurnTimeout((session as any).opts.manager.getOrCreate(), "turn-client", timeoutError);
  await flushMicrotasksUntil(
    () => readCount >= 1 && Boolean(resumedReason),
    "compact activity timeout 未完成权威读取并恢复监控",
  );

  assert.equal((session as any).active.codexTurnId, "turn-compact");
  assert.equal(resumedReason, "provider_turn_in_progress");
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), true);

  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-compact", status: "completed" } },
  });
  await pendingCompact;
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession compact/start 迟到 ACK 后只补偿专用证据确权的 turn", async () => {
  let releasedLateSettlement = 0;
  let resolveLateSettlement!: (value: unknown) => void;
  const lateSettlement = new Promise((resolve) => {
    resolveLateSettlement = resolve;
  });
  const compactStartError = Object.assign(new Error("Codex app-server request timeout: thread/compact/start"), {
    code: "codex_app_server_request_timeout",
    method: "thread/compact/start",
    requestOutcomeUnknown: true,
    lateSettlement,
    releaseLateSettlement() {
      releasedLateSettlement += 1;
    },
  });
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/compact/start") throw compactStartError;
      if (method === "turn/interrupt") return {};
      assert.fail(`compact 迟到 ACK 不得发送额外 RPC：${method}`);
    },
  });
  const pendingCompact = session.compactThread({
    turnId: "turn-client" as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 60_000 },
  }, {
    conversation() {},
    raw() {},
  });
  const compactRejected = assert.rejects(pendingCompact, (error) => error === compactStartError);

  await waitForActiveTurn(session);
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    },
  });
  assert.equal((session as any).active.codexTurnId, null);
  resolveLateSettlement({ status: "fulfilled", value: {} });
  while (!requests.some((request) => request.method === "turn/interrupt")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(
    requests.find((request) => request.method === "turn/interrupt")?.params,
    { threadId: "session-demo", turnId: "turn-compact" },
  );
  await compactRejected;
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(releasedLateSettlement, 1);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession compact/start 迟到明确拒绝时安全释放 active", async () => {
  let resolveLateSettlement!: (value: unknown) => void;
  let releasedLateSettlement = 0;
  const lateSettlement = new Promise((resolve) => {
    resolveLateSettlement = resolve;
  });
  const compactStartError = Object.assign(new Error("Codex app-server request timeout: thread/compact/start"), {
    code: "codex_app_server_request_timeout",
    method: "thread/compact/start",
    lateSettlement,
    releaseLateSettlement() {
      releasedLateSettlement += 1;
    },
  });
  const lateRpcError = new Error("compact rejected by provider");
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/compact/start") throw compactStartError;
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [],
          },
        };
      }
      return {};
    },
  });
  const pendingCompact = session.compactThread({
    turnId: "turn-client" as any,
    timeoutPolicy: { mode: "activity", startupTimeoutMs: 1_000, engineIdleTimeoutMs: 60_000 },
  }, {
    conversation() {},
    raw() {},
  });
  const compactRejected = assert.rejects(pendingCompact, (error) => error === lateRpcError);

  while (!requests.some((request) => request.method === "thread/read")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(session.hasActiveTurn(), true);
  resolveLateSettlement({ status: "rejected", kind: "rpc_error", reason: lateRpcError });

  await compactRejected;
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(releasedLateSettlement, 1);
});

test("CodexAppServerThreadSession compact 前置阶段立即占位并让停止阻断 provider 启动", async () => {
  let releaseEnsureStarted!: () => void;
  const ensureStartedGate = new Promise<void>((resolve) => {
    releaseEnsureStarted = resolve;
  });
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    ensureStarted: async () => await ensureStartedGate,
  });
  const emitters = { conversation() {}, raw() {} };
  const pendingCompact = session.compactThread({ turnId: "turn-compact-owner" as any }, emitters);

  assert.equal(session.hasActiveTurn(), true);
  assert.equal(session.getActiveTurnId(), "turn-compact-owner");
  const concurrentCompact = assert.rejects(
    session.compactThread({ turnId: "turn-compact-concurrent" as any }, emitters),
    /当前 thread 有未完成的 turn/,
  );
  const concurrentSend = assert.rejects(
    session.sendMessage({
      turnId: "turn-send-concurrent" as any,
      userItemId: "item-user" as any,
      text: "不得穿透 compact preflight",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
    }, emitters),
    /当前 thread 有未完成的 turn/,
  );
  const pendingInterrupt = session.interrupt("turn-compact-owner" as any);

  assert.equal(await pendingInterrupt, true);
  await assert.rejects(
    pendingCompact,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE && error?.terminationKind === "manual_interrupt",
  );
  await Promise.all([concurrentCompact, concurrentSend]);
  assert.equal(requests.some((request) => request.method === "thread/compact/start"), false);
  assert.equal(session.hasActiveTurn(), false);
  releaseEnsureStarted();
});

test("CodexAppServerThreadSession unbound compact process fault 保留运行态且不猜测 foreign turn", async () => {
  let rejectCompactStart!: (error: Error) => void;
  const compactStart = new Promise<never>((_resolve, reject) => {
    rejectCompactStart = reject;
  });
  let releasedLateSettlement = 0;
  const lateSettlement = new Promise<never>(() => {});
  const processError = Object.assign(new Error("Codex app-server process exited"), {
    code: "codex_app_server_process_error",
    method: "thread/compact/start",
    requestOutcomeUnknown: true,
    lateSettlement,
    releaseLateSettlement() {
      releasedLateSettlement += 1;
    },
  });
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/compact/start") return await compactStart;
      assert.fail(`compact process fault 不得发送额外 RPC：${method}`);
    },
  });
  const pendingCompact = session.compactThread({ turnId: "turn-client" as any }, {
    conversation() {},
    raw() {},
  });
  let compactSettled = false;
  void pendingCompact.then(
    () => { compactSettled = true; },
    () => { compactSettled = true; },
  );
  while (!requests.some((request) => request.method === "thread/compact/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  rejectCompactStart(processError);
  (session as any).onAppServerMessage({
    method: "error",
    params: { error: { code: "codex_app_server_process_error", message: processError.message } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const interruptError = await session.interrupt("turn-client" as any).then(
    () => assert.fail("缺少 compact 专用 turnId 时不得伪造中断成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  assert.equal(interruptError.code, "codex_turn_interrupt_state_unknown");
  assert.equal(interruptError.preserveRunningState, true);
  assert.equal(compactSettled, false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(requests.some((request) => request.method === "thread/read"), true);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal(releasedLateSettlement, 0);
});

test("CodexAppServerThreadSession interrupt 无 ACK 时保留 active 且不读取状态快照", async () => {
  let rejectInterrupt!: (error: Error) => void;
  const interruptRequest = new Promise<never>((_resolve, reject) => {
    rejectInterrupt = reject;
  });
  const processError = Object.assign(new Error("Codex app-server process exited"), {
    code: "codex_app_server_process_error",
    method: "turn/interrupt",
    requestOutcomeUnknown: true,
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/interrupt") return await interruptRequest;
      assert.fail(`中断失败后不得读取状态快照：${method}`);
    },
  });
  const pendingInterrupt = harness.session.interrupt("turn-client" as any);
  const interruptOutcome = pendingInterrupt.then(
    () => assert.fail("没有 ACK 或 provider 终态时不得返回中断成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );
  while (!harness.requests.some((request) => request.method === "turn/interrupt")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  rejectInterrupt(processError);
  (harness.session as any).onAppServerMessage({
    method: "error",
    params: { error: { code: "codex_app_server_process_error", message: processError.message } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const error = await interruptOutcome;
  assert.equal(error.code, "codex_turn_interrupt_state_unknown");
  assert.equal(error.preserveRunningState, true);
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/interrupt"]);
});

test("CodexAppServerThreadSession unbound compact 忽略 generic terminal，专用 item 后才确权", async () => {
  const { session } = createSendHarness("session-demo", {
    compactBaselineTurns: [{ id: "turn-retired", status: "completed", items: [] }],
    async request(method) {
      if (method === "thread/compact/start") return {};
      return {};
    },
  });
  (session as any).retiredCodexTurnIds.add("turn-retired");
  let compactSettled = false;
  const pendingCompact = session.compactThread({ turnId: "turn-client" as any }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    compactSettled = true;
  });
  await waitForActiveTurn(session);
  await flushMicrotasksUntil(
    () => (session as any).active?.compactStartState?.phase === "accepted",
    "compact/start 未进入 accepted",
  );

  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-retired", status: "completed" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(compactSettled, false);
  assert.equal((session as any).active.codexTurnId, null);
  assert.equal((session as any).retiredCodexTurnIds.has("turn-retired"), true);

  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-current", status: "completed" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(compactSettled, false);
  assert.equal((session as any).active.codexTurnId, null);

  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      threadId: "session-demo",
      turnId: "turn-current",
      item: { id: "item-compact", type: "contextCompaction" },
    },
  });
  await pendingCompact;
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 无 ID compact 只按 contextCompaction snapshot 对账", async () => {
  let providerCompleted = false;
  let readCount = 0;
  const { session } = createSendHarness("session-demo", {
    compactBaselineTurns: [{ id: "turn-history", status: "completed", items: [] }],
    async request(method) {
      if (method === "thread/compact/start") return {};
      if (method === "thread/read") {
        readCount += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [
              { id: "turn-history", status: "completed", items: [] },
              {
                id: "turn-compact",
                status: providerCompleted ? "completed" : "inProgress",
                items: [{ id: "item-compact", type: "contextCompaction" }],
              },
              {
                id: "turn-foreign-goal",
                status: "inProgress",
                items: [{ id: "item-foreign", type: "agentMessage", text: "goal" }],
              },
            ],
          },
        };
      }
      return {};
    },
  });
  const pendingCompact = session.compactThread({ turnId: "turn-client" as any }, {
    conversation() {},
    raw() {},
  });
  await waitForActiveTurn(session);

  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { status: "completed" } },
  });
  for (let attempt = 0; attempt < 20 && (session as any).active?.codexTurnId !== "turn-compact"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(readCount, 1);
  assert.equal((session as any).active?.codexTurnId, "turn-compact");
  assert.equal(session.hasActiveTurn(), true);

  providerCompleted = true;
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { status: "completed" } },
  });
  await pendingCompact;
  assert.equal(readCount, 2);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 终态读取期间出现 foreign started 仍结算已确权 provider turn", async () => {
  let resolveRead!: (value: unknown) => void;
  const pendingRead = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "thread/read") return await pendingRead;
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { status: "completed" } },
  });
  while (!harness.requests.some((request) => request.method === "thread/read")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  harness.session.onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-next", status: "inProgress" } },
  });
  resolveRead({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [{ id: "turn-engine", status: "completed", items: [] }],
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal((harness.session as any).active.codexTurnId, "turn-engine");
  assert.notEqual(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession compact 基线存在 running Goal 时返回 provider_busy 且零中断", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineStatus: { type: "active" },
    compactBaselineTurns: [{ id: "turn-goal", status: "inProgress", items: [] }],
  });

  await assert.rejects(
    session.compactThread({ turnId: "turn-client" as any }, { conversation() {}, raw() {} }),
    (error: any) => error?.code === "codex_compact_provider_busy",
  );

  assert.equal(requests.some((request) => request.method === "thread/compact/start"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession compact 只按完整 baseline 准入且不查询 persistent Goal", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    goalResponse: {
      goal: { threadId: "session-demo", status: "active" },
    },
    async request(method) {
      if (method === "thread/compact/start") return {};
      return {};
    },
  });

  const pending = session.compactThread(
    { turnId: "turn-client" as any },
    { conversation() {}, raw() {} },
  );
  await waitForActiveTurn(session);
  await flushMicrotasksUntil(
    () => (session as any).active?.compactStartState?.phase === "accepted",
    "compact/start 未进入 accepted",
  );
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      threadId: "session-demo",
      turnId: "turn-compact-no-goal-preflight",
      item: { id: "item-compact-no-goal-preflight", type: "contextCompaction" },
    },
  });
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: { id: "turn-compact-no-goal-preflight", status: "completed" },
    },
  });
  await pending;

  assert.equal(requests.some((request) => request.method === "thread/goal/get"), false);
  assert.equal(
    requests.filter((request) => request.method === "thread/read" && (request.params as any)?.includeTurns === true).length,
    1,
  );
  assert.equal(requests.some((request) => request.method === "thread/compact/start"), true);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession compact 基线读取期间 lifecycle 换代时拒绝 mutation", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "thread/read" && (params as any)?.includeTurns === true) {
        (sessionRef as any).onAppServerMessage({
          method: "turn/started",
          params: { threadId: "session-demo", turn: { id: "turn-foreign", status: "inProgress" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-foreign", status: "completed" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "thread/status/changed",
          params: { threadId: "session-demo", status: { type: "idle" } },
        });
        return createRollbackThreadRead([]);
      }
      return {};
    },
  });
  sessionRef = session;

  await assert.rejects(
    session.compactThread({ turnId: "turn-client" as any }, { conversation() {}, raw() {} }),
    (error: any) => error?.code === "codex_provider_active_preflight_stale"
      && error?.providerMutation === "compact",
  );

  assert.equal(requests.some((request) => request.method === "thread/compact/start"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 重启后 compact 不会把基线历史 terminal 误认成当前 turn", async () => {
  let resolveLateSettlement!: (value: unknown) => void;
  const lateSettlement = new Promise((resolve) => {
    resolveLateSettlement = resolve;
  });
  let releasedLateSettlement = 0;
  const compactStartError = Object.assign(new Error("Codex app-server request timeout: thread/compact/start"), {
    code: "codex_app_server_request_timeout",
    method: "thread/compact/start",
    requestOutcomeUnknown: true,
    lateSettlement,
    releaseLateSettlement() {
      releasedLateSettlement += 1;
    },
  });
  const lateRpcError = new Error("compact rejected after restart baseline read");
  let readCount = 0;
  const { session } = createSendHarness("session-demo", {
    compactBaselineTurns: [{ id: "turn-history", status: "completed", items: [] }],
    async request(method) {
      if (method === "thread/compact/start") throw compactStartError;
      if (method === "thread/read") {
        readCount += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{ id: "turn-history", status: "completed", items: [] }],
          },
        };
      }
      return {};
    },
  });
  let compactSettled = false;
  const pendingCompact = session.compactThread({ turnId: "turn-client" as any }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    compactSettled = true;
  });
  const compactRejected = assert.rejects(pendingCompact, (error) => error === lateRpcError);

  await waitForActiveTurn(session);
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-history", status: "completed" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(compactSettled, false);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal((session as any).active.codexTurnId, null);
  assert.equal(releasedLateSettlement, 0);
  assert.equal(readCount, 0);

  resolveLateSettlement({ status: "rejected", kind: "rpc_error", reason: lateRpcError });
  await compactRejected;
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(releasedLateSettlement, 1);
});

test("CodexAppServerThreadSession compact ACK 后缺少专用 turnId 时保留运行态", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/compact/start") return {};
      assert.fail(`无专用 compact turnId 时不得发送额外 RPC：${method}`);
    },
  });
  const pendingCompact = session.compactThread({ turnId: "turn-client" as any }, {
    conversation() {},
    raw() {},
  });
  let compactSettled = false;
  void pendingCompact.then(
    () => { compactSettled = true; },
    () => { compactSettled = true; },
  );
  await waitForActiveTurn(session);
  while ((session as any).active?.compactStartState?.phase !== "accepted") {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const beforeFault = await session.interrupt("turn-client" as any).then(
    () => assert.fail("compact ACK 未携带专用 turnId 时不得伪造中断成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  assert.equal(beforeFault.code, "codex_turn_interrupt_state_unknown");
  assert.equal(beforeFault.preserveRunningState, true);

  (session as any).onAppServerMessage({
    method: "error",
    params: {
      error: {
        code: "codex_app_server_process_error",
        message: "Codex app-server exited after compact ACK",
      },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const afterFault = await session.interrupt("turn-client" as any).then(
    () => assert.fail("process fault 仍未提供专用 turnId，不得伪造中断成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  assert.equal(afterFault.code, "codex_turn_interrupt_state_unknown");
  assert.equal(afterFault.preserveRunningState, true);
  assert.equal(compactSettled, false);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession rejects active turn when thread becomes idle and thread/read reports interrupted", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "interrupted",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.requests[0]?.method, "thread/read");
  assert.equal(harness.getResolved(), null);
  assert.match(harness.getRejected()?.message ?? "", /interrupted/);
});

test("CodexAppServerThreadSession 手动中断后在 thread/read authoritative interrupted 时保留 manual interrupt 语义", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "interrupted",
          items: [],
        },
      ],
    },
  });
  (harness.session as any).active.manualInterruptRequested = true;
  const interruptError = new Error("turn interrupted") as Error & {
    code?: string;
    terminationKind?: "manual_interrupt";
  };
  interruptError.code = MANUAL_TURN_INTERRUPT_CODE;
  interruptError.terminationKind = "manual_interrupt";
  (harness.session as any).active.manualInterruptError = interruptError;

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const rejected = harness.getRejected() as (Error & { code?: string; terminationKind?: string }) | null;
  assert.equal(harness.requests[0]?.method, "thread/read");
  assert.equal(harness.getResolved(), null);
  assert.equal(rejected?.message, "turn interrupted");
  assert.equal(rejected?.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(rejected?.terminationKind, "manual_interrupt");
});

test("CodexAppServerThreadSession resolves active turn when thread becomes idle and thread/read reports completed", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "completed",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.requests[0]?.method, "thread/read");
  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 不会在 thread/read 缺少当前 turn 时拿历史 turn 误结算当前回合", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-previous",
          status: "completed",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), true);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 在线程 idle 但 turn 仍非终态时不会仅凭 thread status hint 提前收口", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "in_progress",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession thread status hint 不会先于稍后到达的真实 final error 抢先收口", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "in_progress",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "idle" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 600));

  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "unexpected status 423 Locked: 所有可用渠道暂时不可用",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(harness.getRejected()?.message ?? "", /423 Locked/);
});

test("CodexAppServerThreadSession willRetry=false 的 responseStreamDisconnected 会直接报真实错误，不走 reconnect recovery", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "unexpected status 423 Locked: 所有可用渠道暂时不可用",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: 423,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.match(harness.getRejected()?.message ?? "", /423 Locked/);
});

test("CodexAppServerThreadSession 在 message 为空时优先回填 additionalDetails 作为错误原因", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "",
        additionalDetails: "relay rejected request",
        codexErrorInfo: "other",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const rejected = harness.getRejected() as (Error & {
    additionalDetails?: string;
    providerErrorInfo?: string;
  }) | null;
  assert.equal(rejected?.message, "relay rejected request");
  assert.equal(rejected?.additionalDetails, "relay rejected request");
  assert.equal(rejected?.providerErrorInfo, "other");
});

test("CodexAppServerThreadSession 在 message 为空且没有 details 时会展示 codexErrorInfo", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "",
        codexErrorInfo: "other",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const rejected = harness.getRejected() as (Error & { providerErrorInfo?: string }) | null;
  assert.equal(rejected?.message, "Codex 上游返回了错误类型是其他，但未提供更多细节。");
  assert.equal(rejected?.providerErrorInfo, "other");
});

test("CodexAppServerThreadSession turn/completed(status=completed) 会直接成功结算当前 turn", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: {
        id: "turn-engine",
        status: "completed",
        error: null,
        items: [],
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 无 turnId 的迟到终态不能直接结算已绑定 active", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const terminal of [
    {
      method: "turn/completed",
      params: { threadId: "session-demo", turn: { status: "completed" } },
      wrongThread: false,
    },
    {
      method: "turn/error",
      params: { threadId: "session-demo", error: { message: "late id-less error" } },
      wrongThread: true,
    },
  ] as const) {
    let readCount = 0;
    const harness = createSessionHarness({}, {
      async request(method) {
        if (method !== "thread/read") return {};
        readCount += 1;
        return {
          thread: {
            id: terminal.wrongThread ? "session-other" : "session-demo",
            status: { type: "active" },
            turns: [{ id: "turn-engine", status: "inProgress", items: [] }],
          },
        };
      },
    });

    harness.session.onAppServerMessage(terminal);
    await flushMicrotasksUntil(() => readCount === 1, `${terminal.method} 未触发首次权威读取`);
    t.mock.timers.tick(150);
    await flushMicrotasksUntil(() => readCount === 2, `${terminal.method} 未执行第二次权威读取`);
    t.mock.timers.tick(300);
    await flushMicrotasksUntil(() => readCount === 3, `${terminal.method} 未执行第三次权威读取`);

    assert.equal(harness.getResolved(), null);
    assert.equal(harness.getRejected(), null);
    assert.equal((harness.session as any).active.providerTerminalStatus ?? null, null);
  }
});

test("CodexAppServerThreadSession 无 turnId 终态对账会重试并保留 pending 期间的新提示", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let readCount = 0;
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method !== "thread/read") return {};
      readCount += 1;
      const completed = readCount >= 4;
      return {
        thread: {
          id: "session-demo",
          status: { type: completed ? "idle" : "active" },
          turns: [{ id: "turn-engine", status: completed ? "completed" : "inProgress", items: [] }],
        },
      };
    },
  });
  const idlessCompleted = {
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { status: "completed" } },
  } as const;

  harness.session.onAppServerMessage(idlessCompleted);
  await flushMicrotasksUntil(() => readCount === 1, "无 turnId 终态未触发首次权威读取");
  harness.session.onAppServerMessage(idlessCompleted);
  t.mock.timers.tick(150);
  await flushMicrotasksUntil(() => readCount === 2, "无 turnId 终态未执行第二次权威读取");
  t.mock.timers.tick(300);
  await flushMicrotasksUntil(
    () => readCount === 4 && harness.getResolved() != null,
    "pending 期间的新终态提示未触发补充对账",
  );

  assert.equal(harness.getRejected(), null);
  assert.equal((harness.session as any).active.providerTerminalStatus, "completed");
  assert.equal((harness.getResolved() as any)?.turnStatus, "completed");
});

test("CodexAppServerThreadSession turn/completed(status=failed) 会按失败结算，而不是误当成功", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: {
        id: "turn-engine",
        status: "failed",
        error: {
          message: "unexpected status 423 Locked: 所有可用渠道暂时不可用",
          additionalDetails: "relay rejected request",
        },
        items: [],
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.getResolved(), null);
  assert.match(harness.getRejected()?.message ?? "", /423 Locked/);
  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
});

test("CodexAppServerThreadSession turn/completed(status=interrupted) 在手动中断后会按 manual interrupt 结算", async () => {
  const harness = createSessionHarness({});
  (harness.session as any).active.manualInterruptRequested = true;
  const interruptError = new Error("turn interrupted") as Error & {
    code?: string;
    terminationKind?: "manual_interrupt";
  };
  interruptError.code = MANUAL_TURN_INTERRUPT_CODE;
  interruptError.terminationKind = "manual_interrupt";
  (harness.session as any).active.manualInterruptError = interruptError;

  harness.session.onAppServerMessage({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: {
        id: "turn-engine",
        status: "interrupted",
        error: null,
        items: [],
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  const rejected = harness.getRejected() as (Error & { code?: string; terminationKind?: string }) | null;
  assert.equal(harness.getResolved(), null);
  assert.equal(rejected?.message, "turn interrupted");
  assert.equal(rejected?.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(rejected?.terminationKind, "manual_interrupt");
  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
});

test("CodexAppServerThreadSession willRetry=false 的 responseStreamConnectionFailed 会直接报真实错误", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "stream connection failed with 502",
        codexErrorInfo: {
          responseStreamConnectionFailed: {
            httpStatusCode: 502,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.match(harness.getRejected()?.message ?? "", /502|connection failed/i);
});

test("CodexAppServerThreadSession willRetry=true 的 responseStreamConnectionFailed 仍按 transient reconnect 处理", async () => {
  const harness = createSessionHarness({}, {
    reconnectRecoveryGraceMs: 20,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "retrying stream connection",
        codexErrorInfo: {
          responseStreamConnectionFailed: {
            httpStatusCode: 502,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), true);
  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession willRetry=false 的 responseTooManyFailedAttempts 会直接报真实错误", async () => {
  const harness = createSessionHarness({});

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: false,
      error: {
        message: "retry limit reached",
        codexErrorInfo: {
          responseTooManyFailedAttempts: {
            httpStatusCode: 429,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.match(harness.getRejected()?.message ?? "", /retry limit reached/i);
});

test("CodexAppServerThreadSession thread status systemError 会触发 terminal reconcile", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "systemError" },
      turns: [
        {
          id: "turn-engine",
          status: "failed",
          items: [],
        },
      ],
    },
  });

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "systemError" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), true);
  assert.match(harness.getRejected()?.message ?? "", /turn ended as failed/i);
});

test("CodexAppServerThreadSession transient reconnect 会主动触发 recovery reconcile，而不只靠 idle 状态", async () => {
  const harness = createSessionHarness({}, {
    reconnectRecoveryGraceMs: 20,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "transport retrying",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: null,
          },
        },
        additionalDetails: "stream disconnected before completion",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), true);
  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession transient reconnect 在恢复后有新活动时会取消 recovery reconcile", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-engine",
          status: "completed",
          items: [],
        },
      ],
    },
  }, {
    reconnectRecoveryGraceMs: 40,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "Reconnecting... 1/5",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: null,
          },
        },
      },
    },
  });
  harness.session.onAppServerMessage({
    method: "item/started",
    params: {
      turn_id: "turn-engine",
      item: {
        id: "reasoning-1",
        type: "reasoning",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession transient reconnect 不会因单独一个 thread/status/changed active 提前取消 recovery", async () => {
  const harness = createSessionHarness({}, {
    reconnectRecoveryGraceMs: 40,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "Reconnecting... 1/5",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: null,
          },
        },
      },
    },
  });
  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "active" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(harness.requests.some((request) => request.method === "thread/read"), true);
  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession transient reconnect 在 provider turn 仍运行时不提前收口", async () => {
  const harness = createSessionHarness({}, {
    reconnectRecoveryGraceMs: 20,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "active" },
            turns: [
              {
                id: "turn-engine",
                status: "in_progress",
                items: [],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "transport retrying",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: null,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.ok(harness.requests.filter((request) => request.method === "thread/read").length >= 2);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("Codex app-server fatal stderr 识别 Rust OOM 类崩溃", () => {
  assert.equal(isFatalCodexAppServerStderrLine("memory allocation of 1048576 bytes failed"), true);
  assert.equal(isFatalCodexAppServerStderrLine("note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace"), false);
});

test("CodexAppServerThreadSession app-server fault 不伪造 provider 终态", () => {
  const harness = createSessionHarness({});
  const active = (harness.session as any).active;

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      error: {
        message: "Codex app-server fatal stderr: memory allocation of 1048576 bytes failed",
        code: "codex_app_server_fatal",
      },
    },
  });

  assert.equal(harness.getRejected(), null);
  assert.equal((harness.session as any).active, active);
  assert.equal(harness.session.hasActiveTurn(), true);
});

test("CodexAppServerThreadSession transient reconnect 会持续对账直到 provider turn completed", async () => {
  let readCount = 0;
  const harness = createSessionHarness({}, {
    reconnectRecoveryGraceMs: 20,
    reconnectRecoveryPollMs: 20,
    reconnectRecoveryMaxAttempts: 2,
    request: async (method: string) => {
      if (method === "thread/read") {
        readCount += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: readCount >= 3 ? "idle" : "active" },
            turns: [
              {
                id: "turn-engine",
                status: readCount >= 3 ? "completed" : "in_progress",
                items: [],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  harness.session.onAppServerMessage({
    method: "error",
    params: {
      turnId: "turn-engine",
      willRetry: true,
      error: {
        message: "transport retrying",
        codexErrorInfo: {
          responseStreamDisconnected: {
            httpStatusCode: null,
          },
        },
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 160));

  assert.ok(readCount >= 3);
  assert.ok(harness.getResolved());
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 忽略错位 provider turn 事件且不刷新当前 turn 活动时间", () => {
  const harness = createSessionHarness({});
  let rawTouches = 0;
  harness.session.active.timeoutController = {
    onRawEvent() {
      rawTouches += 1;
    },
    onConversationEvent() {},
    stop() {},
  };

  harness.session.onAppServerMessage({
    method: "item/reasoning/summaryTextDelta",
    params: {
      threadId: "session-demo",
      turnId: "retired-provider-turn",
      itemId: "reasoning-old",
      delta: "旧 provider turn 的输出",
      summaryIndex: 0,
    },
  });

  assert.equal(rawTouches, 0);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession terminal reconcile 耗尽但无精确终态时保留 active", async () => {
  const harness = createSessionHarness({
    thread: {
      id: "session-demo",
      status: { type: "systemError" },
      turns: [
        {
          id: "turn-engine",
          status: "in_progress",
          items: [],
        },
      ],
    },
  });
  harness.session.active.lastNonRetryableTurnError = new Error("unexpected status 423 Locked: 所有可用渠道暂时不可用");
  const active = harness.session.active;

  harness.session.onAppServerMessage({
    method: "thread/status/changed",
    params: {
      threadId: "session-demo",
      status: { type: "systemError" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 3);
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.session.active, active);
  assert.equal(harness.session.hasActiveTurn(), true);
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents补齐thread/read中的assistant completed", async () => {
  const { session } = createSendHarness("session-demo", {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "completed" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "msg-1",
                    text: "final text",
                    phase: "commentary",
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).assistantLifecycle.ensureStarted({
    itemId: "msg-1",
    engineMessageId: "msg-1",
    turnId: "turn-client",
    phase: "commentary",
  });
  (session as any).assistantLifecycle.appendDelta("msg-1", "partial");

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "completed",
  });

  assert.equal(reconciled.events.length, 1);
  const [event] = reconciled.events;
  assert.equal(event?.type, "item.agentMessage.completed");
  assert.deepEqual((event as any)?.payload, {
    itemId: "msg-1",
    engineMessageId: "msg-1",
    turnId: "turn-client",
    text: "final text",
    revision: 1,
    phase: "commentary",
    completionSource: "snapshot_reconcile",
    structuredPayloadJson: null,
  });
  assert.equal(reconciled.latestAssistantText, "final text");
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents 在没有 live assistant 记录时也会从 thread/read 恢复 completed", async () => {
  const { session } = createSendHarness("session-demo", {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "completed" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "msg-snapshot-only",
                    text: "snapshot only final",
                    phase: "final_answer",
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "completed",
  });

  assert.equal(reconciled.events.length, 1);
  assert.deepEqual((reconciled.events[0] as any)?.payload, {
    itemId: "msg-snapshot-only",
    engineMessageId: "msg-snapshot-only",
    turnId: "turn-client",
    text: "snapshot only final",
    revision: 1,
    phase: "final_answer",
    completionSource: "snapshot_reconcile",
    structuredPayloadJson: null,
  });
  assert.equal(reconciled.latestAssistantText, "snapshot only final");
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents 在 error 路径不读取快照", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    request: async (method: string) => {
      assert.fail(`error 结算不得读取 provider 快照：${method}`);
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).assistantLifecycle.ensureStarted({
    itemId: "msg-err",
    engineMessageId: "msg-err",
    turnId: "turn-client",
    phase: "commentary",
  });
  (session as any).assistantLifecycle.appendDelta("msg-err", "partial");

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "error",
  });

  assert.equal(reconciled.events.length, 1);
  assert.deepEqual((reconciled.events[0] as any)?.payload, {
    itemId: "msg-err",
    engineMessageId: "msg-err",
    turnId: "turn-client",
    text: "partial",
    revision: 1,
    phase: "commentary",
    completionSource: "runtime_close_reconcile",
    structuredPayloadJson: null,
  });
  assert.equal(reconciled.latestAssistantText, "partial");
  assert.equal(requests.some((request) => request.method === "thread/read"), false);
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents 会用 thread/read 升级已完成但过时的 provider assistant", async () => {
  const { session } = createSendHarness("session-demo", {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "completed" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "msg-upgrade",
                    text: "authoritative upgraded final",
                    phase: "final_answer",
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).assistantLifecycle.ensureCompleted({
    itemId: "msg-upgrade",
    engineMessageId: "msg-upgrade",
    turnId: "turn-client",
    text: "older provider completed",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  });

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "completed",
  });

  assert.equal(reconciled.events.length, 1);
  assert.deepEqual((reconciled.events[0] as any)?.payload, {
    itemId: "msg-upgrade",
    engineMessageId: "msg-upgrade",
    turnId: "turn-client",
    text: "authoritative upgraded final",
    revision: 2,
    phase: "final_answer",
    completionSource: "snapshot_reconcile",
    structuredPayloadJson: null,
  });
  assert.equal(reconciled.latestAssistantText, "authoritative upgraded final");
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents 不会把同文本 commentary 的 snapshot item-* 再补成第二条消息", async () => {
  const { session } = createSendHarness("session-demo", {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "completed" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "item-3",
                    text: "准备写入正式工件：更新主 TEST-E2E 报告。",
                    phase: "commentary",
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).assistantLifecycle.ensureCompleted({
    itemId: "msg-provider",
    engineMessageId: "msg-provider",
    turnId: "turn-client",
    text: "准备写入正式工件：更新主 TEST-E2E 报告。",
    revision: 1,
    phase: "commentary",
    completionSource: "provider",
  });

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "completed",
  });

  assert.equal(reconciled.events.length, 0);
  assert.equal(reconciled.latestAssistantText, "准备写入正式工件：更新主 TEST-E2E 报告。");
  assert.deepEqual((session as any).assistantLifecycle.get("msg-provider"), {
    itemId: "msg-provider",
    engineMessageId: "msg-provider",
    turnId: "turn-client",
    text: "准备写入正式工件：更新主 TEST-E2E 报告。",
    revision: 1,
    phase: "commentary",
    completed: true,
    completionSource: "provider",
    updatedAtSeq: 1,
  });
});

test("CodexAppServerThreadSession prepareAssistantTerminalEvents 不会把同文本 final_answer 的 snapshot item-* 再补成第二条消息", async () => {
  const { session } = createSendHarness("session-demo", {
    request: async (method: string) => {
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "completed" },
            turns: [
              {
                id: "turn-engine",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "item-9",
                    text: "当前节点已提交。",
                    phase: "final_answer",
                  },
                ],
              },
            ],
          },
        };
      }
      return {};
    },
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).assistantLifecycle.ensureCompleted({
    itemId: "msg-final",
    engineMessageId: "msg-final",
    turnId: "turn-client",
    text: "当前节点已提交。",
    revision: 1,
    phase: "final_answer",
    completionSource: "provider",
  });

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "completed",
  });

  assert.equal(reconciled.events.length, 0);
  assert.equal(reconciled.latestAssistantText, "当前节点已提交。");
  assert.deepEqual((session as any).assistantLifecycle.get("msg-final"), {
    itemId: "msg-final",
    engineMessageId: "msg-final",
    turnId: "turn-client",
    text: "当前节点已提交。",
    revision: 1,
    phase: "final_answer",
    completed: true,
    completionSource: "provider",
    updatedAtSeq: 1,
  });
});

test("CodexAppServerThreadSession 忽略 retired turn 的迟到 assistant item 事件，避免串到新 turn", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");

  (session as any).assistantLifecycle.startTurn("turn-client-2" as any);
  (session as any).bindCodexTurn("turn-client-1" as any, "turn-engine-1");
  (session as any).retireCodexTurn("turn-client-1" as any);
  (session as any).active = {
    clientTurnId: "turn-client-2",
    clientUserMessageIds: new Set(["item-user-turn-client-2"]),
    codexTurnId: "turn-engine-2",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turn_id: "turn-engine-1",
      item: {
        type: "agentMessage",
        id: "msg-old",
        phase: "commentary",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      turn_id: "turn-engine-1",
      item: {
        type: "agentMessage",
        id: "msg-old",
        text: "late old turn text",
        phase: "commentary",
      },
    },
  });

  assert.deepEqual(conversationEvents.map((event) => event.type), ["turn.engineBound"]);
  assert.equal((session as any).assistantLifecycle.get("msg-old"), null);
});

test("CodexAppServerThreadSession provider turn 绑定事件幂等并记录权威替换", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);

  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).replaceActiveCodexTurnId((session as any).active, "turn-engine-authoritative");

  const bindings = conversationEvents.filter((event) => event.type === "turn.engineBound");
  assert.equal(bindings.length, 2);
  assert.deepEqual(bindings.map((event) => event.payload), [
    {
      turnId: "turn-client",
      engineTurnId: "turn-engine",
      engineSessionId: "session-demo",
      previousEngineTurnId: null,
    },
    {
      turnId: "turn-client",
      engineTurnId: "turn-engine-authoritative",
      engineSessionId: "session-demo",
      previousEngineTurnId: "turn-engine",
    },
  ]);
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine-authoritative");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-engine"), false);
  assert.equal((session as any).clientTurnIdByCodexTurnId.get("turn-engine-authoritative"), "turn-client");
  assert.equal((session as any).retiredCodexTurnIds.has("turn-engine"), true);
});

test("CodexAppServerThreadSession mapping 持久化失败时不提交半状态且保留 active", () => {
  const { session, rawEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  let rejected: Error | null = null;
  (session as any).active.reject = (error: Error) => {
    rejected = error;
  };
  (session as any).emitters.conversation = (event: Record<string, unknown>) => {
    if (event.type === "turn.engineBound") throw new Error("mapping persistence failed");
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-engine-new",
      item: {
        type: "userMessage",
        id: "provider-user-new",
        clientId: "item-user-turn-client",
        content: [],
      },
    },
  });

  assert.equal(rejected, null);
  assert.equal((session as any).active.providerTerminalStatus, null);
  assert.equal((session as any).active.codexTurnId, "turn-engine");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine");
  assert.equal((session as any).clientTurnIdByCodexTurnId.get("turn-engine"), "turn-client");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-engine-new"), false);
  assert.equal(
    rawEvents.some((event) => (event.data as any)?.params?.turnId === "turn-engine-new"),
    false,
  );
});

test("CodexAppServerThreadSession active handoff 前 binding 持久化失败会保留旧 generation", async () => {
  let resolveTurnStart!: (value: unknown) => void;
  let bindingDropCalls = 0;
  const harness = createSendHarness("session-persist-before-active", {
    onSessionBindingDropped() {
      bindingDropCalls += 1;
    },
    request(method) {
      if (method === "thread/resume") return Promise.resolve({});
      if (method === "turn/start") {
        return new Promise((resolve) => {
          resolveTurnStart = resolve;
        });
      }
      assert.fail(`binding 持久化失败用例不得发送额外 RPC：${method}`);
    },
  });
  const emitConversation = (event: Record<string, unknown>) => {
    if (event.type === "turn.engineBound") throw new Error("binding persistence failed before active handoff");
    harness.conversationEvents.push(event);
  };

  const pending = harness.session.sendMessage({
    turnId: "turn-persist-before-active" as any,
    userItemId: "item-user-persist-before-active" as any,
    text: "trigger binding failure",
    images: [],
    assistantItemId: "item-assistant-persist-before-active",
    reasoningItemId: "item-reasoning-persist-before-active",
  }, {
    conversation: emitConversation,
    raw() {},
  });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/start") && Boolean(harness.threadHandlers[0]),
    "turn/start 未发出",
  );

  harness.threadHandlers[0]!.onMessage({
    method: "item/started",
    params: {
      threadId: "session-persist-before-active",
      turnId: "provider-persist-before-active",
      item: {
        type: "userMessage",
        id: "provider-user-persist-before-active",
        clientId: "item-user-persist-before-active",
        content: [],
      },
    },
  });
  assert.equal(
    (harness.session as any).pendingInterruptedStartingTurns.has("turn-persist-before-active"),
    false,
  );
  resolveTurnStart({ turn: { id: "provider-response-after-failure" } });

  const failure = await pending.then(
    () => assert.fail("binding 持久化失败必须显式返回错误"),
    (error: unknown) => error as Error & { preserveRunningState?: boolean },
  );
  assert.equal(failure.message, "binding persistence failed before active handoff");
  assert.equal(failure.preserveRunningState, true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((harness.session as any).active, null);
  assert.equal((harness.session as any).startingTurn?.clientTurnId, "turn-persist-before-active");
  assert.equal((harness.session as any).sessionId, "session-persist-before-active");
  assert.equal(
    (harness.session as any).codexTurnIdByClientTurnId.has("turn-persist-before-active"),
    false,
  );
  assert.equal(
    (harness.session as any).clientTurnIdByCodexTurnId.has("provider-response-after-failure"),
    false,
  );
  assert.equal(bindingDropCalls, 0);
  assert.equal(
    (harness.session as any).pendingInterruptedStartingTurns.has("turn-persist-before-active"),
    true,
  );
  assert.equal(
    (harness.session as any).pendingInterruptedStartingTurns
      .get("turn-persist-before-active")?.providerTurnId,
    "provider-response-after-failure",
  );
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);

  harness.threadHandlers[0]!.onMessage({
    method: "turn/completed",
    params: {
      threadId: "session-persist-before-active",
      turn: { id: "provider-response-after-failure", status: "failed" },
    },
  });
  await flushMicrotasksUntil(
    () => (harness.session as any).startingTurn == null,
    "精确 provider 终态未释放 starting fence",
  );
  assert.equal(
    (harness.session as any).pendingInterruptedStartingTurns.has("turn-persist-before-active"),
    false,
  );
  await harness.session.dispose({ flushActiveTurn: false });
});

test("CodexAppServerThreadSession detached steer 重复同 ID 回显不会绕过补偿退避", () => {
  const harness = createSendHarness("session-current");
  const compensationRetryTimer = setTimeout(() => {}, 60_000);
  compensationRetryTimer.unref?.();
  const correlation = {
    clientTurnId: "turn-client-steer-backoff",
    clientUserMessageId: "item-user-steer-backoff",
    providerThreadId: "session-old",
    sequence: 1,
    state: "interrupted",
    provisionalProviderTurnId: null,
    confirmedProviderTurnId: "turn-owned-steer-backoff",
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: compensationRetryTimer,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
  } as any;
  const correlationKey = JSON.stringify([correlation.providerThreadId, correlation.clientUserMessageId]);
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);
  let compensationCalls = 0;
  (harness.session as any).scheduleInterruptedSteerCompensation = () => {
    compensationCalls += 1;
  };

  (harness.session as any).confirmSteerOwnership(correlation, "turn-owned-steer-backoff");

  assert.equal(correlation.ownershipRecoveryTimer, compensationRetryTimer);
  assert.equal(compensationCalls, 0);
  (harness.session as any).forgetInterruptedSteerCorrelation(correlation);
  assert.equal(correlation.ownershipRecoveryTimer, null);
});

test("CodexAppServerThreadSession detached observer 隔离 foreign raw 并保留 owned raw", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        return {
          data: [{
            id: "turn-owned",
            status: "inProgress",
            itemsView: "full",
            items: [{ type: "userMessage", clientId: "item-user-detached-raw" }],
          }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-detached-raw",
    clientUserMessageId: "item-user-detached-raw",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    ownershipRecoveryRetryAt: Date.now(),
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    ownershipRecoveryExpiryTimer: null,
    ownershipRecoveryTimer: null,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).scheduleInterruptedStartingTurnCompensation = () => {};
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "session-old", turnId: "turn-foreign-goal", itemId: "item-foreign", delta: "foreign" },
  });
  assert.equal(harness.rawEvents.length, 0);

  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-owned",
      item: { type: "userMessage", clientId: "item-user-detached-raw", content: [] },
    },
  });
  assert.equal(harness.rawEvents.length, 1);
  assert.equal((harness.rawEvents[0]?.data as any)?.method, "item/started");
  await waitForCondition(
    () => startingTurn.providerLifecycleTurnId === "turn-owned",
    "detached owned turn 未经 full history 唯一确权",
  );

  detachedHandler.onMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "session-old", turnId: "turn-owned", itemId: "item-owned", delta: "owned" },
  });
  assert.equal(harness.rawEvents.length, 2);
  assert.equal(harness.rawEvents[1]?.clientTurnId, startingTurn.clientTurnId);
  assert.equal((harness.rawEvents[1]?.data as any)?.params?.turnId, "turn-owned");

  detachedHandler.onMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "session-old", turnId: "turn-foreign-after-bind", itemId: "item-foreign", delta: "foreign" },
  });
  assert.equal(harness.rawEvents.length, 2);
  (harness.session as any).forgetInterruptedStartingTurn(startingTurn);
});

test("CodexAppServerThreadSession detached terminal 早于 clientId 时保留证据并幂等收口", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        return {
          data: [{
            id: "turn-owned-terminal-first",
            status: "completed",
            itemsView: "full",
            items: [{ type: "userMessage", clientId: "item-user-terminal-first" }],
          }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-terminal-first",
    clientUserMessageId: "item-user-terminal-first",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    ownershipRecoveryRetryAt: Date.now(),
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    ownershipRecoveryExpiryTimer: null,
    ownershipRecoveryTimer: null,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  let compensationCalls = 0;
  (harness.session as any).scheduleInterruptedStartingTurnCompensation = () => {
    compensationCalls += 1;
  };
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-old", turn: { id: "turn-owned-terminal-first", status: "completed" } },
  });
  assert.equal(harness.rawEvents.length, 0);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  (harness.session as any).clearCodexTurnBindings();
  assert.equal(
    (harness.session as any).terminalObservedProviderTurnStatusById.has("turn-owned-terminal-first"),
    false,
  );
  assert.equal(
    (harness.session as any).terminalObservedProviderTurnStatusByThreadId
      .get("session-old")?.get("turn-owned-terminal-first"),
    "completed",
  );

  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-owned-terminal-first",
      item: { type: "userMessage", clientId: "item-user-terminal-first", content: [] },
    },
  });
  await waitForCondition(
    () => !(harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId),
    "detached terminal 未在 full history 唯一确权后幂等收口",
  );
  assert.equal(compensationCalls, 0);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), false);
  assert.equal(
    (harness.session as any).terminalObservedProviderTurnStatusById.get("turn-owned-terminal-first"),
    "completed",
  );
  assert.equal(harness.rawEvents.length, 1);
  assert.equal((harness.rawEvents[0]?.data as any)?.method, "item/started");
  assert.equal((harness.session as any).detachedProviderThreadUnregisterById.has("session-old"), false);
  assert.equal((harness.session as any).terminalObservedProviderTurnStatusByThreadId.has("session-old"), false);
});

test("CodexAppServerThreadSession detached terminal 不会按相同 turnId 跨 provider thread 串证据", () => {
  const harness = createSendHarness("session-current");
  const startingTurn = {
    clientTurnId: "turn-client-terminal-thread-scope",
    clientUserMessageId: "item-user-terminal-thread-scope",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    ownershipRecoveryRetryDelayMs: 1_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).rememberProviderTerminalStatus(
    "session-current",
    "turn-same-id",
    "completed",
  );
  let compensationCalls = 0;
  (harness.session as any).scheduleInterruptedStartingTurnCompensation = () => {
    compensationCalls += 1;
  };

  (harness.session as any).bindRetiredProviderTurnCorrelation(startingTurn, "turn-same-id");

  assert.equal(compensationCalls, 1);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  (harness.session as any).forgetInterruptedStartingTurn(startingTurn);
});

test("CodexAppServerThreadSession detached steer 冲突回显保留 fence 且不污染映射", () => {
  const harness = createSendHarness("session-current");
  const correlation = {
    clientTurnId: "turn-client-detached-steer",
    clientUserMessageId: "item-user-detached-steer",
    providerThreadId: "session-old",
    sequence: 1,
    state: "interrupted",
    provisionalProviderTurnId: null,
    confirmedProviderTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
  } as any;
  const correlationKey = JSON.stringify([correlation.providerThreadId, correlation.clientUserMessageId]);
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);
  let compensationCalls = 0;
  (harness.session as any).scheduleInterruptedSteerCompensation = () => {
    compensationCalls += 1;
  };
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);
  const buildEcho = (providerTurnId: string) => ({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: providerTurnId,
      item: { type: "userMessage", clientId: correlation.clientUserMessageId, content: [] },
    },
  });

  detachedHandler.onMessage(buildEcho("turn-owned-first"));
  detachedHandler.onMessage(buildEcho("turn-owned-conflict"));

  assert.equal(correlation.confirmedProviderTurnId, null);
  assert.equal(compensationCalls, 0);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(correlation.clientTurnId), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-owned-first"), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-owned-conflict"), false);
  assert.equal((harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey), true);
  assert.deepEqual(
    harness.rawEvents.map((event) => (event.data as any)?.params?.turnId),
    ["turn-owned-first", "turn-owned-conflict"],
  );
});

test("CodexAppServerThreadSession detached starting 的 A/B 回显保留 fence 且零补偿", () => {
  const harness = createSendHarness("session-current");
  const startingTurn = {
    clientTurnId: "turn-client-detached-start-conflict",
    clientUserMessageId: "item-user-detached-start-conflict",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);
  const echo = (providerTurnId: string) => ({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: providerTurnId,
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });

  detachedHandler.onMessage(echo("turn-start-a"));
  detachedHandler.onMessage(echo("turn-start-b"));

  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-start-a"), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-start-b"), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.deepEqual(
    harness.rawEvents.map((event) => (event.data as any)?.params?.turnId),
    ["turn-start-a", "turn-start-b"],
  );
});

test("CodexAppServerThreadSession detached provider turn 反向映射冲突保留 fence 与原 owner", () => {
  const harness = createSendHarness("session-current");
  const startingTurn = {
    clientTurnId: "turn-client-detached-binding-conflict",
    clientUserMessageId: "item-user-detached-binding-conflict",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    startRequestAttemptSequence: 1,
    persistedStartAttemptId: 1,
    providerStartEvidenceAttemptId: 1,
    providerStartEvidenceTurnId: "turn-detached-binding-conflict",
    persistedStartAttemptProviderTurnId: "turn-detached-binding-conflict",
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).bindCodexTurn(
    "turn-client-detached-existing-owner",
    "turn-detached-binding-conflict",
    null,
    "session-old",
  );
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-detached-binding-conflict",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });

  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.get("turn-detached-binding-conflict"), "turn-client-detached-existing-owner");
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId), false);
  assert.equal(harness.rawEvents.length, 1);
  assert.equal((harness.rawEvents[0]?.data as any)?.params?.turnId, "turn-detached-binding-conflict");
});

test("CodexAppServerThreadSession detached 实时候选与 history 不一致时保留 fence", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        return {
          data: [{
            id: "turn-history-b",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-observed-a" }],
          }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-observed-a",
    clientUserMessageId: "item-user-observed-a",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-observed-a",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });
  await waitForCondition(
    () => harness.requests.some((request) => request.method === "thread/turns/list")
      && startingTurn.ownershipRecoveryPromise == null,
    "history/live ownership 冲突未完成隔离",
  );

  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-observed-a"), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-history-b"), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession detached 当前 attempt response 与 clientId 精确匹配时跳过全历史扫描", async () => {
  let fullHistoryReads = 0;
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "turn/interrupt") return {};
      if (method === "thread/turns/list" && (params as any)?.itemsView === "notLoaded") {
        return {
          data: [{ id: "turn-exact-attempt", status: "interrupted" }],
          nextCursor: null,
        };
      }
      if (method === "thread/turns/list") {
        fullHistoryReads += 1;
        return { data: [], nextCursor: "cursor-unbounded" };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-exact-attempt",
    clientUserMessageId: "item-user-exact-attempt",
    providerThreadId: "session-old",
    providerTurnId: "turn-exact-attempt",
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    startRequestSent: true,
    startRequestAttemptSequence: 1,
    pendingStartRequestAttemptId: null,
    lastStartRequestAttemptId: 1,
    persistedStartAttemptId: 1,
    persistedStartAttemptProviderTurnId: "turn-exact-attempt",
    providerStartEvidenceAttemptId: 1,
    providerStartEvidenceTurnId: "turn-exact-attempt",
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    startupInterruptAcknowledged: false,
    acknowledgeStartupInterrupt() {
      this.startupInterruptAcknowledged = true;
    },
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-exact-attempt",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });
  await waitForCondition(
    () => !(harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId),
    "精确 attempt 证据未完成补偿",
  );

  assert.equal(fullHistoryReads, 0);
  assert.equal(startingTurn.providerLifecycleTurnId, null);
  assert.equal(
    (harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId),
    false,
  );
  assert.deepEqual(
    harness.requests.filter((request) => request.method === "turn/interrupt")
      .map((request) => (request.params as any)?.turnId),
    ["turn-exact-attempt"],
  );
});

test("CodexAppServerThreadSession detached 唯一候选超过四页后停止重复扫描且零中断", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        const cursor = String((params as any)?.cursor ?? "");
        const page = cursor ? Number(cursor.replace("cursor-", "")) : 0;
        return {
          data: [{
            id: page === 0 ? "turn-page-a" : `turn-page-foreign-${page}`,
            status: "inProgress",
            items: page === 0
              ? [{ type: "userMessage", clientId: "item-user-page-incomplete" }]
              : [],
          }],
          nextCursor: `cursor-${page + 1}`,
        };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-page-incomplete",
    clientUserMessageId: "item-user-page-incomplete",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);
  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-page-a",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });
  await waitForCondition(
    () => harness.requests.some((request) => request.method === "thread/turns/list")
      && startingTurn.ownershipRecoveryPromise == null,
    "不完整 ownership 页未完成 fail-closed 对账",
  );

  assert.equal(startingTurn.providerLifecycleTurnId, null);
  assert.equal(startingTurn.ownershipRecoveryExhausted, true);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(
    harness.requests.filter((request) => request.method === "thread/turns/list").length,
    4,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    harness.requests.filter((request) => request.method === "thread/turns/list").length,
    4,
  );
  (harness.session as any).forgetInterruptedStartingTurn(startingTurn);
});

test("CodexAppServerThreadSession detached cursor 第二页出现同 clientId 时保留多义 fence", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        const secondPage = String((params as any)?.cursor ?? "") === "cursor-page-2";
        return {
          data: [{
            id: secondPage ? "turn-cursor-b" : "turn-cursor-a",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-cursor-ambiguous" }],
          }],
          nextCursor: secondPage ? null : "cursor-page-2",
        };
      }
      return {};
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-cursor-ambiguous",
    clientUserMessageId: "item-user-cursor-ambiguous",
    providerThreadId: "session-old",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
    compensatedProviderTurnIds: new Set<string>(),
    onProviderTurnRecovered: null,
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
  (harness.session as any).registerDetachedProviderThreadObserver("session-old");
  const detachedHandler = harness.threadHandlers.find((handler) => handler.threadId === "session-old");
  assert.ok(detachedHandler);
  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-cursor-a",
      item: { type: "userMessage", clientId: startingTurn.clientUserMessageId, content: [] },
    },
  });

  await waitForCondition(
    () => harness.requests.filter((request) => request.method === "thread/turns/list").length === 2
      && startingTurn.ownershipRecoveryPromise == null,
    "cursor 第二页多义 ownership 未完成隔离",
  );
  assert.deepEqual(
    harness.requests
      .filter((request) => request.method === "thread/turns/list")
      .map((request) => (request.params as any)?.cursor ?? null),
    [null, "cursor-page-2"],
  );
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(startingTurn.clientTurnId), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), true);
});

test("CodexAppServerThreadSession 普通 start 直接采用响应 ID 且不扫描 ownership 历史", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return { turn: { id: "turn-start-response" } };
      if (method === "thread/turns/list") throw new Error("普通 start 不应扫描 ownership 历史");
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-start-response" as any,
    userItemId: "item-user-start-response" as any,
    text: "bind start response directly",
    images: [],
    assistantItemId: "item-assistant-start-response",
    reasoningItemId: "item-reasoning-start-response",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  assert.equal((harness.session as any).active?.codexTurnId, "turn-start-response");
  assert.equal((harness.session as any).active?.codexTurnBindingSource, "start_result");
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 0);
  assert.equal(harness.session.getSessionId(), "session-demo");
  harness.threadHandlers[0]!.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-start-response", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession active pending steer 扫描不完整时保留原 correlation", async () => {
  let ownershipPageCount = 0;
  const harness = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return { turn: { id: "turn-start-provisional" } };
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        const page = ownershipPageCount;
        ownershipPageCount += 1;
        return {
          data: [{
            id: page === 0 ? "turn-steer-page-one" : `turn-steer-foreign-${page}`,
            status: "inProgress",
            items: page === 0
              ? [{ type: "userMessage", clientId: "item-user-steer-page-limit" }]
              : [],
          }],
          nextCursor: `cursor-steer-${page + 1}`,
        };
      }
      assert.fail(`active steer 扫描用例不得发送额外 RPC：${method}`);
    },
  });
  const send = harness.session.sendMessage({
    turnId: "turn-client-steer-page-limit" as any,
    userItemId: "item-user-start-owner" as any,
    text: "start before steer",
    images: [],
    assistantItemId: "item-assistant-steer-page-limit",
    reasoningItemId: "item-reasoning-steer-page-limit",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  (harness.session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-start-provisional",
      item: { type: "userMessage", clientId: "item-user-start-owner", content: [] },
    },
  });
  await waitForCondition(
    () => (harness.session as any).active?.codexTurnId === "turn-start-provisional",
    "初始 start ownership 未确权",
  );
  await harness.session.appendInput({
    turnId: "turn-client-steer-page-limit" as any,
    userItemId: "item-user-steer-page-limit" as any,
    text: "pending steer ownership page limit",
    images: [],
  });
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-start-provisional", status: "completed" } },
  });

  const correlationKey = JSON.stringify(["session-demo", "item-user-steer-page-limit"]);
  await waitForCondition(
    () => ownershipPageCount === 4,
    "未知 steer ownership 扫描未达到分页上限",
  );
  const correlation = (harness.session as any).pendingSteerCorrelationsByProviderClientKey
    .get(correlationKey);
  assert.ok(correlation);
  assert.equal(correlation.state, "accepted");
  assert.equal(correlation.ownershipRecoveryExhausted, true);
  assert.equal(ownershipPageCount, 4);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 0);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(ownershipPageCount, 4);
  (harness.session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-steer-confirmed",
      item: { type: "userMessage", clientId: "item-user-steer-page-limit", content: [] },
    },
  });
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-steer-confirmed", status: "completed" } },
  });
  assert.deepEqual(await send, { responseText: "" });
  assert.equal(
    (harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey),
    false,
  );
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 普通 start 的迟到 foreign echo 不覆盖响应 ID", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return { turn: { id: "turn-start-stale-admission" } };
      if (method === "thread/turns/list") throw new Error("普通 start 不应扫描 ownership 历史");
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-start-stale-scan" as any,
    userItemId: "item-user-start-stale-scan" as any,
    text: "keep the turn/start response binding",
    images: [],
    assistantItemId: "item-assistant-start-stale-scan",
    reasoningItemId: "item-reasoning-start-stale-scan",
  }, { conversation() {}, raw() {} });

  await waitForActiveTurn(harness.session);
  const handler = harness.threadHandlers.find((item) => item.threadId === "session-demo");
  assert.ok(handler);
  handler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-start-stale-owned",
      item: { type: "userMessage", clientId: "item-user-start-stale-scan", content: [] },
    },
  });
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal((harness.session as any).active.codexTurnId, "turn-start-stale-admission");
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 0);
  assert.equal(harness.session.getSessionId(), "session-demo");

  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-start-stale-admission", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession active steer 扫描在途时实时 echo 确权不会被旧 incomplete 结果覆盖", async () => {
  let resolveFirstPage!: (value: unknown) => void;
  const firstPage = new Promise((resolve) => {
    resolveFirstPage = resolve;
  });
  let fullListCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "turn/start") return { turn: { id: "turn-steer-stale-start-admission" } };
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        if (fullListCalls === 1) return await firstPage;
        return {
          data: [{ id: `turn-steer-stale-foreign-${fullListCalls}`, status: "inProgress", items: [] }],
          nextCursor: `cursor-steer-stale-${fullListCalls}`,
        };
      }
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-steer-stale-scan" as any,
    userItemId: "item-user-steer-stale-start" as any,
    text: "start before stale steer scan",
    images: [],
    assistantItemId: "item-assistant-steer-stale-scan",
    reasoningItemId: "item-reasoning-steer-stale-scan",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  const handler = harness.threadHandlers.find((item) => item.threadId === "session-demo");
  assert.ok(handler);
  handler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-steer-stale-start-admission",
      item: { type: "userMessage", clientId: "item-user-steer-stale-start", content: [] },
    },
  });
  await waitForCondition(
    () => (harness.session as any).active?.codexTurnId === "turn-steer-stale-start-admission",
    "初始 start ownership 未确权",
  );
  await harness.session.appendInput({
    turnId: "turn-client-steer-stale-scan" as any,
    userItemId: "item-user-steer-stale-scan" as any,
    text: "confirm steer while history scan is pending",
    images: [],
  });
  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-steer-stale-start-admission", status: "completed" } },
  });
  await waitForCondition(() => fullListCalls === 1, "steer ownership 首屏扫描未进入 pending");
  handler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-steer-stale-owned",
      item: { type: "userMessage", clientId: "item-user-steer-stale-scan", content: [] },
    },
  });
  resolveFirstPage({
    data: [{ id: "turn-steer-stale-foreign-1", status: "inProgress", items: [] }],
    nextCursor: "cursor-steer-stale-1",
  });

  await waitForCondition(
    () => fullListCalls === 4 && (harness.session as any).pendingSteerOwnershipRecovery == null,
    "旧 steer incomplete 扫描未完成",
  );
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal((harness.session as any).active.codexTurnId, "turn-steer-stale-owned");
  assert.equal(
    Array.from((harness.session as any).pendingSteerCorrelationsByProviderClientKey.values())
      .some((correlation: any) => correlation.clientUserMessageId === "item-user-steer-stale-scan"),
    false,
  );
  assert.equal(harness.session.getSessionId(), "session-demo");

  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-steer-stale-owned", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession active steer 已缓存终态不会被旧 running 历史降级", async () => {
  let resolveOwnershipScan!: (value: unknown) => void;
  const ownershipScan = new Promise((resolve) => {
    resolveOwnershipScan = resolve;
  });
  let fullListCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "turn/start") return { turn: { id: "turn-active-terminal-start-admission" } };
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        return await ownershipScan;
      }
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-active-terminal-cache" as any,
    userItemId: "item-user-active-terminal-start" as any,
    text: "start before cached terminal steer",
    images: [],
    assistantItemId: "item-assistant-active-terminal-cache",
    reasoningItemId: "item-reasoning-active-terminal-cache",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  const handler = harness.threadHandlers.find((item) => item.threadId === "session-demo");
  assert.ok(handler);
  handler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-active-terminal-start-admission",
      item: { type: "userMessage", clientId: "item-user-active-terminal-start", content: [] },
    },
  });
  await waitForCondition(
    () => (harness.session as any).active?.codexTurnId === "turn-active-terminal-start-admission",
    "active terminal cache 初始 start ownership 未确权",
  );
  await harness.session.appendInput({
    turnId: "turn-client-active-terminal-cache" as any,
    userItemId: "item-user-active-terminal-steer" as any,
    text: "steer whose terminal arrives before history",
    images: [],
  });
  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-active-terminal-start-admission", status: "completed" } },
  });
  await waitForCondition(() => fullListCalls === 1, "active terminal cache ownership 扫描未进入 pending");
  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-active-terminal-steer-owned", status: "completed" } },
  });
  assert.equal(harness.session.hasActiveTurn(), true);

  resolveOwnershipScan({
    data: [{
      id: "turn-active-terminal-steer-owned",
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "item-user-active-terminal-steer" }],
    }],
    nextCursor: null,
  });

  assert.deepEqual(await pending, { responseText: "" });
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession active steer 扫描转 detached 时共享 singleflight", async () => {
  let resolveActiveScan!: (value: unknown) => void;
  const activeScan = new Promise((resolve) => {
    resolveActiveScan = resolve;
  });
  let fullListCalls = 0;
  let concurrentFullListCalls = 0;
  let maxConcurrentFullListCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "turn/start") return { turn: { id: "turn-singleflight-start-admission" } };
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        concurrentFullListCalls += 1;
        maxConcurrentFullListCalls = Math.max(maxConcurrentFullListCalls, concurrentFullListCalls);
        try {
          if (fullListCalls === 1) return await activeScan;
          return {
            data: [{
              id: "turn-singleflight-steer-owned",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user-singleflight-steer" }],
            }],
            nextCursor: null,
          };
        } finally {
          concurrentFullListCalls -= 1;
        }
      }
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-singleflight-steer" as any,
    userItemId: "item-user-singleflight-start" as any,
    text: "start before singleflight steer",
    images: [],
    assistantItemId: "item-assistant-singleflight-steer",
    reasoningItemId: "item-reasoning-singleflight-steer",
  }, { conversation() {}, raw() {} });
  const rejected = assert.rejects(pending, /force active settlement during ownership scan/);
  await waitForActiveTurn(harness.session);
  const handler = harness.threadHandlers.find((item) => item.threadId === "session-demo");
  assert.ok(handler);
  handler.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-singleflight-start-admission",
      item: { type: "userMessage", clientId: "item-user-singleflight-start", content: [] },
    },
  });
  await waitForCondition(
    () => (harness.session as any).active?.codexTurnId === "turn-singleflight-start-admission",
    "singleflight 初始 start ownership 未确权",
  );
  await harness.session.appendInput({
    turnId: "turn-client-singleflight-steer" as any,
    userItemId: "item-user-singleflight-steer" as any,
    text: "pending steer before forced settlement",
    images: [],
  });
  handler.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-singleflight-start-admission", status: "completed" } },
  });
  await waitForCondition(() => fullListCalls === 1, "active steer ownership 扫描未进入 pending");

  (harness.session as any).active.reject(new Error("force active settlement during ownership scan"));
  await rejected;
  await waitForCondition(() => !harness.session.hasActiveTurn(), "active 强制收口后仍未释放");
  assert.equal(fullListCalls, 1);

  resolveActiveScan({ data: [], nextCursor: null });
  const correlationKey = JSON.stringify(["session-demo", "item-user-singleflight-steer"]);
  await waitForCondition(
    () => !(harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey),
    "active scan 结束后 detached ownership 未接续",
    2_000,
  );
  assert.equal(fullListCalls, 2);
  assert.equal(maxConcurrentFullListCalls, 1);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession retained starting 扫描中收到候选 echo 后仍保留 fence", async () => {
  let resolveFirstPage!: (value: unknown) => void;
  const firstPage = new Promise((resolve) => {
    resolveFirstPage = resolve;
  });
  let fullListCalls = 0;
  const harness = createSendHarness("session-old", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        if (fullListCalls === 1) return await firstPage;
        if (fullListCalls <= 4) {
          return {
            data: [{ id: `turn-old-page-${fullListCalls}`, status: "inProgress", items: [] }],
            nextCursor: `cursor-old-${fullListCalls}`,
          };
        }
        return {
          data: [{
            id: "turn-owned-after-echo",
            status: "interrupted",
            items: [{ type: "userMessage", clientId: "item-user-inflight-start" }],
          }],
          nextCursor: null,
        };
      }
      if (method === "thread/turns/list" && (params as any)?.itemsView === "notLoaded") {
        return {
          data: [{ id: "turn-owned-after-echo", status: "interrupted", itemsView: "notLoaded" }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  harness.session.detachProviderGeneration("session-old" as any, {
    clientTurnId: "turn-client-inflight-start" as any,
    clientUserMessageId: "item-user-inflight-start",
    provisionalProviderTurnId: "turn-admission-inflight-start",
    onProviderTurnRecovered() {},
  });
  await waitForCondition(() => fullListCalls === 1, "retained starting 首屏扫描未进入 pending");
  const echo = {
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-owned-after-echo",
      item: { type: "userMessage", clientId: "item-user-inflight-start", content: [] },
    },
  };
  (harness.session as any).onAppServerMessage(echo);
  (harness.session as any).onAppServerMessage(echo);
  resolveFirstPage({
    data: [{ id: "turn-old-page-1", status: "inProgress", items: [] }],
    nextCursor: "cursor-old-1",
  });

  await waitForCondition(() => fullListCalls === 4, "retained starting 扫描未达到分页上限", 2_000);
  const retained = (harness.session as any).pendingInterruptedStartingTurns
    .get("turn-client-inflight-start");
  assert.ok(retained);
  assert.equal(fullListCalls, 4);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession detached steer 在扫描中收到 echo 后只合并一次重扫", async () => {
  let resolveFirstPage!: (value: unknown) => void;
  const firstPage = new Promise((resolve) => {
    resolveFirstPage = resolve;
  });
  let fullListCalls = 0;
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        if (fullListCalls === 1) return await firstPage;
        if (fullListCalls <= 4) {
          return {
            data: [{ id: `turn-steer-old-page-${fullListCalls}`, status: "inProgress", items: [] }],
            nextCursor: `cursor-steer-old-${fullListCalls}`,
          };
        }
        return {
          data: [{
            id: "turn-steer-owned-after-echo",
            status: "interrupted",
            items: [{ type: "userMessage", clientId: "item-user-inflight-steer" }],
          }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const correlation = {
    clientTurnId: "turn-client-inflight-steer",
    clientUserMessageId: "item-user-inflight-steer",
    providerThreadId: "session-old",
    sequence: 1,
    state: "interrupted",
    provisionalProviderTurnId: null,
    confirmedProviderTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryExhausted: false,
    ownershipRecoveryRescanRequested: false,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
  } as any;
  const correlationKey = JSON.stringify([correlation.providerThreadId, correlation.clientUserMessageId]);
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);
  (harness.session as any).registerDetachedProviderThreadObserver(correlation.providerThreadId);
  (harness.session as any).scheduleInterruptedSteerOwnershipRecovery(correlation);
  await waitForCondition(() => fullListCalls === 1, "detached steer 首屏扫描未进入 pending");
  const detachedHandler = harness.threadHandlers
    .filter((handler) => handler.threadId === "session-old")
    .at(-1);
  assert.ok(detachedHandler);
  const echo = {
    method: "item/started",
    params: {
      threadId: "session-old",
      turnId: "turn-steer-owned-after-echo",
      item: { type: "userMessage", clientId: correlation.clientUserMessageId, content: [] },
    },
  };
  detachedHandler.onMessage(echo);
  detachedHandler.onMessage(echo);
  resolveFirstPage({
    data: [{ id: "turn-steer-old-page-1", status: "inProgress", items: [] }],
    nextCursor: "cursor-steer-old-1",
  });

  await waitForCondition(
    () => !(harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey),
    "扫描中 steer echo 未触发一次合并重扫",
    2_000,
  );
  assert.equal(fullListCalls, 5);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession detached steer 已缓存终态不会被旧 running 历史降级", async () => {
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        return {
          data: [{
            id: "turn-steer-terminal-before-history",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-steer-terminal-before-history" }],
          }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const correlation = {
    clientTurnId: "turn-client-steer-terminal-before-history",
    clientUserMessageId: "item-user-steer-terminal-before-history",
    providerThreadId: "session-old",
    sequence: 1,
    state: "interrupted",
    provisionalProviderTurnId: null,
    confirmedProviderTurnId: null,
    providerObservedTurnId: null,
    ownershipRecoveryPromise: null,
    ownershipRecoveryTimer: null,
    ownershipRecoveryExhausted: false,
    ownershipRecoveryRescanRequested: false,
    ownershipRecoveryRetryAt: 0,
    ownershipRecoveryRetryDelayMs: 1_000,
    ownershipRecoveryExpiresAt: Date.now() + 60_000,
  } as any;
  const correlationKey = JSON.stringify([correlation.providerThreadId, correlation.clientUserMessageId]);
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);
  (harness.session as any).registerDetachedProviderThreadObserver(correlation.providerThreadId);
  const detachedHandler = harness.threadHandlers
    .filter((handler) => handler.threadId === correlation.providerThreadId)
    .at(-1);
  assert.ok(detachedHandler);

  detachedHandler.onMessage({
    method: "turn/completed",
    params: {
      threadId: correlation.providerThreadId,
      turn: { id: "turn-steer-terminal-before-history", status: "completed" },
    },
  });
  detachedHandler.onMessage({
    method: "item/started",
    params: {
      threadId: correlation.providerThreadId,
      turnId: "turn-steer-terminal-before-history",
      item: { type: "userMessage", clientId: correlation.clientUserMessageId, content: [] },
    },
  });

  await waitForCondition(
    () => !(harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey),
    "已缓存终态的 detached steer 未立即收口",
  );
  assert.equal(harness.requests.filter((request) => request.method === "thread/turns/list").length, 1);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession ownership full 结构非法时立即 exhausted 且不重复扫描", async () => {
  let fullListCalls = 0;
  const harness = createSendHarness("session-old", {
    async request(method, params) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        return {
          data: [{ id: "turn-invalid-items-view", status: "inProgress", items: [], itemsView: "notLoaded" }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  harness.session.detachProviderGeneration("session-old" as any, {
    clientTurnId: "turn-client-invalid-items-view" as any,
    clientUserMessageId: "item-user-invalid-items-view",
    provisionalProviderTurnId: "turn-admission-invalid-items-view",
    onProviderTurnRecovered() {},
  });
  const recovery = (harness.session as any).pendingInterruptedStartingTurns
    .get("turn-client-invalid-items-view");
  assert.ok(recovery);
  await waitForCondition(
    () => recovery.ownershipRecoveryExhausted && recovery.ownershipRecoveryPromise == null,
    "非法 full itemsView 未进入 exhausted",
  );
  assert.equal(fullListCalls, 1);
  assert.equal(recovery.providerLifecycleTurnId, null);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fullListCalls, 1);
  (harness.session as any).forgetInterruptedStartingTurn(recovery);
});

test("CodexAppServerThreadSession ownership 重复 cursor 与跨页 turnId 都有界 fail-closed", async () => {
  const scenarios = [
    {
      name: "repeat-cursor",
      response(call: number) {
        return {
          data: [{ id: `turn-repeat-cursor-${call}`, status: "inProgress", items: [] }],
          nextCursor: "cursor-repeat",
        };
      },
    },
    {
      name: "repeat-turn-id",
      response(call: number) {
        return {
          data: [{ id: "turn-repeat-across-pages", status: "inProgress", items: [] }],
          nextCursor: call === 1 ? "cursor-second-page" : null,
        };
      },
    },
  ];

  for (const scenario of scenarios) {
    let fullListCalls = 0;
    const harness = createSendHarness(`session-${scenario.name}`, {
      async request(method, params) {
        if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
          fullListCalls += 1;
          return scenario.response(fullListCalls);
        }
        return {};
      },
    });
    const clientTurnId = `turn-client-${scenario.name}`;
    harness.session.detachProviderGeneration(`session-${scenario.name}` as any, {
      clientTurnId: clientTurnId as any,
      clientUserMessageId: `item-user-${scenario.name}`,
      provisionalProviderTurnId: `turn-admission-${scenario.name}`,
      onProviderTurnRecovered() {},
    });
    const recovery = (harness.session as any).pendingInterruptedStartingTurns.get(clientTurnId);
    assert.ok(recovery);
    await waitForCondition(
      () => recovery.ownershipRecoveryExhausted && recovery.ownershipRecoveryPromise == null,
      `${scenario.name} 未进入 exhausted`,
    );
    assert.equal(fullListCalls, 2);
    assert.equal(recovery.providerLifecycleTurnId, null);
    assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
    (harness.session as any).forgetInterruptedStartingTurn(recovery);
  }
});

test("CodexAppServerThreadSession ownership 分页共享单次总 deadline", async () => {
  const requestTimeouts: number[] = [];
  let fullListCalls = 0;
  const harness = createSendHarness("session-deadline", {
    async request(method, params, requestOpts) {
      if (method === "thread/turns/list" && (params as any)?.itemsView === "full") {
        fullListCalls += 1;
        requestTimeouts.push(Number(requestOpts?.timeoutMs ?? 0));
        if (fullListCalls === 1) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            data: [{ id: "turn-deadline-page-one", status: "inProgress", items: [] }],
            nextCursor: "cursor-deadline-two",
          };
        }
        return { data: [], nextCursor: null };
      }
      return {};
    },
  });
  const workspace = (harness.session as any).opts.manager.getOrCreate(
    "client-a:ws-demo",
    "Z:/code/codeflowai",
  );

  const evidence = await (harness.session as any).readProviderTurnOwnershipEvidence(
    workspace,
    "session-deadline",
    "item-user-deadline",
    1_000,
  );

  assert.equal(evidence.complete, true);
  assert.equal(fullListCalls, 2);
  assert.equal(requestTimeouts.length, 2);
  assert.ok(requestTimeouts[0]! > requestTimeouts[1]!);
});

test("CodexAppServerThreadSession current 与 detached 的 starting/steer 在 TTL 后停止扫描但保留 fence", () => {
  const harness = createSendHarness("session-current");
  const providerThreadIds = ["session-old", "session-current"];
  for (const [index, providerThreadId] of providerThreadIds.entries()) {
    const startingTurn = {
      clientTurnId: `turn-client-expired-${index}`,
      clientUserMessageId: `item-user-expired-${index}`,
      providerThreadId,
      providerLifecycleTurnId: `turn-owned-expired-${index}`,
      ownershipRecoveryTimer: null,
      ownershipRecoveryExpiresAt: Date.now() - 1,
      compensatedProviderTurnIds: new Set<string>(),
      resolveInterruptFinalized() {},
    } as any;
    const steer = {
      clientTurnId: `turn-client-steer-expired-${index}`,
      clientUserMessageId: `item-user-steer-expired-${index}`,
      providerThreadId,
      sequence: index,
      state: "interrupted",
      provisionalProviderTurnId: null,
      confirmedProviderTurnId: `turn-steer-expired-${index}`,
      ownershipRecoveryPromise: null,
      ownershipRecoveryTimer: null,
      ownershipRecoveryRetryDelayMs: 1_000,
      ownershipRecoveryExpiresAt: Date.now() - 1,
    } as any;
    (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);
    (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(
      JSON.stringify([providerThreadId, steer.clientUserMessageId]),
      steer,
    );
    (harness.session as any).registerDetachedProviderThreadObserver(providerThreadId);

    (harness.session as any).scheduleInterruptedStartingTurnCompensation(
      startingTurn,
      startingTurn.providerLifecycleTurnId,
    );
    (harness.session as any).scheduleInterruptedSteerCompensation(steer, steer.confirmedProviderTurnId);
  }

  assert.equal(harness.requests.length, 0);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 2);
  assert.equal((harness.session as any).pendingSteerCorrelationsByProviderClientKey.size, 2);
  assert.equal((harness.session as any).detachedProviderThreadUnregisterById.size, 2);
  assert.equal(
    Array.from((harness.session as any).pendingInterruptedStartingTurns.values())
      .every((startingTurn: any) => startingTurn.ownershipRecoveryExhausted === true),
    true,
  );
  assert.equal(
    Array.from((harness.session as any).pendingSteerCorrelationsByProviderClientKey.values())
      .every((correlation: any) => correlation.ownershipRecoveryExhausted === true),
    true,
  );
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 同一 clientId 的冲突回显不伪造 active 终态", () => {
  const harness = createSessionHarness({});
  const firstEcho = {
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-engine",
      item: { type: "userMessage", clientId: "item-user-turn-client", content: [] },
    },
  };
  (harness.session as any).onAppServerMessage(firstEcho);
  (harness.session as any).onAppServerMessage({
    ...firstEcho,
    params: { ...firstEcho.params, turnId: "turn-engine-conflict" },
  });

  assert.equal(harness.getRejected(), null);
  assert.equal((harness.session as any).active.providerTerminalStatus, null);
  assert.equal((harness.session as any).active.codexTurnId, "turn-engine");
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-engine-conflict"), false);
});

test("CodexAppServerThreadSession 已按 turn/start 绑定的停止保留 generation 且不触发 binding drop", async () => {
  let bindingDropAttempts = 0;
  const harness = createSendHarness("session-demo", {
    onSessionBindingDropped() {
      bindingDropAttempts += 1;
      throw new Error("binding drop must not run");
    },
    async request(method) {
      if (method === "turn/start") return { turn: { id: "turn-provisional" } };
      if (method === "thread/turns/list") {
        return {
          data: [{ id: "turn-provisional", status: "interrupted", itemsView: "notLoaded" }],
          nextCursor: null,
        };
      }
      return {};
    },
  });
  const send = harness.session.sendMessage({
    turnId: "turn-client-binding-drop" as any,
    userItemId: "item-user-binding-drop" as any,
    text: "stop before ownership",
    images: [],
    assistantItemId: "item-assistant-binding-drop",
    reasoningItemId: "item-reasoning-binding-drop",
  }, {
    conversation() {},
    raw() {},
  });
  await waitForActiveTurn(harness.session);
  assert.equal((harness.session as any).active?.codexTurnId, "turn-provisional");
  assert.equal((harness.session as any).active?.provisionalCodexTurnId, null);
  assert.equal((harness.session as any).active?.codexTurnBindingSource, "start_result");

  assert.equal(await harness.session.interrupt("turn-client-binding-drop" as any), true);
  await assert.rejects(send, (error: any) => error?.terminationKind === "manual_interrupt");
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.getActiveTurnId(), null);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
  assert.equal(bindingDropAttempts, 0);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 0);
  assert.deepEqual(
    harness.requests
      .filter((request) => request.method === "turn/interrupt")
      .map((request) => request.params),
    [{ threadId: "session-demo", turnId: "turn-provisional" }],
  );
  assert.equal(
    harness.requests.some((request) => (
      request.method === "thread/turns/list"
      && (request.params as any)?.itemsView === "full"
    )),
    false,
  );
  assert.equal(harness.session.canIdleDispose(), true);
  await harness.session.dispose({ flushActiveTurn: false });
});

test("CodexAppServerThreadSession uncertain starting 失败时保留原 binding 与运行 fence", async () => {
  let bindingDropCalls = 0;
  const harness = createSendHarness("session-demo", {
    onSessionBindingDropped() {
      bindingDropCalls += 1;
      throw new Error("uncertain starting binding drop must not run");
    },
    async request(method) {
      if (method === "turn/start") {
        throw createTrackedTurnStartTimeout(Promise.resolve({
          status: "fulfilled",
          value: { turn: { id: "turn-ghost" } },
        }));
      }
      if (method === "thread/read") {
        return { thread: { id: "session-demo", status: { type: "idle" }, turns: [] } };
      }
      if (method === "thread/turns/list") return { data: [] };
      return {};
    },
  });

  const send = harness.session.sendMessage({
    turnId: "turn-client-uncertain-binding-drop" as any,
    userItemId: "item-user-uncertain-binding-drop" as any,
    text: "uncertain starting cleanup",
    images: [],
    assistantItemId: "item-assistant-uncertain-binding-drop",
    reasoningItemId: "item-reasoning-uncertain-binding-drop",
  }, { conversation() {}, raw() {} });
  await assert.rejects(
    Promise.race([
      send,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("uncertain starting 未在一秒内收口")), 1_000)),
    ]),
    /Codex app-server request timeout: turn\/start/,
  );
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(harness.session.getActiveTurnId(), "turn-client-uncertain-binding-drop");
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
  assert.equal(bindingDropCalls, 0);
  assert.equal((harness.session as any).startingTurn?.providerTurnId, "turn-ghost");
});

test("CodexAppServerThreadSession compact unavailable 原样失败且保留原 thread", async () => {
  let bindingDropCalls = 0;
  const methods: string[] = [];
  const harness = createSendHarness("session-demo", {
    compactBaselineTurns: [],
    onSessionBindingDropped() {
      bindingDropCalls += 1;
      throw new Error("compact binding drop must not run");
    },
    async request(method, params: any) {
      methods.push(method);
      if (method === "thread/compact/start") throw new Error("no rollout found for thread id session-demo");
      if (method === "thread/resume") {
        assert.equal(params?.threadId, "session-demo");
        return {};
      }
      if (method === "thread/read") {
        assert.equal(params?.threadId, "session-demo");
        assert.equal(params?.includeTurns, false);
        return { thread: { id: "session-demo", status: { type: "idle" } } };
      }
      return {};
    },
  });

  await assert.rejects(
    harness.session.compactThread(
      { turnId: "turn-compact-binding-drop" as any },
      { conversation() {}, raw() {} },
    ),
    /no rollout found for thread id session-demo/,
  );
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.getActiveTurnId(), null);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
  assert.equal(bindingDropCalls, 0);
  assert.deepEqual(harness.requests.map((request) => request.method), [
    "thread/resume",
    "thread/read",
    "thread/compact/start",
  ]);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  await harness.session.dispose({ flushActiveTurn: false });
});

test("CodexAppServerThreadSession 未绑定的迟到 thread/start 不调用 binding drop", async () => {
  let resolveThreadStart!: (value: unknown) => void;
  const threadStart = new Promise((resolve) => {
    resolveThreadStart = resolve;
  });
  let bindingDropAttempts = 0;
  const harness = createSendHarness(null, {
    onSessionBindingDropped() {
      bindingDropAttempts += 1;
      throw new Error("late preflight binding cleanup failed");
    },
    async request(method) {
      if (method === "thread/start") return await threadStart;
      return {};
    },
  });
  const send = harness.session.sendMessage({
    turnId: "turn-client-late-preflight" as any,
    userItemId: "item-user-late-preflight" as any,
    text: "stop during thread start",
    images: [],
    assistantItemId: "item-assistant-late-preflight",
    reasoningItemId: "item-reasoning-late-preflight",
  }, { conversation() {}, raw() {} });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "thread/start"),
    "thread/start 未进入 pending",
  );

  assert.equal(await harness.session.interrupt("turn-client-late-preflight" as any), true);
  await assert.rejects(send, (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE);
  resolveThreadStart({ thread: { id: "session-late-preflight" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.getSessionId(), null);
  assert.equal(bindingDropAttempts, 0);
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
});

test("CodexAppServerThreadSession 已有 binding 在 resume ACK 后由 turn/start 仲裁 provider active 竞态", async () => {
  let providerRunning = true;
  const { session, requests, rawEvents } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        if (providerRunning) {
          throw createExplicitTurnStartRejection(
            "expected active turn id turn-live",
            "request-provider-active-race",
          );
        }
        return { turn: { id: "turn-submission" } };
      }
      return {};
    },
  });
  (session as any).onAppServerMessage({
    method: "thread/status/changed",
    params: { threadId: "session-demo", status: { type: "active" } },
  });
  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-live", status: "inProgress" } },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-live" as any,
    userItemId: "item-user-live" as any,
    text: "不得写入当前 provider goal",
    images: [],
    assistantItemId: "item-assistant-live",
    reasoningItemId: "item-reasoning-live",
    systemMessage: "system-live-head",
    developerMessage: "developer-live-head",
    model: "gpt-6-astra",
    effort: "high",
  }, {
    conversation() {},
    raw(event) {
      rawEvents.push(event as Record<string, unknown>);
    },
  }), /expected active turn id turn-live/);
  assert.equal(requests.some((request) => request.method === "thread/goal/get"), false);
  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  const resumeParams = requests[0]?.params as Record<string, any>;
  const turnStartParams = requests[1]?.params as Record<string, any>;
  assert.equal(resumeParams.developerInstructions, withCodexExecutionInstructions("system-live-head", "developer-live-head"));
  assert.equal(turnStartParams.model, "gpt-6-astra");
  assert.equal(turnStartParams.collaborationMode.settings.developer_instructions, undefined);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(requests.some((request) => request.method === "turn/steer"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.getSessionId(), "session-demo");

  (session as any).onAppServerMessage({
    method: "item/agentMessage/delta",
    params: { threadId: "session-demo", turnId: "turn-live", itemId: "msg-foreign", delta: "foreign" },
  });
  assert.equal(
    rawEvents.some((event) => (event as any).data?.method === "item/agentMessage/delta"),
    false,
  );

  providerRunning = false;
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-live", status: "completed" } },
  });
  (session as any).onAppServerMessage({
    method: "thread/status/changed",
    params: { threadId: "session-demo", status: { type: "idle" } },
  });
  const next = session.sendMessage({
    turnId: "turn-client-after-goal" as any,
    userItemId: "item-user-after-goal" as any,
    text: "Goal 结束后发送",
    images: [],
    assistantItemId: "item-assistant-after-goal",
    reasoningItemId: "item-reasoning-after-goal",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(session);
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-submission",
      item: { type: "userMessage", clientId: "item-user-after-goal", content: [] },
    },
  });
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-submission", status: "completed" } },
  });
  await next;
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 2);
});

test("CodexAppServerThreadSession 将角色规则放入 thread/start 并保留独立的用户输入", async () => {
  const { session, requests, conversationEvents, threadHandlers } = createSendHarness(null);
  const pending = session.sendMessage({
    turnId: "turn-client-role-start" as any,
    userItemId: "item-user-role-start" as any,
    text: "任务原文",
    images: [],
    assistantItemId: "item-assistant-role-start",
    reasoningItemId: "item-reasoning-role-start",
    systemMessage: "系统规则",
    developerMessage: "角色规则和输出骨架",
    model: "gpt-5.6-luna",
  }, { conversation(event) { conversationEvents.push(event as Record<string, unknown>); }, raw() {} });

  await waitForActiveTurn(session);
  const threadStart = requests.find((request) => request.method === "thread/start");
  const turnStart = requests.find((request) => request.method === "turn/start");
  assert.ok(threadStart);
  assert.ok(turnStart);
  assert.equal(
    (threadStart.params as any).developerInstructions,
    withCodexExecutionInstructions("系统规则", "角色规则和输出骨架"),
  );
  assert.equal((turnStart.params as any).collaborationMode.settings.developer_instructions, undefined);
  assert.deepEqual((turnStart.params as any).input, [{ type: "text", text: "任务原文" }]);

  const call = conversationEvents.find((event) => event.type === "item.userMessage.engineCall.created") as any;
  assert.equal(call.payload.call.requests[0].params.developerInstructions, withCodexExecutionInstructions("系统规则", "角色规则和输出骨架"));
  threadHandlers.at(-1)!.onMessage({
    method: "turn/completed",
    params: { threadId: "session-started", turn: { id: "turn-engine", status: "completed" } },
  });
  await pending;
});

test("CodexAppServerThreadSession 在 Astra 模型切换时通过 thread/resume 重载当前角色规则", async () => {
  const { session, requests, threadHandlers } = createSendHarness("session-model-switch");
  const sendAndComplete = async (turnId: string, model: string, providerTurnId: string): Promise<void> => {
    const pending = session.sendMessage({
      turnId: `${turnId}-client` as any,
      userItemId: `${turnId}-user` as any,
      text: "任务原文",
      images: [],
      assistantItemId: `${turnId}-assistant`,
      reasoningItemId: `${turnId}-reasoning`,
      systemMessage: "系统规则",
      developerMessage: "角色规则和输出骨架",
      model,
    }, { conversation() {}, raw() {} });
    await waitForActiveTurn(session);
    threadHandlers.at(-1)!.onMessage({
      method: "turn/completed",
      params: { threadId: "session-model-switch", turn: { id: providerTurnId, status: "completed" } },
    });
    await pending;
  };

  await sendAndComplete("turn-terra", "gpt-5.6-luna", "turn-engine");
  await sendAndComplete("turn-astra", "gpt-6-astra", "turn-engine-2");

  const resumes = requests.filter((request) => request.method === "thread/resume");
  assert.equal(resumes.length, 2);
  assert.equal((resumes[1]!.params as any).developerInstructions, withCodexExecutionInstructions("系统规则", "角色规则和输出骨架"));
  const astraTurn = requests.filter((request) => request.method === "turn/start")[1]!.params as any;
  assert.equal(astraTurn.model, "gpt-6-astra");
  assert.equal(astraTurn.collaborationMode.settings.developer_instructions, undefined);
});

test("CodexAppServerThreadSession 续聊更换角色规则时重新加载并可显式清除", async () => {
  const { session, requests, threadHandlers } = createSendHarness("session-role-change");
  const sendAndComplete = async (index: number, developerMessage: string | null): Promise<void> => {
    const pending = session.sendMessage({
      turnId: `turn-role-${index}` as any,
      userItemId: `item-role-${index}` as any,
      text: "继续任务",
      images: [],
      assistantItemId: `assistant-role-${index}`,
      reasoningItemId: `reasoning-role-${index}`,
      developerMessage,
      model: "gpt-6-astra",
    }, { conversation() {}, raw() {} });
    await waitForActiveTurn(session);
    threadHandlers.at(-1)!.onMessage({
      method: "turn/completed",
      params: { threadId: "session-role-change", turn: { id: index === 1 ? "turn-engine" : `turn-engine-${index}`, status: "completed" } },
    });
    await pending;
  };

  await sendAndComplete(1, "设计角色规则");
  await sendAndComplete(2, "实现角色规则");
  await sendAndComplete(3, null);

  const resumes = requests.filter((request) => request.method === "thread/resume");
  assert.deepEqual(resumes.map((request) => (request.params as any).developerInstructions), [
    withCodexExecutionInstructions("设计角色规则"),
    withCodexExecutionInstructions("实现角色规则"),
    withCodexExecutionInstructions(null),
  ]);
});

test("CodexAppServerThreadSession cached active 不替代已有 binding 的 resume ACK", async () => {
  const { session, requests } = createSendHarness("session-demo");
  (session as any).onAppServerMessage({
    method: "thread/status/changed",
    params: { threadId: "session-demo", status: { type: "active" } },
  });
  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-stale-cached", status: "inProgress" } },
  });

  const pending = session.sendMessage({
    turnId: "turn-client-after-stale-cache" as any,
    userItemId: "item-user-after-stale-cache" as any,
    text: "fresh idle wins",
    images: [],
    assistantItemId: "item-assistant-after-stale-cache",
    reasoningItemId: "item-reasoning-after-stale-cache",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(session);
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });

  assert.deepEqual(await pending, { responseText: "" });
  assert.equal(requests.filter((request) => request.method === "thread/goal/get").length, 0);
  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
});

test("CodexAppServerThreadSession cached idle 仍先 resume 再由 turn/start 仲裁竞态", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        throw createExplicitTurnStartRejection(
          "expected active turn id turn-foreign-goal",
          "cached-idle-provider-rejection",
        );
      }
      throw new Error(`unexpected provider mutation: ${method}`);
    },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-cached-idle" as any,
    userItemId: "item-user-cached-idle" as any,
    text: "cached idle must refresh",
    images: [],
    assistantItemId: "item-assistant-cached-idle",
    reasoningItemId: "item-reasoning-cached-idle",
  }, {
    conversation() {},
    raw() {},
  }), /expected active turn id turn-foreign-goal/);

  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(requests.filter((request) => request.method === "thread/turns/list").length, 0);
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(requests.some((request) => request.method === "turn/steer"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession 普通发送不把 thread/goal/get 放入热路径", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    goalResponse: {
      goal: {
        threadId: "session-demo",
        objective: "keep monitoring",
        status: "active",
      },
    },
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        throw createExplicitTurnStartRejection(
          "expected active turn id turn-goal",
          "goal-active-provider-rejection",
        );
      }
      throw new Error(`active Goal must stop before ${method}`);
    },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-goal-gap" as any,
    userItemId: "item-user-goal-gap" as any,
    text: "must not enter Goal idle gap",
    images: [],
    assistantItemId: "item-assistant-goal-gap",
    reasoningItemId: "item-reasoning-goal-gap",
  }, {
    conversation() {},
    raw() {},
  }), /expected active turn id turn-goal/);

  assert.equal(requests.some((request) => request.method === "thread/goal/get"), false);
  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(requests.some((request) => request.method === "turn/steer"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession 发送前 lifecycle 抖动仍在 resume 后交由 turn/start 原子仲裁", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      throw new Error(`stale admission must not dispatch ${method}`);
    },
  });
  let injected = false;
  const clientTurnId = "turn-client-admission-stale" as any;

  await assert.rejects(harness.session.sendMessage({
    turnId: clientTurnId,
    userItemId: "item-user-admission-stale" as any,
    text: "foreign successor races admission",
    images: [],
    assistantItemId: "item-assistant-admission-stale",
    reasoningItemId: "item-reasoning-admission-stale",
  }, {
    conversation(event) {
      if (injected || event.type !== "item.userMessage.engineCall.created") return;
      injected = true;
      (harness.session as any).onAppServerMessage({
        method: "turn/started",
        params: { threadId: "session-demo", turn: { id: "turn-foreign-race", status: "inProgress" } },
      });
      (harness.session as any).onAppServerMessage({
        method: "turn/completed",
        params: { threadId: "session-demo", turn: { id: "turn-foreign-race", status: "completed" } },
      });
      (harness.session as any).onAppServerMessage({
        method: "thread/status/changed",
        params: { threadId: "session-demo", status: { type: "idle" } },
      });
    },
    raw() {},
  }), /stale admission must not dispatch turn\/start/);

  assert.equal(injected, true);
  assert.deepEqual(
    harness.requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.has(clientTurnId), false);
});

test("CodexAppServerThreadSession thread/resume 普通失败时保留 binding 且不追加 read 或 mutation", async () => {
  const resumeError = new Error("thread is owned by another app-server process");
  const { session, requests } = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/resume") throw resumeError;
      throw new Error(`unexpected provider mutation: ${method}`);
    },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-preflight-failed" as any,
    userItemId: "item-user-preflight-failed" as any,
    text: "preflight must fail closed",
    images: [],
    assistantItemId: "item-assistant-preflight-failed",
    reasoningItemId: "item-reasoning-preflight-failed",
  }, {
    conversation() {},
    raw() {},
  }), (error: unknown) => error === resumeError);

  assert.deepEqual(requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 0);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession resume ACK 后的 provider active 竞态由 turn/start 返回", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        throw createExplicitTurnStartRejection(
          "expected active turn id turn-live",
          "request-resume-active-race",
        );
      }
      return {};
    },
  });
  (session as any).observedProviderThreadStatus = null;
  (session as any).observedProviderActiveTurnId = null;

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-resumed" as any,
    userItemId: "item-user-resumed" as any,
    text: "恢复后继续",
    images: [],
    assistantItemId: "item-assistant-resumed",
    reasoningItemId: "item-reasoning-resumed",
  }, {
    conversation() {},
    raw() {},
  }), /expected active turn id turn-live/);

  assert.deepEqual(
    requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(requests.filter((request) => request.method === "thread/turns/list").length, 0);
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession turn/start 失效后保留 binding 且不自动重投输入", async () => {
  let turnStartCount = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/read") {
        return { thread: { id: "session-demo", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        turnStartCount += 1;
        throw createExplicitTurnStartRejection(
          "thread not found: session-demo",
          "request-turn-start-unavailable",
        );
      }
      return {};
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-resumed-retry" as any,
    userItemId: "item-user-resumed-retry" as any,
    text: "resume then retry",
    images: [],
    assistantItemId: "item-assistant-resumed-retry",
    reasoningItemId: "item-reasoning-resumed-retry",
  }, {
    conversation() {},
    raw() {},
  }), /thread not found: session-demo/);

  assert.equal(turnStartCount, 1);
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(harness.requests.filter((request) => request.method === "thread/goal/get").length, 0);
  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(harness.threadHandlers.length, 1);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal(harness.session.isRecoveryPending(), true);
});

test("CodexAppServerThreadSession turn/start 失效后的用户重试会重新 resume", async () => {
  let turnStartCount = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/read") {
        return { thread: { id: "session-demo", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        turnStartCount += 1;
        throw createExplicitTurnStartRejection(
          "thread not found: session-demo",
          `request-turn-start-retry-${turnStartCount}`,
        );
      }
      return {};
    },
  });

  const send = (suffix: string) => harness.session.sendMessage({
    turnId: `turn-client-retry-${suffix}` as any,
    userItemId: `item-user-retry-${suffix}`,
    text: `retry ${suffix}`,
    images: [],
    assistantItemId: `item-assistant-retry-${suffix}`,
    reasoningItemId: `item-reasoning-retry-${suffix}`,
  }, { conversation() {}, raw() {} });

  await assert.rejects(send("one"), /thread not found: session-demo/);
  await assert.rejects(send("two"), /thread not found: session-demo/);

  assert.equal(turnStartCount, 2);
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(harness.session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession binding 持久化冲突保留 starting fence", async () => {
  const harness = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/read") {
        return { thread: { id: "session-demo", status: { type: "idle" } } };
      }
      if (method === "turn/start") return new Promise(() => {});
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-binding-ambiguous" as any,
    userItemId: "item-user-binding-ambiguous" as any,
    text: "binding ambiguity",
    images: [],
    assistantItemId: "item-assistant-binding-ambiguous",
    reasoningItemId: "item-reasoning-binding-ambiguous",
  }, { conversation() {}, raw() {} });
  let sendSettled = false;
  void pending.then(
    () => { sendSettled = true; },
    () => { sendSettled = true; },
  );
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/start"),
    "binding ambiguity turn/start 未发出",
  );
  const starting = (harness.session as any).startingTurn;
  assert.ok(starting);
  let interruptFinalized = false;
  void starting.interruptFinalized.then(() => {
    interruptFinalized = true;
  });

  const firstError = new Error("first binding persistence failure");
  (harness.session as any).failStartingTurnBindingPersistence(
    starting,
    "provider-binding-a",
    firstError,
  );
  const secondError = (harness.session as any).failStartingTurnBindingPersistence(
    starting,
    "provider-binding-b",
    new Error("second binding persistence failure"),
  );
  await Promise.resolve();
  assert.equal(interruptFinalized, false);

  assert.equal(secondError.code, "codex_turn_ownership_ambiguous");
  assert.equal(starting.providerObservedTurnId, "provider-binding-a");
  assert.equal(starting.providerTurnId, "provider-binding-a");
  assert.equal(starting.compensatedProviderTurnIds.size, 0);
  assert.equal(sendSettled, false);
  assert.equal((harness.session as any).startingTurn, starting);
  assert.equal(harness.session.hasActiveTurn(), true);
});

test("CodexAppServerThreadSession turn/start 在途出现 foreign successor 时由 provider 冲突拒绝", async () => {
  let rejectTurnStart!: (reason: unknown) => void;
  const turnStart = new Promise((_, reject) => {
    rejectTurnStart = reject;
  });
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return await turnStart;
      return {};
    },
  });
  (harness.session as any).observedProviderThreadStatus = null;
  (harness.session as any).observedProviderActiveTurnId = null;

  const pending = harness.session.sendMessage({
    turnId: "turn-client-start-race" as any,
    userItemId: "item-user-start-race" as any,
    text: "turn/start race",
    images: [],
    assistantItemId: "item-assistant-start-race",
    reasoningItemId: "item-reasoning-start-race",
  }, {
    conversation() {},
    raw() {},
  });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/start"),
    "turn/start 未发出",
  );
  (harness.session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-live-b", status: "inProgress" } },
  });
  rejectTurnStart(createExplicitTurnStartRejection(
    "expected active turn id turn-live-b",
    "turn-start-foreign-successor",
  ));

  await assert.rejects(pending, /expected active turn id turn-live-b/);
  assert.deepEqual(
    harness.requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(harness.requests.filter((request) => request.method === "turn/start").length, 1);
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.equal((harness.session as any).observedProviderActiveTurnId, "turn-live-b");
});

test("CodexAppServerThreadSession 输入发出前结束的 provider head 不会覆盖 turn/start 响应绑定", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return { turn: { id: "turn-current" } };
      return {};
    },
  });
  let injected = false;

  const pending = harness.session.sendMessage({
    turnId: "turn-client-pre-send-terminal" as any,
    userItemId: "item-user-pre-send-terminal" as any,
    text: "pre-send terminal",
    images: [],
    assistantItemId: "item-assistant-pre-send-terminal",
    reasoningItemId: "item-reasoning-pre-send-terminal",
  }, {
    conversation(event) {
      if (injected || event.type !== "item.userMessage.engineCall.created") return;
      injected = true;
      (harness.session as any).onAppServerMessage({
        method: "turn/started",
        params: { threadId: "session-demo", turn: { id: "turn-before-input", status: "inProgress" } },
      });
      (harness.session as any).onAppServerMessage({
        method: "turn/completed",
        params: { threadId: "session-demo", turn: { id: "turn-before-input", status: "completed" } },
      });
    },
    raw() {},
  });

  await waitForActiveTurn(harness.session);
  assert.equal(injected, true);
  assert.deepEqual(
    harness.requests.slice(0, 2).map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal((harness.session as any).active.codexTurnId, "turn-current");
  assert.equal(
    (harness.session as any).codexTurnIdByClientTurnId.get("turn-client-pre-send-terminal"),
    "turn-current",
  );
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("turn-before-input"), false);
  (harness.session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-current",
      item: {
        type: "userMessage",
        id: "provider-user-current",
        clientId: "item-user-pre-send-terminal",
        content: [],
      },
    },
  });
  assert.equal((harness.session as any).active.codexTurnId, "turn-current");
  assert.equal((harness.session as any).startingTurn, null);
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-current", status: "completed" } },
  });
  await pending;
});

test("CodexAppServerThreadSession 手动中断窗口的 foreign started 不会替换已确权 ID", () => {
  const { session, conversationEvents, rawEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);
  const active = (session as any).active;
  active.codexTurnBindingSource = "start_result";
  active.manualInterruptRequested = true;
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-authoritative", status: "inProgress" } },
  });

  assert.equal(active.codexTurnId, "turn-engine");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-authoritative"), false);
  assert.equal(
    rawEvents.find((event) => (event.data as any)?.method === "turn/started")?.clientTurnId,
    undefined,
  );
  assert.deepEqual(
    conversationEvents.filter((event) => event.type === "turn.engineBound").at(-1)?.payload,
    {
      turnId: "turn-client",
      engineTurnId: "turn-engine",
      engineSessionId: "session-demo",
      previousEngineTurnId: null,
    },
  );
});

test("CodexAppServerThreadSession 中断 RPC 在途时不预绑定 foreign successor", () => {
  const { session, conversationEvents, rawEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);
  const active = (session as any).active;
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  active.interruptPromise = new Promise(() => {});

  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-successor", status: "inProgress" } },
  });

  assert.equal(active.codexTurnId, "turn-engine");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine");
  assert.deepEqual(
    conversationEvents.filter((event) => event.type === "turn.engineBound").at(-1)?.payload,
    {
      turnId: "turn-client",
      engineTurnId: "turn-engine",
      engineSessionId: "session-demo",
      previousEngineTurnId: null,
    },
  );
  assert.equal(
    rawEvents.find((event) => (event.data as any)?.method === "turn/started")?.clientTurnId,
    undefined,
  );
});

test("CodexAppServerThreadSession 连续 foreign started 只推进 live head，不改本地 ownership", () => {
  const { session, conversationEvents, rawEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);
  (session as any).active.codexTurnBindingSource = "start_result";
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  for (const providerTurnId of ["turn-live-b", "turn-live-c"]) {
    (session as any).onAppServerMessage({
      method: "turn/started",
      params: { threadId: "session-demo", turn: { id: providerTurnId, status: "inProgress" } },
    });
  }
  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "inProgress" } },
  });

  assert.equal((session as any).active.codexTurnId, "turn-engine");
  assert.equal((session as any).observedProviderActiveTurnId, "turn-live-c");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine");
  assert.deepEqual(
    conversationEvents.filter((event) => event.type === "turn.engineBound").map((event) => event.payload),
    [
      {
        turnId: "turn-client",
        engineTurnId: "turn-engine",
        engineSessionId: "session-demo",
        previousEngineTurnId: null,
      },
    ],
  );
  const startedRaw = rawEvents.filter((event) => (event.data as any)?.method === "turn/started");
  assert.deepEqual(startedRaw.map((event) => event.clientTurnId), ["turn-client"]);
});

test("CodexAppServerThreadSession 本地 idle 的长 Goal live head 单调推进且不受迟到 started 回滚", () => {
  const { session } = createSendHarness("session-demo");
  const providerTurnIds = Array.from({ length: 12 }, (_, index) => `turn-goal-${index}`);

  for (const providerTurnId of providerTurnIds) {
    (session as any).onAppServerMessage({
      method: "turn/started",
      params: { threadId: "session-demo", turn: { id: providerTurnId, status: "inProgress" } },
    });
  }
  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: providerTurnIds[0], status: "inProgress" } },
  });

  assert.equal((session as any).observedProviderActiveTurnId, providerTurnIds.at(-1));
  assert.equal((session as any).supersededProviderHeadTurnIds.has(providerTurnIds[0]), true);
  assert.equal((session as any).supersededProviderHeadTurnIds.has(providerTurnIds.at(-2)), true);
  assert.equal((session as any).retiredCodexTurnIds.has(providerTurnIds[0]), false);
});

test("CodexAppServerThreadSession 长 Goal 的真实终态 lineage 超过映射窗口后仍拒绝迟到 started", () => {
  const { session } = createSendHarness("session-demo");
  const providerTurnIds = Array.from({ length: 12 }, (_, index) => `turn-terminal-goal-${index}`);

  for (const [index, providerTurnId] of providerTurnIds.entries()) {
    (session as any).onAppServerMessage({
      method: "turn/started",
      params: { threadId: "session-demo", turn: { id: providerTurnId, status: "inProgress" } },
    });
    if (index === providerTurnIds.length - 1) continue;
    (session as any).onAppServerMessage(index % 2 === 0
      ? {
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: providerTurnId, status: "completed" } },
        }
      : {
          method: "turn/status/changed",
          params: { threadId: "session-demo", turnId: providerTurnId, status: { type: "interrupted" } },
        });
  }

  (session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: providerTurnIds[0], status: "inProgress" } },
  });
  (session as any).onAppServerMessage({
    method: "error",
    params: {
      turnId: providerTurnIds.at(-1),
      willRetry: true,
      error: { message: "retrying provider stream" },
    },
  });

  assert.equal((session as any).observedProviderActiveTurnId, providerTurnIds.at(-1));
  assert.equal((session as any).terminalObservedProviderTurnStatusById.has(providerTurnIds[0]), true);
  assert.equal((session as any).terminalObservedProviderTurnStatusById.has(providerTurnIds.at(-1)), false);
});

test("CodexAppServerThreadSession 已终态映射按关联刷新 LRU 且 tombstone 不被淘汰", () => {
  const { session } = createSendHarness("session-demo");
  const bindRetired = (index: number) => {
    const clientTurnId = `turn-client-retired-${index}`;
    const providerTurnId = `turn-provider-retired-${index}`;
    (session as any).bindCodexTurn(clientTurnId, providerTurnId);
    (session as any).retireProviderTurnId(providerTurnId);
  };

  for (let index = 0; index < 10; index += 1) bindRetired(index);
  bindRetired(0);
  bindRetired(10);

  assert.equal((session as any).retiredCodexTurnMappingOrder.length, 8);
  assert.equal((session as any).clientTurnIdByCodexTurnId.size, 8);
  assert.equal((session as any).clientTurnIdByCodexTurnId.get("turn-provider-retired-0"), "turn-client-retired-0");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-provider-retired-2"), false);
  assert.equal((session as any).retiredCodexTurnIds.has("turn-provider-retired-2"), true);
});

test("CodexAppServerThreadSession handoff 前连续 foreign started 与 clientId 回显不覆盖响应 ID", async () => {
  let resolveTurnStart!: (value: unknown) => void;
  const turnStart = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return await turnStart;
      return {};
    },
  });

  const pending = session.sendMessage({
    turnId: "turn-client-handoff" as any,
    userItemId: "item-user-handoff" as any,
    text: "handoff lineage",
    images: [],
    assistantItemId: "item-assistant-handoff",
    reasoningItemId: "item-reasoning-handoff",
  }, {
    conversation() {},
    raw() {},
  });
  await flushMicrotasksUntil(
    () => requests.some((request) => request.method === "turn/start"),
    "turn/start 未发出",
  );
  for (const providerTurnId of ["turn-live-a", "turn-live-b", "turn-live-c"]) {
    (session as any).onAppServerMessage({
      method: "turn/started",
      params: { threadId: "session-demo", turn: { id: providerTurnId, status: "inProgress" } },
    });
  }
  resolveTurnStart({ turn: { id: "turn-submission" } });
  await waitForActiveTurn(session);

  assert.equal((session as any).active.codexTurnId, "turn-submission");
  assert.equal((session as any).observedProviderActiveTurnId, "turn-live-c");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client-handoff"), "turn-submission");
  assert.equal((session as any).clientTurnIdByCodexTurnId.get("turn-submission"), "turn-client-handoff");

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-live-a",
      item: {
        type: "userMessage",
        id: "provider-user-handoff",
        clientId: "item-user-handoff",
        content: [],
      },
    },
  });
  assert.equal((session as any).active.codexTurnId, "turn-submission");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client-handoff"), "turn-submission");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-live-a"), false);

  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-submission", status: "completed" } },
  });
  await pending;
});

test("CodexAppServerThreadSession 多个 foreign clientId 回显不覆盖 turn/start 响应", async () => {
  let bindingDropCalls = 0;
  const harness = createSendHarness("session-demo", {
    onSessionBindingDropped() {
      bindingDropCalls += 1;
    },
    request(method) {
      if (method === "turn/start") return Promise.resolve({ turn: { id: "provider-active-response" } });
      if (method === "thread/turns/list") throw new Error("普通 start 不应扫描 ownership 历史");
      return Promise.resolve({});
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-active-conflict" as any,
    userItemId: "item-user-active-conflict" as any,
    text: "active ownership conflict",
    images: [],
    assistantItemId: "item-assistant-active-conflict",
    reasoningItemId: "item-reasoning-active-conflict",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  assert.equal((harness.session as any).active.codexTurnId, "provider-active-response");
  assert.equal((harness.session as any).active.codexTurnBindingSource, "start_result");
  const handler = harness.threadHandlers[0]!.onMessage;
  const echo = (providerTurnId: string) => ({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: providerTurnId,
      item: { type: "userMessage", clientId: "item-user-active-conflict", content: [] },
    },
  });
  handler(echo("provider-active-a"));
  handler(echo("provider-active-b"));

  assert.equal((harness.session as any).active.codexTurnId, "provider-active-response");
  assert.equal(
    (harness.session as any).codexTurnIdByClientTurnId.get("turn-client-active-conflict"),
    "provider-active-response",
  );
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("provider-active-a"), false);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has("provider-active-b"), false);
  assert.equal(bindingDropCalls, 0);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);

  handler({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: { id: "provider-active-response", status: "completed" },
    },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession turn/start unavailable 后不自动重投 mutation", async () => {
  let turnStartCount = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "thread/read") {
        return { thread: { id: "session-demo", status: { type: "idle" } } };
      }
      if (method === "turn/start") {
        turnStartCount += 1;
        throw new Error("thread not found: session-demo");
      }
      return {};
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-second-unavailable" as any,
    userItemId: "item-user-second-unavailable" as any,
    text: "retry same provider thread only",
    images: [],
    assistantItemId: "item-assistant-second-unavailable",
    reasoningItemId: "item-reasoning-second-unavailable",
  }, { conversation() {}, raw() {} }), /thread not found: session-demo/);

  assert.equal(turnStartCount, 1);
  assert.equal(harness.requests.filter((request) => request.method === "thread/resume").length, 1);
  assert.equal(harness.requests.filter((request) => request.method === "thread/read").length, 0);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(harness.threadHandlers.length, 1);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.session.isRecoveryPending(), true);
});

test("CodexAppServerThreadSession resume ACK 超时时不追加 read 且不发送输入", async () => {
  let resumeCount = 0;
  const resumeError = Object.assign(new Error("Codex app-server request timeout: thread/resume"), {
    code: "codex_app_server_request_timeout",
    method: "thread/resume",
  });
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") {
        resumeCount += 1;
        throw resumeError;
      }
      assert.fail(`恢复未确认后不得发送 provider mutation：${method}`);
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-resume-timeout" as any,
    userItemId: "item-user-resume-timeout" as any,
    text: "resume timeout must use read truth",
    images: [],
    assistantItemId: "item-assistant-resume-timeout",
    reasoningItemId: "item-reasoning-resume-timeout",
  }, { conversation() {}, raw() {} }), (error: unknown) => error === resumeError);

  assert.equal(resumeCount, 1);
  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(harness.requests.some((request) => request.method === "turn/start"), false);
  assert.equal(harness.session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession resume 返回 systemError 后直接启动下一回合", async () => {
  let sessionRef!: CodexAppServerThreadSession;
  const harness = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/resume") {
        return { thread: { id: "session-demo", status: { type: "systemError" } } };
      }
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "item/started",
          params: {
            threadId: "session-demo",
            turnId: "turn-after-system-error",
            item: {
              type: "userMessage",
              id: "provider-user-after-system-error",
              clientId: "item-user-after-system-error",
              content: [],
            },
          },
        });
        return { turn: { id: "turn-after-system-error" } };
      }
      return {};
    },
  });
  sessionRef = harness.session;

  const pending = harness.session.sendMessage({
    turnId: "turn-client-after-system-error" as any,
    userItemId: "item-user-after-system-error" as any,
    text: "从刚才中断的位置继续",
    images: [],
    assistantItemId: "item-assistant-after-system-error",
    reasoningItemId: "item-reasoning-after-system-error",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-after-system-error", status: "completed" } },
  });
  await pending;

  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.session.isRecoveryPending(), false);
});

test("CodexAppServerThreadSession systemError 后 turn/start 普通失败不会自动重投", async () => {
  let turnStartCount = 0;
  let sessionRef!: CodexAppServerThreadSession;
  const harness = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    async request(method, params: any) {
      if (method === "thread/resume") {
        return { thread: { id: "session-demo", status: { type: "systemError" } } };
      }
      if (method === "turn/start") {
        turnStartCount += 1;
        if (turnStartCount === 1) {
          throw createExplicitTurnStartRejection(
            "temporary turn/start rejection",
            "system-error-turn-start-rejection",
          );
        }
        (sessionRef as any).onAppServerMessage({
          method: "item/started",
          params: {
            threadId: "session-demo",
            turnId: "turn-after-system-error-retry",
            item: {
              type: "userMessage",
              id: "provider-user-after-system-error-retry",
              clientId: params?.clientUserMessageId,
              content: [],
            },
          },
        });
        return { turn: { id: "turn-after-system-error-retry" } };
      }
      return {};
    },
  });
  sessionRef = harness.session;

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-system-error-first" as any,
    userItemId: "item-user-system-error-first" as any,
    text: "第一次继续",
    images: [],
    assistantItemId: "item-assistant-system-error-first",
    reasoningItemId: "item-reasoning-system-error-first",
  }, { conversation() {}, raw() {} }), /temporary turn\/start rejection/);
  assert.equal(harness.session.isRecoveryPending(), false);

  const pending = harness.session.sendMessage({
    turnId: "turn-client-system-error-retry" as any,
    userItemId: "item-user-system-error-retry" as any,
    text: "再次继续",
    images: [],
    assistantItemId: "item-assistant-system-error-retry",
    reasoningItemId: "item-reasoning-system-error-retry",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-after-system-error-retry", status: "completed" } },
  });
  await pending;

  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/resume", "turn/start", "turn/start"],
  );
  assert.equal(turnStartCount, 2);
  assert.equal(harness.session.isRecoveryPending(), false);
});

test("CodexAppServerThreadSession systemError 后 turn/start unavailable 会恢复下次 resume 门禁", async () => {
  let turnStartCount = 0;
  const harness = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/resume") {
        return { thread: { id: "session-demo", status: { type: "systemError" } } };
      }
      if (method === "turn/start") {
        turnStartCount += 1;
        throw new Error("thread not found: session-demo");
      }
      return {};
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-system-error-unavailable" as any,
    userItemId: "item-user-system-error-unavailable" as any,
    text: "继续原回合",
    images: [],
    assistantItemId: "item-assistant-system-error-unavailable",
    reasoningItemId: "item-reasoning-system-error-unavailable",
  }, { conversation() {}, raw() {} }), /thread not found: session-demo/);

  assert.equal(turnStartCount, 1);
  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.session.isRecoveryPending(), true);
});

test("CodexAppServerThreadSession resume 失败不清理 binding 或创建替代会话", async () => {
  let dropped = 0;
  const resumeError = Object.assign(new Error("Codex app-server request timeout: thread/resume"), {
    code: "codex_app_server_request_timeout",
    method: "thread/resume",
  });
  const harness = createSendHarness("session-demo", {
    passthroughProviderPreflight: true,
    onSessionBindingDropped() {
      dropped += 1;
    },
    async request(method, params: any) {
      if (method === "thread/resume") {
        assert.equal(params?.threadId, "session-demo");
        throw resumeError;
      }
      assert.fail(`恢复未确认后不得发送 provider mutation：${method}`);
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-resume-read-timeout" as any,
    userItemId: "item-user-resume-read-timeout" as any,
    text: "resume and read timeout",
    images: [],
    assistantItemId: "item-assistant-resume-read-timeout",
    reasoningItemId: "item-reasoning-resume-read-timeout",
  }, { conversation() {}, raw() {} }), (error: unknown) => error === resumeError);

  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(dropped, 0);
  assert.equal(harness.session.getSessionId(), "session-demo");
});

test("resumeCodexProviderThreadForRead 在 resume 失败后仍以同 ID read 为准", async () => {
  const resumeError = new Error("thread/resume unavailable");
  const read = { thread: { id: "session-demo" } };
  const requests: Array<{ method: string; params: unknown; options: unknown }> = [];
  const requester = {
    async request(method: string, params?: unknown, options?: unknown) {
      requests.push({ method, params, options });
      if (method === "thread/resume") throw resumeError;
      if (method === "thread/read") return read;
      assert.fail(`只读恢复不得发送其他 RPC：${method}`);
    },
  };

  assert.equal(
    await resumeCodexProviderThreadForRead(requester, "session-demo" as any),
    read,
  );
  assert.deepEqual(requests, [
    {
      method: "thread/resume",
      params: { threadId: "session-demo" },
      options: { timeoutMs: 180_000, trackLateSettlement: true },
    },
    {
      method: "thread/read",
      params: { threadId: "session-demo", includeTurns: false },
      options: { timeoutMs: 180_000, trackLateSettlement: true },
    },
  ]);
});

test("resumeCodexProviderThreadForRead 按请求读取 turns 且不校验 status", async () => {
  const read = { thread: { id: "session-demo", status: { type: "notLoaded" } } };
  const requests: Array<{ method: string; params: unknown }> = [];
  const requester = {
    async request(method: string, params?: unknown) {
      requests.push({ method, params });
      if (method === "thread/resume") return {};
      if (method === "thread/read") return read;
      assert.fail(`只读恢复不得发送其他 RPC：${method}`);
    },
  };

  assert.equal(
    await resumeCodexProviderThreadForRead(requester, "session-demo" as any, { includeTurns: true }),
    read,
  );
  assert.deepEqual(requests.map((request) => request.params), [
    { threadId: "session-demo" },
    { threadId: "session-demo", includeTurns: true },
  ]);
});

test("resumeCodexProviderThreadForRead 显式拒绝错误 thread ID", async () => {
  const requester = {
    async request(method: string) {
      if (method === "thread/resume") return {};
      if (method === "thread/read") return { thread: { id: "session-other" } };
      assert.fail(`只读恢复不得发送其他 RPC：${method}`);
    },
  };

  await assert.rejects(
    resumeCodexProviderThreadForRead(requester, "session-demo" as any),
    (error: any) => (
      error?.code === "codex_thread_resume_unconfirmed"
      && error?.providerThreadId === "session-demo"
      && error?.reason === "thread_identity_mismatch_after_resume"
      && error?.preserveBinding === true
    ),
  );
});

test("resumeCodexProviderThreadForRead 的 resume/read 双失败保留两个 cause", async () => {
  const resumeError = new Error("thread/resume unavailable");
  const readError = new Error("thread/read unavailable");
  const requester = {
    async request(method: string) {
      if (method === "thread/resume") throw resumeError;
      if (method === "thread/read") throw readError;
      assert.fail(`只读恢复不得发送其他 RPC：${method}`);
    },
  };

  await assert.rejects(
    resumeCodexProviderThreadForRead(requester, "session-demo" as any),
    (error: any) => (
      error?.code === "codex_thread_resume_unconfirmed"
      && error?.providerThreadId === "session-demo"
      && error?.reason === "read_failed_after_resume"
      && error?.preserveBinding === true
      && error?.cause?.resumeCause === resumeError
      && error?.cause?.cause === readError
    ),
  );
});

for (const scenario of [
  {
    name: "active",
    resume: { thread: { id: "session-demo", status: { type: "active" } } },
    providerError: "expected active turn id turn-live",
    recoveryPending: false,
  },
  {
    name: "notLoaded",
    resume: { thread: { id: "session-demo", status: { type: "notLoaded" } } },
    providerError: "thread not found: session-demo",
    recoveryPending: true,
  },
] as const) {
  test(`CodexAppServerThreadSession resume ACK 为 ${scenario.name} 时由 turn/start 原子裁决`, async () => {
    let observerRegisteredBeforeResume = false;
    let turnStartCount = 0;
    let harness!: ReturnType<typeof createSendHarness>;
    harness = createSendHarness("session-demo", {
      passthroughProviderPreflight: true,
      async request(method) {
        if (method === "thread/resume") {
          observerRegisteredBeforeResume = harness.threadHandlers.length === 1;
          return scenario.resume;
        }
        if (method === "turn/start") {
          turnStartCount += 1;
          throw new Error(scenario.providerError);
        }
        assert.fail(`普通发送不得调用额外 RPC：${method}`);
      },
    });

    await assert.rejects(harness.session.sendMessage({
      turnId: `turn-client-${scenario.name}` as any,
      userItemId: `item-user-${scenario.name}` as any,
      text: `resume read ${scenario.name}`,
      images: [],
      assistantItemId: `item-assistant-${scenario.name}`,
      reasoningItemId: `item-reasoning-${scenario.name}`,
    }, { conversation() {}, raw() {} }), new RegExp(scenario.providerError.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    assert.equal(observerRegisteredBeforeResume, true);
    assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
    assert.equal(turnStartCount, 1);
    assert.equal(harness.session.getSessionId(), "session-demo");
    assert.equal(harness.threadHandlers.length, 1);
    assert.equal(harness.session.isRecoveryPending(), scenario.recoveryPending);
  });
}

test("CodexAppServerThreadSession resume ACK 内容不参与发送前裁决", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") {
        return { thread: { id: "session-other", status: { type: "idle" } } };
      }
      if (method === "turn/start") return { turn: { id: "turn-after-resume" } };
      assert.fail(`恢复发送链不得调用额外方法：${method}`);
    },
  });

  const pending = harness.session.sendMessage({
    turnId: "turn-client-wrong-id" as any,
    userItemId: "item-user-wrong-id" as any,
    text: "resume wrong id",
    images: [],
    assistantItemId: "item-assistant-wrong-id",
    reasoningItemId: "item-reasoning-wrong-id",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  await completePendingSend(harness.session);
  await pending;

  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal(harness.session.isRecoveryPending(), false);
});

test("CodexAppServerThreadSession 迟到旧 provider turn 保留原 owner 且不终止当前 turn", async () => {
  const harness = createSendHarness("session-demo");
  const pending = harness.session.sendMessage({
    turnId: "turn-client-provider-binding-conflict" as any,
    userItemId: "item-user-provider-binding-conflict" as any,
    text: "provider turn binding conflict",
    images: [],
    assistantItemId: "item-assistant-provider-binding-conflict",
    reasoningItemId: "item-reasoning-provider-binding-conflict",
  }, {
    conversation() {},
    raw(event) { harness.rawEvents.push(event as any); },
  });
  await waitForActiveTurn(harness.session);

  const active = (harness.session as any).active;
  assert.ok(active);
  assert.equal(active.codexTurnId, "turn-engine");
  (harness.session as any).bindCodexTurn("turn-client-provider-binding-old", "provider-binding-old");

  harness.threadHandlers[0]!.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "provider-binding-old",
      item: {
        type: "userMessage",
        clientId: "item-user-provider-binding-conflict",
        content: [],
      },
    },
  });
  harness.threadHandlers[0]!.onMessage({
    method: "item/agentMessage/delta",
    params: {
      threadId: "session-demo",
      turnId: "provider-binding-old",
      itemId: "provider-old-assistant",
      delta: "late old output",
    },
  });

  assert.equal((harness.session as any).active, active);
  assert.equal(active.codexTurnId, "turn-engine");
  assert.equal(
    (harness.session as any).clientTurnIdByCodexTurnId.get("provider-binding-old"),
    "turn-client-provider-binding-old",
  );
  assert.equal(
    (harness.session as any).codexTurnIdByClientTurnId.get("turn-client-provider-binding-conflict"),
    "turn-engine",
  );
  assert.equal(
    harness.rawEvents.some((event) => (
      (event as any).data?.method === "item/started"
      && event.clientTurnId === "turn-client-provider-binding-old"
      && event.action === "ignored"
    )),
    true,
  );
  assert.equal(
    harness.rawEvents.some((event) => (
      (event as any).data?.method === "item/agentMessage/delta"
      && event.clientTurnId === "turn-client-provider-binding-old"
      && event.action === "ignored"
    )),
    true,
  );
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
  await completePendingSend(harness.session);
  await pending;
});

test("CodexAppServerThreadSession detached mutation fence 不阻断新的 resume 和 turn/start", async () => {
  const harness = createSendHarness("session-demo");
  (harness.session as any).pendingInterruptedStartingTurns.set("turn-client-fence", {
    clientTurnId: "turn-client-fence",
    providerThreadId: "session-demo",
  });

  const pending = harness.session.sendMessage({
    turnId: "turn-client-fence-retry" as any,
    userItemId: "item-user-fence-retry" as any,
    text: "continue after detached fence",
    images: [],
    assistantItemId: "item-assistant-fence-retry",
    reasoningItemId: "item-reasoning-fence-retry",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  harness.threadHandlers.find((handler) => handler.threadId === "session-demo")!.onMessage({
    method: "turn/completed",
    params: {
      threadId: "session-demo",
      turn: { id: "turn-engine", status: "completed" },
    },
  });
  await pending;

  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has("turn-client-fence"), true);
  (harness.session as any).pendingInterruptedStartingTurns.delete("turn-client-fence");
});

test("CodexAppServerThreadSession turn/start pending 时同 clientId A/B 回显不覆盖响应 ID", async () => {
  for (const providerTurnIds of [["turn-live-a", "turn-live-b"], ["turn-live-b", "turn-live-a"]]) {
    let resolveTurnStart!: (value: unknown) => void;
    const harness = createSendHarness("session-demo", {
      request(method) {
        if (method === "turn/start") {
          return new Promise((resolve) => {
            resolveTurnStart = resolve;
          });
        }
        return Promise.resolve({});
      },
    });
    const pending = harness.session.sendMessage({
      turnId: "turn-client-live-conflict" as any,
      userItemId: "item-user-live-conflict" as any,
      text: "live ownership conflict",
      images: [],
      assistantItemId: "item-assistant-live-conflict",
      reasoningItemId: "item-reasoning-live-conflict",
    }, {
      conversation(event) {
        harness.conversationEvents.push(event as Record<string, unknown>);
      },
      raw(event) {
        harness.rawEvents.push(event as Record<string, unknown>);
      },
    });
    while (!resolveTurnStart || !harness.threadHandlers[0]) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    for (const providerTurnId of providerTurnIds) {
      harness.threadHandlers[0]!.onMessage({
        method: "item/started",
        params: {
          threadId: "session-demo",
          turnId: providerTurnId,
          item: {
            type: "userMessage",
            id: `provider-user-${providerTurnId}`,
            clientId: "item-user-live-conflict",
            content: [],
          },
        },
      });
    }
    assert.equal((harness.session as any).codexTurnIdByClientTurnId.has("turn-client-live-conflict"), false);
    assert.equal(harness.conversationEvents.some((event) => event.type === "turn.engineBound"), false);

    resolveTurnStart({ turn: { id: "turn-response" } });
    await waitForActiveTurn(harness.session);
    assert.equal((harness.session as any).active.codexTurnId, "turn-response");
    assert.equal((harness.session as any).active.codexTurnBindingSource, "start_result");
    assert.equal(
      (harness.session as any).codexTurnIdByClientTurnId.get("turn-client-live-conflict"),
      "turn-response",
    );
    assert.equal(
      (harness.session as any).clientTurnIdByCodexTurnId.get("turn-response"),
      "turn-client-live-conflict",
    );
    assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has(providerTurnIds[0]), false);
    assert.equal((harness.session as any).clientTurnIdByCodexTurnId.has(providerTurnIds[1]), false);
    assert.deepEqual(
      harness.conversationEvents
        .filter((event) => event.type === "turn.engineBound")
        .map((event) => (event as any).payload.engineTurnId),
      ["turn-response"],
    );
    assert.equal(harness.session.getSessionId(), "session-demo");
    assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
    assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);

    harness.threadHandlers[0]!.onMessage({
      method: "turn/completed",
      params: { threadId: "session-demo", turn: { id: "turn-response", status: "completed" } },
    });
    assert.deepEqual(await pending, { responseText: "" });
  }
});

test("CodexAppServerThreadSession turn/steer 直接采用响应 ID 且回显保持幂等", async () => {
  const { session, requests, conversationEvents } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/steer") return { turn: { id: "turn-engine-steered" } };
      return {};
    },
  });
  primeActiveCodexTurn(session);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  await session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-steered" as any,
    text: "继续处理",
    images: [],
  });

  const steerRequest = requests.find((request) => request.method === "turn/steer");
  assert.equal((steerRequest?.params as any)?.expectedTurnId, "turn-engine");
  assert.equal((steerRequest?.params as any)?.clientUserMessageId, "item-user-steered");
  assert.equal((session as any).active.codexTurnId, "turn-engine-steered");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine-steered");
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-engine-steered",
      item: {
        type: "userMessage",
        id: "provider-user-steered",
        clientId: "item-user-steered",
        content: [],
      },
    },
  });
  assert.equal((session as any).active.codexTurnId, "turn-engine-steered");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine-steered");
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("turn-engine"), false);
  assert.equal((session as any).clientTurnIdByCodexTurnId.get("turn-engine-steered"), "turn-client");
  assert.equal((session as any).retiredCodexTurnIds.has("turn-engine"), true);
  assert.deepEqual(
    conversationEvents.filter((event) => event.type === "turn.engineBound").map((event) => event.payload),
    [
      {
        turnId: "turn-client",
        engineTurnId: "turn-engine",
        engineSessionId: "session-demo",
        previousEngineTurnId: null,
      },
      {
        turnId: "turn-client",
        engineTurnId: "turn-engine-steered",
        engineSessionId: "session-demo",
        previousEngineTurnId: "turn-engine",
      },
    ],
  );
});

test("CodexAppServerThreadSession 连续 steer 采用最新响应 ID 且迟到 echo 不会回滚", async () => {
  const { session } = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "turn/steer") {
        const clientId = String((params as any)?.clientUserMessageId ?? "");
        return { turn: { id: clientId === "item-user-b" ? "turn-b-response" : "turn-c-response" } };
      }
      return {};
    },
  });
  primeActiveCodexTurn(session);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  await session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-b" as any,
    text: "steer B",
    images: [],
  });
  await session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-c" as any,
    text: "steer C",
    images: [],
  });

  for (const [clientId, providerTurnId] of [
    ["item-user-c", "turn-c"],
    ["item-user-b", "turn-b"],
  ] as const) {
    (session as any).onAppServerMessage({
      method: "item/started",
      params: {
        threadId: "session-demo",
        turnId: providerTurnId,
        item: { type: "userMessage", id: `provider-${clientId}`, clientId, content: [] },
      },
    });
  }

  assert.equal((session as any).active.codexTurnId, "turn-c-response");
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-c-response");
});

test("CodexAppServerThreadSession steer 明确失败后清理 clientId 关联", async () => {
  const { session } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/steer") throw new Error("turn/steer rejected");
      return {};
    },
  });
  primeActiveCodexTurn(session);

  await assert.rejects(session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-failed" as any,
    text: "失败 steer",
    images: [],
  }), /turn\/steer rejected/);

  assert.equal((session as any).active.clientUserMessageIds.has("item-user-failed"), false);
  assert.equal(
    Array.from((session as any).pendingSteerCorrelationsByProviderClientKey.values())
      .some((correlation: any) => correlation.clientUserMessageId === "item-user-failed"),
    false,
  );
});

test("CodexAppServerThreadSession append ensureStarted 在途时停止不会再发送 steer", async () => {
  let releaseEnsureStarted!: () => void;
  const ensureStarted = new Promise<void>((resolve) => {
    releaseEnsureStarted = resolve;
  });
  const { session, requests } = createSendHarness("session-demo", {
    ensureStarted: async () => await ensureStarted,
    async request(method) {
      if (method === "turn/interrupt") return {};
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-engine", status: "interrupted" }], nextCursor: null };
      }
      return {};
    },
  });
  primeActiveCodexTurn(session);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");

  const pendingAppend = session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-racing-stop" as any,
    text: "stop while ensureStarted",
    images: [],
  });
  await Promise.resolve();
  const pendingInterrupt = session.interrupt("turn-client" as any);
  releaseEnsureStarted();

  await assert.rejects(
    pendingAppend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE,
  );
  assert.equal(await pendingInterrupt, true);
  assert.equal(requests.some((request) => request.method === "turn/steer"), false);
  assert.equal((session as any).pendingSteerCorrelationsByProviderClientKey.size, 0);
});

test("CodexAppServerThreadSession steer 响应 ID 后停止只中断该 ID 且不扫描历史", async () => {
  const interruptedTurnIds: string[] = [];
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/steer") return { turn: { id: "turn-b-response" } };
      if (method === "turn/interrupt") {
        interruptedTurnIds.push(String((params as any)?.turnId ?? ""));
        return {};
      }
      assert.fail(`steer 响应 ID 已确权后不得读取历史：${method}`);
    },
  });
  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-b" as any,
    text: "steer B",
    images: [],
  });

  assert.equal(await harness.session.interrupt("turn-client" as any), true);
  assert.deepEqual(interruptedTurnIds, ["turn-b-response"]);
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/steer", "turn/interrupt"]);
  assert.equal(
    Array.from((harness.session as any).pendingSteerCorrelationsByProviderClientKey.values())
      .some((correlation: any) => correlation.clientUserMessageId === "item-user-b"),
    false,
  );
});

test("CodexAppServerThreadSession steer 在途时旧 turn 终态先恢复最新 clientId ownership", async () => {
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list") {
        return {
          data: [{
            id: "turn-b",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-b" }],
          }],
        };
      }
      return {};
    },
  });
  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-b" as any,
    text: "steer B",
    images: [],
  });

  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  await flushMicrotasksUntil(
    () => (harness.session as any).active.codexTurnId === "turn-b",
    "pending steer ownership 未从历史恢复",
  );
  assert.equal(harness.getResolved(), null);

  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-b", status: "completed" } },
  });
  assert.notEqual(harness.getResolved(), null);
});

test("CodexAppServerThreadSession steer 恢复在途时会继续恢复更新的 clientId", async () => {
  let resolveFirstRecovery!: (value: unknown) => void;
  const firstRecovery = new Promise((resolve) => {
    resolveFirstRecovery = resolve;
  });
  let recoveryCalls = 0;
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/steer") return {};
      if (method === "thread/turns/list") {
        recoveryCalls += 1;
        if (recoveryCalls === 1) return await firstRecovery;
        return {
          data: [{
            id: "turn-c",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-c" }],
          }],
        };
      }
      return {};
    },
  });
  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-b" as any,
    text: "steer B",
    images: [],
  });
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  await flushMicrotasksUntil(() => recoveryCalls === 1, "B ownership recovery 未进入 pending");

  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-c" as any,
    text: "steer C",
    images: [],
  });
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  resolveFirstRecovery({
    data: [{
      id: "turn-b",
      status: "inProgress",
      items: [{ type: "userMessage", clientId: "item-user-b" }],
    }],
  });

  await flushMicrotasksUntil(
    () => (harness.session as any).active.codexTurnId === "turn-c",
    "C ownership 未在 B recovery 完成后继续恢复",
  );
  assert.equal(recoveryCalls, 2);
  assert.equal((harness.session as any).active.confirmedClientUserMessageSequence, 2);
  assert.equal((harness.session as any).pendingSteerCorrelationsByProviderClientKey.size, 0);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession steer 响应缺少 turnId 时停止保留 active 且不扫描历史", async () => {
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/steer") return {};
      assert.fail(`steer 响应缺少 turnId 时不得猜测 provider 状态：${method}`);
    },
  });
  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-b" as any,
    text: "steer B",
    images: [],
  });
  (harness.session as any).active.codexTurnId = null;

  const error = await harness.session.interrupt("turn-client" as any).then(
    () => assert.fail("缺少精确 steer turnId 时不得伪造中断成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );
  assert.equal(error.code, "codex_turn_interrupt_state_unknown");
  assert.equal(error.preserveRunningState, true);
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/steer"]);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 忽略缺少 turnId 且不属于当前 tracked item 的 assistant 事件", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");

  (session as any).assistantLifecycle.startTurn("turn-client-2" as any);
  (session as any).active = {
    clientTurnId: "turn-client-2",
    clientUserMessageIds: new Set(["item-user-turn-client-2"]),
    codexTurnId: "turn-engine-2",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      item: {
        type: "agentMessage",
        id: "msg-without-turn-id",
        phase: "commentary",
      },
    },
  });

  assert.equal(conversationEvents.length, 0);
  assert.equal((session as any).assistantLifecycle.get("msg-without-turn-id"), null);
});

test("CodexAppServerThreadSession 在真实 mapper 路径上按最后 authoritative completed 裁决同 phase assistant", () => {
  const { session } = createSendHarness("session-demo");

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-a", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-b", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-b", text: "second final", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-a", text: "first final", phase: "final_answer" } },
  });

  assert.equal((session as any).assistantLifecycle.latestText("turn-client" as any), "first final");
});

test("CodexAppServerThreadSession 在真实 mapper 路径上不会让 completed assistant 再被迟到 started/delta 改回去", () => {
  const { session } = createSendHarness("session-demo");

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-immutable", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-immutable", text: "final text", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-immutable", phase: "commentary" } },
  });
  (session as any).onAppServerMessage({
    method: "item/agentMessage/delta",
    params: { turn_id: "turn-engine", itemId: "msg-immutable", delta: " stale delta" },
  });

  const record = (session as any).assistantLifecycle.get("msg-immutable");
  assert.equal(record?.text, "final text");
  assert.equal(record?.phase, "final_answer");
  assert.equal(record?.completed, true);
});

test("CodexAppServerThreadSession duplicate started 不会在 completion 前把同一 item 的 phase 降级", async () => {
  const { session } = createSendHarness("session-demo");

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).bindCodexTurn("turn-client" as any, "turn-engine");
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };

  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-phase", phase: "final_answer" } },
  });
  (session as any).onAppServerMessage({
    method: "item/started",
    params: { turn_id: "turn-engine", item: { type: "agentMessage", id: "msg-phase", phase: "commentary" } },
  });
  (session as any).onAppServerMessage({
    method: "item/agentMessage/delta",
    params: { turn_id: "turn-engine", itemId: "msg-phase", delta: "partial text" },
  });

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "error",
  });

  assert.equal((reconciled.events[0] as any)?.payload.phase, "final_answer");
});

test("resolveApprovalPolicy keeps read-only orchestration turns on auto-approve while current stays on-request", () => {
  assert.equal(resolveApprovalPolicy("read-only"), "never");
  assert.equal(resolveApprovalPolicy("full-access"), "never");
  assert.equal(resolveApprovalPolicy("current"), "on-request");
});

test("buildTurnStartParams keeps read-only sandbox but no longer asks for approval", () => {
  const params = buildTurnStartParams({
    threadId: "thread-demo",
    cwd: "Z:/code/test-role",
    text: "列出当前工作区文件",
    images: [],
    accessMode: "read-only",
  });

  assert.equal(params.approvalPolicy, "never");
  assert.deepEqual(params.sandboxPolicy, { type: "readOnly" });
  assert.equal(params.serviceTier, null);
});

test("buildTurnStartParams forwards Codex Fast service tier", () => {
  const params = buildTurnStartParams({
    threadId: "thread-demo",
    cwd: "Z:/code/test-role",
    text: "run fast",
    images: [],
    accessMode: "current",
    serviceTier: "fast",
  });

  assert.equal(params.serviceTier, "fast");
});

test("findCodexTurnIdFromHistory prefers provider lifecycle turn id over stale token usage", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-codex-turn-history-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "client.db") });
  try {
    const workspaceId = "client-a:ws-demo" as any;
    const threadId = "thread-demo" as any;
    const clientTurnId = "turn-client" as any;
    const now = Date.now();

    db.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "tmp" });
    db.conversationEvents.appendEnvelope({
      schema: 1,
      seq: 100,
      ts: now,
      workspaceId,
      threadId,
      engine: "codex",
      type: "turn.started",
      payload: { turnId: clientTurnId },
    });
    db.turns.insertStarted({
      workspaceId,
      threadId,
      engine: "codex",
      turnId: clientTurnId,
      startedAt: now,
      startEventSeq: 100,
    });

    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 101,
      ts: now + 1,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      data: {
        method: "thread/tokenUsage/updated",
        params: { threadId: "provider-thread", turnId: "stale-provider-turn", tokenUsage: { inputTokens: 1 } },
      },
      handled: true,
      action: "ignored",
      emittedTypes: [],
    });
    db.rawEvents.appendEnvelope({
      schema: 1,
      seq: 102,
      ts: now + 2,
      workspaceId,
      threadId,
      engine: "codex",
      source: "codex.app-server.msg",
      clientTurnId,
      data: {
        method: "turn/started",
        params: { threadId: "provider-thread", turn: { id: "provider-turn", status: "inProgress" } },
      },
      handled: true,
      action: "ignored",
      emittedTypes: [],
    });

    assert.equal(findCodexTurnIdFromHistory(db, { threadId, clientTurnId }), "provider-turn");
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

/** 构造真实 send/finalizer 测试环境，并记录 provider 请求与事件。 */
function createSendHarness(
  initialSessionId: string | null = null,
  opts?: {
    workspacePath?: string;
    workspace?: CodexAppServerWorkspace;
    onSessionBindingDropped?: (expectedSessionId: string | null) => void;
    onSessionBinding?: (sessionId: string, capabilities: Record<string, unknown> | null) => void;
    onEngineProcessSnapshot?: (snapshot: unknown) => boolean;
    initialSessionCapabilities?: Record<string, unknown> | null;
    request?: (
      method: string,
      params: unknown,
      requestOpts?: {
        timeoutMs?: number;
        trackLateSettlement?: boolean;
        expectedProcessGeneration?: number;
      },
    ) => Promise<unknown>;
    ensureStarted?: () => Promise<void>;
    getInputActionHmacKey?: () => Buffer;
    compactBaselineTurns?: unknown[];
    compactBaselineStatus?: unknown;
    activeOwnershipRecoveryTtlMs?: number;
    activeOwnershipRecoveryEvidenceTtlMs?: number;
    goalResponse?: unknown;
    passthroughProviderPreflight?: boolean;
    onStartAttempt?: (input: unknown) => void;
  },
) {
  const requests: Array<{ method: string; params: unknown }> = [];
  const responses: Array<{ id: unknown; result: unknown }> = [];
  const conversationEvents: Array<Record<string, unknown>> = [];
  const rawEvents: Array<Record<string, unknown>> = [];
  const threadHandlers: Array<{ threadId: string; onMessage: (msg: Record<string, unknown>) => void }> = [];
  let compactBaselinePending = opts?.compactBaselineTurns != null;
  let defaultTurnStartCount = 0;
  let processGeneration = 1;
  const workspace = {
    request(
      method: string,
      params: unknown,
      requestOpts?: {
        timeoutMs?: number;
        trackLateSettlement?: boolean;
        expectedProcessGeneration?: number;
      },
    ) {
      requests.push({ method, params });
      if (method === "thread/goal/get") {
        return Promise.resolve(opts?.goalResponse ?? { goal: null });
      }
      if (
        method === "thread/read"
        && (params as any)?.includeTurns === false
        && !opts?.passthroughProviderPreflight
      ) {
        return Promise.resolve({
          thread: { id: initialSessionId ?? "session-started", status: { type: "idle" } },
        });
      }
      if (method === "thread/read" && compactBaselinePending) {
        compactBaselinePending = false;
        return Promise.resolve({
          thread: {
            id: initialSessionId ?? "session-started",
            status: opts?.compactBaselineStatus ?? { type: "idle" },
            turns: opts?.compactBaselineTurns ?? [],
          },
        });
      }
      if (opts?.request) {
        return normalizeProviderFixture(method, params, opts.request(method, params, requestOpts));
      }
      if (method === "thread/resume") {
        return Promise.resolve({ thread: { id: String((params as any)?.threadId ?? ""), status: { type: "idle" } } });
      }
      if (method === "thread/start") return Promise.resolve({ thread: { id: "session-started" } });
      if (method === "turn/start") {
        defaultTurnStartCount += 1;
        const providerTurnId = defaultTurnStartCount === 1 ? "turn-engine" : `turn-engine-${defaultTurnStartCount}`;
        const clientId = String((params as any)?.clientUserMessageId ?? "").trim();
        queueMicrotask(() => {
          threadHandlers.at(-1)?.onMessage({
            method: "item/started",
            params: {
              threadId: initialSessionId ?? "session-started",
              turnId: providerTurnId,
              item: { type: "userMessage", id: "provider-user-message", clientId, content: [] },
            },
          });
        });
        return Promise.resolve({ turn: { id: providerTurnId } });
      }
      if (method === "turn/interrupt") return Promise.resolve({});
      assert.fail(`createSendHarness 未声明 RPC：${method}`);
    },
    ensureStarted() {
      return opts?.ensureStarted?.() ?? Promise.resolve();
    },
    getProcessSnapshot() {
      return { running: true, generation: processGeneration };
    },
    isCurrentProcessGeneration(expected: number) {
      return expected === processGeneration;
    },
    registerThread(threadId: string, onMessage: (msg: Record<string, unknown>) => void) {
      const record = { threadId, onMessage };
      threadHandlers.push(record);
      return () => {
        const index = threadHandlers.indexOf(record);
        if (index >= 0) threadHandlers.splice(index, 1);
      };
    },
    respond(id: unknown, result: unknown) {
      responses.push({ id, result });
      return Promise.resolve();
    },
    notify() {
      return Promise.resolve();
    },
  };

  const manager = {
    getOrCreate() { return opts?.workspace ?? workspace as any; },
    getExisting() { return opts?.workspace ?? workspace as any; },
  };
  const session = new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: manager as any,
    workspacePath: opts?.workspacePath ?? "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: initialSessionId as any,
    initialSessionCapabilities: opts?.initialSessionCapabilities as any,
    onEngineProcessSnapshot(snapshot: unknown) {
      return opts?.onEngineProcessSnapshot?.(snapshot) ?? false;
    },
    onSessionBinding(sessionId, capabilities) {
      opts?.onSessionBinding?.(sessionId, capabilities as Record<string, unknown> | null);
    },
    onSessionBindingDropped(expectedSessionId) {
      opts?.onSessionBindingDropped?.(expectedSessionId);
    },
    onStartAttempt(input) {
      opts?.onStartAttempt?.(input);
    },
    getInputActionHmacKey: opts?.getInputActionHmacKey,
    supportsNativeDynamicTools() { return true; },
    activeOwnershipRecoveryTtlMs: opts?.activeOwnershipRecoveryTtlMs,
    activeOwnershipRecoveryEvidenceTtlMs: opts?.activeOwnershipRecoveryEvidenceTtlMs,
  });
  if (initialSessionId) {
    (session as any).observedProviderThreadStatus = "idle";
    (session as any).observedProviderActiveTurnId = null;
  }

  (session as any).emitters = {
    conversation(event: Record<string, unknown>) {
      conversationEvents.push(event);
    },
    raw(event: Record<string, unknown>) {
      rawEvents.push(event);
    },
  };

  return {
    session,
    workspace,
    requests,
    responses,
    conversationEvents,
    rawEvents,
    threadHandlers,
    /** Simulates a workspace app-server restart without replacing the workspace handle. */
    setProcessGeneration(next: number) { processGeneration = next; },
  };
}

/** 构造 enabled Skill 目录及其匹配的 opaque binding。 */
function createCodexSkillReservationFixture() {
  const workspacePath = "Z:/code/codeflowai";
  const workspaceId = "client-a:ws-demo" as any;
  const hmacKey = Buffer.alloc(32, 7);
  const name = "review";
  const scope = "repo";
  const skillPath = path.resolve(workspacePath, ".codex", "skills", name, "SKILL.md");
  const normalizedPath = path.normalize(skillPath);
  const comparisonPath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const skillId = buildCodexSkillId({
    hmacKey,
    workspaceId,
    name,
    scope,
    normalizedAbsolutePath: comparisonPath,
  });
  return {
    hmacKey,
    catalog: {
      data: [{
        cwd: workspacePath,
        skills: [{ name, scope, path: skillPath, enabled: true }],
        errors: [],
      }],
    },
    input: {
      turnId: "turn-skill" as any,
      userItemId: "item-user-skill" as any,
      text: "use $review",
      skillMentions: [{ skillId, name, start: 4, end: 11 }],
    },
  };
}

test("Codex Skill 挂起解析后的并发预占只允许一个 starting turn", async () => {
  const fixture = createCodexSkillReservationFixture();
  const catalogResolvers: Array<(value: unknown) => void> = [];
  const harness = createSendHarness("session-demo", {
    getInputActionHmacKey: () => fixture.hmacKey,
    async request(method) {
      if (method === "skills/list") {
        return await new Promise((resolve) => { catalogResolvers.push(resolve); });
      }
      assert.fail(`并发 Skill 预占不得发送额外 RPC：${method}`);
    },
  });

  const first = harness.session.prepareInputActions(fixture.input);
  const second = harness.session.prepareInputActions({
    ...fixture.input,
    turnId: "turn-skill-concurrent" as any,
    userItemId: "item-user-skill-concurrent" as any,
  });
  await flushMicrotasksUntil(
    () => catalogResolvers.length === 2,
    "并发 skills/list 未同时进入挂起态",
  );

  catalogResolvers[0]!(fixture.catalog);
  const prepared = await first;
  const rejected = assert.rejects(
    second,
    (error: any) => error?.code === "active_turn_conflict",
  );
  catalogResolvers[1]!(fixture.catalog);
  await rejected;

  assert.equal(harness.session.getActiveTurnId(), fixture.input.turnId);
  assert.equal(harness.session.releasePreparedInputActions(prepared), true);
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("Codex Skill 解析期间进程换代只重解一次再登记 reservation", async () => {
  const fixture = createCodexSkillReservationFixture();
  const observedGenerations: number[] = [];
  let ensureStartedCalls = 0;
  let harness!: ReturnType<typeof createSendHarness>;
  harness = createSendHarness("session-demo", {
    getInputActionHmacKey: () => fixture.hmacKey,
    async ensureStarted() { ensureStartedCalls += 1; },
    async request(method, _params, requestOpts) {
      if (method !== "skills/list") assert.fail(`Skill 换代重解不得发送额外 RPC：${method}`);
      observedGenerations.push(Number(requestOpts?.expectedProcessGeneration));
      if (observedGenerations.length === 1) harness.setProcessGeneration(2);
      return fixture.catalog;
    },
  });

  const prepared = await harness.session.prepareInputActions(fixture.input);

  assert.deepEqual(observedGenerations, [1, 2]);
  assert.equal(ensureStartedCalls, 2);
  assert.equal(prepared.processGeneration, 2);
  assert.equal(harness.session.releasePreparedInputActions(prepared), true);
});

test("Codex Skill reservation 后进程换代会在 turn/start 前显式失败", async () => {
  const fixture = createCodexSkillReservationFixture();
  const harness = createSendHarness("session-demo", {
    getInputActionHmacKey: () => fixture.hmacKey,
    async request(method) {
      if (method === "skills/list") return fixture.catalog;
      if (method === "thread/resume") return {};
      assert.fail(`reservation 换代后不得发送 Provider 输入：${method}`);
    },
  });
  const prepared = await harness.session.prepareInputActions(fixture.input);
  harness.setProcessGeneration(2);

  await assert.rejects(
    harness.session.sendMessage({
      turnId: fixture.input.turnId,
      userItemId: fixture.input.userItemId,
      text: fixture.input.text,
      preparedInputActions: prepared,
      images: [],
      assistantItemId: "item-assistant-skill",
      reasoningItemId: "item-reasoning-skill",
    }, {
      conversation(event) { harness.conversationEvents.push(event as any); },
      raw() {},
    }),
    (error: any) => error?.code === "CODEX_SKILL_BINDING_INVALID",
  );

  assert.deepEqual(harness.requests.map((request) => request.method), ["skills/list", "thread/resume"]);
  assert.equal(
    harness.conversationEvents.some((event) => event.type === "item.userMessage.engineCall.created"),
    false,
  );
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 在 active handoff 前同步持久化 turn/start attempt", async () => {
  const startAttempts: unknown[] = [];
  let sessionRef: CodexAppServerThreadSession | null = null;
  const harness = createSendHarness("provider-thread-start-attempt", {
    request: async (method) => {
      if (method === "turn/start") return { turn: { id: "provider-turn-start-attempt" } };
      return {};
    },
    onStartAttempt(input) {
      assert.equal((sessionRef as any)?.active ?? null, null);
      startAttempts.push(input);
    },
  });
  sessionRef = harness.session;

  const pending = harness.session.sendMessage({
    turnId: "turn-client-start-attempt" as any,
    userItemId: "item-user-start-attempt" as any,
    text: "persist before handoff",
    images: [],
    assistantItemId: "item-assistant-start-attempt",
    reasoningItemId: "item-reasoning-start-attempt",
  }, {
    conversation(event) { harness.conversationEvents.push(event as any); },
    raw() {},
  });

  await waitForActiveTurn(harness.session);
  assert.deepEqual(startAttempts, [{
    workspaceId: "client-a:ws-demo",
    threadId: "thread-demo",
    clientTurnId: "turn-client-start-attempt",
    clientUserMessageId: "item-user-start-attempt",
    providerThreadId: "provider-thread-start-attempt",
    provisionalProviderTurnId: "provider-turn-start-attempt",
    attemptId: 1,
    observedAt: (startAttempts[0] as any)?.observedAt,
  }]);
  assert.ok(Number((startAttempts[0] as any)?.observedAt ?? 0) > 0);
  assert.deepEqual(
    harness.conversationEvents
      .filter((event) => event.type === "turn.engineBound")
      .map((event) => (event as any).payload.engineTurnId),
    ["provider-turn-start-attempt"],
  );

  await completePendingSend(harness.session);
  await pending;
});

test("CodexAppServerThreadSession 的 start attempt 持久化失败会拒绝 handoff 并保留 generation", async () => {
  let bindingDrops = 0;
  const harness = createSendHarness("provider-thread-start-attempt-failure", {
    request: async (method) => {
      if (method === "turn/start") return { turn: { id: "provider-turn-start-attempt-failure" } };
      return {};
    },
    onStartAttempt() {
      throw new Error("start attempt persistence failed");
    },
    onSessionBindingDropped() {
      bindingDrops += 1;
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-start-attempt-failure" as any,
    userItemId: "item-user-start-attempt-failure" as any,
    text: "fail before handoff",
    images: [],
    assistantItemId: "item-assistant-start-attempt-failure",
    reasoningItemId: "item-reasoning-start-attempt-failure",
  }, {
    conversation(event) { harness.conversationEvents.push(event as any); },
    raw() {},
  }), /start attempt persistence failed/);

  assert.equal(bindingDrops, 0);
  assert.equal(harness.session.getSessionId(), "provider-thread-start-attempt-failure");
  assert.equal((harness.session as any).active, null);
  assert.equal(harness.conversationEvents.some((event) => event.type === "turn.engineBound"), false);
});

test("CodexAppServerThreadSession 仅在 session binding 持久化成功后提交新 provider generation", async () => {
  let failBinding = true;
  const bindingAttempts: string[] = [];
  const harness = createSendHarness(null, {
    onSessionBinding(sessionId) {
      bindingAttempts.push(sessionId);
      if (failBinding) throw new Error("session binding persistence failed");
    },
  });
  const emitters = {
    conversation(event: Record<string, unknown>) {
      harness.conversationEvents.push(event);
    },
    raw() {},
  };

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-source-before-commit-failed" as any,
    userItemId: "item-user-source-before-commit-failed" as any,
    text: "first attempt",
    images: [],
    assistantItemId: "item-assistant-source-before-commit-failed",
    reasoningItemId: "item-reasoning-source-before-commit-failed",
  }, emitters), /session binding persistence failed/);

  assert.equal(harness.session.getSessionId(), null);
  assert.equal(harness.threadHandlers.length, 0);
  assert.equal(harness.conversationEvents.some((event) => event.type === "thread.started"), false);
  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 1);

  failBinding = false;
  const retry = harness.session.sendMessage({
    turnId: "turn-source-before-commit-retry" as any,
    userItemId: "item-user-source-before-commit-retry" as any,
    text: "retry",
    images: [],
    assistantItemId: "item-assistant-source-before-commit-retry",
    reasoningItemId: "item-reasoning-source-before-commit-retry",
  }, emitters);
  await waitForActiveTurn(harness.session);

  assert.equal(harness.requests.filter((request) => request.method === "thread/start").length, 2);
  assert.deepEqual(bindingAttempts, ["session-started", "session-started"]);
  assert.equal(harness.session.getSessionId(), "session-started");
  assert.equal(
    harness.conversationEvents.filter((event) => event.type === "thread.started").length,
    1,
  );

  await completePendingSend(harness.session);
  await retry;
});

/** 为只测 active 消息路由的用例注入最小 turn 状态。 */
function primeActiveCodexTurn(session: CodexAppServerThreadSession): void {
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "text",
    accessMode: "current",
    toolRegistry: null,
    executeHostTool: null,
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    manualInterruptRequested: false,
    manualInterruptError: null,
    providerTerminalStatus: null,
    lastNonRetryableTurnError: null,
    resolve() {},
    reject() {},
  };
}

/** 结束 harness 中仍等待 provider 终态的 send。 */
async function completePendingSend(session: CodexAppServerThreadSession): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  (session as any).active?.resolve({});
}

/** 等待真实 send 完成 StartingTurn 到 ActiveTurn 的交接。 */
async function waitForActiveTurn(session: CodexAppServerThreadSession): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if ((session as any).active) return;
  }
  throw new Error("CodexAppServerThreadSession did not enter active state in time");
}

/** 在 mock timer 不推进延迟任务时，冲刷 Promise 与 setImmediate 结算。 */
async function flushMicrotasksUntil(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) {
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
      return;
    }
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

/** 等待包含真实短轮询延迟的后台对账完成，并在超时后保留明确断言。 */
async function waitForCondition(check: () => boolean, message: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

/** 交替冲刷 Promise 与当前 mock timers，避免失败路径按真实 5 秒窗口拖慢整套测试。 */
async function settleWithMockTimers(settlement: Promise<void>, runAllTimers: () => void): Promise<void> {
  let settled = false;
  void settlement.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  for (let attempt = 0; attempt < 40 && !settled; attempt += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    runAllTimers();
    await Promise.resolve();
  }
  if (!settled) throw new Error("mock timers 未能推动中断失败路径收口");
  await settlement;
}

test("CodexAppServerThreadSession 直接绑定 turn/start 响应并忽略其他 provider turn", async () => {
  const { session, requests, conversationEvents, threadHandlers } = createSendHarness("session-demo", {
    request(method) {
      if (method === "turn/start") return Promise.resolve({ turn: { id: "provider-response-turn" } });
      return Promise.resolve({});
    },
  });

  const pending = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "hello",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation(event) {
      conversationEvents.push(event as Record<string, unknown>);
    },
    raw() {},
  });

  await waitForActiveTurn(session);
  assert.equal((session as any).active?.codexTurnId, "provider-response-turn");
  assert.equal((session as any).active?.provisionalCodexTurnId, null);
  assert.equal((session as any).active?.codexTurnBindingSource, "start_result");
  const handler = threadHandlers[0]?.onMessage;
  assert.ok(handler);

  handler({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "provider-turn", status: "inProgress" } },
  });
  assert.equal((session as any).active?.codexTurnId, "provider-response-turn");
  handler({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "provider-turn",
      item: { type: "userMessage", id: "provider-user", clientId: "item-user", content: [] },
    },
  });
  assert.equal((session as any).active?.codexTurnId, "provider-response-turn");
  assert.equal((session as any).active?.codexTurnBindingSource, "start_result");

  const bindings = conversationEvents.filter((event) => event.type === "turn.engineBound");
  assert.deepEqual(bindings.map((event) => (event as any).payload), [
    {
      turnId: "turn-client",
      engineTurnId: "provider-response-turn",
      engineSessionId: "session-demo",
      previousEngineTurnId: null,
    },
  ]);

  handler({
    method: "item/started",
    params: { threadId: "session-demo", turnId: "provider-response-turn", item: { type: "agentMessage", id: "msg-live", text: "" } },
  });
  handler({
    method: "item/agentMessage/delta",
    params: { threadId: "session-demo", turnId: "provider-response-turn", itemId: "msg-live", delta: "hello" },
  });
  handler({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "provider-response-turn", status: "completed" } },
  });

  assert.deepEqual(await pending, { responseText: "hello" });
  handler({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "provider-goal-successor", status: "inProgress" } },
  });
  assert.equal((session as any).clientTurnIdByCodexTurnId.has("provider-goal-successor"), false);
  assert.equal(conversationEvents.filter((event) => event.type === "turn.engineBound").length, 1);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
});

test("CodexAppServerThreadSession handoff terminal 后迟到 started 会幂等收口且不阻断下一轮", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let turnStartCount = 0;
  const harness = createSendHarness("session-demo", {
    request(method) {
      if (method === "turn/start") {
        turnStartCount += 1;
        if (turnStartCount === 1) {
          (sessionRef as any).onAppServerMessage({
            method: "item/started",
            params: {
              threadId: "session-demo",
              turnId: "turn-interrupted",
              item: { type: "userMessage", id: "provider-user-first", clientId: "item-first", content: [] },
            },
          });
          (sessionRef as any).onAppServerMessage({
            method: "turn/completed",
            params: { threadId: "session-demo", turn: { id: "turn-interrupted", status: "interrupted" } },
          });
          (sessionRef as any).onAppServerMessage({
            method: "turn/started",
            params: { threadId: "session-demo", turn: { id: "turn-interrupted", status: "inProgress" } },
          });
          return Promise.resolve({ turn: { id: "turn-interrupted" } });
        }
        return Promise.resolve({ turn: { id: "turn-next" } });
      }
      if (method === "thread/read") {
        return Promise.resolve({
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{
              id: "turn-interrupted",
              status: "interrupted",
              items: [{ type: "userMessage", clientId: "item-first" }],
            }],
          },
        });
      }
      return Promise.resolve({});
    },
  });
  sessionRef = harness.session;

  await assert.rejects(
    harness.session.sendMessage({
      turnId: "turn-first" as any,
      userItemId: "item-first" as any,
      text: "terminal then started",
      images: [],
      assistantItemId: "assistant-first",
      reasoningItemId: "reasoning-first",
    }, {
      conversation() {},
      raw() {},
    }),
    /Codex turn ended as interrupted \(turn\.terminal-before-active-handoff\)/,
  );
  assert.equal(harness.session.hasActiveTurn(), false);

  const nextSend = harness.session.sendMessage({
    turnId: "turn-next" as any,
    userItemId: "item-next" as any,
    text: "next",
    images: [],
    assistantItemId: "assistant-next",
    reasoningItemId: "reasoning-next",
  }, {
    conversation() {},
    raw() {},
  });
  await waitForActiveTurn(harness.session);
  harness.threadHandlers[0]!.onMessage({
    method: "item/started",
    params: {
      threadId: "session-demo",
      turnId: "turn-next",
      item: { type: "userMessage", id: "provider-user-next", clientId: "item-next", content: [] },
    },
  });
  harness.threadHandlers[0]!.onMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-next", status: "completed" } },
  });

  assert.deepEqual(await nextSend, { responseText: "" });
  assert.equal(turnStartCount, 2);
  assert.equal(harness.session.hasActiveTurn(), false);
});

/** 构造携带迟到结算句柄的 turn/start timeout。 */
function createTrackedTurnStartTimeout(lateSettlement: Promise<unknown>, onRelease?: () => void): Error {
  return Object.assign(new Error("Codex app-server request timeout: turn/start"), {
    code: "codex_app_server_request_timeout",
    method: "turn/start",
    terminationKind: "error",
    lateSettlement,
    releaseLateSettlement: onRelease,
  });
}

/** 构造携带迟到结算句柄的 turn/steer timeout。 */
function createTrackedTurnSteerTimeout(lateSettlement: Promise<unknown>): Error {
  return Object.assign(new Error("Codex app-server request timeout: turn/steer"), {
    code: "codex_app_server_request_timeout",
    method: "turn/steer",
    terminationKind: "error",
    lateSettlement,
  });
}

/** 构造请求已写出、但 transport 故障导致响应结果未知的 turn/start 错误。 */
function createUnknownTurnStartProcessFault(): Error {
  return Object.assign(new Error("Codex app-server closed before turn/start response"), {
    code: "codex_app_server_closed",
    method: "turn/start",
    requestOutcomeUnknown: true,
    terminationKind: "error",
  });
}

/** 构造 rollback 对账使用的最小 provider thread/read 响应。 */
function createRollbackThreadRead(
  turnIds: string[],
  opts?: { threadId?: string; threadStatus?: string; runningTurnIds?: string[] },
): unknown {
  const runningTurnIds = new Set(opts?.runningTurnIds ?? []);
  return {
    thread: {
      id: opts?.threadId ?? "session-demo",
      status: { type: opts?.threadStatus ?? "idle" },
      turns: turnIds.map((id) => ({ id, status: runningTurnIds.has(id) ? "inProgress" : "completed" })),
    },
  };
}

test("CodexAppServerThreadSession startup Stop 等待 turn/start 响应 ID 与 interrupt ACK", async () => {
  let resolveTurnStart!: (value: unknown) => void;
  const turnStart = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  let resolveInterrupt!: (value: unknown) => void;
  const interrupt = new Promise((resolve) => {
    resolveInterrupt = resolve;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return await turnStart;
      if (method === "turn/interrupt") {
        assert.deepEqual(params, { threadId: "session-demo", turnId: "turn-engine" });
        return await interrupt;
      }
      assert.fail(`startup Stop 不得发送额外 RPC：${method}`);
    },
  });
  let sendSettled = false;
  const pendingSend = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "立即停止",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  const sendOutcome = pendingSend.then(
    () => {
      sendSettled = true;
      return assert.fail("Stop 后 send 不得成功");
    },
    (error: unknown) => {
      sendSettled = true;
      return error as Error & { code?: string; terminationKind?: string };
    },
  );

  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  let stopSettled = false;
  const pendingStop = session.interrupt("turn-client" as any).finally(() => {
    stopSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.equal(sendSettled, false);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);

  resolveTurnStart({ turn: { id: "turn-engine" } });
  await flushMicrotasksUntil(
    () => requests.some((request) => request.method === "turn/interrupt"),
    "turn/start 响应 ID 未触发精确中断",
  );
  assert.equal(stopSettled, false);
  assert.equal(sendSettled, false);

  resolveInterrupt({});
  assert.equal(await pendingStop, true);
  const sendError = await sendOutcome;
  assert.equal(sendError.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal(sendError.terminationKind, "manual_interrupt");
  assert.equal(session.hasActiveTurn(), false);
  assert.equal(session.getActiveTurnId(), null);
  assert.equal(session.getSessionId(), "session-demo");
  assert.deepEqual(requests.map((request) => request.method), [
    "thread/resume",
    "turn/start",
    "turn/interrupt",
  ]);
  assert.equal(requests.some((request) => request.method === "thread/read"), false);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(session.canIdleDispose(), true);
});

test("CodexAppServerThreadSession 图片 turn/start 快速停止后等待真实请求结算再清理", async t => {
  const f = imageReleaseFixture(t);
  let resolveTurnStart!: (value: unknown) => void;
  const turnStart = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  let imagePath = "";
  const harness = createSendHarness("session-demo", {
    workspacePath: f.workspacePath,
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        imagePath = String(
          ((params as any)?.input as any[])?.find((item) => item?.type === "localImage")?.path ?? "",
        );
        return await turnStart;
      }
      if (method === "turn/interrupt") {
        assert.deepEqual(params, { threadId: "session-demo", turnId: "turn-image-stop-late" });
        return {};
      }
      assert.fail(`图片 startup Stop 不得发送额外 RPC：${method}`);
    },
  });
  const pendingSend = harness.session.sendMessage({
    turnId: "turn-client-image-stop" as any,
    userItemId: "item-user-image-stop" as any,
    text: "图片后立即停止",
    images: ["data:image/png;base64,aW1hZ2U="],
    assistantItemId: "item-assistant-image-stop",
    reasoningItemId: "item-reasoning-image-stop",
  }, {
    conversation() {},
    raw() {},
  });
  const sendRejected = assert.rejects(
    pendingSend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE,
  );
  await waitForCondition(() => Boolean(imagePath), "turn/start 未携带临时图片路径");
  assert.equal(path.dirname(imagePath), f.root);
  assert.equal(fs.readFileSync(imagePath, "utf8"), "image");
  assert.equal(fs.existsSync(imagePath), true);

  let stopSettled = false;
  const pendingStop = harness.session.interrupt("turn-client-image-stop" as any).finally(() => {
    stopSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.equal(fs.existsSync(imagePath), true);

  resolveTurnStart({ turn: { id: "turn-image-stop-late" } });
  assert.equal(await pendingStop, true);
  await sendRejected;
  await waitForCondition(() => !fs.existsSync(imagePath), "真实 turn/start 结算后未清理临时图片");
  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession turn/steer 成功 ACK 后保留图片直到 provider turn 终态", async t => {
  const f = imageReleaseFixture(t);
  let imagePath = "";
  const harness = createSendHarness("session-demo", {
    workspacePath: f.workspacePath,
    async request(method, params) {
      if (method === "turn/steer") {
        imagePath = String(
          ((params as any)?.input as any[])?.find((item) => item?.type === "localImage")?.path ?? "",
        );
        return { turn: { id: "turn-engine" } };
      }
      return {};
    },
  });
  primeActiveCodexTurn(harness.session);

  await harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-steer-image-accepted" as any,
    text: "追加图片",
    images: ["data:image/png;base64,aW1hZ2U="],
  });
  assert.equal(path.dirname(imagePath), f.root);
  assert.equal(fs.readFileSync(imagePath, "utf8"), "image");
  assert.equal(fs.existsSync(imagePath), true);

  const active = (harness.session as any).active;
  (harness.session as any).settleActiveFromProviderTerminal(active, "completed", "test", null);
  await waitForCondition(() => !fs.existsSync(imagePath), "provider turn 终态后未清理 steer 临时图片");
});

test("CodexAppServerThreadSession turn/steer 明确拒绝后立即清理临时图片", async t => {
  const f = imageReleaseFixture(t);
  let imagePath = "";
  const harness = createSendHarness("session-demo", {
    workspacePath: f.workspacePath,
    async request(method, params) {
      if (method === "turn/steer") {
        imagePath = String(
          ((params as any)?.input as any[])?.find((item) => item?.type === "localImage")?.path ?? "",
        );
        throw new Error("turn/steer rejected");
      }
      return {};
    },
  });
  primeActiveCodexTurn(harness.session);

  await assert.rejects(harness.session.appendInput({
    turnId: "turn-client" as any,
    userItemId: "item-user-steer-image-rejected" as any,
    text: "追加图片",
    images: ["data:image/png;base64,aW1hZ2U="],
  }), /turn\/steer rejected/u);
  await waitForCondition(() => !fs.existsSync(imagePath), "明确拒绝后未清理 steer 临时图片");
});

test("CodexAppServerThreadSession turn/steer timeout 在迟到结算和 provider 终态前保留临时图片", async t => {
  const f = imageReleaseFixture(t);
  let resolveLateSettlement!: (value: unknown) => void;
  const lateSettlement = new Promise((resolve) => {
    resolveLateSettlement = resolve;
  });
  let imagePath = "";
  let steerRequestOpts: { timeoutMs?: number; trackLateSettlement?: boolean } | undefined;
  const harness = createSendHarness("session-demo", {
    workspacePath: f.workspacePath,
    async request(method, params, requestOpts) {
      if (method === "turn/steer") {
        steerRequestOpts = requestOpts;
        imagePath = String(
          ((params as any)?.input as any[])?.find((item) => item?.type === "localImage")?.path ?? "",
        );
        throw createTrackedTurnSteerTimeout(lateSettlement);
      }
      return {};
    },
  });
  primeActiveCodexTurn(harness.session);

  await assert.rejects(
    harness.session.appendInput({
      turnId: "turn-client" as any,
      userItemId: "item-user-steer-image" as any,
      text: "追加图片",
      images: ["data:image/png;base64,aW1hZ2U="],
    }),
    (error: any) => error?.code === "codex_app_server_request_timeout",
  );
  assert.equal(steerRequestOpts?.trackLateSettlement, true);
  assert.equal(fs.existsSync(imagePath), true);

  resolveLateSettlement({ status: "fulfilled", value: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(imagePath), true);

  const active = (harness.session as any).active;
  (harness.session as any).settleActiveFromProviderTerminal(active, "completed", "test", null);
  await waitForCondition(() => !fs.existsSync(imagePath), "provider turn 终态后未清理 timeout steer 临时图片");
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.clear();
});

/** 真实图片只写本例工作区；清理注入在测试结束前恢复。 */
function imageReleaseFixture(t: test.TestContext) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const workspacePath = fs.mkdtempSync(path.join(parent, "codex-session-image-release-"));
  const root = path.join(workspacePath, ".codeflowai");
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "warn", () => {});
  t.mock.method(logger, "error", () => {});
  t.after(() => {
    t.mock.restoreAll();
    assert.equal(path.dirname(workspacePath), parent);
    assert.ok(path.basename(workspacePath).startsWith("codex-session-image-release-"));
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  return { root, workspacePath };
}

for (const providerFailed of [false, true]) {
  test(`image lease ${providerFailed ? "provider failure" : "completed"} reports cleanup failure and releases active state`, async t => {
    const f = imageReleaseFixture(t), primary = new Error("provider-failed"), cleanup = Object.assign(new Error("private-delete"), { code: "EACCES" });
    const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath });
    const pending = session.sendMessage({ turnId: "image-release-turn" as any, userItemId: "image-user" as any,
      text: "image", images: ["data:image/png;base64,YQ=="], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
    let reported: unknown;
    const outcome = pending.then(() => { assert.fail("image cleanup failure must not report success"); }, error => { reported = error; });
    await waitForActiveTurn(session);
    const unlink = fs.unlinkSync;
    t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
    const active = (session as any).active;
    if (providerFailed) active.reject(primary);
    else (session as any).settleActiveFromProviderTerminal(active, "completed", "test", null);
    if (!providerFailed) assert.equal(active.providerTerminalStatus, "completed");
    await outcome;
    assert.equal((session as any).active, null);
    assert.equal(session.hasActiveTurn(), false);
    assert.equal(session.canIdleDispose(), false);
    assert.ok(reported instanceof Error);
    assert.equal((reported as Error & { code: string }).code, "codex_image_cleanup_failed");
    if (providerFailed) {
      assert.ok(reported instanceof AggregateError);
      assert.equal(reported.cause, primary);
      assert.equal(reported.errors[0], primary);
      assert.equal((reported.errors[1] as Error).cause, cleanup);
      assert.equal(reported.errors.length, 2);
    } else assert.equal(reported.cause, cleanup);
    await assert.rejects(session.dispose(), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  });
}

test("image lease rejected steer preserves provider and cleanup errors without disrupting the active owner", async t => {
  const f = imageReleaseFixture(t), primary = new Error("steer-rejected"), cleanup = new Error("unlink-failed");
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) { if (method === "turn/steer") throw primary; return {}; } });
  primeActiveCodexTurn(session);
  const active = (session as any).active, unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
  await assert.rejects(session.appendInput({ turnId: "turn-client" as any, userItemId: "steer-user" as any,
    text: "image", images: ["data:image/png;base64,YQ=="] }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    assert.equal(error.errors[0], primary);
    assert.equal((error.errors[1] as Error).cause, cleanup);
    return true;
  });
  assert.equal((session as any).active, active);
});

for (const accepted of [false, true]) {
  test(`image lease terminal before steer ${accepted ? "ACK" : "rejection"} still reports its cleanup failure`, async t => {
    const f = imageReleaseFixture(t), unlink = fs.unlinkSync, primary = new Error("steer-rejected-after-terminal");
    let resolveSteer!: (value: unknown) => void, rejectSteer!: (cause: unknown) => void;
    const request = new Promise((resolve, reject) => { resolveSteer = resolve; rejectSteer = reject; });
    const { session, requests } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) { return method === "turn/steer" ? await request : {}; } });
    primeActiveCodexTurn(session);
    const pending = session.appendInput({ turnId: "turn-client" as any, userItemId: "late-after-terminal" as any,
      text: "image", images: ["data:image/png;base64,YQ=="] });
    const cleanup = new Error("delete-after-steer-terminal");
    const outcome = assert.rejects(pending, error => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code: string }).code, "codex_image_cleanup_failed");
      if (!accepted) { assert.ok(error instanceof AggregateError); assert.equal(error.cause, primary); }
      else assert.equal(error.cause, cleanup);
      return true;
    });
    await waitForCondition(() => requests.some(item => item.method === "turn/steer"), "steer not dispatched");
    const active = (session as any).active;
    (session as any).settleActiveFromProviderTerminal(active, "completed", "test", null);
    t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
    if (accepted) resolveSteer({ turn: { id: "turn-engine" } });
    else rejectSteer(primary);
    await outcome;
    assert.equal(active.providerTerminalStatus, "completed");
  });
}

for (const cleanupFails of [false, true]) {
  test(`image lease late settlement ${cleanupFails ? "failure stays explicit" : "success restores admission"} without unhandled rejection`, async t => {
    const f = imageReleaseFixture(t);
    const errors: Record<string, unknown>[] = [];
    t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
    let resolveLate!: (value: unknown) => void;
    const late = new Promise(resolve => { resolveLate = resolve; });
    const { session, requests } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) {
      if (method === "turn/steer") throw createTrackedTurnSteerTimeout(late);
      return {};
    } });
    primeActiveCodexTurn(session);
    await assert.rejects(session.appendInput({ turnId: "turn-client" as any, userItemId: "late-image-user" as any,
      text: "image", images: ["data:image/png;base64,YQ=="] }), error => (error as NodeJS.ErrnoException).code === "codex_app_server_request_timeout");
    const active = (session as any).active;
    (session as any).settleActiveFromProviderTerminal(active, "completed", "test", null);
    (session as any).active = null;
    (session as any).pendingSteerCorrelationsByProviderClientKey.clear();
    const before = requests.length;
    await assert.rejects(session.compactThread({ turnId: "pending-image-block" as any }, { conversation() {}, raw() {} }),
      error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_pending");
    assert.equal(requests.length, before);
    const pendingLog = errors.find(error => error.errorCode === "codex_image_cleanup_pending");
    assert.ok(pendingLog);
    assert.equal(pendingLog.threadId, "thread-demo");
    assert.equal(pendingLog.clientTurnId, "turn-client");
    assert.match(String(pendingLog.requestId), /^codex-image:/);
    const unlink = fs.unlinkSync, cleanup = new Error("late-delete-failed");
    if (cleanupFails) t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
    resolveLate({ status: "fulfilled", value: {} });
    await new Promise<void>(resolve => setImmediate(resolve));
    if (cleanupFails) {
      await assert.rejects(session.prepareInputActions({} as any), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
      for (const operation of [() => session.sendMessage({} as any, {} as any), () => session.appendInput({} as any),
        () => session.compactThread({} as any, {} as any), () => session.prepareRollbackHistory(1, {} as any),
        () => session.applyPreparedRollbackHistory({} as any)]) {
        await assert.rejects(operation(), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
      }
      assert.throws(() => session.resetDynamicToolBinding(), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
      await assert.rejects(session.dispose(), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
      assert.equal(session.canIdleDispose(), false);
    } else {
      assert.deepEqual(fs.readdirSync(f.root), []);
      assert.equal(session.canIdleDispose(), true);
      await session.dispose();
    }
    assert.equal(requests.length, before);
  });
}

test("image lease cleanup error is retained when process termination follows provider completed", async t => {
  const f = imageReleaseFixture(t), cleanup = new Error("delete-after-completed");
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath });
  const pending = session.sendMessage({ turnId: "image-disposed-turn" as any, userItemId: "image-user" as any,
    text: "image", images: ["data:image/png;base64,YQ=="], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
  const outcome = assert.rejects(pending, error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await waitForActiveTurn(session);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
  (session as any).settleActiveFromProviderTerminal((session as any).active, "completed", "test", null);
  session.invalidateAfterProcessTermination();
  await outcome;
});

test("image lease explicit start rejection and cleanup failure do not leave an uncertain starting turn", async t => {
  const f = imageReleaseFixture(t), primary = Object.assign(new Error("provider-rejected"), { code: "codex_app_server_rpc_error", rpcError: true, method: "turn/start" });
  const cleanup = new Error("delete-rejected-start"), unlink = fs.unlinkSync;
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) { if (method === "turn/start") throw primary; return {}; } });
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
  await assert.rejects(session.sendMessage({ turnId: "image-start-rejected" as any, userItemId: "image-user" as any,
    text: "image", images: ["data:image/png;base64,YQ=="], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} }), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primary);
    return true;
  });
  assert.equal(session.hasActiveTurn(), false);
  assert.equal((session as any).startingTurn, null);
});

test("image lease multiple steer releases finish every image and active cleanup before reporting failures", async t => {
  const f = imageReleaseFixture(t), unlink = fs.unlinkSync, primary = new Error("steer-delete-failed");
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) {
    if (method === "turn/start" || method === "turn/steer") return { turn: { id: "turn-engine" } };
    return {};
  } });
  const pending = session.sendMessage({ turnId: "multi-steer-turn" as any, userItemId: "image-user" as any,
    text: "start", images: [], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
  const outcome = assert.rejects(pending, error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await waitForActiveTurn(session);
  for (const id of ["first", "second"]) await session.appendInput({ turnId: "multi-steer-turn" as any, userItemId: id as any,
    text: id, images: ["data:image/png;base64,YQ=="] });
  const files = fs.readdirSync(f.root).map(file => path.join(f.root, file));
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (String(file) === files[0]) throw primary; return unlink(file); });
  (session as any).settleActiveFromProviderTerminal((session as any).active, "completed", "test", null);
  await outcome;
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(files[0]!)]);
  assert.equal((session as any).active, null);
  assert.equal(session.hasActiveTurn(), false);
});

test("image lease interrupt remains available and reports cleanup failure through the owning send", async t => {
  const f = imageReleaseFixture(t), cleanup = new Error("interrupt-delete-failed"), unlink = fs.unlinkSync;
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath });
  const pending = session.sendMessage({ turnId: "image-interrupt-turn" as any, userItemId: "image-user" as any,
    text: "image", images: ["data:image/png;base64,YQ=="], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
  const outcome = assert.rejects(pending, error => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error as AggregateError & { code: string }).code, "codex_image_cleanup_failed");
    assert.equal((error.errors[0] as NodeJS.ErrnoException).code, MANUAL_TURN_INTERRUPT_CODE);
    return true;
  });
  await waitForActiveTurn(session);
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw cleanup; return unlink(file); });
  assert.equal(await session.interrupt("image-interrupt-turn" as any), true);
  await outcome;
  assert.equal(session.hasActiveTurn(), false);
});

test("image lease dispose rechecks cleanup after stopping an active turn before releasing binding", async t => {
  const f = imageReleaseFixture(t), unlink = fs.unlinkSync;
  const { session } = createSendHarness("session-demo", { workspacePath: f.workspacePath });
  const pending = session.sendMessage({ turnId: "image-dispose-turn" as any, userItemId: "image-user" as any,
    text: "image", images: ["data:image/png;base64,YQ=="], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
  const outcome = assert.rejects(pending, error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await waitForActiveTurn(session);
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw new Error("dispose-unlink"); return unlink(file); });
  await assert.rejects(session.dispose(), error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await outcome;
  assert.equal(session.getSessionId(), "session-demo");
});

test("image lease dispose still interrupts an active turn after rejected steer cleanup failed", async t => {
  const f = imageReleaseFixture(t), unlink = fs.unlinkSync;
  const { session, requests } = createSendHarness("session-demo", { workspacePath: f.workspacePath, async request(method) {
    if (method === "turn/steer") throw new Error("rejected-steer");
    if (method === "turn/start") return { turn: { id: "turn-engine" } };
    return {};
  } });
  const pending = session.sendMessage({ turnId: "image-dispose-active" as any, userItemId: "image-user" as any,
    text: "image", images: [], assistantItemId: "a", reasoningItemId: "r" }, { conversation() {}, raw() {} });
  const outcome = assert.rejects(pending, error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await waitForActiveTurn(session);
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { if (path.dirname(String(file)) === f.root) throw new Error("steer-unlink"); return unlink(file); });
  await assert.rejects(session.appendInput({ turnId: "image-dispose-active" as any, userItemId: "bad-steer" as any,
    text: "image", images: ["data:image/png;base64,YQ=="] }));
  const disposing = session.dispose();
  const disposal = assert.rejects(disposing, error => (error as NodeJS.ErrnoException).code === "codex_image_cleanup_failed");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.some(request => request.method === "turn/interrupt"), true);
  await outcome;
  await disposal;
  assert.equal(session.getSessionId(), "session-demo");
});

test("CodexAppServerThreadSession turn/start 返回精确 ID 后立即停止只中断该 ID", async () => {
  let resolveTurnStart!: (value: unknown) => void;
  const turnStart = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  const interruptedTurnIds: string[] = [];
  const { session, requests } = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "turn/start") return await turnStart;
      if (method === "turn/interrupt") {
        interruptedTurnIds.push(String((params as any)?.turnId ?? ""));
        return {};
      }
      if (method === "thread/resume") return {};
      assert.fail(`startup Stop 不得读取 provider 历史：${method}`);
    },
  });
  const pendingSend = session.sendMessage({
    turnId: "turn-client-preflight" as any,
    userItemId: "item-user-preflight" as any,
    text: "预检时立即停止",
    images: [],
    assistantItemId: "item-assistant-preflight",
    reasoningItemId: "item-reasoning-preflight",
  }, {
    conversation() {},
    raw() {},
  });
  await flushMicrotasksUntil(
    () => requests.some((request) => request.method === "turn/start"),
    "turn/start 未发出",
  );

  let stopSettled = false;
  const pendingStop = session.interrupt("turn-client-preflight" as any).finally(() => {
    stopSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopSettled, false);
  assert.deepEqual(interruptedTurnIds, []);

  resolveTurnStart({ turn: { id: "turn-start-late-after-stop" } });
  assert.equal(await pendingStop, true);
  await assert.rejects(
    pendingSend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE && error?.terminationKind === "manual_interrupt",
  );
  assert.equal(requests.filter((request) => request.method === "turn/start").length, 1);
  assert.deepEqual(interruptedTurnIds, ["turn-start-late-after-stop"]);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession detached 精确 interrupt ACK 后直接清理 tombstone", async () => {
  const interruptedTurnIds: string[] = [];
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/interrupt") {
        interruptedTurnIds.push(String((params as any)?.turnId ?? ""));
        return {};
      }
      assert.fail(`detached interrupt ACK 后不得读取 provider 快照：${method}`);
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-detached",
    providerThreadId: "session-demo",
    providerTurnId: "turn-detached",
    providerLifecycleTurnId: null,
    compensatedProviderTurnIds: new Set<string>(),
    startupInterruptAcknowledged: false,
    acknowledgeStartupInterrupt() {},
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);

  assert.equal(await harness.session.interrupt(startingTurn.clientTurnId), true);
  assert.deepEqual(interruptedTurnIds, ["turn-detached"]);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), false);
  assert.equal(startingTurn.compensatedProviderTurnIds.has("turn-detached"), true);
  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume", "turn/interrupt"]);
});

test("CodexAppServerThreadSession external ACK 精确匹配时直接收口 live active", () => {
  const harness = createSessionHarness({});
  const active = (harness.session as any).active;

  assert.equal(harness.session.acknowledgeExactProviderTurnInterrupt({
    clientTurnId: active.clientTurnId,
    providerThreadId: "session-demo" as any,
    providerTurnId: active.codexTurnId,
  }), true);

  assert.equal(active.providerTerminalStatus, "interrupt_acknowledged");
  assert.equal(active.manualInterruptRequested, true);
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
});

test("CodexAppServerThreadSession 旧 tombstone 的 external ACK 只清理旧代且不结算 successor", () => {
  const harness = createSessionHarness({});
  const active = (harness.session as any).active;
  active.codexTurnId = "turn-successor";
  let acknowledgeCalls = 0;
  let finalized = false;
  const startingTurn = {
    clientTurnId: active.clientTurnId,
    providerThreadId: "session-demo",
    providerTurnId: "turn-predecessor",
    providerLifecycleTurnId: null,
    compensatedProviderTurnIds: new Set<string>(),
    startupInterruptAcknowledged: false,
    acknowledgeStartupInterrupt() {
      acknowledgeCalls += 1;
    },
    resolveInterruptFinalized() {
      finalized = true;
    },
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);

  assert.equal(harness.session.acknowledgeExactProviderTurnInterrupt({
    clientTurnId: active.clientTurnId,
    providerThreadId: "session-demo" as any,
    providerTurnId: "turn-predecessor",
  }), true);

  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), false);
  assert.equal(startingTurn.compensatedProviderTurnIds.has("turn-predecessor"), true);
  assert.equal(acknowledgeCalls, 1);
  assert.equal(finalized, true);
  assert.strictEqual((harness.session as any).active, active);
  assert.equal(active.codexTurnId, "turn-successor");
  assert.equal(active.providerTerminalStatus, null);
  assert.equal(active.manualInterruptRequested, false);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession external ACK 无精确 tombstone 时不触碰 successor", () => {
  const harness = createSessionHarness({});
  const active = (harness.session as any).active;
  active.codexTurnId = "turn-successor";

  assert.equal(harness.session.acknowledgeExactProviderTurnInterrupt({
    clientTurnId: active.clientTurnId,
    providerThreadId: "session-demo" as any,
    providerTurnId: "turn-predecessor",
  }), false);

  assert.strictEqual((harness.session as any).active, active);
  assert.equal(active.codexTurnId, "turn-successor");
  assert.equal(active.providerTerminalStatus, null);
  assert.equal(active.manualInterruptRequested, false);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 旧 starting terminal 只收口旧代且不结算 successor", () => {
  const harness = createSessionHarness({});
  const active = (harness.session as any).active;
  active.codexTurnId = "turn-successor";
  let finalized = false;
  const startingTurn = {
    clientTurnId: active.clientTurnId,
    providerThreadId: "session-demo",
    providerTurnId: "turn-predecessor",
    providerLifecycleTurnId: null,
    compensatedProviderTurnIds: new Set<string>(),
    resolveInterruptFinalized() {
      finalized = true;
    },
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);

  assert.equal((harness.session as any).finalizeInterruptedOwnedTurnFromTerminal(
    "session-demo",
    "turn-predecessor",
    "completed",
  ), true);

  assert.equal((harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId), false);
  assert.equal(startingTurn.compensatedProviderTurnIds.has("turn-predecessor"), true);
  assert.equal(finalized, true);
  assert.equal((harness.session as any).retiredCodexTurnIds.has("turn-predecessor"), true);
  assert.strictEqual((harness.session as any).active, active);
  assert.equal(active.codexTurnId, "turn-successor");
  assert.equal(active.providerTerminalStatus, null);
  assert.equal(active.manualInterruptRequested, false);
  assert.equal(harness.getResolved(), null);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession 旧新启动均未确认 provider ID 时隔离歧义 started", () => {
  const harness = createSendHarness("session-demo");
  const oldTurn = {
    clientTurnId: "turn-old-client",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    terminalHintProviderTurnIds: new Set<string>(),
  };
  const newTurn = {
    clientTurnId: "turn-new-client",
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    startRequestSent: true,
    terminalHintProviderTurnIds: new Set<string>(),
  };
  (harness.session as any).pendingInterruptedStartingTurns.set(oldTurn.clientTurnId, oldTurn);
  (harness.session as any).startingTurn = newTurn;

  assert.doesNotThrow(() => {
    (harness.session as any).onAppServerMessage({
      method: "turn/started",
      params: { threadId: "session-demo", turn: { id: "turn-provider-unknown", status: "inProgress" } },
    });
  });
  const rawStarted = harness.rawEvents.find(
    (event) => (event.data as any)?.method === "turn/started"
      && (event.data as any)?.params?.turn?.id === "turn-provider-unknown",
  );
  assert.equal(rawStarted?.clientTurnId, undefined);
  assert.equal((harness.session as any).codexTurnIdByClientTurnId.size, 0);
  assert.equal((harness.session as any).clientTurnIdByCodexTurnId.size, 0);
});

test("CodexAppServerThreadSession 中断记录与 starting 重叠时也不会猜测 started 归属", () => {
  const harness = createSendHarness("session-demo");
  const interruptedTurn = {
    clientTurnId: "turn-interrupted-client",
    providerTurnId: null,
    providerLifecycleTurnId: null,
  };
  (harness.session as any).pendingInterruptedStartingTurns.set(interruptedTurn.clientTurnId, interruptedTurn);
  (harness.session as any).startingTurn = interruptedTurn;

  assert.equal((harness.session as any).resolveRawTurnStartedClientTurnId("turn-interrupted-provider"), null);
  assert.equal((harness.session as any).pendingInterruptedStartingTurns.size, 1);
  assert.equal((harness.session as any).retiredCodexTurnIds.has("turn-interrupted-provider"), false);
});

test("CodexAppServerThreadSession thread/start 期间停止会忽略未绑定的迟到响应", async () => {
  let resolveThreadStart!: (value: unknown) => void;
  const threadStart = new Promise((resolve) => {
    resolveThreadStart = resolve;
  });
  let dropped = 0;
  const harness = createSendHarness(null, {
    onSessionBindingDropped() {
      dropped += 1;
    },
    async request(method) {
      if (method === "thread/start") return await threadStart;
      return {};
    },
  });
  const pendingSend = harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "立即停止",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  const sendRejected = assert.rejects(
    pendingSend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE && error?.terminationKind === "manual_interrupt",
  );
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "thread/start"),
    "thread/start 未发出",
  );

  const pendingInterrupt = harness.session.interrupt("turn-client" as any);
  assert.equal(await pendingInterrupt, true);
  await sendRejected;

  assert.equal(harness.session.getSessionId(), null);
  assert.equal(dropped, 0);
  assert.equal(harness.requests.some((request) => request.method === "turn/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);

  resolveThreadStart({ thread: { id: "session-empty" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.equal(dropped, 0);
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
  assert.equal(harness.session.getSessionId(), null);
});

test("CodexAppServerThreadSession 迟到 thread/start 不覆盖后继 binding 且不留下清理门禁", async () => {
  let resolveThreadStart!: (value: unknown) => void;
  const threadStart = new Promise((resolve) => {
    resolveThreadStart = resolve;
  });
  const bindingWrites: string[] = [];
  const droppedSessionIds: Array<string | null> = [];
  let runtimeBinding = "";
  const harness = createSendHarness(null, {
    passthroughProviderPreflight: true,
    onSessionBinding(sessionId) {
      bindingWrites.push(sessionId);
    },
    onSessionBindingDropped(expectedSessionId) {
      droppedSessionIds.push(expectedSessionId);
      if (runtimeBinding && runtimeBinding !== expectedSessionId) {
        throw new Error("successor binding must stay intact");
      }
      runtimeBinding = "";
    },
    async request(method) {
      if (method === "thread/start") return await threadStart;
      if (method === "thread/read") {
        return { thread: { id: "session-successor", status: { type: "idle" } } };
      }
      if (method === "turn/start") return { turn: { id: "turn-engine-successor" } };
      return {};
    },
  });
  const pending = harness.session.sendMessage({
    turnId: "turn-client-stale-thread-start" as any,
    userItemId: "item-user-stale-thread-start" as any,
    text: "旧 thread/start 不能覆盖后继",
    images: [],
    assistantItemId: "item-assistant-stale-thread-start",
    reasoningItemId: "item-reasoning-stale-thread-start",
  }, { conversation() {}, raw() {} });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "thread/start"),
    "thread/start 未进入 pending",
  );

  assert.equal(await harness.session.interrupt("turn-client-stale-thread-start" as any), true);
  await assert.rejects(pending, (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE);
  runtimeBinding = "session-successor";
  (harness.session as any).sessionId = "session-successor";
  resolveThreadStart({ thread: { id: "session-stale" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();

  assert.deepEqual(bindingWrites, []);
  assert.deepEqual(droppedSessionIds, []);
  assert.equal(runtimeBinding, "session-successor");
  assert.equal((harness.session as any).pendingSessionBindingDrop, null);
  assert.equal(harness.session.getSessionId(), "session-successor");
  assert.equal(harness.requests.some((request) => request.method === "turn/start"), false);

  const successorSend = harness.session.sendMessage({
    turnId: "turn-client-successor" as any,
    userItemId: "item-user-successor" as any,
    text: "后继 binding 继续发送",
    images: [],
    assistantItemId: "item-assistant-successor",
    reasoningItemId: "item-reasoning-successor",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  await completePendingSend(harness.session);
  await successorSend;
});

test("CodexAppServerThreadSession active Stop 仅等待精确 interrupt ACK 且不读取状态快照", async () => {
  let resolveInterrupt!: (value: unknown) => void;
  const interrupt = new Promise((resolve) => {
    resolveInterrupt = resolve;
  });
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/interrupt") return await interrupt;
      assert.fail(`active Stop 不得读取状态快照：${method}`);
    },
  });
  let stopSettled = false;
  const pendingStop = harness.session.interrupt("turn-client" as any).finally(() => {
    stopSettled = true;
  });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/interrupt"),
    "精确中断请求未发出",
  );
  assert.equal(stopSettled, false);
  assert.equal(harness.getRejected(), null);
  assert.equal(harness.session.hasActiveTurn(), true);

  resolveInterrupt({});
  assert.equal(await pendingStop, true);
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupt_acknowledged");
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/interrupt"]);
});

test("CodexAppServerThreadSession 精确中断等待 ACK 时只按 owned predecessor 终态结算", async () => {
  let resolveInterrupt!: (value: unknown) => void;
  const interruptAck = new Promise((resolve) => {
    resolveInterrupt = resolve;
  });
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/interrupt") {
        const providerTurnId = String((params as any)?.turnId ?? "");
        if (providerTurnId === "turn-engine") return await interruptAck;
        assert.fail(`不得中断 foreign successor：${providerTurnId}`);
      }
      assert.fail(`精确 interrupt ACK 后不得读取 provider 快照：${method}`);
    },
  });

  const pendingInterrupt = harness.session.interrupt("turn-client" as any);
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/interrupt"),
    "精确中断请求未发出",
  );
  harness.session.onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-other" } },
  });
  assert.equal((harness.session as any).active.codexTurnId, "turn-engine");

  resolveInterrupt({});
  assert.equal(await pendingInterrupt, true);
  assert.deepEqual(
    harness.requests.filter((request) => request.method === "turn/interrupt")
      .map((request) => (request.params as any)?.turnId),
    ["turn-engine"],
  );
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupt_acknowledged");
});

test("CodexAppServerThreadSession 中断期间 owned predecessor terminal 会结算且不触碰 foreign successor", async () => {
  let resolveFirstInterrupt!: (value: unknown) => void;
  const firstInterrupt = new Promise((resolve) => {
    resolveFirstInterrupt = resolve;
  });
  let successorInterrupted = false;
  const interruptedTurnIds: string[] = [];
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/interrupt") {
        const providerTurnId = String((params as any)?.turnId ?? "");
        interruptedTurnIds.push(providerTurnId);
        if (providerTurnId === "turn-engine") return await firstInterrupt;
        assert.equal(providerTurnId, "turn-successor");
        successorInterrupted = true;
        return {};
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: successorInterrupted ? "idle" : "active" },
            turns: [{
              id: "turn-successor",
              status: successorInterrupted ? "interrupted" : "inProgress",
              items: [],
            }],
          },
        };
      }
      return {};
    },
  });

  const pendingInterrupt = harness.session.interrupt("turn-client" as any);
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/interrupt"),
    "predecessor 中断请求未发出",
  );
  (harness.session as any).onAppServerMessage({
    method: "turn/started",
    params: { threadId: "session-demo", turn: { id: "turn-successor", status: "inProgress" } },
  });
  (harness.session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "interrupted" } },
  });
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupted");
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);

  resolveFirstInterrupt({});
  assert.equal(await pendingInterrupt, true);
  assert.deepEqual(interruptedTurnIds, ["turn-engine"]);
  assert.equal((harness.session as any).active.codexTurnId, "turn-engine");
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
});

test("CodexAppServerThreadSession 启动明确失败但已请求停止时统一按手动中断结算", async () => {
  let rejectTurnStart!: (error: Error) => void;
  const turnStart = new Promise((_resolve, reject) => {
    rejectTurnStart = reject;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return await turnStart;
      return {};
    },
  });
  const pendingSend = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "启动失败前停止",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const pendingInterrupt = session.interrupt("turn-client" as any);
  rejectTurnStart(createExplicitTurnStartRejection(
    "turn/start rejected",
    "startup-stop-explicit-rejection",
  ));

  assert.equal(await pendingInterrupt, true);
  await assert.rejects(
    pendingSend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE && error?.terminationKind === "manual_interrupt",
  );
  assert.deepEqual(
    requests.filter((request) => request.method === "turn/interrupt").map((request) => (request.params as any)?.turnId),
    [],
  );
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession pending turn/start 进程故障且未确权时保留运行 fence", async () => {
  let rejectTurnStart!: (error: Error) => void;
  const turnStart = new Promise((_resolve, reject) => {
    rejectTurnStart = reject;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return await turnStart;
      assert.fail(`process fault 后不得发送推测性 RPC：${method}`);
    },
  });
  let sendSettled = false;
  const pendingSend = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "进程故障窗口立即停止",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    sendSettled = true;
  });
  const sendOutcome = pendingSend.then(
    () => assert.fail("process fault 不得伪造 turn/start 成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const interruptOutcome = session.interrupt("turn-client" as any).then(
    () => assert.fail("未取得权威 turn.id 时不得伪造中断成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  rejectTurnStart(createUnknownTurnStartProcessFault());

  const [interruptError, sendError] = await Promise.all([interruptOutcome, sendOutcome]);
  assert.equal(interruptError.code, "codex_turn_start_state_unknown");
  assert.equal(interruptError.preserveRunningState, true);
  assert.equal(sendError.code, "codex_turn_start_state_unknown");
  assert.equal(sendError.preserveRunningState, true);
  assert.equal(sendSettled, true);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal(session.getActiveTurnId(), "turn-client");
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);

  await assert.rejects(
    session.sendMessage({
      turnId: "turn-next" as any,
      userItemId: "item-next" as any,
      text: "不得越过未知启动",
      images: [],
      assistantItemId: "item-next-assistant",
      reasoningItemId: "item-next-reasoning",
    }, {
      conversation() {},
      raw() {},
    }),
    /\u5f53\u524d thread \u6709\u672a\u5b8c\u6210\u7684 turn/,
  );
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);
});

test("CodexAppServerThreadSession turn/start 迟到精确 ID 后只中断该 ID", async () => {
  const lateSettlement = Promise.resolve({
    status: "fulfilled" as const,
    value: { turn: { id: "turn-current" } },
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") throw createTrackedTurnStartTimeout(lateSettlement);
      if (method === "turn/interrupt") {
        assert.equal((params as any)?.turnId, "turn-current");
        return {};
      }
      assert.fail(`迟到精确 ID 不得触发额外 RPC：${method}`);
    },
  });

  const startError = await session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "精确中断当前 turn",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("turn/start timeout 不得伪造发送成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );

  assert.equal(startError.code, "codex_turn_start_state_unknown");
  assert.equal(startError.preserveRunningState, true);
  await waitForCondition(
    () => requests.some((request) => request.method === "turn/interrupt"),
    "迟到 turn/start 响应未触发精确中断",
  );
  assert.deepEqual(
    requests.filter((request) => request.method === "turn/interrupt")
      .map((request) => (request.params as any)?.turnId),
    ["turn-current"],
  );
  assert.equal(requests.some((request) => request.method === "thread/read"), false);
  assert.equal(requests.some((request) => request.method === "thread/turns/list"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 迟到成功响应缺少 turn.id 时保留运行 fence", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        throw createTrackedTurnStartTimeout(Promise.resolve({ status: "fulfilled", value: {} }));
      }
      assert.fail(`迟到响应缺少 turn.id 时不得推测状态：${method}`);
    },
  });

  const error = await session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "迟到响应缺少 turn.id",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("缺少 turn.id 时不得伪造发送成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );

  assert.equal(error.code, "codex_turn_start_state_unknown");
  assert.equal(error.preserveRunningState, true);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal(session.getActiveTurnId(), "turn-client");
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);
});

test("CodexAppServerThreadSession 正常响应缺少 turn.id 时显式失败并保留运行 fence", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return {};
      assert.fail(`正常响应缺少 turn.id 时不得推测状态：${method}`);
    },
  });

  const error = await session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "正常响应缺少 turn.id",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("缺少 turn.id 时不得伪造发送成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );

  assert.equal(error.code, "codex_turn_start_response_missing_turn_id");
  assert.equal(error.preserveRunningState, true);
  assert.equal((session as any).codexTurnIdByClientTurnId.has("turn-client"), false);
  assert.equal(session.hasActiveTurn(), true);
  assert.equal(session.getActiveTurnId(), "turn-client");
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);
});

test("CodexAppServerThreadSession dispose 保留未确权 fence，明确迟到拒绝后才释放", async () => {
  let rejectTurnStart!: (error: Error) => void;
  let resolveLateSettlement!: (value: unknown) => void;
  const turnStart = new Promise((_resolve, reject) => {
    rejectTurnStart = reject;
  });
  const lateSettlement = new Promise((resolve) => {
    resolveLateSettlement = resolve;
  });
  let releaseCalls = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return await turnStart;
      assert.fail(`dispose 不得猜测未确权 turn：${method}`);
    },
  });
  const sendOutcome = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "dispose 等待迟到结算",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("turn/start timeout 不得伪造发送成功"),
    (error: unknown) => error as Error & { code?: string; preserveRunningState?: boolean },
  );
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const disposeOutcome = session.dispose().then(
    () => assert.fail("未确认 provider 终态时不得释放 session"),
    (error: unknown) => error as Error & { cause?: unknown },
  );
  rejectTurnStart(createTrackedTurnStartTimeout(lateSettlement, () => {
    releaseCalls += 1;
  }));

  const [disposeError, sendError] = await Promise.all([disposeOutcome, sendOutcome]);
  assert.match(
    disposeError.message,
    /active turn 中断未确认.*threadId=thread-demo.*turnId=turn-client/,
  );
  assert.equal((disposeError.cause as any)?.code, "codex_turn_start_state_unknown");
  assert.equal(sendError.code, "codex_turn_start_state_unknown");
  assert.equal(sendError.preserveRunningState, true);
  assert.equal(releaseCalls, 0);
  assert.equal(session.hasActiveTurn(), true);
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);

  resolveLateSettlement({
    status: "rejected",
    kind: "rpc_error",
    reason: createExplicitTurnStartRejection(
      "turn/start rejected after timeout",
      "dispose-late-explicit-rejection",
    ),
  });
  await waitForCondition(
    () => !session.hasActiveTurn(),
    "明确迟到 RPC rejection 未释放 provider fence",
  );
  assert.equal(releaseCalls, 1);
  assert.equal((session as any).pendingInterruptedStartingTurns.size, 0);
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);

  await session.dispose();
  assert.equal((session as any).detachedProviderThreadUnregisterById.size, 0);
});

test("CodexAppServerThreadSession dispose 在 provider 中断未确认时保留 session", async () => {
  const { session } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/interrupt") throw new Error("interrupt transport failed");
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-engine", status: "inProgress" }], nextCursor: null };
      }
      return {};
    },
  });
  primeActiveCodexTurn(session);
  (session as any).bindCodexTurn("turn-client", "turn-engine");

  await assert.rejects(
    session.dispose(),
    /active turn 中断未确认.*threadId=thread-demo.*turnId=turn-client/,
  );
  assert.equal(session.getSessionId(), "session-demo");
  assert.equal(session.hasActiveTurn(), true);
  assert.equal((session as any).codexTurnIdByClientTurnId.get("turn-client"), "turn-engine");
});

test("CodexAppServerThreadSession rollback prepare 的 read 失败不会复用旧 resumed ACK", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        if (readCount === 1) throw new Error("rollback baseline read failed");
        return createRollbackThreadRead(["provider-1"]);
      }
      return {};
    },
  });
  (session as any).resumed = true;

  await assert.rejects(
    session.prepareRollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    /rollback baseline read failed/,
  );
  assert.equal((session as any).resumed, false);
  assert.equal(session.isRecoveryPending(), true);

  const prepared = await session.prepareRollbackHistory(1, {
    droppedTurnIds: ["provider-1"],
    retainedTurnId: null,
  });
  assert.equal(prepared?.sessionId, "session-demo");
  assert.equal(requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(requests.filter((request) => request.method === "thread/read").length, 2);
  session.cancelPreparedRollbackHistory(prepared!);
  await session.dispose({ flushActiveTurn: false });
});

test("CodexAppServerThreadSession rollback history read 失败不会复用旧 resumed ACK", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        if (readCount === 1) throw new Error("rollback history read failed");
        return createRollbackThreadRead(["provider-1"]);
      }
      return {};
    },
  });
  (session as any).resumed = true;

  await assert.rejects(session.readRollbackHistoryTurnIds(), /rollback history read failed/);
  assert.equal((session as any).resumed, false);
  assert.equal(session.isRecoveryPending(), true);

  assert.deepEqual(await session.readRollbackHistoryTurnIds(), ["provider-1"]);
  assert.equal(requests.filter((request) => request.method === "thread/resume").length, 2);
  assert.equal(requests.filter((request) => request.method === "thread/read").length, 2);
  await session.dispose({ flushActiveTurn: false });
});

test("CodexAppServerThreadSession rollbackHistory 用前后 thread/read 确认严格 provider 前缀", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        return readCount <= 2
          ? createRollbackThreadRead(["provider-1", "provider-2", "provider-3"])
          : createRollbackThreadRead(["provider-1"]);
      }
      return {};
    },
  });

  await session.rollbackHistory(2, {
    droppedTurnIds: ["provider-2", "provider-3"],
    retainedTurnId: "provider-1",
  });

  assert.deepEqual(requests.map((request) => request.method), [
    "thread/resume",
    "thread/goal/get",
    "thread/read",
    "thread/goal/get",
    "thread/read",
    "thread/rollback",
    "thread/read",
  ]);
  assert.deepEqual(requests[2]?.params, { threadId: "session-demo", includeTurns: true });
  assert.deepEqual(requests[5]?.params, { threadId: "session-demo", numTurns: 2 });
});

test("CodexAppServerThreadSession rollbackHistory 自动剔除真实尾部后的未物化映射", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        return readCount <= 2
          ? createRollbackThreadRead(["provider-0", "provider-1", "provider-2", "provider-3"])
          : createRollbackThreadRead(["provider-0", "provider-1"]);
      }
      return {};
    },
  });

  const prepared = await session.prepareRollbackHistory(3, {
    droppedTurnIds: ["provider-2", "provider-3", "provider-phantom"],
    retainedTurnId: "provider-1",
  });
  assert.deepEqual(prepared, {
    sessionId: "session-demo",
    numTurns: 2,
    providerLifecycleEventVersion: 0,
    beforeTurnIds: ["provider-0", "provider-1", "provider-2", "provider-3"],
    afterTurnIds: ["provider-0", "provider-1"],
    droppedTurnIds: ["provider-2", "provider-3"],
    retainedTurnId: "provider-1",
  });

  await session.applyPreparedRollbackHistory(prepared!);
  assert.deepEqual(requests.map((request) => request.method), [
    "thread/resume",
    "thread/goal/get",
    "thread/read",
    "thread/goal/get",
    "thread/read",
    "thread/rollback",
    "thread/read",
  ]);
  assert.deepEqual(requests[5]?.params, { threadId: "session-demo", numTurns: 2 });
});

test("CodexAppServerThreadSession rollbackHistory 在 provider 尾部与本地映射不一致时不执行 mutation", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        return createRollbackThreadRead([
          "provider-0",
          "provider-1",
          "provider-2",
          "provider-other",
          "provider-3",
        ]);
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(3, {
      droppedTurnIds: ["provider-2", "provider-3", "provider-phantom"],
      retainedTurnId: "provider-1",
    }),
    /provider 待删除 turns 与本地映射不一致/,
  );
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 自动剔除真实尾部之前的未物化映射", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        return readCount <= 2
          ? createRollbackThreadRead(["provider-0", "provider-1", "provider-2"])
          : createRollbackThreadRead(["provider-0", "provider-1"]);
      }
      return {};
    },
  });

  const prepared = await session.prepareRollbackHistory(2, {
    droppedTurnIds: ["provider-phantom", "provider-2"],
    retainedTurnId: "provider-1",
  });
  assert.equal(prepared?.numTurns, 1);
  assert.deepEqual(prepared?.droppedTurnIds, ["provider-2"]);
  await session.applyPreparedRollbackHistory(prepared!);
  assert.deepEqual(
    requests.filter((request) => request.method === "thread/rollback")
      .map((request) => request.params),
    [{ threadId: "session-demo", numTurns: 1 }],
  );
});

test("CodexAppServerThreadSession rollbackHistory 自动剔除真实尾部中间的未物化映射", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        return readCount <= 2
          ? createRollbackThreadRead(["provider-0", "provider-1", "provider-2", "provider-3"])
          : createRollbackThreadRead(["provider-0", "provider-1"]);
      }
      return {};
    },
  });

  const prepared = await session.prepareRollbackHistory(3, {
    droppedTurnIds: ["provider-2", "provider-phantom", "provider-3"],
    retainedTurnId: "provider-1",
  });
  assert.equal(prepared?.numTurns, 2);
  assert.deepEqual(prepared?.droppedTurnIds, ["provider-2", "provider-3"]);
  await session.applyPreparedRollbackHistory(prepared!);
  assert.deepEqual(
    requests.filter((request) => request.method === "thread/rollback")
      .map((request) => request.params),
    [{ threadId: "session-demo", numTurns: 2 }],
  );
});

test("CodexAppServerThreadSession rollbackHistory 在待删映射全部未物化且已达目标时跳过 mutation", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") return createRollbackThreadRead(["provider-0", "provider-1"]);
      return {};
    },
  });

  const prepared = await session.prepareRollbackHistory(1, {
    droppedTurnIds: ["provider-phantom"],
    retainedTurnId: "provider-1",
  });
  assert.deepEqual(prepared, {
    sessionId: "session-demo",
    numTurns: 0,
    providerLifecycleEventVersion: 0,
    beforeTurnIds: ["provider-0", "provider-1"],
    afterTurnIds: ["provider-0", "provider-1"],
    droppedTurnIds: [],
    retainedTurnId: "provider-1",
  });
  await session.applyPreparedRollbackHistory(prepared!);
  assert.deepEqual(requests.map((request) => request.method), [
    "thread/resume",
    "thread/goal/get",
    "thread/read",
    "thread/goal/get",
    "thread/read",
  ]);
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 在全部映射未物化但存在未知尾部时拒绝 mutation", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") return createRollbackThreadRead(["provider-0", "provider-1", "provider-other"]);
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, {
      droppedTurnIds: ["provider-phantom"],
      retainedTurnId: "provider-1",
    }),
    /provider 回滚边界与本地映射不一致/,
  );
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 在 retained 不是实际尾部前驱时拒绝 mutation", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        return createRollbackThreadRead(["provider-0", "provider-1", "provider-2", "provider-3"]);
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(2, {
      droppedTurnIds: ["provider-2", "provider-3"],
      retainedTurnId: "provider-0",
    }),
    /provider 回滚边界与本地映射不一致/,
  );
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 占用期间拒绝 send 和 compact", async () => {
  let resolveBeforeRead!: (value: unknown) => void;
  const beforeRead = new Promise<unknown>((resolve) => {
    resolveBeforeRead = resolve;
  });
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        if (readCount === 1) return await beforeRead;
        if (readCount === 2) return createRollbackThreadRead(["provider-1", "provider-2"]);
        return createRollbackThreadRead(["provider-1"]);
      }
      return {};
    },
  });
  const emitters = { conversation() {}, raw() {} };
  const pendingRollback = session.rollbackHistory(1, {
    droppedTurnIds: ["provider-2"],
    retainedTurnId: "provider-1",
  });
  while (!requests.some((request) => request.method === "thread/read")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(session.hasActiveTurn(), true);
  await assert.rejects(
    session.sendMessage({
      turnId: "turn-send-during-rollback" as any,
      userItemId: "item-send-during-rollback" as any,
      text: "回滚期间发送",
      images: [],
      assistantItemId: "assistant-send-during-rollback",
      reasoningItemId: "reasoning-send-during-rollback",
    }, emitters),
    /当前 thread 有未完成的 turn/,
  );
  await assert.rejects(
    session.compactThread({ turnId: "turn-compact-during-rollback" as any }, emitters),
    /当前 thread 有未完成的 turn/,
  );
  await assert.rejects(
    session.dispose(),
    /历史回滚仍在执行，拒绝释放 thread session/,
  );
  assert.equal(session.getSessionId(), "session-demo");

  resolveBeforeRead(createRollbackThreadRead(["provider-1", "provider-2"]));
  await pendingRollback;
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession rollbackHistory 在 provider 历史未裁剪时显式标记 mutation unknown", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        return createRollbackThreadRead(["provider-1", "provider-2"]);
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-2"], retainedTurnId: "provider-1" }),
    (error: any) => error?.code === "codex_thread_rollback_state_unknown"
      && error?.providerMutationMayHaveApplied === true
      && /provider 历史未按预期裁剪/.test(String(error?.message ?? "")),
  );
  assert.equal(readCount, 5);
  assert.equal(requests.filter((request) => request.method === "thread/rollback").length, 1);
});

test("CodexAppServerThreadSession rollbackHistory 拒绝错误 provider threadId", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        return createRollbackThreadRead(["provider-1"], { threadId: "session-other" });
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    /thread\/read 返回了错误 threadId：session-other/,
  );
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 拒绝 provider active thread", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        return createRollbackThreadRead(["provider-1"], {
          threadStatus: "active",
          runningTurnIds: ["provider-1"],
        });
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    /thread\/read 未返回 idle thread：active/,
  );
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
});

test("CodexAppServerThreadSession rollbackHistory 在 persistent Goal idle gap 时拒绝 prepare", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    goalResponse: {
      goal: { threadId: "session-demo", status: "active" },
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    (error: any) => error?.code === "codex_provider_foreign_active"
      && error?.providerGoalStatus === "active"
      && error?.providerMutation === "rollback",
  );

  assert.equal(requests.filter((request) => request.method === "thread/goal/get").length, 1);
  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession rollbackHistory prepare 后 lifecycle 换代时拒绝 apply", async () => {
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") return createRollbackThreadRead(["provider-1"]);
      return {};
    },
  });
  const prepared = await session.prepareRollbackHistory(1, {
    droppedTurnIds: ["provider-1"],
    retainedTurnId: null,
  });
  (session as any).onAppServerMessage({
    method: "thread/goal/updated",
    params: { threadId: "session-demo", goal: { threadId: "session-demo", status: "active" } },
  });

  await assert.rejects(
    session.applyPreparedRollbackHistory(prepared!),
    (error: any) => error?.code === "codex_provider_active_preflight_stale"
      && error?.providerMutation === "rollback",
  );

  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession rollbackHistory apply 读取期间 lifecycle 换代时拒绝 mutation", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        if (readCount === 2) {
          (sessionRef as any).onAppServerMessage({
            method: "turn/started",
            params: { threadId: "session-demo", turn: { id: "turn-foreign", status: "inProgress" } },
          });
          (sessionRef as any).onAppServerMessage({
            method: "turn/completed",
            params: { threadId: "session-demo", turn: { id: "turn-foreign", status: "completed" } },
          });
          (sessionRef as any).onAppServerMessage({
            method: "thread/status/changed",
            params: { threadId: "session-demo", status: { type: "idle" } },
          });
        }
        return createRollbackThreadRead(["provider-1"]);
      }
      return {};
    },
  });
  sessionRef = session;
  const prepared = await session.prepareRollbackHistory(1, {
    droppedTurnIds: ["provider-1"],
    retainedTurnId: null,
  });

  await assert.rejects(
    session.applyPreparedRollbackHistory(prepared!),
    (error: any) => error?.code === "codex_provider_active_preflight_stale"
      && error?.providerMutation === "rollback",
  );

  assert.equal(requests.some((request) => request.method === "thread/rollback"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession rollbackHistory 对 unsupported RPC 返回稳定错误码", async () => {
  const { session } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") return createRollbackThreadRead(["provider-1"]);
      if (method === "thread/rollback") throw new Error("Method not found: thread/rollback");
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    (error: any) => error?.code === "codex_thread_rollback_unsupported"
      && error?.providerMutationMayHaveApplied !== true
      && error?.method === "thread/rollback",
  );
});

test("CodexAppServerThreadSession rollbackHistory 在 rollback 后回读持续失败时保留 mutation unknown", async () => {
  let readCount = 0;
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/read") {
        readCount += 1;
        if (readCount <= 2) return createRollbackThreadRead(["provider-1", "provider-2"]);
        throw new Error("thread/read unavailable after rollback");
      }
      return {};
    },
  });

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-2"], retainedTurnId: "provider-1" }),
    (error: any) => error?.code === "codex_thread_rollback_state_unknown"
      && error?.providerMutationMayHaveApplied === true
      && /thread\/read unavailable after rollback/.test(String(error?.message ?? "")),
  );
  assert.equal(readCount, 5);
  assert.equal(requests.filter((request) => request.method === "thread/rollback").length, 1);
});

test("CodexAppServerThreadSession 启动中拒绝并发 rollback", async () => {
  let rejectTurnStart!: (error: Error) => void;
  const turnStart = new Promise((_resolve, reject) => {
    rejectTurnStart = reject;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return await turnStart;
      return {};
    },
  });
  const pendingSend = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "启动中禁止回滚",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await assert.rejects(
    session.rollbackHistory(1, { droppedTurnIds: ["provider-1"], retainedTurnId: null }),
    /当前 thread 有未完成的 turn/,
  );
  assert.equal(requests.some((request) => request.method === "thread\/rollback"), false);
  rejectTurnStart(createExplicitTurnStartRejection(
    "turn/start rejected",
    "rollback-concurrent-start-rejection",
  ));
  await assert.rejects(pendingSend, /turn\/start rejected/);
});

test("CodexAppServerThreadSession active handoff 前收到 terminal 会立即做权威对账", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
        });
        return { turn: { id: "turn-engine" } };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{
              id: "turn-engine",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user" }],
            }],
          },
        };
      }
      return {};
    },
  });
  sessionRef = harness.session;

  const result = await harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "terminal 与响应同批到达",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });

  assert.deepEqual(result, { responseText: "" });
  assert.equal(harness.requests.filter((request) => (
    request.method === "thread/read" && (request.params as any)?.includeTurns === true
  )).length, 1);
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession handoff thread/read 首次失败后会重试权威对账", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let readCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
        });
        return { turn: { id: "turn-engine" } };
      }
      if (method === "thread/read") {
        readCalls += 1;
        if (readCalls === 1) throw new Error("thread/read transient failure");
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{
              id: "turn-engine",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user" }],
            }],
          },
        };
      }
      return {};
    },
  });
  sessionRef = harness.session;

  const result = await harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "handoff read transient failure",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });

  assert.deepEqual(result, { responseText: "" });
  assert.equal(readCalls, 2);
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession handoff 会拒绝错误 threadId 的 read 并重新读取", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let readCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
        });
        return { turn: { id: "turn-engine" } };
      }
      if (method === "thread/read") {
        readCalls += 1;
        return {
          thread: {
            id: readCalls === 1 ? "session-other" : "session-demo",
            status: { type: "idle" },
            turns: [{
              id: "turn-engine",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user" }],
            }],
          },
        };
      }
      return {};
    },
  });
  sessionRef = harness.session;

  await harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "handoff wrong thread read",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });

  assert.equal(readCalls, 2);
  assert.equal(harness.session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession 绑定前旧 idle 不会污染随后启动的 provider turn", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let readCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "thread/status/changed",
          params: { threadId: "session-demo", status: { type: "idle" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "thread/status/changed",
          params: { threadId: "session-demo", status: { type: "active" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "turn/started",
          params: { threadId: "session-demo", turn: { id: "turn-current", status: "inProgress" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "item/started",
          params: {
            threadId: "session-demo",
            turnId: "turn-current",
            item: { type: "userMessage", id: "provider-user", clientId: "item-user", content: [] },
          },
        });
        return { turn: { id: "turn-current" } };
      }
      if (method === "thread/read") {
        readCalls += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{ id: "turn-history", status: "completed", items: [] }],
          },
        };
      }
      return {};
    },
  });
  sessionRef = harness.session;
  let sendSettled = false;
  const pending = harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "stale thread-only terminal hint",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    sendSettled = true;
  });
  await waitForActiveTurn(harness.session);

  assert.equal(readCalls, 0);
  assert.equal(sendSettled, false);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal((harness.session as any).active?.codexTurnId, "turn-current");
  assert.equal(readCalls, 0);
  assert.equal(sendSettled, false);
  assert.equal((harness.session as any).active?.codexTurnBindingSource, "start_result");

  (sessionRef as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-current", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
  assert.equal(readCalls, 0);
});

test("CodexAppServerThreadSession handoff 忽略 retired turn 的迟到 terminal", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  let readCalls = 0;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-retired", status: "completed" } },
        });
        (sessionRef as any).onAppServerMessage({
          method: "item/started",
          params: {
            threadId: "session-demo",
            turnId: "turn-current",
            item: { type: "userMessage", id: "provider-user", clientId: "item-user", content: [] },
          },
        });
        return { turn: { id: "turn-current" } };
      }
      if (method === "thread/read") {
        readCalls += 1;
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{ id: "turn-retired", status: "completed", items: [] }],
          },
        };
      }
      return {};
    },
  });
  sessionRef = harness.session;
  (harness.session as any).retiredCodexTurnIds.add("turn-retired");
  let sendSettled = false;
  const pending = harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "retired handoff terminal",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    sendSettled = true;
  });
  await waitForActiveTurn(harness.session);

  assert.equal(readCalls, 0);
  assert.equal(sendSettled, false);
  assert.equal((harness.session as any).active?.codexTurnId, "turn-current");
  (sessionRef as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-current", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession handoff foreign terminal 不触发 read 或替换响应 ID", async () => {
  let sessionRef: CodexAppServerThreadSession | null = null;
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") {
        (sessionRef as any).onAppServerMessage({
          method: "turn/completed",
          params: { threadId: "session-demo", turn: { id: "turn-stale", status: "completed" } },
        });
        return { turn: { id: "turn-current" } };
      }
      if (method === "thread/read") {
        assert.fail("foreign terminal 不应触发 thread/read");
      }
      return {};
    },
  });
  sessionRef = harness.session;
  let sendSettled = false;
  const pending = harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "stale terminal before response turn persistence",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  }).finally(() => {
    sendSettled = true;
  });
  await waitForActiveTurn(harness.session);

  assert.equal(sendSettled, false);
  assert.equal((harness.session as any).active?.codexTurnId, "turn-current");
  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  (sessionRef as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-current", status: "completed" } },
  });
  assert.deepEqual(await pending, { responseText: "" });
});

test("CodexAppServerThreadSession 立即停止会先等待 handoff 权威 completed 且不再重复中断", async () => {
  let resolveTurnStart!: (value: unknown) => void;
  const turnStart = new Promise((resolve) => {
    resolveTurnStart = resolve;
  });
  const { session, requests } = createSendHarness("session-demo", {
    async request(method) {
      if (method === "turn/start") return await turnStart;
      if (method === "thread/read") {
        return {
          thread: {
            id: "session-demo",
            status: { type: "idle" },
            turns: [{
              id: "turn-engine",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user" }],
            }],
          },
        };
      }
      return {};
    },
  });
  const pendingSend = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "停止与 handoff completed 同时到达",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  while (!requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const pendingInterrupt = session.interrupt("turn-client" as any);
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: "session-demo", turn: { id: "turn-engine", status: "completed" } },
  });
  resolveTurnStart({ turn: { id: "turn-engine" } });

  assert.equal(await pendingInterrupt, true);
  assert.deepEqual(await pendingSend, { responseText: "" });
  assert.equal(requests.filter((request) => (
    request.method === "thread/read" && (request.params as any)?.includeTurns === true
  )).length, 1);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession interrupt ACK 成功后不会中断 foreign successor", async () => {
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/interrupt") {
        const providerTurnId = String((params as any)?.turnId ?? "");
        if (providerTurnId === "turn-engine") {
          (harness.session as any).onAppServerMessage({
            method: "turn/started",
            params: { threadId: "session-demo", turn: { id: "turn-successor", status: "inProgress" } },
          });
          return {};
        }
        assert.fail(`不应中断 foreign successor：${providerTurnId}`);
      }
      assert.fail(`interrupt ACK 后不应继续请求 provider：${method}`);
    },
  });

  assert.equal(await harness.session.interrupt("turn-client" as any), true);
  assert.deepEqual(
    harness.requests.map((request) => [request.method, (request.params as any)?.turnId ?? null]),
    [["turn/interrupt", "turn-engine"]],
  );
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupt_acknowledged");
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
});

test("CodexAppServerThreadSession provider-native deny 在精确 interrupt ACK 后立即失败", async () => {
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/interrupt") {
        assert.equal((params as any)?.turnId, "turn-engine");
        return {};
      }
      assert.fail(`interrupt ACK 后不应继续请求 provider：${method}`);
    },
  });
  (harness.session as any).currentProviderNativeToolPolicy = "deny";

  (harness.session as any).onAppServerMessage({
    id: 91,
    method: "item/tool/requestUserInput",
    params: { threadId: "session-demo", turnId: "turn-engine", questions: [] },
  });
  await flushMicrotasksUntil(
    () => Boolean(harness.getRejected()),
    "provider-native deny 未在精确 interrupt ACK 后收口",
  );
  assert.deepEqual(harness.responses, [{ id: 91, result: { answers: {} } }]);
  assert.equal(harness.rawEvents.some((event) => (event.data as any)?.method === "item/tool/requestUserInput"), true);
  assert.match(harness.getRejected()?.message ?? "", /requestUserInput/);
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/interrupt"]);
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupt_acknowledged");
});

test("CodexAppServerThreadSession provider-native deny 不会把 foreign Goal 请求归给当前 turn", async () => {
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/interrupt") assert.fail("foreign Goal request 不得中断当前本地 turn");
      return {};
    },
  });
  (harness.session as any).currentProviderNativeToolPolicy = "deny";

  (harness.session as any).onAppServerMessage({
    id: 92,
    method: "item/tool/requestUserInput",
    params: { threadId: "session-demo", turnId: "turn-goal", questions: [] },
  });
  await Promise.resolve();

  assert.deepEqual(harness.responses, [{ id: 92, result: { answers: {} } }]);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(harness.getRejected(), null);
  assert.equal((harness.session as any).active.interruptTerminalError ?? null, null);
  assert.equal((harness.session as any).pendingRequests.size, 0);
  assert.equal(harness.rawEvents.some((event) => (event.data as any)?.params?.turnId === "turn-goal"), false);
});

test("CodexAppServerThreadSession provider-native deny 在本地 idle 时响应且隔离 foreign raw", async () => {
  const harness = createSessionHarness({}, {
    async request(method) {
      if (method === "turn/interrupt") assert.fail("本地 idle 时不得中断 provider turn");
      return {};
    },
  });
  (harness.session as any).active = null;
  (harness.session as any).currentProviderNativeToolPolicy = "deny";

  (harness.session as any).onAppServerMessage({
    id: 93,
    method: "item/tool/requestUserInput",
    params: { threadId: "session-demo", turnId: "turn-goal-idle", questions: [] },
  });
  await Promise.resolve();

  assert.deepEqual(harness.responses, [{ id: 93, result: { answers: {} } }]);
  assert.equal(harness.requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal((harness.session as any).pendingRequests.size, 0);
  assert.equal(harness.rawEvents.some((event) => (event.data as any)?.params?.turnId === "turn-goal-idle"), false);
});

test("CodexAppServerThreadSession foreign approval request 会拒绝且不进入本地 pending", async () => {
  const harness = createSessionHarness({});

  (harness.session as any).onAppServerMessage({
    id: 94,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "session-demo", turnId: "turn-goal", command: "echo foreign" },
  });
  await Promise.resolve();

  assert.equal(harness.responses.length, 1);
  assert.equal(harness.responses[0]?.id, 94);
  assert.equal((harness.responses[0]?.result as any)?.decision, "decline");
  assert.equal((harness.session as any).pendingRequests.size, 0);
  assert.equal(harness.rawEvents.some((event) => (event.data as any)?.params?.turnId === "turn-goal"), false);
  assert.equal(harness.getRejected(), null);
});

test("CodexAppServerThreadSession interrupt ACK 后下一 tick 到达的 foreign successor 不会被中断", async () => {
  const harness = createSessionHarness({}, {
    async request(method, params) {
      if (method === "turn/interrupt") {
        const providerTurnId = String((params as any)?.turnId ?? "");
        if (providerTurnId === "turn-engine") {
          setImmediate(() => {
            (harness.session as any).onAppServerMessage({
              method: "turn/started",
              params: { threadId: "session-demo", turn: { id: "turn-successor", status: "inProgress" } },
            });
          });
          return {};
        }
        assert.fail(`不应中断 foreign successor：${providerTurnId}`);
      }
      assert.fail(`interrupt ACK 后不应继续请求 provider：${method}`);
    },
  });

  assert.equal(await harness.session.interrupt("turn-client" as any), true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.requests.filter((request) => request.method === "turn/interrupt")
      .map((request) => (request.params as any)?.turnId),
    ["turn-engine"],
  );
  assert.deepEqual(harness.requests.map((request) => request.method), ["turn/interrupt"]);
  assert.equal((harness.session as any).active.providerTerminalStatus, "interrupt_acknowledged");
  assert.equal((harness.getRejected() as any)?.code, MANUAL_TURN_INTERRUPT_CODE);
});

test("CodexAppServerThreadSession 正常 clientId 回显不会触发 full ownership 历史扫描", async () => {
  const harness = createSendHarness("session-demo");
  const send = harness.session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "normal ownership echo",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
  }, {
    conversation() {},
    raw() {},
  });
  await waitForActiveTurn(harness.session);
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(
    harness.requests.some((request) => (
      request.method === "thread/turns/list"
      && (request.params as any)?.itemsView === "full"
    )),
    false,
  );
  await completePendingSend(harness.session);
  await send;
});

test("CodexAppServerThreadSession 缺少 provider turnId 时中断失败并保留运行态", async () => {
  const harness = createSessionHarness({}, {
    async request(method) {
      assert.fail(`缺少精确 provider turnId 时不得请求 provider：${method}`);
    },
  });
  const active = (harness.session as any).active;
  active.codexTurnId = null;

  const error = await harness.session.interrupt("turn-client" as any).then(
    () => assert.fail("缺少精确 provider turnId 时不得伪造中断成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );

  assert.equal(error.code, "codex_turn_interrupt_state_unknown");
  assert.equal(error.preserveRunningState, true);
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.getRejected(), null);
  assert.equal(active.providerTerminalStatus ?? null, null);
  assert.equal((harness.session as any).active, active);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(active.manualInterruptRequested, true);
  assert.equal(active.manualInterruptError?.code, MANUAL_TURN_INTERRUPT_CODE);
});

test("Codex 普通会话的新建和恢复沿用补充输入请求与原请求回传", async () => {
  for (const initialSessionId of [null, "session-demo"]) {
    const { session, requests, responses } = createSendHarness(initialSessionId);
    const events: any[] = [];
    const pending = session.sendMessage({
      turnId: "turn-client" as any, userItemId: "item-user" as any,
      text: "请选择运行方式", images: [], assistantItemId: "item-assistant", reasoningItemId: "item-reasoning",
    }, { conversation(event) { events.push(event); }, raw() {} });
    await waitForActiveTurn(session);
    const questions = [{ id: "mode", header: "运行方式", question: "请选择运行方式", isOther: true,
      options: [{ label: "自动", description: "自动继续" }, { label: "手动", description: "手动继续" }] }];
    (session as any).onAppServerMessage({ id: "input-choice", method: "item/tool/requestUserInput", params: {
      threadId: initialSessionId ?? "session-started", turnId: "turn-engine", itemId: "input-item", questions,
    } });
    const answers = { mode: { answers: ["自定义运行方式"] } };
    await session.respondUserInput("input-choice", answers);
    (session as any).onAppServerMessage({ method: "turn/completed", params: {
      threadId: initialSessionId ?? "session-started", turn: { id: "turn-engine", status: "completed" },
    } });
    await pending;
    assert.deepEqual(events.find(event => event.type === "userInput.requested")?.payload.request, {
      requestId: "input-choice", params: { workspaceId: "client-a:ws-demo", threadId: "thread-demo", turnId: "turn-client", itemId: "input-item", questions },
    });
    assert.deepEqual(responses, [{ id: "input-choice", result: { answers } }]);
    assert.deepEqual(events.find(event => event.type === "userInput.resolved")?.payload.response, { requestId: "input-choice", answers });
    assert.equal((requests[0]?.params as any).config?.["features.default_mode_request_user_input"], true);
    assert.equal((requests.find(request => request.method === "turn/start")?.params as any).collaborationMode.mode, "default");
    assert.equal(session.hasActiveTurn(), false);
  }
});

test("Codex 补充输入在终止请求后拒绝回传，回合结束后清理旧请求", async () => {
  const { session, responses } = createSessionHarness({});
  (session as any).onAppServerMessage({ id: "stopping-input", method: "item/tool/requestUserInput", params: {
    threadId: "session-demo", turnId: "turn-engine", questions: [{ id: "mode", header: "方式", question: "请选择方式" }],
  } });
  (session as any).active.manualInterruptRequested = true;
  await assert.rejects(session.respondUserInput("stopping-input", { mode: { answers: ["自动"] } }), /已失效/u);
  assert.deepEqual(responses, []);

  const harness = createSendHarness(null);
  const pending = harness.session.sendMessage({
    turnId: "turn-client" as any, userItemId: "item-user" as any, text: "请提问", images: [],
    assistantItemId: "item-assistant", reasoningItemId: "item-reasoning",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  (harness.session as any).onAppServerMessage({ id: "expired-input", method: "item/tool/requestUserInput", params: {
    threadId: "session-started", turnId: "turn-engine", questions: [{ id: "mode", header: "方式", question: "请选择方式" }],
  } });
  (harness.session as any).onAppServerMessage({ method: "turn/completed", params: {
    threadId: "session-started", turn: { id: "turn-engine", status: "completed" },
  } });
  await pending;
  assert.equal((harness.session as any).pendingRequests.size, 0);
  await assert.rejects(harness.session.respondUserInput("expired-input", { mode: { answers: ["自动"] } }));
  assert.deepEqual(harness.responses, []);
});

test("CodexAppServerThreadSession 创建会话忽略历史窗口并下发模型最大容量", async () => {
  const { session, requests } = createSendHarness(null);
  const pending = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "hello",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    contextWindow: 300_000,
  }, {
    conversation() {},
    raw() {},
  });

  await completePendingSend(session);
  await pending;

  assert.equal(requests[0]?.method, "thread/start");
  assert.deepEqual(requests[0]?.params, {
    cwd: "Z:/code/codeflowai",
    approvalPolicy: "on-request",
    config: { "features.default_mode_request_user_input": true, model_context_window: 372_000, model_auto_compact_token_limit: 353_400 },
    developerInstructions: withCodexExecutionInstructions(),
  });
});

test("CodexAppServerThreadSession injects required dynamic tools into thread/start for fresh native tool sessions", async () => {
  const { session, requests } = createSendHarness(null);
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: null,
      description: "管理当前聊天窗口中的长驻进程",
      runtime: "builtin",
      usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
      invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const dynamicToolName = buildCodexDynamicToolNameByToolId(toolRegistry).get("runtime.manageBackgroundService");
  const pending = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "启动本地健康检查",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    responseFormat: "text",
    toolRegistry,
    platformToolTransportRequirement: "required",
  }, {
    conversation() {},
    raw() {},
  });

  await completePendingSend(session);
  await pending;

  assert.equal(requests[0]?.method, "thread/start");
  assert.deepEqual((requests[0]?.params as any)?.dynamicTools, [{
    name: dynamicToolName,
    description: [
      "名称：管理进程",
      "说明：管理当前聊天窗口中的长驻进程",
      "使用边界：仅用于需要在页面里统一管理的长驻进程",
      "调用提示：{\"action\":\"status\",\"serviceId\":\"demo\"}",
    ].join("\n"),
    inputSchema: { type: "object" },
  }]);
});

test("buildCodexDynamicToolNameByToolId emits provider-safe names for dotted tool ids", () => {
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_requirement_analysis__" as any,
      toolsetName: "需求分析",
      toolId: "runtime.submitRequirementAnalysisTurnResult" as any,
      name: "提交需求分析结果",
      alias: null,
      description: "提交需求分析结果",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };

  const dynamicToolName = buildCodexDynamicToolNameByToolId(toolRegistry).get("runtime.submitRequirementAnalysisTurnResult");
  assert.ok(dynamicToolName);
  assert.match(dynamicToolName ?? "", /^[a-zA-Z0-9_-]+$/);
  assert.equal(dynamicToolName?.includes("."), false);
  assert.equal(dynamicToolName, "aidt_runtime_submitRequirementAnalysisTurnResult");
});

test("CodexAppServerThreadSession keeps the active turn alive while a quiet commandExecution is still provider-active", async () => {
  const { session, requests, threadHandlers } = createSendHarness("session-demo");
  const pending = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "启动静默 dev server",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    timeoutPolicy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: 40,
    },
  }, {
    conversation() {},
    raw() {},
  });

  await waitForActiveTurn(session);
  threadHandlers.find((handler) => handler.threadId === "session-demo")!.onMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        id: "cmd-quiet",
        type: "commandExecution",
        processId: "40431",
        command: "pwsh -Command pnpm -C apps/web dev --host 127.0.0.1 --port 39281",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal((session as any).active?.clientTurnId, "turn-client");

  await completePendingSend(session);
  await pending;
});

test("buildCodexDynamicToolNameByToolId de-dupes sanitize collisions deterministically", () => {
  const toolA: ExecutableToolRegistry["tools"][number] = {
    toolsetId: "__runtime_collision__" as any,
    toolsetName: "冲突 1",
    toolId: "runtime.a.b" as any,
    name: "冲突 1",
    alias: null,
    description: "冲突 1",
    runtime: "builtin",
    usageGuidance: null,
    invocationHint: null,
    code: "",
    inputSchema: "{\"type\":\"object\"}",
    outputSchema: "{\"type\":\"object\"}",
    timeoutMs: null,
    workingDirectory: null,
    permissions: { requiresWrite: false },
    envPolicy: null,
    required: false,
  };
  const toolB: ExecutableToolRegistry["tools"][number] = {
    toolsetId: "__runtime_collision__" as any,
    toolsetName: "冲突 2",
    toolId: "runtime.a_b" as any,
    name: "冲突 2",
    alias: null,
    description: "冲突 2",
    runtime: "builtin",
    usageGuidance: null,
    invocationHint: null,
    code: "",
    inputSchema: "{\"type\":\"object\"}",
    outputSchema: "{\"type\":\"object\"}",
    timeoutMs: null,
    workingDirectory: null,
    permissions: { requiresWrite: false },
    envPolicy: null,
    required: false,
  };

  const nameByToolId = buildCodexDynamicToolNameByToolId({ tools: [toolA, toolB] });
  const reversedNameByToolId = buildCodexDynamicToolNameByToolId({ tools: [toolB, toolA] });
  assert.equal(nameByToolId.get("runtime.a.b"), "aidt_runtime_a_b");
  assert.equal(nameByToolId.get("runtime.a_b"), "aidt_runtime_a_b_2");
  assert.deepEqual(Array.from(nameByToolId.entries()), Array.from(reversedNameByToolId.entries()));
});

test("supportsCodexNativeDynamicToolTransport accepts OpenAI-compatible relay upstreams", () => {
  assert.equal(supportsCodexNativeDynamicToolTransport(null), true);
  assert.equal(supportsCodexNativeDynamicToolTransport("https://api.openai.com/v1"), true);
  assert.equal(supportsCodexNativeDynamicToolTransport("https://demo.openai.azure.com/openai/v1"), true);
  assert.equal(supportsCodexNativeDynamicToolTransport("http://127.0.0.1:8092/api-relay/openai"), true);
  assert.equal(supportsCodexNativeDynamicToolTransport("not-a-url"), false);
});

test("CodexAppServerThreadSession turn/start timeout 仅在迟到明确拒绝后释放 fence", async () => {
  const explicitRejection = createExplicitTurnStartRejection(
    "turn/start rejected after timeout",
    "late-turn-start-explicit-rejection",
  );
  const { session, requests } = createSendHarness("session-healthy", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") {
        throw createTrackedTurnStartTimeout(Promise.resolve({
          status: "rejected",
          kind: "rpc_error",
          reason: explicitRejection,
        }));
      }
      assert.fail(`迟到明确拒绝不得触发额外 RPC：${method}`);
    },
  });

  const error = await session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "分析事件",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    responseFormat: "text",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("turn/start timeout 不得伪造发送成功"),
    (cause: unknown) => cause as Error & { code?: string; preserveRunningState?: boolean },
  );

  assert.equal(error.code, "codex_turn_start_state_unknown");
  assert.equal(error.preserveRunningState, true);
  await waitForCondition(
    () => !session.hasActiveTurn(),
    "迟到明确 RPC rejection 未释放 provider fence",
  );
  assert.equal(session.getActiveTurnId(), null);
  assert.equal(session.getSessionId(), "session-healthy");
  assert.deepEqual(requests.map((request) => request.method), ["thread/resume", "turn/start"]);
});

for (const unavailableMessage of ["no rollout found", "thread not found"]) {
test(`CodexAppServerThreadSession resume 返回 ${unavailableMessage} 时保留原 binding 并停止发送`, async () => {
  const harness = createSendHarness("session-missing-rollout", {
    passthroughProviderPreflight: true,
    onSessionBindingDropped() {
      assert.fail("resume 失败不得清理原 binding");
    },
    onSessionBinding() {
      assert.fail("resume 失败不得创建替代 binding");
    },
    async request(method) {
      if (method === "thread/resume") {
        throw new Error(unavailableMessage);
      }
      assert.fail(`resume 失败后不得发送 provider mutation：${method}`);
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-next" as any,
    userItemId: "item-next" as any,
    text: "继续正常运行",
    images: [],
    assistantItemId: "assistant-next",
    reasoningItemId: "reasoning-next",
  }, { conversation() {}, raw() {} }), new RegExp(unavailableMessage));

  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(harness.session.getSessionId(), "session-missing-rollout");
});
}

test("CodexAppServerThreadSession thread/resume 普通错误原样上抛", async () => {
  const resumeError = Object.assign(new Error("Codex app-server temporarily unavailable"), {
    code: "codex_app_server_unavailable",
    method: "thread/resume",
  });
  const harness = createSendHarness("session-existing", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/resume") throw resumeError;
      assert.fail(`thread/resume 失败后不得发送 provider mutation：${method}`);
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-resume-failed" as any,
    userItemId: "item-resume-failed" as any,
    text: "继续",
    images: [],
    assistantItemId: "assistant-resume-failed",
    reasoningItemId: "reasoning-resume-failed",
  }, { conversation() {}, raw() {} }), (error: unknown) => error === resumeError);

  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume"]);
  assert.equal(harness.session.getSessionId(), "session-existing");
  assert.equal(harness.session.isRecoveryPending(), true);
});

test("CodexAppServerThreadSession thread/resume 成功即继续 turn/start", async () => {
  const harness = createSendHarness("session-existing", {
    passthroughProviderPreflight: true,
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return { turn: { id: "turn-after-resume" } };
      assert.fail(`恢复发送链不得调用额外方法：${method}`);
    },
  });

  const pending = harness.session.sendMessage({
    turnId: "turn-resume-succeeded" as any,
    userItemId: "item-resume-succeeded" as any,
    text: "继续",
    images: [],
    assistantItemId: "assistant-resume-succeeded",
    reasoningItemId: "reasoning-resume-succeeded",
  }, { conversation() {}, raw() {} });
  await waitForActiveTurn(harness.session);
  await completePendingSend(harness.session);
  await pending;

  assert.deepEqual(harness.requests.map((request) => request.method), ["thread/resume", "turn/start"]);
  assert.equal(harness.session.getSessionId(), "session-existing");
  assert.equal(harness.session.isRecoveryPending(), false);
});

test("CodexAppServerThreadSession keeps the thread session and leaves dynamic-tool capability unconfirmed when upstream rejects tool registration", async () => {
  let dropped = 0;
  const { session } = createSendHarness(null, {
    onSessionBindingDropped() {
      dropped += 1;
    },
    async request(method, params) {
      if (method === "thread/start") return { thread: { id: "session-started" } };
      if (method === "turn/start") {
        throw new Error("{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Invalid 'tools[0].name': string does not match pattern\",\"param\":\"tools[0].name\",\"relay\":{\"code\":\"400501\"}}}");
      }
      return {};
    },
  });

  await assert.rejects(
    session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "启动本地健康检查",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    responseFormat: "text",
    toolRegistry: {
      tools: [{
        toolsetId: "__runtime_managed_service__" as any,
        toolsetName: "内建进程",
        toolId: "runtime.manageBackgroundService" as any,
        name: "管理进程",
        alias: null,
        description: "管理当前聊天窗口中的长驻进程",
        runtime: "builtin",
        usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
        invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
        code: "",
        inputSchema: "{\"type\":\"object\"}",
        outputSchema: "{\"type\":\"object\"}",
        timeoutMs: null,
        workingDirectory: null,
        permissions: { requiresWrite: false },
        envPolicy: null,
        required: false,
      }],
    },
  }, {
    conversation() {},
    raw() {},
  }),
    (error: any) =>
      String(error?.message ?? "").includes("invalid_request_error")
      && String(error?.message ?? "").includes("400501"),
  );
  assert.equal(session.getSessionId(), "session-started");
  assert.equal(dropped, 0);
});

test("CodexAppServerThreadSession does not clear a healthy session binding on unrelated invalid_request_error", async () => {
  let dropped = 0;
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: null,
      description: "管理当前聊天窗口中的长驻进程",
      runtime: "builtin",
      usageGuidance: "仅用于需要在页面里统一管理的长驻进程",
      invocationHint: "{\"action\":\"status\",\"serviceId\":\"demo\"}",
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const { session } = createSendHarness("session-healthy", {
    initialSessionCapabilities: {
      codexDynamicToolIds: ["runtime.manageBackgroundService"],
      codexDynamicToolBindingVersion: "runtime.manageBackgroundService=>aidt_runtime_manageBackgroundService",
    },
    onSessionBindingDropped() {
      dropped += 1;
    },
    async request(method) {
      if (method === "turn/start") {
        throw new Error("{\"error\":{\"type\":\"invalid_request_error\",\"message\":\"unsupported reasoning_effort value\"}}");
      }
      return {};
    },
  });

  await assert.rejects(
    session.sendMessage({
      turnId: "turn-client" as any,
      userItemId: "item-user" as any,
      text: "启动本地健康检查",
      images: [],
      assistantItemId: "item-assistant",
      reasoningItemId: "item-reasoning",
      responseFormat: "text",
      toolRegistry,
    }, {
      conversation() {},
      raw() {},
    }),
    /unsupported reasoning_effort value/,
  );
  assert.equal(session.getSessionId(), "session-healthy");
  assert.equal(dropped, 0);
  assert.equal(session.resolvePlatformToolTransport(toolRegistry), "native-dynamic");
});

test("CodexAppServerThreadSession 恢复会话忽略历史窗口并下发模型最大容量", async () => {
  const { session, requests } = createSendHarness("session-demo");
  const pending = session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "hello",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    contextWindow: 400_000,
  }, {
    conversation() {},
    raw() {},
  });

  await completePendingSend(session);
  await pending;

  assert.equal(requests[0]?.method, "thread/resume");
  assert.deepEqual(requests[0]?.params, {
    threadId: "session-demo",
    excludeTurns: true,
    cwd: "Z:/code/codeflowai",
    approvalPolicy: "on-request",
    config: { "features.default_mode_request_user_input": true, model_context_window: 372_000, model_auto_compact_token_limit: 353_400 },
    developerInstructions: withCodexExecutionInstructions(),
  });
  assert.equal(requests[1]?.method, "turn/start");
});

test("CodexAppServerThreadSession 旧窗口值变化不改变模型最大容量且不退订", async () => {
  let turnStartCount = 0;
  const { session, requests } = createSendHarness(null, {
    async request(method) {
      if (method === "thread/start") return { thread: { id: "session-started" } };
      if (method === "turn/start") {
        turnStartCount += 1;
        return { turn: { id: `turn-engine-${turnStartCount}` } };
      }
      return {};
    },
  });

  const firstPending = session.sendMessage({
    turnId: "turn-client-1" as any,
    userItemId: "item-user-1" as any,
    text: "hello",
    images: [],
    assistantItemId: "item-assistant-1",
    reasoningItemId: "item-reasoning-1",
    contextWindow: 300_000,
  }, {
    conversation() {},
    raw() {},
  });
  await completePendingSend(session);
  await firstPending;

  requests.length = 0;

  const secondPending = session.sendMessage({
    turnId: "turn-client-2" as any,
    userItemId: "item-user-2" as any,
    text: "hello again",
    images: [],
    assistantItemId: "item-assistant-2",
    reasoningItemId: "item-reasoning-2",
    contextWindow: 600_000,
  }, {
    conversation() {},
    raw() {},
  });
  await completePendingSend(session);
  await secondPending;

  assert.equal(requests[0]?.method, "thread/resume");
  assert.deepEqual(requests[0]?.params, {
    threadId: "session-started",
    excludeTurns: true,
    cwd: "Z:/code/codeflowai",
    approvalPolicy: "on-request",
    config: { "features.default_mode_request_user_input": true, model_context_window: 372_000, model_auto_compact_token_limit: 353_400 },
    developerInstructions: withCodexExecutionInstructions(),
  });
  const startIndex = requests.findIndex((request) => request.method === "turn/start");
  assert.equal(requests.some((request) => request.method === "thread/goal/get"), false);
  assert.equal(requests.some((request) => request.method === "thread/read"), false);
  assert.equal(startIndex, 1);
  assert.equal(requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(requests.some((request) => request.method === "thread/start"), false);
  assert.equal(requests.some((request) => request.method === "thread/fork"), false);
});

test("CodexAppServerThreadSession 配置变化直接在原 binding 上 resume 且不退订", async () => {
  const harness = createSendHarness("session-demo", {
    async request(method) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return { turn: { id: "turn-config-refreshed" } };
      assert.fail(`配置恢复链不得发送：${method}`);
    },
  });
  (harness.session as any).registered = true;
  (harness.session as any).resumed = true;
  (harness.session as any).appliedContextWindow = 300_000;
  (harness.session as any).appliedModelAutoCompactTokenLimit = 285_000;

  const pending = harness.session.sendMessage({
    turnId: "turn-config-refreshed" as any,
    userItemId: "item-config-refreshed" as any,
    text: "refresh config",
    images: [],
    assistantItemId: "assistant-config-refreshed",
    reasoningItemId: "reasoning-config-refreshed",
    contextWindow: 600_000,
  }, {
    conversation() {},
    raw() {},
  });
  await completePendingSend(harness.session);
  await pending;

  assert.equal(harness.session.getSessionId(), "session-demo");
  assert.equal((harness.session as any).registered, true);
  assert.equal((harness.session as any).resumed, true);
  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/resume", "turn/start"],
  );
  assert.equal(harness.requests.some((request) => request.method === "thread/unsubscribe"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/start"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/fork"), false);
});

test("CodexAppServerThreadSession 切换模型时改用新模型最大窗口", async () => {
  const { session, requests } = createSendHarness(null);

  const firstPending = session.sendMessage({
    turnId: "turn-client-1" as any,
    userItemId: "item-user-1" as any,
    text: "hello",
    images: [],
    assistantItemId: "item-assistant-1",
    reasoningItemId: "item-reasoning-1",
    model: "gpt-5.4",
    contextWindow: 300_000,
  }, {
    conversation() {},
    raw() {},
  });
  await completePendingSend(session);
  await firstPending;

  requests.length = 0;

  const secondPending = session.sendMessage({
    turnId: "turn-client-2" as any,
    userItemId: "item-user-2" as any,
    text: "hello again",
    images: [],
    assistantItemId: "item-assistant-2",
    reasoningItemId: "item-reasoning-2",
    model: "gpt-6-astra",
  }, {
    conversation() {},
    raw() {},
  });
  await completePendingSend(session);
  await secondPending;

  assert.equal(requests[0]?.method, "thread/resume");
  assert.deepEqual(requests[0]?.params, {
    threadId: "session-started",
    excludeTurns: true,
    cwd: "Z:/code/codeflowai",
    approvalPolicy: "on-request",
    config: { "features.default_mode_request_user_input": true, model_context_window: 872_000, model_auto_compact_token_limit: 828_400 },
    developerInstructions: withCodexExecutionInstructions(),
  });
  assert.equal(requests.some((request) => request.method === "thread/unsubscribe"), false);
  const startIndex = requests.findIndex((request) => request.method === "turn/start");
  assert.equal(requests.some((request) => request.method === "thread/goal/get"), false);
  assert.equal(requests.some((request) => request.method === "thread/read"), false);
  assert.equal(startIndex, 1);
  assert.equal((requests[startIndex]?.params as any)?.model, "gpt-6-astra");
});

test("CodexAppServerThreadSession required dynamic tools 能力未知时拒绝恢复且不伪造绑定", async () => {
  let dropped = 0;
  let bindingWrites = 0;
  const { session, requests } = createSendHarness("session-legacy", {
    initialSessionCapabilities: null,
    onSessionBindingDropped() {
      dropped += 1;
    },
    onSessionBinding() {
      bindingWrites += 1;
    },
    async request(method) {
      assert.fail(`能力未知时不得发送 provider RPC：${method}`);
    },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "提交需求分析结果",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    responseFormat: "text",
    toolRegistry: createRequiredDynamicToolRegistry(),
    platformToolTransportRequirement: "required",
    conversationProfile: "orchestration",
  }, {
    conversation() {},
    raw() {},
  }), (error: any) => error.code === "codex_thread_capability_incompatible" && error.providerThreadId === "session-legacy");

  assert.equal(dropped, 0);
  assert.equal(bindingWrites, 0);
  assert.deepEqual(requests, []);
  assert.equal(session.getSessionId(), "session-legacy");
});

/** 构造轮换准入测试使用的单一 required 动态工具。 */
function createRequiredDynamicToolRegistry(): ExecutableToolRegistry {
  return {
    tools: [{
      toolsetId: "__runtime_requirement_analysis__" as any,
      toolsetName: "需求分析",
      toolId: "runtime.submitRequirementAnalysisTurnResult" as any,
      name: "提交需求分析结果",
      alias: null,
      description: "提交需求分析结果",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
}

test("CodexAppServerThreadSession required dynamic tools 明确版本不匹配时保留原 binding", async () => {
  const droppedSessionIds: Array<string | null> = [];
  const bindingWrites: Array<{ sessionId: string; capabilities: Record<string, unknown> | null }> = [];
  const startAttempts: unknown[] = [];
  const bindingVersion = buildCodexDynamicToolBindingVersion(createRequiredDynamicToolRegistry());
  const { session, requests } = createSendHarness("session-legacy", {
    initialSessionCapabilities: {
      codexDynamicToolIds: ["runtime.submitRequirementAnalysisTurnResult"],
      codexDynamicToolBindingVersion: `${bindingVersion}-old`,
    },
    onSessionBindingDropped(expectedSessionId) {
      droppedSessionIds.push(expectedSessionId);
    },
    onSessionBinding(sessionId, capabilities) {
      bindingWrites.push({ sessionId, capabilities });
    },
    onStartAttempt(input) {
      startAttempts.push(input);
    },
    async request(method) {
      if (method === "thread/resume") return {};
      assert.fail(`能力明确不兼容时不得继续 mutation：${method}`);
    },
  });

  const error = await session.sendMessage({
    turnId: "turn-client" as any,
    userItemId: "item-user" as any,
    text: "提交需求分析结果",
    images: [],
    assistantItemId: "item-assistant",
    reasoningItemId: "item-reasoning",
    responseFormat: "text",
    toolRegistry: createRequiredDynamicToolRegistry(),
    platformToolTransportRequirement: "required",
    conversationProfile: "orchestration",
  }, {
    conversation() {},
    raw() {},
  }).then(
    () => assert.fail("持久化能力明确不兼容时不得发送输入"),
    (cause: unknown) => cause as Error & { code?: string; providerThreadId?: string },
  );

  assert.equal(error.code, "codex_thread_capability_incompatible");
  assert.equal(error.providerThreadId, "session-legacy");
  assert.deepEqual(droppedSessionIds, []);
  assert.deepEqual(bindingWrites, []);
  assert.equal(startAttempts.length, 0);
  assert.deepEqual(requests, []);
  assert.equal(session.getSessionId(), "session-legacy");
});

test("CodexAppServerThreadSession required 工具 ID 缺失时不 resume 或修改旧 binding", async () => {
  const registry = createRequiredDynamicToolRegistry();
  let bindingWrites = 0;
  const { session, requests } = createSendHarness("session-missing-tool", {
    initialSessionCapabilities: { codexDynamicToolIds: ["runtime.unrelated"], codexDynamicToolBindingVersion: buildCodexDynamicToolBindingVersion(registry) },
    onSessionBinding() { bindingWrites += 1; },
  });
  await assert.rejects(session.sendMessage({
    turnId: "turn-required-missing" as any, userItemId: "item-required-missing" as any,
    text: "使用本轮工具", images: [], assistantItemId: "assistant-required-missing", reasoningItemId: "reasoning-required-missing",
    toolRegistry: registry, platformToolTransportRequirement: "required",
  }, { conversation() {}, raw() {} }), (error: any) => error.code === "codex_thread_capability_incompatible");
  assert.deepEqual(requests, []);
  assert.equal(bindingWrites, 0);
  assert.equal(session.getSessionId(), "session-missing-tool");
});

test("CodexAppServerThreadSession 工具减少或全部关闭时保留上下文续聊，停用工具不能执行", async () => {
  const registry = createRequiredDynamicToolRegistry();
  registry.tools.push({ ...registry.tools[0]!, toolId: "knowledge.rules.read" as any, name: "读取规则" });
  for (const requirement of ["optional", "required"] as const) for (const nextRegistry of [{ tools: registry.tools.slice(0, 1) }, null]) {
    let bindingWrites = 0;
    let executions = 0;
    const { session, requests, responses } = createSendHarness("session-tools", {
      initialSessionCapabilities: {
        codexDynamicToolIds: registry.tools.map(tool => tool.toolId),
        codexDynamicToolBindingVersion: buildCodexDynamicToolBindingVersion(registry),
      },
      onSessionBinding() { bindingWrites += 1; },
    });
    const input = {
      turnId: "turn-tools-changed" as any, userItemId: "user-tools-changed" as any,
      text: "继续任务", images: [], assistantItemId: "assistant-tools", reasoningItemId: "reasoning-tools",
      toolRegistry: nextRegistry, platformToolTransportRequirement: requirement,
      executeHostTool: async () => { executions += 1; return { ok: true as const, output: "executed" }; },
    };
    assert.equal(session.resolvePlatformToolTransport(nextRegistry, requirement), "native-dynamic");
    const reduced = session.sendMessage(input, { conversation() {}, raw() {} });
    await waitForActiveTurn(session);
    const instructions = String((requests.find(request => request.method === "thread/resume")?.params as any)?.developerInstructions);
    assert.match(instructions, /本轮.*平台工具/);
    assert.match(instructions, /停用/);
    assert.strictEqual((session as any).active.toolRegistry, nextRegistry);
    const toolNameById = buildCodexDynamicToolNameByToolId(registry);
    if (nextRegistry) {
      await (session as any).respondDynamicToolCall({ respond: async (id: unknown, result: unknown) => responses.push({ id, result }) }, "allowed-tool", {
        tool: toolNameById.get(registry.tools[0]!.toolId), arguments: {},
      });
      assert.equal((responses.at(-1)!.result as any).success, true);
    }
    await (session as any).respondDynamicToolCall({ respond: async (id: unknown, result: unknown) => responses.push({ id, result }) }, "disabled-tool", {
      tool: toolNameById.get("knowledge.rules.read"), arguments: {},
    });
    assert.equal((responses.at(-1)!.result as any).success, false);
    assert.match(JSON.stringify(responses.at(-1)!.result), /TOOL_NOT_FOUND/);
    assert.equal(executions, nextRegistry ? 1 : 0);
    await completePendingSend(session);
    await reduced;
    assert.equal(session.getSessionId(), "session-tools");
    assert.equal(bindingWrites, 0);
    assert.deepEqual((session as any).sessionCapabilities.codexDynamicToolIds, registry.tools.map(tool => tool.toolId));

    const pending = session.sendMessage({ ...input, toolRegistry: registry }, { conversation() {}, raw() {} });
    await completePendingSend(session);
    await pending;
    assert.deepEqual(requests.map(request => request.method), ["thread/resume", "turn/start", "thread/resume", "turn/start"]);
    assert.equal(session.getSessionId(), "session-tools");
    assert.equal(bindingWrites, 0);
  }
});

test("CodexAppServerThreadSession 工具子集名称映射变化时仍拒绝必需工具发送", async () => {
  const template = createRequiredDynamicToolRegistry().tools[0]!;
  const registry = { tools: [{ ...template, toolId: "runtime.a.b" as any }, { ...template, toolId: "runtime.a_b" as any }] };
  const subset = { tools: registry.tools.slice(1) };
  const { session, requests } = createSendHarness("session-tool-name-collision", {
    initialSessionCapabilities: {
      codexDynamicToolIds: registry.tools.map(tool => tool.toolId),
      codexDynamicToolBindingVersion: buildCodexDynamicToolBindingVersion(registry),
    },
  });
  assert.equal(session.resolvePlatformToolTransport(subset), "protocol");
  await assert.rejects(session.sendMessage({
    turnId: "turn-tool-name-collision" as any, userItemId: "user-tool-name-collision" as any,
    text: "使用本轮工具", images: [], assistantItemId: "assistant-tool-name-collision", reasoningItemId: "reasoning-tool-name-collision",
    toolRegistry: subset, platformToolTransportRequirement: "required",
  }, { conversation() {}, raw() {} }), (error: any) => error.code === "codex_thread_capability_incompatible");
  assert.deepEqual(requests, []);
  assert.equal(session.getSessionId(), "session-tool-name-collision");
});

test("CodexAppServerThreadSession required 工具绑定匹配时正常 resume，不重写能力", async () => {
  const registry = createRequiredDynamicToolRegistry();
  let bindingWrites = 0;
  const { session, requests } = createSendHarness("session-tools-matched", {
    initialSessionCapabilities: { codexDynamicToolIds: registry.tools.map(tool => tool.toolId), codexDynamicToolBindingVersion: buildCodexDynamicToolBindingVersion(registry) },
    onSessionBinding() { bindingWrites += 1; },
  });
  const pending = session.sendMessage({
    turnId: "turn-required-matched" as any, userItemId: "item-required-matched" as any,
    text: "使用本轮工具", images: [], assistantItemId: "assistant-required-matched", reasoningItemId: "reasoning-required-matched",
    toolRegistry: registry, platformToolTransportRequirement: "required",
  }, { conversation() {}, raw() {} });
  await completePendingSend(session);
  await pending;
  assert.deepEqual(requests.map(request => request.method), ["thread/resume", "turn/start"]);
  assert.equal(bindingWrites, 0);
  assert.equal(session.getSessionId(), "session-tools-matched");
});

test("CodexAppServerThreadSession 能在准入不兼容后安全旋转旧 dynamic tool binding", async () => {
  const droppedSessionIds: Array<string | null> = [];
  const bindingVersion = buildCodexDynamicToolBindingVersion(createRequiredDynamicToolRegistry());
  const { session } = createSendHarness("session-legacy", {
    initialSessionCapabilities: {
      codexDynamicToolIds: ["runtime.submitRequirementAnalysisTurnResult"],
      codexDynamicToolBindingVersion: `${bindingVersion}-old`,
    },
    onSessionBindingDropped(expectedSessionId) {
      droppedSessionIds.push(expectedSessionId);
    },
    async request(method) {
      if (method === "thread/resume") return {};
      assert.fail(`dynamic tool binding 不兼容时不应发送其他 RPC：${method}`);
    },
  });

  await assert.rejects(session.sendMessage({
    turnId: "turn-client-rotation" as any,
    userItemId: "item-user-rotation" as any,
    text: "旋转旧工具绑定",
    images: [],
    assistantItemId: "item-assistant-rotation",
    reasoningItemId: "item-reasoning-rotation",
    responseFormat: "text",
    toolRegistry: createRequiredDynamicToolRegistry(),
    platformToolTransportRequirement: "required",
    conversationProfile: "orchestration",
  }, { conversation() {}, raw() {} }), (cause: any) => cause?.code === "codex_thread_capability_incompatible");

  // 能力不兼容在 turn/start 之前发生，旧 provider thread 可以明确摘除；
  // 下一次发送将走 thread/start，而不会把旧能力集合继续带入。
  assert.equal(session.resetDynamicToolBinding(), true);
  assert.equal(session.getSessionId(), null);
  assert.deepEqual(droppedSessionIds, ["session-legacy"]);
});

test("CodexAppServerThreadSession dynamic tool capabilities 持久化失败时保留 provider ownership fence", async () => {
  let bindingWrites = 0;
  const startAttempts: unknown[] = [];
  const harness = createSendHarness(null, {
    initialSessionCapabilities: null,
    onSessionBinding() {
      bindingWrites += 1;
      if (bindingWrites === 2) throw new Error("capabilities persistence failed");
    },
    onStartAttempt(input) {
      startAttempts.push(input);
    },
    async request(method, params) {
      if (method === "thread/start") return { thread: { id: "session-rotated" } };
      if (method === "turn/start") return { turn: { id: "turn-provider-acked" } };
      if (method === "turn/interrupt") {
        assert.deepEqual(params, {
          threadId: "session-rotated",
          turnId: "turn-provider-acked",
        });
        return {};
      }
      assert.fail(`capability 持久化失败用例不得发送额外 RPC：${method}`);
    },
  });

  await assert.rejects(harness.session.sendMessage({
    turnId: "turn-client-capability-write" as any,
    userItemId: "item-user-capability-write" as any,
    text: "capability 持久化失败",
    images: [],
    assistantItemId: "item-assistant-capability-write",
    reasoningItemId: "item-reasoning-capability-write",
    responseFormat: "text",
    toolRegistry: createRequiredDynamicToolRegistry(),
    platformToolTransportRequirement: "required",
    conversationProfile: "orchestration",
  }, { conversation() {}, raw() {} }), /capabilities persistence failed/);

  assert.equal(bindingWrites, 2);
  assert.equal(startAttempts.length, 1);
  assert.equal((harness.session as any).sessionCapabilities, null);
  assert.equal(harness.session.hasActiveTurn(), true);
  assert.equal(harness.session.getActiveTurnId(), "turn-client-capability-write");

  const requestMethodsBeforeRetry = harness.requests.map((request) => request.method);
  const nextError = await harness.session.sendMessage({
    turnId: "turn-client-capability-write-next" as any,
    userItemId: "item-user-capability-write-next" as any,
    text: "下一轮不能穿透 fence",
    images: [],
    assistantItemId: "item-assistant-capability-write-next",
    reasoningItemId: "item-reasoning-capability-write-next",
  }, { conversation() {}, raw() {} }).then(
    () => assert.fail("capability 持久化失败 fence 不得放行下一轮"),
    (error: unknown) => error as Error,
  );
  assert.match(nextError.message, /当前 thread 有未完成的 turn/);
  assert.deepEqual(harness.requests.map((request) => request.method), requestMethodsBeforeRetry);

  assert.equal(
    await harness.session.interrupt("turn-client-capability-write" as any),
    true,
  );
  assert.equal(harness.session.hasActiveTurn(), false);
  assert.deepEqual(
    harness.requests.map((request) => request.method),
    ["thread/start", "turn/start", "turn/interrupt"],
  );
});

test("CodexAppServerThreadSession restoreSessionCapabilities 只补回同一 binding 的空能力快照", () => {
  const bindingVersion = buildCodexDynamicToolBindingVersion(createRequiredDynamicToolRegistry());
  const capabilities = {
    codexDynamicToolIds: ["runtime.submitRequirementAnalysisTurnResult"],
    codexDynamicToolBindingVersion: bindingVersion,
  };
  const { session, requests } = createSendHarness("session-legacy", {
    initialSessionCapabilities: null,
  });

  assert.equal(session.restoreSessionCapabilities("session-other" as any, capabilities), false);
  assert.equal(session.restoreSessionCapabilities("session-legacy" as any, capabilities), true);
  assert.equal(session.restoreSessionCapabilities("session-legacy" as any, {
    ...capabilities,
    codexDynamicToolIds: [...capabilities.codexDynamicToolIds].reverse(),
  }), true);
  assert.equal(session.restoreSessionCapabilities("session-legacy" as any, {
    ...capabilities,
    codexDynamicToolBindingVersion: "conflicting-version",
  }), false);
  assert.deepEqual((session as any).sessionCapabilities, capabilities);
  assert.deepEqual(requests, []);
});

test("CodexAppServerThreadSession disables optional native dynamic tools when the old session lacks the current binding version", () => {
  const { session } = createSendHarness("session-legacy", {
    initialSessionCapabilities: {
      codexDynamicToolIds: ["runtime.submitRequirementAnalysisTurnResult"],
    },
  });
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_requirement_analysis__" as any,
      toolsetName: "需求分析",
      toolId: "runtime.submitRequirementAnalysisTurnResult" as any,
      name: "提交需求分析结果",
      alias: null,
      description: "提交需求分析结果",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };

  assert.equal(session.resolvePlatformToolTransport(toolRegistry), "protocol");
});

test("CodexAppServerThreadSession routes native dynamic tool calls through the host executor", async () => {
  const { session, responses } = createSendHarness("session-demo");
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: null,
      description: "管理进程",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const dynamicToolName = buildCodexDynamicToolNameByToolId(toolRegistry).get("runtime.manageBackgroundService");
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "json",
    accessMode: "current",
    toolRegistry,
    executeHostTool: async () => ({
      ok: true,
      output: { status: "ready", serviceId: "demo-service" },
      durationMs: 12,
    }),
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    resolve() {},
    reject() {},
  };
  (session as any).emitters = {
    conversation() {},
    raw() {},
  };

  (session as any).onAppServerMessage({
    id: 60,
    method: "item/tool/call",
    params: {
      threadId: "session-demo",
      turnId: "turn-engine",
      callId: "call-1",
      tool: dynamicToolName,
      arguments: { action: "status", serviceId: "demo-service" },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(responses, [{
    id: 60,
    result: {
      contentItems: [{
        type: "inputText",
        text: JSON.stringify({
          ok: true,
          output: { status: "ready", serviceId: "demo-service" },
          durationMs: 12,
        }, null, 2),
      }],
      success: true,
    },
  }]);
});

test("Codex public send reports real execute failure once after close and retains runtime files", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-tool-execute-")), db = openClientDb({ dbPath: path.join(root, "application.db") });
  const workspaceId = "client-a:ws-demo" as any;
  db.workspaces.upsert({ id: workspaceId, title: "执行", path: root });
  const service = new ToolRuntimeService(root, { db, workspaceId }), registry = createRequiredDynamicToolRegistry();
  registry.tools[0] = { ...registry.tools[0]!, toolId: "tool.execute" as any, runtime: "node", code: "import fs from 'node:fs'; fs.appendFileSync('once.txt','1'); process.exitCode = 7;", workingDirectory: ".", timeoutMs: 5000 };
  const spawn = childProcess.spawn;
  let closed = false, executions = 0;
  t.mock.method(childProcess, "spawn", ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); child.once("close", () => { closed = true; }); return child; }) as typeof spawn); syncBuiltinESMExports();
  t.mock.method(logger, "error", () => {});
  const harness = createSendHarness(null, { workspacePath: root });
  const pending = harness.session.sendMessage({ turnId: "execute-client-turn" as any, userItemId: "execute-user" as any, text: "执行", images: [], assistantItemId: "execute-assistant", reasoningItemId: "execute-reasoning",
    toolRegistry: registry, platformToolTransportRequirement: "required", accessMode: "current",
    executeHostTool: async ({ accessMode }) => {
      executions++;
      const result = await service.execute(registry.tools[0]!, {}, accessMode, { requestId: "codex-parent", turnId: "execute-client-turn" });
      assert.equal(closed, true);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 7);
      return result;
    } }, { conversation() {}, raw() {} });
  const outcome = pending.then(result => ({ result }), error => ({ error }));
  try {
    await waitForCondition(() => harness.requests.some(item => item.method === "turn/start") && harness.threadHandlers.length > 0, "send did not register provider tool callback");
    harness.threadHandlers.at(-1)!.onMessage({ id: 920, method: "item/tool/call", params: { threadId: "session-started", turnId: "turn-engine", callId: "execute-call", tool: buildCodexDynamicToolNameByToolId(registry).get(registry.tools[0]!.toolId), arguments: {} } });
    assert.equal(harness.responses.length, 0);
    await waitForCondition(() => harness.responses.length > 0, "tool response did not settle");
    assert.equal(executions, 1);
    assert.equal(harness.responses.length, 1); const response = harness.responses[0].result as any;
    assert.equal(response.success, false);
    const failure = JSON.parse(response.contentItems[0].text);
    assert.equal(failure.ok, false); assert.equal(failure.code, "TOOL_EXECUTION_FAILED");
    assert.equal(harness.requests.filter(item => item.method === "turn/interrupt").length, 0);
    assert.equal(fs.readFileSync(path.join(root, "once.txt"), "utf8"), "1");
    const runtimeRoot = path.join(root, ".codeflowai", "tool-runtime");
    const retainedRuns = fs.readdirSync(runtimeRoot);
    assert.equal(retainedRuns.length, 1);
    assert.deepEqual(fs.readdirSync(path.join(runtimeRoot, retainedRuns[0]!)).sort(), ["input.json", "tool.mjs"]);
    const entries = fs.readdirSync(path.join(root, ".codeflowai")).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(root, ".codeflowai", name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
    assert.equal(entries.length, 1); assert.equal(entries[0].parentRequestId, "codex-parent");
    assert.equal(entries[0].errorCode, "TOOL_EXECUTION_FAILED");
  } finally {
    const callback = harness.threadHandlers.at(-1)?.onMessage;
    callback?.({ method: "turn/completed", params: { threadId: "session-started", turn: { id: "turn-engine", status: "completed" } } });
    await outcome; t.mock.restoreAll(); syncBuiltinESMExports(); db.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CodexAppServerThreadSession 动态工具响应传输失败只发送一次并保留原始错误", async () => {
  for (const outcome of ["success", "failure", "throw"] as const) {
    const { session } = createSendHarness("session-demo");
    primeActiveCodexTurn(session);
    const registry = createRequiredDynamicToolRegistry();
    let executions = 0;
    let responses = 0;
    (session as any).active.toolRegistry = registry;
    (session as any).active.executeHostTool = async () => {
      executions += 1;
      if (outcome === "throw") throw new Error("host execution failed token=example-host-secret");
      return outcome === "success"
        ? { ok: true, output: "saved" }
        : { ok: false, code: "INPUT_INVALID", message: "invalid input" };
    };
    const transportError = new Error("response transport closed");
    const workspace = {
      async respond(_requestId: unknown, result: unknown) {
        responses += 1;
        assert.doesNotMatch(JSON.stringify(result), /example-host-secret/);
        throw transportError;
      },
    };
    const toolId = registry.tools[0]!.toolId;
    await assert.rejects((session as any).respondDynamicToolCall(workspace, 60, {
      tool: buildCodexDynamicToolNameByToolId(registry).get(toolId), arguments: {}, callId: "tool-call",
    }), (cause) => cause === transportError);
    assert.equal(executions, 1);
    assert.equal(responses, 1);
    assert.equal((session as any).active.platformToolFailureCounts.size, 0);
  }
});

test("CodexAppServerThreadSession 工作项换段信号在首次失败后结束当前 turn", async () => {
  const { session, responses, requests } = createSendHarness("session-demo");
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_work_items__" as any,
      toolsetName: "节点工作项",
      toolId: "runtime.workItems.update" as any,
      name: "更新节点工作项",
      alias: null,
      description: "更新节点工作项",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const dynamicToolName = buildCodexDynamicToolNameByToolId(toolRegistry).get("runtime.workItems.update");
  let rejected: Error | null = null;
  (session as any).active = {
    clientTurnId: "turn-client",
    clientUserMessageIds: new Set(["item-user-turn-client"]),
    codexTurnId: "turn-engine",
    responseFormat: "json",
    accessMode: "current",
    toolRegistry,
    executeHostTool: async () => ({
      ok: false,
      code: "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED",
      message: "当前底层上下文已达到节点配置的工作项换段阈值。",
    }),
    platformToolFailureCounts: new Map(),
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
      stop() {},
    },
    todolistTextState: { text: "" },
    todolistSeenState: { seen: false },
    todolistToolCompletedState: { completed: false },
    manualInterruptRequested: false,
    manualInterruptError: null,
    interruptPromise: null,
    interruptTerminalError: null,
    pendingEngineIdleTimeoutError: null,
    providerTerminalStatus: null,
    lastNonRetryableTurnError: null,
    resolve() {},
    reject(error: Error) { rejected = error; },
  };
  (session as any).emitters = {
    conversation() {},
    raw() {},
  };

  (session as any).onAppServerMessage({
    id: 62,
    method: "item/tool/call",
    params: {
      threadId: "session-demo",
      turnId: "turn-engine",
      callId: "call-checkpoint",
      tool: dynamicToolName,
      arguments: {},
    },
  });

  await flushMicrotasksUntil(
    () => requests.some((request) => request.method === "turn/interrupt") && rejected != null,
    "工作项换段信号未结束当前 provider turn",
  );

  assert.equal((responses[0]?.result as any)?.success, false);
  assert.equal(requests.filter((request) => request.method === "turn/interrupt").length, 1);
  assert.equal((rejected as Error & { code?: string } | null)?.code, "WORK_ITEM_CONTEXT_CHECKPOINT_REQUIRED");
  assert.equal((session as any).active.platformToolFailureCounts.size, 0);
});

test("CodexAppServerThreadSession foreign dynamic tool request 不复用本地 active 工具上下文", async () => {
  const { session, responses, requests, rawEvents } = createSendHarness("session-demo");
  const toolRegistry: ExecutableToolRegistry = {
    tools: [{
      toolsetId: "__runtime_managed_service__" as any,
      toolsetName: "内建进程",
      toolId: "runtime.manageBackgroundService" as any,
      name: "管理进程",
      alias: null,
      description: "管理进程",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: false,
    }],
  };
  const dynamicToolName = buildCodexDynamicToolNameByToolId(toolRegistry).get("runtime.manageBackgroundService");
  let executeCalls = 0;
  primeActiveCodexTurn(session);
  Object.assign((session as any).active, {
    codexTurnId: "turn-local",
    codexTurnBindingSource: "provider_lifecycle",
    toolRegistry,
    executeHostTool: async () => {
      executeCalls += 1;
      return { ok: true, output: {}, durationMs: 1 };
    },
  });

  (session as any).onAppServerMessage({
    id: 61,
    method: "item/tool/call",
    params: {
      threadId: "session-demo",
      turnId: "turn-foreign",
      callId: "call-foreign",
      tool: dynamicToolName,
      arguments: { action: "status", serviceId: "foreign" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(executeCalls, 0);
  assert.equal(responses.length, 1);
  assert.equal((responses[0]?.result as any)?.success, false);
  assert.match(String((responses[0]?.result as any)?.contentItems?.[0]?.text ?? ""), /TURN_OWNERSHIP_UNCONFIRMED/);
  assert.equal(requests.some((request) => request.method === "turn/interrupt"), false);
  assert.equal(rawEvents.some((event) => (event.data as any)?.params?.turnId === "turn-foreign"), false);
  assert.equal((session as any).active.providerTerminalStatus, null);
});

test("CodexAppServerThreadSession ignores numeric process ids until Codex emits the official running summary", async () => {
  const snapshots: Array<Record<string, unknown>> = [];
  const { session } = createSendHarness("session-demo", {
    onEngineProcessSnapshot(snapshot) {
      snapshots.push(snapshot as Record<string, unknown>);
      return true;
    },
  });

  (session as any).emitters = {
    conversation() {},
    raw() {},
  };
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd-plain",
        processId: "40431",
        command: "pwsh -Command echo hi",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/commandExecution/outputDelta",
    params: {
      itemId: "cmd-plain",
      delta: "Wall time: 0.1234 seconds\nOutput:\nhi\n",
    },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd-plain",
        processId: "40431",
        command: "pwsh -Command echo hi",
        cwd: "Z:/code/codeflowai",
        status: "completed",
        exitCode: 0,
        durationMs: 123,
      },
    },
  });

  assert.deepEqual(snapshots, []);
  assert.equal(await session.stopManagedService?.("engine:codex:40431"), false);
});

test("CodexAppServerThreadSession 并行命令开始和完成均不能替其他命令确认成功", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-stale",
        processId: "40431",
        command: "pwsh -Command Stop-Process -Id 1 -Force",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/commandExecution/outputDelta",
    params: {
      turnId: "turn-engine",
      itemId: "cmd-stale",
      delta: "ProcessId : 1\nName : node.exe\n",
    },
  });
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-next",
        processId: "40432",
        command: "pwsh -Command Get-NetTCPConnection -LocalPort 39281",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });

  const sequence = conversationEvents
    .filter((event) => String(event.type).startsWith("item.tool."))
    .map((event) => `${event.type}:${String((event as any).payload?.itemId ?? "")}`);
  assert.deepEqual(sequence, [
    "item.tool.started:cmd-stale",
    "item.tool.outputDelta:cmd-stale",
    "item.tool.started:cmd-next",
  ]);

  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      turnId: "turn-engine",
      item: { type: "commandExecution", id: "cmd-next", status: "completed", exitCode: 0 },
    },
  });
  assert.equal(conversationEvents.some(
    (event) => event.type === "item.tool.completed" && (event as any).payload?.itemId === "cmd-stale",
  ), false);
  assert.equal((session as any).pendingCommandExecutionsByItemId.has("cmd-stale"), true);
});

test("CodexAppServerThreadSession does not synthesize commandExecution completion from later assistant deltas alone", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-stale",
        processId: "40431",
        command: "pwsh -Command pnpm -C apps/web dev",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/agentMessage/delta",
    params: {
      turnId: "turn-engine",
      itemId: "msg-commentary",
      delta: "still thinking",
    },
  });

  const completedEvents = conversationEvents.filter(
    (event) => event.type === "item.tool.completed" && (event as any).payload?.itemId === "cmd-stale",
  );
  assert.equal(completedEvents.length, 0);
});

test("CodexAppServerThreadSession 并行进度后只按原命令的真实失败事件确认结果", () => {
  const { session, conversationEvents } = createSendHarness("session-demo");
  primeActiveCodexTurn(session);

  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-stale",
        processId: "40431",
        command: "pwsh -Command Stop-Process -Id 1 -Force",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/commandExecution/outputDelta",
    params: {
      turnId: "turn-engine",
      itemId: "cmd-stale",
      delta: "ProcessId : 1\nName : node.exe\n",
    },
  });
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-next",
        processId: "40432",
        command: "pwsh -Command Get-NetTCPConnection -LocalPort 39281",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      turnId: "turn-engine",
      item: {
        type: "commandExecution",
        id: "cmd-stale",
        processId: "40431",
        command: "pwsh -Command Stop-Process -Id 1 -Force",
        cwd: "Z:/code/codeflowai",
        status: "failed",
        exitCode: 1,
        aggregatedOutput: "command failed",
        durationMs: 321,
      },
    },
  });

  const completedEvents = conversationEvents.filter(
    (event) => event.type === "item.tool.completed" && (event as any).payload?.itemId === "cmd-stale",
  ) as Array<Record<string, any>>;
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0]?.payload?.status, "failed");
  assert.equal(completedEvents[0]?.payload?.output.exitCode, 1);
  assert.equal((session as any).pendingCommandExecutionsByItemId.has("cmd-stale"), false);
});

test("CodexAppServerThreadSession can stop a numeric background process from the bottom process list", async () => {
  const snapshots: Array<Record<string, unknown>> = [];
  const { session } = createSendHarness("session-demo", {
    onEngineProcessSnapshot(snapshot) {
      snapshots.push(snapshot as Record<string, unknown>);
      return true;
    },
  });

  (session as any).emitters = {
    conversation() {},
    raw() {},
  };
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      itemId: "cmd-1",
      item: {
        type: "commandExecution",
        id: "cmd-1",
        processId: "40431",
        command: "pwsh -Command Start-Job ...",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/commandExecution/outputDelta",
    params: {
      itemId: "cmd-1",
      delta: [
        "Chunk ID: chunk-1",
        "Wall time: 0.9830 seconds",
        "Process running with session ID 40431",
        "Output:",
        "",
      ].join("\n"),
    },
  });

  const originalKill = process.kill;
  const killCalls: Array<{ pid: number; signal: unknown }> = [];
  (process as any).kill = ((pid: number, signal?: unknown) => {
    killCalls.push({ pid, signal: signal ?? null });
    return true;
  }) as typeof process.kill;

  try {
    const stopped = await session.stopManagedService?.("engine:codex:40431");
    assert.equal(stopped, true);
  } finally {
    (process as any).kill = originalKill;
  }

  assert.deepEqual(killCalls, [{ pid: 40431, signal: "SIGTERM" }]);
  assert.equal(snapshots[0]?.stopSupported, true);
  assert.equal(snapshots[0]?.status, "ready");
  assert.equal(snapshots.at(-1)?.status, "stopped");
  assert.equal(snapshots.at(-1)?.pid, null);
});

test("CodexAppServerThreadSession marks a confirmed background process as exited when the command finally completes", () => {
  const snapshots: Array<Record<string, unknown>> = [];
  const { session } = createSendHarness("session-demo", {
    onEngineProcessSnapshot(snapshot) {
      snapshots.push(snapshot as Record<string, unknown>);
      return true;
    },
  });

  (session as any).emitters = {
    conversation() {},
    raw() {},
  };
  (session as any).onAppServerMessage({
    method: "item/started",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd-exit",
        processId: "40432",
        command: "pwsh -Command Start-Job ...",
        cwd: "Z:/code/codeflowai",
        status: "inProgress",
      },
    },
  });
  (session as any).onAppServerMessage({
    method: "item/commandExecution/outputDelta",
    params: {
      itemId: "cmd-exit",
      delta: "Wall time: 0.5000 seconds\nProcess running with session ID 40432\nOutput:\n",
    },
  });
  (session as any).onAppServerMessage({
    method: "item/completed",
    params: {
      item: {
        type: "commandExecution",
        id: "cmd-exit",
        processId: "40432",
        command: "pwsh -Command Start-Job ...",
        cwd: "Z:/code/codeflowai",
        status: "completed",
        exitCode: 0,
        durationMs: 2300,
      },
    },
  });

  assert.equal(snapshots[0]?.status, "ready");
  assert.equal(snapshots.at(-1)?.status, "exited");
  assert.equal(snapshots.at(-1)?.readySummary, "已退出 · exit 0 · 2300ms");
});

test("CodexAppServerThreadSession 重启后停止 detached starting 会先恢复原 thread 再精确中断", async () => {
  const rpcOrder: string[] = [];
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      rpcOrder.push(method);
      if (method === "thread/resume") {
        assert.deepEqual(params, { threadId: "provider-thread-detached-start" });
        return {};
      }
      if (method === "turn/interrupt") {
        assert.deepEqual(params, {
          threadId: "provider-thread-detached-start",
          turnId: "provider-turn-detached-start",
        });
        return {};
      }
      assert.fail(`detached starting Stop 不得发送额外 RPC：${method}`);
    },
  });
  const startingTurn = {
    clientTurnId: "turn-client-detached-start",
    providerThreadId: "provider-thread-detached-start",
    providerTurnId: "provider-turn-detached-start",
    providerLifecycleTurnId: null,
    compensatedProviderTurnIds: new Set<string>(),
    startupInterruptAcknowledged: false,
    acknowledgeStartupInterrupt() {},
    resolveInterruptFinalized() {},
  } as any;
  (harness.session as any).pendingInterruptedStartingTurns.set(startingTurn.clientTurnId, startingTurn);

  assert.equal(await harness.session.interrupt(startingTurn.clientTurnId), true);
  assert.deepEqual(rpcOrder, ["thread/resume", "turn/interrupt"]);
  assert.equal(
    (harness.session as any).pendingInterruptedStartingTurns.has(startingTurn.clientTurnId),
    false,
  );
  assert.equal(startingTurn.compensatedProviderTurnIds.has("provider-turn-detached-start"), true);
  assert.equal(rpcOrder.some((method) => method === "thread/read" || method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession detached steer 的 resume 失败不阻断同 pair interrupt ACK", async () => {
  const rpcOrder: string[] = [];
  const resumeError = new Error("app-server root restarted");
  const harness = createSendHarness("session-current", {
    async request(method, params) {
      rpcOrder.push(method);
      if (method === "thread/resume") {
        assert.deepEqual(params, { threadId: "provider-thread-detached-steer" });
        throw resumeError;
      }
      if (method === "turn/interrupt") {
        assert.deepEqual(params, {
          threadId: "provider-thread-detached-steer",
          turnId: "provider-turn-detached-steer",
        });
        return {};
      }
      assert.fail(`detached steer Stop 不得发送额外 RPC：${method}`);
    },
  });
  const correlation = {
    clientTurnId: "turn-client-detached-steer",
    clientUserMessageId: "item-user-detached-steer",
    providerThreadId: "provider-thread-detached-steer",
    state: "interrupted",
    confirmedProviderTurnId: "provider-turn-detached-steer",
    ownershipRecoveryTimer: null,
  } as any;
  const correlationKey = JSON.stringify([correlation.providerThreadId, correlation.clientUserMessageId]);
  (harness.session as any).pendingSteerCorrelationsByProviderClientKey.set(correlationKey, correlation);

  assert.equal(await harness.session.interrupt(correlation.clientTurnId), true);
  assert.deepEqual(rpcOrder, ["thread/resume", "turn/interrupt"]);
  assert.equal(
    (harness.session as any).pendingSteerCorrelationsByProviderClientKey.has(correlationKey),
    false,
  );
  assert.equal(rpcOrder.some((method) => method === "thread/read" || method === "thread/turns/list"), false);
});

test("CodexAppServerThreadSession 精确 B interrupt ACK 不会被迟到 A ownership 冲突覆盖", async () => {
  let rejectTurnStart!: (error: Error) => void;
  const turnStart = new Promise<never>((_resolve, reject) => {
    rejectTurnStart = reject;
  });
  let resolveInterrupt!: () => void;
  const interruptRequest = new Promise<void>((resolve) => {
    resolveInterrupt = resolve;
  });
  const interruptedTurnIds: string[] = [];
  const harness = createSendHarness("provider-thread-ack-finality", {
    async request(method, params) {
      if (method === "thread/resume") return {};
      if (method === "turn/start") return await turnStart;
      if (method === "turn/interrupt") {
        interruptedTurnIds.push(String((params as any)?.turnId ?? ""));
        return await interruptRequest;
      }
      assert.fail(`精确 interrupt ACK 用例不得发送额外 RPC：${method}`);
    },
  });
  const pendingSend = harness.session.sendMessage({
    turnId: "turn-client-ack-finality" as any,
    userItemId: "item-user-ack-finality" as any,
    text: "stop exact B",
    images: [],
    assistantItemId: "item-assistant-ack-finality",
    reasoningItemId: "item-reasoning-ack-finality",
  }, {
    conversation() {},
    raw() {},
  });
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/start"),
    "turn/start 未发出",
  );

  const pendingInterrupt = harness.session.interrupt("turn-client-ack-finality" as any);
  rejectTurnStart(createTrackedTurnStartTimeout(Promise.resolve({
    status: "fulfilled",
    value: { turn: { id: "provider-turn-b" } },
  })));
  await flushMicrotasksUntil(
    () => harness.requests.some((request) => request.method === "turn/interrupt"),
    "精确 provider turn B 未进入 interrupt",
  );
  const startingTurn = (harness.session as any).startingTurn;
  assert.ok(startingTurn);
  startingTurn.providerLifecycleTurnId = "provider-turn-a";
  startingTurn.providerOwnershipConflict = Object.assign(new Error("late provider turn A conflict"), {
    code: "codex_turn_ownership_ambiguous",
  });
  resolveInterrupt();

  assert.equal(await pendingInterrupt, true);
  await assert.rejects(
    pendingSend,
    (error: any) => error?.code === MANUAL_TURN_INTERRUPT_CODE && error?.terminationKind === "manual_interrupt",
  );
  assert.deepEqual(interruptedTurnIds, ["provider-turn-b"]);
  assert.equal(harness.requests.some((request) => request.method === "thread/read"), false);
  assert.equal(harness.requests.some((request) => request.method === "thread/turns/list"), false);
});
