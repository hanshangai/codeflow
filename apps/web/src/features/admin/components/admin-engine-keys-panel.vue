<script setup lang="ts">
import { computed, ref } from "vue";

import EngineKeysPanel from "../../settings/components/engine-keys-panel.vue";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";

defineOptions({ name: "AdminEngineKeysPanel" });

type EngineKeyTab = "claude" | "codex" | "deepseek" | "moonshot" | "qwen" | "zai";

const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const activeTab = ref<EngineKeyTab>("codex");
const currentWorkspace = computed(() => config.workspaceId ? workspaces.byId.get(config.workspaceId as any) ?? null : null);
const isSharedWorkspace = computed(() =>
  Boolean(currentWorkspace.value?.kind === "shared" || isSharedWorkspaceSelectionId(config.workspaceId)),
);
const canMaintainSharedHostKeys = computed(() =>
  Boolean(
    isSharedWorkspace.value
    && currentWorkspace.value?.shared?.isHostOwner === true
    && currentWorkspace.value?.capabilities?.canMaintainAssets === true,
  ),
);
/** 桌面本机工作区未登录也可管理自配 Key；共享与其他 Client 仍要求 Server 连接。 */
const keysRouteAvailable = computed(() => config.connected || isDesktopWorkspace(config, config.workspaceId));
const modelTabsAvailable = computed(() => keysRouteAvailable.value || (config.isAccountSession && config.hasActiveSession));

const statusMessage = computed(() => {
  if (!keysRouteAvailable.value) return "请先连接 Server 或启动本机 Client 后再管理大模型 Key。";
  if (isSharedWorkspace.value && canMaintainSharedHostKeys.value) return "";
  if (isSharedWorkspace.value) return "共享工作区成员不可维护大模型 Key，请由共享工作区 Host 处理。";
  if (!presence.isCurrentWorkspaceClientOnline) return "请先启动当前工作区的 Client，Key 配置保存在本地 Client。";
  return "";
});

/** 仅刷新当前页签，维护权限由内部入口判断。 */
function isTabActive(tab: EngineKeyTab): boolean {
  return activeTab.value === tab;
}
</script>

<template>
  <div class="admin-engine-keys-panel">
    <header class="admin-engine-keys-panel__header">
      <h2>模型配置</h2>
      <p>选择模型供应商，配置连接密钥。内置模型无需额外配置。</p>
    </header>
    <a-alert
      v-if="statusMessage"
      class="admin-engine-keys-panel__notice"
      :type="config.connected ? 'info' : 'warning'"
      :message="statusMessage"
      show-icon
    />

    <a-tabs v-model:activeKey="activeTab" class="admin-engine-keys-panel__tabs">
      <a-tab-pane key="codex" tab="OpenAI" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="codex" provider-scope="openai" :active="isTabActive('codex')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="claude" tab="Anthropic" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="claude" provider-scope="anthropic" :active="isTabActive('claude')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="deepseek" tab="DeepSeek" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="claude" provider-scope="deepseek" :active="isTabActive('deepseek')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="zai" tab="GLM" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="claude" provider-scope="zai" :active="isTabActive('zai')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="qwen" tab="Qwen" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="claude" provider-scope="qwen" :active="isTabActive('qwen')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

      <a-tab-pane key="moonshot" tab="Kimi" :disabled="!modelTabsAvailable">
        <div class="admin-engine-keys-panel__pane">
          <EngineKeysPanel fill-height engine-scope="claude" provider-scope="moonshot" :active="isTabActive('moonshot')" :hide-disabled-reason-alert="Boolean(statusMessage)" />
        </div>
      </a-tab-pane>

    </a-tabs>
  </div>
</template>

<style scoped>
.admin-engine-keys-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  gap: 16px;
}
.admin-engine-keys-panel__header h2 { margin: 0; font-size: 20px; font-weight: 600; }
.admin-engine-keys-panel__header p { margin: 4px 0 0; font-size: 12px; color: var(--app-muted); }
.admin-engine-keys-panel__tabs { flex: 1 1 0; min-height: 0; }
/* Tabs 没有内容区高度 props，仅在本页补全内部滚动容器链。 */
.admin-engine-keys-panel__tabs :deep(.ant-tabs-content-holder),
.admin-engine-keys-panel__tabs :deep(.ant-tabs-content),
.admin-engine-keys-panel__tabs :deep(.ant-tabs-tabpane-active) { height: 100%; min-height: 0; overflow: hidden; }

.admin-engine-keys-panel__notice {
  align-self: start;
  justify-self: start;
  width: fit-content;
  max-width: min(100%, 560px);
  height: fit-content;
  padding: 8px 12px;
}

.admin-engine-keys-panel__notice :deep(.ant-alert-message) {
  line-height: 1.5;
}

@media (max-width: 640px) {
  .admin-engine-keys-panel__notice {
    width: 100%;
    max-width: 100%;
  }
}

.admin-engine-keys-panel__tabs :deep(.ant-tabs-nav) {
  margin-bottom: 12px;
}

.admin-engine-keys-panel__tabs :deep(.ant-tabs-tab) {
  padding-top: 6px;
  padding-bottom: 6px;
}

.admin-engine-keys-panel__pane {
  display: flex;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

@media (max-width: 900px) {
  .admin-engine-keys-panel__tabs :deep(.ant-tabs-nav-wrap) {
    overflow-x: auto;
  }
}
</style>
