import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panelSource = fs.readFileSync("apps/web/src/features/admin/components/account-order-info-payment-orders-panel.vue", "utf8");
const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");
const uiSource = fs.readFileSync("apps/web/src/store/ui.ts", "utf8");

test("mobile bottom navigation has only conversations and files", () => {
  const start = layoutSource.indexOf('<div class="mobile-tabs">');
  const h5Tabs = layoutSource.slice(start, layoutSource.indexOf('<template v-else>', start));
  for (const label of ["会话", "文件"]) assert.match(h5Tabs, new RegExp(`>${label}<`, "u"));
  assert.doesNotMatch(h5Tabs, />订单<|>设置</u);
  assert.doesNotMatch(layoutSource, /activeTab === 'pending'/u);
  assert.match(uiSource, /currentTab === "home" \|\| currentTab === "pending"/u);
});

test("H5 orders reuse the real order and invoice application owner", () => {
  assert.match(layoutSource, /<AccountOrderInfoPaymentOrdersPanel[^>]+settingsPageTab === 'orders'[^>]+h5/u);
  assert.match(panelSource, /listAccountOrderInfoPaymentOrders/u);
  assert.match(panelSource, /createInvoiceApplication/u);
  assert.match(panelSource, /getInvoiceProfile/u);
  assert.match(panelSource, /发票状态/u);
  assert.match(panelSource, /申请发票/u);
});

test("H5 orders render cards while desktop keeps the table", () => {
  assert.match(panelSource, /v-if="!props\.h5"/u);
  assert.match(panelSource, /account-order-info-payment-orders__h5-card/u);
  assert.match(panelSource, /待开票/u);
  assert.match(panelSource, /本页实付/u);
  assert.match(panelSource, /account-order-info-payment-orders__h5-kinds/u);
  assert.match(panelSource, /h5-order-filter-drawer/u);
  assert.match(panelSource, /h5-invoice-modal/u);
  assert.match(panelSource, /h5-load-more/u);
  assert.match(panelSource, /scrollbar-width: none/u);
  assert.match(panelSource, /<div v-if="!props\.h5" class="account-order-info-payment-orders__pagination">/u);
});
