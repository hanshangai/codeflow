import { normalizeAssistantMessagePhase, type AssistantLifecycleRecord } from "../assistantLifecycle.js";

export type CodexRecoveredAssistantItem = Pick<
  AssistantLifecycleRecord,
  "itemId" | "engineMessageId" | "text" | "phase"
>;

export type CodexTurnRecoveryOutcome =
  | { kind: "completed"; responseText: string | null; assistantItems: CodexRecoveredAssistantItem[] }
  | { kind: "error"; message: string; code: string }
  | { kind: "pending" };

/** 默认要求整个 provider thread 终态；精确目标已确认时可只按该 turn 收口。 */
export function extractCodexThreadReadRecoveryOutcome(
  read: unknown,
  input: { engineSessionId: string; engineTurnId: string; reason: string; allowSiblingRunning?: boolean },
): CodexTurnRecoveryOutcome {
  const engineSessionId = String(input.engineSessionId ?? "").trim();
  const engineTurnId = String(input.engineTurnId ?? "").trim();
  const reason = String(input.reason ?? "").trim() || "reconcile";
  const thread = (read as any)?.thread ?? null;
  const providerThreadId = String(thread?.id ?? "").trim();
  if (!engineSessionId || !engineTurnId || providerThreadId !== engineSessionId) return { kind: "pending" };

  if (!Array.isArray(thread?.turns)) return { kind: "pending" };
  const turns = thread.turns as any[];
  const turnEvidence = turns.map((item) => ({
    id: String(item?.id ?? "").trim(),
    status: normalizeCodexTurnStatus(item?.status),
    value: item,
  }));
  const matchingTurns = turnEvidence.filter((item) => item.id === engineTurnId);
  if (matchingTurns.length !== 1) return { kind: "pending" };
  if (!input.allowSiblingRunning) {
    if (turnEvidence.some((item) => !item.id || !isTerminalCodexTurnStatus(item.status))) {
      return { kind: "pending" };
    }
    const threadStatus = normalizeCodexTurnStatus(thread?.status);
    if (!isTerminalCodexThreadStatus(threadStatus)) return { kind: "pending" };
  }
  const turn = matchingTurns[0]!.value;
  const turnStatus = matchingTurns[0]!.status;
  if (turnStatus === "completed") {
    return {
      kind: "completed",
      responseText: extractLatestAssistantText(turn),
      assistantItems: extractAssistantItems(turn),
    };
  }
  if (isTerminalCodexTurnStatus(turnStatus)) {
    return {
      kind: "error",
      message: buildCodexTurnTerminalMessage(turnStatus, reason),
      code: `codex_${turnStatus}`,
    };
  }

  return { kind: "pending" };
}

function extractLatestAssistantText(turn: any): string | null {
  const assistant = extractAssistantItems(turn).at(-1) ?? null;
  const text = assistant ? String((assistant as any).text ?? "").trim() : "";
  return text || null;
}

/** 仅补偿普通助手正文；异步问题由结构化交互事件展示。 */
export function extractAssistantItems(turn: any): CodexRecoveredAssistantItem[] {
  const items = Array.isArray(turn?.items) ? (turn.items as any[]) : [];
  const out: CodexRecoveredAssistantItem[] = [];
  for (const item of items) {
    if (String(item?.type ?? "").trim() !== "agentMessage") continue;
    if (item.delivery === "async") continue;
    const itemId = String(item?.id ?? "").trim();
    const text = String(item?.text ?? "");
    if (!itemId || !text.trim()) continue;
    out.push({
      itemId,
      engineMessageId: itemId,
      text,
      phase: normalizeAssistantMessagePhase(item?.phase),
    });
  }
  return out;
}

function normalizeCodexTurnStatus(status: unknown): string {
  if (typeof status === "string") return status.trim().toLowerCase();
  if (status && typeof status === "object") {
    const type = String((status as any).type ?? "").trim().toLowerCase();
    if (type) return type;
  }
  return "";
}

function isTerminalCodexTurnStatus(status: string): boolean {
  return status === "completed" || status === "interrupted" || status === "error" || status === "failed" || status === "cancelled";
}

/** 识别不会再接受新活动的 provider thread 状态。 */
function isTerminalCodexThreadStatus(status: string): boolean {
  return status === "idle" || status === "systemerror" || status === "system_error" || status === "notloaded";
}

function buildCodexTurnTerminalMessage(status: string, reason: string): string {
  const normalizedReason = String(reason ?? "").trim();
  if (normalizedReason) return `Codex turn ended as ${status} (${normalizedReason})`;
  return `Codex turn ended as ${status}`;
}
