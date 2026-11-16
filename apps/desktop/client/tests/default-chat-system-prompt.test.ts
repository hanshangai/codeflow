import test from "node:test";
import assert from "node:assert/strict";

import { buildDefaultChatSystemPrompt, DEFAULT_CHAT_SYSTEM_PROMPT_RULES } from "../src/app/defaultChatSystemPrompt.ts";

test("default chat system prompt keeps validated base rules", () => {
  const prompt = buildDefaultChatSystemPrompt();

  assert.equal(prompt.split("\n").length, DEFAULT_CHAT_SYSTEM_PROMPT_RULES.length);
  assert.match(prompt, /必须使用中文沟通。/);
  assert.match(prompt, /除非用户明确要求为子 agent 指定其他模型，否则必须继承父 agent/);
  assert.match(prompt, /禁止隐式全量操作。/);
  assert.match(prompt, /优先使用当前引擎提供的原生文件编辑能力做最小差异修改/);
  assert.match(prompt, /不得把终端乱码当成源码事实/);
  assert.match(prompt, /必须先用 UTF-8 方式读取文件/);
  assert.match(prompt, /必须仅针对本次实际改动的文本文件执行当前仓库可用的 UTF-8 检查/);
  assert.match(prompt, /如果当前仓库存在 `scripts\/check-utf8\.mjs`，优先执行/);
  assert.match(prompt, /不得因缺少该脚本直接判定验证失败/);
  assert.match(prompt, /必须立即停止并向用户报告失败文件/);
  assert.match(prompt, new RegExp("\u951F\u65A4\u62F7"));
});

test("default chat system prompt appends extra rules without preserving blanks", () => {
  const prompt = buildDefaultChatSystemPrompt(["追加规则 A", "", null, "追加规则 B"]);

  assert.match(prompt, /追加规则 A\n追加规则 B$/);
  assert.equal(DEFAULT_CHAT_SYSTEM_PROMPT_RULES.at(-1), "以下只读命令可无需确认：`git status`、`git diff`、`git log`、`git show`、`git blame`、`git grep`、`git ls-files`、`git rev-parse`。");
});
