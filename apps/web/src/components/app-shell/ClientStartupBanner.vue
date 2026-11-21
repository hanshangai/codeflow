<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import { useAdminStore } from "../../store/admin";
import { useConfigStore } from "../../store/config";
import type { ActiveWorkspaceRuntimeState } from "../../store/presence";
import { resolveDesktopRuntimeStatusHint } from "./desktopLocalClientStatus";
import { useClientStartupBanner } from "./useClientStartupBanner";

defineOptions({ name: "ClientStartupBanner" });

const props = defineProps<{
  runtimeState: ActiveWorkspaceRuntimeState;
}>();

const config = useConfigStore();
const admin = useAdminStore();
const router = useRouter();
const { canManageSharedWorkspace, visible, dismiss } = useClientStartupBanner(computed(() => props.runtimeState));

const alertType = computed<"warning" | "error">(() =>
  props.runtimeState.kind === "shared" && props.runtimeState.status === "forbidden" ? "error" : "warning",
);
/** 复用本机生命周期提示，其他机器的离线不能提示重启本机。 */
const messageText = computed(() => {
  const runtime = props.runtimeState;
  if (runtime.kind === "local") {
    return config.isDesktop && !config.localRuntimeReady
      ? resolveDesktopRuntimeStatusHint({ ready: false, status: config.desktopRuntime?.status, error: config.desktopError })
      : "当前工作区所属的桌面端未在线，文件读取和任务执行暂不可用。";
  }
  if (runtime.kind !== "shared") return "";

  const contactSuffix = canManageSharedWorkspace.value ? "" : "请联系工作区管理员处理。";
  if (runtime.status === "unbound") {
    return canManageSharedWorkspace.value
      ? "共享工作区尚未绑定执行主机，请先完成 Host 绑定。"
      : `共享工作区尚未绑定执行主机。${contactSuffix}`;
  }
  if (runtime.status === "forbidden") return "当前账号暂无该共享工作区访问权限，请联系企业管理员。";
  return `共享工作区 Host 当前离线，文件读取和任务执行暂不可用。${contactSuffix}`;
});
const showAction = computed(() => canManageSharedWorkspace.value || (!config.isDesktop && props.runtimeState.kind === "local"));
const actionLabel = computed(() => props.runtimeState.kind === "shared" ? "共享空间设置" : "下载桌面版");

/** 共享空间保留管理入口，浏览器本地离线引导下载桌面版。 */
function openPrimaryAction(): void {
  if (props.runtimeState.kind !== "shared") {
    void router.push("/download");
    return;
  }
  admin.setPanel("shared-workspaces");
  void router.push({ path: "/admin", query: { panel: "shared-workspaces" } });
}
</script>

<template>
  <a-alert v-if="visible" class="client-startup-banner" :type="alertType" show-icon closable @close="dismiss">
    <template #message>
      <span class="client-startup-banner__message">
        <span class="client-startup-banner__detail">{{ messageText }}</span>
      </span>
    </template>
    <template v-if="showAction" #action>
      <a-button class="client-startup-banner__action" size="small" type="primary" @click="openPrimaryAction">{{ actionLabel }}</a-button>
    </template>
  </a-alert>
</template>

<style scoped>
.client-startup-banner {
  align-items: center;
  min-height: 48px;
  padding: 9px 12px !important;
  border: 1px solid color-mix(in srgb, var(--app-warning, #f59e0b) 34%, var(--app-border, #d9d9d9)) !important;
  border-radius: 16px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--app-warning, #f59e0b) 13%, transparent), rgba(255, 255, 255, 0.78)),
    linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 94%, #fff7e6), var(--app-panel-bg, #fff)) !important;
  box-shadow: 0 12px 28px color-mix(in srgb, var(--app-warning, #f59e0b) 10%, transparent), inset 0 1px 0 rgba(255, 255, 255, 0.85);
}

.client-startup-banner__message {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 100%;
  min-width: 0;
  color: var(--app-text, #141413);
  line-height: 1.35;
  white-space: nowrap;
}

.client-startup-banner__message strong {
  flex: 0 0 auto;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.client-startup-banner__detail {
  min-width: 0;
  overflow: hidden;
  color: color-mix(in srgb, var(--app-text, #141413) 82%, var(--app-muted, #5e5d59));
  text-overflow: ellipsis;
}

.client-startup-banner__action {
  border: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent, #c96442) 92%, white), var(--app-accent, #c96442));
  box-shadow: 0 8px 18px color-mix(in srgb, var(--app-accent, #c96442) 24%, transparent);
  font-weight: 700;
}

.client-startup-banner :deep(.ant-alert-content) {
  min-width: 0;
}

.client-startup-banner :deep(.ant-alert-message) {
  margin-bottom: 0;
  overflow: hidden;
}

.client-startup-banner :deep(.ant-alert-icon) {
  color: var(--app-warning, #f59e0b);
  font-size: 18px;
}

.client-startup-banner :deep(.ant-alert-action) {
  align-self: center;
  margin-inline-start: 16px;
}

@media (max-width: 720px) {
  .client-startup-banner {
    min-height: 44px;
  }

  .client-startup-banner__message {
    gap: 8px;
    font-size: 13px;
  }

  .client-startup-banner__detail {
    max-width: 46vw;
  }
}

:root[data-theme="dark"] .client-startup-banner {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--app-warning, #f59e0b) 16%, transparent), rgba(24, 29, 36, 0.82)),
    linear-gradient(180deg, #18202a, #13171d) !important;
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
</style>
