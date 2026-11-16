import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { logger } from "../src/logger.js";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import { isEngineWorkspaceLogFailure } from "../src/engines/threadSession.js";

/** 会话只使用真实隔离W日志，不启动provider。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-workspace-log-"));
  const workspacePath = path.join(root, "workspace"); fs.mkdirSync(workspacePath);
  const db = openClientDb({ dbPath: path.join(root, "app.db") });
  db.workspaces.upsert({ id: "workspace", title: "项目", path: workspacePath });
  const session = new ClaudeThreadSession({ workspacePath, workspaceId: "workspace", threadId: "thread", initialSessionId: null,
    writeWorkspaceLog: (id, entry) => db.writeWorkspaceLog(id, entry), onEngineProcessSnapshot: () => true, onSessionId() {} });
  t.after(async () => { await session.dispose(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, session, workspacePath };
}

test("Claude交互拒绝沿固定W记录关联，应用无副本且答案不进入日志", async t => {
  const f = fixture(t), application: unknown[] = [], secret = "PRIVATE_CLAUDE_ANSWER";
  t.mock.method(logger, "info", (...args) => { application.push(args); });
  t.mock.method(logger, "error", (...args) => { application.push(args); });
  await assert.rejects(f.session.respondUserInput("missing", { [secret]: "secret answer" } as never), /request 不存在或已处理/);
  const directory = path.join(f.workspacePath, ".codeflowai");
  const names = fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => /^client-.*\.log$/.test(name)) : [];
  assert.ok(names.length > 0);
  const logs = names.flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  assert.ok(logs.every(line => line.workspaceId === "workspace" && line.threadId === "thread" && line.requestId));
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.deepEqual(application, []);
});

test("Claude交互日志falsy拒绝沿原Promise失败，不发送或吞为provider错误", async t => {
  const f = fixture(t);
  f.db.writeWorkspaceLog = () => { throw 0; };
  await assert.rejects(f.session.respondUserInput("missing", {}), error => {
    assert.ok(isEngineWorkspaceLogFailure(error));
    assert.equal((error as AggregateError).cause, 0);
    return true;
  });
});
