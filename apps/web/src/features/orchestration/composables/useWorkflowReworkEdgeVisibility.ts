import { computed, onScopeDispose, ref, watch } from "vue";

const STORAGE_PREFIX = "codeflow-orch-rework-edges";
const CHANGE_EVENT = "codeflow-workflow-rework-edge-visibility-change";

/** 共用本机退回线偏好；按工作区和流程隔离，不修改流程定义或执行快照。 */
export function useWorkflowReworkEdgeVisibility(
  workspaceId: () => string | null | undefined,
  workflowId: () => string | null | undefined,
) {
  const storageKey = computed(() => {
    const id = String(workflowId() ?? "").trim();
    return id ? `${STORAGE_PREFIX}:${workspaceId() ?? ""}:${id}` : "";
  });
  const visibility = ref<boolean | null>(null);
  const preferenceError = ref<string | null>(null);
  const showReworkEdges = computed(() => visibility.value === true);

  /** 存储失败进入可见失败态；写失败不更新画布、不广播成功。 */
  function failPreference(action: "read" | "write", error: unknown): false {
    console.error("[workflow-rework-edge-visibility] preference failed", {
      errorCode: action === "read" ? "WORKFLOW_REWORK_PREFERENCE_READ_FAILED" : "WORKFLOW_REWORK_PREFERENCE_WRITE_FAILED",
      requestId: null,
      workspaceId: workspaceId(),
      workflowId: workflowId(),
      action,
      error,
    });
    preferenceError.value = action === "read"
      ? "读取退回线显示设置失败，请重试"
      : "保存退回线显示设置失败，请重试";
    return false;
  }

  /** 切换流程或收到通知时重新读取当前存储，避免迟到事件覆盖较新的设置。 */
  function reloadVisibility(): boolean {
    visibility.value = null;
    preferenceError.value = null;
    if (!storageKey.value) {
      visibility.value = true;
      return true;
    }
    try {
      visibility.value = window.localStorage.getItem(storageKey.value) !== "0";
      return true;
    } catch (error) {
      return failPreference("read", error);
    }
  }

  /** 先保存再更新和通知同页画布；其他页签由浏览器 storage 事件同步。 */
  function setReworkEdgeVisibility(visible: boolean): boolean {
    if (!storageKey.value || visibility.value === null) return false;
    try {
      window.localStorage.setItem(storageKey.value, visible ? "1" : "0");
    } catch (error) {
      return failPreference("write", error);
    }
    visibility.value = visible;
    preferenceError.value = null;
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: storageKey.value }));
    return true;
  }

  /** 同页仅刷新当前流程，其他流程的设置互不影响。 */
  function onPreferenceChange(event: Event): void {
    if ((event as CustomEvent<string>).detail === storageKey.value) reloadVisibility();
  }

  /** 处理其他页签的更新、删除和清空；读取最新值而非事件携带的旧值。 */
  function onStorage(event: StorageEvent): void {
    if (event.key === null || event.key === storageKey.value) reloadVisibility();
  }

  watch(storageKey, reloadVisibility, { immediate: true, flush: "sync" });
  window.addEventListener(CHANGE_EVENT, onPreferenceChange);
  window.addEventListener("storage", onStorage);
  onScopeDispose(() => {
    window.removeEventListener(CHANGE_EVENT, onPreferenceChange);
    window.removeEventListener("storage", onStorage);
  });

  return { showReworkEdges, preferenceError, reloadVisibility, setReworkEdgeVisibility };
}
