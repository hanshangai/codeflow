import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const ts = createRequire(new URL("../../apps/web/package.json", import.meta.url))("typescript");
const root = new URL("../../", import.meta.url);

test("公开充值浏览器用例保留个人购买，去掉管理请求、表单与私有类型", () => {
  const source = fs.readFileSync(new URL("apps/web/e2e/relay-recharge-pricing.spec.ts", root), "utf8");
  assert.doesNotMatch(source, /\/api\/admin\/|AdminUpdateRelay|RelayRechargePricingConfigView|openAdminPricing|Token 价格管理/u);
  assert.match(source, /个人 Token 折扣充值/u);
  assert.match(source, /RelayRechargePricingPublicView/u);
  assert.match(source, /rechargePricingVersion: 2/u);
  assert.match(source, /当前配置故障不阻断已有订单/u);
  assert.match(source, /await openWithSession\(page, state, "\/admin\?panel=settings"\)/u);
  assert.deepEqual(ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } }).diagnostics, []);
});

test("公开本地浏览器配置不执行已迁出的管理面板用例", () => {
  const source = fs.readFileSync(new URL("apps/web/playwright.config.ts", root), "utf8");
  assert.doesNotMatch(source, /admin-best-practices|admin-invitations|admin-relay-operations|admin-relay-usage-replica/u);
  assert.match(source, /relay-recharge-pricing/u);
  const mobile = fs.readFileSync(new URL("apps/web/e2e/mobile-web.spec.ts", root), "utf8");
  assert.doesNotMatch(mobile, /\/api\/admin\/relay\/status/u);
});
