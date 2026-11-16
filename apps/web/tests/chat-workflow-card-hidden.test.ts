import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_HIDDEN_CARDS_PER_THREAD,
  clearHiddenWorkflowCards,
  hiddenWorkflowTaskIds,
  hideChatWorkflowCard,
} from "../src/features/chat/hiddenWorkflowCards.ts";

/** 用最小 window 替身驱动 localStorage 分支，返回还原函数。 */
function installFakeWindow(
  storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void },
): () => void {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return () => {
    (globalThis as { window?: unknown }).window = original;
  };
}

/** 记录型 localStorage 替身：落盘内容可逐字比对。 */
function createStorage() {
  const stored = new Map<string, string>();
  return {
    stored,
    storage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    },
  };
}

/** 存储键必须逐字稳定，且 threadId 走 URI 编码（含冒号的工作区会话 id 不会串键）。 */
function storageKeyFor(threadId: string): string {
  return `codeflow:chat:hidden-workflow-card::${encodeURIComponent(threadId)}`;
}

test("无 localStorage 时降级为内存层：同会话读回命中、不抛错、不同会话互不串", () => {
  const threadId = "thread-no-window";
  clearHiddenWorkflowCards(threadId);
  assert.doesNotThrow(() => hideChatWorkflowCard(threadId, "task-1"));
  assert.equal(hiddenWorkflowTaskIds(threadId).has("task-1"), true);
  assert.equal(hiddenWorkflowTaskIds("thread-other").size, 0);
  // 空 threadId / 空 taskId 一律忽略，避免写入无法归属的脏记录。
  hideChatWorkflowCard(threadId, "   ");
  hideChatWorkflowCard("", "task-x");
  assert.equal(hiddenWorkflowTaskIds(threadId).size, 1);
  assert.equal(hiddenWorkflowTaskIds("").size, 0);
  clearHiddenWorkflowCards(threadId);
  assert.equal(hiddenWorkflowTaskIds(threadId).size, 0);
});

test("存储键逐字固定，值为换行分隔且重复隐藏不产生重复行", () => {
  const threadId = "client-a:repo:thread-1";
  clearHiddenWorkflowCards(threadId);
  const { stored, storage } = createStorage();
  const restore = installFakeWindow(storage);
  try {
    hideChatWorkflowCard(threadId, "task-1");
    hideChatWorkflowCard(threadId, "task-2");
    hideChatWorkflowCard(threadId, "task-1");
    assert.equal(stored.get(storageKeyFor(threadId)), "task-2\ntask-1");
    assert.deepEqual([...hiddenWorkflowTaskIds(threadId)].sort(), ["task-1", "task-2"]);
  } finally {
    restore();
    clearHiddenWorkflowCards(threadId);
  }
});

test("超过单会话上限按最旧淘汰，落盘只保留最新的 MAX 条", () => {
  const threadId = "thread-max";
  clearHiddenWorkflowCards(threadId);
  const { stored, storage } = createStorage();
  const restore = installFakeWindow(storage);
  try {
    for (let index = 0; index < MAX_HIDDEN_CARDS_PER_THREAD + 2; index += 1) {
      hideChatWorkflowCard(threadId, `task-${index}`);
    }
    const persisted = (stored.get(storageKeyFor(threadId)) ?? "").split("\n");
    assert.equal(persisted.length, MAX_HIDDEN_CARDS_PER_THREAD);
    assert.equal(persisted[persisted.length - 1], `task-${MAX_HIDDEN_CARDS_PER_THREAD + 1}`);
    assert.equal(persisted.includes("task-0"), false);
    assert.equal(persisted.includes("task-1"), false);
  } finally {
    restore();
    clearHiddenWorkflowCards(threadId);
  }
});

test("写入失败不抛异常，内存层仍命中", () => {
  const threadId = "thread-quota";
  clearHiddenWorkflowCards(threadId);
  const restore = installFakeWindow({
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("quota exceeded"); },
  });
  try {
    assert.doesNotThrow(() => hideChatWorkflowCard(threadId, "task-1"));
    assert.equal(hiddenWorkflowTaskIds(threadId).has("task-1"), true);
  } finally {
    restore();
    clearHiddenWorkflowCards(threadId);
  }
});

test("clear 同清内存与落盘", () => {
  const threadId = "thread-clear";
  clearHiddenWorkflowCards(threadId);
  const { stored, storage } = createStorage();
  const restore = installFakeWindow(storage);
  try {
    hideChatWorkflowCard(threadId, "task-1");
    assert.equal(stored.get(storageKeyFor(threadId)), "task-1");
    clearHiddenWorkflowCards(threadId);
    assert.equal(stored.get(storageKeyFor(threadId)), "");
    assert.equal(hiddenWorkflowTaskIds(threadId).size, 0);
  } finally {
    restore();
    clearHiddenWorkflowCards(threadId);
  }
});
