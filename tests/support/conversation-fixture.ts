import type { ThreadConversationState } from "../../apps/web/src/features/chat/chatTypes.ts";

/**
 * 构造对话状态测试夹具。
 * 实现新增字段时只需改这里，不必逐个测试文件同步补齐。
 */
export function createConversationState(
  overrides: Partial<ThreadConversationState> = {},
): ThreadConversationState {
  return {
    threadId: "thread_test",
    items: [],
    tokenUsage: null,
    runningTurnId: null,
    runningTurnStartedAt: null,
    completedTurnIds: {},
    engineSessionId: null,
    currentTodolist: null,
    invalidated: false,
    _indexById: new Map(),
    _assistantTranscriptIdByItemId: new Map(),
    _assistantTranscriptIdByTurnId: new Map(),
    ...overrides,
  };
}
