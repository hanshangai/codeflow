import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/** 读取需求编辑面板源码，用于锁定重复提交防护的交互契约。 */
function readTaskIntakePanelSource(): string {
  return readFileSync(new URL("../src/features/orchestration/components/task-intake-panel.vue", import.meta.url), "utf8");
}

test("需求保存使用单次提交锁并在请求结束后释放", () => {
  const source = readTaskIntakePanelSource();
  const saveRequirement = source.match(/async function saveRequirement\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.ok(saveRequirement, "missing saveRequirement");
  assert.match(saveRequirement, /if \(requirementSaving\.value \|\| !canSubmit\.value\) return;/);
  assert.match(saveRequirement, /requirementSaving\.value = true;\s+try \{/);
  assert.match(saveRequirement, /finally \{\s+requirementSaving\.value = false;/);
});

test("需求保存期间禁用退出和提交并显示进度", () => {
  const source = readTaskIntakePanelSource();

  assert.match(source, /const canSubmit = computed\(\(\) => \(\s+!requirementSaving\.value/);
  assert.match(source, /:closable="!requirementSaving"/);
  assert.match(source, /:keyboard="!requirementSaving"/);
  assert.match(source, /:mask-closable="!requirementSaving"/);
  assert.match(source, /:disabled="requirementSaving" @click="closeRequirementModal">取消<\/button>/);
  assert.match(source, /requirementSaving \? "保存中\.\.\." : isEditMode \? "保存修改" : "保存需求"/);
});
