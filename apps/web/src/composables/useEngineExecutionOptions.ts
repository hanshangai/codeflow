import { computed } from "vue";
import type { AccessMode, EngineType } from "@codeflowai/shared";

import { useEngineStore } from "../store/engine";
import { buildModelSelectOptionGroups, type ModelSelectOptionGroup } from "./modelSelectOptions";

type Getter<T> = () => T;

type UseEngineExecutionOptionsArgs = {
  engine: Getter<EngineType | "" | null | undefined>;
  model: Getter<string | null | undefined>;
  effort: Getter<string | null | undefined>;
  workspaceId?: Getter<string | null | undefined>;
};

type SelectOption = { value: string; label: string };

const ACCESS_MODE_OPTIONS: Array<{ value: AccessMode; label: string }> = [
  { value: "current", label: "需确认" },
  { value: "read-only", label: "只读" },
  { value: "full-access", label: "自动执行" },
];

export function useEngineExecutionOptions(args: UseEngineExecutionOptionsArgs) {
  const engines = useEngineStore();

  const engineType = computed<EngineType | null>(() => {
    const raw = String(args.engine() ?? "").trim();
    if (raw === "claude" || raw === "codex") return raw;
    return null;
  });

  const engineStatus = computed(() => {
    const type = engineType.value;
    if (!type) return null;
    const workspaceId = String(args.workspaceId?.() ?? "").trim();
    return workspaceId
      ? (engines.byTypeForWorkspace(workspaceId).get(type) ?? null)
      : (engines.byType.get(type) ?? null);
  });

  const currentModel = computed(() => String(args.model() ?? "").trim());
  const currentEffort = computed(() => String(args.effort() ?? "").trim());

  const defaultModelId = computed(() => engineStatus.value?.models.find((item) => item.isDefault)?.id ?? "");
  const resolvedModelId = computed(() => currentModel.value || defaultModelId.value);

  const resolvedModelInfo = computed(() => {
    const status = engineStatus.value;
    const modelId = resolvedModelId.value;
    if (!status || !modelId) return null;
    return status.models.find((item) => item.id === modelId) ?? null;
  });

  const hasModelCatalog = computed(() => (engineStatus.value?.models.length ?? 0) > 0);
  const hasEffortCatalog = computed(() => (resolvedModelInfo.value?.supportedReasoningEfforts?.length ?? 0) > 0);

  const modelOptions = computed<ModelSelectOptionGroup[]>(() =>
    buildModelSelectOptionGroups(engineStatus.value?.models ?? [], currentModel.value, { engine: engineType.value }),
  );

  const effortOptions = computed<SelectOption[]>(() => {
    const supported = resolvedModelInfo.value?.supportedReasoningEfforts ?? [];
    const options: SelectOption[] = supported.map((item) => ({
      value: item.reasoningEffort,
      label: item.reasoningEffort,
    }));
    if (currentEffort.value && !options.some((item) => item.value === currentEffort.value)) {
      options.unshift({ value: currentEffort.value, label: `${currentEffort.value}（当前值）` });
    }
    return options;
  });

  return {
    accessModeOptions: ACCESS_MODE_OPTIONS,
    engineStatus,
    effortOptions,
    hasEffortCatalog,
    hasModelCatalog,
    modelOptions,
    resolvedModelInfo,
  };
}

