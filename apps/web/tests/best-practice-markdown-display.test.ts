import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTocHeadings,
  stripMatchingFirstMarkdownH1,
} from "../src/features/markdown/renderMarkdown.ts";

test("best practice display removes a matching first H1 outside code fences", () => {
  const source = "```md\n# 代码示例\n```\n\n# 可执行评审\n\n## 准备\n\n正文";
  const normalized = stripMatchingFirstMarkdownH1(source, "可执行评审");

  assert.doesNotMatch(normalized, /^# 可执行评审$/mu);
  assert.match(normalized, /# 代码示例/u);
  assert.deepEqual(extractTocHeadings(normalized).map((heading) => heading.text), ["准备"]);
});

test("best practice display preserves the source when the first H1 differs from the article title", () => {
  const source = "# 独立章节\n\n正文";
  assert.equal(stripMatchingFirstMarkdownH1(source, "文章标题"), source);
});
