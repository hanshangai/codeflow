import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "./clientDb.js";
import type { ClientDbReaderService } from "./clientDbReaderService.js";
import type { WorkspaceOperationGate, WorkspaceWriteLease } from "../workspace-migration/workspaceOperationGate.js";
import { logger } from "../logger.js";
import { scopeLocalEventWriterEpoch } from "../runtime/localEventPersistence.js";
import { CLIENT_DB_WRITER_PROTOCOL_VERSION, type ClientDbReadCoordinator, type ClientDbWriterCommand,
  type ClientDbWriterMessage, type LocalEventBatch, type LocalEventCommitReceipt } from "./clientDbWriterProtocol.js";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void };
type Job = { lane: string; workspaceId?: WorkspaceId; batchId?: string; run: () => Promise<unknown>; resolve: (value: any) => void; reject: (cause: unknown) => void };
type BatchState = { batch: LocalEventBatch; bytes: number; committed: Promise<LocalEventCommitReceipt>;
  indexed: Deferred<void>; receipt?: LocalEventCommitReceipt; release: (() => void) & Partial<Pick<WorkspaceWriteLease, "run">>; counted: boolean };
type WriterResult = Extract<ClientDbWriterMessage, { type: "result" | "closed" }>;
type TurnScope = { workspaceId: WorkspaceId; threadId: string; turnId?: string | null; ownerGeneration: number };

export type ClientDbWriterServiceOptions = {
  dbPath: string;
  clientId?: string;
  db: ClientDb;
  reader?: ClientDbReaderService;
  workspaceOperationGate?: WorkspaceOperationGate;
  workerPath?: string;
  maxPendingEvents?: number;
  maxPendingBytes?: number;
  maxBatchEvents?: number;
  maxBatchBytes?: number;
  maxWorkspaceConnections?: number;
  workspaceIdleMs?: number;
  timeoutMs?: number;
  lockTimeoutMs?: number;
  onFatalError: (error: Error) => void;
};

/** 单 Client 协调写入、Reader 与短同步许可；有界批次按回合轮转。 */
export class ClientDbWriterService {
  private readonly writerEpoch = crypto.randomUUID();
  private readonly batchOrdinals = new Map<WorkspaceId, number>();
  private readonly worker: Worker;
  private readonly readyState = deferred<Error | null>();
  private readonly exited = deferred<number>();
  private readonly pending = new Map<string, Deferred<WriterResult>>();
  private readonly jobs = new Map<string, Job[]>();
  private readonly batches = new Map<string, BatchState>();
  private readonly workspacePending = new Map<WorkspaceId, string>();
  private readonly workspaceFailures = new Map<WorkspaceId, unknown>();
  private readonly idleWaiters = new Set<() => void>();
  private active: Job | null = null;
  private scheduled: ReturnType<typeof setImmediate> | null = null;
  private pendingEvents = 0;
  private pendingBytes = 0;
  private permitDepth = 0;
  private closing = false;
  private closed = false;
  private terminating = false;
  private fatal: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly timeoutMs: number;
  private readonly lockTimeoutMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxPendingBytes: number;
  private readonly maxBatchEvents: number;
  private readonly maxBatchBytes: number;
  private readonly readyTimer: ReturnType<typeof setTimeout>;
  private readonly unregisterDrain: (() => void) | undefined;

  /** 主线程连接在 Worker 创建前启用许可断言，未准入路径立即显式失败。 */
  constructor(private readonly options: ClientDbWriterServiceOptions) {
    if (typeof options.onFatalError !== "function") throw new Error("CLIENT_DB_WRITER_FATAL_HANDLER_REQUIRED");
    this.timeoutMs = positive(options.timeoutMs ?? 30_000);
    this.lockTimeoutMs = positive(options.lockTimeoutMs ?? 3_000);
    this.maxPendingEvents = positive(options.maxPendingEvents ?? 8192);
    this.maxPendingBytes = positive(options.maxPendingBytes ?? 128 * 1024 * 1024);
    this.maxBatchEvents = positive(options.maxBatchEvents ?? 64);
    this.maxBatchBytes = positive(options.maxBatchBytes ?? 256 * 1024);
    options.db.configureLegacyAccessGuard(() => { if (!this.permitDepth) throw new Error("CLIENT_DB_LEGACY_ACCESS_REQUIRED"); });
    try {
      options.reader?.setDatabaseCoordinator(this.createReaderCoordinator());
      this.unregisterDrain = options.workspaceOperationGate?.registerDrainOwner("client-db-writer", workspaceId => this.drainWorkspace(workspaceId));
      this.worker = createWorker(options.workerPath, { dbPath: options.dbPath, writerEpoch: this.writerEpoch, clientId: options.clientId,
        maxWorkspaceConnections: positive(options.maxWorkspaceConnections ?? 8), workspaceIdleMs: positive(options.workspaceIdleMs ?? 30_000) });
    } catch (cause) { options.db.configureLegacyAccessGuard(null); this.unregisterDrain?.(); options.reader?.setDatabaseCoordinator(null); throw cause; }
    this.worker.on("message", (message: ClientDbWriterMessage) => this.onMessage(message));
    this.worker.on("error", cause => this.fail(new Error("CLIENT_DB_WRITER_WORKER_FAILED", { cause })));
    this.worker.on("messageerror", cause => this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID", { cause })));
    this.worker.on("exit", code => {
      this.exited.resolve(code);
      if (!this.closed && !this.terminating) this.fail(new Error("CLIENT_DB_WRITER_UNEXPECTED_EXIT"));
    });
    this.readyTimer = setTimeout(() => this.fail(new Error("CLIENT_DB_WRITER_READY_TIMEOUT")), this.timeoutMs);
  }

  /** 等待唯一 Worker 初始化；失败禁止同步回落。 */
  async ready(): Promise<void> {
    const error = await this.readyState.promise;
    if (error) throw error;
    if (this.fatal) throw this.fatal;
  }

  /** 身份在事件准入时固定；按W编号只用于安全回收回执，不分配事件seq。 */
  createBatchIdentity(workspaceId: WorkspaceId): Pick<LocalEventBatch, "batchId" | "writerEpoch" | "batchOrdinal"> {
    this.assertOpen();
    const batchOrdinal = (this.batchOrdinals.get(workspaceId) ?? 0) + 1;
    if (!Number.isSafeInteger(batchOrdinal)) throw new Error("LOCAL_EVENT_BATCH_ORDINAL_EXHAUSTED");
    this.batchOrdinals.set(workspaceId, batchOrdinal);
    const writerEpoch = scopeLocalEventWriterEpoch(this.writerEpoch, workspaceId);
    return { batchId: `${writerEpoch}:${batchOrdinal}`, writerEpoch, batchOrdinal };
  }

  /** 发布与必需索引完成后由原pipeline确认，丢失确认不会删除未确认回执。 */
  async confirmBatch(workspaceId: WorkspaceId, batchId: string): Promise<void> {
    await this.enqueue("control:confirmed", async () => {
      await this.request({ type: "confirmed", commandId: crypto.randomUUID(), workspaceId, batchId });
    });
  }

  /** 接收固定批次；容量或边界不符时零准入，提交 ACK 不代表索引已完成。 */
  submit(batch: LocalEventBatch): Promise<LocalEventCommitReceipt> {
    try {
      this.assertOpen();
      const bytes = Buffer.byteLength(JSON.stringify(batch), "utf8");
      if (!batch.batchId || !batch.events.length || batch.events.some(event => event.event.workspaceId !== batch.workspaceId)) throw new Error("CLIENT_DB_WRITER_BATCH_INVALID");
      const existing = this.batches.get(batch.batchId);
      if (existing) {
        if (JSON.stringify(existing.batch) !== JSON.stringify(batch)) throw new Error("LOCAL_EVENT_BATCH_CONFLICT");
        return existing.committed;
      }
      if (this.pendingEvents + batch.events.length > this.maxPendingEvents || this.pendingBytes + bytes > this.maxPendingBytes) throw new Error("CLIENT_DB_WRITER_CAPACITY_EXCEEDED");
      if (batch.events.length > this.maxBatchEvents || batch.events.length > 1 && bytes > this.maxBatchBytes) throw new Error("CLIENT_DB_WRITER_BATCH_TOO_LARGE");
      const scope = batch.events[0]!.event;
      const turnIds = new Set(batch.events.map(message => eventTurnId(message.event)).filter(value => value !== null));
      if (batch.turnId != null) turnIds.add(batch.turnId);
      if (turnIds.size > 1 || batch.events.some(message => message.event.threadId !== scope.threadId)) throw new Error("CLIENT_DB_WRITER_BATCH_SCOPE_INVALID");
      const release = this.options.workspaceOperationGate?.beginWrite(batch.workspaceId) ?? (() => undefined);
      const indexed = deferred<void>();
      // 索引错误由 flushTurn/读屏障显式消费，不因消费者尚未安装产生全局 rejection。
      void indexed.promise.then(undefined, () => undefined);
      const frozen = structuredClone(batch);
      this.pendingBytes += bytes; this.pendingEvents += batch.events.length;
      const state: BatchState = { batch: frozen, bytes, indexed, release, counted: true, committed: Promise.resolve(null as never) };
      state.committed = this.enqueue(`turn:${JSON.stringify([batch.workspaceId, batch.ownerGeneration, scope.threadId, [...turnIds][0] ?? null])}`, async () => {
        const failed = this.workspaceFailures.get(batch.workspaceId);
        if (failed) throw failed;
        const response = await this.request({ type: "commit", commandId: crypto.randomUUID(), batch: frozen });
        if (response.type !== "result" || !response.receipt || response.receipt.batchId !== batch.batchId) throw new Error("CLIENT_DB_WRITER_RECEIPT_INVALID");
        state.receipt = response.receipt;
        if (response.receipt.indexedCount === response.receipt.messages.length) this.finishIndexes(state);
        else this.workspacePending.set(batch.workspaceId, batch.batchId);
        return response.receipt;
      }, batch.workspaceId, batch.batchId).then(value => value as LocalEventCommitReceipt, cause => {
        this.workspaceFailures.set(batch.workspaceId, cause); indexed.reject(cause); release();
        this.releaseBudget(state); this.batches.delete(batch.batchId); throw cause;
      });
      this.batches.set(batch.batchId, state);
      return state.committed;
    } catch (cause) { return Promise.reject(cause); }
  }

  /** 仅由真实索引 owner 调用；持久确认完整批次后才开放后继提交及读屏障。 */
  async indexDatabase(workspaceId: WorkspaceId, batchId: string): Promise<{ localThreadIds?: import("@codeflowai/shared").ThreadId[] }> {
    return await this.enqueue("control:database-index", async () => {
      const response = await this.request({ type: "indexDatabase", commandId: crypto.randomUUID(), workspaceId, batchId });
      if (response.type !== "result") throw new Error("CLIENT_DB_WRITER_RECEIPT_INVALID");
      return response.localThreadIds ? { localThreadIds: response.localThreadIds } : {};
    });
  }

  /** 必需副作用owner收口后推进可见水位，数据库阶段不代替文件及运行态收尾。 */
  completeIndexes(workspaceId: WorkspaceId, batchId: string, indexedCount: number): Promise<number> {
    return this.enqueue("control:index", async () => {
      const state = this.batches.get(batchId);
      if (state && (state.batch.workspaceId !== workspaceId || !state.receipt)) throw new Error("CLIENT_DB_WRITER_INDEX_OWNER_INVALID");
      const response = await this.request({ type: "indexed", commandId: crypto.randomUUID(), workspaceId, batchId, indexedCount });
      if (response.type !== "result" || typeof response.readyThroughSeq !== "number") throw new Error("CLIENT_DB_WRITER_RECEIPT_INVALID");
      if (state?.receipt) {
        state.receipt.indexedCount = indexedCount; state.receipt.indexedThroughSeq = response.readyThroughSeq;
        if (indexedCount === state.receipt.messages.length) this.finishIndexes(state);
      }
      return response.readyThroughSeq;
    });
  }

  /** 索引失败冻结所属 W，正文不撤销，其他工作区继续轮转。 */
  failIndexes(workspaceId: WorkspaceId, batchId: string, cause: unknown): void {
    const state = this.batches.get(batchId);
    if (!state || state.batch.workspaceId !== workspaceId) throw new Error("CLIENT_DB_WRITER_INDEX_OWNER_INVALID");
    this.workspaceFailures.set(workspaceId, cause);
    state.indexed.reject(cause);
    this.schedule();
  }

  /** 等待调用时已准入的本回合正文和真实索引，不推导引擎运行终态。 */
  async flushTurn(scope: TurnScope): Promise<void> {
    const selected = [...this.batches.values()].filter(({ batch }) => batch.workspaceId === scope.workspaceId
      && batch.ownerGeneration === scope.ownerGeneration && batch.events[0]?.event.threadId === scope.threadId
      && (scope.turnId === undefined || (batch.turnId ?? eventTurnId(batch.events[0]!.event)) === scope.turnId));
    await Promise.all(selected.map(async state => { await state.committed; await state.indexed.promise; }));
  }

  /** 冻结调用时已准入集合并等待索引，随后在串行读屏障读取真实可见水位。 */
  async readReadyThroughSeq(workspaceId: WorkspaceId): Promise<number> {
    const selected = [...this.batches.values()].filter(state => state.batch.workspaceId === workspaceId);
    await Promise.all(selected.map(async state => { await state.committed; await state.indexed.promise; }));
    return this.enqueue("reader:ready", async () => {
      const response = await this.request({ type: "readySeq", commandId: crypto.randomUUID(), workspaceId });
      if (response.type !== "result" || typeof response.readyThroughSeq !== "number") throw new Error("CLIENT_DB_WRITER_RECEIPT_INVALID");
      return response.readyThroughSeq;
    }, workspaceId);
  }

  /** 只在所有 Worker 操作之间授予短同步 A/W 许可，thenable 一律拒绝。 */
  withLegacyDatabase<T>(requestId: string, operation: () => T): Promise<T> {
    return this.enqueue("legacy", async () => {
      if (!requestId) throw new Error("CLIENT_DB_LEGACY_REQUEST_ID_REQUIRED");
      return this.synchronous(operation);
    });
  }

  /** 重试前复核生命周期与预算；原批次凭据允许在迁移预留后完成同步副作用。 */
  withExclusiveWorkspaceDatabase<T>(requestId: string, workspaceId: WorkspaceId, operation: () => T, batchId?: string): Promise<T> {
    return this.enqueue("legacy:exclusive", async () => {
      if (!requestId) throw new Error("CLIENT_DB_LEGACY_REQUEST_ID_REQUIRED");
      const deadline = Date.now() + this.lockTimeoutMs;
      let waitingReported = false;
      let lastLock: { cause: unknown; errcode: number } | null = null;
      while (true) {
        if (this.fatal) throw this.fatal;
        if (this.closed || this.terminating) throw new Error("CLIENT_DB_WRITER_CLOSED");
        if (lastLock && Date.now() >= deadline) throw Object.assign(new Error("等待工作区数据库锁超时", { cause: lastLock.cause }), {
          code: "CLIENT_DB_LOCK_TIMEOUT", requestId, workspaceId, phase: "exclusive-acquire", sqliteCode: lastLock.errcode,
        });
        const batch = batchId ? this.batches.get(batchId) : undefined;
        if (batchId && (!batch?.receipt || batch.batch.workspaceId !== workspaceId)) throw new Error("CLIENT_DB_WRITER_INDEX_OWNER_INVALID");
        let entered = false;
        try {
          const execute = () => this.synchronous(() => {
            const scoped = this.options.db.forWorkspace(workspaceId);
            return scoped.withWorkspaceCoreRepos(workspaceId, () => scoped.db.transaction(() => {
              entered = true;
              return this.synchronous(operation) as T & (T extends PromiseLike<unknown> ? never : unknown);
            }, { mode: "exclusive", requireOutermost: true })());
          }) as T;
          return batch?.release.run ? batch.release.run(execute) : execute();
        } catch (error) {
          const lock = !entered ? sqliteLockBeforeCallback(error) : null;
          if (!lock) throw error;
          lastLock = { cause: error, errcode: lock.errcode };
          if (!waitingReported) {
            waitingReported = true;
            try {
              logger.warn("event-writer", "waiting for workspace lock before effects", {
                errorCode: "CLIENT_DB_LOCK_WAIT", requestId, workspaceId, phase: "exclusive-acquire",
                rootCause: { code: "ERR_SQLITE_ERROR", errcode: lock.errcode }, timeoutMs: this.lockTimeoutMs,
              });
            } catch (diagnosticError) {
              throw new AggregateError([error, diagnosticError], "CLIENT_DB_LOCK_DIAGNOSTIC_FAILED", { cause: error });
            }
          }
          const remaining = deadline - Date.now();
          if (remaining > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(25, remaining)));
        }
      }
    });
  }

  /** Reader 与写 Worker 共用全局队列，主线程准备及诊断仅持同步许可。 */
  createReaderCoordinator(): ClientDbReadCoordinator {
    return {
      run: (requestId, workspaceId, operation) => this.enqueue("reader", async () => {
        if (!requestId) throw new Error("CLIENT_DB_READER_REQUEST_ID_REQUIRED");
        const failed = this.workspaceFailures.get(workspaceId);
        if (failed) throw failed;
        await this.request({ type: "readySeq", commandId: crypto.randomUUID(), workspaceId });
        return await operation();
      }, workspaceId),
      synchronous: operation => {
        if (this.active?.lane !== "reader") throw new Error("CLIENT_DB_READER_ACCESS_REQUIRED");
        return this.synchronous(operation);
      },
    };
  }

  /** 等已接收索引完成后关闭真实 W 连接，迁移 owner 继续持外层准入门禁。 */
  async drainWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const selected = [...this.batches.values()].filter(state => state.batch.workspaceId === workspaceId);
    await Promise.all(selected.map(async state => { await state.committed; await state.indexed.promise; }));
    await this.enqueue("control:drain", () => this.request({ type: "drainWorkspace", commandId: crypto.randomUUID(), workspaceId }));
  }

  /** 拒绝新准入并收口原 Worker；正文未索引时关闭必须报告未完成。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.runClose();
    return this.closePromise;
  }

  /** 只在完整索引 ACK 后释放门禁和回合等待。 */
  private finishIndexes(state: BatchState): void {
    if (this.workspacePending.get(state.batch.workspaceId) === state.batch.batchId) this.workspacePending.delete(state.batch.workspaceId);
    this.workspaceFailures.delete(state.batch.workspaceId);
    state.indexed.resolve(); state.release(); this.releaseBudget(state); this.batches.delete(state.batch.batchId); this.schedule();
  }

  /** 队列及未索引回执共用同一容量预算，每批仅释放一次。 */
  private releaseBudget(state: BatchState): void {
    if (!state.counted) return;
    state.counted = false;
    this.pendingEvents -= state.batch.events.length; this.pendingBytes -= state.bytes;
  }

  /** 同步许可不可跨异步边界，即便旧函数返回 Promise 也立即撤销。 */
  private synchronous<T>(operation: () => T): T {
    this.permitDepth++;
    try {
      const value = operation();
      if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") throw new Error("CLIENT_DB_LEGACY_CALLBACK_MUST_BE_SYNCHRONOUS");
      return value;
    } finally { this.permitDepth--; }
  }

  /** 队列只保存预算内的批次；回合队列每次移到尾部以避免持续输出独占。 */
  private enqueue<T>(lane: string, run: () => Promise<T>, workspaceId?: WorkspaceId, batchId?: string): Promise<T> {
    if (this.fatal || this.closed) return Promise.reject(this.fatal ?? new Error("CLIENT_DB_WRITER_CLOSED"));
    return new Promise<T>((resolve, reject) => {
      const queue = this.jobs.get(lane) ?? [];
      queue.push({ lane, run, resolve, reject, workspaceId, batchId }); this.jobs.set(lane, queue); this.schedule();
    });
  }

  /** 将下一批派发留到事件循环，取消和控制消息可以先进入。 */
  private schedule(): void {
    if (this.active || this.scheduled || this.fatal || this.closed) return;
    if (!this.jobs.size) { for (const done of this.idleWaiters) done(); this.idleWaiters.clear(); return; }
    this.scheduled = setImmediate(() => { this.scheduled = null; void this.runNext(); });
  }

  /** 一个真实数据库操作完成后再准入下一个，失败只拒绝所属 job。 */
  private async runNext(): Promise<void> {
    for (const [lane, queue] of this.jobs) {
      const job = queue[0]!;
      const blocking = job.workspaceId && this.workspacePending.get(job.workspaceId);
      if (blocking && blocking !== job.batchId && !this.workspaceFailures.has(job.workspaceId!)) continue;
      queue.shift(); this.jobs.delete(lane); if (queue.length) this.jobs.set(lane, queue);
      this.active = job;
      try { await this.ready(); job.resolve(await job.run()); }
      catch (cause) { job.reject(cause); }
      finally { this.active = null; this.schedule(); }
      return;
    }
  }

  /** 关联每个 IPC 回执，超时保留失败而不重新编号或同步写入。 */
  private request(command: ClientDbWriterCommand): Promise<WriterResult> {
    if (this.fatal) return Promise.reject(this.fatal);
    const pending = deferred<WriterResult>();
    const timer = setTimeout(() => this.fail(new Error("CLIENT_DB_WRITER_ACK_TIMEOUT")), this.timeoutMs);
    this.pending.set(command.commandId, pending);
    try { this.worker.postMessage(command); }
    catch (cause) { this.fail(new Error("CLIENT_DB_WRITER_SEND_FAILED", { cause })); }
    return pending.promise.finally(() => { clearTimeout(timer); this.pending.delete(command.commandId); });
  }

  /** 只接受当前命令回执；未知或畸形消息使服务显式失败。 */
  private onMessage(message: ClientDbWriterMessage): void {
    if (!message || typeof message !== "object") { this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID")); return; }
    if (message.type === "ready") {
      if (message.protocolVersion !== CLIENT_DB_WRITER_PROTOCOL_VERSION) { this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID")); return; }
      clearTimeout(this.readyTimer); this.readyState.resolve(null); return;
    }
    if (message.type === "fatal") {
      if (!message.error || typeof message.error.code !== "string" || typeof message.error.message !== "string") { this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID")); return; }
      this.fail(Object.assign(new Error(message.error.message), message.error)); return;
    }
    const pending = this.pending.get(message.commandId);
    if (!pending) { this.fail(new Error("CLIENT_DB_WRITER_RESPONSE_MISMATCH")); return; }
    if (message.type === "failed") {
      if (!message.error || typeof message.error.code !== "string" || typeof message.error.message !== "string") { this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID")); return; }
      pending.reject(Object.assign(new Error(message.error.message), message.error));
    }
    else if (message.type === "closed") { this.closed = true; pending.resolve(message); }
    else if (message.type === "result") pending.resolve(message);
    else this.fail(new Error("CLIENT_DB_WRITER_PROTOCOL_INVALID"));
  }

  /** 首次线程故障拒绝所有等待，并保留根因供关闭/原 owner 消费。 */
  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error; clearTimeout(this.readyTimer); this.readyState.resolve(error);
    for (const pending of this.pending.values()) pending.reject(error);
    for (const queue of this.jobs.values()) for (const job of queue) job.reject(error);
    this.jobs.clear();
    for (const done of this.idleWaiters) done(); this.idleWaiters.clear();
    for (const state of this.batches.values()) state.indexed.reject(error);
    try { this.options.onFatalError(error); }
    catch (cause) { this.fatal = new AggregateError([error, cause], "CLIENT_DB_WRITER_FATAL_HANDLER_FAILED", { cause: error }); }
  }

  /** 保持门禁直至线程真实退出；退出后才解除主线程断言。 */
  private async runClose(): Promise<void> {
    let failure: unknown = this.fatal;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.ready();
      await Promise.race([
        (async () => {
          await Promise.all([...this.batches.values()].map(async state => { await state.committed; await state.indexed.promise; }));
          if (this.active || this.jobs.size) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
          if (this.fatal) throw this.fatal;
        })(),
        new Promise<never>((_resolve, reject) => { drainTimer = setTimeout(() => reject(new Error("CLIENT_DB_WRITER_DRAIN_TIMEOUT")), this.timeoutMs); }),
      ]);
      clearTimeout(drainTimer);
      await this.enqueue("control:close", async () => {
        if (this.batches.size) failure = new Error("CLIENT_DB_WRITER_INDEX_INCOMPLETE");
        const result = await this.request({ type: "close", commandId: crypto.randomUUID() });
        return result;
      });
      const code = await this.exited.promise;
      if (code !== 0) throw new Error("CLIENT_DB_WRITER_CLOSE_FAILED");
    } catch (cause) {
      failure = cause;
      // 仅本关闭 owner 已明确接管的 terminate 不再追加“意外退出”；原失败继续向上抛。
      this.terminating = true;
      try { await this.worker.terminate(); }
      catch (termination) { failure = new AggregateError([cause, termination], "CLIENT_DB_WRITER_CLOSE_FAILED", { cause }); }
    } finally {
      clearTimeout(drainTimer);
      this.closed = true;
      if (this.scheduled) clearImmediate(this.scheduled);
      for (const queue of this.jobs.values()) for (const job of queue) job.reject(failure ?? new Error("CLIENT_DB_WRITER_CLOSED"));
      this.jobs.clear();
      for (const state of this.batches.values()) { state.indexed.reject(failure ?? new Error("CLIENT_DB_WRITER_CLOSED")); state.release(); this.releaseBudget(state); }
      this.options.db.configureLegacyAccessGuard(null);
      this.options.reader?.setDatabaseCoordinator(null);
      this.unregisterDrain?.();
    }
    if (failure) throw failure;
  }

  /** 关闭/失败之后所有新事件立即拒绝。 */
  private assertOpen(): void {
    if (this.fatal) throw this.fatal;
    if (this.closing || this.closed) throw new Error("CLIENT_DB_WRITER_CLOSED");
  }
}

/** 延迟对象不隐式消费业务失败，由原调用方持有其 Promise。 */
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"], reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** 上限与超时必须是正安全整数。 */
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("CLIENT_DB_WRITER_CONFIG_INVALID");
  return value;
}

/** 仅解包原工作区存储边界；清理/回滚聚合失败不能被当成普通锁竞争重试。 */
function sqliteLockBeforeCallback(error: unknown): { errcode: number } | null {
  const failure = error as { code?: unknown; errcode?: unknown; cause?: unknown } | null;
  if (failure?.code === "WORKSPACE_EXECUTION_PROFILE_STORAGE_FAILED") return sqliteLockBeforeCallback(failure.cause);
  return failure?.code === "ERR_SQLITE_ERROR" && typeof failure.errcode === "number"
    && [5, 6].includes(failure.errcode & 255) ? { errcode: failure.errcode } : null;
}

/** canonical 的 turnId 属于 payload，raw 则保留 envelope 字段。 */
function eventTurnId(event: LocalEventBatch["events"][number]["event"]): string | null {
  const raw = event as { clientTurnId?: unknown; payload?: { turnId?: unknown } };
  const value = raw.clientTurnId ?? raw.payload?.turnId;
  return typeof value === "string" ? value : null;
}

/** 发布入口同目录解析，开发入口使用既有 tsx Worker bootstrap。 */
function createWorker(configuredPath: string | undefined, workerData: import("./clientDbWriterProtocol.js").ClientDbWriterWorkerData): Worker {
  const bundle = typeof __filename === "string" ? path.dirname(__filename) : path.dirname(path.resolve(process.argv[1] ?? ""));
  const candidates = configuredPath ? [path.resolve(configuredPath)] : [path.join(bundle, "clientDbWriterWorker.cjs"),
    path.resolve("src/db/clientDbWriterWorker.ts"), path.resolve("apps/desktop/client/src/db/clientDbWriterWorker.ts")];
  const workerPath = candidates.find(candidate => fs.existsSync(candidate));
  if (!workerPath) throw new Error("CLIENT_DB_WRITER_ENTRY_NOT_FOUND");
  if (!workerPath.endsWith(".ts")) return new Worker(pathToFileURL(workerPath), { workerData });
  const require = createRequire(path.resolve(process.argv[1] ?? "package.json"));
  const bootstrap = `import { tsImport } from ${JSON.stringify(pathToFileURL(require.resolve("tsx/esm/api")).href)}; await tsImport(${JSON.stringify(pathToFileURL(workerPath).href)}, import.meta.url);`;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), { execArgv: ["--conditions", "development"], workerData });
}
