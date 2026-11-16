import { KNOWLEDGE_ASSET_READ_ACTIONS, KNOWLEDGE_ASSET_WRITE_ACTIONS, type KnowledgeAssetAction, type KnowledgeGenerationApplyInput, type ThreadId, type WorkspaceId, type SharedThreadAclSyncItem, type SharedWorkspaceId } from "@codeflowai/shared";
import type { ThreadSharedAclInput } from "../../db/repos/threadRepo.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { KnowledgeAssetError, knowledgeFailure, knowledgeRecord, knowledgeText, requireKnowledgeAssetActorContext } from "../../knowledge/knowledgeAssetFiles.js";
import { KnowledgeAssetStore } from "../../knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService, type KnowledgeGenerateInput, type KnowledgeGenerationStartInput } from "../../knowledge/knowledgeGenerationService.js";
import { KnowledgeReviewStore } from "../../knowledge/knowledgeReviewStore.js";
import { KnowledgeChangeStore } from "../../knowledge/knowledgeChangeStore.js";
import { executeKnowledgeAssetReadTool } from "../../knowledge/knowledgeAssetTools.js";
import { createKnowledgeGenerationExecutor, isKnowledgeGenerationLogFailure } from "../../knowledge/knowledgeGenerationEngine.js";
import { listKnowledgeConversations, createKnowledgeConversation, connectKnowledgeConversation, endKnowledgeConversation, requireKnowledgeConversationOwner } from "../../knowledge/knowledgeConversationService.js";
import { logger } from "../../logger.js";
import { KnowledgeUpdateService } from "../../knowledge/knowledgeUpdateService.js";
import { resolveKnowledgeAssetsRoot } from "../../codeflowai/codeflowaiConfig.js";

/** Client 进程内复用项目文件 Store，避免每个 snapshot 请求重新解析工作区根和文件协议。 */
const knowledgeStores = new Map<string, { workspacePath: string; store: KnowledgeAssetStore }>();
/** 配置目录变化时替换实例，避免复用旧目录的树和快照缓存。 */
function getKnowledgeStore(workspaceId: string, workspacePath: string): KnowledgeAssetStore {
  const existing = knowledgeStores.get(workspaceId);
  if (existing?.workspacePath === workspacePath && existing.store.root === resolveKnowledgeAssetsRoot(workspacePath)) {
    knowledgeStores.delete(workspaceId);
    knowledgeStores.set(workspaceId, existing);
    return existing.store;
  }
  const store = new KnowledgeAssetStore(workspacePath);
  knowledgeStores.set(workspaceId, { workspacePath, store });
  while (knowledgeStores.size > 32) knowledgeStores.delete(knowledgeStores.keys().next().value!);
  return store;
}

/** 新知识入口不依赖旧发布、候选池或技能注册；可信身份仍由 Server 注入。 */
export async function handleKnowledgeAssetRequest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const action = req.method.slice("knowledge.assets.".length) as KnowledgeAssetAction;
  /** 会话事实和同步任务准入持短许可，知识生成与引擎停止等待在许可外。 */
  const database = <T>(operation: () => T): Promise<T> => ctx.withDatabase ? ctx.withDatabase(req.id, operation) : Promise.resolve(operation());
  try {
    const write = (KNOWLEDGE_ASSET_WRITE_ACTIONS as readonly string[]).includes(action);
    if (!write && !(KNOWLEDGE_ASSET_READ_ACTIONS as readonly string[]).includes(action)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "未知知识操作", 400);
    const input = knowledgeRecord(req.body);
    const actor = requireKnowledgeAssetActorContext(input.actorContext);
    // 本地工作区拥有者可维护自己的项目文件；共享入口使用 Server 的资产维护身份。
    const canWrite = actor.permissionScope === "account" || actor.permissionScope === "shared_asset_admin";
    if (write && !canWrite) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "当前共享角色无权维护项目知识", 403);
    const workspaceId = knowledgeText(input.workspaceId, 200, true) as WorkspaceId;
    const workspacePath = ctx.workspaces.get(workspaceId);
    if (!workspacePath) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_NOT_FOUND", "工作区不存在", 404);
    const store = getKnowledgeStore(workspaceId, workspacePath);
    const text = (key: string, max = 100) => knowledgeText(input[key], max, true);
    const nullable = (key: string) => input[key] === null ? null : text(key, 1000);
    const conversationInput = { db: ctx.db, store, workspaceId, actor, sharedWorkspaceId: input.sharedWorkspaceId == null ? null : text("sharedWorkspaceId", 200) };
    const candidateRead = ["node", "revision", "reviews"].includes(action) && input.runId !== undefined;
    // 项目候选及采用只依赖资产权限；继续或停止引擎才需要原会话的当次授权。
    const taskAccess = ["generate", "run.start", "run.stop"].includes(action);
    const task = taskAccess && action !== "generate" && conversationInput.sharedWorkspaceId ? store.readRun(text("runId")) : null;
    const expectedOwner = action === "generate" ? text("ownerThreadId", 200) : task?.ownerThreadId ?? task?.threadId;
    if (conversationInput.sharedWorkspaceId && taskAccess) {
      if (!expectedOwner || !input.sharedThreadAcl || input.verifiedOwnerThreadId !== expectedOwner) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "知识任务所属会话缺少当次权威授权", 403);
    }
    if (conversationInput.sharedWorkspaceId && input.sharedThreadAcl && (action === "conversation.connect" || action === "conversation.end" || taskAccess)) {
      const threadId = (taskAccess ? text("verifiedOwnerThreadId", 200) : text("threadId", 200)) as ThreadId;
      const thread = await database(() => ctx.db.threads.get(threadId));
      if (!thread || thread.workspaceId !== workspaceId || thread.sharedWorkspaceId !== conversationInput.sharedWorkspaceId) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "知识会话不属于当前共享工作区", 403);
      await database(() => ctx.db.threads.setSharedAcl(threadId, input.sharedThreadAcl as ThreadSharedAclInput));
    }
    if (action === "conversation.list" && conversationInput.sharedWorkspaceId && Array.isArray(input.sharedThreadAclSyncItems)) {
      await database(() => ctx.db.threads.setSharedAclMany({ workspaceId, sharedWorkspaceId: conversationInput.sharedWorkspaceId as SharedWorkspaceId, items: input.sharedThreadAclSyncItems as SharedThreadAclSyncItem[] }));
    }
    const generation = () => new KnowledgeGenerationService(store, workspaceId, createKnowledgeGenerationExecutor({
      db: ctx.db, threads: ctx.threads, sessions: ctx.sessions, timeoutPolicy: ctx.timeoutPolicy,
      isTaskAdmissionPaused: ctx.isTaskAdmissionPaused,
      withLegacyDatabase: ctx.withDatabase,
      flushLocalEvents: ctx.flushLocalEvents,
      emitConversation: event => { ctx.onBeforeEmitConversationEvent?.(event); ctx.send({ t: "conversation.event", event }); },
      emitRaw: event => ctx.send({ t: "raw.event", event }),
    }), actor.requestId, ownerThreadId => requireKnowledgeConversationOwner({ ...conversationInput, threadId: ownerThreadId }), ctx.db, ctx.withDatabase);
    /** 定时检查诊断固定于可信物理W，不从计划中的共享业务入口推导路径。 */
    const updates = () => new KnowledgeUpdateService(store, ctx.clientId, workspaceId, ctx.db, ctx.withDatabase);
    /** 候选树从项目任务读取，不依赖本机聊天记录，也不接受前端自带树。 */
    const readStore = () => {
      if (!candidateRead) return store;
      return store.forRun(text("runId"));
    };
    let data: unknown;
    switch (action) {
      case "update.schedule": data = updates().view(generation()); break;
      case "update.save": {
        const service = updates();
        service.save(input.schedule, nullable("expectedHash"), conversationInput.sharedWorkspaceId ? `shared:${conversationInput.sharedWorkspaceId}` : workspaceId);
        data = service.view(generation());
        break;
      }
      case "update.run": {
        const service = updates(), schedule = service.schedule();
        if (!schedule) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_REQUIRED", "请先保存定时更新计划", 400);
        if (conversationInput.sharedWorkspaceId && !input.reservedThreadId) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "定时更新缺少 Server 预留的共享会话", 403);
        data = await database(() => service.start({ requestId: actor.requestId, ...(input.scheduledAt === undefined ? {} : { scheduledAt: Number(input.scheduledAt) }), generation: generation(), createOwner: () => {
          ctx.scheduledTaskScheduler?.assertProjectTasksAccepting();
          return createKnowledgeConversation({ ...conversationInput, nodeId: null, engine: schedule.engine, model: schedule.model, effort: schedule.effort, title: `定时更新 · ${new Date().toLocaleString("zh-CN")}`, reservedThreadId: input.reservedThreadId == null ? undefined : text("reservedThreadId", 200) }).threadId;
        } }));
        break;
      }
      case "snapshot": data = store.snapshot(canWrite, input.includeStates !== false); break;
      case "node": data = readStore().detail(text("nodeId")); break;
      case "revision": data = readStore().readRevision(text("nodeId"), text("revisionId")); break;
      case "reviews": data = new KnowledgeReviewStore(readStore()).list(text("nodeId")); break;
      case "changes": data = new KnowledgeChangeStore(store).list(Number(input.offset ?? 0), { nodeId: input.nodeId == null ? undefined : text("nodeId"), status: input.status == null ? undefined : text("status") }); break;
      case "change": data = new KnowledgeChangeStore(store).detail(text("changeId")); break;
      case "change.review": {
        if (input.decision !== "approve" && input.decision !== "reject") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "审核操作无效", 400);
        data = new KnowledgeChangeStore(store).review({ id: text("changeId"), expectedHash: text("expectedHash"), decision: input.decision, note: knowledgeText(input.note ?? "", 4000), userId: actor.userId });
        break;
      }
      case "search": data = store.search(text("query", 500), input.nodeId == null ? null : text("nodeId"), input.includeDrafts === true); break;
      case "tree.save": store.saveTree(input.tree, nullable("expectedHash")); data = store.snapshot(canWrite); break;
      case "document.save": data = store.saveDocument({ nodeId: text("nodeId"), content: text("content", 2_000_000), sources: input.sources, expectedHash: nullable("expectedHash"), origin: "manual", summary: input.summary == null ? "人工编辑" : text("summary", 4000), adopt: true }); break;
      case "revision.adopt": store.adopt(text("nodeId"), text("revisionId"), nullable("expectedHash")); data = store.detail(text("nodeId")); break;
      case "revision.adopt.batch": {
        if (!Array.isArray(input.nodeIds) || input.nodeIds.length < 1 || input.nodeIds.length > 500 || input.nodeIds.some(id => typeof id !== "string")) {
          throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "批量采用资产范围无效", 400);
        }
        store.adoptMany(input.nodeIds.map(id => knowledgeText(id, 200, true)));
        data = store.snapshot(canWrite);
        break;
      }
      case "imports": data = store.importFiles(knowledgeText(input.directory ?? "", 1000), Number(input.offset ?? 0)); break;
      case "import": store.importFile({ path: text("path", 1000), contentHash: text("contentHash"), parentId: nullable("parentId"), treeHash: nullable("treeHash"), category: input.category as Parameters<typeof store.importFile>[0]["category"], appliesTo: input.appliesTo as string[] | undefined }); data = store.snapshot(canWrite); break;
      case "source": {
        const requestedCount = Number(input.count ?? 200);
        const count = Number.isFinite(requestedCount) ? Math.min(500, Math.max(1, Math.trunc(requestedCount))) : 200;
        const result = executeKnowledgeAssetReadTool(store, "knowledge.source.read", { path: text("path", 1000), startLine: Number(input.startLine ?? 1), count });
        if (!result.ok) throw new KnowledgeAssetError(result.code ?? "KNOWLEDGE_ASSET_IO_FAILED", result.message, 400);
        data = result.output;
        break;
      }
      // 结果页首屏只需要任务计划中的状态；单个任务详情仍走 run/view 的完整复检核验。
      // 避免批任务较多时同步读取所有 review 文件阻塞 Client 事件循环。
      case "runs": data = await database(() => generation().list({ hydrateReviews: false })); break;
      case "run": data = await database(() => generation().view(text("runId"))); break;
      case "run.preview": data = await database(() => generation().preview(text("runId"))); break;
      case "revision.dismiss": data = await generation().dismiss(text("runId"), text("nodeId"), input.revisionId === null ? null : text("revisionId"), actor.userId, input.planHash === undefined ? undefined : text("planHash")); break;
      case "run.cancelAdoption": data = await database(() => generation().cancelAdoption(text("runId"), text("requestId", 200), actor.userId)); break;
      case "generate": data = await database(() => generation().begin({ requestId: text("requestId"), mode: input.mode as KnowledgeGenerateInput["mode"], ownerThreadId: text("ownerThreadId", 200), selectedNodeIds: input.selectedNodeIds as string[], includeDescendants: input.includeDescendants as boolean, strategy: input.strategy as KnowledgeGenerateInput["strategy"], prompt: knowledgeText(input.prompt, 16000), treeHash: nullable("treeHash"), engine: input.engine as KnowledgeGenerateInput["engine"], model: input.model == null ? null : text("model", 200), effort: input.effort == null ? null : text("effort"), ...(input.concurrency === undefined ? {} : { concurrency: Number(input.concurrency) }), reviewConfig: input.reviewConfig as KnowledgeGenerateInput["reviewConfig"], repairReports: input.repairReports as KnowledgeGenerateInput["repairReports"] })); break;
      case "conversation.list": data = await database(() => listKnowledgeConversations(conversationInput)); break;
      case "conversation.create": data = await database(() => createKnowledgeConversation({ ...conversationInput, reservedThreadId: input.reservedThreadId == null ? undefined : text("reservedThreadId", 200), nodeId: nullable("nodeId"), engine: input.engine as KnowledgeGenerateInput["engine"], title: input.title == null ? null : text("title", 200), model: input.model == null ? null : text("model", 200), effort: input.effort == null ? null : text("effort") })); break;
      case "conversation.connect": data = await database(() => connectKnowledgeConversation({ ...conversationInput, threadId: text("threadId", 200) })); break;
      case "conversation.end": {
        const threadId = text("threadId", 200) as ThreadId;
        await database(() => requireKnowledgeConversationOwner({ ...conversationInput, threadId }));
        const service = generation();
        await database(() => {
          for (const run of service.list({ hydrateReviews: false })) if (run.ownerThreadId === threadId && ["batch", "review", "build"].includes(run.mode) && run.active) service.stop(run.id);
          data = endKnowledgeConversation({ ...conversationInput, threadId });
        });
        const turnId = ctx.sessions.getActiveTurnId(threadId);
        if (turnId && !await ctx.sessions.interrupt(threadId, turnId)) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPT_FAILED", "协作权限已结束，但引擎停止未确认，请在会话中查看运行状态");
        break;
      }
      case "run.apply": {
        data = await database(() => generation().apply(text("runId"), input.requestId === undefined ? undefined : { requestId: text("requestId", 200), treeHash: nullable("treeHash"), planHash: text("planHash"), selections: input.selections as KnowledgeGenerationApplyInput["selections"] }));
        break;
      }
      // run.start 只确认任务已入队；复检恢复和生成在 Client 后台执行，不能占住 Host RPC 的 api.res。
      case "run.start": data = await database(() => generation().startAsync(text("runId"), { retryFailed: input.retryFailed === true, nodeIds: input.nodeIds as string[] | undefined, prompt: input.prompt === undefined ? undefined : knowledgeText(input.prompt, 16000), model: input.model === undefined || input.model === null ? input.model : text("model", 200), effort: input.effort === undefined || input.effort === null ? input.effort : text("effort"), ...(input.concurrency === undefined ? {} : { concurrency: Number(input.concurrency) }), reviewConfig: input.reviewConfig as KnowledgeGenerationStartInput["reviewConfig"] })); break;
      case "run.stop": data = await database(() => generation().stop(text("runId"))); break;
    }
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, data } });
  } catch (error) {
    if (isKnowledgeGenerationLogFailure(error)) {
      ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, ...knowledgeFailure(new KnowledgeAssetError("KNOWLEDGE_ASSET_IO_FAILED", "知识任务日志未写入")), details: { requestId: req.id, operation: action, rootCause: "知识任务日志未写入" } } });
      return;
    }
    const assetError = error;
    const failure = knowledgeFailure(assetError);
    const rootCause = error instanceof Error ? error.message : String(error);
    const details = {
      requestId: req.id,
      operation: action,
      rootCause: rootCause.slice(0, 2000),
    };
    logger.error("knowledge-assets", "project knowledge API failed", { code: failure.code, requestId: req.id, workspaceId: (req.body as Record<string, unknown> | null)?.workspaceId, nodeId: (req.body as Record<string, unknown> | null)?.nodeId, runId: (req.body as Record<string, unknown> | null)?.runId, changeId: (req.body as Record<string, unknown> | null)?.changeId, decision: (req.body as Record<string, unknown> | null)?.decision, method: req.method, rootCause: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    ctx.send({ t: "api.res", id: req.id, status: assetError instanceof KnowledgeAssetError ? assetError.status : 500, body: { ok: false, ...failure, details } });
  }
}
