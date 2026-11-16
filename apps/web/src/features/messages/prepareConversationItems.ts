import { computed, isReactive, type ComputedRef } from "vue";
import { prepareConversationItemsForDisplay as prepareShared, type ConversationItem, type DisplayConversationItem } from "@codeflowai/shared";

export type { DisplayConversationItem, RequirementAnalysisDisplayItem } from "@codeflowai/shared";

const displayByFirstItem = new WeakMap<ConversationItem, { items: ConversationItem[]; display: ComputedRef<DisplayConversationItem[]> }>();

/** 在用户/系统消息边界内复用响应式转换；普通对象仍每次按 shared 原语义转换。 */
export function prepareConversationItemsForDisplay(items: ConversationItem[]): DisplayConversationItem[] {
  const output: DisplayConversationItem[] = [];
  let pending: ConversationItem[] = [];
  /** 相邻工具必须整组转换，以保留 shared 的 explore 合并与去重顺序。 */
  function flush(): void {
    if (!pending.length) return;
    const group = pending;
    pending = [];
    let display: DisplayConversationItem[];
    if (group.every(item => isReactive(item))) {
      const first = group[0]!;
      let cached = displayByFirstItem.get(first);
      if (!cached || cached.items.length !== group.length || group.some((item, index) => item !== cached!.items[index])) {
        cached = { items: group, display: computed(() => prepareShared(group)) };
        displayByFirstItem.set(first, cached);
      }
      display = cached.display.value;
    } else {
      display = prepareShared(group);
    }
    for (const item of display) output.push(item);
  }
  for (const item of items) {
    if (item.kind === "systemMessage" || (item.kind === "message" && item.role === "user")) {
      flush();
      output.push(item);
    } else {
      pending.push(item);
    }
  }
  flush();
  return output;
}
