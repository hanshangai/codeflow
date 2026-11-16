import assert from "node:assert/strict";
import test from "node:test";
import * as labels from "../src/features/admin/paymentOrderLabels.ts";

test("公开订单帮助仅导出普通订单实际消费的八项能力", () => {
  assert.deepEqual(Object.keys(labels).sort(), ["ORDER_KIND_OPTIONS", "formatBillingCycleLabel", "formatDateTimeShort", "formatOrderKind", "formatPaymentStatus", "formatPriceFen", "formatRelayMoneyFromUsd", "paymentStatusTone"].sort());
});

test("普通订单类型、状态、历史周期与金额保持原展示语义", () => {
  assert.deepEqual(labels.ORDER_KIND_OPTIONS.map(item => item.value), ["ALL", "PACKAGE", "TOKEN"]);
  assert.equal(labels.formatOrderKind("PACKAGE"), "套餐订单");
  assert.equal(labels.formatOrderKind("TOKEN"), "Token 充值");
  assert.equal(labels.formatOrderKind(null), "-");
  assert.equal(labels.formatPaymentStatus("PAID"), "已支付");
  assert.equal(labels.formatPaymentStatus("QR_READY"), "待支付");
  assert.equal(labels.formatPaymentStatus(undefined), "-");
  assert.equal(labels.paymentStatusTone("PAID"), "success");
  assert.equal(labels.paymentStatusTone("PAYING"), "processing");
  assert.equal(labels.paymentStatusTone("FAILED"), "error");
  assert.equal(labels.formatBillingCycleLabel("NONE"), "永久使用");
  assert.equal(labels.formatBillingCycleLabel("MONTH_12"), "12人月");
  assert.equal(labels.formatBillingCycleLabel("unknown", 7), "7人月");
  assert.equal(labels.formatPriceFen(12345), "￥123.45");
  assert.equal(labels.formatPriceFen(NaN), "-");
  assert.equal(labels.formatRelayMoneyFromUsd(12.34), "￥12.34");
  assert.equal(labels.formatDateTimeShort(0), "-");
  const timestamp = 1700000000000;
  assert.equal(labels.formatDateTimeShort(timestamp), new Date(timestamp).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
});
