<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { CopyOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, Loading3QuartersOutlined, PartitionOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SwapOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import {
  canCreateSpecWorkflow,
  canExportBuiltinSpecWorkflow,
  canExportSpecWorkflowRoleAssets,
  canImportSpecWorkflowRoleAssets,
  type OrchAssetBundle,
  type WorkflowDefinition,
  type WorkspaceId,
  type WorkflowId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { showAssetBundleWarningMessage, useOrchAssetBundleImport } from "../composables/useOrchAssetBundleImport";
import { useAssetGroups } from "../composables/useAssetGroups";
import { sortBuiltinFirst } from "../workflow-order";
import AssetGroupBar from "./asset-group-bar.vue";

defineOptions({ name: "WorkflowSidebar" });

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
const creatingWorkflow = ref(false);
const exportWorkflowIds = ref<WorkflowId[]>([]);
const exporting = ref(false);
const assetGroups = useAssetGroups({ workspaceId: toRef(props, "workspaceId"), assetType: "workflow" });
const assetGroupBarRef = ref<InstanceType<typeof AssetGroupBar> | null>(null);

/** 列表只做展示层排序：内置流程排最前，两段内部沿用数据源原有顺序。 */
const sortedWorkflows = computed(() => sortBuiltinFirst(orch.workflows));
const filteredWorkflows = computed(() =>
  sortedWorkflows.value.filter((workflow) => assetGroups.matches(workflow) && (!searchText.value || workflow.name.toLowerCase().includes(searchText.value.toLowerCase()))),
);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
const canCreateWorkflow = computed(() =>
  isDesktopWorkspace(config, props.workspaceId) || canCreateSpecWorkflow(permissionInput.value),
);
const canImportBundles = computed(() => canImportSpecWorkflowRoleAssets(permissionInput.value));
const canExportBundles = computed(() => canExportSpecWorkflowRoleAssets(permissionInput.value));
const showCreateButton = computed(() => !props.maintenanceForbidden && (canCreateWorkflow.value || props.locked));
const showImportButton = computed(() => !props.maintenanceForbidden && (canImportBundles.value || props.locked));
const showExportButton = computed(() => !props.maintenanceForbidden && (canExportBundles.value || props.locked));
const isSuperAdmin = computed(() => config.accountRole === "super_admin");
const canExportBuiltinWorkflow = computed(() => canExportBuiltinSpecWorkflow(permissionInput.value));
const exportableWorkflowIdSet = computed(() =>
  new Set(
    orch.workflows
      .filter((workflow) => !orch.assetListHostIds.workflow.includes(workflow.id) && (canExportBuiltinWorkflow.value || workflow.kind !== "builtin"))
      .map((workflow) => workflow.id),
  ),
);
const exportableWorkflowCount = computed(() => exportableWorkflowIdSet.value.size);
const allExportableWorkflowSelected = computed(() => exportableWorkflowCount.value > 0 && exportWorkflowIds.value.length === exportableWorkflowCount.value);
const { importInputRef, importing, triggerImport: triggerBundleImport, onImportFile } = useOrchAssetBundleImport({
  workspaceId: () => props.workspaceId,
  async onImported(imported) {
    if (imported.workflows[0]) {
      await selectWorkflow(imported.workflows[0].id);
      return;
    }
    if (imported.roles[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedRoleId = imported.roles[0].id;
      orch.setActiveTab("roles");
      return;
    }
    if (imported.knowledgeBundles[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedKnowledgeBundleId = imported.knowledgeBundles[0].id;
      orch.setActiveTab("knowledge");
      return;
    }
    if (imported.toolsets[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedToolsetId = imported.toolsets[0].id;
      orch.setActiveTab("tools");
    }
  },
});

watch(exportModalOpen, (open) => {
  if (!open) return;
  if (orch.selectedWorkflowId) {
    exportWorkflowIds.value = sanitizeExportWorkflowIds([orch.selectedWorkflowId]);
    return;
  }
  exportWorkflowIds.value = sanitizeExportWorkflowIds(orch.workflows.map((item) => item.id));
});

/** 选中流程前先交由父级处理未保存草稿。 */
async function selectWorkflow(id: WorkflowId): Promise<void> {
  if (orch.selectedWorkflowId === id) return;
  if (!(await props.beforeAssetChange())) return;
  orch.selectedWorkflowId = id;
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新流程列表：草稿与版本可能被其它入口改动，这里给一个显式重取入口。 */
async function refreshWorkflowList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await orch.refreshWorkflows(ctx.value, props.workspaceId);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : "刷新流程列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("流程列表已刷新");
}

/** 新建流程模板；协作/独立由需求启动时选择，不写入模板。 */
async function createWorkflow() {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能维护流程模板定义");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canCreateWorkflow.value) {
    message.warning("当前账号暂无流程模板新建权限");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  if (creatingWorkflow.value) return;
  creatingWorkflow.value = true;
  try {
    const workflow = await orch.saveWorkflow(ctx.value, props.workspaceId, {
      id: "" as WorkflowId,
      workspaceId: props.workspaceId,
      name: "新工作流",
      description: "",
      nodes: [
        { id: "start", type: "start", label: "START", position: { x: 250, y: 0 } },
        { id: "end", type: "end", label: "END", position: { x: 250, y: 200 } },
      ],
      edges: [{ id: "edge-start-end", sourceNodeId: "start", targetNodeId: "end", dataMappings: [] }],
      version: 1,
    });
    orch.selectedWorkflowId = workflow.id;
    orch.setActiveTab("workflows");
    message.success("流程模板已创建");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "创建失败");
  } finally {
    creatingWorkflow.value = false;
  }
}

/** 打开工作流删除确认，列表按钮和更多菜单共用。 */
function confirmDelete(id: WorkflowId, name: string, ev?: Event) {
  ev?.stopPropagation();
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能删除流程模板");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  const workflow = orch.workflows.find((item) => item.id === id) ?? null;
  if (workflow?.kind === "builtin" && !isSuperAdmin.value) {
    message.warning("内置流程模板不可删除");
    return;
  }
  Modal.confirm({
    title: "删除流程模板",
    content: `确定要删除「${name}」吗？会同时移除会话中引用该流程的工作流卡片。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        await orch.removeWorkflow(ctx.value, props.workspaceId, id);
        message.success("流程模板已删除");
      } catch (e) {
        message.error(e instanceof Error ? e.message : "删除失败");
      }
    },
  });
}

function openExportModal() {
  if (props.maintenanceForbidden) {
    message.warning("共享工作区成员不能导出资产包或克隆到个人私域自改");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无流程/角色资产导出权限");
    return;
  }
  if (!orch.workflows.length) {
    message.info("当前还没有流程模板可导出");
    return;
  }
  if (!exportableWorkflowCount.value) {
    message.info("当前账号仅可导出自定义流程，当前工作区没有可导出的自定义流程");
    return;
  }
  exportModalOpen.value = true;
}

function onExportWorkflowToggle(event: Event, workflowId: WorkflowId) {
  if (!isWorkflowExportable(workflowId)) {
    message.warning("内置流程仅超管可导出");
    return;
  }
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  const next = new Set(exportWorkflowIds.value);
  if (checked) next.add(workflowId);
  else next.delete(workflowId);
  exportWorkflowIds.value = sanitizeExportWorkflowIds(orch.workflows.map((item) => item.id).filter((id) => next.has(id)));
}

/** 在权限范围内全选或清空流程导出项。 */
function toggleAllExportWorkflows(): void {
  exportWorkflowIds.value = allExportableWorkflowSelected.value
    ? []
    : sanitizeExportWorkflowIds(orch.workflows.map((item) => item.id));
}

async function onExportBundle() {
  if (props.maintenanceForbidden) {
    message.warning("共享工作区成员不能导出资产包或克隆到个人私域自改");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无流程/角色资产导出权限");
    return;
  }
  const exportIds = sanitizeExportWorkflowIds(exportWorkflowIds.value);
  if (!exportIds.length) {
    message.warning("请至少选择一个流程模板");
    return;
  }
  exporting.value = true;
  try {
    const bundle = await orch.exportWorkflowBundle(ctx.value, props.workspaceId, exportIds);
    downloadBundle(bundle);
    exportModalOpen.value = false;
    message.success("流程资产包已导出");
    showAssetBundleWarningMessage(bundle.warnings);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "导出失败");
  } finally {
    exporting.value = false;
  }
}

/** 导入前先确认当前编辑草稿，避免导入后切换丢失修改。 */
async function triggerImport(): Promise<void> {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能导入流程/角色资产");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canImportBundles.value) {
    message.warning("当前账号暂无流程/角色资产导入权限");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  triggerBundleImport();
}

function downloadBundle(bundle: OrchAssetBundle) {
  const payload = JSON.stringify(bundle, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(bundle.title || "workflow-bundle")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(raw: string): string {
  return String(raw ?? "").trim().replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workflow-bundle";
}

/** 判断当前流程是否可被当前账号导出。 */
function isWorkflowExportable(workflowId: WorkflowId): boolean {
  return exportableWorkflowIdSet.value.has(workflowId);
}

/** 清理导出列表，避免非超管误把内置流程带入请求。 */
function sanitizeExportWorkflowIds(workflowIds: WorkflowId[]): WorkflowId[] {
  return workflowIds.filter((workflowId) => isWorkflowExportable(workflowId));
}

/** 判断流程是否可用于新编排；资产库详情始终允许查看。 */
function isWorkflowAvailable(workflow: unknown): boolean {
  const availability = (workflow as { availability?: { available?: boolean } | null } | null | undefined)?.availability;
  return availability?.available !== false;
}
</script>

<template>
  <div class="wf-sidebar">
    <input ref="importInputRef" type="file" accept=".json,application/json" class="wf-sidebar__hidden-input" @change="onImportFile" />

    <Teleport defer :to="props.toolbarTeleportTarget || 'body'" :disabled="!props.toolbarTeleportTarget">
      <div class="wf-sidebar__search">
        <SearchOutlined class="wf-sidebar__search-icon" />
        <input v-model="searchText" placeholder="搜索模板..." class="wf-sidebar__search-input" />
        <div class="wf-sidebar__search-actions" aria-label="流程操作">
          <a-tooltip v-if="showCreateButton" :title="creatingWorkflow ? '创建中' : '新建自定义流程'">
            <span class="wf-sidebar__tooltip-wrap">
              <button class="wf-sidebar__icon-action wf-sidebar__icon-action--primary" type="button" :aria-label="creatingWorkflow ? '创建中' : '新建自定义流程'" :disabled="props.locked || creatingWorkflow" @click="createWorkflow">
                <PlusOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showImportButton" :title="importing ? '导入中' : '导入流程资产'">
            <span class="wf-sidebar__tooltip-wrap">
              <button
                class="wf-sidebar__icon-action"
                type="button"
                :aria-label="importing ? '导入中' : '导入流程资产'"
                :disabled="props.locked || importing"
                @click="triggerImport"
              >
                <ImportOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showExportButton" title="导出流程资产">
            <span class="wf-sidebar__tooltip-wrap">
              <button
                class="wf-sidebar__icon-action"
                type="button"
                aria-label="导出流程资产"
                :disabled="props.locked"
                @click="openExportModal"
              >
                <ExportOutlined />
              </button>
            </span>
          </a-tooltip>
          <span class="wf-sidebar__tooltip-wrap">
            <button class="wf-sidebar__icon-action" type="button" aria-label="刷新流程列表" @click="refreshWorkflowList">
              <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
              <Loading3QuartersOutlined v-if="refreshing" spin />
              <ReloadOutlined v-else />
            </button>
          </span>
        </div>
      </div>
    </Teleport>

    <AssetGroupBar
      ref="assetGroupBarRef"
      v-model="assetGroups.selectedGroup.value"
      :groups="assetGroups.groups.value"
      :loading="assetGroups.loading.value"
      :can-manage="!props.maintenanceForbidden"
      :load-groups="assetGroups.load"
      :create-group="assetGroups.create"
      :rename-group="assetGroups.rename"
      :delete-group="assetGroups.remove"
      :assign-group="assetGroups.assign"
    />

    <div class="wf-sidebar__items">
      <div v-if="orch.workflowsLoading && !filteredWorkflows.length" class="wf-sidebar__loading">加载中...</div>
      <div
        v-for="wf in filteredWorkflows"
        :key="wf.id"
        class="wf-sidebar__item"
        :class="{
          'wf-sidebar__item--selected': orch.selectedWorkflowId === wf.id,
          'wf-sidebar__item--disabled': !isWorkflowAvailable(wf),
        }"
        @click="selectWorkflow(wf.id)"
      >
        <span class="wf-sidebar__item-icon" aria-hidden="true"><PartitionOutlined /></span>
        <div class="wf-sidebar__item-body">
          <div class="wf-sidebar__item-name">
            <span class="wf-sidebar__item-name-text">{{ wf.name }}</span>
            <span class="wf-sidebar__item-tags">
              <span class="wf-sidebar__item-kind" :class="wf.kind === 'builtin' ? 'wf-sidebar__item-kind--builtin' : ''">{{ wf.kind === 'builtin' ? '内置' : '自定义' }}</span>
              <span v-if="!isWorkflowAvailable(wf)" class="wf-sidebar__item-status">已到期</span>
            </span>
          </div>
          <div class="wf-sidebar__item-meta">v{{ wf.version }} · {{ wf.nodes.filter(n => n.type === 'role').length }} 个执行节点</div>
        </div>
        <button
          v-if="props.canCopyBuiltin && wf.kind === 'builtin'"
          type="button"
          class="wf-sidebar__item-menu wf-sidebar__item-copy"
          :disabled="props.copyingBuiltinAssetId === wf.id"
          title="复制为个人资产"
          :aria-label="`复制 ${wf.name} 为个人资产`"
          @click.stop="emit('copy-builtin', wf.id)"
        >
          <Loading3QuartersOutlined v-if="props.copyingBuiltinAssetId === wf.id" spin />
          <CopyOutlined v-else />
        </button>
        <a-dropdown v-if="!props.maintenanceForbidden && !orch.assetListHostIds.workflow.includes(wf.id) && wf.kind !== 'builtin'" :trigger="['click']">
          <button type="button" class="wf-sidebar__item-menu" aria-label="更多" @click.stop>⋯</button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="assetGroupBarRef?.openMoveGroup(wf)"><template #icon><SwapOutlined /></template>切换分组</a-menu-item>
              <a-menu-divider />
              <a-menu-item :disabled="props.locked" danger @click="confirmDelete(wf.id, wf.name)"><template #icon><DeleteOutlined /></template>删除</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <button v-else-if="!props.maintenanceForbidden && !orch.assetListHostIds.workflow.includes(wf.id) && isSuperAdmin" class="wf-sidebar__item-delete" :disabled="props.locked" @click="confirmDelete(wf.id, wf.name, $event)"><DeleteOutlined /></button>
      </div>
      <div v-if="!orch.workflowsLoading && filteredWorkflows.length === 0" class="wf-sidebar__empty">
        当前分组暂无流程模板
      </div>
    </div>

    <a-modal
      :open="exportModalOpen"
      title="导出流程资产包"
      :width="760"
      :footer="null"
      wrap-class-name="orch-asset-modal orch-asset-bundle-modal"
      @cancel="exportModalOpen = false"
    >
      <div class="wf-sidebar__bundle-modal">
        <div class="wf-sidebar__bundle-intro">
          <strong>批量导出流程模板及其依赖</strong>
          <p>导出的 JSON 会自动带上所选流程模板依赖的角色、知识库和工具，后续可在其他工作区一键导入。</p>
          <p v-if="!canExportBuiltinWorkflow" class="wf-sidebar__bundle-note">当前账号仅可导出自定义流程，内置流程仅超管可导出。</p>
        </div>

        <div class="wf-sidebar__bundle-toolbar">
          <button class="wf-sidebar__ghost-btn orch-action-btn" type="button" :disabled="!exportableWorkflowCount" @click="toggleAllExportWorkflows">
            {{ allExportableWorkflowSelected ? "取消全选" : "全选" }}
          </button>
          <span>已选 {{ exportWorkflowIds.length }} / {{ exportableWorkflowCount }}</span>
        </div>

        <div class="wf-sidebar__bundle-list">
          <label
            v-for="wf in sortedWorkflows"
            :key="wf.id"
            class="wf-sidebar__bundle-item"
            :class="{ 'wf-sidebar__bundle-item--disabled': !isWorkflowExportable(wf.id) }"
          >
            <input
              :checked="exportWorkflowIds.includes(wf.id)"
              type="checkbox"
              :disabled="!isWorkflowExportable(wf.id)"
              @change="onExportWorkflowToggle($event, wf.id)"
            />
            <div>
              <strong>
                {{ wf.name }}
                <span v-if="wf.kind === 'builtin'" class="wf-sidebar__bundle-tag">内置</span>
                <span v-if="wf.kind === 'builtin' && !canExportBuiltinWorkflow" class="wf-sidebar__bundle-tag wf-sidebar__bundle-tag--warn">
                  仅超管可导出
                </span>
              </strong>
              <p>v{{ wf.version }} · {{ wf.nodes.filter(n => n.type === 'role').length }} 个执行节点</p>
            </div>
          </label>
        </div>

        <div class="wf-sidebar__bundle-footer">
          <button class="wf-sidebar__ghost-btn orch-action-btn" :disabled="exporting" @click="exportModalOpen = false">取消</button>
          <button class="wf-sidebar__add-btn orch-action-btn orch-action-btn--primary" :disabled="exporting" @click="onExportBundle">
            {{ exporting ? "导出中..." : "开始导出" }}
          </button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.wf-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.wf-sidebar__hidden-input { display:none; }
.wf-sidebar__search { padding: 12px 14px 0; }
.wf-sidebar__search-input {
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
.wf-sidebar__search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}
.wf-sidebar__items {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 10px;
}
.wf-sidebar__item {
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
.wf-sidebar__item:hover {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
}
.wf-sidebar__item--selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}
.wf-sidebar__item.wf-sidebar__item--selected:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}
.wf-sidebar__item--disabled {
  opacity: 0.72;
}

.wf-sidebar__item--selected .wf-sidebar__item-name {
  color: var(--app-accent);
  font-weight: 600;
}
.wf-sidebar__item-icon {
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
.wf-sidebar__item-body {
  flex: 1 1 auto;
  min-width: 0;
}
.wf-sidebar__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.wf-sidebar__item-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-sidebar__item-meta {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #667085);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-sidebar__item-tags {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 6px;
  pointer-events: none;
  transition: opacity 0.16s ease;
}
.wf-sidebar__item-delete {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.wf-sidebar__item-menu { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); cursor: pointer; font-size: 18px; line-height: 1; opacity: 0; }
.wf-sidebar__item:hover .wf-sidebar__item-menu, .wf-sidebar__item--selected .wf-sidebar__item-menu { opacity: 1; }
.wf-sidebar__item-menu:hover { background: color-mix(in srgb, var(--app-primary) 10%, transparent); color: var(--app-primary); }
/* 内置资产的复制入口常驻显示，避免必须悬停才能发现。 */
.wf-sidebar__item-copy { opacity: 1; font-size: 13px; }
.wf-sidebar__item-copy:disabled { cursor: not-allowed; opacity: .5; }
.wf-sidebar__item:hover .wf-sidebar__item-delete,
.wf-sidebar__item--selected .wf-sidebar__item-delete { opacity: 1; }
.wf-sidebar__item-delete:hover {
  background: color-mix(in srgb, #ff4d4f 10%, transparent);
  color: #ff4d4f;
}
.wf-sidebar__item-delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
}
.wf-sidebar__item-kind {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-accent) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent) 68%, #1f2937);
  font-size: 10.5px;
  font-weight: 500;
}
.wf-sidebar__item-kind--builtin { background: color-mix(in srgb, var(--app-muted) 12%, transparent); color: var(--app-muted, #667085); }
/* 列表加载态只占一行，避免切换 Tab 时插入整块居中占位把列表顶下去。 */
.wf-sidebar__loading {
  padding: 12px 12px 14px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 12px;
}
.wf-sidebar__empty {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}
.wf-sidebar__bundle-modal { display:flex; flex-direction:column; gap:16px; }
.wf-sidebar__bundle-intro {
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px 14px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
}
.wf-sidebar__bundle-intro strong { display:block; margin-bottom:4px; }
.wf-sidebar__bundle-intro p { margin:0; font-size:12px; line-height:1.7; color:var(--app-muted, #666); }
.wf-sidebar__bundle-note { color: color-mix(in srgb, var(--app-accent, #d97757) 72%, #7c2d12) !important; }
.wf-sidebar__bundle-toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
  color:var(--app-muted, #666);
}
.wf-sidebar__bundle-list {
  display:flex;
  flex-direction:column;
  gap:10px;
  max-height:min(52vh, 480px);
  overflow:auto;
  padding-right:4px;
}
.wf-sidebar__bundle-item {
  display:flex;
  align-items:flex-start;
  gap:10px;
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px;
  background:var(--app-bg, #fff);
}
.wf-sidebar__bundle-item--disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.wf-sidebar__bundle-item strong { display:block; font-size:13px; }
.wf-sidebar__bundle-item p { margin:4px 0 0; font-size:12px; color:var(--app-muted, #666); }
.wf-sidebar__bundle-tag {
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
.wf-sidebar__item-status {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
  font-size: 10.5px;
  font-weight: 500;
}
.wf-sidebar__bundle-tag--warn {
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
}
.wf-sidebar__bundle-footer { display:flex; justify-content:flex-end; gap:10px; }

:root[data-theme="dark"] .wf-sidebar__bundle-item,
:root[data-theme="dark"] .wf-sidebar__bundle-intro {
  border-color: rgba(255, 255, 255, 0.08);
}
:root[data-theme="dark"] .wf-sidebar__item {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}
:root[data-theme="dark"] .wf-sidebar__item:hover {
  background: var(--app-sidebar-hover-bg);
}
:root[data-theme="dark"] .wf-sidebar__item--selected {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}
:root[data-theme="dark"] .wf-sidebar__item.wf-sidebar__item--selected:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}
:root[data-theme="dark"] .wf-sidebar__item-kind {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}
:root[data-theme="dark"] .wf-sidebar__item-status {
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
}
:root[data-theme="dark"] .wf-sidebar__item-delete:hover {
  background: rgba(255, 77, 79, 0.14);
}
:root[data-theme="dark"] .wf-sidebar__search-input {
  border-color: rgba(255, 255, 255, 0.08);
  background: #16181d;
}
</style>
