import type { ConversationEventEnvelope, ConversationEventInput } from "../types/events.js";
import type { ThreadPrefs } from "../types/http.js";

export type ThreadPrefsEventSource = ConversationEventEnvelope | ConversationEventInput;

/** 从会话事件里提取 thread prefs 补丁。 */
export function extractThreadPrefsPatchFromConversationEvent(event: ThreadPrefsEventSource): ThreadPrefs | null {
  if (event.type !== "approval.resolved") return null;

  const patch: ThreadPrefs = {};
  if (event.payload.nextPlanMode !== undefined) patch.planMode = Boolean(event.payload.nextPlanMode);
  if (event.payload.nextAccessMode !== undefined) patch.accessMode = event.payload.nextAccessMode ?? null;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** 合并 thread prefs，保留未出现在 patch 里的字段。 */
export function mergeThreadPrefs(current: ThreadPrefs | null | undefined, patch: ThreadPrefs | null | undefined): ThreadPrefs {
  if (!patch) return { ...(current ?? {}) };
  return { ...(current ?? {}), ...patch };
}

/** 按事件顺序回放 thread prefs。 */
export function replayThreadPrefsFromConversationEvents(
  basePrefs: ThreadPrefs | null | undefined,
  events: readonly ThreadPrefsEventSource[],
): ThreadPrefs {
  let next = mergeThreadPrefs(basePrefs, null);
  for (const event of events) {
    next = mergeThreadPrefs(next, extractThreadPrefsPatchFromConversationEvent(event));
  }
  return next;
}
