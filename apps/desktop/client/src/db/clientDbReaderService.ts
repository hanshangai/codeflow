import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { WorkspaceId } from "@codeflowai/shared";
import type { ClientDbReadCoordinator } from "./clientDbWriterProtocol.js";

import {
  CLIENT_DB_READER_SCHEMA_VERSION,
  sanitizeClientDbReaderRootCauseMessage,
  type ClientDbReaderCommand,
  type ClientDbReaderDiagnostic,
  type ClientDbReaderErrorCode,
  type ClientDbReaderErrorData,
  type ClientDbReaderListIntakesResult,
  type ClientDbReaderTimings,
  type ClientDbReaderWorkerData,
  type ClientDbReaderWorkerMessage,
  type ClientDbWorkspaceReaderLease,
  type OrchIntakeListSnapshotInput,
} from "./clientDbReaderProtocol.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const CLIENT_DB_READER_ERROR_CODES = new Set<ClientDbReaderErrorCode>([
  "CLIENT_DB_READER_CLOSED",
  "CLIENT_DB_READER_CLOSING",
  "CLIENT_DB_READER_CLOSE_FAILED",
  "CLIENT_DB_READER_DIAGNOSTIC_FAILED",
  "CLIENT_DB_READER_INIT_FAILED",
  "CLIENT_DB_READER_INVALID_INPUT",
  "CLIENT_DB_READER_PROTOCOL_INVALID",
  "CLIENT_DB_READER_QUERY_FAILED",
  "CLIENT_DB_READER_SCHEMA_INVALID",
  "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH",
  "CLIENT_DB_READER_WORKER_FAILED",
  "ORCH_INTAKE_LIST_SNAPSHOT_INVALID",
  "ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID",
]);
const SAFE_WORKER_ERROR_DETAIL_KEYS = new Set([
  "actual",
  "actualProjectionVersion",
  "actualSchemaVersion",
  "actualSourceUpdatedAt",
  "causeCode",
  "closeFailure",
  "expected",
  "expectedProjectionVersion",
  "expectedSchemaVersion",
  "expectedSourceUpdatedAt",
  "field",
  "instanceId",
  "intakeId",
  "intakeWorkspaceId",
  "invalidIndexes",
  "jsonId",
  "jsonWorkspaceId",
  "missingColumns",
  "missingObjects",
  "osErrorCode",
  "phase",
  "projectionRole",
  "projectionVersion",
  "reason",
  "rootCauseMessage",
  "rootCauseType",
  "sourceUpdatedAt",
  "sqliteCode",
  "terminationFailed",
  "workspaceId",
]);

type ReaderLifecycle = "starting" | "ready" | "closing" | "closed" | "failed";

type PendingListCommand = {
  commandId: string;
  requestId: string;
  workspaceId: WorkspaceId | null;
  resolve: (result: ClientDbReaderListIntakesResult) => void;
  reject: (error: ClientDbReaderError) => void;
};

type Deferred<T> = {
  promise: Promise<T>;
  settled: boolean;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export type ClientDbReaderServiceOptions = {
  dbPath: string;
  busyTimeoutMs?: number;
  workerPath?: string;
  readyTimeoutMs?: number;
  closeTimeoutMs?: number;
  onDiagnostic?: (diagnostic: ClientDbReaderDiagnostic) => void | Promise<void>;
  onFatalError: (error: ClientDbReaderError) => void;
  acquireWorkspaceSource?: (workspaceId: OrchIntakeListSnapshotInput["workspaceId"]) => ClientDbWorkspaceReaderLease | null | Promise<ClientDbWorkspaceReaderLease | null>;
};

/** 主线程可检索的 Reader 错误；details 只允许脱敏后的短根因，不包含路径或 SQL。 */
export class ClientDbReaderError extends Error {
  /** 保存稳定错误码和脱敏字段；原始 cause 仅保留在主线程。 */
  constructor(
    readonly code: ClientDbReaderErrorCode,
    message: string,
    readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClientDbReaderError";
  }
}

/** 单个长期 Reader Worker 服务；所有同步 SQL 都在独立线程内串行执行。 */
export class ClientDbReaderService {
  private readonly worker: Worker;
  private readonly onDiagnostic: ClientDbReaderServiceOptions["onDiagnostic"];
  private readonly onFatalError: ClientDbReaderServiceOptions["onFatalError"];
  private readonly readyTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly readyDeferred = createDeferred<ClientDbReaderError | null>();
  private readonly exitDeferred = createDeferred<number>();
  private readonly pending = new Map<string, PendingListCommand>();
  private readonly drainWaiters = new Set<() => void>();
  private lifecycle: ReaderLifecycle = "starting";
  private terminalError: ClientDbReaderError | null = null;
  private closePromise: Promise<void> | null = null;
  private closeCommandId: string | null = null;
  private closeDeferred: Deferred<void> | null = null;
  private terminationPromise: Promise<number> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private hasReachedReady = false;
  private readonly acquireWorkspaceSource: ClientDbReaderServiceOptions["acquireWorkspaceSource"];
  private databaseCoordinator: ClientDbReadCoordinator | null = null;

  /** 创建唯一普通 SQLite Reader Worker。 */
  constructor(options: ClientDbReaderServiceOptions) {
    this.onDiagnostic = options.onDiagnostic;
    this.acquireWorkspaceSource = options.acquireWorkspaceSource;
    if (typeof options.onFatalError !== "function") {
      throw createServiceError("CLIENT_DB_READER_INVALID_INPUT", { reason: "missing_fatal_error_handler" });
    }
    this.onFatalError = options.onFatalError;
    this.readyTimeoutMs = normalizeTimeout(options.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
    this.closeTimeoutMs = normalizeTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    const dbPath = String(options.dbPath ?? "").trim();
    if (!dbPath) {
      throw createServiceError("CLIENT_DB_READER_INVALID_INPUT", { reason: "missing_db_path" });
    }
    const workerData: ClientDbReaderWorkerData = {
      dbPath,
      busyTimeoutMs: options.busyTimeoutMs,
      workspaceMode: Boolean(options.acquireWorkspaceSource),
    };
    this.worker = createClientDbReaderWorker(workerData, options.workerPath);
    this.worker.on("message", (message: unknown) => {
      this.handleMessage(message).catch((error) => {
        this.failService(
          error instanceof ClientDbReaderError ? error : workerRuntimeError(error, "message_handler_failed"),
          true,
        );
      });
    });
    this.worker.once("error", (error) => {
      this.failService(workerRuntimeError(error, "worker_error"));
    });
    this.worker.once("messageerror", (error) => {
      this.failService(protocolResponseError("worker_response_deserialize_failed", error), true);
    });
    this.worker.once("exit", (code) => this.handleExit(code));
    this.readyTimer = setTimeout(() => {
      this.failService(createServiceError("CLIENT_DB_READER_INIT_FAILED", {
        reason: "ready_timeout",
        timeoutMs: this.readyTimeoutMs,
      }), true);
    }, this.readyTimeoutMs);
  }

  /** 等待只读连接完成 query_only、版本和摘要结构校验。 */
  async ready(): Promise<void> {
    this.assertAcceptingRequests();
    await this.waitForReady();
    if (this.lifecycle === "ready") {
      this.hasReachedReady = true;
      return;
    }
    this.assertAcceptingRequests();
    throw protocolResponseError("ready_lifecycle_invalid");
  }

  /** 通过独立线程读取一个一致的需求列表快照，不在主线程回退执行 SQL。 */
  async listIntakes(input: OrchIntakeListSnapshotInput): Promise<ClientDbReaderListIntakesResult> {
    const coordinator = this.databaseCoordinator;
    return coordinator ? coordinator.run(readRequestId(input), input.workspaceId, () => this.runListIntakes(input))
      : this.runListIntakes(input);
  }

  /** Writer 生命周期安装统一准入，尚在途时不允许更换访问 owner。 */
  setDatabaseCoordinator(coordinator: ClientDbReadCoordinator | null): void {
    if (this.pending.size) throw createServiceError("CLIENT_DB_READER_INVALID_INPUT", { reason: "coordinator_change_during_query" });
    this.databaseCoordinator = coordinator;
  }

  /** 实际读事务由唯一协调队列准入，租约仍由原 ClientDb 取得。 */
  private async runListIntakes(input: OrchIntakeListSnapshotInput): Promise<ClientDbReaderListIntakesResult> {
    this.assertAcceptingRequests();
    const requestId = readRequestId(input);
    if (this.lifecycle === "starting") await this.waitForReady();
    this.assertAcceptingRequests();
    this.hasReachedReady = true;

    const lease = this.acquireWorkspaceSource ? await this.synchronous(() => this.acquireWorkspaceSource!(input.workspaceId)) : null;
    if (this.acquireWorkspaceSource && !lease) throw createServiceError("CLIENT_DB_READER_SCHEMA_INVALID", {
      reason: "workspace_database_missing", workspaceId: input.workspaceId, requestId,
    });
    let result: ClientDbReaderListIntakesResult | undefined;
    let failure: unknown;
    let failed = false;
    try {
      this.synchronous(() => lease?.verify());
      this.assertAcceptingRequests();
      result = await this.postListIntakes(input, requestId, lease?.source);
      this.synchronous(() => lease?.verify());
    } catch (error) {
      failure = error; failed = true;
      if (this.lifecycle === "failed") {
        try { await this.awaitFailedWorkerExit(); }
        catch (exitError) { failure = new AggregateError([failure, exitError], "CLIENT_DB_READER_WORKSPACE_CLOSE_FAILED"); }
      }
    }
    try { this.synchronous(() => lease?.release()); }
    catch (error) {
      failure = failed ? new AggregateError([failure, error], "CLIENT_DB_READER_WORKSPACE_RELEASE_FAILED") : error;
      failed = true;
    }
    if (failed) throw failure;
    return result!;
  }

  /** 仅同步的租约/诊断准备可访问主线程库，Worker await 期间不持许可。 */
  private synchronous<T>(operation: () => T): T {
    return this.databaseCoordinator ? this.databaseCoordinator.synchronous(operation) : operation();
  }

  /** 保存租约的可信 W；外层等待 Worker 关闭连接后才释放租约。 */
  private postListIntakes(input: OrchIntakeListSnapshotInput, requestId: string,
    source?: ClientDbWorkspaceReaderLease["source"]): Promise<ClientDbReaderListIntakesResult> {
    const commandId = crypto.randomUUID();
    const command: ClientDbReaderCommand = {
      type: "listIntakes",
      commandId,
      requestId,
      queuedAtNs: process.hrtime.bigint(),
      input,
      source,
    };
    return new Promise<ClientDbReaderListIntakesResult>((resolve, reject) => {
      this.pending.set(commandId, { commandId, requestId, workspaceId: source ? source.workspaceId as WorkspaceId : null,
        resolve, reject });
      try {
        this.worker.postMessage(command);
      } catch (error) {
        const clientError = createServiceError("CLIENT_DB_READER_PROTOCOL_INVALID", {
          reason: "command_clone_failed",
          commandId,
          requestId,
          ...safeRuntimeDetails(error),
        });
        this.rejectPending(commandId, clientError);
      }
    });
  }

  /** 拒绝新请求，等待全部在途查询自然完成，再通知 Worker 关闭连接。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.lifecycle === "closed") return Promise.resolve();
    if (this.lifecycle !== "failed") this.lifecycle = "closing";
    this.closePromise = this.runClose();
    return this.closePromise;
  }

  /** 执行排空、连接关闭和线程退出的完整关闭序列。 */
  private async runClose(): Promise<void> {
    try {
      await waitWithTimeout(
        this.runCloseSequence(),
        this.closeTimeoutMs,
        () => createServiceError("CLIENT_DB_READER_CLOSE_FAILED", {
          reason: "close_timeout",
          timeoutMs: this.closeTimeoutMs,
        }),
      );
    } catch (error) {
      const clientError = error instanceof ClientDbReaderError
        ? error
        : workerRuntimeError(error, "close_failed");
      this.failService(clientError, true);
      try {
        await waitWithTimeout(
          this.awaitFailedWorkerExit(),
          this.closeTimeoutMs,
          () => createServiceError("CLIENT_DB_READER_CLOSE_FAILED", {
            reason: "termination_timeout",
            timeoutMs: this.closeTimeoutMs,
          }),
        );
      } catch (terminationError) {
        const normalized = terminationError instanceof ClientDbReaderError
          ? terminationError
          : workerRuntimeError(terminationError, "termination_failed");
        this.terminalError = new ClientDbReaderError(normalized.code, normalized.message, {
          ...normalized.details,
          causeCode: clientError.code,
        });
      }
      throw this.requireTerminalError();
    }
  }

  /** 自然等待 ready、在途查询、关闭回执和线程退出。 */
  private async runCloseSequence(): Promise<void> {
    if (this.lifecycle === "failed") {
      await this.awaitFailedWorkerExit();
      throw this.requireTerminalError();
    }
    await this.waitForReady();
    await this.waitForPending();
    if (this.terminalError) {
      await this.awaitFailedWorkerExit();
      throw this.requireTerminalError();
    }

    const commandId = crypto.randomUUID();
    this.closeCommandId = commandId;
    this.closeDeferred = createDeferred<void>();
    const workerClose = this.waitForWorkerClose();
    try {
      this.worker.postMessage({ type: "close", commandId } satisfies ClientDbReaderCommand);
    } catch (error) {
      const postError = workerRuntimeError(error, "close_post_failed");
      this.closeDeferred.reject(postError);
      await workerClose;
      throw postError;
    }
    const exitCode = await workerClose;
    if (exitCode !== 0) throw workerRuntimeError(undefined, "close_exit_nonzero", exitCode);
    if (this.lifecycle !== "closing" || this.terminalError) return;
    this.lifecycle = "closed";
  }

  /** 分发 ready、查询结果、显式失败和关闭回执。 */
  private async handleMessage(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== "string") {
      this.failService(protocolResponseError("invalid_message"), true);
      return;
    }
    if (value.type === "ready") {
      this.handleReady(value);
      return;
    }
    if (value.type === "result" || value.type === "failed") {
      await this.handleQueryResponse(value);
      return;
    }
    if (value.type === "init.failed" || value.type === "fatal") {
      const error = readWorkerError(value.error) ?? protocolResponseError("invalid_error_payload");
      this.failService(error, true);
      return;
    }
    if (value.type === "closed" || value.type === "close.failed") {
      this.handleCloseResponse(value);
      return;
    }
    this.failService(protocolResponseError("unknown_message_type"), true);
  }

  /** 接收初始化成功回执，并保持 close 期间的拒绝新请求状态。 */
  private handleReady(value: Record<string, unknown>): void {
    if (this.readyDeferred.settled || value.schemaVersion !== CLIENT_DB_READER_SCHEMA_VERSION) {
      this.failService(protocolResponseError("invalid_ready_message"), true);
      return;
    }
    if (this.lifecycle !== "starting" && this.lifecycle !== "closing") {
      this.failService(protocolResponseError("unexpected_ready_message"), true);
      return;
    }
    if (this.lifecycle === "starting") {
      this.lifecycle = "ready";
    }
    this.clearReadyTimer();
    this.readyDeferred.resolve(null);
  }

  /** 校验命令关联信息，以原租约 W 诊断并完成请求，不信任 Worker 归属。 */
  private async handleQueryResponse(value: Record<string, unknown>): Promise<void> {
    const commandId = readProtocolId(value.commandId);
    const requestId = readProtocolId(value.requestId);
    const timings = readTimings(value.timings);
    if (!commandId || !requestId || !timings) {
      this.failService(protocolResponseError("invalid_query_response"), true);
      return;
    }
    const pending = this.pending.get(commandId);
    if (!pending || pending.requestId !== requestId) {
      this.failService(protocolResponseError("query_response_mismatch"), true);
      return;
    }

    if (value.type === "result") {
      if (!isListIntakesResult(value.result)) {
        this.failService(protocolResponseError("invalid_query_result"), true);
        return;
      }
      const diagnosticError = await this.invokeDiagnostic({
        operation: "listIntakes",
        outcome: "success",
        commandId,
        requestId,
        workspaceId: pending.workspaceId,
        ...timings,
      });
      if (diagnosticError) {
        this.rejectPending(commandId, diagnosticError);
        return;
      }
      this.resolvePending(commandId, value.result as ClientDbReaderListIntakesResult);
      return;
    }

    const queryError = readWorkerError(value.error);
    if (!queryError) {
      this.failService(protocolResponseError("invalid_query_error"), true);
      return;
    }
    const contextualError = withCommandContext(queryError, commandId, requestId, timings, pending.workspaceId);
    const diagnosticError = await this.invokeDiagnostic({
      operation: "listIntakes",
      outcome: "failed",
      commandId,
      requestId,
      workspaceId: pending.workspaceId,
      errorCode: contextualError.code,
      rootCause: contextualError.details,
      ...timings,
    }, contextualError);
    this.rejectPending(commandId, diagnosticError ?? contextualError);
  }

  /** 处理关闭成功或失败回执，仅接受当前关闭 commandId。 */
  private handleCloseResponse(value: Record<string, unknown>): void {
    const commandId = readProtocolId(value.commandId);
    const deferred = this.closeDeferred;
    if (!commandId || commandId !== this.closeCommandId || !deferred || deferred.settled) {
      this.failService(protocolResponseError("close_response_mismatch"), true);
      return;
    }
    if (value.type === "closed") {
      deferred.resolve();
      return;
    }
    const error = readWorkerError(value.error) ?? protocolResponseError("invalid_close_error");
    deferred.reject(error);
  }

  /** 处理线程退出；非正常关闭一律转为终态失败并拒绝全部请求。 */
  private handleExit(code: number): void {
    this.exitDeferred.resolve(code);
    if (this.lifecycle === "closed") return;
    if (this.lifecycle === "closing" && this.closeDeferred?.settled && code === 0) return;
    if (this.lifecycle === "failed") return;
    this.failService(workerRuntimeError(undefined, "worker_exit", code));
  }

  /** 诊断拒绝及描述失败均交回原请求，query 与 writer 原值只保存在 cause。 */
  private async invokeDiagnostic(
    diagnostic: ClientDbReaderDiagnostic,
    queryError?: ClientDbReaderError,
  ): Promise<ClientDbReaderError | null> {
    try {
      await this.synchronous(() => this.onDiagnostic?.(diagnostic));
      return null;
    } catch (error) {
      const causes: unknown[] = queryError ? [queryError, error] : [error];
      const callbackDetails: Record<string, unknown> = { diagnosticCallbackFailed: true };
      try { Object.assign(callbackDetails, safeRuntimeDetails(error)); }
      catch (descriptionError) {
        callbackDetails.diagnosticDescriptionFailed = true;
        causes.push(descriptionError);
      }
      const cause = causes.length === 1 ? error : new AggregateError(causes,
        "CLIENT_DB_READER_DIAGNOSTIC_FAILED", { cause: queryError ?? error });
      if (queryError) {
        return new ClientDbReaderError(queryError.code, queryError.message, {
          ...callbackDetails,
          ...queryError.details,
        }, { cause });
      }
      return createServiceError("CLIENT_DB_READER_DIAGNOSTIC_FAILED", {
        commandId: diagnostic.commandId,
        requestId: diagnostic.requestId,
        workspaceId: diagnostic.workspaceId,
        queueMs: diagnostic.queueMs,
        dbMs: diagnostic.dbMs,
        ...callbackDetails,
      }, { cause });
    }
  }

  /** 把服务转为失败终态，拒绝 ready、关闭等待和全部在途命令。 */
  private failService(error: ClientDbReaderError, terminate = false): void {
    const firstFailure = this.terminalError === null;
    const reportRuntimeFatal = firstFailure && this.hasReachedReady && this.lifecycle === "ready";
    if (firstFailure) this.terminalError = error;
    this.lifecycle = "failed";
    this.clearReadyTimer();
    if (reportRuntimeFatal) {
      const onlyPending = this.pending.size === 1 ? [...this.pending.values()][0] : null;
      const fatalError = onlyPending
        ? withCommandContext(this.requireTerminalError(), onlyPending.commandId, onlyPending.requestId, undefined, onlyPending.workspaceId)
        : new ClientDbReaderError(error.code, error.message, {
            ...this.requireTerminalError().details,
            pendingCount: this.pending.size,
          });
      this.reportFatalError(fatalError);
    }
    const terminalError = this.requireTerminalError();
    if (!this.readyDeferred.settled) this.readyDeferred.resolve(terminalError);
    if (this.closeDeferred && !this.closeDeferred.settled) this.closeDeferred.reject(terminalError);
    for (const pending of [...this.pending.values()]) {
      this.rejectPending(
        pending.commandId,
        withCommandContext(terminalError, pending.commandId, pending.requestId, undefined, pending.workspaceId),
      );
    }
    if (terminate) this.requestTermination();
  }

  /** 将 ready 后的首次终态失败交给应用日志边界；回调异常并入终态错误。 */
  private reportFatalError(error: ClientDbReaderError): void {
    try {
      this.onFatalError(error);
    } catch (cause) {
      this.terminalError = new ClientDbReaderError(error.code, error.message, {
        ...error.details,
        fatalErrorHandlerFailed: true,
        ...safeRuntimeDetails(cause),
      });
    }
  }

  /** 请求强制终止畸形 Worker，并把终止失败留给 close 显式返回。 */
  private requestTermination(): void {
    if (this.exitDeferred.settled || this.terminationPromise) return;
    this.terminationPromise = this.worker.terminate();
    this.terminationPromise.then(undefined, (error) => {
      this.terminalError = new ClientDbReaderError(
        this.requireTerminalError().code,
        this.requireTerminalError().message,
        {
          ...this.requireTerminalError().details,
          terminationFailed: true,
          ...safeRuntimeDetails(error),
        },
      );
    });
  }

  /** Worker 失败后等待退出；终止调用异常会在此直接抛出。 */
  private async awaitFailedWorkerExit(): Promise<void> {
    if (this.terminationPromise) {
      try {
        await this.terminationPromise;
      } catch {
        throw this.requireTerminalError();
      }
    }
    if (!this.exitDeferred.settled) await this.exitDeferred.promise;
  }

  /** 在 starting/ready 状态接受请求，其余状态返回稳定失败。 */
  private assertAcceptingRequests(): void {
    if (this.lifecycle === "starting" || this.lifecycle === "ready") return;
    if (this.lifecycle === "closing") throw createServiceError("CLIENT_DB_READER_CLOSING", {});
    if (this.lifecycle === "closed") throw createServiceError("CLIENT_DB_READER_CLOSED", {});
    throw this.requireTerminalError();
  }

  /** 返回已记录终态异常；缺失时构造 Worker runtime 失败。 */
  private requireTerminalError(): ClientDbReaderError {
    return this.terminalError ?? workerRuntimeError(undefined, "worker_failed_without_error");
  }

  /** 等待 ready 终态；失败通过返回值再显式抛出，避免孤立 rejection。 */
  private async waitForReady(): Promise<void> {
    const error = await this.readyDeferred.promise;
    if (error) throw error;
  }

  /** 清除初始化计时器，防止 ready/失败后重复触发终态。 */
  private clearReadyTimer(): void {
    if (!this.readyTimer) return;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  /** 等待 pending Map 归零，不取消或抢占已进入 Worker 的同步 SQL。 */
  private waitForPending(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  /** 等待关闭回执和线程退出；全链路时限由 runClose 统一控制。 */
  private async waitForWorkerClose(): Promise<number> {
    const closeDeferred = this.closeDeferred;
    if (!closeDeferred) throw protocolResponseError("missing_close_deferred");
    await closeDeferred.promise;
    return this.exitDeferred.promise;
  }

  /** 完成成功命令并在最后一个命令结束时唤醒关闭流程。 */
  private resolvePending(commandId: string, result: ClientDbReaderListIntakesResult): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    pending.resolve(result);
    this.resolveDrainWaiters();
  }

  /** 完成失败命令并在最后一个命令结束时唤醒关闭流程。 */
  private rejectPending(commandId: string, error: ClientDbReaderError): void {
    const pending = this.pending.get(commandId);
    if (!pending) return;
    this.pending.delete(commandId);
    pending.reject(error);
    this.resolveDrainWaiters();
  }

  /** pending 清空后一次性释放全部排空等待者。 */
  private resolveDrainWaiters(): void {
    if (this.pending.size > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }
}

/** 解析 Worker 路径：开发态使用 TS 源码，发布态使用同目录 CJS。 */
export function resolveClientDbReaderWorkerPath(configuredPath?: string): string {
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error("配置的 Client DB reader worker 不存在");
  }
  const bundledFile = typeof __filename === "string" ? __filename : "";
  if (bundledFile) {
    const bundledWorker = path.resolve(path.dirname(bundledFile), "clientDbReaderWorker.cjs");
    if (fs.existsSync(bundledWorker)) return bundledWorker;
  }
  const mainFile = path.resolve(String(process.argv[1] ?? ""));
  const distWorker = path.resolve(path.dirname(mainFile), "clientDbReaderWorker.cjs");
  if (fs.existsSync(distWorker)) return distWorker;
  const sourceWorker = path.resolve(process.cwd(), "apps/desktop/client/src/db/clientDbReaderWorker.ts");
  if (fs.existsSync(sourceWorker)) return sourceWorker;
  const localSourceWorker = path.resolve(process.cwd(), "src/db/clientDbReaderWorker.ts");
  if (fs.existsSync(localSourceWorker)) return localSourceWorker;
  throw new Error("找不到 Client DB reader worker");
}

/** 创建单个 Worker；开发态通过 tsx bootstrap，发布态直接执行 CJS。 */
function createClientDbReaderWorker(workerData: ClientDbReaderWorkerData, configuredPath?: string): Worker {
  const workerPath = resolveClientDbReaderWorkerPath(configuredPath);
  if (path.extname(workerPath).toLowerCase() !== ".ts") {
    return new Worker(pathToFileURL(workerPath), { workerData });
  }
  const requireBase = path.resolve(String(process.argv[1] ?? path.join(process.cwd(), "package.json")));
  const require = createRequire(requireBase);
  const tsxApiUrl = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const workerUrl = pathToFileURL(workerPath).href;
  const bootstrapSource = [
    `import { tsImport } from ${JSON.stringify(tsxApiUrl)};`,
    `await tsImport(${JSON.stringify(workerUrl)}, import.meta.url);`,
  ].join("\n");
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrapSource)}`), {
    execArgv: ["--conditions", "development"],
    workerData,
  });
}

/** 创建带重复完成保护的 Promise 控制器。 */
function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve: (value) => {
      if (deferred.settled) return;
      deferred.settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (deferred.settled) return;
      deferred.settled = true;
      rejectPromise(error);
    },
  };
  return deferred;
}

/** 规整生命周期超时，避免零值、负值或异常大值破坏边界。 */
function normalizeTimeout(value: unknown, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(120_000, Math.max(10, Math.floor(numeric)));
}

/** 在一个明确时限内等待 Promise，超时后抛出调用方提供的稳定错误。 */
async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createTimeoutError: () => ClientDbReaderError,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从快照输入读取 requestId，缺失时在发命令前显式失败。 */
function readRequestId(input: unknown): string {
  if (!isRecord(input)) {
    throw createServiceError("CLIENT_DB_READER_INVALID_INPUT", { reason: "invalid_input" });
  }
  const requestId = readProtocolId(input.requestId);
  if (!requestId) {
    throw createServiceError("CLIENT_DB_READER_INVALID_INPUT", { reason: "missing_request_id" });
  }
  return requestId;
}

/** 从 Worker 协议读取稳定错误并忽略协议中的任意原始消息。 */
function readWorkerError(value: unknown): ClientDbReaderError | null {
  if (!isRecord(value) || !CLIENT_DB_READER_ERROR_CODES.has(value.code as ClientDbReaderErrorCode)) return null;
  const code = value.code as ClientDbReaderErrorCode;
  const details = sanitizeWorkerErrorDetails(value.details);
  return new ClientDbReaderError(code, serviceErrorMessage(code), details);
}

/** 解析并校验 Worker 返回的非负 queueMs/dbMs。 */
function readTimings(value: unknown): ClientDbReaderTimings | null {
  if (!isRecord(value)) return null;
  const queueMs = value.queueMs;
  const dbMs = value.dbMs;
  if (typeof queueMs !== "number" || typeof dbMs !== "number") return null;
  if (!Number.isFinite(queueMs) || queueMs < 0 || !Number.isFinite(dbMs) || dbMs < 0) return null;
  return { queueMs, dbMs };
}

/** 校验列表响应的完整结构，阻止畸形 Worker 结果伪装成成功。 */
function isListIntakesResult(value: unknown): value is ClientDbReaderListIntakesResult {
  if (!isRecord(value)
    || !Array.isArray(value.intakes)
    || !value.intakes.every((item) => isRecord(item))
    || typeof value.hasMore !== "boolean"
    || (value.nextCursor !== null && typeof value.nextCursor !== "string")
    || !Array.isArray(value.statusCounts)
    || !value.statusCounts.every(isStatusCount)
    || !isNonNegativeInteger(value.totalCount)
    || !isRecord(value.listMetaById)
    || !Object.values(value.listMetaById).every((item) => isRecord(item))
    || !isRecord(value.listPageMeta)
    || !isNonNegativeInteger(value.listPageMeta.totalCount)
    || typeof value.listPageMeta.cursorScope !== "string") {
    return false;
  }
  if ((value.hasMore && value.nextCursor === null) || (!value.hasMore && value.nextCursor !== null)) return false;
  return value.listPageMeta.totalCount === value.totalCount;
}

/** 校验列表状态计数的标量结构，不重新解释业务枚举。 */
function isStatusCount(value: unknown): boolean {
  return isRecord(value)
    && typeof value.status === "string"
    && typeof value.label === "string"
    && isNonNegativeInteger(value.count);
}

/** 判断有限非负整数，供响应总数和状态计数复用。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 在主线程再次白名单过滤 Worker 错误详情，避免协议替身绕过脱敏边界。 */
function sanitizeWorkerErrorDetails(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const details: Record<string, unknown> = {};
  for (const [key, detail] of Object.entries(value)) {
    if (!SAFE_WORKER_ERROR_DETAIL_KEYS.has(key)) continue;
    if (key === "closeFailure") {
      const closeFailure = sanitizeRuntimeDetailRecord(detail);
      if (Object.keys(closeFailure).length > 0) details[key] = closeFailure;
      continue;
    }
    if (key === "rootCauseMessage") {
      const rootCauseMessage = sanitizeClientDbReaderRootCauseMessage(detail);
      if (rootCauseMessage) details[key] = rootCauseMessage;
      continue;
    }
    if (typeof detail === "number" && Number.isFinite(detail)) details[key] = detail;
    else if (typeof detail === "string" && detail.length <= 256) details[key] = detail;
    else if (typeof detail === "boolean") details[key] = detail;
    else if (Array.isArray(detail)
      && detail.length <= 32
      && detail.every((item) => typeof item === "string" && item.length <= 128)) {
      details[key] = [...detail];
    }
  }
  return details;
}

/** 读取长度受限的 commandId/requestId。 */
function readProtocolId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

/** 为请求错误补充关联 ID 和可信租约 W，保留已有主线程 cause。 */
function withCommandContext(
  error: ClientDbReaderError,
  commandId: string,
  requestId: string,
  timings?: ClientDbReaderTimings,
  workspaceId?: WorkspaceId | null,
): ClientDbReaderError {
  return new ClientDbReaderError(error.code, error.message, {
    ...error.details,
    commandId,
    requestId,
    ...(workspaceId != null ? { workspaceId } : {}),
    ...(timings ?? {}),
  }, Object.hasOwn(error, "cause") ? { cause: error.cause } : undefined);
}

/** 构造主线程错误，消息只由稳定 code 决定，cause 不进入传输字段。 */
function createServiceError(
  code: ClientDbReaderErrorCode,
  details: Record<string, unknown>,
  options?: ErrorOptions,
): ClientDbReaderError {
  return new ClientDbReaderError(code, serviceErrorMessage(code), details, options);
}

/** 构造 Worker runtime 错误，只携带脱敏后的短根因，不携带路径或堆栈。 */
function workerRuntimeError(error: unknown, reason: string, exitCode?: number): ClientDbReaderError {
  return createServiceError("CLIENT_DB_READER_WORKER_FAILED", {
    reason,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
    ...safeRuntimeDetails(error),
  });
}

/** 构造 Worker 响应协议错误，并保留可安全检索的反序列化根因。 */
function protocolResponseError(reason: string, cause?: unknown): ClientDbReaderError {
  return createServiceError("CLIENT_DB_READER_PROTOCOL_INVALID", { reason, ...safeRuntimeDetails(cause) });
}

/** 提取安全的异常类型、短根因与 SQLite/操作系统错误码。 */
function safeRuntimeDetails(error: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
  const sqliteError = /^SQLITE_[A-Z0-9_]{1,48}$/.test(code);
  if (isRecord(error)) {
    const type = String(error.name ?? error.constructor?.name ?? "Error");
    if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(type)) details.rootCauseType = type;
  }
  if (sqliteError) details.sqliteCode = code;
  else if (/^[A-Z][A-Z0-9_]{1,31}$/.test(code)) details.osErrorCode = code;
  const rootCauseMessage = sanitizeClientDbReaderRootCauseMessage(isRecord(error) ? error.message : error);
  if (!sqliteError && rootCauseMessage) details.rootCauseMessage = rootCauseMessage;
  return details;
}

/** 二次白名单过滤 Worker 已脱敏的嵌套 runtime 详情。 */
function sanitizeRuntimeDetailRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const details: Record<string, unknown> = {};
  const rootCauseType = typeof value.rootCauseType === "string" ? value.rootCauseType : "";
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rootCauseType)) details.rootCauseType = rootCauseType;
  const rootCauseMessage = sanitizeClientDbReaderRootCauseMessage(value.rootCauseMessage);
  if (rootCauseMessage) details.rootCauseMessage = rootCauseMessage;
  const sqliteCode = typeof value.sqliteCode === "string" ? value.sqliteCode : "";
  if (/^SQLITE_[A-Z0-9_]{1,48}$/.test(sqliteCode)) details.sqliteCode = sqliteCode;
  const osErrorCode = typeof value.osErrorCode === "string" ? value.osErrorCode : "";
  if (/^[A-Z][A-Z0-9_]{1,31}$/.test(osErrorCode)) details.osErrorCode = osErrorCode;
  return details;
}

/** 返回主线程稳定错误消息，禁止采用跨线程传入的任意文本。 */
function serviceErrorMessage(code: ClientDbReaderErrorCode): string {
  switch (code) {
    case "CLIENT_DB_READER_CLOSED": return "数据库只读 Worker 已关闭";
    case "CLIENT_DB_READER_CLOSING": return "数据库只读 Worker 正在关闭";
    case "CLIENT_DB_READER_CLOSE_FAILED": return "数据库只读 Worker 关闭失败";
    case "CLIENT_DB_READER_DIAGNOSTIC_FAILED": return "数据库只读诊断回调失败";
    case "CLIENT_DB_READER_INIT_FAILED": return "数据库只读 Worker 初始化失败";
    case "CLIENT_DB_READER_INVALID_INPUT": return "数据库只读查询参数无效";
    case "CLIENT_DB_READER_PROTOCOL_INVALID": return "数据库只读 Worker 协议无效";
    case "CLIENT_DB_READER_QUERY_FAILED": return "数据库只读查询失败";
    case "CLIENT_DB_READER_SCHEMA_INVALID": return "数据库只读 Worker 所需结构无效";
    case "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH": return "数据库版本与只读 Worker 不匹配";
    case "CLIENT_DB_READER_WORKER_FAILED": return "数据库只读 Worker 异常退出";
    case "ORCH_INTAKE_LIST_SNAPSHOT_INVALID": return "需求列表只读快照无效";
    case "ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID": return "实例摘要投影无效";
  }
}

/** 判断普通对象，供跨线程消息做最小结构校验。 */
function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
