import assert from "node:assert/strict";
import test from "node:test";
import { createServerReminderNotifier, createReminderDeliveryOwner } from "../src/notifications/serverReminderNotifier.js";

const completion = { notificationKey: "k", sourceType: "chat", workspaceId: "w", workspaceTitle: "w", title: "t", summary: "s", targetId: "t", completedAt: 1 } as never;
const action = { notificationKey: "k", sourceType: "chat", workspaceId: "w", workspaceTitle: "w", title: "t", summary: "s", targetId: "t", completedAt: 1 } as never;

test("未提供有效提醒需求时不上传也不伪造发送", async () => {
  const sent: unknown[] = [];
  const notifier = createServerReminderNotifier({
    sendToServer: message => { sent.push(message); return { accepted: true, bytes: 1 }; },
  });
  await notifier.notifyCompletion(completion);
  await notifier.notifyAction(action);
  assert.deepEqual(sent, []);
});

test("桌面未关联云端时不发送任何提醒", async () => {
  let sent = 0;
  const notifier = createServerReminderNotifier({
    canSend: () => false,
    sendToServer: () => { sent += 1; return { accepted: true, bytes: 1 }; },
  });
  await notifier.notifyCompletion(completion);
  await notifier.notifyAction(action);
  assert.equal(sent, 0);
});

test("有效需求缺少结果回执owner时显式失败", async () => {
  let sent = 0;
  const notifier = createServerReminderNotifier({ canSend: () => true,
    sendToServer: () => { sent += 1; return { accepted: true, bytes: 1 }; } });
  await assert.rejects(notifier.notifyCompletion(completion), /REMINDER_DELIVERY_ACK_OWNER_UNAVAILABLE/u);
  assert.equal(sent, 0);
});

test("发送完成必须等待实际结果回执并传播失败", async () => {
  let sent = 0;
  let acknowledge!: () => void;
  const receipt = new Promise<void>(resolve => { acknowledge = resolve; });
  const accepted = createServerReminderNotifier({
    canSend: () => true,
    sendToServer: () => { throw new Error("不能走无回执发送"); },
    notifyOnServer: async () => { sent += 1; await receipt; },
  });
  let completed = false;
  const pending = accepted.notifyCompletion(completion).then(() => { completed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 1);
  assert.equal(completed, false);
  acknowledge();
  await pending;
  assert.equal(completed, true);
  const rejected = createServerReminderNotifier({
    canSend: () => true,
    sendToServer: () => { throw new Error("不能走无回执发送"); },
    notifyOnServer: async () => { throw new Error("actual delivery failed"); },
  });
  await assert.rejects(rejected.notifyAction(action), /actual delivery failed/u);
});

test("云提醒回执按连接owner关联，断线拒绝在途结果且旧回执不能完成新发送", async () => {
  const sent: any[] = [];
  const owner = createReminderDeliveryOwner({ send: message => { sent.push(message); return { accepted: true }; }, timeoutMs: 1000 });
  const first = owner.notify({ t: "reminder.completionNotification", notification: completion });
  let firstDone = false;
  const observed = first.then(() => { firstDone = true; }, error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstDone, false);
  owner.disconnect(new Error("connection retired"));
  assert.match(String(await observed), /connection retired/);
  const second = owner.notify({ t: "reminder.actionNotification", notification: action });
  assert.equal(owner.accept({ t: "reminder.deliveryResult", requestId: sent[0].requestId, ok: true }), false);
  assert.equal(owner.accept({ t: "reminder.deliveryResult", requestId: sent[1].requestId, ok: false, errorCode: "REMINDER_SEND_FAILED" }), true);
  await assert.rejects(second, /REMINDER_SEND_FAILED/);
});
