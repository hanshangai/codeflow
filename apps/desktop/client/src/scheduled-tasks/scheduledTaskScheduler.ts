import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  computeNextCronTimeMs,
  normalizeScheduledTaskWorkflowSkipStatuses,
  type ClientScheduledTaskReportRequestBody,
  type ClientScheduledTaskReportResponseBody,
  type ClientScheduledTaskSyncResponseBody,
  type ClientScheduledTaskConfigWritebackRequestBody,
  type ClientScheduledTaskConfigWritebackResponseBody,
  type DesktopAccountScheduledTaskConfig,
  type DesktopAccountScheduledTaskEdit,
  type DesktopAccountScheduledTaskMutation,
  type DesktopAccountScheduledTaskRunsResponseBody,
  type OrchestrationId,
  type OrchestrationStatus,
  type ScheduledTask,
  type LocalScheduledTaskConfig,
  type ScheduledTaskRun,
  type ScheduledTaskScriptPayload,
  type ScheduledTaskWorkflowPayload,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ClientConfig } from "../config.js";
import type { ApiHandlerContext } from "../app/handleApiRequest.js";
import type { LocalScheduledTaskRepos, AccountScheduledTaskRepos } from "../db/clientDb.js";
import { createScheduledWorkflowInstance } from "../app/handlers/orchestrationHandlers.js";
import { terminateCliProcessTree } from "../app/handlers/engineHandlers.js";
import {
  parseMigrationSkipPendingReason,
  scheduledTaskRuntimeKey,
  scheduledTaskAccountRuntimeKey,
  type ScheduledTaskMigrationQueueSkipReason,
} from "../db/repos/scheduledTaskRuntimeStateRepo.js";
import { logger } from "../logger.js";
import { buildClientChildProcessEnv } from "../runtime/clientProcessEnv.js";
import { WorkspaceOperationGateError } from "../workspace-migration/workspaceOperationGate.js";
import { waitForEngineModelCatalogDispatchReady } from "../engines/engineModelCatalogRuntime.js";
import { isDesktopLocalAssetWorkspace } from "../orchestration/desktopBuiltinAssetService.js";
import { ScheduledTaskRunError, assertScheduledTaskAccountOwner, type ScheduledTaskAccountOwner } from "../db/repos/scheduledTaskRunRepo.js";
import { ScheduledTaskConfigError } from "../db/repos/scheduledTaskConfigRepo.js";
import { validateAccountTaskSnapshot } from "./scheduledTaskAccountSnapshot.js";
import { effectiveAccountTask, ScheduledTaskAccountConfigError } from "../db/repos/scheduledTaskAccountConfigRepo.js";

const TICK_INTERVAL_MS = 60_000;
const OUTPUT_EXCERPT_LIMIT = 16 * 1024;
const isolatedLocalConfigScan = Symbol("isolatedLocalConfigScan");
const accountRequestFailure = Symbol("accountRequestFailure");
const isolatedAccountRequestScan = Symbol("isolatedAccountRequestScan");
const deferredAccountScan = Symbol("deferredAccountScan");
/** 账号代际切换只延后扫描；任务执行/回执的同类错误仍按原边界显式失败。 */
function isAccountContextDeferred(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(isAccountContextDeferred);
  const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "message")?.value : undefined;
  return code === "SCHEDULED_TASK_ACCOUNT_NOT_READY" || code === "SCHEDULED_TASK_ACCOUNT_STALE"
    || code === "DESKTOP_CLOUD_OWNER_STALE_OR_UNAVAILABLE" || message === "SCHEDULED_TASK_ACCOUNT_NOT_READY";
}

type ExecutableTask = ScheduledTask | LocalScheduledTaskConfig;
export type ScheduledTaskAccountContext = ScheduledTaskAccountOwner & { generation: number; assertCurrent(): void };

type SchedulerState = {
  tasks: Map<string, ScheduledTask>;
  queuedByTaskId: Map<string, { scheduledAt: number; workspaceId: WorkspaceId | null }>;
  timer: ReturnType<typeof setInterval> | null;
  tickRunning: boolean;
  tickPending: boolean;
};

type ScheduledRunOwner = {
  taskId: string;
  runId: string;
  child: ChildProcess | null;
  updateRequestId: string | null;
  preparationAbort: AbortController;
  stopPromise: Promise<void> | null;
  stopCause: { reason: unknown } | null;
  drainFailure: Error | null;
  runFailure: { reason: unknown } | null;
  accountContext: ScheduledTaskAccountContext | null;
  workspaceId: WorkspaceId | null;
};

/** 唯一定时调度器：桌面读取本机配置，原账号入口保留 Server 同步与上报。 */
export class ScheduledTaskScheduler {
  private readonly httpBase: string;
  private readonly state: SchedulerState = {
    tasks: new Map(),
    queuedByTaskId: new Map(),
    timer: null,
    tickRunning: false,
    tickPending: false,
  };
  private syncPromise: Promise<void> | null = null;
  private syncPending = false;
  private accountSnapshot: ScheduledTaskAccountContext | null = null;
  private tickPromise: Promise<void> | null = null;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly runs = new Map<string, ScheduledRunOwner>();
  private stopping = false;

  constructor(private readonly input: {
    config: ClientConfig;
    deviceId: string;
    apiContext: ApiHandlerContext;
    /** 同步数据库段独立取得写入协调许可，禁止跨网络或引擎等待持有。 */
    withLegacyDatabase?<T>(requestId: string, operation: () => T): Promise<T>;
    /** 只由桌面主入口装配，固定本机资产和执行权威。 */
    localApiContext?: ApiHandlerContext;
    /** 项目自有计划复用分钟 tick，不依赖旧编排资产初始化。 */
    tickProjectTasks?: () => Promise<void>;
    /** 读取桌面生命周期的暂停事实；不持有第二份调度状态。 */
    isTaskAdmissionPaused?: () => boolean;
    /** 从既有账号owner捕获；桌面未关联返回null，本机调度不依赖账号。 */
    captureAccountContext?: () => ScheduledTaskAccountContext | null;
    /** 桌面云端传输保留原owner内存会话；未装配时普通Client沿原Key入口。 */
    requestAccountTasks?: (owner: ScheduledTaskAccountContext, action: "sync" | "report" | "config",
      payload: Pick<ClientScheduledTaskReportRequestBody, "run" | "nextRuns"> | Omit<ClientScheduledTaskConfigWritebackRequestBody, "clientId" | "deviceId">,
      requestId: string) => Promise<ClientScheduledTaskSyncResponseBody | ClientScheduledTaskReportResponseBody | ClientScheduledTaskConfigWritebackResponseBody>;
  }) {
    this.httpBase = toHttpBaseFromWsUrl(input.config.serverWsUrl);
  }

  /** 启动唯一 timer；桌面未隔离故障交原启动 owner，重复调用保原闭包。 */
  start(operation?: { requestId: string; fail(cause: unknown): void }): void {
    if (this.input.tickProjectTasks) this.assertProjectTasksAccepting();
    else this.assertAccepting("启动定时调度");
    if (this.state.timer) return;
    this.state.timer = setInterval(() => {
      const tick = this.syncAndTick("interval", operation?.requestId);
      const tail = tick.catch((error) => {
        if (this.isIsolatedLocalConfigScanFailure(error) || this.isIsolatedAccountRequestScanFailure(error)) return;
        if (operation) {
          try { operation.fail(error); }
          catch (diagnostic) { throw new AggregateError([error, diagnostic], "SCHEDULED_TASK_SCAN_LOG_FAILED", { cause: error }); }
          throw error;
        }
        if (!isScheduledTaskDiagnosticFailure(error) && !(error as {scheduledTaskFailureLogged?:boolean}|null)?.scheduledTaskFailureLogged) {
          try { logger.error("scheduled-tasks", "scheduled task tick failed", { ...toErrorLog(error),
            errorCode: "SCHEDULED_TASK_SCAN_FAILED", event: { category: "scheduled-tasks", action: "local.tick", outcome: "fail" },
            requestId: `scheduled:interval:${Date.now()}`, clientId: this.input.config.clientId, deviceId: this.input.deviceId,
          }); }
          catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_SCAN_LOG_FAILED", { cause: error }), { code: "SCHEDULED_TASK_SCAN_LOG_FAILED" }); }
        }
        throw error;
      });
      this.activeOperations.delete(tick); this.trackOperation(tail);
    }, TICK_INTERVAL_MS);
    this.state.timer.unref?.();
  }

  /** 只认本实例在完整列表读取边界已经安全记录的配置损坏。 */
  isIsolatedLocalConfigScanFailure(error: unknown): boolean {
    return error instanceof ScheduledTaskConfigError && error.code === "SCHEDULED_TASK_CONFIG_CORRUPT"
      && (error as ScheduledTaskConfigError & { [isolatedLocalConfigScan]?: ScheduledTaskScheduler })[isolatedLocalConfigScan] === this
      && (error as ScheduledTaskConfigError & { scheduledTaskFailureLogged?: boolean }).scheduledTaskFailureLogged === true;
  }

  /** 识别本实例已记录请求及其同次安全扫描聚合，未知故障仍向上失败。 */
  isIsolatedAccountRequestScanFailure(error: unknown): boolean {
    return error instanceof Error && (error as Error & { [isolatedAccountRequestScan]?: ScheduledTaskScheduler })[isolatedAccountRequestScan] === this
      && (error as Error & { scheduledTaskFailureLogged?: boolean }).scheduledTaskFailureLogged === true;
  }

  /** 只合并本实例亲历的请求故障；任一存储或诊断副因都阻止整次扫描隔离。 */
  private isAccountRequestFailure(error: unknown): error is Error {
    return error instanceof Error && ((error as Error & { [accountRequestFailure]?: ScheduledTaskScheduler })[accountRequestFailure] === this
      || error instanceof AggregateError && error.errors.length > 0 && error.errors.every(cause => this.isAccountRequestFailure(cause)));
  }

  /** 停止新调度入口，不中断已经运行的任务。 */
  stop(): void {
    this.stopping = true;
    this.state.tickPending = false;
    if (this.state.timer) {
      clearInterval(this.state.timer);
      this.state.timer = null;
    }
  }

  /** 项目检查在后台完成，真正创建引擎工作前必须再次核对关闭边界。 */
  assertProjectTasksAccepting(): void {
    if (this.stopping) throw new Error("Client 正在关闭，不能启动新的知识更新任务");
    this.assertTaskAdmission();
  }

  /** 只在新任务受理前检查更新暂停；已认领运行不因暂停而失败。 */
  private assertTaskAdmission(): void {
    if (this.input.isTaskAdmissionPaused?.()) {
      throw Object.assign(new Error("正在等待更新，新的任务已暂停"), { code: "DESKTOP_UPDATE_TASKS_PAUSED" });
    }
  }

  /** 排空时已返回的配置请求/CAS失败不重复升级；存储和诊断故障仍阻断。 */
  async stopAndDrain(): Promise<void> {
    this.stop();
    try { await this.waitForInFlightWork(); }
    catch (error) {
      const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
      if (failures.length && failures.every(failure => {
        const handled = failure as Error & { stage?: string; scheduledTaskFailureLogged?: boolean };
        return !isScheduledTaskDiagnosticFailure(failure) && handled?.scheduledTaskFailureLogged === true
          && (this.isAccountRequestFailure(failure) && handled.stage === "config_writeback"
            || failure instanceof ScheduledTaskAccountConfigError && failure.code === "SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT"
              && failure.field === "local_revision" && handled.stage === "config_revision");
      })) return;
      if (error instanceof AggregateError) throw error;
      throw new AggregateError([error], "定时任务调度器关闭时有异步任务失败");
    }
  }

  /** 确认更新时同步标记已认领运行，只唤醒准备等待，不取消已创建实例。 */
  beginUpdateStop(requestId: string): void {
    if (!requestId.trim()) throw new Error("SCHEDULED_TASK_UPDATE_STOP_INPUT_INVALID");
    for (const owner of this.runs.values()) {
      owner.updateRequestId ??= requestId;
      owner.preparationAbort.abort();
    }
  }

  /** 确认后停止原脚本并排空全部运行；流程取消始终由外层原入口先完成。 */
  async stopForUpdate(input: { requestId: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = input.timeoutMs ?? 10_000;
    if (!input.requestId.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("SCHEDULED_TASK_UPDATE_STOP_INPUT_INVALID");
    this.beginUpdateStop(input.requestId);
    const owners = [...this.runs.values()];
    const previousFailure = owners.find(owner => owner.drainFailure)?.drainFailure;
    if (previousFailure) throw previousFailure;
    for (const owner of owners) {
      owner.stopPromise ??= this.stopScriptForUpdate(owner, timeoutMs);
    }
    const results = await Promise.allSettled([
      ...owners.map(owner => owner.stopPromise!), this.waitForInFlightWork({ timeoutMs }),
    ]);
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    for (const owner of owners) if (owner.runFailure && !errors.some(error => Object.is(error, owner.runFailure!.reason))) errors.push(owner.runFailure.reason);
    if (errors.length) {
      const stopFailure = errors.find(error => error?.code === "SCHEDULED_TASK_UPDATE_STOP_FAILED");
      if (stopFailure) throw stopFailure;
      const error = Object.assign(new AggregateError(errors, "定时任务更新停止后未完成原上报或清理"), {
        code: "SCHEDULED_TASK_UPDATE_DRAIN_FAILED", requestId: input.requestId,
        taskIds: owners.map(owner => owner.taskId), runIds: owners.map(owner => owner.runId),
      });
      if (errors.some(error => error?.code !== "SCHEDULED_TASK_DRAIN_TIMEOUT")) {
        for (const owner of owners) owner.drainFailure = error;
      }
      if (this.input.localApiContext) {
        try { logger.error("scheduled-tasks", "scheduled update drain failed", {
          code: error.code, requestId: error.requestId, taskIds: error.taskIds, runIds: error.runIds,
          errorCode: error.code, event: { category: "scheduled-tasks", action: "local.update-drain", outcome: "fail" },
          cause: errors.map(cause => toErrorLog(cause).error),
        }); } catch (logError) {
          const failure = Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_EXECUTION_LOG_FAILED", { cause: error }), { code: "SCHEDULED_TASK_EXECUTION_LOG_FAILED" });
          for (const owner of owners) owner.drainFailure = failure;
          throw failure;
        }
      } else logger.error("scheduled-tasks", "scheduled update drain failed", {
        code: error.code, requestId: error.requestId, taskIds: error.taskIds, runIds: error.runIds,
        cause: errors.map(cause => toErrorLog(cause).error),
      });
      throw error;
    }
    for (const owner of owners) this.runs.delete(owner.runId);
  }

  /** 同一脚本只发一次物理停止；失败保留 owner，禁止后续更新把自然退出误当树确认。 */
  private async stopScriptForUpdate(owner: ScheduledRunOwner, timeoutMs: number): Promise<void> {
    if (!owner.child) return;
    const failure = await terminateCliProcessTree(owner.child, {
      timeoutMs, strictTreeConfirmation: true, onFailure: cause => { owner.stopCause ??= { reason: cause }; },
    });
    if (failure === null) return;
    const error = Object.assign(new Error("定时脚本进程树未确认停止", { cause: owner.stopCause?.reason }), {
      code: "SCHEDULED_TASK_UPDATE_STOP_FAILED", requestId: owner.updateRequestId,
      taskId: owner.taskId, runId: owner.runId, reason: failure,
    });
    try {
      const data = {
        code: error.code, requestId: error.requestId, taskId: owner.taskId, runId: owner.runId, reason: failure, ...toErrorLog(error),
      };
      const context = owner.accountContext === null ? this.input.localApiContext! : this.input.apiContext;
      if (owner.workspaceId) (await this.withDatabase(() => context.db.writeWorkspaceLog(owner.workspaceId!,
        { level: "error", tag: "scheduled-tasks", message: "scheduled script update stop failed", data: { ...data, errorCode: error.code,
          event: { category: "scheduled-tasks", action: "script.update-stop", outcome: "fail" }, workspaceId: owner.workspaceId } })));
      else logger.error("scheduled-tasks", "scheduled script update stop failed", data);
    } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_EXECUTION_LOG_FAILED", { cause: error }), { code: "SCHEDULED_TASK_EXECUTION_LOG_FAILED" }); }
    throw error;
  }

  /** 更新只等待原任务，不停止调度器；超时保留原owner供后续排空。 */
  async waitForInFlightWork(options: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error("SCHEDULED_TASK_DRAIN_TIMEOUT_INVALID");
    const errors: unknown[] = [];
    const drained = new Set<Promise<unknown>>();
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    while (true) {
      const operations = [...this.activeOperations].filter(operation => !drained.has(operation));
      if (!operations.length) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let results: PromiseSettledResult<unknown>[];
      try {
        results = deadline === null ? await Promise.allSettled(operations) : await Promise.race([
          Promise.allSettled(operations), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error("定时任务尚未收口"), { code: "SCHEDULED_TASK_DRAIN_TIMEOUT" })), Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      for (const [index, result] of results.entries()) {
        drained.add(operations[index]);
        const settlement = (operations[index] as Promise<unknown> & { result?: PromiseSettledResult<unknown> }).result ?? result;
        // 已明确失败且记录的扫描由原timer重试，排空不将历史模块故障升级为关闭失败。
        if (settlement.status === "rejected" && !this.isIsolatedLocalConfigScanFailure(settlement.reason)
          && !this.isIsolatedAccountRequestScanFailure(settlement.reason)
          && !errors.some(error => Object.is(error, settlement.reason))) errors.push(settlement.reason);
      }
    }
    for (const operation of drained) this.activeOperations.delete(operation);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 0) {
      throw new AggregateError(errors, "定时任务调度器关闭时有异步任务失败");
    }
  }

  /** 握手成功后同步配置并执行当前到点任务；并发调用共享同一 tick owner。 */
  syncAndTick(reason: string, requestId?: string): Promise<void> {
    const rejection = this.rejectIfStopping("同步并执行定时任务");
    if (rejection) return rejection;
    if (this.input.isTaskAdmissionPaused?.()) return Promise.resolve();
    if (this.tickPromise) {
      this.state.tickPending = true;
      return this.tickPromise;
    }

    const tickPromise = this.performSyncAndTick(reason, requestId);
    this.tickPromise = tickPromise;
    this.trackOperation(tickPromise);
    void tickPromise.then(
      () => {
        if (this.tickPromise === tickPromise) this.tickPromise = null;
      },
      () => {
        if (this.tickPromise === tickPromise) this.tickPromise = null;
      },
    );
    return tickPromise;
  }

  /** 同一tick独立处理本机、账号和项目来源；单源失败不阻止其他源且明确返回。 */
  private async performSyncAndTick(reason: string, requestId?: string): Promise<void> {
    this.state.tickRunning = true;
    try {
      do {
        this.state.tickPending = false;
        const results = await Promise.allSettled([
          Promise.resolve().then(() => this.stopping || this.input.isTaskAdmissionPaused?.() ? undefined : this.input.tickProjectTasks?.()),
          (async () => {
            if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
            if (this.input.localApiContext) {
              let tasks: LocalScheduledTaskConfig[];
              try {
                tasks = (await this.withDatabase(() => this.input.localApiContext!.db.listLocalScheduledTaskConfigs({
                  clientId: this.input.config.clientId, deviceId: this.input.deviceId,
                })));
              } catch (error) {
                if (!(error instanceof ScheduledTaskConfigError) || error.code !== "SCHEDULED_TASK_CONFIG_CORRUPT") throw error;
                try {
                  const safe = toErrorLog(error).error;
                  const data = {
                    code: error.code, stage: "local_config_scan", requestId: requestId ?? `scheduled:local_config_scan:${Date.now()}`,
                    clientId: this.input.config.clientId, deviceId: this.input.deviceId,
                    taskId: safe.taskId ?? null, workspaceId: safe.workspaceId ?? null, rootCause: safe,
                    errorCode: error.code, event: { category: "scheduled-tasks", action: "local.config-scan", outcome: "fail" },
                  };
                  // 只有真实 ClientDb 为已知领域错误注入的物理 W 可作为归属。
                  const workspace = Object.getOwnPropertyDescriptor(error, "workspaceId");
                  if (workspace && "value" in workspace && typeof workspace.value === "string") (await this.withDatabase(() => this.input.localApiContext!.db.writeWorkspaceLog(workspace.value as WorkspaceId,
                    { level: "error", tag: "scheduled-tasks", message: "local scheduled task configuration scan failed", data })));
                  else logger.error("scheduled-tasks", "local scheduled task configuration scan failed", data);
                } catch (logError) {
                  throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_SCAN_LOG_FAILED", { cause: error }),
                    { code: "SCHEDULED_TASK_SCAN_LOG_FAILED" });
                }
                Object.assign(error, { scheduledTaskFailureLogged: true, [isolatedLocalConfigScan]: this });
                throw error;
              }
              await this.tick(tasks.filter(task => task.enabled));
            }
          })(),
          (async () => {
            if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
            if (this.input.localApiContext && !this.input.requestAccountTasks) {
              this.clearAccountSnapshot();
              return;
            }
            if (this.input.localApiContext) {
              let captured: ScheduledTaskAccountContext | null | undefined;
              try {
                captured = this.input.captureAccountContext?.();
              } catch (error) {
                if (isAccountContextDeferred(error)) {
                  const logFailure = this.deferAccountScan(error, requestId ?? `scheduled:account:${Date.now()}`);
                  if (logFailure) throw logFailure;
                  return;
                }
                throw error;
              }
              if (!captured) {
                this.clearAccountSnapshot();
                return;
              }
            }
            try {
              await this.syncExclusive(reason).catch(error => {
                if (isAccountContextDeferred(error)) Object.assign(error as object, { [deferredAccountScan]: this });
                throw error;
              });
              if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
              await this.tick();
            }
            catch (error) {
              if (error instanceof Error && (error as Error & { [deferredAccountScan]?: ScheduledTaskScheduler })[deferredAccountScan] === this) {
                const logFailure = this.deferAccountScan(error, requestId ?? `scheduled:account:${Date.now()}`);
                if (logFailure) throw logFailure;
                return;
              }
              if (this.input.localApiContext && this.input.requestAccountTasks && error instanceof Error && !isScheduledTaskDiagnosticFailure(error)) {
                const requestFailure = this.isAccountRequestFailure(error);
                try {
                  const alreadyLogged = (error as Error & { scheduledTaskFailureLogged?: boolean }).scheduledTaskFailureLogged
                    || error instanceof AggregateError && error.errors.every(cause => (cause as { scheduledTaskFailureLogged?: boolean } | null)?.scheduledTaskFailureLogged === true);
                  if (!alreadyLogged) logger.error("scheduled-tasks", "account task scan failed", {
                    errorCode: requestFailure ? "SCHEDULED_TASK_ACCOUNT_REQUEST_FAILED" : "SCHEDULED_TASK_ACCOUNT_SCAN_FAILED",
                    event: { category: "scheduled-tasks", action: "account.scan", outcome: "fail" },
                    requestId: requestId ?? (error as Error & { requestId?: string }).requestId, clientId: this.input.config.clientId, deviceId: this.input.deviceId,
                    rootCause: toErrorLog(error).error,
                  });
                } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_SCAN_LOG_FAILED", { cause: error }), { code: "SCHEDULED_TASK_SCAN_LOG_FAILED" }); }
                Object.assign(error, { scheduledTaskFailureLogged: true, ...(requestFailure ? { [isolatedAccountRequestScan]: this } : {}) });
              }
              throw error;
            }
          })(),
        ]);
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (errors.length === 1) throw errors[0];
        if (errors.length) {
          const combined = new AggregateError(errors, "定时任务多个配置来源执行失败");
          if (errors.every(error => this.isIsolatedLocalConfigScanFailure(error) || this.isIsolatedAccountRequestScanFailure(error))) {
            Object.assign(combined, { scheduledTaskFailureLogged: true, [isolatedAccountRequestScan]: this });
          }
          throw combined;
        }
      } while (!this.stopping && !this.input.isTaskAdmissionPaused?.() && this.state.tickPending);
    } finally {
      this.state.tickRunning = false;
    }
  }

  /** 手动运行指定任务，先同步配置再执行。 */
  runNow(taskId: string): Promise<ScheduledTaskRun> {
    const rejection = this.rejectIfStopping<ScheduledTaskRun>("手动运行定时任务");
    if (rejection) return rejection;
    return this.trackOperation(this.performRunNow(taskId));
  }

  /** 本机手动运行从当前仓储取配置，绝不同步或回退账号任务。 */
  runLocalNow(taskId: string): Promise<ScheduledTaskRun> {
    const rejection = this.rejectIfStopping<ScheduledTaskRun>("手动运行本机定时任务");
    if (rejection) return rejection;
    // 未受理的暂停拒绝不占在途 owner；实际派发前仍由原入口复核竞争。
    try { this.assertTaskAdmission(); }
    catch (error) { return Promise.reject(error); }
    return this.trackOperation(Promise.resolve().then(async () => {
      const task = (await this.withDatabase(() => this.input.localApiContext?.db.getLocalScheduledTask(taskId)));
      if (!task || !task.enabled || task.deletedAt !== null) throw Object.assign(new Error("本机定时任务不存在或已停用"), { code: "SCHEDULED_TASK_LOCAL_UNAVAILABLE", taskId });
      (await this.withDatabase(() => this.assertLocalTask(task)));
      return this.runTask(task, Date.now(), "manual");
    }));
  }

  /** 本机任务必须归属当前设备与真实承载的个人工作区。 */
  private assertLocalTask(task: LocalScheduledTaskConfig): void {
    const ctx = this.input.localApiContext;
    const workspaceId = resolveTaskWorkspaceId(task);
    const workspace = workspaceId ? ctx?.db.workspaces.get(workspaceId) : null;
    if (!ctx?.localWorkspaceOnly || task.clientId !== this.input.config.clientId || task.deviceId !== this.input.deviceId
      || workspaceId && (!isDesktopLocalAssetWorkspace(this.input.config.clientId, ctx.workspaces, workspaceId)
        || !workspace || workspace.path !== ctx.workspaces.get(workspaceId))) {
      throw Object.assign(new Error("本机定时任务归属无效"), { code: "SCHEDULED_TASK_LOCAL_SCOPE_INVALID", taskId: task.id, workspaceId });
    }
  }

  /** 来源固定原权威；只在流程实际执行时取得W仓储及引擎，迁移延期和日志不创建执行owner。 */
  private taskContext(task: ExecutableTask, workflowExecution = false): ApiHandlerContext {
    if (isLocalTask(task)) this.assertLocalTask(task);
    const context = isLocalTask(task) ? this.input.localApiContext! : this.input.apiContext;
    if (!workflowExecution) return context;
    const workspaceId = resolveTaskWorkspaceId(task);
    const workspace = workspaceId ? context.db.workspaces.get(workspaceId) : null;
    if (!workspaceId || !workspace || workspace.path !== context.workspaces.get(workspaceId)) {
      throw Object.assign(new Error("定时任务工作区不存在或未由本机承载"), {
        code: "SCHEDULED_TASK_WORKSPACE_NOT_FOUND", taskId: task.id, workspaceId,
      });
    }
    return { ...context, db: context.db.forWorkspace(workspaceId), orchEngine: context.orchEngine.forWorkspace(workspaceId) };
  }

  /** 手动运行固定受理时owner，配置同步后重新核对身份和停止边界。 */
  private async performRunNow(taskId: string): Promise<ScheduledTaskRun> {
    this.assertTaskAdmission();
    const owner = this.captureAccount();
    await this.syncForCaller("manual");
    this.assertAccountCurrent(owner);
    this.assertAccepting("手动运行定时任务");
    const task = this.state.tasks.get(taskId);
    if (!task) throw new Error(`定时任务不存在或未同步到当前 Client：${taskId}`);
    const workspaceId = resolveTaskWorkspaceId(task);
    const migrationOperationId = workspaceId
      ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null
      : null;
    if (workspaceId && migrationOperationId) {
      throw new WorkspaceOperationGateError(
        "WORKSPACE_MIGRATION_IN_PROGRESS",
        `工作区正在迁移，暂不能手动运行定时任务：taskId=${task.id}`,
        { workspaceId, operationId: migrationOperationId, taskId: task.id },
      );
    }
    return await this.runTask(task, Date.now(), "manual");
  }

  /** 更新前读取本实例全部在途操作，包含没有工作区的脚本和异步上报。 */
  hasInFlightWork(): boolean {
    return this.runs.size > 0 || [...this.activeOperations].some(operation => !(operation as Promise<unknown> & { result?: PromiseSettledResult<unknown> }).result);
  }

  /** 稍后更新只恢复调度受理；同步失败归原后台任务，不阻塞父控制响应。 */
  resumeAfterUpdate(requestId: string): void {
    if (this.input.localApiContext) {
      const operation = Promise.resolve().then(() => {
        const tick = this.syncAndTick("desktop_update_resume"); this.activeOperations.delete(tick); return tick;
      });
      this.dispatchTracked(operation, error => logger.error("scheduled-tasks", "desktop update resumed scheduler task failed", {
        code: "SCHEDULED_TASK_UPDATE_RESUME_FAILED", requestId, clientId: this.input.config.clientId,
        deviceId: this.input.deviceId, ...toErrorLog(error), errorCode: "SCHEDULED_TASK_UPDATE_RESUME_FAILED",
        event: { category: "scheduled-tasks", action: "local.update-resume", outcome: "fail" },
      }));
      return;
    }
    const owner: Promise<unknown> & { result?: PromiseSettledResult<unknown> } = Promise.resolve().then(() => this.syncAndTick("desktop_update_resume"));
    this.activeOperations.add(owner);
    void owner.then(value => {
      owner.result = { status: "fulfilled", value };
      if (!this.stopping) this.activeOperations.delete(owner);
    }, error => {
      owner.result = { status: "rejected", reason: error };
      try {
        logger.error("scheduled-tasks", "desktop update resumed scheduler task failed", {
          code: "SCHEDULED_TASK_UPDATE_RESUME_FAILED", requestId, clientId: this.input.config.clientId,
          deviceId: this.input.deviceId, ...toErrorLog(error),
        });
      } catch (logError) { owner.result = { status: "rejected", reason: new AggregateError([error, logError], "SCHEDULED_TASK_UPDATE_RESUME_FAILED") }; }
    });
  }

  /** 返回指定工作区当前持久化 running 的定时任务。 */
  listRunningByWorkspace(workspaceId: WorkspaceId, operationId = this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null): Array<{ taskId: string; runId: string }> {
    const result = this.input.apiContext.db.listAccountScheduledRunning(workspaceId, operationId);
    const local = this.input.localApiContext;
    if (local) result.push(...local.db.listLocalScheduledRunning(workspaceId,
      { clientId: this.input.config.clientId, deviceId: this.input.deviceId }, operationId));
    return result.sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  /** 迁移释放后重新同步最新配置，并恢复仍有效的持久化 queue_one 触发。 */
  resumeWorkspace(workspaceId: WorkspaceId, operationId: string): void {
    if (this.input.localApiContext) {
      const operation = Promise.resolve().then(() => {
        const tick = this.syncAndTick("workspace_migration_resume"); this.activeOperations.delete(tick); return tick;
      });
      this.dispatchTracked(operation, error => logger.error("scheduled-tasks", "workspace migration queued task resume failed", {
        code: "scheduled_task_migration_queue_resume_failed", workspaceId, operationId, ...toErrorLog(error), requestId: operationId,
        errorCode: "SCHEDULED_TASK_MIGRATION_QUEUE_RESUME_FAILED", event: { category: "scheduled-tasks", action: "local.workspace-resume", outcome: "fail" },
      }));
      return;
    }
    void this.syncAndTick("workspace_migration_resume").catch((error) => {
      logger.error("scheduled-tasks", "workspace migration queued task resume failed", {
        code: "scheduled_task_migration_queue_resume_failed",
        workspaceId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** 从 Server 拉取当前设备的任务配置，并回传 next_run_at。 */
  sync(reason: string): Promise<void> {
    const rejection = this.rejectIfStopping("同步定时任务配置");
    if (rejection) return rejection;
    return this.trackOperation(this.syncForCaller(reason));
  }

  /** 执行一次已接收的配置同步，并保留 tick pending 语义。 */
  private async syncForCaller(reason: string): Promise<void> {
    if (this.state.tickRunning) this.state.tickPending = true;
    await this.syncExclusive(reason);
  }

  /** 明确刷新串行接续原单飞；仅已知配置损坏允许重建，其他失败中止。 */
  refreshAccountConfigs(requestId: string): Promise<void> {
    const rejection = this.rejectIfStopping("重新同步账号任务");
    if (rejection) return rejection;
    return this.trackOperation((async () => {
      if (!this.input.localApiContext) throw new Error("SCHEDULED_TASK_DESKTOP_REQUIRED");
      const owner = this.captureAccount();
      while (this.syncPromise) {
        try { await this.syncPromise; }
        catch (cause) {
          if (!(cause instanceof ScheduledTaskAccountConfigError) || cause.code !== "SCHEDULED_TASK_ACCOUNT_CONFIG_CORRUPT") throw cause;
          // 用户已明确要求重建坏配置；原同步调用仍保留失败，恢复沿当前owner完整快照。
        }
        this.assertAccountCurrent(owner);
      }
      await this.syncExclusive("desktop_config_refresh", { owner, requestId });
    })());
  }

  /** 桌面配置列表只读当前真实owner，返回安全本地修订投影。 */
  listAccountConfigs(): DesktopAccountScheduledTaskConfig[] {
    if (!this.input.localApiContext) throw new Error("SCHEDULED_TASK_DESKTOP_REQUIRED");
    const owner = this.captureAccount();
    return this.input.apiContext.db.listAccountScheduledTaskConfigs(owner).filter(item => item.snapshot.stopIntent !== "deleted")
      .map(({ snapshot }) => ({ task: effectiveAccountTask(snapshot), localRevision: snapshot.localRevision, pending: snapshot.pending.length > 0, stopIntent: snapshot.stopIntent }));
  }

  /** 历史只读当前owner且不返回内部身份/结算，读取不触发同步或补报。 */
  listAccountRuns(query: { taskId?: string; offset: number; limit: number }): DesktopAccountScheduledTaskRunsResponseBody {
    if (!this.input.localApiContext) throw new Error("SCHEDULED_TASK_DESKTOP_REQUIRED");
    const owner = this.captureAccount();
    try {
      const result = this.input.apiContext.db.listAccountScheduledTaskRuns(owner, query); this.assertAccountCurrent(owner);
      return { total: result.total, items: result.items.map(({ serverOrigin: _origin, ownerUserId: _user,
        reportSettlement: _settlement, reportSettledAt: _settled, ...run }) => run) };
    } catch (cause) {
      const known = cause instanceof ScheduledTaskRunError ? cause : null;
      throw this.accountFailure(cause, owner, known?.taskId || query.taskId || "", known?.runId ?? "", "history_read");
    }
  }

  /** 同步编辑先耐久提交本地CAS，再复用原单飞sync完成回写；失败仍返回失败。 */
  reviseAccountConfig(input: DesktopAccountScheduledTaskMutation & { operation: "update" | "delete"; config?: DesktopAccountScheduledTaskEdit }): Promise<DesktopAccountScheduledTaskConfig> {
    return this.trackOperation(this.performAccountConfigRevision(input));
  }

  /** 当前物理归属由ClientDb定位，renderer不能提交owner或落点。 */
  private async performAccountConfigRevision(input: DesktopAccountScheduledTaskMutation & { operation: "update" | "delete"; config?: DesktopAccountScheduledTaskEdit }): Promise<DesktopAccountScheduledTaskConfig> {
    this.assertAccepting("修改账号任务");
    if (!this.input.localApiContext) throw new Error("SCHEDULED_TASK_DESKTOP_REQUIRED");
    const owner = this.captureAccount(), db = this.input.apiContext.db;
    const located = (await this.withDatabase(() => db.listAccountScheduledTaskConfigs(owner).find(item => item.snapshot.task.id === input.taskId)));
    if (!located) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", input.taskId, "task_missing");
    try {
      const queued = this.state.queuedByTaskId.get(input.taskId);
      const staged = (await this.withDatabase(() => db.withAccountScheduledTasks(located.workspaceId, repos => repos.db.transaction(() => {
        this.assertAccountCurrent(owner);
        const saved = repos.accountConfigs.stage(owner, input);
        if (saved.stopIntent !== null) {
          if (queued && queued.workspaceId !== located.workspaceId) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_CONFLICT", input.taskId, "queue_workspace");
          if (queued) this.reconcileAccountQueuedTask(input.taskId, queued.scheduledAt, owner, false, repos);
          const runtime = repos.runtime.getAccount(input.taskId, owner);
          if (runtime?.queuedReason === "workspace_migration" && runtime.queuedScheduledAt !== null && runtime.queuedOperationId) {
            repos.runtime.consumeAccountMigrationSkipped({ taskId: input.taskId, owner, scheduledAt: runtime.queuedScheduledAt, operationId: runtime.queuedOperationId, at: Date.now() });
          }
        }
        return saved;
      })())));
      if (staged.stopIntent !== null) this.state.queuedByTaskId.delete(input.taskId);
      await this.syncExclusive("local_config_revision"); this.assertAccountCurrent(owner);
      const saved = (await this.withDatabase(() => db.listAccountScheduledTaskConfigs(owner).find(item => item.snapshot.task.id === input.taskId)))?.snapshot;
      if (!saved) throw new ScheduledTaskAccountConfigError("SCHEDULED_TASK_ACCOUNT_CONFIG_STORAGE_FAILED", input.taskId, "revision_readback");
      return { task: effectiveAccountTask(saved), localRevision: saved.localRevision, pending: saved.pending.length > 0, stopIntent: saved.stopIntent };
    } catch (cause) { throw this.accountFailure(cause, owner, input.taskId, "", "config_revision"); }
  }

  /** 保存的原首修订逐项回写；丢ACK不换tuple，业务拒绝先丢修订再显式失败。 */
  private async flushAccountConfigRevisions(owner: ScheduledTaskAccountContext): Promise<void> {
    const db = this.input.apiContext.db;
    while (true) {
      this.assertAccountCurrent(owner);
      const located = (await this.withDatabase(() => db.listAccountScheduledTaskConfigs(owner).find(item => item.snapshot.pending.length > 0)));
      if (!located) return;
      const revision = located.snapshot.pending[0]!;
      let ack: ClientScheduledTaskConfigWritebackResponseBody;
      try { ack = await this.requestAccountTasks(owner, "config", revision) as ClientScheduledTaskConfigWritebackResponseBody; }
      catch (cause) {
        this.assertAccountCurrent(owner);
        const fields = cause as { code?: unknown; reason?: unknown; upstreamCode?: unknown } | null;
        if (fields?.code === "SCHEDULED_TASK_API_FAILED" && fields.reason === "rejected_response" && typeof fields.upstreamCode === "string"
          && ["BAD_REQUEST", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "UNAUTHORIZED"].includes(fields.upstreamCode)) {
          try { await this.withDatabase(() => {
            this.assertAccountCurrent(owner);
            db.withAccountScheduledTasks(located.workspaceId, repos => repos.accountConfigs.reject(owner, revision));
          }); }
          catch (storage) { throw new AggregateError([cause, storage], "账号配置拒绝恢复失败", { cause }); }
        }
        throw this.accountFailure(cause, owner, revision.taskId, "", "config_writeback");
      }
      this.assertAccountCurrent(owner);
      await this.withDatabase(() => {
        this.assertAccountCurrent(owner);
        db.withAccountScheduledTasks(located.workspaceId, repos => repos.accountConfigs.acknowledge(owner, revision, ack));
      });
    }
  }

  /** 本机失败及账号诊断失败保留到公开wait消费；观察回调仅结算，不产生诊断副作用。 */
  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    const owner = operation as Promise<T> & { result?: PromiseSettledResult<T> };
    void operation.then(
      value => {
        if (this.input.localApiContext) owner.result = { status: "fulfilled", value };
        if (!this.stopping) this.activeOperations.delete(operation);
      },
      reason => {
        if (this.input.localApiContext || isScheduledTaskDiagnosticFailure(reason)) owner.result = { status: "rejected", reason };
        else if (!this.stopping) this.activeOperations.delete(operation);
      },
    );
    return operation;
  }

  /** 跟踪 tick 脱离任务，同时保留原 Promise 的 rejection 供关闭阶段汇总。 */
  private dispatchTracked<T>(operation: Promise<T>, onRejected: (error: unknown) => void): void {
    this.trackOperation(operation.catch(async error=>{
      try {
        if (!isScheduledTaskDiagnosticFailure(error) && !(error as {scheduledTaskFailureLogged?:boolean}|null)?.scheduledTaskFailureLogged) await this.withDatabase(() => onRejected(error));
      } catch(logError) { throw Object.assign(new AggregateError([error,logError],"SCHEDULED_TASK_DISPATCH_LOG_FAILED",{cause:error}), { code: "SCHEDULED_TASK_DISPATCH_LOG_FAILED" }); }
      throw error;
    }));
  }

  /** 只包围同步数据库工作，保留原调用 Promise 对失败和停止的所有权。 */
  private async withDatabase<T>(operation: () => T): Promise<T> {
    return this.input.withLegacyDatabase
      ? this.input.withLegacyDatabase(`scheduled:database:${crypto.randomUUID()}`, operation)
      : operation();
  }

  /** 已核验任务按可信注册根写W日志；无W或尚未核实归属的诊断保留应用落点。 */
  private writeTaskLog(task: ExecutableTask, level: "error" | "warn" | "info", message: string, data: Record<string, unknown>): void {
    const context = this.taskContext(task), workspaceId = resolveTaskWorkspaceId(task);
    const registeredWorkspace = workspaceId ? context.db.workspaces.get(workspaceId) : null;
    const hostedPath = workspaceId ? context.workspaces.get(workspaceId) : undefined;
    const trustedWorkspace = Boolean(workspaceId && registeredWorkspace && hostedPath && registeredWorkspace.path === hostedPath);
    if (!trustedWorkspace) { logger[level]("scheduled-tasks", message, data); return; }
    const localData = { taskId: task.id, revision: isLocalTask(task) ? task.revision : undefined, requestId: `scheduled:${task.id}:${Date.now()}`, ...data, workspaceId,
      errorCode: data.code ?? (data.error as Record<string, unknown> | undefined)?.systemCode,
      event: { category: "scheduled-tasks", action: message.replaceAll(" ", "."), outcome: level === "error" ? "fail" : level === "warn" ? "warn" : "info" } };
    try {
      if (workspaceId) context.db.writeWorkspaceLog(workspaceId, { level, tag: "scheduled-tasks", message, data: localData });
      else logger[level]("scheduled-tasks", message, localData);
    } catch (logError) {
      if (level === "error") throw logError;
      const reason = Object.assign(new Error(String(data.code)), { code: data.code, taskId: task.id, workspaceId });
      throw Object.assign(new AggregateError([reason, logError], "SCHEDULED_TASK_EXECUTION_LOG_FAILED", { cause: reason }), { code: "SCHEDULED_TASK_EXECUTION_LOG_FAILED" });
    }
  }

  /** 新运行检查准入暂停；已认领运行仍服从停止边界。 */
  private assertAccepting(action: string, accepted = false): void {
    if (this.stopping) throw new Error(`定时任务调度器正在停止，拒绝${action}`);
    if (!accepted) this.assertTaskAdmission();
  }

  /** 对 Promise public 入口返回明确的停止拒绝。 */
  private rejectIfStopping<T = void>(action: string): Promise<T> | null {
    return this.stopping
      ? Promise.reject(new Error(`定时任务调度器正在停止，拒绝${action}`))
      : null;
  }

  /** 合并并发配置同步；由 tick owner 调用时不反向触发 pending。 */
  private async syncExclusive(reason: string, refresh?: { owner: ScheduledTaskAccountContext; requestId: string }): Promise<void> {
    this.syncPending = true;
    if (this.syncPromise) return await this.syncPromise;
    const syncPromise = (async () => {
      try { do {
        this.syncPending = false;
        await this.performSync(reason, refresh ?? null); refresh = undefined;
      } while (this.syncPending); }
      finally { this.syncPromise = null; }
    })();
    this.syncPromise = syncPromise;
    await syncPromise;
  }

  /** 桌面配置先持久回读，再收敛停删和延期并发布；失败不授予本轮执行权。 */
  private async performSync(_reason: string, refresh: { owner: ScheduledTaskAccountContext; requestId: string } | null = null): Promise<void> {
    const owner = this.captureAccount();
    try {
    if (refresh) {
      this.assertAccountCurrent(refresh.owner);
      const response = await this.requestAccountTasks(owner, "sync", {}) as ClientScheduledTaskSyncResponseBody;
      await this.withDatabase(() => {
      const repaired = this.persistAccountSnapshot(owner, response, (error, workspaceId) => {
        this.assertAccountCurrent(refresh.owner);
        try { logger.error("scheduled-tasks", "explicit account config resync rebuilds corrupt row", {
          errorCode: error.code, requestId: refresh.requestId, taskId: error.taskId, workspaceId, field: error.field,
          ownerUserId: owner.ownerUserId, clientId: owner.clientId, deviceId: owner.deviceId,
          event: { category: "scheduled-tasks", action: "account.config.resync", outcome: "fail" }, rootCause: toErrorLog(error).error,
        }); } catch (diagnostic) { throw Object.assign(new AggregateError([error, diagnostic], "SCHEDULED_TASK_REQUEST_LOG_FAILED", { cause: error }), { code: "SCHEDULED_TASK_REQUEST_LOG_FAILED" }); }
      });
      this.publishAccountSnapshot(owner, repaired);
      });
      await this.reconcileMigrationQueuedTaskConfigs();
      this.assertAccountCurrent(owner);
    }
    if (this.input.localApiContext) await this.flushAccountConfigRevisions(owner);
    const response = await this.requestAccountTasks(owner, "sync", {}) as ClientScheduledTaskSyncResponseBody;
    await this.withDatabase(() => {
      const tasks = this.persistAccountSnapshot(owner, response);
      this.publishAccountSnapshot(owner, tasks);
    });
    await this.reconcileMigrationQueuedTaskConfigs();
    this.assertAccountCurrent(owner);
    (await this.withDatabase(() => this.input.apiContext.db.scheduledTaskRuntimeStates.touchConfigSync({
      clientId: this.input.config.clientId,
      deviceId: this.input.deviceId,
      at: Date.now(),
    })));
    await this.reportNextRuns(owner);
    await this.flushAccountRuns(owner);
    } catch (cause) {
      const fields = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
      throw this.accountFailure(cause, owner, typeof fields.taskId === "string" ? fields.taskId : "", typeof fields.runId === "string" ? fields.runId : "", "sync");
    }
  }

  /** 已验证停删先消费原延期再发布；后续网络失败不能使旧分钟在重新启用后复活。 */
  private publishAccountSnapshot(owner: ScheduledTaskAccountContext, tasks: Map<string, ScheduledTask>): void {
    this.assertAccountCurrent(owner);
    const previousTasks = this.state.tasks;
    try {
      const consumed: string[] = [];
      const taskIds = new Set(tasks.keys());
      const sources = new Set(this.input.apiContext.db.listAccountScheduledTaskRunSources(owner, taskIds));
      for (const [taskId, queued] of this.state.queuedByTaskId) {
        if (!previousTasks.get(taskId)?.enabled || !tasks.get(taskId)?.enabled) sources.add(queued.workspaceId);
      }
      for (const workspaceId of sources) {
        this.input.apiContext.db.withAccountScheduledTasks(workspaceId, repos => repos.db.transaction(() => {
          repos.runs.discardMissingAccount(owner, taskIds, Date.now());
          for (const [taskId, queued] of this.state.queuedByTaskId) {
            if (queued.workspaceId === workspaceId && (!previousTasks.get(taskId)?.enabled || !tasks.get(taskId)?.enabled)) {
              this.reconcileAccountQueuedTask(taskId, queued.scheduledAt, owner, false, repos); consumed.push(taskId);
            }
          }
        })(), true);
      }
      for (const taskId of consumed) this.state.queuedByTaskId.delete(taskId);
    } catch (error) {
      // 保留已验证停用观察，恢复时先消费原延期；事务失败仍向调用方明确返回。
      this.state.tasks = tasks; this.accountSnapshot = owner; throw error;
    }
    this.state.tasks = tasks;
    this.accountSnapshot = owner;
  }

  /** 普通同步与明确刷新共用完整校验和落点规则，回调只允许修复已识别坏行。 */
  private persistAccountSnapshot(owner: ScheduledTaskAccountContext, response: ClientScheduledTaskSyncResponseBody,
    onCorrupt?: (error: ScheduledTaskAccountConfigError, workspaceId: WorkspaceId | null) => void): Map<string, ScheduledTask> {
    let tasks = validateAccountTaskSnapshot(response, owner, Boolean(this.input.localApiContext));
    this.assertAccountCurrent(owner);
    if (this.input.localApiContext) {
      for (const task of tasks.values()) {
        const workspaceId = resolveTaskWorkspaceId(task);
        if (workspaceId !== null && !isDesktopLocalAssetWorkspace(owner.clientId, this.input.localApiContext.workspaces, workspaceId)) {
          throw Object.assign(new Error("账号任务工作区不属于当前桌面"), { code: "SCHEDULED_TASK_SYNC_INVALID", taskId: task.id, workspaceId });
        }
      }
      tasks = this.input.apiContext.db.replaceAccountScheduledTaskConfigs(owner, response, onCorrupt ? { onCorrupt } : undefined);
      this.assertAccountCurrent(owner);
    }
    return tasks;
  }

  /** 当前连接缺失或换 owner 时撤掉旧快照和内存延期，不接管历史运行。 */
  private captureAccount(): ScheduledTaskAccountContext {
    try {
      const owner = this.input.captureAccountContext?.();
      if (!owner) throw Object.assign(new Error("账号调度权威未就绪"), { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
      assertScheduledTaskAccountOwner(owner); owner.assertCurrent();
      if ((!this.input.requestAccountTasks && owner.serverOrigin !== this.httpBase) || owner.clientId !== this.input.config.clientId || owner.deviceId !== this.input.deviceId
        || !Number.isSafeInteger(owner.generation) || owner.generation < 0) throw Object.assign(new Error("账号调度权威不匹配"), { code: "SCHEDULED_TASK_ACCOUNT_NOT_READY" });
      if (this.accountSnapshot && !sameAccountContext(this.accountSnapshot, owner)) this.clearAccountSnapshot();
      return owner;
    } catch (error) { this.clearAccountSnapshot(); throw error; }
  }

  /** 只清现有账号配置/延期，不更改本机事实或捕获 owner 的执行历史。 */
  private clearAccountSnapshot(): void {
    this.accountSnapshot = null; this.state.tasks.clear(); this.state.queuedByTaskId.clear();
  }

  /** 账号代际切换只延后本轮账号扫描，等 accountLinked 或下一轮重新同步；日志失败返回显式错误。 */
  private deferAccountScan(error: unknown, requestId: string, taskId?: string): Error | null {
    this.state.tickPending = false;
    this.clearAccountSnapshot();
    try {
      logger.warn("scheduled-tasks", "account task scan deferred", {
        code: "SCHEDULED_TASK_ACCOUNT_DEFERRED",
        requestId,
        taskId: taskId ?? null,
        clientId: this.input.config.clientId,
        deviceId: this.input.deviceId,
        rootCause: toErrorLog(error).error,
        event: { category: "scheduled-tasks", action: "account.scan", outcome: "deferred" },
      });
      return null;
    } catch (logError) {
      return new AggregateError([error, logError], "SCHEDULED_TASK_SCAN_LOG_FAILED", { cause: error });
    }
  }

  /** 每个 await 后重核当次连接、账号和 ready，旧回执不能确认新 owner。 */
  private assertAccountCurrent(owner: ScheduledTaskAccountContext): void {
    owner.assertCurrent();
    if (!sameAccountContext(owner, this.captureAccount())) throw Object.assign(new Error("账号调度连接已变化"), { code: "SCHEDULED_TASK_ACCOUNT_STALE" });
  }

  /** 所有账号执行先验证快照及遗留 running，配置变型也不能绕过。 */
  private accountForTask(task: ScheduledTask): ScheduledTaskAccountContext {
    const owner = this.captureAccount();
    if (!this.accountSnapshot || !sameAccountContext(owner, this.accountSnapshot) || task.ownerUserId !== owner.ownerUserId
      || task.clientId !== owner.clientId || task.deviceId !== owner.deviceId || !this.state.tasks.has(task.id)) throw Object.assign(new Error("账号任务快照不属于当前连接"), { code: "SCHEDULED_TASK_ACCOUNT_STALE", taskId: task.id });
    if (this.input.localApiContext) {
      const current = this.input.apiContext.db.listAccountScheduledTaskConfigs(owner).find(item => item.snapshot.task.id === task.id)?.snapshot;
      if (!current || !current.serverPresent || current.stopIntent !== null) throw Object.assign(new Error("SCHEDULED_TASK_ACCOUNT_UNAVAILABLE：任务已停用或删除"), { code: "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE", taskId: task.id });
    }
    const running = this.input.apiContext.db.readAccountScheduledTaskState(task.id, owner).running?.runtime.runningRunId;
    if (running && !this.runs.has(running)) throw Object.assign(new Error("账号定时任务存在未收口运行，禁止重放"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING", taskId: task.id, runId: running });
    return owner;
  }

  /** 所有账号任务共用严格 owner tuple，本机保持原 key。 */
  private runtimeKey(task: ExecutableTask, owner?: ScheduledTaskAccountContext): string {
    return !isLocalTask(task) ? scheduledTaskAccountRuntimeKey(task.id, owner ?? this.accountForTask(task)) : taskRuntimeKey(task);
  }

  /** 原 sync 是唯一终态发送者；每次 HTTP 与 ACK 前均重读结算并验证 owner。 */
  private async flushAccountRuns(owner: ScheduledTaskAccountContext): Promise<void> {
    const db = this.input.apiContext.db;
    while (true) {
      this.assertAccountCurrent(owner);
      const pending = (await this.withDatabase(() => db.listPendingAccountScheduledTaskRuns(owner))); if (!pending.length) return;
      for (const candidate of pending) {
        this.assertAccountCurrent(owner);
        const located = (await this.withDatabase(() => db.getAccountScheduledTaskRun(candidate.run.id, owner)));
        if (!located) throw Object.assign(new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", candidate.run.taskId, candidate.run.id, "pending_run_missing"), { workspaceId: candidate.workspaceId });
        if (located.run.reportSettlement !== null) continue;
        const current = located.run;
        if (located.workspaceId !== candidate.workspaceId) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", current.taskId, current.id, "delivery_location");
        if (!this.state.tasks.has(current.taskId)) throw Object.assign(new Error("待报运行缺少当前任务快照"), { code: "SCHEDULED_TASK_ACCOUNT_STALE", taskId: current.taskId, runId: current.id });
        const { source: _source, taskNameSnapshot: _name, reportSettlement: _settlement, reportSettledAt: _at, serverOrigin: _origin, ownerUserId: _user, ...run } = current;
        try {
          await this.reportRun(run, owner);
          this.assertAccountCurrent(owner);
          const beforeAck = await this.withDatabase(() => {
            this.assertAccountCurrent(owner);
            return db.getAccountScheduledTaskRun(run.id, owner);
          });
          if (!beforeAck || beforeAck.workspaceId !== candidate.workspaceId) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", run.taskId, run.id, "ack_location");
          if (beforeAck.run.reportSettlement !== null) continue;
          await this.withDatabase(() => {
            this.assertAccountCurrent(owner);
            db.withAccountScheduledTasks(candidate.workspaceId, repos => repos.runs.acknowledgeAccount(run.id, owner, Date.now()), true);
          });
        } catch (cause) { throw this.accountFailure(cause, owner, run.taskId, run.id, "terminal_delivery"); }
      }
    }
  }

  /** 扫描当前到点任务并触发执行。 */
  private async tick(tasks: Iterable<ExecutableTask> = this.state.tasks.values()): Promise<void> {
    if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
    const now = Date.now();
    const errors: unknown[] = [];
    for (const task of tasks) {
      if (this.stopping || this.input.isTaskAdmissionPaused?.() || this.state.tickPending) break;
      if (!task.enabled) continue;
      let localTaskVerified = false;
      try {
        const ctx = (await this.withDatabase(() => this.taskContext(task)));
        localTaskVerified = isLocalTask(task);
        const account = isLocalTask(task) ? null : await this.withDatabase(() => this.accountForTask(task)).catch(error => {
          if (isAccountContextDeferred(error)) Object.assign(error as object, { [deferredAccountScan]: this });
          throw error;
        });
        const accountState = account ? (await this.withDatabase(() => ctx.db.readAccountScheduledTaskState(task.id, account))) : null;
        const runtime = isLocalTask(task) ? (await this.withDatabase(() => ctx.db.getLocalScheduledTaskRuntime(task)))
          : accountState!.running?.runtime ?? accountState!.queued?.runtime ?? accountState!.locations.find(item => item.workspaceId === resolveTaskWorkspaceId(task))?.runtime ?? null;
        if (isLocalTask(task) && runtime?.runningRunId && !this.runs.has(runtime.runningRunId)) {
          throw Object.assign(new Error("本机定时任务存在未收口运行，禁止重放"), { code: "SCHEDULED_TASK_ORPHAN_RUNNING", taskId: task.id, runId: runtime.runningRunId, revision: task.revision, workspaceId: resolveTaskWorkspaceId(task) });
        }
        if (
          !runtime?.runningRunId
          && runtime?.queuedReason === "workspace_migration"
          && runtime.queuedOperationId
          && runtime.queuedScheduledAt != null
        ) {
          const workspaceId = resolveTaskWorkspaceId(task);
          const activeMigrationId = workspaceId
            ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null
            : null;
          if (!activeMigrationId) {
            this.dispatchTracked(this.runMigrationQueuedTask(task, runtime.queuedScheduledAt, runtime.queuedOperationId), (error) => {
              this.writeTaskLog(task, "error", "persisted workspace migration queued task failed after dispatch", {
                code: "scheduled_task_migration_queue_dispatch_failed",
                taskId: task.id,
                operationId: runtime.queuedOperationId,
                workspaceId,
                scheduledAt: runtime.queuedScheduledAt,
                ...toErrorLog(error),
              });
            });
          }
          continue;
        }
        if (!runtime?.runningRunId && (isLocalTask(task) ? runtime?.queuedReason === "concurrency" : this.state.queuedByTaskId.has(task.id))) {
          this.dispatchTracked(this.runQueuedTaskIfNeeded(task), (error) => {
            this.writeTaskLog(task, "error", "queued scheduled task run failed after dispatch", toErrorLog(error));
          });
          continue;
        }
        const watermark = accountState ? accountState.lastScheduledAt : runtime?.lastScheduledAt ?? null;
        const scheduledAt = resolveDueScheduledAt(task, now, watermark);
        if (!scheduledAt) continue;
        if (accountState ? watermark !== null && scheduledAt <= watermark : runtime?.lastScheduledAt === scheduledAt) continue;
        const workspaceId = resolveTaskWorkspaceId(task);
        const migrationOperationId = workspaceId
          ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null
          : null;
        if (workspaceId && migrationOperationId) {
          await this.deferForWorkspaceMigration(task, scheduledAt, migrationOperationId);
          continue;
        }
        if (runtime?.runningRunId) {
          if (task.concurrencyPolicy === "queue_one") {
            if (isLocalTask(task) && runtime.queuedScheduledAt === null) (await this.withDatabase(() => this.localTransaction(task, runtime.runningRunId!, repos => {
              const current = repos.configs.get(task.id);
              if (!current?.enabled || current.deletedAt !== null || current.revision !== task.revision) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFIG_CONFLICT", task.id, runtime.runningRunId!, "config");
              repos.runtime.queueLocalConcurrency({ taskId: task.id, clientId: task.clientId, deviceId: task.deviceId,
                runId: runtime.runningRunId!, scheduledAt, at: now });
            })));
            else if (!isLocalTask(task) && !this.state.queuedByTaskId.has(task.id)) this.state.queuedByTaskId.set(task.id, { scheduledAt, workspaceId: accountState!.running!.workspaceId });
          } else if (task.concurrencyPolicy === "skip_if_running") {
            await this.reportSkippedRun(task, scheduledAt, "上一次仍在运行，已跳过本次触发");
          }
          continue;
        }
        this.dispatchTracked(this.runAutomaticTask(task, scheduledAt), (error) => {
          this.writeTaskLog(task, "error", "scheduled task run failed after dispatch", { requestId: `scheduled:${task.id}:${scheduledAt}`, taskId: task.id, revision: isLocalTask(task) ? task.revision : undefined, workspaceId: resolveTaskWorkspaceId(task), ...toErrorLog(error) });
        });
      } catch (error) {
        if (error instanceof Error && (error as Error & { [deferredAccountScan]?: ScheduledTaskScheduler })[deferredAccountScan] === this) {
          const logFailure = this.deferAccountScan(error, `scheduled:${task.id}:${now}`, task.id);
          if (logFailure) errors.push(logFailure);
          break;
        }
        try {
          const logFailure = isScheduledTaskDiagnosticFailure(error);
          if (!logFailure && !(error as {scheduledTaskFailureLogged?:boolean}|null)?.scheduledTaskFailureLogged) {
            const data = { requestId: `scheduled:${task.id}:${now}`, taskId: task.id, revision: isLocalTask(task) ? task.revision : undefined, workspaceId: resolveTaskWorkspaceId(task), ...toErrorLog(error) };
            if (localTaskVerified || !isLocalTask(task)) (await this.withDatabase(() => this.writeTaskLog(task, "error", "scheduled task scan failed", data)));
            else logger.error("scheduled-tasks", "scheduled task scan failed", data);
            if(error instanceof Error)Object.assign(error,{scheduledTaskFailureLogged:true});
          }
        } catch(logError) { errors.push(new AggregateError([error,logError],"SCHEDULED_TASK_SCAN_LOG_FAILED",{cause:error}));continue; }
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "本机定时任务扫描失败");
  }

  /** 执行自动调度，必要时按上一编排实例状态跳过。 */
  private async runAutomaticTask(task: ExecutableTask, scheduledAt: number, queued?: { operationId: string | null }): Promise<ScheduledTaskRun> {
    const workspaceId = resolveTaskWorkspaceId(task);
    const migrationOperationId = workspaceId
      ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null
      : null;
    if (workspaceId && migrationOperationId) {
      return await this.deferForWorkspaceMigration(task, scheduledAt, migrationOperationId);
    }
    const skip = task.taskType === "workflow" ? (await this.withDatabase(() => this.resolvePreviousWorkflowInstanceSkip(task))) : null;
    if (skip) {
      return await this.reportSkippedRun(task, scheduledAt, skip.summary, skip.workflowInstanceId, queued);
    }
    try {
      return await this.runTaskInternal(task, scheduledAt, "schedule", queued);
    } catch (error) {
      if (!(error instanceof WorkspaceOperationGateError) || !workspaceId) throw error;
      const operationId = String(error.details.operationId ?? "").trim();
      if (!operationId) throw error;
      return await this.deferForWorkspaceMigration(task, scheduledAt, operationId);
    }
  }

  /** 按最新任务配置收敛迁移延期；仍启用且工作区不变的任务保留待补跑。 */
  private async reconcileMigrationQueuedTaskConfigs(): Promise<void> {
    const account = this.captureAccount();
    for (const location of (await this.withDatabase(() => this.input.apiContext.db.listAccountScheduledMigrationQueued(account)))) {
      const queued = location.runtime;
      if (!queued.queuedOperationId || queued.queuedScheduledAt == null) continue;
      try {
        this.assertAccountCurrent(account);
        const operation = (await this.withDatabase(() => this.input.apiContext.db.workspaceDirectoryMigrations.get(queued.queuedOperationId!)));
        if (!operation || operation.workspaceId !== location.workspaceId) throw Object.assign(new Error("账号迁移延期的原物理位置不匹配"), {
          code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: queued.taskId, field: "queue_operation_location",
        });
        const task = this.state.tasks.get(queued.taskId), persistedSkipReason = parseMigrationSkipPendingReason(queued.queuedReason);
        const skipReason = persistedSkipReason ?? resolveMigrationQueueConfigSkipReason(task, operation.workspaceId);
        if (!skipReason) continue;
        const summary = skipReason === "task_disabled" ? "迁移延期期间任务已禁用，已跳过排队触发"
          : skipReason === "workspace_changed" ? "迁移延期期间任务已改到其他工作区，已跳过排队触发" : "迁移延期期间任务已删除，已跳过排队触发";
        const durable = task && isDurableAccountTask(task) && skipReason !== "task_deleted";
        if (durable) {
          const run = buildMigrationQueueConfigSkippedRun({ task, scheduledAt: queued.queuedScheduledAt,
            operationId: queued.queuedOperationId, summary, workspaceId: operation.workspaceId });
          (await this.withDatabase(() => this.accountRuntimeTransaction(location.workspaceId, queued.taskId, run.id, account, repos => {
            repos.runs.createAccount({ run, owner: account, taskName: task.name });
            if (!persistedSkipReason) repos.runtime.markMigrationQueuedSkipPending({ taskId: scheduledTaskAccountRuntimeKey(queued.taskId, account),
              clientId: account.clientId, deviceId: account.deviceId, scheduledAt: queued.queuedScheduledAt!, operationId: queued.queuedOperationId!, skipReason, at: run.finishedAt! });
            repos.runtime.completeMigrationQueuedSkip({ taskId: scheduledTaskAccountRuntimeKey(queued.taskId, account), scheduledAt: queued.queuedScheduledAt!,
              operationId: queued.queuedOperationId!, skipReason, at: run.finishedAt! });
          }, true)));
          continue;
        }
        if (!persistedSkipReason) (await this.withDatabase(() => this.accountRuntimeTransaction(location.workspaceId, queued.taskId, "", account, repos => repos.runtime.markMigrationQueuedSkipPending({
            taskId: scheduledTaskAccountRuntimeKey(queued.taskId, account),
            clientId: account.clientId, deviceId: account.deviceId, scheduledAt: queued.queuedScheduledAt!,
            operationId: queued.queuedOperationId!, skipReason, at: Date.now(),
          }), true)));
        if (task && skipReason !== "task_deleted") await this.reportRun(buildMigrationQueueConfigSkippedRun({ task,
          scheduledAt: queued.queuedScheduledAt, operationId: queued.queuedOperationId, summary, workspaceId: operation.workspaceId }), account);
        this.assertAccountCurrent(account);
        (await this.withDatabase(() => this.accountRuntimeTransaction(location.workspaceId, queued.taskId, "", account, repos => repos.runtime.completeMigrationQueuedSkip({
          taskId: scheduledTaskAccountRuntimeKey(queued.taskId, account), scheduledAt: queued.queuedScheduledAt!,
          operationId: queued.queuedOperationId!, skipReason, at: Date.now(),
        }), true)));
        const data = {
          code: "scheduled_task_migration_queue_config_skipped", taskId: queued.taskId, operationId: queued.queuedOperationId,
          requestId: `scheduled:${queued.taskId}:${queued.queuedScheduledAt}`, workspaceId: operation.workspaceId, scheduledAt: queued.queuedScheduledAt, skipReason,
        };
        try {
          if (location.workspaceId) (await this.withDatabase(() => this.input.apiContext.db.writeWorkspaceLog(location.workspaceId!,
            { level: "info", tag: "scheduled-tasks", message: "workspace migration queued task skipped after config change", data })));
          else logger.info("scheduled-tasks", "workspace migration queued task skipped after config change", data);
        } catch (logError) {
          throw Object.assign(new AggregateError([logError], "SCHEDULED_TASK_MIGRATION_RECONCILE_LOG_FAILED", { cause: logError }),
            { code: "SCHEDULED_TASK_MIGRATION_RECONCILE_LOG_FAILED" });
        }
      } catch (cause) {
        if (isScheduledTaskDiagnosticFailure(cause)) throw cause;
        const error = this.accountFailure(cause, account, queued.taskId, "", "migration_reconcile");
        if (!(error as Error & { scheduledTaskFailureLogged?: boolean }).scheduledTaskFailureLogged) {
          try { const data = {
            code: "SCHEDULED_TASK_MIGRATION_RECONCILE_FAILED", requestId: (error as Error & { requestId: string }).requestId,
            serverOrigin: account.serverOrigin, ownerUserId: account.ownerUserId, clientId: account.clientId, deviceId: account.deviceId,
            taskId: queued.taskId, runId: null, workspaceId: location.workspaceId, operationId: queued.queuedOperationId,
            stage: "migration_reconcile", rootCause: toErrorLog(error).error,
          };
            if (location.workspaceId) (await this.withDatabase(() => this.input.apiContext.db.writeWorkspaceLog(location.workspaceId!,
              { level: "error", tag: "scheduled-tasks", message: "workspace migration queued task reconciliation failed", data })));
            else logger.error("scheduled-tasks", "workspace migration queued task reconciliation failed", data);
          }
          catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_MIGRATION_RECONCILE_LOG_FAILED", { cause: error }),
            { code: "SCHEDULED_TASK_MIGRATION_RECONCILE_LOG_FAILED", scheduledTaskFailureLogged: true }); }
          Object.assign(error, { scheduledTaskFailureLogged: true });
        }
        throw error;
      }
    }
  }

  /** 执行一次手动或补偿调度任务。 */
  private async runTask(task: ExecutableTask, scheduledAt: number, triggerSource: ScheduledTaskRun["triggerSource"]): Promise<ScheduledTaskRun> {
    return await this.runTaskInternal(task, scheduledAt, triggerSource);
  }

  /** 沿原 owner 执行任务；本机历史与 runtime 认领、终结分别同事务提交。 */
  private async runTaskInternal(
    task: ExecutableTask,
    scheduledAt: number,
    triggerSource: ScheduledTaskRun["triggerSource"],
    migrationQueue?: { operationId: string | null },
  ): Promise<ScheduledTaskRun> {
    const { ctx, account, durableAccount, key, runId, startedAt, workspaceId, runningRun, owner } = await this.withDatabase(() => {
      const ctx = this.taskContext(task);
      this.assertAccepting("创建定时任务执行");
      const account = isLocalTask(task) ? null : this.accountForTask(task);
      const durableAccount = isDurableAccountTask(task) ? account : null;
      const key = this.runtimeKey(task, account ?? undefined);
      const runId = `str_${crypto.randomUUID()}`;
      const startedAt = Date.now();
      const workspaceId = resolveTaskWorkspaceId(task);
      const runningRun: ScheduledTaskRun = {
        id: runId, taskId: task.id, clientId: task.clientId, deviceId: task.deviceId, workspaceId,
        workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null, scheduledAt, startedAt,
        finishedAt: null, status: "running", triggerSource, attempt: 1, durationMs: null,
        summary: "任务开始执行", errorMessage: null, outputExcerpt: null, createdAt: startedAt,
      };
      const releaseWrite = workspaceId
        ? this.input.apiContext.workspaceOperationGate?.beginWrite(workspaceId) ?? (() => {})
        : () => {};
      try {
        if (isLocalTask(task)) {
          this.localTransaction(task, runId, repos => {
            const runtime = repos.runtime.get(key);
            if (runtime?.runningRunId) throw Object.assign(new Error("本机定时任务正在运行"), { code: this.runs.has(runtime.runningRunId) ? "SCHEDULED_TASK_ALREADY_RUNNING" : "SCHEDULED_TASK_ORPHAN_RUNNING", taskId: task.id, runId: runtime.runningRunId });
            repos.runs.create({ run: runningRun, expectedConfigRevision: task.revision });
            if (migrationQueue?.operationId) repos.runtime.markMigrationQueuedStarted({ taskId: key, clientId: task.clientId, deviceId: task.deviceId, scheduledAt, operationId: migrationQueue.operationId, runId, startedAt });
            else {
              if (migrationQueue) repos.runtime.consumeLocalConcurrencyQueued(task, scheduledAt, startedAt);
              repos.runtime.markStarted({ taskId: key, clientId: task.clientId, deviceId: task.deviceId, scheduledAt, runId, startedAt });
            }
            if (repos.runtime.get(key)?.runningRunId !== runId) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", task.id, runId, "runtime_claim");
          });
        } else {
          const state = ctx.db.readAccountScheduledTaskState(task.id, account!);
          if (state.running) throw Object.assign(new Error("账号定时任务正在运行"), { code: "SCHEDULED_TASK_ALREADY_RUNNING", taskId: task.id, runId: state.running.runtime.runningRunId });
          if (triggerSource === "schedule" && !migrationQueue && state.lastScheduledAt !== null && scheduledAt <= state.lastScheduledAt) throw Object.assign(new Error("账号计划点已消费"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: task.id, field: "scheduled_watermark" });
          if (migrationQueue && (!state.queued || state.queued.workspaceId !== workspaceId)) throw Object.assign(new Error("账号延期物理位置冲突"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: task.id, field: "queue_location" });
          if (durableAccount && ctx.db.getAccountScheduledTaskRun(runId, durableAccount)) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", task.id, runId, "run_id_exists");
          this.accountRuntimeTransaction(workspaceId, task.id, runId, account!, repos => {
            if (durableAccount) repos.runs.createAccount({ run: runningRun, owner: durableAccount, taskName: task.name });
            if (migrationQueue?.operationId) repos.runtime.claimAccountQueued({ taskId: task.id, owner: account!, runId, scheduledAt, startedAt, operationId: migrationQueue.operationId });
            else repos.runtime.claimAccount({ taskId: task.id, owner: account!, runId, scheduledAt, startedAt });
          });
        }
      } catch (error) {
        if (account) this.logLocalRunFailure(task, runId, error, account);
        throw error;
      } finally {
        releaseWrite();
      }
      const owner: ScheduledRunOwner = {
        taskId: task.id, runId, child: null, updateRequestId: null, preparationAbort: new AbortController(),
        stopPromise: null, stopCause: null, drainFailure: null, runFailure: null,
        accountContext: account,
        workspaceId,
      };
      this.runs.set(runId, owner);
      return { ctx, account, durableAccount, key, runId, startedAt, workspaceId, runningRun, owner };
    });
    let finalRun: ScheduledTaskRun | null = null;
    try {
      if (!isLocalTask(task)) {
        try { await this.reportRun(runningRun, account!); this.assertAccountCurrent(account!); }
        catch (error) {
          (await this.withDatabase(() => this.logLocalRunFailure(task, runId, error, account!)));
          if (durableAccount) {
            const finishedAt = Date.now();
            const failed: ScheduledTaskRun = { ...runningRun, status: "failed", finishedAt, durationMs: finishedAt - startedAt,
              summary: "派发前回执失败，脚本未启动", errorMessage: "SCHEDULED_TASK_DISPATCH_REPORT_FAILED" };
            try { (await this.withDatabase(() => this.finishAccountRun(failed, durableAccount))); }
            catch (storageError) { throw new AggregateError([error, storageError], "账号派发前失败及终态保存均失败"); }
          }
          throw error;
        }
      }

      try {
        this.assertAccepting("执行定时任务", true);
        (await this.withDatabase(() => this.assertRunNotInterrupted(owner, task)));
        finalRun = task.taskType === "workflow"
          ? await this.runWorkflowTask(task, runId, scheduledAt, startedAt, triggerSource, owner)
          : await this.runScriptTask(task, runId, scheduledAt, startedAt, triggerSource, owner);
      } catch (error) {
        (await this.withDatabase(() => this.logLocalRunFailure(task, runId, error, account ?? undefined)));
        const finishedAt = Date.now();
        finalRun = {
          id: runId,
          taskId: task.id,
          clientId: task.clientId,
          deviceId: task.deviceId,
          workspaceId: resolveTaskWorkspaceId(task),
          workflowInstanceId: null,
          workflowNameSnapshot: null,
          workflowVersion: null,
          scheduledAt,
          startedAt,
          finishedAt,
          status: "failed",
          triggerSource,
          attempt: 1,
          durationMs: finishedAt - startedAt,
          summary: "任务执行失败",
          errorMessage: isLocalTask(task) ? localFailureCode(error) : error instanceof Error ? error.message : String(error),
          outputExcerpt: null,
          createdAt: startedAt,
        };
      }
      if (durableAccount) (await this.withDatabase(() => this.finishAccountRun(finalRun!, durableAccount)));
      if (isLocalTask(task)) (await this.withDatabase(() => this.localTransaction(task, runId, repos => {
        if (repos.runtime.get(key)?.runningRunId !== runId) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFLICT", task.id, runId, "runtime_owner");
        repos.runs.complete(finalRun!);
        repos.runtime.markFinished({ taskId: key, runId, finishedAt: finalRun!.finishedAt! });
        if (repos.runtime.get(key)?.runningRunId !== null) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", task.id, runId, "runtime_finish");
      }, true)));
      else if (durableAccount) {
        this.assertAccountCurrent(durableAccount);
        await this.syncExclusive("account_terminal");
        const saved = (await this.withDatabase(() => ctx.db.getAccountScheduledTaskRun(runId, durableAccount)))?.run;
        if (!saved?.reportSettlement) throw Object.assign(new Error("账号任务结果尚未确认"), { code: "SCHEDULED_TASK_REPORT_PENDING", taskId: task.id, runId });
      } else await this.reportRun(finalRun, account!);
    } catch (error) {
      let failure = account ? Object.assign(this.accountFailure(error, account, task.id, runId, "execution_settlement"), { workspaceId: owner.workspaceId }) : error;
      if (account) {
        try { (await this.withDatabase(() => this.logLocalRunFailure(task, runId, failure, account))); }
        catch (diagnosticError) { failure = diagnosticError; }
      }
      owner.runFailure = { reason: failure };
      throw failure;
    } finally {
      try { if (!isLocalTask(task) && !durableAccount && (!owner.runFailure || !isScheduledTaskDiagnosticFailure(owner.runFailure.reason))) (await this.withDatabase(() => this.accountRuntimeTransaction(owner.workspaceId, task.id, runId, account!,
        repos => repos.runtime.finishAccount({ taskId: task.id, owner: account!, runId, finishedAt: finalRun?.finishedAt ?? Date.now() }), true))); }
      catch (error) {
        const failure = owner.runFailure ? new AggregateError([owner.runFailure.reason, error], "定时任务上报与清理均失败") : error;
        owner.runFailure = { reason: failure };
        throw failure;
      }
      finally { if (!owner.updateRequestId) this.runs.delete(runId); }
    }
    await this.runQueuedTaskIfNeeded(task, account ?? undefined);
    if (!finalRun) throw new Error(`定时任务运行结果未生成：${task.id}`);
    return finalRun;
  }

  /** 捕获物理位置上的同步事务；应用 b8 的历史与 runtime 仍共享原连接。 */
  private accountRuntimeTransaction<T>(workspaceId: WorkspaceId | null, taskId: string, runId: string, owner: ScheduledTaskAccountContext,
    action: (repos: AccountScheduledTaskRepos) => T & (T extends PromiseLike<unknown> ? never : unknown), includeDeleted = false): T {
    try { return this.input.apiContext.db.withAccountScheduledTasks(workspaceId, repos => repos.db.transaction(() => action(repos))(), includeDeleted); }
    catch (cause) { throw this.accountFailure(Object.assign(new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", taskId, runId, "account_runtime_transaction", safeRootCauseCode(cause)), { cause, workspaceId }), owner, taskId, runId, "storage"); }
  }

  /** 终态先 COMMIT 再允许 HTTP；即使当前账号已变也只写捕获 owner 的历史。 */
  private finishAccountRun(run: ScheduledTaskRun, owner: ScheduledTaskAccountContext): void {
    this.accountRuntimeTransaction(run.workspaceId, run.taskId, run.id, owner, repos => {
      repos.runs.completeAccount(run, owner);
      repos.runtime.finishAccount({ taskId: run.taskId, runId: run.id, owner, finishedAt: run.finishedAt! });
    }, true);
  }

  /** 只补拥有上下文的安全关联字段；错误仍上抛，由既有 API/tick 边界记录一次。 */
  private accountFailure(cause: unknown, owner: ScheduledTaskAccountContext, taskId: string, runId: string, stage: string): Error {
    const fields = cause && typeof cause === "object" ? cause as Record<string, unknown> : {};
    return Object.assign(cause instanceof Error ? cause : new Error("账号任务操作失败", { cause }), {
      code: typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(fields.code) ? fields.code : "SCHEDULED_TASK_ACCOUNT_FAILED",
      requestId: fields.requestId ?? (runId || `scheduled-sync:${owner.clientId}:${owner.generation}`), taskId, runId, stage: fields.stage ?? stage,
      serverOrigin: owner.serverOrigin, ownerUserId: owner.ownerUserId, clientId: owner.clientId, deviceId: owner.deviceId,
      httpStatus: fields.httpStatus, reason: fields.reason, upstreamRequestId: fields.upstreamRequestId,
    });
  }

  /** 本机认领与终结沿同连接提交；驱动正文不越过原调度错误边界。 */
  private localTransaction<T>(task: LocalScheduledTaskConfig, runId: string,
    action: (repos: LocalScheduledTaskRepos) => T & (T extends PromiseLike<unknown> ? never : unknown), includeDeleted = false): T {
    try { return this.input.localApiContext!.db.withLocalScheduledTasks(resolveTaskWorkspaceId(task),
      repos => repos.db.transaction(() => action(repos))(), includeDeleted); }
    catch (cause) {
      let error: unknown = cause;
      try {
        const descriptor = cause !== null && typeof cause === "object" ? Object.getOwnPropertyDescriptor(cause, "code") : undefined;
        const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
        error = cause instanceof ScheduledTaskRunError || typeof code === "string" && code.startsWith("SCHEDULED_TASK_")
          ? cause : Object.assign(new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED", task.id, runId, "runtime", safeRootCauseCode(cause)), { cause });
        this.writeTaskLog(task, "error", "local scheduled task transaction failed", {
          requestId:runId,taskId:task.id,runId,revision:task.revision,workspaceId:resolveTaskWorkspaceId(task),...toErrorLog(error),
        });
      } catch (logError) { throw Object.assign(new AggregateError([error,logError],"SCHEDULED_TASK_TRANSACTION_LOG_FAILED",{cause:error}),
        { code: "SCHEDULED_TASK_TRANSACTION_LOG_FAILED" }); }
      if (error instanceof Error) Object.assign(error,{scheduledTaskFailureLogged:true});
      throw error;
    }
  }

  /** 原执行边界按本机或账号来源记录一次，日志再失败保原错误链且停止结算。 */
  private logLocalRunFailure(task: ExecutableTask, runId: string, error: unknown, account?: ScheduledTaskAccountContext): void {
    let knownLogFailure = false;
    try {
      knownLogFailure = isScheduledTaskDiagnosticFailure(error);
      if (!knownLogFailure) {
        const logged = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "scheduledTaskFailureLogged") : undefined;
        if (logged && "value" in logged && logged.value === true) return;
        const safe = toErrorLog(account ? this.accountFailure(error, account, task.id, runId, "execution") : error);
        this.writeTaskLog(task, "error", isLocalTask(task) ? "local scheduled task execution failed" : "scheduled task execution failed", {
          code: localFailureCode(error), requestId: runId, taskId: task.id, runId, revision: isLocalTask(task) ? task.revision : undefined,
          ...(account ? { serverOrigin: account.serverOrigin, ownerUserId: account.ownerUserId, clientId: account.clientId, deviceId: account.deviceId } : {}),
          workspaceId: resolveTaskWorkspaceId(task), stage: safe.error.stage, rootCause: safe.error, ...safe,
        });
      }
    } catch (logError) { throw Object.assign(new AggregateError([error, logError], "SCHEDULED_TASK_EXECUTION_LOG_FAILED", { cause: error }),
      { code: "SCHEDULED_TASK_EXECUTION_LOG_FAILED" }); }
    if (knownLogFailure) throw error;
    if (error instanceof Error) Object.assign(error, { scheduledTaskFailureLogged: true });
  }

  /** 目录等待前后重核派发资格；确认更新仍可打断等待，保留原 Promise 结算。 */
  private async waitForWorkflowPreparation(owner: ScheduledRunOwner, task: ExecutableTask): Promise<void> {
    (await this.withDatabase(() => this.assertRunNotInterrupted(owner, task)));
    const signal = owner.preparationAbort.signal;
    let onAbort!: () => void;
    try {
      await new Promise<void>((resolve, reject) => {
        onAbort = () => { try { this.assertRunNotInterrupted(owner); } catch (error) { reject(error); } };
        signal.addEventListener("abort", onAbort, { once: true });
        void waitForEngineModelCatalogDispatchReady().then(resolve, reject);
      });
    } finally { signal.removeEventListener("abort", onAbort); }
    (await this.withDatabase(() => this.assertRunNotInterrupted(owner, task)));
  }

  /** 更新与账号资格沿原边界核验；传入任务时才检查派发前停删，不打断已派发运行。 */
  private assertRunNotInterrupted(owner: ScheduledRunOwner, beforeDispatch?: ExecutableTask): void {
    if (owner.updateRequestId) throw new Error("SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE：用户已确认更新");
    if (owner.accountContext) {
      this.assertAccountCurrent(owner.accountContext);
      if (beforeDispatch) {
        if (this.input.localApiContext) {
          const snapshot = this.input.apiContext.db.listAccountScheduledTaskConfigs(owner.accountContext).find(item => item.snapshot.task.id === owner.taskId)?.snapshot;
          if (!snapshot || !snapshot.serverPresent || snapshot.stopIntent !== null) throw Object.assign(new Error("SCHEDULED_TASK_ACCOUNT_UNAVAILABLE：本地已停用或删除，未派发"), { code: "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE", taskId: owner.taskId, runId: owner.runId });
        }
        const durable = isDurableAccountTask(beforeDispatch);
        const run = durable ? this.input.apiContext.db.getAccountScheduledTaskRun(owner.runId, owner.accountContext)?.run : null;
        const running = this.input.apiContext.db.readAccountScheduledTaskState(owner.taskId, owner.accountContext).running;
        if (!this.state.tasks.get(owner.taskId)?.enabled || durable && (!run || run.status !== "running" || run.reportSettlement !== null)) {
          throw Object.assign(new Error("SCHEDULED_TASK_ACCOUNT_UNAVAILABLE：任务已停用或删除，未派发"), {
            code: "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE", taskId: owner.taskId, runId: owner.runId, stage: "dispatch",
          });
        }
        if (!running || running.workspaceId !== owner.workspaceId || running.runtime.runningRunId !== owner.runId) throw Object.assign(new Error("账号运行位置不匹配"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: owner.taskId, runId: owner.runId, field: "dispatch_location" });
      }
    }
  }

  /** 模型就绪后同步创建并启动实例；确认后的原启动收口仍保留实例关联。 */
  private async runWorkflowTask(
    task: ExecutableTask,
    runId: string,
    scheduledAt: number,
    startedAt: number,
    triggerSource: ScheduledTaskRun["triggerSource"],
    owner: ScheduledRunOwner,
  ): Promise<ScheduledTaskRun> {
    await this.waitForWorkflowPreparation(owner, task);
    const { ctx, result, payload } = await this.withDatabase(() => {
      this.assertRunNotInterrupted(owner, task);
      const payload = task.payload as ScheduledTaskWorkflowPayload;
      const ctx = this.taskContext(task, true);
      const sequence = owner.accountContext ? (ctx.db.readAccountScheduledTaskState(task.id, owner.accountContext!).lastWorkflowSequence ?? 0) + 1 : null;
      if (sequence !== null && !Number.isSafeInteger(sequence)) throw Object.assign(new Error("账号流程指针顺序已耗尽"), { code: "SCHEDULED_TASK_RUNTIME_CONFLICT", taskId: task.id, runId, field: "workflow_sequence_overflow" });
      const result = createScheduledWorkflowInstance(ctx, {
        workspaceId: payload.contextWorkspaceId,
        workflowId: payload.workflowId,
        taskName: task.name,
        intake: payload.intake,
        interactionMode: payload.interactionMode ?? "guided",
      });
      /** 实例沿原引擎保存，runtime 只写该任务的实际物理库。 */
      const saveInstance = (runtime: LocalScheduledTaskRepos["runtime"]): void => runtime.updateLastWorkflowInstance({
        taskId: taskRuntimeKey(task),
        clientId: this.input.config.clientId,
        deviceId: this.input.deviceId,
        instanceId: result.instanceId,
        at: Date.now(),
      });
      if (isLocalTask(task)) this.localTransaction(task, runId, repos => saveInstance(repos.runtime));
      else this.accountRuntimeTransaction(owner.workspaceId, task.id, runId, owner.accountContext!, repos => repos.runtime.updateAccountWorkflow({
        taskId: task.id, owner: owner.accountContext!, runId, instanceId: result.instanceId, sequence: sequence!, at: Date.now() }));
      return { ctx, result, payload };
    });
    this.assertRunNotInterrupted(owner);
    try {
      if (isLocalTask(task)) await ctx.orchEngine.startInBackground(result.instanceId, runId);
      else await ctx.orchEngine.start(result.instanceId);
      (await this.withDatabase(() => this.assertRunNotInterrupted(owner)));
    } catch (error) {
      (await this.withDatabase(() => this.logLocalRunFailure(task, runId, error, owner.accountContext ?? undefined)));
      const finishedAt = Date.now();
      return {
        id: runId,
        taskId: task.id,
        clientId: task.clientId,
        deviceId: task.deviceId,
        workspaceId: payload.contextWorkspaceId,
        workflowInstanceId: result.instanceId,
        workflowNameSnapshot: result.workflowName,
        workflowVersion: result.workflowVersion,
        scheduledAt,
        startedAt,
        finishedAt,
        status: "failed",
        triggerSource,
        attempt: 1,
        durationMs: finishedAt - startedAt,
        summary: owner.updateRequestId ? `用户确认更新，工作流已中断：${result.workflowName}` : `工作流实例启动失败：${result.workflowName}`,
        errorMessage: isLocalTask(task) ? localFailureCode(error) : error instanceof Error ? error.message : String(error),
        outputExcerpt: null,
        createdAt: startedAt,
      };
    }
    const finishedAt = Date.now();
    return {
      id: runId,
      taskId: task.id,
      clientId: task.clientId,
      deviceId: task.deviceId,
      workspaceId: payload.contextWorkspaceId,
      workflowInstanceId: result.instanceId,
      workflowNameSnapshot: result.workflowName,
      workflowVersion: result.workflowVersion,
      scheduledAt,
      startedAt,
      finishedAt,
      status: "success",
      triggerSource,
      attempt: 1,
      durationMs: finishedAt - startedAt,
      summary: isLocalTask(task) ? `工作流已触发：${result.workflowName}` : `工作流实例已启动：${result.workflowName}`,
      errorMessage: null,
      outputExcerpt: null,
      createdAt: startedAt,
    };
  }

  /** 执行脚本任务，并截断上传 stdout/stderr 摘要。 */
  private async runScriptTask(
    task: ExecutableTask,
    runId: string,
    scheduledAt: number,
    startedAt: number,
    triggerSource: ScheduledTaskRun["triggerSource"],
    owner: ScheduledRunOwner,
  ): Promise<ScheduledTaskRun> {
    const payload = task.payload as ScheduledTaskScriptPayload;
    const workspaces = await this.withDatabase(() => {
      this.assertRunNotInterrupted(owner, task);
      return this.taskContext(task).workspaces;
    });
    this.assertRunNotInterrupted(owner);
    const result = await runScript({
      payload,
      workspaces,
      timeoutMs: task.timeoutMs,
      owner,
    });
    const finishedAt = Date.now();
    if (owner.updateRequestId || result.timedOut || result.exitCode !== 0) {
      const code = owner.updateRequestId ? "SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE" : result.timedOut ? "SCHEDULED_TASK_SCRIPT_TIMEOUT" : "SCHEDULED_TASK_SCRIPT_FAILED";
      const failure = Object.assign(new Error(code), { code, taskId: task.id, runId, workspaceId: owner.workspaceId });
      try { (await this.withDatabase(() => this.writeTaskLog(task, "error", isLocalTask(task) ? "local scheduled script failed" : "scheduled script failed", {
        code,
        requestId: runId, taskId: task.id, runId, revision: isLocalTask(task) ? task.revision : undefined, workspaceId: resolveTaskWorkspaceId(task),
        exitCode: result.exitCode, timedOut: result.timedOut, rootCause: toErrorLog(failure).error,
      }))); } catch (logError) { throw Object.assign(new AggregateError([failure, logError], "SCHEDULED_TASK_EXECUTION_LOG_FAILED", { cause: failure }),
        { code: "SCHEDULED_TASK_EXECUTION_LOG_FAILED" }); }
    }
    return {
      id: runId,
      taskId: task.id,
      clientId: task.clientId,
      deviceId: task.deviceId,
      workspaceId: payload.contextWorkspaceId ?? null,
      workflowInstanceId: null,
      workflowNameSnapshot: null,
      workflowVersion: null,
      scheduledAt,
      startedAt,
      finishedAt,
      status: owner.updateRequestId ? "failed" : result.timedOut ? "timeout" : result.exitCode === 0 ? "success" : "failed",
      triggerSource,
      attempt: 1,
      durationMs: finishedAt - startedAt,
      summary: owner.updateRequestId ? "用户确认更新，脚本已中断" : result.timedOut ? "脚本执行超时" : `脚本退出码：${result.exitCode}`,
      errorMessage: owner.updateRequestId ? "SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE：用户已确认更新" : result.exitCode === 0 && !result.timedOut ? null : result.errorMessage,
      outputExcerpt: result.outputExcerpt,
      createdAt: startedAt,
    };
  }

  /** 上报所有任务的下一次执行时间。 */
  private async reportNextRuns(owner: ScheduledTaskAccountContext): Promise<void> {
    this.assertAccountCurrent(owner);
    const now = Date.now();
    const nextRuns = Array.from(this.state.tasks.values()).map((task) => ({
      taskId: task.id,
      nextRunAt: task.enabled ? computeNextCronTimeMs(task.cronExpr, now, task.timezone) : null,
    }));
    await this.requestAccountTasks(owner, "report", { nextRuns });
    this.assertAccountCurrent(owner);
  }

  /** 上报前复核本地删除；明确返回已删除，不发旧结果或伪造Server ACK。 */
  private async reportRun(run: ScheduledTaskRun, owner: ScheduledTaskAccountContext = this.captureAccount()): Promise<"reported" | "task_deleted"> {
    try {
      this.assertAccountCurrent(owner);
      if (this.input.localApiContext && (await this.withDatabase(() => this.input.apiContext.db.listAccountScheduledTaskConfigs(owner)
        .some(item => item.snapshot.task.id === run.taskId && item.snapshot.stopIntent === "deleted")))) {
        const retained = new Set((await this.withDatabase(() => this.input.apiContext.db.listAccountScheduledTaskConfigs(owner)
          .filter(item => item.snapshot.stopIntent !== "deleted" && item.snapshot.serverPresent).map(item => item.snapshot.task.id))));
        (await this.withDatabase(() => this.input.apiContext.db.withAccountScheduledTasks(run.workspaceId, repos => repos.runs.discardMissingAccount(owner, retained, Date.now()), true)));
        return "task_deleted";
      }
      await this.requestAccountTasks(owner, "report", { run });
      this.assertAccountCurrent(owner);
      return "reported";
    } catch (cause) { throw Object.assign(this.accountFailure(cause, owner, run.taskId, run.id, run.status === "running" ? "dispatch_report" : "terminal_report"), { workspaceId: run.workspaceId }); }
  }

  /** 同步与回执共用原owner；已装配传输失败不回退普通Client凭据。 */
  private async requestAccountTasks(owner: ScheduledTaskAccountContext, action: "sync" | "report" | "config",
    payload: Pick<ClientScheduledTaskReportRequestBody, "run" | "nextRuns"> | Omit<ClientScheduledTaskConfigWritebackRequestBody, "clientId" | "deviceId">): Promise<ClientScheduledTaskSyncResponseBody | ClientScheduledTaskReportResponseBody | ClientScheduledTaskConfigWritebackResponseBody> {
    this.assertAccountCurrent(owner);
    const requestId = `scheduled:${action}:${crypto.randomUUID()}`;
    try {
      const result = this.input.requestAccountTasks
        ? await this.input.requestAccountTasks(owner, action, payload, requestId)
        : await postJson<ClientScheduledTaskSyncResponseBody | ClientScheduledTaskReportResponseBody>(this.httpBase,
          `/api/client/scheduled-tasks/${action}`, this.input.config.apiKey, { ...payload, clientId: owner.clientId, deviceId: owner.deviceId });
      this.assertAccountCurrent(owner);
      return result;
    } catch (error) {
      if (this.input.localApiContext && this.input.requestAccountTasks && error instanceof Error) Object.assign(error, { [accountRequestFailure]: this });
      throw error;
    }
  }

  /** 脚本skipped先耐久保存；workflow成功回执后消费捕获位置，失败保原重试。 */
  private async reportSkippedRun(task: ExecutableTask, scheduledAt: number, summary: string, workflowInstanceId: OrchestrationId | null = null,
    queued?: { operationId: string | null }): Promise<ScheduledTaskRun> {
    const run = buildSkippedRun(task, scheduledAt, summary, workflowInstanceId);
    if (isLocalTask(task)) {
      (await this.withDatabase(() => this.localTransaction(task, run.id, repos => {
        repos.runs.create({ run, expectedConfigRevision: task.revision });
        if (queued?.operationId === null) repos.runtime.consumeLocalConcurrencyQueued(task, scheduledAt, run.finishedAt!);
        repos.runtime.markSkipped({ taskId: taskRuntimeKey(task), clientId: task.clientId, deviceId: task.deviceId, scheduledAt, at: run.finishedAt! });
        if (repos.runtime.get(taskRuntimeKey(task))?.lastScheduledAt !== scheduledAt) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_STORAGE_FAILED",task.id,run.id,"skip_watermark");
      })));
      return run;
    }
    const account = (await this.withDatabase(() => this.accountForTask(task)));
    if (isDurableAccountTask(task)) {
      const workspaceId = run.workspaceId;
      const activeMigration = workspaceId ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) : null;
      if (workspaceId && activeMigration) (await this.withDatabase(() => this.input.apiContext.db.deferAccountScheduledTask({ workspaceId, taskId: task.id, owner: account,
        operationId: activeMigration, scheduledAt, at: run.finishedAt!, skipped: true, skippedRun: run, taskName: task.name })));
      else (await this.withDatabase(() => this.accountRuntimeTransaction(workspaceId, task.id, run.id, account, repos => {
        repos.runs.createAccount({ run, owner: account, taskName: task.name });
        if (queued?.operationId) repos.runtime.consumeAccountMigrationSkipped({ taskId: task.id, owner: account, scheduledAt, operationId: queued.operationId, at: run.finishedAt! });
        else repos.runtime.skipAccount({ taskId: task.id, owner: account, scheduledAt, at: run.finishedAt! });
      })));
      this.assertAccountCurrent(account);
      await this.syncExclusive("account_skipped");
      if (!(await this.withDatabase(() => this.input.apiContext.db.getAccountScheduledTaskRun(run.id, account)))?.run.reportSettlement) throw Object.assign(new Error("账号跳过结果尚未确认"), { code: "SCHEDULED_TASK_REPORT_PENDING", taskId: task.id, runId: run.id });
      return run;
    }
    const workspaceId = resolveTaskWorkspaceId(task);
    await this.reportRun(run, account);
    this.assertAccountCurrent(account);
    const activeMigration = workspaceId ? this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) : null;
    if (workspaceId && activeMigration) (await this.withDatabase(() => this.input.apiContext.db.deferAccountScheduledTask({ workspaceId, taskId: task.id, owner: account,
      operationId: activeMigration, scheduledAt, at: run.finishedAt!, skipped: true })));
    else (await this.withDatabase(() => this.accountRuntimeTransaction(workspaceId, task.id, run.id, account, repos => {
      if (queued?.operationId) {
        repos.runtime.consumeAccountMigrationSkipped({ taskId: task.id, owner: account, scheduledAt, operationId: queued.operationId, at: run.finishedAt! });
      } else repos.runtime.skipAccount({ taskId: task.id, owner: account, scheduledAt, at: run.finishedAt! });
    })));
    return run;
  }

  /** 判断工作流任务是否应因上一轮实例状态跳过本次自动调度。 */
  private resolvePreviousWorkflowInstanceSkip(task: ExecutableTask): { workflowInstanceId: OrchestrationId; summary: string } | null {
    const payload = task.payload as ScheduledTaskWorkflowPayload;
    const skipStatuses = normalizeScheduledTaskWorkflowSkipStatuses(payload.skipWhenPreviousInstanceStatuses);
    if (!skipStatuses.length) return null;

    const taskDb = this.taskContext(task).db;
    const runtime = isLocalTask(task) ? taskDb.getLocalScheduledTaskRuntime(task) : taskDb.readAccountScheduledTaskState(task.id, this.accountForTask(task));
    const instanceId = String(runtime?.lastWorkflowInstanceId ?? "").trim() as OrchestrationId;
    if (!instanceId) return null;

    const instance = this.input.apiContext.db.forWorkspace(payload.contextWorkspaceId).orchInstances.get(instanceId);
    if (!instance) {
      this.writeTaskLog(task, "warn", "previous scheduled workflow instance not found", {
        ...(isLocalTask(task) ? { code: "SCHEDULED_TASK_PREVIOUS_INSTANCE_NOT_FOUND", requestId: `scheduled:${task.id}:${Date.now()}` } : {}),
        task_id: task.id,
        workflow_instance_id: instanceId,
      });
      return null;
    }
    if (instance.workflowId !== payload.workflowId || instance.workspaceId !== payload.contextWorkspaceId) {
      this.writeTaskLog(task, "info", "previous scheduled workflow instance ignored after task target changed", {
        ...(isLocalTask(task) ? { code: "SCHEDULED_TASK_PREVIOUS_TARGET_CHANGED", requestId: `scheduled:${task.id}:${Date.now()}` } : {}),
        task_id: task.id,
        workflow_instance_id: instanceId,
        previous_workflow_id: instance.workflowId,
        current_workflow_id: payload.workflowId,
        previous_workspace_id: instance.workspaceId,
        current_workspace_id: payload.contextWorkspaceId,
      });
      return null;
    }
    if (!skipStatuses.includes(instance.status as OrchestrationStatus)) return null;
    return {
      workflowInstanceId: instance.id,
      summary: `上一轮流程实例状态为 ${instance.status}，按策略跳过本次调度`,
    };
  }

  /** 本机迁移入队在同事务复核当前配置，避免旧快照越过已提交停用。 */
  private async deferForWorkspaceMigration(
    task: ExecutableTask,
    scheduledAt: number,
    operationId: string,
  ): Promise<ScheduledTaskRun> {
    if (isLocalTask(task)) {
      const workspaceId = resolveTaskWorkspaceId(task)!;
      await this.input.apiContext.workspaceOperationGate?.waitForFinalHandoff(workspaceId);
      const current = (await this.withDatabase(() => this.input.localApiContext!.db.getLocalScheduledTask(task.id)));
      this.assertAccepting("迁移延期定时任务");
      if (!current?.enabled || current.deletedAt !== null || current.revision !== task.revision) throw new ScheduledTaskRunError("SCHEDULED_TASK_RUN_CONFIG_CONFLICT", task.id, "", "config");
      (await this.withDatabase(() => this.assertLocalTask(current)));
      const owner = this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null;
      if (!owner) return await this.runAutomaticTask(current, scheduledAt);
      const run = buildSkippedRun(current, scheduledAt, current.concurrencyPolicy === "skip_if_running"
        ? "工作区迁移中，已按策略跳过本次触发" : "工作区迁移中，已排队一次触发");
      (await this.withDatabase(() => this.input.localApiContext!.db.deferLocalScheduledTask({ task: current, operationId: owner, scheduledAt, at: Date.now(),
        ...(current.concurrencyPolicy === "skip_if_running" ? { skippedRun: run } : {}) })));
      return run;
    }
    const workspaceId = resolveTaskWorkspaceId(task)!;
    await this.input.apiContext.workspaceOperationGate?.waitForFinalHandoff(workspaceId);
    const account = (await this.withDatabase(() => this.accountForTask(task))), current = this.state.tasks.get(task.id);
    this.assertAccepting("迁移延期定时任务");
    if (!current?.enabled || resolveTaskWorkspaceId(current) !== workspaceId) throw Object.assign(new Error("账号迁移延期配置已变化"), { code: "SCHEDULED_TASK_ACCOUNT_UNAVAILABLE", taskId: task.id });
    const active = this.input.apiContext.workspaceOperationGate?.getMigrationOperationId(workspaceId) ?? null;
    if (!active) return await this.runAutomaticTask(current, scheduledAt);
    if (current.concurrencyPolicy === "skip_if_running") return await this.reportSkippedRun(current, scheduledAt, "工作区迁移中，已按策略跳过本次触发");
    (await this.withDatabase(() => this.input.apiContext.db.deferAccountScheduledTask({ workspaceId, taskId: current.id, owner: account, scheduledAt, operationId: active, at: Date.now(), skipped: false })));
    return buildSkippedRun(current, scheduledAt, "工作区迁移中，已排队一次触发");
  }

  /** 原子认领并运行一个持久化迁移延期项。 */
  private async runMigrationQueuedTask(
    task: ExecutableTask,
    scheduledAt: number,
    operationId: string,
  ): Promise<ScheduledTaskRun> {
    return isLocalTask(task) ? await this.runTaskInternal(task, scheduledAt, "schedule", { operationId })
      : await this.runAutomaticTask(task, scheduledAt, { operationId });
  }

  /** 停删先落原去重水位；失败保留 cause 交调用边界记录，不消费队列。 */
  private reconcileAccountQueuedTask(taskId: string, scheduledAt: number, owner = this.captureAccount(), consumeMemory = true, capturedRepos?: AccountScheduledTaskRepos): boolean {
    if (consumeMemory && this.state.tasks.get(taskId)?.enabled) return false;
    const task = this.state.tasks.get(taskId);
    try {
      const state = this.input.apiContext.db.readAccountScheduledTaskState(taskId, owner);
      const queued = this.state.queuedByTaskId.get(taskId);
      const workspaceId = queued ? queued.workspaceId : state.running?.workspaceId ?? (task ? resolveTaskWorkspaceId(task) : null);
      const watermark = Math.max(Math.floor((state.lastScheduledAt ?? 0) / TICK_INTERVAL_MS) * TICK_INTERVAL_MS, scheduledAt);
      if (capturedRepos) capturedRepos.runtime.skipAccount({ taskId, owner, scheduledAt: watermark, at: Date.now() });
      else this.accountRuntimeTransaction(workspaceId, taskId, "", owner,
        repos => repos.runtime.skipAccount({ taskId, owner, scheduledAt: watermark, at: Date.now() }), true);
    } catch (cause) {
      const error = Object.assign(new Error("账号排队触发停止事实写入失败", { cause }), {
        code: "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED", taskId, scheduledAt,
        requestId: `scheduled:${taskId}:${scheduledAt}`,
        clientId: this.input.config.clientId, deviceId: this.input.deviceId,
      });
      throw error;
    }
    if (consumeMemory) this.state.queuedByTaskId.delete(taskId);
    return true;
  }

  /** 账号出队等待已有同步并重读有效配置；本机仍沿原持久认领入口。 */
  private async runQueuedTaskIfNeeded(task: ExecutableTask, captured?: ScheduledTaskAccountContext): Promise<void> {
    if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
    if (isLocalTask(task)) {
      const queued = (await this.withDatabase(() => this.input.localApiContext!.db.getLocalScheduledTaskRuntime(task)));
      if (!queued || queued.runningRunId || queued.queuedReason !== "concurrency" || queued.queuedScheduledAt === null) return;
      const current = (await this.withDatabase(() => this.input.localApiContext!.db.getLocalScheduledTask(task.id)));
      if (!current || !current.enabled || current.deletedAt !== null) return;
      await this.runAutomaticTask(current, queued.queuedScheduledAt, { operationId: null });
      return;
    }
    if (captured) this.assertAccountCurrent(captured);
    if (!this.state.queuedByTaskId.has(task.id)) return;
    while (this.syncPromise) await this.syncPromise;
    if (this.stopping || this.input.isTaskAdmissionPaused?.()) return;
    if (captured) this.assertAccountCurrent(captured);
    const scheduledAt = this.state.queuedByTaskId.get(task.id)?.scheduledAt;
    if (scheduledAt === undefined || (await this.withDatabase(() => this.reconcileAccountQueuedTask(task.id, scheduledAt)))) return;
    if ((await this.withDatabase(() => this.input.apiContext.db.readAccountScheduledTaskState(task.id, captured ?? this.accountForTask(this.state.tasks.get(task.id)!)))).running) return;
    const current = this.state.tasks.get(task.id)!;
    this.state.queuedByTaskId.delete(task.id);
    await this.runAutomaticTask(current, scheduledAt);
  }
}

/** 本机 run_once 合并漏点为当前分钟；其他来源保留最近一分钟口径。 */
function resolveDueScheduledAt(task: ExecutableTask, now: number, lastScheduledAt: number | null): number | null {
  if (isLocalTask(task) && task.missedPolicy === "run_once_on_reconnect") {
    const dueAt = computeNextCronTimeMs(task.cronExpr, Math.max(task.updatedAt, lastScheduledAt ?? 0), task.timezone);
    return dueAt <= now ? Math.floor(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS : null;
  }
  const scheduledAt = computeNextCronTimeMs(task.cronExpr, now - TICK_INTERVAL_MS, task.timezone);
  return scheduledAt <= now ? scheduledAt : null;
}

/** 跳过记录保留外部任务身份，来源只在持久边界区分。 */
function buildSkippedRun(
  task: ExecutableTask,
  scheduledAt: number,
  summary: string,
  workflowInstanceId: OrchestrationId | null = null,
  workspaceId: WorkspaceId | null = resolveTaskWorkspaceId(task),
): ScheduledTaskRun {
  const now = Date.now();
  return {
    id: `str_${crypto.randomUUID()}`,
    taskId: task.id,
    clientId: task.clientId,
    deviceId: task.deviceId,
    workspaceId,
    workflowInstanceId,
    workflowNameSnapshot: null,
    workflowVersion: null,
    scheduledAt,
    startedAt: null,
    finishedAt: now,
    status: "skipped",
    triggerSource: "schedule",
    attempt: 1,
    durationMs: null,
    summary,
    errorMessage: null,
    outputExcerpt: null,
    createdAt: now,
  };
}

/** 构造可幂等重试的迁移配置变更 skipped 记录。 */
function buildMigrationQueueConfigSkippedRun(input: {
  task: ScheduledTask;
  scheduledAt: number;
  operationId: string;
  summary: string;
  workspaceId: WorkspaceId;
}): ScheduledTaskRun {
  const run = buildSkippedRun(input.task, input.scheduledAt, input.summary, null, input.workspaceId);
  const digest = crypto.createHash("sha256")
    .update(JSON.stringify([input.task.id, input.operationId, input.scheduledAt]))
    .digest("hex")
    .slice(0, 32);
  return { ...run, id: `str_${digest}` };
}

/** 判断迁移延期是否因最新任务配置失效；null 表示按最新配置保留补跑。 */
function resolveMigrationQueueConfigSkipReason(
  task: ScheduledTask | undefined,
  migrationWorkspaceId: WorkspaceId,
): ScheduledTaskMigrationQueueSkipReason | null {
  if (!task) return "task_deleted";
  if (!task.enabled) return "task_disabled";
  if (resolveTaskWorkspaceId(task) !== migrationWorkspaceId) return "workspace_changed";
  return null;
}

/** 工作区只取已验证配置的上下文 ID。 */
function resolveTaskWorkspaceId(task: ExecutableTask): WorkspaceId | null {
  const payload = task.payload as Partial<ScheduledTaskWorkflowPayload & ScheduledTaskScriptPayload>;
  return payload.contextWorkspaceId ?? null;
}

/** 联合类型保留本机真实字段，不补造账号归属。 */
function isLocalTask(task: ExecutableTask): task is LocalScheduledTaskConfig { return "source" in task && task.source === "local"; }

/** 账号脚本共用原耐久链路；流程保留实例及直接报告职责。 */
function isDurableAccountTask(task: ExecutableTask): boolean {
  return !isLocalTask(task) && task.taskType === "script";
}

/** generation 仅用于当前连接围栏，持久 owner 不包含它。 */
function sameAccountContext(left: ScheduledTaskAccountContext, right: ScheduledTaskAccountContext): boolean {
  return left.serverOrigin === right.serverOrigin && left.ownerUserId === right.ownerUserId && left.clientId === right.clientId
    && left.deviceId === right.deviceId && left.generation === right.generation;
}

/** 队列和持久状态共用仓储编码，防止同 ID 来源串扰。 */
function taskRuntimeKey(task: ExecutableTask): string { return scheduledTaskRuntimeKey(task.id, isLocalTask(task) ? "local" : undefined); }

/** 失败结果只保存可检索诊断码，不反射 SQL、脚本或任意异常正文。 */
function localFailureCode(error: unknown): string {
  const descriptor = error !== null && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
  const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, "message") : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code
    : message && "value" in message && typeof message.value === "string" && message.value.startsWith("SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE") ? "SCHEDULED_TASK_INTERRUPTED_FOR_UPDATE" : "SCHEDULED_TASK_EXECUTION_FAILED";
}

/** 原调度诊断失败只认自有固定码，供请求、后台和清理owner保留同一错误。 */
export function isScheduledTaskDiagnosticFailure(error: unknown): boolean {
  const code = error instanceof AggregateError ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
  return Boolean(code && "value" in code && ["SCHEDULED_TASK_TRANSACTION_LOG_FAILED", "SCHEDULED_TASK_EXECUTION_LOG_FAILED", "SCHEDULED_TASK_DISPATCH_LOG_FAILED", "SCHEDULED_TASK_REQUEST_LOG_FAILED", "SCHEDULED_TASK_SCAN_LOG_FAILED", "SCHEDULED_TASK_MIGRATION_RECONCILE_LOG_FAILED"].includes(code.value));
}

/** 驱动失败仅保留代码和数字扩展码，原始原因仍留内部 cause。 */
function safeRootCauseCode(error: unknown): string {
  const fields = error && typeof error === "object" ? error as { code?: unknown; errcode?: unknown } : {};
  const code = typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(fields.code) ? fields.code : "SQLITE_ERROR";
  return `${code}${Number.isSafeInteger(fields.errcode) ? `:${fields.errcode}` : ""}`;
}

/** 原脚本运行独占 child；更新停止复用该资源，最终结果仍等真实 close。 */
async function runScript(input: {
  payload: ScheduledTaskScriptPayload;
  workspaces: Map<WorkspaceId, string>;
  timeoutMs: number;
  owner: ScheduledRunOwner;
}): Promise<{ exitCode: number | null; timedOut: boolean; errorMessage: string | null; outputExcerpt: string | null }> {
  const cwd = resolveScriptCwd(input.payload, input.workspaces);
  const command = buildShellCommand(input.payload);
  const env = buildScriptEnv(input.payload);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let processError: Error | null = null;
    let output = "";
    const child = spawn(command.file, command.args, { cwd, env, windowsHide: true, detached: process.platform !== "win32" });
    input.owner.child = child;
    const append = (chunk: unknown) => {
      output = truncatePreserveTail(output + Buffer.from(chunk as any).toString("utf8"), OUTPUT_EXCERPT_LIMIT);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(1_000, input.timeoutMs));
    timer.unref?.();
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      processError = error;
      clearTimeout(timer);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (processError) { reject(processError); return; }
      resolve({
        exitCode: code,
        timedOut,
        errorMessage: timedOut ? `脚本超时并已终止：${input.timeoutMs}ms` : code === 0 ? null : `脚本退出码 ${code ?? "unknown"}${signal ? `，signal=${signal}` : ""}`,
        outputExcerpt: output || null,
      });
    });
  });
}

function resolveScriptCwd(payload: ScheduledTaskScriptPayload, workspaces: Map<WorkspaceId, string>): string {
  const base = payload.contextWorkspaceId
    ? workspaces.get(payload.contextWorkspaceId)
    : path.join(os.homedir(), ".codeflowai", "scheduled-tasks");
  if (!base) throw new Error(`脚本任务工作区不存在：${payload.contextWorkspaceId}`);
  fs.mkdirSync(base, { recursive: true });
  const cwd = path.resolve(base, payload.cwdRelative ?? ".");
  const relative = path.relative(base, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`脚本 cwd 越界：${payload.cwdRelative ?? "."}`);
  }
  return cwd;
}

function buildShellCommand(payload: ScheduledTaskScriptPayload): { file: string; args: string[] } {
  if (payload.shell === "powershell") return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", payload.command] };
  if (payload.shell === "cmd") return { file: "cmd.exe", args: ["/d", "/s", "/c", payload.command] };
  if (payload.shell === "bash") return { file: "bash", args: ["-lc", payload.command] };
  return { file: "sh", args: ["-lc", payload.command] };
}

function buildScriptEnv(payload: ScheduledTaskScriptPayload): NodeJS.ProcessEnv {
  const env = buildClientChildProcessEnv(process.env);
  for (const name of payload.envRefs ?? []) {
    if (!Object.prototype.hasOwnProperty.call(env, name)) {
      throw new Error(`脚本环境变量不存在：${name}`);
    }
  }

  return env;
}

/** 请求既有任务 API；HTTP 失败携带非敏感状态，供更新边界追踪上报失败。 */
async function postJson<T extends object>(httpBase: string, pathName: string, apiKey: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${httpBase}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (cause) { throw buildScheduledTaskApiError(pathName, undefined, "transport_failed", cause); }
  let parsed: any;
  try { parsed = await res.json(); }
  catch (cause) { throw buildScheduledTaskApiError(pathName, res.status, "invalid_json", cause, res.headers.get("x-request-id")); }
  if (!res.ok || parsed?.ok !== true) throw buildScheduledTaskApiError(pathName, res.status, "rejected_response", undefined, res.headers.get("x-request-id"));
  if (pathName.endsWith("/report") && (!Number.isSafeInteger(parsed.serverNow) || parsed.serverNow < 0)) throw buildScheduledTaskApiError(pathName, res.status, "invalid_ack", undefined, res.headers.get("x-request-id"));
  return parsed as T;
}

/** API 错误只携带可检索边界，不回显远端正文、命令或凭据。 */
function buildScheduledTaskApiError(pathName: string, httpStatus: number | undefined, reason: string, cause?: unknown, upstreamRequestId?: string | null): Error {
  return Object.assign(new Error(`Scheduled task API failed ${pathName}: ${httpStatus ?? "transport"}`, { cause }), {
    code: "SCHEDULED_TASK_API_FAILED", httpStatus, pathName, reason,
    upstreamRequestId: typeof upstreamRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(upstreamRequestId) ? upstreamRequestId : undefined,
  });
}

function toHttpBaseFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function truncatePreserveTail(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(value.length - maxLength);
}

/** 处理边界只投影安全关联字段和指纹；正文留在内部 cause，至多三层。 */
export function toErrorLog(error: unknown, depth = 0): { error: Record<string, unknown> } {
  const type = error === null ? "null" : typeof error;
  const fields: Record<string, unknown> = {};
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    for (const key of ["name", "message", "code", "field", "rootCauseCode", "taskId", "requestId", "clientId", "deviceId", "ownerUserId",
      "serverOrigin", "stage", "scheduledAt", "runId", "workspaceId", "revision", "httpStatus", "upstreamRequestId", "reason", "cause", "errors"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor && "value" in descriptor) fields[key] = descriptor.value;
    }
  }
  if (error instanceof Error && fields.name === undefined) fields.name = error instanceof AggregateError ? "AggregateError"
    : error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError"
      : error instanceof ReferenceError ? "ReferenceError" : error instanceof URIError ? "URIError" : error instanceof EvalError ? "EvalError" : "Error";
  const fingerprintSource = error instanceof Error ? `${typeof fields.name === "string" ? fields.name : "Error"}:${typeof fields.message === "string" ? fields.message : ""}`
    : error === null || ["undefined", "string", "number", "boolean", "bigint", "symbol"].includes(type) ? String(error) : type;
  const errors = fields.errors;
  const length = Array.isArray(errors) ? Object.getOwnPropertyDescriptor(errors, "length") : undefined;
  const errorCount = length && "value" in length && Number.isSafeInteger(length.value) && length.value >= 0 ? Math.min(length.value, 8) : 0;
  return { error: {
    type: error instanceof Error ? "Error" : type,
    name: typeof fields.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(fields.name) ? fields.name : undefined,
    systemCode: typeof fields.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code) ? fields.code : undefined,
    field: typeof fields.field === "string" && /^[A-Za-z0-9_.]{1,80}$/.test(fields.field) ? fields.field : undefined,
    rootCauseCode: typeof fields.rootCauseCode === "string" && /^[A-Z0-9_:]{1,100}$/.test(fields.rootCauseCode) ? fields.rootCauseCode : undefined,
    taskId: typeof fields.taskId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.taskId) ? fields.taskId : undefined,
    requestId: typeof fields.requestId === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(fields.requestId) ? fields.requestId : undefined,
    clientId: typeof fields.clientId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.clientId) ? fields.clientId : undefined,
    deviceId: typeof fields.deviceId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.deviceId) ? fields.deviceId : undefined,
    ownerUserId: typeof fields.ownerUserId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.ownerUserId) ? fields.ownerUserId : undefined,
    serverOrigin: typeof fields.serverOrigin === "string" && /^https?:\/\/[^\s/@?#]+$/.test(fields.serverOrigin) ? fields.serverOrigin : undefined,
    stage: typeof fields.stage === "string" && /^[a-z][a-z_]{0,63}$/.test(fields.stage) ? fields.stage : undefined,
    scheduledAt: Number.isSafeInteger(fields.scheduledAt) && Number(fields.scheduledAt) >= 0 ? fields.scheduledAt : undefined,
    runId: typeof fields.runId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.runId) ? fields.runId : undefined,
    workspaceId: typeof fields.workspaceId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(fields.workspaceId) ? fields.workspaceId : undefined,
    revision: Number.isSafeInteger(fields.revision) && Number(fields.revision) >= 1 ? fields.revision : undefined,
    httpStatus: Number.isSafeInteger(fields.httpStatus) && Number(fields.httpStatus) >= 100 && Number(fields.httpStatus) <= 599 ? fields.httpStatus : undefined,
    upstreamRequestId: typeof fields.upstreamRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(fields.upstreamRequestId) ? fields.upstreamRequestId : undefined,
    reason: typeof fields.reason === "string" && ["transport_failed", "invalid_json", "rejected_response", "invalid_ack"].includes(fields.reason) ? fields.reason : undefined,
    fingerprint: crypto.createHash("sha256").update(fingerprintSource).digest("hex"),
    ...(depth < 3 && Object.prototype.hasOwnProperty.call(fields, "cause") ? { cause: toErrorLog(fields.cause, depth + 1).error } : {}),
    ...(depth < 3 && error instanceof AggregateError && Array.isArray(errors) ? { errors: Array.from({ length: errorCount }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
      return toErrorLog(descriptor && "value" in descriptor ? descriptor.value : undefined, depth + 1).error;
    }) } : {}),
  } };
}
