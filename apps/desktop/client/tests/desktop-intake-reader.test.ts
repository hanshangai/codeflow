import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OrchIntakesListResponseBody, WorkspaceId } from "@codeflowai/shared";

import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbReaderService } from "../src/db/clientDbReaderService.js";
import { ThreadStore } from "../src/threads/threadStore.js";

/** 用真实工作区库和 Reader Worker 验证桌面入口，不提供云账号或服务端连接。 */
async function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-intake-reader-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const reader = new ClientDbReaderService({
    dbPath,
    /** Worker 致命错误必须直接使测试失败。 */
    onFatalError(error) { throw error; },
    acquireWorkspaceSource: id => db.acquireWorkspaceReaderSource(id),
  });
  t.after(async () => {
    try { await reader.close(); }
    finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  const workspaceId = "local-reader:workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "本机项目", path: workspacePath });
  const workspace = db.forWorkspace(workspaceId);
  for (const source of ["ui", "scheduled_task"] as const) {
    workspace.orchIntakes.create({
      workspaceId, triggerMode: "manual", taskType: "feature", title: source, goal: "本机读取",
      requester: { source }, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId },
    });
  }
  const ctx = {
    db, clientId: "local-reader", workspaces: new Map([[workspaceId, workspacePath]]),
    threads: new ThreadStore(), orchIntakeListReader: reader,
    /** 列表读取不得向 Server 发送任何消息。 */
    send() { assert.fail("本机列表读取不应连接 Server"); },
  } as unknown as ApiHandlerContext;
  await reader.ready();
  return { ctx, workspaceId };
}

for (const sourceKind of ["requirement", "scheduled_task"] as const) {
  test(`未登录桌面通过真实 Worker 读取本机 ${sourceKind} 列表`, async t => {
    const { ctx, workspaceId } = await fixture(t);
    const result = await executeDesktopApiRequest(ctx, {
      method: "orch.intakes.list", body: { workspaceId, sourceKind, limit: 10 },
    }, { requestId: `desktop-reader-${sourceKind}`, clientVersion: "test", startedAt: 1 });

    assert.equal(result.status, 200, JSON.stringify(result.body));
    const body = result.body as OrchIntakesListResponseBody;
    assert.equal(body.totalCount, 1);
    assert.deepEqual(body.intakes.map(item => item.title), [sourceKind === "requirement" ? "ui" : "scheduled_task"]);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, null);
  });
}
