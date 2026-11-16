import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, type ApiHandlerContext, type ApiRequestMessage } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";

const startMethods = [
  "threads.sendMessage", "threads.queue.append", "threads.queue.resume", "threads.compact", "threads.restartCodexAppServer",
  "orch.requirementAnalysis.messages.send", "orch.instances.start", "orch.instances.resume", "orch.instances.rerunFromNode",
  "orch.instances.feedback", "orch.nodes.start", "orch.nodes.skip", "orch.experiments.run.start",
  "knowledge.assets.generate", "knowledge.assets.run.start", "knowledge.assets.update.run",
  "orch.assetDrafts.generate", "orch.assetDraftJobs.resume", "scheduledTasks.runNow", "scheduledTasks.local.runNow",
  "clientDb.cleanup.start", "workspaceDirectoryMigration.prepare", "workspaceDirectoryMigration.prepareStart", "workspaceDirectoryMigration.executeStart",
  "threads.rollback",
];

/** 允许原入口绑定日志方法，意外工作区写入仍失败；门禁先于领域副作用。 */
function fixture(paused: () => boolean) {
  const sent: any[] = [];
  const ctx = { isTaskAdmissionPaused: paused, send: (message: unknown) => { sent.push(message); },
    sessions: { beginThreadOperation: () => () => {} }, workspaces: new Map(),
    db: { writeWorkspaceLog() { throw new Error("UNEXPECTED_WORKSPACE_LOG_WRITE"); } },
  } as unknown as ApiHandlerContext;
  const request = (method: string): ApiRequestMessage => ({ t: "api.req", id: "update-admission", method, path: "/test",
    body: { workspaceId: "workspace", threadId: "thread", instanceId: "instance" } });
  return { ctx, sent, request };
}

for (const method of startMethods) test(`update admission rejects ${method} before execution`, async () => {
  const f = fixture(() => true);
  await handleApiRequest(f.ctx, f.request(method));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].status, 409);
  assert.equal(f.sent[0].body.code, "DESKTOP_UPDATE_TASKS_PAUSED");
});

for (const action of ["cancel", "abort"]) for (const chat of [false, true]) test(`update admission allows ${chat ? "chat" : "direct"} stopping feedback ${action}`, async () => {
  const f = fixture(() => true);
  const req = f.request(chat ? "orch.chat.action" : "orch.instances.feedback");
  req.body = chat ? { action: "feedback", feedbackAction: action } : { action };
  await handleApiRequest(f.ctx, req);
  assert.equal(f.sent.some(message => message.body?.code === "DESKTOP_UPDATE_TASKS_PAUSED"), false);
});

test("update rejection records one owned diagnostic with request and entity context", async t => {
  const f = fixture(() => true), logs: any[][] = [];
  let owned = 0;
  f.ctx.onApiFailureLogged = () => { owned++; };
  t.mock.method(logger, "warn", (...args: any[]) => { logs.push(args); });
  await handleApiRequest(f.ctx, f.request("threads.sendMessage"));
  assert.equal(owned, 1);
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.fromEntries(["code", "requestId", "method", "workspaceId", "threadId"].map(key => [key, logs[0][2][key]])),
    { code: "DESKTOP_UPDATE_TASKS_PAUSED", requestId: "update-admission", method: "threads.sendMessage", workspaceId: "workspace", threadId: "thread" });
  assert.equal(typeof logs[0][2].rootCause, "string");
});

for (const action of ["start", "resume", "confirm_rework", "feedback", "dismiss"]) test(`update admission rejects chat workflow ${action}`, async () => {
  const f = fixture(() => true);
  await handleApiRequest(f.ctx, { ...f.request("orch.chat.action"), body: { action } });
  assert.equal(f.sent[0].status, 409);
  assert.equal(f.sent[0].body.code, "DESKTOP_UPDATE_TASKS_PAUSED");
});

for (const method of ["approvals.respond", "userInput.respond", "turns.interrupt", "threads.queue.pause", "threads.draft.get", "orch.instances.cancel", "orch.nodes.cancel"]) {
  test(`update admission keeps ${method} available`, async () => {
    const f = fixture(() => true);
    await handleApiRequest(f.ctx, { ...f.request(method), body: {} });
    assert.equal(f.sent.length, 1);
    assert.notEqual(f.sent[0].body.code, "DESKTOP_UPDATE_TASKS_PAUSED");
  });
}

test("admission callback failure is observable and does not dispatch", async () => {
  const failure = new Error("admission unavailable");
  const f = fixture(() => { throw failure; });
  await assert.rejects(() => handleApiRequest(f.ctx, f.request("threads.sendMessage")), error => error === failure);
  assert.deepEqual(f.sent, []);
});
