<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "../styles/admin-table.css";
import {
  ApartmentOutlined,
  AreaChartOutlined,
  BarChartOutlined,
  CreditCardOutlined,
  ClockCircleOutlined,
  FolderOutlined,
  KeyOutlined,
  DownOutlined,
  MessageOutlined,
  RightOutlined,
  SettingOutlined,
} from "@ant-design/icons-vue";

import { useConfigStore } from "../../../store/config";
import { useAdminStore, type AdminPanel } from "../../../store/admin";
import { useUiStore } from "../../../store/ui";
import AdminSettingsPanel from "./admin-settings-panel.vue";
import AdminEngineKeysPanel from "./admin-engine-keys-panel.vue";
import AccountRelayUsagePanel from "./account-relay-usage-panel.vue";
import AdminMobileSettingsPanel from "./admin-mobile-settings-panel.vue";
import AdminScheduledTasksPanel from "./AdminScheduledTasksPanel.vue";
import DesktopScheduledTasksPanel from "../../settings/components/desktop-scheduled-tasks-panel.vue";
import SharedWorkspacePanel from "./shared-workspace-panel.vue";
import RelayPricingReadonlyPanel from "./relay-pricing-readonly-panel.vue";
import AdminSessionsPanel from "./admin-sessions-panel.vue";
import EnterpriseManagementPanel from "./enterprise-management-panel.vue";
import EnterpriseTokenPanel from "./enterprise-token-panel.vue";
import EnterpriseAuditPanel from "./enterprise-audit-panel.vue";
import {
  isPublicPanel,
  isMigratedAdminPanel,
  resolveAdminConsoleUrl,
  resolveAllowedSystemPanels,
  resolveAvailableSystemPanels,
  resolveFallbackSystemPanel,
  resolveRouteSystemPanel,
  resolveSystemGroupLabels,
  resolveSystemScope,
  type SystemPanelGroup,
} from "../systemPanelAccess";

defineOptions({ name: "AdminLayout" });

const AccountOrderInfoPackagesPanel = defineAsyncComponent(() => import("./account-order-info-packages-panel.vue"));
const AccountOrderInfoPaymentOrdersPanel = defineAsyncComponent(() => import("./account-order-info-payment-orders-panel.vue"));
const OrchestrationMetricsEntry = defineAsyncComponent(() => import("../../orchestration-metrics/OrchestrationMetricsEntry.vue"));

const admin = useAdminStore();
const ui = useUiStore();
const config = useConfigStore();
const route = useRoute();
const router = useRouter();

type AdminGroupKey = SystemPanelGroup;
type AdminMenuItem = { key: AdminPanel; label: string; icon: any; group: AdminGroupKey };

const adminGroupMeta: Array<{ key: AdminGroupKey }> = [
  { key: "settings" },
  { key: "enterprise" },
  { key: "platform" },
  { key: "analytics" },
];

const iconMap: Partial<Record<AdminPanel, any>> = {
  settings: SettingOutlined,
  workspaces: FolderOutlined,
  "engine-keys": KeyOutlined,
  "relay-self-usage": AreaChartOutlined,
  "relay-price-config": CreditCardOutlined,
  "message-notifications": MessageOutlined,
  "scheduled-tasks": ClockCircleOutlined,
  "orchestration-metrics": BarChartOutlined,
  sessions: KeyOutlined,
  packages: CreditCardOutlined,
  "payment-orders": CreditCardOutlined,
  "enterprise-member-management": KeyOutlined,
  "enterprise-token": CreditCardOutlined,
  "shared-workspaces": FolderOutlined,
  "enterprise-audit": KeyOutlined,
};

const adminGroupOpen = ref<Record<AdminGroupKey, boolean>>({
  settings: true,
  enterprise: true,
  platform: true,
  analytics: true,
});

const systemScope = computed(() =>
  resolveSystemScope({
    accountRole: config.accountRole,
    enterpriseId: config.userSummary?.enterpriseId ?? null,
  }),
);
/** 桌面未登录时按个人范围展示，已登录才使用真实账号范围。 */
const hasServerSession = computed(() => config.hasActiveSession);
const effectiveSystemScope = computed(() => hasServerSession.value ? systemScope.value : "personal_user");
const systemGroupLabels = computed(() => resolveSystemGroupLabels(effectiveSystemScope.value));
const panelAvailability = computed(() => ({}));
const isMigratedSuperAdmin = computed(() => isMigratedAdminPanel(effectiveSystemScope.value, route.query.panel));
/** 使用当前 Server 打开系统浏览器控制台，不携带公开端会话令牌。 */
function openAdminConsole(): void { window.open(resolveAdminConsoleUrl(config.serverWsOrigin), "_blank", "noopener"); }
const internalScrollPanels = new Set<AdminPanel>([
  "engine-keys",
  "scheduled-tasks",
  "sessions",
  "payment-orders",
  "payment-management",
  "audit",
  "enterprise-audit",
  "email",
  "desktop-crash-reports",
]);
/** 内部已有固定表格滚动的面板关闭内容区滚动，避免页面与列表出现双滚动条。 */
const contentUsesInternalScroll = computed(() => !activePanelNeedsLogin.value && internalScrollPanels.has(admin.activePanel));
const compactFlowPanels = new Set<AdminPanel>([
  "settings",
]);
/** 桌面度量由入口区分本机事实与云端登录，其余面板沿原认证边界。 */
const activePanelNeedsLogin = computed(() => !hasServerSession.value && !isPublicPanel(admin.activePanel)
  && !(config.isDesktop && admin.activePanel === "orchestration-metrics"));
/** 表单型设置页与登录提示按内容自然高度排列，避免外层 flex 拉出大块空白。 */
const contentUsesCompactFlow = computed(() => compactFlowPanels.has(admin.activePanel) || activePanelNeedsLogin.value);

/** 账号或登录态变化时重建保活面板缓存，避免展示上一个账号的数据。 */
const settingsPanelsScopeKey = computed(() => [
  config.serverWsOrigin,
  config.userSummary?.userId ?? "",
  config.hasActiveSession ? "signed" : "guest",
].join("|"));

const menuItems = computed<AdminMenuItem[]>(() =>
  resolveAvailableSystemPanels(effectiveSystemScope.value, panelAvailability.value).map((item) => ({
    ...item,
    icon: iconMap[item.key] ?? SettingOutlined,
  })),
);
const allowedPanels = computed(() => resolveAllowedSystemPanels(effectiveSystemScope.value, panelAvailability.value));

const groupedMenuSections = computed(() =>
  adminGroupMeta
    .map((group) => ({
      ...group,
      label: systemGroupLabels.value[group.key],
      items: menuItems.value.filter((item) => item.group === group.key),
    }))
    .filter((group) => group.items.length > 0),
);

function toggleAdminGroup(groupKey: AdminGroupKey): void {
  adminGroupOpen.value[groupKey] = !adminGroupOpen.value[groupKey];
}

function groupHasActivePanel(groupItems: AdminMenuItem[]): boolean {
  return groupItems.some((item) => item.key === admin.activePanel);
}

/** 判断面板是否属于当前可见菜单，非菜单面板不覆盖返回设置时的记忆。 */
function isVisibleMenuPanel(panel: AdminPanel): boolean {
  return menuItems.value.some((item) => item.key === panel);
}

/** 可见菜单面板进入时记录最近选择，供度量等独立面板返回设置复用。 */
function rememberVisibleMenuPanel(panel: AdminPanel): void {
  if (isVisibleMenuPanel(panel)) admin.rememberMenuPanel(panel);
}

/** 通过 URL 切换后台面板，使刷新后仍停留在当前页面，并记录可见菜单选择。 */
async function selectAdminPanel(panel: AdminPanel): Promise<void> {
  if (route.query.panel !== panel) await router.replace({ query: { ...route.query, panel } });
  rememberVisibleMenuPanel(panel);
  if (admin.activePanel !== panel) admin.setPanel(panel);
}

/** 从 /admin?panel=xxx 读取合法面板，不可见或非法 key 返回 null。 */
function resolveRoutePanel(allowedPanels: AdminPanel[]): AdminPanel | null {
  const raw = route.query.panel;
  const panel = Array.isArray(raw) ? raw[0] : raw;
  if (typeof panel !== "string" || !panel.trim()) return null;
  return resolveRouteSystemPanel(panel as AdminPanel, allowedPanels);
}

/** 判断 URL 是否显式指定后台面板，用于区分缺省入口和非法深链。 */
function hasRoutePanelQuery(): boolean {
  const raw = route.query.panel;
  const panel = Array.isArray(raw) ? raw[0] : raw;
  return typeof panel === "string" && panel.trim().length > 0;
}

/** 无 panel 参数进入后台时保留上次可见菜单；非法或不可见面板仍回退首个菜单。 */
function resolveFallbackPanel(allowedPanels: AdminPanel[]): AdminPanel {
  if (!hasRoutePanelQuery()) {
    return resolveFallbackSystemPanel({
      menuPanels: menuItems.value.map((item) => item.key),
      allowedPanels,
      lastMenuPanel: admin.lastMenuPanel,
      activePanel: admin.activePanel,
      hasServerSession: hasServerSession.value,
    });
  }
  return menuItems.value[0]?.key ?? allowedPanels[0]!;
}

/** 在路由、权限与当前面板之间保持单一有效状态。 */
watch(
  [allowedPanels, () => route.query.panel, () => admin.activePanel, () => ui.mainView],
  ([panels]) => {
    if (ui.mainView !== "admin") return;
    if (isMigratedSuperAdmin.value) return;
    if (!panels.length) return;
    const requestedPanel = resolveRoutePanel(panels);
    if (requestedPanel) {
      rememberVisibleMenuPanel(requestedPanel);
      if (requestedPanel !== admin.activePanel) admin.setPanel(requestedPanel);
      return;
    }
    const nextPanel = resolveFallbackPanel(panels);
    if (nextPanel !== admin.activePanel) admin.setPanel(nextPanel);
    if (route.query.panel !== nextPanel) void router.replace({ query: { ...route.query, panel: nextPanel } });
  },
  { immediate: true },
);

</script>

<template>
  <div class="admin-layout">
    <div v-if="admin.activePanel !== 'orchestration-metrics'" class="admin-layout__sidebar">
      <nav class="admin-layout__nav">
        <section
          v-for="group in groupedMenuSections"
          :key="group.key"
          class="admin-layout__nav-group"
          :class="{ 'admin-layout__nav-group--active': groupHasActivePanel(group.items) }"
        >
          <button class="admin-layout__nav-group-toggle" type="button" @click="toggleAdminGroup(group.key)">
            <span>{{ group.label }}</span>
            <component :is="adminGroupOpen[group.key] ? DownOutlined : RightOutlined" />
          </button>
          <div v-show="adminGroupOpen[group.key]" class="admin-layout__nav-group-items">
            <button
              v-for="item in group.items"
              :key="item.key"
              class="admin-layout__nav-item"
              :class="{ 'admin-layout__nav-item--active': admin.activePanel === item.key }"
              @click="selectAdminPanel(item.key)"
            >
              <span class="admin-layout__nav-item-icon">
                <component :is="item.icon" />
              </span>
              <span class="admin-layout__nav-item-label">{{ item.label }}</span>
            </button>
          </div>
        </section>
      </nav>
    </div>
    <div
      class="admin-layout__content"
      :class="{
        'admin-layout__content--sessions': admin.activePanel === 'sessions',
        'admin-layout__content--orchestration-metrics': admin.activePanel === 'orchestration-metrics',
        'admin-layout__content--internal-scroll': contentUsesInternalScroll,
        'admin-layout__content--compact-flow': contentUsesCompactFlow,
      }"
    >
      <div v-if="isMigratedSuperAdmin" class="admin-layout__migration-notice">
        <a-result status="info" title="超级管理员功能已迁至管理控制台">
          <template #subTitle>请使用管理控制台访问平台级配置、审计和运营能力。</template>
          <template #extra>
            <a-button type="primary" @click="openAdminConsole">打开管理控制台</a-button>
          </template>
        </a-result>
      </div>
      <div v-else-if="activePanelNeedsLogin" class="admin-layout__login-hint">
        <a-empty>
          <template #description>
            <div class="admin-layout__login-hint-title">
              {{ admin.activePanel === 'orchestration-metrics' ? '登录后查看度量' : '登录后可用' }}
            </div>
          </template>
        </a-empty>
      </div>
      <SharedWorkspacePanel v-else-if="admin.activePanel === 'shared-workspaces'" />
      <EnterpriseManagementPanel v-else-if="admin.activePanel === 'enterprise-member-management'" />
      <EnterpriseTokenPanel v-else-if="admin.activePanel === 'enterprise-token'" />
      <EnterpriseAuditPanel v-else-if="admin.activePanel === 'enterprise-audit'" />
      <AdminSessionsPanel v-else-if="admin.activePanel === 'sessions'" />
      <AccountOrderInfoPackagesPanel v-else-if="AccountOrderInfoPackagesPanel && admin.activePanel === 'packages'" />      <!-- 度量面板需保活：KeepAlive 不能作为 v-else-if 分支（会随分支一起卸载而丢缓存），故独立于上方面板链渲染。 -->
      <KeepAlive v-if="!isMigratedSuperAdmin">
        <OrchestrationMetricsEntry v-if="admin.activePanel === 'orchestration-metrics' && (config.isDesktop || hasServerSession)" />
      </KeepAlive>
      <!-- 设置分组首次进入后保活：切换菜单复用组件实例，不重新挂载和加载；账号变化时整体重建缓存。 -->
      <KeepAlive v-if="!isMigratedSuperAdmin" :key="settingsPanelsScopeKey">
        <AdminSettingsPanel v-if="admin.activePanel === 'settings'" key="settings" view="settings" />
        <AdminSettingsPanel v-else-if="admin.activePanel === 'workspaces'" key="workspaces" view="workspaces" />
        <AdminEngineKeysPanel v-else-if="admin.activePanel === 'engine-keys'" key="engine-keys" />
        <AccountRelayUsagePanel v-else-if="admin.activePanel === 'relay-self-usage' && hasServerSession" key="relay-self-usage" />
        <AdminMobileSettingsPanel v-else-if="admin.activePanel === 'message-notifications' && hasServerSession" key="message-notifications" />
        <DesktopScheduledTasksPanel v-else-if="admin.activePanel === 'scheduled-tasks' && config.isDesktop" key="scheduled-tasks-desktop" />
        <AdminScheduledTasksPanel v-else-if="admin.activePanel === 'scheduled-tasks'" key="scheduled-tasks" />
          <AccountOrderInfoPaymentOrdersPanel v-else-if="admin.activePanel === 'payment-orders' && hasServerSession && AccountOrderInfoPaymentOrdersPanel" key="payment-orders" />
        <RelayPricingReadonlyPanel v-else-if="admin.activePanel === 'relay-price-config'" key="relay-price-config" />
      </KeepAlive>
    </div>
  </div>
</template>

<style scoped>
.admin-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  background: var(--app-bg);
}

.admin-layout__sidebar {
  width: 220px;
  min-width: 220px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-divider);
  background: var(--app-sidebar-bg);
}

.admin-layout__nav {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 10px 8px;
  gap: 8px;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--app-primary, #1677ff) 22%, transparent) transparent;
}

.admin-layout__nav::-webkit-scrollbar {
  width: 8px;
}

.admin-layout__nav::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 22%, transparent);
}

.admin-layout__nav::-webkit-scrollbar-track {
  background: transparent;
}

.admin-layout__nav-group {
  flex: 0 0 auto;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 78%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, #f7f9fc);
  overflow: hidden;
}

.admin-layout__nav-group--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 22%, var(--app-border, #d9d9d9));
}

.admin-layout__nav-group-toggle {
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: none;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, #f2f4f7);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 700;
  color: color-mix(in srgb, var(--app-text, #1f2937) 75%, #4b5563);
  cursor: pointer;
}

.admin-layout__nav-group-toggle:hover {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
  color: color-mix(in srgb, var(--app-primary, #1677ff) 62%, var(--app-text, #1f2937));
}

.admin-layout__nav-group-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
}

.admin-layout__nav-item {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  color: var(--app-muted);
  transition: all 0.15s;
  text-align: left;
}

.admin-layout__nav-item:hover {
  background: var(--app-sidebar-hover-bg);
  color: var(--app-text);
}

.admin-layout__nav-item--active {
  background: var(--app-sidebar-active-bg);
  color: var(--app-accent);
  font-weight: 600;
}

.admin-layout__nav-item--active:hover {
  background: var(--app-sidebar-active-bg);
  color: var(--app-accent);
}

.admin-layout__nav-item-icon {
  width: auto;
  height: auto;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  color: inherit;
}

.admin-layout__nav-item-label {
  min-width: 0;
  font-weight: inherit;
}

.admin-layout__content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  overflow: auto;
  padding: 24px;
}

.admin-layout__content--internal-scroll {
  overflow: hidden;
}

.admin-layout__content {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.admin-layout__content--compact-flow {
  flex: 0 0 auto;
}

/* 登录提示与聊天页空态一致：在内容区中央展示，不挤在顶部。 */
.admin-layout__content--compact-flow > .admin-layout__login-hint {
  flex: 1 1 auto;
}

.admin-layout__login-hint {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  padding: 24px;
  box-sizing: border-box;
}

.admin-layout__login-hint :deep(.ant-empty) {
  margin: 0;
  max-width: 460px;
}

.admin-layout__login-hint :deep(.ant-empty-description) {
  margin-top: 4px;
  white-space: normal;
}

.admin-layout__login-hint-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text);
}



.admin-layout__content--sessions {
  padding-top: 0;
}

.admin-layout__content--orchestration-metrics {
  padding-top: 12px;
  overflow: hidden;
}
</style>
