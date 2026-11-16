import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { formatAccessEdition } from "../src/features/account/accountDisplay.ts";
import type { AccessContext } from "@codeflowai/shared";

/** 读取实际组件，约束已移除的在线业务入口不能重新出现。 */
function source(path: string): string {
  return fs.readFileSync(`apps/web/src/${path}`, "utf8");
}

test("企业身份不再由历史套餐日期展示过期", () => {
  assert.equal(formatAccessEdition({ identityType: "ENTERPRISE_MEMBER", editionType: "ENTERPRISE", editionStatus: "ACTIVE" } as AccessContext), "企业版");
});

test("兑换入口仅提交 Token 码", () => {
  const modal = source("features/account/components/redemption-code-modal.vue");
  assert.doesNotMatch(modal, /v-model:value="enterpriseName"|enterpriseName:/u);
  assert.doesNotMatch(modal, /a-radio|UNIVERSAL/u);
});

/** 运行组件原始提交方法，外部API边界受控以观察真实请求与副作用。 */
function redemptionSubmit(result: { ok: boolean; message?: string } | Error) {
  const component = source("features/account/components/redemption-code-modal.vue");
  const script = component.slice(component.indexOf(">") + 1, component.indexOf("</script>"));
  const ast = ts.createSourceFile("redemption-modal.ts", script, ts.ScriptTarget.Latest, true);
  const handler = ast.statements.filter(ts.isFunctionDeclaration).find((node) => node.name?.text === "submit");
  assert.ok(handler);
  const requests: unknown[] = [], events: string[] = [];
  const code = { value: "  TOKEN-CODE  " }, submitting = { value: false };
  const context = {
    code, submitting, current: { value: 2 }, ctx: { value: {} }, contentText: {},
    redeemCode: async (_ctx: unknown, body: unknown) => { requests.push(body); if (result instanceof Error) throw result; return result; },
    message: { warning: () => events.push("warning"), error: () => events.push("error"), success: () => events.push("success") },
    loadRecords: async () => events.push("records"), emit: () => events.push("redeemed"),
  };
  const invoke = new Function(...Object.keys(context), ts.transpile(handler.getText(ast), { target: ts.ScriptTarget.ES2022 }) + "\nreturn submit;")(...Object.values(context)) as () => Promise<void>;
  return { invoke, code, submitting, requests, events };
}

test("Token 码兑换成功后刷新记录与账号", async () => {
  const form = redemptionSubmit({ ok: true });
  await form.invoke();
  assert.deepEqual(form.requests, [{ code: "TOKEN-CODE" }]);
  assert.deepEqual(form.events, ["success", "records", "redeemed"]);
  assert.equal(form.submitting.value, false);
});

test("兑换失败不清空输入、不刷新权益，传输异常保持失败", async () => {
  const rejected = redemptionSubmit({ ok: false, message: "流量兑换码已失效" });
  await rejected.invoke();
  assert.deepEqual(rejected.events, ["error"]);
  assert.equal(rejected.code.value, "  TOKEN-CODE  ");
  const cause = new Error("REDEMPTION_NETWORK_FAILURE");
  const network = redemptionSubmit(cause);
  await assert.rejects(network.invoke(), (error) => error === cause);
  assert.deepEqual(network.events, []);
  assert.equal(network.submitting.value, false);
});

test("企业成员与后台活跃页面移除人月写入口", () => {
  for (const path of ["features/account/components/enterprise-drawer.vue"]) {
    const template = source(path).split("<template>")[1]?.split("<style")[0] ?? "";
    assert.doesNotMatch(template, /人月|续费|套餐到期|自动续|分配套餐/u, path);
  }
});
