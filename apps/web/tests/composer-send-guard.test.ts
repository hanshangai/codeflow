import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  shouldAllowComposerSend,
  shouldEnqueueInsteadOfSend,
} from "../src/features/composer/send-guard.ts";

const composerSource = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");

test("真实本机聊天无需云端会话即可发送，其他发送约束仍生效", () => {
  const input = { disabled: false, connected: false, hasWebSession: false, localReady: true, sending: false,
    hasModelRequirement: true, hasSelectedModel: true, hasContent: true, runningTurnId: null };
  assert.equal(shouldAllowComposerSend(input), true);
  assert.equal(shouldAllowComposerSend({ ...input, localReady: false }), false);
  assert.equal(shouldAllowComposerSend({ ...input, disabled: true }), false);
  assert.equal(shouldAllowComposerSend({ ...input, hasSelectedModel: false }), false);
});

test("H5 composer balances circular actions while keeping the input slightly toward attachment", () => {
  assert.match(composerSource, /grid-template-columns: 44px minmax\(0, 1fr\) 44px;\s*align-items: center;\s*column-gap: 0;/u);
  assert.match(composerSource, /:type="props\.surface === 'h5' \? 'default' : 'text'"\s*:shape="props\.surface === 'h5' \? 'circle' : 'default'"/u);
  assert.match(composerSource, /\.composer--h5 \.composer__toolbar-primary \{[^}]*padding: 0;[^}]*-webkit-mask-image: none;[^}]*mask-image: none;/su);
  assert.match(composerSource, /\.composer--h5 \.composer__toolbar-primary :deep\(\.ant-btn\) \{[^}]*border-radius: 50%;/su);
  assert.match(composerSource, /\.composer--h5 \.composer__textarea \{[^}]*width: auto;[^}]*margin: 0 6px 0 4px;/su);
  assert.match(composerSource, /\.composer--h5 \.composer__footer \{[^}]*align-self: center;[^}]*justify-content: center;/su);
});

test("node thread always enqueues while idle chat and node discussion keep direct-send behavior", () => {
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: "node",
    runningTurnId: null,
    queueLength: 0,
  }), true);
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: null,
    runningTurnId: null,
    queueLength: 0,
  }), false);
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: "node-discussion",
    runningTurnId: null,
    queueLength: 0,
  }), false);
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: "node-discussion",
    runningTurnId: "turn-node-discussion-running",
    queueLength: 0,
  }), true);
});

test("interrupted queue yields to new user input while other pauses keep enqueueing", () => {
  // 队列因用户中断暂停：再次发消息表示要继续会话，走直发让宿主端恢复队列并投递待发送项。
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: null,
    runningTurnId: null,
    queueLength: 2,
    queuePausedReason: "user_stop",
  }), false);

  // 显式暂停与失败类暂停不允许被新输入解除，仍需入队。
  for (const reason of ["user_pause", "send_failed", "session_invalidated", "rollback", "transient_cleanup"] as const) {
    assert.equal(shouldEnqueueInsteadOfSend({
      threadSubtype: null,
      runningTurnId: null,
      queueLength: 2,
      queuePausedReason: reason,
    }), true, `${reason} 不应被新输入解除`);
  }

  // 运行中的 turn 与节点线程语义不变：仍然入队。
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: null,
    runningTurnId: "turn-running",
    queueLength: 2,
    queuePausedReason: "user_stop",
  }), true);
  assert.equal(shouldEnqueueInsteadOfSend({
    threadSubtype: "node",
    runningTurnId: null,
    queueLength: 0,
    queuePausedReason: "user_stop",
  }), true);
});

test("composer passes thread subtype into the enqueue decision", () => {
  assert.match(composerSource, /threadSubtype: thread\.value\?\.threadSubtype \?\? null,/u);
  assert.match(composerSource, /if \(sendShouldEnqueue\) \{\s*\/\/[^\n]*\s*await threadQueueStore\.append\(/u);
});

test("node thread keeps queue transport internal and labels the action as send", () => {
  assert.match(composerSource, /const isNodeExecutionThread = computed\(\(\) => thread\.value\?\.threadSubtype === "node"\);/u);
  assert.match(composerSource, /if \(isNodeExecutionThread\.value\) return "发送";/u);
});
