import type { WorkspaceId } from "@codeflowai/shared";
import { computed, isRef, ref, type Ref } from "vue";

import { useConfigStore } from "../../store/config";
import type { ActiveWorkspaceRuntimeState } from "../../store/presence";
import { useWorkspacesStore } from "../../store/workspaces";

type RuntimeStateSource = ActiveWorkspaceRuntimeState | Ref<ActiveWorkspaceRuntimeState>;

const dismissedStateKey = ref<string | null>(null);

/** 跨视图共享关闭状态；工作区、角色或运行态变化后自动恢复提示。 */
export function useClientStartupBanner(runtimeStateSource: RuntimeStateSource) {
  const config = useConfigStore();
  const workspaces = useWorkspacesStore();
  const runtimeState = isRef(runtimeStateSource) ? runtimeStateSource : computed(() => runtimeStateSource as ActiveWorkspaceRuntimeState);

  const currentSharedRole = computed(() => {
    if (runtimeState.value.kind !== "shared") return null;
    const workspaceId = String(config.workspaceId ?? "").trim();
    if (!workspaceId) return null;
    const workspace = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
    return workspace?.shared?.currentUserRole ?? workspace?.shared?.effectiveAssetRole ?? null;
  });
  const canManageSharedWorkspace = computed(() =>
    currentSharedRole.value === "enterprise_admin" || currentSharedRole.value === "workspace_admin",
  );
  const runtimeStateKey = computed(() => JSON.stringify([
    String(config.workspaceId ?? ""),
    config.userSummary?.userId ?? null,
    runtimeState.value.kind,
    runtimeState.value.status,
    currentSharedRole.value,
    config.desktopRuntime?.status ?? null,
    config.desktopRuntime?.requestId ?? null,
    config.desktopError ?? null,
  ]));
  const visible = computed(() => dismissedStateKey.value !== runtimeStateKey.value);

  /** 关闭仅隐藏当前状态；状态变化后恢复展示。 */
  function dismiss(): void {
    dismissedStateKey.value = runtimeStateKey.value;
  }

  return { runtimeState, currentSharedRole, canManageSharedWorkspace, runtimeStateKey, visible, dismiss };
}
