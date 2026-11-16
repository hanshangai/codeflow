import fs from "node:fs";
import path from "node:path";

import type { WorkspaceId } from "@codeflowai/shared";
import { resolveCanonicalWorkspaceRoot, workspacePathIndexRootKey } from "./workspacePathIndexDb.js";

export const WORKSPACE_PATH_ALREADY_REGISTERED = "WORKSPACE_PATH_ALREADY_REGISTERED";

export class WorkspaceRootConflictError extends Error {
  readonly code = WORKSPACE_PATH_ALREADY_REGISTERED;
  readonly status = 409;

  constructor(
    readonly workspaceId: WorkspaceId,
    readonly conflictingWorkspaceIds: WorkspaceId[],
    readonly workspaceRoot: string,
    readonly workspaceRootKey: string,
  ) {
    super("该物理工作区目录已被另一个工作区使用，请选择不同目录");
    this.name = "WorkspaceRootConflictError";
  }
}

export type WorkspaceRootConflict = {
  workspaceRoot: string;
  workspaceRootKey: string;
  workspaceIds: WorkspaceId[];
};

/** 找出运行态中指向同一物理根的全部 workspace；无法解析的路径留给各自错误边界处理。 */
export function findWorkspaceRootConflicts(workspaces: ReadonlyMap<WorkspaceId, string>): WorkspaceRootConflict[] {
  const byRoot = new Map<string, { workspaceRoot: string; workspaceIds: WorkspaceId[] }>();
  for (const [workspaceId, workspacePath] of workspaces) {
    try {
      const workspaceRoot = resolveCanonicalWorkspaceRoot(workspacePath);
      const workspaceRootKey = workspacePathIndexRootKey(workspaceRoot);
      const grouped = byRoot.get(workspaceRootKey) ?? { workspaceRoot, workspaceIds: [] };
      grouped.workspaceIds.push(workspaceId);
      byRoot.set(workspaceRootKey, grouped);
    } catch {
      // 路径不存在或不可读不等于 root 冲突，由 workspace 自己的打开边界记录。
    }
  }
  return Array.from(byRoot.entries())
    .filter(([, grouped]) => grouped.workspaceIds.length > 1)
    .map(([workspaceRootKey, grouped]) => ({ workspaceRootKey, ...grouped }));
}

/** 在写入 workspace repo 前拒绝候选目录复用另一个活动 workspace 的物理根。 */
export function assertWorkspaceRootAvailable(
  workspaces: ReadonlyMap<WorkspaceId, string>,
  workspaceId: WorkspaceId,
  workspacePath: string,
  options?: { allowMissingLeaf?: boolean },
): { workspaceRoot: string; workspaceRootKey: string } {
  const workspaceRoot = options?.allowMissingLeaf
    ? resolveCanonicalWorkspaceRootCandidate(workspacePath)
    : resolveCanonicalWorkspaceRoot(workspacePath);
  const workspaceRootKey = workspacePathIndexRootKey(workspaceRoot);
  const conflictingWorkspaceIds: WorkspaceId[] = [];
  for (const [otherWorkspaceId, otherWorkspacePath] of workspaces) {
    if (otherWorkspaceId === workspaceId) continue;
    try {
      const otherRoot = options?.allowMissingLeaf
        ? resolveCanonicalWorkspaceRootCandidate(otherWorkspacePath)
        : resolveCanonicalWorkspaceRoot(otherWorkspacePath);
      if (workspacePathIndexRootKey(otherRoot) === workspaceRootKey) conflictingWorkspaceIds.push(otherWorkspaceId);
    } catch {
      // 其他损坏 workspace 不阻止当前候选，除非能证明物理根相同。
    }
  }
  if (conflictingWorkspaceIds.length > 0) {
    throw new WorkspaceRootConflictError(workspaceId, conflictingWorkspaceIds, workspaceRoot, workspaceRootKey);
  }
  return { workspaceRoot, workspaceRootKey };
}

/** 解析尚未创建的迁移目标：父目录必须真实存在，最终叶子按原名称拼接。 */
function resolveCanonicalWorkspaceRootCandidate(workspacePath: string): string {
  const resolved = path.resolve(String(workspacePath ?? "").trim());
  try {
    return resolveCanonicalWorkspaceRoot(resolved);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const parent = fs.realpathSync.native(path.dirname(resolved));
  return path.join(parent, path.basename(resolved));
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
