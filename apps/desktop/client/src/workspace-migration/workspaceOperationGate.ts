import type { WorkspaceId } from "@codeflowai/shared";

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export type WorkspaceMigrationActivity = {
  type: string;
  resourceId: string;
};

type WorkspaceGateState = {
  migrationOperationId: string | null;
  activeWriteCount: number;
  drainWaiters: Set<() => void>;
  activities: Map<string, WorkspaceMigrationActivity>;
  finalHandoff: { operationId: string; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } | null;
  finalHandoffFailure: unknown | null;
};

export type WorkspaceWriteLease = (() => void) & {
  /** 原写入未释放时只允许同步收尾，不向其他任务传播迁移期间的准入资格。 */
  run<T>(operation: () => T): T;
};

/** 工作区迁移门禁错误；调用边界据此返回稳定的 409 业务错误。 */
export class WorkspaceOperationGateError extends Error {
  constructor(
    public readonly code: "WORKSPACE_MIGRATION_IN_PROGRESS" | "WORKSPACE_MIGRATION_BUSY",
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkspaceOperationGateError";
  }
}

/** 工作区级写入门禁；迁移预留先阻止新写，再等待已登记短事务退出。 */
export class WorkspaceOperationGate {
  private readonly states = new Map<WorkspaceId, WorkspaceGateState>();
  private readonly drainOwners = new Map<string, (workspaceId: WorkspaceId) => Promise<void>>();
  private readonly writeContinuations = new Map<WorkspaceId, number>();

  /** 长驻数据库 owner 在迁移取得独占前排空并关闭连接，不能只等待同步事务计数。 */
  registerDrainOwner(ownerId: string, drain: (workspaceId: WorkspaceId) => Promise<void>): () => void {
    if (!ownerId || this.drainOwners.has(ownerId)) throw new Error("WORKSPACE_DRAIN_OWNER_CONFLICT");
    this.drainOwners.set(ownerId, drain);
    return () => {
      if (this.drainOwners.get(ownerId) !== drain) throw new Error("WORKSPACE_DRAIN_OWNER_MISMATCH");
      this.drainOwners.delete(ownerId);
    };
  }

  /** 最终交接开始后等待当前 owner 真实收口；普通写入仍由原门禁拒绝。 */
  async waitForFinalHandoff(workspaceId: WorkspaceId): Promise<void> {
    const state = this.states.get(workspaceId);
    if (state?.finalHandoffFailure) throw state.finalHandoffFailure;
    await state?.finalHandoff?.promise;
  }

  /** 同一迁移 owner 建立固定 30 秒最终交接，不重复申请迁移独占或等待 Scheduler。 */
  async beginFinalHandoff(workspaceId: WorkspaceId, operationId: string): Promise<{ complete: () => void; fail: (error: unknown) => void }> {
    const state = this.states.get(workspaceId);
    if (!state || state.migrationOperationId !== operationId || state.finalHandoff || state.finalHandoffFailure) {
      throw new WorkspaceOperationGateError("WORKSPACE_MIGRATION_BUSY", "最终数据库交接 owner 无效", { workspaceId, operationId });
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // owner 会显式检查失败；防止尚无消费者等待时产生未处理拒绝。
    void promise.then(undefined, () => undefined);
    const handoff = { operationId, promise, resolve, reject };
    state.finalHandoff = handoff;
    try { await this.waitForWritesToDrain(workspaceId, state, DEFAULT_DRAIN_TIMEOUT_MS); }
    catch (error) { state.finalHandoffFailure = error; reject(error); throw error; }
    return {
      complete: () => {
        if (state.finalHandoff !== handoff || state.activeWriteCount !== 0) throw new Error("WORKSPACE_DB_HANDOFF_NOT_DRAINED");
        state.finalHandoff = null; state.finalHandoffFailure = null; resolve();
      },
      fail: error => { state.finalHandoffFailure = error; reject(error); },
    };
  }

  /** 关闭或失败时立即拒绝本 owner 等待者，保持资源隔离直至真实释放。 */
  failFinalHandoff(workspaceId: WorkspaceId, operationId: string, error: unknown): void {
    const state = this.states.get(workspaceId);
    if (!state || state.migrationOperationId !== operationId) throw new Error("WORKSPACE_DB_HANDOFF_OWNER_MISMATCH");
    if (state.finalHandoff) { state.finalHandoffFailure = error; state.finalHandoff.reject(error); }
  }

  /** 迁移拒绝新写；已有写凭据的同步收尾仍可复用连接和仓储入口。 */
  assertWriteAllowed(workspaceId: WorkspaceId): void {
    const state = this.states.get(workspaceId);
    if (state?.migrationOperationId && !this.writeContinuations.has(workspaceId)) throw migrationInProgress(workspaceId, state.migrationOperationId);
  }

  /** 登记写入并返回可同步续用的原凭据；迁移只等待已登记操作真实释放。 */
  beginWrite(workspaceId: WorkspaceId): WorkspaceWriteLease {
    const state = this.getOrCreate(workspaceId);
    this.assertWriteAllowed(workspaceId);
    state.activeWriteCount += 1;
    let released = false, running = 0;
    const release = () => {
      if (released) return;
      if (running) throw new Error("WORKSPACE_WRITE_CONTINUATION_ACTIVE");
      released = true;
      state.activeWriteCount -= 1;
      if (state.activeWriteCount < 0) throw new Error(`工作区写门禁计数失衡：workspaceId=${workspaceId}`);
      if (state.activeWriteCount === 0) {
        for (const resolve of state.drainWaiters) resolve();
        state.drainWaiters.clear();
      }
      this.deleteIfIdle(workspaceId, state);
    };
    return Object.assign(release, {
      /** 同步续体复用原计数，finally立即撤销，仅原工作区和未释放凭据有效。 */
      run: <T>(operation: () => T): T => {
        if (released || this.states.get(workspaceId) !== state) throw new Error("WORKSPACE_WRITE_CONTINUATION_RELEASED");
        running++;
        this.writeContinuations.set(workspaceId, (this.writeContinuations.get(workspaceId) ?? 0) + 1);
        try {
          const result = operation();
          if (result && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") {
            throw new Error("WORKSPACE_WRITE_CONTINUATION_MUST_BE_SYNCHRONOUS");
          }
          return result;
        } finally {
          running--;
          const remaining = this.writeContinuations.get(workspaceId)! - 1;
          if (remaining) this.writeContinuations.set(workspaceId, remaining);
          else this.writeContinuations.delete(workspaceId);
        }
      },
    });
  }

  /** 仅供定时快照或固定延期登记短资源；必须匹配实际 owner，最终交接期间拒绝延期。 */
  beginScheduledTaskOperation(workspaceId: WorkspaceId, operationId: string | null, purpose: "snapshot" | "defer"): () => void {
    const state = this.getOrCreate(workspaceId);
    if (state.migrationOperationId !== operationId || purpose === "defer" && (!operationId || state.finalHandoff || state.finalHandoffFailure)) {
      throw new WorkspaceOperationGateError("WORKSPACE_MIGRATION_BUSY", "定时任务操作 owner 已变化或正在最终交接", { workspaceId, operationId });
    }
    state.activeWriteCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true; state.activeWriteCount--;
      if (state.activeWriteCount === 0) { for (const resolve of state.drainWaiters) resolve(); state.drainWaiters.clear(); }
      this.deleteIfIdle(workspaceId, state);
    };
  }

  /** 登记一个可定位的长时活动；迁移检查时由 ActivityInspector 返回。 */
  beginActivity(workspaceId: WorkspaceId, activity: WorkspaceMigrationActivity): () => void {
    const state = this.getOrCreate(workspaceId);
    if (state.migrationOperationId) throw migrationInProgress(workspaceId, state.migrationOperationId);
    const type = normalizeText(activity.type, "type");
    const resourceId = normalizeText(activity.resourceId, "resourceId");
    const key = `${type}\u0000${resourceId}`;
    if (state.activities.has(key)) {
      throw new Error(`工作区活动重复登记：workspaceId=${workspaceId}, type=${type}, resourceId=${resourceId}`);
    }
    state.activities.set(key, { type, resourceId });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!state.activities.delete(key)) {
        throw new Error(`工作区活动释放失败：workspaceId=${workspaceId}, type=${type}, resourceId=${resourceId}`);
      }
      this.deleteIfIdle(workspaceId, state);
    };
  }

  /** 预留迁移独占权并等待短事务排空；返回的 release 仅能释放本 operation。 */
  async acquireMigration(
    workspaceId: WorkspaceId,
    operationId: string,
    options?: { drainTimeoutMs?: number },
  ): Promise<() => void> {
    const normalizedOperationId = normalizeText(operationId, "operationId");
    const state = this.getOrCreate(workspaceId);
    if (state.migrationOperationId && state.migrationOperationId !== normalizedOperationId) {
      throw new WorkspaceOperationGateError(
        "WORKSPACE_MIGRATION_BUSY",
        `工作区已有目录迁移门禁：workspaceId=${workspaceId}`,
        { workspaceId, operationId: state.migrationOperationId },
      );
    }
    state.migrationOperationId = normalizedOperationId;
    const timeoutMs = normalizeTimeout(options?.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
    let drainTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { for (const drain of this.drainOwners.values()) await drain(workspaceId); })(),
        new Promise<never>((_resolve, reject) => { drainTimeout = setTimeout(() => reject(new WorkspaceOperationGateError(
          "WORKSPACE_MIGRATION_BUSY", "等待工作区数据库 owner 排空超时", { workspaceId, operationId, timeoutMs })), timeoutMs); }),
      ]);
      clearTimeout(drainTimeout);
      await this.waitForWritesToDrain(
        workspaceId,
        state,
        timeoutMs,
      );
    } catch (error) {
      if (state.migrationOperationId === normalizedOperationId) state.migrationOperationId = null;
      this.deleteIfIdle(workspaceId, state);
      throw error;
    } finally { clearTimeout(drainTimeout); }
    let released = false;
    return () => {
      if (released) return;
      if (state.migrationOperationId !== normalizedOperationId) {
        throw new Error(`工作区迁移门禁 owner 不匹配：workspaceId=${workspaceId}, operationId=${normalizedOperationId}`);
      }
      if (state.activeWriteCount !== 0) throw new Error("WORKSPACE_DB_HANDOFF_RESOURCES_OPEN");
      released = true;
      state.finalHandoff?.resolve(); state.finalHandoff = null; state.finalHandoffFailure = null;
      state.migrationOperationId = null;
      this.deleteIfIdle(workspaceId, state);
    };
  }

  /** 启动恢复时同步恢复独占 owner；此时尚未开放任何写入口。 */
  restoreMigration(workspaceId: WorkspaceId, operationId: string): () => void {
    const state = this.getOrCreate(workspaceId);
    const normalizedOperationId = normalizeText(operationId, "operationId");
    if (state.migrationOperationId && state.migrationOperationId !== normalizedOperationId) {
      throw new WorkspaceOperationGateError(
        "WORKSPACE_MIGRATION_BUSY",
        `工作区已有目录迁移门禁：workspaceId=${workspaceId}`,
        { workspaceId, operationId: state.migrationOperationId },
      );
    }
    if (state.activeWriteCount !== 0) {
      throw new Error(`启动恢复迁移门禁时仍有工作区写操作：workspaceId=${workspaceId}`);
    }
    state.migrationOperationId = normalizedOperationId;
    let released = false;
    return () => {
      if (released) return;
      if (state.migrationOperationId !== normalizedOperationId) {
        throw new Error(`工作区恢复门禁 owner 不匹配：workspaceId=${workspaceId}, operationId=${normalizedOperationId}`);
      }
      if (state.activeWriteCount !== 0) throw new Error("WORKSPACE_DB_HANDOFF_RESOURCES_OPEN");
      released = true;
      state.finalHandoff?.resolve(); state.finalHandoff = null; state.finalHandoffFailure = null;
      state.migrationOperationId = null;
      this.deleteIfIdle(workspaceId, state);
    };
  }

  /** 返回当前迁移 owner；null 表示工作区未处于迁移独占阶段。 */
  getMigrationOperationId(workspaceId: WorkspaceId): string | null {
    return this.states.get(workspaceId)?.migrationOperationId ?? null;
  }

  /** 更新仅读取已登记短事务，不获取迁移独占权或改变原活动。 */
  hasActiveWrites(): boolean {
    return [...this.states.values()].some(state => state.activeWriteCount > 0);
  }

  /** 返回指定工作区当前已登记的长时活动快照。 */
  listActivities(workspaceId: WorkspaceId): WorkspaceMigrationActivity[] {
    return [...(this.states.get(workspaceId)?.activities.values() ?? [])]
      .sort((left, right) => left.type.localeCompare(right.type) || left.resourceId.localeCompare(right.resourceId));
  }

  /** 等待当前工作区短事务计数归零，超时后保持显式失败。 */
  private async waitForWritesToDrain(
    workspaceId: WorkspaceId,
    state: WorkspaceGateState,
    timeoutMs: number,
  ): Promise<void> {
    if (state.activeWriteCount === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      state.drainWaiters.add(resolve);
    });
    try {
      await Promise.race([
        drained,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new WorkspaceOperationGateError(
            "WORKSPACE_MIGRATION_BUSY",
            `等待工作区写操作退出超时：workspaceId=${workspaceId}`,
            { workspaceId, activeWriteCount: state.activeWriteCount, timeoutMs },
          )), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      state.drainWaiters.delete(resolveDrain);
    }
  }

  /** 延迟创建工作区状态，空闲时及时移除。 */
  private getOrCreate(workspaceId: WorkspaceId): WorkspaceGateState {
    const normalizedWorkspaceId = normalizeText(workspaceId, "workspaceId") as WorkspaceId;
    const existing = this.states.get(normalizedWorkspaceId);
    if (existing) return existing;
    const created: WorkspaceGateState = {
      migrationOperationId: null,
      activeWriteCount: 0,
      drainWaiters: new Set(),
      activities: new Map(),
      finalHandoff: null,
      finalHandoffFailure: null,
    };
    this.states.set(normalizedWorkspaceId, created);
    return created;
  }

  /** 状态无 owner、写入和活动时释放 Map 项。 */
  private deleteIfIdle(workspaceId: WorkspaceId, state: WorkspaceGateState): void {
    if (state.migrationOperationId || state.activeWriteCount !== 0 || state.activities.size !== 0) return;
    this.states.delete(workspaceId);
  }
}

function migrationInProgress(workspaceId: WorkspaceId, operationId: string): WorkspaceOperationGateError {
  return new WorkspaceOperationGateError(
    "WORKSPACE_MIGRATION_IN_PROGRESS",
    `工作区正在迁移目录：workspaceId=${workspaceId}`,
    { workspaceId, operationId },
  );
}

function normalizeText(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`工作区门禁字段不能为空：${field}`);
  return text;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`工作区门禁超时无效：${String(value)}`);
  return value;
}
