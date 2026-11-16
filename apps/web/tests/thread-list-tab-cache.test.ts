import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import type { DesktopApiRequest, ThreadListScope, ThreadSummary, WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../src/api/request.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useOrchestrationStore } from "../src/store/orchestration.ts";
import { useUiStore } from "../src/store/ui.ts";

/** 仅替换网络或 preload，真实 Store 和 API 保留分类、分页与鉴权作用域。 */
function fixture(t: test.TestContext, desktop = false) {
  setActivePinia(createPinia());
  const chat = useChatStore(), ui = useUiStore(), config = useConfigStore(), orch = useOrchestrationStore();
  chat.resetForWorkspace();
  const workspaceId = "cache-client:workspace" as WorkspaceId;
  config.workspaceId = workspaceId;
  const ctx: ApiRequestContext = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "cache-session",
    webSessionId: "cache-web", ensureSession: async () => "cache-session", clearSession() {},
    ...(desktop ? { desktopClientId: "cache-client" } : {}),
  };
  const requests: Array<{ method: string; body: Record<string, any> }> = [];
  let failure: string | null = null;
  let groupIds: string[] = [];
  let pause: { method: string; ready: () => void; wait: Promise<void> } | null = null;
  /** 返回各分类可区分的真实摘要响应，归档使用空列表验证已加载状态。 */
  const respond = (method: string, body: Record<string, any>) => {
    requests.push({ method, body });
    if (failure === method) return { ok: false, message: "synthetic list failure" };
    if (method === "threads.groups.list") return { ok: true, groups: groupIds.map(id => ({
      id, workspaceId, name: id, sharedWorkspaceId: null, createdByUserId: null, createdAt: 1, updatedAt: 1,
    })) };
    if (method === "orch.instances.list") return { ok: true, instances: [], totalCountByIntake: {}, hasMore: false, nextCursor: null };
    assert.equal(method, "threads.list");
    const scope = body.scope ?? "current";
    const thread: ThreadSummary = { id: `${scope}-${body.cursor ?? "first"}`, title: `${scope}-${body.search ?? ""}`,
      engine: "codex", threadType: scope === "orchestration" ? "orchestration" : "chat",
      threadSubtype: scope === "knowledge" ? "knowledge-conversation" : null,
      createdAt: 1, updatedAt: 1, archived: false, groupId: body.groupId === "ungrouped" ? null : body.groupId ?? null };
    return { ok: true, threads: scope === "archived" || body.groupId === "ungrouped" && groupIds.length ? [] : [thread],
      hasMore: scope === "current" && !body.cursor, nextCursor: scope === "current" && !body.cursor ? "second" : null };
  };
  /** 可延后真实 API 响应，复现分类切换期间的在途请求。 */
  const transport = async (method: string, body: Record<string, any>) => {
    const response = respond(method, body);
    if (pause?.method === method) {
      const pending = pause;
      pause = null;
      pending.ready();
      await pending.wait;
    }
    return response;
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  if (desktop) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
      getState: async () => ({ status: "ready" }),
      request: async (request: DesktopApiRequest) => ({ status: 200, body: await transport(request.method, request.body ?? {}) }),
    } } });
    config.desktopRuntime = { status: "ready", requestId: "cache-runtime", releaseId: null, errorCode: null };
    config.desktopClient = { clientId: "cache-client", name: "test", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  }
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(desktop, false, "本机缓存读取不能访问 Server");
    const url = new URL(String(input));
    const method = url.pathname === "/api/threads" ? "threads.list"
      : url.pathname === "/api/threads/groups" ? "threads.groups.list" : "orch.instances.list";
    return new Response(JSON.stringify(await transport(method, Object.fromEntries(url.searchParams))), { headers: { "content-type": "application/json" } });
  });
  t.after(() => {
    chat.resetForWorkspace();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
  });
  return { chat, ui, orch, config, ctx, workspaceId, requests,
    fail(method: string | null) { failure = method; },
    /** 模拟另一窗口维护分组；删除后原会话归入未分组。 */
    setGroupIds(ids: string[]) { groupIds = ids; },
    /** 暂停一次指定读取，让测试自行决定旧响应到达顺序。 */
    pauseNext(method: string) {
      let ready!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      pause = { method, ready, wait };
      return { started, release };
    },
    /** 模拟分类 watcher，只在首次访问时请求，普通刷新仍走原入口。 */
    activate(scope: ThreadListScope) {
      ui.setThreadFilterTab(scope);
      return chat.refreshThreads(ctx, workspaceId, { preferCache: true });
    },
  };
}

for (const desktop of [true, false]) test(`${desktop ? "桌面" : "Web"} 分类往返复用列表和分页游标，空分类不反复请求`, async t => {
  const f = fixture(t, desktop);
  await f.activate("current");
  await f.chat.loadMoreThreads(f.ctx, f.workspaceId);
  const loaded = f.chat.threads.map(thread => thread.id);
  for (const scope of ["orchestration", "knowledge", "archived"] as const) await f.activate(scope);
  const count = f.requests.length;
  await f.activate("current");
  assert.deepEqual(f.chat.threads.map(thread => thread.id), loaded);
  assert.equal(f.chat.threadsHasMore, false);
  assert.equal(f.chat.threadsNextCursor, null);
  await f.activate("archived");
  assert.deepEqual(f.chat.threads, []);
  assert.equal(f.requests.length, count);
});

for (const desktop of [true, false]) test(`${desktop ? "桌面" : "Web"} 空会话分组列表成功后复用，手动刷新仍读取最新分组`, async t => {
  const f = fixture(t, desktop);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  await f.activate("knowledge");
  await f.activate("current");
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.filter(request => request.method === "threads.groups.list").length, 1);
  assert.equal(f.chat.threadGroupsLoading, false);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId);
  assert.equal(f.requests.filter(request => request.method === "threads.groups.list").length, 2);
});

test("会话分组的同作用域并发读取合并，账号和工作区重置后重新读取", async t => {
  const f = fixture(t);
  const paused = f.pauseNext("threads.groups.list");
  const pending = f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  await paused.started;
  const second = f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  paused.release();
  await Promise.all([pending, second]);
  assert.equal(f.requests.length, 1);
  await f.chat.refreshThreadGroups({ ...f.ctx, webSessionId: "new-account" }, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 2);
  f.chat.resetThreadGroupState();
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 3);
});

test("会话分组重置后立即重试不复用旧请求，旧响应不结束新请求加载态", async t => {
  const f = fixture(t);
  const firstPause = f.pauseNext("threads.groups.list");
  const first = f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  await firstPause.started;
  f.chat.resetThreadGroupState();
  const secondPause = f.pauseNext("threads.groups.list");
  const second = f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  await secondPause.started;
  firstPause.release();
  await first;
  assert.equal(f.chat.threadGroupsLoading, true);
  secondPause.release();
  await second;
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 2);
});

test("会话分组刷新失败使缓存失效，后续访问仍失败并可恢复", async t => {
  const f = fixture(t);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  f.fail("threads.groups.list");
  await assert.rejects(f.chat.refreshThreadGroups(f.ctx, f.workspaceId), /synthetic list failure/);
  await assert.rejects(f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true }), /synthetic list failure/);
  f.fail(null);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 4);
});

test("读取到外部分组删除后，未分组会话缓存失效并展示刚转入的会话", async t => {
  const f = fixture(t);
  f.setGroupIds(["group"]);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId);
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { groupId: "ungrouped", preferCache: true });
  assert.equal(f.chat.threads.length, 0);
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { groupId: null, preferCache: true });
  f.setGroupIds([]);
  await f.chat.refreshThreadGroups(f.ctx, f.workspaceId);
  assert.equal(f.chat.activeThreadGroupId, null);
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { groupId: "ungrouped", preferCache: true });
  assert.deepEqual(f.chat.threads.map(thread => thread.id), ["current-first"]);
  assert.equal(f.requests.length, 5);
});

test("手动刷新和删除事件使其它分类缓存失效", async t => {
  const f = fixture(t);
  await f.activate("current");
  await f.activate("archived");
  f.chat.handleThreadChangedFromServer({ workspaceId: f.workspaceId, threadId: "current-first", kind: "deleted" });
  await f.activate("current");
  assert.equal(f.requests.length, 3);
  await f.chat.refreshThreads(f.ctx, f.workspaceId);
  assert.equal(f.requests.length, 4);
  await f.activate("archived");
  assert.equal(f.requests.length, 5);
});

test("列表缓存按搜索、分组、排序和登录会话隔离，工作区重置后不复用", async t => {
  const f = fixture(t);
  await f.activate("current");
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { search: "needle", preferCache: true });
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { search: "", groupId: "group", preferCache: true });
  f.ui.setThreadListSort("title_asc");
  await f.chat.refreshThreads(f.ctx, f.workspaceId, { preferCache: true });
  await f.chat.refreshThreads({ ...f.ctx, webSessionId: "another-session" }, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 5);
  f.chat.resetForWorkspace();
  await f.activate("current");
  assert.equal(f.requests.length, 6);
});

test("首次列表失败显式拒绝且不缓存，恢复后允许重新加载", async t => {
  const f = fixture(t);
  f.fail("threads.list");
  await assert.rejects(f.activate("knowledge"), /synthetic list failure/);
  await assert.rejects(f.activate("knowledge"), /synthetic list failure/);
  f.fail(null);
  await f.activate("knowledge");
  await f.activate("knowledge");
  assert.equal(f.requests.length, 3);
});

test("流程树空摘要也缓存，手动刷新和工作区重置仍重新请求", async t => {
  const f = fixture(t);
  await f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  await f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 2, "需求与定时实例各读取一次");
  await f.orch.refreshInstances(f.ctx, f.workspaceId);
  assert.equal(f.requests.length, 4);
  f.orch.resetForWorkspace(f.workspaceId);
  await f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 6);
});

test("列表与流程树按共享可见范围及账号隔离，切换后读取对应数据", async t => {
  const f = fixture(t);
  const workspaceId = "shared:cache-workspace" as WorkspaceId;
  for (const onlyRelatedToMe of [true, false]) {
    await f.chat.refreshThreads(f.ctx, workspaceId, { onlyRelatedToMe, preferCache: true });
    await f.orch.refreshInstances(f.ctx, workspaceId, { onlyRelatedToMe, preferCache: true });
    await f.orch.refreshInstances(f.ctx, workspaceId, { onlyRelatedToMe, preferCache: true });
  }
  assert.equal(f.requests.length, 6);
  assert.equal(f.requests[0]?.body.onlyRelatedToMe, "true");
  assert.equal(f.requests[3]?.body.onlyRelatedToMe, "false");
  await f.chat.refreshThreads(f.ctx, workspaceId, { onlyRelatedToMe: true, preferCache: true });
  assert.equal(f.requests.length, 6, "共享范围恢复原列表缓存");
  await f.orch.refreshInstances({ ...f.ctx, webSessionId: "other-account" }, workspaceId, { onlyRelatedToMe: false, preferCache: true });
  assert.equal(f.requests.length, 8);
});

for (const desktop of [true, false]) test(`${desktop ? "桌面" : "Web"} 缓存命中会取消另一分类的读取，迟到响应不覆盖当前列表`, async t => {
  const f = fixture(t, desktop);
  await f.activate("current");
  const paused = f.pauseNext("threads.list");
  const pending = f.activate("knowledge");
  await paused.started;
  await f.activate("current");
  paused.release();
  await pending;
  assert.deepEqual(f.chat.threads.map(thread => thread.id), ["current-first"]);
  assert.equal(f.requests.length, 2);
  await f.activate("knowledge");
  assert.equal(f.requests.length, 3, "取消的响应不能写入缓存");
});

test("分页取消后立即切回可重试同一游标，旧页不污染缓存", async t => {
  const f = fixture(t);
  await f.activate("current");
  const paused = f.pauseNext("threads.list");
  const pending = f.chat.loadMoreThreads(f.ctx, f.workspaceId);
  await paused.started;
  await f.activate("archived");
  await f.activate("current");
  const retry = f.chat.loadMoreThreads(f.ctx, f.workspaceId);
  paused.release();
  await Promise.all([pending, retry]);
  assert.deepEqual(f.chat.threads.map(thread => thread.id), ["current-first", "current-second"]);
  assert.equal(f.requests.length, 4);
});

test("恢复列表不会回放旧运行提示，元数据变更后重新加载分类", async t => {
  const f = fixture(t);
  await f.activate("current");
  f.chat.selectedThreadId = "current-first";
  await f.activate("knowledge");
  f.chat.setThreadRunningHint("current-first", { runningTurnId: "live-turn", runningTurnStartedAt: 123 });
  await f.activate("current");
  assert.equal(f.chat.threadRunningHintByThreadId["current-first"]?.running?.runningTurnId, "live-turn");
  assert.equal(f.requests.length, 2);
  f.chat.upsertThreadSummary({ ...f.chat.threads[0]!, title: "changed" });
  await f.activate("knowledge");
  assert.equal(f.requests.length, 3);
});

test("远端删除事件使旧列表请求失效后，仍能继续读取下一页", async t => {
  const f = fixture(t);
  await f.activate("current");
  f.chat.handleThreadChangedFromServer({ workspaceId: f.workspaceId, threadId: "current-first", kind: "deleted" });
  await f.chat.loadMoreThreads(f.ctx, f.workspaceId);
  assert.deepEqual(f.chat.threads.map(thread => thread.id), ["current-second"]);
  assert.equal(f.requests.length, 2);
});

test("刷新失败后旧分类缓存失效，后续访问仍显式失败并可重试", async t => {
  const f = fixture(t);
  await f.activate("current");
  await f.activate("knowledge");
  f.fail("threads.list");
  await assert.rejects(f.chat.refreshThreads(f.ctx, f.workspaceId), /synthetic list failure/);
  await assert.rejects(f.activate("current"), /synthetic list failure/);
  f.fail(null);
  await f.activate("current");
  assert.equal(f.requests.length, 5);
});

test("流程事件在实例列表读取期间到达时，不把旧响应标记为可复用", async t => {
  const f = fixture(t);
  const paused = f.pauseNext("orch.instances.list");
  const pending = f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  await paused.started;
  await f.orch.onOrchestrationEvent(f.ctx, f.workspaceId, {
    id: "event-1", instanceId: "new-instance", type: "orchestration.started", createdAt: 2, payloadJson: "{}",
  }, { hydrateUnknownInstance: false });
  paused.release();
  await pending;
  await f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 4);
});

test("流程树失败不标记已加载，重试失败仍向上传播", async t => {
  const f = fixture(t);
  f.fail("orch.instances.list");
  await assert.rejects(f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true }), /synthetic list failure/);
  await assert.rejects(f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true }), /synthetic list failure/);
  f.fail(null);
  await f.orch.refreshInstances(f.ctx, f.workspaceId, { preferCache: true });
  assert.equal(f.requests.length, 6);
});
