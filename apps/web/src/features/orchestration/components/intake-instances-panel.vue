<script setup lang="ts">
import { computed, watch } from "vue";
import type { OrchestrationId, WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore } from "../../../store/orchestration";
import ArtifactBrowser from "./artifact-browser.vue";
import OrchestrationMonitor from "./orchestration-monitor.vue";

defineOptions({ name: "IntakeInstancesPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  view: "runs" | "artifacts";
}>();

const orch = useOrchestrationStore();
const { ctx } = useApiContext();

const selectedIntake = computed(() => orch.selectedIntake);
const selectedIntakeReadOnly = computed(() => Boolean(selectedIntake.value?.readOnly || selectedIntake.value?.sharedContext?.readOnly));
const relatedInstances = computed(() => {
  if (!selectedIntake.value) return [];
  return orch.instanceSummaries
    .filter((instance) => instance.intakeId === selectedIntake.value?.id)
    .sort((left, right) => right.updatedAt - left.updatedAt);
});

watch([relatedInstances, () => orch.selectedInstanceId], () => {
  const currentId = orch.selectedInstanceId;
  if (currentId && relatedInstances.value.some((instance) => instance.id === currentId)) return;
  const first = relatedInstances.value[0];
  orch.selectedInstanceId = first?.id ?? null;
  if (first) {
    void orch.loadInstance(ctx.value, props.workspaceId, first.id);
  }
}, { immediate: true });

function selectInstance(instanceId: OrchestrationId) {
  orch.selectedInstanceId = instanceId;
  void orch.loadInstance(ctx.value, props.workspaceId, instanceId);
}
</script>

<template>
  <div v-if="selectedIntake" class="intake-instances">
    <div v-if="relatedInstances.length === 0" class="intake-instances__empty-card">
      <strong>{{ view === "runs" ? "这条需求还没有执行记录" : "这条需求还没有结果" }}</strong>
      <p>先回到“需求”页确认当前方案并启动一条执行，右侧才会切到这个需求对应的执行和结果。</p>
      <button class="intake-instances__primary" @click="orch.setActiveTab('tasks')">去看需求与方案</button>
    </div>

    <div v-else class="intake-instances__body">
      <OrchestrationMonitor
        v-if="view === 'runs' && orch.selectedInstanceId"
        :workspace-id="workspaceId"
        :instance-id="orch.selectedInstanceId"
        :read-only="selectedIntakeReadOnly"
      />
      <ArtifactBrowser
        v-else-if="view === 'artifacts' && orch.selectedInstanceId"
        :workspace-id="workspaceId"
      />
      <div v-else class="intake-instances__empty">选择一条执行记录查看详情。</div>
    </div>
  </div>

  <div v-else class="intake-instances__empty-card">
    <strong>先选择一条需求</strong>
    <p>左侧先选中一个需求，右侧才会切换到这个需求对应的执行记录和结果。</p>
  </div>
</template>

<style scoped>
.intake-instances {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  gap: 12px;
  min-height: 0;
}
.intake-instances__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.intake-instances__body > * {
  flex: 1;
  min-height: 0;
}
.intake-instances__empty-card,
.intake-instances__empty {
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 14px;
  padding: 28px 24px;
  text-align: center;
  color: var(--app-muted, #666);
}
.intake-instances__empty-card strong {
  display: block;
  margin-bottom: 8px;
  color: var(--app-text, #222);
}
.intake-instances__empty-card p {
  margin: 0 0 14px;
  font-size: 13px;
  line-height: 1.7;
}
.intake-instances__primary,
.intake-instances__ghost {
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
}
.intake-instances__primary {
  border: none;
  background: var(--app-primary, #1677ff);
  color: #fff;
}
.intake-instances__ghost {
  border: 1px solid var(--app-border, #d9d9d9);
  background: transparent;
}
</style>

