import test from "node:test";
import assert from "node:assert/strict";
import type { PaymentOrderDetailView } from "@codeflowai/shared";

import {
  collectPollingOrderIds,
  mergePolledOrderIntoList,
} from "../../apps/web/src/features/payment-verification/paymentVerificationState.ts";

function buildOrder(input: Partial<PaymentOrderDetailView> & Pick<PaymentOrderDetailView, "orderId" | "outTradeNo" | "status">): PaymentOrderDetailView {
  return {
    orderId: input.orderId,
    outTradeNo: input.outTradeNo,
    productCode: input.productCode ?? "WXPAY_VALIDATION_FIXED",
    status: input.status,
    amountFen: input.amountFen ?? 100,
    currency: input.currency ?? "CNY",
    finalSource: input.finalSource ?? null,
    qrExpiresAt: input.qrExpiresAt ?? null,
    finalizedAt: input.finalizedAt ?? null,
    createdAt: input.createdAt ?? 1,
    updatedAt: input.updatedAt ?? 1,
    title: input.title ?? "验证商品",
    description: input.description ?? "desc",
    orderScene: input.orderScene ?? "PAYMENT_VERIFICATION_PAGE",
    bizRefType: input.bizRefType ?? "",
    bizRefId: input.bizRefId ?? "",
    codeUrl: input.codeUrl ?? null,
    closeReason: input.closeReason ?? null,
    wechatTransactionIdMasked: input.wechatTransactionIdMasked ?? null,
    verifyAttemptCount: input.verifyAttemptCount ?? 0,
    lastErrorCode: input.lastErrorCode ?? null,
    lastErrorMessage: input.lastErrorMessage ?? null,
    latestCallback: input.latestCallback ?? null,
    latestQueryCheck: input.latestQueryCheck ?? null,
    evidence: input.evidence ?? null,
    statusLogs: input.statusLogs ?? [],
  };
}

test("collectPollingOrderIds includes active and detail pending orders without duplicates", () => {
  const active = buildOrder({ orderId: "po-1", outTradeNo: "wxv_1", status: "QR_READY" });
  const detail = buildOrder({ orderId: "po-2", outTradeNo: "wxv_2", status: "PAYING" });
  assert.deepEqual(collectPollingOrderIds(active, detail), ["po-1", "po-2"]);
  assert.deepEqual(collectPollingOrderIds(active, active), ["po-1"]);
  assert.deepEqual(collectPollingOrderIds(buildOrder({ orderId: "po-3", outTradeNo: "wxv_3", status: "PAID" }), detail), ["po-2"]);
});

test("mergePolledOrderIntoList updates list status and final source after backend terminal sync", () => {
  const before = [
    {
      orderId: "po-1",
      outTradeNo: "wxv_1",
      productCode: "WXPAY_VALIDATION_FIXED",
      status: "PAYING" as const,
      amountFen: 100,
      currency: "CNY",
      finalSource: null,
      qrExpiresAt: null,
      finalizedAt: null,
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const after = mergePolledOrderIntoList(before, buildOrder({
    orderId: "po-1",
    outTradeNo: "wxv_1",
    status: "PAID",
    finalSource: "CALLBACK",
    finalizedAt: 10,
    updatedAt: 10,
  }));

  assert.equal(after[0]?.status, "PAID");
  assert.equal(after[0]?.finalSource, "CALLBACK");
  assert.equal(after[0]?.finalizedAt, 10);
});
