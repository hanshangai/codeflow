import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isDurableSystemMessageId } from "../src/features/messages/dismissedSystemMessages.ts";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const systemMessageItemSource = readSource("../src/features/messages/components/items/system-message-item.vue");
const messagesListSource = readSource("../src/features/messages/components/messages-list.vue");
const chatPanelSource = readSource("../src/features/chat/components/chat-panel.vue");

test("提示条把 ✕ 关闭事件抛给上层，而不是只留在组件内部", () => {
  assert.match(systemMessageItemSource, /defineEmits<\{ \(e: "close", id: string\): void \}>\(\)/u);
  assert.match(systemMessageItemSource, /<a-alert[^>]*closable[^>]*@close="emit\('close', String\(item\.id\)\)"/u);
});

test("消息列表把提示条 close 转发为 closeSystemMessage", () => {
  assert.match(messagesListSource, /\(e: "closeSystemMessage", id: string\): void/u);
  assert.match(messagesListSource, /<SystemMessageItem[\s\S]*?@close="\(id\) => emit\('closeSystemMessage', id\)"[\s\S]*?\/>/u);
});

test("会话面板按已关闭集合过滤提示条，并把关闭事件写进记忆", () => {
  assert.match(
    chatPanelSource,
    /const displayItems = computed\(\(\) =>[\s\S]*?\.filter\(\(item\) => item\.kind !== "systemMessage" \|\| !dismissedSystemMessageIdsForThread\.value\.has\(String\(item\.id\)\)\)/u,
  );
  assert.match(
    chatPanelSource,
    /function closeSystemMessage\(id: string\): void \{[\s\S]*?dismissSystemMessage\(threadId, id\);[\s\S]*?\}/u,
  );
  assert.match(chatPanelSource, /@close-system-message="closeSystemMessage"/u);
});

test("只有来自事件回放的稳定 id 可持久化，本地一次性通知 id 不可", () => {
  assert.equal(isDurableSystemMessageId("sys_12"), true);
  assert.equal(isDurableSystemMessageId("orch_3"), true);
  assert.equal(isDurableSystemMessageId("sys_-1"), false);
  assert.equal(isDurableSystemMessageId(""), false);
});
