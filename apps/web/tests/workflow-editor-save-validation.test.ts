import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);

/** 取一个顶层函数体：源码是 CRLF，用顶格 "}" 作为结束边界，避免嵌进内部缩进的括号。 */
function readFunctionBody(signature: string): string {
  const start = editor.indexOf(signature);
  if (start < 0) return "";
  const end = editor.indexOf("\r\n}\r\n", start);
  return end < 0 ? editor.slice(start) : editor.slice(start, end);
}

/** 只有服务端也会拒绝的硬约束才阻断落库：START/END 数量是本编辑器规则，服务端不校验。 */
test("save gate blocks only constraints the server also rejects", () => {
  assert.ok(editor.includes("const blockingDagErrors = computed("), "硬约束需要独立的计算属性");
  assert.ok(editor.includes("if (blockingDagErrors.value.length) {"), "保存入口必须用硬约束集合阻断");
  assert.ok(editor.includes("blocking: true"), "role 节点缺 roleId 应标为硬约束");
  assert.ok(editor.includes("blocking: false"), "START/END 数量不应标为硬约束");
  const gate = editor.indexOf("if (blockingDagErrors.value.length) {");
  const request = editor.indexOf("await orch.saveWorkflow(ctx.value, props.workspaceId, payload);");
  assert.ok(request > gate, "阻断必须发生在发出保存请求之前");
});

/** 新建节点默认同名，未绑定角色的提示必须带节点 id 才区分得出是哪一个。 */
test("unbound role nodes are reported with their node id", () => {
  assert.ok(
    editor.includes("`角色节点 ${workflowNode.label}(${workflowNode.id}) 未绑定 role`"),
    "未绑定角色的提示需要带节点 id",
  );
});

/** 弹窗内保存只记住当前节点编辑（本地草稿）：不落服务端，也不被其他节点的问题挡住。 */
test("binding dialog save keeps edits local without global validation", () => {
  const body = readFunctionBody("function saveBindingEditsAndClose(): void {");
  assert.ok(body, "弹窗保存入口应存在且为同步的本地暂存");
  assert.ok(body.includes("persistWorkflowDraft();"), "必须写入本地草稿");
  assert.ok(!body.includes("saveWorkflow()"), "弹窗保存不得触发服务端保存与全局校验");
  assert.ok(body.includes("已保存到本地草稿"), "提示必须点明只到了本地，否则用户会误以为已落库");
  assert.ok(editor.includes("<SaveOutlined /> 保存</button>"), "弹窗按钮文案应为「保存」");
  assert.ok(!editor.includes("saveWorkflowAndCloseBindingEditor"), "旧的整流程保存入口不得残留");
});

/** 暂存必须监听草稿内容：isDirty 是布尔，只在第一次变脏时跳变，用它只能存下第一次编辑。 */
test("draft autosave listens to draft content, not the dirty flag", () => {
  assert.ok(editor.includes("watch(draftSnapshot, scheduleWorkflowDraftPersist)"), "必须监听草稿快照");
  assert.ok(!editor.includes("watch(isDirty, (dirty) => {"), "不得用 isDirty 布尔驱动暂存");
  assert.ok(editor.includes("draftSnapshot,"), "草稿快照需要从 dirty state 组合式函数取出");
});

/** 待写定时器必须收口，否则会把内容写到错误的流程键下，或复活已放弃的草稿。 */
/** 初始化和切换会改变快照，但没有用户编辑时不得创建本地草稿。 */
test("clean workflow initialization does not persist a draft", () => {
  const scheduleStart = editor.indexOf("function scheduleWorkflowDraftPersist(): void {");
  const scheduleEnd = editor.indexOf("\r\n}\r\n", scheduleStart);
  const scheduleBody = editor.slice(scheduleStart, scheduleEnd);
  assert.ok(scheduleBody.includes("if (!isDirty.value) {"), "初始化期间必须检查干净快照");
  assert.ok(scheduleBody.includes("if (draftHydrationReady) clearWorkflowDraft();"), "初始化期间不得清理尚未完成恢复检查的草稿");
  assert.ok(scheduleBody.includes("if (isDirty.value) persistWorkflowDraft();"), "定时器触发前必须再次确认仍有编辑");
  const persistStart = editor.indexOf("function persistWorkflowDraft(): void {");
  const persistEnd = editor.indexOf("\r\n}\r\n", persistStart);
  assert.ok(editor.slice(persistStart, persistEnd).includes("!isDirty.value"), "写入边界也必须拒绝干净草稿");
});

/** 兼容修复前残留的干净本地快照，恢复前必须与当前服务端基线比较并清理。 */
test("matching local workflow snapshots are cleared without becoming dirty", () => {
  assert.ok(editor.includes("isSnapshotDifferentFromBaseline(draft.definition)"), "恢复前必须比较服务端基线");
  assert.ok(editor.includes("if (!isSnapshotDifferentFromBaseline(draft.definition))"), "一致快照必须直接清理");
});

test("pending draft writes are cancelled on context changes", () => {
  assert.ok(editor.includes("function cancelPendingDraftPersist(): void {"), "需要统一的取消防入口");
  const loadWatcher = editor.slice(
    editor.indexOf("watch([() => props.workflowId"),
    editor.indexOf("watch(isDirty, (dirty) => emit"),
  );
  assert.ok(loadWatcher.includes("cancelPendingDraftPersist();"), "切换流程时必须取消待写定时器");

  const discardBody = readFunctionBody("function discardUnsavedChanges(): void {");
  assert.ok(discardBody.includes("cancelPendingDraftPersist();"), "放弃改动时必须取消待写定时器");
  assert.ok(discardBody.includes("clearWorkflowDraft();"), "放弃改动时必须清除本地草稿");
});

/** 只读资产不得恢复草稿：恢复会让 hasUnsavedChanges 变真，禁用校验/发布却无处保存。 */
test("draft is not restored on readonly assets", () => {
  const body = readFunctionBody("function restoreWorkflowDraft(): {");
  assert.ok(body, "应存在恢复函数");
  assert.ok(body.includes("if (isBuiltinReadonly.value) return"), "只读资产必须直接不恢复");
  // 恢复要读只读态，而加载 watcher 是 immediate，首次会在 setup 中途同步执行，必须延到下一个 tick。
  assert.ok(editor.includes("void nextTick(() => {"), "恢复必须延到 setup 完成后执行");
  assert.ok(editor.includes("applyRestoredWorkflowDraft();"), "setup 完成后必须执行草稿恢复");
});

/** 半损坏草稿必须被守卫挡住，否则渲染路径会抛错且该键永不清除。 */
test("draft guard validates node shape before restoring", () => {
  const body = readFunctionBody("function isRestorableDraftDefinition(value: unknown): value is Omit<WorkflowDefinition, \"createdAt\" | \"updatedAt\"> {");
  assert.ok(body, "恢复前需要结构守卫");
  for (const field of ["candidate.id", "candidate.type", "candidate.position?.x", "candidate.position?.y"]) {
    assert.ok(body.includes(field), `守卫需要校验 ${field}`);
  }
});

/** 旧草稿与当前服务端版本不一致时要提示，避免静默覆盖他人改动。 */
test("restored draft records and checks the server version it was based on", () => {
  assert.ok(editor.includes("baseUpdatedAt: loadedServerUpdatedAt.value"), "草稿要记录基于的服务端版本");
  assert.ok(editor.includes('message.warning("本地草稿基于较早的服务端版本'), "版本变化时必须提示");
  assert.ok(editor.includes("if (!isDirty.value) {"), "与服务端内容一致时不应谎报有草稿");
});
