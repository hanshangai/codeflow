import { computed, onMounted, ref, watch, type Ref } from "vue";
import { message } from "ant-design-vue";
import type { OrchAssetGroup, OrchAssetGroupType, WorkspaceId } from "@codeflowai/shared";

import { assignOrchAssetGroup, createOrchAssetGroup, deleteOrchAssetGroup, listOrchAssetGroups, renameOrchAssetGroup } from "../../../api/orchestration";
import { trackProductEvent } from "../../../analytics/analytics";
import { useApiContext } from "../../../composables/useApiContext";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";

export type AssetGroupFilter = "all" | "ungrouped" | string;

/** 跨组件挂载复用分组快照：切换资产 Tab 会重建列表组件，命中缓存时不再重复请求。 */
const cachedGroupsByScope = new Map<string, {
  serverGroups: OrchAssetGroup[];
  assignments: Record<string, string>;
}>();

/** 统一管理单类资产的分组加载、筛选和维护操作。 */
export function useAssetGroups(input: { workspaceId: Ref<WorkspaceId>; assetType: OrchAssetGroupType }) {
  const { ctx } = useApiContext();
  const groups = ref<OrchAssetGroup[]>([]);
  const assignments = ref<Record<string, string>>(copyAssetGroupAssignments({}));
  const selectedGroup = ref<AssetGroupFilter>("all");
  const loading = ref(false);
  const errorMessage = ref("");
  let requestSeq = 0;
  let workspaceEpoch = 0;

  /** 当前工作区与资产类型组成的缓存键。 */
  function groupScopeKey(): string {
    return `${input.workspaceId.value}|${input.assetType}`;
  }

  /** 用服务端分组刷新展示列表，并校正已失效的选中分组。 */
  function applyGroups(serverGroups: OrchAssetGroup[], groupAssignments: Record<string, string>): void {
    groups.value = [...serverGroups];
    assignments.value = copyAssetGroupAssignments(groupAssignments);
    if (selectedGroup.value !== "all" && selectedGroup.value !== "ungrouped" && !groups.value.some((group) => group.id === selectedGroup.value)) selectedGroup.value = "all";
  }

  /** 把本地已生效的分组改动写回缓存，保证下次复用时与界面一致。 */
  function syncGroupCache(): void {
    cachedGroupsByScope.set(groupScopeKey(), {
      serverGroups: groups.value,
      assignments: copyAssetGroupAssignments(assignments.value),
    });
  }

  /** 从当前工作区加载指定资产类型的分组；命中缓存且非强制刷新时直接复用。 */
  async function load(force = false): Promise<void> {
    const scopeKey = groupScopeKey();
    const cached = force ? undefined : cachedGroupsByScope.get(scopeKey);
    if (cached) {
      errorMessage.value = "";
      applyGroups(cached.serverGroups, cached.assignments);
      return;
    }
    const seq = ++requestSeq;
    const workspaceId = input.workspaceId.value;
    const requestWorkspaceEpoch = workspaceEpoch;
    loading.value = true;
    errorMessage.value = "";
    try {
      const result = await listOrchAssetGroups(ctx.value, workspaceId, input.assetType);
      if (!result.ok) throw new Error(result.message || "加载资产分组失败");
      if (seq !== requestSeq || !isCurrentAssetGroupWorkspace(
        workspaceId,
        input.workspaceId.value,
        requestWorkspaceEpoch,
        workspaceEpoch,
      )) return;
      applyGroups(result.groups, result.assignments);
      cachedGroupsByScope.set(scopeKey, { serverGroups: result.groups, assignments: result.assignments });
    } catch (error) {
      if (seq !== requestSeq) return;
      errorMessage.value = error instanceof Error ? error.message : "加载资产分组失败";
      message.error(errorMessage.value);
    } finally {
      if (seq === requestSeq) loading.value = false;
    }
  }

  /** 判断资产是否符合当前分组筛选；内置资产不进入未分组。 */
  function matches(asset: { id: string; kind?: string | null }): boolean {
    if (selectedGroup.value === "all") return true;
    if (selectedGroup.value === "ungrouped") return asset.kind !== "builtin" && !hasAssetGroupAssignment(assignments.value, asset.id);
    return hasAssetGroupAssignment(assignments.value, asset.id)
      && assignments.value[asset.id] === selectedGroup.value;
  }

  /** 创建分组并刷新本地列表。 */
  async function create(name: string): Promise<void> {
    const request = beginMutation();
    const result = await createOrchAssetGroup(ctx.value, { workspaceId: request.workspaceId, assetType: input.assetType, name });
    if (!result.ok) throw new Error(result.message || "创建分组失败");
    if (!finishMutation(request)) return;
    groups.value = [...groups.value, result.group].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    syncGroupCache();
    trackProductEvent("asset_group_change", {
      action: "create",
      asset_type: input.assetType,
      workspace_type: isSharedWorkspaceSelectionId(request.workspaceId) ? "shared" : "local",
    });
  }

  /** 重命名分组并更新本地列表。 */
  async function rename(groupId: string, name: string): Promise<void> {
    const request = beginMutation();
    const result = await renameOrchAssetGroup(ctx.value, { workspaceId: request.workspaceId, assetType: input.assetType, groupId, name });
    if (!result.ok) throw new Error(result.message || "重命名分组失败");
    if (!finishMutation(request)) return;
    groups.value = groups.value.map((group) => group.id === groupId ? result.group : group).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    syncGroupCache();
    trackProductEvent("asset_group_change", {
      action: "rename",
      asset_type: input.assetType,
      workspace_type: isSharedWorkspaceSelectionId(request.workspaceId) ? "shared" : "local",
    });
  }

  /** 删除分组并清理本地关联。 */
  async function remove(groupId: string): Promise<void> {
    const request = beginMutation();
    const result = await deleteOrchAssetGroup(ctx.value, { workspaceId: request.workspaceId, assetType: input.assetType, groupId });
    if (!result.ok) throw new Error(result.message || "删除分组失败");
    if (!finishMutation(request)) return;
    groups.value = groups.value.filter((group) => group.id !== groupId);
    assignments.value = copyAssetGroupAssignments(assignments.value, groupId);
    if (selectedGroup.value === groupId) selectedGroup.value = "all";
    syncGroupCache();
    trackProductEvent("asset_group_change", {
      action: "delete",
      asset_type: input.assetType,
      workspace_type: isSharedWorkspaceSelectionId(request.workspaceId) ? "shared" : "local",
    });
  }

  /** 移动自定义资产；空分组表示未分组。 */
  async function assign(assetId: string, groupId: string | null): Promise<void> {
    const request = beginMutation();
    const result = await assignOrchAssetGroup(ctx.value, { workspaceId: request.workspaceId, assetType: input.assetType, assetId, groupId });
    if (!result.ok) throw new Error(result.message || "移动资产分组失败");
    if (!finishMutation(request)) return;
    const next = copyAssetGroupAssignments(assignments.value);
    if (groupId) next[assetId] = groupId;
    else delete next[assetId];
    assignments.value = next;
    syncGroupCache();
    trackProductEvent("asset_group_change", {
      action: groupId ? "assign" : "unassign",
      asset_type: input.assetType,
      workspace_type: isSharedWorkspaceSelectionId(request.workspaceId) ? "shared" : "local",
    });
  }

  /** Captures one workspace-bound write and invalidates older list responses. */
  function beginMutation(): { workspaceId: WorkspaceId; workspaceEpoch: number } {
    requestSeq += 1;
    loading.value = false;
    return { workspaceId: input.workspaceId.value, workspaceEpoch };
  }

  /** Rejects stale write responses and invalidates lists started before the completed write. */
  function finishMutation(request: { workspaceId: WorkspaceId; workspaceEpoch: number }): boolean {
    if (!isCurrentAssetGroupWorkspace(
      request.workspaceId,
      input.workspaceId.value,
      request.workspaceEpoch,
      workspaceEpoch,
    )) return false;
    requestSeq += 1;
    loading.value = false;
    return true;
  }

  watch(input.workspaceId, () => {
    workspaceEpoch += 1;
    requestSeq += 1;
    groups.value = [];
    assignments.value = copyAssetGroupAssignments({});
    selectedGroup.value = "all";
    errorMessage.value = "";
    void load();
  }, { flush: "post" });
  onMounted(() => void load());

  return { groups: computed(() => groups.value), assignments: computed(() => assignments.value), selectedGroup, loading, errorMessage, load, matches, create, rename, remove, assign };
}

/** Matches an async group result to the exact workspace generation that started it. */
export function isCurrentAssetGroupWorkspace(
  requestWorkspaceId: WorkspaceId,
  currentWorkspaceId: WorkspaceId,
  requestWorkspaceEpoch: number,
  currentWorkspaceEpoch: number,
): boolean {
  return requestWorkspaceId === currentWorkspaceId && requestWorkspaceEpoch === currentWorkspaceEpoch;
}

/** Copies own assignment entries into a prototype-free record and optionally excludes one group. */
export function copyAssetGroupAssignments(
  source: Readonly<Record<string, string>>,
  excludedGroupId?: string,
): Record<string, string> {
  const target = Object.create(null) as Record<string, string>;
  for (const [assetId, groupId] of Object.entries(source)) {
    if (groupId !== excludedGroupId) target[assetId] = groupId;
  }
  return target;
}

/** Checks assignment ownership without observing Object prototype properties. */
export function hasAssetGroupAssignment(assignments: Readonly<Record<string, string>>, assetId: string): boolean {
  return Object.hasOwn(assignments, assetId);
}
