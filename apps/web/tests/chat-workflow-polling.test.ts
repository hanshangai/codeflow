import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import type { ChatWorkflowSnapshot } from "@codeflowai/shared";
import { chatWorkflowPollDelay } from "../src/features/chat/chatWorkflowPolling.ts";
import { getChatWorkflow } from "../src/api/chatWorkflow.ts";
import { createApiResultError, isCancelledRequestError } from "../src/api/request.ts";

test("工作流查询后台暂停，空闲降频，升级拒绝停止，普通失败退避", () => {
  const input = { visible: true, snapshot: { recommendationEnabled: false, tasks: [] } as ChatWorkflowSnapshot, errorCode: null as string | null, failures: 0 };
  assert.equal(chatWorkflowPollDelay(input), 30_000);
  assert.equal(chatWorkflowPollDelay({ ...input, visible: false }), null);
  assert.equal(chatWorkflowPollDelay({ ...input, errorCode: "CLIENT_UPGRADE_REQUIRED", failures: 5 }), null);
  assert.equal(chatWorkflowPollDelay({ ...input, errorCode: "INTERNAL_ERROR", failures: 5 }), 60_000);
  for (const [failures, delay] of [[1, 10_000], [2, 20_000], [3, 40_000], [4, 60_000], [20, 60_000]]) {
    assert.equal(chatWorkflowPollDelay({ ...input, failures }), delay);
  }
});

test("面板取消查询后，迟到的工作流成功响应按取消处理", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let release!: (response: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = (async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    started();
    return await new Promise<Response>(resolve => { release = resolve; });
  }) as typeof fetch;
  try {
    const result = getChatWorkflow({ serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "test", webSessionId: "web" }, "ws", "thread", controller.signal);
    const rejected = assert.rejects(result, isCancelledRequestError);
    await requestStarted;
    controller.abort();
    release(new Response(JSON.stringify({ ok: true, recommendationEnabled: false, tasks: [] })));
    await rejected;
  } finally { globalThis.fetch = originalFetch; }
});

/** 执行面板真实轮询和已注册 watcher，用可控请求验证状态变化与生命周期。 */
function pollingHarness() {
  const source = readFileSync(new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url), "utf8");
  const start = source.indexOf("function invalidateCurrentRefresh(");
  const end = source.indexOf("async function action(", start);
  assert.ok(start >= 0 && end > start);
  const watchers: Array<{ read: () => any; changed: (...args: any[]) => void; value: any }> = [];
  const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void; reject: (cause: unknown) => void }> = [];
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const lifecycle: Record<string, () => void> = {};
  const snapshots: ChatWorkflowSnapshot[] = [];
  const warnings: unknown[] = [];
  const client = { connectedAt: 1 };
  let timerId = 0;
  const context = {
    AbortController, createApiResultError, isCancelledRequestError, chatWorkflowPollDelay,
    document: {
      hidden: false,
      /** 记录面板实际注册的可见性监听，供前后台测试触发。 */
      addEventListener(event: string, callback: () => void) { if (event === "visibilitychange") lifecycle.visibilityChanged = callback; },
      removeEventListener() {},
    },
    props: { workspaceId: "ws", threadId: "thread", replyRunning: false },
    presence: { clientForWorkspace: () => client, runtimeStateForWorkspace: () => ({ status: "online" }) },
    config: { connectionStatus: "connected" }, ctx: { value: {} },
    snapshot: { value: { recommendationEnabled: false, tasks: [] } }, error: { value: "" }, busy: { value: false },
    feedback: { value: {} }, branches: { value: {} }, reworkTask: { value: null }, expandedTaskIds: { value: new Set() },
    // 切换会话/线程时会清空节点详情弹层；这里只需要一个可写桩。
    stageDetail: { value: null },
    chat: { threadWorkflowByThreadId: {}, setChatWorkflowSnapshot: (_id: string, value: ChatWorkflowSnapshot) => snapshots.push(value) },
    console: { warn: (...args: unknown[]) => warnings.push(args) }, ticker: 0,
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id), clearInterval() {},
    watch: (read: () => any, changed: (...args: any[]) => void, options?: { immediate?: boolean }) => {
      const value = read();
      watchers.push({ read, changed, value });
      if (options?.immediate) changed(value);
    },
    onMounted: (callback: () => void) => { lifecycle.mounted = callback; },
    onActivated: (callback: () => void) => { lifecycle.activated = callback; },
    onDeactivated: (callback: () => void) => { lifecycle.deactivated = callback; },
    onUnmounted: (callback: () => void) => { lifecycle.unmounted = callback; },
    getChatWorkflow: (_ctx: unknown, _workspaceId: string, _threadId: string, signal: AbortSignal) =>
      new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
  };
  const state = "let generation = 0, refreshSequence = 0, timer, requestController = null, pollInFlight = false, pollAgain = false, failures = 0, failureCode = null, panelActive = true;\n";
  vm.runInNewContext(ts.transpileModule(state + source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  /** 只触发真实读取值已变化的 watcher，避免依赖注册顺序或伪造通知入口。 */
  function flushWatchers(): void {
    for (const watcher of watchers) {
      const value = watcher.read(), previous = watcher.value;
      if (isDeepStrictEqual(value, previous)) continue;
      watcher.value = value;
      watcher.changed(value, previous);
    }
  }
  return { context, client, requests, timers, lifecycle, snapshots, warnings, flushWatchers };
}

test("连接恢复隔离旧升级错误及迟到成功，且仅追加一次查询", async () => {
  for (const outcome of ["error-result", "rejection", "success"] as const) {
    const h = pollingHarness();
    assert.equal(h.requests.length, 1);
    const old = h.requests[0]!;
    h.client.connectedAt++;
    h.flushWatchers();
    assert.equal(old.signal.aborted, true);
    const error = { ok: false as const, code: "CLIENT_UPGRADE_REQUIRED" as const, message: "旧升级错误" };
    if (outcome === "rejection") old.reject(createApiResultError(error));
    else old.resolve(outcome === "success" ? { ok: true, recommendationEnabled: true, tasks: [] } : error);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 2);
    assert.equal(h.context.snapshot.value.recommendationEnabled, false);
    assert.equal(h.context.error.value, "");
    assert.equal(h.warnings.length, 0);
    h.requests[1]!.resolve({ ok: true, recommendationEnabled: false, tasks: [] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 2);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0]!.delay, 30_000);
    h.lifecycle.unmounted!();
    assert.equal(h.timers.size, 0);
  }
});

test("后台连接恢复等待重新激活，卸载隔离迟到响应且不再查询", async () => {
  const h = pollingHarness();
  h.lifecycle.deactivated!();
  h.client.connectedAt++;
  h.flushWatchers();
  assert.equal(h.requests[0]!.signal.aborted, true);
  h.requests[0]!.resolve({ ok: false, code: "CLIENT_UPGRADE_REQUIRED", message: "旧升级错误" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
  h.lifecycle.activated!();
  assert.equal(h.requests.length, 2);
  h.lifecycle.unmounted!();
  h.requests[1]!.resolve({ ok: true, recommendationEnabled: true, tasks: [] });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  assert.equal(h.context.snapshot.value.recommendationEnabled, false);
  assert.equal(h.timers.size, 0);
});

test("页面隐藏取消查询，回到前台重新核对且不采用后台迟到成功", async () => {
  const h = pollingHarness();
  h.lifecycle.mounted!();
  h.context.document.hidden = true;
  h.lifecycle.visibilityChanged!();
  assert.equal(h.requests[0]!.signal.aborted, true);
  h.requests[0]!.resolve({ ok: true, recommendationEnabled: true, tasks: [] });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.context.snapshot.value.recommendationEnabled, false);
  assert.equal(h.timers.size, 0);
  h.context.document.hidden = false;
  h.lifecycle.visibilityChanged!();
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve({ ok: true, recommendationEnabled: true, tasks: [] });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.context.snapshot.value.recommendationEnabled, true);
  assert.equal(h.timers.size, 1);
  h.lifecycle.unmounted!();
  assert.equal(h.timers.size, 0);
});

test("HTTP 升级要求停止轮询，在连接恢复后重新查询", async () => {
  const h = pollingHarness();
  h.requests[0]!.resolve({ ok: false, code: "CLIENT_UPGRADE_REQUIRED", message: "当前 Client 需要升级" });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 0);
  h.flushWatchers();
  assert.match(h.context.error.value, /需要升级/);
  assert.equal(h.timers.size, 0);
  h.lifecycle.activated!();
  assert.equal(h.requests.length, 1);
  h.flushWatchers();
  assert.equal(h.requests.length, 1);
  h.client.connectedAt++;
  h.flushWatchers();
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve({ ok: true, recommendationEnabled: false, tasks: [] });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.context.error.value, "");
  assert.equal([...h.timers.values()][0]!.delay, 30_000);
  h.lifecycle.unmounted!();
});

test("启动、执行和续跑中保持快速核对，终态恢复空闲频率", () => {
  for (const view of [
    { task: { state: "starting" } },
    { task: { state: "started" }, status: "running" },
    { task: { state: "dismissed" }, continuation: { status: "pending" } },
    { task: { state: "dismissed" }, continuation: { status: "sending" } },
  ]) {
    const snapshot = { recommendationEnabled: true, tasks: [view] } as ChatWorkflowSnapshot;
    assert.equal(chatWorkflowPollDelay({ visible: true, snapshot, errorCode: null, failures: 0 }), 4_000);
  }
  const snapshot = { recommendationEnabled: true, tasks: [{ task: { state: "started" }, status: "completed", continuation: { status: "sent" } }] } as unknown as ChatWorkflowSnapshot;
  assert.equal(chatWorkflowPollDelay({ visible: true, snapshot, errorCode: null, failures: 0 }), 30_000);
});
