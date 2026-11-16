import crypto from "node:crypto";
import { assertChatWorkflowDirectoryAvailable } from "../../orchestration/workspaceExecutionGuard.js";
import fs from "node:fs";
import path from "node:path";

import type {
  AccessMode,
  AssetDraftId,
  AssetGenerationJob,
  AssetGenerationJobStatus,
  AssetGenerationJobId,
  ArtifactId,
  AssigneeTemplate,
  ConversationEventEnvelope,
  EngineType,
  FeedbackAction,
  InstanceAssignmentSnapshot,
  IntakeId,
  KnowledgeBundleDefinition,
  KnowledgeBundleId,
  ListStatusCount,
  NodeExecutionEnvelope,
  NodePromptSnapshot,
  NodeWorkItemStatus,
  NodeExecutionProfileScope,
  NodeThreadReusePolicy,
  OrchestrationExecutionEngineStrategy,
  OrchestrationId,
  OrchestrationInstance,
  OrchestrationInstanceSummary,
  OrchestrationRunPlan,
  OrchestrationRoleExecutionOverride,
  OrchestrationStatus,
  OrchRuntimeEvidenceGetResponseBody,
  OrchAssetGroupType,
  OrchIntakesListResponseBody,
  PendingMineListItem,
  PendingMineListStatus,
  ProposalId,
  RawEngineEventEnvelope,
  ReminderItem,
  ReminderTone,
  ReminderActionKind,
  RequirementCandidateId,
  RoleDefinition,
  RoleId,
  SkillDefinition,
  SkillId,
  SkillTargetEngine,
  SharedWorkspaceContextListItem,
  TaskIntake,
  TaskIntakeLegacyMetricEvidenceRef,
  TaskIntakeMetricCohortSnapshot,
  TaskIntakeMetricComparabilityPolicy,
  TaskIntakeMetricEvidenceRef,
  TaskIntakeMetricEvidenceSummary,
  TaskIntakeMetricReviewCohortEvidence,
  TaskIntakeMetricReviewReason,
  TaskIntakeMetricReviewSnapshot,
  TaskIntakeMetricReviewSummary,
  TaskIntakeListMeta,
  TaskIntakeExecutionPlan,
  TaskIntakeSourceKind,
  TaskType,
  ThreadId,
  ThreadSummary,
  DownstreamThreadReusePolicy,
  ToolsetDefinition,
  ToolsetId,
  ToolsetRuntimeDefinition,
  WorkflowDefinition,
  WorkflowId,
  WorkflowProposal,
  WorkflowRuntimeDefinition,
  WorkspaceId,
} from "@codeflowai/shared";
import {
  ORCH_ASSET_GROUP_TYPES,
  getEnabledRoleExecutionEngines,
  isAssigneeTemplateStatus,
  isRoleExecutionEngineEnabled,
  normalizeAssigneeTemplateStatus,
  normalizeOrchestrationRunMode,
  normalizeOrchestrationRunPlanAssigneeList,
  normalizeOrchestrationRunPlanAssignees,
  normalizeOrchestrationRunPlanSkippedNodeIds,
  normalizeOrchestrationExecutionEngineStrategy,
  parseStandaloneRoleWorkflowId,
  normalizeTaskAcceptanceCriteria,
  normalizeTaskIntakeTitle,
  normalizeRoleExecutionConfig,
  normalizeOrchAssetBundleImportMode,
  isOrchestrationRuntimeConflictError,
  toOrchestrationRuntimeConflictBody,
  validateInlineThreadPayload,
} from "@codeflowai/shared";

/** 列出指定类型的资产分组和关联。 */
export function handleOrchAssetGroupsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const input = resolveAssetGroupInput(ctx, req);
  if (!input) return;
  ok(ctx, req, ctx.db.orchAssetGroups.list(input.workspaceId, input.assetType));
}

/** 创建指定资产类型的自定义分组。 */
export function handleOrchAssetGroupsCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const input = resolveAssetGroupInput(ctx, req);
  if (!input) return;
  try {
    ok(ctx, req, { group: ctx.db.orchAssetGroups.create(input.workspaceId, input.assetType, str(req, "name")) });
  } catch (error) {
    sendAssetGroupError(ctx, req, error);
  }
}

/** 重命名指定资产类型的分组。 */
export function handleOrchAssetGroupsRename(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const input = resolveAssetGroupInput(ctx, req);
  if (!input) return;
  try {
    ok(ctx, req, { group: ctx.db.orchAssetGroups.rename(input.workspaceId, input.assetType, str(req, "groupId"), str(req, "name")) });
  } catch (error) {
    sendAssetGroupError(ctx, req, error);
  }
}

/** 删除分组，原关联资产自动回到未分组。 */
export function handleOrchAssetGroupsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const input = resolveAssetGroupInput(ctx, req);
  if (!input) return;
  try {
    ctx.db.orchAssetGroups.delete(input.workspaceId, input.assetType, str(req, "groupId"));
    ok(ctx, req, {});
  } catch (error) {
    sendAssetGroupError(ctx, req, error);
  }
}

/** 移动自定义资产到分组；内置资产禁止分组。 */
export function handleOrchAssetGroupsAssign(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const input = resolveAssetGroupInput(ctx, req);
  if (!input) return;
  const assetId = str(req, "assetId");
  const asset = findGroupedAsset(ctx, input.workspaceId, input.assetType, assetId);
  if (!asset) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "资产不存在" } });
    return;
  }
  if (asset.kind === "builtin") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "内置资产不能移动分组" } });
    return;
  }
  try {
    ctx.db.orchAssetGroups.assign(input.workspaceId, input.assetType, assetId, str(req, "groupId") || null);
    ok(ctx, req, { groupId: str(req, "groupId") || null });
  } catch (error) {
    sendAssetGroupError(ctx, req, error);
  }
}

function resolveAssetGroupInput(ctx: ApiHandlerContext, req: ApiRequestMessage): { workspaceId: WorkspaceId; assetType: OrchAssetGroupType } | null {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const assetType = str(req, "assetType") as OrchAssetGroupType;
  if (!workspaceId || !ORCH_ASSET_GROUP_TYPES.includes(assetType)) return badParam(ctx, req, "workspaceId/assetType"), null;
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId), null;
  return { workspaceId, assetType };
}

function findGroupedAsset(ctx: ApiHandlerContext, workspaceId: WorkspaceId, assetType: OrchAssetGroupType, assetId: string): { workspaceId: WorkspaceId; kind?: string | null } | null {
  const asset = assetType === "workflow" ? ctx.db.orchWorkflows.get(assetId as WorkflowId)
    : assetType === "role" ? ctx.db.orchRoles.get(assetId as RoleId)
      : assetType === "knowledge" ? ctx.db.orchKnowledgeBundles.get(assetId as KnowledgeBundleId)
        : assetType === "skill" ? ctx.db.orchSkills.get(assetId as SkillId)
          : ctx.db.orchToolsets.get(assetId as ToolsetId);
  return asset && asset.workspaceId === workspaceId ? asset : null;
}

function sendAssetGroupError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = /不存在/.test(message) ? 404 : /UNIQUE constraint/.test(message) ? 409 : 400;
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, message: /UNIQUE constraint/.test(message) ? "分组名称已存在" : message } });
}

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { interruptTurnBestEffort } from "../turnInterrupt.js";
import { normalizeTextFiles } from "../utils/promptWithAttachments.js";
import { AssetDraftService, AssetDraftServiceError } from "../../orchestration/assetDraftService.js";
import { logger } from "../../logger.js";
import {
  applyOrchAssetBundle,
  copyPersonalOrchAsset,
  buildActiveServerDefaultAssetIds,
  exportKnowledgeBundleDependencyBundle,
  exportRoleDependencyBundle,
  exportSkillDependencyBundle,
  exportToolsetDependencyBundle,
  exportWorkflowDependencyBundle,
} from "../../orchestration/assetBundleService.js";
import {
  createProposalFromIntake as buildProposalFromIntake,
  createProposalFromRole as buildProposalFromRole,
} from "../../orchestration/proposalBuilder.js";
import { isDesktopLocalAssetExecution, isDesktopLocalThreadAssetExecution, listDesktopLocalRequirementThreadIds, type OrchAssetAuthorityRuntimeReadSession } from "../../orchestration/orchAssetAuthorityRuntimeReadService.js";
import { isDesktopLocalAssetWorkspace } from "../../orchestration/desktopBuiltinAssetService.js";
import {
  OrchCurrentWorkflowLabelResolver,
  relabelInstanceSummary,
  relabelRunSummary,
  relabelWorkflowDefinition,
} from "../../orchestration/orchCurrentDefinitionLabels.js";
import type {
  OrchAssetLaunchSnapshot,
  OrchAssetLaunchSnapshotService,
} from "../../orchestration/orchAssetLaunchSnapshotService.js";
import { RequirementAnalysisService, RequirementAnalysisServiceError } from "../../orchestration/requirementAnalysisService.js";
import { OrchRequirementAnalysisSessionRepoError } from "../../db/repos/orchRequirementAnalysisSessionRepo.js";
import { computeOrchNodeRuntimeBreakdown } from "../../orchestration/nodeRuntimeBreakdown.js";
import {
  getSkillPackageInstallStatus,
  installSkillPackage,
  uninstallSkillPackage,
} from "../../orchestration/skillPackageService.js";
import { isActiveTurnConflictError } from "../../engines/threadSession.js";
import { assertClientReasoningEffortSupported } from "../../engines/engineModelCapabilities.js";
import { ChatWorkflowRepo } from "../../db/repos/chatWorkflowRepo.js";
import type { OrchWorkflowExecutionDefaultRepo } from "../../db/repos/orchWorkflowExecutionDefaultRepo.js";
import {
  assertRuntimeEngineModelAvailable,
  resolveRuntimeRoleExecutionConfigForEngine,
  resolveRuntimeRoleExecutionConfigForStrategy,
} from "../../engines/engineModelCatalogRuntime.js";

const ORCH_FEEDBACK_ACTIONS = [
  "approve",
  "retry",
  "override",
  "skip",
  "abort",
  "resume_with_input",
  "choose_branch",
  "cancel",
  "rework_to_target",
  "reevaluate_gates",
] as const satisfies readonly FeedbackAction[];
const ORCH_FEEDBACK_ACTION_ERROR_MESSAGE = `参数错误：action。可用值：${ORCH_FEEDBACK_ACTIONS.join(", ")}。不要使用 continue；waiting-feedback 补充后继续用 {"action":"resume_with_input","feedback":"已补充说明"}；审核通过用 {"action":"approve"}；分支选择用 {"action":"choose_branch","targetNodeId":"ui"}。`;
type RuntimeRoleDefinition = Omit<RoleDefinition, "createdAt" | "updatedAt">;
type RuntimeRoleReader = (roleId: RoleId) => RuntimeRoleDefinition | null;

// ── Intakes / Requirements ──────────────────────────────────────

/** 列表读取模式仅由可信上下文决定，正文不能放宽或收窄工作区归属。 */
export async function handleOrchIntakesList(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const limit = parsePositiveInt((req.body as any)?.limit, 100, 500);
  const cursor = nullableString((req.body as any)?.cursor);
  const allowedResourceIds = normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds);
  const sourceKind = normalizeTaskIntakeSourceKind((req.body as any)?.sourceKind) ?? "requirement";
  const search = nullableString((req.body as any)?.search);
  const statuses = normalizeStringArray((req.body as any)?.statuses);
  try {
    if (!ctx.orchIntakeListReader) {
      const unavailable = new Error("需求列表只读服务未初始化") as Error & { code: string };
      unavailable.code = "ORCH_LIST_READER_UNAVAILABLE";
      throw unavailable;
    }
    const body = await ctx.orchIntakeListReader.listIntakes({
      requestId: req.id,
      workspaceId,
      sourceKind,
      limit,
      cursor,
      search,
      statuses,
      allowedResourceIds,
      localWorkspaceOnly: ctx.localWorkspaceOnly === true,
    });
    ok(ctx, req, await withAssetDraftDatabase(ctx, req.id, () => relabelIntakeListWorkflowNames(ctx, workspaceId, req.id, body)));
  } catch (error) {
    const errorCode = String((error as { code?: unknown } | null)?.code ?? "ORCH_LIST_READER_FAILED");
    const rootCause = error instanceof Error ? error.message : String(error);
    logger.error("orch-list-reader", "orchestration intake list read failed", {
      errorCode,
      requestId: req.id,
      workspaceId,
      sourceKind,
      limit,
      hasCursor: Boolean(cursor),
      allowedResourceCount: allowedResourceIds?.length ?? null,
      rootCause,
      errorDetails: error && typeof error === "object" && !Array.isArray(error)
        ? ((error as { details?: unknown }).details ?? null)
        : null,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, code: errorCode, message: "需求列表读取失败" },
    });
  }
}

/** 需求列表的流程名与最新实例摘要按当前工作流定义覆盖；列表读取器只提供冻结快照，没有实例的行保持原值。 */
function relabelIntakeListWorkflowNames(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  requestId: string,
  body: OrchIntakesListResponseBody,
): OrchIntakesListResponseBody {
  const entries = Object.entries(body.listMetaById ?? {});
  if (entries.length === 0) return body;
  const resolver = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, requestId);
  const listMetaById: Record<string, TaskIntakeListMeta> = { ...body.listMetaById };
  let changed = false;
  for (const [intakeId, meta] of entries) {
    const latestInstance = meta.latestInstance ?? null;
    const labels = latestInstance ? resolver.resolve(workspaceId, latestInstance.workflowId) : null;
    if (!labels) continue;
    listMetaById[intakeId] = {
      ...meta,
      workflowName: labels.name ?? meta.workflowName,
      latestInstance: latestInstance ? relabelInstanceSummary(latestInstance, labels) : meta.latestInstance,
    };
    changed = true;
  }
  return changed ? { ...body, listMetaById } : body;
}

/** 新需求只保存可信入口给出的归属，忽略正文中的归属字段。 */
export function handleOrchIntakesCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const intakeInput = (req.body as any)?.intake;
  if (!intakeInput || typeof intakeInput !== "object") return badParam(ctx, req, "intake");
  const titleRaw = String(intakeInput?.title ?? "").trim();
  if (!titleRaw) return badParam(ctx, req, "intake.title");
  const title = normalizeTaskIntakeTitle(titleRaw);
  const executionPlanResult = parseTaskIntakeExecutionPlanForSave(intakeInput?.executionPlan);
  if (!executionPlanResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: executionPlanResult.message } });
    return;
  }
  const metricEvidenceResult = parseTaskIntakeMetricEvidenceRefs(intakeInput?.metricEvidenceRefs);
  if (!metricEvidenceResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: metricEvidenceResult.message } });
    return;
  }

  const intake = ctx.db.orchIntakes.create({
    workspaceId,
    workspaceScope: ctx.intakeWorkspaceScope ?? null,
    triggerMode: normalizeTriggerMode(intakeInput?.triggerMode),
    taskType: inferTaskTypeFromInput(intakeInput?.taskType, intakeInput?.goal),
    title,
    goal: String(intakeInput?.goal ?? "").trim(),
    background: nullableString(intakeInput?.background),
    acceptanceCriteria: normalizeTaskAcceptanceCriteria(intakeInput?.acceptanceCriteria),
    workbenchItemRefs: normalizeStringArray(intakeInput?.workbenchItemRefs),
    seedArtifactRefs: normalizeStringArray(intakeInput?.seedArtifactRefs) as ArtifactId[] | null,
    metricEvidenceRefs: metricEvidenceResult.refs,
    constraints: normalizeConstraints(intakeInput?.constraints),
    executionPlan: executionPlanResult.executionPlan,
    requester: normalizeRequester(intakeInput?.requester),
  });
  ok(ctx, req, { intake });
}

/** 编辑保持原归属；未知旧记录不因当前入口或正文而被自动认领。 */
export function handleOrchIntakesUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const intakeInput = (req.body as any)?.intake;
  if (!intakeInput || typeof intakeInput !== "object") return badParam(ctx, req, "intake");

  const intakeId = String(intakeInput?.id ?? "").trim() as IntakeId;
  if (!intakeId) return badParam(ctx, req, "intake.id");
  const titleRaw = String(intakeInput?.title ?? "").trim();
  if (!titleRaw) return badParam(ctx, req, "intake.title");
  const title = normalizeTaskIntakeTitle(titleRaw);
  const executionPlanResult = parseTaskIntakeExecutionPlanForSave(intakeInput?.executionPlan);
  if (!executionPlanResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: executionPlanResult.message } });
    return;
  }
  const metricEvidenceResult = parseTaskIntakeMetricEvidenceRefs(intakeInput?.metricEvidenceRefs);
  if (!metricEvidenceResult.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: metricEvidenceResult.message } });
    return;
  }

  const existing = ctx.db.orchIntakes.get(intakeId);
  if (existing && !isScopedOrchestrationIntake(ctx, existing)) return hiddenOrchestrationResource(ctx, req);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的需求" } });
    return;
  }
  const existingScope = existing?.workspaceScope;
  const requestScope = ctx.intakeWorkspaceScope;
  if (existingScope && requestScope && (existingScope.scopeType !== requestScope.scopeType || existingScope.scopeId !== requestScope.scopeId)) {
    logger.warn("orch-api", "intake edit rejected for mismatched workspace scope", {
      errorCode: "ORCH_INTAKE_SCOPE_CONFLICT", requestId: req.id, clientId: ctx.clientId, workspaceId, intakeId,
      expectedScope: existingScope, requestScope, rootCause: "trusted request scope differs from persisted intake scope",
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, code: "FORBIDDEN", message: "需求归属与当前工作区不一致" } });
    return;
  }

  const intake = ctx.db.orchIntakes.upsert({
    id: intakeId,
    workspaceId,
    workspaceScope: existing ? existing.workspaceScope ?? null : ctx.intakeWorkspaceScope ?? null,
    triggerMode: normalizeTriggerMode(intakeInput?.triggerMode),
    taskType: inferTaskTypeFromInput(intakeInput?.taskType, intakeInput?.goal),
    title,
    goal: String(intakeInput?.goal ?? "").trim(),
    background: nullableString(intakeInput?.background),
    acceptanceCriteria: normalizeTaskAcceptanceCriteria(intakeInput?.acceptanceCriteria),
    workbenchItemRefs: normalizeStringArray(intakeInput?.workbenchItemRefs),
    seedArtifactRefs: normalizeStringArray(intakeInput?.seedArtifactRefs) as ArtifactId[] | null,
    metricEvidenceRefs: metricEvidenceResult.refs,
    constraints: normalizeConstraints(intakeInput?.constraints),
    executionPlan: executionPlanResult.executionPlan,
    requester: normalizeRequester(intakeInput?.requester),
  });
  ok(ctx, req, { intake });
}

/** 级联删除先验证完整归属，保护资源冲突必须早于取消、释放及持久化删除。 */
export async function handleOrchIntakesDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const intakeId = str(req, "intakeId") as IntakeId;
  const forceDeleteRunning = parseOptionalBooleanParam(ctx, req, (req.body as any)?.forceDeleteRunning, "forceDeleteRunning");
  if (forceDeleteRunning == null) return;
  if (!workspaceId || !intakeId) return badParam(ctx, req, "workspaceId/intakeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const intake = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchIntakes.get(intakeId));
  if (intake && !isScopedOrchestrationIntake(ctx, intake)) return hiddenOrchestrationResource(ctx, req);
  if (!intake) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `需求不存在：${intakeId}` } });
    return;
  }
  if (intake.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的需求" } });
    return;
  }

  const instances = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchInstances.listByWorkspace(workspaceId, { strictScope: ctx.localWorkspaceOnly === true })
    .filter((instance) => instance.intakeSnapshot.id === intakeId));
  if (ctx.localWorkspaceOnly === true) {
    const proposals = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchProposals.listByWorkspace(workspaceId, { strictScope: true }).filter((proposal) => proposal.intakeId === intakeId));
    if (instances.some((instance) => !isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, instance))
      || proposals.some((proposal) => !isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, proposal))
      || await withAssetDraftDatabase(ctx, req.id, () => collectIntakeThreadIds(instances).some((threadId) => !isDesktopLocalThreadAssetExecution(ctx.clientId, ctx.workspaces, ctx.db, threadId)))) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "CONFLICT", message: "需求包含当前入口不可操作的执行历史，不能级联删除" } });
      return;
    }
  }
  const activeInstances = instances.filter((instance) => isActiveInstanceStatus(instance.status));
  if (activeInstances.length > 0 && !forceDeleteRunning) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "CONFLICT",
        message: `当前需求仍有进行中的执行：${activeInstances[0]!.id}。请先结束或取消该执行，再删除需求。`,
        details: {
          reason: "ACTIVE_RUNNING_INSTANCE",
          activeInstanceIds: activeInstances.map((instance) => instance.id),
        },
      },
    });
    return;
  }

  let cancelledActiveInstanceCount = 0;
  for (const instance of activeInstances) {
    await ctx.orchEngine.cancelAndWait(instance.id);
    cancelledActiveInstanceCount += 1;
  }

  const threadIds = collectIntakeThreadIds(instances);
  for (const threadId of threadIds) {
    await disposeThreadRuntime(ctx, threadId);
  }

  const deletedProposalCount = await withAssetDraftDatabase(ctx, req.id, () => deleteIntakeCascade(ctx, intakeId, instances, threadIds, { workspaceId, requestId: req.id }));
  ok(ctx, req, {
    deletedProposalCount,
    deletedInstanceCount: instances.length,
    deletedThreadCount: threadIds.length,
    cancelledActiveInstanceCount,
  });
}

// ── Requirement Analysis Assistant ──────────────────────────────

/** 本机权威与权限、计数、搜索分页在同一只读快照内相交。 */
export function handleOrchRequirementAnalysisSessionsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const limit = parsePositiveInt((req.body as any)?.limit, 100, 500);
  const cursor = nullableString((req.body as any)?.cursor);
  const search = nullableString((req.body as any)?.search);
  const statuses = normalizeStringArray((req.body as any)?.statuses);
  const readPage = () => createRequirementAnalysisService(ctx).listSessions(workspaceId, {
    includeArchived: true,
    limit,
    cursor,
    search,
    statuses,
    allowedResourceIds: normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds),
    localThreadIds: ctx.localWorkspaceOnly === true ? listDesktopLocalRequirementThreadIds(ctx.clientId, ctx.workspaces, ctx.db, workspaceId) : undefined,
  });
  const page = ctx.localWorkspaceOnly === true ? ctx.db.db.transaction(readPage)() : readPage();
  ok(ctx, req, {
    ...page,
    listPageMeta: {
      totalCount: page.totalCount,
      cursorScope: buildListCursorScope({
        sourceKind: "requirement-analysis",
        search,
        statuses,
        allowedResourceIds: normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds),
      }),
    },
  });
}

/** 返回当前用户待处理列表；共享 Host 可关闭仅适用于本地个人提醒的查收项。 */
export function handleOrchPendingMineList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const limit = parsePositiveInt((req.body as any)?.limit, 100, 500);
  const cursor = nullableString((req.body as any)?.cursor);
  const search = nullableString((req.body as any)?.search);
  const statuses = normalizePendingMineListStatuses((req.body as any)?.statuses);
  const allowedResourceIds = normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds);
  const includeReceipts = (req.body as any)?.includeReceipts !== false;
  const page = listPendingMineItems(ctx, {
    workspaceId,
    limit,
    cursor,
    search,
    statuses,
    allowedResourceIds,
    includeReceipts,
    requestId: req.id,
  });
  ok(ctx, req, {
    ...page,
    listPageMeta: {
      totalCount: page.totalCount,
      cursorScope: buildListCursorScope({
        sourceKind: "pending-mine",
        search,
        statuses,
        allowedResourceIds,
        includeReceipts,
      }),
    },
  });
}

/** 已有 RA 只能从其持久本机归属续接，不能以创建入口认领。 */
export function handleOrchRequirementAnalysisSessionsCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const threadId = str(req, "threadId") as ThreadId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!threadId) return badParam(ctx, req, "threadId");
  if (!allowScopedRequirementSession(ctx, req, workspaceId, threadId)) return;

  const title = nullableString((req.body as any)?.title);
  const created = createRequirementAnalysisService(ctx).createSession({ workspaceId, threadId, title });
  ok(ctx, req, created);
}

/** 获取会话前沿持久 RA 统一权威入口校验。 */
export function handleOrchRequirementAnalysisSessionsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const sessionId = str(req, "sessionId");
  if (!workspaceId || !sessionId) return badParam(ctx, req, "workspaceId/sessionId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  if (!allowScopedRequirementSession(ctx, req, workspaceId, sessionId as ThreadId)) return;
  const data = createRequirementAnalysisService(ctx).getSession(workspaceId, sessionId as any);
  if (!data) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `需求分析会话不存在：${sessionId}` } });
    return;
  }
  ok(ctx, req, data);
}

/** 归档不能改变当前入口不可操作的 RA。 */
export function handleOrchRequirementAnalysisSessionsArchive(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const sessionId = str(req, "sessionId");
  const status = String((req.body as any)?.status ?? "").trim();
  if (!workspaceId || !sessionId) return badParam(ctx, req, "workspaceId/sessionId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (status !== "active" && status !== "archived") return badParam(ctx, req, "status");

  if (!allowScopedRequirementSession(ctx, req, workspaceId, sessionId as ThreadId)) return;
  const session = createRequirementAnalysisService(ctx).updateSessionStatus(workspaceId, sessionId as any, status);
  if (!session) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `需求分析会话不存在：${sessionId}` } });
    return;
  }
  ok(ctx, req, { session });
}

/** 仓储领域错误交回中央 API 单次记录，其余发送失败沿用原策略。 */
export async function handleOrchRequirementAnalysisMessagesSend(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const sessionId = str(req, "sessionId");
  const text = String((req.body as any)?.text ?? "").trim();
  if (!workspaceId || !sessionId || !text) return badParam(ctx, req, "workspaceId/sessionId/text");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!await withAssetDraftDatabase(ctx, req.id, () => allowScopedRequirementSession(ctx, req, workspaceId, sessionId as ThreadId))) return;

  try {
    const data = await createRequirementAnalysisService(ctx).sendMessage({
      workspaceId,
      sessionId: sessionId as any,
      text,
      planMode: Boolean((req.body as any)?.planMode ?? false),
      accessMode: parseAccessMode((req.body as any)?.accessMode),
      model: nullableString((req.body as any)?.model),
      effort: nullableString((req.body as any)?.effort),
      images: Array.isArray((req.body as any)?.images) ? ((req.body as any).images as string[]) : [],
      files: Array.isArray((req.body as any)?.files) ? normalizeTextFiles((req.body as any).files as unknown[]) : [],
      contextWindow: normalizeContextWindow((req.body as any)?.contextWindow),
      autoCompactPct: normalizeAutoCompactPct((req.body as any)?.autoCompactPct),
      serviceTier: (req.body as any)?.serviceTier === "fast" ? "fast" : null,
    });
    ok(ctx, req, data);
  } catch (error) {
    if (error instanceof OrchRequirementAnalysisSessionRepoError || error instanceof RequirementAnalysisServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    logger.error("orch-requirement-analysis", "requirement analysis message send failed", {
      errorCode: String((error as any)?.code ?? "requirement_analysis_message_send_failed"),
      requestId: req.id,
      workspaceId,
      sessionId,
      cause: message,
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: isActiveTurnConflictError(error) ? 409 : 500, body: { ok: false, message } });
  }
}

/** 创建需求的仓储领域错误显式上抛，避免被通用参数错误掩盖。 */
export function handleOrchRequirementAnalysisCreateIntakes(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const sessionId = str(req, "sessionId");
  const candidateIds = normalizeStringArray((req.body as any)?.candidateIds) as any[] | null;
  const workflowSelections = Array.isArray((req.body as any)?.workflowSelections)
    ? ((req.body as any).workflowSelections as unknown[])
      .map((item) => {
        const raw = item as Record<string, unknown> | null | undefined;
        const candidateId = String(raw?.candidateId ?? "").trim();
        const workflowId = String(raw?.workflowId ?? "").trim();
        if (!candidateId || !workflowId) return null;
        return { candidateId: candidateId as any, workflowId: workflowId as any };
      })
      .filter((item): item is { candidateId: RequirementCandidateId; workflowId: WorkflowId } => Boolean(item))
    : null;
  if (!workspaceId || !sessionId || !candidateIds?.length) return badParam(ctx, req, "workspaceId/sessionId/candidateIds");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!allowScopedRequirementSession(ctx, req, workspaceId, sessionId as ThreadId)) return;

  try {
    const data = createRequirementAnalysisService(ctx).createIntakes({
      workspaceId,
      sessionId: sessionId as any,
      candidateIds: candidateIds as any,
      workflowSelections,
    });
    ok(ctx, req, data);
  } catch (error) {
    if (error instanceof OrchRequirementAnalysisSessionRepoError || error instanceof RequirementAnalysisServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

// ── Roles ────────────────────────────────────────────────────────

export function handleOrchRolesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const roles = ctx.db.orchRoles.listByWorkspace(workspaceId);
  ok(ctx, req, { roles });
}

/** 新增或更新角色定义，并阻止未授权覆盖内置角色。 */
export function handleOrchRolesUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const roleInput = (req.body as any)?.role;
  if (!roleInput || typeof roleInput !== "object") return badParam(ctx, req, "role");
  const executionConfigIssue = validateRoleExecutionConfigInput(ctx, roleInput?.executionConfig);
  if (executionConfigIssue) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: executionConfigIssue } });
    return;
  }
  const existing = roleInput.id ? ctx.db.orchRoles.get(roleInput.id as RoleId) : null;
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的角色" } });
    return;
  }
  if (rejectBuiltinAssetUpsert(ctx, req, existing, roleInput.kind, "内置角色")) return;

  const role = ctx.db.orchRoles.upsert({
    ...roleInput,
    workspaceId,
    executionConfig: normalizeRoleExecutionConfig(roleInput.executionConfig, roleInput.executionConfig?.preferredEngine ?? "codex"),
  });
  ok(ctx, req, { role });
}

export function handleOrchRolesDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const roleId = str(req, "roleId") as RoleId;
  if (!workspaceId || !roleId) return badParam(ctx, req, "workspaceId/roleId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = ctx.db.orchRoles.get(roleId);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的角色" } });
    return;
  }
  if (rejectBuiltinAssetDelete(ctx, req, existing, "内置角色")) return;
  ctx.db.db.transaction(() => {
    ctx.db.orchRoles.delete(roleId);
    ctx.db.orchAssetGroups.deleteAssignment(workspaceId, "role", roleId);
  })();
  ok(ctx, req, {});
}

/** 桌面个人复制固定完整图和独立副本，Server/共享入口不能借此克隆私域。 */
export function handleOrchAssetsCopy(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  if (!ctx.localWorkspaceOnly) {
    logger.warn("orch-api", "personal asset copy requires desktop scope", {
      errorCode: "DESKTOP_ASSET_SCOPE_REQUIRED", requestId: req.id, clientId: ctx.clientId,
      workspaceId: str(req, "workspaceId"), rootCause: "request did not enter the trusted desktop adapter",
    });
    ctx.onApiFailureLogged?.();
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, code: "FORBIDDEN", message: "个人资产复制仅支持本机桌面入口" } });
    return;
  }
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const workspacePath = ctx.workspaces.get(workspaceId);
  const assetId = str(req, "assetId");
  const assetType = str(req, "assetType");
  if (!assetId || !["role", "workflow", "knowledge_bundle", "toolset", "skill"].includes(assetType)) return badParam(ctx, req, "assetType/assetId");
  if (!workspacePath) return notFoundWs(ctx, req, workspaceId);
  const imported = copyPersonalOrchAsset({ db: ctx.db, workspaceId, workspacePath, assetId, assetType: assetType as import("@codeflowai/shared").OrchAssetType });
  ok(ctx, req, { imported });
}

export function handleOrchAssetBundlesExport(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const workflowIds = normalizeStringArray((req.body as any)?.workflowIds) ?? [];
  const roleIds = normalizeStringArray((req.body as any)?.roleIds) ?? [];
  const knowledgeBundleIds = normalizeStringArray((req.body as any)?.knowledgeBundleIds) ?? [];
  const skillIds = normalizeStringArray((req.body as any)?.skillIds) ?? [];
  const toolsetIds = normalizeStringArray((req.body as any)?.toolsetIds) ?? [];
  const selectedKindCount = [workflowIds, roleIds, knowledgeBundleIds, skillIds, toolsetIds].filter((ids) => ids.length > 0).length;
  if (selectedKindCount !== 1) {
    return badParam(ctx, req, "workflowIds/roleIds/knowledgeBundleIds/skillIds/toolsetIds");
  }
  try {
    const bundle = workflowIds.length
      ? exportWorkflowDependencyBundle({
        db: ctx.db,
        workspaceId,
        workflowIds,
      })
      : roleIds.length
        ? exportRoleDependencyBundle({
          db: ctx.db,
          workspaceId,
          roleIds,
        })
        : knowledgeBundleIds.length
          ? exportKnowledgeBundleDependencyBundle({
            db: ctx.db,
            workspaceId,
            knowledgeBundleIds,
          })
          : skillIds.length
            ? exportSkillDependencyBundle({
              db: ctx.db,
              workspaceId,
              skillIds,
            })
            : exportToolsetDependencyBundle({
              db: ctx.db,
              workspaceId,
              toolsetIds,
            });
    ok(ctx, req, { bundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

export function handleOrchAssetBundlesImport(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) return notFoundWs(ctx, req, workspaceId);
  const bundle = (req.body as any)?.bundle ?? null;
  if (!bundle || typeof bundle !== "object") return badParam(ctx, req, "bundle");
  try {
    const importMode = normalizeOrchAssetBundleImportMode((req.body as any)?.importMode);
    const imported = ctx.db.db.transaction(() => applyOrchAssetBundle({
      db: ctx.db,
      workspaceId,
      workspacePath,
      bundle,
      importMode,
    }))();
    ok(ctx, req, { imported });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

/** 资产助手仓储短段与异步生成 owner 共用同一数据库准入。 */
function withAssetDraftDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 构造原资产服务后释放许可，由生成 owner 管理后续同步数据库段。 */
export async function handleOrchAssetDraftsGenerate(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const body = (req.body as any) ?? {};
    const service = await withAssetDraftDatabase(ctx, req.id, () => createAssetDraftService(ctx));
    const assetKind = body?.assetKind === "skill" ? "skill" : "role";
    const result = await service.generateAssetDraft({
      workspaceId,
      assetKind,
      mode: body?.mode === "revise" ? "revise" : "create",
      targetAssetId: nullableString(body?.targetAssetId),
      roleSnapshot: body?.roleSnapshot ?? null,
      skillSnapshot: body?.skillSnapshot ?? null,
      clientRequestId: nullableString(body?.clientRequestId),
      prompt: String(body?.prompt ?? ""),
      contextOptions: body?.contextOptions ?? null,
      enginePreference: body?.enginePreference ?? null,
    });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

export function handleOrchAssetDraftJobsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const jobId = str(req, "jobId") as AssetGenerationJobId;
  if (!workspaceId || !jobId) return badParam(ctx, req, "workspaceId/jobId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const result = createAssetDraftService(ctx).getAssetDraftJob({ workspaceId, jobId });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

/** 返回最近的助手草案任务列表，用于 Web 刷新后恢复会话入口。 */
export function handleOrchAssetDraftJobsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const result = createAssetDraftService(ctx).listAssetDraftJobs({
      workspaceId,
      limit: parsePositiveInt((req.body as any)?.limit, 30, 100),
    });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

/** 删除助手草案任务，并清理其关联的 asset-draft 会话资源。 */
export async function handleOrchAssetDraftJobsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const jobId = str(req, "jobId") as AssetGenerationJobId;
  if (!workspaceId || !jobId) return badParam(ctx, req, "workspaceId/jobId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const loadedJob = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchAssetGenerationJobs.get(jobId));
  if (!loadedJob || loadedJob.workspaceId !== workspaceId || (loadedJob.assetKind !== "role" && loadedJob.assetKind !== "skill")) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `草案任务不存在：${jobId}` } });
    return;
  }
  const loadedThread = loadedJob.threadId ? await withAssetDraftDatabase(ctx, req.id, () => ctx.db.threads.get(loadedJob.threadId!)) : null;
  if (loadedThread && loadedThread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "CONFLICT", message: "草案任务关联会话不属于当前工作区" } });
    return;
  }
  let job: AssetGenerationJob = loadedJob;
  try {
    await stopAssetDraftJobForDelete(ctx, job);
    const stoppedJob = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchAssetGenerationJobs.get(job.id));
    if (!stoppedJob) throw new Error(`停止生成后草案任务丢失：${jobId}`);
    job = stoppedJob;

    const threadId = job.threadId;
    const thread = threadId ? await withAssetDraftDatabase(ctx, req.id, () => ctx.db.threads.get(threadId)) : null;
    if (thread && thread.workspaceId !== workspaceId) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, code: "CONFLICT", message: "草案任务关联会话不属于当前工作区" } });
      return;
    }
    if (thread) {
      await ctx.orchEngine.disposeManagedServicesForThread(thread.id, "asset-draft-job-deleted");
      await ctx.sessions.disposeThreadWithOptions(thread.id, { flushActiveTurn: false });
      await ctx.flushLocalEvents?.(workspaceId, thread.id);
    }

    await withAssetDraftDatabase(ctx, req.id, () => ctx.db.db.transaction(() => {
      ctx.db.orchAssetGenerationJobs.delete(job.id);
      if (thread) ctx.db.threads.delete(thread.id);
    })());
    if (thread) ctx.threads.delete(thread.id);
    ok(ctx, req, { jobId: job.id, threadId: threadId ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("orch-asset-draft", "asset draft job delete failed", {
      requestId: req.id,
      workspaceId,
      jobId,
      threadId: job.threadId ?? null,
      jobStatus: job.status,
      error: message,
    });
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        code: "ASSET_DRAFT_DELETE_FAILED",
        message: `未能安全停止或清理助手会话，数据已保留。请重试；若持续失败，请按 requestId ${req.id} 排查 Client 日志。`,
      },
    });
  }
}

/** 恢复任务的异步业务由原服务协调，handler 只许可同步构造。 */
export async function handleOrchAssetDraftJobsResume(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const jobId = str(req, "jobId") as AssetGenerationJobId;
  if (!workspaceId || !jobId) return badParam(ctx, req, "workspaceId/jobId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const body = (req.body as any) ?? {};
    const service = await withAssetDraftDatabase(ctx, req.id, () => createAssetDraftService(ctx));
    const result = await service.resumeAssetDraftJob({
      workspaceId,
      jobId,
      prompt: String(body?.prompt ?? ""),
      selectedPaths: Array.isArray(body?.selectedPaths) ? (body.selectedPaths as string[]) : null,
      targetThreadId: nullableString(body?.targetThreadId) as ThreadId | null,
      enginePreference: body?.enginePreference ?? null,
    });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

export function handleOrchAssetDraftsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const draftId = str(req, "draftId") as AssetDraftId;
  if (!workspaceId || !draftId) return badParam(ctx, req, "workspaceId/draftId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const result = createAssetDraftService(ctx).getAssetDraft({ workspaceId, draftId });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

export function handleOrchAssetDraftsApply(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const draftId = str(req, "draftId") as AssetDraftId;
  if (!workspaceId || !draftId) return badParam(ctx, req, "workspaceId/draftId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const body = (req.body as any) ?? {};
    const result = createAssetDraftService(ctx).applyAssetDraft({
      workspaceId,
      draftId,
      expectedJobId: nullableString(body?.expectedJobId) as AssetGenerationJobId | null,
      expectedBaseVersionId: nullableString(body?.expectedBaseVersionId),
      forceApplyWarnings: body?.forceApplyWarnings === true,
      review: body?.review ?? null,
    });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

export function handleOrchAssetDraftsReject(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const draftId = str(req, "draftId") as AssetDraftId;
  if (!workspaceId || !draftId) return badParam(ctx, req, "workspaceId/draftId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  try {
    const body = (req.body as any) ?? {};
    const result = createAssetDraftService(ctx).rejectDraft({
      workspaceId,
      draftId,
      reason: nullableString(body?.reason),
      review: body?.review ?? null,
    });
    ok(ctx, req, result);
  } catch (error) {
    sendAssetDraftError(ctx, req, error);
  }
}

// ── Workflows ────────────────────────────────────────────────────

export function handleOrchWorkflowsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const workflows = ctx.db.orchWorkflows.listByWorkspace(workspaceId);
  ok(ctx, req, { workflows });
}

/** 新增或更新流程模板，并阻止未授权覆盖内置流程。 */
export function handleOrchWorkflowsUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const workflowInput = (req.body as any)?.workflow;
  if (!workflowInput || typeof workflowInput !== "object") return badParam(ctx, req, "workflow");
  const existing = workflowInput.id ? ctx.db.orchWorkflows.get(workflowInput.id as WorkflowId) : null;
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的工作流" } });
    return;
  }
  if (rejectBuiltinAssetUpsert(ctx, req, existing, workflowInput.kind, "内置流程模板")) return;

  const workflow = ctx.db.orchWorkflows.upsert({ ...workflowInput, workspaceId });
  ok(ctx, req, { workflow });
}

export function handleOrchWorkflowsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const workflowId = str(req, "workflowId") as WorkflowId;
  if (!workspaceId || !workflowId) return badParam(ctx, req, "workspaceId/workflowId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = ctx.db.orchWorkflows.get(workflowId);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的工作流" } });
    return;
  }
  if (rejectBuiltinAssetDelete(ctx, req, existing, "内置流程模板")) return;
  const cardRemoval = ctx.db.db.transaction(() => {
    ctx.db.orchWorkflows.delete(workflowId);
    ctx.db.orchAssetGroups.deleteAssignment(workspaceId, "workflow", workflowId);
    // 流程资产被删后引用它的会话卡片已无法启动，同事务删除；执行实例本身不删，编排侧仍可查看。
    return new ChatWorkflowRepo(ctx.db.db).deleteByWorkflowIds(workspaceId, [workflowId]);
  })();
  logger.info("orchestration", "chat workflow cards removed with workflow asset", {
    code: "ORCH_CHAT_WORKFLOW_CARD_REMOVED", requestId: req.id, workspaceId, workflowId,
    taskIds: cardRemoval.taskIds, removedCount: cardRemoval.taskIds.length,
    skippedInvalidJsonCount: cardRemoval.skippedInvalidJsonCount,
  });
  ok(ctx, req, {});
}

export function handleOrchAssigneeTemplatesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const workflowId = nullableString((req.body as any)?.workflowId) as WorkflowId | null;
  ok(ctx, req, { templates: ctx.db.orchAssigneeTemplates.listByWorkspace(workspaceId, workflowId) });
}

export function handleOrchAssigneeTemplatesUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const parsed = parseAssigneeTemplateInput(ctx, req, workspaceId);
  if (!parsed) return;
  const template = ctx.db.orchAssigneeTemplates.upsert(parsed);
  ok(ctx, req, { template });
}

export function handleOrchAssigneeTemplatesDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const templateId = str(req, "templateId");
  if (!workspaceId || !templateId) return badParam(ctx, req, "workspaceId/templateId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = ctx.db.orchAssigneeTemplates.get(templateId);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的处理人模板" } });
    return;
  }
  ctx.db.orchAssigneeTemplates.delete(templateId);
  ok(ctx, req, {});
}

/**
 * 读取某流程在本工作区的执行默认值；未配置时返回 null。
 * 这是工作区级偏好，不读流程定义本体，因此内置流程同样可读。
 */
export function handleOrchWorkflowExecutionDefaultsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const workflowId = str(req, "workflowId") as WorkflowId;
  if (!workflowId) return badParam(ctx, req, "workflowId");

  ok(ctx, req, { executionDefault: ctx.db.orchWorkflowExecutionDefaults.get(workspaceId, workflowId) });
}

/**
 * 保存流程执行默认值：引擎与模型强制覆盖该流程内所有角色。
 * 只允许本工作区已存在的流程；模型必须仍在当前目录，否则显式失败。
 */
export function handleOrchWorkflowExecutionDefaultsUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const workflowId = str(req, "workflowId") as WorkflowId;
  if (!workflowId) return badParam(ctx, req, "workflowId");

  // 与启动路径用同一份权威读取：内置流程只存在于 Server 资产缓存，不能只查本地 legacy 表。
  const session = requireOrchAssetRuntimeReadSession(ctx, workspaceId, { assetType: "workflow", assetId: workflowId });
  if (!session.getAsset("workflow", workflowId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "流程不存在或不属于当前工作区" } });
    return;
  }

  const engine = str(req, "engine");
  if (engine !== "claude" && engine !== "codex") return badParam(ctx, req, "engine");
  const model = str(req, "model");
  if (!model) return badParam(ctx, req, "model");
  try {
    assertRuntimeEngineModelAvailable(engine, model);
  } catch (error) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }

  const executionDefault = ctx.db.orchWorkflowExecutionDefaults.upsert({
    workspaceId,
    workflowId,
    engine,
    model,
    updatedByUserId: nullableString((req.body as any)?.updatedByUserId),
  });
  ok(ctx, req, { executionDefault });
}

/** 清除流程执行默认值，恢复为角色自身配置；不存在时按成功处理。 */
export function handleOrchWorkflowExecutionDefaultsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const workflowId = str(req, "workflowId") as WorkflowId;
  if (!workflowId) return badParam(ctx, req, "workflowId");

  ctx.db.orchWorkflowExecutionDefaults.delete(workspaceId, workflowId);
  ok(ctx, req, {});
}

// ── Proposals ────────────────────────────────────────────────────

export function handleOrchToolsetsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const toolsets = ctx.db.orchToolsets.listByWorkspace(workspaceId);
  ok(ctx, req, { toolsets });
}

/** 新增或更新工具集，并阻止未授权覆盖内置工具集。 */
export function handleOrchToolsetsUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const toolsetInput = (req.body as any)?.toolset;
  if (!toolsetInput || typeof toolsetInput !== "object") return badParam(ctx, req, "toolset");
  const existing = toolsetInput.id ? ctx.db.orchToolsets.get(toolsetInput.id as ToolsetId) : null;
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的工具集" } });
    return;
  }
  if (rejectBuiltinAssetUpsert(ctx, req, existing, toolsetInput.kind, "内置工具集")) return;

  const toolset = ctx.db.orchToolsets.upsert({ ...toolsetInput, workspaceId } as Omit<ToolsetDefinition, "createdAt" | "updatedAt">);
  ok(ctx, req, { toolset });
}

export function handleOrchToolsetsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const toolsetId = str(req, "toolsetId") as ToolsetId;
  if (!workspaceId || !toolsetId) return badParam(ctx, req, "workspaceId/toolsetId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = ctx.db.orchToolsets.get(toolsetId);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的工具集" } });
    return;
  }
  if (rejectBuiltinAssetDelete(ctx, req, existing, "内置工具集")) return;

  ctx.db.db.transaction(() => {
    ctx.db.orchToolsets.delete(toolsetId);
    ctx.db.orchAssetGroups.deleteAssignment(workspaceId, "toolset", toolsetId);
  })();
  ok(ctx, req, {});
}

/** 列出当前工作区的平台自定义 Skills。 */
export function handleOrchSkillsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const skills = ctx.db.orchSkills.listByWorkspace(workspaceId);
  ok(ctx, req, { skills });
}

/** 新增或更新平台 Skill，保存前强制绑定 workspace 并保护内置定义。 */
export function handleOrchSkillsUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const skillInput = (req.body as any)?.skill;
  if (!skillInput || typeof skillInput !== "object") return badParam(ctx, req, "skill");
  const existing = skillInput.id ? ctx.db.orchSkills.get(skillInput.id as SkillId) : null;
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的 Skill" } });
    return;
  }
  if (rejectBuiltinAssetUpsert(ctx, req, existing, skillInput.kind, "内置 Skill")) return;

  try {
    const skill = ctx.db.orchSkills.upsert({
      ...skillInput,
      workspaceId,
    } as Omit<SkillDefinition, "createdAt" | "updatedAt">);
    ok(ctx, req, { skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

/** 删除平台自定义 Skill；内置 Skill 不允许删除。 */
export function handleOrchSkillsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const skillId = str(req, "skillId") as SkillId;
  if (!workspaceId || !skillId) return badParam(ctx, req, "workspaceId/skillId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = ctx.db.orchSkills.get(skillId);
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的 Skill" } });
    return;
  }
  if (rejectBuiltinAssetDelete(ctx, req, existing, "内置 Skill")) return;

  ctx.db.db.transaction(() => {
    ctx.db.orchSkills.delete(skillId);
    ctx.db.orchAssetGroups.deleteAssignment(workspaceId, "skill", skillId);
  })();
  ok(ctx, req, {});
}

/** 查询 Skill 包在 Codex/Claude 目录中的安装状态。 */
export function handleOrchSkillsInstallStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const resolved = resolveSkillPackageAction(ctx, req);
  if (!resolved) return;
  ok(ctx, req, { status: getSkillPackageInstallStatus(resolved.workspacePath, resolved.skill) });
}

/** 将 Skill 包安装到 Codex/Claude 目标目录。 */
export async function handleOrchSkillsInstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const resolved = await withAssetDraftDatabase(ctx, req.id, () => resolveSkillPackageAction(ctx, req));
  if (!resolved) return;
  const targets = normalizeSkillPackageTargets((req.body as any)?.targets, resolved.skill);
  if (!targets.length) return badParam(ctx, req, "targets");
  const results = await installSkillPackage({
    workspacePath: resolved.workspacePath,
    skill: resolved.skill,
    targets,
  });
  ok(ctx, req, {
    results,
    status: getSkillPackageInstallStatus(resolved.workspacePath, resolved.skill),
  });
}

/** 从 Codex/Claude 目标目录卸载 Skill 包。 */
export async function handleOrchSkillsUninstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const resolved = await withAssetDraftDatabase(ctx, req.id, () => resolveSkillPackageAction(ctx, req));
  if (!resolved) return;
  const targets = normalizeSkillPackageTargets((req.body as any)?.targets, resolved.skill);
  if (!targets.length) return badParam(ctx, req, "targets");
  const results = await uninstallSkillPackage({
    workspacePath: resolved.workspacePath,
    skill: resolved.skill,
    targets,
  });
  ok(ctx, req, {
    results,
    status: getSkillPackageInstallStatus(resolved.workspacePath, resolved.skill),
  });
}

export function handleOrchKnowledgeBundlesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const bundles = ctx.db.orchKnowledgeBundles.listByWorkspace(workspaceId);
  ok(ctx, req, { bundles });
}

/** 新增或更新知识库，并阻止未授权覆盖内置知识库。 */
export function handleOrchKnowledgeBundlesUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const bundleInput = (req.body as any)?.bundle;
  if (!bundleInput || typeof bundleInput !== "object") return badParam(ctx, req, "bundle");
  const existing = bundleInput.id ? ctx.db.orchKnowledgeBundles.get(bundleInput.id as KnowledgeBundleId) : null;
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权修改其他工作区的知识库" } });
    return;
  }
  if (rejectBuiltinAssetUpsert(ctx, req, existing, bundleInput.kind, "内置知识库")) return;

  const bundle = ctx.db.orchKnowledgeBundles.upsert({
    ...bundleInput,
    workspaceId,
  } as Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">);
  ok(ctx, req, { bundle });
}

export async function handleOrchKnowledgeBundlesDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const bundleId = str(req, "bundleId") as KnowledgeBundleId;
  if (!workspaceId || !bundleId) return badParam(ctx, req, "workspaceId/bundleId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const existing = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchKnowledgeBundles.get(bundleId));
  if (existing && existing.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权删除其他工作区的知识库" } });
    return;
  }
  // 内置资产通常不可删；Server 内置包中已不存在的孤儿内置知识库允许删除，用于清理历史残留。
  if (existing?.kind === "builtin" && !(await isOrphanBuiltinKnowledgeBundle(ctx, workspaceId, bundleId))) {
    rejectBuiltinAssetDelete(ctx, req, existing, "内置知识库");
    return;
  }

  await withAssetDraftDatabase(ctx, req.id, () => ctx.db.db.transaction(() => {
    ctx.db.orchKnowledgeBundles.delete(bundleId);
    ctx.db.orchAssetGroups.deleteAssignment(workspaceId, "knowledge", bundleId);
  })());
  ok(ctx, req, {});
}

/** 判断内置知识库是否已不在 Server 内置资产包中（孤儿），孤儿允许删除。 */
async function isOrphanBuiltinKnowledgeBundle(
  ctx: Pick<ApiHandlerContext, "loadServerDefaultBundles" | "db" | "withDatabase">,
  workspaceId: WorkspaceId,
  bundleId: string,
): Promise<boolean> {
  if (!ctx.loadServerDefaultBundles) throw new Error("本地内置资产包读取服务未装配");
  const bundles = [...(await ctx.loadServerDefaultBundles())];
  const activeIds = await withAssetDraftDatabase(ctx, `builtin-knowledge:${bundleId}`, () => buildActiveServerDefaultAssetIds({ db: ctx.db, workspaceId, bundles }));
  return !activeIds.knowledgeBundles.has(String(bundleId));
}

// ── Proposals ────────────────────────────────────────────────────

/** 列出执行提案；共享路由可传 allowedResourceIds 在 Host 侧收窄可见需求。 */
export function handleOrchProposalsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  const allowedResourceIds = normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds);
  if ((req.body as any)?.summaryOnly === true) {
    const limit = Number((req.body as any)?.limit ?? 200);
    const cursor = String((req.body as any)?.cursor ?? "");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || cursor.length > 1_000) return badParam(ctx, req, "limit/cursor");
    if (cursor) {
      let parsed: unknown;
      try { parsed = JSON.parse(cursor); } catch { return badParam(ctx, req, "cursor"); }
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0
        || typeof parsed[1] !== "string" || !parsed[1]) return badParam(ctx, req, "cursor");
    }
    const readPage = () => {
      const allowedProposalIds = ctx.localWorkspaceOnly === true
        ? ctx.db.orchProposals.listByWorkspace(workspaceId, { strictScope: true })
          .filter((proposal) => isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, proposal)).map((proposal) => proposal.id) : undefined;
      return ctx.db.orchProposals.listSummaryPage(workspaceId, { limit, cursor, allowedResourceIds, allowedProposalIds });
    };
    ok(ctx, req, ctx.localWorkspaceOnly === true ? ctx.db.db.transaction(readPage)() : readPage());
    return;
  }
  const allowedSet = allowedResourceIds ? new Set(allowedResourceIds) : null;
  const proposals = ctx.db.orchProposals
    .listByWorkspace(workspaceId, { strictScope: ctx.localWorkspaceOnly === true })
    .filter((proposal) => (!allowedSet || allowedSet.has(String(proposal.intakeId)))
      && (ctx.localWorkspaceOnly !== true || isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, proposal)));
  ok(ctx, req, { proposals });
}

export function handleOrchProposalsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const proposalId = str(req, "proposalId") as ProposalId;
  if (!workspaceId || !proposalId) return badParam(ctx, req, "workspaceId/proposalId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const proposal = readScopedOrchestrationProposal(ctx, proposalId);
  if (!proposal || proposal.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排提案不存在：${proposalId}` } });
    return;
  }
  ok(ctx, req, { proposal });
}

/** 手工提案继承需求归属；内联需求只采可信入口，范围冲突先于提案替换。 */
export function handleOrchProposalsCreate(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const workflowId = str(req, "workflowId") as WorkflowId;
  const roleId = str(req, "roleId") as RoleId;
  const intakeId = str(req, "intakeId") as IntakeId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if ((workflowId ? 1 : 0) + (roleId ? 1 : 0) !== 1) return badParam(ctx, req, "workflowId/roleId");

  const intakeInput = (req.body as any)?.intake;
  if (!intakeId && (!intakeInput || typeof intakeInput !== "object")) return badParam(ctx, req, "intake/intakeId");
  const assetSession = requireOrchAssetRuntimeReadSession(ctx, workspaceId, workflowId
    ? { assetType: "workflow", assetId: workflowId } : { assetType: "role", assetId: roleId });
  const getRole = createSessionRoleReader(assetSession);
  let selectedWorkflow: WorkflowRuntimeDefinition | null = null;
  let selectedRole: RuntimeRoleDefinition | null = null;
  if (workflowId) {
    selectedWorkflow = assetSession.getAsset("workflow", workflowId)?.definition ?? null;
    if (!selectedWorkflow) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工作流不存在：${workflowId}` } });
      return;
    }
    const missingRoleId = selectedWorkflow.nodes
      .filter((node) => node.type === "role" && node.roleId)
      .map((node) => node.roleId as RoleId)
      .find((nodeRoleId) => !getRole(nodeRoleId));
    if (missingRoleId) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: `工作流引用的角色不存在：${missingRoleId}` } });
      return;
    }
  } else {
    selectedRole = assetSession.getAsset("role", roleId)?.definition ?? null;
    if (!selectedRole) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `角色不存在：${roleId}` } });
      return;
    }
  }

  let intake: TaskIntake | null = null;
  if (intakeId) {
    const existingIntake = ctx.db.orchIntakes.get(intakeId);
    if (existingIntake && !isScopedOrchestrationIntake(ctx, existingIntake)) return hiddenOrchestrationResource(ctx, req);
    if (!existingIntake || existingIntake.workspaceId !== workspaceId) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `需求不存在：${intakeId}` } });
      return;
    }
    const existingScope = existingIntake.workspaceScope;
    const requestScope = ctx.intakeWorkspaceScope;
    if (existingScope && requestScope && (existingScope.scopeType !== requestScope.scopeType || existingScope.scopeId !== requestScope.scopeId)) {
      logger.warn("orch-api", "proposal creation rejected for mismatched intake scope", {
        errorCode: "ORCH_INTAKE_SCOPE_CONFLICT", requestId: req.id, clientId: ctx.clientId, workspaceId, intakeId,
        expectedScope: existingScope, requestScope, rootCause: "trusted request scope differs from persisted intake scope",
      });
      ctx.onApiFailureLogged?.();
      ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, code: "FORBIDDEN", message: "需求归属与当前工作区不一致" } });
      return;
    }
    intake = existingIntake;
  } else {
    const executionPlanResult = parseTaskIntakeExecutionPlanForSave(intakeInput?.executionPlan);
    if (!executionPlanResult.ok) {
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: executionPlanResult.message } });
      return;
    }
    const metricEvidenceResult = parseTaskIntakeMetricEvidenceRefs(intakeInput?.metricEvidenceRefs);
    if (!metricEvidenceResult.ok) {
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: metricEvidenceResult.message } });
      return;
    }
    intake = ctx.db.orchIntakes.create({
      workspaceId,
      workspaceScope: ctx.intakeWorkspaceScope ?? null,
      triggerMode: normalizeTriggerMode(intakeInput?.triggerMode),
      taskType: inferTaskTypeFromInput(intakeInput?.taskType, intakeInput?.goal),
      title: normalizeTaskIntakeTitle(intakeInput?.title, intakeInput?.goal),
      goal: String(intakeInput?.goal ?? "").trim(),
      background: nullableString(intakeInput?.background),
      acceptanceCriteria: normalizeTaskAcceptanceCriteria(intakeInput?.acceptanceCriteria),
      workbenchItemRefs: normalizeStringArray(intakeInput?.workbenchItemRefs),
      seedArtifactRefs: normalizeStringArray(intakeInput?.seedArtifactRefs) as ArtifactId[] | null,
      metricEvidenceRefs: metricEvidenceResult.refs,
      constraints: normalizeConstraints(intakeInput?.constraints),
      executionPlan: executionPlanResult.executionPlan,
      requester: normalizeRequester(intakeInput?.requester),
    });
  }

  if (!selectedWorkflow && !selectedRole) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "必须选择一个流程或角色" } });
    return;
  }

  const activeInstance = findActiveInstanceByIntake(ctx, workspaceId, intake.id);
  if (activeInstance) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: ctx.localWorkspaceOnly === true && !isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, activeInstance)
          ? "当前需求已有进行中的执行，请先结束当前执行。" : `当前需求已有进行中的执行：${activeInstance.id}。请先进入执行页查看或结束当前执行，再重新执行。`,
      },
    });
    return;
  }

  supersedeExistingProposalsForIntake(ctx, workspaceId, intake.id);
  const proposal = selectedWorkflow
    ? createProposalFromIntake(ctx, intake, selectedWorkflow, getRole)
    : createProposalFromRole(ctx, intake, selectedRole!, getRole);
  ok(ctx, req, { proposal, intakeId: intake.id });
}

export function handleOrchProposalsConfirm(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const proposalId = str(req, "proposalId") as ProposalId;
  if (!workspaceId || !proposalId) return badParam(ctx, req, "workspaceId/proposalId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const proposal = readScopedOrchestrationProposal(ctx, proposalId);
  if (!proposal || proposal.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排提案不存在：${proposalId}` } });
    return;
  }

  const confirmed = ctx.db.orchProposals.confirm(proposalId);
  if (!confirmed) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: "提案确认失败" } });
    return;
  }
  ok(ctx, req, { proposal: confirmed });
}

// ── Instances ────────────────────────────────────────────────────

/** 具体实例归属与需求权限先于 SQL 分页和统计相交。 */
export function handleOrchInstancesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const readPage = () => ctx.db.orchInstances.listSummariesByWorkspace({
    workspaceId,
    allowedInstanceIds: ctx.localWorkspaceOnly === true
      ? ctx.db.orchInstances.listByWorkspace(workspaceId, { strictScope: true })
        .filter((instance) => isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, instance)).map((instance) => instance.id) : undefined,
    limit: parsePositiveInt((req.body as any)?.limit, 50, 200),
    allowedResourceIds: normalizeAllowedResourceIds((req.body as any)?.allowedResourceIds),
    sourceKind: normalizeTaskIntakeSourceKind((req.body as any)?.sourceKind),
  });
  const result = ctx.localWorkspaceOnly === true ? ctx.db.db.transaction(readPage)() : readPage();
  // 流程名与活跃节点名按当前工作流定义展示；执行仍使用实例冻结快照。
  const resolver = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, req.id);
  ok(ctx, req, {
    instances: result.instances.map((summary) => relabelInstanceSummary(summary, resolver.resolve(workspaceId, summary.workflowId))),
    hasMore: result.hasMore,
    nextCursor: null,
    totalCountByIntake: result.totalCountByIntake,
  });
}

export function handleOrchInstancesGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  // 监控图、节点详情与产物分组名按当前工作流定义展示；执行仍使用实例冻结快照。
  const labels = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, req.id).resolve(workspaceId, instance.workflowId);
  ok(ctx, req, { instance: labels ? { ...instance, workflowSnapshot: relabelWorkflowDefinition(instance.workflowSnapshot, labels) } : instance });
}

/** 返回实例运行态轻量补丁，供 Web 监控兜底刷新使用。 */
export function handleOrchInstancesRuntimePatch(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  if (ctx.localWorkspaceOnly === true && !readScopedOrchestrationInstance(ctx, instanceId)) return hiddenOrchestrationResource(ctx, req);
  const patch = ctx.db.orchInstances.getRuntimePatch(instanceId);
  if (!patch || patch.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  // 流程身份随补丁下发，展示名按当前定义解析；未装配读取服务时保持冻结快照摘要。
  const labels = patch.workflowId
    ? new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, req.id).resolve(workspaceId, patch.workflowId)
    : null;
  ok(ctx, req, { patch: labels ? { ...patch, runSummary: relabelRunSummary(patch.runSummary, labels) } : patch });
}

/** 转派实例节点处理人；只更新实例运行态快照，不反写流程模板。 */
export function handleOrchInstancesReassignNode(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  if (!workspaceId || !instanceId || !nodeId) return badParam(ctx, req, "workspaceId/instanceId/nodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  const node = instance.workflowSnapshot.nodes.find((item) => item.id === nodeId) ?? null;
  const nodeState = instance.nodeStates[nodeId] ?? null;
  if (!node || !nodeState) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }
  if (node.type !== "role") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "只有角色节点可以转派处理人" } });
    return;
  }
  const assigneeUserIds = normalizeOrchestrationRunPlanAssigneeList((req.body as any)?.assigneeUserIds);
  if (assigneeUserIds.length === 0) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "转派节点必须至少选择一个处理人" } });
    return;
  }

  const nodeStates = {
    ...instance.nodeStates,
    [nodeId]: {
      ...nodeState,
      assigneeUserIds,
    },
  };
  ctx.db.orchInstances.updateNodeStates(instanceId, nodeStates);
  ctx.db.orchEvents.append({
    instanceId,
    nodeId,
    type: "orchestration.nodeAssigneesReassigned",
    payloadJson: JSON.stringify({
      instanceId,
      nodeId,
      nodeLabel: node.label,
      assigneeUserIds,
    }),
  });
  const updated = readScopedOrchestrationInstance(ctx, instanceId) ?? { ...instance, nodeStates };
  // 与实例详情保持同一展示口径，避免转派后监控图短暂回落成冻结旧名。
  const labels = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, req.id).resolve(workspaceId, updated.workflowId);
  ok(ctx, req, { instance: labels ? { ...updated, workflowSnapshot: relabelWorkflowDefinition(updated.workflowSnapshot, labels) } : updated });
}

/** 列出实例产物；轻量模式不读取 content_json。 */
export function handleOrchArtifactsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstanceAccess(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  const artifacts = (req.body as any)?.includeContent === false
    ? ctx.db.orchArtifacts.listSummariesByInstance(instanceId)
    : ctx.db.orchArtifacts.listByInstance(instanceId);
  ok(ctx, req, { artifacts });
}

/** 按 ID 返回完整产物，并用实例归属投影校验工作区。 */
export function handleOrchArtifactGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const artifactId = str(req, "artifactId") as ArtifactId;
  if (!workspaceId || !artifactId) return badParam(ctx, req, "workspaceId/artifactId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const artifact = ctx.db.orchArtifacts.get(artifactId);
  if (!artifact) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工件不存在：${artifactId}` } });
    return;
  }
  const instance = readScopedOrchestrationInstanceAccess(ctx, artifact.instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工件不存在：${artifactId}` } });
    return;
  }
  ok(ctx, req, { artifact });
}

/** 返回产物文件和字段索引，权限校验不读取产物正文。 */
export function handleOrchArtifactFilesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const artifactId = str(req, "artifactId") as ArtifactId;
  if (!workspaceId || !artifactId) return badParam(ctx, req, "workspaceId/artifactId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const artifact = ctx.db.orchArtifacts.getAccessProjection(artifactId);
  if (!artifact) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工件不存在：${artifactId}` } });
    return;
  }
  const instance = readScopedOrchestrationInstanceAccess(ctx, artifact.instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工件不存在：${artifactId}` } });
    return;
  }
  const files = ctx.db.orchArtifactFiles.listByArtifact(artifact.id);
  const fields = ctx.db.orchArtifactFields.listByArtifact(artifact.id);
  ok(ctx, req, { files, fields });
}

export async function handleOrchArtifactRevise(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  const artifactId = str(req, "artifactId") as ArtifactId;
  const note = nullableString((req.body as any)?.note);
  if (!workspaceId || !instanceId || !nodeId || !artifactId) {
    return badParam(ctx, req, "workspaceId/instanceId/nodeId/artifactId");
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) return notFoundWs(ctx, req, workspaceId);

  let answer: NodeExecutionEnvelope;
  let workspaceFiles: Array<{ path: string; content: string }>;
  try {
    answer = normalizeArtifactRevisionAnswer((req.body as any)?.answer);
    workspaceFiles = normalizeArtifactRevisionWorkspaceFiles((req.body as any)?.workspaceFiles);
    validateArtifactRevisionWorkspaceFiles(answer, workspaceFiles);
  } catch (error) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: error instanceof Error ? error.message : "人工修订参数错误" },
    });
    return;
  }

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  const nodeState = instance.nodeStates[nodeId];
  if (!nodeState) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }

  const artifact = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchArtifacts.get(artifactId));
  if (!artifact || artifact.instanceId !== instanceId || artifact.nodeId !== nodeId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `工件不存在：${artifactId}` } });
    return;
  }

  try {
    await ctx.orchEngine.ensureAssetRuntimeSnapshotForExecution(instanceId);
    const resolvedWorkspaceFiles = hydrateArtifactRevisionWorkspaceFiles(answer, workspaceFiles, artifact);
    writeArtifactRevisionWorkspaceFiles(workspaceId, workspacePath, ctx.workspacePathIndex, resolvedWorkspaceFiles);
    const revised = await withAssetDraftDatabase(ctx, req.id, () => ctx.orchEngine.reviseArtifact(instanceId, nodeId, artifactId, {
      note,
      answer,
    }));
    const files = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchArtifactFiles.listByArtifact(revised.id));
    const fields = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchArtifactFields.listByArtifact(revised.id));
    ok(ctx, req, { artifact: revised, files, fields });
  } catch (error) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: error instanceof Error ? error.message : "人工修订工件失败" },
    });
  }
}

export function handleOrchEventsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const limit = parseOptionalPositiveInt((req.body as any)?.limit, 500);
  const includePayload = (req.body as any)?.includePayload !== false;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  const events = ctx.db.orchEvents.listByInstance(instanceId, { limit, includePayload });
  ok(ctx, req, { events });
}

/** 分页读取指定节点的工作项和轻量进度。 */
export function handleOrchNodeWorkItemsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const resolved = resolveNodeWorkItemReadScope(ctx, req);
  if (!resolved) return;
  try {
    ok(ctx, req, ctx.db.orchNodeWorkItems.list({
      instanceId: resolved.instanceId,
      nodeId: resolved.nodeId,
      search: nullableString((req.body as any)?.search),
      statuses: normalizeNodeWorkItemStatuses((req.body as any)?.statuses),
      includeDeleted: (req.body as any)?.includeDeleted === true,
      limit: parseOptionalPositiveInt((req.body as any)?.limit, 500) ?? undefined,
      cursor: nullableString((req.body as any)?.cursor),
    }));
  } catch (error) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** 倒序分页读取指定节点或工作项的追加审计事件。 */
export function handleOrchNodeWorkItemEventsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const resolved = resolveNodeWorkItemReadScope(ctx, req);
  if (!resolved) return;
  try {
    ok(ctx, req, ctx.db.orchNodeWorkItems.listEvents({
      instanceId: resolved.instanceId,
      nodeId: resolved.nodeId,
      itemId: nullableString((req.body as any)?.itemId),
      limit: parseOptionalPositiveInt((req.body as any)?.limit, 500) ?? undefined,
      cursor: nullableString((req.body as any)?.cursor),
    }));
  } catch (error) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** 校验工作项只读请求属于当前工作区、实例和真实节点。 */
function resolveNodeWorkItemReadScope(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
): { instanceId: OrchestrationId; nodeId: string } | null {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  if (!workspaceId || !instanceId || !nodeId) {
    badParam(ctx, req, "workspaceId/instanceId/nodeId");
    return null;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    notFoundWs(ctx, req, workspaceId);
    return null;
  }
  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return null;
  }
  if (!instance.nodeStates[nodeId] || !instance.workflowSnapshot.nodes.some((node) => node.id === nodeId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return null;
  }
  return { instanceId, nodeId };
}

/** 规范化工作项状态筛选并拒绝未知值。 */
function normalizeNodeWorkItemStatuses(value: unknown): NodeWorkItemStatus[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("statuses 必须是数组");
  const statuses = value.map((item) => String(item ?? "").trim());
  const invalid = statuses.find((status) => status !== "pending" && status !== "in_progress" && status !== "completed");
  if (invalid) throw new Error(`未知工作项状态：${invalid}`);
  return Array.from(new Set(statuses)) as NodeWorkItemStatus[];
}

export function handleOrchPromptSnapshotsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = nullableString((req.body as any)?.nodeId);
  const limit = parseOptionalPositiveInt((req.body as any)?.limit, 500);
  const includeContent = (req.body as any)?.includeContent === true;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  const snapshots = nodeId
    ? ctx.db.orchPromptSnapshots.listByNode(instanceId, nodeId, { limit, includeContent })
    : ctx.db.orchPromptSnapshots.listByInstance(instanceId, { limit, includeContent });
  ok(ctx, req, { snapshots });
}

export function handleOrchPromptSnapshotGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const promptSnapshotId = str(req, "promptSnapshotId");
  if (!workspaceId || !promptSnapshotId) return badParam(ctx, req, "workspaceId/promptSnapshotId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const snapshot = ctx.db.orchPromptSnapshots.get(promptSnapshotId);
  if (!snapshot) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `提示快照不存在：${promptSnapshotId}` } });
    return;
  }
  const instance = readScopedOrchestrationInstance(ctx, snapshot.instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `提示快照不存在：${promptSnapshotId}` } });
    return;
  }
  ok(ctx, req, { snapshot });
}

/** 汇总实例、节点或执行轮次的 Prompt、会话和原始事件定位引用。 */
export function handleOrchRuntimeEvidenceGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = nullableString((req.body as any)?.nodeId);
  const rawPromptSnapshotId = (req.body as any)?.promptSnapshotId;
  if (rawPromptSnapshotId != null && typeof rawPromptSnapshotId !== "string") return badParam(ctx, req, "promptSnapshotId");
  const promptSnapshotId = nullableString(rawPromptSnapshotId);
  const rawAttemptNo = (req.body as any)?.attemptNo;
  const attemptNo = rawAttemptNo == null ? null : Number(rawAttemptNo);
  const rawLimit = (req.body as any)?.limit;
  const limit = rawLimit == null || String(rawLimit).trim() === "" ? 20 : Number(rawLimit);
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (attemptNo !== null && (!Number.isInteger(attemptNo) || attemptNo <= 0)) return badParam(ctx, req, "attemptNo");
  if (attemptNo !== null && !nodeId) return badParam(ctx, req, "nodeId/attemptNo");
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) return badParam(ctx, req, "limit");
  if (promptSnapshotId && promptSnapshotId.length > 200) return badParam(ctx, req, "promptSnapshotId");

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance || instance.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  if (nodeId && !instance.workflowSnapshot.nodes.some((node) => node.id === nodeId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }

  const selectedSnapshot = promptSnapshotId ? ctx.db.orchPromptSnapshots.get(promptSnapshotId) : null;
  if (promptSnapshotId && (!selectedSnapshot || selectedSnapshot.instanceId !== instanceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `提示快照不存在：${promptSnapshotId}` } });
    return;
  }
  if (selectedSnapshot && ((nodeId && selectedSnapshot.nodeId !== nodeId) || (attemptNo !== null && selectedSnapshot.attemptNo !== attemptNo))) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: `提示快照与请求执行范围不一致：${promptSnapshotId}` } });
    return;
  }
  const promptSnapshotTotal = selectedSnapshot ? 1 : countRuntimeEvidencePromptSnapshots(ctx, instanceId, nodeId, attemptNo);
  const snapshots = selectedSnapshot ? [selectedSnapshot] : (attemptNo !== null
    ? ctx.db.orchPromptSnapshots.listByNode(instanceId, nodeId!, { includeContent: false, attemptNo })
    : nodeId
      ? ctx.db.orchPromptSnapshots.listByNode(instanceId, nodeId, { limit: 500, includeContent: false })
      : ctx.db.orchPromptSnapshots.listByInstance(instanceId, { limit: 500, includeContent: false }));
  const threadSources = new Map<string, Set<"master" | "node" | "prompt_snapshot">>();
  const threadTurnIds = new Map<string, Set<string>>();
  const unresolvedScopeRefs: string[] = [];
  const addThread = (threadId: unknown, source: "master" | "node" | "prompt_snapshot") => {
    const id = String(threadId ?? "").trim();
    if (!id) return;
    const sources = threadSources.get(id) ?? new Set();
    sources.add(source);
    threadSources.set(id, sources);
  };

  const exactTurnScope = attemptNo !== null || selectedSnapshot !== null;
  if (!exactTurnScope) {
    if (!nodeId) addThread(instance.masterThreadId, "master");
    const scopedStates = nodeId
      ? [instance.nodeStates[nodeId]].filter(Boolean)
      : Object.values(instance.nodeStates);
    for (const state of scopedStates) {
      addThread(state?.threadId, "node");
      for (const previousThreadId of state?.previousThreadIds ?? []) addThread(previousThreadId, "node");
    }
  }
  for (const snapshot of snapshots) {
    const threadId = String(snapshot.threadId ?? "").trim();
    const turnId = String(snapshot.turnId ?? "").trim();
    if (!threadId || (exactTurnScope && !turnId)) {
      if (exactTurnScope) unresolvedScopeRefs.push(`promptSnapshot:${snapshot.id}`);
      continue;
    }
    addThread(threadId, "prompt_snapshot");
    if (exactTurnScope) {
      const turnIds = threadTurnIds.get(threadId) ?? new Set<string>();
      turnIds.add(turnId);
      threadTurnIds.set(threadId, turnIds);
    }
  }

  const threads = [...threadSources.entries()].map(([threadId, sources]) => buildRuntimeEvidenceThread(
    ctx,
    workspaceId,
    threadId,
    [...sources],
    limit,
    exactTurnScope ? [...(threadTurnIds.get(threadId) ?? [])] : null,
    unresolvedScopeRefs,
  ));
  const traceDetail = selectedSnapshot
    ? buildRuntimeEvidenceTraceDetail(ctx, workspaceId, selectedSnapshot, limit, unresolvedScopeRefs)
    : null;
  const scopeStatus = exactTurnScope && (snapshots.length === 0 || unresolvedScopeRefs.length > 0)
    ? "incomplete"
    : "available";
  const conversationEventCount = threads.reduce((sum, thread) => sum + thread.conversationEventCount, 0);
  const rawEngineEventCount = threads.reduce((sum, thread) => sum + thread.rawEngineEventCount, 0);
  const hasRawTraceGap = threads.some((thread) => thread.conversationEventCount > 0 && thread.rawEngineEventCount === 0);
  // 节点级查询才给耗时分解：回答「这个节点为什么慢」，因此按节点的全部尝试线程聚合。
  const runtimeBreakdown = nodeId && !exactTurnScope
    ? computeOrchNodeRuntimeBreakdown([...threadSources.keys()].map((threadId) => (
        ctx.db.rawEvents.readThreadRuntimeFacts(threadId as ThreadId)
      )))
    : null;
  const response: OrchRuntimeEvidenceGetResponseBody = {
    instanceId,
    nodeId,
    attemptNo,
    scopeStatus,
    unresolvedScopeRefs: [...new Set(unresolvedScopeRefs)],
    promptSnapshotTotal,
    promptSnapshotsTruncated: promptSnapshotTotal > snapshots.length,
    promptSnapshots: snapshots.map((snapshot) => ({
      id: snapshot.id,
      nodeId: snapshot.nodeId,
      attemptNo: snapshot.attemptNo,
      threadId: snapshot.threadId ?? null,
      turnId: snapshot.turnId ?? null,
      engine: snapshot.engine,
      model: snapshot.model ?? null,
      effort: snapshot.effort ?? null,
      createdAt: snapshot.createdAt,
    })),
    traceDetail,
    threads,
    runtimeBreakdown,
    status: {
      promptSnapshot: snapshots.length > 0 ? "available" : "missing",
      conversationTrace: scopeStatus === "incomplete" ? "incomplete" : conversationEventCount > 0 ? "available" : "missing",
      rawTrace: scopeStatus === "incomplete" || hasRawTraceGap
        ? "incomplete"
        : rawEngineEventCount > 0 ? "available" : conversationEventCount > 0 ? "incomplete" : "missing",
    },
  };
  ok(ctx, req, response);
}

type RuntimeEvidenceTurnRow = {
  turnId: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  startEventSeq: number | null;
  endEventSeq: number | null;
};

/** 读取精确 Prompt 调用的完整正文，并用其 Turn 边界限制事件内容。 */
function buildRuntimeEvidenceTraceDetail(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  snapshot: NodePromptSnapshot,
  limit: number,
  unresolvedScopeRefs: string[],
): NonNullable<OrchRuntimeEvidenceGetResponseBody["traceDetail"]> {
  const threadId = String(snapshot.threadId ?? "").trim();
  const turnId = String(snapshot.turnId ?? "").trim();
  if (!threadId || !turnId) {
    return {
      promptSnapshot: snapshot,
      turn: null,
      conversationEventCount: 0,
      conversationEventsTruncated: false,
      conversationEvents: [],
      rawEngineEventCount: 0,
      rawEngineEventsTruncated: false,
      rawEngineEvents: [],
    };
  }
  const turn = readRuntimeEvidenceTurn(ctx, workspaceId, threadId, turnId);
  if (!turn) {
    unresolvedScopeRefs.push(`turn:${turnId}`);
    return {
      promptSnapshot: snapshot,
      turn: null,
      conversationEventCount: 0,
      conversationEventsTruncated: false,
      conversationEvents: [],
      rawEngineEventCount: 0,
      rawEngineEventsTruncated: false,
      rawEngineEvents: [],
    };
  }
  const conversation = readTurnScopedEventBodies<ConversationEventEnvelope>(
    ctx, "conversation_events", workspaceId, threadId, turn, limit,
  );
  const raw = readTurnScopedEventBodies<RawEngineEventEnvelope>(
    ctx, "raw_engine_events", workspaceId, threadId, turn, limit,
  );
  return {
    promptSnapshot: snapshot,
    turn: { turnId: turn.turnId, status: turn.status, startedAt: turn.startedAt, endedAt: turn.endedAt },
    conversationEventCount: conversation.count,
    conversationEventsTruncated: conversation.count > conversation.events.length,
    conversationEvents: conversation.events,
    rawEngineEventCount: raw.count,
    rawEngineEventsTruncated: raw.count > raw.events.length,
    rawEngineEvents: raw.events,
  };
}

/** 读取一个属于指定工作区和 Thread 的 Turn，缺失时返回 null。 */
function readRuntimeEvidenceTurn(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: string,
  turnId: string,
): RuntimeEvidenceTurnRow | null {
  return ctx.db.db.prepare(
    `SELECT turn_id AS turnId, status, started_at AS startedAt, ended_at AS endedAt,
            start_event_seq AS startEventSeq, end_event_seq AS endEventSeq
       FROM thread_turns
      WHERE workspace_id = ? AND thread_id = ? AND turn_id = ?`,
  ).get(workspaceId, threadId, turnId) as RuntimeEvidenceTurnRow | undefined ?? null;
}

/** 读取一个 Turn 内受限事件正文；任何持久化身份或 JSON 损坏都会显式失败。 */
function readTurnScopedEventBodies<T extends ConversationEventEnvelope | RawEngineEventEnvelope>(
  ctx: ApiHandlerContext,
  table: "conversation_events" | "raw_engine_events",
  workspaceId: WorkspaceId,
  threadId: string,
  turn: RuntimeEvidenceTurnRow,
  limit: number,
): { count: number; events: T[] } {
  const useSeq = table === "conversation_events" && turn.startEventSeq !== null;
  const lowerColumn = useSeq ? "seq" : "ts";
  const upperColumn = useSeq ? "seq" : "ts";
  const lowerValue = useSeq ? turn.startEventSeq! : turn.startedAt;
  const upperValue = useSeq ? turn.endEventSeq : turn.endedAt;
  const rangeSql = upperValue === null ? `${lowerColumn} >= ?` : `${lowerColumn} >= ? AND ${upperColumn} <= ?`;
  const params = upperValue === null
    ? [workspaceId, threadId, lowerValue]
    : [workspaceId, threadId, lowerValue, upperValue];
  const countRow = ctx.db.db.prepare(
    `SELECT COUNT(*) AS value FROM ${table} WHERE workspace_id = ? AND thread_id = ? AND ${rangeSql}`,
  ).get(...params) as { value?: number } | undefined;
  const rows = ctx.db.db.prepare(
    `SELECT seq, event_json AS eventJson FROM ${table} WHERE workspace_id = ? AND thread_id = ? AND ${rangeSql} ORDER BY seq DESC LIMIT ?`,
  ).all(...params, limit) as Array<{ seq: number; eventJson: string }>;
  const events = rows.reverse().map((row) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.eventJson ?? ""));
    } catch (error) {
      throw new Error(`运行证据事件 JSON 损坏：table=${table}, workspaceId=${workspaceId}, threadId=${threadId}, turnId=${turn.turnId}, seq=${row.seq}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`运行证据事件正文无效：table=${table}, workspaceId=${workspaceId}, threadId=${threadId}, turnId=${turn.turnId}, seq=${row.seq}`);
    }
    const envelope = parsed as Record<string, unknown>;
    if (Number(envelope.seq) !== row.seq || String(envelope.workspaceId ?? "") !== workspaceId || String(envelope.threadId ?? "") !== threadId) {
      throw new Error(`运行证据事件身份不一致：table=${table}, workspaceId=${workspaceId}, threadId=${threadId}, turnId=${turn.turnId}, seq=${row.seq}`);
    }
    return parsed as T;
  });
  return { count: Number(countRow?.value ?? 0), events };
}

/** 统计完整 Prompt Snapshot 范围，避免 500 条目录窗口被误报为完整。 */
function countRuntimeEvidencePromptSnapshots(
  ctx: ApiHandlerContext,
  instanceId: OrchestrationId,
  nodeId: string | null,
  attemptNo: number | null,
): number {
  const clauses = ["instance_id = ?"];
  const params: unknown[] = [instanceId];
  if (nodeId) {
    clauses.push("node_id = ?");
    params.push(nodeId);
  }
  if (attemptNo !== null) {
    clauses.push("attempt_no = ?");
    params.push(attemptNo);
  }
  const row = ctx.db.db.prepare(`SELECT COUNT(*) AS value FROM orch_prompt_snapshots WHERE ${clauses.join(" AND ")}`)
    .get(...params) as { value?: number } | undefined;
  return Number(row?.value ?? 0);
}

/** 按 Thread 或精确 Turn 边界构建轻量证据引用。 */
function buildRuntimeEvidenceThread(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: string,
  sources: Array<"master" | "node" | "prompt_snapshot">,
  limit: number,
  requestedTurnIds: string[] | null,
  unresolvedScopeRefs: string[],
): OrchRuntimeEvidenceGetResponseBody["threads"][number] {
  if (requestedTurnIds === null) {
    return buildThreadWideRuntimeEvidence(ctx, workspaceId, threadId, sources, limit);
  }
  const turns = requestedTurnIds.flatMap((turnId) => {
    const row = readRuntimeEvidenceTurn(ctx, workspaceId, threadId, turnId);
    if (!row) unresolvedScopeRefs.push(`turn:${turnId}`);
    return row ? [row] : [];
  });
  const conversation = collectTurnScopedEventRefs(ctx, "conversation_events", workspaceId, threadId, turns, limit);
  const raw = collectTurnScopedEventRefs(ctx, "raw_engine_events", workspaceId, threadId, turns, limit);
  return {
    threadId: threadId as ThreadId,
    sources,
    conversationEventCount: conversation.count,
    rawEngineEventCount: raw.count,
    turnCount: turns.length,
    latestConversationEvents: conversation.refs,
    latestRawEngineEvents: raw.refs,
    latestTurns: turns
      .map(({ turnId, status, startedAt, endedAt }) => ({ turnId, status, startedAt, endedAt }))
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, limit),
  };
}

/** 构建未指定 execution 时的完整 Thread 证据摘要。 */
function buildThreadWideRuntimeEvidence(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  threadId: string,
  sources: Array<"master" | "node" | "prompt_snapshot">,
  limit: number,
): OrchRuntimeEvidenceGetResponseBody["threads"][number] {
  const conversationEventCount = readRuntimeEvidenceCount(ctx, "conversation_events", workspaceId, threadId);
  const rawEngineEventCount = readRuntimeEvidenceCount(ctx, "raw_engine_events", workspaceId, threadId);
  const turnCount = readRuntimeEvidenceCount(ctx, "thread_turns", workspaceId, threadId);
  return {
    threadId: threadId as ThreadId,
    sources,
    conversationEventCount,
    rawEngineEventCount,
    turnCount,
    latestConversationEvents: readLatestRuntimeEvidenceRefs(ctx, "conversation_events", workspaceId, threadId, limit),
    latestRawEngineEvents: readLatestRuntimeEvidenceRefs(ctx, "raw_engine_events", workspaceId, threadId, limit),
    latestTurns: ctx.db.db.prepare(
      "SELECT turn_id AS turnId, status, started_at AS startedAt, ended_at AS endedAt FROM thread_turns WHERE workspace_id = ? AND thread_id = ? ORDER BY started_at DESC LIMIT ?",
    ).all(workspaceId, threadId, limit) as Array<{ turnId: string; status: string; startedAt: number; endedAt: number | null }>,
  };
}

/** 读取指定 Thread 的证据行数。 */
function readRuntimeEvidenceCount(
  ctx: ApiHandlerContext,
  table: "conversation_events" | "raw_engine_events" | "thread_turns",
  workspaceId: WorkspaceId,
  threadId: string,
): number {
  const row = ctx.db.db.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE workspace_id = ? AND thread_id = ?`)
    .get(workspaceId, threadId) as { value?: number } | undefined;
  return Number(row?.value ?? 0);
}

/** 读取完整 Thread 最近的 conversation 或 raw 事件引用。 */
function readLatestRuntimeEvidenceRefs(
  ctx: ApiHandlerContext,
  table: "conversation_events" | "raw_engine_events",
  workspaceId: WorkspaceId,
  threadId: string,
  limit: number,
): Array<{ seq: number; kind: string; occurredAt: number }> {
  const kindColumn = table === "conversation_events" ? "type" : "source";
  return ctx.db.db.prepare(
    `SELECT seq, ${kindColumn} AS kind, ts AS occurredAt FROM ${table} WHERE workspace_id = ? AND thread_id = ? ORDER BY seq DESC LIMIT ?`,
  ).all(workspaceId, threadId, limit) as Array<{ seq: number; kind: string; occurredAt: number }>;
}

/** 用 canonical seq 和 turn 时间边界收敛单次 execution 的事件引用。 */
function collectTurnScopedEventRefs(
  ctx: ApiHandlerContext,
  table: "conversation_events" | "raw_engine_events",
  workspaceId: WorkspaceId,
  threadId: string,
  turns: RuntimeEvidenceTurnRow[],
  limit: number,
): { count: number; refs: Array<{ seq: number; kind: string; occurredAt: number }> } {
  const kindColumn = table === "conversation_events" ? "type" : "source";
  let count = 0;
  const refs = new Map<number, { seq: number; kind: string; occurredAt: number }>();
  for (const turn of turns) {
    const useSeq = table === "conversation_events" && turn.startEventSeq !== null;
    const lowerColumn = useSeq ? "seq" : "ts";
    const upperColumn = useSeq ? "seq" : "ts";
    const lowerValue = useSeq ? turn.startEventSeq! : turn.startedAt;
    const upperValue = useSeq ? turn.endEventSeq : turn.endedAt;
    const rangeSql = upperValue === null ? `${lowerColumn} >= ?` : `${lowerColumn} >= ? AND ${upperColumn} <= ?`;
    const params = upperValue === null
      ? [workspaceId, threadId, lowerValue]
      : [workspaceId, threadId, lowerValue, upperValue];
    const row = ctx.db.db.prepare(
      `SELECT COUNT(*) AS value FROM ${table} WHERE workspace_id = ? AND thread_id = ? AND ${rangeSql}`,
    ).get(...params) as { value?: number } | undefined;
    count += Number(row?.value ?? 0);
    const rows = ctx.db.db.prepare(
      `SELECT seq, ${kindColumn} AS kind, ts AS occurredAt FROM ${table} WHERE workspace_id = ? AND thread_id = ? AND ${rangeSql} ORDER BY seq DESC LIMIT ?`,
    ).all(...params, limit) as Array<{ seq: number; kind: string; occurredAt: number }>;
    for (const event of rows) refs.set(event.seq, event);
  }
  return {
    count,
    refs: [...refs.values()].sort((left, right) => right.seq - left.seq).slice(0, limit),
  };
}

export type ScheduledWorkflowLaunchInput = {
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  taskName: string;
  intake?: Record<string, unknown> | null;
  /** 定时任务冻结到实例的交互策略；无人值守仍保留 ask_human 待反馈。 */
  interactionMode?: "guided" | "unattended";
};

export type ScheduledWorkflowLaunchResult = {
  instanceId: OrchestrationId;
  workflowName: string;
  workflowVersion: number;
};

/** 解析完整资产图后原子创建；本机 scope 与 actor 仅取可信上下文和真实工作区。 */
export function createScheduledWorkflowInstance(
  ctx: ApiHandlerContext,
  input: ScheduledWorkflowLaunchInput,
): ScheduledWorkflowLaunchResult {
  const workspaceId = input.workspaceId;
  if (!workspaceId || !ctx.workspaces.has(workspaceId)) throw new Error(`定时任务工作区不存在：${workspaceId}`);
  if (ctx.localWorkspaceOnly === true && (!isDesktopLocalAssetWorkspace(ctx.clientId, ctx.workspaces, workspaceId)
    || ctx.db.workspaces.get(workspaceId)?.path !== ctx.workspaces.get(workspaceId))) throw Object.assign(new Error("本机定时工作流工作区无效"), { code: "SCHEDULED_TASK_LOCAL_SCOPE_INVALID", workspaceId });
  const localActor = ctx.localWorkspaceOnly === true ? `local:${ctx.clientId}` : null;
  const assetRuntimeSnapshot = requireOrchAssetLaunchSnapshotService(ctx).createFromWorkflowId(workspaceId, input.workflowId);
  const workflow = assetRuntimeSnapshot.workflow.definition;
  const roleDefinitions = collectLaunchRoleDefinitions(assetRuntimeSnapshot);
  const executionDefault = applyWorkflowExecutionDefault({
    defaults: ctx.db.orchWorkflowExecutionDefaults,
    workspaceId,
    workflowId: workflow.id,
    workflow,
    roleDefinitions,
    requestedStrategy: normalizeOrchestrationExecutionEngineStrategy(null, "follow-role"),
    rawOverrides: null,
  });
  const executionEngineStrategy = executionDefault.strategy;
  const strategyValidationIssue = validateExecutionStrategyForWorkflow(workflow, roleDefinitions, executionEngineStrategy);
  if (strategyValidationIssue) throw new Error(strategyValidationIssue);
  const runPlanResult = parseRunPlanForStart(ctx, workspaceId, null, workflow);
  if (!runPlanResult.ok) throw new Error(runPlanResult.message);
  // 定时启动没有手工覆盖，仍然要按同一套校验确认流程级模型在当前目录可用。
  const roleExecutionOverridesResult = parseRoleExecutionOverridesForStart(
    ctx,
    executionDefault.rawOverrides,
    workflow,
    roleDefinitions,
    executionEngineStrategy,
  );
  if (!roleExecutionOverridesResult.ok) throw new Error(roleExecutionOverridesResult.message);
  const created = ctx.db.db.transaction(() => {
    const intakeSnapshot = ctx.db.orchIntakes.create({
      workspaceId,
      workspaceScope: localActor ? { scopeType: "local_workspace", scopeId: workspaceId } : null,
      triggerMode: "api",
      taskType: "unknown",
      title: normalizeTaskIntakeTitle(input.taskName, input.taskName),
      goal: String(input.intake?.goal ?? input.taskName).trim() || input.taskName,
      background: typeof input.intake?.background === "string" ? input.intake.background : null,
      acceptanceCriteria: normalizeTaskAcceptanceCriteria(input.intake?.acceptanceCriteria),
      workbenchItemRefs: null,
      seedArtifactRefs: null,
      metricEvidenceRefs: null,
      constraints: { requireUserConfirmation: false, nodeApprovalMode: "auto" },
      executionPlan: {
        targetType: "workflow",
        workflowId: workflow.id,
        executionEngineStrategy,
      },
      requester: { source: "scheduled_task", ...(localActor ? { userId: localActor } : {}) },
    });
    const instance = ctx.db.orchInstances.create({
      workspaceId,
      workflowId: workflow.id,
      workflowSnapshot: workflow,
      assetRuntimeSnapshot,
      proposalId: null,
      intakeSnapshot,
      roleSnapshots: roleDefinitions,
      toolsetSnapshots: collectLaunchToolsetDefinitions(assetRuntimeSnapshot),
      runtimeConfig: {
        requireProposalConfirmation: false,
        defaultNodeApprovalMode: "auto",
        interactionMode: input.interactionMode ?? "guided",
        executionEngineStrategy,
        roleExecutionOverrides: roleExecutionOverridesResult.overrides,
        executionProfileScope: parseExecutionProfileScope(null, workspaceId),
        initiatorUserId: localActor,
        assignmentSnapshot: runPlanResult.assignmentSnapshot,
      },
      artifactIndex: {},
      nodeAssigneeUserIdsByNodeId: runPlanResult.nodeAssigneeUserIdsByNodeId,
    });
    const startedEvent = ctx.db.orchEvents.append({
      instanceId: instance.id,
      nodeId: null,
      type: "orchestration.instanceStarted",
      payloadJson: JSON.stringify({
        instanceId: instance.id,
        proposalId: null,
        workflowId: instance.workflowId,
        workflowName: workflow.name,
        intakeId: instance.intakeSnapshot.id,
        intakeTitle: instance.intakeSnapshot.title,
        goal: instance.intakeSnapshot.goal,
        triggerSource: "scheduled_task",
      }),
    });
    return { instance, startedEvent };
  })();
  const { instance, startedEvent } = created;
  ctx.emitOrchestration?.(workspaceId, startedEvent);
  return {
    instanceId: instance.id,
    workflowName: workflow.name,
    workflowVersion: workflow.version,
  };
}

/** 按定时任务上下文创建并启动工作流实例。 */
export async function startScheduledWorkflowInstance(
  ctx: ApiHandlerContext,
  input: ScheduledWorkflowLaunchInput,
): Promise<ScheduledWorkflowLaunchResult> {
  const result = await withAssetDraftDatabase(ctx, "scheduled-workflow", () => createScheduledWorkflowInstance(ctx, input));
  await ctx.orchEngine.start(result.instanceId);
  return result;
}

/** 解析提案完整资产图并在单个事务中确认提案、创建实例和启动事件。 */
export async function handleOrchInstancesStart(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const proposalId = str(req, "proposalId") as ProposalId;
  const executionEngineStrategy = normalizeOrchestrationExecutionEngineStrategy((req.body as any)?.executionEngineStrategy, "follow-role");
  if (!workspaceId) return badParam(ctx, req, "workspaceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!proposalId) return badParam(ctx, req, "workspaceId/proposalId");

  let workflow: WorkflowRuntimeDefinition | null = null;
  let intakeSnapshot: TaskIntake | null = null;
  let proposalRef: ProposalId | null = null;
  let workflowId: WorkflowId | null = null;

  const proposal = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationProposal(ctx, proposalId));
  if (!proposal || proposal.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排提案不存在：${proposalId}` } });
    return;
  }
  const proposalBlockingReason = resolveProposalBlockingReason(proposal);
  if (proposalBlockingReason) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: proposalBlockingReason,
      },
    });
    return;
  }
  const activeInstance = await withAssetDraftDatabase(ctx, req.id, () => findActiveInstanceByIntake(ctx, workspaceId, proposal.intakeId));
  if (activeInstance) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: ctx.localWorkspaceOnly === true && !isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, activeInstance)
          ? "当前需求已有进行中的执行，请先结束当前执行。" : `当前需求已有进行中的执行：${activeInstance.id}。请先进入执行页查看或结束当前执行，再重新执行。`,
      },
    });
    return;
  }
  const originalStatus = proposal.status;
  if (proposal.status !== "confirmed" && proposal.requiresConfirmation) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "提案尚未确认，不能启动实例" } });
    return;
  }
  const assetRuntimeSnapshot = await withAssetDraftDatabase(ctx, req.id, () => requireOrchAssetLaunchSnapshotService(ctx).createFromWorkflow(workspaceId, proposal.draftWorkflow));
  workflow = assetRuntimeSnapshot.workflow.definition;
  intakeSnapshot = attachSharedRequirementContextToIntakeSnapshot(proposal.intakeSnapshot, (req.body as any)?.sharedRequirementContext);
  proposalRef = proposal.id;
  workflowId = workflow.id;

  if (!workflow || !workflowId || !intakeSnapshot) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: "实例启动上下文不完整" } });
    return;
  }

  const roleDefinitions = collectLaunchRoleDefinitions(assetRuntimeSnapshot);
  const executionDefault = await withAssetDraftDatabase(ctx, req.id, () => applyWorkflowExecutionDefault({
    defaults: ctx.db.orchWorkflowExecutionDefaults,
    workspaceId,
    workflowId,
    workflow,
    roleDefinitions,
    requestedStrategy: executionEngineStrategy,
    rawOverrides: (req.body as any)?.roleExecutionOverrides,
  }));
  const effectiveExecutionEngineStrategy = executionDefault.strategy;
  const strategyValidationIssue = validateExecutionStrategyForWorkflow(workflow, roleDefinitions, effectiveExecutionEngineStrategy);
  if (strategyValidationIssue) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 409,
      body: {
        ok: false,
        message: strategyValidationIssue,
      },
    });
    return;
  }
  const roleExecutionOverridesResult = await withAssetDraftDatabase(ctx, req.id, () => parseRoleExecutionOverridesForStart(
    ctx,
    executionDefault.rawOverrides,
    workflow,
    roleDefinitions,
    effectiveExecutionEngineStrategy,
  ));
  if (!roleExecutionOverridesResult.ok) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: {
        ok: false,
        message: roleExecutionOverridesResult.message,
      },
    });
    return;
  }
  const runPlanResult = await withAssetDraftDatabase(ctx, req.id, () => parseRunPlanForStart(ctx, workspaceId, (req.body as any)?.runPlan, workflow));
  if (!runPlanResult.ok) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: {
        ok: false,
        message: runPlanResult.message,
      },
    });
    return;
  }
  await withAssetDraftDatabase(ctx, req.id, () => assertChatWorkflowDirectoryAvailable(ctx, workspaceId));
  const persisted = await withAssetDraftDatabase(ctx, req.id, () => ctx.db.db.transaction(() => {
    const effectiveProposal = proposal.status === "confirmed" ? proposal : ctx.db.orchProposals.confirm(proposal.id);
    if (!effectiveProposal) return null;
    const instance = ctx.db.orchInstances.create({
      workspaceId,
      workflowId,
      workflowSnapshot: workflow,
      assetRuntimeSnapshot,
      proposalId: proposalRef,
      intakeSnapshot,
      roleSnapshots: roleDefinitions,
      toolsetSnapshots: collectLaunchToolsetDefinitions(assetRuntimeSnapshot),
      runtimeConfig: {
        requireProposalConfirmation: effectiveProposal.requiresConfirmation !== false,
        defaultNodeApprovalMode: intakeSnapshot.constraints?.nodeApprovalMode ?? "auto",
        executionEngineStrategy: effectiveExecutionEngineStrategy,
        roleExecutionOverrides: roleExecutionOverridesResult.overrides,
        executionProfileScope: parseExecutionProfileScope((req.body as any)?.executionProfileScope, workspaceId),
        initiatorUserId: nullableString((req.body as any)?.initiatorUserId),
        assignmentSnapshot: runPlanResult.assignmentSnapshot,
      },
      artifactIndex: {},
      nodeAssigneeUserIdsByNodeId: runPlanResult.nodeAssigneeUserIdsByNodeId,
      skippedNodeIds: runPlanResult.skippedNodeIds,
    });
    ctx.db.orchEvents.append({
      instanceId: instance.id,
      nodeId: null,
      type: "orchestration.instanceStarted",
      payloadJson: JSON.stringify({
        instanceId: instance.id,
        proposalId: instance.proposalId ?? null,
        workflowId: instance.workflowId,
        goal: instance.intakeSnapshot.goal,
        skippedNodeIds: runPlanResult.skippedNodeIds,
      }),
    });
    return { effectiveProposal, instance };
  })());
  if (!persisted) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "提案启动时已不存在" } });
    return;
  }
  const { effectiveProposal, instance } = persisted;

  await ctx.orchEngine.startInBackground(instance.id, req.id);
  ok(ctx, req, {
    instanceId: instance.id,
    proposalId: proposalRef,
    autoConfirmed: originalStatus !== "confirmed" && effectiveProposal.status === "confirmed",
  });
}

/** 暂停编排实例，并等待运行时完成当前活跃节点的中断收敛。 */
export async function handleOrchInstancesPause(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  await ctx.orchEngine.pause(instanceId);
  ok(ctx, req, {});
}

/** 恢复编排；带 nodeId 时只提交一次节点补充并沿用当前会话。 */
export async function handleOrchInstancesResume(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  const feedback = nullableString((req.body as any)?.feedback);
  const artifactIds = normalizeStringArray((req.body as any)?.artifactIds) as ArtifactId[] | null;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  if (nodeId) {
    if (!instance.nodeStates[nodeId]) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
      return;
    }
    try {
      await ctx.orchEngine.submitFeedback(instanceId, nodeId, "resume_with_input", {
        feedback,
        artifactIds,
      });
    } catch (error) {
      if (isOrchestrationRuntimeConflictError(error)) {
        ctx.send({ t: "api.res", id: req.id, status: 409, body: toOrchestrationRuntimeConflictBody(error) });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
      return;
    }

    // 带 nodeId 的 resume 已由 submitFeedback 完成节点级恢复/重置，并在
    // Engine 内安排后台续跑；不要再触发一次实例级 recovery probe。
    ok(ctx, req, {});
    return;
  }

  try {
    await ctx.orchEngine.resumeInBackground(instanceId);
    ok(ctx, req, {});
  } catch (error) {
    if (isOrchestrationRuntimeConflictError(error)) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: toOrchestrationRuntimeConflictBody(error) });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

/** 取消准入与同步状态变更持短许可，后续中断仍由原Engine取消owner持有。 */
export async function handleOrchInstancesCancel(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  if (!workspaceId || !instanceId) return badParam(ctx, req, "workspaceId/instanceId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  await withAssetDraftDatabase(ctx, req.id, () => ctx.orchEngine.cancel(instanceId));
  ok(ctx, req, {});
}

/**
 * 停止单个节点：硬中断该节点 in-flight turn，节点转入 waiting-feedback 等待用户在节点会话中补充输入继续执行。
 * 与「终止流程」不同，本入口仅影响目标节点，整体 instance 继续保持 running/waiting 状态。
 */
export async function handleOrchNodesCancel(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  if (!workspaceId || !instanceId || !nodeId) return badParam(ctx, req, "workspaceId/instanceId/nodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  if (!instance.nodeStates[nodeId]) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }

  try {
    await ctx.orchEngine.cancelNode(instanceId, nodeId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message } });
    return;
  }
  ok(ctx, req, {});
}

/** 启动等待人工启动的节点；可携带启动前补充说明，后续执行由引擎后台调度。 */
export async function handleOrchNodesStart(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  const actorUserId = nullableString((req.body as any)?.actorUserId);
  const feedback = nullableString((req.body as any)?.feedback);
  if (!workspaceId || !instanceId || !nodeId) return badParam(ctx, req, "workspaceId/instanceId/nodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  if (!instance.nodeStates[nodeId]) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }

  try {
    await ctx.orchEngine.startWaitingNode(instanceId, nodeId, actorUserId, feedback);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message } });
    return;
  }
  ok(ctx, req, {});
}

/** 跳过等待人工启动的节点；只接受 waiting-start，后续调度由引擎后台推进。 */
export async function handleOrchNodesSkip(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  const actorUserId = nullableString((req.body as any)?.actorUserId);
  if (!workspaceId || !instanceId || !nodeId) return badParam(ctx, req, "workspaceId/instanceId/nodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  if (!instance.nodeStates[nodeId]) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }

  try {
    await ctx.orchEngine.skipWaitingNode(instanceId, nodeId, actorUserId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message } });
    return;
  }
  ok(ctx, req, {});
}

/** 提交人工审核/反馈决定；只确认状态写入，后续续跑由引擎后台调度。 */
export async function handleOrchInstancesFeedback(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  const action = str(req, "action") as FeedbackAction;
  const targetNodeId = nullableString((req.body as any)?.targetNodeId);
  const feedback = nullableString((req.body as any)?.feedback);
  const images = normalizeStringArray((req.body as any)?.images) ?? [];
  const artifactIds = normalizeStringArray((req.body as any)?.artifactIds) as ArtifactId[] | null;
  if (!workspaceId || !instanceId || !nodeId || !action) return badParam(ctx, req, "workspaceId/instanceId/nodeId/action");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!isFeedbackAction(action)) return badFeedbackActionParam(ctx, req);
  const budgetCheck = validateInlineThreadPayload({ text: feedback ?? "", images }, { contextLabel: "当前审核意见" });
  if (!budgetCheck.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: budgetCheck.message } });
    return;
  }

  const instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  const nodeState = instance.nodeStates[nodeId];
  if (!nodeState) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${nodeId}` } });
    return;
  }
  const requiredFeedbackMessage = resolveRequiredManualReviewFeedback(nodeState, action, feedback, targetNodeId, images.length > 0);
  if (requiredFeedbackMessage) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: requiredFeedbackMessage } });
    return;
  }

  try {
    await ctx.orchEngine.submitFeedback(instanceId, nodeId, action, {
      feedback,
      artifactIds,
      targetNodeId,
      images,
    });
  } catch (error) {
    if (isOrchestrationRuntimeConflictError(error)) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: toOrchestrationRuntimeConflictBody(error) });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  ok(ctx, req, {});
}

/**
 * 「从指定节点重跑」handler：先校验重跑起点与可选运行覆盖，再委托给 engine.rerunFromNode。
 * 引擎内部负责 cancelAndWait → applyRequestedRework → resume 的完整流程。
 */
export async function handleOrchInstancesRerunFromNode(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const targetNodeId = str(req, "targetNodeId");
  const note = nullableString((req.body as any)?.note);
  const images = normalizeStringArray((req.body as any)?.images) ?? [];
  const threadReusePolicy = parseNodeThreadReusePolicy((req.body as any)?.threadReusePolicy);
  const downstreamThreadReusePolicy = parseDownstreamThreadReusePolicy((req.body as any)?.downstreamThreadReusePolicy);
  const rerunNodeIds = (req.body as any)?.rerunNodeIds;
  const rawApplyLatestWorkItemPolicy = (req.body as any)?.applyLatestWorkItemPolicy;
  if (!workspaceId || !instanceId || !targetNodeId) return badParam(ctx, req, "workspaceId/instanceId/targetNodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);
  if (!threadReusePolicy.ok) return badParam(ctx, req, "threadReusePolicy");
  if (!downstreamThreadReusePolicy.ok) return badParam(ctx, req, "downstreamThreadReusePolicy");
  if (rawApplyLatestWorkItemPolicy != null && typeof rawApplyLatestWorkItemPolicy !== "boolean") {
    return badParam(ctx, req, "applyLatestWorkItemPolicy");
  }
  const budgetCheck = validateInlineThreadPayload({ text: note ?? "", images }, { contextLabel: "当前重跑说明" });
  if (!budgetCheck.ok) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: budgetCheck.message } });
    return;
  }

  let instance = await withAssetDraftDatabase(ctx, req.id, () => readScopedOrchestrationInstance(ctx, instanceId));
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }
  if (!instance.nodeStates[targetNodeId]) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `节点不存在：${targetNodeId}` } });
    return;
  }
  const targetNode = instance.workflowSnapshot.nodes.find((node) => node.id === targetNodeId) ?? null;
  if (!targetNode || targetNode.type !== "role") {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 400,
      body: { ok: false, message: "仅 role 节点支持从此节点重跑" },
    });
    return;
  }

  try {
    instance = await ctx.orchEngine.ensureAssetRuntimeSnapshotForExecution(instanceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }

  try {
    await withAssetDraftDatabase(ctx, req.id, () => ctx.orchEngine.validateRerunFromNodeScope(instanceId, targetNodeId, rerunNodeIds ?? null));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }

  const rawRoleExecutionOverrides = (req.body as any)?.roleExecutionOverrides;
  if (rawRoleExecutionOverrides != null) {
    if (instance.status === "running") {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 409,
        body: { ok: false, message: "运行中的实例不能更新执行覆盖，请先停止或暂停流程" },
      });
      return;
    }
    const parsedOverrides = await withAssetDraftDatabase(ctx, req.id, () => parseRoleExecutionOverridesForStart(
      ctx,
      rawRoleExecutionOverrides,
      instance.workflowSnapshot,
      collectRuntimeSnapshotRoleDefinitions(instance),
      normalizeOrchestrationExecutionEngineStrategy(instance.runtimeConfig?.executionEngineStrategy, "follow-role"),
      instance.runtimeConfig?.roleExecutionOverrides ?? null,
    ));
    if (!parsedOverrides.ok) {
      ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: parsedOverrides.message } });
      return;
    }
    if (parsedOverrides.overrides) {
      const nextOverrides = { ...(instance.runtimeConfig?.roleExecutionOverrides ?? {}) };
      for (const [roleId, override] of Object.entries(parsedOverrides.overrides)) {
        nextOverrides[roleId] = { ...(nextOverrides[roleId] ?? {}), ...override };
      }
      const runtimeConfig = { ...(instance.runtimeConfig ?? {}), roleExecutionOverrides: nextOverrides };
      await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchInstances.updateRuntimeConfig(instanceId, runtimeConfig));
      await withAssetDraftDatabase(ctx, req.id, () => ctx.db.orchEvents.append({
        instanceId,
        nodeId: targetNodeId,
        type: "orchestration.executionOverridesUpdated",
        payloadJson: JSON.stringify({
          instanceId,
          nodeId: targetNodeId,
          updatedRoleIds: Object.keys(parsedOverrides.overrides!),
          source: "rerun_from_node",
        }),
      }));
    }
  }

  try {
    await ctx.orchEngine.rerunFromNode(instanceId, targetNodeId, {
      note,
      images: images.length ? images : null,
      threadReusePolicy: threadReusePolicy.policy,
      downstreamThreadReusePolicy: downstreamThreadReusePolicy.policy,
      rerunNodeIds: rerunNodeIds ?? null,
      applyLatestWorkItemPolicy: rawApplyLatestWorkItemPolicy === true,
    });
  } catch (error) {
    if (isOrchestrationRuntimeConflictError(error)) {
      ctx.send({ t: "api.res", id: req.id, status: 409, body: toOrchestrationRuntimeConflictBody(error) });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
    return;
  }
  ok(ctx, req, {});
}

export function handleOrchInstancesEnsureDiscussionThread(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const instanceId = str(req, "instanceId") as OrchestrationId;
  const nodeId = str(req, "nodeId");
  if (!workspaceId || !instanceId || !nodeId) return badParam(ctx, req, "workspaceId/instanceId/nodeId");
  if (!ctx.workspaces.has(workspaceId)) return notFoundWs(ctx, req, workspaceId);

  const instance = readScopedOrchestrationInstance(ctx, instanceId);
  if (!instance) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `编排实例不存在：${instanceId}` } });
    return;
  }

  try {
    const created = ctx.orchEngine.ensureDiscussionThread(instanceId, nodeId);
    const persistedThread = ctx.db.threads.get(created.threadId);
    if (!persistedThread) {
      throw new Error(`讨论线程创建成功但未找到线程记录：${created.threadId}`);
    }
    ok(ctx, req, {
      thread: toThreadSummary(persistedThread),
      created: created.created,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message } });
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Persists one proposal from an authority-approved workflow and role reader. */
export function createProposalFromIntake(
  ctx: ApiHandlerContext,
  intake: TaskIntake,
  selectedWorkflow: WorkflowRuntimeDefinition,
  getRole: RuntimeRoleReader,
): WorkflowProposal {
  return buildProposalFromIntake(
    {
      db: {
        orchProposals: ctx.db.orchProposals,
      },
      getRole,
    },
    intake,
    selectedWorkflow,
  );
}

/** Persists one standalone proposal from an authority-approved role snapshot. */
export function createProposalFromRole(
  ctx: ApiHandlerContext,
  intake: TaskIntake,
  selectedRole: RuntimeRoleDefinition,
  getRole: RuntimeRoleReader,
): WorkflowProposal {
  return buildProposalFromRole(
    {
      db: {
        orchProposals: ctx.db.orchProposals,
      },
      getRole,
    },
    intake,
    selectedRole,
  );
}

/** Opens the single authority-pinned asset session required by one proposal operation. */
function requireOrchAssetRuntimeReadSession(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  root?: import("../../orchestration/orchAssetAuthorityRuntimeReadService.js").OrchAssetRuntimeRoot,
): OrchAssetAuthorityRuntimeReadSession {
  if (!ctx.orchAssetRuntimeRead) throw new Error("资产运行读取服务未装配");
  return ctx.orchAssetRuntimeRead.openWorkspace(workspaceId, root);
}

/** 返回唯一启动资产图服务；缺少生产装配时显式失败。 */
function requireOrchAssetLaunchSnapshotService(ctx: ApiHandlerContext): OrchAssetLaunchSnapshotService {
  if (!ctx.orchAssetLaunchSnapshot) throw new Error("启动资产图服务未装配");
  return ctx.orchAssetLaunchSnapshot;
}

/** 从完整图提取无展示时间角色定义，兼容旧实例轻量字段。 */
function collectLaunchRoleDefinitions(snapshot: OrchAssetLaunchSnapshot): Record<string, RuntimeRoleDefinition> {
  const definitions = Object.create(null) as Record<string, RuntimeRoleDefinition>;
  for (const [roleId, entry] of Object.entries(snapshot.roles)) definitions[roleId] = entry.definition;
  return definitions;
}

/** 从完整图提取无展示时间工具集定义，兼容旧实例轻量字段。 */
function collectLaunchToolsetDefinitions(snapshot: OrchAssetLaunchSnapshot): Record<string, ToolsetRuntimeDefinition> {
  const definitions = Object.create(null) as Record<string, ToolsetRuntimeDefinition>;
  for (const [toolsetId, entry] of Object.entries(snapshot.toolsets)) definitions[toolsetId] = entry.definition;
  return definitions;
}

/** Reuses role definitions within one proposal operation without changing its pinned authority. */
function createSessionRoleReader(session: OrchAssetAuthorityRuntimeReadSession): RuntimeRoleReader {
  const roles = new Map<RoleId, RuntimeRoleDefinition | null>();
  return (roleId) => {
    if (!roles.has(roleId)) roles.set(roleId, session.getAsset("role", roleId)?.definition ?? null);
    return roles.get(roleId) ?? null;
  };
}

function resolveProposalBlockingReason(proposal: WorkflowProposal): string | null {
  const standaloneRoleId = parseStandaloneRoleWorkflowId(proposal.draftWorkflow.id);
  const warning = (proposal.warnings ?? []).find((item) =>
    String(item ?? "").includes("请手动选择工作流") || String(item ?? "").includes("未自动选定"),
  );
  if (warning) {
    return `${warning}。请先手动选择流程模板后重新生成方案。`;
  }
  const hasExecutableRoleNode = proposal.draftWorkflow.nodes.some((node) => node.type === "role" && node.roleId);
  if (!hasExecutableRoleNode) {
    return standaloneRoleId
      ? "当前方案没有可执行角色节点，请先重新选择角色后再启动。"
      : "当前方案没有可执行角色节点，请先补充或选择流程模板后再启动。";
  }
  return null;
}

/** 从实例完整图提取角色运行定义，供重跑覆盖校验使用。 */
function collectRuntimeSnapshotRoleDefinitions(
  instance: OrchestrationInstance,
): Record<string, RuntimeRoleDefinition> {
  const snapshot = instance.assetRuntimeSnapshot;
  if (!snapshot) throw new Error(`编排实例缺少完整运行快照: ${instance.id}`);
  const roles = Object.create(null) as Record<string, RuntimeRoleDefinition>;
  for (const [roleId, entry] of Object.entries(snapshot.roles)) roles[roleId] = entry.definition;
  return roles;
}

/** 解析流程启动前的角色执行覆盖，只接受当前工作流里的角色。 */
function parseRoleExecutionOverridesForStart(
  ctx: ApiHandlerContext,
  raw: unknown,
  workflow: WorkflowRuntimeDefinition,
  roleDefinitions: Record<string, RuntimeRoleDefinition>,
  executionEngineStrategy: OrchestrationExecutionEngineStrategy,
  existingOverrides: Record<string, OrchestrationRoleExecutionOverride> | null = null,
): { ok: true; overrides: Record<string, OrchestrationRoleExecutionOverride> | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, overrides: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "参数错误：roleExecutionOverrides 必须是对象" };
  }

  const workflowRoleIds = new Set(
    workflow.nodes
      .filter((node) => node.type === "role" && node.roleId)
      .map((node) => String(node.roleId)),
  );
  const overrides: Record<string, OrchestrationRoleExecutionOverride> = {};
  for (const [rawRoleId, rawOverride] of Object.entries(raw as Record<string, unknown>)) {
    const roleId = String(rawRoleId ?? "").trim();
    if (!roleId || !workflowRoleIds.has(roleId)) {
      return { ok: false, message: `参数错误：角色不在当前流程中：${roleId || rawRoleId}` };
    }
    if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
      return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId} 必须是对象` };
    }
    const parsed = parseRoleExecutionOverride(
      ctx,
      roleId,
      rawOverride as Record<string, unknown>,
      roleDefinitions[roleId],
      executionEngineStrategy,
      existingOverrides?.[roleId] ?? null,
    );
    if (!parsed.ok) return parsed;
    if (parsed.override) overrides[roleId] = parsed.override;
  }

  return { ok: true, overrides: Object.keys(overrides).length ? overrides : null };
}

/** 解析启动运行计划，并把跳过节点和协作处理人转换为实例冻结快照。 */
function parseRunPlanForStart(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  raw: unknown,
  workflow: WorkflowRuntimeDefinition,
): {
  ok: true;
  nodeAssigneeUserIdsByNodeId: Record<string, string[]>;
  assignmentSnapshot: InstanceAssignmentSnapshot | null;
  skippedNodeIds: string[];
} | { ok: false; message: string } {
  const runPlan = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as OrchestrationRunPlan : null;
  const runMode = normalizeOrchestrationRunMode(runPlan?.runMode);
  const skippedNodeIds = normalizeOrchestrationRunPlanSkippedNodeIds(runPlan?.skippedNodeIds);
  const skippedNodeValidation = validateSkippedNodeIdsForWorkflow(workflow, skippedNodeIds, "跳过节点");
  if (skippedNodeValidation) return { ok: false, message: skippedNodeValidation };
  const skippedNodeIdSet = new Set(skippedNodeIds);
  const assigneesByNodeId = normalizeOrchestrationRunPlanAssignees(runPlan?.nodeAssigneeUserIdsByNodeId);
  const hasCollaborativePayload = Object.keys(assigneesByNodeId).length > 0
    || Boolean(String(runPlan?.assigneeTemplateId ?? "").trim())
    || (Array.isArray(runPlan?.profilePrecheckResults) && runPlan.profilePrecheckResults.length > 0);
  if (runMode !== "collaborative") {
    if (hasCollaborativePayload) return { ok: false, message: "独立运行不支持处理人运行计划" };
    return { ok: true, nodeAssigneeUserIdsByNodeId: {}, assignmentSnapshot: null, skippedNodeIds };
  }

  if (!runPlan) return { ok: false, message: "协作运行启动前必须提交处理人运行计划" };
  const assigneeTemplateId = String(runPlan.assigneeTemplateId ?? "").trim();
  if (!assigneeTemplateId) return { ok: false, message: "协作运行启动前必须选择处理人模板" };
  const assigneeTemplate = ctx.db.orchAssigneeTemplates.get(assigneeTemplateId);
  if (!assigneeTemplate || assigneeTemplate.workspaceId !== workspaceId || assigneeTemplate.workflowId !== workflow.id) {
    return { ok: false, message: "协作运行启动前选择的处理人模板不存在" };
  }
  if (assigneeTemplate.status !== "published") {
    return { ok: false, message: "协作运行启动前必须选择已发布的处理人模板" };
  }
  const roleNodeIds = workflow.nodes
    .filter((node) => node.type === "role")
    .map((node) => String(node.id ?? "").trim())
    .filter((nodeId) => nodeId && !skippedNodeIdSet.has(nodeId));
  if (roleNodeIds.length === 0) return { ok: false, message: "协作运行缺少未跳过的可分配角色节点" };
  const allowedNodeIds = new Set(roleNodeIds);
  const unknownNodeId = Object.keys(assigneesByNodeId).find((nodeId) => !allowedNodeIds.has(nodeId));
  if (unknownNodeId) return { ok: false, message: `处理人运行计划包含非可分配节点：${unknownNodeId}` };
  const missingNodeId = roleNodeIds.find((nodeId) => (assigneesByNodeId[nodeId]?.length ?? 0) === 0);
  if (missingNodeId) return { ok: false, message: `协作运行节点必须选择处理人：${missingNodeId}` };

  return {
    ok: true,
    nodeAssigneeUserIdsByNodeId: assigneesByNodeId,
    skippedNodeIds,
    assignmentSnapshot: {
      source: "run_plan",
      assigneeTemplateId,
      nodeAssigneeUserIdsByNodeId: assigneesByNodeId,
      profilePrecheckResults: Array.isArray(runPlan.profilePrecheckResults) ? runPlan.profilePrecheckResults : null,
      frozenAt: Date.now(),
    },
  };
}

/** 校验启动跳过节点必须存在，且不能跳过流程边界节点。 */
function validateSkippedNodeIdsForWorkflow(workflow: WorkflowRuntimeDefinition, skippedNodeIds: string[], label: string): string | null {
  if (skippedNodeIds.length === 0) return null;
  const nodeById = new Map(workflow.nodes.map((node) => [String(node.id ?? "").trim(), node]));
  for (const nodeId of skippedNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node) return `${label}包含不存在的节点：${nodeId}`;
    if (node.type === "start" || node.type === "end") return `${label}不能包含开始或结束节点：${nodeId}`;
  }
  return null;
}

/** 解析服务端注入的 Profile 作用域；缺失时按本地工作区兜底。 */
function parseExecutionProfileScope(raw: unknown, workspaceId: WorkspaceId): NodeExecutionProfileScope {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const scopeType = String(record.scopeType ?? "").trim();
  const scopeId = nullableString(record.scopeId);
  if (scopeType === "shared_workspace" && scopeId) return { scopeType, scopeId };
  if (scopeType === "local_workspace" && scopeId) return { scopeType, scopeId };
  return { scopeType: "local_workspace", scopeId: String(workspaceId) };
}

/** 解析单个角色覆盖项，避免把非法 engine/model/context 静默吞掉。 */
function parseRoleExecutionOverride(
  ctx: ApiHandlerContext,
  roleId: string,
  raw: Record<string, unknown>,
  role: RuntimeRoleDefinition | undefined,
  executionEngineStrategy: OrchestrationExecutionEngineStrategy,
  existingOverride: OrchestrationRoleExecutionOverride | null,
): { ok: true; override: OrchestrationRoleExecutionOverride | null } | { ok: false; message: string } {
  if (!role) return { ok: false, message: `参数错误：角色不存在：${roleId}` };
  const override: OrchestrationRoleExecutionOverride = {};

  const rawEngine = raw.engine;
  if (rawEngine != null && String(rawEngine).trim()) {
    const engine = String(rawEngine).trim();
    if (engine !== "claude" && engine !== "codex") {
      return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}.engine` };
    }
    if (!isRoleExecutionEngineEnabled(role.executionConfig, engine, role.executionConfig.preferredEngine)) {
      return { ok: false, message: `角色「${role.name}」未启用 ${engine === "codex" ? "Codex" : "Claude"}，不能在本次流程中覆盖到该引擎` };
    }
    override.engine = engine as EngineType;
  }

  const model = parseOptionalStringOverride(raw.model, `roleExecutionOverrides.${roleId}.model`);
  if (!model.ok) return { ok: false, message: model.message };
  if (model.value) override.model = model.value;

  const effort = parseOptionalEffortOverride(raw, `roleExecutionOverrides.${roleId}.effort`);
  if (!effort.ok) return { ok: false, message: effort.message };
  if (effort.hasValue) override.effort = effort.value;
  const effectiveOverride = { ...(existingOverride ?? {}), ...override };
  try {
    const resolvedConfig = effectiveOverride.engine
      ? resolveRuntimeRoleExecutionConfigForEngine(role.executionConfig, effectiveOverride.engine, role.executionConfig.preferredEngine)
      : resolveRuntimeRoleExecutionConfigForStrategy(
          role.executionConfig,
          executionEngineStrategy,
          role.executionConfig.preferredEngine,
        );
    const effectiveEffort = Object.prototype.hasOwnProperty.call(effectiveOverride, "effort")
      ? effectiveOverride.effort
      : resolvedConfig.effort;
    assertClientReasoningEffortSupported(
      ctx.db,
      resolvedConfig.engine,
      effectiveOverride.model ?? resolvedConfig.model,
      effectiveEffort,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}：${message}` };
  }

  const autoCompactPct = parseOptionalNumber(raw.autoCompactPct);
  if (!autoCompactPct.ok) return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}.autoCompactPct` };
  if (autoCompactPct.value != null) {
    if (autoCompactPct.value < 50 || autoCompactPct.value > 99) {
      return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}.autoCompactPct 应在 50-99 之间` };
    }
    override.autoCompactPct = Math.round(autoCompactPct.value);
  }

  const contextWindow = parseOptionalNumber(raw.contextWindow);
  if (!contextWindow.ok) return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}.contextWindow` };
  if (contextWindow.value != null) {
    if (contextWindow.value <= 0) {
      return { ok: false, message: `参数错误：roleExecutionOverrides.${roleId}.contextWindow 必须大于 0` };
    }
    override.contextWindow = Math.round(contextWindow.value);
  }
  // 显式给出该键即可表达开关：非 "fast" 一律记作关闭（null），从而覆盖角色默认的 fast。
  if (Object.prototype.hasOwnProperty.call(raw, "serviceTier")) {
    override.serviceTier = raw.serviceTier === "fast" ? "fast" : null;
  }

  return { ok: true, override: Object.keys(override).length ? override : null };
}

/** 解析可选数值字段：null/空字符串表示不覆盖，非法数值显式失败。 */
function parseOptionalNumber(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value == null || value === "") return { ok: true, value: null };
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) return { ok: false };
  return { ok: true, value: normalized };
}

/** 解析节点会话复用策略，缺省按产品口径复用旧会话。 */
function parseNodeThreadReusePolicy(raw: unknown): { ok: true; policy: NodeThreadReusePolicy } | { ok: false } {
  if (raw == null || raw === "") return { ok: true, policy: "reuse-existing" };
  if (raw === "reuse-existing" || raw === "new-thread") return { ok: true, policy: raw };
  return { ok: false };
}

/** 解析下游会话策略，缺省保留下游已有会话。 */
function parseDownstreamThreadReusePolicy(
  raw: unknown,
): { ok: true; policy: DownstreamThreadReusePolicy } | { ok: false } {
  if (raw == null || raw === "") return { ok: true, policy: "preserve-existing" };
  if (raw === "preserve-existing" || raw === "cascade-new-thread") return { ok: true, policy: raw };
  return { ok: false };
}

/** 校验强制引擎策略能被完整图中的全部角色执行。 */
function validateExecutionStrategyForWorkflow(
  workflow: WorkflowRuntimeDefinition,
  roleDefinitions: Record<string, RuntimeRoleDefinition>,
  strategy: ReturnType<typeof normalizeOrchestrationExecutionEngineStrategy>,
): string | null {
  if (strategy !== "force-codex" && strategy !== "force-claude") return null;
  const targetEngine = strategy === "force-codex" ? "codex" : "claude";
  const missingRoles: string[] = [];
  for (const node of workflow.nodes) {
    if (node.type !== "role" || !node.roleId) continue;
    const role = roleDefinitions[node.roleId];
    if (!role) continue;
    if (!isRoleExecutionEngineEnabled(role.executionConfig, targetEngine, role.executionConfig.preferredEngine)) {
      missingRoles.push(role.name || node.label || node.roleId);
    }
  }
  if (!missingRoles.length) return null;
  return `当前流程存在未启用 ${targetEngine === "codex" ? "Codex" : "Claude"} 的角色，不能强制切换该引擎：${missingRoles.join("、")}`;
}

/**
 * 应用工作区级流程执行默认值：把配置的引擎与模型强制覆盖到该流程内全部角色。
 * 传入的手工角色覆盖逐字段优先；命中强制引擎时会在启动快照里显式启用该引擎的角色 profile，
 * 保证后续策略校验与运行期解析都能落到目标引擎。未配置时原样返回。
 */
export function applyWorkflowExecutionDefault(input: {
  defaults: OrchWorkflowExecutionDefaultRepo;
  workspaceId: WorkspaceId;
  workflowId: WorkflowId;
  workflow: WorkflowRuntimeDefinition;
  roleDefinitions: Record<string, RuntimeRoleDefinition>;
  requestedStrategy: OrchestrationExecutionEngineStrategy;
  rawOverrides: unknown;
}): { strategy: OrchestrationExecutionEngineStrategy; rawOverrides: unknown } {
  const configured = input.defaults.get(input.workspaceId, input.workflowId);
  // 非法形态原样透传，交给启动校验显式拒绝，不在合并阶段静默归一成空对象。
  if (input.rawOverrides != null && (typeof input.rawOverrides !== "object" || Array.isArray(input.rawOverrides))) {
    return { strategy: input.requestedStrategy, rawOverrides: input.rawOverrides };
  }
  const manualOverrides = input.rawOverrides && typeof input.rawOverrides === "object" && !Array.isArray(input.rawOverrides)
    ? { ...(input.rawOverrides as Record<string, unknown>) }
    : {};
  if (!configured) {
    return { strategy: input.requestedStrategy, rawOverrides: manualOverrides };
  }

  const requestedForcesEngine = input.requestedStrategy === "force-codex" || input.requestedStrategy === "force-claude";
  const requestedEngine: EngineType = input.requestedStrategy === "force-codex" ? "codex" : "claude";
  if (requestedForcesEngine && requestedEngine !== configured.engine) {
    // 本次显式指定的引擎与流程级配置不同，流程级模型无法套用，整体让位给本次选择。
    return { strategy: input.requestedStrategy, rawOverrides: manualOverrides };
  }
  const strategy: OrchestrationExecutionEngineStrategy = requestedForcesEngine
    ? input.requestedStrategy
    : configured.engine === "codex" ? "force-codex" : "force-claude";

  for (const node of input.workflow.nodes) {
    if (node.type !== "role" || !node.roleId) continue;
    const role = input.roleDefinitions[node.roleId];
    if (!role) continue;
    enableRoleExecutionEngine(role, configured.engine);
    const manual = manualOverrides[node.roleId];
    const manualRecord = manual && typeof manual === "object" && !Array.isArray(manual)
      ? manual as Record<string, unknown>
      : {};
    manualOverrides[node.roleId] = {
      ...manualRecord,
      engine: manualRecord.engine == null || !String(manualRecord.engine).trim() ? configured.engine : manualRecord.engine,
      model: manualRecord.model == null || !String(manualRecord.model).trim() ? configured.model : manualRecord.model,
    };
  }
  return { strategy, rawOverrides: manualOverrides };
}

/** 在启动快照中启用指定引擎；已启用时保持原状，避免无意义改写冻结角色配置。 */
function enableRoleExecutionEngine(role: RuntimeRoleDefinition, engine: EngineType): void {
  const normalized = normalizeRoleExecutionConfig(role.executionConfig, role.executionConfig.preferredEngine);
  if (normalized.engineProfiles[engine].enabled) return;
  role.executionConfig = {
    ...normalized,
    engineProfiles: {
      ...normalized.engineProfiles,
      [engine]: { ...normalized.engineProfiles[engine], enabled: true },
    },
  };
}

function inferTaskType(goal: string): TaskType {
  const text = String(goal ?? "").trim().toLowerCase();
  if (!text) return "unknown";
  if (text.includes("bug") || text.includes("fix") || text.includes("修复") || text.includes("问题")) return "bugfix";
  if (text.includes("分析") || text.includes("调研") || text.includes("review") || text.includes("方案")) return "analysis";
  return "feature";
}

function inferTaskTypeFromInput(raw: unknown, goal: unknown): TaskType {
  const taskType = String(raw ?? "").trim();
  if (taskType === "feature" || taskType === "bugfix" || taskType === "analysis" || taskType === "unknown") {
    return taskType;
  }
  return inferTaskType(String(goal ?? ""));
}

function collectIntakeThreadIds(instances: OrchestrationInstance[]): ThreadId[] {
  const threadIds = new Set<ThreadId>();
  for (const instance of instances) {
    const masterThreadId = String(instance.masterThreadId ?? "").trim();
    if (masterThreadId) threadIds.add(masterThreadId as ThreadId);
    for (const nodeState of Object.values(instance.nodeStates ?? {})) {
      const nodeThreadId = String(nodeState.threadId ?? "").trim();
      if (nodeThreadId) threadIds.add(nodeThreadId as ThreadId);
      for (const previousThreadId of nodeState.previousThreadIds ?? []) {
        const normalizedPreviousThreadId = String(previousThreadId ?? "").trim();
        if (normalizedPreviousThreadId) threadIds.add(normalizedPreviousThreadId as ThreadId);
      }
      const discussionThreadId = String(nodeState.discussionThreadId ?? "").trim();
      if (discussionThreadId) threadIds.add(discussionThreadId as ThreadId);
    }
  }
  return [...threadIds];
}

async function disposeThreadRuntime(
  ctx: Pick<ApiHandlerContext, "sessions">,
  threadId: ThreadId,
): Promise<void> {
  const normalizedThreadId = String(threadId ?? "").trim() as ThreadId;
  if (!normalizedThreadId) return;
  await ctx.sessions.disposeThreadWithOptions(normalizedThreadId, { flushActiveTurn: false });
}

function deleteIntakeCascade(
  ctx: Pick<ApiHandlerContext, "db" | "threads">,
  intakeId: IntakeId,
  instances: OrchestrationInstance[],
  threadIds: ThreadId[],
  scope: { workspaceId: WorkspaceId; requestId: string },
): number {
  const tx = ctx.db.db.transaction(() => {
    for (const instance of instances) {
      const artifactIds = ctx.db.orchArtifacts.listByInstance(instance.id).map((artifact) => artifact.id);
      for (const artifactId of artifactIds) {
        ctx.db.orchArtifactFiles.deleteByArtifact(artifactId);
      }
      ctx.db.orchArtifacts.deleteByInstance(instance.id);
      ctx.db.orchEvents.deleteByInstance(instance.id);
      ctx.db.orchFeedback.deleteByInstance(instance.id);
      ctx.db.orchPromptSnapshots.deleteByInstance(instance.id);
      ctx.db.orchInstances.delete(instance.id);
    }
    for (const threadId of threadIds) {
      ctx.db.threads.delete(threadId);
    }
    // 会话卡片随需求同事务删除：两张表无外键，漏删会留下实例已消失的幽灵卡。
    const cardRemoval = new ChatWorkflowRepo(ctx.db.db).deleteByIntakeIds(scope.workspaceId, [intakeId]);
    const deletedProposalCount = ctx.db.orchProposals.deleteByIntake(intakeId);
    ctx.db.orchIntakes.delete(intakeId);
    return { deletedProposalCount, cardRemoval };
  });
  const { deletedProposalCount, cardRemoval } = tx();
  logger.info("orchestration", "chat workflow cards removed with intake", {
    code: "ORCH_CHAT_WORKFLOW_CARD_REMOVED", requestId: scope.requestId, workspaceId: scope.workspaceId,
    intakeId, taskIds: cardRemoval.taskIds, removedCount: cardRemoval.taskIds.length,
    skippedInvalidJsonCount: cardRemoval.skippedInvalidJsonCount,
  });
  for (const threadId of threadIds) {
    ctx.threads.delete(threadId);
  }
  return deletedProposalCount;
}

function normalizeTriggerMode(raw: unknown): TaskIntake["triggerMode"] {
  const v = String(raw ?? "").trim();
  return v === "dialog" || v === "api" ? v : "manual";
}

function normalizeStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  return items.length ? items : null;
}

/** Validates structured metric evidence so invalid cohort links cannot be persisted as ordinary Intake data. */
function parseTaskIntakeMetricEvidenceRefs(
  raw: unknown,
): { ok: true; refs: TaskIntakeMetricEvidenceRef[] | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, refs: null };
  if (!Array.isArray(raw) || raw.length > 20) return { ok: false, message: "参数错误：intake.metricEvidenceRefs" };
  const refs: TaskIntakeMetricEvidenceRef[] = [];
  const scopeKinds = new Set(["mine", "enterprise", "super_admin_user", "super_admin_enterprise", "shared_workspace"]);
  const conclusions = new Set(["improved", "regressed", "no_detectable_change"]);
  const reviewReasons = new Set<TaskIntakeMetricReviewReason>([
    "metric_version_unavailable", "metric_version_mismatch", "comparability_policy_mismatch", "baseline_cohort_missing",
    "candidate_cohort_missing", "cohort_identity_mismatch", "baseline_sample_below_minimum", "candidate_sample_below_minimum",
    "baseline_evidence_incomplete", "candidate_evidence_incomplete", "baseline_interval_unavailable", "candidate_interval_unavailable",
  ]);
  const parsePeriod = (value: unknown): { from: number; to: number } | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const from = Number((value as Record<string, unknown>).from);
    const to = Number((value as Record<string, unknown>).to);
    return Number.isFinite(from) && from > 0 && Number.isFinite(to) && to > from ? { from, to } : null;
  };
  const parseSummary = (value: unknown): TaskIntakeMetricEvidenceSummary | null | undefined => {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const evaluatedCount = Number(input.evaluatedCount);
    const coverageRate = input.coverageRate == null ? null : Number(input.coverageRate);
    const passRate = input.passRate == null ? null : Number(input.passRate);
    if (!Number.isInteger(evaluatedCount) || evaluatedCount < 0
      || (coverageRate !== null && (!Number.isFinite(coverageRate) || coverageRate < 0 || coverageRate > 1))
      || (passRate !== null && (!Number.isFinite(passRate) || passRate < 0 || passRate > 1))) return undefined;
    return { evaluatedCount, coverageRate, passRate };
  };
  const parseCohort = (value: unknown): TaskIntakeMetricCohortSnapshot | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const required = ["cohortKey", "criterion", "evaluatorId", "evaluatorVersion", "workflowSnapshotHash", "roleSnapshotHash", "nodeId", "promptDefinitionHash", "engine"]
      .map((key) => [key, String(input[key] ?? "").trim()] as const);
    const current = parseSummary(input.current);
    const comparison = parseSummary(input.comparison);
    const conclusion = input.conclusion == null ? null : String(input.conclusion);
    if (required.some(([, item]) => !item) || current === undefined || comparison === undefined
      || (conclusion !== null && !conclusions.has(conclusion))) return null;
    const fields = Object.fromEntries(required) as Record<string, string>;
    return {
      cohortKey: fields.cohortKey!, criterion: fields.criterion!, evaluatorId: fields.evaluatorId!, evaluatorVersion: fields.evaluatorVersion!,
      workflowSnapshotHash: fields.workflowSnapshotHash!, roleSnapshotHash: fields.roleSnapshotHash!, nodeId: fields.nodeId!,
      promptDefinitionHash: fields.promptDefinitionHash!, engine: fields.engine!, model: nullableString(input.model), effort: nullableString(input.effort),
      current, comparison, conclusion: conclusion as TaskIntakeMetricCohortSnapshot["conclusion"],
    };
  };
  /** Parses the frozen policy without accepting partial or out-of-range values. */
  const parseComparabilityPolicy = (value: unknown): TaskIntakeMetricComparabilityPolicy | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const minEvaluatedSamples = Number(input.minEvaluatedSamples);
    const requiredCoverageRate = Number(input.requiredCoverageRate);
    const confidenceLevel = Number(input.confidenceLevel);
    return Number.isInteger(minEvaluatedSamples) && minEvaluatedSamples > 0
      && Number.isFinite(requiredCoverageRate) && requiredCoverageRate >= 0 && requiredCoverageRate <= 1
      && Number.isFinite(confidenceLevel) && confidenceLevel > 0 && confidenceLevel < 1
      ? { minEvaluatedSamples, requiredCoverageRate, confidenceLevel }
      : null;
  };
  /** Parses one full review summary and verifies its count relationships. */
  const parseReviewSummary = (value: unknown): TaskIntakeMetricReviewSummary | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const integerKeys = ["factCount", "eligibleCount", "evaluatedCount", "passedCount", "failedCount", "missingEvidenceCount", "notEvaluatedCount"] as const;
    const counts = Object.fromEntries(integerKeys.map((key) => [key, Number(input[key])])) as Record<(typeof integerKeys)[number], number>;
    const coverageRate = input.coverageRate == null ? null : Number(input.coverageRate);
    const passRate = input.passRate == null ? null : Number(input.passRate);
    const confidenceLow = input.confidenceLow == null ? null : Number(input.confidenceLow);
    const confidenceHigh = input.confidenceHigh == null ? null : Number(input.confidenceHigh);
    const ratios = [coverageRate, passRate, confidenceLow, confidenceHigh];
    const expectedCoverageRate = counts.eligibleCount > 0 ? counts.evaluatedCount / counts.eligibleCount : null;
    const expectedPassRate = counts.evaluatedCount > 0 ? counts.passedCount / counts.evaluatedCount : null;
    if (integerKeys.some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)
      || counts.passedCount + counts.failedCount !== counts.evaluatedCount
      || counts.evaluatedCount + counts.missingEvidenceCount !== counts.eligibleCount
      || counts.eligibleCount + counts.notEvaluatedCount !== counts.factCount
      || coverageRate !== expectedCoverageRate || passRate !== expectedPassRate
      || ratios.some((item) => item !== null && (!Number.isFinite(item) || item < 0 || item > 1))
      || (counts.evaluatedCount === 0 && (passRate !== null || confidenceLow !== null || confidenceHigh !== null))
      || (counts.evaluatedCount > 0 && (passRate === null || confidenceLow === null || confidenceHigh === null))
      || (passRate !== null && confidenceLow !== null && confidenceHigh !== null
        && (confidenceLow > passRate || passRate > confidenceHigh))) return null;
    return { ...counts, coverageRate, passRate, confidenceLow, confidenceHigh };
  };
  /** Parses one saved cohort side and binds it back to the parent pair key. */
  const parseReviewCohort = (value: unknown, expectedCohortKey: string): TaskIntakeMetricReviewCohortEvidence | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const cohortKey = String(input.cohortKey ?? "").trim();
    const summary = parseReviewSummary(input.summary);
    return cohortKey === expectedCohortKey && summary ? { cohortKey, summary } : null;
  };
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
    const input = value as Record<string, unknown>;
    const currentPeriod = parsePeriod(input.currentPeriod);
    const comparisonPeriod = parsePeriod(input.comparisonPeriod);
    const observationWindow = input.observationWindow == null ? null : parsePeriod(input.observationWindow);
    const createdAt = Number(input.createdAt);
    const scopeKind = String(input.scopeKind ?? "");
    const hypothesis = nullableString(input.hypothesis);
    const targetVersion = nullableString(input.targetVersion);
    const improvementFieldCount = Number(hypothesis !== null) + Number(targetVersion !== null) + Number(observationWindow !== null);
    if (!scopeKinds.has(scopeKind) || !currentPeriod || !comparisonPeriod
      || (currentPeriod.from < comparisonPeriod.to && comparisonPeriod.from < currentPeriod.to)
      || (input.observationWindow != null && !observationWindow)
      || (hypothesis !== null && hypothesis.length > 500)
      || (targetVersion !== null && targetVersion.length > 200)
      || (improvementFieldCount !== 0 && improvementFieldCount !== 3)
      || (observationWindow !== null && observationWindow.from < createdAt)
      || (observationWindow !== null && observationWindow.to - observationWindow.from > 366 * 86_400_000)
      || !Number.isFinite(createdAt) || createdAt <= 0) {
      return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
    }
    if (input.kind === "orchestration_evaluation_cohort_pair") {
      const baseline = parseCohort(input.baseline);
      const candidate = parseCohort(input.candidate);
      const sameConfiguration = baseline && candidate
        && baseline.workflowSnapshotHash === candidate.workflowSnapshotHash
        && baseline.nodeId === candidate.nodeId
        && baseline.roleSnapshotHash === candidate.roleSnapshotHash
        && baseline.promptDefinitionHash === candidate.promptDefinitionHash
        && baseline.engine === candidate.engine
        && baseline.model === candidate.model
        && baseline.effort === candidate.effort;
      if (!baseline || !candidate || baseline.cohortKey === candidate.cohortKey
        || sameConfiguration
        || (observationWindow !== null && observationWindow.from < Math.max(currentPeriod.to, comparisonPeriod.to))
        || baseline.criterion !== candidate.criterion
        || baseline.evaluatorId !== candidate.evaluatorId
        || baseline.evaluatorVersion !== candidate.evaluatorVersion) {
        return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
      }
      const metricSchemaVersion = input.metricSchemaVersion == null ? null : Number(input.metricSchemaVersion);
      const metricDefinitionVersion = nullableString(input.metricDefinitionVersion);
      const comparabilityPolicy = input.comparabilityPolicy == null ? null : parseComparabilityPolicy(input.comparabilityPolicy);
      const metricVersionFieldCount = Number(metricSchemaVersion !== null) + Number(metricDefinitionVersion !== null) + Number(comparabilityPolicy !== null);
      if ((metricVersionFieldCount !== 0 && metricVersionFieldCount !== 3)
        || (metricSchemaVersion !== null && (!Number.isInteger(metricSchemaVersion) || metricSchemaVersion <= 0))
        || (input.comparabilityPolicy != null && !comparabilityPolicy)) {
        return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
      }
      let reviews: TaskIntakeMetricReviewSnapshot[] | null = null;
      if (input.reviews != null) {
        if (!Array.isArray(input.reviews) || input.reviews.length > 20 || !observationWindow || metricVersionFieldCount !== 3) {
          return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
        }
        const parsedReviews: TaskIntakeMetricReviewSnapshot[] = [];
        const reviewIds = new Set<string>();
        const reviewFingerprints = new Set<string>();
        for (const rawReview of input.reviews) {
          if (!rawReview || typeof rawReview !== "object" || Array.isArray(rawReview)) {
            return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
          }
          const review = rawReview as Record<string, unknown>;
          const reviewId = String(review.reviewId ?? "").trim();
          const evidenceFingerprint = String(review.evidenceFingerprint ?? "").trim();
          const status = String(review.status ?? "");
          const reasonCodes = Array.isArray(review.reasonCodes) ? review.reasonCodes.map((item) => String(item)) : null;
          const baselinePeriod = parsePeriod(review.baselinePeriod);
          const candidatePeriod = parsePeriod(review.candidatePeriod);
          const reviewPolicy = parseComparabilityPolicy(review.comparabilityPolicy);
          const reviewSchemaVersion = Number(review.metricSchemaVersion);
          const reviewDefinitionVersion = String(review.metricDefinitionVersion ?? "").trim();
          const evaluatedAt = Number(review.evaluatedAt);
          const reviewedBaseline = review.baseline == null ? null : parseReviewCohort(review.baseline, baseline.cohortKey);
          const reviewedCandidate = review.candidate == null ? null : parseReviewCohort(review.candidate, candidate.cohortKey);
          if (!reviewId || reviewId.length > 200 || !/^[a-f0-9]{64}$/u.test(evidenceFingerprint)
            || !["insufficient_evidence", "verified_improved", "not_improved"].includes(status)
            || !reasonCodes || reasonCodes.length > reviewReasons.size || new Set(reasonCodes).size !== reasonCodes.length
            || reasonCodes.some((item) => !reviewReasons.has(item as TaskIntakeMetricReviewReason))
            || !baselinePeriod || !candidatePeriod || baselinePeriod.from !== currentPeriod.from || baselinePeriod.to !== currentPeriod.to
            || candidatePeriod.from !== observationWindow.from || candidatePeriod.to !== observationWindow.to
            || !Number.isInteger(reviewSchemaVersion) || reviewSchemaVersion <= 0 || !reviewDefinitionVersion
            || !reviewPolicy
            || !Number.isFinite(evaluatedAt) || evaluatedAt < observationWindow.to
            || (review.baseline != null && !reviewedBaseline) || (review.candidate != null && !reviewedCandidate)
            || reviewIds.has(reviewId) || reviewFingerprints.has(evidenceFingerprint)) {
            return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
          }
          const typedReasons = reasonCodes as TaskIntakeMetricReviewReason[];
          const hasReason = (reason: TaskIntakeMetricReviewReason) => typedReasons.includes(reason);
          const versionMismatch = reviewSchemaVersion !== metricSchemaVersion || reviewDefinitionVersion !== metricDefinitionVersion;
          const policyMismatch = reviewPolicy.minEvaluatedSamples !== comparabilityPolicy!.minEvaluatedSamples
            || reviewPolicy.requiredCoverageRate !== comparabilityPolicy!.requiredCoverageRate
            || reviewPolicy.confidenceLevel !== comparabilityPolicy!.confidenceLevel;
          const baselineSummary = reviewedBaseline?.summary ?? null;
          const candidateSummary = reviewedCandidate?.summary ?? null;
          const comparable = baselineSummary !== null && candidateSummary !== null
            && baselineSummary.evaluatedCount >= reviewPolicy.minEvaluatedSamples
            && candidateSummary.evaluatedCount >= reviewPolicy.minEvaluatedSamples
            && baselineSummary.coverageRate === reviewPolicy.requiredCoverageRate
            && candidateSummary.coverageRate === reviewPolicy.requiredCoverageRate
            && baselineSummary.confidenceHigh !== null && candidateSummary.confidenceLow !== null;
          const provesImprovement = comparable && candidateSummary.confidenceLow! > baselineSummary.confidenceHigh!;
          const reasonFactsMatch = !hasReason("metric_version_unavailable")
            && hasReason("metric_version_mismatch") === versionMismatch
            && hasReason("comparability_policy_mismatch") === policyMismatch
            && hasReason("baseline_sample_below_minimum") === Boolean(baselineSummary && baselineSummary.evaluatedCount < reviewPolicy.minEvaluatedSamples)
            && hasReason("candidate_sample_below_minimum") === Boolean(candidateSummary && candidateSummary.evaluatedCount < reviewPolicy.minEvaluatedSamples)
            && hasReason("baseline_evidence_incomplete") === Boolean(baselineSummary && baselineSummary.coverageRate !== reviewPolicy.requiredCoverageRate)
            && hasReason("candidate_evidence_incomplete") === Boolean(candidateSummary && candidateSummary.coverageRate !== reviewPolicy.requiredCoverageRate)
            && hasReason("baseline_interval_unavailable") === Boolean(baselineSummary
              && (baselineSummary.passRate === null || baselineSummary.confidenceLow === null || baselineSummary.confidenceHigh === null))
            && hasReason("candidate_interval_unavailable") === Boolean(candidateSummary
              && (candidateSummary.passRate === null || candidateSummary.confidenceLow === null || candidateSummary.confidenceHigh === null))
            && (!hasReason("baseline_cohort_missing") || baselineSummary === null)
            && (!hasReason("candidate_cohort_missing") || candidateSummary === null)
            && (!hasReason("cohort_identity_mismatch") || baselineSummary === null || candidateSummary === null)
            && (baselineSummary !== null || hasReason("baseline_cohort_missing") || hasReason("cohort_identity_mismatch"))
            && (candidateSummary !== null || hasReason("candidate_cohort_missing") || hasReason("cohort_identity_mismatch"));
          const fingerprintPayload = {
            status, reasonCodes: typedReasons, baselinePeriod, candidatePeriod,
            baseline: reviewedBaseline, candidate: reviewedCandidate,
            metricSchemaVersion: reviewSchemaVersion, metricDefinitionVersion: reviewDefinitionVersion,
            comparabilityPolicy: reviewPolicy,
          };
          const expectedFingerprint = crypto.createHash("sha256").update(JSON.stringify(fingerprintPayload)).digest("hex");
          if (!reasonFactsMatch || evidenceFingerprint !== expectedFingerprint
            || (status === "insufficient_evidence" && typedReasons.length === 0)
            || (status !== "insufficient_evidence" && (!comparable || typedReasons.length > 0))
            || (status === "verified_improved" && !provesImprovement)
            || (status === "not_improved" && provesImprovement)) {
            return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
          }
          reviewIds.add(reviewId);
          reviewFingerprints.add(evidenceFingerprint);
          parsedReviews.push({
            reviewId, evidenceFingerprint, status: status as TaskIntakeMetricReviewSnapshot["status"],
            reasonCodes: typedReasons, baselinePeriod, candidatePeriod,
            baseline: reviewedBaseline, candidate: reviewedCandidate, metricSchemaVersion: reviewSchemaVersion,
            metricDefinitionVersion: reviewDefinitionVersion, comparabilityPolicy: reviewPolicy, evaluatedAt,
          });
        }
        reviews = parsedReviews.length ? parsedReviews : null;
      }
      refs.push({
        kind: "orchestration_evaluation_cohort_pair",
        scopeKind: scopeKind as TaskIntakeMetricEvidenceRef["scopeKind"],
        scopeId: nullableString(input.scopeId), currentPeriod, comparisonPeriod,
        baseline, candidate, metricSchemaVersion, metricDefinitionVersion, comparabilityPolicy,
        hypothesis, targetVersion, observationWindow, reviews, createdAt,
      });
      continue;
    }
    if (input.kind !== "orchestration_evaluation_cohort") {
      return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
    }
    const required = ["cohortKey", "criterion", "evaluatorId", "evaluatorVersion", "workflowSnapshotHash", "roleSnapshotHash", "engine"]
      .map((key) => [key, String(input[key] ?? "").trim()] as const);
    const nodeId = nullableString(input.nodeId);
    const promptDefinitionHash = nullableString(input.promptDefinitionHash);
    const promptHash = nullableString(input.promptHash);
    const effort = nullableString(input.effort);
    const stableIdentityFieldCount = Number(nodeId !== null) + Number(promptDefinitionHash !== null);
    const current = parseSummary(input.current);
    const comparison = parseSummary(input.comparison);
    const conclusion = input.conclusion == null ? null : String(input.conclusion);
    if (required.some(([, item]) => !item) || stableIdentityFieldCount === 1 || (stableIdentityFieldCount === 0 && promptHash === null)
      || current === undefined || comparison === undefined || (conclusion !== null && !conclusions.has(conclusion))) {
      return { ok: false, message: "参数错误：intake.metricEvidenceRefs[]" };
    }
    const fields = Object.fromEntries(required) as Record<string, string>;
    refs.push({
      kind: "orchestration_evaluation_cohort",
      scopeKind: scopeKind as TaskIntakeMetricEvidenceRef["scopeKind"],
      scopeId: nullableString(input.scopeId),
      cohortKey: fields.cohortKey!, criterion: fields.criterion!, evaluatorId: fields.evaluatorId!, evaluatorVersion: fields.evaluatorVersion!,
      workflowSnapshotHash: fields.workflowSnapshotHash!, roleSnapshotHash: fields.roleSnapshotHash!,
      nodeId, promptDefinitionHash, promptHash,
      engine: fields.engine!, model: nullableString(input.model), effort, currentPeriod, comparisonPeriod, current, comparison,
      conclusion: conclusion as TaskIntakeLegacyMetricEvidenceRef["conclusion"],
      hypothesis, targetVersion, observationWindow, createdAt,
    });
  }
  return { ok: true, refs: refs.length ? refs : null };
}

/** 校验并规范化需求侧保存的默认执行配置；这里只保存草稿，不做启动态强校验。 */
function parseTaskIntakeExecutionPlanForSave(
  raw: unknown,
): { ok: true; executionPlan: TaskIntakeExecutionPlan | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, executionPlan: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "参数错误：intake.executionPlan 必须是对象" };
  }
  const input = raw as Record<string, unknown>;
  const targetType = input.targetType === "workflow" || input.targetType === "role" ? input.targetType : null;
  if (!targetType) return { ok: false, message: "参数错误：intake.executionPlan.targetType" };

  const workflowId = parseOptionalStringField(input.workflowId, "intake.executionPlan.workflowId");
  if (!workflowId.ok) return workflowId;
  const roleId = parseOptionalStringField(input.roleId, "intake.executionPlan.roleId");
  if (!roleId.ok) return roleId;
  if (targetType === "workflow" && roleId.value) {
    return { ok: false, message: "参数错误：流程执行配置不接受 roleId" };
  }
  if (targetType === "role" && workflowId.value) {
    return { ok: false, message: "参数错误：单角色执行配置不接受 workflowId" };
  }
  const executionEngineStrategy = parseSavedExecutionEngineStrategy(input.executionEngineStrategy);
  if (!executionEngineStrategy.ok) return executionEngineStrategy;
  const roleExecutionOverrides = parseSavedRoleExecutionOverrides(input.roleExecutionOverrides);
  if (!roleExecutionOverrides.ok) return roleExecutionOverrides;
  const runPlan = parseSavedRunPlan(input.runPlan);
  if (!runPlan.ok) return runPlan;
  if (targetType === "role" && input.runPlan != null) {
    return { ok: false, message: "参数错误：单角色执行配置不接受 runPlan" };
  }
  const updatedAt = parseOptionalNumber(input.updatedAt);
  if (!updatedAt.ok) return { ok: false, message: "参数错误：intake.executionPlan.updatedAt" };

  return {
    ok: true,
    executionPlan: {
      targetType,
      workflowId: targetType === "workflow" ? workflowId.value as WorkflowId | null : null,
      roleId: targetType === "role" ? roleId.value as RoleId | null : null,
      executionEngineStrategy: executionEngineStrategy.value,
      roleExecutionOverrides: roleExecutionOverrides.overrides,
      runPlan: targetType === "workflow" ? runPlan.runPlan : null,
      updatedAt: updatedAt.value == null ? Date.now() : Math.round(updatedAt.value),
    },
  };
}

/** 解析保存执行配置中的可选字符串；非字符串输入视为接口错误。 */
function parseOptionalStringField(
  value: unknown,
  path: string,
): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: `参数错误：${path}` };
  return { ok: true, value: value.trim() || null };
}

/** 解析保存执行配置中的引擎策略，避免非法值被静默回落。 */
function parseSavedExecutionEngineStrategy(
  raw: unknown,
): { ok: true; value: OrchestrationExecutionEngineStrategy } | { ok: false; message: string } {
  if (raw == null || raw === "") return { ok: true, value: "follow-role" };
  const value = String(raw).trim();
  if (value === "follow-role" || value === "force-codex" || value === "force-claude" || value === "smart-planning") {
    return { ok: true, value };
  }
  return { ok: false, message: "参数错误：intake.executionPlan.executionEngineStrategy" };
}

/** 解析保存执行配置中的角色覆盖；角色是否属于流程留到启动前按最新流程校验。 */
function parseSavedRoleExecutionOverrides(
  raw: unknown,
): { ok: true; overrides: Record<string, OrchestrationRoleExecutionOverride> | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, overrides: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "参数错误：intake.executionPlan.roleExecutionOverrides 必须是对象" };
  }
  const overrides: Record<string, OrchestrationRoleExecutionOverride> = {};
  for (const [rawRoleId, rawOverride] of Object.entries(raw as Record<string, unknown>)) {
    const roleId = String(rawRoleId ?? "").trim();
    if (!roleId) return { ok: false, message: "参数错误：intake.executionPlan.roleExecutionOverrides 包含空角色 ID" };
    if (!rawOverride || typeof rawOverride !== "object" || Array.isArray(rawOverride)) {
      return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId} 必须是对象` };
    }
    const parsed = parseSavedRoleExecutionOverride(roleId, rawOverride as Record<string, unknown>);
    if (!parsed.ok) return parsed;
    if (parsed.override) overrides[roleId] = parsed.override;
  }
  return { ok: true, overrides: Object.keys(overrides).length ? overrides : null };
}

/** 解析保存执行配置中的单角色覆盖项；只校验结构和值域，不读取角色模板。 */
function parseSavedRoleExecutionOverride(
  roleId: string,
  raw: Record<string, unknown>,
): { ok: true; override: OrchestrationRoleExecutionOverride | null } | { ok: false; message: string } {
  const override: OrchestrationRoleExecutionOverride = {};
  const rawEngine = raw.engine;
  if (rawEngine != null && rawEngine !== "") {
    if (rawEngine !== "claude" && rawEngine !== "codex") {
      return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId}.engine` };
    }
    override.engine = rawEngine;
  }
  const model = parseOptionalStringOverride(raw.model, `intake.executionPlan.roleExecutionOverrides.${roleId}.model`);
  if (!model.ok) return { ok: false, message: model.message };
  if (model.value) override.model = model.value;

  const effort = parseOptionalEffortOverride(raw, `intake.executionPlan.roleExecutionOverrides.${roleId}.effort`);
  if (!effort.ok) return { ok: false, message: effort.message };
  if (effort.hasValue) override.effort = effort.value;
  const autoCompactPct = parseOptionalNumber(raw.autoCompactPct);
  if (!autoCompactPct.ok) {
    return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId}.autoCompactPct` };
  }
  if (autoCompactPct.value != null) {
    if (autoCompactPct.value < 50 || autoCompactPct.value > 99) {
      return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId}.autoCompactPct 应在 50-99 之间` };
    }
    override.autoCompactPct = Math.round(autoCompactPct.value);
  }
  const contextWindow = parseOptionalNumber(raw.contextWindow);
  if (!contextWindow.ok) {
    return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId}.contextWindow` };
  }
  if (contextWindow.value != null) {
    if (contextWindow.value <= 0) {
      return { ok: false, message: `参数错误：intake.executionPlan.roleExecutionOverrides.${roleId}.contextWindow 必须大于 0` };
    }
    override.contextWindow = Math.round(contextWindow.value);
  }
  // 显式给出该键即可表达开关：非 "fast" 一律记作关闭（null），从而覆盖角色默认的 fast。
  if (Object.prototype.hasOwnProperty.call(raw, "serviceTier")) {
    override.serviceTier = raw.serviceTier === "fast" ? "fast" : null;
  }
  return { ok: true, override: Object.keys(override).length ? override : null };
}

/** 解析保存执行配置中的运行计划；保存允许协作计划不完整，启动时再强校验。 */
function parseSavedRunPlan(
  raw: unknown,
): { ok: true; runPlan: OrchestrationRunPlan | null } | { ok: false; message: string } {
  if (raw == null) return { ok: true, runPlan: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "参数错误：intake.executionPlan.runPlan 必须是对象" };
  }
  const input = raw as Record<string, unknown>;
  if (
    input.runMode != null
    && input.runMode !== ""
    && input.runMode !== "independent"
    && input.runMode !== "collaborative"
  ) {
    return { ok: false, message: "参数错误：intake.executionPlan.runPlan.runMode" };
  }
  const runMode = normalizeOrchestrationRunMode(input.runMode);
  const assigneeTemplateId = parseOptionalStringField(input.assigneeTemplateId, "intake.executionPlan.runPlan.assigneeTemplateId");
  if (!assigneeTemplateId.ok) return assigneeTemplateId;
  const assignees = parseSavedRunPlanAssignees(input.nodeAssigneeUserIdsByNodeId);
  if (!assignees.ok) return assignees;
  const skippedNodeIds = parseSavedRunPlanSkippedNodeIds(input.skippedNodeIds);
  if (!skippedNodeIds.ok) return skippedNodeIds;
  const profilePrecheckResults = input.profilePrecheckResults;
  if (profilePrecheckResults != null && !Array.isArray(profilePrecheckResults)) {
    return { ok: false, message: "参数错误：intake.executionPlan.runPlan.profilePrecheckResults" };
  }
  const hasCollaborativePayload = Boolean(assigneeTemplateId.value)
    || Object.keys(assignees.assignees).length > 0
    || (Array.isArray(profilePrecheckResults) && profilePrecheckResults.length > 0);
  if (runMode !== "collaborative" && hasCollaborativePayload) {
    return { ok: false, message: "参数错误：独立运行不能保存协作处理人计划" };
  }
  return {
    ok: true,
    runPlan: {
      runMode,
      skippedNodeIds: skippedNodeIds.skippedNodeIds,
      assigneeTemplateId: runMode === "collaborative" ? assigneeTemplateId.value : null,
      nodeAssigneeUserIdsByNodeId: runMode === "collaborative" ? assignees.assignees : null,
      profilePrecheckResults: runMode === "collaborative" && Array.isArray(profilePrecheckResults) ? profilePrecheckResults : null,
    },
  };
}

/** 解析保存执行配置中的启动跳过节点列表，要求每一项都是非空字符串。 */
function parseSavedRunPlanSkippedNodeIds(
  raw: unknown,
): { ok: true; skippedNodeIds: string[] } | { ok: false; message: string } {
  if (raw == null) return { ok: true, skippedNodeIds: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, message: "参数错误：intake.executionPlan.runPlan.skippedNodeIds 必须是数组" };
  }
  const skippedNodeIds: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      return { ok: false, message: "参数错误：intake.executionPlan.runPlan.skippedNodeIds 必须是字符串数组" };
    }
    const nodeId = value.trim();
    if (!nodeId) return { ok: false, message: "参数错误：intake.executionPlan.runPlan.skippedNodeIds 包含空节点 ID" };
    if (!skippedNodeIds.includes(nodeId)) skippedNodeIds.push(nodeId);
  }
  return { ok: true, skippedNodeIds };
}

/** 解析保存执行配置中的节点处理人映射，要求节点和用户 ID 都是字符串。 */
function parseSavedRunPlanAssignees(
  raw: unknown,
): { ok: true; assignees: Record<string, string[]> } | { ok: false; message: string } {
  if (raw == null) return { ok: true, assignees: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "参数错误：intake.executionPlan.runPlan.nodeAssigneeUserIdsByNodeId 必须是对象" };
  }
  const assignees: Record<string, string[]> = {};
  for (const [rawNodeId, rawUserIds] of Object.entries(raw as Record<string, unknown>)) {
    const nodeId = String(rawNodeId ?? "").trim();
    if (!nodeId) return { ok: false, message: "参数错误：intake.executionPlan.runPlan.nodeAssigneeUserIdsByNodeId 包含空节点 ID" };
    if (rawUserIds == null) continue;
    if (!Array.isArray(rawUserIds)) {
      return { ok: false, message: `参数错误：intake.executionPlan.runPlan.nodeAssigneeUserIdsByNodeId.${nodeId} 必须是数组` };
    }
    const userIds: string[] = [];
    for (const value of rawUserIds) {
      if (typeof value !== "string") {
        return { ok: false, message: `参数错误：intake.executionPlan.runPlan.nodeAssigneeUserIdsByNodeId.${nodeId} 必须是字符串数组` };
      }
      const userId = value.trim();
      if (userId && !userIds.includes(userId)) userIds.push(userId);
    }
    if (userIds.length > 0) assignees[nodeId] = userIds;
  }
  return { ok: true, assignees };
}

/** 归一化人工修订提交，保留下游依赖的字段、附件和正式文件 key。 */
function normalizeArtifactRevisionAnswer(raw: unknown): NodeExecutionEnvelope {
  if (!raw || typeof raw !== "object") {
    throw new Error("人工修订缺少 answer");
  }
  const input = raw as Record<string, any>;
  const mode = String(input.mode ?? "").trim();
  const extras = normalizeArtifactRevisionAnswerExtras(input);
  if (mode === "text") {
    return {
      mode: "text",
      text: String(input.text ?? ""),
      summary: nullableString(input.summary),
      changedFiles: normalizeStringArray(input.changedFiles),
      ...extras,
    };
  }
  if (mode === "structured") {
    return {
      mode: "structured",
      data: input.data ?? {},
      summary: nullableString(input.summary),
      changedFiles: normalizeStringArray(input.changedFiles),
      ...extras,
    };
  }
  if (mode === "file") {
    const file = input.file && typeof input.file === "object" ? input.file : null;
    const filePath = String(file?.path ?? "").trim();
    if (!filePath) throw new Error("人工修订缺少 answer.file.path");
    if (Object.prototype.hasOwnProperty.call(file ?? {}, "content")) {
      throw new Error("人工修订 answer.file 不允许内联 content，请改用 workspaceFiles");
    }
    return {
      mode: "file",
      file: {
        ...(nullableString(file?.key) ? { key: nullableString(file?.key) } : {}),
        path: filePath,
        summary: nullableString(file?.summary),
      },
      summary: nullableString(input.summary),
      changedFiles: normalizeStringArray(input.changedFiles),
      ...extras,
    };
  }
  if (mode === "file-set") {
    const files = Array.isArray(input.files) ? input.files : null;
    if (!files?.length) throw new Error("人工修订缺少 answer.files");
    const normalizedFiles = files.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const filePath = String((item as any).path ?? "").trim();
      if (!filePath) return [];
      if (Object.prototype.hasOwnProperty.call(item, "content")) {
        throw new Error("人工修订 answer.files 不允许内联 content，请改用 workspaceFiles");
      }
      return [{
        ...(nullableString((item as any).key) ? { key: nullableString((item as any).key) } : {}),
        path: filePath,
        summary: nullableString((item as any).summary),
      }];
    });
    if (!normalizedFiles.length) throw new Error("人工修订缺少有效的 answer.files.path");
    return {
      mode: "file-set",
      files: normalizedFiles,
      summary: nullableString(input.summary),
      changedFiles: normalizeStringArray(input.changedFiles),
      ...extras,
    };
  }
  throw new Error(`人工修订 answer.mode 不支持：${mode || "unknown"}`);
}

/** 提取人工修订附加输出，避免保存时丢失结构化字段和动态附件。 */
function normalizeArtifactRevisionAnswerExtras(input: Record<string, any>): Pick<NodeExecutionEnvelope, "fields" | "attachments"> {
  const fields = normalizeArtifactRevisionFields(input.fields);
  const attachments = normalizeArtifactRevisionAttachments(input.attachments);
  return {
    ...(fields ? { fields } : {}),
    ...(attachments ? { attachments } : {}),
  };
}

/** 校验并浅拷贝人工修订字段，保持字段值由后续契约校验处理。 */
function normalizeArtifactRevisionFields(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("人工修订 answer.fields 必须是对象");
  }
  return { ...(raw as Record<string, unknown>) };
}

/** 归一化人工修订附件；附件保留在 attachments，不能混入正式交付物 files。 */
function normalizeArtifactRevisionAttachments(raw: unknown): NonNullable<NodeExecutionEnvelope["attachments"]> | null {
  if (raw == null) return null;
  if (!Array.isArray(raw)) {
    throw new Error("人工修订 answer.attachments 必须是数组");
  }
  const attachments: NonNullable<NodeExecutionEnvelope["attachments"]> = raw.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const filePath = String((item as any).path ?? "").trim();
    if (!filePath) return [];
    return [{
      ...(nullableString((item as any).key) ? { key: nullableString((item as any).key) } : {}),
      path: filePath,
      ...(Object.prototype.hasOwnProperty.call(item, "content") ? { content: String((item as any).content ?? "") } : {}),
      summary: nullableString((item as any).summary),
      kind: nullableString((item as any).kind) as NonNullable<NodeExecutionEnvelope["attachments"]>[number]["kind"],
      format: nullableString((item as any).format) as NonNullable<NodeExecutionEnvelope["attachments"]>[number]["format"],
      language: nullableString((item as any).language),
    }];
  });
  if (raw.length > 0 && attachments.length !== raw.length) {
    throw new Error(`人工修订 answer.attachments[${attachments.length}] 缺少有效的 path`);
  }
  return attachments.length ? attachments : null;
}

function normalizeArtifactRevisionWorkspaceFiles(raw: unknown): Array<{ path: string; content: string }> {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new Error("人工修订 workspaceFiles 必须是数组");
  }
  const files = raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const filePath = String((item as any).path ?? "").trim();
    if (!filePath) return [];
    return [{
      path: filePath,
      content: String((item as any).content ?? ""),
    }];
  });
  if (raw.length > 0 && files.length !== raw.length) {
    throw new Error("人工修订 workspaceFiles 缺少有效的 path");
  }
  return files;
}

function validateArtifactRevisionWorkspaceFiles(
  answer: NodeExecutionEnvelope,
  workspaceFiles: Array<{ path: string; content: string }>,
): void {
  if (answer.mode !== "file" && answer.mode !== "file-set") {
    if (workspaceFiles.length) {
      throw new Error("text/structured 人工修订不应携带 workspaceFiles");
    }
    return;
  }

  if (!workspaceFiles.length) {
    throw new Error("file/file-set 人工修订必须提供 workspaceFiles");
  }

  const expectedPaths = answer.mode === "file"
    ? [answer.file.path]
    : answer.files.map((file) => file.path);
  const expected = new Set(expectedPaths.map(normalizeWorkspaceRelativePath));
  const actual = new Set(workspaceFiles.map((file) => normalizeWorkspaceRelativePath(file.path)));
  if (answer.mode === "file") {
    if (expected.size !== actual.size) {
      throw new Error("workspaceFiles 与 answer 路径集合不一致");
    }
    for (const filePath of expected) {
      if (!actual.has(filePath)) {
        throw new Error("workspaceFiles 与 answer 路径集合不一致");
      }
    }
    return;
  }
  for (const filePath of actual) {
    if (!expected.has(filePath)) {
      throw new Error("workspaceFiles 包含 answer 之外的路径");
    }
  }
}

/** 写入人工修订的工作区文件，并在全部写入成功后增量更新路径索引。 */
function writeArtifactRevisionWorkspaceFiles(
  workspaceId: WorkspaceId,
  workspacePath: string,
  workspacePathIndex: ApiHandlerContext["workspacePathIndex"],
  files: Array<{ path: string; content: string }>,
): void {
  const changedPaths: string[] = [];
  for (const file of files) {
    const relPath = normalizeWorkspaceRelativePath(file.path);
    const absPath = path.resolve(workspacePath, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, file.content, "utf8");
    changedPaths.push(relPath);
  }
  if (workspacePathIndex && changedPaths.length > 0) {
    workspacePathIndex.applyChanges(workspaceId, workspacePath, changedPaths.map((filePath) => ({ type: "upsert", path: filePath })));
  }
}

function hydrateArtifactRevisionWorkspaceFiles(
  answer: NodeExecutionEnvelope,
  workspaceFiles: Array<{ path: string; content: string }>,
  artifact: { contentJson: string },
): Array<{ path: string; content: string }> {
  if (answer.mode !== "file-set") return workspaceFiles;

  const expectedPaths = answer.files.map((file) => normalizeWorkspaceRelativePath(file.path));
  const providedByPath = new Map<string, string>();
  for (const file of workspaceFiles) {
    const relPath = normalizeWorkspaceRelativePath(file.path);
    if (!providedByPath.has(relPath)) {
      providedByPath.set(relPath, file.content);
    }
  }
  if (expectedPaths.every((path) => providedByPath.has(path))) {
    return workspaceFiles;
  }

  const fallbackByPath = parseArtifactWorkspaceFileContents(artifact.contentJson);
  const hydrated = [...workspaceFiles];
  for (const relPath of expectedPaths) {
    if (providedByPath.has(relPath)) continue;
    const fallbackContent = fallbackByPath.get(relPath);
    if (fallbackContent == null) {
      throw new Error(`缺少文件内容：${relPath}（请重新加载后再保存）`);
    }
    hydrated.push({ path: relPath, content: fallbackContent });
    providedByPath.set(relPath, fallbackContent);
  }
  return hydrated;
}

function parseArtifactWorkspaceFileContents(contentJson: string): Map<string, string> {
  const byPath = new Map<string, string>();
  try {
    const parsed = JSON.parse(String(contentJson ?? "{}")) as Record<string, unknown>;
    const mode = String(parsed.mode ?? "").trim();
    if (mode === "file") {
      const file = parsed.file as Record<string, unknown> | null | undefined;
      const relPath = normalizeWorkspaceRelativePath(String(file?.path ?? ""));
      byPath.set(relPath, String(file?.content ?? ""));
      return byPath;
    }
    if (mode === "file-set") {
      const files = Array.isArray(parsed.files) ? parsed.files : [];
      for (const item of files) {
        if (!item || typeof item !== "object") continue;
        const relPath = normalizeWorkspaceRelativePath(String((item as any).path ?? ""));
        if (byPath.has(relPath)) continue;
        byPath.set(relPath, String((item as any).content ?? ""));
      }
    }
  } catch {
    // ignore parse errors; caller will report missing file fallback.
  }
  return byPath;
}

function normalizeWorkspaceRelativePath(filePath: string): string {
  const normalized = String(filePath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .trim();
  if (!normalized || normalized === "." || path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`工件路径非法：${filePath}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`工件路径非法：${filePath}`);
  }
  return normalized;
}

function normalizeConstraints(raw: any): TaskIntake["constraints"] {
  if (!raw || typeof raw !== "object") return null;
  return {
    requireUserConfirmation: raw.requireUserConfirmation !== false,
    nodeApprovalMode: normalizeApprovalMode(raw.nodeApprovalMode),
  };
}

function normalizeApprovalMode(raw: unknown): "auto" | "manual" {
  return String(raw ?? "").trim() === "manual" ? "manual" : "auto";
}

/** 校验人工反馈动作白名单，避免未知 action 进入编排引擎。 */
function isFeedbackAction(raw: string): raw is FeedbackAction {
  return (ORCH_FEEDBACK_ACTIONS as readonly string[]).includes(raw);
}

function toThreadSummary(thread: {
  id: ThreadId;
  title: string;
  threadType: ThreadSummary["threadType"];
  threadSubtype: ThreadSummary["threadSubtype"];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  engine: ThreadSummary["engine"];
}): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    threadType: thread.threadType,
    threadSubtype: thread.threadSubtype,
    archived: thread.archived,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    engine: thread.engine,
  };
}

/** 单会话沿原 RA 权威精确读取，不扫描其他会话或认领未知历史。 */
function allowScopedRequirementSession(ctx: ApiHandlerContext, req: ApiRequestMessage, workspaceId: WorkspaceId, id: ThreadId): boolean {
  if (ctx.localWorkspaceOnly !== true || ctx.db.threads.get(id)?.workspaceId === workspaceId
    && isDesktopLocalThreadAssetExecution(ctx.clientId, ctx.workspaces, ctx.db, id)) return true;
  hiddenOrchestrationResource(ctx, req);
  return false;
}

/** 原领域读取同时验证本机冻结归属与可信请求工作区；remote 保持既有读取。 */
function readScopedOrchestrationInstance(ctx: ApiHandlerContext, id: OrchestrationId): OrchestrationInstance | null {
  const instance = ctx.db.orchInstances.get(id, { strictScope: ctx.localWorkspaceOnly === true });
  return ctx.localWorkspaceOnly === true && (!isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, instance)
    || ctx.intakeWorkspaceScope?.scopeType === "local_workspace" && instance?.workspaceId !== ctx.intakeWorkspaceScope.scopeId) ? null : instance;
}

/** 产物仍使用原轻量关系投影，本机先以所属实例冻结事实准入。 */
function readScopedOrchestrationInstanceAccess(ctx: ApiHandlerContext, id: OrchestrationId) {
  if (ctx.localWorkspaceOnly === true && !readScopedOrchestrationInstance(ctx, id)) return null;
  return ctx.db.orchInstances.getAccessProjection(id);
}

/** 提案沿自身冻结需求及可信请求工作区准入，不借 live intake 认领历史。 */
function readScopedOrchestrationProposal(ctx: ApiHandlerContext, id: ProposalId): WorkflowProposal | null {
  const proposal = ctx.db.orchProposals.get(id, { strictScope: ctx.localWorkspaceOnly === true });
  return ctx.localWorkspaceOnly === true && (!isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, proposal)
    || ctx.intakeWorkspaceScope?.scopeType === "local_workspace" && proposal?.workspaceId !== ctx.intakeWorkspaceScope.scopeId) ? null : proposal;
}

/** live intake 复用原仓储范围语义，并绑定可信本机请求工作区。 */
function isScopedOrchestrationIntake(ctx: ApiHandlerContext, intake: TaskIntake): boolean {
  return ctx.localWorkspaceOnly !== true || isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, { workspaceId: intake.workspaceId, intakeSnapshot: intake })
    && (ctx.intakeWorkspaceScope?.scopeType !== "local_workspace" || intake.workspaceId === ctx.intakeWorkspaceScope.scopeId);
}

/** 不对受保护资源暴露存在性或真实实体身份。 */
function hiddenOrchestrationResource(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "编排资源不存在" } });
}

/** 本机仅替换可操作提案，合法共享或未知历史保留原状态。 */
function supersedeExistingProposalsForIntake(ctx: ApiHandlerContext, workspaceId: WorkspaceId, intakeId: IntakeId): void {
  const proposals = ctx.db.orchProposals
    .listByWorkspace(workspaceId, { strictScope: ctx.localWorkspaceOnly === true })
    .filter((proposal) => proposal.intakeId === intakeId && (ctx.localWorkspaceOnly !== true || isDesktopLocalAssetExecution(ctx.clientId, ctx.workspaces, proposal)));

  for (const proposal of proposals) {
    if (proposal.status === "rejected" || proposal.status === "superseded") continue;
    ctx.db.orchProposals.update({
      ...proposal,
      status: "superseded",
    });
  }
}

function isActiveInstanceStatus(status: OrchestrationStatus): boolean {
  return status === "pending"
    || status === "running"
    || status === "paused"
    || status === "waiting-start"
    || status === "waiting-approval"
    || status === "waiting-feedback";
}

/** 复用原活跃实例入口，损坏冻结事实不能隐藏同需求已有执行。 */
function findActiveInstanceByIntake(
  ctx: Pick<ApiHandlerContext, "db" | "localWorkspaceOnly">,
  workspaceId: WorkspaceId,
  intakeId: IntakeId,
): OrchestrationInstance | null {
  return listActiveInstancesByIntake(ctx, workspaceId, intakeId)[0] ?? null;
}

/** 本机在归一化前严格读取冻结身份；远程沿用原查询口径。 */
function listActiveInstancesByIntake(
  ctx: Pick<ApiHandlerContext, "db" | "localWorkspaceOnly">,
  workspaceId: WorkspaceId,
  intakeId: IntakeId,
): OrchestrationInstance[] {
  return ctx.db.orchInstances
    .listByWorkspace(workspaceId, { strictScope: ctx.localWorkspaceOnly === true })
    .filter((item) => item.intakeSnapshot.id === intakeId && isActiveInstanceStatus(item.status));
}

function validateRoleExecutionConfigInput(ctx: ApiHandlerContext, raw: any): string | null {
  if (!raw || typeof raw !== "object") return "参数错误：role.executionConfig";
  const preferredEngine = String(raw.preferredEngine ?? "").trim();
  if (preferredEngine !== "claude" && preferredEngine !== "codex") {
    return "参数错误：role.executionConfig.preferredEngine";
  }

  const engineProfiles = raw.engineProfiles;
  if (!engineProfiles || typeof engineProfiles !== "object") {
    return "参数错误：role.executionConfig.engineProfiles";
  }

  const enabledEngines = getEnabledRoleExecutionEngines(raw, preferredEngine === "claude" ? "claude" : "codex");
  if (!enabledEngines.length) return "参数错误：role.executionConfig.engineProfiles 至少启用一个引擎";
  if (!isRoleExecutionEngineEnabled(raw, preferredEngine === "claude" ? "claude" : "codex", preferredEngine === "claude" ? "claude" : "codex")) {
    return "参数错误：role.executionConfig.preferredEngine 必须是已启用引擎";
  }

  for (const engine of ["claude", "codex"] as const) {
    const profile = (engineProfiles as Record<string, any>)[engine];
    if (!profile || typeof profile !== "object") return `参数错误：role.executionConfig.engineProfiles.${engine}`;
    const mode = String(profile.mode ?? "").trim();
    if (mode !== "auto" && mode !== "custom") {
      return `参数错误：role.executionConfig.engineProfiles.${engine}.mode`;
    }
    if (typeof profile.enabled !== "boolean") {
      return `参数错误：role.executionConfig.engineProfiles.${engine}.enabled`;
    }
    if (!profile.enabled || mode !== "custom") continue;

    const customConfig = profile.customConfig;
    if (!customConfig || typeof customConfig !== "object") {
      return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig`;
    }
    const model = String(customConfig.model ?? "").trim();
    const rawEffort = customConfig.effort;
    const accessMode = String(customConfig.accessMode ?? "").trim();
    const rawAutoCompactPct = customConfig.autoCompactPct;
    const rawContextWindow = customConfig.contextWindow;
    if (!model) return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.model`;
    if (rawEffort != null && typeof rawEffort !== "string") {
      return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.effort`;
    }
    try {
      assertClientReasoningEffortSupported(ctx.db, engine, model, rawEffort);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.effort：${message}`;
    }
    if (accessMode !== "read-only" && accessMode !== "current" && accessMode !== "full-access") {
      return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.accessMode`;
    }
    if (rawAutoCompactPct != null) {
      const autoCompactPct = Number(rawAutoCompactPct);
      if (!Number.isFinite(autoCompactPct) || autoCompactPct < 50 || autoCompactPct > 99) {
        return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.autoCompactPct`;
      }
    }
    if (rawContextWindow != null) {
      const contextWindow = Number(rawContextWindow);
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        return `参数错误：role.executionConfig.engineProfiles.${engine}.customConfig.contextWindow`;
      }
    }
  }
  return null;
}

/** 解析可选字符串覆盖；空字符串表示不覆盖。 */
function parseOptionalStringOverride(value: unknown, field: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, message: `参数错误：${field}` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed || null };
}

/** 解析 effort 覆盖；显式 null/空字符串表示运行时不发送 effort。 */
function parseOptionalEffortOverride(
  raw: Record<string, unknown>,
  field: string,
): { ok: true; hasValue: boolean; value: string | null } | { ok: false; message: string } {
  if (!Object.prototype.hasOwnProperty.call(raw, "effort")) return { ok: true, hasValue: false, value: null };
  const value = raw.effort;
  if (value == null || value === "") return { ok: true, hasValue: true, value: null };
  if (typeof value !== "string") return { ok: false, message: `参数错误：${field}` };
  return { ok: true, hasValue: true, value: value.trim() || null };
}

function parseOptionalBooleanParam(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  raw: unknown,
  field: string,
): boolean | null {
  if (raw == null) return false;
  if (typeof raw === "boolean") return raw;
  badParam(ctx, req, field);
  return null;
}

/** 解析 Server 侧共享可见资源白名单；undefined 表示不限制，数组表示按 ID 限定。 */
function normalizeAllowedResourceIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return Array.from(new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean)));
}

function resolveRequiredManualReviewFeedback(
  nodeState: OrchestrationInstance["nodeStates"][string],
  action: FeedbackAction,
  feedback: string | null,
  targetNodeId: string | null,
  hasFeedbackImages = false,
): string | null {
  if (action === "rework_to_target") {
    if (!String(targetNodeId ?? "").trim()) {
      return "驳回到指定节点时必须选择目标节点";
    }
    if (!String(feedback ?? "").trim() && !hasFeedbackImages) {
      return "驳回到指定节点时必须填写退回说明或附图";
    }
    return null;
  }
  if (String(feedback ?? "").trim() || hasFeedbackImages) return null;
  if (!nodeState || nodeState.status !== "waiting-approval") return null;
  if (action === "approve" && nodeState.conclusion?.nextAction === "rework") {
    return "确认退回修改时必须填写改进意见或附图";
  }
  if (action === "retry" || action === "resume_with_input") {
    return "退回重跑前必须填写改进意见或附图";
  }
  return null;
}

function normalizeRequester(raw: any): TaskIntake["requester"] {
  if (!raw || typeof raw !== "object") return null;
  const source = String(raw.source ?? "").trim();
  return {
    userId: nullableString(raw.userId),
    source: source === "ui" || source === "chat" || source === "api" || source === "scheduled_task" ? source : null,
  };
}

/** 规范化编排入口来源筛选；未知值按不筛选处理。 */
function normalizeTaskIntakeSourceKind(value: unknown): TaskIntakeSourceKind | null {
  const text = String(value ?? "").trim();
  return text === "requirement" || text === "scheduled_task" ? text : null;
}

/** 将 Server 可信的共享需求上下文绑定到 intake 快照，仅共享启动请求携带该字段。 */
function attachSharedRequirementContextToIntakeSnapshot(intake: TaskIntake, rawContext: unknown): TaskIntake {
  if (rawContext == null) return intake;
  const sharedContext = normalizeSharedRequirementContextForIntake(rawContext, intake.id);
  return { ...intake, sharedContext, readOnly: Boolean(sharedContext.readOnly) };
}

/** 校验共享需求上下文与当前 intake 匹配，防止 Host 使用错误共享区路由信息。 */
function normalizeSharedRequirementContextForIntake(rawContext: unknown, intakeId: string): SharedWorkspaceContextListItem {
  if (!rawContext || typeof rawContext !== "object" || Array.isArray(rawContext)) {
    throw new Error("invalid shared requirement context: object required");
  }
  const record = rawContext as Record<string, unknown>;
  const sharedWorkspaceId = nullableString(record.sharedWorkspaceId);
  const resourceId = nullableString(record.resourceId);
  const resourceType = nullableString(record.resourceType);
  const ownerUserId = nullableString(record.ownerUserId);
  if (!sharedWorkspaceId || resourceType !== "requirement" || resourceId !== String(intakeId) || !ownerUserId) {
    throw new Error(`invalid shared requirement context: intakeId=${intakeId}, resourceId=${resourceId ?? ""}`);
  }
  const visibilityText = nullableString(record.visibility);
  const visibility = (visibilityText === "private" || visibilityText === "participants" || visibilityText === "team" ? visibilityText : "participants") as SharedWorkspaceContextListItem["visibility"];
  const relatedReasons = Array.isArray(record.relatedReasons)
    ? record.relatedReasons
      .map((item) => String(item ?? "").trim())
      .filter((item): item is SharedWorkspaceContextListItem["relatedReasons"][number] => item === "owner" || item === "participant" || item === "todo" || item === "mention" || item === "trigger")
    : [];
  const createdAt = Number(record.createdAt ?? 0);
  const updatedAt = Number(record.updatedAt ?? 0);
  const publishedAt = record.publishedAt == null ? null : Number(record.publishedAt);
  return {
    id: (nullableString(record.id) ?? `server_req_${sharedWorkspaceId}_${resourceId}`) as SharedWorkspaceContextListItem["id"],
    sharedWorkspaceId: sharedWorkspaceId as SharedWorkspaceContextListItem["sharedWorkspaceId"],
    enterpriseId: nullableString(record.enterpriseId) ?? "",
    hostWorkspaceId: (nullableString(record.hostWorkspaceId) ?? "") as SharedWorkspaceContextListItem["hostWorkspaceId"],
    resourceType: "requirement",
    resourceId,
    ownerUserId,
    visibility,
    participantUserIds: normalizeStringArray(record.participantUserIds) ?? [],
    titleSummary: nullableString(record.titleSummary) ?? resourceId,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : null,
    relatedToMe: Boolean(record.relatedToMe),
    relatedReasons,
    readOnly: Boolean(record.readOnly),
  };
}
function nullableString(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

/** 校验并规范化处理人模板输入；模板绑定流程模板中的角色节点。 */
function parseAssigneeTemplateInput(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  workspaceId: WorkspaceId,
): (Omit<AssigneeTemplate, "id" | "createdAt" | "updatedAt" | "version"> & { id?: string | null; version?: number | null }) | null {
  const raw = (req.body as any)?.template;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    badParam(ctx, req, "template");
    return null;
  }
  const workflowId = nullableString(raw.workflowId) as WorkflowId | null;
  const name = nullableString(raw.name);
  if (!workflowId || !name) {
    badParam(ctx, req, "template.workflowId/name");
    return null;
  }
  const workflow = ctx.db.orchWorkflows.get(workflowId);
  if (!workflow || workflow.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "处理人模板绑定的流程不存在" } });
    return null;
  }
  const assigneesByNodeId = normalizeOrchestrationRunPlanAssignees(raw.nodeAssigneeUserIdsByNodeId);
  const roleNodeIds = workflow.nodes.filter((node) => node.type === "role").map((node) => String(node.id ?? "").trim()).filter(Boolean);
  const allowedNodeIds = new Set(roleNodeIds);
  const unknownNodeId = Object.keys(assigneesByNodeId).find((nodeId) => !allowedNodeIds.has(nodeId));
  if (unknownNodeId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `处理人模板包含非可分配节点：${unknownNodeId}` } });
    return null;
  }
  const rawStatus = nullableString(raw.status) ?? "draft";
  if (!isAssigneeTemplateStatus(rawStatus)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "处理人模板状态无效" } });
    return null;
  }
  const status = normalizeAssigneeTemplateStatus(rawStatus);
  const missingNodeId = status === "published"
    ? roleNodeIds.find((nodeId) => (assigneesByNodeId[nodeId]?.length ?? 0) === 0)
    : null;
  if (missingNodeId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `发布处理人模板前必须选择处理人：${missingNodeId}` } });
    return null;
  }
  return {
    id: nullableString(raw.id),
    workspaceId,
    workflowId,
    name,
    version: Number.isFinite(Number(raw.version)) ? Number(raw.version) : null,
    status,
    nodeAssigneeUserIdsByNodeId: assigneesByNodeId,
  };
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** 解析可选正整数参数，缺省返回 null 表示不改变旧接口完整返回语义。 */
function parseOptionalPositiveInt(value: unknown, max: number): number | null {
  if (value == null || String(value).trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(Math.floor(parsed), max);
}

type PendingMinePageInput = {
  workspaceId: WorkspaceId;
  limit: number;
  cursor: string | null;
  search: string | null;
  statuses: PendingMineListStatus[];
  allowedResourceIds: string[] | null;
  includeReceipts: boolean;
  /** 触发本次读取的请求标识，用于展示名降级日志可关联。 */
  requestId: string;
};

/** 构造当前用户待处理投影；仅返回编排相关待办/查收项。 */
function listPendingMineItems(
  ctx: ApiHandlerContext,
  input: PendingMinePageInput,
): {
  items: PendingMineListItem[];
  hasMore: boolean;
  nextCursor: string | null;
  statusCounts: Array<ListStatusCount<PendingMineListStatus>>;
  totalCount: number;
} {
  if (input.allowedResourceIds && input.allowedResourceIds.length === 0) {
    return { items: [], hasMore: false, nextCursor: null, statusCounts: [], totalCount: 0 };
  }
  const allowed = input.allowedResourceIds ? new Set(input.allowedResourceIds.map(String)) : null;
  const allItems = derivePendingMineItems(ctx, input.workspaceId, input.requestId)
    .filter((item) => input.includeReceipts || item.pendingMineStatus !== "receipt")
    .filter((item) => !allowed || allowed.has(String(item.intake.id)))
    .filter((item) => matchesPendingMineSearch(item, input.search));
  const statusCounts = countPendingMineStatuses(allItems);
  const filtered = input.statuses.length > 0
    ? allItems.filter((item) => input.statuses.includes(item.pendingMineStatus))
    : allItems;
  const afterCursor = applyPendingMineCursor(filtered, input.cursor);
  const page = afterCursor.slice(0, input.limit + 1);
  const hasMore = page.length > input.limit;
  const items = hasMore ? page.slice(0, input.limit) : page;
  return {
    items,
    hasMore,
    nextCursor: hasMore && items.length > 0 ? `${items[items.length - 1]!.reminder.updatedAt}:${items[items.length - 1]!.reminder.id}` : null,
    statusCounts,
    totalCount: filtered.length,
  };
}

/** 从实例事实实时推导待我处理项，避免依赖已加载分页列表。 */
function derivePendingMineItems(ctx: ApiHandlerContext, workspaceId: WorkspaceId, requestId: string): PendingMineListItem[] {
  const intakesById = new Map(ctx.db.orchIntakes.listByWorkspace(workspaceId).map((intake) => [String(intake.id), intake] as const));
  const grouped = new Map<string, OrchestrationInstanceSummary[]>();
  // 待办摘要里的流程名与活跃节点名同样按当前定义展示。
  const resolver = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead, requestId);
  const summaries = ctx.db.orchInstances.listSummariesByIntakeIds(workspaceId, Array.from(intakesById.keys()))
    .map((summary) => relabelInstanceSummary(summary, resolver.resolve(workspaceId, summary.workflowId)));
  for (const instance of summaries) {
    const intakeId = String(instance.intakeId ?? "").trim();
    if (!intakeId || !intakesById.has(intakeId)) continue;
    const list = grouped.get(intakeId) ?? [];
    list.push(instance);
    grouped.set(intakeId, list);
  }
  const items: PendingMineListItem[] = [];
  for (const [intakeId, instances] of grouped.entries()) {
    const item = buildPendingMineItem(ctx, workspaceId, intakesById.get(intakeId)!, intakeId as IntakeId, instances);
    if (item) items.push(item);
  }
  return items.sort((left, right) => right.reminder.updatedAt - left.reminder.updatedAt || String(right.reminder.id).localeCompare(left.reminder.id));
}

/** 为单个 intake 选择一个当前用户最需要关注的待办或查收项。 */
function buildPendingMineItem(
  ctx: ApiHandlerContext,
  workspaceId: WorkspaceId,
  intake: TaskIntake,
  intakeId: IntakeId,
  instances: OrchestrationInstanceSummary[],
): PendingMineListItem | null {
  const instance = pickPendingMineDisplayInstance(instances);
  if (!instance) return null;
  const title = String(instance.intakeTitle ?? intake.title ?? "").trim() || "未命名需求";
  const baseMeta = buildTaskIntakeListMetaFromInstance(instance, instances.length);

  if (instance.status === "completed") {
    const receipt = ctx.db.reminderReceipts.get("orch_instance", workspaceId, String(instance.id));
    if (receipt?.marker && receipt.marker === String(instance.id)) return null;
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "receipt",
      id: `orch:${instance.id}:receipt`,
      title,
      statusLabel: "待查收",
      tone: "success",
      summary: "编排执行已完成，等待您查看结果。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: false,
      primaryActionKind: "open_orch_artifacts",
      primaryActionLabel: "查看结果",
      ignoreMarker: String(instance.id),
      routeTarget: { workspaceId, intakeId, instanceId: instance.id },
    });
  }

  const waitingStart = findSummaryNodeByStatus(instance, "waiting-start");
  if (waitingStart) {
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "waiting-start",
      id: `orch:${instance.id}:start:${waitingStart.nodeId}`,
      title,
      statusLabel: "待启动",
      tone: "warning",
      summary: `${waitingStart.nodeLabel} · 等待人工启动`,
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "启动节点",
      ignoreMarker: `${instance.id}:start:${waitingStart.nodeId}:${instance.updatedAt}`,
      routeTarget: { workspaceId, intakeId, instanceId: instance.id, nodeId: waitingStart.nodeId },
    });
  }

  const waitingFeedback = findSummaryNodeByStatus(instance, "waiting-feedback");
  if (waitingFeedback) {
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "waiting-feedback",
      id: `orch:${instance.id}:feedback:${waitingFeedback.nodeId}`,
      title,
      statusLabel: instance.runSummary.statusLabel,
      tone: instance.runSummary.statusTone,
      summary: instance.runSummary.detailText ?? `${waitingFeedback.nodeLabel} · 等待人工处理`,
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "查看结果并处理",
      ignoreMarker: `${instance.id}:feedback:${waitingFeedback.nodeId}:${instance.updatedAt}`,
      routeTarget: { workspaceId, intakeId, instanceId: instance.id, nodeId: waitingFeedback.nodeId },
    });
  }

  const waitingApproval = findSummaryNodeByStatus(instance, "waiting-approval");
  if (waitingApproval) {
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "waiting-approval",
      id: `orch:${instance.id}:approval:${waitingApproval.nodeId}`,
      title,
      statusLabel: "待审批",
      tone: "info",
      summary: `${waitingApproval.nodeLabel} · 等待人工审核`,
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      primaryActionKind: "open_orch_primary_action",
      primaryActionLabel: "查看结果并审核",
      ignoreMarker: `${instance.id}:approval:${waitingApproval.nodeId}:${instance.updatedAt}`,
      routeTarget: { workspaceId, intakeId, instanceId: instance.id, nodeId: waitingApproval.nodeId },
    });
  }

  if (instance.status === "failed") {
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "failed",
      id: `orch:${instance.id}:failed`,
      title,
      statusLabel: "异常待处理",
      tone: "danger",
      summary: "执行失败，建议先进入执行工作区查看详情。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: `${instance.id}:failed:${instance.updatedAt}`,
      routeTarget: { workspaceId, intakeId, instanceId: instance.id, nodeId: null },
    });
  }

  if (instance.status === "paused") {
    return buildPendingMineListItem({
      workspaceId,
      intake,
      listMeta: baseMeta,
      status: "paused",
      id: `orch:${instance.id}:paused`,
      title,
      statusLabel: "暂停待处理",
      tone: "warning",
      summary: "执行已暂停，等待您继续处理。",
      updatedAt: Number(instance.updatedAt ?? Date.now()),
      isActionRequired: true,
      primaryActionKind: "open_orch_monitor",
      primaryActionLabel: "查看执行",
      ignoreMarker: `${instance.id}:paused:${instance.updatedAt}`,
      routeTarget: { workspaceId, intakeId, instanceId: instance.id, nodeId: null },
    });
  }

  return null;
}

/** 组装待我处理列表行，输出结构化状态和可点击提醒信息。 */
function buildPendingMineListItem(input: {
  workspaceId: WorkspaceId;
  intake: TaskIntake;
  listMeta: TaskIntakeListMeta;
  status: PendingMineListStatus;
  id: string;
  title: string;
  statusLabel: string;
  tone: ReminderTone;
  summary: string;
  updatedAt: number;
  isActionRequired: boolean;
  primaryActionKind: ReminderActionKind;
  primaryActionLabel: string;
  ignoreMarker: string;
  routeTarget: ReminderItem["routeTarget"];
}): PendingMineListItem {
  const reminder: ReminderItem = {
    id: input.id,
    sourceType: "orchestration",
    workspaceId: input.workspaceId,
    pendingMineStatus: input.status,
    displayKind: input.status === "receipt" ? "receipt" : "action",
    title: input.title,
    statusLabel: input.statusLabel,
    tone: input.tone,
    summary: input.summary,
    updatedAt: input.updatedAt,
    isActionRequired: input.isActionRequired,
    readState: "unread",
    primaryActionKind: input.primaryActionKind,
    primaryActionLabel: input.primaryActionLabel,
    ignoreMarker: input.ignoreMarker,
    routeTarget: input.routeTarget,
  };
  return {
    reminder,
    intake: input.intake,
    listMeta: {
      ...input.listMeta,
      attentionStatus: input.status,
      attentionLabel: input.statusLabel,
      attentionActionKind: input.primaryActionKind,
    },
    pendingMineStatus: input.status,
    pendingMineStatusLabel: pendingMineStatusLabel(input.status),
  };
}

/** 优先选取需要人工关注的实例；没有关注态时不返回。 */
function pickPendingMineDisplayInstance(instances: OrchestrationInstanceSummary[]): OrchestrationInstanceSummary | null {
  const preferred = instances
    .filter((instance) =>
      instance.status === "paused"
      || instance.status === "waiting-start"
      || instance.status === "waiting-approval"
      || instance.status === "waiting-feedback"
      || instance.status === "failed"
      || instance.status === "completed")
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return preferred[0] ?? null;
}

/** 从实例事实构造列表元数据，不读取提醒态。 */
function buildTaskIntakeListMetaFromInstance(instance: OrchestrationInstanceSummary, instanceCount: number): TaskIntakeListMeta {
  const progressTotal = Number(instance.runSummary.progressTotal ?? 0);
  const progressDone = Number(instance.runSummary.progressDone ?? 0);
  return {
    listStatus: instance.status,
    listStatusLabel: taskListStatusLabel(instance.status),
    workflowName: nullableString(instance.workflowName),
    instanceCount,
    latestInstance: null,
    progressText: progressTotal > 0 ? `${progressDone}/${progressTotal}` : null,
  };
}

/** 从实例摘要解析当前等待节点，用于生成待办入口。 */
function findSummaryNodeByStatus(
  instance: OrchestrationInstanceSummary,
  status: "waiting-start" | "waiting-feedback" | "waiting-approval",
): { nodeId: string; nodeLabel: string } | null {
  if (instance.runSummary.activeNodeStatus !== status) return null;
  const nodeId = String(instance.runSummary.activeNodeId ?? "").trim();
  if (!nodeId) return null;
  const nodeLabel = String(instance.runSummary.activeNodeLabel ?? "当前节点").trim() || "当前节点";
  return { nodeId, nodeLabel };
}

/** 待我处理第一版只搜索提醒标题/摘要和 intake 标题。 */
function matchesPendingMineSearch(item: PendingMineListItem, search: string | null): boolean {
  if (!search) return true;
  const keyword = search.toLowerCase();
  return [
    item.reminder.title,
    item.reminder.summary ?? "",
    item.intake.title ?? "",
  ].some((value) => String(value ?? "").toLowerCase().includes(keyword));
}

/** 按 updatedAt/id 游标裁剪待我处理列表。 */
function applyPendingMineCursor(items: PendingMineListItem[], cursor: string | null): PendingMineListItem[] {
  if (!cursor) return items;
  const sep = cursor.indexOf(":");
  if (sep <= 0) return items;
  const updatedAt = Number(cursor.substring(0, sep));
  const id = cursor.substring(sep + 1);
  if (!Number.isFinite(updatedAt) || !id) return items;
  return items.filter((item) => item.reminder.updatedAt < updatedAt || (item.reminder.updatedAt === updatedAt && item.reminder.id < id));
}

/** 统计待我处理状态数量；不带当前已选状态筛选。 */
function countPendingMineStatuses(items: PendingMineListItem[]): Array<ListStatusCount<PendingMineListStatus>> {
  const counts = new Map<PendingMineListStatus, number>();
  for (const item of items) {
    counts.set(item.pendingMineStatus, (counts.get(item.pendingMineStatus) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([status, count]) => ({ status, label: pendingMineStatusLabel(status), count }));
}

/** 规范化待我处理状态筛选参数，非法状态直接丢弃。 */
function normalizePendingMineListStatuses(value: unknown): PendingMineListStatus[] {
  const input = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const allowed = new Set<PendingMineListStatus>(["waiting-start", "waiting-approval", "waiting-feedback", "receipt", "failed", "paused"]);
  return Array.from(new Set(input.map((item) => String(item ?? "").trim()).filter((item): item is PendingMineListStatus => allowed.has(item as PendingMineListStatus))));
}

/** 返回待我处理状态的中文展示文案。 */
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

/** 返回编排入口流程状态的中文展示文案。 */
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

/** 计算实例节点完成进度，供列表紧凑展示。 */
function deriveInstanceProgressText(instance: OrchestrationInstance): string | null {
  const states = Object.values(instance.nodeStates ?? {});
  if (states.length === 0) return null;
  const completed = states.filter((state) => state.status === "completed" || state.status === "skipped").length;
  return `${completed}/${states.length}`;
}

/** 构造列表筛选签名，供前端识别分页条件变化。 */
function buildListCursorScope(input: {
  sourceKind: string;
  search?: string | null;
  statuses?: unknown[] | null;
  allowedResourceIds?: string[] | null;
  includeReceipts?: boolean;
}): string {
  return JSON.stringify({
    sourceKind: input.sourceKind,
    search: nullableString(input.search) ?? "",
    statuses: normalizeStringArray(input.statuses) ?? [],
    allowedResourceIds: input.allowedResourceIds ?? null,
    ...(typeof input.includeReceipts === "boolean" ? { includeReceipts: input.includeReceipts } : {}),
  });
}

/** 判断任务是否仍可能持有本地或 provider 执行。 */
function isExecutingAssetDraftJob(status: AssetGenerationJobStatus): boolean {
  return status === "queued"
    || status === "planning"
    || status === "collecting_context"
    || status === "generating"
    || status === "validating";
}

/** 删除前先确认关联 turn 已停止；执行态任务再用 CAS 切到 cancelled。 */
async function stopAssetDraftJobForDelete(ctx: ApiHandlerContext, job: AssetGenerationJob): Promise<void> {
  const threadId = job.threadId;
  if (threadId) {
    const activeTurn = await withAssetDraftDatabase(ctx, job.id, () => ctx.getActiveThreadTurn?.({
      workspaceId: job.workspaceId,
      threadId,
    }) ?? ctx.db.turns.listByThread(threadId).find((turn) => turn.status === "started") ?? null);
    if (activeTurn) {
      await interruptTurnBestEffort(ctx, {
        workspaceId: job.workspaceId,
        threadId,
        turnId: activeTurn.turnId,
      }, { ensureTerminalEvent: true });
    }
  }

  const progress = {
    stage: "cancelled" as const,
    headline: "生成任务已取消",
    detail: "删除助手会话前已停止本轮生成",
    percent: 100,
  };
  const transitioned = await withAssetDraftDatabase(ctx, job.id, () => ctx.db.db.transaction(() => {
    const result = ctx.db.orchAssetGenerationJobs.patchIfStatus(
      job.id,
      ["queued", "planning", "collecting_context", "generating", "validating"],
      { status: "cancelled", progress, failure: null, interactionRequest: null },
    );
    if (!result) return false;
    ctx.db.orchAssetJobEvents.append({
      jobId: job.id,
      type: "orch.assetDraft.statusChanged",
      payloadJson: JSON.stringify({
        from: result.previous.status,
        to: "cancelled",
        headline: progress.headline,
        detail: progress.detail,
        percent: progress.percent,
      }),
    });
    return true;
  })());
  if (transitioned) return;

  const latest = await withAssetDraftDatabase(ctx, job.id, () => ctx.db.orchAssetGenerationJobs.get(job.id));
  if (latest && isExecutingAssetDraftJob(latest.status)) {
    throw new Error(`草案任务取消状态竞争失败：jobId=${job.id}, status=${latest.status}`);
  }
}

function parseAccessMode(raw: unknown): AccessMode | null {
  const value = String(raw ?? "").trim();
  return value === "read-only" || value === "current" || value === "full-access"
    ? value
    : null;
}

function normalizeAutoCompactPct(raw: unknown): number | null {
  return typeof raw === "number" && raw >= 50 && raw <= 99 ? raw : null;
}

function normalizeContextWindow(raw: unknown): number | null {
  return typeof raw === "number" && raw > 0 ? Math.round(raw) : null;
}

/** 复用可信范围及资产读取，保留通知投递结果供提交后核验。 */
function createRequirementAnalysisService(ctx: ApiHandlerContext): RequirementAnalysisService {
  return new RequirementAnalysisService({
    db: ctx.db,
    withLegacyDatabase: ctx.withDatabase,
    intakeWorkspaceScope: ctx.intakeWorkspaceScope,
    orchAssetRuntimeRead: ctx.orchAssetRuntimeRead,
    threads: ctx.threads,
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    timeoutPolicy: ctx.timeoutPolicy,
    emitConversation: (event) => {
      if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
      return ctx.send({ t: "conversation.event", event });
    },
    emitRaw: (event) => {
      ctx.send({ t: "raw.event", event });
    },
  });
}

/** 资产生成与恢复使用请求同一许可和提交屏障，禁止异步服务回退裸库访问。 */
function createAssetDraftService(ctx: ApiHandlerContext): AssetDraftService {
  return new AssetDraftService({
    db: ctx.db,
    workspaces: ctx.workspaces,
    threads: ctx.threads,
    sessions: ctx.sessions,
    timeoutPolicy: ctx.timeoutPolicy,
    isTaskAdmissionPaused: ctx.isTaskAdmissionPaused,
    withLegacyDatabase: ctx.withDatabase,
    flushLocalEvents: ctx.flushLocalEvents,
    emitConversation: (event) => {
      if (ctx.onBeforeEmitConversationEvent) ctx.onBeforeEmitConversationEvent(event);
      ctx.send({ t: "conversation.event", event });
    },
    emitRaw: (event) => {
      ctx.send({ t: "raw.event", event });
    },
  });
}

function sendAssetDraftError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  if (error instanceof AssetDraftServiceError) {
    ctx.send({
      t: "api.res",
      id: req.id,
      status: error.status,
      body: error.details === undefined
        ? { ok: false, code: error.code, message: error.message }
        : { ok: false, code: error.code, message: error.message, details: error.details },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, code: "INTERNAL_ERROR", message } });
}

function str(req: ApiRequestMessage, key: string): string {
  return String((req.body as any)?.[key] ?? "").trim();
}

function ok(ctx: ApiHandlerContext, req: ApiRequestMessage, data: Record<string, unknown>): void {
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...data } });
}

function badParam(ctx: ApiHandlerContext, req: ApiRequestMessage, param: string): void {
  ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `参数错误：${param}` } });
}

/** 返回带示例的 feedback action 参数错误，帮助调用方选择正确动作。 */
function badFeedbackActionParam(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: ORCH_FEEDBACK_ACTION_ERROR_MESSAGE } });
}

function notFoundWs(ctx: ApiHandlerContext, req: ApiRequestMessage, workspaceId: WorkspaceId): void {
  ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
}

function resolveSkillPackageAction(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
): { workspaceId: WorkspaceId; workspacePath: string; skill: SkillDefinition } | null {
  const workspaceId = str(req, "workspaceId") as WorkspaceId;
  const skillId = str(req, "skillId") as SkillId;
  if (!workspaceId || !skillId) {
    badParam(ctx, req, "workspaceId/skillId");
    return null;
  }
  const workspacePath = ctx.workspaces.get(workspaceId);
  if (!workspacePath) {
    notFoundWs(ctx, req, workspaceId);
    return null;
  }
  const skill = ctx.db.orchSkills.get(skillId);
  if (!skill) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `Skill 不存在：${skillId}` } });
    return null;
  }
  if (skill.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: "无权访问其他工作区的 Skill" } });
    return null;
  }
  return { workspaceId, workspacePath, skill };
}

function normalizeSkillPackageTargets(raw: unknown, skill: SkillDefinition): SkillTargetEngine[] {
  const requested = Array.isArray(raw) && raw.length
    ? raw
    : (skill.installTargets?.length ? skill.installTargets : skill.targetEngines);
  const allowed = new Set(skill.targetEngines);
  return [...new Set(requested.map((item) => String(item ?? "").trim()))]
    .filter((item): item is SkillTargetEngine => (item === "codex" || item === "claude") && allowed.has(item as SkillTargetEngine));
}

function rejectBuiltinAssetDelete(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  asset: Pick<RoleDefinition | WorkflowDefinition | ToolsetDefinition | KnowledgeBundleDefinition | SkillDefinition, "kind"> | null | undefined,
  label: string,
): boolean {
  if (asset?.kind !== "builtin") return false;
  ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: `${label}不可删除` } });
  return true;
}

/** 除非 Server 显式授权，Client Host 不允许通过 upsert 覆盖内置资产定义。 */
function rejectBuiltinAssetUpsert(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  asset: Pick<RoleDefinition | WorkflowDefinition | ToolsetDefinition | KnowledgeBundleDefinition | SkillDefinition, "kind"> | null | undefined,
  incomingKind: unknown,
  label: string,
): boolean {
  if ((req.body as any)?.allowBuiltinAssetUpdate === true) return false;
  if (asset?.kind !== "builtin" && String(incomingKind ?? "").trim() !== "builtin") return false;
  ctx.send({ t: "api.res", id: req.id, status: 403, body: { ok: false, message: `${label} 仅超管可修改` } });
  return true;
}

