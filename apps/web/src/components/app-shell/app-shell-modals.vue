<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CloseOutlined } from "@ant-design/icons-vue";
import type {
  AuditLogFilters,
  CancelMyAccountRequestBody,
  EnterpriseMemberSortBy,
  EnterpriseMemberSortDirection,
  PreviewRemoveEnterpriseMemberResponseBody,
  ApiResult,
} from "@codeflowai/shared";

// 以下弹窗首屏无条件实例化（通用版必渲染），保持静态导入：改异步只会新增 Suspense 依赖并多一跳。
import ClientUpgradeModal from "../../features/settings/components/client-upgrade-modal.vue";
import ClientManagementModal from "../../features/settings/components/client-management-modal.vue";
import AccountDrawer from "../../features/account/components/account-drawer.vue";
import EnterpriseDrawer from "../../features/account/components/enterprise-drawer.vue";
import type { AppShellBindings } from "../../composables/useAppShell";
import { hasDirtyPreviewWindows, isDirtyPreviewWindow } from "../../features/explorer/previewWindowEditor";
import { captureAccountSession, useAccountStore } from "../../store/account";
import { isDesktopWorkspace } from "../../services/desktop";
import { createApiResultError, createCancelledRequestError, isCancelledRequestError } from "../../api/request";

defineOptions({ name: "AppShellModals" });

/**
 * 首屏不会实例化的低频弹窗/面板改为按需加载，避免其重依赖（diff-viewer、终端包等）进入首屏模块图。
 * 这些组件均由 v-if / portal 懒渲染控住，首屏不实例化，因此不会成为整壳 Suspense 的异步依赖。
 */
const WorkspaceManager = defineAsyncComponent(() => import("../../features/workspaces/components/workspace-manager.vue"));
const EngineKeysPanel = defineAsyncComponent(() => import("../../features/settings/components/engine-keys-panel.vue"));
const ExplorerPanel = defineAsyncComponent(() => import("../../features/explorer/components/explorer-panel.vue"));
const ExplorerPreviewWindow = defineAsyncComponent(() => import("../../features/explorer/components/explorer-preview-window.vue"));

/** 移动端首屏会实例化终端弹窗；关闭 suspensible，避免终端包阻塞整壳 Suspense。 */
const TerminalModal = defineAsyncComponent({
  loader: () => import("../../features/terminal/components/terminal-modal.vue"),
  suspensible: false,
});

const props = defineProps<{
  shell: AppShellBindings;
}>();
const shell = props.shell;
const account = useAccountStore();

/** 设置弹窗只展示 Web/Server 连接引导，Client 离线由工作区 Banner 和 Client 入口承载。 */
const showConnectionGuide = computed(() => !shell.config.isDesktop && Boolean(shell.connectError || !shell.config.connected));
const connectionGuideMessage = computed(() =>
  shell.connectError || "Web 正在连接服务，恢复后会自动加载工作区与 Client 状态。",
);
const connectionGuideDescription = "当前账号会话会保留，系统会自动重试连接；如需人工排查，可先查看接入说明。";

/** 任务栏关闭与窗口内关闭使用同一未保存确认，避免绕过草稿保护。 */
function closePreviewTab(target: (typeof shell.ui.explorerPreviewWindows)[number]): void {
  if (isDirtyPreviewWindow(target)) {
    Modal.confirm({ title: "有未保存的修改", content: "关闭后本窗口的修改将丢失。", okText: "放弃修改并关闭", cancelText: "继续编辑",
      onOk: () => shell.ui.closePreviewWindow(target.id) });
    return;
  }
  shell.ui.closePreviewWindow(target.id);
}

function closeAllPreviewTabs(): void {
  const windows = shell.ui.explorerPreviewWindows;
  const dirtyCount = windows.filter(isDirtyPreviewWindow).length;
  if (dirtyCount > 0) {
    Modal.confirm({ title: "有未保存的修改", content: `有 ${dirtyCount} 个预览窗口包含未保存修改，全部关闭后将丢失。`,
      okText: "全部放弃并关闭", cancelText: "取消", onOk: () => shell.ui.closeAllPreviewWindows() });
    return;
  }
  shell.ui.closeAllPreviewWindows();
}

function showResultToast(result: { ok: boolean; message?: string }, successMessage: string) {
  if (result.ok) {
    message.success(successMessage);
  } else {
    message.error(result.message || "操作失败");
  }
}

/** 账号动作共用会话修订校验，旧会话不能向新界面反馈。 */
async function handleAccountSelfService(action: () => Promise<ApiResult<object>>, successMessage: string) {
  const owner = captureAccountSession(shell.config);
  try {
    const result = await action();
    if (!result.ok) throw createApiResultError(result);
    owner.assertCurrent();
    showResultToast(result, successMessage);
  } catch (error) {
    if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
    owner.assertResponseCurrent();
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 默认Key发送失败保持rejection，不在页面重复发送邮件。 */
async function handleSendDefaultKey() {
  await handleAccountSelfService(() => account.sendDefaultKey(), "默认 Key 已发送到注册邮箱");
}

/** 只为仍拥有轮换结果的会话重连；重连失败保持失败态。 */
async function handleRotateDefaultKey() {
  const owner = captureAccountSession(shell.config);
  const serverWsOrigin = shell.config.serverWsOrigin;
  let result: Awaited<ReturnType<typeof account.rotateDefaultKey>>;
  try {
    result = await account.rotateDefaultKey();
    if (!result.ok) throw createApiResultError(result);
  } catch (error) {
    if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
    owner.assertResponseCurrent();
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }

  if (shell.config.serverWsOrigin !== serverWsOrigin || shell.config.sessionToken !== result.sessionToken
    || shell.config.userSummary?.userId !== result.userSummary.userId) throw createCancelledRequestError("scope-change");
  result.assertCurrent();
  if (shell.config.connected || shell.config.connectionStatus === "connecting" || shell.config.connectionStatus === "reconnecting") {
    shell.disconnect();
    try {
      await shell.connect();
      result.assertCurrent();
      if (shell.connectError) throw new Error(shell.connectError);
    } catch (error) {
      result.assertCurrent();
      console.error("[ACCOUNT_DEFAULT_KEY_RECONNECT_FAILED]", { code: "ACCOUNT_DEFAULT_KEY_RECONNECT_FAILED",
        requestId: `account-key-reconnect-${Date.now()}`, userId: result.userSummary.userId,
        cause: "默认 Key 轮换后 Web 重连失败" });
      message.warning(`默认 Key 已更换，但 Web 重连失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  result.assertCurrent();
  message.success("默认 Key 已更换，旧 Key 已失效");
}

/** 密码提交及刷新失败由同一提示边界明确报告。 */
async function handleChangePassword(payload: { oldPassword: string; newPassword: string; confirmPassword: string }) {
  await handleAccountSelfService(() => account.changePassword(payload), "密码修改成功");
}

/** 个人信息内的退出登录；失败提示由 useAppShell 统一负责，这里只阻止未处理拒绝。 */
async function handleDrawerLogout(): Promise<void> {
  try {
    await shell.logout();
  } catch {
    // shell.logout 已在自身边界提示非取消错误并向上抛出，此处不重复提示。
  }
}

/** 注销失败显式提示并上抛，成功收尾前再核对未出现新账号。 */
async function handleCancelAccount(payload: CancelMyAccountRequestBody) {
  const serverWsOrigin = shell.config.serverWsOrigin;
  try {
    const result = await account.cancelAccount(payload);
    if (!result.ok) throw createApiResultError(result);
    if (shell.config.sessionToken || shell.config.authMode === "account" || shell.config.serverWsOrigin !== serverWsOrigin) {
      throw createCancelledRequestError("scope-change");
    }
    message.success("账号已注销，可使用原邮箱重新注册");
    await shell.router.push("/");
  } catch (error) {
    if (!isCancelledRequestError(error) || error.kind !== "scope-change") {
      message.error(error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

/** 资料提示只归发起会话，失败继续向上抛出。 */
async function handleSaveProfile(payload: { fullName: string; phone: string; avatarUrl: string | null }) {
  const owner = captureAccountSession(shell.config);
  try {
    const result = await account.updateMyProfile(payload);
    if (!result.ok) throw createApiResultError(result);
    owner.assertCurrent();
    showResultToast(result, "个人信息已更新");
  } catch (error) {
    if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
    owner.assertResponseCurrent();
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** 校验会话后才执行头像表单回调，旧请求不得关闭新账号弹窗。 */
async function handleSaveAvatar(payload: { avatarUrl: string | null; onSuccess?: () => void; onError?: () => void }) {
  const owner = captureAccountSession(shell.config), userId = owner.userId;
  /** 回调异常归属原操作，日志只保存固定原因与安全定位。 */
  const reportCallbackFailure = (phase: "success" | "failure") => console.error("[ACCOUNT_AVATAR_CALLBACK_FAILED]", {
    code: "ACCOUNT_AVATAR_CALLBACK_FAILED", requestId: `account-avatar-callback-${Date.now()}`, userId, phase, cause: "头像表单回调失败",
  });
  let result: Awaited<ReturnType<typeof account.updateMyAvatar>>;
  try {
    result = await account.updateMyAvatar(payload.avatarUrl);
    if (!result.ok) throw createApiResultError(result);
  } catch (error) {
    if (isCancelledRequestError(error) && error.kind === "scope-change") throw error;
    owner.assertResponseCurrent();
    try { payload.onError?.(); }
    catch (callbackError) {
      reportCallbackFailure("failure");
      throw new AggregateError([error, callbackError], "ACCOUNT_AVATAR_FAILURE_CALLBACK_FAILED", { cause: error });
    }
    owner.assertResponseCurrent();
    message.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
  owner.assertCurrent();
  try { payload.onSuccess?.(); }
  catch (error) {
    reportCallbackFailure("success");
    if (owner.isCurrentResponse() && shell.config.sessionToken) {
      message.error("头像已保存，但界面更新失败，请重新打开账号面板");
    }
    throw error;
  }
  owner.assertCurrent();
  showResultToast(result, "头像已更新");
}

/** 企业保存复用账号提示边界，同企业换账号也禁止旧反馈。 */
async function handleSaveEnterprise(payload: { name?: string; contactName?: string; contactEmail?: string; contactPhone?: string }) {
  await handleAccountSelfService(() => account.updateEnterpriseProfile(payload), "企业信息已更新");
}

/** 独立企业抽屉翻页时复用 store 成员分页状态，保证自动刷新仍停留在当前页。 */
async function handleLoadEnterpriseMembers(payload: {
  page: number;
  pageSize: number;
  sortBy?: EnterpriseMemberSortBy | "";
  sortDirection?: EnterpriseMemberSortDirection | "";
}) {
  await account.loadEnterpriseMembers(true, {
    page: payload.page,
    pageSize: payload.pageSize,
    sortBy: payload.sortBy,
    sortDirection: payload.sortDirection,
  });
}

async function handleAddEnterpriseMember(email: string) {
  const result = await account.addEnterpriseMember(email);
  showResultToast(result, "添加成功，待用户确认");
}

/** 邀请结果提示沿账号边界，旧操作不影响新账号界面。 */
async function handleRespondEnterpriseInvitation(payload: { invitationId: string; action: "accept" | "decline" }) {
  await handleAccountSelfService(() => account.respondEnterpriseInvitation(payload.invitationId, payload.action),
    payload.action === "accept" ? "已确认加入企业" : "已拒绝企业邀请");
}

/** 成员密码提示复用原会话边界，避免旧操作向新账号反馈。 */
async function handleResetEnterpriseMemberPassword(payload: { membershipId: string; newPassword: string; confirmPassword: string }) {
  await handleAccountSelfService(() => account.resetEnterpriseMemberPassword(payload.membershipId, {
    newPassword: payload.newPassword,
    confirmPassword: payload.confirmPassword,
  }), "成员密码已重置");
}

async function handleUpdateEnterpriseMemberStatus(payload: { membershipId: string; status: "active" | "disabled" }) {
  const result = await account.updateEnterpriseMemberStatus(payload.membershipId, payload.status);
  showResultToast(result, payload.status === "disabled" ? "成员已禁用" : "成员已启用");
}

async function handleRemoveEnterpriseMember(membershipId: string) {
  const result = await account.removeEnterpriseMember(membershipId);
  showResultToast(result, "成员已移除");
}

/** 打开移除确认前读取后端返还预览，避免前端自行推导额度口径。 */
async function previewRemoveEnterpriseMember(membershipId: string): Promise<PreviewRemoveEnterpriseMemberResponseBody> {
  const result = await account.previewRemoveEnterpriseMember(membershipId);
  if (!result.ok) {
    throw new Error(result.message || "移除预览失败");
  }
  return result;
}

function handleAccountDrawerOpenChange(open: boolean) {
  if (open) {
    void account.openAccountDrawer();
    return;
  }
  account.closeAccountDrawer();
}

/** Load the enterprise drawer through the existing account boundary. */
function handleEnterpriseDrawerOpenChange(open: boolean) {
  if (open) {
    void account.openEnterpriseDrawer();
    return;
  }
  account.closeEnterpriseDrawer();
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

</script>

<template>
  <a-modal
    :open="shell.settingsOpen"
    :footer="null"
    :closable="true"
    :mask-closable="false"
    @cancel="shell.settingsOpen = false"
    :width="shell.config.isDesktop ? 880 : 720"
    :destroy-on-close="false"
    wrap-class-name="settings-modal settings-modal--shell"
    :body-style="shell.isMobileModalViewport ? { padding: 0 } : { padding: 0, height: 'min(640px, calc(100dvh - 150px))', display: 'flex', flexDirection: 'column', overflow: 'hidden' }"
    centered
  >
    <template #closeIcon><CloseOutlined /></template>
    <template #title>
      <div class="settings-modal__title">
        <strong>设置</strong>
        <span>{{ shell.config.isDesktop ? "模型连接与密钥" : "工作区、模型连接与桌面更新" }}</span>
      </div>
    </template>

    <a-alert v-if="shell.config.desktopError" class="settings-modal__alert" type="error" show-icon :message="shell.config.desktopError">
      <template #action><a-button size="small" @click="shell.config.refreshDesktopRuntime()">重试</a-button></template>
    </a-alert>

    <div v-if="shell.isMobileModalViewport" class="settings-modal__mobile-pane">
      <div
        v-if="showConnectionGuide"
        style="display: grid; gap: 12px; margin-bottom: 16px"
      >
        <a-alert
          type="warning"
          show-icon
          :message="connectionGuideMessage"
          :description="connectionGuideDescription"
        />
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
          <a-button
            v-if="!shell.config.connected && shell.config.hasActiveSession"
            type="primary"
            :loading="shell.config.connectionStatus === 'connecting' || shell.config.connectionStatus === 'reconnecting'"
            @click="shell.connect"
          >
            {{ shell.config.connectionStatus === 'connecting' || shell.config.connectionStatus === 'reconnecting' ? '连接中' : '重试连接' }}
          </a-button>
          <a-button
            v-else-if="!shell.config.connected && !shell.config.hasActiveSession"
            type="primary"
            @click="shell.settingsOpen = false; shell.pushLoginRoute()"
          >
            去登录
          </a-button>
        </div>
      </div>

      <EngineKeysPanel v-if="shell.settingsActiveTab === 'engine-keys'" :active="shell.settingsOpen && shell.settingsActiveTab === 'engine-keys'" />

      <template v-else>
        <WorkspaceManager :active="shell.settingsOpen && shell.settingsActiveTab === 'workspaces'" />
        <div
          v-if="shell.isLandingRoute"
          class="settings-modal__landing-entry"
        >
          <span>{{ shell.config.workspaceId ? '工作区已就绪，可以开始使用' : '请先选择或新建一个工作区' }}</span>
          <a-button type="primary" :disabled="!shell.config.workspaceId" @click="shell.settingsOpen = false; shell.router.push('/chat')">进入应用</a-button>
        </div>
      </template>
    </div>

    <div v-else class="settings-modal__desktop">
      <div
        v-if="showConnectionGuide"
        class="settings-modal__guide"
      >
        <a-alert
          type="warning"
          show-icon
          :message="connectionGuideMessage"
          :description="connectionGuideDescription"
        />
        <div class="settings-modal__guide-actions">
          <a-button
            v-if="!shell.config.connected && shell.config.hasActiveSession"
            type="primary"
            :loading="shell.config.connectionStatus === 'connecting' || shell.config.connectionStatus === 'reconnecting'"
            @click="shell.connect"
          >
            {{ shell.config.connectionStatus === 'connecting' || shell.config.connectionStatus === 'reconnecting' ? '连接中' : '重试连接' }}
          </a-button>
          <a-button
            v-else-if="!shell.config.connected && !shell.config.hasActiveSession"
            type="primary"
            @click="shell.settingsOpen = false; shell.pushLoginRoute()"
          >
            去登录
          </a-button>
        </div>
      </div>

      <div v-if="shell.config.isDesktop" class="settings-modal__single">
        <EngineKeysPanel :active="shell.settingsOpen" />
      </div>

      <a-tabs
        v-else
        v-model:activeKey="shell.settingsActiveTab"
        tab-position="left"
        class="settings-modal__tabs settings-modal__tabs--side"
      >
        <a-tab-pane key="workspaces" tab="工作区" :disabled="!shell.config.canManageWorkspaces">
          <WorkspaceManager :active="shell.settingsOpen && shell.settingsActiveTab === 'workspaces'" />
          <div
            v-if="shell.isLandingRoute"
            class="settings-modal__landing-entry"
          >
            <span>{{ shell.config.workspaceId ? '工作区已就绪，可以开始使用' : '请先选择或新建一个工作区' }}</span>
            <a-button type="primary" :disabled="!shell.config.workspaceId" @click="shell.settingsOpen = false; shell.router.push('/chat')">进入应用</a-button>
          </div>
        </a-tab-pane>

        <a-tab-pane key="engine-keys" tab="模型配置" :disabled="!(shell.config.connected || isDesktopWorkspace(shell.config, shell.config.workspaceId))">
          <EngineKeysPanel :active="shell.settingsOpen && shell.settingsActiveTab === 'engine-keys'" />
        </a-tab-pane>
      </a-tabs>
    </div>
  </a-modal>

  <ClientUpgradeModal v-model:open="shell.clientUpgradeOpen" />
  <ClientManagementModal v-model:open="shell.clientManagementOpen" />
  <TerminalModal v-if="shell.isMobileModalViewport" v-model:open="shell.terminalOpen" />

  <a-modal
    :open="shell.explorerOpen"
    title="文件浏览器"
    :footer="null"
    :closable="true"
    :mask-closable="true"
    @cancel="shell.explorerOpen = false"
    :width="'92%'"
    :destroy-on-close="true"
    wrap-class-name="explorer-modal"
    centered
  >
    <template #closeIcon><CloseOutlined /></template>
    <ExplorerPanel v-if="shell.explorerOpen && shell.config.workspaceId" :workspace-id="shell.config.workspaceId" />
    <div v-else-if="shell.explorerOpen && !shell.config.workspaceId" style="padding: 48px; text-align: center; color: var(--app-muted)">
      请先选择工作区
    </div>
  </a-modal>

  <ExplorerPreviewWindow v-for="pw in shell.ui.explorerPreviewWindows" :key="pw.id" :win="pw" />

  <Teleport to="body">
    <div v-if="shell.ui.explorerPreviewWindows.length >= 2" class="preview-taskbar">
      <div
        v-for="pw in shell.ui.explorerPreviewWindows"
        :key="pw.id"
        class="preview-taskbar__tab"
        :class="{ 'preview-taskbar__tab--active': pw.zIndex === shell.maxPreviewZ }"
        @click="shell.ui.bringPreviewWindowToFront(pw.id)"
      >
        <span class="preview-taskbar__tab-name" :title="pw.filePath">{{ shell.previewWindowFileName(pw.filePath) }}</span>
        <span class="preview-taskbar__tab-close" @click.stop="closePreviewTab(pw)">&times;</span>
      </div>
      <div class="preview-taskbar__close-all" @click="closeAllPreviewTabs">全部关闭</div>
    </div>
  </Teleport>

  <a-modal
    v-if="shell.mode === 'mobile' || shell.config.isDesktop"
    :open="shell.workspaceManagerOpen"
    title="工作区管理"
    :footer="null"
    :closable="true"
    :mask-closable="true"
    @cancel="shell.workspaceManagerOpen = false"
    :width="600"
    :destroy-on-close="false"
    wrap-class-name="workspace-manager-modal"
    centered
  >
    <template #closeIcon><CloseOutlined /></template>
    <WorkspaceManager v-if="shell.config.canManageWorkspaces" :active="shell.workspaceManagerOpen" />
    <div v-else style="padding: 32px; text-align: center; color: var(--app-muted)">
      请先连接 Server
    </div>
  </a-modal>

  <AccountDrawer
    :responding-enterprise-invitation="account.respondingEnterpriseInvitation"
    :open="account.accountDrawerOpen"
    :initial-tab="account.accountDrawerTab"
    :surface="account.accountDrawerSurface"
    :summary="account.meSummary"
    :loading="account.meLoading"
    :saving-profile="account.savingMeProfile"
    :saving-enterprise-profile="account.savingEnterpriseProfile"
    :rotating-key="account.rotatingDefaultKey"
    @respond-enterprise-invitation="handleRespondEnterpriseInvitation"
    :sending-key="account.sendingDefaultKey"
    :changing-password="account.changingPassword"
    :logging-out="shell.config.logoutInProgress"
    :cancelling-account="account.cancellingAccount"
    @update:open="handleAccountDrawerOpenChange"
    @send-key="handleSendDefaultKey"
    @rotate-key="handleRotateDefaultKey"
    @save-avatar="handleSaveAvatar"
    @save-profile="handleSaveProfile"
    @save-enterprise="handleSaveEnterprise"
    @change-password="handleChangePassword"
    @logout="handleDrawerLogout"
    @cancel-account="handleCancelAccount"
  />
  <EnterpriseDrawer
    :open="account.enterpriseDrawerOpen"
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
    @update:open="handleEnterpriseDrawerOpenChange"
    @add-member="handleAddEnterpriseMember"
    @load-members="handleLoadEnterpriseMembers"
    @reset-member-password="handleResetEnterpriseMemberPassword"
    @update-member-status="handleUpdateEnterpriseMemberStatus"
    @remove-member="handleRemoveEnterpriseMember"
    @load-audit="handleLoadEnterpriseAudit"
    @export-audit="handleExportEnterpriseAudit"
  />
</template>


<style scoped>
:global(.settings-modal--shell .ant-modal-content) {
  padding: 0;
  overflow: hidden;
  border-radius: 16px;
}

:global(.settings-modal--shell .ant-modal-header) {
  padding: 20px 24px 0;
  margin: 0;
}

:global(.settings-modal--shell .ant-modal-body) {
  padding: 0;
}

.settings-modal__title {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-modal__title strong {
  color: var(--app-text);
  font-size: 18px;
  font-weight: 600;
}

.settings-modal__title span {
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 400;
}

.settings-modal__alert {
  margin: 16px 24px 0;
}

.settings-modal__mobile-pane {
  padding: 20px 24px 24px;
}

.settings-modal__desktop {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
}

.settings-modal__guide {
  display: grid;
  gap: 10px;
  padding: 16px 24px 0;
}

.settings-modal__guide-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.settings-modal__single {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 22px 24px;
}

.settings-modal__tabs--side {
  display: flex;
  flex: 1 1 0;
  min-height: 0;
}

.settings-modal__tabs--side :deep(.ant-tabs-nav) {
  width: 196px;
  margin: 0;
  padding: 16px 12px;
  background: var(--app-bg-secondary);
}

.settings-modal__tabs--side :deep(.ant-tabs-nav-wrap),
.settings-modal__tabs--side :deep(.ant-tabs-nav-list) {
  width: 100%;
}

.settings-modal__tabs--side :deep(.ant-tabs-nav-list) {
  gap: 4px;
}

.settings-modal__tabs--side :deep(.ant-tabs-tab) {
  justify-content: flex-start;
  margin: 0 !important;
  padding: 10px 14px;
  border-radius: 10px;
}

.settings-modal__tabs--side :deep(.ant-tabs-tab-btn) {
  color: var(--app-muted);
  font-size: 14px;
}

.settings-modal__tabs--side :deep(.ant-tabs-tab-active) {
  position: relative;
  background: var(--app-panel-bg);
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 6px 16px rgba(15, 23, 42, 0.05);
}

.settings-modal__tabs--side :deep(.ant-tabs-tab-active::before) {
  content: "";
  position: absolute;
  left: 6px;
  top: 50%;
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: var(--app-accent);
  transform: translateY(-50%);
}

.settings-modal__tabs--side :deep(.ant-tabs-tab-active .ant-tabs-tab-btn) {
  color: var(--app-text);
  font-weight: 600;
}

.settings-modal__tabs--side :deep(.ant-tabs-ink-bar) {
  display: none;
}

.settings-modal__tabs--side :deep(.ant-tabs-content-holder) {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
}

.settings-modal__tabs--side :deep(.ant-tabs-content) {
  height: 100%;
  max-height: none;
}

.settings-modal__tabs--side :deep(.ant-tabs-tabpane) {
  height: 100%;
  overflow: auto;
  padding: 22px 24px;
}

.settings-modal__landing-entry {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--app-divider);
  color: var(--app-muted);
  font-size: 13px;
}
</style>
