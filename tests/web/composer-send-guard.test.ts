import test from "node:test";
import assert from "node:assert/strict";

import {
  shouldAllowComposerSend,
  shouldEnqueueInsteadOfSend,
  shouldSubmitOnEnter,
} from "../../apps/web/src/features/composer/send-guard.ts";

test("shouldAllowComposerSend blocks sending while a turn is running", () => {
  const allowed = shouldAllowComposerSend({
    disabled: false,
    connected: true,
    hasWebSession: true,
    sending: false,
    hasModelRequirement: false,
    hasSelectedModel: true,
    hasContent: true,
    runningTurnId: "turn-running",
  });

  assert.equal(allowed, false);
});

test("shouldAllowComposerSend allows draft content when idle and ready", () => {
  const allowed = shouldAllowComposerSend({
    disabled: false,
    connected: true,
    hasWebSession: true,
    sending: false,
    hasModelRequirement: false,
    hasSelectedModel: true,
    hasContent: true,
    runningTurnId: null,
  });

  assert.equal(allowed, true);
});

test("shouldSubmitOnEnter does not submit while a turn is running by default", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    runningTurnId: "turn-running",
  });

  assert.equal(shouldSubmit, false);
});

test("shouldSubmitOnEnter submits during running when allowDuringRunning=true (composer 入队场景)", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    runningTurnId: "turn-running",
    allowDuringRunning: true,
  });

  assert.equal(shouldSubmit, true);
});

test("shouldSubmitOnEnter submits on bare Enter (Enter 发送)", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    runningTurnId: null,
  });

  assert.equal(shouldSubmit, true);
});

test("shouldSubmitOnEnter does not submit on Ctrl+Enter (留给换行)", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    runningTurnId: null,
  });

  assert.equal(shouldSubmit, false);
});

test("shouldSubmitOnEnter does not submit on Cmd+Enter (留给换行)", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: true,
    altKey: false,
    runningTurnId: null,
  });

  assert.equal(shouldSubmit, false);
});

test("shouldSubmitOnEnter does not submit on Alt+Enter (留给换行)", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: true,
    runningTurnId: null,
  });

  assert.equal(shouldSubmit, false);
});

test("shouldSubmitOnEnter does not submit while IME composition is active", () => {
  const shouldSubmit = shouldSubmitOnEnter({
    key: "Enter",
    shiftKey: false,
    isComposing: true,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    runningTurnId: null,
  });

  assert.equal(shouldSubmit, false);
});

test("shouldEnqueueInsteadOfSend: idle + 队列空 → 直接 send", () => {
  const enqueue = shouldEnqueueInsteadOfSend({ runningTurnId: null, queueLength: 0 });
  assert.equal(enqueue, false);
});

test("shouldEnqueueInsteadOfSend: 节点线程即使 idle 且队列空也入队", () => {
  const enqueue = shouldEnqueueInsteadOfSend({
    threadSubtype: "node",
    runningTurnId: null,
    queueLength: 0,
  });
  assert.equal(enqueue, true);
});

test("shouldEnqueueInsteadOfSend: 普通会话 idle 且队列空仍直接 send", () => {
  const enqueue = shouldEnqueueInsteadOfSend({
    threadSubtype: null,
    runningTurnId: null,
    queueLength: 0,
  });
  assert.equal(enqueue, false);
});

test("shouldEnqueueInsteadOfSend: 节点讨论线程不被当成执行节点", () => {
  const enqueue = shouldEnqueueInsteadOfSend({
    threadSubtype: "node-discussion",
    runningTurnId: null,
    queueLength: 0,
  });
  assert.equal(enqueue, false);
});

test("shouldEnqueueInsteadOfSend: 节点讨论线程在模型回复期间正常入队", () => {
  const enqueue = shouldEnqueueInsteadOfSend({
    threadSubtype: "node-discussion",
    runningTurnId: "turn-node-discussion-running",
    queueLength: 0,
  });
  assert.equal(enqueue, true);
});

test("shouldEnqueueInsteadOfSend: 运行中 → 入队", () => {
  const enqueue = shouldEnqueueInsteadOfSend({ runningTurnId: "turn-running", queueLength: 0 });
  assert.equal(enqueue, true);
});

test("shouldEnqueueInsteadOfSend: 空闲但队列非空 → 入队（保留顺序）", () => {
  const enqueue = shouldEnqueueInsteadOfSend({ runningTurnId: null, queueLength: 3 });
  assert.equal(enqueue, true);
});
