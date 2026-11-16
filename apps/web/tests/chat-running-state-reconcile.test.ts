import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("apps/web/src/features/chat/components/chat-panel.vue", "utf8");
const chatStoreSource = fs.readFileSync("apps/web/src/store/chat.ts", "utf8");

test("运行中会话定期核对权威状态，终态漏事件时自动回放历史", () => {
  assert.match(source, /RUNNING_STATE_RECONCILE_INTERVAL_MS\s*=\s*5_000/u);
  assert.match(source, /chat\.syncThreadSummaryState\(ctx\.value, \{ workspaceId, threadId \}\)/u);
  assert.match(source, /if \(running(?:\s*\|\|[^)]*)?\) return;/u);
  assert.match(source, /runningStateReconcileGeneration/u);
  assert.match(source, /await chat\.loadThread\(ctx\.value, \{/u);
  assert.match(source, /CHAT_RUNNING_STATE_RECONCILE_FAILED/u);
  assert.match(source, /stopRunningStateReconcile\(\);/u);
});

test("accepted chat turns rehydrate history when live events are missing", () => {
  assert.match(chatStoreSource, /ACCEPTED_TURN_CONTENT_RECONCILE_DELAYS_MS\s*=\s*\[2_500,\s*8_000,\s*20_000\]/u);
  assert.match(chatStoreSource, /scheduleAcceptedTurnContentReconcile\(/u);
  assert.match(chatStoreSource, /conversationHasTurnActivity\(stateBefore, normalizedTurnId\)/u);
  assert.match(chatStoreSource, /bumpContentEpoch:\s*false/u);
  assert.match(chatStoreSource, /CHAT_ACCEPTED_TURN_CONTENT_RECONCILE_FAILED/u);
  assert.match(chatStoreSource, /cancelAcceptedTurnContentReconcile\(\{[\s\S]*?workspaceId:\s*event\.workspaceId/u);
  assert.match(chatStoreSource, /cancelAcceptedTurnContentReconcileForThread\(previousThreadId\)/u);
});
