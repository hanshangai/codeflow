import type { EngineType, SessionId, ThreadId, ThreadSessionCapabilities, WorkspaceId } from "@codeflowai/shared";

export type ThreadRuntime = {
  threadId: ThreadId;
  workspaceId: WorkspaceId;
  engine: EngineType;
  title: string;
  /** 引擎侧会话标识（Claude sessionId / Codex threadId），首次获取后写入。 */
  sessionId: SessionId | null;
  /** 引擎会话已挂载的平台能力（用于恢复时判断能否继续走原生工具回路）。 */
  sessionCapabilities: ThreadSessionCapabilities | null;
  /** 线程生命周期版本：clear/resetSession 后递增，用于隔离旧 turn 的迟到事件。 */
  lifecycleVersion: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * Client 侧 thread 存储（内存态）：
 * - thread 创建时确定 engine（不可变）
 * - sessionId 首次拿到后写入（用于 resume）
 */
export class ThreadStore {
  private readonly byThreadId = new Map<ThreadId, ThreadRuntime>();

  /** 创建并记录 thread（若已存在则返回已有记录）。 */
  create(opts: {
    threadId: ThreadId;
    workspaceId: WorkspaceId;
    engine: EngineType;
    title: string;
    sessionId?: SessionId | null;
    sessionCapabilities?: ThreadSessionCapabilities | null;
  }): ThreadRuntime {
    const existing = this.byThreadId.get(opts.threadId);
    if (existing) {
      if (existing.workspaceId !== opts.workspaceId || existing.engine !== opts.engine) {
        throw Object.assign(new Error("THREAD_RUNTIME_SCOPE_CONFLICT"), {
          code: "THREAD_RUNTIME_SCOPE_CONFLICT", threadId: opts.threadId,
          workspaceId: opts.workspaceId, existingWorkspaceId: existing.workspaceId,
        });
      }
      if (opts.sessionId) existing.sessionId = opts.sessionId;
      if (opts.sessionCapabilities !== undefined) existing.sessionCapabilities = opts.sessionCapabilities ?? null;
      return existing;
    }
    const now = Date.now();
    const rt: ThreadRuntime = {
      threadId: opts.threadId,
      workspaceId: opts.workspaceId,
      engine: opts.engine,
      title: opts.title,
      sessionId: opts.sessionId ?? null,
      sessionCapabilities: opts.sessionCapabilities ?? null,
      lifecycleVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.byThreadId.set(opts.threadId, rt);
    return rt;
  }

  /** 获取 thread 运行态。 */
  get(threadId: ThreadId): ThreadRuntime | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  /** 写入 sessionId（首次创建后可用于 resume）。 */
  setSessionId(threadId: ThreadId, sessionId: SessionId): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    rt.sessionId = sessionId;
    rt.updatedAt = Date.now();
  }

  setSessionBinding(threadId: ThreadId, sessionId: SessionId, sessionCapabilities: ThreadSessionCapabilities | null): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    rt.sessionId = sessionId;
    rt.sessionCapabilities = sessionCapabilities ?? null;
    rt.updatedAt = Date.now();
  }

  setSessionCapabilities(threadId: ThreadId, sessionCapabilities: ThreadSessionCapabilities | null): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    rt.sessionCapabilities = sessionCapabilities ?? null;
    rt.updatedAt = Date.now();
  }

  dropSessionBinding(threadId: ThreadId): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    rt.sessionId = null;
    rt.sessionCapabilities = null;
    rt.updatedAt = Date.now();
  }

  /** 更新 title（不影响 engine/ids）。 */
  setTitle(threadId: ThreadId, title: string): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    const t = String(title ?? "").trim();
    if (!t) return;
    rt.title = t;
    rt.updatedAt = Date.now();
  }

  /** 清空 session 绑定；历史清理可保留原活动时间，避免把旧会话顶到列表前面。 */
  clearSessionId(threadId: ThreadId, opts?: { preserveUpdatedAt?: boolean }): void {
    const rt = this.byThreadId.get(threadId);
    if (!rt) return;
    rt.sessionId = null;
    rt.sessionCapabilities = null;
    rt.lifecycleVersion += 1;
    if (!opts?.preserveUpdatedAt) rt.updatedAt = Date.now();
  }

  /** 删除 thread 运行态。 */
  delete(threadId: ThreadId): void {
    this.byThreadId.delete(threadId);
  }
}

