import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { compileTemplate, parse } from "vue/compiler-sfc";

const source = readFileSync(new URL("../src/features/account/components/auth-register-page.vue", import.meta.url), "utf8");

/** 提供有效个人注册表单，企业名称校验使用页面真实方法。 */
function createContext() {
  return {
    resetFieldFeedback() {},
    fieldErrors: { email: "", verificationCode: "", phone: "", fullName: "", password: "", confirmPassword: "", inviteCode: "" },
    form: { email: "user@example.test", verificationCode: "123456", phone: "13800000000", fullName: "User",
      password: "secret1", confirmPassword: "secret1", inviteCode: "" },
    validateEmailInput: () => "", validateVerificationCodeInput: () => "", validatePhoneField: () => "",
    validateDisplayNameInput: () => "", validatePasswordInput: () => "", validateConfirmPasswordInput: () => "",
    validateInviteCodeInput: () => "", setError() {}, normalizeEmailInput: (value: string) => value,
    normalizePhoneInput: (value: string) => value, normalizeInviteCodeInput: (value: string) => value,
    initialInviteCode: "", agreementChecked: { value: true },
    enterpriseAdminChecked: { value: true }, enterpriseName: { value: "  Acme  " }, enterpriseNameError: { value: "" },
    COPY: { enterpriseNameRequired: "required", enterpriseNameTooLong: "too-long" },
  };
}

test("注册表单按企业管理员选择提交内联输入的企业名称", () => {
  const context = createContext();
  const validate = loadHandler("validateRegisterForm", context);
  assert.deepEqual(validate(), {
    email: "user@example.test", verificationCode: "123456", phone: "13800000000", fullName: "User",
    password: "secret1", confirmPassword: "secret1", agreementAccepted: true,
    registerAsEnterpriseAdmin: true, enterpriseName: "Acme",
  });
  context.enterpriseAdminChecked.value = false;
  const personal = validate();
  assert.equal("registerAsEnterpriseAdmin" in personal, false);
  assert.equal("enterpriseName" in personal, false);
});

/** 从真实页面脚本加载指定方法，依赖由用例显式提供。 */
function loadHandler(name: string, context: Record<string, unknown>): (...args: any[]) => any {
  const { descriptor } = parse(source);
  const ast = ts.createSourceFile("register.ts", descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
  const handler = ast.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === name);
  assert.ok(handler, name);
  return new Function(...Object.keys(context), ts.transpile(handler.getText(ast), { target: ts.ScriptTarget.ES2022 }) + `\nreturn ${name};`)(...Object.values(context));
}

test("内联企业名称为空白或超长时阻止注册并显示字段错误", () => {
  const context = createContext();
  const validate = loadHandler("validateRegisterForm", context);
  context.enterpriseName.value = " ";
  assert.equal(validate(), null);
  assert.equal(context.enterpriseNameError.value, "required");
  context.enterpriseName.value = "A".repeat(101);
  assert.equal(validate(), null);
  assert.equal(context.enterpriseNameError.value, "too-long");
  context.enterpriseName.value = "Acme";
  assert.equal(validate().enterpriseName, "Acme");
  assert.equal(context.enterpriseNameError.value, "");
});

test("勾选企业管理员只切换身份，取消勾选清除内联名称和错误", () => {
  const context = createContext();
  context.enterpriseAdminChecked.value = false;
  const toggle = loadHandler("handleEnterpriseAdminToggle", context);
  toggle({ target: { checked: true } });
  assert.equal(context.enterpriseAdminChecked.value, true);
  context.enterpriseNameError.value = "exists";
  toggle({ target: { checked: false } });
  assert.equal(context.enterpriseAdminChecked.value, false);
  assert.equal(context.enterpriseName.value, "");
  assert.equal(context.enterpriseNameError.value, "");
});

test("注册重名时保留内联企业名称，显示字段错误并停止跳转", async () => {
  let navigated = false;
  const context = {
    ...createContext(), submitting: { value: false }, clearError() {}, validateAgreement: () => true,
    validateRegisterForm: () => ({ email: "user@example.test", registerAsEnterpriseAdmin: true, enterpriseName: "Taken" }),
    account: { async register() { return { ok: false, code: "ENTERPRISE_NAME_ALREADY_EXISTS", message: "exists" }; } },
    trackProductEventWithEmail() {}, router: { async push() { navigated = true; } },
  };
  context.enterpriseName.value = "Taken";
  await loadHandler("submit", context)();
  assert.equal(context.enterpriseName.value, "Taken");
  assert.equal(context.enterpriseAdminChecked.value, true);
  assert.equal(context.enterpriseNameError.value, "exists");
  assert.equal(context.submitting.value, false);
  assert.equal(navigated, false);
});

test("注册页新增模板可以编译", () => {
  const { descriptor, errors } = parse(source);
  assert.deepEqual(errors, []);
  const compiled = compileTemplate({ filename: "auth-register-page.vue", id: "register-test", source: descriptor.template!.content,
    compilerOptions: { expressionPlugins: ["typescript"] } });
  assert.deepEqual(compiled.errors, []);
});
