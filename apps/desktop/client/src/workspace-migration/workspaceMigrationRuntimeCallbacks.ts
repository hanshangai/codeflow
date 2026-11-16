import type { WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import type { WorkspaceDirectoryMigrationRecord } from "../db/repos/workspaceDirectoryMigrationRepo.js";
import type { WorkspaceOperationGate } from "./workspaceOperationGate.js";

/** 保持启动装配的迁移回调可独立验证；资源仍由原会话和路径索引持有。 */
export function createWorkspaceMigrationRuntimeCallbacks(input: {
  db: ClientDb;
  gate: WorkspaceOperationGate;
  sessions: { disposeThread(threadId: string): Promise<void> };
  pathIndex: { upsertWorkspace(workspaceId: WorkspaceId, directory: string, options: { prepareOnly: true }): void;
    suspendWorkspace?: (workspaceId: WorkspaceId) => Promise<() => void> };
  onWorkspacesChanged(reason: "migration"): void | Promise<void>;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
}) {
  return {
    ...(input.pathIndex.suspendWorkspace ? {
      /** 复制前排空原索引owner，门禁释放后再恢复原state的监听与构建。 */
      prepareWorkspaceIndex: (workspaceId: WorkspaceId) => input.pathIndex.suspendWorkspace!(workspaceId),
    } : {}),
    /** 独占期只在原 owner 快照中收集 ID，关闭连接后再异步释放会话。 */
    async disposeWorkspaceSessions(workspaceId: WorkspaceId): Promise<void> {
      const readIds = () => input.db.withWorkspaceCoreSnapshot(workspaceId, input.gate.getMigrationOperationId(workspaceId), view => {
        const result: string[] = [];
        if (!view) return result;
        let cursor: string | null = null;
        do {
          const page = view.threads.listByWorkspace(workspaceId, { includeArchived: true, limit: 2000, cursor });
          result.push(...page.threads.map(thread => thread.id));
          cursor = page.hasMore ? page.nextCursor : null;
          if (page.hasMore && !cursor) throw new Error(`释放工作区会话时分页缺少游标：workspaceId=${workspaceId}`);
        } while (cursor);
        return result;
      });
      const ids = input.withLegacyDatabase ? await input.withLegacyDatabase(`migration:sessions:${workspaceId}`, readIds) : readIds();
      await Promise.all(ids.map(id => input.sessions.disposeThread(id)));
    },
    /** 独占期仅刷新路径，构建由原迁移预留在 gate 释放后启动。 */
    async onCommittedPath(operation: WorkspaceDirectoryMigrationRecord): Promise<void> {
      input.pathIndex.upsertWorkspace(operation.workspaceId, operation.targetPath, { prepareOnly: true });
      await input.onWorkspacesChanged("migration");
    },
  };
}
