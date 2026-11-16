import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, nextTick } from "vue";
import { message } from "ant-design-vue";
import { useDesktopWindowControls } from "../src/composables/useDesktopWindowControls.ts";

/** 控制 preload 响应顺序，保留实际 Vue 生命周期和 ref 更新。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** 挂载真实 composable；仅隔离原生窗口和消息展示，不依赖浏览器 DOM。 */
function setup(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  let listener!: (state: { maximized: boolean }) => void;
  let released = 0;
  const calls: string[] = [], notices: unknown[] = [], logs: unknown[][] = [];
  const controls = {
    getState: async () => ({ maximized: false }),
    onStateChange(callback: typeof listener) { listener = callback; return () => { released += 1; }; },
    minimize: async () => { calls.push("minimize"); },
    toggleMaximize: async () => { calls.push("maximize"); return { maximized: true }; },
    close: async () => { calls.push("close"); },
    ...overrides,
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { windowControls: controls } } });
  t.mock.method(message, "error", (value: unknown) => { notices.push(value); });
  t.mock.method(console, "error", (...values: unknown[]) => { logs.push(values); });
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  let api!: ReturnType<typeof useDesktopWindowControls>;
  const app = renderer.createApp({ setup() { api = useDesktopWindowControls(); return () => null; } });
  t.after(() => {
    app.unmount();
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  app.mount({});
  return { api, controls, calls, notices, logs, emit: (maximized: boolean) => listener({ maximized }),
    unmount: () => app.unmount(), released: () => released };
}

for (const action of ["minimize", "toggleMaximize", "close"] as const) {
  for (const cause of [new Error("native action failed"), undefined, null, false, 0, ""]) {
    test(`${action} exposes failure and preserves ${String(cause)} without rejecting the click handler`, async t => {
      const f = setup(t, { [action]: async () => { throw cause; } });
      const result = await f.api[action]();
      assert.deepEqual(result, { ok: false, error: cause });
      assert.equal(f.notices.length, 1);
      assert.equal(f.logs.length, 1);
      assert.equal(f.api.maximized.value, false);
    });
  }
}

test("initial state failure is visible and does not block later window actions", async t => {
  const error = new Error("state failed");
  const f = setup(t, { getState: async () => { throw error; } });
  await nextTick();
  await nextTick();
  assert.equal(f.notices.length, 1);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(await f.api.minimize(), { ok: true });
  assert.deepEqual(f.calls, ["minimize"]);
});

test("subscription failure is handled explicitly and stops the initial read", async t => {
  let reads = 0;
  const f = setup(t, { onStateChange: () => { throw new Error("subscribe failed"); },
    getState: async () => { reads += 1; return { maximized: false }; } });
  await nextTick();
  assert.equal(f.notices.length, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(reads, 0);
});

test("native events win over delayed initial and action responses", async t => {
  const initial = deferred<{ maximized: boolean }>(), action = deferred<{ maximized: boolean }>();
  const f = setup(t, { getState: () => initial.promise, toggleMaximize: () => action.promise });
  f.emit(true);
  initial.resolve({ maximized: false });
  await nextTick();
  assert.equal(f.api.maximized.value, true);
  const result = f.api.toggleMaximize();
  f.emit(false);
  action.resolve({ maximized: true });
  assert.deepEqual(await result, { ok: true });
  assert.equal(f.api.maximized.value, false);
  assert.deepEqual(f.notices, []);
});

test("unmount releases subscription and prevents delayed state writes", async t => {
  const initial = deferred<{ maximized: boolean }>(), action = deferred<{ maximized: boolean }>();
  const f = setup(t, { getState: () => initial.promise, toggleMaximize: () => action.promise });
  const result = f.api.toggleMaximize();
  f.unmount();
  initial.resolve({ maximized: true });
  action.resolve({ maximized: true });
  f.emit(true);
  await result;
  await nextTick();
  assert.equal(f.released(), 1);
  assert.equal(f.api.maximized.value, false);
});

test("delayed action failure after unmount still fails without showing a stale toast", async t => {
  const action = deferred<void>(), error = new Error("late native failure");
  const f = setup(t, { close: () => action.promise });
  const result = f.api.close();
  f.unmount();
  action.reject(error);
  assert.deepEqual(await result, { ok: false, error });
  assert.deepEqual(f.notices, []);
  assert.equal(f.logs.length, 1);
});

test("successful controls report success and use the original native actions", async t => {
  const f = setup(t);
  await nextTick();
  assert.deepEqual(await f.api.minimize(), { ok: true });
  assert.deepEqual(await f.api.toggleMaximize(), { ok: true });
  assert.equal(f.api.maximized.value, true);
  assert.deepEqual(await f.api.close(), { ok: true });
  assert.deepEqual(f.calls, ["minimize", "maximize", "close"]);
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.logs, []);
});

test("diagnostics omit arbitrary native error fields while the caller keeps the original error", async t => {
  const error = Object.assign(new Error("native failure"), { token: "FAKE_TEST_SENTINEL" });
  const f = setup(t, { close: async () => { throw error; } });
  assert.deepEqual(await f.api.close(), { ok: false, error });
  assert.equal(JSON.stringify(f.logs).includes("FAKE_TEST_SENTINEL"), false);
  assert.equal((f.logs[0]![1] as { rootCause: unknown }).rootCause, "native failure");
});

test("subscription release failure is logged once and rethrown from its owning boundary", t => {
  const error = new Error("unsubscribe failed");
  const f = setup(t, { onStateChange: () => () => { throw error; } });
  t.mock.method(console, "warn", () => {});
  assert.throws(f.unmount, candidate => candidate === error);
  assert.equal(f.logs.length, 1);
  assert.equal((f.logs[0]![1] as { code: string }).code, "DESKTOP_WINDOW_SUBSCRIPTION_FAILED");
});
