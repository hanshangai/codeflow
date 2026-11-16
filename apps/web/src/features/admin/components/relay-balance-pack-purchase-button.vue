<script setup lang="ts">
import { ref } from "vue";
import { MoneyCollectOutlined } from "@ant-design/icons-vue";
import type { CheckoutEntrySource, RelayBalancePackTargetScope } from "@codeflowai/shared";

import RelayTokenRechargeModal from "./relay-token-recharge-modal.vue";

defineOptions({ name: "RelayBalancePackPurchaseButton" });

const props = withDefaults(defineProps<{
  disabledReason?: string | null;
  entrySource?: CheckoutEntrySource;
  defaultTargetScope?: RelayBalancePackTargetScope;
  enterpriseId?: string | null;
  label?: string;
  size?: "small" | "middle" | "large";
}>(), {
  disabledReason: null,
  entrySource: "ACCOUNT_DRAWER",
  defaultTargetScope: "USER",
  enterpriseId: null,
  label: "Token充值",
  size: "middle",
});

const emit = defineEmits<{
  (event: "opened"): void;
  (event: "succeeded"): void;
}>();

const modalVisible = ref(false);

/** 请求打开统一充值弹框，登录和禁用校验由弹框组件集中处理。 */
function openModal(): void {
  modalVisible.value = true;
}
</script>

<template>
  <a-button type="primary" :size="props.size" @click="openModal">
    <template #icon><MoneyCollectOutlined /></template>
    {{ props.label }}
  </a-button>

  <RelayTokenRechargeModal
    v-model:open="modalVisible"
    :disabled-reason="props.disabledReason"
    :default-target-scope="props.defaultTargetScope"
    :enterprise-id="props.enterpriseId"
    :entry-source="props.entrySource"
    @opened="emit('opened')"
    @succeeded="emit('succeeded')"
  />
</template>
