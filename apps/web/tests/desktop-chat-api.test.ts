import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApiRequest } from "@codeflowai/shared";
import { requestJson, type ApiRequestContext } from "../src/api/request.ts";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";

const workspaceId = "desktop:project";
const ctx: ApiRequestContext = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
const operations = [
  ["/api/fs/extractAttachment", "fs.extractAttachment"],
  ["/api/threads/input-actions/list", "threads.inputActions.list"],
  ["/api/threads/file-changes/list", "threads.fileChanges.list"],
  ["/api/threads/file-changes/diff", "threads.fileChanges.diff"],
  ["/api/threads/file-changes/accept", "threads.fileChanges.accept"],
  ["/api/threads/file-changes/undo", "threads.fileChanges.undo"],
  ["/api/threads/rollback", "threads.rollback"],
  ["/api/threads/rollback/preview", "threads.rollback.preview"],
  ["/api/threads/messages/delete", "threads.messages.delete"],
  ["/api/threads/managed-services/list", "threads.managedServices.list"],
  ["/api/threads/managed-services/stop", "threads.managedServices.stop"],
  ["/api/threads/compact", "threads.compact"],
  ["/api/threads/clear", "threads.clear"],
  ["/api/orch/chat/get", "orch.chat.get"],
  ["/api/orch/chat/settings", "orch.chat.settings"],
  ["/api/orch/chat/action", "orch.chat.action"],
  ["/api/orch/chat/natural", "orch.chat.natural"],
  ["/api/orch/chat/rework", "orch.chat.rework"],
  ["/api/orch/chat/delete", "orch.chat.delete"],
] as const;

/** 隔离 preload；任何云端请求都会让本机路由测试失败。 */
function installBridge(t: test.TestContext, request: (input: DesktopApiRequest) => Promise<{ status: number; body: object }>): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({}), request } } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机会话能力不能转发到 Server"); });
}

test("本机会话完整操作复用 Client 路由，未登录也不请求云端会话", async t => {
  const actual: DesktopApiRequest[] = [];
  installBridge(t, async request => { actual.push(request); return { status: 200, body: { ok: true, local: true } }; });
  for (const [path, method] of operations) {
    const body = { workspaceId, threadId: "thread", requestId: "operation", path: "中文文件.txt" };
    const response = await requestJson(ctx, { method: "POST", path, body, requireWebSession: true });
    assert.deepEqual(response, { ok: true, local: true }, path);
    assert.deepEqual(actual.at(-1), { method, body }, path);
  }
});

test("新增会话路由保持共享、其他 Client 和身份未知的请求走原权限链", () => {
  for (const [path] of operations) {
    for (const target of ["shared:project", "other:project"]) {
      assert.equal(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId: target, threadId: "thread" } }, "desktop"), null, `${path}:${target}`);
    }
    assert.equal(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId, threadId: "thread" } }), null, path);
  }
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/account/me/quick-phrases" }, "desktop"), null);
});

test("本机会话能力失败保留原失败结果，禁止转云端重试写入", async t => {
  let calls = 0;
  installBridge(t, async () => { calls++; return { status: 409, body: { ok: false, code: "CONFLICT", message: "当前版本已变化", details: { requestId: "failure" } } }; });
  const response = await requestJson(ctx, { method: "POST", path: "/api/orch/chat/action", body: { workspaceId, threadId: "thread", action: "start" } });
  assert.deepEqual(response, { ok: false, code: "CONFLICT", message: "当前版本已变化", details: { requestId: "failure" } });
  assert.equal(calls, 1);
});
