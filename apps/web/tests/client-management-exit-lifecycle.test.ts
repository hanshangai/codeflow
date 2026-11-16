import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";

/** 执行当前管理框完整 setup；任何退出请求或计时器都会令测试失败。 */
function harness(t: test.TestContext) {
  const source = fs.readFileSync(new URL("../src/features/settings/components/client-management-modal.vue", import.meta.url), "utf8");
  const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = ts.transpileModule(compileScript(parse(source).descriptor, { id: "client-management-lifecycle" }).content, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const props = vue.reactive({ open: true });
  const client = { clientId: "client-a", workspaceIds: ["client-a:main"] };
  const presence = vue.reactive({ online: { onlineClients: [client] } });
  const events: unknown[][] = [];
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  const unexpected = () => { throw new Error("设备管理生命周期不得发起请求或创建计时器"); };
  new Function("require", "module", "exports", "setTimeout", "setInterval", script)((id: string) => {
    if (id === "vue") return vue;
    if (id === "../../../store/presence") return { usePresenceStore: () => presence };
    if (id === "../../../store/config") return { useConfigStore: () => ({ workspaceId: "" }) };
    if (id === "../../../store/workspaces") return { useWorkspacesStore: () => ({ byId: new Map() }) };
    if (id === "../../../composables/useApiContext") return { useApiContext: () => ({ ctx: vue.ref({}) }) };
    if (id === "ant-design-vue") return { Modal: {}, message: { error: unexpected, success: unexpected } };
    if (id === "../../../api/request") return { requestJson: unexpected, isCancelledRequestError: () => false };
    if (id === "@ant-design/icons-vue" || id.endsWith(".vue") || id.startsWith("../../../utils/") || id === "../../../analytics/analytics") return {};
    throw new Error(`unexpected client management import: ${id}`);
  }, module, module.exports, unexpected, unexpected);
  const scope = vue.effectScope();
  const actions = scope.run(() => module.exports.default.setup(props, { expose() {}, emit: (...args: unknown[]) => events.push(args) }))!;
  t.after(() => scope.stop());
  return { props, presence, client, events, actions };
}

test("关闭设备管理框只请求关闭展示，保留在线 Client 连接", t => {
  const f = harness(t);
  f.actions.handleClose();
  assert.deepEqual(f.events, [["update:open", false]]);
  assert.deepEqual(f.presence.online.onlineClients, [f.client]);
});

test("关闭设备管理框同步关闭数据清理子弹窗，重新打开不恢复旧弹窗", async t => {
  const f = harness(t);
  f.actions.openClientDataCleanup(f.client);
  assert.equal(f.actions.cleanupClientId.value, "client-a");
  assert.equal(f.actions.cleanupOpen.value, true);
  f.props.open = false;
  await vue.nextTick();
  assert.equal(f.actions.cleanupOpen.value, false);
  f.props.open = true;
  await vue.nextTick();
  assert.equal(f.actions.cleanupOpen.value, false);
  assert.deepEqual(f.presence.online.onlineClients, [f.client]);
});
