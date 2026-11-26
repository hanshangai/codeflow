import { defineStore } from "pinia";
import type {
  ApiResult,
  AssigneeTemplate,
  OrchAssetBundle,
  OrchAssetBundleImportCounts,
  OrchAssetBundleImportMode,
  OrchAssetBundlesImportResponseBody,
  Artifact,
  ArtifactFileEntry,
  ArtifactId,
  OrchArtifactFilesListResponseBody,
  FeedbackAction,
  IntakeId,
  KnowledgeBundleDefinition,
  KnowledgeBundleId,
  KnowledgeSourceKind,
  ListStatusCount,
  NodeExecutionState,
  NodeExecutionEnvelope,
  NodePromptSnapshot,
  NodeThreadReusePolicy,
  DownstreamThreadReusePolicy,
  OrchestrationEventRecord,
  OrchestrationId,
  OrchestrationInstance,
  EngineType,
  OrchestrationInstanceRuntimePatch,
  OrchestrationInstanceSummary,
  OrchestrationRunPlan,
  OrchestrationRoleExecutionOverride,
  OrchAssetListMetadata,
  OrchAssetType,
  PendingMineListItem,
  PendingMineListStatus,
  ReminderItem,
  ReminderTone,
  ThreadSummary,
  TaskIntake,
  TaskIntakeListMeta,
  TaskIntakeListStatus,
  OrchProposalsCreateRequestBody,
  ProposalId,
  RoleDefinition,
  RoleId,
  SkillDefinition,
  SkillId,
  SkillTargetEngine,
  OrchSkillInstallTargetStatus,
  ToolDefinition,
  ToolsetDefinition,
  ToolsetId,
  OrchestrationExecutionEngineStrategy,
  WorkflowDefinition,
  WorkflowId,
  WorkflowProposal,
  WorkflowProposalSummary,
  WorkspaceId,
} from "@codeflowai/shared";
import { deriveOrchestrationInstanceSummary, isOrchAssetType, normalizeTaskIntakeTitle } from "@codeflowai/shared";

import {
  createApiResultError,
  createCancelledRequestError,
  isCancelledRequestError,
  type AbortKind,
  type ApiRequestContext,
} from "../api/request";
import {
  createOrchIntake,
  confirmOrchProposal,
  createOrchProposal,
  deleteOrchIntake,
  deleteOrchAssigneeTemplate,
  deleteOrchWorkflowExecutionDefault,
  deleteOrchKnowledgeBundle,
  deleteOrchRole,
  deleteOrchSkill,
  deleteOrchToolset,
  deleteOrchWorkflow,
  exportOrchAssetBundle,
  getOrchArtifact,
  getOrchPromptSnapshot,
  getOrchSkillInstallStatus,
  importOrchAssetBundle,
  installOrchSkillPackage,
  listOrchArtifacts,
  listOrchArtifactFiles,
  listOrchAssigneeTemplates,
  listOrchEvents,
  listOrchPromptSnapshots,
  listOrchInstances,
  listOrchIntakes,
  listOrchKnowledgeBundles,
  listPendingMineItems,
  listOrchProposals,
  listOrchRoles,
  listOrchSkills,
  listOrchToolsets,
  listOrchWorkflows,
  pauseOrchInstance,
  getOrchInstance,
  getOrchInstanceRuntimePatch,
  getOrchWorkflowExecutionDefault,
  reassignOrchInstanceNode,
  reviseOrchArtifact,
  startOrchInstance,
  startOrchNode,
  skipOrchNode,
  cancelOrchInstance,
  cancelOrchNode,
  ensureOrchDiscussionThread,
  submitOrchFeedback,
  rerunOrchInstanceFromNode,
  resumeOrchInstance,
  upsertOrchIntake,
  upsertOrchAssigneeTemplate,
  upsertOrchKnowledgeBundle,
  upsertOrchRole,
  upsertOrchSkill,
  upsertOrchToolset,
  upsertOrchWorkflow,
  upsertOrchWorkflowExecutionDefault,
  uninstallOrchSkillPackage,
} from "../api/orchestration";
import { trackProductEvent } from "../analytics/analytics";
import { createBrowserUuid } from "../utils/browserUuid";
import { isSharedWorkspaceSelectionId } from "../utils/workspaceId";

/** 正式需求列表单页大小:50 条覆盖绝大多数 sidebar 场景,避免一上来就显示「加载更多」 */
const INTAKE_LIST_PAGE_SIZE = 50;
const ORCH_DETAIL_EVENT_LIMIT = 200;
const TERMINAL_INSTANCE_CACHE_LIMIT = 12;

type AssetAnalyticsEventName = "asset_save" | "asset_delete" | "asset_install" | "asset_uninstall";

/** 为资产 mutation 请求补齐网络异常埋点；取消请求不计入业务失败。 */
async function runTrackedAssetRequest<T>(
  eventName: AssetAnalyticsEventName,
  assetType: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent(eventName, {
        asset_type: assetType,
        status: "failed",
        source: "orchestration",
        error_code_group: "request_error",
      });
    }
    throw error;
  }
}

type NetworkHydrationGuard = boolean | (() => boolean);

const pendingArtifactPatchLoads = new Map<string, Promise<Artifact | null>>();
const artifactFileLoads = new Map<string, { revision: string | null; promise: Promise<OrchArtifactFilesListResponseBody | null> }>();
const pendingPromptSnapshotPatchLoads = new Map<string, Promise<NodePromptSnapshot | null>>();
const pendingInstancePatchLoads = new Map<string, Promise<OrchestrationInstance | null>>();
const pendingInstanceRuntimePatchLoads = new Map<string, Promise<OrchestrationInstanceRuntimePatch | null>>();
const pendingSelectedInstanceLoads = new Map<string, Promise<OrchestrationInstance | null>>();
const pendingSelectedInstanceDetailLoads = new Map<string, {
  promise: Promise<void>;
  networkGuards: Set<NetworkHydrationGuard | undefined>;
}>();
const pendingScheduledIntakeRefreshes = new Map<string, Promise<void>>();
type SelectedInstanceRequestScope = {
  key: string;
  controller: AbortController;
};
let selectedInstanceRequestScope: SelectedInstanceRequestScope | null = null;

type ImportedAssetBundleResult = OrchAssetBundlesImportResponseBody["imported"];
type ImportedAssetBundleMetadata = Record<OrchAssetType, OrchAssetListMetadata[]>;

export type OrchestrationAssetListMetadataState = {
  role: OrchAssetListMetadata<"role">[] | null;
  workflow: OrchAssetListMetadata<"workflow">[] | null;
  knowledge_bundle: OrchAssetListMetadata<"knowledge_bundle">[] | null;
  toolset: OrchAssetListMetadata<"toolset">[] | null;
  skill: OrchAssetListMetadata<"skill">[] | null;
};

type OrchestrationAssetListRefreshVersionState = Record<OrchAssetType, number>;
type OrchestrationAssetListLoadedState = Record<OrchAssetType, boolean>;
type OrchestrationAssetListLoadPromiseState = Record<OrchAssetType, Promise<void> | null>;

export type OrchTab =
  | "tasks"
  | "proposals"
  | "knowledge"
  | "skills"
  | "tools"
  | "mcp"
  | "roles"
  | "workflows"
  | "runs"
  | "artifacts";

/** 内置草稿的资产类型与资产页签一一对应，供「未发布资产」入口直接定位编辑器。 */
export const ASSET_TAB_BY_ASSET_TYPE: Record<OrchAssetType, OrchTab> = {
  workflow: "workflows",
  role: "roles",
  knowledge_bundle: "knowledge",
  skill: "skills",
  toolset: "tools",
};

export type OrchUiIntent =
  | {
      id: number;
      kind: "open_monitor";
      intakeId: IntakeId;
      instanceId: OrchestrationId | null;
      nodeId: string | null;
    }
  | {
      id: number;
      kind: "open_primary_action";
      intakeId: IntakeId;
      instanceId: OrchestrationId | null;
      nodeId: string | null;
    }
  | {
      id: number;
      kind: "open_artifacts";
      intakeId: IntakeId;
      instanceId: OrchestrationId | null;
      nodeId: string | null;
    }
  | {
      id: number;
      kind: "open_metric_review";
      intakeId: IntakeId;
      instanceId: null;
      nodeId: null;
    };

export type SelectedInstanceDetailErrors = {
  artifacts?: string;
  events?: string;
  promptSnapshots?: string;
  artifactFiles?: string;
};

export class OrchIntakeDeleteConflictError extends Error {
  intakeId: IntakeId;
  activeInstanceIds: OrchestrationId[];

  constructor(input: { intakeId: IntakeId; message: string; activeInstanceIds?: OrchestrationId[] | null }) {
    super(input.message);
    this.name = "OrchIntakeDeleteConflictError";
    this.intakeId = input.intakeId;
    this.activeInstanceIds = (input.activeInstanceIds ?? []).filter(Boolean) as OrchestrationId[];
  }
}

export type OrchestrationState = {
  workspaceScopeId: string | null;
  workspaceRequestGeneration: number;
  workspaceRequestSequence: number;
  workspaceLatestRequestByScope: Record<string, number>;
  activeTab: OrchTab;

  /** 当前活动工作区的列表元数据；null 表示当前响应未提供 Server 元数据。 */
  assetListMetadata: OrchestrationAssetListMetadataState;
  /** 仅用于拒绝工作区切换前返回的资产请求，不参与持久化。 */
  assetListWorkspaceEpoch: number;
  /** 五类最新刷新版本；本地修改会使对应在途刷新失效。 */
  assetListRefreshVersions: OrchestrationAssetListRefreshVersionState;
  /** 当前工作区内已成功读取的资产列表；空列表也会标记为已读取。 */
  assetListLoaded: OrchestrationAssetListLoadedState;
  /** 当前列表中仅存于共享 Host 或远程 Client 的定义；展示不授予 Server 修订写入权。 */
  assetListHostIds: Record<OrchAssetType, string[]>;
  /** 首次读取中的列表请求，供快速切换 Tab 时复用。 */
  assetListLoadPromises: OrchestrationAssetListLoadPromiseState;
  /** 单份角色/流程快照的来源，执行候选不得复用管理资产 ID。 */
  assetListPurposes: Record<"role" | "workflow", "catalog" | "execution">;

  intakes: TaskIntake[];
  intakesLoading: boolean;
  intakesLoadingMore: boolean;
  intakesHasMore: boolean;
  intakesNextCursor: string | null;
  intakeStatusCounts: Array<ListStatusCount<TaskIntakeListStatus>>;
  intakeTotalCount: number;
  intakeListMetaById: Record<string, TaskIntakeListMeta>;
  scheduledIntakes: TaskIntake[];
  scheduledIntakesLoading: boolean;
  scheduledIntakesLoadingMore: boolean;
  scheduledIntakesHasMore: boolean;
  scheduledIntakesNextCursor: string | null;
  scheduledIntakeStatusCounts: Array<ListStatusCount<TaskIntakeListStatus>>;
  scheduledIntakeTotalCount: number;
  scheduledIntakeListMetaById: Record<string, TaskIntakeListMeta>;
  pendingMineItems: PendingMineListItem[];
  pendingMineLoading: boolean;
  pendingMineLoadingMore: boolean;
  pendingMineHasMore: boolean;
  pendingMineNextCursor: string | null;
  pendingMineStatusCounts: Array<ListStatusCount<PendingMineListStatus>>;
  pendingMineTotalCount: number;
  /** 共享工作区正式需求列表筛选；true 表示只看本人 owner/participant 相关记录。 */
  intakeListOnlyRelatedToMe: boolean;
  selectedIntakeId: IntakeId | null;
  selectedIntakeSnapshot: TaskIntake | null;
  intakeComposerOpen: boolean;

  roles: RoleDefinition[];
  rolesLoading: boolean;
  selectedRoleId: RoleId | null;

  workflows: WorkflowDefinition[];
  workflowsLoading: boolean;
  selectedWorkflowId: WorkflowId | null;
  assigneeTemplates: AssigneeTemplate[];
  assigneeTemplatesLoading: boolean;

  proposals: WorkflowProposalSummary[];
  proposalsLoading: boolean;
  selectedProposalId: ProposalId | null;

  knowledgeBundles: KnowledgeBundleDefinition[];
  knowledgeBundlesLoading: boolean;
  selectedKnowledgeBundleId: KnowledgeBundleId | null;

  skills: SkillDefinition[];
  skillsLoading: boolean;
  selectedSkillId: SkillId | null;

  toolsets: ToolsetDefinition[];
  toolsetsLoading: boolean;
  selectedToolsetId: ToolsetId | null;

  instances: OrchestrationInstance[];
  instanceSummaries: OrchestrationInstanceSummary[];
  instanceTotalCountByIntake: Record<string, number>;
  instancesHasMore: boolean;
  instancesNextCursor: string | null;
  instancesLoading: boolean;
  /** 成功读取的实例摘要作用域；空结果同样视为已加载。 */
  instancesLoadedScope: string | null;
  /** 列表读取期间收到新事件时，不将旧响应登记为可复用快照。 */
  instancesListRevision: number;
  selectedInstanceId: OrchestrationId | null;
  selectedInstance: OrchestrationInstance | null;
  selectedInstanceArtifacts: Artifact[];
  selectedInstanceEvents: OrchestrationEventRecord[];
  selectedInstancePromptSnapshots: NodePromptSnapshot[];
  selectedArtifactFiles: ArtifactFileEntry[];
  selectedArtifactId: ArtifactId | null;
  selectedInstanceDetailsLoading: boolean;
  selectedInstanceDetailsLoadedAt: number | null;
  selectedInstanceDetailErrors: SelectedInstanceDetailErrors;
  uiIntentSeq: number;
  pendingUiIntent: OrchUiIntent | null;
};

export const useOrchestrationStore = defineStore("orchestration", {
  state: (): OrchestrationState => ({
    workspaceScopeId: null,
    workspaceRequestGeneration: 0,
    workspaceRequestSequence: 0,
    workspaceLatestRequestByScope: {},
    activeTab: "tasks",
    assetListMetadata: createEmptyAssetListMetadataState(),
    assetListWorkspaceEpoch: 0,
    assetListRefreshVersions: createEmptyAssetListRefreshVersionState(),
    assetListLoaded: createEmptyAssetListLoadedState(),
    assetListHostIds: { role: [], workflow: [], knowledge_bundle: [], skill: [], toolset: [] },
    assetListLoadPromises: createEmptyAssetListLoadPromiseState(),
    assetListPurposes: { role: "catalog", workflow: "catalog" },
    intakes: [],
    intakesLoading: false,
    intakesLoadingMore: false,
    intakesHasMore: false,
    intakesNextCursor: null,
    intakeStatusCounts: [],
    intakeTotalCount: 0,
    intakeListMetaById: {},
    scheduledIntakes: [],
    scheduledIntakesLoading: false,
    scheduledIntakesLoadingMore: false,
    scheduledIntakesHasMore: false,
    scheduledIntakesNextCursor: null,
    scheduledIntakeStatusCounts: [],
    scheduledIntakeTotalCount: 0,
    scheduledIntakeListMetaById: {},
    pendingMineItems: [],
    pendingMineLoading: false,
    pendingMineLoadingMore: false,
    pendingMineHasMore: false,
    pendingMineNextCursor: null,
    pendingMineStatusCounts: [],
    pendingMineTotalCount: 0,
    intakeListOnlyRelatedToMe: true,
    selectedIntakeId: null,
    selectedIntakeSnapshot: null,
    intakeComposerOpen: false,
    roles: [],
    rolesLoading: false,
    selectedRoleId: null,
    workflows: [],
    workflowsLoading: false,
    selectedWorkflowId: null,
    assigneeTemplates: [],
    assigneeTemplatesLoading: false,
    proposals: [],
    proposalsLoading: false,
    selectedProposalId: null,
    knowledgeBundles: [],
    knowledgeBundlesLoading: false,
    selectedKnowledgeBundleId: null,
    skills: [],
    skillsLoading: false,
    selectedSkillId: null,
    toolsets: [],
    toolsetsLoading: false,
    selectedToolsetId: null,
    instances: [],
    instanceSummaries: [],
    instanceTotalCountByIntake: {},
    instancesHasMore: false,
    instancesNextCursor: null,
    instancesLoading: false,
    instancesLoadedScope: null,
    instancesListRevision: 0,
    selectedInstanceId: null,
    selectedInstance: null,
    selectedInstanceArtifacts: [],
    selectedInstanceEvents: [],
    selectedInstancePromptSnapshots: [],
    selectedArtifactFiles: [],
    selectedArtifactId: null,
    selectedInstanceDetailsLoading: false,
    selectedInstanceDetailsLoadedAt: null,
    selectedInstanceDetailErrors: {},
    uiIntentSeq: 0,
    pendingUiIntent: null,
  }),
  persist: {
    pick: [
      "activeTab",
      "intakeComposerOpen",
      "selectedRoleId",
      "selectedWorkflowId",
      "selectedProposalId",
      "selectedKnowledgeBundleId",
      "selectedSkillId",
      "selectedToolsetId",
    ],
  },
  getters: {
    selectedIntake(s): TaskIntake | null {
      if (!s.selectedIntakeId) return null;
      return s.intakes.find((item) => item.id === s.selectedIntakeId)
        ?? s.scheduledIntakes.find((item) => item.id === s.selectedIntakeId)
        ?? (s.selectedIntakeSnapshot?.id === s.selectedIntakeId ? s.selectedIntakeSnapshot : null);
    },
    selectedRole(s): RoleDefinition | null {
      if (!s.selectedRoleId) return null;
      return s.roles.find((item) => item.id === s.selectedRoleId) ?? null;
    },
    selectedWorkflow(s): WorkflowDefinition | null {
      if (!s.selectedWorkflowId) return null;
      return s.workflows.find((item) => item.id === s.selectedWorkflowId) ?? null;
    },
    selectedProposal(s): WorkflowProposalSummary | null {
      if (!s.selectedProposalId) return null;
      return s.proposals.find((item) => item.id === s.selectedProposalId) ?? null;
    },
    selectedKnowledgeBundle(s): KnowledgeBundleDefinition | null {
      if (!s.selectedKnowledgeBundleId) return null;
      return s.knowledgeBundles.find((item) => item.id === s.selectedKnowledgeBundleId) ?? null;
    },
    selectedSkill(s): SkillDefinition | null {
      if (!s.selectedSkillId) return null;
      return s.skills.find((item) => item.id === s.selectedSkillId) ?? null;
    },
    selectedToolset(s): ToolsetDefinition | null {
      if (!s.selectedToolsetId) return null;
      return s.toolsets.find((item) => item.id === s.selectedToolsetId) ?? null;
    },
    toolOptions(s): Array<{ toolsetId: ToolsetId; toolsetName: string; tool: ToolDefinition }> {
      return s.toolsets.flatMap((toolset) =>
        toolset.tools.map((tool) => ({
          toolsetId: toolset.id,
          toolsetName: toolset.name,
          tool,
        })),
      );
    },
    selectedArtifact(s): Artifact | null {
      if (!s.selectedArtifactId) return null;
      return s.selectedInstanceArtifacts.find((item) => item.id === s.selectedArtifactId) ?? null;
    },
    selectedArtifactFileEntries(s): ArtifactFileEntry[] {
      if (!s.selectedArtifactId) return [];
      return s.selectedArtifactFiles.filter((item) => item.artifactId === s.selectedArtifactId);
    },
  },
  actions: {
    setActiveTab(tab: OrchTab) {
      this.activeTab = tab === "proposals" || tab === "runs" ? "tasks" : tab;
    },

    openIntakeComposer() {
      this.activeTab = "tasks";
      this.intakeComposerOpen = true;
      this.selectedIntakeId = null;
      this.selectedIntakeSnapshot = null;
    },

    dispatchUiIntent(intent: Omit<OrchUiIntent, "id">) {
      this.uiIntentSeq += 1;
      this.pendingUiIntent = {
        ...intent,
        id: this.uiIntentSeq,
      } as OrchUiIntent;
    },

    clearUiIntent(intentId: number) {
      if (this.pendingUiIntent?.id !== intentId) return;
      this.pendingUiIntent = null;
    },

    /** 刷新编排工作台首屏摘要；完整资产和实例仅在用户进入对应视图后加载。 */
    async refreshWorkspaceData(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: { onlyRelatedToMe?: boolean | null }) {
      await Promise.all([
        this.refreshIntakes(ctx, workspaceId, { onlyRelatedToMe: opts?.onlyRelatedToMe }),
        this.refreshScheduledIntakes(ctx, workspaceId),
      ]);
    },

    /** 刷新正式需求列表，并同步列表态携带的最新实例摘要。 */
    async refreshIntakes(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: TaskIntakeListStatus[] | null },
    ) {
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "intakes");
      if (!request) return;
      this.intakesLoading = true;
      this.intakesLoadingMore = false;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.intakeListOnlyRelatedToMe);
        if (onlyRelatedToMe != null) this.intakeListOnlyRelatedToMe = onlyRelatedToMe;
        const res = await listOrchIntakes(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          sourceKind: "requirement",
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载需求列表失败");
        const previousSelectedSnapshot = this.selectedIntakeId
          ? (this.intakes.find((item) => item.id === this.selectedIntakeId)
            ?? this.scheduledIntakes.find((item) => item.id === this.selectedIntakeId)
            ?? (this.selectedIntakeSnapshot?.id === this.selectedIntakeId ? this.selectedIntakeSnapshot : null))
          : null;
        this.intakes = (res as any).intakes ?? [];
        this.intakesHasMore = Boolean((res as any).hasMore);
        this.intakesNextCursor = (res as any).nextCursor ?? null;
        this.intakeStatusCounts = (res as any).statusCounts ?? [];
        this.intakeTotalCount = Number((res as any).totalCount ?? this.intakes.length);
        this.intakeListMetaById = (res as any).listMetaById ?? {};
        this.instanceSummaries = mergeLatestInstanceSummariesFromListMeta(this.instanceSummaries, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        this.instanceTotalCountByIntake = mergeInstanceCountsFromListMeta(this.instanceTotalCountByIntake, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        if (this.selectedIntakeId) {
          const refreshedSelected = this.intakes.find((item) => item.id === this.selectedIntakeId) ?? null;
          if (refreshedSelected) {
            this.selectedIntakeSnapshot = refreshedSelected;
          } else if (this.scheduledIntakes.some((item) => item.id === this.selectedIntakeId)) {
            this.selectedIntakeSnapshot = previousSelectedSnapshot;
          } else if (
            previousSelectedSnapshot
            && (previousSelectedSnapshot.requester?.source === "scheduled_task"
              ? this.scheduledIntakesHasMore
              : this.intakesHasMore)
          ) {
            this.selectedIntakeSnapshot = previousSelectedSnapshot;
          } else {
            this.selectedIntakeId = null;
            this.selectedIntakeSnapshot = null;
            this.selectedProposalId = null;
            this.selectedInstanceId = null;
            clearSelectedInstanceDetails(this);
          }
        }
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.intakesLoading = false;
      }
    },

    /** 加载更多正式需求，并同步追加页的最新实例摘要。 */
    async loadMoreIntakes(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: TaskIntakeListStatus[] | null },
    ): Promise<void> {
      if (this.intakesLoading || !this.intakesHasMore || this.intakesLoadingMore || !this.intakesNextCursor) return;
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "intakes");
      if (!request) return;
      this.intakesLoadingMore = true;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.intakeListOnlyRelatedToMe);
        const res = await listOrchIntakes(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          cursor: this.intakesNextCursor,
          sourceKind: "requirement",
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载更多需求失败");
        const existingIds = new Set(this.intakes.map((item) => String(item.id)));
        const appended = ((res as any).intakes ?? []).filter((item: TaskIntake) => !existingIds.has(String(item.id)));
        this.intakes = [...this.intakes, ...appended];
        this.intakesHasMore = Boolean((res as any).hasMore);
        this.intakesNextCursor = (res as any).nextCursor ?? null;
        this.intakeStatusCounts = (res as any).statusCounts ?? this.intakeStatusCounts;
        this.intakeTotalCount = Number((res as any).totalCount ?? this.intakeTotalCount);
        this.intakeListMetaById = { ...this.intakeListMetaById, ...((res as any).listMetaById ?? {}) };
        this.instanceSummaries = mergeLatestInstanceSummariesFromListMeta(this.instanceSummaries, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        this.instanceTotalCountByIntake = mergeInstanceCountsFromListMeta(this.instanceTotalCountByIntake, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.intakesLoadingMore = false;
      }
    },

    /** 刷新定时任务调度生成的编排列表；共享工作区成员均可见。 */
    async refreshScheduledIntakes(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { search?: string | null; statuses?: TaskIntakeListStatus[] | null },
    ): Promise<void> {
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "scheduled-intakes");
      if (!request) return;
      this.scheduledIntakesLoading = true;
      this.scheduledIntakesLoadingMore = false;
      try {
        const res = await listOrchIntakes(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          sourceKind: "scheduled_task",
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载定时编排失败");
        this.scheduledIntakes = (res as any).intakes ?? [];
        this.scheduledIntakesHasMore = Boolean((res as any).hasMore);
        this.scheduledIntakesNextCursor = (res as any).nextCursor ?? null;
        this.scheduledIntakeStatusCounts = (res as any).statusCounts ?? [];
        this.scheduledIntakeTotalCount = Number((res as any).totalCount ?? this.scheduledIntakes.length);
        this.scheduledIntakeListMetaById = (res as any).listMetaById ?? {};
        this.instanceSummaries = mergeLatestInstanceSummariesFromListMeta(this.instanceSummaries, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        this.instanceTotalCountByIntake = mergeInstanceCountsFromListMeta(this.instanceTotalCountByIntake, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        if (this.selectedIntakeId) {
          const refreshedSelected = this.scheduledIntakes.find((item) => item.id === this.selectedIntakeId) ?? null;
          if (refreshedSelected) this.selectedIntakeSnapshot = refreshedSelected;
        }
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.scheduledIntakesLoading = false;
      }
    },

    /** 加载更多定时编排；不走共享需求上下文权限过滤。 */
    async loadMoreScheduledIntakes(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { search?: string | null; statuses?: TaskIntakeListStatus[] | null },
    ): Promise<void> {
      if (this.scheduledIntakesLoading || !this.scheduledIntakesHasMore || this.scheduledIntakesLoadingMore || !this.scheduledIntakesNextCursor) return;
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "scheduled-intakes");
      if (!request) return;
      this.scheduledIntakesLoadingMore = true;
      try {
        const res = await listOrchIntakes(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          cursor: this.scheduledIntakesNextCursor,
          sourceKind: "scheduled_task",
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载更多定时编排失败");
        const existingIds = new Set(this.scheduledIntakes.map((item) => String(item.id)));
        const appended = ((res as any).intakes ?? []).filter((item: TaskIntake) => !existingIds.has(String(item.id)));
        this.scheduledIntakes = [...this.scheduledIntakes, ...appended];
        this.scheduledIntakesHasMore = Boolean((res as any).hasMore);
        this.scheduledIntakesNextCursor = (res as any).nextCursor ?? null;
        this.scheduledIntakeStatusCounts = (res as any).statusCounts ?? this.scheduledIntakeStatusCounts;
        this.scheduledIntakeTotalCount = Number((res as any).totalCount ?? this.scheduledIntakeTotalCount);
        this.scheduledIntakeListMetaById = { ...this.scheduledIntakeListMetaById, ...((res as any).listMetaById ?? {}) };
        this.instanceSummaries = mergeLatestInstanceSummariesFromListMeta(this.instanceSummaries, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        this.instanceTotalCountByIntake = mergeInstanceCountsFromListMeta(this.instanceTotalCountByIntake, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.scheduledIntakesLoadingMore = false;
      }
    },

    /** 刷新当前用户待我处理投影列表；服务端分页避免漏掉未加载需求。 */
    async refreshPendingMine(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: PendingMineListStatus[] | null },
    ): Promise<void> {
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "pending-mine");
      if (!request) return;
      this.pendingMineLoading = true;
      this.pendingMineLoadingMore = false;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.intakeListOnlyRelatedToMe);
        const res = await listPendingMineItems(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载待我处理失败");
        this.pendingMineItems = (res as any).items ?? [];
        this.pendingMineHasMore = Boolean((res as any).hasMore);
        this.pendingMineNextCursor = (res as any).nextCursor ?? null;
        this.pendingMineStatusCounts = (res as any).statusCounts ?? [];
        this.pendingMineTotalCount = Number((res as any).totalCount ?? this.pendingMineItems.length);
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.pendingMineLoading = false;
      }
    },

    /** 加载更多待我处理投影，按服务端 cursor 续页。 */
    async loadMorePendingMine(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      opts?: { onlyRelatedToMe?: boolean | null; search?: string | null; statuses?: PendingMineListStatus[] | null },
    ): Promise<void> {
      if (this.pendingMineLoading || !this.pendingMineHasMore || this.pendingMineLoadingMore || !this.pendingMineNextCursor) return;
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "pending-mine");
      if (!request) return;
      this.pendingMineLoadingMore = true;
      try {
        const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.intakeListOnlyRelatedToMe);
        const res = await listPendingMineItems(ctx, workspaceId, {
          limit: INTAKE_LIST_PAGE_SIZE,
          cursor: this.pendingMineNextCursor,
          onlyRelatedToMe,
          search: opts?.search ?? null,
          statuses: opts?.statuses ?? null,
        });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载更多待我处理失败");
        const existingIds = new Set(this.pendingMineItems.map((item) => String(item.reminder.id)));
        const appended = ((res as any).items ?? []).filter((item: PendingMineListItem) => !existingIds.has(String(item.reminder.id)));
        this.pendingMineItems = [...this.pendingMineItems, ...appended];
        this.pendingMineHasMore = Boolean((res as any).hasMore);
        this.pendingMineNextCursor = (res as any).nextCursor ?? null;
        this.pendingMineStatusCounts = (res as any).statusCounts ?? this.pendingMineStatusCounts;
        this.pendingMineTotalCount = Number((res as any).totalCount ?? this.pendingMineTotalCount);
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.pendingMineLoadingMore = false;
      }
    },

    /** 创建需求资产并同步列表与当前选中态。 */
    async createIntake(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      intake: Omit<TaskIntake, "id" | "workspaceId" | "createdAt" | "updatedAt">,
    ) {
      const res = await runTrackedAssetRequest("asset_save", "intake", () => (
        createOrchIntake(ctx, { workspaceId, intake })
      ));
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "intake", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "保存需求失败");
      }
      const saved = (res as any).intake as TaskIntake;
      upsertLocalSorted(this.intakes, saved, compareIntakesByUpdatedAt);
      this.selectedIntakeId = saved.id;
      this.selectedIntakeSnapshot = saved;
      this.intakeComposerOpen = false;
      trackProductEvent("asset_save", { asset_type: "intake", status: "success", source: "orchestration" });
      return saved;
    },

    /** 保存需求资产并同步列表与当前选中态。 */
    async saveIntake(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      intake: Omit<TaskIntake, "workspaceId" | "createdAt" | "updatedAt">,
    ) {
      const res = await runTrackedAssetRequest("asset_save", "intake", () => (
        upsertOrchIntake(ctx, { workspaceId, intake })
      ));
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "intake", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "保存需求失败");
      }
      const saved = (res as any).intake as TaskIntake;
      upsertLocalSorted(this.intakes, saved, compareIntakesByUpdatedAt);
      this.selectedIntakeId = saved.id;
      this.selectedIntakeSnapshot = saved;
      this.intakeComposerOpen = false;
      trackProductEvent("asset_save", { asset_type: "intake", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除需求资产及其关联的本地投影，冲突时保留可恢复上下文。 */
    async removeIntake(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      intakeId: IntakeId,
      options: { forceDeleteRunning?: boolean; preserveSelection?: boolean } = {},
    ) {
      const res = await runTrackedAssetRequest("asset_delete", "intake", () => (
        deleteOrchIntake(ctx, {
          workspaceId,
          intakeId,
          forceDeleteRunning: options.forceDeleteRunning ?? false,
        })
      ));
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "intake", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        if (res.code === "CONFLICT" && isActiveInstanceDeleteConflictDetails(res.details)) {
          throw new OrchIntakeDeleteConflictError({
            intakeId,
            message: res.message ?? "当前需求仍有进行中的执行",
            activeInstanceIds: toOrchestrationIds((res.details as Record<string, unknown>)["activeInstanceIds"]),
          });
        }
        throw new Error((res as any).message ?? "删除需求失败");
      }
      const removedProposalIds = new Set(
        this.proposals
          .filter((proposal) => proposal.intakeId === intakeId)
          .map((proposal) => proposal.id),
      );
      const removedInstanceIds = new Set(
        [
          ...this.instances
            .filter((instance) => instance.intakeSnapshot.id === intakeId)
            .map((instance) => instance.id),
          ...this.instanceSummaries
            .filter((instance) => instance.intakeId === intakeId)
            .map((instance) => instance.id),
        ],
      );
      const removedSelectedSnapshot = this.selectedIntakeId === intakeId
        ? (this.intakes.find((item) => item.id === intakeId)
          ?? this.scheduledIntakes.find((item) => item.id === intakeId)
          ?? (this.selectedIntakeSnapshot?.id === intakeId ? this.selectedIntakeSnapshot : null))
        : null;

      this.intakes = this.intakes.filter((item) => item.id !== intakeId);
      this.scheduledIntakes = this.scheduledIntakes.filter((item) => item.id !== intakeId);
      this.proposals = this.proposals.filter((proposal) => proposal.intakeId !== intakeId);
      this.instances = this.instances.filter((instance) => instance.intakeSnapshot.id !== intakeId);
      this.instanceSummaries = this.instanceSummaries.filter((instance) => instance.intakeId !== intakeId);
      const remainingCounts = { ...this.instanceTotalCountByIntake };
      delete remainingCounts[String(intakeId)];
      this.instanceTotalCountByIntake = remainingCounts;

      if (this.selectedIntakeId === intakeId) {
        if (options.preserveSelection) {
          this.selectedIntakeSnapshot = removedSelectedSnapshot;
        } else {
          const fallback = this.intakes[0] ?? this.scheduledIntakes[0] ?? null;
          this.selectedIntakeId = fallback?.id ?? null;
          this.selectedIntakeSnapshot = fallback;
          this.intakeComposerOpen = false;
        }
      }
      if (this.selectedProposalId && removedProposalIds.has(this.selectedProposalId)) {
        this.selectedProposalId = null;
      }
      if (this.selectedInstanceId && removedInstanceIds.has(this.selectedInstanceId)) {
        this.selectedInstanceId = null;
        clearSelectedInstanceDetails(this);
      }

      trackProductEvent("asset_delete", { asset_type: "intake", status: "success", source: "orchestration" });
      return res;
    },

    /** 同步切换单份角色/流程快照来源，并使旧来源的请求与选择失效。 */
    setAssetListPurpose(assetType: "role" | "workflow", purpose?: "execution"): void {
      const nextPurpose = purpose ?? "catalog";
      if (this.assetListPurposes[assetType] === nextPurpose) return;
      this.assetListPurposes[assetType] = nextPurpose;
      this.assetListMetadata[assetType] = null;
      this.assetListHostIds[assetType] = [];
      this.assetListLoaded[assetType] = false;
      this.assetListLoadPromises[assetType] = null;
      this.assetListRefreshVersions[assetType] += 1;
      if (assetType === "role") {
        this.roles = [];
        this.rolesLoading = false;
        this.selectedRoleId = null;
      } else {
        this.workflows = [];
        this.workflowsLoading = false;
        this.selectedWorkflowId = null;
      }
    },

    /** 仅复用同工作区、同用途的成功快照或在途请求。 */
    async ensureAssetListLoaded(ctx: ApiRequestContext, workspaceId: WorkspaceId, assetType: OrchAssetType, purpose?: "execution"): Promise<void> {
      if (assetType === "role" || assetType === "workflow") this.setAssetListPurpose(assetType, purpose);
      if (this.assetListLoaded[assetType]) return;
      const existing = this.assetListLoadPromises[assetType];
      if (existing) return existing;

      let pending: Promise<void>;
      switch (assetType) {
        case "role":
          pending = this.refreshRoles(ctx, workspaceId, purpose);
          break;
        case "workflow":
          pending = this.refreshWorkflows(ctx, workspaceId, purpose);
          break;
        case "knowledge_bundle":
          pending = this.refreshKnowledgeBundles(ctx, workspaceId);
          break;
        case "toolset":
          pending = this.refreshToolsets(ctx, workspaceId);
          break;
        case "skill":
          pending = this.refreshSkills(ctx, workspaceId);
          break;
      }
      this.assetListLoadPromises[assetType] = pending;
      try {
        await pending;
      } finally {
        if (this.assetListLoadPromises[assetType] === pending) this.assetListLoadPromises[assetType] = null;
      }
    },

    /** 按用途刷新角色；切换来源时清除旧候选及 Server 修订元数据。 */
    async refreshRoles(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
      this.setAssetListPurpose("role", purpose);
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = ++this.assetListRefreshVersions.role;
      this.rolesLoading = true;
      try {
        const res = await listOrchRoles(ctx, workspaceId, purpose);
        if (!isCurrentAssetListRefresh(this, "role", workspaceEpoch, refreshVersion)) return;
        if (!res.ok) throw createApiResultError(res);
        const snapshot = await prepareServerAssetListSnapshot(ctx, workspaceId, "role", res.roles, res.assetMetadata, purpose);
        if (!isCurrentAssetListRefresh(this, "role", workspaceEpoch, refreshVersion)) return;
        this.roles = snapshot.definitions;
        this.assetListMetadata.role = snapshot.metadata;
        this.assetListHostIds.role = snapshot.hostAssetIds ?? [];
        this.assetListLoaded.role = !snapshot.hostFailure;
        if (snapshot.hostFailure) throw snapshot.hostFailure.cause;
      } finally {
        if (isCurrentAssetListRefresh(this, "role", workspaceEpoch, refreshVersion)) this.rolesLoading = false;

      }
    },

    /** 保存角色；成功响应只回写仍处于管理来源的列表。 */
    async saveRole(ctx: ApiRequestContext, workspaceId: WorkspaceId, role: Omit<RoleDefinition, "createdAt" | "updatedAt">) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.role;
      const requestRole = { ...role, id: ensureAssetMutationId(role.id) };
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "role", requestRole.id, "upsert");
      const res = await runTrackedAssetRequest("asset_save", "role", () => (
        upsertOrchRole(ctx, { workspaceId, role: requestRole, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "role", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const saved = res.role;
      const serverMetadata = validateAssetUpsertMutationResponse("role", requestRole.id, saved.id, res);
      const current = serverMetadata && isCatalogAssetList(this, "role")
        ? await reconcileDelayedAssetUpsert({
          state: this,
          assetType: "role",
          assetId: saved.id,
          requestRefreshVersion: refreshVersion,
          mutationMetadata: serverMetadata,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: () => this.refreshRoles(ctx, workspaceId),
          readCurrent: () => this.roles.find((item) => item.id === saved.id),
        })
        : null;
      if (isCatalogAssetList(this, "role")) {
        if (current) {
          this.selectedRoleId = current.id;
          trackProductEvent("asset_save", { asset_type: "role", status: "success", source: "orchestration" });
          return current;
        }
        upsertLocal(this.roles, saved);
        applyAssetUpsertMetadata(this, "role", saved.id, res);
        this.selectedRoleId = saved.id;
      }
      trackProductEvent("asset_save", { asset_type: "role", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除角色；迟到管理响应不改写执行来源的候选和元数据。 */
    async removeRole(ctx: ApiRequestContext, workspaceId: WorkspaceId, roleId: RoleId) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.role;
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "role", roleId, "delete");
      const res = await runTrackedAssetRequest("asset_delete", "role", () => (
        deleteOrchRole(ctx, { workspaceId, roleId, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "role", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const serverMetadata = readServerAssetMutationMetadata("role", res, false);
      if (!isCatalogAssetList(this, "role")) {
        trackProductEvent("asset_delete", { asset_type: "role", status: "success", source: "orchestration" });
        return;
      }
      if (serverMetadata && requestMetadata.expectedRevision !== undefined
        && hasNewerAssetMutationRevision(this, "role", roleId, refreshVersion, requestMetadata.expectedRevision)) {
        advanceAssetListMutationVersion(this, "role");
        trackProductEvent("asset_delete", { asset_type: "role", status: "success", source: "orchestration" });
        return;
      }
      this.roles = this.roles.filter((item) => item.id !== roleId);
      applyAssetDeleteMetadata(this, "role", roleId, res);
      if (this.selectedRoleId === roleId) this.selectedRoleId = null;
      trackProductEvent("asset_delete", { asset_type: "role", status: "success", source: "orchestration" });
    },

    /** 刷新知识包定义及其可选 Server 修订元数据。 */
    async refreshKnowledgeBundles(ctx: ApiRequestContext, workspaceId: WorkspaceId) {

      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = ++this.assetListRefreshVersions.knowledge_bundle;
      this.knowledgeBundlesLoading = true;
      try {
        const res = await listOrchKnowledgeBundles(ctx, workspaceId);
        if (!isCurrentAssetListRefresh(this, "knowledge_bundle", workspaceEpoch, refreshVersion)) return;
        if (!res.ok) throw createApiResultError(res);
        const snapshot = await prepareServerAssetListSnapshot(ctx, workspaceId, "knowledge_bundle", res.bundles, res.assetMetadata);
        if (!isCurrentAssetListRefresh(this, "knowledge_bundle", workspaceEpoch, refreshVersion)) return;
        this.knowledgeBundles = snapshot.definitions;
        this.assetListMetadata.knowledge_bundle = snapshot.metadata;
        this.assetListHostIds.knowledge_bundle = snapshot.hostAssetIds ?? [];
        this.assetListLoaded.knowledge_bundle = !snapshot.hostFailure;
        if (snapshot.hostFailure) throw snapshot.hostFailure.cause;
      } finally {
        if (isCurrentAssetListRefresh(this, "knowledge_bundle", workspaceEpoch, refreshVersion)) this.knowledgeBundlesLoading = false;

      }
    },

    /** 保存知识包并按响应更新 Server 修订元数据。 */
    async saveKnowledgeBundle(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      bundle: Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">,
    ) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.knowledge_bundle;
      const requestBundle = { ...bundle, id: ensureAssetMutationId(bundle.id) };
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "knowledge_bundle", requestBundle.id, "upsert");
      const res = await runTrackedAssetRequest("asset_save", "knowledge_bundle", () => (
        upsertOrchKnowledgeBundle(ctx, { workspaceId, bundle: requestBundle, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "knowledge_bundle", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const saved = res.bundle;
      const serverMetadata = validateAssetUpsertMutationResponse("knowledge_bundle", requestBundle.id, saved.id, res);
      const current = serverMetadata
        ? await reconcileDelayedAssetUpsert({
          state: this,
          assetType: "knowledge_bundle",
          assetId: saved.id,
          requestRefreshVersion: refreshVersion,
          mutationMetadata: serverMetadata,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: () => this.refreshKnowledgeBundles(ctx, workspaceId),
          readCurrent: () => this.knowledgeBundles.find((item) => item.id === saved.id),
        })
        : null;
      if (current) {
        this.selectedKnowledgeBundleId = current.id;
        trackProductEvent("asset_save", { asset_type: "knowledge_bundle", status: "success", source: "orchestration" });
        return current;
      }
      upsertLocal(this.knowledgeBundles, saved);
      applyAssetUpsertMetadata(this, "knowledge_bundle", saved.id, res);
      this.selectedKnowledgeBundleId = saved.id;
      trackProductEvent("asset_save", { asset_type: "knowledge_bundle", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除知识包后同步本地列表及其 Server 修订元数据。 */
    async removeKnowledgeBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, bundleId: KnowledgeBundleId) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.knowledge_bundle;
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "knowledge_bundle", bundleId, "delete");
      const res = await runTrackedAssetRequest("asset_delete", "knowledge_bundle", () => (
        deleteOrchKnowledgeBundle(ctx, { workspaceId, bundleId, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "knowledge_bundle", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const serverMetadata = readServerAssetMutationMetadata("knowledge_bundle", res, false);
      if (serverMetadata && requestMetadata.expectedRevision !== undefined
        && hasNewerAssetMutationRevision(this, "knowledge_bundle", bundleId, refreshVersion, requestMetadata.expectedRevision)) {
        advanceAssetListMutationVersion(this, "knowledge_bundle");
        trackProductEvent("asset_delete", { asset_type: "knowledge_bundle", status: "success", source: "orchestration" });
        return;
      }
      this.knowledgeBundles = this.knowledgeBundles.filter((item) => item.id !== bundleId);
      applyAssetDeleteMetadata(this, "knowledge_bundle", bundleId, res);
      if (this.selectedKnowledgeBundleId === bundleId) this.selectedKnowledgeBundleId = null;
      trackProductEvent("asset_delete", { asset_type: "knowledge_bundle", status: "success", source: "orchestration" });
    },

    /** 刷新 Skill 定义及其可选 Server 修订元数据。 */
    async refreshSkills(ctx: ApiRequestContext, workspaceId: WorkspaceId) {

      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = ++this.assetListRefreshVersions.skill;
      this.skillsLoading = true;
      try {
        const res = await listOrchSkills(ctx, workspaceId);
        if (!isCurrentAssetListRefresh(this, "skill", workspaceEpoch, refreshVersion)) return;
        if (!res.ok) throw createApiResultError(res);
        const snapshot = await prepareServerAssetListSnapshot(ctx, workspaceId, "skill", res.skills, res.assetMetadata);
        if (!isCurrentAssetListRefresh(this, "skill", workspaceEpoch, refreshVersion)) return;
        this.skills = snapshot.definitions;
        this.assetListMetadata.skill = snapshot.metadata;
        this.assetListHostIds.skill = snapshot.hostAssetIds ?? [];
        this.assetListLoaded.skill = !snapshot.hostFailure;
        if (snapshot.hostFailure) throw snapshot.hostFailure.cause;
      } finally {
        if (isCurrentAssetListRefresh(this, "skill", workspaceEpoch, refreshVersion)) this.skillsLoading = false;

      }
    },

    /** 保存平台自定义 Skill，并同步左侧资产列表选中态。 */
    async saveSkill(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      skill: Omit<SkillDefinition, "createdAt" | "updatedAt">,
    ) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.skill;
      const requestSkill = { ...skill, id: ensureAssetMutationId(skill.id) };
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "skill", requestSkill.id, "upsert");
      const res = await runTrackedAssetRequest("asset_save", "skill", () => (
        upsertOrchSkill(ctx, { workspaceId, skill: requestSkill, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "skill", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const saved = res.skill;
      const serverMetadata = validateAssetUpsertMutationResponse("skill", requestSkill.id, saved.id, res);
      const current = serverMetadata
        ? await reconcileDelayedAssetUpsert({
          state: this,
          assetType: "skill",
          assetId: saved.id,
          requestRefreshVersion: refreshVersion,
          mutationMetadata: serverMetadata,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: () => this.refreshSkills(ctx, workspaceId),
          readCurrent: () => this.skills.find((item) => item.id === saved.id),
        })
        : null;
      if (current) {
        this.selectedSkillId = current.id;
        trackProductEvent("asset_save", { asset_type: "skill", status: "success", source: "orchestration" });
        return current;
      }
      upsertLocal(this.skills, saved);
      applyAssetUpsertMetadata(this, "skill", saved.id, res);
      this.selectedSkillId = saved.id;
      trackProductEvent("asset_save", { asset_type: "skill", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除平台自定义 Skill，并清理当前选中态。 */
    async removeSkill(ctx: ApiRequestContext, workspaceId: WorkspaceId, skillId: SkillId) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.skill;
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "skill", skillId, "delete");
      const res = await runTrackedAssetRequest("asset_delete", "skill", () => (
        deleteOrchSkill(ctx, { workspaceId, skillId, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "skill", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const serverMetadata = readServerAssetMutationMetadata("skill", res, false);
      if (serverMetadata && requestMetadata.expectedRevision !== undefined
        && hasNewerAssetMutationRevision(this, "skill", skillId, refreshVersion, requestMetadata.expectedRevision)) {
        advanceAssetListMutationVersion(this, "skill");
        trackProductEvent("asset_delete", { asset_type: "skill", status: "success", source: "orchestration" });
        return;
      }
      this.skills = this.skills.filter((item) => item.id !== skillId);
      applyAssetDeleteMetadata(this, "skill", skillId, res);
      if (this.selectedSkillId === skillId) this.selectedSkillId = null;
      trackProductEvent("asset_delete", { asset_type: "skill", status: "success", source: "orchestration" });
    },

    /** 读取 Skill 包在 Codex/Claude 目标目录的安装状态。 */
    async getSkillInstallStatus(ctx: ApiRequestContext, workspaceId: WorkspaceId, skillId: SkillId): Promise<OrchSkillInstallTargetStatus[]> {
      const res = await getOrchSkillInstallStatus(ctx, { workspaceId, skillId });
      if (!res.ok) throw new Error((res as any).message ?? "读取 Skill 安装状态失败");
      return (res as any).status ?? [];
    },

    /** 安装 Skill 包到 Codex/Claude 目标目录。 */
    async installSkillPackage(ctx: ApiRequestContext, workspaceId: WorkspaceId, skillId: SkillId, targets: SkillTargetEngine[]) {
      const res = await runTrackedAssetRequest("asset_install", "skill", () => (
        installOrchSkillPackage(ctx, { workspaceId, skillId, targets })
      ));
      if (!res.ok) {
        trackProductEvent("asset_install", { asset_type: "skill", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "安装 Skill 失败");
      }
      trackProductEvent("asset_install", { asset_type: "skill", status: "success", source: "orchestration" });
      return res as any;
    },

    /** 从 Codex/Claude 目标目录卸载 Skill 包。 */
    async uninstallSkillPackage(ctx: ApiRequestContext, workspaceId: WorkspaceId, skillId: SkillId, targets: SkillTargetEngine[]) {
      const res = await runTrackedAssetRequest("asset_uninstall", "skill", () => (
        uninstallOrchSkillPackage(ctx, { workspaceId, skillId, targets })
      ));
      if (!res.ok) {
        trackProductEvent("asset_uninstall", { asset_type: "skill", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "卸载 Skill 失败");
      }
      trackProductEvent("asset_uninstall", { asset_type: "skill", status: "success", source: "orchestration" });
      return res as any;
    },

    /** 刷新工具集定义及其可选 Server 修订元数据。 */
    async refreshToolsets(ctx: ApiRequestContext, workspaceId: WorkspaceId) {

      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = ++this.assetListRefreshVersions.toolset;
      this.toolsetsLoading = true;
      try {
        const res = await listOrchToolsets(ctx, workspaceId);
        if (!isCurrentAssetListRefresh(this, "toolset", workspaceEpoch, refreshVersion)) return;
        if (!res.ok) throw createApiResultError(res);
        const snapshot = await prepareServerAssetListSnapshot(ctx, workspaceId, "toolset", res.toolsets, res.assetMetadata);
        if (!isCurrentAssetListRefresh(this, "toolset", workspaceEpoch, refreshVersion)) return;
        this.toolsets = snapshot.definitions;
        this.assetListMetadata.toolset = snapshot.metadata;
        this.assetListHostIds.toolset = snapshot.hostAssetIds ?? [];
        this.assetListLoaded.toolset = !snapshot.hostFailure;
        if (snapshot.hostFailure) throw snapshot.hostFailure.cause;
      } finally {
        if (isCurrentAssetListRefresh(this, "toolset", workspaceEpoch, refreshVersion)) this.toolsetsLoading = false;

      }
    },

    /** 保存工具集并按响应更新 Server 修订元数据。 */
    async saveToolset(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      toolset: Omit<ToolsetDefinition, "createdAt" | "updatedAt">,
    ) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.toolset;
      const requestToolset = { ...toolset, id: ensureAssetMutationId(toolset.id) };
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "toolset", requestToolset.id, "upsert");
      const res = await runTrackedAssetRequest("asset_save", "toolset", () => (
        upsertOrchToolset(ctx, { workspaceId, toolset: requestToolset, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "toolset", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const saved = res.toolset;
      const serverMetadata = validateAssetUpsertMutationResponse("toolset", requestToolset.id, saved.id, res);
      const current = serverMetadata
        ? await reconcileDelayedAssetUpsert({
          state: this,
          assetType: "toolset",
          assetId: saved.id,
          requestRefreshVersion: refreshVersion,
          mutationMetadata: serverMetadata,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: () => this.refreshToolsets(ctx, workspaceId),
          readCurrent: () => this.toolsets.find((item) => item.id === saved.id),
        })
        : null;
      if (current) {
        this.selectedToolsetId = current.id;
        trackProductEvent("asset_save", { asset_type: "toolset", status: "success", source: "orchestration" });
        return current;
      }
      upsertLocal(this.toolsets, saved);
      applyAssetUpsertMetadata(this, "toolset", saved.id, res);
      this.selectedToolsetId = saved.id;
      trackProductEvent("asset_save", { asset_type: "toolset", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除工具集后同步本地列表及其 Server 修订元数据。 */
    async removeToolset(ctx: ApiRequestContext, workspaceId: WorkspaceId, toolsetId: ToolsetId) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.toolset;
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "toolset", toolsetId, "delete");
      const res = await runTrackedAssetRequest("asset_delete", "toolset", () => (
        deleteOrchToolset(ctx, { workspaceId, toolsetId, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "toolset", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const serverMetadata = readServerAssetMutationMetadata("toolset", res, false);
      if (serverMetadata && requestMetadata.expectedRevision !== undefined
        && hasNewerAssetMutationRevision(this, "toolset", toolsetId, refreshVersion, requestMetadata.expectedRevision)) {
        advanceAssetListMutationVersion(this, "toolset");
        trackProductEvent("asset_delete", { asset_type: "toolset", status: "success", source: "orchestration" });
        return;
      }
      this.toolsets = this.toolsets.filter((item) => item.id !== toolsetId);
      applyAssetDeleteMetadata(this, "toolset", toolsetId, res);
      if (this.selectedToolsetId === toolsetId) this.selectedToolsetId = null;
      trackProductEvent("asset_delete", { asset_type: "toolset", status: "success", source: "orchestration" });
    },

    /** 按用途刷新流程；切换来源时清除旧候选及 Server 修订元数据。 */
    async refreshWorkflows(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
      this.setAssetListPurpose("workflow", purpose);
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = ++this.assetListRefreshVersions.workflow;
      this.workflowsLoading = true;
      try {
        const res = await listOrchWorkflows(ctx, workspaceId, purpose);
        if (!isCurrentAssetListRefresh(this, "workflow", workspaceEpoch, refreshVersion)) return;
        if (!res.ok) throw createApiResultError(res);
        const snapshot = await prepareServerAssetListSnapshot(ctx, workspaceId, "workflow", res.workflows, res.assetMetadata, purpose);
        if (!isCurrentAssetListRefresh(this, "workflow", workspaceEpoch, refreshVersion)) return;
        this.workflows = snapshot.definitions;
        this.assetListMetadata.workflow = snapshot.metadata;
        this.assetListHostIds.workflow = snapshot.hostAssetIds ?? [];
        this.assetListLoaded.workflow = !snapshot.hostFailure;
        if (snapshot.hostFailure) throw snapshot.hostFailure.cause;
      } finally {
        if (isCurrentAssetListRefresh(this, "workflow", workspaceEpoch, refreshVersion)) this.workflowsLoading = false;

      }
    },

    /**
     * 判断一条资产是否为「服务端权威模式下的内置资产」：这类资产随服务端分发、只读，
     * 资产库里的编辑器不应提交写入，避免用户点保存后才收到 403。
     * 资产元数据只在服务端权威模式下存在，因此它的有无即为该模式的判据。
     */
    isServerAuthoritativeBuiltinAsset(assetType: OrchAssetType, assetId: string): boolean {
      const id = String(assetId ?? "").trim();
      if (!id) return false;
      const list = this.assetListMetadata[assetType];
      return Array.isArray(list) && list.some((item) => item.assetId === id && item.scopeType === "builtin");
    },

    /** 保存流程；成功响应只回写仍处于管理来源的列表。 */
    async saveWorkflow(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      workflow: Omit<WorkflowDefinition, "createdAt" | "updatedAt">,
    ) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.workflow;
      const requestWorkflow = { ...workflow, id: ensureAssetMutationId(workflow.id) };
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "workflow", requestWorkflow.id, "upsert");
      const res = await runTrackedAssetRequest("asset_save", "workflow", () => (
        upsertOrchWorkflow(ctx, { workspaceId, workflow: requestWorkflow, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "workflow", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const saved = res.workflow;
      const serverMetadata = validateAssetUpsertMutationResponse("workflow", requestWorkflow.id, saved.id, res);
      const current = serverMetadata && isCatalogAssetList(this, "workflow")
        ? await reconcileDelayedAssetUpsert({
          state: this,
          assetType: "workflow",
          assetId: saved.id,
          requestRefreshVersion: refreshVersion,
          mutationMetadata: serverMetadata,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: () => this.refreshWorkflows(ctx, workspaceId),
          readCurrent: () => this.workflows.find((item) => item.id === saved.id),
        })
        : null;
      if (isCatalogAssetList(this, "workflow")) {
        if (current) {
          this.selectedWorkflowId = current.id;
          trackProductEvent("asset_save", { asset_type: "workflow", status: "success", source: "orchestration" });
          return current;
        }
        upsertLocal(this.workflows, saved);
        applyAssetUpsertMetadata(this, "workflow", saved.id, res);
        this.selectedWorkflowId = saved.id;
      }
      trackProductEvent("asset_save", { asset_type: "workflow", status: "success", source: "orchestration" });
      return saved;
    },

    /**
     * 读取某流程在本工作区的执行默认值；未配置时返回 null。
     * 每次调用都重新请求，保证其他成员改过之后弹框展示的是最新配置。
     */
    async loadWorkflowExecutionDefault(ctx: ApiRequestContext, workspaceId: WorkspaceId, workflowId: WorkflowId) {
      const res = await getOrchWorkflowExecutionDefault(ctx, workspaceId, workflowId);
      if (!res.ok) throw createApiResultError(res);
      return res.executionDefault ?? null;
    },

    /** 保存流程执行默认值并返回后端确认结果，不做乐观写入。 */
    async saveWorkflowExecutionDefault(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      workflowId: WorkflowId,
      input: { engine: EngineType; model: string },
    ) {
      const res = await upsertOrchWorkflowExecutionDefault(ctx, {
        workspaceId,
        workflowId,
        engine: input.engine,
        model: input.model,
      });
      if (!res.ok) throw createApiResultError(res);
      return res.executionDefault;
    },

    /** 清除流程执行默认值，恢复为角色自身配置。 */
    async clearWorkflowExecutionDefault(ctx: ApiRequestContext, workspaceId: WorkspaceId, workflowId: WorkflowId) {
      const res = await deleteOrchWorkflowExecutionDefault(ctx, { workspaceId, workflowId });
      if (!res.ok) throw createApiResultError(res);
    },

    /** 删除流程；迟到管理响应不改写执行来源的候选和元数据。 */
    async removeWorkflow(ctx: ApiRequestContext, workspaceId: WorkspaceId, workflowId: WorkflowId) {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersion = this.assetListRefreshVersions.workflow;
      const requestMetadata = prepareAssetMutationRequestMetadata(this, "workflow", workflowId, "delete");
      const res = await runTrackedAssetRequest("asset_delete", "workflow", () => (
        deleteOrchWorkflow(ctx, { workspaceId, workflowId, ...requestMetadata })
      ));
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "workflow", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw createApiResultError(res);
      }
      const serverMetadata = readServerAssetMutationMetadata("workflow", res, false);
      if (!isCatalogAssetList(this, "workflow")) {
        trackProductEvent("asset_delete", { asset_type: "workflow", status: "success", source: "orchestration" });
        return;
      }
      if (serverMetadata && requestMetadata.expectedRevision !== undefined
        && hasNewerAssetMutationRevision(this, "workflow", workflowId, refreshVersion, requestMetadata.expectedRevision)) {
        advanceAssetListMutationVersion(this, "workflow");
        trackProductEvent("asset_delete", { asset_type: "workflow", status: "success", source: "orchestration" });
        return;
      }
      this.workflows = this.workflows.filter((item) => item.id !== workflowId);
      applyAssetDeleteMetadata(this, "workflow", workflowId, res);
      this.assigneeTemplates = this.assigneeTemplates.filter((item) => item.workflowId !== workflowId);
      if (this.selectedWorkflowId === workflowId) this.selectedWorkflowId = null;
      trackProductEvent("asset_delete", { asset_type: "workflow", status: "success", source: "orchestration" });
    },

    /** 刷新流程模板处理人模板，workflowId 为空时拉取当前 workspace 全部模板。 */
    async refreshAssigneeTemplates(ctx: ApiRequestContext, workspaceId: WorkspaceId, workflowId?: WorkflowId | null) {
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "assignee-templates");
      if (!request) return;
      this.assigneeTemplatesLoading = true;
      try {
        const res = await listOrchAssigneeTemplates(ctx, workspaceId, workflowId ?? null);
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(res, "加载处理人模板失败");
        const templates = ((res as any).templates ?? []) as AssigneeTemplate[];
        if (workflowId) {
          const targetWorkflowId = String(workflowId);
          this.assigneeTemplates = [
            ...this.assigneeTemplates.filter((item) => String(item.workflowId) !== targetWorkflowId),
            ...templates,
          ];
        } else {
          this.assigneeTemplates = templates;
        }
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.assigneeTemplatesLoading = false;
      }
    },

    /** 保存流程模板处理人模板并同步本地列表。 */
    async saveAssigneeTemplate(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      template: Omit<AssigneeTemplate, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string | null; version?: number | null },
    ) {
      const res = await runTrackedAssetRequest("asset_save", "assignee_template", () => (
        upsertOrchAssigneeTemplate(ctx, { workspaceId, template })
      ));
      if (!res.ok) {
        trackProductEvent("asset_save", { asset_type: "assignee_template", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "保存处理人模板失败");
      }
      const saved = (res as any).template as AssigneeTemplate;
      upsertLocal(this.assigneeTemplates, saved);
      trackProductEvent("asset_save", { asset_type: "assignee_template", status: "success", source: "orchestration" });
      return saved;
    },

    /** 删除流程模板处理人模板并同步本地列表。 */
    async removeAssigneeTemplate(ctx: ApiRequestContext, workspaceId: WorkspaceId, templateId: string) {
      const res = await runTrackedAssetRequest("asset_delete", "assignee_template", () => (
        deleteOrchAssigneeTemplate(ctx, { workspaceId, templateId })
      ));
      if (!res.ok) {
        trackProductEvent("asset_delete", { asset_type: "assignee_template", status: "failed", source: "orchestration", error_code_group: "request_rejected" });
        throw new Error((res as any).message ?? "删除处理人模板失败");
      }
      this.assigneeTemplates = this.assigneeTemplates.filter((item) => item.id !== templateId);
      trackProductEvent("asset_delete", { asset_type: "assignee_template", status: "success", source: "orchestration" });
    },

    /** 转派运行实例中的单个节点处理人，并同步当前实例与摘要。 */
    async reassignNodeAssignees(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      nodeId: string,
      assigneeUserIds: string[],
    ) {
      const res = await reassignOrchInstanceNode(ctx, { workspaceId, instanceId, nodeId, assigneeUserIds });
      if (!res.ok) throw new Error((res as any).message ?? "转派节点处理人失败");
      const instance = (res as any).instance as OrchestrationInstance;
      this.selectedInstance = instance;
      upsertLocal(this.instanceSummaries, deriveOrchestrationInstanceSummary(instance));
      trackProductEvent("orchestration_control", {
        action: "reassign_node",
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
        assignee_count: assigneeUserIds.length,
      });
      return instance;
    },

    /** 导出流程资产包，并记录本次导出资产数量。 */
    async exportWorkflowBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, workflowIds: WorkflowId[]) {
      const res = await exportOrchAssetBundle(ctx, { workspaceId, workflowIds });
      if (!res.ok) throw new Error((res as any).message ?? "导出流程资产包失败");
      trackProductEvent("orchestration_asset_transfer", {
        action: "export",
        asset_type: "workflow",
        asset_count: workflowIds.length,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return (res as any).bundle as OrchAssetBundle;
    },

    /** 导出角色资产包，自动附带依赖的知识库与工具。 */
    async exportRoleBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, roleIds: RoleId[]) {
      const res = await exportOrchAssetBundle(ctx, { workspaceId, roleIds });
      if (!res.ok) throw new Error((res as any).message ?? "导出角色资产包失败");
      trackProductEvent("orchestration_asset_transfer", {
        action: "export",
        asset_type: "role",
        asset_count: roleIds.length,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return (res as any).bundle as OrchAssetBundle;
    },

    /** 导出知识库资产包。 */
    async exportKnowledgeAssetBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, knowledgeBundleIds: KnowledgeBundleId[]) {
      const res = await exportOrchAssetBundle(ctx, { workspaceId, knowledgeBundleIds });
      if (!res.ok) throw new Error((res as any).message ?? "导出知识库资产包失败");
      trackProductEvent("orchestration_asset_transfer", {
        action: "export",
        asset_type: "knowledge",
        asset_count: knowledgeBundleIds.length,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return (res as any).bundle as OrchAssetBundle;
    },

    /** 导出 Skill 资产包。 */
    async exportSkillAssetBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, skillIds: SkillId[]) {
      const res = await exportOrchAssetBundle(ctx, { workspaceId, skillIds });
      if (!res.ok) throw new Error((res as any).message ?? "导出 Skill 资产包失败");
      trackProductEvent("orchestration_asset_transfer", {
        action: "export",
        asset_type: "skill",
        asset_count: skillIds.length,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return (res as any).bundle as OrchAssetBundle;
    },

    /** 导出工具资产包。 */
    async exportToolsetAssetBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, toolsetIds: ToolsetId[]) {
      const res = await exportOrchAssetBundle(ctx, { workspaceId, toolsetIds });
      if (!res.ok) throw new Error((res as any).message ?? "导出工具资产包失败");
      trackProductEvent("orchestration_asset_transfer", {
        action: "export",
        asset_type: "toolset",
        asset_count: toolsetIds.length,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return (res as any).bundle as OrchAssetBundle;
    },

    /** 导入资产包；仅向仍处于管理来源的类型回写结果和补偿刷新。 */
    async importWorkflowBundle(ctx: ApiRequestContext, workspaceId: WorkspaceId, bundle: OrchAssetBundle, importMode: OrchAssetBundleImportMode = "overwrite") {
      const workspaceEpoch = this.assetListWorkspaceEpoch;
      const refreshVersions = { ...this.assetListRefreshVersions };
      const clientRequestId = createAssetClientRequestId();
      const res = await importOrchAssetBundle(ctx, { workspaceId, bundle, importMode, clientRequestId });
      assertCurrentAssetListWorkspace(this.assetListWorkspaceEpoch, workspaceEpoch);
      if (!res.ok) throw createApiResultError(res);
      const imported = normalizeImportedAssetBundleResult(res.imported);
      const serverMetadata = prepareImportedAssetBundleMetadata(imported, res);
      if (serverMetadata) {
        await reconcileAndApplyImportedAssetBundle({
          state: this,
          imported,
          serverMetadata,
          requestRefreshVersions: refreshVersions,
          requestWorkspaceEpoch: workspaceEpoch,
          refresh: {
            role: () => this.refreshRoles(ctx, workspaceId),
            workflow: () => this.refreshWorkflows(ctx, workspaceId),
            knowledge_bundle: () => this.refreshKnowledgeBundles(ctx, workspaceId),
            toolset: () => this.refreshToolsets(ctx, workspaceId),
            skill: () => this.refreshSkills(ctx, workspaceId),
          },
        });
      } else {
        applyImportedAssetBundle(this, imported, null);
      }
      trackProductEvent("orchestration_asset_transfer", {
        action: "import",
        asset_type: "bundle",
        asset_count: imported.roles.length + imported.knowledgeBundles.length + imported.skills.length + imported.toolsets.length + imported.workflows.length,
        import_mode: importMode,
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
      return imported;
    },

    /** 分页累积轻量摘要后一次提交；失败或切换工作区不留下半份列表。 */
    async refreshProposals(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: { onlyRelatedToMe?: boolean | null }) {
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "proposals");
      if (!request) return;
      this.proposalsLoading = true;
      try {
        const proposals = new Map<string, WorkflowProposalSummary>();
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const res = await listOrchProposals(ctx, workspaceId, { onlyRelatedToMe: opts?.onlyRelatedToMe, cursor });
          if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
          assertApiOk(res, "加载方案列表失败");
          if (!res.ok || !Array.isArray(res.proposals)) throw new Error("方案列表响应缺少 proposals");
          if (res.hasMore !== undefined && typeof res.hasMore !== "boolean") throw new Error("方案列表分页状态无效");
          for (const proposal of res.proposals) proposals.set(proposal.id, {
            id: proposal.id, workspaceId: proposal.workspaceId, intakeId: proposal.intakeId, status: proposal.status,
            createdAt: proposal.createdAt, updatedAt: proposal.updatedAt,
            draftWorkflow: { id: proposal.draftWorkflow.id, name: proposal.draftWorkflow.name },
            sharedContext: proposal.sharedContext, readOnly: proposal.readOnly,
          });
          cursor = null;
          if (res.hasMore) {
            if (typeof res.nextCursor !== "string" || !res.nextCursor || res.nextCursor.length > 1_000
              || seenCursors.has(res.nextCursor)) throw new Error("方案列表分页游标无效或重复");
            cursor = res.nextCursor;
            seenCursors.add(cursor);
          }
        } while (cursor);
        this.proposals = [...proposals.values()];
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.proposalsLoading = false;
      }
    },

    async createProposal(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      input: Pick<OrchProposalsCreateRequestBody, "workflowId" | "roleId" | "intakeId" | "intake">,
    ) {
      const res = await createOrchProposal(ctx, {
        workspaceId,
        workflowId: input.workflowId ?? null,
        roleId: input.roleId ?? null,
        intakeId: input.intakeId ?? null,
        intake: input.intake ?? null,
      });
      if (!res.ok) throw new Error((res as any).message ?? "创建编排提案失败");
      const proposal = (res as any).proposal as WorkflowProposal;
      upsertLocal(this.proposals, proposal);
      const intakeId = String((res as any).intakeId ?? proposal.intakeId ?? "").trim();
      if (intakeId) {
        this.selectedIntakeId = intakeId as IntakeId;
        this.selectedIntakeSnapshot = proposal.intakeSnapshot?.id === intakeId ? proposal.intakeSnapshot : this.selectedIntakeSnapshot;
      }
      this.intakeComposerOpen = false;
      await this.refreshIntakes(ctx, workspaceId);
      this.selectedProposalId = proposal.id;
      return proposal;
    },

    async confirmProposal(ctx: ApiRequestContext, workspaceId: WorkspaceId, proposalId: ProposalId) {
      const res = await confirmOrchProposal(ctx, { workspaceId, proposalId });
      if (!res.ok) throw new Error((res as any).message ?? "确认编排提案失败");
      const proposal = (res as any).proposal as WorkflowProposal;
      upsertLocal(this.proposals, proposal);
      this.selectedProposalId = proposal.id;
      return proposal;
    },

    async startProposal(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      proposalId: ProposalId,
      executionEngineStrategy: OrchestrationExecutionEngineStrategy = "follow-role",
      roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null,
      runPlan?: OrchestrationRunPlan | null,
    ) {
      const startRes = await startOrchInstance(ctx, {
        workspaceId,
        proposalId,
        executionEngineStrategy,
        roleExecutionOverrides: roleExecutionOverrides ?? null,
        runPlan: runPlan ?? null,
      });
      if (!startRes.ok) throw new Error((startRes as any).message ?? "启动编排失败");
      const instanceId = (startRes as any).instanceId as OrchestrationId;
      trackProductEvent("orchestration_start", {
        execution_engine_strategy: executionEngineStrategy,
        has_run_plan: Boolean(runPlan),
        role_override_count: Object.keys(roleExecutionOverrides ?? {}).length,
      });
      await this.refreshProposals(ctx, workspaceId);
      await this.refreshInstances(ctx, workspaceId);
      await this.loadInstance(ctx, workspaceId, instanceId);
      this.activeTab = "tasks";
      return instanceId;
    },

    async executeIntake(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      input: {
        intakeId: IntakeId;
        workflowId?: WorkflowId | null;
        roleId?: RoleId | null;
        executionEngineStrategy?: OrchestrationExecutionEngineStrategy;
        roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
        runPlan?: OrchestrationRunPlan | null;
      },
    ) {
      const proposal = await this.createProposal(ctx, workspaceId, {
        workflowId: input.workflowId ?? null,
        roleId: input.roleId ?? null,
        intakeId: input.intakeId,
        intake: null,
      });
      await this.confirmProposal(ctx, workspaceId, proposal.id);
      return this.startProposal(
        ctx,
        workspaceId,
        proposal.id,
        input.executionEngineStrategy ?? "follow-role",
        input.roleExecutionOverrides ?? null,
        input.runPlan ?? null,
      );
    },

    async quickStartWorkflow(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      workflowId: WorkflowId,
      taskTitle: string,
      taskGoal: string,
    ) {
      const proposal = await this.createProposal(ctx, workspaceId, {
        workflowId,
        intake: {
          triggerMode: "manual",
          taskType: "unknown",
          title: normalizeTaskIntakeTitle(taskTitle, taskGoal),
          goal: taskGoal,
          background: null,
          acceptanceCriteria: null,
          workbenchItemRefs: null,
          seedArtifactRefs: null,
          constraints: { requireUserConfirmation: true },
          requester: { source: "ui" },
        },
      });
      await this.confirmProposal(ctx, workspaceId, proposal.id);
      return this.startProposal(ctx, workspaceId, proposal.id, "follow-role");
    },

    /** 刷新实例摘要；分类往返可复用已加载结果，显式刷新仍读取服务端真值。 */
    async refreshInstances(ctx: ApiRequestContext, workspaceId: WorkspaceId, opts?: { onlyRelatedToMe?: boolean | null; preferCache?: boolean }) {
      const onlyRelatedToMe = resolveSharedOnlyRelatedToMe(workspaceId, opts?.onlyRelatedToMe ?? this.intakeListOnlyRelatedToMe);
      const loadedScope = JSON.stringify([ctx.serverWsOrigin, ctx.webSessionId, ctx.desktopClientId ?? null,
        workspaceId, this.workspaceRequestGeneration, onlyRelatedToMe]);
      if (opts?.preferCache && this.instancesLoadedScope === loadedScope && !this.instancesLoading) return;
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, "instances");
      if (!request) return;
      this.instancesLoadedScope = null;
      const revision = this.instancesListRevision;
      this.instancesLoading = true;
      try {
        const [requirementRes, scheduledRes] = await Promise.all([
          listOrchInstances(ctx, workspaceId, { limit: 50, sourceKind: "requirement", onlyRelatedToMe }),
          listOrchInstances(ctx, workspaceId, { limit: 50, sourceKind: "scheduled_task" }),
        ]);
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        assertApiOk(requirementRes, "加载需求实例失败");
        assertApiOk(scheduledRes, "加载定时实例失败");
        const fetchedSummaries = normalizeOrchInstanceSummaries([
          ...((requirementRes as any).instances ?? []),
          ...((scheduledRes as any).instances ?? []),
        ]);
        this.instanceSummaries = mergeLatestInstanceSummariesFromListMeta(fetchedSummaries, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        const fetchedCounts = mergeCountMaps(
          normalizeInstanceTotalCountByIntake((requirementRes as any).totalCountByIntake),
          normalizeInstanceTotalCountByIntake((scheduledRes as any).totalCountByIntake),
        );
        this.instanceTotalCountByIntake = mergeInstanceCountsFromListMeta(fetchedCounts, [
          this.intakeListMetaById,
          this.scheduledIntakeListMetaById,
        ]);
        syncLoadedIntakeListMetaForSummaries(this, this.instanceSummaries);
        this.instancesHasMore = Boolean((requirementRes as any).hasMore) || Boolean((scheduledRes as any).hasMore);
        this.instancesNextCursor = ((requirementRes as any).nextCursor ?? (scheduledRes as any).nextCursor ?? null) as string | null;
        const selectedStillExists = this.selectedInstanceId
          ? this.instanceSummaries.some((item) => item.id === this.selectedInstanceId)
            || this.instances.some((item) => item.id === this.selectedInstanceId)
            || this.selectedInstance?.id === this.selectedInstanceId
          : false;
        if (!selectedStillExists) {
          this.selectedInstanceId = null;
          clearSelectedInstanceDetails(this);
        } else if (this.selectedInstanceId && this.selectedInstance?.id !== this.selectedInstanceId) {
          clearSelectedInstanceDetails(this);
        }
        if (this.instancesListRevision === revision) this.instancesLoadedScope = loadedScope;
      } catch (error) {
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return;
        throw error;
      } finally {
        if (isOrchestrationWorkspaceRequestCurrent(this, request)) this.instancesLoading = false;
      }
    },

    /** 选择并加载完整实例；默认读取服务端真值，仅显式 force=false 时复用本地快照。 */
    async loadInstance(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      options: { force?: boolean; loadDetails?: boolean; allowNetworkHydration?: NetworkHydrationGuard } = {},
    ): Promise<OrchestrationInstance | null> {
      if (this.workspaceScopeId != null && this.workspaceScopeId !== String(workspaceId)) return null;
      const requestKey = `${workspaceId}::selected-instance::${instanceId}`;
      const selectionScope = beginSelectedInstanceRequestScope(workspaceId, instanceId);
      const existing = pendingSelectedInstanceLoads.get(requestKey);
      if (existing) {
        this.selectedInstanceId = instanceId;
        if (this.selectedInstance?.id !== instanceId) clearSelectedInstanceDetails(this);
        const loaded = await existing;
        if (loaded && options.loadDetails && this.selectedInstanceId === instanceId) {
          await this.loadSelectedInstanceDetails(ctx, workspaceId, instanceId, {
            allowNetworkHydration: options.allowNetworkHydration,
          });
        }
        return loaded;
      }
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `selected-instance:${String(instanceId)}`);
      if (!request) return null;
      this.selectedInstanceId = instanceId;
      if (this.selectedInstance?.id !== instanceId) {
        clearSelectedInstanceDetails(this);
      }
      const cachedInstance = resolveTrackedInstanceSnapshot(this.selectedInstance, this.instances, instanceId);
      if (cachedInstance) {
        this.selectedInstance = cachedInstance;
        this.upsertInstanceSummaryFromInstance(cachedInstance);
        if (options.force === false) {
          if (options.loadDetails) {
            await this.loadSelectedInstanceDetails(ctx, workspaceId, instanceId, {
              allowNetworkHydration: options.allowNetworkHydration,
            });
          }
          return cachedInstance;
        }
      }
      const selectionStillCurrent = () => (
        this.selectedInstanceId === instanceId
        && isOrchestrationWorkspaceRequestCurrent(this, request)
      );
      const promise = (async () => {
        let res: Awaited<ReturnType<typeof getOrchInstance>>;
        try {
          res = await getOrchInstance(ctx, { workspaceId, instanceId }, { signal: selectionScope.controller.signal });
        } catch (error) {
          if (isCancelledRequestError(error)) return null;
          throw error;
        }
        if (!selectionStillCurrent()) return null;
        if (!res.ok) {
          this.selectedInstanceId = null;
          clearSelectedInstanceDetails(this);
          throw createOrchestrationApiResultError(res, "加载实例失败");
        }

        const fetchedInstance = (res as any).instance as OrchestrationInstance | null;
        const instance = fetchedInstance
          ? pickNewerInstanceSnapshot(resolveTrackedInstanceSnapshot(this.selectedInstance, this.instances, instanceId), fetchedInstance)
          : null;
        if (!instance) {
          this.selectedInstanceId = null;
          clearSelectedInstanceDetails(this);
          return null;
        }
        this.selectedInstance = instance;
        upsertLocalSorted(this.instances, instance, compareInstancesByUpdatedAt);
        trimLoadedInstanceCache(this.instances, this.selectedInstanceId);
        this.upsertInstanceSummaryFromInstance(instance);
        return instance;
      })().finally(() => {
        if (pendingSelectedInstanceLoads.get(requestKey) === promise) pendingSelectedInstanceLoads.delete(requestKey);
      });

      pendingSelectedInstanceLoads.set(requestKey, promise);
      const loaded = await promise;
      if (loaded && options.loadDetails && this.selectedInstanceId === instanceId) {
        await this.loadSelectedInstanceDetails(ctx, workspaceId, instanceId, {
          allowNetworkHydration: options.allowNetworkHydration,
        });
      }
      return loaded;
    },

    /** 产物目录返回即发布，正文预览不等待事件和提示词目录；详情错误仍统一收口。 */
    async loadSelectedInstanceDetails(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      options: { force?: boolean; allowNetworkHydration?: NetworkHydrationGuard } = {},
    ): Promise<void> {
      if (this.selectedInstanceId !== instanceId) return;
      if (this.workspaceScopeId != null && this.workspaceScopeId !== String(workspaceId)) return;
      if (!resolveNetworkHydrationGuard(options.allowNetworkHydration)) return;
      const requestKey = `${workspaceId}::selected-instance-details::${instanceId}`;
      const selectionScope = beginSelectedInstanceRequestScope(workspaceId, instanceId);
      const existing = pendingSelectedInstanceDetailLoads.get(requestKey);
      if (existing) {
        existing.networkGuards.add(options.allowNetworkHydration);
        if (options.force) this.selectedInstanceDetailErrors = {};
        await existing.promise;
        return;
      }
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `selected-instance-details:${String(instanceId)}`);
      if (!request) return;

      const selectionStillCurrent = () => (
        this.selectedInstanceId === instanceId
        && isOrchestrationWorkspaceRequestCurrent(this, request)
      );
      const networkGuards = new Set<NetworkHydrationGuard | undefined>([options.allowNetworkHydration]);
      const allowNetworkHydration = () => Array.from(networkGuards)
        .some((guard) => resolveNetworkHydrationGuard(guard));
      this.selectedInstanceDetailsLoading = true;
      if (options.force) this.selectedInstanceDetailErrors = {};
      const promise = (async () => {
        const errors: SelectedInstanceDetailErrors = {};
        const diagnosticSources: unknown[] = [];
        const [artifactResult, eventResult, promptSnapshotResult] = await Promise.allSettled([
          listOrchArtifacts(ctx, { workspaceId, instanceId }, { signal: selectionScope.controller.signal }).then((result) => {
            if (selectionStillCurrent() && result.ok) {
              this.selectedInstanceArtifacts = mergeArtifactList(this.selectedInstanceArtifacts, result.artifacts);
            }
            return result;
          }),
          listOrchEvents(
            ctx,
            { workspaceId, instanceId, limit: ORCH_DETAIL_EVENT_LIMIT, includePayload: false },
            { signal: selectionScope.controller.signal },
          ),
          listOrchPromptSnapshots(
            ctx,
            { workspaceId, instanceId, includeContent: false },
            { signal: selectionScope.controller.signal },
          ),
        ]);
        if (!selectionStillCurrent()) return;

        if (artifactResult.status !== "fulfilled" || !artifactResult.value.ok) {
          errors.artifacts = describeDetailLoadFailure(artifactResult);
          diagnosticSources.push(artifactResult.status === "rejected" ? artifactResult.reason : artifactResult.value);
        }
        if (eventResult.status === "fulfilled" && eventResult.value.ok) {
          this.selectedInstanceEvents = (eventResult.value as any).events ?? [];
        } else {
          errors.events = describeDetailLoadFailure(eventResult);
          diagnosticSources.push(eventResult.status === "rejected" ? eventResult.reason : eventResult.value);
        }
        if (promptSnapshotResult.status === "fulfilled" && promptSnapshotResult.value.ok) {
          this.selectedInstancePromptSnapshots = mergePromptSnapshotList(
            this.selectedInstancePromptSnapshots,
            (promptSnapshotResult.value as any).snapshots ?? [],
            instanceId,
          );
        } else {
          errors.promptSnapshots = describeDetailLoadFailure(promptSnapshotResult);
          diagnosticSources.push(promptSnapshotResult.status === "rejected" ? promptSnapshotResult.reason : promptSnapshotResult.value);
        }

        const selectionChanged = this.syncSelectedArtifactSelection();
        if (selectionChanged) this.selectedArtifactFiles = [];
        if (this.selectedArtifactId && allowNetworkHydration()) {
          const selectedArtifactId = this.selectedArtifactId;
          const selectedArtifact = this.selectedInstanceArtifacts.find((artifact) => artifact.id === selectedArtifactId);
          if (selectedArtifact && !String(selectedArtifact.contentJson ?? "").trim()) {
            try {
              const loadedArtifact = await this.loadArtifact(ctx, workspaceId, selectedArtifactId, {
                attachToNodeState: false,
                loadFiles: false,
                allowNetworkHydration: options.allowNetworkHydration,
              });
              if (!loadedArtifact) {
                errors.artifacts = `加载选中产物正文失败：${selectedArtifactId}`;
              }
            } catch (error) {
              errors.artifacts = error instanceof Error ? error.message : String(error);
              diagnosticSources.push(error);
            }
          }
          if (!selectionStillCurrent() || this.selectedArtifactId !== selectedArtifactId) return;
          if (allowNetworkHydration()) {
            try {
              await this.loadArtifactFiles(ctx, workspaceId, selectedArtifactId);
            } catch (error) {
              if (!selectionStillCurrent()) return;
              errors.artifactFiles = error instanceof Error ? error.message : String(error);
              diagnosticSources.push(error);
            }
          }
        } else if (!this.selectedArtifactId) {
          this.selectedArtifactFiles = [];
        }
        if (!selectionStillCurrent()) return;
        this.selectedInstanceDetailErrors = errors;
        this.selectedInstanceDetailsLoadedAt = Date.now();
        if (hasSelectedInstanceDetailErrors(errors)) {
          throw createSelectedInstanceDetailLoadError(errors, diagnosticSources);
        }
      })().catch((error) => {
        if (!selectionStillCurrent()) return;
        if (!hasSelectedInstanceDetailErrors(this.selectedInstanceDetailErrors)) {
          const reason = error instanceof Error ? error.message : String(error);
          this.selectedInstanceDetailErrors = {
            artifacts: reason,
            events: reason,
            promptSnapshots: reason,
          };
        }
        throw error;
      }).finally(() => {
        if (pendingSelectedInstanceDetailLoads.get(requestKey)?.promise === promise) {
          pendingSelectedInstanceDetailLoads.delete(requestKey);
        }
        if (selectionStillCurrent()) this.selectedInstanceDetailsLoading = false;
      });

      pendingSelectedInstanceDetailLoads.set(requestKey, { promise, networkGuards });
      await promise;
    },

    async loadTrackedInstance(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      options: { syncSelection?: boolean } = {},
    ): Promise<OrchestrationInstance | null> {
      const key = `${workspaceId}::instance::${instanceId}`;
      const callerGeneration = this.workspaceRequestGeneration;
      const settleForCaller = (instance: OrchestrationInstance | null): OrchestrationInstance | null => {
        if (!instance) return null;
        if (
          this.workspaceScopeId !== String(workspaceId)
          || this.workspaceRequestGeneration !== callerGeneration
        ) return null;
        if (options.syncSelection && this.selectedInstanceId === instanceId) {
          this.selectedInstance = instance;
        }
        return instance;
      };
      const existing = pendingInstancePatchLoads.get(key);
      if (existing) return settleForCaller(await existing);
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `tracked-instance:${String(instanceId)}`);
      if (!request) return null;
      const promise = (async () => {
        const res = await getOrchInstance(ctx, { workspaceId, instanceId });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return null;
        assertApiOk(res, "加载实例运行快照失败");
        const fetchedInstance = (res as any).instance as OrchestrationInstance | null;
        const instance = fetchedInstance
          ? pickNewerInstanceSnapshot(resolveTrackedInstanceSnapshot(this.selectedInstance, this.instances, instanceId), fetchedInstance)
          : null;
        if (!instance) return null;
        upsertLocalSorted(this.instances, instance, compareInstancesByUpdatedAt);
        trimLoadedInstanceCache(this.instances, this.selectedInstanceId);
        this.upsertInstanceSummaryFromInstance(instance);
        return instance;
      })().finally(() => {
        if (pendingInstancePatchLoads.get(key) === promise) pendingInstancePatchLoads.delete(key);
      });
      pendingInstancePatchLoads.set(key, promise);
      return settleForCaller(await promise);
    },

    /** 拉取实例运行态轻量补丁，供执行监控兜底刷新合并状态。 */
    async loadTrackedInstanceRuntimePatch(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      options: { syncSelection?: boolean } = {},
    ): Promise<OrchestrationInstanceRuntimePatch | null> {
      const key = `${workspaceId}::instance-runtime::${instanceId}`;
      const callerGeneration = this.workspaceRequestGeneration;
      const settleForCaller = (patch: OrchestrationInstanceRuntimePatch | null): OrchestrationInstanceRuntimePatch | null => {
        if (!patch) return null;
        if (
          this.workspaceScopeId !== String(workspaceId)
          || this.workspaceRequestGeneration !== callerGeneration
        ) return null;
        this.applyTrackedInstanceRuntimePatch(patch, options);
        return patch;
      };
      const existing = pendingInstanceRuntimePatchLoads.get(key);
      if (existing) return settleForCaller(await existing);
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `instance-runtime:${String(instanceId)}`);
      if (!request) return null;
      const promise = (async () => {
        const res = await getOrchInstanceRuntimePatch(ctx, { workspaceId, instanceId });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return null;
        assertApiOk(res, "加载实例运行态失败");
        const patch = (res as any).patch as OrchestrationInstanceRuntimePatch | null;
        if (!patch) return null;
        return patch;
      })().finally(() => {
        if (pendingInstanceRuntimePatchLoads.get(key) === promise) pendingInstanceRuntimePatchLoads.delete(key);
      });
      pendingInstanceRuntimePatchLoads.set(key, promise);
      return settleForCaller(await promise);
    },

    /** 定时任务启动新流程时刷新左侧定时编排，避免等待手动刷新。 */
    async refreshScheduledIntakesOnce(ctx: ApiRequestContext, workspaceId: WorkspaceId): Promise<void> {
      const key = String(workspaceId);
      const existing = pendingScheduledIntakeRefreshes.get(key);
      if (existing) return await existing;
      const promise = this.refreshScheduledIntakes(ctx, workspaceId).finally(() => {
        if (pendingScheduledIntakeRefreshes.get(key) === promise) pendingScheduledIntakeRefreshes.delete(key);
      });
      pendingScheduledIntakeRefreshes.set(key, promise);
      await promise;
    },

    async ensureSelectedInstanceDetails(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId | null = null,
      options: { force?: boolean; allowNetworkHydration?: NetworkHydrationGuard } = {},
    ): Promise<void> {
      const targetId = instanceId ?? this.selectedInstanceId;
      if (!targetId || this.selectedInstanceId !== targetId) return;
      const instance = resolveTrackedInstanceSnapshot(this.selectedInstance, this.instances, targetId);
      if (!instance) return;
      if (!options.force && !shouldHydrateSelectedInstanceDetails(
        instance,
        this.selectedInstanceArtifacts,
        this.selectedInstancePromptSnapshots,
      ) && this.selectedInstanceDetailsLoadedAt && !hasSelectedInstanceDetailErrors(this.selectedInstanceDetailErrors)) {
        return;
      }
      await this.loadSelectedInstanceDetails(ctx, workspaceId, targetId, options);
    },

    /** 同版本索引复用请求和结果；版本变化或作用域失效时拒绝旧索引回写。 */
    async loadArtifactFiles(ctx: ApiRequestContext, workspaceId: WorkspaceId, artifactId: ArtifactId): Promise<OrchArtifactFilesListResponseBody | null> {
      if (this.workspaceScopeId != null && this.workspaceScopeId !== String(workspaceId)) return null;
      const key = `${workspaceId}::artifact-files::${artifactId}`;
      const generation = this.workspaceRequestGeneration;
      const currentRevision = () => artifactRevisionKey(this.selectedInstanceArtifacts.find((item) => item.id === artifactId));
      const revision = currentRevision();
      let load = artifactFileLoads.get(key);
      if (!load || load.revision !== revision) {
        const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `artifact-files:${String(artifactId)}`);
        if (!request) return null;
        let reusable = false;
        const promise = (async () => {
          const result = await listOrchArtifactFiles(ctx, { workspaceId, artifactId });
          if (!isOrchestrationWorkspaceRequestCurrent(this, request) || currentRevision() !== revision) return null;
          if (!result.ok) {
            if (this.selectedArtifactId === artifactId) {
              this.selectedInstanceDetailErrors = { ...this.selectedInstanceDetailErrors, artifactFiles: result.message };
            }
            throw createOrchestrationApiResultError(result, "加载产物文件索引失败");
          }
          reusable = revision !== null;
          return { files: result.files, fields: result.fields };
        })().finally(() => {
          if (!reusable && artifactFileLoads.get(key)?.promise === promise) artifactFileLoads.delete(key);
        });
        load = { revision, promise };
        artifactFileLoads.set(key, load);
      }
      const result = await load.promise;
      if (this.workspaceScopeId !== String(workspaceId) || this.workspaceRequestGeneration !== generation
        || currentRevision() !== revision) return null;
      if (result && this.selectedArtifactId === artifactId) this.selectedArtifactFiles = result.files;
      return result;
    },

    /** 按 ID 加载完整产物，拒绝覆盖更新版本；调用方可关闭文件索引联动。 */
    async loadArtifact(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      artifactId: ArtifactId,
      options: {
        attachToNodeState?: boolean;
        loadFiles?: boolean;
        allowNetworkHydration?: NetworkHydrationGuard;
      } = {},
    ): Promise<Artifact | null> {
      const key = `${workspaceId}::artifact::${artifactId}`;
      const callerGeneration = this.workspaceRequestGeneration;
      const settleForCaller = async (artifact: Artifact | null): Promise<Artifact | null> => {
        if (!artifact) return null;
        if (
          this.workspaceScopeId !== String(workspaceId)
          || this.workspaceRequestGeneration !== callerGeneration
        ) return null;
        if (this.selectedInstance?.id === artifact.instanceId) {
          const current = this.selectedInstanceArtifacts.find((item) => item.id === artifact.id);
          if (current && (current.version > artifact.version
            || (current.version === artifact.version && current.updatedAt > artifact.updatedAt))) return null;
          upsertLocalSorted(this.selectedInstanceArtifacts, artifact, compareArtifactsByCreatedAt);
          if (options.attachToNodeState !== false) {
            this.applyTrackedInstancePatch(artifact.instanceId, (instance) => {
              instance.updatedAt = Math.max(instance.updatedAt ?? 0, artifact.updatedAt ?? Date.now());
              const nodeState = instance.nodeStates[artifact.nodeId];
              if (nodeState) {
                nodeState.outputArtifactIds = Array.from(new Set([...(nodeState.outputArtifactIds ?? []), artifact.id]));
                instance.nodeStates[artifact.nodeId] = nodeState;
              }
              const artifactIndex = { ...(instance.artifactIndex ?? {}) };
              artifactIndex[artifact.nodeId] = Array.from(new Set([...(artifactIndex[artifact.nodeId] ?? []), artifact.id]));
              instance.artifactIndex = artifactIndex;
            });
          }
          const selectionChanged = this.syncSelectedArtifactSelection();
          if (selectionChanged) this.selectedArtifactFiles = [];
          if (
            options.loadFiles !== false
            && resolveNetworkHydrationGuard(options.allowNetworkHydration)
            && this.selectedArtifactId === artifact.id
          ) {
            await this.loadArtifactFiles(ctx, workspaceId, artifact.id);
          }
        }
        return artifact;
      };
      const existing = pendingArtifactPatchLoads.get(key);
      if (existing) return await settleForCaller(await existing);
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `artifact:${String(artifactId)}`);
      if (!request) return null;
      const promise = (async () => {
        const res = await getOrchArtifact(ctx, { workspaceId, artifactId });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return null;
        assertApiOk(res, "加载产物正文失败");
        const artifact = (res as any).artifact as Artifact | null;
        if (!artifact) return null;
        return artifact;
      })().finally(() => {
        if (pendingArtifactPatchLoads.get(key) === promise) pendingArtifactPatchLoads.delete(key);
      });
      pendingArtifactPatchLoads.set(key, promise);
      return await settleForCaller(await promise);
    },

    async loadPromptSnapshot(ctx: ApiRequestContext, workspaceId: WorkspaceId, promptSnapshotId: string): Promise<NodePromptSnapshot | null> {
      const key = `${workspaceId}::prompt::${promptSnapshotId}`;
      const existing = pendingPromptSnapshotPatchLoads.get(key);
      if (existing) return await existing;
      const request = beginOrchestrationWorkspaceRequest(this, workspaceId, `prompt:${promptSnapshotId}`);
      if (!request) return null;
      const promise = (async () => {
        const res = await getOrchPromptSnapshot(ctx, { workspaceId, promptSnapshotId });
        if (!isOrchestrationWorkspaceRequestCurrent(this, request)) return null;
        assertApiOk(res, "加载 Prompt Snapshot 失败");
        const snapshot = (res as any).snapshot as NodePromptSnapshot | null;
        if (!snapshot) return null;
        if (this.selectedInstance?.id === snapshot.instanceId) {
          upsertLocalSorted(this.selectedInstancePromptSnapshots, snapshot, comparePromptSnapshotsByCreatedAt);
          this.applyTrackedInstancePatch(snapshot.instanceId, (instance) => {
            instance.updatedAt = Math.max(instance.updatedAt ?? 0, snapshot.createdAt ?? Date.now());
            const nodeState = instance.nodeStates[snapshot.nodeId];
            if (nodeState) {
              nodeState.promptSnapshotIds = Array.from(new Set([...(nodeState.promptSnapshotIds ?? []), snapshot.id]));
              instance.nodeStates[snapshot.nodeId] = nodeState;
            }
          });
        }
        return snapshot;
      })().finally(() => {
        if (pendingPromptSnapshotPatchLoads.get(key) === promise) pendingPromptSnapshotPatchLoads.delete(key);
      });
      pendingPromptSnapshotPatchLoads.set(key, promise);
      return await promise;
    },

    syncSelectedArtifactSelection(): boolean {
      const nextSelectedArtifactId = this.selectedInstanceArtifacts.some((artifact) => artifact.id === this.selectedArtifactId)
        ? this.selectedArtifactId
        : this.selectedInstanceArtifacts[0]?.id ?? null;
      const selectionChanged = nextSelectedArtifactId !== this.selectedArtifactId;
      this.selectedArtifactId = nextSelectedArtifactId;
      return selectionChanged;
    },

    /** 由完整实例刷新本地摘要缓存，确保事件与详情加载后列表态同步。 */
    upsertInstanceSummaryFromInstance(instance: OrchestrationInstance): void {
      const summary = deriveOrchestrationInstanceSummary(instance);
      upsertLocalSorted(this.instanceSummaries, summary, compareInstanceSummariesByUpdatedAt);
      const intakeId = String(instance.intakeSnapshot?.id ?? "").trim();
      const localCount = intakeId
        ? this.instanceSummaries.filter((summary) => summary.intakeId === intakeId).length
        : 0;
      if (intakeId && (this.instanceTotalCountByIntake[intakeId] == null || this.instanceTotalCountByIntake[intakeId] < localCount)) {
        this.instanceTotalCountByIntake = {
          ...this.instanceTotalCountByIntake,
          [intakeId]: localCount,
        };
      }
      syncLoadedIntakeListMetaForIntake(this, summary.intakeId);
    },

    applyTrackedInstancePatch(instanceId: OrchestrationId, updater: (instance: OrchestrationInstance) => void): void {
      const applied = new Set<OrchestrationInstance>();
      const selected = this.selectedInstance?.id === instanceId ? this.selectedInstance : null;
      if (selected) {
        updater(selected);
        reconcileTrackedInstanceStatus(selected);
        this.upsertInstanceSummaryFromInstance(selected);
        applied.add(selected);
      }
      const listed = this.instances.find((item) => item.id === instanceId) ?? null;
      if (listed && !applied.has(listed)) {
        updater(listed);
        reconcileTrackedInstanceStatus(listed);
        this.upsertInstanceSummaryFromInstance(listed);
      }
      trimLoadedInstanceCache(this.instances, this.selectedInstanceId);
    },

    /** 合并运行态轻量补丁，刷新监控状态且保留已加载详情大字段。 */
    applyTrackedInstanceRuntimePatch(
      patch: OrchestrationInstanceRuntimePatch,
      options: { syncSelection?: boolean } = {},
    ): void {
      const applied = new Set<OrchestrationInstance>();
      let summarySource: OrchestrationInstance | null = null;
      const selected = this.selectedInstance?.id === patch.id ? this.selectedInstance : null;
      if (selected) {
        mergeRuntimePatchIntoInstance(selected, patch);
        summarySource = selected;
        applied.add(selected);
      }

      const listed = this.instances.find((item) => item.id === patch.id) ?? null;
      if (listed && !applied.has(listed)) {
        mergeRuntimePatchIntoInstance(listed, patch);
        summarySource = summarySource ?? listed;
      }
      if (options.syncSelection && this.selectedInstanceId === patch.id && !selected && listed) {
        this.selectedInstance = listed;
      }

      const existingSummary = this.instanceSummaries.find((item) => item.id === patch.id) ?? null;
      const nextSummary = summarySource
        ? applyRuntimePatchToSummary(deriveOrchestrationInstanceSummary(summarySource), patch)
        : existingSummary
          ? applyRuntimePatchToSummary(existingSummary, patch)
          : null;
      if (nextSummary) {
        upsertLocalSorted(this.instanceSummaries, nextSummary, compareInstanceSummariesByUpdatedAt);
        syncLoadedIntakeListMetaForIntake(this, nextSummary.intakeId);
      }
      trimLoadedInstanceCache(this.instances, this.selectedInstanceId);
    },

    /** 暂停确认成功后才更新实例，业务拒绝保持当前状态并抛给组件边界。 */
    async pauseInstance(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId) {
      const res = await pauseOrchInstance(ctx, { workspaceId, instanceId });
      assertApiOk(res, "暂停编排失败");
      this.applyTrackedInstancePatch(instanceId, (instance) => {
        instance.status = "paused";
        instance.updatedAt = Date.now();
      });
    },

    /** 恢复编排实例；会话复用由普通恢复语义固定。 */
    async resumeInstance(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId) {
      const res = await resumeOrchInstance(ctx, { workspaceId, instanceId });
      assertApiOk(res, "恢复编排失败");
      this.applyTrackedInstancePatch(instanceId, (instance) => {
        instance.status = "running";
        instance.updatedAt = Date.now();
      });
    },

    /** 取消确认成功后同步本地终态，失败时不产生成功状态或埋点。 */
    async cancelInstance(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId) {
      const res = await cancelOrchInstance(ctx, { workspaceId, instanceId });
      assertApiOk(res, "取消编排失败");
      this.applyTrackedInstancePatch(instanceId, (instance) => {
        instance.status = "cancelled";
        instance.updatedAt = Date.now();
      });
      trackProductEvent("orchestration_control", {
        action: "cancel_instance",
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
    },

    /** 确认停止节点成功后才记操作，状态仍等待原事件同步。 */
    async cancelNode(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId, nodeId: string) {
      const res = await cancelOrchNode(ctx, { workspaceId, instanceId, nodeId });
      assertApiOk(res, "停止节点失败");
      trackProductEvent("orchestration_control", {
        action: "cancel_node",
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
    },

    /** 启动 waiting-start 节点；可带本次启动前补充说明，本地等待后端事件同步。 */
    async startNode(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId, nodeId: string, feedback?: string | null) {
      const res = await startOrchNode(ctx, { workspaceId, instanceId, nodeId, feedback: String(feedback ?? "").trim() || null });
      assertApiOk(res, "启动节点失败");
      trackProductEvent("orchestration_manual_start", {
        has_feedback: Boolean(String(feedback ?? "").trim()),
      });
    },

    /** 跳过 waiting-start 节点；本地等待后端事件/补丁同步。 */
    async skipNode(ctx: ApiRequestContext, workspaceId: WorkspaceId, instanceId: OrchestrationId, nodeId: string) {
      const res = await skipOrchNode(ctx, { workspaceId, instanceId, nodeId });
      assertApiOk(res, "跳过节点失败");
      trackProductEvent("orchestration_control", {
        action: "skip_node",
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
      });
    },

    /** 提交节点反馈；显式换会话只通过从节点重跑入口处理。 */
    async submitFeedback(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      nodeId: string,
      action: FeedbackAction,
      feedback?: string,
      artifactIds?: ArtifactId[],
      targetNodeId?: string | null,
      images?: string[] | null,
    ) {
      const res = await submitOrchFeedback(ctx, {
        workspaceId,
        instanceId,
        nodeId,
        action,
        feedback,
        artifactIds,
        targetNodeId,
        images,
      });
      assertApiOk(res, "提交节点反馈失败");
      trackProductEvent("orchestration_review_submit", {
        action,
        has_feedback: Boolean(String(feedback ?? "").trim()),
        artifact_count: artifactIds?.length ?? 0,
        has_images: Boolean(images?.length),
        image_count: images?.length ?? 0,
        has_target_node: Boolean(String(targetNodeId ?? "").trim()),
      });
    },

    /**
     * 「从指定节点重跑」：透传到后端 rerun-from-node API，并同步本地已知的运行覆盖。
     * 子图重置与 running 状态回写都由引擎事件驱动，避免前端伪造节点生命周期。
     */
    async rerunInstanceFromNode(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      targetNodeId: string,
      note?: string | null,
      options?: {
        threadReusePolicy?: NodeThreadReusePolicy | null;
        downstreamThreadReusePolicy?: DownstreamThreadReusePolicy | null;
        images?: string[] | null;
        rerunNodeIds?: string[] | null;
        roleExecutionOverrides?: Record<string, OrchestrationRoleExecutionOverride> | null;
        applyLatestWorkItemPolicy?: boolean | null;
      },
    ) {
      const res = await rerunOrchInstanceFromNode(ctx, {
        workspaceId,
        instanceId,
        targetNodeId,
        note,
        images: options?.images ?? null,
        threadReusePolicy: options?.threadReusePolicy ?? null,
        downstreamThreadReusePolicy: options?.downstreamThreadReusePolicy ?? null,
        rerunNodeIds: options?.rerunNodeIds ?? null,
        roleExecutionOverrides: options?.roleExecutionOverrides ?? null,
        applyLatestWorkItemPolicy: options?.applyLatestWorkItemPolicy ?? null,
      });
      assertApiOk(res, "从节点重跑失败");
      trackProductEvent("orchestration_control", {
        action: "rerun_from_node",
        workspace_type: isSharedWorkspaceSelectionId(workspaceId) ? "shared" : "local",
        has_note: Boolean(String(note ?? "").trim()),
        has_images: Boolean(options?.images?.length),
        image_count: options?.images?.length ?? 0,
        rerun_node_count: options?.rerunNodeIds?.length ?? 0,
        override_count: Object.keys(options?.roleExecutionOverrides ?? {}).length,
        sync_work_item_policy: options?.applyLatestWorkItemPolicy === true,
        thread_reuse_policy: options?.threadReusePolicy ?? null,
        downstream_thread_reuse_policy: options?.downstreamThreadReusePolicy ?? null,
      });
      const overrides = options?.roleExecutionOverrides;
      if (overrides && Object.keys(overrides).length > 0) {
        this.applyTrackedInstancePatch(instanceId, (instance) => {
          const current = instance.runtimeConfig?.roleExecutionOverrides ?? {};
          const next = Object.fromEntries(
            Object.entries(overrides).map(([roleId, override]) => [
              roleId,
              { ...(current[roleId] ?? {}), ...override },
            ]),
          );
          instance.runtimeConfig = {
            ...(instance.runtimeConfig ?? {}),
            roleExecutionOverrides: { ...current, ...next },
          };
        });
      }
    },

    async ensureDiscussionThread(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      nodeId: string,
    ): Promise<{ thread: ThreadSummary; created: boolean }> {
      const res = await ensureOrchDiscussionThread(ctx, { workspaceId, instanceId, nodeId });
      if (!res.ok) throw new Error((res as any).message ?? "打开讨论线程失败");
      const thread = (res as any).thread as ThreadSummary;
      const created = Boolean((res as any).created);
      this.applyTrackedInstancePatch(instanceId, (instance) => {
        const nodeState = instance.nodeStates[nodeId];
        if (!nodeState) return;
        nodeState.discussionThreadId = thread.id;
        instance.nodeStates[nodeId] = nodeState;
      });
      return { thread, created };
    },

    async reviseArtifact(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      instanceId: OrchestrationId,
      nodeId: string,
      artifactId: ArtifactId,
      input: {
        note?: string | null;
        answer: NodeExecutionEnvelope;
        workspaceFiles?: Array<{ path: string; content: string }> | null;
      },
    ): Promise<Artifact> {
      const res = await reviseOrchArtifact(ctx, {
        workspaceId,
        instanceId,
        nodeId,
        artifactId,
        note: input.note ?? null,
        answer: input.answer,
        workspaceFiles: input.workspaceFiles ?? null,
      });
      if (!res.ok) throw new Error(res.message);
      const revised = (res as any).artifact as Artifact;
      const files = (res as any).files as ArtifactFileEntry[] | undefined;
      if (this.selectedInstance?.id === instanceId) {
        upsertLocalSorted(this.selectedInstanceArtifacts, revised, compareArtifactsByCreatedAt);
        this.selectedArtifactId = revised.id;
        this.selectedArtifactFiles = files ?? [];
        this.applyTrackedInstancePatch(instanceId, (instance) => {
          instance.updatedAt = Math.max(instance.updatedAt ?? 0, revised.updatedAt ?? Date.now());
          const nodeState = instance.nodeStates[nodeId];
          if (nodeState) {
            nodeState.outputArtifactIds = Array.from(new Set([...(nodeState.outputArtifactIds ?? []), revised.id]));
            instance.nodeStates[nodeId] = nodeState;
          }
          const artifactIndex = { ...(instance.artifactIndex ?? {}) };
          artifactIndex[nodeId] = Array.from(new Set([...(artifactIndex[nodeId] ?? []), revised.id]));
          instance.artifactIndex = artifactIndex;
        });
      }
      return revised;
    },

    async resyncSelectedInstance(ctx: ApiRequestContext, workspaceId: WorkspaceId) {
      if (!this.selectedInstanceId) return;
      if (this.selectedInstance && this.selectedInstance.workspaceId !== workspaceId) return;
      await this.loadInstance(ctx, workspaceId, this.selectedInstanceId);
    },

    createDefaultKnowledgeBundle(workspaceId: WorkspaceId, scope: KnowledgeBundleDefinition["scope"] = "shared") {
      return {
        id: "" as KnowledgeBundleId,
        workspaceId,
        name: "新知识库",
        scope,
        description: [
          `适用场景：这组知识主要服务于${scope === "workflow" ? "流程默认" : scope === "role" ? "角色默认" : "全局共享"}的编排节点，补充稳定背景和约束。`,
          "覆盖范围：包含团队约定、关键文档和可浏览的项目目录，帮助 AI 在执行时快速建立上下文。",
          "优先关注：先看 README、src、tests 等关键来源，再按需深入具体文件。",
        ].join("\n"),
        sourceRefs: [
          createKnowledgeSourceRef({
            kind: "workspace-dir",
            title: "项目目录",
            ref: ".",
            description: "整个工作区都可访问。执行时优先查看 README、src、tests 等目录，再按需读取具体文件。",
          }),
        ],
      } satisfies Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">;
    },

    createDefaultSkill(workspaceId: WorkspaceId) {
      const name = "新 Skill";
      const slug = "new-skill";
      const description = "一句话说明这个 Skill 解决什么稳定场景。";
      const trigger = "当角色需要执行该类稳定工作流时使用。";
      const instructions = [
        "先判断当前任务是否符合 trigger；如果不符合，不要强行套用本 Skill。",
        "符合时，按本 Skill 的步骤执行，并结合当前节点的角色、任务、知识库和工具边界。",
        "若本 Skill 与当前节点的明确要求冲突，以当前节点要求为准，并说明冲突点。",
      ].join("\n");
      const skillMd = buildDefaultSkillMd({ name, slug, description, trigger, instructions });
      return {
        id: "" as SkillId,
        workspaceId,
        name,
        slug,
        description,
        trigger,
        instructions,
        targetEngines: ["codex", "claude"],
        packageVersion: 1,
        skillMd,
        files: [createTextSkillPackageFile("SKILL.md", "skill-md", skillMd)],
        scripts: [],
        installTargets: ["codex", "claude"],
        packageHash: null,
        tags: [],
        kind: "custom",
      } satisfies Omit<SkillDefinition, "createdAt" | "updatedAt">;
    },

    createDefaultToolset(workspaceId: WorkspaceId) {
      return {
        id: "" as ToolsetId,
        workspaceId,
        name: "新工具",
        description: "",
        tools: [
          {
            id: "tool-read-workspace",
            name: "读取工作区文件",
            description: "读取指定文件并提取需要的信息。",
            runtime: "shell",
            invocationHint: [
              "适用场景：当您已经知道要查看的文件或目录，且只需要做一次只读检查时，优先使用这个工具。",
              "不要使用：如果只是概念性分析、无需读取真实文件，或者直接用引擎原生 Read/Glob/Bash 就更顺手，就不要多包一层平台工具。",
              "输入要求：先明确 path，必要时再补 query；不要在路径和目标都不清楚时盲调。",
              "调用后：先总结读到了什么，再决定是否继续打开更多文件、进入修改，还是把发现写进结果。",
            ].join("\n"),
            code: "rg -n \"关键词\" path/to/file",
            inputSchema: "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"query\":{\"type\":\"string\"}},\"required\":[\"path\"]}",
            outputSchema: "{\"type\":\"object\",\"properties\":{\"summary\":{\"type\":\"string\"}}}",
            timeoutMs: 15_000,
            workingDirectory: ".",
            requiresWrite: false,
          },
        ],
      } satisfies Omit<ToolsetDefinition, "createdAt" | "updatedAt">;
    },

    /** 合并流程事件；异步补全后仍须属于原工作区代次，隐藏页只合并缓存。 */
    async onOrchestrationEvent(
      ctx: ApiRequestContext,
      workspaceId: WorkspaceId,
      event: OrchestrationEventRecord,
      options: { hydrateUnknownInstance?: boolean; allowNetworkHydration?: NetworkHydrationGuard } = {},
    ) {
      if (!String(event.type ?? "").startsWith("orchestration.")) return;
      const eventGeneration = this.workspaceRequestGeneration;
      const isEventScopeCurrent = () => this.workspaceRequestGeneration === eventGeneration
        && (this.workspaceScopeId == null || this.workspaceScopeId === String(workspaceId));
      if (!isEventScopeCurrent()) return;
      this.instancesLoadedScope = null;
      this.instancesListRevision += 1;

      const payload = safeParseOrchestrationPayload(event.payloadJson);
      const instanceId = String(payload?.instanceId ?? event.instanceId ?? "").trim() as OrchestrationId;
      if (!instanceId) return;
      // 兼容旧 hydrateUnknownInstance，同时允许可见性 predicate 在每个 await 后动态生效。
      const allowNetworkHydration = () => {
        return isEventScopeCurrent() && resolveNetworkHydrationGuard(
          options.allowNetworkHydration,
          options.hydrateUnknownInstance !== false,
        );
      };
      const fullInstanceKnown = this.selectedInstance?.id === instanceId || this.instances.some((item) => item.id === instanceId);
      const summaryKnown = this.instanceSummaries.some((item) => item.id === instanceId);
      if (event.type === "orchestration.managedServices.changed" && !fullInstanceKnown && !summaryKnown) {
        return;
      }
      if (!fullInstanceKnown && !allowNetworkHydration()) return;
      if (!fullInstanceKnown) {
        await this.loadTrackedInstance(ctx, workspaceId, instanceId, {
          syncSelection: this.selectedInstanceId === instanceId,
        });
        if (!isEventScopeCurrent()) return;
      }
      if (allowNetworkHydration() && isScheduledTaskInstanceStartedEvent(event, payload)) {
        await this.refreshScheduledIntakesOnce(ctx, workspaceId);
        if (allowNetworkHydration()) await this.refreshInstances(ctx, workspaceId);
        if (!isEventScopeCurrent()) return;
      }

      if (event.type === "orchestration.managedServices.changed") {
        if (this.selectedInstance?.id === instanceId) {
          upsertLocalSorted(this.selectedInstanceEvents, event, compareOrchestrationEventsByCreatedAt);
          this.selectedInstanceEvents = this.selectedInstanceEvents.slice(-200);
        }
        return;
      }

      this.applyTrackedInstancePatch(instanceId, (instance) => {
        const previousUpdatedAt = instance.updatedAt ?? 0;
        const eventCreatedAt = event.createdAt ?? Date.now();
        const snapshotFreshness = compareTrackedSnapshotFreshness(previousUpdatedAt, eventCreatedAt);
        instance.updatedAt = Math.max(previousUpdatedAt, eventCreatedAt);
        if (event.type === "orchestration.started" || event.type === "orchestration.resumed") {
          instance.status = "running";
        }
        if (event.type === "orchestration.paused") {
          instance.status = "paused";
        }
        if (event.type === "orchestration.completed") {
          instance.status = String(payload?.status ?? instance.status) as OrchestrationInstance["status"];
        }
        if (event.type === "orchestration.cancelled") {
          instance.status = "cancelled";
        }
        if (event.type === "orchestration.error") {
          instance.status = "failed";
        }

        if (event.type === "orchestration.reworkRequested") {
          instance.status = "running";
          const targetNodeId = String(payload?.targetNodeId ?? "").trim();
          if (!targetNodeId) return;
          const affectedNodeIds = collectTrackedAffectedNodeIds(instance, targetNodeId, payload?.affectedNodeIds);
          for (const affectedNodeId of affectedNodeIds) {
            const affectedNodeState = instance.nodeStates[affectedNodeId];
            if (!affectedNodeState) continue;
            resetTrackedNodeStateForRetry(affectedNodeState);
            affectedNodeState.status = "pending";
            instance.nodeStates[affectedNodeId] = affectedNodeState;
          }
          instance.artifactIndex = pruneTrackedArtifactIndex(instance.artifactIndex, affectedNodeIds) ?? {};
          return;
        }

        const nodeId = String(payload?.nodeId ?? "").trim();
        if (!nodeId) return;
        const currentNodeState = instance.nodeStates[nodeId];
        if (event.type === "orchestration.nodeStateChanged" && payload?.nodeState && typeof payload.nodeState === "object") {
          const incomingNodeState = payload.nodeState as NodeExecutionState;
          if (!currentNodeState) {
            instance.nodeStates[nodeId] = incomingNodeState;
            return;
          }
          instance.nodeStates[nodeId] = mergeNodeExecutionStateSnapshots(currentNodeState, incomingNodeState, {
            newerSnapshot: snapshotFreshness,
          });
          return;
        }
        if (!currentNodeState) return;
        if (event.type === "orchestration.nodeStateChanged") {
          const eventExecutionId = String(payload?.nodeExecutionId ?? "").trim() || null;
          const incomingNodeState: NodeExecutionState = {
            ...currentNodeState,
            status: String(payload?.status ?? currentNodeState.status) as any,
            attemptId: eventExecutionId ?? currentNodeState.attemptId ?? null,
            nodeExecutionId: eventExecutionId ?? currentNodeState.nodeExecutionId ?? currentNodeState.attemptId ?? null,
            attemptNo: payload?.attemptNo == null ? currentNodeState.attemptNo ?? null : Number(payload.attemptNo),
            parentExecutionId: Object.prototype.hasOwnProperty.call(payload ?? {}, "parentExecutionId")
              ? (payload?.parentExecutionId ? String(payload.parentExecutionId) : null)
              : currentNodeState.parentExecutionId ?? null,
            threadId: Object.prototype.hasOwnProperty.call(payload ?? {}, "threadId")
              ? (payload?.threadId ? String(payload.threadId) : null)
              : currentNodeState.threadId ?? null,
          };
          instance.nodeStates[nodeId] = mergeNodeExecutionStateSnapshots(currentNodeState, incomingNodeState, {
            newerSnapshot: snapshotFreshness,
          });
          return;
        }
        if (event.type === "orchestration.gateResult" && Array.isArray(payload?.results)) {
          currentNodeState.gateResults = payload.results as any;
          instance.nodeStates[nodeId] = currentNodeState;
          return;
        }
        if (event.type === "orchestration.approvalRequested") {
          currentNodeState.status = "waiting-approval";
          currentNodeState.humanActionSource = "approval";
          if (payload?.artifactId) {
            currentNodeState.outputArtifactIds = Array.from(new Set([...(currentNodeState.outputArtifactIds ?? []), String(payload.artifactId)]));
          }
          instance.nodeStates[nodeId] = currentNodeState;
          return;
        }
        if (event.type === "orchestration.feedbackRequested") {
          currentNodeState.status = "waiting-feedback";
          currentNodeState.humanActionSource = typeof payload?.source === "string" ? payload.source as any : currentNodeState.humanActionSource ?? null;
          if (payload?.reason) {
            currentNodeState.error = String(payload.reason);
          }
          if (payload?.artifactId) {
            currentNodeState.outputArtifactIds = Array.from(new Set([...(currentNodeState.outputArtifactIds ?? []), String(payload.artifactId)]));
          }
          instance.nodeStates[nodeId] = currentNodeState;
          return;
        }
        if (event.type === "orchestration.error") {
          currentNodeState.error = String(payload?.error ?? currentNodeState.error ?? "");
          instance.nodeStates[nodeId] = currentNodeState;
        }
      });

      if (this.selectedInstance?.id === instanceId) {
        upsertLocalSorted(this.selectedInstanceEvents, event, compareOrchestrationEventsByCreatedAt);
        this.selectedInstanceEvents = this.selectedInstanceEvents.slice(-200);
      }

      const artifactId = String(payload?.artifactId ?? "").trim() as ArtifactId;
      if (allowNetworkHydration() && artifactId && this.selectedInstance?.id === instanceId) {
        const artifact = await this.loadArtifact(ctx, workspaceId, artifactId, {
          attachToNodeState: event.type !== "orchestration.artifactDiscarded",
          loadFiles: false,
        });
        if (
          artifact
          && allowNetworkHydration()
          && this.selectedInstance?.id === instanceId
          && this.selectedArtifactId === artifactId
        ) {
          await this.loadArtifactFiles(ctx, workspaceId, artifactId);
        }
      }
      const promptSnapshotId = String(payload?.promptSnapshotId ?? "").trim();
      if (allowNetworkHydration() && promptSnapshotId && this.selectedInstance?.id === instanceId) {
        await this.loadPromptSnapshot(ctx, workspaceId, promptSnapshotId);
      }
    },


    /** 切换工作区时使全部在途请求失效，并清空工作区级状态。 */
    resetForWorkspace(workspaceId: WorkspaceId | null = null) {
      cancelSelectedInstanceRequests(workspaceId == null ? "clear" : "workspace-switch");
      this.workspaceScopeId = workspaceId == null ? null : String(workspaceId);
      this.workspaceRequestGeneration += 1;
      this.workspaceRequestSequence = 0;
      this.workspaceLatestRequestByScope = {};
      this.assetListWorkspaceEpoch += 1;

      this.intakes = [];
      this.intakesLoading = false;
      this.intakesLoadingMore = false;
      this.intakesHasMore = false;
      this.intakesNextCursor = null;
      this.intakeStatusCounts = [];
      this.intakeTotalCount = 0;
      this.intakeListMetaById = {};
      this.scheduledIntakes = [];
      this.scheduledIntakesLoading = false;
      this.scheduledIntakesLoadingMore = false;
      this.scheduledIntakesHasMore = false;
      this.scheduledIntakesNextCursor = null;
      this.scheduledIntakeStatusCounts = [];
      this.scheduledIntakeTotalCount = 0;
      this.scheduledIntakeListMetaById = {};
      this.pendingMineItems = [];
      this.pendingMineLoading = false;
      this.pendingMineLoadingMore = false;
      this.pendingMineHasMore = false;
      this.pendingMineNextCursor = null;
      this.pendingMineStatusCounts = [];
      this.pendingMineTotalCount = 0;
      this.intakeListOnlyRelatedToMe = true;
      this.roles = [];
      this.rolesLoading = false;
      this.workflows = [];
      this.workflowsLoading = false;
      this.assigneeTemplates = [];
      this.assigneeTemplatesLoading = false;
      this.proposals = [];
      this.proposalsLoading = false;
      this.knowledgeBundles = [];
      this.knowledgeBundlesLoading = false;
      this.skills = [];
      this.skillsLoading = false;
      this.toolsets = [];

      this.assetListMetadata = createEmptyAssetListMetadataState();
      this.assetListRefreshVersions = incrementAssetListRefreshVersions(this.assetListRefreshVersions);
      this.assetListLoaded = createEmptyAssetListLoadedState();
      this.assetListHostIds = { role: [], workflow: [], knowledge_bundle: [], skill: [], toolset: [] };
      this.assetListLoadPromises = createEmptyAssetListLoadPromiseState();
      this.assetListPurposes = { role: "catalog", workflow: "catalog" };
      this.rolesLoading = false;
      this.workflowsLoading = false;
      this.knowledgeBundlesLoading = false;
      this.skillsLoading = false;

      this.toolsetsLoading = false;
      this.instances = [];
      this.instanceSummaries = [];
      this.instanceTotalCountByIntake = {};
      this.instancesHasMore = false;
      this.instancesNextCursor = null;
      this.instancesLoading = false;
      this.instancesLoadedScope = null;
      this.instancesListRevision = 0;
      this.selectedIntakeId = null;
      this.selectedIntakeSnapshot = null;
      this.intakeComposerOpen = false;
      this.selectedRoleId = null;
      this.selectedWorkflowId = null;
      this.selectedProposalId = null;
      this.selectedKnowledgeBundleId = null;
      this.selectedSkillId = null;
      this.selectedToolsetId = null;
      this.selectedInstanceId = null;
      clearSelectedInstanceDetails(this);
      this.uiIntentSeq = 0;
      this.pendingUiIntent = null;
      pendingArtifactPatchLoads.clear();
      pendingPromptSnapshotPatchLoads.clear();
      pendingInstancePatchLoads.clear();
      pendingInstanceRuntimePatchLoads.clear();
      pendingSelectedInstanceLoads.clear();
      pendingSelectedInstanceDetailLoads.clear();
      pendingScheduledIntakeRefreshes.clear();
    },
  },
});

export type OrchestrationStore = ReturnType<typeof useOrchestrationStore>;

/** 激活当前实例的请求域，并真实取消上一实例尚未完成的请求。 */
function beginSelectedInstanceRequestScope(
  workspaceId: WorkspaceId,
  instanceId: OrchestrationId,
): SelectedInstanceRequestScope {
  const key = `${workspaceId}::selected-instance::${instanceId}`;
  const current = selectedInstanceRequestScope;
  if (current?.key === key && !current.controller.signal.aborted) return current;
  cancelSelectedInstanceRequests("selection-change");
  const created = { key, controller: new AbortController() };
  selectedInstanceRequestScope = created;
  return created;
}

/** 取消当前实例请求域；取消原因供统一请求层识别并安静收口。 */
function cancelSelectedInstanceRequests(reason: AbortKind): void {
  const current = selectedInstanceRequestScope;
  selectedInstanceRequestScope = null;
  if (!current || current.controller.signal.aborted) return;
  pendingSelectedInstanceLoads.delete(current.key);
  pendingSelectedInstanceDetailLoads.delete(current.key.replace("::selected-instance::", "::selected-instance-details::"));
  current.controller.abort(createCancelledRequestError(reason));
}

type OrchestrationWorkspaceRequestToken = {
  workspaceId: string;
  generation: number;
  scope: string;
  requestId: number;
};

/** 登记工作区请求；不同工作区必须先 reset，避免无意切换当前数据口径。 */
function beginOrchestrationWorkspaceRequest(
  state: OrchestrationState,
  workspaceId: WorkspaceId,
  scope: string,
): OrchestrationWorkspaceRequestToken | null {
  const normalizedWorkspaceId = String(workspaceId ?? "").trim();
  if (!normalizedWorkspaceId) return null;
  if (state.workspaceScopeId == null) state.workspaceScopeId = normalizedWorkspaceId;
  if (state.workspaceScopeId !== normalizedWorkspaceId) return null;
  const requestId = state.workspaceRequestSequence + 1;
  state.workspaceRequestSequence = requestId;
  state.workspaceLatestRequestByScope[scope] = requestId;
  return {
    workspaceId: normalizedWorkspaceId,
    generation: state.workspaceRequestGeneration,
    scope,
    requestId,
  };
}

/** 仅允许当前工作区 generation 和当前 scope 的最新请求回写。 */
function isOrchestrationWorkspaceRequestCurrent(
  state: OrchestrationState,
  token: OrchestrationWorkspaceRequestToken | null,
): token is OrchestrationWorkspaceRequestToken {
  return Boolean(
    token
    && state.workspaceScopeId === token.workspaceId
    && state.workspaceRequestGeneration === token.generation
    && state.workspaceLatestRequestByScope[token.scope] === token.requestId,
  );
}

/** 每次派生下一网络请求前重新读取 guard，支持 KeepAlive 可见性在 await 期间变化。 */
function resolveNetworkHydrationGuard(
  guard: NetworkHydrationGuard | undefined,
  fallback = true,
): boolean {
  return typeof guard === "function" ? guard() : guard ?? fallback;
}

export type HydratedPlannerDraftFence = {
  active: boolean;
  startHydrationKey: string;
  currentHydrationKey: string;
  startIntakeId: string;
  currentIntakeId: string;
  startSelectionGeneration: number;
  currentSelectionGeneration: number;
  startDraftRevision: number;
  currentDraftRevision: number;
};

/** 判断慢 planner 请求完成后是否仍可恢复保存计划，防止覆盖期间的用户编辑。 */
export function shouldApplyHydratedPlannerDraft(fence: HydratedPlannerDraftFence): boolean {
  return fence.active
    && fence.startHydrationKey === fence.currentHydrationKey
    && fence.startIntakeId === fence.currentIntakeId
    && fence.startSelectionGeneration === fence.currentSelectionGeneration
    && fence.startDraftRevision === fence.currentDraftRevision;
}

/** 在慢水合完成后执行一次受 fence 保护的草稿恢复，供组件与行为测试共用。 */
export async function applyHydratedPlannerDraftIfCurrent(
  fence: HydratedPlannerDraftFence,
  apply: () => void | Promise<void>,
): Promise<boolean> {
  if (!shouldApplyHydratedPlannerDraft(fence)) return false;
  await apply();
  return true;
}


/** 创建未加载 Server 列表元数据的活动工作区初始状态。 */
function createEmptyAssetListMetadataState(): OrchestrationAssetListMetadataState {
  return {
    role: null,
    workflow: null,
    knowledge_bundle: null,
    toolset: null,
    skill: null,
  };
}

/** 创建五类刷新初始版本，版本仅用于当前页面生命周期内的并发门禁。 */
function createEmptyAssetListRefreshVersionState(): OrchestrationAssetListRefreshVersionState {
  return {
    role: 0,
    workflow: 0,
    knowledge_bundle: 0,
    toolset: 0,
    skill: 0,
  };
}

/** 创建五类资产列表的未读取状态，避免以数组长度推断空列表是否已加载。 */
function createEmptyAssetListLoadedState(): OrchestrationAssetListLoadedState {
  return {
    role: false,
    workflow: false,
    knowledge_bundle: false,
    toolset: false,
    skill: false,
  };
}

/** 创建五类资产列表的空在途请求状态。 */
function createEmptyAssetListLoadPromiseState(): OrchestrationAssetListLoadPromiseState {
  return {
    role: null,
    workflow: null,
    knowledge_bundle: null,
    toolset: null,
    skill: null,
  };
}

/** 工作区重置时整体推进刷新版本，使此前全部列表请求失效。 */
function incrementAssetListRefreshVersions(
  current: OrchestrationAssetListRefreshVersionState,
): OrchestrationAssetListRefreshVersionState {
  return {
    role: current.role + 1,
    workflow: current.workflow + 1,
    knowledge_bundle: current.knowledge_bundle + 1,
    toolset: current.toolset + 1,
    skill: current.skill + 1,
  };
}

/** 判断列表响应是否仍属于当前工作区及该类型的最新刷新。 */
function isCurrentAssetListRefresh(
  state: Pick<OrchestrationState, "assetListWorkspaceEpoch" | "assetListRefreshVersions">,
  assetType: OrchAssetType,
  workspaceEpoch: number,
  refreshVersion: number,
): boolean {
  return state.assetListWorkspaceEpoch === workspaceEpoch
    && state.assetListRefreshVersions[assetType] === refreshVersion;
}

/** 管理写入仅维护管理快照，执行候选由目标 Client 的列表读取负责。 */
function isCatalogAssetList(state: OrchestrationState, assetType: OrchAssetType): boolean {
  return (assetType !== "role" && assetType !== "workflow") || state.assetListPurposes[assetType] === "catalog";
}

/** 工作区切换后拒绝把旧工作区 mutation 结果写入当前活动状态。 */
function assertCurrentAssetListWorkspace(currentEpoch: number, requestEpoch: number): void {
  if (currentEpoch !== requestEpoch) throw createCancelledRequestError("workspace-switch");
}

type AssetUpsertRequestMetadata = {
  clientRequestId: string;
  expectedRevision?: number | null;
};
type AssetDeleteRequestMetadata = {
  clientRequestId: string;
  expectedRevision?: number;
};

/** Assigns a browser UUID before a new asset enters either the legacy or Server write path. */
function ensureAssetMutationId<T extends string>(assetId: T): T {
  if (assetId) return assetId;
  return createBrowserUuid() as T;
}

/** Builds one request-stable idempotency key and uses Server list metadata as the only revision source. */
function prepareAssetMutationRequestMetadata(
  state: OrchestrationState,
  assetType: OrchAssetType,
  assetId: string,
  operation: "upsert",
): AssetUpsertRequestMetadata;
/** Builds delete metadata without permitting a null optimistic revision. */
function prepareAssetMutationRequestMetadata(
  state: OrchestrationState,
  assetType: OrchAssetType,
  assetId: string,
  operation: "delete",
): AssetDeleteRequestMetadata;
function prepareAssetMutationRequestMetadata(
  state: OrchestrationState,
  assetType: OrchAssetType,
  assetId: string,
  operation: "upsert" | "delete",
): AssetUpsertRequestMetadata | AssetDeleteRequestMetadata {
  if (state.assetListHostIds[assetType].includes(assetId)) throw new Error("Host 资产只读，请在承载工作区维护原定义");
  const clientRequestId = createAssetClientRequestId();
  const metadata = state.assetListMetadata[assetType];
  if (metadata === null) return { clientRequestId };
  const current = metadata.find((item) => item.assetId === assetId);
  if (current) return { clientRequestId, expectedRevision: current.revision };
  if (operation === "upsert") return { clientRequestId, expectedRevision: null };
  throw invalidAssetListResponse(assetType, "删除目标缺少当前修订元数据");
}

/** 生成一次 Web 资产写请求使用的稳定幂等标识。 */
function createAssetClientRequestId(): string {
  return `web_${createBrowserUuid()}`;
}

/** 本地列表修改后清除对应元数据，并阻止更早的刷新恢复旧快照。 */
function invalidateAssetListMetadata(state: OrchestrationState, assetType: OrchAssetType): void {
  state.assetListMetadata[assetType] = null;
  advanceAssetListMutationVersion(state, assetType);
}

/** 推进单类型 mutation 版本并结束更早刷新遗留的 loading。 */
function advanceAssetListMutationVersion(state: OrchestrationState, assetType: OrchAssetType): void {
  state.assetListRefreshVersions[assetType] += 1;
  switch (assetType) {
    case "role":
      state.rolesLoading = false;
      break;
    case "workflow":
      state.workflowsLoading = false;
      break;
    case "knowledge_bundle":
      state.knowledgeBundlesLoading = false;
      break;
    case "toolset":
      state.toolsetsLoading = false;
      break;
    case "skill":
      state.skillsLoading = false;
      break;
  }
}

type AssetMutationResponseMetadata<T extends OrchAssetType> = {
  changeSeq?: unknown;
  cacheStatus?: unknown;
  assetMetadata?: OrchAssetListMetadata<T>;
};

/** Binds an authoritative upsert response to the exact asset identity sent by this request. */
function validateAssetUpsertMutationResponse<T extends OrchAssetType>(
  assetType: T,
  requestAssetId: string,
  responseAssetId: string,
  response: AssetMutationResponseMetadata<T>,
): OrchAssetListMetadata<T> | null {
  const server = readServerAssetMutationMetadata(assetType, response, true, requestAssetId);
  if (server && responseAssetId !== requestAssetId) {
    throw invalidAssetListResponse(assetType, "保存响应资产身份与请求不一致");
  }
  return server?.assetMetadata ?? null;
}

/** Preserves a revision loaded after this mutation started when it is newer than the mutation result. */
function hasNewerAssetMutationRevision(
  state: OrchestrationState,
  assetType: OrchAssetType,
  assetId: string,
  requestRefreshVersion: number,
  mutationRevision: number,
): boolean {
  if (state.assetListRefreshVersions[assetType] === requestRefreshVersion) return false;
  const current = state.assetListMetadata[assetType]?.find((item) => item.assetId === assetId);
  return Boolean(current && current.revision > mutationRevision);
}

/** Re-reads an ambiguous missing asset after mutation commit and preserves the authoritative final state. */
async function reconcileDelayedAssetUpsert<T extends OrchAssetType, D extends { id: string }>(input: {
  state: OrchestrationState;
  assetType: T;
  assetId: string;
  requestRefreshVersion: number;
  mutationMetadata: OrchAssetListMetadata<T>;
  requestWorkspaceEpoch: number;
  refresh(): Promise<void>;
  readCurrent(): D | undefined;
}): Promise<D | null> {
  if (input.state.assetListRefreshVersions[input.assetType] === input.requestRefreshVersion) return null;
  const metadata = input.state.assetListMetadata[input.assetType];
  const currentMetadata = metadata?.find((item) => item.assetId === input.assetId);
  if (currentMetadata) {
    if (currentMetadata.revision === input.mutationMetadata.revision
      && currentMetadata.contentHash !== input.mutationMetadata.contentHash) {
      throw invalidAssetListResponse(input.assetType, "同一修订的内容哈希不一致");
    }
    if (currentMetadata.revision >= input.mutationMetadata.revision) {
      advanceAssetListMutationVersion(input.state, input.assetType);
      const current = input.readCurrent();
      if (!current) throw invalidAssetListResponse(input.assetType, "当前修订缺少本地定义");
      return current;
    }
  }
  if (currentMetadata) return null;

  await input.refresh();
  assertCurrentAssetListWorkspace(input.state.assetListWorkspaceEpoch, input.requestWorkspaceEpoch);
  if (!isCatalogAssetList(input.state, input.assetType)) return null;
  const refreshedMetadata = input.state.assetListMetadata[input.assetType];
  if (refreshedMetadata === null) {
    throw invalidAssetListResponse(input.assetType, "保存后刷新缺少 Server 修订元数据");
  }
  const finalMetadata = refreshedMetadata.find((item) => item.assetId === input.assetId);
  const current = input.readCurrent();
  if (!finalMetadata && !current) {
    throw invalidAssetListResponse(input.assetType, "资产已被较新的操作删除");
  }
  if (!finalMetadata || !current || finalMetadata.revision < input.mutationMetadata.revision
    || (finalMetadata.revision === input.mutationMetadata.revision
      && finalMetadata.contentHash !== input.mutationMetadata.contentHash)) {
    throw invalidAssetListResponse(input.assetType, "保存后刷新资产状态与 mutation 不一致");
  }
  return current;
}

/** Applies one authoritative upsert metadata item while preserving untouched revisions. */
function applyAssetUpsertMetadata<T extends OrchAssetType>(
  state: OrchestrationState,
  assetType: T,
  assetId: string,
  response: AssetMutationResponseMetadata<T>,
): void {
  const server = readServerAssetMutationMetadata(assetType, response, true, assetId);
  if (!server) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  const current = state.assetListMetadata[assetType];
  if (current === null) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  const currentItems = current as OrchAssetListMetadata<T>[];
  const byId = new Map<string, OrchAssetListMetadata<T>>(currentItems.map((item) => [item.assetId, item]));
  byId.set(assetId, server.assetMetadata!);
  const ordered = getAssetDefinitionIds(state, assetType).map((id) => byId.get(id));
  if (ordered.some((item) => !item)) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  state.assetListMetadata[assetType] = ordered as OrchestrationAssetListMetadataState[T];
  advanceAssetListMutationVersion(state, assetType);
}

/** Removes one authoritative delete target while preserving untouched revisions. */
function applyAssetDeleteMetadata<T extends OrchAssetType>(
  state: OrchestrationState,
  assetType: T,
  assetId: string,
  response: AssetMutationResponseMetadata<T>,
): void {
  const server = readServerAssetMutationMetadata(assetType, response, false);
  if (!server) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  const current = state.assetListMetadata[assetType];
  if (current === null) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  const next = current.filter((item) => item.assetId !== assetId);
  const remainingIds = getAssetDefinitionIds(state, assetType);
  if (next.length !== remainingIds.length || next.some((item, index) => item.assetId !== remainingIds[index])) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  state.assetListMetadata[assetType] = next as OrchestrationAssetListMetadataState[T];
  advanceAssetListMutationVersion(state, assetType);
}

/** Validates the optional Server marker and exact upsert metadata without trusting partial responses. */
function readServerAssetMutationMetadata<T extends OrchAssetType>(
  assetType: T,
  response: AssetMutationResponseMetadata<T>,
  requireAssetMetadata: boolean,
  expectedAssetId?: string,
): { assetMetadata: OrchAssetListMetadata<T> | null } | null {
  const hasServerField = Object.hasOwn(response, "changeSeq")
    || Object.hasOwn(response, "cacheStatus")
    || Object.hasOwn(response, "assetMetadata");
  if (!hasServerField) return null;
  if (!Number.isSafeInteger(response.changeSeq) || Number(response.changeSeq) < 1 || response.cacheStatus !== "pending") {
    throw invalidAssetListResponse(assetType, "Server mutation 元数据非法");
  }
  if (!requireAssetMetadata) {
    if (Object.hasOwn(response, "assetMetadata")) {
      throw invalidAssetListResponse(assetType, "删除响应不应包含资产修订元数据");
    }
    return { assetMetadata: null };
  }
  const metadata = response.assetMetadata;
  if (!metadata) throw invalidAssetListResponse(assetType, "保存响应缺少资产修订元数据");
  const snapshot = prepareAssetListSnapshot(assetType, [{ id: expectedAssetId ?? "" }], [metadata]);
  return { assetMetadata: snapshot.metadata![0]! };
}

/** Server 修订排序排除仅供展示的 Host 原件，不把两种写入来源混用。 */
function getAssetDefinitionIds(state: OrchestrationState, assetType: OrchAssetType): string[] {
  const definitions = assetType === "role" ? state.roles : assetType === "workflow" ? state.workflows
    : assetType === "knowledge_bundle" ? state.knowledgeBundles : assetType === "skill" ? state.skills : state.toolsets;
  const hostIds = new Set(state.assetListHostIds[assetType]);
  return definitions.filter(item => !hostIds.has(item.id)).map(item => item.id);
}

/** 服务端权威列表统一补读承载 Client 内置资产；旧 Client 仍从自身目录返回，原件沿 Host 只读边界展示。 */
async function prepareServerAssetListSnapshot<T extends OrchAssetType, D extends { id: string }>(
  ctx: ApiRequestContext, workspaceId: WorkspaceId, assetType: T, definitions: D[],
  metadata: OrchAssetListMetadata<T>[] | undefined, purpose?: "execution",
): Promise<{ definitions: D[]; metadata: OrchAssetListMetadata<T>[] | null; hostAssetIds?: string[]; hostFailure?: { cause: unknown } }> {
  const snapshot = prepareAssetListSnapshot(assetType, definitions, metadata);
  // 带 Client 命名空间的工作区（本地/远程/共享）都由承载 Client 提供内置资产；纯 Server 工作区不补读。
  if (workspaceId.indexOf(":") <= 0 || purpose || snapshot.metadata === null) return snapshot;
  const list = assetType === "role" ? listOrchRoles : assetType === "workflow" ? listOrchWorkflows
    : assetType === "knowledge_bundle" ? listOrchKnowledgeBundles : assetType === "skill" ? listOrchSkills : listOrchToolsets;
  try {
    const response = await list(ctx, workspaceId, "execution");
    if (!response.ok) throw createApiResultError(response);
    const field = assetType === "role" ? "roles" : assetType === "workflow" ? "workflows"
      : assetType === "knowledge_bundle" ? "bundles" : assetType === "skill" ? "skills" : "toolsets";
    const hostAssets = (response as unknown as Record<string, unknown>)[field];
    if (!Array.isArray(hostAssets)) throw invalidAssetListResponse(assetType, "Host 定义列表不是数组");
    const ids = new Set(snapshot.definitions.map(item => item.id)), seenHostIds = new Set<string>();
    const hostAssetIds: string[] = [], hostDefinitions: D[] = [];
    for (const value of hostAssets) {
      if (!value || (value.kind !== "builtin" && value.kind !== "custom") || typeof value.id !== "string"
        || !value.id || value.id.trim() !== value.id || seenHostIds.has(value.id)) {
        throw invalidAssetListResponse(assetType, "Host 资产身份或类型非法、重复");
      }
      seenHostIds.add(value.id);
      if (ids.has(value.id)) continue;
      hostAssetIds.push(value.id);
      hostDefinitions.push({ ...value, workspaceId } as D);
    }
    return { ...snapshot, definitions: [...snapshot.definitions, ...hostDefinitions], hostAssetIds };
  } catch (cause) {
    // 已确认的独立来源失败：保留 Server 数据，调用者继续抛错并提供显式重试。
    return { ...snapshot, hostFailure: { cause } };
  }
}

/** 校验定义和可选元数据一一对应，并按定义顺序生成不可变列表快照。 */
function prepareAssetListSnapshot<T extends OrchAssetType, D extends { id: string }>(
  assetType: T,
  definitions: D[],
  metadata: OrchAssetListMetadata<T>[] | undefined,
): { definitions: D[]; metadata: OrchAssetListMetadata<T>[] | null } {
  if (!Array.isArray(definitions)) {
    throw invalidAssetListResponse(assetType, "定义列表不是数组");
  }
  const definitionSnapshot = [...definitions];
  if (metadata === undefined) {
    return { definitions: definitionSnapshot, metadata: null };
  }
  if (!Array.isArray(metadata) || metadata.length !== definitionSnapshot.length) {
    throw invalidAssetListResponse(assetType, "定义与元数据数量不一致");
  }

  const definitionIds = new Set<string>();
  for (const definition of definitionSnapshot) {
    if (typeof definition?.id !== "string" || !definition.id || definition.id.trim() !== definition.id) {
      throw invalidAssetListResponse(assetType, "定义身份非法");
    }
    if (definitionIds.has(definition.id)) {
      throw invalidAssetListResponse(assetType, "定义身份重复");
    }
    definitionIds.add(definition.id);
  }

  const metadataById = new Map<string, OrchAssetListMetadata<T>>();
  for (const raw of metadata as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidAssetListResponse(assetType, "元数据项非法");
    }
    const item = raw as Record<string, unknown>;
    if (item.assetType !== assetType) {
      throw invalidAssetListResponse(assetType, "元数据资产类型不一致");
    }
    if (typeof item.assetId !== "string" || !item.assetId || item.assetId.trim() !== item.assetId) {
      throw invalidAssetListResponse(assetType, "元数据资产身份非法");
    }
    if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision <= 0) {
      throw invalidAssetListResponse(assetType, "元数据修订非法");
    }
    if (item.scopeType !== "builtin" && item.scopeType !== "user" && item.scopeType !== "shared_workspace") {
      throw invalidAssetListResponse(assetType, "元数据来源作用域非法");
    }
    if (typeof item.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(item.contentHash)) {
      throw invalidAssetListResponse(assetType, "元数据内容哈希非法");
    }
    if (metadataById.has(item.assetId)) {
      throw invalidAssetListResponse(assetType, "元数据资产身份重复");
    }
    metadataById.set(item.assetId, {
      assetType,
      assetId: item.assetId,
      revision: item.revision,
      scopeType: item.scopeType,
      contentHash: item.contentHash,
    });
  }

  const orderedMetadata = definitionSnapshot.map((definition) => {
    const item = metadataById.get(definition.id);
    if (!item) throw invalidAssetListResponse(assetType, "定义缺少对应元数据");
    return item;
  });
  return { definitions: definitionSnapshot, metadata: orderedMetadata };
}

/** 构造不包含资产正文和值的列表响应完整性错误。 */
function invalidAssetListResponse(assetType: OrchAssetType, reason: string): Error {
  const error = new Error(`资产列表响应无效（${assetType}）：${reason}`);
  error.name = "OrchestrationAssetListResponseError";
  return error;

}

function compareIntakesByUpdatedAt(left: TaskIntake, right: TaskIntake): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

/** 合并不同来源的实例计数，供需求编排和定时编排同时展示运行次数。 */
function mergeCountMaps(...maps: Array<Record<string, number> | undefined>): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const map of maps) {
    for (const [id, count] of Object.entries(map ?? {})) {
      merged[id] = (merged[id] ?? 0) + Number(count ?? 0);
    }
  }
  return merged;
}

function upsertLocal<T extends { id: string }>(list: T[], value: T) {
  const index = list.findIndex((item) => item.id === value.id);
  if (index >= 0) list[index] = value;
  else list.unshift(value);
}

/** 正文和文件索引均以实例、版本与更新时间判断是否可复用。 */
function artifactRevisionKey(artifact: Artifact | undefined): string | null {
  return artifact ? `${artifact.instanceId}:${artifact.version}:${artifact.updatedAt}` : null;
}

/** 同版本且未更新的产物保留已读正文，其余字段以最新目录为准。 */
function mergeArtifactList(current: Artifact[], incoming: Artifact[]): Artifact[] {
  const currentById = new Map(current.map((artifact) => [artifact.id, artifact]));
  return incoming.map((artifact) => {
    const existing = currentById.get(artifact.id);
    if (existing && existing.instanceId === artifact.instanceId
      && existing.version === artifact.version && existing.updatedAt === artifact.updatedAt
      && String(existing.contentJson ?? "").trim() && !String(artifact.contentJson ?? "").trim()) {
      return { ...artifact, contentJson: existing.contentJson };
    }
    return artifact;
  });
}

/** 合并 Prompt Snapshot 列表；轻量摘要不能覆盖已按需加载的完整内容。 */
function mergePromptSnapshotList(
  current: NodePromptSnapshot[],
  incoming: NodePromptSnapshot[],
  instanceId: OrchestrationId,
): NodePromptSnapshot[] {
  const currentById = new Map(
    current
      .filter((snapshot) => snapshot.instanceId === instanceId)
      .map((snapshot) => [snapshot.id, snapshot] as const),
  );
  const merged = incoming.map((snapshot) => {
    const existing = currentById.get(snapshot.id);
    if (existing && isPromptSnapshotContentLoaded(existing) && !isPromptSnapshotContentLoaded(snapshot)) {
      return existing;
    }
    return snapshot;
  });
  const mergedIds = new Set(merged.map((snapshot) => snapshot.id));
  for (const snapshot of currentById.values()) {
    if (isPromptSnapshotContentLoaded(snapshot) && !mergedIds.has(snapshot.id)) merged.push(snapshot);
  }
  return merged.sort(comparePromptSnapshotsByCreatedAt);
}

/** 判断快照是否包含完整 prompt 正文，兼容旧数据没有标记的情况。 */
function isPromptSnapshotContentLoaded(snapshot: NodePromptSnapshot): boolean {
  return snapshot.contentLoaded !== false;
}

function buildDefaultSkillMd(input: { name: string; slug: string; description: string; trigger: string; instructions: string }): string {
  return [
    "---",
    `name: ${yamlDoubleQuoted(input.slug)}`,
    `description: ${yamlDoubleQuoted(input.description || input.trigger || input.name)}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    input.description,
    "",
    "## Trigger",
    "",
    input.trigger,
    "",
    "## Instructions",
    "",
    input.instructions,
  ].join("\n");
}

function createTextSkillPackageFile(
  relPath: string,
  kind: NonNullable<SkillDefinition["files"]>[number]["kind"],
  content: string,
): NonNullable<SkillDefinition["files"]>[number] {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n");
  return {
    relPath,
    kind,
    contentText: normalized,
    contentBase64: null,
    contentType: relPath.endsWith(".md") ? "text/markdown" : "text/plain",
    sizeBytes: new TextEncoder().encode(normalized).length,
    sha256: "",
  };
}

function yamlDoubleQuoted(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** 规整资产包导入响应，兼容旧 Client 未返回统计字段的情况。 */
function normalizeImportedAssetBundleResult(raw: Partial<ImportedAssetBundleResult> | null | undefined): ImportedAssetBundleResult {
  return {
    roles: raw?.roles ?? [],
    knowledgeBundles: raw?.knowledgeBundles ?? [],
    skills: raw?.skills ?? [],
    toolsets: raw?.toolsets ?? [],
    workflows: raw?.workflows ?? [],
    warnings: raw?.warnings ?? [],
    overwritten: raw?.overwritten ?? createEmptyImportCounts(),
    skipped: raw?.skipped ?? createEmptyImportCounts(),
    copied: raw?.copied ?? createEmptyImportCounts(),
  };
}

/** 校验可选 Server 导入元数据，并在修改本地定义前建立五类精确快照。 */
function prepareImportedAssetBundleMetadata(
  imported: ImportedAssetBundleResult,
  response: Pick<OrchAssetBundlesImportResponseBody, "changeSeq" | "cacheStatus" | "assetMetadata">,
): ImportedAssetBundleMetadata | null {
  const hasServerField = Object.hasOwn(response, "changeSeq")
    || Object.hasOwn(response, "cacheStatus")
    || Object.hasOwn(response, "assetMetadata");
  if (!hasServerField) return null;
  const definitionsByType = {
    role: imported.roles,
    workflow: imported.workflows,
    knowledge_bundle: imported.knowledgeBundles,
    toolset: imported.toolsets,
    skill: imported.skills,
  } as const;
  const importedCount = Object.values(definitionsByType).reduce((total, definitions) => total + definitions.length, 0);
  const stateValid = importedCount === 0
    ? response.changeSeq === null && response.cacheStatus === "ready"
    : Number.isSafeInteger(response.changeSeq) && Number(response.changeSeq) >= 1 && response.cacheStatus === "pending";
  if (!stateValid || !Array.isArray(response.assetMetadata) || response.assetMetadata.length !== importedCount) {
    throw invalidAssetListResponse("role", "Server 导入元数据状态非法");
  }
  const metadataByType: ImportedAssetBundleMetadata = {
    role: [],
    workflow: [],
    knowledge_bundle: [],
    toolset: [],
    skill: [],
  };
  const assetIds = new Set<string>();
  for (const metadata of response.assetMetadata) {
    if (!metadata || !isOrchAssetType(metadata.assetType)
      || typeof metadata.assetId !== "string" || !metadata.assetId || assetIds.has(metadata.assetId)) {
      throw invalidAssetListResponse("role", "Server 导入资产身份非法");
    }
    if (metadata.scopeType !== "user") {
      throw invalidAssetListResponse(metadata.assetType, "Server 个人导入资产作用域非法");
    }
    assetIds.add(metadata.assetId);
    metadataByType[metadata.assetType].push(metadata);
  }
  metadataByType.role = prepareAssetListSnapshot("role", definitionsByType.role, metadataByType.role).metadata ?? [];
  metadataByType.workflow = prepareAssetListSnapshot(
    "workflow", definitionsByType.workflow, metadataByType.workflow,
  ).metadata ?? [];
  metadataByType.knowledge_bundle = prepareAssetListSnapshot(
    "knowledge_bundle", definitionsByType.knowledge_bundle, metadataByType.knowledge_bundle,
  ).metadata ?? [];
  metadataByType.toolset = prepareAssetListSnapshot(
    "toolset", definitionsByType.toolset, metadataByType.toolset,
  ).metadata ?? [];
  metadataByType.skill = prepareAssetListSnapshot("skill", definitionsByType.skill, metadataByType.skill).metadata ?? [];
  return metadataByType;
}

/** 补偿仍处于管理来源的导入类型，执行候选留给 Client 列表维护。 */
async function reconcileAndApplyImportedAssetBundle(input: {
  state: OrchestrationStore;
  imported: ImportedAssetBundleResult;
  serverMetadata: ImportedAssetBundleMetadata;
  requestRefreshVersions: OrchestrationAssetListRefreshVersionState;
  requestWorkspaceEpoch: number;
  refresh: Record<OrchAssetType, () => Promise<void>>;
}): Promise<void> {
  const changedCounts: Record<OrchAssetType, number> = {
    role: input.imported.roles.length,
    workflow: input.imported.workflows.length,
    knowledge_bundle: input.imported.knowledgeBundles.length,
    toolset: input.imported.toolsets.length,
    skill: input.imported.skills.length,
  };
  const changedTypes = (Object.keys(changedCounts) as OrchAssetType[]).filter(
    (assetType) => changedCounts[assetType] > 0,
  );
  const safeVersions = { ...input.requestRefreshVersions };
  const reconciled = new Set<OrchAssetType>();
  while (true) {
    assertCurrentAssetListWorkspace(input.state.assetListWorkspaceEpoch, input.requestWorkspaceEpoch);
    const pendingTypes = changedTypes.filter(
      (assetType) => isCatalogAssetList(input.state, assetType)
        && input.state.assetListRefreshVersions[assetType] !== safeVersions[assetType],
    );
    if (pendingTypes.length === 0) break;
    const refreshVersions = new Map<OrchAssetType, number>();
    const refreshes = pendingTypes.map((assetType) => {
      if (reconciled.has(assetType)) {
        throw invalidAssetListResponse(assetType, "导入补偿期间资产再次变化");
      }
      const refreshing = input.refresh[assetType]();
      refreshVersions.set(assetType, input.state.assetListRefreshVersions[assetType]);
      return refreshing;
    });
    await Promise.all(refreshes);
    assertCurrentAssetListWorkspace(input.state.assetListWorkspaceEpoch, input.requestWorkspaceEpoch);
    for (const assetType of pendingTypes) {
      if (!isCatalogAssetList(input.state, assetType)) continue;
      const refreshVersion = refreshVersions.get(assetType)!;
      if (input.state.assetListRefreshVersions[assetType] !== refreshVersion) {
        throw invalidAssetListResponse(assetType, "导入补偿刷新被更新操作取代");
      }
      safeVersions[assetType] = refreshVersion;
      reconciled.add(assetType);
    }
  }
  const roles = selectImportedAssetUpdates(
    input.state, "role", input.imported.roles, input.serverMetadata.role, reconciled.has("role"),
  );
  const workflows = selectImportedAssetUpdates(
    input.state, "workflow", input.imported.workflows, input.serverMetadata.workflow, reconciled.has("workflow"),
  );
  const knowledgeBundles = selectImportedAssetUpdates(
    input.state, "knowledge_bundle", input.imported.knowledgeBundles,
    input.serverMetadata.knowledge_bundle, reconciled.has("knowledge_bundle"),
  );
  const toolsets = selectImportedAssetUpdates(
    input.state, "toolset", input.imported.toolsets, input.serverMetadata.toolset, reconciled.has("toolset"),
  );
  const skills = selectImportedAssetUpdates(
    input.state, "skill", input.imported.skills, input.serverMetadata.skill, reconciled.has("skill"),
  );
  const localApply = {
    imported: {
      ...input.imported,
      roles: roles.definitions,
      workflows: workflows.definitions,
      knowledgeBundles: knowledgeBundles.definitions,
      toolsets: toolsets.definitions,
      skills: skills.definitions,
    },
    serverMetadata: {
      role: roles.metadata,
      workflow: workflows.metadata,
      knowledge_bundle: knowledgeBundles.metadata,
      toolset: toolsets.metadata,
      skill: skills.metadata,
    },
  };
  applyImportedAssetBundle(input.state, localApply.imported, localApply.serverMetadata);
}

/** 保留同修订或更高修订，仅为当前管理快照选择可安全应用的导入项。 */
function selectImportedAssetUpdates<T extends OrchAssetType, D extends { id: string }>(
  state: OrchestrationState,
  assetType: T,
  definitions: D[],
  metadata: OrchAssetListMetadata<T>[],
  reconciled: boolean,
): { definitions: D[]; metadata: OrchAssetListMetadata<T>[] } {
  if (!isCatalogAssetList(state, assetType)) return { definitions: [], metadata: [] };
  if (!reconciled) return { definitions: [...definitions], metadata: [...metadata] };
  const currentMetadata = state.assetListMetadata[assetType] as OrchAssetListMetadata<T>[] | null;
  if (currentMetadata === null) {
    throw invalidAssetListResponse(assetType, "导入后权威刷新缺少 Server 修订元数据");
  }
  const currentById = new Map(currentMetadata.map((item) => [item.assetId, item]));
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    const incoming = metadata[index]!;
    if (definition.id !== incoming.assetId) {
      throw invalidAssetListResponse(assetType, "导入补偿校验的定义与元数据身份不一致");
    }
    const current = currentById.get(incoming.assetId);
    if (!current) throw invalidAssetListResponse(assetType, "导入资产已被较新的操作删除");
    if (current.revision > incoming.revision) continue;
    if (current.revision === incoming.revision) {
      if (current.contentHash !== incoming.contentHash) {
        throw invalidAssetListResponse(assetType, "导入后同一修订的内容哈希不一致");
      }
      continue;
    }
    throw invalidAssetListResponse(assetType, "导入后权威刷新修订落后于导入响应");
  }
  return { definitions: [], metadata: [] };
}

/** 同步回写已校验的导入结果，仅更新各类型的管理快照。 */
function applyImportedAssetBundle(
  state: OrchestrationStore,
  imported: ImportedAssetBundleResult,
  serverMetadata: ImportedAssetBundleMetadata | null,
): void {
  if (isCatalogAssetList(state, "role")) for (const role of imported.roles) upsertLocal(state.roles, role);
  for (const item of imported.knowledgeBundles) upsertLocal(state.knowledgeBundles, item);
  for (const item of imported.skills) upsertLocal(state.skills, item);
  for (const item of imported.toolsets) upsertLocal(state.toolsets, item);
  if (isCatalogAssetList(state, "workflow")) for (const item of imported.workflows) upsertLocal(state.workflows, item);
  applyImportedAssetBundleMetadata(state, imported, serverMetadata);
}

/** 合并管理快照的导入修订；legacy 响应仅失效实际变化的管理类型。 */
function applyImportedAssetBundleMetadata(
  state: OrchestrationState,
  imported: ImportedAssetBundleResult,
  serverMetadata: ImportedAssetBundleMetadata | null,
): void {
  const changedByType: Record<OrchAssetType, number> = {
    role: imported.roles.length,
    workflow: imported.workflows.length,
    knowledge_bundle: imported.knowledgeBundles.length,
    toolset: imported.toolsets.length,
    skill: imported.skills.length,
  };
  for (const assetType of Object.keys(changedByType) as OrchAssetType[]) {
    if (changedByType[assetType] === 0 || !isCatalogAssetList(state, assetType)) continue;
    if (!serverMetadata) {
      invalidateAssetListMetadata(state, assetType);
      continue;
    }
    mergeImportedAssetMetadata(state, assetType, serverMetadata[assetType]);
  }
}

/** 将一个类型的导入修订合入已知列表快照，并保持定义顺序。 */
function mergeImportedAssetMetadata<T extends OrchAssetType>(
  state: OrchestrationState,
  assetType: T,
  importedMetadata: OrchAssetListMetadata<T>[],
): void {
  const current = state.assetListMetadata[assetType] as OrchAssetListMetadata<T>[] | null;
  if (current === null) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  const byId = new Map(current.map((metadata) => [metadata.assetId, metadata]));
  for (const metadata of importedMetadata) byId.set(metadata.assetId, metadata);
  const ordered = getAssetDefinitionIds(state, assetType).map((assetId) => byId.get(assetId));
  if (ordered.some((metadata) => !metadata)) {
    invalidateAssetListMetadata(state, assetType);
    return;
  }
  state.assetListMetadata[assetType] = ordered as OrchestrationAssetListMetadataState[T];
  advanceAssetListMutationVersion(state, assetType);
}

/** 创建空导入统计，避免 UI 消费 undefined。 */
function createEmptyImportCounts(): OrchAssetBundleImportCounts {
  return {
    roles: 0,
    knowledgeBundles: 0,
    skills: 0,
    toolsets: 0,
    workflows: 0,
  };
}

function upsertLocalSorted<T extends { id: string }>(
  list: T[],
  value: T,
  compare: (left: T, right: T) => number,
) {
  upsertLocal(list, value);
  list.sort(compare);
}

function compareInstancesByUpdatedAt(left: OrchestrationInstance, right: OrchestrationInstance): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

/** 将终局实例详情限制为 12 条；当前选择和所有活动实例始终保留。 */
function trimLoadedInstanceCache(instances: OrchestrationInstance[], selectedInstanceId: OrchestrationId | null): void {
  const selected = selectedInstanceId
    ? instances.find((instance) => instance.id === selectedInstanceId) ?? null
    : null;
  const active = instances.filter((instance) => !isTerminalInstanceStatus(instance.status));
  const selectedTerminal = selected && isTerminalInstanceStatus(selected.status) ? selected : null;
  const terminal = instances.filter((instance) => (
    isTerminalInstanceStatus(instance.status) && instance.id !== selectedTerminal?.id
  )).sort(compareInstancesByUpdatedAt);
  if (terminal.length + (selectedTerminal ? 1 : 0) <= TERMINAL_INSTANCE_CACHE_LIMIT) return;
  const retainedTerminal = [
    ...(selectedTerminal ? [selectedTerminal] : []),
    ...terminal,
  ].slice(0, TERMINAL_INSTANCE_CACHE_LIMIT);
  const retained = [...active, ...retainedTerminal];
  instances.splice(0, instances.length, ...retained.sort(compareInstancesByUpdatedAt));
}

/** 终局实例可安全按最近使用顺序淘汰，活动实例必须持续接收运行态更新。 */
function isTerminalInstanceStatus(status: OrchestrationInstance["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** 共享工作区默认只看本人相关需求；本地工作区不携带该筛选参数。 */
function resolveSharedOnlyRelatedToMe(workspaceId: WorkspaceId, raw: unknown): boolean | null {
  if (!isSharedWorkspaceSelectionId(String(workspaceId))) return null;
  if (raw == null) return true;
  return Boolean(raw);
}

/** 实例摘要列表排序：最新活跃信息优先展示。 */
function compareInstanceSummariesByUpdatedAt(left: OrchestrationInstanceSummary, right: OrchestrationInstanceSummary): number {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

/** 运行时校验实例列表形态，兼容旧完整实例但禁止未知结构污染摘要状态。 */
function normalizeOrchInstanceSummaries(value: unknown): OrchestrationInstanceSummary[] {
  if (!Array.isArray(value)) throw new Error("编排实例列表响应格式无效：instances 不是数组");
  return value.map((item, index) => {
    const normalized = normalizeOrchInstanceSummaryItem(item);
    if (!normalized) throw new Error(`编排实例列表响应格式无效：第 ${index + 1} 项无法识别`);
    return normalized;
  });
}

function normalizeOrchInstanceSummaryItem(item: unknown): OrchestrationInstanceSummary | null {
  if (isFullOrchInstanceLike(item)) {
    return deriveOrchestrationInstanceSummary(item as OrchestrationInstance);
  }
  if (!isOrchInstanceSummaryLike(item)) return null;
  const summary = item as OrchestrationInstanceSummary;
  return {
    id: summary.id,
    workspaceId: summary.workspaceId,
    workflowId: summary.workflowId,
    proposalId: summary.proposalId ?? null,
    intakeId: summary.intakeId,
    intakeTitle: summary.intakeTitle,
    intakeGoalPreview: summary.intakeGoalPreview,
    workflowName: summary.workflowName ?? null,
    status: summary.status,
    runSummary: summary.runSummary,
    sharedContext: summary.sharedContext ?? null,
    readOnly: Boolean(summary.readOnly || summary.sharedContext?.readOnly),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

/** 合并需求列表元数据里的最新实例，避免实例分页漏项时详情误判为未执行。 */
function mergeLatestInstanceSummariesFromListMeta(
  base: OrchestrationInstanceSummary[],
  metaMaps: Array<Record<string, TaskIntakeListMeta> | null | undefined>,
): OrchestrationInstanceSummary[] {
  const summariesById = new Map<string, OrchestrationInstanceSummary>();
  for (const summary of base) {
    const normalized = normalizeOrchInstanceSummaryItem(summary);
    if (!normalized) throw new Error("编排实例摘要状态格式无效");
    summariesById.set(normalized.id, normalized);
  }
  for (const metaMap of metaMaps) {
    for (const [rawIntakeId, meta] of Object.entries(metaMap ?? {})) {
      if (!meta.latestInstance) continue;
      const normalized = normalizeOrchInstanceSummaryItem(meta.latestInstance);
      if (!normalized) throw new Error("需求列表最新实例摘要格式无效");
      const intakeId = String(rawIntakeId ?? "").trim();
      if (!intakeId || normalized.intakeId !== intakeId) throw new Error("需求列表最新实例摘要 intakeId 不匹配");
      const existing = summariesById.get(normalized.id);
      summariesById.set(normalized.id, pickFresherInstanceSummary(existing, normalized));
    }
  }
  return [...summariesById.values()].sort(compareInstanceSummariesByUpdatedAt);
}

/** 合并需求列表元数据里的实例计数，保持计数不低于列表接口事实。 */
function mergeInstanceCountsFromListMeta(
  base: Record<string, number>,
  metaMaps: Array<Record<string, TaskIntakeListMeta> | null | undefined>,
): Record<string, number> {
  const merged = { ...base };
  for (const metaMap of metaMaps) {
    for (const [rawIntakeId, meta] of Object.entries(metaMap ?? {})) {
      const intakeId = String(rawIntakeId ?? "").trim();
      const count = Number(meta.instanceCount);
      if (!intakeId) throw new Error("需求列表实例计数格式无效：intakeId 为空");
      if (!Number.isFinite(count) || count < 0) throw new Error("需求列表实例计数格式无效");
      merged[intakeId] = Math.max(merged[intakeId] ?? 0, Math.floor(count));
    }
  }
  return merged;
}

/** 把最新实例摘要同步回已加载的需求列表元数据，避免左侧卡片停留在旧状态。 */
function syncLoadedIntakeListMetaForSummary(
  state: Pick<
    OrchestrationState,
    "intakes" | "scheduledIntakes" | "intakeListMetaById" | "scheduledIntakeListMetaById" | "pendingMineItems" | "instanceTotalCountByIntake"
  >,
  summary: OrchestrationInstanceSummary,
): void {
  const intakeId = String(summary.intakeId ?? "").trim();
  if (!intakeId) throw new Error("编排实例摘要 intakeId 为空，无法同步需求列表状态");
  const nextCount = Math.max(1, Number(state.instanceTotalCountByIntake[intakeId] ?? 0));
  const syncMap = (key: "intakeListMetaById" | "scheduledIntakeListMetaById", loaded: TaskIntake[]): void => {
    if (!loaded.some((intake) => String(intake.id) === intakeId)) return;
    state[key] = {
      ...state[key],
      [intakeId]: buildTaskIntakeListMetaFromSummary(summary, nextCount, state[key][intakeId]),
    };
  };
  syncMap("intakeListMetaById", state.intakes);
  syncMap("scheduledIntakeListMetaById", state.scheduledIntakes);
  state.pendingMineItems = syncPendingMineItemForSummary(state.pendingMineItems, summary, nextCount);
}

/** 按 intake 重新选择展示摘要，避免单个终态事件覆盖同需求的活跃执行。 */
function syncLoadedIntakeListMetaForIntake(
  state: Pick<
    OrchestrationState,
    "intakes" | "scheduledIntakes" | "intakeListMetaById" | "scheduledIntakeListMetaById" | "pendingMineItems" | "instanceTotalCountByIntake" | "instanceSummaries"
  >,
  intakeId: IntakeId,
): void {
  const normalizedIntakeId = String(intakeId ?? "").trim();
  if (!normalizedIntakeId) throw new Error("需求 intakeId 为空，无法同步列表状态");
  const displaySummary = pickDisplayInstanceSummary(
    state.instanceSummaries.filter((summary) => String(summary.intakeId) === normalizedIntakeId),
  );
  if (displaySummary) syncLoadedIntakeListMetaForSummary(state, displaySummary);
}

/** 批量同步实例摘要，按 intake 选择当前列表应展示的实例状态。 */
function syncLoadedIntakeListMetaForSummaries(
  state: Pick<
    OrchestrationState,
    "intakes" | "scheduledIntakes" | "intakeListMetaById" | "scheduledIntakeListMetaById" | "pendingMineItems" | "instanceTotalCountByIntake"
  >,
  summaries: OrchestrationInstanceSummary[],
): void {
  const byIntake = new Map<string, OrchestrationInstanceSummary[]>();
  for (const summary of summaries) {
    const intakeId = String(summary.intakeId ?? "").trim();
    if (!intakeId) throw new Error("编排实例摘要 intakeId 为空，无法批量同步需求列表状态");
    const list = byIntake.get(intakeId) ?? [];
    list.push(summary);
    byIntake.set(intakeId, list);
  }
  for (const list of byIntake.values()) {
    const displaySummary = pickDisplayInstanceSummary(list);
    if (displaySummary) syncLoadedIntakeListMetaForSummary(state, displaySummary);
  }
}

/** 用实例摘要派生列表元数据，保留待办提醒字段并和 Client 列表口径保持一致。 */
function buildTaskIntakeListMetaFromSummary(
  summary: OrchestrationInstanceSummary,
  instanceCount: number,
  previous?: TaskIntakeListMeta | null,
): TaskIntakeListMeta {
  const latestInstance = previous?.latestInstance?.id === summary.id
    ? pickFresherInstanceSummary(previous.latestInstance, summary)
    : summary;
  return {
    ...(previous ?? {}),
    listStatus: latestInstance.status,
    listStatusLabel: taskListStatusLabel(latestInstance.status),
    workflowName: latestInstance.workflowName ?? previous?.workflowName ?? null,
    instanceCount: Math.max(1, Number(previous?.instanceCount ?? 0), instanceCount),
    latestInstance,
    progressText: formatRunSummaryProgressText(latestInstance.runSummary.progressText),
  };
}

/** 同步已加载的待我处理缓存；非待办状态会移除旧项，避免普通列表被旧提醒覆盖。 */
function syncPendingMineItemForSummary(
  items: PendingMineListItem[],
  summary: OrchestrationInstanceSummary,
  instanceCount: number,
): PendingMineListItem[] {
  const intakeId = String(summary.intakeId ?? "").trim();
  const index = items.findIndex((item) => String(item.intake.id) === intakeId);
  if (index < 0) return items;
  const current = items[index]!;
  const nextMeta = buildTaskIntakeListMetaFromSummary(summary, instanceCount, current.listMeta);
  const nextItem = buildPendingMineItemFromSummary(summary, current, nextMeta);
  if (!nextItem) return items.filter((_, itemIndex) => itemIndex !== index);
  const next = [...items];
  next[index] = nextItem;
  return next;
}

/** 从实例摘要重建已加载待办项，保持等待/完成/失败等状态的本地展示同步。 */
function buildPendingMineItemFromSummary(
  summary: OrchestrationInstanceSummary,
  current: PendingMineListItem,
  listMeta: TaskIntakeListMeta,
): PendingMineListItem | null {
  const pending = resolvePendingMineDescriptor(summary);
  if (!pending) return null;
  const reminder: ReminderItem = {
    ...current.reminder,
    id: pending.id,
    pendingMineStatus: pending.status,
    displayKind: pending.status === "receipt" ? "receipt" : "action",
    statusLabel: pending.statusLabel,
    tone: pending.tone,
    summary: pending.summary,
    updatedAt: summary.updatedAt,
    isActionRequired: pending.status !== "receipt",
    primaryActionKind: pending.primaryActionKind,
    primaryActionLabel: pending.primaryActionLabel,
    ignoreMarker: pending.ignoreMarker,
    routeTarget: {
      workspaceId: summary.workspaceId,
      intakeId: summary.intakeId,
      instanceId: summary.id,
      nodeId: summary.runSummary.activeNodeId,
    },
  };
  return {
    ...current,
    reminder,
    listMeta: {
      ...listMeta,
      attentionStatus: pending.status,
      attentionLabel: pending.statusLabel,
      attentionActionKind: pending.primaryActionKind,
    },
    pendingMineStatus: pending.status,
    pendingMineStatusLabel: pendingMineStatusLabel(pending.status),
  };
}

/** 解析摘要对应的待办展示信息；返回 null 表示当前不应留在待我处理缓存。 */
function resolvePendingMineDescriptor(summary: OrchestrationInstanceSummary): {
  status: PendingMineListStatus;
  id: string;
  statusLabel: string;
  tone: ReminderTone;
  summary: string;
  primaryActionKind: NonNullable<ReminderItem["primaryActionKind"]>;
  primaryActionLabel: string;
  ignoreMarker: string;
} | null {
  const nodeId = String(summary.runSummary.activeNodeId ?? "").trim();
  const nodeLabel = String(summary.runSummary.activeNodeLabel ?? "当前节点").trim() || "当前节点";
  const updatedAt = Number(summary.updatedAt ?? Date.now());
  if (summary.status === "completed") {
    return {
      status: "receipt",
      id: `orch:${summary.id}:receipt`,
      statusLabel: "待查收",
      tone: "success",
      summary: "编排执行已完成，等待您查看结果。",
      primaryActionKind: "open_orch_artifacts",
      primaryActionLabel: "查看结果",
      ignoreMarker: String(summary.id),
    };
  }
  if (summary.status === "failed") {
    return {
      status: "failed",
      id: `orch:${summary.id}:failed`,
      statusLabel: "异常待处理",
      tone: "danger",
      summary: "执行失败，建议先进入执行工作区查看详情。",
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: `${summary.id}:failed:${updatedAt}`,
    };
  }
  if (summary.status === "paused") {
    return {
      status: "paused",
      id: `orch:${summary.id}:paused`,
      statusLabel: "暂停待处理",
      tone: "warning",
      summary: "执行已暂停，等待您继续处理。",
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: `${summary.id}:paused:${updatedAt}`,
    };
  }
  if (summary.status === "waiting-start" && nodeId) {
    return {
      status: "waiting-start",
      id: `orch:${summary.id}:start:${nodeId}`,
      statusLabel: "待启动",
      tone: "warning",
      summary: `${nodeLabel} · 等待人工启动`,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "启动节点",
      ignoreMarker: `${summary.id}:start:${nodeId}:${updatedAt}`,
    };
  }
  if (summary.status === "waiting-approval" && nodeId) {
    return {
      status: "waiting-approval",
      id: `orch:${summary.id}:approval:${nodeId}`,
      statusLabel: summary.runSummary.statusLabel || "待审核",
      tone: "info",
      summary: summary.runSummary.detailText ?? `${nodeLabel} · 等待人工审核`,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "查看结果并审核",
      ignoreMarker: `${summary.id}:approval:${nodeId}:${updatedAt}`,
    };
  }
  if (summary.status === "waiting-feedback" && nodeId) {
    return {
      status: "waiting-feedback",
      id: `orch:${summary.id}:feedback:${nodeId}`,
      statusLabel: summary.runSummary.statusLabel || "待反馈",
      tone: summary.runSummary.statusTone === "danger" ? "danger" : "warning",
      summary: summary.runSummary.detailText ?? `${nodeLabel} · 等待人工处理`,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "查看结果并处理",
      ignoreMarker: `${summary.id}:feedback:${nodeId}:${updatedAt}`,
    };
  }
  return null;
}

/** 返回待我处理状态文案，供本地缓存重建时保持筛选标签一致。 */
function pendingMineStatusLabel(status: PendingMineListStatus): string {
  const labels: Record<PendingMineListStatus, string> = {
    "waiting-start": "待启动确认",
    "waiting-approval": "待审批",
    "waiting-feedback": "待反馈",
    receipt: "待查收",
    failed: "异常待处理",
    paused: "暂停待处理",
  };
  return labels[status] ?? status;
}

/** 列表紧凑进度只展示数字口径，和 Client 列表投影的 progressText 对齐。 */
function formatRunSummaryProgressText(progressText: string | null | undefined): string | null {
  const text = String(progressText ?? "").trim();
  const match = text.match(/(\d+)\s*\/\s*(\d+)/);
  return match ? `${match[1]}/${match[2]}` : text || null;
}

/** 选择列表展示实例：活跃态优先，其次取最近更新。 */
function pickDisplayInstanceSummary(summaries: OrchestrationInstanceSummary[]): OrchestrationInstanceSummary | null {
  const active = summaries
    .filter((summary) => isActiveListInstanceStatus(summary.status))
    .sort(compareInstanceSummariesByUpdatedAt);
  if (active[0]) return active[0];
  return [...summaries].sort(compareInstanceSummariesByUpdatedAt)[0] ?? null;
}

/** 判断实例状态是否应优先占用需求列表状态。 */
function isActiveListInstanceStatus(status: OrchestrationInstanceSummary["status"]): boolean {
  return status === "pending"
    || status === "running"
    || status === "paused"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

/** 返回需求列表流程状态文案，和 Client 列表投影保持同一口径。 */
function taskListStatusLabel(status: TaskIntakeListMeta["listStatus"]): string {
  const labels: Record<string, string> = {
    "not-started": "未启动",
    pending: "待运行",
    running: "运行中",
    paused: "已暂停",
    "waiting-start": "待启动确认",
    "waiting-approval": "待审批",
    "waiting-feedback": "待反馈",
    completed: "已完成",
    failed: "已失败",
    cancelled: "已取消",
  };
  return labels[status] ?? String(status);
}

/** 选择更新时间更靠前的实例摘要，时间相同优先采用列表元数据的最新实例。 */
function pickFresherInstanceSummary(
  existing: OrchestrationInstanceSummary | undefined,
  incoming: OrchestrationInstanceSummary,
): OrchestrationInstanceSummary {
  if (!existing) return incoming;
  return compareInstanceSummariesByUpdatedAt(incoming, existing) <= 0 ? incoming : existing;
}

function isFullOrchInstanceLike(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return typeof value.id === "string"
    && typeof value.workspaceId === "string"
    && value.intakeSnapshot !== null
    && typeof value.intakeSnapshot === "object"
    && value.workflowSnapshot !== null
    && typeof value.workflowSnapshot === "object"
    && value.nodeStates !== null
    && typeof value.nodeStates === "object";
}

function isOrchInstanceSummaryLike(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const value = item as Record<string, unknown>;
  return typeof value.id === "string"
    && typeof value.workspaceId === "string"
    && typeof value.workflowId === "string"
    && typeof value.intakeId === "string"
    && typeof value.intakeTitle === "string"
    && typeof value.status === "string"
    && value.runSummary !== null
    && typeof value.runSummary === "object";
}

/** 规范化后端返回的需求执行次数，避免非法计数污染列表态。 */
function normalizeInstanceTotalCountByIntake(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, rawCount] of Object.entries(value as Record<string, unknown>)) {
    const intakeId = String(key ?? "").trim();
    const count = Number(rawCount);
    if (intakeId && Number.isFinite(count) && count >= 0) result[intakeId] = Math.floor(count);
  }
  return result;
}

/** 清空当前详情缓存，但保留调用方已决定好的 selectedInstanceId。 */
function clearSelectedInstanceDetails(state: Pick<
  OrchestrationState,
  | "selectedInstance"
  | "selectedInstanceArtifacts"
  | "selectedInstanceEvents"
  | "selectedInstancePromptSnapshots"
  | "selectedArtifactFiles"
  | "selectedArtifactId"
  | "selectedInstanceDetailsLoading"
  | "selectedInstanceDetailsLoadedAt"
  | "selectedInstanceDetailErrors"
>): void {
  artifactFileLoads.clear();
  state.selectedInstance = null;
  state.selectedInstanceArtifacts = [];
  state.selectedInstanceEvents = [];
  state.selectedInstancePromptSnapshots = [];
  state.selectedArtifactFiles = [];
  state.selectedArtifactId = null;
  state.selectedInstanceDetailsLoading = false;
  state.selectedInstanceDetailsLoadedAt = null;
  state.selectedInstanceDetailErrors = {};
}

function reconcileTrackedInstanceStatus(instance: OrchestrationInstance): void {
  if (!instance) return;
  if (instance.status === "completed" || instance.status === "failed" || instance.status === "cancelled") return;
  if (instance.status === "paused") return;

  const statuses = Object.values(instance.nodeStates ?? {}).map((state) => state?.status ?? "pending");
  if (statuses.includes("waiting-approval")) {
    instance.status = "waiting-approval";
    return;
  }
  if (statuses.includes("waiting-feedback")) {
    instance.status = "waiting-feedback";
    return;
  }
  if (statuses.includes("waiting-start")) {
    instance.status = "waiting-start";
    return;
  }

  const hasFailed = statuses.includes("failed");
  const hasActive = statuses.some((status) =>
    status === "queued"
    || status === "running"
    || status === "result-submitted"
    || status === "finalizing"
    || status === "artifact-writing"
    || status === "gate-checking");
  const hasProgress = statuses.some((status) =>
    status !== "pending" && status !== "ready" && status !== "queued");
  const allTerminal = statuses.length > 0 && statuses.every((status) =>
    status === "completed" || status === "skipped" || status === "failed" || status === "cancelled");

  if (allTerminal) {
    instance.status = hasFailed ? "failed" : "completed";
    return;
  }
  if (hasFailed && !hasActive) {
    instance.status = "failed";
    return;
  }
  if (!hasProgress) {
    instance.status = "pending";
    return;
  }
  instance.status = "running";
}

function resolveTrackedInstanceSnapshot(
  selectedInstance: OrchestrationInstance | null,
  instances: OrchestrationInstance[],
  instanceId: OrchestrationId,
): OrchestrationInstance | null {
  const selected = selectedInstance?.id === instanceId ? selectedInstance : null;
  const listed = instances.find((item) => item.id === instanceId) ?? null;
  if (!selected) return listed;
  if (!listed) return selected;
  return pickNewerInstanceSnapshot(selected, listed);
}

function pickNewerInstanceSnapshot(
  current: OrchestrationInstance | null,
  incoming: OrchestrationInstance,
): OrchestrationInstance {
  if (!current) return incoming;
  const currentUpdatedAt = current.updatedAt ?? 0;
  const incomingUpdatedAt = incoming.updatedAt ?? 0;
  const currentSignalScore = scoreTrackedInstanceSignal(current);
  const incomingSignalScore = scoreTrackedInstanceSignal(incoming);
  if (currentUpdatedAt > incomingUpdatedAt && currentSignalScore >= incomingSignalScore) {
    return current;
  }
  return mergeTrackedInstanceSnapshots(current, incoming);
}

function mergeTrackedInstanceSnapshots(
  current: OrchestrationInstance,
  incoming: OrchestrationInstance,
): OrchestrationInstance {
  const snapshotFreshness = compareTrackedSnapshotFreshness(current.updatedAt ?? 0, incoming.updatedAt ?? 0);
  const lifecycleResetNodeIds = collectLifecycleResetNodeIds(current.nodeStates, incoming.nodeStates, snapshotFreshness);
  const mergedNodeStates: Record<string, NodeExecutionState> = {};
  const nodeIds = new Set([
    ...Object.keys(current.nodeStates ?? {}),
    ...Object.keys(incoming.nodeStates ?? {}),
  ]);
  for (const nodeId of nodeIds) {
    const currentNodeState = current.nodeStates?.[nodeId];
    const incomingNodeState = incoming.nodeStates?.[nodeId];
    if (currentNodeState && incomingNodeState) {
      mergedNodeStates[nodeId] = mergeNodeExecutionStateSnapshots(currentNodeState, incomingNodeState, {
        newerSnapshot: snapshotFreshness,
      });
      continue;
    }
    if (incomingNodeState) {
      mergedNodeStates[nodeId] = incomingNodeState;
      continue;
    }
    if (currentNodeState) {
      mergedNodeStates[nodeId] = currentNodeState;
    }
  }

  const merged: OrchestrationInstance = {
    ...current,
    ...incoming,
    roleSnapshots: incoming.roleSnapshots ?? current.roleSnapshots ?? null,
    toolsetSnapshots: incoming.toolsetSnapshots ?? current.toolsetSnapshots ?? null,
    runtimeConfig: incoming.runtimeConfig ?? current.runtimeConfig ?? null,
    artifactIndex: mergeTrackedArtifactIndex(
      snapshotFreshness === "incoming" || snapshotFreshness === "equal"
        ? pruneTrackedArtifactIndex(current.artifactIndex, lifecycleResetNodeIds)
        : current.artifactIndex,
      snapshotFreshness === "current" || snapshotFreshness === "equal"
        ? pruneTrackedArtifactIndex(incoming.artifactIndex, lifecycleResetNodeIds)
        : incoming.artifactIndex,
    ) ?? null,
    masterThreadId: incoming.masterThreadId ?? current.masterThreadId ?? null,
    nodeStates: mergedNodeStates,
    createdAt: Math.min(current.createdAt ?? incoming.createdAt, incoming.createdAt ?? current.createdAt),
    updatedAt: Math.max(current.updatedAt ?? 0, incoming.updatedAt ?? 0),
  };
  reconcileTrackedInstanceStatus(merged);
  return merged;
}

/** 将轻量运行态补丁并入完整实例，避免监控轮询覆盖已加载的大文本详情。 */
function mergeRuntimePatchIntoInstance(
  instance: OrchestrationInstance,
  patch: OrchestrationInstanceRuntimePatch,
): void {
  const snapshotFreshness = compareTrackedSnapshotFreshness(instance.updatedAt ?? 0, patch.updatedAt ?? 0);
  if (snapshotFreshness !== "current") {
    instance.status = patch.status;
  }
  instance.updatedAt = Math.max(instance.updatedAt ?? 0, patch.updatedAt ?? 0);
  instance.nodeStates = instance.nodeStates ?? {};
  const lifecycleResetNodeIds = new Set<string>();
  for (const [nodeId, patchNodeState] of Object.entries(patch.nodeStates ?? {})) {
    if (shouldRuntimePatchClearNodeDetails(instance.nodeStates[nodeId], patchNodeState, snapshotFreshness)) {
      lifecycleResetNodeIds.add(nodeId);
    }
  }
  const incomingArtifactIndex = snapshotFreshness === "current"
    ? undefined
    : pruneTrackedArtifactIndex(patch.artifactIndex, lifecycleResetNodeIds);
  instance.artifactIndex = mergeTrackedArtifactIndex(
    pruneTrackedArtifactIndex(instance.artifactIndex, lifecycleResetNodeIds),
    incomingArtifactIndex,
  ) ?? {};

  for (const [nodeId, patchNodeState] of Object.entries(patch.nodeStates ?? {})) {
    const currentNodeState = instance.nodeStates[nodeId];
    const incomingNodeState = toRuntimePatchNodeState(
      currentNodeState,
      patchNodeState,
      lifecycleResetNodeIds.has(nodeId),
    );
    instance.nodeStates[nodeId] = currentNodeState
      ? mergeNodeExecutionStateSnapshots(currentNodeState, incomingNodeState, { newerSnapshot: snapshotFreshness })
      : incomingNodeState;
  }
  reconcileTrackedInstanceStatus(instance);
}

/** 将运行态节点补丁补齐为可合并节点态，保留本地详情字段。 */
function toRuntimePatchNodeState(
  current: NodeExecutionState | null | undefined,
  patch: OrchestrationInstanceRuntimePatch["nodeStates"][string],
  clearDetails: boolean,
): NodeExecutionState {
  return {
    ...patch,
    nodeId: patch.nodeId,
    status: patch.status,
    retryCount: patch.retryCount ?? current?.retryCount ?? 0,
    humanActionSource: patch.humanActionSource ?? null,
    assigneeUserIds: patch.assigneeUserIds ?? current?.assigneeUserIds ?? null,
    threadId: patch.threadId ?? null,
    previousThreadIds: patch.previousThreadIds ?? current?.previousThreadIds ?? null,
    discussionThreadId: patch.discussionThreadId ?? null,
    renderedInput: clearDetails ? null : current?.renderedInput ?? null,
    output: clearDetails ? null : current?.output ?? null,
    conclusion: clearDetails ? null : current?.conclusion ?? null,
    promptSnapshotIds: patch.promptSnapshotIds ?? null,
    knowledgeWarnings: patch.knowledgeWarnings ?? null,
    gateResults: patch.gateResults ?? null,
    startedAt: patch.startedAt ?? null,
    completedAt: patch.completedAt ?? null,
    error: patch.error ?? null,
    errorCode: patch.errorCode ?? null,
    providerThreadId: patch.providerThreadId ?? null,
    recoveryReason: patch.recoveryReason ?? null,
    preserveBinding: patch.preserveBinding ?? null,
    userChoiceRequired: patch.userChoiceRequired ?? null,
    recoveryStrategies: patch.recoveryStrategies ?? null,
    branchTaken: patch.branchTaken ?? null,
    inputArtifactIds: patch.inputArtifactIds ?? null,
    outputArtifactIds: patch.outputArtifactIds ?? null,
    activeFeedbackRecordIds: patch.activeFeedbackRecordIds ?? null,
    feedbackRecordIds: patch.feedbackRecordIds ?? null,
    manualStartApprovedAt: patch.manualStartApprovedAt ?? null,
    manualStartApprovedBy: patch.manualStartApprovedBy ?? null,
  };
}

/** 判断轻量补丁是否代表新生命周期，避免重跑节点显示上一轮详情。 */
function shouldRuntimePatchClearNodeDetails(
  current: NodeExecutionState | null | undefined,
  patch: OrchestrationInstanceRuntimePatch["nodeStates"][string],
  snapshotFreshness: "current" | "incoming" | "equal",
): boolean {
  if (!current || snapshotFreshness === "current") return false;
  return isResetLikeNodeExecutionStatus(patch.status);
}

/** 用运行态补丁刷新列表摘要，保留列表元信息和分页语义。 */
function applyRuntimePatchToSummary(
  summary: OrchestrationInstanceSummary,
  patch: OrchestrationInstanceRuntimePatch,
): OrchestrationInstanceSummary {
  if ((summary.updatedAt ?? 0) > (patch.updatedAt ?? 0)) return summary;
  return {
    ...summary,
    status: patch.status,
    runSummary: patch.runSummary,
    updatedAt: Math.max(summary.updatedAt ?? 0, patch.updatedAt ?? 0),
  };
}

function mergeNodeExecutionStateSnapshots(
  current: NodeExecutionState,
  incoming: NodeExecutionState,
  options: { newerSnapshot: "current" | "incoming" | "equal" },
): NodeExecutionState {
  const lifecycleResetState = resolveLifecycleResetNodeExecutionState(current, incoming, options.newerSnapshot);
  if (lifecycleResetState) {
    return lifecycleResetState;
  }
  const terminalPreferredState = resolveTerminalPreferredNodeExecutionState(current, incoming, options.newerSnapshot);
  if (terminalPreferredState) {
    return terminalPreferredState;
  }
  const preferred = pickRicherNodeExecutionState(current, incoming);
  const fallback = preferred === incoming ? current : incoming;
  const identityPreferred = options.newerSnapshot === "incoming"
    ? incoming
    : options.newerSnapshot === "current"
      ? current
      : preferred;
  const identityFallback = identityPreferred === incoming ? current : incoming;
  const executionId = resolveCanonicalNodeExecutionId(identityPreferred, identityFallback);
  const sameAttempt = nodeExecutionSnapshotsShareAttempt(current, incoming);
  const recoveryPreferred = sameAttempt ? preferred : identityPreferred;
  const recoveryFallback = sameAttempt ? fallback : null;
  return {
    ...fallback,
    ...preferred,
    status: preferred.status ?? fallback.status,
    attemptId: executionId,
    nodeExecutionId: executionId,
    attemptNo: identityPreferred.attemptNo ?? identityFallback.attemptNo ?? null,
    submissionId: identityPreferred.submissionId ?? identityFallback.submissionId ?? null,
    parentExecutionId: identityPreferred.parentExecutionId ?? identityFallback.parentExecutionId ?? null,
    humanActionSource: preferred.humanActionSource ?? fallback.humanActionSource ?? null,
    assigneeUserIds: preferred.assigneeUserIds ?? fallback.assigneeUserIds ?? null,
    threadId: preferred.threadId ?? fallback.threadId ?? null,
    previousThreadIds: mergeUniqueValues(current.previousThreadIds, incoming.previousThreadIds),
    discussionThreadId: preferred.discussionThreadId ?? fallback.discussionThreadId ?? null,
    renderedInput: pickRicherText(current.renderedInput, incoming.renderedInput),
    output: pickRicherText(current.output, incoming.output),
    promptSnapshotIds: mergeUniqueValues(current.promptSnapshotIds, incoming.promptSnapshotIds),
    knowledgeWarnings: mergeUniqueValues(current.knowledgeWarnings, incoming.knowledgeWarnings),
    gateResults: pickRicherCollection(current.gateResults, incoming.gateResults),
    conclusion: incoming.conclusion ?? current.conclusion ?? null,
    retryCount: Math.max(current.retryCount ?? 0, incoming.retryCount ?? 0),
    startedAt: pickEarlierTimestamp(current.startedAt, incoming.startedAt),
    completedAt: pickLaterTimestamp(current.completedAt, incoming.completedAt),
    error: pickRicherText(current.error, incoming.error),
    errorCode: recoveryPreferred.errorCode ?? recoveryFallback?.errorCode ?? null,
    providerThreadId: recoveryPreferred.providerThreadId ?? recoveryFallback?.providerThreadId ?? null,
    recoveryReason: recoveryPreferred.recoveryReason ?? recoveryFallback?.recoveryReason ?? null,
    preserveBinding: recoveryPreferred.preserveBinding ?? recoveryFallback?.preserveBinding ?? null,
    userChoiceRequired: recoveryPreferred.userChoiceRequired ?? recoveryFallback?.userChoiceRequired ?? null,
    recoveryStrategies: recoveryPreferred.recoveryStrategies ?? recoveryFallback?.recoveryStrategies ?? null,
    branchTaken: incoming.branchTaken ?? current.branchTaken ?? null,
    inputArtifactIds: mergeUniqueValues(current.inputArtifactIds, incoming.inputArtifactIds),
    outputArtifactIds: mergeUniqueValues(current.outputArtifactIds, incoming.outputArtifactIds),
    activeFeedbackRecordIds: mergeUniqueValues(current.activeFeedbackRecordIds, incoming.activeFeedbackRecordIds),
    feedbackRecordIds: mergeUniqueValues(current.feedbackRecordIds, incoming.feedbackRecordIds),
    manualStartApprovedAt: incoming.manualStartApprovedAt ?? current.manualStartApprovedAt ?? null,
    manualStartApprovedBy: incoming.manualStartApprovedBy ?? current.manualStartApprovedBy ?? null,
  };
}

function pickRicherNodeExecutionState(
  current: NodeExecutionState,
  incoming: NodeExecutionState,
): NodeExecutionState {
  const currentScore = scoreNodeExecutionStateSignal(current);
  const incomingScore = scoreNodeExecutionStateSignal(incoming);
  return incomingScore >= currentScore ? incoming : current;
}

function scoreNodeExecutionStateSignal(state: NodeExecutionState): number {
  const statusWeight: Record<NodeExecutionState["status"], number> = {
    pending: 0,
    ready: 5,
    queued: 8,
    running: 12,
    "result-submitted": 13,
    finalizing: 14,
    "artifact-writing": 15,
    "gate-checking": 16,
    "waiting-start": 20,
    "waiting-approval": 22,
    completed: 26,
    failed: 26,
    skipped: 24,
    "waiting-feedback": 22,
    cancelled: 24,
  };
  return (statusWeight[state.status] ?? 0)
    + (resolveCanonicalNodeExecutionId(state) ? 8 : 0)
    + (state.parentExecutionId ? 4 : 0)
    + (state.humanActionSource ? 12 : 0)
    + (state.threadId ? 18 : 0)
    + ((state.previousThreadIds?.length ?? 0) > 0 ? 8 + (state.previousThreadIds?.length ?? 0) : 0)
    + (state.discussionThreadId ? 12 : 0)
    + (hasMeaningfulText(state.renderedInput) ? 14 : 0)
    + (hasMeaningfulText(state.output) ? 14 : 0)
    + ((state.promptSnapshotIds?.length ?? 0) > 0 ? 12 + (state.promptSnapshotIds?.length ?? 0) : 0)
    + ((state.knowledgeWarnings?.length ?? 0) > 0 ? 6 + (state.knowledgeWarnings?.length ?? 0) : 0)
    + ((state.gateResults?.length ?? 0) > 0 ? 10 + (state.gateResults?.length ?? 0) : 0)
    + (state.conclusion ? 14 : 0)
    + (state.startedAt ? 8 : 0)
    + (state.completedAt ? 12 : 0)
    + (hasMeaningfulText(state.error) ? 10 : 0)
    + (state.branchTaken ? 4 : 0)
    + ((state.inputArtifactIds?.length ?? 0) > 0 ? 8 + (state.inputArtifactIds?.length ?? 0) : 0)
    + ((state.outputArtifactIds?.length ?? 0) > 0 ? 12 + (state.outputArtifactIds?.length ?? 0) : 0)
    + ((state.activeFeedbackRecordIds?.length ?? 0) > 0 ? 8 + (state.activeFeedbackRecordIds?.length ?? 0) : 0)
    + ((state.feedbackRecordIds?.length ?? 0) > 0 ? 8 + (state.feedbackRecordIds?.length ?? 0) : 0)
    + (state.manualStartApprovedAt ? 4 : 0)
    + (state.manualStartApprovedBy ? 2 : 0)
    + Math.max(state.retryCount ?? 0, 0);
}

function compareTrackedSnapshotFreshness(
  currentUpdatedAt: number,
  incomingUpdatedAt: number,
): "current" | "incoming" | "equal" {
  if (incomingUpdatedAt > currentUpdatedAt) return "incoming";
  if (currentUpdatedAt > incomingUpdatedAt) return "current";
  return "equal";
}

function resolveLifecycleResetNodeExecutionState(
  current: NodeExecutionState,
  incoming: NodeExecutionState,
  newerSnapshot: "current" | "incoming" | "equal",
): NodeExecutionState | null {
  if (newerSnapshot === "equal") {
    if (
      nodeExecutionStatusPhase(incoming.status) < nodeExecutionStatusPhase(current.status)
      && isResetLikeNodeExecutionStatus(incoming.status)
    ) {
      return mergeLifecycleResetNodeExecutionState(current, incoming);
    }
    if (
      nodeExecutionStatusPhase(current.status) < nodeExecutionStatusPhase(incoming.status)
      && isResetLikeNodeExecutionStatus(current.status)
    ) {
      return mergeLifecycleResetNodeExecutionState(incoming, current);
    }
    return null;
  }
  if (newerSnapshot === "incoming" && nodeExecutionStatusPhase(incoming.status) < nodeExecutionStatusPhase(current.status)) {
    return mergeLifecycleResetNodeExecutionState(current, incoming);
  }
  if (newerSnapshot === "current" && nodeExecutionStatusPhase(current.status) < nodeExecutionStatusPhase(incoming.status)) {
    return mergeLifecycleResetNodeExecutionState(incoming, current);
  }
  return null;
}

function resolveTerminalPreferredNodeExecutionState(
  current: NodeExecutionState,
  incoming: NodeExecutionState,
  newerSnapshot: "current" | "incoming" | "equal",
): NodeExecutionState | null {
  if (newerSnapshot === "equal") {
    if (shouldPreferTerminalSnapshot(current, incoming)) {
      return mergeTerminalPreferredNodeExecutionState(current, incoming);
    }
    if (shouldPreferTerminalSnapshot(incoming, current)) {
      return mergeTerminalPreferredNodeExecutionState(incoming, current);
    }
    return null;
  }
  if (newerSnapshot === "incoming" && shouldPreferTerminalSnapshot(current, incoming)) {
    return mergeTerminalPreferredNodeExecutionState(current, incoming);
  }
  if (newerSnapshot === "current" && shouldPreferTerminalSnapshot(incoming, current)) {
    return mergeTerminalPreferredNodeExecutionState(incoming, current);
  }
  return null;
}

function shouldPreferTerminalSnapshot(
  staleSnapshot: NodeExecutionState,
  terminalSnapshot: NodeExecutionState,
): boolean {
  return isTerminalNodeExecutionStatus(terminalSnapshot.status)
    && nodeExecutionStatusPhase(terminalSnapshot.status) >= nodeExecutionStatusPhase(staleSnapshot.status)
    && terminalSnapshot.status !== staleSnapshot.status;
}

function mergeLifecycleResetNodeExecutionState(
  staleSnapshot: NodeExecutionState,
  resetSnapshot: NodeExecutionState,
): NodeExecutionState {
  const executionId = resolveResetNodeExecutionId(resetSnapshot, staleSnapshot);
  return {
    ...staleSnapshot,
    ...resetSnapshot,
    status: resetSnapshot.status,
    attemptId: executionId,
    nodeExecutionId: executionId,
    attemptNo: pickResetSnapshotValue(resetSnapshot.attemptNo, staleSnapshot.attemptNo) ?? null,
    submissionId: pickResetSnapshotValue(resetSnapshot.submissionId, staleSnapshot.submissionId) ?? null,
    parentExecutionId: pickResetSnapshotValue(resetSnapshot.parentExecutionId, staleSnapshot.parentExecutionId) ?? null,
    humanActionSource: resetSnapshot.humanActionSource ?? null,
    threadId: pickResetSnapshotValue(resetSnapshot.threadId, staleSnapshot.threadId) ?? null,
    previousThreadIds: mergeUniqueValues(staleSnapshot.previousThreadIds, resetSnapshot.previousThreadIds),
    discussionThreadId: pickResetSnapshotValue(resetSnapshot.discussionThreadId, staleSnapshot.discussionThreadId) ?? null,
    renderedInput: resetSnapshot.renderedInput ?? null,
    output: resetSnapshot.output ?? null,
    promptSnapshotIds: pickResetSnapshotValue(resetSnapshot.promptSnapshotIds, staleSnapshot.promptSnapshotIds) ?? null,
    knowledgeWarnings: pickResetSnapshotValue(resetSnapshot.knowledgeWarnings, staleSnapshot.knowledgeWarnings) ?? null,
    gateResults: resetSnapshot.gateResults ?? null,
    conclusion: resetSnapshot.conclusion ?? null,
    retryCount: Math.max(staleSnapshot.retryCount ?? 0, resetSnapshot.retryCount ?? 0),
    startedAt: resetSnapshot.startedAt ?? null,
    completedAt: resetSnapshot.completedAt ?? null,
    error: resetSnapshot.error ?? null,
    errorCode: resetSnapshot.errorCode ?? null,
    providerThreadId: resetSnapshot.providerThreadId ?? null,
    recoveryReason: resetSnapshot.recoveryReason ?? null,
    preserveBinding: resetSnapshot.preserveBinding ?? null,
    userChoiceRequired: resetSnapshot.userChoiceRequired ?? null,
    recoveryStrategies: resetSnapshot.recoveryStrategies ?? null,
    branchTaken: resetSnapshot.branchTaken ?? null,
    inputArtifactIds: pickResetSnapshotValue(resetSnapshot.inputArtifactIds, staleSnapshot.inputArtifactIds) ?? null,
    outputArtifactIds: resetSnapshot.outputArtifactIds ?? null,
    activeFeedbackRecordIds: pickResetSnapshotValue(
      resetSnapshot.activeFeedbackRecordIds,
      staleSnapshot.activeFeedbackRecordIds,
    ) ?? null,
    feedbackRecordIds: pickResetSnapshotValue(resetSnapshot.feedbackRecordIds, staleSnapshot.feedbackRecordIds) ?? null,
    manualStartApprovedAt: resetSnapshot.manualStartApprovedAt ?? null,
    manualStartApprovedBy: resetSnapshot.manualStartApprovedBy ?? null,
  };
}

function pickResetSnapshotValue<T>(
  resetValue: T | null | undefined,
  staleValue: T | null | undefined,
): T | null | undefined {
  return resetValue !== undefined ? resetValue : staleValue;
}

function mergeTerminalPreferredNodeExecutionState(
  staleSnapshot: NodeExecutionState,
  terminalSnapshot: NodeExecutionState,
): NodeExecutionState {
  const executionId = resolveCanonicalNodeExecutionId(terminalSnapshot, staleSnapshot);
  const sameAttempt = nodeExecutionSnapshotsShareAttempt(staleSnapshot, terminalSnapshot);
  const recoveryFallback = sameAttempt ? staleSnapshot : null;
  return {
    ...staleSnapshot,
    ...terminalSnapshot,
    status: terminalSnapshot.status,
    attemptId: executionId,
    nodeExecutionId: executionId,
    attemptNo: terminalSnapshot.attemptNo ?? staleSnapshot.attemptNo ?? null,
    submissionId: terminalSnapshot.submissionId ?? staleSnapshot.submissionId ?? null,
    parentExecutionId: terminalSnapshot.parentExecutionId ?? staleSnapshot.parentExecutionId ?? null,
    humanActionSource: terminalSnapshot.humanActionSource ?? staleSnapshot.humanActionSource ?? null,
    threadId: terminalSnapshot.threadId ?? staleSnapshot.threadId ?? null,
    previousThreadIds: mergeUniqueValues(staleSnapshot.previousThreadIds, terminalSnapshot.previousThreadIds),
    discussionThreadId: terminalSnapshot.discussionThreadId ?? staleSnapshot.discussionThreadId ?? null,
    renderedInput: pickRicherText(staleSnapshot.renderedInput, terminalSnapshot.renderedInput),
    output: pickRicherText(staleSnapshot.output, terminalSnapshot.output),
    promptSnapshotIds: mergeUniqueValues(staleSnapshot.promptSnapshotIds, terminalSnapshot.promptSnapshotIds),
    knowledgeWarnings: mergeUniqueValues(staleSnapshot.knowledgeWarnings, terminalSnapshot.knowledgeWarnings),
    gateResults: pickRicherCollection(staleSnapshot.gateResults, terminalSnapshot.gateResults),
    conclusion: terminalSnapshot.conclusion ?? staleSnapshot.conclusion ?? null,
    retryCount: Math.max(staleSnapshot.retryCount ?? 0, terminalSnapshot.retryCount ?? 0),
    startedAt: pickEarlierTimestamp(staleSnapshot.startedAt, terminalSnapshot.startedAt),
    completedAt: pickLaterTimestamp(staleSnapshot.completedAt, terminalSnapshot.completedAt),
    error: pickRicherText(staleSnapshot.error, terminalSnapshot.error),
    errorCode: terminalSnapshot.errorCode ?? recoveryFallback?.errorCode ?? null,
    providerThreadId: terminalSnapshot.providerThreadId ?? recoveryFallback?.providerThreadId ?? null,
    recoveryReason: terminalSnapshot.recoveryReason ?? recoveryFallback?.recoveryReason ?? null,
    preserveBinding: terminalSnapshot.preserveBinding ?? recoveryFallback?.preserveBinding ?? null,
    userChoiceRequired: terminalSnapshot.userChoiceRequired ?? recoveryFallback?.userChoiceRequired ?? null,
    recoveryStrategies: terminalSnapshot.recoveryStrategies ?? recoveryFallback?.recoveryStrategies ?? null,
    branchTaken: terminalSnapshot.branchTaken ?? staleSnapshot.branchTaken ?? null,
    inputArtifactIds: mergeUniqueValues(staleSnapshot.inputArtifactIds, terminalSnapshot.inputArtifactIds),
    outputArtifactIds: mergeUniqueValues(staleSnapshot.outputArtifactIds, terminalSnapshot.outputArtifactIds),
    activeFeedbackRecordIds: mergeUniqueValues(staleSnapshot.activeFeedbackRecordIds, terminalSnapshot.activeFeedbackRecordIds),
    feedbackRecordIds: mergeUniqueValues(staleSnapshot.feedbackRecordIds, terminalSnapshot.feedbackRecordIds),
    manualStartApprovedAt: terminalSnapshot.manualStartApprovedAt ?? staleSnapshot.manualStartApprovedAt ?? null,
    manualStartApprovedBy: terminalSnapshot.manualStartApprovedBy ?? staleSnapshot.manualStartApprovedBy ?? null,
  };
}

function resolveCanonicalNodeExecutionId(
  preferred: NodeExecutionState,
  fallback?: NodeExecutionState,
): string | null {
  return String(
    preferred.attemptId
      ?? preferred.nodeExecutionId
      ?? fallback?.attemptId
      ?? fallback?.nodeExecutionId
      ?? "",
  ).trim() || null;
}

function resolveResetNodeExecutionId(
  resetSnapshot: NodeExecutionState,
  staleSnapshot: NodeExecutionState,
): string | null {
  const explicitlyReset = Object.prototype.hasOwnProperty.call(resetSnapshot, "attemptId")
    || Object.prototype.hasOwnProperty.call(resetSnapshot, "nodeExecutionId");
  return explicitlyReset
    ? String(resetSnapshot.attemptId ?? resetSnapshot.nodeExecutionId ?? "").trim() || null
    : resolveCanonicalNodeExecutionId(staleSnapshot);
}

function nodeExecutionStatusPhase(status: NodeExecutionState["status"]): number {
  switch (status) {
    case "pending":
      return 0;
    case "ready":
      return 1;
    case "queued":
      return 2;
    case "running":
      return 3;
    case "result-submitted":
      return 4;
    case "finalizing":
      return 5;
    case "artifact-writing":
      return 6;
    case "gate-checking":
      return 7;
    case "waiting-start":
      return 8;
    case "waiting-approval":
    case "waiting-feedback":
      return 9;
    case "completed":
    case "failed":
    case "skipped":
    case "cancelled":
      return 10;
    default:
      return 0;
  }
}

function isTerminalNodeExecutionStatus(status: NodeExecutionState["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "skipped"
    || status === "cancelled";
}

function isResetLikeNodeExecutionStatus(status: NodeExecutionState["status"]): boolean {
  return status === "pending"
    || status === "ready"
    || status === "queued";
}

function scoreTrackedInstanceSignal(instance: OrchestrationInstance): number {
  const statusWeight: Record<OrchestrationInstance["status"], number> = {
    pending: 0,
    running: 18,
    paused: 16,
    completed: 22,
    failed: 22,
    cancelled: 20,
    "waiting-start": 18,
    "waiting-approval": 20,
    "waiting-feedback": 20,
  };
  const nodeSignalScore = Object.values(instance.nodeStates ?? {}).reduce(
    (total, state) => total + scoreNodeExecutionStateSignal(state),
    0,
  );
  const artifactSignalScore = Object.values(instance.artifactIndex ?? {}).reduce(
    (total, ids) => total + (Array.isArray(ids) ? ids.length : 0),
    0,
  );
  return (statusWeight[instance.status] ?? 0)
    + nodeSignalScore
    + artifactSignalScore
    + (instance.masterThreadId ? 12 : 0);
}

function collectTrackedArtifactIds(instance?: OrchestrationInstance | null): ArtifactId[] {
  if (!instance) return [];
  const ids = new Set<string>();
  for (const value of Object.values(instance.artifactIndex ?? {})) {
    if (!Array.isArray(value)) continue;
    for (const artifactId of value) {
      if (artifactId) ids.add(String(artifactId));
    }
  }
  for (const state of Object.values(instance.nodeStates ?? {})) {
    for (const artifactId of state?.outputArtifactIds ?? []) {
      if (artifactId) ids.add(String(artifactId));
    }
  }
  return Array.from(ids) as ArtifactId[];
}

function isActiveInstanceDeleteConflictDetails(details: unknown): details is { reason: string; activeInstanceIds?: unknown } {
  if (!details || typeof details !== "object") return false;
  return String((details as { reason?: unknown }).reason ?? "").trim() === "ACTIVE_RUNNING_INSTANCE";
}

function toOrchestrationIds(raw: unknown): OrchestrationId[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item ?? "").trim())
    .filter(Boolean) as OrchestrationId[];
}

function collectTrackedPromptSnapshotIds(instance?: OrchestrationInstance | null): string[] {
  if (!instance) return [];
  const ids = new Set<string>();
  for (const state of Object.values(instance.nodeStates ?? {})) {
    for (const promptSnapshotId of state?.promptSnapshotIds ?? []) {
      if (promptSnapshotId) ids.add(String(promptSnapshotId));
    }
  }
  return Array.from(ids);
}

function shouldHydrateSelectedInstanceDetails(
  instance: OrchestrationInstance,
  artifacts: Artifact[],
  promptSnapshots: NodePromptSnapshot[],
): boolean {
  const loadedArtifactIds = new Set(
    artifacts
      .filter((artifact) => artifact.instanceId === instance.id)
      .map((artifact) => String(artifact.id)),
  );
  if (collectTrackedArtifactIds(instance).some((artifactId) => !loadedArtifactIds.has(String(artifactId)))) {
    return true;
  }

  const loadedPromptSnapshotIds = new Set(
    promptSnapshots
      .filter((snapshot) => snapshot.instanceId === instance.id)
      .map((snapshot) => String(snapshot.id)),
  );
  return collectTrackedPromptSnapshotIds(instance)
    .some((promptSnapshotId) => !loadedPromptSnapshotIds.has(promptSnapshotId));
}

/** 判断选中实例详情是否存在分项加载错误。 */
function hasSelectedInstanceDetailErrors(errors: SelectedInstanceDetailErrors): boolean {
  return Object.values(errors).some((message) => Boolean(String(message ?? "").trim()));
}

/** 将详情后台加载失败转为可展示的短错误信息。 */
function describeDetailLoadFailure(result: PromiseSettledResult<ApiResult<Record<string, unknown>>>): string {
  if (result.status === "rejected") {
    return result.reason instanceof Error ? result.reason.message : String(result.reason);
  }
  return result.value.ok ? "加载结果无效" : result.value.message;
}

/** 恢复元数据只可在同一 Attempt 内补全，不能从旧 Attempt 回填到新快照。 */
function nodeExecutionSnapshotsShareAttempt(current: NodeExecutionState, incoming: NodeExecutionState): boolean {
  const currentExecutionId = String(current.nodeExecutionId ?? current.attemptId ?? "").trim();
  const incomingExecutionId = String(incoming.nodeExecutionId ?? incoming.attemptId ?? "").trim();
  if (currentExecutionId || incomingExecutionId) {
    return Boolean(currentExecutionId) && currentExecutionId === incomingExecutionId;
  }
  const currentAttemptNo = typeof current.attemptNo === "number" ? current.attemptNo : null;
  const incomingAttemptNo = typeof incoming.attemptNo === "number" ? incoming.attemptNo : null;
  if (currentAttemptNo != null || incomingAttemptNo != null) {
    return currentAttemptNo != null && currentAttemptNo === incomingAttemptNo;
  }
  return true;
}

/** 汇总分项详情失败，并从同一个首个诊断源成对保留 API code/requestId。 */
function createSelectedInstanceDetailLoadError(
  errors: SelectedInstanceDetailErrors,
  diagnosticSources: unknown[],
): Error {
  const diagnostics = diagnosticSources
    .map((source) => source && typeof source === "object" ? source as Record<string, any> : null)
    .filter((source): source is Record<string, any> => Boolean(source));
  const diagnostic = diagnostics.find((source) => Boolean(
    String(source.code ?? "").trim()
    || String(source.requestId ?? source.request_id ?? source.meta?.requestId ?? "").trim(),
  ));
  const code = String(diagnostic?.code ?? "").trim() || "ORCH_INSTANCE_DETAILS_LOAD_FAILED";
  const requestId = String(
    diagnostic?.requestId ?? diagnostic?.request_id ?? diagnostic?.meta?.requestId ?? "",
  ).trim() || null;
  const message = Object.values(errors).map((value) => String(value ?? "").trim()).filter(Boolean).join("；")
    || "加载实例详情失败";
  const error = new Error(message) as Error & { code?: string; requestId?: string | null };
  error.code = code;
  error.requestId = requestId;
  return error;
}

/** 解析运行时返回的精确影响集；旧事件未携带该字段时才按完整下游兼容。 */
function collectTrackedAffectedNodeIds(
  instance: OrchestrationInstance,
  targetNodeId: string,
  rawAffectedNodeIds?: unknown,
): Set<string> {
  if (Array.isArray(rawAffectedNodeIds)) {
    return new Set(rawAffectedNodeIds.map((nodeId) => String(nodeId ?? "").trim()).filter(Boolean));
  }
  const visited = new Set<string>();
  const queue = [targetNodeId];
  while (queue.length > 0) {
    const currentNodeId = queue.shift()!;
    if (visited.has(currentNodeId)) continue;
    visited.add(currentNodeId);
    const outgoing = instance.workflowSnapshot?.edges?.filter((edge) => edge.sourceNodeId === currentNodeId) ?? [];
    for (const edge of outgoing) {
      queue.push(edge.targetNodeId);
    }
  }
  return visited;
}

function collectLifecycleResetNodeIds(
  currentNodeStates: Record<string, NodeExecutionState> | null | undefined,
  incomingNodeStates: Record<string, NodeExecutionState> | null | undefined,
  newerSnapshot: "current" | "incoming" | "equal",
): Set<string> {
  const lifecycleResetNodeIds = new Set<string>();
  const nodeIds = new Set([
    ...Object.keys(currentNodeStates ?? {}),
    ...Object.keys(incomingNodeStates ?? {}),
  ]);
  for (const nodeId of nodeIds) {
    const currentNodeState = currentNodeStates?.[nodeId];
    const incomingNodeState = incomingNodeStates?.[nodeId];
    if (!currentNodeState || !incomingNodeState) continue;
    if (newerSnapshot === "equal") {
      if (
        nodeExecutionStatusPhase(incomingNodeState.status) < nodeExecutionStatusPhase(currentNodeState.status)
        && isResetLikeNodeExecutionStatus(incomingNodeState.status)
      ) {
        lifecycleResetNodeIds.add(nodeId);
        continue;
      }
      if (
        nodeExecutionStatusPhase(currentNodeState.status) < nodeExecutionStatusPhase(incomingNodeState.status)
        && isResetLikeNodeExecutionStatus(currentNodeState.status)
      ) {
        lifecycleResetNodeIds.add(nodeId);
      }
      continue;
    }
    if (newerSnapshot === "incoming" && nodeExecutionStatusPhase(incomingNodeState.status) < nodeExecutionStatusPhase(currentNodeState.status)) {
      lifecycleResetNodeIds.add(nodeId);
      continue;
    }
    if (newerSnapshot === "current" && nodeExecutionStatusPhase(currentNodeState.status) < nodeExecutionStatusPhase(incomingNodeState.status)) {
      lifecycleResetNodeIds.add(nodeId);
    }
  }
  return lifecycleResetNodeIds;
}

function resetTrackedNodeStateForRetry(nodeState: NodeExecutionState): void {
  nodeState.humanActionSource = null;
  nodeState.error = null;
  nodeState.errorCode = null;
  nodeState.providerThreadId = null;
  nodeState.recoveryReason = null;
  nodeState.preserveBinding = null;
  nodeState.userChoiceRequired = null;
  nodeState.recoveryStrategies = null;
  nodeState.gateResults = null;
  nodeState.conclusion = null;
  nodeState.output = null;
  nodeState.outputArtifactIds = null;
  nodeState.startedAt = null;
  nodeState.completedAt = null;
  nodeState.renderedInput = null;
  nodeState.branchTaken = null;
  nodeState.activeFeedbackRecordIds = null;
  nodeState.manualStartApprovedAt = null;
  nodeState.manualStartApprovedBy = null;
}

function pruneTrackedArtifactIndex(
  artifactIndex: Record<string, ArtifactId[]> | null | undefined,
  removedNodeIds: Set<string>,
): Record<string, ArtifactId[]> | null | undefined {
  if (!artifactIndex) return artifactIndex;
  if (!removedNodeIds.size) return artifactIndex;
  const pruned = Object.fromEntries(
    Object.entries(artifactIndex).filter(([nodeId]) => !removedNodeIds.has(nodeId)),
  );
  return Object.keys(pruned).length > 0 ? pruned : {};
}

function mergeTrackedArtifactIndex(
  current?: Record<string, ArtifactId[]> | null,
  incoming?: Record<string, ArtifactId[]> | null,
): Record<string, ArtifactId[]> | null | undefined {
  if (!current && !incoming) return incoming ?? current;
  const keys = new Set([
    ...Object.keys(current ?? {}),
    ...Object.keys(incoming ?? {}),
  ]);
  const merged: Record<string, ArtifactId[]> = {};
  for (const key of keys) {
    const values = mergeUniqueValues(current?.[key], incoming?.[key]);
    if (values) {
      merged[key] = values;
    }
  }
  return Object.keys(merged).length > 0 ? merged : incoming ?? current;
}

/** 统一把后端业务失败响应转为异常，避免调用方误判为成功。 */
function assertApiOk<T extends object>(res: ApiResult<T>, fallbackMessage: string): asserts res is Extract<ApiResult<T>, { ok: true }> {
  if (res.ok) return;
  throw createOrchestrationApiResultError(res, fallbackMessage);
}

/** 保留 API code/requestId，供组件边界输出可检索且不含正文的错误日志。 */
function createOrchestrationApiResultError(res: unknown, fallbackMessage: string): Error {
  const raw = res && typeof res === "object" ? res as Record<string, any> : {};
  const error = new Error(String(raw.message ?? "").trim() || fallbackMessage) as Error & {
    code?: string;
    requestId?: string | null;
  };
  error.code = String(raw.code ?? "API_REQUEST_FAILED").trim() || "API_REQUEST_FAILED";
  error.requestId = String(raw.requestId ?? raw.request_id ?? raw.meta?.requestId ?? "").trim() || null;
  return error;
}

function mergeUniqueValues<T>(current?: T[] | null, incoming?: T[] | null): T[] | null | undefined {
  const merged = Array.from(new Set([...(current ?? []), ...(incoming ?? [])]));
  if (merged.length > 0) return merged;
  if (incoming !== undefined) return incoming;
  return current;
}

function pickRicherCollection<T>(current?: T[] | null, incoming?: T[] | null): T[] | null | undefined {
  const currentSize = current?.length ?? 0;
  const incomingSize = incoming?.length ?? 0;
  if (incomingSize > currentSize) return incoming;
  if (currentSize > incomingSize) return current;
  return incoming ?? current;
}

function pickRicherText(current?: string | null, incoming?: string | null): string | null | undefined {
  const currentText = normalizeMeaningfulText(current);
  const incomingText = normalizeMeaningfulText(incoming);
  if (incomingText.length > currentText.length) return incoming;
  if (currentText.length > incomingText.length) return current;
  return incoming ?? current;
}

function normalizeMeaningfulText(value?: string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasMeaningfulText(value?: string | null): boolean {
  return normalizeMeaningfulText(value).length > 0;
}

function pickEarlierTimestamp(current?: number | null, incoming?: number | null): number | null | undefined {
  if (typeof current !== "number") return incoming;
  if (typeof incoming !== "number") return current;
  return Math.min(current, incoming);
}

function pickLaterTimestamp(current?: number | null, incoming?: number | null): number | null | undefined {
  if (typeof current !== "number") return incoming;
  if (typeof incoming !== "number") return current;
  return Math.max(current, incoming);
}

function compareArtifactsByCreatedAt(left: Artifact, right: Artifact): number {
  return (right.version ?? 0) - (left.version ?? 0)
    || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

function comparePromptSnapshotsByCreatedAt(left: NodePromptSnapshot, right: NodePromptSnapshot): number {
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

function compareOrchestrationEventsByCreatedAt(left: OrchestrationEventRecord, right: OrchestrationEventRecord): number {
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
    || String(right.id).localeCompare(String(left.id));
}

function safeParseOrchestrationPayload(payloadJson: string | null | undefined): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 判断编排事件是否为定时任务自动创建的新执行，用于触发定时编排列表刷新。 */
function isScheduledTaskInstanceStartedEvent(event: OrchestrationEventRecord, payload: Record<string, unknown> | null): boolean {
  return event.type === "orchestration.instanceStarted"
    && String(payload?.triggerSource ?? "").trim() === "scheduled_task";
}

function createKnowledgeSourceRef(input: {
  kind: KnowledgeSourceKind;
  title: string;
  ref?: string;
  description?: string | null;
  inlineBody?: string | null;
}) {
  return {
    id: `source-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: input.kind,
    title: input.title,
    description: input.description ?? null,
    ref: input.ref ?? null,
    inlineBody: input.inlineBody ?? null,
    enabled: true,
  };
}

