import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ThreadId, WorkspaceId } from "@codeflowai/shared";
import { openClientDb } from "../src/db/clientDb.js";
import { ClientDbReaderError, ClientDbReaderService } from "../src/db/clientDbReaderService.js";
import { ClientDbCleanupService } from "../src/db/clientDbCleanupService.js";
import { openSqliteDb } from "../src/db/sqliteDb.js";

/** 仅建立本例的应用与真实 W 库，Reader 来源使用文件身份核验。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reader-cleanup-"));
  const dbPath = path.join(root, "app.db");
  const db = openClientDb({ dbPath });
  const workspaces = ["reader:a", "reader:b", "reader:c"].map(id => {
    const workspaceId = id as WorkspaceId;
    const workspacePath = path.join(root, id.replace(":", "-"));
    fs.mkdirSync(workspacePath);
    db.workspaces.upsert({ id: workspaceId, title: id, path: workspacePath });
    const view = db.forWorkspace(workspaceId);
    view.threads.create({ id: "same" as ThreadId, workspaceId, engine: "codex", title: id });
    view.db.prepare("UPDATE threads SET updated_at = 100 WHERE id = 'same'").run();
    view.conversationEvents.appendEnvelope({ schema: 1, seq: 1, ts: 100, workspaceId, threadId: "same" as ThreadId,
      engine: "codex", type: "thread.started", payload: {} });
    return { workspaceId, workspacePath, view };
  });
  workspaces.forEach(({ workspaceId }, index) => db.applicationDb.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(100 - index, workspaceId));
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, dbPath, workspaces };
}

test("原 Reader 每请求读取所属 DELETE 工作区并在响应前关闭读租约", async t => {
  const f = fixture(t);
  for (const { workspaceId, view } of f.workspaces) {
    view.orchIntakes.upsert({ id: "same-intake" as any, workspaceId, triggerMode: "manual", taskType: "feature",
      title: workspaceId, goal: "目标", workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  }
  let leases = 0;
  let diagnosticWorkspace: WorkspaceId | null = null;
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    onDiagnostic() {
      assert.equal(leases, 1);
      f.db.forWorkspace(diagnosticWorkspace!).db.transaction(() =>
        f.db.forWorkspace(diagnosticWorkspace!).threads.rename("same" as ThreadId, "读连接已关闭，可立即写入"), { mode: "immediate" })();
    },
    acquireWorkspaceSource(workspaceId) {
      const location = f.workspaces.find(value => value.workspaceId === workspaceId)!;
      const dbPath = path.join(location.workspacePath, ".codeflowai", "workspace.db");
      const stat = fs.statSync(dbPath, { bigint: true });
      leases++;
      return { source: { dbPath, workspaceId, dev: String(stat.dev), ino: String(stat.ino) },
        verify() { assert.equal(fs.statSync(dbPath, { bigint: true }).ino, stat.ino); },
        release() { leases--; } };
    } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  for (const { workspaceId, view } of f.workspaces) {
    diagnosticWorkspace = workspaceId;
    const result = await reader.listIntakes({ requestId: "reader-test", workspaceId });
    assert.equal(result.totalCount, 1);
    assert.equal(result.intakes[0]?.title, workspaceId);
    assert.equal(leases, 0);
    view.db.transaction(() => view.threads.rename("same" as ThreadId, "写入优先后仍可用"), { mode: "immediate" })();
  }
});

test("Reader 使用同一 W 完整分页且拒绝伪造文件身份，不回退应用库", async t => {
  const f = fixture(t);
  const { workspaceId, view } = f.workspaces[0]!;
  view.db.transaction(() => {
    for (let index = 0; index < 5; index++) view.orchIntakes.upsert({ id: `page-${index}` as any, workspaceId,
      triggerMode: "manual", taskType: "feature", title: `page-${index}`, goal: "目标" });
  })();
  let corruptIdentity = false;
  let releases = 0;
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource(id) {
      const lease = f.db.acquireWorkspaceReaderSource(id)!;
      const actual = fs.lstatSync(lease.source.dbPath, { bigint: true });
      assert.equal(lease.source.ino, String(actual.ino), "跨线程身份必须保留完整inode，禁止经过Number损失精度");
      return { ...lease, source: { ...lease.source, ino: corruptIdentity ? "invalid-inode" : lease.source.ino },
        release() { lease.release(); releases++; } };
    } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const result = await reader.listIntakes({ requestId: "page-reader", workspaceId, limit: 2, cursor });
    assert.equal(result.totalCount, 5);
    ids.push(...result.intakes.map(item => item.id));
    cursor = result.nextCursor ?? null;
  } while (cursor);
  assert.equal(new Set(ids).size, 5);
  corruptIdentity = true;
  await assert.rejects(reader.listIntakes({ requestId: "wrong-source", workspaceId }),
    (error: any) => error.code === "CLIENT_DB_READER_SCHEMA_INVALID" && error.details.reason === "workspace_source_replaced");
  assert.equal(releases, 4);
});

test("Reader 明确拒绝高版本和不完整 W，释放租约后其他 W 仍能读取", async t => {
  const f = fixture(t);
  let releases = 0;
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource(workspaceId) {
      const location = f.workspaces.find(value => value.workspaceId === workspaceId)!;
      const dbPath = path.join(location.workspacePath, ".codeflowai", "workspace.db");
      const stat = fs.statSync(dbPath, { bigint: true });
      return { source: { dbPath, workspaceId, dev: String(stat.dev), ino: String(stat.ino) }, verify() {}, release() { releases++; } };
    } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  f.workspaces[0]!.view.db.pragma("user_version = 999");
  await assert.rejects(reader.listIntakes({ requestId: "high-version", workspaceId: f.workspaces[0]!.workspaceId }),
    (error: any) => error.code === "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH");
  f.workspaces[1]!.view.db.exec("DROP INDEX idx_orch_artifacts_instance_node");
  await assert.rejects(reader.listIntakes({ requestId: "missing-index", workspaceId: f.workspaces[1]!.workspaceId }),
    (error: any) => error.code === "CLIENT_DB_READER_SCHEMA_INVALID");
  assert.equal((await reader.listIntakes({ requestId: "healthy", workspaceId: f.workspaces[2]!.workspaceId })).totalCount, 0);
  assert.equal(releases, 3);
});

test("原清理服务逐 W 隔离同名会话，A 成功 B 失败后 C 保留且租约释放", async t => {
  const f = fixture(t);
  f.workspaces[1]!.view.db.exec("CREATE TRIGGER fail_cleanup BEFORE DELETE ON conversation_events BEGIN SELECT RAISE(ABORT, 'cleanup failure'); END");
  const leased: string[] = [];
  const notices: string[] = [];
  const cleanup = new ClientDbCleanupService({ db: f.db, dbPath: f.dbPath, batchDelayMs: 0,
    flushEventPersistence() {},
    async beginThreadCleanup(target) { return () => leased.push(target.workspaceId); },
    onThreadHistoryCleaned(target) { notices.push(target.workspaceId); } });
  t.after(() => cleanup.dispose());
  cleanup.start({ inactiveBefore: 500, requestId: "cleanup-workspaces" });
  const deadline = Date.now() + 10_000;
  while (cleanup.isRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cleanup.getStorageSummary().cleanup.status, "failed");
  assert.equal(f.workspaces[0]!.view.conversationEvents.getLatestSeq(), 0, JSON.stringify(cleanup.getStorageSummary().cleanup));
  assert.equal(f.workspaces[1]!.view.conversationEvents.getLatestSeq(), 1);
  assert.equal(f.workspaces[2]!.view.conversationEvents.getLatestSeq(), 1);
  assert.deepEqual(notices, [f.workspaces[0]!.workspaceId]);
  assert.deepEqual(leased, [f.workspaces[0]!.workspaceId, f.workspaces[1]!.workspaceId]);
});

test("空间统计包含应用和 W，关闭失败交回原 ClientDb owner 后保持工作区门禁", t => {
  const f = fixture(t);
  const cleanup = new ClientDbCleanupService({ db: f.db, dbPath: f.dbPath,
    flushEventPersistence() {}, async beginThreadCleanup() { return null; }, onThreadHistoryCleaned() {} });
  t.after(() => cleanup.dispose());
  const paths = [f.dbPath, ...f.workspaces.map(value => path.join(value.workspacePath, ".codeflowai", "workspace.db"))];
  const expectedBytes = paths.reduce((total, dbPath) => total + ["", "-wal", "-shm", "-journal"].reduce((size, suffix) =>
    size + (fs.existsSync(dbPath + suffix) ? fs.statSync(dbPath + suffix).size : 0), 0), 0);
  assert.equal(cleanup.getStorageSummary().databaseBytes, expectedBytes);
  const probe = openSqliteDb(f.dbPath, { readonly: true });
  const prototype = Object.getPrototypeOf(probe);
  const originalClose = prototype.close;
  probe.close();
  let armed = true;
  t.mock.method(prototype, "close", function(this: unknown) {
    if (armed) { armed = false; throw new Error("injected reader close failure"); }
    return originalClose.call(this);
  });
  assert.throws(() => cleanup.getStorageSummary(), /injected reader close failure/);
  assert.throws(() => f.db.acquireWorkspaceReaderSource(f.workspaces[0]!.workspaceId));
  assert.doesNotThrow(() => f.db.close());
});

test("Reader诊断只用原lease可信W，worker伪造归属不改变真实固定日志", async t => {
  const f = fixture(t), [a, b] = f.workspaces;
  const seen: unknown[] = [];
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource: workspaceId => f.db.acquireWorkspaceReaderSource(workspaceId),
    onDiagnostic(diagnostic) {
      seen.push(diagnostic.workspaceId);
      assert.ok(diagnostic.workspaceId);
      f.db.writeWorkspaceLog(diagnostic.workspaceId, { level: "info", tag: "client-db-reader",
        message: "reader fixed workspace diagnostic", data: diagnostic });
    } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  const worker = (reader as any).worker, emit = worker.emit;
  t.mock.method(worker, "emit", function(this: unknown, event: string, ...args: any[]) {
    if (event === "message" && ["result", "failed"].includes(args[0]?.type)) args[0].workspaceId = b!.workspaceId;
    return emit.call(this, event, ...args);
  });
  await reader.listIntakes({ requestId: "fixed-reader-w", workspaceId: a!.workspaceId });
  assert.deepEqual(seen, [a!.workspaceId]);
  const logs = fs.readdirSync(path.join(a!.workspacePath, ".codeflowai")).filter(name => name.endsWith(".log"))
    .map(name => fs.readFileSync(path.join(a!.workspacePath, ".codeflowai", name), "utf8")).join("");
  assert.match(logs, /fixed-reader-w/);
  assert.equal(fs.readdirSync(path.join(b!.workspacePath, ".codeflowai")).some(name => name.endsWith(".log")), false);
});

for (const diagnostic of [undefined, null, false, 0, { failure: "writer-failed" }]) {
  test(`Reader成功查询诊断拒绝${typeof diagnostic}保原值且释放原租约`, async t => {
    const f = fixture(t), workspaceId = f.workspaces[0]!.workspaceId;
    let releases = 0, rejectDiagnostic = true;
    const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
      acquireWorkspaceSource(id) {
        const lease = f.db.acquireWorkspaceReaderSource(id)!;
        return { ...lease, release() { releases++; lease.release(); } };
      }, onDiagnostic() { if (rejectDiagnostic) throw diagnostic; } });
    t.after(async () => { await reader.close(); });
    await reader.ready();
    await assert.rejects(reader.listIntakes({ requestId: "successful-query-log-failed", workspaceId }), error => {
      assert.ok(error instanceof ClientDbReaderError);
      assert.equal(error.code, "CLIENT_DB_READER_DIAGNOSTIC_FAILED");
      assert.equal(error.cause, diagnostic);
      assert.equal(Object.hasOwn(error, "cause"), true);
      assert.equal(error.details.workspaceId, workspaceId);
      return true;
    });
    assert.equal(releases, 1);
    rejectDiagnostic = false;
    assert.equal((await reader.listIntakes({ requestId: "diagnostic-recovered", workspaceId })).totalCount, 0);
    assert.equal(releases, 2);
  });
}

test("Reader查询与诊断双失败保原安全query对象和falsy writer且其他W继续", async t => {
  const f = fixture(t), [a, b] = f.workspaces;
  let rejectDiagnostic = true, releases = 0;
  let rootCause: Record<string, unknown> | undefined;
  a!.view.db.pragma("user_version = 999");
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource(id) {
      const lease = f.db.acquireWorkspaceReaderSource(id)!;
      return { ...lease, release() { releases++; lease.release(); } };
    }, async onDiagnostic(diagnostic) { rootCause = diagnostic.rootCause; if (rejectDiagnostic) throw undefined; } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  await assert.rejects(reader.listIntakes({ requestId: "reader-double-failure", workspaceId: a!.workspaceId }), error => {
    assert.ok(error instanceof ClientDbReaderError);
    assert.equal(error.code, "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH");
    assert.ok(error.cause instanceof AggregateError);
    const [query, diagnostic] = error.cause.errors;
    assert.ok(query instanceof ClientDbReaderError);
    assert.equal(query.code, error.code);
    assert.equal(query.details.requestId, "reader-double-failure");
    assert.equal(query.details.workspaceId, a!.workspaceId);
    assert.equal(error.cause.cause, query);
    assert.equal(diagnostic, undefined);
    return true;
  });
  assert.equal(rootCause?.actualSchemaVersion, 999, "失败诊断沿已有安全details保留可检索根因");
  assert.equal(rootCause?.workspaceId, a!.workspaceId);
  assert.equal(rootCause?.requestId, "reader-double-failure");
  rejectDiagnostic = false;
  assert.equal((await reader.listIntakes({ requestId: "other-reader-w", workspaceId: b!.workspaceId })).totalCount, 0);
  assert.equal(releases, 2);
});

test("Reader诊断错误描述再失败仍交回原请求保留query和writer原值", async t => {
  const f = fixture(t), workspaceId = f.workspaces[0]!.workspaceId;
  f.workspaces[0]!.view.db.pragma("user_version = 999");
  const descriptionFailure = { failure: "description-failed" };
  const writerFailure = Object.defineProperty({}, "code", { get() { throw descriptionFailure; } });
  const reader = new ClientDbReaderService({ dbPath: f.dbPath, onFatalError(error) { throw error; },
    acquireWorkspaceSource: id => f.db.acquireWorkspaceReaderSource(id),
    onDiagnostic() { throw writerFailure; } });
  t.after(async () => { await reader.close(); });
  await reader.ready();
  await assert.rejects(reader.listIntakes({ requestId: "reader-description-failed", workspaceId }), error => {
    assert.ok(error instanceof ClientDbReaderError);
    assert.equal(error.code, "CLIENT_DB_READER_SCHEMA_VERSION_MISMATCH");
    assert.equal(error.details.requestId, "reader-description-failed");
    assert.equal(error.details.workspaceId, workspaceId);
    assert.ok(error.cause instanceof AggregateError);
    const [query, writer, description] = error.cause.errors;
    assert.ok(query instanceof ClientDbReaderError);
    assert.equal(writer, writerFailure);
    assert.equal(description, descriptionFailure);
    return true;
  });
});
