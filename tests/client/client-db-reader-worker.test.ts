import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "../../packages/shared/src/index.ts";
import { ClientDbReaderError, ClientDbReaderService } from "../../apps/desktop/client/src/db/clientDbReaderService.ts";
import { sanitizeClientDbReaderRootCauseMessage } from "../../apps/desktop/client/src/db/clientDbReaderProtocol.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";

/** 将测试字符串限制到共享 WorkspaceId 类型，避免测试伪造跨层结构。 */
function makeWorkspaceId(value: string): WorkspaceId {
  return value as WorkspaceId;
}

test("Client DB reader worker reads migrated credential metadata and closes cleanly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reader-worker-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-worker-workspace");
  const diagnostics: Array<{ outcome: string; queueMs: number; dbMs: number; workspaceId?: string | null; rootCause?: Record<string, unknown> }> = [];
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({
    dbPath,
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    onFatalError: (error) => fatalErrors.push(error),
  });
  try {
    db.workspaces.upsert({ id: workspaceId, title: "reader test", path: root });
    db.engineKeys.saveBuiltIn({ label: 'builtin metadata', engine: 'codex', providerId: 'openai', baseUrl: 'https://relay.example/v1', serverOrigin: 'https://server.example', ownerUserId: 'owner-reader', keyId: 'server-reader-key', secretRef: 'builtin-reader-ref' });
    await reader.ready();
    const result = await reader.listIntakes({
      requestId: "reader-test-request",
      workspaceId,
      sourceKind: "requirement",
      limit: 10,
    });
    assert.deepEqual(result.intakes, []);
    assert.equal(result.hasMore, false);
    assert.equal(result.nextCursor, null);
    assert.equal(result.totalCount, 0);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0]?.outcome, "success");
    assert.equal(diagnostics[0]?.workspaceId, null, "legacy应用reader不得从查询input猜W诊断归属");
    assert.equal(diagnostics[0]?.rootCause, undefined, "成功诊断不包含失败根因");
    assert.equal(typeof diagnostics[0]?.queueMs, "number");
    assert.equal(typeof diagnostics[0]?.dbMs, "number");
    assert.deepEqual(fatalErrors, []);
    await reader.close();
    await assert.rejects(
      reader.ready(),
      (error: any) => error?.code === "CLIENT_DB_READER_CLOSED",
    );
  } finally {
    await reader.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Client DB reader worker serializes concurrent list requests without main-thread fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reader-concurrency-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-concurrency-workspace");
  db.workspaces.upsert({ id: workspaceId, title: "reader test", path: root });
  const diagnostics: Array<{ requestId: string; queueMs: number; dbMs: number }> = [];
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({
    dbPath,
    onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
    onFatalError: (error) => fatalErrors.push(error),
  });
  try {
    await reader.ready();
    const results = await Promise.all(
      ["one", "two", "three"].map((suffix) => reader.listIntakes({
        requestId: `reader-concurrent-${suffix}`,
        workspaceId,
        sourceKind: "requirement",
        limit: 10,
      })),
    );
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.intakes.length === 0));
    assert.deepEqual(
      diagnostics.map((item) => item.requestId).sort(),
      ["reader-concurrent-one", "reader-concurrent-three", "reader-concurrent-two"].sort(),
    );
    assert.ok(diagnostics.every((item) => Number.isFinite(item.queueMs) && item.queueMs >= 0));
    assert.ok(diagnostics.every((item) => Number.isFinite(item.dbMs) && item.dbMs >= 0));
    assert.deepEqual(fatalErrors, []);
  } finally {
    await reader.close();
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Client DB reader local scope failure is request-local and the same worker recovers after repair", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-reader-local-scope-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-local-workspace");
  const otherWorkspaceId = makeWorkspaceId("reader-other-workspace");
  for (const id of [workspaceId, otherWorkspaceId]) db.workspaces.upsert({ id, title: id, path: root });
  const local = db.orchIntakes.create({ workspaceId, triggerMode: "manual", taskType: "feature", title: "Local", goal: "Local", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  const shared = db.orchIntakes.create({ workspaceId, triggerMode: "manual", taskType: "feature", title: "Shared", goal: "Shared", workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } });
  const other = db.orchIntakes.create({ workspaceId: otherWorkspaceId, triggerMode: "manual", taskType: "feature", title: "Other", goal: "Other", workspaceScope: { scopeType: "local_workspace", scopeId: otherWorkspaceId } });
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({ dbPath, onFatalError: error => fatalErrors.push(error) });
  try {
    await reader.ready();
    const input = { requestId: "reader-local", workspaceId, allowedResourceIds: [local.id], localWorkspaceOnly: true };
    const first = await reader.listIntakes(input);
    assert.deepEqual(first.intakes.map(item => item.id), [local.id]);
    const secret = "PRIVATE_WORKER_INTAKE_ID";
    const badJson = JSON.stringify({ ...shared, id: secret });
    db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(badJson, shared.id);
    await assert.rejects(reader.listIntakes({ ...input, requestId: "reader-local-broken" }), (error: any) => {
      assert.equal(error.code, "ORCH_INTAKE_LIST_SNAPSHOT_INVALID");
      assert.equal(error.details.intakeId, shared.id);
      assert.equal(error.details.workspaceId, workspaceId);
      assert.equal(error.details.reason, "json_identity_mismatch");
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, new RegExp(secret));
      return true;
    });
    const otherResult = await reader.listIntakes({ requestId: "reader-other", workspaceId: otherWorkspaceId, localWorkspaceOnly: true } as any);
    assert.deepEqual(otherResult.intakes.map(item => item.id), [other.id]);
    db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(JSON.stringify(shared), shared.id);
    const recovered = await reader.listIntakes({ ...input, requestId: "reader-local-recovered", allowedResourceIds: undefined });
    assert.deepEqual(recovered.intakes.map(item => item.id), [local.id]);
    assert.deepEqual(fatalErrors, []);
  } finally { await reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Client DB reader uses visible frozen history and recovers after corrupt instance repair in the same worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-reader-instance-scope-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-frozen-workspace");
  db.workspaces.upsert({ id: workspaceId, title: "Frozen", path: root });
  const intake = db.orchIntakes.create({ workspaceId, triggerMode: "manual", taskType: "feature", title: "Local", goal: "Local", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  const workflow = db.orchWorkflows.upsert({ workspaceId, name: "Frozen", description: "Frozen", version: 1, nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [] });
  const local = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  db.orchInstances.updateStatus(local.id, "completed");
  const hidden = db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: { ...intake, workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } } });
  db.orchInstances.updateStatus(hidden.id, "running");
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({ dbPath, onFatalError: error => fatalErrors.push(error) });
  try {
    await reader.ready();
    const input = { requestId: "reader-frozen", workspaceId, localWorkspaceOnly: true };
    const before = db.db.prepare("SELECT * FROM orch_intake_list_states").all();
    const first = await reader.listIntakes(input);
    assert.equal(first.listMetaById[intake.id]!.latestInstance?.id, local.id);
    assert.equal(first.listMetaById[intake.id]!.instanceCount, 1);
    assert.equal(first.listMetaById[intake.id]!.listStatus, "completed");
    assert.deepEqual(first.statusCounts, [{ status: "completed", label: "已完成", count: 1 }]);
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_intake_list_states").all(), before);
    const secret = "PRIVATE_WORKER_FROZEN_WORKSPACE";
    db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...hidden.intakeSnapshot, workspaceId: secret }), hidden.id);
    await assert.rejects(reader.listIntakes({ ...input, requestId: "reader-frozen-invalid", statuses: ["not-started"], search: "missing" }), (error: any) => {
      assert.equal(error.code, "ORCH_INTAKE_LIST_SNAPSHOT_INVALID");
      assert.equal(error.details.instanceId, hidden.id);
      assert.equal(error.details.workspaceId, workspaceId);
      assert.equal(error.details.reason, "intake_identity_mismatch");
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, new RegExp(secret));
      return true;
    });
    db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify(hidden.intakeSnapshot), hidden.id);
    const restored = await reader.listIntakes({ ...input, requestId: "reader-frozen-restored" });
    assert.equal(restored.listMetaById[intake.id]!.latestInstance?.id, local.id);
    assert.equal(restored.listMetaById[intake.id]!.instanceCount, 1);
    assert.deepEqual(fatalErrors, []);
  } finally { await reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("Client DB reader worker rejects an incomplete intake projection during startup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reader-integrity-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-integrity-workspace");
  db.workspaces.upsert({ id: workspaceId, title: "reader integrity", path: root });
  const intake = db.orchIntakes.create({
    workspaceId,
    triggerMode: "manual",
    taskType: "feature",
    title: "投影缺行",
    goal: "Reader 启动必须显式失败",
    requester: { source: "ui" },
  });
  db.db.prepare(
    "DELETE FROM orch_intake_list_states WHERE workspace_id = ? AND intake_id = ?",
  ).run(String(workspaceId), String(intake.id));
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({
    dbPath,
    onFatalError: (error) => fatalErrors.push(error),
  });

  try {
    await assert.rejects(
      reader.ready(),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_SNAPSHOT_INVALID"
        && error?.details?.causeCode === "ORCH_INTAKE_LIST_PROJECTION_INCOMPLETE",
    );
    await assert.rejects(
      reader.close(),
      (error: any) => error?.code === "ORCH_INTAKE_LIST_SNAPSHOT_INVALID",
    );
    assert.deepEqual(fatalErrors, []);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Client DB reader worker rejects a database whose journal mode is not WAL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reader-journal-mode-"));
  const dbPath = path.join(root, "client.db");
  const writer = openClientDb({ dbPath });
  writer.close();
  const rawDb = openSqliteDb(dbPath);
  try {
    assert.equal(String(rawDb.pragma("journal_mode = DELETE", { simple: true })).toLowerCase(), "delete");
  } finally {
    rawDb.close();
  }
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({
    dbPath,
    onFatalError: (error) => fatalErrors.push(error),
  });

  try {
    await assert.rejects(
      reader.ready(),
      (error: any) => error?.code === "CLIENT_DB_READER_SCHEMA_INVALID"
        && error?.details?.reason === "journal_mode_invalid"
        && error?.details?.expected === "wal"
        && error?.details?.actual === "delete",
    );
    assert.deepEqual(fatalErrors, []);
    await assert.rejects(
      reader.close(),
      (error: any) => error?.code === "CLIENT_DB_READER_SCHEMA_INVALID",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Client DB reader messageerror rejects pending work and reports one runtime fatal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-reader-messageerror-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  const workspaceId = makeWorkspaceId("reader-messageerror-workspace");
  db.workspaces.upsert({ id: workspaceId, title: "messageerror", path: root });
  const fatalErrors: ClientDbReaderError[] = [];
  const reader = new ClientDbReaderService({
    dbPath,
    onFatalError: (error) => fatalErrors.push(error),
  });

  try {
    await reader.ready();
    const pending = reader.listIntakes({
      requestId: "reader-messageerror-request",
      workspaceId,
      sourceKind: "requirement",
      limit: 10,
    });
    (reader as any).worker.emit(
      "messageerror",
      new Error("reader deserialize marker at Z:\\private\\reader.js dataKey=must-not-leak"),
    );
    await assert.rejects(
      pending,
      (error: any) => error?.code === "CLIENT_DB_READER_PROTOCOL_INVALID"
        && error?.details?.reason === "worker_response_deserialize_failed"
        && String(error?.details?.rootCauseMessage ?? "").includes("reader deserialize marker")
        && !String(error?.details?.rootCauseMessage ?? "").includes("must-not-leak"),
    );
    assert.equal(fatalErrors.length, 1);
    assert.equal(fatalErrors[0]?.code, "CLIENT_DB_READER_PROTOCOL_INVALID");
    assert.equal(fatalErrors[0]?.details.requestId, "reader-messageerror-request");
    await assert.rejects(
      reader.listIntakes({
        requestId: "reader-messageerror-after-fatal",
        workspaceId,
        sourceKind: "requirement",
        limit: 10,
      }),
      (error: any) => error?.code === "CLIENT_DB_READER_PROTOCOL_INVALID",
    );
    await assert.rejects(
      reader.close(),
      (error: any) => error?.code === "CLIENT_DB_READER_PROTOCOL_INVALID",
    );
    assert.equal(fatalErrors.length, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Client DB reader root cause sanitizer removes secrets and paths", () => {
  const hexKey = "a".repeat(64);
  const raw = [
    "Cannot load better-sqlite3-multiple-ciphers",
    "at Z:\\private\\reader.js",
    "at \\\\server\\secret\\reader.js",
    "at /private/reader.js",
    "dbPath=/private/client.db",
    "at:/private/colon.db",
    "Authorization: Bearer bearer-secret",
    "dataKey=data-key-secret",
    "https://user:pass@example.test/path?token=url-secret",
    "postgres://audit-user:audit-pass@example.test/private-db",
    hexKey,
    "diagnostic tail ".repeat(40),
  ].join("\n");

  const sanitized = sanitizeClientDbReaderRootCauseMessage(raw);
  assert.ok(sanitized?.includes("better-sqlite3-multiple-ciphers"));
  assert.ok((sanitized?.length ?? 0) <= 256);
  assert.equal(sanitized?.includes("\n"), false);
  for (const secret of [
    "Z:\\private",
    "server\\secret",
    "/private/reader.js",
    "/private/client.db",
    "/private/colon.db",
    "bearer-secret",
    "data-key-secret",
    "user:pass",
    "url-secret",
    "audit-user",
    "audit-pass",
    "private-db",
    hexKey,
  ]) {
    assert.equal(sanitized?.includes(secret), false, `sanitizer leaked ${secret}`);
  }
});
