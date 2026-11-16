import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { performance } from "node:perf_hooks";

import { engineDiagnosticCause, writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "../threadSession.js";
import type { CodexRuntimeConfig } from "../../enginesConfig.js";
import { CodexAppServerWorkspace } from "./codexAppServerWorkspace.js";

type CodexAppServerProcessRecord = {
  workspaceId: WorkspaceId;
  workspacePath: string;
  workspace: CodexAppServerWorkspace;
};

type CodexStdoutDispatchTask = {
  run: () => void;
  bytes: number;
  pause?: () => void;
  resume?: () => void;
  /** 控制 RPC 在途时禁止暂停 stdout，保证 response 仍能被读取。 */
  canPause?: () => boolean;
  onFailure?: (cause: unknown) => void;
};

type CodexStdoutDispatchWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
};

const DEFAULT_STDOUT_BATCH_MESSAGES = 100;
const DEFAULT_STDOUT_BATCH_BYTES = 1024 * 1024;
const STDOUT_BATCH_BUDGET_MS = 8;
const DEFAULT_STDOUT_HIGH_WATER_MESSAGES = 2_000;
const DEFAULT_STDOUT_HIGH_WATER_BYTES = 32 * 1024 * 1024;

class CodexStdoutThreadQueue {
  private values: Array<CodexStdoutDispatchTask | undefined> = [];
  private head = 0;
  queuedBytes = 0;
  paused = false;
  pause: (() => void) | null = null;
  resume: (() => void) | null = null;
  canPause: (() => boolean) | null = null;
  failure: { reason: unknown } | null = null;

  /** 返回该 thread 尚未分发的 stdout 消息数。 */
  get length(): number {
    return this.values.length - this.head;
  }

  /** 将一条 stdout 分发任务追加到 thread FIFO。 */
  push(task: CodexStdoutDispatchTask): void {
    this.values.push(task);
    this.queuedBytes += task.bytes;
    if (task.pause) this.pause = task.pause;
    if (task.resume) this.resume = task.resume;
    if (task.canPause) this.canPause = task.canPause;
  }

  /** 取出 thread FIFO 最早任务，并同步维护字节数。 */
  shift(): CodexStdoutDispatchTask | null {
    const task = this.values[this.head] ?? null;
    if (!task) return null;
    this.values[this.head] = undefined;
    this.head += 1;
    this.queuedBytes = Math.max(0, this.queuedBytes - task.bytes);
    if (this.head >= 1_024 && this.head * 2 >= this.values.length) {
      this.values = this.values.slice(this.head);
      this.head = 0;
    }
    return task;
  }

  /** 丢弃未分发项并复位背压计数。 */
  clear(): void {
    this.values = [];
    this.head = 0;
    this.queuedBytes = 0;
  }
}

/** 跨 app-server 进程按 CodeFlow thread 公平分发 stdout，保持各 thread 严格 FIFO。 */
class CodexStdoutDispatcher {
  private readonly queues = new Map<ThreadId, CodexStdoutThreadQueue>();
  private readonly activeThreadIds: ThreadId[] = [];
  private readonly waiters = new Map<ThreadId, Set<CodexStdoutDispatchWaiter>>();
  private cursor = 0;
  private immediate: NodeJS.Immediate | null = null;
  private draining = false;
  private readonly batchMessages: number;
  private readonly batchBytes: number;
  private readonly highWaterMessages: number;
  private readonly highWaterBytes: number;
  private readonly lowWaterMessages: number;
  private readonly lowWaterBytes: number;

  constructor(
    limits: {
      batchMessages?: number;
      batchBytes?: number;
      highWaterMessages?: number;
      highWaterBytes?: number;
    } | undefined,
    private readonly onFlowState: (
      threadId: ThreadId,
      state: "paused" | "resumed",
      queuedMessages: number,
      queuedBytes: number,
    ) => void,
  ) {
    this.batchMessages = resolvePositiveInteger(limits?.batchMessages, DEFAULT_STDOUT_BATCH_MESSAGES);
    this.batchBytes = resolvePositiveInteger(limits?.batchBytes, DEFAULT_STDOUT_BATCH_BYTES);
    this.highWaterMessages = resolvePositiveInteger(limits?.highWaterMessages, DEFAULT_STDOUT_HIGH_WATER_MESSAGES);
    this.highWaterBytes = resolvePositiveInteger(limits?.highWaterBytes, DEFAULT_STDOUT_HIGH_WATER_BYTES);
    this.lowWaterMessages = Math.max(1, Math.floor(this.highWaterMessages / 2));
    this.lowWaterBytes = Math.max(1, Math.floor(this.highWaterBytes / 2));
  }

  /** 快速接收 stdout 任务；达到高水位时只暂停该 thread 的独占子进程 stdout。 */
  enqueue(threadId: ThreadId, task: CodexStdoutDispatchTask): void {
    let queue = this.queues.get(threadId) ?? null;
    if (queue?.failure) throw queue.failure.reason;
    if (!queue) {
      queue = new CodexStdoutThreadQueue();
      this.queues.set(threadId, queue);
      this.activeThreadIds.push(threadId);
    }
    queue.push({ ...task, bytes: Math.max(0, Math.floor(task.bytes)) });
    if (
      !queue.paused
      && (queue.length >= this.highWaterMessages || queue.queuedBytes >= this.highWaterBytes)
      && queue.pause
      && (queue.canPause?.() ?? true)
    ) {
      queue.pause();
      queue.paused = true;
      this.onFlowState(threadId, "paused", queue.length, queue.queuedBytes);
    }
    this.schedule();
  }

  /** 控制 RPC 发出前恢复目标 thread 的 stdout，避免响应卡在已暂停的管道。 */
  resume(threadId: ThreadId): void {
    const queue = this.queues.get(threadId);
    if (!queue?.paused) return;
    queue.resume?.();
    queue.paused = false;
    this.onFlowState(threadId, "resumed", queue.length, queue.queuedBytes);
  }

  /** 等待指定 thread 已接收的 stdout 任务全部完成，供 session 释放前建立排空屏障。 */
  waitForIdle(threadId: ThreadId): Promise<void> {
    const failure = this.queues.get(threadId)?.failure;
    if (failure) return Promise.reject(failure.reason);
    if (!this.queues.has(threadId)) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const threadWaiters = this.waiters.get(threadId) ?? new Set<CodexStdoutDispatchWaiter>();
      threadWaiters.add({ resolve, reject });
      this.waiters.set(threadId, threadWaiters);
      this.schedule();
      this.immediate?.ref?.();
    });
  }

  /** 只有队列已排空或故障后封存，进程回收 owner 才可退役其已观察失败。 */
  retireStoppedThread(threadId: ThreadId): boolean {
    const queue = this.queues.get(threadId);
    if (!queue) return true;
    if (!queue.failure || queue.length !== 0 || this.activeThreadIds.includes(threadId)) return false;
    this.queues.delete(threadId);
    return true;
  }

  /** 按 thread 保序分发；达到耗时、条数或字节预算后让出，单条任务不可抢占。 */
  private drainBatch(): void {
    this.immediate = null;
    if (this.draining) return;
    this.draining = true;
    let dispatchedMessages = 0;
    let dispatchedBytes = 0;
    const startedAt = performance.now();
    try {
      while (
        this.activeThreadIds.length > 0
        && dispatchedMessages < this.batchMessages
        && (dispatchedMessages === 0 || dispatchedBytes < this.batchBytes)
        && (dispatchedMessages === 0 || performance.now() - startedAt < STDOUT_BATCH_BUDGET_MS)
      ) {
        if (this.cursor >= this.activeThreadIds.length) this.cursor = 0;
        const threadId = this.activeThreadIds[this.cursor]!;
        const queue = this.queues.get(threadId);
        if (!queue) {
          this.activeThreadIds.splice(this.cursor, 1);
          continue;
        }
        const task = queue.shift();
        if (!task) {
          this.finishThreadQueue(threadId, queue);
          continue;
        }
        dispatchedMessages += 1;
        dispatchedBytes += task.bytes;
        try {
          task.run();
          this.resumeIfBelowLowWater(threadId, queue);
          if (queue.length === 0) this.finishThreadQueue(threadId, queue);
          else this.cursor = (this.cursor + 1) % this.activeThreadIds.length;
        } catch (cause) {
          let failure: unknown = cause;
          try { task.onFailure?.(cause); }
          catch (secondary) { failure = new AggregateError([cause, secondary], "Codex stdout 分发与收口均失败", { cause }); }
          const error = failure instanceof Error ? failure : new Error("Codex stdout 分发失败", { cause: failure });
          // 仅熔断抛错的 thread 队列；不能让 setImmediate 异常扩大为 Client 进程未处理异常。
          this.failThreadQueue(threadId, queue, error);
          continue;
        }
      }
    } finally {
      this.draining = false;
      if (this.activeThreadIds.length > 0) this.schedule();
    }
  }

  /** 完成空队列并唤醒 thread 排空等待者。 */
  private finishThreadQueue(threadId: ThreadId, queue: CodexStdoutThreadQueue): void {
    this.resumeIfBelowLowWater(threadId, queue);
    this.queues.delete(threadId);
    const index = this.activeThreadIds.indexOf(threadId);
    if (index >= 0) {
      this.activeThreadIds.splice(index, 1);
      if (index < this.cursor) this.cursor -= 1;
      if (this.cursor >= this.activeThreadIds.length) this.cursor = 0;
    }
    const threadWaiters = this.waiters.get(threadId);
    if (!threadWaiters) return;
    this.waiters.delete(threadId);
    for (const waiter of threadWaiters) waiter.resolve();
  }

  /** 低水位后恢复该 thread 的 stdout，不影响其它 thread 或公共 Server WS。 */
  private resumeIfBelowLowWater(threadId: ThreadId, queue: CodexStdoutThreadQueue): void {
    if (!queue.paused || !queue.resume) return;
    if (queue.length > this.lowWaterMessages || queue.queuedBytes > this.lowWaterBytes) return;
    queue.resume();
    queue.paused = false;
    this.onFlowState(threadId, "resumed", queue.length, queue.queuedBytes);
  }

  /** 任务异常时拒绝该 thread 的排空屏障，禁止伪造已完成。 */
  private rejectThreadWaiters(threadId: ThreadId, error: Error): void {
    const threadWaiters = this.waiters.get(threadId);
    if (!threadWaiters) return;
    this.waiters.delete(threadId);
    for (const waiter of threadWaiters) waiter.reject(error);
  }

  /** 丢弃发生分发异常的 thread 剩余消息，并让原 drain/释放观察得到显式失败。 */
  private failThreadQueue(threadId: ThreadId, queue: CodexStdoutThreadQueue, error: Error): void {
    queue.clear();
    try { queue.resume?.(); }
    catch (cause) { error = new AggregateError([error, cause], "Codex stdout 分发和流恢复均失败", { cause: error }); }
    queue.paused = false;
    queue.failure = { reason: error };
    const index = this.activeThreadIds.indexOf(threadId);
    if (index >= 0) {
      this.activeThreadIds.splice(index, 1);
      if (index < this.cursor) this.cursor -= 1;
      if (this.cursor >= this.activeThreadIds.length) this.cursor = 0;
    }
    this.rejectThreadWaiters(threadId, error);
  }

  /** 在下一轮 check 阶段继续分发。 */
  private schedule(): void {
    if (this.immediate || this.draining || this.activeThreadIds.length === 0) return;
    this.immediate = setImmediate(() => this.drainBatch());
    if (this.waiters.size === 0) this.immediate.unref?.();
  }
}

/** 为单个 CodeFlow thread 绑定隔离的 app-server 进程。 */
export type CodexAppServerThreadManager = {
  getOrCreate: (workspaceId: WorkspaceId, workspacePath: string) => CodexAppServerWorkspace;
  getExisting: (workspaceId: WorkspaceId) => CodexAppServerWorkspace | null;
  /** 仅重启该 thread 的独占 app-server，成功后返回新 Workspace。 */
  restart?: (workspaceId: WorkspaceId, workspacePath: string) => Promise<CodexAppServerWorkspace>;
  drainMessages?: () => Promise<void>;
  resumeStdout?: () => void;
};

/** Codex app-server 管理器：每个 CodeFlow thread 独占一个进程。 */
export class CodexAppServerManager {
  private readonly byThreadId = new Map<ThreadId, CodexAppServerProcessRecord>();
  private readonly releasingByThreadId = new Map<ThreadId, Promise<void>>();
  private killAllInFlight: Promise<void> | null = null;
  private readonly stdoutDispatcher: CodexStdoutDispatcher;

  constructor(private readonly opts: {
    writeWorkspaceLog: EngineWorkspaceLogWriter;
    clientInfo: { name: string; title: string; version: string };
    /** 为每个 app-server 提供当前活动 Codex Key 的运行时配置。 */
    resolveCodexRuntimeConfig?: (threadId: ThreadId) => CodexRuntimeConfig | null | Promise<CodexRuntimeConfig | null>;
    stdoutDispatchLimits?: {
      batchMessages?: number;
      batchBytes?: number;
      highWaterMessages?: number;
      highWaterBytes?: number;
    };
  }) {
    this.stdoutDispatcher = new CodexStdoutDispatcher(opts.stdoutDispatchLimits, (
      threadId,
      state,
      queuedMessages,
      queuedBytes,
    ) => {
      const record = this.byThreadId.get(threadId);
      if (!record) throw new Error(`Missing Codex stdout workspace owner: threadId=${threadId}`);
      writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, record.workspaceId, () => ({ level: state === "paused" ? "warn" : "info",
        tag: "codex-app-server", message: `stdout ${state}`, data: { threadId, queuedMessages, queuedBytes, scope: "thread_app_server_stdout" } }));
    });
  }

  /** 返回绑定到指定 thread 的进程句柄；句柄本身不会启动进程。 */
  forThread(threadId: ThreadId): CodexAppServerThreadManager {
    const normalizedThreadId = String(threadId ?? "").trim() as ThreadId;
    if (!normalizedThreadId) throw new Error("Invalid Codex app-server threadId");
    return {
      getOrCreate: (workspaceId, workspacePath) => this.getOrCreateForThread(
        normalizedThreadId,
        workspaceId,
        workspacePath,
      ),
      getExisting: (workspaceId) => this.getExistingForThread(normalizedThreadId, workspaceId),
      restart: (workspaceId, workspacePath) => this.restartForThread(
        normalizedThreadId,
        workspaceId,
        workspacePath,
      ),
      drainMessages: () => this.stdoutDispatcher.waitForIdle(normalizedThreadId),
      resumeStdout: () => this.stdoutDispatcher.resume(normalizedThreadId),
    };
  }

  /** 释放指定 thread 的隔离进程；并发调用复用，成功后才删除记录。 */
  releaseThread(threadId: ThreadId): Promise<void> {
    const inFlight = this.releasingByThreadId.get(threadId);
    if (inFlight) return inFlight;
    const record = this.byThreadId.get(threadId) ?? null;
    if (!record) return Promise.resolve();

    let resolveOperation!: () => void;
    let rejectOperation!: (error: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    // 先发布 Manager 门禁，避免 workspace.kill() 的同步故障回调重入释放或复用旧记录。
    this.releasingByThreadId.set(threadId, operation);
    void operation.then(
      () => this.clearReleasingThread(threadId, operation),
      () => this.clearReleasingThread(threadId, operation),
    );
    let termination: Promise<void>;
    try {
      // kill() 会同步建立 Workspace 终止门禁，再异步等待进程树退出。
      termination = record.workspace.kill();
    } catch (cause) {
      rejectOperation(cause);
      return operation;
    }
    void Promise.allSettled([termination, this.stdoutDispatcher.waitForIdle(threadId)]).then(
      results => {
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) {
          if (record.workspace.isReleaseComplete() && this.stdoutDispatcher.retireStoppedThread(threadId)
            && this.byThreadId.get(threadId) === record) this.byThreadId.delete(threadId);
          rejectOperation(failures.length === 1 ? failures[0] : new AggregateError(failures, "Codex 进程和stdout排空失败", { cause: failures[0] }));
          return;
        }
        if (this.byThreadId.get(threadId) === record) this.byThreadId.delete(threadId);
        resolveOperation();
      },
      rejectOperation,
    );
    return operation;
  }

  /** 终止并重建单个 thread 的独占 app-server；失败时不伪造新 Workspace。 */
  private async restartForThread(
    threadId: ThreadId,
    workspaceId: WorkspaceId,
    workspacePath: string,
  ): Promise<CodexAppServerWorkspace> {
    const previous = this.byThreadId.get(threadId)?.workspace ?? null;
    await this.releaseThread(threadId);
    const replacement = this.getOrCreateForThread(threadId, workspaceId, workspacePath);
    previous?.transferThreadHandlersTo(replacement);
    return replacement;
  }

  /** 获取或创建 thread 隔离进程（惰性启动：首次 request/notify 时启动）。 */
  private getOrCreateForThread(
    threadId: ThreadId,
    workspaceId: WorkspaceId,
    workspacePath: string,
  ): CodexAppServerWorkspace {
    const normalizedPath = String(workspacePath ?? "").trim();
    if (!normalizedPath) throw new Error(`Invalid Codex app-server workspacePath: threadId=${threadId}`);
    if (this.killAllInFlight) {
      throw new Error("Codex app-server workspaces are being released");
    }
    if (this.releasingByThreadId.has(threadId)) {
      throw new Error(`Codex app-server thread is being released: threadId=${threadId}`);
    }
    const existing = this.byThreadId.get(threadId) ?? null;
    if (existing) {
      this.assertProcessScope(existing, threadId, workspaceId, normalizedPath);
      // kill 的调用结果可先失败、进程树随后才确认退出；这时旧记录仍在，但对象已永久封存。
      // 只有回收完成后才允许替换，不能丢弃仍在终止或终止失败的进程记录。
      if (!existing.workspace.isReleaseComplete()) return existing.workspace;
    }
    const workspace = new CodexAppServerWorkspace({
      writeWorkspaceLog: this.opts.writeWorkspaceLog,
      localThreadId: threadId,
      workspaceId,
      workspacePath: normalizedPath,
      clientInfo: this.opts.clientInfo,
      resolveCodexRuntimeConfig: this.opts.resolveCodexRuntimeConfig ? () => this.opts.resolveCodexRuntimeConfig!(threadId) : undefined,
      onStderrLine: (line) => {
        const s = String(line ?? "").trim();
        if (!s) return;
        writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, workspaceId, () => ({ level: "warn", tag: "codex-app-server", message: "stderr", data: {
          workspaceId,
          threadId,
          rootCause: engineDiagnosticCause(s), lineLength: s.length,
        } }));
      },
      onRequestTimeout: (timeout) => {
        writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, workspaceId, () => ({ level: "warn", tag: "codex-app-server", message: "request timeout", data: {
          workspaceId,
          threadId,
          requestId: timeout.requestId,
          method: timeout.method,
          elapsedMs: timeout.elapsedMs,
          timeoutMs: timeout.timeoutMs,
          processGeneration: timeout.processGeneration,
          pendingMethods: timeout.pendingMethods,
        } }));
      },
      onProcessFault: (fault) => {
        writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, workspaceId, () => ({ level: "error", tag: "codex-app-server", message: "process fault", data: {
          workspaceId,
          threadId,
          code: fault.code,
          requestId: fault.requestId ?? null,
          method: fault.method ?? null,
          rootCause: engineDiagnosticCause(fault.message),
        } }));
      },
      scheduleThreadMessage: (task) => this.stdoutDispatcher.enqueue(threadId, task),
      resumeStdout: () => this.stdoutDispatcher.resume(threadId),
    });
    existing?.workspace.transferThreadHandlersTo(workspace);
    this.byThreadId.set(threadId, { workspaceId, workspacePath: normalizedPath, workspace });
    if (existing) {
      writeEngineWorkspaceLog(this.opts.writeWorkspaceLog, workspaceId, () => ({ level: "info", tag: "codex-app-server", message: "released workspace replaced", data: {
        code: "codex_app_server_released_workspace_replaced",
        requestId: null,
        workspaceId,
        threadId,
        previousProcessGeneration: existing.workspace.getProcessSnapshot().generation,
        reason: "release completed after retained process record",
      } }));
    }
    return workspace;
  }

  /** 读取 thread 的既有隔离进程；不会触发 app-server 启动。 */
  private getExistingForThread(threadId: ThreadId, workspaceId: WorkspaceId): CodexAppServerWorkspace | null {
    if (this.killAllInFlight || this.releasingByThreadId.has(threadId)) return null;
    const existing = this.byThreadId.get(threadId) ?? null;
    if (!existing) return null;
    if (existing.workspaceId !== workspaceId) {
      throw new Error(
        `Codex app-server thread workspace mismatch: threadId=${threadId}, expected=${existing.workspaceId}, actual=${workspaceId}`,
      );
    }
    if (existing.workspace.isReleaseComplete()) return null;
    return existing.workspace;
  }

  /** 终止所有 thread 隔离进程；并发调用复用，期间禁止创建漏出快照的新进程。 */
  killAllWorkspaces(): Promise<void> {
    if (this.killAllInFlight) return this.killAllInFlight;
    let operation!: Promise<void>;
    operation = Promise.resolve()
      .then(() => this.killAllWorkspacesOnce())
      .finally(() => {
        if (this.killAllInFlight === operation) this.killAllInFlight = null;
      });
    this.killAllInFlight = operation;
    return operation;
  }

  /** 在全量门禁内依次释放快照中的进程，并汇总所有失败。 */
  private async killAllWorkspacesOnce(): Promise<void> {
    const failures: Error[] = [];
    for (const threadId of [...this.byThreadId.keys()]) {
      try {
        await this.releaseThread(threadId);
      } catch (cause) {
        failures.push(new Error(`Codex app-server 进程终止失败：threadId=${threadId}`, { cause }));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Codex app-server 进程终止失败（${failures.length} 个）`);
    }
  }

  /** 仅清理由当前释放操作持有的 thread 门禁。 */
  private clearReleasingThread(threadId: ThreadId, operation: Promise<void>): void {
    if (this.releasingByThreadId.get(threadId) === operation) {
      this.releasingByThreadId.delete(threadId);
    }
  }

  /** 校验复用进程仍属于同一 workspace 与路径。 */
  private assertProcessScope(
    record: CodexAppServerProcessRecord,
    threadId: ThreadId,
    workspaceId: WorkspaceId,
    workspacePath: string,
  ): void {
    if (record.workspaceId === workspaceId && record.workspacePath === workspacePath) return;
    throw new Error(
      `Codex app-server thread scope mismatch: threadId=${threadId}, `
      + `expected=${record.workspaceId}@${record.workspacePath}, actual=${workspaceId}@${workspacePath}`,
    );
  }
}

/** 解析正整数限制；非法值回退到显式默认值。 */
function resolvePositiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


