import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/** 节点绑定字段多，靠分组两列网格压缩纵向长度，不允许退回单列堆叠。 */
test("binding dialog lays fields out in two-column groups", () => {
  assert.match(editor, /wf-editor__modal--binding/u);
  assert.match(
    editor,
    /\.wf-editor__modal--binding \.wf-editor__group-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 14px 20px; \}/u,
  );
  for (const title of ["基础信息", "执行策略", "输出与结果", "知识与输入"]) {
    assert.match(editor, new RegExp(`wf-editor__group-title">${title}`, "u"), `缺少分组：${title}`);
  }
});

/** 弹窗 fieldset 带 :disabled，原生 button 会被连同禁用，折叠触发器只能是键盘可达的非表单元素。 */
test("collapsible groups stay operable inside the disabled fieldset", () => {
  assert.match(editor, /class="wf-editor__group-head"\s+role="button"\s+tabindex="0"/u);
  assert.match(editor, /@keydown\.enter\.prevent="bindingOutputSectionOpen = !bindingOutputSectionOpen"/u);
  assert.match(editor, /@keydown\.space\.prevent="bindingKnowledgeSectionOpen = !bindingKnowledgeSectionOpen"/u);
  assert.doesNotMatch(editor, /<button[^>]*wf-editor__group-head/u);
});

/** 折叠区必须带出当前值，否则收起后看不到已配置内容。 */
test("collapsed groups summarise their current values", () => {
  assert.match(editor, /const bindingOutputSectionOpen = ref\(false\);/u);
  assert.match(editor, /const bindingKnowledgeSectionOpen = ref\(false\);/u);
  assert.match(editor, /\{\{ bindingOutputSummary \}\}/u);
  assert.match(editor, /\{\{ bindingKnowledgeSummary \}\}/u);
});

/** 长解释文案改走 tooltip；随数据变化的动态提示必须留在页面可见。 */
test("long field hints move into tooltips while dynamic hints stay visible", () => {
  for (const label of ["条件说明", "工作项模式", "启动前置提示说明", "允许退回到的上游节点", "输出模式", "结果名称", "结果保存方式", "额外知识库"]) {
    assert.match(editor, new RegExp(`<span>${label}[^<]*<a-tooltip`, "u"), `${label} 的长说明应移入 tooltip`);
  }
  assert.match(
    editor,
    /<div v-else class="wf-editor__field-hint">当前节点上游还没有其他角色节点，暂时无需单独配置。<\/div>/u,
  );
});

/** 单行字段的名称与控件同行，省下一行高度；含 textarea 的字段必须保持纵向，否则控件被压窄。 */
test("inline fields put the label beside the control", () => {
  const rule = editor.match(
    /\.wf-editor__modal--binding label\.wf-editor__field:not\(:has\(textarea\)\) \{[\s\S]*?\r?\n\}/u,
  )?.[0] ?? "";
  assert.ok(rule, "单行字段应改为名称与控件同行");
  assert.ok(rule.includes("grid-template-columns: auto minmax(0, 1fr);"), "同行布局应是「名称 + 控件」两列");
  assert.ok(rule.includes("align-items: center;"), "名称与控件需要垂直居中对齐");
  // 只作用于 <label> 字段：checkbox 网格与卡片列表用 <div>，不能被改成两列。
  assert.ok(
    !/\.wf-editor__modal--binding \.wf-editor__field:not\(:has\(textarea\)\)/u.test(editor),
    "同行规则必须限定在 label 上，避免影响 div 字段",
  );
});

/** 「节点绑定」与弹窗标题重复已删；节点 ID 保留并加说明，因为「输入绑定」要按它引用上游节点。 */
test("binding dialog labels the node id instead of repeating its own title", () => {
  assert.ok(!editor.includes("<h4>节点绑定</h4>"), "与弹窗标题重复的区块标题应已删除");
  assert.ok(editor.includes("节点 ID：{{ selectedWorkflowNode.id }}"), "节点 ID 需要带说明文字，不能裸显示");
  assert.ok(
    editor.includes("来源节点 ID 填上游节点的 ID，可在该节点的绑定弹窗中查看。"),
    "输入绑定需要说明来源节点 ID 从哪里取",
  );
});
