import crypto from "node:crypto";
import { types } from "node:util";
import type { ConversationEventInput, EngineType, ExecutableToolRegistry, RawEngineEventInput, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { assertReasoningEffortSupportedForModel, extractTurnErrorMetadata } from "@codeflowai/shared";
import { createTurnErrorEventInputFromError } from "../errors/turnErrors.js";
import type { ClientDb } from "../db/clientDb.js";
import type { ThreadSessionManager } from "../engines/threadSessionManager.js";
import type { HostToolExecutor, ThreadEngineSession, TurnTimeoutPolicy } from "../engines/threadSession.js";
import { emitTurnTerminalWithAssistantReconcile } from "../engines/turnTerminalEmitter.js";
import type { ThreadStore } from "../threads/threadStore.js";
import type { WorkspaceLogEntry } from "../logger.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";
import { assertRuntimeEngineModelAvailable, getRuntimeEngineModels, resolveRuntimeThreadPrefsWithCatalogDefaults } from "../engines/engineModelCatalogRuntime.js";
import { isKnowledgeRateLimitError, KnowledgeAssetError } from "./knowledgeAssetFiles.js";

export type KnowledgeGenerationEngineInput = {
  workspaceId: WorkspaceId; runId: string; ownerThreadId: string; title: string; engine: EngineType; model: string | null; effort: string | null;
  prompt: string; instructions: string; registry: ExecutableToolRegistry; execute: HostToolExecutor;
  signal: AbortSignal; onThreadCreated: (threadId: string) => void; purpose?: "generation" | "review" | "planning";
  /** service 同步保留诊断失败；独立 executor 仍由原 Promise 返回最终失败。 */
  onDiagnosticFailure?: (error: unknown) => void;
  /** 修订时复用同一资产工作会话；不传则创建新的独立执行线程。 */
  threadId?: string | null;
  /** 复检使用独立上下文，生命周期与事件归入这个文件工作会话。 */
  reviewParent?: {
    threadId: string | null; model: string | null; effort: string | null;
    /** 首次单独复检按确切版本溯源，仅复用同权限范围与引擎的本地文件会话。 */
    sourceThreadId?: string | null;
    onThreadCreated: (threadId: string) => void;
    completionSummary: () => string;
  };
};
export type KnowledgeGenerationExecutor = ((input: KnowledgeGenerationEngineInput) => Promise<void>) & {
  resolveConfig?: typeof resolveKnowledgeExecutionConfig;
};
export type KnowledgeGenerationEngineDeps = {
  db: ClientDb; threads: ThreadStore; sessions: ThreadSessionManager; timeoutPolicy: TurnTimeoutPolicy;
  emitConversation: (event: ConversationEventInput) => void; emitRaw: (event: RawEngineEventInput) => void;
  /** 读取桌面更新的唯一准入事实；询问结束后原任务可继续。 */
  isTaskAdmissionPaused?: () => boolean;
  /** 同步仓储和诊断短段复用Writer准入，provider等待不得持许可。 */
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
  /** 生成启动及终态等待正文和索引完成。 */
  flushLocalEvents?: (workspaceId: WorkspaceId, threadId?: ThreadId) => Promise<void>;
};

const diagnosticFailure = Symbol("knowledge-generation-log-failure");
/** 只读取自有 data 字段；反射失败交由调用边界保留新原因。 */
export function knowledgeGenerationOwn(value: unknown, key: PropertyKey): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
/** 仅识别本模块自产错误，外部同名 code 不获得诊断中止资格。 */
export function isKnowledgeGenerationLogFailure(value: unknown): boolean {
  return types.isNativeError(value) && knowledgeGenerationOwn(value, diagnosticFailure) === true;
}
/** 后发生的失败按层级追加，cause 始终保留原始拒绝值。 */
export function combineKnowledgeGenerationFailure(primary: unknown, secondary: unknown): AggregateError {
  const combined = new AggregateError([primary, secondary], "知识任务执行或诊断失败", { cause: primary });
  const diagnostic = isKnowledgeGenerationLogFailure(primary) || isKnowledgeGenerationLogFailure(secondary);
  Object.assign(combined, { code: diagnostic ? "KNOWLEDGE_GENERATION_LOG_FAILED" : "KNOWLEDGE_ASSET_INTERRUPT_FAILED" });
  if (diagnostic) Object.defineProperty(combined, diagnosticFailure, { value: true });
  return combined;
}
/** 有界描述只读自有字段，不执行未知 getter、迭代器或字符串转换。 */
export function describeKnowledgeGenerationFailure(root: unknown): Record<string, unknown> {
  let remaining = 20;
  const visited = new Set<unknown>();
  const describe = (value: unknown, depth: number): Record<string, unknown> => {
    remaining--;
    const scalar = typeof value === "string" ? value : value === null ? "null" : ["undefined", "boolean", "number", "bigint"].includes(typeof value) ? String(value) : typeof value === "symbol" ? "symbol" : null;
    if (scalar !== null) return { name: typeof value, message: redactClientStartupText(scalar).slice(0, 1000) };
    if (visited.has(value)) return { name: "circular" };
    visited.add(value);
    const message = knowledgeGenerationOwn(value, "message"), name = knowledgeGenerationOwn(value, "name");
    const result: Record<string, unknown> = { name: typeof name === "string" && /^(?:Error|AggregateError|KnowledgeAssetError|TypeError|RangeError)$/.test(name) ? name : typeof value,
      message: typeof message === "string" ? redactClientStartupText(message).slice(0, 1000) : "非文本异常" };
    if (depth < 3 && remaining > 0) {
      const cause = Object.getOwnPropertyDescriptor(value, "cause");
      if (cause && "value" in cause) result.cause = describe(cause.value, depth + 1);
      const errors = knowledgeGenerationOwn(value, "errors");
      if (Array.isArray(errors)) {
        const length = knowledgeGenerationOwn(errors, "length");
        const children: Record<string, unknown>[] = [];
        if (typeof length === "number") for (let index = 0; index < Math.min(10, length) && remaining > 0; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(errors, String(index));
          if (descriptor && "value" in descriptor) children.push(describe(descriptor.value, depth + 1));
        }
        result.errors = children;
      }
    }
    return result;
  };
  return describe(root, 0);
}
/** 构造、脱敏及固定同步写在同一保因边界，info 不制造不存在的业务主因。 */
export function writeKnowledgeGenerationLog(db: Pick<ClientDb, "writeWorkspaceLog">, workspaceId: WorkspaceId, entry: () => WorkspaceLogEntry, business?: { reason: unknown }): void {
  try { db.writeWorkspaceLog(workspaceId, entry()); }
  catch (error) { throw knowledgeGenerationDiagnosticFailure(error, business); }
}
/** 描述或写入失败统一保原对象，presence 盒区分实际 undefined 与未发生业务错误。 */
export function knowledgeGenerationDiagnosticFailure(error: unknown, business?: { reason: unknown }): AggregateError {
  const failure = new AggregateError(business ? [business.reason, error] : [error], "知识任务日志未写入", { cause: business ? business.reason : error });
  Object.assign(failure, { code: "KNOWLEDGE_GENERATION_LOG_FAILED" });
  Object.defineProperty(failure, diagnosticFailure, { value: true });
  return failure;
}

/** 绑定诊断只认自有 data code，反射失败保留原 mismatch 输入。 */
function isCodexDynamicToolBindingMismatch(error: unknown): boolean {
  try { return knowledgeGenerationOwn(error, "code") === "codex_thread_capability_incompatible"; }
  catch (reflectionError) { throw knowledgeGenerationDiagnosticFailure(reflectionError, { reason: error }); }
}
/** 原始标量沿原 429 口径；未知对象只读取自有 data 字段。 */
export function isKnowledgeGenerationRateLimitError(error: unknown): boolean {
  try {
    if (error === null || typeof error !== "object" && typeof error !== "function") return isKnowledgeRateLimitError(error);
    const record: Record<string, string | number> = {};
    for (const key of ["status", "statusCode", "httpStatus", "upstreamStatus", "code", "errorCode", "message", "error"]) {
      const value = knowledgeGenerationOwn(error, key);
      if (typeof value === "string" || typeof value === "number") record[key] = value;
    }
    return isKnowledgeRateLimitError(record);
  } catch (reflectionError) { throw knowledgeGenerationDiagnosticFailure(reflectionError, { reason: error }); }
}

/** 复用运行时目录解析具体模型，任务准入与执行器使用同一校验口径。 */
export function resolveKnowledgeExecutionConfig(engine: EngineType, prefs: { model: string | null; effort: string | null }): { model: string; effort: string | null } {
  assertRuntimeEngineModelAvailable(engine, prefs.model);
  assertReasoningEffortSupportedForModel(engine, prefs.model, prefs.effort, getRuntimeEngineModels(engine));
  const resolved = resolveRuntimeThreadPrefsWithCatalogDefaults(engine, prefs);
  if (!resolved.model) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_REQUIRED", "当前引擎目录缺少默认模型，请先配置可用模型");
  return { model: resolved.model, effort: resolved.effort };
}

/** 按规划、生成或复检职责发送独立上下文，统一解析模型并保留执行事件。 */
export function createKnowledgeGenerationExecutor(deps: KnowledgeGenerationEngineDeps): KnowledgeGenerationExecutor {
  /** 只把同步工作交给Writer协调，网络和引擎生命周期继续由本执行owner持有。 */
  const database = <T>(requestId: string, operation: () => T): Promise<T> => deps.withLegacyDatabase ? deps.withLegacyDatabase(requestId, operation) : Promise.resolve(operation());
  /** 等待下一次准入检查；原任务取消会立即释放定时器与监听。 */
  const waitForAdmissionRetry = (signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止"));
    };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 20);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  /** 子线程保留完整 canonical/raw，向父会话转发可展开的执行内容。 */
  const executeThread = async (input: KnowledgeGenerationEngineInput, parent?: { threadId: ThreadId; itemId: string; taskId: string }): Promise<void> => {
    while (deps.isTaskAdmissionPaused?.()) await waitForAdmissionRetry(input.signal);
    if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
    // ownerThreadId 仅表达任务归属，绝不借用知识讨论会话或研发会话的上下文。
    const { runtime, threadId, turnId, userItemId, model, effort } = await database(input.runId, () => {
    if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
    const owner = deps.db.threads.get(input.ownerThreadId as ThreadId);
    if (!owner || owner.workspaceId !== input.workspaceId || owner.threadSubtype !== "knowledge-conversation" || owner.archived) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "所属知识会话已失效", 403);
    const requestedThreadId = input.threadId ? String(input.threadId).trim() : "";
    const existing = requestedThreadId ? deps.db.threads.get(requestedThreadId as ThreadId) : null;
    if (requestedThreadId && (!existing || existing.workspaceId !== input.workspaceId || existing.engine !== input.engine || existing.threadSubtype !== "knowledge-assets" || existing.archived)) {
      throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "要复用的知识工作会话不存在、已归档或配置不一致");
    }
    // 默认项首次从目录解析；修订沿用该线程已冻结的实际配置，显式变更仍严格校验。
    const requestedModel = input.model ?? existing?.model ?? null;
    const requestedEffort = input.effort ?? (input.model && input.model !== existing?.model ? null : existing?.effort) ?? null;
    const { model, effort } = resolveKnowledgeExecutionConfig(input.engine, { model: requestedModel, effort: requestedEffort });
    const threadId = (requestedThreadId || `knowledge-${crypto.randomUUID()}`) as ThreadId;
    const turnId = `turn_${crypto.randomUUID()}` as TurnId;
    const userItemId = `item_user_${crypto.randomUUID()}`;
    const title = `[${input.purpose === "review" ? "知识复检" : input.purpose === "planning" ? "知识规划" : "知识生成"}] ${input.title}`;
    if (!existing) {
      deps.db.threads.create({ id: threadId, workspaceId: input.workspaceId, engine: input.engine, title, threadType: "orchestration", threadSubtype: parent ? "knowledge-review" : "knowledge-assets",
        // 执行线程必须保存本批次冻结的模型配置；否则打开会话时会错误回退到引擎默认模型。
        prefs: { model, effort, accessMode: "read-only", planMode: false },
        sharedAcl: owner.sharedWorkspaceId ? { ownerUserId: owner.ownerUserId!, sharedWorkspaceId: owner.sharedWorkspaceId, visibility: owner.sharedVisibility!, participantUserIds: owner.sharedParticipantUserIds, updatedAt: owner.sharedAclUpdatedAt ?? Date.now() } : null });
    } else if (existing.model !== model || existing.effort !== effort) {
      deps.db.threads.updatePrefs(threadId, { model, effort });
    }
    const persisted = existing ?? deps.db.threads.get(threadId);
    const runtime = deps.threads.get(threadId) ?? deps.threads.create({ threadId, workspaceId: input.workspaceId, engine: input.engine, title: persisted?.title ?? title,
      sessionId: persisted?.sessionId ?? null, sessionCapabilities: persisted?.sessionCapabilities ?? null });
    return { runtime, threadId, turnId, userItemId, model, effort };
    });
    let session: ThreadEngineSession | null = null, terminal = false, dispatched = false, interactionError: KnowledgeAssetError | null = null;
    let interruptError: KnowledgeAssetError | null = null;
    const executionFailures: unknown[] = [];
    const interrupts: Promise<unknown>[] = [];
    /** 停止请求等待引擎结果；中断失败不能被正常取消提示覆盖。 */
    const stop = () => {
      if (session && dispatched) interrupts.push(session.interrupt(turnId).then(matched => {
        if (matched === false && (session!.hasActiveTurn?.() === true || !(terminal || session!.getObservedTurnTerminalStatus?.(turnId)))) {
          throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPT_FAILED", "知识任务中断未命中，且尚未确认回合终态");
        }
      }).catch(error => {
        interruptError ??= Object.assign(new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPT_FAILED", error instanceof Error ? error.message : "引擎中断失败"), { cause: error });
      }));
    };
    /** 只投影内容事件；子任务的 turn 状态不能覆盖父工作会话。 */
    const emit = (event: ConversationEventInput): void => {
      deps.emitConversation(event);
      if (parent && event.type.startsWith("item.")) deps.emitConversation({
        ts: event.ts ?? Date.now(), workspaceId: input.workspaceId, threadId: parent.threadId, engine: input.engine,
        type: "item.subagent.childEvent", payload: { itemId: parent.itemId, taskId: parent.taskId, innerEventType: event.type, innerPayload: event.payload },
      });
    };
    input.signal.addEventListener("abort", stop, { once: true });
    try {
      input.onThreadCreated(threadId);
      while (deps.isTaskAdmissionPaused?.()) await waitForAdmissionRetry(input.signal);
      if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
      session = await database(input.runId, () => deps.sessions.getOrCreate(runtime));
      const toolSession = session;
      const toolTransport = await database(input.runId, () => toolSession.resolvePlatformToolTransport(input.registry, "required"));
      if (toolTransport !== "native-dynamic") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_ENGINE_UNSUPPORTED", "当前引擎不支持项目知识所需的真实平台工具，请切换可用引擎");
      emit({ ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "turn.started", payload: { turnId } });
      emit({ ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "item.userMessage.created", payload: { turnId, itemId: userItemId, text: input.prompt } });
      await deps.flushLocalEvents?.(input.workspaceId, threadId);
      const sendInput = {
        turnId, userItemId, assistantItemId: `item_assistant_${crypto.randomUUID()}`, reasoningItemId: `item_reasoning_${crypto.randomUUID()}`,
        text: input.prompt, userMessage: input.prompt,
        systemMessage: input.purpose === "review"
          ? "你是独立的项目知识复检工程师。重新读取绑定文档和生成要求，按主张核对真实来源；规格约束核对已确认要求及适用边界，现状说明核对真实源码和原始资料。通过复检工具提交有证据的报告。"
          : input.purpose === "planning"
            ? "你负责项目知识的轻量规划，只判断可引用资料与必要知识缺口。根据项目入口、资料目录和必要片段确定覆盖范围，缺口明确后立即通过 knowledge.plan.submit 提交候选计划及已读依据；已有资料足够时引用原文，允许没有新增内容。实现细节、完整调用链、历史方案冲突与测试核验留给生成和独立复检，不在规划阶段预先完成。不要提交正文或采用正式树。工作区文件只读。"
            : "你是项目知识资产工程师。根据真实项目证据完成当前绑定任务，生成的目录和内容必须遵循用户要求。工作区文件仍为只读，但 knowledge.asset.submit 是平台授权的唯一资产交付工具，不属于文件写入；文档完成后必须调用它提交当前绑定节点，不能只返回文字。本任务已授权直接交付，不另起实施计划审批；平台随后在本工作会话调度独立复检子任务，不重复发起额外评审。",
        // 复用受控执行权限；普通只读会话在 Claude 中会映射为计划模式并请求实施审批。
        developerMessage: `${input.instructions}\n本任务在后台执行，不能等待人工审批或补充输入。目录导航与证据读取使用knowledge.source.list/read；定位内容可用无需审批的原生Glob/Grep等只读检索工具，再用source.read读取证据行段与完整指纹。不要调用Bash、Shell或命令执行工具拼接管道、循环、变量展开或运行脚本来检索、统计、验证路径；这些操作可能触发审批并使任务失败。不要调用提问或计划审批工具。`, workMode: "general" as const, conversationProfile: "orchestration" as const, planMode: false, images: [] as string[], accessMode: "read-only" as const,
        model, effort, toolRegistry: input.registry, toolRegistryJson: JSON.stringify(input.registry),
        executeHostTool: input.execute, platformToolTransportRequirement: "required" as const, responseFormat: "text" as const, providerNativeToolPolicy: "allow" as const, timeoutPolicy: deps.timeoutPolicy,
      };
      const emitters = {
        flush: () => deps.flushLocalEvents?.(input.workspaceId, threadId) ?? Promise.resolve(),
        conversation: (event: ConversationEventInput) => {
          if ((event.type === "turn.completed" || event.type === "turn.error") && event.payload.turnId === turnId) {
            if (terminal) return;
            terminal = true;
            if (event.type === "turn.error") {
              interactionError ??= isKnowledgeRateLimitError(event.payload)
                ? new KnowledgeAssetError("KNOWLEDGE_ASSET_RATE_LIMITED", "模型服务暂时限流，任务会在退避后自动重试")
                : new KnowledgeAssetError("KNOWLEDGE_ASSET_ENGINE_FAILED", "知识生成引擎执行失败，请检查任务会话记录");
            }
          }
          emit(event);
          if (event.type === "approval.request" || event.type === "userInput.requested") {
            const payload = event.payload as Record<string, unknown>;
            // 后台不能等待交互；保留工具与审批根因，不能将其误报为知识要求缺失。
            const reason = String(payload.message ?? payload.prompt ?? "引擎需要补充信息").slice(0, 1000);
            interactionError = new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_REQUIRED", event.type === "approval.request"
              ? `后台知识任务无法等待工具 ${String(payload.toolName ?? "未知工具")} 的交互审批，请使用无需审批的只读工具后重试。审批原因：${reason}`
              : `后台知识任务需要补充输入，请在知识要求中补充后重试。原因：${reason}`);
            stop();
          }
        },
        raw: (event: RawEngineEventInput) => deps.emitRaw(event),
      };
      let bindingReset = false;
      while (true) {
        while (deps.isTaskAdmissionPaused?.()) await waitForAdmissionRetry(input.signal);
        if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
        try {
          dispatched = true;
          await session.sendMessage(sendInput, emitters);
          break;
        } catch (error) {
          if (bindingReset || input.engine !== "codex" || !isCodexDynamicToolBindingMismatch(error)) throw error;
          dispatched = false;
          while (deps.isTaskAdmissionPaused?.()) await waitForAdmissionRetry(input.signal);
          if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
          const staleProviderThreadId = session.getSessionId();
          let rotated = false;
          try {
            rotated = session.resetDynamicToolBinding?.() === true;
          } catch (rotationError) {
            const combined = combineKnowledgeGenerationFailure(error, rotationError);
            await database(input.runId, () => writeKnowledgeGenerationLog(deps.db, input.workspaceId, () => ({ level: "error", tag: "knowledge-assets", message: "stale Codex dynamic tool binding rotation failed", data: {
              code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_FAILED",
              requestId: input.runId,
              workspaceId: input.workspaceId,
              threadId,
              runId: input.runId,
              purpose: input.purpose ?? "generation",
              ownerThreadId: input.ownerThreadId, turnId, errorCode: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_FAILED", event: { category: "knowledge", action: "binding_rotation", outcome: "failure" },
              providerThreadId: staleProviderThreadId,
              activeTurnId: session!.getActiveTurnId?.() ?? null,
              rootCause: describeKnowledgeGenerationFailure(combined),
            } }), { reason: combined }));
            throw combined;
          }
          if (!rotated) {
            await database(input.runId, () => writeKnowledgeGenerationLog(deps.db, input.workspaceId, () => ({ level: "error", tag: "knowledge-assets", message: "stale Codex dynamic tool binding cannot be rotated safely", data: {
              code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_REJECTED",
              requestId: input.runId,
              workspaceId: input.workspaceId,
              threadId,
              runId: input.runId,
              purpose: input.purpose ?? "generation",
              ownerThreadId: input.ownerThreadId, turnId, errorCode: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATION_REJECTED", event: { category: "knowledge", action: "binding_rotation", outcome: "failure" },
              providerThreadId: staleProviderThreadId,
              activeTurnId: session!.getActiveTurnId?.() ?? null,
              rootCause: describeKnowledgeGenerationFailure(error),
            } }), { reason: error }));
            throw error;
          }
          bindingReset = true;
          await database(input.runId, () => writeKnowledgeGenerationLog(deps.db, input.workspaceId, () => ({ level: "warn", tag: "knowledge-assets", message: "stale Codex dynamic tool binding rotated for knowledge execution", data: {
            code: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATED",
            requestId: input.runId,
            workspaceId: input.workspaceId,
            threadId,
            runId: input.runId,
            purpose: input.purpose ?? "generation",
            ownerThreadId: input.ownerThreadId, turnId, errorCode: "KNOWLEDGE_CODEX_TOOL_BINDING_ROTATED", event: { category: "knowledge", action: "binding_rotation", outcome: "success" },
            providerThreadId: staleProviderThreadId,
            rootCause: describeKnowledgeGenerationFailure(error),
          } }), { reason: error }));
        }
      }
      await Promise.all(interrupts);
      if (interruptError) throw interruptError;
      if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
      if (interactionError) throw interactionError;
      if (!terminal) {
        await emitTurnTerminalWithAssistantReconcile({ session, turnId, outcome: "completed", emitConversation: emit, buildTerminalEvent: () => {
          if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
          return { ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "turn.completed", payload: { turnId } };
        } });
        terminal = true;
      }
    } catch (error) {
      const capturedError = interactionError as KnowledgeAssetError | null;
      let captured: unknown = error;
      const diagnostic = isKnowledgeGenerationLogFailure(error);
      if (diagnostic) {
        try { input.onDiagnosticFailure?.(error); }
        catch (callbackError) { captured = combineKnowledgeGenerationFailure(error, callbackError); }
      }
      await Promise.all(interrupts);
      let normalized: unknown = captured;
      try {
        const cancelled = !diagnostic && (error instanceof KnowledgeAssetError && error.code === "KNOWLEDGE_ASSET_INTERRUPTED"
          || input.signal.aborted && extractTurnErrorMetadata(error).terminationKind === "manual_interrupt");
        const cause = !diagnostic && !cancelled && capturedError && capturedError.code !== "KNOWLEDGE_ASSET_ENGINE_FAILED" ? capturedError : captured;
        normalized = cancelled ? Object.assign(new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止"), { cause: captured }) : !diagnostic && isKnowledgeGenerationRateLimitError(cause)
          ? new KnowledgeAssetError("KNOWLEDGE_ASSET_RATE_LIMITED", "模型服务暂时限流，任务会在退避后自动重试") : cause;
      } catch (normalizationError) {
        normalized = isKnowledgeGenerationLogFailure(normalizationError) ? normalizationError : knowledgeGenerationDiagnosticFailure(normalizationError, { reason: captured });
        try { input.onDiagnosticFailure?.(normalized); }
        catch (callbackError) { normalized = combineKnowledgeGenerationFailure(normalized, callbackError); }
      }
      executionFailures.push(normalized);
      try {
        if (!terminal) await emitTurnTerminalWithAssistantReconcile({ session, turnId, outcome: "error", emitConversation: emit, buildTerminalEvent: () => createTurnErrorEventInputFromError({ workspaceId: input.workspaceId, threadId, engine: input.engine, turnId, error: interruptError ?? normalized }) });
      } catch (terminalError) {
        executionFailures.splice(0, executionFailures.length, combineKnowledgeGenerationFailure(normalized, terminalError));
      }
    } finally {
      input.signal.removeEventListener("abort", stop);
      await Promise.all(interrupts);
      const cleanupFailures: unknown[] = [];
      try { await deps.flushLocalEvents?.(input.workspaceId, threadId); }
      catch (error) { cleanupFailures.push(error); }
      try { await deps.sessions.disposeThread(threadId); }
      catch (error) { cleanupFailures.push(error); }
      try { await deps.flushLocalEvents?.(input.workspaceId, threadId); }
      catch (error) { cleanupFailures.push(error); }
      const failures = [...executionFailures, ...(interruptError && !executionFailures.includes(interruptError) ? [interruptError] : []), ...cleanupFailures]
        .filter(error => !(interruptError && error instanceof KnowledgeAssetError && error.code === "KNOWLEDGE_ASSET_INTERRUPTED"));
      if (failures.length > 1) throw failures.slice(1).reduce(combineKnowledgeGenerationFailure, failures[0]);
      if (cleanupFailures.length) throw Object.assign(new AggregateError(failures, "知识任务执行或清理失败", { cause: failures[0] }), { code: "KNOWLEDGE_ASSET_INTERRUPT_FAILED" });
      if (failures.length) throw failures[0];
    }
  };
  /** 复检优先接回版本来源的本地文件会话；无符合范围的会话时建立宿主。 */
  const execute: KnowledgeGenerationExecutor = async input => {
    const parent = input.reviewParent;
    if (!parent) return executeThread(input);
    if (input.purpose !== "review") throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "只有复检可以作为文件工作会话的子任务");
    while (deps.isTaskAdmissionPaused?.()) await waitForAdmissionRetry(input.signal);
    if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
    const threadId = await database(input.runId, () => {
    if (input.signal.aborted) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INTERRUPTED", "知识任务已停止");
    const owner = deps.db.threads.get(input.ownerThreadId as ThreadId);
    if (!owner || owner.workspaceId !== input.workspaceId || owner.threadSubtype !== "knowledge-conversation" || owner.archived) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "所属知识会话已失效", 403);
    const requestedThreadId = parent.threadId ?? parent.sourceThreadId;
    const candidate = requestedThreadId ? deps.db.threads.get(requestedThreadId as ThreadId) : null;
    const existing = candidate && candidate.workspaceId === input.workspaceId && candidate.engine === input.engine && candidate.threadSubtype === "knowledge-assets" && !candidate.archived
      && candidate.ownerUserId === owner.ownerUserId && candidate.sharedWorkspaceId === owner.sharedWorkspaceId ? candidate : null;
    if (parent.threadId && !existing) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "复检所属的文件工作会话已失效");
    const threadId = (existing?.id ?? `knowledge-${crypto.randomUUID()}`) as ThreadId;
    if (!existing) {
      const prefs = resolveKnowledgeExecutionConfig(input.engine, parent);
      deps.db.threads.create({ id: threadId, workspaceId: input.workspaceId, engine: input.engine, title: `[知识工作] ${input.title}`, threadType: "orchestration", threadSubtype: "knowledge-assets",
        prefs: { ...prefs, accessMode: "read-only", planMode: false },
        sharedAcl: owner.sharedWorkspaceId ? { ownerUserId: owner.ownerUserId!, sharedWorkspaceId: owner.sharedWorkspaceId, visibility: owner.sharedVisibility!, participantUserIds: owner.sharedParticipantUserIds, updatedAt: owner.sharedAclUpdatedAt ?? Date.now() } : null });
    }
    return threadId;
    });
    parent.onThreadCreated(threadId);
    const task = { threadId, itemId: `item_review_${crypto.randomUUID()}`, taskId: `review_${crypto.randomUUID()}` };
    deps.emitConversation({ ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "item.subagent.started",
      payload: { itemId: task.itemId, taskId: task.taskId, description: `复检 · ${input.title}`, taskType: "knowledge_review" } });
    try {
      await executeThread(input, task);
      const summary = parent.completionSummary();
      deps.emitConversation({ ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "item.subagent.completed",
        payload: { itemId: task.itemId, taskId: task.taskId, status: "completed", summary } });
      await deps.flushLocalEvents?.(input.workspaceId, threadId);
    } catch (error) {
      try {
        deps.emitConversation({ ts: Date.now(), workspaceId: input.workspaceId, threadId, engine: input.engine, type: "item.subagent.completed",
          payload: { itemId: task.itemId, taskId: task.taskId, status: input.signal.aborted ? "stopped" : "failed", summary: String(describeKnowledgeGenerationFailure(error).message) } });
        await deps.flushLocalEvents?.(input.workspaceId, threadId);
      } catch (projectionError) { throw combineKnowledgeGenerationFailure(error, projectionError); }
      throw error;
    }
  };
  execute.resolveConfig = resolveKnowledgeExecutionConfig;
  return execute;
}
