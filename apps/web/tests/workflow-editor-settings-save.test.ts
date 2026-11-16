import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/** 模型配置不再有独立保存按钮，落库统一走底部「保存」。 */
test("流程设置不再提供独立的模型配置保存按钮", () => {
  assert.ok(!editor.includes("保存模型配置"), "不应再出现「保存模型配置」按钮文案");
  assert.ok(!editor.includes("canSaveExecutionDefault"), "只服务该按钮的禁用校验应一并移除");
  assert.ok(editor.includes("恢复默认"), "模型配置区应保留「恢复默认」入口");
  assert.match(editor, /<SaveOutlined \/> 保存<\/button>/u, "底部保存入口文案应为「保存」");
  assert.match(editor, />关闭<\/button>/u, "底部关闭入口文案应为「关闭」");
});

/** 底部保存要同时提交模型配置与流程定义，且模型配置先提交。 */
test("底部保存先提交模型配置再保存流程定义", () => {
  const body = editor.match(/async function saveWorkflowAndCloseSettings\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.ok(body, "应保留 saveWorkflowAndCloseSettings");
  const modelIndex = body.indexOf("submitExecutionDefault()");
  const workflowIndex = body.indexOf("saveWorkflow()");
  assert.ok(modelIndex >= 0, "底部保存应提交模型配置");
  assert.ok(workflowIndex >= 0, "底部保存应保存流程定义");
  assert.ok(modelIndex < workflowIndex, "模型配置必须先提交：流程定义被 DAG 校验挡住时不该连带存不下模型配置");
  assert.match(body, /if \(saved && modelSaved\)/u, "两者都成功才关闭弹窗");
});

/** 提交口径按表单意图分支：无改动跳过、引擎置空等于恢复默认、未选模型只提示不阻断。 */
test("模型配置提交按表单意图分支且不阻断流程模板保存", () => {
  const body = editor.match(/async function submitExecutionDefault\(\)[\s\S]*?\n\}/u)?.[0] ?? "";
  assert.ok(body, "应有 submitExecutionDefault");
  assert.match(body, /if \(!isExecutionDefaultDirty\(\)\) return true;/u, "无改动时应跳过提交");
  assert.match(body, /if \(!executionDefaultEngine\.value\) return clearExecutionDefault\(\);/u, "引擎置空应按恢复默认处理");
  assert.match(body, /message\.warning\("模型配置未选择模型，本次只保存流程"\);/u, "未选模型时只提示，不阻断流程保存");
});
