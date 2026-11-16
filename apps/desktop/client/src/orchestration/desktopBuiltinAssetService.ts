import type { OrchAssetBundle, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import { applyOrchAssetBundle, buildActiveServerDefaultAssetIds, pruneStaleServerDefaultAssets } from "./assetBundleService.js";
import { assertDesktopBuiltinBundles } from "./orchAssetBundleValidation.js";
export { readDesktopBuiltinAssetBundles } from "./orchAssetBundleValidation.js";

/** 先校验整组包，再逐工作区原子覆盖；失败停止后续，已提交工作区与个人副本保留。 */
export function installDesktopBuiltinAssets(input: {
  db: ClientDb;
  bundles: readonly OrchAssetBundle[];
  workspaces: ReadonlyMap<WorkspaceId, string>;
}): void {
  assertDesktopBuiltinBundles(input.bundles);
  for (const [workspaceId, workspacePath] of input.workspaces) {
    input.db.withWorkspaceAssetWrite(workspaceId, db => {
      assertBuiltinTargets(db, workspaceId, input.bundles);
      for (const bundle of input.bundles) {
        applyOrchAssetBundle({ db, workspaceId, workspacePath, bundle,
          strictDependencies: true, overwriteExisting: true, workspaceConfigMode: "read" });
      }
      pruneStaleServerDefaultAssets({ db, workspaceId, bundles: [...input.bundles] });
    });
  }
}

/** 确定 ID 被个人定义或其他工作区占用时中止整组安装，禁止覆盖个人数据。 */
function assertBuiltinTargets(db: ClientDb, workspaceId: WorkspaceId, bundles: readonly OrchAssetBundle[]): void {
  const ids = buildActiveServerDefaultAssetIds({ db, workspaceId, bundles: [...bundles] });
  const targets = [
    [ids.roles, db.orchRoles], [ids.workflows, db.orchWorkflows], [ids.knowledgeBundles, db.orchKnowledgeBundles],
    [ids.skills, db.orchSkills], [ids.toolsets, db.orchToolsets],
  ] as const;
  for (const [assetIds, repository] of targets) {
    for (const assetId of assetIds) {
      const asset = repository.get(assetId as never);
      if (asset && (asset.kind !== "builtin" || asset.workspaceId !== workspaceId)) {
        throw new Error(`DESKTOP_BUILTIN_TARGET_CONFLICT: workspaceId=${workspaceId}, assetId=${assetId}`);
      }
    }
  }
  assertPersonalBuiltinDependencies(db, workspaceId, bundles, ids);
}

/** 当前包删除仍被个人图引用的内置资产或工具时拒绝切换，不改写个人定义。 */
function assertPersonalBuiltinDependencies(db: ClientDb, workspaceId: WorkspaceId, bundles: readonly OrchAssetBundle[],
  nextIds: ReturnType<typeof buildActiveServerDefaultAssetIds>): void {
  /** 只检查现有同步清理会删除的包内 builtin，与原 prune 边界一致。 */
  const removed = (assets: Array<{ id: string; kind?: string | null }>, kind: string, active: Set<string>): Set<string> =>
    new Set(assets.filter(asset => asset.kind === "builtin" && asset.id.startsWith(`bundle-${kind}-`) && !active.has(asset.id)).map(asset => asset.id));
  const removedRoles = removed(db.orchRoles.listByWorkspace(workspaceId), "role", nextIds.roles);
  const removedKnowledge = removed(db.orchKnowledgeBundles.listByWorkspace(workspaceId), "knowledge", nextIds.knowledgeBundles);
  const removedSkills = removed(db.orchSkills.listByWorkspace(workspaceId), "skill", nextIds.skills);
  const removedToolsets = removed(db.orchToolsets.listByWorkspace(workspaceId), "toolset", nextIds.toolsets);
  const nextTools = new Map<string, Set<string>>();
  for (const bundle of bundles) {
    for (const entry of bundle.toolsets) {
      const ids = buildActiveServerDefaultAssetIds({ db, workspaceId, bundles: [{ ...bundle, toolsets: [entry] }] });
      for (const id of ids.toolsets) nextTools.set(id, new Set(entry.toolset.tools.map(tool => tool.id)));
    }
  }
  /** 失败上下文进入既有安装错误边界，保留个人主键、引用路径和目标标识。 */
  const requireRetained = (missing: boolean, ownerId: string, reference: string, targetId: string): void => {
    if (missing) throw new Error(`DESKTOP_BUILTIN_CUSTOM_DEPENDENCY_REMOVED: workspaceId=${workspaceId}, assetId=${ownerId}, reference=${reference}, targetId=${targetId}`);
  };
  for (const item of db.orchRoles.listByWorkspace(workspaceId)) {
    if (item.kind !== "custom") continue;
    const role = db.orchRoles.get(item.id, { requireCompleteDefinition: true })!;
    for (const id of role.defaultKnowledgeBundleIds ?? []) requireRetained(removedKnowledge.has(id), role.id, "defaultKnowledgeBundleIds", id);
    for (const id of role.defaultSkillIds ?? []) requireRetained(removedSkills.has(id), role.id, "defaultSkillIds", id);
    for (const ref of role.toolRefs ?? []) {
      requireRetained(removedToolsets.has(ref.toolsetId), role.id, "toolRefs.toolsetId", ref.toolsetId);
      requireRetained(nextTools.has(ref.toolsetId) && !nextTools.get(ref.toolsetId)!.has(ref.toolId), role.id,
        "toolRefs.toolId", `${ref.toolsetId}/${ref.toolId}`);
    }
  }
  for (const item of db.orchWorkflows.listByWorkspace(workspaceId)) {
    if (item.kind !== "custom") continue;
    const workflow = db.orchWorkflows.get(item.id, { requireCompleteDefinition: true })!;
    for (const id of workflow.workflowKnowledgeBundleIds ?? []) requireRetained(removedKnowledge.has(id), workflow.id, "workflowKnowledgeBundleIds", id);
    for (const node of workflow.nodes) {
      if (node.roleId) requireRetained(removedRoles.has(node.roleId), workflow.id, `nodes[${node.id}].roleId`, node.roleId);
      for (const id of node.knowledgeOverrideBundleIds ?? []) requireRetained(removedKnowledge.has(id), workflow.id, `nodes[${node.id}].knowledgeOverrideBundleIds`, id);
    }
  }
}

/** 安装目标只认当前承载的精确命名空间；共享请求权威由可信上下文决定。 */
export function isDesktopLocalAssetWorkspace(clientId: string, workspaces: ReadonlyMap<WorkspaceId, string>, workspaceId?: string): boolean {
  if (!workspaceId || !workspaces.has(workspaceId as WorkspaceId)) return false;
  const prefix = `${clientId}:`;
  return workspaceId.startsWith(prefix) && workspaceId.length > prefix.length && !workspaceId.slice(prefix.length).includes(":");
}
