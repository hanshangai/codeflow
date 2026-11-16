
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { RedemptionRecordItem } from "@codeflowai/shared";

import { listMyRedemptionRecords, redeemCode } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "redeemed"): void;
}>();

const { ctx } = useApiContext();
const code = ref("");
const submitting = ref(false);
const loadingRecords = ref(false);
const records = ref<RedemptionRecordItem[]>([]);
const total = ref(0);
const current = ref(1);
const pageSize = ref(5);
const pageSizeOptions = ["5", "10", "20", "50", "100"];

const contentText = {
  title: "流量兑换",
  codeLabel: "请输入流量兑换码",
  submit: "立即兑换",
  records: "兑换记录",
  empty: "暂无兑换记录",
  success: "兑换成功，权益已更新",
  inputRequired: "请输入流量兑换码",
} as const;

const columns = [
  { title: "流量兑换", dataIndex: "codeMasked", key: "codeMasked", width: 140 },
  { title: "兑换内容", dataIndex: "content", key: "content" },
  { title: "兑换时间", dataIndex: "redeemedAt", key: "redeemedAt", width: 170 },
  { title: "兑换后余额", dataIndex: "balance", key: "balance", width: 220 },
];

const canSubmit = computed(() => code.value.trim().length > 0 && !submitting.value);

/** Format timestamp in local time for compact tables. */
function formatTime(value: number | null | undefined): string {
  const ts = Number(value ?? 0);
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString();
}

/** Format redeemed content from record deltas. */
function formatContent(record: RedemptionRecordItem): string {
  const owner = record.enterpriseId ? `企业${record.enterpriseName ? `（${record.enterpriseName}）` : ""}` : "个人";
  if (record.redeemedChoice === "ENTERPRISE") return `${owner} 永久企业版`;
  if (record.redeemedChoice === "PACKAGE") return `${owner} ${record.packageDeltaPersonMonths} 人月套餐`;
  return `${owner} ${record.tokenDeltaAmountYuan} 元 Token`;
}

/** Format post-redemption balance snapshot for user confirmation. */
function formatBalance(record: RedemptionRecordItem): string {
  if (record.redeemedChoice === "ENTERPRISE") return "永久企业版已开通，Token 另计";
  if (record.redeemedChoice === "PACKAGE") {
    return record.after.packageExpiresAt > 0 ? `套餐到期：${formatTime(record.after.packageExpiresAt)}` : "套餐余额已更新";
  }
  const owner = record.enterpriseId ? "企业 Token 池" : "Token 余额";
  return `${owner}：${formatYuanAmount(record.after.tokenQuotaUsd * record.exchangeRateSnapshot)} 元`;
}

/** Format CNY amounts without exposing internal Relay USD quota. */
function formatYuanAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return (Math.round(value * 100) / 100).toString();
}

/** Load personal redemption records with current pagination. */
async function loadRecords(resetPage = false): Promise<void> {
  if (resetPage) current.value = 1;
  loadingRecords.value = true;
  try {
    const result = await listMyRedemptionRecords(ctx.value, { offset: (current.value - 1) * pageSize.value, limit: pageSize.value });
    if (!result.ok) {
      message.error(result.message || "兑换记录加载失败");
      return;
    }
    records.value = result.items;
    total.value = result.total;
  } finally {
    loadingRecords.value = false;
  }
}

/** Update record pagination and reload when values changed. */
async function updatePagination(nextCurrent?: number, nextPageSize?: number, resetToFirstPage = false): Promise<void> {
  const normalizedPageSize = Number(nextPageSize ?? pageSize.value);
  const pageSizeChanged = normalizedPageSize !== pageSize.value;
  const normalizedCurrent = pageSizeChanged || resetToFirstPage ? 1 : Number(nextCurrent ?? current.value);

  if (current.value === normalizedCurrent && pageSize.value === normalizedPageSize) {
    return;
  }

  pageSize.value = normalizedPageSize;
  current.value = normalizedCurrent;
  await loadRecords(false);
}

/** Handle record page changes from the standard pagination component. */
async function handlePaginationChange(page: number, nextPageSize: number): Promise<void> {
  await updatePagination(page, nextPageSize);
}

/** Reset records to first page when page size changes. */
async function handlePageSizeChange(_: number, nextPageSize: number): Promise<void> {
  await updatePagination(1, nextPageSize, true);
}

/** Submit redemption request and refresh balance-related data. */
async function submit(): Promise<void> {
  const text = code.value.trim();
  if (!text) {
    message.warning(contentText.inputRequired);
    return;
  }
  submitting.value = true;
  try {
    const result = await redeemCode(ctx.value, { code: text });
    if (!result.ok) {
      message.error(result.message || "兑换失败");
      return;
    }
    message.success(contentText.success);
    code.value = "";
    current.value = 1;
    await loadRecords(false);
    emit("redeemed");
  } finally {
    submitting.value = false;
  }
}

/** Close modal through v-model so parent owns visibility. */
function close(): void {
  emit("update:open", false);
}

watch(() => props.open, (open) => {
  if (open) void loadRecords(true);
});
</script>

<template>
  <a-modal
    :open="open"
    :title="contentText.title"
    :footer="null"
    width="820px"
    @cancel="close"
  >
    <div class="redemption-modal">
      <section class="redemption-modal__redeem-panel">
        <a-form layout="vertical" class="redemption-modal__form" @submit.prevent="submit">
          <a-form-item class="redemption-modal__code-field" :label="contentText.codeLabel">
            <a-input
              v-model:value="code"
              size="large"
              autocomplete="off"
              allow-clear
              :maxlength="40"
              placeholder="请输入 16 位流量兑换码"
              @press-enter="submit"
            />
          </a-form-item>
          <a-button
            class="redemption-modal__submit"
            type="primary"
            size="large"
            :loading="submitting"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ contentText.submit }}
          </a-button>
        </a-form>
      </section>

      <section class="redemption-modal__records-panel">
        <div class="redemption-modal__records-header">
          <div>
            <strong>{{ contentText.records }}</strong>
            <span>查看已兑换权益和兑换后的余额变化</span>
          </div>
          <a-tag :bordered="false">共 {{ total }} 条</a-tag>
        </div>

        <a-table
          class="redemption-modal__table"
          size="small"
          row-key="id"
          :columns="columns"
          :data-source="records"
          :loading="loadingRecords"
          :pagination="false"
          :locale="{ emptyText: contentText.empty }"
          :scroll="{ x: 760 }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'content'">
              {{ formatContent(record as RedemptionRecordItem) }}
            </template>
            <template v-else-if="column.key === 'redeemedAt'">
              {{ formatTime((record as RedemptionRecordItem).redeemedAt) }}
            </template>
            <template v-else-if="column.key === 'balance'">
              {{ formatBalance(record as RedemptionRecordItem) }}
            </template>
          </template>
        </a-table>

        <div class="redemption-modal__pagination">
          <a-pagination
            :current="current"
            :page-size="pageSize"
            :total="total"
            :show-size-changer="true"
            :show-quick-jumper="total > pageSize"
            :page-size-options="pageSizeOptions"
            :show-less-items="true"
            @change="handlePaginationChange"
            @showSizeChange="handlePageSizeChange"
          >
            <template #buildOptionText="{ value }">
              {{ value }} 条/页
            </template>
          </a-pagination>
        </div>
      </section>
    </div>
  </a-modal>
</template>

<style scoped>
.redemption-modal {
  display: grid;
  gap: 18px;
  min-width: 0;
}

.redemption-modal__redeem-panel,
.redemption-modal__records-panel {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding: 18px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
  border-radius: 18px;
  background: color-mix(in srgb, var(--app-panel-bg) 98%, #fff);
}

.redemption-modal__redeem-panel {
  grid-template-columns: minmax(0, 1fr);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--app-accent) 9%, #fff7f0), color-mix(in srgb, var(--app-panel-bg) 98%, #fff));
}

.redemption-modal__form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: flex-end;
  gap: 12px;
  min-width: 0;
}

.redemption-modal__code-field {
  margin-bottom: 0;
}

.redemption-modal__code-field :deep(.ant-form-item-label) {
  padding-bottom: 6px;
}

.redemption-modal__code-field :deep(.ant-input) {
  font-family: Consolas, "SFMono-Regular", monospace;
  letter-spacing: 0;
}

.redemption-modal__submit {
  min-width: 112px;
}

.redemption-modal__records-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.redemption-modal__records-header > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.redemption-modal__records-header strong {
  color: var(--app-text);
  font-size: 15px;
}

.redemption-modal__records-header span {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.redemption-modal__table {
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--app-accent) 8%, var(--app-border));
  border-radius: 14px;
}

.redemption-modal__table :deep(.ant-table) {
  background: transparent;
}

.redemption-modal__table :deep(.ant-table-thead > tr > th) {
  color: var(--app-text);
  font-weight: 600;
  background: color-mix(in srgb, var(--app-bg) 82%, var(--app-panel-bg));
}

.redemption-modal__table :deep(.ant-table-tbody > tr > td) {
  color: var(--app-text);
}

.redemption-modal__pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
  padding-top: 2px;
}

@media (max-width: 768px) {
  .redemption-modal__redeem-panel,
  .redemption-modal__records-panel {
    padding: 14px;
  }

  .redemption-modal__form {
    grid-template-columns: 1fr;
  }

  .redemption-modal__submit {
    width: 100%;
  }

  .redemption-modal__records-header,
  .redemption-modal__pagination {
    align-items: stretch;
    justify-content: flex-start;
  }
}
</style>
