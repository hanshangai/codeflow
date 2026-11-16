import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../src/db/clientDb.ts";
import {
  assertChatDirectoryAvailable,
  assertChatWorkflowDirectoryAvailable,
  reserveChatWorkflowDirectory,
  waitForWorkspaceWriteAvailable,
} from "../src/orchestration/workspaceExecutionGuard.ts";

/** 创建真实 Client SQLite，验证并行策略只依赖工作区存在性。 */
function createHarness(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ws-guard-parallel-"));
  const db = openClientDb({ dbPath: path.join(directory, "client.db") });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "ws-guard" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "guard", path: directory });
  return {
    db,
    workspaceId,
    directory,
    ctx: {
      workspaces: new Map([[workspaceId, directory]]),
      sessions: { hasActiveTurn: () => true },
      db,
    } as never,
  };
}

test("普通会话、多个工作流和工作流节点可以并行使用同一代码目录", async (t) => {
  const harness = createHarness(t);

  assert.doesNotThrow(() => assertChatDirectoryAvailable(harness.ctx, harness.workspaceId));
  assert.doesNotThrow(() => assertChatWorkflowDirectoryAvailable(harness.ctx, harness.workspaceId));
  const releaseChat = reserveChatWorkflowDirectory(harness.ctx, harness.workspaceId, "thread-1", false);
  const releaseWorkflow = reserveChatWorkflowDirectory(harness.ctx, harness.workspaceId, "thread-2", false);
  await Promise.all([
    waitForWorkspaceWriteAvailable(harness.ctx, harness.workspaceId, "instance-1", "thread-1"),
    waitForWorkspaceWriteAvailable(harness.ctx, harness.workspaceId, "instance-2", "thread-2", { intervalMs: 1, maxWaitMs: 1 }),
  ]);
  releaseChat();
  releaseWorkflow();
});

test("工作区不存在时仍然拒绝执行入口", async (t) => {
  const harness = createHarness(t);
  const missing = "missing-workspace";
  await assert.rejects(
    () => waitForWorkspaceWriteAvailable(harness.ctx, missing, null, null),
    /工作区目录不可用/,
  );
  assert.throws(
    () => assertChatWorkflowDirectoryAvailable(harness.ctx, missing),
    /工作区目录不可用/,
  );
});
