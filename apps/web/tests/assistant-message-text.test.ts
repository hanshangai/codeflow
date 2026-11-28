import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAssistantMessageText } from "../src/features/messages/assistantMessageText.ts";
import { renderMarkdown } from "../src/features/markdown/renderMarkdown.ts";

const citation = "\uE200cite\uE202turn492203view2\uE202turn848013view0\uE202turn103274view3\uE202turn904712search3\uE201";

test("网页引用编号不再出现在历史消息的 Markdown 中", () => {
  const text = "**已同步。**\n" + citation + "\n\n[来源](https://example.com)";
  const display = formatAssistantMessageText(text, false);
  assert.equal(renderMarkdown(display), renderMarkdown("**已同步。**\n\n[来源](https://example.com)"));
});

test("流式消息在引用标记的每个分段都只显示正文，后续输出照常显示", () => {
  for (let i = 1; i <= citation.length; i++) {
    assert.equal(formatAssistantMessageText("正文。" + citation.slice(0, i), true), "正文。", String(i));
  }
  assert.equal(formatAssistantMessageText("正文。" + citation + "后续。", true), "正文。后续。");
});

test("中断的消息转为完成态后仍隐藏可识别的残缺引用", () => {
  for (let i = "\uE200cite\uE202".length; i < citation.length; i++) {
    assert.equal(formatAssistantMessageText("正文。" + citation.slice(0, i), false), "正文。", String(i));
  }
});

test("独占一行的引用不打断段落，保留原有的空行", () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = ["第一行", citation, "第二行", "", "下一段"].join(newline);
    const expected = ["第一行", "第二行", "", "下一段"].join(newline);
    assert.equal(formatAssistantMessageText(text, false), expected);
  }
});

test("保留普通引用编号、其他私用字符和不符合协议的文本", () => {
  const text = "中文 turn492203view2 \uE000 \uE200cite\uE202example\uE201 \uE200cite\uE202other";
  assert.equal(formatAssistantMessageText(text, false), text);
  assert.equal(formatAssistantMessageText(text, true), text);
  for (const ambiguous of ["\uE200", "\uE200ci", "\uE200cite"]) {
    assert.equal(formatAssistantMessageText("正文。" + ambiguous, false), "正文。" + ambiguous);
  }
});
