<script setup lang="ts">
import { computed } from "vue";
import type { AuditLogItem } from "@codeflowai/shared";

import {
  formatAuditActorRole,
  formatAuditOperationType,
  formatAuditOperationTypeTag,
  formatAuditResult,
  formatAuditResultTag,
  formatDateOnly,
  formatTimestamp,
} from "../accountDisplay";

defineOptions({ name: "AuditLogTable" });

const props = withDefaults(defineProps<{
  items: AuditLogItem[];
  loading?: boolean;
  total?: number;
  current?: number;
  pageSize?: number;
  showEnterprise?: boolean;
  showPagination?: boolean;
  deletable?: boolean;
  deletingAuditId?: string | null;
  emptyText?: string;
}>(), {
  loading: false,
  total: 0,
  current: 1,
  pageSize: 10,
  showEnterprise: true,
  showPagination: true,
  deletable: false,
  deletingAuditId: null,
  emptyText: "暂无审计记录",
});

const emit = defineEmits<{
  (e: "page-change", payload: { page: number; pageSize: number }): void;
  (e: "delete", record: AuditLogItem): void;
}>();

const pageSizeOptions = ["10", "20", "50", "100"];

const scrollX = computed(() => {
  const base = props.showEnterprise ? 1600 : 1440;
  return props.deletable ? base + 96 : base;
});

type PackageAuditSnapshot = {
  expiresAt: number | null;
  personMonths: number | null;
};

type PackageAuditRow = {
  label: string;
  value: string;
};

const PACKAGE_ADJUSTMENT_ACTIONS = new Set([
  "package.adjusted",
  "package.batch_adjusted",
  "package.admin_adjusted",
  "package.admin_personal_updated",
  "package.admin_enterprise_admin_updated",
]);

/** Identify package adjustment audit rows before applying package-specific rendering. */
function isPackageAdjustmentRecord(record: AuditLogItem): boolean {
  return record.operationType === "package_adjustment" || PACKAGE_ADJUSTMENT_ACTIONS.has(record.action);
}

/** Narrow unknown audit detail values to plain objects for legacy detail compatibility. */
function toPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Read a finite numeric field without coercing invalid values to zero. */
function readNumberField(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Read a nested detail object while preserving null for missing old-log fields. */
function readRecordField(source: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return toPlainRecord(source?.[key]);
}

/** Extract the current person-month count from legacy before/after package details. */
function resolvePackagePersonMonths(data: Record<string, unknown> | null): number | null {
  const allocation = readRecordField(data, "allocation");
  const allocationPersonMonths = readNumberField(allocation, "allocatedPersonMonths");
  if (allocationPersonMonths !== null) return allocationPersonMonths;

  const packageSummary = readRecordField(data, "packageSummary");
  return readNumberField(packageSummary, "allocatedPersonMonths")
    ?? readNumberField(packageSummary, "purchasedPersonMonths");
}

/** Extract package expiry and person-month count from a before/after audit detail block. */
function resolvePackageAuditSnapshot(data: Record<string, unknown> | null): PackageAuditSnapshot {
  const allocation = readRecordField(data, "allocation");
  const packageSummary = readRecordField(data, "packageSummary");
  const enterpriseSummary = readRecordField(data, "enterpriseSummary");
  return {
    expiresAt: readNumberField(allocation, "expiresAt")
      ?? readNumberField(packageSummary, "expiresAt")
      ?? readNumberField(enterpriseSummary, "expiresAt"),
    personMonths: resolvePackagePersonMonths(data),
  };
}

/** Format person-month values with the unit used by package operations. */
function formatPersonMonths(value: number | null): string {
  return value === null ? "-" : `${value} 人月`;
}

/** Read explicit added person-months from metadata before falling back to before/after diff. */
function resolveAddedPersonMonths(record: AuditLogItem, before: PackageAuditSnapshot, after: PackageAuditSnapshot): number | null {
  const metadata = record.metadata;
  const giftPersonMonths = readNumberField(metadata, "giftPersonMonths");
  if (giftPersonMonths !== null) return giftPersonMonths;

  const batchPersonMonths = readNumberField(metadata, "personMonths");
  if (batchPersonMonths !== null) {
    return metadata?.action === "decrease" ? -batchPersonMonths : batchPersonMonths;
  }

  if (before.personMonths !== null && after.personMonths !== null) {
    return after.personMonths - before.personMonths;
  }
  if (after.personMonths !== null) return after.personMonths;
  return null;
}

/** Build the package adjustment rows shared by table summary and expanded detail. */
function packageAuditRows(record: AuditLogItem): PackageAuditRow[] {
  if (!isPackageAdjustmentRecord(record)) return [];
  const before = resolvePackageAuditSnapshot(record.beforeData);
  const after = resolvePackageAuditSnapshot(record.afterData);
  const addedPersonMonths = resolveAddedPersonMonths(record, before, after);
  if (before.expiresAt === null && addedPersonMonths === null && after.expiresAt === null) {
    return [];
  }
  return [
    { label: "原到期日期", value: formatDateOnly(before.expiresAt) },
    { label: "增加人月数", value: formatPersonMonths(addedPersonMonths) },
    { label: "调整后到期日期", value: formatDateOnly(after.expiresAt) },
  ];
}

/** Render package adjustment summaries as explicit fields; other rows keep their original summary. */
function formatAuditSummary(record: AuditLogItem): string {
  const rows = packageAuditRows(record);
  if (!rows.length) return record.summary || record.actionLabel || record.action;
  return rows.map((item) => `${item.label}：${item.value}`).join("\n");
}

function hasDetail(record: AuditLogItem): boolean {
  return [record.beforeData, record.afterData, record.metadata].some((item) => Boolean(item && Object.keys(item).length));
}

function detailCount(data: Record<string, unknown> | null): number {
  return data ? Object.keys(data).length : 0;
}

function stringifyDetail(data: Record<string, unknown> | null): string {
  if (!data || !Object.keys(data).length) return "无";
  return JSON.stringify(data, null, 2);
}

function formatActorTitle(record: AuditLogItem): string {
  return record.actor.fullName || record.actor.email || record.actor.userId || "系统";
}

function formatActorSubtitle(record: AuditLogItem): string {
  const parts = [formatAuditActorRole(record.actor.role)];
  if (record.actor.email) {
    parts.push(record.actor.email);
  } else if (record.actor.userId) {
    parts.push(record.actor.userId);
  }
  return parts.join(" / ");
}

function formatTargetType(type: string | null | undefined): string {
  if (type === "user") return "用户";
  if (type === "enterprise") return "企业";
  return type?.trim() || "对象";
}

function formatTargetTitle(record: AuditLogItem): string {
  return record.target.label || record.target.fullName || record.target.email || record.target.enterpriseName || record.target.id;
}

function formatTargetSubtitle(record: AuditLogItem): string {
  const parts = [formatTargetType(record.target.type)];
  if (record.target.email) {
    parts.push(record.target.email);
  } else if (record.target.enterpriseId) {
    parts.push(record.target.enterpriseId);
  } else if (record.target.userId) {
    parts.push(record.target.userId);
  } else if (record.target.id) {
    parts.push(record.target.id);
  }
  return parts.join(" / ");
}

function formatEnterpriseTitle(record: AuditLogItem): string {
  return record.enterprise.name || record.enterprise.enterpriseId || "-";
}

function formatEnterpriseSubtitle(record: AuditLogItem): string {
  return record.enterprise.enterpriseId || "-";
}

function handlePaginationChange(page: number, pageSize: number) {
  emit("page-change", { page, pageSize });
}

function handlePageSizeChange(_: number, pageSize: number) {
  emit("page-change", { page: 1, pageSize });
}

/** 通知父组件删除指定审计记录；实际权限和刷新由父级处理。 */
function handleDelete(record: AuditLogItem) {
  emit("delete", record);
}
</script>

<template>
  <div class="audit-log-table">
    <a-table
      class="audit-log-table__table"
      :data-source="items"
      :loading="loading"
      :pagination="false"
      size="small"
      row-key="auditId"
      :scroll="{ x: scrollX, y: '100%' }"
      :expandable="{ rowExpandable: hasDetail }"
    >
      <template #emptyText>
        <a-empty :description="emptyText" />
      </template>

      <template #expandedRowRender="{ record }">
        <div v-if="packageAuditRows(record).length" class="audit-log-table__package-detail">
          <article class="audit-log-table__detail-card audit-log-table__package-card">
            <header>
              <strong>套餐调整摘要</strong>
              <span>关键字段</span>
            </header>
            <div class="audit-log-table__package-grid">
              <div v-for="item in packageAuditRows(record)" :key="item.label" class="audit-log-table__package-item">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
            </div>
          </article>
        </div>
        <div v-else class="audit-log-table__expanded">
          <article class="audit-log-table__detail-card">
            <header>
              <strong>变更前</strong>
              <span>{{ detailCount(record.beforeData) ? `${detailCount(record.beforeData)} 个字段` : "无数据" }}</span>
            </header>
            <pre>{{ stringifyDetail(record.beforeData) }}</pre>
          </article>
          <article class="audit-log-table__detail-card">
            <header>
              <strong>变更后</strong>
              <span>{{ detailCount(record.afterData) ? `${detailCount(record.afterData)} 个字段` : "无数据" }}</span>
            </header>
            <pre>{{ stringifyDetail(record.afterData) }}</pre>
          </article>
          <article class="audit-log-table__detail-card audit-log-table__detail-card--meta">
            <header>
              <strong>补充信息</strong>
              <span>{{ detailCount(record.metadata) ? `${detailCount(record.metadata)} 项` : "无数据" }}</span>
            </header>
            <pre>{{ stringifyDetail(record.metadata) }}</pre>
          </article>
        </div>
      </template>

      <a-table-column title="操作时间" :width="180">
        <template #default="{ record }">{{ formatTimestamp(record.createdAt) }}</template>
      </a-table-column>

      <a-table-column title="操作类型" :width="140">
        <template #default="{ record }">
          <a-tag :color="formatAuditOperationTypeTag(record.operationType)" :bordered="false">
            {{ formatAuditOperationType(record.operationType) }}
          </a-tag>
        </template>
      </a-table-column>

      <a-table-column title="操作动作" :width="220">
        <template #default="{ record }">
          <div class="audit-log-table__stack">
            <strong>{{ record.actionLabel || record.action }}</strong>
            <span>{{ record.action }}</span>
          </div>
        </template>
      </a-table-column>

      <a-table-column title="执行结果" :width="100">
        <template #default="{ record }">
          <a-tag :color="formatAuditResultTag(record.result)" :bordered="false">
            {{ formatAuditResult(record.result) }}
          </a-tag>
        </template>
      </a-table-column>

      <a-table-column title="操作用户" :width="220">
        <template #default="{ record }">
          <div class="audit-log-table__stack">
            <strong>{{ formatActorTitle(record) }}</strong>
            <span>{{ formatActorSubtitle(record) }}</span>
          </div>
        </template>
      </a-table-column>

      <a-table-column title="被操作对象" :width="240">
        <template #default="{ record }">
          <div class="audit-log-table__stack">
            <strong>{{ formatTargetTitle(record) }}</strong>
            <span>{{ formatTargetSubtitle(record) }}</span>
          </div>
        </template>
      </a-table-column>

      <a-table-column v-if="showEnterprise" title="所属企业" :width="220">
        <template #default="{ record }">
          <div class="audit-log-table__stack">
            <strong>{{ formatEnterpriseTitle(record) }}</strong>
            <span>{{ formatEnterpriseSubtitle(record) }}</span>
          </div>
        </template>
      </a-table-column>

      <a-table-column title="变更摘要" :width="360">
        <template #default="{ record }">
          <div class="audit-log-table__summary">{{ formatAuditSummary(record) }}</div>
        </template>
      </a-table-column>

      <a-table-column v-if="deletable" title="操作" :width="96" fixed="right">
        <template #default="{ record }">
          <a-popconfirm
            title="确认删除这条审计记录？"
            ok-text="删除"
            cancel-text="取消"
            placement="left"
            @confirm="handleDelete(record)"
          >
            <a-button danger size="small" :loading="deletingAuditId === record.auditId">删除</a-button>
          </a-popconfirm>
        </template>
      </a-table-column>
    </a-table>

    <div class="audit-log-table__mobile-list">
      <a-spin :spinning="loading">
        <article v-for="record in items" :key="record.auditId" class="audit-log-table__mobile-card">
          <header>
            <div>
              <strong>{{ record.actionLabel || record.action }}</strong>
              <span>{{ formatTimestamp(record.createdAt) }}</span>
            </div>
            <a-tag :color="formatAuditResultTag(record.result)" :bordered="false">
              {{ formatAuditResult(record.result) }}
            </a-tag>
          </header>
          <div class="audit-log-table__mobile-tags">
            <a-tag :color="formatAuditOperationTypeTag(record.operationType)" :bordered="false">
              {{ formatAuditOperationType(record.operationType) }}
            </a-tag>
            <span>{{ record.action }}</span>
          </div>
          <dl>
            <div><dt>操作用户</dt><dd>{{ formatActorTitle(record) }}<small>{{ formatActorSubtitle(record) }}</small></dd></div>
            <div><dt>操作对象</dt><dd>{{ formatTargetTitle(record) }}<small>{{ formatTargetSubtitle(record) }}</small></dd></div>
            <div v-if="showEnterprise"><dt>所属企业</dt><dd>{{ formatEnterpriseTitle(record) }}<small>{{ formatEnterpriseSubtitle(record) }}</small></dd></div>
          </dl>
          <p>{{ formatAuditSummary(record) }}</p>
          <details v-if="hasDetail(record)">
            <summary>查看变更详情</summary>
            <div v-if="packageAuditRows(record).length" class="audit-log-table__mobile-detail-grid">
              <div v-for="item in packageAuditRows(record)" :key="item.label"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div>
            </div>
            <div v-else class="audit-log-table__mobile-detail-json">
              <div><strong>变更前</strong><pre>{{ stringifyDetail(record.beforeData) }}</pre></div>
              <div><strong>变更后</strong><pre>{{ stringifyDetail(record.afterData) }}</pre></div>
              <div><strong>补充信息</strong><pre>{{ stringifyDetail(record.metadata) }}</pre></div>
            </div>
          </details>
          <a-popconfirm
            v-if="deletable"
            title="确认删除这条审计记录？"
            ok-text="删除"
            cancel-text="取消"
            @confirm="handleDelete(record)"
          >
            <a-button danger block :loading="deletingAuditId === record.auditId">删除记录</a-button>
          </a-popconfirm>
        </article>
        <a-empty v-if="!loading && items.length === 0" :description="emptyText" />
      </a-spin>
    </div>

    <div v-if="showPagination" class="audit-log-table__pagination">
      <div class="audit-log-table__pagination-total">共 {{ total }} 条记录</div>
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
  </div>
</template>

<style scoped>
/* 表格行使用 1fr 撑满；含分页时分页固定底部 */
.audit-log-table {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-auto-rows: auto;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 14px;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

/* 表格 body 独立滚动，避免大 pageSize 撑开面板导致分页器不可达。 */
.audit-log-table__table {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.audit-log-table__mobile-list {
  display: none;
  min-height: 0;
  overflow-y: auto;
}

.audit-log-table__mobile-list :deep(.ant-spin-nested-loading),
.audit-log-table__mobile-list :deep(.ant-spin-container) {
  min-height: 100%;
}

.audit-log-table__mobile-card {
  display: grid;
  gap: 11px;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel-bg);
  box-shadow: 0 8px 20px rgba(20, 20, 19, 0.045);
}

.audit-log-table__mobile-card + .audit-log-table__mobile-card {
  margin-top: 10px;
}

.audit-log-table__mobile-card header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.audit-log-table__mobile-card header strong,
.audit-log-table__mobile-card header span {
  display: block;
}

.audit-log-table__mobile-card header strong {
  color: var(--app-text);
  font-size: 14px;
}

.audit-log-table__mobile-card header span,
.audit-log-table__mobile-tags span,
.audit-log-table__mobile-card dt,
.audit-log-table__mobile-card dd small,
.audit-log-table__mobile-detail-grid span {
  color: var(--app-muted);
  font-size: 11px;
}

.audit-log-table__mobile-card header span {
  margin-top: 3px;
}

.audit-log-table__mobile-tags {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.audit-log-table__mobile-tags span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-log-table__mobile-card dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
  margin: 0;
}

.audit-log-table__mobile-card dl > div {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 9px 10px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-bg) 72%, var(--app-panel-bg));
}

.audit-log-table__mobile-card dd {
  margin: 0;
  overflow: hidden;
  color: var(--app-text);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-log-table__mobile-card dd small {
  display: block;
  overflow: hidden;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audit-log-table__mobile-card > p {
  margin: 0;
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
}

.audit-log-table__mobile-card details {
  border-top: 1px solid var(--app-divider);
  padding-top: 10px;
}

.audit-log-table__mobile-card summary {
  min-height: 40px;
  display: flex;
  align-items: center;
  color: var(--app-accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.audit-log-table__mobile-detail-grid,
.audit-log-table__mobile-detail-json {
  display: grid;
  gap: 8px;
}

.audit-log-table__mobile-detail-grid > div,
.audit-log-table__mobile-detail-json > div {
  display: grid;
  gap: 3px;
  padding: 9px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-bg) 72%, var(--app-panel-bg));
}

.audit-log-table__mobile-detail-json pre {
  max-height: 180px;
  margin: 0;
  overflow: auto;
  color: var(--app-text);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.audit-log-table__table :deep(.ant-spin-nested-loading),
.audit-log-table__table :deep(.ant-spin-container),
.audit-log-table__table :deep(.ant-table),
.audit-log-table__table :deep(.ant-table-container) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
}

.audit-log-table__table :deep(.ant-table-content) {
  flex: 1;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  overflow: auto;
}

.audit-log-table__table :deep(.ant-table-header) {
  flex: 0 0 auto;
}

.audit-log-table__table :deep(.ant-table-body) {
  flex: 1;
  min-height: 0;
  overflow: auto !important;
}

.audit-log-table__table :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  height: 38px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  vertical-align: middle;
}

.audit-log-table__table :deep(.ant-table-tbody > tr > td) {
  padding: 9px 12px;
  font-size: 12px;
  line-height: 1.3;
}

.audit-log-table__table :deep(.ant-tag) {
  margin-inline-end: 0;
}

.audit-log-table__stack {
  display: grid;
  gap: 2px;
}

.audit-log-table__stack strong {
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.3;
}

.audit-log-table__stack span {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.25;
  word-break: break-word;
}

.audit-log-table__summary {
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
}

.audit-log-table__expanded {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.audit-log-table__package-detail {
  display: grid;
  grid-template-columns: minmax(0, 720px);
}

.audit-log-table__package-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.audit-log-table__package-item {
  display: grid;
  gap: 4px;
  padding: 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 4%, var(--app-bg));
}

.audit-log-table__package-item span {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.25;
}

.audit-log-table__package-item strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.3;
}

.audit-log-table__detail-card {
  display: grid;
  gap: 10px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 96%, #ffffff);
}

.audit-log-table__detail-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.audit-log-table__detail-card strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.3;
}

.audit-log-table__detail-card span {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.25;
}

.audit-log-table__detail-card pre {
  margin: 0;
  padding: 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 4%, var(--app-bg));
  color: var(--app-text);
  font-size: 11px;
  line-height: 1.45;
  overflow: auto;
  max-height: 320px;
  white-space: pre-wrap;
  word-break: break-word;
}

.audit-log-table__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.audit-log-table__pagination-total {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}

@media (max-width: 767px) {
  .audit-log-table__table {
    display: none;
  }

  .audit-log-table__mobile-list {
    display: block;
  }

  .audit-log-table__package-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .audit-log-table__expanded {
    grid-template-columns: 1fr;
  }

  .audit-log-table__pagination {
    align-items: stretch;
  }
}
</style>
