import { h, ref } from "vue";
import { message, Modal } from "ant-design-vue";
import type { OrchAssetBundle, OrchAssetBundleImportCounts, OrchAssetBundleImportMode, OrchAssetBundleWarning, OrchAssetBundlesImportResponseBody, WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore } from "../../../store/orchestration";

type ImportedAssets = OrchAssetBundlesImportResponseBody["imported"];

const IMPORT_MODE_OPTIONS: { value: OrchAssetBundleImportMode; label: string; description: string }[] = [
  {
    value: "skip_existing",
    label: "仅新增导入",
    description: "同源资产已存在时保持现状，只导入目标工作区缺失的资产。",
  },
  {
    value: "overwrite",
    label: "覆盖导入",
    description: "同源资产已存在时使用资产包内容覆盖，影响后续新建实例。",
  },
  {
    value: "copy",
    label: "副本导入",
    description: "每次生成一套新的流程及依赖资产，适合分叉改造。",
  },
];

type UseOrchAssetBundleImportInput = {
  workspaceId: () => WorkspaceId;
  onImported?: (imported: ImportedAssets) => void | Promise<void>;
};

/** 统一处理规格页资产包导入，避免各侧边栏重复维护解析与提示逻辑。 */
export function useOrchAssetBundleImport(input: UseOrchAssetBundleImportInput) {
  const orch = useOrchestrationStore();
  const { ctx } = useApiContext();
  const importInputRef = ref<HTMLInputElement | null>(null);
  const importing = ref(false);

  /** 触发隐藏文件选择器。 */
  function triggerImport(): void {
    if (importing.value) return;
    importInputRef.value?.click();
  }

  /** 解析并导入资产包，导入完成后交由调用方决定选中哪个资产。 */
  async function onImportFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement | null)?.files?.[0] ?? null;
    if (!file) return;
    importing.value = true;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as OrchAssetBundle;
      const importMode = await confirmImportMode(bundle);
      if (!importMode) return;
      const imported = await orch.importWorkflowBundle(ctx.value, input.workspaceId(), bundle, importMode);
      await input.onImported?.(imported);
      message.success(formatImportSuccessMessage(importMode, imported));
      showAssetBundleWarningMessage(imported.warnings);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      importing.value = false;
      if (importInputRef.value) importInputRef.value.value = "";
    }
  }

  return {
    importInputRef,
    importing,
    triggerImport,
    onImportFile,
  };
}

/** 展示资产包导入/导出清理失效依赖后的提示。 */
export function showAssetBundleWarningMessage(warnings: readonly OrchAssetBundleWarning[] | null | undefined): boolean {
  const summary = formatAssetBundleWarningSummary(warnings);
  if (!summary) return false;
  message.warning(summary, 8);
  return true;
}

/** 汇总资产包 warning，避免长列表挤满页面提示。 */
export function formatAssetBundleWarningSummary(warnings: readonly OrchAssetBundleWarning[] | null | undefined): string {
  const list = (warnings ?? []).filter((warning) => warning.code === "missing_dependency");
  if (!list.length) return "";
  const preview = list.slice(0, 3).map((warning) => warning.message || `${warning.dependencyKind}:${warning.dependencyId}`);
  const suffix = list.length > preview.length ? `；另有 ${list.length - preview.length} 项` : "";
  return `已跳过 ${list.length} 个失效依赖：${preview.join("；")}${suffix}`;
}

/** 弹出导入方式选择框，取消时返回 null。 */
function confirmImportMode(bundle: OrchAssetBundle): Promise<OrchAssetBundleImportMode | null> {
  let selected: OrchAssetBundleImportMode = "skip_existing";
  const radioName = `orch-asset-import-mode-${Date.now()}`;
  return new Promise((resolve) => {
    Modal.confirm({
      title: "选择导入方式",
      okText: "开始导入",
      cancelText: "取消",
      content: () => h("div", { style: "display:flex;flex-direction:column;gap:12px;line-height:1.6;" }, [
        h("div", { style: "color:#595959;" }, `资产包：${bundle.title || bundle.bundleId || "未命名资产包"}`),
        h("div", { style: "display:flex;flex-direction:column;gap:8px;" }, IMPORT_MODE_OPTIONS.map((option) =>
          h("label", { key: option.value, style: "display:flex;gap:8px;align-items:flex-start;cursor:pointer;" }, [
            h("input", {
              type: "radio",
              name: radioName,
              value: option.value,
              checked: option.value === selected,
              onChange: () => {
                selected = option.value;
              },
            }),
            h("span", { style: "display:flex;flex-direction:column;gap:2px;" }, [
              h("strong", option.label),
              h("span", { style: "color:#8c8c8c;font-size:12px;" }, option.description),
            ]),
          ]),
        )),
      ]),
      onOk: () => resolve(selected),
      onCancel: () => resolve(null),
    });
  });
}

/** 格式化导入完成提示，保留跳过和覆盖摘要。 */
function formatImportSuccessMessage(importMode: OrchAssetBundleImportMode, imported: ImportedAssets): string {
  const importedCounts = countImportedAssets(imported);
  const skippedCounts = imported.skipped ?? createEmptyCounts();
  const overwrittenCounts = imported.overwritten ?? createEmptyCounts();
  const prefix = importMode === "copy" ? "已导入副本" : importMode === "skip_existing" ? "已完成仅新增导入" : "已完成覆盖导入";
  const parts = [`${prefix}：${formatImportCounts(importedCounts)}`];
  if (sumImportCounts(overwrittenCounts) > 0) parts.push(`覆盖 ${formatImportCounts(overwrittenCounts)}`);
  if (sumImportCounts(skippedCounts) > 0) parts.push(`跳过 ${formatImportCounts(skippedCounts)}`);
  return parts.join("；");
}

/** 将导入返回的资产数组转换为计数。 */
function countImportedAssets(imported: ImportedAssets): OrchAssetBundleImportCounts {
  return {
    roles: imported.roles.length,
    knowledgeBundles: imported.knowledgeBundles.length,
    skills: imported.skills.length,
    toolsets: imported.toolsets.length,
    workflows: imported.workflows.length,
  };
}

/** 创建空计数，兼容旧版本 Client 未返回统计的情况。 */
function createEmptyCounts(): OrchAssetBundleImportCounts {
  return {
    roles: 0,
    knowledgeBundles: 0,
    skills: 0,
    toolsets: 0,
    workflows: 0,
  };
}

/** 汇总五类资产计数。 */
function sumImportCounts(counts: OrchAssetBundleImportCounts): number {
  return counts.roles + counts.knowledgeBundles + counts.skills + counts.toolsets + counts.workflows;
}

/** 按规格页展示顺序格式化资产计数。 */
function formatImportCounts(counts: OrchAssetBundleImportCounts): string {
  return `${counts.workflows} 个流程、${counts.roles} 个角色、${counts.knowledgeBundles} 个知识库、${counts.toolsets} 个工具、${counts.skills} 个 Skill`;
}
