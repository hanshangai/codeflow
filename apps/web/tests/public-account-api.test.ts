import assert from "node:assert/strict";
import test from "node:test";
import * as publicPanels from "../src/features/admin/systemPanelAccess.ts";
import { createMyEnterprise, listEnterpriseSessions, redeemCode, listAccountOrderInfoPaymentOrders } from "../src/api/account/index.ts";
import { getMyMessageNotificationConfig } from "../src/api/message-notifications/index.ts";
import { createRelayBalancePackBusinessOrder, cancelRelayBalancePackBusinessOrder } from "../src/api/relay-token-package/index.ts";
const { resolveAllowedSystemPanels, isMigratedAdminPanel, resolveAdminConsoleUrl } = publicPanels;

test("超管普通设置沿用个人能力，只有旧管理深链提示迁移", () => {
  assert.deepEqual(resolveAllowedSystemPanels("super_admin"), resolveAllowedSystemPanels("personal_user"));
  for (const panel of ["settings", "engine-keys", "relay-price-config", "payment-orders"]) assert.equal(isMigratedAdminPanel("super_admin", panel), false);
  for (const panel of ["user-management", "payment-management", "audit", "relay-config", "sessions", "shared-workspaces"]) {
    assert.equal(isMigratedAdminPanel("super_admin", [panel]), true);
    assert.equal(isMigratedAdminPanel("enterprise_admin", panel), false);
  }
});

test("桌面本地页面从已登录Server地址构造固定HTTP控制台，不携带token", () => {
  assert.equal(typeof resolveAdminConsoleUrl, "function");
  const target = new URL(resolveAdminConsoleUrl("ws://cloud.example.test:39280/ws?token=discarded"));
  assert.equal(target.href, "http://cloud.example.test:39280/console/");
  assert.equal(target.search, ""); assert.equal(target.hash, "");
  assert.equal(resolveAdminConsoleUrl("wss://cloud.example.test/ws"), "https://cloud.example.test/console/");
});

test("公开账号、企业会话、通知及个人购买继续发送原用户协议", async (t) => {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return Response.json({ ok: true });
  });
  const ctx = { serverWsOrigin: "ws://127.0.0.1:39280", sessionToken: "user-session", webSessionId: null };
  await createMyEnterprise(ctx, { name: "My team" });
  await listEnterpriseSessions(ctx); await redeemCode(ctx, { code: "TOKEN-CODE" });
  await listAccountOrderInfoPaymentOrders(ctx); await getMyMessageNotificationConfig(ctx);
  await createRelayBalancePackBusinessOrder(ctx, { targetScope: "PERSONAL", balanceAmountFen: 1000, expectedPricingVersion: 1 } as never);
  await cancelRelayBalancePackBusinessOrder(ctx, "order-1");
  assert.deepEqual(calls.map(({ path }) => path), ["/api/account/me/enterprise", "/api/account/enterprise/sessions", "/api/account/redemption-codes/redeem", "/api/account/order-info/payment-orders", "/api/account/message-notifications/config", "/api/account/me/relay-balance-package/orders", "/api/account/me/relay-balance-package/orders/order-1/cancel"]);
  assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "POST", "GET", "GET", "POST", "POST"]);
  assert.deepEqual(calls[0]!.body, { name: "My team" });
  assert.deepEqual(calls[2]!.body, { code: "TOKEN-CODE" });
});
