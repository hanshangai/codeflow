import { performance } from "node:perf_hooks";

import type { RawEngineEventRepo } from "../db/repos/eventRepo.js";

export type RawEventRetentionRunResult = {
  cutoffSeqExclusive: number;
  deletedRows: number;
  batchCount: number;
  configuredBatchSize: number;
  initialBatchSize: number;
  finalBatchSize: number;
  batchSizeAdjustmentCount: number;
  deleteDurationMs: number;
  maxBatchDeleteDurationMs: number;
  durationMs: number;
};

export type RawEventRetentionRunFailure = RawEventRetentionRunResult & {
  error: unknown;
};

export type RawEventRetentionPressureSnapshot = {
  shouldDefer: boolean;
  reasons: string[];
  inboundMessages: number;
  inboundBytes: number;
  activeHandlers: number;
  eventLoopLagMaxMs: number;
  eventLoopLagP99Ms: number;
};

const RAW_EVENT_RETENTION_DELETE_BUDGET_MS = 25;
const RAW_EVENT_RETENTION_INITIAL_BATCH_MAX = 10;

/** 分批清理过期 raw 事件，并在批次间让出事件循环。 */
export function createRawEventRetentionWorker(
  repo: Pick<RawEngineEventRepo, "deleteBeforeSeq">,
  opts: {
    batchSize?: number;
    batchDelayMs?: number;
    pressureRetryDelayMs?: number;
    /** 仅用于注入单调时钟，生产环境默认使用 performance.now。 */
    now?: () => number;
    getRuntimePressure?: () => RawEventRetentionPressureSnapshot;
    onDeferred?: (input: { cutoffSeqExclusive: number; pressure: RawEventRetentionPressureSnapshot }) => void;
    onResumed?: (input: { cutoffSeqExclusive: number; pressure: RawEventRetentionPressureSnapshot }) => void;
    onComplete?: (result: RawEventRetentionRunResult) => void;
    onError: (failure: RawEventRetentionRunFailure) => void;
    withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  },
) {
  const configuredBatchSize = Math.max(1, Math.min(1_000, Math.floor(Number(opts.batchSize ?? 100))));
  const batchDelayMs = Math.max(0, Math.floor(Number(opts.batchDelayMs ?? 25)));
  const pressureRetryDelayMs = normalizePressureRetryDelay(opts.pressureRetryDelayMs);
  const now = opts.now ?? (() => performance.now());
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deferredForPressure = false;
  let failureRecord: { error: unknown } | null = null;
  let activeBatch: Promise<void> | null = null;
  let runSettled = Promise.resolve();
  let settleRun: () => void = () => {};
  let run: {
    cutoffSeqExclusive: number;
    deletedRows: number;
    batchCount: number;
    initialBatchSize: number;
    currentBatchSize: number;
    finalBatchSize: number;
    batchSizeAdjustmentCount: number;
    deleteDurationMs: number;
    maxBatchDeleteDurationMs: number;
    startedAt: number;
  } | null = null;

  /** 返回当前运行统计并清空运行态。 */
  function finishRun(): RawEventRetentionRunResult | null {
    if (!run) return null;
    const result: RawEventRetentionRunResult = {
      cutoffSeqExclusive: run.cutoffSeqExclusive,
      deletedRows: run.deletedRows,
      batchCount: run.batchCount,
      configuredBatchSize,
      initialBatchSize: run.initialBatchSize,
      finalBatchSize: run.finalBatchSize,
      batchSizeAdjustmentCount: run.batchSizeAdjustmentCount,
      deleteDurationMs: roundDuration(run.deleteDurationMs),
      maxBatchDeleteDurationMs: roundDuration(run.maxBatchDeleteDurationMs),
      durationMs: Date.now() - run.startedAt,
    };
    run = null;
    settleRun();
    return result;
  }

  /** 调度下一小批清理，确保同步 SQLite 操作之间可以处理网络和引擎事件。 */
  function scheduleBatch(delayMs: number): void {
    if (disposed || !run || timer || failureRecord) return;
    timer = setTimeout(runBatch, delayMs);
  }

  /** 计时器失败留在原owner；通知再错保两侧原值，禁止逃全局或周期重试。 */
  function retainFailure(error: unknown, result: RawEventRetentionRunResult): void {
    if (timer) clearTimeout(timer);
    timer = null;
    run = null;
    deferredForPressure = false;
    failureRecord = { error };
    try { opts.onError({ ...result, error }); }
    catch (notificationError) {
      failureRecord = { error: new AggregateError([error, notificationError], "RAW_EVENT_RETENTION_NOTIFICATION_FAILED", { cause: error }) };
    }
  }

  /** 执行原分批策略；任一阶段失败均停止后续删除并交原owner观察。 */
  function runBatch(): void {
    timer = null;
    if (disposed || !run || failureRecord) return;
    const pending = runBatchWork();
    activeBatch = pending;
    void pending.then(() => { if (activeBatch === pending) activeBatch = null; });
  }

  /** 仅删除与计时进入同步许可；排队和压力重试由当前批次owner等待。 */
  async function runBatchWork(): Promise<void> {
    if (!run) return;
    let completed: RawEventRetentionRunResult | null = null;
    try {
      const pressure = opts.getRuntimePressure?.() ?? null;
      if (pressure?.shouldDefer) {
        if (!deferredForPressure) {
          deferredForPressure = true;
          opts.onDeferred?.({ cutoffSeqExclusive: run.cutoffSeqExclusive, pressure });
        }
        scheduleBatch(pressureRetryDelayMs);
        return;
      }
      if (deferredForPressure) {
        deferredForPressure = false;
        opts.onResumed?.({ cutoffSeqExclusive: run.cutoffSeqExclusive, pressure: pressure ?? emptyPressureSnapshot() });
      }
      const requestedBatchSize = run.currentBatchSize;
      const cutoff = run.cutoffSeqExclusive;
      const deletion = () => {
        if (disposed) return { deleted: 0, deleteDurationMs: 0 };
        const deleteStartedAt = now();
        let deleted = 0, deletionFailure: { error: unknown } | null = null;
        try { deleted = repo.deleteBeforeSeq(cutoff, requestedBatchSize); }
        catch (error) { deletionFailure = { error }; }
        let deleteDurationMs: number;
        try { deleteDurationMs = Math.max(0, now() - deleteStartedAt); }
        catch (timingError) {
          throw deletionFailure ? new AggregateError([deletionFailure.error, timingError], "RAW_EVENT_RETENTION_TIMING_FAILED", { cause: deletionFailure.error }) : timingError;
        }
        recordDeleteDuration(deleteDurationMs);
        if (deletionFailure) throw deletionFailure.error;
        return { deleted, deleteDurationMs };
      };
      const { deleted, deleteDurationMs } = opts.withLegacyDatabase
        ? await opts.withLegacyDatabase(`raw-retention:${cutoff}`, deletion) : deletion();
      if (disposed) { finishRun(); return; }
      run.deletedRows += deleted;
      run.batchCount += 1;
      if (deleted < requestedBatchSize) {
        completed = finishRun();
        if (completed) opts.onComplete?.(completed);
        return;
      }
      const nextBatchSize = adjustRawEventRetentionBatchSize({
        currentBatchSize: requestedBatchSize,
        configuredBatchSize,
        deleteDurationMs,
      });
      if (nextBatchSize !== run.currentBatchSize) run.batchSizeAdjustmentCount += 1;
      run.currentBatchSize = nextBatchSize;
      run.finalBatchSize = nextBatchSize;
      scheduleBatch(resolveAdaptiveBatchDelay(batchDelayMs, deleteDurationMs));
    } catch (error) {
      retainFailure(error, completed ?? finishRun()!);
    }
  }

  /** 累加同步 SQLite 删除耗时，区分数据库占用与批次间排队时间。 */
  function recordDeleteDuration(durationMs: number): void {
    if (!run) return;
    run.deleteDurationMs += durationMs;
    run.maxBatchDeleteDurationMs = Math.max(run.maxBatchDeleteDurationMs, durationMs);
  }

  /** 只观察原失败，周期触发和关闭均不得清空或替换该记录。 */
  function assertNoFailure(): void {
    if (failureRecord) throw failureRecord.error;
  }

  return {
    /** 启动原清理轮次；原失败显式抛出，只有忙碌状态返回false。 */
    trigger(cutoffSeqExclusive: number): boolean {
      assertNoFailure();
      const cutoffSeq = Math.floor(Number(cutoffSeqExclusive ?? 0));
      if (!Number.isFinite(cutoffSeq) || cutoffSeq <= 0) {
        throw new Error("Invalid raw event retention cutoff sequence");
      }
      if (disposed) throw new Error("Raw event retention worker is disposed");
      if (run) return false;
      const initialBatchSize = Math.min(configuredBatchSize, RAW_EVENT_RETENTION_INITIAL_BATCH_MAX);
      run = {
        cutoffSeqExclusive: cutoffSeq,
        deletedRows: 0,
        batchCount: 0,
        initialBatchSize,
        currentBatchSize: initialBatchSize,
        finalBatchSize: initialBatchSize,
        batchSizeAdjustmentCount: 0,
        deleteDurationMs: 0,
        maxBatchDeleteDurationMs: 0,
        startedAt: Date.now(),
      };
      runSettled = new Promise(resolve => { settleRun = resolve; });
      deferredForPressure = false;
      scheduleBatch(0);
      return true;
    },
    assertNoFailure,
    /** 等待已登记轮次及其当前批次，原失败仍由同一worker显式返回。 */
    async waitIdle(): Promise<void> {
      await runSettled;
      if (activeBatch) await activeBatch;
      assertNoFailure();
    },
    /** 先取消全部后续访问，再把原失败显式交给关闭owner。 */
    dispose(): void | Promise<void> {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      assertNoFailure();
      const finish = () => { run = null; deferredForPressure = false; settleRun(); assertNoFailure(); };
      if (activeBatch) return activeBatch.then(finish);
      finish();
    },
    /** 判断是否有清理轮次正在运行。 */
    isRunning(): boolean {
      return run != null;
    },
  };
}

/** 按同步删除耗时预算收缩或渐进恢复下一批大小。 */
function adjustRawEventRetentionBatchSize(input: {
  currentBatchSize: number;
  configuredBatchSize: number;
  deleteDurationMs: number;
}): number {
  if (input.deleteDurationMs > RAW_EVENT_RETENTION_DELETE_BUDGET_MS) {
    const proportional = Math.floor(
      input.currentBatchSize * RAW_EVENT_RETENTION_DELETE_BUDGET_MS / input.deleteDurationMs,
    );
    return Math.max(1, Math.min(input.currentBatchSize - 1, proportional));
  }
  if (input.deleteDurationMs < RAW_EVENT_RETENTION_DELETE_BUDGET_MS / 2) {
    return Math.min(
      input.configuredBatchSize,
      Math.max(input.currentBatchSize + 1, Math.ceil(input.currentBatchSize * 1.25)),
    );
  }
  return input.currentBatchSize;
}

/** 超出同步删除预算时延长批次间隔，给前台事件处理留出恢复窗口。 */
function resolveAdaptiveBatchDelay(batchDelayMs: number, deleteDurationMs: number): number {
  if (deleteDurationMs <= RAW_EVENT_RETENTION_DELETE_BUDGET_MS) return batchDelayMs;
  return Math.max(batchDelayMs, Math.ceil(deleteDurationMs));
}

/** 提供未接入压力采样时的显式零值恢复快照。 */
function emptyPressureSnapshot(): RawEventRetentionPressureSnapshot {
  return {
    shouldDefer: false,
    reasons: [],
    inboundMessages: 0,
    inboundBytes: 0,
    activeHandlers: 0,
    eventLoopLagMaxMs: 0,
    eventLoopLagP99Ms: 0,
  };
}

/** 保留两位小数，避免高精度计时噪声污染结构化日志。 */
function roundDuration(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 规范压力重试间隔，避免非法测试配置制造忙循环。 */
function normalizePressureRetryDelay(value: unknown): number {
  if (value == null) return 250;
  const delayMs = Math.floor(Number(value));
  if (!Number.isFinite(delayMs) || delayMs < 1 || delayMs > 60_000) {
    throw new Error(`Invalid raw event retention pressure retry delay: ${String(value)}`);
  }
  return delayMs;
}
