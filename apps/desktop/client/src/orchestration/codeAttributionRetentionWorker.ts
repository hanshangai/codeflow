import crypto from "node:crypto";

import {
  countOrchestrationCodeAttributionMatches,
  type OrchestrationMetricCodeAttributionRetentionIngestInput,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type { WorkspaceLogEntry } from "../logger.js";
import { CodeAttributionRetentionTaskRepoError } from "../db/repos/codeAttributionRetentionTaskRepo.js";
import { readCommitRetentionObservation } from "../git/gitService.js";
import { CodeAttributionHttpTransportError, type CodeAttributionHttpTransport } from "./codeAttributionHttpTransport.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_LEASE_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000;

export type CodeAttributionRetentionLogger = {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
};

export type CodeAttributionRetentionWorkerOptions = {
  leaseOwner?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => number;
  listWorkspaceIds?: () => Iterable<string>;
  /** 来自统一需求入口；无需求不领取任务或读取 Git。 */
  hasDemand?: (workspaceId: string) => boolean;
  /** 同步数据库段进入统一 writer 许可，Git/HTTP 等待不持许可。 */
  withDatabase?<T>(operation: () => T): Promise<T>;
  logger: CodeAttributionRetentionLogger;
  onFatalError(error: unknown): void | Promise<void>;
};

export type CodeAttributionRetentionRunResult = "uploaded" | "idle" | "failed";

/** Observes due Git lineage tasks and uploads only source-code-free retention counts. */
export class CodeAttributionRetentionWorker {
  private readonly leaseOwner: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: (Promise<CodeAttributionRetentionRunResult> & { result?: PromiseSettledResult<CodeAttributionRetentionRunResult> }) | null = null;
  private stopped = true;

  /** 单一worker拥有全部W来源的timer和在途观察，禁止为每库另建后台实例。 */
  constructor(
    private readonly db: ClientDb,
    private readonly transport: CodeAttributionHttpTransport,
    private readonly options: CodeAttributionRetentionWorkerOptions,
  ) {
    this.leaseOwner = options.leaseOwner ?? `code-attribution-retention:${process.pid}:${crypto.randomUUID()}`;
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
    this.now = options.now ?? Date.now;
  }

  /** 未消费的失败阻止重启，唯一timer保持原不重叠轮询。 */
  start(): void {
    if (!this.stopped) return;
    if (this.activeRun?.result?.status === "rejected") throw this.activeRun.result.reason;
    this.stopped = false;
    this.schedule(0);
  }

  /** 停timer后等原Git/HTTP与fatal回调尾链，失败显式消费，不强杀在途观察。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.activeRun;
    try { if (run) await run; }
    finally { if (this.activeRun === run) this.activeRun = null; }
  }

  /** Executes at most one due task and preserves lease failures for the caller. */
  runOnce(): Promise<CodeAttributionRetentionRunResult> {
    if (this.activeRun) return this.activeRun;
    const run = this.executeOnce();
    this.retainRun(run);
    return run;
  }

  /** 原 activeRun 保留失败到 stop，成功释放当前尾链，不建另一失败记录。 */
  private retainRun(run: Promise<CodeAttributionRetentionRunResult>): void {
    const owner = run as NonNullable<typeof this.activeRun>;
    this.activeRun = owner;
    void owner.then(value => { owner.result = { status: "fulfilled", value }; if (this.activeRun === owner) this.activeRun = null; },
      reason => { owner.result = { status: "rejected", reason }; });
  }

  /** Claims, observes, uploads, and settles one file/window task. */
  private async executeOnce(): Promise<CodeAttributionRetentionRunResult> {
    const claimedAt = this.now();
    let task: ReturnType<ClientDb["codeAttributionRetentionTasks"]["claimNext"]> = null;
    let taskDb: ClientDb | undefined;
    let ownerWorkspaceId: WorkspaceId | null = this.db.workspaceId ?? null;
    try {
      const workspaceIds = await this.withDatabase(() => Array.from(this.db.workspaceId ? [this.db.workspaceId]
        : this.options.listWorkspaceIds?.() ?? this.db.workspaces.list().map(workspace => workspace.id)));
      for (const workspaceId of workspaceIds) {
        if (this.options.hasDemand?.(workspaceId) !== true) continue;
        ownerWorkspaceId = workspaceId;
        const source = await this.withDatabase(() => workspaceId === this.db.workspaceId ? this.db : this.db.forWorkspace(workspaceId));
        task = await this.withDatabase(() => this.options.hasDemand?.(workspaceId) === true
          ? source.codeAttributionRetentionTasks.claimNext({ leaseOwner: this.leaseOwner, now: claimedAt, leaseMs: this.leaseMs }) : null);
        if (task) { taskDb = source; break; }
      }
    } catch (error) {
      await this.writeLog(ownerWorkspaceId, "error", { requestId: `${this.leaseOwner}:${claimedAt}`, errorCode: "CODE_ATTRIBUTION_RETENTION_CLAIM_FAILED", rootCause: safeError(error) }, "code attribution retention claim failed", { reason: error });
      throw error;
    }
    if (!task || !taskDb) return "idle";
    const context = {
      requestId: `${this.leaseOwner}:${claimedAt}`,
      taskId: task.id,
      workspaceId: task.workspaceId,
      instanceId: task.instanceId,
      commitSha: task.commitSha,
      fileIdentitySha256: task.fileIdentitySha256,
      windowDays: task.windowDays,
      attemptCount: task.attemptCount,
    };

    let observation: OrchestrationMetricCodeAttributionRetentionIngestInput;
    try {
      if (task.frozenObservation) {
        observation = task.frozenObservation.observation;
      } else {
        const workspace = await this.withDatabase(() => taskDb!.workspaces.get(task!.workspaceId));
        if (!workspace) throw new Error("留存观察任务关联的工作区不存在");
        const gitObservation = await readCommitRetentionObservation(workspace.path, {
          repositoryPath: task.repositoryPath,
          repository: task.repository,
          commitSha: task.commitSha,
          filePath: task.filePath,
          fileIdentitySha256: task.fileIdentitySha256,
        });
        const observedAt = this.now();
        if (gitObservation.status === "unavailable") {
          observation = {
            observationId: task.id,
            sourceWorkspaceId: task.workspaceId,
            sourceInstanceId: task.instanceId,
            repository: task.repository,
            commitSha: task.commitSha,
            fileIdentitySha256: task.fileIdentitySha256,
            windowDays: task.windowDays,
            stillPresentAiAddedLines: null,
            qualityStatus: "unavailable",
            qualityReasons: [gitObservation.reason],
            retentionEvidenceSha256: null,
            evidenceRef: null,
            observedAt: null,
          };
        } else {
          const stillPresentAiAddedLines = countOrchestrationCodeAttributionMatches(
            task.retainedLines,
            gitObservation.targetCommitLines,
          );
          const evidenceRefHash = sha256(`${task.id}\0${gitObservation.observationRef}\0${gitObservation.evidenceSha256}\0${stillPresentAiAddedLines}`);
          observation = {
            observationId: task.id,
            sourceWorkspaceId: task.workspaceId,
            sourceInstanceId: task.instanceId,
            repository: task.repository,
            commitSha: task.commitSha,
            fileIdentitySha256: task.fileIdentitySha256,
            windowDays: task.windowDays,
            stillPresentAiAddedLines,
            qualityStatus: "complete",
            qualityReasons: [],
            retentionEvidenceSha256: gitObservation.evidenceSha256,
            evidenceRef: `client-code-attribution-retention:${evidenceRefHash}`,
            observedAt,
          };
        }
        observation = (await this.withDatabase(() => taskDb!.codeAttributionRetentionTasks.freezeObservation({
          id: task!.id, leaseOwner: this.leaseOwner, head: gitObservation.observationRef,
          observation, now: this.now(),
        }))).observation;
      }
    } catch (error) {
      const failedAt = this.now();
      await this.writeLog(ownerWorkspaceId, "warn", { event: { category: "code_attribution", action: "retention_observe", outcome: "fail" },
        ...context, errorCode: "CODE_ATTRIBUTION_RETENTION_GIT_OBSERVATION_FAILED", rootCause: safeError(error),
      }, "code attribution retention Git observation failed", { reason: error });
      try { await this.withDatabase(() => taskDb!.codeAttributionRetentionTasks.markFailed({
        id: task!.id,
        leaseOwner: this.leaseOwner,
        errorCode: "CODE_ATTRIBUTION_RETENTION_GIT_OBSERVATION_FAILED",
        retryAt: failedAt + retryDelayMs(task!.attemptCount),
        now: failedAt,
      })); }
      catch (settlementError) {
        const failure = new AggregateError([error, settlementError], "CODE_ATTRIBUTION_RETENTION_FAILURE_SETTLEMENT_FAILED", { cause: error });
        await this.writeLog(ownerWorkspaceId, "error", { ...context, errorCode: "CODE_ATTRIBUTION_RETENTION_FAILURE_SETTLEMENT_FAILED", rootCause: safeError(settlementError) }, "code attribution retention failure settlement failed", { reason: failure });
        throw failure;
      }
      return "failed";
    }

    if (this.options.hasDemand?.(task.workspaceId) !== true) {
      const cancelledAt = this.now();
      await this.withDatabase(() => taskDb!.codeAttributionRetentionTasks.markFailed({
        id: task!.id, leaseOwner: this.leaseOwner, errorCode: "CODE_ATTRIBUTION_DEMAND_CANCELLED", retryAt: cancelledAt + 1, now: cancelledAt,
      }));
      return "idle";
    }
    let receipt: Awaited<ReturnType<CodeAttributionHttpTransport["uploadRetention"]>>;
    try { receipt = await this.transport.uploadRetention(observation); }
    catch (error) {
      await this.writeLog(ownerWorkspaceId, "warn", { event: { category: "code_attribution", action: "retention_upload", outcome: "fail" },
        ...context, errorCode: error instanceof CodeAttributionHttpTransportError ? error.serverCode ?? error.code : "CODE_ATTRIBUTION_RETENTION_UPLOAD_FAILED",
        rootCause: safeError(error), ...(error instanceof CodeAttributionHttpTransportError ? { serverRequestId: error.requestId, httpStatus: error.status, retryable: !isTerminalTransportFailure(error) } : {}),
      }, "code attribution retention observation synchronization failed", { reason: error });
      if (!(error instanceof CodeAttributionHttpTransportError)) throw error;
      const failedAt = this.now();
      const errorCode = error.serverCode ?? error.code;
      try {
        await this.withDatabase(() => {
          if (isTerminalTransportFailure(error)) {
            taskDb!.codeAttributionRetentionTasks.markTerminalFailure({
              id: task!.id,
              leaseOwner: this.leaseOwner,
              errorCode,
              now: failedAt,
            });
          } else {
            taskDb!.codeAttributionRetentionTasks.markFailed({
              id: task!.id,
              leaseOwner: this.leaseOwner,
              errorCode,
              retryAt: failedAt + retryDelayMs(task!.attemptCount),
              now: failedAt,
            });
          }
        });
      } catch (settlementError) {
        const failure = new AggregateError([error, settlementError], "CODE_ATTRIBUTION_RETENTION_FAILURE_SETTLEMENT_FAILED", { cause: error });
        await this.writeLog(ownerWorkspaceId, "error", { ...context, errorCode: "CODE_ATTRIBUTION_RETENTION_FAILURE_SETTLEMENT_FAILED", rootCause: safeError(settlementError) }, "code attribution retention failure settlement failed", { reason: failure });
        throw failure;
      }
      return "failed";
    }
    try { await this.withDatabase(() => taskDb!.codeAttributionRetentionTasks.deleteSucceeded({ id: task!.id, leaseOwner: this.leaseOwner, now: this.now() })); }
    catch (error) {
      await this.writeLog(ownerWorkspaceId, "error", { ...context, errorCode: "CODE_ATTRIBUTION_RETENTION_SETTLEMENT_FAILED", rootCause: safeError(error) }, "code attribution retention settlement failed", { reason: error });
      throw error;
    }
    await this.writeLog(ownerWorkspaceId, "info", { event: { category: "code_attribution", action: "retention_upload", outcome: "success" },
      ...context, qualityStatus: receipt.qualityStatus }, "code attribution retention observation synchronized");
    return "uploaded";
  }

  /** 每段同步数据库操作独立取得许可，不跨 Git 和上传等待持锁。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.options.withDatabase ? this.options.withDatabase(operation) : operation();
  }

  /** 逐 W 领取来源决定日志落点；无来源的全局枚举失败保原应用边界。 */
  private async writeLog(workspaceId: WorkspaceId | null, level: WorkspaceLogEntry["level"], data: Record<string, unknown>, message: string, business?: { reason: unknown }): Promise<void> {
    await this.withDatabase(() => {
      try {
        if (workspaceId) this.db.writeWorkspaceLog(workspaceId, { level, tag: "code-attribution-retention", message, data: {
          event: { category: "code_attribution", action: message.replaceAll(" ", "."), outcome: level === "info" ? "success" : "fail" }, ...data, workspaceId,
        } });
        else this.options.logger[level === "debug" ? "info" : level](data, message);
      } catch (error) {
        throw Object.assign(new AggregateError(business ? [business.reason, error] : [error], "CODE_ATTRIBUTION_RETENTION_LOG_FAILED", { cause: business ? business.reason : error }),
          { code: "CODE_ATTRIBUTION_RETENTION_LOG_FAILED", workspaceId });
      }
    });
  }

  /** Schedules the next run and stops on an unhandled persistence or implementation failure. */
  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const tail = this.runOnce().then((result) => {
        if (!this.stopped) this.schedule(result === "uploaded" ? 0 : this.pollIntervalMs);
        return result;
      }, async error => {
        this.stopped = true;
        try { await this.options.onFatalError(error); }
        catch (callbackError) { throw new AggregateError([error, callbackError], "CODE_ATTRIBUTION_RETENTION_FATAL_CALLBACK_FAILED", { cause: error }); }
        throw error;
      });
      this.retainRun(tail);
    }, delayMs);
    this.timer.unref?.();
  }
}

/** Treats malformed requests/responses and non-retryable 4xx as terminal. */
function isTerminalTransportFailure(error: CodeAttributionHttpTransportError): boolean {
  if (error.status === 404 && error.serverCode === "NOT_FOUND") return false;
  return error.code === "CODE_ATTRIBUTION_SYNC_CONFIG_INVALID"
    || error.code === "CODE_ATTRIBUTION_SYNC_REQUEST_INVALID"
    || error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_TOO_LARGE"
    || error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID"
    || (error.status !== null && [400, 403, 404, 409, 413, 422].includes(error.status));
}

/** Calculates a bounded retry delay for long-lived observation tasks. */
function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(12, attemptCount - 1));
  return Math.min(MAX_RETRY_DELAY_MS, 60_000 * (2 ** exponent));
}

/** Requires one positive safe worker duration. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`代码留存观察配置无效：${field}`);
  return value;
}

/** Hashes source-code-free observation identity metadata. */
function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/** 只投影固定诊断码；未知异常不读取属性或转换正文，保留原失败。 */
function safeError(error: unknown): Record<string, string> {
  if (error instanceof CodeAttributionRetentionTaskRepoError) return { name: error.name, code: error.code };
  if (!(error instanceof Error)) return { name: "NonError", code: "UNKNOWN_FAILURE" };
  return { name: "Error", code: "GIT_OBSERVATION_FAILED" };
}
