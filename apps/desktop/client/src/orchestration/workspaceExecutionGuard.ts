import type { WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../app/handleApiRequest.js";

type Context = Pick<ApiHandlerContext, "workspaces" | "db" | "sessions"> & {
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
};

/**
 * 工作区执行策略：代码目录不是全局互斥锁。
 * 普通会话、多个工作流以及工作流节点会话可以并行运行；需要隔离文件
 * 变更时由工作流/会话显式选择 worktree。这里保留旧入口，确保工作区
 * 不存在时尽早失败，并兼容旧的启动、续跑和等待调用。
 */
function assertWorkspaceAvailable(ctx: Context, workspaceId: string): void {
  if (!ctx.workspaces.get(workspaceId as WorkspaceId)) throw new Error("工作区目录不可用");
}

/** 普通会话和工作流之间不再互相占用目录锁。 */
export function reserveChatWorkflowDirectory(ctx: Context, workspaceId: string, _threadId: string, _readOnly: boolean): () => void {
  assertWorkspaceAvailable(ctx, workspaceId);
  return () => {};
}

/** 普通会话发送前只校验工作区仍然存在，不检查其他执行。 */
export function assertChatDirectoryAvailable(ctx: Context, workspaceId: string, _exceptThreadId?: string | null): void {
  assertWorkspaceAvailable(ctx, workspaceId);
}

/** 工作流启动/恢复前允许与其他会话、工作流并行，仅校验工作区存在。 */
export function assertChatWorkflowDirectoryAvailable(
  ctx: Context,
  workspaceId: string,
  _exceptInstanceId?: string | null,
  _exceptThreadId?: string | null,
): void {
  assertWorkspaceAvailable(ctx, workspaceId);
}

/** 目录没有跨会话互斥，因此编排引擎无需轮询等待目录释放。 */
export async function waitForWorkspaceWriteAvailable(
  ctx: Context,
  workspaceId: string,
  _exceptInstanceId?: string | null,
  _exceptThreadId?: string | null,
  options?: { intervalMs?: number; maxWaitMs?: number; shouldAbort?: () => boolean },
): Promise<void> {
  const check = () => {
    if (options?.shouldAbort?.()) return;
    assertWorkspaceAvailable(ctx, workspaceId);
  };
  if (ctx.withLegacyDatabase) await ctx.withLegacyDatabase(`orchestration-workspace:${workspaceId}`, check);
  else check();
}
