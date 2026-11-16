import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const floatSource = readFileSync(
  new URL("../src/features/chat/components/user-message-float.vue", import.meta.url),
  "utf8",
);

/** 收起态浮在消息区右上角，且脱离文档流——顶部整行高度要还给消息。 */
test("用户消息浮窗收起态脱离文档流并贴右上角", () => {
  const rule = floatSource.match(/\.chat-user-msg-float--collapsed \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.ok(rule, "应有收起态样式规则");
  assert.match(rule, /position: absolute;/u, "收起态应脱离文档流，不再占消息流一行");
  assert.match(rule, /top: 16px;/u, "收起态应贴消息区顶部");
  assert.match(rule, /right: 16px;/u, "收起态应贴右侧、与消息内容右边界对齐");
  assert.match(rule, /background: var\(--app-panel-bg/u, "浮在消息之上需要不透明底色兜底");
});

/** 展开态保持占位：基类仍是 44px 通栏一行，不能被改成定位元素而遮挡消息。 */
test("展开态保持占位、不遮挡消息", () => {
  const base = floatSource.match(/\n\.chat-user-msg-float \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.ok(base, "应有浮窗基类样式规则");
  assert.match(base, /height: 44px;/u, "展开态仍占一行高度");
  assert.ok(!base.includes("position: absolute"), "基类不应绝对定位");
});
