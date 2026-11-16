import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ApiResult, QuickPhraseCollection } from "@codeflowai/shared";
import { openSqliteDb } from "../src/db/sqliteDb.js";
import { migrateClientDb } from "../src/db/migrateClientDb.js";

/** 每例使用真实临时应用库，关闭后重新打开验证持久化。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-quick-phrases-"));
  const filename = path.join(root, "application.db");
  let db = openSqliteDb(filename);
  migrateClientDb(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, get db() { return db; }, reopen() { db.close(); db = openSqliteDb(filename); migrateClientDb(db); } };
}

test("本机集合只在应用库迁移，工作区不创建平行集合", t => {
  const f = fixture(t);
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_quick_phrases'").get());
  assert.ok(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_model_context_preferences'").get());
  const workspace = openSqliteDb(path.join(f.root, "workspace.db"));
  try {
    migrateClientDb(workspace, { scope: "workspace" });
    assert.equal(workspace.prepare("SELECT 1 FROM sqlite_master WHERE name='local_quick_phrases'").get(), undefined);
    assert.equal(workspace.prepare("SELECT 1 FROM sqlite_master WHERE name='local_model_context_preferences'").get(), undefined);
  } finally { workspace.close(); }
});

test("本机增删改排序重开保留，版本及集合冲突不产生副作用", async t => {
  const f = fixture(t);
  const { executeLocalQuickPhraseRequest: execute } = await import("../src/app/handlers/localQuickPhraseHandlers.js");
  const call = (method: string, body: Record<string, unknown> = {}) => {
    const response = execute(f.db, `quickPhrases.${method}`, body);
    assert.equal(response.status, 200);
    const value = response.body as ApiResult<QuickPhraseCollection>;
    assert.equal(value.ok, true);
    return value as QuickPhraseCollection;
  };
  const a = call("create", { clientRequestId: "a", title: "分析", content: "分析问题\n保留细节" });
  const b = call("create", { clientRequestId: "b", title: "评审", content: "检查代码" });
  const aid = a.items[0]!.id, bid = b.items[1]!.id;
  const updated = call("update", { id: aid, version: 1, title: "分析更新", content: "新的正文" });
  assert.equal(updated.items[0]!.version, 2);
  const before = call("list");
  assert.equal(execute(f.db, "quickPhrases.update", { id: aid, version: 1, title: "旧修改", content: "不能覆盖" }).status, 409);
  assert.equal(execute(f.db, "quickPhrases.delete", { id: aid, version: 1 }).status, 409);
  assert.equal(execute(f.db, "quickPhrases.reorder", { revision: 0, ids: [bid, aid] }).status, 409);
  for (const ids of [[aid], [aid, aid], [aid, "missing"]]) {
    assert.equal(execute(f.db, "quickPhrases.reorder", { revision: before.revision, ids }).status, 400);
  }
  assert.deepEqual(call("list"), before);
  const ordered = call("reorder", { revision: before.revision, ids: [bid, aid] });
  assert.deepEqual(ordered.items.map(item => [item.id, item.sortOrder]), [[bid, 0], [aid, 1]]);
  assert.equal(ordered.items[1]!.version, 2);
  f.reopen();
  assert.deepEqual(call("list"), ordered);
  const remaining = call("delete", { id: bid, version: 1 });
  assert.equal(remaining.items.length, 1);
  assert.equal(remaining.items[0]!.sortOrder, 0);
  f.reopen();
  assert.deepEqual(call("list"), remaining);
});

test("本机创建请求幂等且异内容冲突，未知数据库错误向外抛出", async t => {
  const f = fixture(t);
  const { executeLocalQuickPhraseRequest: execute } = await import("../src/app/handlers/localQuickPhraseHandlers.js");
  const body = { clientRequestId: "same-request", title: "名称", content: "正文" };
  const first = execute(f.db, "quickPhrases.create", body);
  f.reopen();
  assert.deepEqual(execute(f.db, "quickPhrases.create", body), first);
  assert.equal(execute(f.db, "quickPhrases.create", { ...body, content: "另一正文" }).status, 409);
  assert.equal(execute(f.db, "quickPhrases.create", { ...body, clientRequestId: "empty", title: " " }).status, 400);
  f.db.exec("DROP TABLE local_quick_phrases");
  assert.throws(() => execute(f.db, "quickPhrases.list", {}), /no such table/u);
});

test("旧应用库升级保留既有配置，写入异常原子回滚后可恢复", async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO meta(key,value) VALUES (?,?)").run("quick-phrase-upgrade-probe", "既有配置");
  f.db.exec("DROP TABLE local_quick_phrases; DROP TABLE local_quick_phrase_collection; DROP TABLE local_model_context_preferences; PRAGMA user_version=101");
  f.reopen();
  assert.equal((f.db.prepare("SELECT value FROM meta WHERE key=?").get("quick-phrase-upgrade-probe") as { value: string }).value, "既有配置");
  const { executeLocalQuickPhraseRequest: execute } = await import("../src/app/handlers/localQuickPhraseHandlers.js");
  f.db.exec("CREATE TRIGGER fail_quick_phrase_revision BEFORE UPDATE ON local_quick_phrase_collection BEGIN SELECT RAISE(ABORT,'QUICK_PHRASE_REVISION_FAILURE'); END");
  const body = { clientRequestId: "rollback", title: "名称", content: "正文" };
  assert.throws(() => execute(f.db, "quickPhrases.create", body), /QUICK_PHRASE_REVISION_FAILURE/u);
  assert.deepEqual(execute(f.db, "quickPhrases.list", {}).body, { ok: true, revision: 0, items: [] });
  f.db.exec("DROP TRIGGER fail_quick_phrase_revision");
  assert.equal(execute(f.db, "quickPhrases.create", body).status, 200);
});
