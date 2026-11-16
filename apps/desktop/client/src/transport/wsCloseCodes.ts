import {
  CLIENT_WS_CLOSE_CODE_ACCESS_CHANGED,
  CLIENT_WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_PREEMPT_DECLINED,
  CLIENT_WS_CLOSE_CODE_PREEMPT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_REPLACED,
  CLIENT_WS_CLOSE_CODE_STOP_REQUESTED,
  CLIENT_WS_CLOSE_CODE_TRY_AGAIN_LATER,
} from "@codeflowai/shared";

export {
  CLIENT_WS_CLOSE_CODE_ACCESS_CHANGED,
  CLIENT_WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_PREEMPT_DECLINED,
  CLIENT_WS_CLOSE_CODE_PREEMPT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_REPLACED,
  CLIENT_WS_CLOSE_CODE_STOP_REQUESTED,
  CLIENT_WS_CLOSE_CODE_TRY_AGAIN_LATER,
};

export type ClientWsCloseDisposition = "reconnect" | "blocked" | "stop";

const LEGACY_STOP_REASONS = new Set([
  "Kicked by admin",
  "Kicked by enterprise admin",
  "Replaced by another client",
]);

/** Keep unknown codes retryable; only explicit operator/replacement signals may stop the daemon. */
export function resolveClientWsCloseDisposition(code: number, reason = ""): ClientWsCloseDisposition {
  if (code === CLIENT_WS_CLOSE_CODE_STOP_REQUESTED) return "stop";
  if (code === CLIENT_WS_CLOSE_CODE_REPLACED) {
    return LEGACY_STOP_REASONS.has(String(reason).trim()) ? "stop" : "blocked";
  }
  if (
    code === 1008
    || code === CLIENT_WS_CLOSE_CODE_PREEMPT_DECLINED
    || code === CLIENT_WS_CLOSE_CODE_PREEMPT_TIMEOUT
    || code === CLIENT_WS_CLOSE_CODE_ACCESS_CHANGED
  ) {
    return "blocked";
  }
  return "reconnect";
}

/** Backward-compatible helper for callers that only need to know whether transport reconnects. */
export function isFatalClientCloseCode(code: number, reason = ""): boolean {
  return resolveClientWsCloseDisposition(code, reason) !== "reconnect";
}
