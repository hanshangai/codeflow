<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import AdminScheduledTasksPanel from "../../admin/components/AdminScheduledTasksPanel.vue";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { mergeLocalScheduledTasks } from "../scheduledTaskMerge";

const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true });
const config = useConfigStore();
const { ctx } = useApiContext();
/** 账号任务需要 Client 已完成账号关联，未关联前继续展示本机任务。 */
const accountReady = computed(() => config.desktopCloudAccountLinked);
/** 已有 Server 会话但 Client 关联未就绪时，仍应展示账号任务而不是退回本机。 */
const hasServerSession = computed(() => config.authMode === "account" && config.hasActiveSession);
const merging = ref(false);
const mergeError = ref("");
const panelRevision = ref(0);
/** 已关联优先展示本机合并视图；仅有 Server 会话时展示账号任务；合并失败退回本机。 */
const source = computed<"local" | "desktop-account" | "account">(() => {
  if (accountReady.value) return mergeError.value ? "local" : "desktop-account";
  return hasServerSession.value ? "account" : "local";
});

/** 把本机任务合并到账号当前设备；失败保留本机任务并允许重试。 */
async function runMerge(): Promise<void> {
  if (!props.active || !accountReady.value || merging.value) return;
  merging.value = true;
  mergeError.value = "";
  const requestId = `scheduled-task-merge-${Date.now()}`;
  try {
    const result = await mergeLocalScheduledTasks(ctx.value);
    if (result.merged) {
      panelRevision.value += 1;
      message.success(`已合并 ${result.merged} 条本机定时任务到账号`);
    }
  } catch (error) {
    mergeError.value = error instanceof Error ? error.message : "本机定时任务合并失败";
    console.error("[scheduled-tasks.merge_failed]", {
      code: "SCHEDULED_TASK_MERGE_FAILED", requestId, userId: config.userSummary?.userId ?? null,
      serverOrigin: config.serverWsOrigin, clientId: config.desktopClient?.clientId ?? null,
      deviceId: config.desktopClient?.deviceId ?? null,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error(mergeError.value);
  } finally { merging.value = false; }
}

watch([() => props.active, accountReady], ([active, ready]) => {
  if (active && ready) void runMerge();
}, { immediate: true });
</script>

<template>
  <section class="desktop-tasks">
    <a-alert v-if="mergeError" type="error" show-icon :message="mergeError">
      <template #action><a-button size="small" :loading="merging" @click="runMerge">重试合并</a-button></template>
    </a-alert>
    <a-alert v-else-if="merging" type="info" show-icon message="正在合并本机定时任务到账号…" />
    <AdminScheduledTasksPanel :key="`${source}-${panelRevision}`" :source="source" :active="active" />
  </section>
</template>

<style scoped>
.desktop-tasks {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.desktop-tasks > .scheduled-tasks { flex: 1 1 0; }
</style>
