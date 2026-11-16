<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { FolderOpenOutlined } from "@ant-design/icons-vue";

import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { isDesktopWorkspace } from "../../../services/desktop";

defineOptions({ name: "H5FilesPanel" });

const emit = defineEmits<{
  (event: "open-workspaces"): void;
}>();

const ExplorerPanel = defineAsyncComponent(() => import("../../explorer/components/explorer-panel.vue"));
const config = useConfigStore();
const presence = usePresenceStore();

const workspaceId = computed(() => config.workspaceId);
/** 桌面本机工作区走本地桥，未登录 Server 也允许浏览文件。 */
const workspaceReady = computed(() => Boolean(
  workspaceId.value
  && (config.connected || isDesktopWorkspace(config, workspaceId.value))
  && presence.isCurrentWorkspaceClientOnline,
));
const unavailableTitle = computed(() => workspaceId.value ? "工作区暂时离线" : "还没有可浏览的工作区");
const unavailableDescription = computed(() => workspaceId.value
  ? "Client 恢复在线后即可继续浏览工作区文件。"
  : "选择或创建工作区后，可在这里浏览文件、Git 变更与修订记录。");
</script>

<template>
  <section class="h5-files" aria-label="文件">
    <header class="h5-files__header">
      <h1>文件</h1>
    </header>

    <div class="h5-files__body">
      <ExplorerPanel v-if="workspaceReady && workspaceId" surface="h5" :workspace-id="workspaceId" />
      <div v-else class="h5-files__unavailable">
        <div class="h5-files__empty-icon"><FolderOpenOutlined /></div>
        <strong>{{ unavailableTitle }}</strong>
        <p>{{ unavailableDescription }}</p>
        <button type="button" @click="emit('open-workspaces')">前往工作区设置</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.h5-files {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--app-text);
  background: var(--app-bg);
}

.h5-files__header {
  min-height: 56px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  padding: 12px 16px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 72%, transparent);
  background: color-mix(in srgb, var(--app-bg) 88%, transparent);
  backdrop-filter: blur(22px) saturate(145%);
  -webkit-backdrop-filter: blur(22px) saturate(145%);
}

.h5-files__header h1 {
  margin: 0;
  letter-spacing: 0;
  font-size: 21px;
  line-height: 1.25;
  font-weight: 720;
}

.h5-files__body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.h5-files__unavailable {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 24px 48px;
  text-align: center;
}

.h5-files__empty-icon {
  width: 68px;
  height: 68px;
  display: grid;
  place-items: center;
  margin-bottom: 18px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 18%, var(--app-divider));
  border-radius: 22px;
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-surface));
  font-size: 29px;
  box-shadow: 0 14px 32px color-mix(in srgb, #000 8%, transparent);
}

.h5-files__unavailable strong {
  font-size: 17px;
  line-height: 1.4;
}

.h5-files__unavailable p {
  max-width: 285px;
  margin: 8px 0 20px;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.65;
}

.h5-files__unavailable button {
  min-width: 148px;
  min-height: 46px;
  padding: 0 18px;
  border: 0;
  border-radius: 15px;
  color: #fff;
  background: var(--app-accent);
  font-size: 14px;
  font-weight: 650;
}

.h5-files__unavailable button:focus-visible {
  outline: 2px solid var(--app-accent);
  outline-offset: 2px;
}

@media (max-width: 340px) {
  .h5-files__header {
    padding-inline: 12px;
  }
}
</style>
