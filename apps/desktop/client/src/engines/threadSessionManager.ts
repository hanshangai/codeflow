import type { ConversationEventInput, EngineModelProviderId, EngineType, ManagedServiceSnapshot, SessionId, ThreadId, ThreadSessionCapabilities, TurnId, WorkspaceId } from "@codeflowai/shared";

import type { CodexRuntimeConfig, EngineCredentialConfig } from "../enginesConfig.js";
import type { ThreadRuntime, ThreadStore } from "../threads/threadStore.js";
import { EngineProcessRuntime } from "./engineProcessRuntime.js";
import { buildAssistantCompletedEvent } from "./assistantLifecycle.js";
import { ClaudeThreadSession } from "./claude/claudeThreadSession.js";
import { CodexAppServerManager, type CodexAppServerThreadManager } from "./codex-app-server/codexAppServerManager.js";
import { CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS } from "./codex-app-server/codexAppServerWorkspace.js";
import type { CodexHistoryProjection } from "./codex-app-server/codexAppServerHistory.js";
import { extractCodexThreadReadRecoveryOutcome, type CodexTurnRecoveryOutcome } from "./codex-app-server/codexTurnRecovery.js";
import {
  CodexAppServerThreadSession,
  resumeCodexProviderThreadForRead,
  type CodexDetachedProviderRecoveryInput,
  type CodexStartAttemptInput,
} from "./codex-app-server/codexAppServerThreadSession.js";
import type { AppendTurnInput, AppendTurnResult, ThreadDisposeOptions, ThreadEngineSession, ThreadInterruptOptions } from "./threadSession.js";
import { createEngineWorkspaceLogFailure, engineDiagnosticCause, engineDiagnosticField, isEngineWorkspaceLogFailure, writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "./threadSession.js";
import type { WorkspaceLogEntry } from "../logger.js";
import type { BuiltInRelayCredentialService, EngineCredentialLease } from '../security/builtInRelayCredentialService.js';
import type { DesktopCloudAccountOwner } from '../runtime/desktopCloudAccount.js';

export type CodexDanglingTurnFailureResult = {
  kind: "error" | "pending";
  message: string;
  code: string;
  dropSessionBinding: boolean;
  actualEngineTurnId?: string;
  providerThreadId?: SessionId | null;
  preserveBinding?: boolean;
  userChoiceRequired?: boolean;
  recoveryStrategies?: readonly ["retry-existing", "new-thread"];
};

export type CodexDanglingTurnReconcileResult =
  | {
      kind: "completed";
      responseText: string | null;
      assistantEvents: ConversationEventInput[];
      actualEngineTurnId?: string;
    }
  | CodexDanglingTurnFailureResult;

type CodexTerminalReconcileResult =
  | Extract<CodexDanglingTurnReconcileResult, { kind: "completed" }>
  | (Omit<CodexDanglingTurnFailureResult, "kind"> & {
      kind: "error";
      providerTerminal: true;
    });

export type CodexRecoveredInterruptResult =
  | { kind: "ready"; actualEngineTurnId: string; allowSiblingRunning: true }
  | {
      kind: "terminal";
      actualEngineTurnId: string;
      allowSiblingRunning: true;
      reconciled: CodexTerminalReconcileResult;
    }
  | CodexDanglingTurnFailureResult;

type CodexThreadReadAttempt =
  | { kind: "read"; value: unknown }
  | { kind: "failed"; message: string; retryable?: boolean; error?: unknown };

/** 统一恢复 RPC 的长预算与迟到结算追踪，避免各调用点回退到 10 秒。 */
const CODEX_RECOVERY_REQUEST_OPTIONS = {
  timeoutMs: CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS,
  trackLateSettlement: true,
} as const;

export const THREAD_DELETION_IN_PROGRESS_CODE = "thread_deletion_in_progress";
export const THREAD_OPERATION_IN_PROGRESS_CODE = "thread_operation_in_progress";
export const THREAD_RUNTIME_STALE_CODE = "thread_runtime_stale";

export type PersistedSessionBindingClearResult =
  | { kind: "cleared" }
  | { kind: "already_cleared" }
  | { kind: "session_mismatch"; actualSessionId: SessionId }
  | { kind: "thread_missing" };

export type PersistedSessionCapabilitiesRestoreResult =
  | { kind: "restored" }
  | { kind: "session_mismatch"; actualSessionId: SessionId | null }
  | { kind: "thread_missing" };

type ThreadSessionRecord = {
  session: ThreadEngineSession;
  lastUsedAt: number;
};

type ThreadDisposalStrength = "session" | "thread";

type ThreadDisposal = {
  strength: ThreadDisposalStrength;
  promise: Promise<void>;
  record: ThreadSessionRecord | null;
};

export type IsolatedThreadSessionHandle = {
  session: ThreadEngineSession;
  dispose: () => Promise<void>;
};

type SessionIdleCleanupOptions = {
  enabled?: boolean;
  idleMs?: number;
  scanMs?: number;
  now?: () => number;
};

type CodexRestartOptions =
  | {
      mode: "force";
      beforeKill?: never;
      threadId?: ThreadId;
      requestId?: string;
      afterTermination?: (session: ThreadEngineSession | null) => Promise<void>;
    }
  | { mode?: "safe"; beforeKill?: () => void | Promise<void> };

type CodexRestartOwner = {
  mode: "safe" | "force";
  threadId: ThreadId | null;
  promise: Promise<void>;
  killCommitted: boolean;
  supersede: () => void;
};

/** 标记 safe restart 已由用户显式 force 接管，供 Key 事务及时回滚。 */
function createCodexRestartSupersededError(): Error & { code: "codex_restart_superseded_by_force" } {
  return Object.assign(new Error("Codex 安全重启已由用户显式强制重启接管"), {
    code: "codex_restart_superseded_by_force" as const,
  });
}

type NormalizedSessionIdleCleanupOptions = {
  enabled: boolean;
  idleMs: number;
  scanMs: number;
  now: () => number;
};

const DEFAULT_SESSION_IDLE_DISPOSE_MS = 30 * 60_000;
const DEFAULT_SESSION_IDLE_SCAN_MS = 5 * 60_000;
const CODEX_RECOVERY_TURN_LIMIT = 64;

/**
 * thread → engine session 管理：
 * - 同一 thread 复用同一 session 实例
 * - sessionId 写回 ThreadStore（供 resume）
 */
export class ThreadSessionManager {
  private readonly sessions = new Map<ThreadId, ThreadSessionRecord>();
  private readonly disposingByThreadId = new Map<ThreadId, ThreadDisposal>();
  private readonly deletingThreadIds = new Set<ThreadId>();
  private readonly activeOperationCountByThreadId = new Map<ThreadId, number>();
  private readonly engineProcesses = new EngineProcessRuntime();
  private readonly codexAppServer: CodexAppServerManager;
  private readonly idleCleanup: NormalizedSessionIdleCleanupOptions;
  private idleCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private idleCleanupRunning = false;
  private idleCleanupTask: Promise<number> | null = null;
  private stopping = false;
  private codexRestartInFlight: CodexRestartOwner | null = null;
  private managedServiceSnapshotProvider: ((threadId: ThreadId) => ManagedServiceSnapshot[]) | null = null;
  private readonly credentialLeasesByThread = new Map<string, EngineCredentialLease>();
  private readonly credentialOwnersByThread = new Map<string, DesktopCloudAccountOwner & { keyId?: string }>();

  constructor(
    private readonly opts: {
      workspaces: Map<WorkspaceId, string>;
      writeWorkspaceLog: EngineWorkspaceLogWriter;
      threads: ThreadStore;
      withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
      clearPersistedSessionBinding?: (
        threadId: ThreadId,
        expectedSessionId?: SessionId,
        workspaceId?: WorkspaceId,
      ) => PersistedSessionBindingClearResult | void;
      /** Codex provider 绑定先写入本地持久层，再发布到运行态与 canonical 事件。 */
      persistSessionBinding?: (
        threadId: ThreadId,
        sessionId: SessionId,
        sessionCapabilities: ThreadRuntime["sessionCapabilities"],
        workspaceId?: WorkspaceId,
      ) => void;
      /** 仅当持久层仍绑定 expectedSessionId 时恢复 capability；实现必须使用单条 CAS 写。 */
      persistSessionCapabilitiesIfMatches?: (
        threadId: ThreadId,
        expectedSessionId: SessionId,
        sessionCapabilities: ThreadSessionCapabilities,
        workspaceId?: WorkspaceId,
      ) => PersistedSessionCapabilitiesRestoreResult;
      /** turn/start response 到达时同步保存 ACK 前的 attempt 证据。 */
      persistCodexStartAttempt?: (input: CodexStartAttemptInput) => void;
      /** 从 Client DB 解析当前活动 Codex Key，供 app-server 进程命令行覆盖使用。 */
      resolveCodexRuntimeConfig?: () => CodexRuntimeConfig | null;
      builtInRelayCredentials?: BuiltInRelayCredentialService;
      resolveClaudeCredentials?: (providerId: EngineModelProviderId) => EngineCredentialConfig | null;
      resolveClaudeModelProvider?: (model: string | null | undefined) => EngineModelProviderId | null;
      hasClaudeCredentials?: (providerId: EngineModelProviderId) => boolean;
      /** 在 Codex 新 mutation 前执行持久化门禁；抛错即拒绝启动。 */
      assertCodexMutationAllowed?: (threadId: ThreadId) => void;
      /** 惰性读取或初始化 Client-local Skill opaque-id HMAC key。 */
      getThreadInputActionHmacKey?: () => Buffer;
      sessionIdleCleanup?: SessionIdleCleanupOptions;
    },
  ) {
    this.codexAppServer = new CodexAppServerManager({
      writeWorkspaceLog: opts.writeWorkspaceLog,
      // 对齐 Codex CLI：不注入 CodeFlow 标识，保持 UA/originator 与 CLI 一致，便于上游代理识别。
      clientInfo: { name: "codex_cli_rs", title: "Codex CLI", version: "0.98.0" },
      resolveCodexRuntimeConfig: threadId => opts.withLegacyDatabase
        ? this.withDatabase(`codex-config:${threadId}`, () => this.resolveCodexRuntimeConfigForThread(threadId))
        : this.resolveCodexRuntimeConfigForThread(threadId),
    });
    this.idleCleanup = normalizeSessionIdleCleanupOptions(opts.sessionIdleCleanup);
    this.startIdleCleanupTimer();
  }

  /** 持久回调沿原owner的同步短段准入，进程与会话等待不持许可。 */
  private async withDatabase<T>(requestId: string, operation: () => T): Promise<T> {
    return this.opts.withLegacyDatabase ? this.opts.withLegacyDatabase(requestId, operation) : operation();
  }

  /** 设置跨运行时托管服务读取器，供 idle 回收避开仍有服务的 thread。 */
  setManagedServiceSnapshotProvider(provider: ((threadId: ThreadId) => ManagedServiceSnapshot[]) | null): void {
    this.managedServiceSnapshotProvider = provider;
  }

  /** 获取或创建 thread 对应的引擎会话。 */
  getOrCreate(thread: ThreadRuntime): ThreadEngineSession {
    this.assertNotStopping();
    this.assertThreadAvailable(thread.threadId, thread);
    if (thread.engine === "codex" && this.codexRestartInFlight
      && (!this.codexRestartInFlight.threadId || this.codexRestartInFlight.threadId === thread.threadId)) {
      throw new Error("Codex app-server 正在重启，请稍后重试");
    }
    if (this.disposingByThreadId.has(thread.threadId)) {
      throw new Error(`thread session 正在释放，请稍后重试：${thread.threadId}`);
    }
    const existing = this.sessions.get(thread.threadId);
    if (existing) {
      if (existing.session instanceof CodexAppServerThreadSession) {
        existing.session.retryPendingSessionBindingDrop();
      }
      existing.lastUsedAt = this.idleCleanup.now();
      return existing.session;
    }

    const workspacePath = this.opts.workspaces.get(thread.workspaceId);
    if (!workspacePath) throw new Error(`未知 workspaceId：${thread.workspaceId}`);

    if (thread.engine === "claude") {
      const created = new ClaudeThreadSession({
        withLegacyDatabase: this.opts.withLegacyDatabase,
        writeWorkspaceLog: this.opts.writeWorkspaceLog,
        workspacePath,
        workspaceId: thread.workspaceId,
        threadId: thread.threadId,
        initialSessionId: thread.sessionId,
        onEngineProcessSnapshot: (snapshot) => this.engineProcesses.upsertThreadService(thread.threadId, snapshot),
        onSessionId: (sid) => {
          this.opts.threads.setSessionId(thread.threadId, sid);
        },
        readProviderCredentials: this.opts.resolveClaudeCredentials,
        resolveModelProvider: this.opts.resolveClaudeModelProvider,
        hasConfiguredProviderCredentials: this.opts.hasClaudeCredentials,
        acquireCredential: input => this.acquireCredentialForThread(thread.threadId, 'claude', input),
      });
      this.sessions.set(thread.threadId, { session: created, lastUsedAt: this.idleCleanup.now() });
      return created;
    }

    if (thread.engine === "codex") {
      // Codex 统一使用 app-server（真流式）：减少分叉与事件遗漏风险。
      const created = new CodexAppServerThreadSession({
        withLegacyDatabase: this.opts.withLegacyDatabase,
        writeWorkspaceLog: this.opts.writeWorkspaceLog,
        manager: this.codexAppServer.forThread(thread.threadId),
        workspacePath,
        workspaceId: thread.workspaceId,
        threadId: thread.threadId,
        initialSessionId: thread.sessionId,
        initialSessionCapabilities: thread.sessionCapabilities,
        onEngineProcessSnapshot: (snapshot) => this.engineProcesses.upsertThreadService(thread.threadId, snapshot),
        onSessionBinding: (sid, capabilities) => {
          this.opts.persistSessionBinding?.(thread.threadId, sid, capabilities, thread.workspaceId);
          this.opts.threads.setSessionBinding(thread.threadId, sid, capabilities);
        },
        onSessionBindingDropped: (expectedSessionId) => {
          if (expectedSessionId) {
            this.clearExpectedCodexSessionBinding(thread.threadId, String(expectedSessionId), thread.workspaceId);
            return;
          }
          this.opts.clearPersistedSessionBinding?.(thread.threadId, undefined, thread.workspaceId);
          this.opts.threads.dropSessionBinding(thread.threadId);
        },
        onStartAttempt: (input) => {
          const persist = this.opts.persistCodexStartAttempt;
          if (!persist) throw new Error("Codex start attempt persistence is not configured");
          persist(input);
        },
        resolveCodexRuntimeConfig: () => this.resolveCodexRuntimeConfigForThread(thread.threadId),
        acquireCredential: input => this.acquireCredentialForThread(thread.threadId, 'codex', input),
        assertMutationAllowed: () => this.opts.assertCodexMutationAllowed?.(thread.threadId),
        getInputActionHmacKey: this.opts.getThreadInputActionHmacKey,
      });
      this.sessions.set(thread.threadId, { session: created, lastUsedAt: this.idleCleanup.now() });
      return created;
    }

    throw new Error(`engine 未支持：${thread.engine}`);
  }

  /**
   * 将冻结证据确认的 Codex capability 恢复到同一 provider binding。
   * expectedSessionId 是 CAS 所有权；不匹配时不写持久层、ThreadStore 或缓存 session。
   */
  restoreCodexSessionCapabilities(
    threadId: ThreadId,
    expectedSessionId: SessionId,
    capabilities: ThreadSessionCapabilities,
  ): boolean {
    const runtimeThread = this.opts.threads.get(threadId);
    if (
      !runtimeThread
      || runtimeThread.engine !== "codex"
      || runtimeThread.sessionId !== expectedSessionId
    ) {
      return false;
    }

    const cachedRecord = this.sessions.has(threadId) ? this.sessions.get(threadId)! : null;
    const cached = cachedRecord?.session ?? null;
    if (cached) {
      if (!(cached instanceof CodexAppServerThreadSession)) return false;
      if (!cached.canRestoreSessionCapabilities(expectedSessionId, capabilities)) return false;
    }
    const previousRuntimeCapabilities = cloneSessionCapabilities(runtimeThread.sessionCapabilities);

    const persistIfMatches = this.opts.persistSessionCapabilitiesIfMatches;
    if (!persistIfMatches) return false;

    try {
      const persisted = persistIfMatches(threadId, expectedSessionId, capabilities, runtimeThread.workspaceId);
      if (persisted.kind !== "restored") return false;

      // 持久化 CAS 期间调用方可能同步触发换代；发布内存前再次核对同一对象和 binding。
      if (
        this.opts.threads.get(threadId) !== runtimeThread
        || runtimeThread.engine !== "codex"
        || runtimeThread.sessionId !== expectedSessionId
        || !sessionCapabilitiesEqual(runtimeThread.sessionCapabilities, previousRuntimeCapabilities)
        || (this.sessions.get(threadId) ?? null) !== cachedRecord
      ) {
        return false;
      }
      this.opts.threads.setSessionBinding(threadId, expectedSessionId, capabilities);
      if (cached && !cached.restoreSessionCapabilities(expectedSessionId, capabilities)) {
        this.rollbackRuntimeSessionCapabilities(
          threadId,
          runtimeThread,
          expectedSessionId,
          previousRuntimeCapabilities,
        );
        return false;
      }
      return true;
    } catch (cause) {
      this.rollbackRuntimeSessionCapabilities(
        threadId,
        runtimeThread,
        expectedSessionId,
        previousRuntimeCapabilities,
      );
      this.log(runtimeThread.workspaceId, "error", "Codex session capability restore failed", () => ({
        code: "codex_session_capability_restore_failed",
        requestId: null,
        threadId,
        providerThreadId: expectedSessionId,
        rootCause: engineDiagnosticCause(cause),
      }), { reason: cause });
      throw cause;
    }
  }

  /**
   * 业务终态持久化后，只解除同一 Codex session 的内存恢复门禁。
   * 不存在缓存 session 时无需解除；binding 不一致时保持原状态。
   */
  releaseCodexRecoveryPending(
    threadId: ThreadId,
    expectedSessionId: SessionId,
  ): boolean {
    const runtimeThread = this.opts.threads.get(threadId);
    if (
      !runtimeThread
      || runtimeThread.engine !== "codex"
      || runtimeThread.sessionId !== expectedSessionId
    ) {
      return false;
    }

    const cached = this.sessions.get(threadId)?.session ?? null;
    if (!cached) return true;
    if (!(cached instanceof CodexAppServerThreadSession)) return false;
    return cached.releaseRecoveryPending(expectedSessionId);
  }

  /** capability 发布失败时只回滚仍由原 runtime/同一 provider binding 持有的内存状态。 */
  private rollbackRuntimeSessionCapabilities(
    threadId: ThreadId,
    expectedRuntime: ThreadRuntime,
    expectedSessionId: SessionId,
    previousCapabilities: ThreadSessionCapabilities | null,
  ): void {
    const current = this.opts.threads.get(threadId);
    if (current !== expectedRuntime || current.sessionId !== expectedSessionId) return;
    if (sessionCapabilitiesEqual(current.sessionCapabilities, previousCapabilities)) return;
    this.opts.threads.setSessionBinding(threadId, expectedSessionId, previousCapabilities);
  }

  /** 构造不写入普通 ThreadStore 的隔离会话，供受控实验等专用运行时使用。 */
  createIsolatedSession(input: {
    sessionKey: string;
    workspaceId: WorkspaceId;
    engine: EngineType;
    initialSessionId?: SessionId | null;
    onSessionId: (sessionId: SessionId) => void;
    onSessionBindingDropped?: () => void;
  }): IsolatedThreadSessionHandle {
    this.assertNotStopping();
    if (input.engine === "codex" && this.codexRestartInFlight) {
      throw new Error("Codex app-server 正在重启，请稍后重试");
    }
    const workspacePath = this.opts.workspaces.get(input.workspaceId);
    if (!workspacePath) throw new Error(`未知 workspaceId：${input.workspaceId}`);
    const isolatedThreadId = input.sessionKey as ThreadId;
    if (this.sessions.has(isolatedThreadId) || this.disposingByThreadId.has(isolatedThreadId)) throw new Error(`隔离会话已存在或正在释放：threadId=${isolatedThreadId}`);
    const session = input.engine === "claude"
      ? new ClaudeThreadSession({
          withLegacyDatabase: this.opts.withLegacyDatabase,
          writeWorkspaceLog: this.opts.writeWorkspaceLog,
          workspacePath,
          workspaceId: input.workspaceId,
          threadId: input.sessionKey,
          initialSessionId: input.initialSessionId ?? null,
          onEngineProcessSnapshot: () => false,
          onSessionId: input.onSessionId,
          readProviderCredentials: this.opts.resolveClaudeCredentials,
          resolveModelProvider: this.opts.resolveClaudeModelProvider,
          hasConfiguredProviderCredentials: this.opts.hasClaudeCredentials,
          acquireCredential: input => this.acquireCredentialForThread(isolatedThreadId, 'claude', input),
        })
      : new CodexAppServerThreadSession({
          withLegacyDatabase: this.opts.withLegacyDatabase,
          writeWorkspaceLog: this.opts.writeWorkspaceLog,
          manager: this.codexAppServer.forThread(isolatedThreadId),
          workspacePath,
          workspaceId: input.workspaceId,
          threadId: input.sessionKey,
          initialSessionId: input.initialSessionId ?? null,
          initialSessionCapabilities: null,
          onEngineProcessSnapshot: () => false,
          onSessionBinding: (sessionId) => input.onSessionId(sessionId),
          onSessionBindingDropped: () => input.onSessionBindingDropped?.(),
          // 隔离会话没有普通 thread_turns 行，不参与会话恢复。
          onStartAttempt() {},
          resolveCodexRuntimeConfig: () => this.resolveCodexRuntimeConfigForThread(isolatedThreadId),
          acquireCredential: input => this.acquireCredentialForThread(isolatedThreadId, 'codex', input),
        });
    const record = { session, lastUsedAt: this.idleCleanup.now() };
    this.sessions.set(isolatedThreadId, record);
    return {
      session,
      dispose: async () => {
        if (this.sessions.get(isolatedThreadId) !== record) return;
        await this.disposeSessionRecord(isolatedThreadId, record, { flushActiveTurn: true, reason: "thread-disposed" });
      },
    };
  }

  /** 已派发回合复用冻结配置；恢复/目录等直接进程入口仍必须通过同一凭据门禁。 */
  private resolveCodexRuntimeConfigForThread(threadId: string) {
    const accepted = this.credentialLeasesByThread.get(threadId);
    if (accepted) return accepted.config;
    if (!this.opts.builtInRelayCredentials) return this.opts.resolveCodexRuntimeConfig?.() ?? null;
    const lease = this.acquireCredentialForThread(threadId, 'codex', {});
    try { lease.assertCurrent(); return lease.config; } finally { lease.release(); }
  }

  /** 原会话记录 owner 与 Key，供账号门禁和目标 Key 释放复用。 */
  private acquireCredentialForThread(threadId: string, engine: EngineType, input: { model?: string | null; turnId?: string }): EngineCredentialLease {
    if (this.disposingByThreadId.has(threadId as ThreadId)) throw Object.assign(new Error(`thread session 正在释放：threadId=${threadId}`), { code: 'CONFLICT', details: { reason: 'thread_disposal_in_progress', threadId } });
    const service = this.opts.builtInRelayCredentials;
    if (!service) return { config: null, owner: null, assertCurrent() {}, release() {} };
    const providerId = engine === 'claude' ? this.opts.resolveClaudeModelProvider?.(input.model) ?? undefined : undefined;
    const lease = service.acquire({ engine, providerId, threadId, turnId: input.turnId });
    const prior = this.credentialOwnersByThread.get(threadId);
    if (prior && (!lease.owner || prior.generation !== lease.owner.generation || prior.accountSessionId !== lease.owner.accountSessionId || prior.ownerUserId !== lease.owner.ownerUserId || prior.serverOrigin !== lease.owner.serverOrigin)) {
      lease.release();
      throw Object.assign(new Error(`旧账号引擎进程尚未释放：threadId=${threadId}`), { code: 'BUILT_IN_RELAY_PROCESS_RELEASE_REQUIRED', threadId });
    }
    if (lease.owner) this.credentialOwnersByThread.set(threadId, { ...lease.owner, keyId: lease.config?.credentialIdentity?.keyId });
    this.credentialLeasesByThread.set(threadId, lease);
    return { ...lease, release: () => { if (this.credentialLeasesByThread.get(threadId) === lease) this.credentialLeasesByThread.delete(threadId); lease.release(); } };
  }

  /** 排空后按 Key 释放原会话；省略 Key 时释放整个 owner，不中断已派发回合。 */
  async releaseInvalidatedBuiltInSessions(owner: DesktopCloudAccountOwner, keyId?: string): Promise<void> {
    for (const [threadId, previous] of [...this.credentialOwnersByThread]) {
      if (previous.serverOrigin !== owner.serverOrigin || previous.ownerUserId !== owner.ownerUserId || previous.accountSessionId !== owner.accountSessionId || previous.generation !== owner.generation) continue;
      if (keyId && previous.keyId !== keyId) continue;
      if (this.credentialLeasesByThread.has(threadId)) throw new Error(`内置凭据回合尚未排空：threadId=${threadId}`);
      const record = this.sessions.get(threadId as ThreadId);
      if (record) await this.disposeSessionRecord(threadId as ThreadId, record, { flushActiveTurn: false, reason: 'thread-disposed' });
      else await this.codexAppServer.releaseThread(threadId as ThreadId);
      this.credentialOwnersByThread.delete(threadId);
    }
  }

  /** 显式自配切换仅释放指定 Key 的 Claude 会话；目标在途或释放失败均阻止切换。 */
  async releaseCompletedBuiltInClaudeSessions(keyIds: ReadonlySet<string>): Promise<void> {
    const targets = [...this.sessions].filter(([threadId, record]) => {
      const keyId = this.credentialOwnersByThread.get(threadId)?.keyId;
      return record.session.engine === 'claude' && keyId !== undefined && keyIds.has(keyId);
    });
    for (const [threadId, record] of targets) {
      if (this.credentialLeasesByThread.has(threadId) || record.session.hasActiveTurn()) {
        throw Object.assign(new Error(`内置 Claude 回合尚未结束：threadId=${threadId}`), { code: 'CONFLICT', details: { reason: 'builtin_claude_turn_in_progress', threadId } });
      }
    }
    const results = await Promise.allSettled(targets.map(([threadId, record]) => this.disposeSessionRecord(threadId, record, { flushActiveTurn: false, reason: 'thread-disposed' })));
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [new Error(`内置 Claude 会话释放失败：threadId=${targets[index]![0]}`, { cause: result.reason })] : []);
    if (failures.length) throw new AggregateError(failures, '内置 Claude 会话未完整释放', { cause: failures[0] });
  }

  /** 中断某 thread 的 turn（若无运行中则忽略）。 */
  async interrupt(threadId: ThreadId, turnId: string, options?: ThreadInterruptOptions): Promise<boolean> {
    const session = this.touchThreadSession(threadId)?.session ?? null;
    if (!session) return false;
    return await session.interrupt(turnId as TurnId, options);
  }

  /** 查询既有 session owner 的阶段，不因只读运行态创建新 session。 */
  getTurnPhase(threadId: ThreadId, turnId: TurnId): "running" | "stopping" | "draining" | "failed" | null {
    return this.sessions.get(threadId)?.session.getTurnPhase?.(turnId) ?? null;
  }

  /** 读取现有 session 的安全保存失败码，不访问新资源或重试写入。 */
  getTurnFailure(threadId: ThreadId, turnId: TurnId): string | null {
    return this.sessions.get(threadId)?.session.getTurnFailure?.(turnId) ?? null;
  }

  /** 旋转不应复用的 Codex generation；重启恢复可复用 session 的 detached 补偿链。 */
  detachCodexProviderGeneration(
    threadId: ThreadId,
    expectedSessionId: SessionId,
    recovery?: CodexDetachedProviderRecoveryInput,
  ): void {
    const expected = String(expectedSessionId ?? "").trim();
    if (!expected) throw new Error(`Codex generation rotation 缺少 expectedSessionId：threadId=${threadId}`);
    const runtimeSessionId = String(this.opts.threads.get(threadId)?.sessionId ?? "").trim();
    if (runtimeSessionId && runtimeSessionId !== expected) {
      throw new Error(
        `Codex generation rotation 拒绝清除新 runtime 绑定：threadId=${threadId}, expected=${expected}, actual=${runtimeSessionId}`,
      );
    }
    let record = this.sessions.get(threadId) ?? null;
    if (!record && recovery) {
      const runtimeThread = this.opts.threads.get(threadId) ?? null;
      if (!runtimeThread) {
        throw new Error(`Codex generation rotation 缺少 runtime thread：threadId=${threadId}`);
      }
      if (runtimeThread.engine !== "codex") {
        throw new Error(`generation rotation 仅支持 Codex runtime：threadId=${threadId}, engine=${runtimeThread.engine}`);
      }
      if (runtimeSessionId !== expected) {
        throw new Error(
          `Codex generation rotation 无法恢复旧 binding：threadId=${threadId}, expected=${expected}, actual=${runtimeSessionId || "missing"}`,
        );
      }
      const session = this.getOrCreate(runtimeThread);
      record = this.sessions.get(threadId) ?? { session, lastUsedAt: this.idleCleanup.now() };
    }
    if (record) {
      if (!(record.session instanceof CodexAppServerThreadSession)) {
        throw new Error(`generation rotation 仅支持 Codex session：threadId=${threadId}, engine=${record.session.engine}`);
      }
      record.session.retryPendingSessionBindingDrop();
      record.session.detachProviderGeneration(expectedSessionId, recovery);
      return;
    }
    this.clearExpectedCodexSessionBinding(threadId, expected);
  }

  /** 幂等清理指定旧 generation；runtime 已换代时拒绝触碰新 binding。 */
  private clearExpectedCodexSessionBinding(threadId: ThreadId, expectedSessionId: string,
    workspaceId = this.opts.threads.get(threadId)?.workspaceId): void {
    const runtimeSessionId = String(this.opts.threads.get(threadId)?.sessionId ?? "").trim();
    if (runtimeSessionId && runtimeSessionId !== expectedSessionId) {
      const error = Object.assign(new Error(
        `Codex generation rotation 拒绝清除新 runtime 绑定：threadId=${threadId}, expected=${expectedSessionId}, actual=${runtimeSessionId}`,
      ), { code: "codex_session_binding_runtime_mismatch" });
      this.logExpectedCodexSessionBindingClearFailure(threadId, expectedSessionId, runtimeSessionId, "runtime_mismatch", error, undefined, workspaceId);
      throw error;
    }
    let result: PersistedSessionBindingClearResult | void;
    try {
      result = this.opts.clearPersistedSessionBinding?.(threadId, expectedSessionId as SessionId, workspaceId);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.logExpectedCodexSessionBindingClearFailure(threadId, expectedSessionId, runtimeSessionId, "persisted_clear_failed", error, undefined, workspaceId);
      throw error;
    }
    if (this.opts.clearPersistedSessionBinding && !result) {
      const error = Object.assign(new Error(
        `Codex generation rotation 缺少 persisted binding CAS 结果：threadId=${threadId}, expected=${expectedSessionId}`,
      ), { code: "codex_session_binding_clear_result_missing" });
      this.logExpectedCodexSessionBindingClearFailure(threadId, expectedSessionId, runtimeSessionId, "persisted_result_missing", error, undefined, workspaceId);
      throw error;
    }
    if (result?.kind === "session_mismatch") {
      const error = Object.assign(new Error(
        `Codex generation rotation 拒绝清除新 persisted 绑定：threadId=${threadId}, expected=${expectedSessionId}, actual=${result.actualSessionId}`,
      ), { code: "codex_session_binding_persisted_mismatch" });
      this.logExpectedCodexSessionBindingClearFailure(threadId, expectedSessionId, runtimeSessionId, "persisted_mismatch", error, result.actualSessionId, workspaceId);
      throw error;
    }
    if (result?.kind === "thread_missing") {
      const error = Object.assign(new Error(`Codex generation rotation 缺少 persisted thread：threadId=${threadId}`), {
        code: "codex_session_binding_persisted_thread_missing",
      });
      this.logExpectedCodexSessionBindingClearFailure(threadId, expectedSessionId, runtimeSessionId, "persisted_thread_missing", error, undefined, workspaceId);
      throw error;
    }
    if (runtimeSessionId === expectedSessionId) this.opts.threads.dropSessionBinding(threadId);
  }

  /** 在 generation 清理的处理边界记录一次可检索失败上下文。 */
  private logExpectedCodexSessionBindingClearFailure(
    threadId: ThreadId,
    expectedSessionId: string,
    runtimeSessionId: string,
    reason: string,
    error: Error,
    actualPersistedSessionId?: SessionId,
    workspaceId?: WorkspaceId,
  ): void {
    if (!workspaceId) throw new AggregateError([error, new Error(`Missing workspace scope: threadId=${threadId}`)], "Codex binding 清理失败且缺少工作区身份", { cause: error });
    this.log(workspaceId, "error", "Codex expected session binding clear failed", () => ({
      code: String(engineDiagnosticField(error, "code") ?? "codex_session_binding_clear_failed"),
      requestId: null,
      threadId,
      expectedSessionId,
      runtimeSessionId: runtimeSessionId || null,
      actualPersistedSessionId: actualPersistedSessionId ?? null,
      reason,
      rootCause: engineDiagnosticCause(error),
    }), { reason: error });
  }

  hasActiveTurn(threadId: ThreadId): boolean {
    const session = this.sessions.get(threadId)?.session ?? null;
    return Boolean(session?.hasActiveTurn());
  }

  /** 校验删除门禁和预期 runtime 身份，拒绝已删除会话的迟到操作。 */
  assertThreadAvailable(threadId: ThreadId, expectedRuntime?: ThreadRuntime | null): void {
    if (this.deletingThreadIds.has(threadId)) {
      throw Object.assign(new Error(`会话正在删除，暂不能启动新操作：threadId=${threadId}`), {
        code: THREAD_DELETION_IN_PROGRESS_CODE,
        threadId,
      });
    }
    if (!expectedRuntime) return;
    const readCurrent = (this.opts.threads as ThreadStore & { get?: (id: ThreadId) => ThreadRuntime | null }).get;
    if (typeof readCurrent !== "function" || readCurrent.call(this.opts.threads, threadId) === expectedRuntime) return;
    throw Object.assign(new Error(`会话运行态已失效，暂不能启动新操作：threadId=${threadId}`), {
      code: THREAD_RUNTIME_STALE_CODE,
      threadId,
    });
  }

  /** 跟踪一个会话写操作；删除已开始时拒绝，返回函数用于释放计数。 */
  beginThreadOperation(threadId: ThreadId): () => void {
    this.assertThreadAvailable(threadId);
    this.activeOperationCountByThreadId.set(threadId, (this.activeOperationCountByThreadId.get(threadId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.activeOperationCountByThreadId.get(threadId) ?? 1) - 1;
      if (next > 0) this.activeOperationCountByThreadId.set(threadId, next);
      else this.activeOperationCountByThreadId.delete(threadId);
    };
  }

  /** 锁住一组待删会话，直到资源释放、事务提交和内存清理全部结束。 */
  beginThreadDeletion(threadIds: ReadonlyArray<ThreadId>): () => void {
    const ids = [...new Set(threadIds)].sort((left, right) => String(left).localeCompare(String(right)));
    const conflict = ids.find((threadId) => this.deletingThreadIds.has(threadId)) ?? null;
    if (conflict) this.assertThreadAvailable(conflict);
    const activeOperation = ids.find((threadId) => (this.activeOperationCountByThreadId.get(threadId) ?? 0) > 0) ?? null;
    if (activeOperation) {
      throw Object.assign(new Error(`会话仍有写操作正在处理，暂不能删除：threadId=${activeOperation}`), {
        code: THREAD_OPERATION_IN_PROGRESS_CODE,
        threadId: activeOperation,
      });
    }
    for (const threadId of ids) this.deletingThreadIds.add(threadId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const threadId of ids) this.deletingThreadIds.delete(threadId);
    };
  }

  /** 只读汇总运行中的回合，供退出确认与运行态展示使用。 */
  listActiveTurns(): Array<{ threadId: ThreadId; turnId: TurnId | null; engine: EngineType }> {
    const turns: Array<{ threadId: ThreadId; turnId: TurnId | null; engine: EngineType }> = [];
    for (const [threadId, record] of this.sessions) {
      if (!record.session.hasActiveTurn()) continue;
      turns.push({ threadId, turnId: record.session.getActiveTurnId?.() ?? null, engine: record.session.engine });
    }
    return turns;
  }

  /** 返回当前 session active turnId；用于把阻断发送的运行态暴露给 UI 停止按钮。 */
  getActiveTurnId(threadId: ThreadId): TurnId | null {
    const session = this.sessions.get(threadId)?.session ?? null;
    if (!session?.hasActiveTurn()) return null;
    return session.getActiveTurnId?.() ?? null;
  }

  /** 分开判断回合存活与输入通道可写，避免收口期间继续追加。 */
  canAppendInput(threadId: ThreadId): boolean {
    const session = this.sessions.get(threadId)?.session ?? null;
    return Boolean(session?.hasActiveTurn() && (session.canAppendInput?.() ?? true));
  }

  /** 向当前 active turn 追加输入；仅命中真实运行中的 session 时执行。 */
  async appendInput(threadId: ThreadId, input: AppendTurnInput): Promise<AppendTurnResult | null> {
    const session = this.sessions.get(threadId)?.session ?? null;
    if (!session?.hasActiveTurn()) return null;
    this.touchThreadSession(threadId);
    if (!session.appendInput) throw new Error(`engine ${session.engine} 不支持 active turn 追加输入`);
    return await session.appendInput(input);
  }

  getWorkspacePath(workspaceId: WorkspaceId): string | null {
    return this.opts.workspaces.get(workspaceId) ?? null;
  }

  listEngineManagedServices(threadId: ThreadId): ManagedServiceSnapshot[] {
    return this.engineProcesses.listThreadServices(threadId);
  }

  async stopEngineManagedService(threadId: ThreadId, serviceId: string): Promise<boolean> {
    const session = this.touchThreadSession(threadId)?.session ?? null;
    if (!session?.stopManagedService) return false;
    return await session.stopManagedService(serviceId);
  }

  /** 恢复 provider thread 后只处理中断请求携带的精确映射，禁止改停最新 Goal turn。 */
  async interruptCodexTurnByEngineIds(input: {
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    workspacePath: string;
    turnId: TurnId;
    engineSessionId: SessionId;
    engineTurnId?: string | null;
    exactProviderTurn?: boolean;
    clientUserMessageIds?: readonly string[];
    clientUserMessageId?: string | null;
  }): Promise<CodexRecoveredInterruptResult> {
    this.assertCodexProcessCreationAllowed();
    const expectedEngineTurnId = String(input.engineTurnId ?? "").trim() || null;
    const threadManager = this.codexAppServer.forThread(input.threadId);
    const ws = threadManager.getOrCreate(input.workspaceId, input.workspacePath);
    if (input.exactProviderTurn) {
      if (!expectedEngineTurnId) {
        return buildCodexRecoveryPendingResult(
          "精确 Codex provider turn 缺少 turnId，未发送中断请求",
          "codex_turn_correlation_scan_incomplete",
        );
      }
      let interruptError: unknown = null;
      try {
        await ws.request(
          "turn/interrupt",
          { threadId: input.engineSessionId, turnId: expectedEngineTurnId },
          CODEX_RECOVERY_REQUEST_OPTIONS,
        );
      } catch (firstError) {
        if (isEngineWorkspaceLogFailure(firstError)) throw firstError;
        interruptError = firstError;
        if (isCodexThreadUnavailableSignal(firstError)) {
          let resumeError: unknown = null;
          try {
            await ws.request("thread/resume", { threadId: input.engineSessionId }, CODEX_RECOVERY_REQUEST_OPTIONS);
          } catch (error) {
            resumeError = error;
          }
          try {
            await ws.request(
              "turn/interrupt",
              { threadId: input.engineSessionId, turnId: expectedEngineTurnId },
              CODEX_RECOVERY_REQUEST_OPTIONS,
            );
            interruptError = null;
            if (resumeError) {
              this.log(input.workspaceId, "warn", "exact Codex interrupt acknowledged after resume failed", () => ({
                code: "codex_exact_interrupt_acknowledged_after_resume_failed",
                requestId: String(engineDiagnosticField(resumeError, "requestId") ?? "").trim() || null,
                threadId: input.threadId,
                workspaceId: input.workspaceId,
                providerThreadId: input.engineSessionId,
                providerTurnId: expectedEngineTurnId,
                rootCause: engineDiagnosticCause(resumeError),
              }), { reason: resumeError });
            }
          } catch (retryError) {
            if (isEngineWorkspaceLogFailure(retryError)) throw retryError;
            interruptError = combineCodexResumeAndInterruptFailures(resumeError, retryError);
          }
        }
      }
      if (interruptError) {
        const readAttempt = isCodexNoActiveTurnError(interruptError)
          ? await readCodexThreadWithResumeFallback(ws, input.engineSessionId, { includeTurns: true, turnId: expectedEngineTurnId })
          : await readCodexThreadById(ws, input.engineSessionId, { turnId: expectedEngineTurnId });
        if (readAttempt.kind === "read") {
          const outcome = extractCodexThreadReadRecoveryOutcome(readAttempt.value, {
            engineSessionId: input.engineSessionId,
            engineTurnId: expectedEngineTurnId,
            reason: "interrupt-recovery.no-active-turn",
            allowSiblingRunning: true,
          });
          if (outcome.kind !== "pending") {
            this.settleLiveCodexSessionAfterTerminalRead({
              threadId: input.threadId,
              clientTurnId: input.turnId,
              providerThreadId: input.engineSessionId,
              providerTurnId: expectedEngineTurnId,
            }, outcome, readAttempt.value);
            return {
              kind: "terminal",
              actualEngineTurnId: expectedEngineTurnId,
              allowSiblingRunning: true,
              reconciled: mapCodexRecoveryOutcome(outcome, {
                workspaceId: input.workspaceId,
                threadId: input.threadId,
                turnId: input.turnId,
              }),
            };
          }
        }
        if (
          isCodexAppServerRestartableFailure(interruptError)
          || (readAttempt.kind === "failed" && isCodexAppServerRestartableFailure(readAttempt.error ?? readAttempt.message))
        ) {
          const restarted = await this.tryRestartAndInterruptExactCodexTurn({
            threadManager,
            workspaceId: input.workspaceId,
            workspacePath: input.workspacePath,
            threadId: input.threadId,
            clientTurnId: input.turnId,
            providerThreadId: input.engineSessionId,
            providerTurnId: expectedEngineTurnId,
          });
          if (restarted?.kind === "ready") {
            const liveSession = this.sessions.get(input.threadId)?.session ?? null;
            if (liveSession instanceof CodexAppServerThreadSession) {
              liveSession.acknowledgeExactProviderTurnInterrupt({
                clientTurnId: input.turnId,
                providerThreadId: input.engineSessionId,
                providerTurnId: expectedEngineTurnId,
              });
            }
            return {
              kind: "ready",
              actualEngineTurnId: expectedEngineTurnId,
              allowSiblingRunning: true,
            };
          }
          if (restarted?.kind === "terminal") {
            return {
              kind: "terminal",
              actualEngineTurnId: expectedEngineTurnId,
              allowSiblingRunning: true,
              reconciled: restarted.reconciled,
            };
          }
          if (restarted?.kind === "failed") {
            interruptError = combineCodexResumeAndInterruptFailures(interruptError, restarted.error);
          }
        }
        const confirmation = readAttempt.kind === "failed"
          ? `；终态确认失败：${readAttempt.message}`
          : "；同 ID thread/read 未返回目标终态";
        const noActiveMessage = interruptError instanceof Error ? interruptError.message : String(interruptError);
        const interruptMessage = isCodexNoActiveTurnSignal(interruptError)
          ? `Codex provider 返回 no active turn：${noActiveMessage}`
          : `Codex provider 拒绝或未确认停止请求：${noActiveMessage}`;
        return buildCodexRecoveryPendingResult(
          `${interruptMessage}；目标回合终态仍未确认${confirmation}`,
          "interrupt_failed",
        );
      }
      const liveSession = this.sessions.get(input.threadId)?.session ?? null;
      if (liveSession instanceof CodexAppServerThreadSession) {
        liveSession.acknowledgeExactProviderTurnInterrupt({
          clientTurnId: input.turnId,
          providerThreadId: input.engineSessionId,
          providerTurnId: expectedEngineTurnId,
        });
      }
      return {
        kind: "ready",
        actualEngineTurnId: expectedEngineTurnId,
        allowSiblingRunning: true,
      };
    }
    const clientUserMessageIds = normalizeCodexClientUserMessageIds(input);
    if (clientUserMessageIds.length === 0) {
      return buildCodexRecoveryPendingResult(
        `持久化 provider turnId=${expectedEngineTurnId ?? "missing"} 缺少 clientUserMessageId 候选，无法证明本地 ownership`,
        "codex_turn_correlation_scan_incomplete",
      );
    }
    const maxSnapshotAttempts = 3;
    let snapshot: Extract<ReturnType<typeof inspectCodexRunningTurns>, { kind: "valid" }> | null = null;
    let selectedTurnId: string | null = null;
    let ambiguousMessage = "Codex thread 尚未返回可中断的精确 active turn";
    let ownershipLostMessage: string | null = null;
    let correlationScanIncompleteMessage: string | null = null;
    let recoveredOwnedTurnId: string | null = null;
    for (let attempt = 0; attempt < maxSnapshotAttempts; attempt += 1) {
      const readAttempt = await readCodexThreadWithResumeFallback(ws, input.engineSessionId);
      if (readAttempt.kind === "failed") {
        return buildCodexRecoveryPendingResult(readAttempt.message, "interrupt_recovery_failed");
      }

      const inspected = inspectCodexRunningTurns(
        readAttempt.value,
        input.engineSessionId,
        expectedEngineTurnId,
        clientUserMessageIds,
      );
      if (inspected.kind === "invalid") {
        return buildCodexRecoveryPendingResult(inspected.message, "interrupt_state_ambiguous");
      }
      const ownership = selectLatestCodexClientUserMessageOwnership(inspected, clientUserMessageIds);
      if (ownership.kind === "ambiguous") {
        return buildCodexRecoveryPendingResult(
          `clientUserMessageId=${ownership.clientUserMessageId} 命中多个 provider turn：${ownership.providerTurnIds.join(",")}`,
          "codex_turn_ownership_ambiguous",
        );
      }
      if (ownership.kind === "incomplete") {
        correlationScanIncompleteMessage = buildCodexTurnCorrelationScanIncompleteMessage(
          clientUserMessageIds,
          inspected.runningTurnIds,
        );
        ownershipLostMessage = null;
        if (attempt < maxSnapshotAttempts - 1) await delay(100 * (attempt + 1));
        continue;
      }
      const ownedTurnId = ownership.kind === "selected" ? ownership.providerTurnId : null;
      if (ownedTurnId && recoveredOwnedTurnId && recoveredOwnedTurnId !== ownedTurnId) {
        return buildCodexRecoveryPendingResult(
          `clientUserMessageIds=${clientUserMessageIds.join(",")} 在中断对账中先后命中不同 provider turn：${recoveredOwnedTurnId},${ownedTurnId}`,
          "codex_turn_ownership_ambiguous",
        );
      }
      if (ownedTurnId) recoveredOwnedTurnId = ownedTurnId;
      const ownedTurnStatus = ownedTurnId ? inspected.turnStatusById.get(ownedTurnId) ?? "" : "";
      if (ownedTurnId) {
        ownershipLostMessage = null;
        correlationScanIncompleteMessage = null;
      }
      if (ownedTurnId && isTerminalCodexTurnStatus(ownedTurnStatus)) {
        const outcome = extractCodexThreadReadRecoveryOutcome(readAttempt.value, {
          engineSessionId: input.engineSessionId,
          engineTurnId: ownedTurnId,
          reason: "interrupt-recovery.pre-interrupt-terminal",
          allowSiblingRunning: true,
        });
        if (outcome.kind === "pending") {
          return buildCodexRecoveryPendingResult(
            `Codex provider turn=${ownedTurnId} 的终态快照不完整`,
            "interrupt_state_ambiguous",
          );
        }
        const reconciled = mapCodexRecoveryOutcome(outcome, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId: input.turnId,
        });
        this.settleLiveCodexSessionAfterTerminalRead({
          threadId: input.threadId,
          clientTurnId: input.turnId,
          providerThreadId: input.engineSessionId,
          providerTurnId: ownedTurnId,
        }, outcome, readAttempt.value);
        return {
          kind: "terminal",
          actualEngineTurnId: ownedTurnId,
          allowSiblingRunning: true,
          reconciled,
        };
      }
      if (inspected.runningTurnIds.length === 0) {
        if (!ownedTurnId) {
          if (isNonTerminalCodexThreadStatus(inspected.threadStatus)) {
            ambiguousMessage = `Codex thread 状态与 turn 列表矛盾：threadStatus=${inspected.threadStatus || "missing"}, runningTurnIds=none`;
            ownershipLostMessage = null;
            correlationScanIncompleteMessage = null;
          } else if (isTerminalCodexThreadStatus(inspected.threadStatus) && inspected.turnListComplete) {
            ownershipLostMessage = `clientUserMessageIds=${clientUserMessageIds.join(",")} 均未在 provider thread 完整历史中物化`;
            correlationScanIncompleteMessage = null;
          } else if (inspected.turnListComplete) {
            ambiguousMessage = `Codex thread 状态不足以证明 ownership 已丢失：threadStatus=${inspected.threadStatus || "missing"}, runningTurnIds=none`;
            ownershipLostMessage = null;
            correlationScanIncompleteMessage = null;
          } else {
            correlationScanIncompleteMessage = buildCodexTurnCorrelationScanIncompleteMessage(
              clientUserMessageIds,
              inspected.runningTurnIds,
            );
            ownershipLostMessage = null;
          }
        } else if (!isTerminalCodexThreadStatus(inspected.threadStatus)) {
          ambiguousMessage = `Codex thread 状态与 running turn 不一致：threadStatus=${inspected.threadStatus || "missing"}`;
        }
      } else {
        if (ownedTurnId && isRunningCodexTurnStatus(ownedTurnStatus) && isNonTerminalCodexThreadStatus(inspected.threadStatus)) {
          snapshot = inspected;
          selectedTurnId = ownedTurnId;
          break;
        }
        if (!ownedTurnId) {
          if (inspected.turnListComplete) {
            ownershipLostMessage = `clientUserMessageIds=${clientUserMessageIds.join(",")} 均未在 provider thread 完整历史中物化；当前 foreign running turn=${inspected.runningTurnIds.join(",")}`;
            correlationScanIncompleteMessage = null;
          } else {
            correlationScanIncompleteMessage = buildCodexTurnCorrelationScanIncompleteMessage(
              clientUserMessageIds,
              inspected.runningTurnIds,
            );
            ownershipLostMessage = null;
          }
        }
        ambiguousMessage = `Codex thread 未返回可证明的 active turn：threadStatus=${inspected.threadStatus || "missing"}, expectedTurnStatus=${inspected.expectedTurnStatus || "missing"}, expectedTurnMatchCount=${inspected.expectedTurnMatchCount}, latestTurnId=${inspected.latestTurnId || "missing"}, latestTurnStatus=${inspected.latestTurnStatus || "missing"}, runningTurnIds=${inspected.runningTurnIds.join(",") || "none"}`;
      }
      if (attempt < maxSnapshotAttempts - 1) await delay(100 * (attempt + 1));
    }
    if (!snapshot || !selectedTurnId) {
      if (correlationScanIncompleteMessage) {
        return buildCodexRecoveryPendingResult(
          correlationScanIncompleteMessage,
          "codex_turn_correlation_scan_incomplete",
        );
      }
      if (ownershipLostMessage) {
        return buildCodexRecoveryPendingResult(
          ownershipLostMessage,
          "codex_thread_resume_unconfirmed",
        );
      }
      return buildCodexRecoveryPendingResult(ambiguousMessage, "interrupt_state_ambiguous");
    }

    const actualEngineTurnId = selectedTurnId;
    // restart fallback 的快照后可能立刻出现 Goal successor；终态只按精确 owned turn 裁决并旋转旧 generation。
    const allowSiblingRunning = true as const;
    if (snapshot.runningTurnIds.length > 1 || actualEngineTurnId !== expectedEngineTurnId) {
      this.log(input.workspaceId, "info", "recovered interrupt selected exact provider turn among multiple running turns", () => ({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engineSessionId: input.engineSessionId,
        engineTurnId: actualEngineTurnId,
        runningTurnIds: snapshot.runningTurnIds,
      }));
    }
    try {
      await ws.request(
        "turn/interrupt",
        { threadId: input.engineSessionId, turnId: actualEngineTurnId },
        CODEX_RECOVERY_REQUEST_OPTIONS,
      );
    } catch (error) {
      const afterInterrupt = await readCodexThreadWithResumeFallback(ws, input.engineSessionId);
      if (afterInterrupt.kind === "read") {
        const outcome = extractCodexThreadReadRecoveryOutcome(afterInterrupt.value, {
          engineSessionId: input.engineSessionId,
          engineTurnId: actualEngineTurnId,
          reason: "interrupt-recovery",
          allowSiblingRunning,
        });
        if (outcome.kind !== "pending") {
          const reconciled = mapCodexRecoveryOutcome(outcome, {
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            turnId: input.turnId,
          });
          this.settleLiveCodexSessionAfterTerminalRead({
            threadId: input.threadId,
            clientTurnId: input.turnId,
            providerThreadId: input.engineSessionId,
            providerTurnId: actualEngineTurnId,
          }, outcome, afterInterrupt.value);
          return {
            kind: "terminal",
            actualEngineTurnId,
            allowSiblingRunning,
            reconciled,
          };
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      const confirmationMessage = afterInterrupt.kind === "failed"
        ? `；终态确认失败：${afterInterrupt.message}`
        : "";
      return buildCodexRecoveryPendingResult(
        `Codex 实际 active turn 中断结果仍未确认：${message}${confirmationMessage}`,
        "interrupt_failed",
      );
    }
    return {
      kind: "ready",
      actualEngineTurnId,
      allowSiblingRunning,
    };
  }

  /** provider read 已确认终态时同步收口仍缓存的同一 live session。 */
  private settleLiveCodexSessionAfterTerminalRead(
    input: {
      threadId: ThreadId;
      clientTurnId: TurnId;
      providerThreadId: SessionId;
      providerTurnId: string;
    },
    outcome: Exclude<CodexTurnRecoveryOutcome, { kind: "pending" }>,
    providerThreadRead: unknown,
  ): void {
    const providerTerminalStatus = getCodexRecoveryTerminalStatus(outcome);
    if (!providerTerminalStatus) return;
    const liveSession = this.sessions.get(input.threadId)?.session ?? null;
    if (!(liveSession instanceof CodexAppServerThreadSession)) return;
    liveSession.acknowledgeExactProviderTurnInterrupt({
      clientTurnId: input.clientTurnId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      providerTerminalStatus,
      providerThreadRead,
    });
  }

  /** 仅在精确中断确认进程失效后重启目标 thread，并重试一次同一 provider pair。 */
  private async tryRestartAndInterruptExactCodexTurn(input: {
    threadManager: CodexAppServerThreadManager;
    workspaceId: WorkspaceId;
    workspacePath: string;
    threadId: ThreadId;
    clientTurnId: TurnId;
    providerThreadId: SessionId;
    providerTurnId: string;
  }): Promise<
    | { kind: "ready" }
    | { kind: "terminal"; reconciled: CodexTerminalReconcileResult }
    | { kind: "failed"; error: unknown }
    | null
  > {
    if (!input.threadManager.restart) return null;
    let ws: CodexRecoveryWorkspace;
    try {
      ws = await input.threadManager.restart(input.workspaceId, input.workspacePath);
      this.log(input.workspaceId, "warn", "restarting target Codex app-server after exact interrupt process failure", () => ({
        code: "codex_exact_interrupt_target_restart",
        requestId: null,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
      }));
    } catch (error) {
      if (isEngineWorkspaceLogFailure(error)) throw error;
      this.log(input.workspaceId, "error", "target Codex app-server restart failed during exact interrupt recovery", () => ({
        code: "codex_exact_interrupt_target_restart_failed",
        requestId: null,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        rootCause: engineDiagnosticCause(error),
      }), { reason: error });
      return { kind: "failed", error };
    }

    let interruptError: unknown = null;
    try {
      await ws.request(
        "turn/interrupt",
        { threadId: input.providerThreadId, turnId: input.providerTurnId },
        CODEX_RECOVERY_REQUEST_OPTIONS,
      );
      return { kind: "ready" };
    } catch (firstError) {
      if (isEngineWorkspaceLogFailure(firstError)) throw firstError;
      interruptError = firstError;
    }

    if (isCodexThreadUnavailableSignal(interruptError)) {
      let resumeError: unknown = null;
      try {
        await ws.request("thread/resume", { threadId: input.providerThreadId }, CODEX_RECOVERY_REQUEST_OPTIONS);
      } catch (error) {
        resumeError = error;
      }
      try {
        await ws.request(
          "turn/interrupt",
          { threadId: input.providerThreadId, turnId: input.providerTurnId },
          CODEX_RECOVERY_REQUEST_OPTIONS,
        );
        if (resumeError) {
          this.log(input.workspaceId, "warn", "target Codex interrupt acknowledged after target resume failed", () => ({
            code: "codex_target_interrupt_acknowledged_after_resume_failed",
            requestId: String(engineDiagnosticField(resumeError, "requestId") ?? "").trim() || null,
            workspaceId: input.workspaceId,
            threadId: input.threadId,
            providerThreadId: input.providerThreadId,
            providerTurnId: input.providerTurnId,
            rootCause: engineDiagnosticCause(resumeError),
          }), { reason: resumeError });
        }
        return { kind: "ready" };
      } catch (retryError) {
        if (isEngineWorkspaceLogFailure(retryError)) throw retryError;
        interruptError = combineCodexResumeAndInterruptFailures(resumeError, retryError);
      }
    }

    const readAttempt = await readCodexThreadById(ws, input.providerThreadId, { turnId: input.providerTurnId });
    if (readAttempt.kind === "read") {
      const outcome = extractCodexThreadReadRecoveryOutcome(readAttempt.value, {
        engineSessionId: input.providerThreadId,
        engineTurnId: input.providerTurnId,
        reason: "interrupt-recovery.target-restart",
        allowSiblingRunning: true,
      });
      if (outcome.kind !== "pending") {
        this.settleLiveCodexSessionAfterTerminalRead({
          threadId: input.threadId,
          clientTurnId: input.clientTurnId,
          providerThreadId: input.providerThreadId,
          providerTurnId: input.providerTurnId,
        }, outcome, readAttempt.value);
        return { kind: "terminal", reconciled: mapCodexRecoveryOutcome(outcome, {
          workspaceId: input.workspaceId,
          threadId: input.threadId,
          turnId: input.clientTurnId,
        }) };
      }
    }
    const detail = readAttempt.kind === "failed"
      ? `${interruptError instanceof Error ? interruptError.message : String(interruptError)}；thread/read 失败：${readAttempt.message}`
      : `${interruptError instanceof Error ? interruptError.message : String(interruptError)}；thread/read 未确认目标终态`;
    return {
      kind: "failed",
      error: new Error(detail),
    };
  }

  /** 重启后读取 provider 终态；无法确认时返回 pending，禁止伪造本地 terminal。 */
  async reconcileCodexDanglingTurn(input: {
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    workspacePath: string;
    turnId: TurnId;
    engineSessionId: SessionId;
    engineTurnId?: string | null;
    exactProviderTurn?: boolean;
    clientUserMessageIds?: readonly string[];
    clientUserMessageId?: string | null;
    allowSiblingRunning?: boolean;
  }): Promise<CodexDanglingTurnReconcileResult> {
    this.assertCodexProcessCreationAllowed();
    const threadManager = this.codexAppServer.forThread(input.threadId);
    let ws = threadManager.getOrCreate(input.workspaceId, input.workspacePath);
    // 精确 provider pair 已有唯一身份；失败后重复 resume/read 只会把同一进程的 RPC 队列继续推高。
    // 非精确 ownership 扫描仍保留短重试，以等待 provider 历史物化。
    let maxAttempts = input.exactProviderTurn ? 1 : 3;
    let targetRestarted = false;
    const expectedEngineTurnId = String(input.engineTurnId ?? "").trim() || null;
    const clientUserMessageIds = normalizeCodexClientUserMessageIds(input);
    let recoveredEngineTurnId: string | null = null;
    if (input.exactProviderTurn && !expectedEngineTurnId) {
      return buildCodexRecoveryPendingResult(
        "精确 Codex provider turn 缺少 turnId，无法读取终态",
        "codex_turn_correlation_scan_incomplete",
      );
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const readAttempt = input.exactProviderTurn
        ? await readCodexThreadDirectFirst(ws, input.engineSessionId, expectedEngineTurnId!)
        : await readCodexThreadWithResumeFallback(
            ws,
            input.engineSessionId,
            { includeTurns: false },
          );
      if (readAttempt.kind === "failed") {
        if (
          input.exactProviderTurn
          && !targetRestarted
          && isCodexAppServerRestartableFailure(readAttempt.error ?? readAttempt.message)
          && threadManager.restart
        ) {
          try {
            ws = await threadManager.restart(input.workspaceId, input.workspacePath);
            targetRestarted = true;
            maxAttempts += 1;
            this.log(input.workspaceId, "warn", "restarting target Codex app-server after startup reconcile process failure", () => ({
              code: "codex_startup_reconcile_target_restart",
              requestId: null,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              providerThreadId: input.engineSessionId,
              providerTurnId: expectedEngineTurnId,
              rootCause: readAttempt.message,
            }));
            continue;
          } catch (error) {
            if (isEngineWorkspaceLogFailure(error)) throw error;
            this.log(input.workspaceId, "error", "target Codex app-server restart failed during startup reconcile", () => ({
              code: "codex_startup_reconcile_target_restart_failed",
              requestId: null,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              providerThreadId: input.engineSessionId,
              providerTurnId: expectedEngineTurnId,
              rootCause: engineDiagnosticCause(error),
            }), { reason: error });
            return {
              kind: "pending",
              message: `Codex 恢复对账无法重启目标 app-server：${error instanceof Error ? error.message : String(error)}`,
              code: "reconcile_failed",
              dropSessionBinding: false,
            };
          }
        }
        if (attempt < maxAttempts - 1 && readAttempt.retryable !== false) {
          await delay(250 * (attempt + 1));
          continue;
        }
        return {
          kind: "pending",
          message: `Codex 恢复对账暂未确认回合终态：${readAttempt.message}`,
          code: "reconcile_failed",
          dropSessionBinding: false,
          ...(recoveredEngineTurnId ? { actualEngineTurnId: recoveredEngineTurnId } : {}),
        };
      }

      let actualEngineTurnId = expectedEngineTurnId;
      let allowSiblingRunning = input.exactProviderTurn === true ? true : input.allowSiblingRunning;
      if (!input.exactProviderTurn && clientUserMessageIds.length > 0) {
        const inspected = inspectCodexRunningTurns(
          readAttempt.value,
          input.engineSessionId,
          expectedEngineTurnId,
          clientUserMessageIds,
        );
        if (inspected.kind === "invalid") {
          if (attempt < maxAttempts - 1) {
            await delay(250 * (attempt + 1));
            continue;
          }
          return buildCodexRecoveryPendingResult(
            `Codex 恢复对账无法验证 ownership：${inspected.message}`,
            "codex_turn_ownership_state_invalid",
          );
        }
        const ownership = selectLatestCodexClientUserMessageOwnership(inspected, clientUserMessageIds);
        if (ownership.kind === "ambiguous") {
          return buildCodexRecoveryPendingResult(
            `clientUserMessageId=${ownership.clientUserMessageId} 命中多个 provider turn：${ownership.providerTurnIds.join(",")}`,
            "codex_turn_ownership_ambiguous",
          );
        }
        const correlatedTurnId = ownership.kind === "selected" ? ownership.providerTurnId : null;
        if (!correlatedTurnId) {
          const scanIncomplete = ownership.kind === "incomplete";
          const message = scanIncomplete
            ? buildCodexTurnCorrelationScanIncompleteMessage(clientUserMessageIds, inspected.runningTurnIds)
            : `clientUserMessageIds=${clientUserMessageIds.join(",")} 均未在 provider thread 完整历史中物化`;
          if (attempt < maxAttempts - 1) {
            await delay(250 * (attempt + 1));
            continue;
          }
          return buildCodexRecoveryPendingResult(
            message,
            scanIncomplete ? "codex_turn_correlation_scan_incomplete" : "codex_thread_resume_unconfirmed",
          );
        }
        if (recoveredEngineTurnId && recoveredEngineTurnId !== correlatedTurnId) {
          return buildCodexRecoveryPendingResult(
            `clientUserMessageIds=${clientUserMessageIds.join(",")} 在重启对账中先后命中不同 provider turn：${recoveredEngineTurnId},${correlatedTurnId}`,
            "codex_turn_ownership_ambiguous",
          );
        }
        recoveredEngineTurnId = correlatedTurnId;
        actualEngineTurnId = correlatedTurnId;
        allowSiblingRunning = true;
      }

      if (!actualEngineTurnId) {
        return buildCodexRecoveryPendingResult(
          "Codex provider turnId 缺失且本地 clientUserMessageId 历史不足，无法恢复唯一 ownership",
          "codex_turn_correlation_scan_incomplete",
        );
      }

      const outcome = extractCodexThreadReadRecoveryOutcome(readAttempt.value, {
        engineSessionId: input.engineSessionId,
        engineTurnId: actualEngineTurnId,
        reason: `startup-reconcile.attempt-${attempt + 1}`,
        allowSiblingRunning,
      });
      if (outcome.kind === "pending") {
        if (attempt < maxAttempts - 1) {
          await delay(250 * (attempt + 1));
          continue;
        }
        return {
          kind: "pending",
          message: "Codex 上一条请求的终态仍未确认；本地回合保持待处理。",
          code: "client_restart_reconcile_timeout",
          dropSessionBinding: false,
            ...(actualEngineTurnId !== expectedEngineTurnId ? { actualEngineTurnId } : {}),
        };
      }
      const mapped = mapCodexRecoveryOutcome(outcome, {
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        turnId: input.turnId,
      });
      return actualEngineTurnId !== expectedEngineTurnId
        ? { ...mapped, actualEngineTurnId }
        : mapped;
    }

    return {
      kind: "pending",
      message: "Codex 上一条请求的终态仍未确认；本地回合保持待处理。",
      code: "client_restart_reconcile_timeout",
      dropSessionBinding: false,
      ...(recoveredEngineTurnId ? { actualEngineTurnId: recoveredEngineTurnId } : {}),
    };
  }

  /** 释放某 thread 的引擎会话（用于删除/清空后重建 session）。 */
  async disposeThread(threadId: ThreadId): Promise<void> {
    return await this.disposeThreadWithOptions(threadId, {});
  }

  /** 释放 thread session；并发调用复用同一结果，dispose 失败向上抛出。 */
  async disposeThreadWithOptions(threadId: ThreadId, opts: { flushActiveTurn?: boolean }): Promise<void> {
    const record = this.sessions.get(threadId) ?? null;
    if (!record) {
      await this.runThreadDisposal(threadId, "thread", null, async () => {
        await this.codexAppServer.releaseThread(threadId);
      });
      return;
    }
    await this.disposeSessionRecord(threadId, record, {
      flushActiveTurn: opts.flushActiveTurn !== false,
      reason: "thread-disposed",
    });
  }

  /** Reads a cached ordinary-chat session without creating Provider state. */
  getExisting(threadId: ThreadId): ThreadEngineSession | null {
    const record = this.sessions.get(threadId) ?? null;
    if (record) record.lastUsedAt = this.idleCleanup.now();
    return record?.session ?? null;
  }

  /** 停止创建新会话，并等待当前全部引擎 session 完成安全释放。 */
  async stopAndDrain(): Promise<void> {
    this.stopping = true;
    this.stopIdleCleanupTimer();
    // 退出时先主动中断运行中回合，避免关闭预算被长时间流式输出耗尽；失败仍由后续 dispose 收口。
    await Promise.allSettled(this.listActiveTurns().flatMap(({ threadId, turnId }) => turnId
      ? [this.interrupt(threadId, String(turnId)).catch(() => false)]
      : []));

    const ownerTargets: Array<{ description: string; promise: Promise<void> }> = [];
    if (this.idleCleanupTask) ownerTargets.push({ description: "停止前已有 idle session 扫描", promise: this.idleCleanupTask.then(() => {}) });
    for (const [threadId, disposal] of this.disposingByThreadId) {
      ownerTargets.push({
        description: `停止前已有 thread session 释放：threadId=${threadId}`,
        promise: disposal.promise,
      });
    }
    const restartOwner = this.codexRestartInFlight;
    if (restartOwner) {
      ownerTargets.push({
        description: "停止前已有 Codex app-server 重启",
        promise: restartOwner.promise,
      });
    }

    const failures: Error[] = [];
    const ownerResults = await Promise.allSettled(ownerTargets.map((target) => target.promise));
    for (const [index, result] of ownerResults.entries()) {
      if (result.status !== "rejected") continue;
      const cause = result.reason;
      failures.push(new Error(`${ownerTargets[index]!.description}失败：${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
    }

    const targets: Array<{ description: string; promise: Promise<void> }> = [];
    // Claude 现为 Desktop/Agent SDK 风格的长驻 stream-json session，Client 停止时
    // 也必须显式 dispose，否则子进程会失去宿主且留下不可恢复的后台任务。
    const sessionTargets = [...this.sessions];
    for (const [threadId, record] of sessionTargets) {
      targets.push({
        description: `停止时引擎 session 释放：threadId=${threadId}, engine=${record.session.engine}`,
        promise: this.disposeSessionRecord(threadId, record, {
          flushActiveTurn: true,
          reason: "thread-disposed",
        }),
      });
    }

    const results = await Promise.allSettled(targets.map((target) => target.promise));
    for (const [index, result] of results.entries()) {
      if (result.status !== "rejected") continue;
      const cause = result.reason;
      failures.push(new Error(`${targets[index]!.description}失败：${cause instanceof Error ? cause.message : String(cause)}`, {
        cause,
      }));
    }
    if (failures.length > 0) {
      const first = failures[0]!;
      throw new AggregateError(failures, `ThreadSessionManager 停止失败（${failures.length} 项）：${first.message}`);
    }
  }

  /** 重启 Codex app-server；会话 force 限定目标，key 切换仍默认安全释放全部进程。 */
  async restartCodexProcesses(options?: CodexRestartOptions): Promise<void> {
    this.assertNotStopping();
    const mode = options?.mode === "force" ? "force" : "safe";
    const current = this.codexRestartInFlight;
    if (current) {
      const threadId = options?.mode === "force" ? options.threadId ?? null : null;
      // 不同范围不能复用或接管同一事务，避免会话重启接管 Key 切换的全局释放。
      if (current.threadId !== threadId) {
        throw new Error("Codex app-server 已在重启中，请稍后重试");
      }
      if (mode !== "force") throw new Error("Codex app-server 已在重启中");
      if (current.mode === "force" || current.killCommitted) {
        await current.promise;
        return;
      }
    }

    const owner = this.createCodexRestartOwner(mode, options);
    this.codexRestartInFlight = owner;
    current?.supersede();
    try {
      await owner.promise;
    } finally {
      if (this.codexRestartInFlight === owner) this.codexRestartInFlight = null;
    }
  }

  /** 创建单次 restart owner；force 可在配置提交前显式接管 safe。 */
  private createCodexRestartOwner(
    mode: "safe" | "force",
    options?: CodexRestartOptions,
  ): CodexRestartOwner {
    let rejectSuperseded: ((cause: Error) => void) | null = null;
    const superseded = mode === "safe"
      ? new Promise<never>((_resolve, reject) => { rejectSuperseded = reject; })
      : null;
    const owner: CodexRestartOwner = {
      mode,
      threadId: options?.mode === "force" ? options.threadId ?? null : null,
      promise: Promise.resolve(),
      killCommitted: false,
      supersede: () => {
        const reject = rejectSuperseded;
        if (!reject) return;
        rejectSuperseded = null;
        reject(createCodexRestartSupersededError());
      },
    };
    owner.promise = Promise.resolve().then(
      () => this.restartCodexProcessesOnce(options, owner, superseded),
    );
    return owner;
  }

  /** force 直接终止进程；safe 必须先释放全部 live session。 */
  private async restartCodexProcessesOnce(
    options: CodexRestartOptions | undefined,
    owner: CodexRestartOwner,
    superseded: Promise<never> | null,
  ): Promise<void> {
    const targetThreadId = options?.mode === "force" ? options.threadId : undefined;
    const targets = [...this.sessions].filter(([threadId, record]) =>
      record.session.engine === "codex" && (!targetThreadId || threadId === targetThreadId));
    const force = options?.mode === "force";
    if (!force) {
      const disposalResults = Promise.allSettled(
        targets.map(async ([threadId, record]) => {
          await this.disposeSessionRecord(threadId, record, { flushActiveTurn: true, reason: "codex-restart" });
          return threadId;
        }),
      );
      const results = superseded
        ? await Promise.race([disposalResults, superseded])
        : await disposalResults;
      if (this.codexRestartInFlight !== owner) throw createCodexRestartSupersededError();
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [new Error(`Codex session 重启前释放失败：threadId=${targets[index]![0]}`, { cause: result.reason })]
        : []);
      if (failures.length > 0) {
        throw new AggregateError(failures, `Codex app-server 重启被阻止（${failures.length} 个 session 未安全释放）`);
      }
      owner.killCommitted = true;
      await options?.beforeKill?.();
    } else {
      owner.killCommitted = true;
    }
    if (targetThreadId) {
      // 只终止请求会话的独占进程；失败时不作任何本地终态假设。
      await this.codexAppServer.releaseThread(targetThreadId);
      await this.codexAppServer.forThread(targetThreadId).drainMessages?.();
    } else {
      await this.codexAppServer.killAllWorkspaces();
    }
    if (force) {
      this.clearExplicitlyRestartedCodexSessions(targets);
      if (options?.mode === "force") {
        await options.afterTermination?.(targets[0]?.[1].session ?? null);
        for (const [, record] of targets) this.log(record.session.workspaceId, "info", "explicit Codex restart settled after process termination", () => ({
          code: "codex_explicit_restart_settled",
          requestId: options.requestId ?? null,
          threadId: targetThreadId ?? null,
          affectedThreadIds: targets.map(([threadId]) => threadId),
          source: targetThreadId ? "thread_restart" : "all_processes_restart",
        }));
      }
    }
  }

  /** kill 成功后唤醒旧调用并丢弃旧代引用；持久化终态交给共享结算入口。 */
  private clearExplicitlyRestartedCodexSessions(targets: readonly [ThreadId, ThreadSessionRecord][]): void {
    for (const [threadId, record] of targets) {
      record.session.invalidateAfterProcessTermination?.();
      if (this.sessions.get(threadId) === record) {
        this.sessions.delete(threadId);
        this.engineProcesses.clearThread(threadId);
        this.credentialOwnersByThread.delete(threadId);
      }
      const disposal = this.disposingByThreadId.get(threadId);
      if (disposal?.strength === "session" && disposal.record === record) {
        this.disposingByThreadId.delete(threadId);
      }
    }
  }

  /** 立即执行一次 idle session 清理，返回本次释放数量。 */
  async disposeIdleSessions(now = this.idleCleanup.now()): Promise<number> {
    if (!this.idleCleanup.enabled || this.idleCleanupRunning) return 0;
    this.idleCleanupRunning = true;
    let disposed = 0;
    const failures: Error[] = [];
    try {
      for (const [threadId, record] of [...this.sessions]) {
        if (this.stopping) break;
        let stage = "eligibility";
        try {
          if (!(await this.withDatabase("session-manager", () => this.isIdleDisposable(threadId, record, now)))) continue;
          if (this.sessions.get(threadId) !== record) continue;
          stage = "dispose";
          await this.disposeSessionRecord(threadId, record, { flushActiveTurn: false, reason: "idle" });
          disposed += 1;
        } catch (cause) {
          let failure = cause;
          try {
            writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, record.session.workspaceId, () => ({ level: "error", tag: "thread-session",
              message: "idle session scan failed", data: { errorCode: "ENGINE_IDLE_SCAN_FAILED", requestId: `engine-idle:${threadId}`,
                threadId, stage, rootCause: engineDiagnosticCause(cause) } }), { reason: cause });
          } catch (diagnosticError) { failure = diagnosticError; }
          failures.push(new Error(`idle thread session 释放失败：threadId=${threadId}`, { cause: failure }));
        }
      }
    } finally {
      this.idleCleanupRunning = false;
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `idle thread session 释放失败（${failures.length} 个）`);
    }
    return disposed;
  }

  /** 更新某 thread 的最近使用时间并返回记录。 */
  private touchThreadSession(threadId: ThreadId): ThreadSessionRecord | null {
    const record = this.sessions.get(threadId) ?? null;
    if (!record) return null;
    record.lastUsedAt = this.idleCleanup.now();
    return record;
  }

  /** 串行释放同一 thread，并在 dispose 结束前阻止创建替代 session。 */
  private disposeSessionRecord(
    threadId: ThreadId,
    record: ThreadSessionRecord,
    options: ThreadDisposeOptions,
  ): Promise<void> {
    const strength: ThreadDisposalStrength = options.reason === "codex-restart" ? "session" : "thread";
    return this.runThreadDisposal(threadId, strength, record, async () => {
      const currentBeforeDispose = this.sessions.get(threadId) ?? null;
      if (currentBeforeDispose && currentBeforeDispose !== record) {
        throw new Error(`thread session 释放前 ownership 已换代：threadId=${threadId}`);
      }
      if (currentBeforeDispose === record) {
        await record.session.dispose?.(options);
      }
      const currentAfterDispose = this.sessions.get(threadId) ?? null;
      if (currentAfterDispose && currentAfterDispose !== record) {
        throw new Error(`thread session 释放期间 ownership 已换代：threadId=${threadId}`);
      }
      if (currentAfterDispose === record) {
        // session 已释放后立即移除，避免进程回收失败时复用废弃对象。
        this.sessions.delete(threadId);
        this.engineProcesses.clearThread(threadId);
      }
      if (record.session.engine === "codex" && options.reason !== "codex-restart") {
        await this.codexAppServer.releaseThread(threadId);
      }
      this.credentialOwnersByThread.delete(threadId);
    });
  }

  /** 串行执行同一 thread 的释放任务，并在异步等待期间阻止创建替代 session。 */
  private runThreadDisposal(
    threadId: ThreadId,
    strength: ThreadDisposalStrength,
    record: ThreadSessionRecord | null,
    run: () => Promise<void>,
  ): Promise<void> {
    const inFlight = this.disposingByThreadId.get(threadId);
    if (inFlight && (inFlight.strength === "thread" || strength === "session")) {
      return inFlight.promise;
    }

    let resolveDisposal!: () => void;
    let rejectDisposal!: (error: unknown) => void;
    const disposal = new Promise<void>((resolve, reject) => {
      resolveDisposal = resolve;
      rejectDisposal = reject;
    });
    const entry = { strength, promise: disposal, record };
    // thread 释放可原子升级正在进行的 session-only 释放，中间不开放替代 session 创建窗口。
    this.disposingByThreadId.set(threadId, entry);
    const predecessor = inFlight?.promise ?? Promise.resolve();
    void predecessor.then(run).then(resolveDisposal, rejectDisposal);
    void disposal.then(
      () => this.clearDisposingThread(threadId, entry),
      () => this.clearDisposingThread(threadId, entry),
    );
    return disposal;
  }

  /** 仅清理由当前 dispose owner 持有的 thread gate。 */
  private clearDisposingThread(threadId: ThreadId, disposal: ThreadDisposal): void {
    if (this.disposingByThreadId.get(threadId) === disposal) {
      this.disposingByThreadId.delete(threadId);
    }
  }

  /** 恢复路径服从停止与重启门禁，禁止创建漏网 Codex 进程。 */
  private assertCodexProcessCreationAllowed(): void {
    this.assertNotStopping();
    if (this.codexRestartInFlight) {
      throw new Error("Codex app-server 正在重启，请稍后重试");
    }
  }

  /** 停止开始后拒绝新增会话、进程和重启任务。 */
  private assertNotStopping(): void {
    if (this.stopping) {
      throw new Error("ThreadSessionManager 正在停止，拒绝创建新会话或进程");
    }
  }

  /** 判断 session 是否达到 idle 回收条件。 */
  private isIdleDisposable(threadId: ThreadId, record: ThreadSessionRecord, now: number): boolean {
    if (this.disposingByThreadId.has(threadId)) return false;
    if (now - record.lastUsedAt < this.idleCleanup.idleMs) return false;
    if (record.session.hasActiveTurn()) return false;
    if (this.hasLiveManagedService(threadId)) return false;
    if (record.session.canIdleDispose && !record.session.canIdleDispose()) return false;
    return true;
  }

  /** 检查当前 thread 是否仍有运行中托管服务。 */
  private hasLiveManagedService(threadId: ThreadId): boolean {
    const snapshots = this.managedServiceSnapshotProvider
      ? this.managedServiceSnapshotProvider(threadId)
      : this.engineProcesses.listThreadServices(threadId);
    return snapshots.some((snapshot) => snapshot.status === "starting" || snapshot.status === "ready");
  }

  /** 启动 idle 清理定时器。 */
  private startIdleCleanupTimer(): void {
    if (!this.idleCleanup.enabled || this.idleCleanupTimer) return;
    this.idleCleanupTimer = setInterval(() => {
      if (this.idleCleanupTask) return;
      const task = this.disposeIdleSessions();
      this.idleCleanupTask = task;
      void task.then(() => { if (this.idleCleanupTask === task) this.idleCleanupTask = null; }, () => {
        // 原拒绝保留在同一task供stopAndDrain消费；已按W记录，不自动重试失败扫描。
        this.stopIdleCleanupTimer();
      });
    }, this.idleCleanup.scanMs);
    this.idleCleanupTimer.unref?.();
  }

  /** 停止 idle session 扫描；不会中断已经开始的释放任务。 */
  private stopIdleCleanupTimer(): void {
    if (!this.idleCleanupTimer) return;
    clearInterval(this.idleCleanupTimer);
    this.idleCleanupTimer = null;
  }

  /** 只使用可信线程 W 写日志；诊断失败与 provider 失败区分并保留业务根因。 */
  private log(workspaceId: WorkspaceId, level: WorkspaceLogEntry["level"], message: string,
    data: () => Record<string, unknown>, business?: { reason: unknown }): void {
    try {
      writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, workspaceId, () => ({ level, tag: "thread-session-manager", message, data: data() }), business);
    } catch (cause) {
      if (isEngineWorkspaceLogFailure(cause)) throw cause;
      throw createEngineWorkspaceLogFailure(cause);
    }
  }
}

type CodexRecoveryWorkspace = {
  request(
    method: string,
    params?: unknown,
    opts?: { timeoutMs?: number; trackLateSettlement?: boolean; history?: CodexHistoryProjection },
  ): Promise<unknown>;
};

/** 分页读取精确 provider thread；正文仅加载需要确认的目标 turn。 */
async function readCodexThreadById(
  ws: CodexRecoveryWorkspace,
  engineSessionId: SessionId,
  opts: { includeTurns?: boolean; turnId?: string } = {},
): Promise<CodexThreadReadAttempt> {
  try {
    const value = await ws.request(
      "thread/read",
      { threadId: engineSessionId, includeTurns: opts.includeTurns !== false },
      {
        ...CODEX_RECOVERY_REQUEST_OPTIONS,
        history: { ...(opts.turnId ? { turnIds: [opts.turnId] } : {}), itemTypes: ["userMessage", "agentMessage"] },
      },
    );
    const providerThreadId = String((value as any)?.thread?.id ?? "").trim();
    if (providerThreadId !== String(engineSessionId)) {
      return {
        kind: "failed",
        message: `thread/read 返回了错误 threadId：expected=${engineSessionId}, actual=${providerThreadId || "missing"}`,
      };
    }
    return { kind: "read", value };
  } catch (error) {
    if (isEngineWorkspaceLogFailure(error)) throw error;
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: String((error as any)?.code ?? "").trim() !== "codex_app_server_request_timeout",
      error,
    };
  }
}

/** 精确 provider pair 启动对账先读取现状；仅 thread 不存在时才触发 resume。 */
async function readCodexThreadDirectFirst(
  ws: CodexRecoveryWorkspace,
  engineSessionId: SessionId,
  turnId: string,
): Promise<CodexThreadReadAttempt> {
  const direct = await readCodexThreadById(ws, engineSessionId, { includeTurns: true, turnId });
  if (direct.kind === "read" || !isCodexThreadUnavailableSignal(direct.message)) return direct;
  return await readCodexThreadWithResumeFallback(ws, engineSessionId, { includeTurns: true, turnId });
}

/** 直接恢复并读取指定 provider thread；精确 pair 不依赖当前本地 binding。 */
async function readCodexThreadWithResumeFallback(
  ws: CodexRecoveryWorkspace,
  engineSessionId: SessionId,
  opts: { includeTurns?: boolean; turnId?: string } = {},
): Promise<CodexThreadReadAttempt> {
  let head: unknown;
  try {
    head = await resumeCodexProviderThreadForRead(ws, engineSessionId, {
      includeTurns: opts.includeTurns === true,
      history: { ...(opts.turnId ? { turnIds: [opts.turnId] } : {}), itemTypes: ["userMessage", "agentMessage"] },
    });
  } catch (error) {
    if (isEngineWorkspaceLogFailure(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "failed",
      message,
      retryable: (error as any)?.retryable !== false,
      error,
    };
  }

  const thread = (head as any)?.thread ?? null;
  const providerThreadId = String(thread?.id ?? "").trim();
  if (providerThreadId !== String(engineSessionId)) {
    return {
      kind: "failed",
      message: `thread/read 返回了错误 threadId：expected=${engineSessionId}, actual=${providerThreadId || "missing"}`,
    };
  }
  if (opts.includeTurns) return { kind: "read", value: head };

  try {
    const listed = await ws.request(
      "thread/turns/list",
      {
        threadId: engineSessionId,
        limit: CODEX_RECOVERY_TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      },
      { ...CODEX_RECOVERY_REQUEST_OPTIONS, history: { itemTypes: ["userMessage", "agentMessage"] } },
    );
    if (!Array.isArray((listed as any)?.data)) {
      throw new Error(`thread/turns/list 返回非法结构：threadId=${engineSessionId}`);
    }
    const listedTurns = (listed as any).data as unknown[];
    const hasExplicitNextCursor = Object.prototype.hasOwnProperty.call(listed as object, "nextCursor");
    const turnListComplete = hasExplicitNextCursor
      ? !String((listed as any)?.nextCursor ?? "").trim()
      : listedTurns.length < CODEX_RECOVERY_TURN_LIMIT;
    return {
      kind: "read",
      value: {
        thread: {
          ...thread,
          turns: listedTurns,
          __codeflowRecoveryTurnListComplete: turnListComplete,
        },
      },
    };
  } catch (error) {
    if (isEngineWorkspaceLogFailure(error)) throw error;
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
      retryable: String((error as any)?.code ?? "").trim() !== "codex_app_server_request_timeout",
      error,
    };
  }
}

/** 提取匹配 thread 的 running turn ID；结构或 threadId 不可信时显式返回 invalid。 */
function inspectCodexRunningTurns(
  read: unknown,
  engineSessionId: SessionId,
  expectedTurnId: string | null,
  clientUserMessageIds: readonly string[] = [],
): {
  kind: "valid";
  threadStatus: string;
  latestTurnId: string;
  latestTurnStatus: string;
  runningTurnIds: string[];
  expectedTurnMatchCount: number;
  expectedTurnStatus: string;
  clientUserMessageTurnIdsById: Map<string, string[]>;
  turnStatusById: Map<string, string>;
  turnListComplete: boolean;
} | { kind: "invalid"; message: string } {
  const thread = (read as any)?.thread ?? null;
  const providerThreadId = String(thread?.id ?? "").trim();
  if (providerThreadId !== String(engineSessionId)) {
    return {
      kind: "invalid",
      message: `thread/read 返回了错误 threadId：expected=${engineSessionId}, actual=${providerThreadId || "missing"}`,
    };
  }
  if (!Array.isArray(thread?.turns)) {
    return { kind: "invalid", message: `thread/turns/list 缺少 turns：threadId=${engineSessionId}` };
  }
  const seenTurnIds = new Set<string>();
  const runningTurnIds: string[] = [];
  const normalizedClientUserMessageIds = normalizeCodexClientUserMessageIds({ clientUserMessageIds });
  const clientUserMessageTurnIdsById = new Map(
    normalizedClientUserMessageIds.map((clientId) => [clientId, [] as string[]]),
  );
  const turnStatusById = new Map<string, string>();
  let expectedTurnMatchCount = 0;
  let expectedTurnStatus = "";
  for (const turn of thread.turns as any[]) {
    const turnId = String(turn?.id ?? "").trim();
    if (!turnId) return { kind: "invalid", message: `thread/turns/list turn 缺少 ID：threadId=${engineSessionId}` };
    if (seenTurnIds.has(turnId)) {
      return { kind: "invalid", message: `thread/turns/list 包含重复 turnId：threadId=${engineSessionId}, turnId=${turnId}` };
    }
    seenTurnIds.add(turnId);
    const turnStatus = normalizeCodexStatus(turn?.status);
    turnStatusById.set(turnId, turnStatus);
    if (turnId === expectedTurnId) {
      expectedTurnMatchCount += 1;
      expectedTurnStatus = turnStatus;
    }
    if (normalizedClientUserMessageIds.length > 0 && !Array.isArray(turn?.items)) {
      return {
        kind: "invalid",
        message: `thread/turns/list full item 结构非法：threadId=${engineSessionId}, turnId=${turnId}`,
      };
    }
    for (const clientUserMessageId of normalizedClientUserMessageIds) {
      if (codexTurnContainsClientUserMessage(turn, clientUserMessageId)) {
        clientUserMessageTurnIdsById.get(clientUserMessageId)!.push(turnId);
      }
    }
    if (isRunningCodexTurnStatus(turnStatus)) runningTurnIds.push(turnId);
  }
  return {
    kind: "valid",
    threadStatus: normalizeCodexStatus(thread.status),
    latestTurnId: String(thread.turns[0]?.id ?? "").trim(),
    latestTurnStatus: normalizeCodexStatus(thread.turns[0]?.status),
    runningTurnIds,
    expectedTurnMatchCount,
    expectedTurnStatus,
    clientUserMessageTurnIdsById,
    turnStatusById,
    turnListComplete: (thread as any).__codeflowRecoveryTurnListComplete === true,
  };
}

/** 有界 provider turn 页未覆盖完整历史时保留 running，禁止把“未命中”升级成 ownership 丢失。 */
function buildCodexTurnCorrelationScanIncompleteMessage(
  clientUserMessageIds: readonly string[],
  runningTurnIds: readonly string[],
): string {
  return `thread/turns/list 仅检查最近 ${CODEX_RECOVERY_TURN_LIMIT} 个 provider turn 且仍有更早历史；clientUserMessageIds=${clientUserMessageIds.join(",")} 尚未完整确权，拒绝误判 ownership 丢失；当前 running turn=${runningTurnIds.join(",") || "none"}`;
}

/** 规范化按新到旧排列的本地 clientId 候选，并兼容旧单值调用。 */
function normalizeCodexClientUserMessageIds(input: {
  clientUserMessageIds?: readonly string[];
  clientUserMessageId?: string | null;
}): string[] {
  const ordered = [
    ...(input.clientUserMessageIds ?? []),
    input.clientUserMessageId ?? "",
  ];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of ordered) {
    const clientId = String(value ?? "").trim();
    if (!clientId || seen.has(clientId)) continue;
    seen.add(clientId);
    normalized.push(clientId);
  }
  return normalized;
}

/** 从同一 provider 快照选择最新且唯一物化的本地 clientId；高优先级缺口未覆盖时保持 incomplete。 */
function selectLatestCodexClientUserMessageOwnership(
  inspected: Extract<ReturnType<typeof inspectCodexRunningTurns>, { kind: "valid" }>,
  clientUserMessageIds: readonly string[],
):
  | { kind: "selected"; clientUserMessageId: string; providerTurnId: string }
  | { kind: "ambiguous"; clientUserMessageId: string; providerTurnIds: string[] }
  | { kind: "missing" }
  | { kind: "incomplete" } {
  for (const clientUserMessageId of clientUserMessageIds) {
    const providerTurnIds = inspected.clientUserMessageTurnIdsById.get(clientUserMessageId) ?? [];
    if (providerTurnIds.length > 1) {
      return { kind: "ambiguous", clientUserMessageId, providerTurnIds };
    }
    if (providerTurnIds.length === 1) {
      return {
        kind: "selected",
        clientUserMessageId,
        providerTurnId: providerTurnIds[0]!,
      };
    }
    if (!inspected.turnListComplete) return { kind: "incomplete" };
  }
  return inspected.turnListComplete ? { kind: "missing" } : { kind: "incomplete" };
}

/** 判断 provider turn 是否包含指定 clientUserMessageId 的用户消息。 */
function codexTurnContainsClientUserMessage(turn: unknown, clientUserMessageId: string): boolean {
  const items = Array.isArray((turn as any)?.items) ? ((turn as any).items as any[]) : [];
  return items.some((item) => (
    String(item?.type ?? "").trim() === "userMessage"
    && String(item?.clientId ?? item?.client_id ?? "").trim() === clientUserMessageId
  ));
}

/** 规范化 Codex 字符串或对象状态。 */
function normalizeCodexStatus(status: unknown): string {
  if (typeof status === "string") return status.trim().toLowerCase();
  if (status && typeof status === "object") return String((status as any).type ?? "").trim().toLowerCase();
  return "";
}

/** 判断 provider 是否明确要求先恢复 thread/rollout。 */
function isCodexThreadUnavailableSignal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return normalized.includes("thread not found") || normalized.includes("no rollout found");
}

/** 判断 provider 是否明确表示目标回合已经没有可中断对象。 */
function isCodexNoActiveTurnSignal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim().toLowerCase().includes("no active turn to interrupt");
}

/** 仅识别进程已明确失效的错误；单纯 RPC timeout 不得立即重启 app-server。 */
function isCodexAppServerRestartableFailure(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  const code = String(record?.code ?? "").trim();
  if (
    code === "codex_app_server_closed"
    || code === "codex_app_server_fatal"
    || code === "codex_app_server_process_error"
    || code === "codex_app_server_process_tree_termination_failed"
  ) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.trim().toLowerCase();
  return normalized.includes("codex app-server closed")
    || normalized.includes("codex app-server fatal")
    || normalized.includes("codex app-server process error")
    || normalized.includes("process tree termination failed");
}

/** 合并恢复失败与精确中断重试失败，保留两个根因供上层日志追踪。 */
function combineCodexResumeAndInterruptFailures(resumeCause: unknown, interruptCause: unknown): Error {
  const interruptError = interruptCause instanceof Error ? interruptCause : new Error(String(interruptCause));
  if (resumeCause == null) return interruptError;
  const resumeError = resumeCause instanceof Error ? resumeCause : new Error(String(resumeCause));
  return Object.assign(new Error(
    `thread/resume 失败：${resumeError.message}；turn/interrupt 重试失败：${interruptError.message}`,
    { cause: interruptError },
  ), { resumeCause: resumeError });
}

/** 复制 capability 快照，避免调用方后续修改数组污染 CAS 基线。 */
function cloneSessionCapabilities(
  capabilities: ThreadSessionCapabilities | null | undefined,
): ThreadSessionCapabilities | null {
  if (!capabilities) return null;
  return {
    codexDynamicToolIds: Array.isArray(capabilities.codexDynamicToolIds)
      ? capabilities.codexDynamicToolIds.map(String)
      : capabilities.codexDynamicToolIds ?? null,
    codexDynamicToolBindingVersion: capabilities.codexDynamicToolBindingVersion ?? null,
  };
}

/** capability 以稳定化的工具集合和 binding version 比较。 */
function sessionCapabilitiesEqual(
  left: ThreadSessionCapabilities | null | undefined,
  right: ThreadSessionCapabilities | null | undefined,
): boolean {
  const normalizeIds = (value: string[] | null | undefined): string[] => Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item ?? "").trim()).filter(Boolean))).sort()
    : [];
  const leftIds = normalizeIds(left?.codexDynamicToolIds);
  const rightIds = normalizeIds(right?.codexDynamicToolIds);
  return leftIds.length === rightIds.length
    && leftIds.every((item, index) => item === rightIds[index])
    && String(left?.codexDynamicToolBindingVersion ?? "").trim()
      === String(right?.codexDynamicToolBindingVersion ?? "").trim();
}

/** 判断 provider turn 是否仍在执行。 */
function isRunningCodexTurnStatus(status: string): boolean {
  return status === "inprogress" || status === "in_progress" || status === "running" || status === "active";
}

/** 判断 provider turn 是否已明确结束。 */
function isTerminalCodexTurnStatus(status: string): boolean {
  return status === "completed" || status === "interrupted" || status === "error" || status === "failed" || status === "cancelled";
}

/** 判断 provider thread 是否仍允许存在 active turn。 */
function isNonTerminalCodexThreadStatus(status: string): boolean {
  return status === "active" || status === "running" || status === "inprogress" || status === "in_progress";
}

/** 只有 idle 能证明 provider thread 已无 active turn并可做完整 ownership 裁决。 */
function isTerminalCodexThreadStatus(status: string): boolean {
  return status === "idle";
}

/** 从已确认的恢复结果还原 provider 终态，供 live session 精确收口。 */
function getCodexRecoveryTerminalStatus(
  outcome: Exclude<CodexTurnRecoveryOutcome, { kind: "pending" }>,
): string | null {
  if (outcome.kind === "completed") return "completed";
  const code = String(outcome.code ?? "").trim().toLowerCase();
  const status = code.startsWith("codex_") ? code.slice("codex_".length) : "";
  return isTerminalCodexTurnStatus(status) ? status : null;
}

/** 构造需要保留本地 running 的 provider 待确认结果。 */
function buildCodexRecoveryPendingResult(message: string, code: string): CodexDanglingTurnFailureResult {
  return { kind: "pending", message, code, dropSessionBinding: false };
}

/** 仅识别 provider 明确表示目标 turn 已无 active 状态的竞态信号。 */
function isCodexNoActiveTurnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim().toLowerCase().includes("no active turn to interrupt");
}

/** 规范化 idle 回收配置，测试可注入 now。 */
function normalizeSessionIdleCleanupOptions(input?: SessionIdleCleanupOptions): NormalizedSessionIdleCleanupOptions {
  const idleMs = normalizePositiveMs(input?.idleMs, DEFAULT_SESSION_IDLE_DISPOSE_MS);
  const scanMs = normalizePositiveMs(input?.scanMs, DEFAULT_SESSION_IDLE_SCAN_MS);
  return {
    enabled: input?.enabled !== false,
    idleMs,
    scanMs,
    now: input?.now ?? (() => Date.now()),
  };
}

/** 规范化正整数毫秒值。 */
function normalizePositiveMs(value: unknown, fallback: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.floor(n));
}

/** 把已确认的 provider 终态映射为本地完成或失败，不接受 pending 快照。 */
export function mapCodexRecoveryOutcome(
  outcome: Exclude<CodexTurnRecoveryOutcome, { kind: "pending" }>,
  input: { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId },
): CodexTerminalReconcileResult {
  if (outcome.kind === "completed") {
    return {
      kind: "completed",
      responseText: outcome.responseText,
      assistantEvents: outcome.assistantItems.map((item, index) => buildAssistantCompletedEvent({
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        engine: "codex",
        itemId: item.itemId,
        engineMessageId: item.engineMessageId,
        turnId: input.turnId,
        text: item.text,
        revision: index + 1,
        phase: item.phase,
        completionSource: "snapshot_reconcile",
      })),
    };
  }
  return {
    kind: "error",
    message: outcome.message,
    code: outcome.code,
    dropSessionBinding: false,
    providerTerminal: true,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
