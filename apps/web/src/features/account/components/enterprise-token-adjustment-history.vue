<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { EyeOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type {
  RelayEnterpriseQuotaAdjustmentRecordItem,
  RelayEnterpriseQuotaAdjustmentRecordStatusFilter,
  RelayMemberQuotaAdjustType,
  RelayMemberQuotaOperationStatus,
} from "@codeflowai/shared";

import { listEnterpriseRelayQuotaAdjustmentRecords } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";
import { formatRelayUsdUnitsAsYuan } from "../relayUsdUnits";

defineOptions({ name: "EnterpriseTokenAdjustmentHistory" });

const props = defineProps<{
  enterpriseId?: string | null;
}>();

type HistoryRange = "7" | "30" | "90" | "all";

const { ctx } = useApiContext();
const records = ref<RelayEnterpriseQuotaAdjustmentRecordItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loadError = ref("");
const detailOpen = ref(false);
const selectedRecord = ref<RelayEnterpriseQuotaAdjustmentRecordItem | null>(null);
const paging = reactive({ current: 1, pageSize: 20, pageSizeOptions: ["10", "20", "50", "100"] });
const filters = reactive({
  search: "",
  adjustType: "" as RelayMemberQuotaAdjustType | "",
  status: "" as RelayEnterpriseQuotaAdjustmentRecordStatusFilter | "",
  range: "30" as HistoryRange,
});
let requestRevision = 0;
let requestController: AbortController | null = null;

const adjustTypeOptions = [
  { label: "全部类型", value: "" },
  { label: "增加", value: "INCREASE" },
  { label: "回收", value: "RECLAIM" },
];
const statusOptions = [
  { label: "全部状态", value: "" },
  { label: "处理中", value: "PROCESSING" },
  { label: "成功", value: "SUCCEEDED" },
  { label: "已拒绝", value: "REJECTED" },
  { label: "结果待确认", value: "RESULT_UNKNOWN" },
];
const rangeOptions = [
  { label: "最近 7 天", value: "7" },
  { label: "最近 30 天", value: "30" },
  { label: "最近 90 天", value: "90" },
  { label: "全部时间", value: "all" },
];

/** 格式化精确额度；尚未产生最终账本时保持占位。 */
function formatQuota(value: string | null): string {
  return value === null ? "-" : formatRelayUsdUnitsAsYuan(value);
}

/** 显示带方向的调整金额。 */
function formatSignedAmount(record: RelayEnterpriseQuotaAdjustmentRecordItem): string {
  const prefix = record.adjustType === "INCREASE" ? "+" : "-";
  return `${prefix}${formatRelayUsdUnitsAsYuan(record.amountUsdUnits)}`;
}

/** 使用明确中文格式显示操作时间。 */
function formatDateTime(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** 映射操作状态为可读标签。 */
function statusMeta(status: RelayMemberQuotaOperationStatus): { color: string; text: string } {
  if (status === "SUCCEEDED") return { color: "success", text: "成功" };
  if (status === "REJECTED") return { color: "error", text: "已拒绝" };
  if (status === "RESULT_UNKNOWN") return { color: "error", text: "结果待确认" };
  if (status === "RECONCILING") return { color: "warning", text: "对账中" };
  return { color: "processing", text: "处理中" };
}

/** 区分管理员操作与生命周期自动回收来源。 */
function operationSourceLabel(record: RelayEnterpriseQuotaAdjustmentRecordItem): string {
  return ({
    ENTERPRISE_ALLOCATION: "首次分配",
    ENTERPRISE_INCREASE: "增加额度",
    ADMIN_RECLAIM: "管理员回收",
    MEMBERSHIP_RECLAIM: "成员离企回收",
    EXPIRY_RECLAIM: "额度到期回收",
    ACCOUNT_REVOKE: "账号失权回收",
    ENTERPRISE_REVOKE: "企业失权回收",
  } as Record<string, string>)[record.operationType] ?? (record.adjustType === "INCREASE" ? "增加额度" : "回收额度");
}

/** 主表优先展示成员邮箱，详情再补充姓名或用户 ID。 */
function memberDisplay(record: RelayEnterpriseQuotaAdjustmentRecordItem): { primary: string; secondary: string } {
  const primary = record.memberEmail || record.memberFullName || record.memberUserId || "未知成员";
  const secondary = record.memberFullName && record.memberFullName !== primary
    ? record.memberFullName
    : record.memberUserId && record.memberUserId !== primary
      ? record.memberUserId
      : "-";
  return {
    primary,
    secondary,
  };
}

/** 返回操作人主展示和次级标识。 */
function actorDisplay(record: RelayEnterpriseQuotaAdjustmentRecordItem): { primary: string; secondary: string } {
  return {
    primary: record.actorFullName || record.actorEmail || record.actorUserId || "系统任务",
    secondary: record.actorEmail || record.actorUserId || "",
  };
}

/** 根据预设范围构造服务端闭区间时间筛选。 */
function resolveTimeRange(): { createdFrom?: number; createdTo?: number } {
  if (filters.range === "all") return {};
  const createdTo = Date.now();
  return {
    createdFrom: createdTo - Number(filters.range) * 24 * 60 * 60 * 1000,
    createdTo,
  };
}

/** 取消当前记录请求，避免企业切换后旧响应覆盖新作用域。 */
function cancelRequest(): void {
  requestController?.abort();
  requestController = null;
}

/** 按当前企业、筛选和分页读取分配与回收记录。 */
async function refresh(): Promise<void> {
  const enterpriseId = String(props.enterpriseId ?? "").trim();
  const revision = ++requestRevision;
  cancelRequest();
  if (!enterpriseId) {
    records.value = [];
    total.value = 0;
    loadError.value = "";
    return;
  }
  const controller = new AbortController();
  requestController = controller;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await listEnterpriseRelayQuotaAdjustmentRecords(ctx.value, {
      enterpriseId,
      search: filters.search.trim() || undefined,
      adjustType: filters.adjustType || undefined,
      status: filters.status || undefined,
      ...resolveTimeRange(),
      offset: (paging.current - 1) * paging.pageSize,
      limit: paging.pageSize,
    }, { signal: controller.signal });
    if (revision !== requestRevision) return;
    if (!result.ok) throw new Error(result.message || "分配与回收记录加载失败");
    records.value = result.items;
    total.value = result.total;
  } catch (error) {
    if (revision !== requestRevision) return;
    records.value = [];
    total.value = 0;
    loadError.value = error instanceof Error ? error.message : "分配与回收记录加载失败";
  } finally {
    if (revision === requestRevision) {
      loading.value = false;
      requestController = null;
    }
  }
}

/** 应用筛选并回到第一页。 */
async function applyFilters(): Promise<void> {
  paging.current = 1;
  await refresh();
}

/** 重置为默认最近 30 天口径并重新读取。 */
async function resetFilters(): Promise<void> {
  filters.search = "";
  filters.adjustType = "";
  filters.status = "";
  filters.range = "30";
  paging.current = 1;
  await refresh();
}

/** 翻页或调整每页条数后读取对应记录。 */
async function handlePageChange(page: number, pageSize: number): Promise<void> {
  const sizeChanged = pageSize !== paging.pageSize;
  paging.current = sizeChanged ? 1 : page;
  paging.pageSize = pageSize;
  await refresh();
}

/** 打开记录详情并固定当前快照。 */
function openDetail(record: RelayEnterpriseQuotaAdjustmentRecordItem): void {
  selectedRecord.value = record;
  detailOpen.value = true;
}

defineExpose({ refresh });

onMounted(() => void refresh());
onUnmounted(() => {
  requestRevision += 1;
  cancelRequest();
});
watch(() => props.enterpriseId, () => {
  requestRevision += 1;
  cancelRequest();
  records.value = [];
  total.value = 0;
  paging.current = 1;
  detailOpen.value = false;
  selectedRecord.value = null;
  void refresh();
});
</script>

<template>
  <section class="enterprise-token-history" aria-label="分配与回收记录">
    <div class="enterprise-token-history__toolbar">
      <a-input
        v-model:value="filters.search"
        class="enterprise-token-history__search"
        allow-clear
        placeholder="搜索成员姓名或邮箱"
        @press-enter="applyFilters"
      />
      <a-select v-model:value="filters.adjustType" :options="adjustTypeOptions" aria-label="操作类型" />
      <a-select v-model:value="filters.status" :options="statusOptions" aria-label="操作状态" />
      <a-select v-model:value="filters.range" :options="rangeOptions" aria-label="时间范围" />
      <a-button type="primary" :loading="loading" @click="applyFilters">
        <template #icon><SearchOutlined /></template>
        查询
      </a-button>
      <a-button :disabled="loading" @click="resetFilters">重置</a-button>
    </div>

    <a-alert v-if="loadError" type="error" show-icon message="分配与回收记录加载失败" :description="loadError">
      <template #action><a-button size="small" :loading="loading" @click="refresh">重试</a-button></template>
    </a-alert>

    <a-table
      v-if="!loadError"
      class="enterprise-token-history__table"
      :data-source="records"
      :loading="{ spinning: loading, tip: '记录加载中...' }"
      :pagination="false"
      row-key="operationId"
      size="small"
      :scroll="{ x: 1000 }"
    >
      <a-table-column title="操作时间" :width="160">
        <template #default="{ record }">{{ formatDateTime(record.startedAt) }}</template>
      </a-table-column>
      <a-table-column title="成员" :width="220">
        <template #default="{ record }">
          <div class="enterprise-token-history__identity">
            <strong>{{ memberDisplay(record).primary }}</strong>
          </div>
        </template>
      </a-table-column>
      <a-table-column title="类型" :width="96">
        <template #default="{ record }">
          <a-tag :color="record.adjustType === 'INCREASE' ? 'green' : 'orange'">
            {{ record.adjustType === "INCREASE" ? "增加" : "回收" }}
          </a-tag>
        </template>
      </a-table-column>
      <a-table-column title="变动额度" :width="130">
        <template #default="{ record }">
          <strong :class="['enterprise-token-history__amount', `is-${record.adjustType.toLowerCase()}`]">
            {{ formatSignedAmount(record) }}
          </strong>
        </template>
      </a-table-column>
      <a-table-column title="调整前" :width="120">
        <template #default="{ record }">{{ formatQuota(record.memberBeforeUsdUnits) }}</template>
      </a-table-column>
      <a-table-column title="调整后" :width="120">
        <template #default="{ record }">{{ formatQuota(record.memberAfterUsdUnits) }}</template>
      </a-table-column>
      <a-table-column title="状态" :width="96">
        <template #default="{ record }">
          <a-tag :color="statusMeta(record.operationStatus).color">{{ statusMeta(record.operationStatus).text }}</a-tag>
        </template>
      </a-table-column>
      <a-table-column title="详情" :width="64" fixed="right">
        <template #default="{ record }">
          <a-tooltip title="查看操作详情">
            <a-button type="text" size="small" aria-label="查看操作详情" @click="openDetail(record)">
              <template #icon><EyeOutlined /></template>
            </a-button>
          </a-tooltip>
        </template>
      </a-table-column>
      <template #emptyText>
        <div v-if="loading" class="enterprise-token-history__table-loading-placeholder" aria-hidden="true" />
        <a-empty v-else description="暂无分配或回收记录" />
      </template>
    </a-table>

    <div v-if="!loadError" class="enterprise-token-history__mobile-list">
      <div v-if="loading" class="enterprise-token-history__mobile-loading" role="status">
        <a-spin />
        <span>记录加载中...</span>
      </div>
      <template v-else>
        <button
          v-for="record in records"
          :key="record.operationId"
          type="button"
          class="enterprise-token-history__mobile-item"
          @click="openDetail(record)"
        >
          <span class="enterprise-token-history__mobile-head">
            <span class="enterprise-token-history__identity">
              <strong>{{ memberDisplay(record).primary }}</strong>
            </span>
            <a-tag :color="record.adjustType === 'INCREASE' ? 'green' : 'orange'">
              {{ record.adjustType === "INCREASE" ? "增加" : "回收" }}
            </a-tag>
          </span>
          <span class="enterprise-token-history__mobile-amount-row">
            <strong :class="['enterprise-token-history__amount', `is-${record.adjustType.toLowerCase()}`]">
              {{ formatSignedAmount(record) }}
            </strong>
            <a-tag :color="statusMeta(record.operationStatus).color">{{ statusMeta(record.operationStatus).text }}</a-tag>
          </span>
          <span class="enterprise-token-history__mobile-balance">
            调整前 {{ formatQuota(record.memberBeforeUsdUnits) }} → 调整后 {{ formatQuota(record.memberAfterUsdUnits) }}
          </span>
          <span class="enterprise-token-history__mobile-meta">
            {{ formatDateTime(record.startedAt) }}
          </span>
        </button>
        <a-empty v-if="records.length === 0" description="暂无分配或回收记录" />
      </template>
    </div>

    <div v-if="!loadError" class="enterprise-token-history__pagination">
      <span>共 {{ total }} 条记录</span>
      <a-pagination
        :current="paging.current"
        :page-size="paging.pageSize"
        :total="total"
        :show-size-changer="true"
        :page-size-options="paging.pageSizeOptions"
        size="small"
        @change="handlePageChange"
        @show-size-change="handlePageChange"
      />
    </div>

    <a-drawer v-model:open="detailOpen" title="操作详情" width="min(440px, 100vw)" destroy-on-close>
      <a-descriptions v-if="selectedRecord" :column="1" size="small" bordered>
        <a-descriptions-item label="状态">
          <a-tag :color="statusMeta(selectedRecord.operationStatus).color">
            {{ statusMeta(selectedRecord.operationStatus).text }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="操作类型">{{ operationSourceLabel(selectedRecord) }}</a-descriptions-item>
        <a-descriptions-item label="成员">
          <div class="enterprise-token-history__identity">
            <strong>{{ memberDisplay(selectedRecord).primary }}</strong>
            <span>{{ memberDisplay(selectedRecord).secondary }}</span>
          </div>
        </a-descriptions-item>
        <a-descriptions-item label="变动额度">{{ formatSignedAmount(selectedRecord) }}</a-descriptions-item>
        <a-descriptions-item label="调整前额度">{{ formatQuota(selectedRecord.memberBeforeUsdUnits) }}</a-descriptions-item>
        <a-descriptions-item label="调整后额度">{{ formatQuota(selectedRecord.memberAfterUsdUnits) }}</a-descriptions-item>
        <a-descriptions-item label="操作人">
          {{ actorDisplay(selectedRecord).primary }}
          <span v-if="actorDisplay(selectedRecord).secondary">（{{ actorDisplay(selectedRecord).secondary }}）</span>
        </a-descriptions-item>
        <a-descriptions-item label="操作时间">{{ formatDateTime(selectedRecord.startedAt) }}</a-descriptions-item>
        <a-descriptions-item label="备注">{{ selectedRecord.note || "-" }}</a-descriptions-item>
        <a-descriptions-item label="操作 ID">
          <a-typography-text copyable>{{ selectedRecord.operationId }}</a-typography-text>
        </a-descriptions-item>
        <a-descriptions-item label="请求 ID">
          <a-typography-text v-if="selectedRecord.requestId" copyable>{{ selectedRecord.requestId }}</a-typography-text>
          <span v-else>-</span>
        </a-descriptions-item>
        <a-descriptions-item v-if="selectedRecord.publicMessage" label="处理结果">
          {{ selectedRecord.publicMessage }}
        </a-descriptions-item>
      </a-descriptions>
    </a-drawer>
  </section>
</template>

<style scoped>
.enterprise-token-history {
  display: grid;
  gap: 14px;
  min-width: 0;
}

.enterprise-token-history__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.enterprise-token-history__toolbar :deep(.ant-select) {
  width: 136px;
}

.enterprise-token-history__search {
  flex: 1 1 220px;
  max-width: 360px;
}

.enterprise-token-history__table-loading-placeholder {
  min-height: 176px;
}

.enterprise-token-history__table :deep(.ant-table-thead > tr > th) {
  padding: 8px 10px;
  white-space: nowrap;
}

.enterprise-token-history__table :deep(.ant-table-tbody > tr > td) {
  padding: 6px 10px;
  vertical-align: middle;
  white-space: nowrap;
}

.enterprise-token-history__table :deep(.ant-tag) {
  margin-inline-end: 0;
}

.enterprise-token-history__mobile-loading {
  display: grid;
  min-height: 220px;
  place-content: center;
  justify-items: center;
  gap: 12px;
  color: var(--app-muted);
}

.enterprise-token-history__identity {
  display: grid;
  min-width: 0;
}

.enterprise-token-history__identity strong,
.enterprise-token-history__identity span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-token-history__identity span,
.enterprise-token-history__mobile-meta,
.enterprise-token-history__mobile-balance,
.enterprise-token-history__pagination {
  color: var(--app-muted);
  font-size: 12px;
}

.enterprise-token-history__amount.is-increase {
  color: var(--app-success);
}

.enterprise-token-history__amount.is-reclaim {
  color: var(--app-danger);
}

.enterprise-token-history__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.enterprise-token-history__mobile-list {
  display: none;
}

@media (max-width: 767px) {
  .enterprise-token-history__toolbar {
    align-items: stretch;
  }

  .enterprise-token-history__search,
  .enterprise-token-history__toolbar :deep(.ant-select) {
    flex: 1 1 calc(50% - 4px);
    width: auto;
    max-width: none;
  }

  .enterprise-token-history__toolbar :deep(.ant-btn) {
    flex: 1 1 auto;
  }

  .enterprise-token-history__table {
    display: none;
  }

  .enterprise-token-history__mobile-list {
    display: grid;
    gap: 10px;
  }

  .enterprise-token-history__mobile-item {
    display: grid;
    gap: 8px;
    width: 100%;
    padding: 12px;
    border: 1px solid var(--app-border);
    border-radius: 8px;
    background: var(--app-panel-bg);
    color: var(--app-text);
    text-align: left;
  }

  .enterprise-token-history__mobile-head,
  .enterprise-token-history__mobile-amount-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .enterprise-token-history__pagination {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
