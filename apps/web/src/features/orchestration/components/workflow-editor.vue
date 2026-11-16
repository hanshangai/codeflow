<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRaw, watch } from "vue";
import { ConnectionMode, Handle, MarkerType, Position, VueFlow, useVueFlow, type Connection, type Edge, type EdgeUpdateEvent, type Node } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import { message } from "ant-design-vue";
import { DownOutlined, InfoCircleOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons-vue";
import {
  canMaintainBuiltinSpecAssets,
  DEFAULT_WORKFLOW_FAMILY,
  normalizeWorkflowFamily,
  type ArtifactBinding,
  type ArtifactOutputMode,
  type DataMapping,
  type EngineType,
  type WorkflowExecutionDefault,
  type OutputWritePolicy,
  type KnowledgeBundleDefinition,
  normalizeNodeWorkItemPolicy,
  type RoleDefinition,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkspaceId,
  type WorkflowId,
} from "@codeflowai/shared";
import {
  buildConfigNodeCardViewModel,
  buildWorkflowNodeLabelIndex,
  type WorkflowNodeCardViewModel,
  WORKFLOW_NODE_CARD_WIDTH,
  WORKFLOW_NODE_GAP_X,
  WORKFLOW_NODE_GAP_Y,
  isWorkflowTerminalNodeType,
  workflowNodeBoxSize,
  workflowNodeRadius,
  workflowNodeTypeTone,
} from "../workflow-node-cards";
import { computeWorkflowAutoLayout, type WorkflowAutoLayoutDirection, type WorkflowRoutePoint } from "./workflow-auto-layout";
import { withWorkflowEdgeRouting } from "./workflow-edge-layout";
import { buildWorkflowReworkEdges, hasWorkflowReworkEdges, isWorkflowReworkVisualEdge } from "./workflow-rework-edges";
import WorkflowAssigneeTemplateManager from "./workflow-assignee-template-manager.vue";
import WorkflowSmoothEdge from "./workflow-smooth-edge.vue";

import { useApiContext } from "../../../composables/useApiContext";
import { buildModelSelectOptionGroups } from "../../../composables/modelSelectOptions";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useUiStore } from "../../../store/ui";
import { parseSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { useOrchAssetDirtyState } from "../composables/useOrchAssetDirtyState";
import { useWorkflowReworkEdgeVisibility } from "../composables/useWorkflowReworkEdgeVisibility";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";

defineOptions({ name: "WorkflowEditor" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  sourceDefinition?: WorkflowDefinition | null;
  /** 角色选择只需要稳定的 ID 和名称。 */
  roleDefinitions?: Array<Pick<RoleDefinition, "id" | "name">>;
  saveLabel?: string;
  /** 无工作区只读预览：强制只读，且不触发展示以外的任何请求。 */
  previewReadonly?: boolean;
}>();
const emit = defineEmits<{ (event: "dirty-change", dirty: boolean): void }>();
const WORKFLOW_EDITOR_NODE_CARD_HEIGHT = 134;
/** 编辑器节点基准尺寸；开始/结束在此基础上取正方形（见 workflowNodeBoxSize）。 */
const WORKFLOW_EDITOR_NODE_BASE_SIZE = {
  width: WORKFLOW_NODE_CARD_WIDTH,
  height: WORKFLOW_EDITOR_NODE_CARD_HEIGHT,
} as const;
const WORKFLOW_EDITOR_MIN_ZOOM = 0.5;
const WORKFLOW_EDITOR_INITIAL_READABLE_ZOOM = 0.68;
const WORKFLOW_EDITOR_INITIAL_PADDING = 32;
const WORKFLOW_EDGE_LABEL_BG_PADDING: [number, number] = [10, 4];
/** 方向键微调节点的步长；按住 Shift 走大步。 */
const NODE_NUDGE_STEP = 1;
const NODE_NUDGE_STEP_FAST = 10;
const NODE_NUDGE_DIRECTIONS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};
const WORKFLOW_EDGE_MARKER = {
  type: MarkerType.Arrow,
  width: 11,
  height: 11,
  color: "#94a3b8",
  strokeWidth: 1.2,
} as const;
const WORKFLOW_EDGE_SELECTED_MARKER = {
  ...WORKFLOW_EDGE_MARKER,
  color: "#1677ff",
  strokeWidth: 1.35,
} as const;

type FlowNodeData = {
  label: string;
  workflowNode: WorkflowNode;
  card: WorkflowNodeCardViewModel;
};

const orch = useOrchestrationStore();
const config = useConfigStore();
const ui = useUiStore();
const { ctx } = useApiContext();
const workflowName = ref("");
const workflowDescription = ref("");
const workflowFamily = ref<WorkflowDefinition["family"]>(null);
const workflowKnowledgeBundleIds = ref<string[]>([]);
/** 流程默认知识库条目较多，默认收起，避免挤占流程设置弹窗；需要时再展开。 */
const knowledgeSectionExpanded = ref(false);
const editorNodes = ref<Node<FlowNodeData>[]>([]);
const editorEdges = ref<Edge[]>([]);
let suppressDisplayEdgeModelUpdate = false;
const {
  showReworkEdges,
  preferenceError: reworkEdgePreferenceError,
  reloadVisibility: reloadReworkEdgeVisibility,
  setReworkEdgeVisibility,
} = useWorkflowReworkEdgeVisibility(() => props.workspaceId, () => props.workflowId);
const hasReworkEdges = computed(() => hasWorkflowReworkEdges(
  editorNodes.value.flatMap((node) => node.data?.workflowNode ? [node.data.workflowNode] : []),
));
/** 退回关系仅作为画布提示，正常流程边仍由 editorEdges 独立维护。 */
const displayEdges = computed<Edge[]>({
  get: () => [
    ...editorEdges.value,
    // 关掉时不构建这些线，顺带省掉一次退回线的布局计算。
    ...(showReworkEdges.value
      ? buildWorkflowReworkEdges(editorNodes.value.flatMap((node) => node.data?.workflowNode
        ? [{ ...node.data.workflowNode, position: node.position }]
        : []), {
        nodeWidth: WORKFLOW_NODE_CARD_WIDTH,
        nodeHeight: WORKFLOW_EDITOR_NODE_CARD_HEIGHT,
        dark: isDarkTheme.value,
        resolveNodeSize: (node) => editorNodeBoxSize(node.type),
      })
      : []),
  ],
  set: (edges) => {
    if (suppressDisplayEdgeModelUpdate) {
      suppressDisplayEdgeModelUpdate = false;
      return;
    }
    editorEdges.value = edges
      .filter((edge) => !isWorkflowReworkVisualEdge(edge))
      .map(stripVueFlowEdgeInternals);
  },
});
const selectedNodeId = ref<string | null>(null);
const selectedEdgeId = ref<string | null>(null);
const canvasShellRef = ref<HTMLElement | null>(null);
const bindingEditorOpen = ref(false);
/** 绑定弹窗的高频区（基础信息、执行策略）常显，低频区默认收起以压缩纵向长度。 */
const bindingOutputSectionOpen = ref(false);
const bindingKnowledgeSectionOpen = ref(false);
const workflowSettingsOpen = ref(false);
const assigneeTemplateManagerOpen = ref(false);
const bindingModalBodyStyle = {
  maxHeight: "calc(100vh - 240px)",
  overflowY: "auto",
  paddingRight: "20px",
} as const;

/** 流程级模型配置：独立于流程定义存储，因此内置流程同样可编辑。 */
const engines = useEngineStore();
const executionDefaultEngine = ref<EngineType | null>(null);
const executionDefaultModel = ref("");
const savedExecutionDefault = ref<WorkflowExecutionDefault | null>(null);
const executionDefaultLoading = ref(false);
const executionDefaultSaving = ref(false);
/** 读取回填期间连续改写引擎与模型，此时不能被「引擎切换」逻辑误判成用户操作。 */
let suppressExecutionDefaultEngineWatch = false;
/** 该流程实际参与执行的角色数，用于提示强制覆盖范围。 */
const executionRoleCount = computed(() => new Set(
  editorNodes.value
    .filter((node) => node.data?.workflowNode.type === "role" && node.data?.workflowNode.roleId)
    .map((node) => String(node.data?.workflowNode.roleId)),
).size);
const executionDefaultModelOptions = computed(() => {
  const engine = executionDefaultEngine.value;
  if (!engine) return [];
  const models = engines.byTypeForWorkspace(props.workspaceId).get(engine)?.models ?? [];
  const groups = buildModelSelectOptionGroups(models, executionDefaultModel.value, { engine });
  const withProviderPrefix = groups.length > 1;
  return groups.flatMap((group) => group.options.map((option) => ({
    value: option.value,
    label: withProviderPrefix ? `${group.label} · ${option.label}` : option.label,
  })));
});
const contextMenu = ref<{
  visible: boolean;
  kind: "node" | "edge";
  id: string;
  x: number;
  y: number;
  title: string;
} | null>(null);
const {
  isDirty,
  draftSnapshot,
  hasUnsavedChanges,
  isSnapshotDifferentFromBaseline,
  markCleanFromCurrentDraft,
} = useOrchAssetDirtyState(() => buildWorkflowPayload());

/** 本地草稿按键隔离到工作区 + 流程，避免不同流程互相覆盖。 */
const WORKFLOW_DRAFT_STORAGE_PREFIX = "codeflow-orch-workflow-draft";

function workflowDraftStorageKey(workflowId: string): string {
  return `${WORKFLOW_DRAFT_STORAGE_PREFIX}:${props.workspaceId}:${workflowId}`;
}

/** 暂存的写入、恢复、清除必须共用同一个键来源，否则会写了读不到。 */
function currentWorkflowDraftId(): string {
  return String(props.workflowId ?? "").trim();
}

/** 最近一次从服务端加载到的版本标记；草稿据此判断自己是否已落后于最新落库内容。 */
const loadedServerUpdatedAt = ref(0);
// 初次加载/切换时先禁止清理已有草稿，待恢复检查完成后才把“用户改回基线”视为放弃草稿。
let draftHydrationReady = false;
let workflowLoadEpoch = 0;

let localDraftTimer: ReturnType<typeof setTimeout> | null = null;

/** 取消尚未落盘的暂存；切换流程、放弃改动、卸载都必须调用，否则定时器会把内容写到错误的键下。 */
function cancelPendingDraftPersist(): void {
  if (!localDraftTimer) return;
  clearTimeout(localDraftTimer);
  localDraftTimer = null;
}

/** 把流程快照写进编辑器状态；加载、恢复草稿、放弃改动三处共用，避免新增字段时漏改其中一处。 */
function applyWorkflowSnapshot(source: {
  name: string;
  description: string;
  family?: string | null;
  workflowKnowledgeBundleIds?: string[] | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}): void {
  workflowName.value = source.name;
  workflowDescription.value = source.description;
  workflowFamily.value = normalizeWorkflowFamily(source.family) ?? DEFAULT_WORKFLOW_FAMILY;
  workflowKnowledgeBundleIds.value = [...(source.workflowKnowledgeBundleIds ?? [])];
  // 索引必须来自本次快照：此刻 editorNodes 还是上一份数据，卡片徽标不能用它解析退回目标名。
  const nodeLabels = buildWorkflowNodeLabelIndex(source.nodes);
  editorNodes.value = source.nodes.map((node) => toFlowNode(node, nodeLabels));
  editorEdges.value = source.edges.map(toFlowEdge);
  // 已保存的自动布局折线属于流程定义的一部分；首次加载时保留，避免被默认绕行算法覆盖。
  refreshEditorEdgeAnchorLayouts(true);
  selectedNodeId.value = source.nodes[0]?.id ?? null;
  selectedEdgeId.value = null;
  bindingEditorOpen.value = false;
}

/**
 * 把当前编辑态写入本地暂存，避免未落库的改动因刷新丢失。
 * 降级意图：localStorage 写入失败（配额满、隐私模式）不阻断继续编辑，只留可检索告警（workflow-editor / local draft persist failed）；
 * 影响范围：仅失去「刷新后可恢复」能力，服务端已落库数据与本次会话内的编辑都不受影响。
 */
function persistWorkflowDraft(): void {
  const workflowId = currentWorkflowDraftId();
  if (!workflowId || !isDirty.value) return;
  try {
    window.localStorage.setItem(workflowDraftStorageKey(workflowId), JSON.stringify({
      savedAt: Date.now(),
      baseUpdatedAt: loadedServerUpdatedAt.value,
      name: workflowName.value,
      description: workflowDescription.value,
      family: workflowFamily.value,
      workflowKnowledgeBundleIds: [...workflowKnowledgeBundleIds.value],
      definition: buildWorkflowPayload(),
    }));
  } catch (error) {
    console.warn("[workflow-editor] local draft persist failed", { workflowId, error });
  }
}

/** 合并连续编辑后再写盘，避免逐次输入都写盘。 */
function scheduleWorkflowDraftPersist(): void {
  cancelPendingDraftPersist();
  // 加载/切换也会改变 draftSnapshot，但不能把初始化过程当成用户编辑写入本地草稿。
  if (!isDirty.value) {
    if (draftHydrationReady) clearWorkflowDraft();
    return;
  }
  localDraftTimer = setTimeout(() => {
    localDraftTimer = null;
    if (isDirty.value) persistWorkflowDraft();
  }, 400);
}

/** 清除当前流程的本地草稿；落库成功与放弃改动后都必须调用，否则下次打开会恢复出陈旧编辑。 */
function clearWorkflowDraft(): void {
  const workflowId = currentWorkflowDraftId();
  if (!workflowId) return;
  try {
    window.localStorage.removeItem(workflowDraftStorageKey(workflowId));
  } catch (error) {
    console.warn("[workflow-editor] local draft clear failed", { workflowId, error });
  }
}

/** 草稿必须带齐渲染依赖（id/type/label/position），否则恢复后会在视口计算等路径抛错且该键永不清除。 */
function isRestorableDraftDefinition(value: unknown): value is Omit<WorkflowDefinition, "createdAt" | "updatedAt"> {
  if (!value || typeof value !== "object") return false;
  const definition = value as {
    id?: unknown;
    workspaceId?: unknown;
    name?: unknown;
    description?: unknown;
    version?: unknown;
    nodes?: unknown;
    edges?: unknown;
    workflowKnowledgeBundleIds?: unknown;
  };
  if (typeof definition.id !== "string"
    || typeof definition.workspaceId !== "string"
    || typeof definition.name !== "string"
    || typeof definition.description !== "string"
    || !Number.isFinite(definition.version)
    || !Array.isArray(definition.nodes)
    || !Array.isArray(definition.edges)
    || (definition.workflowKnowledgeBundleIds !== undefined
      && (!Array.isArray(definition.workflowKnowledgeBundleIds)
        || !definition.workflowKnowledgeBundleIds.every((id) => typeof id === "string")))) return false;
  const validNodes = definition.nodes.every((node) => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as { id?: unknown; type?: unknown; label?: unknown; position?: { x?: unknown; y?: unknown } };
    return typeof candidate.id === "string"
      && typeof candidate.type === "string"
      && typeof candidate.label === "string"
      && Number.isFinite(candidate.position?.x)
      && Number.isFinite(candidate.position?.y);
  });
  if (!validNodes) return false;
  return definition.edges.every((edge) => {
    if (!edge || typeof edge !== "object") return false;
    const candidate = edge as { id?: unknown; sourceNodeId?: unknown; targetNodeId?: unknown; dataMappings?: unknown };
    return typeof candidate.id === "string"
      && typeof candidate.sourceNodeId === "string"
      && typeof candidate.targetNodeId === "string"
      && Array.isArray(candidate.dataMappings)
      && candidate.dataMappings.every((mapping) => {
        if (!mapping || typeof mapping !== "object") return false;
        const item = mapping as { sourceField?: unknown; targetField?: unknown };
        return typeof item.sourceField === "string" && typeof item.targetField === "string";
      });
  });
}

/**
 * 恢复本地草稿并覆盖当前编辑态；只读资产不恢复，内容损坏时丢弃该键而不是每次打开都失败。
 * 返回 baseUpdatedAt 供调用方判断草稿是否已落后于服务端。
 */
function restoreWorkflowDraft(): {
  restored: false;
  baseUpdatedAt: 0;
} | {
  restored: true;
  baseUpdatedAt: number;
  name: string;
  description: string;
  family: string | null;
  workflowKnowledgeBundleIds: string[];
  definition: Omit<WorkflowDefinition, "createdAt" | "updatedAt">;
} {
  // 只读资产上恢复草稿会让 hasUnsavedChanges 变真，进而禁用校验/发布，而该资产又无处保存。
  if (isBuiltinReadonly.value) return { restored: false, baseUpdatedAt: 0 };
  const workflowId = currentWorkflowDraftId();
  if (!workflowId) return { restored: false, baseUpdatedAt: 0 };
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(workflowDraftStorageKey(workflowId));
  } catch (error) {
    console.warn("[workflow-editor] local draft read failed", { workflowId, error });
    return { restored: false, baseUpdatedAt: 0 };
  }
  if (!raw) return { restored: false, baseUpdatedAt: 0 };
  let draft: {
    baseUpdatedAt?: number;
    name?: string;
    description?: string;
    family?: string;
    workflowKnowledgeBundleIds?: string[];
    definition?: unknown;
  };
  try {
    draft = JSON.parse(raw) as typeof draft;
  } catch (error) {
    console.warn("[workflow-editor] local draft parse failed", { workflowId, error });
    clearWorkflowDraft();
    return { restored: false, baseUpdatedAt: 0 };
  }
  if (!isRestorableDraftDefinition(draft.definition)) {
    clearWorkflowDraft();
    return { restored: false, baseUpdatedAt: 0 };
  }
  return {
    restored: true,
    baseUpdatedAt: Number(draft.baseUpdatedAt ?? 0),
    name: draft.name ?? workflowName.value,
    description: draft.description ?? workflowDescription.value,
    family: draft.family ?? workflowFamily.value ?? null,
    workflowKnowledgeBundleIds: [...(draft.workflowKnowledgeBundleIds ?? [])],
    definition: draft.definition,
  };
}

/**
 * 恢复本地草稿并按情况提示：只读资产不恢复；与服务端内容一致时视为无改动直接清掉；
 * 草稿基于的服务端版本已变时提示风险，避免静默覆盖他人改动。
 * 必须在 setup 完成后调用——isBuiltinReadonly 等 computed 在 immediate watcher 首次执行时尚未初始化。
 */
function applyRestoredWorkflowDraft(): void {
  const draft = restoreWorkflowDraft();
  if (!draft.restored) return;
  // 旧版本可能已经写入了“未编辑”的本地快照；与当前服务端基线一致时直接清理，不能触发脏状态。
  if (!isSnapshotDifferentFromBaseline(draft.definition)) {
    clearWorkflowDraft();
    return;
  }
  applyWorkflowSnapshot({
    name: draft.name,
    description: draft.description,
    family: draft.family,
    workflowKnowledgeBundleIds: draft.workflowKnowledgeBundleIds,
    nodes: draft.definition.nodes,
    edges: draft.definition.edges,
  });
  if (!isDirty.value) {
    clearWorkflowDraft();
    return;
  }
  if (draft.baseUpdatedAt !== 0 && draft.baseUpdatedAt !== loadedServerUpdatedAt.value) {
    message.warning("本地草稿基于较早的服务端版本，保存前请确认不会覆盖他人的改动");
    return;
  }
  message.info("已恢复本地未保存的流程草稿");
}

// 监听草稿内容而非 isDirty：isDirty 是布尔，只在第一次变脏时跳变一次，之后所有编辑都不会再触发暂存。
watch(draftSnapshot, scheduleWorkflowDraftPersist);
const visibleRoles = computed(() => props.roleDefinitions ?? orch.roles);
const visibleKnowledgeBundles = computed(() => orch.knowledgeBundles);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
let edgeAnchorRefreshRafId: number | null = null;

const { fitView, setViewport, setEdges, getNodes } = useVueFlow("workflow-editor");
const isDarkTheme = computed(() => {
  if (ui.themeMode === "dark") return true;
  if (ui.themeMode === "light") return false;
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
});
const sharedWorkspaceId = computed(() => parseSharedWorkspaceSelectionId(String(props.workspaceId ?? "")));
const miniMapNodeColor = computed(() => (isDarkTheme.value ? "#415369" : "#d8e0ea"));
const miniMapNodeStrokeColor = computed(() => (isDarkTheme.value ? "#64748b" : "#b9c5d4"));
const miniMapMaskColor = computed(() => (isDarkTheme.value ? "rgba(15, 23, 37, 0.46)" : "rgba(240, 244, 248, 0.62)"));
const miniMapMaskStrokeColor = computed(() => (isDarkTheme.value ? "rgba(148, 163, 184, 0.74)" : "rgba(148, 163, 184, 0.5)"));
const miniMapWidth = 140;
const miniMapHeight = 105;

watch([() => props.workflowId, () => props.sourceDefinition], ([id, sourceDefinition]) => {
  const loadEpoch = ++workflowLoadEpoch;
  draftHydrationReady = false;
  cancelPendingDraftPersist();
  const workflow = sourceDefinition ?? orch.workflows.find((item) => item.id === id);
  if (!workflow) return;
  // 切换流程时先取消上一个流程的待写定时器，否则它会把内容写到新流程的键下。
  loadedServerUpdatedAt.value = Number(workflow.updatedAt ?? 0);
  applyWorkflowSnapshot({
    name: workflow.name,
    description: workflow.description,
    family: workflow.family,
    workflowKnowledgeBundleIds: workflow.workflowKnowledgeBundleIds,
    nodes: workflow.nodes,
    edges: workflow.edges,
  });
  markCleanFromCurrentDraft();
  // 本 watcher 是 immediate，首次会在 setup 中途同步执行，此时 isBuiltinReadonly 等 computed 还没初始化；
  // 草稿恢复要读只读态，延到下一个 tick 执行。
  void nextTick(() => {
    if (loadEpoch !== workflowLoadEpoch) return;
    applyRestoredWorkflowDraft();
    draftHydrationReady = true;
  });
  setTimeout(() => { void resetInitialWorkflowViewport(); }, 100);
}, { immediate: true });
watch(isDirty, (dirty) => emit("dirty-change", dirty), { immediate: true });

/** Fits small workflows and aligns oversized workflows to their leading edge at a readable zoom. */
async function resetInitialWorkflowViewport(): Promise<void> {
  await nextTick();
  const canvas = canvasShellRef.value?.querySelector<HTMLElement>(".wf-editor__canvas");
  if (!canvas || editorNodes.value.length === 0) return;

  const minX = Math.min(...editorNodes.value.map((node) => node.position.x));
  const maxX = Math.max(...editorNodes.value.map((node) => node.position.x + editorNodeBoxSize(node.data?.workflowNode.type).width));
  const minY = Math.min(...editorNodes.value.map((node) => node.position.y));
  const maxY = Math.max(...editorNodes.value.map((node) => node.position.y + editorNodeBoxSize(node.data?.workflowNode.type).height));
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const availableWidth = Math.max(1, canvas.clientWidth - WORKFLOW_EDITOR_INITIAL_PADDING * 2);
  const availableHeight = Math.max(1, canvas.clientHeight - WORKFLOW_EDITOR_INITIAL_PADDING * 2);
  const fitZoom = Math.min(availableWidth / graphWidth, availableHeight / graphHeight);

  if (fitZoom >= WORKFLOW_EDITOR_MIN_ZOOM) {
    // 首次进入直接定位，不做从默认视口缩放到适配视口的动画。
    await fitView({ padding: 0.12, duration: 0 });
    return;
  }

  const isVertical = graphHeight >= graphWidth;
  const crossAxisFitZoom = isVertical ? availableWidth / graphWidth : availableHeight / graphHeight;
  const zoom = Math.max(
    WORKFLOW_EDITOR_MIN_ZOOM,
    Math.min(WORKFLOW_EDITOR_INITIAL_READABLE_ZOOM, crossAxisFitZoom),
  );
  await setViewport({
    x: isVertical
      ? canvas.clientWidth / 2 - ((minX + maxX) / 2) * zoom
      : WORKFLOW_EDITOR_INITIAL_PADDING - minX * zoom,
    y: isVertical
      ? WORKFLOW_EDITOR_INITIAL_PADDING - minY * zoom
      : canvas.clientHeight / 2 - ((minY + maxY) / 2) * zoom,
    zoom,
  }, { duration: 0 });
}

const selectedNode = computed(() => editorNodes.value.find((node) => node.id === selectedNodeId.value) ?? null);
const savedWorkflow = computed(() => props.sourceDefinition ?? orch.workflows.find((item) => item.id === props.workflowId) ?? null);
/**
 * 只读红旗：预览态一律只读；服务端权威模式下的内置工作流随服务端分发且只读；
 * 其余沿用既有内置资产口径。
 */
const isBuiltinReadonly = computed(() => props.previewReadonly === true
  || orch.isServerAuthoritativeBuiltinAsset("workflow", String(props.workflowId ?? ""))
  || (savedWorkflow.value?.kind === "builtin" && !canMaintainBuiltinSpecAssets(permissionInput.value)));
const selectedWorkflowNode = computed(() => selectedNode.value?.data?.workflowNode ?? null);
const selectedEdge = computed(() => editorEdges.value.find((edge) => edge.id === selectedEdgeId.value) ?? null);
const selectedWorkflowEdge = computed(() => (selectedEdge.value?.data as { workflowEdge: WorkflowEdge } | undefined)?.workflowEdge ?? null);
const selectedKnowledgeIds = computed(() => new Set(selectedWorkflowNode.value?.knowledgeOverrideBundleIds ?? []));
const selectedOutputWritePolicy = computed(() => normalizeOutputWritePolicy(selectedWorkflowNode.value));
const selectedReworkTargetIds = computed(() => new Set(selectedWorkflowNode.value?.reworkPolicy?.allowedTargetNodeIds ?? []));
/** 输出模式的中文标签，与下方 option 文案保持一致，供折叠区摘要复用。 */
const OUTPUT_MODE_LABELS: Record<string, string> = {
  "": "跟随角色默认输出",
  text: "文本",
  structured: "结构化结果",
  file: "单文件",
  "file-set": "多文件 / 文件集合",
};
/** 折叠区摘要必须带出当前值，避免收起后看不到已配置内容。 */
const bindingOutputSummary = computed(() => {
  const node = selectedWorkflowNode.value;
  if (!node) return "";
  const mode = OUTPUT_MODE_LABELS[node.outputArtifactMode ?? ""] ?? "跟随角色默认输出";
  const resultKey = String(node.outputResultKey ?? "").trim();
  return resultKey ? `${mode} · ${resultKey}` : mode;
});
const bindingKnowledgeSummary = computed(() => {
  const node = selectedWorkflowNode.value;
  if (!node) return "";
  const parts = [`知识库 ${selectedKnowledgeIds.value.size} 项`];
  if (node.type === "role") parts.push(`输入绑定 ${(node.inputBindings ?? []).length} 条`);
  return parts.join(" · ");
});
const upstreamRoleNodeOptions = computed(() => {
  const currentNode = selectedWorkflowNode.value;
  if (!currentNode || currentNode.type !== "role") return [];
  const visited = new Set<string>();
  const queue = [currentNode.id];
  const options: Array<{ id: string; label: string }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const inEdges = editorEdges.value.filter((edge) => edge.target === current);
    for (const edge of inEdges) {
      queue.push(edge.source);
      const upstreamNode = editorNodes.value.find((node) => node.id === edge.source)?.data?.workflowNode ?? null;
      if (upstreamNode?.type === "role" && upstreamNode.id !== currentNode.id && !options.some((item) => item.id === upstreamNode.id)) {
        options.push({ id: upstreamNode.id, label: upstreamNode.label || upstreamNode.id });
      }
    }
  }
  return options;
});
const hasSelectedBinding = computed(() => Boolean(selectedWorkflowNode.value || selectedWorkflowEdge.value));
const bindingModalTitle = computed(() => {
  if (selectedWorkflowNode.value) return `编辑节点绑定 · ${selectedWorkflowNode.value.label || selectedWorkflowNode.value.id}`;
  if (selectedWorkflowEdge.value) return `编辑连线绑定 · ${selectedEdge.value?.source ?? ""} -> ${selectedEdge.value?.target ?? ""}`;
  return "编辑绑定";
});
const selectedBindingSummary = computed(() => {
  if (selectedWorkflowNode.value) return `已选节点：${selectedWorkflowNode.value.label || selectedWorkflowNode.value.id}`;
  if (selectedWorkflowEdge.value) return `已选连线：${selectedEdge.value?.source ?? ""} -> ${selectedEdge.value?.target ?? ""}`;
  return "双击节点或连线即可编辑对应的配置。";
});

watch([selectedNodeId, selectedEdgeId], ([nodeId, edgeId]) => {
  if (!nodeId && !edgeId) bindingEditorOpen.value = false;
});

watch(bindingEditorOpen, (open) => {
  if (!open) return;
  closeContextMenu();
  bindingOutputSectionOpen.value = false;
  bindingKnowledgeSectionOpen.value = false;
});

watch(selectedEdgeId, () => {
  editorEdges.value = applyEditorEdgePresentation(editorEdges.value);
});

watch(isDarkTheme, () => {
  editorNodes.value = editorNodes.value.map((node) => {
    const workflowNode = node.data?.workflowNode ?? null;
    if (!workflowNode) return node;
    return {
      ...node,
      style: nodeStyle(workflowNode.type),
    };
  });
});

function cloneValue<T>(value: T): T {
  return structuredClone(unwrapReactiveValue(value));
}

/** Vue Flow 会把响应式边对象回写到 v-model；递归解除代理后再进入业务定义，避免 structuredClone 失败。 */
function unwrapReactiveValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  const raw = toRaw(value);
  if (raw === null || typeof raw !== "object") return raw as T;
  if (raw instanceof Date) return new Date(raw.getTime()) as T;
  const existing = seen.get(raw);
  if (existing) return existing as T;
  if (Array.isArray(raw)) {
    const result: unknown[] = [];
    seen.set(raw, result);
    for (const item of raw) result.push(unwrapReactiveValue(item, seen));
    return result as T;
  }
  const result: Record<string, unknown> = {};
  seen.set(raw, result);
  for (const [key, item] of Object.entries(raw)) result[key] = unwrapReactiveValue(item, seen);
  return result as T;
}

/** Removes Vue Flow's runtime graph references before an edge re-enters editor state. */
function stripVueFlowEdgeInternals(edge: Edge): Edge {
  const raw = toRaw(edge) as Edge & { sourceNode?: unknown; targetNode?: unknown; events?: unknown };
  const { sourceNode: _sourceNode, targetNode: _targetNode, events: _events, ...definition } = raw;
  return {
    ...definition,
    data: isRecord(definition.data) ? cloneValue(definition.data) : definition.data,
  };
}

/** 仅保留当前节点合同字段，避免编辑器继续透传未定义属性。 */
function normalizeWorkflowNodeForEditor(node: WorkflowNode): WorkflowNode {
  return {
    id: node.id,
    type: node.type,
    roleId: node.roleId ?? null,
    conditionExpr: node.conditionExpr ?? null,
    conditionDecisionMode: node.conditionDecisionMode ?? null,
    label: node.label,
    position: node.position,
    inputReferences: node.inputReferences ?? null,
    inputBindings: node.inputBindings ?? null,
    outputWritePolicy: node.outputWritePolicy ?? null,
    outputArtifactMode: node.outputArtifactMode ?? null,
    outputResultKey: node.outputResultKey ?? null,
    knowledgeOverrideBundleIds: node.knowledgeOverrideBundleIds ?? null,
    startMode: node.startMode ?? null,
    manualStartPrompt: node.startMode === "manual" ? node.manualStartPrompt ?? null : null,
    approvalMode: node.approvalMode ?? null,
    failPolicy: node.failPolicy ?? null,
    workItemPolicy: normalizeNodeWorkItemPolicy(node.workItemPolicy),
    reworkPolicy: node.reworkPolicy ?? null,
  };
}

function toFlowNode(node: WorkflowNode, nodeLabels?: Map<string, string>): Node<FlowNodeData> {
  const workflowNode = normalizeWorkflowNodeForEditor(cloneValue(node));
  return {
    id: workflowNode.id,
    type: "editor",
    position: workflowNode.position,
    data: {
      label: workflowNode.label,
      workflowNode,
      card: buildEditorNodeCardViewModel(workflowNode, nodeLabels),
    },
    style: nodeStyle(workflowNode.type),
  };
}

function toFlowEdge(edge: WorkflowEdge): Edge {
  const edgePalette = resolveEditorEdgePalette(isDarkTheme.value);
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
      ...WORKFLOW_EDGE_MARKER,
      color: edgePalette.stroke,
    },
    animated: false,
    style: {
      stroke: edgePalette.stroke,
      strokeWidth: 1.9,
    },
    data: {
      workflowEdge: cloneValue(edge),
      ...(edge.routePoints?.length ? { routePoints: cloneValue(edge.routePoints) } : {}),
    },
    interactionWidth: 18,
  };
}

function refreshEditorEdgeAnchorLayouts(preserveStoredRoutePoints = false) {
  editorEdges.value = decorateEditorEdges(
    preserveStoredRoutePoints ? editorEdges.value : editorEdges.value.map(clearTransientRoutePoints),
  );
}

/** 节点拖动期间 Vue Flow 可能保留上一帧的内部边缓存，几何变化完成后再同步一次。 */
function syncEditorEdgeStore(): void {
  if (getNodes.value.length === 0) return;
  suppressDisplayEdgeModelUpdate = true;
  setEdges(displayEdges.value);
  // Vue Flow normally emits update:edges in the same scheduler turn. Keep a fallback
  // reset so a store that suppresses that emit cannot block a later user change.
  window.setTimeout(() => {
    suppressDisplayEdgeModelUpdate = false;
  }, 0);
}

function scheduleRefreshEditorEdgeAnchorLayouts(_event?: unknown) {
  if (typeof window === "undefined") {
    refreshEditorEdgeAnchorLayouts();
    return;
  }
  if (edgeAnchorRefreshRafId !== null) return;
  edgeAnchorRefreshRafId = window.requestAnimationFrame(() => {
    edgeAnchorRefreshRafId = null;
    refreshEditorEdgeAnchorLayouts();
    syncEditorEdgeStore();
  });
}

function cancelScheduledEdgeAnchorRefresh() {
  if (typeof window === "undefined") return;
  if (edgeAnchorRefreshRafId === null) return;
  window.cancelAnimationFrame(edgeAnchorRefreshRafId);
  edgeAnchorRefreshRafId = null;
}

/** 按节点类型解析编辑器内的 bbox 尺寸，供连线锚点与自动布局使用。 */
function editorNodeBoxSize(type: string | null | undefined): { width: number; height: number } {
  return workflowNodeBoxSize(type, WORKFLOW_EDITOR_NODE_BASE_SIZE);
}

function nodeStyle(type: WorkflowNodeType): Record<string, string> {
  const palette = editorNodePalette(type, isDarkTheme.value);
  const size = editorNodeBoxSize(type);
  return {
    width: `${size.width}px`,
    height: `${size.height}px`,
    padding: "0",
    borderRadius: workflowNodeRadius(type),
    border: `1px solid ${palette.border}`,
    background: palette.background,
    color: palette.text,
    boxShadow: "0 8px 20px rgba(15, 23, 42, 0.08)",
    overflow: "visible",
  };
}

function clearTransientRoutePoints(edge: Edge): Edge {
  const data = isRecord(edge.data) ? edge.data : {};
  const { routePoints: _ignoredRoutePoints, ...rest } = data;
  const workflowEdge = isRecord(rest.workflowEdge) ? rest.workflowEdge : null;
  if (!workflowEdge && !("routePoints" in data)) return edge;
  const nextWorkflowEdge = workflowEdge
    ? (() => {
      const { routePoints: _ignoredDefinitionRoutePoints, ...definition } = workflowEdge;
      return definition;
    })()
    : null;
  return {
    ...edge,
    data: {
      ...rest,
      ...(nextWorkflowEdge ? { workflowEdge: nextWorkflowEdge } : {}),
    },
  };
}

function applyEditorRoutePoints(routeByEdgeId: Map<string, WorkflowRoutePoint[]>) {
  editorEdges.value = decorateEditorEdges(
    editorEdges.value.map((edge) => {
      const routePoints = routeByEdgeId.get(edge.id);
      const data = isRecord(edge.data) ? edge.data : {};
      const workflowEdge = cloneValue((data as any).workflowEdge ?? {
        id: edge.id,
        sourceNodeId: edge.source,
        targetNodeId: edge.target,
        conditionBranch: null,
        dataMappings: [],
      });
      if (!routePoints?.length) {
        const { routePoints: _ignoredDefinitionRoutePoints, ...definition } = workflowEdge;
        const { routePoints: _ignoredRoutePoints, ...rest } = data;
        return {
          ...edge,
          data: { ...rest, workflowEdge: definition },
        };
      }
      const normalizedRoutePoints = routePoints.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));
      return {
        ...edge,
        data: {
          ...data,
          routePoints: normalizedRoutePoints,
          workflowEdge: {
            ...workflowEdge,
            routePoints: normalizedRoutePoints,
          },
        },
      };
    }),
  );
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function decorateEditorEdges(edges: Edge[]): Edge[] {
  return applyEditorEdgePresentation(
    withWorkflowEdgeRouting(
      edges,
      // Vue Flow 节点的 type 是渲染器类型，业务类型在 data.workflowNode 里。
      editorNodes.value.map((node) => ({
        id: node.id,
        position: node.position,
        type: node.data?.workflowNode.type ?? null,
      })),
      (node) => editorNodeBoxSize(node.type),
    ),
  );
}

function applyEditorEdgePresentation(edges: Edge[]): Edge[] {
  const edgePalette = resolveEditorEdgePalette(isDarkTheme.value);
  return edges.map((edge) => {
    const selected = edge.id === selectedEdgeId.value;
    return {
      ...edge,
      markerEnd: selected
        ? {
          ...WORKFLOW_EDGE_SELECTED_MARKER,
          color: edgePalette.strokeSelected,
        }
        : {
          ...WORKFLOW_EDGE_MARKER,
          color: edgePalette.stroke,
        },
      style: {
        stroke: selected ? edgePalette.strokeSelected : edgePalette.stroke,
        strokeWidth: selected ? 2.35 : 1.9,
      },
    };
  });
}

function resolveEditorEdgePalette(isDark: boolean): { stroke: string; strokeSelected: string } {
  if (isDark) {
    return {
      stroke: "#9fb3ca",
      strokeSelected: "#65a9ff",
    };
  }
  return {
    stroke: "#8699ad",
    strokeSelected: "#1677ff",
  };
}

function editorNodePalette(type: WorkflowNodeType, isDark: boolean): { background: string; border: string; text: string } {
  const tone = workflowNodeTypeTone(type);
  if (isDark) {
    if (tone === "success") {
      return {
        background: "linear-gradient(180deg, rgba(24, 45, 31, 0.94), rgba(16, 30, 22, 0.96))",
        border: "#3e6f4f",
        text: "#e7f8ec",
      };
    }
    if (tone === "danger") {
      return {
        background: "linear-gradient(180deg, rgba(74, 23, 26, 0.94), rgba(44, 15, 17, 0.96))",
        border: "#8f3b40",
        text: "#ffe4e6",
      };
    }
    if (tone === "warning") {
      return {
        background: "linear-gradient(180deg, rgba(61, 45, 21, 0.94), rgba(45, 33, 15, 0.96))",
        border: "#9a783d",
        text: "#fff4db",
      };
    }
    if (tone === "violet") {
      return {
        background: "linear-gradient(180deg, rgba(49, 33, 72, 0.94), rgba(34, 22, 52, 0.96))",
        border: "#6f4fa6",
        text: "#f1e9ff",
      };
    }
    return {
      background: "linear-gradient(180deg, rgba(31, 36, 45, 0.94), rgba(23, 28, 36, 0.96))",
      border: "#546072",
      text: "#edf1f7",
    };
  }
  if (tone === "success") {
    return {
      background: "linear-gradient(180deg, rgba(246,255,237,0.96), #ffffff)",
      border: "#b7eb8f",
      text: "#1f2937",
    };
  }
  if (tone === "danger") {
    return {
      background: "linear-gradient(180deg, rgba(255,242,240,0.96), #ffffff)",
      border: "#ffccc7",
      text: "#1f2937",
    };
  }
  if (tone === "warning") {
    return {
      background: "linear-gradient(180deg, rgba(255,251,230,0.96), #ffffff)",
      border: "#ffe58f",
      text: "#1f2937",
    };
  }
  if (tone === "violet") {
    return {
      background: "linear-gradient(180deg, rgba(249,240,255,0.96), #ffffff)",
      border: "#d3adf7",
      text: "#1f2937",
    };
  }
  return {
    background: "linear-gradient(180deg, rgba(230,244,255,0.95), #ffffff)",
    border: "#91caff",
    text: "#1f2937",
  };
}

function resolveRoleName(roleId: string | null | undefined): string | null {
  const id = String(roleId ?? "").trim();
  if (!id) return null;
  return visibleRoles.value.find((role) => role.id === id)?.name ?? null;
}

/** 当前画布的节点 id → 节点名索引，供画布内就地重建卡片时解析退回目标名。 */
const editorNodeLabelIndex = computed(() => buildWorkflowNodeLabelIndex(
  editorNodes.value.flatMap((node) => (node.data?.workflowNode ? [node.data.workflowNode] : [])),
));

function buildEditorNodeCardViewModel(
  node: WorkflowNode,
  nodeLabels: Map<string, string> = editorNodeLabelIndex.value,
): WorkflowNodeCardViewModel {
  return buildConfigNodeCardViewModel(node, {
    roleName: resolveRoleName(node.roleId),
    // 退回徽标要显示节点名而不是 id；索引由调用方给，避免依赖正在构建中的 editorNodes。
    resolveNodeLabel: (nodeId) => nodeLabels.get(nodeId) ?? null,
  });
}

/** 创建画布节点草稿，按节点类型填入最小默认配置。 */
function createNode(type: WorkflowNodeType): WorkflowNode {
  return {
    id: `${type}-${Date.now()}`,
    type,
    roleId: null,
    conditionExpr: null,
    conditionDecisionMode: null,
    label: type === "role" ? "新角色节点" : type === "condition" ? "条件判断" : type === "parallel-fork" ? "并行分叉" : type === "parallel-join" ? "并行汇合" : type === "start" ? "START" : "END",
    position: { x: 120, y: 96 },
    inputBindings: [],
    outputWritePolicy: null,
    outputArtifactMode: null,
    outputResultKey: null,
    knowledgeOverrideBundleIds: [],
    startMode: null,
    manualStartPrompt: null,
    approvalMode: null,
    failPolicy: type === "role" ? "wait-feedback" : null,
    workItemPolicy: null,
    reworkPolicy: null,
  };
}

function suggestNewNodePosition(): { x: number; y: number } {
  const index = editorNodes.value.length;
  const column = index % 3;
  const row = Math.floor(index / 3);
  return {
    x: 96 + column * WORKFLOW_NODE_GAP_X,
    y: 88 + row * WORKFLOW_NODE_GAP_Y,
  };
}

function selectNode(id: string | null) { selectedNodeId.value = id; selectedEdgeId.value = null; }
function selectEdge(id: string | null) {
  if (id && !editorEdges.value.some((edge) => edge.id === id)) return;
  selectedEdgeId.value = id;
  selectedNodeId.value = null;
}

function openBindingEditor() {
  if (!hasSelectedBinding.value) return;
  closeContextMenu();
  bindingEditorOpen.value = true;
}

function closeBindingEditor() {
  bindingEditorOpen.value = false;
}

/** 打开处理人模板维护；模板仅作为共享工作区运行预案，不写入流程节点。 */
function openAssigneeTemplateManager(): void {
  if (!sharedWorkspaceId.value) {
    message.info("非共享工作区按独立运行处理，无需维护处理人模板");
    return;
  }
  if (!savedWorkflow.value) {
    message.warning("请先保存流程，再维护处理人模板");
    return;
  }
  assigneeTemplateManagerOpen.value = true;
}

function handleNodeDoubleClick(event: { node: Node<FlowNodeData> }) {
  selectNode(event.node.id);
  openBindingEditor();
}

function handleEdgeDoubleClick(event: { edge: Edge }) {
  selectEdge(event.edge.id);
  openBindingEditor();
}

/** 更新选中节点草稿；内置只读模式仅保留详情查看。 */
function updateSelectedNode(mutator: (node: WorkflowNode) => void) {
  if (!selectedNode.value || isBuiltinReadonly.value) return;
  editorNodes.value = editorNodes.value.map((node) => {
    if (node.id !== selectedNode.value?.id) return node;
    const workflowNode = cloneValue(node.data?.workflowNode ?? createNode("role"));
    mutator(workflowNode);
    return {
      ...node,
      style: nodeStyle(workflowNode.type),
      data: {
        label: workflowNode.label,
        workflowNode,
        card: buildEditorNodeCardViewModel(workflowNode),
      },
    };
  });
}

/** 更新选中连线草稿；内置只读模式拒绝字段映射写入。 */
function updateSelectedEdge(mutator: (edge: WorkflowEdge) => void) {
  if (!selectedEdge.value || isBuiltinReadonly.value) return;
  editorEdges.value = editorEdges.value.map((edge) => {
    if (edge.id !== selectedEdge.value?.id) return edge;
    const workflowEdge = cloneValue((edge.data as any)?.workflowEdge ?? { id: edge.id, sourceNodeId: edge.source, targetNodeId: edge.target, conditionBranch: null, dataMappings: [] });
    mutator(workflowEdge);
    const data = isRecord(edge.data) ? edge.data : {};
    return {
      ...edge,
      label: workflowEdge.conditionBranch ?? "",
      data: {
        ...data,
        workflowEdge,
      },
    };
  });
}

/** 新增流程节点；内置流程只读时不改变图结构。 */
function addNodeOfType(type: WorkflowNodeType) {
  if (isBuiltinReadonly.value) return;
  const workflowNode = createNode(type);
  workflowNode.position = suggestNewNodePosition();
  editorNodes.value = [...editorNodes.value, toFlowNode(workflowNode)];
  selectNode(workflowNode.id);
}

/** 复制流程节点；仅可维护资产允许产生新节点。 */
function duplicateSelectedNode() {
  if (!selectedWorkflowNode.value || isBuiltinReadonly.value) return;
  const source = cloneValue(selectedWorkflowNode.value);
  const duplicated: WorkflowNode = {
    ...source,
    id: `${source.type}-${Date.now()}`,
    label: source.label?.trim() ? `${source.label}（副本）` : "节点副本",
    position: {
      x: Math.round((source.position?.x ?? 120) + 48),
      y: Math.round((source.position?.y ?? 120) + 48),
    },
  };
  editorNodes.value = [...editorNodes.value, toFlowNode(duplicated)];
  selectNode(duplicated.id);
  closeContextMenu();
  message.success("已复制节点");
}

/** 从选中节点追加下游节点和连线；内置流程只允许查看。 */
function addDownstreamNodeFromSelection() {
  if (!selectedWorkflowNode.value || isBuiltinReadonly.value) return;
  const sourceNode = selectedWorkflowNode.value;
  const workflowNode = createNode("role");
  workflowNode.label = "新下游节点";
  workflowNode.position = {
    x: Math.round((sourceNode.position?.x ?? 120) + 240),
    y: Math.round(sourceNode.position?.y ?? 120),
  };
  const workflowEdge: WorkflowEdge = {
    id: `edge-${Date.now()}`,
    sourceNodeId: sourceNode.id,
    targetNodeId: workflowNode.id,
    conditionBranch: null,
    dataMappings: [],
  };
  editorNodes.value = [...editorNodes.value, toFlowNode(workflowNode)];
  editorEdges.value = [...editorEdges.value, toFlowEdge(workflowEdge)];
  refreshEditorEdgeAnchorLayouts();
  selectNode(workflowNode.id);
  closeContextMenu();
  bindingEditorOpen.value = true;
  message.success("已添加下游节点");
}

function toggleReworkTarget(nodeId: string, checked: boolean) {
  updateSelectedNode((node) => {
    const next = new Set(node.reworkPolicy?.allowedTargetNodeIds ?? []);
    if (checked) next.add(nodeId);
    else next.delete(nodeId);
    node.reworkPolicy = next.size
      ? { allowedTargetNodeIds: Array.from(next) }
      : null;
  });
}

/** 删除选中节点及关联连线；内置流程拒绝删除。 */
function removeSelectedNode() {
  if (!selectedNode.value || isBuiltinReadonly.value) return;
  const nodeId = selectedNode.value.id;
  editorNodes.value = editorNodes.value.filter((node) => node.id !== nodeId);
  editorEdges.value = editorEdges.value.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
  refreshEditorEdgeAnchorLayouts();
  selectedNodeId.value = null;
  bindingEditorOpen.value = false;
  closeContextMenu();
}

/** 删除选中连线；内置流程拒绝删除。 */
function removeSelectedEdge() {
  if (!selectedEdge.value || isBuiltinReadonly.value) return;
  editorEdges.value = editorEdges.value.filter((edge) => edge.id !== selectedEdge.value?.id);
  refreshEditorEdgeAnchorLayouts();
  selectedEdgeId.value = null;
  bindingEditorOpen.value = false;
  closeContextMenu();
}

function removeSelectedBinding() {
  if (selectedWorkflowNode.value) {
    removeSelectedNode();
    return;
  }
  if (selectedWorkflowEdge.value) removeSelectedEdge();
}

function isValidConnection(params: Connection): boolean {
  const sourceId = String(params.source ?? "").trim();
  const targetId = String(params.target ?? "").trim();
  if (!sourceId || !targetId || sourceId === targetId) return false;

  const sourceNode = editorNodes.value.find((node) => node.id === sourceId)?.data?.workflowNode ?? null;
  const targetNode = editorNodes.value.find((node) => node.id === targetId)?.data?.workflowNode ?? null;
  if (!sourceNode || !targetNode) return false;
  if (sourceNode.type === "end") return false;
  if (targetNode.type === "start") return false;
  return true;
}

/** 创建流程连线；内置流程不允许通过画布写入新边。 */
function onConnect(params: Connection) {
  if (isBuiltinReadonly.value) return;
  const sourceId = String(params.source ?? "").trim();
  const targetId = String(params.target ?? "").trim();
  if (!sourceId || !targetId) {
    message.warning("请将连线拖到目标节点的连接区域后松开鼠标");
    return;
  }
  if (!isValidConnection(params)) {
    message.warning("该连线不合法，请检查起止节点");
    return;
  }
  const existing = editorEdges.value.find((edge) => edge.source === sourceId && edge.target === targetId);
  if (existing) {
    selectEdge(existing.id);
    return;
  }
  const workflowEdge: WorkflowEdge = { id: `edge-${Date.now()}`, sourceNodeId: sourceId, targetNodeId: targetId, conditionBranch: null, dataMappings: [] };
  editorEdges.value = [...editorEdges.value, toFlowEdge(workflowEdge)];
  refreshEditorEdgeAnchorLayouts();
  selectEdge(workflowEdge.id);
}

/** 重连已有连线后同步业务端点，并清理所有受端点槽位变化影响的旧路由。 */
function onEdgeUpdate(event: EdgeUpdateEvent): void {
  if (isBuiltinReadonly.value) return;
  const connection = event.connection;
  if (!isValidConnection(connection)) {
    message.warning("该连线端点不合法，请检查起止节点");
    return;
  }
  if (editorEdges.value.some((edge) => (
    edge.id !== event.edge.id
    && edge.source === connection.source
    && edge.target === connection.target
  ))) {
    message.warning("相同起止节点的连线已存在");
    return;
  }
  editorEdges.value = editorEdges.value.map((edge) => {
    if (edge.id !== event.edge.id) return edge;
    const data = isRecord(edge.data) ? edge.data : {};
    const workflowEdge = cloneValue((data as any).workflowEdge ?? {
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      conditionBranch: null,
      dataMappings: [],
    });
    const { routePoints: _ignoredDefinitionRoutePoints, ...definition } = workflowEdge;
    const { routePoints: _ignoredRoutePoints, ...rest } = data;
    return {
      ...edge,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? null,
      targetHandle: connection.targetHandle ?? null,
      data: {
        ...rest,
        workflowEdge: {
          ...definition,
          sourceNodeId: connection.source,
          targetNodeId: connection.target,
        },
      },
    };
  });
  // 端点分组发生变化，其他边的锚点槽位也可能变化，因此统一清除旧路由并重算展示路径。
  refreshEditorEdgeAnchorLayouts();
  syncEditorEdgeStore();
}

function eventValue(event: Event): string {
  return String((event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? "");
}

function eventChecked(event: Event): boolean {
  return Boolean((event.target as HTMLInputElement | null)?.checked);
}

function toggleKnowledge(bundleId: string, checked: boolean) {
  updateSelectedNode((node) => {
    const next = new Set(node.knowledgeOverrideBundleIds ?? []);
    if (checked) next.add(bundleId);
    else next.delete(bundleId);
    node.knowledgeOverrideBundleIds = Array.from(next);
  });
}

function addInputBinding() {
  updateSelectedNode((node) => {
    node.inputBindings = [...(node.inputBindings ?? []), { sourceNodeId: null, sourceArtifactKind: null, targetField: null, required: false }];
  });
}

function updateInputBinding(index: number, key: keyof ArtifactBinding, value: string | boolean) {
  updateSelectedNode((node) => {
    const next = [...(node.inputBindings ?? [])];
    const current = { ...(next[index] ?? {}) };
    (current as any)[key] = typeof value === "string" ? (value || null) : value;
    next[index] = current;
    node.inputBindings = next;
  });
}

function removeInputBinding(index: number) {
  updateSelectedNode((node) => {
    const next = [...(node.inputBindings ?? [])];
    next.splice(index, 1);
    node.inputBindings = next;
  });
}

function addDataMapping() {
  updateSelectedEdge((edge) => {
    edge.dataMappings = [...(edge.dataMappings ?? []), { sourceField: "", targetField: "" }];
  });
}

function updateDataMapping(index: number, key: keyof DataMapping, value: string) {
  updateSelectedEdge((edge) => {
    const next = [...(edge.dataMappings ?? [])];
    const current = { ...(next[index] ?? { sourceField: "", targetField: "" }) };
    current[key] = value;
    next[index] = current;
    edge.dataMappings = next;
  });
}

function removeDataMapping(index: number) {
  updateSelectedEdge((edge) => {
    const next = [...(edge.dataMappings ?? [])];
    next.splice(index, 1);
    edge.dataMappings = next;
  });
}

function onNodeLabelInput(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.label = value; });
}

/** 切换节点类型时清理不适用于新类型的配置字段。 */
function onNodeTypeChange(event: Event) {
  const value = eventValue(event) as WorkflowNodeType;
  updateSelectedNode((node) => {
    node.type = value;
    if (node.type !== "role") {
      node.roleId = null;
      node.outputWritePolicy = null;
      node.outputArtifactMode = null;
      node.startMode = null;
      node.manualStartPrompt = null;
      node.approvalMode = null;
      node.failPolicy = null;
      node.workItemPolicy = null;
    }
    if (node.type !== "condition") {
      node.conditionExpr = null;
      node.conditionDecisionMode = null;
    }
  });
}

function onNodeRoleChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    node.roleId = value ? value as any : null;
    if (!node.failPolicy) node.failPolicy = "wait-feedback";
  });
}

function onConditionExprInput(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.conditionExpr = value || null; });
}

/** 更新条件节点分支决策方式；auto 以 null 保存，兼容历史流程默认值。 */
function onConditionDecisionModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.conditionDecisionMode = value === "manual" ? "manual" : null; });
}

function onFailPolicyChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.failPolicy = value ? value as any : null; });
}

function onPrimaryOutputKindInput(event: Event) {
  const value = eventValue(event).trim();
  updateSelectedNode((node) => { node.outputResultKey = value || null; });
}

function onOutputModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.outputArtifactMode = value ? value as any : null; });
}

function onPersistenceModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    if (!value) {
      node.outputWritePolicy = null;
      return;
    }
    node.outputWritePolicy = {
      ...normalizeOutputWritePolicy(node),
      persistenceMode: value as OutputWritePolicy["persistenceMode"],
    };
  });
}

function onBaseDirInput(event: Event) {
  const value = eventValue(event).trim();
  updateSelectedNode((node) => {
    node.outputWritePolicy = {
      ...normalizeOutputWritePolicy(node),
      baseDir: value || null,
    };
  });
}

function onOverwritePolicyChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    node.outputWritePolicy = {
      ...normalizeOutputWritePolicy(node),
      overwritePolicy: (value || "create-versioned-copy") as OutputWritePolicy["overwritePolicy"],
    };
  });
}

function resetOutputWritePolicy() {
  updateSelectedNode((node) => {
    node.outputWritePolicy = null;
  });
}

function onApprovalModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => { node.approvalMode = value ? value as any : null; });
}

/** 更新节点启动方式；自动启动按默认值保存，人工启动才写入节点配置。 */
function onStartModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    node.startMode = value === "manual" ? "manual" : null;
    if (node.startMode !== "manual") node.manualStartPrompt = null;
  });
}

/** 切换节点工作项模式；顺序约束由运行时工具和数据库状态机共同保证。 */
function onWorkItemModeChange(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    node.workItemPolicy = value === "sequential" ? { mode: "sequential" } : null;
  });
}

/** 更新人工启动节点的运行态提示说明；保存链路负责归一化空白内容。 */
function onManualStartPromptInput(event: Event) {
  const value = eventValue(event);
  updateSelectedNode((node) => {
    node.manualStartPrompt = node.startMode === "manual" ? value || null : null;
  });
}

function onEdgeBranchInput(event: Event) {
  const value = eventValue(event);
  updateSelectedEdge((edge) => { edge.conditionBranch = value || null; });
}

/** 汇总编辑器当前草稿，供保存和未保存检测共用。 */
function buildWorkflowPayload(): Omit<WorkflowDefinition, "createdAt" | "updatedAt"> {
  const nodes: WorkflowNode[] = editorNodes.value.map((node) => {
    const workflowNode = normalizeWorkflowNodeForEditor(cloneValue(node.data?.workflowNode ?? createNode("role")));
    return { ...workflowNode, label: workflowNode.label || node.id, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } };
  });
  const edges: WorkflowEdge[] = editorEdges.value.map((edge) => {
    const workflowEdge = cloneValue((edge.data as any)?.workflowEdge ?? { id: edge.id, sourceNodeId: edge.source, targetNodeId: edge.target, conditionBranch: null, dataMappings: [] });
    const routePoints = Array.isArray(workflowEdge.routePoints)
      ? workflowEdge.routePoints
        .map((point: any) => ({ x: Number(point?.x), y: Number(point?.y) }))
        .filter((point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];
    const { routePoints: _ignoredRoutePoints, ...definitionEdge } = workflowEdge;
    return {
      ...definitionEdge,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      conditionBranch: workflowEdge.conditionBranch || null,
      dataMappings: (workflowEdge.dataMappings ?? []).filter((item: DataMapping) => item.sourceField || item.targetField),
      ...(routePoints.length >= 2 ? { routePoints } : {}),
    };
  });
  return {
    id: props.workflowId,
    workspaceId: props.workspaceId,
    family: normalizeWorkflowFamily(workflowFamily.value) ?? DEFAULT_WORKFLOW_FAMILY,
    name: workflowName.value,
    description: workflowDescription.value,
    workflowKnowledgeBundleIds: [...workflowKnowledgeBundleIds.value],
    nodes,
    edges,
    kind: props.sourceDefinition?.kind ?? orch.selectedWorkflow?.kind ?? "custom",
    version: (props.sourceDefinition?.version ?? orch.selectedWorkflow?.version ?? 0) + 1,
  };
}

/** 保存流程定义；普通用户在内置详情中只能读取配置。 */
async function saveWorkflow(): Promise<boolean> {
  if (isBuiltinReadonly.value) {
    message.info("内置流程仅超管可修改");
    return false;
  }
  // 只对服务端会拒绝的硬约束阻断：服务端只回字段路径式的脱敏错误，用户无法据它定位到具体节点。
  // START/END 数量等本地规则不在此列——它们不阻断落库，只作编辑器内提示。
  if (blockingDagErrors.value.length) {
    message.error(`流程校验未通过：${blockingDagErrors.value.join("；")}`);
    return false;
  }
  try {
    const payload = buildWorkflowPayload();
    await orch.saveWorkflow(ctx.value, props.workspaceId, payload);
    markCleanFromCurrentDraft();
    clearWorkflowDraft();
    message.success("流程已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
    return false;
  }
}

/** 父级资产切换守卫调用的保存入口，失败时返回 false 阻止切换。 */
async function saveCurrentDraft(): Promise<boolean> {
  return saveWorkflow();
}

/** 放弃当前未保存流程草稿，并恢复为 store 中最近保存态。 */
function discardUnsavedChanges(): void {
  const workflow = savedWorkflow.value;
  if (!workflow) return;
  cancelPendingDraftPersist();
  applyWorkflowSnapshot({
    name: workflow.name,
    description: workflow.description,
    family: workflow.family,
    workflowKnowledgeBundleIds: workflow.workflowKnowledgeBundleIds,
    nodes: workflow.nodes,
    edges: workflow.edges,
  });
  workflowSettingsOpen.value = false;
  markCleanFromCurrentDraft();
  // 放弃的语义要覆盖本地暂存，否则刷新后草稿又会被恢复回来。
  clearWorkflowDraft();
}

defineExpose({
  hasUnsavedChanges,
  saveCurrentDraft,
  discardUnsavedChanges,
});

/**
 * 弹窗内保存只记住当前编辑态（本地草稿），不做全局校验、不落服务端。
 * 服务端按完整 definition 校验，会被其他没配好的节点挡住，而此刻用户只想保存这一个节点的绑定。
 * 落服务端仍走画布的「保存草稿」，全局校验保留在那里。
 */
function saveBindingEditsAndClose(): void {
  persistWorkflowDraft();
  // 提示必须点明只到了本地：若只说「已保存」，用户会以为已落库，切资产时误选「放弃」而丢掉唯一副本。
  message.success("已保存到本地草稿");
  closeBindingEditor();
}

/** 打开流程设置时读取本工作区的模型配置；失败显式提示，不静默回落。 */
async function loadExecutionDefault(): Promise<void> {
  executionDefaultLoading.value = true;
  try {
    const saved = await orch.loadWorkflowExecutionDefault(ctx.value, props.workspaceId, props.workflowId);
    suppressExecutionDefaultEngineWatch = true;
    savedExecutionDefault.value = saved;
    executionDefaultEngine.value = saved?.engine ?? null;
    executionDefaultModel.value = saved?.model ?? "";
    await nextTick();
  } catch (error) {
    message.error(error instanceof Error ? error.message : "流程模型配置读取失败");
  } finally {
    suppressExecutionDefaultEngineWatch = false;
    executionDefaultLoading.value = false;
  }
}

/** 保存流程模型配置：只写工作区级偏好，不改流程定义本体；返回是否已落库。 */
async function saveExecutionDefault(): Promise<boolean> {
  const engine = executionDefaultEngine.value;
  const model = executionDefaultModel.value.trim();
  if (!engine || !model) {
    message.warning("请先选择执行引擎与模型");
    return false;
  }
  executionDefaultSaving.value = true;
  try {
    savedExecutionDefault.value = await orch.saveWorkflowExecutionDefault(
      ctx.value,
      props.workspaceId,
      props.workflowId,
      { engine, model },
    );
    message.success("流程模型配置已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "流程模型配置保存失败");
    return false;
  } finally {
    executionDefaultSaving.value = false;
  }
}

/** 清除流程模型配置，恢复为各角色自身执行配置；返回是否已落库。 */
async function clearExecutionDefault(): Promise<boolean> {
  executionDefaultSaving.value = true;
  try {
    await orch.clearWorkflowExecutionDefault(ctx.value, props.workspaceId, props.workflowId);
    savedExecutionDefault.value = null;
    executionDefaultEngine.value = null;
    executionDefaultModel.value = "";
    message.success("已恢复为角色自身执行配置");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "流程模型配置清除失败");
    return false;
  } finally {
    executionDefaultSaving.value = false;
  }
}

/** 表单里的模型配置是否与已保存值不同；无改动时底部保存不重复提交。 */
function isExecutionDefaultDirty(): boolean {
  const engine = executionDefaultEngine.value;
  const model = executionDefaultModel.value.trim();
  const saved = savedExecutionDefault.value;
  if (!saved) return Boolean(engine || model);
  return saved.engine !== engine || String(saved.model ?? "") !== model;
}

/**
 * 底部「保存」时同步提交模型配置，与流程定义各自独立、分别报错：
 * 引擎置空表示恢复默认（清除配置）；引擎已选但模型未选视为未填完，只提示、不阻断流程模板保存。
 * 返回模型配置是否已落库，供调用方决定是否关闭弹窗。
 */
async function submitExecutionDefault(): Promise<boolean> {
  if (!isExecutionDefaultDirty()) return true;
  if (!executionDefaultEngine.value) return clearExecutionDefault();
  if (!executionDefaultModel.value.trim()) {
    message.warning("模型配置未选择模型，本次只保存流程");
    return true;
  }
  return saveExecutionDefault();
}

watch(workflowSettingsOpen, (open) => {
  if (open) void loadExecutionDefault();
});
watch(executionDefaultEngine, () => {
  if (suppressExecutionDefaultEngineWatch) return;
  // 用户手动切换引擎后旧模型必然不属于新引擎，清空并要求重新选择，避免提交跨引擎组合。
  executionDefaultModel.value = "";
});

/**
 * 底部保存：模型配置与流程定义各自独立提交、分别报错。
 * 模型配置先提交，流程定义因 DAG 校验被拒时不会连带模型配置一起存不下；
 * 两者都成功才关闭弹窗，否则留在弹窗让用户看到错误。
 */
async function saveWorkflowAndCloseSettings() {
  const modelSaved = await submitExecutionDefault();
  const saved = await saveWorkflow();
  if (saved && modelSaved) workflowSettingsOpen.value = false;
}

type WorkflowDagIssue = {
  message: string;
  /** 服务端也会拒绝的硬约束：不修就无法落库，保存前必须阻断。 */
  blocking: boolean;
};

const dagIssues = computed<WorkflowDagIssue[]>(() => {
  const issues: WorkflowDagIssue[] = [];
  const startNodes = editorNodes.value.filter((node) => node.data?.workflowNode.type === "start");
  const endNodes = editorNodes.value.filter((node) => node.data?.workflowNode.type === "end");
  // START/END 数量只是本编辑器的提示，服务端不校验（只检查 nodes/edges 是数组），因此不阻断落库。
  if (startNodes.length !== 1) issues.push({ message: "需要恰好 1 个 START 节点", blocking: false });
  if (endNodes.length !== 1) issues.push({ message: "需要恰好 1 个 END 节点", blocking: false });
  for (const node of editorNodes.value) {
    const workflowNode = node.data?.workflowNode;
    // role 节点缺 roleId 是服务端 orchAssetValidation 的硬校验，必须阻断。
    // 带上节点 id：默认新建的节点同名，只报 label 无法区分是哪一个。
    if (workflowNode?.type === "role" && !workflowNode.roleId) {
      issues.push({ message: `角色节点 ${workflowNode.label}(${workflowNode.id}) 未绑定 role`, blocking: true });
      break;
    }
  }
  return issues;
});

/** 编辑器内的全部提示，含服务端不校验的本地规则。 */
const dagErrors = computed(() => dagIssues.value.map((issue) => issue.message));
/** 落库前必须满足的硬约束，只含服务端会拒绝的项。 */
const blockingDagErrors = computed(() => dagIssues.value.filter((issue) => issue.blocking).map((issue) => issue.message));

function normalizeOutputWritePolicy(node: WorkflowNode | null): OutputWritePolicy {
  return {
    persistenceMode: node?.outputWritePolicy?.persistenceMode ?? defaultPersistenceMode(node?.outputArtifactMode ?? null),
    baseDir: node?.outputWritePolicy?.baseDir ?? null,
    overwritePolicy: node?.outputWritePolicy?.overwritePolicy ?? "create-versioned-copy",
  };
}

function defaultPersistenceMode(outputMode: ArtifactOutputMode | null | undefined): OutputWritePolicy["persistenceMode"] {
  return outputMode === "file" || outputMode === "file-set" ? "dual-write" : "db-only";
}

function normalizeContextMenuPosition(
  clientX: number,
  clientY: number,
  dimensions: { width: number; height: number },
): { x: number; y: number } {
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1280;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 720;
  const margin = 12;
  return {
    x: Math.max(margin, Math.min(clientX, viewportWidth - dimensions.width - margin)),
    y: Math.max(margin, Math.min(clientY, viewportHeight - dimensions.height - margin)),
  };
}

function closeContextMenu() {
  contextMenu.value = null;
}

function openContextMenu(input: {
  kind: "node" | "edge";
  id: string;
  x: number;
  y: number;
  title: string;
}) {
  const position = normalizeContextMenuPosition(input.x, input.y, {
    width: input.kind === "node" ? 260 : 220,
    height: input.kind === "node" ? 220 : 120,
  });
  contextMenu.value = { visible: true, ...input, x: position.x, y: position.y };
}

function onCanvasContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const nodeEl = target.closest(".vue-flow__node[data-id]") as HTMLElement | null;
  if (nodeEl) {
    event.preventDefault();
    const nodeId = String(nodeEl.dataset.id ?? "").trim();
    if (!nodeId) return;
    selectNode(nodeId);
    const workflowNode = editorNodes.value.find((node) => node.id === nodeId)?.data?.workflowNode ?? null;
    openContextMenu({
      kind: "node",
      id: nodeId,
      x: event.clientX,
      y: event.clientY,
      title: workflowNode?.label || nodeId,
    });
    return;
  }

  const edgeEl = target.closest(".vue-flow__edge[data-id]") as HTMLElement | null;
  if (edgeEl) {
    event.preventDefault();
    const edgeId = String(edgeEl.dataset.id ?? "").trim();
    if (!edgeId) return;
    const workflowEdge = editorEdges.value.find((edge) => edge.id === edgeId) ?? null;
    if (!workflowEdge) return;
    selectEdge(edgeId);
    openContextMenu({
      kind: "edge",
      id: edgeId,
      x: event.clientX,
      y: event.clientY,
      title: `${workflowEdge?.source ?? edgeId} -> ${workflowEdge?.target ?? ""}`.trim(),
    });
    return;
  }

  closeContextMenu();
}

function handleContextAction(action: "edit" | "delete") {
  if (!contextMenu.value) return;
  if (action === "edit") {
    openBindingEditor();
    return;
  }
  removeSelectedBinding();
}

function handleGlobalPointerDown(event: Event) {
  if (!contextMenu.value?.visible) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(".wf-editor__context-menu")) return;
  closeContextMenu();
}

/** 判断键盘焦点是否落在可编辑元素上，避免在输入框内按删除键误删画布节点。 */
function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  const tagName = element.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || element.isContentEditable;
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeContextMenu();
    return;
  }
  // 方向键微调选中节点；焦点在输入控件、弹窗打开或内置只读时不响应。
  const nudgeDirection = NODE_NUDGE_DIRECTIONS[event.key];
  if (nudgeDirection) {
    if (bindingEditorOpen.value || isEditableKeyboardTarget(event.target)) return;
    if (!selectedNodeId.value || isBuiltinReadonly.value) return;
    event.preventDefault();
    nudgeSelectedNode(nudgeDirection, event.shiftKey);
    return;
  }
  // Delete/Backspace 删除选中节点或连线；绑定编辑弹窗打开或焦点在输入控件时不响应。
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (bindingEditorOpen.value || isEditableKeyboardTarget(event.target)) return;
  if (!hasSelectedBinding.value || isBuiltinReadonly.value) return;
  event.preventDefault();
  removeSelectedBinding();
}

onMounted(() => {
  window.addEventListener("pointerdown", handleGlobalPointerDown, true);
  window.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("resize", closeContextMenu);
});

onBeforeUnmount(() => {
  // debounce 未到期就卸载时补一次写入，否则这段编辑不会被暂存。
  const hadPendingDraft = localDraftTimer !== null;
  cancelPendingDraftPersist();
  if (hadPendingDraft && isDirty.value) persistWorkflowDraft();
  if (draftHydrationReady && !isDirty.value) clearWorkflowDraft();
  cancelScheduledEdgeAnchorRefresh();
  window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
  window.removeEventListener("keydown", handleGlobalKeydown);
  window.removeEventListener("resize", closeContextMenu);
});

/**
 * 用方向键微调选中节点位置；只改坐标，不碰其它定义字段。
 * 与拖动保持一致：同步写回 workflowNode.position，并让连线按新位置重算锚点与绕行。
 */
function nudgeSelectedNode(direction: { x: number; y: number }, fast: boolean): void {
  const nodeId = selectedNodeId.value;
  if (!nodeId) return;
  const step = fast ? NODE_NUDGE_STEP_FAST : NODE_NUDGE_STEP;
  editorNodes.value = editorNodes.value.map((node) => {
    if (node.id !== nodeId) return node;
    const position = {
      x: Math.round(node.position.x + direction.x * step),
      y: Math.round(node.position.y + direction.y * step),
    };
    const workflowNode = cloneValue(node.data?.workflowNode ?? createNode("role"));
    workflowNode.position = position;
    return {
      ...node,
      position,
      data: {
        ...node.data,
        label: workflowNode.label,
        workflowNode,
        card: buildEditorNodeCardViewModel(workflowNode),
      },
    };
  });
  // 连续按键合并到一帧，避免每按一次都重算全图锚点。
  scheduleRefreshEditorEdgeAnchorLayouts();
}

/** 应用自动布局；布局结果属于定义变更，内置只读时跳过。 */
async function applyAutoLayout(direction: WorkflowAutoLayoutDirection) {
  if (!editorNodes.value.length || isBuiltinReadonly.value) return;
  try {
    const layoutResult = await computeWorkflowAutoLayout(
      editorNodes.value.map((node) => ({ id: node.id, type: node.data?.workflowNode.type ?? null })),
      editorEdges.value,
      {
        direction,
        nodeWidth: WORKFLOW_EDITOR_NODE_BASE_SIZE.width,
        nodeHeight: WORKFLOW_EDITOR_NODE_BASE_SIZE.height,
        resolveNodeSize: (node) => editorNodeBoxSize(node.type),
      },
    );

    editorNodes.value = editorNodes.value.map((node) => {
      const nextPosition = layoutResult.nodePositions.get(node.id) ?? node.position;
      const workflowNode = cloneValue(node.data?.workflowNode ?? createNode("role"));
      workflowNode.position = nextPosition;
      return {
        ...node,
        position: nextPosition,
        data: {
          ...node.data,
          label: workflowNode.label,
          workflowNode,
          card: buildEditorNodeCardViewModel(workflowNode),
        },
      };
    });
    applyEditorRoutePoints(layoutResult.edgeRoutes);

    await nextTick();
    fitView({ padding: 0.16, duration: 240 });
    message.success(direction === "horizontal" ? "已按水平优先自动布局" : "已按垂直优先自动布局");
  } catch (error) {
    message.error(error instanceof Error ? `自动布局失败：${error.message}` : "自动布局失败");
  }
}
</script>

<template>
  <div class="wf-editor">
    <div class="wf-editor__toolbar">
      <input
        v-model="workflowName"
        name="codeflow-workflow-name"
        autocomplete="new-password"
        class="wf-editor__name-input"
        :disabled="isBuiltinReadonly"
        placeholder="流程模板名称"
      />
      <!-- 描述改为只读预览：完整文本在「流程设置」里编辑，这里只用来看当前流程写了什么。 -->
      <span class="wf-editor__desc-text" :title="workflowDescription">{{ workflowDescription || "未填写描述" }}</span>
      <button v-if="sharedWorkspaceId" class="wf-editor__ghost-btn" type="button" :disabled="isBuiltinReadonly" @click="openAssigneeTemplateManager">
        处理人模板
      </button>
      <div v-if="dagErrors.length" class="wf-editor__errors">
        <span v-for="err in dagErrors" :key="err" class="wf-editor__error-tag">{{ err }}</span>
      </div>
      <span v-if="isBuiltinReadonly" class="wf-editor__readonly-badge">内置只读</span>
      <button class="wf-editor__ghost-btn" type="button" @click="workflowSettingsOpen = true">
        流程设置
      </button>
    </div>

    <div class="wf-editor__body">
      <div class="wf-editor__palette">
        <h4>节点面板</h4>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('role')"><span class="wf-editor__palette-dot" style="background:#1677ff" />角色</button>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('condition')"><span class="wf-editor__palette-dot" style="background:#faad14" />条件</button>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('parallel-fork')"><span class="wf-editor__palette-dot" style="background:#722ed1" />分叉</button>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('parallel-join')"><span class="wf-editor__palette-dot" style="background:#722ed1" />汇合</button>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('start')"><span class="wf-editor__palette-dot" style="background:#52c41a" />Start</button>
        <button class="wf-editor__palette-btn" :disabled="isBuiltinReadonly" @click="addNodeOfType('end')"><span class="wf-editor__palette-dot" style="background:#ff4d4f" />End</button>
      </div>

      <div ref="canvasShellRef" class="wf-editor__canvas-shell" @contextmenu="onCanvasContextMenu">
        <div class="wf-editor__canvas-toolbar">
          <div class="wf-editor__selection-summary" :class="{ 'wf-editor__selection-summary--idle': !hasSelectedBinding }">
            {{ selectedBindingSummary }}
          </div>
          <div class="wf-editor__canvas-actions">
            <button
              v-if="hasReworkEdges"
              class="wf-editor__ghost-btn"
              :class="{ 'wf-editor__ghost-btn--active': showReworkEdges }"
              type="button"
              :aria-pressed="showReworkEdges"
              :disabled="!!reworkEdgePreferenceError"
              title="退回线只解释节点允许退回到哪些节点，不参与流程执行；该偏好只记在本机，按流程分别保存"
              @click="setReworkEdgeVisibility(!showReworkEdges)"
            >
              {{ showReworkEdges ? "隐藏退回线" : "显示退回线" }}
            </button>
            <button class="wf-editor__ghost-btn" type="button" :disabled="isBuiltinReadonly" @click="applyAutoLayout('horizontal')">自动水平布局</button>
            <button class="wf-editor__ghost-btn" type="button" :disabled="isBuiltinReadonly" @click="applyAutoLayout('vertical')">自动垂直布局</button>
            <button class="wf-editor__ghost-btn" type="button" :disabled="!hasSelectedBinding" @click="openBindingEditor">编辑节点</button>
            <button class="wf-editor__danger-btn" type="button" :disabled="isBuiltinReadonly || !hasSelectedBinding" @click="removeSelectedBinding">删除选中</button>
            <button class="wf-editor__save-btn" type="button" :disabled="isBuiltinReadonly || !isDirty" @click="saveWorkflow"><SaveOutlined /> {{ props.saveLabel || "保存" }}</button>
          </div>
        </div>

        <a-alert v-if="reworkEdgePreferenceError" type="error" :message="reworkEdgePreferenceError" show-icon>
          <template #action>
            <a-button size="small" @click="reloadReworkEdgeVisibility">重试</a-button>
          </template>
        </a-alert>
        <div class="wf-editor__canvas">
          <!-- 关闭 VueFlow 内置删除键（默认 Backspace）：它直接改 v-model 数据、不检查只读态，
               会绕过对内置流程的保护。删除统一由 handleGlobalKeydown 走 removeSelectedBinding。 -->
          <VueFlow
            v-model:nodes="editorNodes"
            v-model:edges="displayEdges"
            :delete-key-code="null"
            :connection-mode="ConnectionMode.Loose"
            :nodes-draggable="!isBuiltinReadonly"
            :nodes-connectable="!isBuiltinReadonly"
            :edges-updatable="!isBuiltinReadonly"
            :is-valid-connection="isValidConnection"
            @connect="onConnect"
            @edge-update="onEdgeUpdate"
            @node-drag="scheduleRefreshEditorEdgeAnchorLayouts"
            @node-drag-stop="() => { refreshEditorEdgeAnchorLayouts(); syncEditorEdgeStore(); }"
            @node-click="(event) => selectNode(event.node.id)"
            @node-double-click="handleNodeDoubleClick"
            @edge-click="(event) => selectEdge(event.edge.id)"
            @edge-double-click="(event) => { if (editorEdges.some((edge) => edge.id === event.edge.id)) handleEdgeDoubleClick(event); }"
            @pane-click="() => { selectedNodeId = null; selectedEdgeId = null; }"
          >
            <template #edge-workflow-smooth="edgeProps">
              <WorkflowSmoothEdge v-bind="edgeProps" />
            </template>
            <template #node-editor="nodeProps">
              <div class="wf-editor__node-shell">
                <Handle
                  id="left"
                  type="target"
                  :position="Position.Left"
                  class="wf-editor__handle wf-editor__handle--left"
                />
                <Handle
                  id="top"
                  type="target"
                  :position="Position.Top"
                  class="wf-editor__handle wf-editor__handle--top"
                />
                <div
                  class="wf-editor__node"
                  :class="[
                    `wf-editor__node--${nodeProps.data.card.statusTone}`,
                    { 'wf-editor__node--terminal': isWorkflowTerminalNodeType(nodeProps.data.workflowNode.type) },
                  ]"
                >
                  <!-- 开始/结束是圆形的终止符：只留居中节点名，不再重复类型徽标。 -->
                  <strong
                    v-if="isWorkflowTerminalNodeType(nodeProps.data.workflowNode.type)"
                    class="wf-editor__node-terminal-label"
                  >
                    {{ nodeProps.data.card.label }}
                  </strong>
                  <template v-else>
                    <div class="wf-editor__node-head">
                      <div class="wf-editor__node-copy">
                        <span v-if="nodeProps.data.card.eyebrow" class="wf-editor__node-eyebrow">
                          {{ nodeProps.data.card.eyebrow }}
                        </span>
                        <strong>{{ nodeProps.data.card.label }}</strong>
                      </div>
                      <span class="wf-editor__node-status" :class="`wf-editor__node-status--${nodeProps.data.card.statusTone}`">
                        {{ nodeProps.data.card.statusLabel }}
                      </span>
                    </div>
                    <div v-if="nodeProps.data.card.metrics.length" class="wf-editor__node-metrics">
                      <span
                        v-for="metric in nodeProps.data.card.metrics"
                        :key="metric.key"
                        class="wf-editor__node-metric"
                        :class="`wf-editor__node-metric--${metric.tone}`"
                      >
                        {{ metric.label }} {{ metric.value }}
                      </span>
                    </div>
                    <div v-if="nodeProps.data.card.badges.length" class="wf-editor__node-badges">
                      <span
                        v-for="badge in nodeProps.data.card.badges"
                        :key="badge.key"
                        class="wf-editor__node-badge"
                        :class="`wf-editor__node-badge--${badge.tone}`"
                      >
                        {{ badge.text }}
                      </span>
                    </div>
                  </template>
                </div>
                <Handle
                  id="right"
                  type="source"
                  :position="Position.Right"
                  class="wf-editor__handle wf-editor__handle--right"
                />
                <Handle
                  id="bottom"
                  type="source"
                  :position="Position.Bottom"
                  class="wf-editor__handle wf-editor__handle--bottom"
                />
              </div>
            </template>
            <Background />
            <Controls />
            <MiniMap
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
        </div>

        <div
          v-if="contextMenu?.visible"
          class="wf-editor__context-menu"
          :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        >
          <div class="wf-editor__context-title">
            {{ contextMenu.kind === "node" ? "节点" : "连线" }} · {{ contextMenu.title }}
          </div>
          <button class="wf-editor__context-item" type="button" @click="handleContextAction('edit')">编辑节点</button>
          <button
            v-if="contextMenu.kind === 'node'"
            class="wf-editor__context-item"
            :disabled="isBuiltinReadonly"
            type="button"
            @click="duplicateSelectedNode"
          >
            复制节点
          </button>
          <button
            v-if="contextMenu.kind === 'node'"
            class="wf-editor__context-item"
            :disabled="isBuiltinReadonly"
            type="button"
            @click="addDownstreamNodeFromSelection"
          >
            从这里新建下游节点
          </button>
          <button class="wf-editor__context-item wf-editor__context-item--danger" :disabled="isBuiltinReadonly" type="button" @click="handleContextAction('delete')">
            {{ contextMenu.kind === "node" ? "删除节点" : "删除连线" }}
          </button>
        </div>
      </div>
    </div>

    <a-modal
      :open="workflowSettingsOpen"
      :width="860"
      :body-style="bindingModalBodyStyle"
      wrap-class-name="wf-editor__settings-dialog"
      title="流程设置"
      @cancel="workflowSettingsOpen = false"
    >
      <template #footer>
        <div class="wf-editor__dialog-footer">
          <div class="wf-editor__dialog-footer-copy">这里维护流程级默认配置，不直接改节点细节。</div>
          <div class="wf-editor__dialog-footer-actions">
            <button class="wf-editor__ghost-btn" type="button" @click="workflowSettingsOpen = false">关闭</button>
            <button class="wf-editor__save-btn" type="button" :disabled="isBuiltinReadonly" @click="saveWorkflowAndCloseSettings"><SaveOutlined /> 保存</button>
          </div>
        </div>
      </template>

      <fieldset class="wf-editor__readonly-fieldset wf-editor__modal" :disabled="isBuiltinReadonly">
        <label class="wf-editor__field">
          <span>流程描述</span>
          <textarea
            v-model="workflowDescription"
            name="codeflow-workflow-description"
            autocomplete="off"
            class="wf-editor__textarea"
            rows="3"
            placeholder="写清这个流程适用什么场景，便于他人挑选模板"
          />
        </label>
        <label class="wf-editor__field">
          <span>流程类型</span>
          <select v-model="workflowFamily" class="wf-editor__select">
            <option value="feature-dev">feature-dev</option>
            <option value="generic-kb">generic-kb</option>
            <option value="bugfix">bugfix</option>
            <option value="analysis">analysis</option>
          </select>
          <small class="wf-editor__field-hint">分类标记：在需求分析里用这个流程生成需求时，需求会沿用该类型——bugfix / analysis 记为对应类型，其余（feature-dev、generic-kb）记为「新功能开发」；generic-kb 用于知识库/资料类流程。它不改变执行，跑哪些节点、走哪条连线由下面的模板决定。</small>
        </label>

        <div class="wf-editor__field wf-editor__config-card">
          <component
            :is="isBuiltinReadonly ? 'div' : 'button'"
            class="wf-editor__section-toggle"
            role="button"
            :tabindex="isBuiltinReadonly ? 0 : undefined"
            :aria-expanded="knowledgeSectionExpanded"
            @click="knowledgeSectionExpanded = !knowledgeSectionExpanded"
            @keydown.enter.prevent="knowledgeSectionExpanded = !knowledgeSectionExpanded"
            @keydown.space.prevent="knowledgeSectionExpanded = !knowledgeSectionExpanded"
          >
            <span>流程默认知识库</span>
            <small>已选 {{ workflowKnowledgeBundleIds.length }} 个</small>
            <DownOutlined class="wf-editor__section-caret" :class="{ 'is-expanded': knowledgeSectionExpanded }" />
          </component>
          <small class="wf-editor__field-hint">这些知识库会作为流程级默认上下文，节点还可以继续单独叠加自己的额外知识范围。</small>
          <div v-show="knowledgeSectionExpanded" class="wf-editor__check-grid">
            <label v-for="bundle in visibleKnowledgeBundles" :key="bundle.id" class="wf-editor__check-card">
              <input v-model="workflowKnowledgeBundleIds" type="checkbox" :value="bundle.id" />
              <div>
                <strong>{{ bundle.name }}</strong>
                <p>{{ bundle.scope }}</p>
              </div>
            </label>
          </div>
        </div>
      </fieldset>

      <section v-if="props.previewReadonly !== true" class="wf-editor__model-config">
        <div class="wf-editor__field">
          <span>模型配置</span>
          <small class="wf-editor__field-hint">
            配置后该流程内 {{ executionRoleCount }} 个角色统一按此引擎与模型执行，覆盖角色自身的执行配置；任务发起时单独选择的角色模型优先。
            该配置只作用于本工作区，不修改流程定义，内置流程重新发布也不会覆盖它。
          </small>
        </div>
        <div class="wf-editor__model-config-row">
          <label class="wf-editor__field">
            <span>执行引擎</span>
            <select v-model="executionDefaultEngine" class="wf-editor__select" :disabled="executionDefaultLoading">
              <option :value="null">不覆盖</option>
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <label class="wf-editor__field">
            <span>模型</span>
            <select
              v-model="executionDefaultModel"
              class="wf-editor__select"
              :disabled="executionDefaultLoading || !executionDefaultEngine"
            >
              <option value="" disabled>{{ executionDefaultEngine ? "请选择模型" : "请先选择执行引擎" }}</option>
              <option v-for="option in executionDefaultModelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <small v-if="executionDefaultEngine && !executionDefaultModelOptions.length" class="wf-editor__field-hint">
              当前工作区模型目录尚未加载或没有可用模型，请先确认本工作区的模型清单。
            </small>
          </label>
        </div>
        <div class="wf-editor__model-config-footer">
          <small class="wf-editor__field-hint">
            <template v-if="savedExecutionDefault">
              已配置：{{ savedExecutionDefault.engine === "codex" ? "Codex" : "Claude" }} · {{ savedExecutionDefault.model }}
            </template>
            <template v-else>当前未配置模型，各角色按自身执行配置运行。</template>
          </small>
          <div class="wf-editor__model-config-actions">
            <button
              class="wf-editor__ghost-btn"
              type="button"
              :disabled="executionDefaultSaving || !savedExecutionDefault"
              @click="clearExecutionDefault"
            >
              恢复默认
            </button>
          </div>
        </div>
      </section>
    </a-modal>

    <WorkflowAssigneeTemplateManager
      v-model:open="assigneeTemplateManagerOpen"
      :workspace-id="workspaceId"
      :workflow="savedWorkflow"
      :shared-workspace-id="sharedWorkspaceId"
    />

    <a-modal
      :open="bindingEditorOpen && hasSelectedBinding"
      :width="960"
      :body-style="bindingModalBodyStyle"
      wrap-class-name="wf-editor__binding-dialog"
      :title="bindingModalTitle"
      @cancel="closeBindingEditor"
    >
      <template #footer>
        <div v-if="hasSelectedBinding" class="wf-editor__dialog-footer">
          <button class="wf-editor__danger-btn" type="button" :disabled="isBuiltinReadonly" @click="removeSelectedBinding">删除当前绑定</button>
          <div class="wf-editor__dialog-footer-actions">
            <button class="wf-editor__ghost-btn" type="button" @click="closeBindingEditor">关闭</button>
            <button class="wf-editor__save-btn" type="button" :disabled="isBuiltinReadonly" @click="saveBindingEditsAndClose"><SaveOutlined /> 保存</button>
          </div>
        </div>
      </template>

      <fieldset class="wf-editor__readonly-fieldset wf-editor__modal wf-editor__modal--binding" :disabled="isBuiltinReadonly">
        <template v-if="selectedWorkflowNode">
          <div class="wf-editor__inspector-header">
            <div>
              <!-- 「节点绑定」与弹窗标题重复，已去掉；节点 ID 保留是因为「输入绑定」要按它引用上游节点。 -->
              <div class="wf-editor__summary">节点 ID：{{ selectedWorkflowNode.id }}</div>
            </div>
          </div>

          <section class="wf-editor__group">
            <h5 class="wf-editor__group-title">基础信息</h5>
            <div class="wf-editor__group-grid">
              <label class="wf-editor__field">
                <span>标签</span>
                <input
                  :value="selectedWorkflowNode.label"
                  name="codeflow-workflow-node-label"
                  autocomplete="new-password"
                  class="wf-editor__input"
                  @input="onNodeLabelInput"
                />
              </label>
              <label class="wf-editor__field">
                <span>类型</span>
                <select :value="selectedWorkflowNode.type" class="wf-editor__select" @change="onNodeTypeChange">
                  <option value="start">start</option><option value="role">role</option><option value="condition">condition</option><option value="parallel-fork">parallel-fork</option><option value="parallel-join">parallel-join</option><option value="end">end</option>
                </select>
              </label>
              <label v-if="selectedWorkflowNode.type === 'role'" class="wf-editor__field wf-editor__field--full">
                <span>绑定角色</span>
                <select :value="selectedWorkflowNode.roleId ?? ''" class="wf-editor__select" @change="onNodeRoleChange">
                  <option value="">请选择角色</option>
                  <option v-for="role in visibleRoles" :key="role.id" :value="role.id">{{ role.name }}</option>
                </select>
              </label>
              <label v-if="selectedWorkflowNode.type === 'condition'" class="wf-editor__field wf-editor__field--full">
                <span>条件说明（当前仅启发式）<a-tooltip title="当前不是通用条件表达式引擎。运行态只支持极少量启发式判断，复杂分支逻辑还未真正实现。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <textarea :value="selectedWorkflowNode.conditionExpr ?? ''" class="wf-editor__textarea" rows="4" @input="onConditionExprInput" />
              </label>
              <label v-if="selectedWorkflowNode.type === 'condition'" class="wf-editor__field wf-editor__field--full">
                <span>分支决策方式</span>
                <select :value="selectedWorkflowNode.conditionDecisionMode === 'manual' ? 'manual' : 'auto'" class="wf-editor__select" @change="onConditionDecisionModeChange">
                  <option value="auto">自动判断</option>
                  <option value="manual">人工选择</option>
                </select>
              </label>
            </div>
          </section>
          <section v-if="selectedWorkflowNode.type === 'role'" class="wf-editor__group">
            <h5 class="wf-editor__group-title">执行策略</h5>
            <div class="wf-editor__group-grid">
              <label class="wf-editor__field">
                <span>失败策略</span>
                <select :value="selectedWorkflowNode.failPolicy ?? ''" class="wf-editor__select" @change="onFailPolicyChange">
                  <option value="">未设置</option><option value="stop">stop</option><option value="wait-feedback">wait-feedback</option><option value="skip">skip</option>
                </select>
              </label>
              <label class="wf-editor__field">
                <span>节点审核方式</span>
                <select :value="selectedWorkflowNode.approvalMode ?? ''" class="wf-editor__select" @change="onApprovalModeChange">
                  <option value="">跟随需求默认</option>
                  <option value="auto">自动通过</option>
                  <option value="manual">人工审核</option>
                </select>
              </label>
              <label class="wf-editor__field">
                <span>节点启动方式</span>
                <select :value="selectedWorkflowNode.startMode === 'manual' ? 'manual' : 'auto'" class="wf-editor__select" @change="onStartModeChange">
                  <option value="auto">自动启动</option>
                  <option value="manual">人工启动</option>
                </select>
              </label>
              <label class="wf-editor__field">
                <span>工作项模式<a-tooltip title="适用于需要批量处理的节点。Agent 自行创建和维护清单，但任意时刻只能处理首个未完成项；所有工作项完成后才能提交节点结果。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <select :value="selectedWorkflowNode.workItemPolicy?.mode ?? ''" class="wf-editor__select" @change="onWorkItemModeChange">
                  <option value="">不启用</option>
                  <option value="sequential">同一会话严格顺序执行</option>
                </select>
              </label>
              <label v-if="selectedWorkflowNode.startMode === 'manual'" class="wf-editor__field wf-editor__field--full">
                <span>启动前置提示说明<a-tooltip title="仅在节点进入待启动状态时展示，用户填写的补充说明会作为本次节点上下文传入执行。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <textarea
                  :value="selectedWorkflowNode.manualStartPrompt ?? ''"
                  class="wf-editor__textarea"
                  rows="4"
                  placeholder="例如：请判断需求涉及的子系统/模块，用于分支创建节点创建。"
                  @input="onManualStartPromptInput"
                />
              </label>
              <div class="wf-editor__field wf-editor__field--full">
                <span>允许退回到的上游节点<a-tooltip title="只有当当前节点通过结构化结论把 nextAction 设为 rework 时才会生效。不选则默认允许退回到所有上游角色节点。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <div v-if="upstreamRoleNodeOptions.length" class="wf-editor__check-grid">
                  <label v-for="option in upstreamRoleNodeOptions" :key="option.id" class="wf-editor__check-card">
                    <input :checked="selectedReworkTargetIds.has(option.id)" type="checkbox" @change="toggleReworkTarget(option.id, eventChecked($event))" />
                    <div><strong>{{ option.label }}</strong><p>{{ option.id }}</p></div>
                  </label>
                </div>
                <div v-else class="wf-editor__field-hint">当前节点上游还没有其他角色节点，暂时无需单独配置。</div>
              </div>
            </div>
          </section>
          <section v-if="selectedWorkflowNode.type === 'role'" class="wf-editor__group wf-editor__group--card">
            <div
              class="wf-editor__group-head"
              role="button"
              tabindex="0"
              :aria-expanded="bindingOutputSectionOpen"
              @click="bindingOutputSectionOpen = !bindingOutputSectionOpen"
              @keydown.enter.prevent="bindingOutputSectionOpen = !bindingOutputSectionOpen"
              @keydown.space.prevent="bindingOutputSectionOpen = !bindingOutputSectionOpen"
            >
              <h5 class="wf-editor__group-title">输出与结果</h5>
              <span class="wf-editor__group-summary">{{ bindingOutputSummary }}</span>
              <DownOutlined class="wf-editor__section-caret" :class="{ 'is-expanded': bindingOutputSectionOpen }" />
            </div>
            <div v-show="bindingOutputSectionOpen" class="wf-editor__group-grid">
              <label class="wf-editor__field">
                <span>输出模式<a-tooltip title="文件类结果默认会直接写入正式工作区路径；审核只改变 DB 中的状态，不再搬运文件。若要自定义目录、保存位置或冲突处理方式，请在下面设置。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <select :value="selectedWorkflowNode.outputArtifactMode ?? ''" class="wf-editor__select" @change="onOutputModeChange">
                  <option value="">跟随角色默认输出</option>
                  <option value="text">文本</option>
                  <option value="structured">结构化结果</option>
                  <option value="file">单文件</option>
                  <option value="file-set">多文件 / 文件集合</option>
                </select>
              </label>
              <label class="wf-editor__field">
                <span>结果名称（供流程引用）<a-tooltip title="例如 analysis-report、solution-plan、implementation-report、verification-report。这是流程里引用这类结果的稳定名称，不是文件名。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <input
                  :value="selectedWorkflowNode.outputResultKey ?? ''"
                  name="codeflow-workflow-output-result-key"
                  autocomplete="off"
                  class="wf-editor__input"
                  @input="onPrimaryOutputKindInput"
                />
              </label>
              <div class="wf-editor__field wf-editor__field--full">
                <div class="wf-editor__section-header">
                  <span>结果保存方式<a-tooltip title="默认规则是：文本/结构化结果保存到数据库；文件类结果同时保存到数据库和工作区。这里可以覆盖保存位置、发布目录与冲突处理方式。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                  <button class="wf-editor__ghost-btn" type="button" @click="resetOutputWritePolicy">恢复默认</button>
                </div>
                <div class="wf-editor__list-card">
                  <div class="wf-editor__list-grid">
                    <label class="wf-editor__field">
                      <span>保存位置</span>
                      <select :value="selectedWorkflowNode.outputWritePolicy?.persistenceMode ?? ''" class="wf-editor__select" @change="onPersistenceModeChange">
                        <option value="">跟随输出类型默认</option>
                        <option value="db-only">只写 DB</option>
                        <option value="workspace-only">只写工作区</option>
                        <option value="dual-write">DB + 工作区</option>
                      </select>
                    </label>
                    <label class="wf-editor__field">
                      <span>冲突处理方式</span>
                      <select :value="selectedOutputWritePolicy.overwritePolicy" class="wf-editor__select" @change="onOverwritePolicyChange">
                        <option value="create-versioned-copy">生成版本化副本</option>
                        <option value="overwrite">直接覆盖</option>
                        <option value="reject">发现冲突即报错</option>
                      </select>
                    </label>
                    <label class="wf-editor__field wf-editor__field--full">
                      <span>工作区基目录（可选）</span>
                      <input
                        :value="selectedOutputWritePolicy.baseDir ?? ''"
                        name="codeflow-workflow-output-base-dir"
                        autocomplete="off"
                        class="wf-editor__input"
                        placeholder="默认：工作流文档根目录/功能/&lt;需求名&gt;--&lt;短ID&gt;/&lt;角色名&gt;"
                        @input="onBaseDirInput"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </section>
          <section class="wf-editor__group wf-editor__group--card">
            <div
              class="wf-editor__group-head"
              role="button"
              tabindex="0"
              :aria-expanded="bindingKnowledgeSectionOpen"
              @click="bindingKnowledgeSectionOpen = !bindingKnowledgeSectionOpen"
              @keydown.enter.prevent="bindingKnowledgeSectionOpen = !bindingKnowledgeSectionOpen"
              @keydown.space.prevent="bindingKnowledgeSectionOpen = !bindingKnowledgeSectionOpen"
            >
              <h5 class="wf-editor__group-title">知识与输入</h5>
              <span class="wf-editor__group-summary">{{ bindingKnowledgeSummary }}</span>
              <DownOutlined class="wf-editor__section-caret" :class="{ 'is-expanded': bindingKnowledgeSectionOpen }" />
            </div>
            <div v-show="bindingKnowledgeSectionOpen" class="wf-editor__group-grid">
              <div class="wf-editor__field wf-editor__field--full">
                <span>额外知识库<a-tooltip title="节点会在流程默认知识库之上叠加这些来源，作为该节点这次执行可访问的知识范围。"><InfoCircleOutlined class="wf-editor__hint-icon" /></a-tooltip></span>
                <div class="wf-editor__check-grid">
                  <label v-for="bundle in visibleKnowledgeBundles" :key="bundle.id" class="wf-editor__check-card">
                    <input :checked="selectedKnowledgeIds.has(bundle.id)" type="checkbox" @change="toggleKnowledge(bundle.id, eventChecked($event))" />
                    <div><strong>{{ bundle.name }}</strong><p>{{ bundle.scope }}</p></div>
                  </label>
                </div>
              </div>
              <div v-if="selectedWorkflowNode.type === 'role'" class="wf-editor__field wf-editor__field--full">
                <div class="wf-editor__section-header"><span>输入绑定</span><button class="wf-editor__ghost-btn" @click="addInputBinding"><PlusOutlined /> 添加绑定</button></div>
                <small class="wf-editor__field-hint">来源节点 ID 填上游节点的 ID，可在该节点的绑定弹窗中查看。</small>
                <div v-for="(binding, index) in selectedWorkflowNode.inputBindings ?? []" :key="index" class="wf-editor__list-card">
                  <div class="wf-editor__list-grid">
                    <label class="wf-editor__field">
                      <span>来源节点 ID</span>
                      <input
                        :value="binding.sourceNodeId ?? ''"
                        name="codeflow-workflow-input-source-node"
                        autocomplete="off"
                        class="wf-editor__input"
                        @input="updateInputBinding(index, 'sourceNodeId', eventValue($event))"
                      />
                    </label>
                    <label class="wf-editor__field">
                      <span>来源结果名称</span>
                      <input
                        :value="binding.sourceArtifactKind ?? ''"
                        name="codeflow-workflow-input-source-result"
                        autocomplete="off"
                        class="wf-editor__input"
                        @input="updateInputBinding(index, 'sourceArtifactKind', eventValue($event))"
                      />
                    </label>
                    <label class="wf-editor__field">
                      <span>写入字段名</span>
                      <input
                        :value="binding.targetField ?? ''"
                        name="codeflow-workflow-input-target-field"
                        autocomplete="off"
                        class="wf-editor__input"
                        @input="updateInputBinding(index, 'targetField', eventValue($event))"
                      />
                    </label>
                  </div>
                  <a-switch class="app-form-switch" :checked="Boolean(binding.required)" :disabled="isBuiltinReadonly" checked-children="必需" un-checked-children="可选" @change="(checked: boolean) => updateInputBinding(index, 'required', checked)" />
                  <button class="wf-editor__danger-link" @click="removeInputBinding(index)">删除绑定</button>
                </div>
              </div>
            </div>
          </section>
        </template>

        <template v-else-if="selectedWorkflowEdge">
          <div class="wf-editor__inspector-header">
            <div>
              <h4>边绑定</h4>
              <div class="wf-editor__summary">{{ selectedEdge?.source }} -> {{ selectedEdge?.target }}</div>
            </div>
          </div>
          <label class="wf-editor__field">
            <span>分支标签</span>
            <input
              :value="selectedWorkflowEdge.conditionBranch ?? ''"
              name="codeflow-workflow-edge-branch"
              autocomplete="new-password"
              class="wf-editor__input"
              @input="onEdgeBranchInput"
            />
          </label>
          <div class="wf-editor__field">
            <div class="wf-editor__section-header"><span>字段映射</span><button class="wf-editor__ghost-btn" @click="addDataMapping"><PlusOutlined /> 添加映射</button></div>
            <div v-for="(mapping, index) in selectedWorkflowEdge.dataMappings" :key="index" class="wf-editor__list-card">
              <div class="wf-editor__list-grid">
                <label class="wf-editor__field">
                  <span>来源字段</span>
                  <input
                    :value="mapping.sourceField"
                    name="codeflow-workflow-mapping-source-field"
                    autocomplete="off"
                    class="wf-editor__input"
                    @input="updateDataMapping(index, 'sourceField', eventValue($event))"
                  />
                </label>
                <label class="wf-editor__field">
                  <span>目标字段</span>
                  <input
                    :value="mapping.targetField"
                    name="codeflow-workflow-mapping-target-field"
                    autocomplete="off"
                    class="wf-editor__input"
                    @input="updateDataMapping(index, 'targetField', eventValue($event))"
                  />
                </label>
              </div>
              <button class="wf-editor__danger-link" @click="removeDataMapping(index)">删除映射</button>
            </div>
          </div>
        </template>

        <div v-else class="wf-editor__binding-empty wf-editor__binding-empty--panel">选择节点或连线后，可在这里编辑流程绑定。</div>
      </fieldset>
    </a-modal>
  </div>
</template>

<style scoped>
.wf-editor { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
.wf-editor__readonly-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.wf-editor__readonly-badge { color: var(--app-muted, #6b7280); font-size: 12px; white-space: nowrap; }
.wf-editor__toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--app-border, #e8e8e8); flex-wrap: wrap; }
.wf-editor__name-input, .wf-editor__input, .wf-editor__select, .wf-editor__textarea { padding: 6px 8px; border: 1px solid var(--app-border, #d9d9d9); border-radius: 4px; font-size: 13px; outline: none; background: var(--app-bg, #fff); color: var(--app-text, #333); }
.wf-editor__name-input { width: 220px; font-weight: 600; }
/* 描述预览吃掉工具栏剩余宽度，把右侧的状态与「流程设置」推到最右；放不下才省略。 */
.wf-editor__desc-text { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: color-mix(in srgb, var(--app-text, #333) 72%, #8b8b8b); }
.wf-editor__textarea { width: 100%; resize: vertical; }
.wf-editor__errors { display: flex; gap: 4px; flex-wrap: wrap; }
.wf-editor__error-tag { padding: 2px 8px; background: #fff2f0; color: #ff4d4f; border-radius: 4px; font-size: 11px; }
.wf-editor__save-btn, .wf-editor__ghost-btn, .wf-editor__danger-btn { padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.wf-editor__save-btn, .wf-editor__ghost-btn, .wf-editor__danger-btn { min-height:34px; padding:6px 14px; border-radius:10px; font-size:13px; }
.wf-editor__save-btn {
  border: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  color: #fff;
  box-shadow: 0 12px 24px rgba(201,100,66,0.18);
}
.wf-editor__ghost-btn { border: 1px dashed var(--app-border); background: none; color: var(--app-accent); }
/* 视图偏好按钮的开启态：保持文字按钮外形，用实线边框与淡底色表示当前已开启 */
.wf-editor__ghost-btn--active { border-style: solid; border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border, #e8e8e8)); background: color-mix(in srgb, var(--app-accent) 10%, transparent); }
.wf-editor__danger-btn { border: 1px solid #ffccc7; background: #fff2f0; color: #cf1322; }
.wf-editor__danger-link { border: none; background: none; color: #cf1322; cursor: pointer; font-size: 12px; padding: 0; }
.wf-editor__bindings-label, .wf-editor__binding-empty { font-size: 12px; color: var(--app-muted, #666); }
.wf-editor__bindings-note { font-size: 12px; color: var(--app-muted, #8c8c8c); }
.wf-editor__binding-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 999px; font-size: 12px; }
.wf-editor__body { display: grid; grid-template-columns: 128px minmax(0, 1fr); flex: 1; min-height: 0; min-width: 0; }
.wf-editor__palette { padding: 12px; border-right: 1px solid var(--app-border, #e8e8e8); overflow-y: auto; }
.wf-editor__palette h4 { margin: 0 0 12px; font-size: 12px; color: var(--app-muted, #999); }
.wf-editor__palette-btn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 8px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 4px; background: none; cursor: pointer; font-size: 12px; margin-bottom: 6px; color: var(--app-text, #333); }
.wf-editor__palette-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.wf-editor__canvas-shell { min-width: 0; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
/* 工具栏放不下时整块换行，避免摘要被压成逐字竖排 */
.wf-editor__canvas-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--app-border, #e8e8e8); }
/* 摘要按整行宽度正常折行；用最小宽度挡住「被压成一列单字」的竖排 */
.wf-editor__selection-summary { flex: 1 1 240px; min-width: 8em; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg)); color: var(--app-text); font-size: 12px; line-height: 1.6; }
.wf-editor__selection-summary--idle { color: var(--app-muted, #6b7280); background: color-mix(in srgb, var(--app-bg, #fff) 92%, #f5f7fb); }
.wf-editor__canvas-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wf-editor__canvas { min-width: 0; flex: 1; min-height: 0; height: 100%; }
:deep(.wf-editor__canvas .vue-flow__node-editor) { background: transparent; }
/* 选中光晕取主题色，阴影用固定黑透明度：亮暗两套都能用，不再需要暗色覆盖。 */
:deep(.wf-editor__canvas .vue-flow__node.selected) { box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-accent) 22%, transparent), 0 10px 24px rgba(0, 0, 0, 0.16); }
:deep(.wf-editor__canvas .vue-flow__node.selected > div) { box-shadow: inherit; }
:deep(.wf-editor__canvas .vue-flow__edge-path),
:deep(.wf-editor__canvas .vue-flow__edge-interaction) {
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
:deep(.wf-editor__canvas .vue-flow__edge-path) {
  stroke: var(--wf-editor-edge-default, #8699ad);
  stroke-width: 1.9px;
  transition: stroke 0.18s ease, stroke-width 0.18s ease;
}
:deep(.wf-editor__canvas .vue-flow__edge.selected .vue-flow__edge-path) {
  stroke: var(--wf-editor-edge-selected, #1677ff);
  stroke-width: 2.35px;
}
:deep(.wf-editor__canvas .vue-flow__connection-path) {
  stroke: var(--wf-editor-edge-selected, #1677ff);
  stroke-width: 1.9px;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 4 3;
}
/* 画布浮层（缩放控件/小地图）配色只用主题变量，不用 :root[data-theme] 属性选择器：
   在 scoped 样式里 :root 会被编译成 :root[data-theme][data-v-x]，html 上永远没有组件属性，规则会静默失效。 */
:deep(.wf-editor__canvas .vue-flow__controls) {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--app-panel-bg);
  box-shadow: var(--app-shadow);
}
:deep(.wf-editor__canvas .vue-flow__controls .vue-flow__controls-button) {
  background: transparent;
  border-bottom: 1px solid var(--app-divider);
  color: var(--app-muted);
}
:deep(.wf-editor__canvas .vue-flow__controls .vue-flow__controls-button:last-child) { border-bottom: 0; }
:deep(.wf-editor__canvas .vue-flow__controls .vue-flow__controls-button:hover) { background: var(--app-sidebar-hover-bg); color: var(--app-text); }
/* 库的按钮图标是写死的深色，必须显式跟随 currentColor 才能随按钮文字色一起变。 */
:deep(.wf-editor__canvas .vue-flow__controls .vue-flow__controls-button svg) { fill: currentColor; stroke: currentColor; }
:deep(.wf-editor__canvas .vue-flow__minimap) {
  border: 1px solid var(--app-border);
  border-radius: 12px;
  overflow: hidden;
  background: var(--app-panel-bg);
  box-shadow: var(--app-shadow);
}
:deep(.wf-editor__canvas .vue-flow__edge-textbg) {
  fill: var(--wf-editor-edge-label-bg, rgba(255, 255, 255, 0.9));
}
:deep(.wf-editor__canvas .vue-flow__edge-text) {
  fill: var(--wf-editor-edge-label-text, #475569);
  font-size: 11px;
  font-weight: 600;
}
.wf-editor__node-shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.wf-editor__node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  padding: 9px 12px;
  overflow: hidden;
}
/* 开始/结束是圆：节点名居中；bbox 即外接正方形，handle 落在圆切点上，无需再定位。 */
.wf-editor__node--terminal {
  align-items: center;
  justify-content: center;
  gap: 0;
  padding: 0;
}
.wf-editor__node-terminal-label {
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
:deep(.wf-editor__node-shell .wf-editor__handle) {
  position: absolute;
  top: 50%;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 1px solid var(--wf-editor-edge-handle-border, #eff6ff);
  background: var(--wf-editor-edge-handle-bg, #6f869f);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.2);
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease, background-color 0.16s ease, border-color 0.16s ease;
}
:deep(.wf-editor__node-shell .wf-editor__handle::before) {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 999px;
}
:deep(.wf-editor__node-shell .wf-editor__handle--left) {
  left: -1px;
  transform: translate(-50%, -50%) scale(0.84);
}
:deep(.wf-editor__node-shell .wf-editor__handle--right) {
  right: -1px;
  transform: translate(50%, -50%) scale(0.84);
}
:deep(.wf-editor__node-shell .wf-editor__handle--top) {
  top: -1px;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.84);
}
:deep(.wf-editor__node-shell .wf-editor__handle--bottom) {
  top: auto;
  bottom: -1px;
  left: 50%;
  right: auto;
  transform: translate(-50%, 50%) scale(0.84);
}
:deep(.wf-editor__canvas .vue-flow__node:hover .wf-editor__handle),
:deep(.wf-editor__canvas .vue-flow__node.selected .wf-editor__handle),
:deep(.wf-editor__node-shell .wf-editor__handle.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle.valid) {
  opacity: 1;
}
:deep(.wf-editor__canvas .vue-flow__node:hover .wf-editor__handle--left),
:deep(.wf-editor__canvas .vue-flow__node.selected .wf-editor__handle--left),
:deep(.wf-editor__node-shell .wf-editor__handle--left.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle--left.valid) {
  transform: translate(-50%, -50%) scale(1);
}
:deep(.wf-editor__canvas .vue-flow__node:hover .wf-editor__handle--right),
:deep(.wf-editor__canvas .vue-flow__node.selected .wf-editor__handle--right),
:deep(.wf-editor__node-shell .wf-editor__handle--right.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle--right.valid) {
  transform: translate(50%, -50%) scale(1);
}
:deep(.wf-editor__canvas .vue-flow__node:hover .wf-editor__handle--top),
:deep(.wf-editor__canvas .vue-flow__node.selected .wf-editor__handle--top),
:deep(.wf-editor__node-shell .wf-editor__handle--top.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle--top.valid) {
  transform: translate(-50%, -50%) scale(1);
}
:deep(.wf-editor__canvas .vue-flow__node:hover .wf-editor__handle--bottom),
:deep(.wf-editor__canvas .vue-flow__node.selected .wf-editor__handle--bottom),
:deep(.wf-editor__node-shell .wf-editor__handle--bottom.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle--bottom.valid) {
  transform: translate(-50%, 50%) scale(1);
}
:deep(.wf-editor__node-shell .wf-editor__handle.connecting),
:deep(.wf-editor__node-shell .wf-editor__handle.valid) {
  background: var(--wf-editor-edge-handle-active, #c96442);
  border-color: color-mix(in srgb, var(--wf-editor-edge-handle-active, #c96442) 76%, #ffffff);
}
.wf-editor__node-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
  align-items: start;
  min-width: 0;
}
.wf-editor__node-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.wf-editor__node-eyebrow {
  font-size: 10px;
  line-height: 1.4;
  color: color-mix(in srgb, var(--app-text, #1f2937) 54%, #94a3b8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-editor__node-copy strong {
  font-size: 13px;
  line-height: 1.35;
  color: inherit;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}
.wf-editor__node-status,
.wf-editor__node-metric,
.wf-editor__node-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  line-height: 1;
  font-weight: 600;
}
.wf-editor__node-status {
  min-height: 22px;
  max-width: 84px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.wf-editor__node-metrics,
.wf-editor__node-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-content: flex-start;
  overflow: hidden;
}
.wf-editor__node-metrics {
  min-height: 22px;
  max-height: 52px;
}
.wf-editor__node-badges {
  max-height: 24px;
}
.wf-editor__node-metric,
.wf-editor__node-badge {
  min-height: 20px;
  padding: 0 8px;
  font-size: 10px;
}
.wf-editor__node-status--neutral,
.wf-editor__node-badge--neutral { background: rgba(148, 163, 184, 0.14); color: #475569; }
.wf-editor__node-status--info,
.wf-editor__node-badge--info { background: rgba(22, 119, 255, 0.12); color: #0958d9; }
.wf-editor__node-status--success,
.wf-editor__node-badge--success { background: rgba(82, 196, 26, 0.14); color: #237804; }
.wf-editor__node-status--warning,
.wf-editor__node-badge--warning { background: rgba(250, 173, 20, 0.16); color: #ad6800; }
.wf-editor__node-status--danger,
.wf-editor__node-badge--danger { background: rgba(255, 77, 79, 0.14); color: #cf1322; }
.wf-editor__node-status--violet,
.wf-editor__node-badge--violet { background: rgba(114, 46, 209, 0.14); color: #531dab; }
.wf-editor__node-metric--input { background: rgba(22, 119, 255, 0.12); color: #0958d9; }
.wf-editor__node-metric--output { background: rgba(82, 196, 26, 0.14); color: #237804; }
.wf-editor__node-metric--thread { background: rgba(114, 46, 209, 0.14); color: #531dab; }
.wf-editor__node-metric--human { background: rgba(250, 173, 20, 0.16); color: #ad6800; }
.wf-editor__node-metric--retry { background: rgba(148, 163, 184, 0.14); color: #475569; }
.wf-editor__context-menu { position: fixed; z-index: 2200; min-width: 180px; padding: 8px; border: 1px solid var(--app-border, #d9d9d9); border-radius: 14px; background: color-mix(in srgb, var(--app-bg, #fff) 98%, #f7f9fc); box-shadow: 0 16px 34px rgba(15, 23, 42, 0.18); }
.wf-editor__context-title { padding: 4px 8px 8px; font-size: 12px; font-weight: 600; color: var(--app-text, #1f2937); line-height: 1.5; }
.wf-editor__context-item { width: 100%; border: 0; border-radius: 10px; background: transparent; color: var(--app-text, #1f2937); padding: 9px 10px; text-align: left; font-size: 13px; cursor: pointer; appearance: none; -webkit-appearance: none; transition: background-color 0.14s ease, color 0.14s ease, box-shadow 0.14s ease; }
.wf-editor__context-item:hover { background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-bg)); }
.wf-editor__context-item:focus-visible { outline: none; background: color-mix(in srgb, var(--app-accent) 12%, var(--app-panel-bg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 36%, var(--app-border)); }
.wf-editor__context-item--danger { color: #cf1322; }
.wf-editor__inspector-header, .wf-editor__section-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.wf-editor__inspector-header h4 { margin: 0; font-size: 14px; }
.wf-editor__field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 14px; }
.wf-editor__field--full { grid-column: 1 / -1; }
.wf-editor__field span { font-size: 12px; color: var(--app-muted, #666); }
.wf-editor__field-hint { font-size: 11px; line-height: 1.6; color: var(--app-muted, #8c8c8c); }
.wf-editor__check-grid, .wf-editor__list-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }

/* 可折叠区块标题：整行可点，右侧箭头指示展开态。 */
.wf-editor__section-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.wf-editor__section-toggle > span {
  font-weight: 600;
  color: var(--app-text);
}

.wf-editor__section-toggle > small {
  color: var(--app-muted);
}

.wf-editor__section-caret {
  margin-left: auto;
  font-size: 11px;
  color: var(--app-muted);
  transition: transform 0.15s ease;
}

.wf-editor__section-caret.is-expanded {
  transform: rotate(180deg);
}
.wf-editor__check-card, .wf-editor__list-card { border: 1px solid var(--app-border, #e8e8e8); border-radius: 8px; padding: 8px; }
.wf-editor__check-card { display: flex; align-items: flex-start; gap: 8px; }
.wf-editor__check-card strong { display: block; font-size: 12px; }
.wf-editor__check-card p { margin: 2px 0 0; font-size: 11px; color: var(--app-muted, #999); }
.wf-editor__checkbox-line { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; margin: 8px 0; }
.wf-editor__choice-group { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.wf-editor__choice-group--inline { width:min(220px,100%); margin:8px 0; }
.wf-editor__choice { position:relative; cursor:pointer; }
.wf-editor__choice input { position:absolute; opacity:0; pointer-events:none; }
.wf-editor__choice span {
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 12px;
  border:1px solid var(--wf-editor-control-border, #cfd8e3);
  border-radius:12px;
  background:var(--wf-editor-control-bg, #fbfdff);
  box-shadow:var(--wf-editor-control-shadow, inset 0 1px 0 rgba(255,255,255,0.75));
  color:color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size:12px;
  font-weight:600;
  transition:border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}
.wf-editor__choice:hover span {
  border-color:var(--wf-editor-control-border-hover, #93a4b8);
  background:var(--wf-editor-control-bg-hover, #f2f8ff);
  box-shadow:var(--wf-editor-control-shadow-hover, inset 0 1px 2px rgba(15,23,42,0.04));
}
.wf-editor__choice input:checked + span {
  border-color:var(--wf-editor-control-focus, #3898ec);
  box-shadow:var(--wf-editor-control-focus-ring, inset 0 0 0 1px #3898ec, 0 0 0 3px rgba(56,152,236,0.18));
  background:color-mix(in srgb, var(--wf-editor-control-bg-hover, #f2f8ff) 86%, #ffffff);
  color:color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}
.wf-editor__summary { margin-top: 6px; padding: 8px 10px; border-radius: 8px; background: var(--app-bg-secondary); font-size: 12px; }
.wf-editor__binding-empty--panel { padding: 24px 16px; line-height: 1.7; }
.wf-editor__dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wf-editor__dialog-footer-copy { font-size: 12px; color: var(--app-muted, #6b7280); }
.wf-editor__dialog-footer-actions { display: flex; align-items: center; gap: 10px; }
.wf-editor__modal { display: flex; flex-direction: column; gap: 14px; min-height: 0; }
/* 节点绑定弹窗字段多，改为两列分组网格压缩纵向长度；短控件并排，长内容跨整行。 */
.wf-editor__modal--binding { gap: 18px; }
.wf-editor__modal--binding .wf-editor__group { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.wf-editor__modal--binding .wf-editor__group-title { margin: 0; color: var(--app-text, #333); font-size: 13px; font-weight: 600; }
.wf-editor__modal--binding .wf-editor__group-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; }
.wf-editor__modal--binding .wf-editor__group-head:hover .wf-editor__group-title,
.wf-editor__modal--binding .wf-editor__group-head:focus-visible .wf-editor__group-title { color: var(--app-link, #1677ff); }
.wf-editor__modal--binding .wf-editor__group-summary { min-width: 0; margin-left: auto; overflow: hidden; color: var(--app-muted, #6b7280); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
/* 可折叠分组做成与「流程默认知识库」一致的聚合成卡片：标题左、摘要右、箭头最右。 */
.wf-editor__modal--binding .wf-editor__group--card { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 10px; background: color-mix(in srgb, var(--app-bg, #fff) 96%, #f8fafc); }
.wf-editor__modal--binding .wf-editor__group--card .wf-editor__group-head { gap: 10px; }
.wf-editor__modal--binding .wf-editor__group--card .wf-editor__section-caret { margin-left: 0; flex: 0 0 auto; }
.wf-editor__modal--binding .wf-editor__group-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; }
/* 单行控件与名称同行，省下一行高度；含 textarea 的字段保持纵向，否则控件会被压窄。
   只作用于 <label> 字段：checkbox 网格与卡片列表用的是 <div>，布局不受影响。 */
.wf-editor__modal--binding label.wf-editor__field:not(:has(textarea)) {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 4px 10px;
}
/* 折叠区的键盘可达性依赖 role=button + tabindex，焦点环必须可见。 */
.wf-editor__modal--binding .wf-editor__group-head:focus-visible { outline: 2px solid var(--app-link, #1677ff); outline-offset: 2px; border-radius: 4px; }
.wf-editor__hint-icon { margin-left: 4px; color: var(--app-muted, #6b7280); font-size: 12px; cursor: help; }
@media (max-width: 720px) {
  .wf-editor__modal--binding .wf-editor__group-grid { grid-template-columns: minmax(0, 1fr); }
}
.wf-editor__model-config,
.wf-editor__field.wf-editor__config-card { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border: 1px solid var(--app-border, #e8e8e8); border-radius: 10px; background: color-mix(in srgb, var(--app-bg, #fff) 96%, #f8fafc); }
.wf-editor__model-config-row { display: flex; gap: 16px; }
.wf-editor__model-config-row .wf-editor__field { flex: 1 1 0; margin-bottom: 0; }
.wf-editor__model-config-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.wf-editor__model-config-actions { display: flex; align-items: center; gap: 10px; }
:root[data-theme="dark"] .wf-editor__model-config,
:root[data-theme="dark"] .wf-editor__config-card { border-color: #303030; background: #1f1f1f; }
:deep(.wf-editor__binding-dialog .ant-modal) { max-width: calc(100vw - 32px); margin: 24px auto; padding-bottom: 0; }
:deep(.wf-editor__binding-dialog .ant-modal-content) { display: flex; flex-direction: column; max-height: calc(100vh - 48px); overflow: hidden; }
:deep(.wf-editor__binding-dialog .ant-modal-body) { min-height: 0; overflow: auto; }
:deep(.wf-editor__settings-dialog .ant-modal) { max-width: calc(100vw - 32px); margin: 24px auto; padding-bottom: 0; }
:deep(.wf-editor__settings-dialog .ant-modal-content) { display: flex; flex-direction: column; max-height: calc(100vh - 48px); overflow: hidden; }
:deep(.wf-editor__settings-dialog .ant-modal-body) { min-height: 0; overflow: auto; }
@media (max-width: 1400px) { .wf-editor__body { grid-template-columns: 112px 1fr; } }
:root[data-theme="dark"] .wf-editor__toolbar, :root[data-theme="dark"] .wf-editor__palette, :root[data-theme="dark"] .wf-editor__canvas-toolbar, :root[data-theme="dark"] .wf-editor__binding-chip, :root[data-theme="dark"] .wf-editor__palette-btn, :root[data-theme="dark"] .wf-editor__check-card, :root[data-theme="dark"] .wf-editor__list-card, :root[data-theme="dark"] .wf-editor__context-menu { border-color: #303030; }
:root[data-theme="dark"] .wf-editor__node-copy strong { color: #f3f4f6; }
:root[data-theme="dark"] .wf-editor__node-status--neutral,
:root[data-theme="dark"] .wf-editor__node-badge--neutral,
:root[data-theme="dark"] .wf-editor__node-metric--retry { background: rgba(148, 163, 184, 0.16); color: #cbd5e1; }
:root[data-theme="dark"] .wf-editor__node-status--info,
:root[data-theme="dark"] .wf-editor__node-badge--info,
:root[data-theme="dark"] .wf-editor__node-metric--input { background: rgba(22, 119, 255, 0.16); color: #8eb7ff; }
:root[data-theme="dark"] .wf-editor__node-status--success,
:root[data-theme="dark"] .wf-editor__node-badge--success,
:root[data-theme="dark"] .wf-editor__node-metric--output { background: rgba(82, 196, 26, 0.18); color: #b7eb8f; }
:root[data-theme="dark"] .wf-editor__node-status--warning,
:root[data-theme="dark"] .wf-editor__node-badge--warning,
:root[data-theme="dark"] .wf-editor__node-metric--human { background: rgba(250, 173, 20, 0.18); color: #ffd666; }
:root[data-theme="dark"] .wf-editor__node-status--danger,
:root[data-theme="dark"] .wf-editor__node-badge--danger { background: rgba(255, 77, 79, 0.18); color: #ffccc7; }
:root[data-theme="dark"] .wf-editor__node-status--violet,
:root[data-theme="dark"] .wf-editor__node-badge--violet,
:root[data-theme="dark"] .wf-editor__node-metric--thread { background: rgba(114, 46, 209, 0.18); color: #d3adf7; }

.wf-editor__field {
  gap: 8px;
}

.wf-editor__field span,
.wf-editor__bindings-label {
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text, #1f2937) 82%, #4b5563);
}

.wf-editor__toolbar,
.wf-editor__palette,
.wf-editor__canvas-toolbar,
.wf-editor__check-card,
.wf-editor__list-card {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 96%, #f7f9fc), var(--app-bg, #fff));
}

.wf-editor__name-input,
.wf-editor__input,
.wf-editor__select,
.wf-editor__textarea {
  min-height: 40px;
  padding: 9px 12px;
  border-radius: 10px;
  border-color: color-mix(in srgb, var(--app-accent) 14%, var(--app-border));
  background: linear-gradient(180deg, #ffffff, #f7fbff);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 0 rgba(255, 255, 255, 0.9);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

.wf-editor__name-input:hover,
.wf-editor__input:hover,
.wf-editor__select:hover,
.wf-editor__textarea:hover {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border));
  background: linear-gradient(180deg, #ffffff, #f2f8ff);
}

.wf-editor__name-input:focus,
.wf-editor__input:focus,
.wf-editor__select:focus,
.wf-editor__textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 14%, transparent), inset 0 1px 2px rgba(15, 23, 42, 0.04);
  background: #fff;
}

.wf-editor__name-input::placeholder,
.wf-editor__input::placeholder,
.wf-editor__textarea::placeholder {
  color: color-mix(in srgb, var(--app-muted, #666) 76%, #9aa6b2);
}

:root[data-theme="dark"] .wf-editor__field span,
:root[data-theme="dark"] .wf-editor__bindings-label {
  color: #d6dbe4;
}

:root[data-theme="dark"] .wf-editor__toolbar,
:root[data-theme="dark"] .wf-editor__palette,
:root[data-theme="dark"] .wf-editor__canvas-toolbar,
:root[data-theme="dark"] .wf-editor__check-card,
:root[data-theme="dark"] .wf-editor__list-card {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
}

:root[data-theme="dark"] .wf-editor__name-input,
:root[data-theme="dark"] .wf-editor__input,
:root[data-theme="dark"] .wf-editor__select,
:root[data-theme="dark"] .wf-editor__textarea {
  border-color: #3b4c63;
  background: linear-gradient(180deg, #181d24, #13171d);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(59, 76, 99, 0.14);
}

:root[data-theme="dark"] .wf-editor__selection-summary { background: rgba(22, 119, 255, 0.12); color: #d6dbe4; }

:root[data-theme="dark"] .wf-editor__selection-summary--idle { background: rgba(255, 255, 255, 0.04); color: #9fb0c2; }

:root[data-theme="dark"] .wf-editor__context-menu { background: #151a21; }

:root[data-theme="dark"] .wf-editor__context-title { color: #d6dbe4; }

:root[data-theme="dark"] .wf-editor__context-item { color: #d6dbe4; }
:root[data-theme="dark"] .wf-editor__context-item:hover,
:root[data-theme="dark"] .wf-editor__context-item:focus-visible,
:root[data-theme="dark"] .wf-editor__context-item:active {
  background: color-mix(in srgb, var(--app-accent, #d97757) 18%, rgba(255, 255, 255, 0.07));
  color: #f3f6fb;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--app-accent, #d97757) 34%, rgba(255, 255, 255, 0.1));
}

.wf-editor {
  --wf-editor-edge-default: #8699ad;
  --wf-editor-edge-selected: #1677ff;
  --wf-editor-edge-label-bg: rgba(255, 255, 255, 0.9);
  --wf-editor-edge-label-text: #475569;
  --wf-editor-edge-handle-bg: color-mix(in srgb, var(--app-accent,#c96442) 56%, #ffffff);
  --wf-editor-edge-handle-border: color-mix(in srgb, var(--app-accent,#c96442) 26%, #ffffff);
  --wf-editor-edge-handle-active: color-mix(in srgb, var(--app-accent,#c96442) 88%, #b24a2b);
  --wf-editor-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 88%, #f5f0e6);
  --wf-editor-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 78%, #f9f5ed);
  --wf-editor-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 82%, #d9cfbf);
  --wf-editor-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 18%, #d3c7b7);
  --wf-editor-control-shadow: 0 0 0 1px color-mix(in srgb, #f0eee6 88%, transparent), inset 0 1px 0 rgba(255,255,255,0.78);
  --wf-editor-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d1cfc5 82%, transparent), inset 0 1px 0 rgba(255,255,255,0.86);
  --wf-editor-control-focus: #3898ec;
  --wf-editor-control-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --wf-editor-card-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #f8f3e9), color-mix(in srgb, var(--app-bg,#fff) 96%, #fdfbf6));
  --wf-editor-card-bg-hover: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #fff8f0), color-mix(in srgb, var(--app-bg,#fff) 88%, #f7eadc));
  --wf-editor-card-border: color-mix(in srgb, var(--app-border,#d9d9d9) 78%, #d8c9b4);
  --wf-editor-card-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d2bea6);
  --wf-editor-card-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 12px 26px rgba(88,58,32,0.04);
  --wf-editor-card-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 16px 30px rgba(88,58,32,0.1);
}

.wf-editor__field {
  gap: 8px;
}

.wf-editor__field span,
.wf-editor__bindings-label {
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text, #1f2937) 82%, #4b5563);
}

.wf-editor__toolbar,
.wf-editor__palette,
.wf-editor__canvas-toolbar {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #faf6ef), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
}

.wf-editor__selection-summary {
  padding: 0;
  padding-inline-end: 8px;
  background: transparent;
  border: none;
  box-shadow: none;
  color: color-mix(in srgb, var(--app-text,#1f2937) 84%, #5a4531);
  font-size: 13px;
}

.wf-editor__selection-summary--idle {
  background: transparent;
  color: color-mix(in srgb, var(--app-muted,#6b7280) 86%, #7b6856);
}

.wf-editor__check-grid,
.wf-editor__list-grid {
  gap: 10px;
}

.wf-editor__check-card,
.wf-editor__list-card {
  border: 1px solid var(--wf-editor-card-border);
  border-radius: 14px;
  padding: 12px;
  background: var(--wf-editor-card-bg);
  box-shadow: var(--wf-editor-card-shadow);
}

.wf-editor__check-card {
  gap: 10px;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease, transform 0.16s ease;
}

.wf-editor__check-card:hover {
  border-color: var(--wf-editor-card-border-hover);
  background: var(--wf-editor-card-bg-hover);
  box-shadow: var(--wf-editor-card-shadow-hover);
  transform: translateY(-1px);
}

.wf-editor__check-card strong {
  font-size: 13px;
}

.wf-editor__check-card p {
  margin: 4px 0 0;
  color: color-mix(in srgb, var(--app-muted,#666) 80%, #8a7258);
}

.wf-editor__check-card input,
.wf-editor__checkbox-line input {
  accent-color: var(--app-accent, #c96442);
}

.wf-editor__name-input,
.wf-editor__input,
.wf-editor__select,
.wf-editor__textarea {
  min-height: 40px;
  padding: 10px 12px;
  border-radius: 12px;
  border-color: var(--wf-editor-control-border);
  background: var(--wf-editor-control-bg);
  box-shadow: var(--wf-editor-control-shadow);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

.wf-editor__name-input:hover,
.wf-editor__input:hover,
.wf-editor__select:hover,
.wf-editor__textarea:hover {
  border-color: var(--wf-editor-control-border-hover);
  background: var(--wf-editor-control-bg-hover);
  box-shadow: var(--wf-editor-control-shadow-hover);
}

.wf-editor__name-input:focus,
.wf-editor__input:focus,
.wf-editor__select:focus,
.wf-editor__textarea:focus {
  border-color: var(--wf-editor-control-focus);
  box-shadow: var(--wf-editor-control-focus-ring);
  background: color-mix(in srgb, var(--wf-editor-control-bg-hover) 86%, #ffffff);
}

.wf-editor__name-input::placeholder,
.wf-editor__input::placeholder,
.wf-editor__textarea::placeholder {
  color: color-mix(in srgb, var(--app-muted, #666) 76%, #9aa6b2);
}

.wf-editor__save-btn,
.wf-editor__ghost-btn,
.wf-editor__danger-btn {
  min-height: 36px;
  padding: 6px 14px;
  border-radius: 10px;
}

.wf-editor__save-btn {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  box-shadow: 0 12px 24px rgba(201,100,66,0.18);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.wf-editor__save-btn:not(:disabled):hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow: 0 14px 28px rgba(201,100,66,0.26);
}
.wf-editor__save-btn:not(:disabled):active {
  transform: translateY(0) scale(0.98);
  filter: brightness(0.94);
  box-shadow: 0 6px 12px rgba(201,100,66,0.16);
}
.wf-editor__save-btn:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-accent,#c96442) 28%, transparent);
  outline-offset: 2px;
}

.wf-editor__ghost-btn {
  border-style: solid;
  border-color: color-mix(in srgb, var(--app-border,#d9d9d9) 74%, #d7c7b0);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf7f0), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
  color: color-mix(in srgb, var(--app-text,#1f2937) 80%, #6f553d);
}

.wf-editor__ghost-btn:hover:not(:disabled) {
  border-color: var(--wf-editor-control-border-hover);
  background: var(--wf-editor-control-bg-hover);
  box-shadow: var(--wf-editor-control-shadow-hover);
  color: color-mix(in srgb, var(--app-text,#1f2937) 84%, #5f4a35);
}

.wf-editor__danger-btn {
  border-color: color-mix(in srgb, #ff4d4f 34%, #d8b7b7);
  background: linear-gradient(180deg, #fff9f8, #fff0ee);
}

.wf-editor__danger-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, #ff4d4f 46%, #cf9d9d);
  background: linear-gradient(180deg, #fff6f5, #ffece9);
}

:root[data-theme="dark"] .wf-editor {
  --wf-editor-edge-default: #9fb3ca;
  --wf-editor-edge-selected: #65a9ff;
  --wf-editor-edge-label-bg: rgba(15, 23, 42, 0.88);
  --wf-editor-edge-label-text: #cbd5e1;
  --wf-editor-edge-handle-bg: color-mix(in srgb, var(--app-accent,#d97757) 44%, #2a2f36);
  --wf-editor-edge-handle-border: color-mix(in srgb, var(--app-accent,#d97757) 36%, #3a4452);
  --wf-editor-edge-handle-active: color-mix(in srgb, var(--app-accent,#d97757) 86%, #f2b28f);
  --wf-editor-control-bg: color-mix(in srgb, var(--app-panel-bg,#30302e) 92%, #1e1a16);
  --wf-editor-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#30302e) 84%, #27221c);
  --wf-editor-control-border: color-mix(in srgb, var(--app-border,#303030) 95%, #544a40);
  --wf-editor-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 22%, #6a5a4b);
  --wf-editor-control-shadow: 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 1px rgba(0,0,0,0.24);
  --wf-editor-control-shadow-hover: 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 1px rgba(0,0,0,0.28);
  --wf-editor-control-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --wf-editor-card-bg: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02));
  --wf-editor-card-bg-hover: linear-gradient(180deg, rgba(217,119,87,0.16), rgba(255,255,255,0.03));
  --wf-editor-card-border: color-mix(in srgb, var(--app-border,#303030) 92%, #5a4d42);
  --wf-editor-card-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 36%, #73604f);
  --wf-editor-card-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 28px rgba(0,0,0,0.18);
  --wf-editor-card-shadow-hover: inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(0,0,0,0.22);
}

:root[data-theme="dark"] .wf-editor__field span,
:root[data-theme="dark"] .wf-editor__bindings-label {
  color: #d6dbe4;
}

:root[data-theme="dark"] .wf-editor__toolbar,
:root[data-theme="dark"] .wf-editor__palette,
:root[data-theme="dark"] .wf-editor__canvas-toolbar,
:root[data-theme="dark"] .wf-editor__check-card,
:root[data-theme="dark"] .wf-editor__list-card {
  background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
}

:root[data-theme="dark"] .wf-editor__name-input,
:root[data-theme="dark"] .wf-editor__input,
:root[data-theme="dark"] .wf-editor__select,
:root[data-theme="dark"] .wf-editor__textarea {
  color: #ece7df;
}

:root[data-theme="dark"] .wf-editor__selection-summary {
  background: transparent;
  border-color: transparent;
  color: #ece7df;
  box-shadow: none;
}

:root[data-theme="dark"] .wf-editor__selection-summary--idle {
  background: transparent;
  color: #9fb0c2;
}

@media (max-width: 767px) {
  .wf-editor__canvas-toolbar,
  .wf-editor__dialog-footer,
  .wf-editor__dialog-footer-actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>

<style>
.wf-editor__settings-dialog,
.wf-editor__binding-dialog {
  --wf-editor-modal-surface: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf6ee), color-mix(in srgb, var(--app-bg,#fff) 97%, #fffaf4));
  --wf-editor-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.76));
  --wf-editor-modal-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #ddceb8);
  --wf-editor-modal-header-border: color-mix(in srgb, var(--app-border,#d9d9d9) 68%, #eadfce);
  --wf-editor-modal-shadow: 0 28px 80px rgba(84,57,34,0.18);
  --wf-editor-modal-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 82%, #f7f0e5);
  --wf-editor-modal-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 74%, #fbf6ee);
  --wf-editor-modal-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #d5c5ae);
  --wf-editor-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d3bea2);
  --wf-editor-modal-control-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 10px 22px rgba(88,58,32,0.04);
  --wf-editor-modal-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 14px 26px rgba(88,58,32,0.09);
  --wf-editor-modal-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 16%, transparent);
  --wf-editor-modal-card-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #f8f3e9), color-mix(in srgb, var(--app-bg,#fff) 96%, #fdfbf6));
  --wf-editor-modal-card-bg-hover: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #fff8f0), color-mix(in srgb, var(--app-bg,#fff) 88%, #f7eadc));
  --wf-editor-modal-card-border: color-mix(in srgb, var(--app-border,#d9d9d9) 78%, #d8c9b4);
  --wf-editor-modal-card-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d2bea6);
}

.wf-editor__settings-dialog .ant-modal-content,
.wf-editor__binding-dialog .ant-modal-content {
  border: 1px solid var(--wf-editor-modal-border);
  border-radius: 20px;
  overflow: hidden;
  background: var(--wf-editor-modal-surface);
  box-shadow: var(--wf-editor-modal-shadow);
}

.wf-editor__settings-dialog .ant-modal-header,
.wf-editor__binding-dialog .ant-modal-header {
  margin-bottom: 0;
  padding: 18px 24px 14px;
  border-bottom: 1px solid var(--wf-editor-modal-header-border);
  background: var(--wf-editor-modal-surface-soft);
}

.wf-editor__settings-dialog .ant-modal-title,
.wf-editor__binding-dialog .ant-modal-title {
  font-size: 15px;
  font-weight: 700;
  color: color-mix(in srgb, var(--app-text,#1f2937) 88%, #5c4630);
}

.wf-editor__settings-dialog .ant-modal-body,
.wf-editor__binding-dialog .ant-modal-body {
  padding: 20px 24px 24px;
  background: transparent;
}

/* footer 与 body 同口径透出弹框表面，分隔线取 header 同色变量：亮暗都由 --app-* 派生，不需要按主题写覆盖。
   padding 沿用原先只在 scoped 块写过、却因 :deep 编译而从未生效的那两条规则。 */
.wf-editor__settings-dialog .ant-modal-footer,
.wf-editor__binding-dialog .ant-modal-footer {
  padding: 14px 24px 18px;
  border-top: 1px solid var(--wf-editor-modal-header-border);
  background: transparent;
}

.wf-editor__settings-dialog .ant-modal-close,
.wf-editor__binding-dialog .ant-modal-close {
  inset-inline-end: 14px;
  top: 14px;
  width: 34px;
  height: 34px;
  border-radius: 999px;
}

.wf-editor__settings-dialog .wf-editor__field,
.wf-editor__binding-dialog .wf-editor__field {
  gap: 8px;
}

.wf-editor__settings-dialog .wf-editor__field span,
.wf-editor__binding-dialog .wf-editor__field span {
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text,#1f2937) 84%, #594633);
}

.wf-editor__settings-dialog .wf-editor__input,
.wf-editor__settings-dialog .wf-editor__select,
.wf-editor__settings-dialog .wf-editor__textarea,
.wf-editor__binding-dialog .wf-editor__input,
.wf-editor__binding-dialog .wf-editor__select,
.wf-editor__binding-dialog .wf-editor__textarea {
  min-height: 42px;
  padding: 10px 12px;
  border: 1px solid var(--wf-editor-modal-control-border);
  border-radius: 12px;
  background: var(--wf-editor-modal-control-bg);
  box-shadow: var(--wf-editor-modal-control-shadow);
}

.wf-editor__settings-dialog .wf-editor__input:hover,
.wf-editor__settings-dialog .wf-editor__select:hover,
.wf-editor__settings-dialog .wf-editor__textarea:hover,
.wf-editor__binding-dialog .wf-editor__input:hover,
.wf-editor__binding-dialog .wf-editor__select:hover,
.wf-editor__binding-dialog .wf-editor__textarea:hover {
  border-color: var(--wf-editor-modal-control-border-hover);
  background: var(--wf-editor-modal-control-bg-hover);
  box-shadow: var(--wf-editor-modal-control-shadow-hover);
}

.wf-editor__settings-dialog .wf-editor__input:focus,
.wf-editor__settings-dialog .wf-editor__select:focus,
.wf-editor__settings-dialog .wf-editor__textarea:focus,
.wf-editor__binding-dialog .wf-editor__input:focus,
.wf-editor__binding-dialog .wf-editor__select:focus,
.wf-editor__binding-dialog .wf-editor__textarea:focus {
  border-color: #3898ec;
  box-shadow: var(--wf-editor-modal-focus-ring);
}

.wf-editor__settings-dialog .wf-editor__check-grid,
.wf-editor__binding-dialog .wf-editor__check-grid,
.wf-editor__binding-dialog .wf-editor__list-grid {
  gap: 10px;
}

.wf-editor__settings-dialog .wf-editor__choice-group,
.wf-editor__binding-dialog .wf-editor__choice-group {
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:8px;
}

.wf-editor__settings-dialog .wf-editor__choice-group--inline,
.wf-editor__binding-dialog .wf-editor__choice-group--inline {
  width:min(220px,100%);
}

.wf-editor__settings-dialog .wf-editor__choice,
.wf-editor__binding-dialog .wf-editor__choice {
  position:relative;
  cursor:pointer;
}

.wf-editor__settings-dialog .wf-editor__choice input,
.wf-editor__binding-dialog .wf-editor__choice input {
  position:absolute;
  opacity:0;
  pointer-events:none;
}

.wf-editor__settings-dialog .wf-editor__choice span,
.wf-editor__binding-dialog .wf-editor__choice span {
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:40px;
  padding:0 12px;
  border:1px solid var(--wf-editor-modal-control-border);
  border-radius:12px;
  background:var(--wf-editor-modal-control-bg);
  box-shadow:var(--wf-editor-modal-control-shadow);
  color:color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size:12px;
  font-weight:600;
}

.wf-editor__settings-dialog .wf-editor__choice:hover span,
.wf-editor__binding-dialog .wf-editor__choice:hover span {
  border-color:var(--wf-editor-modal-control-border-hover);
  background:var(--wf-editor-modal-control-bg-hover);
  box-shadow:var(--wf-editor-modal-control-shadow-hover);
}

.wf-editor__settings-dialog .wf-editor__choice input:checked + span,
.wf-editor__binding-dialog .wf-editor__choice input:checked + span {
  border-color:#3898ec;
  box-shadow:var(--wf-editor-modal-focus-ring);
  background:color-mix(in srgb, var(--wf-editor-modal-control-bg-hover) 84%, #ffffff);
  color:color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}


.wf-editor__settings-dialog .wf-editor__check-card,
.wf-editor__binding-dialog .wf-editor__check-card,
.wf-editor__binding-dialog .wf-editor__list-card {
  border: 1px solid var(--wf-editor-modal-card-border);
  border-radius: 14px;
  padding: 12px;
  background: var(--wf-editor-modal-card-bg);
  box-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 12px 26px rgba(88,58,32,0.04);
}

.wf-editor__settings-dialog .wf-editor__check-card:hover,
.wf-editor__binding-dialog .wf-editor__check-card:hover {
  border-color: var(--wf-editor-modal-card-border-hover);
  background: var(--wf-editor-modal-card-bg-hover);
}

.wf-editor__settings-dialog .wf-editor__check-card input,
.wf-editor__binding-dialog .wf-editor__check-card input,
.wf-editor__binding-dialog .wf-editor__checkbox-line input {
  accent-color: var(--app-accent, #c96442);
}

:root[data-theme="dark"] .wf-editor__settings-dialog,
:root[data-theme="dark"] .wf-editor__binding-dialog {
  --wf-editor-modal-surface: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
  --wf-editor-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  --wf-editor-modal-border: color-mix(in srgb, var(--app-border,#303030) 90%, #594c40);
  --wf-editor-modal-header-border: color-mix(in srgb, var(--app-border,#303030) 82%, #4b4036);
  --wf-editor-modal-shadow: 0 32px 90px rgba(0,0,0,0.45);
  --wf-editor-modal-control-bg: linear-gradient(180deg, rgba(31,27,23,0.98), rgba(24,21,18,0.98));
  --wf-editor-modal-control-bg-hover: linear-gradient(180deg, rgba(38,33,28,0.98), rgba(30,26,22,0.98));
  --wf-editor-modal-control-border: color-mix(in srgb, var(--app-border,#303030) 86%, #625346);
  --wf-editor-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 26%, #756152);
  --wf-editor-modal-control-shadow: inset 0 1px 1px rgba(255,255,255,0.04), 0 12px 24px rgba(0,0,0,0.22);
  --wf-editor-modal-control-shadow-hover: inset 0 1px 1px rgba(255,255,255,0.06), 0 14px 28px rgba(0,0,0,0.28);
  --wf-editor-modal-card-bg: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
  --wf-editor-modal-card-bg-hover: linear-gradient(180deg, rgba(217,119,87,0.14), rgba(255,255,255,0.03));
  --wf-editor-modal-card-border: color-mix(in srgb, var(--app-border,#303030) 88%, #5a4d42);
  --wf-editor-modal-card-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 34%, #73604f);
}
</style>

