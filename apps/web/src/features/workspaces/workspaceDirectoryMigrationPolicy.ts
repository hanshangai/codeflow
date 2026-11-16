import type { OnlineClientInfo, WorkspaceSummary } from "@codeflowai/shared";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";

/** 判断工作区是否为共享入口；共享成员不能迁移 Host 的本地目录。 */
export function isSharedWorkspaceDirectoryMigrationEntry(workspace: WorkspaceSummary): boolean {
  return workspace.kind === "shared" || Boolean(workspace.shared) || isSharedWorkspaceSelectionId(workspace.id);
}

/** 返回迁移入口的阻断原因；活动 operation 保留查看和恢复入口。 */
export function getWorkspaceDirectoryMigrationDisabledReason(input: {
  workspace: WorkspaceSummary;
  client: OnlineClientInfo | null | undefined;
  connected: boolean;
  /** 桌面本机工作区直连内置 Client，不要求 Server 会话。 */
  localDesktop?: boolean;
}): string | null {
  const { workspace, client, connected, localDesktop = false } = input;
  if (isSharedWorkspaceDirectoryMigrationEntry(workspace)) return "共享成员入口不能迁移本机目录";
  if (workspace.activeDirectoryMigration) return null;
  if (!connected && !localDesktop) return "当前未连接 Server";
  if (!client) return "工作区所属 Client 离线";
  if (!localDesktop && client.capabilities?.workspaceDirectoryMigrationV1 !== true) return "请先升级工作区所属 Client";
  if (workspace.directoryMigrationIndexState?.indexRebuildStatus === "pending") {
    return "文件索引待恢复";
  }
  return null;
}

/** 判断迁移按钮是否禁用；活动 operation 允许进入详情页处理恢复。 */
export function isWorkspaceDirectoryMigrationActionDisabled(input: {
  workspace: WorkspaceSummary;
  client: OnlineClientInfo | null | undefined;
  connected: boolean;
  localDesktop?: boolean;
}): boolean {
  return getWorkspaceDirectoryMigrationDisabledReason(input) !== null;
}
