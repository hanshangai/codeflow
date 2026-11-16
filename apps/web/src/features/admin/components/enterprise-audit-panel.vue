<script setup lang="ts">
import { computed, onMounted, reactive } from "vue";
import { message } from "ant-design-vue";
import type { AuditLogFilters } from "@codeflowai/shared";

import { useAccountStore } from "../../../store/account";
import { useConfigStore } from "../../../store/config";
import { auditOperationTypeOptions, auditResultOptions } from "../../account/accountDisplay";
import AuditLogTable from "../../account/components/audit-log-table.vue";

defineOptions({ name: "EnterpriseAuditPanel" });

const account = useAccountStore();
const config = useConfigStore();

const canExport = computed(() => config.accountRole === "enterprise_admin");

const filters = reactive({
  userKeyword: "",
  operationType: undefined as AuditLogFilters["operationType"],
  result: "",
  dateFrom: "",
  dateTo: "",
});

const paging = reactive({
  current: 1,
  pageSize: 20,
});

/** 日期筛选统一按自然日取整，避免 date 类型只命中当天零点。 */
function resolveDateFilterTimestamp(value: string, endOfDay = false): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parts = normalized.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) return undefined;
  const [year, month, day] = parts;
  const date = endOfDay
    ? new Date(year!, month! - 1, day!, 23, 59, 59, 999)
    : new Date(year!, month! - 1, day!, 0, 0, 0, 0);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** 组装企业审计筛选参数：顶部日期控件按“整天”过滤，列表仍按日期时间展示。 */
function buildFilters(overrides?: Partial<AuditLogFilters>): AuditLogFilters {
  const dateFrom = resolveDateFilterTimestamp(filters.dateFrom);
  const dateTo = resolveDateFilterTimestamp(filters.dateTo, true);
  return {
    userKeyword: filters.userKeyword.trim() || undefined,
    operationType: filters.operationType,
    result: filters.result || undefined,
    dateFrom: Number.isFinite(dateFrom) ? dateFrom : undefined,
    dateTo: Number.isFinite(dateTo) ? dateTo : undefined,
    offset: (paging.current - 1) * paging.pageSize,
    limit: paging.pageSize,
    ...overrides,
  };
}

async function loadAudit(resetPage = true) {
  if (resetPage) {
    paging.current = 1;
  }
  const res = await account.loadEnterpriseAuditLogs(buildFilters());
  if (!res.ok) {
    message.error(res.message || "审计记录加载失败");
  }
}

async function handleExport() {
  const res = await account.exportEnterpriseAuditLogs(buildFilters({ offset: undefined, limit: undefined }));
  if (!res.ok) {
    message.error(res.message || "审计记录导出失败");
    return;
  }
  message.success("审计记录已导出");
}

async function handlePageChange(payload: { page: number; pageSize: number }) {
  paging.current = payload.page;
  paging.pageSize = payload.pageSize;
  await loadAudit(false);
}

onMounted(() => {
  if (!account.enterpriseAuditLogs.length && !account.enterpriseAuditLoading) {
    void loadAudit();
  }
});
</script>

<template>
  <div class="enterprise-audit-panel">
    <div class="enterprise-audit-panel__toolbar">
      <a-input
        v-model:value="filters.userKeyword"
        class="enterprise-audit-panel__search-input enterprise-audit-panel__field enterprise-audit-panel__field--search"
        placeholder="按姓名、邮箱或用户 ID 查询"
        allow-clear
        @press-enter="loadAudit()"
      />
      <a-select v-model:value="filters.operationType" class="enterprise-audit-panel__field enterprise-audit-panel__field--filter" placeholder="操作类型" allow-clear>
        <a-select-option v-for="item in auditOperationTypeOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </a-select-option>
      </a-select>
      <a-select v-model:value="filters.result" class="enterprise-audit-panel__field enterprise-audit-panel__field--filter" placeholder="操作结果" allow-clear>
        <a-select-option v-for="item in auditResultOptions" :key="item.value" :value="item.value">
          {{ item.label }}
        </a-select-option>
      </a-select>
      <a-input v-model:value="filters.dateFrom" class="enterprise-audit-panel__field enterprise-audit-panel__field--date" type="date" />
      <a-input v-model:value="filters.dateTo" class="enterprise-audit-panel__field enterprise-audit-panel__field--date" type="date" />
      <a-space class="enterprise-audit-panel__toolbar-actions" wrap>
        <a-button class="enterprise-audit-panel__toolbar-action" type="primary" :loading="account.enterpriseAuditLoading" @click="loadAudit()">
          查询
        </a-button>
        <a-button
          v-if="canExport"
          class="enterprise-audit-panel__toolbar-action enterprise-audit-panel__toolbar-action--secondary"
          :loading="account.exportingEnterpriseAudit"
          @click="handleExport"
        >
          导出 Excel
        </a-button>
      </a-space>
    </div>

    <AuditLogTable
      :items="account.enterpriseAuditLogs"
      :loading="account.enterpriseAuditLoading"
      :total="account.enterpriseAuditTotal"
      :current="paging.current"
      :page-size="paging.pageSize"
      :show-enterprise="false"
      empty-text="当前企业暂无符合条件的审计记录"
      @page-change="handlePageChange"
    />
  </div>
</template>

<style scoped>
/* 面板根：撑满父容器；AuditLogTable 占 1fr，由其内部撑高 + body 滚动 */
.enterprise-audit-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.enterprise-audit-panel__toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.enterprise-audit-panel__field {
  min-width: 0;
}

.enterprise-audit-panel__field--search {
  flex: 1 1 220px;
  min-width: min(100%, 220px);
}

.enterprise-audit-panel__field--filter {
  flex: 1 1 112px;
  min-width: min(100%, 112px);
}

.enterprise-audit-panel__field--date {
  flex: 1 1 176px;
  min-width: min(100%, 176px);
}

.enterprise-audit-panel__toolbar-actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px 8px;
}

.enterprise-audit-panel__toolbar-action {
  min-width: 72px;
  padding-inline: 12px;
}

.enterprise-audit-panel__toolbar-action--secondary {
  min-width: 84px;
}

@media (max-width: 1280px) {
  .enterprise-audit-panel__toolbar-actions {
    margin-left: 0;
    width: 100%;
    justify-content: flex-start;
  }
}

@media (max-width: 760px) {
  .enterprise-audit-panel__field--search,
  .enterprise-audit-panel__field--filter,
  .enterprise-audit-panel__field--date,
  .enterprise-audit-panel__toolbar-actions {
    flex-basis: 100%;
    min-width: 0;
  }

  .enterprise-audit-panel__toolbar-actions :deep(.ant-btn) {
    flex: 1 1 0;
  }
}
</style>
