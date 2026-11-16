import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { TaskIntake, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { openSqliteDb, type SqliteDb } from "../src/db/sqliteDb.js";
import { readOrchIntakeListSnapshot, type OrchIntakeListSnapshotInput } from "../src/db/orchIntakeListSnapshot.js";

const workspaceId = "desktop-intakes:project" as WorkspaceId;
const secret = "PRIVATE_INTAKE_SCOPE_BODY";

/** 临时真实 SQLite 保留原投影写入口，读取只调用生产快照函数。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-intake-local-"));
  const dbPath = path.join(root, "client.db");
  const db = openClientDb({ dbPath });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "Local", path: root });
  /** 已知范围只写原事实；历史 unknown 保持空值。 */
  function add(id: string, scope: "local" | "shared" | "unknown", title = "searchable 条目", source = "ui"): TaskIntake {
    return db.orchIntakes.upsert({ id: id as any, workspaceId, triggerMode: "manual", taskType: "feature", title, goal: "目标", requester: { source } as any,
      workspaceScope: scope === "unknown" ? null : scope === "local" ? { scopeType: "local_workspace", scopeId: workspaceId } : { scopeType: "shared_workspace", scopeId: "shared" } });
  }
  /** 内部模式由测试扮演可信调用方，输入经原归一化和事务。 */
  function read(input: Partial<OrchIntakeListSnapshotInput> & { localWorkspaceOnly?: boolean } = {}) {
    return readOrchIntakeListSnapshot(db.db, { requestId: "local-intake-test", workspaceId, ...input } as OrchIntakeListSnapshotInput);
  }
  return { db, root, dbPath, add, read };
}

/** 诊断仅含真实列身份和固定原因，JSON 伪造身份与正文不得外泄。 */
function invalid(run: () => unknown, id: string, reason?: string) {
  assert.throws(run, (error: any) => {
    assert.equal(error.code, "ORCH_INTAKE_LIST_SNAPSHOT_INTAKE_INVALID");
    assert.equal(error.details.intakeId, id);
    assert.equal(error.details.workspaceId, workspaceId);
    if (reason) assert.equal(error.details.reason, reason);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${error.cause?.message}`, new RegExp(secret));
    return true;
  });
}

test("local intake scope intersects permissions before counts searches and cursors while remote signature stays stable", t => {
  const f = fixture(t);
  const local = f.add("local", "local");
  f.add("shared", "shared");
  f.add("unknown", "unknown");
  f.add("scheduled", "local", "searchable 定时", "scheduled_task");
  const other = "desktop-intakes:other" as WorkspaceId;
  f.db.workspaces.upsert({ id: other, title: "Other", path: f.root });
  f.db.orchIntakes.create({ workspaceId: other, triggerMode: "manual", taskType: "feature", title: "Other", goal: "Other", workspaceScope: { scopeType: "local_workspace", scopeId: other } });
  f.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE workspace_id = ?").run(`{${secret}`, other);
  const before = f.db.db.prepare("SELECT total_changes() AS total").get();
  const remote = f.read();
  assert.equal(remote.totalCount, 3);
  assert.equal(remote.listPageMeta.cursorScope, '{"sourceKind":"requirement","search":"","statuses":[],"allowedResourceIds":null}');
  for (const search of [undefined, "searchable", "条"]) {
    const result = f.read({ localWorkspaceOnly: true, search, allowedResourceIds: ["local", "shared", "unknown"] });
    assert.deepEqual(result.intakes.map(item => item.id), [local.id]);
    assert.equal(result.totalCount, 1);
    assert.deepEqual(result.statusCounts, [{ status: "not-started", label: "未启动", count: 1 }]);
    assert.equal(result.hasMore, false);
    assert.deepEqual(JSON.parse(result.listPageMeta.cursorScope).workspaceScope, { scopeType: "local_workspace", scopeId: workspaceId });
  }
  assert.equal(f.read({ localWorkspaceOnly: true, allowedResourceIds: ["shared"] }).totalCount, 0);
  const selectedStatus = f.read({ localWorkspaceOnly: true, statuses: ["completed"] });
  assert.equal(selectedStatus.totalCount, 0);
  assert.deepEqual(selectedStatus.intakes, []);
  assert.deepEqual(selectedStatus.statusCounts, [{ status: "not-started", label: "未启动", count: 1 }]);
  assert.equal(f.read({ localWorkspaceOnly: true, sourceKind: "scheduled_task" }).totalCount, 1);
  assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), before);
});

test("local intake list paginates all 503 trusted rows without omissions or repeats", t => {
  const f = fixture(t);
  f.db.db.transaction(() => {
    for (let index = 0; index < 503; index++) {
      const id = `local-${index.toString().padStart(3, "0")}`;
      f.add(id, "local");
      f.db.db.prepare("UPDATE orch_intake_list_states SET updated_at = ? WHERE intake_id = ?").run(1000 - index, id);
    }
    f.add("new-shared", "shared");
    f.add("new-unknown", "unknown");
  })();
  const received: string[] = [];
  let cursor: string | null = null;
  do {
    const result = f.read({ localWorkspaceOnly: true, limit: 101, cursor });
    assert.equal(result.totalCount, 503);
    received.push(...result.intakes.map(item => item.id));
    assert.equal(result.hasMore, received.length < 503);
    cursor = result.nextCursor;
  } while (cursor);
  assert.deepEqual(received, Array.from({ length: 503 }, (_, index) => `local-${index.toString().padStart(3, "0")}`));
});

for (const [name, change] of [
  ["bad JSON", () => `{${secret}`], ["array", () => "[]"],
  ["scope", (item: TaskIntake) => JSON.stringify({ ...item, workspaceScope: { scopeType: "local_workspace", scopeId: "other" } })],
  ["numeric ID", (item: TaskIntake) => JSON.stringify({ ...item, id: 123 })],
  ["numeric workspace", (item: TaskIntake) => JSON.stringify({ ...item, workspaceId: 123 })],
  ["whitespace ID", (item: TaskIntake) => JSON.stringify({ ...item, id: ` ${item.id} ` })],
  ["whitespace workspace", (item: TaskIntake) => JSON.stringify({ ...item, workspaceId: ` ${workspaceId} ` })],
  ["forged ID", (item: TaskIntake) => JSON.stringify({ ...item, id: secret })],
  ["forged workspace", (item: TaskIntake) => JSON.stringify({ ...item, workspaceId: secret })],
] as const) {
  test(`local intake prevalidation rejects ${name} outside source search status permission and cursor filters`, t => {
    const f = fixture(t);
    const good = f.add("good", "local");
    const bad = f.add(name === "numeric ID" ? "123" : "bad", "shared", "Hidden", "scheduled_task");
    const raw = change(bad);
    f.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(raw, bad.id);
    invalid(() => f.read({ localWorkspaceOnly: true, sourceKind: "requirement", search: "searchable", statuses: ["completed"], allowedResourceIds: [good.id], cursor: "1:missing" }), bad.id);
    assert.equal((f.db.db.prepare("SELECT intake_json FROM orch_intakes WHERE id = ?").get(bad.id) as any).intake_json, raw);
    assert.equal(f.read({ sourceKind: "requirement" }).totalCount, 1);
  });
}

test("local intake prevalidation reaches a corrupt 501st row and preserves explicit empty permission short circuit", t => {
  const f = fixture(t);
  f.db.db.transaction(() => { for (let index = 0; index < 503; index++) f.add(`intake-${index}`, "local"); })();
  f.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = 'intake-500'").run(`{${secret}`);
  invalid(() => f.read({ localWorkspaceOnly: true, limit: 1 }), "intake-500");
  const empty = f.read({ localWorkspaceOnly: true, allowedResourceIds: [] });
  assert.deepEqual(empty, { intakes: [], hasMore: false, nextCursor: null, statusCounts: [], totalCount: 0, listMetaById: {},
    listPageMeta: { totalCount: 0, cursorScope: '{"sourceKind":"requirement","search":"","statuses":[],"allowedResourceIds":[],"workspaceScope":{"scopeType":"local_workspace","scopeId":"desktop-intakes:project"}}' } });
});

test("local intake prevalidation rejects whitespace SQL identity even when JSON repeats it", t => {
  const f = fixture(t);
  const item = f.add("original", "local");
  const id = " whitespace-id ";
  f.db.db.prepare("INSERT INTO orch_intakes (id, workspace_id, task_type, goal, intake_json, created_at, updated_at) VALUES (?, ?, 'feature', 'Goal', ?, 1, 1)")
    .run(id, workspaceId, JSON.stringify({ ...item, id }));
  invalid(() => f.read({ localWorkspaceOnly: true, allowedResourceIds: ["other"] }), id, "row_identity_mismatch");
});

test("local intake prevalidation and page reads share one SQLite snapshot across a concurrent scope change", t => {
  const f = fixture(t);
  const item = f.add("snapshot", "local");
  const reader = openSqliteDb(f.dbPath, { readonly: true });
  let changed = false;
  const wrapped: SqliteDb = {
    close: () => reader.close(), exec: sql => reader.exec(sql), pragma: (sql, opts) => reader.pragma(sql, opts), transaction: fn => reader.transaction(fn),
    prepare(sql) {
      const statement = reader.prepare(sql);
      return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args), run: (...args) => statement.run(...args),
        *iterate(...args) {
          yield* statement.iterate(...args);
          if (!changed && sql.includes("intake_json") && sql.includes("orch_intakes")) {
            changed = true;
            f.db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(JSON.stringify({ ...item, title: "Changed", workspaceScope: { scopeType: "shared_workspace", scopeId: "shared" } }), item.id);
          }
        },
      };
    },
  };
  let result;
  try { result = readOrchIntakeListSnapshot(wrapped, { requestId: "snapshot-local", workspaceId, localWorkspaceOnly: true } as OrchIntakeListSnapshotInput); }
  finally { reader.close(); }
  assert.equal(changed, true);
  assert.deepEqual(result.intakes.map(intake => [intake.id, intake.title, intake.workspaceScope?.scopeType]), [[item.id, "searchable 条目", "local_workspace"]]);
  assert.equal(f.read({ localWorkspaceOnly: true }).totalCount, 0);
});

test("local frozen instance prevalidation and metadata share one SQLite snapshot", t => {
  const f = fixture(t);
  const intake = f.add("frozen-snapshot", "local");
  const workflow = f.db.orchWorkflows.upsert({ workspaceId, name: "Snapshot", description: "Snapshot", version: 1, nodes: [{ id: "start", type: "start", label: "Start", position: { x: 0, y: 0 } }], edges: [] });
  const instance = f.db.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  f.db.orchInstances.updateStatus(instance.id, "completed");
  const reader = openSqliteDb(f.dbPath, { readonly: true });
  let changed = false;
  const wrapped: SqliteDb = {
    close: () => reader.close(), exec: sql => reader.exec(sql), pragma: (sql, opts) => reader.pragma(sql, opts), transaction: fn => reader.transaction(fn),
    prepare(sql) {
      const statement = reader.prepare(sql);
      return { get: (...args) => statement.get(...args), all: (...args) => statement.all(...args), run: (...args) => statement.run(...args),
        *iterate(...args) {
          yield* statement.iterate(...args);
          if (!changed && sql.includes("intake_snapshot_json") && sql.includes("orch_instances")) {
            changed = true;
            f.db.db.prepare("UPDATE orch_instances SET intake_snapshot_json = ? WHERE id = ?").run(JSON.stringify({ ...intake, workspaceScope: null }), instance.id);
          }
        },
      };
    },
  };
  let result;
  try { result = readOrchIntakeListSnapshot(wrapped, { requestId: "frozen-snapshot", workspaceId, localWorkspaceOnly: true }); }
  finally { reader.close(); }
  assert.equal(changed, true);
  assert.equal(result.listMetaById[intake.id]!.latestInstance?.id, instance.id);
  assert.equal(result.listMetaById[intake.id]!.instanceCount, 1);
  assert.equal(f.read({ localWorkspaceOnly: true }).listMetaById[intake.id]!.instanceCount, 0);
});
