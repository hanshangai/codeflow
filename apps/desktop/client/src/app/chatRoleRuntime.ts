import path from "node:path";

import type {
  ExecutableToolDescriptor,
  ExecutableToolRegistry,
  EngineType,
  KnowledgeBundleId,
  KnowledgeCatalogSnapshot,
  RoleDefinition,
  RoleId,
  SkillDefinition,
  OrchAssetType,
  RuntimeKnowledgeSource,
  ToolDefinition,
  ToolRef,
  ToolsetDefinition,
  WorkspaceId,
} from "@codeflowai/shared";
import { KnowledgeRuntimeService } from "../orchestration/knowledgeRuntimeService.js";
import type { OrchAssetAuthorityRuntimeReadService, OrchAssetAuthorityRuntimeReadSession } from "../orchestration/orchAssetAuthorityRuntimeReadService.js";
import type { OrchestrationRuntimeAssetDefinitionByType } from "@codeflowai/shared";
import { buildSkillScriptToolEntries, ensureSkillPackageInstalled } from "../orchestration/skillPackageService.js";
import type { RequiredWorkspaceSkill } from "../engines/threadSession.js";
import type { SkillRuntimeMaterializationContext } from "../orchestration/skillRuntimePackage.js";

export type ChatRoleRuntime = {
  role: RoleDefinition;
  systemRule: string;
  developerMessage: string | null;
  userMessage: string;
  toolRegistry: ExecutableToolRegistry | null;
  requiresRoleToolTransport: boolean;
  skills: SkillDefinition[];
};

/** 解析普通聊天角色资产，并按 system/developer/user 三层生成本轮注入内容。 */
export function resolveChatRoleRuntime(input: SkillRuntimeMaterializationContext & {
  assetRuntimeRead?: Pick<OrchAssetAuthorityRuntimeReadService, "withWorkspace">;
  workspaceId: WorkspaceId;
  workspacePath: string;
  roleId: RoleId | null;
  userMessage: string;
  engine?: EngineType;
}): ChatRoleRuntime | null {
  if (!input.roleId) return null;
  if (!input.assetRuntimeRead) throw new Error("普通聊天资产权威读取服务未装配");
  const { role, knowledge, toolRegistry, skills } = input.assetRuntimeRead.withWorkspace(input.workspaceId, session => {
    const role = readDefinition(session, "role", input.roleId!);
    if (!role) throw new Error(`普通聊天角色不存在：${input.roleId}`);
    assertWorkspaceMatch("角色", role.workspaceId, input.workspaceId, role.id);
    const knowledge = resolveRoleKnowledge({ session, role, workspaceId: input.workspaceId,
      knowledgeRuntime: new KnowledgeRuntimeService(input.workspacePath) });
    const toolRegistry = buildRoleToolRegistry({ session, role, workspaceId: input.workspaceId });
    const skills: SkillDefinition[] = [];
    const slugs = new Set<string>();
    for (const skillId of new Set(role.defaultSkillIds ?? [])) {
      const skill = readDefinition(session, "skill", skillId);
      if (!skill) throw new Error(`角色「${role.name}」绑定的 Skill 不存在：${skillId}`);
      assertWorkspaceMatch("Skill", skill.workspaceId, input.workspaceId, skill.id);
      if (!input.engine || !skill.targetEngines.includes(input.engine as "codex" | "claude")) {
        throw new Error(`角色「${role.name}」绑定的 Skill 不支持当前执行引擎 ${input.engine}：${skill.name}`);
      }
      const slug = String(skill.slug ?? "").trim();
      if (!slug || slugs.has(slug)) throw new Error(`角色「${role.name}」绑定的 Skill slug 缺失或重复：${skill.id}`);
      slugs.add(slug);
      skills.push(skill);
    }
    return { role, knowledge, toolRegistry, skills };
  }, { assetType: "role", assetId: input.roleId });
  const scriptTools = buildSkillScriptToolEntries({ ...input, skills });
  const registry = mergeExecutableToolRegistries(toolRegistry, { tools: scriptTools.map(entry => toExecutableTool(entry.toolset, entry.tool, entry.ref)) });
  return {
    role,
    systemRule: buildRoleSystemRule(role),
    developerMessage: [buildRoleDeveloperMessage(role, knowledge, registry), skills.length
      ? xmlBlockNode("bound_skills", skills.map(skill => xmlTextNode("skill", skill.trigger, { name: skill.name, slug: skill.slug }))) : null].filter(Boolean).join("\n") || null,
    userMessage: buildRoleUserMessage(input.userMessage, knowledge.catalogs),
    toolRegistry: registry,
    requiresRoleToolTransport: Boolean(registry?.tools.length),
    skills,
  };
}

/** 从同一权威会话取脱离引用的定义；时间字段只用于兼容已有运行时 helper。 */
function readDefinition<T extends OrchAssetType>(session: OrchAssetAuthorityRuntimeReadSession, type: T, id: string):
  (OrchestrationRuntimeAssetDefinitionByType[T] & { createdAt: number; updatedAt: number }) | null {
  const asset = session.getAsset(type, id);
  if (!asset) return null;
  const source = asset.source;
  return { ...structuredClone(asset.definition), createdAt: source.createdAt,
    updatedAt: source.updatedAt };
}

/** 角色绑定即要求当前引擎发现完整包；安装失败中止本轮，不改变用户模型选择。 */
export async function prepareChatRoleSkills(workspacePath: string, runtime: ChatRoleRuntime | null, engine: EngineType): Promise<RequiredWorkspaceSkill[]> {
  const requirements: RequiredWorkspaceSkill[] = [];
  for (const skill of runtime?.skills ?? []) {
    if (engine !== "codex" && engine !== "claude") throw new Error(`Skill 不支持当前执行引擎：${engine}`);
    const installed = await ensureSkillPackageInstalled({ workspacePath, skill, targets: [engine] });
    const status = installed.status.find(item => item.targetId === engine);
    if (!status?.ready) throw new Error(`角色绑定的 Skill 安装后未就绪：${skill.id}`);
    if (!skill.slug) throw new Error(`角色绑定的 Skill 缺少 slug：${skill.id}`);
    requirements.push({ name: skill.slug, expectedPath: path.join(status.installedPath, "SKILL.md") });
  }
  return requirements;
}

/** 合并多个工具注册表，按 toolId 去重；后面的注册表优先。 */
export function mergeExecutableToolRegistries(
  ...registries: Array<ExecutableToolRegistry | null | undefined>
): ExecutableToolRegistry | null {
  const tools = new Map<string, ExecutableToolDescriptor>();
  for (const registry of registries) {
    for (const tool of registry?.tools ?? []) {
      tools.set(String(tool.toolId), tool);
    }
  }
  const merged = Array.from(tools.values());
  return merged.length ? { tools: merged } : null;
}

/** 生成普通聊天动态平台工具已注册的 developer 补充说明。 */
export function buildNativeDynamicToolDeveloperMessageForChat(toolRegistry: ExecutableToolRegistry | null): string | null {
  if (!toolRegistry?.tools.length) return null;
  const toolList = toolRegistry.tools
    .map((tool) => `${tool.toolId}（${tool.alias || tool.name}）`)
    .join("，");
  return [
    "补充说明：当前这些平台补充能力已经作为真实工具注册好了。",
    `已注册工具：${toolList}`,
    "需要时直接调用工具名，不要输出任何 assistant 文本 JSON 协议。",
    "这是普通聊天回合，没有编排节点结果提交协议，也没有 runtime.submitNodeResult 工具。",
  ].join("\n");
}

/** 解析角色默认知识库，并把正文知识裁剪到 prompt 可承载范围。 */
function resolveRoleKnowledge(input: {
  session: OrchAssetAuthorityRuntimeReadSession;
  role: RoleDefinition;
  workspaceId: WorkspaceId;
  knowledgeRuntime: KnowledgeRuntimeService;
}): { catalogs: KnowledgeCatalogSnapshot[] } {
  const bundleIds = Array.from(new Set((input.role.defaultKnowledgeBundleIds ?? []).map((id) => String(id).trim()).filter(Boolean)));
  const catalogs: KnowledgeCatalogSnapshot[] = [];
  for (const rawBundleId of bundleIds) {
    const bundleId = rawBundleId as KnowledgeBundleId;
    const bundle = readDefinition(input.session, "knowledge_bundle", bundleId);
    if (!bundle) throw new Error(`角色「${input.role.name}」绑定的知识库不存在：${bundleId}`);
    assertWorkspaceMatch("知识库", bundle.workspaceId, input.workspaceId, bundle.id);
    catalogs.push(input.knowledgeRuntime.buildCatalog(bundle));
  }

  const selectedInlineItems = input.knowledgeRuntime.trimInlineItemsForPrompt(
    catalogs.flatMap((catalog) => catalog.inlineItems ?? []),
  );
  const inlineBySourceKey = new Map(selectedInlineItems.map((item) => [item.sourceKey, item]));
  return {
    catalogs: catalogs.map((catalog) => ({
      ...catalog,
      inlineItems: (catalog.inlineItems ?? [])
        .map((item) => inlineBySourceKey.get(item.sourceKey))
        .filter((item): item is KnowledgeCatalogSnapshot["inlineItems"][number] => Boolean(item)),
    })),
  };
}

/** 解析角色绑定工具，缺失或跨工作区时显式失败。 */
function buildRoleToolRegistry(input: {
  session: OrchAssetAuthorityRuntimeReadSession;
  role: RoleDefinition;
  workspaceId: WorkspaceId;
}): ExecutableToolRegistry | null {
  const tools: ExecutableToolDescriptor[] = [];
  for (const ref of input.role.toolRefs ?? []) {
    const toolset = readDefinition(input.session, "toolset", ref.toolsetId);
    if (!toolset) throw new Error(`角色「${input.role.name}」绑定的工具集不存在：${ref.toolsetId}`);
    assertWorkspaceMatch("工具集", toolset.workspaceId, input.workspaceId, toolset.id);
    const tool = toolset.tools.find((item) => item.id === ref.toolId);
    if (!tool) throw new Error(`角色「${input.role.name}」绑定的工具不存在：${ref.toolsetId}/${ref.toolId}`);
    tools.push(toExecutableTool(toolset, tool, ref));
  }
  return tools.length ? { tools } : null;
}

/** 将工具集定义转换为模型可调用的运行时工具描述。 */
function toExecutableTool(
  toolset: ToolsetDefinition,
  tool: ToolDefinition,
  ref: ToolRef,
): ExecutableToolDescriptor {
  return {
    toolsetId: toolset.id,
    toolsetName: toolset.name,
    toolId: tool.id,
    name: tool.name,
    alias: ref.alias ?? null,
    description: tool.description,
    runtime: tool.runtime,
    usageGuidance: ref.usageGuidance ?? null,
    invocationHint: tool.invocationHint ?? null,
    code: tool.code,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    timeoutMs: tool.timeoutMs ?? null,
    workingDirectory: tool.workingDirectory ?? null,
    permissions: {
      requiresWrite: Boolean(tool.requiresWrite),
    },
    envPolicy: tool.envPolicy ?? null,
    required: ref.required ?? false,
  };
}

/** 构造 system 层的角色身份与普通聊天边界。 */
function buildRoleSystemRule(role: RoleDefinition): string {
  const coreResponsibility = String(role.responsibility ?? role.description ?? "").trim();
  return xmlBlockNode("chat_role_system", [
    xmlTextNode("role_identity", coreResponsibility || role.name, {
      roleId: role.id,
      name: role.name,
      kind: role.kind,
    }),
    role.systemPrompt ? xmlTextNode("role_rules", role.systemPrompt) : "",
    xmlTextNode(
      "ordinary_chat_boundary",
      "当前是普通聊天，不是编排节点执行。角色只影响本轮提示、知识引用和角色工具；不得引入节点结果提交协议。",
    ),
  ]);
}

/** 构造 developer 层的角色契约、知识协议和工具协议。 */
function buildRoleDeveloperMessage(
  role: RoleDefinition,
  knowledge: { catalogs: KnowledgeCatalogSnapshot[] },
  toolRegistry: ExecutableToolRegistry | null,
): string | null {
  const warnings = knowledge.catalogs.flatMap((catalog) => catalog.warnings ?? []);
  const blocks = [
    xmlBlockNode("chat_role_contract", [
      xmlTextNode("input_definition", formatJson(role.inputDefinition)),
      xmlTextNode("output_definition", formatJson(role.outputDefinition)),
      role.gateCriteria?.length ? xmlTextNode("gate_criteria", formatJson(role.gateCriteria)) : "",
      xmlTextNode("rule", "角色 executionConfig 不接管普通聊天的 engine、model、effort 或 accessMode；这些仍以当前会话和 Composer 选择为准。"),
      xmlTextNode("rule", "普通聊天没有 runtime.submitNodeResult、control.nextAction 或节点结果提交协议；不要输出或伪造这些协议。"),
    ]),
    xmlBlockNode("knowledge_contract", [
      xmlTextNode("rule", "角色知识库是参考材料。正文型知识放在 user 层；文件和目录型知识只给路径引用。"),
      xmlTextNode("rule", "需要查看路径引用内容时，直接使用引擎原生 Read/Glob/Bash 等能力读取当前工作区。"),
      xmlTextNode("rule", "引用知识时必须基于实际可见正文或已读取内容，不要假设未读取文件。"),
    ]),
    toolRegistry?.tools.length
      ? xmlBlockNode("platform_capabilities", [
        xmlTextNode("rule", "角色绑定工具已注册为真实平台工具；需要时直接调用工具，不要输出 assistant 文本 JSON 协议。"),
        xmlTextNode("rule", "引擎原生工具仍保持可用，通用读写、搜索、测试和交互能力优先使用引擎原生能力。"),
        xmlBlockNode("tool_registry", toolRegistry.tools.map(formatTool)),
      ])
      : "",
    warnings.length
      ? xmlBlockNode("knowledge_warnings", warnings.map((warning) => xmlTextNode("warning", `${warning.code}: ${warning.message}`, {
        bundleId: warning.bundleId,
        sourceId: warning.sourceId,
      })))
      : "",
  ].filter(Boolean);
  return blocks.length ? xmlBlockNode("chat_role_developer", blocks) : null;
}

/** 构造 user 层消息，保留用户原文并附加角色知识。 */
function buildRoleUserMessage(userMessage: string, catalogs: KnowledgeCatalogSnapshot[]): string {
  const inlineKnowledge = catalogs.flatMap((catalog) => catalog.inlineItems ?? []);
  const runtimeSources = catalogs.flatMap((catalog) => catalog.runtimeSources ?? []);
  const blocks = [
    xmlTextNode("chat_message", userMessage),
    inlineKnowledge.length
      ? xmlBlockNode("inline_knowledge", inlineKnowledge.map((item) => xmlBlockNode("knowledge_item", [
        xmlTextNode("body", item.bodyText),
      ], {
        title: item.title,
        kind: item.sourceKind,
        description: item.description ?? undefined,
      })))
      : "",
    runtimeSources.length
      ? xmlBlockNode("reference_paths", runtimeSources.map(formatRuntimeSource))
      : "",
  ].filter(Boolean);
  return xmlBlockNode("chat_role_user", blocks);
}

/** 渲染文件/目录型知识引用，避免把项目文件正文直接塞入 prompt。 */
function formatRuntimeSource(source: RuntimeKnowledgeSource): string {
  return xmlTextNode(
    "source_ref",
    source.description
      ? `${source.description}。查看方式：直接使用引擎原生 Read/Glob/Bash 等能力。`
      : "查看方式：直接使用引擎原生 Read/Glob/Bash 等能力。",
    {
      kind: source.sourceKind,
      path: source.workspaceRelPath || source.originRef,
      usage: source.title,
      targetType: source.targetType,
    },
  );
}

/** 渲染单个角色工具的模型可见说明。 */
function formatTool(tool: ExecutableToolDescriptor): string {
  return xmlBlockNode("tool", [
    xmlTextNode("item", tool.description, { key: "description" }),
    tool.invocationHint ? xmlTextNode("item", tool.invocationHint, { key: "invocation_hint" }) : "",
    tool.usageGuidance ? xmlTextNode("item", tool.usageGuidance, { key: "usage_guidance" }) : "",
    tool.inputSchema ? xmlTextNode("item", tool.inputSchema, { key: "input_schema" }) : "",
    tool.outputSchema ? xmlTextNode("item", tool.outputSchema, { key: "output_schema" }) : "",
    xmlTextNode("item", tool.permissions.requiresWrite ? "会修改工作区文件" : "默认只做只读检查", { key: "permissions" }),
  ].filter(Boolean), {
    toolId: tool.toolId,
    name: tool.name,
    runtime: tool.runtime,
    required: tool.required ? "true" : "false",
    alias: tool.alias ?? undefined,
  });
}

/** 校验角色依赖资产仍在当前工作区边界内。 */
function assertWorkspaceMatch(label: string, assetWorkspaceId: WorkspaceId, currentWorkspaceId: WorkspaceId, id: string): void {
  if (assetWorkspaceId === currentWorkspaceId) return;
  throw new Error(`${label}不属于当前工作区：${id}`);
}

/** 以稳定缩进渲染结构化角色合同。 */
function formatJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/** 渲染 XML 块节点，空子节点会被丢弃。 */
function xmlBlockNode(tag: string, children: string[], attrs?: Record<string, unknown>): string {
  const body = children.map((item) => String(item ?? "").trim()).filter(Boolean).join("\n");
  return `<${tag}${formatAttrs(attrs)}>\n${body}\n</${tag}>`;
}

/** 渲染 XML 文本节点，并转义正文。 */
function xmlTextNode(tag: string, text: unknown, attrs?: Record<string, unknown>): string {
  return `<${tag}${formatAttrs(attrs)}>${escapeXml(String(text ?? ""))}</${tag}>`;
}

/** 渲染 XML 属性，空属性不输出。 */
function formatAttrs(attrs?: Record<string, unknown>): string {
  const pairs = Object.entries(attrs ?? {})
    .filter(([, value]) => value != null && String(value).trim() !== "")
    .map(([key, value]) => `${key}="${escapeXml(String(value))}"`);
  return pairs.length ? ` ${pairs.join(" ")}` : "";
}

/** 转义 XML 特殊字符，避免角色内容破坏标签结构。 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
