import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalScheduledTaskConfigInput, WorkspaceId } from "@codeflowai/shared";
import type { ScheduledTaskConfigRepo } from "../src/db/repos/scheduledTaskConfigRepo.js";
import { openClientDb } from "../src/db/clientDb.js";
import { CLIENT_DB_SCHEMA_VERSION, migrateClientDb } from "../src/db/migrateClientDb.js";
import { CLIENT_DB_READER_SCHEMA_VERSION } from "../src/db/clientDbReaderProtocol.js";
import { scheduledTaskRuntimeKey } from "../src/db/repos/scheduledTaskRuntimeStateRepo.js";

/** 生成无账号、无工作区脚本配置；各测试仅覆盖与断言相关的字段。 */
function scriptConfig(overrides: Partial<LocalScheduledTaskConfigInput> = {}): LocalScheduledTaskConfigInput {
  return {
    id: "local-task-1", source: "local", clientId: "client-1", deviceId: "device-1", workspaceScope: null,
    name: "本机脚本", description: null, taskType: "script", cronExpr: "*/5 * * * *", timezone: "Asia/Shanghai",
    enabled: true, payload: { shell: "sh", command: "printf local" },
    concurrencyPolicy: "skip_if_running", missedPolicy: "skip_missed", timeoutMs: 60_000,
    ...overrides,
  };
}

/** 为每项测试创建独立真实 SQLite，并保证连接和临时目录释放。 */
function fixture(t: test.TestContext): { file: string; client: ReturnType<typeof openClientDb> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-task-config-"));
  const file = path.join(dir, "client.db");
  const client = openClientDb({ dbPath: file });
  t.after(() => { client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { file, client };
}

/** 工作区两组仓储用例在实际注册库保持原业务断言。 */
function workspaceConfigRepo(client: ReturnType<typeof openClientDb>, file: string): Pick<ScheduledTaskConfigRepo,"create"|"get"|"update"> {
  const workspaceId = "workspace-1" as WorkspaceId;
  client.workspaces.upsert({ id: workspaceId, title: "workspace", path: path.dirname(file) });
  return {
    /** 原 create 在同连接 callback 内完成且真实 close 后返回。 */
    create: input=>client.withLocalScheduledTasks(workspaceId,repos=>repos.configs.create(input)),
    /** 原 get 每次读取同一实际任务库。 */
    get: id=>client.withLocalScheduledTasks(workspaceId,repos=>repos.configs.get(id)),
    /** 原 update 保原归属/CAS 断言。 */
    update: input=>client.withLocalScheduledTasks(workspaceId,repos=>repos.configs.update(input)),
  };
}

/** 只匹配稳定错误码与实体上下文，避免依赖错误文案。 */
function configError(code: string, taskId = "local-task-1"): (error: unknown) => boolean {
  return (error) => error instanceof Error
    && (error as Error & { code?: string }).code === code
    && (error as Error & { taskId?: string }).taskId === taskId;
}

test("D16 F4 接续仅改配置/runtime设备，保留墓碑、队列、running和全部时间且可重入", t => {
  const { client } = fixture(t), task = scriptConfig();
  client.scheduledTaskConfigs.create({ config: task, at: 100 });
  client.scheduledTaskConfigs.delete({ taskId: task.id, expectedRevision: 1, at: 200 });
  const key = scheduledTaskRuntimeKey(task.id, "local");
  client.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: task.clientId, deviceId: task.deviceId,
    runId: "retained-running", scheduledAt: 300, startedAt: 301 });
  client.scheduledTaskRuntimeStates.queueForWorkspaceMigration({ taskId: key, clientId: task.clientId, deviceId: task.deviceId,
    scheduledAt: 400, operationId: "retained-migration", at: 302 });
  client.scheduledTaskRuntimeStates.updateLastWorkflowInstance({ taskId: key, clientId: task.clientId,
    deviceId: task.deviceId, instanceId: "retained-instance", at: 303 });
  const configBefore = client.db.prepare("SELECT * FROM scheduled_task_configs").get() as Record<string, unknown>;
  const runtimeBefore = client.db.prepare("SELECT * FROM scheduled_task_runtime_states").get() as Record<string, unknown>;
  const request = { taskId: task.id, clientId: task.clientId, oldDeviceId: task.deviceId, nextDeviceId: "device-next" };
  assert.equal(client.scheduledTaskConfigs.rebindDesktopDevice(request), true);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").get(), { ...configBefore, device_id: request.nextDeviceId });
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runtime_states").get(), { ...runtimeBefore, device_id: request.nextDeviceId });
  assert.equal(client.scheduledTaskConfigs.rebindDesktopDevice(request), false);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runtime_states").get(), { ...runtimeBefore, device_id: request.nextDeviceId });
});

test("D16 F4 缺runtime不创建，半对/第三设备/异client拒绝且runtime写失败回滚配置", t => {
  const { client } = fixture(t), task = scriptConfig();
  client.scheduledTaskConfigs.create({ config: task, at: 100 });
  const request = { taskId: task.id, clientId: task.clientId, oldDeviceId: task.deviceId, nextDeviceId: "device-next" };
  assert.equal(client.scheduledTaskConfigs.rebindDesktopDevice(request), true);
  assert.equal(client.db.prepare("SELECT * FROM scheduled_task_runtime_states").all().length, 0);
  client.db.prepare("UPDATE scheduled_task_configs SET device_id=?").run(task.deviceId);
  const key = scheduledTaskRuntimeKey(task.id, "local");
  client.scheduledTaskRuntimeStates.markSkipped({ taskId: key, clientId: task.clientId, deviceId: task.deviceId, scheduledAt: 200, at: 201 });
  for (const [clientId, deviceId] of [[task.clientId, "device-next"], [task.clientId, "device-third"], ["foreign-client", task.deviceId]]) {
    client.db.prepare("UPDATE scheduled_task_runtime_states SET client_id=?,device_id=?").run(clientId, deviceId);
    const before = client.db.prepare("SELECT * FROM scheduled_task_configs").all();
    assert.throws(() => client.scheduledTaskConfigs.rebindDesktopDevice(request));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
  }
  client.db.prepare("UPDATE scheduled_task_runtime_states SET client_id=?,device_id=?").run(task.clientId, task.deviceId);
  const before = client.db.prepare("SELECT * FROM scheduled_task_configs").all();
  const runtimeBefore = client.db.prepare("SELECT * FROM scheduled_task_runtime_states").all();
  client.db.exec("CREATE TRIGGER reinstall_runtime_failure BEFORE UPDATE ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'PRIVATE_REINSTALL_FAILURE'); END");
  assert.throws(() => client.scheduledTaskConfigs.rebindDesktopDevice(request), configError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED"));
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runtime_states").all(), runtimeBefore);
});

test("D16 F4 配置触发器改变runtime水位时成对回滚，不能把中途副作用当原事实", t => {
  const { client } = fixture(t), task = scriptConfig(), key = scheduledTaskRuntimeKey(task.id, "local");
  client.scheduledTaskConfigs.create({ config: task, at: 100 });
  client.scheduledTaskRuntimeStates.markSkipped({ taskId: key, clientId: task.clientId, deviceId: task.deviceId, scheduledAt: 200, at: 201 });
  const before = client.db.prepare("SELECT * FROM scheduled_task_configs").all(), runtimeBefore = client.db.prepare("SELECT * FROM scheduled_task_runtime_states").all();
  client.db.exec("CREATE TRIGGER reinstall_unexpected_watermark AFTER UPDATE OF device_id ON scheduled_task_configs BEGIN UPDATE scheduled_task_runtime_states SET last_scheduled_at=300; END");
  assert.throws(() => client.scheduledTaskConfigs.rebindDesktopDevice({ taskId: task.id, clientId: task.clientId,
    oldDeviceId: task.deviceId, nextDeviceId: "device-next" }));
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_runtime_states").all(), runtimeBefore);
});

test("local config persists without account ownership and reopens with the same revision", (t) => {
  const { file, client } = fixture(t);
  assert.ok(client.scheduledTaskConfigs, "ClientDb must expose the local configuration repository");
  const saved = client.scheduledTaskConfigs.create({ config: scriptConfig(), at: 100 });
  assert.equal(saved.source, "local");
  assert.equal("ownerUserId" in saved, false);
  assert.equal(saved.workspaceScope, null);
  assert.equal(saved.revision, 1);
  assert.equal(saved.deletedAt, null);
  assert.equal(saved.createdAt, 100);
  client.close();
  const reopened = openClientDb({ dbPath: file });
  try {
    assert.deepEqual(reopened.scheduledTaskConfigs.get("local-task-1"), saved);
    assert.deepEqual(reopened.scheduledTaskConfigs.listSchedulable({ clientId: "client-1", deviceId: "device-1" }), [saved]);
    assert.deepEqual(reopened.scheduledTaskConfigs.list({ clientId: "client-other", deviceId: "device-1" }), []);
    assert.deepEqual(reopened.scheduledTaskConfigs.list({ clientId: "client-1", deviceId: "device-other" }), []);
    assert.equal(reopened.scheduledTaskRuntimeStates.get("local-task-1"), null);
  } finally { reopened.close(); }
});

test("revision compare-and-swap rejects stale edits, toggles and deletion without any write", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskConfigs;
  repo.create({ config: scriptConfig(), at: 100 });
  const edited = repo.update({ config: scriptConfig({ name: "修改后" }), expectedRevision: 1, at: 200 });
  assert.equal(edited.revision, 2);
  assert.equal(edited.name, "修改后");
  const before = client.db.prepare("SELECT * FROM scheduled_task_configs").all();
  for (const operation of [
    () => repo.update({ config: scriptConfig({ name: "过期修改" }), expectedRevision: 1, at: 300 }),
    () => repo.setEnabled({ taskId: "local-task-1", expectedRevision: 1, enabled: false, at: 300 }),
    () => repo.delete({ taskId: "local-task-1", expectedRevision: 1, at: 300 }),
    () => repo.create({ config: scriptConfig(), at: 300 }),
  ]) {
    assert.throws(operation, configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
  }
});

for (const stop of ["toggle", "update", "delete"] as const) for (const reason of ["migration", "concurrency"] as const) test(`停止配置事务同步消费本机延期：${stop}/${reason}，连续重新启用不恢复旧触发`, t => {
  const { client } = fixture(t);
  const config = scriptConfig();
  client.scheduledTaskConfigs.create({ config, at: 100 });
  const key = scheduledTaskRuntimeKey(config.id, "local");
  for (const taskId of [config.id, key]) client.scheduledTaskRuntimeStates.queueForWorkspaceMigration({
    taskId, clientId: config.clientId, deviceId: config.deviceId, scheduledAt: 150, operationId: "migration-before-stop", at: 150,
  });
  if (reason === "concurrency") client.db.prepare("UPDATE scheduled_task_runtime_states SET queued_reason = 'concurrency', queued_operation_id = NULL WHERE task_id = ?").run(key);
  const serverBefore = client.scheduledTaskRuntimeStates.get(config.id);
  if (stop === "toggle") client.scheduledTaskConfigs.setEnabled({ taskId: config.id, expectedRevision: 1, enabled: false, at: 200 });
  else if (stop === "update") client.scheduledTaskConfigs.update({ config: { ...config, enabled: false }, expectedRevision: 1, at: 200 });
  else client.scheduledTaskConfigs.delete({ taskId: config.id, expectedRevision: 1, at: 200 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.lastScheduledAt, 150);
  if (stop === "update") client.scheduledTaskConfigs.update({ config, expectedRevision: 2, at: 300 });
  else if (stop !== "delete") client.scheduledTaskConfigs.setEnabled({ taskId: config.id, expectedRevision: 2, enabled: true, at: 300 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
  assert.deepEqual(client.scheduledTaskRuntimeStates.get(config.id), serverBefore);
  assert.equal(client.scheduledTaskRuns.list({}).total, 0);
});

test("消费延期保留原 running，CAS 或消费驱动失败使配置和延期一起回滚", t => {
  const { client } = fixture(t);
  const config = scriptConfig();
  const saved = client.scheduledTaskConfigs.create({ config, at: 100 });
  const key = scheduledTaskRuntimeKey(config.id, "local");
  client.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: config.clientId, deviceId: config.deviceId, scheduledAt: 120, runId: "still-running", startedAt: 120 });
  client.scheduledTaskRuntimeStates.queueForWorkspaceMigration({ taskId: key, clientId: config.clientId, deviceId: config.deviceId,
    scheduledAt: 150, operationId: "migration-before-stop", at: 150 });
  const before = client.scheduledTaskRuntimeStates.get(key);
  assert.throws(() => client.scheduledTaskConfigs.setEnabled({ taskId: config.id, expectedRevision: 2, enabled: false, at: 200 }), configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
  assert.deepEqual(client.scheduledTaskRuntimeStates.get(key), before);
  client.db.exec("CREATE TRIGGER stop_consumption_failure BEFORE UPDATE ON scheduled_task_runtime_states BEGIN SELECT RAISE(ABORT, 'PRIVATE_STOP_SQL_BODY'); END");
  assert.throws(() => client.scheduledTaskConfigs.setEnabled({ taskId: config.id, expectedRevision: 1, enabled: false, at: 200 }), error => {
    assert.ok(configError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED")(error));
    assert.doesNotMatch(String(error), /PRIVATE_STOP_SQL_BODY/);
    return true;
  });
  assert.deepEqual(client.scheduledTaskConfigs.get(config.id), saved);
  assert.deepEqual(client.scheduledTaskRuntimeStates.get(key), before);
  client.db.exec("DROP TRIGGER stop_consumption_failure");
  client.scheduledTaskConfigs.delete({ taskId: config.id, expectedRevision: 1, at: 200 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.runningRunId, "still-running");
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
});

test("queue_one 改为 skip 后已有更晚自动水位，停用消费不得倒退", t => {
  const { client } = fixture(t);
  const config = scriptConfig({ concurrencyPolicy: "queue_one" });
  client.scheduledTaskConfigs.create({ config, at: 1 });
  const key = scheduledTaskRuntimeKey(config.id, "local");
  client.scheduledTaskRuntimeStates.markStarted({ taskId: key, clientId: config.clientId, deviceId: config.deviceId, scheduledAt: 60_000, runId: "running", startedAt: 60_000 });
  client.scheduledTaskRuntimeStates.queueLocalConcurrency({ taskId: config.id, clientId: config.clientId, deviceId: config.deviceId, runId: "running", scheduledAt: 120_000, at: 120_000 });
  client.scheduledTaskConfigs.update({ config: { ...config, concurrencyPolicy: "skip_if_running" }, expectedRevision: 1, at: 120_001 });
  client.scheduledTaskRuntimeStates.markSkipped({ taskId: key, clientId: config.clientId, deviceId: config.deviceId, scheduledAt: 180_000, at: 180_000 });
  client.scheduledTaskConfigs.setEnabled({ taskId: config.id, expectedRevision: 2, enabled: false, at: 180_001 });
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.lastScheduledAt, 180_000);
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.queuedScheduledAt, null);
  assert.equal(client.scheduledTaskRuntimeStates.get(key)?.runningRunId, "running");
});

test("client, device and local workspace ownership are immutable and shared scope is rejected", (t) => {
  const { client, file } = fixture(t);
  const repo = workspaceConfigRepo(client, file);
  const scoped = scriptConfig({ workspaceScope: { scopeType: "local_workspace", scopeId: "workspace-1" }, payload: {
    shell: "bash", command: "true", contextWorkspaceId: "workspace-1" as any,
  } });
  const original = repo.create({ config: scoped, at: 100 });
  for (const config of [
    { ...scoped, clientId: "client-other" },
    { ...scoped, deviceId: "device-other" },
    { ...scoped, workspaceScope: null, payload: { shell: "sh", command: "true" } },
    { ...scoped, workspaceScope: { scopeType: "local_workspace", scopeId: "workspace-2" }, payload: {
      shell: "sh", command: "true", contextWorkspaceId: "workspace-2",
    } },
  ]) {
    assert.throws(() => repo.update({ config: config as LocalScheduledTaskConfigInput, expectedRevision: 1, at: 200 }),
      configError("SCHEDULED_TASK_CONFIG_OWNERSHIP_IMMUTABLE"));
    assert.deepEqual(repo.get(scoped.id), original);
  }
  assert.throws(() => repo.create({ config: scriptConfig({ id: "shared-task", workspaceScope: {
    scopeType: "shared_workspace", scopeId: "shared-1",
  } as any }), at: 200 }), configError("SCHEDULED_TASK_CONFIG_INVALID", "shared-task"));
});

test("workflow requires matching local workspace and preserves existing payload contract", (t) => {
  const { client, file } = fixture(t);
  const repo = workspaceConfigRepo(client, file);
  const config = scriptConfig({ taskType: "workflow", workspaceScope: { scopeType: "local_workspace", scopeId: "workspace-1" }, payload: {
    workflowId: "workflow-1" as any, contextWorkspaceId: "workspace-1" as any, workflowVersionPolicy: "latest",
    intake: { title: "定时需求" }, runMode: "normal", approvalMode: "default", interactionMode: "guided",
    skipWhenPreviousInstanceStatuses: ["running", "paused"],
  } });
  assert.deepEqual(repo.create({ config, at: 100 }).payload, config.payload);
  for (const [id, workspaceScope, payload] of [
    ["workflow-no-scope", null, config.payload],
    ["workflow-wrong-scope", { scopeType: "local_workspace", scopeId: "workspace-2" }, config.payload],
    ["workflow-no-context", config.workspaceScope, { workflowId: "workflow-1" }],
    ["script-context-no-scope", null, { shell: "sh", command: "true", contextWorkspaceId: "workspace-1" }],
  ] as const) {
    assert.throws(() => repo.create({ config: scriptConfig({ id, taskType: id.startsWith("workflow") ? "workflow" : "script",
      workspaceScope, payload } as any), at: 200 }), configError("SCHEDULED_TASK_CONFIG_INVALID", id));
  }
});

test("disable and tombstone stop scheduling, retain evidence and cannot be revived", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskConfigs;
  const saved = repo.create({ config: scriptConfig(), at: 100 });
  const disabled = repo.setEnabled({ taskId: saved.id, expectedRevision: 1, enabled: false, at: 200 });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.revision, 2);
  assert.deepEqual(repo.listSchedulable({ clientId: saved.clientId, deviceId: saved.deviceId }), []);
  assert.equal(repo.list({ clientId: saved.clientId, deviceId: saved.deviceId }).length, 1);
  const enabled = repo.setEnabled({ taskId: saved.id, expectedRevision: 2, enabled: true, at: 300 });
  assert.equal(enabled.revision, 3);
  assert.equal(repo.listSchedulable({ clientId: saved.clientId, deviceId: saved.deviceId }).length, 1);
  const deleted = repo.delete({ taskId: saved.id, expectedRevision: 3, at: 400 });
  assert.equal(deleted.revision, 4);
  assert.equal(deleted.deletedAt, 400);
  assert.equal(deleted.enabled, false);
  assert.deepEqual(deleted.payload, saved.payload);
  assert.equal(deleted.name, saved.name);
  assert.equal(repo.get(saved.id)?.deletedAt, 400);
  assert.deepEqual(repo.list({ clientId: saved.clientId, deviceId: saved.deviceId }), []);
  assert.deepEqual(repo.listSchedulable({ clientId: saved.clientId, deviceId: saved.deviceId }), []);
  for (const expectedRevision of [1, 4]) {
    assert.throws(() => repo.update({ config: scriptConfig(), expectedRevision, at: 500 }), configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
    assert.throws(() => repo.setEnabled({ taskId: saved.id, expectedRevision, enabled: true, at: 500 }), configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
    assert.throws(() => repo.delete({ taskId: saved.id, expectedRevision, at: 500 }), configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
  }
  assert.throws(() => repo.create({ config: scriptConfig(), at: 600 }), configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
  assert.deepEqual(repo.get(saved.id), deleted);
});

test("invalid input fails explicitly before persisting configuration", async (t) => {
  const cases: Array<[string, Partial<LocalScheduledTaskConfigInput>]> = [
    ["source", { source: "account" as any }], ["name", { name: "" }], ["description", { description: 1 as any }],
    ["cron", { cronExpr: "70 * * * *" }], ["timezone", { timezone: "Invalid/Zone" }],
    ["enabled", { enabled: "true" as any }], ["policy", { concurrencyPolicy: "overlap" as any }],
    ["missed", { missedPolicy: "unknown" as any }], ["timeout", { timeoutMs: 0 }],
    ["payload", { payload: null as any }], ["shell", { payload: { shell: "unknown", command: "true" } as any }],
    ["command", { payload: { shell: "sh", command: "" } }],
    ["envRefs", { payload: { shell: "sh", command: "true", envRefs: "PATH" } as any }],
    ["workflow-mode", { taskType: "workflow", workspaceScope: { scopeType: "local_workspace", scopeId: "workspace-1" }, payload: {
      workflowId: "workflow-1", contextWorkspaceId: "workspace-1", interactionMode: "invalid",
    } as any }],
  ];
  for (const [name, changes] of cases) await t.test(name, (subtest) => {
    const { client } = fixture(subtest);
    assert.throws(() => client.scheduledTaskConfigs.create({ config: scriptConfig(changes), at: 100 }), configError("SCHEDULED_TASK_CONFIG_INVALID"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), []);
  });
});

test("timezone whitespace fails create and update before changing stored configuration", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskConfigs;
  const invalid = scriptConfig({ timezone: " Asia/Shanghai " });
  assert.throws(() => repo.create({ config: invalid, at: 100 }), configError("SCHEDULED_TASK_CONFIG_INVALID"));
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), []);
  const saved = repo.create({ config: scriptConfig(), at: 100 });
  assert.throws(() => repo.update({ config: invalid, expectedRevision: 1, at: 200 }), configError("SCHEDULED_TASK_CONFIG_INVALID"));
  assert.deepEqual(repo.get(saved.id), saved);
});

test("corrupt JSON and stored fields fail reads and mutations without leaking payload or writes", async (t) => {
  const cases = [
    ["payload_json", "{secret-command"], ["payload_json", '{"shell":"sh","command":false}'],
    ["enabled", 2], ["source", "account"], ["revision", 0], ["timeout_ms", -1], ["cron_expr", "invalid"],
    ["timezone", "Invalid/Zone"], ["timezone", " Asia/Shanghai "],
    ["workspace_scope_type", "shared_workspace"], ["deleted_at", "corrupt"],
  ] as const;
  for (const [column, value] of cases) await t.test(`${column}:${value}`, (subtest) => {
    const { client } = fixture(subtest);
    const repo = client.scheduledTaskConfigs;
    repo.create({ config: scriptConfig(), at: 100 });
    client.db.exec("PRAGMA ignore_check_constraints = ON");
    client.db.prepare(`UPDATE scheduled_task_configs SET ${column} = ? WHERE id = ?`).run(value, "local-task-1");
    const before = client.db.prepare("SELECT * FROM scheduled_task_configs").all();
    for (const operation of [
      () => repo.get("local-task-1"),
      () => repo.list({ clientId: "client-1", deviceId: "device-1" }),
      () => repo.listSchedulable({ clientId: "client-1", deviceId: "device-1" }),
      () => repo.update({ config: scriptConfig(), expectedRevision: 1, at: 200 }),
      () => repo.setEnabled({ taskId: "local-task-1", expectedRevision: 1, enabled: false, at: 200 }),
      () => repo.delete({ taskId: "local-task-1", expectedRevision: 1, at: 200 }),
    ]) {
      assert.throws(operation, (error) => configError("SCHEDULED_TASK_CONFIG_CORRUPT")(error)
        && !String(error).includes("secret-command"));
      assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), before);
    }
  });
});

test("V90 upgrades atomically to the local config schema without importing legacy state", (t) => {
  const { client } = fixture(t);
  client.db.exec("DROP TABLE IF EXISTS scheduled_task_configs; PRAGMA user_version = 90");
  client.scheduledTaskRuntimeStates.markStarted({ taskId: "legacy-server-task", clientId: "client-1", deviceId: "device-1",
    scheduledAt: 90, runId: "run-old", startedAt: 90 });
  migrateClientDb(client.db);
  assert.equal(CLIENT_DB_READER_SCHEMA_VERSION, CLIENT_DB_SCHEMA_VERSION);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), []);
  assert.equal(client.scheduledTaskRuntimeStates.get("legacy-server-task")?.runningRunId, "run-old");
  migrateClientDb(client.db);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
});

test("failed V91 schema creation rolls back the table and version then permits retry", (t) => {
  const { client } = fixture(t);
  client.db.exec(`DROP TABLE IF EXISTS scheduled_task_configs; PRAGMA user_version = 90;
    CREATE TABLE idx_scheduled_task_configs_device (id TEXT);`);
  assert.throws(() => migrateClientDb(client.db), /idx_scheduled_task_configs_device/);
  assert.equal(client.db.pragma("user_version", { simple: true }), 90);
  assert.equal(client.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduled_task_configs'").get(), undefined);
  client.db.exec("DROP TABLE idx_scheduled_task_configs_device");
  migrateClientDb(client.db);
  assert.equal(client.db.pragma("user_version", { simple: true }), CLIENT_DB_SCHEMA_VERSION);
  assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), []);
});

test("SQLite write failure propagates and leaves the existing configuration unchanged", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskConfigs;
  const saved = repo.create({ config: scriptConfig(), at: 100 });
  client.db.exec(`CREATE TRIGGER reject_task_config_update BEFORE UPDATE ON scheduled_task_configs
    BEGIN SELECT RAISE(ABORT, 'injected-write-failure'); END;`);
  assert.throws(() => repo.update({ config: scriptConfig({ name: "未落盘" }), expectedRevision: 1, at: 200 }), (error) =>
    configError("SCHEDULED_TASK_CONFIG_STORAGE_FAILED")(error)
    && /^ERR_SQLITE_ERROR:1811$/.test((error as Error & { rootCauseCode: string }).rootCauseCode)
    && !String(error).includes("injected-write-failure"));
  assert.deepEqual(repo.get(saved.id), saved);
});

test("nonserializable payload fails with safe entity context before any SQLite write", (t) => {
  const { client } = fixture(t);
  const circular: Record<string, unknown> = { shell: "sh", command: "private-command" };
  circular.self = circular;
  for (const payload of [circular, { shell: "sh", command: "private-command", toJSON: () => undefined }]) {
    assert.throws(() => client.scheduledTaskConfigs.create({ config: scriptConfig({ payload: payload as any }), at: 100 }), (error) =>
      configError("SCHEDULED_TASK_CONFIG_INVALID")(error) && !String(error).includes("private-command"));
    assert.deepEqual(client.db.prepare("SELECT * FROM scheduled_task_configs").all(), []);
  }
});

test("a second connection cannot overwrite a revision committed by another connection", (t) => {
  const { client, file } = fixture(t);
  client.scheduledTaskConfigs.create({ config: scriptConfig(), at: 100 });
  const other = openClientDb({ dbPath: file });
  try {
    const stale = other.scheduledTaskConfigs.get("local-task-1")!;
    const saved = client.scheduledTaskConfigs.update({ config: scriptConfig({ name: "先提交" }), expectedRevision: 1, at: 200 });
    assert.throws(() => other.scheduledTaskConfigs.update({ config: { ...stale, name: "旧连接覆盖" }, expectedRevision: stale.revision, at: 300 }),
      configError("SCHEDULED_TASK_CONFIG_CONFLICT"));
    assert.deepEqual(other.scheduledTaskConfigs.get(stale.id), saved);
    assert.deepEqual(client.scheduledTaskConfigs.get(stale.id), saved);
  } finally { other.close(); }
});

test("invalid write-after-trigger state rolls back both update and trigger effects", (t) => {
  const { client } = fixture(t);
  const repo = client.scheduledTaskConfigs;
  const saved = repo.create({ config: scriptConfig(), at: 100 });
  client.db.exec(`CREATE TRIGGER corrupt_task_config_update AFTER UPDATE ON scheduled_task_configs
    BEGIN UPDATE scheduled_task_configs SET payload_json = '{private-command' WHERE id = NEW.id; END;`);
  assert.throws(() => repo.setEnabled({ taskId: saved.id, expectedRevision: 1, enabled: false, at: 200 }),
    configError("SCHEDULED_TASK_CONFIG_CORRUPT"));
  assert.deepEqual(repo.get(saved.id), saved);
});
