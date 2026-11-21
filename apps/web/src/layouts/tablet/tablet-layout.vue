<script setup lang="ts">
import { computed } from "vue";
import ThreadList from "../../features/threads/components/thread-list.vue";
import ChatPanel from "../../features/chat/components/chat-panel.vue";
import OrchestrationLayout from "../../features/orchestration/components/orchestration-layout.vue";
import AdminLayout from "../../features/admin/components/admin-layout.vue";
import InspectorPanel from "../../features/inspector/components/inspector-panel.vue";
import ExplorerRightPanel from "../../features/explorer/components/explorer-right-panel.vue";
import TerminalModal from "../../features/terminal/components/terminal-modal.vue";
import ClientStartupBanner from "../../components/app-shell/ClientStartupBanner.vue";
import { useClientStartupBanner } from "../../components/app-shell/useClientStartupBanner";
import {
  DESKTOP_TABLET_KEPT_ALIVE_INCLUDE,
  resolveDesktopTabletPrimaryPane,
  shouldRenderEmptyWorkspacePane,
} from "../main-view-keepalive";
import { useChatStore } from "../../store/chat";
import { useConfigStore } from "../../store/config";
import { usePresenceStore } from "../../store/presence";
import { useUiStore } from "../../store/ui";

defineOptions({ name: "TabletLayout" });

const config = useConfigStore();
const chat = useChatStore();
const presence = usePresenceStore();
const ui = useUiStore();
const rightPanelStyle = computed(() => {
  const preferred = ui.rightPanelMode === "terminal"
    ? ui.terminalPanelWidth
    : ui.rightPanelMode === "explorer"
      ? ui.explorerPanelWidth
      : ui.inspectorPanelWidth;
  return { width: `min(${preferred}px, 44vw)` };
});

const primaryPane = computed(() => resolveDesktopTabletPrimaryPane(ui.mainView));
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
const clientStartupBanner = useClientStartupBanner(activeWorkspaceRuntimeState);
const showClientStartupGuide = computed(() =>
  primaryPane.value !== "orchestration"
  && config.connected
  && clientStartupBanner.visible.value
  && activeWorkspaceRuntimeState.value.kind !== "none"
  && activeWorkspaceRuntimeState.value.status !== "online"
  && activeWorkspaceRuntimeState.value.status !== "unknown",
);

</script>

<template>
  <KeepAlive :include="DESKTOP_TABLET_KEPT_ALIVE_INCLUDE">
    <AdminLayout v-if="ui.mainView === 'admin'" />
  </KeepAlive>

  <div v-show="ui.mainView !== 'admin'" class="layout layout--tablet">
    <div v-show="ui.mainView !== 'orchestration' && !ui.rightPanelMode" class="layout__sidebar">
      <div class="layout__sidebar-panel">
        <ThreadList compact />
      </div>
    </div>

    <div class="layout__main">
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
        />
      </KeepAlive>
    </div>

    <div v-if="ui.rightPanelMode === 'inspector'" class="layout__inspector layout__inspector--tablet" :style="rightPanelStyle">
      <div class="layout__inspector-panel"><InspectorPanel /></div>
    </div>
    <div v-else-if="ui.rightPanelMode === 'explorer' && config.workspaceId" class="layout__inspector layout__inspector--tablet" :style="rightPanelStyle">
      <ExplorerRightPanel :workspace-id="config.workspaceId" />
    </div>
    <div v-else-if="ui.rightPanelMode === 'terminal'" class="layout__inspector layout__inspector--tablet" :style="rightPanelStyle">
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

.layout__inspector--tablet {
  min-width: 360px;
}
</style>
