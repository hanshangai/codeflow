import type {
  WorkspaceId,
  OrchAssetBundlesExportRequestBody,
  OrchAssetBundlesExportResponseBody,
  OrchAssetBundlesImportRequestBody,
  OrchAssetBundlesImportResponseBody,
  OrchAssetDraftGenerateRequestBody,
  OrchAssetDraftGenerateResponseBody,
  OrchAssetDraftGetRequestBody,
  OrchAssetDraftGetResponseBody,
  OrchAssetDraftApplyRequestBody,
  OrchAssetDraftApplyResponseBody,
  OrchAssetDraftJobGetRequestBody,
  OrchAssetDraftJobGetResponseBody,
  OrchAssetDraftJobDeleteRequestBody,
  OrchAssetDraftJobDeleteResponseBody,
  OrchAssetDraftJobsListRequestBody,
  OrchAssetDraftJobsListResponseBody,
  OrchAssetDraftJobResumeRequestBody,
  OrchAssetDraftJobResumeResponseBody,
  OrchIntakesListResponseBody,
  OrchIntakesCreateRequestBody,
  OrchIntakesCreateResponseBody,
  OrchIntakesDeleteRequestBody,
  OrchIntakesDeleteResponseBody,
  OrchIntakesUpsertRequestBody,
  OrchIntakesUpsertResponseBody,
  OrchRequirementAnalysisCreateIntakesRequestBody,
  OrchRequirementAnalysisCreateIntakesResponseBody,
  OrchRequirementAnalysisMessagesSendRequestBody,
  OrchRequirementAnalysisMessagesSendResponseBody,
  OrchRequirementAnalysisSessionsArchiveRequestBody,
  OrchRequirementAnalysisSessionsArchiveResponseBody,
  OrchRequirementAnalysisSessionsCreateRequestBody,
  OrchRequirementAnalysisSessionsCreateResponseBody,
  OrchRequirementAnalysisSessionsGetRequestBody,
  OrchRequirementAnalysisSessionsGetResponseBody,
  OrchRequirementAnalysisSessionsListResponseBody,
  OrchPendingMineListRequestQuery,
  OrchPendingMineListResponseBody,
  OrchAssetGroupType,
  OrchAssetGroupsListResponseBody,
  OrchAssetGroupsCreateRequestBody,
  OrchAssetGroupsCreateResponseBody,
  OrchAssetGroupsRenameRequestBody,
  OrchAssetGroupsRenameResponseBody,
  OrchAssetGroupsDeleteRequestBody,
  OrchAssetGroupsDeleteResponseBody,
  OrchAssetGroupsAssignRequestBody,
  OrchAssetGroupsAssignResponseBody,
  OrchAssetApplicationRequest,
  OrchAssetApplication,
  OrchRolesListResponseBody,
  OrchAssetType,
  OrchBuiltinAssetCatalogResponseBody,
  OrchRolesUpsertRequestBody,
  OrchRolesUpsertResponseBody,
  OrchRolesDeleteRequestBody,
  OrchRolesDeleteResponseBody,
  OrchWorkflowsListResponseBody,
  OrchWorkflowsUpsertRequestBody,
  OrchWorkflowsUpsertResponseBody,
  OrchWorkflowsDeleteRequestBody,
  OrchWorkflowsDeleteResponseBody,
  OrchAssigneeTemplatesListResponseBody,
  OrchAssigneeTemplatesUpsertRequestBody,
  OrchAssigneeTemplatesUpsertResponseBody,
  OrchAssigneeTemplatesDeleteRequestBody,
  OrchWorkflowExecutionDefaultsGetResponseBody,
  OrchWorkflowExecutionDefaultsUpsertRequestBody,
  OrchWorkflowExecutionDefaultsUpsertResponseBody,
  OrchWorkflowExecutionDefaultsDeleteRequestBody,
  OrchToolsetsListResponseBody,
  OrchToolsetsUpsertRequestBody,
  OrchToolsetsUpsertResponseBody,
  OrchToolsetsDeleteRequestBody,
  OrchToolsetsDeleteResponseBody,
  OrchSkillsListResponseBody,
  OrchSkillsUpsertRequestBody,
  OrchSkillsUpsertResponseBody,
  OrchSkillsDeleteRequestBody,
  OrchSkillsDeleteResponseBody,
  OrchSkillsInstallStatusRequestBody,
  OrchSkillsInstallStatusResponseBody,
  OrchSkillsInstallRequestBody,
  OrchSkillsInstallResponseBody,
  OrchSkillsUninstallRequestBody,
  OrchSkillsUninstallResponseBody,
  OrchKnowledgeBundlesListResponseBody,
  OrchKnowledgeBundlesUpsertRequestBody,
  OrchKnowledgeBundlesUpsertResponseBody,
  OrchKnowledgeBundlesDeleteRequestBody,
  OrchKnowledgeBundlesDeleteResponseBody,
  OrchProposalsListResponseBody,
  OrchProposalsGetRequestBody,
  OrchProposalsGetResponseBody,
  OrchProposalsCreateRequestBody,
  OrchProposalsCreateResponseBody,
  OrchProposalsConfirmRequestBody,
  OrchProposalsConfirmResponseBody,
  OrchInstancesListResponseBody,
  OrchInstancesListRequestQuery,
  OrchInstancesGetRequestBody,
  OrchInstancesGetResponseBody,
  OrchInstancesRuntimePatchRequestBody,
  OrchInstancesRuntimePatchResponseBody,
  OrchInstancesReassignNodeRequestBody,
  OrchInstancesReassignNodeResponseBody,
  OrchArtifactGetRequestBody,
  OrchArtifactGetResponseBody,
  OrchArtifactsListRequestBody,
  OrchArtifactsListResponseBody,
  OrchArtifactFilesListRequestBody,
  OrchArtifactFilesListResponseBody,
  OrchArtifactReviseRequestBody,
  OrchArtifactReviseResponseBody,
  OrchEventsListRequestBody,
  OrchEventsListResponseBody,
  OrchNodeWorkItemsListRequestBody,
  OrchNodeWorkItemsListResponseBody,
  OrchNodeWorkItemEventsListRequestBody,
  OrchNodeWorkItemEventsListResponseBody,
  OrchRuntimeEvidenceGetRequestBody,
  OrchRuntimeEvidenceGetResponseBody,
  OrchPromptSnapshotGetRequestBody,
  OrchPromptSnapshotGetResponseBody,
  OrchPromptSnapshotsListRequestBody,
  OrchPromptSnapshotsListResponseBody,
  OrchInstancesStartRequestBody,
  OrchInstancesStartResponseBody,
  OrchInstancesPauseRequestBody,
  OrchInstancesResumeRequestBody,
  OrchInstancesCancelRequestBody,
  OrchNodesStartRequestBody,
  OrchNodesSkipRequestBody,
  OrchNodesCancelRequestBody,
  OrchInstancesFeedbackRequestBody,
  OrchInstancesRerunFromNodeRequestBody,
  OrchInstancesEnsureDiscussionThreadRequestBody,
  OrchInstancesEnsureDiscussionThreadResponseBody,
  OrchIntakesListRequestQuery,
  OrchRequirementAnalysisSessionsListRequestQuery,
} from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "../request";

export function listOrchAssetGroups(ctx: ApiRequestContext, workspaceId: WorkspaceId, assetType: OrchAssetGroupType) {
  return requestJson<OrchAssetGroupsListResponseBody>(ctx, { method: "GET", path: `/api/orch/asset-groups?workspaceId=${encodeURIComponent(String(workspaceId))}&assetType=${encodeURIComponent(assetType)}` });
}

export function createOrchAssetGroup(ctx: ApiRequestContext, body: OrchAssetGroupsCreateRequestBody) {
  return requestJson<OrchAssetGroupsCreateResponseBody>(ctx, { method: "POST", path: "/api/orch/asset-groups/create", body });
}

export function renameOrchAssetGroup(ctx: ApiRequestContext, body: OrchAssetGroupsRenameRequestBody) {
  return requestJson<OrchAssetGroupsRenameResponseBody>(ctx, { method: "POST", path: "/api/orch/asset-groups/rename", body });
}

export function deleteOrchAssetGroup(ctx: ApiRequestContext, body: OrchAssetGroupsDeleteRequestBody) {
  return requestJson<OrchAssetGroupsDeleteResponseBody>(ctx, { method: "POST", path: "/api/orch/asset-groups/delete", body });
}

export function assignOrchAssetGroup(ctx: ApiRequestContext, body: OrchAssetGroupsAssignRequestBody) {
  return requestJson<OrchAssetGroupsAssignResponseBody>(ctx, { method: "POST", path: "/api/orch/asset-groups/assign", body });
}

/** Enables one Server asset for the current personal or enterprise shared context by reference. */
export function applyOrchAsset(ctx: ApiRequestContext, body: OrchAssetApplicationRequest) {
  return requestJson<{ applications: OrchAssetApplication[] }>(ctx, {
    method: "POST",
    path: "/api/orch/assets/apply",
    body,
  });
}

/** Removes one application binding while preserving the source asset and its revision history. */
export function unapplyOrchAsset(ctx: ApiRequestContext, body: OrchAssetApplicationRequest) {
  return requestJson<{ removed: number }>(ctx, {
    method: "POST",
    path: "/api/orch/assets/unapply",
    body,
  });
}

/** Lists reference bindings without loading any asset definition body. */
export function listOrchAssetApplications(ctx: ApiRequestContext, target?: {
  kind: "personal" | "shared_workspace" | "enterprise_shared_workspaces";
  sharedWorkspaceId?: string;
  enterpriseId?: string;
}) {
  const params = new URLSearchParams();
  if (target?.kind === "shared_workspace") {
    params.set("targetKind", "shared_workspace");
    if (target.sharedWorkspaceId) params.set("sharedWorkspaceId", target.sharedWorkspaceId);
  } else if (target?.kind === "enterprise_shared_workspaces") {
    params.set("targetKind", "enterprise_shared_workspaces");
    if (target.enterpriseId) params.set("enterpriseId", target.enterpriseId);
  }
  return requestJson<{ applications: OrchAssetApplication[] }>(ctx, {
    method: "GET",
    path: `/api/orch/assets/applications${params.toString() ? `?${params.toString()}` : ""}`,
  });
}

// ── Intakes / Requirements ──────────────────────────────────────

export function listOrchIntakes(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: Omit<OrchIntakesListRequestQuery, "workspaceId">,
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  if (opts?.cursor) params.set("cursor", String(opts.cursor));
  if (opts?.limit && Number.isFinite(opts.limit)) params.set("limit", String(Math.max(1, Math.floor(opts.limit))));
  if (opts?.sourceKind) params.set("sourceKind", String(opts.sourceKind));
  if (opts?.onlyRelatedToMe != null) params.set("onlyRelatedToMe", String(Boolean(opts.onlyRelatedToMe)));
  if (opts?.search) params.set("search", String(opts.search));
  if (opts?.statuses?.length) params.set("statuses", opts.statuses.join(","));
  return requestJson<OrchIntakesListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/intakes?${params.toString()}`,
  });
}

export function createOrchIntake(ctx: ApiRequestContext, body: OrchIntakesCreateRequestBody) {
  return requestJson<OrchIntakesCreateResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/intakes/create",
    body,
  });
}

export function upsertOrchIntake(ctx: ApiRequestContext, body: OrchIntakesUpsertRequestBody) {
  return requestJson<OrchIntakesUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/intakes/upsert",
    body,
  });
}

export function deleteOrchIntake(ctx: ApiRequestContext, body: OrchIntakesDeleteRequestBody) {
  return requestJson<OrchIntakesDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/intakes/delete",
    body,
  });
}

export function listRequirementAnalysisSessions(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: Omit<OrchRequirementAnalysisSessionsListRequestQuery, "workspaceId">,
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  if (opts?.cursor) params.set("cursor", String(opts.cursor));
  if (opts?.limit && Number.isFinite(opts.limit)) params.set("limit", String(Math.max(1, Math.floor(opts.limit))));
  if (opts?.onlyRelatedToMe != null) params.set("onlyRelatedToMe", String(Boolean(opts.onlyRelatedToMe)));
  if (opts?.search) params.set("search", String(opts.search));
  if (opts?.statuses?.length) params.set("statuses", opts.statuses.join(","));
  return requestJson<OrchRequirementAnalysisSessionsListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/requirement-analysis/sessions?${params.toString()}`,
  });
}

export function listPendingMineItems(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: Omit<OrchPendingMineListRequestQuery, "workspaceId">,
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  if (opts?.cursor) params.set("cursor", String(opts.cursor));
  if (opts?.limit && Number.isFinite(opts.limit)) params.set("limit", String(Math.max(1, Math.floor(opts.limit))));
  if (opts?.onlyRelatedToMe != null) params.set("onlyRelatedToMe", String(Boolean(opts.onlyRelatedToMe)));
  if (opts?.search) params.set("search", String(opts.search));
  if (opts?.statuses?.length) params.set("statuses", opts.statuses.join(","));
  return requestJson<OrchPendingMineListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/pending-mine?${params.toString()}`,
  });
}

export function createRequirementAnalysisSession(ctx: ApiRequestContext, body: OrchRequirementAnalysisSessionsCreateRequestBody) {
  return requestJson<OrchRequirementAnalysisSessionsCreateResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/requirement-analysis/sessions/create",
    body,
  });
}

export function getRequirementAnalysisSession(ctx: ApiRequestContext, body: OrchRequirementAnalysisSessionsGetRequestBody) {
  return requestJson<OrchRequirementAnalysisSessionsGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/requirement-analysis/sessions/get",
    body,
  });
}

export function archiveRequirementAnalysisSession(
  ctx: ApiRequestContext,
  body: OrchRequirementAnalysisSessionsArchiveRequestBody,
) {
  return requestJson<OrchRequirementAnalysisSessionsArchiveResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/requirement-analysis/sessions/archive",
    body,
  });
}

export function sendRequirementAnalysisMessage(ctx: ApiRequestContext, body: OrchRequirementAnalysisMessagesSendRequestBody) {
  return requestJson<OrchRequirementAnalysisMessagesSendResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/requirement-analysis/messages/send",
    body,
  });
}

export function createRequirementAnalysisIntakes(
  ctx: ApiRequestContext,
  body: OrchRequirementAnalysisCreateIntakesRequestBody,
) {
  return requestJson<OrchRequirementAnalysisCreateIntakesResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/requirement-analysis/create-intakes",
    body,
  });
}

// ── Roles ────────────────────────────────────────────────────────

/** 默认读取管理资产库；执行用途显式读取目标 Client 的角色。 */
export function listOrchRoles(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
  return requestJson<OrchRolesListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/roles?workspaceId=${encodeURIComponent(String(workspaceId))}${purpose ? "&purpose=execution" : ""}`,
  });
}

/** 无工作区只读预览：按类型读取已发布内置资产，不依赖 workspaceId。 */
export function listBuiltinOrchAssets(ctx: ApiRequestContext, assetType: OrchAssetType) {
  return requestJson<OrchBuiltinAssetCatalogResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/builtin-assets?assetType=${encodeURIComponent(assetType)}`,
  });
}

export function upsertOrchRole(ctx: ApiRequestContext, body: OrchRolesUpsertRequestBody) {
  return requestJson<OrchRolesUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/roles/upsert",
    body,
  });
}

export function deleteOrchRole(ctx: ApiRequestContext, body: OrchRolesDeleteRequestBody) {
  return requestJson<OrchRolesDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/roles/delete",
    body,
  });
}

export function startAssetAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftGenerateRequestBody) {
  return requestJson<OrchAssetDraftGenerateResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/generate",
    body,
  });
}

export function startRoleAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftGenerateRequestBody) {
  return startAssetAssistantJob(ctx, body);
}

export function getAssetAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobGetRequestBody) {
  return requestJson<OrchAssetDraftJobGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/jobs/get",
    body,
  });
}

export function getRoleAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobGetRequestBody) {
  return getAssetAssistantJob(ctx, body);
}

/** 列出最近助手草案任务，用于资产页左侧会话列表恢复。 */
export function listAssetAssistantJobs(ctx: ApiRequestContext, body: OrchAssetDraftJobsListRequestBody) {
  return requestJson<OrchAssetDraftJobsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/jobs/list",
    body,
  });
}

export function listRoleAssistantJobs(ctx: ApiRequestContext, body: OrchAssetDraftJobsListRequestBody) {
  return listAssetAssistantJobs(ctx, body);
}

/** 删除助手草案任务及其关联会话记录。 */
export function deleteAssetAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobDeleteRequestBody) {
  return requestJson<OrchAssetDraftJobDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/jobs/delete",
    body,
  });
}

export function deleteRoleAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobDeleteRequestBody) {
  return deleteAssetAssistantJob(ctx, body);
}

export function resumeAssetAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobResumeRequestBody) {
  return requestJson<OrchAssetDraftJobResumeResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/jobs/resume",
    body,
  });
}

export function resumeRoleAssistantJob(ctx: ApiRequestContext, body: OrchAssetDraftJobResumeRequestBody) {
  return resumeAssetAssistantJob(ctx, body);
}

export function getAssetAssistantResult(ctx: ApiRequestContext, body: OrchAssetDraftGetRequestBody) {
  return requestJson<OrchAssetDraftGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/get",
    body,
  });
}

export function getRoleAssistantResult(ctx: ApiRequestContext, body: OrchAssetDraftGetRequestBody) {
  return getAssetAssistantResult(ctx, body);
}

/** 应用已通过校验的资产草案；正式资产版本由 Client 侧统一记录。 */
export function applyAssetAssistantDraft(ctx: ApiRequestContext, body: OrchAssetDraftApplyRequestBody) {
  return requestJson<OrchAssetDraftApplyResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-drafts/apply",
    body,
  });
}

export function applyRoleAssistantDraft(ctx: ApiRequestContext, body: OrchAssetDraftApplyRequestBody) {
  return applyAssetAssistantDraft(ctx, body);
}

export function exportOrchAssetBundle(ctx: ApiRequestContext, body: OrchAssetBundlesExportRequestBody) {
  return requestJson<OrchAssetBundlesExportResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-bundles/export",
    body,
  });
}

export function importOrchAssetBundle(ctx: ApiRequestContext, body: OrchAssetBundlesImportRequestBody) {
  return requestJson<OrchAssetBundlesImportResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/asset-bundles/import",
    body,
  });
}

/** 桌面单次复制完整依赖图；调用方仅在实际本机资产页提供入口。 */
export function copyPersonalOrchAsset(ctx: ApiRequestContext, body: { workspaceId: WorkspaceId; assetType: OrchAssetType; assetId: string }) {
  return requestJson<{ imported: OrchAssetBundlesImportResponseBody["imported"] & { rootAssetId: string } }>(ctx, {
    method: "POST", path: "/api/orch/assets/copy", body,
  });
}

// ── Workflows ────────────────────────────────────────────────────

/** 默认读取管理资产库；执行用途显式读取目标 Client 的流程。 */
export function listOrchWorkflows(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
  return requestJson<OrchWorkflowsListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/workflows?workspaceId=${encodeURIComponent(String(workspaceId))}${purpose ? "&purpose=execution" : ""}`,
  });
}

export function upsertOrchWorkflow(ctx: ApiRequestContext, body: OrchWorkflowsUpsertRequestBody) {
  return requestJson<OrchWorkflowsUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/workflows/upsert",
    body,
  });
}

export function deleteOrchWorkflow(ctx: ApiRequestContext, body: OrchWorkflowsDeleteRequestBody) {
  return requestJson<OrchWorkflowsDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/workflows/delete",
    body,
  });
}

export function listOrchAssigneeTemplates(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  workflowId?: string | null,
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  if (workflowId) params.set("workflowId", String(workflowId));
  return requestJson<OrchAssigneeTemplatesListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/assignee-templates?${params.toString()}`,
  });
}

export function upsertOrchAssigneeTemplate(ctx: ApiRequestContext, body: OrchAssigneeTemplatesUpsertRequestBody) {
  return requestJson<OrchAssigneeTemplatesUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/assignee-templates/upsert",
    body,
  });
}

export function deleteOrchAssigneeTemplate(ctx: ApiRequestContext, body: OrchAssigneeTemplatesDeleteRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/assignee-templates/delete",
    body,
  });
}

/** 读取某流程在本工作区的执行默认值；未配置时后端返回 null。 */
export function getOrchWorkflowExecutionDefault(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  workflowId: string,
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  params.set("workflowId", String(workflowId));
  return requestJson<OrchWorkflowExecutionDefaultsGetResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/workflow-execution-default?${params.toString()}`,
  });
}

/** 保存流程执行默认值：该流程内所有角色统一按此引擎与模型执行。 */
export function upsertOrchWorkflowExecutionDefault(ctx: ApiRequestContext, body: OrchWorkflowExecutionDefaultsUpsertRequestBody) {
  return requestJson<OrchWorkflowExecutionDefaultsUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/workflow-execution-default/upsert",
    body,
  });
}

/** 清除流程执行默认值，恢复为角色自身配置。 */
export function deleteOrchWorkflowExecutionDefault(ctx: ApiRequestContext, body: OrchWorkflowExecutionDefaultsDeleteRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/workflow-execution-default/delete",
    body,
  });
}

// ── Toolsets ────────────────────────────────────────────────────

/** 管理列表来自 Server；执行用途读取实际承载工作区的 Client。 */
export function listOrchToolsets(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
  return requestJson<OrchToolsetsListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/toolsets?workspaceId=${encodeURIComponent(String(workspaceId))}${purpose ? "&purpose=execution" : ""}`,
  });
}

export function upsertOrchToolset(ctx: ApiRequestContext, body: OrchToolsetsUpsertRequestBody) {
  return requestJson<OrchToolsetsUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/toolsets/upsert",
    body,
  });
}

export function deleteOrchToolset(ctx: ApiRequestContext, body: OrchToolsetsDeleteRequestBody) {
  return requestJson<OrchToolsetsDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/toolsets/delete",
    body,
  });
}

// ── Skills ─────────────────────────────────────────────────────

/** 执行用途与角色/流程保持同一 Host 资产读取边界。 */
export function listOrchSkills(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
  return requestJson<OrchSkillsListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/skills?workspaceId=${encodeURIComponent(String(workspaceId))}${purpose ? "&purpose=execution" : ""}`,
  });
}

export function upsertOrchSkill(ctx: ApiRequestContext, body: OrchSkillsUpsertRequestBody) {
  return requestJson<OrchSkillsUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/skills/upsert",
    body,
  });
}

export function deleteOrchSkill(ctx: ApiRequestContext, body: OrchSkillsDeleteRequestBody) {
  return requestJson<OrchSkillsDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/skills/delete",
    body,
  });
}

export function getOrchSkillInstallStatus(ctx: ApiRequestContext, body: OrchSkillsInstallStatusRequestBody) {
  return requestJson<OrchSkillsInstallStatusResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/skills/install-status?workspaceId=${encodeURIComponent(String(body.workspaceId))}&skillId=${encodeURIComponent(String(body.skillId))}`,
  });
}

export function installOrchSkillPackage(ctx: ApiRequestContext, body: OrchSkillsInstallRequestBody) {
  return requestJson<OrchSkillsInstallResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/skills/install",
    body,
  });
}

export function uninstallOrchSkillPackage(ctx: ApiRequestContext, body: OrchSkillsUninstallRequestBody) {
  return requestJson<OrchSkillsUninstallResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/skills/uninstall",
    body,
  });
}

// ── Knowledge Bundles ───────────────────────────────────────────

/** 执行用途读取 Host 知识包，管理用途保留 Server 修订。 */
export function listOrchKnowledgeBundles(ctx: ApiRequestContext, workspaceId: WorkspaceId, purpose?: "execution") {
  return requestJson<OrchKnowledgeBundlesListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/knowledge-bundles?workspaceId=${encodeURIComponent(String(workspaceId))}${purpose ? "&purpose=execution" : ""}`,
  });
}

export function upsertOrchKnowledgeBundle(ctx: ApiRequestContext, body: OrchKnowledgeBundlesUpsertRequestBody) {
  return requestJson<OrchKnowledgeBundlesUpsertResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/knowledge-bundles/upsert",
    body,
  });
}

export function deleteOrchKnowledgeBundle(ctx: ApiRequestContext, body: OrchKnowledgeBundlesDeleteRequestBody) {
  return requestJson<OrchKnowledgeBundlesDeleteResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/knowledge-bundles/delete",
    body,
  });
}

// ── Proposals ────────────────────────────────────────────────────

/** 按页读取执行提案摘要，旧 Client 仍可返回没有分页字段的完整列表。 */
export function listOrchProposals(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  opts?: { onlyRelatedToMe?: boolean | null; cursor?: string | null },
) {
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  params.set("summaryOnly", "true");
  params.set("limit", "200");
  if (opts?.cursor) params.set("cursor", opts.cursor);
  if (opts?.onlyRelatedToMe != null) params.set("onlyRelatedToMe", String(Boolean(opts.onlyRelatedToMe)));
  return requestJson<OrchProposalsListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/proposals?${params.toString()}`,
  });
}

export function getOrchProposal(ctx: ApiRequestContext, body: OrchProposalsGetRequestBody) {
  return requestJson<OrchProposalsGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/proposals/get",
    body,
  });
}

export function createOrchProposal(ctx: ApiRequestContext, body: OrchProposalsCreateRequestBody) {
  return requestJson<OrchProposalsCreateResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/proposals/create",
    body,
  });
}

export function confirmOrchProposal(ctx: ApiRequestContext, body: OrchProposalsConfirmRequestBody) {
  return requestJson<OrchProposalsConfirmResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/proposals/confirm",
    body,
  });
}

// ── Instances ────────────────────────────────────────────────────

/** 获取编排实例轻量摘要列表，详情数据通过 getOrchInstance 按需加载。 */
export function listOrchInstances(
  ctx: ApiRequestContext,
  workspaceId: WorkspaceId,
  options: Omit<OrchInstancesListRequestQuery, "workspaceId"> = {},
) {
  const rawLimit = Number(options.limit ?? 50);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
  const params = new URLSearchParams();
  params.set("workspaceId", String(workspaceId));
  params.set("limit", String(limit));
  if (options.sourceKind) params.set("sourceKind", String(options.sourceKind));
  if (options.onlyRelatedToMe != null) params.set("onlyRelatedToMe", String(Boolean(options.onlyRelatedToMe)));
  return requestJson<OrchInstancesListResponseBody>(ctx, {
    method: "GET",
    path: `/api/orch/instances?${params.toString()}`,
  });
}

/** 获取完整实例，并允许选择切换时取消大响应传输。 */
export function getOrchInstance(
  ctx: ApiRequestContext,
  body: OrchInstancesGetRequestBody,
  opts?: { signal?: AbortSignal },
) {
  return requestJson<OrchInstancesGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/instances/get",
    body,
    signal: opts?.signal,
  });
}

/** 获取实例运行态轻量补丁，避免监控兜底轮询拉完整实例详情。 */
export function getOrchInstanceRuntimePatch(ctx: ApiRequestContext, body: OrchInstancesRuntimePatchRequestBody) {
  return requestJson<OrchInstancesRuntimePatchResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/instances/runtime-patch",
    body,
  });
}

export function reassignOrchInstanceNode(ctx: ApiRequestContext, body: OrchInstancesReassignNodeRequestBody) {
  return requestJson<OrchInstancesReassignNodeResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/instances/reassign-node",
    body,
  });
}

/** 默认只拉产物元数据，正文由单条 get 按需读取。 */
export function listOrchArtifacts(
  ctx: ApiRequestContext,
  body: OrchArtifactsListRequestBody,
  opts?: { signal?: AbortSignal },
) {
  return requestJson<OrchArtifactsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/artifacts/list",
    body: { ...body, includeContent: body.includeContent ?? false },
    signal: opts?.signal,
  });
}

export function getOrchArtifact(ctx: ApiRequestContext, body: OrchArtifactGetRequestBody) {
  return requestJson<OrchArtifactGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/artifacts/get",
    body,
  });
}

export function listOrchArtifactFiles(ctx: ApiRequestContext, body: OrchArtifactFilesListRequestBody) {
  return requestJson<OrchArtifactFilesListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/artifact-files/list",
    body,
  });
}

export function reviseOrchArtifact(ctx: ApiRequestContext, body: OrchArtifactReviseRequestBody) {
  return requestJson<OrchArtifactReviseResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/artifacts/revise",
    body,
  });
}

/** 读取实例事件目录，并允许实例切换取消旧请求。 */
export function listOrchEvents(
  ctx: ApiRequestContext,
  body: OrchEventsListRequestBody,
  opts?: { signal?: AbortSignal },
) {
  return requestJson<OrchEventsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/events/list",
    body,
    signal: opts?.signal,
  });
}

/** 分页读取节点工作项及进度。 */
export function listOrchNodeWorkItems(ctx: ApiRequestContext, body: OrchNodeWorkItemsListRequestBody) {
  return requestJson<OrchNodeWorkItemsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/node-work-items/list",
    body,
  });
}

/** 分页读取节点或单个工作项的审计事件。 */
export function listOrchNodeWorkItemEvents(ctx: ApiRequestContext, body: OrchNodeWorkItemEventsListRequestBody) {
  return requestJson<OrchNodeWorkItemEventsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/node-work-item-events/list",
    body,
  });
}

/** 读取运行证据目录；节点切换或关闭时允许取消聚合请求。 */
export function getOrchRuntimeEvidence(ctx: ApiRequestContext, body: OrchRuntimeEvidenceGetRequestBody, opts?: { signal?: AbortSignal }) {
  return requestJson<OrchRuntimeEvidenceGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/runtime-evidence/get",
    body,
    signal: opts?.signal,
  });
}

/** 读取 Prompt 快照目录，并允许实例切换取消旧请求。 */
export function listOrchPromptSnapshots(
  ctx: ApiRequestContext,
  body: OrchPromptSnapshotsListRequestBody,
  opts?: { signal?: AbortSignal },
) {
  return requestJson<OrchPromptSnapshotsListResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/prompt-snapshots/list",
    body: { includeContent: false, ...body },
    signal: opts?.signal,
  });
}

export function getOrchPromptSnapshot(ctx: ApiRequestContext, body: OrchPromptSnapshotGetRequestBody) {
  return requestJson<OrchPromptSnapshotGetResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/prompt-snapshots/get",
    body,
  });
}

export function startOrchInstance(ctx: ApiRequestContext, body: OrchInstancesStartRequestBody) {
  return requestJson<OrchInstancesStartResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/instances/start",
    body,
  });
}

export function pauseOrchInstance(ctx: ApiRequestContext, body: OrchInstancesPauseRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/instances/pause",
    body,
  });
}

export function resumeOrchInstance(ctx: ApiRequestContext, body: OrchInstancesResumeRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/instances/resume",
    body,
  });
}

export function cancelOrchInstance(ctx: ApiRequestContext, body: OrchInstancesCancelRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/instances/cancel",
    body,
  });
}

/** 启动等待人工启动的节点：解除 waiting-start 门禁，执行由后端后台推进。 */
export function startOrchNode(ctx: ApiRequestContext, body: OrchNodesStartRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/nodes/start",
    body,
  });
}

/** 跳过 waiting-start 节点：节点标记为 skipped 后，后续执行由后端后台推进。 */
export function skipOrchNode(ctx: ApiRequestContext, body: OrchNodesSkipRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/nodes/skip",
    body,
  });
}

/** 停止单个节点：硬中断该节点 in-flight turn；节点会落 waiting-feedback，整体 instance 继续运行。 */
export function cancelOrchNode(ctx: ApiRequestContext, body: OrchNodesCancelRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/nodes/cancel",
    body,
  });
}

export function submitOrchFeedback(ctx: ApiRequestContext, body: OrchInstancesFeedbackRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/instances/feedback",
    body,
  });
}

/** 「从指定节点重跑」：刹停当前运行，重置显式影响集，再拉起调度。 */
export function rerunOrchInstanceFromNode(ctx: ApiRequestContext, body: OrchInstancesRerunFromNodeRequestBody) {
  return requestJson<{}>(ctx, {
    method: "POST",
    path: "/api/orch/instances/rerun-from-node",
    body,
  });
}

export function ensureOrchDiscussionThread(
  ctx: ApiRequestContext,
  body: OrchInstancesEnsureDiscussionThreadRequestBody,
) {
  return requestJson<OrchInstancesEnsureDiscussionThreadResponseBody>(ctx, {
    method: "POST",
    path: "/api/orch/instances/discussion-thread/ensure",
    body,
  });
}
