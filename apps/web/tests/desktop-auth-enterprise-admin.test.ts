import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { parse } from "vue/compiler-sfc";

const source = readFileSync(new URL("../src/features/account/components/desktop-auth-modal.vue", import.meta.url), "utf8");

/** 执行真实弹窗方法，只替换账号接口、提示及窗口事件边界。 */
function createHarness() {
  const requests: Record<string, unknown>[] = [];
  const logs: unknown[][] = [];
  const context = {
    props: { open: true }, mode: { value: "register" }, errorText: { value: "" }, submitting: { value: false },
    enterpriseAdminChecked: { value: true }, enterpriseName: { value: "Acme" },
    enterpriseNameError: { value: "" },
    register: { email: "user@example.test", code: "123456", phone: "13800000000", fullName: "User",
      password: "secret1", confirmPassword: "secret1", inviteCode: "", agreement: true },
    login: { email: "", password: "" }, forgot: { code: "", password: "", confirmPassword: "" },
    registerCaptcha: { value: "" }, forgotCaptcha: { value: "" }, loginCaptcha: { value: "" },
    suppressLoginPrompt: { value: false }, setDesktopLoginPromptDismissed() {}, emit() {},
    message: { success() {} }, console: { error(...args: unknown[]) { logs.push(args); } },
    account: {
      async register(input: Record<string, unknown>): Promise<Record<string, unknown>> {
        requests.push(input);
        return { ok: true, email: "user@example.test" };
      },
    },
  };
  const { descriptor } = parse(source);
  const ast = ts.createSourceFile("desktop-auth.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const methods = ast.statements.filter(ts.isFunctionDeclaration);
  const script = ts.transpile(methods.map(node => node.getText(ast)).join("\n"), { target: ts.ScriptTarget.ES2022 });
  const handlers = new Function(...Object.keys(context), `${script}\nreturn { ${methods.map(node => node.name!.text).join(", ")} };`)(...Object.values(context));
  return { context, handlers, requests, logs };
}

test("桌面企业注册提交身份和企业名称，普通注册不携带企业字段", async () => {
  const { context, handlers, requests } = createHarness();
  await handlers.submitRegister();
  assert.deepEqual(requests[0], {
    email: "user@example.test", verificationCode: "123456", phone: "13800000000", fullName: "User",
    password: "secret1", confirmPassword: "secret1", agreementAccepted: true,
    registerAsEnterpriseAdmin: true, enterpriseName: "Acme",
  });
  assert.equal(context.enterpriseAdminChecked.value, false);
  assert.equal(context.enterpriseName.value, "");
  await handlers.submitRegister();
  assert.equal("registerAsEnterpriseAdmin" in requests[1]!, false);
  assert.equal("enterpriseName" in requests[1]!, false);
});

test("企业名称空白或超长时阻止桌面注册并显示内联错误", async () => {
  const { context, handlers, requests } = createHarness();
  context.enterpriseName.value = " ";
  await handlers.submitRegister();
  assert.match(context.enterpriseNameError.value, /企业名称/u);
  context.enterpriseName.value = "A".repeat(101);
  await handlers.submitRegister();
  assert.match(context.enterpriseNameError.value, /100/u);
  assert.deepEqual(requests, []);
});

test("桌面注册重名时保留内联企业名称并显示字段错误", async () => {
  const { context, handlers, requests, logs } = createHarness();
  context.account.register = async input => {
    requests.push(input);
    return { ok: false, code: "ENTERPRISE_NAME_ALREADY_EXISTS", message: "企业名称已存在" };
  };
  await handlers.submitRegister();
  assert.equal(context.mode.value, "register");
  assert.equal(context.enterpriseName.value, "Acme");
  assert.match(context.enterpriseNameError.value, /已存在/u);
  assert.equal(logs.length, 1);
  const failure = logs[0]![1] as Record<string, unknown>;
  assert.match(String(failure.requestId), /^desktop-account-registration-/u);
  assert.equal(failure.errorCode, "ENTERPRISE_NAME_ALREADY_EXISTS");
  assert.equal(failure.enterpriseName, "Acme");
  assert.equal("password" in failure, false);
  context.enterpriseName.value = "Another";
  await handlers.submitRegister();
  assert.equal(requests[1]!.enterpriseName, "Another");
});

test("勾选只切换企业身份，取消或关闭主弹窗时清除企业名称", () => {
  const { context, handlers } = createHarness();
  context.enterpriseAdminChecked.value = false;
  handlers.handleEnterpriseAdminToggle({ target: { checked: true } });
  assert.equal(context.enterpriseAdminChecked.value, true);
  context.enterpriseNameError.value = "exists";
  handlers.handleEnterpriseAdminToggle({ target: { checked: false } });
  assert.equal(context.enterpriseAdminChecked.value, false);
  assert.equal(context.enterpriseName.value, "");
  assert.equal(context.enterpriseNameError.value, "");
  context.enterpriseName.value = "Acme";
  context.enterpriseAdminChecked.value = true;
  handlers.close();
  assert.equal(context.enterpriseName.value, "");
  assert.equal(context.enterpriseAdminChecked.value, false);
});
