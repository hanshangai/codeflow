import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type { WorkspaceId } from "@codeflowai/shared";

import type { WorkspaceLogEntry } from "../../logger.js";
import { createEngineWorkspaceLogFailure, engineDiagnosticCause, engineDiagnosticField, isEngineWorkspaceLogFailure, writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "../threadSession.js";
import { redactClientStartupText } from "../../startup/clientStartupStatus.js";
import {
  readCodexThreadHistory,
  readCodexTurnHistoryPage,
  type CodexHistoryProjection,
} from "./codexAppServerHistory.js";
import {
  CodexAppServerLineReader,
  type CodexAppServerLineLimitError,
} from "./codexAppServerLineReader.js";
import { resolveCodexCli } from "./codexAppServerCli.js";
import {
  buildCodexAppServerConfigArgs,
  CODEFLOWAI_CODEX_API_KEY_ENV,
  readEngineConfig,
  type CodexRuntimeConfig,
} from "../../enginesConfig.js";
import { buildClientChildProcessEnv } from "../../runtime/clientProcessEnv.js";
import {
  excludeTurnsFromThreadResume,
  resolveCodexAppServerModelProvider,
} from "./codexAppServerProtocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  method: string;
  processGeneration: number;
};

type TimedOutPending = {
  resolve: (settlement: CodexAppServerLateSettlement) => void;
  method: string;
  processGeneration: number;
  expiryTimer: NodeJS.Timeout;
};

type ProcessTermination = {
  child: ChildProcessWithoutNullStreams;
  processGeneration: number;
  promise: Promise<void>;
};

export type CodexProcessTreeTerminationCompletion =
  | { status: "confirmed" }
  | { status: "unconfirmed"; reason: string }
  | { status: "failed"; error: Error; helperExited?: boolean };

export type CodexProcessTreeTerminationHandle = {
  outcome: Promise<void>;
  completion: Promise<CodexProcessTreeTerminationCompletion>;
};

export type CodexProcessTreeTerminationOptions = {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawnProcess?: typeof spawn;
  timeoutMs?: number;
  stopGraceMs?: number;
};

const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 15_000;
const TASKKILL_STOP_GRACE_MS = 1_000;
const CODEX_APP_SERVER_LATE_SETTLEMENT_TTL_MS = 10 * 60_000;

export type CodexAppServerMessage = Record<string, unknown>;

type ThreadHandlerRegistration = {
  owner: CodexAppServerWorkspace;
  handler: (msg: CodexAppServerMessage) => void;
};

/** 恢复类 RPC 的默认预算；覆盖大历史 thread/resume 的实际耗时。 */
export const CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS = 180_000;

/** 识别旧调用点的 10 秒预算；其它显式预算按调用方意图保留。 */
const CODEX_APP_SERVER_LEGACY_RECOVERY_TIMEOUT_MS = 10_000;

/** 需要长预算和迟到结算追踪的恢复/控制 RPC。 */
function isCodexRecoveryRpcMethod(method: string): boolean {
  return method === "thread/resume"
    || method === "thread/read"
    || method === "thread/turns/list"
    || method === "turn/interrupt";
}

/** 为未经过协议构造器的 thread/start|resume 调用补上当前运行时 provider。 */
function addCurrentCodexModelProvider(
  method: string,
  params: unknown,
  resolveRuntimeConfig?: () => CodexRuntimeConfig | null,
): unknown {
  if (method !== "thread/start" && method !== "thread/resume") return params;
  if (!resolveRuntimeConfig || !params || typeof params !== "object" || Array.isArray(params)) return params;
  const record = params as Record<string, unknown>;
  if (String(record.modelProvider ?? "").trim()) return params;
  const modelProvider = resolveCodexAppServerModelProvider(resolveRuntimeConfig());
  return modelProvider ? { ...record, modelProvider } : params;
}

export type CodexAppServerLateSettlement =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; kind: "rpc_error" | "process_fault"; reason: Error };
export type CodexAppServerFaultCode =
  | "codex_app_server_closed"
  | "codex_app_server_fatal"
  | "codex_app_server_process_error"
  | "codex_app_server_process_tree_termination_failed"
  | "codex_app_server_protocol_line_too_large"
  | "codex_app_server_thread_handler_error"
  | "codex_app_server_generation_changed"
  | "codex_app_server_request_timeout";

export type CodexAppServerRequestTimeout = {
  requestId: number;
  method: string;
  elapsedMs: number;
  timeoutMs: number;
  processGeneration: number;
  pendingMethods: string[];
};

export type CodexAppServerRequestOptions = {
  timeoutMs?: number;
  trackLateSettlement?: boolean;
  expectedProcessGeneration?: number;
  /** Local projection for paginated history reads; never sent to the provider. */
  history?: CodexHistoryProjection;
};

/**
 * Codex `app-server` 进程会话（由上层按 CodeFlow thread 隔离）。
 * - 通过 stdin/stdout 逐行 JSON-RPC 通信
 * - 将通知/请求分发给对应 thread（按 params.threadId）
 */
export class CodexAppServerWorkspace {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private termination: ProcessTermination | null = null;
  private terminationFailure: (Error & Partial<Pick<CodexAppServerRuntimeError, "requestId" | "processTreeHelperExited">>) | null = null;
  private releaseRequested = false;
  private processGeneration = 0;

  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly timedOutPending = new Map<number, TimedOutPending>();
  /** 同一进程代的相同恢复请求只保留一个在途 RPC，避免超时后继续堆叠。 */
  private readonly inFlightRecoveryRequests = new Map<string, Promise<unknown>>();
  private readonly threadHandlers = new Map<string, ThreadHandlerRegistration>();
  private readonly faultedChildren = new WeakSet<ChildProcessWithoutNullStreams>();

  constructor(
    private readonly opts: {
      workspaceId: WorkspaceId;
      localThreadId: string;
      writeWorkspaceLog: EngineWorkspaceLogWriter;
      workspacePath: string;
      clientInfo: { name: string; title: string; version: string };
      /** 从 Client DB 读取当前活动 Key；返回 null 表示使用 Codex 本机配置。 */
      resolveCodexRuntimeConfig?: () => CodexRuntimeConfig | null | Promise<CodexRuntimeConfig | null>;
      onOrphanMessage?: (msg: CodexAppServerMessage) => void;
      onStderrLine?: (line: string) => void;
      onRequestTimeout?: (timeout: CodexAppServerRequestTimeout) => void;
      onProcessFault?: (fault: {
        code: CodexAppServerFaultCode;
        message: string;
        method?: string;
        requestId?: string | number;
      }) => void;
      terminateProcessTree?: (
        child: ChildProcessWithoutNullStreams,
      ) => Promise<void> | CodexProcessTreeTerminationHandle;
      scheduleThreadMessage?: (task: {
        run: () => void;
        onFailure?: (cause: unknown) => void;
        bytes: number;
        pause?: () => void;
        resume?: () => void;
        canPause?: () => boolean;
      }) => void;
      /** 控制 RPC 发出前恢复被背压暂停的 stdout。 */
      resumeStdout?: () => void;
    },
  ) {}

  /** 确保 app-server 已启动并完成 initialize/initialized。 */
  async ensureStarted(): Promise<void> {
    if (this.terminationFailure) throw this.terminationFailure;
    if (this.termination) {
      throw createCodexAppServerError(
        "codex_app_server_closed",
        "Codex app-server process tree termination is in progress",
      );
    }
    if (this.releaseRequested) {
      throw createCodexAppServerError(
        "codex_app_server_closed",
        "Codex app-server workspace has been released",
      );
    }
    // 必须先等待已有 startPromise；spawn 后到 initialize 完成之间 child 已存在但尚未 ready。
    if (!this.startPromise && this.child) return;
    if (!this.startPromise) this.startPromise = this.start();
    try {
      await this.startPromise;
    } catch (e) {
      // 允许下次重试启动（避免 startPromise 永久处于 rejected）。
      this.startPromise = null;
      throw e;
    }
  }

  /** 判断当前 workspace app-server 子进程是否仍在运行。 */
  isRunning(): boolean {
    return this.child != null;
  }

  /** 仅物理回收已结束才允许退役；诊断失败仍由本次释放拒绝返回，不阻塞后续显式重建。 */
  isReleaseComplete(): boolean {
    return this.releaseRequested
      && this.child == null
      && this.termination == null
      && (this.terminationFailure == null || isEngineWorkspaceLogFailure(this.terminationFailure));
  }

  /** Atomically snapshots the live child generation for prepared Skill fencing. */
  getProcessSnapshot(): { running: boolean; generation: number } {
    return {
      running: this.child != null,
      generation: this.processGeneration,
    };
  }

  /** Checks that a prepared input still targets the same live app-server child. */
  isCurrentProcessGeneration(expectedGeneration: number): boolean {
    return this.child != null && this.processGeneration === expectedGeneration;
  }

  /** 发送 JSON-RPC request；副作用请求可选择保留超时后的迟到结算。 */
  async request(
    method: string,
    params: unknown,
    opts?: CodexAppServerRequestOptions,
  ): Promise<unknown> {
    await this.ensureStarted();
    const needsProvider = (method === "thread/start" || method === "thread/resume")
      && params && typeof params === "object" && !Array.isArray(params) && !String((params as Record<string, unknown>).modelProvider ?? "").trim();
    const runtimeConfig = needsProvider && this.opts.resolveCodexRuntimeConfig ? await this.opts.resolveCodexRuntimeConfig() : null;
    const child = this.child;
    if (!child) throw new Error("Codex app-server not started");
    if (
      opts?.expectedProcessGeneration != null
      && this.processGeneration !== opts.expectedProcessGeneration
    ) {
      throw createCodexAppServerError(
        "codex_app_server_generation_changed",
        `Codex app-server process generation changed before ${method}`,
        method,
        { processGeneration: this.processGeneration },
      );
    }
    const providerParams = addCurrentCodexModelProvider(
      method,
      params,
      this.opts.resolveCodexRuntimeConfig ? () => runtimeConfig : undefined,
    );
    const effectiveParams = excludeTurnsFromThreadResume(method, providerParams);
    const processGeneration = this.processGeneration;
    const requestedTimeoutMs = Number(opts?.timeoutMs ?? 20_000);
    const normalizedTimeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(500, requestedTimeoutMs)
      : 20_000;
    const isRecoveryRpc = isCodexRecoveryRpcMethod(method);
    const useLegacyRecoveryPolicy = isRecoveryRpc
      && (opts?.timeoutMs == null || normalizedTimeoutMs === CODEX_APP_SERVER_LEGACY_RECOVERY_TIMEOUT_MS);
    const timeoutMs = useLegacyRecoveryPolicy
      ? CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS
      : normalizedTimeoutMs;
    const trackLateSettlement = opts?.trackLateSettlement ?? useLegacyRecoveryPolicy;
    const recoveryKey = isRecoveryRpc && trackLateSettlement
      ? `${processGeneration}:${method}:${safeStableJson(effectiveParams)}:${safeStableJson(opts?.history ?? null)}`
      : null;
    const existingRecovery = recoveryKey ? this.inFlightRecoveryRequests.get(recoveryKey) : null;
    if (existingRecovery) return existingRecovery;

    let request!: Promise<unknown>;
    const clearRecoveryRequest = () => {
      if (recoveryKey && this.inFlightRecoveryRequests.get(recoveryKey) === request) {
        this.inFlightRecoveryRequests.delete(recoveryKey);
      }
    };
    const record = effectiveParams as Record<string, unknown> | null;
    const paginatedHistory = record && typeof record === "object" && (
      (method === "thread/read" && record.includeTurns === true)
      || (method === "thread/turns/list" && record.itemsView === "full")
    );
    request = paginatedHistory
      ? this.requestHistory(method, record, { ...opts, timeoutMs, expectedProcessGeneration: processGeneration })
        .finally(clearRecoveryRequest)
      : this.requestStarted(method, effectiveParams, { ...opts, timeoutMs, trackLateSettlement }, clearRecoveryRequest);
    if (recoveryKey) {
      this.inFlightRecoveryRequests.set(recoveryKey, request);
      void request.then(
        clearRecoveryRequest,
        (error) => {
          const lateSettlement = (error as any)?.lateSettlement;
          if (lateSettlement && typeof lateSettlement.then === "function") {
            // 超时只结束本地等待；等真实响应/进程故障后再允许下一次同请求。
            void lateSettlement.then(clearRecoveryRequest, clearRecoveryRequest);
            return;
          }
          clearRecoveryRequest?.();
        },
      );
    }
    return request;
  }

  /** Keeps all pages within the original RPC timeout and child generation. */
  private async requestHistory(
    method: string,
    params: Record<string, unknown>,
    options: CodexAppServerRequestOptions,
  ): Promise<unknown> {
    const deadline = Date.now() + (options.timeoutMs ?? CODEX_APP_SERVER_RECOVERY_REQUEST_TIMEOUT_MS);
    const request = async (pageMethod: string, pageParams: Record<string, unknown>): Promise<unknown> => {
      await this.ensureStarted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw createCodexAppServerError("codex_app_server_request_timeout", "Codex paginated history read timed out", method);
      }
      return this.requestStarted(pageMethod, pageParams, {
        timeoutMs: remaining,
        expectedProcessGeneration: options.expectedProcessGeneration,
        trackLateSettlement: true,
      });
    };
    return method === "thread/read"
      ? readCodexThreadHistory(request, params, options.history)
      : readCodexTurnHistoryPage(request, params, options.history);
  }

  /** 在已完成 initialize 的当前进程代发送一次 RPC；禁止递归进入 ensureStarted。 */
  private requestStarted(
    method: string,
    params: unknown,
    opts: CodexAppServerRequestOptions,
    onLateSettlementReleased?: () => void,
  ): Promise<unknown> {
    const child = this.child;
    if (!child) throw new Error("Codex app-server not started");
    if (
      opts.expectedProcessGeneration != null
      && this.processGeneration !== opts.expectedProcessGeneration
    ) {
      throw createCodexAppServerError(
        "codex_app_server_generation_changed",
        `Codex app-server process generation changed before ${method}`,
        method,
        { processGeneration: this.processGeneration },
      );
    }
    const id = this.nextId++;
    const payload = { id, method, params };
    const processGeneration = this.processGeneration;
    const startedAt = Date.now();
    const requestedTimeoutMs = Number(opts.timeoutMs ?? 20_000);
    const timeoutMs = Number.isFinite(requestedTimeoutMs)
      ? Math.max(500, requestedTimeoutMs)
      : 20_000;
    let resolveLateSettlement: ((settlement: CodexAppServerLateSettlement) => void) | null = null;
    const lateSettlement = opts.trackLateSettlement
      ? new Promise<CodexAppServerLateSettlement>((resolve) => {
          resolveLateSettlement = resolve;
        })
      : null;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pendingMethods = Array.from(this.pending.values(), (pending) => pending.method).sort();
        this.pending.delete(id);
        if (resolveLateSettlement) {
          let timedOut!: TimedOutPending;
          const expiryTimer = setTimeout(() => {
            if (this.timedOutPending.get(id) !== timedOut) return;
            this.timedOutPending.delete(id);
            const reason = createCodexAppServerError(
              "codex_app_server_request_timeout",
              `Codex app-server late settlement expired: ${method}`,
              method,
              { requestId: id, processGeneration },
            );
            try {
              this.log("warn", "late settlement expired", () => ({
                code: "codex_app_server_late_settlement_expired",
                workspaceId: this.opts.workspaceId,
                requestId: id,
                method,
                processGeneration,
                ttlMs: CODEX_APP_SERVER_LATE_SETTLEMENT_TTL_MS,
              }), { reason });
            } catch (diagnosticError) {
              const failure = this.retainDiagnosticFailure(diagnosticError);
              timedOut.resolve({ status: "rejected", kind: "process_fault", reason: failure });
              onLateSettlementReleased?.();
              return;
            }
            timedOut.resolve({ status: "rejected", kind: "process_fault", reason });
            onLateSettlementReleased?.();
          }, CODEX_APP_SERVER_LATE_SETTLEMENT_TTL_MS);
          expiryTimer.unref?.();
          timedOut = { resolve: resolveLateSettlement, method, processGeneration, expiryTimer };
          this.timedOutPending.set(id, timedOut);
        }
        const err = createCodexAppServerError(
          "codex_app_server_request_timeout",
          `Codex app-server request timeout: ${method}`,
          method,
          { requestId: id, processGeneration },
        );
        if (lateSettlement) {
          err.lateSettlement = lateSettlement;
          err.releaseLateSettlement = () => {
            const timedOut = this.timedOutPending.get(id);
            if (timedOut) clearTimeout(timedOut.expiryTimer);
            this.timedOutPending.delete(id);
            onLateSettlementReleased?.();
          };
        }
        let diagnosticError: { reason: unknown } | null = null;
        try {
          this.opts.onRequestTimeout?.({
            requestId: id,
            method,
            elapsedMs: Date.now() - startedAt,
            timeoutMs,
            processGeneration,
            pendingMethods,
          });
        } catch (cause) { diagnosticError = { reason: cause }; }
        if (diagnosticError) {
          const aggregate = this.retainDiagnosticFailure(new AggregateError([err, diagnosticError.reason], err.message, { cause: err }));
          Object.assign(aggregate, { requestId: id, method, processGeneration,
            lateSettlement: err.lateSettlement, releaseLateSettlement: err.releaseLateSettlement });
          reject(aggregate);
        } else reject(err);
        if (method === "initialize" && this.child === child && this.processGeneration === processGeneration) {
          this.failWorkspace(err, {
            child,
            processGeneration,
            notifyThreads: true,
            killChild: true,
          });
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method, processGeneration });
      try {
        // stdout 与 RPC response 共用一条管道；控制请求在途时必须先解除通知背压。
        this.opts.resumeStdout?.();
        this.writeLine(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        const requestError = error instanceof Error ? error : new Error(String(error));
        // 尚未写出即已知传输失败，不保留永远无法结算的 late promise。
        if (resolveLateSettlement) {
          resolveLateSettlement({ status: "rejected", kind: "process_fault", reason: requestError });
          onLateSettlementReleased?.();
        }
        reject(requestError);
      }
    });
  }

  /** 发送 JSON-RPC notification（无返回）。 */
  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.notifyStarted(method, params);
  }

  /** 发送 JSON-RPC response（用于 requestApproval/requestUserInput 等）。 */
  async respond(id: unknown, result: unknown): Promise<void> {
    await this.ensureStarted();
    this.respondStarted(id, result);
  }

  /** 在 ready 进程代直接写出 notification。 */
  private notifyStarted(method: string, params?: unknown): void {
    const payload = params === undefined ? { method } : { method, params };
    this.opts.resumeStdout?.();
    this.writeLine(payload);
  }

  /** 在 ready 进程代直接回写 JSON-RPC response。 */
  private respondStarted(id: unknown, result: unknown): void {
    this.opts.resumeStdout?.();
    this.writeLine({ id, result });
  }

  /** 注册某 codex threadId 的消息处理器；旧注销句柄不得删除后注册的处理器。 */
  registerThread(threadId: string, onMessage: (msg: CodexAppServerMessage) => void): () => void {
    const tid = String(threadId ?? "").trim();
    if (!tid) throw new Error("Invalid threadId");
    const registration: ThreadHandlerRegistration = { owner: this, handler: onMessage };
    this.threadHandlers.set(tid, registration);
    return () => {
      const owner = registration.owner;
      if (owner.threadHandlers.get(tid) !== registration) return;
      owner.threadHandlers.delete(tid);
    };
  }

  /** 将现有 thread handler 迁移到替代 Workspace，避免单 thread 重启后丢失事件路由。 */
  transferThreadHandlersTo(target: CodexAppServerWorkspace): void {
    if (target === this) return;
    for (const [threadId, registration] of this.threadHandlers) {
      this.threadHandlers.delete(threadId);
      registration.owner = target;
      target.threadHandlers.set(threadId, registration);
    }
  }

  /** 异步请求终止 app-server 进程树并释放 Workspace；并发调用复用同一回收结果。 */
  kill(): Promise<void> {
    // 显式释放即永久封存旧 Workspace；即使复用故障回收也不能再次拉起进程。
    this.releaseRequested = true;
    const activeTermination = this.termination;
    if (activeTermination) return activeTermination.promise;
    const child = this.child;
    if (!child) {
      return this.terminationFailure
        ? Promise.reject(this.terminationFailure)
        : Promise.resolve();
    }
    const processGeneration = this.processGeneration;
    const error = createCodexAppServerError(
      "codex_app_server_closed",
      "Codex app-server stopped by CodeFlow",
    );
    const termination = this.terminateChild(
      child,
      processGeneration,
      "Codex app-server process tree termination failed",
    );
    this.settleWorkspaceFault(error, {
      child,
      processGeneration,
      notifyThreads: true,
      reportFault: false,
    });
    return termination;
  }

  /** 按实际 CLI 命令构造环境并启动工作区唯一的 app-server。 */
  private async start(): Promise<void> {
    const cli = resolveCodexCli();

    // 运行时配置以 Client DB 为准：Key 只注入当前子进程，provider/Base URL
    // 通过本次 app-server 的 -c 覆盖传入，避免启动时改写多个进程共享的 config.toml。
    // 没有运行时 resolver 时直接使用 Codex 原生 config/auth，保留独立运行能力。
    const runtimeConfig = this.opts.resolveCodexRuntimeConfig ? await this.opts.resolveCodexRuntimeConfig() : null;
    if (this.releaseRequested || this.termination) throw createCodexAppServerError("codex_app_server_closed", "Codex app-server stopped during runtime configuration");
    if (runtimeConfig?.credentialIdentity && !runtimeConfig.apiKey) throw Object.assign(new Error('内置中转凭据材料缺失'), { code: 'BUILT_IN_RELAY_REVALIDATION_REQUIRED' });
    const hasRuntimeResolver = Boolean(this.opts.resolveCodexRuntimeConfig);
    const codexCreds = hasRuntimeResolver ? (runtimeConfig ?? {}) : readEngineConfig("codex");
    const providerConfigArgs = hasRuntimeResolver
      ? buildCodexAppServerConfigArgs(runtimeConfig)
      : [];
    const env = buildClientChildProcessEnv(process.env, cli.command);
    // 清掉可能来自父进程的旧运行时 Key，避免跨 app-server 串 Key。
    delete env[CODEFLOWAI_CODEX_API_KEY_ENV];
    if (providerConfigArgs.length > 0) {
      // 托管 provider 明确只接受专用运行时变量，不回退到公共环境变量。
      delete env.OPENAI_API_KEY;
      if (codexCreds.apiKey) env[CODEFLOWAI_CODEX_API_KEY_ENV] = codexCreds.apiKey;
    }

    const child = spawn(cli.command, [...cli.argsPrefix, "app-server", ...providerConfigArgs], {
      cwd: this.opts.workspacePath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.processGeneration += 1;
    const processGeneration = this.processGeneration;

    const stdoutReader = new CodexAppServerLineReader(
      (line) => {
        if (this.child !== child || this.processGeneration !== processGeneration || this.faultedChildren.has(child)) return;
        this.onStdoutLine(line, child.stdout, child, processGeneration);
      },
      (limit) => this.failOversizedLine(child, processGeneration, "stdout", limit),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.processGeneration !== processGeneration) return;
      if (this.faultedChildren.has(child)) {
        stdoutReader.close();
        return;
      }
      try {
        stdoutReader.push(chunk);
      } catch (cause) {
        this.failOutputReader(child, processGeneration, "stdout", cause);
      }
    });
    const stderrReader = new CodexAppServerLineReader(
      (line) => {
        if (
          this.child !== child
          || this.processGeneration !== processGeneration
          || this.faultedChildren.has(child)
        ) return;
        const text = String(line ?? "");
        this.opts.onStderrLine?.(text);
        if (isFatalCodexAppServerStderrLine(text)) {
          const err = createCodexAppServerError(
            "codex_app_server_fatal",
            `Codex app-server fatal stderr: ${text.trim()}`,
          );
          this.failWorkspace(err, {
            child,
            processGeneration,
            notifyThreads: true,
            killChild: true,
          });
        }
      },
      (limit) => this.failOversizedLine(child, processGeneration, "stderr", limit),
    );
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child !== child || this.processGeneration !== processGeneration) return;
      if (this.faultedChildren.has(child)) {
        stderrReader.close();
        return;
      }
      try {
        stderrReader.push(chunk);
      } catch (cause) {
        this.failOutputReader(child, processGeneration, "stderr", cause);
      }
    });

    child.on("close", (code, signal) => {
      try { this.handleChildClose(child, processGeneration, code, signal); }
      catch (cause) { this.retainDiagnosticFailure(cause); }
      finally { stdoutReader.close(); stderrReader.close(); }
    });
    child.stdout.on("end", () => {
      try {
        stdoutReader.end();
      } catch (cause) {
        this.failOutputReader(child, processGeneration, "stdout", cause);
      }
    });
    child.stderr.on("end", () => {
      try {
        stderrReader.end();
      } catch (cause) {
        this.failOutputReader(child, processGeneration, "stderr", cause);
      }
    });

    child.on("error", (error) => {
      if (
        this.child !== child
        || this.processGeneration !== processGeneration
        || this.faultedChildren.has(child)
      ) return;
      const processError = createCodexAppServerError(
        "codex_app_server_process_error",
        `Codex app-server process error: ${error.message}`,
      );
      this.failWorkspace(processError, {
        child,
        processGeneration,
        notifyThreads: true,
        killChild: false,
      });
    });

    // initialize handshake（对齐 CodeMoss）；这里不能再调用 public request，避免等待自身 startPromise。
    await this.requestStarted("initialize", {
      clientInfo: this.opts.clientInfo,
      capabilities: { experimentalApi: true },
    }, { timeoutMs: 15_000 });
    this.notifyStarted("initialized");
  }

  /** Fails only the owning CodeFlow thread when the provider sends an unbounded JSON-RPC line. */
  private failOversizedLine(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    stream: "stdout" | "stderr",
    limit: CodexAppServerLineLimitError,
  ): void {
    const requestId = `codex-app-server:${child.pid ?? "unknown"}:${processGeneration}:${stream}`;
    const error = createCodexAppServerError(
      "codex_app_server_protocol_line_too_large",
      `Codex app-server ${stream} line exceeds limit: requestId=${requestId}, lineBytes=${limit.lineBytes}, maxLineBytes=${limit.maxLineBytes}`,
      "protocol-line",
      { requestId, processGeneration },
    );
    this.failWorkspace(error, {
      child,
      processGeneration,
      notifyThreads: true,
      killChild: true,
    });
  }

  /** Converts synchronous stream-decoder errors into an explicit workspace process fault. */
  private failOutputReader(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    stream: "stdout" | "stderr",
    cause: unknown,
  ): void {
    const requestId = `codex-app-server:${child.pid ?? "unknown"}:${processGeneration}:${stream}`;
    const error = createCodexAppServerError(
      "codex_app_server_process_error",
      `Codex app-server ${stream} stream parsing failed: requestId=${requestId}`,
      "protocol-line",
      { requestId, processGeneration },
    );
    Object.defineProperty(error, "cause", { value: cause, configurable: true });
    this.failWorkspace(error, {
      child,
      processGeneration,
      notifyThreads: true,
      killChild: true,
    });
  }

  /** 立即结算响应；thread 消息交给共享公平调度器，避免 stdout 洪峰占满主线程。 */
  private onStdoutLine(
    line: string,
    stdout?: Pick<NodeJS.ReadableStream, "pause" | "resume">,
    sourceChild: ChildProcessWithoutNullStreams | null = this.child,
    sourceGeneration: number = this.processGeneration,
  ): void {
    const msg = safeJson(line);
    if (!msg) return;

    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : null;
    const hasResultOrError = "result" in msg || "error" in msg;

    if (typeof id === "number" && hasResultOrError) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if ("error" in msg && msg.error) {
          pending.reject(createCodexAppServerRpcError(msg.error, pending.method, id));
        } else {
          pending.resolve((msg as any).result);
        }
        return;
      }
      const timedOut = this.timedOutPending.get(id);
      if (!timedOut) return;
      clearTimeout(timedOut.expiryTimer);
      this.timedOutPending.delete(id);
      if ("error" in msg && msg.error) {
        timedOut.resolve({
          status: "rejected",
          kind: "rpc_error",
          reason: createCodexAppServerRpcError(msg.error, timedOut.method, id),
        });
      } else {
        timedOut.resolve({ status: "fulfilled", value: (msg as any).result });
      }
      return;
    }

    if (!method) return;
    const run = () => this.dispatchThreadMessage(msg, method, sourceChild, sourceGeneration);
    if (!this.opts.scheduleThreadMessage) {
      run();
      return;
    }
    this.opts.scheduleThreadMessage({
      run,
      onFailure: cause => {
        this.retainDiagnosticFailure(cause, false);
        this.failOutputReader(sourceChild!, sourceGeneration, "stdout", cause);
      },
      bytes: Buffer.byteLength(line),
      ...(stdout
        ? {
            pause: () => stdout.pause(),
            resume: () => stdout.resume(),
            canPause: () => this.canPauseStdout(sourceChild, sourceGeneration),
          }
        : {}),
    });
  }

  /** 只有当前代没有控制 RPC 在途时才允许暂停 stdout 通知读取。 */
  private canPauseStdout(
    sourceChild: ChildProcessWithoutNullStreams | null,
    sourceGeneration: number,
  ): boolean {
    if (
      !sourceChild
      || this.child !== sourceChild
      || this.processGeneration !== sourceGeneration
    ) return false;
    for (const pending of this.pending.values()) {
      if (pending.processGeneration === sourceGeneration) return false;
    }
    // timeout 只结束本地等待；迟到响应仍需从同一 stdout 管道读出。
    for (const pending of this.timedOutPending.values()) {
      if (pending.processGeneration === sourceGeneration) return false;
    }
    return true;
  }

  /** 将当前进程代际的一条 thread 消息交给 handler；过期队列项不得影响新进程。 */
  private dispatchThreadMessage(
    msg: CodexAppServerMessage,
    method: string,
    sourceChild: ChildProcessWithoutNullStreams | null,
    sourceGeneration: number,
  ): void {
    if (
      !sourceChild
      || this.child !== sourceChild
      || this.processGeneration !== sourceGeneration
      || this.faultedChildren.has(sourceChild)
    ) return;
    const threadId = extractThreadId(msg);
    const registration = threadId ? this.threadHandlers.get(threadId) ?? null : null;
    if (!registration) {
      this.opts.onOrphanMessage?.(msg);
      return;
    }
    try {
      registration.handler(msg);
    } catch (cause) {
      const error = createCodexAppServerError(
        "codex_app_server_thread_handler_error",
        `Codex app-server thread handler failed: threadId=${threadId}, method=${method}`,
        method,
      );
      Object.defineProperty(error, "cause", { value: cause, configurable: true });
      this.failWorkspace(error, {
        child: sourceChild,
        processGeneration: sourceGeneration,
        notifyThreads: true,
        killChild: true,
      });
    }
  }

  private writeLine(value: unknown): void {
    if (this.terminationFailure) throw this.terminationFailure;
    const child = this.child;
    if (!child || this.termination || this.releaseRequested || this.faultedChildren.has(child)) {
      throw createCodexAppServerError(
        "codex_app_server_closed",
        "Codex app-server is not writable while stopping or faulted",
      );
    }
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /** 结算 root 自行退出的当前代运行态；未发现真实终止失败时允许后续重新拉起。 */
  private handleChildClose(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const alreadyFaulted = this.faultedChildren.has(child);
    const isCurrent = this.child === child && this.processGeneration === processGeneration;
    if (!isCurrent) return;
    if (alreadyFaulted) {
      this.releaseExitedProcessAfterTerminationFailure(child, processGeneration);
      return;
    }

    // 通知所有 thread：让 active turn 立即失败（避免只靠 turnTimeout 才收口）。
    const reason = signal ? `signal=${signal}` : `code=${code}`;
    const closeErr = createCodexAppServerError(
      "codex_app_server_closed",
      `Codex app-server closed (${reason})`,
      undefined,
      {
        requestId: `codex-app-server:${child.pid ?? "unknown"}:${processGeneration}:close`,
        processGeneration,
        processExit: { exitCode: code, signal, processGeneration, pid: child.pid },
      },
    );
    this.failWorkspace(closeErr, {
      child,
      processGeneration,
      notifyThreads: true,
      killChild: false,
    });
  }

  /** 同步收口 app-server 故障；需要时异步回收当前进程树并记录失败。 */
  private failWorkspace(
    error: CodexAppServerRuntimeError,
    opts: {
      child: ChildProcessWithoutNullStreams | null;
      processGeneration: number;
      notifyThreads: boolean;
      killChild: boolean;
      reportFault?: boolean;
    },
  ): void {
    const isCurrent = this.child === opts.child && this.processGeneration === opts.processGeneration;
    if (!isCurrent) return;
    if (!opts.child || !opts.killChild) {
      this.settleWorkspaceFault(error, opts);
      if (!this.isTerminating(opts.child, opts.processGeneration)) {
        this.clearCurrentProcess(opts.child, opts.processGeneration);
      }
      return;
    }
    const termination = this.terminateChild(
      opts.child,
      opts.processGeneration,
      "Codex app-server process tree termination failed after fault",
    );
    this.settleWorkspaceFault(error, opts);
    // 同一拒绝仍保留在 termination.promise/terminationFailure，供 kill 与后续准入显式消费。
    void termination.then(() => undefined, () => undefined);
  }

  /** 结算指定进程代际的请求与 thread handler，不执行进程终止。 */
  private settleWorkspaceFault(
    error: CodexAppServerRuntimeError,
    opts: {
      child: ChildProcessWithoutNullStreams | null;
      processGeneration: number;
      notifyThreads: boolean;
      reportFault?: boolean;
    },
  ): void {
    if (opts.child && this.faultedChildren.has(opts.child)) return;
    let diagnosticFailure: Error | null = null;
    if (opts.reportFault !== false) {
      try {
        this.opts.onProcessFault?.({
          code: error.code,
          message: error.message,
          method: error.method,
          requestId: error.requestId,
        });
      } catch (cause) { diagnosticFailure = this.retainDiagnosticFailure(new AggregateError([error, cause], error.message, { cause: error })); }
    }
    if (opts.child) this.faultedChildren.add(opts.child);

    for (const [requestId, p] of this.pending.entries()) {
      if (p.processGeneration !== opts.processGeneration) continue;
      clearTimeout(p.timeout);
      const requestError = createCodexAppServerError(error.code, error.message, p.method, {
        requestId,
        processGeneration: p.processGeneration,
        processExit: error.processExit,
      });
      requestError.requestOutcomeUnknown = true;
      p.reject(diagnosticFailure ?? requestError);
      this.pending.delete(requestId);
    }
    for (const [requestId, pending] of this.timedOutPending.entries()) {
      if (pending.processGeneration !== opts.processGeneration) continue;
      clearTimeout(pending.expiryTimer);
      pending.resolve({ status: "rejected", kind: "process_fault", reason: diagnosticFailure ?? cloneCodexAppServerError(error) });
      this.timedOutPending.delete(requestId);
    }

    if (opts.notifyThreads) {
      const msg = buildCodexAppServerFaultMessage(error);
      for (const registration of this.threadHandlers.values()) {
        try {
          registration.handler(msg);
        } catch (handlerError) {
          let failure: unknown = handlerError;
          try {
            this.opts.onProcessFault?.({
              code: error.code,
              message: "Codex app-server fault handler failed",
              method: error.method,
              requestId: error.requestId,
            });
          } catch (cause) { failure = new AggregateError([handlerError, cause], "Codex fault handler 与诊断均失败", { cause: handlerError }); }
          this.retainDiagnosticFailure(failure);
        }
      }
    }
  }

  /** 为当前 child 建立异步回收 singleflight；真实失败保留运行记录，root 已退出则释放旧代。 */
  private terminateChild(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    failureMessage: string,
  ): Promise<void> {
    const activeTermination = this.termination;
    if (
      activeTermination
      && activeTermination.child === child
      && activeTermination.processGeneration === processGeneration
    ) return activeTermination.promise;

    let resolveOperation!: () => void;
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.termination = { child, processGeneration, promise: operation };
    let processTermination: CodexProcessTreeTerminationHandle;
    try {
      // 终止门禁已建立；在同一调用栈启动异步回收，避免旧进程继续接收请求。
      processTermination = this.terminateProcessTree(child);
    } catch (cause) {
      processTermination = completedTermination(Promise.reject(cause));
    }
    let operationSettled = false;
    // 保留根因和显式恢复入口；调用方只序列化 message 时仍能定位回收失败。
    const buildFailure = (cause: unknown): CodexAppServerRuntimeError => {
      let reason = "process termination failed", rootCause = cause;
      try {
        const message = engineDiagnosticField(cause, "message");
        if (typeof message === "string") reason = redactClientStartupText(message);
        else if (typeof cause === "string") reason = redactClientStartupText(cause);
      } catch (descriptionError) { rootCause = new AggregateError([cause, descriptionError], "Codex 回收失败及描述均失败", { cause }); }
      return Object.assign(new Error(
        `${failureMessage}: pid=${Number(child.pid ?? 0) || "unknown"}; ${reason}。请在会话菜单选择“重启 Codex”后重试。`,
        { cause: rootCause },
      ), {
        code: "codex_app_server_process_tree_termination_failed" as const,
        requestId: `codex-app-server:${child.pid ?? "unknown"}:${processGeneration}:termination`,
        processGeneration,
        terminationKind: "error" as const,
      });
    };
    void processTermination.outcome.then(
      () => undefined,
      (cause) => {
        const outcomeFailure = buildFailure(cause);
        if (this.termination?.promise === operation) {
          this.terminationFailure = this.terminationFailure && isEngineWorkspaceLogFailure(this.terminationFailure)
            ? this.retainDiagnosticFailure(outcomeFailure) : outcomeFailure;
        }
        if (operationSettled) return;
        operationSettled = true;
        rejectOperation(this.reportTerminationFailure(this.terminationFailure ?? outcomeFailure));
      },
    );
    const settleCompletion = (completion: CodexProcessTreeTerminationCompletion) => {
      if (completion.status === "confirmed" || completion.status === "unconfirmed") {
        if (completion.status === "unconfirmed") {
          try { this.log("warn", "process tree termination unconfirmed", () => ({
            code: "codex_app_server_process_tree_termination_unconfirmed",
            workspaceId: this.opts.workspaceId,
            pid: Number(child.pid ?? 0) || null,
            processGeneration,
            exitCode: child.exitCode ?? null,
            signalCode: child.signalCode ?? null,
            reason: completion.reason,
          })); } catch (cause) { this.retainDiagnosticFailure(cause); }
        }
        if (this.termination?.promise === operation) {
          this.termination = null;
          if (!isEngineWorkspaceLogFailure(this.terminationFailure)) this.terminationFailure = null;
          this.clearCurrentProcess(child, processGeneration);
        }
        if (!operationSettled) {
          operationSettled = true;
          if (this.terminationFailure) rejectOperation(this.terminationFailure);
          else resolveOperation();
        }
        return;
      }
      // completion 是 helper 生命周期的最终真相；迟到失败应保留 code/signal/output。
      const failure = buildFailure(completion.error);
      failure.processTreeHelperExited = completion.helperExited === true;
      if (this.termination?.promise === operation) {
        this.termination = null;
        if (isEngineWorkspaceLogFailure(this.terminationFailure)) this.retainDiagnosticFailure(failure);
        else this.terminationFailure = failure;
        try { this.releaseExitedProcessAfterTerminationFailure(child, processGeneration); }
        catch (cause) { this.retainDiagnosticFailure(cause); }
      }
      if (!operationSettled) {
        operationSettled = true;
        rejectOperation(this.reportTerminationFailure(this.terminationFailure ?? failure));
      }
    };
    void processTermination.completion.then(
      settleCompletion,
      (cause) => settleCompletion({
        status: "failed",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      }),
    );
    return operation;
  }

  /** 用户已确认：helper 与原 child 均退出后允许下一轮续聊；子树未确认保留日志供人工排查清理，禁止重杀旧 PID。 */
  private releaseExitedProcessAfterTerminationFailure(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
  ): void {
    const failure = this.terminationFailure;
    if (this.child !== child || this.processGeneration !== processGeneration || this.termination
      || !failure?.processTreeHelperExited || !childHasExited(child)) return;
    this.log("warn", "process tree termination unconfirmed after root exit", () => ({
      code: "codex_app_server_process_tree_termination_unconfirmed",
      requestId: failure.requestId,
      workspaceId: this.opts.workspaceId,
      pid: child.pid,
      processGeneration,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      rootCause: engineDiagnosticCause(failure.cause),
      recovery: "allow_next_request_after_root_exit",
      descendantsTermination: "unconfirmed",
    }), { reason: failure });
    this.terminationFailure = null;
    this.clearCurrentProcess(child, processGeneration);
  }

  /** 判断当前代 child 是否仍由异步终止器持有。 */
  private isTerminating(
    child: ChildProcessWithoutNullStreams | null,
    processGeneration: number,
  ): boolean {
    return Boolean(
      child
      && this.termination?.child === child
      && this.termination.processGeneration === processGeneration,
    );
  }

  /** 仅在 child 与进程代际仍匹配时清理当前运行态。 */
  private clearCurrentProcess(child: ChildProcessWithoutNullStreams | null, processGeneration: number): void {
    if (this.child !== child || this.processGeneration !== processGeneration) return;
    this.child = null;
    this.startPromise = null;
  }

  /** 异步终止当前 child 及其后代；测试可注入替身。 */
  private terminateProcessTree(child: ChildProcessWithoutNullStreams): CodexProcessTreeTerminationHandle {
    if (this.opts.terminateProcessTree) {
      return normalizeTerminationHandle(this.opts.terminateProcessTree(child));
    }
    return terminateCodexProcessTree(child);
  }

  /** 固定进程所属 W 写日志，描述与 writer 失败交给调用处的原请求或终止 owner。 */
  private log(level: WorkspaceLogEntry["level"], message: string, data: () => Record<string, unknown>, business?: { reason: unknown }): void {
    writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, this.opts.workspaceId, () => ({ level, tag: "codex-app-server", message,
      data: { threadId: this.opts.localThreadId, ...data() } }), business);
  }

  /** 诊断边界保留聚合日志标记；分发边界显式传false，保留原业务错误分类。 */
  private retainDiagnosticFailure(cause: unknown, diagnostic = true): Error {
    const previous = this.terminationFailure;
    const failure = diagnostic
      ? isEngineWorkspaceLogFailure(cause) ? cause as Error : createEngineWorkspaceLogFailure(cause)
      : cause instanceof Error ? cause : new Error("Codex 输出分发失败", { cause });
    if (previous && previous !== failure) {
      const aggregate = new AggregateError([previous, failure], "Codex 进程异步处理失败", { cause: previous });
      this.terminationFailure = isEngineWorkspaceLogFailure(previous) || isEngineWorkspaceLogFailure(failure)
        ? createEngineWorkspaceLogFailure(aggregate) : aggregate;
    } else this.terminationFailure = failure;
    return this.terminationFailure;
  }

  /** 异步回收只在此处翻译诊断回调失败，不产生无人观察的拒绝。 */
  private reportTerminationFailure(failure: unknown, method?: string): Error {
    if (isEngineWorkspaceLogFailure(failure)) return failure as Error;
    try {
      this.opts.onProcessFault?.({ code: "codex_app_server_process_tree_termination_failed",
        message: failure instanceof Error ? failure.message : "Codex process termination failed", method,
        requestId: failure && typeof failure === "object" ? Object.getOwnPropertyDescriptor(failure, "requestId")?.value : undefined });
    } catch (cause) { return this.retainDiagnosticFailure(new AggregateError([failure, cause], "Codex 进程回收和诊断均失败", { cause: failure })); }
    return failure instanceof Error ? failure : new Error("Codex process termination failed", { cause: failure });
  }
}

/** 将普通异步终止器适配为同时描述调用结果与 helper 生命周期的句柄。 */
function normalizeTerminationHandle(
  termination: Promise<void> | CodexProcessTreeTerminationHandle,
): CodexProcessTreeTerminationHandle {
  if (
    termination
    && typeof termination === "object"
    && "outcome" in termination
    && "completion" in termination
  ) return termination;
  return completedTermination(Promise.resolve(termination));
}

/** 为没有独立 helper 生命周期的终止器生成已绑定的完成结果。 */
function completedTermination(outcome: Promise<void>): CodexProcessTreeTerminationHandle {
  return {
    outcome,
    completion: outcome.then<CodexProcessTreeTerminationCompletion, CodexProcessTreeTerminationCompletion>(
      () => ({ status: "confirmed" }),
      (cause) => ({
        status: "failed",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      }),
    ),
  };
}

/** Windows 异步使用 taskkill /T 回收包装器、原生 codex 与工具子进程。 */
export function terminateCodexProcessTree(
  child: ChildProcessWithoutNullStreams,
  options: CodexProcessTreeTerminationOptions = {},
): CodexProcessTreeTerminationHandle {
  const platform = options.platform ?? process.platform;
  const pid = Number(child.pid ?? 0);
  if (platform !== "win32") {
    if (childHasExited(child)) return completedTermination(Promise.resolve());
    let outcome: Promise<void>;
    try {
      const signaled = child.kill("SIGTERM");
      outcome = !signaled && isProcessAlive(pid)
        ? Promise.reject(new Error(`Codex app-server process did not accept SIGTERM: pid=${pid || "unknown"}`))
        : Promise.resolve();
    } catch (cause) {
      outcome = Promise.reject(cause);
    }
    return completedTermination(outcome);
  }
  if (childHasExited(child)) {
    const completion: CodexProcessTreeTerminationCompletion = {
      status: "unconfirmed",
      reason: `Codex app-server root process already exited; descendant process tree termination is unconfirmed: pid=${pid || "unknown"}, exitCode=${child.exitCode ?? "null"}, signalCode=${child.signalCode ?? "null"}`,
    };
    return { outcome: Promise.resolve(), completion: Promise.resolve(completion) };
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return completedTermination(Promise.reject(
      new Error("Codex app-server PID is unavailable; process tree termination is unconfirmed"),
    ));
  }

  const systemRoot = String(options.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? "").trim();
  if (!systemRoot) {
    return completedTermination(Promise.reject(
      new Error(`Windows system root is missing; cannot terminate Codex process tree: pid=${pid}`),
    ));
  }
  const taskkillPath = path.join(systemRoot, "System32", "taskkill.exe");
  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = normalizePositiveTimeout(options.timeoutMs, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
  const stopGraceMs = normalizePositiveTimeout(options.stopGraceMs, TASKKILL_STOP_GRACE_MS);

  let resolveOutcome!: () => void;
  let rejectOutcome!: (error: Error) => void;
  const outcome = new Promise<void>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  let resolveCompletion!: (completion: CodexProcessTreeTerminationCompletion) => void;
  const completion = new Promise<CodexProcessTreeTerminationCompletion>((resolve) => {
    resolveCompletion = resolve;
  });
  let outcomeSettled = false;
  let completionSettled = false;
  let terminationTimeout: NodeJS.Timeout | null = null;
  let stopGraceTimeout: NodeJS.Timeout | null = null;
  let helperLifecycleTimeout: NodeJS.Timeout | null = null;
  let helperExitFallbackTimeout: NodeJS.Timeout | null = null;
  let timeoutFailure: Error | null = null;
  let helperError: Error | null = null;
  let helperExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const settleOutcome = (error?: Error) => {
    if (outcomeSettled) return;
    outcomeSettled = true;
    if (error) rejectOutcome(error);
    else resolveOutcome();
  };
  const settleCompletion = (result: CodexProcessTreeTerminationCompletion) => {
    if (completionSettled) return;
    completionSettled = true;
    if (terminationTimeout) clearTimeout(terminationTimeout);
    if (stopGraceTimeout) clearTimeout(stopGraceTimeout);
    if (helperLifecycleTimeout) clearTimeout(helperLifecycleTimeout);
    if (helperExitFallbackTimeout) clearTimeout(helperExitFallbackTimeout);
    resolveCompletion(result);
  };

  let taskkill: ReturnType<typeof spawn>;
  try {
    taskkill = spawnProcess(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (cause) {
    const failure = new Error(`taskkill spawn failed: pid=${pid}`, { cause });
    settleOutcome(failure);
    settleCompletion({ status: "failed", error: failure });
    return { outcome, completion };
  }
  taskkill.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes = appendBoundedOutput(stdout, stdoutBytes, chunk);
  });
  taskkill.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes = appendBoundedOutput(stderr, stderrBytes, chunk);
  });
  taskkill.on("error", (cause) => {
    helperError = cause instanceof Error ? cause : new Error(String(cause));
    if (!timeoutFailure) {
      const failure = new Error(`taskkill helper error: pid=${pid}`, { cause: helperError });
      settleOutcome(failure);
      if (!Number.isSafeInteger(Number(taskkill.pid ?? 0)) || Number(taskkill.pid ?? 0) <= 0) {
        settleCompletion({ status: "failed", error: failure });
      }
    }
  });
  terminationTimeout = setTimeout(() => {
    timeoutFailure = new Error(
      `taskkill timed out after ${timeoutMs}ms; process tree termination is unconfirmed: pid=${pid}`,
    );
    if (!processHasExited(taskkill)) {
      const signalError = tryStopTaskkill(taskkill);
      if (signalError) {
        timeoutFailure = new Error(`${timeoutFailure.message}, taskkillStopError=${signalError}`);
      }
    }
    stopGraceTimeout = setTimeout(() => {
      const helperContext = helperError ? `, taskkillHelperError=${helperError.message}` : "";
      const failure = new Error(
        `${timeoutFailure!.message}${helperContext}, taskkillStopGraceExpiredMs=${stopGraceMs}`,
      );
      settleOutcome(failure);
      if (helperExit || processHasExited(taskkill)) {
        settleHelperResult(
          helperExit?.code ?? taskkill.exitCode,
          helperExit?.signal ?? taskkill.signalCode,
        );
        return;
      }
      // 再保留一个短窗口接收迟到 close；仍无生命周期事件时有界失败，允许显式重试。
      helperLifecycleTimeout = setTimeout(() => {
        settleCompletion({
          status: "failed",
          error: new Error(`${failure.message}, taskkillHelperLifecycle=unconfirmed`),
        });
      }, stopGraceMs);
      helperLifecycleTimeout.unref?.();
    }, stopGraceMs);
    stopGraceTimeout.unref?.();
  }, timeoutMs);
  terminationTimeout.unref?.();
  /** 根据 helper 最终退出结果收口；零退出码是唯一整树成功证据。 */
  const settleHelperResult = (code: number | null, signal: NodeJS.Signals | null) => {
    if (timeoutFailure && !outcomeSettled) return;
    // /T /F 的零退出码是完整进程树回收的权威结果，避免裸 PID 复用误判。
    if (code === 0 && signal == null) {
      settleOutcome();
      settleCompletion({ status: "confirmed" });
      return;
    }
    const output = readTerminationOutput(stderr, stdout);
    const timeoutContext = timeoutFailure ? `${timeoutFailure.message}; ` : "";
    const helperContext = helperError ? `; helperError=${helperError.message}` : "";
    const failure = new Error(
      `${timeoutContext}taskkill did not confirm process tree termination: pid=${pid}, code=${code ?? "null"}, signal=${signal ?? "null"}, detail=${output || "empty"}${helperContext}`,
    );
    settleOutcome(failure);
    settleCompletion({ status: "failed", error: failure, helperExited: true });
  };
  taskkill.on("exit", (code, signal) => {
    helperExit = { code, signal };
    // 正常等 close 让 stdout/stderr 先排空；close 丢失时再有界回落到 exit 结果。
    helperExitFallbackTimeout = setTimeout(() => settleHelperResult(code, signal), stopGraceMs);
    helperExitFallbackTimeout.unref?.();
  });
  taskkill.on("close", (code, signal) => {
    settleHelperResult(code, signal);
  });
  return { outcome, completion };
}

/** 追加有界 taskkill 输出，避免异常 helper 持续输出占用内存。 */
function appendBoundedOutput(chunks: Buffer[], currentBytes: number, chunk: Buffer): number {
  const remaining = Math.max(0, 4_096 - currentBytes);
  if (remaining === 0) return currentBytes;
  const captured = chunk.subarray(0, remaining);
  chunks.push(captured);
  return currentBytes + captured.length;
}

/** 优先读取 stderr，并截断为可检索的单行终止上下文。 */
function readTerminationOutput(stderr: Buffer[], stdout: Buffer[]): string {
  return Buffer.concat(stderr.length > 0 ? stderr : stdout).toString("utf8").trim().slice(0, 500);
}

/** 将可配置超时规范化为正整数毫秒。 */
function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 超时后停止 taskkill 包装进程；错误作为终止失败上下文返回。 */
function tryStopTaskkill(taskkill: ReturnType<typeof spawn>): string | null {
  try {
    return taskkill.kill() ? null : "taskkill.kill() returned false";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 判断原始 child 是否已经由操作系统结算，禁止对旧 PID 再执行 taskkill。 */
function childHasExited(child: ChildProcessWithoutNullStreams): boolean {
  return processHasExited(child);
}

/** 判断任意 ChildProcess 是否已经由操作系统结算。 */
function processHasExited(child: Pick<ReturnType<typeof spawn>, "exitCode" | "signalCode">): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** 检查 PID 是否仍存在；权限错误按存活处理。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return String((error as NodeJS.ErrnoException)?.code ?? "") !== "ESRCH";
  }
}

function safeJson(line: string): CodexAppServerMessage | null {
  try {
    const v = JSON.parse(String(line ?? ""));
    if (typeof v === "object" && v) return v as CodexAppServerMessage;
    return null;
  } catch {
    return null;
  }
}

/** 为恢复请求生成不抛异常的参数键；异常参数只会失去去重，不影响 RPC 本身。 */
function safeStableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function extractThreadId(msg: CodexAppServerMessage): string | null {
  const params = (msg.params ?? null) as Record<string, unknown> | null;
  if (!params) return null;
  const direct = String((params as any).threadId ?? (params as any).thread_id ?? "").trim();
  if (direct) return direct;
  const turn = (params as any).turn as Record<string, unknown> | null;
  const fromTurn = turn ? String((turn as any).threadId ?? (turn as any).thread_id ?? "").trim() : "";
  if (fromTurn) return fromTurn;
  const fromThread = (params as any).thread as Record<string, unknown> | null;
  const nested = fromThread ? String((fromThread as any).id ?? "").trim() : "";
  return nested || null;
}

type CodexAppServerRuntimeError = Error & {
  code: CodexAppServerFaultCode;
  method?: string;
  requestId?: string | number;
  processGeneration?: number;
  processTreeHelperExited?: boolean;
  processExit?: { exitCode: number | null; signal: NodeJS.Signals | null; processGeneration: number; pid?: number };
  requestOutcomeUnknown?: boolean;
  lateSettlement?: Promise<CodexAppServerLateSettlement>;
  releaseLateSettlement?: () => void;
  terminationKind: "error";
};

type CodexAppServerRpcError = Error & {
  rpcError: true;
  method: string;
  requestId: number;
  terminationKind: "error";
};

/** 判断 stderr 是否代表 app-server 已不可继续服务。 */
export function isFatalCodexAppServerStderrLine(line: string): boolean {
  const normalized = String(line ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (/memory allocation of \d+ bytes failed/.test(normalized)) return true;
  if (normalized.includes("fatal runtime error")) return true;
  if (normalized.includes("panicked at")) return true;
  return false;
}

/** 构造可序列化到 turn.error 的 app-server 运行时错误。 */
function createCodexAppServerError(
  code: CodexAppServerFaultCode,
  message: string,
  method?: string,
  context?: {
    requestId?: string | number;
    processGeneration?: number;
    processExit?: CodexAppServerRuntimeError["processExit"];
  },
): CodexAppServerRuntimeError {
  const error = new Error(message) as CodexAppServerRuntimeError;
  error.code = code;
  error.terminationKind = "error";
  if (method) error.method = method;
  if (context?.requestId != null) error.requestId = context.requestId;
  if (context?.processGeneration != null) error.processGeneration = context.processGeneration;
  if (context?.processExit) error.processExit = { ...context.processExit };
  return error;
}

/** 标记 provider 返回的 JSON-RPC error，避免与 transport/process fault 混淆。 */
function createCodexAppServerRpcError(payload: unknown, method: string, requestId: number): CodexAppServerRpcError {
  const message = String((payload as any)?.message ?? payload);
  return Object.assign(new Error(message), {
    rpcError: true as const,
    method,
    requestId,
    terminationKind: "error" as const,
  });
}

/** 克隆错误，避免同一个 Error 实例被多处异步链路共享修改。 */
function cloneCodexAppServerError(error: CodexAppServerRuntimeError): CodexAppServerRuntimeError {
  const cloned = createCodexAppServerError(error.code, error.message, error.method, {
    requestId: error.requestId,
    processGeneration: error.processGeneration,
    processExit: error.processExit,
  });
  if (error.requestOutcomeUnknown) cloned.requestOutcomeUnknown = true;
  return cloned;
}

/** 转为 app-server message，使 thread session 走统一 provider error 映射。 */
function buildCodexAppServerFaultMessage(error: CodexAppServerRuntimeError): CodexAppServerMessage {
  return {
    method: "error",
    params: {
      error: {
        message: error.message,
        code: error.code,
        requestId: error.requestId ?? null,
        processGeneration: error.processGeneration ?? null,
        ...(error.processExit ? { processExit: { ...error.processExit } } : {}),
      },
    },
  };
}

