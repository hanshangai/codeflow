import { CODEX_PROVIDER_TURN_MAPPING_CONFLICT_CODE } from "../db/repos/codexProviderTurnMapping.js";
import type { ClientToServerMessage } from "@codeflowai/shared";
import { WorkspaceApiRequestFailure, getWorkspaceApiRequestFailureDetails } from "../app/handleApiRequest.js";

/** 请求最终处分只补未尝试的失败响应；原聚合保留，不重做业务或重复投递。 */
export function dispatchWorkspaceApiRequestFailure(input: {
  error: unknown;
  requestId: string;
  send(message: ClientToServerMessage): { accepted: boolean };
}): { error: WorkspaceApiRequestFailure; response: "accepted" | "already_attempted" | "rejected" } | null {
  const details = getWorkspaceApiRequestFailureDetails(input.error);
  if (!details || details.requestId !== input.requestId) return null;
  const failure = input.error as WorkspaceApiRequestFailure;
  if (details.responseAttempted) return { error: failure, response: "already_attempted" };
  try {
    const result = input.send({ t: "api.res", id: input.requestId, status: 500,
      body: { ok: false, code: details.code, message: "请求执行失败，请查看工作区日志", requestId: input.requestId } });
    if (!result.accepted) throw result;
    return { error: failure, response: "accepted" };
  } catch (deliveryError) {
    return { error: new WorkspaceApiRequestFailure([failure, deliveryError], {
      ...details, code: "WORKSPACE_API_FAILURE_RESPONSE_REJECTED", responseAttempted: true, responseDelivered: false,
    }), response: "rejected" };
  }
}

export type TransportMessageFailureDisposition =
  | "isolate_raw_event"
  | "isolate_terminal_turn_mapping"
  | "shutdown_client";

export type TransportFailureTurnSnapshot = {
  turnId: unknown;
  workspaceId: unknown;
  threadId: unknown;
  engine: unknown;
  status: unknown;
};

type FailurePolicyInput = {
  messageType: string;
  error: unknown;
  event: {
    type?: unknown;
    engine?: unknown;
    workspaceId?: unknown;
    threadId?: unknown;
    clientTurnId?: unknown;
    payload?: { turnId?: unknown } | null;
  } | null;
  turn: TransportFailureTurnSnapshot | null;
};

export type PreparedTransportMessageFailure = {
  disposition: TransportMessageFailureDisposition;
  effectiveError: unknown;
  turn: TransportFailureTurnSnapshot | null;
};

/** 读取必要的 turn 快照并严格落库被隔离的 ACK；任一步失败都升级为受控关闭。 */
export function prepareTransportMessageFailure(input: {
  messageType: string;
  error: unknown;
  event: FailurePolicyInput["event"];
  loadTurn: (turnId: string) => TransportFailureTurnSnapshot | null;
  flushConversationEvidence: () => void;
  flushRawEvidence: () => void;
}): PreparedTransportMessageFailure {
  const messageType = String(input.messageType ?? "").trim();
  const eventTurnId = String(
    messageType === "raw.eventAck"
      ? input.event?.clientTurnId
      : input.event?.payload?.turnId,
  ).trim();
  let turn: TransportFailureTurnSnapshot | null = null;
  if ((messageType === "conversation.eventAck" || messageType === "raw.eventAck") && eventTurnId) {
    try {
      turn = input.loadTurn(eventTurnId);
    } catch (cause) {
      return {
        disposition: "shutdown_client",
        effectiveError: combineTransportFailureErrors(input.error, cause, "消息失败处分读取本地 turn 失败"),
        turn: null,
      };
    }
  }

  const disposition = decideTransportMessageFailureDisposition({
    messageType,
    error: input.error,
    event: input.event,
    turn,
  });
  try {
    if (disposition === "isolate_raw_event") input.flushRawEvidence();
    if (disposition === "isolate_terminal_turn_mapping") input.flushConversationEvidence();
  } catch (cause) {
    return {
      disposition: "shutdown_client",
      effectiveError: combineTransportFailureErrors(
        input.error,
        cause,
        disposition === "isolate_raw_event"
          ? "raw ACK 隔离前严格落库失败"
          : "终态 turn 映射冲突隔离前严格落库失败",
      ),
      turn,
    };
  }
  return { disposition, effectiveError: input.error, turn };
}

/** 仅隔离 raw ACK，或 scope 完全匹配的旧终态 turn 映射冲突；未知故障仍关闭 Client。 */
export function decideTransportMessageFailureDisposition(input: FailurePolicyInput): TransportMessageFailureDisposition {
  const messageType = String(input.messageType ?? "").trim();
  if (messageType === "raw.eventAck") {
    const event = input.event;
    const turn = input.turn;
    const eventTurnId = String(event?.clientTurnId ?? "").trim();
    if (
      event?.engine !== "codex"
      || turn?.engine !== "codex"
      || (turn?.status !== "completed" && turn?.status !== "error")
      || !eventTurnId
      || String(turn.turnId ?? "") !== eventTurnId
      || String(turn.workspaceId ?? "") !== String(event.workspaceId ?? "")
      || String(turn.threadId ?? "") !== String(event.threadId ?? "")
    ) {
      return "shutdown_client";
    }
    return hasNestedErrorCode(input.error, CODEX_PROVIDER_TURN_MAPPING_CONFLICT_CODE)
      ? "isolate_raw_event"
      : "shutdown_client";
  }
  if (messageType !== "conversation.eventAck") return "shutdown_client";

  const event = input.event;
  const turn = input.turn;
  const eventTurnId = String(event?.payload?.turnId ?? "").trim();
  if (
    event?.type !== "turn.engineBound"
    || event?.engine !== "codex"
    || turn?.engine !== "codex"
    || (turn?.status !== "completed" && turn?.status !== "error")
    || !eventTurnId
    || String(turn.turnId ?? "") !== eventTurnId
    || String(turn.workspaceId ?? "") !== String(event.workspaceId ?? "")
    || String(turn.threadId ?? "") !== String(event.threadId ?? "")
  ) {
    return "shutdown_client";
  }
  return hasNestedErrorCode(input.error, CODEX_PROVIDER_TURN_MAPPING_CONFLICT_CODE)
    ? "isolate_terminal_turn_mapping"
    : "shutdown_client";
}

/** 沿 Error/AggregateError cause 链查找结构化错误码，拒绝依赖文案匹配。 */
function hasNestedErrorCode(cause: unknown, code: string, seen = new Set<object>()): boolean {
  if (!cause || typeof cause !== "object" || seen.has(cause)) return false;
  seen.add(cause);
  if (String((cause as { code?: unknown }).code ?? "") === code) return true;
  if (cause instanceof AggregateError) {
    for (const nested of cause.errors) {
      if (hasNestedErrorCode(nested, code, seen)) return true;
    }
  }
  return hasNestedErrorCode((cause as { cause?: unknown }).cause, code, seen);
}

/** 聚合原始索引错误和失败处分自身错误，避免丢失任一侧证据。 */
function combineTransportFailureErrors(primary: unknown, secondary: unknown, message: string): AggregateError {
  return new AggregateError([primary, secondary], message, { cause: primary });
}
