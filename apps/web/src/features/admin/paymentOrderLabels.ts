import type { PaymentOrderKind, PaymentOrderStatus } from "@codeflowai/shared";
import { DEFAULT_RELAY_USD_TO_CNY_RATE } from "@codeflowai/shared";

export const ORDER_KIND_OPTIONS = [
  { value: "ALL", label: "订单类型" },
  { value: "PACKAGE", label: "套餐订单" },
  { value: "TOKEN", label: "Token充值" },
] as const;

const PAYMENT_STATUS_OPTIONS = [
  { value: "ALL", label: "支付状态" },
  { value: "CREATED", label: "待创建二维码" },
  { value: "QR_READY", label: "待支付" },
  { value: "PAYING", label: "支付中" },
  { value: "PAID", label: "已支付" },
  { value: "CANCELLED", label: "已取消" },
  { value: "TIMEOUT", label: "已超时" },
  { value: "FAILED", label: "支付失败" },
] as const;

export function formatPaymentStatus(status: PaymentOrderStatus | null | undefined): string {
  return PAYMENT_STATUS_OPTIONS.find((item) => item.value === status)?.label ?? String(status ?? "-");
}

export function formatOrderKind(kind: PaymentOrderKind | null | undefined): string {
  if (kind === "TOKEN") return "Token 充值";
  if (kind === "PACKAGE") return "套餐订单";
  return "-";
}

export function paymentStatusTone(status: PaymentOrderStatus | null | undefined): string {
  if (status === "PAID") return "success";
  if (status === "QR_READY" || status === "PAYING") return "processing";
  if (status === "CANCELLED" || status === "TIMEOUT") return "warning";
  if (status === "FAILED") return "error";
  return "default";
}

/** 历史企业开通订单展示原资格与周期事实。 */
export function formatBillingCycleLabel(billingCycle: string | null | undefined, durationMonths?: number | null): string {
  if (billingCycle === "NONE") return "永久使用";
  if (billingCycle === "MONTH_1" || durationMonths === 1) return "1人月";
  if (billingCycle === "MONTH_3" || durationMonths === 3) return "3人月";
  if (billingCycle === "MONTH_6" || durationMonths === 6) return "6人月";
  if (billingCycle === "MONTH_12" || durationMonths === 12) return "12人月";
  if (billingCycle === "MONTH_24" || durationMonths === 24) return "24人月";
  return durationMonths && durationMonths > 0 ? `${durationMonths}人月` : "-";
}

export function formatPriceFen(fen: number | null | undefined): string {
  if (!Number.isFinite(Number(fen))) return "-";
  return `￥${(Number(fen) / 100).toFixed(2)}`;
}

export function formatRelayMoneyFromUsd(value: number | null | undefined): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "-";
  return `￥${(numeric * DEFAULT_RELAY_USD_TO_CNY_RATE).toFixed(2)}`;
}

export function formatDateTimeShort(value: number | null | undefined): string {
  if (!value || value <= 0) return "-";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
