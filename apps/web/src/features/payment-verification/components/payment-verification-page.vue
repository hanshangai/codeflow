<script setup lang="ts">
import { reactive } from "vue";
import { Modal } from "ant-design-vue";

import { usePaymentVerification } from "../composables/usePaymentVerification";
import VerificationProductCard from "./verification-product-card.vue";
import VerificationOrderTable from "./verification-order-table.vue";
import CreateOrderDrawer from "./create-order-drawer.vue";
import OrderDetailDrawer from "./order-detail-drawer.vue";
import "../styles/payment-verification.css";

defineOptions({ name: "PaymentVerificationPage" });

const payment = reactive(usePaymentVerification());

function confirmCancel(orderId: string) {
  Modal.confirm({
    title: "取消当前订单？",
    content: "系统会先尝试关单，再立即查单确认最终状态，避免把已支付订单误标记为取消。",
    okText: "确认取消",
    cancelText: "返回",
    onOk: async () => {
      await payment.cancelOrder(orderId);
    },
  });
}
</script>

<template>
  <div class="payment-verification">
    <section class="payment-verification__masthead">
      <div>
        <p class="payment-verification__eyebrow">微信支付核心能力一期</p>
        <h1>浏览器验证页</h1>
        <p class="payment-verification__intro">
          这一页只验证固定商品下单、二维码支付、支付回调、主动查单和证据闭环，不承担套餐购买和权益开通。
        </p>
      </div>
      <div class="payment-verification__masthead-facts">
        <span>固定验证商品</span>
        <span>Native 扫码支付</span>
        <span>回调 + 查单双路径</span>
      </div>
    </section>

    <VerificationProductCard
      :product="payment.product"
      :active-order="payment.activeOrder"
      :polling="payment.polling"
      :countdown-seconds="payment.countdownSeconds"
      @create-order="payment.openCreateDrawer"
      @refresh-order="({ orderId }) => payment.verifyOrder(orderId, 'PAGE_REFRESH')"
      @open-detail="({ orderId }) => payment.openDetailDrawer(orderId)"
      @cancel-order="({ orderId }) => confirmCancel(orderId)"
    />

    <VerificationOrderTable
      :items="payment.items"
      :loading="payment.listLoading"
      :filters="payment.filters"
      :total="payment.total"
      @filter-change="payment.changeFilters"
      @open-detail="({ orderId }) => payment.openDetailDrawer(orderId)"
      @copy-out-trade-no="({ outTradeNo }) => payment.copyOutTradeNo(outTradeNo)"
    />

    <CreateOrderDrawer
      :open="payment.createDrawerOpen"
      :product="payment.product"
      :submitting="payment.creating"
      @close="payment.closeCreateDrawer"
      @submit="({ remark }) => payment.createOrder(remark)"
    />

    <OrderDetailDrawer
      :open="payment.detailDrawerOpen"
      :order="payment.detailOrder"
      :refreshing="payment.refreshing"
      @close="payment.closeDetailDrawer"
      @verify-now="({ orderId }) => payment.verifyOrder(orderId, 'DETAIL_DRAWER')"
    />
  </div>
</template>
