import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { WorkspaceId } from "@codeflowai/shared";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_READER_SCHEMA_VERSION } from "../src/db/clientDbReaderProtocol.js";
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../src/db/migrateClientDb.js";
import { logger } from "../src/logger.js";
import { ThreadStore } from "../src/threads/threadStore.js";

type SessionInput = Parameters<ReturnType<typeof openClientDb>["orchRequirementAnalysisSessions"]["create"]>[0];
const workspaceId = "workspace-ra-scope" as WorkspaceId;
const secret = "PRIVATE_REQUIREMENT_BODY_TOKEN";

/** 每项使用独立真实 SQLite，结束后关闭连接并删除临时目录。 */
async function withSessions(run: (db: ReturnType<typeof openClientDb>, input: SessionInput, root: string) => unknown): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-ra-scope-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  try {
    db.workspaces.upsert({ id: workspaceId, title: "范围测试", path: root });
    db.threads.create({ id: "ra-session" as any, workspaceId, engine: "codex", title: "需求分析", threadSubtype: "requirement-analysis" });
    await run(db, { id: "ra-session" as any, workspaceId, title: "需求分析", status: "active", phase: "discover", engine: "codex", runtimeThreadId: "ra-session" as any }, root);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 断言领域失败携带固定码和真实实体，所有可见异常内容都不含正文。 */
function expectFailure(run: () => unknown, code: string, sessionId = "ra-session"): void {
  assert.throws(run, (error: any) => {
    assert.equal(error.name, "OrchRequirementAnalysisSessionRepoError");
    assert.equal(error.code, code);
    assert.deepEqual(error.details, { sessionId, workspaceId });
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${error.cause?.message}`, new RegExp(secret));
    return true;
  });
}

test("RA schema 88 upgrades to current without assigning legacy scope and survives reopen", async () => {
  await withSessions((db, input, root) => {
    db.orchRequirementAnalysisSessions.create(input);
    const columns = db.db.prepare("PRAGMA table_info(orch_requirement_analysis_sessions)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "workspace_scope_json")) {
      db.db.exec("ALTER TABLE orch_requirement_analysis_sessions DROP COLUMN workspace_scope_json");
    }
    db.db.pragma("user_version = 88");
    migrateClientDb(db.db);
    assert.equal(db.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.equal(CLIENT_DB_READER_SCHEMA_VERSION, CLIENT_DB_SCHEMA_VERSION);
    const row = db.db.prepare("SELECT workspace_scope_json FROM orch_requirement_analysis_sessions WHERE id = ?").get(input.id) as any;
    assert.equal(row.workspace_scope_json, null);
    const reopened = openClientDb({ dbPath: path.join(root, "client.db") });
    try {
      assert.equal((reopened.orchRequirementAnalysisSessions.get(input.id) as any).workspaceScope, null);
      assert.equal((reopened.orchRequirementAnalysisSessions.listByWorkspace(workspaceId).sessions[0] as any).workspaceScope, null);
    } finally {
      reopened.close();
    }
  });
});

test("fresh RA schema exposes nullable scope and valid local/shared scopes survive get list and reopen", async () => {
  await withSessions((db, input, root) => {
    const columns = db.db.prepare("PRAGMA table_info(orch_requirement_analysis_sessions)").all() as Array<{ name: string; notnull: number }>;
    assert.equal(columns.find((column) => column.name === "workspace_scope_json")?.notnull, 0);
    const shared = { scopeType: "shared_workspace", scopeId: "shared-a" };
    const created = db.orchRequirementAnalysisSessions.create({ ...input, workspaceScope: shared } as any);
    shared.scopeId = "mutated-input";
    assert.deepEqual((created as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
    (created as any).workspaceScope.scopeId = "mutated-result";
    db.threads.create({ id: "ra-local" as any, workspaceId, engine: "codex", title: "本机需求", threadSubtype: "requirement-analysis" });
    db.orchRequirementAnalysisSessions.create({ ...input, id: "ra-local", runtimeThreadId: "ra-local", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } } as any);
    const reopened = openClientDb({ dbPath: path.join(root, "client.db") });
    try {
      assert.deepEqual((reopened.orchRequirementAnalysisSessions.get(input.id) as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
      const page = reopened.orchRequirementAnalysisSessions.listByWorkspace(workspaceId);
      assert.equal(page.sessions.length, 2);
      assert.deepEqual((page.sessions.find((session) => session.id === "ra-local") as any).workspaceScope, { scopeType: "local_workspace", scopeId: workspaceId });
      assert.deepEqual((page.sessions.find((session) => session.id === input.id) as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
    } finally {
      reopened.close();
    }
  });
});

test("RA v89 ALTER failure rolls migration back to 88 and the same entry can retry", async () => {
  await withSessions((db, input) => {
    db.orchRequirementAnalysisSessions.create(input);
    const columns = db.db.prepare("PRAGMA table_info(orch_requirement_analysis_sessions)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "workspace_scope_json")) db.db.exec("ALTER TABLE orch_requirement_analysis_sessions DROP COLUMN workspace_scope_json");
    db.db.pragma("user_version = 88");
    const beforeFact = db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all();
    const beforeProjection = db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all();
    const exec = db.db.exec;
    db.db.exec = (sql: string) => {
      if (sql.includes("ALTER TABLE") && sql.includes("workspace_scope_json")) throw new Error("RA_MIGRATION_TEST_FAILURE");
      return exec.call(db.db, sql);
    };
    try {
      assert.throws(() => migrateClientDb(db.db), /RA_MIGRATION_TEST_FAILURE/);
    } finally {
      db.db.exec = exec;
    }
    assert.equal(db.db.pragma("user_version", { simple: true }), 88);
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all(), beforeFact);
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all(), beforeProjection);
    migrateClientDb(db.db);
    assert.equal(db.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
    assert.equal((db.orchRequirementAnalysisSessions.get(input.id) as any).workspaceScope, null);
  });
});

test("RA update preserves omitted scope and rejects reassignment removal workspace moves without side effects", async () => {
  await withSessions((db, input) => {
    const created = db.orchRequirementAnalysisSessions.create({ ...input, workspaceScope: { scopeType: "shared_workspace", scopeId: "shared-a" } } as any);
    const { workspaceScope: _scope, ...omitted } = created as any;
    const updated = db.orchRequirementAnalysisSessions.update({ ...omitted, title: "已编辑" });
    assert.deepEqual((updated as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
    db.orchRequirementAnalysisSessions.listByWorkspace(workspaceId);
    const beforeFact = db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all();
    const beforeProjection = db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all();
    const beforeCache = db.db.prepare("SELECT * FROM orch_list_status_count_cache").all();
    for (const scope of [null, { scopeType: "local_workspace", scopeId: workspaceId }, { scopeType: "shared_workspace", scopeId: "shared-b" }]) {
      expectFailure(() => db.orchRequirementAnalysisSessions.update({ ...updated, title: "不可写入", workspaceScope: scope } as any), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT");
    }
    assert.throws(() => db.orchRequirementAnalysisSessions.update({ ...omitted, workspaceId: "other", title: "不可写入" }), /ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT/);
    assert.equal(db.orchRequirementAnalysisSessions.get(input.id)?.title, "已编辑");
    assert.equal((db.db.prepare("SELECT title FROM orch_requirement_analysis_search_fts WHERE session_id = ?").get(input.id) as any).title, "已编辑");
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all(), beforeFact);
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all(), beforeProjection);
    assert.deepEqual(db.db.prepare("SELECT * FROM orch_list_status_count_cache").all(), beforeCache);
    const updateScope = { scopeType: "shared_workspace", scopeId: "shared-a" };
    const sameScope = db.orchRequirementAnalysisSessions.update({ ...updated, workspaceScope: updateScope } as any);
    updateScope.scopeId = "mutated-update";
    assert.deepEqual((sameScope as any).workspaceScope, { scopeType: "shared_workspace", scopeId: "shared-a" });
  });
});

test("unknown RA scope cannot be explicitly upgraded and missing update fails before creating projections", async () => {
  await withSessions((db, input) => {
    const legacy = db.orchRequirementAnalysisSessions.create(input);
    const updated = db.orchRequirementAnalysisSessions.update({ ...legacy, title: "旧记录编辑" });
    assert.equal((updated as any).workspaceScope, null);
    expectFailure(() => db.orchRequirementAnalysisSessions.update({ ...legacy, workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } } as any), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT");
    expectFailure(() => db.orchRequirementAnalysisSessions.update({ ...legacy, id: "missing" } as any), "ORCH_REQUIREMENT_ANALYSIS_SESSION_NOT_FOUND", "missing");
    assert.equal((db.db.prepare("SELECT COUNT(*) AS total FROM orch_requirement_analysis_search_fts WHERE session_id = 'missing'").get() as any).total, 0);
  });
});

test("invalid explicit RA scopes are rejected consistently by create and update", async () => {
  await withSessions((db, input) => {
    const legacy = db.orchRequirementAnalysisSessions.create(input);
    for (const workspaceScope of [{}, [], { scopeType: "personal", scopeId: secret }, { scopeType: "shared_workspace", scopeId: " a" }, { scopeType: "local_workspace", scopeId: "other" }, { scopeType: "shared_workspace", scopeId: "a", extra: secret }]) {
      expectFailure(() => db.orchRequirementAnalysisSessions.create({ ...input, id: "invalid", workspaceScope } as any), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID", "invalid");
      expectFailure(() => db.orchRequirementAnalysisSessions.update({ ...legacy, workspaceScope } as any), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_INVALID");
    }
    assert.equal(db.orchRequirementAnalysisSessions.listByWorkspace(workspaceId).sessions.length, 1);
  });
});

test("damaged RA JSON and scope fail safely on get list and update without erasing evidence", async () => {
  await withSessions((db, input) => {
    const session = db.orchRequirementAnalysisSessions.create(input);
    for (const json of [`{${secret}`, "[]", "null", JSON.stringify({ scopeType: "shared_workspace", scopeId: "", text: secret }), JSON.stringify({ scopeType: "local_workspace", scopeId: "other" })]) {
      db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(json, input.id);
      expectFailure(() => db.orchRequirementAnalysisSessions.get(input.id), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
      expectFailure(() => db.orchRequirementAnalysisSessions.listByWorkspace(workspaceId), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
      expectFailure(() => db.orchRequirementAnalysisSessions.update({ ...session, title: "不可写入" }), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
      assert.equal((db.db.prepare("SELECT workspace_scope_json FROM orch_requirement_analysis_sessions WHERE id = ?").get(input.id) as any).workspace_scope_json, json);
    }
  });
});

for (const operation of ["create", "update"] as const) {
  for (const boundary of ["projection", "cache"] as const) {
    test(`RA ${operation} rolls fact and FTS back when ${boundary} fails`, async () => {
      await withSessions((db, input) => {
        const existing = operation === "update" ? db.orchRequirementAnalysisSessions.create(input) : null;
        db.orchRequirementAnalysisSessions.listByWorkspace(workspaceId);
        if (!existing) {
          db.db.prepare("INSERT INTO orch_list_status_count_cache (cache_key, workspace_id, list_kind, search, scope_key, counts_json, total_count, created_at, expires_at) VALUES ('ra-cache', ?, 'draft', '', '*', '[]', 0, 0, 9999999999999)").run(workspaceId);
        }
        const beforeFact = db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all();
        const beforeProjection = db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all();
        const beforeCache = db.db.prepare("SELECT * FROM orch_list_status_count_cache").all();
        const prepare = db.db.prepare;
        if (boundary === "projection") {
          db.db.prepare = (sql: string) => {
            if (sql.includes("INSERT INTO orch_requirement_analysis_search_fts")) throw new Error("RA_PROJECTION_TEST_FAILURE");
            return prepare.call(db.db, sql);
          };
        } else {
          db.db.exec("CREATE TRIGGER fail_ra_cache BEFORE DELETE ON orch_list_status_count_cache BEGIN SELECT RAISE(ABORT, 'RA_CACHE_TEST_FAILURE'); END");
        }
        try {
          assert.throws(() => operation === "create"
            ? db.orchRequirementAnalysisSessions.create({ ...input, title: "不可写入" })
            : db.orchRequirementAnalysisSessions.update({ ...existing!, title: "不可写入" }), new RegExp(boundary === "projection" ? "RA_PROJECTION_TEST_FAILURE" : "RA_CACHE_TEST_FAILURE"));
        } finally {
          db.db.prepare = prepare;
        }
        assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all(), beforeFact);
        assert.deepEqual(db.db.prepare("SELECT * FROM orch_requirement_analysis_search_fts").all(), beforeProjection);
        assert.deepEqual(db.db.prepare("SELECT * FROM orch_list_status_count_cache").all(), beforeCache);
      });
    });
  }
}

for (const method of ["orch.requirementAnalysis.sessions.get", "orch.requirementAnalysis.sessions.list", "orch.requirementAnalysis.createIntakes", "orch.requirementAnalysis.messages.send"]) {
  test(`RA API ${method} records one safe failure with request and entity identities`, async () => {
    await withSessions(async (db, input, root) => {
      db = db.forWorkspace(workspaceId);
      db.threads.create({ id: input.runtimeThreadId!, workspaceId, engine: "codex", title: "需求分析", threadSubtype: "requirement-analysis" });
      const session = db.orchRequirementAnalysisSessions.create(input);
      db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(`{${secret}`, input.id);
      const sent: any[] = [];
      const logs: unknown[][] = [];
      const get = db.orchRequirementAnalysisSessions.get.bind(db.orchRequirementAnalysisSessions);
      let reads = 0;
      if (method.endsWith("createIntakes") || method.endsWith("messages.send")) {
        db.orchRequirementAnalysisSessions.get = (id) => ++reads === 1 ? session : get(id);
      }
      const error = logger.error;
      const writeWorkspaceLog = db.writeWorkspaceLog;
      logger.error = (...args: any[]) => { logs.push(args); };
      db.writeWorkspaceLog = (targetWorkspaceId, entry) => {
        writeWorkspaceLog(targetWorkspaceId, entry);
        if (entry.level === "error") logs.push([entry.tag, entry.message, entry.data]);
      };
      const ctx = { db, clientId: "client-ra-scope", workspaces: new Map([[workspaceId, root]]), threads: new ThreadStore(), sessions: { beginThreadOperation: () => () => {}, getOrCreate: () => assert.fail("provider must not run") }, send: (message: unknown) => sent.push(message) } as unknown as ApiHandlerContext;
      try {
        await handleApiRequest(ctx, { t: "api.req", id: "request-ra-scope", method, body: { workspaceId, sessionId: input.id, candidateIds: ["candidate"], text: secret, intakeId: secret, instanceId: secret } } as any);
      } finally {
        logger.error = error;
        db.writeWorkspaceLog = writeWorkspaceLog;
        db.orchRequirementAnalysisSessions.get = get;
      }
      if (method.endsWith("createIntakes") || method.endsWith("messages.send")) assert.ok(reads >= 2, "must reach the local handler catch");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].status, 500);
      assert.equal(sent[0].body.code, "INTERNAL_ERROR");
      assert.equal(logs.length, 1);
      const details = logs[0]![2] as any;
      assert.equal(details.errorCode, "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID");
      assert.equal(details.requestId, "request-ra-scope");
      assert.equal(details.sessionId, input.id);
      assert.equal(details.workspaceId, workspaceId);
      assert.ok(details.rootCause);
      assert.doesNotMatch(JSON.stringify({ logs, sent }), new RegExp(secret));
    });
  });
}
