import crypto from "node:crypto";
import type {
  HostRpcHttpResultMessage,
  HostRpcHttpResultRequest,
  HostRpcHttpTask,
} from "@codeflowai/shared";

const DEFAULT_POLL_WAIT_MS = 30_000;
const POLL_REQUEST_TIMEOUT_MS = 40_000;
const RESULT_REQUEST_TIMEOUT_MS = 8_000;
const MAX_RETRY_DELAY_MS = 10_000;
const LEGACY_SESSION_CONFLICT_RETRY_LIMIT = 3;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_SLOW_TASK_THRESHOLD_MS = 5_000;
const ERROR_RESPONSE_CODE_SCAN_LIMIT_BYTES = 64 * 1024;
const TASK_RESPONSE_BODY_LIMIT_BYTES = 64 * 1024 * 1024;
const ERROR_MESSAGE_HASH_LIMIT_CODE_UNITS = 16 * 1024;
const HOST_RPC_DIAGNOSTIC_ERROR_CODE = {
  transport: "HOST_RPC_HTTP_TRANSPORT_STOPPED",
  poll: "HOST_RPC_HTTP_POLL_FAILED",
  handler: "HOST_RPC_HTTP_HANDLER_FAILED",
  validation: "HOST_RPC_HTTP_RESULT_INVALID",
  serialization: "HOST_RPC_HTTP_RESULT_SERIALIZATION_FAILED",
  post: "HOST_RPC_HTTP_RESULT_POST_FAILED",
} as const;
const SAFE_RESPONSE_ERROR_CODES = new Set([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "HOST_RPC_OPERATION_GONE",
  "HOST_RPC_POLL_CONFLICT",
  "HOST_RPC_SESSION_MISMATCH",
  "HOST_RPC_CLIENT_UNAVAILABLE",
  "HOST_RPC_CAPABILITY_REQUIRED",
]);
const SAFE_ERROR_CONTENT_TYPES = new Set([
  "application/json",
  "application/problem+json",
  "application/octet-stream",
  "text/html",
  "text/plain",
]);
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "Error",
  "HostRpcHttpFatalError",
  "HostRpcHttpResponseError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
]);
const SAFE_EXTERNAL_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type FetchLike = typeof fetch;

export type HostRpcHttpTransportEvents = {
  onDiagnostic?: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  onFatal?: (error: Error) => void;
  /** 当前 session 已失效时由 WS owner 重新握手，禁止在旧 session 上无限重试。 */
  onSessionInvalidated?: () => void;
};

export type HostRpcHttpTransportOptions = {
  serverWsUrl: string;
  apiKey: string;
  clientId: string;
  execute: (task: HostRpcHttpTask) => Promise<HostRpcHttpResultMessage[]>;
  events?: HostRpcHttpTransportEvents;
  fetchImpl?: FetchLike;
  pollWaitMs?: number;
  retryBaseMs?: number;
  maxConcurrency?: number;
  pollRequestTimeoutMs?: number;
  resultRequestTimeoutMs?: number;
  slowTaskThresholdMs?: number;
};

type HostRpcHttpErrorResponseMetadata = {
  status: number;
  responseErrorCode: string | null;
  contentType: string | null;
  bodyBytesRead: number;
  bodyTruncated: boolean;
  bodyPrefixHash: string;
};

type BoundedResponseBody = {
  bytes: Buffer;
  bodyBytesRead: number;
  bodyTruncated: boolean;
  bodyPrefixHash: string;
};

class HostRpcHttpFatalError extends Error {
  /** 构造不可重试错误，并只附带经过筛选的响应元数据。 */
  constructor(message: string, readonly responseMetadata: HostRpcHttpErrorResponseMetadata | null = null) {
    super(message);
    this.name = "HostRpcHttpFatalError";
  }
}

class HostRpcHttpResponseError extends Error {
  /** 构造可重试响应错误，不保留原始响应正文。 */
  constructor(message: string, readonly responseMetadata: HostRpcHttpErrorResponseMetadata) {
    super(message);
    this.name = "HostRpcHttpResponseError";
  }
}

class HostRpcHttpRequestTimeoutError extends Error {
  constructor() {
    super("Host RPC HTTP request timed out");
    this.name = "TimeoutError";
  }
}

type LeasedHostRpcHttpTask = {
  task: HostRpcHttpTask;
  sessionId: string;
};

type HostRpcTaskDiagnosticContext = {
  hostRpcOperationId: string;
  requestId: string | null;
  sharedWorkspaceOperationId: string | null;
  routeEventId: string | null;
  method: string | null;
  operationKey: string | null;
  workspaceId: string | null;
  queueMs: number | null;
};

type HostRpcTaskActivePhase = "handler" | "serialize" | "post";

type HostRpcTaskTimingState = {
  taskStartedAt: number;
  handlerStartedAt: number;
  handlerMs: number | null;
  serializeStartedAt: number | null;
  serializeMs: number | null;
  postStartedAt: number | null;
  postMs: number | null;
  postAttempts: number;
  resultBytes: number | null;
  activePhase: HostRpcTaskActivePhase;
  finished: boolean;
};

type HostRpcTaskDiagnosticData = HostRpcTaskDiagnosticContext & {
  phase: "in_progress" | "complete";
  outcome: "in_progress" | "accepted" | "gone" | "failed";
  activePhase: HostRpcTaskActivePhase;
  handlerMs: number;
  serializeMs: number;
  resultBytes: number;
  postMs: number;
  postAttempts: number;
  clientTotalMs: number;
  totalMs: number;
};

type HostRpcTaskTimingData = Omit<HostRpcTaskDiagnosticData, "phase" | "outcome">;

type RetryWaiter = {
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
};

/** 单 poll 领取只读 Host RPC，并用有界 worker 并发执行；结果提交失败不重复执行命令。 */
export class HostRpcHttpTransport {
  private readonly httpBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly pollWaitMs: number;
  private readonly retryBaseMs: number;
  private readonly maxConcurrency: number;
  private readonly pollRequestTimeoutMs: number;
  private readonly resultRequestTimeoutMs: number;
  private readonly slowTaskThresholdMs: number;
  private running = false;
  private stopped = true;
  private runPromise: Promise<void> | null = null;
  private readonly activeRequests = new Set<AbortController>();
  private readonly retryWaiters = new Set<RetryWaiter>();
  private readonly activeSlowTaskMonitorStops = new Set<() => void>();
  private sessionId: string | null = null;

  constructor(private readonly opts: HostRpcHttpTransportOptions) {
    this.httpBase = toHttpBaseFromWsUrl(opts.serverWsUrl);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollWaitMs = Math.max(1_000, Math.min(30_000, Math.floor(opts.pollWaitMs ?? DEFAULT_POLL_WAIT_MS)));
    this.retryBaseMs = Math.max(10, Math.floor(opts.retryBaseMs ?? 500));
    this.maxConcurrency = resolveMaxConcurrency(opts.maxConcurrency);
    this.pollRequestTimeoutMs = resolveRequestTimeout(opts.pollRequestTimeoutMs, POLL_REQUEST_TIMEOUT_MS);
    this.resultRequestTimeoutMs = resolveRequestTimeout(opts.resultRequestTimeoutMs, RESULT_REQUEST_TIMEOUT_MS);
    this.slowTaskThresholdMs = resolveSlowTaskThreshold(opts.slowTaskThresholdMs);
  }

  /** 启动唯一 long-poll 循环；连接代际变化时中止旧请求并切换 session。 */
  start(sessionId: string): void {
    const normalizedSessionId = String(sessionId ?? "").trim();
    if (!normalizedSessionId) throw new HostRpcHttpFatalError("Host RPC HTTP session id is required");
    const sessionChanged = this.sessionId !== normalizedSessionId;
    this.sessionId = normalizedSessionId;
    if (this.running) {
      if (sessionChanged) {
        this.abortActiveRequests();
        this.releaseRetryWaiters();
      }
      return;
    }
    this.stopped = false;
    this.running = true;
    this.runPromise = this.run().catch((error) => {
      const normalized = toSafeFatalError(error);
      this.opts.events?.onDiagnostic?.("error", "Host RPC HTTP transport stopped", {
        phase: "transport",
        errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.transport,
        ...safeErrorDiagnosticData(error),
      });
      this.opts.events?.onFatal?.(normalized);
    }).finally(() => {
      this.running = false;
      this.runPromise = null;
    });
  }

  /** 停止领取新命令，清理慢任务监视器并取消当前 HTTP 请求。 */
  stop(): void {
    this.stopped = true;
    for (const stopMonitor of this.activeSlowTaskMonitorStops) stopMonitor();
    this.abortActiveRequests();
    this.releaseRetryWaiters();
  }

  /** 停止领取并等待已领取命令完成，供 Client 在关闭 DB 前排空。 */
  async stopAndDrain(): Promise<void> {
    const running = this.runPromise;
    this.stop();
    if (running) await running;
  }

  /** 返回当前循环状态，供诊断和定向测试使用。 */
  isRunning(): boolean {
    return this.running;
  }

  /** 保持单 poll；旧请求中断不延迟新 session，旧版连续 409 交由 WS owner 恢复。 */
  private async run(): Promise<void> {
    const workers = new Set<Promise<void>>();
    let workerFailure: Error | null = null;
    let primaryFailure: Error | null = null;
    let signalWorkerFailure!: (error: Error) => void;
    const workerFailureSignal = new Promise<Error>((resolve) => {
      signalWorkerFailure = resolve;
    });
    let pollRetryAttempt = 0;
    let legacySessionConflictAttempts = 0;
    try {
      while (!this.stopped) {
        if (workerFailure) throw workerFailure;
        if (!this.sessionId) {
          await this.waitBeforeRetry(1);
          continue;
        }
        if (workers.size >= this.maxConcurrency) {
          await Promise.race(workers);
          continue;
        }

        const pollSessionId = this.sessionId;
        let leased: LeasedHostRpcHttpTask | null;
        try {
          leased = await this.fetchNextTask();
          pollRetryAttempt = 0;
          legacySessionConflictAttempts = 0;
        } catch (error) {
          if (workerFailure && isAbortError(error)) break;
          if (this.stopped && isAbortError(error)) break;
          if (pollSessionId !== this.sessionId && isAbortError(error)) {
            pollRetryAttempt = 0;
            legacySessionConflictAttempts = 0;
            continue;
          }
          if (error instanceof HostRpcHttpFatalError) {
            this.opts.events?.onDiagnostic?.("error", "Host RPC poll failed", {
              phase: "poll",
              errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.poll,
              ...safeErrorDiagnosticData(error),
            });
            throw error;
          }
          pollRetryAttempt += 1;
          this.opts.events?.onDiagnostic?.("warn", "Host RPC poll failed", {
            phase: "poll",
            errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.poll,
            attempt: pollRetryAttempt,
            ...safeErrorDiagnosticData(error),
          });
          if (pollSessionId !== this.sessionId) {
            pollRetryAttempt = 0;
            legacySessionConflictAttempts = 0;
            continue;
          }
          legacySessionConflictAttempts = error instanceof HostRpcHttpResponseError && isLegacySessionConflict(error.responseMetadata)
            ? legacySessionConflictAttempts + 1 : 0;
          if (legacySessionConflictAttempts >= LEGACY_SESSION_CONFLICT_RETRY_LIMIT && error instanceof HostRpcHttpResponseError) {
            this.invalidateSession(error.responseMetadata, "poll");
            pollRetryAttempt = 0;
            legacySessionConflictAttempts = 0;
            continue;
          }
          await this.waitBeforeRetry(pollRetryAttempt);
          if (pollSessionId !== this.sessionId) {
            pollRetryAttempt = 0;
            legacySessionConflictAttempts = 0;
          }
          continue;
        }
        if (!leased || leased.sessionId !== this.sessionId) continue;
        if (this.stopped) break;
        if (workerFailure) throw workerFailure;

        let worker!: Promise<void>;
        worker = this.executeLeasedTask(leased).catch((error) => {
          if (!workerFailure) {
            workerFailure = toSafeFatalError(error);
            signalWorkerFailure(workerFailure);
          }
          this.stop();
        }).finally(() => {
          workers.delete(worker);
        });
        workers.add(worker);
      }
    } catch (error) {
      primaryFailure = toSafeFatalError(error);
      this.stop();
    } finally {
      this.abortActiveRequests();
      this.releaseRetryWaiters();
      const drain = Promise.allSettled(workers);
      if (!primaryFailure && !workerFailure) {
        const signaledFailure = await Promise.race([
          drain.then(() => null),
          workerFailureSignal,
        ]);
        workerFailure ??= signaledFailure;
      }
      if (!primaryFailure && !workerFailure) await drain;
    }
    const failure = primaryFailure ?? workerFailure;
    if (failure) throw failure;
  }

  /** 任务仅执行一次；旧 session 的提交中断直接收口，不重建退避占用处理名额。 */
  private async executeLeasedTask(leased: LeasedHostRpcHttpTask): Promise<void> {
    const context = buildTaskDiagnosticContext(leased.task);
    const taskStartedAt = performance.now();
    const timing: HostRpcTaskTimingState = {
      taskStartedAt,
      handlerStartedAt: taskStartedAt,
      handlerMs: null,
      serializeStartedAt: null,
      serializeMs: null,
      postStartedAt: null,
      postMs: null,
      postAttempts: 0,
      resultBytes: null,
      activePhase: "handler",
      finished: false,
    };
    const stopSlowTaskMonitor = this.startSlowTaskMonitor(context, timing);
    try {
      let messages: HostRpcHttpResultMessage[];
      try {
        messages = await this.opts.execute(leased.task);
      } catch (error) {
        timing.handlerMs = elapsedMs(timing.handlerStartedAt);
        const timingData = buildTaskTimingData(context, timing);
        this.opts.events?.onDiagnostic?.("error", "Host RPC handler failed", {
          ...timingData,
          phase: "handler",
          errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.handler,
          outcome: "failed",
          ...safeErrorDiagnosticData(error),
        });
        this.reportSlowTask({ ...timingData, phase: "complete", outcome: "failed" });
        throw new HostRpcHttpFatalError("Host RPC handler failed");
      }
      timing.handlerMs = elapsedMs(timing.handlerStartedAt);
      if (this.stopped) return;
      try {
        validateExecutionResult(leased.task, messages);
      } catch (error) {
        const timingData = buildTaskTimingData(context, timing);
        this.opts.events?.onDiagnostic?.("error", "Host RPC result validation failed", {
          ...timingData,
          phase: "validation",
          errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.validation,
          outcome: "failed",
          ...safeErrorDiagnosticData(error),
        });
        this.reportSlowTask({ ...timingData, phase: "complete", outcome: "failed" });
        throw toSafeFatalError(error, "Host RPC result validation failed");
      }

      timing.activePhase = "serialize";
      timing.serializeStartedAt = performance.now();
      let serializedBody: string;
      try {
        serializedBody = JSON.stringify({ messages } satisfies HostRpcHttpResultRequest);
      } catch (error) {
        timing.serializeMs = elapsedMs(timing.serializeStartedAt);
        const timingData = buildTaskTimingData(context, timing);
        this.opts.events?.onDiagnostic?.("error", "Host RPC result serialization failed", {
          ...timingData,
          phase: "serialize",
          errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.serialization,
          outcome: "failed",
          ...safeErrorDiagnosticData(error),
        });
        this.reportSlowTask({ ...timingData, phase: "complete", outcome: "failed" });
        throw new HostRpcHttpFatalError("Host RPC result serialization failed");
      }
      timing.serializeMs = elapsedMs(timing.serializeStartedAt);
      timing.resultBytes = Buffer.byteLength(serializedBody, "utf8");
      timing.postStartedAt = performance.now();
      timing.activePhase = "post";
      while (!this.stopped) {
        timing.postAttempts += 1;
        try {
          const outcome = await this.postResult(leased.task.operationId, serializedBody, leased.sessionId, context);
          timing.postMs = elapsedMs(timing.postStartedAt);
          const completionData = {
            ...buildTaskTimingData(context, timing),
            phase: "complete" as const,
            outcome,
          };
          this.opts.events?.onDiagnostic?.("info", "Host RPC task completed", {
            ...completionData,
          });
          this.reportSlowTask(completionData);
          return;
        } catch (error) {
          if (this.stopped && isAbortError(error)) return;
          if (leased.sessionId !== this.sessionId && isAbortError(error)) continue;
          timing.postMs = elapsedMs(timing.postStartedAt);
          const timingData = buildTaskTimingData(context, timing);
          const data = {
            ...timingData,
            phase: "post",
            errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE.post,
            outcome: error instanceof HostRpcHttpFatalError ? "failed" : "retrying",
            ...safeErrorDiagnosticData(error),
          };
          if (error instanceof HostRpcHttpFatalError) {
            this.opts.events?.onDiagnostic?.("error", "Host RPC result submit failed", data);
            this.reportSlowTask({ ...timingData, phase: "complete", outcome: "failed" });
            throw error;
          }
          this.opts.events?.onDiagnostic?.("warn", "Host RPC result submit failed", data);
          if (leased.sessionId !== this.sessionId) continue;
          await this.waitBeforeRetry(timing.postAttempts);
        }
      }
    } finally {
      stopSlowTaskMonitor();
    }
  }

  /** 为任务建立一次性慢任务告警；排队时间已知时提前扣除告警延迟。 */
  private startSlowTaskMonitor(context: HostRpcTaskDiagnosticContext, timing: HostRpcTaskTimingState): () => void {
    const delayMs = Math.max(0, this.slowTaskThresholdMs - (context.queueMs ?? 0));
    const timer = setTimeout(() => {
      if (timing.finished) return;
      this.reportSlowTask({
        ...buildTaskTimingData(context, timing),
        phase: "in_progress",
        outcome: "in_progress",
      });
    }, delayMs);
    timer.unref?.();
    let stopMonitor!: () => void;
    stopMonitor = () => {
      timing.finished = true;
      clearTimeout(timer);
      this.activeSlowTaskMonitorStops.delete(stopMonitor);
    };
    this.activeSlowTaskMonitorStops.add(stopMonitor);
    return stopMonitor;
  }

  /** 对执行中或已完成的慢任务告警；已完成事件保留旧 phase=slow 兼容日志检索。 */
  private reportSlowTask(data: HostRpcTaskDiagnosticData): void {
    const slowStages = [
      data.queueMs !== null && data.queueMs >= this.slowTaskThresholdMs ? "queue" : null,
      data.handlerMs >= this.slowTaskThresholdMs ? "handler" : null,
      data.serializeMs >= this.slowTaskThresholdMs ? "serialize" : null,
      data.postMs >= this.slowTaskThresholdMs ? "post" : null,
      data.totalMs >= this.slowTaskThresholdMs ? "total" : null,
    ].filter((stage): stage is string => stage !== null);
    if (!slowStages.length) return;
    this.opts.events?.onDiagnostic?.("warn", "Host RPC task slow", {
      ...data,
      phase: data.phase === "in_progress" ? "in_progress" : "slow",
      errorCode: "HOST_RPC_HTTP_SLOW_TASK",
      diagnosticOutcome: "slow",
      slowStages,
      slowTaskThresholdMs: this.slowTaskThresholdMs,
    });
  }

  /** long-poll 一条命令，并把领取时的 WS session 固定到该租约。 */
  private async fetchNextTask(): Promise<LeasedHostRpcHttpTask | null> {
    const sessionId = this.currentSessionId();
    const query = new URLSearchParams({ clientId: this.opts.clientId, wait: String(this.pollWaitMs) });
    return await this.request(
      `${this.httpBase}/api/client/rpc/next?${query.toString()}`,
      { method: "GET", headers: this.authHeaders(sessionId) },
      this.pollRequestTimeoutMs,
      async (response, signal) => {
        if (response.status === 204) {
          await cancelResponseBody(response, signal);
          return null;
        }
        if (!response.ok) {
          const metadata = await readSafeErrorResponseMetadata(response, signal);
          if (sessionId !== this.sessionId) return null;
          if (response.status === 409 && (metadata.responseErrorCode === "HOST_RPC_SESSION_MISMATCH"
            || metadata.responseErrorCode === "HOST_RPC_CLIENT_UNAVAILABLE")) {
            this.invalidateSession(metadata, "poll");
            return null;
          }
          if (metadata.responseErrorCode === "HOST_RPC_CAPABILITY_REQUIRED") {
            throw new HostRpcHttpFatalError("Host RPC capability rejected", metadata);
          }
          if (response.status === 401 || response.status === 403) {
            throw new HostRpcHttpFatalError(`Host RPC poll authentication failed (${response.status})`, metadata);
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 409) {
            throw new HostRpcHttpFatalError(`Host RPC poll rejected (${response.status})`, metadata);
          }
          throw new HostRpcHttpResponseError(`Host RPC poll failed (${response.status})`, metadata);
        }

        const body = await readBoundedResponseBody(response, TASK_RESPONSE_BODY_LIMIT_BYTES, signal);
        if (body.bodyTruncated) {
          throw new HostRpcHttpFatalError("Host RPC poll response body exceeded the size limit");
        }
        let value: unknown;
        try {
          value = JSON.parse(body.bytes.toString("utf8")) as unknown;
        } catch {
          throw new HostRpcHttpFatalError("Host RPC poll returned invalid JSON");
        }
        if (!isHostRpcTask(value)) throw new HostRpcHttpFatalError("Host RPC poll returned an invalid task");
        if (sessionId !== this.sessionId) return null;
        return { task: value, sessionId };
      },
    );
  }

  /** 410 或 session 退役终止提交；旧版 409 请求重新握手，不重放已执行命令。 */
  private async postResult(
    operationId: string,
    serializedBody: string,
    sessionId: string,
    context: HostRpcTaskDiagnosticContext,
  ): Promise<"accepted" | "gone"> {
    if (sessionId !== this.sessionId) return "gone";
    const query = new URLSearchParams({ clientId: this.opts.clientId });
    return await this.request(
      `${this.httpBase}/api/client/rpc/${encodeURIComponent(operationId)}/result?${query.toString()}`,
      {
        method: "POST",
        headers: { ...this.authHeaders(sessionId), "Content-Type": "application/json" },
        body: serializedBody,
      },
      this.resultRequestTimeoutMs,
      async (response, signal) => {
        if (response.status === 410) {
          await cancelResponseBody(response, signal);
          return "gone";
        }
        if (!response.ok) {
          const metadata = await readSafeErrorResponseMetadata(response, signal);
          if (sessionId !== this.sessionId) return "gone";
          if (response.status === 409 && (metadata.responseErrorCode === "HOST_RPC_SESSION_MISMATCH"
            || metadata.responseErrorCode === "HOST_RPC_CLIENT_UNAVAILABLE" || isLegacySessionConflict(metadata))) {
            this.invalidateSession(metadata, "result", context);
            return "gone";
          }
          if (response.status === 401 || response.status === 403) {
            throw new HostRpcHttpFatalError(`Host RPC result authentication failed (${response.status})`, metadata);
          }
          if (response.status >= 400 && response.status < 500 && response.status !== 409) {
            throw new HostRpcHttpFatalError(`Host RPC result rejected (${response.status})`, metadata);
          }
          throw new HostRpcHttpResponseError(`Host RPC result submit failed (${response.status})`, metadata);
        }
        await cancelResponseBody(response, signal);
        return "accepted";
      },
    );
  }

  /** 明确失效或旧版冲突持续时退役当前 session，记录关联后由 WS owner 重新握手。 */
  private invalidateSession(metadata: HostRpcHttpErrorResponseMetadata, phase: "poll" | "result", context?: HostRpcTaskDiagnosticContext): void {
    if (!this.sessionId) return;
    if (!this.opts.events?.onSessionInvalidated) throw new HostRpcHttpFatalError("Host RPC session invalidated without recovery owner", metadata);
    this.opts.events?.onDiagnostic?.("warn", "Host RPC session invalidated; waiting for WS handshake", {
      ...context, clientId: this.opts.clientId, phase,
      errorCode: HOST_RPC_DIAGNOSTIC_ERROR_CODE[phase === "poll" ? "poll" : "post"],
      rootCause: metadata.responseErrorCode ?? `HTTP ${metadata.status}`, ...metadata,
    });
    this.sessionId = null;
    this.abortActiveRequests();
    this.releaseRetryWaiters();
    this.opts.events.onSessionInvalidated();
  }

  /** 执行带总 deadline 的请求，直到响应正文消费完成前都可由 stop 中断。 */
  private async request<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    this.activeRequests.add(controller);
    const timeout = setTimeout(() => controller.abort(new HostRpcHttpRequestTimeoutError()), timeoutMs);
    timeout.unref?.();
    try {
      const response = await waitForRequestStage(
        this.fetchImpl(url, { ...init, signal: controller.signal }),
        controller.signal,
      );
      return await consume(response, controller.signal);
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(controller);
    }
  }

  /** 生成绑定指定连接代际且不输出凭据的鉴权头。 */
  private authHeaders(sessionId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      "X-Codeflow-Host-Rpc-Session": sessionId,
    };
  }

  /** 返回当前 WS 握手签发的连接 session；缺失时禁止发起 HTTP RPC。 */
  private currentSessionId(): string {
    if (!this.sessionId) throw new HostRpcHttpFatalError("Host RPC HTTP session id is missing");
    return this.sessionId;
  }

  /** 使用有上限的指数退避，stop 时同步解除等待。 */
  private waitBeforeRetry(attempt: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const delayMs = Math.min(this.retryBaseMs * Math.pow(2, Math.max(0, attempt - 1)), MAX_RETRY_DELAY_MS);
    return new Promise((resolve) => {
      const waiter: RetryWaiter = {
        timer: setTimeout(() => {
          this.retryWaiters.delete(waiter);
          resolve();
        }, delayMs),
        resolve,
      };
      waiter.timer.unref?.();
      this.retryWaiters.add(waiter);
    });
  }

  /** 中止当前 poll 和结果提交；执行器本身由 stopAndDrain 等待自然收口。 */
  private abortActiveRequests(): void {
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }

  /** 解除所有 worker 的退避等待，避免停止或致命失败后遗留 timer。 */
  private releaseRetryWaiters(): void {
    for (const waiter of this.retryWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.retryWaiters.clear();
  }
}

/** 旧版 RPC 只返回通用 409；明确的 poll 冲突由原退避处理，不触发重新握手。 */
function isLegacySessionConflict(metadata: HostRpcHttpErrorResponseMetadata): boolean {
  return metadata.status === 409 && (metadata.responseErrorCode === null || metadata.responseErrorCode === "CONFLICT");
}

/** 将可选 worker 并发限制收窄到 1~16，无效值使用默认 4。 */
function resolveMaxConcurrency(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_CONCURRENCY;
  return Math.max(1, Math.min(16, Math.floor(value)));
}

/** 将单请求总 deadline 限制在 10ms~5min，无效值使用默认值。 */
function resolveRequestTimeout(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(10, Math.min(5 * 60_000, Math.floor(value)));
}

/** 将慢任务诊断阈值限制在 100ms~5min，无效值使用默认 5 秒。 */
function resolveSlowTaskThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_SLOW_TASK_THRESHOLD_MS;
  return Math.max(100, Math.min(5 * 60_000, Math.floor(value)));
}

/** 将 Client WS 地址转换为同源 HTTP 根地址。 */
function toHttpBaseFromWsUrl(wsUrl: string): string {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    throw new HostRpcHttpFatalError("Host RPC Server URL is invalid");
  }
  if (url.username || url.password) {
    throw new HostRpcHttpFatalError("Host RPC Server URL must not include credentials");
  }
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new HostRpcHttpFatalError("Host RPC Server URL protocol is invalid");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** 校验 Server 下发的最小任务结构。 */
function isHostRpcTask(value: unknown): value is HostRpcHttpTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  if (typeof task.operationId !== "string" || !task.operationId.trim()) return false;
  if (
    task.queueMs !== undefined
    && (typeof task.queueMs !== "number" || !Number.isFinite(task.queueMs) || task.queueMs < 0)
  ) return false;
  const message = asRecord(task.message);
  if (!message) return false;
  if (message.t === "api.req") {
    return typeof message.id === "string" && Boolean(message.id.trim()) && typeof message.method === "string";
  }
  return message.t === "sharedWorkspace.command" && asRecord(message.envelope) !== null;
}

/** 提取任务关联字段供结构化日志使用，不读取或输出业务正文。 */
function buildTaskDiagnosticContext(task: HostRpcHttpTask): HostRpcTaskDiagnosticContext {
  if (task.message.t === "api.req") {
    const body = asRecord(task.message.body);
    return {
      hostRpcOperationId: task.operationId,
      requestId: readDiagnosticText(task.message.id),
      sharedWorkspaceOperationId: null,
      routeEventId: null,
      method: readDiagnosticText(task.message.method),
      operationKey: null,
      workspaceId: readDiagnosticText(body?.workspaceId),
      queueMs: normalizeQueueMs(task.queueMs),
    };
  }
  const envelope = asRecord(task.message.envelope);
  const payload = asRecord(envelope?.payload);
  return {
    hostRpcOperationId: task.operationId,
    requestId: null,
    sharedWorkspaceOperationId: readDiagnosticText(envelope?.operationId),
    routeEventId: readDiagnosticText(envelope?.routeEventId),
    method: readDiagnosticText(payload?.method),
    operationKey: readDiagnosticText(envelope?.operationKey),
    workspaceId: readDiagnosticText(envelope?.localWorkspaceId),
    queueMs: normalizeQueueMs(task.queueMs),
  };
}

/** 将未知值收窄为普通对象，仅用于读取允许记录的关联字段。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 将允许记录的关联值规整为非空字符串。 */
function readDiagnosticText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

/** 兼容旧 Server 缺失 queueMs；新 Server 的非法值已在 task 校验阶段拒绝。 */
function normalizeQueueMs(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 返回非负毫秒耗时并保留两位小数。 */
function elapsedMs(startedAt: number): number {
  return Math.max(0, Number((performance.now() - startedAt).toFixed(2)));
}

/** 组装统一耗时口径；totalMs 包含 Server 排队和 Client 处理耗时。 */
function buildTaskTimingData(
  context: HostRpcTaskDiagnosticContext,
  timing: HostRpcTaskTimingState,
): HostRpcTaskTimingData {
  const clientTotalMs = elapsedMs(timing.taskStartedAt);
  return {
    ...context,
    activePhase: timing.activePhase,
    handlerMs: timing.handlerMs ?? elapsedMs(timing.handlerStartedAt),
    serializeMs: timing.serializeMs
      ?? (timing.serializeStartedAt === null ? 0 : elapsedMs(timing.serializeStartedAt)),
    resultBytes: timing.resultBytes ?? 0,
    postMs: timing.postMs
      ?? (timing.postStartedAt === null ? 0 : elapsedMs(timing.postStartedAt)),
    postAttempts: timing.postAttempts,
    clientTotalMs,
    totalMs: sumElapsedMs(context.queueMs ?? 0, clientTotalMs),
  };
}

/** 合并排队与 Client 耗时并限制浮点误差。 */
function sumElapsedMs(queueMs: number, clientTotalMs: number): number {
  return Math.max(0, Number((queueMs + clientTotalMs).toFixed(2)));
}

/** 执行器必须为每条命令生成唯一最终响应，避免 HTTP 提交伪成功。 */
function validateExecutionResult(task: HostRpcHttpTask, messages: HostRpcHttpResultMessage[]): void {
  if (!Array.isArray(messages)) throw new HostRpcHttpFatalError("Host RPC executor did not return a result array");
  if (task.message.t === "api.req") {
    if (messages.length !== 1 || messages[0]?.t !== "api.res" || messages[0].id !== task.message.id) {
      throw new HostRpcHttpFatalError("Host RPC api.req did not produce one matching api.res");
    }
    return;
  }
  const results = messages.filter((message) => message.t === "sharedWorkspace.route.result");
  if (results.length !== 1 || messages.some((message) => message.t === "api.res")) {
    throw new HostRpcHttpFatalError("Host RPC shared command did not produce one route result");
  }
}

/** 流式读取有界正文；stop/deadline 会取消 reader，达到上限后立即停止继续拉取。 */
async function readBoundedResponseBody(
  response: Response,
  limitBytes: number,
  signal: AbortSignal,
  completeOnBodyFailure = false,
): Promise<BoundedResponseBody> {
  const byteLimit = Math.max(1, Math.floor(limitBytes));
  const hash = crypto.createHash("sha256");
  const chunks: Buffer[] = [];
  let bodyBytesRead = 0;
  let bodyTruncated = false;
  const reader = response.body?.getReader() ?? null;
  if (reader) {
    try {
      while (bodyBytesRead < byteLimit) {
        const item = await readResponseBodyChunk(reader, signal);
        if (item.done) break;
        const remaining = byteLimit - bodyBytesRead;
        const prefix = item.value.subarray(0, remaining);
        if (prefix.byteLength > 0) {
          const retained = Buffer.from(prefix);
          chunks.push(retained);
          hash.update(retained);
          bodyBytesRead += retained.byteLength;
        }
        if (item.value.byteLength > remaining || bodyBytesRead >= byteLimit) {
          bodyTruncated = true;
          try {
            await waitForRequestStage(reader.cancel(), signal);
          } catch {
            if (isActiveRequestAbort(signal)) throw requestAbortReason(signal);
            // 大小上限是权威失败；cleanup reject/deadline 不得把它降级为可重试网络错误。
          }
          break;
        }
      }
    } catch (error) {
      if (isActiveRequestAbort(signal)) throw requestAbortReason(signal);
      if (!completeOnBodyFailure) throw error;
      bodyTruncated = true;
    } finally {
      if (!signal.aborted) reader.releaseLock();
    }
  }
  return {
    bytes: bodyTruncated ? Buffer.alloc(0) : Buffer.concat(chunks, bodyBytesRead),
    bodyBytesRead,
    bodyTruncated,
    bodyPrefixHash: hash.digest("hex"),
  };
}

/** 将单次 stream read 与请求 signal 绑定，兼容不会自动响应 fetch signal 的测试流。 */
function readResponseBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(requestAbortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => reject(requestAbortReason(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (item) => finish(() => resolve(item)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** 将 headers fetch 或 body cancel 等请求阶段纳入同一个 AbortSignal 生命周期。 */
function waitForRequestStage<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(requestAbortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(requestAbortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** 返回请求中止的固定异常；deadline 与主动 stop 保持可区分。 */
function requestAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Host RPC HTTP request aborted");
  error.name = "AbortError";
  return error;
}

/** 对不需要正文的响应立即取消流，并让 cancel 也服从总 deadline/stop。 */
async function cancelResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) return;
  try {
    await waitForRequestStage(response.body.cancel(), signal);
  } catch {
    if (isActiveRequestAbort(signal)) throw requestAbortReason(signal);
    throw new HostRpcHttpFatalError("Host RPC response body cleanup failed");
  }
}

/** 错误响应最多读取 64KiB，只保留前缀哈希、字节数和顶层白名单字段。 */
async function readSafeErrorResponseMetadata(
  response: Response,
  signal: AbortSignal,
): Promise<HostRpcHttpErrorResponseMetadata> {
  const contentType = normalizeSafeContentType(response.headers.get("content-type"));
  const body = await readBoundedResponseBody(
    response,
    ERROR_RESPONSE_CODE_SCAN_LIMIT_BYTES,
    signal,
    true,
  );
  const responseErrorCode = !body.bodyTruncated && contentType?.includes("json")
    ? readWhitelistedResponseErrorCode(body.bytes)
    : null;
  return {
    status: response.status,
    responseErrorCode,
    contentType,
    bodyBytesRead: body.bodyBytesRead,
    bodyTruncated: body.bodyTruncated,
    bodyPrefixHash: body.bodyPrefixHash,
  };
}

/** 仅允许输出固定响应 media type，丢弃参数和未知值。 */
function normalizeSafeContentType(value: string | null): string | null {
  const mediaType = String(value ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return SAFE_ERROR_CONTENT_TYPES.has(mediaType) ? mediaType : null;
}

/** 从有限 JSON 文本中只提取普通对象自己的顶层白名单错误码。 */
function readWhitelistedResponseErrorCode(body: Buffer): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (!record || !Object.prototype.hasOwnProperty.call(record, "code")) return null;
  const code = typeof record.code === "string" ? record.code : "";
  return SAFE_RESPONSE_ERROR_CODES.has(code) ? code : null;
}

/** 提取白名单异常类型、外部 code、消息哈希和安全响应元数据。 */
function safeErrorDiagnosticData(error: unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const metadata = error instanceof HostRpcHttpFatalError || error instanceof HostRpcHttpResponseError
    ? error.responseMetadata
    : null;
  if (metadata) Object.assign(data, metadata);
  const errorName = safeErrorName(error);
  if (errorName) data.errorName = errorName;
  const externalErrorCode = safeOwnString(error, "code");
  if (externalErrorCode && SAFE_EXTERNAL_ERROR_CODES.has(externalErrorCode)) {
    data.externalErrorCode = externalErrorCode;
  }
  const message = safeErrorMessage(error);
  if (message !== null) {
    const messageTruncated = message.length > ERROR_MESSAGE_HASH_LIMIT_CODE_UNITS;
    const hashInput = messageTruncated ? message.slice(0, ERROR_MESSAGE_HASH_LIMIT_CODE_UNITS) : message;
    const hash = crypto.createHash("sha256").update(hashInput, "utf8").digest("hex");
    if (messageTruncated) {
      data.messagePrefixHash = hash;
      data.messageTruncated = true;
      data.messageCodeUnits = message.length;
    } else {
      data.messageHash = hash;
    }
  }
  return data;
}

/** 把跨 transport 边界的未知异常收口为固定安全 fatal。 */
function toSafeFatalError(error: unknown, fallback = "Host RPC HTTP transport failed"): HostRpcHttpFatalError {
  if (error instanceof HostRpcHttpFatalError) return error;
  const metadata = error instanceof HostRpcHttpResponseError ? error.responseMetadata : null;
  return new HostRpcHttpFatalError(fallback, metadata);
}

/** 只返回固定白名单异常类型，未知自定义 name 不写日志。 */
function safeErrorName(error: unknown): string | null {
  const ownName = safeOwnString(error, "name");
  if (ownName && SAFE_ERROR_NAMES.has(ownName)) return ownName;
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const domNameGetter = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
    const domName = domNameGetter?.call(error);
    if (typeof domName === "string" && SAFE_ERROR_NAMES.has(domName)) return domName;
  }
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error instanceof Error) return "Error";
  return null;
}

/** 读取未知对象的自有字符串数据属性，不触发 getter 或字符串化协议。 */
function safeOwnString(value: unknown, key: string): string | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

/** 只取可安全哈希的异常文本，不把原文放进日志字段。 */
function safeErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return error;
  return safeOwnString(error, "message");
}

/** 判断请求是否由 AbortController 主动中止。 */
function isAbortError(error: unknown): boolean {
  return safeErrorName(error) === "AbortError";
}

/** 判断请求是否触发总 deadline。 */
function isTimeoutError(error: unknown): boolean {
  return safeErrorName(error) === "TimeoutError";
}

/** 主动 stop/session abort 是控制流；deadline 仍属于请求失败。 */
function isActiveRequestAbort(signal: AbortSignal): boolean {
  return signal.aborted && !isTimeoutError(signal.reason);
}
