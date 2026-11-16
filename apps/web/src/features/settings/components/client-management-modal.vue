<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { Modal, message } from "ant-design-vue";
import { DesktopOutlined, MoreOutlined } from "@ant-design/icons-vue";
import {
  type OnlineClientInfo,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { isCancelledRequestError, requestJson } from "../../../api/request";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { resolveWorkspaceDisplayTitle } from "../../../utils/workspaceTitle";
import { resolveWorkspaceRuntimeDisplay } from "../../../utils/workspaceRuntimeDisplay";
import ClientDataCleanupModal from "./client-data-cleanup-modal.vue";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "ClientManagementModal" });

const props = defineProps<{ open: boolean; embedded?: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();

const cleanupClientId = ref("");
const cleanupOpen = ref(false);

/** Client rename state */
const editingNameClientId = ref<string | null>(null);
const editingNameValue = ref("");
const savingName = ref(false);

const onlineClients = computed(() => presence.online.onlineClients);
const cleanupClientOnline = computed(() => onlineClients.value.some((client) => client.clientId === cleanupClientId.value));
const currentWorkspace = computed(() => {
  const workspaceId = String(config.workspaceId ?? "").trim();
  if (!workspaceId) return null;
  return workspaces.byId.get(workspaceId as WorkspaceId) ?? null;
});
const isCurrentSharedWorkspace = computed(() => {
  const workspaceId = String(config.workspaceId ?? "").trim();
  if (!workspaceId) return false;
  const workspace = currentWorkspace.value;
  return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
});
const workspaceRuntimeDisplay = computed(() => resolveWorkspaceRuntimeDisplay(
  presence.activeWorkspaceRuntimeState,
  presence.accountClientState,
));
const sharedWorkspaceName = computed(() => currentWorkspace.value?.title || currentWorkspace.value?.shared?.displayName || "当前共享工作区");
const sharedHostLabel = computed(() => currentWorkspace.value?.shared?.hostLabel || sharedWorkspaceName.value);
const sharedHostOwner = computed(() => currentWorkspace.value?.shared?.hostOwnerName || "工作区管理员");
const sharedHostStatusHint = computed(() => {
  if (workspaceRuntimeDisplay.value.status === "online") return "当前共享工作区可正常读取文件和执行任务。";
  if (workspaceRuntimeDisplay.value.status === "offline") return "运行设备已离线，请联系负责人恢复连接。";
  if (workspaceRuntimeDisplay.value.status === "unbound") return "尚未绑定运行设备，请联系工作区管理员。";
  if (workspaceRuntimeDisplay.value.status === "forbidden") return "当前账号暂无该共享工作区访问权限。";
  return "正在确认运行设备状态。";
});
const personalClientEmptyHint = computed(() => workspaceRuntimeDisplay.value.status === "online"
  ? "不影响当前共享工作区的使用。"
  : "共享工作区以上方运行状态为准。");

/** 打开指定在线 Client 的历史数据清理弹窗。 */
function openClientDataCleanup(client: OnlineClientInfo): void {
  cleanupClientId.value = client.clientId;
  cleanupOpen.value = true;
}

function workspaceTitle(wid: string): string {
  return resolveWorkspaceDisplayTitle(wid, (id) => workspaces.byId.get(id as any)?.title);
}

/** 优先使用用户名称；未命名设备不暴露内部连接 ID。 */
function displayName(client: OnlineClientInfo): string {
  return client.name?.trim() || (client.clientId === config.desktopClient?.clientId ? "本机" : "未命名设备");
}

function startEditName(client: OnlineClientInfo): void {
  editingNameClientId.value = client.clientId;
  editingNameValue.value = client.name ?? "";
}

function cancelEditName(): void {
  editingNameClientId.value = null;
  editingNameValue.value = "";
}

/** 保存 Client 显示名称，并按请求结果记录设置事件。 */
async function saveName(clientId: string): Promise<void> {
  const name = editingNameValue.value.trim();
  savingName.value = true;
  try {
    const res = await requestJson(ctx.value, {
      method: "POST",
      path: "/api/client-names/upsert",
      body: { clientId, name },
    });
    if (!res.ok) {
      trackProductEvent("settings_save_failed", { settings_panel: "client_management", settings_action: "rename_client", source: "settings", error_code_group: "request_rejected" });
      message.error(res.message ?? "保存失败");
      return;
    }
    message.success(name ? "名称已保存" : "名称已清除");
    trackProductEvent("settings_save_success", { settings_panel: "client_management", settings_action: "rename_client", source: "settings" });
    editingNameClientId.value = null;
    editingNameValue.value = "";
  } catch (e) {
    if (isCancelledRequestError(e)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "client_management", settings_action: "rename_client", source: "settings", error_code_group: "request_error" });
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    savingName.value = false;
  }
}

/** 管理页关闭不影响已连接 Client。 */
function handleClose(): void {
  emit("update:open", false);
}

watch(
  () => props.open,
  (v) => {
    if (!v) cleanupOpen.value = false;
  },
  { immediate: true },
);
</script>

<template>
  <component
    :is="embedded ? 'div' : Modal"
    v-bind="!embedded ? { open, title: '设备与运行状态', footer: null, width: 'min(560px, calc(100vw - 24px))', centered: true,
      bodyStyle: { height: isCurrentSharedWorkspace ? 'min(360px, calc(100dvh - 180px))' : 'min(240px, calc(100dvh - 180px))', overflow: 'hidden' } } : {}"
    v-on="!embedded ? { cancel: handleClose } : {}"
  >
    <div class="client-mgmt" :class="{ 'client-mgmt--embedded': embedded }">
      <section v-if="isCurrentSharedWorkspace" class="client-mgmt__host-summary">
        <div class="client-mgmt__section-heading">
          <div class="client-mgmt__host-name">
            <span class="client-mgmt__label">当前共享工作区</span>
            <strong>{{ sharedWorkspaceName }}</strong>
          </div>
          <a-badge :status="workspaceRuntimeDisplay.tone === 'online' ? 'success' : workspaceRuntimeDisplay.tone === 'offline' ? 'warning' : 'processing'"
            :text="workspaceRuntimeDisplay.label.replace('Host ', '')" />
        </div>
        <dl class="client-mgmt__host-details">
          <div><dt>本地工作区</dt><dd>{{ sharedHostLabel }}</dd></div>
          <div><dt>负责人</dt><dd>{{ sharedHostOwner }}</dd></div>
        </dl>
        <p class="client-mgmt__hint">{{ sharedHostStatusHint }}</p>
      </section>

      <div class="client-mgmt__section-heading">
        <strong>{{ isCurrentSharedWorkspace ? '我的设备' : '在线设备' }}</strong>
        <span v-if="presence.ready || onlineClients.length" class="client-mgmt__label">{{ onlineClients.length }} 台在线</span>
      </div>
      <div class="client-mgmt__list" aria-label="设备列表">
        <article v-for="client in onlineClients" :key="client.clientId" class="client-mgmt__card">
          <div class="client-mgmt__card-header">
            <div class="client-mgmt__device-icon"><DesktopOutlined /></div>
            <div v-if="editingNameClientId === client.clientId" class="client-mgmt__rename">
              <a-input v-model:value="editingNameValue" :maxlength="32" size="small" placeholder="设备名称（留空清除）"
                :disabled="savingName" aria-label="设备名称" @press-enter="saveName(client.clientId)" />
              <a-button size="small" type="primary" :loading="savingName" @click="saveName(client.clientId)">保存</a-button>
              <a-button size="small" :disabled="savingName" @click="cancelEditName">取消</a-button>
            </div>
            <div v-else class="client-mgmt__identity">
              <strong :title="displayName(client)">{{ displayName(client) }}</strong>
              <a-badge status="success" text="在线" />
            </div>
            <a-dropdown :trigger="['click']" placement="bottomRight" :disabled="savingName">
              <a-button type="text" shape="circle" size="small" :aria-label="displayName(client) + '的更多操作'" title="更多操作">
                <template #icon><MoreOutlined /></template>
              </a-button>
              <template #overlay>
                <a-menu>
                  <a-menu-item key="rename" @click="startEditName(client)">重命名</a-menu-item>
                  <a-menu-item key="cleanup" @click="openClientDataCleanup(client)">清理数据</a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </div>
          <div class="client-mgmt__workspaces">
            <span class="client-mgmt__label">关联工作区</span>
            <div v-if="client.workspaceIds.length" class="client-mgmt__workspace-tags">
              <a-tag v-for="wid in client.workspaceIds" :key="wid" :bordered="false">{{ workspaceTitle(wid) }}</a-tag>
            </div>
            <span v-else class="client-mgmt__label">暂无关联工作区</span>
          </div>
        </article>

        <div v-if="!onlineClients.length && !presence.ready" class="client-mgmt__empty" aria-busy="true">
          <a-spin />
          <span>正在读取设备状态…</span>
        </div>
        <div v-else-if="!onlineClients.length" class="client-mgmt__empty">
          <DesktopOutlined class="client-mgmt__empty-icon" />
          <strong>暂无在线设备</strong>
          <span class="client-mgmt__hint">{{ isCurrentSharedWorkspace ? personalClientEmptyHint : '设备连接后会显示在这里。' }}</span>
        </div>
      </div>

      <ClientDataCleanupModal v-model:open="cleanupOpen" :client-id="cleanupClientId" :disabled="!cleanupClientOnline" />
    </div>
  </component>
</template>

<style scoped>
.client-mgmt {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  color: var(--app-text);
}

.client-mgmt--embedded {
  height: min(520px, calc(100dvh - 180px));
}

.client-mgmt__section-heading,
.client-mgmt__card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

.client-mgmt__section-heading {
  flex: 0 0 auto;
  font-size: 13px;
}

.client-mgmt__label,
.client-mgmt__hint {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.client-mgmt__list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
}

.client-mgmt__card,
.client-mgmt__host-summary {
  display: grid;
  flex: 0 0 auto;
  gap: 14px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
}

.client-mgmt__device-icon {
  display: grid;
  flex: 0 0 36px;
  place-items: center;
  height: 36px;
  border-radius: 10px;
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  font-size: 19px;
}

.client-mgmt__identity {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  min-width: 0;
}

.client-mgmt__identity strong,
.client-mgmt__host-name strong {
  overflow: hidden;
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-mgmt__rename {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.client-mgmt__rename > :first-child {
  flex: 1 1 120px;
  min-width: 0;
}

.client-mgmt__workspaces {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 12px;
  font-size: 12px;
}

.client-mgmt__workspace-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.client-mgmt__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--app-danger);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.client-mgmt__error > :last-child {
  flex-shrink: 0;
}

.client-mgmt__empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  font-size: 13px;
}

.client-mgmt__empty-icon {
  color: var(--app-muted);
  font-size: 28px;
  opacity: 0.6;
}

.client-mgmt__host-name {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.client-mgmt__host-details {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 24px;
  margin: 0;
  font-size: 12px;
}

.client-mgmt__host-details > div {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.client-mgmt__host-details dt {
  flex-shrink: 0;
  color: var(--app-muted);
}

.client-mgmt__host-details dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.client-mgmt__hint {
  margin: 0;
}
</style>
