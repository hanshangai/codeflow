import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { renderToString } from "vue/server-renderer";
import * as shared from "@codeflowai/shared";

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

for (const [version, displayVersion] of [["2026.11.11.03", "1.0.1111.3"], ["2026.11.11.01", "1.0.1111"], ["legacy-version", "legacy-version"]]) {
  test(`download page renders ${displayVersion} without changing registered version ${version}`, async context => {
    const metadata = { version, platform: "win32", arch: "x64", publishedAt: 1, size: 165936742,
      sha256: "a".repeat(64), downloadPath: "/api/public/desktop-download/windows-x64" };
    const scope = vue.effectScope();
    context.after(() => scope.stop());
    const page = loadModule(script.content, id => {
      if (id === "vue") return { ...vue, onMounted: () => {}, onBeforeUnmount: () => {} };
      if (id === "vue-router") return { useRoute: () => ({ hash: "" }), useRouter: () => ({ push: () => {} }) };
      if (id === "@codeflowai/shared") return shared;
      if (id === "../../../../../desktop/package.json") return requireTest("../../desktop/package.json");
      if (id === "../../../api/desktopDownload") return { getDesktopDownload: async () => metadata };
      if (id === "../../../api/request") return { wsOriginToHttpOrigin: () => "http://downloads.test" };
      if (id === "../../../analytics/analytics") return { trackProductEvent: () => {} };
      if (id === "../../../store/config") return { useConfigStore: () => vue.reactive({ serverWsOrigin: "ws://downloads.test" }) };
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
    const html = await renderToString(app);
    assert.ok(html.includes(`版本 ${displayVersion} ·`), html);
    if (version !== displayVersion) assert.ok(!html.includes(`版本 ${version} ·`), html);
    assert.equal(metadata.version, version);
    assert.ok(html.includes("http://downloads.test/api/public/desktop-download/windows-x64"));
  });
}
