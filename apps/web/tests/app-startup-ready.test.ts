import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import type { DesktopBridgeApi, DesktopMigrationState } from "@codeflowai/shared";
import { createBrowserUuid } from "../src/utils/browserUuid.js";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
type TestNode = { type: string; parent: TestNode | null; children: TestNode[]; props: Record<string, unknown>; text?: string };

/** 编译真实入口组件，仅替换外部模块加载边界。 */
function component(url: URL, requireModule: (id: string) => unknown, loadModule: (id: string) => Promise<unknown>): vue.Component {
  const descriptor = parse(readFileSync(url, "utf8")).descriptor;
  const script = compileScript(descriptor, { id: "startup-ready", inlineTemplate: true }).content;
  const compiled = ts.transpileModule(script, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [context => source => ts.visitNode(source, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createCallExpression(ts.factory.createIdentifier("loadModule"), undefined, node.arguments);
      }
      return ts.visitEachChild(node, visit, context);
    }) as ts.SourceFile] },
  }).outputText;
  const module = { exports: {} as { default: vue.Component } };
  new Function("require", "module", "exports", "loadModule", compiled)(requireModule, module, module.exports, loadModule);
  return module.exports.default;
}

/** 用真实 Vue 渲染器验证挂载顺序，只替换浏览器节点与异步模块传输。 */
function fixture(t: test.TestContext, migration = false, migrationBridge?: Partial<DesktopBridgeApi>, shell?: ReturnType<typeof startupShell>, deferredModules: string[] = []) {
  const dataset: Record<string, string> = { codeflowReady: "1" };
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset } } });
  const logs: unknown[][] = [], errors: unknown[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const modules = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
  for (const file of ["./standard-app.vue", "./features/desktop/components/desktop-migration-startup.vue",
    "./layouts/desktop/desktop-layout.vue", "./layouts/tablet/tablet-layout.vue", "./layouts/mobile/mobile-layout.vue", ...deferredModules]) {
    let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    modules.set(file, { promise, resolve, reject });
  }
  const appComponent = component(new URL("../src/App.vue", import.meta.url), (id: string) => {
    if (id === "vue") return vue;
    if (id === "./services/desktop") return { getDesktopBridge: () => migration ? { getMigrationState() {} } : null };
    if (id === "./utils/browserUuid") return { createBrowserUuid };
    if (id === "./api/request") return { isCancelledRequestError };
    throw new Error(`unexpected App import: ${id}`);
  }, (id: string) => id === "ant-design-vue" ? Promise.resolve({ default: { install() {} } }) : modules.get(id)!.promise);
  const passthrough = vue.defineComponent({ setup: (_props, { slots }) => () => vue.h("div", slots.default?.()) });
  const layoutRequests: string[] = [];
  const businessReadyEvents: unknown[][] = [];
  if (shell) {
    const standardComponent = component(new URL("../src/standard-app.vue", import.meta.url), id => {
      if (id === "vue") return vue;
      if (id === "vue-router") return { useRoute: () => ({ name: "chat", query: {} }) };
      if (id.endsWith("useAppShell")) return { useAppShell: () => shell };
      if (id.endsWith("useAutoUpdateCli")) return { useAutoUpdateCli() {} };
      if (id.endsWith("useBuiltInRelayAutoEnable")) return { useBuiltInRelayAutoEnable() {} };
      if (id.endsWith("useDefaultThreadAutoCreate")) return { useDefaultThreadAutoCreate() {} };
      if (id.endsWith("useLocalModelSetupGuide")) return { useLocalModelSetupGuide: () => ({ guideOpen: vue.ref(false) }) };
      if (id.endsWith("accountH5DeepLink")) return { resolveAccountH5DeepLink: () => ({}) };
      if (id.endsWith("store/ui")) return {};
      if (id === "./api/request") return { isCancelledRequestError };
      if (id === "./services/desktop") return { getDesktopUpdateCapabilities: () => ({ details: false }) };
      throw new Error(`unexpected StandardApp import: ${id}`);
    }, async id => {
      if (id.includes("/layouts/")) { layoutRequests.push(id); return modules.get(id)!.promise; }
      if (deferredModules.includes(id)) return modules.get(id)!.promise;
      return { __esModule: true, default: passthrough };
    });
    const options = standardComponent as vue.ComponentOptions, setup = options.setup!;
    /** 观测真实 setup 对 App 发布的事件，保留组件本身的渲染和错误传播。 */
    options.setup = (props, context) => setup(props, { ...context, emit: (event: string, ...args: unknown[]) => {
      if (event === "desktopBusinessReady") businessReadyEvents.push(args);
      context.emit(event, ...args);
    } });
    modules.get("./standard-app.vue")!.resolve({ default: standardComponent });
  }
  if (migrationBridge) {
    const config = { serverWsOrigin: "", sessionToken: null, userSummary: null, logoutInProgress: false };
    const migrationComponent = component(new URL("../src/features/desktop/components/desktop-migration-startup.vue", import.meta.url), id => {
      if (id === "vue") return vue;
      if (id.endsWith("services/desktop")) return { getDesktopBridge: () => migrationBridge };
      if (id.endsWith("store/config")) return { useConfigStore: () => config };
      if (id.endsWith("desktopAuthPromptState")) return { desktopAuthModalOpen: vue.ref(false) };
      if (id === "ant-design-vue") return Object.fromEntries(["Alert", "Button", "ConfigProvider", "Progress", "Space"].map(name => [name, passthrough]));
      throw new Error(`unexpected migration import: ${id}`);
    }, async id => { throw new Error(`unexpected dynamic migration import: ${id}`); });
    modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: migrationComponent });
  }
  /** 节点移动保持真实父子关系，使 Suspense 的隐藏容器与可见树可以区分。 */
  const renderer = vue.createRenderer<TestNode, TestNode>({
    createElement: type => ({ type, parent: null, children: [], props: {} }),
    createText: text => ({ type: "text", text, parent: null, children: [], props: {} }),
    createComment: text => ({ type: "comment", text, parent: null, children: [], props: {} }),
    setText: (node, text) => { node.text = text; },
    setElementText: (node, text) => { node.text = text; node.children = []; },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    patchProp: (node, key, _previous, next) => { node.props[key] = next; },
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node); node.parent = parent;
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1); node.parent = null; },
  });
  const root: TestNode = { type: "root", parent: null, children: [], props: {} };
  const app = renderer.createApp(appComponent);
  for (const name of ["a-config-provider", "a-alert", "a-button", "a-drawer", "a-spin"]) app.component(name, passthrough);
  app.config.errorHandler = error => { errors.push(error); };
  app.mount(root);
  t.after(() => {
    app.unmount();
    if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document");
  });
  return { app, root, dataset, modules, layoutRequests, businessReadyEvents, logs, errors };
}

/** 仅隔离应用壳初始化副作用，启动状态与真实模板保持响应式联动。 */
function startupShell(desktop = true) {
  return vue.reactive({ config: { isDesktop: desktop, localRuntimeReady: false, desktopError: null as string | null,
    hasActiveSession: false }, desktopStartupComplete: !desktop, ui: { mainView: "chat" }, mode: "desktop",
    antdTheme: {}, workspaceSwitching: false, settingsOpen: false, desktopAuthModalOpen: false, feedbackOpen: false });
}

/** 只排空有限异步模块与渲染续体，不等待业务任务。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index++) { await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick(); }
}

/** 可见树排除 Suspense 的隐藏容器。 */
function nodes(root: TestNode): TestNode[] { return [root, ...root.children.flatMap(nodes)]; }

for (const standard of [false, true]) test(`${standard ? "实际StandardApp" : "根App"}的业务作用域取消保留界面与后续布局就绪`, async t => {
  let invoke!: () => void;
  const control = vue.defineComponent({ emits: ["submit"], setup(_props, { emit }) {
    invoke = () => emit("submit");
    return () => vue.h("button", "join-enterprise");
  } });
  const layout = vue.defineComponent({ setup: () => () => vue.h(control, {
    onSubmit: async () => { throw createCancelledRequestError("scope-change"); },
  }) });
  const shell = standard ? startupShell() : undefined;
  if (shell) shell.desktopStartupComplete = true;
  const f = fixture(t, false, undefined, shell);
  if (standard) f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: layout });
  else f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({ emits: ["workbenchReady"],
    setup(_props, { emit }) { vue.onMounted(() => emit("workbenchReady", true)); return () => vue.h(layout); },
  }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
  invoke();
  await settle();
  assert.ok(nodes(f.root).some(node => node.text === "join-enterprise"));
  assert.equal(nodes(f.root).some(node => node.text === "启动暂未完成"), false);
  assert.equal(f.dataset.codeflowReady, "1");
  assert.deepEqual(f.errors, []);
  assert.equal(f.logs.some(record => JSON.stringify(record).includes("WEB_APP_SHELL_FAILED")), false);
  if (shell) {
    shell.mode = "tablet";
    await settle();
    assert.ok(f.layoutRequests.includes("./layouts/tablet/tablet-layout.vue"));
    f.modules.get("./layouts/tablet/tablet-layout.vue")!.resolve({ __esModule: true, default: layout });
    await settle();
    assert.equal(f.dataset.codeflowReady, "1");
  }
});

test("fallback加载期间清除旧ready，实际工作台挂载后才就绪", async t => {
  const f = fixture(t);
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.ok(nodes(f.root).some(node => node.props["aria-busy"] === "true"));
  let mounted = false;
  f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({
    emits: ["workbenchReady"], setup(_props, { emit }) { vue.onMounted(() => { mounted = true; emit("workbenchReady", true); }); return () => vue.h("section", "workbench"); },
  }) });
  await settle();
  assert.equal(mounted, true);
  assert.equal(f.dataset.codeflowReady, "1");
  assert.equal(nodes(f.root).some(node => node.props["aria-busy"] === "true"), false);
  f.app.unmount();
  assert.equal(f.dataset.codeflowReady, undefined);
});

for (const { desktop, held, label } of [
  { desktop: true, held: true, label: "无需等待held运行时" },
  { desktop: true, held: false, label: "桌面入口正常就绪" },
  { desktop: false, held: false, label: "浏览器入口正常就绪" },
]) test(`真实工作台布局延迟时不发布ready，加载成功后${label}`, async t => {
  const shell = startupShell(desktop);
  const f = fixture(t, held, undefined, shell);
  if (held) f.modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: vue.defineComponent({
    emits: ["ready"], setup(_props, { emit }) { vue.onMounted(() => emit("ready")); return () => vue.h("section", "startup"); },
  }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined, "启动屏挂载不能作为工作台资源就绪");
  assert.ok(f.layoutRequests.includes("./layouts/desktop/desktop-layout.vue"), "围栏期间必须主动确认布局，避免等待运行时放行而死锁");
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
  assert.equal(shell.desktopStartupComplete, !desktop, "资源确认不能依赖运行时先完成业务初始化");
  assert.equal(nodes(f.root).some(node => node.text === "workbench"), !desktop, "资源加载不得提前挂载桌面业务布局");
  shell.desktopStartupComplete = true;
  await settle();
  assert.ok(nodes(f.root).some(node => node.text === "workbench"));
  assert.deepEqual(f.errors, []);
});

for (const held of [true, false]) test(`${held ? "held" : "普通"}入口真实工作台布局拒绝加载时保留错误且不发布ready`, async t => {
  const f = fixture(t, held, undefined, startupShell());
  if (held) f.modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: vue.defineComponent({
    emits: ["ready"], setup(_props, { emit }) { vue.onMounted(() => emit("ready")); return () => vue.h("section", "startup"); },
  }) });
  await settle();
  const cause = new Error("DESKTOP_LAYOUT_LOAD_FAILED");
  const rejected = assert.rejects(f.modules.get("./layouts/desktop/desktop-layout.vue")!.promise, { message: cause.message });
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.reject(cause);
  await rejected;
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.ok(f.errors.includes(cause));
  assert.ok(f.logs.some(record => {
    const context = record[1] as { errorCode?: string; requestId?: string; rootCause?: string };
    return context?.errorCode === "WEB_APP_SHELL_FAILED" && typeof context.requestId === "string" && context.rootCause === cause.message;
  }));
});

test("窗口模式连续变化时旧布局完成不能放行当前尚未确认的布局", async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  const layout = { __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) };
  await settle();
  shell.mode = "tablet";
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve(layout);
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined, "desktop完成不能确认当前tablet布局");
  assert.ok(f.layoutRequests.includes("./layouts/tablet/tablet-layout.vue"));
  shell.mode = "mobile";
  f.modules.get("./layouts/tablet/tablet-layout.vue")!.resolve(layout);
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined, "tablet完成不能确认当前mobile布局");
  assert.ok(f.layoutRequests.includes("./layouts/mobile/mobile-layout.vue"));
  f.modules.get("./layouts/mobile/mobile-layout.vue")!.resolve(layout);
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
  assert.deepEqual(f.errors, []);
});

test("窗口模式往返后只以当前已确认布局发布ready", async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  await settle();
  shell.mode = "tablet";
  await settle();
  shell.mode = "desktop";
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1", "当前desktop已确认时不能被已离开的tablet阻塞");
  assert.deepEqual(f.errors, []);
});

test("已确认资源后切换窗口模式立即撤销ready，直到当前布局加载完成", async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  const layout = { __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) };
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve(layout);
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
  shell.mode = "tablet";
  assert.equal(f.dataset.codeflowReady, undefined, "resize必须同步撤销旧模式的资源事实");
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  f.modules.get("./layouts/tablet/tablet-layout.vue")!.resolve(layout);
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
});

for (const retired of ["mode", "unmount"] as const) test(`${retired}之后旧布局加载拒绝仍须保留真实错误`, async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  await settle();
  if (retired === "mode") { shell.mode = "tablet"; await settle(); }
  else f.app.unmount();
  const cause = new Error("RETIRED_LAYOUT_LOAD_FAILED");
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.reject(cause);
  await settle();
  assert.ok(f.errors.includes(cause), "generation变化或卸载不能吞掉实际import拒绝");
  assert.equal(f.dataset.codeflowReady, undefined);
  if (retired === "mode") {
    f.modules.get("./layouts/tablet/tablet-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
    await settle();
    assert.equal(f.dataset.codeflowReady, undefined, "实际资源失败后不能由迟到成功继续放行");
  }
});

test("宿主资源确认独立于业务首帧，异步业务未挂载时不能因超时关闭启动页", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const shell = startupShell(), topbar = "./components/app-shell/app-topbar.vue";
  const f = fixture(t, true, undefined, shell, [topbar]);
  f.modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: vue.defineComponent({
    emits: ["ready"], setup(_props, { emit }) { vue.onMounted(() => emit("ready")); return () => vue.h("section", "startup"); },
  }) });
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1", "宿主必须能放行held Runtime，不能等待业务初始化");
  assert.ok(nodes(f.root).some(node => String(node.props.class).includes("app-startup-hold--active")));
  shell.desktopStartupComplete = true;
  await settle();
  t.mock.timers.tick(1600);
  await settle();
  assert.ok(nodes(f.root).some(node => String(node.props.class).includes("app-startup-hold--active")), "未挂载业务组件时超时不能当作首帧成功");
  f.modules.get(topbar)!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("header", "topbar") }) });
  await settle();
  assert.equal(nodes(f.root).some(node => String(node.props.class).includes("app-startup-hold--active")), false, "实际首帧完成即可关闭启动页");
  assert.deepEqual(f.errors, []);
});

test("业务首帧异步组件失败显示可重试错误，运行时恢复不能清除资源失败", async t => {
  const shell = startupShell(), topbar = "./components/app-shell/app-topbar.vue";
  const f = fixture(t, true, undefined, shell, [topbar]);
  f.modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: vue.defineComponent({
    emits: ["ready"], setup(_props, { emit }) { vue.onMounted(() => emit("ready")); return () => vue.h("section", "startup"); },
  }) });
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  shell.desktopStartupComplete = true;
  await settle();
  const cause = new Error("TOPBAR_LOAD_FAILED");
  f.modules.get(topbar)!.reject(cause);
  await settle();
  assert.ok(f.errors.includes(cause));
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.deepEqual(f.businessReadyEvents, []);
  assert.ok(nodes(f.root).some(node => node.text === cause.message || node.props.message === cause.message), "资源失败不能被启动遮罩隐藏");
  assert.ok(nodes(f.root).some(node => node.text === "重试"));
  shell.config.desktopError = null;
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.ok(nodes(f.root).some(node => node.text === cause.message || node.props.message === cause.message), "Runtime恢复不能洗掉资源失败");
});

test("入口卸载后布局加载续体不能重发ready或启动其他模式加载", async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  await settle();
  f.app.unmount();
  shell.mode = "tablet";
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.deepEqual(f.layoutRequests, ["./layouts/desktop/desktop-layout.vue"]);
});

test("布局资源已确认但运行时初始化失败时不能发布ready", async t => {
  const shell = startupShell(), f = fixture(t, false, undefined, shell);
  await settle();
  shell.config.desktopError = "RUNTIME_INITIALIZATION_FAILED";
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.ok(nodes(f.root).some(node => node.props.message === "RUNTIME_INITIALIZATION_FAILED"));
});

test("HTTP浏览器缺少crypto.randomUUID仍能挂载入口并正常就绪", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "crypto", original); else Reflect.deleteProperty(globalThis, "crypto"); });
  const f = fixture(t);
  f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({
    emits: ["workbenchReady"], setup(_props, { emit }) { vue.onMounted(() => emit("workbenchReady", true)); return () => vue.h("section", "workbench"); },
  }) });
  await settle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.dataset.codeflowReady, "1");
});

for (const migration of [false, true]) test(`${migration ? "迁移" : "普通"}入口运行时错误恢复后重新确认布局并发布ready`, async t => {
  const shell = startupShell();
  const f = fixture(t, migration, migration ? {
    getMigrationState: async () => ({ status: "ready", migrationId: null, candidateId: null, workspaceCount: 0, stage: "not_needed",
      completed: 0, total: null, errorCode: null, message: null, account: { status: "not_requested", errorCode: null, message: null } }),
    onMigrationState: () => () => {}, takeMigrationAccount: async () => null,
  } : undefined, shell);
  await settle();
  shell.config.desktopError = "TRANSIENT_RUNTIME_INFO_FAILURE";
  f.modules.get("./layouts/desktop/desktop-layout.vue")!.resolve({ __esModule: true,
    default: vue.defineComponent({ setup: () => () => vue.h("section", "workbench") }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  shell.config.desktopError = null;
  shell.config.localRuntimeReady = true;
  shell.desktopStartupComplete = true;
  await settle();
  assert.ok(nodes(f.root).some(node => node.text === "workbench"));
  assert.equal(f.dataset.codeflowReady, "1", "真实布局与运行时恢复后必须结束宿主等待");
  assert.deepEqual(f.errors, []);
});

test("迁移入口可先就绪，切换工作台时清除旧ready直到新模块挂载", async t => {
  const f = fixture(t, true);
  let enterWorkbench!: () => void, requireMigration!: () => void;
  f.modules.get("./features/desktop/components/desktop-migration-startup.vue")!.resolve({ default: vue.defineComponent({
    emits: ["ready", "interactive"], setup(_props, { emit }) {
      enterWorkbench = () => emit("ready"); requireMigration = () => emit("interactive", true); return () => vue.h("section", "migration");
    },
  }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined, "挂载仍未确认迁移状态");
  requireMigration(); await settle();
  assert.equal(f.dataset.codeflowReady, "1");
  enterWorkbench();
  assert.equal(f.dataset.codeflowReady, undefined);
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({ emits: ["workbenchReady"], setup(_props, { emit }) { vue.onMounted(() => emit("workbenchReady", true)); return () => vue.h("section", "workbench"); } }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
});

for (const initial of ["available", "failed", "runtime_starting", "ready"] as const) test(`真实迁移入口${initial}必须先确认状态，自动进入时等待账号交付及工作台挂载`, async t => {
  let confirm!: (value: DesktopMigrationState) => void, deliver!: (value: null) => void, takes = 0;
  const state = new Promise<DesktopMigrationState>(resolve => { confirm = resolve; });
  const account = new Promise<null>(resolve => { deliver = resolve; });
  let listener!: (value: DesktopMigrationState) => void;
  const f = fixture(t, true, { getMigrationState: () => state, onMigrationState: fn => { listener = fn; return () => {}; },
    takeMigrationAccount: () => { takes++; return account; } });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  const ready: DesktopMigrationState = { status: "ready", migrationId: null, candidateId: null, workspaceCount: 0, stage: "not_needed",
    completed: 0, total: null, errorCode: null, message: null, account: { status: "not_requested", errorCode: null, message: null } };
  confirm(initial === "ready" ? ready : { ...ready, status: initial === "runtime_starting" ? "running" : initial, stage: initial });
  await settle();
  assert.equal(f.dataset.codeflowReady, initial === "available" || initial === "failed" ? "1" : undefined);
  if (initial !== "ready") { listener(ready); await settle(); }
  assert.equal(f.dataset.codeflowReady, undefined, "进入工作台时撤销迁移页ready");
  listener(ready); await settle();
  assert.equal(takes, 1, "并发状态通知不得重复消费账号");
  deliver(null); await settle();
  assert.equal(f.dataset.codeflowReady, undefined, "账号交付完成仍需等待工作台");
  f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({ emits: ["workbenchReady"], setup(_props, { emit }) { vue.onMounted(() => emit("workbenchReady", true)); return () => vue.h("section", "workbench"); } }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, "1");
});

for (const failure of ["module", "mounted"] as const) test(`${failure}失败保留显式错误且不能发布ready`, async t => {
  const f = fixture(t), cause = new Error(`APP_${failure.toUpperCase()}_FAILED`);
  if (failure === "module") f.modules.get("./standard-app.vue")!.reject(cause);
  else f.modules.get("./standard-app.vue")!.resolve({ default: vue.defineComponent({
    setup() { vue.onMounted(() => { throw cause; }); return () => vue.h("section", "broken"); },
  }) });
  await settle();
  assert.equal(f.dataset.codeflowReady, undefined);
  assert.ok(f.errors.includes(cause));
  assert.ok(f.logs.some(record => JSON.stringify(record).includes("WEB_APP_SHELL_FAILED")));
  assert.ok(nodes(f.root).some(node => node.text === cause.message));
  assert.ok(nodes(f.root).some(node => node.text === "重试"));
});
