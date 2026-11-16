import type { PaymentOrderDetailView, PaymentOrderListItemView } from "@codeflowai/shared";

export function isPendingVerificationOrder(order: PaymentOrderDetailView | null): boolean {
  return order?.status === "QR_READY" || order?.status === "PAYING";
}

export function collectPollingOrderIds(
  activeOrder: PaymentOrderDetailView | null,
  detailOrder: PaymentOrderDetailView | null,
): string[] {
  const ids = new Set<string>();
  if (isPendingVerificationOrder(activeOrder) && activeOrder) ids.add(activeOrder.orderId);
  if (isPendingVerificationOrder(detailOrder) && detailOrder) ids.add(detailOrder.orderId);
  return [...ids];
}

export function toVerificationListItem(order: PaymentOrderDetailView): PaymentOrderListItemView {
  return {
    orderId: order.orderId,
    outTradeNo: order.outTradeNo,
    productCode: order.productCode,
    status: order.status,
    amountFen: order.amountFen,
    currency: order.currency,
    finalSource: order.finalSource,
    qrExpiresAt: order.qrExpiresAt,
    finalizedAt: order.finalizedAt,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

export function mergePolledOrderIntoList(
  items: PaymentOrderListItemView[],
  order: PaymentOrderDetailView,
): PaymentOrderListItemView[] {
  const nextItem = toVerificationListItem(order);
  let changed = false;
  const next = items.map((item) => {
    if (item.orderId !== order.orderId) return item;
    changed = true;
    return nextItem;
  });
  return changed ? next : items;
}
