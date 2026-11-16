import fs from "node:fs";
import path from "node:path";
import { ORCH_ASSET_BUNDLE_SCHEMA_VERSION, type OrchAssetBundle } from "@codeflowai/shared";
import { assertCompleteSkillPackage } from "../db/repos/orchSkillRepo.js";

/** 校验包版本和标识，不改变已有导入的兼容边界。 */
export function validateBundle(bundle: OrchAssetBundle): void {
  if (!bundle || typeof bundle !== "object") throw new Error("资产包不能为空");
  if (bundle.schemaVersion !== ORCH_ASSET_BUNDLE_SCHEMA_VERSION) {
    throw new Error(`不支持的资产包格式：${String((bundle as any).schemaVersion ?? "(empty)")}`);
  }
  if (!String(bundle.bundleId ?? "").trim()) throw new Error("资产包缺少 bundleId");
}

/** 完整图必须保留所有引用，重复身份或残缺 Skill 均在首笔写入前拒绝。 */
export function assertCompleteOrchAssetBundle(bundle: OrchAssetBundle): void {
  validateBundle(bundle);
  const groups = [bundle.roles, bundle.knowledgeBundles, bundle.skills ?? [], bundle.toolsets, bundle.workflows];
  for (const entries of groups) {
    if (!Array.isArray(entries)) throw new Error("资产包列表结构非法");
    const ids = new Set<string>();
    for (const entry of entries) {
      if (typeof entry?.sourceId !== "string" || !entry.sourceId || entry.sourceId !== entry.sourceId.trim()) throw new Error("资产包 sourceId 非法");
      if (ids.has(entry.sourceId)) throw new Error(`资产包 sourceId 重复：${entry.sourceId}`);
      ids.add(entry.sourceId);
    }
  }
  for (const { toolset } of bundle.toolsets) {
    if (!toolset || !Array.isArray(toolset.tools)) throw new Error("资产包工具清单非法");
    const ids = new Set<string>();
    for (const tool of toolset.tools) {
      if (!tool || typeof tool.id !== "string" || !tool.id.trim() || ids.has(tool.id)) throw new Error("资产包工具标识非法或重复");
      ids.add(tool.id);
    }
  }
  for (const { knowledgeBundle } of bundle.knowledgeBundles) {
    if (!knowledgeBundle || !Array.isArray(knowledgeBundle.sourceRefs)
      || !["workflow", "role", "shared"].includes(knowledgeBundle.scope)) throw new Error("资产包知识定义非法");
  }
  const knowledge = new Set(bundle.knowledgeBundles.map(entry => entry.sourceId));
  const skills = new Set((bundle.skills ?? []).map(entry => entry.sourceId));
  const roles = new Set(bundle.roles.map(entry => entry.sourceId));
  const toolsets = new Map(bundle.toolsets.map(entry => [entry.sourceId, entry.toolset]));
  /** 所有可选依赖列表仍须保证每个已声明的 ID 能在本图解析。 */
  const requireReferences = (ids: readonly string[] | null | undefined, known: ReadonlySet<string>, label: string): void => {
    if (ids == null) return;
    if (!Array.isArray(ids)) throw new Error(`${label}依赖列表非法`);
    for (const id of ids) if (!known.has(id)) throw new Error(`资产包缺少${label}依赖：${id}`);
  };
  for (const { role } of bundle.roles) {
    requireReferences(role.defaultKnowledgeBundleIds, knowledge, "知识包");
    requireReferences(role.defaultSkillIds, skills, "Skill");
    for (const ref of role.toolRefs ?? []) {
      const toolset = toolsets.get(ref.toolsetId);
      if (!toolset || !toolset.tools.some(tool => tool.id === ref.toolId)) throw new Error(`资产包缺少工具依赖：${ref.toolsetId}/${ref.toolId}`);
    }
  }
  for (const { workflow } of bundle.workflows) {
    if (!workflow || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) throw new Error("资产包流程图不完整");
    requireReferences(workflow.workflowKnowledgeBundleIds, knowledge, "知识包");
    for (const node of workflow.nodes) {
      if (node.roleId && !roles.has(node.roleId)) throw new Error(`资产包缺少角色依赖：${node.roleId}`);
      requireReferences(node.knowledgeOverrideBundleIds, knowledge, "知识包");
    }
  }
  for (const { skill } of bundle.skills ?? []) assertCompleteSkillPackage(skill);
}

/** 仅读取当前 Client payload 的静态包；缺失、损坏和悬挂依赖均显式失败。 */
export function readDesktopBuiltinAssetBundles(directory: string): OrchAssetBundle[] {
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name.toLowerCase().endsWith(".json"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const bundles = files.map(entry => {
    const filePath = path.join(directory, entry.name);
    try {
      if (!entry.isFile()) throw new Error("内置包资源必须是普通文件");
      const bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filePath))) as OrchAssetBundle;
      assertDesktopBuiltinBundles([bundle]);
      return bundle;
    } catch (cause) {
      throw new Error(`DESKTOP_BUILTIN_BUNDLE_INVALID: ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  });
  assertDesktopBuiltinBundles(bundles);
  return bundles;
}

/** 只接受非空的可信静态包集合，复用完整图校验而不裁剪依赖。 */
export function assertDesktopBuiltinBundles(bundles: readonly OrchAssetBundle[]): void {
  if (!Array.isArray(bundles) || !bundles.length) throw new Error("DESKTOP_BUILTIN_BUNDLE_EMPTY");
  const ids = new Set<string>();
  for (const bundle of bundles) {
    if (bundle?.source?.kind !== "server-default") throw new Error("桌面内置资产包来源非法");
    if (!Number.isSafeInteger(bundle.bundleVersion) || bundle.bundleVersion < 1) throw new Error("桌面内置资产包版本非法");
    assertCompleteOrchAssetBundle(bundle);
    if (ids.has(bundle.bundleId)) throw new Error(`桌面内置资产包重复：${bundle.bundleId}`);
    ids.add(bundle.bundleId);
  }
}
