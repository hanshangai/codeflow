<script setup lang="ts">
import { computed, defineAsyncComponent, onActivated, onBeforeUnmount, onDeactivated, ref, toRef, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import {
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons-vue";
import {
  canManageSpecKnowledgeAndToolsets,
  getTaskIntakeTitle,
  isSharedWorkspaceSelectionId,
  shouldKeepPaidMenusVisibleWhenExpired,
  type AssetGenerationJobId,
  type AssetGenerationJobStatus,
  type KnowledgeBundleDefinition,
  type OrchAssetDraftJobListItem,
  type OrchAssetType,
  type OrchBuiltinAssetCatalogItem,
  type OrchestrationId,
  type OrchestrationStatus,
  type ProposalId,
  type RoleDefinition,
  type RoleId,
  type SkillDefinition,
  type SkillId,
  type ToolsetDefinition,
  type WorkflowDefinition,
  type WorkspaceId,
} from "@codeflowai/shared";
import { useRoute, useRouter } from "vue-router";

import { copyPersonalOrchAsset, deleteAssetAssistantJob, listAssetAssistantJobs } from "../../../api/orchestration";
import { createApiResultError } from "../../../api/request";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore, type OrchTab } from "../../../store/orchestration";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { useRequirementAnalysisStore } from "../../../store/requirementAnalysis";
import { useUiStore } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import AssetAssistantPanel from "./AssetAssistantPanel.vue";
import ClientStartupBanner from "../../../components/app-shell/ClientStartupBanner.vue";
import DesktopPanelResizeHandle from "../../../components/layout/desktop-panel-resize-handle.vue";
import { resolveLeftSidebarTrackWidth } from "../../../layouts/desktop/desktop-panel-sizing";
import { deriveIntakeRunSummary } from "../task-intake-run-summary";
import KnowledgeBundleForm from "./knowledge-bundle-form.vue";
import KnowledgeBundleList from "./knowledge-bundle-list.vue";
import IntakeInstancesPanel from "./intake-instances-panel.vue";
import McpManagementPanel from "./mcp-management-panel.vue";
import RequirementAnalysisWorkspace from "./requirement-analysis-workspace.vue";
import RoleList from "./role-list.vue";
import RoleDefinitionForm from "./role-definition-form.vue";
import SkillForm from "./skill-form.vue";
import SkillList from "./skill-list.vue";
import SkillMarketplacePanel from "./skill-marketplace-panel.vue";
import TaskEntrySidebar from "./task-entry-sidebar.vue";
import TaskIntakePanel from "./task-intake-panel.vue";
import ToolsetForm from "./toolset-form.vue";
import ToolsetList from "./toolset-list.vue";
import WorkflowSidebar from "./workflow-sidebar.vue";
import WorkflowEditor from "./workflow-editor.vue";
import type { OrchAssetEditorHandle } from "../composables/useOrchAssetDirtyState";
import { useBuiltinAssetLibrary } from "../composables/useBuiltinAssetLibrary";

defineOptions({ name: "OrchestrationLayout" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  desktopLeftSidebarWidth?: number;
  desktopLeftSidebarMaxWidth?: number;
}>();
const emit = defineEmits<{
  (e: "left-sidebar-resize-start"): void;
  (e: "left-sidebar-resize-preview", width: number): void;
  (e: "left-sidebar-resize-commit", width: number): void;
  (e: "left-sidebar-resize-cancel"): void;
}>();

type WorkspaceTab = "tasks" | "artifacts";
type AssetTab = "workflows" | "roles" | "knowledge" | "skills" | "tools" | "mcp";
type AssetWorkspaceView = "assistant" | "assets";
type SkillView = "owned" | "market";
type AssetLoadFailure = {
  scopeKey: string;
  message: string;
};
type PlannedAssetEntry = "assistant";
const assetToolbarTeleportTarget = "#orch-asset-toolbar-host";

const orch = useOrchestrationStore();
const config = useConfigStore();
const presence = usePresenceStore();
const analysis = useRequirementAnalysisStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();
const route = useRoute();
const router = useRouter();
const desktopLocalWorkspace = computed(() => isDesktopWorkspace(config, props.workspaceId));

/** 提取可检索错误字段，避免把接口正文写入浏览器日志。 */
function errorDiagnosticContext(error: unknown, fallbackCode: string): { errorCode: string; requestId: string | null } {
  const raw = error && typeof error === "object" ? error as Record<string, any> : {};
  return {
    errorCode: String(raw.code ?? fallbackCode).trim() || fallbackCode,
    requestId: String(raw.requestId ?? raw.request_id ?? raw.meta?.requestId ?? "").trim() || null,
  };
}

const businessTabs: WorkspaceTab[] = ["tasks", "artifacts"];
const lastWorkspaceTab = ref<OrchTab>("tasks");
const lastAssetTab = ref<OrchTab>("workflows");
const activeAssetView = ref<AssetWorkspaceView>("assets");
const skillView = ref<SkillView>("market");
const skillViewOptions: Array<{ label: string; value: SkillView }> = [
  { label: "Skill 市场", value: "market" },
  { label: "平台 Skill", value: "owned" },
];
const assistantCreateKey = ref(0);
const assistantSessions = ref<OrchAssetDraftJobListItem[]>([]);
const assistantSessionsLoading = ref(false);
const assistantSessionsError = ref("");
const assistantSessionSearchText = ref("");
const activeAssistantJobId = ref<AssetGenerationJobId | null>(null);
const assistantSessionDeletingIds = ref<Set<AssetGenerationJobId>>(new Set());
const assetEditorRef = ref<OrchAssetEditorHandle | null>(null);
const assetLoadFailure = ref<AssetLoadFailure | null>(null);
const assetUnsavedModalOpen = ref(false);
const assetUnsavedModalSaving = ref(false);

let resolveAssetUnsavedConfirm: ((confirmed: boolean) => void) | null = null;
let assetUnsavedConfirmEpoch = 0;

const hasDesktopSidebar = computed(() => Number.isFinite(props.desktopLeftSidebarWidth));
const desktopSidebarCollapsed = computed(() => hasDesktopSidebar.value && ui.leftSidebarCollapsed);
const desktopGridStyle = computed(() => hasDesktopSidebar.value
  ? {
      "--orch-sidebar-width": `${props.desktopLeftSidebarWidth}px`,
      "--orch-sidebar-track-width": `${resolveLeftSidebarTrackWidth({
        collapsed: desktopSidebarCollapsed.value,
        effectiveLeftWidth: props.desktopLeftSidebarWidth ?? 360,
      })}px`,
    }
  : undefined);

/* ── 无工作区只读预览 ──
 * 预览态只由「无工作区」触发：已有工作区但 Client 离线不算预览，维持既有行为。
 * 预览分支不挂载任何列表/编辑器写入口，只读取已发布内置资产。 */
const normalizedWorkspaceId = computed(() => String(props.workspaceId ?? "").trim());
/** 预览态判定：仅由「无工作区」决定。 */
const previewReadonly = computed(() => normalizedWorkspaceId.value === "");
/** 预览态左侧静态分类标签（不可交互）。 */
const previewWorkspaceTabs = ["原始需求", "需求编排", "定时任务"] as const;
/** 预览态逐类型收窄后的只读定义，供五个表单以 source-definition 渲染。 */
type PreviewDefinitionByType = {
  role: RoleDefinition;
  workflow: WorkflowDefinition;
  knowledge_bundle: KnowledgeBundleDefinition;
  toolset: ToolsetDefinition;
  skill: SkillDefinition;
};
/** 预览态资产分类到内置资产类型的映射；MCP 依赖工作区 Client，因此没有可预览类型。 */
const previewAssetType = computed<OrchAssetType | null>(() => {
  if (activeAssetTab.value === "workflows") return "workflow";
  if (activeAssetTab.value === "roles") return "role";
  if (activeAssetTab.value === "knowledge") return "knowledge_bundle";
  if (activeAssetTab.value === "skills") return "skill";
  if (activeAssetTab.value === "tools") return "toolset";
  return null;
});
const previewSelectedId = ref("");
const builtinAssetLibrary = useBuiltinAssetLibrary();
const previewItems = builtinAssetLibrary.itemsByType;
/** 预览列表只展示当前分类对应的内置资产。 */
const previewListItems = computed<OrchBuiltinAssetCatalogItem[]>(() => {
  const assetType = previewAssetType.value;
  return assetType ? previewItems.value[assetType] ?? [] : [];
});
const previewListError = computed(() => {
  const assetType = previewAssetType.value;
  return assetType ? builtinAssetLibrary.errorByType.value[assetType] ?? "" : "";
});
const previewListLoading = computed(() => {
  const assetType = previewAssetType.value;
  if (!assetType) return false;
  return builtinAssetLibrary.loadingByType.value[assetType] === true
    && previewListItems.value.length === 0
    && !previewListError.value;
});
const previewListEmptyText = computed(() => (
  previewAssetType.value === null ? "MCP 需要在工作区中配置" : "暂无内置资产可预览"
));
const previewSelectedItem = computed<OrchBuiltinAssetCatalogItem | null>(() => (
  previewListItems.value.find((item) => item.assetId === previewSelectedId.value) ?? null
));
const previewDefinitionByType = computed<Partial<PreviewDefinitionByType>>(() => {
  const item = previewSelectedItem.value;
  // definition 的联合分支与自身 assetType 严格对应，因此这里的收窄是安全的。
  return item ? { [item.assetType]: item.definition } as Partial<PreviewDefinitionByType> : {};
});
const previewRole = computed(() => previewDefinitionByType.value.role ?? null);
const previewWorkflow = computed(() => previewDefinitionByType.value.workflow ?? null);
const previewKnowledgeBundle = computed(() => previewDefinitionByType.value.knowledge_bundle ?? null);
const previewToolset = computed(() => previewDefinitionByType.value.toolset ?? null);
const previewSkill = computed(() => previewDefinitionByType.value.skill ?? null);

const tabMeta: Record<OrchTab, { label: string; hint: string }> = {
  tasks: {
    label: "需求",
    hint: "记录要解决什么问题、背景是什么、验收标准是什么。需求会沉淀成可追踪记录。",
  },
  proposals: {
    label: "方案",
    hint: "方案视图已并入需求页，这里只保留内部状态兼容，不再单独作为需求管理入口。",
  },
  runs: {
    label: "执行",
    hint: "查看某个方案真正跑起来之后的执行状态、节点进度、日志事件和人工干预。",
  },
  artifacts: {
    label: "结果",
    hint: "查看执行过程中产出的结果物，例如分析、设计、代码修改说明和测试结论。",
  },
  workflows: {
    label: "流程",
    hint: "复用固定执行路径时再维护模板，用来沉淀长期稳定的执行做法。",
  },
  roles: {
    label: "Agent",
    hint: "定义各个角色负责什么、如何提示模型、输入输出契约是什么。",
  },
  knowledge: {
    label: "知识库",
    hint: "维护流程级和角色级可读取的上下文资料。",
  },
  skills: {
    label: "Skills",
    hint: "维护平台自定义的可复用执行技能，按角色绑定后注入 Codex 或 Claude。",
  },
  tools: {
    label: "工具",
    hint: "维护 Agent 可调用的平台工具，角色直接多选需要使用的工具。",
  },
  mcp: {
    label: "MCP",
    hint: "管理当前工作区 Client 可用的 MCP 服务。",
  },
};

const assetNavMeta: Record<AssetTab, { label: string; hint: string }> = {
  workflows: {
    label: "WF",
    hint: "复用固定执行路径，适合长期沉淀稳定做法。",
  },
  roles: {
    label: "Agent",
    hint: "定义角色职责、提示词、输入输出契约和执行模型。",
  },
  skills: {
    label: "Skill",
    hint: "维护平台自定义技能，并绑定到需要使用它的 Agent。",
  },
  knowledge: {
    label: "KB",
    hint: "维护流程级与角色级可读取的上下文资料。",
  },
  tools: {
    label: "Tool",
    hint: "维护可复用的平台工具，Agent 从这里挑选可用工具。",
  },
  mcp: {
    label: "MCP",
    hint: "管理当前工作区 Client 的 MCP 服务和引擎接入。",
  },
};

const assetTypesByTab: Record<AssetTab, readonly OrchAssetType[]> = {
  workflows: ["workflow", "role", "knowledge_bundle"],
  roles: ["role", "knowledge_bundle", "skill", "toolset"],
  knowledge: ["knowledge_bundle"],
  skills: ["skill"],
  tools: ["toolset"],
  mcp: [],
};

const plannedAssetNavMeta: Record<PlannedAssetEntry, { label: string; hint: string }> = {
  assistant: {
    label: "AI 辅助创建 Agent 和 Skill",
    hint: "AI 辅助创建 Agent 和 Skill",
  },
};

const activeTab = computed(() => orch.activeTab);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
const keepAllAssetTabsVisible = computed(() => shouldKeepPaidMenusVisibleWhenExpired(permissionInput.value));
const canManageKnowledgeAndToolsets = computed(() => desktopLocalWorkspace.value || canManageSpecKnowledgeAndToolsets(permissionInput.value));
const knowledgeToolsetLocked = computed(() => keepAllAssetTabsVisible.value && !canManageKnowledgeAndToolsets.value);
const assetTabs = computed<AssetTab[]>(() => (
  canManageKnowledgeAndToolsets.value || keepAllAssetTabsVisible.value
    ? ["workflows", "roles", "skills", "mcp", "knowledge", "tools"]
    : ["workflows", "roles", "mcp"]
));
const disabledAssetTabs = computed<AssetTab[]>(() => (
  keepAllAssetTabsVisible.value && !canManageKnowledgeAndToolsets.value
    ? ["knowledge", "tools", "skills"]
    : []
));
const routeSection = computed<"workspace" | "assets">(() =>
  route.name === "orchestration-assets" ? "assets" : "workspace",
);
const currentWorkspace = computed(() => workspaces.byId.get(props.workspaceId) ?? null);
const isSharedWorkspace = computed(() =>
  currentWorkspace.value?.kind === "shared" || isSharedWorkspaceSelectionId(props.workspaceId),
);
const currentSharedRole = computed(() =>
  currentWorkspace.value?.capabilities?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.effectiveAssetRole
  ?? currentWorkspace.value?.shared?.currentUserRole
  ?? null,
);
const sharedRoleResolved = computed(() => !isSharedWorkspace.value || currentSharedRole.value != null);
const isSharedMemberView = computed(() => currentSharedRole.value === "member");
const canMaintainSharedAssets = computed(() =>
  currentWorkspace.value?.capabilities?.canMaintainAssets === true,
);
/** 共享资产仅向工作区授权的维护者开放编辑；个人资产由本人维护。 */
const assetMaintenanceLocked = computed(() =>
  isSharedWorkspace.value && !canMaintainSharedAssets.value,
);
const assetDefinitionLocked = computed(() => assetMaintenanceLocked.value);
const assetMaintenanceLockReason = computed(() => {
  if (currentSharedRole.value === "member") return "当前账号未获得该共享工作区的资产维护授权，只能查看和使用共享资产。";
  return "当前账号没有该共享工作区的资产维护权限。";
});
const fallbackAssetTab = computed<AssetTab>(() =>
  assetTabs.value.includes(lastAssetTab.value as AssetTab) && !disabledAssetTabs.value.includes(lastAssetTab.value as AssetTab)
    ? (lastAssetTab.value as AssetTab)
    : "roles",
);
const activeAssetTab = computed<AssetTab>(() =>
  isAssetTab(activeTab.value) && assetTabs.value.includes(activeTab.value) && !disabledAssetTabs.value.includes(activeTab.value)
    ? activeTab.value
    : fallbackAssetTab.value,
);
const isSkillMarketView = computed(() => (
  activeAssetView.value === "assets"
  && activeAssetTab.value === "skills"
  && skillView.value === "market"
));
const activeAssetTypes = computed(() => (isSkillMarketView.value ? [] : assetTypesByTab[activeAssetTab.value]));
const activeAssetDataLoaded = computed(() => activeAssetTypes.value.every((assetType) => orch.assetListLoaded[assetType]));
/** 当前分类有已取得的定义时，独立来源失败不遮住已可用的资产详情。 */
const activeAssetDataAvailable = computed(() => {
  const type = previewAssetType.value;
  return (type === "role" ? orch.roles : type === "workflow" ? orch.workflows
    : type === "knowledge_bundle" ? orch.knowledgeBundles : type === "skill" ? orch.skills : type === "toolset" ? orch.toolsets : []).length > 0;
});
/** 当前 Tab 是否确实有资产请求在进行，避免失效标记导致永久“加载中”。 */
const activeAssetListLoading = computed(() => activeAssetTypes.value.some((assetType) => (
  assetType === "workflow" ? orch.workflowsLoading
    : assetType === "role" ? orch.rolesLoading
      : assetType === "knowledge_bundle" ? orch.knowledgeBundlesLoading
        : assetType === "toolset" ? orch.toolsetsLoading : orch.skillsLoading
)));
const assetLoadScopeKey = computed(() => `${String(props.workspaceId)}|${activeAssetTab.value}`);
const assetPageLoadError = computed(() => {
  if (
    activeAssetView.value !== "assets"
    || activeAssetDataLoaded.value
    || assetLoadFailure.value?.scopeKey !== assetLoadScopeKey.value
  ) return "";
  return assetLoadFailure.value.message;
});
const assetPageLoading = computed(() => (
  activeAssetView.value === "assets"
  && !previewReadonly.value
  && !activeAssetDataLoaded.value
  && activeAssetListLoading.value
  && !assetPageLoadError.value
  && (presence.isCurrentWorkspaceClientOnline || activeWorkspaceRuntimeState.value.status === "unknown")
));
/** 只对自定义资产维持整页只读；已发布内置资产允许普通用户进入详情查看。 */
const selectedAssetKind = computed(() => {
  if (activeAssetTab.value === "workflows") return orch.selectedWorkflow?.kind ?? null;
  if (activeAssetTab.value === "roles") return orch.selectedRole?.kind ?? null;
  if (activeAssetTab.value === "knowledge") return orch.selectedKnowledgeBundle?.kind ?? null;
  if (activeAssetTab.value === "skills") return isSkillMarketView.value ? null : (orch.selectedSkill?.kind ?? null);
  if (activeAssetTab.value === "mcp") return null;
  return orch.selectedToolset?.kind ?? null;
});
const selectedBuiltinAsset = computed(() => selectedAssetKind.value === "builtin");
/** Host 原件只读展示；其写入必须留在承载工作区，不能转成 Server 新资产。 */
const selectedHostAsset = computed(() => {
  const type = previewAssetType.value;
  const id = type === "role" ? orch.selectedRoleId : type === "workflow" ? orch.selectedWorkflowId
    : type === "knowledge_bundle" ? orch.selectedKnowledgeBundleId : type === "skill" ? orch.selectedSkillId : orch.selectedToolsetId;
  return type != null && id != null && orch.assetListHostIds[type].includes(id);
});
const selectedAssetReadonly = computed(() => selectedBuiltinAsset.value || selectedHostAsset.value);
const copyingBuiltinAssetId = ref<string | null>(null);
const desktopCopyAssetType = computed<OrchAssetType | null>(() => {
  if (activeAssetTab.value === "workflows") return "workflow";
  if (activeAssetTab.value === "roles") return "role";
  if (activeAssetTab.value === "knowledge") return "knowledge_bundle";
  if (activeAssetTab.value === "skills" && !isSkillMarketView.value) return "skill";
  if (activeAssetTab.value === "tools") return "toolset";
  return null;
});
/** 复制指定内置资产并刷新完整图，成功后直接选中可编辑副本；迟到结果不覆盖新工作区。 */
async function copyBuiltinAsset(assetType: OrchAssetType, assetId: string): Promise<void> {
  const workspaceId = props.workspaceId;
  if (!desktopLocalWorkspace.value || !assetId || copyingBuiltinAssetId.value) return;
  const runtimeId = config.desktopRuntime?.requestId;
  copyingBuiltinAssetId.value = assetId;
  let copied = false;
  try {
    const response = await copyPersonalOrchAsset(ctx.value, { workspaceId, assetType, assetId });
    if (!response.ok) throw createApiResultError(response);
    copied = true;
    if (props.workspaceId !== workspaceId || config.desktopRuntime?.requestId !== runtimeId) return;
    await Promise.all([
      orch.refreshRoles(ctx.value, workspaceId), orch.refreshWorkflows(ctx.value, workspaceId),
      orch.refreshKnowledgeBundles(ctx.value, workspaceId), orch.refreshToolsets(ctx.value, workspaceId),
      orch.refreshSkills(ctx.value, workspaceId),
    ]);
    if (props.workspaceId !== workspaceId || config.desktopRuntime?.requestId !== runtimeId) return;
    const rootId = response.imported.rootAssetId;
    if (assetType === "role") orch.selectedRoleId = rootId as RoleId;
    else if (assetType === "workflow") orch.selectedWorkflowId = rootId as WorkflowDefinition["id"];
    else if (assetType === "knowledge_bundle") orch.selectedKnowledgeBundleId = rootId as KnowledgeBundleDefinition["id"];
    else if (assetType === "toolset") orch.selectedToolsetId = rootId as ToolsetDefinition["id"];
    else orch.selectedSkillId = rootId as SkillId;
  } catch (error) {
    console.error("[OrchestrationLayout] personal asset copy failed", {
      ...errorDiagnosticContext(error, "DESKTOP_ASSET_COPY_FAILED"), workspaceId, assetType, assetId, copied,
      rootCause: error instanceof Error ? error.message : String(error),
    });
    message.error(copied ? "复制已保存，资产列表刷新失败，请重新加载。" : error instanceof Error ? error.message : "复制失败");
  } finally {
    copyingBuiltinAssetId.value = null;
  }
}
const assetPageLocked = computed(() => (
  assetMaintenanceLocked.value
  && activeAssetTab.value !== "mcp"
  && !isSkillMarketView.value
  && (
    activeAssetView.value !== "assets"
    || (!activeAssetDataLoaded.value && !activeAssetDataAvailable.value)
    || !selectedAssetReadonly.value
  )
));
/** 横排资产标签复用会话列表 segmented 风格，仅展示资产类型名称。 */
const assetSegmentedOptions = computed(() => assetTabs.value.map((tab) => ({
  label: assetNavMeta[tab].label,
  value: tab,
  disabled: disabledAssetTabs.value.includes(tab),
})));
/** 按标题、状态、类型和原始需求过滤助手会话列表。 */
const filteredAssistantSessions = computed(() => {
  const keyword = assistantSessionSearchText.value.trim().toLowerCase();
  if (!keyword) return assistantSessions.value;
  return assistantSessions.value.filter((item) => {
    const haystack = [
      assistantSessionTitle(item),
      assistantSessionMeta(item),
      item.job.assetKind,
      item.job.mode,
      item.job.prompt,
    ].join(" ").toLowerCase();
    return haystack.includes(keyword);
  });
});
const scopedProposals = computed(() => {
  if (!orch.selectedIntakeId) return [];
  return orch.proposals.filter((proposal) => proposal.intakeId === orch.selectedIntakeId);
});
const scopedInstances = computed(() => {
  if (!orch.selectedIntakeId) return [];
  return orch.instanceSummaries.filter((instance) => instance.intakeId === orch.selectedIntakeId);
});
const scopedExecutionProposals = computed(() => {
  const proposalIds = new Set(
    scopedInstances.value
      .map((instance) => String(instance.proposalId ?? "").trim())
      .filter(Boolean),
  );
  return scopedProposals.value.filter((proposal) => proposalIds.has(String(proposal.id)));
});
const scopedArtifactCount = computed(() => scopedInstances.value.reduce((count, instance) => count + instance.runSummary.artifactCount, 0));
const activeWorkspaceRuntimeState = computed(() => presence.activeWorkspaceRuntimeState);
const awaitingWorkspaceRuntime = computed(() =>
  !presence.isCurrentWorkspaceClientOnline
  && !orch.intakeComposerOpen
  && orch.intakes.length === 0
  && orch.proposals.length === 0
  && orch.instanceSummaries.length === 0
  && analysis.sessions.length === 0
  && !orch.intakesLoading
  && !orch.proposalsLoading
  && !orch.instancesLoading,
);
const showClientStartupGuide = computed(() =>
  config.connected
  && activeWorkspaceRuntimeState.value.kind !== "none"
  && activeWorkspaceRuntimeState.value.status !== "online"
  && activeWorkspaceRuntimeState.value.status !== "unknown",
);
const workspaceTitle = computed(() => {
  if (analysis.viewMode === "analysis" && activeTab.value === "tasks") {
    return analysis.selectedSession?.title ?? "AI 梳理需求";
  }
  if (orch.intakeComposerOpen) return "新需求";
  if (orch.selectedIntake) return getTaskIntakeTitle(orch.selectedIntake);
  if (awaitingWorkspaceRuntime.value) {
    if (activeWorkspaceRuntimeState.value.kind === "shared") {
      if (activeWorkspaceRuntimeState.value.status === "unknown") return "正在确认共享 Host 状态";
      if (activeWorkspaceRuntimeState.value.status === "unbound") return "等待共享 Host 绑定";
      if (activeWorkspaceRuntimeState.value.status === "forbidden") return "共享工作区暂不可用";
      return "等待共享 Host 连接";
    }
    return "等待 Client 连接";
  }
  if (orch.intakes.length > 0) return "选择一个需求";
  return "还没有需求";
});
const workspaceMeta = computed(() => {
  if (analysis.viewMode === "analysis" && activeTab.value === "tasks") {
    if (!analysis.selectedSession) return "";
    return `创建于 ${formatTime(analysis.selectedSession.createdAt)}，最近消息于 ${formatTime(analysis.selectedSession.lastMessageAt)}`;
  }
  if (!orch.selectedIntake) return "";
  return `创建于 ${formatTime(orch.selectedIntake.createdAt)}，最近更新于 ${formatTime(orch.selectedIntake.updatedAt)}`;
});
const workspaceRunSummary = computed(() => {
  if (analysis.viewMode === "analysis" && activeTab.value === "tasks") return null;
  if (!orch.selectedIntake) return null;
  return deriveIntakeRunSummary(orch.selectedIntake.id, orch.instanceSummaries);
});
const hideWorkspaceControls = computed(() =>
  activeTab.value === "tasks" && analysis.viewMode === "analysis",
);
const hideWorkspaceBar = computed(() =>
  activeTab.value === "tasks" && analysis.viewMode === "analysis",
);
const embeddedSwitcher = computed(() => {
  if (activeTab.value === "artifacts" && scopedInstances.value.length > 1) {
    return {
      label: "结果来源",
      value: orch.selectedInstanceId ?? scopedInstances.value[0]?.id ?? "",
      options: scopedInstances.value.map((instance, index) => ({
        value: instance.id,
        label: index === 0 ? "最新执行" : `历史执行 ${scopedInstances.value.length - index}`,
        meta: `${instanceStatusLabel(instance.status)} · ${formatShortTime(instance.updatedAt)}`,
      })),
    };
  }
  return null;
});

const loadingByTab = computed<Record<OrchTab, boolean>>(() => ({
  tasks: orch.intakesLoading,
  proposals: orch.proposalsLoading,
  runs: orch.instancesLoading,
  artifacts: orch.instancesLoading,
  workflows: orch.workflowsLoading,
  roles: orch.rolesLoading,
  knowledge: orch.knowledgeBundlesLoading,
  skills: orch.skillsLoading,
  tools: orch.toolsetsLoading,
  mcp: false,
}));

let hydratedWorkspaceId: WorkspaceId | null = null;
let appliedSharedRoleKey: string | null = null;
const orchestrationViewActive = ref(true);
let visibleHydrationInFlight: Promise<void> | null = null;
let visibleHydrationInFlightKey: string | null = null;
let visibleHydrationQueued = false;
let visibleHydrationRevision = 0;

/** 需求页首屏刷新必须先按共享角色确定列表筛选，避免管理员短暂走成员默认过滤。 */
function resolveSharedRequirementOnlyRelatedToMe(currentValue: boolean): boolean | null {
  if (!isSharedWorkspace.value) return null;
  if (!sharedRoleResolved.value) return true;
  return isSharedMemberView.value ? currentValue : false;
}

/** 仅在 KeepAlive 页面激活且仍处于编排主视图时允许派生请求。 */
function canHydrateOrchestrationView(): boolean {
  return orchestrationViewActive.value && ui.mainView === "orchestration";
}

/** 按当前资产 Tab 读取编辑器所需的缺失列表，已成功加载的数据直接复用。 */
async function ensureActiveAssetDataLoaded(workspaceId: WorkspaceId): Promise<void> {
  const scopeKey = assetLoadScopeKey.value;
  if (assetLoadFailure.value?.scopeKey === scopeKey) assetLoadFailure.value = null;
  try {
    await Promise.all(activeAssetTypes.value.map((assetType) => (
      orch.ensureAssetListLoaded(ctx.value, workspaceId, assetType)
    )));
  } catch (error) {
    if (assetLoadScopeKey.value === scopeKey) {
      assetLoadFailure.value = {
        scopeKey,
        message: error instanceof Error && error.message.trim() ? error.message : "资产加载失败，请重试。",
      };
    }
    throw error;
  }
}

/** 清除当前资产范围的失败状态并重新执行统一加载流程。 */
function retryAssetPageLoad(): void {
  assetLoadFailure.value = null;
  visibleHydrationRevision += 1;
  scheduleVisibleOrchestrationHydration();
}

/** 刷新可见路由；AI 分析读取执行流程/角色，资产页读取当前管理列表。 */
async function refreshVisibleOrchestrationData(): Promise<void> {
  const workspaceId = props.workspaceId;
  if (!workspaceId || !presence.isCurrentWorkspaceClientOnline || !canHydrateOrchestrationView()) return;
  if (isSharedWorkspace.value && !sharedRoleResolved.value) return;
  if (routeSection.value === "assets") {
    if (activeAssetView.value === "assistant") {
      await refreshAssistantSessions();
      return;
    }
    await ensureActiveAssetDataLoaded(workspaceId);
    return;
  }
  const analysisAssetLoads = analysis.viewMode === "analysis"
    ? [
        orch.ensureAssetListLoaded(ctx.value, workspaceId, "workflow", "execution"),
        orch.ensureAssetListLoaded(ctx.value, workspaceId, "role", "execution"),
      ]
    : [];
  await Promise.all([
    orch.refreshWorkspaceData(ctx.value, workspaceId, {
      onlyRelatedToMe: resolveSharedRequirementOnlyRelatedToMe(orch.intakeListOnlyRelatedToMe),
    }),
    analysis.refreshSessions(ctx.value, workspaceId, {
      onlyRelatedToMe: resolveSharedRequirementOnlyRelatedToMe(analysis.sessionListOnlyRelatedToMe),
    }),
    ...analysisAssetLoads,
  ]);
}

/** 标识当前可见刷新范围，避免同一首屏被多个 immediate watch 重复排队。 */
function buildVisibleHydrationKey(): string {
  return [
    visibleHydrationRevision,
    String(props.workspaceId),
    routeSection.value,
    activeAssetView.value,
    activeAssetTab.value,
    analysis.viewMode,
    String(currentSharedRole.value ?? ""),
    String(orch.intakeListOnlyRelatedToMe),
    String(analysis.sessionListOnlyRelatedToMe),
  ].join("|");
}

/** 合并同一激活窗口内的刷新触发；排队前隔离管理来源，失败由页面统一提示。 */
function scheduleVisibleOrchestrationHydration(): void {
  if (!canHydrateOrchestrationView()) return;
  if (routeSection.value === "assets" && activeAssetView.value === "assets") {
    for (const assetType of activeAssetTypes.value) {
      if (assetType === "role" || assetType === "workflow") orch.setAssetListPurpose(assetType);
    }
  }
  const hydrationKey = buildVisibleHydrationKey();
  if (visibleHydrationInFlight) {
    if (visibleHydrationInFlightKey === hydrationKey) return;
    visibleHydrationQueued = true;
    return;
  }
  const hydration = (async () => {
    let activeHydrationKey = hydrationKey;
    while (canHydrateOrchestrationView()) {
      visibleHydrationInFlightKey = activeHydrationKey;
      visibleHydrationQueued = false;
      await refreshVisibleOrchestrationData();
      const nextHydrationKey = buildVisibleHydrationKey();
      if (!visibleHydrationQueued || nextHydrationKey === activeHydrationKey) return;
      activeHydrationKey = nextHydrationKey;
    }
  })();
  visibleHydrationInFlight = hydration;
  visibleHydrationInFlightKey = hydrationKey;
  let failedHydrationKey: string | null = null;
  void hydration.catch((error) => {
    failedHydrationKey = visibleHydrationInFlightKey;
    console.error("[OrchestrationLayout] visible hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_VISIBLE_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      routeSection: routeSection.value,
      hydrationKey: failedHydrationKey,
    });
    message.error(error instanceof Error ? error.message : "加载需求编排数据失败");
  }).finally(() => {
    const shouldHydrateQueuedScope = Boolean(
      failedHydrationKey
      && visibleHydrationQueued
      && canHydrateOrchestrationView(),
    );
    if (visibleHydrationInFlight === hydration) {
      visibleHydrationInFlight = null;
      visibleHydrationInFlightKey = null;
    }
    if (failedHydrationKey) visibleHydrationQueued = false;
    if (shouldHydrateQueuedScope) scheduleVisibleOrchestrationHydration();
  });
}

watch([() => props.workspaceId, () => presence.isCurrentWorkspaceClientOnline, () => currentSharedRole.value], ([wsId, clientOnline]) => {
  if (!wsId) {
    // 进入/停留预览态：助手子视图与助手会话都是工作区级状态，必须归零，
    // 否则残留的助手侧栏会渲染上一工作区的会话，其删除按钮还会发出写请求。
    // 不改 activeTab，保留用户上次停留的模块。
    if (activeAssetView.value !== "assets") activeAssetView.value = "assets";
    if (assistantSessions.value.length) assistantSessions.value = [];
    // 清掉上一个工作区的水合状态，避免预览分支误读残留数据。
    if (hydratedWorkspaceId === null) return;
    visibleHydrationRevision += 1;
    cancelAssetUnsavedScope();
    orch.resetForWorkspace(null);
    hydratedWorkspaceId = null;
    appliedSharedRoleKey = null;
    return;
  }
  visibleHydrationRevision += 1;

  const workspaceChanged = hydratedWorkspaceId !== wsId;
  if (workspaceChanged) {
    cancelAssetUnsavedScope();
    if (!isAssetTab(orch.activeTab)) {
      orch.setActiveTab("tasks");
    }
    orch.resetForWorkspace(wsId);
    analysis.resetForWorkspace(wsId);
    hydratedWorkspaceId = wsId;
    appliedSharedRoleKey = null;
  }

  if (isSharedWorkspace.value && !sharedRoleResolved.value) return;
  if (isSharedWorkspace.value) {
    const roleKey = `${String(wsId)}:${String(currentSharedRole.value ?? "")}`;
    if (isSharedMemberView.value) {
      if (appliedSharedRoleKey !== roleKey) {
        orch.intakeListOnlyRelatedToMe = true;
        analysis.sessionListOnlyRelatedToMe = true;
      }
    } else {
      orch.intakeListOnlyRelatedToMe = false;
      analysis.sessionListOnlyRelatedToMe = false;
    }
    appliedSharedRoleKey = roleKey;
  }
  if (!clientOnline) return;
  scheduleVisibleOrchestrationHydration();
}, { immediate: true });

onDeactivated(() => cancelAssetUnsavedScope());
onBeforeUnmount(() => cancelAssetUnsavedScope());

/** 重新读取当前预览分类的内置资产。 */
function retryPreviewAssets(): void {
  const assetType = previewAssetType.value;
  if (assetType) void builtinAssetLibrary.retry(assetType);
}

/** 预览态按当前分类读取内置资产，并把选中项保持在有效条目上。 */
watch([previewReadonly, previewAssetType, () => previewItems.value], ([isPreview, assetType]) => {
  if (!isPreview || !assetType) {
    previewSelectedId.value = "";
    return;
  }
  void builtinAssetLibrary.ensureTypeLoaded(assetType);
  if (!previewListItems.value.some((item) => item.assetId === previewSelectedId.value)) {
    previewSelectedId.value = previewListItems.value[0]?.assetId ?? "";
  }
}, { immediate: true });

watch([() => props.workspaceId, activeAssetView], ([wsId, view]) => {
  if (!wsId || view !== "assistant") return;
  void refreshAssistantSessions();
}, { immediate: true });

onActivated(() => {
  const wasInactive = !orchestrationViewActive.value;
  orchestrationViewActive.value = true;
  if (wasInactive) {
    visibleHydrationRevision += 1;
    scheduleVisibleOrchestrationHydration();
  }
});

onDeactivated(() => {
  orchestrationViewActive.value = false;
  visibleHydrationQueued = false;
});

watch(activeTab, (tab) => {
  if (tab === "proposals" || tab === "runs" || tab === "artifacts") {
    orch.setActiveTab("tasks");
    return;
  }
  if (isWorkspaceTab(tab)) lastWorkspaceTab.value = tab;
  if (isAssetTab(tab) && assetTabs.value.includes(tab) && !disabledAssetTabs.value.includes(tab)) lastAssetTab.value = tab;
}, { immediate: true });

watch([routeSection, assetTabs, disabledAssetTabs], ([section, tabs, blockedTabs]) => {
  if (section === "workspace" && !isWorkspaceTab(orch.activeTab)) {
    orch.setActiveTab(lastWorkspaceTab.value);
  }
  if (section === "assets") {
    const nextAssetTab = isAssetTab(orch.activeTab) && tabs.includes(orch.activeTab) && !blockedTabs.includes(orch.activeTab)
      ? orch.activeTab
      : fallbackAssetTab.value;
    if (orch.activeTab !== nextAssetTab) {
      orch.setActiveTab(nextAssetTab);
    }
  }
}, { immediate: true });

/** 进入 AI 分析模式时补齐候选匹配依赖；退出时不重复刷新需求摘要。 */
watch(() => analysis.viewMode, (viewMode) => {
  if (viewMode !== "analysis") return;
  scheduleVisibleOrchestrationHydration();
});

watch([
  routeSection,
  activeAssetView,
  activeAssetTab,
  () => orch.intakeListOnlyRelatedToMe,
  () => analysis.sessionListOnlyRelatedToMe,
], () => {
  scheduleVisibleOrchestrationHydration();
});

watch([() => orch.selectedIntakeId, () => orch.proposals.length, () => orch.selectedProposalId], () => {
  if (orch.selectedProposalId && scopedProposals.value.some((proposal) => proposal.id === orch.selectedProposalId)) return;
  orch.selectedProposalId = scopedProposals.value[0]?.id ?? null;
}, { immediate: true });

watch([
  activeTab,
  () => orch.instanceSummaries.length,
  () => orch.selectedInstanceId,
  orchestrationViewActive,
  () => ui.mainView,
], () => {
  if (!canHydrateOrchestrationView()) return;
  if (activeTab.value !== "artifacts") return;
  if (orch.selectedInstanceId && scopedInstances.value.some((instance) => instance.id === orch.selectedInstanceId)) return;
  const first = scopedInstances.value[0];
  if (!first) return;
  orch.selectedInstanceId = first.id;
  void orch.loadInstance(ctx.value, props.workspaceId, first.id, {
    loadDetails: true,
    allowNetworkHydration: canHydrateOrchestrationView,
  }).catch((error) => {
    console.error("[OrchestrationLayout] artifact instance hydration failed", {
      ...errorDiagnosticContext(error, "ORCH_ARTIFACT_INSTANCE_HYDRATION_FAILED"),
      workspaceId: String(props.workspaceId),
      instanceId: String(first.id),
    });
    message.error(error instanceof Error ? error.message : "加载实例详情失败");
  });
}, { immediate: true });

watch([activeTab, () => orch.workflows.length, () => orch.selectedWorkflowId], () => {
  if (activeTab.value !== "workflows") return;
  const selected = orch.workflows.find((item) => item.id === orch.selectedWorkflowId) ?? null;
  if (selected) return;
  orch.selectedWorkflowId = orch.workflows[0]?.id ?? null;
}, { immediate: true });

watch([activeTab, () => orch.roles.length, () => orch.selectedRoleId], () => {
  if (activeTab.value !== "roles") return;
  const selected = orch.roles.find((item) => item.id === orch.selectedRoleId) ?? null;
  if (selected) return;
  orch.selectedRoleId = orch.roles[0]?.id ?? null;
}, { immediate: true });

watch([activeTab, () => orch.knowledgeBundles.length, () => orch.selectedKnowledgeBundleId], () => {
  if (activeTab.value !== "knowledge") return;
  if (orch.selectedKnowledgeBundleId) return;
  if (orch.knowledgeBundles[0]) orch.selectedKnowledgeBundleId = orch.knowledgeBundles[0].id;
}, { immediate: true });

watch([activeTab, () => orch.skills.length, () => orch.selectedSkillId], () => {
  if (activeTab.value !== "skills" || skillView.value !== "owned") return;
  if (orch.selectedSkillId) return;
  if (orch.skills[0]) orch.selectedSkillId = orch.skills[0].id;
}, { immediate: true });

watch([activeTab, () => orch.toolsets.length, () => orch.selectedToolsetId], () => {
  if (activeTab.value !== "tools") return;
  if (orch.selectedToolsetId) return;
  if (orch.toolsets[0]) orch.selectedToolsetId = orch.toolsets[0].id;
}, { immediate: true });

const countByTab = computed<Record<OrchTab, number>>(() => ({
  tasks: orch.intakeComposerOpen || orch.selectedIntakeId ? 1 : 0,
  proposals: scopedProposals.value.length,
  runs: scopedInstances.value.length,
  artifacts: scopedArtifactCount.value,
  workflows: orch.workflows.length,
  roles: orch.roles.length,
  knowledge: orch.knowledgeBundles.length,
  skills: orch.skills.length,
  tools: orch.toolsets.length,
  mcp: 0,
}));

function tabCountLabel(tab: OrchTab): string | number {
  if (awaitingWorkspaceRuntime.value && isWorkspaceTab(tab)) return "...";
  return loadingByTab.value[tab] ? "..." : countByTab.value[tab];
}

function openWorkspaceRoute() {
  if (routeSection.value !== "workspace") {
    void router.push("/orchestration/workspace");
  }
}

function openAssetsRoute() {
  if (routeSection.value !== "assets") {
    void router.push("/orchestration/assets");
  }
}

async function setWorkspaceTab(tab: WorkspaceTab): Promise<void> {
  if (!(await confirmBeforeAssetChange())) return;
  openWorkspaceRoute();
  orch.setActiveTab(tab);
}

async function setAssetTab(tab: AssetTab): Promise<void> {
  if (disabledAssetTabs.value.includes(tab)) {
    showExpiredFeaturePrompt();
    return;
  }
  if (activeAssetView.value === "assets" && activeAssetTab.value === tab) return;
  if (!(await confirmBeforeAssetChange())) return;
  activeAssetView.value = "assets";
  openAssetsRoute();
  orch.setActiveTab(tab);
}

/** 从横排资产标签切换资产类型，入口先校验类型再复用原切换流程。 */
function handleAssetSegmentChange(value: string | number): void {
  if (!isAssetTab(value as OrchTab)) return;
  void setAssetTab(value as AssetTab);
}

/** 打开助手工作区；助手模式只影响当前布局，不写入编排资产 tab 状态。 */
async function openAssistantPanel(): Promise<void> {
  if (activeAssetView.value === "assistant") return;
  if (!(await confirmBeforeAssetChange())) return;
  activeAssetView.value = "assistant";
  openAssetsRoute();
}

/** 从助手候选卡跳回正式 Agent 表单继续检查。 */
async function handleAssistantOpenRole(roleId: RoleId): Promise<void> {
  if (!(await confirmBeforeAssetChange())) return;
  activeAssetView.value = "assets";
  openAssetsRoute();
  orch.selectedRoleId = roleId;
  orch.setActiveTab("roles");
}

/** 从助手候选卡跳回正式 Skill 表单继续检查。 */
async function handleAssistantOpenSkill(skillId: SkillId): Promise<void> {
  if (!(await confirmBeforeAssetChange())) return;
  activeAssetView.value = "assets";
  openAssetsRoute();
  orch.selectedSkillId = skillId;
  skillView.value = "owned";
  orch.setActiveTab("skills");
}

/** 请求助手面板打开新建会话弹框；真正启动由弹框确认后完成。 */
async function requestAssistantConversationCreate(): Promise<void> {
  if (!(await confirmBeforeAssetChange())) return;
  activeAssetView.value = "assistant";
  openAssetsRoute();
  assistantCreateKey.value += 1;
}

/** 在切换资产或打开创建入口前确认编辑器状态，保存失败时停止后续动作。 */
function confirmBeforeAssetChange(): Promise<boolean> {
  const editor = assetEditorRef.value;
  if (!editor?.hasUnsavedChanges()) return Promise.resolve(true);
  if (assetUnsavedModalOpen.value) return Promise.resolve(false);
  assetUnsavedConfirmEpoch += 1;
  assetUnsavedModalOpen.value = true;
  return new Promise((resolve) => {
    resolveAssetUnsavedConfirm = resolve;
  });
}

/** 切换 Skill 市场/平台 Skill 子视图，切前确认编辑器状态防止丢草稿。 */
function onSkillViewChange(next: string | number): void {
  const value = next as SkillView;
  if (value === skillView.value) return;
  void (async () => {
    if (await confirmBeforeAssetChange()) skillView.value = value;
  })();
}

/** 切回「平台 Skill」时重新加载编排技能列表（默认停在 Skill 市场时不会加载）。 */
watch(skillView, (view) => {
  if (view !== "owned") return;
  if (!canHydrateOrchestrationView() || !presence.isCurrentWorkspaceClientOnline) return;
  visibleHydrationRevision += 1;
  scheduleVisibleOrchestrationHydration();
});

/** 关闭未保存确认弹框，并把本次切换结果返回给调用方。 */
function resolveAssetUnsavedModal(confirmed: boolean, epoch = assetUnsavedConfirmEpoch): void {
  if (epoch !== assetUnsavedConfirmEpoch) return;
  assetUnsavedModalOpen.value = false;
  const resolve = resolveAssetUnsavedConfirm;
  resolveAssetUnsavedConfirm = null;
  resolve?.(confirmed);
}

/** Invalidates an old editor confirmation before workspace or KeepAlive scope changes. */
function cancelAssetUnsavedScope(): void {
  assetUnsavedConfirmEpoch += 1;
  assetUnsavedModalOpen.value = false;
  assetUnsavedModalSaving.value = false;
  const resolve = resolveAssetUnsavedConfirm;
  resolveAssetUnsavedConfirm = null;
  resolve?.(false);
}

/** 保存当前资产草稿，保存成功后允许继续待处理动作。 */
async function savePendingAssetSwitch(): Promise<void> {
  const editor = assetEditorRef.value;
  if (!editor) {
    resolveAssetUnsavedModal(true);
    return;
  }
  const epoch = assetUnsavedConfirmEpoch;
  assetUnsavedModalSaving.value = true;
  try {
    const saved = await editor.saveCurrentDraft();
    if (saved) resolveAssetUnsavedModal(true, epoch);
  } finally {
    if (epoch === assetUnsavedConfirmEpoch) assetUnsavedModalSaving.value = false;
  }
}

/** 放弃当前资产草稿修改，并允许继续待处理动作。 */
function discardPendingAssetSwitch(): void {
  assetEditorRef.value?.discardUnsavedChanges();
  resolveAssetUnsavedModal(true);
}

/** 取消本次切换，保留当前未保存草稿。 */
function cancelPendingAssetSwitch(): void {
  if (assetUnsavedModalSaving.value) return;
  resolveAssetUnsavedModal(false);
}

/** 从后端恢复最近助手草案任务，刷新后仍能显示左侧会话列表。 */
async function refreshAssistantSessions(preferredJobId: AssetGenerationJobId | null = activeAssistantJobId.value): Promise<void> {
  assistantSessionsLoading.value = true;
  assistantSessionsError.value = "";
  try {
    const res = await listAssetAssistantJobs(ctx.value, { workspaceId: props.workspaceId, limit: 30 });
    if (!res.ok) throw new Error(res.message || "加载助手会话失败");
    assistantSessions.value = res.jobs;
    const preferred = preferredJobId && res.jobs.some((item) => item.job.id === preferredJobId) ? preferredJobId : null;
    activeAssistantJobId.value = preferred ?? res.jobs[0]?.job.id ?? null;
  } catch (error) {
    assistantSessionsError.value = error instanceof Error ? error.message : "加载助手会话失败";
  } finally {
    assistantSessionsLoading.value = false;
  }
}

/** 选择左侧助手会话后由主面板恢复真实 asset-draft 会话。 */
function selectAssistantSession(jobId: AssetGenerationJobId): void {
  activeAssetView.value = "assistant";
  openAssetsRoute();
  activeAssistantJobId.value = jobId;
}

/** 确认删除助手会话；后端会同时清理草案任务和关联 thread。 */
function confirmDeleteAssistantSession(session: OrchAssetDraftJobListItem): void {
  const title = assistantSessionTitle(session);
  Modal.confirm({
    title: "删除助手会话",
    content: isExecutingAssistantSession(session.job.status)
      ? `「${title}」仍在生成。删除时会先停止本轮生成，再清理助手会话和候选草稿记录。`
      : `确定要删除「${title}」吗？删除后会清理该助手草案会话和候选草稿记录。`,
    okText: "删除",
    okType: "danger",
    cancelText: "取消",
    async onOk() {
      setAssistantSessionDeleting(session.job.id, true);
      try {
        const res = await deleteAssetAssistantJob(ctx.value, { workspaceId: props.workspaceId, jobId: session.job.id });
        if (!res.ok) throw new Error(res.message || "删除助手会话失败");
        assistantSessions.value = assistantSessions.value.filter((item) => item.job.id !== session.job.id);
        if (activeAssistantJobId.value === session.job.id) {
          activeAssistantJobId.value = assistantSessions.value[0]?.job.id ?? null;
        }
        message.success("助手会话已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除助手会话失败");
        throw error;
      } finally {
        setAssistantSessionDeleting(session.job.id, false);
      }
    },
  });
}

/** Panel 轮询到新状态时，增量更新左侧会话行。 */
function upsertAssistantSession(value: OrchAssetDraftJobListItem): void {
  const next = assistantSessions.value.filter((item) => item.job.id !== value.job.id);
  next.unshift(value);
  assistantSessions.value = next.sort((a, b) => b.job.updatedAt - a.job.updatedAt);
}

/** Panel 新建或切换活动任务后，同步左侧选中态。 */
function updateActiveAssistantJobId(value: AssetGenerationJobId | null): void {
  activeAssistantJobId.value = value;
}

/** 助手会话删除状态用新 Set 赋值，保证 Vue 能追踪按钮 disabled。 */
function setAssistantSessionDeleting(jobId: AssetGenerationJobId, deleting: boolean): void {
  const next = new Set(assistantSessionDeletingIds.value);
  if (deleting) next.add(jobId);
  else next.delete(jobId);
  assistantSessionDeletingIds.value = next;
}

/** 判断删除前是否需要先停止生成。 */
function isExecutingAssistantSession(status: AssetGenerationJobStatus): boolean {
  return status === "queued"
    || status === "planning"
    || status === "collecting_context"
    || status === "generating"
    || status === "validating";
}

/** 返回当前会话是否正在执行删除请求。 */
function isAssistantSessionDeleting(jobId: AssetGenerationJobId): boolean {
  return assistantSessionDeletingIds.value.has(jobId);
}

/** 根据草案任务生成左侧会话标题。 */
function assistantSessionTitle(item: OrchAssetDraftJobListItem): string {
  const target = item.job.assetKind === "skill" && item.job.targetAssetId
    ? orch.skills.find((skill) => skill.id === item.job.targetAssetId)?.name ?? ""
    : item.job.targetAssetId
    ? orch.roles.find((role) => role.id === item.job.targetAssetId)?.name ?? ""
    : "";
  if (target) return `${item.job.mode === "revise" ? "优化" : "创建"} ${target}`;
  const promptTitle = firstTextLine(item.job.prompt);
  if (promptTitle) return promptTitle;
  const label = item.job.assetKind === "skill" ? "Skill" : "Agent";
  return item.job.mode === "revise" ? `优化 ${label}` : `创建 ${label}`;
}

/** 根据草案任务生成左侧会话状态与时间。 */
function assistantSessionMeta(item: OrchAssetDraftJobListItem): string {
  return `${assistantJobStatusLabel(item.job.status)} · ${formatShortTime(item.job.updatedAt)}`;
}

/** 资产草案任务状态转成用户可读短标签。 */
function assistantJobStatusLabel(status: AssetGenerationJobStatus): string {
  const map: Record<AssetGenerationJobStatus, string> = {
    queued: "排队中",
    planning: "分析中",
    collecting_context: "收集上下文",
    generating: "生成中",
    validating: "校验中",
    awaiting_input: "待补充",
    awaiting_review: "待确认",
    applied: "已应用",
    rejected: "已拒绝",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] ?? status;
}

/** 取首行短文本作为会话标题，避免左侧列表被长 prompt 撑开。 */
function firstTextLine(value: string): string {
  return String(value ?? "").split(/\r?\n/)[0]?.trim().slice(0, 32) ?? "";
}

/** 已过期的付费能力点击时统一弹出续费提示。 */
function showExpiredFeaturePrompt() {
  Modal.warning({
    title: "套餐已到期",
    content: "该功能暂无法使用。如需使用请尽快续费。",
    okText: "知道了",
  });
}

async function handleEmbeddedSelectionChange(rawValue: string) {
  const value = String(rawValue ?? "").trim();
  if (!value) return;
  if (activeTab.value === "artifacts") {
    orch.selectedInstanceId = value as OrchestrationId;
    try {
      await orch.loadInstance(ctx.value, props.workspaceId, value as OrchestrationId, {
        loadDetails: true,
        allowNetworkHydration: canHydrateOrchestrationView,
      });
    } catch (error) {
      console.error("[OrchestrationLayout] artifact selection hydration failed", {
        ...errorDiagnosticContext(error, "ORCH_ARTIFACT_SELECTION_HYDRATION_FAILED"),
        workspaceId: String(props.workspaceId),
        instanceId: value,
      });
      message.error(error instanceof Error ? error.message : "加载实例产出物失败");
    }
  }
}

function isAssetTab(tab: OrchTab): tab is AssetTab {
  return tab === "workflows" || tab === "roles" || tab === "knowledge" || tab === "skills" || tab === "tools" || tab === "mcp";
}

function isWorkspaceTab(tab: OrchTab): tab is WorkspaceTab {
  return tab === "tasks";
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function instanceStatusLabel(status: OrchestrationStatus): string {
  const map: Record<OrchestrationStatus, string> = {
    pending: "等待中",
    running: "执行中",
    paused: "已暂停",
    "waiting-start": "等待启动",
    "waiting-approval": "等待审核",
    "waiting-feedback": "等待补充",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return map[status] ?? status;
}

function summaryToneClass(tone: string | null | undefined): string {
  switch (tone) {
    case "success":
      return "orch-layout__workspace-status--success";
    case "warning":
      return "orch-layout__workspace-status--warning";
    case "danger":
      return "orch-layout__workspace-status--danger";
    case "neutral":
      return "orch-layout__workspace-status--neutral";
    default:
      return "orch-layout__workspace-status--info";
  }
}
</script>

<template>
  <div class="orch-layout">
    <div
      v-if="routeSection === 'workspace'"
      class="orch-layout__body orch-layout__body--workspace"
      :class="{ 'orch-layout__body--sidebar-collapsed': desktopSidebarCollapsed }"
      :style="desktopGridStyle"
    >
      <aside
        class="orch-layout__sidebar orch-layout__sidebar--resizable"
        data-testid="left-sidebar"
        :class="{ 'orch-layout__sidebar--collapsed': desktopSidebarCollapsed }"
      >
        <div
          id="orch-workspace-left-sidebar-content"
          class="orch-layout__sidebar-viewport"
          data-testid="left-sidebar-scrollport"
          :inert="desktopSidebarCollapsed"
          :aria-hidden="desktopSidebarCollapsed"
        >
          <TaskEntrySidebar v-if="!previewReadonly" :workspace-id="workspaceId" />
          <div v-else class="orch-layout__preview-sidebar">
            <div class="orch-layout__asset-tabs-row thread-list__tabs-row">
              <div class="orch-layout__asset-segmented thread-list__segmented" role="tablist" aria-label="需求分类">
                <button
                  v-for="(label, index) in previewWorkspaceTabs"
                  :key="label"
                  class="orch-layout__asset-segmented-item"
                  :class="{
                    'orch-layout__asset-segmented-item--active': index === 0,
                    'orch-layout__asset-segmented-item--disabled': index !== 0,
                  }"
                  type="button"
                  role="tab"
                  :aria-selected="index === 0"
                  aria-disabled="true"
                  disabled
                >
                  {{ label }}
                </button>
              </div>
            </div>
            <div class="orch-layout__preview-sidebar-empty">创建工作区后可查看需求列表</div>
          </div>
        </div>
        <DesktopPanelResizeHandle
          v-if="hasDesktopSidebar"
          v-show="!desktopSidebarCollapsed"
          :value="desktopLeftSidebarWidth ?? 360"
          :min="300"
          :max="desktopLeftSidebarMaxWidth ?? 520"
          @resize-start="emit('left-sidebar-resize-start')"
          @resize-preview="emit('left-sidebar-resize-preview', $event)"
          @resize-commit="emit('left-sidebar-resize-commit', $event)"
          @resize-cancel="emit('left-sidebar-resize-cancel')"
        />
      </aside>

      <main class="orch-layout__content orch-layout__content--workspace">
        <div v-if="showClientStartupGuide" class="orch-layout__guide-banner">
          <ClientStartupBanner :runtime-state="activeWorkspaceRuntimeState" />
        </div>
        <div v-if="previewReadonly" class="orch-layout__preview-banner">
          当前为预览模式，内容只读；创建或选择工作区后即可使用完整功能。
        </div>
        <div class="orch-layout__panel orch-layout__panel--workspace">
          <RequirementAnalysisWorkspace
            v-if="!previewReadonly && analysis.viewMode === 'analysis'"
            :workspace-id="workspaceId"
          />
          <TaskIntakePanel v-else-if="!previewReadonly" :workspace-id="workspaceId" />
          <div v-else class="orch-layout__asset-readonly orch-layout__preview-guide">
            <span class="orch-layout__asset-readonly-badge">预览模式</span>
            <strong>创建工作区后开始编排</strong>
            <p>需求编排用来把原始需求梳理成可执行方案，并跟踪执行过程与产出结果。当前没有可用工作区，这里只展示模块结构，不提供任何写入口。</p>
            <p>创建或选择工作区后，即可记录需求、生成方案、发起执行并查看结果。</p>
          </div>
        </div>
      </main>
    </div>

    <template v-else>
      <div
        class="orch-layout__asset-shell"
        :class="{
          'orch-layout__asset-shell--sidebar-collapsed': desktopSidebarCollapsed,
        }"
        :style="desktopGridStyle"
      >
        <aside
          class="orch-layout__sidebar orch-layout__sidebar--assets orch-layout__sidebar--resizable"
          data-testid="left-sidebar"
          :class="{
            'orch-layout__sidebar--assistant': activeAssetView === 'assistant',
            'orch-layout__sidebar--collapsed': desktopSidebarCollapsed,
          }"
        >
          <div
            id="orch-assets-left-sidebar-content"
            class="orch-layout__sidebar-viewport"
            data-testid="left-sidebar-scrollport"
            :inert="desktopSidebarCollapsed"
            :aria-hidden="desktopSidebarCollapsed"
          >
            <div
              id="orch-asset-toolbar-host"
              class="orch-layout__asset-toolbar-host orch-layout__asset-toolbar-host--asset orch-layout__asset-toolbar-scope"
              :class="{ 'orch-layout__asset-toolbar-host--hidden': activeAssetView !== 'assets' }"
            >
            </div>
            <div v-if="!previewReadonly && activeAssetView === 'assistant'" class="orch-layout__assistant-search orch-layout__asset-toolbar-host">
            <SearchOutlined class="orch-layout__assistant-search-icon" />
            <input v-model="assistantSessionSearchText" class="orch-layout__assistant-search-input" placeholder="搜索会话..." />
            <div class="orch-layout__assistant-search-actions" aria-label="助手会话操作">
              <a-tooltip title="AI创建 Agent / Skill">
                <span class="orch-layout__assistant-tooltip-wrap">
                  <button
                    class="orch-layout__assistant-icon-action orch-layout__assistant-icon-action--primary"
                    type="button"
                    aria-label="新建助手会话"
                    @click="requestAssistantConversationCreate"
                  >
                    <PlusOutlined />
                  </button>
                </span>
              </a-tooltip>
            </div>
            </div>

            <nav class="orch-layout__asset-nav" aria-label="编排资产管理">
            <section class="orch-layout__asset-nav-section orch-layout__asset-tabs-section">
              <div class="orch-layout__asset-tabs-row thread-list__tabs-row">
                <div class="orch-layout__asset-segmented thread-list__segmented" role="tablist" aria-label="资产库分类">
                  <button
                    v-for="option in assetSegmentedOptions"
                    :key="option.value"
                    class="orch-layout__asset-segmented-item"
                    :class="{
                      'orch-layout__asset-segmented-item--active': activeAssetView === 'assets' && activeAssetTab === option.value,
                      'orch-layout__asset-segmented-item--disabled': option.disabled,
                    }"
                    type="button"
                    role="tab"
                    :aria-selected="activeAssetView === 'assets' && activeAssetTab === option.value"
                    :aria-disabled="option.disabled"
                    @click="handleAssetSegmentChange(option.value)"
                  >
                    {{ option.label }}
                  </button>
                  <template v-if="!previewReadonly">
                  <a-tooltip :title="plannedAssetNavMeta.assistant.label">
                    <button
                      class="orch-layout__asset-segmented-item orch-layout__asset-segmented-item--assistant"
                      :class="{ 'orch-layout__asset-segmented-item--active': activeAssetView === 'assistant' }"
                      type="button"
                      role="tab"
                      :aria-label="plannedAssetNavMeta.assistant.label"
                      :aria-selected="activeAssetView === 'assistant'"
                      @click="openAssistantPanel"
                    >
                      AI
                    </button>
                  </a-tooltip>
                  </template>
                </div>
              </div>
            </section>
            </nav>

            <section v-if="previewReadonly" class="orch-layout__asset-sidebar-card">
              <div class="orch-layout__asset-column-body orch-layout__asset-preview-list">
                <div v-if="previewListError" class="orch-layout__asset-preview-hint orch-layout__asset-preview-hint--error">
                  内置资产暂不可用
                </div>
                <div v-else-if="previewListLoading" class="orch-layout__asset-preview-hint">内置资产加载中...</div>
                <div v-else-if="!previewListItems.length" class="orch-layout__asset-preview-hint">
                  {{ previewListEmptyText }}
                </div>
                <template v-else>
                  <button
                    v-for="item in previewListItems"
                    :key="item.assetId"
                    class="orch-layout__asset-preview-item"
                    :class="{ 'orch-layout__asset-preview-item--active': item.assetId === previewSelectedId }"
                    type="button"
                    :aria-pressed="item.assetId === previewSelectedId"
                    @click="previewSelectedId = item.assetId"
                  >
                    <span class="orch-layout__asset-preview-item-name">{{ item.definition.name }}</span>
                    <small class="orch-layout__asset-preview-item-meta">内置只读 · 修订 {{ item.revision }}</small>
                  </button>
                </template>
              </div>
            </section>

            <section v-else-if="activeAssetView === 'assets' && activeAssetTab !== 'mcp' && !isSkillMarketView" class="orch-layout__asset-sidebar-card">
            <div class="orch-layout__asset-column-body orch-layout__asset-toolbar-scope">
              <KnowledgeBundleList
                v-if="activeAssetTab === 'knowledge'"
                :workspace-id="workspaceId"
                :locked="knowledgeToolsetLocked"
                :maintenance-forbidden="assetDefinitionLocked"
                :before-asset-change="confirmBeforeAssetChange"
                :toolbar-teleport-target="assetToolbarTeleportTarget"
                :can-copy-builtin="desktopLocalWorkspace"
                :copying-builtin-asset-id="copyingBuiltinAssetId"
                @copy-builtin="copyBuiltinAsset('knowledge_bundle', $event)"
              />
              <ToolsetList
                v-else-if="activeAssetTab === 'tools'"
                :workspace-id="workspaceId"
                :locked="knowledgeToolsetLocked"
                :maintenance-forbidden="assetDefinitionLocked"
                :before-asset-change="confirmBeforeAssetChange"
                :toolbar-teleport-target="assetToolbarTeleportTarget"
                :can-copy-builtin="desktopLocalWorkspace"
                :copying-builtin-asset-id="copyingBuiltinAssetId"
                @copy-builtin="copyBuiltinAsset('toolset', $event)"
              />
              <SkillList
                v-else-if="activeAssetTab === 'skills'"
                :workspace-id="workspaceId"
                :locked="knowledgeToolsetLocked"
                :maintenance-forbidden="assetDefinitionLocked"
                :before-asset-change="confirmBeforeAssetChange"
                :toolbar-teleport-target="assetToolbarTeleportTarget"
                :can-copy-builtin="desktopLocalWorkspace"
                :copying-builtin-asset-id="copyingBuiltinAssetId"
                @copy-builtin="copyBuiltinAsset('skill', $event)"
              />
              <RoleList
                v-else-if="activeAssetTab === 'roles'"
                :workspace-id="workspaceId"
                :maintenance-forbidden="assetDefinitionLocked"
                :before-asset-change="confirmBeforeAssetChange"
                :toolbar-teleport-target="assetToolbarTeleportTarget"
                :can-copy-builtin="desktopLocalWorkspace"
                :copying-builtin-asset-id="copyingBuiltinAssetId"
                @copy-builtin="copyBuiltinAsset('role', $event)"
              />
              <WorkflowSidebar
                v-else-if="activeAssetTab === 'workflows'"
                :workspace-id="workspaceId"
                :maintenance-forbidden="assetDefinitionLocked"
                :before-asset-change="confirmBeforeAssetChange"
                :toolbar-teleport-target="assetToolbarTeleportTarget"
                :can-copy-builtin="desktopLocalWorkspace"
                :copying-builtin-asset-id="copyingBuiltinAssetId"
                @copy-builtin="copyBuiltinAsset('workflow', $event)"
              />
            </div>
            </section>

            <div
              id="orch-mcp-sidebar-host"
              class="orch-layout__mcp-sidebar-host"
              :class="{ 'orch-layout__mcp-sidebar-host--hidden': activeAssetView !== 'assets' || activeAssetTab !== 'mcp' }"
            />

            <div
              id="orch-skill-market-sidebar-host"
              class="orch-layout__skill-market-sidebar-host"
              :class="{ 'orch-layout__skill-market-sidebar-host--hidden': activeAssetView !== 'assets' || !isSkillMarketView }"
            />

            <section v-if="!previewReadonly && activeAssetView === 'assistant'" class="orch-layout__asset-sidebar-card">
            <div class="orch-layout__asset-column-body orch-layout__assistant-column">
              <div v-if="assistantSessionsError" class="orch-layout__assistant-hint orch-layout__assistant-hint--error">
                {{ assistantSessionsError }}
              </div>
              <div
                v-for="session in filteredAssistantSessions"
                :key="session.job.id"
                class="orch-layout__assistant-session"
                :class="{ 'orch-layout__assistant-session--active': activeAssistantJobId === session.job.id }"
                role="button"
                tabindex="0"
                @click="selectAssistantSession(session.job.id)"
                @keydown.enter.prevent="selectAssistantSession(session.job.id)"
                @keydown.space.prevent="selectAssistantSession(session.job.id)"
              >
                <div class="orch-layout__assistant-session-titlebar">
                  <span
                    class="orch-layout__assistant-session-kind"
                    :class="{ 'orch-layout__assistant-session-kind--skill': session.job.assetKind === 'skill' }"
                  >{{ session.job.assetKind === "skill" ? "Skill" : "Agent" }}</span>
                  <span class="orch-layout__assistant-session-title">{{ assistantSessionTitle(session) }}</span>
                </div>
                <small class="orch-layout__assistant-session-meta">{{ assistantSessionMeta(session) }}</small>
                <a-tooltip title="删除会话">
                  <button
                    class="orch-layout__assistant-session-delete"
                    type="button"
                    :disabled="isAssistantSessionDeleting(session.job.id)"
                    aria-label="删除助手会话"
                    @click.stop="confirmDeleteAssistantSession(session)"
                  >
                    <DeleteOutlined />
                  </button>
                </a-tooltip>
              </div>
              <div v-if="!assistantSessionsLoading && !assistantSessionsError && filteredAssistantSessions.length === 0" class="orch-layout__assistant-hint">
                {{ assistantSessions.length === 0 ? "暂无助手会话" : "没有匹配的会话" }}
              </div>
            </div>
            </section>
          </div>
          <DesktopPanelResizeHandle
            v-if="hasDesktopSidebar"
            v-show="!desktopSidebarCollapsed"
            :value="desktopLeftSidebarWidth ?? 360"
            :min="300"
            :max="desktopLeftSidebarMaxWidth ?? 520"
            @resize-start="emit('left-sidebar-resize-start')"
            @resize-preview="emit('left-sidebar-resize-preview', $event)"
            @resize-commit="emit('left-sidebar-resize-commit', $event)"
            @resize-cancel="emit('left-sidebar-resize-cancel')"
          />
        </aside>

        <main
          class="orch-layout__content orch-layout__content--asset"
          data-testid="desktop-main-pane"
        >
          <div
            v-if="!previewReadonly && showClientStartupGuide"
            class="orch-layout__guide-banner"
          >
            <ClientStartupBanner :runtime-state="activeWorkspaceRuntimeState" />
          </div>
          <div v-if="previewReadonly" class="orch-layout__preview-banner">
            当前为预览模式，内容只读；创建或选择工作区后即可使用完整功能。
          </div>
          <div v-if="previewReadonly" class="orch-layout__panel orch-layout__panel--asset">
            <div v-if="previewListError" class="orch-layout__asset-state orch-layout__asset-state--error">
              <strong>内置资产暂不可用</strong>
              <p>{{ previewListError }}</p>
              <a-button type="primary" @click="retryPreviewAssets">
                <template #icon><ReloadOutlined /></template>
                重新加载
              </a-button>
            </div>

            <div v-else-if="previewListLoading" class="orch-layout__asset-state">
              <a-spin size="large" />
              <span>内置资产加载中...</span>
            </div>

            <div v-else-if="!previewSelectedItem" class="orch-layout__asset-state">
              <strong>{{ previewListEmptyText }}</strong>
              <p>创建工作区后即可维护自己的流程、Agent、知识库、工具、Skills 与 MCP 服务。</p>
            </div>

            <template v-else>
              <RoleDefinitionForm
                v-if="previewRole"
                :workspace-id="''"
                :role-id="previewRole.id"
                :source-definition="previewRole"
                :preview-readonly="true"
              />
              <WorkflowEditor
                v-else-if="previewWorkflow"
                :workspace-id="''"
                :workflow-id="previewWorkflow.id"
                :source-definition="previewWorkflow"
                :preview-readonly="true"
              />
              <KnowledgeBundleForm
                v-else-if="previewKnowledgeBundle"
                :workspace-id="''"
                :bundle-id="previewKnowledgeBundle.id"
                :source-definition="previewKnowledgeBundle"
                :preview-readonly="true"
              />
              <ToolsetForm
                v-else-if="previewToolset"
                :workspace-id="''"
                :toolset-id="previewToolset.id"
                :source-definition="previewToolset"
                :preview-readonly="true"
              />
              <SkillForm
                v-else-if="previewSkill"
                :workspace-id="''"
                :skill-id="previewSkill.id"
                :source-definition="previewSkill"
                :preview-readonly="true"
              />
            </template>
          </div>
          <div v-else class="orch-layout__panel orch-layout__panel--asset">
            <div v-if="activeAssetView === 'assets' && activeAssetTab === 'skills'" class="orch-layout__skill-view-switch" data-testid="skill-view-switch" role="group" aria-label="Skill 视图">
              <button
                v-for="option in skillViewOptions"
                :key="option.value"
                type="button"
                class="orch-layout__skill-view-option"
                :class="{ 'is-active': skillView === option.value }"
                :aria-pressed="skillView === option.value"
                @click="onSkillViewChange(option.value)"
              >{{ option.label }}</button>
            </div>
            <a-alert v-if="assetPageLoadError && activeAssetDataAvailable && !isSkillMarketView"
              type="error" show-icon message="部分资产加载失败，已显示可用资产" :description="assetPageLoadError">
              <template #action><a-button size="small" @click="retryAssetPageLoad">重新加载</a-button></template>
            </a-alert>
            <a-alert v-if="selectedHostAsset && !selectedBuiltinAsset" type="info" show-icon
              message="Host 共享资产只读，请在承载工作区维护原定义" />
            <div v-if="assetPageLoading && !activeAssetDataAvailable && !isSkillMarketView" class="orch-layout__asset-state">
              <a-spin size="large" />
              <span>资产加载中...</span>
            </div>

            <div v-else-if="assetPageLoadError && !activeAssetDataAvailable && !isSkillMarketView" class="orch-layout__asset-state orch-layout__asset-state--error">
              <strong>资产加载失败</strong>
              <p>{{ assetPageLoadError }}</p>
              <a-button type="primary" @click="retryAssetPageLoad">
                <template #icon><ReloadOutlined /></template>
                重新加载
              </a-button>
            </div>

            <div v-else-if="assetPageLocked && !isSkillMarketView" class="orch-layout__asset-readonly">
              <span class="orch-layout__asset-readonly-badge">共享工作区成员</span>
              <strong>共享资产维护未授权</strong>
              <p>{{ assetMaintenanceLockReason }}</p>
              <p>你仍可在需求页选择共享流程、角色、知识库、工具和 Skills 参与执行；本页不提供新建、导入、导出、删除或保存定义的入口，也不支持克隆到个人私域自改。</p>
            </div>

            <AssetAssistantPanel
              v-else-if="activeAssetView === 'assistant'"
              :workspace-id="workspaceId"
              :maintenance-forbidden="assetPageLocked"
              :create-key="assistantCreateKey"
              :selected-job-id="activeAssistantJobId"
              @open-role="handleAssistantOpenRole"
              @open-skill="handleAssistantOpenSkill"
              @active-job-change="updateActiveAssistantJobId"
              @session-upsert="upsertAssistantSession"
              @sessions-refresh="refreshAssistantSessions"
            />

            <template v-else-if="activeAssetTab === 'mcp'">
              <McpManagementPanel :open="activeAssetView === 'assets'" />
            </template>

            <template v-else-if="activeAssetTab === 'knowledge'">
              <KnowledgeBundleForm
                v-if="orch.selectedKnowledgeBundleId"
                ref="assetEditorRef"
                :workspace-id="workspaceId"
                :bundle-id="orch.selectedKnowledgeBundleId"
                :preview-readonly="selectedAssetReadonly"
                :save-label="desktopLocalWorkspace ? '保存' : '保存草稿'"
              />
              <div v-else class="orch-layout__empty">从左侧列表选择一个知识库，或先新建一个知识库。</div>
            </template>

            <template v-else-if="activeAssetTab === 'tools'">
              <ToolsetForm
                v-if="orch.selectedToolsetId"
                ref="assetEditorRef"
                :workspace-id="workspaceId"
                :toolset-id="orch.selectedToolsetId"
                :preview-readonly="selectedAssetReadonly"
                :save-label="desktopLocalWorkspace ? '保存' : '保存草稿'"
              />
              <div v-else class="orch-layout__empty">从左侧列表选择一个工具，或先新建一个工具。</div>
            </template>

            <template v-else-if="activeAssetTab === 'skills'">
              <SkillForm
                v-if="skillView === 'owned' && orch.selectedSkillId"
                ref="assetEditorRef"
                :workspace-id="workspaceId"
                :skill-id="orch.selectedSkillId"
                :preview-readonly="selectedAssetReadonly"
                :save-label="desktopLocalWorkspace ? '保存' : '保存草稿'"
              />
              <div v-else-if="skillView === 'owned'" class="orch-layout__empty">从左侧列表选择一个 Skill，或先新建一个 Skill。</div>
              <SkillMarketplacePanel v-else :open="activeAssetView === 'assets'" />
            </template>

            <template v-else-if="activeAssetTab === 'roles'">
              <RoleDefinitionForm
                v-if="orch.selectedRoleId"
                ref="assetEditorRef"
                :workspace-id="workspaceId"
                :role-id="orch.selectedRoleId"
                :preview-readonly="selectedAssetReadonly"
                :save-label="desktopLocalWorkspace ? '保存' : '保存草稿'"
              />
              <div v-else class="orch-layout__empty">从左侧列表选择一个角色，或先新建一个角色。</div>
            </template>

            <template v-else-if="activeAssetTab === 'workflows'">
              <WorkflowEditor
                v-if="orch.selectedWorkflowId"
                ref="assetEditorRef"
                :workspace-id="workspaceId"
                :workflow-id="orch.selectedWorkflowId"
                :preview-readonly="selectedAssetReadonly"
                :role-definitions="orch.roles"
                save-label="保存"
              />
              <div v-else class="orch-layout__empty">从左侧列表选择一个流程，或先新建一个流程。</div>
            </template>

            <div v-if="activeAssetView === 'assets' && knowledgeToolsetLocked && (activeAssetTab === 'knowledge' || activeAssetTab === 'skills' || activeAssetTab === 'tools')" class="orch-layout__locked-mask">
              <div class="orch-layout__locked-card">
                <strong>套餐已到期</strong>
                <p>该功能暂无法使用。如需使用请尽快续费。</p>
              </div>
            </div>
          </div>
        </main>
      </div>
    </template>

    <a-modal
      :open="assetUnsavedModalOpen"
      title="当前资产有未保存修改"
      :mask-closable="false"
      :keyboard="!assetUnsavedModalSaving"
      wrap-class-name="orch-asset-modal"
      @cancel="cancelPendingAssetSwitch"
    >
      <p class="orch-layout__unsaved-text">
        切换资产前是否保存当前修改？
      </p>
      <template #footer>
        <div class="orch-layout__unsaved-actions">
          <button class="orch-layout__unsaved-btn" type="button" :disabled="assetUnsavedModalSaving" @click="cancelPendingAssetSwitch">取消</button>
          <button class="orch-layout__unsaved-btn" type="button" :disabled="assetUnsavedModalSaving" @click="discardPendingAssetSwitch">
            放弃修改
          </button>
          <button class="orch-layout__unsaved-btn orch-layout__unsaved-btn--primary" type="button" :disabled="assetUnsavedModalSaving" @click="savePendingAssetSwitch">
            {{ assetUnsavedModalSaving ? "保存中..." : "保存并切换" }}
          </button>
        </div>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.orch-layout {
  --orch-sidebar-width: 360px;
  --orch-sidebar-track-width: var(--orch-sidebar-width);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 12px;
}
.orch-layout__body,
.orch-layout__asset-shell {
  display: grid;
  grid-template-columns: var(--orch-sidebar-track-width) minmax(0, 1fr);
  gap: 0;
  min-height: 0;
  flex: 1;
  transition: grid-template-columns 180ms ease;
}

.orch-layout__sidebar,
.orch-layout__content {
  min-height: 0;
}

.orch-layout__sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 12px 0 12px 12px;
  border: none;
  border-right: 1px solid var(--app-divider, var(--app-border, #e8e8e8));
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow: hidden;
  transition: width 180ms ease;
}

.orch-layout__sidebar--resizable {
  position: relative;
  overflow: visible;
}

.orch-layout__sidebar--collapsed {
  overflow: hidden;
}

.orch-layout__sidebar-viewport {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  width: 100%;
  transition: transform 180ms ease;
}

.orch-layout__sidebar--collapsed .orch-layout__sidebar-viewport {
  transform: translateX(-100%);
  pointer-events: none;
  visibility: hidden;
}

.orch-layout__sidebar--collapsed .desktop-panel-resize-handle {
  opacity: 0;
  pointer-events: none;
}

.orch-layout__sidebar--assets {
  flex-direction: column;
  gap: 8px;
  padding: 12px;
}

@media (prefers-reduced-motion: reduce) {
  .orch-layout__body,
  .orch-layout__asset-shell,
  .orch-layout__sidebar,
  .orch-layout__sidebar-viewport {
    transition-duration: 0ms;
  }
}

.orch-layout__sidebar--assets .orch-layout__sidebar-viewport {
  gap: 8px;
}

.orch-layout__sidebar--assistant {
  justify-content: flex-start;
}

.orch-layout__content {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding-left: 16px;
}

.orch-layout__content--workspace {
  padding-left: 0;
}

.orch-layout__guide-banner {
  flex: 0 0 auto;
  padding: 12px 16px 0;
}

/* 无工作区只读预览提示条：仅在这两个模块的内容区顶部渲染，纯文本不带 CTA。 */
.orch-layout__preview-banner {
  flex: 0 0 auto;
  padding: 10px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #e8e8e8));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 68%, var(--app-text, #1f2937));
  font-size: 13px;
  line-height: 1.6;
}

/* 预览态左侧外壳：保留分栏与折叠开关，仅替换内容区。 */
.orch-layout__preview-sidebar {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.orch-layout__preview-sidebar-empty {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 12px;
  color: var(--app-muted, #999);
  font-size: 13px;
  text-align: center;
}

.orch-layout__workspace-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 94%, #fbf7f0), var(--app-bg, #fff));
  box-shadow: 0 8px 18px rgba(15, 23, 42, 0.035);
}

.orch-layout__workspace-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--app-text, #1f2937);
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.orch-layout__workspace-title-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.orch-layout__workspace-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  white-space: nowrap;
}

.orch-layout__workspace-status--info {
  background: rgba(22, 119, 255, 0.12);
  color: #0958d9;
}

.orch-layout__workspace-status--success {
  background: rgba(82, 196, 26, 0.14);
  color: #237804;
}

.orch-layout__workspace-status--warning {
  background: rgba(250, 173, 20, 0.16);
  color: #ad6800;
}

.orch-layout__workspace-status--danger {
  background: rgba(255, 77, 79, 0.14);
  color: #cf1322;
}

.orch-layout__workspace-status--neutral {
  background: rgba(148, 163, 184, 0.14);
  color: #475569;
}

.orch-layout__workspace-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px 8px;
  flex-wrap: wrap;
}

.orch-layout__workspace-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.orch-layout__workspace-meta {
  font-size: 11px;
  line-height: 1.2;
  color: var(--app-muted, #8b95a7);
}

.orch-layout__workspace-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.orch-layout__tab {
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border, #e8e8e8));
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #fbf6ee), var(--app-bg, #fff));
  border-radius: 12px;
  padding: 6px 9px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.orch-layout__tab--workspace {
  min-height: 24px;
  padding: 3px 7px;
  border-radius: 10px;
  gap: 6px;
  font-size: 11px;
}

.orch-layout__tab--workspace span {
  font-weight: 600;
}

.orch-layout__tab:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #e8e8e8));
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
}

.orch-layout__tab small {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--app-hover-bg, #f5f5f5);
  color: var(--app-muted, #666);
  font-size: 10px;
}

.orch-layout__tab--workspace small {
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  font-size: 9px;
}

.orch-layout__tab--active {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #e8e8e8));
  color: var(--app-accent);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent) 11%, #fff), color-mix(in srgb, var(--app-panel-bg, #fff) 96%, transparent));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent) 18%, transparent), 0 14px 28px rgba(15, 23, 42, 0.08);
}

.orch-layout__subhead {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
  padding: 0 4px;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.orch-layout__subhead-switcher {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.orch-layout__subhead-select {
  min-width: 220px;
  padding: 8px 12px;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 12%, var(--app-border, #d9d9d9));
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #fbf6ee), color-mix(in srgb, var(--app-bg, #fff) 100%, #ffffff));
  color: var(--app-text, #1f2937);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 0 rgba(255, 255, 255, 0.9);
}

.orch-layout__panel {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 18px;
  background: transparent;
  box-shadow: 0 14px 34px rgba(15, 23, 42, 0.05);
  overflow: auto;
}

.orch-layout__panel--workspace {
  padding: 0;
}

.orch-layout__panel--asset {
  padding: 14px;
  position: relative;
}

.orch-layout__panel--workspace,
.orch-layout__panel--asset {
  display: flex;
  flex-direction: column;
}

.orch-layout__panel--workspace > *,
.orch-layout__panel--asset > * {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.orch-layout__asset-nav {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 0 0 auto;
}

.orch-layout__asset-toolbar-host {
  flex: 0 0 auto;
  min-height: 0;
}

.orch-layout__asset-toolbar-host--asset {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 10px;
}

.orch-layout__asset-toolbar-host--hidden {
  display: none;
}

.orch-layout__asset-toolbar-host--asset :deep(.wf-sidebar__search),
.orch-layout__asset-toolbar-host--asset :deep(.role-list__search),
.orch-layout__asset-toolbar-host--asset :deep(.kb-sidebar__search),
.orch-layout__asset-toolbar-host--asset :deep(.tool-sidebar__search),
.orch-layout__asset-toolbar-host--asset :deep(.skill-sidebar__search) {
  order: 1;
  flex: 1 1 auto;
  min-width: 0;
}

.orch-layout__asset-nav-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.orch-layout__asset-tabs-row.thread-list__tabs-row {
  margin-bottom: 0;
}

.orch-layout__asset-segmented {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-muted) 6%, transparent);
}

.orch-layout__asset-segmented-item {
  flex: 1 1 0;
  min-width: 0;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-muted, #667085);
  cursor: pointer;
  font-size: 13px;
  line-height: 32px;
  white-space: nowrap;
  transition: color 150ms ease, background 150ms ease;
}

.orch-layout__asset-segmented-item:hover {
  color: var(--app-text, #1f2937);
}

.orch-layout__asset-segmented-item--active,
.orch-layout__asset-segmented-item--active:hover {
  background: var(--app-panel-bg, #fff);
  color: var(--app-accent, #d97757);
  font-weight: 600;
}

.orch-layout__asset-segmented-item--assistant {
  flex: 0 0 34px;
  width: 34px;
  padding: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0;
}

.orch-layout__asset-segmented-item--disabled {
  opacity: 0.56;
  cursor: not-allowed;
}

.orch-layout__asset-segmented-item--disabled:hover {
  color: var(--app-muted, #667085);
}

.orch-layout__asset-sidebar-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  overflow: hidden;
}

/* 预览态左侧只读列表：不挂载任何列表组件，只做只读浏览与选中。 */
.orch-layout__asset-preview-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  padding: 2px;
}

.orch-layout__asset-preview-hint {
  margin: auto;
  padding: 16px;
  color: var(--app-muted, #999);
  font-size: 13px;
  text-align: center;
}

.orch-layout__asset-preview-hint--error {
  color: var(--app-danger, #d4380d);
}

.orch-layout__asset-preview-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
  background: transparent;
  color: var(--app-text, #1f2937);
  text-align: left;
  cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease;
}

.orch-layout__asset-preview-item:hover {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #e8e8e8));
}

.orch-layout__asset-preview-item--active,
.orch-layout__asset-preview-item--active:hover {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg, #fff));
}

.orch-layout__asset-preview-item-name {
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.orch-layout__asset-preview-item-meta {
  color: var(--app-muted, #999);
  font-size: 11px;
}

.orch-layout__mcp-sidebar-host {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.orch-layout__mcp-sidebar-host--hidden {
  display: none;
}

.orch-layout__skill-market-sidebar-host {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.orch-layout__skill-market-sidebar-host--hidden {
  display: none;
}

.orch-layout__skill-view-switch {
  display: inline-flex;
  flex: 0 0 auto;
  align-self: flex-start;
  gap: 2px;
  padding: 3px;
  margin-bottom: 10px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-text, #1f2937) 4%, transparent);
}

.orch-layout__skill-view-option {
  appearance: none;
  border: 0;
  border-radius: 7px;
  padding: 5px 14px;
  background: transparent;
  color: var(--app-muted, #8b95a7);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, box-shadow 120ms ease;
}

.orch-layout__skill-view-option:hover {
  color: var(--app-text, #1f2937);
}

.orch-layout__skill-view-option.is-active {
  color: var(--app-accent, #c46a2a);
  background: var(--app-panel-bg, #fff);
  box-shadow: 0 1px 3px color-mix(in srgb, #000 10%, transparent);
}

.orch-layout__skill-view-option:focus-visible {
  outline: 2px solid var(--app-accent, #c46a2a);
  outline-offset: 1px;
}

.orch-layout__asset-column-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: transparent;
}

.orch-layout__asset-column-body :deep(.wf-sidebar),
.orch-layout__asset-column-body :deep(.role-list),
.orch-layout__asset-column-body :deep(.kb-sidebar),
.orch-layout__asset-column-body :deep(.tool-sidebar),
.orch-layout__asset-column-body :deep(.skill-sidebar) {
  background: transparent;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search),
.orch-layout__asset-toolbar-scope :deep(.role-list__search),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search) {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0;
  position: relative;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-input),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input) {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 34px;
  min-height: 34px;
  padding: 0 11px 0 30px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  border-radius: 12px;
  outline: none;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #333);
  font-size: 12px;
  line-height: 20px;
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03);
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-icon),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-icon),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-icon),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-icon),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-icon) {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  color: rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input::placeholder),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-input::placeholder),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input::placeholder),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input::placeholder),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input::placeholder) {
  color: rgba(0, 0, 0, 0.25);
  opacity: 1;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input:hover),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-input:hover),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input:hover),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input:hover),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input:hover) {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input:focus),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-input:focus),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input:focus),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input:focus),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input:focus) {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-actions),
.orch-layout__asset-toolbar-scope :deep(.role-list__search-actions),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-actions),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-actions),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-actions) {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__tooltip-wrap),
.orch-layout__asset-toolbar-scope :deep(.role-list__tooltip-wrap),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__tooltip-wrap),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__tooltip-wrap),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__tooltip-wrap) {
  display: inline-flex;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action) {
  width: 30px;
  min-width: 30px;
  height: 30px;
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #d9d9d9));
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text, #334155));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--app-accent) 8%, transparent);
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action:hover),
.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action:hover),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action:hover),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action:hover),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action:hover),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--app-accent) 12%, transparent);
  outline: none;
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action--primary),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action--primary),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action--primary),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action--primary),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action--primary) {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text, #334155));
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action--primary:hover),
.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action--primary:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action--primary:hover),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action--primary:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action--primary:hover),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action--primary:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action--primary:hover),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action--primary:focus-visible),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action--primary:hover),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action--primary:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
}

.orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action:disabled),
.orch-layout__asset-toolbar-scope :deep(.role-list__icon-action:disabled),
.orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action:disabled),
.orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action:disabled),
.orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action:disabled) {
  cursor: not-allowed;
  opacity: 0.4;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__items),
.orch-layout__asset-column-body :deep(.role-list__items),
.orch-layout__asset-column-body :deep(.kb-sidebar__items),
.orch-layout__asset-column-body :deep(.tool-sidebar__list),
.orch-layout__asset-column-body :deep(.skill-sidebar__items) {
  /* 左右与上方工具区对齐（左 0、右 10），否则列表看起来比搜索框那一行窄一截 */
  padding: 6px 10px 10px 0;
  background: transparent;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item),
.orch-layout__asset-column-body :deep(.role-list__item),
.orch-layout__asset-column-body :deep(.kb-sidebar__item),
.orch-layout__asset-column-body :deep(.tool-sidebar__item),
.orch-layout__asset-column-body :deep(.skill-sidebar__item) {
  min-height: 54px;
  border-color: transparent;
  border-radius: 8px;
  background: transparent;
  box-shadow: none;
  margin-bottom: 4px;
  padding-left: 10px;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item:hover),
.orch-layout__asset-column-body :deep(.role-list__item:hover),
.orch-layout__asset-column-body :deep(.kb-sidebar__item:hover),
.orch-layout__asset-column-body :deep(.tool-sidebar__item:hover),
.orch-layout__asset-column-body :deep(.skill-sidebar__item:hover) {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
  box-shadow: none;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item--selected),
.orch-layout__asset-column-body :deep(.role-list__item--selected),
.orch-layout__asset-column-body :deep(.kb-sidebar__item--selected),
.orch-layout__asset-column-body :deep(.tool-sidebar__item--selected),
.orch-layout__asset-column-body :deep(.skill-sidebar__item--selected),
.orch-layout__asset-column-body :deep(.wf-sidebar__item.wf-sidebar__item--selected:hover),
.orch-layout__asset-column-body :deep(.role-list__item.role-list__item--selected:hover),
.orch-layout__asset-column-body :deep(.kb-sidebar__item.kb-sidebar__item--selected:hover),
.orch-layout__asset-column-body :deep(.tool-sidebar__item.tool-sidebar__item--selected:hover),
.orch-layout__asset-column-body :deep(.skill-sidebar__item.skill-sidebar__item--selected:hover) {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item-icon),
.orch-layout__asset-column-body :deep(.role-list__item-icon),
.orch-layout__asset-column-body :deep(.kb-sidebar__item-icon),
.orch-layout__asset-column-body :deep(.tool-sidebar__item-icon),
.orch-layout__asset-column-body :deep(.skill-sidebar__item-icon) {
  width: 24px;
  height: 24px;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item-name),
.orch-layout__asset-column-body :deep(.role-list__item-name),
.orch-layout__asset-column-body :deep(.kb-sidebar__item-name),
.orch-layout__asset-column-body :deep(.tool-sidebar__item-name),
.orch-layout__asset-column-body :deep(.skill-sidebar__item-name) {
  font-size: 13px;
  line-height: 1.35;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__item-meta),
.orch-layout__asset-column-body :deep(.role-list__item-meta),
.orch-layout__asset-column-body :deep(.kb-sidebar__item-meta),
.orch-layout__asset-column-body :deep(.tool-sidebar__item-meta),
.orch-layout__asset-column-body :deep(.skill-sidebar__item-meta) {
  margin-top: 2px;
  line-height: 1.35;
}

.orch-layout__asset-column-body :deep(.wf-sidebar__empty),
.orch-layout__asset-column-body :deep(.role-list__empty),
.orch-layout__asset-column-body :deep(.kb-sidebar__empty),
.orch-layout__asset-column-body :deep(.tool-sidebar__empty),
.orch-layout__asset-column-body :deep(.skill-sidebar__empty) {
  border-radius: 10px;
}

.orch-layout__assistant-column {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px 10px;
  overflow: auto;
}

.orch-layout__assistant-search {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0;
  position: relative;
}

.orch-layout__assistant-search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  color: rgba(0, 0, 0, 0.35);
  pointer-events: none;
}

.orch-layout__assistant-search-input {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 34px;
  min-height: 34px;
  padding: 0 11px 0 30px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  border-radius: 12px;
  outline: none;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #333);
  font-size: 12px;
  line-height: 20px;
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03);
}

.orch-layout__assistant-search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}

.orch-layout__assistant-search-input:hover {
  border-color: color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
}

.orch-layout__assistant-search-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.orch-layout__assistant-tooltip-wrap {
  display: inline-flex;
}

.orch-layout__assistant-icon-action {
  width: 30px;
  min-width: 30px;
  height: 30px;
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #d9d9d9));
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text, #334155));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--app-accent) 8%, transparent);
  cursor: pointer;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease, box-shadow 0.16s ease;
}

.orch-layout__assistant-icon-action:hover,
.orch-layout__assistant-icon-action:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--app-accent) 12%, transparent);
  outline: none;
}

.orch-layout__assistant-icon-action--primary {
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent) 82%, var(--app-text, #334155));
}

.orch-layout__assistant-icon-action--primary:hover,
.orch-layout__assistant-icon-action--primary:focus-visible {
  border-color: color-mix(in srgb, var(--app-accent) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
}

.orch-layout__assistant-hint {
  border: 1px dashed var(--app-border, #e8e8e8);
  border-radius: 10px;
  padding: 10px 12px;
  color: var(--app-muted, #667085);
  font-size: 12px;
}

.orch-layout__assistant-hint--error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #991b1b;
}

.orch-layout__assistant-session {
  width: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex-shrink: 0;
  min-height: 50px;
  padding: 7px 38px 7px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text, #1f2937);
  cursor: pointer;
  text-align: left;
  transition: background 100ms ease, color 100ms ease;
}

.orch-layout__assistant-session:hover,
.orch-layout__assistant-session:focus-visible {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
  outline: none;
}

.orch-layout__assistant-session-titlebar {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.orch-layout__assistant-session-kind {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 1px 8px;
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  color: var(--app-accent);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.orch-layout__assistant-session-kind--skill {
  background: color-mix(in srgb, var(--app-success) 16%, transparent);
  color: var(--app-success);
}

.orch-layout__assistant-session-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 700;
  line-height: 1.4;
}

.orch-layout__assistant-session-meta {
  min-width: 0;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted, #667085);
  font-size: 11px;
  line-height: 1.4;
}

.orch-layout__assistant-session--active,
.orch-layout__assistant-session--active:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.orch-layout__assistant-session--active .orch-layout__assistant-session-title {
  color: var(--app-accent);
  font-weight: 600;
}

.orch-layout__assistant-session-delete {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 10px;
  background: none;
  color: var(--app-muted, #999);
  cursor: pointer;
  font-size: 12px;
  opacity: 0;
  transition: opacity 0.15s, background-color 0.16s ease, color 0.16s ease;
}

.orch-layout__assistant-session:hover .orch-layout__assistant-session-delete,
.orch-layout__assistant-session:focus-within .orch-layout__assistant-session-delete,
.orch-layout__assistant-session--active .orch-layout__assistant-session-delete {
  opacity: 1;
}

.orch-layout__assistant-session-delete:hover,
.orch-layout__assistant-session-delete:focus-visible {
  color: #ff4d4f;
  background: color-mix(in srgb, #ff4d4f 12%, transparent);
  outline: none;
}

.orch-layout__assistant-session-delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  color: var(--app-muted, #999);
  background: transparent;
}

.orch-layout__empty {
  min-height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 12px;
  color: var(--app-muted, #999);
  font-size: 14px;
  text-align: center;
  padding: 24px;
}

.orch-layout__unsaved-text {
  margin: 0;
  color: var(--app-text, #1f2937);
  line-height: 1.7;
}

.orch-layout__unsaved-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.orch-layout__unsaved-btn {
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-text, #1f2937);
  cursor: pointer;
}

.orch-layout__unsaved-btn--primary {
  border-color: var(--app-accent, #d97757);
  background: var(--app-accent, #d97757);
  color: #fff;
}

.orch-layout__unsaved-btn:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}

.orch-layout__asset-state {
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--app-muted, #667085);
}

.orch-layout__asset-state--error strong {
  color: var(--app-text, #1f2937);
  font-size: 16px;
}

.orch-layout__asset-state--error p {
  max-width: 560px;
  margin: 0;
  text-align: center;
}

.orch-layout__asset-readonly {
  min-height: 260px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 12px;
  padding: 28px;
  border: 1px dashed color-mix(in srgb, var(--app-accent) 24%, var(--app-border, #d9d9d9));
  border-radius: 18px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #fbf6ee), color-mix(in srgb, var(--app-bg, #fff) 98%, #fffdf9));
  color: var(--app-text, #1f2937);
}

.orch-layout__asset-readonly-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 12%, #fff);
  color: color-mix(in srgb, var(--app-accent) 72%, #5a4531);
  font-size: 12px;
  font-weight: 700;
}

.orch-layout__asset-readonly strong {
  font-size: 18px;
}

.orch-layout__asset-readonly p {
  max-width: 680px;
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--app-muted, #667085);
}

.orch-layout__locked-mask {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(255, 255, 255, 0.56);
  backdrop-filter: blur(2px);
}

.orch-layout__locked-card {
  min-width: min(320px, 100%);
  max-width: 420px;
  padding: 18px 20px;
  border: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 84%, #d8c9b4);
  border-radius: 18px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #fff) 92%, #fbf6ee), color-mix(in srgb, var(--app-bg, #fff) 98%, #fffdf8));
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.1);
  text-align: center;
}

.orch-layout__locked-card strong {
  display: block;
  margin-bottom: 6px;
  font-size: 16px;
  color: var(--app-text, #1f2937);
}

.orch-layout__locked-card p {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-muted, #667085);
}

@media (max-width: 1199px) {
  .orch-layout {
    --orch-sidebar-width: 320px;
  }
  .orch-layout__asset-shell {
    grid-template-columns: 1fr;
  }
  .orch-layout__asset-shell .orch-layout__content {
    padding-left: 0;
  }
  .orch-layout__sidebar--assets {
    display: flex;
    border-right: none;
    border-bottom: 1px solid var(--app-divider, var(--app-border, #e8e8e8));
    max-height: 420px;
  }
  .orch-layout__sidebar--assets.orch-layout__sidebar--assistant {
    display: flex;
    max-height: none;
  }
  .orch-layout__asset-nav {
    overflow: visible;
  }
  .orch-layout__asset-sidebar-card {
    min-height: 0;
  }

  .orch-layout__workspace-copy h3,
  .orch-layout__workspace-title {
    font-size: 14px;
  }
  .orch-layout__workspace-title-row {
    flex-wrap: wrap;
  }

  .orch-layout__subhead-switcher {
    width: 100%;
    justify-content: space-between;
  }

  .orch-layout__subhead-select {
    width: 100%;
  }

}

@media (max-width: 860px) {
  .orch-layout {
    --orch-sidebar-width: 300px;
  }
}

@media (max-width: 720px) {
  .orch-layout__body {
    grid-template-columns: 1fr;
  }
  .orch-layout__body .orch-layout__sidebar {
    border-right: none;
    border-bottom: 1px solid var(--app-divider, var(--app-border, #e8e8e8));
    max-height: 360px;
  }
  .orch-layout__body .orch-layout__content {
    padding-left: 0;
  }
  .orch-layout__sidebar--assets {
    display: flex;
    max-height: 460px;
  }
  .orch-layout__asset-nav {
    gap: 8px;
    overflow: visible;
  }
  .orch-layout__asset-nav-section {
    gap: 4px;
  }
  .orch-layout__asset-tabs-row.thread-list__tabs-row {
    overflow-x: auto;
    padding-bottom: 2px;
  }
  .orch-layout__asset-segmented {
    min-width: 420px;
  }
  .orch-layout__subhead {
    padding: 0;
  }
}

:root[data-theme="dark"] .orch-layout__workspace-bar,
:root[data-theme="dark"] .orch-layout__panel {
  border-color: #303030;
  background: transparent;
}

:root[data-theme="dark"] .orch-layout__sidebar {
  border-color: #303030;
  background: transparent;
}

:root[data-theme="dark"] .orch-layout__asset-sidebar-card {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.wf-sidebar__item--selected),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.role-list__item--selected),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.kb-sidebar__item--selected),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.tool-sidebar__item--selected),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.skill-sidebar__item--selected),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.wf-sidebar__item.wf-sidebar__item--selected:hover),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.role-list__item.role-list__item--selected:hover),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.kb-sidebar__item.kb-sidebar__item--selected:hover),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.tool-sidebar__item.tool-sidebar__item--selected:hover),
:root[data-theme="dark"] .orch-layout__asset-column-body :deep(.skill-sidebar__item.skill-sidebar__item--selected:hover) {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .orch-layout__locked-mask {
  background: rgba(15, 23, 42, 0.48);
}

:root[data-theme="dark"] .orch-layout__locked-card {
  border-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
}

:root[data-theme="dark"] .orch-layout__locked-card strong {
  color: #ece7df;
}

:root[data-theme="dark"] .orch-layout__locked-card p {
  color: #c8d2de;
}

:root[data-theme="dark"] .orch-layout__asset-readonly {
  border-color: rgba(217, 119, 87, 0.28);
  background: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
}

:root[data-theme="dark"] .orch-layout__asset-readonly-badge {
  background: rgba(217, 119, 87, 0.16);
  color: #ffd2c2;
}

:root[data-theme="dark"] .orch-layout__asset-readonly strong {
  color: #ece7df;
}

:root[data-theme="dark"] .orch-layout__asset-readonly p {
  color: #c8d2de;
}

:root[data-theme="dark"] .orch-layout__asset-segmented {
  background: rgba(255, 255, 255, 0.07);
}

:root[data-theme="dark"] .orch-layout__asset-segmented-item--active,
:root[data-theme="dark"] .orch-layout__asset-segmented-item--active:hover {
  background: #16181d;
  color: #ffd2c2;
}

:root[data-theme="dark"] .orch-layout__assistant-search-input,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__search-input),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input) {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-layout__assistant-search-input::placeholder,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-input::placeholder),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__search-input::placeholder),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-input::placeholder),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-input::placeholder),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-input::placeholder) {
  color: #7f8794;
  opacity: 1;
}

:root[data-theme="dark"] .orch-layout__assistant-search-icon,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__search-icon),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__search-icon),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__search-icon),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__search-icon),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__search-icon) {
  color: #7f8794;
}

:root[data-theme="dark"] .orch-layout__assistant-icon-action,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__icon-action),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action) {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-layout__assistant-icon-action:hover,
:root[data-theme="dark"] .orch-layout__assistant-icon-action:focus-visible,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action:hover),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action:focus-visible),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__icon-action:hover),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__icon-action:focus-visible),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action:hover),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action:focus-visible),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action:hover),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action:focus-visible),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action:hover),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent) 24%, #303030);
  background: color-mix(in srgb, var(--app-accent) 10%, #16181d);
  color: #ffd2c2;
}

:root[data-theme="dark"] .orch-layout__assistant-icon-action--primary,
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.wf-sidebar__icon-action--primary),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.role-list__icon-action--primary),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.kb-sidebar__icon-action--primary),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.tool-sidebar__icon-action--primary),
:root[data-theme="dark"] .orch-layout__asset-toolbar-scope :deep(.skill-sidebar__icon-action--primary) {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-layout__assistant-session {
  border-color: transparent;
  background: transparent;
}

:root[data-theme="dark"] .orch-layout__assistant-hint {
  border-color: rgba(255, 255, 255, 0.12);
  color: #9fb0c2;
}

:root[data-theme="dark"] .orch-layout__assistant-hint--error {
  border-color: rgba(248, 113, 113, 0.38);
  background: rgba(127, 29, 29, 0.22);
  color: #fecaca;
}

:root[data-theme="dark"] .orch-layout__assistant-session--active,
:root[data-theme="dark"] .orch-layout__assistant-session--active:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .orch-layout__tab,
:root[data-theme="dark"] .orch-layout__subhead-select {
  border-color: rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, #181d24, #13171d);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(59, 76, 99, 0.14);
}

:root[data-theme="dark"] .orch-layout__workspace-label,
:root[data-theme="dark"] .orch-layout__subhead,
:root[data-theme="dark"] .orch-layout__workspace-meta,
:root[data-theme="dark"] .orch-layout__empty {
  color: #9fb0c2;
}

:root[data-theme="dark"] .orch-layout__workspace-title,
:root[data-theme="dark"] .orch-layout__assistant-session-title,
:root[data-theme="dark"] .orch-layout__assistant-session-meta {
  color: #9fb0c2;
}

:root[data-theme="dark"] .orch-layout__tab {
  color: #d6dbe4;
}

:root[data-theme="dark"] .orch-layout__tab--active {
  color: #ffd2c2;
}
</style>
