import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { KnowledgeAssetActorContext, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { handleKnowledgeAssetRequest } from "../src/app/handlers/knowledgeAssetHandlers.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { logger } from "../src/logger.js";

/** 只读搜索/正文分支不消费业务 DB，保持真实文件 store 与正式 handler。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-search-handler-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "", nodes: [{ id: "doc", parentId: null, title: "请求搜索", orderKey: "1", summary: "", tags: [], instructions: "", sourceScope: [] }] }, null);
  store.saveDocument({ nodeId: "doc", content: "# 请求搜索\n\n正式知识正文。", sources: [], expectedHash: null, origin: "manual" });
  const workspaceId = `workspace:${path.basename(root)}` as WorkspaceId;
  const sent: Array<{ id: string; status: number; body: { ok: boolean; code?: string; details?: { requestId: string }; data?: any } }> = [];
  const ctx = { workspaces: new Map([[workspaceId, root]]), send(message: unknown) { sent.push(message as typeof sent[number]); } } as unknown as ApiHandlerContext;
  const actor: KnowledgeAssetActorContext = { userId: "test-owner", accountRole: "enterprise_admin", enterpriseId: null, requestId: "actor-request", permissionScope: "account" };
  /** 请求只经正式 API 分支，返回同 id 的实际响应。 */
  async function request(id: string, action: string, input: Record<string, unknown> = {}) {
    await handleKnowledgeAssetRequest(ctx, { t: "api.req", id, method: `knowledge.assets.${action}`, body: { workspaceId, actorContext: actor, ...input } } as ApiRequestMessage);
    const response = sent.find(message => message.id === id);
    assert.ok(response);
    return response;
  }
  return { root, store, request, cache: path.join(root, ".codeflowai", "knowledge-search.sqlite") };
}

test("页面搜索真实返回新库命中，不新增错误日志", async t => {
  const f = fixture(t), errors: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { errors.push(args); });
  const response = await f.request("request-search-ok", "search", { query: "请求搜索" });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.items[0]?.nodeId, "doc");
  assert.equal(fs.existsSync(f.cache), true);
  assert.deepEqual(errors, []);
});

test("已跟踪运行数据通过 handler 返回可见409及一次结构化日志，正文和版本仍可读", async t => {
  const f = fixture(t), errors: unknown[][] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { errors.push(args); });
  fs.mkdirSync(path.dirname(f.cache), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(f.cache), "tracked"), "keep");
  execFileSync("git", ["add", "--", ".codeflowai/tracked"], { cwd: f.root, windowsHide: true });
  const response = await f.request("request-search-tracked", "search", { query: "请求搜索" });
  assert.equal(response.status, 409);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.equal(response.body.details?.requestId, "request-search-tracked");
  assert.equal(fs.existsSync(f.cache), false);
  assert.equal(errors.length, 1);
  const log = errors[0]?.[2] as Record<string, unknown>;
  assert.equal(log.requestId, "request-search-tracked");
  assert.equal(log.code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.ok(log.workspaceId);
  assert.ok(log.rootCause);
  const node = await f.request("request-read-node", "node", { nodeId: "doc" });
  assert.equal(node.status, 200);
  assert.equal(node.body.data.current.content, "# 请求搜索\n\n正式知识正文。");
  const revisionId = node.body.data.current.revision.id;
  const revision = await f.request("request-read-revision", "revision", { nodeId: "doc", revisionId });
  assert.equal(revision.status, 200);
  assert.equal(revision.body.data.content, "# 请求搜索\n\n正式知识正文。");
  assert.equal(errors.length, 1);
});
