<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import {
  DesktopOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  LoginOutlined,
  MessageOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons-vue";
import type {
  AdminSessionInfo,
  AdminStatsKeyDetailItem,
  AdminStatsUsageDetailItem,
  AuditLogItem,
  UsageOverview,
  ApiOk,
  ApiResult,
} from "@codeflowai/shared";

import * as accountApi from "../../../api/account";
import { useConfigStore } from "../../../store/config";
import { useApiContext } from "../../../composables/useApiContext";
import { createApiResultError } from "../../../api/request";
import { createBrowserUuid } from "../../../utils/browserUuid";
import { formatAuditActorRole } from "../../account/accountDisplay";

defineOptions({ name: "AdminSessionsPanel" });

type SessionDetailMode = "activeSessions" | "totalKeys" | "activeKeys" | "todayLogins" | "todayMessages";

const config = useConfigStore();
const { ctx } = useApiContext();
const isMobile = computed(() => typeof window !== "undefined" && window.innerWidth <= 767);
const canKickSession = computed(() => config.accountRole === "enterprise_admin" && !!config.userSummary?.enterpriseId);
const detailMode = ref<SessionDetailMode>("activeSessions");
const sessionPaging = reactive({
  current: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});
const keyPaging = reactive({
  current: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});
const usagePaging = reactive({
  current: 1,
  pageSize: 20,
  pageSizeOptions: ["10", "20", "50", "100"],
});
const enterpriseOverview = ref<UsageOverview | null>(null);
const enterpriseSessions = ref<AdminSessionInfo[]>([]);
const enterpriseSessionsLoading = ref(false);
const keyDetails = ref<AdminStatsKeyDetailItem[]>([]);
const keyDetailsTotal = ref(0);
const keyDetailsLoading = ref(false);
const usageDetails = ref<AdminStatsUsageDetailItem[]>([]);
const usageDetailsTotal = ref(0);
const usageDetailsLoading = ref(false);
const loginAuditDetails = ref<AuditLogItem[]>([]);
const loginAuditTotal = ref(0);
const loginAuditLoading = ref(false);
const overviewCards = [
  { key: "activeSessions", metricKey: "activeSessions", label: "在线会话", icon: DesktopOutlined },
  { key: "totalKeys", metricKey: "totalKeys", label: "总密钥数", icon: KeyOutlined },
  { key: "activeKeys", metricKey: "activeKeys", label: "活跃密钥", icon: ThunderboltOutlined },
  { key: "todayLogins", metricKey: "todayLogins", label: "今日登录", icon: LoginOutlined },
  { key: "todayMessages", metricKey: "todayMessages", label: "今日消息", icon: MessageOutlined },
] as const;

const scopedOverview = enterpriseOverview;
const scopedSessions = enterpriseSessions;
const sessionsLoading = enterpriseSessionsLoading;
const totalSessions = computed(() => scopedSessions.value.length);
const pagedSessions = computed(() => {
  const start = (sessionPaging.current - 1) * sessionPaging.pageSize;
  return scopedSessions.value.slice(start, start + sessionPaging.pageSize);
});
const currentPagination = computed(() => {
  if (detailMode.value === "activeSessions") {
    return {
      current: sessionPaging.current,
      pageSize: sessionPaging.pageSize,
      total: totalSessions.value,
      pageSizeOptions: sessionPaging.pageSizeOptions,
    };
  }
  if (detailMode.value === "totalKeys" || detailMode.value === "activeKeys") {
    return {
      current: keyPaging.current,
      pageSize: keyPaging.pageSize,
      total: keyDetailsTotal.value,
      pageSizeOptions: keyPaging.pageSizeOptions,
    };
  }
  if (detailMode.value === "todayLogins") {
    return {
      current: usagePaging.current,
      pageSize: usagePaging.pageSize,
      total: loginAuditTotal.value,
      pageSizeOptions: usagePaging.pageSizeOptions,
    };
  }
  return {
    current: usagePaging.current,
    pageSize: usagePaging.pageSize,
    total: usageDetailsTotal.value,
    pageSizeOptions: usagePaging.pageSizeOptions,
  };
});
const detailTitle = computed(() => {
  if (detailMode.value === "totalKeys") return "密钥明细";
  if (detailMode.value === "activeKeys") return "活跃密钥明细";
  if (detailMode.value === "todayLogins") return "今日登录明细";
  if (detailMode.value === "todayMessages") return "今日消息明细";
  return "在线会话明细";
});
const detailLoading = computed(() => {
  if (detailMode.value === "activeSessions") return sessionsLoading.value;
  if (detailMode.value === "totalKeys" || detailMode.value === "activeKeys") return keyDetailsLoading.value;
  if (detailMode.value === "todayLogins") return loginAuditLoading.value;
  return usageDetailsLoading.value;
});

onMounted(async () => {
  await loadSessionManagement();
});

/** 在企业会话边界保留可追踪失败，阻止后续刷新与操作。 */
function assertSessionResult<T extends object>(result: ApiResult<T>, action: string): asserts result is ApiOk<T> {
  if (result.ok) return;
  const details = result.details as { requestId?: string } | undefined;
  console.error("[PUBLIC_ENTERPRISE_SESSIONS_FAILED]", {
    code: result.code, requestId: details?.requestId ?? createBrowserUuid(),
    userId: config.userSummary?.userId, enterpriseId: config.userSummary?.enterpriseId,
    action, rootCause: result.message,
  });
  throw createApiResultError(result);
}

/** 会话管理主刷新：刷新总览、会话列表，并按当前卡片刷新对应明细。 */
async function loadSessionManagement(): Promise<void> {
  if (!canKickSession.value) assertSessionResult({ ok: false, code: "FORBIDDEN", message: "企业会话仅允许当前企业管理员访问" }, "access");
  await Promise.all([loadEnterpriseOverview(), loadEnterpriseSessions()]);
  const totalPages = Math.max(1, Math.ceil(totalSessions.value / sessionPaging.pageSize));
  if (sessionPaging.current > totalPages) {
    sessionPaging.current = 1;
  }
  await loadCurrentDetail(false);
}

/** 企业管理员总览走企业作用域接口，避免读到平台全局统计。 */
async function loadEnterpriseOverview(): Promise<void> {
  const result = await accountApi.getEnterpriseSessionOverview(ctx.value);
  assertSessionResult(result, "overview");
  enterpriseOverview.value = result;
}

/** 企业管理员在线会话列表只加载本企业会话，不复用平台 store。 */
async function loadEnterpriseSessions(): Promise<void> {
  enterpriseSessionsLoading.value = true;
  try {
    const result = await accountApi.listEnterpriseSessions(ctx.value);
    assertSessionResult(result, "sessions");
    enterpriseSessions.value = result.sessions;
  } finally {
    enterpriseSessionsLoading.value = false;
  }
}

/** 按当前选中的卡片加载对应明细。 */
async function loadCurrentDetail(resetPage: boolean): Promise<void> {
  if (detailMode.value === "activeSessions") {
    if (resetPage) {
      sessionPaging.current = 1;
    }
    return;
  }
  if (detailMode.value === "totalKeys" || detailMode.value === "activeKeys") {
    if (resetPage) {
      keyPaging.current = 1;
    }
    await loadKeyDetails();
    return;
  }
  if (resetPage) {
    usagePaging.current = 1;
  }
  if (detailMode.value === "todayLogins") {
    await loadLoginAuditDetails();
    return;
  }
  await loadUsageDetails();
}

/** 密钥卡片详情走服务端分页；activeKeys 只取激活密钥。 */
async function loadKeyDetails(): Promise<void> {
  keyDetailsLoading.value = true;
  try {
    const query = {
      activeOnly: detailMode.value === "activeKeys",
      offset: (keyPaging.current - 1) * keyPaging.pageSize,
      limit: keyPaging.pageSize,
    };
    const result = await accountApi.listEnterpriseSessionKeys(ctx.value, query);
    assertSessionResult(result, "keys");
    keyDetails.value = result.items;
    keyDetailsTotal.value = result.total;
  } finally {
    keyDetailsLoading.value = false;
  }
}

/** 登录/消息卡片详情按当天动作日志读取，并保持服务端分页。 */
async function loadLoginAuditDetails(): Promise<void> {
  loginAuditLoading.value = true;
  try {
    const [dateFrom, dateTo] = resolveTodayRange();
    const query = {
      operationType: "authentication" as const,
      result: "success",
      dateFrom,
      dateTo,
      offset: (usagePaging.current - 1) * usagePaging.pageSize,
      limit: usagePaging.pageSize,
    };
    const result = await accountApi.listEnterpriseAuditLogs(ctx.value, query);
    assertSessionResult(result, "audit-logs");
    loginAuditDetails.value = result.items.filter((item) => item.action === "login.succeeded");
    loginAuditTotal.value = result.total;
  } finally {
    loginAuditLoading.value = false;
  }
}

/** 今日消息卡片详情按当天 usage log 读取，并保持服务端分页。 */
async function loadUsageDetails(): Promise<void> {
  usageDetailsLoading.value = true;
  try {
    const [createdFrom, createdTo] = resolveTodayRange();
    const query = {
      action: detailMode.value === "todayLogins" ? "login" : "message",
      createdFrom,
      createdTo,
      offset: (usagePaging.current - 1) * usagePaging.pageSize,
      limit: usagePaging.pageSize,
    };
    const result = await accountApi.listEnterpriseSessionUsageLogs(ctx.value, query);
    assertSessionResult(result, "usage-logs");
    usageDetails.value = result.items;
    usageDetailsTotal.value = result.total;
  } finally {
    usageDetailsLoading.value = false;
  }
}

/** 点击卡片切换明细类型；再次点击同一卡片只做刷新。 */
async function selectDetail(nextMode: SessionDetailMode): Promise<void> {
  const changed = detailMode.value !== nextMode;
  detailMode.value = nextMode;
  await loadCurrentDetail(changed);
}

/** 与会话信息分页规范保持一致：改页大小时回第一页。 */
async function handlePaginationChange(page: number, pageSize: number): Promise<void> {
  if (detailMode.value === "activeSessions") {
    const pageSizeChanged = pageSize !== sessionPaging.pageSize;
    sessionPaging.pageSize = pageSize;
    sessionPaging.current = pageSizeChanged ? 1 : page;
    return;
  }
  if (detailMode.value === "totalKeys" || detailMode.value === "activeKeys") {
    const pageSizeChanged = pageSize !== keyPaging.pageSize;
    keyPaging.pageSize = pageSize;
    keyPaging.current = pageSizeChanged ? 1 : page;
    await loadKeyDetails();
    return;
  }
  const pageSizeChanged = pageSize !== usagePaging.pageSize;
  usagePaging.pageSize = pageSize;
  usagePaging.current = pageSizeChanged ? 1 : page;
  if (detailMode.value === "todayLogins") {
    await loadLoginAuditDetails();
    return;
  }
  await loadUsageDetails();
}

async function handlePageSizeChange(_: number, pageSize: number): Promise<void> {
  await handlePaginationChange(1, pageSize);
}

/** 仅踢出当前企业会话；失败时不再刷新列表。 */
async function handleKick(id: string): Promise<void> {
  if (!canKickSession.value) assertSessionResult({ ok: false, code: "FORBIDDEN", message: "企业会话仅允许当前企业管理员操作" }, "kick");
  const res = await accountApi.kickEnterpriseSession(ctx.value, id);
  assertSessionResult(res, "kick");
  message.success("已踢出会话");
  await loadSessionManagement();
}

function formatTime(ts: number): string {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN");
}

function formatDuration(ts: number): string {
  const dur = Date.now() - ts;
  const minutes = Math.floor(dur / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function formatKeyStatus(active: boolean): string {
  return active ? "启用" : "停用";
}

function sessionKindLabel(record: { sessionKind: string }): string {
  return record.sessionKind === "web" ? "Web 登录" : "Client";
}

/** 会话角色按基础角色和企业归属展示。 */
function formatSessionAccountRole(record: Pick<AdminSessionInfo, "accountRole" | "enterpriseId">): string {
  if (record.accountRole === "super_admin") return "超级管理员";
  if (record.accountRole === "enterprise_admin") return "企业管理员";
  if (record.enterpriseId) return "企业版";
  return "个人用户";
}

/** 今日登录明细按企业归属补齐企业版角色，其余沿用审计角色中文口径。 */
function formatLoginAuditActorRole(record: AuditLogItem): string {
  if (record.actor.role === "enterprise_admin") return "企业管理员";
  if (record.actor.role === "super_admin") return "超级管理员";
  if (record.enterprise.enterpriseId) return "企业版";
  return formatAuditActorRole(record.actor.role);
}

/** 会话管理里的客户端版本展示：有值显示版本，否则统一显示未知版本。 */
function formatSessionClientVersion(record: Pick<AdminSessionInfo, "clientVersion">): string {
  return record.clientVersion || "未知版本";
}

/** 未知版本原因提示：区分 client 未上报、web 未绑定工作区、web 无法唯一匹配三类场景。 */
function resolveUnknownVersionHint(record: Pick<AdminSessionInfo, "sessionKind" | "clientVersion" | "activeWorkspaceId">): string | null {
  if (record.clientVersion) return null;
  if (record.sessionKind === "client") {
    return "对应在线 Client 连接在建立时未上报版本，通常需要客户端重连后才会带上版本号。";
  }
  if (!record.activeWorkspaceId) {
    return "当前 Web 会话尚未绑定工作区，系统暂时无法关联到对应的 Client 版本。";
  }
  return "当前 Web 会话无法唯一匹配到对应的 Client 版本，常见原因是存在多个在线 Client，或对应 Client 未上报版本。";
}

function resolveTodayRange(): [number, number] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return [start.getTime(), end.getTime()];
}
</script>

<template>
  <div class="admin-sessions">
    <div class="admin-sessions__header">
      <h2 class="admin-sessions__title">会话管理</h2>
      <a-button @click="loadSessionManagement()">
        <template #icon><ReloadOutlined /></template>
        刷新
      </a-button>
    </div>

    <div v-if="scopedOverview" class="admin-sessions__overview-cards">
      <button
        v-for="card in overviewCards"
        :key="card.key"
        type="button"
        class="admin-sessions__overview-card"
        :class="{ 'admin-sessions__overview-card--active': detailMode === card.key }"
        @click="selectDetail(card.key)"
      >
        <div class="admin-sessions__overview-icon">
          <component :is="card.icon" />
        </div>
        <div class="admin-sessions__overview-copy">
          <strong>{{ scopedOverview[card.metricKey] }}</strong>
          <span>{{ card.label }}</span>
        </div>
      </button>
    </div>

    <div class="admin-sessions__detail-head">
      <strong>{{ detailTitle }}</strong>
    </div>

    <div class="admin-sessions__data">
      <template v-if="detailMode === 'activeSessions' && isMobile">
      <a-spin :spinning="sessionsLoading">
        <div class="admin-card-list">
          <div v-for="record in pagedSessions" :key="record.id" class="admin-card">
            <div class="admin-card__subtitle">{{ record.id }}</div>
            <div class="admin-card__row">
              <span class="admin-card__field">类型: <b>{{ sessionKindLabel(record) }}</b></span>
            </div>
            <div class="admin-card__row">
              <span class="admin-card__field">用户名: <b>{{ record.userName || "-" }}</b></span>
              <span class="admin-card__field">邮箱: <b>{{ record.userEmail || "-" }}</b></span>
            </div>
            <div class="admin-card__row">
              <span class="admin-card__field">角色: <b>{{ formatSessionAccountRole(record) }}</b></span>
            </div>
            <div class="admin-card__row">
              <span class="admin-card__field">在线: <b>{{ formatDuration(record.connectedAt) }}</b></span>
              <span class="admin-card__field">{{ formatTime(record.connectedAt) }}</span>
            </div>
            <div class="admin-card__row" v-if="record.sessionKind === 'web'">
              <span class="admin-card__field">Web连接数: <b>{{ record.connectedWebCount ?? 0 }}</b></span>
              <span class="admin-card__field">
                客户端版本:
                <b>{{ formatSessionClientVersion(record) }}</b>
                <a-tooltip v-if="resolveUnknownVersionHint(record)" :title="resolveUnknownVersionHint(record)">
                  <InfoCircleOutlined class="admin-card__hint-icon" />
                </a-tooltip>
              </span>
            </div>
            <div class="admin-card__row" v-if="record.sessionKind === 'web'">
              <span class="admin-card__field">过期: <b>{{ formatTime(record.sessionExpiresAt || 0) }}</b></span>
            </div>
            <div class="admin-card__row" v-else>
              <span class="admin-card__field">
                客户端版本:
                <b>{{ formatSessionClientVersion(record) }}</b>
                <a-tooltip v-if="resolveUnknownVersionHint(record)" :title="resolveUnknownVersionHint(record)">
                  <InfoCircleOutlined class="admin-card__hint-icon" />
                </a-tooltip>
              </span>
              <span class="admin-card__field">工作区: <b>{{ record.workspaceIds?.join(", ") || "-" }}</b></span>
            </div>
            <div v-if="canKickSession" class="admin-card__actions">
              <a-popconfirm title="确认踢出该会话？" @confirm="handleKick(record.id)">
                <a-button size="small" danger>踢出</a-button>
              </a-popconfirm>
            </div>
          </div>
          <div v-if="!sessionsLoading && totalSessions === 0" class="admin-card-list__empty">当前无在线会话</div>
        </div>
      </a-spin>
    </template>

    <a-table
      v-else-if="detailMode === 'activeSessions'"
      class="admin-table"
      :data-source="pagedSessions"
      :loading="sessionsLoading"
      :pagination="false"
      row-key="id"
      size="small"
      :scroll="{ x: 680, y: '100%' }"
    >
      <a-table-column title="类型" :width="100">
        <template #default="{ record }">{{ sessionKindLabel(record) }}</template>
      </a-table-column>
      <a-table-column title="用户名" :width="160">
        <template #default="{ record }">{{ record.userName || "-" }}</template>
      </a-table-column>
      <a-table-column title="用户邮箱" :width="220">
        <template #default="{ record }">
          <span class="admin-table__text">{{ record.userEmail || "-" }}</span>
        </template>
      </a-table-column>
      <a-table-column title="账户角色" :width="120">
        <template #default="{ record }">{{ formatSessionAccountRole(record) }}</template>
      </a-table-column>
      <a-table-column title="客户端版本" :width="120">
        <template #default="{ record }">
          <span class="admin-table__version-cell">
            <span>{{ formatSessionClientVersion(record) }}</span>
            <a-tooltip v-if="resolveUnknownVersionHint(record)" :title="resolveUnknownVersionHint(record)">
              <InfoCircleOutlined class="admin-table__hint-icon" />
            </a-tooltip>
          </span>
        </template>
      </a-table-column>
      <a-table-column title="Web连接数" :width="100">
        <template #default="{ record }">{{ record.sessionKind === "web" ? (record.connectedWebCount ?? 0) : "-" }}</template>
      </a-table-column>
      <a-table-column title="过期时间" :width="160">
        <template #default="{ record }">{{ record.sessionKind === "web" ? formatTime(record.sessionExpiresAt || 0) : "-" }}</template>
      </a-table-column>
      <a-table-column title="连接时间" :width="160">
        <template #default="{ record }">{{ formatTime(record.connectedAt) }}</template>
      </a-table-column>
      <a-table-column title="在线时长" :width="100">
        <template #default="{ record }">{{ formatDuration(record.connectedAt) }}</template>
      </a-table-column>
      <a-table-column v-if="canKickSession" title="操作" :width="100">
        <template #default="{ record }">
          <a-popconfirm title="确认踢出该会话？" @confirm="handleKick(record.id)">
            <a-button size="small" danger>踢出</a-button>
          </a-popconfirm>
        </template>
      </a-table-column>
    </a-table>

    <a-table
      v-else-if="detailMode === 'totalKeys' || detailMode === 'activeKeys'"
      class="admin-table"
      :data-source="keyDetails"
      :loading="keyDetailsLoading"
      :pagination="false"
      row-key="keyId"
      size="small"
      :scroll="{ x: 980, y: '100%' }"
    >
      <a-table-column title="密钥名称" :width="220" data-index="keyName" />
      <a-table-column title="Key 标识" :width="140" data-index="keyPrefix" />
      <a-table-column title="状态" :width="100">
        <template #default="{ record }">{{ formatKeyStatus(record.isActive) }}</template>
      </a-table-column>
      <a-table-column title="到期时间" :width="160">
        <template #default="{ record }">{{ formatTime(record.expiresAt) }}</template>
      </a-table-column>
      <a-table-column title="最近使用" :width="160">
        <template #default="{ record }">{{ formatTime(record.lastUsedAt) }}</template>
      </a-table-column>
      <a-table-column title="累计登录" :width="100" data-index="loginCount" />
      <a-table-column title="累计消息" :width="100" data-index="messageCount" />
      <a-table-column title="创建时间" :width="160">
        <template #default="{ record }">{{ formatTime(record.createdAt) }}</template>
      </a-table-column>
    </a-table>

    <a-table
      v-else-if="detailMode === 'todayLogins'"
      class="admin-table"
      :data-source="loginAuditDetails"
      :loading="loginAuditLoading"
      :pagination="false"
      row-key="auditId"
      size="small"
      :scroll="{ x: 1080, y: '100%' }"
    >
      <a-table-column title="时间" :width="180">
        <template #default="{ record }">{{ formatTime(record.createdAt) }}</template>
      </a-table-column>
      <a-table-column title="用户名" :width="180">
        <template #default="{ record }">{{ record.actor.fullName || "-" }}</template>
      </a-table-column>
      <a-table-column title="用户邮箱" :width="220">
        <template #default="{ record }">
          <span class="admin-table__text">{{ record.actor.email || "-" }}</span>
        </template>
      </a-table-column>
      <a-table-column title="角色" :width="120">
        <template #default="{ record }">{{ formatLoginAuditActorRole(record) }}</template>
      </a-table-column>
      <a-table-column title="摘要" :width="320">
        <template #default="{ record }">
          <span class="admin-table__text" :title="record.summary || '-'">{{ record.summary || "-" }}</span>
        </template>
      </a-table-column>
    </a-table>

    <a-table
      v-else
      class="admin-table"
      :data-source="usageDetails"
      :loading="usageDetailsLoading"
      :pagination="false"
      row-key="logId"
      size="small"
      :scroll="{ x: 1080, y: '100%' }"
    >
      <a-table-column title="时间" :width="180">
        <template #default="{ record }">{{ formatTime(record.createdAt) }}</template>
      </a-table-column>
      <a-table-column title="动作" :width="120" data-index="action" />
      <a-table-column title="密钥名称" :width="220" data-index="keyName" />
      <a-table-column title="Key 标识" :width="140" data-index="keyPrefix" />
      <a-table-column title="工作区" :width="220">
        <template #default="{ record }">
          <span
            class="admin-table__text"
            :title="record.workspaceTitle ? (record.workspaceTitle + ' (' + (record.workspaceId || '-') + ')') : (record.workspaceId || '-')"
          >
            {{ record.workspaceTitle || record.workspaceId || "-" }}
          </span>
        </template>
      </a-table-column>
      <a-table-column title="明细" :width="260">
        <template #default="{ record }">
          <span class="admin-table__text" :title="record.workspacePath || record.detail || '-'">
            {{ record.workspacePath || record.detail || "-" }}
          </span>
        </template>
      </a-table-column>
    </a-table>

      <div v-if="!detailLoading && currentPagination.total === 0" class="admin-sessions__empty">
        当前暂无明细数据
      </div>
    </div>

    <div class="admin-sessions__pagination">
      <div class="admin-sessions__pagination-total">共 {{ currentPagination.total }} 条记录</div>
      <a-pagination
        :current="currentPagination.current"
        :page-size="currentPagination.pageSize"
        :total="currentPagination.total"
        :show-size-changer="true"
        :show-quick-jumper="currentPagination.total > currentPagination.pageSize"
        :page-size-options="currentPagination.pageSizeOptions"
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
.admin-sessions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  gap: 14px;
  height: 100%;
  min-height: 0;
  min-width: 0;
}

.admin-sessions__data {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.admin-sessions__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.admin-sessions__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--app-text);
  margin: 0;
}

.admin-sessions__overview-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.admin-sessions__overview-card {
  appearance: none;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 12px;
  width: 100%;
  min-height: 72px;
  margin: 0;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
  background: var(--app-panel-bg);
  color: inherit;
  cursor: pointer;
  font: inherit;
  line-height: normal;
  text-align: left;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.admin-sessions__overview-card:hover,
.admin-sessions__overview-card--active {
  border-color: color-mix(in srgb, var(--app-accent) 35%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 6%, var(--app-panel-bg));
}

.admin-sessions__overview-card:focus {
  outline: none;
}

.admin-sessions__overview-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 50%, transparent);
  outline-offset: 2px;
}

.admin-sessions__overview-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  min-width: 38px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 10%, transparent);
  color: var(--app-accent);
  font-size: 18px;
}

.admin-sessions__overview-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.admin-sessions__overview-copy strong {
  color: var(--app-text);
  font-size: 22px;
  line-height: 1.1;
}

.admin-sessions__overview-copy span {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}

.admin-sessions__detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

.admin-sessions__detail-head strong {
  color: var(--app-text);
  font-size: 16px;
  line-height: 1.3;
}

.admin-sessions__data > :deep(.ant-spin-nested-loading),
.admin-sessions__data > :deep(.ant-spin-nested-loading > .ant-spin-container) {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-height: 0;
}

.admin-card-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.admin-table {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.admin-table :deep(.ant-spin-nested-loading),
.admin-table :deep(.ant-spin-container),
.admin-table :deep(.ant-table),
.admin-table :deep(.ant-table-container) {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
}

.admin-table :deep(.ant-table-content) {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  overflow: auto;
}

/* scroll.y 生效时 antd 拆成 header/body 两个兄弟节点：表头必须不可压缩，
   否则 body 的 max-height:100% 会把 header 挤到只剩几像素（表现为表头显示不全）。 */
.admin-table :deep(.ant-table-header) {
  flex: 0 0 auto;
}

.admin-table :deep(.ant-table-body) {
  flex: 1 1 auto;
  min-height: 0;
}

.admin-table :deep(.ant-table-thead > tr > th) {
  position: sticky;
  top: 0;
  z-index: 2;
}

.admin-sessions__empty {
  color: var(--app-muted);
  text-align: center;
  padding: 32px 0;
}

.admin-sessions__pagination {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.admin-sessions__pagination-total {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}

.admin-table__text {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-card__hint-icon,
.admin-table__hint-icon {
  margin-left: 4px;
  color: var(--app-muted);
  font-size: 12px;
  vertical-align: middle;
}

.admin-table__version-cell {
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

@media (max-height: 900px) {
  .admin-sessions__overview-cards {
    gap: 10px;
  }

  .admin-sessions__overview-card {
    padding: 12px;
    border-radius: 12px;
  }

  .admin-sessions__overview-icon {
    width: 34px;
    height: 34px;
    min-width: 34px;
    font-size: 16px;
  }

  .admin-sessions__overview-copy strong {
    font-size: 20px;
  }
}

@media (max-width: 760px) {
  .admin-sessions__pagination {
    align-items: stretch;
  }
}
</style>
