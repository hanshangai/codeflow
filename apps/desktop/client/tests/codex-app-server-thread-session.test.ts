import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationEventInput, SessionId, TurnId, WorkspaceId } from "@codeflowai/shared";

import { buildCodexDeveloperInstructions, CodexAppServerThreadSession } from "../src/engines/codex-app-server/codexAppServerThreadSession.ts";
import * as catalog from "../src/engines/engineModelCatalogRuntime.ts";
import { INITIAL_ENGINE_MODEL_CATALOG_V1 } from "@codeflowai/shared/engine-model-catalog-seed";
import { buildCodexDynamicToolNameByToolId } from '../src/engines/codex-app-server/codexAppServerProtocol.js';

test("Codex 原生提问提示只在允许交互时要求使用结构化问题", () => {
  const allowed = buildCodexDeveloperInstructions({ accessMode: "current", providerNativeToolPolicy: "allow", responseFormat: "text" });
  const interactiveOnly = buildCodexDeveloperInstructions({ accessMode: "current", providerNativeToolPolicy: "interactive-only", responseFormat: "text" });
  const denied = buildCodexDeveloperInstructions({ accessMode: "current", providerNativeToolPolicy: "deny", responseFormat: "text" });

  assert.match(allowed ?? "", /必须暂停并调用 request_user_input/);
  assert.match(allowed ?? "", /不要只在普通回复中列出编号选项/);
  assert.match(interactiveOnly ?? "", /必须暂停并调用 request_user_input/);
  assert.doesNotMatch(denied ?? "", /必须暂停并调用 request_user_input/);
});

test('revoked builtin Codex credential rejects a new turn before provider setup', async () => {
  const denied = Object.assign(new Error('credential revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  manager: { getOrCreate() { assert.fail('must not setup provider'); } } as any, workspacePath: 'D:/isolated', workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: null, initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {}, acquireCredential: () => { throw denied; } });
  await assert.rejects(session.sendMessage({ turnId: 'turn_credentials', userItemId: 'user', text: 'test', images: [], assistantItemId: 'assistant', reasoningItemId: 'reasoning' }, { conversation() {}, raw() {} }), error => error === denied);
  assert.equal(session.hasActiveTurn(), false);
});

test("数据库许可覆盖Codex凭据准入，失败原因保持原值且不启动provider", async () => {
  let permitted = false;
  const denied = new Error("COORDINATED_CREDENTIAL_DENIED");
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,
    manager: { getOrCreate() { assert.fail("provider must not start"); } }, workspacePath: "D:/isolated", workspaceId: "ws-permission", threadId: "thread-permission",
    initialSessionId: null, initialSessionCapabilities: null, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {},
    withLegacyDatabase: async (_requestId: string, operation: () => unknown) => {
      permitted = true;
      try { const result = operation(); assert.equal(Boolean((result as any)?.then), false); return result; }
      finally { permitted = false; }
    },
    acquireCredential() { assert.equal(permitted, true, "credential DB access requires permission"); throw denied; },
  } as any);
  const input = { turnId: "turn", userItemId: "user", text: "test", images: [], assistantItemId: "assistant", reasoningItemId: "reasoning" };
  for (const operation of [
    () => session.sendMessage(input, { conversation() {}, raw() {} }),
    () => session.appendInput({ turnId: "turn", text: "more", images: [] } as any),
    () => session.respondApproval("approval", "accept"),
    () => session.respondUserInput("question", {}),
  ]) await assert.rejects(operation, error => error === denied);
});

test("Codex等待数据库许可时立即停止沿原call等待释放且不派发provider", async () => {
  let allow!: () => void;
  const gate = new Promise<void>(resolve => { allow = resolve; });
  let releases = 0, confirmed = false, stopped = false;
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,
    manager: { getOrCreate() { assert.fail("cancelled preparation must not dispatch"); } }, workspacePath: "D:/isolated", workspaceId: "ws-admission", threadId: "thread-admission",
    initialSessionId: null, initialSessionCapabilities: null, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {},
    withLegacyDatabase: async (_requestId: string, operation: () => unknown) => { await gate; return operation(); },
    acquireCredential() { return { config: null, owner: null, assertCurrent() {}, release() { releases++; } }; },
  } as any);
  const input = { turnId: "turn", userItemId: "user", text: "执行", images: [], assistantItemId: "assistant", reasoningItemId: "reasoning" };
  const sending = session.sendMessage(input, { conversation() {}, raw() {} });
  const outcome = Promise.allSettled([sending]);
  assert.equal(session.getActiveTurnId(), "turn");
  assert.equal(session.getTurnPhase("turn"), "running");
  await assert.rejects(session.sendMessage({ ...input, turnId: "successor" }, { conversation() {}, raw() {} }), /未完成/u);
  const stopping = session.interrupt("turn", { onStopConfirmed() { confirmed = true; } }).finally(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, true);
  assert.equal(stopped, false);
  assert.equal(session.getTurnPhase("turn"), "draining");
  allow();
  assert.equal(await stopping, true);
  assert.equal((await outcome)[0]?.status, "rejected");
  assert.equal(releases, 1);
  assert.equal(session.getActiveTurnId(), null);
});

test('revoked builtin Codex credential blocks auxiliary engine operations before provider setup', async () => {
  const denied = Object.assign(new Error('credential revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  manager: { getOrCreate() { assert.fail('must not setup provider'); } } as any, workspacePath: 'D:/isolated', workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: 'provider-thread', initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {}, acquireCredential: () => { throw denied; } });
  for (const operation of [
    () => session.listInputActions('$'),
    () => session.prepareInputActions({ turnId: 'turn', userItemId: 'user', text: '$skill', skillMentions: [] }),
    () => session.prepareRollbackHistory(1, { droppedTurnIds: ['provider-turn'], retainedTurnId: null }),
    () => session.readRollbackHistoryTurnIds(),
    () => session.respondApproval('approval', 'accept'),
    () => session.respondUserInput('question', {}),
  ]) await assert.rejects(operation(), error => error === denied);
});

/** 提供已确认的桌面云端补充目录，每项测试独立清理暂停态。 */
function setupCompactCatalog(t: test.TestContext): void {
  catalog.resetEngineModelCatalogRuntimeForTest();
  t.after(() => catalog.resetEngineModelCatalogRuntimeForTest());
  catalog.initializeLocalEngineModelCatalog();
  const base = INITIAL_ENGINE_MODEL_CATALOG_V1.find((row) => row.engine === "codex")!;
  catalog.confirmEngineModelCatalogApplied(catalog.applyEngineModelCatalogSnapshot({
    schemaVersion: "engine-model-catalog/v1",
    configVersion: 1,
    capturedAt: 1,
    rows: [...INITIAL_ENGINE_MODEL_CATALOG_V1, {
      ...base, catalogItemId: "cloud-history", modelId: "cloud-history", displayName: "Cloud history",
      isDefault: false, sortOrder: INITIAL_ENGINE_MODEL_CATALOG_V1.filter((row) => row.engine === "codex").length + 1,
    }],
  }, 1, "compact-test"));
}

test('accepted builtin turn retains its lease for continuous provider tool requests until natural completion', async t => {
  setupCompactCatalog(t);
  let valid = true, released = 0, handled = 0;
  const responses: unknown[] = [], requests: string[] = [];
  const denied = Object.assign(new Error('credential revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const ws = { async ensureStarted() {}, registerThread() { return () => {}; }, async request(method: string) { requests.push(method); if (method === 'thread/resume') return {}; if (method === 'turn/start') return { turn: { id: 'provider-turn' } }; assert.fail(method); }, async respond(id: unknown, result: unknown) { responses.push({ id, result }); } };
  const toolRegistry = { tools: [{ toolsetId: 'test-tools', toolsetName: 'Test', toolId: 'test.echo', name: 'Echo', description: 'test', runtime: 'node' as const, code: '', permissions: { requiresWrite: false } }] };
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  manager: { getOrCreate() { return ws; } } as any, workspacePath: 'D:/isolated', workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: 'provider-thread', initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {}, supportsNativeDynamicTools: () => true, acquireCredential: () => { if (!valid) throw denied; return { owner: null, config: { apiKey: 'frozen-test-secret', baseUrl: 'https://relay.example/v1' }, assertCurrent() { if (!valid) throw denied; }, release() { released += 1; } }; } });
  const pending = session.sendMessage({ turnId: 'client-turn', userItemId: 'user', text: 'test', images: [], assistantItemId: 'assistant', reasoningItemId: 'reasoning', toolRegistry, executeHostTool: async () => { handled += 1; return { ok: true, output: 'echo' }; } }, { conversation() {}, raw() {} });
  for (let attempt = 0; attempt < 30 && !(session as any).active; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok((session as any).active); valid = false; assert.equal(released, 0);
  await assert.rejects(session.respondApproval('new-approval', 'accept'), error => error === denied);
  const tool = buildCodexDynamicToolNameByToolId(toolRegistry).get('test.echo'); assert.ok(tool);
  for (const id of [1, 2]) {
    (session as any).onAppServerMessage({ id, method: 'item/tool/call', params: { threadId: 'provider-thread', turnId: 'provider-turn', callId: `call-${id}`, tool, arguments: {} } });
    for (let attempt = 0; attempt < 30 && responses.length < id; attempt += 1) await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(handled, 2); assert.equal(responses.length, 2); assert.equal(released, 0);
  (session as any).onAppServerMessage({ method: 'turn/completed', params: { threadId: 'provider-thread', turn: { id: 'provider-turn', status: 'completed' } } });
  await pending; assert.equal(released, 1); assert.deepEqual(requests, ['thread/resume', 'turn/start']);
});

test('credential lease stays owned by unresolved provider mutation after the public call has failed', () => {
  let releases = 0;
  const session = new CodexAppServerThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  manager: {} as any, workspacePath: 'D:/isolated', workspaceId: 'ws_credentials', threadId: 'th_credentials', initialSessionId: 'provider-thread', initialSessionCapabilities: null, onEngineProcessSnapshot: () => false, onSessionBinding() {}, onSessionBindingDropped() {}, onStartAttempt() {} }) as any;
  session.credentialLease = { config: {}, owner: null, assertCurrent() {}, release() { releases += 1; } };
  const starting = { clientTurnId: 'uncertain-turn', providerThreadId: 'provider-thread', resolveInterruptFinalized() {} };
  session.pendingInterruptedStartingTurns.set('uncertain-turn', starting);
  session.releaseSettledCredential(); assert.equal(releases, 0);
  session.forgetInterruptedStartingTurn(starting); assert.equal(releases, 1);
});

/** 保留真实 session 压缩链，仅替换外部 provider RPC。 */
function createHistoricalCompactSession(request: (method: string, params: unknown) => Promise<unknown>) {
  return new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: {
      getOrCreate() {
        return {
          async ensureStarted() {},
          registerThread() { return () => {}; },
          request,
        };
      },
    } as any,
    workspacePath: "Z:/code/aidt-code",
    workspaceId: "client-test:ws-history-compact" as WorkspaceId,
    threadId: "thread-history-compact",
    initialSessionId: "engine-history-compact" as SessionId,
    initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false,
    onSessionBinding() {},
    onSessionBindingDropped() {},
    onStartAttempt() {},
  });
}

test("Codex 精确停止ACK先于保存完成，draining期间禁止新turn且保存失败向两位owner传播", async t => {
  setupCompactCatalog(t);
  let acknowledge!: () => void, failSave!: (error: Error) => void;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  const saved = new Promise<void>((_resolve, reject) => { failSave = reject; });
  const requests: string[] = [];
  const session = createHistoricalCompactSession(async method => {
    requests.push(method);
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: "provider-turn" } };
    if (method === "turn/interrupt") return await ack;
    assert.fail(method);
  });
  const input = { turnId: "client-turn", userItemId: "user", text: "test", images: [], assistantItemId: "assistant", reasoningItemId: "reasoning" };
  const sending = session.sendMessage(input, { conversation() {}, raw() {}, flush: () => saved })
    .then(value => ({ value }), error => ({ error }));
  for (let tick = 0; !(session as any).active && tick < 30; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.ok((session as any).active);
  let confirmed = false, finished = false;
  const stopping = session.interrupt("client-turn", { onStopConfirmed() { confirmed = true; } })
    .then(value => ({ value }), error => ({ error })).finally(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false, "发出RPC不能代替目标turn停止证明");
  acknowledge();
  for (let tick = 0; !confirmed && tick < 8; tick++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, true);
  assert.equal(finished, false);
  assert.equal(session.getTurnPhase("client-turn"), "draining");
  assert.equal(session.getActiveTurnId(), "client-turn");
  await assert.rejects(session.sendMessage({ ...input, turnId: "successor" }, { conversation() {}, raw() {} }), /未完成|active/i);
  assert.equal(requests.filter(method => method === "turn/start").length, 1);
  const failure = new Error("SAVE_FAILED");
  failSave(failure);
  assert.equal((await stopping as { error: unknown }).error, failure);
  const sendResult = await sending as { error: AggregateError };
  assert.ok(sendResult.error instanceof AggregateError && sendResult.error.errors.includes(failure));
  assert.equal(session.getTurnPhase("client-turn"), "failed");
  assert.equal(session.getTurnFailure("client-turn"), "TURN_EVENT_FLUSH_FAILED");
  await assert.rejects(session.sendMessage({ ...input, turnId: "successor" }, { conversation() {}, raw() {} }), /未完成/);
});

test("Codex 正常完成与停止竞态复用已有终态证明，保存期间不再发interrupt RPC", async t => {
  setupCompactCatalog(t);
  let finishSave!: () => void;
  const saved = new Promise<void>(resolve => { finishSave = resolve; });
  const requests: string[] = [];
  const session = createHistoricalCompactSession(async method => {
    requests.push(method);
    if (method === "thread/resume") return {};
    if (method === "turn/start") return { turn: { id: "provider-turn" } };
    assert.fail(method);
  });
  const sending = session.sendMessage({ turnId: "client-turn", userItemId: "user", text: "test", images: [],
    assistantItemId: "assistant", reasoningItemId: "reasoning" }, { conversation() {}, raw() {}, flush: () => saved });
  for (let tick = 0; !(session as any).active && tick < 30; tick++) await new Promise(resolve => setImmediate(resolve));
  (session as any).onAppServerMessage({ method: "turn/completed", params: {
    threadId: "engine-history-compact", turn: { id: "provider-turn", status: "completed" },
  } });
  for (let tick = 0; (session as any).active && tick < 30; tick++) await new Promise(resolve => setImmediate(resolve));
  let confirmed = false;
  const stopping = session.interrupt("client-turn", { onStopConfirmed() { confirmed = true; } });
  assert.equal(confirmed, true);
  assert.equal(session.getTurnPhase("client-turn"), "draining");
  finishSave();
  assert.equal(await stopping, true);
  await sending;
  assert.equal(requests.includes("turn/interrupt"), false);
});

test("Codex 历史云端模型在断连后拒绝压缩且不恢复 provider", async (t) => {
  setupCompactCatalog(t);
  catalog.pauseEngineModelCatalogDispatchForReconnect("disconnect");
  const requests: string[] = [];
  const session = createHistoricalCompactSession(async (method) => {
    requests.push(method);
    throw new Error("不应调用已暂停云端模型的 provider");
  });
  await assert.rejects(session.compactThread({
    turnId: "turn-history-cloud-paused" as TurnId,
    catalogModel: "cloud-history",
  }, { conversation() {}, raw() {} }), (error: any) => error.code === "ENGINE_MODEL_NOT_AVAILABLE");
  assert.deepEqual(requests, []);
  assert.equal(session.hasActiveTurn(), false);
});

test("Codex 历史本地模型在断连后继续恢复且不覆盖 provider 模型参数", async (t) => {
  setupCompactCatalog(t);
  catalog.pauseEngineModelCatalogDispatchForReconnect("disconnect");
  const reachedSetup = new Error("reached provider setup");
  const requests: Array<{ method: string; params: unknown }> = [];
  const session = createHistoricalCompactSession(async (method, params) => {
    requests.push({ method, params });
    throw reachedSetup;
  });
  await assert.rejects(session.compactThread({
    turnId: "turn-history-local-paused" as TurnId,
    catalogModel: "gpt-6.1-sol",
    contextWindow: 32000,
    autoCompactPct: 80,
  }, { conversation() {}, raw() {} }), (error) => error === reachedSetup);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "thread/resume");
  assert.equal(Object.hasOwn(requests[0]?.params as object, "model"), false);
  const config = (requests[0]?.params as { config: Record<string, unknown> }).config;
  assert.equal(config.model_context_window, 1000000);
  assert.equal(config.model_auto_compact_token_limit, 800000);
  assert.equal(session.hasActiveTurn(), false);
});

test("Codex 历史云端模型恢复期间断连会在 compact 启动前重新拒绝", async (t) => {
  setupCompactCatalog(t);
  const requests: string[] = [];
  const session = createHistoricalCompactSession(async (method) => {
    requests.push(method);
    if (method === "thread/resume") {
      catalog.pauseEngineModelCatalogDispatchForReconnect("disconnect");
      return {};
    }
    throw new Error(`不应继续调用已暂停云端模型：${method}`);
  });
  await assert.rejects(session.compactThread({
    turnId: "turn-history-cloud-disconnected" as TurnId,
    catalogModel: "cloud-history",
  }, { conversation() {}, raw() {} }), (error: any) => error.code === "ENGINE_MODEL_NOT_AVAILABLE");
  assert.deepEqual(requests, ["thread/resume"]);
  assert.equal(session.hasActiveTurn(), false);
});

test("CodexAppServerThreadSession resume 超时保留绑定并允许原 session 重试", async () => {
  const workspaceId = "client-test:ws-codex-resume-timeout" as WorkspaceId;
  const sessionId = "engine-session-resume-timeout" as SessionId;
  const requests: string[] = [];
  let dropped = 0;
  let resumeAttempts = 0;

  const session = new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: {} as any,
    workspacePath: "Z:/code/aidt-code",
    workspaceId,
    threadId: "thread-codex-resume-timeout",
    initialSessionId: sessionId,
    initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false,
    onSessionBinding() {},
    onSessionBindingDropped() {
      dropped += 1;
    },
    onStartAttempt() {},
  });

  const ws = {
    registerThread() {
      return () => {};
    },
    async request(method: string) {
      requests.push(method);
      resumeAttempts += 1;
      if (resumeAttempts > 1) return {};
      const error = new Error("Codex app-server request timeout: thread/resume") as Error & { code?: string };
      error.code = "codex_app_server_request_timeout";
      throw error;
    },
  };

  await assert.rejects(
    () => (session as any).ensureThreadSession(
      ws,
      (_event: ConversationEventInput) => {},
      "current",
      null,
      null,
      null,
      null,
      null,
      { modelContextWindow: null, modelAutoCompactTokenLimit: null },
      [],
      [],
      null,
      null,
      "optional",
    ),
    /Codex app-server request timeout: thread\/resume/,
  );

  assert.equal((session as any).resumed, false);
  assert.equal(dropped, 0);
  assert.equal(session.getSessionId(), sessionId);

  const retried = await (session as any).ensureThreadSession(
    ws,
    (_event: ConversationEventInput) => {},
    "current",
    null,
    null,
    null,
    null,
    null,
    { modelContextWindow: null, modelAutoCompactTokenLimit: null },
    [],
    [],
    null,
    null,
    "optional",
  );
  assert.deepEqual(requests, ["thread/resume", "thread/resume"]);
  assert.equal(retried.didThreadResume, true);
  assert.equal((session as any).resumed, true);
  assert.equal(dropped, 0);
  assert.equal(session.getSessionId(), sessionId);
});

test("CodexAppServerThreadSession 旧动态工具绑定准入失败时保留上下文且不发送 RPC", async () => {
  const workspaceId = "client-test:ws-codex-tool-binding-rotation" as WorkspaceId;
  const oldSessionId = "engine-session-stale-tools" as SessionId;
  const requests: string[] = [];
  let dropped = 0;
  let unregisterCount = 0;
  const startingTurn = {
    clientTurnId: "turn-tool-binding-rotation" as TurnId,
    interruptRequested: false,
    preflightInterruptSignal: new Promise<void>(() => {}),
    startRequestSent: false,
    pendingStartRequestAttemptId: null,
    providerThreadId: null,
    providerTurnId: null,
    providerLifecycleTurnId: null,
    providerObservedTurnId: null,
    providerOwnershipConflict: null,
  };

  const session = new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: {} as any,
    workspacePath: "Z:/code/aidt-code",
    workspaceId,
    threadId: "thread-codex-tool-binding-rotation",
    initialSessionId: oldSessionId,
    initialSessionCapabilities: {
      codexDynamicToolIds: ["knowledge.plan.submit"],
      codexDynamicToolBindingVersion: "stale",
    },
    onEngineProcessSnapshot: () => false,
    onSessionBindingDropped() {
      dropped += 1;
    },
    onSessionBinding() {},
    onStartAttempt() {},
  });

  const ws = {
    registerThread() {
      return () => {
        unregisterCount += 1;
      };
    },
    async request(method: string) {
      requests.push(method);
      assert.fail(`工具不兼容时不得发送 RPC：${method}`);
    },
  };

  (session as any).resumed = true;
  (session as any).startingTurn = startingTurn;
  await assert.rejects((session as any).ensureThreadSession(
    ws, () => {}, "current", null, null, null, null, null,
    { modelContextWindow: null, modelAutoCompactTokenLimit: null },
    [{ name: "knowledge.asset.submit", description: "", inputSchema: { type: "object" } }],
    ["knowledge.asset.submit"], "fresh", null, "required", startingTurn, "turn_start",
  ), (error: any) => error.code === "codex_thread_capability_incompatible" && error.preserveBinding === true);

  assert.deepEqual(requests, []);
  assert.equal(session.getSessionId(), oldSessionId);
  assert.equal(dropped, 0);
  assert.equal(unregisterCount, 0);
});

test("CodexAppServerThreadSession 缺少 clientId ownership 时不按最新 provider turn 结算", async () => {
  const workspaceId = "client-test:ws-codex-terminal-mismatch" as WorkspaceId;
  const sessionId = "engine-session-terminal-mismatch" as SessionId;
  const clientTurnId = "turn-client-terminal-mismatch" as TurnId;
  const providerTurnId = "turn-provider-terminal-mismatch";
  let resolved = 0;
  let readCount = 0;
  const ws = {
    async request(method: string) {
      assert.equal(method, "thread/read");
      readCount += 1;
      return { thread: { turns: [{ id: providerTurnId, status: "completed" }] } };
    },
  };
  const manager = {
    getOrCreate() {
      return ws;
    },
  };

  const session = new CodexAppServerThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    manager: manager as any,
    workspacePath: "Z:/code/aidt-code",
    workspaceId,
    threadId: "thread-codex-terminal-mismatch",
    initialSessionId: sessionId,
    initialSessionCapabilities: null,
    onEngineProcessSnapshot: () => false,
    onSessionBinding() {},
    onSessionBindingDropped() {},
    onStartAttempt() {},
  });

  const active = {
    clientTurnId,
    codexTurnId: "turn-start-response-id",
    resolve() {
      resolved += 1;
    },
    reject(error: Error) {
      throw error;
    },
    timeoutController: {
      onRawEvent() {},
      onConversationEvent() {},
    },
  };
  (session as any).active = active;
  (session as any).emitters = {
    conversation() {},
    raw() {},
  };
  (session as any).onAppServerMessage({
    method: "turn/completed",
    params: { threadId: sessionId, turn: { id: providerTurnId, status: "completed" } },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(resolved, 0);
  assert.equal(readCount, 0);
  assert.equal(active.codexTurnId, "turn-start-response-id");
});
