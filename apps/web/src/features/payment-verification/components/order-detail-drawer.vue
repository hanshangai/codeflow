<script setup lang="ts">
import type { PaymentOrderDetailView } from "@codeflowai/shared";

defineOptions({ name: "OrderDetailDrawer" });

defineProps<{
  open: boolean;
  order: PaymentOrderDetailView | null;
  refreshing: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "verify-now", payload: { orderId: string }): void;
}>();
</script>

<template>
  <a-drawer
    :open="open"
    title="订单详情"
    width="520"
    destroy-on-close
    @close="emit('close')"
  >
    <template v-if="order">
      <div class="payment-verification__detail-grid">
        <div class="payment-verification__detail-item">
          <label>订单号</label>
          <strong>{{ order.outTradeNo }}</strong>
        </div>
        <div class="payment-verification__detail-item">
          <label>当前状态</label>
          <strong>{{ order.status }}</strong>
        </div>
        <div class="payment-verification__detail-item">
          <label>终态来源</label>
          <strong>{{ order.finalSource ?? "待确认" }}</strong>
        </div>
        <div class="payment-verification__detail-item">
          <label>微信交易号</label>
          <strong>{{ order.wechatTransactionIdMasked ?? "-" }}</strong>
        </div>
      </div>

      <div class="payment-verification__detail-block">
        <h4>状态轨迹</h4>
        <ul class="payment-verification__timeline">
          <li v-for="log in order.statusLogs" :key="log.id">
            <strong>{{ log.toStatus }}</strong>
            <span>{{ log.triggerSource }}</span>
            <small>{{ new Date(log.createdAt).toLocaleString() }}</small>
          </li>
        </ul>
      </div>

      <div class="payment-verification__detail-block">
        <h4>最新回调</h4>
        <p v-if="order.latestCallback">
          {{ order.latestCallback.notificationId }} / {{ order.latestCallback.verifyStatus }} / {{ order.latestCallback.processStatus }}
        </p>
        <p v-else>暂无回调记录</p>
      </div>

      <div class="payment-verification__detail-block">
        <h4>最新查单</h4>
        <p v-if="order.latestQueryCheck">
          {{ order.latestQueryCheck.triggerSource }} / {{ order.latestQueryCheck.tradeState ?? "-" }} / {{ order.latestQueryCheck.queryResult }}
        </p>
        <p v-else>暂无查单记录</p>
      </div>

      <div class="payment-verification__detail-block">
        <h4>证据摘要</h4>
        <p v-if="order.evidence">
          {{ order.evidence.terminalStatus }} / {{ order.evidence.confirmedBy }} / {{ order.evidence.completenessStatus }}
        </p>
        <p v-else>订单尚未生成终态证据</p>
      </div>
    </template>
    <template #footer>
      <div class="payment-verification__drawer-actions">
        <a-button @click="emit('close')">关闭</a-button>
        <a-button
          type="primary"
          :loading="refreshing"
          :disabled="!order || (order.status !== 'QR_READY' && order.status !== 'PAYING')"
          @click="order && emit('verify-now', { orderId: order.orderId })"
        >
          重新核验
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>
