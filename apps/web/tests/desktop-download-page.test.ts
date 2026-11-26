import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { renderToString } from "vue/server-renderer";

const requireTest = createRequire(import.meta.url);
const { parse, compileScript, compileTemplate } = requireTest("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const pageFile = new URL("../src/features/desktop/components/desktop-download-page.vue", import.meta.url);
const descriptor = parse(readFileSync(pageFile, "utf8")).descriptor;
const script = compileScript(descriptor, { id: "desktop-download-page-test" });
const template = compileTemplate({ source: descriptor.template!.content, filename: pageFile.pathname,
  id: "desktop-download-page-test", compilerOptions: { bindingMetadata: script.bindings } });

function loadModule(source: string, resolve: (id: string) => unknown): any {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(resolve, module, module.exports);
  return module.exports;
}

const windows = { platform: "win32", arch: "x64", version: "2026.11.21.02", publishedAt: 1, size: 165936742,
  sha256: "a".repeat(64), downloadPath: "/api/public/desktop-download/windows-x64" };

/** 用真实 SFC 编译产物渲染页面，仅替换请求与路由依赖。 */
async function renderPage(context: test.TestContext, packages: unknown[]): Promise<string> {
  const scope = vue.effectScope();
  context.after(() => scope.stop());
  const page = loadModule(script.content, id => {
    if (id === "vue") return { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} };
    if (id === "vue-router") return { useRoute: () => ({ hash: "" }), useRouter: () => ({ push: () => {} }) };
    if (id === "../../../api/desktopDownload") return { getDesktopDownload: async () => ({ packages }) };
    if (id === "../../../api/request") return { wsOriginToHttpOrigin: () => "http://downloads.test" };
    if (id === "../../../analytics/analytics") return { trackProductEvent: () => {} };
    if (id === "../../../store/config") return { useConfigStore: () => vue.reactive({ serverWsOrigin: "ws://downloads.test" }) };
    if (id === "../../landing/components/LandingNav.vue") return { default: { render: () => vue.h("nav") } };
    throw new Error(`unexpected download page import: ${id}`);
  }).default;
  const state = scope.run(() => page.setup({}, { expose: () => {} }))!;
  await new Promise<void>(resolve => setImmediate(resolve));
  await vue.nextTick();
  const render = loadModule(template.code, id => {
    assert.equal(id, "vue");
    return vue;
  }).render;
  const app = vue.createSSRApp({ setup: () => () => render({}, [], {}, vue.proxyRefs(state), {}, {}) });
  for (const name of ["a-button", "a-spin", "a-alert"]) app.component(name, { setup: (_props: unknown, { slots }: any) => () => vue.h("span", slots.default?.()) });
  return renderToString(app);
}

for (const [version, displayVersion, expected] of [
  ["2026.11.21.02", "1.13.1121.2", "版本 1.13.1121.2"],
  ["2026.11.21.01", "1.13.1121", "版本 1.13.1121"],
  ["2026.11.21.02", undefined, "应用版本未标记（资源版本 2026.11.21.02）"],
  ["legacy-version", undefined, "应用版本未标记（资源版本 legacy-version）"],
]) {
  test(`download page renders ${expected} without changing registered version ${version}`, async context => {
    const html = await renderPage(context, [{ ...windows, version, displayVersion }]);
    assert.ok(html.includes(`${expected} ·`), html);
    assert.ok(!html.includes(`版本 ${version} ·`), html);
    assert.ok(html.includes("http://downloads.test/api/public/desktop-download/windows-x64"));
    assert.ok(html.includes("Apple Silicon"));
    assert.ok(html.includes("Intel"));
    assert.ok(html.includes("准备中"));
  });
}

test("macOS 双架构包登记后直接展示对应下载按钮", async context => {
  const html = await renderPage(context, [windows,
    { ...windows, platform: "darwin", arch: "arm64", version: "2026.11.26.01", publishedAt: 2, size: 2048,
      sha256: "b".repeat(64), downloadPath: "/api/public/desktop-download/darwin-arm64" },
    { ...windows, platform: "darwin", arch: "x64", version: "2026.11.26.01", publishedAt: 2, size: 3072,
      sha256: "c".repeat(64), downloadPath: "/api/public/desktop-download/darwin-x64" }]);
  assert.ok(html.includes("http://downloads.test/api/public/desktop-download/darwin-arm64"), html);
  assert.ok(html.includes("http://downloads.test/api/public/desktop-download/darwin-x64"), html);
  assert.ok(html.includes("下载 Apple Silicon 版"));
  assert.ok(html.includes("下载 Intel 版"));
  assert.ok(!html.includes("准备中"));
});
