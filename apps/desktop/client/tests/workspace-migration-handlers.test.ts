import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.ts";
import {
  handleWorkspaceMigrationCancel,
  handleWorkspaceMigrationExecuteStart,
  handleWorkspaceMigrationGet,
  handleWorkspaceMigrationPrepare,
  handleWorkspaceMigrationRecover,
} from "../src/app/handlers/workspaceMigrationHandlers.ts";
import { openClientDb, type ClientDb } from "../src/db/clientDb.ts";
import type { WorkspaceDirectoryMigrationRecord } from "../src/db/repos/workspaceDirectoryMigrationRepo.ts";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.ts";

type Fixture = {
  db: ClientDb;
  workspaceId: WorkspaceId;
  sourcePath: string;
  targetParentPath: string;
  close: () => void;
};

/** 创建最小 Client DB fixture，复用真实迁移 Repo 生成完整 operation。 */
function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-workspace-migration-handlers-"));
  const sourcePath = path.join(root, "source");
  const targetParentPath = path.join(root, "targets");
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.mkdirSync(targetParentPath, { recursive: true });
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  const workspaceId = "client:workspace" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "Workspace", path: sourcePath });
  return {
    db,
    workspaceId,
    sourcePath,
    targetParentPath,
    close: () => {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 构造 handler 所需的最小上下文并捕获单次 API 响应。 */
function createContext(fixture: Fixture, service: Record<string, unknown>): {
  ctx: ApiHandlerContext;
  responses: Array<{ status: number; body: any }>;
} {
  const responses: Array<{ status: number; body: any }> = [];
  return {
    ctx: {
      db: fixture.db,
      workspaces: new Map([[fixture.workspaceId, fixture.sourcePath]]),
      clientId: "client",
      send: (message: any) => {
        if (message.t === "api.res") responses.push({ status: message.status, body: message.body });
      },
      workspaceMigrationService: service as any,
    } as ApiHandlerContext,
    responses,
  };
}

/** 构造固定字段的 API 请求，避免测试依赖 Server 路由实现。 */
function request(method: string, body: Record<string, unknown>): ApiRequestMessage {
  return { t: "api.req", id: `request-${method}`, method, path: `/${method}`, body };
}

/** 写入一个 scanning operation 供查询和归属校验使用。 */
function createOperation(fixture: Fixture, operationId = "operation-1"): WorkspaceDirectoryMigrationRecord {
  return fixture.db.workspaceDirectoryMigrations.create({
    operationId,
    idempotencyKey: `key-${operationId}`,
    workspaceId: fixture.workspaceId,
    sourcePath: fixture.sourcePath,
    targetParentPath: fixture.targetParentPath,
    targetPath: path.join(fixture.targetParentPath, "migrated"),
    now: 1,
  }).operation;
}

test("迁移异步handler只在归属和投影持Writer许可，Service等待不持许可", async () => {
  const fixture = createFixture(), operation = createOperation(fixture);
  const writer = new ClientDbWriterService({ db: fixture.db, dbPath: path.join(path.dirname(fixture.sourcePath), "client.db"), onFatalError(error) { assert.fail(error); } });
  try {
    await writer.ready();
    const service = { prepare: async () => { assert.throws(() => fixture.db.workspaces.list(), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/); return operation; },
      cancel: async () => operation, recover: async () => operation };
    const harness = createContext(fixture, service);
    harness.ctx.withDatabase = (requestId, callback) => writer.withLegacyDatabase(requestId, callback);
    await handleWorkspaceMigrationPrepare(harness.ctx, request("workspaceDirectoryMigration.prepare", { workspaceId: fixture.workspaceId,
      idempotencyKey: "writer-prepare", targetParentPath: fixture.targetParentPath, targetDirectoryName: "moved" }));
    await handleWorkspaceMigrationCancel(harness.ctx, request("workspaceDirectoryMigration.cancel", { workspaceId: fixture.workspaceId, operationId: operation.operationId }));
    await handleWorkspaceMigrationRecover(harness.ctx, request("workspaceDirectoryMigration.recover", { workspaceId: fixture.workspaceId, operationId: operation.operationId }));
    assert.deepEqual(harness.responses.map(response => response.status), [202, 200, 200]);
  } finally { await writer.close(); fixture.close(); }
});

test("迁移 prepare 缺少参数时显式返回目标参数错误", async () => {
  const fixture = createFixture();
  try {
    const harness = createContext(fixture, { prepare: async () => { throw new Error("不应调用 Service"); } });
    await handleWorkspaceMigrationPrepare(harness.ctx, request("workspaceDirectoryMigration.prepare", {
      workspaceId: fixture.workspaceId,
      idempotencyKey: "key",
    }));
    assert.equal(harness.responses[0]?.status, 400);
    assert.equal(harness.responses[0]?.body.code, "WORKSPACE_MIGRATION_TARGET_INVALID");
  } finally {
    fixture.close();
  }
});

test("迁移 prepare 的异步扫描响应使用 202", async () => {
  const fixture = createFixture();
  try {
    const operation = createOperation(fixture);
    const harness = createContext(fixture, { prepare: async () => operation });
    await handleWorkspaceMigrationPrepare(harness.ctx, request("workspaceDirectoryMigration.prepare", {
      workspaceId: fixture.workspaceId,
      idempotencyKey: "key-prepare",
      targetParentPath: fixture.targetParentPath,
      targetDirectoryName: "migrated",
    }));
    assert.equal(harness.responses[0]?.status, 202);
    assert.equal(harness.responses[0]?.body.operation.operationId, operation.operationId);
  } finally {
    fixture.close();
  }
});

test("迁移 operation handler 拒绝跨 workspace 访问", () => {
  const fixture = createFixture();
  try {
    createOperation(fixture);
    const harness = createContext(fixture, { executeStart: () => { throw new Error("不应调用 Service"); } });
    handleWorkspaceMigrationExecuteStart(harness.ctx, request("workspaceDirectoryMigration.executeStart", {
      workspaceId: "client:other",
      operationId: "operation-1",
      startAttemptId: "attempt-1",
      expectedStateVersion: 1,
    }));
    assert.equal(harness.responses[0]?.status, 404);
    assert.equal(harness.responses[0]?.body.code, "WORKSPACE_MIGRATION_NOT_FOUND");
  } finally {
    fixture.close();
  }
});

test("executeStart 严格拒绝字符串 stateVersion", async () => {
  const fixture = createFixture();
  try {
    createOperation(fixture);
    const harness = createContext(fixture, { executeStart: () => { throw new Error("不应调用 Service"); } });
    await handleWorkspaceMigrationExecuteStart(harness.ctx, request("workspaceDirectoryMigration.executeStart", {
      workspaceId: fixture.workspaceId,
      operationId: "operation-1",
      startAttemptId: "attempt-1",
      expectedStateVersion: "1",
    }));
    assert.equal(harness.responses[0]?.status, 409);
    assert.equal(harness.responses[0]?.body.code, "WORKSPACE_MIGRATION_STATE_CONFLICT");
  } finally {
    fixture.close();
  }
});

test("cancel 和 recover 路由调用对应 Service 并返回 operation DTO", async () => {
  const fixture = createFixture();
  try {
    const operation = createOperation(fixture);
    const calls: string[] = [];
    const service = {
      cancel: async () => { calls.push("cancel"); return operation; },
      recover: async () => { calls.push("recover"); return operation; },
    };
    const cancelHarness = createContext(fixture, service);
    await handleWorkspaceMigrationCancel(cancelHarness.ctx, request("workspaceDirectoryMigration.cancel", {
      workspaceId: fixture.workspaceId,
      operationId: operation.operationId,
    }));
    const recoverHarness = createContext(fixture, service);
    await handleWorkspaceMigrationRecover(recoverHarness.ctx, request("workspaceDirectoryMigration.recover", {
      workspaceId: fixture.workspaceId,
      operationId: operation.operationId,
    }));
    assert.deepEqual(calls, ["cancel", "recover"]);
    assert.equal(cancelHarness.responses[0]?.status, 200);
    assert.equal(cancelHarness.responses[0]?.body.operation.operationId, operation.operationId);
    assert.equal(recoverHarness.responses[0]?.status, 200);
  } finally {
    fixture.close();
  }
});

test("迁移查询隔离不属于 workspace 的 operation", () => {
  const fixture = createFixture();
  try {
    createOperation(fixture);
    const harness = createContext(fixture, {});
    handleWorkspaceMigrationGet(harness.ctx, request("workspaceDirectoryMigration.get", {
      workspaceId: "client:other",
      operationId: "operation-1",
    }));
    assert.equal(harness.responses[0]?.status, 404);
    assert.equal(harness.responses[0]?.body.code, "WORKSPACE_MIGRATION_NOT_FOUND");
  } finally {
    fixture.close();
  }
});
