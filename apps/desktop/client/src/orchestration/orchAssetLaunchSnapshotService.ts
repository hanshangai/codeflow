import {
  compareOrchAssetCodePoints,
  parseStandaloneRoleWorkflowId,
  type KnowledgeBundleId,
  type OrchAssetType,
  type OrchestrationAssetRuntimeSnapshot,
  type OrchestrationRuntimeAssetDefinitionByType,
  type OrchestrationRuntimeAssetSnapshotEntry,
  type RoleId,
  type SkillId,
  type ToolsetId,
  type WorkflowId,
  type WorkflowRuntimeDefinition,
  type WorkspaceId,
} from "@codeflowai/shared";

import type {
  OrchAssetAuthorityRuntimeAsset,
  OrchAssetAuthorityRuntimeReadService,
  OrchAssetAuthorityRuntimeReadSession,
} from "./orchAssetAuthorityRuntimeReadService.js";

type LaunchAssetSource<T extends OrchAssetType> = OrchAssetAuthorityRuntimeAsset<T>["source"];

export type OrchAssetLaunchSnapshotEntry<T extends OrchAssetType> = OrchestrationRuntimeAssetSnapshotEntry<T>;
export type OrchAssetLaunchSnapshot = OrchestrationAssetRuntimeSnapshot;

export class OrchAssetLaunchSnapshotError extends Error {
  /** Creates one explicit launch graph input, dependency or integrity failure. */
  constructor(
    readonly code: "ASSET_LAUNCH_INPUT_INVALID" | "ASSET_LAUNCH_DEPENDENCY_MISSING" | "ASSET_LAUNCH_GRAPH_INVALID" | "ASSET_CACHE_EXECUTION_REMOVED",
    message: string,
  ) {
    super(message);
    this.name = "OrchAssetLaunchSnapshotError";
  }
}

/** Resolves one complete launch asset graph from a single authority-pinned session. */
export class OrchAssetLaunchSnapshotService {
  private readonly openWorkspace: OrchAssetAuthorityRuntimeReadService["openWorkspace"];
  private readonly withWorkspace: OrchAssetAuthorityRuntimeReadService["withWorkspace"];

  /** Captures the existing Task 66 session factory and preserves its receiver. */
  constructor(reader: Pick<OrchAssetAuthorityRuntimeReadService, "openWorkspace"> & Partial<Pick<OrchAssetAuthorityRuntimeReadService, "withWorkspace">>) {
    const openWorkspace = reader?.openWorkspace;
    if (typeof openWorkspace !== "function") throw launchInputInvalid("资产运行读取服务未装配");
    this.openWorkspace = openWorkspace.bind(reader);
    this.withWorkspace = reader.withWorkspace?.bind(reader) ?? ((id, read, root) => read(this.openWorkspace(id, root)));
  }

  /** Resolves dependencies for an already-frozen proposal workflow without re-reading that workflow asset. */
  createFromWorkflow(workspaceId: WorkspaceId, workflow: WorkflowRuntimeDefinition): OrchAssetLaunchSnapshot {
    const normalizedWorkspaceId = requiredText(workspaceId, "workspaceId") as WorkspaceId;
    const workflowEntry = createDetachedWorkflowEntry(normalizedWorkspaceId, workflow, null);
    const standaloneRoleId = parseStandaloneRoleWorkflowId(workflowEntry.assetId);
    return this.withWorkspace(normalizedWorkspaceId, session => buildLaunchSnapshot(session, normalizedWorkspaceId, workflowEntry),
      standaloneRoleId ? { assetType: "role", assetId: standaloneRoleId } : { assetType: "workflow", assetId: workflowEntry.assetId });
  }

  /** Reads a scheduled workflow and all of its dependencies from one authority-pinned session. */
  createFromWorkflowId(workspaceId: WorkspaceId, workflowId: WorkflowId): OrchAssetLaunchSnapshot {
    const normalizedWorkspaceId = requiredText(workspaceId, "workspaceId") as WorkspaceId;
    const normalizedWorkflowId = requiredText(workflowId, "workflowId") as WorkflowId;
    return this.withWorkspace(normalizedWorkspaceId, session => {
      const cache = new Map<string, OrchAssetAuthorityRuntimeAsset<OrchAssetType>>();
      const workflowAsset = readRequiredAsset(
        session,
        normalizedWorkspaceId,
        cache,
        "workflow",
        normalizedWorkflowId,
        `工作流不存在：${normalizedWorkflowId}`,
      );
      return buildLaunchSnapshot(session, normalizedWorkspaceId, toDetachedEntry(workflowAsset), cache);
    }, { assetType: "workflow", assetId: normalizedWorkflowId });
  }
}

/** Resolves every runtime dependency before exposing a usable launch snapshot. */
function buildLaunchSnapshot(
  session: OrchAssetAuthorityRuntimeReadSession,
  workspaceId: WorkspaceId,
  workflow: OrchAssetLaunchSnapshotEntry<"workflow">,
  existingCache = new Map<string, OrchAssetAuthorityRuntimeAsset<OrchAssetType>>(),
): OrchAssetLaunchSnapshot {
  const roleIds = new Set<RoleId>();
  for (const node of workflow.definition.nodes) {
    if (node.type !== "role") continue;
    if (!node.roleId) throw launchGraphInvalid(`工作流角色节点未绑定角色：${node.id}`);
    roleIds.add(requiredText(node.roleId, `节点 ${node.id} roleId`) as RoleId);
  }

  const roles = readAssetMap(session, workspaceId, existingCache, "role", roleIds, "角色不存在");
  const knowledgeBundleIds = new Set<KnowledgeBundleId>(workflow.definition.workflowKnowledgeBundleIds ?? []);
  const toolsetIds = new Set<ToolsetId>();
  const skillIds = new Set<SkillId>();
  for (const node of workflow.definition.nodes) {
    for (const bundleId of node.knowledgeOverrideBundleIds ?? []) knowledgeBundleIds.add(bundleId);
  }
  for (const roleEntry of Object.values(roles)) {
    for (const bundleId of roleEntry.definition.defaultKnowledgeBundleIds ?? []) knowledgeBundleIds.add(bundleId);
    for (const ref of roleEntry.definition.toolRefs ?? []) toolsetIds.add(ref.toolsetId);
    for (const skillId of roleEntry.definition.defaultSkillIds ?? []) skillIds.add(skillId);
  }

  const knowledgeBundles = readAssetMap(
    session,
    workspaceId,
    existingCache,
    "knowledge_bundle",
    knowledgeBundleIds,
    "知识包不存在",
  );
  const toolsets = readAssetMap(session, workspaceId, existingCache, "toolset", toolsetIds, "工具集不存在");
  const skills = readAssetMap(session, workspaceId, existingCache, "skill", skillIds, "Skill 不存在");
  validateRoleToolReferences(roles, toolsets);

  return {
    authorityMode: session.authorityMode,
    workflow,
    roles,
    knowledgeBundles,
    toolsets,
    skills,
  };
}

/** Reads unique IDs in canonical order so launch snapshots are deterministic. */
function readAssetMap<T extends Exclude<OrchAssetType, "workflow">>(
  session: OrchAssetAuthorityRuntimeReadSession,
  workspaceId: WorkspaceId,
  cache: Map<string, OrchAssetAuthorityRuntimeAsset<OrchAssetType>>,
  assetType: T,
  assetIds: Set<string>,
  missingLabel: string,
): Record<string, OrchAssetLaunchSnapshotEntry<T>> {
  const entries = Object.create(null) as Record<string, OrchAssetLaunchSnapshotEntry<T>>;
  for (const assetId of [...assetIds].map((item) => requiredText(item, `${assetType} assetId`)).sort(compareOrchAssetCodePoints)) {
    entries[assetId] = toDetachedEntry(readRequiredAsset(
      session,
      workspaceId,
      cache,
      assetType,
      assetId,
      `${missingLabel}：${assetId}`,
    ));
  }
  return entries;
}

/** Reads and validates one dependency while preserving original reader failures. */
function readRequiredAsset<T extends OrchAssetType>(
  session: OrchAssetAuthorityRuntimeReadSession,
  workspaceId: WorkspaceId,
  cache: Map<string, OrchAssetAuthorityRuntimeAsset<OrchAssetType>>,
  assetType: T,
  assetId: string,
  missingMessage: string,
): OrchAssetAuthorityRuntimeAsset<T> {
  const cacheKey = `${assetType}:${assetId}`;
  const cached = cache.get(cacheKey) as OrchAssetAuthorityRuntimeAsset<T> | undefined;
  if (cached) return cached;
  const asset = session.getAsset(assetType, assetId);
  if (!asset) throw launchDependencyMissing(missingMessage);
  assertAssetIdentity(session, workspaceId, assetType, assetId, asset);
  const detached = cloneAuthorityAsset(asset);
  cache.set(cacheKey, detached as OrchAssetAuthorityRuntimeAsset<OrchAssetType>);
  return detached;
}

/** Rejects broken reader identity or authority composition before returning a snapshot. */
function assertAssetIdentity<T extends OrchAssetType>(
  session: OrchAssetAuthorityRuntimeReadSession,
  workspaceId: WorkspaceId,
  assetType: T,
  assetId: string,
  asset: OrchAssetAuthorityRuntimeAsset<T>,
): void {
  if (asset.assetType !== assetType || asset.assetId !== assetId || asset.definition.id !== assetId) {
    throw launchGraphInvalid(`${assetType} 资产身份不一致：${assetId}`);
  }
  if (asset.definition.workspaceId !== workspaceId) {
    throw launchGraphInvalid(`${assetType} 资产不属于运行工作区：${assetId}`);
  }
  if (asset.source.authorityMode !== session.authorityMode) {
    throw launchGraphInvalid(`${assetType} 资产来源与会话权威不一致：${assetId}`);
  }
}

/** Ensures each role tool reference resolves to a concrete tool inside its selected toolset. */
function validateRoleToolReferences(
  roles: Record<string, OrchAssetLaunchSnapshotEntry<"role">>,
  toolsets: Record<string, OrchAssetLaunchSnapshotEntry<"toolset">>,
): void {
  for (const role of Object.values(roles)) {
    for (const ref of role.definition.toolRefs ?? []) {
      const toolset = toolsets[ref.toolsetId];
      if (!toolset) throw launchDependencyMissing(`角色绑定的工具集不存在：${role.assetId}/${ref.toolsetId}`);
      if (!toolset.definition.tools.some((tool) => tool.id === ref.toolId)) {
        throw launchGraphInvalid(`角色绑定的工具不存在：${role.assetId}/${ref.toolsetId}/${ref.toolId}`);
      }
    }
  }
}

/** Creates a detached workflow entry from an existing proposal snapshot. */
function createDetachedWorkflowEntry(
  workspaceId: WorkspaceId,
  workflow: WorkflowRuntimeDefinition,
  source: LaunchAssetSource<"workflow"> | null,
): OrchAssetLaunchSnapshotEntry<"workflow"> {
  if (!workflow || typeof workflow !== "object") throw launchInputInvalid("workflow 非法");
  const runtimeWorkflow = cloneRuntimeDefinition<"workflow">("workflow", workflow);
  const workflowId = requiredText(runtimeWorkflow.id, "workflow.id");
  if (runtimeWorkflow.workspaceId !== workspaceId) throw launchInputInvalid("workflow 不属于运行工作区");
  return {
    assetType: "workflow",
    assetId: workflowId,
    definition: runtimeWorkflow,
    source: source ? structuredClone(source) : null,
  };
}

/** Clones one authority asset so callers cannot mutate the pinned session result. */
function cloneAuthorityAsset<T extends OrchAssetType>(
  asset: OrchAssetAuthorityRuntimeAsset<T>,
): OrchAssetAuthorityRuntimeAsset<T> {
  return structuredClone(asset);
}

/** Converts one validated authority asset into the launch snapshot representation. */
function toDetachedEntry<T extends OrchAssetType>(
  asset: OrchAssetAuthorityRuntimeAsset<T>,
): OrchAssetLaunchSnapshotEntry<T> {
  return {
    assetType: asset.assetType,
    assetId: asset.assetId,
    definition: cloneRuntimeDefinition(asset.assetType, asset.definition),
    source: structuredClone(asset.source),
  };
}

/** Clones one runtime definition and removes repository-owned presentation timestamps. */
function cloneRuntimeDefinition<T extends OrchAssetType>(
  assetType: T,
  definition: unknown,
): OrchestrationRuntimeAssetDefinitionByType[T] {
  const cloned = structuredClone(definition) as OrchestrationRuntimeAssetDefinitionByType[T] & {
    createdAt?: unknown;
    updatedAt?: unknown;
  };
  if (assetType === "skill") {
    const skill = cloned as OrchestrationRuntimeAssetDefinitionByType["skill"];
    if (typeof skill.skillMd !== "string" || !Array.isArray(skill.files)
      || typeof skill.packageHash !== "string" || !/^[0-9a-f]{64}$/.test(skill.packageHash)) {
      throw launchGraphInvalid("Skill 运行包定义不完整");
    }
  }
  delete cloned.createdAt;
  delete cloned.updatedAt;
  return cloned;
}

/** Requires an exact non-empty internal identity. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw launchInputInvalid(`${label} 非法`);
  return value;
}

/** Creates an explicit launch input error. */
function launchInputInvalid(message: string): OrchAssetLaunchSnapshotError {
  return new OrchAssetLaunchSnapshotError("ASSET_LAUNCH_INPUT_INVALID", message);
}

/** Creates an explicit missing dependency error. */
function launchDependencyMissing(message: string): OrchAssetLaunchSnapshotError {
  return new OrchAssetLaunchSnapshotError("ASSET_LAUNCH_DEPENDENCY_MISSING", message);
}

/** Creates an explicit launch graph integrity error. */
function launchGraphInvalid(message: string): OrchAssetLaunchSnapshotError {
  return new OrchAssetLaunchSnapshotError("ASSET_LAUNCH_GRAPH_INVALID", message);
}
