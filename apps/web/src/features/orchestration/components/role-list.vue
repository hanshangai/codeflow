<script setup lang="ts">
import { ref, computed, toRef, watch } from "vue";
import { CopyOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, Loading3QuartersOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SwapOutlined, TeamOutlined } from "@ant-design/icons-vue";
import { message, Modal } from "ant-design-vue";
import {
  canCreateSpecRole,
  canExportBuiltinSpecRole,
  canExportSpecWorkflowRoleAssets,
  canImportSpecWorkflowRoleAssets,
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchAssetBundle,
  type WorkspaceId,
  type RoleId,
  type RoleDefinition,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { showAssetBundleWarningMessage, useOrchAssetBundleImport } from "../composables/useOrchAssetBundleImport";
import { useAssetGroups } from "../composables/useAssetGroups";
import AssetGroupBar from "./asset-group-bar.vue";

defineOptions({ name: "RoleList" });

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
const exportRoleIds = ref<RoleId[]>([]);
const exporting = ref(false);
const assetGroups = useAssetGroups({ workspaceId: toRef(props, "workspaceId"), assetType: "role" });
const assetGroupBarRef = ref<InstanceType<typeof AssetGroupBar> | null>(null);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));

const filteredRoles = computed(() => {
  const q = searchText.value.toLowerCase();
  return orch.roles.filter((r) => assetGroups.matches(r) && (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)));
});


const CAPABILITY_MARKER = /\u80fd\u529b\u4e0e\u4ef7\u503c[:\uff1a]/;

/** Return the first description line so capability details stay inside the role description. */
function roleDescriptionSummary(description: string | null | undefined): string {
  const text = String(description ?? "").trim();
  const markerIndex = text.search(CAPABILITY_MARKER);
  const summaryText = markerIndex >= 0 ? text.slice(0, markerIndex) : text;
  return summaryText.split(/\r?\n/).find((line) => line.trim())?.trim() || "\u6682\u65e0\u63cf\u8ff0";
}

/** 汇总角色公开能力标签，保持列表信息密度但不展开内部提示词。 */
function roleCapabilityTags(role: RoleDefinition): string[] {
  const tags = [roleDeliveryTag(role)];
  const inputCount = role.inputDefinition.requiredFields.length;
  const outputCount = roleOutputItemCount(role);
  const capabilityCount = (role.defaultKnowledgeBundleIds ?? []).length
    + (role.defaultSkillIds ?? []).length
    + (role.toolRefs ?? []).length;
  if (inputCount > 0) tags.push(`输入 ${inputCount}`);
  if (outputCount > 0) tags.push(`输出 ${outputCount}`);
  if (capabilityCount > 0) tags.push(`能力 ${capabilityCount}`);
  return tags.slice(0, 4);
}

/** 返回角色交付方式的短标签。 */
function roleDeliveryTag(role: RoleDefinition): string {
  if (role.outputDefinition.deliveryMode === "file-set") return "多文件";
  if (role.outputDefinition.deliveryMode === "file") return "单文件";
  return "直接输出";
}

/** 统计角色对外可感知的交付项数量。 */
function roleOutputItemCount(role: RoleDefinition): number {
  const output = role.outputDefinition;
  if (output.deliveryMode === "direct") return Math.max(1, output.requiredFields.length);
  return Math.max(output.files?.length ?? 0, output.requiredFields.length);
}
const canCreateRole = computed(() => isDesktopWorkspace(config, props.workspaceId) || canCreateSpecRole(permissionInput.value));
const canImportBundles = computed(() => canImportSpecWorkflowRoleAssets(permissionInput.value));
const canExportBundles = computed(() => canExportSpecWorkflowRoleAssets(permissionInput.value));
const showCreateButton = computed(() => !props.maintenanceForbidden && (canCreateRole.value || props.locked));
const showImportButton = computed(() => !props.maintenanceForbidden && (canImportBundles.value || props.locked));
const showExportButton = computed(() => !props.maintenanceForbidden && (canExportBundles.value || props.locked));
const canExportBuiltinRole = computed(() => canExportBuiltinSpecRole(permissionInput.value));
const exportableRoleIdSet = computed(() =>
  new Set(
    orch.roles
      .filter((role) => (canExportBuiltinRole.value || role.kind !== "builtin"))
      .map((role) => role.id),
  ),
);
const exportableRoleCount = computed(() => exportableRoleIdSet.value.size);
const allExportableRoleSelected = computed(() => exportableRoleCount.value > 0 && exportRoleIds.value.length === exportableRoleCount.value);
const { importInputRef, importing, triggerImport: triggerBundleImport, onImportFile } = useOrchAssetBundleImport({
  workspaceId: () => props.workspaceId,
  async onImported(imported) {
    if (imported.roles[0]) {
      await selectRole(imported.roles[0].id);
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
  if (orch.selectedRoleId && isRoleExportable(orch.selectedRoleId)) {
    exportRoleIds.value = sanitizeExportRoleIds([orch.selectedRoleId]);
    return;
  }
  exportRoleIds.value = sanitizeExportRoleIds(orch.roles.map((item) => item.id));
});

/** 选中角色前先交由父级处理未保存草稿。 */
async function selectRole(roleId: RoleId): Promise<void> {
  if (orch.selectedRoleId === roleId) return;
  if (!(await props.beforeAssetChange())) return;
  orch.selectedRoleId = roleId;
  orch.setActiveTab("roles");
}

/** 仅在当前账号具备权限时触发资产包导入。 */
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

/** 打开角色导出弹窗，默认优先选中当前角色。 */
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
  if (!orch.roles.length) {
    message.info("当前还没有角色可导出");
    return;
  }
  if (!exportableRoleCount.value) {
    message.info("当前账号仅可导出自定义角色，当前工作区没有可导出的自定义角色");
    return;
  }
  exportModalOpen.value = true;
}

/** 切换角色导出选择，非超管遇到内置角色时直接阻止。 */
function onExportRoleToggle(event: Event, roleId: RoleId) {
  if (!isRoleExportable(roleId)) {
    message.warning("内置角色仅超管可导出");
    return;
  }
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  const next = new Set(exportRoleIds.value);
  if (checked) next.add(roleId);
  else next.delete(roleId);
  exportRoleIds.value = sanitizeExportRoleIds(orch.roles.map((item) => item.id).filter((id) => next.has(id)));
}

/** 在权限范围内全选或清空角色导出项。 */
function toggleAllExportRoles(): void {
  exportRoleIds.value = allExportableRoleSelected.value
    ? []
    : sanitizeExportRoleIds(orch.roles.map((item) => item.id));
}

/** 导出选中的角色资产包，并自动附带依赖资产。 */
async function onExportBundle() {
  if (props.maintenanceForbidden) {
    message.warning("共享工作区成员不能导出资产包或克隆到个人私域自改");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无流程/角色资产导出权限");
    return;
  }
  const exportIds = sanitizeExportRoleIds(exportRoleIds.value);
  if (!exportIds.length) {
    message.warning("请至少选择一个角色");
    return;
  }
  exporting.value = true;
  try {
    const bundle = await orch.exportRoleBundle(ctx.value, props.workspaceId, exportIds);
    downloadBundle(bundle);
    exportModalOpen.value = false;
    message.success("角色资产包已导出");
    showAssetBundleWarningMessage(bundle.warnings);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "导出失败");
  } finally {
    exporting.value = false;
  }
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新 Agent 列表：草稿与版本可能被其它入口改动，这里给一个显式重取入口。 */
async function refreshRoleList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await orch.refreshRoles(ctx.value, props.workspaceId);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : "刷新 Agent 列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("Agent 列表已刷新");
}

async function createRole() {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能维护角色定义");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canCreateRole.value) {
    message.warning("当前账号暂无角色新建权限");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  try {
    const role = await orch.saveRole(ctx.value, props.workspaceId, {
      id: "" as RoleId,
      workspaceId: props.workspaceId,
      name: "新角色",
      description: "负责某一类稳定工程动作的专业角色。",
      responsibility: "只在自己的职责边界内处理当前节点任务，并把结果交代清楚。",
      systemPrompt: [
        "您是软件工程编排中的专业角色，必须先理解当前节点目标、上游输入和约束，再开始执行。",
        "不要假装完成未验证的工作；如果信息不足、结果不确定或存在风险，必须直接说明。",
        "输出时要交代做了什么、依据是什么、结果是否可靠，以及下一步建议。",
      ].join("\n"),
      inputDefinition: createDefaultRoleInputDefinition(),
      outputDefinition: createDefaultRoleOutputDefinition(),
      gateCriteria: [],
      executionConfig: createDefaultRoleExecutionConfig("codex"),
      defaultKnowledgeBundleIds: [],
      toolRefs: [],
      kind: "custom",
    });
    orch.selectedRoleId = role.id;
    orch.setActiveTab("roles");
    message.success("角色已创建");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "创建角色失败");
  }
}

function confirmDelete(roleId: RoleId, name: string) {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能删除角色");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  const role = orch.roles.find((item) => item.id === roleId) ?? null;
  if (role?.kind === "builtin") {
    message.warning("内置角色不可删除");
    return;
  }
  Modal.confirm({
    title: "删除角色",
    content: `确定要删除角色「${name}」吗？`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      try {
        await orch.removeRole(ctx.value, props.workspaceId, roleId);
        message.success("角色已删除");
      } catch (e) {
        message.error(e instanceof Error ? e.message : "删除失败");
      }
    },
  });
}

/** 下载导出的角色资产包。 */
function downloadBundle(bundle: OrchAssetBundle) {
  const payload = JSON.stringify(bundle, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeFileName(bundle.title || "role-bundle")}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 规整下载文件名，避免浏览器保存时报非法字符。 */
function safeFileName(raw: string): string {
  return String(raw ?? "").trim().replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "role-bundle";
}

/** 判断当前角色是否允许被当前账号导出。 */
function isRoleExportable(roleId: RoleId): boolean {
  return exportableRoleIdSet.value.has(roleId);
}

/** 清理导出列表，避免非超管误带出内置角色。 */
function sanitizeExportRoleIds(roleIds: RoleId[]): RoleId[] {
  return roleIds.filter((roleId) => isRoleExportable(roleId));
}

/** 判断角色是否可用于新编排；资产库详情始终允许查看。 */
function isRoleAvailable(role: unknown): boolean {
  const availability = (role as { availability?: { available?: boolean } | null } | null | undefined)?.availability;
  return availability?.available !== false;
}

</script>

<template>
  <div class="role-list">
    <input ref="importInputRef" type="file" accept=".json,application/json" class="role-list__hidden-input" @change="onImportFile" />

    <Teleport defer :to="props.toolbarTeleportTarget || 'body'" :disabled="!props.toolbarTeleportTarget">
      <div class="role-list__search">
        <SearchOutlined class="role-list__search-icon" />
        <input v-model="searchText" placeholder="搜索角色..." class="role-list__search-input" />
        <div class="role-list__search-actions" aria-label="Agent 操作">
          <a-tooltip v-if="showCreateButton" title="新建自定义 Agent">
            <span class="role-list__tooltip-wrap">
              <button class="role-list__icon-action role-list__icon-action--primary" type="button" aria-label="新建自定义 Agent" :disabled="props.locked || orch.rolesLoading" @click="createRole">
                <PlusOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showImportButton" :title="importing ? '导入中' : '导入 Agent 资产'">
            <span class="role-list__tooltip-wrap">
              <button
                class="role-list__icon-action"
                type="button"
                :aria-label="importing ? '导入中' : '导入 Agent 资产'"
                :disabled="props.locked || importing"
                @click="triggerImport"
              >
                <ImportOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showExportButton" title="导出 Agent 资产">
            <span class="role-list__tooltip-wrap">
              <button
                class="role-list__icon-action"
                type="button"
                aria-label="导出 Agent 资产"
                :disabled="props.locked"
                @click="openExportModal"
              >
                <ExportOutlined />
              </button>
            </span>
          </a-tooltip>
          <span class="role-list__tooltip-wrap">
            <button class="role-list__icon-action" type="button" aria-label="刷新 Agent 列表" @click="refreshRoleList">
              <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
              <Loading3QuartersOutlined v-if="refreshing" spin />
              <ReloadOutlined v-else />
            </button>
          </span>
        </div>
      </div>
    </Teleport>

    <AssetGroupBar ref="assetGroupBarRef" v-model="assetGroups.selectedGroup.value" :groups="assetGroups.groups.value" :loading="assetGroups.loading.value" :can-manage="!props.maintenanceForbidden" :load-groups="assetGroups.load" :create-group="assetGroups.create" :rename-group="assetGroups.rename" :delete-group="assetGroups.remove" :assign-group="assetGroups.assign" />

    <div class="role-list__items">
      <div v-if="orch.rolesLoading" class="role-list__loading">加载中...</div>
      <div
        v-for="role in filteredRoles"
        :key="role.id"
        class="role-list__item"
        :class="{
          'role-list__item--selected': orch.selectedRoleId === role.id,
          'role-list__item--disabled': !isRoleAvailable(role),
        }"
        @click="selectRole(role.id)"
      >
        <span class="role-list__item-icon" aria-hidden="true"><TeamOutlined /></span>
        <div class="role-list__item-body">
          <div class="role-list__item-name">
            <span class="role-list__item-name-text">{{ role.name }}</span>
            <span class="role-list__item-tags">
              <span
                class="role-list__item-kind"
                :class="role.kind === 'builtin' ? 'role-list__item-kind--builtin' : ''"
              >
                {{ role.kind === 'builtin' ? '内置' : '自定义' }}
              </span>
              <span v-if="!isRoleAvailable(role)" class="role-list__item-status">已到期</span>
            </span>
          </div>
          <div class="role-list__item-capabilities" aria-label="角色能力摘要">
            <span v-for="tag in roleCapabilityTags(role)" :key="tag">{{ tag }}</span>
          </div>
        </div>
        <button
          v-if="props.canCopyBuiltin && role.kind === 'builtin'"
          type="button"
          class="role-list__item-menu role-list__item-copy"
          :disabled="props.copyingBuiltinAssetId === role.id"
          title="复制为个人资产"
          :aria-label="`复制 ${role.name} 为个人资产`"
          @click.stop="emit('copy-builtin', role.id)"
        >
          <Loading3QuartersOutlined v-if="props.copyingBuiltinAssetId === role.id" spin />
          <CopyOutlined v-else />
        </button>
        <a-dropdown v-if="!props.maintenanceForbidden && role.kind !== 'builtin'" :trigger="['click']">
          <button type="button" class="role-list__item-menu" aria-label="更多" @click.stop>⋯</button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="assetGroupBarRef?.openMoveGroup(role)"><template #icon><SwapOutlined /></template>切换分组</a-menu-item>
              <a-menu-divider />
              <a-menu-item :disabled="props.locked" danger @click="confirmDelete(role.id, role.name)"><template #icon><DeleteOutlined /></template>删除</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
      <div v-if="!orch.rolesLoading && filteredRoles.length === 0" class="role-list__empty">
        当前分组暂无 Agent
      </div>
    </div>

    <a-modal
      :open="exportModalOpen"
      title="导出角色资产包"
      :width="720"
      :footer="null"
      wrap-class-name="orch-asset-modal orch-asset-bundle-modal"
      @cancel="exportModalOpen = false"
    >
      <div class="role-list__bundle-modal">
        <div class="role-list__bundle-intro">
          <strong>批量导出角色及其依赖</strong>
          <p>导出的 JSON 会自动带上所选角色依赖的知识库和工具，后续可在其他工作区一键导入。</p>
          <p v-if="!canExportBuiltinRole" class="role-list__bundle-note">当前账号仅可导出自定义角色，内置角色仅超管可导出。</p>
        </div>

        <div class="role-list__bundle-toolbar">
          <button class="role-list__ghost-btn orch-action-btn" type="button" :disabled="!exportableRoleCount" @click="toggleAllExportRoles">
            {{ allExportableRoleSelected ? "取消全选" : "全选" }}
          </button>
          <span>已选 {{ exportRoleIds.length }} / {{ exportableRoleCount }}</span>
        </div>

        <div class="role-list__bundle-list">
          <label
            v-for="role in orch.roles"
            :key="role.id"
            class="role-list__bundle-item"
            :class="{ 'role-list__bundle-item--disabled': !isRoleExportable(role.id) }"
          >
            <input
              :checked="exportRoleIds.includes(role.id)"
              type="checkbox"
              :disabled="!isRoleExportable(role.id)"
              @change="onExportRoleToggle($event, role.id)"
            />
            <div>
              <strong>
                {{ role.name }}
                <span v-if="role.kind === 'builtin'" class="role-list__bundle-tag">内置</span>
                <span v-if="role.kind === 'builtin' && !canExportBuiltinRole" class="role-list__bundle-tag role-list__bundle-tag--warn">
                  仅超管可导出
                </span>
              </strong>
              <p>{{ roleDescriptionSummary(role.description) }}</p>
            </div>
          </label>
        </div>

        <div class="role-list__bundle-footer">
          <button class="role-list__ghost-btn orch-action-btn" :disabled="exporting" @click="exportModalOpen = false">取消</button>
          <button class="orch-action-btn orch-action-btn--primary" :disabled="exporting" @click="onExportBundle">
            {{ exporting ? "导出中..." : "开始导出" }}
          </button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.role-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.role-list__hidden-input { display:none; }
.role-list__ghost-btn {
  border-color: color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #334155);
}
.role-list__ghost-btn:hover,
.role-list__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
  color: var(--app-accent, #d97757);
}

.role-list__search {
  padding: 12px 14px 0;
}

.role-list__search-input {
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

.role-list__search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.role-list__items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 10px;
}

.role-list__item {
  display: flex;
  align-items: flex-start;
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

.role-list__item:hover {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
}

.role-list__item--selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.role-list__item.role-list__item--selected:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.role-list__item--disabled {
  opacity: 0.72;
}

.role-list__item--selected .role-list__item-name {
  color: var(--app-accent);
  font-weight: 600;
}

.role-list__item-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #10b981, #0d9488);
  color: #fff;
  font-size: 13px;
}

.role-list__item-body {
  flex: 1 1 auto;
  min-width: 0;
}

.role-list__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.role-list__item-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-list__item-capabilities {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.role-list__item-capabilities span {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--app-muted, #667085) 9%, transparent);
  color: var(--app-muted, #667085);
  font-size: 10.5px;
  line-height: 1;
}

.role-list__item-tags {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 6px;
  pointer-events: none;
  transition: opacity 0.16s ease;
}

.role-list__item-kind {
  display: inline-flex;
  align-items: center;
  height: 16px;
  font-size: 10.5px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-accent) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent) 68%, #1f2937);
  font-weight: 500;
}

.role-list__item-kind--builtin {
  background: color-mix(in srgb, var(--app-muted) 12%, transparent);
  color: var(--app-muted, #667085);
}

.role-list__item-status {
  display: inline-flex;
  align-items: center;
  height: 16px;
  font-size: 10.5px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
  font-weight: 500;
}

.role-list__item-delete {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 10px;
  background: none;
  cursor: pointer;
  color: var(--app-muted, #999);
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s, background-color 0.16s ease, color 0.16s ease;
}
.role-list__item-menu { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); cursor: pointer; font-size: 18px; line-height: 1; opacity: 0; }
.role-list__item:hover .role-list__item-menu, .role-list__item--selected .role-list__item-menu { opacity: 1; }
.role-list__item-menu:hover { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 10%, transparent); }
/* 内置资产的复制入口常驻显示，避免必须悬停才能发现。 */
.role-list__item-copy { opacity: 1; font-size: 13px; }
.role-list__item-copy:disabled { cursor: not-allowed; opacity: .5; }

.role-list__item:hover .role-list__item-delete,
.role-list__item--selected .role-list__item-delete {
  opacity: 1;
}

.role-list__item-delete:hover {
  color: #ff4d4f;
  background: color-mix(in srgb, #ff4d4f 12%, transparent);
}

.role-list__item-delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  color: var(--app-muted, #999);
  background: transparent;
}

.role-list__loading,
.role-list__empty {
  min-height: 160px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--app-muted, #999);
  font-size: 13px;
}

.role-list__bundle-modal { display:flex; flex-direction:column; gap:16px; }
.role-list__bundle-intro {
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px 14px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
}
.role-list__bundle-intro strong { display:block; margin-bottom:4px; }
.role-list__bundle-intro p { margin:0; font-size:12px; line-height:1.7; color:var(--app-muted, #666); }
.role-list__bundle-note { color: color-mix(in srgb, var(--app-accent, #d97757) 72%, #7c2d12) !important; }
.role-list__bundle-toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
  color:var(--app-muted, #666);
}
.role-list__bundle-list {
  display:flex;
  flex-direction:column;
  gap:10px;
  max-height:min(52vh, 480px);
  overflow:auto;
  padding-right:4px;
}
.role-list__bundle-item {
  display:flex;
  align-items:flex-start;
  gap:10px;
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px;
  background:var(--app-bg, #fff);
}
.role-list__bundle-item--disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
.role-list__bundle-item strong { display:block; font-size:13px; }
.role-list__bundle-item p { margin:4px 0 0; font-size:12px; color:var(--app-muted, #666); }
.role-list__bundle-tag {
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
.role-list__bundle-tag--warn {
  background: color-mix(in srgb, #f59e0b 14%, #fff);
  color: #92400e;
}
.role-list__bundle-footer { display:flex; justify-content:flex-end; gap:10px; }

:root[data-theme="dark"] .role-list__ghost-btn {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .role-list__ghost-btn:hover,
:root[data-theme="dark"] .role-list__ghost-btn:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 24%, #303030);
  background: color-mix(in srgb, var(--app-accent) 10%, #16181d);
  color: #ffd2c2;
}

:root[data-theme="dark"] .role-list__item {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

:root[data-theme="dark"] .role-list__item:hover {
  background: var(--app-sidebar-hover-bg);
}

:root[data-theme="dark"] .role-list__item--selected {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .role-list__item.role-list__item--selected:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .role-list__item-kind {
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  color: #ffd2c2;
}

:root[data-theme="dark"] .role-list__item-kind--builtin {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}

:root[data-theme="dark"] .role-list__item-capabilities span {
  background: rgba(148, 163, 184, 0.12);
  color: #9fb0c2;
}

:root[data-theme="dark"] .role-list__search-input {
  border-color: rgba(255, 255, 255, 0.08);
  background: #16181d;
}

:root[data-theme="dark"] .role-list__bundle-item,
:root[data-theme="dark"] .role-list__bundle-intro {
  border-color: rgba(255, 255, 255, 0.08);
}

:root[data-theme="dark"] .role-list__bundle-tag {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}

:root[data-theme="dark"] .role-list__bundle-tag--warn {
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
}

:root[data-theme="dark"] .role-list__item-status {
  background: rgba(245, 158, 11, 0.18);
  color: #fcd34d;
}
</style>
