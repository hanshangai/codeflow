import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

import type { LocalScheduledTaskConfigInput, ScheduledTaskRun } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../src/db/migrateClientDb.js";
import { CLIENT_DB_READER_SCHEMA_VERSION } from "../src/db/clientDbReaderProtocol.js";
import * as accountRuntime from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";

const ACCOUNT_OWNER = { serverOrigin: "https://example.test", ownerUserId: "owner-1", clientId: "client-1", deviceId: "device-1" };

/** 提供无账号脚本配置，测试可显式指定工作区或设备。 */
function config(overrides: Partial<LocalScheduledTaskConfigInput> = {}): LocalScheduledTaskConfigInput {
  return {
    id: "task-1", source: "local", clientId: "client-1", deviceId: "device-1", workspaceScope: null,
    name: "本机任务", description: null, taskType: "script", cronExpr: "* * * * *", timezone: "Asia/Shanghai",
    enabled: true, payload: { shell: "sh", command: "private-command" },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 60_000,
    ...overrides,
  };
}

/** 复用调度器首次 running 字段；summary 可为空或“任务开始执行”。 */
function running(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return {
    id: "run-1", taskId: "task-1", clientId: "client-1", deviceId: "device-1", workspaceId: null,
    workflowInstanceId: null, workflowNameSnapshot: null, workflowVersion: null,
    scheduledAt: 150, startedAt: 200, finishedAt: null, status: "running", triggerSource: "schedule",
    attempt: 1, durationMs: null, summary: "任务开始执行", errorMessage: null, outputExcerpt: null, createdAt: 200,
    ...overrides,
  };
}

/** 复现原调度器脚本终态；覆盖项可生成工作流关联或失败。 */
function completed(overrides: Partial<ScheduledTaskRun> = {}): ScheduledTaskRun {
  return running({ status: "success", finishedAt: 250, durationMs: 50, summary: "完成", outputExcerpt: "ok", ...overrides });
}

/** 每次使用真实独立 SQLite 文件，不接触用户 Client 数据。 */
function fixture(t: test.TestContext): { file: string; client: ReturnType<typeof openClientDb> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-task-run-"));
  const file = path.join(dir, "client.db");
  const client = openClientDb({ dbPath: file });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  client.scheduledTaskConfigs.create({ config: config(), at: 100 });
  return { file, client };
}

/** 断言稳定错误上下文，并禁止传播任务正文或 SQLite 异常正文。 */
function runError(code: string, runId = "run-1"): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && (error as Error & { code: string }).code === code
    && (error as Error & { taskId: string }).taskId === "task-1"
    && (error as Error & { runId: string }).runId === runId
    && typeof (error as Error & { field: string }).field === "string"
    && !String(error).includes("private-command");
}

test("D16 内部历史保留旧设备全行，原列表与执行终结仍限定精确身份", t => {
  const { client } = fixture(t), repo = client.scheduledTaskRuns;
  const saved = repo.create({ run: running(), expectedConfigRevision: 1 });
  client.scheduledTaskConfigs.delete({ taskId: "task-1", expectedRevision: 1, at: 101 });
  client.db.prepare("UPDATE scheduled_task_configs SET device_id='next-device' WHERE id='task-1'").run();
  const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
  assert.deepEqual(repo.listLocalHistory({ clientId: "client-1", deviceId: "next-device" }), { items: [saved], total: 1 });
  assert.deepEqual(repo.list({ clientId: "client-1", deviceId: "next-device" }), { items: [], total: 0 });
  assert.deepEqual(repo.get("run-1"), saved);
  assert.throws(() => repo.complete(completed({ deviceId: "next-device" })), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  assert.throws(() => repo.create({ run: running({ id: "new-run", deviceId: "next-device" }), expectedConfigRevision: 2 }),
    error => (error as { code?: string }).code === "SCHEDULED_TASK_RUN_CONFIG_CONFLICT");
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
  assert.deepEqual(repo.complete(completed()), { ...completed(), source: "local", configRevision: 1, taskNameSnapshot: "本机任务" });
});

test("D16 历史 SQL 在解码前排除外来 Client、第三设备配置、孤儿、账号和错 scope 正文", t => {
  const { client } = fixture(t), repo = client.scheduledTaskRuns;
  const saved = repo.create({ run: running(), expectedConfigRevision: 1 });
  for (const [id, clientId, deviceId] of [["foreign-client", "foreign-client", "device-1"],
    ["third-device", "client-1", "third-device"], ["orphan", "client-1", "device-1"]]) {
    client.scheduledTaskConfigs.create({ config: config({ id, clientId, deviceId }), at: 100 });
    repo.create({ run: running({ id, taskId: id, clientId, deviceId }), expectedConfigRevision: 1 });
  }
  repo.createAccount({ run: running({ id: "account" }), owner: ACCOUNT_OWNER, taskName: "account" });
  repo.create({ run: running({ id: "wrong-scope" }), expectedConfigRevision: 1 });
  const row = client.db.prepare("SELECT * FROM scheduled_task_runs WHERE id='run-1'").get() as Record<string, unknown>;
  const columns = Object.keys(row);
  client.db.prepare(`INSERT INTO scheduled_task_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map(column => column === "id" ? "foreign-run-client" : column === "client_id" ? "other-client" : row[column]));
  client.db.exec(`PRAGMA ignore_check_constraints=ON;
    UPDATE scheduled_task_configs SET device_id='next-device' WHERE id='task-1';
    UPDATE scheduled_task_configs SET payload_json='{PRIVATE_BAD_CONFIG' WHERE id IN ('foreign-client','third-device');
    DELETE FROM scheduled_task_configs WHERE id='orphan';
    UPDATE scheduled_task_runs SET workspace_id='wrong-scope' WHERE id='wrong-scope';
    UPDATE scheduled_task_runs SET attempt='PRIVATE_BAD_BODY' WHERE id<>'run-1';
    UPDATE scheduled_task_runs SET source='unknown' WHERE id='foreign-client'`);
  const before = client.db.prepare("SELECT * FROM scheduled_task_runs ORDER BY id").all();
  assert.deepEqual(repo.listLocalHistory({ clientId: "client-1", deviceId: "next-device" }), { items: [saved], total: 1 });
  assert.deepEqual(repo.listLocalHistory({ clientId: "client-1", deviceId: "next-device", taskId: "third-device" }), { items: [], total: 0 });
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs ORDER BY id").all(), before);
});

for (const [column, value] of [["attempt", "PRIVATE_BAD_BODY"], ["source", "unknown"]] as const)
test(`D16 当前归属历史损坏 ${column} 仍显式失败`, t => {
  const { client } = fixture(t); client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
  client.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE scheduled_task_configs SET device_id='next-device'");
  client.db.prepare(`UPDATE scheduled_task_runs SET ${column}=?`).run(value);
  assert.throws(() => client.scheduledTaskRuns.listLocalHistory({ clientId: "client-1", deviceId: "next-device" }), runError("SCHEDULED_TASK_RUN_CORRUPT"));
});

test("D16 内部历史拒绝缺失或非法 owner、任务和分页", t => {
  const { client } = fixture(t), valid = { clientId: "client-1", deviceId: "device-1" };
  for (const invalid of [{ clientId: undefined }, { deviceId: undefined }, { clientId: " " }, { deviceId: null },
    { clientId: 1 }, { taskId: "" }, { offset: -1 }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
    assert.throws(() => client.scheduledTaskRuns.listLocalHistory({ ...valid, ...invalid } as never), { code: "SCHEDULED_TASK_RUN_INVALID" });
  }
});

test("account schema accepts an isolated owner and pending terminal without a local revision", t => {
  const { client } = fixture(t);
  client.db.prepare(`INSERT INTO scheduled_task_runs (id, task_id, client_id, device_id, workspace_id, workflow_instance_id,
    workflow_name_snapshot, workflow_version, scheduled_at, started_at, finished_at, status, trigger_source, attempt, duration_ms,
    summary, error_message, output_excerpt, created_at, source, config_revision, task_name_snapshot, server_origin, owner_user_id, report_settlement, report_settled_at)
    VALUES ('account-run', 'task-1', 'client-1', 'device-1', NULL, NULL, NULL, NULL, 150, 200, 250, 'success', 'schedule', 1, 50,
    'ok', NULL, NULL, 200, 'account', NULL, 'account task', 'https://example.test', 'owner-1', NULL, NULL)`).run();
  assert.equal(client.scheduledTaskRuns.list({ taskId: "task-1" }).total, 0, "local reads exclude account history");
  assert.equal(client.scheduledTaskRuns.get("account-run"), null);
});

test("account runtime claim is exact and does not adopt legacy bare task state", t => {
  const { client } = fixture(t);
  client.scheduledTaskRuntimeStates.markStarted({ taskId: "task-1", clientId: "client-1", deviceId: "device-1", scheduledAt: 1, runId: "legacy", startedAt: 2 });
  assert.equal(typeof accountRuntime.scheduledTaskAccountRuntimeKey, "function", "account owner must have an unambiguous runtime key");
  const key = accountRuntime.scheduledTaskAccountRuntimeKey("task-1", ACCOUNT_OWNER);
  client.scheduledTaskRuntimeStates.claimAccount({ taskId: "task-1", owner: ACCOUNT_OWNER, runId: "run-1", scheduledAt: 150, startedAt: 200 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.runningRunId, "run-1");
  assert.equal(client.scheduledTaskRuntimeStates.get("task-1")?.runningRunId, "legacy");
  assert.throws(() => client.scheduledTaskRuntimeStates.claimAccount({ taskId: "task-1", owner: ACCOUNT_OWNER, runId: "run-2", scheduledAt: 200, startedAt: 210 }));
  assert.throws(() => client.scheduledTaskRuntimeStates.finishAccount({ taskId: "task-1", owner: ACCOUNT_OWNER, runId: "wrong", finishedAt: 250 }));
  client.scheduledTaskRuntimeStates.finishAccount({ taskId: "task-1", owner: ACCOUNT_OWNER, runId: "run-1", finishedAt: 250 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.runningRunId, null);
});

test("account pending is isolated by four owner fields, ordered, and ACK uses exact terminal CAS", t => {
  const { client } = fixture(t), repo = client.scheduledTaskRuns;
  const initial = running(); repo.createAccount({ run: initial, owner: ACCOUNT_OWNER, taskName: "account" });
  assert.deepEqual(repo.listPendingAccount(ACCOUNT_OWNER), []);
  assert.throws(() => repo.acknowledgeAccount(initial.id, ACCOUNT_OWNER, 230));
  repo.completeAccount(completed(), ACCOUNT_OWNER);
  for (const owner of [{ ...ACCOUNT_OWNER, serverOrigin: "https://other.test" }, { ...ACCOUNT_OWNER, ownerUserId: "other" },
    { ...ACCOUNT_OWNER, clientId: "other" }, { ...ACCOUNT_OWNER, deviceId: "other" }]) {
    assert.deepEqual(repo.listPendingAccount(owner), []); assert.throws(() => repo.getAccount(initial.id, owner));
    assert.throws(() => repo.completeAccount(completed(), owner)); assert.throws(() => repo.acknowledgeAccount(initial.id, owner, 260));
  }
  const second = running({ id: "run-2" }); repo.createAccount({ run: second, owner: ACCOUNT_OWNER, taskName: "account" });
  repo.completeAccount(completed({ id: "run-2" }), ACCOUNT_OWNER);
  assert.deepEqual(repo.listPendingAccount(ACCOUNT_OWNER, 1).map(run => run.id), ["run-1"]);
  repo.acknowledgeAccount("run-1", ACCOUNT_OWNER, 260);
  assert.equal(repo.getAccount("run-1", ACCOUNT_OWNER)?.reportSettlement, "acknowledged");
  assert.throws(() => repo.acknowledgeAccount("run-1", ACCOUNT_OWNER, 260));
  assert.deepEqual(repo.listPendingAccount(ACCOUNT_OWNER).map(run => run.id), ["run-2"]);
  assert.equal(repo.get("run-1"), null); assert.deepEqual(repo.list({}), { items: [], total: 0 });
});

test("account running observed missing retains deletion on completion and new same-task run is eligible", t => {
  const { client } = fixture(t), repo = client.scheduledTaskRuns;
  repo.createAccount({ run: running(), owner: ACCOUNT_OWNER, taskName: "account" });
  repo.discardMissingAccount(ACCOUNT_OWNER, new Set(), 220);
  const saved = repo.completeAccount(completed(), ACCOUNT_OWNER);
  assert.equal(saved.reportSettlement, "task_deleted"); assert.equal(saved.reportSettledAt, 220);
  assert.deepEqual(repo.listPendingAccount(ACCOUNT_OWNER), []);
  repo.createAccount({ run: running({ id: "new-run" }), owner: ACCOUNT_OWNER, taskName: "account" });
  repo.completeAccount(completed({ id: "new-run" }), ACCOUNT_OWNER);
  assert.deepEqual(repo.listPendingAccount(ACCOUNT_OWNER).map(run => run.id), ["new-run"]);
});

test("account corrupt creation readback rolls back rather than accepting altered run contents", t => {
  const { client } = fixture(t);
  client.db.exec("CREATE TRIGGER change_account AFTER INSERT ON scheduled_task_runs WHEN NEW.source='account' BEGIN UPDATE scheduled_task_runs SET summary='changed' WHERE id=NEW.id; END");
  assert.throws(() => client.scheduledTaskRuns.createAccount({ run: running(), owner: ACCOUNT_OWNER, taskName: "account" }));
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), []);
});

test("D08 account metadata conflict never decodes a different owner's damaged body", t => {
  const { client }=fixture(t),foreign={...ACCOUNT_OWNER,ownerUserId:"foreign-owner"};
  client.scheduledTaskRuns.createAccount({run:running(),owner:foreign,taskName:"foreign"});
  client.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE scheduled_task_runs SET attempt='PRIVATE_BODY'");
  assert.equal(client.scheduledTaskRuns.hasAccount("run-1",ACCOUNT_OWNER),false);
  assert.equal(client.scheduledTaskRuns.hasMissingAccount(ACCOUNT_OWNER,new Set()),false);
  assert.deepEqual(client.scheduledTaskRuns.listPendingAccount(ACCOUNT_OWNER),[]);
  assert.throws(()=>client.scheduledTaskRuns.getAccount("run-1",ACCOUNT_OWNER),{code:"SCHEDULED_TASK_RUN_CONFLICT",field:"owner"});
  assert.throws(()=>client.scheduledTaskRuns.getAccount("run-1",foreign),{code:"SCHEDULED_TASK_RUN_CORRUPT"});
  assert.equal((client.db.prepare("SELECT attempt FROM scheduled_task_runs").get() as {attempt:string}).attempt,"PRIVATE_BODY");
});

test("V92 local rows and original indexes survive the account schema upgrade, failed DDL restores all", t => {
  const { client } = fixture(t);
  // 从真实 V92 列构造前版表，不调用本片新建表模拟旧库。
  client.db.exec(`DROP TABLE scheduled_task_runs;
    CREATE TABLE scheduled_task_runs (id TEXT PRIMARY KEY,task_id TEXT NOT NULL,client_id TEXT NOT NULL,device_id TEXT NOT NULL,
      workspace_id TEXT NULL,workflow_instance_id TEXT NULL,workflow_name_snapshot TEXT NULL,workflow_version INTEGER NULL,
      scheduled_at INTEGER NOT NULL,started_at INTEGER NULL,finished_at INTEGER NULL,status TEXT NOT NULL,trigger_source TEXT NOT NULL,
      attempt INTEGER NOT NULL,duration_ms INTEGER NULL,summary TEXT NULL,error_message TEXT NULL,output_excerpt TEXT NULL,created_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source='local'),config_revision INTEGER NOT NULL CHECK(config_revision>0),task_name_snapshot TEXT NOT NULL);
    CREATE INDEX idx_scheduled_task_runs_history ON scheduled_task_runs(task_id,created_at DESC,id DESC);
    CREATE INDEX idx_scheduled_task_runs_device ON scheduled_task_runs(client_id,device_id,created_at DESC,id DESC);
    PRAGMA user_version=92;`);
  client.scheduledTaskRuns.create({ run: running({ summary: "保留中文证据" }), expectedConfigRevision: 1 });
  const rows = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
  const indexes = client.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_task_runs' ORDER BY name").all();
  client.db.exec("CREATE TABLE scheduled_task_runs_v92 (sentinel TEXT)");
  assert.throws(() => migrateClientDb(client.db));
  assert.equal(client.db.pragma("user_version", { simple: true }), 92); assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), rows);
  client.db.exec("DROP TABLE scheduled_task_runs_v92"); migrateClientDb(client.db);
  const after = client.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  const oldColumns = Object.keys(rows[0] as object);
  assert.deepEqual(after.map(row => Object.fromEntries(oldColumns.map(column => [column, row[column]]))), rows);
  assert.deepEqual(client.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='scheduled_task_runs' ORDER BY name").all().map((index: any) => index.name), indexes.map((index: any) => index.name));
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
});

for (const missingIndex of ["idx_scheduled_task_runs_history", "idx_scheduled_task_runs_device"] as const) test(`V92 missing ${missingIndex} upgrades preserving local rows and both indexes`, t => {
  const { client } = fixture(t);
  const source = fs.readFileSync(new URL("../src/db/migrateClientDb.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("migration.ts", source, ts.ScriptTarget.Latest, true);
  const original = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "applyV92");
  assert.ok(original, "use the unchanged production V92 schema, not the new account table");
  const code = ts.transpileModule(original.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  client.db.exec("DROP TABLE scheduled_task_runs"); new Function("db", `${code}; applyV92(db);`)(client.db);
  client.db.exec(`PRAGMA user_version=92; DROP INDEX ${missingIndex}`);
  const saved = client.scheduledTaskRuns.create({ run: running({ summary: "保留缺索引旧库" }), expectedConfigRevision: 1 });
  const rows = client.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  assert.equal(client.db.pragma("user_version", { simple: true }), 92);
  assert.equal(client.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(missingIndex), undefined);
  migrateClientDb(client.db);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  assert.deepEqual(client.scheduledTaskRuns.get(saved.id), saved);
  const columns = Object.keys(rows[0]!);
  const upgraded = client.db.prepare("SELECT * FROM scheduled_task_runs").all() as Array<Record<string, unknown>>;
  assert.deepEqual(upgraded.map(row => Object.fromEntries(columns.map(column => [column, row[column]]))), rows);
  for (const [index, fields] of [["idx_scheduled_task_runs_history", ["task_id", "created_at", "id"]], ["idx_scheduled_task_runs_device", ["client_id", "device_id", "created_at", "id"]]] as const) {
    assert.deepEqual((client.db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map(field => field.name), fields);
    const order = (client.db.prepare(`PRAGMA index_xinfo(${index})`).all() as Array<{ key: number; desc: number }>).filter(field => field.key === 1).map(field => field.desc);
    assert.deepEqual(order, index === "idx_scheduled_task_runs_history" ? [0, 1, 1] : [0, 0, 1, 1]);
  }
});

test("lower version replay preserves an already upgraded account row and its settlement", t => {
  const { client } = fixture(t), repo = client.scheduledTaskRuns;
  repo.createAccount({ run: running(), owner: ACCOUNT_OWNER, taskName: "account" });
  repo.completeAccount(completed(), ACCOUNT_OWNER); repo.acknowledgeAccount("run-1", ACCOUNT_OWNER, 260);
  const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
  client.db.exec("PRAGMA user_version=90"); migrateClientDb(client.db);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
  assert.equal(repo.getAccount("run-1", ACCOUNT_OWNER)?.reportSettlement, "acknowledged");
});

test("local run history freezes config metadata and survives reopening without runtime-state writes", (t) => {
  const { file, client } = fixture(t);
  assert.ok(client.scheduledTaskRuns, "ClientDb must expose durable local run history");
  const saved = client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
  assert.deepEqual(saved, { ...running(), source: "local", configRevision: 1, taskNameSnapshot: "本机任务" });
  assert.equal("payload" in saved, false);
  assert.equal("ownerUserId" in saved, false);
  assert.equal(client.scheduledTaskRuntimeStates.get("task-1"), null);
  client.close();
  const reopened = openClientDb({ dbPath: file });
  try { assert.deepEqual(reopened.scheduledTaskRuns.get("run-1"), saved); }
  finally { reopened.close(); }
});

test("the scheduler's initial running summary is retained and conflicting initial replay fails", (t) => {
  const { client } = fixture(t);
  const initial = running({ summary: "任务开始执行" });
  const saved = client.scheduledTaskRuns.create({ run: initial, expectedConfigRevision: 1 });
  assert.equal(saved.summary, "任务开始执行");
  assert.deepEqual(client.scheduledTaskRuns.create({ run: initial, expectedConfigRevision: 1 }), saved);
  assert.throws(() => client.scheduledTaskRuns.create({ run: { ...initial, summary: "另一次开始" }, expectedConfigRevision: 1 }), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  const final = client.scheduledTaskRuns.complete(completed());
  assert.deepEqual(client.scheduledTaskRuns.create({ run: initial, expectedConfigRevision: 1 }), final);
});

for (const [label, changes] of [
  ["client", { clientId: "other-client" }], ["device", { deviceId: "other-device" }],
  ["workspace", { workspaceId: "ws-other" }], ["missing task", { taskId: "missing" }],
] as const) {
  test(`new history rejects ${label} mismatch without inserting`, (t) => {
    const { client } = fixture(t);
    assert.throws(() => client.scheduledTaskRuns.create({ run: running(changes), expectedConfigRevision: 1 }), (error) =>
      error instanceof Error && (error as Error & { code: string }).code === "SCHEDULED_TASK_RUN_CONFIG_CONFLICT");
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), []);
  });
}

for (const state of ["edited", "disabled", "deleted"] as const) {
  test(`new history rejects ${state} configuration while existing history can complete`, (t) => {
    const { client } = fixture(t);
    const repo = client.scheduledTaskRuns;
    repo.create({ run: running(), expectedConfigRevision: 1 });
    if (state === "edited") client.scheduledTaskConfigs.update({ config: config({ name: "新名称" }), expectedRevision: 1, at: 210 });
    if (state === "disabled") client.scheduledTaskConfigs.setEnabled({ taskId: "task-1", enabled: false, expectedRevision: 1, at: 210 });
    if (state === "deleted") client.scheduledTaskConfigs.delete({ taskId: "task-1", expectedRevision: 1, at: 210 });
    const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
    assert.throws(() => repo.create({ run: running({ id: "run-new" }), expectedConfigRevision: 1 }), runError("SCHEDULED_TASK_RUN_CONFIG_CONFLICT", "run-new"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
    assert.deepEqual(repo.create({ run: running(), expectedConfigRevision: 1 }), repo.get("run-1"));
    const saved = repo.complete(completed());
    assert.equal(saved.taskNameSnapshot, "本机任务");
    assert.equal(saved.configRevision, 1);
    assert.equal(saved.source, "local");
    assert.deepEqual(repo.list({ taskId: "task-1" }), { items: [saved], total: 1 });
    assert.deepEqual(repo.create({ run: running(), expectedConfigRevision: 1 }), saved);
  });
}

test("new history reads the current config revision from another SQLite connection", (t) => {
  const { file, client } = fixture(t);
  const other = openClientDb({ dbPath: file });
  try {
    other.scheduledTaskConfigs.update({ config: config({ name: "第二修订" }), expectedRevision: 1, at: 120 });
    assert.throws(() => client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 }), runError("SCHEDULED_TASK_RUN_CONFIG_CONFLICT"));
    const saved = client.scheduledTaskRuns.create({ run: { ...running(), source: "account", configRevision: 999, taskNameSnapshot: "伪造" } as any, expectedConfigRevision: 2 });
    assert.equal(saved.source, "local");
    assert.equal(saved.configRevision, 2);
    assert.equal(saved.taskNameSnapshot, "第二修订");
  } finally { other.close(); }
});

test("workspace-bound history requires the same config workspace and retains workflow results", (t) => {
  const { client, file } = fixture(t), workspaceId = "ws-1" as import("@codeflowai/shared").WorkspaceId;
  client.workspaces.upsert({ id: workspaceId, title: "workspace", path: path.dirname(file) });
  client.withLocalScheduledTasks(workspaceId, repos => repos.configs.create({ config: config({ id: "task-workspace", workspaceScope: { scopeType: "local_workspace", scopeId: "ws-1" },
    taskType: "workflow", payload: { workflowId: "workflow-1", contextWorkspaceId: "ws-1" } }), at: 100 }));
  assert.throws(() => client.withLocalScheduledTasks(workspaceId, repos => repos.runs.create({ run: running({ taskId: "task-workspace" }), expectedConfigRevision: 1 })));
  const initial = running({ taskId: "task-workspace", workspaceId: "ws-1" });
  client.withLocalScheduledTasks(workspaceId, repos => repos.runs.create({ run: initial, expectedConfigRevision: 1 }));
  const final = completed({ ...initial, status: "success", finishedAt: 250, durationMs: 50,
    workflowInstanceId: "orch-1", workflowNameSnapshot: "工作流", workflowVersion: 3 });
  assert.deepEqual(client.withLocalScheduledTasks(workspaceId, repos => repos.runs.complete(final)), { ...final, source: "local", configRevision: 1, taskNameSnapshot: "本机任务" });
});

test("same initial run and terminal replays are idempotent but conflicting writes do not change history", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskRuns;
  const saved = repo.create({ run: running(), expectedConfigRevision: 1 });
  assert.deepEqual(repo.create({ run: running(), expectedConfigRevision: 1 }), saved);
  assert.throws(() => repo.create({ run: running({ scheduledAt: 151 }), expectedConfigRevision: 1 }), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  assert.throws(() => repo.create({ run: running(), expectedConfigRevision: 2 }), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  const final = repo.complete(completed());
  assert.deepEqual(repo.complete(completed()), final);
  for (const changes of [{ status: "failed" as const }, { summary: "different" }, { finishedAt: 260, durationMs: 60 }]) {
    assert.throws(() => repo.complete(completed(changes)), runError("SCHEDULED_TASK_RUN_CONFLICT"));
    assert.deepEqual(repo.get("run-1"), final);
  }
  assert.throws(() => repo.complete(running()), runError("SCHEDULED_TASK_RUN_INVALID"));
});

for (const field of ["taskId", "clientId", "deviceId", "workspaceId", "scheduledAt", "startedAt", "triggerSource", "attempt", "createdAt"] as const) {
  test(`completion cannot replace the frozen ${field}`, (t) => {
    const { client } = fixture(t);
    const saved = client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
    const values = { taskId: "task-other", clientId: "client-other", deviceId: "device-other", workspaceId: "ws-other",
      scheduledAt: 149, startedAt: 201, triggerSource: "manual", attempt: 2, createdAt: 199 };
    const changed = completed({ [field]: values[field], ...(field === "startedAt" ? { durationMs: 49 } : {}) } as any);
    assert.throws(() => client.scheduledTaskRuns.complete(changed), (error) =>
      error instanceof Error && (error as Error & { code: string }).code === "SCHEDULED_TASK_RUN_CONFLICT");
    assert.deepEqual(client.scheduledTaskRuns.get("run-1"), saved);
  });
}

for (const status of ["success", "failed", "timeout"] as const) {
  test(`running history accepts the scheduler ${status} result`, (t) => {
    const { client } = fixture(t);
    client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
    assert.equal(client.scheduledTaskRuns.complete(completed({ status, errorMessage: status === "success" ? null : "execution failed" })).status, status);
  });
}

test("direct skipped history is durable and cannot transition to another outcome", (t) => {
  const { client } = fixture(t);
  const skip = running({ status: "skipped", startedAt: null, finishedAt: 200, summary: "上一轮仍在运行", workflowInstanceId: "previous-orch" });
  const saved = client.scheduledTaskRuns.create({ run: skip, expectedConfigRevision: 1 });
  assert.deepEqual(client.scheduledTaskRuns.create({ run: skip, expectedConfigRevision: 1 }), saved);
  assert.throws(() => client.scheduledTaskRuns.complete(completed()), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  assert.deepEqual(client.scheduledTaskRuns.get("run-1"), saved);
});

test("history pagination applies task, client and device filters before total and page selection", (t) => {
  const { client } = fixture(t);
  for (const [taskId, clientId, deviceId] of [["task-2", "client-1", "device-1"], ["task-3", "client-2", "device-1"], ["task-4", "client-1", "device-2"]]) {
    client.scheduledTaskConfigs.create({ config: config({ id: taskId, clientId, deviceId }), at: 100 });
    client.scheduledTaskRuns.create({ run: running({ id: `run-${taskId}`, taskId, clientId, deviceId }), expectedConfigRevision: 1 });
  }
  for (let i = 1; i <= 3; i++) client.scheduledTaskRuns.create({ run: running({ id: `run-${i}`, scheduledAt: 150 + i, createdAt: 200 + i, startedAt: 200 + i }), expectedConfigRevision: 1 });
  const page = client.scheduledTaskRuns.list({ taskId: "task-1", clientId: "client-1", deviceId: "device-1", offset: 1, limit: 1 });
  assert.equal(page.total, 3);
  assert.deepEqual(page.items.map((item) => item.id), ["run-2"]);
  assert.equal(client.scheduledTaskRuns.list({ clientId: "client-1", deviceId: "device-1" }).total, 4);
  assert.deepEqual(client.scheduledTaskRuns.list({ taskId: "task-1", clientId: "client-2" }), { items: [], total: 0 });
  assert.deepEqual(client.scheduledTaskRuns.list({ offset: 100 }), { items: [], total: 6 });
  assert.equal(client.scheduledTaskRuns.get("absent"), null);
});

for (const [label, changes] of [
  ["queued", { status: "queued" }], ["terminal before creation", { status: "success", finishedAt: 250, durationMs: 50 }],
  ["unsafe time", { scheduledAt: Number.MAX_SAFE_INTEGER + 1 }], ["missing identity", { clientId: "" }],
  ["negative attempt", { attempt: -1 }], ["unfinished running duration", { durationMs: 0 }],
  ["workflow result before execution", { workflowVersion: 1 }], ["invalid output", { outputExcerpt: {} }],
] as const) {
  test(`invalid ${label} fails without inserting history`, (t) => {
    const { client } = fixture(t);
    assert.throws(() => client.scheduledTaskRuns.create({ run: running(changes as any), expectedConfigRevision: 1 }), runError("SCHEDULED_TASK_RUN_INVALID"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), []);
  });
}

test("invalid paging, revision and completion inputs explicitly fail", (t) => {
  const { client } = fixture(t);
  for (const query of [{ offset: -1 }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { taskId: " " }, { clientId: "" }, { deviceId: 1 }]) {
    assert.throws(() => client.scheduledTaskRuns.list(query as any), (error) => (error as any).code === "SCHEDULED_TASK_RUN_INVALID");
  }
  for (const revision of [0, -1, 1.2, Number.NaN]) assert.throws(() => client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: revision }), runError("SCHEDULED_TASK_RUN_INVALID"));
  assert.throws(() => client.scheduledTaskRuns.complete(completed()), runError("SCHEDULED_TASK_RUN_CONFLICT"));
  assert.throws(() => client.scheduledTaskRuns.get(" "), (error) => (error as any).code === "SCHEDULED_TASK_RUN_INVALID");
  client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
  for (const changes of [{ finishedAt: null }, { durationMs: 1 }, { finishedAt: 199, durationMs: -1 }, { workflowVersion: 0 }]) {
    assert.throws(() => client.scheduledTaskRuns.complete(completed(changes)), runError("SCHEDULED_TASK_RUN_INVALID"));
    assert.equal(client.scheduledTaskRuns.get("run-1")?.status, "running");
  }
});

for (const [column, value] of [["attempt", "bad"], ["source", "cloud"], ["config_revision", 0], ["task_name_snapshot", ""],
  ["finished_at", 210], ["workflow_version", "bad"], ["created_at", -1], ["trigger_source", "unknown"]] as const) {
  test(`corrupt ${column} fails reads and mutations without repair`, (t) => {
    const { client } = fixture(t);
    client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
    client.db.exec("PRAGMA ignore_check_constraints = ON");
    client.db.prepare(`UPDATE scheduled_task_runs SET ${column} = ? WHERE id = ?`).run(value, "run-1");
    const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
    for (const action of [() => client.scheduledTaskRuns.get("run-1"), () => client.scheduledTaskRuns.list({ taskId: "task-1" }),
      () => client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 }), () => client.scheduledTaskRuns.complete(completed())]) {
      assert.throws(action, runError("SCHEDULED_TASK_RUN_CORRUPT"));
      assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
    }
  });
}

test("corrupt configuration is rejected through the existing strict decoder with run context", (t) => {
  const { client } = fixture(t);
  client.db.prepare("UPDATE scheduled_task_configs SET payload_json = ? WHERE id = ?").run("{private-command", "task-1");
  assert.throws(() => client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 }), (error) =>
    runError("SCHEDULED_TASK_RUN_CONFIG_CONFLICT")(error) && (error as any).rootCauseCode === "SCHEDULED_TASK_CONFIG_CORRUPT");
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), []);
});

for (const operation of ["INSERT", "UPDATE"] as const) {
  test(`SQLite ${operation} failure is explicit, sanitized and leaves no partial history`, (t) => {
    const { client } = fixture(t);
    if (operation === "UPDATE") client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
    const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
    client.db.exec(`CREATE TRIGGER reject_run_write BEFORE ${operation} ON scheduled_task_runs
      BEGIN SELECT RAISE(ABORT, 'private-command'); END;`);
    assert.throws(() => operation === "INSERT" ? client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 })
      : client.scheduledTaskRuns.complete(completed()), (error) => runError("SCHEDULED_TASK_RUN_STORAGE_FAILED")(error)
        && (error as any).rootCauseCode === "ERR_SQLITE_ERROR:1811");
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
  });
}

for (const operation of ["INSERT", "UPDATE"] as const) {
  test(`invalid read-after-${operation} rolls back the entire write`, (t) => {
    const { client } = fixture(t);
    if (operation === "UPDATE") client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 });
    const before = client.db.prepare("SELECT * FROM scheduled_task_runs").all();
    client.db.exec(`CREATE TRIGGER corrupt_run_write AFTER ${operation} ON scheduled_task_runs
      BEGIN UPDATE scheduled_task_runs SET task_name_snapshot = '' WHERE id = NEW.id; END;`);
    assert.throws(() => operation === "INSERT" ? client.scheduledTaskRuns.create({ run: running(), expectedConfigRevision: 1 })
      : client.scheduledTaskRuns.complete(completed()), runError("SCHEDULED_TASK_RUN_CORRUPT"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runs").all(), before);
  });
}

test("V91 upgrades to run history without changing config or importing runtime markers", (t) => {
  const { client } = fixture(t);
  const saved = client.scheduledTaskConfigs.get("task-1");
  client.db.exec("DROP TABLE scheduled_task_runs; PRAGMA user_version = 91");
  client.scheduledTaskRuntimeStates.markStarted({ taskId: "task-1", clientId: "client-1", deviceId: "device-1", scheduledAt: 150, runId: "old-marker", startedAt: 200 });
  migrateClientDb(client.db);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  assert.equal(CLIENT_DB_READER_SCHEMA_VERSION, CLIENT_DB_SCHEMA_VERSION);
  assert.deepEqual(client.scheduledTaskConfigs.get("task-1"), saved);
  assert.deepEqual(client.scheduledTaskRuns.list({}), { items: [], total: 0 });
  assert.equal(client.scheduledTaskRuntimeStates.get("task-1")?.runningRunId, "old-marker");
  client.db.exec("DROP TABLE scheduled_task_runs");
  migrateClientDb(client.db);
  assert.deepEqual(client.scheduledTaskRuns.list({}), { items: [], total: 0 });
});

test("failed V92 table and index creation rolls back to V91 and can retry", (t) => {
  const { client } = fixture(t);
  const saved = client.scheduledTaskConfigs.get("task-1");
  client.db.exec(`DROP TABLE scheduled_task_runs; PRAGMA user_version = 91;
    CREATE TABLE idx_scheduled_task_runs_history (id TEXT);`);
  assert.throws(() => migrateClientDb(client.db), /idx_scheduled_task_runs_history/);
  assert.equal(client.db.pragma("user_version", { simple: true }), 91);
  assert.equal(client.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduled_task_runs'").get(), undefined);
  assert.deepEqual(client.scheduledTaskConfigs.get("task-1"), saved);
  client.db.exec("DROP TABLE idx_scheduled_task_runs_history");
  migrateClientDb(client.db);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  assert.deepEqual(client.scheduledTaskRuns.list({}), { items: [], total: 0 });
});
