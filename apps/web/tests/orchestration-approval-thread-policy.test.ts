import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/features/orchestration/components/approval-dialog.vue", import.meta.url),
  "utf8",
);

test("普通人工审核不公开或发送会话恢复策略", () => {
  assert.doesNotMatch(source, /new-thread/u);
  assert.doesNotMatch(source, /节点会话策略/u);
  assert.doesNotMatch(source, /reuse-existing/u);
  assert.doesNotMatch(source, /threadReusePolicy/u);
  assert.doesNotMatch(source, /recoveryStrategy/u);
});
