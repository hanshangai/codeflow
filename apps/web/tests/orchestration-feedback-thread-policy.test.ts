import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/features/orchestration/components/feedback-dialog.vue", import.meta.url),
  "utf8",
);

test("反馈弹窗不公开会话恢复策略参数或说明面板", () => {
  assert.doesNotMatch(source, /requestedThreadPolicy/u);
  assert.doesNotMatch(source, /showThreadPolicy/u);
  assert.doesNotMatch(source, /threadPolicyHelpLines/u);
  assert.doesNotMatch(source, /threadReusePolicy/u);
  assert.doesNotMatch(source, /recoveryStrategy/u);
  assert.doesNotMatch(source, /继续使用原会话/u);
  assert.doesNotMatch(source, /系统会继续恢复原会话/u);
  assert.doesNotMatch(source, /allowsExplicitNewThreadRecovery/u);
  assert.doesNotMatch(source, /threadRecoveryStrategy/u);
  assert.doesNotMatch(source, /canChooseNewThread/u);
  assert.doesNotMatch(source, /原会话已确认无法恢复/u);
});

test("反馈弹窗不保留恢复二选一控件", () => {
  assert.doesNotMatch(source, /恢复方式（必选）/u);
  assert.doesNotMatch(source, /重试原会话/u);
  assert.doesNotMatch(source, /新建会话/u);
});
