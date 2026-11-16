import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as XLSX from "xlsx";
import type { ClientToServerMessage, DesktopApiRequest, SharedWorkspaceId, ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.ts";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ThreadStore } from "../src/threads/threadStore.ts";

/** 用真实工作区 SQLite 和统一 executor 验证能力，不启动模型或云端连接。 */
async function fixture(t: test.TestContext) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "desktop-chat-capabilities-")));
  const root = path.join(directory, "project");
  fs.mkdirSync(root);
  const database = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const sent: ClientToServerMessage[] = [];
  const ctx = { db: database, clientId: "local-client", workspaces: new Map<WorkspaceId, string>(), threads: new ThreadStore(),
    sessions: { hasActiveTurn: () => false, beginThreadOperation: () => () => {} },
    send(message: ClientToServerMessage) { sent.push(message); },
  } as ApiHandlerContext;
  let sequence = 0;
  /** 每个调用保留独立请求关联，业务仍走原处理器。 */
  const call = (method: string, body: Record<string, unknown>) => executeDesktopApiRequest(ctx, { method, body } as DesktopApiRequest,
    { requestId: `chat-capability-${++sequence}`, clientVersion: "test", startedAt: 1 });
  const created = await call("workspaces.upsert", { workspaceId: "project", path: root, title: "会话能力" });
  assert.equal(created.status, 200);
  const workspaceId = (created.body as { workspace: { id: WorkspaceId } }).workspace.id;
  const db = database.forWorkspace(workspaceId);
  const threadId = "local-chat" as ThreadId;
  db.threads.create({ id: threadId, workspaceId, engine: "codex", title: "本机会话" });
  return { ctx, db, call, root, workspaceId, threadId, sent, body: { workspaceId, threadId } };
}

test("本机命令目录返回标准成功信封和真实 Codex 命令，不要求云端身份", async t => {
  const f = await fixture(t);
  const response = await f.call("threads.inputActions.list", { ...f.body, trigger: "/" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as { ok: boolean; engine: string; actions: Array<{ id: string }> };
  assert.equal(body.ok, true);
  assert.equal(body.engine, "codex");
  assert.ok(body.actions.length > 0);
  assert.deepEqual(f.sent, []);
});

test("本机 Office 附件通过原 Worker 提取中文内容，损坏文件明确失败", async t => {
  const f = await fixture(t);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["名称", "数量"], ["验收资料", 2]]), "测试表");
  const base64 = XLSX.write(workbook, { type: "base64", bookType: "xlsx" }) as string;
  const response = await f.call("fs.extractAttachment", { workspaceId: f.workspaceId, fileName: "验收.xlsx", base64 });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body as { ok: boolean; text: string };
  assert.equal(body.ok, true);
  assert.match(body.text, /验收资料/);
  assert.match(body.text, /测试表/);
  const failed = await f.call("fs.extractAttachment", { workspaceId: f.workspaceId, fileName: "损坏.xlsx", base64: "invalid" });
  assert.ok(failed.status >= 400);
  assert.equal((failed.body as { ok: boolean }).ok, false);
});

test("本机文件引用读取真实目录和 stat，越界请求显式拒绝", async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, "说明.txt"), "说明", "utf8");
  const search = await f.call("fs.search", { workspaceId: f.workspaceId, query: "说明", limit: 20 });
  assert.equal(search.status, 200);
  assert.ok((search.body as { results: Array<{ path: string }> }).results.some(item => item.path === "说明.txt"));
  const stat = await f.call("fs.stat", { workspaceId: f.workspaceId, path: "说明.txt" });
  assert.equal(stat.status, 200);
  assert.equal((stat.body as { exists: boolean }).exists, true);
  assert.equal((stat.body as { isDir: boolean }).isDir, false);
  assert.ok((await f.call("fs.stat", { workspaceId: f.workspaceId, path: "../outside.txt" })).status >= 400);
});

test("本机文件变更可读取并接受真实快照，失败操作不更改文件", async t => {
  const f = await fixture(t);
  const turnId = "turn-change" as TurnId;
  f.db.turns.insertStarted({ workspaceId: f.workspaceId, threadId: f.threadId, engine: "codex", turnId, startedAt: 1, startEventSeq: null });
  f.db.turns.setEnded(turnId, { status: "completed", endedAt: 2, endEventSeq: null });
  const before = f.db.blobs.put(Buffer.from("原文", "utf8"), "utf8");
  const after = f.db.blobs.put(Buffer.from("改后", "utf8"), "utf8");
  f.db.fileChanges.captureBefore({ threadId: f.threadId, turnId, path: "变更.txt", beforeExists: true, beforeBlobId: before, capturedAt: 1 });
  f.db.fileChanges.captureAfter({ threadId: f.threadId, turnId, path: "变更.txt", afterExists: true, afterBlobId: after, capturedAt: 2 });
  fs.writeFileSync(path.join(f.root, "变更.txt"), "改后", "utf8");
  const listed = await f.call("threads.fileChanges.list", f.body);
  assert.equal(listed.status, 200);
  assert.equal((listed.body as { items: Array<{ path: string }> }).items[0]?.path, "变更.txt");
  const diff = await f.call("threads.fileChanges.diff", { ...f.body, path: "变更.txt" });
  assert.equal(diff.status, 200);
  assert.equal((diff.body as { beforeText: string }).beforeText, "原文");
  assert.equal((diff.body as { afterText: string }).afterText, "改后");
  const refused = await f.call("threads.fileChanges.undo", { ...f.body, paths: ["不存在.txt"] });
  assert.ok(refused.status >= 400);
  assert.equal(fs.readFileSync(path.join(f.root, "变更.txt"), "utf8"), "改后");
  const accepted = await f.call("threads.fileChanges.accept", { ...f.body, paths: ["变更.txt"] });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(f.db.fileChanges.getAcceptedBlobId(f.threadId, "变更.txt"), after);
});

test("会话工作流本机开关可持久保存，renderer 无法注入账号或共享身份", async t => {
  const f = await fixture(t);
  const response = await f.call("orch.chat.settings", { ...f.body, enabled: true });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as { recommendationEnabled: boolean }).recommendationEnabled, true);
  const snapshot = await f.call("orch.chat.get", f.body);
  assert.equal((snapshot.body as { recommendationEnabled: boolean }).recommendationEnabled, true);
  for (const forged of [{ actorUserId: "cloud-user" }, { executionProfileScope: { scopeType: "shared_workspace", scopeId: "shared" } }]) {
    const rejected = await f.call("orch.chat.settings", { ...f.body, ...forged, enabled: false });
    assert.equal(rejected.status, 400);
  }
  const shared = "shared-chat" as ThreadId;
  f.db.threads.create({ id: shared, workspaceId: f.workspaceId, engine: "codex", title: "共享", sharedAcl: { sharedWorkspaceId: "shared" as SharedWorkspaceId, ownerUserId: "owner" } });
  assert.equal((await f.call("orch.chat.get", { ...f.body, threadId: shared })).status, 404);
});

test("本机会话工作流读取不受遗留资产同步状态阻塞", async t => {
  const f = await fixture(t);
  const response = await f.call("orch.chat.get", f.body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual((response.body as { tasks: unknown[] }).tasks, []);
});

test("新能力严格绑定已有工作区和线程，错误范围不产生副作用", async t => {
  const f = await fixture(t);
  const requests = [
    { method: "threads.inputActions.list", fields: { trigger: "/" } },
    { method: "threads.fileChanges.accept", fields: { paths: ["file"] } },
    { method: "orch.chat.settings", fields: { enabled: false } },
  ];
  for (const { method, fields } of requests) {
    for (const workspaceId of ["other:project", "shared:project", "local-client:unknown"]) {
      const response = await f.call(method, { ...f.body, workspaceId, ...fields });
      assert.ok(response.status >= 400, `${method}:${workspaceId}`);
    }
  }
  assert.equal((await f.call("orch.chat.get", { ...f.body, threadId: "unknown" })).status, 404);
  assert.ok(f.db.threads.get(f.threadId));
});
