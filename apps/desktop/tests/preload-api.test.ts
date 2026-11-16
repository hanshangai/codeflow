import test from "node:test";
import assert from "node:assert/strict";
import type { DesktopUpdateDiagnostics } from "@codeflowai/shared";

import { EventEmitter } from "node:events";
import { createDesktopBridge, subscribeDesktopEvents, subscribeFixedChannel } from "../src/preload.js";

test("bridge exposes only explicit desktop operations", async () => {
  const bridge = createDesktopBridge({
    getState: () => ({ status: "ready", requestId: null, releaseId: "local", errorCode: null }),
    openWindow: () => {},
    exit: async () => {},
    request: async (request) => ({ status: 200, body: { method: request.method } }),
    onEvent: () => () => {},
  });
  assert.deepEqual(Object.keys(bridge).sort(), ["exit", "getState", "onEvent", "openWindow", "request"]);
  assert.deepEqual(await bridge.getState(), { status: "ready", requestId: null, releaseId: "local", errorCode: null });
  assert.deepEqual(await bridge.request({ method: "workspaces.list" }), { status: 200, body: { method: "workspaces.list" } });
});

test("update capabilities remain optional and discard arguments, mutable references and action results", async () => {
  const snapshot = { deviceId: "current", operation: "idle", updateCheckFailure: { requestId: "update-1", rootCause: { code: "EIO" } } };
  const deps = { getState: () => ({ status: "ready" as const, requestId: null, releaseId: "local", errorCode: null }),
    openWindow() {}, exit() {}, request: async () => ({ status: 200, body: {} }), onEvent: () => () => {},
    async getUpdateState(...args: unknown[]) { assert.equal(args.length, 0); return snapshot; },
    async getUpdateDetails(...args: unknown[]) { assert.equal(args.length, 0); return snapshot; },
    async checkForUpdates(...args: unknown[]) { assert.equal(args.length, 0); return { releaseDir: "PRIVATE_PATH" }; } };
  const bridge = createDesktopBridge(deps as never) as unknown as Record<string, (...args: unknown[]) => Promise<any>>;
  assert.equal(typeof bridge.getUpdateState, "function"); assert.equal(typeof bridge.checkForUpdates, "function");
  assert.equal(typeof bridge.getUpdateDetails, "function");
  const state = await bridge.getUpdateState!({ deviceId: "other" });
  state.updateCheckFailure.rootCause.code = "MUTATED";
  assert.equal(snapshot.updateCheckFailure.rootCause.code, "EIO");
  const details = await bridge.getUpdateDetails!({ deviceId: "other", force: true });
  details.updateCheckFailure.rootCause.code = "MUTATED_DETAILS";
  assert.equal(snapshot.updateCheckFailure.rootCause.code, "EIO");
  assert.equal(await bridge.checkForUpdates!({ force: true, path: "PRIVATE_PATH" }), undefined);
});

test("directory capability preserves selection, cancellation and rejection without exposing arbitrary IPC", async () => {
  let result: string | null = "C:\\chosen";
  let failure: Error | undefined;
  const bridge = createDesktopBridge({
    getState: () => ({ status: "ready", requestId: null, releaseId: "local", errorCode: null }),
    openWindow() {}, exit() {}, request: async () => ({ status: 200, body: {} }), onEvent: () => () => {},
    selectDirectory: async (initialPath?: string) => {
      assert.equal(initialPath, "C:\\project");
      if (failure) throw failure;
      return result;
    },
  });
  const pick = bridge.selectDirectory;
  assert.equal(typeof pick, "function");
  assert.equal(await pick!("C:\\project"), "C:\\chosen");
  result = null;
  assert.equal(await pick!("C:\\project"), null);
  failure = new Error("NATIVE_DIALOG_FAILED");
  await assert.rejects(pick!("C:\\project"), error => error === failure);
  assert.equal("ipcRenderer" in bridge, false);
});

for (const cause of [false, null, undefined, 0, "", new Error("original")]) test(`update capabilities retain rejection ${String(cause)}`, async () => {
  const bridge = createDesktopBridge({ getState: () => ({ status: "ready", requestId: null, releaseId: "local", errorCode: null }),
    openWindow() {}, exit() {}, request: async () => ({ status: 200, body: {} }), onEvent: () => () => {},
    getUpdateState: async () => { throw cause; }, getUpdateDetails: async () => { throw cause; }, checkForUpdates: async () => { throw cause; } } as never) as unknown as Record<string, () => Promise<unknown>>;
  assert.equal(typeof bridge.getUpdateState, "function"); assert.equal(typeof bridge.checkForUpdates, "function");
  await assert.rejects(bridge.getUpdateState!(), error => error === cause);
  await assert.rejects(bridge.getUpdateDetails!(), error => error === cause);
  await assert.rejects(bridge.checkForUpdates!(), error => error === cause);
});

test("diagnostics capability provides a deep snapshot and preserves falsy rejection", async () => {
  const snapshot: DesktopUpdateDiagnostics = { deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", failures: [{ reported: false, record: {
    schemaVersion: 1, kind: "failure", deviceId: "868683b1-e79b-4509-9ca1-97b7786e5344", errorId: "232634a4-66f8-4b07-9c5f-956c706a7a29",
    at: "2026-11-02T00:00:00.000Z", requestId: "update-1", errorCode: "DESKTOP_RELEASE_FAILED", releaseId: "next",
    shellVersion: "1.0.0", currentReleaseId: "installation", webVersion: "1.0.0", clientVersion: "1.0.0", phase: "verify", recovery: "not_needed",
    rootCause: { name: "Error", code: "EIO", causes: [{ name: "Error", code: "EACCES" }] }, rollbackError: null, payloadSha256: "a".repeat(64),
  } }] };
  let failure: { cause: unknown } | undefined;
  const deps = {
    getState: () => ({ status: "ready" as const, requestId: null, releaseId: "local", errorCode: null }),
    openWindow() {}, exit() {}, request: async () => ({ status: 200, body: {} }), onEvent: () => () => {},
    getUpdateDiagnostics: async () => { if (failure) throw failure.cause; return snapshot; },
  };
  const bridge = createDesktopBridge(deps);
  const get = (bridge as { getUpdateDiagnostics?: () => Promise<DesktopUpdateDiagnostics> }).getUpdateDiagnostics;
  assert.equal(typeof get, "function", "preload must expose diagnostics only when provided");
  const result = await get!();
  result.failures[0]!.record.rootCause.causes![0]!.code = "MUTATED";
  assert.equal(snapshot.failures[0]!.record.rootCause.causes![0]!.code, "EACCES");
  failure = { cause: false };
  await assert.rejects(get!(), error => error === false);
});

test("bridge exposes window controls only when the shell provides them", async () => {
  const calls: string[] = [];
  const bridge = createDesktopBridge({
    getState: () => ({ status: "ready", requestId: null, releaseId: "local", errorCode: null }),
    openWindow: () => {}, exit: async () => {},
    request: async () => ({ status: 200, body: {} }), onEvent: () => () => {},
    windowControls: {
      minimize: async () => { calls.push("minimize"); },
      toggleMaximize: async () => { calls.push("toggle"); return { maximized: true }; },
      close: async () => { calls.push("close"); },
      getState: async () => { calls.push("get"); return { maximized: false }; },
      onStateChange: (listener) => { listener({ maximized: true }); return () => { calls.push("dispose"); }; },
    },
  });
  assert.deepEqual(Object.keys(bridge).sort(), ["exit", "getState", "onEvent", "openWindow", "request", "windowControls"]);
  assert.deepEqual(await bridge.windowControls!.getState(), { maximized: false });
  await bridge.windowControls!.minimize();
  assert.deepEqual(await bridge.windowControls!.toggleMaximize(), { maximized: true });
  await bridge.windowControls!.close();
  const dispose = bridge.windowControls!.onStateChange(() => { calls.push("state"); });
  dispose();
  assert.deepEqual(calls, ["get", "minimize", "toggle", "close", "state", "dispose"]);
});

test("preload event subscription exposes only payload on the fixed channel and removes its own listener", () => {
  const ipc = new EventEmitter();
  const received: unknown[][] = [];
  const event = { t: "conversation.event", event: { seq: 9 } };
  const bridge = createDesktopBridge({
    getState: () => ({ status: "ready", requestId: null, releaseId: "local", errorCode: null }),
    request: async () => ({ status: 200, body: {} }), openWindow: () => {}, exit: () => {},
    onEvent: (listener) => subscribeDesktopEvents(ipc, listener),
  });
  const remove = bridge.onEvent!((...args) => { received.push(args); });
  assert.equal(ipc.listenerCount("desktop:event"), 1);
  ipc.emit("arbitrary:channel", { sender: "raw" }, event);
  ipc.emit("desktop:event", { sender: "raw", reply: () => assert.fail("raw IPC exposed") }, event);
  assert.deepEqual(received, [[event]]);
  remove();
  remove();
  assert.equal(ipc.listenerCount("desktop:event"), 0);
  ipc.emit("desktop:event", {}, event);
  assert.deepEqual(received, [[event]]);
});

test("fixed channel subscription strips the event argument and removes the same listener", () => {
  const ipc = new EventEmitter();
  const received: { maximized: boolean }[] = [];
  const remove = subscribeFixedChannel(ipc, "desktop:window-state", state => { received.push(state); });
  ipc.emit("other:channel", {}, { maximized: false });
  ipc.emit("desktop:window-state", { sender: "raw" }, { maximized: true });
  assert.deepEqual(received, [{ maximized: true }]);
  remove();
  remove();
  assert.equal(ipc.listenerCount("desktop:window-state"), 0);
  ipc.emit("desktop:window-state", {}, { maximized: false });
  assert.deepEqual(received, [{ maximized: true }]);
});
