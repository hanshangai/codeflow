<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from "vue";
import { message } from "ant-design-vue";
import { FullscreenExitOutlined, FullscreenOutlined, LoadingOutlined, QuestionCircleOutlined, ReloadOutlined, UnorderedListOutlined, WarningOutlined } from "@ant-design/icons-vue";
import {
  type Artifact,
  type ArtifactFileEntry,
  type GitFileStatus,
  type GitStatusResult,
  type NodeExecutionState,
  type NodeWorkItem,
  type NodeWorkItemEvent,
  type NodeWorkItemStatus,
  type NodeWorkItemSummary,
  type NodeResultField,
  type NodePromptSnapshot,
  type OrchestrationId,
  type RoleExecutionRevision,
  type WorkflowNode,
  type WorkspaceId,
} from "@codeflowai/shared";

import { fetchGitDiff, fetchGitDiffFiles, fetchGitStatus } from "../../../api/git";
import { listOrchNodeWorkItemEvents, listOrchNodeWorkItems } from "../../../api/orchestration";
import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore } from "../../../store/orchestration";
import {
  buildArtifactRevisionSubmission,
  buildDefaultArtifactRevisionNote,
  buildEditableArtifactDraft,
  cloneEditableArtifactDraft,
  createEmptyEditableArtifactFileDraft,
  formatArtifactRevisionCaption,
  type EditableArtifactDraft,
  type EditableArtifactFileDraft,
} from "../artifact-revision";
import { resolveNodeWorkbenchDescriptor } from "../node-workbench";
import DiffViewer from "../../chat/components/diff-viewer.vue";
import ArtifactFilePreview from "./artifact-file-preview.vue";
import {
  buildArtifactPresentation,
  inferArtifactRenderMode,
  isDocumentArtifactPath,
  isImageArtifactPath,
  isSpreadsheetArtifactPath,
  type ArtifactPreviewRenderMode,
  type ArtifactPresentation,
  type ArtifactPresentationFile,
} from "./artifact-preview-utils";

defineOptions({ name: "NodeExecutionDetail" });

type DetailView = "result" | "debug";
type PromptModalTab = "system" | "developer" | "user";
type PromptModalMessage = { key: PromptModalTab; label: string; content: string };
type OutputFieldDisplayItem = {
  key: string;
  label: string;
  valueType: string;
  valuePreview: string;
  valueText: string;
  validationStatus: string | null;
};
type OutputFileNavigatorItem = {
  kind: "file";
  key: string;
  filePath: string;
  gitPath: string;
  renderMode: ArtifactPreviewRenderMode;
  draftFileId: string | null;
  isDraft: boolean;
  fileRole: "contract" | "attachment";
  gitChange: OutputGitChange | null;
};
type OutputNavigatorItem = OutputFileNavigatorItem | {
  kind: "field";
  key: string;
  field: OutputFieldDisplayItem;
};
type OutputNavigatorGroup = {
  key: "contract" | "attachment" | "field";
  label: string;
  items: OutputNavigatorItem[];
};
type ArtifactCompareDiffPayload = {
  original: string;
  modified: string;
  filePath: string;
};
type OutputGitChangeKind = "added" | "modified" | "deleted" | "renamed";
type OutputGitChangeScope = "staged" | "unstaged" | "untracked";
type OutputGitChange = {
  path: string;
  kind: OutputGitChangeKind;
  scopes: OutputGitChangeScope[];
};
type OutputGitDiffMode = "unstaged" | "staged";
type OutputGitDiffPayload =
  | { kind: "files"; path: string; mode: OutputGitDiffMode; original: string; modified: string }
  | { kind: "patch"; path: string; mode: OutputGitDiffMode; diff: string };

const props = defineProps<{
  workspaceId: WorkspaceId;
  instanceId: OrchestrationId;
  nodeState: NodeExecutionState;
  node: WorkflowNode | null;
  workflowNodes?: WorkflowNode[];
  fillHeight?: boolean;
  artifacts?: Artifact[];
  promptSnapshots?: NodePromptSnapshot[];
  showAttentionNote?: boolean;
  /** 外层已有节点名时隐藏内部标题，避免同一名字出现两次（编排监控的分栏面板需要保留）。 */
  hideHeadlineTitle?: boolean;
}>();

const orch = useOrchestrationStore();
const { ctx } = useApiContext();
const slots = useSlots();
const activeView = ref<DetailView>("result");
const selectedOutputArtifactId = ref<string | null>(null);
const selectedInputArtifactId = ref<string | null>(null);
const selectedPromptSnapshotId = ref<string | null>(null);
const promptSnapshotManuallySelected = ref(false);
const promptModalOpen = ref(false);
const promptModalTab = ref<PromptModalTab>("user");
const selectedOutputPreviewPath = ref<string | null>(null);
const selectedOutputFieldKey = ref<string | null>(null);
const selectedInputPreviewPath = ref<string | null>(null);
const showOutputRaw = ref(false);
const showInputRaw = ref(false);
const conclusionPopoverRef = ref<HTMLElement | null>(null);
const showConclusionPopover = ref(false);
const revisionEditorOpen = ref(false);
const compareModalOpen = ref(false);
const compareModalFullscreen = ref(false);
const compareBaseArtifactId = ref<string | null>(null);
const outputGitStatusLoading = ref(false);
const outputGitStatusError = ref<string | null>(null);
const outputGitChangeMap = ref<Record<string, OutputGitChange>>({});
const outputGitDiffModalOpen = ref(false);
const outputGitDiffModalFullscreen = ref(false);
const outputGitDiffLoading = ref(false);
const outputGitDiffError = ref<string | null>(null);
const outputGitDiffPayload = ref<OutputGitDiffPayload | null>(null);
const outputGitDiffMode = ref<OutputGitDiffMode>("unstaged");
const revisionSubmitting = ref(false);
const revisionDraft = ref<EditableArtifactDraft | null>(null);
const revisionDraftFileId = ref<string | null>(null);
const revisionError = ref<string | null>(null);
const outputFileNavCollapsed = ref(false);
const OUTPUT_FILE_NAV_COLLAPSED_STORAGE_KEY = "nodeDetail.outputFileNavCollapsed";
const OUTPUT_GIT_STATUS_REFRESH_DEBOUNCE_MS = 120;
const OUTPUT_GIT_STATUS_CACHE_TTL_MS = 15_000;
const artifactFilesByArtifactId = ref<Record<string, ArtifactFileEntry[]>>({});
const artifactFieldsByArtifactId = ref<Record<string, NodeResultField[]>>({});
const artifactPreviewStates = ref<Record<string, { version: number; updatedAt: number; loading: boolean; error: string | null }>>({});
const inputDetailsOpen = ref(false);
let artifactPreviewGeneration = 0;
const workItemsPopoverOpen = ref(false);
const workItemStatusFilter = ref<"all" | NodeWorkItemStatus>("all");
const workItemSearchDraft = ref("");
const workItemSearch = ref("");
const workItems = ref<NodeWorkItem[]>([]);
const workItemSummary = ref<NodeWorkItemSummary | null>(null);
const workItemsLoading = ref(false);
const workItemsLoadingMore = ref(false);
const workItemsError = ref<string | null>(null);
const workItemsHasMore = ref(false);
const workItemsNextCursor = ref<string | null>(null);
const selectedWorkItemId = ref<string | null>(null);
const selectedWorkItemEvents = ref<NodeWorkItemEvent[]>([]);
const workItemEventsLoading = ref(false);
const workItemEventsError = ref<string | null>(null);
type OutputGitStatusCacheEntry = {
  scopeKey: string;
  loadedAt: number;
  changeMap: Record<string, OutputGitChange>;
};

let outputGitStatusRequestSeq = 0;
let outputGitDiffRequestSeq = 0;
let workItemRequestSeq = 0;
let workItemEventRequestSeq = 0;
let outputGitStatusRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let outputGitStatusCache: OutputGitStatusCacheEntry | null = null;
let outputGitStatusRefreshQueued = false;

const workItemsEnabled = computed(() =>
  props.node?.workItemPolicy?.mode === "sequential" || props.nodeState.workItemSummary != null,
);
const displayedWorkItemSummary = computed(() => workItemSummary.value ?? props.nodeState.workItemSummary ?? null);
const workItemProgressLabel = computed(() => {
  const summary = displayedWorkItemSummary.value;
  return summary ? `${summary.completed}/${summary.total}` : "0/0";
});
const selectedWorkItem = computed(() =>
  workItems.value.find((item) => item.id === selectedWorkItemId.value) ?? null,
);

const artifactsById = computed(() => {
  const map = new Map<string, Artifact>();
  for (const artifact of props.artifacts ?? []) {
    map.set(artifact.id, artifact);
  }
  return map;
});

const inputArtifacts = computed(() =>
  (props.nodeState.inputArtifactIds ?? [])
    .map((artifactId) => artifactsById.value.get(artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact)),
);

const outputArtifacts = computed(() =>
  (props.nodeState.outputArtifactIds ?? [])
    .map((artifactId) => artifactsById.value.get(artifactId))
    .filter((artifact): artifact is Artifact => Boolean(artifact)),
);

const nodeArtifacts = computed(() =>
  (props.artifacts ?? []).filter((artifact) => artifact.nodeId === props.nodeState.nodeId),
);

const availableOutputArtifacts = computed(() =>
  [...(outputArtifacts.value.length ? outputArtifacts.value : nodeArtifacts.value)]
    .sort(compareArtifactsByRecency),
);
const showInputSelector = computed(() => inputArtifacts.value.length > 1);

const nodePromptSnapshots = computed(() =>
  (props.promptSnapshots ?? [])
    .filter((snapshot) => snapshot.nodeId === props.nodeState.nodeId)
    .sort(comparePromptSnapshotsByRecency),
);
const nodePromptSnapshotIds = computed(() =>
  Array.from(new Set((props.nodeState.promptSnapshotIds ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))),
);

watch(availableOutputArtifacts, (artifacts) => {
  if (!artifacts.length) {
    selectedOutputArtifactId.value = null;
    return;
  }
  if (!artifacts.some((artifact) => artifact.id === selectedOutputArtifactId.value)) {
    selectedOutputArtifactId.value = artifacts[0]?.id ?? null;
    showOutputRaw.value = false;
  }
}, { immediate: true });

watch(inputArtifacts, (artifacts) => {
  if (!artifacts.length) {
    selectedInputArtifactId.value = null;
    return;
  }
  if (!artifacts.some((artifact) => artifact.id === selectedInputArtifactId.value)) {
    selectedInputArtifactId.value = artifacts[0]?.id ?? null;
    showInputRaw.value = false;
  }
}, { immediate: true });

watch(nodePromptSnapshots, (snapshots) => {
  if (!snapshots.length) {
    selectedPromptSnapshotId.value = null;
    promptSnapshotManuallySelected.value = false;
    return;
  }
  const latestSnapshotId = snapshots[0]?.id ?? null;
  if (!snapshots.some((snapshot) => snapshot.id === selectedPromptSnapshotId.value)) {
    selectedPromptSnapshotId.value = latestSnapshotId;
    promptSnapshotManuallySelected.value = false;
    return;
  }
  if (!promptSnapshotManuallySelected.value && selectedPromptSnapshotId.value !== latestSnapshotId) {
    selectedPromptSnapshotId.value = latestSnapshotId;
  }
}, { immediate: true });

watch(nodePromptSnapshotIds, (ids) => {
  if (nodePromptSnapshots.value.length || selectedPromptSnapshotId.value || ids.length === 0) return;
  selectedPromptSnapshotId.value = ids[ids.length - 1] ?? null;
}, { immediate: true });

const selectedOutputArtifact = computed(() =>
  availableOutputArtifacts.value.find((artifact) => artifact.id === selectedOutputArtifactId.value)
  ?? availableOutputArtifacts.value[0]
  ?? null,
);
const selectedOutputArtifactFields = computed(() => {
  const artifactId = selectedOutputArtifact.value?.id;
  if (!artifactId) return [] as NodeResultField[];
  return artifactFieldsByArtifactId.value[artifactId] ?? [];
});
const selectedOutputFields = computed(() => collectArtifactOutputFields(selectedOutputArtifact.value, selectedOutputArtifactFields.value));

const selectedInputArtifact = computed(() =>
  inputArtifacts.value.find((artifact) => artifact.id === selectedInputArtifactId.value)
  ?? inputArtifacts.value[0]
  ?? null,
);

const selectedPromptSnapshot = computed(() =>
  nodePromptSnapshots.value.find((snapshot) => snapshot.id === selectedPromptSnapshotId.value)
  ?? nodePromptSnapshots.value[0]
  ?? null,
);
const latestNodePromptSnapshotId = computed(() =>
  selectedPromptSnapshot.value?.id
  ?? selectedPromptSnapshotId.value
  ?? nodePromptSnapshotIds.value[nodePromptSnapshotIds.value.length - 1]
  ?? null,
);
const selectedPromptSnapshotLoaded = computed(() => Boolean(selectedPromptSnapshot.value && selectedPromptSnapshot.value.contentLoaded !== false));
const hasPromptSnapshotReference = computed(() => Boolean(selectedPromptSnapshot.value || latestNodePromptSnapshotId.value));
const currentThreadId = computed(() => String(props.nodeState.threadId ?? "").trim());
const previousThreadIds = computed(() =>
  Array.from(new Set((props.nodeState.previousThreadIds ?? []).map((item) => String(item ?? "").trim()).filter(Boolean))),
);
const selectedRoleRevision = computed<RoleExecutionRevision | null>(() =>
  selectedPromptSnapshot.value?.promptEnvelope?.meta?.roleExecutionRevision
  ?? selectedPromptSnapshot.value?.roleExecutionRevision
  ?? null,
);
const promptModalMessages = computed<PromptModalMessage[]>(() => {
  const snapshot = selectedPromptSnapshot.value;
  if (!snapshot || snapshot.contentLoaded === false) return [];
  const messages: PromptModalMessage[] = [
    { key: "system", label: "系统规则", content: snapshot.systemMessage },
  ];
  if (snapshot.developerMessage) {
    messages.push({ key: "developer", label: "运行补充规则", content: snapshot.developerMessage });
  }
  messages.push({ key: "user", label: "任务内容", content: snapshot.userMessage });
  return messages;
});
const activePromptModalMessage = computed(() =>
  promptModalMessages.value.find((item) => item.key === promptModalTab.value)
  ?? promptModalMessages.value[0]
  ?? null,
);
const hasHeaderActions = computed(() => Boolean(slots["header-actions"]));
const isAwaitingHumanAction = computed(() =>
  props.nodeState.status === "waiting-start" || props.nodeState.status === "waiting-approval" || props.nodeState.status === "waiting-feedback",
);
const workbench = computed(() => resolveNodeWorkbenchDescriptor(props.nodeState));
const headerAttentionLabel = computed(() =>
  workbench.value.attentionKind ? workbench.value.detailLabel ?? workbench.value.statusLabel : null,
);
const headerAttentionTone = computed<"warning" | "danger">(() =>
  workbench.value.attentionKind === "execution_error" ? "danger" : "warning",
);
const showHeaderAttentionNote = computed(() =>
  props.showAttentionNote !== false && Boolean(headerAttentionLabel.value),
);
/** 控制节点只负责流程调度，结果空态应说明职责而不是暗示产出缺失。 */
const emptyResultMessage = computed(() => {
  switch (props.node?.type) {
    case "start":
      return "开始节点用于启动流程，本身不产生交付结果。";
    case "end":
      return "结束节点用于标记流程完成，本身不产生交付结果。";
    case "condition":
      return "条件分支节点用于选择后续路径，本身不产生交付结果。";
    case "parallel-fork":
      return "并行分叉节点用于启动多条并行分支，本身不产生交付结果。";
    case "parallel-join":
      return "并行汇合节点用于等待并汇合并行分支，本身不产生交付结果。";
    default:
      return "当前节点还没有产出可展示的结果。";
  }
});
const conclusion = computed(() => props.nodeState.conclusion ?? null);
const conclusionButtonTone = computed(() => conclusionVerdictTone(conclusion.value?.reviewVerdict));
const evaluatedAcceptanceChecks = computed(() =>
  (conclusion.value?.acceptanceChecks ?? []).filter((check) => check.verdict === "pass" || check.verdict === "fail"),
);
const workflowNodeLabelById = computed<Record<string, string>>(() =>
  Object.fromEntries(
    (props.workflowNodes ?? [])
      .map((workflowNode) => {
        const nodeId = String(workflowNode.id ?? "").trim();
        const label = String(workflowNode.label ?? "").trim() || nodeId;
        return [nodeId, label] as const;
      })
      .filter(([nodeId]) => Boolean(nodeId)),
  ),
);
const conclusionReworkTargetLabel = computed(() => resolveWorkflowNodeLabel(conclusion.value?.rework?.targetNodeId));

const selectedOutputArtifactFiles = computed(() => {
  const artifactId = selectedOutputArtifact.value?.id;
  if (!artifactId) return [] as ArtifactFileEntry[];
  return artifactFilesByArtifactId.value[artifactId] ?? [];
});
const selectedInputArtifactFiles = computed(() => {
  const artifactId = selectedInputArtifact.value?.id;
  if (!artifactId) return [] as ArtifactFileEntry[];
  return artifactFilesByArtifactId.value[artifactId] ?? [];
});
const selectedOutputPresentation = computed(() =>
  buildArtifactPresentation(selectedOutputArtifact.value, selectedOutputArtifactFiles.value),
);
const compareBaseArtifacts = computed(() => {
  const current = selectedOutputArtifact.value;
  if (!current) return [] as Artifact[];
  return (props.artifacts ?? [])
    .filter((artifact) => artifact.nodeId === current.nodeId && artifact.kind === current.kind && artifact.version < current.version)
    .sort(compareArtifactsByRecency);
});
const compareBaseArtifact = computed(() =>
  compareBaseArtifacts.value.find((artifact) => artifact.id === compareBaseArtifactId.value)
  ?? compareBaseArtifacts.value[0]
  ?? null,
);
const compareBaseArtifactFiles = computed(() => {
  const artifactId = compareBaseArtifact.value?.id;
  if (!artifactId) return [] as ArtifactFileEntry[];
  return artifactFilesByArtifactId.value[artifactId] ?? [];
});
const compareBasePresentation = computed(() =>
  buildArtifactPresentation(compareBaseArtifact.value, compareBaseArtifactFiles.value),
);
const comparePendingArtifact = computed(() =>
  artifactPreviewLoading(selectedOutputArtifact.value) || artifactPreviewError(selectedOutputArtifact.value)
    ? selectedOutputArtifact.value
    : artifactPreviewLoading(compareBaseArtifact.value) || artifactPreviewError(compareBaseArtifact.value)
      ? compareBaseArtifact.value
      : null,
);
const compareModalFullscreenTitle = computed(() => compareModalFullscreen.value ? "还原节点产出版本对比" : "全屏查看节点产出版本对比");
const compareModalWidth = computed(() => compareModalFullscreen.value ? "100vw" : 1320);
const compareModalBodyStyle = computed(() =>
  compareModalFullscreen.value
    ? { padding: "16px 20px", height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" }
    : { padding: "16px 20px", height: "min(74dvh, calc(100dvh - 140px))", overflow: "hidden" });
const compareModalWrapClassName = computed(() =>
  compareModalFullscreen.value
    ? "node-detail__compare-modal-wrap node-detail__compare-modal-wrap--fullscreen"
    : "node-detail__compare-modal-wrap");
const outputGitDiffModalFullscreenTitle = computed(() => outputGitDiffModalFullscreen.value ? "还原交付物 Git 差异" : "全屏查看交付物 Git 差异");
const outputGitDiffModalWidth = computed(() => outputGitDiffModalFullscreen.value ? "100vw" : 1320);
const outputGitDiffModalBodyStyle = computed(() =>
  outputGitDiffModalFullscreen.value
    ? { padding: "16px 20px", height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" }
    : { padding: "16px 20px", maxHeight: "calc(100vh - 140px)", overflowY: "auto" });
const outputGitDiffModalWrapClassName = computed(() =>
  outputGitDiffModalFullscreen.value
    ? "node-detail__git-diff-modal-wrap node-detail__git-diff-modal-wrap--fullscreen"
    : "node-detail__git-diff-modal-wrap");
const selectedInputPresentation = computed(() =>
  buildArtifactPresentation(selectedInputArtifact.value, selectedInputArtifactFiles.value),
);
const activeOutputPreview = computed(() => {
  if (!selectedOutputPresentation.value.files.length) return selectedOutputPresentation.value;
  return selectedOutputPresentation.value.files.find((file) => file.filePath === selectedOutputPreviewPath.value)
    ?? selectedOutputPresentation.value.files[0]
    ?? selectedOutputPresentation.value;
});
const activeOutputField = computed(() => {
  const fieldKey = selectedOutputFieldKey.value;
  if (!fieldKey) return null;
  return selectedOutputFields.value.find((field) => field.key === fieldKey) ?? null;
});
const activeOutputGitChange = computed(() => {
  if (activeOutputField.value || revisionEditorOpen.value) return null;
  return resolveOutputPreviewGitChange(activeOutputPreview.value);
});
const activeOutputGitDiffModes = computed<OutputGitDiffMode[]>(() => {
  const change = activeOutputGitChange.value;
  if (!change) return [];
  const modes: OutputGitDiffMode[] = [];
  if (change.scopes.includes("unstaged") || change.scopes.includes("untracked")) modes.push("unstaged");
  if (change.scopes.includes("staged")) modes.push("staged");
  return modes;
});
const activeInputPreview = computed(() => {
  if (!selectedInputPresentation.value.files.length) return selectedInputPresentation.value;
  return selectedInputPresentation.value.files.find((file) => file.filePath === selectedInputPreviewPath.value)
    ?? selectedInputPresentation.value.files[0]
    ?? selectedInputPresentation.value;
});
const compareBasePreview = computed(() => resolveCompareBasePreview(
  compareBasePresentation.value,
  activeOutputPreview.value.filePath,
));
const compareDiffPayload = computed<ArtifactCompareDiffPayload | null>(() => {
  const basePreview = compareBasePreview.value;
  if (!basePreview) return null;
  if (!isTextDiffablePreview(activeOutputPreview.value) || !isTextDiffablePreview(basePreview)) return null;
  return {
    original: basePreview.content,
    modified: activeOutputPreview.value.content,
    filePath: activeOutputPreview.value.filePath,
  };
});
const compareFallbackReason = computed(() => {
  if (compareDiffPayload.value) return "";
  if (!compareBaseArtifact.value) return "";
  const basePreview = compareBasePreview.value;
  if (!basePreview) return "所选对比版本没有同路径文件，暂时只能并排查看。";
  if (isImageArtifactPath(activeOutputPreview.value.filePath) || isImageArtifactPath(basePreview.filePath)) {
    return "图片类产出暂不支持文本 diff，已回退到并排预览。";
  }
  if (isDocumentArtifactPath(activeOutputPreview.value.filePath) || isDocumentArtifactPath(basePreview.filePath)) {
    return "文档类产出暂不支持文本 diff，已回退到并排预览。";
  }
  if (isSpreadsheetArtifactPath(activeOutputPreview.value.filePath) || isSpreadsheetArtifactPath(basePreview.filePath)) {
    return "表格类产出暂不支持文本 diff，已回退到并排预览。";
  }
  return "当前产出内容暂不支持文本 diff，已回退到并排预览。";
});
const outputPreviewItems = computed(() => {
  if (selectedOutputPresentation.value.files.length) return selectedOutputPresentation.value.files;
  return [{
    filePath: selectedOutputPresentation.value.filePath,
    content: selectedOutputPresentation.value.content,
    renderMode: selectedOutputPresentation.value.renderMode,
    workspacePreviewPath: selectedOutputPresentation.value.workspacePreviewPath,
    fileRole: selectedOutputPresentation.value.fileRole ?? "contract",
    fileKey: selectedOutputPresentation.value.fileKey ?? null,
    summary: selectedOutputPresentation.value.summary ?? null,
    format: selectedOutputPresentation.value.format ?? null,
  }];
});
const outputPreviewWorkspaceGitPaths = computed(() =>
  Array.from(new Set(
    outputPreviewItems.value
      .map((file) => outputPreviewWorkspaceGitPath(file))
      .filter((path): path is string => Boolean(path)),
  )).sort(),
);
const outputNavigatorItems = computed<OutputFileNavigatorItem[]>(() => {
  if (revisionEditorOpen.value && revisionDraft.value?.mode === "file-set") {
    return revisionDraft.value.files.map((file) => {
      const filePath = String(file.path || "未命名文件");
      return {
        kind: "file",
        key: file.id,
        filePath,
        gitPath: "",
        renderMode: inferArtifactRenderMode(filePath),
        draftFileId: file.id,
        isDraft: true,
        fileRole: "contract",
        gitChange: null,
      };
    });
  }
  return outputPreviewItems.value.map((file) => ({
    kind: "file",
    key: file.filePath,
    filePath: file.filePath,
    gitPath: outputPreviewWorkspaceGitPath(file),
    renderMode: file.renderMode,
    draftFileId: null,
    isDraft: false,
    fileRole: file.fileRole ?? "contract",
    gitChange: outputGitChangeMap.value[outputPreviewWorkspaceGitPath(file)] ?? null,
  }));
});
const outputFieldNavigatorItems = computed<OutputNavigatorItem[]>(() => {
  if (revisionEditorOpen.value) return [];
  return selectedOutputFields.value.map((field) => ({
    kind: "field",
    key: `field:${field.key}`,
    field,
  }));
});
const outputNavigatorGroups = computed<OutputNavigatorGroup[]>(() => [
  {
    key: "contract",
    label: "交付物",
    items: outputNavigatorItems.value.filter((item) => item.fileRole !== "attachment"),
  },
  {
    key: "attachment",
    label: "附件",
    items: outputNavigatorItems.value.filter((item) => item.fileRole === "attachment"),
  },
  {
    key: "field",
    label: "输出字段",
    items: outputFieldNavigatorItems.value,
  },
]);
const outputNavigatorSummaryLabel = computed(() => {
  const contractCount = outputNavigatorGroups.value.find((group) => group.key === "contract")?.items.length ?? 0;
  const attachmentCount = outputNavigatorGroups.value.find((group) => group.key === "attachment")?.items.length ?? 0;
  const fieldCount = outputNavigatorGroups.value.find((group) => group.key === "field")?.items.length ?? 0;
  const parts = [`交付物 ${contractCount}`];
  if (attachmentCount) parts.push(`附件 ${attachmentCount}`);
  if (fieldCount) parts.push(`字段 ${fieldCount}`);
  return parts.join(" · ");
});
const selectedOutputRevisionCaption = computed(() =>
  selectedOutputArtifact.value ? formatArtifactRevisionCaption(selectedOutputArtifact.value) : null,
);
const canReviseSelectedOutputArtifact = computed(() =>
  Boolean(
    !activeOutputField.value
    && isAwaitingHumanAction.value
    && props.node
    && selectedOutputArtifact.value
    && !artifactPreviewLoading(selectedOutputArtifact.value)
    && !artifactPreviewError(selectedOutputArtifact.value)
    && selectedOutputArtifact.value.status !== "rejected"
    && selectedOutputArtifact.value.status !== "superseded",
  ),
);
const selectedRevisionDraftFile = computed<EditableArtifactFileDraft | null>(() => {
  const draft = revisionDraft.value;
  if (!draft) return null;
  if (draft.mode === "file") return draft.file;
  if (draft.mode !== "file-set") return null;
  return draft.files.find((file) => file.id === revisionDraftFileId.value) ?? draft.files[0] ?? null;
});
const selectedOutputEditableMode = computed<EditableArtifactDraft["mode"] | null>(() => {
  const artifact = selectedOutputArtifact.value;
  if (!artifact) return null;
  return buildEditableArtifactDraft(artifact).mode;
});
const canAddRevisionFile = computed(() => {
  if (activeOutputField.value) return false;
  if (!canReviseSelectedOutputArtifact.value) return false;
  if (revisionDraft.value?.mode === "file-set") return true;
  return !revisionEditorOpen.value && selectedOutputEditableMode.value === "file-set";
});
const canDeleteRevisionFile = computed(() =>
  revisionDraft.value?.mode === "file-set" && revisionDraft.value.files.length > 1 && Boolean(selectedRevisionDraftFile.value),
);
const revisionHelpLines = computed(() => {
  const lines = [
    "保存修订会生成整份交付产出的新版本，不是按单个文件分别记版本。",
    "多文件产出里，即使只改了一个文件，保存后形成的也是这整份交付的下一版。",
    "审核通过或后续重跑时，系统都会默认使用最新交付件。",
  ];
  if (selectedOutputEditableMode.value === "file-set") {
    lines.unshift("当前是多文件交付，可以直接新增文件、删除当前文件，或修改任意一个文件正文。");
  }
  return lines;
});

watch(selectedOutputPresentation, (presentation) => {
  selectedOutputPreviewPath.value = resolvePreviewPath(presentation, selectedOutputPreviewPath.value);
}, { immediate: true });

watch(selectedOutputFields, (fields) => {
  if (selectedOutputFieldKey.value && !fields.some((field) => field.key === selectedOutputFieldKey.value)) {
    selectedOutputFieldKey.value = null;
  }
});

watch(selectedInputPresentation, (presentation) => {
  selectedInputPreviewPath.value = resolvePreviewPath(presentation, selectedInputPreviewPath.value);
}, { immediate: true });

watch(
  () => [selectedOutputArtifact.value?.id ?? null, compareBaseArtifacts.value.map((artifact) => artifact.id).join("|")] as const,
  () => {
    const versions = compareBaseArtifacts.value;
    if (!versions.length) {
      compareBaseArtifactId.value = null;
      compareModalFullscreen.value = false;
      compareModalOpen.value = false;
      return;
    }
    if (!versions.some((artifact) => artifact.id === compareBaseArtifactId.value)) {
      compareBaseArtifactId.value = versions[0]?.id ?? null;
    }
  },
  { immediate: true },
);

watch([() => props.workspaceId, () => props.instanceId, () => props.nodeState.nodeId], () => {
  showConclusionPopover.value = false;
  workItemsPopoverOpen.value = false;
  workItemSearchDraft.value = "";
  workItemSearch.value = "";
  workItemRequestSeq += 1;
  workItemEventRequestSeq += 1;
  workItems.value = [];
  workItemSummary.value = null;
  workItemsLoading.value = false;
  workItemsLoadingMore.value = false;
  workItemsError.value = null;
  workItemsHasMore.value = false;
  workItemsNextCursor.value = null;
  selectedWorkItemId.value = null;
  selectedWorkItemEvents.value = [];
  workItemEventsLoading.value = false;
  workItemEventsError.value = null;
  selectedOutputArtifactId.value = availableOutputArtifacts.value[0]?.id ?? null;
  selectedOutputPreviewPath.value = null;
  selectedOutputFieldKey.value = null;
  showOutputRaw.value = false;
  compareModalFullscreen.value = false;
  compareModalOpen.value = false;
  inputDetailsOpen.value = false;
});

watch([() => props.workspaceId, () => props.instanceId], () => {
  artifactPreviewGeneration += 1;
  artifactPreviewStates.value = {};
  artifactFilesByArtifactId.value = {};
  artifactFieldsByArtifactId.value = {};
}, { flush: "sync" });

watch(selectedWorkItemId, () => {
  void refreshSelectedWorkItemEvents();
});

watch(activeView, () => {
  showConclusionPopover.value = false;
});

watch(conclusion, (value) => {
  if (!value) showConclusionPopover.value = false;
});

watch(() => selectedOutputArtifact.value?.id ?? null, (artifactId, previousArtifactId) => {
  if (artifactId !== previousArtifactId) selectedOutputFieldKey.value = null;
  if (!artifactId || !revisionEditorOpen.value) return;
  if (artifactId === previousArtifactId) return;
  const artifact = selectedOutputArtifact.value;
  if (!artifact) return;
  initializeRevisionDraft(artifact);
});

watch(
  () => [
    props.workspaceId,
    props.instanceId,
    selectedOutputArtifact.value,
    activeView.value === "debug" && inputDetailsOpen.value ? selectedInputArtifact.value : null,
    compareModalOpen.value ? compareBaseArtifact.value : null,
  ] as const,
  ([_workspaceId, _instanceId, outputArtifact, inputArtifact, compareArtifact]) => {
    for (const artifactId of new Set([outputArtifact?.id, inputArtifact?.id, compareArtifact?.id])) {
      void loadArtifactPreview(artifactId ?? null);
    }
  },
  { immediate: true },
);

watch(
  () => [
    props.workspaceId,
    activeView.value,
    outputPreviewWorkspaceGitPaths.value.join("|"),
  ] as const,
  () => {
    scheduleOutputGitStatusRefresh();
  },
  { immediate: true },
);

/** 结果视图可见且路径稳定时才调度 Git 状态刷新，避免隐藏面板和抖动路径重复请求。 */
function scheduleOutputGitStatusRefresh(): void {
  clearOutputGitStatusRefreshTimer();
  if (activeView.value !== "result") {
    outputGitStatusLoading.value = false;
    outputGitStatusRefreshQueued = false;
    return;
  }
  if (!outputPreviewWorkspaceGitPaths.value.length) {
    outputGitStatusError.value = null;
    outputGitStatusLoading.value = false;
    outputGitStatusRefreshQueued = false;
    outputGitChangeMap.value = {};
    return;
  }
  const scopeKey = buildOutputGitStatusScopeKey(outputPreviewWorkspaceGitPaths.value);
  const cached = outputGitStatusCache;
  if (cached && cached.scopeKey === scopeKey && Date.now() - cached.loadedAt <= OUTPUT_GIT_STATUS_CACHE_TTL_MS) {
    outputGitStatusError.value = null;
    outputGitStatusLoading.value = false;
    outputGitStatusRefreshQueued = false;
    outputGitChangeMap.value = { ...cached.changeMap };
    return;
  }
  outputGitStatusRefreshTimer = setTimeout(() => {
    outputGitStatusRefreshTimer = null;
    if (outputGitStatusLoading.value) {
      outputGitStatusRefreshQueued = true;
      return;
    }
    void refreshOutputGitStatus();
  }, OUTPUT_GIT_STATUS_REFRESH_DEBOUNCE_MS);
}

/** 清理结果视图 Git 状态刷新定时器，避免组件切换后残留请求。 */
function clearOutputGitStatusRefreshTimer(): void {
  if (!outputGitStatusRefreshTimer) return;
  clearTimeout(outputGitStatusRefreshTimer);
  outputGitStatusRefreshTimer = null;
  outputGitStatusRefreshQueued = false;
}

function initializeRevisionDraft(artifact: Artifact) {
  const draft = buildEditableArtifactDraft(artifact);
  revisionDraft.value = draft;
  if (draft.mode === "file-set") {
    const selectedFile = draft.files.find((file) => file.path === activeOutputPreview.value.filePath) ?? draft.files[0] ?? null;
    revisionDraftFileId.value = selectedFile?.id ?? null;
  } else {
    revisionDraftFileId.value = draft.mode === "file" ? draft.file.id : null;
  }
  revisionError.value = null;
}

function openRevisionEditor() {
  if (!selectedOutputArtifact.value) return;
  selectedOutputFieldKey.value = null;
  initializeRevisionDraft(selectedOutputArtifact.value);
  revisionEditorOpen.value = true;
  showOutputRaw.value = false;
}

function closeRevisionEditor() {
  revisionEditorOpen.value = false;
  revisionDraft.value = null;
  revisionDraftFileId.value = null;
  revisionError.value = null;
}

function addRevisionDraftFile() {
  if (revisionDraft.value?.mode !== "file-set") return;
  const next = [...revisionDraft.value.files, createEmptyEditableArtifactFileDraft(revisionDraft.value.files.length)];
  revisionDraft.value = {
    ...revisionDraft.value,
    files: next,
  };
  revisionDraftFileId.value = next[next.length - 1]?.id ?? null;
}

function addRevisionDraftFileFromToolbar() {
  if (!selectedOutputArtifact.value) return;
  if (!revisionEditorOpen.value) {
    openRevisionEditor();
  }
  addRevisionDraftFile();
}

function removeRevisionDraftFile(fileId: string) {
  if (revisionDraft.value?.mode !== "file-set") return;
  if (revisionDraft.value.files.length <= 1) {
    revisionError.value = "至少要保留一个文件";
    return;
  }
  const next = revisionDraft.value.files.filter((file) => file.id !== fileId);
  revisionDraft.value = {
    ...revisionDraft.value,
    files: next,
  };
  if (!next.some((file) => file.id === revisionDraftFileId.value)) {
    revisionDraftFileId.value = next[0]?.id ?? null;
  }
}

async function submitRevision() {
  if (!props.node || !selectedOutputArtifact.value || !revisionDraft.value) return;
  revisionSubmitting.value = true;
  revisionError.value = null;
  try {
    const nextDraft = cloneEditableArtifactDraft(revisionDraft.value);
    const baseDraft = buildEditableArtifactDraft(selectedOutputArtifact.value);
    const submission = buildArtifactRevisionSubmission(nextDraft, { previousDraft: baseDraft });
    const revised = await orch.reviseArtifact(
      ctx.value,
      props.workspaceId,
      props.instanceId,
      props.node.id,
      selectedOutputArtifact.value.id,
      {
        note: buildDefaultArtifactRevisionNote(nextDraft, {
          previousDraft: baseDraft,
          changedFiles: submission.answer.changedFiles ?? null,
        }),
        answer: submission.answer,
        workspaceFiles: submission.workspaceFiles,
      },
    );
    selectedOutputArtifactId.value = revised.id;
    message.success(`已生成新的人工修订版本 v${revised.version}`);
    closeRevisionEditor();
  } catch (error) {
    const nextError = error instanceof Error ? error.message : "保存人工修订失败";
    revisionError.value = nextError;
    message.error(nextError);
  } finally {
    revisionSubmitting.value = false;
  }
}

/** 打开工作项面板时按用户操作读取一次，不跟随运行事件自动刷新。 */
function handleWorkItemsPopoverOpenChange(open: boolean): void {
  workItemsPopoverOpen.value = open;
  if (open) void refreshNodeWorkItems();
}

/** 提交搜索词并按用户操作查询，避免每次按键都发起请求。 */
function applyWorkItemSearch(value: string): void {
  workItemSearch.value = String(value ?? "").trim();
  void refreshNodeWorkItems();
}

/** 清空搜索输入时立即恢复当前状态筛选下的完整列表。 */
function handleWorkItemSearchChange(): void {
  if (!workItemSearchDraft.value.trim() && workItemSearch.value) applyWorkItemSearch("");
}

/** 用户切换状态筛选后重新读取当前列表。 */
function handleWorkItemStatusFilterChange(): void {
  void refreshNodeWorkItems();
}

/** 按用户操作重新加载当前节点的工作项首页。 */
async function refreshNodeWorkItems(): Promise<void> {
  const requestSeq = ++workItemRequestSeq;
  if (!workItemsEnabled.value) {
    workItems.value = [];
    workItemSummary.value = null;
    workItemsHasMore.value = false;
    workItemsNextCursor.value = null;
    selectedWorkItemId.value = null;
    return;
  }
  workItemsLoading.value = true;
  workItemsError.value = null;
  try {
    const response = await listOrchNodeWorkItems(ctx.value, {
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
      nodeId: props.nodeState.nodeId,
      search: workItemSearch.value || null,
      statuses: workItemStatusFilter.value === "all" ? null : [workItemStatusFilter.value],
      includeDeleted: false,
      limit: 100,
      cursor: null,
    });
    if (requestSeq !== workItemRequestSeq) return;
    if (!response.ok) throw new Error(String((response as any).message ?? "读取工作项失败"));
    const payload = response as any;
    workItems.value = Array.isArray(payload.items) ? payload.items : [];
    workItemSummary.value = payload.summary ?? props.nodeState.workItemSummary ?? null;
    workItemsHasMore.value = payload.hasMore === true;
    workItemsNextCursor.value = String(payload.nextCursor ?? "").trim() || null;
    const selectedItemStillVisible = workItems.value.some((item) => item.id === selectedWorkItemId.value);
    if (!selectedItemStillVisible) {
      selectedWorkItemId.value = workItems.value[0]?.id ?? null;
    } else {
      void refreshSelectedWorkItemEvents();
    }
  } catch (error) {
    if (requestSeq !== workItemRequestSeq) return;
    workItemsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestSeq === workItemRequestSeq) workItemsLoading.value = false;
  }
}

/** 追加加载当前筛选下的下一页工作项。 */
async function loadMoreNodeWorkItems(): Promise<void> {
  if (!workItemsNextCursor.value || workItemsLoadingMore.value) return;
  const requestSeq = workItemRequestSeq;
  workItemsLoadingMore.value = true;
  workItemsError.value = null;
  try {
    const response = await listOrchNodeWorkItems(ctx.value, {
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
      nodeId: props.nodeState.nodeId,
      search: workItemSearch.value || null,
      statuses: workItemStatusFilter.value === "all" ? null : [workItemStatusFilter.value],
      includeDeleted: false,
      limit: 100,
      cursor: workItemsNextCursor.value,
    });
    if (requestSeq !== workItemRequestSeq) return;
    if (!response.ok) throw new Error(String((response as any).message ?? "读取更多工作项失败"));
    const payload = response as any;
    const nextItems = Array.isArray(payload.items) ? payload.items as NodeWorkItem[] : [];
    const byId = new Map(workItems.value.map((item) => [item.id, item]));
    for (const item of nextItems) byId.set(item.id, item);
    workItems.value = Array.from(byId.values());
    workItemSummary.value = payload.summary ?? workItemSummary.value;
    workItemsHasMore.value = payload.hasMore === true;
    workItemsNextCursor.value = String(payload.nextCursor ?? "").trim() || null;
  } catch (error) {
    if (requestSeq !== workItemRequestSeq) return;
    workItemsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    workItemsLoadingMore.value = false;
  }
}

/** 读取选中工作项的追加事件，供节点详情审计回看。 */
async function refreshSelectedWorkItemEvents(): Promise<void> {
  const requestSeq = ++workItemEventRequestSeq;
  const itemId = selectedWorkItemId.value;
  selectedWorkItemEvents.value = [];
  workItemEventsError.value = null;
  if (!itemId) return;
  workItemEventsLoading.value = true;
  try {
    const response = await listOrchNodeWorkItemEvents(ctx.value, {
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
      nodeId: props.nodeState.nodeId,
      itemId,
      limit: 100,
      cursor: null,
    });
    if (requestSeq !== workItemEventRequestSeq) return;
    if (!response.ok) throw new Error(String((response as any).message ?? "读取工作项记录失败"));
    selectedWorkItemEvents.value = Array.isArray((response as any).events) ? (response as any).events : [];
  } catch (error) {
    if (requestSeq !== workItemEventRequestSeq) return;
    workItemEventsError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestSeq === workItemEventRequestSeq) workItemEventsLoading.value = false;
  }
}

/** 格式化工作项状态。 */
function workItemStatusLabel(status: NodeWorkItemStatus): string {
  if (status === "completed") return "已完成";
  if (status === "in_progress") return "处理中";
  return "待处理";
}

/** 格式化工作项事件类型。 */
function workItemEventLabel(type: NodeWorkItemEvent["type"]): string {
  const labels: Record<NodeWorkItemEvent["type"], string> = {
    board_created: "建立清单",
    item_created: "创建工作项",
    item_updated: "更新工作项",
    item_started: "开始处理",
    item_reopened: "重新打开",
    item_completed: "完成工作项",
    item_deleted: "删除工作项",
  };
  return labels[type] ?? type;
}

/** 提取工作项事件中最适合人工阅读的摘要。 */
function workItemEventDetail(event: NodeWorkItemEvent): string | null {
  const payload = event.payload ?? {};
  const direct = [payload.reason, payload.resultSummary].map((item) => String(item ?? "").trim()).find(Boolean);
  if (direct) return direct;
  if (Array.isArray(payload.changedFields) && payload.changedFields.length) {
    return `字段：${payload.changedFields.map((item) => String(item)).join("、")}`;
  }
  const clientKey = String(payload.clientKey ?? "").trim();
  return clientKey || null;
}

function formatTime(ts: number | null | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** 优先展示持久化字段索引；摘要正文尚未读取时不生成解析错误。 */
function collectArtifactOutputFields(artifact: Artifact | null, persistedFields: NodeResultField[]): OutputFieldDisplayItem[] {
  if (!artifact) return [];
  if (persistedFields.length) {
    return persistedFields.map((field) => {
      const valueText = formatPersistedOutputFieldValue(field);
      return {
        key: field.fieldKey,
        label: field.label ?? field.fieldKey,
        valueType: field.valueType,
        valuePreview: field.valuePreview?.trim() ? field.valuePreview : previewOutputFieldText(valueText),
        valueText,
        validationStatus: field.validationStatus,
      };
    });
  }
  if (!String(artifact.contentJson ?? "").trim()) return [];
  const parsed = parseArtifactContentJson(artifact);
  if (parsed.error) {
    return [{
      key: "__parse_error__",
      label: "字段解析失败",
      valueType: "error",
      valuePreview: parsed.error,
      valueText: parsed.error,
      validationStatus: "invalid",
    }];
  }
  const envelope = parsed.value;
  const values = new Map<string, unknown>();
  if (isRecord(envelope?.fields)) {
    for (const [key, value] of Object.entries(envelope.fields)) values.set(key, value);
  }
  if (values.size === 0 && envelope?.mode === "structured" && isRecord(envelope.data)) {
    for (const [key, value] of Object.entries(envelope.data)) values.set(key, value);
  }
  if (values.size === 0) return [];
  return Array.from(values.entries()).map(([key, value]) => {
    const valueText = formatOutputFieldValue(value);
    return {
      key,
      label: key,
      valueType: inferOutputFieldValueType(value),
      valuePreview: previewOutputFieldText(valueText),
      valueText,
      validationStatus: resolveOutputFieldValidationStatus(artifact, key),
    };
  });
}

/** 反序列化字段索引值用于详情展示；解析失败时把错误展示出来。 */
function formatPersistedOutputFieldValue(field: NodeResultField): string {
  try {
    return formatOutputFieldValue(JSON.parse(field.valueJson));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `字段值解析失败：${reason}`;
  }
}

/** 解析 artifact.contentJson；失败时返回可展示错误而不是静默吞掉。 */
function parseArtifactContentJson(artifact: Artifact): { value: any | null; error: string | null } {
  try {
    return { value: JSON.parse(String(artifact.contentJson ?? "null")), error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { value: null, error: `结果内容不是合法 JSON：${reason}` };
  }
}

/** 从 artifact metadata 中读取字段校验状态，缺失时回退为空。 */
function resolveOutputFieldValidationStatus(artifact: Artifact, fieldKey: string): string | null {
  const report = (artifact.metadata as any)?.nodeResult?.validationReport;
  const results = Array.isArray(report?.fieldResults) ? report.fieldResults : [];
  const matched = results.find((item: any) => String(item?.fieldKey ?? "") === fieldKey);
  return matched?.status ? String(matched.status) : null;
}

/** 推断展示用字段类型，不反推角色契约。 */
function inferOutputFieldValueType(value: unknown): string {
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value == null) return "null";
  return "json";
}

/** 格式化字段完整值，右侧详情保持字符串原文，JSON 值做缩进。 */
function formatOutputFieldValue(value: unknown): string {
  if (typeof value === "string") return value || "-";
  if (value === undefined) return "-";
  const text = JSON.stringify(value, null, 2);
  return text?.trim() ? text : "-";
}

/** 从完整字段值生成左侧导航短描述。 */
function previewOutputFieldText(text: string): string {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : (normalized || "-");
}

/** 将字段校验状态映射为审核界面可读文案。 */
function outputFieldStatusLabel(status: string | null | undefined): string {
  if (status === "valid") return "已校验";
  if (status === "missing") return "缺失";
  if (status === "invalid") return "无效";
  return "未校验";
}

/** 判断普通对象，避免数组被当成字段映射。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 将角色 revision 以稳定 JSON 展示，便于排查 prompt 快照对应的配置版本。 */
function formatRoleRevision(revision: RoleExecutionRevision | null): string {
  if (!revision) return "";
  return JSON.stringify(revision, null, 2);
}

/** 正文和文件索引并行读取，失败保持可重试状态；旧作用域不得回写当前预览。 */
async function loadArtifactPreview(artifactId: string | null, retry = false): Promise<void> {
  if (!artifactId) return;
  const artifact = (props.artifacts ?? []).find((item) => item.id === artifactId);
  if (!artifact || artifactPreviewStates.value[artifactId]?.loading) return;
  if (!retry && artifactPreviewState(artifact)) return;
  const generation = artifactPreviewGeneration;
  const workspaceId = props.workspaceId;
  const instanceId = props.instanceId;
  const revision = { version: artifact.version, updatedAt: artifact.updatedAt };
  artifactPreviewStates.value[artifactId] = { ...revision, loading: true, error: null };
  delete artifactFilesByArtifactId.value[artifactId];
  delete artifactFieldsByArtifactId.value[artifactId];
  try {
    const [loaded, index] = await Promise.all([
      String(artifact.contentJson ?? "").trim() ? artifact : orch.loadArtifact(ctx.value, workspaceId, artifactId, {
        attachToNodeState: false, loadFiles: false,
      }),
      orch.loadArtifactFiles(ctx.value, workspaceId, artifactId),
    ]);
    if (generation !== artifactPreviewGeneration) return;
    const current = (props.artifacts ?? []).find((item) => item.id === artifactId);
    if (!current || !artifactPreviewState(current)) return;
    if (!loaded || !index) throw new Error("产物正文或文件索引未返回，请重试");
    artifactFilesByArtifactId.value[artifactId] = index.files;
    artifactFieldsByArtifactId.value[artifactId] = index.fields ?? [];
  } catch (error) {
    if (generation !== artifactPreviewGeneration) return;
    const current = (props.artifacts ?? []).find((item) => item.id === artifactId);
    if (!current || !artifactPreviewState(current)) return;
    const reason = error instanceof Error ? error.message : String(error);
    artifactPreviewStates.value[artifactId] = { ...revision, loading: false, error: `加载产物失败：${reason}` };
    const diagnostic = error as { code?: string; requestId?: string; details?: { requestId?: string } } | null;
    console.error("[NodeExecutionDetail] artifact preview failed", {
      errorCode: diagnostic?.code ?? "ORCH_ARTIFACT_PREVIEW_FAILED",
      requestId: diagnostic?.requestId ?? diagnostic?.details?.requestId ?? null,
      workspaceId, instanceId, artifactId, rootCause: reason,
    });
  } finally {
    if (generation === artifactPreviewGeneration) {
      artifactPreviewStates.value[artifactId]!.loading = false;
      const latest = (props.artifacts ?? []).find((item) => item.id === artifactId);
      if (latest && !artifactPreviewState(latest)) void loadArtifactPreview(artifactId);
    }
  }
}

/** 预览状态仅适用于对应版本，目录更新后须重新读取正文和索引。 */
function artifactPreviewState(artifact: Artifact) {
  const state = artifactPreviewStates.value[artifact.id];
  return state?.version === artifact.version && state.updatedAt === artifact.updatedAt ? state : null;
}

/** 摘要尚未补全也属于加载中，不能提前展示正文空态。 */
function artifactPreviewLoading(artifact: Artifact | null): boolean {
  return Boolean(artifact && (artifactPreviewState(artifact)?.loading ?? true));
}

/** 预览失败独立于空内容，保留错误直到用户重试。 */
function artifactPreviewError(artifact: Artifact | null): string | null {
  return artifact ? artifactPreviewState(artifact)?.error ?? null : null;
}

/** 参考输入仅在调试面板展开后读取。 */
function onInputDetailsToggle(event: Event): void {
  inputDetailsOpen.value = (event.currentTarget as HTMLDetailsElement).open;
}

/** 刷新当前交付物引用文件的 Git 状态；状态只用于展示，不写回 artifact。 */
async function refreshOutputGitStatus() {
  if (activeView.value !== "result") {
    outputGitStatusLoading.value = false;
    outputGitStatusRefreshQueued = false;
    return;
  }
  const paths = outputPreviewWorkspaceGitPaths.value;
  const requestSeq = ++outputGitStatusRequestSeq;
  const scopeKey = buildOutputGitStatusScopeKey(paths);
  const cached = outputGitStatusCache;
  outputGitStatusError.value = null;
  if (!paths.length) {
    outputGitChangeMap.value = {};
    outputGitStatusLoading.value = false;
    return;
  }
  if (cached && cached.scopeKey === scopeKey && Date.now() - cached.loadedAt <= OUTPUT_GIT_STATUS_CACHE_TTL_MS) {
    outputGitChangeMap.value = { ...cached.changeMap };
    outputGitStatusLoading.value = false;
    return;
  }
  outputGitChangeMap.value = {};
  outputGitStatusLoading.value = true;
  try {
    const primary = await requestGitStatus(null);
    const statuses: GitStatusResult[] = [primary];
    if (primary.isRepo) {
      const loadedRepos = new Set([primary.repositoryPath ?? ""]);
      const candidateRepos = primary.repositories
        .filter((repo) => repo.path && paths.some((item) => item === repo.path || item.startsWith(`${repo.path}/`)));
      for (const repo of candidateRepos) {
        if (loadedRepos.has(repo.path)) continue;
        statuses.push(await requestGitStatus(repo.path));
        loadedRepos.add(repo.path);
      }
    }
    if (requestSeq !== outputGitStatusRequestSeq) return;
    const changeMap = buildOutputGitChangeMap(statuses);
    outputGitChangeMap.value = changeMap;
    outputGitStatusCache = {
      scopeKey,
      loadedAt: Date.now(),
      changeMap: { ...changeMap },
    };
  } catch (error) {
    if (requestSeq !== outputGitStatusRequestSeq) return;
    const reason = error instanceof Error ? error.message : String(error);
    outputGitStatusError.value = `Git 状态不可用：${reason}`;
    outputGitChangeMap.value = {};
  } finally {
    if (requestSeq === outputGitStatusRequestSeq) {
      outputGitStatusLoading.value = false;
      if (outputGitStatusRefreshQueued) {
        outputGitStatusRefreshQueued = false;
        scheduleOutputGitStatusRefresh();
      }
    }
  }
}

/** 读取单个仓库的 Git 状态，API 失败时显式抛出给 UI 展示。 */
async function requestGitStatus(repositoryPath: string | null): Promise<GitStatusResult> {
  const res = await fetchGitStatus(ctx.value, { workspaceId: props.workspaceId, repositoryPath });
  if (!(res as any).ok) throw new Error((res as any).message || "加载 Git 状态失败");
  return res as GitStatusResult;
}

/** 只把真实 workspace 路径纳入 Git 状态作用域；空路径或伪路径不触发查询。 */
function outputPreviewWorkspaceGitPath(file: ArtifactPresentationFile): string {
  return normalizeWorkspaceRelativePath(file.workspacePreviewPath);
}

/** 生成输出文件 Git 状态缓存键，路径稳定时复用短 TTL 结果。 */
function buildOutputGitStatusScopeKey(paths: string[]): string {
  return JSON.stringify([String(props.workspaceId), paths]);
}

/** 汇总 staged / unstaged / untracked，生成按 workspace 相对路径索引的变更表。 */
function buildOutputGitChangeMap(statuses: GitStatusResult[]): Record<string, OutputGitChange> {
  const map = new Map<string, OutputGitChange>();
  for (const status of statuses) {
    if (!status.isRepo) continue;
    for (const file of status.staged) {
      mergeOutputGitChange(map, file.path, gitStatusCharToChangeKind(file.index), "staged");
    }
    for (const file of status.unstaged) {
      mergeOutputGitChange(map, file.path, gitStatusCharToChangeKind(file.working), "unstaged");
    }
    for (const path of status.untracked) {
      mergeOutputGitChange(map, path, "added", "untracked");
    }
  }
  return Object.fromEntries(map.entries());
}

/** 合并同一路径多种 Git 状态，删除优先级最高，其次新增、重命名、修改。 */
function mergeOutputGitChange(
  map: Map<string, OutputGitChange>,
  rawPath: string,
  kind: OutputGitChangeKind,
  scope: OutputGitChangeScope,
) {
  const path = normalizeWorkspaceRelativePath(rawPath);
  if (!path) return;
  const current = map.get(path);
  if (!current) {
    map.set(path, { path, kind, scopes: [scope] });
    return;
  }
  if (!current.scopes.includes(scope)) current.scopes.push(scope);
  current.kind = pickDominantGitChangeKind(current.kind, kind);
}

/** 将 Git status 字符映射为交付物需要展示的变更类型。 */
function gitStatusCharToChangeKind(statusChar: string | null | undefined): OutputGitChangeKind {
  if (statusChar === "D") return "deleted";
  if (statusChar === "A" || statusChar === "?") return "added";
  if (statusChar === "R") return "renamed";
  return "modified";
}

/** 多状态合并时按更需要用户关注的类型决定主徽标。 */
function pickDominantGitChangeKind(left: OutputGitChangeKind, right: OutputGitChangeKind): OutputGitChangeKind {
  const rank: Record<OutputGitChangeKind, number> = { deleted: 4, added: 3, renamed: 2, modified: 1 };
  return rank[right] > rank[left] ? right : left;
}

/** 从当前 Git 状态表查找文件变化。 */
function resolveOutputPreviewGitChange(file: ArtifactPresentationFile): OutputGitChange | null {
  const path = outputPreviewWorkspaceGitPath(file);
  if (!path) return null;
  return outputGitChangeMap.value[path] ?? null;
}

/** 规范化 workspace 相对路径，避免 Windows 分隔符导致状态匹配失败。 */
function normalizeWorkspaceRelativePath(rawPath: string | null | undefined): string {
  const raw = String(rawPath ?? "").trim().replace(/\\/g, "/");
  if (!raw || /^[a-zA-Z]:/.test(raw) || raw.startsWith("/")) return "";
  const normalized = raw.replace(/^\.\//, "").replace(/\/+/g, "/");
  return normalized === "." ? "" : normalized;
}

/** Git 状态主徽标文案，聚焦用户最关心的新增、修改、删除。 */
function outputGitChangeLabel(change: OutputGitChange): string {
  if (change.kind === "added") return "新增";
  if (change.kind === "deleted") return "删除";
  if (change.kind === "renamed") return "重命名";
  return "修改";
}

/** Git 状态范围说明，区分工作区、暂存区和混合状态。 */
function outputGitChangeScopeLabel(change: OutputGitChange): string {
  if (change.scopes.includes("staged") && (change.scopes.includes("unstaged") || change.scopes.includes("untracked"))) return "暂存+工作区";
  if (change.scopes.includes("staged")) return "暂存区";
  if (change.scopes.includes("untracked")) return "未跟踪";
  return "工作区";
}

/** Git 状态完整说明，用于 hover 和 diff 弹窗标题。 */
function outputGitChangeTitle(change: OutputGitChange): string {
  return `${outputGitChangeScopeLabel(change)}：${outputGitChangeLabel(change)} ${change.path}`;
}

/** 关闭节点产出版本对比弹框并恢复普通窗口尺寸。 */
function closeCompareModal(): void {
  compareModalFullscreen.value = false;
  compareModalOpen.value = false;
}

/** 切换节点产出版本对比弹框全屏状态，保留当前对比版本。 */
function toggleCompareModalFullscreen(): void {
  compareModalFullscreen.value = !compareModalFullscreen.value;
}

/** 打开当前交付文件的 Git 差异弹窗，优先展示未暂存/未跟踪变化。 */
async function openOutputGitDiff(mode?: OutputGitDiffMode) {
  const change = activeOutputGitChange.value;
  if (!change) return;
  const nextMode = mode ?? activeOutputGitDiffModes.value[0] ?? "unstaged";
  outputGitDiffMode.value = nextMode;
  outputGitDiffModalOpen.value = true;
  await loadOutputGitDiff(change.path, nextMode);
}

/** 关闭交付物 Git 差异弹框并恢复普通窗口尺寸。 */
function closeOutputGitDiffModal(): void {
  outputGitDiffModalFullscreen.value = false;
  outputGitDiffModalOpen.value = false;
}

/** 切换交付物 Git 差异弹框全屏状态，保留当前 diff 范围和内容。 */
function toggleOutputGitDiffModalFullscreen(): void {
  outputGitDiffModalFullscreen.value = !outputGitDiffModalFullscreen.value;
}

/** 读取 Git diff；文本 diff 失败时回退到统一 diff 文本，不静默吞错。 */
async function loadOutputGitDiff(path: string, mode: OutputGitDiffMode) {
  const requestSeq = ++outputGitDiffRequestSeq;
  outputGitDiffLoading.value = true;
  outputGitDiffError.value = null;
  outputGitDiffPayload.value = null;
  const staged = mode === "staged";
  try {
    const res = await fetchGitDiffFiles(ctx.value, { workspaceId: props.workspaceId, path, staged });
    if (!(res as any).ok) throw new Error((res as any).message || "加载 Git 文件差异失败");
    if (requestSeq !== outputGitDiffRequestSeq) return;
    outputGitDiffPayload.value = {
      kind: "files",
      path,
      mode,
      original: String((res as any).original ?? ""),
      modified: String((res as any).modified ?? ""),
    };
  } catch (fileError) {
    try {
      const res = await fetchGitDiff(ctx.value, { workspaceId: props.workspaceId, path, staged });
      if (!(res as any).ok) throw new Error((res as any).message || "加载 Git diff 失败");
      if (requestSeq !== outputGitDiffRequestSeq) return;
      const diff = String((res as any).diff ?? "").trim();
      outputGitDiffPayload.value = { kind: "patch", path, mode, diff: diff || "当前文件存在 Git 变化，但 Git 没有返回文本 diff。" };
    } catch (patchError) {
      if (requestSeq !== outputGitDiffRequestSeq) return;
      const firstReason = fileError instanceof Error ? fileError.message : String(fileError);
      const secondReason = patchError instanceof Error ? patchError.message : String(patchError);
      outputGitDiffError.value = `无法展示 Git 差异：${firstReason}；${secondReason}`;
    }
  } finally {
    if (requestSeq === outputGitDiffRequestSeq) {
      outputGitDiffLoading.value = false;
    }
  }
}

/** 切换 Git diff 范围，保留当前弹窗并重新加载对应内容。 */
function selectOutputGitDiffMode(mode: OutputGitDiffMode) {
  const change = activeOutputGitChange.value;
  if (!change || outputGitDiffMode.value === mode) return;
  outputGitDiffMode.value = mode;
  void loadOutputGitDiff(change.path, mode);
}

function outputGitDiffModeLabel(mode: OutputGitDiffMode): string {
  return mode === "staged" ? "暂存区" : "工作区";
}

function compareArtifactsByRecency(left: Artifact, right: Artifact): number {
  if (left.version !== right.version) return right.version - left.version;
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  return String(right.id).localeCompare(String(left.id));
}

/** Prompt Snapshot 统一按最新优先展示和默认选中。 */
function comparePromptSnapshotsByRecency(left: NodePromptSnapshot, right: NodePromptSnapshot): number {
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

function artifactTitle(artifact: Artifact): string {
  return artifact.title || artifact.kind;
}

function artifactSummary(artifact: Artifact): string {
  const revisionCaption = formatArtifactRevisionCaption(artifact);
  return [
    artifact.kind,
    `第 ${artifact.version} 版`,
    artifactStatusLabel(artifact.status),
    revisionCaption,
  ].filter(Boolean).join(" · ");
}

function previewFilename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function resolvePreviewPath(presentation: ArtifactPresentation, currentPath: string | null): string | null {
  if (!presentation.files.length) return null;
  if (currentPath && presentation.files.some((file) => file.filePath === currentPath)) {
    return currentPath;
  }
  return presentation.files[0]?.filePath ?? null;
}

/** 按当前文件路径查找所选历史版本的同名文件，避免把不同文件误当作 diff 两端。 */
function resolveCompareBasePreview(
  presentation: ArtifactPresentation,
  currentFilePath: string,
): ArtifactPresentationFile | null {
  if (!presentation.files.length) return presentation;
  return presentation.files.find((file) => file.filePath === currentFilePath) ?? null;
}

/** 只有可直接读取文本内容的产出才进入 Monaco diff；图片等二进制预览走兜底双栏。 */
function isTextDiffablePreview(preview: ArtifactPresentationFile): boolean {
  return !isImageArtifactPath(preview.filePath)
    && !isSpreadsheetArtifactPath(preview.filePath)
    && !isDocumentArtifactPath(preview.filePath);
}

function outputFileBadge(filePath: string): string {
  const fileName = previewFilename(filePath);
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  const normalized = String(ext ?? "").trim().toLowerCase();
  if (!normalized) return "FILE";
  return normalized.slice(0, 4).toUpperCase();
}

function previewKindLabel(preview: ArtifactPresentationFile): string {
  if (isImageArtifactPath(preview.filePath)) return "图片预览";
  if (isSpreadsheetArtifactPath(preview.filePath)) return "表格预览";
  if (isDocumentArtifactPath(preview.filePath)) return "文档预览";
  if (preview.renderMode === "markdown") return "Markdown";
  if (preview.renderMode === "html") return "HTML";
  return "文本 / 原始内容";
}

/** 生成文件导航项的类型说明，字段项不走文件预览逻辑。 */
function outputNavigatorItemKindLabel(item: OutputFileNavigatorItem): string {
  const role = item.fileRole === "attachment" ? "附件" : "交付物";
  return `${role} · ${previewKindLabel(outputNavigatorPreview(item))}`;
}

/** 根据导航项找到实际文件预览，修订草稿只保留路径和渲染模式。 */
function outputNavigatorPreview(item: OutputFileNavigatorItem): ArtifactPresentationFile {
  if (item.isDraft) {
    return {
      filePath: item.filePath,
      content: "",
      renderMode: item.renderMode,
      workspacePreviewPath: null,
      fileRole: item.fileRole,
    };
  }
  return outputPreviewItems.value.find((file) => file.filePath === item.filePath) ?? {
    filePath: item.filePath,
    content: "",
    renderMode: item.renderMode,
    workspacePreviewPath: null,
  };
}

/** 左侧导航徽章统一入口：文件显示后缀，字段显示固定类型。 */
function outputNavigatorItemBadge(item: OutputNavigatorItem): string {
  if (item.kind === "field") return "字段";
  return outputFileBadge(item.filePath);
}

/** 左侧导航标题统一入口，避免模板直接分支访问联合类型字段。 */
function outputNavigatorItemTitle(item: OutputNavigatorItem): string {
  if (item.kind === "field") return item.field.label;
  return previewFilename(item.filePath);
}

/** 左侧导航副标题统一入口，字段只给元信息，不塞长内容。 */
function outputNavigatorItemDescription(item: OutputNavigatorItem): string {
  if (item.kind === "field") {
    return `${item.field.key} · ${item.field.valueType} · ${outputFieldStatusLabel(item.field.validationStatus)}`;
  }
  return outputNavigatorItemKindLabel(item);
}

/** 导航项 hover title 使用路径或短预览，完整字段值只在右侧详情展示。 */
function outputNavigatorItemTitleAttr(item: OutputNavigatorItem): string {
  if (item.kind === "field") return `${item.field.key}: ${item.field.valuePreview}`;
  return item.filePath;
}

/** 选择字段时只切换右侧详情，不影响当前文件路径；选择文件时回到文件预览。 */
function selectOutputNavigatorItem(item: OutputNavigatorItem) {
  if (item.kind === "field") {
    selectedOutputFieldKey.value = item.field.key;
    showOutputRaw.value = false;
    compareModalOpen.value = false;
    return;
  }
  selectedOutputFieldKey.value = null;
  if (item.isDraft && item.draftFileId) {
    revisionDraftFileId.value = item.draftFileId;
    return;
  }
  selectedOutputPreviewPath.value = item.filePath;
}

/** 文件和字段共用导航激活态，但字段激活时不高亮背后的文件。 */
function isOutputNavigatorItemActive(item: OutputNavigatorItem): boolean {
  if (item.kind === "field") return activeOutputField.value?.key === item.field.key;
  if (activeOutputField.value) return false;
  if (item.isDraft) return item.draftFileId === selectedRevisionDraftFile.value?.id;
  return item.filePath === activeOutputPreview.value.filePath;
}

function persistOutputNavCollapsed() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OUTPUT_FILE_NAV_COLLAPSED_STORAGE_KEY, outputFileNavCollapsed.value ? "1" : "0");
  } catch {
    // ignore localStorage write errors
  }
}

function toggleOutputFileNav() {
  outputFileNavCollapsed.value = !outputFileNavCollapsed.value;
  persistOutputNavCollapsed();
}

function initializeOutputFileNavCollapsed() {
  if (typeof window === "undefined") return;
  try {
    const stored = window.localStorage.getItem(OUTPUT_FILE_NAV_COLLAPSED_STORAGE_KEY);
    if (stored === "1" || stored === "0") {
      outputFileNavCollapsed.value = stored === "1";
      return;
    }
  } catch {
    // ignore localStorage read errors
  }
  outputFileNavCollapsed.value = window.innerWidth < 1280;
}

function joinOrDash(values: Array<string | null | undefined> | null | undefined): string {
  const items = (values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
  return items.length ? items.join(", ") : "-";
}

function resolveWorkflowNodeLabel(nodeId: string | null | undefined): string | null {
  const normalizedId = String(nodeId ?? "").trim();
  if (!normalizedId) return null;
  return workflowNodeLabelById.value[normalizedId] ?? normalizedId;
}

function approvalModeLabel(mode: string | null | undefined): string {
  if (mode === "manual") return "人工审核";
  if (mode === "auto") return "自动通过";
  return "跟随需求默认";
}

function nodeStatusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    pending: "等待",
    ready: "就绪",
    queued: "排队",
    running: "运行中",
    "result-submitted": "结果已提交",
    finalizing: "正在收尾",
    "artifact-writing": "保存结果",
    "gate-checking": "门禁检查中",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    completed: "完成",
    failed: "失败",
    skipped: "跳过",
    cancelled: "已取消",
    "waiting-feedback": "等待反馈",
  };
  return map[String(status ?? "")] ?? String(status ?? "-");
}

function nodeTypeLabel(type: string | null | undefined): string {
  const map: Record<string, string> = {
    start: "开始",
    end: "结束",
    role: "角色节点",
    condition: "条件分支",
    "parallel-fork": "并行分叉",
    "parallel-join": "并行汇合",
  };
  return map[String(type ?? "")] ?? String(type ?? "-");
}

function outputModeLabel(mode: string | null | undefined): string {
  if (mode === "file") return "单文件";
  if (mode === "file-set") return "多文件";
  if (mode === "structured") return "结构化结果";
  if (mode === "text") return "文本";
  return "跟随角色默认输出";
}

function persistenceModeLabel(mode: string | null | undefined): string {
  if (mode === "workspace-only") return "只保存到工作区";
  if (mode === "dual-write") return "同时保存到数据库和工作区";
  if (mode === "db-only") return "只保存到数据库";
  return "默认策略";
}

function overwritePolicyLabel(mode: string | null | undefined): string {
  if (mode === "overwrite") return "直接覆盖";
  if (mode === "reject") return "冲突时报错";
  return "生成版本化副本";
}

function artifactStatusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    draft: "草稿",
    approved: "已通过",
    rejected: "已驳回",
    superseded: "已替代",
  };
  return map[String(status ?? "")] ?? String(status ?? "-");
}

function reviewVerdictLabel(verdict: string | null | undefined): string {
  if (verdict === "fail") return "不通过";
  if (verdict === "partial") return "部分满足";
  return "通过";
}

function conclusionVerdictTone(verdict: string | null | undefined): "success" | "warning" | "danger" {
  if (verdict === "fail") return "danger";
  if (verdict === "partial") return "warning";
  return "success";
}

function acceptanceVerdictLabel(verdict: string | null | undefined): string {
  if (verdict === "fail") return "未通过";
  if (verdict === "pass") return "通过";
  return "";
}

function nextActionLabel(nextAction: string | null | undefined): string {
  if (nextAction === "rework") return "退回修改";
  if (nextAction === "ask_human") return "等待人工补充";
  if (nextAction === "stop") return "建议暂停";
  return "继续后续流程";
}

function toggleConclusionPopover() {
  showConclusionPopover.value = !showConclusionPopover.value;
}

/** 打开模型输入预览弹框，并优先按需补齐完整 Prompt Snapshot。 */
async function openPromptModal(tab: PromptModalTab = "user"): Promise<void> {
  if (!(await ensureSelectedPromptSnapshotLoaded())) return;
  const messages = promptModalMessages.value;
  promptModalTab.value = messages.some((item) => item.key === tab) ? tab : messages[0]?.key ?? "user";
  promptModalOpen.value = true;
}

/** 切换 Prompt Snapshot，同时让弹框回到任务内容层。 */
async function selectPromptSnapshotForPreview(snapshotId: string): Promise<void> {
  selectedPromptSnapshotId.value = snapshotId;
  promptSnapshotManuallySelected.value = true;
  promptModalTab.value = "user";
  if (promptModalOpen.value) await ensureSelectedPromptSnapshotLoaded();
}

/** 摘要态 snapshot 不包含完整 prompt 正文，预览前必须按 id 拉取完整内容。 */
async function ensureSelectedPromptSnapshotLoaded(): Promise<boolean> {
  const snapshot = selectedPromptSnapshot.value;
  const promptSnapshotId = snapshot?.id ?? latestNodePromptSnapshotId.value;
  if (!promptSnapshotId || (snapshot && snapshot.contentLoaded !== false)) return true;
  try {
    const loaded = await orch.loadPromptSnapshot(ctx.value, props.workspaceId, promptSnapshotId);
    await nextTick();
    if (!loaded) {
      message.warning("加载 Prompt Snapshot 失败");
      return false;
    }
    selectedPromptSnapshotId.value = loaded.id;
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    message.error(`加载 Prompt Snapshot 失败：${reason}`);
    return false;
  }
}

function handleDocumentPointerDown(event: MouseEvent) {
  if (!showConclusionPopover.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (conclusionPopoverRef.value?.contains(target)) return;
  showConclusionPopover.value = false;
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  showConclusionPopover.value = false;
}

onMounted(() => {
  initializeOutputFileNavCollapsed();
  document.addEventListener("mousedown", handleDocumentPointerDown);
  document.addEventListener("keydown", handleDocumentKeydown);
});

onBeforeUnmount(() => {
  artifactPreviewGeneration += 1;
  clearOutputGitStatusRefreshTimer();
  document.removeEventListener("mousedown", handleDocumentPointerDown);
  document.removeEventListener("keydown", handleDocumentKeydown);
});
</script>

<template>
  <div class="node-detail" :class="{ 'node-detail--fill-height': fillHeight }">
    <div class="node-detail__header">
      <div class="node-detail__header-main">
        <div class="node-detail__headline">
          <div v-if="!hideHeadlineTitle || selectedOutputRevisionCaption || canReviseSelectedOutputArtifact" class="node-detail__headline-title">
            <h4 v-if="!hideHeadlineTitle">{{ node?.label ?? nodeState.nodeId }}</h4>
            <a-popover v-if="selectedOutputRevisionCaption || canReviseSelectedOutputArtifact" trigger="click" placement="bottomLeft" :arrow="false">
              <template #content>
                <div class="node-detail__help-popover">
                  <strong>版本规则说明</strong>
                  <p v-for="line in revisionHelpLines" :key="line">{{ line }}</p>
                </div>
              </template>
              <button type="button" class="node-detail__help-btn" aria-label="查看版本规则说明">
                <QuestionCircleOutlined />
              </button>
            </a-popover>
          </div>
          <div class="node-detail__headline-meta">
            <span>{{ nodeTypeLabel(node?.type) }}</span>
            <span>{{ approvalModeLabel(node?.approvalMode) }}</span>
            <span>状态：{{ workbench.statusLabel }}</span>
            <span>重试：{{ nodeState.retryCount }}</span>
          </div>
        </div>
        <div class="node-detail__meta-line">
          <span>开始：{{ formatTime(nodeState.startedAt) }}</span>
          <span>完成：{{ formatTime(nodeState.completedAt) }}</span>
          <span v-if="selectedOutputArtifact">第 {{ selectedOutputArtifact.version }} 版</span>
          <span v-if="selectedOutputArtifact">{{ artifactStatusLabel(selectedOutputArtifact.status) }}</span>
        </div>
      </div>
      <div class="node-detail__header-actions">
        <div class="node-detail__header-action-group node-detail__header-action-group--summary">
        <div
          v-if="conclusion"
          ref="conclusionPopoverRef"
          class="node-detail__conclusion-popover"
        >
          <button
            type="button"
            class="node-detail__conclusion-button"
            :class="`node-detail__conclusion-button--${conclusionButtonTone}`"
            :aria-expanded="showConclusionPopover ? 'true' : 'false'"
            @click.stop="toggleConclusionPopover"
          >
            结论：{{ reviewVerdictLabel(conclusion.reviewVerdict) }}
          </button>
          <div v-if="showConclusionPopover" class="node-detail__conclusion-panel">
            <div class="node-detail__conclusion-panel-head">
              <strong>业务结论</strong>
              <span>{{ nextActionLabel(conclusion.nextAction) }}</span>
            </div>
            <p class="node-detail__conclusion-summary">{{ conclusion.summary || "未填写结论摘要" }}</p>
            <div class="node-detail__conclusion-meta">
              <span>下一步：{{ nextActionLabel(conclusion.nextAction) }}</span>
              <span v-if="conclusionReworkTargetLabel">退回节点：{{ conclusionReworkTargetLabel }}</span>
              <span v-if="conclusion.rework?.reason">{{ conclusion.rework.reason }}</span>
              <span v-if="conclusion.humanInput?.summary">人工补充：{{ conclusion.humanInput.summary }}</span>
            </div>
            <div v-if="evaluatedAcceptanceChecks.length" class="node-detail__conclusion-checks">
              <div
                v-for="check in evaluatedAcceptanceChecks"
                :key="`${check.criterionId ?? check.label}_${check.verdict}`"
                class="node-detail__conclusion-check"
              >
                <div class="node-detail__conclusion-check-head">
                  <strong>{{ check.label }}</strong>
                  <span
                    class="node-detail__conclusion-check-tag"
                    :class="`node-detail__conclusion-check-tag--${conclusionVerdictTone(check.verdict === 'fail' ? 'fail' : check.verdict === 'pass' ? 'pass' : 'partial')}`"
                  >
                    {{ acceptanceVerdictLabel(check.verdict) }}
                  </span>
                </div>
                <small v-if="check.evidence">{{ check.evidence }}</small>
              </div>
            </div>
          </div>
        </div>
        <a-popover
          v-if="workItemsEnabled"
          :open="workItemsPopoverOpen"
          trigger="click"
          placement="bottomRight"
          :arrow="false"
          @open-change="handleWorkItemsPopoverOpenChange"
        >
          <template #content>
            <section
              class="node-detail__work-items node-detail__work-items-popover"
              aria-label="节点工作项"
              :aria-busy="workItemsLoading"
            >
              <div class="node-detail__work-items-head">
                <div>
                  <h5>工作项</h5>
                  <p v-if="workItemSummary">
                    已完成 {{ workItemSummary.completed }}/{{ workItemSummary.total }}
                    <span v-if="workItemSummary.inProgress"> · 处理中 {{ workItemSummary.inProgress }}</span>
                    <span v-if="workItemSummary.pending"> · 待处理 {{ workItemSummary.pending }}</span>
                  </p>
                  <p v-else>等待工作项清单</p>
                </div>
                <div class="node-detail__work-items-controls">
                  <a-input-search
                    v-model:value="workItemSearchDraft"
                    class="node-detail__work-items-search"
                    aria-label="搜索工作项"
                    placeholder="搜索名称、标识或路径"
                    allow-clear
                    :loading="workItemsLoading"
                    @search="applyWorkItemSearch"
                    @change="handleWorkItemSearchChange"
                  />
                  <label class="node-detail__work-items-filter">
                    <span>状态</span>
                    <select v-model="workItemStatusFilter" @change="handleWorkItemStatusFilterChange">
                      <option value="all">全部</option>
                      <option value="in_progress">处理中</option>
                      <option value="pending">待处理</option>
                      <option value="completed">已完成</option>
                    </select>
                  </label>
                  <a-button
                    class="node-detail__work-items-refresh"
                    :loading="workItemsLoading"
                    aria-label="刷新工作项"
                    @click="refreshNodeWorkItems"
                  >
                    <ReloadOutlined aria-hidden="true" />
                  </a-button>
                </div>
              </div>
              <div class="node-detail__work-items-progress" role="progressbar" :aria-valuenow="workItemSummary?.progressPercent ?? 0" aria-valuemin="0" aria-valuemax="100">
                <span :style="{ width: `${workItemSummary?.progressPercent ?? 0}%` }" />
              </div>
              <div v-if="workItemsError" class="node-detail__work-items-error">{{ workItemsError }}</div>
              <div v-if="workItemsLoading && !workItems.length" class="node-detail__work-items-empty">正在读取工作项...</div>
              <div v-else-if="!workItems.length" class="node-detail__work-items-empty">
                {{ workItemSearch ? "没有匹配的工作项" : "当前筛选下没有工作项" }}
              </div>
              <div v-else class="node-detail__work-items-layout">
                <div class="node-detail__work-items-list">
                  <button
                    v-for="(item, index) in workItems"
                    :key="item.id"
                    type="button"
                    class="node-detail__work-item-row"
                    :class="{ 'node-detail__work-item-row--active': item.id === selectedWorkItemId }"
                    @click="selectedWorkItemId = item.id"
                  >
                    <span class="node-detail__work-item-index">{{ index + 1 }}</span>
                    <span class="node-detail__work-item-main">
                      <strong>{{ item.title }}</strong>
                      <small>
                        {{ item.clientKey }}
                        <template v-if="item.sourceKey"> · {{ item.sourceKey }}</template>
                      </small>
                    </span>
                    <span class="node-detail__work-item-status" :class="`node-detail__work-item-status--${item.status}`">
                      {{ workItemStatusLabel(item.status) }}
                    </span>
                  </button>
                  <button
                    v-if="workItemsHasMore"
                    type="button"
                    class="node-detail__work-items-more"
                    :disabled="workItemsLoadingMore"
                    @click="loadMoreNodeWorkItems"
                  >
                    {{ workItemsLoadingMore ? "正在加载..." : "加载更多" }}
                  </button>
                </div>
                <div class="node-detail__work-item-detail">
                  <template v-if="selectedWorkItem">
                    <div class="node-detail__work-item-detail-head">
                      <div>
                        <strong>{{ selectedWorkItem.title }}</strong>
                        <small>版本 {{ selectedWorkItem.version }} · {{ workItemStatusLabel(selectedWorkItem.status) }}</small>
                      </div>
                      <span>{{ formatTime(selectedWorkItem.updatedAt) }}</span>
                    </div>
                    <dl class="node-detail__work-item-fields">
                      <template v-if="selectedWorkItem.description">
                        <dt>说明</dt><dd>{{ selectedWorkItem.description }}</dd>
                      </template>
                      <template v-if="selectedWorkItem.outputPath">
                        <dt>产出</dt><dd><code>{{ selectedWorkItem.outputPath }}</code></dd>
                      </template>
                      <template v-if="selectedWorkItem.resultSummary">
                        <dt>结果</dt><dd>{{ selectedWorkItem.resultSummary }}</dd>
                      </template>
                      <template v-if="selectedWorkItem.evidence.length">
                        <dt>证据</dt>
                        <dd class="node-detail__work-item-evidence">
                          <code v-for="entry in selectedWorkItem.evidence" :key="entry">{{ entry }}</code>
                        </dd>
                      </template>
                    </dl>
                    <div class="node-detail__work-item-events">
                      <h6>变更记录</h6>
                      <div v-if="workItemEventsLoading" class="node-detail__work-items-empty">正在读取记录...</div>
                      <div v-else-if="workItemEventsError" class="node-detail__work-items-error">{{ workItemEventsError }}</div>
                      <div v-else-if="!selectedWorkItemEvents.length" class="node-detail__work-items-empty">暂无记录</div>
                      <div v-else class="node-detail__work-item-event-list">
                        <div v-for="event in selectedWorkItemEvents" :key="event.id" class="node-detail__work-item-event">
                          <span>{{ workItemEventLabel(event.type) }}</span>
                          <small>{{ workItemEventDetail(event) || formatTime(event.createdAt) }}</small>
                          <time>{{ formatTime(event.createdAt) }}</time>
                        </div>
                      </div>
                    </div>
                  </template>
                </div>
              </div>
            </section>
          </template>
          <button
            type="button"
            class="node-detail__header-toggle node-detail__work-items-toggle"
            :class="{ 'node-detail__work-items-toggle--expanded': workItemsPopoverOpen }"
            :aria-expanded="workItemsPopoverOpen"
            :title="workItemsPopoverOpen ? '收起工作项' : '查看工作项'"
          >
            <UnorderedListOutlined aria-hidden="true" />
            <span>工作项</span>
            <strong>{{ workItemProgressLabel }}</strong>
          </button>
        </a-popover>
        <button
          type="button"
          class="node-detail__header-toggle"
          @click="activeView = activeView === 'result' ? 'debug' : 'result'"
        >
          {{ activeView === "result" ? "调试信息" : "查看交付结果" }}
        </button>
        </div>
        <div v-if="hasHeaderActions" class="node-detail__header-action-group node-detail__header-action-group--ops">
          <slot name="header-actions" />
        </div>
      </div>
      <div
        v-if="showHeaderAttentionNote"
        class="node-detail__attention-note"
        :class="`node-detail__attention-note--${headerAttentionTone}`"
      >
        <span class="node-detail__attention-note-label">{{ workbench.attentionKind === "execution_error" ? "当前中断原因" : "当前说明" }}</span>
        <span>{{ headerAttentionLabel }}</span>
      </div>
    </div>

    <div v-if="activeView === 'result'" class="node-detail__view node-detail__view--result">
      <div v-if="selectedOutputArtifact" class="node-detail__preview-card node-detail__preview-card--workspace">
        <div class="node-detail__preview-head node-detail__preview-head--compact">
          <div class="node-detail__preview-actions">
            <button
              v-if="canReviseSelectedOutputArtifact"
              type="button"
              class="node-detail__preview-toggle node-detail__preview-toggle--accent"
              data-testid="artifact-revision-open"
              @click="revisionEditorOpen ? closeRevisionEditor() : openRevisionEditor()"
            >
              {{ revisionEditorOpen ? "取消编辑" : "编辑" }}
            </button>
            <button
              v-if="canAddRevisionFile"
              type="button"
              class="node-detail__preview-toggle"
              data-testid="artifact-revision-add-file"
              @click="addRevisionDraftFileFromToolbar"
            >
              新增文件
            </button>
            <button
              v-if="revisionEditorOpen && canDeleteRevisionFile && selectedRevisionDraftFile"
              type="button"
              class="node-detail__preview-toggle node-detail__preview-toggle--danger"
              @click="removeRevisionDraftFile(selectedRevisionDraftFile.id)"
            >
              删除当前文件
            </button>
            <button
              v-if="!activeOutputField && !revisionEditorOpen && compareBaseArtifacts.length"
              type="button"
              class="node-detail__preview-toggle"
              @click="compareModalOpen = true"
            >
              对比版本
            </button>
            <button
              v-if="activeOutputGitChange && !revisionEditorOpen"
              type="button"
              class="node-detail__preview-toggle"
              :title="outputGitChangeTitle(activeOutputGitChange)"
              @click="openOutputGitDiff()"
            >
              查看 Git 差异
            </button>
            <button
              v-if="!activeOutputField && !revisionEditorOpen && activeOutputPreview.renderMode === 'markdown'"
              type="button"
              class="node-detail__preview-toggle"
              @click="showOutputRaw = !showOutputRaw"
            >
              {{ showOutputRaw ? "渲染预览" : "查看原文" }}
            </button>
            <button
              v-if="revisionEditorOpen"
              type="button"
              class="node-detail__preview-toggle node-detail__preview-toggle--accent"
              data-testid="artifact-revision-submit"
              :disabled="revisionSubmitting"
              @click="submitRevision"
            >
              {{ revisionSubmitting ? "保存中..." : "保存修订" }}
            </button>
          </div>
        </div>
        <div class="node-detail__workspace" :class="{ 'node-detail__workspace--nav-collapsed': outputFileNavCollapsed }">
          <aside class="node-detail__file-nav" :class="{ 'node-detail__file-nav--collapsed': outputFileNavCollapsed }">
            <div class="node-detail__file-nav-head">
              <div v-if="!outputFileNavCollapsed" class="node-detail__file-nav-head-main">
                <strong>{{ outputNavigatorSummaryLabel }}</strong>
                <span
                  v-if="outputGitStatusLoading"
                  class="node-detail__file-nav-status"
                  title="正在读取 Git 状态"
                  aria-label="正在读取 Git 状态"
                >
                  <LoadingOutlined spin />
                </span>
                <span
                  v-else-if="outputGitStatusError"
                  class="node-detail__file-nav-status node-detail__file-nav-status--error"
                  :title="outputGitStatusError"
                  aria-label="Git 状态不可用"
                >
                  <WarningOutlined />
                </span>
              </div>
              <button
                type="button"
                class="node-detail__file-nav-toggle"
                :aria-label="outputFileNavCollapsed ? '展开文件区' : '收起文件区'"
                @click="toggleOutputFileNav"
              >
                {{ outputFileNavCollapsed ? "▶" : "收起 ◀" }}
              </button>
            </div>
            <div v-if="!outputFileNavCollapsed" class="node-detail__file-nav-list">
              <template v-for="group in outputNavigatorGroups" :key="group.key">
                <div v-if="group.items.length" class="node-detail__file-nav-group-title">
                  {{ group.label }}（{{ group.items.length }}）
                </div>
                <button
                  v-for="item in group.items"
                  :key="item.key"
                  type="button"
                  class="node-detail__file-nav-item"
                  :class="{ 'node-detail__file-nav-item--active': isOutputNavigatorItemActive(item) }"
                  :title="outputNavigatorItemTitleAttr(item)"
                  @click="selectOutputNavigatorItem(item)"
                >
                  <span
                    class="node-detail__file-nav-badge"
                    :class="{ 'node-detail__file-nav-badge--field': item.kind === 'field' }"
                  >
                    {{ outputNavigatorItemBadge(item) }}
                  </span>
                  <strong>{{ outputNavigatorItemTitle(item) }}</strong>
                  <small>
                    <span>{{ outputNavigatorItemDescription(item) }}</span>
                    <span
                      v-if="item.kind === 'file' && item.gitChange"
                      class="node-detail__git-status-pill"
                      :class="`node-detail__git-status-pill--${item.gitChange.kind}`"
                      :title="outputGitChangeTitle(item.gitChange)"
                    >
                      {{ outputGitChangeLabel(item.gitChange) }}
                    </span>
                  </small>
                </button>
              </template>
            </div>
          </aside>

          <div class="node-detail__preview-frame node-detail__preview-frame--result">
            <div
              v-if="revisionEditorOpen && revisionDraft"
              class="node-detail__editor"
              data-testid="artifact-revision-editor"
            >
              <div v-if="revisionDraft.mode === 'file' || revisionDraft.mode === 'file-set'" class="node-detail__editor-toolbar">
                <span class="node-detail__editor-toolbar-note">
                  直接修改正文即可，系统会自动生成新版本。
                </span>
              </div>

              <div v-if="revisionError" class="node-detail__revision-error">
                {{ revisionError }}
              </div>

              <textarea
                v-if="revisionDraft.mode === 'text'"
                v-model="revisionDraft.text"
                class="node-detail__editor-textarea"
                data-testid="artifact-revision-text"
                placeholder="直接修订当前文本结果"
              />
              <textarea
                v-else-if="revisionDraft.mode === 'structured'"
                v-model="revisionDraft.jsonText"
                class="node-detail__editor-textarea node-detail__editor-textarea--code"
                data-testid="artifact-revision-json"
                placeholder="请输入合法 JSON"
              />
              <textarea
                v-else-if="revisionDraft.mode === 'file'"
                v-model="revisionDraft.file.content"
                class="node-detail__editor-textarea"
                data-testid="artifact-revision-file-content"
                placeholder="直接修订文件正文"
              />
              <textarea
                v-else-if="selectedRevisionDraftFile"
                v-model="selectedRevisionDraftFile.content"
                class="node-detail__editor-textarea"
                data-testid="artifact-revision-fileset-content"
                placeholder="直接修订文件正文"
              />
            </div>
            <div v-else-if="activeOutputField && !artifactPreviewLoading(selectedOutputArtifact) && !artifactPreviewError(selectedOutputArtifact)" class="node-detail__field-preview">
              <div class="node-detail__field-preview-head">
                <div>
                  <span>输出字段</span>
                  <strong>{{ activeOutputField.label }}</strong>
                </div>
                <code>{{ activeOutputField.key }}</code>
              </div>
              <div class="node-detail__field-preview-meta">
                <span>{{ activeOutputField.valueType }}</span>
                <span>{{ outputFieldStatusLabel(activeOutputField.validationStatus) }}</span>
              </div>
              <pre class="node-detail__field-preview-value">{{ activeOutputField.valueText }}</pre>
            </div>
            <ArtifactFilePreview
              v-else
              :workspace-id="workspaceId"
              :preview="activeOutputPreview"
              :loading="artifactPreviewLoading(selectedOutputArtifact)"
              :error="artifactPreviewError(selectedOutputArtifact)"
              :show-raw-markdown="showOutputRaw"
              empty-markdown-text="*当前结果没有可预览正文*"
              @retry="loadArtifactPreview(selectedOutputArtifact?.id ?? null, true)"
            />
          </div>
        </div>
      </div>

      <div v-else-if="orch.selectedInstanceDetailsLoading" class="node-detail__preview-frame node-detail__preview-frame--result">
        <ArtifactFilePreview :workspace-id="workspaceId" :preview="selectedOutputPresentation" loading />
      </div>
      <div v-else class="node-detail__empty">
        {{ emptyResultMessage }}
      </div>

      <a-modal
        :open="compareModalOpen"
        :footer="null"
        :width="compareModalWidth"
        :body-style="compareModalBodyStyle"
        :wrap-class-name="compareModalWrapClassName"
        destroy-on-close
        @cancel="closeCompareModal"
      >
        <template #title>
          <div class="node-detail__modal-titlebar">
            <span>节点产出版本对比</span>
            <a-tooltip :title="compareModalFullscreenTitle">
              <a-button size="small" type="text" :aria-label="compareModalFullscreenTitle" @click.stop="toggleCompareModalFullscreen">
                <component :is="compareModalFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
              </a-button>
            </a-tooltip>
          </div>
        </template>
        <div
          v-if="selectedOutputArtifact && compareBaseArtifact"
          class="node-detail__compare-modal"
          :class="{ 'node-detail__compare-modal--fullscreen': compareModalFullscreen }"
        >
          <ArtifactFilePreview
            v-if="comparePendingArtifact"
            :workspace-id="workspaceId"
            :preview="compareBasePresentation"
            :loading="artifactPreviewLoading(comparePendingArtifact)"
            :error="artifactPreviewError(comparePendingArtifact)"
            @retry="loadArtifactPreview(comparePendingArtifact.id, true)"
          />
          <template v-else-if="compareDiffPayload">
            <div class="node-detail__compare-diff">
              <div class="node-detail__compare-head node-detail__compare-head--diff">
                <div>
                  <strong>真实差异</strong>
                  <span>
                    第 {{ compareBaseArtifact.version }} 版 · {{ artifactStatusLabel(compareBaseArtifact.status) }}
                    → 第 {{ selectedOutputArtifact.version }} 版 · {{ artifactStatusLabel(selectedOutputArtifact.status) }}
                  </span>
                </div>
                <label class="node-detail__compare-version-control">
                  <span>选择</span>
                  <select v-model="compareBaseArtifactId">
                    <option v-for="artifact in compareBaseArtifacts" :key="artifact.id" :value="artifact.id">
                      第 {{ artifact.version }} 版 · {{ artifactStatusLabel(artifact.status) }}
                    </option>
                  </select>
                </label>
                <code>{{ compareDiffPayload.filePath }}</code>
              </div>
              <div class="node-detail__compare-diff-body">
                <DiffViewer
                  :original="compareDiffPayload.original"
                  :modified="compareDiffPayload.modified"
                  :file-path="compareDiffPayload.filePath"
                  :hide-unchanged="true"
                />
              </div>
            </div>
          </template>

          <template v-else>
            <div v-if="compareFallbackReason" class="node-detail__compare-note">
              {{ compareFallbackReason }}
            </div>
            <div class="node-detail__compare-panes">
              <div class="node-detail__compare-pane">
                <div class="node-detail__compare-head">
                  <strong>当前版本</strong>
                  <span>第 {{ selectedOutputArtifact.version }} 版 · {{ artifactStatusLabel(selectedOutputArtifact.status) }}</span>
                </div>
                <div class="node-detail__compare-body">
                  <ArtifactFilePreview
                    :workspace-id="workspaceId"
                    :preview="activeOutputPreview"
                    :show-raw-markdown="showOutputRaw"
                    empty-markdown-text="*当前结果没有可预览正文*"
                  />
                </div>
              </div>

              <div class="node-detail__compare-pane">
                <div class="node-detail__compare-head">
                  <strong>对比版本</strong>
                  <label class="node-detail__compare-version-control">
                    <span>选择</span>
                    <select v-model="compareBaseArtifactId">
                      <option v-for="artifact in compareBaseArtifacts" :key="artifact.id" :value="artifact.id">
                        第 {{ artifact.version }} 版 · {{ artifactStatusLabel(artifact.status) }}
                      </option>
                    </select>
                  </label>
                </div>
                <div class="node-detail__compare-body">
                  <ArtifactFilePreview
                    v-if="compareBasePreview"
                    :workspace-id="workspaceId"
                    :preview="compareBasePreview"
                    :show-raw-markdown="false"
                    empty-markdown-text="*对比版本没有可预览正文*"
                  />
                  <div v-else class="node-detail__empty">所选对比版本没有同路径文件。</div>
                </div>
              </div>
            </div>
          </template>
        </div>
        <div v-else class="node-detail__empty">当前结果没有历史版本可对比。</div>
      </a-modal>

      <a-modal
        :open="outputGitDiffModalOpen"
        :footer="null"
        :width="outputGitDiffModalWidth"
        :body-style="outputGitDiffModalBodyStyle"
        :wrap-class-name="outputGitDiffModalWrapClassName"
        destroy-on-close
        @cancel="closeOutputGitDiffModal"
      >
        <template #title>
          <div class="node-detail__modal-titlebar">
            <span>交付物 Git 差异</span>
            <a-tooltip :title="outputGitDiffModalFullscreenTitle">
              <a-button size="small" type="text" :aria-label="outputGitDiffModalFullscreenTitle" @click.stop="toggleOutputGitDiffModalFullscreen">
                <component :is="outputGitDiffModalFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
              </a-button>
            </a-tooltip>
          </div>
        </template>
        <div class="node-detail__git-diff-modal" :class="{ 'node-detail__git-diff-modal--fullscreen': outputGitDiffModalFullscreen }">
          <div class="node-detail__git-diff-head">
            <div>
              <strong>{{ activeOutputGitChange ? outputGitChangeLabel(activeOutputGitChange) : "Git 差异" }}</strong>
              <span v-if="activeOutputGitChange">{{ outputGitChangeScopeLabel(activeOutputGitChange) }}</span>
            </div>
            <div class="node-detail__git-diff-actions">
              <button
                v-for="mode in activeOutputGitDiffModes"
                :key="mode"
                type="button"
                class="node-detail__preview-toggle"
                :class="{ 'node-detail__preview-toggle--active': outputGitDiffMode === mode }"
                @click="selectOutputGitDiffMode(mode)"
              >
                {{ outputGitDiffModeLabel(mode) }}
              </button>
            </div>
            <code>{{ outputGitDiffPayload?.path ?? activeOutputGitChange?.path ?? "-" }}</code>
          </div>

          <div v-if="outputGitDiffLoading" class="node-detail__git-diff-loading">
            <a-spin />
            <span>正在加载 Git 差异...</span>
          </div>
          <div v-else-if="outputGitDiffError" class="node-detail__compare-note">
            {{ outputGitDiffError }}
          </div>
          <div v-else-if="outputGitDiffPayload?.kind === 'files'" class="node-detail__git-diff-body">
            <DiffViewer
              :original="outputGitDiffPayload.original"
              :modified="outputGitDiffPayload.modified"
              :file-path="outputGitDiffPayload.path"
              :hide-unchanged="true"
            />
          </div>
          <pre v-else-if="outputGitDiffPayload?.kind === 'patch'" class="node-detail__git-diff-patch">{{ outputGitDiffPayload.diff }}</pre>
          <div v-else class="node-detail__empty">当前文件没有可展示的 Git 差异。</div>
        </div>
      </a-modal>
    </div>

    <div v-else class="node-detail__view">
      <section class="node-detail__debug-summary">
        <div class="node-detail__debug-card node-detail__debug-card--primary">
          <span>当前状态</span>
          <strong>{{ workbench.statusLabel }}</strong>
          <small>重试 {{ nodeState.retryCount }} 次 · {{ nodeTypeLabel(node?.type) }}</small>
        </div>
        <div class="node-detail__debug-card">
          <span>模型输入</span>
          <strong>{{ selectedPromptSnapshotLoaded ? "已记录完整提示词" : hasPromptSnapshotReference ? "已记录提示词元数据" : nodeState.renderedInput ? "已记录任务说明" : "暂无记录" }}</strong>
          <small>{{ selectedPromptSnapshot ? selectedPromptSnapshot.engine + (selectedPromptSnapshot.model ? " · " + selectedPromptSnapshot.model : "") : hasPromptSnapshotReference ? "点击预览后加载完整 Prompt Snapshot" : "Prompt Snapshot 会在节点启动后生成" }}</small>
        </div>
        <div class="node-detail__debug-card">
          <span>参考输入</span>
          <strong>{{ inputArtifacts.length }} 项</strong>
          <small>{{ inputArtifacts.length ? "来自上游节点交付物" : "本节点无上游输入" }}</small>
        </div>
        <div class="node-detail__debug-card">
          <span>交付结果</span>
          <strong>{{ availableOutputArtifacts.length }} 项</strong>
          <small>{{ selectedOutputArtifact ? "第 " + selectedOutputArtifact.version + " 版 · " + artifactStatusLabel(selectedOutputArtifact.status) : "暂未产出" }}</small>
        </div>
      </section>

      <details class="node-detail__fold">
        <summary>节点配置与绑定</summary>
        <div class="node-detail__fold-body">
          <div class="node-detail__config-grid">
            <div class="node-detail__config-card">
              <span>执行会话</span>
              <strong>{{ nodeState.threadId ? "已创建" : "暂无" }}</strong>
              <code v-if="nodeState.threadId">{{ nodeState.threadId }}</code>
            </div>
            <div class="node-detail__config-card">
              <span>绑定角色 ID</span>
              <strong>{{ node?.roleId || "-" }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>失败策略</span>
              <strong>{{ node?.failPolicy || "-" }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>审核方式</span>
              <strong>{{ approvalModeLabel(node?.approvalMode) }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>输出模式</span>
              <strong>{{ outputModeLabel(node?.outputArtifactMode) }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>结果名称</span>
              <strong>{{ node?.outputResultKey || "-" }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>结果保存方式</span>
              <strong>{{ persistenceModeLabel(node?.outputWritePolicy?.persistenceMode) }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>覆盖策略</span>
              <strong>{{ overwritePolicyLabel(node?.outputWritePolicy?.overwritePolicy) }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>工作区基目录</span>
              <strong>{{ node?.outputWritePolicy?.baseDir || "默认目录" }}</strong>
            </div>
            <div class="node-detail__config-card">
              <span>额外知识库</span>
              <strong>{{ joinOrDash(node?.knowledgeOverrideBundleIds) }}</strong>
            </div>
          </div>

          <div v-if="node?.inputBindings?.length" class="node-detail__field">
            <label>输入绑定规则</label>
            <div class="node-detail__binding-list">
              <div v-for="(binding, index) in node.inputBindings" :key="index" class="node-detail__binding-card">
                <strong>#{{ index + 1 }}</strong>
                <span>来源节点：{{ binding.sourceNodeId || "-" }}</span>
                <span>来源结果名称：{{ binding.sourceArtifactKind || "-" }}</span>
                <span>写入字段：{{ binding.targetField || "-" }}</span>
                <span>是否必需：{{ binding.required ? "是" : "否" }}</span>
              </div>
            </div>
          </div>
        </div>
      </details>

      <details v-if="selectedInputArtifact" :open="inputDetailsOpen" class="node-detail__fold" @toggle="onInputDetailsToggle">
        <summary>参考输入（{{ inputArtifacts.length }} 项）</summary>
        <div class="node-detail__fold-body">
          <div class="node-detail__hint">
            这些是系统在执行该节点时带入的上游结果，默认不会和当前交付结果混在一起显示。
          </div>

          <div v-if="showInputSelector" class="node-detail__switcher">
            <button
              v-for="artifact in inputArtifacts"
              :key="artifact.id"
              type="button"
              class="node-detail__switcher-item"
              :class="{ 'node-detail__switcher-item--active': artifact.id === selectedInputArtifact?.id }"
              @click="selectedInputArtifactId = artifact.id"
            >
              <strong>{{ artifactTitle(artifact) }}</strong>
              <small>{{ artifactSummary(artifact) }}</small>
            </button>
          </div>

          <div class="node-detail__preview-card node-detail__preview-card--subtle">
            <div class="node-detail__preview-head">
              <div>
                <h5>{{ artifactTitle(selectedInputArtifact) }}</h5>
                <p>{{ artifactSummary(selectedInputArtifact) }}<template v-if="selectedInputPresentation.files.length"> · {{ selectedInputPresentation.files.length }} 个文件</template></p>
              </div>
              <div class="node-detail__preview-actions">
                <button
                  v-if="activeInputPreview.renderMode === 'markdown'"
                  type="button"
                  class="node-detail__preview-toggle"
                  @click="showInputRaw = !showInputRaw"
                >
                  {{ showInputRaw ? "渲染预览" : "查看原文" }}
                </button>
              </div>
            </div>

            <div v-if="selectedInputPresentation.files.length > 1" class="node-detail__switcher">
              <button
                v-for="file in selectedInputPresentation.files"
                :key="file.filePath"
                type="button"
                class="node-detail__switcher-item"
                :class="{ 'node-detail__switcher-item--active': file.filePath === activeInputPreview.filePath }"
                @click="selectedInputPreviewPath = file.filePath"
              >
                <strong>{{ file.filePath }}</strong>
                <small>{{ previewKindLabel(file) }}</small>
              </button>
            </div>

            <div class="node-detail__preview-frame node-detail__preview-frame--input">
              <ArtifactFilePreview
                :workspace-id="workspaceId"
                :preview="activeInputPreview"
                :loading="artifactPreviewLoading(selectedInputArtifact)"
                :error="artifactPreviewError(selectedInputArtifact)"
                :show-raw-markdown="showInputRaw"
                empty-markdown-text="*当前输入没有可预览正文*"
                @retry="loadArtifactPreview(selectedInputArtifact?.id ?? null, true)"
              />
            </div>
          </div>
        </div>
      </details>

      <details v-if="currentThreadId || previousThreadIds.length" class="node-detail__fold">
        <summary>节点会话</summary>
        <div class="node-detail__fold-body">
          <div v-if="currentThreadId" class="node-detail__field">
            <label>当前会话</label>
            <pre class="node-detail__pre">{{ currentThreadId }}</pre>
          </div>
          <div v-if="previousThreadIds.length" class="node-detail__field">
            <label>历史会话</label>
            <pre class="node-detail__pre">{{ previousThreadIds.join("\n") }}</pre>
          </div>
        </div>
      </details>

      <details v-if="nodeState.renderedInput || hasPromptSnapshotReference" class="node-detail__fold" open>
        <summary>模型输入</summary>
        <div class="node-detail__fold-body">
          <div class="node-detail__prompt-card">
            <div class="node-detail__prompt-card-main">
              <span>发送给模型的信息</span>
              <strong>{{ selectedPromptSnapshotLoaded ? "完整 Prompt Snapshot" : hasPromptSnapshotReference ? "Prompt Snapshot 元数据" : "任务说明" }}</strong>
              <p>
                {{ selectedPromptSnapshotLoaded
                  ? "系统规则、运行补充规则和任务内容已分层保存，点击预览查看完整内容。"
                  : hasPromptSnapshotReference
                    ? "已记录快照索引，点击预览后加载完整内容。"
                  : "当前只记录了发给角色的任务说明，点击预览查看全文。" }}
              </p>
            </div>
            <div class="node-detail__prompt-card-meta">
              <span v-if="selectedPromptSnapshot">第 {{ selectedPromptSnapshot.attemptNo }} 次</span>
              <span v-if="selectedPromptSnapshot">{{ selectedPromptSnapshot.engine }}<template v-if="selectedPromptSnapshot.model"> · {{ selectedPromptSnapshot.model }}</template></span>
              <span v-if="nodePromptSnapshots.length > 1">共 {{ nodePromptSnapshots.length }} 次记录</span>
            </div>
            <button type="button" class="node-detail__preview-toggle node-detail__preview-toggle--accent" @click="openPromptModal('user')">
              预览
            </button>
          </div>

          <div v-if="selectedRoleRevision" class="node-detail__snapshot-section">
            <span>角色执行 revision</span>
            <pre class="node-detail__pre">{{ formatRoleRevision(selectedRoleRevision) }}</pre>
          </div>

          <div v-if="nodePromptSnapshots.length > 1" class="node-detail__snapshot-picker">
            <button
              v-for="snapshot in nodePromptSnapshots"
              :key="snapshot.id"
              type="button"
              class="node-detail__snapshot-chip"
              :class="{ 'node-detail__snapshot-chip--active': snapshot.id === selectedPromptSnapshot?.id }"
              @click="selectPromptSnapshotForPreview(snapshot.id)"
            >
              第 {{ snapshot.attemptNo }} 次 · {{ formatTime(snapshot.createdAt) }}
            </button>
          </div>
        </div>
      </details>

      <details v-if="nodeState.output || nodeState.error || nodeState.gateResults?.length" class="node-detail__fold">
        <summary>执行回执</summary>
        <div class="node-detail__fold-body">
          <div v-if="nodeState.output" class="node-detail__field">
            <label>模型原文</label>
            <pre class="node-detail__pre">{{ nodeState.output }}</pre>
          </div>

          <div v-if="nodeState.error" class="node-detail__field node-detail__field--error">
            <label>{{ workbench.attentionKind === "execution_error" ? "中断原因" : workbench.attentionKind ? "当前原因" : "错误" }}</label>
            <pre class="node-detail__pre">{{ nodeState.error }}</pre>
          </div>

          <div v-if="nodeState.gateResults?.length" class="node-detail__field">
            <label>门禁结果</label>
            <div v-for="gr in nodeState.gateResults" :key="gr.criterionId" class="node-detail__gate-result">
              <span class="node-detail__gate-dot" :style="{ backgroundColor: gr.outcome === 'error' ? '#faad14' : gr.passed ? '#52c41a' : '#ff4d4f' }" />
              <span>{{ gr.criterionId }}：{{ gr.outcome === 'error' ? "评估异常" : gr.passed ? "通过" : "未通过" }} · {{ gr.message }}<template v-if="gr.errorCode"> · {{ gr.errorCode }}</template><template v-if="gr.evaluationCallId"> · 调用 {{ gr.evaluationCallId }}</template></span>
              <ul v-if="gr.evidence?.length" class="node-detail__gate-evidence">
                <li v-for="(evidence, evidenceIndex) in gr.evidence" :key="`${gr.criterionId}-${evidenceIndex}`">
                  “{{ evidence.quote }}”<template v-if="evidence.explanation">（{{ evidence.explanation }}）</template>
                </li>
              </ul>
            </div>
          </div>

          <div v-if="conclusion" class="node-detail__field">
            <label>结构化结论</label>
            <div class="node-detail__gate-result">
              <span class="node-detail__gate-dot" :style="{ backgroundColor: conclusion.reviewVerdict === 'fail' ? '#ff4d4f' : conclusion.reviewVerdict === 'partial' ? '#faad14' : '#52c41a' }" />
              <span>业务结论：{{ reviewVerdictLabel(conclusion.reviewVerdict) }} · 下一步：{{ nextActionLabel(conclusion.nextAction) }}</span>
            </div>
          </div>
        </div>
      </details>
    </div>

    <a-modal
      :open="promptModalOpen"
      title="发送给模型的信息"
      :width="1080"
      :footer="null"
      wrap-class-name="node-detail__prompt-modal-dialog"
      @cancel="promptModalOpen = false"
    >
      <div class="node-detail__prompt-modal">
        <div v-if="selectedPromptSnapshotLoaded && selectedPromptSnapshot" class="node-detail__prompt-modal-head">
          <div>
            <strong>Prompt Snapshot</strong>
            <p>{{ selectedPromptSnapshot.id }}</p>
          </div>
          <div class="node-detail__prompt-modal-meta">
            <span>第 {{ selectedPromptSnapshot.attemptNo }} 次</span>
            <span>{{ formatTime(selectedPromptSnapshot.createdAt) }}</span>
            <span>{{ selectedPromptSnapshot.engine }}<template v-if="selectedPromptSnapshot.model"> · {{ selectedPromptSnapshot.model }}</template></span>
          </div>
        </div>
        <div v-else class="node-detail__prompt-modal-head">
          <div>
            <strong>任务说明</strong>
            <p>当前没有完整 Prompt Snapshot，仅展示节点记录的任务说明。</p>
          </div>
        </div>

        <div v-if="nodePromptSnapshots.length > 1" class="node-detail__snapshot-picker node-detail__snapshot-picker--modal">
          <button
            v-for="snapshot in nodePromptSnapshots"
            :key="snapshot.id"
            type="button"
            class="node-detail__snapshot-chip"
            :class="{ 'node-detail__snapshot-chip--active': snapshot.id === selectedPromptSnapshot?.id }"
            @click="selectPromptSnapshotForPreview(snapshot.id)"
          >
            第 {{ snapshot.attemptNo }} 次
          </button>
        </div>

        <template v-if="selectedPromptSnapshotLoaded">
          <div class="node-detail__prompt-tabs">
            <button
              v-for="messageItem in promptModalMessages"
              :key="messageItem.key"
              type="button"
              class="node-detail__prompt-tab"
              :class="{ 'node-detail__prompt-tab--active': messageItem.key === activePromptModalMessage?.key }"
              @click="promptModalTab = messageItem.key"
            >
              {{ messageItem.label }}
            </button>
          </div>
          <pre class="node-detail__prompt-modal-pre">{{ activePromptModalMessage?.content || "" }}</pre>
        </template>
        <pre v-else class="node-detail__prompt-modal-pre">{{ nodeState.renderedInput }}</pre>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.node-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.node-detail--fill-height {
  height: 100%;
}

.node-detail__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px 16px;
}

.node-detail__header-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.node-detail__headline {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
}

.node-detail__headline-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.node-detail__header h4 {
  margin: 0;
  font-size: 17px;
}

.node-detail__headline-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--app-muted, #666);
  min-width: 0;
}

.node-detail__headline-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--app-accent, #c96442) 18%, var(--app-border, #d9d9d9));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 10%, var(--app-panel-bg, #fff));
  color: var(--app-text, #1f2937);
}

.node-detail__meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: var(--app-muted, #666);
  min-width: 0;
}

.node-detail__meta-line span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-muted, #666) 8%, var(--app-panel-bg, #fff));
  color: var(--app-muted, #666);
}

.node-detail__header-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  justify-self: end;
  align-self: start;
  min-width: 0;
}

.node-detail__header-action-group {
  display: flex;
  flex-wrap: nowrap;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}

.node-detail__header-toggle,
.node-detail__conclusion-button {
  min-width: 0;
  min-height: 32px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 95%, var(--app-bg-secondary, #f5f5f5)), var(--app-bg, #fff));
  color: var(--app-muted, #666);
  padding: 0 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.node-detail__conclusion-popover {
  position: relative;
}

.node-detail__conclusion-button {
  min-width: 118px;
}

.node-detail__work-items-toggle {
  gap: 6px;
  color: #237804;
  border-color: color-mix(in srgb, #52c41a 42%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #52c41a 7%, var(--app-bg, #fff));
}

.node-detail__work-items-toggle:hover,
.node-detail__work-items-toggle--expanded {
  border-color: #52c41a;
  background: color-mix(in srgb, #52c41a 12%, var(--app-bg, #fff));
}

.node-detail__work-items-toggle strong {
  padding-left: 6px;
  border-left: 1px solid color-mix(in srgb, currentColor 28%, transparent);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.node-detail__conclusion-button--success {
  color: #237804;
  border-color: color-mix(in srgb, #52c41a 48%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #52c41a 8%, var(--app-bg, #fff));
}

.node-detail__conclusion-button--warning {
  color: #ad6800;
  border-color: color-mix(in srgb, #faad14 52%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 10%, var(--app-bg, #fff));
}

.node-detail__conclusion-button--danger {
  color: #cf1322;
  border-color: color-mix(in srgb, #ff4d4f 52%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 10%, var(--app-bg, #fff));
}

.node-detail__header-actions :deep(.orch-monitor__action-btn) {
  min-width: 0;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  justify-content: center;
}

.node-detail__header-actions :deep(.orch-monitor__action-btn:hover) {
  transform: none;
}

.node-detail__attention-note {
  grid-column: 1 / -1;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 88%, transparent);
  background: var(--app-bg-secondary, #f5f5f5);
  font-size: 12px;
  line-height: 1.6;
  color: var(--app-text, #222);
}

.node-detail__attention-note-label {
  flex: 0 0 auto;
  font-weight: 600;
  white-space: nowrap;
  color: var(--app-muted, #666);
}

.node-detail__attention-note span:last-child {
  min-width: 0;
}

.node-detail__attention-note--warning {
  border-color: color-mix(in srgb, #faad14 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #faad14 8%, var(--app-bg, #fff));
}

.node-detail__attention-note--danger {
  border-color: color-mix(in srgb, #ff4d4f 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 8%, var(--app-bg, #fff));
}

.node-detail__work-items {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.node-detail__work-items-popover {
  width: min(860px, calc(100vw - 64px));
  max-height: calc(100vh - 120px);
  overflow: auto;
}

.node-detail__work-items-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.node-detail__work-items-head h5,
.node-detail__work-item-events h6 {
  margin: 0;
  color: var(--app-text, #1f2937);
}

.node-detail__work-items-head h5 {
  font-size: 14px;
}

.node-detail__work-items-head p {
  margin: 4px 0 0;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__work-items-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-width: 0;
}

.node-detail__work-items-search {
  width: 260px;
}

.node-detail__work-items-refresh {
  width: 32px;
  height: 32px;
  flex: 0 0 32px;
  padding: 0;
}

.node-detail__work-items-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__work-items-filter select {
  min-width: 112px;
  height: 32px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 6px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  padding: 0 28px 0 10px;
}

.node-detail__work-items-progress {
  width: 100%;
  height: 5px;
  overflow: hidden;
  background: var(--app-bg-secondary, #eef1f4);
}

.node-detail__work-items-progress span {
  display: block;
  height: 100%;
  background: #2f7d5a;
  transition: width 180ms ease;
}

.node-detail__work-items-layout {
  display: grid;
  grid-template-columns: minmax(320px, 1.15fr) minmax(280px, 0.85fr);
  grid-template-rows: minmax(0, 1fr);
  height: 390px;
  min-height: 220px;
  max-height: calc(100vh - 250px);
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 6px;
  overflow: hidden;
}

.node-detail__work-items-list,
.node-detail__work-item-detail {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.node-detail__work-items-list {
  border-right: 1px solid var(--app-border, #e5e7eb);
}

.node-detail__work-item-row {
  width: 100%;
  min-height: 58px;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 64px;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--app-border, #edf0f2);
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  text-align: left;
  cursor: pointer;
}

.node-detail__work-item-row:hover,
.node-detail__work-item-row--active {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 6%, var(--app-bg, #fff));
}

.node-detail__work-item-row--active {
  box-shadow: inset 3px 0 0 var(--app-primary, #1677ff);
}

.node-detail__work-item-index {
  color: var(--app-muted, #667085);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.node-detail__work-item-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.node-detail__work-item-main strong,
.node-detail__work-item-main small {
  min-width: 0;
  overflow-wrap: anywhere;
}

.node-detail__work-item-main strong {
  font-size: 13px;
  line-height: 1.45;
}

.node-detail__work-item-main small {
  color: var(--app-muted, #667085);
  font-size: 11px;
  line-height: 1.35;
}

.node-detail__work-item-status {
  font-size: 11px;
  font-weight: 600;
  text-align: right;
  white-space: nowrap;
  color: var(--app-muted, #667085);
}

.node-detail__work-item-status--in_progress {
  color: #0958d9;
}

.node-detail__work-item-status--completed {
  color: #237804;
}

.node-detail__work-items-more {
  width: 100%;
  min-height: 38px;
  border: 0;
  border-bottom: 1px solid var(--app-border, #edf0f2);
  background: var(--app-bg, #fff);
  color: var(--app-primary, #1677ff);
  cursor: pointer;
}

.node-detail__work-items-more:disabled {
  color: var(--app-muted, #98a2b3);
  cursor: wait;
}

.node-detail__work-item-detail {
  padding: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary, #f5f5f5) 52%, var(--app-bg, #fff));
}

.node-detail__work-item-detail-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.node-detail__work-item-detail-head > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.node-detail__work-item-detail-head strong {
  overflow-wrap: anywhere;
}

.node-detail__work-item-detail-head small,
.node-detail__work-item-detail-head > span {
  color: var(--app-muted, #667085);
  font-size: 11px;
}

.node-detail__work-item-detail-head > span {
  flex: 0 0 auto;
}

.node-detail__work-item-fields {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 8px 10px;
  margin: 16px 0;
  font-size: 12px;
  line-height: 1.55;
}

.node-detail__work-item-fields dt {
  color: var(--app-muted, #667085);
}

.node-detail__work-item-fields dd {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}

.node-detail__work-item-fields code,
.node-detail__work-item-evidence code {
  font-size: 11px;
  overflow-wrap: anywhere;
  white-space: normal;
}

.node-detail__work-item-evidence {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.node-detail__work-item-events {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--app-border, #e5e7eb);
}

.node-detail__work-item-events h6 {
  font-size: 12px;
}

.node-detail__work-item-event-list {
  display: flex;
  flex-direction: column;
}

.node-detail__work-item-event {
  display: grid;
  grid-template-columns: 76px minmax(0, 1fr) auto;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--app-border, #edf0f2);
  font-size: 11px;
}

.node-detail__work-item-event span {
  color: var(--app-text, #1f2937);
  font-weight: 600;
}

.node-detail__work-item-event small,
.node-detail__work-item-event time {
  color: var(--app-muted, #667085);
  overflow-wrap: anywhere;
}

.node-detail__work-item-event time {
  white-space: nowrap;
}

.node-detail__work-items-empty,
.node-detail__work-items-error {
  padding: 12px;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__work-items-error {
  color: #cf1322;
  border-left: 3px solid #ff4d4f;
  background: color-mix(in srgb, #ff4d4f 6%, var(--app-bg, #fff));
}

.node-detail__view {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.node-detail__view--result {
  flex: 1 1 auto;
}

.node-detail__debug-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.node-detail__debug-card {
  min-width: 0;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 96%, #f6f9ff), var(--app-bg, #fff));
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.node-detail__debug-card--primary {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #e8e8e8));
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-primary, #1677ff) 9%, var(--app-bg, #fff)), var(--app-bg, #fff));
}

.node-detail__debug-card span,
.node-detail__prompt-card-main span {
  font-size: 11px;
  color: var(--app-muted, #666);
}

.node-detail__debug-card strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-text, #1f2937);
}

.node-detail__debug-card small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted, #667085);
}

.node-detail__prompt-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 14%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-primary, #1677ff) 6%, var(--app-bg, #fff)), var(--app-bg, #fff));
}

.node-detail__prompt-card-main {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.node-detail__prompt-card-main strong {
  color: var(--app-text, #1f2937);
}

.node-detail__prompt-card-main p {
  margin: 0;
  color: var(--app-muted, #667085);
  font-size: 12px;
  line-height: 1.6;
}

.node-detail__prompt-card-meta,
.node-detail__prompt-modal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__prompt-card-meta {
  justify-content: flex-end;
}
.node-detail--fill-height .node-detail__view--result {
  height: 100%;
}
/* 默认 detail 视图（非 result）在 fill-height 模式下需要自己撑满+滚动，否则会被外层 review-workspace 的 overflow:hidden 截掉长内容 */
.node-detail--fill-height .node-detail__view:not(.node-detail__view--result) {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.node-detail__conclusion-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 12;
  width: min(420px, calc(100vw - 120px));
  max-height: min(48vh, 420px);
  overflow: auto;
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 16%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: var(--app-bg, #fff);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.16);
}

.node-detail__conclusion-panel-head,
.node-detail__conclusion-check-head {
  display: flex;
  align-items: center;
  gap: 10px;
  justify-content: space-between;
  flex-wrap: wrap;
}

.node-detail__conclusion-panel-head strong {
  font-size: 14px;
}

.node-detail__conclusion-panel-head span,
.node-detail__conclusion-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 16%, var(--app-border, #e8e8e8));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
  color: var(--app-muted, #666);
  font-size: 12px;
}

.node-detail__conclusion-summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-text, #1f2937);
}

.node-detail__conclusion-meta,
.node-detail__conclusion-checks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-detail__conclusion-check {
  min-width: 180px;
  max-width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--app-border, #e8e8e8);
  background: var(--app-bg, #fff);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.node-detail__conclusion-check-tag {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12px;
}

.node-detail__conclusion-check-tag--success {
  background: color-mix(in srgb, #52c41a 10%, var(--app-bg, #fff));
  color: #237804;
}

.node-detail__conclusion-check-tag--warning {
  background: color-mix(in srgb, #faad14 12%, var(--app-bg, #fff));
  color: #ad6800;
}

.node-detail__conclusion-check-tag--danger {
  background: color-mix(in srgb, #ff4d4f 10%, var(--app-bg, #fff));
  color: #cf1322;
}

.node-detail__conclusion-check small {
  color: var(--app-muted, #666);
  line-height: 1.6;
}

.node-detail__file-strip {
  display: flex;
  align-items: center;
  gap: 8px;
}

.node-detail__file-strip--scrollable {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 36px;
  align-items: center;
  gap: 10px;
}

.node-detail__file-rail {
  display: flex;
  overflow-x: auto;
  gap: 8px;
  min-width: 0;
  scrollbar-width: thin;
  padding-bottom: 2px;
  scroll-behavior: smooth;
  overscroll-behavior-x: contain;
}

.node-detail__rail-arrow {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  color: var(--app-muted, #666);
  cursor: pointer;
}

.node-detail__file-pill {
  flex: 0 0 176px;
  max-width: 176px;
  min-height: 58px;
  text-align: left;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: var(--app-bg, #fff);
  padding: 9px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.node-detail__file-pill strong {
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-detail__file-pill--header {
  flex: 0 0 auto;
  min-height: 40px;
  max-width: 320px;
  padding: 0 14px;
  justify-content: center;
}

.node-detail__file-pill span {
  font-size: 11px;
  color: var(--app-muted, #666);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-detail__file-pill--header span {
  display: none;
}

.node-detail__file-pill--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 55%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary, #1677ff) 18%, transparent);
}

.node-detail__switcher {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-detail__switcher--versions {
  flex: 0 0 auto;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: clip;
  min-height: 64px;
  padding-top: 2px;
  padding-bottom: 6px;
  min-width: 0;
  scrollbar-width: thin;
  overscroll-behavior-x: contain;
}

.node-detail__switcher-item {
  min-width: 156px;
  max-width: 220px;
  text-align: left;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
  background: var(--app-bg, #fff);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}

.node-detail__switcher-item strong {
  font-size: 11px;
  line-height: 1.45;
}

.node-detail__switcher-item small {
  font-size: 10px;
  line-height: 1.45;
  color: var(--app-muted, #666);
}

.node-detail__switcher--versions .node-detail__switcher-item {
  flex: 0 0 220px;
  min-height: 54px;
}

.node-detail__switcher--versions .node-detail__switcher-item small {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-detail__switcher-item--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 55%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary, #1677ff) 18%, transparent);
}

.node-detail__preview-card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  padding: 14px;
  background: var(--app-bg, #fff);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.node-detail--fill-height .node-detail__preview-card {
  flex: 1 1 auto;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
}

.node-detail__preview-card--workspace {
  padding: 12px;
  gap: 10px;
}

.node-detail__workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}

.node-detail--fill-height .node-detail__workspace {
  height: 100%;
  grid-row: 2;
}

.node-detail__workspace--nav-collapsed {
  grid-template-columns: 36px minmax(0, 1fr);
}

/* 收起态下的 toggle：压缩成贴边的小图标按钮 */
.node-detail__file-nav--collapsed .node-detail__file-nav-toggle {
  min-width: 24px;
  padding: 0 4px;
}

.node-detail__file-nav {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: var(--app-bg, #fff);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.03);
}

.node-detail__file-nav--collapsed {
  align-items: stretch;
}

/* 文件区头部：弱化分隔线，标题做小号副标题样式 */
.node-detail__file-nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  padding: 6px 6px 6px 12px;
  gap: 6px;
  background: color-mix(in srgb, var(--app-bg, #fff) 94%, var(--app-bg-secondary, #f5f5f5));
}

.node-detail__file-nav--collapsed .node-detail__file-nav-head {
  justify-content: center;
  padding: 6px;
}

/* 标题与 Git 状态指示同处一行；状态不再插入列表，避免打开弹框时列表整体位移 */
.node-detail__file-nav-head-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1 1 auto;
}

.node-detail__file-nav-status {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--app-muted, #6b7280);
  font-size: 12px;
}

.node-detail__file-nav-status--error {
  color: #ad6800;
}

.node-detail__file-nav-head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--app-muted, #6b7280);
}

/* 收起按钮：无边框图标按钮，hover 出现底色 */
.node-detail__file-nav-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  min-height: 26px;
  padding: 0 8px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--app-muted, #6b7280);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.node-detail__file-nav-toggle:hover {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, transparent);
  color: var(--app-primary, #1677ff);
}

.node-detail__file-nav-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  min-height: 0;
  overflow: auto;
}

.node-detail__file-nav-group-title {
  padding: 6px 4px 2px;
  color: var(--app-muted, #6b7280);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.node-detail__file-nav-item {
  position: relative;
  width: 100%;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text, #1f2937);
  text-align: left;
  padding: 7px 10px 7px 10px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-areas:
    "badge title"
    "badge desc";
  align-items: center;
  gap: 0 10px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.node-detail__file-nav-item:hover {
  background: color-mix(in srgb, var(--app-primary, #1677ff) 5%, var(--app-bg, #fff));
}

.node-detail__file-nav-item--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 22%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 9%, var(--app-bg, #fff));
}

.node-detail__file-nav-item--active::before {
  content: "";
  position: absolute;
  left: 2px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 999px;
  background: var(--app-primary, #1677ff);
}

/* 文件类型徽章：方形卡片样式，体现“文件图标”语义 */
.node-detail__file-nav-badge {
  grid-area: badge;
  align-self: center;
  min-width: 32px;
  height: 28px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 18%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 6%, var(--app-bg, #fff));
  color: var(--app-primary, #1677ff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.node-detail__file-nav-badge--field {
  border-color: color-mix(in srgb, #0f766e 24%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, #0f766e 8%, var(--app-bg, #fff));
  color: #0f766e;
}

.node-detail__file-nav-item strong {
  grid-area: title;
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.node-detail__file-nav-item small {
  grid-area: desc;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #6b7280);
}

.node-detail__file-nav-item small > span:first-child {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail__git-status-pill {
  flex: 0 0 auto;
  margin-left: auto;
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 700;
  line-height: 1.5;
}

.node-detail__git-status-pill--added {
  background: color-mix(in srgb, #16a34a 12%, var(--app-bg, #fff));
  color: #15803d;
}

.node-detail__git-status-pill--modified,
.node-detail__git-status-pill--renamed {
  background: color-mix(in srgb, #1677ff 12%, var(--app-bg, #fff));
  color: var(--app-primary, #1677ff);
}

.node-detail__git-status-pill--deleted {
  background: color-mix(in srgb, #ff4d4f 12%, var(--app-bg, #fff));
  color: #cf1322;
}

.node-detail__preview-card--subtle {
  background: var(--app-bg, #fff);
}

.node-detail__preview-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.node-detail__preview-head--compact {
  align-items: center;
  gap: 16px;
}

.node-detail__preview-head h5,
.node-detail__section-header h5 {
  margin: 0 0 4px;
  font-size: 15px;
}

.node-detail__preview-head p,
.node-detail__section-header p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.node-detail__preview-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
}

.node-detail__preview-toggle {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  color: var(--app-muted, #666);
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}

.node-detail__preview-toggle--accent {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 40%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
}

.node-detail__preview-toggle--danger {
  border-color: color-mix(in srgb, #ff4d4f 40%, var(--app-border, #d9d9d9));
  color: #cf1322;
  background: color-mix(in srgb, #ff4d4f 8%, var(--app-bg, #fff));
}

.node-detail__preview-toggle--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 50%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-bg, #fff));
}

.node-detail__preview-toggle:disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.node-detail__help-btn {
  width: 24px;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 18%, var(--app-border, #d9d9d9));
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, var(--app-text, #1f2937));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.node-detail__help-btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 32%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 12%, var(--app-bg, #fff));
}

.node-detail__help-popover {
  max-width: 320px;
  display: grid;
  gap: 6px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-text, #334155);
}

.node-detail__help-popover strong,
.node-detail__help-popover p {
  margin: 0;
}

.node-detail__editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  min-height: 0;
  padding: 6px 12px 10px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 2%, var(--app-bg, #fff));
}

.node-detail__editor-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
  flex-wrap: wrap;
  flex: 0 0 auto;
}

.node-detail__editor-path {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  flex: 1 1 320px;
}

.node-detail__editor-path span {
  font-size: 11px;
  font-weight: 600;
  color: var(--app-muted, #666);
}

.node-detail__editor-path-input,
.node-detail__editor-textarea {
  width: 100%;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 12px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
}

.node-detail__editor-toolbar-note {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-muted, #666);
}

.node-detail__revision-error {
  border: 1px solid color-mix(in srgb, #ff4d4f 30%, var(--app-border, #d9d9d9));
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
  color: #cf1322;
  background: color-mix(in srgb, #ff4d4f 6%, var(--app-bg, #fff));
}

.node-detail__editor-textarea {
  flex: 1 1 0;
  min-height: 0;
  resize: none;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}

.node-detail__editor-textarea--code {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
}

.node-detail__preview-frame {
  overflow: hidden;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: var(--app-bg, #fff);
  min-height: 0;
  flex: 1 1 auto;
}

.node-detail__preview-frame--result {
  flex: 1 1 auto;
  min-height: 360px;
}

.node-detail--fill-height .node-detail__preview-frame--result {
  min-height: 0;
  height: 100%;
}

.node-detail__field-preview {
  height: 100%;
  min-height: 0;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: hidden;
}

.node-detail__field-preview-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  min-width: 0;
}

.node-detail__field-preview-head div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.node-detail__field-preview-head span,
.node-detail__field-preview-meta {
  color: var(--app-muted, #6b7280);
  font-size: 12px;
  line-height: 1.5;
}

.node-detail__field-preview-head strong {
  color: var(--app-text, #1f2937);
  font-size: 18px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail__field-preview-head code {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail__field-preview-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.node-detail__field-preview-value {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  overflow: auto;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 2%, var(--app-bg, #fff));
  color: var(--app-text, #1f2937);
  padding: 12px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.node-detail__preview-frame--input {
  height: min(36vh, 340px);
}

.node-detail__modal-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: calc(100% - 44px);
  min-width: 0;
}

.node-detail__modal-titlebar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-detail__compare-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.node-detail__compare-panes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}

.node-detail__compare-diff,
.node-detail__compare-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  overflow: hidden;
  background: var(--app-bg, #fff);
  min-height: 0;
}

.node-detail__compare-head {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, #fafbfd);
  font-size: 12px;
}

.node-detail__compare-head--diff {
  align-items: flex-start;
}

.node-detail__compare-head--diff > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.node-detail__compare-version-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--app-muted, #667085);
}

.node-detail__compare-version-control select {
  min-height: 28px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  font-size: 12px;
}

.node-detail__compare-head code {
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted, #667085);
}

.node-detail__compare-body,
.node-detail__compare-diff-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

:global(.node-detail__compare-modal-wrap--fullscreen.ant-modal-wrap),
:global(.node-detail__git-diff-modal-wrap--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

:global(.node-detail__compare-modal-wrap--fullscreen .ant-modal),
:global(.node-detail__git-diff-modal-wrap--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.node-detail__compare-modal-wrap--fullscreen .ant-modal-content),
:global(.node-detail__git-diff-modal-wrap--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.node-detail__compare-modal-wrap--fullscreen .ant-modal-body),
:global(.node-detail__git-diff-modal-wrap--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-modal,
:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-diff,
:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-pane,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-modal {
  height: 100%;
  max-height: none;
  min-height: 0;
}

:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-diff,
:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-pane,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-modal {
  display: flex;
  flex-direction: column;
}

:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-panes,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-body,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-patch {
  flex: 1 1 auto;
  min-height: 0;
}

:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-body,
:global(.node-detail__compare-modal-wrap--fullscreen) .node-detail__compare-diff-body,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-body,
:global(.node-detail__git-diff-modal-wrap--fullscreen) .node-detail__git-diff-patch {
  height: auto;
  max-height: none;
  min-height: 0;
}

.node-detail__compare-note {
  flex: 0 0 auto;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #faad14 35%, var(--app-border, #e8e8e8));
  border-radius: 12px;
  background: color-mix(in srgb, #faad14 10%, var(--app-bg, #fff));
  color: #8a5a00;
  font-size: 12px;
}

.node-detail__git-diff-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.node-detail__git-diff-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 0.9fr);
  gap: 12px;
  align-items: center;
}

.node-detail__git-diff-head > div:first-child {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.node-detail__git-diff-head strong {
  font-size: 14px;
  color: var(--app-text, #1f2937);
}

.node-detail__git-diff-head span,
.node-detail__git-diff-head code {
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__git-diff-head code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.node-detail__git-diff-actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.node-detail__git-diff-loading {
  min-height: 260px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.node-detail__git-diff-body {
  height: min(66vh, 760px);
  min-height: 420px;
}

.node-detail__git-diff-patch {
  margin: 0;
  max-height: min(66vh, 760px);
  overflow: auto;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: var(--app-bg-secondary, #fafafa);
  padding: 12px;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.node-detail__compare-modal--fullscreen,
.node-detail__compare-modal--fullscreen .node-detail__compare-diff,
.node-detail__compare-modal--fullscreen .node-detail__compare-pane,
.node-detail__git-diff-modal--fullscreen {
  height: 100%;
  max-height: none;
  min-height: 0;
}

.node-detail__compare-modal--fullscreen .node-detail__compare-diff,
.node-detail__compare-modal--fullscreen .node-detail__compare-pane,
.node-detail__git-diff-modal--fullscreen {
  display: flex;
  flex-direction: column;
}

.node-detail__compare-modal--fullscreen .node-detail__compare-panes,
.node-detail__compare-modal--fullscreen .node-detail__compare-body,
.node-detail__compare-modal--fullscreen .node-detail__compare-diff-body,
.node-detail__git-diff-modal--fullscreen .node-detail__git-diff-body,
.node-detail__git-diff-modal--fullscreen .node-detail__git-diff-patch {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.node-detail__markdown {
  height: 100%;
}

.node-detail__fold {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, var(--app-bg-secondary, #fafafa));
}

.node-detail__fold summary {
  list-style: none;
  cursor: pointer;
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 600;
}

.node-detail__fold summary::-webkit-details-marker {
  display: none;
}

.node-detail__fold[open] summary {
  border-bottom: 1px solid var(--app-border, #e8e8e8);
}

.node-detail__fold-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.node-detail__hint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.node-detail__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.node-detail__field label {
  display: block;
  font-size: 11px;
  color: var(--app-muted, #666);
  font-weight: 500;
}

.node-detail__field--error label {
  color: #cf1322;
}

.node-detail__pre {
  margin: 0;
  padding: 12px;
  border-radius: 10px;
  background: var(--app-bg-secondary, #fafafa);
  font-size: 12px;
  line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

.node-detail__pre--fill {
  height: 100%;
  max-height: none;
  border-radius: 0;
}

.node-detail__config-grid,
.node-detail__binding-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.node-detail__config-card,
.node-detail__binding-card,
.node-detail__snapshot-card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  background: var(--app-bg, #fff);
}

.node-detail__config-card span,
.node-detail__binding-card span,
.node-detail__snapshot-section span {
  color: var(--app-muted, #666);
}

.node-detail__config-card code {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
}

.node-detail__snapshot-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-detail__snapshot-picker--modal {
  padding-bottom: 2px;
}

.node-detail__snapshot-chip {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  padding: 4px 10px;
  font-size: 11px;
  cursor: pointer;
}

.node-detail__snapshot-chip--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 60%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
}

.node-detail__snapshot-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.node-detail__snapshot-meta span {
  color: var(--app-muted, #666);
}

.node-detail__snapshot-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.node-detail__prompt-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.node-detail__prompt-modal-head {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  align-items: flex-start;
  padding: 12px 14px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary, #fafafa) 74%, var(--app-bg, #fff));
}

.node-detail__prompt-modal-head strong {
  display: block;
  margin-bottom: 4px;
  color: var(--app-text, #1f2937);
}

.node-detail__prompt-modal-head p {
  margin: 0;
  color: var(--app-muted, #667085);
  font-size: 12px;
  word-break: break-word;
}

.node-detail__prompt-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-detail__prompt-tab {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 999px;
  background: var(--app-bg, #fff);
  color: var(--app-muted, #667085);
  padding: 7px 12px;
  font-size: 12px;
  cursor: pointer;
}

.node-detail__prompt-tab--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 58%, var(--app-border, #d9d9d9));
  color: var(--app-primary, #1677ff);
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, var(--app-bg, #fff));
}

.node-detail__prompt-modal-pre {
  margin: 0;
  height: min(68vh, 720px);
  min-height: 420px;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: var(--app-bg-secondary, #fafafa);
  color: var(--app-text, #1f2937);
  font-size: 12px;
  line-height: 1.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

.node-detail__gate-result {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  padding: 4px 0;
}

.node-detail__gate-evidence {
  flex-basis: 100%;
  margin: 2px 0 0 16px;
  padding-left: 16px;
  color: var(--app-muted, #666);
  line-height: 1.6;
  min-width: 0;
  overflow-wrap: anywhere;
}

.node-detail__gate-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.node-detail__gate-result > span:last-of-type {
  min-width: 0;
  overflow-wrap: anywhere;
}

.node-detail__empty {
  padding: 20px;
  border-radius: 12px;
  border: 1px dashed var(--app-border, #d9d9d9);
  color: var(--app-muted, #666);
  font-size: 13px;
  text-align: center;
}

@media (max-width: 1100px) {
  .node-detail__debug-summary,
  .node-detail__config-grid,
  .node-detail__binding-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .node-detail__work-items-layout {
    grid-template-columns: minmax(280px, 1fr) minmax(260px, 0.8fr);
  }
}

@media (max-width: 767px) {
  .node-detail__headline,
  .node-detail__preview-head,
  .node-detail__editor-toolbar,
  .node-detail__section-header,
  .node-detail__snapshot-meta,
  .node-detail__prompt-card,
  .node-detail__prompt-modal-head {
    flex-direction: column;
  }

  .node-detail__header {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }

  .node-detail__debug-summary {
    grid-template-columns: 1fr;
  }
  .node-detail__config-grid,
  .node-detail__binding-list {
    grid-template-columns: 1fr;
  }

  .node-detail__prompt-card {
    align-items: stretch;
  }

  .node-detail__prompt-card-meta {
    justify-content: flex-start;
  }

  .node-detail__prompt-modal-pre {
    min-height: 320px;
  }
  .node-detail__header-actions,
  .node-detail__preview-actions {
    width: 100%;
    align-items: stretch;
    justify-self: stretch;
    justify-content: flex-start;
  }

  .node-detail__header-action-group {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .node-detail__attention-note {
    flex-direction: column;
    gap: 6px;
  }

  .node-detail__conclusion-panel {
    left: 0;
    right: auto;
    width: min(100%, 420px);
  }

  .node-detail__workspace,
  .node-detail__workspace--nav-collapsed {
    grid-template-columns: 1fr;
  }

  .node-detail__file-nav--collapsed {
    display: none;
  }

  .node-detail__file-nav-item,
  .node-detail__switcher-item {
    flex-basis: 176px;
  }

  .node-detail__compare-panes {
    grid-template-columns: 1fr;
  }

  .node-detail__work-items-head {
    align-items: stretch;
    flex-direction: column;
  }

  .node-detail__work-items-popover {
    width: calc(100vw - 32px);
    max-height: calc(100vh - 80px);
  }

  .node-detail__work-items-filter {
    justify-content: space-between;
  }

  .node-detail__work-items-controls {
    width: 100%;
    align-items: center;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .node-detail__work-items-search {
    width: 100%;
    flex: 1 0 100%;
  }

  .node-detail__work-items-filter {
    flex: 1 1 auto;
  }

  .node-detail__work-items-layout {
    grid-template-columns: 1fr;
    grid-template-rows: auto auto;
    height: auto;
    max-height: none;
  }

  .node-detail__work-items-list {
    height: 320px;
    max-height: 320px;
    border-right: 0;
    border-bottom: 1px solid var(--app-border, #e5e7eb);
  }

  .node-detail__work-item-detail {
    max-height: 360px;
  }

  .node-detail__work-item-event {
    grid-template-columns: 72px minmax(0, 1fr);
  }

  .node-detail__work-item-event time {
    grid-column: 2;
  }
}

:root[data-theme="dark"] .node-detail__attention-note,
:root[data-theme="dark"] .node-detail__debug-card,
:root[data-theme="dark"] .node-detail__prompt-card,
:root[data-theme="dark"] .node-detail__prompt-modal-head,
:root[data-theme="dark"] .node-detail__header-toggle,
:root[data-theme="dark"] .node-detail__conclusion-button,
:root[data-theme="dark"] .node-detail__rail-arrow,
:root[data-theme="dark"] .node-detail__file-nav,
:root[data-theme="dark"] .node-detail__file-nav-head,
:root[data-theme="dark"] .node-detail__file-nav-toggle,
:root[data-theme="dark"] .node-detail__file-nav-item,
:root[data-theme="dark"] .node-detail__file-pill,
:root[data-theme="dark"] .node-detail__conclusion-panel,
:root[data-theme="dark"] .node-detail__preview-card,
:root[data-theme="dark"] .node-detail__fold,
:root[data-theme="dark"] .node-detail__preview-frame,
:root[data-theme="dark"] .node-detail__field-preview-value,
:root[data-theme="dark"] .node-detail__git-diff-patch,
:root[data-theme="dark"] .node-detail__compare-diff,
:root[data-theme="dark"] .node-detail__compare-pane,
:root[data-theme="dark"] .node-detail__editor,
:root[data-theme="dark"] .node-detail__editor-path-input,
:root[data-theme="dark"] .node-detail__editor-textarea,
:root[data-theme="dark"] .node-detail__revision-error,
:root[data-theme="dark"] .node-detail__field-preview-value,
:root[data-theme="dark"] .node-detail__switcher-item,
:root[data-theme="dark"] .node-detail__config-card,
:root[data-theme="dark"] .node-detail__binding-card,
:root[data-theme="dark"] .node-detail__snapshot-card {
  border-color: #303030;
}

:root[data-theme="dark"] .node-detail__preview-card,
:root[data-theme="dark"] .node-detail__conclusion-panel,
:root[data-theme="dark"] .node-detail__file-nav,
:root[data-theme="dark"] .node-detail__file-nav-item,
:root[data-theme="dark"] .node-detail__git-diff-patch,
:root[data-theme="dark"] .node-detail__compare-diff,
:root[data-theme="dark"] .node-detail__compare-pane,
:root[data-theme="dark"] .node-detail__switcher-item,
:root[data-theme="dark"] .node-detail__config-card,
:root[data-theme="dark"] .node-detail__binding-card,
:root[data-theme="dark"] .node-detail__snapshot-card {
  background: var(--app-bg, #141414);
}

:root[data-theme="dark"] .node-detail__preview-toggle,
:root[data-theme="dark"] .node-detail__prompt-tab,
:root[data-theme="dark"] .node-detail__prompt-modal-pre,
:root[data-theme="dark"] .node-detail__editor-path-input,
:root[data-theme="dark"] .node-detail__editor-textarea,
:root[data-theme="dark"] .node-detail__editor,
:root[data-theme="dark"] .node-detail__revision-error,
:root[data-theme="dark"] .node-detail__pre,
:root[data-theme="dark"] .node-detail__empty,
:root[data-theme="dark"] .node-detail__compare-head,
:root[data-theme="dark"] .node-detail__compare-version-control select,
:root[data-theme="dark"] .node-detail__snapshot-chip {
  background: #1f1f1f;
}

:root[data-theme="dark"] .node-detail__file-pill--active,
:root[data-theme="dark"] .node-detail__file-nav-item--active,
:root[data-theme="dark"] .node-detail__switcher-item--active {
  background: #141414;
}

:root[data-theme="dark"] .node-detail__work-items-toggle,
:root[data-theme="dark"] .node-detail__conclusion-button--success,
:root[data-theme="dark"] .node-detail__conclusion-check-tag--success,
:root[data-theme="dark"] .node-detail__work-item-status--completed,
:root[data-theme="dark"] .node-detail__git-status-pill--added {
  color: #b7eb8f;
}

:root[data-theme="dark"] .node-detail__work-items-progress span {
  background: #52c41a;
}

:root[data-theme="dark"] .node-detail__conclusion-button--warning,
:root[data-theme="dark"] .node-detail__conclusion-check-tag--warning,
:root[data-theme="dark"] .node-detail__file-nav-status--error,
:root[data-theme="dark"] .node-detail__compare-note {
  color: #ffd666;
}

:root[data-theme="dark"] .node-detail__conclusion-button--danger,
:root[data-theme="dark"] .node-detail__conclusion-check-tag--danger,
:root[data-theme="dark"] .node-detail__work-items-error,
:root[data-theme="dark"] .node-detail__revision-error,
:root[data-theme="dark"] .node-detail__field--error label,
:root[data-theme="dark"] .node-detail__git-status-pill--deleted,
:root[data-theme="dark"] .node-detail__preview-toggle--danger {
  color: #ff9c9c;
}

:root[data-theme="dark"] .node-detail__work-item-status--in_progress {
  color: #8eb7ff;
}

:root[data-theme="dark"] .node-detail__file-nav-badge--field {
  color: #5eead4;
}
</style>

