<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ENGINE_MODEL_PROVIDERS, type EngineModelProviderId, type RelayModelPriceView } from "@codeflowai/shared";
import { getPublicRelayPricingCurrent } from "../../../api/relay-pricing";
import { createApiResultError, isApiResultError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { createBrowserUuid } from "../../../utils/browserUuid";

const { ctx } = useApiContext();
const rows = ref<RelayModelPriceView[]>([]);
const loading = ref(false);
const errorText = ref("");

/** 刷新前清除旧价；失败持久展示并抛给 Vue 边界，下一次刷新可重试。 */
async function load(): Promise<void> {
  const requestId = createBrowserUuid();
  loading.value = true;
  rows.value = [];
  errorText.value = "";
  try {
    const result = await getPublicRelayPricingCurrent(ctx.value);
    if (!result.ok) throw createApiResultError(result);
    rows.value = result.rows;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : String(error);
    const details = isApiResultError(error) && error.details && typeof error.details === "object"
      ? error.details as { requestId?: string } : undefined;
    console.error("[PUBLIC_RELAY_PRICING_FAILED]", {
      code: isApiResultError(error) ? error.code : "PUBLIC_RELAY_PRICING_FAILED",
      requestId: details?.requestId || requestId,
      path: "/api/public/relay/pricing/current",
      rootCause: errorText.value,
    });
    throw error;
  } finally {
    loading.value = false;
  }
}

/** 将稳定供应商标识映射为原公开名称，旧数据缺失时保留明确占位。 */
function providerLabel(value: unknown): string {
  return ENGINE_MODEL_PROVIDERS[String(value ?? "") as EngineModelProviderId]?.providerLabel ?? "待补齐";
}

onMounted(async () => { await load(); });
</script>

<template>
  <section class="relay-pricing-readonly-panel">
    <div class="relay-pricing-readonly-panel__heading">
      <h2>模型价格</h2>
      <a-button size="small" :loading="loading" @click="load">刷新</a-button>
    </div>
    <a-alert v-if="errorText" type="error" show-icon :message="errorText" />
    <a-table v-else :loading="loading" :data-source="rows" row-key="id" :pagination="false" :scroll="{ x: 1294 }" size="small">
      <a-table-column title="模型供应商">
        <template #default="{ record }">{{ providerLabel(record.providerId) }}</template>
      </a-table-column>
      <a-table-column title="供应商" data-index="supplier" />
      <a-table-column title="模型版本" data-index="modelVersion" />
      <a-table-column title="多模态">
        <template #default="{ record }">{{ record.multimodal ? "是" : "否" }}</template>
      </a-table-column>
      <a-table-column title="输入价格（命中缓存，元/百万 Token）">
        <template #default="{ record }">{{ (record.inputCachedPriceMilliYuanPerMillionTokens / 1000).toFixed(3) }}</template>
      </a-table-column>
      <a-table-column title="输入价格（未命中缓存，元/百万 Token）">
        <template #default="{ record }">{{ (record.inputUncachedPriceMilliYuanPerMillionTokens / 1000).toFixed(3) }}</template>
      </a-table-column>
      <a-table-column title="输出（元/百万 Token）">
        <template #default="{ record }">{{ (record.outputPriceMilliYuanPerMillionTokens / 1000).toFixed(3) }}</template>
      </a-table-column>
      <a-table-column title="备注" data-index="remark" />
    </a-table>
  </section>
</template>

<style scoped>
.relay-pricing-readonly-panel { min-height: 0; padding: 16px; overflow: auto; }
.relay-pricing-readonly-panel__heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.relay-pricing-readonly-panel__heading h2 { margin: 0; font-size: 18px; }
</style>
