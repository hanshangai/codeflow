/**
 * Claude Code stream-json stdout 事件类型桥接。
 *
 * 从 @anthropic-ai/claude-agent-sdk re-export SDK 导出的类型，
 * 手动补充 SDK 未导出的控制协议类型（SDKControlRequest 等）。
 */

// ── SDK 导出类型 re-export ──
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKLocalCommandOutputMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKToolProgressMessage,
  SDKAuthStatusMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKFilesPersistedEvent,
  SDKToolUseSummaryMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKPartialAssistantMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKLocalCommandOutputMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKToolProgressMessage,
  SDKAuthStatusMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskProgressMessage,
  SDKFilesPersistedEvent,
  SDKToolUseSummaryMessage,
  SDKRateLimitEvent,
  SDKRateLimitInfo,
  SDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage,
};

// ── SDK 未导出的控制协议类型（手动定义，对齐 sdk.d.ts 内部 declare type）──

/** stdout: Claude Code 请求权限审批 */
export type ClaudeControlRequest = {
  type: "control_request";
  request_id: string;
  request: {
    subtype: string;
    tool_name?: string;
    tool_use_id?: string;
    input?: unknown;
    permission_suggestions?: unknown[];
    blocked_path?: string;
    decision_reason?: string;
    agent_id?: string;
    description?: string;
    [k: string]: unknown;
  };
};

/** stdin: 应用程序回写权限审批结果 */
export type ClaudeControlResponse = {
  type: "control_response";
  response: {
    subtype: string;
    request_id: string;
    response?: unknown;
    error?: string;
    [k: string]: unknown;
  };
};

/** stdout: 取消已发出的 control_request */
export type ClaudeControlCancelRequest = {
  type: "control_cancel_request";
  request_id: string;
};

/** stdout: 心跳保活 */
export type ClaudeKeepAlive = {
  type: "keep_alive";
};

/** Claude Code stdout 的完整类型联合：SDKMessage + 控制协议 + 心跳 */
export type ClaudeStdoutEvent =
  | SDKMessage
  | ClaudeControlRequest
  | ClaudeControlResponse
  | ClaudeControlCancelRequest
  | ClaudeKeepAlive;

/**
 * 所有已知的 stdout 顶层 type 字面量。
 * 替换 claudeThreadSession.ts 中硬编码的 knownRawTypes。
 */
export const ALL_KNOWN_STDOUT_TYPES: ReadonlySet<string> = new Set([
  // SDKMessage 成员（11 种顶层 type）
  "assistant", "user", "result", "stream_event", "error",
  "system", "tool_progress",
  "auth_status", "rate_limit_event", "prompt_suggestion", "tool_use_summary",
  // 控制协议（SDK 未导出）
  "control_request", "control_response", "control_cancel_request",
  // 非协议
  "keep_alive",
]);
