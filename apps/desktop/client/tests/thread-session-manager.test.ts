import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";

import {
  mapCodexRecoveryOutcome,
  ThreadSessionManager,
} from "../src/engines/threadSessionManager.ts";
import { CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS } from "../src/engines/codex-app-server/codexAppServerWorkspace.ts";
import type { ThreadDisposeOptions, ThreadEngineSession } from "../src/engines/threadSession.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";

type RecoveryRpcMethod = "thread/resume" | "thread/read" | "thread/turns/list" | "turn/interrupt";
type RecoveryRpcHandler = (params: any, options?: { timeoutMs?: number; trackLateSettlement?: boolean }) => unknown | Promise<unknown>;

/** 为恢复测试构造真实 runtime 和显式 RPC workspace；未声明请求立即失败。 */
function createRecoveryManager(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engineSessionId: string;
  runtimeSessionId?: string;
  workspacePath?: string;
  handlers: Partial<Record<RecoveryRpcMethod, RecoveryRpcHandler>>;
  onRestart?: () => void;
}): { manager: ThreadSessionManager; threads: ThreadStore } {
  const workspacePath = input.workspacePath ?? "Z:/code/aidt-code";
  const threads = new ThreadStore();
  threads.create({
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    engine: "codex",
    title: "recovery fixture",
    sessionId: (input.runtimeSessionId ?? input.engineSessionId) as any,
  });
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[input.workspaceId, workspacePath]]),
    threads,
  }) as any;
  const workspace = {
    async ensureStarted() {},
    registerThread() { return () => {}; },
    async request(method: string, params?: unknown, options?: { timeoutMs?: number; trackLateSettlement?: boolean }) {
      const handler = input.handlers[method as RecoveryRpcMethod];
      if (!handler) assert.fail(`未声明的 Codex recovery RPC：${method}`);
      assert.equal(options?.timeoutMs, CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS);
      assert.equal(options?.trackLateSettlement, true);
      return await handler(params, options);
    },
  };
  manager.codexAppServer = {
    forThread(candidateThreadId: ThreadId) {
      assert.equal(candidateThreadId, input.threadId);
      return {
        getOrCreate(candidateWorkspaceId: WorkspaceId, candidateWorkspacePath: string) {
          assert.equal(candidateWorkspaceId, input.workspaceId);
          assert.equal(candidateWorkspacePath, workspacePath);
          return workspace;
        },
        ...(input.onRestart
          ? {
              async restart(candidateWorkspaceId: WorkspaceId, candidateWorkspacePath: string) {
                assert.equal(candidateWorkspaceId, input.workspaceId);
                assert.equal(candidateWorkspacePath, workspacePath);
                input.onRestart?.();
                return workspace;
              },
            }
          : {}),
      };
    },
  };
  return { manager, threads };
}

test("ThreadSessionManager 区分回合存活与追加通道，且不改变未声明能力的引擎", () => {
  const threadId = "thread-appendability" as ThreadId;
  const manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map(), threads: new ThreadStore() });
  assert.equal(manager.canAppendInput(threadId), false);
  let active = true;
  let writable = false;
  const session = { hasActiveTurn: () => active, canAppendInput: () => writable };
  (manager as any).sessions.set(threadId, { session });
  assert.equal(manager.canAppendInput(threadId), false);
  assert.equal(session.hasActiveTurn(), true);
  writable = true;
  assert.equal(manager.canAppendInput(threadId), true);
  active = false;
  assert.equal(manager.canAppendInput(threadId), false);
  (manager as any).sessions.set(threadId, { session: { hasActiveTurn: () => true } });
  assert.equal(manager.canAppendInput(threadId), true);
});

test('builtin owner release disposes isolated sessions exactly once through existing lifecycle', async t => {
  const workspaceId = 'ws-isolated-owner' as WorkspaceId;
  const threads = new ThreadStore(), manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map([[workspaceId, 'D:/isolated']]), threads }) as any;
  const owner = { serverOrigin: 'https://server.example', ownerUserId: 'user-a', accountSessionId: 'session-a', generation: 1 };
  const handle = manager.createIsolatedSession({ sessionKey: 'isolated-owner', workspaceId, engine: 'claude', onSessionId() {} });
  let disposed = 0; t.mock.method(handle.session, 'dispose', async () => { disposed += 1; });
  manager.credentialOwnersByThread.set('isolated-owner', owner);
  await manager.releaseInvalidatedBuiltInSessions(owner);
  assert.equal(disposed, 1);
  await handle.dispose(); await manager.stopAndDrain();
  assert.equal(disposed, 1); assert.equal(threads.get('isolated-owner' as ThreadId), null);
  assert.equal(manager.credentialOwnersByThread.has('isolated-owner'), false);
});

test('builtin key refresh releases only its sessions while owner logout releases the remaining provider', async t => {
  const workspaceId = 'ws-key-owner' as WorkspaceId, threads = new ThreadStore();
  const owner = { serverOrigin: 'https://server.example', ownerUserId: 'user-a', accountSessionId: 'session-a', generation: 1 };
  const keyIds = { codex: 'key-codex', claude: 'key-claude' };
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, 'D:/isolated']]), threads,
    builtInRelayCredentials: { acquire({ engine }: { engine: keyof typeof keyIds }) { return { owner, config: { apiKey: 'secret', credentialIdentity: { ...owner, keyId: keyIds[engine] } }, assertCurrent() {}, release() {} }; } } as any,
    sessionIdleCleanup: { enabled: false },
  }) as any;
  const codex = manager.createIsolatedSession({ sessionKey: 'isolated-codex', workspaceId, engine: 'codex', onSessionId() {} });
  const claude = manager.createIsolatedSession({ sessionKey: 'isolated-claude', workspaceId, engine: 'claude', onSessionId() {} });
  const disposed: string[] = [];
  t.mock.method(codex.session, 'dispose', async () => { disposed.push('codex'); });
  t.mock.method(claude.session, 'dispose', async () => { disposed.push('claude'); });
  manager.acquireCredentialForThread('isolated-codex', 'codex', {}).release();
  const acceptedClaude = manager.acquireCredentialForThread('isolated-claude', 'claude', {});
  assert.equal(manager.credentialOwnersByThread.get('isolated-codex')?.keyId, keyIds.codex);
  assert.equal(manager.credentialOwnersByThread.get('isolated-claude')?.keyId, keyIds.claude);
  await manager.releaseInvalidatedBuiltInSessions(owner, keyIds.codex);
  assert.deepEqual(disposed, ['codex']);
  assert.equal(manager.getExisting('isolated-claude'), claude.session);
  assert.equal(manager.credentialLeasesByThread.has('isolated-claude'), true);
  acceptedClaude.release();
  await manager.releaseInvalidatedBuiltInSessions(owner);
  assert.deepEqual(disposed, ['codex', 'claude']); assert.equal(manager.credentialOwnersByThread.size, 0);
  await codex.dispose(); await claude.dispose(); await manager.stopAndDrain();
  assert.deepEqual(disposed, ['codex', 'claude']);
});

test('normal session disposal clears credential process owner before later custom dispatch', async () => {
  const workspaceId = 'ws-owner-cleanup' as WorkspaceId, threadId = 'thread-owner-cleanup' as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  manager.sessions.set(threadId, { session: createFakeSession({ workspaceId, threadId }), lastUsedAt: 0 });
  manager.credentialOwnersByThread.set(threadId, { serverOrigin: 'https://server.example', ownerUserId: 'user-a', accountSessionId: 'session-a', generation: 1 });
  manager.codexAppServer = { async releaseThread() {} };
  await manager.disposeThread(threadId);
  assert.equal(manager.credentialOwnersByThread.has(threadId), false);
});

test('builtin scope failure also blocks direct recovery runtime configuration without an active key', () => {
  const denied = Object.assign(new Error('builtin scope revoked'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
  const manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map(), threads: new ThreadStore(), builtInRelayCredentials: { acquire() { throw denied; } } as any }) as any;
  const workspace = manager.codexAppServer.forThread('thread-recovery').getOrCreate('ws-recovery', 'D:/isolated');
  assert.throws(() => workspace.opts.resolveCodexRuntimeConfig(), error => error === denied);
});

test('completed Claude owner release blocks a captured session from acquiring credentials during disposal', async t => {
  const workspaceId = 'ws-claude-release-gate' as WorkspaceId, threads = new ThreadStore();
  let entered!: () => void, finish!: () => void;
  let acquisitions = 0;
  const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { finish = resolve; });
  const manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map([[workspaceId, 'D:/isolated']]), threads, builtInRelayCredentials: { acquire() { acquisitions += 1; return { config: { apiKey: 'custom-secret' }, owner: null, assertCurrent() {}, release() {} }; } } as any, sessionIdleCleanup: { enabled: false } }) as any;
  const thread = threads.create({ threadId: 'thread-release-gate' as ThreadId, workspaceId, engine: 'claude', title: 'release' }), session = manager.getOrCreate(thread);
  manager.credentialOwnersByThread.set(thread.threadId, { serverOrigin: 'https://server.example', ownerUserId: 'owner', accountSessionId: 'session', generation: 1, keyId: 'key-release' });
  t.mock.method(session, 'dispose', async () => { entered(); await waiting; });
  const releasing = manager.releaseCompletedBuiltInClaudeSessions(new Set(['key-release'])); await started;
  assert.throws(() => session.opts.acquireCredential({}), { code: 'CONFLICT' });
  assert.equal(acquisitions, 0);
  finish(); await releasing; assert.equal(manager.getExisting(thread.threadId), null);
});

test('completed Claude release selects owner key ids and preserves another provider lease', async t => {
  const workspaceId = 'ws-claude-key-scope' as WorkspaceId, threads = new ThreadStore();
  const owner = { serverOrigin: 'https://server.example', ownerUserId: 'owner', accountSessionId: 'session', generation: 1 };
  const manager = new ThreadSessionManager({ writeWorkspaceLog: testEngineWorkspaceLog,  workspaces: new Map([[workspaceId, 'D:/isolated']]), threads, sessionIdleCleanup: { enabled: false } }) as any;
  const target = manager.createIsolatedSession({ sessionKey: 'isolated-anthropic', workspaceId, engine: 'claude', onSessionId() {} });
  const other = manager.createIsolatedSession({ sessionKey: 'isolated-zai', workspaceId, engine: 'claude', onSessionId() {} });
  const disposed: string[] = [];
  t.mock.method(target.session, 'dispose', async () => { disposed.push('anthropic'); });
  t.mock.method(other.session, 'dispose', async () => { disposed.push('zai'); });
  manager.credentialOwnersByThread.set('isolated-anthropic', { ...owner, keyId: 'key-anthropic' });
  manager.credentialOwnersByThread.set('isolated-zai', { ...owner, keyId: 'key-zai' });
  const otherLease = { config: null, owner, assertCurrent() {}, release() {} };
  manager.credentialLeasesByThread.set('isolated-zai', otherLease);
  try {
    await manager.releaseCompletedBuiltInClaudeSessions(new Set(['key-anthropic']));
    assert.deepEqual(disposed, ['anthropic']); assert.equal(manager.getExisting('isolated-zai'), other.session);
    assert.equal(manager.credentialLeasesByThread.get('isolated-zai'), otherLease);
    assert.equal(manager.credentialOwnersByThread.get('isolated-zai')?.keyId, 'key-zai');
  } finally { manager.credentialLeasesByThread.delete('isolated-zai'); await manager.stopAndDrain(); }
});

test("ThreadSessionManager 在发布 Codex runtime binding 前先持久化 generation", () => {
  const workspaceId = "client-test:ws-thread-session-binding-order" as WorkspaceId;
  const threadId = "thread-session-binding-order" as ThreadId;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "binding order",
  });
  const calls: string[] = [];
  const originalSetSessionBinding = threads.setSessionBinding.bind(threads);
  threads.setSessionBinding = (...args) => {
    calls.push("runtime");
    originalSetSessionBinding(...args);
  };
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    persistSessionBinding() {
      calls.push("persisted");
    },
  }) as any;
  manager.codexAppServer = { forThread() { return {}; } };

  const session = manager.getOrCreate(runtime) as any;
  session.opts.onSessionBinding("session-binding-order", null);

  assert.deepEqual(calls, ["persisted", "runtime"]);
  assert.equal(threads.get(threadId)?.sessionId, "session-binding-order");
});

test("ThreadSessionManager 同步转发 Codex start attempt 到持久层", () => {
  const workspaceId = "client-test:ws-thread-session-start-attempt" as WorkspaceId;
  const threadId = "thread-session-start-attempt" as ThreadId;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "start attempt",
  });
  const received: unknown[] = [];
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    persistCodexStartAttempt(input) {
      received.push(input);
    },
  }) as any;
  manager.codexAppServer = { forThread() { return {}; } };
  const session = manager.getOrCreate(runtime) as any;
  const input = {
    workspaceId,
    threadId,
    clientTurnId: "turn-session-start-attempt",
    clientUserMessageId: "item-user-session-start-attempt",
    providerThreadId: "provider-thread-session-start-attempt",
    provisionalProviderTurnId: "provider-turn-session-start-attempt",
    attemptId: 1,
    observedAt: 1_000,
  };

  session.opts.onStartAttempt(input);

  assert.deepEqual(received, [input]);
});

test("ThreadSessionManager reconcileCodexDanglingTurn 会把 client turnId 写入 assistant completed 事件", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-1" as ThreadId;
  const turnId = "turn-session-manager-1" as any;
  const workspacePath = "Z:/code/aidt-code";

  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    workspacePath,
    engineSessionId: "engine-session-1",
    handlers: {
      "thread/resume": (params) => {
        assert.deepEqual(params, { threadId: "engine-session-1" });
        return {};
      },
      "thread/read": (params) => {
        assert.deepEqual(params, { threadId: "engine-session-1", includeTurns: false });
        return { thread: { id: "engine-session-1", status: "idle" } };
      },
      "thread/turns/list": (params) => {
        assert.deepEqual(params, {
          threadId: "engine-session-1",
          limit: 64,
          sortDirection: "desc",
          itemsView: "full",
        });
        return {
          data: [{
            id: "engine-turn-1",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "msg-thread-manager-1",
              text: "recovered final answer",
              phase: "final_answer",
            }],
          }],
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath,
    turnId,
    engineSessionId: "engine-session-1" as any,
    engineTurnId: "engine-turn-1",
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.assistantEvents.length, 1);
  assert.equal(String((result.assistantEvents[0] as any)?.payload?.turnId ?? ""), String(turnId));
  assert.equal(String((result.assistantEvents[0] as any)?.payload?.phase ?? ""), "final_answer");
});

test("ThreadSessionManager 重启对账仍为 running 时返回 pending", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-pending" as ThreadId;
  let listCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-pending",
    handlers: {
      "thread/resume": () => ({}),
      "thread/read": () => ({ thread: { id: "engine-session-pending", status: { type: "active" } } }),
      "thread/turns/list": () => {
        listCount += 1;
        return { data: [{ id: "engine-turn-pending", status: "inProgress", items: [] }] };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-pending" as any,
    engineSessionId: "engine-session-pending" as any,
    engineTurnId: "engine-turn-pending",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "client_restart_reconcile_timeout");
  assert.equal(listCount, 3);
});

test("ThreadSessionManager 重启对账会在 fresh app-server 中先 resume 再读取终态", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-resume-read" as ThreadId;
  const order: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-resume-read",
    handlers: {
      "thread/resume": () => {
        order.push("thread/resume");
        throw new Error("thread not found: engine-session-resume-read");
      },
      "thread/read": () => {
        order.push("thread/read");
        return { thread: { id: "engine-session-resume-read", status: "idle" } };
      },
      "thread/turns/list": () => {
        order.push("thread/turns/list");
        return { data: [{ id: "engine-turn-resume-read", status: "completed", items: [] }] };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-resume-read" as any,
    engineSessionId: "engine-session-resume-read" as any,
    engineTurnId: "engine-turn-resume-read",
  });

  assert.equal(result.kind, "completed");
  assert.deepEqual(order, ["thread/resume", "thread/read", "thread/turns/list"]);
});

test("ThreadSessionManager 精确 provider 对账只尝试一次，避免恢复请求堆叠", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-exact-once" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-exact-once",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return {
          thread: {
            id: "engine-session-exact-once",
            status: "active",
            turns: [{ id: "engine-turn-exact-once", status: "inProgress", items: [] }],
          },
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-exact-once" as any,
    engineSessionId: "engine-session-exact-once" as any,
    engineTurnId: "engine-turn-exact-once",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "client_restart_reconcile_timeout");
  assert.deepEqual(methods, ["thread/read"]);
});

test("ThreadSessionManager 精确 provider read 超时后不追加 resume 或重复恢复", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-exact-timeout" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-exact-timeout",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        throw Object.assign(new Error("Codex app-server request timeout: thread/read"), {
          code: "codex_app_server_request_timeout",
        });
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-exact-timeout" as any,
    engineSessionId: "engine-session-exact-timeout" as any,
    engineTurnId: "engine-turn-exact-timeout",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "reconcile_failed");
  assert.match(result.message, /app-server request timeout: thread\/read/);
  assert.deepEqual(methods, ["thread/read"]);
});

test("ThreadSessionManager 启动对账单纯 RPC 超时不立即重启 app-server", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-restart" as ThreadId;
  const methods: string[] = [];
  let restartCalls = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-restart",
    onRestart: () => {
      restartCalls += 1;
    },
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        throw Object.assign(new Error("Codex app-server request timeout: thread/read"), {
          code: "codex_app_server_request_timeout",
        });
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-restart" as any,
    engineSessionId: "engine-session-startup-restart" as any,
    engineTurnId: "engine-turn-startup-restart",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "reconcile_failed");
  assert.equal(restartCalls, 0);
  assert.deepEqual(methods, ["thread/read"]);
});

test("ThreadSessionManager 精确 provider read 明确不存在时才 fallback resume", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-exact-resume-fallback" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-exact-resume-fallback",
    handlers: {
      "thread/read": () => {
        methods.push("thread/read");
        if (methods.length === 1) throw new Error("thread not found: engine-session-exact-resume-fallback");
        return {
          thread: {
            id: "engine-session-exact-resume-fallback",
            status: "idle",
            turns: [{ id: "engine-turn-exact-resume-fallback", status: "completed", items: [] }],
          },
        };
      },
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-exact-resume-fallback" as any,
    engineSessionId: "engine-session-exact-resume-fallback" as any,
    engineTurnId: "engine-turn-exact-resume-fallback",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "completed");
  assert.deepEqual(methods, ["thread/read", "thread/resume", "thread/read"]);
});

test("ThreadSessionManager startup 在最新 clientId 未物化时恢复上一候选的真实终态", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-ghost-terminal" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-ghost-terminal",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-startup-ghost-terminal", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return {
          data: [
            {
              id: "engine-turn-actual-terminal",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user-startup-terminal" }],
            },
            { id: "engine-turn-foreign-goal", status: "inProgress", items: [] },
          ],
          nextCursor: null,
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-ghost-terminal" as any,
    engineSessionId: "engine-session-startup-ghost-terminal" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageIds: ["item-user-startup-newer-missing", "item-user-startup-terminal"],
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.actualEngineTurnId, "engine-turn-actual-terminal");
  assert.deepEqual(methods, ["thread/resume", "thread/read", "thread/turns/list"]);
});

test("ThreadSessionManager startup 精确 ownership 仍运行时返回真实 provider turnId", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-ghost-running" as ThreadId;
  let listCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-ghost-running",
    handlers: {
      "thread/resume": () => ({}),
      "thread/read": () => ({
        thread: { id: "engine-session-startup-ghost-running", status: "active" },
      }),
      "thread/turns/list": () => {
        listCount += 1;
        return {
          data: [
            {
              id: "engine-turn-actual-running",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "item-user-startup-running" }],
            },
            { id: "engine-turn-foreign-running", status: "inProgress", items: [] },
          ],
          nextCursor: null,
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-ghost-running" as any,
    engineSessionId: "engine-session-startup-ghost-running" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageId: "item-user-startup-running",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "client_restart_reconcile_timeout");
  assert.equal(result.actualEngineTurnId, "engine-turn-actual-running");
  assert.equal(listCount, 3);
});

test("ThreadSessionManager startup 同一 clientUserMessageId 命中多个 turn 时拒绝猜测", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-ambiguous" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-ambiguous",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-startup-ambiguous", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return {
          data: [
            {
              id: "engine-turn-ambiguous-a",
              status: "completed",
              items: [{ type: "userMessage", clientId: "item-user-startup-ambiguous" }],
            },
            {
              id: "engine-turn-ambiguous-b",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "item-user-startup-ambiguous" }],
            },
          ],
          nextCursor: null,
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-ambiguous" as any,
    engineSessionId: "engine-session-startup-ambiguous" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageIds: ["item-user-startup-newer-missing", "item-user-startup-ambiguous"],
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_ownership_ambiguous");
  assert.deepEqual(methods, ["thread/resume", "thread/read", "thread/turns/list"]);
});

test("ThreadSessionManager startup 多次快照把同一 clientId 映射到不同 turn 时拒绝换绑", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-changing-owner" as ThreadId;
  let listCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-changing-owner",
    handlers: {
      "thread/resume": () => ({}),
      "thread/read": () => ({
        thread: { id: "engine-session-startup-changing-owner", status: "active" },
      }),
      "thread/turns/list": () => {
        listCount += 1;
        return {
          data: [{
            id: listCount === 1 ? "engine-turn-owner-a" : "engine-turn-owner-b",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-startup-changing-owner" }],
          }],
          nextCursor: null,
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-changing-owner" as any,
    engineSessionId: "engine-session-startup-changing-owner" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageId: "item-user-startup-changing-owner",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_ownership_ambiguous");
  assert.match(result.message, /engine-turn-owner-a,engine-turn-owner-b/);
  assert.equal(listCount, 2);
});

test("ThreadSessionManager interrupt 多次快照 ownership 从 A 漂到 B 时零中断", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-interrupt-changing-owner" as ThreadId;
  const methods: string[] = [];
  let listCount = 0;
  let interruptCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-interrupt-changing-owner",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return {
          thread: {
            id: "engine-session-interrupt-changing-owner",
            status: listCount === 0 ? "idle" : "active",
          },
        };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        listCount += 1;
        return {
          data: [{
            id: listCount === 1 ? "engine-turn-owner-a" : "engine-turn-owner-b",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-interrupt-changing-owner" }],
          }],
          nextCursor: null,
        };
      },
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        interruptCount += 1;
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-interrupt-changing-owner" as any,
    engineSessionId: "engine-session-interrupt-changing-owner" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageId: "item-user-interrupt-changing-owner",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_ownership_ambiguous");
  assert.match(result.message, /engine-turn-owner-a,engine-turn-owner-b/);
  assert.equal(interruptCount, 0);
  assert.equal(listCount, 2);
  assert.deepEqual(methods, [
    "thread/resume",
    "thread/read",
    "thread/turns/list",
    "thread/resume",
    "thread/read",
    "thread/turns/list",
  ]);
});

test("ThreadSessionManager startup 历史页未覆盖 clientId 时保持 scan-incomplete", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-startup-scan-incomplete" as ThreadId;
  let listCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-startup-scan-incomplete",
    handlers: {
      "thread/resume": () => ({}),
      "thread/read": () => ({
        thread: { id: "engine-session-startup-scan-incomplete", status: "active" },
      }),
      "thread/turns/list": () => {
        listCount += 1;
        return {
          data: [{
            id: "engine-turn-older-owned",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-startup-older" }],
          }],
          nextCursor: "older-provider-turns",
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-startup-scan-incomplete" as any,
    engineSessionId: "engine-session-startup-scan-incomplete" as any,
    engineTurnId: "engine-turn-ghost",
    clientUserMessageIds: ["item-user-startup-newer-missing", "item-user-startup-older"],
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_correlation_scan_incomplete");
  assert.match(result.message, /仍有更早历史/);
  assert.equal(listCount, 3);
});

test("ThreadSessionManager phantom ID 会按 clientUserMessageId 恢复并中断真实 active turn", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-recovered-interrupt" as ThreadId;
  const order: Array<{ method: string; turnId: string | null }> = [];
  const record = (method: string, params?: any) => {
    order.push({ method, turnId: String(params?.turnId ?? "") || null });
  };
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-recovered-interrupt",
    handlers: {
      "thread/resume": (params) => {
        record("thread/resume", params);
        throw new Error("thread not found: engine-session-recovered-interrupt");
      },
      "thread/read": (params) => {
        record("thread/read", params);
        return { thread: { id: "engine-session-recovered-interrupt", status: { type: "active" } } };
      },
      "thread/turns/list": (params) => {
        record("thread/turns/list", params);
        return {
          data: [
            { id: "engine-turn-stale", status: "interrupted", items: [] },
            {
              id: "engine-turn-actual",
              status: "inProgress",
              items: [{ type: "userMessage", clientId: "item-user-actual" }],
            },
          ],
        };
      },
      "turn/interrupt": (params) => {
        record("turn/interrupt", params);
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-recovered-interrupt" as any,
    engineSessionId: "engine-session-recovered-interrupt" as any,
    engineTurnId: "engine-turn-stale",
    clientUserMessageId: "item-user-actual",
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "engine-turn-actual",
    allowSiblingRunning: true,
  });
  assert.deepEqual(order, [
    { method: "thread/resume", turnId: null },
    { method: "thread/read", turnId: null },
    { method: "thread/turns/list", turnId: null },
    { method: "turn/interrupt", turnId: "engine-turn-actual" },
  ]);
});

test("ThreadSessionManager 缺少 provider turnId 时按 clientUserMessageId 恢复唯一 active turn", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-missing-provider-turn" as ThreadId;
  const requests: Array<{ method: string; turnId: string | null }> = [];
  const record = (method: string, params?: any) => {
    requests.push({ method, turnId: String(params?.turnId ?? "") || null });
  };
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-missing-provider-turn",
    handlers: {
      "thread/resume": (params) => {
        record("thread/resume", params);
        return {};
      },
      "thread/read": (params) => {
        record("thread/read", params);
        return { thread: { id: "engine-session-missing-provider-turn", status: "active" } };
      },
      "thread/turns/list": (params) => {
        record("thread/turns/list", params);
        return {
          data: [{
            id: "engine-turn-recovered-from-client-id",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-missing-provider-turn" }],
          }],
          nextCursor: null,
        };
      },
      "turn/interrupt": (params) => {
        record("turn/interrupt", params);
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-missing-provider-turn" as any,
    engineSessionId: "engine-session-missing-provider-turn" as any,
    engineTurnId: null,
    clientUserMessageId: "item-user-missing-provider-turn",
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "engine-turn-recovered-from-client-id",
    allowSiblingRunning: true,
  });
  assert.deepEqual(requests, [
    { method: "thread/resume", turnId: null },
    { method: "thread/read", turnId: null },
    { method: "thread/turns/list", turnId: null },
    { method: "turn/interrupt", turnId: "engine-turn-recovered-from-client-id" },
  ]);
});

test("ThreadSessionManager restart-stop 在最新 B 未物化时精确中断已物化 running A", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-recovered-previous-client" as ThreadId;
  const requests: Array<{ method: string; turnId: string | null }> = [];
  const record = (method: string, params?: any) => {
    requests.push({ method, turnId: String(params?.turnId ?? "") || null });
  };
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-recovered-previous-client",
    handlers: {
      "thread/resume": (params) => {
        record("thread/resume", params);
        return {};
      },
      "thread/read": (params) => {
        record("thread/read", params);
        return { thread: { id: "engine-session-recovered-previous-client", status: "active" } };
      },
      "thread/turns/list": (params) => {
        record("thread/turns/list", params);
        return {
          data: [{
            id: "engine-turn-owned-a",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-a" }],
          }],
          nextCursor: null,
        };
      },
      "turn/interrupt": (params) => {
        record("turn/interrupt", params);
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-recovered-previous-client" as any,
    engineSessionId: "engine-session-recovered-previous-client" as any,
    engineTurnId: "engine-turn-provisional-b",
    clientUserMessageIds: ["item-user-b", "item-user-a"],
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "engine-turn-owned-a",
    allowSiblingRunning: true,
  });
  assert.deepEqual(requests, [
    { method: "thread/resume", turnId: null },
    { method: "thread/read", turnId: null },
    { method: "thread/turns/list", turnId: null },
    { method: "turn/interrupt", turnId: "engine-turn-owned-a" },
  ]);
});

test("ThreadSessionManager 旧历史缺少 clientUserMessageId 时不信任裸 provider turnId", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-converged-interrupt" as ThreadId;
  const order: Array<{ method: string; turnId: string | null }> = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-converged-interrupt",
    handlers: {},
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-converged-interrupt" as any,
    engineSessionId: "engine-session-converged-interrupt" as any,
    engineTurnId: "engine-turn-old",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_correlation_scan_incomplete");
  assert.deepEqual(order, []);
});

test("ThreadSessionManager 精确目标已终态时不受 foreign running Goal 阻断", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-terminal-with-goal" as ThreadId;
  const requests: Array<{ method: string; turnId: string | null }> = [];
  const record = (method: string, params?: any) => {
    requests.push({ method, turnId: String(params?.turnId ?? "") || null });
  };
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-terminal-with-goal",
    handlers: {
      "thread/resume": (params) => {
        record("thread/resume", params);
        return {};
      },
      "thread/read": (params) => {
        record("thread/read", params);
        return { thread: { id: "engine-session-terminal-with-goal", status: "active" } };
      },
      "thread/turns/list": (params) => {
        record("thread/turns/list", params);
        return {
          data: [
            {
              id: "engine-turn-owned",
              status: "interrupted",
              items: [{ type: "userMessage", clientId: "item-user-owned" }],
            },
            { id: "engine-turn-goal", status: "inProgress", items: [] },
          ],
        };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-terminal-with-goal" as any,
    engineSessionId: "engine-session-terminal-with-goal" as any,
    engineTurnId: "engine-turn-owned",
    clientUserMessageId: "item-user-owned",
  });

  assert.equal(result.kind, "terminal");
  if (result.kind !== "terminal") assert.fail("应返回真实 provider 终态");
  assert.equal(result.actualEngineTurnId, "engine-turn-owned");
  assert.equal(result.reconciled.kind, "error");
  assert.equal(result.reconciled.code, "codex_interrupted");
  assert.equal(result.reconciled.providerTerminal, true);
  assert.deepEqual(requests, [
    { method: "thread/resume", turnId: null },
    { method: "thread/read", turnId: null },
    { method: "thread/turns/list", turnId: null },
  ]);
});

test("ThreadSessionManager 仅有历史 running 且目标 ID 不匹配时不会误中断", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-stale-running-interrupt" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-stale-running-interrupt",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-stale-running-interrupt", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return { data: [
          { id: "engine-turn-old", status: "inProgress", items: [] },
          { id: "engine-turn-newer", status: "completed", items: [] },
        ] };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-stale-running-interrupt" as any,
    engineSessionId: "engine-session-stale-running-interrupt" as any,
    engineTurnId: "engine-turn-missing",
    clientUserMessageId: "item-user-missing",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_thread_resume_unconfirmed");
  assert.deepEqual(methods, [
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
  ]);
});

test("ThreadSessionManager 多个 running turn 中存在精确目标时直接中断目标", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-ambiguous-interrupt" as ThreadId;
  const requests: Array<{ method: string; turnId: string | null }> = [];
  const record = (method: string, params?: any) => {
    requests.push({ method, turnId: String(params?.turnId ?? "") || null });
  };
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-ambiguous-interrupt",
    handlers: {
      "thread/resume": (params) => {
        record("thread/resume", params);
        return {};
      },
      "thread/read": (params) => {
        record("thread/read", params);
        return { thread: { id: "engine-session-ambiguous-interrupt", status: "active" } };
      },
      "thread/turns/list": (params) => {
        record("thread/turns/list", params);
        return { data: [
          {
            id: "engine-turn-running-1",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-running-1" }],
          },
          { id: "engine-turn-running-2", status: "inProgress", items: [] },
        ] };
      },
      "turn/interrupt": (params) => {
        record("turn/interrupt", params);
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-ambiguous-interrupt" as any,
    engineSessionId: "engine-session-ambiguous-interrupt" as any,
    engineTurnId: "engine-turn-running-1",
    clientUserMessageId: "item-user-running-1",
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "engine-turn-running-1",
    allowSiblingRunning: true,
  });
  assert.deepEqual(requests, [
    { method: "thread/resume", turnId: null },
    { method: "thread/read", turnId: null },
    { method: "thread/turns/list", turnId: null },
    { method: "turn/interrupt", turnId: "engine-turn-running-1" },
  ]);
});

test("ThreadSessionManager 重复 running turnId 时拒绝中断", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-duplicate-running" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-duplicate-running",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-duplicate-running", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return { data: [
          { id: "engine-turn-duplicate", status: "inProgress", items: [] },
          { id: "engine-turn-duplicate", status: "inProgress", items: [] },
        ] };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-duplicate-running" as any,
    engineSessionId: "engine-session-duplicate-running" as any,
    engineTurnId: "engine-turn-duplicate",
    clientUserMessageId: "item-user-duplicate",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_state_ambiguous");
  assert.deepEqual(methods, ["thread/resume", "thread/read", "thread/turns/list"]);
});

test("ThreadSessionManager 目标状态未知时不猜测唯一最新 running turn", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-unknown-expected" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-unknown-expected",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-unknown-expected", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return { data: [
          {
            id: "engine-turn-expected",
            status: "queued",
            items: [{ type: "userMessage", clientId: "item-user-expected" }],
          },
          { id: "engine-turn-other", status: "inProgress", items: [] },
        ] };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-unknown-expected" as any,
    engineSessionId: "engine-session-unknown-expected" as any,
    engineTurnId: "engine-turn-expected",
    clientUserMessageId: "item-user-expected",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_state_ambiguous");
  assert.deepEqual(methods, [
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
  ]);
});

test("ThreadSessionManager 多个 running turn 且目标不存在时保持 pending", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-missing-target-interrupt" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-missing-target-interrupt",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-missing-target-interrupt", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return { data: [
          { id: "engine-turn-running-1", status: "inProgress", items: [] },
          { id: "engine-turn-running-2", status: "inProgress", items: [] },
        ] };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-missing-target-interrupt" as any,
    engineSessionId: "engine-session-missing-target-interrupt" as any,
    engineTurnId: "engine-turn-missing",
    clientUserMessageId: "item-user-missing",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_thread_resume_unconfirmed");
  assert.deepEqual(methods, [
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
  ]);
});

test("ThreadSessionManager 有界 turn 页未覆盖完整历史时不误判 ownership 丢失", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-correlation-incomplete" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-correlation-incomplete",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        return { thread: { id: "engine-session-correlation-incomplete", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return {
          data: [{ id: "foreign-goal-turn", status: "inProgress", items: [] }],
          nextCursor: "older-provider-turns",
        };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-correlation-incomplete" as any,
    engineSessionId: "engine-session-correlation-incomplete" as any,
    engineTurnId: "ghost-provider-turn",
    clientUserMessageId: "item-user-owned-but-older",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "codex_turn_correlation_scan_incomplete");
  assert.match(result.message, /仍有更早历史/);
  assert.deepEqual(methods, [
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
    "thread/resume", "thread/read", "thread/turns/list",
  ]);
});

test("ThreadSessionManager 中断失败且终态读取失败时保留两段错误上下文", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-interrupt-and-read-failed" as ThreadId;
  const methods: string[] = [];
  let headReadCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-interrupt-and-read-failed",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "thread/read": () => {
        methods.push("thread/read");
        headReadCount += 1;
        if (headReadCount > 1) throw new Error("failed to read session metadata: rollout is empty");
        return { thread: { id: "engine-session-interrupt-and-read-failed", status: "active" } };
      },
      "thread/turns/list": () => {
        methods.push("thread/turns/list");
        return {
          data: [{
            id: "engine-turn-owned",
            status: "inProgress",
            items: [{ type: "userMessage", clientId: "item-user-owned" }],
          }],
          nextCursor: null,
        };
      },
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw new Error("no active turn to interrupt");
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-interrupt-and-read-failed" as any,
    engineSessionId: "engine-session-interrupt-and-read-failed" as any,
    engineTurnId: "engine-turn-owned",
    clientUserMessageId: "item-user-owned",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_failed");
  assert.match(result.message, /no active turn to interrupt/);
  assert.match(result.message, /终态确认失败：Codex thread\/read 请求失败；binding 保持不变/);
  assert.deepEqual(methods, ["thread/resume", "thread/read", "thread/turns/list", "turn/interrupt", "thread/resume", "thread/read"]);
});

test("ThreadSessionManager resume 与 read 均不可用时保留 binding 与 running", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-invalidated" as ThreadId;
  const order: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-invalidated",
    handlers: {
      "thread/resume": () => {
        order.push("thread/resume");
        throw new Error("no rollout found for thread engine-session-invalidated");
      },
      "thread/read": () => {
        order.push("thread/read");
        throw new Error("thread not found: engine-session-invalidated");
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-invalidated" as any,
    engineSessionId: "engine-session-invalidated" as any,
    engineTurnId: "engine-turn-invalidated",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "reconcile_failed");
  assert.equal(result.dropSessionBinding, false);
  assert.equal(result.providerThreadId, undefined);
  assert.equal(result.userChoiceRequired, undefined);
  assert.equal(result.recoveryStrategies, undefined);
  assert.equal("providerTerminal" in result, false);
  assert.match(result.message, /恢复对账暂未确认回合终态/);
  assert.deepEqual(order, [
    "thread/resume",
    "thread/read",
    "thread/resume",
    "thread/read",
    "thread/resume",
    "thread/read",
  ]);
});

test("ThreadSessionManager 普通 thread invalid 异常不会误判会话失效", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-invalid-state" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "engine-session-invalid-state",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        throw new Error("thread state invalid while provider snapshot is syncing");
      },
      "thread/read": () => {
        methods.push("thread/read");
        throw new Error("thread state invalid while provider snapshot is syncing");
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-session-manager-invalid-state" as any,
    engineSessionId: "engine-session-invalid-state" as any,
    engineTurnId: "engine-turn-invalid-state",
    clientUserMessageId: "item-user-invalid-state",
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_recovery_failed");
  assert.equal(result.dropSessionBinding, false);
  assert.deepEqual(methods, ["thread/resume", "thread/read"]);
});

test("ThreadSessionManager idle 回收会释放本地 session 且不清持久化绑定", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-idle-1" as ThreadId;
  let dropped = 0;
  let disposeOptions: ThreadDisposeOptions | null = null;
  const manager = createIdleCleanupManager({
    workspaceId,
    onDropSessionBinding() {
      dropped += 1;
    },
  });
  (manager as any).sessions.set(threadId, {
    session: createFakeSession({
      workspaceId,
      threadId,
      dispose(options) {
        disposeOptions = options ?? null;
      },
    }),
    lastUsedAt: 0,
  });

  const disposed = await manager.disposeIdleSessions(150);

  assert.equal(disposed, 1);
  assert.equal((manager as any).sessions.has(threadId), false);
  assert.equal(dropped, 0);
  assert.deepEqual(disposeOptions, { flushActiveTurn: false, reason: "idle" });
});

test("ThreadSessionManager idle dispose 完成前拒绝 rollback 路径的同 thread getOrCreate", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-idle-race" as ThreadId;
  let releaseDispose!: () => void;
  let markDisposeStarted!: () => void;
  const disposeStarted = new Promise<void>((resolve) => {
    markDisposeStarted = resolve;
  });
  const disposeGate = new Promise<void>((resolve) => {
    releaseDispose = resolve;
  });
  const manager = createIdleCleanupManager({ workspaceId });
  const originalSession = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      markDisposeStarted();
      await disposeGate;
    },
  });
  (manager as any).sessions.set(threadId, { session: originalSession, lastUsedAt: 0 });

  const pendingCleanup = manager.disposeIdleSessions(150);
  await disposeStarted;

  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId })),
    /thread session 正在释放/,
  );
  assert.equal((manager as any).sessions.get(threadId)?.session, originalSession);

  releaseDispose();
  assert.equal(await pendingCleanup, 1);
  const replacement = manager.getOrCreate(createThreadRuntime({ workspaceId, threadId }));
  assert.notEqual(replacement, originalSession);
});

test("ThreadSessionManager disposeThreadWithOptions 向上抛出 dispose 失败", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-dispose-failure" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId });
  let shouldFail = true;
  const originalSession = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      if (shouldFail) throw new Error("dispose failed");
    },
  });
  (manager as any).sessions.set(threadId, {
    session: originalSession,
    lastUsedAt: 0,
  });

  await assert.rejects(
    manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false }),
    /dispose failed/,
  );
  assert.equal((manager as any).sessions.get(threadId)?.session, originalSession);
  assert.equal((manager as any).disposingByThreadId.has(threadId), false);

  shouldFail = false;
  await manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  assert.equal((manager as any).sessions.has(threadId), false);
});

test("ThreadSessionManager 仅在 Codex session 成功释放后回收隔离进程", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-process-release" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const order: string[] = [];
  manager.sessions.set(threadId, {
    session: createFakeSession({
      workspaceId,
      threadId,
      dispose() { order.push("session-dispose"); },
    }),
    lastUsedAt: 0,
  });
  manager.codexAppServer = {
    async releaseThread(candidateThreadId: ThreadId) {
      assert.equal(candidateThreadId, threadId);
      order.push("process-release");
    },
  };

  await manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });

  assert.deepEqual(order, ["session-dispose", "process-release"]);
  assert.equal(manager.sessions.has(threadId), false);
});

test("ThreadSessionManager 精确中断只恢复持久化 A/a 且不覆盖 runtime B", async () => {
  const workspaceId = "client-test:ws-recovery-successor" as WorkspaceId;
  const threadId = "thread-recovery-successor" as ThreadId;
  const requests: Array<{ method: string; params: unknown }> = [];
  const { manager, threads } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    runtimeSessionId: "provider-b",
    handlers: {
      "thread/resume": (params) => {
        requests.push({ method: "thread/resume", params });
        return {};
      },
      "turn/interrupt": (params) => {
        requests.push({ method: "turn/interrupt", params });
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "provider-turn-a",
    allowSiblingRunning: true,
  });
  assert.deepEqual(requests, [
    { method: "turn/interrupt", params: { threadId: "provider-a", turnId: "provider-turn-a" } },
  ]);
  assert.equal(threads.get(threadId)?.sessionId, "provider-b");
});

test("ThreadSessionManager 精确中断仅在明确 thread 不可用时 resume 后重试", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-resume-failed" as WorkspaceId;
  const threadId = "thread-exact-interrupt-resume-failed" as ThreadId;
  const calls: Array<{ method: string; params: unknown }> = [];
  let interruptCount = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    handlers: {
      "thread/resume": (params) => {
        calls.push({ method: "thread/resume", params });
        return {};
      },
      "turn/interrupt": (params) => {
        calls.push({ method: "turn/interrupt", params });
        interruptCount += 1;
        if (interruptCount === 1) throw new Error("thread not found: provider-a");
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.deepEqual(result, {
    kind: "ready",
    actualEngineTurnId: "provider-turn-a",
    allowSiblingRunning: true,
  });
  assert.deepEqual(calls, [
    { method: "turn/interrupt", params: { threadId: "provider-a", turnId: "provider-turn-a" } },
    { method: "thread/resume", params: { threadId: "provider-a" } },
    { method: "turn/interrupt", params: { threadId: "provider-a", turnId: "provider-turn-a" } },
  ]);
});

test("ThreadSessionManager 精确中断 no-active 后按同一 turn 的 terminal read 收口", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-no-active-terminal" as WorkspaceId;
  const threadId = "thread-exact-interrupt-no-active-terminal" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    handlers: {
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw new Error("no active turn to interrupt");
      },
      "thread/read": (params) => {
        methods.push("thread/read");
        assert.deepEqual(params, { threadId: "provider-a", includeTurns: true });
        return {
          thread: {
            id: "provider-a",
            status: "idle",
            turns: [{ id: "provider-turn-a", status: "interrupted", items: [] }],
          },
        };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "terminal");
  if (result.kind !== "terminal") assert.fail("应返回 provider 已确认终态");
  assert.equal(result.actualEngineTurnId, "provider-turn-a");
  assert.equal(result.reconciled.kind, "error");
  assert.equal(result.reconciled.code, "codex_interrupted");
  assert.equal(result.reconciled.providerTerminal, true);
  assert.deepEqual(methods, ["turn/interrupt", "thread/resume", "thread/read"]);
});

test("ThreadSessionManager 精确中断 no-active 后 read 仍 running 时保留 pending", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-no-active-running" as WorkspaceId;
  const threadId = "thread-exact-interrupt-no-active-running" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    handlers: {
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw new Error("no active turn to interrupt");
      },
      "thread/read": () => {
        methods.push("thread/read");
        return {
          thread: {
            id: "provider-a",
            status: "active",
            turns: [{ id: "provider-turn-a", status: "inProgress", items: [] }],
          },
        };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_failed");
  assert.match(result.message, /no active turn to interrupt/);
  assert.match(result.message, /目标回合终态仍未确认/);
  assert.deepEqual(methods, ["turn/interrupt", "thread/read"]);
});

test("ThreadSessionManager 精确中断 no-active 后 read 失败时保留 pending", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-no-active-read-failed" as WorkspaceId;
  const threadId = "thread-exact-interrupt-no-active-read-failed" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    handlers: {
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw new Error("no active turn to interrupt");
      },
      "thread/read": () => {
        methods.push("thread/read");
        throw new Error("thread/read unavailable");
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_failed");
  assert.match(result.message, /终态确认失败：Codex thread\/read 请求失败；binding 保持不变。/);
  assert.deepEqual(methods, ["turn/interrupt", "thread/read"]);
});

test("ThreadSessionManager 精确中断超时后同 ID terminal read 可收口", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-timeout-terminal" as WorkspaceId;
  const threadId = "thread-exact-interrupt-timeout-terminal" as ThreadId;
  const methods: string[] = [];
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    handlers: {
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw new Error("Codex app-server request timeout: turn/interrupt");
      },
      "thread/read": () => {
        methods.push("thread/read");
        return {
          thread: {
            id: "provider-a",
            status: "idle",
            turns: [{ id: "provider-turn-a", status: "cancelled", items: [] }],
          },
        };
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "terminal");
  if (result.kind !== "terminal") assert.fail("终态 read 已明确确认，不应继续 pending");
  assert.equal(result.actualEngineTurnId, "provider-turn-a");
  assert.equal(result.reconciled.kind, "error");
  assert.equal(result.reconciled.providerTerminal, true);
  assert.deepEqual(methods, ["turn/interrupt", "thread/read"]);
});

test("ThreadSessionManager 精确中断传输超时后保留 pending 且不立即重启 app-server", async () => {
  const workspaceId = "client-test:ws-exact-interrupt-target-restart" as WorkspaceId;
  const threadId = "thread-exact-interrupt-target-restart" as ThreadId;
  const methods: string[] = [];
  let restartCalls = 0;
  const { manager } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-target-restart",
    onRestart: () => {
      restartCalls += 1;
    },
    handlers: {
      "turn/interrupt": () => {
        methods.push("turn/interrupt");
        throw Object.assign(new Error("Codex app-server request timeout: turn/interrupt"), {
          code: "codex_app_server_request_timeout",
        });
      },
      "thread/read": () => {
        methods.push("thread/read");
        throw Object.assign(new Error("Codex app-server request timeout: thread/read"), {
          code: "codex_app_server_request_timeout",
        });
      },
      "thread/resume": () => {
        methods.push("thread/resume");
        return {};
      },
    },
  });

  const result = await manager.interruptCodexTurnByEngineIds({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-target-restart" as any,
    engineSessionId: "provider-target-restart" as any,
    engineTurnId: "provider-turn-target-restart",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "pending");
  assert.equal(result.code, "interrupt_failed");
  assert.equal(restartCalls, 0);
  assert.deepEqual(methods, ["turn/interrupt", "thread/read"]);
});

test("ThreadSessionManager 精确终态不受 thread status 过渡值阻断且不覆盖 runtime B", async () => {
  const workspaceId = "client-test:ws-recovery-terminal-successor" as WorkspaceId;
  const threadId = "thread-recovery-terminal-successor" as ThreadId;
  const methods: string[] = [];
  const { manager, threads } = createRecoveryManager({
    workspaceId,
    threadId,
    engineSessionId: "provider-a",
    runtimeSessionId: "provider-b",
    handlers: {
      "thread/resume": (params) => {
        methods.push("thread/resume");
        assert.deepEqual(params, { threadId: "provider-a" });
        return {};
      },
      "thread/read": (params) => {
        methods.push("thread/read");
        assert.deepEqual(params, { threadId: "provider-a", includeTurns: true });
        return {
          thread: {
            id: "provider-a",
            status: "notloaded",
            turns: [{
              id: "provider-turn-a",
              status: "completed",
              items: [{
                type: "agentMessage",
                id: "provider-message-a",
                text: "provider A completed",
                phase: "final_answer",
              }],
            }],
          },
        };
      },
    },
  });

  const result = await manager.reconcileCodexDanglingTurn({
    threadId,
    workspaceId,
    workspacePath: "Z:/code/aidt-code",
    turnId: "turn-a" as any,
    engineSessionId: "provider-a" as any,
    engineTurnId: "provider-turn-a",
    exactProviderTurn: true,
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.responseText, "provider A completed");
  assert.deepEqual(methods, ["thread/read"]);
  assert.equal(threads.get(threadId)?.sessionId, "provider-b");
});

test("ThreadSessionManager 进程回收失败时移除已释放 session 并允许继续回收", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-process-release-failure" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let disposeCalls = 0;
  const session = createFakeSession({
    workspaceId,
    threadId,
    dispose() { disposeCalls += 1; },
  });
  manager.sessions.set(threadId, { session, lastUsedAt: 0 });
  let releaseProcess!: () => void;
  let rejectProcess!: (error: Error) => void;
  manager.codexAppServer = {
    forThread() { return {}; },
    async releaseThread() {
      await new Promise<void>((resolve, reject) => {
        releaseProcess = resolve;
        rejectProcess = reject;
      });
    },
  };

  const firstDisposal = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.sessions.has(threadId), false);
  assert.equal(disposeCalls, 1);
  assert.equal(manager.disposingByThreadId.has(threadId), true);

  rejectProcess(new Error("taskkill failed"));
  await assert.rejects(firstDisposal, /taskkill failed/);
  assert.equal(manager.sessions.has(threadId), false);
  assert.equal(manager.disposingByThreadId.has(threadId), false);

  // 已释放 session 不再复用；重试只回收上次残留的进程。
  const retry = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  await new Promise((resolve) => setImmediate(resolve));
  releaseProcess();
  await retry;
  assert.equal(manager.sessions.has(threadId), false);
  assert.equal(disposeCalls, 1);
  const replacement = manager.getOrCreate(createThreadRuntime({ workspaceId, threadId }));
  assert.notEqual(replacement, session);
});

test("ThreadSessionManager 无内存 session 时仍回收恢复流程创建的隔离进程", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-orphan-process-release" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let releasedThreadId: ThreadId | null = null;
  manager.codexAppServer = {
    async releaseThread(candidateThreadId: ThreadId) {
      releasedThreadId = candidateThreadId;
    },
  };

  await manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });

  assert.equal(releasedThreadId, threadId);
});

test("ThreadSessionManager 无内存 session 时等待孤儿进程回收", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-orphan-process-wait" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let releaseProcess!: () => void;
  let releaseCalls = 0;
  manager.codexAppServer = {
    async releaseThread() {
      releaseCalls += 1;
      await new Promise<void>((resolve) => { releaseProcess = resolve; });
    },
  };
  let completed = false;

  const firstDisposal = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  const secondDisposal = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  const disposal = Promise.all([firstDisposal, secondDisposal])
    .then(() => { completed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  assert.equal(releaseCalls, 1);
  assert.equal(manager.disposingByThreadId.has(threadId), true);
  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId })),
    /thread session 正在释放/,
  );

  releaseProcess();
  await disposal;
  assert.equal(completed, true);
  assert.equal(manager.disposingByThreadId.has(threadId), false);
});

test("ThreadSessionManager 孤儿进程回收失败后清理门禁并允许重试", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-orphan-process-retry" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let releaseCalls = 0;
  manager.codexAppServer = {
    async releaseThread() {
      releaseCalls += 1;
      if (releaseCalls === 1) throw new Error("taskkill failed");
    },
  };

  const first = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  const concurrent = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  await assert.rejects(Promise.all([first, concurrent]), /taskkill failed/);
  assert.equal(releaseCalls, 1);
  assert.equal(manager.disposingByThreadId.has(threadId), false);

  await manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  assert.equal(releaseCalls, 2);
  assert.equal(manager.disposingByThreadId.has(threadId), false);
});

test("ThreadSessionManager 重启会等待 session 与配置步骤完成后再终止 Codex 进程", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-restart-wait" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const order: string[] = [];
  let releaseDispose!: () => void;
  let markDisposeStarted!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  manager.sessions.set(threadId, {
    session: createFakeSession({
      workspaceId,
      threadId,
      async dispose() {
        order.push("dispose-start");
        markDisposeStarted();
        await disposeGate;
        order.push("dispose-end");
      },
    }),
    lastUsedAt: 0,
  });
  let releaseKill!: () => void;
  const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
  manager.codexAppServer = {
    async killAllWorkspaces() {
      order.push("kill-start");
      await killGate;
      order.push("kill-end");
    },
  };

  const restart = manager.restartCodexProcesses({ beforeKill() { order.push("before-kill"); } });
  await disposeStarted;

  assert.deepEqual(order, ["dispose-start"]);
  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: "thread-restart-new" as ThreadId })),
    /正在重启/,
  );
  releaseDispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["dispose-start", "dispose-end", "before-kill", "kill-start"]);
  releaseKill();
  await restart;

  assert.deepEqual(order, ["dispose-start", "dispose-end", "before-kill", "kill-start", "kill-end"]);
  assert.equal(manager.sessions.has(threadId), false);
});

test("ThreadSessionManager 用户显式重启接管仍停在 dispose 的安全重启", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-force-takes-safe" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let releaseDispose!: () => void;
  let markDisposeStarted!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  let invalidationCalls = 0;
  const staleSession = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      markDisposeStarted();
      await disposeGate;
    },
    invalidateAfterProcessTermination() {
      invalidationCalls += 1;
    },
  });
  manager.sessions.set(threadId, { session: staleSession, lastUsedAt: 0 });
  let beforeKillCalls = 0;
  let killCalls = 0;
  manager.codexAppServer = {
    forThread() { return {}; },
    async killAllWorkspaces() { killCalls += 1; },
  };

  const safeResult = manager.restartCodexProcesses({
    beforeKill() { beforeKillCalls += 1; },
  }).then(() => null, (error: Error) => error);
  await disposeStarted;
  await manager.restartCodexProcesses({ mode: "force" });
  const safeError = await safeResult;

  assert.equal((safeError as any)?.code, "codex_restart_superseded_by_force");
  assert.equal(beforeKillCalls, 0);
  assert.equal(killCalls, 1);
  assert.equal(invalidationCalls, 1);
  assert.equal(manager.sessions.has(threadId), false);
  assert.equal(manager.disposingByThreadId.has(threadId), false);
  const successor = manager.getOrCreate(createThreadRuntime({ workspaceId, threadId }));
  assert.notEqual(successor, staleSession);

  releaseDispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.sessions.get(threadId)?.session, successor);
  assert.equal(manager.codexRestartInFlight, null);
});

test("ThreadSessionManager force 接管时保留已升级的 thread 释放门禁", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-force-keeps-thread-disposal" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let markDisposeStarted!: () => void;
  let releaseDispose!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const staleSession = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      markDisposeStarted();
      await disposeGate;
    },
  });
  manager.sessions.set(threadId, { session: staleSession, lastUsedAt: 0 });

  let markReleaseStarted!: () => void;
  let releaseThread!: () => void;
  const releaseStarted = new Promise<void>((resolve) => { markReleaseStarted = resolve; });
  const releaseGate = new Promise<void>((resolve) => { releaseThread = resolve; });
  manager.codexAppServer = {
    forThread() { return {}; },
    async killAllWorkspaces() {},
    async releaseThread() {
      markReleaseStarted();
      await releaseGate;
    },
  };

  const safeResult = manager.restartCodexProcesses().then(() => null, (error: Error) => error);
  await disposeStarted;
  const threadDisposal = manager.disposeThread(threadId);
  await manager.restartCodexProcesses({ mode: "force" });

  assert.equal(manager.disposingByThreadId.get(threadId)?.strength, "thread");
  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId })),
    /正在释放/,
  );

  releaseDispose();
  await releaseStarted;
  assert.equal(manager.disposingByThreadId.get(threadId)?.strength, "thread");
  releaseThread();
  await threadDisposal;

  assert.equal((await safeResult as any)?.code, "codex_restart_superseded_by_force");
  assert.equal(manager.disposingByThreadId.has(threadId), false);
  assert.notEqual(manager.getOrCreate(createThreadRuntime({ workspaceId, threadId })), staleSession);
});

test("ThreadSessionManager 安全重启进入配置提交后 force 复用同一事务", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-force-joins-safe" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  manager.sessions.set(threadId, {
    session: createFakeSession({ workspaceId, threadId, dispose() {} }),
    lastUsedAt: 0,
  });
  let markBeforeKillStarted!: () => void;
  let releaseBeforeKill!: () => void;
  const beforeKillStarted = new Promise<void>((resolve) => { markBeforeKillStarted = resolve; });
  const beforeKillGate = new Promise<void>((resolve) => { releaseBeforeKill = resolve; });
  let beforeKillCalls = 0;
  let killCalls = 0;
  manager.codexAppServer = {
    async killAllWorkspaces() { killCalls += 1; },
  };

  const safe = manager.restartCodexProcesses({
    async beforeKill() {
      beforeKillCalls += 1;
      markBeforeKillStarted();
      await beforeKillGate;
    },
  });
  await beforeKillStarted;
  const force = manager.restartCodexProcesses({ mode: "force" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(killCalls, 0);

  releaseBeforeKill();
  await Promise.all([safe, force]);
  assert.equal(beforeKillCalls, 1);
  assert.equal(killCalls, 1);
  assert.equal(manager.codexRestartInFlight, null);
});

test("ThreadSessionManager 删除会在 restart-only 释放后升级回收残留进程", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-restart-delete-upgrade" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const order: string[] = [];
  let releaseDispose!: () => void;
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  const session = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      order.push("dispose-start");
      await disposeGate;
      order.push("dispose-end");
    },
  });
  manager.sessions.set(threadId, { session, lastUsedAt: 0 });
  let releaseCalls = 0;
  manager.codexAppServer = {
    async releaseThread() {
      releaseCalls += 1;
      order.push("release-thread");
    },
  };

  const restartOnly = manager.disposeSessionRecord(threadId, manager.sessions.get(threadId), {
    flushActiveTurn: true,
    reason: "codex-restart",
  });
  const deletion = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(order, ["dispose-start"]);
  assert.equal(manager.disposingByThreadId.get(threadId)?.strength, "thread");
  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId })),
    /thread session 正在释放/,
  );

  releaseDispose();
  await Promise.all([restartOnly, deletion]);
  assert.deepEqual(order, ["dispose-start", "dispose-end", "release-thread"]);
  assert.equal(releaseCalls, 1);
  assert.equal(manager.sessions.has(threadId), false);
  assert.equal(manager.disposingByThreadId.has(threadId), false);
});

test("ThreadSessionManager restart-only 释放失败时强删除同步失败且可重试", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-restart-delete-failure" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let rejectDispose!: (error: Error) => void;
  let disposeCalls = 0;
  const session = createFakeSession({
    workspaceId,
    threadId,
    async dispose() {
      disposeCalls += 1;
      await new Promise<void>((_resolve, reject) => { rejectDispose = reject; });
    },
  });
  manager.sessions.set(threadId, { session, lastUsedAt: 0 });
  let releaseCalls = 0;
  manager.codexAppServer = { async releaseThread() { releaseCalls += 1; } };

  const restartOnly = manager.disposeSessionRecord(threadId, manager.sessions.get(threadId), {
    flushActiveTurn: true,
    reason: "codex-restart",
  });
  const deletion = manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  await new Promise((resolve) => setImmediate(resolve));
  rejectDispose(new Error("restart dispose failed"));
  const results = await Promise.allSettled([restartOnly, deletion]);

  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.equal(disposeCalls, 1);
  assert.equal(releaseCalls, 0);
  assert.equal(manager.sessions.get(threadId)?.session, session);
  assert.equal(manager.disposingByThreadId.has(threadId), false);

  (session as any).dispose = async () => { disposeCalls += 1; };
  await manager.disposeThreadWithOptions(threadId, { flushActiveTurn: false });
  assert.equal(disposeCalls, 2);
  assert.equal(releaseCalls, 1);
  assert.equal(manager.sessions.has(threadId), false);
});

test("ThreadSessionManager idle 扫描跳过等待期间已换代的旧 session 快照", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const firstThreadId = "thread-session-manager-idle-snapshot-first" as ThreadId;
  const replacedThreadId = "thread-session-manager-idle-snapshot-replaced" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let releaseFirstDispose!: () => void;
  const firstDisposeGate = new Promise<void>((resolve) => { releaseFirstDispose = resolve; });
  const first = createFakeSession({
    workspaceId,
    threadId: firstThreadId,
    async dispose() { await firstDisposeGate; },
  });
  let oldDisposeCalls = 0;
  const old = createFakeSession({
    workspaceId,
    threadId: replacedThreadId,
    dispose() { oldDisposeCalls += 1; },
  });
  let replacementDisposeCalls = 0;
  const replacement = createFakeSession({
    workspaceId,
    threadId: replacedThreadId,
    dispose() { replacementDisposeCalls += 1; },
  });
  manager.sessions.set(firstThreadId, { session: first, lastUsedAt: 0 });
  manager.sessions.set(replacedThreadId, { session: old, lastUsedAt: 0 });
  const released: ThreadId[] = [];
  manager.codexAppServer = {
    async releaseThread(candidateThreadId: ThreadId) { released.push(candidateThreadId); },
  };

  const idleCleanup = manager.disposeIdleSessions(150);
  await new Promise((resolve) => setImmediate(resolve));
  await manager.disposeThreadWithOptions(replacedThreadId, { flushActiveTurn: false });
  manager.sessions.set(replacedThreadId, { session: replacement, lastUsedAt: 150 });
  releaseFirstDispose();

  assert.equal(await idleCleanup, 1);
  assert.equal(oldDisposeCalls, 1);
  assert.equal(replacementDisposeCalls, 0);
  assert.equal(manager.sessions.get(replacedThreadId)?.session, replacement);
  assert.equal(released.filter((threadId) => threadId === replacedThreadId).length, 1);
  assert.equal(released.filter((threadId) => threadId === firstThreadId).length, 1);
});

test("ThreadSessionManager 安全重启在任一 session 释放失败时保留失败项且不终止进程", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const failedThreadId = "thread-session-manager-restart-failed" as ThreadId;
  const succeededThreadId = "thread-session-manager-restart-succeeded" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const failedSession = createFakeSession({
    workspaceId,
    threadId: failedThreadId,
    async dispose() {
      throw new Error("restart dispose failed");
    },
  });
  manager.sessions.set(failedThreadId, { session: failedSession, lastUsedAt: 0 });
  manager.sessions.set(succeededThreadId, {
    session: createFakeSession({ workspaceId, threadId: succeededThreadId, dispose() {} }),
    lastUsedAt: 0,
  });
  let killCalls = 0;
  manager.codexAppServer = {
    async releaseThread() {},
    async killAllWorkspaces() { killCalls += 1; },
  };

  await assert.rejects(
    manager.restartCodexProcesses(),
    (error: any) => error instanceof AggregateError && /restart dispose failed/.test(String(error.errors?.[0]?.cause)),
  );

  assert.equal(killCalls, 0);
  assert.equal(manager.sessions.get(failedThreadId)?.session, failedSession);
  assert.equal(manager.sessions.has(succeededThreadId), false);
  assert.equal(manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: failedThreadId })), failedSession);
});

test("ThreadSessionManager 用户显式重启跳过 stale dispose 并在 kill 成功后清理运行态", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-explicit-restart" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let disposeCalls = 0;
  let invalidationCalls = 0;
  manager.sessions.set(threadId, {
    session: createFakeSession({
      workspaceId,
      threadId,
      dispose() {
        disposeCalls += 1;
        throw new Error("stale local dispose guard");
      },
      invalidateAfterProcessTermination() {
        invalidationCalls += 1;
      },
    }),
    lastUsedAt: 0,
  });
  manager.engineProcesses.upsertThreadService(threadId, createManagedServiceSnapshot("service-explicit-restart"));
  let killCalls = 0;
  manager.codexAppServer = {
    async killAllWorkspaces() { killCalls += 1; },
  };

  await manager.restartCodexProcesses({ mode: "force" });

  assert.equal(disposeCalls, 0);
  assert.equal(invalidationCalls, 1);
  assert.equal(killCalls, 1);
  assert.equal(manager.sessions.has(threadId), false);
  assert.deepEqual(manager.listEngineManagedServices(threadId), []);
});

test("ThreadSessionManager 用户显式重启在真实 kill 失败时显式失败并保留运行态", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-session-manager-explicit-restart-kill-failed" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const session = createFakeSession({ workspaceId, threadId });
  manager.sessions.set(threadId, { session, lastUsedAt: 0 });
  manager.engineProcesses.upsertThreadService(threadId, createManagedServiceSnapshot("service-kill-failed"));
  manager.codexAppServer = {
    async killAllWorkspaces() { throw new Error("taskkill failed"); },
  };

  await assert.rejects(manager.restartCodexProcesses({ mode: "force" }), /taskkill failed/);

  assert.equal(manager.sessions.get(threadId)?.session, session);
  assert.equal(manager.listEngineManagedServices(threadId).length, 1);
  assert.equal(manager.codexRestartInFlight, null);
});

test("ThreadSessionManager 会话重启只终止目标进程，并在终态落库前保持重启门禁", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const targetId = "thread-targeted-restart" as ThreadId;
  const siblingId = "thread-targeted-restart-sibling" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let invalidated = 0;
  const target = createFakeSession({ workspaceId, threadId: targetId,
    invalidateAfterProcessTermination() { invalidated += 1; },
  });
  const sibling = createFakeSession({ workspaceId, threadId: siblingId });
  manager.sessions.set(targetId, { session: target, lastUsedAt: 0 });
  manager.sessions.set(siblingId, { session: sibling, lastUsedAt: 0 });
  let releaseKill!: () => void;
  const kill = new Promise<void>((resolve) => { releaseKill = resolve; });
  const released: ThreadId[] = [];
  manager.codexAppServer = {
    async releaseThread(threadId: ThreadId) { released.push(threadId); await kill; },
    forThread() { return { async drainMessages() {} }; },
    async killAllWorkspaces() { assert.fail("会话重启不能全局终止进程"); },
  };
  let releaseTerminal!: () => void;
  let terminalStarted!: () => void;
  const terminal = new Promise<void>((resolve) => { releaseTerminal = resolve; });
  const terminalStart = new Promise<void>((resolve) => { terminalStarted = resolve; });
  const restart = manager.restartCodexProcesses({
    mode: "force", threadId: targetId, requestId: "targeted-restart",
    async afterTermination(session: ThreadEngineSession | null) {
      assert.equal(session, target);
      terminalStarted();
      await terminal;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidated, 0);
  assert.equal(manager.sessions.get(targetId)?.session, target);
  releaseKill();
  await terminalStart;
  assert.equal(invalidated, 1);
  assert.equal(manager.sessions.get(siblingId)?.session, sibling);
  assert.equal(manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: siblingId })), sibling);
  assert.throws(() => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: targetId })), /正在重启/);
  await assert.rejects(manager.restartCodexProcesses({ mode: "force", threadId: siblingId }), /重启中/);
  releaseTerminal();
  await restart;
  assert.deepEqual(released, [targetId]);
  assert.notEqual(manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: targetId })), target);
  assert.equal(manager.sessions.get(siblingId)?.session, sibling);
});

test("ThreadSessionManager 会话进程终止失败时不执行终态回调，允许重试", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const threadId = "thread-targeted-restart-retry" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const session = createFakeSession({ workspaceId, threadId });
  manager.sessions.set(threadId, { session, lastUsedAt: 0 });
  let failure = true;
  let settled = 0;
  manager.codexAppServer = {
    async releaseThread() { if (failure) throw new Error("taskkill failed"); },
    forThread() { return { async drainMessages() {} }; },
  };
  const options = { mode: "force" as const, threadId, async afterTermination() { settled += 1; } };
  await assert.rejects(manager.restartCodexProcesses(options), /taskkill failed/);
  assert.equal(settled, 0);
  assert.equal(manager.sessions.get(threadId)?.session, session);
  failure = false;
  await manager.restartCodexProcesses(options);
  assert.equal(settled, 1);
  assert.equal(manager.sessions.has(threadId), false);
});

test("ThreadSessionManager idle 回收会跳过 pending 交互或运行中托管服务", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const pendingThreadId = "thread-session-manager-idle-pending" as ThreadId;
  const serviceThreadId = "thread-session-manager-idle-service" as ThreadId;
  let disposed = 0;
  const manager = createIdleCleanupManager({ workspaceId });
  (manager as any).sessions.set(pendingThreadId, {
    session: createFakeSession({
      workspaceId,
      threadId: pendingThreadId,
      canIdleDispose() {
        return false;
      },
      dispose() {
        disposed += 1;
      },
    }),
    lastUsedAt: 0,
  });
  (manager as any).sessions.set(serviceThreadId, {
    session: createFakeSession({
      workspaceId,
      threadId: serviceThreadId,
      dispose() {
        disposed += 1;
      },
    }),
    lastUsedAt: 0,
  });
  manager.setManagedServiceSnapshotProvider((threadId) => threadId === serviceThreadId
    ? [{
        serviceId: "platform:demo",
        source: "platform",
        status: "ready",
        pid: 1234,
        command: "node server.js",
        args: [],
        workingDirectory: "Z:/code/aidt-code",
        startupTimeoutMs: 90_000,
        readySummary: "ready",
        startedAt: 1,
        readyAt: 2,
        exitedAt: null,
        exitCode: null,
        exitSignal: null,
      }]
    : []);

  const cleanupCount = await manager.disposeIdleSessions(150);

  assert.equal(cleanupCount, 0);
  assert.equal(disposed, 0);
  assert.equal((manager as any).sessions.has(pendingThreadId), true);
  assert.equal((manager as any).sessions.has(serviceThreadId), true);
});

test("ThreadSessionManager idle 回收会继续处理失败项之后的 session", async () => {
  const workspaceId = "client-test:ws-thread-session-manager" as WorkspaceId;
  const failedThreadId = "thread-session-manager-idle-failed" as ThreadId;
  const succeedingThreadId = "thread-session-manager-idle-succeeding" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId });
  (manager as any).sessions.set(failedThreadId, {
    session: createFakeSession({
      workspaceId,
      threadId: failedThreadId,
      async dispose() {
        throw new Error("first idle dispose failed");
      },
    }),
    lastUsedAt: 0,
  });
  (manager as any).sessions.set(succeedingThreadId, {
    session: createFakeSession({ workspaceId, threadId: succeedingThreadId, dispose() {} }),
    lastUsedAt: 0,
  });

  await assert.rejects(
    manager.disposeIdleSessions(150),
    (error: any) => error instanceof AggregateError && error.errors.length === 1 && /first idle dispose failed/.test(String(error.errors[0]?.cause)),
  );
  assert.equal((manager as any).sessions.has(failedThreadId), true);
  assert.equal((manager as any).sessions.has(succeedingThreadId), false);
  assert.equal((manager as any).disposingByThreadId.has(failedThreadId), false);
});

test("ThreadSessionManager 会在 Codex session 启动前执行持久化回滚门禁", async () => {
  const workspaceId = "client-test:ws-thread-session-rollback-guard" as WorkspaceId;
  const threadId = "thread-session-rollback-guard" as ThreadId;
  let guardCalls = 0;
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads: { setSessionId() {}, setSessionBinding() {}, dropSessionBinding() {} } as any,
    assertCodexMutationAllowed(candidateThreadId) {
      guardCalls += 1;
      assert.equal(candidateThreadId, threadId);
      throw Object.assign(new Error("存在未确认的 Codex 历史回滚"), { code: "rollback_reconciliation_required" });
    },
  });
  const session = manager.getOrCreate(createThreadRuntime({ workspaceId, threadId }));

  await assert.rejects(
    session.sendMessage({} as any, { conversation() {}, raw() {} }),
    (error: any) => error?.code === "rollback_reconciliation_required",
  );
  assert.equal(guardCalls, 1);
  assert.equal(session.hasActiveTurn(), false);
});

test("ThreadSessionManager getOrCreate 会自动补清失败的持久化 binding，且先清 SQLite 再清 runtime", () => {
  const workspaceId = "client-test:ws-thread-session-detach-retry" as WorkspaceId;
  const threadId = "thread-session-detach-retry" as ThreadId;
  const expectedSessionId = "engine-session-idle";
  const runtime = createThreadRuntime({ workspaceId, threadId });
  let persistedSessionId: string | null = expectedSessionId;
  let clearAttempts = 0;
  let allowPersistedClear = false;
  const cleanupOrder: string[] = [];
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads: {
      get(candidateThreadId: ThreadId) {
        return candidateThreadId === threadId ? runtime : null;
      },
      setSessionId() {},
      setSessionBinding() {},
      dropSessionBinding(candidateThreadId: ThreadId) {
        assert.equal(candidateThreadId, threadId);
        cleanupOrder.push("runtime-drop");
        runtime.sessionId = null;
      },
    } as any,
    clearPersistedSessionBinding(candidateThreadId, candidateExpectedSessionId) {
      assert.equal(candidateThreadId, threadId);
      assert.equal(candidateExpectedSessionId, expectedSessionId);
      clearAttempts += 1;
      cleanupOrder.push("persist-clear");
      if (!allowPersistedClear) throw new Error("persisted binding clear failed");
      persistedSessionId = null;
      return { kind: "cleared" };
    },
  });
  const session = manager.getOrCreate(runtime);

  assert.throws(
    () => (session as any).dropSessionBinding(),
    /persisted binding clear failed/,
  );
  assert.equal(session.getSessionId(), null);
  assert.equal((session as any).pendingSessionBindingDrop?.expectedSessionId, expectedSessionId);
  assert.equal(runtime.sessionId, expectedSessionId);
  assert.equal(persistedSessionId, expectedSessionId);
  assert.deepEqual(cleanupOrder, ["persist-clear"]);

  assert.throws(() => manager.getOrCreate(runtime), /persisted binding clear failed/);
  assert.equal(runtime.sessionId, expectedSessionId);
  assert.equal(persistedSessionId, expectedSessionId);
  assert.deepEqual(cleanupOrder, ["persist-clear", "persist-clear"]);

  allowPersistedClear = true;
  assert.equal(manager.getOrCreate(runtime), session);
  assert.equal(clearAttempts, 3);
  assert.equal(persistedSessionId, null);
  assert.equal(runtime.sessionId, null);
  assert.equal((session as any).pendingSessionBindingDrop, null);
  assert.deepEqual(cleanupOrder, ["persist-clear", "persist-clear", "persist-clear", "runtime-drop"]);
});

test("ThreadSessionManager pending binding drop 不会误清已换代的 runtime binding", () => {
  const workspaceId = "client-test:ws-thread-session-detach-cas" as WorkspaceId;
  const threadId = "thread-session-detach-cas" as ThreadId;
  const runtime = createThreadRuntime({ workspaceId, threadId });
  let clearCalls = 0;
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads: {
      get(candidateThreadId: ThreadId) {
        return candidateThreadId === threadId ? runtime : null;
      },
      setSessionId() {},
      setSessionBinding() {},
      dropSessionBinding() {
        assert.fail("不得清除已换代的 runtime binding");
      },
    } as any,
    clearPersistedSessionBinding() {
      clearCalls += 1;
      throw new Error("first persisted clear failed");
    },
  });
  const session = manager.getOrCreate(runtime);
  assert.throws(() => (session as any).dropSessionBinding(), /first persisted clear failed/);
  runtime.sessionId = "engine-session-new" as any;

  assert.throws(
    () => manager.getOrCreate(runtime),
    /拒绝清除新 runtime 绑定.*expected=engine-session-idle.*actual=engine-session-new/,
  );
  assert.equal(clearCalls, 1);
  assert.equal(runtime.sessionId, "engine-session-new");
});

test("ThreadSessionManager 区分持久化 binding 已空与已换代，且不误清 successor", () => {
  const workspaceId = "client-test:ws-thread-session-persisted-cas" as WorkspaceId;
  const threadId = "thread-session-persisted-cas" as ThreadId;
  const expectedSessionId = "engine-session-old";
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "persisted binding CAS",
    sessionId: expectedSessionId as any,
  });
  let persistedState: "successor" | "empty" = "successor";
  let clearCalls = 0;
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    clearPersistedSessionBinding(candidateThreadId, candidateExpectedSessionId) {
      assert.equal(candidateThreadId, threadId);
      assert.equal(candidateExpectedSessionId, expectedSessionId);
      clearCalls += 1;
      return persistedState === "successor"
        ? { kind: "session_mismatch", actualSessionId: "engine-session-successor" as any }
        : { kind: "already_cleared" };
    },
  });
  const session = manager.getOrCreate(runtime);

  assert.throws(
    () => (session as any).dropSessionBinding(),
    /拒绝清除新 persisted 绑定.*expected=engine-session-old.*actual=engine-session-successor/,
  );
  assert.equal(runtime.sessionId, expectedSessionId);
  assert.equal((session as any).pendingSessionBindingDrop?.expectedSessionId, expectedSessionId);

  persistedState = "empty";
  assert.equal(manager.getOrCreate(runtime), session);
  assert.equal(clearCalls, 2);
  assert.equal(runtime.sessionId, null);
  assert.equal((session as any).pendingSessionBindingDrop, null);
});

test("ThreadSessionManager 无 expectedSessionId 时保留通用 binding 清理语义", () => {
  const workspaceId = "client-test:ws-thread-session-generic-clear" as WorkspaceId;
  const threadId = "thread-session-generic-clear" as ThreadId;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "generic binding clear",
  });
  let receivedExpectedSessionId: unknown = "not-called";
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    clearPersistedSessionBinding(_candidateThreadId, candidateExpectedSessionId) {
      receivedExpectedSessionId = candidateExpectedSessionId;
    },
  });
  const session = manager.getOrCreate(runtime) as any;

  session.opts.onSessionBindingDropped(null);

  assert.equal(receivedExpectedSessionId, undefined);
  assert.equal(runtime.sessionId, null);
});

test("ThreadSessionManager expected 清理缺少 CAS 结果时 fail-closed", () => {
  const workspaceId = "client-test:ws-thread-session-cas-result" as WorkspaceId;
  const threadId = "thread-session-cas-result" as ThreadId;
  const runtime = createThreadRuntime({ workspaceId, threadId });
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads: {
      get() { return runtime; },
      setSessionId() {},
      setSessionBinding() {},
      dropSessionBinding() {
        assert.fail("缺少 CAS 结果时不得清 runtime binding");
      },
    } as any,
    clearPersistedSessionBinding() {},
  });
  const session = manager.getOrCreate(runtime);

  assert.throws(
    () => (session as any).dropSessionBinding(),
    /缺少 persisted binding CAS 结果/,
  );
  assert.equal(runtime.sessionId, "engine-session-idle");
});

test("ThreadSessionManager capability 恢复使用持久化 CAS 后再发布内存", () => {
  const workspaceId = "client-test:ws-capability-restore" as WorkspaceId;
  const threadId = "thread-capability-restore" as ThreadId;
  const providerThreadId = "provider-capability-restore" as any;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "capability restore",
    sessionId: providerThreadId,
  });
  const calls: string[] = [];
  const originalSetSessionBinding = threads.setSessionBinding.bind(threads);
  threads.setSessionBinding = (...args) => {
    calls.push("runtime");
    originalSetSessionBinding(...args);
  };
  const capabilities = {
    codexDynamicToolIds: ["runtime.submitNodeResult"],
    codexDynamicToolBindingVersion: "binding-v1",
  };
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    persistSessionCapabilitiesIfMatches(candidateThreadId, expectedSessionId, candidateCapabilities) {
      calls.push("persisted-cas");
      assert.equal(candidateThreadId, threadId);
      assert.equal(expectedSessionId, providerThreadId);
      assert.deepEqual(candidateCapabilities, capabilities);
      assert.equal(runtime.sessionCapabilities, null);
      return { kind: "restored" };
    },
  });

  assert.equal(manager.restoreCodexSessionCapabilities(threadId, providerThreadId, capabilities), true);
  assert.deepEqual(calls, ["persisted-cas", "runtime"]);
  assert.deepEqual(runtime.sessionCapabilities, capabilities);
});

test("ThreadSessionManager capability CAS 拒绝或抛错时不污染内存", () => {
  const workspaceId = "client-test:ws-capability-restore-failure" as WorkspaceId;
  const threadId = "thread-capability-restore-failure" as ThreadId;
  const providerThreadId = "provider-capability-restore-failure" as any;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "capability restore failure",
    sessionId: providerThreadId,
  });
  const capabilities = {
    codexDynamicToolIds: ["runtime.submitNodeResult"],
    codexDynamicToolBindingVersion: "binding-v1",
  };
  let mode: "mismatch" | "throw" = "mismatch";
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    persistSessionCapabilitiesIfMatches() {
      if (mode === "throw") throw new Error("capability CAS failed");
      return { kind: "session_mismatch", actualSessionId: "provider-successor" as any };
    },
  });

  assert.equal(manager.restoreCodexSessionCapabilities(threadId, providerThreadId, capabilities), false);
  assert.equal(runtime.sessionId, providerThreadId);
  assert.equal(runtime.sessionCapabilities, null);

  mode = "throw";
  assert.throws(
    () => manager.restoreCodexSessionCapabilities(threadId, providerThreadId, capabilities),
    /capability CAS failed/,
  );
  assert.equal(runtime.sessionId, providerThreadId);
  assert.equal(runtime.sessionCapabilities, null);
});

test("ThreadSessionManager 业务终态只释放同一 Codex binding 的 recovery fence", () => {
  const workspaceId = "client-test:ws-release-recovery-fence" as WorkspaceId;
  const threadId = "thread-release-recovery-fence" as ThreadId;
  const providerThreadId = "provider-release-recovery-fence" as any;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "release recovery fence",
    sessionId: providerThreadId,
  });
  let persistedClearCalls = 0;
  let runtimeDropCalls = 0;
  const originalDropSessionBinding = threads.dropSessionBinding.bind(threads);
  threads.dropSessionBinding = (...args) => {
    runtimeDropCalls += 1;
    originalDropSessionBinding(...args);
  };
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
    clearPersistedSessionBinding() {
      persistedClearCalls += 1;
      return { kind: "cleared" };
    },
  }) as any;
  let releaseThreadCalls = 0;
  manager.codexAppServer = {
    forThread() { return {}; },
    async releaseThread() { releaseThreadCalls += 1; },
  };
  const session = manager.getOrCreate(runtime) as any;
  session.recoveryPending = true;

  assert.equal(manager.releaseCodexRecoveryPending(threadId, providerThreadId), true);
  assert.equal(session.isRecoveryPending(), false);
  assert.equal(runtime.sessionId, providerThreadId);
  assert.equal(persistedClearCalls, 0);
  assert.equal(runtimeDropCalls, 0);
  assert.equal(releaseThreadCalls, 0);
});

test("ThreadSessionManager recovery fence 释放在无缓存时幂等，binding 冲突时 fail-closed", () => {
  const workspaceId = "client-test:ws-release-recovery-fence-guard" as WorkspaceId;
  const threadId = "thread-release-recovery-fence-guard" as ThreadId;
  const providerThreadId = "provider-release-recovery-fence-guard" as any;
  const threads = new ThreadStore();
  const runtime = threads.create({
    threadId,
    workspaceId,
    engine: "codex",
    title: "release recovery fence guard",
    sessionId: providerThreadId,
  });
  const manager = new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[workspaceId, "Z:/code/aidt-code"]]),
    threads,
  }) as any;

  assert.equal(manager.releaseCodexRecoveryPending(threadId, providerThreadId), true);
  assert.equal(manager.releaseCodexRecoveryPending(threadId, "provider-other"), false);

  manager.codexAppServer = { forThread() { return {}; } };
  const session = manager.getOrCreate(runtime) as any;
  session.recoveryPending = true;
  session.sessionId = "provider-other";

  assert.equal(manager.releaseCodexRecoveryPending(threadId, providerThreadId), false);
  assert.equal(session.isRecoveryPending(), true);
  assert.equal(runtime.sessionId, providerThreadId);
});

test("ThreadSessionManager 真实 provider 失败终态携带结构化标记", () => {
  const mapped = mapCodexRecoveryOutcome(
    { kind: "error", message: "provider turn failed", code: "codex_failed" },
    {
      workspaceId: "client-test:ws-provider-terminal" as WorkspaceId,
      threadId: "thread-provider-terminal" as ThreadId,
      turnId: "turn-provider-terminal" as any,
    },
  );

  assert.deepEqual(mapped, {
    kind: "error",
    message: "provider turn failed",
    code: "codex_failed",
    dropSessionBinding: false,
    providerTerminal: true,
  });
});

test("ThreadSessionManager stopAndDrain 等待全部引擎 session 并拒绝停止后的新工作", async () => {
  const workspaceId = "client-test:ws-thread-session-manager-stop" as WorkspaceId;
  const codexThreadId = "thread-session-manager-stop-codex" as ThreadId;
  const claudeThreadId = "thread-session-manager-stop-claude" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let markDisposeStarted!: () => void;
  let releaseDispose!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  let disposeOptions: ThreadDisposeOptions | null = null;
  let claudeDisposeCalls = 0;
  const codexSession = createFakeSession({
    workspaceId,
    threadId: codexThreadId,
    async dispose(options) {
      disposeOptions = options ?? null;
      markDisposeStarted();
      await disposeGate;
    },
  });
  const claudeSession = createFakeSession({
    workspaceId,
    threadId: claudeThreadId,
    dispose() { claudeDisposeCalls += 1; },
  }) as any;
  claudeSession.engine = "claude";
  manager.sessions.set(codexThreadId, { session: codexSession, lastUsedAt: 0 });
  manager.sessions.set(claudeThreadId, { session: claudeSession, lastUsedAt: 0 });
  const releasedThreads: ThreadId[] = [];
  manager.codexAppServer = {
    async releaseThread(threadId: ThreadId) { releasedThreads.push(threadId); },
  };

  const draining = manager.stopAndDrain();
  await disposeStarted;
  let settled = false;
  void draining.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(manager.idleCleanupTimer, null);
  assert.throws(
    () => manager.getOrCreate(createThreadRuntime({ workspaceId, threadId: "thread-stop-late" as ThreadId })),
    /正在停止/,
  );
  assert.throws(
    () => manager.createIsolatedSession({
      sessionKey: "isolated-stop-late",
      workspaceId,
      engine: "claude",
      onSessionId() {},
    }),
    /正在停止/,
  );
  await assert.rejects(manager.restartCodexProcesses(), /正在停止/);
  await assert.rejects(
    manager.reconcileCodexDanglingTurn({
      threadId: codexThreadId,
      workspaceId,
      workspacePath: "Z:/code/aidt-code",
      turnId: "turn-stop-late",
      engineSessionId: "session-stop-late",
    }),
    /正在停止/,
  );

  releaseDispose();
  await draining;

  assert.deepEqual(disposeOptions, { flushActiveTurn: true, reason: "thread-disposed" });
  assert.deepEqual(releasedThreads, [codexThreadId]);
  assert.equal(claudeDisposeCalls, 1);
  assert.equal(manager.sessions.has(claudeThreadId), false);
});

test("ThreadSessionManager stopAndDrain 处理全部 Codex session 后聚合释放失败", async () => {
  const workspaceId = "client-test:ws-thread-session-manager-stop-errors" as WorkspaceId;
  const failedThreadIds = [
    "thread-session-manager-stop-failed-1",
    "thread-session-manager-stop-failed-2",
  ] as ThreadId[];
  const succeededThreadId = "thread-session-manager-stop-succeeded" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  for (const threadId of failedThreadIds) {
    manager.sessions.set(threadId, {
      session: createFakeSession({
        workspaceId,
        threadId,
        async dispose() { throw new Error(`dispose failed: ${threadId}`); },
      }),
      lastUsedAt: 0,
    });
  }
  let succeededDisposeCalls = 0;
  manager.sessions.set(succeededThreadId, {
    session: createFakeSession({
      workspaceId,
      threadId: succeededThreadId,
      dispose() { succeededDisposeCalls += 1; },
    }),
    lastUsedAt: 0,
  });
  const releasedThreads: ThreadId[] = [];
  manager.codexAppServer = {
    async releaseThread(threadId: ThreadId) { releasedThreads.push(threadId); },
  };

  const error = await manager.stopAndDrain().then(() => null, (cause: unknown) => cause);

  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors.length, 2);
  assert.match(error.errors[0].message, new RegExp(failedThreadIds[0]!));
  assert.match(error.errors[1].message, new RegExp(failedThreadIds[1]!));
  assert.equal(succeededDisposeCalls, 1);
  assert.deepEqual(releasedThreads, [succeededThreadId]);
  assert.equal(manager.sessions.has(succeededThreadId), false);
});

test("ThreadSessionManager stopAndDrain 等待已开始的 idle dispose 并释放剩余引擎 session", async () => {
  const workspaceId = "client-test:ws-thread-session-manager-stop-idle" as WorkspaceId;
  const activeThreadId = "thread-session-manager-stop-idle-active" as ThreadId;
  const queuedThreadId = "thread-session-manager-stop-idle-queued" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  let markDisposeStarted!: () => void;
  let releaseDispose!: () => void;
  const disposeStarted = new Promise<void>((resolve) => { markDisposeStarted = resolve; });
  const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
  let queuedDisposeCalls = 0;
  const activeSession = createFakeSession({
    workspaceId,
    threadId: activeThreadId,
    async dispose() {
      markDisposeStarted();
      await disposeGate;
    },
  }) as any;
  activeSession.engine = "claude";
  const queuedSession = createFakeSession({
    workspaceId,
    threadId: queuedThreadId,
    dispose() { queuedDisposeCalls += 1; },
  }) as any;
  queuedSession.engine = "claude";
  manager.sessions.set(activeThreadId, { session: activeSession, lastUsedAt: 0 });
  manager.sessions.set(queuedThreadId, { session: queuedSession, lastUsedAt: 0 });

  const idleCleanup = manager.disposeIdleSessions(150);
  await disposeStarted;
  const draining = manager.stopAndDrain();
  let settled = false;
  void draining.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  releaseDispose();
  assert.equal(await idleCleanup, 1);
  await draining;
  assert.equal(queuedDisposeCalls, 1);
  assert.equal(manager.sessions.has(queuedThreadId), false);
});

test("ThreadSessionManager stopAndDrain 等待 restart owner 与被 force 移除的旧 disposal owner", async () => {
  const workspaceId = "client-test:ws-thread-session-manager-stop-restart" as WorkspaceId;
  const threadId = "thread-session-manager-stop-restart" as ThreadId;
  const manager = createIdleCleanupManager({ workspaceId }) as any;
  const record = {
    session: createFakeSession({ workspaceId, threadId }),
    lastUsedAt: 0,
  };
  manager.sessions.set(threadId, record);
  let releaseDisposal!: () => void;
  const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve; });
  manager.disposingByThreadId.set(threadId, {
    strength: "session",
    promise: disposalGate,
    record,
  });
  let markKillStarted!: () => void;
  let releaseKill!: () => void;
  const killStarted = new Promise<void>((resolve) => { markKillStarted = resolve; });
  const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
  manager.codexAppServer = {
    async killAllWorkspaces() {
      markKillStarted();
      await killGate;
    },
  };
  const restart = manager.restartCodexProcesses({ mode: "force" });
  await killStarted;

  const draining = manager.stopAndDrain();
  let settled = false;
  void draining.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseKill();
  await restart;
  assert.equal(manager.disposingByThreadId.has(threadId), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseDisposal();
  await draining;
});

function createIdleCleanupManager(input: {
  workspaceId: WorkspaceId;
  onDropSessionBinding?: () => void;
}): ThreadSessionManager {
  return new ThreadSessionManager({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspaces: new Map([[input.workspaceId, "Z:/code/aidt-code"]]),
    threads: {
      setSessionId() {},
      setSessionBinding() {},
      dropSessionBinding() {
        input.onDropSessionBinding?.();
      },
    } as any,
    sessionIdleCleanup: {
      enabled: true,
      idleMs: 100,
      scanMs: 1_000,
      now: () => 0,
    },
  });
}

/** 构造只用于 manager getOrCreate 的 Codex thread runtime。 */
function createThreadRuntime(input: { workspaceId: WorkspaceId; threadId: ThreadId }): any {
  return {
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    engine: "codex",
    title: "test thread",
    sessionId: "engine-session-idle",
    sessionCapabilities: null,
  };
}

function createFakeSession(input: {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  canIdleDispose?: () => boolean;
  dispose?: (options?: ThreadDisposeOptions) => void | Promise<void>;
  invalidateAfterProcessTermination?: () => void;
}): ThreadEngineSession {
  const session: ThreadEngineSession = {
    engine: "codex",
    workspaceId: input.workspaceId,
    threadId: input.threadId,
    getSessionId() {
      return "engine-session-idle" as any;
    },
    hasActiveTurn() {
      return false;
    },
    resolvePlatformToolTransport() {
      return "protocol";
    },
    async prepareAssistantTerminalEvents() {
      return { events: [], latestAssistantText: null };
    },
    async sendMessage() {
      return { responseText: "" };
    },
    async interrupt() {
      return false;
    },
  };
  if (input.canIdleDispose) session.canIdleDispose = input.canIdleDispose;
  if (input.dispose) session.dispose = input.dispose;
  if (input.invalidateAfterProcessTermination) {
    session.invalidateAfterProcessTermination = input.invalidateAfterProcessTermination;
  }
  return session;
}

/** 构造 engine runtime 清理断言所需的最小托管进程快照。 */
function createManagedServiceSnapshot(serviceId: string) {
  return {
    serviceId,
    status: "ready" as const,
    pid: 1234,
    command: "codex-tool",
    args: [],
    workingDirectory: "Z:/code/aidt-code",
    startupTimeoutMs: 1_000,
    readySummary: "ready",
    startedAt: 1,
    readyAt: 1,
    exitedAt: null,
    exitCode: null,
    exitSignal: null,
  };
}
