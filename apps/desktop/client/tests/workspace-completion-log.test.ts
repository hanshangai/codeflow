import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { openClientDb } from "../src/db/clientDb.js";
import { describeWorkspaceApiFailure } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";

/** 提取真实索引及其日志依赖，不启动 Client；通知出口由确定性屏障替代。 */
function functions() {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["logClientStep", "createEventIndexRuntime", "notifyThreadCompletionReminder"];
  const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
  assert.equal(declarations.length, names.length);
  const code = ts.transpileModule(declarations.map(node => node.getText(tree)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("describeWorkspaceApiFailure", "shouldSendThreadCompletionNotification", "resolveThreadCompletionReminderRouting", "logger",
    `${code}\nreturn { ${names.join(",")} };`)(describeWorkspaceApiFailure, () => true, () => ({}), logger);
}

/** 日志落在真实 W，应用库和另一 W 不充当回退落点。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-completion-"));
  const directory = path.join(root, "workspace"); fs.mkdirSync(directory);
  const db = openClientDb({ dbPath: path.join(root, "application.db") });
  db.workspaces.upsert({ id: "workspace", title: "项目", path: directory });
  const view = db.forWorkspace("workspace");
  view.threads.create({ id: "thread", workspaceId: "workspace", engine: "claude", title: "会话" });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const api = functions(), runtime = api.createEventIndexRuntime();
  const notify = (promise: Promise<void>) => api.notifyThreadCompletionReminder({ db: view, runtime,
    reminderCompletionNotifier: { notifyCompletion: () => promise } }, { workspaceId: "workspace", threadId: "thread", ts: 1 }, "turn");
  return { directory, db, view, runtime, notify };
}

test("完成提醒保留未结束尾链，所属W与索引边界各记诊断并显式报告", async t => {
  const f = fixture(t), application: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => application.push(args));
  let reject!: (error: unknown) => void;
  const notification = new Promise<void>((_resolve, fail) => { reject = fail; });
  f.notify(notification);
  let settled = false;
  const waiting = f.runtime.waitForIdle().finally(() => { settled = true; });
  const failure = assert.rejects(waiting, (error: unknown) => error === undefined);
  await Promise.resolve(); assert.equal(settled, false);
  reject(undefined); await failure;
  const directory = path.join(f.directory, ".codeflowai");
  const rows = fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  assert.equal(rows.length, 1); assert.equal(rows[0].workspaceId, "workspace");
  assert.equal(rows[0].threadId, "thread"); assert.equal(rows[0].turnId, "turn"); assert.ok(rows[0].requestId);
  assert.equal(application.length, 1);
  assert.deepEqual(application[0], ["client-runtime", "event index background task failed", {
    entry: "client.runtime", event: { category: "client_runtime", action: "event_index.background", outcome: "fail" },
    errorCode: "EVENT_INDEX_BACKGROUND_FAILED", task: "reminder-completion",
    errorMessage: describeWorkspaceApiFailure(undefined).message, rootCause: describeWorkspaceApiFailure(undefined).rootCause,
  }]);
});

test("完成提醒与W诊断双错保falsy原值，成功的独立尾链正常收口", async t => {
  const f = fixture(t), application: unknown[] = [];
  t.mock.method(logger, "error", (...args: unknown[]) => application.push(args));
  f.view.writeWorkspaceLog = () => { throw 0; };
  f.notify(Promise.resolve());
  await f.runtime.waitForIdle();
  assert.deepEqual(application, []);
  const notification = Promise.reject(false);
  f.notify(notification);
  await assert.rejects(f.runtime.waitForIdle(), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [false, 0]); assert.equal(error.cause, false); return true;
  });
  assert.equal(application.length, 1);
});

test("索引边界诊断失败保原提醒错误且不伪写W成功", async t => {
  const f = fixture(t), original = new Error("NOTIFICATION_FAILED"), diagnostic = new Error("INDEX_LOG_FAILED");
  let workspaceWrites = 0;
  f.view.writeWorkspaceLog = () => { workspaceWrites++; };
  t.mock.method(logger, "error", () => { throw diagnostic; });
  f.notify(Promise.reject(original));
  await assert.rejects(f.runtime.waitForIdle(), (error: unknown) => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, diagnostic]);
    assert.equal(error.cause, original); return true;
  });
  assert.equal(workspaceWrites, 0);
});
