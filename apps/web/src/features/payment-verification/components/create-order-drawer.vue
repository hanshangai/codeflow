<script setup lang="ts">
import { ref, watch } from "vue";
import type { VerificationProductResponseBody } from "@codeflowai/shared";

defineOptions({ name: "CreateOrderDrawer" });

const props = defineProps<{
  open: boolean;
  product: VerificationProductResponseBody | null;
  submitting: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "submit", payload: { remark: string }): void;
}>();

const remark = ref("");

watch(
  () => props.open,
  (open) => {
    if (open) remark.value = "";
  },
);
</script>

<template>
  <a-drawer
    :open="open"
    title="创建验证订单"
    width="420"
    destroy-on-close
    @close="emit('close')"
  >
    <div class="payment-verification__drawer-group">
      <label>商品编码</label>
      <strong>{{ product?.productCode ?? "-" }}</strong>
    </div>
    <div class="payment-verification__drawer-group">
      <label>商品名称</label>
      <strong>{{ product?.name ?? "-" }}</strong>
    </div>
    <div class="payment-verification__drawer-group">
      <label>固定金额</label>
      <strong>￥{{ ((product?.amountFen ?? 0) / 100).toFixed(2) }}</strong>
    </div>
    <div class="payment-verification__drawer-group">
      <label>订单场景</label>
      <strong>PAYMENT_VERIFICATION_PAGE</strong>
    </div>
    <div class="payment-verification__drawer-group">
      <label>备注（选填）</label>
      <a-textarea v-model:value="remark" :rows="4" placeholder="用于记录本次验证上下文" />
    </div>
    <template #footer>
      <div class="payment-verification__drawer-actions">
        <a-button @click="emit('close')">取消</a-button>
        <a-button type="primary" :loading="submitting" @click="emit('submit', { remark })">
          确认创建
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>
