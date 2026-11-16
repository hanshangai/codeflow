import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { DesktopEvent } from "@codeflowai/shared";

import { bindMainFrameEvents } from "../src/mainFrameEvents.js";

/** 控制真实事件生命周期，确认适配器只向当前可信主 frame 投递。 */
function fixture(url = "about:blank") {
  const sent: unknown[][] = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url, send: (...args: unknown[]) => { sent.push(args); } },
    isDestroyed: () => false, isLoadingMainFrame: () => false,
  });
  const listeners = new Set<(event: DesktopEvent) => void>();
  const event = { t: "conversation.event", event: { schema: 1, seq: 9, ts: 1000, workspaceId: "client:workspace",
    threadId: "thread-1", engine: "codex", type: "thread.started", payload: {} } } as DesktopEvent;
  return { contents, listeners, sent, event,
    subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** 只发当前真实订阅者，不存储历史事件。 */
    publish: () => { for (const listener of listeners) listener(event); },
  };
}

test("a canceled main navigation keeps the committed document subscribed until the next commit", () => {
  const f = fixture("codeflow://desktop/chat");
  const dispose = bindMainFrameEvents(f.contents, "codeflow://desktop/", f.subscribe);
  const previousListener = [...f.listeners][0];
  assert.ok(previousListener);
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(f.listeners.size, 1, "canceling navigation leaves the old document active");
  f.publish();
  assert.deepEqual(f.sent, [["desktop:event", f.event]]);
  f.contents.mainFrame = { url: "codeflow://desktop/next", send: (...args) => { f.sent.push(["current", ...args]); } };
  f.contents.emit("did-frame-navigate", {}, f.contents.mainFrame.url, -1, "", true, 1, 2);
  assert.equal(f.listeners.size, 1);
  assert.equal(f.listeners.has(previousListener), false, "a committed document replaces the old subscription");
  f.publish();
  assert.deepEqual(f.sent.at(-1), ["current", "desktop:event", f.event]);
  dispose();
});

test("a failed main navigation keeps delivering to the unchanged trusted document", () => {
  const f = fixture("codeflow://desktop/chat");
  const dispose = bindMainFrameEvents(f.contents, "codeflow://desktop/", f.subscribe);
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  f.contents.emit("did-fail-provisional-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://unavailable.invalid/", true, 1, 2);
  f.publish();
  assert.deepEqual(f.sent, [["desktop:event", f.event]]);
  assert.equal(f.listeners.size, 1);
  dispose();
});

test("main frame events bind at trusted document commit before page load and reset on main reload", () => {
  const f = fixture();
  const dispose = bindMainFrameEvents(f.contents, "codeflow://desktop/", f.subscribe);
  f.publish();
  assert.equal(f.listeners.size, 0);
  f.contents.mainFrame.url = "codeflow://desktop/chat";
  f.contents.emit("did-frame-navigate", {}, f.contents.mainFrame.url, 200, "OK", true, 1, 1);
  assert.equal(f.listeners.size, 1);
  f.contents.emit("did-frame-navigate", {}, "codeflow://desktop/iframe", 200, "OK", false, 1, 2);
  assert.equal(f.listeners.size, 1);
  f.publish();
  assert.deepEqual(f.sent, [["desktop:event", f.event]]);
  f.contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(f.listeners.size, 1);
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(f.listeners.size, 1);
  f.contents.mainFrame = { url: "codeflow://desktop/next", send: (...args) => { f.sent.push(["current", ...args]); } };
  f.contents.emit("did-frame-navigate", {}, f.contents.mainFrame.url, 200, "OK", true, 1, 1);
  f.publish();
  assert.deepEqual(f.sent.at(-1), ["current", "desktop:event", f.event]);
  dispose();
  dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.contents.listenerCount("did-frame-navigate"), 0);
  assert.equal(f.contents.listenerCount("did-start-navigation"), 0);
});

test("main frame events reject foreign pages and release subscriptions on destruction", () => {
  const f = fixture("codeflow://desktop/");
  bindMainFrameEvents(f.contents, "codeflow://desktop/", f.subscribe);
  assert.equal(f.listeners.size, 1, "an already loaded trusted page receives events");
  f.contents.mainFrame.url = "https://external.invalid/";
  assert.throws(f.publish, /DESKTOP_IPC_FORBIDDEN/);
  assert.deepEqual(f.sent, []);
  f.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  f.contents.emit("did-frame-navigate", {}, f.contents.mainFrame.url, 200, "OK", true, 1, 1);
  assert.equal(f.listeners.size, 0, "foreign document does not subscribe");
  f.contents.mainFrame.url = "codeflow://desktop/";
  f.contents.emit("did-frame-navigate", {}, f.contents.mainFrame.url, 200, "OK", true, 1, 1);
  assert.equal(f.listeners.size, 1);
  f.contents.emit("destroyed");
  assert.equal(f.listeners.size, 0);
  assert.equal(f.contents.listenerCount("did-frame-navigate"), 0);
});

test("a newly created empty document remains unsubscribed until its trusted main navigation commits", () => {
  const f = fixture("");
  const dispose = bindMainFrameEvents(f.contents, "codeflow://desktop/", f.subscribe);
  assert.equal(f.listeners.size, 0);
  f.contents.mainFrame.url = "about:blank";
  f.contents.emit("did-frame-navigate", {}, "about:blank", -1, "", true, 1, 1);
  assert.equal(f.listeners.size, 0);
  f.contents.mainFrame.url = "codeflow://desktop/";
  f.contents.emit("did-frame-navigate", {}, "codeflow://desktop/", 200, "OK", true, 1, 1);
  assert.equal(f.listeners.size, 1);
  dispose();
});
