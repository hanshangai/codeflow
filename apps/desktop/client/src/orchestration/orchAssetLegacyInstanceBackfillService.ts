import type {
  OrchestrationAssetRuntimeSnapshot,
  OrchestrationId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { OrchAssetLaunchSnapshotError, type OrchAssetLaunchSnapshotService } from "./orchAssetLaunchSnapshotService.js";

type LegacyInstanceBackfillDb = Pick<ClientDb, "db" | "orchInstances" | "orchEvents"> & Partial<Pick<ClientDb, "workspaceId" | "forWorkspace">>;

/** 为 v71 前非终态实例补录可追溯的升级兼容运行快照。 */
export class OrchAssetLegacyInstanceBackfillService {
  /** 接受根Db或已固定W的view；旧显式仓储适配器保留原边界。 */
  constructor(
    private readonly db: LegacyInstanceBackfillDb,
    private readonly launchSnapshots: Pick<OrchAssetLaunchSnapshotService, "createFromWorkflow">,
  ) {}

  /** 根Db必须传可信W；同一W的实例快照和补录事件原子提交。 */
  ensureForExecution(instanceId: OrchestrationId, workspaceId?: WorkspaceId): OrchestrationAssetRuntimeSnapshot | null {
    if (this.db.workspaceId && workspaceId && this.db.workspaceId !== workspaceId) throw new Error("WORKSPACE_SCOPE_MISMATCH");
    const scope = workspaceId ?? this.db.workspaceId;
    if (this.db.forWorkspace && !scope) throw new Error("WORKSPACE_SCOPE_REQUIRED");
    const db = this.db.forWorkspace && scope ? this.db.forWorkspace(scope) : this.db;
    const instance = db.orchInstances.get(instanceId);
    if (!instance) throw new Error(`编排实例不存在: ${instanceId}`);
    if (scope && instance.workspaceId !== scope) throw new Error("WORKSPACE_SCOPE_MISMATCH");
    if (instance.assetRuntimeSnapshot?.authorityMode === "server" || instance.assetRuntimeSnapshot?.executionAuthorization) {
      throw new OrchAssetLaunchSnapshotError("ASSET_CACHE_EXECUTION_REMOVED", `历史云端资产执行已停用：${instanceId}`);
    }
    if (instance.assetRuntimeSnapshot) return instance.assetRuntimeSnapshot;
    if (isTerminalStatus(instance.status)) return null;

    const capturedAt = Date.now();
    const resolved = this.launchSnapshots.createFromWorkflow(instance.workspaceId, instance.workflowSnapshot);
    return db.db.transaction(() => {
      const latest = db.orchInstances.get(instanceId);
      if (!latest) throw new Error(`编排实例不存在: ${instanceId}`);
      if (latest.assetRuntimeSnapshot) return latest.assetRuntimeSnapshot;
      if (isTerminalStatus(latest.status)) return null;

      const backfilled = db.orchInstances.backfillAssetRuntimeSnapshot(instanceId, resolved);
      if (!backfilled.applied) return backfilled.instance.assetRuntimeSnapshot ?? null;
      const snapshot = backfilled.instance.assetRuntimeSnapshot;
      if (!snapshot) throw new Error(`编排实例资产运行快照补录结果为空: ${instanceId}`);
      db.orchEvents.append({
        instanceId,
        nodeId: null,
        type: "orchestration.assetRuntimeSnapshotBackfilled",
        payloadJson: JSON.stringify({
          instanceId,
          workflowId: backfilled.instance.workflowId,
          capturedAt,
          authorityMode: snapshot.authorityMode,
          source: "legacy_upgrade",
        }),
        createdAt: capturedAt,
      });
      return snapshot;
    })();
  }
}

/** 判断历史实例是否已进入不再产生 attempt 的终态。 */
function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
