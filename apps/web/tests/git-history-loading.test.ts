import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";
import { createPinia, setActivePinia } from "pinia";
import { getPathDisplayInfo, type DesktopApiRequest, type GitStatusResult, type WorkspaceId } from "@codeflowai/shared";
import * as fileMetaPresentation from "../src/utils/fileMetaPresentation.ts";
import { useExplorerStore } from "../src/store/explorer.ts";
import { createWebSocketClient } from "../src/services/ws.ts";

const workspaceId = "desktop:history" as WorkspaceId;
const ctx = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null as string | null, desktopClientId: "desktop" };

/** 构造完整仓库的同 HEAD 快照，隔离状态传输等待与历史刷新语义。 */
function historyStatus(repositoryPath = ""): GitStatusResult {
  return { isRepo: true, repositoryPath, repositories: [{ path: repositoryPath, name: "repository" }],
    branch: "main", tracking: null, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], fileStats: {},
    merging: false, rebasing: false, headCommit: "a".repeat(40), historyCacheable: true };
}

/** 真实 Store 沿本机桥读取，测试只替换 API 的响应边界。 */
function fixture(t: test.TestContext, request: (request: DesktopApiRequest) => Promise<unknown>) {
  ctx.webSessionId = t.name;
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout,
    codeflowDesktop: { getState: async () => ({}), request } } });
  t.after(() => original ? Object.defineProperty(globalThis, "window", original) : Reflect.deleteProperty(globalThis, "window"));
  setActivePinia(createPinia());
  const store = useExplorerStore();
  store.selectedGitRepositoryPath = "";
  store.gitStatus = { isRepo: true, headCommit: "a".repeat(40) } as never;
  return store;
}

test("Git 定时复查保留已有空态，不进入加载展示且相同快照不替换引用", async t => {
  let resolveStatus!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(resolve => { resolveStatus = resolve; }));
  store._applyGitStatusSnapshot(workspaceId, { ...historyStatus(), ahead: 4 });
  const snapshot = store.gitStatus, repositories = store.gitRepositories, selections = store.selectedGitRepositoriesByWorkspace;
  const refresh = store.refreshGitStatusCached(ctx, workspaceId);
  assert.equal(store.gitStatusLoading, false, "后台请求不能使空列表变成加载中");
  assert.equal(store.gitStatus, snapshot);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus(), ahead: 4 } });
  await refresh;
  assert.equal(store.gitStatus, snapshot, "无变化时不触发依赖整个状态的重新渲染");
  assert.equal(store.gitRepositories, repositories);
  assert.equal(store.selectedGitRepositoriesByWorkspace, selections);
});

test("Git 后台复查检测到变化后才更新状态，保留刷新期间文件列表", async t => {
  let resolveStatus!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(resolve => { resolveStatus = resolve; }));
  store._applyGitStatusSnapshot(workspaceId, { ...historyStatus(), untracked: ["old.txt"] });
  const snapshot = store.gitStatus;
  const refresh = store.refreshGitView(ctx, workspaceId);
  assert.equal(store.gitStatusLoading, false);
  assert.equal(store.gitStatus, snapshot);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus(), ahead: 1, untracked: ["new.txt"] } });
  await refresh;
  assert.equal(store.gitStatus?.ahead, 1);
  assert.deepEqual(store.gitStatus?.untracked, ["new.txt"]);
  assert.notEqual(store.gitStatus, snapshot);
});

test("Git 首次读取仍显示加载，后台失败保留内容并显式拒绝", async t => {
  let resolveStatus!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(resolve => { resolveStatus = resolve; }));
  store.gitStatus = null;
  const first = store.refreshGitStatusCached(ctx, workspaceId);
  assert.equal(store.gitStatusLoading, true);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus() } });
  await first;
  const snapshot = store.gitStatus;
  const refresh = store.refreshGitView(ctx, workspaceId);
  assert.equal(store.gitStatusLoading, false);
  resolveStatus({ status: 500, body: { ok: false, code: "INTERNAL", message: "background refresh failed" } });
  await assert.rejects(refresh, /background refresh failed/);
  assert.equal(store.gitStatus, snapshot);
  assert.equal(store.gitStatusLoading, false);
});

/** 通过真实本机工具事件驱动 Git 刷新，不建立云端连接。 */
function toolRefreshClient(t: test.TestContext, explorer: ReturnType<typeof useExplorerStore>, toolName = "Bash",
  onError?: (message: string) => void) {
  const config = { ...ctx, workspaceId, connected: true, localRuntimeReady: true,
    desktopClient: { clientId: "desktop", workspaceIds: [workspaceId] }, setConnectionStatus() {} };
  const client = createWebSocketClient({ config, explorer, onError,
    chat: { threadPresentationVersionByThreadId: {}, applyEngineEvent() {}, markWorkspaceSubscribed() {} },
    presence: { isCurrentWorkspaceClientOnline: true }, engine: {} } as never);
  client.replaceLocalWorkspaceSubscription(workspaceId);
  t.after(client.disconnect);
  /** 只推进真实刷新器的去抖定时器，避免依赖墙钟耗时。 */
  return () => {
    client.receiveDesktopEvent({ t: "conversation.event", event: { schema: 1, seq: 1, ts: 1, workspaceId,
      threadId: "thread" as never, engine: "codex", type: "item.tool.completed", payload: { toolName } } as never });
    t.mock.timers.tick(16);
    t.mock.timers.tick(400);
  };
}

for (const cacheable of [true, false]) test(`工具刷新只读取一次现有 40 条历史：可缓存=${cacheable}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    if (request.method === "git.status") return { status: 200, body: { ok: true, isRepo: true, repositoryPath: "",
      repositories: [], staged: [], unstaged: [], untracked: [], headCommit: (cacheable ? "b" : "a").repeat(40), historyCacheable: cacheable } };
    return { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${index}` })) } };
  });
  store.viewMode = "log";
  store.gitStatus!.historyCacheable = cacheable;
  await store.loadGitLog(ctx, workspaceId, 40);
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  requests.length = 0;
  toolRefreshClient(t, store)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.filter(request => request.method === "git.log").map(request => request.body?.maxCount), [40]);
  assert.equal(store.gitLogEntries.length, 40);
});

for (const changed of ["panel", "repository"]) test(`工具状态返回前切换 ${changed}，不继续读取旧刷新历史`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveStatus!: (value: unknown) => void;
  const logs: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
    logs.push(request);
    return { status: 200, body: { ok: true, entries: [], total: 0 } };
  });
  store.viewMode = "log";
  toolRefreshClient(t, store)();
  if (changed === "panel") store.viewMode = "files";
  else store.selectedGitRepositoryPath = "nested";
  resolveStatus({ status: 200, body: { ok: true, isRepo: true, repositoryPath: "", repositories: [],
    staged: [], unstaged: [], untracked: [], headCommit: "b".repeat(40), historyCacheable: true } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 0);
});

test("工具刷新复用完整库的同 HEAD 历史，手动刷新仍保留 40 条重读", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    if (request.method === "git.status") return { status: 200, body: { ok: true, isRepo: true, repositoryPath: "",
      repositories: [], staged: [], unstaged: [], untracked: [], headCommit: "a".repeat(40), historyCacheable: true } };
    return { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${index}` })) } };
  });
  store.viewMode = "log";
  store.gitStatus!.historyCacheable = true;
  await store.loadGitLog(ctx, workspaceId, 40);
  requests.length = 0;
  toolRefreshClient(t, store)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.method), ["git.status"]);
  await store.refreshGitView(ctx, workspaceId, true);
  assert.deepEqual(requests.filter(request => request.method === "git.log").map(request => request.body?.maxCount), [40]);
  assert.equal(store.gitLogEntries.length, 40);
});

for (const manualFirst of [true, false]) test(`同作用域自动与手动并发刷新保留强制重读：手动先发=${manualFirst}`, async t => {
  let resolveStatus!: (value: unknown) => void;
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
    return { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${index}` })) } };
  });
  store.viewMode = "log";
  store.gitStatus = historyStatus();
  await store.loadGitLog(ctx, workspaceId, 40);
  requests.length = 0;
  const first = store.refreshGitView(ctx, workspaceId, manualFirst);
  const second = store.refreshGitView(ctx, workspaceId, !manualFirst);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus() } });
  await Promise.all([first, second]);
  assert.deepEqual(requests.map(request => request.method), ["git.status", "git.log"]);
  assert.equal(requests[1]!.body?.maxCount, 40);
  assert.equal(store.gitLogEntries.length, 40);
});

for (const failureMethod of ["git.status", "git.log"]) test(`合并刷新在 ${failureMethod} 失败时均拒绝并允许重试`, async t => {
  let resolveStatus!: (value: unknown) => void, fail = false;
  const requests: DesktopApiRequest[] = [];
  const failure = { status: 500, body: { ok: false, code: "INTERNAL", message: "refresh failed" } };
  const store = fixture(t, async request => {
    requests.push(request);
    if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
    if (fail && failureMethod === "git.log") return failure;
    return { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${index}` })) } };
  });
  store.viewMode = "log";
  store.gitStatus = historyStatus();
  await store.loadGitLog(ctx, workspaceId, 40);
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  requests.length = 0;
  fail = true;
  const first = store.refreshGitView(ctx, workspaceId, true);
  const second = store.refreshGitView(ctx, workspaceId);
  const settled = Promise.allSettled([first, second]);
  resolveStatus(failureMethod === "git.status" ? failure : { status: 200, body: { ok: true, ...historyStatus(), headCommit: "b".repeat(40) } });
  const results = await settled;
  assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
  for (const result of results) if (result.status === "rejected") assert.match(result.reason.message, /refresh failed/);
  assert.equal(requests.filter(request => request.method === "git.log").length, failureMethod === "git.status" ? 0 : 1);
  assert.equal(store.gitStatusLoading || store.gitLogLoading, false);
  assert.equal(store.gitLogEntries.length, 40);
  fail = false;
  const retry = store.refreshGitView(ctx, workspaceId, true);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus() } });
  await retry;
  assert.equal(store.gitLogError, null);
  assert.equal(store.gitLogEntries.length, 40);
});

for (const changed of ["repository", "identity"]) test(`${changed} 切换后回到原作用域，合并状态也不能复活旧刷新`, async t => {
  const resolvers: Array<(value: unknown) => void> = [], logs: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    if (request.method === "git.status") return new Promise(resolve => resolvers.push(resolve));
    logs.push(request);
    return { status: 200, body: { ok: true, entries: [{ hash: "current" }], total: 1 } };
  });
  store.viewMode = "log";
  store.gitStatus = historyStatus();
  const context = { ...ctx }, originalSession = context.webSessionId;
  const first = store.refreshGitView(context, workspaceId, true);
  if (changed === "repository") store.selectedGitRepositoryPath = "nested";
  else context.webSessionId = "other-session";
  const second = store.refreshGitView(context, workspaceId, true);
  if (changed === "repository") store.selectedGitRepositoryPath = "";
  else context.webSessionId = originalSession;
  const returned = store.refreshGitView(context, workspaceId, true);
  resolvers[0]!({ status: 200, body: { ok: true, ...historyStatus() } });
  await Promise.all([first, returned]);
  assert.equal(logs.length, 1);
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["current"]);
  resolvers[1]!({ status: 200, body: { ok: true, ...historyStatus("nested") } });
  await second;
  assert.equal(logs.length, 1);
  assert.equal(store.gitStatus?.repositoryPath, "");
  assert.equal(store.gitStatusLoading || store.gitLogLoading, false);
});

for (const cacheable of [true, false]) test(`状态刷新等待期间新增分页，返回后保留最新 60 条：可缓存=${cacheable}`, async t => {
  let resolveStatus!: (value: unknown) => void;
  const logs: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
    logs.push(request);
    return { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${Number(request.body?.skip) + index}` })) } };
  });
  store.viewMode = "log";
  store.gitStatus!.historyCacheable = cacheable;
  await store.loadGitLog(ctx, workspaceId, 40);
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  const refreshing = store.refreshGitView(ctx, workspaceId, true);
  await store.loadGitLog(ctx, workspaceId, 20, 40);
  assert.equal(store.gitLogEntries.length, 60);
  logs.length = 0;
  resolveStatus({ status: 200, body: { ok: true, isRepo: true, repositoryPath: "", repositories: [],
    staged: [], unstaged: [], untracked: [], headCommit: (cacheable ? "b" : "a").repeat(40), historyCacheable: cacheable } });
  await refreshing;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(logs.map(request => request.body?.maxCount), [60]);
  assert.equal(store.gitLogEntries.length, 60);
});

for (const cacheable of [true, false]) for (const pageBeforeRefresh of [true, false]) for (const pageFirst of [true, false]) {
  test(`并发分页刷新保留第三页：可缓存=${cacheable}，分页先发=${pageBeforeRefresh}，分页先回=${pageFirst}`, async t => {
    let resolveStatus!: (value: unknown) => void, resolvePage!: (value: unknown) => void;
    const logs: DesktopApiRequest[] = [];
    const store = fixture(t, async request => {
      if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
      logs.push(request);
      if (request.body?.skip === 40) return new Promise(resolve => { resolvePage = resolve; });
      return { status: 200, body: { ok: true, total: 80,
        entries: Array.from({ length: Number(request.body?.maxCount) }, (_, index) => ({ hash: `commit-${index}` })) } };
    });
    store.viewMode = "log";
    store.gitStatus = { ...historyStatus(), historyCacheable: cacheable };
    await store.loadGitLog(ctx, workspaceId, 40);
    mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
    await new Promise(resolve => setImmediate(resolve));
    const page = pageBeforeRefresh ? store.loadGitLog(ctx, workspaceId, 20, 40) : null;
    const refreshing = store.refreshGitView(ctx, workspaceId, true);
    const loadingMore = page ?? store.loadGitLog(ctx, workspaceId, 20, 40);
    logs.length = 0;
    const pageResponse = { status: 200, body: { ok: true, total: 80,
      entries: Array.from({ length: 20 }, (_, index) => ({ hash: `commit-${40 + index}` })) } };
    if (pageFirst) {
      resolvePage(pageResponse);
      await loadingMore;
      assert.equal(store.gitLogEntries.length, 60);
    }
    resolveStatus({ status: 200, body: { ok: true, ...historyStatus(),
      headCommit: (cacheable ? "b" : "a").repeat(40), historyCacheable: cacheable } });
    await refreshing;
    if (!pageFirst) {
      resolvePage(pageResponse);
      await loadingMore;
    }
    assert.deepEqual(logs.map(request => [request.body?.skip, request.body?.maxCount]), [[0, 60]]);
    assert.equal(store.gitLogEntries.length, 60);
    assert.equal(store.gitLogEntries.at(-1)?.hash, "commit-59");
    assert.equal(store.gitLogLoading, false);
    assert.equal(store.gitLogError, null);
  });
}

test("历史并发请求合并，同一 HEAD 重进保留已加载分页", async t => {
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => { requests.push(request); return { status: 200, body: { ok: true,
    entries: [{ hash: request.body?.skip ? "second" : "first" }], total: 2 } }; });
  await Promise.all([store.loadGitLog(ctx, workspaceId, 1), store.loadGitLog(ctx, workspaceId, 1)]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.body?.headCommit, "a".repeat(40));
  await store.loadGitLog(ctx, workspaceId, 1, 1);
  await store.loadGitLog(ctx, workspaceId, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["first", "second"]);
});

test("HEAD 改变后的迟到历史不覆盖新列表或 loading", async t => {
  const resolvers: Array<(value: unknown) => void> = [];
  const store = fixture(t, async () => new Promise(resolve => resolvers.push(resolve)));
  const old = store.loadGitLog(ctx, workspaceId);
  store.gitStatus!.headCommit = "b".repeat(40);
  const next = store.loadGitLog(ctx, workspaceId);
  resolvers[0]!({ status: 200, body: { ok: true, entries: [{ hash: "old" }], total: 1 } });
  await old;
  assert.equal(store.gitLogLoading, true);
  assert.equal(store.gitLogEntries.length, 0);
  resolvers[1]!({ status: 200, body: { ok: true, entries: [{ hash: "new" }], total: 1 } });
  await next;
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["new"]);
});

test("读取失败显式保留错误且允许同一 HEAD 重试", async t => {
  let calls = 0;
  const store = fixture(t, async () => ++calls === 1
    ? { status: 500, body: { ok: false, message: "history failed", code: "INTERNAL" } }
    : { status: 200, body: { ok: true, entries: [], total: 0 } });
  await assert.rejects(store.loadGitLog(ctx, workspaceId), /history failed/);
  assert.match(store.gitLogError!, /history failed/);
  await store.loadGitLog(ctx, workspaceId);
  assert.equal(store.gitLogError, null);
  await store.loadGitLog(ctx, workspaceId);
  assert.equal(calls, 2);
});

test("打开提交只读元数据，完整 diff 由显式操作读取", async t => {
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => { requests.push(request); return { status: 200, body: { ok: true,
    entry: { hash: "commit" }, files: [], diff: request.body?.includeDiff ? "patch" : "", diffLoaded: Boolean(request.body?.includeDiff) } }; });
  await store.loadGitCommitDetail(ctx, workspaceId, "commit");
  assert.equal(requests[0]!.body?.includeDiff, false);
  assert.equal(store.gitCommitDetail?.diffLoaded, false);
  await store.loadGitCommitDetail(ctx, workspaceId, "commit", true);
  assert.equal(store.gitCommitDetail?.diff, "patch");
});

test("返回列表后，迟到的完整 diff 不重新打开提交详情", async t => {
  let resolve!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(done => { resolve = done; }));
  store.gitCommitDetail = { entry: { hash: "commit" }, files: [], diff: "", diffLoaded: false } as never;
  const loading = store.loadGitCommitDetail(ctx, workspaceId, "commit", true);
  store.clearGitCommitDetail();
  resolve({ status: 200, body: { ok: true, entry: { hash: "commit" }, files: [], diff: "patch", diffLoaded: true } });
  await loading;
  assert.equal(store.gitCommitDetail, null);
  assert.equal(store.gitCommitDetailLoading, false);
});

for (const includeDiff of [false, true]) test(`读取指定提交期间 HEAD 更新仍展示响应：diff=${includeDiff}`, async t => {
  let resolve!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(done => { resolve = done; }));
  const loading = store.loadGitCommitDetail(ctx, workspaceId, "commit", includeDiff);
  store.gitStatus!.headCommit = "b".repeat(40);
  resolve({ status: 200, body: { ok: true, entry: { hash: "commit" }, files: [], diff: includeDiff ? "patch" : "", diffLoaded: includeDiff } });
  await loading;
  assert.equal(store.gitCommitDetail?.entry.hash, "commit");
  assert.equal(store.gitCommitDetail?.diffLoaded, includeDiff);
  assert.equal(store.gitCommitDetailLoading, false);
});

test("切换仓库后仍拒绝旧仓库的迟到详情", async t => {
  let resolve!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(done => { resolve = done; }));
  const loading = store.loadGitCommitDetail(ctx, workspaceId, "commit");
  store.selectedGitRepositoryPath = "other";
  resolve({ status: 200, body: { ok: true, entry: { hash: "commit" }, files: [], diff: "", diffLoaded: false } });
  await loading;
  assert.equal(store.gitCommitDetail, null);
});

test("快速切换 HEAD 后返回原 HEAD，仍能加载当前列表", async t => {
  const resolvers: Array<(value: unknown) => void> = [];
  const store = fixture(t, async () => new Promise(resolve => resolvers.push(resolve)));
  const first = store.loadGitLog(ctx, workspaceId);
  store.gitStatus!.headCommit = "b".repeat(40);
  const second = store.loadGitLog(ctx, workspaceId);
  store.gitStatus!.headCommit = "a".repeat(40);
  const returned = store.loadGitLog(ctx, workspaceId);
  for (const resolve of resolvers) resolve({ status: 200, body: { ok: true, entries: [{ hash: "current" }], total: 1 } });
  await Promise.all([first, second, returned]);
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["current"]);
  assert.equal(store.gitLogLoading, false);
});

test("已缓存 HEAD 切到新 HEAD 后返回，不能将清空的列表误判为原缓存", async t => {
  const resolvers: Array<(value: unknown) => void> = [];
  const store = fixture(t, async () => new Promise(resolve => resolvers.push(resolve)));
  const first = store.loadGitLog(ctx, workspaceId);
  resolvers[0]!({ status: 200, body: { ok: true, entries: [{ hash: "first" }], total: 1 } });
  await first;
  store.gitStatus!.headCommit = "b".repeat(40);
  const second = store.loadGitLog(ctx, workspaceId);
  store.gitStatus!.headCommit = "a".repeat(40);
  const returned = store.loadGitLog(ctx, workspaceId);
  for (const resolve of resolvers.slice(1)) resolve({ status: 200, body: { ok: true, entries: [{ hash: "first" }], total: 1 } });
  await Promise.all([second, returned]);
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["first"]);
  assert.equal(store.gitLogTotal, 1);
});

type HostNode = { type: string; props: Record<string, any>; children: HostNode[]; text: string; parent?: HostNode };

/** 编译并挂载真实模板，保留 watcher、事件和 Store，只隔离浏览器 DOM 与 UI 子组件。 */
function mountSfc(t: test.TestContext, file: string, props: Record<string, unknown>) {
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  /** 递归编译现有展示子组件，模板拆分不改变真实 watcher 与事件断言。 */
  function compileSfc(url: URL): vue.Component {
    const source = readFileSync(url, "utf8");
    const compiled = ts.transpileModule(compileScript(parse(source).descriptor, { id: url.href, inlineTemplate: true }).content,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} as { default: vue.Component } };
    new Function("require", "module", "exports", compiled)((id: string) => {
      if (id === "vue") return vue;
      if (id === "../../../store/explorer") return { useExplorerStore };
      if (id === "@codeflowai/shared") return { getPathDisplayInfo };
      if (id === "../../../utils/fileMetaPresentation") return fileMetaPresentation;
      if (id === "ant-design-vue") return { Modal: { confirm() { throw new Error("刷新不能触发 Git 写操作"); } } };
      if (id === "@ant-design/icons-vue") return new Proxy({}, { get: () => vue.defineComponent(() => () => null) });
      if (id === "./git-commit-form.vue") return { default: vue.defineComponent(() => () => null) };
      if (id.startsWith(".") && id.endsWith(".vue")) return { default: compileSfc(new URL(id, url)) };
      throw new Error(`unexpected SFC import: ${id}`);
    }, module, module.exports);
    return module.exports.default;
  }
  const create = (type: string): HostNode => ({ type, props: {}, children: [], text: "" });
  const renderer = vue.createRenderer<HostNode, HostNode>({
    createElement: create, createText: text => ({ ...create("text"), text }), createComment: () => create("comment"),
    setText: (node, text) => { node.text = text; }, setElementText: (node, text) => { node.text = text; },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, next) => { node.props[key] = next; },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node);
      node.parent = parent;
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); },
  });
  const root = create("root"), app = renderer.createApp(compileSfc(new URL(file, import.meta.url)), props);
  for (const tag of ["a-button", "a-spin", "a-tag", "a-alert", "a-checkbox", "a-directory-tree"]) {
    app.component(tag, vue.defineComponent({ setup: (_props, { slots, attrs }) => () => vue.h(tag, attrs, [slots.default?.(), slots.action?.()]) }));
  }
  const instance = app.mount(root);
  t.after(app.unmount);
  /** 读取真实渲染节点，检查按钮行为与错误提示。 */
  const find = (type: string, node = root): HostNode[] => [
    ...(node.type === type ? [node] : []), ...node.children.flatMap(child => find(type, child)),
  ];
  return { find, instance, unmount: () => app.unmount() };
}

for (const layout of ["flat", "tree"]) test(`真实 Git ${layout} 视图在后台复查期间保持无变更展示`, async t => {
  let resolveStatus!: (value: unknown) => void;
  const store = fixture(t, async () => new Promise(resolve => { resolveStatus = resolve; }));
  store._applyGitStatusSnapshot(workspaceId, historyStatus());
  const panel = mountSfc(t, "../src/features/explorer/components/git-changes-panel.vue", { workspaceId, ctx });
  (panel.instance as unknown as { layout: string }).layout = layout;
  await vue.nextTick();
  assert.ok(panel.find("span").some(node => node.text === "工作区无变更"));
  const refresh = store.refreshGitStatusCached(ctx, workspaceId);
  await vue.nextTick();
  assert.ok(panel.find("span").some(node => node.text === "工作区无变更"));
  assert.equal(panel.find("span").some(node => node.text === "加载中"), false);
  resolveStatus({ status: 200, body: { ok: true, ...historyStatus() } });
  await refresh;
  await vue.nextTick();
  assert.ok(panel.find("span").some(node => node.text === "工作区无变更"));
});

test("真实历史组件忽略相同 HEAD 的状态刷新和重挂载，HEAD 变化才重新读取", async t => {
  let calls = 0;
  const store = fixture(t, async () => { calls++; return { status: 200, body: { ok: true, entries: [], total: 0 } }; });
  store.gitStatus!.historyCacheable = true;
  const file = "../src/features/explorer/components/git-log-panel.vue";
  const panel = mountSfc(t, file, { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  store.gitStatus = { ...store.gitStatus! };
  await vue.nextTick();
  assert.equal(calls, 1);
  panel.unmount();
  mountSfc(t, file, { workspaceId, ctx });
  await vue.nextTick();
  assert.equal(calls, 1);
  store.gitStatus!.headCommit = "b".repeat(40);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
});

for (const completed of [false, true]) test(`浅库同 HEAD 补全历史后随状态刷新重读：完整库=${completed}`, async t => {
  let total = 1;
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    return { status: 200, body: { ok: true, entries: Array.from({ length: total }, (_, index) => ({ hash: `commit-${index}` })), total } };
  });
  store.gitStatus!.historyCacheable = false;
  const panel = mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.gitLogTotal, 1);
  total = 3;
  store.gitStatus = { ...store.gitStatus!, historyCacheable: completed };
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.gitLogTotal, 3);
  assert.equal(requests.length, 2);
  await store.loadGitLog(ctx, workspaceId, 20, 3);
  assert.equal(requests[2]!.body?.skip, 3);
  panel.unmount();
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, completed ? 3 : 4);
});

for (const staleFirst of [true, false]) test(`浅库历史在途时刷新同 HEAD 快照，旧响应不覆盖新历史：旧响应先返回=${staleFirst}`, async t => {
  const resolvers: Array<(value: unknown) => void> = [];
  const store = fixture(t, async request => {
    if (request.method === "git.status") return { status: 200, body: { ok: true, isRepo: true,
      repositoryPath: "", repositories: [], staged: [], unstaged: [], untracked: [],
      headCommit: "a".repeat(40), historyCacheable: false } };
    assert.equal(request.method, "git.log");
    return new Promise(resolve => { resolvers.push(resolve); });
  });
  await store.refreshGitStatus(ctx, workspaceId);
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 1);
  await store.refreshGitStatus(ctx, workspaceId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  for (const index of staleFirst ? [0, 1] : [1, 0]) {
    const total = index === 0 ? 1 : 3;
    resolvers[index]!({ status: 200, body: { ok: true, entries: [{ hash: `history-${total}` }], total } });
    await new Promise(resolve => setImmediate(resolve));
    if (staleFirst && index === 0) {
      assert.equal(store.gitLogTotal, 0);
      assert.equal(store.gitLogLoading, true);
    } else {
      assert.equal(store.gitLogTotal, 3);
      assert.equal(store.gitLogEntries[0]!.hash, "history-3");
      assert.equal(store.gitLogLoading, false);
    }
  }
});

test("浅库缓存快照失效在途分页，重读从首屏开始", async t => {
  const requests: DesktopApiRequest[] = [];
  const resolvers: Array<(value: unknown) => void> = [];
  const store = fixture(t, async request => {
    if (request.method === "git.status") return { status: 200, body: { ok: true, isRepo: true,
      repositoryPath: "", repositories: [], staged: [], unstaged: [], untracked: [],
      headCommit: "a".repeat(40), historyCacheable: false } };
    assert.equal(request.method, "git.log");
    requests.push(request);
    if (requests.length === 1) return { status: 200, body: { ok: true, entries: [{ hash: "old-first" }], total: 5 } };
    return new Promise(resolve => { resolvers.push(resolve); });
  });
  await store.refreshGitStatus(ctx, workspaceId);
  await store.loadGitLog(ctx, workspaceId, 20);
  const oldPage = store.loadGitLog(ctx, workspaceId, 20, 1);
  await store.refreshGitStatusCached(ctx, workspaceId);
  const reloaded = store.loadGitLog(ctx, workspaceId, 20, 1);
  assert.deepEqual(requests.map(request => request.body?.skip), [0, 1, 0]);
  resolvers[0]!({ status: 200, body: { ok: true, entries: [{ hash: "old-tail" }], total: 5 } });
  await oldPage;
  assert.equal(store.gitLogEntries.length, 0);
  assert.equal(store.gitLogLoading, true);
  resolvers[1]!({ status: 200, body: { ok: true, entries: [{ hash: "new-first" }], total: 3 } });
  await reloaded;
  assert.deepEqual(store.gitLogEntries.map(entry => entry.hash), ["new-first"]);
  assert.equal(store.gitLogTotal, 3);
  assert.equal(store.gitLogLoading, false);
});

test("切换独立仓库时等待新状态，不携带旧仓库 HEAD 请求历史", async t => {
  const logs: DesktopApiRequest[] = [];
  let resolveStatus!: (value: unknown) => void;
  const store = fixture(t, async request => {
    if (request.method === "git.status") return new Promise(resolve => { resolveStatus = resolve; });
    logs.push(request);
    return { status: 200, body: { ok: true, entries: [], total: 0 } };
  });
  store.gitStatus!.repositoryPath = "";
  mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  await new Promise(resolve => setImmediate(resolve));
  const switching = store.selectGitRepository(ctx, workspaceId, "nested");
  await vue.nextTick();
  assert.equal(logs.length, 1);
  resolveStatus({ status: 200, body: { ok: true, isRepo: true, repositoryPath: "nested", repositories: [],
    staged: [], unstaged: [], untracked: [], headCommit: "b".repeat(40) } });
  await switching;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 2);
  assert.equal(logs[1]!.body?.headCommit, "b".repeat(40));
  assert.equal(logs[1]!.body?.repositoryPath, "nested");
});

test("提交元数据失败提示再次点击提交，不能显示无效的重试历史操作", async t => {
  const store = fixture(t, async () => ({ status: 200, body: { ok: true, entries: [], total: 0 } }));
  store.gitCommitDetailError = "metadata failed";
  const panel = mountSfc(t, "../src/features/explorer/components/git-log-panel.vue", { workspaceId, ctx });
  assert.equal(panel.find("a-alert").length, 1);
  assert.match(panel.find("a-alert")[0]!.props.message, /再次点击提交/);
  assert.equal(panel.find("a-button").length, 0);
});

test("真实提交详情在明确点击后才发出完整差异读取事件", t => {
  let loads = 0;
  const detail = vue.reactive({ entry: { hash: "commit", parents: [], date: "2026-11-05" }, files: [], diff: "", diffLoaded: false });
  const panel = mountSfc(t, "../src/features/explorer/components/git-commit-detail.vue", { detail, onLoadDiff: () => loads++ });
  assert.equal(loads, 0);
  panel.find("a-button")[0]!.props.onClick();
  assert.equal(loads, 1);
});

/** 文件视图下写文件工具完成：Git 状态与文件树同步刷新；命令类工具只刷新 Git 状态。 */
test("文件视图工具完成后刷新 Git 状态与文件树", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    if (request.method === "git.status") return { status: 200, body: { ok: true, isRepo: true, repositoryPath: "",
      repositories: [], staged: [], unstaged: [], untracked: [], headCommit: "b".repeat(40), historyCacheable: true } };
    return { status: 200, body: { ok: true, nodes: [] } };
  });
  store.viewMode = "files";
  toolRefreshClient(t, store, "Write")();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.method).sort(), ["fs.tree", "git.status"]);

  requests.length = 0;
  toolRefreshClient(t, store)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.method), ["git.status"]);
});

/** 从未加载过 Git 状态时没有可见数据需要更新，文件写入只刷新文件树。 */
test("未加载 Git 状态时跳过 Git 请求，文件写入仍刷新文件树", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: DesktopApiRequest[] = [];
  const store = fixture(t, async request => {
    requests.push(request);
    return { status: 200, body: { ok: true, nodes: [] } };
  });
  store.viewMode = "files";
  store.gitStatus = null;
  toolRefreshClient(t, store, "Write")();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(request => request.method), ["fs.tree"]);

  requests.length = 0;
  toolRefreshClient(t, store)();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, []);
});

/** 后台刷新失败仍记录，但只有 Git 视图内才提示用户。 */
test("文件视图后台刷新失败不弹提示，Git 视图仍提示", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const surfaced: string[] = [];
  const store = fixture(t, async () => ({ status: 500, body: { ok: false, code: "INTERNAL", message: "refresh failed" } }));
  store.viewMode = "files";
  toolRefreshClient(t, store, "Bash", message => surfaced.push(message))();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(surfaced.length, 0);

  store.viewMode = "git";
  toolRefreshClient(t, store, "Bash", message => surfaced.push(message))();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(surfaced.length, 1);
  assert.match(surfaced[0]!, /refresh failed/u);
});
