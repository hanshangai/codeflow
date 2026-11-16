import type { ConversationEventInput, ConversationUserInputRequest, RequestUserInputResponse, ThreadId } from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { onThreadQueueAppend } from "../handleThreadQueueRequest.js";

/** 按持久化问题验证回答，稳定排序供重试比对；普通字符串也允许作为自定义答案。 */
function normalizeAnswers(item: ConversationUserInputRequest, value: unknown): RequestUserInputResponse["answers"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回答必须是问题 ID 到答案的映射");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== item.questions.length || Object.keys(input).some(id => !item.questions.some(question => question.id === id))) {
    throw new Error("回答的问题与原提问不匹配");
  }
  return Object.fromEntries(item.questions.map(question => {
    const entry = input[question.id] as { answers?: unknown } | null;
    if (!entry || !Array.isArray(entry.answers) || !entry.answers.length
      || entry.answers.some(answer => typeof answer !== "string" || !answer.trim())) throw new Error("请填写每个问题的回答");
    return [question.id, { answers: entry.answers.map(answer => String(answer).trim()) }];
  }));
}

/** 异步提问没有待回复的 provider RPC；沿原队列回传上下文，重启后仍按已保存事实去重。 */
export async function respondAsyncUserInput(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<boolean> {
  const body = req.body as Record<string, unknown>, threadId = String(body.threadId) as ThreadId;
  /** 每次异步索引批次重新取得许可；派发队列前释放同步快照许可。 */
  const access = <T>(operation: () => T): Promise<T> => ctx.withDatabase ? ctx.withDatabase(req.id, operation) : Promise.resolve(operation());
  await ctx.flushLocalEvents?.(ctx.db.workspaceId!, threadId);
  await ctx.db.ensureThreadPresentation(ctx.db.workspaceId!, threadId, { withDatabase: access });
  const prepared = await access(() => {
  const item = ctx.db.conversationEvents.readPresentation(threadId).items.find(
    (candidate): candidate is ConversationUserInputRequest => candidate.kind === "userInputRequest"
      && candidate.delivery === "async" && candidate.requestId === body.requestId);
  if (!item) return false;
  /** 已知校验拒绝在本请求边界记录一次，不返回成功或投递后续消息。 */
  const reject = (status: number, message: string): boolean => {
    ctx.db.writeWorkspaceLog(item.workspaceId, { level: "warn", tag: "userInput", message: "异步回答被拒绝",
      data: { errorCode: "ASYNC_USER_INPUT_REJECTED", requestId: req.id, workspaceId: item.workspaceId,
        threadId, providerRequestId: item.requestId, rootCause: message } });
    ctx.onApiFailureLogged?.();
    const sent = ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, code: status === 400 ? "BAD_REQUEST" : "CONFLICT", message } });
    if (sent?.accepted === false) throw sent;
    return true;
  };
  let answers: RequestUserInputResponse["answers"];
  try { answers = normalizeAnswers(item, body.answers); }
  catch (error) { return reject(400, error instanceof Error ? error.message : "回答格式非法"); }
  if (item.state === "expired") return reject(409, "该问题已经失效");
  if (item.state === "submitted" && JSON.stringify(normalizeAnswers(item, item.submittedAnswers)) !== JSON.stringify(answers)) {
    return reject(409, "该问题已经提交，不能覆盖原回答");
  }
  const clientItemId = `async-user-input:${String(item.requestId)}`;
  const text = ["补充输入回答：", ...item.questions.map(question => `${question.question}\n回答：${answers[question.id]!.answers.join("；")}`)].join("\n\n");
  const queued = ctx.db.threadMessageQueue.findLatestByClientItemId(threadId, clientItemId);
  if (queued && queued.text !== text) return reject(409, "该问题的另一份回答已经入队");
  if (queued?.status === "cancelled") return reject(409, "原回答已取消，不能通过重试重新发送");
  /** 桌面发送入口先本地落库；独立 Client 沿既有传输等待 canonical 回流。 */
  const emitResolved = (): void => {
    const event: ConversationEventInput = { ts: Date.now(), workspaceId: item.workspaceId, threadId, engine: "codex",
      type: "userInput.resolved", payload: { response: { requestId: item.requestId, answers } } };
    const sent = ctx.send({ t: "conversation.event", event });
    if (sent?.accepted === false) throw sent;
  };
  if (queued?.status === "sent" || item.state === "submitted" && !queued) {
    emitResolved();
    const sent = ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, idempotent: true } });
    if (sent?.accepted === false) throw sent;
    return true;
  }
  if (queued?.status === "failed" && !ctx.db.threadMessageQueue.findIdempotentItem(threadId, clientItemId)) {
    return reject(409, "原回答发送失败，请先处理会话中已有的失败队列项");
  }
  const thread = ctx.db.threads.get(threadId)!;
  return { thread, text, clientItemId, emitResolved };
  });
  if (typeof prepared === "boolean") return prepared;
  const { thread, text, clientItemId, emitResolved } = prepared;
  await onThreadQueueAppend(ctx, { ...req, method: "threads.queue.append", body: {
    ...body, text, clientItemId, images: [], files: [], sendOptions: { workMode: "general", planMode: thread.planMode ?? false,
      accessMode: thread.accessMode, model: thread.model, effort: thread.effort, serviceTier: thread.serviceTier,
      roleId: thread.roleId, contextWindow: thread.contextWindow, autoCompactPct: thread.autoCompactPct },
  } }, { beforeDispatch: emitResolved });
  return true;
}
