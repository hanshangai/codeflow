<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch, type Component } from "vue";
import { useRoute } from "vue-router";
import type { DesktopBundleUpdatePhase } from "@codeflowai/shared";

import { useAppShell } from "./composables/useAppShell";
import { useAutoUpdateCli } from "./features/settings/composables/useAutoUpdateCli";
import { useBuiltInRelayAutoEnable } from "./features/settings/composables/useBuiltInRelayAutoEnable";
import { useLocalModelSetupGuide } from "./features/settings/composables/useLocalModelSetupGuide";
import { useDefaultThreadAutoCreate } from "./features/threads/useDefaultThreadAutoCreate";
import { resolveStandardApplicationEntryPath } from "./store/ui";
import { resolveAccountH5DeepLink } from "./features/office-h5/accountH5DeepLink";
import { isCancelledRequestError } from "./api/request";
import { DesktopUpdateServiceError, getDesktopUpdateCapabilities, getDesktopUpdateDetails } from "./services/desktop";

const props = withDefaults(defineProps<{ hostStartupActive?: boolean }>(), { hostStartupActive: false });
const emit = defineEmits<{ workbenchReady: [ready: boolean]; desktopBusinessReady: []; desktopStartupStatus: [label: string] }>();
// 围栏内与实际渲染共用布局加载入口，确认资源时不提前挂载业务组件。
const layoutLoaders = {
  mobile: () => import("./layouts/mobile/mobile-layout.vue"),
  tablet: () => import("./layouts/tablet/tablet-layout.vue"),
  desktop: () => import("./layouts/desktop/desktop-layout.vue"),
};
const layoutModules = new Map<keyof typeof layoutLoaders, Promise<{ default: Component }>>();
/** 启动确认与渲染共用同一次导入，避免 Safari 18 并发读取尚未初始化的模块导出。 */
function loadLayout(mode: keyof typeof layoutLoaders): Promise<{ default: Component }> {
  let pending = layoutModules.get(mode);
  if (!pending) { pending = layoutLoaders[mode](); layoutModules.set(mode, pending); }
  return pending;
}
const MobileLayout = defineAsyncComponent(() => loadLayout("mobile"));
const TabletLayout = defineAsyncComponent(() => loadLayout("tablet"));
const DesktopLayout = defineAsyncComponent(() => loadLayout("desktop"));
const LandingPage = defineAsyncComponent(() => import("./features/landing/components/landing-page.vue"));
const BestPracticePage = defineAsyncComponent(() => import("./features/best-practices/components/BestPracticePage.vue"));
const ContactPage = defineAsyncComponent(() => import("./features/landing/components/contact-page.vue"));
const UpgradePage = defineAsyncComponent(() => import("./features/landing/components/upgrade-page.vue"));
const DataSecurityCommitmentPage = defineAsyncComponent(() => import("./features/landing/components/data-security-commitment-page.vue"));
const PaymentVerificationPage = defineAsyncComponent(() => import("./features/payment-verification/components/payment-verification-page.vue"));
const ProjectKnowledgePage = defineAsyncComponent(() => import("./features/project-knowledge/components/project-knowledge-page.vue"));
const AuthLoginPage = defineAsyncComponent(() => import("./features/account/components/auth-login-page.vue"));
const AuthRegisterPage = defineAsyncComponent(() => import("./features/account/components/auth-register-page.vue"));
const AuthForgotPage = defineAsyncComponent(() => import("./features/account/components/auth-forgot-page.vue"));
const AppTopbar = defineAsyncComponent(() => import("./components/app-shell/app-topbar.vue"));
const DesktopWindowBar = defineAsyncComponent(() => import("./components/app-shell/desktop-window-bar.vue"));
const AppShellModals = defineAsyncComponent(() => import("./components/app-shell/app-shell-modals.vue"));
const DesktopAuthModal = defineAsyncComponent(() => import("./features/account/components/desktop-auth-modal.vue"));
const DesktopUpdateCheckModal = defineAsyncComponent(() => import("./features/settings/components/desktop-update-check-modal.vue"));
const DesktopUpdateNoticeModal = defineAsyncComponent(() => import("./features/settings/components/desktop-update-notice-modal.vue"));
const DesktopQuitConfirmModal = defineAsyncComponent(() => import("./features/settings/components/desktop-quit-confirm-modal.vue"));
const LocalModelSetupModal = defineAsyncComponent(() => import("./features/settings/components/local-model-setup-modal.vue"));
const FeedbackModal = defineAsyncComponent(() => import("./features/feedback/components/feedback-modal.vue"));
const PendingPanel = defineAsyncComponent(() => import("./features/office-h5/components/H5PendingPanel.vue"));
const DesktopDownloadPage = defineAsyncComponent(() => import("./features/desktop/components/desktop-download-page.vue"));
const DesktopMigrationPage = defineAsyncComponent(() => import("./features/desktop/components/desktop-migration-page.vue"));
const DesktopMigrationBanner = defineAsyncComponent(() => import("./features/desktop/components/desktop-migration-banner.vue"));

/** 官网导航页共用缓存边界，避免切换时重复挂载和初始化请求。 */
const PUBLIC_SITE_MAIN_VIEWS = new Set([
  "landing",
  "best-practices",
  "guide",
  "contact",
  "upgrade",
  "download",
  "desktop-migration",
]);

defineOptions({ name: "StandardApp" });

const shell = useAppShell();

/** 启动围栏内的升级阶段与估算进度；阶段来自主进程 coordinator 的公开观察。 */
const STARTUP_UPGRADE_PHASES: Partial<Record<DesktopBundleUpdatePhase, { label: string; progress: number }>> = {
  prepare: { label: "正在校验新版本", progress: 15 },
  "read-active": { label: "正在读取当前版本", progress: 20 },
  verify: { label: "正在校验新版本", progress: 30 },
  compatibility: { label: "正在检查兼容性", progress: 40 },
  "prepare-directory": { label: "正在准备升级目录", progress: 50 },
  drain: { label: "正在停止当前服务", progress: 60 },
  "restart-client": { label: "正在切换新版本", progress: 70 },
  "reload-web": { label: "正在加载新版本", progress: 80 },
  health: { label: "正在确认新版本", progress: 90 },
  activate: { label: "正在完成升级", progress: 95 },
  rollback: { label: "正在恢复原版本", progress: 60 },
};
const startupUpgrade = ref<{ label: string; progress: number } | null>(null);
/** 将已有启动阶段传给可见的外层启动页，避免更新提示被遮罩隐藏。 */
const startupLabel = computed(() => shell.config.desktopError ? "启动暂未完成" : startupUpgrade.value?.label
  ?? (shell.config.localRuntimeReady ? "正在加载本地工作区与会话" : "正在启动本地运行环境"));
watch(startupLabel, label => emit("desktopStartupStatus", label), { immediate: true });
let startupUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
let startupUpgradePolling = false;

/** 升级进度只在启动围栏可见期间轮询，启动完成或组件卸载后停止。 */
function scheduleStartupUpgradePoll(): void {
  if (startupUpgradeTimer || startupUpgradePolling || shell.desktopStartupComplete || shell.config.desktopError || !shell.config.isDesktop) return;
  startupUpgradeTimer = setTimeout(() => { startupUpgradeTimer = null; void pollStartupUpgrade(); }, 800);
}

/** 读取主进程更新阶段；读取失败停止轮询并保留普通启动文案，不阻断启动。 */
async function pollStartupUpgrade(): Promise<void> {
  if (startupUpgradePolling || shell.desktopStartupComplete || shell.config.desktopError) return;
  if (!getDesktopUpdateCapabilities().details) return;
  startupUpgradePolling = true;
  try {
    const details = await getDesktopUpdateDetails();
    const phase = details.bundle.phase;
    const next = details.bundle.target && phase ? STARTUP_UPGRADE_PHASES[phase] : undefined;
    startupUpgrade.value = next ? { label: next.label, progress: next.progress } : null;
  } catch (error) {
    console.error("[desktop_startup_upgrade_status_failed]", {
      code: error instanceof DesktopUpdateServiceError ? error.code : "DESKTOP_UPDATE_DETAILS_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  } finally { startupUpgradePolling = false; }
  if (!shell.desktopStartupComplete) scheduleStartupUpgradePoll();
}

onMounted(() => { scheduleStartupUpgradePoll(); });
onBeforeUnmount(() => {
  if (startupUpgradeTimer) clearTimeout(startupUpgradeTimer);
  startupUpgradeTimer = null;
});

let startupFlowCancelled = false;
let layoutGeneration = 0;
let businessReadyEmitted = false;
/** 卸载或真实子树失败后停止续体；业务取消不退休仍在使用的布局。 */
onBeforeUnmount(() => { startupFlowCancelled = true; });
onErrorCaptured((error) => {
  if (isCancelledRequestError(error)) return false;
  startupFlowCancelled = true;
});

/** 确认当前窗口模式对应的布局资源；模式切换后旧请求不能放行新布局。 */
async function confirmCurrentLayout(): Promise<void> {
  if (startupFlowCancelled) return;
  const generation = ++layoutGeneration;
  emit("workbenchReady", false);
  try {
    await loadLayout(shell.mode);
  } catch (error) {
    startupFlowCancelled = true;
    throw error;
  }
  if (startupFlowCancelled || generation !== layoutGeneration) return;
  if (!shell.config.desktopError) emit("workbenchReady", true);
}

/** 业务子树完成挂载或初始化错误页完成渲染后，才关闭视觉启动页。 */
async function emitDesktopBusinessReady(): Promise<void> {
  await nextTick();
  if (startupFlowCancelled || businessReadyEmitted) return;
  businessReadyEmitted = true;
  emit("desktopBusinessReady");
}

onMounted(async () => {
  await confirmCurrentLayout();
});

/** 运行时错误恢复后沿同一入口补做布局确认，不能遗留未发布的就绪事实。 */
watch([() => shell.mode, () => Boolean(shell.config.desktopError)], async () => {
  if (startupFlowCancelled) return;
  await confirmCurrentLayout();
}, { flush: "sync" });

/** 初始化失败显示现有错误页，不能借此确认布局资源健康。 */
watch(
  () => Boolean(shell.config.desktopError),
  async (failed) => { if (failed) await emitDesktopBusinessReady(); },
  { immediate: true },
);

/** 桌面端不再展示全屏认证页：历史 /auth 路由回到工作台并弹出登录框。 */
watch([() => shell.config.isDesktop, () => shell.ui.mainView], ([desktop, view]) => {
  if (!desktop || view !== "auth") return;
  shell.openDesktopAuthModal();
  void shell.router.replace("/chat");
}, { immediate: true });
/** 桌面启动后按设置后台更新已安装 CLI；默认开启，可在基础设置关闭。 */
useAutoUpdateCli();
/** 首次装完 Client 并上线后自动启用一次内置中转 Key（仅 Codex），公开视图不参与。 */
useBuiltInRelayAutoEnable({ publicMainViews: PUBLIC_SITE_MAIN_VIEWS });
/** 没有会话的本地工作区自动创建一次「默认会话」，创建后自动选中并打开；安装向导未完成时不介入。 */
useDefaultThreadAutoCreate({ publicMainViews: PUBLIC_SITE_MAIN_VIEWS });
/** 桌面首次启动且没有可用模型配置时，引导配置 Key 或登录；每次运行最多提示一次。 */
const { guideOpen, dismissGuide, configureGuide, loginGuide } = useLocalModelSetupGuide({
  publicMainViews: PUBLIC_SITE_MAIN_VIEWS,
  settingsOpen: computed(() => shell.settingsOpen),
  workspaceSwitching: computed(() => shell.workspaceSwitching),
  openSettings: () => {
    shell.settingsActiveTab = "engine-keys";
    shell.settingsOpen = true;
  },
  openDesktopAuth: () => shell.openDesktopAuthModal(),
});
const route = useRoute();
const showNotificationPending = computed(() => shell.mode !== "mobile"
  && route.name === "chat" && resolveAccountH5DeepLink(route.query).tab === "pending");
/** 迁移提示关闭只保留在当前页面生命周期，切换视图不重置，刷新页面重新出现。 */
const desktopMigrationBannerDismissed = ref(false);
const showDesktopMigrationBanner = computed(() => !desktopMigrationBannerDismissed.value && !shell.config.isDesktop && shell.mode !== "mobile"
  && !/Android|iPhone|iPad|Mobile|MicroMessenger|wxwork|DingTalk/iu.test(navigator.userAgent)
  && shell.config.hasActiveSession && ["chat", "orchestration", "knowledge", "admin"].includes(shell.ui.mainView));

/** Close a notification target without changing the desktop's current workspace. */
function closeNotificationPending(): void {
  const query = { ...route.query };
  delete query.tab;
  delete query.targetId;
  void shell.router.replace({ path: "/chat", query });
}
/** 仅桌面官网页面切换时启用缓存，移动端继续交由现有布局管理。 */
const isPublicSiteViewActive = computed(() => (
  shell.mode !== "mobile" && PUBLIC_SITE_MAIN_VIEWS.has(shell.ui.mainView)
  && shell.ui.mainView !== "download" && shell.ui.mainView !== "desktop-migration"
));

/** 桌面直接回到应用页，浏览器继续使用原账号入口。 */
function enterApplication() {
  /** 首页进入应用：优先回到离开前的应用页，其次按账号默认首页兜底。 */
  const targetPath = resolveStandardApplicationEntryPath({
    lastAppRoutePath: shell.ui.lastAppRoutePath,
    homePath: shell.config.homePath,
  });
  if (shell.config.isDesktop || (shell.config.authMode === "account" && shell.config.hasActiveSession)) {
    void shell.router.push(targetPath);
    return;
  }
  shell.pushLoginRoute({ redirectPath: targetPath });
}

/** 重新加载沿原启动入口重试，不另建初始化或运行时实例。 */
function retryDesktopStartup(): void {
  window.location.reload();
}

const layoutNode = computed(() => {
  if (shell.mode === "mobile") return MobileLayout;
  if (shell.mode === "tablet") return TabletLayout;
  return DesktopLayout;
});
const layoutListeners = computed(() => (shell.mode === "mobile" ? { logout: shell.logout } : {}));

const authComponent = computed(() => {
  if (route.name === "auth-register") return AuthRegisterPage;
  if (route.name === "auth-forgot") return AuthForgotPage;
  return AuthLoginPage;
});

</script>

<template>
  <a-config-provider :theme="shell.antdTheme">
    <div v-if="shell.config.isDesktop && !shell.desktopStartupComplete" class="app-shell">
      <DesktopWindowBar />
      <main class="desktop-startup-loading" :class="{ 'desktop-startup-loading--host-masked': props.hostStartupActive }" :aria-busy="!shell.config.desktopError">
        <section class="desktop-startup-loading__content" aria-live="polite">
          <div class="desktop-startup-loading__brand"><img src="/favicon.svg" alt="" />CodeFlow</div>
          <h1>{{ shell.config.desktopError ? '启动暂未完成' : startupUpgrade ? '正在升级应用' : '正在准备您的工作台' }}</h1>
          <template v-if="shell.config.desktopError">
            <a-alert type="error" show-icon :message="shell.config.desktopError" />
            <a-button type="primary" @click="retryDesktopStartup">重试</a-button>
          </template>
          <template v-else>
            <span class="app-route-loading-spinner" aria-label="加载中" />
            <template v-if="startupUpgrade">
              <p>{{ startupUpgrade.label }}，请稍后…</p>
              <div
                class="desktop-startup-loading__progress"
                role="progressbar"
                :aria-valuenow="startupUpgrade.progress"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${startupUpgrade.progress}%` }" />
              </div>
            </template>
            <p v-else>{{ shell.config.localRuntimeReady ? '正在加载工作区' : '正在启动本地运行环境' }}</p>
          </template>
        </section>
      </main>
    </div>
    <Suspense v-else @resolve="emitDesktopBusinessReady">
    <div class="app-shell">
      <AppTopbar
        v-if="shell.mode !== 'mobile' && shell.ui.mainView !== 'landing' && shell.ui.mainView !== 'download' && shell.ui.mainView !== 'desktop-migration' && shell.ui.mainView !== 'best-practices' && shell.ui.mainView !== 'guide' && shell.ui.mainView !== 'contact' && shell.ui.mainView !== 'upgrade' && shell.ui.mainView !== 'auth' && shell.ui.mainView !== 'payment-verification' && shell.ui.mainView !== 'h5' && shell.ui.mainView !== 'office-h5'"
        :shell="shell"
      />
      <DesktopWindowBar v-else />
      <DesktopMigrationBanner v-if="showDesktopMigrationBanner" @close="desktopMigrationBannerDismissed = true" />

      <div v-if="shell.workspaceSwitching" class="app-workspace-switching">
        <a-spin size="large" tip="切换工作区..." />
      </div>

      <KeepAlive v-if="isPublicSiteViewActive">
        <LandingPage
          v-if="shell.ui.mainView === 'landing'"
          @open-settings="shell.openSettingsOrWizard"
          @enter-app="enterApplication"
        />
        <BestPracticePage
          v-else-if="shell.ui.mainView === 'best-practices'"
          @open-settings="shell.openSettingsOrWizard"
          @enter-app="enterApplication"
        />
        <ContactPage
          v-else-if="shell.ui.mainView === 'contact'"
          @open-settings="shell.openSettingsOrWizard"
          @enter-app="enterApplication"
        />
        <UpgradePage
          v-else-if="shell.ui.mainView === 'upgrade'"
          @open-settings="shell.openSettingsOrWizard"
          @enter-app="enterApplication"
        />
        <DataSecurityCommitmentPage
          v-else-if="route.name === 'data-security-commitment'"
          @open-settings="shell.openSettingsOrWizard"
          @enter-app="enterApplication"
        />
      </KeepAlive>
      <component v-else-if="shell.ui.mainView === 'auth'" :is="authComponent" />
      <DesktopDownloadPage v-else-if="shell.ui.mainView === 'download'" />
      <DesktopMigrationPage v-else-if="shell.ui.mainView === 'desktop-migration'" />
      <PaymentVerificationPage v-else-if="shell.ui.mainView === 'payment-verification'" />
      <ProjectKnowledgePage v-else-if="shell.ui.mainView === 'knowledge'" />
      <component v-else :is="layoutNode" v-on="layoutListeners" />

      <AppShellModals :shell="shell" />
      <DesktopAuthModal
        v-if="shell.config.isDesktop"
        v-model:open="shell.desktopAuthModalOpen"
      />
      <DesktopUpdateCheckModal v-if="shell.config.isDesktop" />
      <DesktopUpdateNoticeModal v-if="shell.config.isDesktop" />
      <DesktopQuitConfirmModal v-if="shell.config.isDesktop" />
      <FeedbackModal v-model:open="shell.feedbackOpen" :source="shell.feedbackSource" />
      <LocalModelSetupModal
        v-if="shell.config.isDesktop"
        :open="guideOpen"
        @dismiss="dismissGuide"
        @configure="configureGuide"
        @login="loginGuide"
      />
      <a-drawer :open="showNotificationPending" title="待办" width="min(640px, 100vw)" destroy-on-close @close="closeNotificationPending">
        <PendingPanel v-if="showNotificationPending" />
      </a-drawer>
    </div>
    <template #fallback>
      <div class="app-shell">
        <main class="desktop-startup-loading" aria-busy="true">
          <span class="app-route-loading-spinner" aria-label="加载中" />
        </main>
      </div>
    </template>
    </Suspense>
  </a-config-provider>
</template>

<style scoped>
.desktop-startup-loading { flex: 1 1 0; min-height: 0; display: grid; place-items: center; overflow: auto; padding: 24px; background: var(--app-bg); }
.desktop-startup-loading--host-masked { visibility: hidden; }
.desktop-startup-loading__content { width: min(100%, 480px); display: flex; flex-direction: column; align-items: center; gap: 20px; text-align: center; }
.desktop-startup-loading__brand { display: flex; align-items: center; gap: 12px; font-size: 28px; font-weight: 600; }
.desktop-startup-loading__brand img { width: 44px; height: 44px; }
.desktop-startup-loading h1 { margin: 8px 0 0; font-size: 22px; color: var(--app-text); }
.desktop-startup-loading p { margin: 0; color: var(--app-muted); }
.desktop-startup-loading__progress { width: min(100%, 280px); height: 6px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, var(--app-text) 12%, transparent); }
.desktop-startup-loading__progress span { display: block; height: 100%; border-radius: inherit; background: var(--app-accent, #c96442); transition: width 320ms ease; }
</style>
