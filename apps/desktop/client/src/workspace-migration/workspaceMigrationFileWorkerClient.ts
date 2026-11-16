import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";

import type {
  WorkspaceMigrationCopyCommand,
  WorkspaceMigrationCopyResult,
  WorkspaceMigrationFileCommand,
  WorkspaceMigrationFileErrorData,
  WorkspaceMigrationFileProgress,
  WorkspaceMigrationFileWorkerData,
  WorkspaceMigrationFileWorkerMessage,
  WorkspaceMigrationProbeCommand,
  WorkspaceMigrationProbeResult,
  WorkspaceMigrationScanCommand,
  WorkspaceMigrationScanResult,
  WorkspaceMigrationVerifyCommand,
  WorkspaceMigrationVerifyResult,
  WorkspaceMigrationWatchCommand,
  WorkspaceMigrationSnapshotCommand,
  WorkspaceMigrationSnapshotResult,
  WorkspaceMigrationDbVerifyCommand,
} from "./workspaceMigrationFileProtocol.js";

const WATCH_STOP_TIMEOUT_MS = 5_000;

type TaskOptions = {
  onProgress?: (progress: WorkspaceMigrationFileProgress) => void;
  waitForExit?: boolean;
};

export type WorkspaceMigrationFileWorkerClientOptions = {
  workerPath?: string;
  watchStopTimeoutMs?: number;
};

export type WorkspaceMigrationFileTask<T> = {
  taskId: string;
  promise: Promise<T>;
  closed?: Promise<void>;
  cancel: () => void;
  terminate: () => Promise<number>;
};

export type WorkspaceMigrationFileWatcher = {
  taskId: string;
  ready: Promise<void>;
  closed: Promise<void>;
  stop: () => Promise<void>;
  terminate: () => Promise<number>;
};

export type WorkspaceMigrationFileWatcherCallbacks = {
  onChanged: (event: { eventType: "rename" | "change"; relativePath: string | null }) => void;
  onError: (error: WorkspaceMigrationFileClientError) => void;
};

/** 主线程可检索的 Worker 错误；details 来自已脱敏跨线程协议。 */
export class WorkspaceMigrationFileClientError extends Error {
  constructor(
    public readonly code: WorkspaceMigrationFileErrorData["code"],
    message: string,
    public readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceMigrationFileClientError";
  }
}

/** 文件 Worker 主线程入口；每个重任务独占 Worker，watch 独立长驻。 */
export class WorkspaceMigrationFileWorkerClient {
  /** 可选 Worker 路径和停止超时仅用于发布态定位及可控生命周期测试。 */
  constructor(private readonly options: WorkspaceMigrationFileWorkerClientOptions = {}) {}

  /** 最终数据库复制必须连同 Worker 真实退出一起结算。 */
  snapshotWorkspaceDb(input: Omit<WorkspaceMigrationSnapshotCommand, "type">): WorkspaceMigrationFileTask<WorkspaceMigrationSnapshotResult> {
    return this.startTask({ type: "workspace-db.snapshot", ...input });
  }

  /** 恢复/清理只读校验复用原 Worker，不发布或修复目标。 */
  verifyWorkspaceDb(input: Omit<WorkspaceMigrationDbVerifyCommand, "type">): WorkspaceMigrationFileTask<{ verified: true }> {
    return this.startTask({ type: "workspace-db.verify", ...input });
  }

  /** 启动预检或权威源扫描。 */
  scan(
    input: Omit<WorkspaceMigrationScanCommand, "type">,
    options?: TaskOptions,
  ): WorkspaceMigrationFileTask<WorkspaceMigrationScanResult> {
    return this.startTask({ type: "scan", ...input }, options);
  }

  /** 启动源到 staging 的流式复制。 */
  copy(
    input: Omit<WorkspaceMigrationCopyCommand, "type">,
    options?: TaskOptions,
  ): WorkspaceMigrationFileTask<WorkspaceMigrationCopyResult> {
    return this.startTask({ type: "copy", ...input }, options);
  }

  /** 启动源和目标的完整清单校验。 */
  verify(
    input: Omit<WorkspaceMigrationVerifyCommand, "type">,
    options?: TaskOptions,
  ): WorkspaceMigrationFileTask<WorkspaceMigrationVerifyResult> {
    return this.startTask({ type: "verify", ...input }, options);
  }

  /** 启动目标文件系统能力探测。 */
  probe(
    input: Omit<WorkspaceMigrationProbeCommand, "type">,
    options?: TaskOptions,
  ): WorkspaceMigrationFileTask<WorkspaceMigrationProbeResult> {
    return this.startTask({ type: "probe", ...input }, options);
  }

  /** 启动源、目标父目录或最终目标监听。 */
  watch(
    input: Omit<WorkspaceMigrationWatchCommand, "type">,
    callbacks: WorkspaceMigrationFileWatcherCallbacks,
  ): WorkspaceMigrationFileWatcher {
    const taskId = crypto.randomUUID();
    const worker = createWorkspaceMigrationFileWorker({
      taskId,
      command: { type: "watch", ...input },
      cancelBuffer: new SharedArrayBuffer(4),
    }, this.options.workerPath);
    let readySettled = false;
    let closedSettled = false;
    let stopAcknowledged = false;
    let terminalError: WorkspaceMigrationFileClientError | null = null;
    let stopPromise: Promise<void> | null = null;
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let resolveClosed!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    /** 将 watcher 失败收敛一次；closed 只表达资源已关闭，错误由 ready 或 onError 显式暴露。 */
    const fail = (error: WorkspaceMigrationFileClientError) => {
      if (terminalError || closedSettled) return;
      terminalError = error;
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      callbacks.onError(error);
    };

    worker.on("message", (message: WorkspaceMigrationFileWorkerMessage) => {
      if (!message || message.taskId !== taskId) return;
      if (closedSettled) return;
      if (message.type === "watch.ready") {
        if (!readySettled) {
          readySettled = true;
          resolveReady();
        }
        return;
      }
      if (message.type === "watch.changed") {
        callbacks.onChanged({ eventType: message.eventType, relativePath: message.relativePath });
        return;
      }
      if (message.type === "watch.stopped") {
        stopAcknowledged = true;
        return;
      }
      if (message.type === "watch.error" || message.type === "failed") fail(toClientError(message.error));
    });
    worker.once("error", (error) => fail(workerRuntimeError(error)));
    worker.once("exit", (code) => {
      if (!stopAcknowledged && !terminalError) fail(workerRuntimeError(new Error(`watch worker exited code=${code}`)));
      closedSettled = true; resolveClosed();
    });

    return {
      taskId,
      ready,
      closed,
      stop: async () => {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          if (closedSettled) { if (terminalError) throw terminalError; return; }
          try {
            if (!terminalError) worker.postMessage({ type: "watch.stop", taskId });
          } catch (error) {
            const clientError = workerRuntimeError(error);
            fail(clientError);
            throw clientError;
          }
          let timer: ReturnType<typeof setTimeout> | null = null;
          const stopTimeoutMs = normalizePositiveTimeout(this.options.watchStopTimeoutMs, WATCH_STOP_TIMEOUT_MS);
          try {
            await Promise.race([
              closed,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(watchStopTimeoutError(stopTimeoutMs)), stopTimeoutMs);
              }),
            ]);
          } catch (error) {
            const clientError = error instanceof WorkspaceMigrationFileClientError ? error : workerRuntimeError(error);
            fail(clientError);
            try { await worker.terminate(); }
            catch (terminationError) { throw new AggregateError([clientError, terminationError], "WORKSPACE_MIGRATION_WATCHER_TERMINATE_FAILED", { cause: clientError }); }
            throw clientError;
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (terminalError) throw terminalError;
        })();
        return stopPromise;
      },
      terminate: () => worker.terminate(),
    };
  }

  /** 创建一次性 Worker 任务并暴露共享内存取消标记。 */
  private startTask<T>(command: WorkspaceMigrationFileCommand, options?: TaskOptions): WorkspaceMigrationFileTask<T> {
    const taskId = crypto.randomUUID();
    const cancelBuffer = new SharedArrayBuffer(4);
    const cancelView = new Int32Array(cancelBuffer);
    const worker = createWorkspaceMigrationFileWorker({ taskId, command, cancelBuffer }, this.options.workerPath);
    const closed = new Promise<void>(resolve => { worker.once("exit", () => resolve()); });
    let settled = false;
    const waitForExit = options?.waitForExit === true || command.type === "workspace-db.snapshot" || command.type === "workspace-db.verify";
    let received: { result: T } | { error: unknown } | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      worker.on("message", (message: WorkspaceMigrationFileWorkerMessage) => {
        if (!message || message.taskId !== taskId) return;
        if (message.type === "progress") {
          options?.onProgress?.(message.progress);
          return;
        }
        if (message.type === "result") {
          if (waitForExit) { received = { result: message.result as T }; return; }
          settled = true;
          resolve(message.result as T);
          return;
        }
        if (message.type === "failed") {
          if (waitForExit) { received = { error: toClientError(message.error) }; return; }
          settled = true;
          reject(toClientError(message.error));
        }
      });
      worker.once("error", (error) => {
        if (settled) return;
        if (waitForExit) { received = { error: received && "error" in received ? new AggregateError([received.error, error], "WORKSPACE_DB_WORKER_FAILED", { cause: received.error }) : workerRuntimeError(error) }; return; }
        settled = true;
        reject(workerRuntimeError(error));
      });
      worker.once("exit", (code) => {
        if (settled) return;
        settled = true;
        if (waitForExit && received) {
          if ("error" in received) reject(received.error);
          else if (code === 0) resolve(received.result);
          else reject(workerRuntimeError(new Error(`file worker exited code=${code}`)));
          return;
        }
        reject(workerRuntimeError(new Error(`file worker exited before result code=${code}`)));
      });
    });
    return {
      taskId,
      promise,
      closed,
      cancel: () => {
        Atomics.store(cancelView, 0, 1);
        Atomics.notify(cancelView, 0);
      },
      terminate: () => worker.terminate(),
    };
  }
}

/** 解析 Worker 路径，开发态使用 TS 源码，发布包使用构建后的 CJS。 */
function resolveWorkspaceMigrationFileWorkerPath(configuredPath?: string): string {
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    if (fs.existsSync(resolved)) return resolved;
    throw new Error("配置的 workspace migration file worker 不存在");
  }
  const bundledFile = typeof __filename === "string" ? __filename : "";
  if (bundledFile) {
    const bundledWorker = path.resolve(path.dirname(bundledFile), "workspaceMigrationFileWorker.cjs");
    if (fs.existsSync(bundledWorker)) return bundledWorker;
  }
  const mainFile = path.resolve(String(process.argv[1] ?? ""));
  const distWorker = path.resolve(path.dirname(mainFile), "workspaceMigrationFileWorker.cjs");
  if (fs.existsSync(distWorker)) return distWorker;
  const sourceWorker = path.resolve(process.cwd(), "apps/desktop/client/src/workspace-migration/workspaceMigrationFileWorker.ts");
  if (fs.existsSync(sourceWorker)) return sourceWorker;
  const localSourceWorker = path.resolve(process.cwd(), "src/workspace-migration/workspaceMigrationFileWorker.ts");
  if (fs.existsSync(localSourceWorker)) return localSourceWorker;
  throw new Error("找不到 workspace migration file worker");
}

/** 创建文件 Worker；开发态通过 tsx bootstrap，发布态直接运行 CJS。 */
function createWorkspaceMigrationFileWorker(workerData: WorkspaceMigrationFileWorkerData, configuredPath?: string): Worker {
  const workerPath = resolveWorkspaceMigrationFileWorkerPath(configuredPath);
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

/** 转换 Worker 协议错误。 */
function toClientError(error: WorkspaceMigrationFileErrorData): WorkspaceMigrationFileClientError {
  return new WorkspaceMigrationFileClientError(error.code, error.message, error.details);
}

/** 转换 Worker runtime 异常，cause 仅供 Client 本地结构化日志使用。 */
function workerRuntimeError(error: unknown): WorkspaceMigrationFileClientError {
  return new WorkspaceMigrationFileClientError(
    "WORKSPACE_MIGRATION_VERIFY_FAILED",
    "工作区文件 Worker 异常退出",
    { reason: "worker_runtime_failed", ...summarizeRuntimeError(error) },
    error === undefined ? undefined : { cause: error },
  );
}

/** 提取不含本地路径的 Worker runtime 错误类型和操作系统错误码。 */
function summarizeRuntimeError(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const rawType = String((error as { name?: unknown }).name ?? error.constructor?.name ?? "Error");
  const rawCode = String((error as NodeJS.ErrnoException).code ?? "");
  const details: Record<string, string> = {};
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)) details.rootCauseType = rawType;
  if (/^[A-Za-z0-9_.-]{1,32}$/.test(rawCode)) details.osErrorCode = rawCode;
  return details;
}

/** 构造 watcher 停止超时错误，供回调和 stop 调用方使用同一终态。 */
function watchStopTimeoutError(timeoutMs: number): WorkspaceMigrationFileClientError {
  return new WorkspaceMigrationFileClientError(
    "WORKSPACE_MIGRATION_VERIFY_FAILED",
    "工作区文件监听停止超时",
    { reason: "watch_stop_timeout", timeoutMs },
  );
}

/** 读取正整数超时，非法测试配置回退到生产默认值。 */
function normalizePositiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
