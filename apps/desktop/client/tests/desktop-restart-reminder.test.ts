import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import type { ClientToServerMessage, WorkspaceId } from "@codeflowai/shared";
import { describeWorkspaceApiFailure } from "../src/app/handleApiRequest.js";
import { createReminderDeliveryOwner, createServerReminderNotifier } from "../src/notifications/serverReminderNotifier.js";
import type { ReminderCompletionNotification } from "../src/notifications/reminderNotificationTypes.js";

/** 执行 index 的真实提醒装配、发送与尾链，只有云连接和日志使用受控边界。 */
function fixture() {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const selected: string[] = [];
  const functions = new Set(["logClientStep", "createEventIndexRuntime"]);
  const variables = new Set(["hasDesktopReminderScope", "sendToServer", "reminderDelivery", "reminderCompletionNotifier"]);
  /** 沿真实声明选取协作入口，避免复制准入条件导致测试与实现一起出错。 */
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && functions.has(node.name?.text ?? "")
      || ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && variables.has(d.name.text))) {
      selected.push(node.getText(tree));
    } else ts.forEachChild(node, visit);
  };
  visit(tree);
  const code = ts.transpileModule(selected.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const workspaceId = "local-client:project" as WorkspaceId, owner = { ownerUserId: "account-a" };
  const scopes: Array<{ clientId: string; userId: string; workspaceId: string; sharedWorkspaceId: string }> = [];
  const sent: Array<Extract<ClientToServerMessage, { t: "reminder.completionNotification" | "reminder.actionNotification" }>> = [];
  const failures: unknown[] = [], logs: unknown[] = [];
  let demanded = true, accepted = true;
  const context = {
    createReminderDeliveryOwner, createServerReminderNotifier, describeWorkspaceApiFailure,
    config: { clientId: "local-client" }, keepFullEventOutput: false, desktopLifecycle: {}, desktopCloudAccount: {
      getOwner: () => owner,
      send(message: typeof sent[number]) { sent.push(message); return { accepted, reason: accepted ? null : "connection unavailable" }; },
    },
    desktopHostScopes: scopes, sanitizeClientToServerMessage: (message: unknown) => message,
    hasRemoteDataDemand: (kind: string, workspace: string) => demanded && kind === "reminders" && workspace === workspaceId,
    logger: { error(...args: unknown[]) { logs.push(args); } },
  };
  const api = new Function(...Object.keys(context), `${code}\nreturn { reminderCompletionNotifier, reminderDelivery, runtime: createEventIndexRuntime() };`)(...Object.values(context));
  const notification: ReminderCompletionNotification = { notificationKey: "thread:turn:receipt", sourceType: "chat", workspaceId, workspaceTitle: "Project",
    title: "Completed", summary: "Review result", targetId: "thread", completedAt: 1, sharedWorkspaceId: "shared-a" };
  return { ...api, owner, scopes, sent, failures, logs, notification,
    /** 同一原尾链必须由 shutdown 的 waitForIdle 消费，不能绕过失败。 */
    notify() {
      api.runtime.trackWork(() => api.reminderCompletionNotifier.notifyCompletion(notification),
        (error: unknown) => { failures.push(error); }, "reminder-completion");
    },
    setDemand(value: boolean) { demanded = value; },
    rejectDispatch() { accepted = false; },
  };
}

for (const mismatch of ["missing", "local", "account", "client", "workspace", "shared"] as const) {
  test(`提醒订阅缺少匹配的${mismatch}授权时不派发，不让无效任务阻断首次退出排空`, async () => {
    const f = fixture();
    if (mismatch !== "missing") f.scopes.push({ clientId: mismatch === "client" ? "other-client" : "local-client", userId: mismatch === "account" ? "account-b" : "account-a",
      workspaceId: mismatch === "workspace" ? "local-client:other" : f.notification.workspaceId,
      sharedWorkspaceId: mismatch === "shared" ? "shared-b" : "shared-a" });
    if (mismatch === "local") f.notification.sharedWorkspaceId = null;
    f.notify();
    await f.runtime.waitForIdle();
    assert.deepEqual(f.sent, []);
    assert.deepEqual(f.failures, []);
    assert.deepEqual(f.logs, []);
  });
}

test("授权与订阅都有效的提醒等待真实回执，成功后首次退出排空完成", async () => {
  const f = fixture();
  f.scopes.push({ clientId: "local-client", userId: "account-a", workspaceId: f.notification.workspaceId, sharedWorkspaceId: "shared-a" });
  f.notify();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].t, "reminder.completionNotification");
  assert.equal(f.reminderDelivery.accept({ t: "reminder.deliveryResult", requestId: f.sent[0].requestId, ok: true }), true);
  await f.runtime.waitForIdle();
  assert.deepEqual(f.failures, []);
});

test("授权有效但实际发送失败仍显式阻止成功排空，不清除原始失败", async () => {
  const f = fixture();
  f.scopes.push({ clientId: "local-client", userId: "account-a", workspaceId: f.notification.workspaceId, sharedWorkspaceId: "shared-a" });
  f.rejectDispatch();
  f.notify();
  await assert.rejects(f.runtime.waitForIdle(), /REMINDER_DELIVERY_DISPATCH_REJECTED/u);
  assert.equal(f.sent.length, 1);
  assert.equal(f.failures.length, 1);
  assert.equal(f.logs.length, 1);
});

test("Host授权存在但没有提醒需求时不创建外发任务", async () => {
  const f = fixture();
  f.scopes.push({ clientId: "local-client", userId: "account-a", workspaceId: f.notification.workspaceId, sharedWorkspaceId: "shared-a" });
  f.setDemand(false);
  f.notify();
  await f.runtime.waitForIdle();
  assert.deepEqual(f.sent, []);
});
