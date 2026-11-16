<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import ThreadList from "../../features/threads/components/thread-list.vue";
import ChatPanel from "../../features/chat/components/chat-panel.vue";
import OrchestrationLayout from "../../features/orchestration/components/orchestration-layout.vue";
import InspectorPanel from "../../features/inspector/components/inspector-panel.vue";
import ExplorerRightPanel from "../../features/explorer/components/explorer-right-panel.vue";
import TerminalModal from "../../features/terminal/components/terminal-modal.vue";
import AdminLayout from "../../features/admin/components/admin-layout.vue";
import ClientStartupBanner from "../../components/app-shell/ClientStartupBanner.vue";
import DesktopPanelResizeHandle from "../../components/layout/desktop-panel-resize-handle.vue";
import {
  DESKTOP_TABLET_KEPT_ALIVE_INCLUDE,
  resolveDesktopTabletPrimaryPane,
  shouldRenderEmptyWorkspacePane,
} from "../main-view-keepalive";
import { useChatStore } from "../../store/chat";
import { useConfigStore } from "../../store/config";
import { usePresenceStore } from "../../store/presence";
import { useUiStore } from "../../store/ui";
import { resolveDesktopPanelSizing, resolveLeftSidebarTrackWidth } from "./desktop-panel-sizing";

defineOptions({ name: "DesktopLayout" });

const config = useConfigStore();
const chat = useChatStore();
const presence = usePresenceStore();
const ui = useUiStore();

const layoutRef = ref<HTMLElement | null>(null);
const availableWidth = ref(0);
const dragPreviewWidth = ref<number | null>(null);
let layoutResizeObserver: ResizeObserver | null = null;

const activeRightPanelWidth = computed(() => {
  if (ui.rightPanelMode === "explorer") return ui.explorerPanelWidth;
  if (ui.rightPanelMode === "terminal") return ui.terminalPanelWidth;
  return ui.inspectorPanelWidth;
});

const measuredWidth = computed(() => availableWidth.value || (typeof window !== "undefined" ? window.innerWidth : 1440));
const sizingRightMode = computed(() => (
  ui.rightPanelMode === "explorer" && !config.workspaceId ? null : ui.rightPanelMode
));
const panelSizing = computed(() => resolveDesktopPanelSizing({
  containerWidth: measuredWidth.value,
  leftPreference: dragPreviewWidth.value ?? ui.leftSidebarWidth,
  rightMode: sizingRightMode.value,
  rightPreference: activeRightPanelWidth.value,
}));
const leftSidebarTrackWidth = computed(() => resolveLeftSidebarTrackWidth({
  collapsed: ui.leftSidebarCollapsed,
  effectiveLeftWidth: panelSizing.value.effectiveLeftWidth,
}));
const leftSidebarStyle = computed(() => ({
  width: `${leftSidebarTrackWidth.value}px`,
  "--left-sidebar-content-width": `${panelSizing.value.effectiveLeftWidth}px`,
}));
const rightPanelStyle = computed(() => ({ width: `${panelSizing.value.effectiveRightWidth}px` }));
const primaryPane = computed(() => resolveDesktopTabletPrimaryPane(ui.mainView));
const orchestrationLeftWidth = computed(() => panelSizing.value.effectiveLeftWidth);
const orchestrationLeftMaxWidth = computed(() => panelSizing.value.effectiveLeftMaxWidth);

/* ── 右侧面板拖拽调宽 ── */
const isResizing = ref(false);

const hasWorkspace = computed(() => Boolean(String(config.workspaceId ?? "").trim()));
const showEmptyWorkspacePane = computed(() => shouldRenderEmptyWorkspacePane({
  hasWorkspace: hasWorkspace.value,
  primaryPane: primaryPane.value,
}));
const primaryPaneComponent = computed(() => (primaryPane.value === "orchestration" ? OrchestrationLayout : ChatPanel));
const primaryPaneProps = computed(() => {
  // 归一化为字符串：未选中工作区时必须是空串，编排模块据此判定只读预览。
  const workspaceId = String(config.workspaceId ?? "");
  return primaryPane.value === "orchestration"
    ? { workspaceId }
    : { workspaceId, threadId: chat.primaryThreadId };
});
const activeWorkspaceRuntimeState = computed(() => presence.activeWorkspaceRuntimeState);
const showClientStartupGuide = computed(() =>
  primaryPane.value !== "orchestration"
  && config.connected
  && activeWorkspaceRuntimeState.value.kind !== "none"
  && activeWorkspaceRuntimeState.value.status !== "online"
  && activeWorkspaceRuntimeState.value.status !== "unknown",
);

/** 启动桌面右侧面板拖拽，并将宽度写回当前非空面板模式。 */
function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  if (!ui.rightPanelMode) return;
  const mode: "inspector" | "explorer" | "terminal" = ui.rightPanelMode;
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = activeRightPanelWidth.value;

  function onMouseMove(ev: MouseEvent) {
    // 向左拖 → 宽度增大（clientX 减小）
    ui.setRightPanelWidth(mode, startWidth + (startX - ev.clientX));
  }
  function onMouseUp() {
    isResizing.value = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  }
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onLeftResizeStart(): void {
  dragPreviewWidth.value = panelSizing.value.effectiveLeftWidth;
  isResizing.value = true;
}

function onLeftResizePreview(width: number): void {
  dragPreviewWidth.value = width;
  isResizing.value = true;
}

function onLeftResizeCommit(width: number): void {
  ui.setLeftSidebarWidth(width);
  dragPreviewWidth.value = null;
  isResizing.value = false;
}

function onLeftResizeCancel(): void {
  dragPreviewWidth.value = null;
  isResizing.value = false;
}

function updateAvailableWidth(): void {
  availableWidth.value = layoutRef.value?.clientWidth ?? 0;
}

onMounted(() => {
  updateAvailableWidth();
  if (typeof ResizeObserver !== "undefined" && layoutRef.value) {
    layoutResizeObserver = new ResizeObserver(updateAvailableWidth);
    layoutResizeObserver.observe(layoutRef.value);
  }
});

onBeforeUnmount(() => {
  layoutResizeObserver?.disconnect();
  layoutResizeObserver = null;
});
</script>

<template>
  <!-- Admin 全屏布局（缓存，不销毁） -->
  <KeepAlive :include="DESKTOP_TABLET_KEPT_ALIVE_INCLUDE">
    <AdminLayout v-if="ui.mainView === 'admin'" />
  </KeepAlive>

  <!-- 正常布局（切到 admin 时仅隐藏，不销毁） -->
  <div ref="layoutRef" v-show="ui.mainView !== 'admin'" class="layout layout--desktop" :class="{ 'layout--resizing': isResizing }">
    <div
      v-show="ui.mainView !== 'orchestration'"
      class="layout__sidebar"
      data-testid="left-sidebar"
      :class="{ 'layout__sidebar--collapsed': ui.leftSidebarCollapsed }"
      :style="leftSidebarStyle"
    >
      <div
        id="desktop-left-sidebar-content"
        class="layout__sidebar-panel"
        data-testid="left-sidebar-scrollport"
        :inert="ui.leftSidebarCollapsed"
        :aria-hidden="ui.leftSidebarCollapsed"
      >
        <ThreadList />
      </div>
      <DesktopPanelResizeHandle
        v-if="ui.mainView !== 'orchestration'"
        v-show="!ui.leftSidebarCollapsed"
        :value="panelSizing.effectiveLeftWidth"
        :min="300"
        :max="panelSizing.effectiveLeftMaxWidth"
        @resize-start="onLeftResizeStart"
        @resize-preview="onLeftResizePreview"
        @resize-commit="onLeftResizeCommit"
        @resize-cancel="onLeftResizeCancel"
      />
    </div>

    <div class="layout__main" data-testid="desktop-main-pane">
      <div v-if="showClientStartupGuide" class="layout__guide-banner">
        <ClientStartupBanner :runtime-state="activeWorkspaceRuntimeState" />
      </div>
      <div v-if="showEmptyWorkspacePane" class="layout__empty-workspace">
        <strong>请先创建或选择工作区</strong>
        <span>工作区创建后，会话、文件和需求编排会自动进入可用状态。</span>
      </div>
      <KeepAlive v-else :include="DESKTOP_TABLET_KEPT_ALIVE_INCLUDE">
        <component
          :is="primaryPaneComponent"
          :key="primaryPane"
          v-bind="primaryPaneProps"
          :desktop-left-sidebar-width="primaryPane === 'orchestration' ? orchestrationLeftWidth : undefined"
          :desktop-left-sidebar-max-width="primaryPane === 'orchestration' ? orchestrationLeftMaxWidth : undefined"
          @left-sidebar-resize-start="onLeftResizeStart"
          @left-sidebar-resize-preview="onLeftResizePreview"
          @left-sidebar-resize-commit="onLeftResizeCommit"
          @left-sidebar-resize-cancel="onLeftResizeCancel"
        />
      </KeepAlive>
    </div>

    <!-- Inspector 面板 -->
    <div v-if="ui.rightPanelMode === 'inspector'" class="layout__inspector" data-testid="desktop-right-panel" :style="rightPanelStyle">
      <div class="layout__resize-handle" @mousedown="onResizeStart" />
      <div class="layout__inspector-panel">
        <InspectorPanel />
      </div>
    </div>
    <!-- Explorer 面板（与 Inspector 互斥） -->
    <div v-else-if="ui.rightPanelMode === 'explorer' && config.workspaceId" class="layout__inspector" data-testid="desktop-right-panel" :style="rightPanelStyle">
      <div class="layout__resize-handle" @mousedown="onResizeStart" />
      <ExplorerRightPanel :workspace-id="config.workspaceId" />
    </div>
    <!-- Terminal 面板（账号级，可跨本地工作区） -->
    <div v-else-if="ui.rightPanelMode === 'terminal'" class="layout__inspector" data-testid="desktop-right-panel" :style="rightPanelStyle">
      <div class="layout__resize-handle" @mousedown="onResizeStart" />
      <TerminalModal embedded workbench :open="true" />
    </div>
  </div>
</template>

<style scoped>
.layout__guide-banner {
  padding: 12px 16px 0;
}

.layout__empty-workspace {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  text-align: center;
  padding: 24px;
}

.layout__empty-workspace strong {
  color: var(--app-text);
  font-size: 16px;
}

.layout__sidebar--collapsed {
  overflow: hidden;
  border-right: 0;
}
</style>
