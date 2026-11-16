import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApiRequest, DesktopApiResponse, DesktopBridgeApi } from "@codeflowai/shared";

import { getCodeflowaiConfig, setCodeflowaiConfig } from "../src/api/codeflowai/index.ts";
import { requestJson } from "../src/api/request.ts";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";

test("codeflowai config requests route to the local Client only for the exact local workspace", () => {
  assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: "/api/codeflowai/config?workspaceId=local-client%3Aws" }, "local-client"),
    { method: "codeflowai.config.get", body: { workspaceId: "local-client:ws" } });
  assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: "/api/codeflowai/config",
    body: { workspaceId: "local-client:ws", config: { paths: { workflowDocsRoot: "codeflow-docs" } } } }, "local-client"),
  { method: "codeflowai.config.set", body: { workspaceId: "local-client:ws", config: { paths: { workflowDocsRoot: "codeflow-docs" } } } });

  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/codeflowai/config?workspaceId=shared%3Aws" }, "local-client"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/codeflowai/config?workspaceId=other-client%3Aws" }, "local-client"), null);
  assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/codeflowai/config",
    body: { workspaceId: "shared:ws", config: {} } }, "local-client"), null);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/codeflowai/config?workspaceId=local-client%3Aws" }, null), null);
});

/** 只替换 preload 边界，记录桥请求并确保没有任何 HTTP 回退。 */
function installBoundary(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const calls = { bridge: 0, fetch: 0 };
  const bridge: DesktopBridgeApi = {
    getState: async () => ({ status: "ready", requestId: "process", releaseId: null, errorCode: null }),
    openWindow: async () => {}, exit: async () => {}, onEvent: () => () => {},
    request: (request): Promise<DesktopApiResponse> => {
      calls.bridge++;
      requests.push(structuredClone(request));
      return Promise.resolve({ status: 200, body: { ok: true, path: "/project/codeflowai/codeflowai.json", config: {} } });
    },
  };
  Object.defineProperty(globalThis, "window", { value: { codeflowDesktop: bridge }, configurable: true });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls.fetch++;
    throw new Error("DESKTOP_CONFIG_MUST_NOT_USE_FETCH");
  });
  const ctx = { serverWsOrigin: "ws://server", sessionToken: null, webSessionId: null, desktopClientId: "local-client",
    ensureSession: async () => "unused-session" };
  return { requests, calls, ctx };
}

test("desktop basic config read and write go through the bridge without HTTP", async (t) => {
  const h = installBoundary(t);
  const workspaceId = "local-client:ws";

  assert.deepEqual(await getCodeflowaiConfig(h.ctx, workspaceId), {
    ok: true, path: "/project/codeflowai/codeflowai.json", config: {},
  });
  assert.deepEqual(await setCodeflowaiConfig(h.ctx, { workspaceId, config: { paths: { workflowDocsRoot: "codeflow-docs" } } }), {
    ok: true, path: "/project/codeflowai/codeflowai.json", config: {},
  });

  assert.deepEqual(h.requests, [
    { method: "codeflowai.config.get", body: { workspaceId } },
    { method: "codeflowai.config.set", body: { workspaceId, config: { paths: { workflowDocsRoot: "codeflow-docs" } } } },
  ]);
  assert.deepEqual(h.calls, { bridge: 2, fetch: 0 });
});

test("shared workspace basic config keeps the existing server route", async (t) => {
  const h = installBoundary(t);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  assert.deepEqual(await requestJson(h.ctx, { method: "GET", path: "/api/codeflowai/config?workspaceId=shared%3Aws" }), { ok: true });
  assert.deepEqual(h.requests, []);
  assert.equal(fetches, 1);
});
