import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";
import type { DesktopApiRequest, WorkspaceId } from "@codeflowai/shared";

import { useExplorerStore } from "../src/store/explorer.ts";

const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
const head = "a".repeat(40);

/** 只替换本机桥响应边界，其余走真实 Store。 */
function fixture(t: test.TestContext, request: (request: DesktopApiRequest) => Promise<unknown>) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({}), request } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const store = useExplorerStore();
  store.selectedGitRepositoryPath = "";
  store.gitStatus = { isRepo: true, headCommit: head, historyCacheable: true } as never;
  return store;
}

test("git history shows the cached page while the forced refresh is pending", async t => {
  let resolveRefresh!: (value: unknown) => void;
  let calls = 0;
  const store = fixture(t, async () => {
    calls += 1;
    if (calls === 1) return { status: 200, body: { ok: true, entries: [{ hash: "first" }], total: 1 } };
    return new Promise((resolve) => { resolveRefresh = resolve; });
  });
  const workspaceId = `desktop:cache-${crypto.randomUUID()}` as WorkspaceId;

  await store.loadGitLog(ctx, workspaceId);
  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["first"]);

  // 模拟面板卸载/工作区 Store 重置：缓存由模块级快照保留。
  store.resetForWorkspace();
  store.gitStatus = { isRepo: true, headCommit: head, historyCacheable: true } as never;
  const refresh = store.loadGitLog(ctx, workspaceId, 20, 0, true);

  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["first"]);
  assert.equal(store.gitLogLoading, true);

  resolveRefresh({ status: 200, body: { ok: true, entries: [{ hash: "second" }], total: 1 } });
  await refresh;
  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["second"]);
  assert.equal(store.gitLogLoading, false);
});

test("git history keeps the last repository list visible while a new HEAD loads", async t => {
  let resolveNext!: (value: unknown) => void;
  let calls = 0;
  const store = fixture(t, async () => {
    calls += 1;
    if (calls === 1) return { status: 200, body: { ok: true, entries: [{ hash: "old-head" }], total: 1 } };
    return new Promise((resolve) => { resolveNext = resolve; });
  });
  const workspaceId = `desktop:cache-head-${crypto.randomUUID()}` as WorkspaceId;

  await store.loadGitLog(ctx, workspaceId);
  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["old-head"]);

  store.gitStatus = { isRepo: true, headCommit: "b".repeat(40), historyCacheable: true } as never;
  const refresh = store.loadGitLog(ctx, workspaceId, 20, 0, true);
  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["old-head"]);

  resolveNext({ status: 200, body: { ok: true, entries: [{ hash: "new-head" }], total: 1 } });
  await refresh;
  assert.deepEqual(store.gitLogEntries.map((entry) => entry.hash), ["new-head"]);
});
