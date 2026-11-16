<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CopyOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, Loading3QuartersOutlined, PlusOutlined, ReadOutlined, ReloadOutlined, SearchOutlined, SwapOutlined } from "@ant-design/icons-vue";
import { canExportBuiltinSpecKnowledgeBundle, canExportSpecWorkflowRoleAssets, canImportRuleAssets, type KnowledgeBundleDefinition, type KnowledgeBundleId, type OrchAssetBundle, type WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { showAssetBundleWarningMessage, useOrchAssetBundleImport } from "../composables/useOrchAssetBundleImport";
import { useAssetGroups } from "../composables/useAssetGroups";
import AssetGroupBar from "./asset-group-bar.vue";

defineOptions({ name: "KnowledgeBundleList" });

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
const exportKnowledgeBundleIds = ref<KnowledgeBundleId[]>([]);
const exporting = ref(false);
const assetGroups = useAssetGroups({ workspaceId: toRef(props, "workspaceId"), assetType: "knowledge" });
const assetGroupBarRef = ref<InstanceType<typeof AssetGroupBar> | null>(null);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
const filteredKnowledgeBundles = computed(() => {
  const q = searchText.value.toLowerCase();
  return orch.knowledgeBundles.filter((item) => assetGroups.matches(item) && (!q || item.name.toLowerCase().includes(q)));
});

const canImportBundles = computed(() => canImportRuleAssets(permissionInput.value));
const showCreateButton = computed(() => !props.maintenanceForbidden);
const showImportButton = computed(() => !props.maintenanceForbidden && (canImportBundles.value || props.locked));
const canExportBundles = computed(() => canExportSpecWorkflowRoleAssets(permissionInput.value));
const showExportButton = computed(() => !props.maintenanceForbidden && (canExportBundles.value || props.locked));
const canExportBuiltinKnowledgeBundle = computed(() => canExportBuiltinSpecKnowledgeBundle(permissionInput.value));
const exportableKnowledgeBundleIdSet = computed(() =>
  new Set(
    orch.knowledgeBundles
      .filter((bundle) => (canExportBuiltinKnowledgeBundle.value || bundle.kind !== "builtin"))
      .map((bundle) => bundle.id),
  ),
);
const exportableKnowledgeBundleCount = computed(() => exportableKnowledgeBundleIdSet.value.size);
const allExportableKnowledgeBundleSelected = computed(() =>
  exportableKnowledgeBundleCount.value > 0 && exportKnowledgeBundleIds.value.length === exportableKnowledgeBundleCount.value,
);
const { importInputRef, importing, triggerImport: triggerBundleImport, onImportFile } = useOrchAssetBundleImport({
  workspaceId: () => props.workspaceId,
  async onImported(imported) {
    if (imported.knowledgeBundles[0]) {
      await selectBundle(imported.knowledgeBundles[0].id);
      return;
    }
    if (imported.workflows[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedWorkflowId = imported.workflows[0].id;
      orch.setActiveTab("workflows");
    }
  },
});

watch(exportModalOpen, (open) => {
  if (!open) return;
  if (orch.selectedKnowledgeBundleId && isKnowledgeBundleExportable(orch.selectedKnowledgeBundleId)) {
    exportKnowledgeBundleIds.value = sanitizeExportKnowledgeBundleIds([orch.selectedKnowledgeBundleId]);
    return;
  }
  exportKnowledgeBundleIds.value = sanitizeExportKnowledgeBundleIds(orch.knowledgeBundles.map((item) => item.id));
});

/** 仅在当前账号具备权限时触发资产包导入。 */
async function triggerImport(): Promise<void> {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能导入知识库");
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

/** 打开知识库导出弹窗，默认优先选中当前知识库。 */
function openExportModal() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  if (!orch.knowledgeBundles.length) {
    message.info("当前还没有知识库可导出");
    return;
  }
  if (!exportableKnowledgeBundleCount.value) {
    message.info("当前账号仅可导出自定义知识库，当前工作区没有可导出的自定义知识库");
    return;
  }
  exportModalOpen.value = true;
}

/** 切换知识库导出选择，非超管遇到内置知识库时直接阻止。 */
function onExportKnowledgeBundleToggle(event: Event, bundleId: KnowledgeBundleId) {
  if (!isKnowledgeBundleExportable(bundleId)) {
    message.warning("内置知识库仅超管可导出");
    return;
  }
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  const next = new Set(exportKnowledgeBundleIds.value);
  if (checked) next.add(bundleId);
  else next.delete(bundleId);
  exportKnowledgeBundleIds.value = sanitizeExportKnowledgeBundleIds(orch.knowledgeBundles.map((item) => item.id).filter((id) => next.has(id)));
}

/** 在权限范围内全选或清空知识库导出项。 */
function toggleAllExportKnowledgeBundles(): void {
  exportKnowledgeBundleIds.value = allExportableKnowledgeBundleSelected.value
    ? []
    : sanitizeExportKnowledgeBundleIds(orch.knowledgeBundles.map((item) => item.id));
}

/** 导出选中的知识库资产包。 */
async function onExportBundle() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  const exportIds = sanitizeExportKnowledgeBundleIds(exportKnowledgeBundleIds.value);
  if (!exportIds.length) {
    message.warning("请至少选择一个知识库");
    return;
  }
  exporting.value = true;
  try {
    const bundle = await orch.exportKnowledgeAssetBundle(ctx.value, props.workspaceId, exportIds);
    downloadBundle(bundle);
    exportModalOpen.value = false;
    message.success("知识库资产包已导出");
    showAssetBundleWarningMessage(bundle.warnings);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "导出失败");
  } finally {
    exporting.value = false;
  }
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新知识库列表：草稿与版本可能被其它入口改动，这里给一个显式重取入口。 */
async function refreshKnowledgeList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await orch.refreshKnowledgeBundles(ctx.value, props.workspaceId);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : "刷新知识库列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("知识库列表已刷新");
}

async function createBundle() {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能维护知识库定义");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  try {
    const saved = await orch.saveKnowledgeBundle(
      ctx.value,
      props.workspaceId,
      orch.createDefaultKnowledgeBundle(props.workspaceId),
    );
    orch.selectedKnowledgeBundleId = saved.id;
    message.success("知识库已创建");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "创建知识库失败");
  }
}

/** 选中知识库前先交由父级处理未保存草稿。 */
async function selectBundle(bundleId: KnowledgeBundleId): Promise<void> {
  if (orch.selectedKnowledgeBundleId === bundleId) return;
  if (!(await props.beforeAssetChange())) return;
  orch.selectedKnowledgeBundleId = bundleId;
  orch.setActiveTab("knowledge");
}

/** 下载导出的知识库资产包。 */
function downloadBundle(bundle: OrchAssetBundle) {
  const payload = JSON.stringify(bundle, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFileName(bundle.title || "knowledge-bundle") + ".json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 规整下载文件名，避免浏览器保存时报非法字符。 */
function safeFileName(raw: string): string {
  return String(raw ?? "").trim().replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "knowledge-bundle";
}

/** 判断当前知识库是否允许被当前账号导出。 */
function isKnowledgeBundleExportable(bundleId: KnowledgeBundleId): boolean {
  return exportableKnowledgeBundleIdSet.value.has(bundleId);
}

/** 清理导出列表，避免非超管误带出内置知识库。 */
function sanitizeExportKnowledgeBundleIds(bundleIds: KnowledgeBundleId[]): KnowledgeBundleId[] {
  return bundleIds.filter((bundleId) => isKnowledgeBundleExportable(bundleId));
}

/** 打开知识库删除确认，列表按钮和更多菜单共用。 */
function confirmDelete(bundleId: KnowledgeBundleId, name: string, event?: Event) {
  event?.stopPropagation();
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能删除知识库");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  const bundle = orch.knowledgeBundles.find((item) => item.id === bundleId) ?? null;
  if (bundle?.kind === "builtin") {
    message.warning("内置知识库不可删除");
    return;
  }
  Modal.confirm({
    title: "删除知识库",
    content: `确定要删除「${name}」吗？`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        await orch.removeKnowledgeBundle(ctx.value, props.workspaceId, bundleId);
        message.success("知识库已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除失败");
      }
    },
  });
}
</script>

<template>
  <div class="kb-sidebar">
    <input ref="importInputRef" type="file" accept=".json,application/json" class="kb-sidebar__hidden-input" @change="onImportFile" />

    <Teleport defer :to="props.toolbarTeleportTarget || 'body'" :disabled="!props.toolbarTeleportTarget">
      <div class="kb-sidebar__search">
        <SearchOutlined class="kb-sidebar__search-icon" />
        <input v-model="searchText" placeholder="搜索知识库..." class="kb-sidebar__search-input" />
        <div class="kb-sidebar__search-actions" aria-label="知识库操作">
          <a-tooltip v-if="showCreateButton" title="新建自定义知识库">
            <span class="kb-sidebar__tooltip-wrap">
              <button class="kb-sidebar__icon-action kb-sidebar__icon-action--primary" type="button" aria-label="新建自定义知识库" :disabled="props.locked" @click="createBundle">
                <PlusOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showImportButton" :title="importing ? '导入中' : '导入知识库资产'">
            <span class="kb-sidebar__tooltip-wrap">
              <button
                class="kb-sidebar__icon-action"
                type="button"
                :aria-label="importing ? '导入中' : '导入知识库资产'"
                :disabled="props.locked || importing"
                @click="triggerImport"
              >
                <ImportOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showExportButton" title="导出知识库资产">
            <span class="kb-sidebar__tooltip-wrap">
              <button
                class="kb-sidebar__icon-action"
                type="button"
                aria-label="导出知识库资产"
                :disabled="props.locked"
                @click="openExportModal"
              >
                <ExportOutlined />
              </button>
            </span>
          </a-tooltip>
          <span class="kb-sidebar__tooltip-wrap">
            <button class="kb-sidebar__icon-action" type="button" aria-label="刷新知识库列表" @click="refreshKnowledgeList">
              <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
              <Loading3QuartersOutlined v-if="refreshing" spin />
              <ReloadOutlined v-else />
            </button>
          </span>
        </div>
      </div>
    </Teleport>

    <AssetGroupBar ref="assetGroupBarRef" v-model="assetGroups.selectedGroup.value" :groups="assetGroups.groups.value" :loading="assetGroups.loading.value" :can-manage="!props.maintenanceForbidden" :load-groups="assetGroups.load" :create-group="assetGroups.create" :rename-group="assetGroups.rename" :delete-group="assetGroups.remove" :assign-group="assetGroups.assign" />

    <div class="kb-sidebar__items">
      <div v-if="orch.knowledgeBundlesLoading" class="kb-sidebar__empty">加载中...</div>
      <div
        v-for="bundle in filteredKnowledgeBundles"
        :key="bundle.id"
        class="kb-sidebar__item"
        :class="{ 'kb-sidebar__item--selected': orch.selectedKnowledgeBundleId === bundle.id }"
        @click="selectBundle(bundle.id)"
      >
        <span class="kb-sidebar__item-icon" aria-hidden="true"><ReadOutlined /></span>
        <div class="kb-sidebar__item-body">
          <div class="kb-sidebar__item-name">
            <span class="kb-sidebar__item-name-text">{{ bundle.name }}</span>
            <span
              class="kb-sidebar__item-kind"
              :class="{ 'kb-sidebar__item-kind--builtin': bundle.kind === 'builtin' }"
            >{{ bundle.kind === 'builtin' ? '内置' : '自定义' }}</span>
          </div>
          <div class="kb-sidebar__item-meta">{{ bundle.scope }} · {{ bundle.sourceRefs.length }} 个来源</div>
        </div>
        <button
          v-if="props.canCopyBuiltin && bundle.kind === 'builtin'"
          type="button"
          class="kb-sidebar__item-menu kb-sidebar__item-copy"
          :disabled="props.copyingBuiltinAssetId === bundle.id"
          title="复制为个人资产"
          :aria-label="`复制 ${bundle.name} 为个人资产`"
          @click.stop="emit('copy-builtin', bundle.id)"
        >
          <Loading3QuartersOutlined v-if="props.copyingBuiltinAssetId === bundle.id" spin />
          <CopyOutlined v-else />
        </button>
        <a-dropdown v-if="!props.maintenanceForbidden && bundle.kind !== 'builtin'" :trigger="['click']">
          <button type="button" class="kb-sidebar__item-menu" aria-label="更多" @click.stop>⋯</button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="assetGroupBarRef?.openMoveGroup(bundle)"><template #icon><SwapOutlined /></template>切换分组</a-menu-item>
              <a-menu-divider />
              <a-menu-item :disabled="props.locked" danger @click="confirmDelete(bundle.id, bundle.name)"><template #icon><DeleteOutlined /></template>删除</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
      <div v-if="!orch.knowledgeBundlesLoading && filteredKnowledgeBundles.length === 0" class="kb-sidebar__empty">
        当前分组暂无知识库
      </div>
    </div>

    <a-modal
      :open="exportModalOpen"
      title="导出知识库资产包"
      :width="720"
      :footer="null"
      wrap-class-name="orch-asset-modal orch-asset-bundle-modal"
      @cancel="exportModalOpen = false"
    >
      <div class="kb-sidebar__bundle-modal">
        <div class="kb-sidebar__bundle-intro">
          <strong>批量导出知识库</strong>
          <p>导出的 JSON 会带上所选知识库定义，后续可在其他工作区一键导入。</p>
          <p v-if="!canExportBuiltinKnowledgeBundle" class="kb-sidebar__bundle-note">当前账号仅可导出自定义知识库，内置知识库仅超管可导出。</p>
        </div>

        <div class="kb-sidebar__bundle-toolbar">
          <button class="kb-sidebar__ghost-btn orch-action-btn" type="button" :disabled="!exportableKnowledgeBundleCount" @click="toggleAllExportKnowledgeBundles">
            {{ allExportableKnowledgeBundleSelected ? "取消全选" : "全选" }}
          </button>
          <span>已选 {{ exportKnowledgeBundleIds.length }} / {{ exportableKnowledgeBundleCount }}</span>
        </div>

        <div class="kb-sidebar__bundle-list">
          <label
            v-for="bundle in orch.knowledgeBundles"
            :key="bundle.id"
            class="kb-sidebar__bundle-item"
            :class="{ 'kb-sidebar__bundle-item--disabled': !isKnowledgeBundleExportable(bundle.id) }"
          >
            <input
              :checked="exportKnowledgeBundleIds.includes(bundle.id)"
              type="checkbox"
              :disabled="!isKnowledgeBundleExportable(bundle.id)"
              @change="onExportKnowledgeBundleToggle($event, bundle.id)"
            />
            <div>
              <strong>
                {{ bundle.name }}
                <span v-if="bundle.kind === 'builtin'" class="kb-sidebar__bundle-tag">内置</span>
                <span v-if="bundle.kind === 'builtin' && !canExportBuiltinKnowledgeBundle" class="kb-sidebar__bundle-tag kb-sidebar__bundle-tag--warn">
                  仅超管可导出
                </span>
              </strong>
              <p>{{ bundle.scope }} · {{ bundle.sourceRefs.length }} 个来源</p>
            </div>
          </label>
        </div>

        <div class="kb-sidebar__bundle-footer">
          <button class="kb-sidebar__ghost-btn orch-action-btn" :disabled="exporting" @click="exportModalOpen = false">取消</button>
          <button class="orch-action-btn orch-action-btn--primary" :disabled="exporting" @click="onExportBundle">
            {{ exporting ? "导出中..." : "开始导出" }}
          </button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.kb-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.kb-sidebar__hidden-input { display:none; }
.kb-sidebar__ghost-btn {
  border-color: color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #334155);
}
.kb-sidebar__ghost-btn:hover,
.kb-sidebar__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
  color: var(--app-accent, #d97757);
}
.kb-sidebar__search { padding: 12px 14px 0; }
.kb-sidebar__search-input {
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
.kb-sidebar__search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}
.kb-sidebar__items {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 10px;
}
.kb-sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 40px 7px 12px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  margin-bottom: 2px;
  overflow: hidden;
  transition: background 100ms ease, border-color 100ms ease;
}
.kb-sidebar__item:hover {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
}
.kb-sidebar__item--selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}
.kb-sidebar__item.kb-sidebar__item--selected:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.kb-sidebar__item--selected .kb-sidebar__item-name {
  color: var(--app-accent);
  font-weight: 600;
}

.kb-sidebar__item-icon {
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

.kb-sidebar__item-body {
  flex: 1 1 auto;
  min-width: 0;
}
.kb-sidebar__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.kb-sidebar__item-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-sidebar__item-meta {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #667085);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kb-sidebar__item-delete {
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
.kb-sidebar__item-menu { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); cursor: pointer; font-size: 18px; line-height: 1; opacity: 0; }
.kb-sidebar__item:hover .kb-sidebar__item-menu, .kb-sidebar__item--selected .kb-sidebar__item-menu { opacity: 1; }
.kb-sidebar__item-menu:hover { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 10%, transparent); }
/* 内置资产的复制入口常驻显示。 */
.kb-sidebar__item-copy { opacity: 1; font-size: 13px; }
.kb-sidebar__item-copy:disabled { cursor: not-allowed; opacity: .5; }
.kb-sidebar__item:hover .kb-sidebar__item-delete,
.kb-sidebar__item--selected .kb-sidebar__item-delete { opacity: 1; }
.kb-sidebar__item-delete:hover {
  background: color-mix(in srgb, #ff4d4f 10%, transparent);
  color: #ff4d4f;
}
.kb-sidebar__item-delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
}
.kb-sidebar__item-kind {
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
.kb-sidebar__item-kind--builtin { background: color-mix(in srgb, var(--app-muted) 12%, transparent); color: var(--app-muted, #667085); }
.kb-sidebar__bundle-modal { display:flex; flex-direction:column; gap:16px; }
.kb-sidebar__bundle-intro {
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px 14px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
}
.kb-sidebar__bundle-intro strong { display:block; margin-bottom:4px; }
.kb-sidebar__bundle-intro p { margin:0; font-size:12px; line-height:1.7; color:var(--app-muted, #666); }
.kb-sidebar__bundle-note { color: color-mix(in srgb, var(--app-accent, #d97757) 72%, #7c2d12) !important; }
.kb-sidebar__bundle-toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
  color:var(--app-muted, #666);
}
.kb-sidebar__bundle-list {
  display:flex;
  flex-direction:column;
  gap:10px;
  max-height:min(52vh, 480px);
  overflow:auto;
  padding-right:4px;
}
.kb-sidebar__bundle-item {
  display:flex;
  align-items:flex-start;
  gap:10px;
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px;
  background:var(--app-bg, #fff);
}
.kb-sidebar__bundle-item--disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.kb-sidebar__bundle-item strong { display:block; font-size:13px; }
.kb-sidebar__bundle-item p { margin:4px 0 0; font-size:12px; color:var(--app-muted, #666); }
.kb-sidebar__bundle-tag {
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
.kb-sidebar__bundle-tag--warn {
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
}
.kb-sidebar__bundle-footer { display:flex; justify-content:flex-end; gap:10px; }
.kb-sidebar__empty {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

:root[data-theme="dark"] .kb-sidebar__ghost-btn {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}
:root[data-theme="dark"] .kb-sidebar__ghost-btn:hover,
:root[data-theme="dark"] .kb-sidebar__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, #303030);
  background: color-mix(in srgb, var(--app-accent) 10%, #16181d);
  color: #ffd2c2;
}
:root[data-theme="dark"] .kb-sidebar__bundle-item,
:root[data-theme="dark"] .kb-sidebar__bundle-intro {
  border-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #30302e) 96%, #181614), color-mix(in srgb, var(--app-bg, #1f1e1d) 100%, #1f1e1d));
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}
:root[data-theme="dark"] .kb-sidebar__item {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
:root[data-theme="dark"] .kb-sidebar__item:hover {
  background: var(--app-sidebar-hover-bg);
}
:root[data-theme="dark"] .kb-sidebar__item--selected {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}
:root[data-theme="dark"] .kb-sidebar__item.kb-sidebar__item--selected:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}
:root[data-theme="dark"] .kb-sidebar__bundle-tag,
:root[data-theme="dark"] .kb-sidebar__item-kind {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}
:root[data-theme="dark"] .kb-sidebar__bundle-tag--warn {
  background: rgba(245, 158, 11, 0.16);
  color: #fbbf24;
}
:root[data-theme="dark"] .kb-sidebar__item-delete:hover {
  background: rgba(255, 77, 79, 0.14);
}
:root[data-theme="dark"] .kb-sidebar__search-input {
  border-color: rgba(255, 255, 255, 0.08);
  background: #16181d;
}
</style>
