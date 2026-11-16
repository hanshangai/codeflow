<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "DesktopMigrationBanner" });
const config = useConfigStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const router = useRouter();
const legacy = computed(() => {
  const workspace = workspaces.workspaces.find(item => item.id === config.workspaceId);
  const clientId = workspace?.shared?.hostClientId || workspace?.ownerClientId;
  const client = presence.online.onlineClients.find(item => clientId ? item.clientId === clientId : item.workspaceIds.includes(config.workspaceId));
  return client?.runtimeSource === "legacy";
});
/** 各页面复用统一下载入口，不中断当前任务或弹出额外窗口。 */
function download(): void {
  trackProductEvent("desktop_migration_download_clicked", { source: "workspace_banner", kind: legacy.value ? "legacy_client" : "web" });
  void router.push("/download");
}
/** 迁移说明走应用内路由。 */
function openMigrationGuide(): void {
  void router.push({ path: "/download", hash: "#migration" });
}
</script>

<template>
  <a-alert class="desktop-migration-banner" type="warning" show-icon>
    <template #message>{{ legacy ? "当前使用独立 Client，请迁移至桌面版。" : "Web 工作台处于迁移过渡期，请使用桌面版。" }}</template>
    <template #action><a-space><a-button type="primary" size="small" @click="download">下载桌面版</a-button><a href="/download#migration" @click.prevent="openMigrationGuide">迁移说明</a></a-space></template>
  </a-alert>
</template>

<style scoped>
.desktop-migration-banner { flex: 0 0 auto; }
</style>
