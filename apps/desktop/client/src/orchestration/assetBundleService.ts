import crypto from "node:crypto";

import { sanitizePathSegment } from "./artifactPathPolicy.js";
import {
  ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
  type EditableBundleKnowledgeBundle,
  type EditableBundleRole,
  type EditableBundleSkill,
  type EditableBundleToolset,
  type EditableBundleWorkflow,
  type OrchAssetBundle,
  type OrchAssetBundleImportCounts,
  type OrchAssetBundleImportMode,
  type OrchAssetBundleWarning,
  type OrchAssetType,
  normalizeOrchAssetDefinitionKind,
  normalizeOrchAssetBundleImportMode,
  type RoleDefinition,
  type KnowledgeBundleDefinition,
  type SkillDefinition,
  type ToolsetDefinition,
  type WorkflowDefinition,
  type WorkspaceId,
  workspaceIdAliasChain,
  workspaceIdsReferToSameWorkspace,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { ChatWorkflowRepo } from "../db/repos/chatWorkflowRepo.js";
import { assertCompleteOrchAssetBundle, validateBundle } from "./orchAssetBundleValidation.js";
export { assertCompleteOrchAssetBundle } from "./orchAssetBundleValidation.js";
import { logger } from "../logger.js";
import {
  defaultCodeflowaiConfig,
  ensureCodeflowaiConfig,
  readExistingCodeflowaiConfig,
} from "../codeflowai/codeflowaiConfig.js";

export type ImportedAssets = {
  roles: RoleDefinition[];
  knowledgeBundles: KnowledgeBundleDefinition[];
  skills: SkillDefinition[];
  toolsets: ToolsetDefinition[];
  workflows: WorkflowDefinition[];
  warnings: OrchAssetBundleWarning[];
  overwritten: OrchAssetBundleImportCounts;
  skipped: OrchAssetBundleImportCounts;
  copied: OrchAssetBundleImportCounts;
  pruned: OrchAssetBundleImportCounts;
};

type BundleAssetKind = "role" | "knowledge" | "skill" | "toolset" | "workflow";

type AssetLookupDb = Pick<ClientDb, "orchRoles" | "orchKnowledgeBundles" | "orchSkills" | "orchToolsets" | "orchWorkflows">;

type LegacyAsset =
  | RoleDefinition
  | WorkflowDefinition
  | KnowledgeBundleDefinition
  | ToolsetDefinition
  | SkillDefinition;

/** 导出流程依赖图；桌面复制要求完整，旧导出保持缺失引用告警行为。 */
export function exportWorkflowDependencyBundle(args: {
  db: Pick<ClientDb, "orchWorkflows" | "orchRoles" | "orchKnowledgeBundles" | "orchSkills" | "orchToolsets">;
  workspaceId: WorkspaceId;
  workflowIds: string[];
  strictDependencies?: boolean;
}): OrchAssetBundle {
  const workflows = selectExportAssets(args.workflowIds, id => args.db.orchWorkflows.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "流程");
  if (!workflows.length) {
    throw new Error("至少选择一个流程模板");
  }

  const roleIds = new Set<string>();
  const knowledgeBundleIds = new Set<string>();
  const skillIds = new Set<string>();
  const toolsetIds = new Set<string>();

  for (const workflow of workflows) {
    for (const bundleId of workflow.workflowKnowledgeBundleIds ?? []) knowledgeBundleIds.add(String(bundleId));
    for (const node of workflow.nodes) {
      if (node.roleId) roleIds.add(String(node.roleId));
      for (const bundleId of node.knowledgeOverrideBundleIds ?? []) knowledgeBundleIds.add(String(bundleId));
    }
  }

  const roles = selectExportAssets([...roleIds], id => args.db.orchRoles.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "角色");
  for (const role of roles) {
    for (const bundleId of role.defaultKnowledgeBundleIds ?? []) knowledgeBundleIds.add(String(bundleId));
    for (const skillId of role.defaultSkillIds ?? []) skillIds.add(String(skillId));
    for (const ref of role.toolRefs ?? []) toolsetIds.add(String(ref.toolsetId));
  }

  const knowledgeBundles = selectExportAssets([...knowledgeBundleIds], id => args.db.orchKnowledgeBundles.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "知识包");
  const skills = selectExportAssets([...skillIds], id => args.db.orchSkills.get(id as any,
    { requireCompletePackage: args.strictDependencies }), args, "Skill");
  const toolsets = selectExportAssets([...toolsetIds], id => args.db.orchToolsets.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "工具集");

  const sortedWorkflowIds = workflows.map((item) => item.id).sort();
  const bundleHash = crypto.createHash("sha1").update(`${args.workspaceId}:${sortedWorkflowIds.join(",")}`).digest("hex").slice(0, 12);
  const title = workflows.length === 1
    ? `${workflows[0].name} 资产包`
    : `批量流程资产包（${workflows.length}个模板）`;

  return prepareExportBundle({
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: `workspace-export-${bundleHash}`,
    bundleVersion: Date.now(),
    title,
    description: "由配置中心导出的流程模板及其角色、知识库、Skills、工具集依赖。",
    generatedAt: Date.now(),
    source: {
      kind: "workspace-export",
      label: title,
      workspaceId: args.workspaceId,
    },
    roles: roles.map((role) => ({
      sourceId: role.id,
      role: stripAssetMeta(role),
    })),
    knowledgeBundles: knowledgeBundles.map((bundle) => ({
      sourceId: bundle.id,
      knowledgeBundle: stripAssetMeta(bundle),
    })),
    skills: skills.map((skill) => ({
      sourceId: skill.id,
      skill: stripAssetMeta(skill),
    })),
    toolsets: toolsets.map((toolset) => ({
      sourceId: toolset.id,
      toolset: stripAssetMeta(toolset),
    })),
    workflows: workflows.map((workflow) => ({
      sourceId: workflow.id,
      workflow: stripAssetMeta(workflow),
    })),
  }, args.strictDependencies);
}

/** 按角色导出角色定义及其知识库、Skills、工具集依赖，不额外附带流程模板。 */
export function exportRoleDependencyBundle(args: {
  db: Pick<ClientDb, "orchRoles" | "orchKnowledgeBundles" | "orchSkills" | "orchToolsets">;
  workspaceId: WorkspaceId;
  roleIds: string[];
  strictDependencies?: boolean;
}): OrchAssetBundle {
  const roles = selectExportAssets(args.roleIds, id => args.db.orchRoles.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "角色");
  if (!roles.length) {
    throw new Error("至少选择一个角色");
  }

  const knowledgeBundleIds = new Set<string>();
  const skillIds = new Set<string>();
  const toolsetIds = new Set<string>();
  for (const role of roles) {
    for (const bundleId of role.defaultKnowledgeBundleIds ?? []) knowledgeBundleIds.add(String(bundleId));
    for (const skillId of role.defaultSkillIds ?? []) skillIds.add(String(skillId));
    for (const ref of role.toolRefs ?? []) toolsetIds.add(String(ref.toolsetId));
  }

  const knowledgeBundles = selectExportAssets([...knowledgeBundleIds], id => args.db.orchKnowledgeBundles.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "知识包");
  const skills = selectExportAssets([...skillIds], id => args.db.orchSkills.get(id as any,
    { requireCompletePackage: args.strictDependencies }), args, "Skill");
  const toolsets = selectExportAssets([...toolsetIds], id => args.db.orchToolsets.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "工具集");

  const sortedRoleIds = roles.map((item) => item.id).sort();
  const bundleHash = crypto.createHash("sha1").update(`${args.workspaceId}:${sortedRoleIds.join(",")}`).digest("hex").slice(0, 12);
  const title = roles.length === 1
    ? `${roles[0].name} 角色资产包`
    : `批量角色资产包（${roles.length}个角色）`;

  return prepareExportBundle({
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: `workspace-role-export-${bundleHash}`,
    bundleVersion: Date.now(),
    title,
    description: "由配置中心导出的角色定义及其知识库、Skills、工具集依赖。",
    generatedAt: Date.now(),
    source: {
      kind: "workspace-export",
      label: title,
      workspaceId: args.workspaceId,
    },
    roles: roles.map((role) => ({
      sourceId: role.id,
      role: stripAssetMeta(role),
    })),
    knowledgeBundles: knowledgeBundles.map((bundle) => ({
      sourceId: bundle.id,
      knowledgeBundle: stripAssetMeta(bundle),
    })),
    skills: skills.map((skill) => ({
      sourceId: skill.id,
      skill: stripAssetMeta(skill),
    })),
    toolsets: toolsets.map((toolset) => ({
      sourceId: toolset.id,
      toolset: stripAssetMeta(toolset),
    })),
    workflows: [],
  }, args.strictDependencies);
}

/** 按知识库导出资产包，不额外附带流程、角色、Skills 或工具集。 */
export function exportKnowledgeBundleDependencyBundle(args: {
  db: Pick<ClientDb, "orchKnowledgeBundles">;
  workspaceId: WorkspaceId;
  knowledgeBundleIds: string[];
  strictDependencies?: boolean;
}): OrchAssetBundle {
  const knowledgeBundles = selectExportAssets(args.knowledgeBundleIds, id => args.db.orchKnowledgeBundles.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "知识包");
  if (!knowledgeBundles.length) {
    throw new Error("至少选择一个知识库");
  }

  const sortedIds = knowledgeBundles.map((item) => item.id).sort();
  const bundleHash = crypto.createHash("sha1").update(args.workspaceId + ":" + sortedIds.join(",")).digest("hex").slice(0, 12);
  const title = knowledgeBundles.length === 1
    ? knowledgeBundles[0].name + " 知识库资产包"
    : "批量知识库资产包（" + knowledgeBundles.length + "个知识库）";

  return prepareExportBundle({
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: "workspace-knowledge-export-" + bundleHash,
    bundleVersion: Date.now(),
    title,
    description: "由配置中心导出的知识库资产包。",
    generatedAt: Date.now(),
    source: {
      kind: "workspace-export",
      label: title,
      workspaceId: args.workspaceId,
    },
    roles: [],
    knowledgeBundles: knowledgeBundles.map((bundle) => ({
      sourceId: bundle.id,
      knowledgeBundle: stripAssetMeta(bundle),
    })),
    skills: [],
    toolsets: [],
    workflows: [],
  }, args.strictDependencies, false);
}

/** 按 Skill 导出资产包，不额外附带流程、角色、知识库或工具集。 */
export function exportSkillDependencyBundle(args: {
  db: Pick<ClientDb, "orchSkills">;
  workspaceId: WorkspaceId;
  skillIds: string[];
  strictDependencies?: boolean;
}): OrchAssetBundle {
  const skills = selectExportAssets(args.skillIds, id => args.db.orchSkills.get(id as any,
    { requireCompletePackage: args.strictDependencies }), args, "Skill");
  if (!skills.length) {
    throw new Error("至少选择一个 Skill");
  }

  const sortedIds = skills.map((item) => item.id).sort();
  const bundleHash = crypto.createHash("sha1").update(args.workspaceId + ":" + sortedIds.join(",")).digest("hex").slice(0, 12);
  const title = skills.length === 1
    ? skills[0].name + " Skill 资产包"
    : "批量 Skills 资产包（" + skills.length + "个 Skill）";

  return prepareExportBundle({
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: "workspace-skill-export-" + bundleHash,
    bundleVersion: Date.now(),
    title,
    description: "由配置中心导出的 Skills 资产包。",
    generatedAt: Date.now(),
    source: {
      kind: "workspace-export",
      label: title,
      workspaceId: args.workspaceId,
    },
    roles: [],
    knowledgeBundles: [],
    skills: skills.map((skill) => ({
      sourceId: skill.id,
      skill: stripAssetMeta(skill),
    })),
    toolsets: [],
    workflows: [],
  }, args.strictDependencies, false);
}

/** 按工具集导出资产包，不额外附带流程、角色、知识库或 Skills。 */
export function exportToolsetDependencyBundle(args: {
  db: Pick<ClientDb, "orchToolsets">;
  workspaceId: WorkspaceId;
  toolsetIds: string[];
  strictDependencies?: boolean;
}): OrchAssetBundle {
  const toolsets = selectExportAssets(args.toolsetIds, id => args.db.orchToolsets.get(id as any,
    { requireCompleteDefinition: args.strictDependencies }), args, "工具集");
  if (!toolsets.length) {
    throw new Error("至少选择一个工具集");
  }

  const sortedIds = toolsets.map((item) => item.id).sort();
  const bundleHash = crypto.createHash("sha1").update(args.workspaceId + ":" + sortedIds.join(",")).digest("hex").slice(0, 12);
  const title = toolsets.length === 1
    ? toolsets[0].name + " 工具集资产包"
    : "批量工具集资产包（" + toolsets.length + "个工具集）";

  return prepareExportBundle({
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: "workspace-toolset-export-" + bundleHash,
    bundleVersion: Date.now(),
    title,
    description: "由配置中心导出的工具集资产包。",
    generatedAt: Date.now(),
    source: {
      kind: "workspace-export",
      label: title,
      workspaceId: args.workspaceId,
    },
    roles: [],
    knowledgeBundles: [],
    skills: [],
    toolsets: toolsets.map((toolset) => ({
      sourceId: toolset.id,
      toolset: stripAssetMeta(toolset),
    })),
    workflows: [],
  }, args.strictDependencies, false);
}

/** 完整导出不跳过丢失或跨工作区的根与依赖；旧调用保留过滤语义。 */
function selectExportAssets<T extends { workspaceId: WorkspaceId }>(ids: string[], read: (id: string) => T | null,
  args: { workspaceId: WorkspaceId; strictDependencies?: boolean }, label: string): T[] {
  return ids.flatMap(id => {
    const asset = read(id);
    if (asset?.workspaceId === args.workspaceId) return [asset];
    if (args.strictDependencies) throw new Error(`${label}依赖不存在或不属于当前工作区：${id}`);
    return [];
  });
}

/** 严格导出先检完整图，不通过删除缺失引用伪造完整包。 */
function prepareExportBundle(bundle: OrchAssetBundle, strict = false, sanitize = true): OrchAssetBundle {
  if (strict) { assertCompleteOrchAssetBundle(bundle); return bundle; }
  return sanitize ? sanitizeBundleDependencies(bundle) : bundle;
}

/** 在同一事务内复制所选资产与完整依赖，原件和个人副本不再共享引用。 */
export function copyPersonalOrchAsset(args: {
  db: AssetLookupDb & Pick<ClientDb, "db">;
  workspaceId: WorkspaceId;
  workspacePath: string;
  assetType: OrchAssetType;
  assetId: string;
}): ImportedAssets & { rootAssetId: string } {
  return args.db.db.transaction(() => {
    const input = { db: args.db, workspaceId: args.workspaceId, strictDependencies: true };
    let bundle: OrchAssetBundle;
    switch (args.assetType) {
      case "workflow": bundle = exportWorkflowDependencyBundle({ ...input, workflowIds: [args.assetId] }); break;
      case "role": bundle = exportRoleDependencyBundle({ ...input, roleIds: [args.assetId] }); break;
      case "knowledge_bundle": bundle = exportKnowledgeBundleDependencyBundle({ ...input, knowledgeBundleIds: [args.assetId] }); break;
      case "skill": bundle = exportSkillDependencyBundle({ ...input, skillIds: [args.assetId] }); break;
      case "toolset": bundle = exportToolsetDependencyBundle({ ...input, toolsetIds: [args.assetId] }); break;
      default: throw new Error("不支持的资产类型");
    }
    const imported = applyOrchAssetBundle({ ...args, bundle, copyAsPersonal: true, workspaceConfigMode: "read" });
    const root = args.assetType === "workflow" ? imported.workflows[0] : args.assetType === "role" ? imported.roles[0]
      : args.assetType === "knowledge_bundle" ? imported.knowledgeBundles[0] : args.assetType === "skill" ? imported.skills[0] : imported.toolsets[0];
    if (!root) throw new Error("个人资产复制缺少根资产");
    return { ...imported, rootAssetId: root.id };
  })();
}

/** Apply an asset bundle with explicit conflict behavior while preserving dependency remapping. */
export function applyOrchAssetBundle(args: {
  db: Pick<ClientDb, "orchRoles" | "orchKnowledgeBundles" | "orchSkills" | "orchToolsets" | "orchWorkflows">;
  workspaceId: WorkspaceId;
  workspacePath: string;
  bundle: OrchAssetBundle;
  importMode?: OrchAssetBundleImportMode | null;
  overwriteExisting?: boolean;
  /** 可信本机复制入口要求完整依赖；不接受 renderer 自行设定。 */
  strictDependencies?: boolean;
  copyAsPersonal?: boolean;
  /** 启动同步只读读取；显式用户导入默认保持原有配置初始化行为。 */
  workspaceConfigMode?: "ensure" | "read";
}): ImportedAssets {
  validateBundle(args.bundle);
  const bundle = prepareExportBundle(args.bundle, args.strictDependencies || args.copyAsPersonal);
  const importMode = args.copyAsPersonal ? "copy" : resolveApplyImportMode(args);
  const names = args.copyAsPersonal ? personalCopyNames(args.db, args.workspaceId) : null;
  const tokens = args.copyAsPersonal ? {} : buildPlaceholderTokens(args.workspacePath, args.workspaceConfigMode ?? "ensure");
  const roleIdMap = buildImportTargetIdMap({
    db: args.db,
    bundleId: bundle.bundleId,
    workspaceId: args.workspaceId,
    kind: "role",
    sourceIds: bundle.roles.map((item) => item.sourceId),
    importMode,
  });
  const knowledgeIdMap = buildImportTargetIdMap({
    db: args.db,
    bundleId: bundle.bundleId,
    workspaceId: args.workspaceId,
    kind: "knowledge",
    sourceIds: bundle.knowledgeBundles.map((item) => item.sourceId),
    importMode,
  });
  const bundleSkills = bundle.skills ?? [];
  const skillIdMap = buildImportTargetIdMap({
    db: args.db,
    bundleId: bundle.bundleId,
    workspaceId: args.workspaceId,
    kind: "skill",
    sourceIds: bundleSkills.map((item) => item.sourceId),
    importMode,
  });
  const toolsetIdMap = buildImportTargetIdMap({
    db: args.db,
    bundleId: bundle.bundleId,
    workspaceId: args.workspaceId,
    kind: "toolset",
    sourceIds: bundle.toolsets.map((item) => item.sourceId),
    importMode,
  });
  const workflowIdMap = buildImportTargetIdMap({
    db: args.db,
    bundleId: bundle.bundleId,
    workspaceId: args.workspaceId,
    kind: "workflow",
    sourceIds: bundle.workflows.map((item) => item.sourceId),
    importMode,
  });

  const imported: ImportedAssets = {
    roles: [],
    knowledgeBundles: [],
    skills: [],
    toolsets: [],
    workflows: [],
    warnings: bundle.warnings ?? [],
    overwritten: createImportCounts(),
    skipped: createImportCounts(),
    copied: createImportCounts(),
    pruned: createImportCounts(),
  };

  for (const entry of bundle.knowledgeBundles) {
    const targetId = knowledgeIdMap.get(entry.sourceId)!;
    const existing = args.db.orchKnowledgeBundles.get(targetId as any);
    if (existing && importMode === "skip_existing") {
      imported.skipped.knowledgeBundles += 1;
      continue;
    }
    const materialized = args.copyAsPersonal ? { ...entry.knowledgeBundle }
      : normalizeImportedKnowledgeBundle(replacePlaceholders(entry.knowledgeBundle, tokens), tokens);
    if (importMode === "copy") materialized.name = names ? takePersonalCopyName(materialized.name, names.knowledge) : buildCopyAssetName(materialized.name);
    imported.knowledgeBundles.push(args.db.orchKnowledgeBundles.upsert({
      ...materialized,
      kind: args.copyAsPersonal ? "custom" : resolveImportedAssetKind(bundle, materialized.kind),
      id: targetId as any,
      workspaceId: args.workspaceId,
    }));
    markImportedAsset(imported, "knowledge", importMode, !!existing);
  }

  for (const entry of bundle.toolsets) {
    const targetId = toolsetIdMap.get(entry.sourceId)!;
    const existing = args.db.orchToolsets.get(targetId as any);
    if (existing && importMode === "skip_existing") {
      imported.skipped.toolsets += 1;
      continue;
    }
    const materialized = replacePlaceholders(entry.toolset, tokens);
    if (importMode === "copy") materialized.name = names ? takePersonalCopyName(materialized.name, names.toolset) : buildCopyAssetName(materialized.name);
    imported.toolsets.push(args.db.orchToolsets.upsert({
      ...materialized,
      kind: args.copyAsPersonal ? "custom" : resolveImportedAssetKind(bundle, materialized.kind),
      id: targetId as any,
      workspaceId: args.workspaceId,
    }));
    markImportedAsset(imported, "toolset", importMode, !!existing);
  }

  for (const entry of bundleSkills) {
    const targetId = skillIdMap.get(entry.sourceId)!;
    const existing = args.db.orchSkills.get(targetId as any);
    if (existing && importMode === "skip_existing") {
      imported.skipped.skills += 1;
      continue;
    }
    const materialized = replacePlaceholders(entry.skill, tokens);
    if (importMode === "copy") materialized.name = names ? takePersonalCopyName(materialized.name, names.skill) : buildCopyAssetName(materialized.name);
    imported.skills.push(args.db.orchSkills.upsert({
      ...materialized,
      kind: args.copyAsPersonal ? "custom" : resolveImportedAssetKind(bundle, materialized.kind),
      id: targetId as any,
      workspaceId: args.workspaceId,
    }));
    markImportedAsset(imported, "skill", importMode, !!existing);
  }

  for (const entry of bundle.roles) {
    const targetId = roleIdMap.get(entry.sourceId)!;
    const existing = args.db.orchRoles.get(targetId as any);
    if (existing && importMode === "skip_existing") {
      imported.skipped.roles += 1;
      continue;
    }
    const materialized = replacePlaceholders(entry.role, tokens);
    if (importMode === "copy") materialized.name = names ? takePersonalCopyName(materialized.name, names.role) : buildCopyAssetName(materialized.name);
    imported.roles.push(args.db.orchRoles.upsert({
      ...materialized,
      kind: args.copyAsPersonal ? "custom" : resolveImportedAssetKind(bundle, materialized.kind),
      builtinGroup: args.copyAsPersonal ? null : materialized.builtinGroup ?? null,
      id: targetId as any,
      workspaceId: args.workspaceId,
      defaultKnowledgeBundleIds: (materialized.defaultKnowledgeBundleIds ?? []).map((id) => requireMappedId(knowledgeIdMap, id, "knowledge")),
      defaultSkillIds: (materialized.defaultSkillIds ?? []).map((id) => requireMappedId(skillIdMap, id, "skill")),
      toolRefs: (materialized.toolRefs ?? []).map((ref) => ({
        ...ref,
        toolsetId: requireMappedId(toolsetIdMap, ref.toolsetId, "toolset"),
      })),
    }));
    markImportedAsset(imported, "role", importMode, !!existing);
  }

  for (const entry of bundle.workflows) {
    const targetId = workflowIdMap.get(entry.sourceId)!;
    const existing = args.db.orchWorkflows.get(targetId as any);
    if (existing && importMode === "skip_existing") {
      imported.skipped.workflows += 1;
      continue;
    }
    const materialized = replacePlaceholders(entry.workflow, tokens);
    if (importMode === "copy") materialized.name = names ? takePersonalCopyName(materialized.name, names.workflow) : buildCopyAssetName(materialized.name);
    imported.workflows.push(args.db.orchWorkflows.upsert({
      ...materialized,
      kind: args.copyAsPersonal ? "custom" : resolveImportedAssetKind(bundle, materialized.kind),
      id: targetId as any,
      workspaceId: args.workspaceId,
      workflowKnowledgeBundleIds: (materialized.workflowKnowledgeBundleIds ?? []).map((id) => requireMappedId(knowledgeIdMap, id, "knowledge")),
      nodes: (materialized.nodes ?? []).map((node) => ({
        ...node,
        roleId: node.roleId ? requireMappedId(roleIdMap, node.roleId, "role") : node.roleId ?? null,
        knowledgeOverrideBundleIds: (node.knowledgeOverrideBundleIds ?? []).map((id) => requireMappedId(knowledgeIdMap, id, "knowledge")),
      })),
    }));
    markImportedAsset(imported, "workflow", importMode, !!existing);
  }

  return imported;
}

/** 清理当前随包内置资产集合中已不存在的旧 builtin 资产。 */
export function pruneStaleServerDefaultAssets(args: {
  db: Pick<ClientDb, "db" | "orchRoles" | "orchKnowledgeBundles" | "orchSkills" | "orchToolsets" | "orchWorkflows">;
  workspaceId: WorkspaceId;
  bundles: OrchAssetBundle[];
}): OrchAssetBundleImportCounts {
  const serverDefaultBundles = args.bundles.filter((bundle) => bundle.source.kind === "server-default");
  const pruned = createImportCounts();
  if (!serverDefaultBundles.length) return pruned;
  const activeIds = buildActiveServerDefaultAssetIds({
    db: args.db,
    workspaceId: args.workspaceId,
    bundles: serverDefaultBundles,
  });

  const prunedWorkflowIds: string[] = [];
  for (const workflow of args.db.orchWorkflows.listByWorkspace(args.workspaceId)) {
    if (shouldPruneBuiltinAsset("workflow", workflow, activeIds.workflows)) {
      args.db.orchWorkflows.delete(workflow.id);
      prunedWorkflowIds.push(workflow.id);
      pruned.workflows += 1;
    }
  }
  for (const role of args.db.orchRoles.listByWorkspace(args.workspaceId)) {
    if (shouldPruneBuiltinAsset("role", role, activeIds.roles)) {
      args.db.orchRoles.delete(role.id);
      pruned.roles += 1;
    }
  }
  for (const bundle of args.db.orchKnowledgeBundles.listByWorkspace(args.workspaceId)) {
    if (shouldPruneBuiltinAsset("knowledge", bundle, activeIds.knowledgeBundles)) {
      args.db.orchKnowledgeBundles.delete(bundle.id);
      pruned.knowledgeBundles += 1;
    }
  }
  for (const skill of args.db.orchSkills.listByWorkspace(args.workspaceId)) {
    if (shouldPruneBuiltinAsset("skill", skill, activeIds.skills)) {
      args.db.orchSkills.delete(skill.id);
      pruned.skills += 1;
    }
  }
  for (const toolset of args.db.orchToolsets.listByWorkspace(args.workspaceId)) {
    if (shouldPruneBuiltinAsset("toolset", toolset, activeIds.toolsets)) {
      args.db.orchToolsets.delete(toolset.id);
      pruned.toolsets += 1;
    }
  }
  // 内置流程资产被清理后，引用它的会话卡片已无法启动；这里绕过了 orch.workflows.delete handler，需自行清理。
  if (prunedWorkflowIds.length) {
    const cardRemoval = new ChatWorkflowRepo(args.db.db).deleteByWorkflowIds(args.workspaceId, prunedWorkflowIds);
    logger.info("orchestration", "chat workflow cards removed with pruned builtin workflows", {
      code: "ORCH_CHAT_WORKFLOW_CARD_REMOVED", workspaceId: args.workspaceId, workflowIds: prunedWorkflowIds,
      taskIds: cardRemoval.taskIds, removedCount: cardRemoval.taskIds.length,
      skippedInvalidJsonCount: cardRemoval.skippedInvalidJsonCount,
    });
  }
  return pruned;
}

/** 各类型单独保留已占用名称；本批每次分配会立即加入同一集合。 */
function personalCopyNames(db: AssetLookupDb, workspaceId: WorkspaceId): Record<BundleAssetKind, Set<string>> {
  return {
    role: new Set(db.orchRoles.listByWorkspace(workspaceId).map(asset => asset.name)),
    workflow: new Set(db.orchWorkflows.listByWorkspace(workspaceId).map(asset => asset.name)),
    knowledge: new Set(db.orchKnowledgeBundles.listByWorkspace(workspaceId).map(asset => asset.name)),
    skill: new Set(db.orchSkills.listByWorkspace(workspaceId).map(asset => asset.name)),
    toolset: new Set(db.orchToolsets.listByWorkspace(workspaceId).map(asset => asset.name)),
  };
}

/** 一个操作自动避开所有同类型冲突，无需额外命名选择。 */
function takePersonalCopyName(rawName: string, occupied: Set<string>): string {
  let name = `${rawName}_复制`;
  while (occupied.has(name)) name += "_复制";
  occupied.add(name);
  return name;
}

/** 清理资产包内无法重映射的依赖引用，并保留可展示的 warning。 */
function sanitizeBundleDependencies(bundle: OrchAssetBundle): OrchAssetBundle {
  const knowledgeIds = new Set(bundle.knowledgeBundles.map((item) => String(item.sourceId)));
  const roleIds = new Set(bundle.roles.map((item) => String(item.sourceId)));
  const skillIds = new Set((bundle.skills ?? []).map((item) => String(item.sourceId)));
  const toolsetIds = new Set(bundle.toolsets.map((item) => String(item.sourceId)));
  const warnings = [...(bundle.warnings ?? [])];

  const roles = bundle.roles.map((entry) => {
    const role = entry.role;
    return {
      ...entry,
      role: {
        ...role,
        defaultKnowledgeBundleIds: sanitizeOptionalIdList(role.defaultKnowledgeBundleIds, {
          knownIds: knowledgeIds,
          warnings,
          ownerKind: "role",
          ownerSourceId: entry.sourceId,
          ownerName: role.name,
          dependencyKind: "knowledge",
        }) ?? undefined,
        defaultSkillIds: sanitizeOptionalIdList(role.defaultSkillIds, {
          knownIds: skillIds,
          warnings,
          ownerKind: "role",
          ownerSourceId: entry.sourceId,
          ownerName: role.name,
          dependencyKind: "skill",
        }) ?? undefined,
        toolRefs: role.toolRefs == null
          ? role.toolRefs
          : role.toolRefs.filter((ref) => keepDependencyRef(ref.toolsetId, {
            knownIds: toolsetIds,
            warnings,
            ownerKind: "role",
            ownerSourceId: entry.sourceId,
            ownerName: role.name,
            dependencyKind: "toolset",
          })),
      },
    };
  });

  const workflows = bundle.workflows.map((entry) => {
    const workflow = entry.workflow;
    return {
      ...entry,
      workflow: {
        ...workflow,
        workflowKnowledgeBundleIds: sanitizeOptionalIdList(workflow.workflowKnowledgeBundleIds, {
          knownIds: knowledgeIds,
          warnings,
          ownerKind: "workflow",
          ownerSourceId: entry.sourceId,
          ownerName: workflow.name,
          dependencyKind: "knowledge",
        }),
        nodes: workflow.nodes.map((node) => {
          const roleId = node.roleId == null || keepDependencyRef(node.roleId, {
            knownIds: roleIds,
            warnings,
            ownerKind: "workflow",
            ownerSourceId: entry.sourceId,
            ownerName: workflow.name,
            ownerNodeId: node.id,
            dependencyKind: "role",
          }) ? node.roleId : null;
          return {
            ...node,
            roleId,
            knowledgeOverrideBundleIds: sanitizeOptionalIdList(node.knowledgeOverrideBundleIds, {
              knownIds: knowledgeIds,
              warnings,
              ownerKind: "workflow",
              ownerSourceId: entry.sourceId,
              ownerName: workflow.name,
              ownerNodeId: node.id,
              dependencyKind: "knowledge",
            }),
          };
        }),
      },
    };
  });

  return { ...bundle, roles, workflows, warnings };
}

/** 清理可选 ID 列表，保留原本的 null/undefined 形态。 */
function sanitizeOptionalIdList<T extends string>(
  ids: T[] | null | undefined,
  args: MissingDependencyWarningInput,
): T[] | null | undefined {
  if (ids == null) return ids;
  return ids.filter((id) => keepDependencyRef(id, args));
}

/** 判断依赖是否在资产包内存在，不存在时记录 warning。 */
function keepDependencyRef(id: string, args: MissingDependencyWarningInput): boolean {
  const dependencyId = String(id ?? "").trim();
  if (dependencyId && args.knownIds.has(dependencyId)) return true;
  addMissingDependencyWarning(args.warnings, { ...args, dependencyId });
  return false;
}

type MissingDependencyWarningInput = {
  knownIds: Set<string>;
  warnings: OrchAssetBundleWarning[];
  ownerKind: OrchAssetBundleWarning["ownerKind"];
  ownerSourceId: string;
  ownerName?: string | null;
  ownerNodeId?: string | null;
  dependencyKind: OrchAssetBundleWarning["dependencyKind"];
};

/** 记录缺失依赖 warning，并避免同一依赖重复刷屏。 */
function addMissingDependencyWarning(
  warnings: OrchAssetBundleWarning[],
  args: Omit<MissingDependencyWarningInput, "knownIds" | "warnings"> & { dependencyId: string },
): void {
  const exists = warnings.some((warning) =>
    warning.code === "missing_dependency"
    && warning.ownerKind === args.ownerKind
    && warning.ownerSourceId === args.ownerSourceId
    && (warning.ownerNodeId ?? null) === (args.ownerNodeId ?? null)
    && warning.dependencyKind === args.dependencyKind
    && warning.dependencyId === args.dependencyId
  );
  if (exists) return;
  warnings.push({
    code: "missing_dependency",
    ownerKind: args.ownerKind,
    ownerSourceId: args.ownerSourceId,
    ownerName: args.ownerName ?? null,
    ownerNodeId: args.ownerNodeId ?? null,
    dependencyKind: args.dependencyKind,
    dependencyId: args.dependencyId,
    message: buildMissingDependencyMessage(args),
  });
}

/** 生成人可读 warning 文案，供导入导出提示直接展示。 */
function buildMissingDependencyMessage(args: {
  ownerKind: OrchAssetBundleWarning["ownerKind"];
  ownerName?: string | null;
  ownerSourceId: string;
  ownerNodeId?: string | null;
  dependencyKind: OrchAssetBundleWarning["dependencyKind"];
  dependencyId: string;
}): string {
  const ownerLabel = args.ownerKind === "role" ? "角色" : "流程";
  const dependencyLabel = args.dependencyKind === "knowledge"
    ? "知识库"
    : args.dependencyKind === "skill"
      ? "Skill"
      : args.dependencyKind === "toolset"
        ? "工具集"
        : "角色";
  const ownerName = args.ownerName ? `“${args.ownerName}”` : `(${args.ownerSourceId})`;
  const nodeSuffix = args.ownerNodeId ? `节点 ${args.ownerNodeId} ` : "";
  return `${ownerLabel}${ownerName}${nodeSuffix}引用的${dependencyLabel}不存在，已跳过：${args.dependencyId}`;
}

/** 解析导入模式；旧调用只传 overwriteExisting 时保持兼容。 */
function resolveApplyImportMode(args: { importMode?: OrchAssetBundleImportMode | null; overwriteExisting?: boolean }): OrchAssetBundleImportMode {
  if (args.importMode != null) return normalizeOrchAssetBundleImportMode(args.importMode);
  return args.overwriteExisting === false ? "skip_existing" : "overwrite";
}

/** 创建一组导入计数，供响应摘要和 UI 提示复用。 */
function createImportCounts(): OrchAssetBundleImportCounts {
  return {
    roles: 0,
    knowledgeBundles: 0,
    skills: 0,
    toolsets: 0,
    workflows: 0,
  };
}

/** 根据资产类型累加导入结果计数。 */
function markImportedAsset(
  imported: Pick<ImportedAssets, "overwritten" | "copied">,
  kind: BundleAssetKind,
  importMode: OrchAssetBundleImportMode,
  hadExistingTarget: boolean,
): void {
  if (importMode === "copy") {
    incrementImportCount(imported.copied, kind);
    return;
  }
  if (hadExistingTarget) incrementImportCount(imported.overwritten, kind);
}

/** 递增指定资产类型计数。 */
function incrementImportCount(counts: OrchAssetBundleImportCounts, kind: BundleAssetKind): void {
  if (kind === "role") counts.roles += 1;
  else if (kind === "knowledge") counts.knowledgeBundles += 1;
  else if (kind === "skill") counts.skills += 1;
  else if (kind === "toolset") counts.toolsets += 1;
  else counts.workflows += 1;
}

/** 为副本导入资产生成易识别名称，不强制做唯一名。 */
function buildCopyAssetName(rawName: string | null | undefined): string {
  const name = String(rawName ?? "").trim();
  if (!name) return "未命名资产（副本）";
  return name.endsWith("（副本）") ? name : `${name}（副本）`;
}

/** 解析资产占位符；启动同步只读读取，显式导入按需确保工作区配置存在。 */
function buildPlaceholderTokens(
  workspacePath: string,
  mode: "ensure" | "read" = "ensure",
): Record<string, string> {
  const config = mode === "read"
    ? readExistingCodeflowaiConfig(workspacePath)?.config ?? defaultCodeflowaiConfig()
    : ensureCodeflowaiConfig(workspacePath).config;
  return {
    workflowDocsRoot: String(config.paths?.workflowDocsRoot ?? "codeflow-docs").trim() || "codeflow-docs",
    prdDirName: String(config.workflow?.dirs?.prd?.dirName ?? "需求分析").trim() || "需求分析",
    uiDirName: String(config.workflow?.dirs?.ui?.dirName ?? "原型设计").trim() || "原型设计",
    arcDirName: String(config.workflow?.dirs?.arc?.dirName ?? "架构设计").trim() || "架构设计",
    designDirName: String(config.workflow?.dirs?.design?.dirName ?? "设计卡").trim() || "设计卡",
    devDirName: String(config.workflow?.dirs?.dev?.dirName ?? "任务与开发").trim() || "任务与开发",
    testDirName: String(config.workflow?.dirs?.test?.dirName ?? "集成测试").trim() || "集成测试",
  };
}

/** 仅归一化合法知识源路径；结构缺失原样交给仓储边界拒绝。 */
function normalizeImportedKnowledgeBundle(
  bundle: EditableBundleKnowledgeBundle,
  tokens: Record<string, string>,
): EditableBundleKnowledgeBundle {
  const workflowDocsRoot = normalizePosixLike(tokens.workflowDocsRoot);
  if (!workflowDocsRoot || !Array.isArray(bundle.sourceRefs)) return bundle;
  return {
    ...bundle,
    sourceRefs: bundle.sourceRefs.map((source) => {
      if (source.kind !== "workbench-dir" && source.kind !== "workbench-doc") return source;
      return {
        ...source,
        ref: stripWorkbenchRootPrefix(source.ref, workflowDocsRoot),
      };
    }),
  };
}

/** 产物路径里的日期后缀（YYYYMMDD），由平台渲染，模型不再手写。 */
function formatArtifactDateStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
}

/**
 * 产物路径的运行时 token：把路径规则里的主题、编号、日期解析成平台权威值，
 * 使 pathRule 完全可解析，模型只需照抄平台给出的路径而不自行拼接目录。
 */
export function buildArtifactPathRuntimeTokens(input: {
  /** 工作区路径；未登记时用默认产物根与目录名继续解析，避免整链退化。 */
  workspacePath?: string | null;
  topicTitle: string;
  topicDirName: string;
  ordinal: number;
  now?: number;
}): Record<string, string> {
  return {
    ...buildPlaceholderTokens(String(input.workspacePath ?? ""), "read"),
    topicName: sanitizePathSegment(String(input.topicTitle ?? "").trim(), "未命名需求", 48),
    topicDirName: String(input.topicDirName ?? "").trim(),
    ordinal: String(Math.max(1, Math.trunc(Number(input.ordinal) || 1))).padStart(2, "0"),
    date: formatArtifactDateStamp(input.now ?? Date.now()),
  };
}

/** 递归替换 {{token}}；未注册的 token 原样保留，便于上游发现规则缺口。 */
export function replacePlaceholders<T>(input: T, tokens: Record<string, string>): T {
  if (typeof input === "string") {
    return input.replace(/\{\{(\w+)\}\}/g, (_all, key) => {
      const normalizedKey = String(key ?? "").trim();
      return Object.prototype.hasOwnProperty.call(tokens, normalizedKey)
        ? tokens[normalizedKey]
        : `{{${normalizedKey}}}`;
    }) as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => replacePlaceholders(item, tokens)) as T;
  }
  if (!input || typeof input !== "object") return input;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    result[key] = replacePlaceholders(value, tokens);
  }
  return result as T;
}

/** 按导入模式建立 sourceId 到目标 ID 的映射。 */
function buildImportTargetIdMap(args: {
  db: AssetLookupDb;
  bundleId: string;
  workspaceId: WorkspaceId;
  kind: BundleAssetKind;
  sourceIds: string[];
  importMode: OrchAssetBundleImportMode;
}): Map<string, string> {
  if (args.importMode === "copy") return buildCopyTargetIdMap(args.kind, args.sourceIds);
  return buildTargetIdMap(args);
}

/** 副本导入每次生成新 ID，避免覆盖同源资产。 */
function buildCopyTargetIdMap(kind: BundleAssetKind, sourceIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sourceId of sourceIds) {
    map.set(sourceId, `bundle-${kind}-${crypto.randomUUID()}`);
  }
  return map;
}

/** 为资产包 sourceId 建立目标 ID 映射，优先复用 workspace 历史别名下已存在的 builtin ID。 */
function buildTargetIdMap(args: {
  db: AssetLookupDb;
  bundleId: string;
  workspaceId: WorkspaceId;
  kind: BundleAssetKind;
  sourceIds: string[];
}): Map<string, string> {
  const map = new Map<string, string>();
  const workspaceAliases = workspaceIdAliasChain(args.workspaceId);
  for (const sourceId of args.sourceIds) {
    const candidateIds = workspaceAliases.map((workspaceAlias) => buildTargetAssetId(args.bundleId, workspaceAlias, args.kind, sourceId));
    const existingId = candidateIds.find((targetId) => assetExistsInWorkspace(args.db, args.kind, targetId, args.workspaceId));
    map.set(sourceId, existingId ?? candidateIds[0] ?? buildTargetAssetId(args.bundleId, args.workspaceId, args.kind, sourceId));
  }
  return map;
}

/** 生成内置资产稳定 ID；workspaceId 保留在 hash 中，避免不同 workspace 间直接冲突。 */
function buildTargetAssetId(
  bundleId: string,
  workspaceId: string,
  kind: BundleAssetKind,
  sourceId: string,
): string {
  const digest = crypto.createHash("sha1").update(`${bundleId}:${workspaceId}:${kind}:${sourceId}`).digest("hex").slice(0, 12);
  return `bundle-${kind}-${digest}`;
}

/** 按现有 Client 规则派生工作区内的旧 builtin ID，供存量迁移反解 Server builtinKey。 */
export function buildLegacyBuiltinAssetId(input: {
  bundleId: string;
  workspaceId: string;
  assetType: OrchAssetType;
  sourceId: string;
}): string {
  const kind: BundleAssetKind = input.assetType === "knowledge_bundle" ? "knowledge" : input.assetType;
  return buildTargetAssetId(input.bundleId, input.workspaceId, kind, input.sourceId);
}

/** 为当前服务端内置资产包集合计算仍应保留的稳定资产 ID。 */
export function buildActiveServerDefaultAssetIds(args: {
  db: AssetLookupDb;
  workspaceId: WorkspaceId;
  bundles: OrchAssetBundle[];
}): {
  roles: Set<string>;
  knowledgeBundles: Set<string>;
  skills: Set<string>;
  toolsets: Set<string>;
  workflows: Set<string>;
} {
  const roles = new Set<string>();
  const knowledgeBundles = new Set<string>();
  const skills = new Set<string>();
  const toolsets = new Set<string>();
  const workflows = new Set<string>();
  for (const bundle of args.bundles) {
    addMappedIds(roles, buildTargetIdMap({
      db: args.db,
      bundleId: bundle.bundleId,
      workspaceId: args.workspaceId,
      kind: "role",
      sourceIds: bundle.roles.map((item) => item.sourceId),
    }));
    addMappedIds(knowledgeBundles, buildTargetIdMap({
      db: args.db,
      bundleId: bundle.bundleId,
      workspaceId: args.workspaceId,
      kind: "knowledge",
      sourceIds: bundle.knowledgeBundles.map((item) => item.sourceId),
    }));
    addMappedIds(skills, buildTargetIdMap({
      db: args.db,
      bundleId: bundle.bundleId,
      workspaceId: args.workspaceId,
      kind: "skill",
      sourceIds: (bundle.skills ?? []).map((item) => item.sourceId),
    }));
    addMappedIds(toolsets, buildTargetIdMap({
      db: args.db,
      bundleId: bundle.bundleId,
      workspaceId: args.workspaceId,
      kind: "toolset",
      sourceIds: bundle.toolsets.map((item) => item.sourceId),
    }));
    addMappedIds(workflows, buildTargetIdMap({
      db: args.db,
      bundleId: bundle.bundleId,
      workspaceId: args.workspaceId,
      kind: "workflow",
      sourceIds: bundle.workflows.map((item) => item.sourceId),
    }));
  }
  return { roles, knowledgeBundles, skills, toolsets, workflows };
}

/** 把 sourceId 映射后的目标资产 ID 合并到保留集合。 */
function addMappedIds(target: Set<string>, map: Map<string, string>): void {
  for (const id of map.values()) target.add(String(id));
}

/** 仅清理确定来自内置包、且当前随包集合已不再声明的资产。 */
function shouldPruneBuiltinAsset(
  kind: BundleAssetKind,
  asset: { id: string; kind?: string | null },
  activeIds: Set<string>,
): boolean {
  const id = String(asset.id ?? "").trim();
  return asset.kind === "builtin"
    && id.startsWith(`bundle-${kind}-`)
    && !activeIds.has(id);
}

/** 检查候选资产 ID 是否已属于当前 workspace 或其历史别名。 */
function assetExistsInWorkspace(
  db: AssetLookupDb,
  kind: BundleAssetKind,
  targetId: string,
  workspaceId: WorkspaceId,
): boolean {
  const existing = kind === "role"
    ? db.orchRoles.get(targetId as any)
    : kind === "knowledge"
      ? db.orchKnowledgeBundles.get(targetId as any)
      : kind === "skill"
        ? db.orchSkills.get(targetId as any)
        : kind === "toolset"
          ? db.orchToolsets.get(targetId as any)
          : db.orchWorkflows.get(targetId as any);
  return !!existing && workspaceIdsReferToSameWorkspace(existing.workspaceId, workspaceId);
}

function requireMappedId(map: Map<string, string>, sourceId: string, label: string): any {
  const targetId = map.get(String(sourceId));
  if (!targetId) {
    throw new Error(`资产包缺少 ${label} 依赖：${String(sourceId)}`);
  }
  return targetId;
}

function stripAssetMeta<T extends { id: string; workspaceId: string; createdAt: number; updatedAt: number }>(
  asset: T,
): Omit<T, "id" | "workspaceId" | "createdAt" | "updatedAt"> {
  const { id: _id, workspaceId: _workspaceId, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = asset;
  return rest;
}

function resolveImportedAssetKind(bundle: Pick<OrchAssetBundle, "source">, currentKind: unknown): "builtin" | "custom" {
  if (bundle.source.kind === "server-default") return "builtin";
  return normalizeOrchAssetDefinitionKind(currentKind);
}

function stripWorkbenchRootPrefix(rawRef: string | null | undefined, workflowDocsRoot: string): string {
  const normalizedRef = normalizePosixLike(rawRef);
  if (!normalizedRef || normalizedRef === ".") return normalizedRef;
  if (normalizedRef === workflowDocsRoot) return "";
  if (normalizedRef.startsWith(`${workflowDocsRoot}/`)) {
    return normalizedRef.slice(workflowDocsRoot.length + 1);
  }
  return normalizedRef;
}

function normalizePosixLike(raw: string | null | undefined): string {
  return String(raw ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

