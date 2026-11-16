import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatToolDisplayName } from "../src/features/chat/toolDisplayName.ts";

const chatPanelCss = readFileSync(new URL("../src/styles/chat-panel.css", import.meta.url), "utf8");

test("知识工具名称转为可读文案，不再暴露 MCP 全名", () => {
  assert.equal(formatToolDisplayName("mcp__aidt_runtime__aidt_knowledge_source_read"), "读取项目来源");
  assert.equal(formatToolDisplayName("knowledge.source.read"), "读取项目来源");
  assert.equal(formatToolDisplayName("knowledge.source.list"), "浏览项目目录");
});

test("未知工具去掉 MCP 前缀后保留原名，空名回退为调用工具", () => {
  assert.equal(formatToolDisplayName("mcp__github__create_issue"), "create_issue");
  assert.equal(formatToolDisplayName(""), "调用工具");
});

test("处理中提示单行省略，长工具名不换行", () => {
  assert.match(chatPanelCss, /\.typing__text \{[^}]*white-space: nowrap/u);
  assert.match(chatPanelCss, /\.typing__text \{[^}]*text-overflow: ellipsis/u);
});
