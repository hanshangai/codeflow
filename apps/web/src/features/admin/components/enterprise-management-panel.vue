<script setup lang="ts">
import { computed, watch } from "vue";
import { message } from "ant-design-vue";
import type {
  AuditLogFilters,
  EnterpriseMemberSortBy,
  EnterpriseMemberSortDirection,
  PreviewRemoveEnterpriseMemberResponseBody,
} from "@codeflowai/shared";

import EnterpriseDrawer from "../../account/components/enterprise-drawer.vue";
import { captureAccountSession, useAccountStore } from "../../../store/account";
import { useConfigStore } from "../../../store/config";
import { createApiResultError, isCancelledRequestError } from "../../../api/request";

defineOptions({ name: "EnterpriseManagementPanel" });

const account = useAccountStore();
const config = useConfigStore();

const isEnterpriseAdmin = computed(() => config.accountRole === "enterprise_admin" && Boolean(config.userSummary?.enterpriseId));
const managedEnterpriseId = computed(() => isEnterpriseAdmin.value ? config.userSummary?.enterpriseId ?? null : null);

async function hydrateEnterprise(force = false) {
  const enterpriseId = managedEnterpriseId.value;
  if (!enterpriseId) return;
  const sameScope = account.enterpriseScopeId === enterpriseId;
  await Promise.all([
    account.loadEnterpriseSummary(force, { silent: sameScope && Boolean(account.enterpriseSummary), enterpriseId }),
    account.loadEnterpriseMembers(force, {
      silent: sameScope && Boolean(account.enterpriseMembers.length),
      enterpriseId,
      page: account.enterpriseMembersPage,
      pageSize: account.enterpriseMembersPageSize,
    }),
  ]);
}

/** 统一展示操作结果；成功后可触发当前企业视图刷新。 */
function showResultToast(result: { ok: boolean; message?: string }, successMessage: string) {
  if (result.ok) {
    message.success(successMessage);
  } else {
    message.error(result.message || "操作失败");
  }
}

/** 企业成员分页复用当前企业作用域。 */
async function handleLoadEnterpriseMembers(payload: {
  page: number;
  pageSize: number;
  sortBy?: EnterpriseMemberSortBy | "";
  sortDirection?: EnterpriseMemberSortDirection | "";
}) {
  await account.loadEnterpriseMembers(true, {
    enterpriseId: managedEnterpriseId.value,
    page: payload.page,
    pageSize: payload.pageSize,
    sortBy: payload.sortBy,
    sortDirection: payload.sortDirection,
  });
}

async function handleAddEnterpriseMember(email: string) {
  const result = await account.addEnterpriseMember(email, managedEnterpriseId.value);
  showResultToast(result, "添加成功，待用户确认");
}

/** 成员重置反馈属于发起账号，失败提示后仍明确抛出。 */
async function handleResetEnterpriseMemberPassword(payload: { membershipId: string; newPassword: string; confirmPassword: string }) {
  const owner = captureAccountSession(config);
  try {
    const result = await account.resetEnterpriseMemberPassword(payload.membershipId, {
      newPassword: payload.newPassword, confirmPassword: payload.confirmPassword,
    });
    if (!result.ok) throw createApiResultError(result);
    owner.assertCurrent();
    showResultToast(result, "成员密码已重置");
  } catch (error) {
    if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
    owner.assertResponseCurrent();
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function handleUpdateEnterpriseMemberStatus(payload: { membershipId: string; status: "active" | "disabled" }) {
  const result = await account.updateEnterpriseMemberStatus(payload.membershipId, payload.status, managedEnterpriseId.value);
  showResultToast(result, payload.status === "disabled" ? "成员已禁用" : "成员已启用");
}

async function handleRemoveEnterpriseMember(membershipId: string) {
  const result = await account.removeEnterpriseMember(membershipId, managedEnterpriseId.value);
  showResultToast(result, "成员已移除");
}

/** 按当前企业作用域读取移除返还预览。 */
async function previewRemoveEnterpriseMember(membershipId: string): Promise<PreviewRemoveEnterpriseMemberResponseBody> {
  const result = await account.previewRemoveEnterpriseMember(membershipId, managedEnterpriseId.value);
  if (!result.ok) {
    throw new Error(result.message || "移除预览失败");
  }
  return result;
}

async function handleLoadEnterpriseAudit(filters: AuditLogFilters) {
  const result = await account.loadEnterpriseAuditLogs(filters);
  if (!result.ok) {
    message.error(result.message || "审计记录加载失败");
  }
}

async function handleExportEnterpriseAudit(filters: AuditLogFilters) {
  const result = await account.exportEnterpriseAuditLogs(filters);
  if (!result.ok) {
    message.error(result.message || "审计记录导出失败");
    return;
  }
  message.success("审计记录已导出");
}

watch(
  managedEnterpriseId,
  (enterpriseId, previousEnterpriseId) => {
    if (!enterpriseId) return;
    void hydrateEnterprise(enterpriseId !== previousEnterpriseId);
  },
  { immediate: true },
);
</script>

<template>
  <div class="enterprise-management-panel">
    <a-alert
      v-if="!isEnterpriseAdmin"
      type="warning"
      show-icon
      message="当前账号无企业管理权限"
    />

    <EnterpriseDrawer
      v-else
      embedded
      :open="true"
      :show-audit-tab="false"
      :summary="account.enterpriseSummary"
      :members="account.enterpriseMembers"
      :members-total="account.enterpriseMembersTotal"
      :members-current="account.enterpriseMembersPage"
      :members-page-size="account.enterpriseMembersPageSize"
      :members-sort-by="account.enterpriseMembersSortBy"
      :members-sort-direction="account.enterpriseMembersSortDirection"
      :loading="account.enterpriseLoading"
      :adding-member="account.addingEnterpriseMember"
      :resetting-password="account.resettingEnterprisePassword"
      :updating-member-status="account.updatingEnterpriseMemberStatus"
      :removing-member="account.removingEnterpriseMember"
      :audit-logs="account.enterpriseAuditLogs"
      :audit-total="account.enterpriseAuditTotal"
      :audit-loading="account.enterpriseAuditLoading"
      :exporting-audit="account.exportingEnterpriseAudit"
      :preview-remove-member="previewRemoveEnterpriseMember"
      @add-member="handleAddEnterpriseMember"
      @load-members="handleLoadEnterpriseMembers"
      @reset-member-password="handleResetEnterpriseMemberPassword"
      @update-member-status="handleUpdateEnterpriseMemberStatus"
      @remove-member="handleRemoveEnterpriseMember"
      @load-audit="handleLoadEnterpriseAudit"
      @export-audit="handleExportEnterpriseAudit"
    />
  </div>
</template>

<style scoped>
.enterprise-management-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.enterprise-management-panel__selector {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 16px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.enterprise-management-panel__selector-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.enterprise-management-panel__selector-copy strong {
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.5;
}

.enterprise-management-panel__selector-copy span {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.enterprise-management-panel__selector-input {
  flex: 0 1 420px;
  width: min(420px, 50%);
}

.enterprise-management-panel__empty {
  display: grid;
  place-items: center;
  min-height: 280px;
}

@media (max-width: 900px) {
  .enterprise-management-panel__selector {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .enterprise-management-panel__selector-input {
    flex-basis: auto;
    width: 100%;
  }
}
</style>
