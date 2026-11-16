import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(
  new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url),
  "utf8",
);
const messagesCss = readFileSync(new URL("../src/styles/messages.css", import.meta.url), "utf8");

/**
 * 消息行是「头像 + 行内间距」再放内容，卡片没有头像，必须补等宽左缩进才能和内容列对齐。
 * 缩进值直接从 messages.css 读出来，布局尺寸一变测试即红，避免两边悄悄漂移。
 */
test("workflow card indents to the message content column", () => {
  const avatarWidth = Number(messagesCss.match(/\.msg-avatar \{[\s\S]*?width: (\d+)px/u)?.[1] ?? 0);
  const rowGap = Number(messagesCss.match(/\.msg-row \{[\s\S]*?gap: (\d+)px/u)?.[1] ?? 0);
  assert.ok(avatarWidth > 0 && rowGap > 0, "应能从 messages.css 读到头像宽度与行间距");
  const expected = avatarWidth + rowGap;
  assert.ok(
    panel.includes(`margin: 12px 0 12px ${expected}px;`),
    `卡片左缩进应等于头像 ${avatarWidth}px + 间距 ${rowGap}px = ${expected}px`,
  );
});

/** 小屏下消息行改用更小的头像与间距，卡片缩进必须同步收窄。 */
test("workflow card narrows its indent on small screens", () => {
  const mobileBlock = messagesCss.slice(messagesCss.indexOf("@media (max-width: 767px)"));
  const avatarWidth = Number(mobileBlock.match(/\.msg-avatar \{[\s\S]*?width: (\d+)px/u)?.[1] ?? 0);
  const rowGap = Number(mobileBlock.match(/\.msg-row \{[\s\S]*?gap: (\d+)px/u)?.[1] ?? 0);
  assert.ok(avatarWidth > 0 && rowGap > 0, "应能从小屏媒体查询读到头像宽度与间距");
  const expected = avatarWidth + rowGap;
  assert.ok(
    panel.includes(`@media (max-width: 767px) { .chat-workflow { margin-left: ${expected}px; } }`),
    `小屏左缩进应等于 ${avatarWidth}px + ${rowGap}px = ${expected}px`,
  );
});
