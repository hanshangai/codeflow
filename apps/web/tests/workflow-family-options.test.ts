import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WORKFLOW_FAMILIES } from "@codeflowai/shared";

const editorSource = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/** 截取流程类型下拉自身的片段，避免匹配到页面上其他 select。 */
function readFamilyOptionValues(): string[] {
  const selectStart = editorSource.indexOf('class="wf-editor__select"');
  const selectEnd = editorSource.indexOf("</select>", selectStart);
  return [...editorSource.slice(selectStart, selectEnd).matchAll(/<option value="([^"]+)"/gu)].map((match) => match[1]!);
}

test("流程设置的类型下拉覆盖共享枚举的全部取值", () => {
  const options = readFamilyOptionValues();
  assert.deepEqual(options, [...WORKFLOW_FAMILIES]);
});
