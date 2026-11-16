import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { KNOWLEDGE_ASSET_READ_ACTIONS, type DesktopApiRequest, type WorkspaceId } from "@codeflowai/shared";
import { requestKnowledgeAsset } from "../src/api/projectKnowledge/index.ts";
import { uploadWorkspaceFile } from "../src/api/fs/index.ts";

/** 隔离桌面桥；任何登录或 Server 请求都直接使测试失败。 */
function fixture(t: test.TestContext) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window"), requests: DesktopApiRequest[] = [];
  const bridge = { getState: async () => ({}), request: async (request: DesktopApiRequest) => {
    requests.push(request);
    const data = request.method === "fs.uploadBegin" ? { uploadId: "upload", chunkSizeBytes: 3 }
      : request.method === "fs.uploadChunk" ? { receivedBytes: Number(request.body!.offset) + Buffer.from(String(request.body!.base64), "base64").length }
      : request.method === "fs.uploadComplete" ? { path: "说明.md", fileName: "说明.md", size: 6 } : { data: [] };
    return { status: 200, body: { ok: true, ...data } };
  } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: bridge } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("不得连接 Server"); });
  return { bridge, requests, ctx: { desktopClientId: "local", serverWsOrigin: "", sessionToken: null, webSessionId: null,
    ensureSession: async () => { throw new Error("不得要求登录"); } } };
}

test("规格库页面提供本机请求身份，未登录首屏不走 Server", () => {
  const source = readFileSync(new URL("../src/features/project-knowledge/components/project-knowledge-page.vue", import.meta.url), "utf8");
  const implementation = source.match(/function ctx\(\): ApiRequestContext \{([\s\S]*?)\n\}/u)![1]!;
  const config = { desktopClient: { clientId: "local" }, serverWsOrigin: "", sessionToken: null, webSessionId: null };
  const context = new Function("config", implementation)(config);
  assert.equal(context.desktopClientId, "local");
});

test("规格库读取和维护接口在未登录时使用本机桥", async t => {
  const f = fixture(t), workspaceId = "local:workspace";
  for (const action of KNOWLEDGE_ASSET_READ_ACTIONS) assert.equal((await requestKnowledgeAsset(f.ctx, action, { workspaceId })).ok, true);
  for (const action of ["import", "generate", "run.start", "run.apply", "document.save", "conversation.create", "update.save"] as const) {
    assert.equal((await requestKnowledgeAsset(f.ctx, action, { workspaceId }, { method: "POST" })).ok, true);
  }
  assert.ok(f.requests.every(request => request.method.startsWith("knowledge.assets.") && request.body?.workspaceId === workspaceId));
});

test("规格库文档分片上传保留 UTF-8 字节，全程不经过 Server", async t => {
  const f = fixture(t), file = new File(["中文"], "说明.md", { type: "text/markdown" });
  const result = await uploadWorkspaceFile(f.ctx, { workspaceId: "local:workspace" as WorkspaceId, file });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(f.requests.map(request => request.method), ["fs.uploadBegin", "fs.uploadChunk", "fs.uploadChunk", "fs.uploadComplete"]);
  assert.equal(Buffer.concat(f.requests.filter(request => request.method === "fs.uploadChunk").map(request => Buffer.from(String(request.body?.base64), "base64"))).toString("utf8"), "中文");
});

test("本机上传分片失败会取消临时文件，保持原失败且不完成上传", async t => {
  const f = fixture(t), original = f.bridge.request;
  f.bridge.request = async request => request.method === "fs.uploadChunk"
    ? (f.requests.push(request), { status: 500, body: { ok: false, code: "UPLOAD_FAILED" } } as any) : original(request);
  await assert.rejects(uploadWorkspaceFile(f.ctx, { workspaceId: "local:workspace" as WorkspaceId, file: new File(["text"], "说明.md") }), { code: "UPLOAD_FAILED" });
  assert.equal(f.requests.at(-1)?.method, "fs.uploadCancel");
  assert.ok(!f.requests.some(request => request.method === "fs.uploadComplete"));
});

test("创建上传期间取消仍取得传输 ID 并清理临时文件", async t => {
  const f = fixture(t), original = f.bridge.request, controller = new AbortController();
  f.bridge.request = async request => {
    if (request.method === "fs.uploadBegin") controller.abort();
    return original(request);
  };
  await assert.rejects(uploadWorkspaceFile(f.ctx, { workspaceId: "local:workspace" as WorkspaceId, file: new File(["text"], "说明.md") }, { signal: controller.signal }));
  assert.deepEqual(f.requests.map(request => request.method), ["fs.uploadBegin", "fs.uploadCancel"]);
});
