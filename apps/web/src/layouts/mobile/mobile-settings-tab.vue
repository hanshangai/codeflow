<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { useRouter } from "vue-router";
import { message, Modal } from "ant-design-vue";
import {
  BarChartOutlined,
  BellOutlined,
  BulbFilled,
  BulbOutlined,
  ClusterOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  KeyOutlined,
  LinkOutlined,
  LogoutOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ToolOutlined,
  UserOutlined,
} from "@ant-design/icons-vue";

import { APP_MODALS_KEY } from "../../services/appModals";
import { isDesktopWorkspace } from "../../services/desktop";
import { WS_CLIENT_KEY } from "../../services/ws";
import { pushLoginRoute } from "../../features/account/loginRedirect";
import { resolveSystemScope } from "../../features/admin/systemPanelAccess";
import { useConfigStore } from "../../store/config";
import { usePresenceStore } from "../../store/presence";
import { useUiStore, type MobileEntrySurface } from "../../store/ui";
import { useAccountStore } from "../../store/account";
import { useWorkspacesStore } from "../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../utils/workspaceId";
import { resolveWorkspaceRuntimeDisplay } from "../../utils/workspaceRuntimeDisplay";

defineOptions({ name: "MobileSettingsTab" });

const props = withDefaults(defineProps<{ entrySurface?: MobileEntrySurface }>(), {
  entrySurface: "standard",
});

const emit = defineEmits<{
  (e: "navigate", entry: { type: "settings"; context: Record<string, unknown> } | { type: "admin"; context?: Record<string, unknown> }): void;
  (e: "logout"): void;
}>();

const config = useConfigStore();
const presence = usePresenceStore();
const ui = useUiStore();
const account = useAccountStore();
const workspaces = useWorkspacesStore();
const ws = inject(WS_CLIENT_KEY, null);
const appModals = inject(APP_MODALS_KEY, null);
const router = useRouter();

const connectError = ref<string | null>(null);

const connectionStatusText = computed(() => {
  if (config.connectionStatus === "connected") return "已连接";
  if (config.connectionStatus === "connecting") return "连接中";
  if (config.connectionStatus === "reconnecting") return "重连中";
  return "未连接";
});
const workspaceRuntimeDisplay = computed(() => resolveWorkspaceRuntimeDisplay(
  presence.activeWorkspaceRuntimeState,
  presence.accountClientState,
));

const themeLabel = computed(() => {
  if (ui.themeMode === "light") return "亮色";
  if (ui.themeMode === "dark") return "暗色";
  return "自动";
});

const ThemeIcon = computed(() => {
  if (ui.themeMode === "dark") return BulbFilled;
  return BulbOutlined;
});

const isAccountLoggedIn = computed(() => config.authMode === "account" && Boolean(config.userSummary));
const isH5Surface = computed(() => props.entrySurface === "h5");
const hasWorkspace = computed(() => Boolean(String(config.workspaceId ?? "").trim()));
const isCurrentSharedWorkspace = computed(() => {
  const workspaceId = String(config.workspaceId ?? "").trim();
  if (!workspaceId) return false;
  const workspace = workspaces.byId.get(workspaceId as any) ?? null;
  return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
});
const systemScope = computed(() =>
  resolveSystemScope({
    accountRole: config.accountRole,
    enterpriseId: config.userSummary?.enterpriseId ?? null,
  }),
);
const systemEntryDescription = computed(() => {
  if (!isAccountLoggedIn.value) return "请先使用邮箱账号登录";
  switch (systemScope.value) {
    case "super_admin":
      return "系统设置、平台管理与系统运维";
    case "enterprise_admin":
      return "设置、企业管理、订单信息与操作审计";
    case "enterprise_member":
      return "设置";
    default:
      return "设置与订单信息";
  }
});

/** 退出仅撤销当前 CodeFlow 会话，办公平台绑定保持不变。 */
function confirmLogout(): void {
  Modal.confirm({
    title: "退出当前账号？",
    content: "退出后将返回登录页，企业微信和钉钉绑定不会解除。",
    okText: "退出登录",
    cancelText: "取消",
    okType: "danger",
    onOk: () => emit("logout"),
  });
}


const connect = async () => {
  connectError.value = null;
  try {
    await ws?.connect();
  } catch (e) {
    connectError.value = e instanceof Error ? e.message : String(e);
    message.error(connectError.value);
  }
};
</script>

<template>
  <div class="mobile-workspace">
    <div class="mobile-workspace__status">
      <div class="mobile-workspace__status-text">
        <span class="mobile-workspace__status-dot" :class="config.connected ? 'mobile-workspace__status-dot--ok' : 'mobile-workspace__status-dot--err'" />
        Server: {{ connectionStatusText }}
        <template v-if="config.connected">
          <span class="mobile-workspace__status-sep">|</span>
          <span class="mobile-workspace__status-dot" :class="workspaceRuntimeDisplay.tone === 'online' ? 'mobile-workspace__status-dot--ok' : 'mobile-workspace__status-dot--warn'" />
          {{ workspaceRuntimeDisplay.label }}
        </template>
      </div>
      <a-space size="small">
        <a-button v-if="!config.connected && config.hasActiveSession" type="primary" size="small" @click="connect">重试连接</a-button>
        <a-button v-else-if="!config.connected && !config.hasActiveSession" type="primary" size="small" @click="pushLoginRoute(router)">去登录</a-button>
      </a-space>
    </div>

    <a-alert
      v-if="connectError"
      type="error"
      :message="connectError"
      show-icon
      closable
      @close="connectError = null"
      style="margin: 0 16px 10px"
    />

    <div class="mobile-action-list">
      <div class="mobile-action-list__title">账号</div>

      <button class="mobile-action-item" :disabled="!isAccountLoggedIn" @click="account.openAccountDrawer()">
        <UserOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">账号中心</span>
        <span class="mobile-action-item__desc">{{ isAccountLoggedIn ? '查看套餐、Key 与密码修改' : '请先使用邮箱账号登录' }}</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button
        v-if="isH5Surface"
        class="mobile-action-item"
        :disabled="!isAccountLoggedIn"
        @click="emit('navigate', { type: 'settings', context: { tab: 'office-bindings' } })"
      >
        <LinkOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">办公平台账号绑定</span>
        <span class="mobile-action-item__desc">绑定企业微信或钉钉，启用免密登录</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button v-if="isH5Surface && isAccountLoggedIn" class="mobile-action-item" @click="confirmLogout">
        <LogoutOutlined class="mobile-action-item__icon" style="color: #b42318" />
        <span class="mobile-action-item__label" style="color: #b42318">退出登录</span>
        <span class="mobile-action-item__desc">保留办公平台绑定，仅退出当前会话</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>
    </div>

    <div class="mobile-action-list">
      <div class="mobile-action-list__title">配置</div>
      <button v-if="config.isDesktop" class="mobile-action-item" @click="emit('navigate', { type: 'settings', context: { tab: 'scheduled-tasks' } })">
        <ClockCircleOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">定时任务</span>
      </button>

      <button v-if="config.isDesktop" class="mobile-action-item" @click="emit('navigate', { type: 'settings', context: { tab: 'app-update' } })">
        <ReloadOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">应用更新</span>
        <span class="mobile-action-item__desc">查看本机更新状态与诊断</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button class="mobile-action-item" :disabled="!config.canManageWorkspaces" @click="emit('navigate', { type: 'settings', context: { tab: 'workspaces' } })">
        <ClusterOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">工作区管理</span>
        <span class="mobile-action-item__desc">选择、新建与管理工作区</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button
        v-if="isH5Surface"
        class="mobile-action-item"
        :disabled="!config.connected || !isAccountLoggedIn"
        @click="emit('navigate', { type: 'settings', context: { tab: 'message-notifications' } })"
      >
        <BellOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">企业微信与钉钉通知</span>
        <span class="mobile-action-item__desc">配置群机器人 Webhook 与通知接收人</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button class="mobile-action-item" :disabled="!(config.connected || isDesktopWorkspace(config, config.workspaceId))" @click="emit('navigate', { type: 'settings', context: { tab: 'engine-keys' } })">
        <KeyOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">大模型 KEY 设置</span>
        <span class="mobile-action-item__desc">引擎密钥配置</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button
        class="mobile-action-item"
        :disabled="!config.connected"
        @click="emit('navigate', { type: 'settings', context: { tab: 'client-management' } })"
      >
        <ClusterOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">设备与运行状态</span>
        <span class="mobile-action-item__desc">查看设备及关联工作区</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button class="mobile-action-item" :disabled="!(config.connected || isDesktopWorkspace(config, config.workspaceId)) || !hasWorkspace" @click="emit('navigate', { type: 'settings', context: { tab: 'codeflowai-config' } })">
        <ToolOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">CodeFlow 配置</span>
        <span class="mobile-action-item__desc">{{ hasWorkspace ? 'CodeFlow 功能参数' : '请先创建或选择工作区' }}</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

      <button class="mobile-action-item" @click="appModals?.toggleTheme()">
        <component :is="ThemeIcon" class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">主题</span>
        <span class="mobile-action-item__desc">当前：{{ themeLabel }}</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>
    </div>

    <div class="mobile-action-list">
      <div class="mobile-action-list__title">工具</div>

      <button class="mobile-action-item" :disabled="!config.connected || !hasWorkspace || isCurrentSharedWorkspace" @click="emit('navigate', { type: 'settings', context: { tab: 'terminal' } })">
        <CodeOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">终端</span>
        <span class="mobile-action-item__desc">{{ !hasWorkspace ? '请先创建或选择工作区' : isCurrentSharedWorkspace ? '共享工作区不可使用终端' : '管理和操作终端' }}</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>

    </div>

    <div class="mobile-action-list">
      <div class="mobile-action-list__title">业务</div>

      <button class="mobile-action-item" :disabled="!isAccountLoggedIn" @click="emit('navigate', { type: 'admin', context: { panel: 'orchestration-metrics' } })">
        <BarChartOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">编排度量</span>
        <span class="mobile-action-item__desc">查看执行趋势、流程效率与规格质量</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>
    </div>

    <div class="mobile-action-list">
      <div class="mobile-action-list__title">系统</div>

      <button class="mobile-action-item" :disabled="!isAccountLoggedIn" @click="emit('navigate', { type: 'admin' })">
        <SafetyCertificateOutlined class="mobile-action-item__icon" />
        <span class="mobile-action-item__label">系统</span>
        <span class="mobile-action-item__desc">{{ systemEntryDescription }}</span>
        <span class="mobile-action-item__arrow">→</span>
      </button>
    </div>
  </div>
</template>
