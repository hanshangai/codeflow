<script setup lang="ts">
import { computed, ref, watch } from "vue";
import QRCode from "qrcode";
import type { PaymentOrderDetailView, VerificationProductResponseBody } from "@codeflowai/shared";

defineOptions({ name: "VerificationProductCard" });

const props = defineProps<{
  product: VerificationProductResponseBody | null;
  activeOrder: PaymentOrderDetailView | null;
  polling: boolean;
  countdownSeconds: number | null;
}>();

const emit = defineEmits<{
  (e: "create-order"): void;
  (e: "refresh-order", payload: { orderId: string }): void;
  (e: "cancel-order", payload: { orderId: string }): void;
  (e: "open-detail", payload: { orderId: string }): void;
}>();

const qrDataUrl = ref<string>("");
const showQrCode = computed(() => props.activeOrder?.status === "QR_READY" || props.activeOrder?.status === "PAYING");

watch(
  () => ({
    codeUrl: props.activeOrder?.codeUrl ?? "",
    showQrCode: showQrCode.value,
  }),
  async ({ codeUrl, showQrCode }) => {
    if (!showQrCode || !codeUrl) {
      qrDataUrl.value = "";
      return;
    }
    try {
      qrDataUrl.value = await QRCode.toDataURL(codeUrl, {
        margin: 1,
        width: 280,
        color: {
          dark: "#162235",
          light: "#f8f4eb",
        },
      });
    } catch {
      qrDataUrl.value = "";
    }
  },
  { immediate: true },
);

function statusLabel(order: PaymentOrderDetailView | null): string {
  if (!order) return "未创建订单";
  if (order.status === "QR_READY") return "待扫码";
  if (order.status === "PAYING") return "支付中";
  if (order.status === "PAID") return "支付成功";
  if (order.status === "CANCELLED") return "已取消";
  if (order.status === "TIMEOUT") return "已超时";
  if (order.status === "FAILED") return "支付失败";
  return "创建中";
}
</script>

<template>
  <section class="payment-verification__hero-card">
    <div class="payment-verification__hero-header">
      <div>
        <p class="payment-verification__eyebrow">固定验证商品</p>
        <h2>{{ product?.name ?? "微信支付验证商品" }}</h2>
        <p class="payment-verification__subtext">
          {{ product?.description ?? "用于验证二维码支付、回调与查单闭环" }}
        </p>
      </div>
      <div class="payment-verification__price-chip">
        <span>金额</span>
        <strong>￥{{ ((product?.amountFen ?? 0) / 100).toFixed(2) }}</strong>
      </div>
    </div>

    <div class="payment-verification__hero-body">
      <div class="payment-verification__qr-panel">
        <div class="payment-verification__qr-box">
          <img v-if="qrDataUrl" :src="qrDataUrl" alt="支付二维码" class="payment-verification__qr-image" />
          <div v-else class="payment-verification__qr-empty">
            <span>{{ activeOrder ? "当前订单已进入终态" : "创建订单后显示二维码" }}</span>
            <small>{{ activeOrder ? "查看详情可核验回调、查单与证据摘要" : "二维码仅用于验证支付闭环" }}</small>
          </div>
        </div>
        <div class="payment-verification__status-row">
          <span class="payment-verification__status-pill">
            {{ statusLabel(activeOrder) }}
          </span>
          <span v-if="showQrCode && countdownSeconds !== null" class="payment-verification__countdown">
            剩余 {{ countdownSeconds }}s
          </span>
          <span v-if="showQrCode && polling" class="payment-verification__countdown">自动轮询中</span>
        </div>
      </div>

      <div class="payment-verification__summary-panel">
        <div class="payment-verification__summary-card">
          <span>当前订单</span>
          <strong>{{ activeOrder?.outTradeNo ?? "尚未创建" }}</strong>
        </div>
        <div class="payment-verification__summary-card">
          <span>终态来源</span>
          <strong>{{ activeOrder?.finalSource ?? "待确认" }}</strong>
        </div>
        <div class="payment-verification__summary-card">
          <span>最后更新时间</span>
          <strong>{{ activeOrder ? new Date(activeOrder.updatedAt).toLocaleString() : "暂无" }}</strong>
        </div>
      </div>
    </div>

    <div class="payment-verification__actions">
      <a-button type="primary" size="large" @click="emit('create-order')">
        创建验证订单
      </a-button>
      <a-button
        size="large"
        :disabled="!activeOrder || (activeOrder.status !== 'QR_READY' && activeOrder.status !== 'PAYING')"
        @click="activeOrder && emit('refresh-order', { orderId: activeOrder.orderId })"
      >
        刷新支付结果
      </a-button>
      <a-button
        size="large"
        :disabled="!activeOrder"
        @click="activeOrder && emit('open-detail', { orderId: activeOrder.orderId })"
      >
        查看详情
      </a-button>
      <a-button
        danger
        size="large"
        :disabled="!activeOrder || (activeOrder.status !== 'QR_READY' && activeOrder.status !== 'PAYING')"
        @click="activeOrder && emit('cancel-order', { orderId: activeOrder.orderId })"
      >
        取消订单
      </a-button>
    </div>
  </section>
</template>
