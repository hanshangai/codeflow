import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

let fixtureSeq = 0;
/** 执行真实表单 setup；只隔离浏览器、网络和 store，保留 Vue 的响应式监听。 */
function fixture(t: test.TestContext, delivery?: "async", surface?: { active?: boolean; mainView: string; selectedThreadId: string }) {
  const threadId = `thread-${++fixtureSeq}`;
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const source = fs.readFileSync("apps/web/src/features/messages/components/items/user-input-request-item.vue", "utf8");
  const script = compileScript(parse(source).descriptor, { id: "async-input" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const props = vue.reactive({ active: surface?.active, item: { kind: "userInputRequest", id: threadId, requestId: threadId, threadId, workspaceId: "workspace",
    delivery, state: "pending", header: "问题", prompt: "补充输入", questions: [{ id: "q", question: "选择范围", header: "范围" }] } });
  const chat = vue.reactive({ selectedThreadId: surface?.selectedThreadId ?? threadId }), ui = vue.reactive({ mainView: surface?.mainView ?? "chat" });
  const config = { connected: true, webSessionId: "web", webInstanceId: "instance" };
  const apiCalls: unknown[] = [];
  const modules: Record<string, unknown> = {
    vue: { ...vue, inject: () => null, onBeforeUnmount() {}, onDeactivated() {} },
    "ant-design-vue": { message: {}, Modal: {} }, "@ant-design/icons-vue": {},
    "@/composables/useClipboard": { copyToClipboard() {} },
    "../../../../api/request": { createApiResultError: (result: any) => new Error(result.message) },
    "../../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref({}) }) },
    "../../../../api/interactions": { respondUserInput: async (_ctx: unknown, body: unknown) => { apiCalls.push(body); return { ok: true }; } },
    "../../../../services/desktop": { isDesktopWorkspace: () => true },
    "../../../../store/chat": { useChatStore: () => chat }, "../../../../store/config": { useConfigStore: () => config },
    "../../../../store/ui": { useUiStore: () => ui },
  };
  const module = { exports: {} as any }, scope = vue.effectScope();
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (!(id in modules)) throw new Error(`Unexpected import: ${id}`);
    return modules[id];
  }, module, module.exports);
  const state = scope.run(() => module.exports.default.setup(props, { expose() {} }))!;
  t.after(() => scope.stop());
  return { props, chat, ui, state, apiCalls, remount: () => scope.run(() => module.exports.default.setup(props, { expose() {} }))! };
}

test("异步问题不自动打开，用户打开后重复通知不抢回焦点", async t => {
  const f = fixture(t, "async");
  assert.equal(f.state.dialogOpen.value, false, "问题到达时不自动弹出");
  f.state.dialogOpen.value = true;
  f.props.item = { ...f.props.item };
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, true, "重复通知不改变用户已打开的弹层");
  assert.equal(f.remount().dialogOpen.value, false, "重挂载不能自动抢焦点");
  assert.deepEqual(f.apiCalls, [], "打开弹框不自动回答或提交默认选项");
});

test("同步与异步请求都由用户点击打开；切换会话关闭表单", async t => {
  const sync = fixture(t);
  assert.equal(sync.state.dialogOpen.value, false);
  const asyncInput = fixture(t, "async");
  assert.equal(asyncInput.state.dialogOpen.value, false, "异步请求也不自动打开");
  asyncInput.state.dialogOpen.value = true;
  asyncInput.chat.selectedThreadId = "another";
  await vue.nextTick();
  assert.equal(asyncInput.state.dialogOpen.value, false, "切换会话必须关闭旧表单");
});

test("消息流卡片与输入区上方实例都不自动弹出异步表单", async t => {
  const messageCard = fixture(t, "async");
  assert.equal(messageCard.state.dialogOpen.value, false, "消息流卡片保持手动点击打开");
  const composerCard = fixture(t, "async");
  assert.equal(composerCard.state.dialogOpen.value, false, "输入区上方实例同样手动点击打开");
});

test("可见编排容器不自动弹框，隐藏后关闭已打开表单", async t => {
  const f = fixture(t, "async", { active: true, mainView: "orchestration", selectedThreadId: "another" });
  assert.equal(f.state.dialogOpen.value, false, "可见容器不自动弹框");
  f.state.dialogOpen.value = true;
  f.props.active = false;
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, false, "隐藏后关闭");
  f.props.active = true;
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, false, "再次激活不能自动打开");
});

test("隐藏容器激活后也不自动弹框", async t => {
  const f = fixture(t, "async", { active: false, mainView: "orchestration", selectedThreadId: "another" });
  assert.equal(f.state.dialogOpen.value, false);
  f.props.active = true;
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, false);
});

test("问题提交事件关闭残留表单，同编号的新问题不继承旧弹框", async t => {
  const f = fixture(t);
  f.state.dialogOpen.value = true;
  f.props.item = { ...f.props.item, state: "submitted" };
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, false, "其他卡片或页面提交后应关闭待填写弹框");
  f.state.dialogOpen.value = true;
  f.props.item = { ...f.props.item };
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, true, "用户仍可主动查看已提交答案");
  f.props.item = { ...f.props.item, id: "new-question", state: "pending" };
  await vue.nextTick();
  assert.equal(f.state.dialogOpen.value, false, "原生请求编号复用时也不能保留上一题弹框");
});
