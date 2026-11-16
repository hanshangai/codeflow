<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { ReloadOutlined, UserAddOutlined } from "@ant-design/icons-vue";
import type {
  AuditLogFilters,
  AuditLogItem,
  EnterpriseMemberItem,
  EnterpriseMemberSortBy,
  EnterpriseMemberSortDirection,
  EnterpriseSummaryResponseBody,
  PreviewRemoveEnterpriseMemberResponseBody,
} from "@codeflowai/shared";

import {
  auditOperationTypeOptions,
  auditResultOptions,
  formatAccountStatus,
  formatEnterpriseMemberDisplayRole,
  formatKeyStatus,
  formatTimestamp,
} from "../accountDisplay";
import AddMemberModal from "./add-member-modal.vue";
import AuditLogTable from "./audit-log-table.vue";
import ResetPasswordModal from "./reset-password-modal.vue";

defineOptions({ name: "EnterpriseDrawer" });

const props = defineProps<{
  open: boolean;
  embedded?: boolean;
  showAuditTab?: boolean;
  summary: EnterpriseSummaryResponseBody | null;
  members: EnterpriseMemberItem[];
  membersTotal?: number;
  membersCurrent?: number;
  membersPageSize?: number;
  membersSortBy?: EnterpriseMemberSortBy | "";
  membersSortDirection?: EnterpriseMemberSortDirection | "";
  loading?: boolean;
  addingMember?: boolean;
  resettingPassword?: boolean;
  updatingMemberStatus?: boolean;
  removingMember?: boolean;
  auditLogs?: AuditLogItem[];
  auditTotal?: number;
  auditLoading?: boolean;
  exportingAudit?: boolean;
  previewRemoveMember: (membershipId: string) => Promise<PreviewRemoveEnterpriseMemberResponseBody>;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "add-member", email: string): void;
  (e: "load-members", payload: {
    page: number;
    pageSize: number;
    sortBy?: EnterpriseMemberSortBy | "";
    sortDirection?: EnterpriseMemberSortDirection | "";
  }): void;
  (e: "reset-member-password", payload: { membershipId: string; newPassword: string; confirmPassword: string }): void;
  (e: "update-member-status", payload: { membershipId: string; status: "active" | "disabled" }): void;
  (e: "remove-member", membershipId: string): void;
  (e: "load-audit", filters: AuditLogFilters): void;
  (e: "export-audit", filters: AuditLogFilters): void;
}>();


const addMemberOpen = ref(false);
const resetOpen = ref(false);
const DEFAULT_ACTIVE_TAB = "members";
const activeTab = ref<string>(DEFAULT_ACTIVE_TAB);
const selectedMember = ref<EnterpriseMemberItem | null>(null);
const removePreview = ref<PreviewRemoveEnterpriseMemberResponseBody | null>(null);
const removeConfirmOpen = ref(false);
const removePreviewing = ref(false);
const statusTargetId = ref("");
const removeTargetId = ref("");
const auditPaging = reactive({
  current: 1,
  pageSize: 10,
});
const memberPageSizeOptions = ["10", "20", "50", "100"];
const auditFilters = reactive({
  userKeyword: "",
  operationType: undefined as AuditLogFilters["operationType"],
  result: "",
  dateFrom: "",
  dateTo: "",
});

const membersTotal = computed(() => props.membersTotal ?? props.members.length);
const membersCurrent = computed(() => props.membersCurrent ?? 1);
const membersPageSize = computed(() => props.membersPageSize ?? 10);
watch(
  () => props.updatingMemberStatus,
  (loading) => {
    if (!loading) {
      statusTargetId.value = "";
    }
  },
);

watch(
  () => props.removingMember,
  (loading) => {
    if (!loading) {
      removeTargetId.value = "";
      removeConfirmOpen.value = false;
      removePreview.value = null;
      selectedMember.value = null;
    }
  },
);


watch(
  () => props.showAuditTab,
  (showAuditTab) => {
    if (showAuditTab === false && activeTab.value === "audit") {
      activeTab.value = DEFAULT_ACTIVE_TAB;
    }
  },
  { immediate: true },
);

watch(
  () => props.open,
  (open) => {
    if (!open) {
      addMemberOpen.value = false;
      resetOpen.value = false;
      removeConfirmOpen.value = false;
      removePreview.value = null;
      removePreviewing.value = false;
      activeTab.value = DEFAULT_ACTIVE_TAB;
      auditPaging.current = 1;
      auditPaging.pageSize = 10;
      auditFilters.userKeyword = "";
      auditFilters.operationType = undefined;
      auditFilters.result = "";
      auditFilters.dateFrom = "";
      auditFilters.dateTo = "";
    }
  },
);

function close() {
  emit("update:open", false);
}

function buildAuditFilters(overrides?: Partial<AuditLogFilters>): AuditLogFilters {
  const dateFrom = auditFilters.dateFrom ? new Date(auditFilters.dateFrom).getTime() : undefined;
  const dateTo = auditFilters.dateTo ? new Date(auditFilters.dateTo).getTime() : undefined;
  return {
    userKeyword: auditFilters.userKeyword.trim() || undefined,
    operationType: auditFilters.operationType,
    result: auditFilters.result || undefined,
    dateFrom: Number.isFinite(dateFrom) ? dateFrom : undefined,
    dateTo: Number.isFinite(dateTo) ? dateTo : undefined,
    offset: (auditPaging.current - 1) * auditPaging.pageSize,
    limit: auditPaging.pageSize,
    ...overrides,
  };
}

function loadAudit(resetPage = true) {
  if (resetPage) {
    auditPaging.current = 1;
  }
  emit("load-audit", buildAuditFilters());
}

function exportAudit() {
  emit("export-audit", buildAuditFilters({ offset: undefined, limit: undefined }));
}

function handleAuditPageChange(payload: { page: number; pageSize: number }) {
  auditPaging.current = payload.page;
  auditPaging.pageSize = payload.pageSize;
  emit("load-audit", buildAuditFilters());
}

function handleTabChange(key: string) {
  activeTab.value = key;
  if (key === "audit") {
    loadAudit();
  }
}

/** 成员分页翻页时通知上层拉取对应页。 */
function handleMembersPaginationChange(page: number, pageSize: number) {
  const pageSizeChanged = pageSize !== membersPageSize.value;
  emit("load-members", buildMembersLoadPayload(pageSizeChanged ? 1 : page, pageSize));
}

/** 切换分页条数时统一回到第一页，保持与用户页分页行为一致。 */
function handleMembersPageSizeChange(_: number, pageSize: number) {
  emit("load-members", buildMembersLoadPayload(1, pageSize));
}

/** 刷新当前页成员列表，保留当前分页与排序口径。 */
function refreshMembers() {
  emit("load-members", buildMembersLoadPayload(membersCurrent.value, membersPageSize.value));
}

/** 构造成员列表加载参数，翻页时保留当前排序口径。 */
function buildMembersLoadPayload(page: number, pageSize: number) {
  return {
    page,
    pageSize,
    sortBy: props.membersSortBy ?? "",
    sortDirection: props.membersSortDirection ?? "",
  };
}

/** 判断成员行是否仍处于邀请中，邀请行不能执行成员操作。 */
function isPendingInvitation(member: EnterpriseMemberItem): boolean {
  return member.membershipStatus === "pending_invitation" || member.invitationStatus === "pending";
}

/** 成员管理页展示成员当前备注，邀请未确认时固定显示邀请中。 */
function formatMemberStatusRemark(member: EnterpriseMemberItem): string {
  return member.statusRemark || (isPendingInvitation(member) ? "邀请中" : "已加入");
}

/** 成员移除只撤销企业权限。 */
function buildRemoveConfirmMessage(member: EnterpriseMemberItem | null): string {
  return `确认移除成员「${member?.fullName || member?.email || "该成员"}」？移除后将失去企业功能。`;
}

/** 打开重置密码弹窗；邀请中的成员尚未加入，不能重置。 */
function openReset(member: EnterpriseMemberItem) {
  if (isPendingInvitation(member)) return;
  selectedMember.value = member;
  resetOpen.value = true;
}

/** 提交邀请后关闭表单，结果与列表刷新仍由企业管理容器统一反馈。 */
function handleAddMember(email: string) {
  addMemberOpen.value = false;
  emit("add-member", email);
}

function handleResetConfirm(payload: { newPassword: string; confirmPassword: string }) {
  if (!selectedMember.value) return;
  resetOpen.value = false;
  emit("reset-member-password", {
    membershipId: selectedMember.value.membershipId,
    newPassword: payload.newPassword,
    confirmPassword: payload.confirmPassword,
  });
}

/** 切换成员账号状态；邀请中和 Owner 行不允许操作。 */
function toggleMemberStatus(member: EnterpriseMemberItem) {
  if (member.memberRole === "owner" || isPendingInvitation(member)) return;
  statusTargetId.value = member.membershipId;
  emit("update-member-status", {
    membershipId: member.membershipId,
    status: member.accountStatus === "disabled" ? "active" : "disabled",
  });
}

/** 移除已加入成员；邀请中行只做展示，不执行成员移除。 */
async function openRemoveConfirm(member: EnterpriseMemberItem) {
  if (member.memberRole === "owner" || isPendingInvitation(member) || removePreviewing.value) return;
  selectedMember.value = member;
  removeTargetId.value = member.membershipId;
  removePreview.value = null;
  removePreviewing.value = true;
  try {
    removePreview.value = await props.previewRemoveMember(member.membershipId);
    removeConfirmOpen.value = true;
  } catch (error) {
    removeTargetId.value = "";
    selectedMember.value = null;
    message.error(error instanceof Error ? error.message : "移除预览失败");
  } finally {
    removePreviewing.value = false;
  }
}

/** 确认移除成员，实际返还结果以后端执行结果为准。 */
function confirmRemoveMember() {
  if (!selectedMember.value) return;
  removeTargetId.value = selectedMember.value.membershipId;
  emit("remove-member", selectedMember.value.membershipId);
}

/** 取消移除确认时清理本次预览快照和行级目标。 */
function cancelRemoveConfirm() {
  removePreview.value = null;
  removeTargetId.value = "";
  selectedMember.value = null;
}

</script>

<template>
  <a-drawer
    v-if="!embedded"
    :open="open"
    width="min(980px, 100vw)"
    placement="right"
    destroy-on-close
    @close="close"
  >
    <template #title>
      <span>企业中心</span>
      <a-tag v-if="summary?.status === 'disabled'" color="red" :bordered="false" class="enterprise-drawer__status-tag">已停用</a-tag>
    </template>
    <a-spin :spinning="loading">
      <template v-if="summary">
        <div class="enterprise-drawer">
          <a-tabs
            v-model:activeKey="activeTab"
            size="small"
            @change="handleTabChange"
          >
            <a-tab-pane key="members" tab="成员管理">
              <div class="enterprise-drawer__panel">
                <div class="enterprise-drawer__member-toolbar">
                  <div class="enterprise-drawer__member-summary">
                    <strong>企业成员</strong>
                    <span>{{ membersTotal }} 人</span>
                    <a-tag v-if="summary.status === 'disabled'" color="red" :bordered="false">企业已停用</a-tag>
                  </div>
                  <a-space :size="8">
                    <a-button :loading="loading" title="刷新成员列表" aria-label="刷新成员列表" @click="refreshMembers">
                      <template #icon><ReloadOutlined /></template>
                    </a-button>
                    <a-button type="primary" @click="addMemberOpen = true">
                      <template #icon><UserAddOutlined /></template>
                      添加成员
                    </a-button>
                  </a-space>
                </div>
                <a-table
                  class="enterprise-drawer__table"
                  size="small"
                  :data-source="members"
                  row-key="membershipId"
                  :pagination="false"
                  :scroll="{ x: 1270 }"
                >
                  <a-table-column title="姓名" data-index="fullName" :width="120" />
                  <a-table-column title="邮箱" data-index="email" :width="220">
                    <template #default="{ record }">
                      <span class="enterprise-drawer__cell-ellipsis" :title="record.email">{{ record.email }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="手机号" data-index="phone" :width="140" />
                  <a-table-column title="成员角色" :width="150">
                    <template #default="{ record }">{{ formatEnterpriseMemberDisplayRole(record.displayMemberRole ?? record.memberRole) }}</template>
                  </a-table-column>
                  <a-table-column title="账号状态" :width="110">
                    <template #default="{ record }">{{ formatAccountStatus(record.accountStatus) }}</template>
                  </a-table-column>
                  <a-table-column title="状态备注" :width="110">
                    <template #default="{ record }">{{ formatMemberStatusRemark(record) }}</template>
                  </a-table-column>
                  <a-table-column title="加入时间" :width="160">
                    <template #default="{ record }">{{ formatTimestamp(record.joinedAt) }}</template>
                  </a-table-column>
                  <a-table-column title="操作" :width="240" fixed="right">
                    <template #default="{ record }">
                      <a-space wrap>
                        <a-button size="small" :disabled="record.memberRole === 'owner' || isPendingInvitation(record)" @click="openReset(record)">重置密码</a-button>
                        <a-button
                          size="small"
                          :loading="updatingMemberStatus && statusTargetId === record.membershipId"
                          :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || removingMember"
                          @click="toggleMemberStatus(record)"
                        >
                          {{ record.accountStatus === 'disabled' ? '启用' : '禁用' }}
                        </a-button>
                        <a-button
                          danger
                          size="small"
                          :loading="(removingMember || removePreviewing) && removeTargetId === record.membershipId"
                          :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || updatingMemberStatus"
                          @click="openRemoveConfirm(record)"
                        >
                          移除
                        </a-button>
                      </a-space>
                    </template>
                  </a-table-column>
                </a-table>
                <div class="enterprise-drawer__pagination">
                  <div class="enterprise-drawer__pagination-total">共 {{ membersTotal }} 条记录</div>
                  <a-pagination
                    :current="membersCurrent"
                    :page-size="membersPageSize"
                    :total="membersTotal"
                    :show-size-changer="true"
                    :show-quick-jumper="membersTotal > membersPageSize"
                    :page-size-options="memberPageSizeOptions"
                    :show-less-items="true"
                    @change="handleMembersPaginationChange"
                    @showSizeChange="handleMembersPageSizeChange"
                  >
                    <template #buildOptionText="{ value }">
                      {{ value }} 条/页
                    </template>
                  </a-pagination>
                </div>
              </div>
            </a-tab-pane>

            <a-tab-pane v-if="$slots.invoiceProfile" key="invoice-profile" tab="发票信息">
              <div class="enterprise-drawer__panel">
                <slot name="invoiceProfile" />
              </div>
            </a-tab-pane>

            <a-tab-pane v-if="showAuditTab !== false" key="audit" tab="操作审计">
              <div class="enterprise-drawer__panel">
                <div class="enterprise-drawer__audit-head">
                  <div>
                    <strong>企业操作审计</strong>
                    <p>仅企业管理员可查看，支持按成员、时间、操作类型和状态筛选并导出 Excel。</p>
                  </div>
                  <a-tag color="gold" :bordered="false">企业管理员</a-tag>
                </div>

                <div class="enterprise-drawer__audit-toolbar">
                  <a-input
                    v-model:value="auditFilters.userKeyword"
                    class="enterprise-drawer__audit-field enterprise-drawer__audit-field--search"
                    placeholder="按姓名、邮箱或用户 ID 查询"
                    allow-clear
                    @press-enter="loadAudit()"
                  />
                  <a-select v-model:value="auditFilters.operationType" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--filter" placeholder="操作类型" allow-clear>
                    <a-select-option v-for="item in auditOperationTypeOptions" :key="item.value" :value="item.value">
                      {{ item.label }}
                    </a-select-option>
                  </a-select>
                  <a-select v-model:value="auditFilters.result" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--filter" placeholder="操作状态" allow-clear>
                    <a-select-option v-for="item in auditResultOptions" :key="item.value" :value="item.value">
                      {{ item.label }}
                    </a-select-option>
                  </a-select>
                  <a-input v-model:value="auditFilters.dateFrom" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--date" type="datetime-local" />
                  <a-input v-model:value="auditFilters.dateTo" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--date" type="datetime-local" />
                  <a-space class="enterprise-drawer__audit-actions" wrap>
                    <a-button type="primary" :loading="auditLoading" @click="loadAudit()">查询</a-button>
                    <a-button :loading="exportingAudit" @click="exportAudit">导出 Excel</a-button>
                  </a-space>
                </div>

                <AuditLogTable
                  :items="auditLogs || []"
                  :loading="auditLoading"
                  :total="auditTotal || 0"
                  :current="auditPaging.current"
                  :page-size="auditPaging.pageSize"
                  :show-enterprise="false"
                  empty-text="当前企业暂无符合条件的审计记录"
                  @page-change="handleAuditPageChange"
                />
              </div>
            </a-tab-pane>

          </a-tabs>
        </div>
      </template>
      <a-empty v-else description="暂无企业数据" />
    </a-spin>

  </a-drawer>

  <div v-else class="enterprise-drawer__embedded-shell">
    <a-spin :spinning="loading">
      <template v-if="summary">
        <div class="enterprise-drawer">
          <a-tabs
            v-model:activeKey="activeTab"
            size="small"
            :tab-bar-style="{ display: 'none' }"
            @change="handleTabChange"
          >
            <a-tab-pane key="members" tab="成员管理" class="enterprise-drawer__embedded-members-pane">
              <div class="enterprise-drawer__panel">
                <div class="enterprise-drawer__member-toolbar">
                  <div class="enterprise-drawer__member-summary">
                    <strong>企业成员</strong>
                    <span>{{ membersTotal }} 人</span>
                    <a-tag v-if="summary.status === 'disabled'" color="red" :bordered="false">企业已停用</a-tag>
                  </div>
                  <a-space :size="8">
                    <a-button :loading="loading" title="刷新成员列表" aria-label="刷新成员列表" @click="refreshMembers">
                      <template #icon><ReloadOutlined /></template>
                    </a-button>
                    <a-button type="primary" @click="addMemberOpen = true">
                      <template #icon><UserAddOutlined /></template>
                      添加成员
                    </a-button>
                  </a-space>
                </div>
                <a-table
                  class="enterprise-drawer__table"
                  size="small"
                  :data-source="members"
                  row-key="membershipId"
                  :pagination="false"
                  :scroll="{ x: 1270 }"
                >
                  <a-table-column title="姓名" data-index="fullName" :width="120" />
                  <a-table-column title="邮箱" data-index="email" :width="220">
                    <template #default="{ record }">
                      <span class="enterprise-drawer__cell-ellipsis" :title="record.email">{{ record.email }}</span>
                    </template>
                  </a-table-column>
                  <a-table-column title="手机号" data-index="phone" :width="140" />
                  <a-table-column title="成员角色" :width="150">
                    <template #default="{ record }">{{ formatEnterpriseMemberDisplayRole(record.displayMemberRole ?? record.memberRole) }}</template>
                  </a-table-column>
                  <a-table-column title="账号状态" :width="110">
                    <template #default="{ record }">{{ formatAccountStatus(record.accountStatus) }}</template>
                  </a-table-column>
                  <a-table-column title="加入状态" :width="110">
                    <template #default="{ record }">{{ formatMemberStatusRemark(record) }}</template>
                  </a-table-column>
                  <a-table-column title="加入企业时间" :width="150">
                    <template #default="{ record }">{{ formatTimestamp(record.joinedAt) }}</template>
                  </a-table-column>
                  <a-table-column title="操作" :width="200" fixed="right">
                    <template #default="{ record }">
                      <a-space wrap>
                        <a-button size="small" :disabled="record.memberRole === 'owner' || isPendingInvitation(record)" @click="openReset(record)">重置密码</a-button>
                        <a-button
                          size="small"
                          :loading="updatingMemberStatus && statusTargetId === record.membershipId"
                          :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || removingMember"
                          @click="toggleMemberStatus(record)"
                        >
                          {{ record.accountStatus === 'disabled' ? '启用' : '禁用' }}
                        </a-button>
                        <a-button
                          danger
                          size="small"
                          :loading="(removingMember || removePreviewing) && removeTargetId === record.membershipId"
                          :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || updatingMemberStatus"
                          @click="openRemoveConfirm(record)"
                        >
                          移除
                        </a-button>
                      </a-space>
                    </template>
                  </a-table-column>
                </a-table>
                <div class="enterprise-drawer__mobile-list enterprise-drawer__mobile-list--members">
                  <article v-for="record in members" :key="record.membershipId" class="enterprise-drawer__mobile-card">
                    <header class="enterprise-drawer__mobile-card-head">
                      <div>
                        <strong>{{ record.fullName || record.email }}</strong>
                        <span>{{ record.email }}</span>
                      </div>
                      <a-tag :bordered="false" :color="record.accountStatus === 'active' ? 'green' : 'red'">
                        {{ formatAccountStatus(record.accountStatus) }}
                      </a-tag>
                    </header>
                    <dl class="enterprise-drawer__mobile-stats">
                      <div><dt>成员角色</dt><dd>{{ formatEnterpriseMemberDisplayRole(record.displayMemberRole ?? record.memberRole) }}</dd></div>
                      <div><dt>加入状态</dt><dd>{{ formatMemberStatusRemark(record) }}</dd></div>
                      <div><dt>手机号</dt><dd>{{ record.phone || '-' }}</dd></div>
                      <div><dt>加入时间</dt><dd>{{ formatTimestamp(record.joinedAt) }}</dd></div>
                    </dl>
                    <div class="enterprise-drawer__mobile-actions enterprise-drawer__mobile-actions--three">
                      <a-button :disabled="record.memberRole === 'owner' || isPendingInvitation(record)" @click="openReset(record)">重置密码</a-button>
                      <a-button
                        :loading="updatingMemberStatus && statusTargetId === record.membershipId"
                        :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || removingMember"
                        @click="toggleMemberStatus(record)"
                      >
                        {{ record.accountStatus === 'disabled' ? '启用' : '禁用' }}
                      </a-button>
                      <a-button
                        danger
                        :loading="(removingMember || removePreviewing) && removeTargetId === record.membershipId"
                        :disabled="record.memberRole === 'owner' || isPendingInvitation(record) || updatingMemberStatus"
                        @click="openRemoveConfirm(record)"
                      >
                        移除
                      </a-button>
                    </div>
                  </article>
                  <a-empty v-if="members.length === 0" description="暂无企业成员" />
                </div>
                <div class="enterprise-drawer__pagination">
                  <div class="enterprise-drawer__pagination-total">共 {{ membersTotal }} 条记录</div>
                  <a-pagination
                    :current="membersCurrent"
                    :page-size="membersPageSize"
                    :total="membersTotal"
                    :show-size-changer="true"
                    :show-quick-jumper="membersTotal > membersPageSize"
                    :page-size-options="memberPageSizeOptions"
                    :show-less-items="true"
                    @change="handleMembersPaginationChange"
                    @showSizeChange="handleMembersPageSizeChange"
                  >
                    <template #buildOptionText="{ value }">
                      {{ value }} 条/页
                    </template>
                  </a-pagination>
                </div>
              </div>
            </a-tab-pane>

            <a-tab-pane v-if="$slots.invoiceProfile" key="invoice-profile" tab="发票信息">
              <div class="enterprise-drawer__panel">
                <slot name="invoiceProfile" />
              </div>
            </a-tab-pane>

            <a-tab-pane v-if="showAuditTab !== false" key="audit" tab="操作审计">
              <div class="enterprise-drawer__panel">
                <div class="enterprise-drawer__audit-head">
                  <div>
                    <strong>企业操作审计</strong>
                    <p>仅企业管理员可查看，支持按成员、时间、操作类型和状态筛选并导出 Excel。</p>
                  </div>
                  <a-tag color="gold" :bordered="false">企业管理员</a-tag>
                </div>

                <div class="enterprise-drawer__audit-toolbar">
                  <a-input
                    v-model:value="auditFilters.userKeyword"
                    class="enterprise-drawer__audit-field enterprise-drawer__audit-field--search"
                    placeholder="按姓名、邮箱或用户 ID 查询"
                    allow-clear
                    @press-enter="loadAudit()"
                  />
                  <a-select v-model:value="auditFilters.operationType" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--filter" placeholder="操作类型" allow-clear>
                    <a-select-option v-for="item in auditOperationTypeOptions" :key="item.value" :value="item.value">
                      {{ item.label }}
                    </a-select-option>
                  </a-select>
                  <a-select v-model:value="auditFilters.result" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--filter" placeholder="操作状态" allow-clear>
                    <a-select-option v-for="item in auditResultOptions" :key="item.value" :value="item.value">
                      {{ item.label }}
                    </a-select-option>
                  </a-select>
                  <a-input v-model:value="auditFilters.dateFrom" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--date" type="datetime-local" />
                  <a-input v-model:value="auditFilters.dateTo" class="enterprise-drawer__audit-field enterprise-drawer__audit-field--date" type="datetime-local" />
                  <a-space class="enterprise-drawer__audit-actions" wrap>
                    <a-button type="primary" :loading="auditLoading" @click="loadAudit()">查询</a-button>
                    <a-button :loading="exportingAudit" @click="exportAudit">导出 Excel</a-button>
                  </a-space>
                </div>

                <AuditLogTable
                  :items="auditLogs || []"
                  :loading="auditLoading"
                  :total="auditTotal || 0"
                  :current="auditPaging.current"
                  :page-size="auditPaging.pageSize"
                  :show-enterprise="false"
                  empty-text="当前企业暂无符合条件的审计记录"
                  @page-change="handleAuditPageChange"
                />
              </div>
            </a-tab-pane>

          </a-tabs>
        </div>
      </template>
      <a-empty v-else description="暂无企业数据" />
    </a-spin>
  </div>

  <AddMemberModal
    v-model:open="addMemberOpen"
    :submitting="addingMember"
    @add="handleAddMember"
  />




  <ResetPasswordModal
    v-model:open="resetOpen"
    :loading="resettingPassword"
    :target-label="selectedMember?.fullName || '企业成员'"
    @confirm="handleResetConfirm"
  />

  <a-modal
    v-model:open="removeConfirmOpen"
    title="确认移除成员"
    ok-text="确认移除"
    cancel-text="取消"
    :confirm-loading="removingMember"
    @ok="confirmRemoveMember"
    @cancel="cancelRemoveConfirm"
  >
    <p>{{ buildRemoveConfirmMessage(selectedMember) }}</p>
  </a-modal>
</template>

<style scoped>
.enterprise-drawer {
  display: grid;
  gap: 12px;
}

.enterprise-drawer__embedded-shell {
  height: 100%;
  min-height: 0;
}

.enterprise-drawer__embedded-shell :deep(.ant-spin-nested-loading),
.enterprise-drawer__embedded-shell :deep(.ant-spin-container) {
  height: 100%;
  min-height: 0;
}

.enterprise-drawer__embedded-shell .enterprise-drawer {
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
}

.enterprise-drawer__status-tag {
  margin-left: 8px;
  vertical-align: middle;
}

.enterprise-drawer__panel {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.enterprise-drawer__save-button {
  min-width: 140px;
  box-shadow: 0 12px 24px rgba(217, 119, 87, 0.18);
}

.enterprise-drawer__member-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--app-divider);
}

.enterprise-drawer__member-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.enterprise-drawer__member-summary strong {
  color: var(--app-text);
  font-size: 15px;
}

.enterprise-drawer__member-summary span {
  color: var(--app-muted);
  font-size: 12px;
}

.enterprise-drawer__audit-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.enterprise-drawer__audit-head strong {
  color: var(--app-text);
  font-size: 16px;
}

.enterprise-drawer__audit-head p {
  margin: 6px 0 0;
  color: var(--app-muted);
  line-height: 1.6;
}

.enterprise-drawer__audit-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.enterprise-drawer__audit-field {
  min-width: 0;
}

.enterprise-drawer__audit-field--search {
  flex: 1 1 220px;
  min-width: min(100%, 220px);
}

.enterprise-drawer__audit-field--filter {
  flex: 1 1 112px;
  min-width: min(100%, 112px);
}

.enterprise-drawer__audit-field--date {
  flex: 1 1 176px;
  min-width: min(100%, 176px);
}

.enterprise-drawer__audit-actions {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.enterprise-drawer__table {
  min-width: 0;
}

.enterprise-drawer :deep(.ant-tabs-nav) {
  margin-bottom: 10px;
}

.enterprise-drawer :deep(.ant-table-thead > tr > th),
.enterprise-drawer :deep(.ant-table-tbody > tr > td) {
  padding: 8px 12px;
}

.enterprise-drawer :deep(.ant-table-thead > tr > th) {
  font-weight: 600;
}

.enterprise-drawer__pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.enterprise-drawer__pagination-total {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.3;
}

.enterprise-drawer__cell-ellipsis {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-drawer__table :deep(.ant-table-wrapper),
.enterprise-drawer__table :deep(.ant-spin-nested-loading),
.enterprise-drawer__table :deep(.ant-spin-container),
.enterprise-drawer__table :deep(.ant-table-container),
.enterprise-drawer__table :deep(.ant-table-cell) {
  min-width: 0;
}

.enterprise-drawer__mobile-list {
  display: none;
}

.enterprise-drawer__mobile-card {
  display: grid;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel-bg);
  box-shadow: 0 8px 20px rgba(20, 20, 19, 0.045);
}

.enterprise-drawer__mobile-card-head,
.enterprise-drawer__mobile-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.enterprise-drawer__mobile-card-head > div {
  min-width: 0;
}

.enterprise-drawer__mobile-card-head strong,
.enterprise-drawer__mobile-card-head span {
  display: block;
}

.enterprise-drawer__mobile-card-head strong {
  overflow: hidden;
  color: var(--app-text);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-drawer__mobile-card-head span {
  margin-top: 2px;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enterprise-drawer__mobile-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.enterprise-drawer__mobile-stats > div {
  display: grid;
  gap: 3px;
  min-width: 0;
  padding: 9px 10px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--app-bg) 72%, var(--app-panel-bg));
}

.enterprise-drawer__mobile-stats dt {
  color: var(--app-muted);
  font-size: 11px;
}

.enterprise-drawer__mobile-stats dd {
  margin: 0;
  overflow: hidden;
  color: var(--app-text);
  font-size: 12px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.enterprise-drawer__mobile-actions :deep(.ant-btn) {
  flex: 1 1 0;
  min-width: 0;
  min-height: 44px;
}

@media (max-width: 760px) {
  .enterprise-drawer__embedded-shell .enterprise-drawer__table {
    display: none;
  }

  .enterprise-drawer__embedded-shell .enterprise-drawer__mobile-list {
    display: grid;
    gap: 10px;
  }

  .enterprise-drawer__audit-field--search,
  .enterprise-drawer__audit-field--filter,
  .enterprise-drawer__audit-field--date,
  .enterprise-drawer__audit-actions {
    flex-basis: 100%;
    min-width: 0;
  }

  .enterprise-drawer__audit-actions {
    margin-left: 0;
    justify-content: flex-start;
  }

  .enterprise-drawer__audit-actions :deep(.ant-btn) {
    flex: 1 1 0;
  }

  .enterprise-drawer__pagination {
    align-items: stretch;
  }
}

@media (max-width: 560px) {

  .enterprise-drawer__member-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .enterprise-drawer__member-toolbar :deep(.ant-btn) {
    width: 100%;
  }
}
</style>
