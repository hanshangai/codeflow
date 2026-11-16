import { computed, ref } from "vue";

export type OrchAssetEditorHandle = {
  hasUnsavedChanges: () => boolean;
  saveCurrentDraft: () => Promise<boolean>;
  discardUnsavedChanges: () => void;
};

/** 维护资产编辑草稿的保存态快照，用于切换前判断是否存在未保存修改。 */
export function useOrchAssetDirtyState(readDraft: () => unknown) {
  const baselineSnapshot = ref(stableAssetSnapshot(readDraft()));
  const draftSnapshot = computed(() => stableAssetSnapshot(readDraft()));
  const isDirty = computed(() => baselineSnapshot.value !== draftSnapshot.value);

  /** 将当前草稿标记为最近保存态。 */
  function markCleanFromCurrentDraft(): void {
    baselineSnapshot.value = draftSnapshot.value;
  }

  /** 返回当前草稿是否偏离最近保存态。 */
  function hasUnsavedChanges(): boolean {
    return isDirty.value;
  }

  /** 判断一个持久化快照是否真的偏离当前已保存基线。 */
  function isSnapshotDifferentFromBaseline(value: unknown): boolean {
    return baselineSnapshot.value !== stableAssetSnapshot(value);
  }

  return {
    isDirty,
    /** 当前草稿的稳定快照；调用方要「持续感知编辑」必须监听它——isDirty 是布尔，只在跳变时触发一次。 */
    draftSnapshot,
    hasUnsavedChanges,
    isSnapshotDifferentFromBaseline,
    markCleanFromCurrentDraft,
  };
}

/** 将资产草稿转换为字段顺序稳定的快照字符串。 */
function stableAssetSnapshot(value: unknown): string {
  return JSON.stringify(normalizeForSnapshot(value));
}

/** 递归排序对象键，避免字段插入顺序造成误判。 */
function normalizeForSnapshot(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeForSnapshot(item));
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const next = normalizeForSnapshot(input[key]);
    if (next !== undefined) output[key] = next;
  }
  return output;
}
