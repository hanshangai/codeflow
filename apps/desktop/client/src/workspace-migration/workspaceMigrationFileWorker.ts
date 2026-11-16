import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

import {
  WorkspaceMigrationFileError,
  copyWorkspaceMigrationTree,
  probeWorkspaceMigrationTarget,
  scanWorkspaceMigrationTree,
  verifyWorkspaceMigrationTrees,
  snapshotWorkspaceDatabase,
  verifyWorkspaceDatabase,
} from "./workspaceMigrationFileOps.js";
import type {
  WorkspaceMigrationFileCommand,
  WorkspaceMigrationFileErrorData,
  WorkspaceMigrationFileProgress,
  WorkspaceMigrationFileWorkerControl,
  WorkspaceMigrationFileWorkerData,
  WorkspaceMigrationFileWorkerMessage,
  WorkspaceMigrationWatchCommand,
} from "./workspaceMigrationFileProtocol.js";

const input = normalizeWorkerData(workerData);
const cancelView = new Int32Array(input.cancelBuffer);

void runWorker(input)
  .then(() => {
    if (input.command.type !== "watch") parentPort?.close();
  })
  .catch((error) => {
    post({ type: "failed", taskId: input.taskId, error: toErrorData(error, "worker_failed") });
    parentPort?.close();
  });

/** 执行一次性文件命令，watch 命令则保持事件循环直到主线程停止。 */
async function runWorker(data: WorkspaceMigrationFileWorkerData): Promise<void> {
  const hooks = {
    isCancelled: () => Atomics.load(cancelView, 0) === 1,
    onProgress: (progress: WorkspaceMigrationFileProgress) => {
      post({ type: "progress", taskId: data.taskId, progress });
    },
  };
  const command = data.command;
  if (command.type === "watch") {
    startWatcher(data.taskId, command);
    return;
  }
  const result = command.type === "workspace-db.snapshot"
    ? await snapshotWorkspaceDatabase(command, hooks)
    : command.type === "workspace-db.verify"
      ? await verifyWorkspaceDatabase(command, hooks)
      : command.type === "scan"
    ? await scanWorkspaceMigrationTree(command, hooks)
    : command.type === "copy"
      ? await copyWorkspaceMigrationTree(command, hooks)
      : command.type === "verify"
        ? await verifyWorkspaceMigrationTrees(command, hooks)
        : await probeWorkspaceMigrationTarget(command, hooks);
  post({ type: "result", taskId: data.taskId, result });
}

/** 启动递归或单层文件监听；缺失 filename 和 watcher error 都显式上报。 */
function startWatcher(taskId: string, command: WorkspaceMigrationWatchCommand): void {
  let stopped = false;
  let watcher: fs.FSWatcher;
  try {
    const filter = normalizeFilter(command.filterRelativePath, command.caseSensitive);
    watcher = fs.watch(command.watchRoot, { recursive: command.recursive }, (eventType, filename) => {
      if (stopped) return;
      const relativePath = normalizeWatchPath(filename, command.caseSensitive);
      if (relativePath && filter && relativePath !== filter && !relativePath.startsWith(`${filter}/`)) return;
      post({
        type: "watch.changed",
        taskId,
        // fs.watch 事件只作复核提示，是否失败由内容清单决定，不直接监控访问时间。
        eventType: eventType === "change" ? "change" : "rename",
        relativePath,
      });
    });
  } catch (error) {
    post({ type: "watch.error", taskId, error: toErrorData(error, "watch_start_failed") });
    parentPort?.close();
    return;
  }
  watcher.once("error", (error) => {
    if (stopped) return;
    stopped = true;
    watcher.close();
    const code = (error as NodeJS.ErrnoException).code;
    post({
      type: "watch.error",
      taskId,
      error: toErrorData(error, code === "ENOSPC" ? "watch_overflow" : "watch_runtime_failed"),
    });
    parentPort?.close();
  });
  parentPort!.on("message", (message: WorkspaceMigrationFileWorkerControl) => {
    if (message?.type !== "watch.stop" || message.taskId !== taskId || stopped) return;
    stopped = true;
    watcher.close();
    post({ type: "watch.stopped", taskId });
    parentPort!.close();
  });
  post({ type: "watch.ready", taskId });
}

/** 校验跨线程初始数据，避免未知命令在 Worker 内继续执行。 */
function normalizeWorkerData(value: unknown): WorkspaceMigrationFileWorkerData {
  const raw = value as Partial<WorkspaceMigrationFileWorkerData> | null;
  const taskId = String(raw?.taskId ?? "").trim();
  if (!taskId) throw new Error("workspace migration file worker 缺少 taskId");
  if (!(raw?.cancelBuffer instanceof SharedArrayBuffer) || raw.cancelBuffer.byteLength < 4) {
    throw new Error("workspace migration file worker 缺少 cancelBuffer");
  }
  const command = raw.command as WorkspaceMigrationFileCommand | undefined;
  if (!command || !["scan", "copy", "verify", "probe", "watch", "workspace-db.snapshot", "workspace-db.verify"].includes(command.type)) {
    throw new Error("workspace migration file worker 命令非法");
  }
  return { taskId, command, cancelBuffer: raw.cancelBuffer };
}

/** 归一化监听过滤前缀，只接受工作区相对路径。 */
function normalizeFilter(value: string | null | undefined, caseSensitive: boolean): string | null {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw)) {
    throw new Error("workspace migration watch filter 必须是相对路径");
  }
  const normalized = raw.replace(/^\.\/+/, "").replace(/\/+$/g, "");
  if (!normalized) return null;
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("workspace migration watch filter 非法");
  }
  return caseSensitive ? normalized : normalized.toUpperCase();
}

/** 归一化 fs.watch filename；无法定位具体路径时返回 null 触发 fail-closed。 */
function normalizeWatchPath(value: string | Buffer | null, caseSensitive: boolean): string | null {
  if (value == null) return null;
  const normalized = String(value).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+|\/+$/g, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => part === "..")) return null;
  return caseSensitive ? normalized : normalized.toUpperCase();
}

/** 将内部异常转换为不含绝对路径的跨线程错误。 */
function toErrorData(error: unknown, fallbackReason: string): WorkspaceMigrationFileErrorData {
  if (error instanceof WorkspaceMigrationFileError) {
    return { code: error.code, message: error.message, details: { ...error.details, ...summarizeRootCause(error.cause) } };
  }
  return {
    code: "WORKSPACE_MIGRATION_VERIFY_FAILED",
    message: "工作区文件 Worker 执行失败",
    details: { reason: fallbackReason, ...summarizeRootCause(error) },
  };
}

/** 提取不含 message、stack 和本地路径的底层错误类型及操作系统错误码。 */
function summarizeRootCause(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") return {};
  const rawType = String((error as { name?: unknown }).name ?? error.constructor?.name ?? "Error");
  const rawCode = String((error as NodeJS.ErrnoException).code ?? "");
  const details: Record<string, string> = {};
  if (/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(rawType)) details.rootCauseType = rawType;
  if (/^[A-Za-z0-9_.-]{1,32}$/.test(rawCode)) details.osErrorCode = rawCode;
  return details;
}

/** 向主线程发送结构化消息，缺失 parentPort 时显式失败。 */
function post(message: WorkspaceMigrationFileWorkerMessage): void {
  if (!parentPort) throw new Error("workspace migration file worker 缺少 parentPort");
  parentPort.postMessage(message);
}
