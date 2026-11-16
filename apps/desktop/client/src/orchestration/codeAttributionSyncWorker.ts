import crypto from "node:crypto";
import type { ClientDb } from "../db/clientDb.js";
import type { WorkspaceId } from "@codeflowai/shared";
import type { WorkspaceLogEntry } from "../logger.js";

import {
  CodeAttributionOutboxRepoError,
  type ClaimedCodeAttributionBatch,
  type CodeAttributionOutboxRepo,
} from "../db/repos/codeAttributionOutboxRepo.js";
import {
  CodeAttributionHttpTransportError,
  type CodeAttributionHttpTransport,
} from "./codeAttributionHttpTransport.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_LEASE_MS = 90_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export type CodeAttributionSyncLogger = {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
};

export type CodeAttributionSyncWorkerOptions = {
  leaseOwner?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  now?: () => number;
  listWorkspaceIds?: () => Iterable<string>;
  /** 来自统一需求入口；缺少需求时不读取 outbox。 */
  hasDemand?: (workspaceId: string) => boolean;
  /** 同步数据库段进入统一 writer 许可；网络请求期间不持许可。 */
  withDatabase?<T>(operation: () => T): Promise<T>;
  logger: CodeAttributionSyncLogger;
  workspaceId?: WorkspaceId;
  writeWorkspaceLog?: ClientDb["writeWorkspaceLog"];
  onFatalError(error: unknown): void | Promise<void>;
};

export type CodeAttributionSyncRunResult = "uploaded" | "idle" | "failed";

/** Drains the local attribution outbox with one lease owner and a stoppable non-overlapping timer. */
export class CodeAttributionSyncWorker {
  private readonly leaseOwner: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeRun: (Promise<CodeAttributionSyncRunResult> & { result?: PromiseSettledResult<CodeAttributionSyncRunResult> }) | null = null;
  private stopped = true;

  /** 根实例沿注册W领取；显式单仓储构造保留既有兼容入口。 */
  constructor(source: ClientDb, transport: CodeAttributionHttpTransport, options: CodeAttributionSyncWorkerOptions);
  constructor(source: CodeAttributionOutboxRepo, transport: CodeAttributionHttpTransport,
    options: CodeAttributionSyncWorkerOptions & { workspaceId: WorkspaceId; writeWorkspaceLog: ClientDb["writeWorkspaceLog"] });
  constructor(
    private readonly source: CodeAttributionOutboxRepo | ClientDb,
    private readonly transport: CodeAttributionHttpTransport,
    private readonly options: CodeAttributionSyncWorkerOptions,
  ) {
    if (!("forWorkspace" in source) && (!options.workspaceId || !options.writeWorkspaceLog)) throw new TypeError("CODE_ATTRIBUTION_SYNC_REPOSITORY_SCOPE_REQUIRED");
    this.leaseOwner = options.leaseOwner ?? `code-attribution-sync:${process.pid}:${crypto.randomUUID()}`;
    this.pollIntervalMs = positiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
    this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
    this.now = options.now ?? Date.now;
  }

  /** 启动唯一timer；未消费的失败阻止新派发，重复启动不创建并行轮询。 */
  start(): void {
    if (!this.stopped) return;
    if (this.activeRun?.result?.status === "rejected") throw this.activeRun.result.reason;
    this.stopped = false;
    this.schedule(0);
  }

  /** 停timer后等待原上传/fatal尾链并显式消费失败，不强杀已派发HTTP。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = this.activeRun;
    try { if (run) await run; }
    finally { if (this.activeRun === run) this.activeRun = null; }
  }

  /** Executes at most one leased batch; persistence failures remain visible to the caller. */
  runOnce(): Promise<CodeAttributionSyncRunResult> {
    if (this.activeRun) return this.activeRun;
    const run = this.executeOnce();
    this.retainRun(run);
    return run;
  }

  /** 原 activeRun 保留拒绝到 stop；成功仅释放当前任务，不覆盖 timer 尾链。 */
  private retainRun(run: Promise<CodeAttributionSyncRunResult>): void {
    const owner = run as NonNullable<typeof this.activeRun>;
    this.activeRun = owner;
    void owner.then(value => { owner.result = { status: "fulfilled", value }; if (this.activeRun === owner) this.activeRun = null; },
      reason => { owner.result = { status: "rejected", reason }; });
  }

  /** Claims, uploads, and settles one immutable outbox record. */
  private async executeOnce(): Promise<CodeAttributionSyncRunResult> {
    const now = this.now();
    let claimed: ClaimedCodeAttributionBatch | null = null;
    let outbox: CodeAttributionOutboxRepo | undefined;
    let ownerWorkspaceId: WorkspaceId | null = "forWorkspace" in this.source ? this.source.workspaceId ?? null : this.options.workspaceId!;
    try {
      const source = this.source;
      const workspaceIds = await this.withDatabase(() => Array.from("forWorkspace" in source && !source.workspaceId
        ? this.options.listWorkspaceIds?.() ?? source.workspaces.list().map(workspace => workspace.id)
        : [null]));
      for (const workspaceId of workspaceIds) {
        ownerWorkspaceId = workspaceId ?? ("forWorkspace" in source ? source.workspaceId ?? null : this.options.workspaceId!);
        if (!ownerWorkspaceId || this.options.hasDemand?.(ownerWorkspaceId) !== true) continue;
        const repository = await this.withDatabase(() => "forWorkspace" in source
          ? (workspaceId === null ? source : source.forWorkspace(workspaceId)).codeAttributionOutbox : source);
        const expired = await this.withDatabase(() => this.options.hasDemand?.(ownerWorkspaceId!) === true
          ? repository.getNextAssociationToRenew({ now, leaseMs: this.leaseMs }) : null);
        if (expired) {
          if (this.options.hasDemand?.(ownerWorkspaceId) !== true) return "idle";
          if (!this.transport.renewAssociation) throw new Error("CODE_ATTRIBUTION_ASSOCIATION_RENEWAL_UNAVAILABLE");
          const association = await this.transport.renewAssociation({ associationId: expired.associationId, sourceWorkspaceId: expired.workspaceId, sourceInstanceId: expired.instanceId });
          if (this.options.hasDemand?.(ownerWorkspaceId) !== true) return "idle";
          await this.withDatabase(() => repository.enqueue({ ...expired, associationId: association.associationId, associationExpiresAt: association.expiresAt, now: this.now() }));
        }
        if (this.options.hasDemand?.(ownerWorkspaceId) !== true) return "idle";
        claimed = await this.withDatabase(() => this.options.hasDemand?.(ownerWorkspaceId!) === true
          ? repository.claimNext({ leaseOwner: this.leaseOwner, now: this.now(), leaseMs: this.leaseMs }) : null);
        if (claimed) { outbox = repository; break; }
      }
    } catch (error) {
      await this.writeLog(ownerWorkspaceId, error instanceof CodeAttributionOutboxRepoError && error.code === "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED" ? "warn" : "error", {
        event: { category: "code_attribution", action: "claim", outcome: "fail" }, requestId: `${this.leaseOwner}:${now}`,
        errorCode: error instanceof CodeAttributionOutboxRepoError ? error.code : "CODE_ATTRIBUTION_SYNC_CLAIM_FAILED", rootCause: safeError(error),
      }, "code attribution claim failed", { reason: error });
      if (error instanceof CodeAttributionOutboxRepoError
        && error.code === "CODE_ATTRIBUTION_OUTBOX_ASSOCIATION_EXPIRED") {
        return "failed";
      }
      throw error;
    }
    if (!claimed || !outbox) return "idle";

    const context = {
      requestId: `${this.leaseOwner}:${now}`,
      outboxId: claimed.record.id,
      sourceBatchId: claimed.record.sourceBatchId,
      workspaceId: claimed.record.workspaceId,
      instanceId: claimed.record.instanceId,
      commitSha: claimed.record.commitSha,
      attemptCount: claimed.record.attemptCount,
    };
    if (this.options.hasDemand?.(claimed.record.workspaceId) !== true) {
      const cancelledAt = this.now();
      await this.withDatabase(() => outbox!.markFailed({ id: claimed!.record.id, leaseOwner: this.leaseOwner,
        contentSha256: claimed!.record.contentSha256, errorCode: "CODE_ATTRIBUTION_DEMAND_CANCELLED", retryAt: cancelledAt + 1, now: cancelledAt }));
      return "idle";
    }
    let receipt: Awaited<ReturnType<CodeAttributionHttpTransport["upload"]>>;
    try { receipt = await this.transport.upload(claimed.batch); }
    catch (error) {
      await this.writeLog(ownerWorkspaceId, "warn", { event: { category: "code_attribution", action: "upload", outcome: "fail" },
        ...context, errorCode: error instanceof CodeAttributionHttpTransportError ? error.serverCode ?? error.code : "CODE_ATTRIBUTION_SYNC_UPLOAD_FAILED",
        rootCause: safeError(error), ...(error instanceof CodeAttributionHttpTransportError ? { serverRequestId: error.requestId, httpStatus: error.status, retryable: classifyTransportFailure(error) === "retry" } : {}),
      }, "code attribution batch synchronization failed", { reason: error });
      if (!(error instanceof CodeAttributionHttpTransportError)) throw error;
      const failedAt = this.now();
      const decision = classifyTransportFailure(error);
      const errorCode = error.serverCode ?? error.code;
      try {
        await this.withDatabase(() => {
          if (decision === "association_expired" || decision === "terminal") {
            outbox!.markTerminalFailure({
              id: claimed!.record.id,
              leaseOwner: this.leaseOwner,
              contentSha256: claimed!.record.contentSha256,
              errorCode,
              associationExpired: decision === "association_expired",
              now: failedAt,
            });
          } else {
            const retryAt = Math.min(
              failedAt + retryDelayMs(claimed!.record.attemptCount),
              claimed!.record.associationExpiresAt,
            );
            if (retryAt <= failedAt) {
              outbox!.markTerminalFailure({
                id: claimed!.record.id,
                leaseOwner: this.leaseOwner,
                contentSha256: claimed!.record.contentSha256,
                errorCode: "ORCH_METRICS_DELIVERY_ASSOCIATION_EXPIRED",
                associationExpired: true,
                now: failedAt,
              });
            } else {
              outbox!.markFailed({
                id: claimed!.record.id,
                leaseOwner: this.leaseOwner,
                contentSha256: claimed!.record.contentSha256,
                errorCode,
                retryAt,
                now: failedAt,
              });
            }
          }
        });
      } catch (settlementError) {
        const failure = new AggregateError([error, settlementError], "CODE_ATTRIBUTION_SYNC_FAILURE_SETTLEMENT_FAILED", { cause: error });
        await this.writeLog(ownerWorkspaceId, "error", { ...context, errorCode: "CODE_ATTRIBUTION_SYNC_FAILURE_SETTLEMENT_FAILED", rootCause: safeError(settlementError) }, "code attribution failure settlement failed", { reason: failure });
        throw failure;
      }
      return "failed";
    }
    try { await this.withDatabase(() => outbox!.deleteSucceeded({ id: claimed!.record.id, leaseOwner: this.leaseOwner, contentSha256: claimed!.record.contentSha256, now: this.now() })); }
    catch (error) {
      await this.writeLog(ownerWorkspaceId, "error", { ...context, errorCode: "CODE_ATTRIBUTION_SYNC_SETTLEMENT_FAILED", rootCause: safeError(error) }, "code attribution settlement failed", { reason: error });
      throw error;
    }
    await this.writeLog(ownerWorkspaceId, "info", { event: { category: "code_attribution", action: "upload", outcome: "success" },
      ...context, reconciliationStatus: receipt.reconciliationStatus }, "code attribution batch synchronized");
    return "uploaded";
  }

  /** 每段同步数据库操作独立取得许可，不跨上传等待持锁。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.options.withDatabase ? this.options.withDatabase(operation) : operation();
  }

  /** 日志归属只取领取来源，payload 中的 workspaceId 不改变固定 writer。 */
  private async writeLog(workspaceId: WorkspaceId | null, level: WorkspaceLogEntry["level"], data: Record<string, unknown>, message: string, business?: { reason: unknown }): Promise<void> {
    await this.withDatabase(() => {
      try {
        if (workspaceId) {
          const write = "forWorkspace" in this.source ? this.source.writeWorkspaceLog : this.options.writeWorkspaceLog!;
          write(workspaceId, { level, tag: "code-attribution-sync", message, data: {
            event: { category: "code_attribution", action: message.replaceAll(" ", "."), outcome: level === "info" ? "success" : "fail" }, ...data, workspaceId,
          } });
        } else this.options.logger[level === "debug" ? "info" : level](data, message);
      } catch (error) {
        throw Object.assign(new AggregateError(business ? [business.reason, error] : [error], "CODE_ATTRIBUTION_SYNC_LOG_FAILED", { cause: business ? business.reason : error }),
          { code: "CODE_ATTRIBUTION_SYNC_LOG_FAILED", workspaceId });
      }
    });
  }

  /** Schedules the next poll unless stop or a fatal persistence failure has occurred. */
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
        catch (callbackError) { throw new AggregateError([error, callbackError], "CODE_ATTRIBUTION_SYNC_FATAL_CALLBACK_FAILED", { cause: error }); }
        throw error;
      });
      this.retainRun(tail);
    }, delayMs);
    this.timer.unref?.();
  }
}

/** Classifies only explicit protocol failures; unknown errors remain fatal. */
function classifyTransportFailure(
  error: CodeAttributionHttpTransportError,
): "retry" | "terminal" | "association_expired" {
  if (error.serverCode === "ORCH_METRICS_DELIVERY_ASSOCIATION_EXPIRED" || error.status === 410) {
    return "association_expired";
  }
  if (
    error.code === "CODE_ATTRIBUTION_SYNC_CONFIG_INVALID"
    || error.code === "CODE_ATTRIBUTION_SYNC_REQUEST_INVALID"
    || error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_TOO_LARGE"
    || error.code === "CODE_ATTRIBUTION_SYNC_RESPONSE_INVALID"
  ) {
    return "terminal";
  }
  if (error.status !== null && [400, 409, 413, 422].includes(error.status)) return "terminal";
  return "retry";
}

/** Calculates bounded exponential retry delay from the persisted attempt count. */
function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * (2 ** exponent));
}

/** Requires a positive safe worker duration. */
function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`代码归因同步配置无效：${field}`);
  }
  return value;
}

/** 只投影固定诊断码；未知异常不读取属性或转换正文，保留原失败。 */
function safeError(error: unknown): Record<string, string> {
  if (error instanceof CodeAttributionOutboxRepoError || error instanceof CodeAttributionHttpTransportError) return { name: error.name, code: error.code };
  return { name: error instanceof Error ? "Error" : "NonError", code: "CODE_ATTRIBUTION_SYNC_OPERATION_FAILED" };
}
