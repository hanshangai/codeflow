<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { UnorderedListOutlined } from "@ant-design/icons-vue";
import { MarkerType, Panel, VueFlow, useVueFlow, type Edge, type Node } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import type { NodeExecutionState, WorkflowEdge, WorkflowNode, WorkflowRuntimeDefinition } from "@codeflowai/shared";
import { useUiStore } from "../../../store/ui";
import {
  buildConfigNodeCardViewModel,
  type WorkflowNodeCardMetricTone,
  type WorkflowNodeCardTone,
  WORKFLOW_NODE_CARD_HEIGHT,
  WORKFLOW_NODE_CARD_WIDTH,
  isWorkflowTerminalNodeType,
  workflowNodeBoxSize,
  workflowNodeRadius,
} from "../workflow-node-cards";
import { resolveNodeWorkbenchDescriptor } from "../node-workbench";
import { useWorkflowReworkEdgeVisibility } from "../composables/useWorkflowReworkEdgeVisibility";
import { withWorkflowEdgeRouting } from "./workflow-edge-layout";
import WorkflowSmoothEdge from "./workflow-smooth-edge.vue";
import { buildWorkflowReworkEdges, hasWorkflowReworkEdges, isWorkflowReworkVisualEdge } from "./workflow-rework-edges";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";

defineOptions({ name: "WorkflowGraphView" });

const props = withDefaults(defineProps<{
  workflow: WorkflowRuntimeDefinition | null;
  nodeStates?: Record<string, NodeExecutionState> | null;
  nodeAssigneeLabelsByNodeId?: Record<string, string[]> | null;
  roleNameById?: Record<string, string> | null;
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  minHeight?: string;
  fillHeight?: boolean;
  showControls?: boolean;
  showMiniMap?: boolean;
  showReworkEdgeToggle?: boolean;
}>(), {
  nodeStates: null,
  nodeAssigneeLabelsByNodeId: null,
  roleNameById: null,
  selectedNodeId: null,
  selectedEdgeId: null,
  minHeight: "360px",
  fillHeight: false,
  showControls: false,
  showMiniMap: true,
  showReworkEdgeToggle: true,
});

type WorkflowGraphContextPayload = {
  id: string;
  clientX: number;
  clientY: number;
};

const emit = defineEmits<{
  (event: "node-click", nodeId: string): void;
  (event: "node-double-click", nodeId: string): void;
  (event: "work-items-click", nodeId: string): void;
  (event: "node-contextmenu", payload: WorkflowGraphContextPayload): void;
  (event: "edge-click", edgeId: string): void;
  (event: "edge-double-click", edgeId: string): void;
  (event: "edge-contextmenu", payload: WorkflowGraphContextPayload): void;
  (event: "pane-click"): void;
}>();

const flowId = `workflow-graph-${Math.random().toString(36).slice(2, 8)}`;
const { fitView } = useVueFlow(flowId);
const ui = useUiStore();
const {
  showReworkEdges,
  preferenceError: reworkEdgePreferenceError,
  reloadVisibility: reloadReworkEdgeVisibility,
  setReworkEdgeVisibility,
} = useWorkflowReworkEdgeVisibility(() => props.workflow?.workspaceId, () => props.workflow?.id);
const hasReworkEdges = computed(() => hasWorkflowReworkEdges(props.workflow?.nodes ?? []));

/** 提供给外层操作区，沿用同一份退回线显示偏好和失败提示。 */
function toggleReworkEdges(): void {
  setReworkEdgeVisibility(!showReworkEdges.value);
}

defineExpose({ hasReworkEdges, showReworkEdges, reworkEdgePreferenceError, toggleReworkEdges });

const WORKFLOW_EDGE_LABEL_BG_PADDING: [number, number] = [10, 4];
const isDarkTheme = computed(() => {
  if (ui.themeMode === "dark") return true;
  if (ui.themeMode === "light") return false;
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
});
const miniMapNodeColor = computed(() => (isDarkTheme.value ? "#415369" : "#d8e0ea"));
const miniMapNodeStrokeColor = computed(() => (isDarkTheme.value ? "#64748b" : "#b9c5d4"));
const miniMapMaskColor = computed(() => (isDarkTheme.value ? "rgba(15, 23, 37, 0.46)" : "rgba(240, 244, 248, 0.62)"));
const miniMapMaskStrokeColor = computed(() => (isDarkTheme.value ? "rgba(148, 163, 184, 0.74)" : "rgba(148, 163, 184, 0.5)"));
const miniMapWidth = 140;
const miniMapHeight = 105;
const workflowNodeLabelById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    (props.workflow?.nodes ?? [])
      .map((workflowNode) => {
        const nodeId = String(workflowNode.id ?? "").trim();
        const label = String(workflowNode.label ?? "").trim() || nodeId;
        return [nodeId, label] as const;
      })
      .filter(([nodeId]) => Boolean(nodeId)),
  ),
);

const flowNodes = computed<Node[]>(() =>
  (props.workflow?.nodes ?? []).map((node) => {
    return {
      id: node.id,
      type: "orch",
      position: {
        x: Math.round(node.position?.x ?? 0),
        y: Math.round(node.position?.y ?? 0),
      },
      data: buildNodeViewModel(node, props.nodeStates?.[node.id] ?? null, props.nodeAssigneeLabelsByNodeId?.[node.id] ?? []),
      style: nodeStyle(node, props.nodeStates?.[node.id] ?? null, props.selectedNodeId === node.id),
      draggable: false,
      selectable: true,
      connectable: false,
    };
  }),
);

const flowEdges = computed<Edge[]>(() => [
  // 只读画布同样拿不到自动布局路由，跨越型直连要靠绕行避让卡片。
  ...withWorkflowEdgeRouting(
    (props.workflow?.edges ?? []).map((edge) => {
      const selected = props.selectedEdgeId === edge.id;
      const stroke = selected ? "#1677ff" : "#94a3b8";
      return {
        id: edge.id,
        source: edge.sourceNodeId,
        target: edge.targetNodeId,
        type: "workflow-smooth",
        label: edge.conditionBranch ?? "",
        labelShowBg: true,
        labelBgPadding: WORKFLOW_EDGE_LABEL_BG_PADDING,
        labelBgBorderRadius: 10,
        markerEnd: {
          type: MarkerType.Arrow,
          width: 11,
          height: 11,
          color: stroke,
          strokeWidth: selected ? 1.35 : 1.2,
        },
        animated: selected,
        style: edgeStyle(edge, selected),
        data: {
          workflowEdge: edge,
          ...(edge.routePoints?.length ? { routePoints: edge.routePoints } : {}),
        },
        interactionWidth: 18,
        selectable: true,
      };
    }),
    props.workflow?.nodes ?? [],
    (node) => graphNodeBoxSize(node.type),
  ),
  ...(showReworkEdges.value
    ? buildWorkflowReworkEdges(props.workflow?.nodes ?? [], {
      nodeWidth: WORKFLOW_NODE_CARD_WIDTH,
      nodeHeight: WORKFLOW_NODE_CARD_HEIGHT,
      dark: isDarkTheme.value,
      resolveNodeSize: (node) => graphNodeBoxSize(node.type),
    })
    : []),
]);

watch(
  () => [
    props.workflow?.id ?? "",
    props.workflow?.nodes.length ?? 0,
    props.workflow?.edges.length ?? 0,
  ].join("|"),
  async () => {
    await nextTick();
    fitView({ padding: 0.16, duration: 180 });
  },
  { immediate: true },
);

type GraphNodeViewModel = {
  label: string;
  eyebrow: string | null;
  statusLabel: string;
  statusTone: WorkflowNodeCardTone;
  /** 开始/结束：渲染成圆形终止符，只显示居中节点名。 */
  terminal: boolean;
  /** 终止符的运行态文案（如「失败」）；配置态为 null，此时类型名与节点名重复、无需展示。 */
  terminalStatusLabel: string | null;
  assigneeText: string | null;
  assigneeTitle: string | null;
  metrics: Array<{
    key: string;
    label: string;
    value: string;
    tone: WorkflowNodeCardMetricTone;
  }>;
  badges: Array<{
    key: string;
    text: string;
    tone: WorkflowNodeCardTone;
  }>;
};

function buildNodeViewModel(node: WorkflowNode, state: NodeExecutionState | null, assigneeLabels: string[] = []): GraphNodeViewModel {
  const assignee = summarizeAssigneeLabels(assigneeLabels);
  const terminal = isWorkflowTerminalNodeType(node.type);
  if (!state) {
    const model = buildConfigNodeCardViewModel(node, {
      roleName: resolveRoleName(node.roleId),
      // 退回徽标显示节点名：复用本视图已有的 id→label 解析。
      resolveNodeLabel: (nodeId) => resolveWorkflowNodeLabel(nodeId),
    });
    return {
      ...model,
      terminal,
      // 配置态的类型名与节点名重复，圆里不再重复展示。
      terminalStatusLabel: null,
      assigneeText: assignee.text,
      assigneeTitle: assignee.title,
    };
  }

  const metrics: GraphNodeViewModel["metrics"] = [];
  const workbench = resolveNodeWorkbenchDescriptor(state);
  if (state.workItemSummary) {
    metrics.push({
      key: "workItems",
      label: "工作项",
      value: `${state.workItemSummary.completed}/${state.workItemSummary.total}`,
      tone: "output",
    });
  }
  pushRuntimeCountMetric(metrics, "input", "输入", state.inputArtifactIds?.length ?? 0, "input");
  pushRuntimeCountMetric(metrics, "output", "输出", state.outputArtifactIds?.length ?? 0, "output");
  if (state.status === "waiting-start" || state.status === "waiting-approval" || state.status === "waiting-feedback") {
    metrics.push({ key: "human", label: "人工", value: "需要", tone: "human" });
  }
  if (state.threadId) metrics.push({ key: "thread", label: "会话", value: "已连", tone: "thread" });
  if (state.status === "waiting-start" || state.status === "waiting-approval" || state.status === "waiting-feedback") {
    // keep waiting state visible even when card height is fixed
  }
  if ((state.retryCount ?? 0) > 0) {
    metrics.push({ key: "retry", label: "重试", value: String(state.retryCount), tone: "retry" });
  }

  const badges: GraphNodeViewModel["badges"] = [];
  if (state.conclusion?.reviewVerdict === "fail") badges.push({ key: "verdict", text: "不通过", tone: "danger" });
  if (state.conclusion?.reviewVerdict === "partial") badges.push({ key: "verdict", text: "部分满足", tone: "warning" });
  if (workbench.attentionKind === "execution_error") badges.push({ key: "interrupt", text: "中断", tone: "danger" });
  if (state.conclusion?.nextAction === "rework") {
    badges.push({
      key: "rework",
      text: `退回 ${resolveWorkflowNodeLabel(state.conclusion.rework?.targetNodeId) ?? "-"}`,
      tone: "danger",
    });
  }
  if (state.conclusion?.nextAction === "ask_human") badges.push({ key: "human", text: "需补充", tone: "warning" });
  if (state.conclusion?.nextAction === "stop") badges.push({ key: "stop", text: "待决策", tone: "warning" });

  return {
    label: node.label,
    eyebrow: null,
    statusLabel: workbench.statusLabel,
    statusTone: statusTone(state),
    terminal,
    // 运行态的圆同样要能读出状态：结束节点的 danger 色与「失败」同色，只靠颜色区分不出来。
    terminalStatusLabel: terminal ? workbench.statusLabel : null,
    assigneeText: assignee.text,
    assigneeTitle: assignee.title,
    metrics: metrics.slice(0, 4),
    badges,
  };
}

/** 压缩节点处理人文案；完整名单放在 title，避免多人协作时撑开节点卡片。 */
function summarizeAssigneeLabels(labels: string[]): { text: string | null; title: string | null } {
  const normalized = Array.from(new Set(labels.map((item) => String(item ?? "").trim()).filter(Boolean)));
  if (!normalized.length) return { text: null, title: null };
  const title = normalized.join("、");
  if (normalized.length <= 2) {
    return { text: `处理人 ${title}`, title };
  }
  return { text: `处理人 ${normalized.slice(0, 2).join("、")} 等 ${normalized.length} 人`, title };
}

function resolveWorkflowNodeLabel(nodeId: string | null | undefined): string | null {
  const normalizedId = String(nodeId ?? "").trim();
  if (!normalizedId) return null;
  return workflowNodeLabelById.value[normalizedId] ?? normalizedId;
}

function resolveRoleName(roleId: string | null | undefined): string | null {
  const id = String(roleId ?? "").trim();
  if (!id) return null;
  const roleName = props.roleNameById?.[id];
  return typeof roleName === "string" && roleName.trim().length > 0 ? roleName : null;
}

function pushRuntimeCountMetric(
  metrics: GraphNodeViewModel["metrics"],
  key: string,
  label: string,
  count: number,
  tone: WorkflowNodeCardMetricTone,
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  metrics.push({ key, label, value: String(count), tone });
}

/** 按节点类型解析画布内的 bbox 尺寸；开始/结束取正方形（即圆的外接框）。 */
function graphNodeBoxSize(type: string | null | undefined): { width: number; height: number } {
  return workflowNodeBoxSize(type, {
    width: WORKFLOW_NODE_CARD_WIDTH,
    height: WORKFLOW_NODE_CARD_HEIGHT,
  });
}

function nodeStyle(node: WorkflowNode, state: NodeExecutionState | null, selected: boolean): Record<string, string> {
  const palette = statePalette(state, isDarkTheme.value);
  const size = graphNodeBoxSize(node.type);
  const base = {
    width: `${size.width}px`,
    height: `${size.height}px`,
    padding: "0",
    borderRadius: workflowNodeRadius(node.type),
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.text,
    boxShadow: selected ? `0 0 0 2px ${palette.focus}` : "0 8px 20px rgba(15, 23, 42, 0.08)",
    overflow: "hidden",
  };
  return base;
}

function edgeStyle(edge: WorkflowEdge, selected: boolean): Record<string, string | number> {
  return {
    stroke: selected ? "#1677ff" : "#94a3b8",
    strokeWidth: selected ? 2.2 : 1.65,
  };
}

function statePalette(state: NodeExecutionState | null, isDark: boolean): { background: string; border: string; text: string; focus: string } {
  if (isDark) {
    const workbench = resolveNodeWorkbenchDescriptor(state);
    if (workbench.attentionKind === "execution_error") {
      return { background: "linear-gradient(180deg, rgba(74, 23, 26, 0.94), rgba(44, 15, 17, 0.96))", border: "#8f3b40", text: "#ffe4e6", focus: "rgba(255, 99, 99, 0.2)" };
    }
    switch (state?.status) {
      case "completed":
        return { background: "linear-gradient(180deg, rgba(24, 45, 31, 0.94), rgba(16, 30, 22, 0.96))", border: "#3e6f4f", text: "#e7f8ec", focus: "rgba(82, 196, 26, 0.22)" };
      case "running":
        return { background: "linear-gradient(180deg, rgba(20, 38, 62, 0.94), rgba(14, 28, 46, 0.96))", border: "#3f6394", text: "#e9f2ff", focus: "rgba(80, 140, 255, 0.26)" };
      case "waiting-approval":
        return { background: "linear-gradient(180deg, rgba(29, 35, 67, 0.94), rgba(20, 26, 52, 0.96))", border: "#4f5f9c", text: "#eef2ff", focus: "rgba(120, 136, 255, 0.22)" };
      case "waiting-start":
        return { background: "linear-gradient(180deg, rgba(58, 42, 24, 0.94), rgba(42, 29, 16, 0.96))", border: "#9a6b3d", text: "#fff3e0", focus: "rgba(250, 140, 22, 0.22)" };
      case "waiting-feedback":
        return { background: "linear-gradient(180deg, rgba(61, 45, 21, 0.94), rgba(45, 33, 15, 0.96))", border: "#9a783d", text: "#fff4db", focus: "rgba(250, 173, 20, 0.24)" };
      case "result-submitted":
      case "finalizing":
      case "artifact-writing":
      case "gate-checking":
        return { background: "linear-gradient(180deg, rgba(49, 33, 72, 0.94), rgba(34, 22, 52, 0.96))", border: "#6f4fa6", text: "#f1e9ff", focus: "rgba(168, 125, 255, 0.22)" };
      case "failed":
        return { background: "linear-gradient(180deg, rgba(74, 23, 26, 0.94), rgba(44, 15, 17, 0.96))", border: "#8f3b40", text: "#ffe4e6", focus: "rgba(255, 99, 99, 0.2)" };
      case "cancelled":
      case "skipped":
        return { background: "linear-gradient(180deg, rgba(36, 41, 49, 0.94), rgba(24, 29, 36, 0.96))", border: "#596475", text: "#e5e7eb", focus: "rgba(148, 163, 184, 0.2)" };
      case "ready":
      case "queued":
        return { background: "linear-gradient(180deg, rgba(17, 42, 45, 0.94), rgba(12, 30, 32, 0.96))", border: "#3f7d79", text: "#defaf6", focus: "rgba(54, 211, 196, 0.22)" };
      default:
        return { background: "linear-gradient(180deg, rgba(31, 36, 45, 0.94), rgba(23, 28, 36, 0.96))", border: "#546072", text: "#edf1f7", focus: "rgba(148, 163, 184, 0.2)" };
    }
  }

  const workbench = resolveNodeWorkbenchDescriptor(state);
  if (workbench.attentionKind === "execution_error") {
    return { background: "linear-gradient(180deg, rgba(255,242,240,0.96), #ffffff)", border: "#ffccc7", text: "#1f2937", focus: "rgba(255, 77, 79, 0.18)" };
  }
  switch (state?.status) {
    case "completed":
      return { background: "linear-gradient(180deg, rgba(246,255,237,0.95), #ffffff)", border: "#b7eb8f", text: "#1f2937", focus: "rgba(82, 196, 26, 0.2)" };
    case "running":
      return { background: "linear-gradient(180deg, rgba(230,244,255,0.95), #ffffff)", border: "#91caff", text: "#1f2937", focus: "rgba(22, 119, 255, 0.22)" };
    case "waiting-approval":
      return { background: "linear-gradient(180deg, rgba(240,245,255,0.96), #ffffff)", border: "#adc6ff", text: "#1f2937", focus: "rgba(9, 88, 217, 0.2)" };
    case "waiting-start":
      return { background: "linear-gradient(180deg, rgba(255,247,230,0.96), #ffffff)", border: "#ffd591", text: "#1f2937", focus: "rgba(250, 140, 22, 0.18)" };
    case "waiting-feedback":
      return { background: "linear-gradient(180deg, rgba(255,251,230,0.96), #ffffff)", border: "#ffe58f", text: "#1f2937", focus: "rgba(250, 173, 20, 0.2)" };
    case "result-submitted":
    case "finalizing":
    case "artifact-writing":
    case "gate-checking":
      return { background: "linear-gradient(180deg, rgba(249,240,255,0.96), #ffffff)", border: "#d3adf7", text: "#1f2937", focus: "rgba(114, 46, 209, 0.18)" };
    case "failed":
      return { background: "linear-gradient(180deg, rgba(255,242,240,0.96), #ffffff)", border: "#ffccc7", text: "#1f2937", focus: "rgba(255, 77, 79, 0.18)" };
    case "cancelled":
    case "skipped":
      return { background: "linear-gradient(180deg, rgba(250,250,250,0.98), #ffffff)", border: "#d9d9d9", text: "#1f2937", focus: "rgba(140, 140, 140, 0.18)" };
    case "ready":
    case "queued":
      return { background: "linear-gradient(180deg, rgba(240,253,250,0.96), #ffffff)", border: "#87e8de", text: "#1f2937", focus: "rgba(19, 194, 194, 0.18)" };
    default:
      return { background: "linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.96))", border: "#d9d9d9", text: "#1f2937", focus: "rgba(148, 163, 184, 0.16)" };
  }
}

function statusTone(state: NodeExecutionState | null): WorkflowNodeCardTone {
  const workbench = resolveNodeWorkbenchDescriptor(state);
  if (workbench.attentionKind === "execution_error") {
    return "danger";
  }
  switch (state?.status) {
    case "completed":
      return "success";
    case "running":
    case "waiting-approval":
      return "info";
    case "waiting-start":
    case "waiting-feedback":
      return "warning";
    case "failed":
      return "danger";
    case "result-submitted":
    case "finalizing":
    case "artifact-writing":
    case "gate-checking":
      return "violet";
    default:
      return "neutral";
  }
}

function nodeStatusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    pending: "等待",
    ready: "就绪",
    queued: "排队",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "写入结果",
    "gate-checking": "门禁检查",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待反馈",
    completed: "已完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
  };
  return map[String(status ?? "")] ?? String(status ?? "-");
}

function onCanvasContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const nodeEl = target.closest(".vue-flow__node[data-id]") as HTMLElement | null;
  if (nodeEl) {
    const nodeId = String(nodeEl.dataset.id ?? "").trim();
    if (!nodeId) return;
    event.preventDefault();
    emit("node-contextmenu", {
      id: nodeId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    return;
  }

  const edgeEl = target.closest(".vue-flow__edge[data-id]") as HTMLElement | null;
  if (edgeEl) {
    const edgeId = String(edgeEl.dataset.id ?? "").trim();
    if (!edgeId) return;
    if (flowEdges.value.some((edge) => edge.id === edgeId && isWorkflowReworkVisualEdge(edge))) return;
    event.preventDefault();
    emit("edge-contextmenu", {
      id: edgeId,
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }
}
</script>

<template>
  <div class="wf-graph-view" :style="{ minHeight, ...(fillHeight ? { height: '100%' } : {}) }" @contextmenu="onCanvasContextMenu">
    <VueFlow
      :id="flowId"
      :nodes="flowNodes"
      :edges="flowEdges"
      :nodes-draggable="false"
      :nodes-connectable="false"
      :elements-selectable="true"
      :fit-view-on-init="true"
      :zoom-on-double-click="false"
      class="wf-graph-view__canvas"
      @node-click="(event) => emit('node-click', event.node.id)"
      @node-double-click="(event) => emit('node-double-click', event.node.id)"
      @edge-click="(event) => { if (!isWorkflowReworkVisualEdge(event.edge)) emit('edge-click', event.edge.id); }"
      @edge-double-click="(event) => { if (!isWorkflowReworkVisualEdge(event.edge)) emit('edge-double-click', event.edge.id); }"
      @pane-click="emit('pane-click')"
    >
      <template #edge-workflow-smooth="edgeProps">
        <WorkflowSmoothEdge v-bind="edgeProps" />
      </template>
      <template #node-orch="nodeProps">
        <div
          class="wf-graph-node"
          :class="[`wf-graph-node--${nodeProps.data.statusTone}`, { 'wf-graph-node--terminal': nodeProps.data.terminal }]"
        >
          <!-- 开始/结束是圆形的终止符：只留居中节点名，不再重复类型徽标与运行指标。 -->
          <strong v-if="nodeProps.data.terminal" class="wf-graph-node__terminal-label">
            {{ nodeProps.data.label }}
          </strong>
          <span
            v-if="nodeProps.data.terminal && nodeProps.data.terminalStatusLabel"
            class="wf-graph-node__terminal-status"
          >
            {{ nodeProps.data.terminalStatusLabel }}
          </span>
          <div v-if="!nodeProps.data.terminal" class="wf-graph-node__head">
            <div class="wf-graph-node__copy">
              <span v-if="nodeProps.data.eyebrow" class="wf-graph-node__eyebrow">{{ nodeProps.data.eyebrow }}</span>
              <strong>{{ nodeProps.data.label }}</strong>
            </div>
            <span class="wf-graph-node__status" :class="`wf-graph-node__status--${nodeProps.data.statusTone}`">
              {{ nodeProps.data.statusLabel }}
            </span>
          </div>
          <div v-if="!nodeProps.data.terminal && nodeProps.data.assigneeText" class="wf-graph-node__assignee" :title="nodeProps.data.assigneeTitle">
            {{ nodeProps.data.assigneeText }}
          </div>
          <div v-if="!nodeProps.data.terminal && nodeProps.data.metrics.length" class="wf-graph-node__metrics">
            <template
              v-for="metric in nodeProps.data.metrics"
              :key="metric.key"
            >
              <button
                v-if="metric.key === 'workItems'"
                type="button"
                class="wf-graph-node__metric wf-graph-node__metric-button"
                :class="`wf-graph-node__metric--${metric.tone}`"
                :title="`查看工作项（已完成 ${metric.value}）`"
                :aria-label="`${nodeProps.data.label}工作项，已完成 ${metric.value}，点击查看`"
                @click.stop="emit('work-items-click', nodeProps.id)"
                @dblclick.stop
              >
                <UnorderedListOutlined aria-hidden="true" />
                <span>{{ metric.label }}</span>
                <strong>{{ metric.value }}</strong>
              </button>
              <span
                v-else
                class="wf-graph-node__metric"
                :class="`wf-graph-node__metric--${metric.tone}`"
              >
                {{ metric.label }} {{ metric.value }}
              </span>
            </template>
          </div>
          <div v-if="!nodeProps.data.terminal && nodeProps.data.badges.length" class="wf-graph-node__badges">
            <span
              v-for="badge in nodeProps.data.badges"
              :key="badge.key"
              class="wf-graph-node__badge"
              :class="`wf-graph-node__badge--${badge.tone}`"
            >
              {{ badge.text }}
            </span>
          </div>
        </div>
      </template>
      <Background />
      <Controls v-if="showControls" />
      <Panel
        v-if="showReworkEdgeToggle && hasReworkEdges"
        position="top-right"
      >
        <a-button
          size="small"
          :aria-pressed="showReworkEdges"
          :disabled="!!reworkEdgePreferenceError"
          title="退回线只解释节点允许退回到哪些节点，不参与流程执行；该偏好只记在本机，按流程分别保存"
          @click="setReworkEdgeVisibility(!showReworkEdges)"
        >
          {{ showReworkEdges ? "隐藏退回线" : "显示退回线" }}
        </a-button>
      </Panel>
      <MiniMap
        v-if="showMiniMap"
        position="bottom-right"
        :width="miniMapWidth"
        :height="miniMapHeight"
        :node-color="miniMapNodeColor"
        :node-stroke-color="miniMapNodeStrokeColor"
        :mask-color="miniMapMaskColor"
        :mask-stroke-color="miniMapMaskStrokeColor"
        :mask-stroke-width="1.1"
        :mask-border-radius="8"
      />
    </VueFlow>
    <a-alert v-if="reworkEdgePreferenceError" type="error" :message="reworkEdgePreferenceError" show-icon class="wf-graph-view__preference-error">
      <template #action>
        <a-button size="small" @click="reloadReworkEdgeVisibility">重试</a-button>
      </template>
    </a-alert>
  </div>
</template>

<style scoped>
.wf-graph-view {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 18px;
  overflow: hidden;
  background:
    radial-gradient(circle at top left, rgba(22, 119, 255, 0.08), transparent 28%),
    linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 98%, #f7f9fc), var(--app-bg, #fff));
}

.wf-graph-view__canvas {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.wf-graph-view__preference-error {
  flex: 0 0 auto;
  margin: 8px 12px;
}

:deep(.wf-graph-view__canvas .vue-flow__node) {
  background: transparent;
}

:deep(.wf-graph-view__canvas .vue-flow__edge-path),
:deep(.wf-graph-view__canvas .vue-flow__edge-interaction) {
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

:deep(.wf-graph-view__canvas .vue-flow__edge-path) {
  stroke: #94a3b8;
  stroke-width: 1.65px;
  transition: stroke 0.18s ease, stroke-width 0.18s ease;
}

:deep(.wf-graph-view__canvas .vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: #1677ff;
  stroke-width: 2.2px;
}

.wf-graph-node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 9px 12px;
  color: inherit;
  overflow: hidden;
}

/* 开始/结束是圆：节点名居中；bbox 即外接正方形，单条连线时端点落在圆切点上。 */
.wf-graph-node--terminal {
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
}

.wf-graph-node__terminal-label {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  padding: 0 14px;
  font-size: 13px;
  line-height: 1.35;
  text-align: center;
  word-break: break-word;
}

/* 运行态的状态文字紧贴节点名下方，字号小一档，避免撑破圆。 */
.wf-graph-node__terminal-status {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.2;
  opacity: 0.75;
  text-align: center;
}

.wf-graph-node__head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
  min-width: 0;
}

.wf-graph-node__copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.wf-graph-node__eyebrow {
  font-size: 10px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--app-text, #1f2937) 54%, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-graph-node__head strong {
  font-size: 13px;
  line-height: 1.35;
  color: inherit;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}

.wf-graph-node__status {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  max-width: 84px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.wf-graph-node__status--neutral {
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.wf-graph-node__status--info {
  background: rgba(22, 119, 255, 0.12);
  color: #0958d9;
}

.wf-graph-node__status--success {
  background: rgba(82, 196, 26, 0.14);
  color: #237804;
}

.wf-graph-node__status--warning {
  background: rgba(250, 173, 20, 0.16);
  color: #ad6800;
}

.wf-graph-node__status--danger {
  background: rgba(255, 77, 79, 0.14);
  color: #cf1322;
}

.wf-graph-node__status--violet {
  background: rgba(114, 46, 209, 0.14);
  color: #531dab;
}

.wf-graph-node__assignee {
  min-width: 0;
  padding-left: 8px;
  border-left: 2px solid rgba(22, 119, 255, 0.45);
  color: color-mix(in srgb, currentColor 72%, #64748b);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-graph-node__metrics,
.wf-graph-node__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-content: flex-start;
  overflow: hidden;
}

.wf-graph-node__metrics {
  min-height: 22px;
  max-height: 52px;
}

.wf-graph-node__badges {
  min-height: 0;
  max-height: 24px;
}

.wf-graph-node__metric,
.wf-graph-node__badge {
  display: inline-flex;
  align-items: center;
  min-height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.wf-graph-node__metric-button {
  gap: 4px;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.wf-graph-node__metric-button:hover {
  border-color: currentColor;
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.12);
}

.wf-graph-node__metric-button:active {
  transform: translateY(1px);
}

.wf-graph-node__metric-button:focus-visible {
  outline: 2px solid var(--app-accent, #c96442);
  outline-offset: 1px;
}

.wf-graph-node__metric-button strong {
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.wf-graph-node__metric--input {
  background: rgba(22, 119, 255, 0.12);
  color: #0958d9;
}

.wf-graph-node__metric--output {
  background: rgba(82, 196, 26, 0.14);
  color: #237804;
}

.wf-graph-node__metric--thread {
  background: rgba(114, 46, 209, 0.14);
  color: #531dab;
}

.wf-graph-node__metric--human {
  background: rgba(250, 173, 20, 0.16);
  color: #ad6800;
}

.wf-graph-node__metric--retry {
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.wf-graph-node__badge--neutral {
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.wf-graph-node__badge--info {
  background: rgba(22, 119, 255, 0.12);
  color: #0958d9;
}

.wf-graph-node__badge--success {
  background: rgba(82, 196, 26, 0.14);
  color: #237804;
}

.wf-graph-node__badge--warning {
  background: rgba(250, 173, 20, 0.16);
  color: #ad6800;
}

.wf-graph-node__badge--danger {
  background: rgba(255, 77, 79, 0.14);
  color: #cf1322;
}

.wf-graph-node__badge--violet {
  background: rgba(114, 46, 209, 0.14);
  color: #531dab;
}

/* 画布浮层配色只用主题变量，不用 :root[data-theme] 属性选择器：
   在 scoped 样式里 :root 会被编译成 :root[data-theme][data-v-x]，html 上永远没有组件属性，规则会静默失效。 */
:deep(.wf-graph-view__canvas .vue-flow__controls) {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--app-panel-bg);
  box-shadow: var(--app-shadow);
}

:deep(.wf-graph-view__canvas .vue-flow__controls .vue-flow__controls-button) {
  background: transparent;
  border-bottom: 1px solid var(--app-divider);
  color: var(--app-muted);
}

:deep(.wf-graph-view__canvas .vue-flow__controls .vue-flow__controls-button:last-child) { border-bottom: 0; }

:deep(.wf-graph-view__canvas .vue-flow__controls .vue-flow__controls-button:hover) { background: var(--app-sidebar-hover-bg); color: var(--app-text); }

/* 库的按钮图标是写死的深色，必须显式跟随 currentColor 才能随按钮文字色一起变。 */
:deep(.wf-graph-view__canvas .vue-flow__controls .vue-flow__controls-button svg) { fill: currentColor; stroke: currentColor; }

:deep(.wf-graph-view__canvas .vue-flow__minimap) {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--app-panel-bg);
  box-shadow: var(--app-shadow);
}

:deep(.wf-graph-view__canvas .vue-flow__edge-textbg) {
  fill: var(--app-panel-bg);
}

:deep(.wf-graph-view__canvas .vue-flow__edge-text) {
  fill: var(--app-text);
  font-size: 11px;
  font-weight: 600;
}

:root[data-theme="dark"] .wf-graph-view {
  border-color: #303030;
  background:
    radial-gradient(circle at top left, rgba(22, 119, 255, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
}

:root[data-theme="dark"] .wf-graph-node__head strong {
  color: #f3f4f6;
}

:root[data-theme="dark"] .wf-graph-node__status--neutral,
:root[data-theme="dark"] .wf-graph-node__metric--retry,
:root[data-theme="dark"] .wf-graph-node__badge--neutral {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}

:root[data-theme="dark"] .wf-graph-node__status--info,
:root[data-theme="dark"] .wf-graph-node__metric--input,
:root[data-theme="dark"] .wf-graph-node__badge--info {
  background: rgba(22, 119, 255, 0.16);
  color: #8eb7ff;
}

:root[data-theme="dark"] .wf-graph-node__status--success,
:root[data-theme="dark"] .wf-graph-node__metric--output,
:root[data-theme="dark"] .wf-graph-node__badge--success {
  background: rgba(82, 196, 26, 0.18);
  color: #b7eb8f;
}

:root[data-theme="dark"] .wf-graph-node__status--warning,
:root[data-theme="dark"] .wf-graph-node__metric--human,
:root[data-theme="dark"] .wf-graph-node__badge--warning {
  background: rgba(250, 173, 20, 0.18);
  color: #ffd666;
}

:root[data-theme="dark"] .wf-graph-node__status--danger,
:root[data-theme="dark"] .wf-graph-node__badge--danger {
  background: rgba(255, 77, 79, 0.18);
  color: #ffccc7;
}

:root[data-theme="dark"] .wf-graph-node__status--violet,
:root[data-theme="dark"] .wf-graph-node__metric--thread,
:root[data-theme="dark"] .wf-graph-node__badge--violet {
  background: rgba(114, 46, 209, 0.18);
  color: #d3adf7;
}
</style>

