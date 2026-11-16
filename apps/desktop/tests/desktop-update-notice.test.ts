import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createUpdateNoticeController,
  readUpdateNoticeState,
  shouldNotifyUpdateNotice,
  UPDATE_NOTICE_DAILY_INTERVAL_MS,
  type PreparedUpdateNotice,
} from "../src/updateNotice.js";

/** 每个用例使用独立数据目录，避免提醒节流跨用例污染。 */
function fixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-update-notice-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { file: path.join(directory, "update-notice.json") };
}

function prepared(releaseId = "release-1"): PreparedUpdateNotice {
  return { releaseId, version: "2026.11.13.05", currentVersion: "2026.11.13.04", shellOnly: false };
}

test("首次下载完成立即提醒，24 小时内同一版本不重复", async t => {
  const { file } = fixture(t);
  let now = 1_000;
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => now });

  const notice = await controller.evaluate(prepared());
  assert.equal(notice?.releaseId, "release-1");
  assert.equal(notice?.version, "2026.11.13.05");
  assert.equal((await controller.peek())?.releaseId, "release-1");
  assert.equal((await readUpdateNoticeState(file)).state?.lastNotifiedAt, 1_000);

  // 待关闭提醒不重复推送，只由 peek 供页面补查。
  assert.equal(await controller.evaluate(prepared()), null);
  assert.ok(await controller.peek());
  now += 60 * 60 * 1000;
  await controller.dismiss("later");
  assert.equal((await readUpdateNoticeState(file)).state?.lastNotifiedAt, now);
  assert.equal(await controller.evaluate(prepared()), null);
  assert.equal((await controller.peek()), null);

  now += UPDATE_NOTICE_DAILY_INTERVAL_MS;
  assert.equal((await controller.evaluate(prepared()))?.releaseId, "release-1");
});

test("候选被撤销后清空待提醒，不再展示过期版本", async t => {
  const { file } = fixture(t);
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => 3_000 });
  assert.ok(await controller.evaluate(prepared()));
  await controller.evaluate(null);
  assert.equal(await controller.peek(), null);
  assert.equal(await controller.evaluate(prepared()), null);
});

test("新版本清空旧节流并立即提醒", async t => {
  const { file } = fixture(t);
  let now = 5_000;
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => now });
  assert.ok(await controller.evaluate(prepared("release-1")));
  await controller.dismiss("later");
  now += 1_000;
  assert.equal(await controller.evaluate(prepared("release-1")), null);
  assert.equal((await controller.evaluate(prepared("release-2")))?.releaseId, "release-2");
});

test("本次不再提醒只抑制当前运行，新实例恢复每日提醒", async t => {
  const { file } = fixture(t);
  let now = 10_000;
  const first = createUpdateNoticeController({ noticeFile: file, now: () => now });
  assert.ok(await first.evaluate(prepared()));
  await first.dismiss("session");
  assert.equal(await first.evaluate(prepared()), null);
  now += UPDATE_NOTICE_DAILY_INTERVAL_MS * 2;
  assert.equal(await first.evaluate(prepared()), null);

  const restarted = createUpdateNoticeController({ noticeFile: file, now: () => now });
  assert.equal((await restarted.evaluate(prepared()))?.releaseId, "release-1");
});

test("手动检查刷新节流但不解除本次抑制", async t => {
  const { file } = fixture(t);
  let now = 20_000;
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => now });
  assert.ok(await controller.evaluate(prepared()));
  await controller.markSeen(prepared());
  assert.equal((await readUpdateNoticeState(file)).state?.lastNotifiedAt, 20_000);
  await controller.dismiss("session");
  now += UPDATE_NOTICE_DAILY_INTERVAL_MS * 2;
  assert.equal(await controller.evaluate(prepared()), null);
});

test("损坏的提醒状态按未提醒处理并显式上报读取失败", async t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, "{not-json");
  const errors: unknown[] = [];
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => 30_000,
    onStateError(error, context) { errors.push([error, context.operation]); } });
  assert.ok(await controller.evaluate(prepared()));
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as [unknown, string])[1], "read");
});

test("提醒状态写入失败保留内存提醒并上报写入失败", async t => {
  const file = path.join(os.tmpdir(), `missing-dir-${Date.now()}`, "update-notice.json");
  const errors: unknown[] = [];
  const controller = createUpdateNoticeController({ noticeFile: file, now: () => 40_000,
    onStateError(error, context) { errors.push([error, context.operation]); } });
  const notice = await controller.evaluate(prepared());
  assert.equal(notice?.releaseId, "release-1");
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as [unknown, string])[1], "write");
});

test("判定函数在时间回拨时不重复提醒", () => {
  const state = { schemaVersion: 1 as const, releaseId: "release-1", version: "v1", lastNotifiedAt: 100_000 };
  assert.equal(shouldNotifyUpdateNotice({ prepared: prepared("release-1"), state, sessionDismissedReleaseId: null, now: 50_000 }), false);
  assert.equal(shouldNotifyUpdateNotice({ prepared: prepared("release-1"), state, sessionDismissedReleaseId: "release-1", now: 200_000 }), false);
  assert.equal(shouldNotifyUpdateNotice({ prepared: null, state, sessionDismissedReleaseId: null, now: 200_000 }), false);
});
