import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { Worker } from "node:worker_threads";
import type { WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { WorkspacePathIndexService } from "../src/fs/workspacePathIndexService.js";
import { openWorkspacePathIndexDb, WorkspacePathIndexDb } from "../src/fs/workspacePathIndexDb.js";
import { logger } from "../src/logger.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

/** 只控制 Worker 退出，索引数据库、固定日志和注册根均使用真实实现。 */
class IndexWorker extends EventEmitter {
  terminateCalls = 0;
  release: (() => void) | null = null;
  delayExit = false;
  terminateFailure: { reason: unknown } | null = null;
  constructor(readonly data: { workspaceId: WorkspaceId; generation: number; configStamp: string; excludeRulesStamp: string; policyStamp: string; maxEntries: number }) { super(); }
  /** 完成空 generation，发布事务仍由原 service 执行。 */
  complete(): void {
    this.emit("message", { type: "done", ...this.data, indexedCount: 0, skippedDirCount: 0, partial: false });
  }
  /** 延迟模式直到显式释放才同时完成真实退出观察和 terminate Promise。 */
  terminate(): Promise<number> {
    this.terminateCalls++;
    if (this.terminateFailure) return Promise.reject(this.terminateFailure.reason);
    return new Promise(resolve => {
      const finish = (): void => { this.emit("exit", 0); resolve(0); };
      if (this.delayExit) this.release = finish;
      else finish();
    });
  }
}

/** 等待公开生命周期的可观察条件，防止使用宽松状态证明成功。 */
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("index observation timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** 每例注册可信 W，排空原 owner 后再关闭真实连接和临时目录。 */
async function fixture(t: TestContext, action: (f: { db: ReturnType<typeof openClientDb>; root: string; workspace: string;
  workspaceId: WorkspaceId; gate: WorkspaceOperationGate; service: WorkspacePathIndexService; workers: IndexWorker[] }) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-index-w-log-")), workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const gate = new WorkspaceOperationGate();
  const db = openClientDb({ dbPath: path.join(root, "client.db"), workspaceOperationGate: gate }), workspaceId = "local:index-log" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "index", path: workspace });
  const workers: IndexWorker[] = [];
  const service = new WorkspacePathIndexService({ writeWorkspaceLog: (id, entry) => db.writeWorkspaceLog(id, entry), warmupDelayMs: 0,
    workerFactory: (_workerPath, data) => { const worker = new IndexWorker(data); workers.push(worker); return worker as unknown as Worker; } });
  const failures: unknown[] = [];
  try { await action({ db, root, workspace, workspaceId, gate, service, workers }); }
  catch (error) { failures.push(error); }
  finally {
    for (const worker of workers) worker.release?.();
    try { await service.dispose(); } catch (error) { failures.push(error); }
    try { db.close(); } catch (error) { failures.push(error); }
    t.mock.restoreAll();
    try { fs.rmSync(root, { recursive: true }); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "index fixture cleanup failed", { cause: failures[0] });
  }
}

test("D18 文件索引开始与完成续写可信 W 日志，保原 requestId", async t => fixture(t, async f => {
  const applicationLogs: unknown[] = [];
  t.mock.method(logger, "info", (...args: unknown[]) => { applicationLogs.push(args); });
  f.service.rebuildWorkspace(f.workspaceId, f.workspace, { requestId: "index-log-request" });
  await until(() => f.workers.length === 1);
  f.workers[0]!.complete();
  await f.service.waitForIdle();
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
  const directory = path.join(f.workspace, ".codeflowai");
  const content = fs.readdirSync(directory).filter(file => file.endsWith(".log")).map(file => fs.readFileSync(path.join(directory, file), "utf8")).join("");
  assert.match(content, /workspace path index build started/);
  assert.match(content, /workspace path index build finished/);
  assert.match(content, /index-log-request/);
  assert.equal(JSON.stringify(applicationLogs).includes("workspace path index build"), false);
}));

test("D18 publish 提交后 cleanup 失败仍保 active，公开等待交付原错误", async t => fixture(t, async f => {
  const original = new Error("INDEX_POST_COMMIT_CLEANUP_FAILED"), publish = WorkspacePathIndexDb.prototype.publishBuild;
  t.mock.method(WorkspacePathIndexDb.prototype, "publishBuild", function (this: WorkspacePathIndexDb, ...args: Parameters<WorkspacePathIndexDb["publishBuild"]>) {
    publish.apply(this, args); throw original;
  });
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1); f.workers[0]!.complete();
  await assert.rejects(f.service.waitForIdle(), error => error === original);
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
}));

test("D18 已发布 generation 的生命周期失败不伪造 failed，后续订阅停止", async t => fixture(t, async f => {
  const original = new Error("INDEX_DONE_LISTENER_FAILED"), observed: string[] = [];
  f.service.subscribeLifecycle(event => { if (event.type === "done") throw original; });
  f.service.subscribeLifecycle(event => { observed.push(event.type); });
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1); f.workers[0]!.complete();
  await assert.rejects(f.service.waitForIdle(), error => (error as Error).cause === original);
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
  assert.deepEqual(observed, ["building"]);
}));

/** 仅展开本错误树的原对象，保留顺序和 undefined/null/NaN，不读取错误正文。 */
function leaves(error: unknown): unknown[] {
  if (error instanceof AggregateError) return error.errors.flatMap(leaves);
  if (error instanceof Error && error.cause !== undefined) return leaves(error.cause);
  return [error];
}

for (const logFailure of [undefined, null, false, 0, "", NaN, new Error("INDEX_OPERATION_LOG_FAILED")]) {
  test(`D18 原业务、日志假值 ${String(logFailure)} 与终止副错由同 owner 顺序交付`, async t => fixture(t, async f => {
    const business = new Error("INDEX_WORKER_BUSINESS_FAILED"), cleanup = new Error("INDEX_TERMINATE_FAILED");
    t.mock.method(f.db, "writeWorkspaceLog", (_id: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
      if (entry.message === "workspace path index operation failed") throw logFailure;
    });
    f.service.rebuildWorkspace(f.workspaceId, f.workspace);
    await until(() => f.workers.length === 1);
    const worker = f.workers[0]!; worker.terminateFailure = { reason: cleanup };
    worker.emit("error", business);
    await assert.rejects(f.service.waitForIdle(), error => {
      const causes = leaves(error);
      assert.equal(causes.length, 3); assert.equal(causes[0], business);
      assert.ok(Object.is(causes[1], logFailure)); assert.equal(causes[2], cleanup); return true;
    });
    worker.terminateFailure = null;
    await assert.doesNotReject(f.service.terminateWorkspaceRebuild(f.workspaceId, worker.data.generation, "retry termination"), "retry termination failed");
    await assert.doesNotReject(f.service.waitForIdle(), "retry drain failed");
  }));
}

test("D18 固定日志独占拒写不旁路或转应用日志，释放后原 W 可重试", async t => fixture(t, async f => {
  const application: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => { application.push(args); });
  const blocker = path.join(f.workspace, ".codeflowai"); fs.writeFileSync(blocker, "block controls");
  const release = await f.gate.acquireMigration(f.workspaceId, "index-gate");
  try {
    assert.throws(() => f.service.reserveWorkspaceRebuild(f.workspaceId, f.workspace, { requestId: "index-gate-request" }), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
      assert.equal(error.errors[1].code, "WORKSPACE_MIGRATION_IN_PROGRESS"); return true;
    });
    assert.equal(application.length, 0); assert.equal(f.workers.length, 0);
    assert.equal(fs.readdirSync(f.workspace).some(file => file.endsWith(".log")), false);
  } finally { release(); }
  fs.unlinkSync(blocker);
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1); f.workers[0]!.complete(); await f.service.waitForIdle();
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
}));

test("D18 W1 开始日志拒写后，W2 仍能沿原单 Worker 名额完成", async t => fixture(t, async f => {
  const original = new Error("INDEX_START_LOG_FAILED"), secondId = "local:index-log-2" as WorkspaceId, secondRoot = path.join(f.root, "second");
  fs.mkdirSync(secondRoot); f.db.workspaces.upsert({ id: secondId, title: "second", path: secondRoot });
  t.mock.method(f.db, "writeWorkspaceLog", (id: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    if (id === f.workspaceId && entry.message === "workspace path index build started") throw original;
  });
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await assert.rejects(f.service.waitForIdle(), error => (error as Error).cause === original);
  f.service.rebuildWorkspace(secondId, secondRoot);
  await until(() => f.workers.length === 2); f.workers[1]!.complete(); await f.service.waitForIdle();
  assert.equal(f.service.search(secondId, secondRoot, "x").indexStatus, "ready");
}));

test("D18 业务、close、日志与terminate多错均保原对象和顺序", async t => fixture(t, async f => {
  const business = new Error("INDEX_BUSINESS"), closeFailure = new Error("INDEX_CLOSE"), logFailure = new Error("INDEX_LOG"), terminateFailure = new Error("INDEX_TERMINATE");
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1);
  const close = WorkspacePathIndexDb.prototype.close;
  t.mock.method(WorkspacePathIndexDb.prototype, "close", function (this: WorkspacePathIndexDb) { close.call(this); throw closeFailure; });
  t.mock.method(f.db, "writeWorkspaceLog", (_id: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    if (entry.message === "workspace path index operation failed") throw logFailure;
  });
  const worker = f.workers[0]!; worker.terminateFailure = { reason: terminateFailure };
  worker.emit("error", business);
  await assert.rejects(f.service.waitForIdle(), error => {
    assert.deepEqual(leaves(error), [business, closeFailure, logFailure, terminateFailure]); return true;
  });
  worker.terminateFailure = null;
  await f.service.terminateWorkspaceRebuild(f.workspaceId, worker.data.generation, "retry");
  await f.service.waitForIdle();
}));

test("D18 非法设置和日志双错由原search显式拒绝，不读取实时文件", async t => fixture(t, async f => {
  const logFailure = new Error("INDEX_SETTINGS_LOG_FAILED");
  fs.writeFileSync(path.join(f.workspace, ".codeflowai"), "invalid controls");
  fs.writeFileSync(path.join(f.workspace, "visible.txt"), "must not become a fallback result");
  let writes = 0;
  t.mock.method(f.db, "writeWorkspaceLog", (_id: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    writes++; assert.equal((entry.data as { requestId: string }).requestId, "invalid-settings-request"); throw logFailure;
  });
  let original: unknown;
  for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => f.service.search(f.workspaceId, f.workspace, "visible", {}, { requestId: "invalid-settings-request" }), error => {
    if (attempt === 0) original = error;
    assert.equal(error, original); assert.ok(error instanceof AggregateError);
    assert.match(error.errors[0].message, /codeflowai.*普通目录/u); assert.equal(error.errors[1], logFailure);
    assert.equal(error.cause, error.errors[0]); return true;
  });
  assert.equal(writes, 1);
}));

test("D18 查询业务与日志双错不实时降级，重复请求保持原对象", async t => fixture(t, async f => {
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1); f.workers[0]!.complete(); await f.service.waitForIdle();
  const business = new Error("INDEX_QUERY_FAILED"), diagnostic = new Error("INDEX_QUERY_LOG_FAILED");
  t.mock.method(WorkspacePathIndexDb.prototype, "search", () => { throw business; });
  t.mock.method(f.db, "writeWorkspaceLog", () => { throw diagnostic; });
  let original: unknown;
  for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => f.service.search(f.workspaceId, f.workspace, "visible"), error => {
    if (attempt === 0) original = error;
    assert.equal(error, original); assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [business, diagnostic]); assert.equal(error.cause, business); return true;
  });
}));

test("D18 完成日志拒写保已提交 active，原 wait 交付同一诊断失败", async t => fixture(t, async f => {
  const logFailure = new Error("INDEX_FINISH_LOG_REJECTED");
  t.mock.method(f.db, "writeWorkspaceLog", (_id: WorkspaceId, entry: Parameters<typeof f.db.writeWorkspaceLog>[1]) => {
    if (entry.message === "workspace path index build finished") throw logFailure;
  });
  const events: string[] = [];
  f.service.subscribeLifecycle(event => { events.push(event.type); });
  f.service.rebuildWorkspace(f.workspaceId, f.workspace, { requestId: "finish-request" });
  await until(() => f.workers.length === 1);
  f.workers[0]!.complete();
  await assert.rejects(f.service.waitForIdle(), error => {
    assert.equal((error as { cause: unknown }).cause, logFailure); return true;
  });
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
  const data = f.workers[0]!.data;
  const db = openWorkspacePathIndexDb({ workspaceId: f.workspaceId, workspacePath: f.workspace,
    settings: { configStamp: data.configStamp, excludeRulesStamp: data.excludeRulesStamp, policyStamp: data.policyStamp, maxEntries: data.maxEntries } });
  try { assert.equal(db.getMeta().activeGeneration, f.workers[0]!.data.generation); }
  finally { db.close(); }
  assert.deepEqual(events, ["building"], "日志拒写后不再发布成功或伪造 failed 生命周期");
  await f.service.waitForIdle();
}));

test("D18 dispose 等真实 terminate，退出前不清资源或宣称完成", async t => fixture(t, async f => {
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1);
  const worker = f.workers[0]!; worker.delayExit = true;
  let done = false;
  const disposal = f.service.dispose().then(() => { done = true; });
  await until(() => worker.terminateCalls === 1);
  assert.equal(done, false);
  worker.release!();
  await disposal;
  assert.equal(done, true);
}));

test("D18 迁移 prepareOnly 更新根时不打开或排队目标索引", async t => fixture(t, async f => {
  f.service.upsertWorkspace(f.workspaceId, f.workspace);
  const target = path.join(f.root, "target"); fs.mkdirSync(target);
  f.db.workspaces.upsert({ id: f.workspaceId, title: "index", path: target });
  f.service.upsertWorkspace(f.workspaceId, target, { prepareOnly: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.workers.length, 0);
  assert.equal(fs.existsSync(path.join(target, ".codeflowai")), false);
  const reservation = f.service.reserveWorkspaceRebuild(f.workspaceId, target);
  assert.equal(reservation.kind, "reserved");
  if (reservation.kind !== "reserved") throw new Error("missing reservation");
  f.service.startReservedWorkspaceRebuild(f.workspaceId, reservation.generation);
  await until(() => f.workers.length === 1);
  f.workers[0]!.complete();
  await f.service.waitForIdle();
}));

test("D18 相同目标根 prepareOnly 也停止旧排队，release 后仍能原路径重建", async t => fixture(t, async f => {
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  f.service.upsertWorkspace(f.workspaceId, f.workspace, { prepareOnly: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.workers.length, 0);
  f.service.rebuildWorkspace(f.workspaceId, f.workspace);
  await until(() => f.workers.length === 1); f.workers[0]!.complete(); await f.service.waitForIdle();
  assert.equal(f.service.search(f.workspaceId, f.workspace, "x").indexStatus, "ready");
}));
