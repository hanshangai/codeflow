import type { RequestUserInputQuestion, RequestUserInputRequest, TurnId, WorkspaceId } from "@codeflowai/shared";

/** 只识别 provider 明确标记的异步问题；错误结构中止映射，不伪造普通消息。 */
export function buildAsyncUserInputRequest(opts: {
  item: Record<string, unknown> | null;
  workspaceId: WorkspaceId;
  threadId: string;
  turnId: TurnId | null;
}): RequestUserInputRequest | null {
  const item = opts.item;
  if (item?.type !== "agentMessage" || item.delivery !== "async") return null;
  if (typeof item.id !== "string" || !item.id.trim() || !Array.isArray(item.questions) || !item.questions.length) {
    throw new Error("Codex 异步问题缺少 itemId 或 questions");
  }
  const questions = item.questions.map((raw: unknown, index: number): RequestUserInputQuestion => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Codex 异步问题结构非法");
    const question = raw as Record<string, unknown>;
    if (typeof question.title !== "string" || !question.title.trim()) throw new Error("Codex 异步问题缺少标题");
    if (question.options != null && (!Array.isArray(question.options)
      || question.options.some(option => typeof option !== "string" || !option.trim()))) throw new Error("Codex 异步问题选项非法");
    return { id: `question_${index + 1}`, header: `问题 ${index + 1}`, question: question.title,
      ...(Array.isArray(question.options) && question.options.length
        ? { options: question.options.map(label => ({ label: String(label), description: "" })) } : {}) };
  });
  return { requestId: item.id, params: { workspaceId: opts.workspaceId, threadId: opts.threadId as any,
    turnId: opts.turnId ?? "" as TurnId, itemId: item.id as any, delivery: "async", questions } };
}

/** 从 approval request params 中提取可读提示（best-effort）。 */
export function extractApprovalMessage(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  const cmd = (params as any).command ?? (params as any).argv ?? null;
  if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
  if (Array.isArray(cmd)) return cmd.map((v) => String(v ?? "")).filter(Boolean).join(" ").trim() || undefined;
  return undefined;
}

/** 将 app-server 的 requestUserInput params 映射为 shared 的 `RequestUserInputRequest`。 */
export function buildUserInputRequest(opts: {
  requestId: unknown;
  workspaceId: WorkspaceId;
  threadId: any;
  activeTurnId: TurnId | null;
  params: Record<string, unknown> | undefined;
}): RequestUserInputRequest {
  const p = opts.params ?? {};
  const itemId = String((p as any).itemId ?? (p as any).item_id ?? `userInput_${Date.now()}`).trim();
  const questionsRaw = Array.isArray((p as any).questions) ? ((p as any).questions as unknown[]) : [];
  const questions: RequestUserInputQuestion[] = questionsRaw
    .map((q) => {
      const r = q as Record<string, unknown>;
      const optionsRaw = Array.isArray((r as any).options) ? ((r as any).options as unknown[]) : [];
      const options = optionsRaw
        .map((o) => {
          const rr = o as Record<string, unknown>;
          const label = String((rr as any).label ?? "").trim();
          const description = String((rr as any).description ?? "").trim();
          if (!label && !description) return null;
          return { label, description };
        })
        .filter((v): v is { label: string; description: string } => Boolean(v));
      return {
        id: String((r as any).id ?? "").trim(),
        header: String((r as any).header ?? ""),
        question: String((r as any).question ?? ""),
        isOther: Boolean((r as any).isOther ?? (r as any).is_other),
        options: options.length ? options : undefined,
      } satisfies RequestUserInputQuestion;
    })
    .filter((q) => q.id);

  const turnId = (opts.activeTurnId ?? String((p as any).turnId ?? (p as any).turn_id ?? `turn_${Date.now()}`)) as any;

  return {
    requestId: opts.requestId as any,
    params: {
      workspaceId: opts.workspaceId,
      threadId: opts.threadId,
      turnId,
      itemId: itemId as any,
      questions,
    },
  };
}


