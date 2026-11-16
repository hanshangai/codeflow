import test from "node:test";
import assert from "node:assert/strict";

import {
  TASK_INTAKE_TITLE_MAX_LENGTH,
  getTaskIntakeTitle,
  normalizeTaskIntakeTitle,
} from "../../packages/shared/src/index.ts";

test("normalizeTaskIntakeTitle 优先使用显式标题并压平成单行", () => {
  const title = normalizeTaskIntakeTitle("  任务看板\n首页\t改版  ", "不会使用这个回退");
  assert.equal(title, "任务看板 首页 改版");
});

test("normalizeTaskIntakeTitle 在标题为空时回退到目标正文", () => {
  const title = normalizeTaskIntakeTitle("", "  修复角色编辑流程的保存与校验 ");
  assert.equal(title, "修复角色编辑流程的保存与校验");
});

test("normalizeTaskIntakeTitle 会截断到最大长度", () => {
  const raw = "标题".repeat(40);
  const title = normalizeTaskIntakeTitle(raw);
  assert.equal(Array.from(title).length, TASK_INTAKE_TITLE_MAX_LENGTH);
});

test("getTaskIntakeTitle 对旧数据缺失 title 时仍能稳定取值", () => {
  const title = getTaskIntakeTitle({
    title: "",
    goal: "使用目标正文作为旧数据标题回退",
  } as any);
  assert.equal(title, "使用目标正文作为旧数据标题回退");
});
