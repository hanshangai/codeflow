import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import { handleReminderIgnoreItems, handleReminderItemsList } from "../src/app/handlers/reminderHandlers.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { openClientDb } from "../src/db/clientDb.js";

/** 用真实 SQLite 和 Git 工作区验证读取成本，初始化全部在观测之前完成。 */
function fixture(t: test.TestContext, count: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-query-"));
  const root = path.join(directory, "workspace");
  fs.mkdirSync(root);
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
  const application = openClientDb({ dbPath: path.join(directory, "app.db"), localCanonicalEvents: true });
  const workspaceId = "reminder-client:workspace" as WorkspaceId;
  application.workspaces.upsert({ id: workspaceId, title: "提醒查询", path: root });
  const writer = application.forWorkspace(workspaceId);
  writer.db.transaction(() => {
    for (let index = 0; index < count; index++) {
      const threadId = `thread-${index}` as ThreadId;
      writer.threads.create({ id: threadId, workspaceId, engine: "claude", title: `提醒 ${index}` });
      writer.threadReminderStates.recordTurnCompleted({ threadId, workspaceId, turnId: `turn-${index}` as TurnId, completedAt: 1_000 + index });
      if (index === 0) writer.reminderReceipts.upsert({ entityType: "thread", workspaceId, entityId: threadId, marker: `turn-${index}` });
    }
  })();
  let response: any;
  const ctx = { db: writer, workspaces: new Map([[workspaceId, root]]), send(value: unknown) { response = value; } } as ApiHandlerContext;
  t.after(() => { application.close(); fs.rmSync(directory, { recursive: true }); });
  return { application, writer, workspaceId, root,
    /** 返回真实 handler 响应，便于同时验证业务结果与数据库成本。 */
    load() {
      handleReminderItemsList(ctx, { id: "reminder-performance", body: { workspaceId } } as ApiRequestMessage);
      return response;
    },
    /** 忽略操作查询后仍从原 writer 写入，不能把只读快照泄漏到后续副作用。 */
    ignore(items: Array<{ reminderId: string; ignoreMarker: string }>) {
      handleReminderIgnoreItems(ctx, { id: "reminder-ignore", body: { workspaceId, items } } as ApiRequestMessage);
      return response;
    },
  };
}

/** 观测真实查询与连接，不替换数据库结果。 */
function observe(t: test.TestContext) {
  let closes = 0, ddl = 0, git = 0, lookups = 0;
  const close = DatabaseSync.prototype.close, exec = DatabaseSync.prototype.exec, prepare = DatabaseSync.prototype.prepare;
  const spawnSync = childProcess.spawnSync;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { closes++; return close.call(this); });
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    if (/\b(?:CREATE|ALTER|DROP)\b/iu.test(sql)) ddl++;
    return exec.call(this, sql);
  });
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (/\bFROM\s+reminder_(?:receipts|ignores)\b/iu.test(sql)) lookups++;
    return prepare.call(this, sql);
  });
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof spawnSync>) => {
    if (args[0] === "git") git++;
    return (spawnSync as (...values: any[]) => any)(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { get closes() { return closes; }, get ddl() { return ddl; }, get git() { return git; }, get lookups() { return lookups; } };
}

for (const count of [4, 80]) test(`${count} 个会话提醒在只读短快照内合批查询，保留已读过滤`, t => {
  const f = fixture(t, count);
  const filename = path.join(f.root, ".codeflowai", "workspace.db");
  const before = fs.readFileSync(filename);
  const counters = observe(t);
  const started = performance.now();
  const response = f.load();
  t.diagnostic(JSON.stringify({ count, elapsedMs: Number((performance.now() - started).toFixed(2)),
    git: counters.git, closes: counters.closes, markerQueries: counters.lookups }));
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, count - 1);
  assert.equal(response.body.items.some((item: any) => item.routeTarget.threadId === "thread-0"), false);
  assert.equal(counters.git, 0, "提醒读取不应执行 Git");
  assert.equal(counters.ddl, 0, "提醒读取不应初始化 schema");
  assert.equal(counters.closes, 1, "同一工作区提醒应只使用一次短连接");
  assert.equal(counters.lookups, 2, "已读和忽略记录各批量读取一次");
  assert.deepEqual(fs.readFileSync(filename), before);
});

test("工作区快照不改变忽略写入归属，新错误标记仍重新显示", t => {
  const f = fixture(t, 4);
  f.writer.threadReminderStates.recordTurnError({ workspaceId: f.workspaceId,
    threadId: "thread-1", turnId: "error-turn" as TurnId, endedAt: 2_000 });
  const item = f.load().body.items.find((value: any) => value.routeTarget.threadId === "thread-1");
  assert.equal(item.displayKind, "action");
  const ignored = f.ignore([{ reminderId: item.id, ignoreMarker: item.ignoreMarker }]);
  assert.deepEqual(ignored.body.ignoredIds, [item.id]);
  assert.equal(f.load().body.items.some((value: any) => value.id === item.id), false);
  f.writer.threadReminderStates.recordTurnError({ workspaceId: f.workspaceId,
    threadId: "thread-1", turnId: "new-error-turn" as TurnId, endedAt: 2_001 });
  assert.equal(f.load().body.items.some((value: any) => value.id === item.id), true);
});

test("提醒短快照查询失败必须上抛，不返回空列表", t => {
  const f = fixture(t, 4);
  const failure = new Error("synthetic reminder query failure");
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (/\bFROM\s+reminder_receipts\b/iu.test(sql)) throw failure;
    return prepare.call(this, sql);
  });
  assert.throws(() => f.load(), error => error === failure || (error as Error).cause === failure);
});
