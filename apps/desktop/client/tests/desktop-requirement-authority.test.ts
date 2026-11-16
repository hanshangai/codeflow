import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import * as authority from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";
import { ThreadQueueDispatcher } from "../src/queue/threadQueueDispatcher.js";
import { OrchRequirementAnalysisSessionRepoError } from "../src/db/repos/orchRequirementAnalysisSessionRepo.js";
import { logger } from "../src/logger.js";

const workspaceId = "desktop-ra:project" as WorkspaceId;
const secret = "PRIVATE_RA_SCOPE_BODY";

/** 真实 SQLite 夹具只写临时目录，归属读取不得改变派生表。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-desktop-ra-"));
  const db = openClientDb({ dbPath: path.join(root, "client.db") });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.workspaces.upsert({ id: workspaceId, title: "RA", path: root });
  const workspaces = new Map([[workspaceId, root]]);
  /** 按现行同 ID 契约创建线程与可选持久归属。 */
  function add(id: string, scope: "local" | "shared" | "unknown" | "missing", title = id) {
    const threadId = id as ThreadId;
    db.threads.create({ id: threadId, workspaceId, engine: "codex", title, threadSubtype: "requirement-analysis" });
    if (scope !== "missing") db.orchRequirementAnalysisSessions.create({
      id: id as any, workspaceId, title, status: "active", phase: "discover", engine: "codex", runtimeThreadId: threadId,
      workspaceScope: scope === "unknown" ? null : scope === "local"
        ? { scopeType: "local_workspace", scopeId: workspaceId } : { scopeType: "shared_workspace", scopeId: "shared-ra" },
    });
    return threadId;
  }
  return { db, root, workspaces, add };
}

/** 固定错误不得携带原始归属 JSON 或用户正文。 */
function expectFailure(run: () => unknown, code: string, sessionId: string) {
  assert.throws(run, (error: any) => {
    assert.equal(error.name, "OrchRequirementAnalysisSessionRepoError");
    assert.equal(error.code, code);
    assert.equal(error.details.sessionId, sessionId);
    assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${error.cause?.message}`, new RegExp(secret));
    return true;
  });
}

for (const [scope, permitted] of [["local", true], ["shared", false], ["unknown", false], ["missing", false]] as const) {
  test(`desktop RA ${scope} scope ${permitted ? "allows" : "denies"} local execution without claiming history`, t => {
    const f = fixture(t);
    const id = f.add(`ra-${scope}`, scope);
    const before = f.db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all();
    assert.equal(authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), permitted);
    assert.deepEqual(f.db.db.prepare("SELECT * FROM orch_requirement_analysis_sessions").all(), before);
  });
}

for (const runtimeThreadId of [null, "another-thread", " ra-local "]) {
  test(`desktop RA rejects conflicting runtime thread ${JSON.stringify(runtimeThreadId)}`, t => {
    const f = fixture(t);
    const id = f.add("ra-local", "local");
    f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET runtime_thread_id = ? WHERE id = ?").run(runtimeThreadId, id);
    expectFailure(() => authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", id);
    expectFailure(() => authority.listDesktopLocalRequirementThreadIds("desktop-ra", f.workspaces, f.db, workspaceId), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", id);
  });
}

test("desktop RA detects a same-ID session stored under another workspace before list filtering", t => {
  const f = fixture(t);
  const id = f.add("ra-conflict", "unknown");
  const other = "desktop-ra:other" as WorkspaceId;
  f.db.workspaces.upsert({ id: other, title: "Other", path: f.root });
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_id = ? WHERE id = ?").run(other, id);
  expectFailure(() => authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", id);
  expectFailure(() => authority.listDesktopLocalRequirementThreadIds("desktop-ra", f.workspaces, f.db, workspaceId), "ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", id);
});

for (const raw of [`{${secret}`, "[]", "null", JSON.stringify({ scopeType: "local_workspace", scopeId: "other" }), JSON.stringify({ scopeType: "shared_workspace", scopeId: "shared-ra", body: secret })]) {
  test(`desktop RA rejects damaged scope ${raw.slice(0, 30)} instead of hiding its row`, t => {
    const f = fixture(t);
    const id = f.add("ra-damaged", "local");
    f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(raw, id);
    expectFailure(() => authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", id);
    expectFailure(() => authority.listDesktopLocalRequirementThreadIds("desktop-ra", f.workspaces, f.db, workspaceId), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", id);
    assert.equal((f.db.db.prepare("SELECT workspace_scope_json FROM orch_requirement_analysis_sessions WHERE id = ?").get(id) as any).workspace_scope_json, raw);
  });
}

test("desktop RA scope rows read all 503 sessions without FTS repair or cache writes", t => {
  const f = fixture(t);
  const thread = f.db.db.prepare("INSERT INTO threads (id, workspace_id, engine, title, thread_type, thread_subtype, created_at, updated_at) VALUES (?, ?, 'codex', ?, 'chat', 'requirement-analysis', 1, 1)");
  const session = f.db.db.prepare("INSERT INTO orch_requirement_analysis_sessions (id, workspace_id, title, status, phase, engine, runtime_thread_id, workspace_scope_json, last_message_at, created_at, updated_at) VALUES (?, ?, ?, 'active', 'discover', 'codex', ?, ?, 1, 1, 1)");
  f.db.db.transaction(() => {
    for (let index = 0; index < 503; index++) {
      const id = `ra-${index.toString().padStart(3, "0")}`;
      thread.run(id, workspaceId, id);
      session.run(id, workspaceId, id, id, JSON.stringify({ scopeType: "local_workspace", scopeId: workspaceId }));
    }
  })();
  const changesBefore = f.db.db.prepare("SELECT total_changes() AS total").get();
  const rows = f.db.orchRequirementAnalysisSessions.listWorkspaceScopeRows(workspaceId);
  assert.equal(rows.length, 503);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["id", "runtimeThreadId", "workspaceId", "workspaceScope"]);
  const allowed = authority.listDesktopLocalRequirementThreadIds("desktop-ra", f.workspaces, f.db, workspaceId);
  assert.equal(allowed.length, 503);
  assert.ok(allowed.includes("ra-502"));
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS total FROM orch_requirement_analysis_search_fts").get() as any).total, 0);
  assert.equal((f.db.db.prepare("SELECT COUNT(*) AS total FROM orch_list_status_count_cache").get() as any).total, 0);
  assert.deepEqual(f.db.db.prepare("SELECT total_changes() AS total").get(), changesBefore);
});

test("desktop RA single-thread authority does not scan a different damaged session", t => {
  const f = fixture(t);
  const local = f.add("local", "local");
  const damaged = f.add("damaged", "shared");
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(`{${secret}`, damaged);
  assert.equal(authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, local), true);
  expectFailure(() => authority.listDesktopLocalRequirementThreadIds("desktop-ra", f.workspaces, f.db, workspaceId), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", damaged);
});

test("desktop RA persisted shared thread markers do not hide a corrupt scope fact", t => {
  const f = fixture(t);
  const id = f.add("shared-marker", "shared");
  f.db.db.prepare("UPDATE threads SET shared_workspace_id = 'shared-ra' WHERE id = ?").run(id);
  assert.equal(authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), false);
  f.db.db.prepare("UPDATE orch_requirement_analysis_sessions SET workspace_scope_json = ? WHERE id = ?").run(`{${secret}`, id);
  expectFailure(() => authority.isDesktopLocalThreadAssetExecution("desktop-ra", f.workspaces, f.db, id), "ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", id);
});

test("RA recovery failure leaves pending items intact when pause persistence fails", t => {
  const f = fixture(t);
  const id = f.add("ra-rollback", "local");
  const item = f.db.threadMessageQueue.appendItem({ workspaceId, threadId: id, text: "Private queue", images: [], files: [],
    sendOptions: { workMode: "general", planMode: false, model: null, effort: null, accessMode: null, contextWindow: null, autoCompactPct: null, serviceTier: null }, originWebSessionId: null }).item;
  f.db.db.exec("CREATE TRIGGER fail_ra_pause BEFORE INSERT ON thread_queue_states BEGIN SELECT RAISE(ABORT, 'RA_PAUSE_WRITE_FAILED'); END");
  const dispatcher = new ThreadQueueDispatcher({ db: f.db } as any);
  const logs: any[][] = [];
  const log = logger.error;
  logger.error = (...args: any[]) => { logs.push(args); };
  try {
    assert.throws(() => dispatcher.recoverOnStartup(() => { throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", { sessionId: id, workspaceId }); }), /RA_PAUSE_WRITE_FAILED/);
  } finally { logger.error = log; }
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
  assert.equal(f.db.threadQueueStates.getState(id).paused, false);
  assert.deepEqual(logs, []);
  assert.throws(() => dispatcher.recoverOnStartup(() => { throw new Error("UNCLASSIFIED_FAILURE"); }), /UNCLASSIFIED_FAILURE/);
  assert.throws(() => dispatcher.recoverOnStartup(() => { throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID", { sessionId: "different", workspaceId }); }), /ORCH_REQUIREMENT_ANALYSIS_DATA_INVALID/);
  assert.equal(f.db.threadMessageQueue.getById(item.id)?.status, "pending");
});

test("desktop RA SQL list denies missing authority and filters before title cursor pagination", t => {
  const f = fixture(t);
  const first = f.add("local-first", "local", "B-local");
  f.add("shared", "shared", "A-shared");
  f.add("unknown", "unknown", "C-unknown");
  f.add("missing", "missing", "E-missing");
  const last = f.add("local-last", "local", "D-local");
  assert.deepEqual(f.db.threads.listByWorkspace(workspaceId, { localOnly: true, scope: "all" }).threads, []);
  const opts = { localOnly: true, localRequirementThreadIds: [first, last], scope: "all", sort: "title_asc", limit: 1 } as any;
  const page1 = f.db.threads.listByWorkspace(workspaceId, opts);
  assert.deepEqual(page1.threads.map(item => item.id), [first]);
  assert.equal(page1.hasMore, true);
  const page2 = f.db.threads.listByWorkspace(workspaceId, { ...opts, cursor: page1.nextCursor });
  assert.deepEqual(page2.threads.map(item => item.id), [last]);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.nextCursor, null);
  const searched = f.db.threads.listByWorkspace(workspaceId, { ...opts, search: "shared" });
  assert.deepEqual(searched.threads, []);
  assert.equal(searched.hasMore, false);
  assert.equal(f.db.threads.listByWorkspace(workspaceId, { scope: "all" }).threads.length, 5);
});
