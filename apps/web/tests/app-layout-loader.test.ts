import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { defineAsyncComponent } from "vue";

/** 执行真实布局声明、Vue 异步加载和启动确认，只控制浏览器 import 边界。 */
function fixture(mode: "mobile" | "tablet" | "desktop") {
  const source = readFileSync(new URL("../src/standard-app.vue", import.meta.url), "utf8");
  const script = ts.createSourceFile("standard-app.ts", source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/u)![1]!, ts.ScriptTarget.Latest, true);
  const declarations = new Set(["layoutLoaders", "layoutModules", "MobileLayout", "TabletLayout", "DesktopLayout"]);
  const statements = script.statements.filter(statement => ts.isFunctionDeclaration(statement)
    ? ["loadLayout", "confirmCurrentLayout"].includes(statement.name?.text ?? "")
    : ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declarations.has(declaration.name.getText(script))));
  const code = ts.transpileModule(statements.map(statement => statement.getText(script)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    transformers: { before: [context => ast => ts.visitNode(ast, function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        return ts.factory.createCallExpression(ts.factory.createIdentifier("loadModule"), undefined, node.arguments);
      }
      return ts.visitEachChild(node, visit, context);
    }) as ts.SourceFile] },
  }).outputText;
  let resolve!: (module: unknown) => void, reject!: (cause: Error) => void, imports = 0;
  const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
  const readiness: boolean[] = [];
  const component = { name: "LoadedLayout", render: () => null };
  const module = { __esModule: true, default: component };
  const uninitializedModule = { __esModule: true, get default(): never { throw new ReferenceError("Cannot access uninitialized variable."); } };
  const entry = new Function("defineAsyncComponent", "loadModule", "shell", "emit",
    `let startupFlowCancelled = false, layoutGeneration = 0;\n${code}\nreturn { confirmCurrentLayout, layouts: { mobile: MobileLayout, tablet: TabletLayout, desktop: DesktopLayout } };`)(
    defineAsyncComponent,
    () => ++imports === 1 ? pending : Promise.resolve(uninitializedModule),
    { mode, config: { desktopError: null } },
    (_event: string, ready: boolean) => readiness.push(ready),
  ) as { confirmCurrentLayout: () => Promise<void>; layouts: Record<typeof mode, { __asyncLoader: () => Promise<unknown> }> };
  return { ...entry, resolve: () => resolve(module), reject, component, readiness, imports: () => imports };
}

for (const mode of ["mobile", "tablet", "desktop"] as const) {
  test(`${mode} 的启动确认与页面渲染共用一次布局导入，避免 Safari 18 读取未初始化模块`, async () => {
    const f = fixture(mode);
    const confirmed = f.confirmCurrentLayout();
    const rendered = f.layouts[mode].__asyncLoader();
    f.resolve();
    const [, result] = await Promise.all([confirmed, rendered]);
    assert.equal(result, f.component);
    assert.equal(f.imports(), 1);
    assert.deepEqual(f.readiness, [false, true]);
  });
}

test("布局导入失败同时拒绝启动确认与页面渲染，不确认就绪", async () => {
  const f = fixture("mobile"), cause = new Error("LAYOUT_IMPORT_FAILED");
  const confirmed = f.confirmCurrentLayout();
  const rendered = f.layouts.mobile.__asyncLoader();
  const confirmFailure = assert.rejects(confirmed, error => error === cause);
  const renderFailure = assert.rejects(rendered, error => error === cause);
  f.reject(cause);
  await Promise.all([confirmFailure, renderFailure]);
  assert.deepEqual(f.readiness, [false]);
  assert.equal(f.imports(), 1);
});
