import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ClientToServerMessage, DesktopApiRequest, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import { handleApiRequest, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";
import { ThreadStore } from "../src/threads/threadStore.js";
import { handleThreadsClear, handleThreadsDelete, handleThreadsLoad, handleThreadsPresentation } from "../src/app/handlers/threadHandlers.js";
import { ClientDbWriterService } from "../src/db/clientDbWriterService.js";

for (const method of ["threads.delete", "threads.clear"] as const) for (const flushFails of [false, true]) test(`${method}真实Writer等待异步缓冲排空，失败时保留历史（失败=${flushFails}）`, async t => {
  const f = fixture(t, 20);
  const tails: Promise<void>[] = [];
  const writer = new ClientDbWriterService({ db: f.db, dbPath: path.join(path.dirname(f.root), "app.db"), onFatalError(error) { assert.fail(error); } });
  const ctx: ApiHandlerContext = { ...f.ctx, db: f.writer, withDatabase: (requestId, operation) => writer.withLegacyDatabase(requestId, operation),
    sessions: { beginThreadDeletion: () => () => {}, disposeThreadWithOptions: async () => {} } as any,
    orchEngine: { disposeManagedServicesForThread: async () => {} } as any,
    trackApiTail(work) { void work.then(undefined, () => undefined); tails.push(work); },
    async flushLocalEvents() {
      assert.throws(() => f.writer.threads.get(f.threadId), /CLIENT_DB_LEGACY_ACCESS_REQUIRED/);
      await writer.withLegacyDatabase("async-event-flush", () => f.writer.conversationEvents.getLatestSeqByThread(f.threadId));
      if (flushFails) throw new Error("ASYNC_EVENT_BUFFER_FLUSH_FAILED");
    },
  };
  ctx.flushEventPersistence = () => ctx.flushLocalEvents!(f.workspaceId, f.threadId);
  try {
    await writer.ready();
    const request = { t: "api.req" as const, id: method, method, path: "/test", body: { workspaceId: f.workspaceId, threadId: f.threadId } };
    await (method === "threads.delete" ? handleThreadsDelete(ctx, request) : handleThreadsClear(ctx, request));
    assert.equal((f.sent.find(message => message.t === "api.res") as any)?.status, flushFails ? 500 : 200);
    if (method === "threads.delete" && !flushFails) {
      assert.equal(await writer.withLegacyDatabase("verify-deletion-marker", () => f.writer.threads.get(f.threadId)), null);
      await Promise.all(tails);
    }
    assert.equal(await writer.withLegacyDatabase("verify-async-delete", () => f.writer.conversationEvents.getLatestSeqByThread(f.threadId)), flushFails ? 20 : 0);
  } finally { await writer.close(); }
});

/** 真实 Git/SQLite 夹具只写临时目录，读取经桌面或通用 API 入口。 */
function fixture(t: test.TestContext, count = 600) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "thread-readonly-"));
  const root = path.join(directory, "project");
  fs.mkdirSync(root);
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  const db = openClientDb({ dbPath: path.join(directory, "app.db"), localCanonicalEvents: true });
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "reader-client:workspace" as WorkspaceId;
  const threadId = "history" as ThreadId;
  db.workspaces.upsert({ id: workspaceId, title: "只读历史", path: root });
  const writer = db.forWorkspace(workspaceId);
  writer.threads.create({ id: threadId, workspaceId, engine: "codex", title: "会话" });
  writer.db.transaction(() => {
    for (let seq = 1; seq <= count; seq++) writer.conversationEvents.appendEnvelope({
      schema: 1, seq, ts: 100 + seq, workspaceId, threadId, engine: "codex", type: "thread.started", payload: {},
    });
  })();
  const sent: ClientToServerMessage[] = [];
  const ctx = { db, clientId: "reader-client", workspaces: new Map([[workspaceId, root]]), threads: new ThreadStore(),
    send(message: ClientToServerMessage) { sent.push(message); },
  } as ApiHandlerContext;
  return { db, writer, ctx, sent, root, workspaceId, threadId,
    filename: path.join(root, ".codeflowai", "workspace.db"), exclude: path.join(root, ".git", "info", "exclude"),
    /** 固定可信归属，只允许测试指定分页参数。 */
    load(body: Record<string, unknown> = {}, method: "threads.load" | "threads.events" = "threads.load") {
      return executeDesktopApiRequest(ctx, { method, body: { workspaceId, threadId, ...body } } as DesktopApiRequest,
        { requestId: "readonly-history", startedAt: 1, clientVersion: "1.0.0" });
    },
  };
}

/** 观测真实子进程和 SQLite 生命周期；不替换查询结果。 */
function observe(t: test.TestContext) {
  let git = 0, closes = 0, ddl = 0;
  const spawn = childProcess.spawnSync, close = DatabaseSync.prototype.close, exec = DatabaseSync.prototype.exec;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawn>) => {
    if (args[0] === "git") git++;
    return (spawn as (...args: any[]) => unknown)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) { closes++; return close.call(this); });
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (/\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)) ddl++;
    return exec.call(this, sql);
  });
  return { get git() { return git; }, get closes() { return closes; }, get ddl() { return ddl; } };
}

for (const method of ["threads.load", "threads.presentation"] as const) test(`${method} 每个SQLite批次取得同步许可且读屏障失败不读取正文`, async t => {
  const f = fixture(t, 650);
  let permitted = false, leases = 0, flushed = false;
  const prepare = DatabaseSync.prototype.prepare;
  const ctx: ApiHandlerContext = { ...f.ctx, db: f.writer,
    async flushLocalEvents() { flushed = true; },
    async withDatabase(_requestId, operation) {
      assert.equal(permitted, false, "不能跨await持有许可或重复嵌套申请");
      permitted = true; leases++;
      try {
        const value = operation();
        assert.equal(Boolean(value && typeof (value as any).then === "function"), false, "许可只包含同步短段");
        return value;
      } finally { permitted = false; }
    },
  };
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        assert.equal(flushed, true, "SQL快照必须在事件及索引屏障之后");
        assert.equal(permitted, true, `SQL在异步批次后越过许可：${sql.slice(0, 90)}`);
        return value.apply(target, args);
      };
    } });
  });
  const request = { t: "api.req" as const, id: "coordinated-read", method, path: "/test", body: { workspaceId: f.workspaceId, threadId: f.threadId } };
  await (method === "threads.load" ? handleThreadsLoad(ctx, request) : handleThreadsPresentation(ctx, request));
  assert.ok(leases > 1, "分批读取使用多次短许可");
  assert.equal((f.sent.find(message => message.t === "api.res") as any)?.status, 200);
  ctx.flushLocalEvents = async () => { throw new Error("INDEX_READ_BARRIER_FAILED"); };
  const before = leases;
  await assert.rejects(method === "threads.load" ? handleThreadsLoad(ctx, request) : handleThreadsPresentation(ctx, request), /INDEX_READ_BARRIER_FAILED/);
  assert.equal(leases, before, "失败屏障后不能继续读取或构建索引");
});

for (const method of ["threads.delete", "threads.clear"] as const) test(`${method} 先阻止新准入并排空事件，每批删除持许可且资源释放不持锁`, async t => {
  const f = fixture(t, 1100);
  const tails: Promise<void>[] = [];
  let permitted = false, fenced = false, flushed = 0, deleted = 0;
  const ctx: ApiHandlerContext = { ...f.ctx, db: f.writer,
    trackApiTail(work) { void work.then(undefined, () => undefined); tails.push(work); },
    async withDatabase(_requestId, operation) {
      assert.equal(permitted, false); permitted = true;
      try { const value = operation(); assert.equal(Boolean(value && typeof (value as any).then === "function"), false); return value; }
      finally { permitted = false; }
    },
    async flushLocalEvents() { assert.equal(fenced, true, "先关闭线程新准入，避免排空后继续写入"); assert.equal(permitted, false); flushed++; },
    sessions: { beginThreadDeletion() { fenced = true; return () => { fenced = false; }; },
      async disposeThreadWithOptions() { assert.equal(permitted, false); await Promise.resolve(); } } as any,
    orchEngine: { async disposeManagedServicesForThread() { assert.equal(permitted, false); await Promise.resolve(); } } as any,
  };
  for (const name of ["deleteByThread", "deleteByThreadThroughSeq"] as const) {
    const original = f.writer.conversationEvents[name].bind(f.writer.conversationEvents);
    t.mock.method(f.writer.conversationEvents, name, ((...args: any[]) => {
      assert.equal(permitted, true); assert.equal(fenced, true); assert.ok(flushed > 0); deleted++;
      return (original as (...values: any[]) => number)(...args);
    }) as any);
  }
  await (method === "threads.delete" ? handleThreadsDelete(ctx, { t: "api.req", id: "delete", method, path: "/test", body: { workspaceId: f.workspaceId, threadId: f.threadId } })
    : handleThreadsClear(ctx, { t: "api.req", id: "clear", method, path: "/test", body: { workspaceId: f.workspaceId, threadId: f.threadId } }));
  if (method === "threads.delete") {
    assert.equal(fenced, true, "后台清理期间保持门禁");
    assert.equal(deleted, 0, "确认不等待事件物理删除");
    await Promise.all(tails);
  }
  assert.equal(fenced, false);
  assert.ok(deleted > 0);
  assert.equal((f.sent.find(message => message.t === "api.res") as any)?.status, 200);
  assert.equal(f.writer.conversationEvents.getLatestSeqByThread(f.threadId), 0);
});

for (const entry of ["desktop", "api"] as const) test(`${entry} 历史加载不执行 Git、DDL 或改写数据库，连接按批复用`, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.exclude, "# 外部修改，读取不得修复\n", "utf8");
  const before = fs.readFileSync(f.filename), exclude = fs.readFileSync(f.exclude);
  const counters = observe(t);
  let response: { status: number; body: any };
  if (entry === "desktop") response = await f.load();
  else {
    await handleApiRequest(f.ctx, { t: "api.req", id: "api-history", path: "/test", method: "threads.load",
      body: { workspaceId: f.workspaceId, threadId: f.threadId } });
    response = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
  }
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.events.length, 600);
  assert.equal(response.body.rawEventCount, 600);
  assert.equal(counters.git, 0, "只读请求不应运行 Git");
  assert.equal(counters.ddl, 0, "只读请求不应初始化 schema 或 TEMP 写入触发器");
  assert.ok(counters.closes <= 10, `600 条历史应按批复用连接，实际 ${counters.closes}`);
  assert.deepEqual(fs.readFileSync(f.filename), before);
  assert.deepEqual(fs.readFileSync(f.exclude), exclude);
});

test("读取不构建写入服务，运行状态使用本请求只读快照", async t => {
  const f = fixture(t, 1);
  const forbidden = () => { throw new Error("只读请求不应构建写入服务"); };
  f.ctx.orchEngine = { forWorkspace: forbidden } as unknown as ApiHandlerContext["orchEngine"];
  f.ctx.queueDispatcher = { forWorkspace: forbidden } as unknown as ApiHandlerContext["queueDispatcher"];
  f.ctx.getActiveThreadTurn = input => {
    assert.equal(input.includeDb, false, "运行状态不得绕过只读视图重新查询根写库");
    return { turnId: "live-turn" as any, startedAt: 200, source: "runtime" };
  };
  const response = await f.load();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as any).running.runningTurnId, "live-turn");
});

for (const entry of ["desktop", "api"] as const) for (const method of ["threads.list", "threads.groups.list"] as const) {
  test(`${entry} ${method} 复用只读快照，不初始化 writer 或修改 Git 排除`, async t => {
    const f = fixture(t, 1);
    const group = f.writer.threads.createGroup({ workspaceId: f.workspaceId, name: "研发" });
    f.writer.db.prepare("UPDATE threads SET group_id = ? WHERE id = ?").run(group.id, f.threadId);
    f.writer.threads.create({ id: "shared" as ThreadId, workspaceId: f.workspaceId, engine: "codex", title: "共享" });
    f.writer.db.prepare("UPDATE threads SET shared_workspace_id = 'shared-only' WHERE id = 'shared'").run();
    f.ctx.localWorkspaceOnly = true;
    f.ctx.getActiveThreadTurn = input => {
      assert.equal(input.includeDb, false);
      return { turnId: "live-list" as any, startedAt: 300, source: "runtime" };
    };
    fs.writeFileSync(f.exclude, "# 外部变更，列表不得修复\n", "utf8");
    const before = fs.readFileSync(f.filename), exclude = fs.readFileSync(f.exclude);
    const counters = observe(t);
    const body = { workspaceId: f.workspaceId, ...(method === "threads.list" ? { scope: "current", groupId: group.id, limit: 1 } : {}) };
    let response: { status: number; body: any };
    if (entry === "desktop") response = await executeDesktopApiRequest(f.ctx, { method, body },
      { requestId: "readonly-list", startedAt: 1, clientVersion: "1.0.0" });
    else {
      await handleApiRequest(f.ctx, { t: "api.req", id: "readonly-list", path: "/test", method, body });
      response = f.sent.find(message => message.t === "api.res") as Extract<ClientToServerMessage, { t: "api.res" }>;
    }
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (method === "threads.list") {
      assert.deepEqual(response.body.threads.map((thread: { id: string }) => thread.id), [f.threadId]);
      assert.equal(response.body.runningByThreadId[f.threadId].runningTurnId, "live-list");
      assert.equal(response.body.hasMore, false);
    } else assert.deepEqual(response.body.groups.map((item: { id: string }) => item.id), [group.id]);
    assert.equal(counters.git, 0, "列表不运行 Git");
    assert.equal(counters.ddl, 0, "列表不初始化 writer 或 TEMP 触发器");
    assert.equal(counters.closes, 1, "同一列表的归属、分页和运行态共用一个短连接");
    assert.deepEqual(fs.readFileSync(f.filename), before);
    assert.deepEqual(fs.readFileSync(f.exclude), exclude);
  });
}

test("只读工作区视图拒绝写入，原 writer 仍校验并修复 Git 排除", t => {
  const f = fixture(t, 1);
  const reader = f.db.forWorkspace(f.workspaceId, { readonly: true });
  assert.equal(reader.threads.get(f.threadId)?.title, "会话");
  assert.throws(() => reader.threads.rename(f.threadId, "不应写入"));
  assert.equal(f.writer.threads.get(f.threadId)?.title, "会话");
  fs.writeFileSync(f.exclude, "# 排除规则被移除\n", "utf8");
  f.writer.threads.rename(f.threadId, "正常写入");
  assert.equal(childProcess.execFileSync("git", ["check-ignore", "--", ".codeflowai/workspace.db"],
    { cwd: f.root, windowsHide: true, encoding: "utf8" }).trim(), ".codeflowai/workspace.db");
  assert.equal(reader.threads.get(f.threadId)?.title, "正常写入");
});

test("原始事件分页也沿只读入口返回真实历史", async t => {
  const f = fixture(t, 1);
  f.writer.rawEvents.appendEnvelope({ schema: 1, seq: 2, ts: 102, workspaceId: f.workspaceId, threadId: f.threadId,
    engine: "codex", source: "readonly-test", data: { text: "原始记录" }, handled: true, action: "mapped", emittedTypes: ["thread.started"] });
  const counters = observe(t);
  const response = await f.load({ limit: 1 }, "threads.events");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual((response.body as any).events.map((event: any) => [event.seq, event.data.text]), [[2, "原始记录"]]);
  assert.equal(counters.git, 0);
  assert.equal(counters.ddl, 0);
});

test("只读连接关闭失败显式上抛，并保留门禁直到原 owner 完成清理", t => {
  const f = fixture(t, 1);
  const failure = new Error("injected readonly close failure"), close = DatabaseSync.prototype.close;
  let rejectClose = true;
  t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
    if (rejectClose) { rejectClose = false; throw failure; }
    return close.call(this);
  });
  const reader = f.db.forWorkspace(f.workspaceId, { readonly: true });
  assert.throws(() => reader.threads.get(f.threadId), error => error instanceof Error && error.cause === failure);
  assert.throws(() => f.db.acquireWorkspaceReaderSource(f.workspaceId));
  assert.doesNotThrow(() => f.db.close());
});

test("批次间释放读锁且允许追加，当前分页不跨越开始时的高水位", async t => {
  const f = fixture(t);
  let wrote = false;
  let loaded = false;
  const pending = f.load().then(response => { loaded = true; return response; });
  const concurrent = new Promise<void>((resolve, reject) => setImmediate(() => {
    try {
      assert.equal(loaded, false, "追加应发生在历史加载完成前");
      f.writer.conversationEvents.appendEnvelope({ schema: 1, seq: 601, ts: 701, workspaceId: f.workspaceId,
        threadId: f.threadId, engine: "codex", type: "thread.started", payload: {} });
      wrote = true;
      resolve();
    } catch (error) { reject(error); }
  }));
  const response = await pending;
  await concurrent;
  assert.equal(wrote, true);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal((response.body as any).latestSeq, 600);
  assert.equal((response.body as any).events.at(-1).seq, 600);
  assert.equal(((await f.load({ limit: 1 })).body as any).events[0].seq, 601);
});

test("只读视图遇到缺失或不支持的数据库显式失败，不创建或迁移文件", t => {
  const f = fixture(t, 1);
  const missingId = "reader-client:missing" as WorkspaceId;
  const missingRoot = path.join(f.root, "missing");
  fs.mkdirSync(missingRoot);
  f.db.workspaces.upsert({ id: missingId, title: "未初始化", path: missingRoot });
  assert.throws(() => f.db.forWorkspace(missingId, { readonly: true }).threads.get(f.threadId));
  assert.equal(fs.existsSync(path.join(missingRoot, ".codeflowai")), false);
  const native = new DatabaseSync(f.filename);
  native.exec("PRAGMA user_version = 999");
  native.close();
  const before = fs.readFileSync(f.filename);
  assert.throws(() => f.db.forWorkspace(f.workspaceId, { readonly: true }).threads.get(f.threadId));
  assert.deepEqual(fs.readFileSync(f.filename), before);
});

test("加载让出期间删除会话后，响应保留原来的隐藏进程入口语义", async t => {
  const f = fixture(t);
  const pending = f.load();
  const deleted = new Promise<void>((resolve, reject) => setImmediate(() => {
    try {
      f.writer.db.transaction(() => {
        f.writer.db.prepare("DELETE FROM conversation_events WHERE thread_id = ?").run(f.threadId);
        f.writer.db.prepare("DELETE FROM threads WHERE id = ?").run(f.threadId);
      })();
      resolve();
    } catch (error) { reject(error); }
  }));
  const response = await pending;
  await deleted;
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual((response.body as any).managedServices, { visible: false, threadId: null });
});
