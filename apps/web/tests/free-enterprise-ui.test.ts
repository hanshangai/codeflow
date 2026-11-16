import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { compileTemplate, parse } from "vue/compiler-sfc";

test("移除授权菜单后移动端及后台布局仍可编译", () => {
  for (const relative of ["layouts/mobile/mobile-layout.vue", "features/admin/components/admin-layout.vue"]) {
    const { descriptor, errors } = parse(source(relative));
    assert.deepEqual(errors, [], relative);
    assert.ok(descriptor.template);
    const compiled = compileTemplate({ id: relative, filename: relative, source: descriptor.template.content,
      compilerOptions: { expressionPlugins: ["typescript"] } });
    assert.deepEqual(compiled.errors.map(error => typeof error === "string" ? error : error.message), [], relative);
  }
});

test("关闭建企表单会清空状态，摘要迟到后不再跳转", async () => {
  const component = source("features/account/components/account-drawer.vue");
  const ast = ts.createSourceFile("drawer.ts", component.slice(component.indexOf(">") + 1, component.indexOf("</script>")), ts.ScriptTarget.Latest, true);
  const handlers = ast.statements.filter(ts.isFunctionDeclaration).filter(node => ["submitCreateEnterprise", "resetEnterpriseCreation"].includes(node.name?.text ?? ""));
  assert.equal(handlers.length, 2);
  let resolveSummary!: (summary: unknown) => void, summaryRequested!: () => void;
  const pending = new Promise(resolve => { resolveSummary = resolve; });
  const requested = new Promise<void>(resolve => { summaryRequested = resolve; });
  const busy = { value: false }, name = { value: "Team A" }, error = { value: "" }, open = { value: true };
  const effects: unknown[] = [];
  const context = { creatingEnterprise: busy, newEnterpriseName: name, createEnterpriseError: error, createEnterpriseOpen: open,
    captureAccountSession: () => ({ userId: "user-a", requestContext: {}, isCurrentResponse: () => true, assertResponseCurrent() {} }), config: {},
    createMyEnterprise: async () => ({ ok: true, enterpriseId: "team-a" }), isCancelledRequestError: () => false,
    account: { loadMeSummary() { summaryRequested(); return pending; } }, emit: (...args: unknown[]) => effects.push(args),
    router: { async push(input: unknown) { effects.push(input); } }, message: { success: (text: string) => effects.push(text) } };
  const { submit, reset } = new Function(...Object.keys(context), "let enterpriseCreationRevision=0;\n"
    + handlers.map(handler => ts.transpile(handler.getText(ast), { target: ts.ScriptTarget.ES2022 })).join("\n")
    + "\nreturn {submit: submitCreateEnterprise, reset: resetEnterpriseCreation};")(...Object.values(context));
  const request = submit();
  await requested;
  error.value = "old-error";
  reset();
  assert.equal(name.value, "");
  assert.equal(error.value, "");
  assert.equal(busy.value, false);
  assert.equal(open.value, false);
  resolveSummary({ enterpriseSummary: { enterpriseId: "team-a" } });
  await request;
  assert.deepEqual(effects, []);
});

test("建企请求失败后若已切账号，不写入新账号表单或日志", async () => {
  const component = source("features/account/components/account-drawer.vue");
  const ast = ts.createSourceFile("drawer.ts", component.slice(component.indexOf(">") + 1, component.indexOf("</script>")), ts.ScriptTarget.Latest, true);
  const handler = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === "submitCreateEnterprise");
  assert.ok(handler);
  let current = true, reject!: (error: Error) => void;
  const pending = new Promise((_, fail) => { reject = fail; });
  const error = { value: "" }, busy = { value: false }, logs: unknown[] = [];
  const context = { creatingEnterprise: busy, newEnterpriseName: { value: "Team A" }, createEnterpriseError: error,
    captureAccountSession: () => ({ userId: "user-a", requestContext: {}, isCurrentResponse: () => current }), config: {},
    createMyEnterprise: () => pending, isCancelledRequestError: () => false,
    props: { summary: { userId: "user-b" } }, console: { error: (...args: unknown[]) => logs.push(args) } };
  const submit = new Function(...Object.keys(context), "let enterpriseCreationRevision=0;\n" + ts.transpile(handler.getText(ast), { target: ts.ScriptTarget.ES2022 }) + "\nreturn submitCreateEnterprise;")(...Object.values(context));
  const request = submit();
  current = false;
  reject(new Error("NETWORK_FAILED"));
  await request;
  assert.equal(error.value, "");
  assert.deepEqual(logs, []);
});

/** 从仓库源码读取退役入口，避免路由或懒加载重新暴露企业收费。 */
function source(relative: string): string {
  return readFileSync(new URL(`../src/${relative}`, import.meta.url), "utf8");
}

test("各端共享入口不再包含企业购买路由、弹窗或授权面板", () => {
  assert.doesNotMatch(source("router/index.ts"), /enterprise-checkout|payment\/enterprise/);
  assert.doesNotMatch(source("services/appModals.ts"), /EnterprisePurchase/);
  assert.doesNotMatch(source("features/admin/systemPanelAccess.ts"), /private-license|billing-plan-configs/);
  assert.equal(existsSync(new URL("../src/features/enterprise-checkout/components/enterprise-checkout-page.vue", import.meta.url)), false);
});

test("账号入口接入免费建企 API，只收企业名称并刷新账号", () => {
  assert.match(source("api/account/index.ts"), /\/api\/account\/me\/enterprise/);
  assert.match(source("features/account/components/account-drawer.vue"), /创建企业/);
  assert.match(source("features/account/components/account-drawer.vue"), /createMyEnterprise/);
});

test("兑换表单仅提交 code，管理页只生成个人 Token", () => {
  const modal = source("features/account/components/redemption-code-modal.vue");
  assert.match(modal, /redeemCode\(ctx.value, \{ code: text \}\)/);
  assert.doesNotMatch(modal, /v-model:value="enterpriseName"/);

});
