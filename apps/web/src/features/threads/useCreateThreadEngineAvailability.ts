import { computed, ref, unref, type Ref } from "vue";
import { message } from "ant-design-vue";
import type { EngineType } from "@codeflowai/shared";

import { useApiContext } from "../../composables/useApiContext";
import { useEngineStore } from "../../store/engine";
import { useEngineKeysStore } from "../../store/engineKeys";
import { resolveEngineUnavailableIssue } from "../../utils/engineAvailability";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";
import { isCancelledRequestError } from "../../api/request";

type MaybeRef<T> = T | Ref<T>;

/** 为新建会话弹窗提供引擎禁用原因和刷新入口。 */
export function useCreateThreadEngineAvailability(workspaceId: MaybeRef<string>) {
  const { ctx } = useApiContext();
  const engines = useEngineStore();
  const engineKeys = useEngineKeysStore();
  const engineStatusError = ref<string | null>(null);
  const keyStatusError = ref<string | null>(null);

  const normalizedWorkspaceId = computed(() => String(unref(workspaceId) ?? "").trim());
  const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(normalizedWorkspaceId.value));
  const disabledEngines = computed<Partial<Record<EngineType, string>>>(() => {
    const result: Partial<Record<EngineType, string>> = {};
    for (const engine of ["claude", "codex"] as EngineType[]) {
      const status = engines.byTypeForWorkspace(normalizedWorkspaceId.value).get(engine) ?? null;
      const issue = engineStatusError.value
        ?? resolveEngineUnavailableIssue(engine, status, {
          isSharedWorkspace: isSharedWorkspace.value,
          hasMaintainedKeys: !isSharedWorkspace.value && engineKeys.hasKeysForEngine(engine),
          activeProviderIds: isSharedWorkspace.value ? [] : engineKeys.providerIdsForEngine(engine),
          keyLoadError: keyStatusError.value,
        });
      if (issue) result[engine] = issue;
    }
    return result;
  });

  /** 引擎刷新失败先禁用弹窗并向调用方抛错，阻止读取 Key 或继续创建。 */
  async function refreshEngineAvailability(): Promise<void> {
    const workspace = normalizedWorkspaceId.value;
    if (!workspace) return;
    engineStatusError.value = null;
    keyStatusError.value = null;

    try {
      await engines.refresh(ctx.value, workspace);
    } catch (error) {
      if (!isCancelledRequestError(error) && workspace === normalizedWorkspaceId.value) {
        engineStatusError.value = `无法读取引擎状态：${error instanceof Error ? error.message : String(error)}`;
      }
      throw error;
    }
    if (workspace !== normalizedWorkspaceId.value) return;
    const scopedEngineState = engines.byWorkspaceId[workspace];
    if (scopedEngineState?.lastError) {
      engineStatusError.value = `无法读取引擎状态：${scopedEngineState.lastError}`;
      return;
    }

    if (isSharedWorkspace.value) return;
    try {
      await engineKeys.refresh(ctx.value, workspace);
    } catch (error) {
      if (isCancelledRequestError(error)) return;
      keyStatusError.value = error instanceof Error ? error.message : String(error);
      message.warning(`无法读取大模型 Key 配置：${keyStatusError.value}`);
    }
  }

  return {
    disabledEngines,
    refreshEngineAvailability,
  };
}
