import test from "node:test";
import assert from "node:assert/strict";
import { isProxy, reactive, toRaw } from "vue";
import type { DesktopApiRequest, DesktopApiResponse, DesktopBridgeApi } from "@codeflowai/shared";
import { isCancelledRequestError, requestJson } from "../src/api/request.ts";
import { requestDesktopApi } from "../src/services/desktop.ts";

/** 仅替换 preload 边界，同步克隆入参以复现 Electron 对 Proxy 的拒绝。 */
function installBoundary(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const calls = { bridge: 0, fetch: 0, session: 0 };
  const control = { respond: (_request: DesktopApiRequest): DesktopApiResponse | Promise<DesktopApiResponse> => ({ status: 200, body: { ok: true } }) };
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "process", releaseId: null, errorCode: null }),
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
    request: (request) => {
      calls.bridge++;
      const cloned = structuredClone(request);
      requests.push(cloned);
      return Promise.resolve(control.respond(cloned));
    },
  };
  Object.defineProperty(globalThis, "window", { value: { codeflowDesktop: bridge }, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls.fetch++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const ctx = { serverWsOrigin: "ws://server", sessionToken: null, webSessionId: null, desktopClientId: "local",
    ensureSession: async () => { calls.session++; return "test-session"; } };
  return { requests, calls, control, ctx };
}

test("本机验收数组跨桥前成为独立 JSON 数据，不改变 reactive 原对象", async (t) => {
  const h = installBoundary(t);
  const intake = reactive({ id: "intake", acceptanceCriteria: [{ id: "check", text: "交付结果可审阅" }] });
  const acceptanceCriteria = intake.acceptanceCriteria;
  assert.equal(isProxy(acceptanceCriteria), true);
  const body = { workspaceId: "local:ws", intakeId: intake.id, acceptanceCriteria };

  assert.deepEqual(await requestJson(h.ctx, { method: "POST", path: "/api/orch/intakes/upsert", body }), { ok: true });
  assert.deepEqual(h.requests, [{ method: "orch.intakes.upsert", body: {
    workspaceId: "local:ws", intakeId: "intake", acceptanceCriteria: [{ id: "check", text: "交付结果可审阅" }],
  } }]);
  assert.strictEqual(body.acceptanceCriteria, acceptanceCriteria);
  assert.strictEqual(intake.acceptanceCriteria, acceptanceCriteria);
  assert.deepEqual(toRaw(intake), { id: "intake", acceptanceCriteria: [{ id: "check", text: "交付结果可审阅" }] });
  assert.notStrictEqual(h.requests[0]!.body!.acceptanceCriteria, acceptanceCriteria);
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("本机普通嵌套 reactive 对象保持原草稿内容并可跨桥克隆", async (t) => {
  const h = installBoundary(t);
  const draft = reactive({ preferences: { engine: "codex", model: "test-model" }, text: "继续开发" });
  assert.equal(isProxy(draft.preferences), true);

  await requestJson(h.ctx, { method: "POST", path: "/api/threads/draft/save", body: { workspaceId: "local:ws", threadId: "thread", draft } });

  assert.deepEqual(h.requests, [{ method: "threads.draft.save", body: { workspaceId: "local:ws", threadId: "thread",
    draft: { preferences: { engine: "codex", model: "test-model" }, text: "继续开发" },
  } }]);
  assert.deepEqual(toRaw(draft), { preferences: { engine: "codex", model: "test-model" }, text: "继续开发" });
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("本机 JSON 数据与 HTTP 一致地省略对象 undefined 并将数组 undefined 转为 null", async (t) => {
  const h = installBoundary(t);
  const body = { workspaceId: "local:ws", omitted: undefined, nested: { keep: "值", omitted: undefined }, values: [undefined, "保留"] };

  await requestJson(h.ctx, { method: "POST", path: "/api/orch/intakes/upsert", body });

  assert.deepEqual(h.requests, [{ method: "orch.intakes.upsert", body: {
    workspaceId: "local:ws", nested: { keep: "值" }, values: [null, "保留"],
  } }]);
  assert.equal(Object.hasOwn(body, "omitted"), true);
  assert.equal(body.values[0], undefined);
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("无正文的本机 GET 保持原路由且不要求云端认证", async (t) => {
  const h = installBoundary(t);
  await requestJson(h.ctx, { method: "GET", path: "/api/workspaces" });
  assert.deepEqual(h.requests, [{ method: "workspaces.list" }]);
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("本机 BigInt 和循环引用序列化失败即中止，不调用桥接或 HTTP", async (t) => {
  const h = installBoundary(t);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [1n, cyclic]) {
    await assert.rejects(requestJson(h.ctx, { method: "POST", path: "/api/orch/intakes/upsert",
      body: { workspaceId: "local:ws", value } }), TypeError);
    assert.deepEqual(h.calls, { bridge: 0, fetch: 0, session: 0 });
  }
});

test("桥接同步和异步失败原样抛出，失败响应及畸形响应不会变成成功", async (t) => {
  const h = installBoundary(t);
  const failure = new Error("DESKTOP_API_TIMEOUT");
  const opts = { method: "GET", path: "/api/workspaces" } as const;
  h.control.respond = () => { throw failure; };
  await assert.rejects(requestJson(h.ctx, opts), (error) => error === failure);
  h.control.respond = () => Promise.reject(failure);
  await assert.rejects(requestJson(h.ctx, opts), (error) => error === failure);
  const response = { ok: false, code: "CONFLICT", message: "本机写入失败", details: { requestId: "failed-request" } };
  h.control.respond = () => ({ status: 409, body: response });
  assert.strictEqual(await requestJson(h.ctx, opts), response);
  h.control.respond = () => ({ status: 200, body: "invalid" });
  await assert.rejects(requestJson(h.ctx, opts), /DESKTOP_API_RESPONSE_INVALID/);
  assert.deepEqual(h.calls, { bridge: 4, fetch: 0, session: 0 });
});

test("已取消请求不进入桥接，等待中取消仍保留原作用域原因", async (t) => {
  const h = installBoundary(t);
  const controller = new AbortController();
  controller.abort("workspace-switch");
  await assert.rejects(requestJson(h.ctx, { method: "GET", path: "/api/workspaces", signal: controller.signal }),
    (error) => isCancelledRequestError(error) && error.kind === "workspace-switch");
  assert.deepEqual(h.calls, { bridge: 0, fetch: 0, session: 0 });
  let resolve!: (response: DesktopApiResponse) => void;
  h.control.respond = () => new Promise((done) => { resolve = done; });
  const pendingController = new AbortController();
  const pending = requestJson(h.ctx, { method: "GET", path: "/api/workspaces", signal: pendingController.signal });
  pendingController.abort("selection-change");
  await assert.rejects(pending, (error) => isCancelledRequestError(error) && error.kind === "selection-change");
  resolve({ status: 200, body: { ok: true } });
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("直接本机 helper 将 intake/envRefs reactive 草稿快照成独立 JSON DTO", async (t) => {
  const h = installBoundary(t);
  const payload = reactive({ intake: { goal: "保留目标", acceptanceCriteria: ["结果"] }, envRefs: ["PATH"], omitted: undefined });
  const intake = payload.intake;
  await requestDesktopApi({ method: "scheduledTasks.local.create", body: { payload } });
  assert.deepEqual(h.requests, [{ method: "scheduledTasks.local.create", body: { payload: {
    intake: { goal: "保留目标", acceptanceCriteria: ["结果"] }, envRefs: ["PATH"],
  } } }]);
  assert.strictEqual(payload.intake, intake);
  assert.equal(isProxy(payload.envRefs), true);
  assert.equal(Object.hasOwn(toRaw(payload), "omitted"), true);
  assert.deepEqual(h.calls, { bridge: 1, fetch: 0, session: 0 });
});

test("直接本机 helper 对循环和 BigInt 在派发前显式失败", async (t) => {
  const h = installBoundary(t);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [1n, cyclic]) {
    await assert.rejects(requestDesktopApi({ method: "scheduledTasks.local.create", body: { value } }), TypeError);
    assert.deepEqual(h.calls, { bridge: 0, fetch: 0, session: 0 });
  }
});
