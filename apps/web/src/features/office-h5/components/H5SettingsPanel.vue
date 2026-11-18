<script setup lang="ts">
import { computed } from "vue";
import {
  BellRing,
  ChartNoAxesCombined,
  Clock3,
  KeyRound,
  LogOut,
  PanelsTopLeft,
  ReceiptText,
  RefreshCw,
  UserRound,
} from "lucide-vue-next";

import { useConfigStore } from "../../../store/config";
import type { AccountDrawerTab } from "../../../store/account";
import { useUiStore, type MobilePageEntry, type ThemeMode } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { getWorkspaceDisplayTitle } from "../../../utils/workspaceDisplay";
import { isDesktopWorkspace } from "../../../services/desktop";

defineOptions({ name: "H5SettingsPanel" });
withDefaults(defineProps<{ embedded?: boolean }>(), { embedded: false });

const emit = defineEmits<{
  (event: "navigate", entry: MobilePageEntry): void;
  (event: "account", tab: AccountDrawerTab): void;
  (event: "logout"): void;
}>();

const config = useConfigStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();

const currentWorkspace = computed(() => config.workspaceId ? workspaces.byId.get(config.workspaceId) ?? null : null);
const workspaceLabel = computed(() => currentWorkspace.value ? getWorkspaceDisplayTitle(currentWorkspace.value) : "未选择");
type ProfileSettingTab = "workspaces" | "engine-keys" | "relay-self-usage" | "orders" | "message-notifications" | "scheduled-tasks" | "app-update";

const themeOptions: Array<{ key: ThemeMode; label: string }> = [
  { key: "light", label: "亮色" },
  { key: "dark", label: "暗色" },
  { key: "auto", label: "自动" },
];

/** 打开头像设置的二级页，并标记返回目标为当前设置层。 */
function navigateSetting(tab: ProfileSettingTab): void {
  emit("navigate", { type: "settings", context: { tab, returnTo: "profile-settings" } });
}

/** 切换 H5 主题并沿用全局主题持久化状态。 */
function setTheme(mode: ThemeMode): void {
  ui.setThemeMode(mode);
}
</script>

<template>
  <section class="h5-settings" :class="{ 'h5-settings--embedded': embedded }" aria-label="设置">
    <header v-if="!embedded" class="h5-settings__header">
      <div>
        <h1>设置</h1>
        <p>个人偏好与工作环境</p>
      </div>
    </header>

    <div class="h5-settings__scroll">
      <section class="h5-settings__section">
        <div class="h5-settings__group" aria-label="工作台设置">
          <button v-if="config.isDesktop" type="button" @click="navigateSetting('scheduled-tasks')">
            <span class="h5-settings__row-icon"><Clock3 /></span>
            <span class="h5-settings__row-copy"><strong>定时任务</strong></span>
          </button>
          <button v-if="config.isDesktop" type="button" @click="navigateSetting('app-update')">
            <span class="h5-settings__row-icon"><RefreshCw /></span>
            <span class="h5-settings__row-copy"><strong>应用更新</strong></span>
          </button>
          <button type="button" @click="navigateSetting('workspaces')">
            <span class="h5-settings__row-icon h5-settings__row-icon--workspace"><PanelsTopLeft /></span>
            <span class="h5-settings__row-copy"><strong>工作区管理</strong><small>{{ workspaceLabel }}</small></span>
          </button>
          <button type="button" :disabled="!(config.connected || isDesktopWorkspace(config, config.workspaceId))" @click="navigateSetting('engine-keys')">
            <span class="h5-settings__row-icon h5-settings__row-icon--keys"><KeyRound /></span>
            <span class="h5-settings__row-copy"><strong>模型与密钥</strong><small>引擎密钥配置</small></span>
          </button>
          <button type="button" :disabled="!config.userSummary" @click="navigateSetting('relay-self-usage')">
            <span class="h5-settings__row-icon h5-settings__row-icon--usage"><ChartNoAxesCombined /></span>
            <span class="h5-settings__row-copy"><strong>流量统计</strong><small>余额、用量与消费趋势</small></span>
          </button>
          <button type="button" :disabled="!config.userSummary" @click="navigateSetting('orders')">
            <span class="h5-settings__row-icon h5-settings__row-icon--orders"><ReceiptText /></span>
            <span class="h5-settings__row-copy"><strong>支付订单</strong><small>订单记录与发票</small></span>
          </button>
          <button type="button" :disabled="!config.connected" @click="navigateSetting('message-notifications')">
            <span class="h5-settings__row-icon h5-settings__row-icon--notifications"><BellRing /></span>
            <span class="h5-settings__row-copy"><strong>消息通知</strong><small>{{ config.connected ? '提醒方式与接收范围' : '连接服务后可设置' }}</small></span>
          </button>
        </div>
      </section>

      <section class="h5-settings__section">
        <div class="h5-settings__group" aria-label="个人中心">
          <button type="button" @click="emit('account', 'overview')">
            <span class="h5-settings__row-icon h5-settings__row-icon--profile"><UserRound /></span>
            <span class="h5-settings__row-copy"><strong>个人信息</strong><small>头像、姓名、手机号与账号 Key</small></span>
          </button>
        </div>
      </section>

      <section class="h5-settings__section">
        <div class="h5-settings__theme" role="group" aria-label="亮暗模式">
          <button
            v-for="option in themeOptions"
            :key="option.key"
            type="button"
            :aria-pressed="ui.themeMode === option.key"
            :class="{ active: ui.themeMode === option.key }"
            @click="setTheme(option.key)"
          >
            <span>{{ option.label }}</span>
          </button>
        </div>
      </section>

      <section class="h5-settings__section h5-settings__section--logout">
        <button type="button" :disabled="!config.userSummary" @click="emit('logout')">
          <LogOut :size="18" :stroke-width="1.75" />
          <span>退出登录</span>
        </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.h5-settings {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-bg) 94%, var(--app-panel-bg));
}

.h5-settings--embedded { height: auto; overflow: visible; background: transparent; }
.h5-settings--embedded .h5-settings__scroll { flex: none; overflow: visible; padding: 0 0 16px; }
.h5-settings--embedded .h5-settings__group { box-shadow: none; }

.h5-settings__header {
  flex: 0 0 auto;
  padding: 14px 16px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 70%, transparent);
  background: color-mix(in srgb, var(--app-bg) 86%, transparent);
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
}

.h5-settings__header > div:first-child {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.h5-settings__header h1,
.h5-settings__header p,
.h5-settings__section h2 {
  margin: 0;
  letter-spacing: 0;
}

.h5-settings__header h1 {
  font-size: 21px;
  line-height: 1.25;
  font-weight: 720;
}

.h5-settings__header p {
  color: var(--app-muted);
  font-size: 12px;
}

.h5-settings__row-copy {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.h5-settings__row-copy strong,
.h5-settings__row-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.h5-settings__row-copy small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.35;
}

.h5-settings__scroll {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 6px 14px 18px;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}

.h5-settings__section {
  margin-top: 10px;
}

.h5-settings__section:first-child { margin-top: 0; }

.h5-settings__group {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-divider) 80%, transparent);
  border-radius: 17px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  box-shadow: 0 10px 26px color-mix(in srgb, #000 5%, transparent);
}

.h5-settings__group > button {
  width: 100%;
  min-height: 62px;
  display: grid;
  grid-template-columns: 40px minmax(0, 1fr);
  align-items: center;
  gap: 11px;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 68%, transparent);
  color: var(--app-text);
  background: transparent;
  text-align: left;
}

.h5-settings__group > button:last-child {
  border-bottom: 0;
}

.h5-settings__group > button:active,
.h5-settings__theme button:active {
  background: var(--app-hover);
}

.h5-settings__group > button:disabled {
  opacity: 0.45;
}

.h5-settings__row-icon {
  --icon-color: #3977c6;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 13px;
  color: #fff;
  background: linear-gradient(145deg, color-mix(in srgb, var(--icon-color) 88%, white), var(--icon-color));
  box-shadow: inset 0 1px 0 #ffffff24, 0 3px 8px color-mix(in srgb, var(--icon-color) 16%, transparent);
}

.h5-settings__row-icon :deep(svg) {
  width: 21px;
  height: 21px;
  stroke-width: 1.75;
}

.h5-settings__row-icon--workspace { --icon-color: #287f69; }
.h5-settings__row-icon--keys { --icon-color: #4d6dc4; }
.h5-settings__row-icon--usage { --icon-color: #278798; }
.h5-settings__row-icon--orders { --icon-color: #ae7931; }
.h5-settings__row-icon--notifications { --icon-color: #bb6b43; }

.h5-settings__row-copy strong {
  font-size: 14px;
  line-height: 1.35;
  font-weight: 620;
}

.h5-settings__theme {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
  padding: 4px;
  border: 1px solid color-mix(in srgb, var(--app-divider) 80%, transparent);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
}

.h5-settings__theme button {
  min-width: 0;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 12px;
  color: var(--app-muted);
  background: transparent;
  font-size: 13px;
}

.h5-settings__theme button.active {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-bg));
  box-shadow: 0 4px 12px color-mix(in srgb, #000 7%, transparent);
  font-weight: 650;
}

.h5-settings__section--logout > button {
  width: 100%;
  min-height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, #b42318 20%, var(--app-divider));
  border-radius: 15px;
  color: #b42318;
  background: color-mix(in srgb, #b42318 4%, var(--app-panel-bg));
  font-size: 14px;
  font-weight: 620;
}

.h5-settings button:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: -2px;
}

@media (max-width: 340px) {
  .h5-settings__header {
    padding-inline: 12px;
  }

  .h5-settings__scroll {
    padding-inline: 10px;
  }
}
</style>
