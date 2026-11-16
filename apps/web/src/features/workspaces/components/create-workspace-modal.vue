<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { FolderOpenOutlined } from "@ant-design/icons-vue";
import type { OnlineClientInfo, WorkspaceExecutionProfile, WorkspaceId } from "@codeflowai/shared";
import { getDesktopBridge } from "../../../services/desktop";

import ClientDirectoryPickerModal from "./client-directory-picker-modal.vue";

defineOptions({ name: "CreateWorkspaceModal" });

type Props = {
  open: boolean;
  saving: boolean;
  mode?: "create" | "edit";
  initial?: { workspaceId?: WorkspaceId; title: string; path: string; clientId?: string } | null;
  clients?: OnlineClientInfo[];
  workspaceReadonly?: boolean;
  profileEnabled?: boolean;
  profileLoading?: boolean;
  profileSaving?: boolean;
  profile?: WorkspaceExecutionProfile | null;
  profileError?: string | null;
  localRuntime?: boolean;
};

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  (e: "confirm", payload: { workspaceId?: WorkspaceId; title: string; path: string; clientId?: string }): void;
  (e: "profile-save", profileText: string): void;
  (e: "profile-refresh"): void;
}>();

const title = ref("");
const path = ref("");
const workspaceId = ref("");
const clientId = ref("");
const profileText = ref("");
const pathPickerOpen = ref(false);
const pathPickerLoading = ref(false);
const pathPickerError = ref("");
const onlineClients = computed(() => props.clients ?? []);
const mode = computed(() => props.mode ?? "create");
const profileVisible = computed(() => Boolean(props.profileEnabled) && mode.value === "edit");
const workspaceReadonly = computed(() => Boolean(props.workspaceReadonly));
const pathReadonly = computed(() => workspaceReadonly.value || mode.value === "edit");
const needsClientSelection = computed(() => mode.value === "create" && onlineClients.value.length > 1);
const selectedClientInfo = computed(() => onlineClients.value.find((client) => client.clientId === clientId.value) ?? null);
const canBrowsePath = computed(() => mode.value === "create" && !!clientId.value.trim());
const modalWidth = computed(() => profileVisible.value ? 920 : undefined);
const modalTitle = computed(() => {
  if (mode.value !== "edit") return "新建工作区";
  return workspaceReadonly.value ? "工作区 Profile" : "编辑工作区";
});
const modalOkText = computed(() => mode.value === "create" ? "创建" : "保存工作区");
const modalCancelText = computed(() => workspaceReadonly.value ? "关闭" : "取消");
const modalOkButtonProps = computed(() => workspaceReadonly.value ? { style: { display: "none" } } : {});
const profileStatusText = computed(() => {
  if (props.profileLoading) return "读取中";
  if (props.profileError) return "不可达";
  return props.profile?.source === "workspace" ? "已配置" : "未配置";
});
const profileStatusColor = computed(() => {
  if (props.profileError) return "orange";
  return props.profile?.source === "workspace" ? "green" : "default";
});
const profileUpdatedAtText = computed(() => {
  const updatedAt = props.profile?.updatedAt ?? null;
  return updatedAt ? new Date(updatedAt).toLocaleString() : "暂无";
});
const profileSaveDisabled = computed(() => Boolean(props.profileLoading || props.profileSaving || props.profileError));

/** 编辑态说明目录不可修改和共享工作区的维护边界。 */
const pathDescription = computed(() => {
  if (workspaceReadonly.value) {
    return "共享工作区基础信息由共享关系维护，这里仅维护当前工作区我的执行 Profile。";
  }
  if (mode.value === "edit") {
    return "工作区目录创建后不可修改；如需切换目录，请新建工作区。";
  }
  return "";
});

watch(
  () => props.open,
  (open) => {
    if (!open) {
      pathPickerOpen.value = false;
      return;
    }
    const initial = props.initial ?? null;
    pathPickerError.value = "";
    title.value = initial?.title ?? "";
    path.value = initial?.path ?? "";
    workspaceId.value = String(initial?.workspaceId ?? "");
    clientId.value = String(initial?.clientId ?? "");
    profileText.value = props.profile?.profileText ?? "";
    if (mode.value === "create" && !clientId.value && onlineClients.value.length === 1) {
      clientId.value = onlineClients.value[0]!.clientId;
    }
  },
);

watch(
  () => props.profile?.profileText,
  (next) => {
    if (!props.open || !profileVisible.value) return;
    profileText.value = next ?? "";
  },
);

watch(
  () => clientId.value,
  (next, previous) => {
    if (!props.open || mode.value !== "create") return;
    if (!previous || next === previous) return;
    // 切换目标 Client 后清空路径，避免把另一台机器的目录误提交过来。
    path.value = "";
  },
);

/** 本机使用系统目录框；远端仍浏览目标 Client，取消保留原路径，失败展示错误态。 */
async function openDirectoryPicker(): Promise<void> {
  if (pathPickerLoading.value) return;
  if (!canBrowsePath.value) {
    message.warning("请先选择目标 Client");
    return;
  }
  pathPickerError.value = "";
  if (!props.localRuntime) {
    pathPickerOpen.value = true;
    return;
  }
  const targetClientId = clientId.value;
  pathPickerLoading.value = true;
  try {
    const bridge = getDesktopBridge();
    if (!bridge?.selectDirectory) throw new Error("当前桌面版本不支持系统目录选择，请升级桌面端");
    const selected = await bridge.selectDirectory(path.value.trim() || undefined);
    if (selected !== null && props.open && clientId.value === targetClientId) path.value = selected;
  } catch (error) {
    pathPickerError.value = error instanceof Error ? error.message : String(error);
  } finally {
    pathPickerLoading.value = false;
  }
}

/** 接收目录选择结果，并写回工作区目录输入框。 */
function onDirectoryPicked(value: string): void {
  path.value = value;
}

/** 校验弹窗输入，并把工作区标题/路径/目标 Client 交给父组件保存。 */
function onOk(): void {
  if (workspaceReadonly.value) {
    onCancel();
    return;
  }
  const nextTitle = title.value.trim();
  const nextPath = path.value.trim();
  const id = workspaceId.value.trim();

  if (!nextTitle || !nextPath) {
    message.error("请填写工作区名称和工作区目录");
    return;
  }
  if (mode.value === "edit" && !id) {
    message.error("缺少 workspaceId（编辑模式）");
    return;
  }
  if (mode.value === "create" && !onlineClients.value.length) {
    message.error("当前没有在线 Client，无法创建工作区");
    return;
  }
  if (needsClientSelection.value && !clientId.value.trim()) {
    message.error("请选择目标 Client");
    return;
  }

  emit("confirm", {
    workspaceId: id ? (id as WorkspaceId) : undefined,
    title: nextTitle,
    path: nextPath,
    clientId: clientId.value.trim() || undefined,
  });
}

/** 关闭弹窗并交还开关状态给父组件。 */
function onCancel(): void {
  pathPickerOpen.value = false;
  emit("update:open", false);
}

/** 保存右侧 Profile 文本；最终校验由 Server/Client 执行。 */
function onProfileSave(): void {
  emit("profile-save", profileText.value);
}

/** 触发父组件重新读取 Profile。 */
function onProfileRefresh(): void {
  emit("profile-refresh");
}
</script>

<template>
  <a-modal
    :open="open"
    :title="modalTitle"
    :width="modalWidth"
    :confirm-loading="saving"
    :ok-button-props="modalOkButtonProps"
    :mask-closable="false"
    :ok-text="modalOkText"
    :cancel-text="modalCancelText"
    @ok="onOk"
    @cancel="onCancel"
  >
    <div class="create-workspace-modal__layout" :class="{ 'create-workspace-modal__layout--with-profile': profileVisible }">
    <a-form layout="vertical" class="create-workspace-modal__form" autocomplete="off">
      <a-form-item v-if="mode === 'create' && onlineClients.length && !localRuntime" label="目标 Client">
        <a-select
          v-if="needsClientSelection"
          v-model:value="clientId"
          placeholder="请选择要创建到哪台 Client"
          :options="onlineClients.map((client) => ({ value: client.clientId, label: `${client.name || client.clientId} (${client.workspaceIds.length} 个工作区)` }))"
        />
        <a-input
          v-else
          :value="(selectedClientInfo?.name || selectedClientInfo?.clientId) ?? (onlineClients[0]?.name || onlineClients[0]?.clientId) ?? ''"
          disabled
        />
      </a-form-item>

      <a-form-item label="工作区名称">
        <a-input
          v-model:value="title"
          name="codeflow-workspace-title"
          autocomplete="new-password"
          :disabled="workspaceReadonly"
          placeholder="名称"
        />
      </a-form-item>

      <a-form-item label="工作区目录">
        <div class="create-workspace-modal__path-row">
          <a-input
            v-model:value="path"
            name="codeflow-workspace-path"
            autocomplete="off"
            allow-clear
            :disabled="pathReadonly"
            placeholder="路径"
          />
          <a-button v-if="mode === 'create'" :loading="pathPickerLoading" @click="openDirectoryPicker">
            <template #icon><FolderOpenOutlined /></template>
            浏览目录
          </a-button>
        </div>
        <a-alert v-if="pathPickerError" type="error" show-icon :message="pathPickerError" />
        <div v-if="pathDescription" class="create-workspace-modal__path-hint">{{ pathDescription }}</div>
      </a-form-item>
    </a-form>

    <section v-if="profileVisible" class="create-workspace-modal__profile">
      <div class="create-workspace-modal__profile-header">
        <div>
          <div class="create-workspace-modal__profile-title">当前工作区我的执行 Profile</div>
          <div class="create-workspace-modal__profile-subtitle">
            按当前工作区保存，供 AI 读取执行偏好；禁止填写密码、token、私钥。
          </div>
        </div>
        <a-tag :color="profileStatusColor">{{ profileStatusText }}</a-tag>
      </div>

      <a-alert
        v-if="profileError"
        type="warning"
        show-icon
        :message="profileError"
        class="create-workspace-modal__profile-alert"
      />

      <a-textarea
        v-model:value="profileText"
        :rows="12"
        :disabled="profileLoading || profileSaving || Boolean(profileError)"
        placeholder="例如：本工作区 Git author、文档目录偏好、分支命名约定、代码风格要求。不要填写任何可直接授权的凭据。"
      />

      <div class="create-workspace-modal__profile-meta">
        <span>更新时间：{{ profileUpdatedAtText }}</span>
        <span>Profile 按工作区保存，本阶段不跨工作区、不跨 Client 自动同步。</span>
      </div>

      <div class="create-workspace-modal__profile-actions">
        <a-button :loading="profileLoading" :disabled="profileSaving" @click="onProfileRefresh">刷新 Profile</a-button>
        <a-button type="primary" :loading="profileSaving" :disabled="profileSaveDisabled" @click="onProfileSave">
          保存 Profile
        </a-button>
      </div>
    </section>
    </div>
  </a-modal>
  <ClientDirectoryPickerModal
    v-model:open="pathPickerOpen"
    :client-id="clientId"
    :initial-value="path"
    @pick="onDirectoryPicked"
  />
</template>

<style scoped>
.create-workspace-modal__layout {
  display: grid;
  gap: 18px;
}

.create-workspace-modal__layout--with-profile {
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.9fr);
  align-items: start;
}

.create-workspace-modal__form {
  min-width: 0;
}

.create-workspace-modal__path-row {
  display: flex;
  gap: 8px;
}

.create-workspace-modal__path-row :deep(.ant-input-affix-wrapper) {
  flex: 1;
}

.create-workspace-modal__path-row :deep(.ant-btn) {
  flex: 0 0 auto;
}

.create-workspace-modal__path-hint {
  margin-top: 6px;
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.6;
  word-break: break-all;
}

.create-workspace-modal__profile {
  min-width: 0;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  padding: 14px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-accent) 6%);
}

.create-workspace-modal__profile-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.create-workspace-modal__profile-title {
  font-weight: 700;
  color: var(--app-text);
}

.create-workspace-modal__profile-subtitle {
  margin-top: 4px;
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.5;
}

.create-workspace-modal__profile-alert {
  margin-bottom: 10px;
}

.create-workspace-modal__profile-meta {
  display: grid;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.5;
}

.create-workspace-modal__profile-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

@media (max-width: 768px) {
  .create-workspace-modal__layout--with-profile {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
