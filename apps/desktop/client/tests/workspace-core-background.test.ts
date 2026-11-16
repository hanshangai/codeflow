import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { OrchestrationAssetRuntimeSnapshot, OrchestrationId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { hashCodeAttributionOutboxPayload, type CodeAttributionOutboxPayload } from "../src/db/repos/codeAttributionOutboxRepo.js";
import { CodeAttributionSyncWorker } from "../src/orchestration/codeAttributionSyncWorker.js";
import { CodeAttributionRetentionWorker } from "../src/orchestration/codeAttributionRetentionWorker.js";
import { CodeAttributionHttpTransportError, type CodeAttributionHttpTransport } from "../src/orchestration/codeAttributionHttpTransport.js";
import { OrchAssetLegacyInstanceBackfillService } from "../src/orchestration/orchAssetLegacyInstanceBackfillService.js";
import { backfillEventOutputOnce } from "../src/diagnostics/eventOutputBackfill.js";
import { logger, type WorkspaceLogEntry } from "../src/logger.js";

const now = 1_000_000;
const instanceId = "same-instance" as OrchestrationId;
const outboxId = "same-outbox";
const retentionId = `code-attribution-retention:${"a".repeat(64)}`;

/** 所有工作区均为独立临时目录，后台owner仅持可重开view。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-core-background-"));
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  const views: ClientDb[] = [];
  for (const name of ["a", "b", "c"]) {
    const workspaceId = `background:${name}` as WorkspaceId, directory = path.join(root, name);
    fs.mkdirSync(directory);
    db.workspaces.upsert({ id: workspaceId, title: name, path: directory });
    const view = db.forWorkspace(workspaceId);
    db.applicationDb.prepare("UPDATE workspaces SET updated_at=? WHERE id=?").run(now - views.length, workspaceId);
    const workflow = { id: "workflow" as never, workspaceId, family: "feature-dev" as const, name: name,
      description: "", nodes: [], edges: [], version: 1 };
    const instance = view.orchInstances.create({ workspaceId, workflowId: workflow.id, workflowSnapshot: workflow,
      intakeSnapshot: { id: "intake" as never, workspaceId, title: name, triggerMode: "manual", taskType: "feature", goal: name, createdAt: 1, updatedAt: 1 } });
    view.db.transaction(() => {
      view.db.prepare("DELETE FROM orch_instance_summaries WHERE instance_id=?").run(instance.id);
      view.db.prepare("UPDATE orch_instances SET id=? WHERE id=?").run(instanceId, instance.id);
    })();
    views.push(view);
  }
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, views };
}

/** 不含源码的最小合法批次，同主键在不同W允许独立领取。 */
function enqueueOutbox(view: ClientDb) {
  const payload: CodeAttributionOutboxPayload = { commit: { sourceWorkspaceId: view.workspaceId!, sourceInstanceId: instanceId,
    repository: "repository", commitSha: "a".repeat(40), disposition: "matched", qualityStatus: "complete", qualityReasons: [],
    commitEvidenceSha256: "b".repeat(64), observedAt: 1 }, facts: [] };
  view.codeAttributionOutbox.enqueue({ id: outboxId, sourceBatchId: "same-batch", workspaceId: view.workspaceId!, instanceId,
    repository: "repository", commitSha: "a".repeat(40), payload, contentSha256: hashCodeAttributionOutboxPayload(payload),
    associationId: "association", associationExpiresAt: now + 1_000_000, now: 1 });
}

/** 留存任务只在领取W执行Git观察；无Git的隔离目录用于验证失败收尾。 */
function enqueueRetention(view: ClientDb) {
  view.codeAttributionRetentionTasks.enqueue({ id: retentionId, workspaceId: view.workspaceId!, instanceId,
    repositoryPath: "", repository: "repository", commitSha: "a".repeat(40), filePath: "file.ts", fileIdentitySha256: "b".repeat(64),
    retainedLines: [], retainedAiAddedLines: 0, windowDays: 7, dueAt: 1, now: 1 });
}

/** 测试只记录结构化错误，不输出payload。 */
function workerOptions() {
  const fatal: unknown[] = [];
  return { fatal, options: { now: () => now, leaseOwner: "background-test", pollIntervalMs: 10_000, hasDemand: () => true,
    logger: { info() {}, warn() {}, error() {} }, onFatalError(error: unknown) { fatal.push(error); } } };
}

/** 外部网络边界使用受控promise，持久化和租约仍使用真实SQLite。 */
function transport(upload: CodeAttributionHttpTransport["upload"]): CodeAttributionHttpTransport {
  return { upload, uploadRetention: async () => { throw new Error("UNEXPECTED_RETENTION_UPLOAD"); } } as CodeAttributionHttpTransport;
}

for (const kind of ["sync", "retention"] as const) {
  for (const state of ["retry", "leased", "terminal"] as const) {
    test(`${kind} 归因按需查询遇到${state}未同步事实必须失败`, async t => {
      const f = fixture(t), view = f.views[0]!;
      if (kind === "sync") enqueueOutbox(view); else enqueueRetention(view);
      const repository = kind === "sync" ? view.codeAttributionOutbox : view.codeAttributionRetentionTasks;
      const claimed = repository.claimNext({ leaseOwner: "other-owner", now, leaseMs: 10_000 });
      assert.ok(claimed);
      const id = kind === "sync" ? outboxId : retentionId;
      const settlement = { id, leaseOwner: "other-owner", errorCode: "TEST_UPLOAD_FAILED", now,
        ...(kind === "sync" ? { contentSha256: (claimed as any).record.contentSha256 } : {}) };
      if (state === "retry") repository.markFailed({ ...settlement, retryAt: now + 5_000 } as never);
      else if (state === "terminal") repository.markTerminalFailure(settlement as never);
      let uploads = 0;
      const rpc = transport(async () => { uploads++; throw new Error("UNEXPECTED_UPLOAD"); });
      rpc.uploadRetention = async () => { uploads++; throw new Error("UNEXPECTED_UPLOAD"); };
      const options = { ...workerOptions().options,
        listWorkspaceIds: () => [view.workspaceId!], hasDemand: (id: string) => id === view.workspaceId };
      const worker = kind === "sync" ? new CodeAttributionSyncWorker(f.db, rpc, options)
        : new CodeAttributionRetentionWorker(f.db, rpc, options);
      assert.equal(await worker.runOnce(), "idle");
      assert.throws(() => kind === "sync" ? view.codeAttributionOutbox.assertDrained({ throughCreatedAt: now })
        : view.codeAttributionRetentionTasks.assertDrained({ dueThrough: now }), (error: any) => error.code === (kind === "sync"
        ? "CODE_ATTRIBUTION_OUTBOX_NOT_DRAINED" : "CODE_ATTRIBUTION_RETENTION_TASK_NOT_DRAINED")
        && error.recordId === id && error.lastErrorCode === (state === "leased" ? null : "TEST_UPLOAD_FAILED"));
      assert.equal(uploads, 0);
      await worker.stop();
    });
  }
}

test("按需归因固定截止时间，忽略其后新增批次和未到期留存", async t => {
  const f = fixture(t), view = f.views[0]!;
  enqueueOutbox(view); enqueueRetention(view);
  view.db.prepare("UPDATE code_attribution_outbox SET created_at=?").run(now + 1);
  view.db.prepare("UPDATE code_attribution_retention_tasks SET due_at=?, available_at=?").run(now + 1, now + 1);
  assert.doesNotThrow(() => view.codeAttributionOutbox.assertDrained({ throughCreatedAt: now }));
  assert.doesNotThrow(() => view.codeAttributionRetentionTasks.assertDrained({ dueThrough: now }));
});

test("D18 同步成功日志只落领取W，不复制到应用logger", async t => {
  const f = fixture(t), a = f.views[0]!; enqueueOutbox(a);
  const app: unknown[] = [], logs: Array<{ id: WorkspaceId; message: string; data: unknown }> = [];
  t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId, entry: WorkspaceLogEntry) => { logs.push({ id, message: entry.message, data: entry.data }); });
  const h = workerOptions();
  h.options.logger.info = (...args: unknown[]) => { app.push(args); };
  const worker = new CodeAttributionSyncWorker(f.db, transport(async () => ({ reconciliationStatus: "complete" } as never)), h.options);
  assert.equal(await worker.runOnce(), "uploaded"); await worker.stop();
  assert.equal(logs.length, 1); assert.equal(logs[0]!.id, a.workspaceId);
  assert.match(logs[0]!.message, /batch synchronized/); assert.equal(app.length, 0);
});

for (const kind of ["sync", "retention"] as const) {
  test(`D18 ${kind} 未知Error的name getter不覆盖业务原错与W诊断`, async t => {
    const f = fixture(t), a = f.views[0]!, business = new Error("CLAIM_FAILED");
    let reads = 0;
    Object.defineProperty(business, "name", { get() { reads++; throw new Error("NAME_GETTER_MUST_NOT_RUN"); } });
    if (kind === "sync") t.mock.method(a.codeAttributionOutbox, "claimNext", () => { throw business; });
    else t.mock.method(a.codeAttributionRetentionTasks, "claimNext", () => { throw business; });
    const logs: Array<{ id: WorkspaceId; entry: WorkspaceLogEntry }> = [], write = f.db.writeWorkspaceLog;
    t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId, entry: WorkspaceLogEntry) => { logs.push({ id, entry }); write(id, entry); });
    const worker = kind === "sync" ? new CodeAttributionSyncWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }), workerOptions().options)
      : new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }), workerOptions().options);
    const running = worker.runOnce();
    await assert.rejects(running, error => error === business);
    assert.equal(worker.runOnce(), running);
    await assert.rejects(worker.stop(), error => error === business);
    assert.equal(reads, 0); assert.equal(logs.length, 1); assert.equal(logs[0]!.id, a.workspaceId);
    assert.equal((logs[0]!.entry.data as { rootCause: { name: string } }).rootCause.name, "Error");
  });
}

for (const rejected of [undefined, null, false, 0, "", NaN, new Error("ATTRIBUTION_LOG_REJECTED")]) {
  test(`D18 同步业务失败日志拒写 ${String(rejected)} 停止原租约结算`, async t => {
    const f = fixture(t), [a, b] = f.views; enqueueOutbox(a!); enqueueOutbox(b!);
    const business = new CodeAttributionHttpTransportError("CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 503, "INTERNAL_ERROR", "attribution-r", "controlled");
    t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId) => { assert.equal(id, a!.workspaceId); throw rejected; });
    const worker = new CodeAttributionSyncWorker(f.db, transport(async () => { throw business; }), workerOptions().options);
    await assert.rejects(worker.runOnce(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], business);
      assert.ok(Object.is(error.errors[1], rejected)); assert.equal(error.cause, business); return true;
    });
    await assert.rejects(worker.stop());
    assert.equal(a!.codeAttributionOutbox.get(outboxId)?.status, "leased");
    assert.equal(b!.codeAttributionOutbox.get(outboxId)?.status, "pending");
  });
}

for (const kind of ["sync", "retention"] as const) {
  test(`D18 ${kind} timer 的业务、日志和fatal回调三错保原stop消费`, async t => {
    const f = fixture(t), a = f.views[0]!, business = new Error(`${kind}_CLAIM_FAILED`), diagnostic = new Error(`${kind}_LOG_FAILED`), fatal = new Error(`${kind}_FATAL_FAILED`);
    if (kind === "sync") t.mock.method(a.codeAttributionOutbox, "claimNext", () => { throw business; });
    else t.mock.method(a.codeAttributionRetentionTasks, "claimNext", () => { throw business; });
    t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId) => { assert.equal(id, a.workspaceId); throw diagnostic; });
    let observed!: (error: unknown) => void;
    const reached = new Promise<unknown>(resolve => { observed = resolve; });
    const options = { ...workerOptions().options, onFatalError(error: unknown) { observed(error); throw fatal; } };
    const worker = kind === "sync" ? new CodeAttributionSyncWorker(f.db, transport(async () => { throw new Error("unexpected upload"); }), options)
      : new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("unexpected upload"); }), options);
    worker.start();
    const original = await reached;
    assert.ok(original instanceof AggregateError); assert.deepEqual(original.errors, [business, diagnostic]);
    await assert.rejects(worker.stop(), error => {
      assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, fatal]); assert.equal(error.cause, original); return true;
    });
  });
}

test("D18 留存Git观察日志拒写保业务和诊断双因，任务保持leased", async t => {
  const f = fixture(t), a = f.views[0]!; enqueueRetention(a);
  const diagnostic = new Error("RETENTION_LOG_REJECTED");
  t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId) => { assert.equal(id, a.workspaceId); throw diagnostic; });
  const worker = new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("unexpected upload"); }), workerOptions().options);
  await assert.rejects(worker.runOnce(), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], diagnostic); assert.equal(error.cause, error.errors[0]); return true;
  });
  await assert.rejects(worker.stop());
  assert.equal(a.codeAttributionRetentionTasks.get(retentionId)?.status, "leased");
});

test("D18 同步删除已提交后完成日志拒写不重建记录，stop消费原错", async t => {
  const f = fixture(t), a = f.views[0]!; enqueueOutbox(a);
  const diagnostic = new Error("ATTRIBUTION_DONE_LOG_FAILED");
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw diagnostic; });
  const worker = new CodeAttributionSyncWorker(f.db, transport(async () => ({ reconciliationStatus: "complete" } as never)), workerOptions().options);
  let original: unknown;
  await assert.rejects(worker.runOnce(), error => { original = error; assert.equal((error as Error).cause, diagnostic); return true; });
  assert.equal(a.codeAttributionOutbox.get(outboxId), null);
  assert.throws(() => worker.start(), error => error === original);
  await assert.rejects(worker.stop(), error => error === original);
  await worker.stop();
});

test("D18 同步业务、failed结算和诊断三错保原树，后续W不派发", async t => {
  const f = fixture(t), [a, b] = f.views; enqueueOutbox(a!); enqueueOutbox(b!);
  const business = new CodeAttributionHttpTransportError("CODE_ATTRIBUTION_SYNC_SERVER_REJECTED", 503, "INTERNAL_ERROR", "request", "controlled"),
    storage = new Error("ATTRIBUTION_MARK_FAILED"), diagnostic = new Error("ATTRIBUTION_MARK_LOG_FAILED");
  t.mock.method(a!.codeAttributionOutbox, "markFailed", () => { throw storage; });
  t.mock.method(f.db, "writeWorkspaceLog", (_id: WorkspaceId, entry: WorkspaceLogEntry) => { if (entry.message === "code attribution failure settlement failed") throw diagnostic; });
  const worker = new CodeAttributionSyncWorker(f.db, transport(async () => { throw business; }), workerOptions().options);
  let original: unknown;
  await assert.rejects(worker.runOnce(), error => {
    original = error; assert.ok(error instanceof AggregateError); assert.equal(error.errors[1], diagnostic);
    assert.deepEqual(error.errors[0].errors, [business, storage]); assert.equal(error.cause, error.errors[0]); return true;
  });
  await assert.rejects(worker.stop(), error => error === original);
  assert.equal(a!.codeAttributionOutbox.get(outboxId)?.status, "leased");
  assert.equal(b!.codeAttributionOutbox.get(outboxId)?.status, "pending");
});

for (const kind of ["sync", "retention"] as const) {
  test(`D18 ${kind} stop 等待异步fatal回调完成后消费原错误`, async t => {
    const f = fixture(t), a = f.views[0]!, business = new Error(`${kind}_ASYNC_FATAL`);
    if (kind === "sync") t.mock.method(a.codeAttributionOutbox, "claimNext", () => { throw business; });
    else t.mock.method(a.codeAttributionRetentionTasks, "claimNext", () => { throw business; });
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    const options = { ...workerOptions().options, async onFatalError(error: unknown) { assert.equal(error, business); entered(); await pending; } };
    const worker = kind === "sync" ? new CodeAttributionSyncWorker(f.db, transport(async () => { throw new Error("unexpected upload"); }), options)
      : new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("unexpected upload"); }), options);
    worker.start(); await reached;
    let settled = false;
    const stopping = worker.stop().then(() => { settled = true; }, error => { settled = true; throw error; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
    release(); await assert.rejects(stopping, error => error === business); await worker.stop();
  });
}

test("root同步worker逐W领取并只结算领取来源，同outboxId互不覆盖", async t => {
  const f = fixture(t), [a, b] = f.views;
  enqueueOutbox(a!); enqueueOutbox(b!);
  const uploaded: string[] = [], h = workerOptions();
  const worker = new CodeAttributionSyncWorker(f.db, transport(async batch => {
    uploaded.push(batch.commit.sourceWorkspaceId); return { reconciliationStatus: "complete" } as never;
  }), h.options);
  t.after(() => worker.stop());
  assert.equal(await worker.runOnce(), "uploaded");
  assert.deepEqual(uploaded, [a!.workspaceId]);
  assert.equal(a!.codeAttributionOutbox.get(outboxId), null);
  assert.equal(b!.codeAttributionOutbox.get(outboxId)?.status, "pending");
  assert.equal(await worker.runOnce(), "uploaded");
  assert.deepEqual(uploaded, [a!.workspaceId, b!.workspaceId]);
  assert.equal(b!.codeAttributionOutbox.get(outboxId), null);
});

test("后台领取惰性打开可信W，首库有任务时不初始化后续库", async t => {
  const f = fixture(t), [a, b] = f.views;
  enqueueOutbox(a!); enqueueRetention(a!);
  const opened: string[] = [];
  const original = f.db.forWorkspace;
  f.db.forWorkspace = id => { opened.push(id); return original(id); };
  const h = workerOptions();
  const sync = new CodeAttributionSyncWorker(f.db, transport(async () => ({ reconciliationStatus: "complete" } as never)),
    { ...h.options, listWorkspaceIds: () => [a!.workspaceId!, b!.workspaceId!] });
  const retention = new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }),
    { ...h.options, listWorkspaceIds: () => [a!.workspaceId!, b!.workspaceId!] });
  t.after(async () => { await sync.stop(); await retention.stop(); });
  assert.equal(await sync.runOnce(), "uploaded");
  assert.deepEqual(opened, [a!.workspaceId]);
  opened.length = 0;
  assert.equal(await retention.runOnce(), "failed");
  assert.deepEqual(opened, [a!.workspaceId]);
});

test("后台来源沿现有可信W集合，不读取被启动隔离的注册库", async t => {
  const f = fixture(t), [a] = f.views;
  const opened: string[] = [];
  const original = f.db.forWorkspace;
  f.db.forWorkspace = id => {
    opened.push(id);
    if (id !== a!.workspaceId) throw new Error("ISOLATED_WORKSPACE_OPENED");
    return original(id);
  };
  const h = workerOptions();
  const options = { ...h.options, listWorkspaceIds: () => [a!.workspaceId!] };
  const sync = new CodeAttributionSyncWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }), options);
  const retention = new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }), options);
  t.after(async () => { await sync.stop(); await retention.stop(); });
  assert.equal(await sync.runOnce(), "idle");
  assert.equal(await retention.runOnce(), "idle");
  assert.deepEqual(opened, [a!.workspaceId, a!.workspaceId]);
});

test("定时任务队列领域失败穿过W opener保原身份和业务关联，之后连接可重开", t => {
  const f = fixture(t), workspaceId = f.views[0]!.workspaceId!;
  const failure = Object.assign(new Error("账户任务队列对账失败"), {
    code: "SCHEDULED_TASK_ACCOUNT_QUEUE_RECONCILE_FAILED", taskId: "task", scheduledAt: now,
  });
  assert.throws(() => f.db.withLocalScheduledTasks(workspaceId, () => { throw failure; }), error => error === failure);
  assert.equal(f.db.withLocalScheduledTasks(workspaceId, repos => (repos.db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok), 1);
});

test("未知上传异常不删除领取记录，stop等待唯一在途上传结算", async t => {
  const f = fixture(t), [a, b] = f.views;
  enqueueOutbox(a!); enqueueOutbox(b!);
  let release!: () => void, entered!: () => void;
  const uploading = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const h = workerOptions(), failure = new Error("INJECTED_UPLOAD_FAILURE");
  const worker = new CodeAttributionSyncWorker(f.db, transport(async () => { entered(); await pending; throw failure; }), h.options);
  const running = worker.runOnce();
  await uploading;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await assert.rejects(running, error => error === failure);
  await assert.rejects(stopping, error => error === failure);
  assert.equal(a!.codeAttributionOutbox.get(outboxId)?.status, "leased");
  assert.equal(b!.codeAttributionOutbox.get(outboxId)?.status, "pending");
});

test("定时同步出现持久化错误时触发原fatal边界并停止后续W", async t => {
  const f = fixture(t), [a, b] = f.views;
  enqueueOutbox(a!); enqueueOutbox(b!);
  const failure = new Error("INJECTED_CLAIM_FAILURE");
  a!.codeAttributionOutbox.claimNext = () => { throw failure; };
  let failed!: (error: unknown) => void;
  const observed = new Promise<unknown>(resolve => { failed = resolve; });
  let calls = 0;
  const h = workerOptions();
  const worker = new CodeAttributionSyncWorker(f.db, transport(async () => { calls++; return {} as never; }),
    { ...h.options, onFatalError: failed });
  worker.start();
  assert.equal(await observed, failure);
  await assert.rejects(worker.stop(), error => error === failure);
  assert.equal(calls, 0);
  assert.equal(b!.codeAttributionOutbox.get(outboxId)?.status, "pending");
});

test("留存观察失败只回写领取W，禁止上传和结算其他W同ID任务", async t => {
  const f = fixture(t), [a, b] = f.views;
  enqueueRetention(a!); enqueueRetention(b!);
  const h = workerOptions();
  const worker = new CodeAttributionRetentionWorker(f.db, transport(async () => { throw new Error("UNEXPECTED_UPLOAD"); }), h.options);
  t.after(() => worker.stop());
  assert.equal(await worker.runOnce(), "failed");
  assert.equal(a!.codeAttributionRetentionTasks.get(retentionId)?.status, "failed");
  assert.equal(a!.codeAttributionRetentionTasks.get(retentionId)?.lastErrorCode, "CODE_ATTRIBUTION_RETENTION_GIT_OBSERVATION_FAILED");
  assert.equal(b!.codeAttributionRetentionTasks.get(retentionId)?.status, "pending");
});

test("历史实例补录要求可信W，同instanceId的图和事件在同一W原子提交", t => {
  const f = fixture(t), [a, b] = f.views;
  const service = new OrchAssetLegacyInstanceBackfillService(f.db, { createFromWorkflow(_workspaceId, workflow) {
    return { authorityMode: "legacy", workflow: { assetType: "workflow", assetId: workflow.id, definition: workflow, source: null },
      roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {} } as OrchestrationAssetRuntimeSnapshot;
  } });
  assert.throws(() => service.ensureForExecution(instanceId), /WORKSPACE.*REQUIRED/);
  assert.equal(service.ensureForExecution(instanceId, a!.workspaceId!)?.workflow.definition.name, "a");
  assert.equal(a!.orchEvents.listByInstance(instanceId).length, 1);
  assert.equal(b!.orchInstances.get(instanceId)?.assetRuntimeSnapshot, null);
  b!.db.exec("CREATE TRIGGER fail_backfill BEFORE INSERT ON orch_events BEGIN SELECT RAISE(ABORT, 'INJECTED_BACKFILL_EVENT'); END;");
  assert.throws(() => service.ensureForExecution(instanceId, b!.workspaceId!), /INJECTED_BACKFILL_EVENT/);
  assert.equal(b!.orchInstances.get(instanceId)?.assetRuntimeSnapshot, null);
  assert.equal(b!.orchEvents.listByInstance(instanceId).length, 0);
});

test("输出整理逐W提交，B损坏JSON显式失败且不标完成、不处理C", t => {
  const f = fixture(t), originals: string[] = [];
  for (const [i, view] of f.views.entries()) {
    const threadId = "same-thread" as never;
    view.threads.create({ id: threadId, workspaceId: view.workspaceId!, engine: "codex", title: "历史输出" });
    const event = i === 1 ? "{broken" : JSON.stringify({ schema: 1, seq: 1, ts: 1, workspaceId: view.workspaceId,
      threadId, engine: "codex", type: "item.tool.outputDelta", payload: { itemId: "tool", delta: "完整工具输出" } });
    originals.push(event);
    view.db.prepare("INSERT INTO conversation_events(seq,thread_id,workspace_id,engine,type,event_json,ts) VALUES(1,?,?, 'codex','item.tool.outputDelta',?,1)")
      .run(threadId, view.workspaceId, event);
  }
  assert.throws(() => backfillEventOutputOnce(f.db), /EVENT_OUTPUT_BACKFILL_ROW_INVALID/);
  const [a, b, c] = f.views;
  assert.notEqual((a!.db.prepare("SELECT event_json FROM conversation_events WHERE seq=1").get() as { event_json: string }).event_json, originals[0]);
  assert.ok(a!.db.prepare("SELECT value FROM meta WHERE key='event_output_backfill_v2_tool_only'").get());
  assert.equal(b!.db.prepare("SELECT value FROM meta WHERE key='event_output_backfill_v2_tool_only'").get(), undefined);
  assert.equal((c!.db.prepare("SELECT event_json FROM conversation_events WHERE seq=1").get() as { event_json: string }).event_json, originals[2]);
  assert.equal(f.db.applicationDb.prepare("SELECT value FROM meta WHERE key='event_output_backfill_v2_tool_only'").get(), undefined);
});

test("输出整理日志逐可信W落盘且应用无同条", t => {
  const f = fixture(t), application = t.mock.method(logger, "info", () => {});
  backfillEventOutputOnce(f.db);
  for (const view of f.views) {
    const directory = path.join(f.db.workspaces.get(view.workspaceId!)!.path, ".codeflowai");
    const logs = fs.readdirSync(directory).filter(name => name.endsWith(".log"))
      .map(name => fs.readFileSync(path.join(directory, name), "utf8")).join("");
    assert.match(logs, /startup backfill started/);
    assert.match(logs, /startup backfill finished/);
    assert.ok(logs.includes(view.workspaceId!));
  }
  assert.equal(application.mock.callCount(), 0);
});

test("输出整理完成日志失败保留真实完成标记并停止后续W", t => {
  const f = fixture(t), [a, b, c] = f.views;
  const failure = { diagnostic: "writer-failed" }, original = b!.writeWorkspaceLog;
  t.mock.method(b!, "writeWorkspaceLog", (workspaceId: WorkspaceId, entry: WorkspaceLogEntry) => {
    if (entry.message === "startup backfill finished") throw failure;
    original(workspaceId, entry);
  });
  assert.throws(() => backfillEventOutputOnce(f.db), error => error === failure);
  for (const view of [a!, b!]) assert.ok(view.db.prepare("SELECT value FROM meta WHERE key='event_output_backfill_v2_tool_only'").get());
  assert.equal(c!.db.prepare("SELECT value FROM meta WHERE key='event_output_backfill_v2_tool_only'").get(), undefined);
  assert.equal(backfillEventOutputOnce(b!).skippedReason, "already_done");
});

test("输出整理业务和日志双错不执行未知getter且保留两原值", t => {
  const f = fixture(t), view = f.views[0]!;
  let reads = 0;
  const business = Object.create(null, { code: { get() { reads++; throw new Error("must not read"); } },
    toString: { get() { reads++; throw new Error("must not convert"); } } });
  t.mock.method(view.db, "prepare", () => { throw business; });
  const writer = { diagnostic: "writer-failed" };
  t.mock.method(view, "writeWorkspaceLog", () => { throw writer; });
  assert.throws(() => backfillEventOutputOnce(view), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [business, writer]);
    assert.equal(error.cause, business);
    return true;
  });
  assert.equal(reads, 0);
});
