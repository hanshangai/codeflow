<script setup lang="ts">
import { EyeOutlined } from "@ant-design/icons-vue";
import type { WorkspaceId, OrchestrationId, OrchestrationInstanceSummary, OrchestrationStatus } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore } from "../../../store/orchestration";

defineOptions({ name: "InstanceList" });

const props = defineProps<{ workspaceId: WorkspaceId }>();

const orch = useOrchestrationStore();
const { ctx } = useApiContext();

function selectInstance(instanceId: OrchestrationId) {
  orch.selectedInstanceId = instanceId;
  orch.loadInstance(ctx.value, props.workspaceId, instanceId);
}

function instanceTitle(inst: OrchestrationInstanceSummary): string {
  return inst.intakeTitle || inst.intakeGoalPreview || String(inst.id);
}

function statusColor(status: OrchestrationStatus): string {
  switch (status) {
    case "running": return "#1677ff";
    case "waiting-start": return "#fa8c16";
    case "waiting-approval": return "#0958d9";
    case "waiting-feedback": return "#faad14";
    case "completed": return "#52c41a";
    case "failed": return "#ff4d4f";
    case "paused": return "#faad14";
    case "cancelled": return "#999";
    default: return "#d9d9d9";
  }
}

function statusLabel(status: OrchestrationStatus): string {
  const map: Record<OrchestrationStatus, string> = {
    pending: "等待中", running: "运行中", paused: "已暂停",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核", "waiting-feedback": "等待补充",
    completed: "已完成", failed: "失败", cancelled: "已取消",
  };
  return map[status] ?? status;
}

function formatTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="instance-list">
    <div class="instance-list__header">
      <h3>编排实例</h3>
      <button class="instance-list__refresh" @click="orch.refreshInstances(ctx, workspaceId)">刷新</button>
    </div>

    <div v-if="orch.instancesLoading" class="instance-list__loading">加载中...</div>

    <table v-else-if="orch.instanceSummaries.length" class="instance-list__table">
      <thead>
        <tr>
          <th>需求</th>
          <th>工作流</th>
          <th>状态</th>
          <th>创建时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="inst in orch.instanceSummaries" :key="inst.id" class="instance-list__row" @click="selectInstance(inst.id)">
          <td class="instance-list__requirement">{{ instanceTitle(inst).slice(0, 60) }}{{ instanceTitle(inst).length > 60 ? '...' : '' }}</td>
          <td>{{ inst.workflowName ?? '-' }}</td>
          <td>
            <span class="instance-list__status" :style="{ color: statusColor(inst.status) }">
              {{ statusLabel(inst.status) }}
            </span>
          </td>
          <td>{{ formatTime(inst.createdAt) }}</td>
          <td>
            <button class="instance-list__view-btn" @click.stop="selectInstance(inst.id)">
              <EyeOutlined /> 查看
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="instance-list__empty">暂无编排实例</div>
  </div>
</template>

<style scoped>
.instance-list__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.instance-list__header h3 { margin: 0; font-size: 16px; }
.instance-list__refresh {
  padding: 4px 12px; border: 1px solid var(--app-border, #d9d9d9); border-radius: 4px;
  background: none; cursor: pointer; font-size: 12px;
}
.instance-list__table { width: 100%; border-collapse: collapse; font-size: 13px; }
.instance-list__table th {
  text-align: left; padding: 8px 12px; border-bottom: 2px solid var(--app-border, #e8e8e8);
  font-weight: 500; color: var(--app-muted, #666); font-size: 12px;
}
.instance-list__table td { padding: 10px 12px; border-bottom: 1px solid var(--app-border, #f0f0f0); }
.instance-list__row { cursor: pointer; transition: background 0.15s; }
.instance-list__row:hover { background: var(--app-hover-bg, #fafafa); }
.instance-list__requirement { max-width: 300px; }
.instance-list__status { font-weight: 500; font-size: 12px; }
.instance-list__view-btn {
  padding: 2px 8px; border: 1px solid var(--app-border, #d9d9d9); border-radius: 4px;
  background: none; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;
}
.instance-list__loading, .instance-list__empty {
  text-align: center; padding: 40px; color: var(--app-muted, #999); font-size: 13px;
}

:root[data-theme="dark"] .instance-list__table th { border-bottom-color: #303030; }
:root[data-theme="dark"] .instance-list__table td { border-bottom-color: #303030; }
:root[data-theme="dark"] .instance-list__row:hover { background: #1f1f1f; }
</style>

