import { getEngineModelInfo, resolveEngineModelProvider, type EngineModelInfo, type EngineType } from "@codeflowai/shared";

export type ModelSelectOption = {
  value: string;
  label: string;
};

export type ModelSelectOptionGroup = {
  label: string;
  options: ModelSelectOption[];
};

export type ModelSelectOptionsBuildOptions = {
  allowedProviderIds?: Iterable<string> | null;
  /** 当前引擎：用于把历史别名（如 deepseek-flash[1m]）归一到目录条目，避免误落「当前值」兜底。 */
  engine?: EngineType | null;
};

/** 构造按供应商分组的模型选项；当前值缺失于目录时保留兜底项。 */
export function buildModelSelectOptionGroups(
  models: EngineModelInfo[],
  currentModel?: string | null,
  options?: ModelSelectOptionsBuildOptions,
): ModelSelectOptionGroup[] {
  const groups: ModelSelectOptionGroup[] = [];
  const groupById = new Map<string, ModelSelectOptionGroup>();
  const allowedProviderIds = options?.allowedProviderIds
    ? new Set(Array.from(options.allowedProviderIds, (item) => String(item).trim()).filter(Boolean))
    : null;
  for (const model of models) {
    const provider = resolveModelProvider(model);
    if (allowedProviderIds && !allowedProviderIds.has(provider.id)) continue;
    let group = groupById.get(provider.id);
    if (!group) {
      group = { label: provider.label, options: [] };
      groupById.set(provider.id, group);
      groups.push(group);
    }
    group.options.push({ value: model.id, label: model.displayName || model.id });
  }

  const normalizedCurrent = String(currentModel ?? "").trim();
  // 先按引擎做别名归一：已合并的历史别名应命中目录条目，而不是退化成「当前值」兜底项。
  const currentInfo = normalizedCurrent && options?.engine
    ? getEngineModelInfo(options.engine, normalizedCurrent, models)
    : null;
  const currentOptionId = currentInfo?.id ?? normalizedCurrent;
  if (currentOptionId && !groups.some((group) => group.options.some((option) => option.value === currentOptionId))) {
    groups.unshift({
      label: currentInfo ? "当前模型" : "当前模型（已移除）",
      options: [{
        value: currentOptionId,
        label: currentInfo?.displayName || `${currentOptionId}（已移除）`,
      }],
    });
  }
  return groups;
}

/** 将分组选项拍平，用于数量判断或搜索匹配。 */
export function flattenModelSelectOptionGroups(groups: ModelSelectOptionGroup[]): ModelSelectOption[] {
  return groups.flatMap((group) => group.options);
}

/** 按模型 id、展示名或供应商名过滤分组选项，并保留命中的供应商分组。 */
export function filterModelSelectOptionGroups(
  groups: ModelSelectOptionGroup[],
  query: string,
): ModelSelectOptionGroup[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return groups;
  return groups
    .map((group) => {
      const groupMatched = group.label.toLowerCase().includes(normalizedQuery);
      const options = groupMatched
        ? group.options
        : group.options.filter((option) =>
            option.value.toLowerCase().includes(normalizedQuery) ||
            option.label.toLowerCase().includes(normalizedQuery),
          );
      return { ...group, options };
    })
    .filter((group) => group.options.length > 0);
}

/** 解析供应商分组；优先使用目录元数据，兼容旧客户端返回的无元数据模型。 */
export function resolveModelProvider(model: EngineModelInfo): { id: string; label: string } {
  const provider = resolveEngineModelProvider(model);
  return { id: provider.providerId, label: provider.providerLabel };
}
