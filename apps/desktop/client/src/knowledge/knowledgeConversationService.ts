import crypto from "node:crypto";
import { extractTurnErrorMetadata, type ConversationEventInput, type EngineType, type KnowledgeGenerationRun, type KnowledgeConversationSummary, type ThreadId, type WorkspaceId, type SharedWorkspaceId, type KnowledgeAssetActorContext } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import type { PersistedThread } from "../db/repos/threadRepo.js";
import type { SharedWorkspaceToolExecutionContext } from "../app/sharedWorkspaceToolPolicy.js";
import type { HostToolExecutionResult } from "../engines/threadSession.js";
import { KnowledgeAssetError, knowledgeFailure, knowledgeHash, knowledgeId, knowledgeRecord, knowledgeText } from "./knowledgeAssetFiles.js";
import { KnowledgeAssetStore, knowledgeCategoryNodes, parseKnowledgeAssetTree } from "./knowledgeAssetStore.js";
import { buildKnowledgeAssetGenerationTools, buildKnowledgeAssetReadTools, executeKnowledgeAssetReadTool, knowledgeAssetReadCacheKey, knowledgeTool, KNOWLEDGE_SPECIFICATION_POLICY } from "./knowledgeAssetTools.js";

export type KnowledgeConversationActor = Pick<KnowledgeAssetActorContext, "userId" | "permissionScope">;
export function readKnowledgeConversationActor(value: unknown): KnowledgeConversationActor | null {
  if (!value || typeof value !== "object") return null;
  const actor = value as Record<string, unknown>;
  if (typeof actor.userId !== "string" || !actor.userId.trim() || !["account", "shared_member", "shared_asset_admin"].includes(String(actor.permissionScope))) return null;
  return { userId: actor.userId, permissionScope: actor.permissionScope as KnowledgeConversationActor["permissionScope"] };
}
type ConversationInput = { db: ClientDb; store: KnowledgeAssetStore; workspaceId: string; actor: KnowledgeConversationActor; sharedWorkspaceId?: string | null };
type ConversationRecord = { thread_id: string; node_id: string | null; created_by_user_id: string; active: number; activation_version: number };

/** 从项目任务事实取得后台宿主；是否为空由列表仓储在分页前核对事件。 */
export function knowledgeTaskOwnerThreadIds(workspacePath: string): string[] {
  const store = new KnowledgeAssetStore(workspacePath);
  const ids = store.files.directories(`${store.root}/runs`).map(id => store.readRun(id))
    .filter(run => run.mode !== "conversation")
    .map(run => run.ownerThreadId ?? run.threadId).filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
type KnowledgeExecutionBinding = {
  run: KnowledgeGenerationRun;
  item: KnowledgeGenerationRun["items"][number];
  kind: "generation" | "review";
};
function assertWriter(actor: KnowledgeConversationActor): void {
  if (actor.permissionScope !== "account" && actor.permissionScope !== "shared_asset_admin") {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "当前身份不能维护项目知识", 403);
  }
}
function record(db: ClientDb, threadId: string): ConversationRecord | null {
  return db.db.prepare("SELECT * FROM knowledge_conversations WHERE thread_id = ?").get(threadId) as ConversationRecord | undefined ?? null;
}
function findKnowledgeExecutionBinding(store: KnowledgeAssetStore, threadId: string): KnowledgeExecutionBinding | null {
  for (const run of store.listRuns()) {
    for (const item of run.items) {
      if (item.executionThreadId === threadId) return { run, item, kind: "generation" };
      if (item.review?.executionThreadId === threadId) return { run, item, kind: "review" };
    }
  }
  return null;
}
function allowed(input: ConversationInput, thread: PersistedThread, conversation: ConversationRecord): boolean {
  if (thread.workspaceId !== input.workspaceId || thread.threadType !== "chat" || thread.threadSubtype !== "knowledge-conversation" || thread.archived) return false;
  if (input.actor.permissionScope === "account") return !thread.sharedWorkspaceId && conversation.created_by_user_id === input.actor.userId;
  return Boolean(input.sharedWorkspaceId && thread.sharedWorkspaceId === input.sharedWorkspaceId && (thread.ownerUserId === input.actor.userId || thread.sharedParticipantUserIds.includes(input.actor.userId)));
}
function summary(thread: PersistedThread, conversation: ConversationRecord): KnowledgeConversationSummary {
  return { threadId: thread.id, createdByUserId: conversation.created_by_user_id, title: thread.title, nodeId: conversation.node_id, engine: thread.engine, model: thread.model, effort: thread.effort, active: conversation.active === 1, createdAt: thread.createdAt, updatedAt: thread.updatedAt };
}
function requireConversation(input: ConversationInput & { threadId: string }) {
  assertWriter(input.actor);
  const thread = input.db.threads.get(input.threadId as ThreadId), conversation = record(input.db, input.threadId);
  if (!thread || !conversation || !allowed(input, thread, conversation)) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "请选择当前项目内自己拥有或参与的独立知识会话", 403);
  }
  return { thread, conversation };
}
export function listKnowledgeConversations(input: ConversationInput): KnowledgeConversationSummary[] {
  assertWriter(input.actor);
  const records = input.db.db.prepare("SELECT k.* FROM knowledge_conversations k JOIN threads t ON t.id = k.thread_id WHERE t.workspace_id = ? AND t.archived = 0 ORDER BY t.updated_at DESC, t.id ASC").all(input.workspaceId) as ConversationRecord[];
  return records.flatMap(conversation => {
    const thread = input.db.threads.get(conversation.thread_id as ThreadId);
    return thread && allowed(input, thread, conversation) ? [summary(thread, conversation)] : [];
  });
}
export function createKnowledgeConversation(input: ConversationInput & { nodeId: string | null; engine: EngineType; title?: string | null; model?: string | null; effort?: string | null; reservedThreadId?: string }): KnowledgeConversationSummary {
  assertWriter(input.actor);
  if (input.engine !== "codex" && input.engine !== "claude") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "请选择支持的模型引擎", 400);
  if (input.actor.permissionScope !== "account" && !input.sharedWorkspaceId) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "缺少共享工作区身份", 403);
  const node = input.nodeId ? input.store.node(input.nodeId) : null;
  // 创建始终得到独立会话；继续历史会话必须显式调用 connect。
  const threadId = (input.reservedThreadId ? knowledgeText(input.reservedThreadId, 200, true) : `knowledge_${crypto.randomUUID()}`) as ThreadId;
  return input.db.db.transaction(() => {
    const thread = input.db.threads.create({ id: threadId, workspaceId: input.workspaceId as WorkspaceId, engine: input.engine,
      title: knowledgeText(input.title || (node ? `${node.title} · 知识专题` : "项目知识会话"), 200, true), threadType: "chat", threadSubtype: "knowledge-conversation",
      prefs: { model: input.model ?? null, effort: input.effort ?? null, accessMode: "read-only" },
      sharedAcl: input.sharedWorkspaceId ? { sharedWorkspaceId: input.sharedWorkspaceId as SharedWorkspaceId, ownerUserId: input.actor.userId, visibility: "private", participantUserIds: [] } : null,
    });
    input.db.db.prepare("INSERT INTO knowledge_conversations (thread_id, node_id, created_by_user_id) VALUES (?, ?, ?)").run(threadId, input.nodeId, input.actor.userId);
    return summary(thread, record(input.db, threadId)!);
  })();
}
export function connectKnowledgeConversation(input: ConversationInput & { threadId: string }): KnowledgeConversationSummary {
  const { thread, conversation } = requireConversation(input);
  if (conversation.node_id) input.store.node(conversation.node_id);
  if (!conversation.active) input.db.db.prepare("UPDATE knowledge_conversations SET active = 1, activation_version = activation_version + 1 WHERE thread_id = ?").run(input.threadId);
  return summary(thread, record(input.db, input.threadId)!);
}
export function endKnowledgeConversation(input: ConversationInput & { threadId: string }): KnowledgeConversationSummary {
  const { thread } = requireConversation(input);
  // 即刻撤销工具权限；运行中的引擎由调用边界停止，历史与固定范围一直保留。
  input.db.db.prepare("UPDATE knowledge_conversations SET active = 0, activation_version = activation_version + 1 WHERE thread_id = ?").run(input.threadId);
  return summary(thread, record(input.db, input.threadId)!);
}
export function requireKnowledgeConversationOwner(input: ConversationInput & { threadId: string }): KnowledgeConversationSummary & { activationVersion: number } {
  const { thread, conversation } = requireConversation(input);
  if (!conversation.active) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "知识协作已结束，请先重新进入知识会话");
  return { ...summary(thread, conversation), activationVersion: conversation.activation_version };
}

type TurnInput = {
  db: ClientDb; store: KnowledgeAssetStore; workspaceId: string; threadId: string; turnId: string;
  engine: EngineType; model: string | null; effort: string | null; prompt: string;
  isActive: () => boolean; sharedContext?: SharedWorkspaceToolExecutionContext | null;
  trustedActor?: KnowledgeConversationActor | null;
};

/** 专属会话固定权限与范围；资产续聊沿用绑定节点及本轮正文基线，不依赖旧引擎补参数。 */
export function createKnowledgeConversationTurn(input: TurnInput) {
  const thread = input.db.threads.get(input.threadId as ThreadId);
  const execution = thread?.threadSubtype === "knowledge-assets" ? findKnowledgeExecutionBinding(input.store, input.threadId) : null;
  const isExecution = Boolean(execution);
  if (thread?.threadSubtype !== "knowledge-conversation" && !isExecution) return null;
  if (!input.trustedActor) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "知识会话缺少当前回合可信身份", 403);
  const ownerInput = { ...input, actor: input.trustedActor, sharedWorkspaceId: input.sharedContext?.sharedWorkspaceId };
  const owner = isExecution ? null : requireKnowledgeConversationOwner(ownerInput);
  const executionOwnerId = execution?.run.ownerThreadId ?? execution?.run.threadId;
  const executionOwner = executionOwnerId ? requireKnowledgeConversationOwner({ ...ownerInput, threadId: executionOwnerId }) : null;
  if (isExecution && !executionOwner) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "资产执行缺少可核验的所属知识会话", 403);
  if (isExecution && (!thread || thread.archived || thread.workspaceId !== input.workspaceId || !execution)) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "知识工作会话已失效", 403);
  }
  if (isExecution && thread?.sharedWorkspaceId) {
    const related = thread.ownerUserId === input.trustedActor.userId || thread.sharedParticipantUserIds.includes(input.trustedActor.userId);
    if (!related || input.sharedContext?.sharedWorkspaceId !== thread.sharedWorkspaceId) {
      throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "只能访问自己拥有或参与的知识工作会话", 403);
    }
  }
  if (thread?.sharedWorkspaceId && input.sharedContext?.toolPolicyKey !== "ai.shared.write" && input.sharedContext?.operationKey !== "ai.thread.send.shared") {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "维护共享知识需要共享写入会话上下文", 403);
  }
  const executionRecord = isExecution ? record(input.db, input.threadId) : null;
  const binding = { nodeId: owner?.nodeId ?? execution?.item.nodeId ?? null, version: executionRecord?.activation_version ?? 1 };
  const store = execution ? input.store.forRun(execution.run.id) : input.store;
  const initial = { ...store.readTree(), hash: input.store.readTree().hash };
  if (binding.nodeId) store.node(binding.nodeId, initial.tree);
  const boundDocumentHash = execution?.kind === "generation" ? store.currentHash(binding.nodeId!) : null;
  const boundNodeShape = binding.nodeId ? (() => {
    const node = store.node(binding.nodeId!, initial.tree);
    const children = initial.tree.nodes.filter(candidate => candidate.parentId === node.id && !candidate.archived);
    const preview = children.slice(0, 80);
    const childList = preview.map(child => child.title + (child.summary && preview.length <= 20 ? "：" + child.summary : "")).join("；");
    const remainder = children.length > preview.length ? "；其余子资产按目录读取，不要把它们的正文复制到父节点" : "";
    return children.length
      ? "本专题包含子资产：" + childList + remainder + "。目录负责导航，正文只解释本专题值得长期维护的关键机制，避免重复子资产，不设置字数目标。"
      : "围绕本专题解决的具体问题归纳有直接证据的关键事实，不套固定章节或字数要求。";
  })() : "";
  const registry = execution?.kind === "review" ? buildKnowledgeAssetReadTools(true, true) : buildKnowledgeAssetGenerationTools("plan");
  if (execution?.kind !== "review") {
    const planTool = registry.tools.find(t => t.toolId === "knowledge.plan.submit")!;
    const planSchema = JSON.parse(planTool.inputSchema!);
    planSchema.properties.projectInstructions = { type: "string", description: "仅在用户明确要求保存项目默认要求时填写；仅项目根范围允许。" };
    planTool.inputSchema = JSON.stringify(planSchema);
    const documentTool = buildKnowledgeAssetGenerationTools("document").tools.find(t => t.toolId === "knowledge.asset.submit")!;
    const documentSchema = JSON.parse(documentTool.inputSchema!);
    documentSchema.properties.nodeId = { type: "string" };
    documentSchema.properties.expectedHash = { type: ["string", "null"] };
    if (!isExecution) documentSchema.required.push("nodeId", "expectedHash");
    registry.tools.push({ ...documentTool, description: isExecution
      ? "提交当前绑定资产的完整文档和来源；nodeId、expectedHash 可省略，使用绑定节点和本轮开始时的正文基线。新版本待用户采用。"
      : "提交指定已采用节点的完整文档和来源；expectedHash 使用 knowledge.node.read 的 currentHash。已有正文的新版本待用户采用。", inputSchema: JSON.stringify(documentSchema) });
    registry.tools.push(knowledgeTool("knowledge.plan.read", "分页读取本会话尚未采用的目录计划，按用户后续要求调整；用 nextOffset 继续。", { type: "object", properties: { offset: { type: "integer", minimum: 0 } }, additionalProperties: false }));
  }
  if (isExecution) registry.tools = registry.tools.filter(tool => !["knowledge.plan.read", "knowledge.plan.submit", "knowledge.tree.read", "knowledge.search"].includes(String(tool.toolId)));
  const run: KnowledgeGenerationRun = {
    schemaVersion: 1, id: `run_${knowledgeHash(`${input.threadId}:${input.turnId}`).slice(0, 32)}`,
    createdAt: new Date().toISOString(), mode: "conversation", nodeId: binding.nodeId, ownerThreadId: input.threadId,
    prompt: input.prompt.slice(0, 16000), engine: input.engine, threadId: input.threadId,
    model: input.model, effort: input.effort, treeHash: initial.hash, proposedTree: null,
    baseTree: initial.tree,
    rationale: "正在读取项目证据，可以在会话中停止或补充要求。", gaps: [], items: [], phase: "planning", error: null,
  };
  let finished = false;
  // 一轮知识对话内只读证据按参数复用，并限制导航预算。
  // 这样模型即使重复发起同一读取，也不会把整棵资产树放大成数百次调用。
  const readCache = new Map<string, HostToolExecutionResult>();
  const readCounts = new Map<string, number>();
  const assertActive = () => {
    if (executionOwner && executionOwnerId) {
      const currentOwner = requireKnowledgeConversationOwner({ ...ownerInput, threadId: executionOwnerId });
      if (currentOwner.activationVersion !== executionOwner.activationVersion) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "所属知识会话已结束或重新连接，旧执行回合失效");
      if (!store.scope(currentOwner.nodeId).some(node => node.id === binding.nodeId)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SCOPE_INVALID", "资产执行超出原会话范围", 403);
    }
    const current = record(input.db, input.threadId);
    const executionAlive = isExecution && Boolean(input.db.threads.get(input.threadId as ThreadId)?.archived === false);
    const conversationAlive = !isExecution && current?.activation_version === binding.version && current.active === 1;
    if (finished || !input.isActive() || !(executionAlive || conversationAlive)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "会话已停止或知识范围已变更，本次提交未写入");
  };
  const inScope = (nodeId: string) => {
    if (isExecution && nodeId !== binding.nodeId) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SCOPE_INVALID", "资产执行会话只能读写绑定知识", 403);
    if (!store.scope(binding.nodeId).some(n => n.id === nodeId)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SCOPE_INVALID", "只能提交当前知识范围内的知识");
  };
  const releases: Array<() => void> = [];
  /** 释放本轮及原资产任务的占用；各次释放失败均显式上报。 */
  const releaseExecutions = () => {
    const failures: unknown[] = [];
    for (const release of [...releases].reverse()) {
      try { release(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, `知识会话执行占用释放失败：${run.id}`);
  };
  try {
    if (execution) releases.push(store.claimRunExecution(execution.run.id));
    releases.push(store.claimRunExecution(run.id));
    store.saveRun(run);
  } catch (error) {
    try { releaseExecutions(); }
    catch (releaseError) { throw new AggregateError([error, releaseError], `知识会话启动失败且占用未释放：${run.id}`); }
    throw error;
  }
  return {
    registry,
    // 与构建 worker 保持同一权限模式：原生文件只读，知识写入仍由绑定工具控制。
    conversationProfile: "orchestration" as const,
    instructions: [
      isExecution ? (execution?.kind === "review" ? "这是当前资产的独立复检会话。可以继续询问复检依据和问题；需要修改正文时请回到对应的资产工作会话。" : "这是当前资产的独立资产工作会话。可以继续补充要求，AI 读取证据后通过知识工具提交修订版本。") : "当前会话正在协作维护项目知识。正常回答、澄清和连续调整都在本会话进行；用户只在讨论时不要强行提交。",
      `当前知识范围：${binding.nodeId ?? "项目根"}。先用 knowledge.tree.read 返回的 nodeStates.hasCurrent/hasDraft 判断资产状态；只有需要正文、来源或 currentHash 时才调用 node.read，再用 source.list/source.read 按需核对项目事实，不将整库塞入上下文。`,
      "一级目录固定为规格约束、系统架构、产品文档，二级专题按需要创建。系统架构仅沉淀跨文件理解且容易误改的机制和有依据的决策，产品文档引用有效原文并检索，不重复改写。目录调整先用knowledge.plan.read读取最近计划，再用knowledge.plan.submit提交，已有节点保持ID。旧库未归类时先提出三类目录计划并等待采用。",
      KNOWLEDGE_SPECIFICATION_POLICY,
      boundNodeShape,
      "围绕专题问题归纳有直接证据的事实；完成后删除重复和无依据内容，不引入新事实，不按固定章节补齐全文。",
      "文档用 knowledge.asset.submit 提交；先读节点取得 currentHash 作为 expectedHash，来源使用 source.read 返回的完整指纹。批量资产按节点逐次提交，停止前已提交的资产会保留；已有正文的新版本等待采用。",
      "不得直接修改知识文件或业务源码。普通文字不算已交付；工具成功后解释交付物。已有正文的新版本等待采用，不可宣称已覆盖。",
      "用户明确要求保存目录要求时通过计划提交节点 instructions；保存项目默认要求时在项目根范围提交 projectInstructions。区分事实、推断和缺口，引用直接证据。",
    ].join("\n"),
    execute(toolId: string, raw: unknown): HostToolExecutionResult {
      assertActive();
      if (!registry.tools.some(t => String(t.toolId) === toolId)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_TOOL_UNKNOWN", "未注册的知识工具", 400);
      if (toolId === "knowledge.plan.read") {
        const offset = knowledgeRecord(raw).offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "计划分页位置无效", 400);
        const plan = run.proposedTree ? run : store.listRuns().find(r => r.threadId === input.threadId && r.nodeId === binding.nodeId && r.proposedTree && r.treeHash === run.treeHash && r.id !== run.id);
        const nodes = plan?.proposedTree?.nodes ?? [];
        return { ok: true, output: plan ? { runId: plan.id, nodes: nodes.slice(Number(offset), Number(offset) + 100), projectInstructions: plan.proposedTree!.instructions, rationale: plan.rationale, gaps: plan.gaps, nextOffset: Number(offset) + 100 < nodes.length ? Number(offset) + 100 : null } : { runId: null, nodes: [], nextOffset: null } };
      }
      if (toolId === "knowledge.plan.submit") {
        const data = knowledgeRecord(raw);
        if (!Array.isArray(data.nodes) || data.nodes.length > 1000) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "一次计划最多提交 1000 个节点", 400);
        input.store.assertTreeHash(run.treeHash);
        const previousPlan = store.listRuns().find(r => r.threadId === input.threadId && r.nodeId === binding.nodeId && r.proposedTree && r.treeHash === run.treeHash && r.id !== run.id);
        const base = run.proposedTree ?? previousPlan?.proposedTree ?? initial.tree;
        const merged = new Map<string, unknown>(base.nodes.map(n => [n.id, n]));
        const ids = new Set<string>();
        for (const value of data.nodes) {
          const n = knowledgeRecord(value), id = knowledgeId(n.id);
          if (ids.has(id)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_TREE_INVALID", "计划节点 ID 重复", 400);
          if (initial.tree.nodes.some(n => n.id === id) && binding.nodeId) inScope(id);
          ids.add(id); merged.set(id, n);
        }
        if (data.projectInstructions !== undefined && binding.nodeId) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SCOPE_INVALID", "保存项目要求请先选择项目范围");
        const categories = knowledgeCategoryNodes();
        const policy = !initial.tree.nodes.length || base.schemaVersion === 3 || [...merged.values()].some(value => { const node = knowledgeRecord(value); return node.category !== undefined || node.appliesTo !== undefined || categories.some(category => category.id === node.parentId); });
        const proposed = parseKnowledgeAssetTree({ ...base, ...(policy ? { schemaVersion: 3 } : {}), instructions: data.projectInstructions === undefined ? base.instructions : knowledgeText(data.projectInstructions, 16000), nodes: policy ? [...new Map([...categories, ...merged.values()].map(value => [knowledgeRecord(value).id, value])).values()] : [...merged.values()] });
        store.validateSourceScope(proposed);
        if (binding.nodeId) for (const id of ids) {
          if (!store.ancestry(id, proposed).some(n => n.id === binding.nodeId)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_SCOPE_INVALID", "建议节点必须在当前目录下");
        }
        if (!Array.isArray(data.gaps) || data.gaps.length > 100) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "缺口列表无效", 400);
        run.gaps = data.gaps.map(g => knowledgeText(g, 2000, true));
        run.rationale = knowledgeText(data.rationale, 8000, true);
        run.proposedTree = proposed; run.mode = "tree"; run.phase = "planned";
        store.saveRun(run);
        return { ok: true, output: { accepted: true, runId: run.id, nodeCount: proposed.nodes.length, requiresTreeAdoption: true } };
      }
      if (toolId === "knowledge.asset.submit") {
        const data = knowledgeRecord(raw), nodeId = knowledgeId(data.nodeId === undefined && execution?.kind === "generation" ? binding.nodeId : data.nodeId);
        store.assertTreeHash(run.treeHash);
        inScope(nodeId);
        if (store.category(nodeId) === "product") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "产品文档保留原文，请导入或更新原始资料，不通过AI改写正文", 400);
        if (!Array.isArray(data.sources) || !data.sources.length) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "知识必须包含直接来源", 400);
        const expectedHash = data.expectedHash === undefined && execution?.kind === "generation" && nodeId === binding.nodeId ? boundDocumentHash
          : data.expectedHash === null ? null : knowledgeText(data.expectedHash, 64, true);
        const instructions = [store.effectiveInstructions(nodeId), run.prompt].filter(Boolean).join("\n\n");
        const revision = store.saveDocument({ nodeId, content: knowledgeText(data.content, 2_000_000, true), sources: data.sources, expectedHash, origin: "ai", instructions, userInstructions: instructions, summary: knowledgeText(data.summary, 4000), runId: execution?.run.id ?? run.id, ...(isExecution || store.category(nodeId) === "specifications" ? { adopt: false } : {}) });
        run.items.push({ id: `item_${crypto.randomUUID()}`, nodeId, title: store.node(nodeId).title, expectedHash, inheritedInstructions: store.effectiveInstructions(nodeId), instructions, status: "completed", revisionId: revision.id, error: null });
        if (execution?.kind === "generation") {
          const original = store.readRun(execution.run.id);
          const originalItem = original.items.find(item => item.id === execution.item.id);
          if (originalItem) {
            originalItem.status = "completed";
            originalItem.revisionId = revision.id;
            originalItem.expectedHash = expectedHash;
            originalItem.inheritedInstructions = store.effectiveInstructions(nodeId);
            originalItem.instructions = instructions;
            originalItem.repairReportId = undefined;
            originalItem.repairRevisionId = undefined;
            originalItem.maintenanceFingerprint = undefined;
            originalItem.error = null;
            if (originalItem.review && originalItem.reviewConfig?.enabled !== false) {
              originalItem.review = { ...originalItem.review, status: "pending", reportId: null, error: null, stale: false, staleReasons: [] };
            }
            store.saveRun(original);
          }
        }
        run.phase = run.proposedTree ? "planned" : "generating";
        run.rationale = `已保存 ${run.items.length} 份知识版本。`;
        store.saveRun(run);
        return { ok: true, output: { accepted: true, runId: execution?.run.id ?? run.id, nodeId, revisionId: revision.id, adopted: !isExecution && store.category(nodeId) !== "specifications" && expectedHash === null } };
      }
      const readInput = knowledgeRecord(raw);
      if (isExecution) {
        if (toolId === "knowledge.node.read" || toolId === "knowledge.revision.read" || toolId === "knowledge.review.report.read") inScope(knowledgeId(readInput.nodeId));
      }
      const readKey = knowledgeAssetReadCacheKey(toolId, readInput);
      const cached = readCache.get(readKey);
      if (cached) return cached;
      const count = (readCounts.get(toolId) ?? 0) + 1;
      readCounts.set(toolId, count);
      const limit = toolId === "knowledge.node.read" ? 96 : toolId === "knowledge.source.read" ? 128 : toolId === "knowledge.tree.read" ? 64 : 96;
      if (count > limit) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_READ_LIMIT_REACHED", `本轮 ${toolId} 读取次数已达到 ${limit} 次，请整理已有证据后继续`);
      const result = executeKnowledgeAssetReadTool(store, toolId, readInput);
      // 正文和搜索可能命中实时引用，每次调用必须重新核验原文件。
      if (result.ok && !["knowledge.node.read", "knowledge.search", "knowledge.rules.read"].includes(toolId)) readCache.set(readKey, result);
      return result;
    },
    finish(error?: unknown, interrupted = false): void {
      if (finished) return;
      // Provider 可直接拒绝 sendMessage，而不先发 canonical turn.error；不能依赖 DB 终态落盘顺序识别停止。
      if (error != null && extractTurnErrorMetadata(error).terminationKind === "manual_interrupt") {
        interrupted = true;
        error = undefined;
      }
      finished = true;
      try {
        const finalRun = store.readRun(run.id);
        // 有效提交保留为可采用计划；对话中没有提交也是合法讨论。
        if (finalRun.proposedTree) finalRun.phase = "planned";
        else if (interrupted) finalRun.phase = "interrupted";
        else if (error) finalRun.phase = finalRun.items.length ? "partial" : "failed";
        else finalRun.phase = "completed";
        if (error) finalRun.error = knowledgeFailure(error);
        if (!finalRun.items.length && !finalRun.proposedTree && !error) finalRun.rationale = interrupted
          ? "本轮已停止，可在同一会话补充要求后继续。"
          : "本轮交流已结束，可在同一会话继续补充要求。";
        store.saveRun(finalRun);
      } finally { releaseExecutions(); }
    },
  };
}

export function settleKnowledgeConversationEvent(turn: ReturnType<typeof createKnowledgeConversationTurn>, turnId: string, event: ConversationEventInput): void {
  if (event.type !== "turn.completed" && event.type !== "turn.error") return;
  if (event.payload.turnId !== turnId) return;
  if (event.type === "turn.completed") { turn?.finish(); return; }
  if (event.payload.terminationKind === "manual_interrupt") { turn?.finish(undefined, true); return; }
  turn?.finish(new KnowledgeAssetError("KNOWLEDGE_ASSET_ENGINE_FAILED", "知识会话回合失败，请查看会话中的错误信息"));
}
