<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CopyOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, Loading3QuartersOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SwapOutlined, ToolOutlined } from "@ant-design/icons-vue";
import { canExportBuiltinSpecToolset, canExportSpecWorkflowRoleAssets, canImportRuleAssets, type OrchAssetBundle, type ToolsetDefinition, type ToolsetId, type WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { showAssetBundleWarningMessage, useOrchAssetBundleImport } from "../composables/useOrchAssetBundleImport";
import { useAssetGroups } from "../composables/useAssetGroups";
import AssetGroupBar from "./asset-group-bar.vue";

defineOptions({ name: "ToolsetList" });

const props = withDefaults(defineProps<{
  workspaceId: WorkspaceId;
  locked?: boolean;
  maintenanceForbidden?: boolean;
  beforeAssetChange?: () => Promise<boolean>;
  toolbarTeleportTarget?: string;
  /** 桌面本机工作区允许把内置资产复制为个人资产。 */
  canCopyBuiltin?: boolean;
  copyingBuiltinAssetId?: string | null;
}>(), {
  locked: false,
  maintenanceForbidden: false,
  beforeAssetChange: async () => true,
  toolbarTeleportTarget: "",
  canCopyBuiltin: false,
  copyingBuiltinAssetId: null,
});
const emit = defineEmits<{ (e: "copy-builtin", assetId: string): void }>();
const orch = useOrchestrationStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const searchText = ref("");
const exportModalOpen = ref(false);
const exportToolsetIds = ref<ToolsetId[]>([]);
const exporting = ref(false);
const assetGroups = useAssetGroups({ workspaceId: toRef(props, "workspaceId"), assetType: "toolset" });
const assetGroupBarRef = ref<InstanceType<typeof AssetGroupBar> | null>(null);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
const canImportBundles = computed(() => canImportRuleAssets(permissionInput.value));
const showCreateButton = computed(() => !props.maintenanceForbidden);
const showImportButton = computed(() => !props.maintenanceForbidden && (canImportBundles.value || props.locked));
const canExportBundles = computed(() => canExportSpecWorkflowRoleAssets(permissionInput.value));
const showExportButton = computed(() => !props.maintenanceForbidden && (canExportBundles.value || props.locked));
const canExportBuiltinToolset = computed(() => canExportBuiltinSpecToolset(permissionInput.value));
const exportableToolsetIdSet = computed(() =>
  new Set(
    orch.toolsets
      .filter((toolset) => !orch.assetListHostIds.toolset.includes(toolset.id) && (canExportBuiltinToolset.value || toolset.kind !== "builtin"))
      .map((toolset) => toolset.id),
  ),
);
const exportableToolsetCount = computed(() => exportableToolsetIdSet.value.size);
const allExportableToolsetSelected = computed(() => exportableToolsetCount.value > 0 && exportToolsetIds.value.length === exportableToolsetCount.value);
const { importInputRef, importing, triggerImport: triggerBundleImport, onImportFile } = useOrchAssetBundleImport({
  workspaceId: () => props.workspaceId,
  async onImported(imported) {
    if (imported.toolsets[0]) {
      await selectToolset(imported.toolsets[0].id);
      return;
    }
    if (imported.workflows[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedWorkflowId = imported.workflows[0].id;
      orch.setActiveTab("workflows");
    }
  },
});

const filteredToolsets = computed(() => {
  const q = searchText.value.toLowerCase();
  return orch.toolsets.filter((toolset) => assetGroups.matches(toolset) && (!q || toolset.name.toLowerCase().includes(q)));
});


watch(exportModalOpen, (open) => {
  if (!open) return;
  if (orch.selectedToolsetId && isToolsetExportable(orch.selectedToolsetId)) {
    exportToolsetIds.value = sanitizeExportToolsetIds([orch.selectedToolsetId]);
    return;
  }
  exportToolsetIds.value = sanitizeExportToolsetIds(orch.toolsets.map((item) => item.id));
});

/** 仅在当前账号具备权限时触发资产包导入。 */
async function triggerImport(): Promise<void> {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能导入工具");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canImportBundles.value) {
    message.warning("当前账号暂无规则资产导入权限");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  triggerBundleImport();
}

/** 打开工具导出弹窗，默认优先选中当前工具。 */
function openExportModal() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  if (!orch.toolsets.length) {
    message.info("当前还没有工具可导出");
    return;
  }
  if (!exportableToolsetCount.value) {
    message.info("当前账号仅可导出自定义工具，当前工作区没有可导出的自定义工具");
    return;
  }
  exportModalOpen.value = true;
}

/** 切换工具导出选择，非超管遇到内置工具时直接阻止。 */
function onExportToolsetToggle(event: Event, toolsetId: ToolsetId) {
  if (!isToolsetExportable(toolsetId)) {
    message.warning("内置工具仅超管可导出");
    return;
  }
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  const next = new Set(exportToolsetIds.value);
  if (checked) next.add(toolsetId);
  else next.delete(toolsetId);
  exportToolsetIds.value = sanitizeExportToolsetIds(orch.toolsets.map((item) => item.id).filter((id) => next.has(id)));
}

/** 在权限范围内全选或清空工具导出项。 */
function toggleAllExportToolsets(): void {
  exportToolsetIds.value = allExportableToolsetSelected.value
    ? []
    : sanitizeExportToolsetIds(orch.toolsets.map((item) => item.id));
}

/** 导出选中的工具资产包。 */
async function onExportBundle() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  const exportIds = sanitizeExportToolsetIds(exportToolsetIds.value);
  if (!exportIds.length) {
    message.warning("请至少选择一个工具");
    return;
  }
  exporting.value = true;
  try {
    const bundle = await orch.exportToolsetAssetBundle(ctx.value, props.workspaceId, exportIds);
    downloadBundle(bundle);
    exportModalOpen.value = false;
    message.success("工具资产包已导出");
    showAssetBundleWarningMessage(bundle.warnings);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "导出失败");
  } finally {
    exporting.value = false;
  }
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新工具列表：草稿与版本可能被其它入口改动，这里给一个显式重取入口。 */
async function refreshToolsetList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await orch.refreshToolsets(ctx.value, props.workspaceId);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : "刷新工具列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("工具列表已刷新");
}

async function createToolset() {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能维护工具定义");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  try {
    const saved = await orch.saveToolset(ctx.value, props.workspaceId, orch.createDefaultToolset(props.workspaceId));
    orch.selectedToolsetId = saved.id;
    message.success("工具已创建");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "新建工具失败");
  }
}

/** 选中工具前先交由父级处理未保存草稿。 */
async function selectToolset(toolsetId: ToolsetId): Promise<void> {
  if (orch.selectedToolsetId === toolsetId) return;
  if (!(await props.beforeAssetChange())) return;
  orch.selectedToolsetId = toolsetId;
  orch.setActiveTab("tools");
}

/** 下载导出的工具资产包。 */
function downloadBundle(bundle: OrchAssetBundle) {
  const payload = JSON.stringify(bundle, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFileName(bundle.title || "toolset-bundle") + ".json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 规整下载文件名，避免浏览器保存时报非法字符。 */
function safeFileName(raw: string): string {
  return String(raw ?? "").trim().replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "toolset-bundle";
}

/** 判断当前工具是否允许被当前账号导出。 */
function isToolsetExportable(toolsetId: ToolsetId): boolean {
  return exportableToolsetIdSet.value.has(toolsetId);
}

/** 清理导出列表，避免非超管误带出内置工具。 */
function sanitizeExportToolsetIds(toolsetIds: ToolsetId[]): ToolsetId[] {
  return toolsetIds.filter((toolsetId) => isToolsetExportable(toolsetId));
}

function onToolsetKeydown(toolsetId: ToolsetId, event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void selectToolset(toolsetId);
}

/** 打开工具删除确认，列表按钮和更多菜单共用。 */
function confirmDelete(toolsetId: ToolsetId, name: string, event?: Event) {
  event?.stopPropagation();
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能删除工具");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  const toolset = orch.toolsets.find((item) => item.id === toolsetId) ?? null;
  if (toolset?.kind === "builtin") {
    message.warning("内置工具不可删除");
    return;
  }
  Modal.confirm({
    title: "删除工具",
    content: `确认删除工具「${name}」？`,
    okText: "删除",
    cancelText: "取消",
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await orch.removeToolset(ctx.value, props.workspaceId, toolsetId);
        message.success("工具已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除失败");
      }
    },
  });
}
</script>

<template>
  <div class="tool-sidebar">
    <input ref="importInputRef" type="file" accept=".json,application/json" class="tool-sidebar__hidden-input" @change="onImportFile" />

    <Teleport defer :to="props.toolbarTeleportTarget || 'body'" :disabled="!props.toolbarTeleportTarget">
      <div class="tool-sidebar__search">
        <SearchOutlined class="tool-sidebar__search-icon" />
        <input v-model="searchText" class="tool-sidebar__search-input" placeholder="搜索工具..." />
        <div class="tool-sidebar__search-actions" aria-label="工具操作">
          <a-tooltip v-if="showCreateButton" title="新建自定义工具">
            <span class="tool-sidebar__tooltip-wrap">
              <button class="tool-sidebar__icon-action tool-sidebar__icon-action--primary" type="button" aria-label="新建自定义工具" :disabled="props.locked" @click="createToolset">
                <PlusOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showImportButton" :title="importing ? '导入中' : '导入工具资产'">
            <span class="tool-sidebar__tooltip-wrap">
              <button
                class="tool-sidebar__icon-action"
                type="button"
                :aria-label="importing ? '导入中' : '导入工具资产'"
                :disabled="props.locked || importing"
                @click="triggerImport"
              >
                <ImportOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showExportButton" title="导出工具资产">
            <span class="tool-sidebar__tooltip-wrap">
              <button
                class="tool-sidebar__icon-action"
                type="button"
                aria-label="导出工具资产"
                :disabled="props.locked"
                @click="openExportModal"
              >
                <ExportOutlined />
              </button>
            </span>
          </a-tooltip>
          <span class="tool-sidebar__tooltip-wrap">
            <button class="tool-sidebar__icon-action" type="button" aria-label="刷新工具列表" @click="refreshToolsetList">
              <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
              <Loading3QuartersOutlined v-if="refreshing" spin />
              <ReloadOutlined v-else />
            </button>
          </span>
        </div>
      </div>
    </Teleport>

    <AssetGroupBar ref="assetGroupBarRef" v-model="assetGroups.selectedGroup.value" :groups="assetGroups.groups.value" :loading="assetGroups.loading.value" :can-manage="!props.maintenanceForbidden" :load-groups="assetGroups.load" :create-group="assetGroups.create" :rename-group="assetGroups.rename" :delete-group="assetGroups.remove" :assign-group="assetGroups.assign" />

    <div class="tool-sidebar__list">
      <div v-if="orch.toolsetsLoading" class="tool-sidebar__empty">加载中...</div>
      <div
        v-for="toolset in filteredToolsets"
        :key="toolset.id"
        class="tool-sidebar__item"
        :class="{ 'tool-sidebar__item--selected': orch.selectedToolsetId === toolset.id }"
        @click="selectToolset(toolset.id)"
        @keydown="onToolsetKeydown(toolset.id, $event)"
        role="button"
        tabindex="0"
      >
        <span class="tool-sidebar__item-icon" aria-hidden="true"><ToolOutlined /></span>
        <div class="tool-sidebar__item-body">
          <div class="tool-sidebar__item-name">
            <span class="tool-sidebar__item-name-text">{{ toolset.name }}</span>
            <span
              class="tool-sidebar__item-kind"
              :class="{ 'tool-sidebar__item-kind--builtin': toolset.kind === 'builtin' }"
            >{{ toolset.kind === 'builtin' ? '内置' : '自定义' }}</span>
          </div>
          <div class="tool-sidebar__item-meta">{{ toolset.tools.length }} 个工具 · {{ toolset.description || "无描述" }}</div>
        </div>
        <a-tooltip v-if="props.canCopyBuiltin && toolset.kind === 'builtin'" title="复制为个人资产" placement="bottom">
          <button
            type="button"
            class="tool-sidebar__menu tool-sidebar__copy"
            :disabled="props.copyingBuiltinAssetId === toolset.id"
            :aria-label="`复制 ${toolset.name} 为个人资产`"
            @click.stop="emit('copy-builtin', toolset.id)"
          >
            <Loading3QuartersOutlined v-if="props.copyingBuiltinAssetId === toolset.id" spin />
            <CopyOutlined v-else />
          </button>
        </a-tooltip>
        <a-dropdown v-if="!props.maintenanceForbidden && !orch.assetListHostIds.toolset.includes(toolset.id) && toolset.kind !== 'builtin'" :trigger="['click']">
          <button type="button" class="tool-sidebar__menu" aria-label="更多" @click.stop>⋯</button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="assetGroupBarRef?.openMoveGroup(toolset)"><template #icon><SwapOutlined /></template>切换分组</a-menu-item>
              <a-menu-divider />
              <a-menu-item :disabled="props.locked" danger @click="confirmDelete(toolset.id, toolset.name)"><template #icon><DeleteOutlined /></template>删除</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
      <div v-if="!orch.toolsetsLoading && filteredToolsets.length === 0" class="tool-sidebar__empty">
        当前分组暂无工具
      </div>
    </div>

    <a-modal
      :open="exportModalOpen"
      title="导出工具资产包"
      :width="720"
      :footer="null"
      wrap-class-name="orch-asset-modal orch-asset-bundle-modal"
      @cancel="exportModalOpen = false"
    >
      <div class="tool-sidebar__bundle-modal">
        <div class="tool-sidebar__bundle-intro">
          <strong>批量导出工具</strong>
          <p>导出的 JSON 会带上所选工具定义，后续可在其他工作区一键导入。</p>
          <p v-if="!canExportBuiltinToolset" class="tool-sidebar__bundle-note">当前账号仅可导出自定义工具，内置工具仅超管可导出。</p>
        </div>

        <div class="tool-sidebar__bundle-toolbar">
          <button class="tool-sidebar__ghost-btn orch-action-btn" type="button" :disabled="!exportableToolsetCount" @click="toggleAllExportToolsets">
            {{ allExportableToolsetSelected ? "取消全选" : "全选" }}
          </button>
          <span>已选 {{ exportToolsetIds.length }} / {{ exportableToolsetCount }}</span>
        </div>

        <div class="tool-sidebar__bundle-list">
          <label
            v-for="toolset in orch.toolsets"
            :key="toolset.id"
            class="tool-sidebar__bundle-item"
            :class="{ 'tool-sidebar__bundle-item--disabled': !isToolsetExportable(toolset.id) }"
          >
            <input
              :checked="exportToolsetIds.includes(toolset.id)"
              type="checkbox"
              :disabled="!isToolsetExportable(toolset.id)"
              @change="onExportToolsetToggle($event, toolset.id)"
            />
            <div>
              <strong>
                {{ toolset.name }}
                <span v-if="toolset.kind === 'builtin'" class="tool-sidebar__bundle-tag">内置</span>
                <span v-if="toolset.kind === 'builtin' && !canExportBuiltinToolset" class="tool-sidebar__bundle-tag tool-sidebar__bundle-tag--warn">
                  仅超管可导出
                </span>
              </strong>
              <p>{{ toolset.tools.length }} 个工具</p>
            </div>
          </label>
        </div>

        <div class="tool-sidebar__bundle-footer">
          <button class="tool-sidebar__ghost-btn orch-action-btn" :disabled="exporting" @click="exportModalOpen = false">取消</button>
          <button class="orch-action-btn orch-action-btn--primary" :disabled="exporting" @click="onExportBundle">
            {{ exporting ? "导出中..." : "开始导出" }}
          </button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.tool-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.tool-sidebar__hidden-input { display:none; }
.tool-sidebar__ghost-btn {
  border-color: color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #334155);
}
.tool-sidebar__ghost-btn:hover,
.tool-sidebar__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
  color: var(--app-accent, #d97757);
}
.tool-sidebar__search {
  padding: 12px 14px 0;
}
.tool-sidebar__search-input {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  border-radius: 12px;
  font-size: 12px;
  outline: none;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #333);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03);
}
.tool-sidebar__search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}
.tool-sidebar__list {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 10px 10px;
}
.tool-sidebar__item {
  width: 100%;
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  padding: 7px 40px 7px 12px;
  text-align: left;
  cursor: pointer;
  margin-bottom: 2px;
  overflow: hidden;
  transition: background 100ms ease, border-color 100ms ease;
}
.tool-sidebar__item:hover {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
}
.tool-sidebar__item--selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}
.tool-sidebar__item.tool-sidebar__item--selected:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.tool-sidebar__item--selected .tool-sidebar__item-name {
  color: var(--app-accent);
  font-weight: 600;
}
.tool-sidebar__item-icon {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--app-accent);
  color: #fff;
  font-size: 13px;
}
.tool-sidebar__item-body {
  flex: 1 1 auto;
  min-width: 0;
}
.tool-sidebar__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.tool-sidebar__item-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-sidebar__item-meta {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #667085);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-sidebar__delete {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.tool-sidebar__menu { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); cursor: pointer; font-size: 18px; line-height: 1; opacity: 0; }
.tool-sidebar__item:hover .tool-sidebar__menu, .tool-sidebar__item--selected .tool-sidebar__menu { opacity: 1; }
.tool-sidebar__menu:hover { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 10%, transparent); }
/* 内置资产的复制入口常驻显示。 */
.tool-sidebar__copy { opacity: 1; font-size: 13px; }
.tool-sidebar__copy:disabled { cursor: not-allowed; opacity: .5; }
.tool-sidebar__item:hover .tool-sidebar__delete,
.tool-sidebar__item--selected .tool-sidebar__delete {
  opacity: 1;
}
.tool-sidebar__delete:hover {
  background: color-mix(in srgb, #ff4d4f 10%, transparent);
  color: #ff4d4f;
}
.tool-sidebar__delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
}
.tool-sidebar__item-kind {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-accent) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent) 68%, #1f2937);
  font-size: 10.5px;
  font-weight: 500;
  pointer-events: none;
}
.tool-sidebar__item-kind--builtin { background: color-mix(in srgb, var(--app-muted) 12%, transparent); color: var(--app-muted, #667085); }
.tool-sidebar__bundle-modal { display:flex; flex-direction:column; gap:16px; }
.tool-sidebar__bundle-intro {
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px 14px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
}
.tool-sidebar__bundle-intro strong { display:block; margin-bottom:4px; }
.tool-sidebar__bundle-intro p { margin:0; font-size:12px; line-height:1.7; color:var(--app-muted, #666); }
.tool-sidebar__bundle-note { color: color-mix(in srgb, var(--app-accent, #d97757) 72%, #7c2d12) !important; }
.tool-sidebar__bundle-toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
  color:var(--app-muted, #666);
}
.tool-sidebar__bundle-list {
  display:flex;
  flex-direction:column;
  gap:10px;
  max-height:min(52vh, 480px);
  overflow:auto;
  padding-right:4px;
}
.tool-sidebar__bundle-item {
  display:flex;
  align-items:flex-start;
  gap:10px;
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px;
  background:var(--app-bg, #fff);
}
.tool-sidebar__bundle-item--disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.tool-sidebar__bundle-item strong { display:block; font-size:13px; }
.tool-sidebar__bundle-item p { margin:4px 0 0; font-size:12px; color:var(--app-muted, #666); }
.tool-sidebar__bundle-tag {
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, #94a3b8 12%, #fff);
  color: #475569;
  font-size: 10px;
  font-weight: 600;
}
.tool-sidebar__bundle-tag--warn {
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
}
.tool-sidebar__bundle-footer { display:flex; justify-content:flex-end; gap:10px; }
.tool-sidebar__empty {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 12px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

:root[data-theme="dark"] .tool-sidebar__bundle-item,
:root[data-theme="dark"] .tool-sidebar__bundle-intro {
  border-color: rgba(255, 255, 255, 0.08);
}

:root[data-theme="dark"] .tool-sidebar__ghost-btn {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .tool-sidebar__ghost-btn:hover,
:root[data-theme="dark"] .tool-sidebar__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, #303030);
  background: color-mix(in srgb, var(--app-accent) 10%, #16181d);
  color: #ffd2c2;
}

:root[data-theme="dark"] .tool-sidebar__item {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

:root[data-theme="dark"] .tool-sidebar__item:hover {
  background: var(--app-sidebar-hover-bg);
}

:root[data-theme="dark"] .tool-sidebar__item--selected {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}
:root[data-theme="dark"] .tool-sidebar__item.tool-sidebar__item--selected:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .tool-sidebar__bundle-tag,
:root[data-theme="dark"] .tool-sidebar__item-kind {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}
:root[data-theme="dark"] .tool-sidebar__bundle-tag--warn {
  background: rgba(245, 158, 11, 0.16);
  color: #fbbf24;
}

:root[data-theme="dark"] .tool-sidebar__delete:hover {
  background: rgba(255, 77, 79, 0.14);
}

:root[data-theme="dark"] .tool-sidebar__search-input {
  border-color: rgba(255, 255, 255, 0.08);
  background: #16181d;
}
</style>
