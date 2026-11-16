import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ClientToServerMessage, WorkspaceId } from "@codeflowai/shared";

import { handleWorkspacesUpsert } from "../src/app/handlers/workspaceHandlers.ts";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import { migrateClientDb } from "../src/db/migrateClientDb.ts";
import { WorkspaceRepo } from "../src/db/repos/workspaceRepo.ts";
import { openSqliteDb } from "../src/db/sqliteDb.ts";
import { logger } from "../src/logger.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";

/** 构造最小 workspace upsert handler 运行环境。 */
function setup(): {
  workspaceId: WorkspaceId;
  originalPath: string;
  nextPath: string;
  db: { workspaces: WorkspaceRepo; close: () => void };
  ctx: ApiHandlerContext;
  sent: ClientToServerMessage[];
  cleanup: () => void;
} {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-ws-upsert-"));
  const originalPath = path.join(tempRoot, "original");
  const nextPath = path.join(tempRoot, "next");
  fs.mkdirSync(originalPath);
  fs.mkdirSync(nextPath);

  const sqlite = openSqliteDb(path.join(tempRoot, "client.db"));
  migrateClientDb(sqlite);
  const workspaces = new WorkspaceRepo(sqlite);
  const workspaceId = "client-test:workspace-upsert-handler" as WorkspaceId;
  workspaces.upsert({ id: workspaceId, title: "Original", path: originalPath });

  const sent: ClientToServerMessage[] = [];
  const ctx = {
    db: { workspaces, close: () => sqlite.close() },
    clientId: "client-test",
    workspaces: new Map([[workspaceId, originalPath]]),
    send(message: ClientToServerMessage) {
      sent.push(message);
    },
  } as ApiHandlerContext;

  return {
    workspaceId,
    originalPath,
    nextPath,
    db: ctx.db as any,
    ctx,
    sent,
    cleanup() {
      sqlite.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

test("workspaces.upsert在真实Writer许可内读写注册，变更回调不持许可", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-upsert-writer-")), dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath }), workspacePath = path.join(root, "workspace"); fs.mkdirSync(workspacePath);
  const messages: any[] = [];
  const writer = new ClientDbWriterService({ db, dbPath, onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    const ctx = { db, workspaces: new Map(), clientId: "client", withDatabase: (requestId, operation) => writer.withLegacyDatabase(requestId, operation),
      async onWorkspacesChanged() { assert.throws(() => db.workspaces.list(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/); }, send(message) { messages.push(message); } } as ApiHandlerContext;
    await handleWorkspacesUpsert(ctx, { t: "api.req", id: "writer-upsert", method: "workspaces.upsert", path: "/test", body: { workspaceId: "workspace", title: "工作区", path: workspacePath } });
    assert.equal(messages.at(-1)?.status, 200);
    assert.equal(await writer.withLegacyDatabase("verify-workspace", () => db.workspaces.get("client:workspace" as WorkspaceId)?.title), "工作区");
  } finally { await writer.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("handleWorkspacesUpsert 允许编辑名称但拒绝修改既有工作区目录", async () => {
  const harness = setup();
  try {
    await handleWorkspacesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-rename-workspace",
      method: "workspaces.upsert",
      path: "/workspaces/upsert",
      body: {
        workspaceId: harness.workspaceId,
        title: "Renamed",
        path: harness.originalPath,
      },
    } as ApiRequestMessage);

    const renameResponse = harness.sent.find((message) => message.t === "api.res" && message.id === "req-rename-workspace") as any;
    assert.equal(renameResponse?.status, 200);
    assert.equal(harness.db.workspaces.get(harness.workspaceId)?.title, "Renamed");
    assert.equal(harness.db.workspaces.get(harness.workspaceId)?.path, harness.originalPath);

    await handleWorkspacesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-change-path",
      method: "workspaces.upsert",
      path: "/workspaces/upsert",
      body: {
        workspaceId: harness.workspaceId,
        title: "Changed Path",
        path: harness.nextPath,
      },
    } as ApiRequestMessage);

    const pathResponse = harness.sent.find((message) => message.t === "api.res" && message.id === "req-change-path") as any;
    assert.equal(pathResponse?.status, 400);
    assert.match(String(pathResponse?.body?.message ?? ""), /目录创建后不可修改/);
    assert.equal(harness.db.workspaces.get(harness.workspaceId)?.title, "Renamed");
    assert.equal(harness.db.workspaces.get(harness.workspaceId)?.path, harness.originalPath);
    assert.equal(harness.ctx.workspaces.get(harness.workspaceId), harness.originalPath);
  } finally {
    harness.cleanup();
  }
});

test("handleWorkspacesUpsert 等待工作区变更回调并暴露本地内置资产安装失败", async () => {
  const harness = setup();
  try {
    let callbackReason = "";
    harness.ctx.onWorkspacesChanged = async (reason) => {
      callbackReason = String(reason ?? "");
      throw new Error("default bundle unavailable");
    };

    await handleWorkspacesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-sync-failed",
      method: "workspaces.upsert",
      path: "/workspaces/upsert",
      body: {
        workspaceId: "new-workspace",
        title: "New Workspace",
        path: harness.nextPath,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-sync-failed") as any;
    assert.equal(callbackReason, "create");
    assert.equal(response?.status, 500);
    assert.match(String(response?.body?.message ?? ""), /本地内置资产安装失败/);
    assert.match(String(response?.body?.message ?? ""), /default bundle unavailable/);
  } finally {
    harness.cleanup();
  }
});

test("handleWorkspacesUpsert 拒绝另一工作区复用同一物理根", async (t) => {
  const harness = setup();
  const logs: Array<Record<string, unknown>> = [];
  t.mock.method(logger, "warn", (_module: string, _message: string, context?: Record<string, unknown>) => { if (context) logs.push(context); });
  try {
    await handleWorkspacesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-duplicate-root",
      method: "workspaces.upsert",
      path: "/workspaces/upsert",
      body: {
        workspaceId: "duplicate-root",
        title: "Duplicate Root",
        path: harness.originalPath,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => message.t === "api.res" && message.id === "req-duplicate-root") as any;
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "WORKSPACE_PATH_ALREADY_REGISTERED");
    assert.equal(logs.find(entry => entry.requestId === "req-duplicate-root")?.indexPath, path.join(fs.realpathSync.native(harness.originalPath), ".codeflowai", "file-index.db"));
    assert.match(String(response?.body?.message ?? ""), /物理工作区目录/);
    assert.equal(harness.db.workspaces.get("client-test:duplicate-root" as WorkspaceId), null);
    assert.equal(harness.ctx.workspaces.has("client-test:duplicate-root" as WorkspaceId), false);
  } finally {
    harness.cleanup();
  }
});

test("handleWorkspacesUpsert 在运行 Map 落后于 SQLite 时仍拒绝重复物理根", async () => {
  const harness = setup();
  try {
    harness.ctx.workspaces.delete(harness.workspaceId);
    await handleWorkspacesUpsert(harness.ctx, {
      t: "api.req",
      id: "req-persisted-duplicate-root",
      method: "workspaces.upsert",
      path: "/workspaces/upsert",
      body: {
        workspaceId: "persisted-duplicate-root",
        title: "Persisted Duplicate Root",
        path: harness.originalPath,
      },
    } as ApiRequestMessage);

    const response = harness.sent.find((message) => (
      message.t === "api.res" && message.id === "req-persisted-duplicate-root"
    )) as any;
    assert.equal(response?.status, 409);
    assert.equal(response?.body?.code, "WORKSPACE_PATH_ALREADY_REGISTERED");
    assert.equal(harness.db.workspaces.get("client-test:persisted-duplicate-root" as WorkspaceId), null);
  } finally {
    harness.cleanup();
  }
});
