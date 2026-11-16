import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { isCancelledRequestError } from "../src/api/request.ts";

const require = createRequire(import.meta.url);
const { parse, compileScript } = require("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const { renderToString } = require("vue/server-renderer") as typeof import("vue/server-renderer");

/** 渲染真实模板，仅隔离初始化副作用及异步业务组件，检查启动期间是否挂载工作台。 */
async function renderStartup(options: { desktop?: boolean; complete?: boolean; ready?: boolean; error?: string } = {}): Promise<string> {
  const shell = vue.reactive({ config: { isDesktop: options.desktop ?? true, localRuntimeReady: options.ready ?? false,
    desktopError: options.error ?? null, hasActiveSession: false }, desktopStartupComplete: options.complete ?? false,
    ui: { mainView: "chat" }, mode: "desktop", antdTheme: {}, workspaceSwitching: false });
  const descriptor = parse(readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8")).descriptor;
  const source = compileScript(descriptor, { id: "startup-screen", inlineTemplate: true }).content;
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [context => ast => ts.visitNode(ast, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createCallExpression(ts.factory.createIdentifier("loadModule"), undefined, node.arguments);
      }
      return ts.visitEachChild(node, visit, context);
    }) as ts.SourceFile] } }).outputText;
  const module = { exports: {} as { default: vue.Component } };
  /** 未列出的依赖立即失败，避免测试用默认空对象隐藏真实初始化。 */
  const load = (id: string): unknown => {
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
    throw new Error(`Unexpected dependency: ${id}`);
  };
  new Function("require", "module", "exports", "loadModule", compiled)(load, module, module.exports,
    async (id: string) => ({ __esModule: true, default: vue.defineComponent({ setup: () => () => vue.h("div", { "data-component": id }) }) }));
  const app = vue.createSSRApp(module.exports.default);
  const passthrough = vue.defineComponent({ setup: (_props, { slots }) => () => vue.h("section", slots.default?.()) });
  for (const name of ["a-config-provider", "a-alert", "a-button", "a-drawer", "a-spin"]) app.component(name, passthrough);
  return renderToString(app);
}

test("桌面首次启动保留全屏加载，运行时就绪但目录未完成时仍不挂载工作台", async () => {
  for (const ready of [false, true]) {
    const html = await renderStartup({ ready });
    assert.match(html, /aria-busy="true"/u);
    assert.doesNotMatch(html, /data-component=".*(?:app-topbar|desktop-layout|app-shell-modals|desktop-auth-modal)/u);
  }
});

test("启动失败留在加载页显示原因与重试，不挂载业务界面", async () => {
  const html = await renderStartup({ error: "WORKSPACE_READ_FAILED" });
  assert.match(html, /WORKSPACE_READ_FAILED/u);
  assert.match(html, /重试/u);
  assert.doesNotMatch(html, /desktop-layout/u);
});

test("完成首次初始化才显示工作台，浏览器不等待桌面初始化", async () => {
  for (const options of [{ complete: true, ready: true }, { desktop: false }]) {
    const html = await renderStartup(options);
    assert.match(html, /data-component=".*desktop-layout/u);
    assert.doesNotMatch(html, /aria-busy="true"/u);
  }
});
