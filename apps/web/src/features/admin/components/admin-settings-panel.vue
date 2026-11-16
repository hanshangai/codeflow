<script setup lang="ts">
import { computed } from "vue";

import WorkspaceManager from "../../workspaces/components/workspace-manager.vue";
import CodeflowaiConfigPanel from "../../settings/components/codeflowai-config-panel.vue";
import SoftwareUpdatePanel from "../../settings/components/software-update-panel.vue";
import { useConfigStore } from "../../../store/config";
import { useUiStore, type ThemeMode } from "../../../store/ui";

defineOptions({ name: "AdminSettingsPanel" });

type AdminSettingsView = "settings" | "workspaces";

const props = withDefaults(defineProps<{
  view?: AdminSettingsView;
}>(), {
  view: "settings",
});

const config = useConfigStore();
const ui = useUiStore();

/** 主题是本地界面偏好：直接读写 ui store，走 setThemeMode 以保留主题埋点。 */
const themeMode = computed<ThemeMode>({
  get: () => ui.themeMode,
  set: (mode) => ui.setThemeMode(mode),
});
</script>

<template>
  <div
    class="admin-settings-panel"
    :class="{ 'admin-settings-panel--workspaces': props.view === 'workspaces' }"
  >
    <section class="admin-settings-panel__surface">
      <div class="admin-settings-panel__pane">
        <div v-if="props.view === 'settings'" class="admin-settings-panel__group">
          <a-form layout="vertical" :colon="false">
            <a-form-item label="主题">
              <a-radio-group v-model:value="themeMode" option-type="button" button-style="solid">
                <a-radio-button value="light">浅色</a-radio-button>
                <a-radio-button value="dark">深色</a-radio-button>
                <a-radio-button value="auto">自动</a-radio-button>
              </a-radio-group>
              <div class="admin-settings-panel__hint">
                自动模式跟随系统深浅色设置切换。
              </div>
            </a-form-item>
          </a-form>
        </div>
        <div v-if="props.view === 'settings'" class="admin-settings-panel__group admin-settings-panel__engines">
          <div class="admin-settings-panel__group-title">模型引擎</div>
          <SoftwareUpdatePanel compact />
        </div>
        <WorkspaceManager
          v-if="props.view === 'workspaces' && config.canManageWorkspaces"
          :active="props.view === 'workspaces'"
        />
        <a-alert
          v-else-if="props.view === 'workspaces'"
          type="info"
          show-icon
          message="请先连接 Server 或启动本机 Client"
        />
        <CodeflowaiConfigPanel
          v-else-if="config.workspaceId"
          :workspace-id="config.workspaceId"
          :active="props.view === 'settings'"
        />
        <a-alert
          v-else
          type="info"
          show-icon
          message="请先创建或选择工作区"
          description="工作区创建后才能维护基础配置。"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin-settings-panel {
  display: grid;
  align-content: start;
  min-width: 0;
}

.admin-settings-panel--workspaces {
  height: 100%;
  min-height: 0;
  align-content: stretch;
}

.admin-settings-panel__surface {
  min-width: 0;
  padding: 16px 18px 18px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-panel-bg) 88%, var(--app-bg));
  box-shadow: var(--app-shadow-sm);
}

.admin-settings-panel:not(.admin-settings-panel--workspaces) .admin-settings-panel__surface {
  padding: 12px 14px 14px;
}

.admin-settings-panel__pane {
  display: grid;
  gap: 12px;
  min-height: 240px;
  min-width: 0;
}

.admin-settings-panel--workspaces .admin-settings-panel__surface,
.admin-settings-panel--workspaces .admin-settings-panel__pane {
  height: 100%;
  min-height: 0;
}

.admin-settings-panel--workspaces .admin-settings-panel__pane {
  align-content: start;
  overflow-y: auto;
}

/* 外观分组与 CodeFlowAI 配置组保持同一种卡片视觉。 */
.admin-settings-panel__group {
  padding: 10px 14px 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 95%, var(--app-text) 5%);
}

.admin-settings-panel__engines {
  padding: 10px 14px 12px;
}

.admin-settings-panel__group-title {
  margin-bottom: 10px;
  color: var(--app-text);
  font-size: 14px;
  font-weight: 600;
}

.admin-settings-panel__hint {
  margin-top: 4px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.admin-settings-panel__group :deep(.ant-form-item) {
  margin-bottom: 12px;
}

.admin-settings-panel__group :deep(.ant-form-item-label) {
  padding-bottom: 4px;
}

</style>
