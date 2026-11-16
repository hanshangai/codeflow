import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "@codeflowai/shared";

import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { createWeComReminderNotifier } from "../../apps/desktop/client/src/notifications/weComReminderNotifier.ts";

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-wecom-reminder-"));
  const db = openClientDb({ dbPath: path.join(tempDir, "client.db") });
  const workspaceId = "ws-wecom" as WorkspaceId;
  db.workspaces.upsert({ id: workspaceId, title: "WeCom WS", path: tempDir });
  return {
    db,
    workspaceId,
    cleanup() {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

test("WeCom 未订阅时不创建发送记录也不调用第三方", async () => {
  const notifier = createWeComReminderNotifier({
    records: {} as never,
    env: { CODEFLOWAI_WECOM_REMINDER_ENABLED: "1", CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://example.invalid/webhook" },
    fetchImpl: async () => { throw new Error("unexpected webhook"); },
  });
  await notifier.notifyCompletion({ workspaceId: "ws" } as never);
  await notifier.notifyAction({ workspaceId: "ws" } as never);
});

test("WeCom reminder notifier sends text notification once", async () => {
  const harness = createHarness();
  try {
    const requests: Array<{ url: string; body: any }> = [];
    const notifier = createWeComReminderNotifier({
      hasDemand: () => true,
      records: harness.db.weComReminderNotifications,
      now: () => 1_700_000_000_000,
      env: {
        CODEFLOWAI_WECOM_REMINDER_ENABLED: "1",
        CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
        CODEFLOWAI_WECOM_REMINDER_AT_MOBILES: "13800000000,13800000000",
        CODEFLOWAI_WECOM_REMINDER_AT_USER_IDS: "zhangsan",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
      },
    });

    const notification = {
      notificationKey: "thread:abc:receipt:turn-1",
      sourceType: "chat" as const,
      workspaceId: harness.workspaceId,
      workspaceTitle: "WeCom WS",
      title: "完成通知",
      summary: "会话已完成，等待您查看结果。",
      targetId: "thread-abc",
      completedAt: 1_700_000_000_000,
    };
    await notifier.notifyCompletion(notification);
    await notifier.notifyCompletion(notification);

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key");
    assert.equal(requests[0].body.msgtype, "text");
    assert.match(requests[0].body.text.content, /完成通知/);
    assert.match(requests[0].body.text.content, /会话名称：完成通知/);
    assert.deepEqual(requests[0].body.text.mentioned_mobile_list, ["13800000000"]);
    assert.deepEqual(requests[0].body.text.mentioned_list, ["zhangsan"]);

    const record = harness.db.weComReminderNotifications.get(notification.notificationKey);
    assert.equal(record?.status, "sent");
    assert.equal(record?.attempts, 1);
  } finally {
    harness.cleanup();
  }
});

test("WeCom reminder notifier uses orchestration title as summary", async () => {
  const harness = createHarness();
  try {
    const requests: Array<{ url: string; body: any }> = [];
    const notifier = createWeComReminderNotifier({
      hasDemand: () => true,
      records: harness.db.weComReminderNotifications,
      now: () => 1_700_000_000_000,
      env: {
        CODEFLOWAI_WECOM_REMINDER_ENABLED: "1",
        CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
      },
    });

    await notifier.notifyCompletion({
      notificationKey: "orch:instance-title:completed",
      sourceType: "orchestration",
      workspaceId: harness.workspaceId,
      workspaceTitle: "WeCom WS",
      title: "第1期-下线笔记模块入口",
      summary: "编排执行已完成，等待您查看结果。",
      targetId: "instance-title",
      completedAt: 1_700_000_000_000,
    });

    assert.match(requests[0].body.text.content, /任务摘要：第1期-下线笔记模块入口/);
    assert.doesNotMatch(requests[0].body.text.content, /任务摘要：编排执行已完成/);
  } finally {
    harness.cleanup();
  }
});

test("WeCom reminder notifier sends action notification once", async () => {
  const harness = createHarness();
  try {
    const requests: Array<{ url: string; body: any }> = [];
    const notifier = createWeComReminderNotifier({
      hasDemand: () => true,
      records: harness.db.weComReminderNotifications,
      now: () => 1_700_000_000_000,
      env: {
        CODEFLOWAI_WECOM_REMINDER_ENABLED: "1",
        CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
      },
    });

    const notification = {
      notificationKey: "orch:instance-approval:approval:review",
      sourceType: "orchestration" as const,
      workspaceId: harness.workspaceId,
      workspaceTitle: "WeCom WS",
      title: "删除已购套餐",
      summary: "人工审核 · 等待人工审核",
      targetId: "instance-approval",
      statusLabel: "待审核",
      actionLabel: "查看结果并审核",
      occurredAt: 1_700_000_000_000,
    };
    await notifier.notifyAction(notification);
    await notifier.notifyAction(notification);

    assert.equal(requests.length, 1);
    assert.match(requests[0].body.text.content, /任务类型：编排任务/);
    assert.match(requests[0].body.text.content, /任务名称：删除已购套餐/);
    assert.doesNotMatch(requests[0].body.text.content, /会话名称：删除已购套餐/);
    assert.match(requests[0].body.text.content, /任务状态：待审核/);
    assert.match(requests[0].body.text.content, /任务摘要：人工审核 · 等待人工审核/);
    assert.match(requests[0].body.text.content, /处理动作：查看结果并审核/);
    assert.match(requests[0].body.text.content, /提醒时间：/);

    const record = harness.db.weComReminderNotifications.get(notification.notificationKey);
    assert.equal(record?.status, "sent");
    assert.equal(record?.attempts, 1);
  } finally {
    harness.cleanup();
  }
});

test("WeCom reminder notifier records failed webhook response", async () => {
  const harness = createHarness();
  try {
    const notifier = createWeComReminderNotifier({
      hasDemand: () => true,
      records: harness.db.weComReminderNotifications,
      env: {
        CODEFLOWAI_WECOM_REMINDER_ENABLED: "true",
        CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
      },
      fetchImpl: async () => new Response(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook" }), { status: 200 }),
    });

    await assert.rejects(
      () => notifier.notifyCompletion({
        notificationKey: "orch:instance-1:completed",
        sourceType: "orchestration",
        workspaceId: harness.workspaceId,
        workspaceTitle: "WeCom WS",
        title: "编排完成",
        summary: "编排执行已完成，等待您查看结果。",
        targetId: "instance-1",
        completedAt: Date.now(),
      }),
      /WeCom webhook error 93000/,
    );

    const record = harness.db.weComReminderNotifications.get("orch:instance-1:completed");
    assert.equal(record?.status, "failed");
    assert.match(record?.errorMessage ?? "", /invalid webhook/);
  } finally {
    harness.cleanup();
  }
});

test("WeCom reminder notifier is no-op when disabled", async () => {
  const harness = createHarness();
  try {
    let called = false;
    const notifier = createWeComReminderNotifier({
      hasDemand: () => true,
      records: harness.db.weComReminderNotifications,
      env: {},
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    await notifier.notifyCompletion({
      notificationKey: "thread:none:receipt:turn-1",
      sourceType: "chat",
      workspaceId: harness.workspaceId,
      workspaceTitle: "WeCom WS",
      title: "不会发送",
      summary: "",
      targetId: "thread-none",
      completedAt: Date.now(),
    });

    assert.equal(called, false);
    assert.equal(harness.db.weComReminderNotifications.get("thread:none:receipt:turn-1"), null);
  } finally {
    harness.cleanup();
  }
});

test("WeCom reminder notifier fails fast on invalid enabled config", () => {
  const harness = createHarness();
  try {
    assert.throws(
      () => createWeComReminderNotifier({
      hasDemand: () => true,
        records: harness.db.weComReminderNotifications,
        env: {
          CODEFLOWAI_WECOM_REMINDER_ENABLED: "1",
          CODEFLOWAI_WECOM_REMINDER_WEBHOOK: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test-key",
          CODEFLOWAI_WECOM_REMINDER_TIMEOUT_MS: "invalid",
        },
      }),
      /TIMEOUT_MS must be between 1000 and 60000/,
    );
  } finally {
    harness.cleanup();
  }
});
