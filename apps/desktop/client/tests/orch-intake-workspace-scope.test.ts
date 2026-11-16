import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TaskIntake, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";

/** 使用真实 SQLite 验证归属事实与失败后的持久记录。 */
function withIntakes(run: (db: ReturnType<typeof openClientDb>, input: Omit<TaskIntake, "id" | "createdAt" | "updatedAt">) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-intake-scope-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  try {
    const workspaceId = "workspace-scope" as WorkspaceId;
    db.workspaces.upsert({ id: workspaceId, title: "Scope", path: root });
    run(db, { workspaceId, title: "归属测试", goal: "保留可信归属", taskType: "feature", triggerMode: "manual" });
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("intake scope persists and cannot be reassigned, removed or moved to another workspace", () => {
  withIntakes((db, input) => {
    const scope = { scopeType: "shared_workspace", scopeId: "shared-a" };
    const created = db.orchIntakes.create({ ...input, workspaceScope: scope } as any);
    scope.scopeId = "mutated";
    assert.deepEqual((db.orchIntakes.get(created.id) as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
    const { workspaceScope: _scope, ...withoutScope } = created as any;
    const updated = db.orchIntakes.upsert({ ...withoutScope, title: "已编辑" });
    assert.deepEqual((updated as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
    for (const workspaceScope of [null, { scopeType: "local_workspace", scopeId: input.workspaceId }, { scopeType: "shared_workspace", scopeId: "shared-b" }]) {
      assert.throws(() => db.orchIntakes.upsert({ ...created, title: "不可落地", workspaceScope } as any), (error: any) => {
        assert.equal(error.code, "ORCH_INTAKE_SCOPE_CONFLICT");
        assert.deepEqual(error.details, { intakeId: created.id, workspaceId: input.workspaceId });
        return true;
      });
    }
    assert.throws(() => db.orchIntakes.upsert({ ...created, workspaceId: "other-workspace" } as any), /ORCH_INTAKE_SCOPE_CONFLICT/);
    assert.equal(db.orchIntakes.get(created.id)?.title, "已编辑");
  });
});

test("unknown intake scope stays unknown and invalid explicit scopes never persist", () => {
  withIntakes((db, input) => {
    const legacy = db.orchIntakes.create(input);
    db.orchIntakes.upsert({ ...legacy, title: "旧记录编辑" });
    assert.equal((db.orchIntakes.get(legacy.id) as any).workspaceScope ?? null, null);
    assert.throws(() => db.orchIntakes.upsert({ ...legacy, workspaceScope: { scopeType: "local_workspace", scopeId: input.workspaceId } } as any), /ORCH_INTAKE_SCOPE_CONFLICT/);
    for (const workspaceScope of [{}, [], { scopeType: "personal", scopeId: "a" }, { scopeType: "shared_workspace", scopeId: " a" },
      { scopeType: "local_workspace", scopeId: "other" }, { scopeType: "shared_workspace", scopeId: "a", extra: true }]) {
      assert.throws(() => db.orchIntakes.create({ ...input, workspaceScope } as any), (error: any) => {
        assert.equal(error.code, "ORCH_INTAKE_SCOPE_INVALID");
        assert.equal(error.details.workspaceId, input.workspaceId);
        assert.match(error.details.intakeId, /^[0-9a-f-]{36}$/);
        return true;
      });
      assert.throws(() => db.orchIntakes.upsert({ ...legacy, workspaceScope } as any), (error: any) => {
        assert.equal(error.code, "ORCH_INTAKE_SCOPE_INVALID");
        assert.deepEqual(error.details, { intakeId: legacy.id, workspaceId: input.workspaceId });
        return true;
      });
    }
    assert.equal(db.orchIntakes.listByWorkspace(input.workspaceId).length, 1);
  });
});

test("damaged persisted intake scope or JSON fails before an edit can erase its evidence", () => {
  withIntakes((db, input) => {
    const intake = db.orchIntakes.create(input);
    for (const json of ["{bad", "null", "[]", JSON.stringify({ ...intake, workspaceScope: { scopeType: "shared_workspace", scopeId: "" } })]) {
      db.db.prepare("UPDATE orch_intakes SET intake_json = ? WHERE id = ?").run(json, intake.id);
      assert.throws(() => db.orchIntakes.get(intake.id), (error: any) => {
        assert.equal(error.code, "ORCH_INTAKE_DATA_INVALID");
        assert.deepEqual(error.details, { intakeId: intake.id, workspaceId: intake.workspaceId });
        if (json === "{bad") {
          assert.equal(error.cause.name, "SyntaxError");
          assert.equal(error.cause.message, "Invalid intake JSON");
        }
        return true;
      });
      assert.throws(() => db.orchIntakes.upsert({ ...intake, title: "不可落地" }), /ORCH_INTAKE_DATA_INVALID/);
      assert.equal((db.db.prepare("SELECT intake_json FROM orch_intakes WHERE id = ?").get(intake.id) as any).intake_json, json);
    }
  });
});
