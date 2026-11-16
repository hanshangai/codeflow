<script setup lang="ts">
import { computed, defineAsyncComponent, getCurrentInstance, nextTick, onBeforeUnmount, onErrorCaptured, provide, ref, watch } from "vue";
import { getDesktopBridge } from "./services/desktop";
import { createBrowserUuid } from "./utils/browserUuid";
import { isCancelledRequestError } from "./api/request";

const app = getCurrentInstance()?.appContext.app;
let antdInstallPromise: Promise<void> | undefined;

/** 延迟注册 Ant Design，先让路由壳显示加载态，避免首屏静默等待大依赖。 */
function ensureAntdInstalled(): Promise<void> {
  if (!app) return Promise.reject(new Error("应用实例不可用，无法注册 Ant Design"));
  antdInstallPromise ??= import("ant-design-vue").then(({ default: Antd }) => {
    app.use(Antd);
  });
  return antdInstallPromise;
}

/** 页面壳加载前完成公共组件注册，保证异步页面中的 a-* 组件可解析。 */
function loadAppShell<T>(loader: () => Promise<{ default: T }>): Promise<T> {
  return Promise.all([ensureAntdInstalled(), loader()]).then(([, module]) => module.default);
}

const StandardApp = defineAsyncComponent(() => loadAppShell(() => import("./standard-app.vue")));
const DesktopMigrationStartup = defineAsyncComponent(() => loadAppShell(() => import("./features/desktop/components/desktop-migration-startup.vue")));
const hasMigrationStartup = Boolean(getDesktopBridge()?.getMigrationState);
const desktopStartupReady = ref(!hasMigrationStartup);
const layoutReady = ref(false);
const hostSplashDone = ref(!hasMigrationStartup);
const desktopStartupLabel = ref("正在加载工作台");
const WORKBENCH_READY_KEY = "codeflow:desktop-workbench-ready";
provide(WORKBENCH_READY_KEY, hostSplashDone);
const hostStartupHold = computed(() => hasMigrationStartup && !hostSplashDone.value);
const migrationInteractive = ref(false);
const startupRequestId = createBrowserUuid();
const mountedShells = new Set<"standard" | "migration">();
let readyGeneration = 0;
const shellFailed = ref<string | null>(null);

/** 异步入口切换或失败先撤销旧事实，不能让旧页面就绪覆盖新一轮加载。 */
function clearShellReady(): void {
  readyGeneration++;
  delete document.documentElement.dataset.codeflowReady;
}

/** 挂载后等待渲染收口，仅确认可交互的迁移页或实际工作台可发布就绪。 */
async function markShellMounted(shell: "standard" | "migration"): Promise<void> {
  mountedShells.add(shell);
  const owner = readyGeneration;
  await nextTick();
  if (shellFailed.value !== null || owner !== readyGeneration || hasMigrationStartup && !mountedShells.has("migration")
    || desktopStartupReady.value && (!mountedShells.has("standard") || !layoutReady.value)
    || !desktopStartupReady.value && !migrationInteractive.value) return;
  document.documentElement.dataset.codeflowReady = "1";
}

/** 卸载页面壳立即失效，后到 mounted 续体不能重新发布已退休的事实。 */
function markShellUnmounted(shell: "standard" | "migration"): void {
  mountedShells.delete(shell);
  // 启动页被工作台替换后卸载，不再撤销已发布的工作台就绪。
  if (shell === "migration" && hostSplashDone.value) return;
  clearShellReady();
}

clearShellReady();
watch([desktopStartupReady, migrationInteractive, layoutReady], () => {
  clearShellReady();
  if (desktopStartupReady.value && mountedShells.has("standard")) void markShellMounted("standard");
  else if (migrationInteractive.value && mountedShells.has("migration")) void markShellMounted("migration");
}, { flush: "sync" });
onBeforeUnmount(clearShellReady);
/** 已退休业务请求的取消不改变应用就绪；真实子树错误仍进入可重试失败页。 */
onErrorCaptured((error, _instance, info) => {
  if (isCancelledRequestError(error)) return false;
  shellFailed.value = error instanceof Error ? error.message : String(error);
  clearShellReady();
  console.error("[WEB_APP_SHELL_FAILED]", { errorCode: "WEB_APP_SHELL_FAILED", requestId: startupRequestId, phase: info,
    rootCause: error instanceof Error ? error.message : String(error) });
});

/** 刷新后沿原启动入口重试，失败资源不在当前页面内静默恢复。 */
function retryAppStartup(): void {
  window.location.reload();
}

defineOptions({ name: "App" });

</script>

<template>
  <Suspense>
    <main v-if="shellFailed !== null" class="account-h5-route-loading" role="alert">
      <section class="app-startup-error">
        <h1>启动暂未完成</h1>
        <p>{{ shellFailed || '应用资源加载失败，请重试。' }}</p>
        <button type="button" @click="retryAppStartup">重试</button>
      </section>
    </main>
    <div v-else class="app-startup-root">
      <StandardApp v-if="desktopStartupReady" :host-startup-active="hostStartupHold"
        @workbench-ready="layoutReady = $event"
        @desktop-business-ready="hostSplashDone = true"
        @desktop-startup-status="desktopStartupLabel = $event"
        @vue:mounted="markShellMounted('standard')" @vue:unmounted="markShellUnmounted('standard')" />
      <div v-if="hasMigrationStartup" class="app-startup-hold" :class="{ 'app-startup-hold--active': hostStartupHold }">
        <DesktopMigrationStartup :startup-label="desktopStartupLabel" @ready="desktopStartupReady = true"
          @interactive="migrationInteractive = $event"
          @vue:mounted="markShellMounted('migration')" @vue:unmounted="markShellUnmounted('migration')" />
      </div>
    </div>
    <template #fallback>
      <main class="account-h5-route-loading" aria-busy="true">
        <span class="app-route-loading-spinner" aria-label="加载中" />
      </main>
    </template>
  </Suspense>
</template>

<style>
.app-startup-root { height: 100%; min-height: 0; }
.app-startup-error { width: min(480px, calc(100% - 48px)); display: grid; gap: 16px; text-align: center; }

/* 首位启动页覆盖工作台初始化过程，完成后再一次性切到应用壳。 */
.app-startup-hold--active { position: fixed; inset: 0; z-index: 2000; }

.app-workspace-switching {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.08);
  backdrop-filter: blur(1px);
}

.app-workspace-switching > .ant-spin {
  padding: 14px 18px;
  border: 1px solid var(--app-divider);
  border-radius: 12px;
  background: var(--app-panel-bg);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
}

.account-h5-route-loading {
  /* 导航后的原生拖拽区域须显式清除，错误页重试才能接收鼠标事件。 */
  -webkit-app-region: no-drag;
  display: grid;
  min-height: 100vh;
  min-height: 100dvh;
  place-items: center;
  background: var(--app-bg);
}

.app-route-loading-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid color-mix(in srgb, var(--app-muted) 25%, transparent);
  border-top-color: var(--app-accent);
  border-radius: 50%;
  animation: app-route-loading-spin 0.8s linear infinite;
}

@keyframes app-route-loading-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .app-workspace-switching { background: rgba(0, 0, 0, 0.35); }
}
:root[data-theme="dark"] .app-workspace-switching { background: rgba(0, 0, 0, 0.35); }

.app-topbar__brand--clickable {
  cursor: pointer;
}

.app-topbar__terminal-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.app-topbar__terminal-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: var(--app-muted);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}
.app-topbar__terminal-badge--attention {
  animation: topbar-reminder-badge-breathe 1.8s ease-in-out infinite;
}

@keyframes topbar-reminder-badge-breathe {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--app-accent) 18%, transparent);
  }
  50% {
    transform: scale(1.08);
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--app-accent) 8%, transparent);
  }
}

.app-topbar__terminal-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.app-topbar__terminal-state {
  position: absolute;
  top: -3px;
  right: -4px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--app-panel-bg);
  border-radius: 50%;
}

.app-topbar__terminal-state--running {
  background: var(--app-success);
}

.app-topbar__terminal-state--offline {
  background: var(--app-muted);
}

.topbar-client-popover__hint {
  font-size: 12px;
  color: var(--app-muted);
  margin-bottom: 4px;
}

.topbar-client-popover__tip {
  margin-top: 8px;
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.5;
  padding-left: 10px;
  border-left: 2px solid var(--app-accent);
}

.topbar-client-popover__tip code {
  font-size: 11px;
  background: var(--app-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
}

.explorer-modal .ant-modal {
  max-width: 1700px;
}

.explorer-modal .ant-modal-body {
  padding: 0;
  height: 80vh;
  overflow: hidden;
}

.explorer-preview-modal.ant-modal-wrap {
  pointer-events: none;
}
.explorer-preview-modal .ant-modal {
  pointer-events: none;
  max-width: 1400px;
}

.explorer-preview-modal .ant-modal-content {
  pointer-events: auto;
  cursor: move;
  user-select: none;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.10);
}
.explorer-preview-modal .ant-modal-body {
  cursor: default;
  user-select: text;
  padding: 0;
  height: 70vh;
  overflow: hidden;
}
.explorer-preview-modal .ant-modal-close {
  cursor: pointer;
}

.ant-modal .ant-modal-close,
:where(.css-dev-only-do-not-override-f4li2i).ant-modal .ant-modal-close {
  top: 16px;
}

.ant-modal .ant-modal-content {
  padding: 20px 24px;
}

/* 全屏预览弹框贴边展示，避免继承弹框内边距留出边框。 */
.ant-modal-wrap[class*="--fullscreen"] .ant-modal-content,
.ant-modal-wrap[class*="--desktop-fullscreen"] .ant-modal-content {
  padding: 0;
}

.settings-modal__mobile-pane {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.preview-taskbar {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2100;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  background: var(--app-bg-secondary, #f5f5f5);
  border: 1px solid var(--app-divider, #e8e8e8);
  border-bottom: none;
  border-radius: 8px 8px 0 0;
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.10);
  max-width: 80vw;
  overflow-x: auto;
}
.preview-taskbar__tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
  color: var(--app-text-secondary, #666);
  background: transparent;
  transition: background 0.15s, color 0.15s;
  user-select: none;
}
.preview-taskbar__tab:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.06));
}
.preview-taskbar__tab--active {
  color: var(--app-accent, #c96442);
  background: var(--app-bg, #fff);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  font-weight: 600;
}
.preview-taskbar__tab-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.preview-taskbar__tab-close {
  font-size: 14px;
  line-height: 1;
  opacity: 0.5;
  cursor: pointer;
  padding: 0 2px;
  border-radius: 3px;
}
.preview-taskbar__tab-close:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.08);
}
.preview-taskbar__close-all {
  padding: 4px 8px;
  font-size: 11px;
  color: var(--app-muted, #999);
  cursor: pointer;
  white-space: nowrap;
  border-left: 1px solid var(--app-divider, #e8e8e8);
  margin-left: 4px;
  user-select: none;
}
.preview-taskbar__close-all:hover {
  color: var(--app-text, #333);
}

.explorer-modal .ant-tree.ant-tree-directory .ant-tree-treenode-selected::before {
  background: rgba(0, 0, 0, 0.10) !important;
}
.explorer-modal .ant-tree.ant-tree-directory .ant-tree-treenode-selected:hover::before {
  background: rgba(0, 0, 0, 0.14) !important;
}
.explorer-modal .ant-tree.ant-tree-directory .ant-tree-treenode-selected .ant-tree-node-content-wrapper,
.explorer-modal .ant-tree.ant-tree-directory .ant-tree-treenode-selected .ant-tree-switcher {
  color: inherit !important;
}

.explorer-modal .ant-tree {
  border-radius: 0 !important;
}

.settings-modal.ant-modal-wrap,
.terminal-modal.ant-modal-wrap,
.workspace-manager-modal.ant-modal-wrap,
.explorer-modal.ant-modal-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}
.settings-modal .ant-modal,
.terminal-modal .ant-modal,
.workspace-manager-modal .ant-modal,
.explorer-modal .ant-modal {
  top: 0;
  margin: 0;
}

@media (min-width: 768px) {
  .workspace-manager-modal .ant-modal {
    max-height: calc(100vh - 48px);
  }

  .workspace-manager-modal .ant-modal-content {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 48px);
    overflow: hidden;
  }

  .workspace-manager-modal .ant-modal-body {
    min-height: 0;
    max-height: calc(100vh - 120px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
}

@keyframes mobile-modal-slide-up {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}

@media (max-width: 767px) {
  .ant-modal .ant-modal-content {
    padding: 12px;
  }
  .settings-modal.ant-modal-wrap,
  .terminal-modal.ant-modal-wrap,
  .workspace-manager-modal.ant-modal-wrap,
  .explorer-modal.ant-modal-wrap,
  .explorer-preview-modal.ant-modal-wrap {
    overflow: hidden !important;
    overscroll-behavior: none !important;
  }
  .explorer-preview-modal.ant-modal-wrap {
    pointer-events: auto !important;
  }
  .explorer-preview-modal .ant-modal {
    pointer-events: auto !important;
  }
  .explorer-preview-modal .ant-modal-content {
    cursor: default !important;
    user-select: auto !important;
  }

  .settings-modal .ant-modal,
  .terminal-modal .ant-modal,
  .workspace-manager-modal .ant-modal,
  .explorer-modal .ant-modal,
  .explorer-preview-modal .ant-modal {
    display: flex !important;
    flex-direction: column !important;
    width: 100% !important;
    max-width: 100% !important;
    height: 100dvh !important;
    height: 100vh !important;
    min-height: 100dvh !important;
    margin: 0 !important;
    top: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    animation: mobile-modal-slide-up 280ms cubic-bezier(0.25, 0.46, 0.45, 0.94) !important;
  }

  .settings-modal .ant-modal > div:first-child,
  .terminal-modal .ant-modal > div:first-child,
  .workspace-manager-modal .ant-modal > div:first-child,
  .explorer-modal .ant-modal > div:first-child,
  .explorer-preview-modal .ant-modal > div:first-child {
    display: flex !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
  }

  .settings-modal .ant-modal-content,
  .terminal-modal .ant-modal-content,
  .workspace-manager-modal .ant-modal-content,
  .explorer-modal .ant-modal-content,
  .explorer-preview-modal .ant-modal-content {
    flex: 1 1 auto !important;
    display: flex !important;
    flex-direction: column !important;
    min-height: 0 !important;
    height: auto !important;
    padding: var(--safe-top) 0 var(--safe-bottom) 0 !important;
    box-sizing: border-box !important;
    overflow: hidden !important;
    border-radius: 0 !important;
  }

  .settings-modal .ant-modal-body,
  .terminal-modal .ant-modal-body,
  .workspace-manager-modal .ant-modal-body,
  .explorer-modal .ant-modal-body,
  .explorer-preview-modal .ant-modal-body {
    flex: 1 !important;
    min-height: 0 !important;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
  }
  .settings-modal .ant-modal-body,
  .workspace-manager-modal .ant-modal-body,
  .explorer-modal .ant-modal-body,
  .explorer-preview-modal .ant-modal-body {
    overflow-y: auto !important;
  }

  .settings-modal .ant-modal-body,
  .workspace-manager-modal .ant-modal-body {
    padding: 12px;
  }
  .terminal-modal .ant-modal-body {
    max-height: none !important;
    overflow: hidden !important;
  }
  .terminal-modal .ant-modal-body,
  .explorer-modal .ant-modal-body,
  .explorer-preview-modal .ant-modal-body {
    padding: 0;
  }

  .settings-modal .ant-tabs-nav { display: none; }
  .settings-modal .ant-tabs,
  .settings-modal .ant-tabs-content-holder,
  .settings-modal .ant-tabs-content {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: 100% !important;
  }
  .settings-modal .ant-tabs-tabpane,
  .settings-modal .ant-tabs-tabpane-active {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    height: 100% !important;
  }
  .settings-modal .ant-tabs-content {
    max-height: none;
    overflow-y: visible;
  }
  .settings-modal .ant-input,
  .settings-modal .ant-input-password {
    font-size: 16px;
  }
}
</style>
