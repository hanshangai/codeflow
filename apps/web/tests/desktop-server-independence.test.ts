import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { effectScope, nextTick } from "vue";
import type { DesktopApiRequest, WorkspaceId } from "@codeflowai/shared";
import { requestJson, isCancelledRequestError } from "../src/api/request.ts";
import { downloadWorkspaceFile } from "../src/api/fs/index.ts";
import { listEngineCustomModels, upsertEngineCustomModel, deleteEngineCustomModel } from "../src/api/engineModels/index.ts";
import { exportOrchAssetBundle, importOrchAssetBundle, listPendingMineItems, listBuiltinOrchAssets } from "../src/api/orchestration/index.ts";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";
import { useBuiltinAssetLibrary } from "../src/features/orchestration/composables/useBuiltinAssetLibrary.ts";
import { useConfigStore } from "../src/store/config.ts";

const workspaceId = "local-audit:project" as WorkspaceId;

/** 固定本机桥并禁止认证与 HTTP，避免只测映射表而漏掉实际调用。 */
function fixture(t: test.TestContext) {
  const requests: DesktopApiRequest[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = { getState: async () => ({}), request: async (request: DesktopApiRequest) => {
    requests.push(request); return { status: 200, body: { ok: true, models: [], items: [], bundle: {} } };
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("UNEXPECTED_SERVER_REQUEST"); });
  const ctx = { desktopClientId: "local-audit", serverWsOrigin: "ws://offline", sessionToken: null, webSessionId: null,
    ensureSession: async () => { throw new Error("UNEXPECTED_ACCOUNT_AUTH"); } };
  return { bridge, requests, ctx };
}

test("local model management and asset exchange bypass Server login through their real APIs", async t => {
  const f = fixture(t);
  const results = [
    await listEngineCustomModels(f.ctx, workspaceId),
    await upsertEngineCustomModel(f.ctx, { engine: "codex", modelId: "local-model", providerId: "openai" }, workspaceId),
    await deleteEngineCustomModel(f.ctx, { id: "local-model" }, workspaceId),
    await exportOrchAssetBundle(f.ctx, { workspaceId, roleIds: ["developer"] }),
    await importOrchAssetBundle(f.ctx, { workspaceId, bundle: {} as never, importMode: "copy" }),
    await listPendingMineItems(f.ctx, workspaceId, { limit: 20 }),
    await listBuiltinOrchAssets(f.ctx, "role"),
  ];
  assert.ok(results.every(result => result.ok), JSON.stringify(results));
  assert.deepEqual(f.requests.map(request => request.method), ["engineCustomModels.list", "engineCustomModels.upsert", "engineCustomModels.delete",
    "orch.assetBundles.export", "orch.assetBundles.import", "orch.pendingMine.list", "runtime.builtinAssets.list"]);
  assert.equal(f.requests[5]?.body?.limit, 20);
});

test("new local routes preserve remote and shared targets and do not retry a failed local write", async t => {
  const f = fixture(t);
  for (const target of ["other:project", "shared:project"]) {
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: `/api/engine-keys/models?workspaceId=${encodeURIComponent(target)}` }, "local-audit"), null);
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/orch/asset-bundles/export", body: { workspaceId: target } }, "local-audit"), null);
    assert.equal(resolveDesktopApiRequest({ method: "GET", path: `/api/orch/pending-mine?workspaceId=${encodeURIComponent(target)}` }, "local-audit"), null);
  }
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/engine-keys/models?workspaceId=local-audit:project" }), null);
  f.bridge.request = async () => { throw new Error("LOCAL_WRITE_FAILED"); };
  await assert.rejects(upsertEngineCustomModel(f.ctx, { engine: "codex", modelId: "local-model", providerId: "openai" }, workspaceId), /LOCAL_WRITE_FAILED/);
});

test("local download returns original bytes and filename without a Server session", async t => {
  const f = fixture(t), bytes = Buffer.from("本机文件\u0000data", "utf8");
  f.bridge.request = async request => {
    f.requests.push(request);
    return { status: 200, body: { ok: true, path: "文档.txt", fileName: "文档.txt", mimeType: "text/plain", size: bytes.length, base64: bytes.toString("base64") } } as never;
  };
  const result = await downloadWorkspaceFile(f.ctx, { workspaceId, path: "文档.txt" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.filename, "文档.txt");
  assert.equal(result.contentType, "text/plain");
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  assert.deepEqual(f.requests, [{ method: "fs.downloadFile", body: { workspaceId, path: "文档.txt" } }]);
});

test("local download cancellation and invalid file data fail without remote fallback", async t => {
  const f = fixture(t), controller = new AbortController();
  controller.abort("workspace-switch");
  await assert.rejects(downloadWorkspaceFile(f.ctx, { workspaceId, path: "file.txt" }, { signal: controller.signal }), isCancelledRequestError);
  assert.equal(f.requests.length, 0);
  f.bridge.request = async () => ({ status: 200, body: { ok: true, fileName: "file.txt", size: 4, base64: "YQ==" } }) as never;
  await assert.rejects(downloadWorkspaceFile(f.ctx, { workspaceId, path: "file.txt" }), /下载.*(无效|不一致)/);
  const denied = await requestJson(f.ctx, { method: "GET", path: "/api/account/me/summary" });
  assert.equal(denied.ok, false);
});

/** 真实读取器复用统一配置、请求上下文和桥，只隔离 UI 生命周期。 */
function builtinFixture(t: test.TestContext, ready = true, desktop = true) {
  const f = fixture(t);
  if (!desktop) window.codeflowDesktop = undefined;
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "ws://offline";
  config.desktopRuntime = { status: ready ? "ready" : "starting", requestId: "runtime-a" } as never;
  config.desktopClient = ready ? { clientId: "local-audit", workspaceIds: [] } as never : null;
  let authCalls = 0;
  t.mock.method(config, "ensureSession", async () => {
    authCalls += 1;
    if (desktop) throw new Error("UNEXPECTED_ACCOUNT_AUTH");
    return "test-account-session";
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const scope = effectScope();
  const library = scope.run(() => useBuiltinAssetLibrary())!;
  t.after(() => { scope.stop(); });
  return { ...f, config, library, logs, get authCalls() { return authCalls; } };
}

/** 交付有限响应与 Vue watcher，不依赖真实服务或轮询。 */
async function settleBuiltin(): Promise<void> { await nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); await nextTick(); }

test("桌面内置预览尚未就绪不请求 Server，就绪后自动重读已请求类型", async t => {
  const f = builtinFixture(t, false);
  await f.library.ensureTypeLoaded("role");
  assert.equal(f.authCalls, 0);
  assert.equal(f.requests.length, 0);
  assert.match(f.library.errorByType.value.role ?? "", /本机.*尚未就绪/u);
  f.config.desktopRuntime = { status: "ready", requestId: "runtime-a" } as never;
  f.config.desktopClient = { clientId: "local-audit", workspaceIds: [] } as never;
  await settleBuiltin();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.library.itemsByType.value.role, []);
  assert.equal(f.library.errorByType.value.role, "");
});

test("本机内置预览切换运行时使旧请求失效，旧结算不删除新在途请求", async t => {
  const f = builtinFixture(t);
  const pending: Array<(value: any) => void> = [];
  f.bridge.request = async request => { f.requests.push(request); return await new Promise(resolve => pending.push(resolve)); };
  const older = f.library.ensureTypeLoaded("role");
  f.config.desktopRuntime = { status: "ready", requestId: "runtime-b" } as never;
  await settleBuiltin();
  assert.equal(f.requests.length, 2);
  pending[0]!({ status: 200, body: { ok: true, items: [{ assetId: "old" }] } });
  await older;
  assert.equal("role" in f.library.itemsByType.value, false);
  assert.equal(f.library.loadingByType.value.role, true);
  const newer = f.library.ensureTypeLoaded("role");
  assert.equal(f.requests.length, 2);
  pending[1]!({ status: 200, body: { ok: true, items: [{ assetId: "new" }] } });
  await newer;
  assert.equal(f.library.itemsByType.value.role?.[0]?.assetId, "new");
  assert.equal(f.library.loadingByType.value.role, false);
});

test("内置预览失败显式暴露并记结构日志，重试仍复用同类型在途 Promise", async t => {
  const f = builtinFixture(t);
  f.bridge.request = async () => { throw new Error("本机内置资产读取失败"); };
  await f.library.ensureTypeLoaded("skill");
  assert.equal(f.library.errorByType.value.skill, "本机内置资产读取失败");
  assert.equal(f.library.loadingByType.value.skill, false);
  const detail = f.logs[0]?.[1] as { code?: string; requestId?: string; assetType?: string; desktopClientId?: string } | undefined;
  assert.equal(detail?.assetType, "skill");
  assert.equal(detail?.desktopClientId, "local-audit");
  assert.ok(detail?.code);
  assert.ok(detail?.requestId);
  let resolve!: (value: any) => void;
  f.bridge.request = async request => { f.requests.push(request); return await new Promise(complete => { resolve = complete; }); };
  const first = f.library.retry("skill"), second = f.library.ensureTypeLoaded("skill");
  assert.equal(first, second);
  resolve({ status: 200, body: { ok: true, items: [] } });
  await first;
  assert.equal(f.library.errorByType.value.skill, "");
});

test("本机内置预览缓存不随登录或 Server 连接变化", async t => {
  const f = builtinFixture(t);
  await f.library.ensureTypeLoaded("role");
  f.config.$patch({ connected: true, sessionToken: "fixture-token", sessionExpiresAt: Date.now() + 60_000, authMode: "account", userSummary: { userId: "account-a", fullName: "A" } as never });
  await settleBuiltin();
  f.config.$patch({ connected: false, sessionToken: null, sessionExpiresAt: null, authMode: null, userSummary: null });
  await settleBuiltin();
  assert.equal(f.requests.length, 1);
  assert.equal(f.authCalls, 0);
  assert.deepEqual(f.library.itemsByType.value.role, []);
});

test("Web 内置预览没有在线工作区时显式提示且不请求 Server", async t => {
  const f = builtinFixture(t, true, false);
  await f.library.ensureTypeLoaded("role");
  assert.equal(f.authCalls, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.library.errorByType.value.role, "没有在线工作区，无法查看内置资产");
  assert.deepEqual(f.library.itemsByType.value.role, undefined);
});

test("Web 内置预览已有账号会话时提示先选择工作区", async t => {
  const f = builtinFixture(t, true, false);
  f.config.authMode = "account";
  f.config.sessionToken = "fixture-token";
  f.config.sessionExpiresAt = Date.now() + 60_000;
  await f.library.ensureTypeLoaded("role");
  assert.equal(f.authCalls, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.library.errorByType.value.role, "请先选择工作区查看内置资产");
});
