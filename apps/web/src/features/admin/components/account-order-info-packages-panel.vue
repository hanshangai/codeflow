<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import type { AccountOrderInfoPackageItem, PackageStatus } from "@codeflowai/shared";

import { listAccountOrderInfoPackages } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";
import { formatDateOnly, formatPackageSource } from "../../account/accountDisplay";

defineOptions({ name: "AccountOrderInfoPackagesPanel" });

const { ctx } = useApiContext();

const items = ref<AccountOrderInfoPackageItem[]>([]);
const loading = ref(false);
const paging = reactive({
  current: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});

const pagedItems = computed(() => {
  const start = (paging.current - 1) * paging.pageSize;
  return items.value.slice(start, start + paging.pageSize);
});
/** 表格空态保留表头，避免无套餐账号进入页面时出现整页空白。 */
const packageTableLocale = computed(() => ({
  emptyText: loading.value ? "正在加载套餐信息" : "暂无套餐信息",
}));

function formatStatus(status: PackageStatus | null | undefined): string {
  if (status === "ACTIVE") return "生效中";
  if (status === "EXPIRING") return "即将到期";
  if (status === "EXPIRED") return "已过期";
  return "未开通";
}

function statusColor(status: PackageStatus | null | undefined): string {
  if (status === "ACTIVE") return "green";
  if (status === "EXPIRING") return "gold";
  if (status === "EXPIRED") return "red";
  return "default";
}

/** 拉取当前账号可见的套餐信息。 */
async function loadPackages(): Promise<void> {
  loading.value = true;
  try {
    const result = await listAccountOrderInfoPackages(ctx.value);
    if (!result.ok) {
      message.error(result.message);
      return;
    }
    items.value = result.items;
    const totalPages = Math.max(1, Math.ceil(items.value.length / paging.pageSize));
    if (paging.current > totalPages) {
      paging.current = 1;
    }
  } finally {
    loading.value = false;
  }
}

async function handlePaginationChange(page: number, pageSize: number): Promise<void> {
  const pageSizeChanged = pageSize !== paging.pageSize;
  paging.pageSize = pageSize;
  paging.current = pageSizeChanged ? 1 : page;
}

async function handlePageSizeChange(_: number, pageSize: number): Promise<void> {
  paging.pageSize = pageSize;
  paging.current = 1;
}

onMounted(() => {
  void loadPackages();
});
</script>

<template>
  <div class="admin-panel account-order-info-packages">
    <div class="admin-panel__header">
      <div>
        <h2 class="admin-panel__title">历史套餐</h2>
        <p class="admin-panel__description">仅展示历史人月事实，不影响当前企业访问权限</p>
      </div>
      <a-button type="primary" :loading="loading" @click="loadPackages">刷新</a-button>
    </div>

    <div class="account-order-info-packages__query-summary">
      <span>查询范围：当前账号</span>
      <span>记录数：{{ items.length }}</span>
    </div>

    <a-table
      class="admin-panel__table"
      :data-source="pagedItems"
      :loading="loading"
      :locale="packageTableLocale"
      :pagination="false"
      row-key="itemId"
      size="small"
      :scroll="{ x: 980, y: 480 }"
    >
      <a-table-column title="名称" :width="220">
        <template #default="{ record }">
          <div class="account-order-info-packages__cell">
            <strong>{{ record.displayName }}</strong>
            <small>{{ record.planName || '-' }}</small>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="范围" :width="100">
        <template #default>企业</template>
      </a-table-column>
      <a-table-column title="状态" :width="120">
        <template #default="{ record }">
          <a-tag :color="statusColor(record.status)">{{ formatStatus(record.status) }}</a-tag>
        </template>
      </a-table-column>
      <a-table-column title="已购" data-index="purchasedPersonMonths" :width="90" />
      <a-table-column title="已分配" data-index="allocatedPersonMonths" :width="90" />
      <a-table-column title="可分配" data-index="availablePersonMonths" :width="90" />
      <a-table-column title="到期日期" :width="140">
        <template #default="{ record }">{{ formatDateOnly(record.expiresAt) }}</template>
      </a-table-column>
      <a-table-column title="来源" :width="140">
        <template #default="{ record }">
          {{ formatPackageSource({
            purchasedPersonMonths: record.purchasedPersonMonths,
            allocatedPersonMonths: record.allocatedPersonMonths,
            availablePersonMonths: record.availablePersonMonths,
            expiresAt: record.expiresAt,
            sourceType: record.sourceType,
            isEnterprise: record.scope === 'ENTERPRISE',
            scopeType: record.scope === 'ENTERPRISE' ? 'ENTERPRISE' : 'NONE',
            planCode: record.planCode,
            planName: record.planName,
            status: record.status,
          }) }}
        </template>
      </a-table-column>
    </a-table>

    <div class="account-order-info-packages__pagination">
      <div class="account-order-info-packages__pagination-total">共 {{ items.length }} 条记录</div>
      <a-pagination
        :current="paging.current"
        :page-size="paging.pageSize"
        :total="items.length"
        :show-size-changer="true"
        :show-quick-jumper="items.length > paging.pageSize"
        :page-size-options="paging.pageSizeOptions"
        :show-less-items="true"
        @change="handlePaginationChange"
        @showSizeChange="handlePageSizeChange"
      >
        <template #buildOptionText="{ value }">
          {{ value }} 条/页
        </template>
      </a-pagination>
    </div>
  </div>
</template>

<style scoped>
.account-order-info-packages {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto auto auto;
  gap: 14px;
  align-content: start;
  height: auto;
  min-width: 0;
  min-height: 0;
}

.admin-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.admin-panel__title {
  margin: 0;
  font-size: 18px;
}

.admin-panel__description {
  margin: 6px 0 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.account-order-info-packages__query-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.4;
}

.admin-panel__table {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.admin-panel__table :deep(.ant-spin-nested-loading),
.admin-panel__table :deep(.ant-spin-container),
.admin-panel__table :deep(.ant-table),
.admin-panel__table :deep(.ant-table-container) {
  display: flex;
  flex-direction: column;
  flex: initial;
  min-width: 0;
  min-height: 0;
}

.admin-panel__table :deep(.ant-table-content),
.admin-panel__table :deep(.ant-table-body) {
  flex: initial;
  min-width: 0;
  min-height: 0;
  max-height: min(52vh, 520px);
  overflow: auto;
}

.admin-panel__table :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  font-size: 12px;
}

.admin-panel__table :deep(.ant-table-tbody > tr > td) {
  padding: 10px 12px;
  vertical-align: top;
}

.account-order-info-packages__cell {
  display: grid;
  gap: 4px;
}

.account-order-info-packages__cell strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.4;
}

.account-order-info-packages__cell small {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.account-order-info-packages__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.account-order-info-packages__pagination-total {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}
</style>
