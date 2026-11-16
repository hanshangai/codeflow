<script setup lang="ts">
import { reactive, watch } from "vue";
import type { PaymentOrderFilterView, PaymentOrderListItemView } from "@codeflowai/shared";

defineOptions({ name: "VerificationOrderTable" });

const props = defineProps<{
  items: PaymentOrderListItemView[];
  loading: boolean;
  filters: PaymentOrderFilterView;
  total: number;
}>();

const emit = defineEmits<{
  (e: "filter-change", payload: PaymentOrderFilterView): void;
  (e: "open-detail", payload: { orderId: string }): void;
  (e: "copy-out-trade-no", payload: { outTradeNo: string }): void;
}>();

const localFilters = reactive<PaymentOrderFilterView>({
  status: "ALL",
  confirmedBy: "ALL",
  keyword: "",
  page: 1,
  pageSize: 20,
});

watch(
  () => props.filters,
  (next) => {
    Object.assign(localFilters, next);
  },
  { immediate: true, deep: true },
);

const columns = [
  { title: "订单号", key: "outTradeNo" },
  { title: "状态", key: "status" },
  { title: "金额", key: "amountFen" },
  { title: "确认方式", key: "finalSource" },
  { title: "创建时间", key: "createdAt" },
  { title: "操作", key: "action" },
];

function submitFilters() {
  emit("filter-change", { ...localFilters, page: 1 });
}

function resetFilters() {
  emit("filter-change", {
    status: "ALL",
    confirmedBy: "ALL",
    keyword: "",
    page: 1,
    pageSize: localFilters.pageSize,
  });
}
</script>

<template>
  <section class="payment-verification__table-card">
    <div class="payment-verification__table-toolbar">
      <div class="payment-verification__filter-row">
        <a-select v-model:value="localFilters.status" style="width: 150px">
          <a-select-option value="ALL">全部状态</a-select-option>
          <a-select-option value="QR_READY">待扫码</a-select-option>
          <a-select-option value="PAYING">支付中</a-select-option>
          <a-select-option value="PAID">支付成功</a-select-option>
          <a-select-option value="FAILED">支付失败</a-select-option>
          <a-select-option value="CANCELLED">已取消</a-select-option>
          <a-select-option value="TIMEOUT">已超时</a-select-option>
        </a-select>
        <a-select v-model:value="localFilters.confirmedBy" style="width: 170px">
          <a-select-option value="ALL">全部确认方式</a-select-option>
          <a-select-option value="CALLBACK">CALLBACK</a-select-option>
          <a-select-option value="QUERY">QUERY</a-select-option>
          <a-select-option value="MANUAL_CANCEL">MANUAL_CANCEL</a-select-option>
          <a-select-option value="TIMEOUT_SWEEP">TIMEOUT_SWEEP</a-select-option>
          <a-select-option value="CREATE_FAIL">CREATE_FAIL</a-select-option>
        </a-select>
        <a-input v-model:value="localFilters.keyword" placeholder="搜索订单号" @pressEnter="submitFilters" />
        <a-button type="primary" @click="submitFilters">查询</a-button>
        <a-button @click="resetFilters">重置</a-button>
      </div>
      <span class="payment-verification__table-total">共 {{ total }} 条</span>
    </div>

    <a-table
      :columns="columns"
      :data-source="items"
      :loading="loading"
      :pagination="false"
      :row-key="(record: PaymentOrderListItemView) => record.orderId"
      size="middle"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'outTradeNo'">
          <button class="payment-verification__link-btn" @click="emit('copy-out-trade-no', { outTradeNo: record.outTradeNo })">
            {{ record.outTradeNo }}
          </button>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag>{{ record.status }}</a-tag>
        </template>
        <template v-else-if="column.key === 'amountFen'">
          ￥{{ (record.amountFen / 100).toFixed(2) }}
        </template>
        <template v-else-if="column.key === 'finalSource'">
          {{ record.finalSource ?? "待确认" }}
        </template>
        <template v-else-if="column.key === 'createdAt'">
          {{ new Date(record.createdAt).toLocaleString() }}
        </template>
        <template v-else-if="column.key === 'action'">
          <a-button type="link" @click="emit('open-detail', { orderId: record.orderId })">详情</a-button>
        </template>
      </template>
    </a-table>

    <div class="payment-verification__pagination">
      <a-pagination
        :current="filters.page"
        :page-size="filters.pageSize"
        :total="total"
        :show-size-changer="false"
        @change="(page: number) => emit('filter-change', { ...filters, page })"
      />
    </div>
  </section>
</template>
