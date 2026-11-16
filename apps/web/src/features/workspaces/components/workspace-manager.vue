<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import type { OnlineClientInfo, WorkspaceExecutionProfile, WorkspaceId, WorkspaceSummary } from "@codeflowai/shared";

import { isDesktopWorkspace } from "../../../services/desktop";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { getSharedWorkspaceOwnerLabel, getWorkspaceDisplayTitle, getWorkspaceKindLabel } from "../../../utils/workspaceDisplay";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import {
  getWorkspaceDirectoryMigrationDisabledReason,
  isSharedWorkspaceDirectoryMigrationEntry,
  isWorkspaceDirectoryMigrationActionDisabled,
} from "../workspaceDirectoryMigrationPolicy";
import CreateWorkspaceModal from "./create-workspace-modal.vue";
import WorkspaceDirectoryMigrationModal from "./workspace-directory-migration-modal.vue";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "WorkspaceManager" });

const props = withDefaults(defineProps<{
  active?: boolean;
  surface?: "default" | "h5";
}>(), {
  active: true,
  surface: "default",
});

const emit = defineEmits<{
  (e: "selected", workspaceId: WorkspaceId): void;
}>();

const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();

const editOpen = ref(false);
const saving = ref(false);
const profileLoading = ref(false);
const profileSaving = ref(false);
const profileError = ref<string | null>(null);
const profileValue = ref<WorkspaceExecutionProfile | null>(null);
const profileWorkspaceId = ref<WorkspaceId | null>(null);
let profileRequestVersion = 0;
const modalMode = ref<"create" | "edit">("create");
const modalInitial = ref<{ workspaceId?: WorkspaceId; title: string; path: string; clientId?: string } | null>(null);
const modalWorkspaceReadonly = ref(false);
const migrationOpen = ref(false);
const migrationWorkspaceId = ref<WorkspaceId | null>(null);
const migrationWorkspace = computed(() => migrationWorkspaceId.value
  ? workspaces.byId.get(migrationWorkspaceId.value) ?? null
  : null);
/** 桌面内置 Client 的安全投影；本机工作区在未连接 Server 时仍可迁移。 */
const localDesktopClient = computed<OnlineClientInfo | null>(() => {
  const client = config.desktopClient;
  if (!config.localRuntimeReady || !client) return null;
  return {
    ...client,
    capabilities: { ...(client.capabilities ?? {}), workspaceDirectoryMigrationV1: true },
  };
});

/** 优先使用 Server presence 中的 Client；本机工作区回落到内置 Client。 */
function migrationClientFor(workspaceId: WorkspaceId | string): OnlineClientInfo | null {
  return presence.clientForWorkspace(workspaceId as WorkspaceId)
    ?? (isDesktopWorkspace(config, String(workspaceId)) ? localDesktopClient.value : null);
}

/** 仅未连接 Server 的桌面单机模式直连内置 Client；已连接时沿用 Server 语义。 */
function isLocalDesktopWorkspace(workspaceId: WorkspaceId | string): boolean {
  return !config.connected && isDesktopWorkspace(config, String(workspaceId));
}

const migrationClient = computed(() => migrationWorkspace.value
  ? migrationClientFor(migrationWorkspace.value.id)
  : null);

const items = computed(() => workspaces.workspaces);
const createClients = computed(() => presence.availableClients);

function isSharedWorkspace(workspace: WorkspaceSummary): boolean {
  return isSharedWorkspaceDirectoryMigrationEntry(workspace) || isSharedWorkspaceSelectionId(workspace.id);
}

function sharedWorkspaceRoleLabel(workspace: WorkspaceSummary): string {
  const role = workspace.shared?.effectiveAssetRole ?? workspace.shared?.currentUserRole;
  if (role === "enterprise_admin") return "企业管理员";
  if (role === "workspace_admin") return "工作区管理员";
  return "成员";
}

function workspaceSelectionLabel(workspace: WorkspaceSummary): string {
  const action = workspace.id === config.workspaceId ? "当前工作区" : "选择工作区";
  return `${action}：${getWorkspaceDisplayTitle(workspace)}`;
}

/** 本地和云端工作区沿统一请求入口刷新。 */
const refresh = async () => {
  if (!config.canManageWorkspaces) return;
  try {
    // 已有列表时静默刷新，进入面板立即展示缓存，不再整块转圈。
    await workspaces.refresh(ctx.value, { silent: true });
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  }
};

/** 用户主动切换工作区：先保存草稿，再应用内切换，避免整页刷新造成白屏。 */
function switchWorkspaceFromUserAction(workspaceId: string): void {
  const target = workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
  trackProductEvent("workspace_switch", { source: "workspace_manager", status: "started", workspace_type: target && isSharedWorkspace(target) ? "shared" : "local" });
  config.switchWorkspace(workspaceId, {
    flushDrafts: true,
    source: "workspace_manager",
    onApplied: (nextWorkspaceId) => emit("selected", nextWorkspaceId as WorkspaceId),
  });
}

watch(
  () => [props.active, config.canManageWorkspaces] as const,
  ([active, connected], previous) => {
    const [prevActive, prevConnected] = previous ?? [undefined, undefined];
    if (!active || !connected) return;
    if (prevActive === active && prevConnected === connected) return;
    void refresh();
  },
  { immediate: true },
);

watch(editOpen, (open) => { if (!open) resetProfilePanel(); }, { flush: "sync" });
onBeforeUnmount(resetProfilePanel);

/** 使用实际可用 Client 创建工作区，桌面默认选择本机。 */
function openCreate(): void {
  if (!config.canManageWorkspaces) {
    message.warning(config.isDesktop ? "本地运行时尚未就绪" : "请先连接 Server");
    return;
  }
  if (!createClients.value.length) {
    message.warning("请先让至少一个 Client 在线");
    return;
  }
  modalMode.value = "create";
  modalWorkspaceReadonly.value = false;
  modalInitial.value = { title: "", path: "", clientId: resolveDefaultCreateClientId() ?? undefined };
  resetProfilePanel();
  editOpen.value = true;
}

/** 编辑名称和本地 Profile，目录迁移沿既有独立入口处理。 */
function openEdit(w: WorkspaceSummary): void {
  if (!config.canManageWorkspaces) return;
  if (w.activeDirectoryMigration) {
    openMigration(w);
    return;
  }
  modalMode.value = "edit";
  modalWorkspaceReadonly.value = isSharedWorkspace(w);
  modalInitial.value = {
    workspaceId: w.id,
    title: w.title,
    path: w.path,
    clientId: presence.clientForWorkspace(w.id)?.clientId ?? undefined,
  };
  resetProfilePanel();
  profileWorkspaceId.value = w.id;
  void loadWorkspaceProfile(w.id);
  editOpen.value = true;
}

/** 打开本机目录迁移；共享成员、离线 Client、旧 Client 和索引异常均在入口阻断。 */
function openMigration(w: WorkspaceSummary): void {
  if (isSharedWorkspace(w)) {
    message.info("共享成员入口不能迁移本机目录，请在 Host 本地工作区操作");
    return;
  }
  const client = migrationClientFor(w.id);
  const disabledReason = getWorkspaceDirectoryMigrationDisabledReason({
    workspace: w,
    client,
    connected: config.connected,
    localDesktop: isLocalDesktopWorkspace(w.id),
  });
  if (disabledReason) {
    message.warning(disabledReason);
    return;
  }
  migrationWorkspaceId.value = w.id;
  migrationOpen.value = true;
}

/** 返回工作区卡片上的迁移按钮文案，活动 operation 统一进入进度查看。 */
function migrationActionLabel(w: WorkspaceSummary): string {
  if (!w.activeDirectoryMigration && w.directoryMigrationIndexState?.indexRebuildStatus === "failed") return "重建索引";
  return w.activeDirectoryMigration ? "迁移中" : "迁移目录";
}

/** 判断迁移入口是否应禁用；活动 operation 保留查看和恢复入口。 */
function migrationActionDisabled(w: WorkspaceSummary): boolean {
  return isWorkspaceDirectoryMigrationActionDisabled({
    workspace: w,
    client: migrationClientFor(w.id),
    connected: config.connected,
    localDesktop: isLocalDesktopWorkspace(w.id),
  });
}

/** 解释迁移入口禁用原因，避免用户只看到不可点击按钮。 */
function migrationDisabledReason(w: WorkspaceSummary): string {
  if (w.activeDirectoryMigration) return "迁移进行中，点击查看进度";
  return getWorkspaceDirectoryMigrationDisabledReason({
    workspace: w,
    client: migrationClientFor(w.id),
    connected: config.connected,
    localDesktop: isLocalDesktopWorkspace(w.id),
  }) ?? "";
}

/** 共享 Host 维护期间禁止成员入口切换，Host 本地入口仍可查看迁移态。 */
function workspaceCardSelectionDisabled(w: WorkspaceSummary): boolean {
  return isSharedWorkspace(w) && (w.entryStatus !== "available" || Boolean(w.hostMaintenance?.active));
}

/** 离线也可移除账号入口；失败保留确认框并展示原因。 */
function confirmDelete(w: WorkspaceSummary): void {
  if (!config.canManageWorkspaces) return;
  if (isSharedWorkspace(w)) {
    message.info("共享工作区请在共享空间设置中维护共享关系，不能作为本地工作区移除");
    return;
  }
  Modal.confirm({
    title: "移除工作区",
    content: config.isDesktop
      ? "将从本机列表移除该工作区。历史会话与元数据保留，重新添加同一目录可恢复。"
      : "将从账号列表移除该工作区，Client 离线时也可移除。本地历史会话与元数据保留，主动重新添加同一工作区可恢复。",
    okText: "移除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      try {
        await workspaces.delete(ctx.value, w.id);
      } catch (error) {
        message.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
      if (config.workspaceId === w.id) {
        switchWorkspaceFromUserAction(workspaces.workspaces.length ? workspaces.workspaces[0]!.id : "");
      }
      message.success("已移除");
    },
  });
}

/** 保存工作区后切到该工作区，由应用内切换重建当前工作区上下文。 */
async function onModalConfirm(payload: { workspaceId?: WorkspaceId; title: string; path: string; clientId?: string }): Promise<void> {
  if (!config.canManageWorkspaces) return;
  if (modalWorkspaceReadonly.value) return;
  saving.value = true;
  try {
    const w = await workspaces.upsert(ctx.value, payload);
    switchWorkspaceFromUserAction(w.id);
    editOpen.value = false;
    message.success("工作区已保存");
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}

/** 桌面新增优先本机，浏览器沿当前工作区或唯一在线 Client。 */
function resolveDefaultCreateClientId(): string | null {
  if (config.localRuntimeReady) return config.desktopClient!.clientId;
  const currentClientId = presence.clientForWorkspace(config.workspaceId)?.clientId ?? null;
  if (currentClientId) return currentClientId;
  return createClients.value.length === 1 ? createClients.value[0]!.clientId : null;
}

/** 读取当前面板；仅最新请求回填，旧失败保留目标诊断，不能污染新面板。 */
async function loadWorkspaceProfile(workspaceId: WorkspaceId): Promise<boolean> {
  if (profileSaving.value) return false;
  const version = ++profileRequestVersion;
  profileLoading.value = true;
  profileError.value = null;
  try {
    const profile = await workspaces.getExecutionProfile(ctx.value, workspaceId);
    if (!isProfileRequestCurrent(workspaceId, version)) return false;
    profileValue.value = profile;
    return true;
  } catch (e) {
    const text = reportProfileFailure(e, workspaceId, "read");
    if (isProfileRequestCurrent(workspaceId, version)) {
      profileError.value = text;
      profileValue.value = null;
    } else {
      message.error(`工作区 ${workspaceId} Profile 读取失败：${text}`);
    }
    return false;
  } finally {
    if (isProfileRequestCurrent(workspaceId, version)) profileLoading.value = false;
  }
}

/** 保存固定目标的 Profile；已派发保存照常结算，旧结果不修改新面板。 */
async function onProfileSave(profileText: string): Promise<boolean> {
  const workspaceId = profileWorkspaceId.value;
  if (!editOpen.value || !workspaceId || !config.canManageWorkspaces || profileLoading.value || profileSaving.value || profileError.value) return false;
  const version = ++profileRequestVersion;
  profileSaving.value = true;
  profileError.value = null;
  try {
    const profile = await workspaces.updateExecutionProfile(ctx.value, workspaceId, profileText);
    if (isProfileRequestCurrent(workspaceId, version)) {
      profileValue.value = profile;
      message.success("Profile 已保存");
    } else {
      message.success(`工作区 ${workspaceId} Profile 已保存`);
    }
    return true;
  } catch (e) {
    const text = reportProfileFailure(e, workspaceId, "save");
    message.error(isProfileRequestCurrent(workspaceId, version) ? text : `工作区 ${workspaceId} Profile 保存失败：${text}`);
    return false;
  } finally {
    if (isProfileRequestCurrent(workspaceId, version)) profileSaving.value = false;
  }
}

/** 仅当前打开的面板可刷新；保存期间由原按钮和加载入口阻止读取竞争。 */
function refreshProfile(): void {
  const workspaceId = profileWorkspaceId.value;
  if (!editOpen.value || !workspaceId) return;
  void loadWorkspaceProfile(workspaceId);
}

/** 同一工作区重新打开亦属新代次，避免仅比目标 ID 接受旧结果。 */
function isProfileRequestCurrent(workspaceId: WorkspaceId, version: number): boolean {
  return editOpen.value && profileWorkspaceId.value === workspaceId && profileRequestVersion === version;
}

/** 记录失败所属目标及请求诊断，不记录 Profile 正文；日志失败保留原异常。 */
function reportProfileFailure(error: unknown, workspaceId: WorkspaceId, operation: "read" | "save"): string {
  const text = error instanceof Error ? error.message : String(error);
  const diagnostic = error && typeof error === "object" ? error as { code?: string; requestId?: string } : null;
  try {
    console.error("workspace Profile request failed", {
      errorCode: diagnostic?.code ?? "WORKSPACE_PROFILE_REQUEST_FAILED", requestId: diagnostic?.requestId ?? null,
      workspaceId, operation, rootCause: text,
    });
  } catch (loggingError) {
    throw new AggregateError([error, loggingError], "工作区 Profile 请求及日志记录均失败", { cause: error });
  }
  return text;
}

/** 清空面板并失效所有旧请求，供切换、关闭和卸载共用。 */
function resetProfilePanel(): void {
  profileRequestVersion++;
  profileWorkspaceId.value = null;
  profileValue.value = null;
  profileError.value = null;
  profileLoading.value = false;
  profileSaving.value = false;
}
</script>

<template>
  <div class="ws-manager" :class="{ 'ws-manager--h5': props.surface === 'h5' }">
    <a-spin :spinning="workspaces.loading" style="min-height: 120px">
    <div class="ws-manager__grid">
      <div
        v-for="w in items"
        :key="w.id"
        class="ws-manager__card"
        :class="{ 'ws-manager__card--active': w.id === config.workspaceId }"
      >
        <button
          class="ws-manager__card-select"
          type="button"
          :aria-label="workspaceSelectionLabel(w)"
          :aria-pressed="w.id === config.workspaceId"
          :disabled="workspaceCardSelectionDisabled(w)"
          @click="switchWorkspaceFromUserAction(w.id)"
        >
          <div v-if="w.id === config.workspaceId" class="ws-manager__card-badge">当前</div>
          <div class="ws-manager__card-title">{{ getWorkspaceDisplayTitle(w) }}</div>
          <div class="ws-manager__badges">
            <a-tag :color="isSharedWorkspace(w) ? 'blue' : 'default'">{{ getWorkspaceKindLabel(w) }}</a-tag>
            <template v-if="isSharedWorkspace(w)">
              <a-tag v-if="getSharedWorkspaceOwnerLabel(w)">Host {{ getSharedWorkspaceOwnerLabel(w) }}</a-tag>
              <a-tag>{{ sharedWorkspaceRoleLabel(w) }}</a-tag>
              <a-tag :color="w.entryStatus === 'available' ? 'green' : 'orange'">
                {{ w.entryStatus === "available" ? (w.shared?.isHostOwner ? "本机承载" : "Host 在线") : w.disabledReason || "暂不可用" }}
              </a-tag>
            </template>
            <a-tag v-if="w.hostedShared" color="cyan">共享 Host</a-tag>
            <a-tag v-if="w.activeDirectoryMigration" color="orange">{{ migrationActionLabel(w) }}</a-tag>
            <a-tag v-else-if="w.hostMaintenance?.active" color="orange">共享维护中</a-tag>
          </div>
          <div class="ws-manager__card-path">{{ w.path }}</div>
          <div class="ws-manager__card-id">{{ w.id }}</div>
        </button>
        <div class="ws-manager__card-actions">
          <a-tooltip v-if="!isSharedWorkspace(w)" :title="migrationDisabledReason(w)">
            <a-button
              size="small"
              type="text"
              :disabled="migrationActionDisabled(w)"
              @click="openMigration(w)"
            >{{ migrationActionLabel(w) }}</a-button>
          </a-tooltip>
          <a-button size="small" type="text" :disabled="Boolean(w.activeDirectoryMigration)" @click="openEdit(w)">{{ isSharedWorkspace(w) ? "Profile" : "编辑" }}</a-button>
          <a-button size="small" type="text" danger :disabled="isSharedWorkspace(w)" @click="confirmDelete(w)">移除</a-button>
        </div>
      </div>

      <button class="ws-manager__card ws-manager__card--add" type="button" aria-label="新建工作区" @click="openCreate">
        <div class="ws-manager__card-add-icon" aria-hidden="true">+</div>
        <div class="ws-manager__card-add-text">新建工作区</div>
      </button>
    </div>
    </a-spin>
  </div>

  <CreateWorkspaceModal
    v-model:open="editOpen"
    :saving="saving"
    :mode="modalMode"
    :initial="modalInitial"
    :clients="createClients"
    :local-runtime="config.isDesktop"
    :workspace-readonly="modalWorkspaceReadonly"
    :profile-enabled="modalMode === 'edit'"
    :profile-loading="profileLoading"
    :profile-saving="profileSaving"
    :profile="profileValue"
    :profile-error="profileError"
    @confirm="onModalConfirm"
    @profile-save="onProfileSave"
    @profile-refresh="refreshProfile"
  />

  <WorkspaceDirectoryMigrationModal
    v-model:open="migrationOpen"
    :workspace="migrationWorkspace"
    :client="migrationClient"
  />
</template>

<style scoped>
.ws-manager__grid {
  display: grid;
  /* 按容器宽度自动排布；min(100%, 300px) 保证窄屏单列也不会溢出 */
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 12px;
}

.ws-manager__card {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-bg);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.ws-manager__card:hover {
  border-color: color-mix(in srgb, var(--app-accent) 40%, transparent);
}

.ws-manager__card--active {
  border-color: var(--app-accent);
}

.ws-manager__card-select {
  display: flex;
  width: 100%;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  appearance: none;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.ws-manager__card-select:focus-visible,
.ws-manager__card--add:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}

.ws-manager__card-badge {
  position: absolute;
  top: 10px;
  right: 10px;
  font-size: 10px;
  font-weight: 600;
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  padding: 1px 8px;
  border-radius: 4px;
  line-height: 1.6;
}

.ws-manager__card--add {
  min-height: 100px;
  align-items: center;
  justify-content: center;
  padding: 14px;
  appearance: none;
  border-style: dashed;
  color: var(--app-muted);
  font: inherit;
  text-align: center;
  cursor: pointer;
}

.ws-manager__card--add:hover {
  border-color: var(--app-accent);
  color: var(--app-accent);
}

.ws-manager__card-add-icon {
  font-size: 24px;
  line-height: 1;
}

.ws-manager__card-add-text {
  font-size: 12px;
}

.ws-manager__card-title {
  padding-right: 44px;
  overflow: hidden;
  font-weight: 600;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-manager__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ws-manager__card-path {
  font-size: 12px;
  color: var(--app-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-manager__card-id {
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 11px;
  color: var(--app-muted);
  opacity: 0.7;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-manager__card-actions {
  display: flex;
  padding: 0 8px 8px;
  gap: 2px;
  margin-top: 0;
}

/* H5 用单列工作区卡片承载切换与维护动作，避免缩放桌面双栏。 */
.ws-manager--h5 {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 0 calc(18px + var(--safe-bottom, 0px));
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ws-manager--h5::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.ws-manager--h5 .ws-manager__grid {
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.ws-manager--h5 .ws-manager__card {
  border-radius: 18px;
  border-color: color-mix(in srgb, var(--app-divider) 82%, transparent);
  background: color-mix(in srgb, var(--app-surface) 96%, transparent);
  box-shadow: 0 10px 24px color-mix(in srgb, #000 5%, transparent);
}

.ws-manager--h5 .ws-manager__card-select {
  gap: 8px;
  min-height: 116px;
  padding: 14px;
}

.ws-manager--h5 .ws-manager__card--active {
  border-color: color-mix(in srgb, var(--app-accent) 65%, var(--app-divider));
  box-shadow: 0 12px 28px color-mix(in srgb, var(--app-accent) 12%, transparent);
}

.ws-manager--h5 .ws-manager__card-title {
  padding-right: 48px;
  font-size: 16px;
  font-weight: 700;
}

.ws-manager--h5 .ws-manager__badges {
  gap: 5px;
}

.ws-manager--h5 .ws-manager__badges :deep(.ant-tag) {
  margin-inline-end: 0;
  border-radius: 7px;
  font-size: 10px;
  line-height: 20px;
}

.ws-manager--h5 .ws-manager__card-path {
  font-size: 12px;
}

.ws-manager--h5 .ws-manager__card-actions {
  min-height: 48px;
  align-items: center;
  margin-top: 0;
  padding: 0 10px 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-divider) 70%, transparent);
}

.ws-manager--h5 .ws-manager__card-actions :deep(.ant-btn) {
  min-height: 40px;
  flex: 1 1 0;
  border-radius: 11px;
}

.ws-manager--h5 .ws-manager__card--add {
  min-height: 64px;
  flex-direction: row;
  gap: 8px;
  border-radius: 17px;
  border-style: dashed;
  box-shadow: none;
}

.ws-manager--h5 .ws-manager__card-add-icon {
  font-size: 21px;
}

.ws-manager--h5 .ws-manager__card-add-text {
  font-size: 14px;
  font-weight: 650;
}
</style>
