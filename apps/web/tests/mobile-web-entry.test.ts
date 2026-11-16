import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { resolveLegacyMobileRedirect } from "../src/features/account/legacyMobileRedirect.ts";
import { buildLoginRouteLocation, resolvePostLoginTarget } from "../src/features/account/loginRedirect.ts";

/** 执行真实启动状态和模板，只隔离异步应用壳的加载。 */
function applicationEntry(hasMigrationBridge: boolean) {
  const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const descriptor = parse(readFileSync("apps/web/src/App.vue", "utf8")).descriptor;
  const script = ts.createSourceFile("App.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const declarations = script.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations]);
  const context: Record<string, unknown> = {};
  for (const name of ["hasMigrationStartup", "desktopStartupReady", "shellFailed"]) {
    const initializer = declarations.find(declaration => declaration.name.getText(script) === name)?.initializer;
    assert.ok(initializer, `${name}必须由应用入口派生`);
    const expression = ts.transpileModule(initializer.getText(script), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    context[name] = new Function("getDesktopBridge", "ref", "hasMigrationStartup", `return ${expression}`)(
      () => hasMigrationBridge ? { getMigrationState() {} } : null, vue.ref, context.hasMigrationStartup,
    );
  }
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: "App.vue", id: "application-entry",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name }) as (context: object, cache: unknown[]) => vue.VNode;
  /** 保留默认插槽及条件渲染结果，不加载子应用的依赖。 */
  const visibleNodes = (node: vue.VNode): vue.VNode[] => {
    const slots = node.children as { default?: () => vue.VNode[] } | null;
    const children = Array.isArray(node.children) ? node.children : slots?.default?.() ?? [];
    return [node, ...children.filter(vue.isVNode).flatMap(visibleNodes)];
  };
  const state = vue.proxyRefs(context);
  return () => visibleNodes(render(state, []));
}

test("retired office links retain business targets and discard authorization secrets", () => {
  const target = resolveLegacyMobileRedirect({
    corpId: "retired", code: "single-use", state: "retired-state",
    redirect: "/h5?workspaceId=OWNER%3Aws-1&threadId=thread-1&code=old&openOfficeBindings=1",
  });
  assert.deepEqual(target, { path: "/chat", query: { workspaceId: "OWNER:ws-1", threadId: "thread-1" } });
});

test("legacy redirects reject external, protocol-relative and malformed targets", () => {
  for (const redirect of ["https://evil.test/h5", "//evil.test/h5", "/h5\\evil.test", "/h5/../../other", "/auth/login?redirect=/h5", "javascript:alert(1)"]) {
    assert.deepEqual(resolveLegacyMobileRedirect({ redirect }), { path: "/chat", query: {} });
  }
});

test("workflow targets survive a CodeFlow login on the same Web route", () => {
  const path = "/chat?workspaceId=ws-2&tab=pending&targetId=instance-2";
  assert.deepEqual(buildLoginRouteLocation(path), { path: "/auth/login/", query: { redirect: path } });
  assert.deepEqual(resolvePostLoginTarget("/admin", { redirect: path }), {
    path: "/chat", query: { workspaceId: "ws-2", tab: "pending", targetId: "instance-2" },
  });
  assert.deepEqual(resolvePostLoginTarget("/admin", { redirect: path.replace("/chat", "/h5/") }), {
    path: "/chat", query: { workspaceId: "ws-2", tab: "pending", targetId: "instance-2" },
  });
});

test("public application only mounts the standard shell and no H5 API routes", () => {
  const app = readFileSync("apps/web/src/App.vue", "utf8");
  const login = readFileSync("apps/web/src/features/account/components/auth-login-page.vue", "utf8");
  const nodes = applicationEntry(false)();
  assert.equal(nodes.filter(node => node.type === "StandardApp").length, 1);
  assert.equal(nodes.some(node => node.type === "DesktopMigrationStartup"), false);
  assert.doesNotMatch(app, /H5App/);
  assert.doesNotMatch(login, /getOfficeH5LoginOptions|startOfficeH5OAuth|bindingLoginPlatform/);
});

test("desktop migration gates the standard shell until its ready event", () => {
  const render = applicationEntry(true);
  const pending = render();
  assert.equal(pending.some(node => node.type === "StandardApp"), false);
  const migration = pending.find(node => node.type === "DesktopMigrationStartup");
  assert.ok(migration, "桌面迁移必须负责报告启动就绪");
  migration.props!.onReady();
  assert.equal(render().filter(node => node.type === "StandardApp").length, 1);
});
