<script setup lang="ts">
import type {
  AccountH5BootstrapResponse,
  AccountH5BootstrapStatus,
  AccountLoginResponseBody,
  ApiResult,
  ChatWorkflowActiveStatus,
  FeedbackAction,
  OfficeH5Action,
  OfficeH5BootstrapResponse,
  OfficeH5BootstrapStatus,
  OfficeH5EntitlementSummary,
  OfficePlatform,
  PendingMineListItem,
  ThreadRunningState,
  ThreadSummary,
  ThreadWorkflowState,
  WorkspaceSummary,
  WorkspaceId,
} from "@codeflowai/shared";
import { resolveThreadPrefsWithCatalogDefaults } from "@codeflowai/shared";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";

import { isCancelledRequestError, type ApiRequestContext } from "../../../api/request";
import { listWorkspaces } from "../../../api/workspaces";
import {
  archiveOfficeH5Thread,
  bootstrapAccountH5,
  bootstrapOfficeH5,
  createOfficeH5RequestId,
  createOfficeH5Thread,
  deleteOfficeH5Thread,
  getOfficeH5LoginOptions,
  getOfficeH5ThreadPrefs,
  guardOfficeH5Action,
  interruptOfficeH5Turn,
  listOfficeH5PendingMine,
  listOfficeH5Threads,
  loadOfficeH5Thread,
  renameOfficeH5Thread,
  resumeOfficeH5,
  resumeOfficeH5OrchInstance,
  sendOfficeH5Message,
  skipOfficeH5OrchNode,
  startOfficeH5OAuth,
  startOfficeH5OrchNode,
  submitOfficeH5OrchFeedback,
  type OfficeH5HttpMeta,
} from "../../../api/office-h5";
import { pushLoginRoute, resolvePostLoginTarget } from "../../account/loginRedirect";
import { resolveOfficeH5CorpId } from "../officeH5EntryResolution";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { replayOfficeH5Conversation, type OfficeH5ConversationMessage } from "../officeH5Conversation";
import { hasOfficeH5CallbackQuery, stripOfficeH5CallbackQuery } from "../officeH5CallbackQuery";
import { normalizeOfficeH5PreferredWorkspaceId, resolveOfficeH5WorkspaceSelection } from "../officeH5Workspace";
import { stageOfficeH5BootstrapHandoff } from "../officeH5Resume";
import { trackProductEvent } from "../../../analytics/analytics";

type H5EntryMode = "office" | "account";

const props = withDefaults(defineProps<{ entryMode?: H5EntryMode }>(), {
  entryMode: "office",
});

const emit = defineEmits<{
  (event: "logout"): void;
}>();

const copy = {
  title: "\u529e\u516c H5 \u5de5\u4f5c\u53f0",
  subtitle: "\u4f1a\u8bdd\u3001\u6267\u884c\u4e0e\u6d41\u7a0b\u5f85\u529e",
  wecom: "\u4f01\u4e1a\u5fae\u4fe1",
  dingtalk: "\u9489\u9489",
  accountH5: "CodeFlow H5",
  checking: "\u6b63\u5728\u6821\u9a8c\u529e\u516c\u5165\u53e3",
  checkingAccount: "\u6b63\u5728\u6821\u9a8c\u8d26\u53f7 H5 \u5165\u53e3",
  ready: "\u5df2\u5c31\u7eea",
  blocked: "\u5165\u53e3\u88ab\u963b\u65ad",
  retry: "\u91cd\u8bd5",
  openWeb: "\u6253\u5f00 Web",
  bindAccount: "\u767b\u5f55\u5e76\u7ed1\u5b9a",
  refresh: "\u5237\u65b0",
  threads: "\u4f1a\u8bdd",
  pending: "\u5f85\u529e",
  account: "\u8d26\u53f7",
  workspace: "\u5de5\u4f5c\u533a",
  package: "\u5957\u9910",
  token: "Token",
  createThread: "\u65b0\u5efa\u4f1a\u8bdd",
  newThreadPlaceholder: "\u8f93\u5165\u4f1a\u8bdd\u6807\u9898",
  emptyThreads: "\u6682\u65e0\u4f1a\u8bdd\uff0c\u53ef\u4ee5\u5148\u65b0\u5efa\u4e00\u4e2a H5 \u4f1a\u8bdd\u3002",
  sendPlaceholder: "\u8f93\u5165\u8981\u6267\u884c\u7684\u5185\u5bb9",
  send: "\u53d1\u9001",
  interrupt: "\u4e2d\u65ad",
  rename: "\u91cd\u547d\u540d",
  archive: "\u5f52\u6863",
  delete: "\u5220\u9664",
  renamePrompt: "\u8f93\u5165\u65b0\u4f1a\u8bdd\u540d\u79f0",
  deleteConfirm: "\u786e\u8ba4\u5220\u9664\u8be5\u4f1a\u8bdd\uff1f",
  pendingEmpty: "\u6682\u65e0\u9700\u4f60\u5904\u7406\u7684\u6d41\u7a0b\u5f85\u529e\u3002",
  pendingFocusHint: "\u4f18\u5148\u5904\u7406\u9700\u8981\u4f60\u786e\u8ba4\u7684\u6d41\u7a0b\u4e8b\u9879",
  approve: "\u901a\u8fc7",
  requestChanges: "\u8981\u6c42\u4fee\u6539",
  clarify: "\u63d0\u4ea4\u8865\u5145",
  startNode: "\u542f\u52a8\u8282\u70b9",
  skipNode: "\u8df3\u8fc7\u8282\u70b9",
  resume: "\u7ee7\u7eed",
  requestChangesPlaceholder: "\u8981\u6c42\u4fee\u6539\u65f6\u8bf7\u586b\u5199\u5177\u4f53\u610f\u89c1",
  clarifyPlaceholder: "\u586b\u5199\u9700\u8981\u8865\u5145\u7684\u8bf4\u660e\u6216\u8f93\u5165",
  running: "\u8fd0\u884c\u4e2d",
  idle: "\u7a7a\u95f2",
  workflowWaitingExecution: "\u7b49\u5f85\u6267\u884c",
  workflowWaitingStart: "\u5f85\u542f\u52a8",
  workflowWaitingApproval: "\u5f85\u786e\u8ba4",
  workflowWaitingFeedback: "\u5f85\u8865\u5145",
  workflowPaused: "\u5df2\u6682\u505c",
  available: "\u53ef\u7528",
  limited: "\u53d7\u9650",
  unknown: "\u672a\u77e5",
  unavailable: "\u4e0d\u53ef\u7528",
  missingEntry: "\u5165\u53e3\u7f3a\u5c11 code\u3001state \u6216 corpId\uff0c\u8bf7\u4ece\u529e\u516c\u5e73\u53f0\u91cd\u65b0\u8fdb\u5165\u3002",
  missingAccountSession: "\u767b\u5f55\u4f1a\u8bdd\u5df2\u5931\u6548\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55\u3002",
  noThreadSelected: "\u8bf7\u5148\u9009\u62e9\u4f1a\u8bdd",
  actionBlocked: "\u64cd\u4f5c\u88ab\u963b\u65ad",
  actionDone: "\u64cd\u4f5c\u5df2\u63d0\u4ea4",
  conversationTitle: "\u4f1a\u8bdd\u5185\u5bb9",
  conversationEmpty: "\u5f53\u524d\u4f1a\u8bdd\u8fd8\u6ca1\u6709\u6d88\u606f\u3002",
  conversationLoading: "\u6b63\u5728\u52a0\u8f7d\u4f1a\u8bdd\u3002\u3002\u3002",
  assistantWorking: "CodeFlow \u6b63\u5728\u56de\u590d",
  userLabel: "\u4f60",
  assistantLabel: "CodeFlow",
  currentNode: "\u5f53\u524d\u8282\u70b9",
  viewOnlyPending: "\u5f53\u524d\u4e8b\u9879\u53ea\u9700\u67e5\u770b\uff0c\u65e0\u9700\u64cd\u4f5c\u3002",
  feedbackRequired: "\u8bf7\u5148\u586b\u5199\u64cd\u4f5c\u610f\u89c1\u3002",
  pendingTargetMissing: "\u5f53\u524d\u5f85\u529e\u7f3a\u5c11\u6d41\u7a0b\u5b9e\u4f8b\u6216\u8282\u70b9\u6807\u8bc6\uff0c\u65e0\u6cd5\u6267\u884c\u3002",
  accountMenu: "\u8d26\u53f7\u7ba1\u7406",
  currentAccount: "\u5f53\u524d CodeFlow \u8d26\u53f7",
  switchAccount: "\u5207\u6362 CodeFlow \u8d26\u53f7",
  manageBinding: "\u66f4\u6362\u6216\u7ba1\u7406\u7ed1\u5b9a",
  logout: "\u9000\u51fa\u767b\u5f55",
  closeAccountPanel: "\u5173\u95ed\u8d26\u53f7\u9762\u677f",
  logoutHint: "\u9000\u51fa\u53ea\u64a4\u9500\u5f53\u524d CodeFlow \u4f1a\u8bdd\uff0c\u4f01\u4e1a\u5fae\u4fe1\u548c\u9489\u9489\u7ed1\u5b9a\u7ee7\u7eed\u4fdd\u7559\u3002",
  logoutConfirm: "\u786e\u8ba4\u9000\u51fa\u5f53\u524d CodeFlow \u8d26\u53f7\uff1f\u529e\u516c\u5e73\u53f0\u7ed1\u5b9a\u4e0d\u4f1a\u89e3\u9664\u3002",
  workspaceRequired: "\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u5df2\u8fde\u63a5\u7684\u5de5\u4f5c\u533a\u3002",
  modelUnavailable: "\u5f53\u524d\u4f1a\u8bdd\u672a\u914d\u7f6e\u53ef\u7528\u6a21\u578b\uff0c\u8bf7\u5148\u5728 Web \u7aef\u9009\u62e9\u6a21\u578b\u540e\u91cd\u8bd5\u3002",
  oauthRedirectFailed: "\u672a\u80fd\u6253\u5f00\u529e\u516c\u5e73\u53f0\u6388\u6743\u9875\uff0c\u8bf7\u91cd\u8bd5\u3002",
};

type TabKey = "threads" | "pending";
type PendingAction = "approve" | "request_changes" | "clarify" | "start" | "skip" | "resume";

type PendingActionOption = {
  key: PendingAction;
  label: string;
  primary?: boolean;
};

const route = useRoute();
const router = useRouter();
const config = useConfigStore();
const engines = useEngineStore();

const activeTab = ref<TabKey>("threads");
const bootstrapState = ref<OfficeH5BootstrapResponse | AccountH5BootstrapResponse | null>(null);
const loading = ref(true);
const oauthNavigationPending = ref(false);
const refreshing = ref(false);
const actionBusy = ref<string | null>(null);
const accountPanelOpen = ref(false);
const entryErrorMessage = ref<string | null>(null);
const dataErrorMessage = ref<string | null>(null);
const latestGuardMessage = ref<string | null>(null);
const threads = ref<ThreadSummary[]>([]);
const runningByThreadId = ref<Record<string, ThreadRunningState>>({});
const workflowByThreadId = ref<Record<string, ThreadWorkflowState>>({});
const pendingItems = ref<PendingMineListItem[]>([]);
const workspaceOptions = ref<WorkspaceSummary[]>([]);
const selectedThreadId = ref<string>("");
const conversationMessages = ref<OfficeH5ConversationMessage[]>([]);
const conversationLoading = ref(false);
const conversationErrorMessage = ref<string | null>(null);
const conversationListRef = ref<HTMLElement | null>(null);
const awaitingTurnId = ref("");
const pendingFeedbackDrafts = ref<Record<string, string>>({});
const newThreadTitle = ref("");
const messageDraft = ref("");
const workspaceId = ref<WorkspaceId>("");

const accountEntry = computed(() => props.entryMode === "account");
const platform = computed<OfficePlatform>(() => route.path.includes("dingtalk") ? "dingtalk" : "wecom");
const platformLabel = computed(() => accountEntry.value ? copy.accountH5 : platform.value === "wecom" ? copy.wecom : copy.dingtalk);
const shellVariant = computed(() => accountEntry.value ? "account" : platform.value);
const routeCorpId = computed(() => String(route.query.corpId ?? route.query.corpid ?? route.query.corp_id ?? "").trim());
const routeEnterpriseId = computed(() => String(route.query.enterpriseId ?? "").trim());
const routeAuthCode = computed(() => String(route.query.code ?? route.query.authCode ?? route.query.auth_code ?? "").trim());
const routeState = computed(() => String(route.query.state ?? "").trim());
const routeWorkspaceId = computed(() => String(route.query.workspaceId ?? route.query.workspace ?? route.query.workspace_id ?? "").trim());
const ready = computed(() => bootstrapState.value?.status === "ready");
const blocked = computed(() => Boolean(bootstrapState.value && bootstrapState.value.status !== "ready"));
const showBindAccountAction = computed(() => bootstrapState.value?.reasonCode === "OFFICE_H5_UNBOUND");
const selectedThread = computed(() => threads.value.find((item) => item.id === selectedThreadId.value) ?? null);
const selectedThreadRunning = computed(() => selectedThreadId.value ? runningByThreadId.value[selectedThreadId.value] ?? null : null);
/** 会话工作流活跃档位 → 本文件 copy 表词条；运行中复用 running。 */
const workflowPillCopy: Record<ChatWorkflowActiveStatus, keyof typeof copy> = {
  pending: "workflowWaitingExecution",
  running: "running",
  paused: "workflowPaused",
  "waiting-start": "workflowWaitingStart",
  "waiting-approval": "workflowWaitingApproval",
  "waiting-feedback": "workflowWaitingFeedback",
};
/** 会话行右侧胶囊：turn 运行中优先，其次是活跃工作流标签，都没有时显示空闲。 */
const threadPillByThreadId = computed<Record<string, { label: string; className: string }>>(() => Object.fromEntries(
  threads.value.map((thread) => {
    const workflow = workflowByThreadId.value[String(thread.id)];
    if (runningByThreadId.value[String(thread.id)]) return [String(thread.id), { label: copy.running, className: "run-pill" }];
    if (workflow) return [String(thread.id), {
      label: copy[workflowPillCopy[workflow.status]],
      className: workflow.status === "running" ? "run-pill" : "workflow-pill",
    }];
    return [String(thread.id), { label: copy.idle, className: "idle-pill" }];
  }),
));
const conversationAwaitingReply = computed(() => Boolean(selectedThreadRunning.value || awaitingTurnId.value));
const conversationHasStreamingReply = computed(() => conversationMessages.value.some((message) => message.streaming));
const entitlement = computed<OfficeH5EntitlementSummary | null>(() => bootstrapState.value?.entitlement ?? null);
const officeBootstrapState = computed<OfficeH5BootstrapResponse | null>(() => {
  const state = bootstrapState.value;
  return state && "platformContext" in state ? state : null;
});
const canSend = computed(() => Boolean(
  ready.value
  && workspaceId.value
  && selectedThread.value
  && messageDraft.value.trim()
  && !actionBusy.value,
));
const webChatHref = computed(() => "/chat");
const webOrchHref = computed(() => "/orchestration/workspace");

let refreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
let conversationRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let oauthNavigationFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let conversationPollAttemptsRemaining = 0;
let optimisticConversationMessage: OfficeH5ConversationMessage | null = null;

function apiContext(): ApiRequestContext {
  return {
    serverWsOrigin: config.serverWsOrigin,
    sessionToken: config.sessionToken,
    webSessionId: config.webSessionId,
    isLogoutInProgress: () => config.logoutInProgress,
    ensureSession: (signal?: AbortSignal) => config.ensureSession(signal),
    clearSession: () => config.clearSession(),
  };
}

function clientKind(): "mobile" | "desktop" | "unknown" {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent.toLowerCase();
  if (/android|iphone|ipad|mobile/.test(ua)) return "mobile";
  if (ua) return "desktop";
  return "unknown";
}

function applyOfficeSession(data: OfficeH5BootstrapResponse): void {
  if (!data.sessionToken || !data.sessionExpiresAt || !data.userSummary || !data.accountRole || !data.accessContext) return;
  const login: AccountLoginResponseBody = {
    sessionToken: data.sessionToken,
    sessionExpiresAt: data.sessionExpiresAt,
    serverNow: data.serverNow,
    authMode: "account",
    accountRole: data.accountRole,
    homePath: data.homePath || "/chat",
    userSummary: data.userSummary,
    accessContext: data.accessContext,
  };
  config.setAccountSession(login);
}

/** 保存 Server 签发的办公入口恢复凭证，不接受缺少有效期的结果。 */
function applyOfficeH5ResumeCredential(data: OfficeH5BootstrapResponse): void {
  const credential = String(data.resumeCredential ?? "").trim();
  const expiresAt = Number(data.resumeExpiresAt ?? 0);
  if (!credential || expiresAt <= Date.now()) return;
  config.setOfficeH5Resume({
    platform: data.platformContext.platform,
    corpId: data.platformContext.corpId,
    credential,
    expiresAt,
  });
}

/** 构造当前 H5 请求上下文；账号模式不携带办公平台字段。 */
function currentMeta(actionPrefix = "h5_action"): OfficeH5HttpMeta {
  if (accountEntry.value) {
    return {
      entryChannel: "h5",
      requestId: createOfficeH5RequestId(actionPrefix),
    };
  }
  const context = officeBootstrapState.value?.platformContext;
  return {
    entryChannel: "office_h5",
    platform: context?.platform ?? platform.value,
    corpId: context?.corpId ?? routeCorpId.value,
    enterpriseId: context?.enterpriseId ?? null,
    requestId: createOfficeH5RequestId(actionPrefix),
  };
}

function statusText(status: OfficeH5BootstrapStatus | AccountH5BootstrapStatus | undefined): string {
  if (!status || status === "checking") return accountEntry.value ? copy.checkingAccount : copy.checking;
  if (status === "ready") return copy.ready;
  return copy.blocked;
}

function formatTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Map package and token states to compact labels. */
function entitlementStatusText(status: string | null | undefined): string {
  if (status === "available") return copy.available;
  if (status === "limited") return copy.limited;
  if (status === "unavailable") return copy.unavailable;
  return copy.unknown;
}

/** 未绑定时进入账号登录；已有会话必须显式切换后再绑定目标平台。 */
async function openAccountBinding(): Promise<void> {
  const corpId = routeCorpId.value;
  if (!corpId) {
    entryErrorMessage.value = copy.missingEntry;
    return;
  }
  if (config.hasActiveSession) {
    await router.push({
      path: "/h5",
      query: {
        openOfficeBindings: "1",
        switchAccount: "1",
        switchPlatform: platform.value,
        bindPlatform: platform.value,
        bindCorpId: corpId,
      },
    });
    return;
  }
  const target = router.resolve(resolvePostLoginTarget("/h5", { redirect: route.query.redirect }));
  const currentFullPath = router.resolve({
    path: target.path,
    query: {
      ...target.query,
      openOfficeBindings: "1",
      bindPlatform: platform.value,
      bindCorpId: corpId,
    },
    hash: target.hash,
  }).fullPath;
  await pushLoginRoute(router, {
    currentFullPath,
    surface: "h5",
  });
}

/** 打开统一账号绑定页；切换模式会保留当前办公平台作为操作目标。 */
async function openAccountSettings(mode: "manage" | "switch"): Promise<void> {
  const query: Record<string, string> = { openOfficeBindings: "1" };
  if (mode === "switch") {
    query.switchAccount = "1";
    query.switchPlatform = platform.value;
  }
  accountPanelOpen.value = false;
  await router.push({ path: "/h5", query });
}

/** 清理一次性 OAuth 参数后退出，平台绑定仍由用户显式解除。 */
async function confirmLogout(): Promise<void> {
  if (!window.confirm(copy.logoutConfirm)) return;
  accountPanelOpen.value = false;
  await router.replace({ path: "/h5" });
  emit("logout");
}

/** 构造 OAuth 回跳地址，并显式带回当前办公平台和 CodeFlow 企业作用域。 */
function buildOAuthRedirectUri(corpId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("code");
  url.searchParams.delete("authCode");
  url.searchParams.delete("auth_code");
  url.searchParams.delete("state");
  url.searchParams.set("corpId", corpId);
  if (routeEnterpriseId.value) url.searchParams.set("enterpriseId", routeEnterpriseId.value);
  else url.searchParams.delete("enterpriseId");
  return url.toString();
}

/** 发起办公平台 OAuth；调用方必须先解析出可用 CorpId 和可选企业作用域。 */
async function startOfficeAuthorization(corpId: string): Promise<void> {
  trackProductEvent("oauth_bind_start", { source: "office_h5", oauth_provider: platform.value });
  let res: Awaited<ReturnType<typeof startOfficeH5OAuth>>;
  try {
    res = await startOfficeH5OAuth(config.serverWsOrigin, {
      platform: platform.value,
      corpId,
      enterpriseId: routeEnterpriseId.value || undefined,
      redirectUri: buildOAuthRedirectUri(corpId),
      clientKind: clientKind(),
    });
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "authorize_request_error" });
    }
    throw error;
  }
  if (!res.ok) {
    trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "authorize_request_rejected" });
  }
  const data = handleResult(res);
  oauthNavigationPending.value = true;
  oauthNavigationFallbackTimer = setTimeout(() => {
    oauthNavigationFallbackTimer = null;
    oauthNavigationPending.value = false;
    loading.value = false;
    entryErrorMessage.value = copy.oauthRedirectFailed;
    trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "navigation_timeout" });
  }, 10_000);
  try {
    window.location.assign(data.authorizeUrl);
  } catch (error) {
    if (oauthNavigationFallbackTimer != null) clearTimeout(oauthNavigationFallbackTimer);
    oauthNavigationFallbackTimer = null;
    oauthNavigationPending.value = false;
    trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "navigation_error" });
    throw error;
  }
}

/** 路由缺少 corpId 时，尝试用当前平台的唯一可用登录入口回填。 */
async function resolveOfficeH5EntryCorpId(): Promise<{ corpId: string | null; message: string | null }> {
  if (routeCorpId.value) return { corpId: routeCorpId.value, message: null };
  const res = await getOfficeH5LoginOptions(config.serverWsOrigin);
  const data = handleResult(res);
  const resolved = resolveOfficeH5CorpId({
    routeCorpId: routeCorpId.value,
    platform: platform.value,
    loginOptions: data.options,
  });
  if (resolved) return { corpId: resolved.corpId, message: null };
  return {
    corpId: null,
    message: data.options.find((item) => item.platform === platform.value)?.message || copy.missingEntry,
  };
}

/** 尝试恢复同一账号会话已验证的办公入口；凭证失效时由调用方重新 OAuth。 */
async function tryResumeOfficeH5(corpId: string): Promise<OfficeH5BootstrapResponse | null> {
  const cached = config.officeH5Resume[platform.value];
  if (!config.hasActiveSession || !cached || cached.corpId !== corpId || cached.expiresAt <= Date.now() + 5_000) {
    if (cached) config.clearOfficeH5Resume(platform.value);
    return null;
  }
  const res = await resumeOfficeH5(apiContext(), {
    platform: platform.value,
    corpId,
    credential: cached.credential,
    enterpriseId: routeEnterpriseId.value || undefined,
    clientKind: clientKind(),
  });
  if (!res.ok) {
    if (res.code === "UNAUTHORIZED") {
      config.clearOfficeH5Resume(platform.value);
      return null;
    }
    throw new Error(res.message);
  }
  const data = res;
  if (!data.resumed) {
    config.clearOfficeH5Resume(platform.value);
    return null;
  }
  return data.bootstrap;
}

/** 应用入口成功结果，并统一进入新版账号 H5；通知深链继续保留原目标。 */
async function completeReadyOfficeH5(data: OfficeH5BootstrapResponse): Promise<boolean> {
  bootstrapState.value = data;
  if (hasOfficeH5CallbackQuery(route.query as LocationQueryRaw)) {
    await router.replace({ path: route.path, query: stripOfficeH5CallbackQuery(route.query as LocationQueryRaw), hash: route.hash });
  }
  if (data.status !== "ready") return false;
  if (data.sessionToken) applyOfficeSession(data);
  applyOfficeH5ResumeCredential(data);
  entryErrorMessage.value = null;
  const redirect = String(route.query.redirect ?? "").trim();
  stageOfficeH5BootstrapHandoff(data);
  await router.replace(redirect ? resolvePostLoginTarget("/h5", { redirect }) : { path: "/h5" });
  return true;
}

/** Expose only actions valid for the current pending state. */
function pendingActionsFor(item: PendingMineListItem): PendingActionOption[] {
  if (item.pendingMineStatus === "waiting-start") {
    return [
      { key: "start", label: copy.startNode, primary: true },
      { key: "skip", label: copy.skipNode },
    ];
  }
  if (item.pendingMineStatus === "waiting-approval") {
    return [
      { key: "approve", label: copy.approve, primary: true },
      { key: "request_changes", label: copy.requestChanges },
    ];
  }
  if (item.pendingMineStatus === "waiting-feedback") {
    return [{ key: "clarify", label: copy.clarify, primary: true }];
  }
  if (item.pendingMineStatus === "paused" || item.pendingMineStatus === "failed") {
    return [
      { key: "resume", label: copy.resume, primary: true },
      { key: "skip", label: copy.skipNode },
    ];
  }
  return [];
}

/** Return whether the pending action requires user feedback. */
function pendingActionNeedsFeedback(action: PendingAction): boolean {
  return action === "request_changes" || action === "clarify";
}

/** Return the mobile feedback placeholder for the pending item. */
function pendingFeedbackPlaceholder(item: PendingMineListItem): string {
  return item.pendingMineStatus === "waiting-approval"
    ? copy.requestChangesPlaceholder
    : copy.clarifyPlaceholder;
}

function requireReady(): boolean {
  if (!ready.value) {
    latestGuardMessage.value = bootstrapState.value?.message || copy.missingEntry;
    return false;
  }
  return true;
}

function requireWorkspace(): boolean {
  if (workspaceId.value) return true;
  dataErrorMessage.value = copy.workspaceRequired;
  return false;
}

/** 执行动作前校验入口、企业访问和目标状态。 */
async function ensureActionAllowed(action: OfficeH5Action, extra: Record<string, unknown> = {}): Promise<OfficeH5HttpMeta | null> {
  if (!requireReady()) return null;
  if (!requireWorkspace()) return null;
  const meta = currentMeta(accountEntry.value ? "h5_action" : "oh5_guard");
  if (!("platform" in meta)) {
    latestGuardMessage.value = null;
    return meta;
  }
  const res = await guardOfficeH5Action(apiContext(), meta, {
    action,
    platform: meta.platform,
    corpId: meta.corpId,
    requestId: meta.requestId,
    workspaceId: workspaceId.value,
    ...extra,
  });
  if (!res.ok) throw new Error(res.message);
  if (!res.allowed) {
    latestGuardMessage.value = res.message || copy.actionBlocked;
    if (res.latestStateHint === "thread_not_found") {
      await refreshAll({ retryOnFailure: false });
    }
    return null;
  }
  latestGuardMessage.value = null;
  return meta;
}

function handleResult<T extends object>(res: ApiResult<T>): T {
  if (!res.ok) throw new Error(res.message);
  return res as T;
}

function messageFromApiResult(res: ApiResult<object>): string | null {
  return res.ok ? null : res.message;
}

function clearRefreshRetry(): void {
  if (refreshRetryTimer == null) return;
  clearTimeout(refreshRetryTimer);
  refreshRetryTimer = null;
}

function scheduleRefreshRetry(): void {
  if (typeof window === "undefined" || refreshRetryTimer != null) return;
  refreshRetryTimer = setTimeout(() => {
    refreshRetryTimer = null;
    void refreshAll({ retryOnFailure: false });
  }, 1200);
}

async function resolveReadyWorkspace(): Promise<boolean> {
  const currentWorkspaceId = normalizeOfficeH5PreferredWorkspaceId(workspaceId.value)
    || normalizeOfficeH5PreferredWorkspaceId(routeWorkspaceId.value)
    || normalizeOfficeH5PreferredWorkspaceId(config.workspaceId);
  const workspaceRes = await listWorkspaces(apiContext(), { currentWorkspaceId });
  if (!workspaceRes.ok) {
    workspaceOptions.value = [];
    if (!workspaceId.value) dataErrorMessage.value = workspaceRes.message;
    return Boolean(workspaceId.value);
  }
  workspaceOptions.value = workspaceRes.workspaces ?? [];
  const nextWorkspaceId = resolveOfficeH5WorkspaceSelection({
    currentWorkspaceId: workspaceId.value,
    routeWorkspaceId: routeWorkspaceId.value,
    storedWorkspaceId: config.workspaceId,
    resolvedCurrentWorkspaceId: workspaceRes.resolvedCurrentWorkspaceId ?? null,
    candidates: workspaceOptions.value,
  });
  if (!nextWorkspaceId) {
    dataErrorMessage.value = copy.workspaceRequired;
    return false;
  }
  workspaceId.value = nextWorkspaceId;
  config.switchWorkspace(nextWorkspaceId, { preservePrimaryThreadUrl: true });
  return true;
}

/** 校验 H5 入口并完成账号或办公 OAuth 会话初始化。 */
async function bootstrap(): Promise<void> {
  if (oauthNavigationFallbackTimer != null) clearTimeout(oauthNavigationFallbackTimer);
  oauthNavigationFallbackTimer = null;
  oauthNavigationPending.value = false;
  loading.value = true;
  entryErrorMessage.value = null;
  dataErrorMessage.value = null;
  latestGuardMessage.value = null;
  clearRefreshRetry();
  let loginSucceeded = false;
  try {
    if (accountEntry.value) {
      const res = await bootstrapAccountH5(apiContext(), { clientKind: clientKind() });
      const data = handleResult(res);
      bootstrapState.value = data;
      if (data.status === "ready") {
        loginSucceeded = true;
        trackProductEvent("h5_login_success", { source: "office_h5", oauth_provider: "account_h5", status: "success" });
        entryErrorMessage.value = null;
        if (await resolveReadyWorkspace()) await refreshAll();
      } else {
        trackProductEvent("h5_login_failed", { source: "office_h5", oauth_provider: "account_h5", error_code_group: "bootstrap_not_ready" });
      }
      return;
    }
    const entryCorpId = await resolveOfficeH5EntryCorpId();
    if (!entryCorpId.corpId) {
      bootstrapState.value = {
        status: "forbidden",
        serverNow: Date.now(),
        platformContext: {
          platform: platform.value,
          corpId: "unknown",
          enterpriseId: null,
          clientKind: clientKind(),
          entryChannel: "office_h5",
          requestId: createOfficeH5RequestId("oh5_missing"),
        },
        reasonCode: "OFFICE_H5_FORBIDDEN",
        message: entryCorpId.message || copy.missingEntry,
        entitlement: null,
        recoveryActions: ["back_to_office", "retry"],
      };
      return;
    }
    if (!routeAuthCode.value) {
      const resumed = await tryResumeOfficeH5(entryCorpId.corpId);
      if (resumed) {
        if (await completeReadyOfficeH5(resumed)) return;
        if (resumed.status === "ready" && await resolveReadyWorkspace()) await refreshAll();
        return;
      }
      await startOfficeAuthorization(entryCorpId.corpId);
      return;
    }
    let res: Awaited<ReturnType<typeof bootstrapOfficeH5>>;
    try {
      res = await bootstrapOfficeH5(config.serverWsOrigin, {
        platform: platform.value,
        corpId: entryCorpId.corpId,
        authCode: routeAuthCode.value,
        state: routeState.value,
        enterpriseId: routeEnterpriseId.value || undefined,
        redirectUri: buildOAuthRedirectUri(entryCorpId.corpId),
        clientKind: clientKind(),
      });
    } catch (error) {
      if (!isCancelledRequestError(error)) {
        trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "callback_request_error" });
      }
      throw error;
    }
    if (!res.ok) {
      trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "callback_request_rejected" });
    }
    const data = handleResult(res);
    if (await completeReadyOfficeH5(data)) {
      loginSucceeded = true;
      trackProductEvent("oauth_bind_success", { source: "office_h5", oauth_provider: platform.value, status: "success" });
      return;
    }
    trackProductEvent("oauth_bind_failed", { source: "office_h5", oauth_provider: platform.value, error_code_group: "bootstrap_not_ready" });
    if (data.status === "ready" && await resolveReadyWorkspace()) await refreshAll();
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    if (accountEntry.value && !config.hasActiveSession) {
      await pushLoginRoute(router, { currentFullPath: route.fullPath, replace: true, surface: "h5" });
      return;
    }
    entryErrorMessage.value = error instanceof Error ? error.message : String(error);
    if (!loginSucceeded) {
      trackProductEvent("h5_login_failed", {
        source: "office_h5",
        oauth_provider: accountEntry.value ? "account_h5" : platform.value,
        error_code_group: "bootstrap_error",
      });
    }
  } finally {
    if (!oauthNavigationPending.value) loading.value = false;
  }
}

async function refreshAll(options: { retryOnFailure?: boolean } = {}): Promise<void> {
  if (!requireReady()) return;
  if (!workspaceId.value && !(await resolveReadyWorkspace())) {
    if (options.retryOnFailure !== false) scheduleRefreshRetry();
    return;
  }
  refreshing.value = true;
  dataErrorMessage.value = null;
  try {
    const meta = currentMeta("oh5_refresh");
    const refreshWorkspaceId = workspaceId.value;
    const previousThreadId = selectedThreadId.value;
    const [threadRes, pendingRes] = await Promise.all([
      listOfficeH5Threads(apiContext(), meta, workspaceId.value),
      listOfficeH5PendingMine(apiContext(), meta, workspaceId.value),
      engines.refresh(apiContext(), refreshWorkspaceId, {
        shouldApply: () => String(workspaceId.value) === String(refreshWorkspaceId),
      }),
    ]);
    const errors = [messageFromApiResult(threadRes), messageFromApiResult(pendingRes)].filter(Boolean);
    if (threadRes.ok) {
      threads.value = threadRes.threads ?? [];
      runningByThreadId.value = threadRes.runningByThreadId ?? {};
      workflowByThreadId.value = threadRes.workflowByThreadId ?? {};
    }
    if (pendingRes.ok) pendingItems.value = pendingRes.items ?? [];
    if (!selectedThreadId.value && threads.value[0]) selectedThreadId.value = threads.value[0].id;
    if (selectedThreadId.value && !threads.value.some((item) => item.id === selectedThreadId.value)) {
      selectedThreadId.value = threads.value[0]?.id ?? "";
    }
    if (selectedThreadId.value !== previousThreadId) resetSelectedConversation();
    if (threadRes.ok && selectedThreadId.value) await loadSelectedConversation({ silent: true });
    if (errors.length) {
      dataErrorMessage.value = errors.join(" / ");
      if (options.retryOnFailure !== false) scheduleRefreshRetry();
    } else {
      clearRefreshRetry();
      dataErrorMessage.value = null;
    }
  } catch (error) {
    dataErrorMessage.value = error instanceof Error ? error.message : String(error);
    if (options.retryOnFailure !== false) scheduleRefreshRetry();
  } finally {
    refreshing.value = false;
  }
}

/** Stop the active conversation refresh timer. */
function clearConversationRefresh(): void {
  if (conversationRefreshTimer == null) return;
  clearTimeout(conversationRefreshTimer);
  conversationRefreshTimer = null;
}

/** Reset messages and polling state for the previous thread. */
function resetSelectedConversation(): void {
  clearConversationRefresh();
  conversationMessages.value = [];
  conversationErrorMessage.value = null;
  conversationLoading.value = false;
  awaitingTurnId.value = "";
  conversationPollAttemptsRemaining = 0;
  optimisticConversationMessage = null;
}

/** Scroll the conversation panel to its latest message. */
async function scrollConversationToEnd(): Promise<void> {
  await nextTick();
  const target = conversationListRef.value;
  if (target) target.scrollTop = target.scrollHeight;
}

/** Schedule another refresh while a reply is running or pending. */
function scheduleConversationRefresh(delayMs = 1_200): void {
  if (typeof window === "undefined") return;
  clearConversationRefresh();
  conversationRefreshTimer = setTimeout(() => {
    conversationRefreshTimer = null;
    if (document.hidden) {
      scheduleConversationRefresh(1_500);
      return;
    }
    void loadSelectedConversation({ silent: true });
  }, delayMs);
}

/** Replay the full event window and render user and assistant messages. */
async function loadSelectedConversation(options: { silent?: boolean } = {}): Promise<void> {
  const thread = selectedThread.value;
  const requestWorkspaceId = workspaceId.value;
  if (!ready.value || !thread || !requestWorkspaceId) {
    resetSelectedConversation();
    return;
  }
  const requestThreadId = thread.id;
  clearConversationRefresh();
  if (!options.silent) conversationLoading.value = true;
  conversationErrorMessage.value = null;
  try {
    const result = await loadOfficeH5Thread(apiContext(), currentMeta("oh5_conversation"), {
      workspaceId: requestWorkspaceId,
      threadId: requestThreadId,
      limit: 1_000,
    });
    if (selectedThreadId.value !== requestThreadId || workspaceId.value !== requestWorkspaceId) return;
    if (!result.ok) throw new Error(result.message);

    const snapshot = replayOfficeH5Conversation(requestThreadId, result.events ?? []);
    const optimisticMatched = Boolean(optimisticConversationMessage && snapshot.messages.some((message) =>
      message.role === "user"
      && (message.turnId === awaitingTurnId.value || message.text === optimisticConversationMessage?.text),
    ));
    if (optimisticMatched) optimisticConversationMessage = null;
    conversationMessages.value = optimisticConversationMessage
      ? [...snapshot.messages, optimisticConversationMessage]
      : snapshot.messages;
    const nextRunning = { ...runningByThreadId.value };
    if (result.running) nextRunning[requestThreadId] = result.running;
    else delete nextRunning[requestThreadId];
    runningByThreadId.value = nextRunning;

    if (awaitingTurnId.value && snapshot.completedTurnIds.includes(awaitingTurnId.value)) {
      awaitingTurnId.value = "";
      conversationPollAttemptsRemaining = 0;
      optimisticConversationMessage = null;
      conversationMessages.value = snapshot.messages;
    }
    await scrollConversationToEnd();

    const shouldContinue = Boolean(result.running)
      || Boolean(awaitingTurnId.value && conversationPollAttemptsRemaining > 0);
    if (awaitingTurnId.value && conversationPollAttemptsRemaining > 0) {
      conversationPollAttemptsRemaining -= 1;
    }
    if (shouldContinue) scheduleConversationRefresh();
  } catch (error) {
    if (selectedThreadId.value !== requestThreadId || workspaceId.value !== requestWorkspaceId) return;
    conversationErrorMessage.value = error instanceof Error ? error.message : String(error);
    if (conversationPollAttemptsRemaining > 0) {
      conversationPollAttemptsRemaining -= 1;
      scheduleConversationRefresh(1_600);
    }
  } finally {
    if (selectedThreadId.value === requestThreadId) conversationLoading.value = false;
  }
}

/** Switch workspace and clear the previous thread conversation. */
function handleWorkspaceChange(): void {
  resetSelectedConversation();
  selectedThreadId.value = "";
  if (workspaceId.value) config.switchWorkspace(workspaceId.value, { preservePrimaryThreadUrl: true });
  void refreshAll();
}
/** Load the selected thread and clear the previous error notice. */
function selectThread(thread: ThreadSummary): void {
  if (selectedThreadId.value !== thread.id) resetSelectedConversation();
  selectedThreadId.value = thread.id;
  latestGuardMessage.value = null;
  void loadSelectedConversation();
}

async function runAction(key: string, task: () => Promise<void>): Promise<void> {
  actionBusy.value = key;
  dataErrorMessage.value = null;
  try {
    await task();
  } catch (error) {
    dataErrorMessage.value = error instanceof Error ? error.message : String(error);
  } finally {
    actionBusy.value = null;
  }
}

async function createThread(): Promise<void> {
  const title = newThreadTitle.value.trim() || `${platformLabel.value} H5 ${new Date().toLocaleTimeString()}`;
  await runAction("thread.create", async () => {
    const meta = await ensureActionAllowed("thread.create");
    if (!meta) return;
    const res = await createOfficeH5Thread(apiContext(), meta, { workspaceId: workspaceId.value, engine: "codex", title });
    const data = handleResult(res);
    resetSelectedConversation();
    selectedThreadId.value = data.threadId;
    newThreadTitle.value = "";
    await refreshAll();
  });
}

async function renameThread(thread: ThreadSummary): Promise<void> {
  const title = window.prompt(copy.renamePrompt, thread.title)?.trim();
  if (!title || title === thread.title) return;
  await runAction(`thread.rename.${thread.id}`, async () => {
    const meta = await ensureActionAllowed("thread.rename", { threadId: thread.id });
    if (!meta) return;
    handleResult(await renameOfficeH5Thread(apiContext(), meta, { workspaceId: workspaceId.value, threadId: thread.id, title }));
    await refreshAll();
  });
}

async function archiveThread(thread: ThreadSummary): Promise<void> {
  await runAction(`thread.archive.${thread.id}`, async () => {
    const meta = await ensureActionAllowed("thread.archive", { threadId: thread.id });
    if (!meta) return;
    handleResult(await archiveOfficeH5Thread(apiContext(), meta, { workspaceId: workspaceId.value, threadId: thread.id, archived: true }));
    await refreshAll();
  });
}

async function deleteThread(thread: ThreadSummary): Promise<void> {
  if (!window.confirm(copy.deleteConfirm)) return;
  await runAction(`thread.delete.${thread.id}`, async () => {
    const meta = await ensureActionAllowed("thread.delete", { threadId: thread.id });
    if (!meta) return;
    handleResult(await deleteOfficeH5Thread(apiContext(), meta, { workspaceId: workspaceId.value, threadId: thread.id }));
    selectedThreadId.value = "";
    await refreshAll();
  });
}

/** 发送消息；若最终写接口报告锁冲突，则保留草稿并引导用户显式接管。 */
async function sendMessage(): Promise<void> {
  const thread = selectedThread.value;
  const text = messageDraft.value.trim();
  if (!thread || !text) {
    latestGuardMessage.value = copy.noThreadSelected;
    return;
  }
  await runAction("thread.send", async () => {
    const clientItemId = createOfficeH5RequestId("oh5_msg");
    const meta = await ensureActionAllowed("thread.send", { threadId: thread.id, clientItemId });
    if (!meta) return;
    const threadPrefs = handleResult(await getOfficeH5ThreadPrefs(apiContext(), meta, {
      workspaceId: workspaceId.value,
      threadId: thread.id,
    })).prefs;
    const models = engines.byTypeForWorkspace(workspaceId.value).get(thread.engine)?.models ?? [];
    if (!models.length) throw new Error(copy.modelUnavailable);
    const executionPrefs = resolveThreadPrefsWithCatalogDefaults(thread.engine, threadPrefs, models);
    const resolvedModel = String(executionPrefs.model ?? "").trim();
    if (!resolvedModel) throw new Error(copy.modelUnavailable);
    if (!models.some((model) => model.id === resolvedModel)) {
      throw new Error(`当前模型 ${resolvedModel} 已从模型目录移除，请在会话设置中重新选择模型。`);
    }
    const sendResult = await sendOfficeH5Message(apiContext(), meta, {
      workspaceId: workspaceId.value,
      threadId: thread.id,
      text,
      workMode: "general",
      roleId: threadPrefs?.roleId ?? null,
      planMode: executionPrefs.planMode,
      accessMode: executionPrefs.accessMode,
      model: resolvedModel,
      effort: executionPrefs.effort,
      contextWindow: executionPrefs.contextWindow,
      autoCompactPct: executionPrefs.autoCompactPct,
      serviceTier: executionPrefs.serviceTier,
      clientItemId,
    });
    const sendData = handleResult(sendResult);
    messageDraft.value = "";
    awaitingTurnId.value = String(sendData.turnId ?? clientItemId);
    conversationPollAttemptsRemaining = 30;
    optimisticConversationMessage = {
      id: clientItemId,
      role: "user",
      text,
      createdAt: Date.now(),
      turnId: sendData.turnId ? String(sendData.turnId) : null,
      streaming: false,
    };
    conversationMessages.value = [...conversationMessages.value, optimisticConversationMessage];
    await scrollConversationToEnd();
    scheduleConversationRefresh(500);
  });
}

async function interruptThread(thread: ThreadSummary): Promise<void> {
  const running = runningByThreadId.value[thread.id];
  if (!running?.runningTurnId) return;
  await runAction(`turn.interrupt.${thread.id}`, async () => {
    const meta = await ensureActionAllowed("turn.interrupt", { threadId: thread.id, turnId: running.runningTurnId });
    if (!meta) return;
    handleResult(await interruptOfficeH5Turn(apiContext(), meta, { workspaceId: workspaceId.value, threadId: thread.id, turnId: running.runningTurnId }));
    await refreshAll();
  });
}

function pendingTarget(item: PendingMineListItem) {
  return {
    workspaceId: (item.reminder.routeTarget.workspaceId || workspaceId.value) as WorkspaceId,
    instanceId: item.reminder.routeTarget.instanceId ?? null,
    nodeId: item.reminder.routeTarget.nodeId ?? null,
  };
}

function feedbackActionBody(action: PendingAction): { guardAction: OfficeH5Action; feedbackAction?: FeedbackAction } {
  if (action === "approve") return { guardAction: "orch.approve", feedbackAction: "approve" };
  if (action === "request_changes") return { guardAction: "orch.request_changes", feedbackAction: "retry" };
  if (action === "clarify") return { guardAction: "orch.clarify", feedbackAction: "resume_with_input" };
  if (action === "start") return { guardAction: "orch.node_start" };
  if (action === "skip") return { guardAction: "orch.node_skip" };
  return { guardAction: "orch.resume" };
}

async function handlePendingAction(item: PendingMineListItem, action: PendingAction): Promise<void> {
  const target = pendingTarget(item);
  if (!target.instanceId || !target.nodeId) {
    dataErrorMessage.value = copy.pendingTargetMissing;
    return;
  }
  const feedback = String(pendingFeedbackDrafts.value[item.reminder.id] ?? "").trim();
  if (pendingActionNeedsFeedback(action) && !feedback) {
    dataErrorMessage.value = copy.feedbackRequired;
    return;
  }
  await runAction(`${action}.${item.reminder.id}`, async () => {
    const mapped = feedbackActionBody(action);
    const meta = await ensureActionAllowed(mapped.guardAction, { instanceId: target.instanceId, nodeId: target.nodeId });
    if (!meta) return;
    const base = {
      workspaceId: target.workspaceId,
      instanceId: target.instanceId,
      nodeId: target.nodeId,
      feedback: feedback || null,
    };
    if (action === "start") {
      handleResult(await startOfficeH5OrchNode(apiContext(), meta, base));
    } else if (action === "skip") {
      handleResult(await skipOfficeH5OrchNode(apiContext(), meta, base));
    } else if (action === "resume") {
      handleResult(await resumeOfficeH5OrchInstance(apiContext(), meta, base));
    } else {
      handleResult(await submitOfficeH5OrchFeedback(apiContext(), meta, { ...base, action: mapped.feedbackAction }));
    }
    latestGuardMessage.value = copy.actionDone;
    const nextDrafts = { ...pendingFeedbackDrafts.value };
    delete nextDrafts[item.reminder.id];
    pendingFeedbackDrafts.value = nextDrafts;
    await refreshAll();
  });
}

onMounted(() => {
  void bootstrap();
});

onBeforeUnmount(() => {
  if (oauthNavigationFallbackTimer != null) clearTimeout(oauthNavigationFallbackTimer);
  oauthNavigationFallbackTimer = null;
  clearRefreshRetry();
  clearConversationRefresh();
});
</script>

<template>
  <main class="office-h5-shell" :class="`office-h5-shell--${shellVariant}`">
    <section class="office-hero">
      <div>
        <p class="office-eyebrow">{{ platformLabel }}</p>
        <h1>{{ copy.title }}</h1>
        <p>{{ copy.subtitle }}</p>
      </div>
      <div class="office-hero__actions">
        <span class="status-pill" :class="{ 'status-pill--ready': ready, 'status-pill--blocked': blocked }">
          {{ statusText(bootstrapState?.status) }}
        </span>
        <button
          v-if="ready && !accountEntry"
          class="account-trigger"
          type="button"
          :aria-expanded="accountPanelOpen"
          aria-controls="office-h5-account-panel"
          @click="accountPanelOpen = !accountPanelOpen"
        >
          {{ copy.accountMenu }}
        </button>
      </div>
    </section>

    <section
      v-if="ready && !accountEntry && accountPanelOpen"
      id="office-h5-account-panel"
      class="office-card office-account-panel"
    >
      <div class="office-account-panel__head">
        <div>
          <span>{{ copy.currentAccount }}</span>
          <strong>{{ bootstrapState?.userSummary?.fullName || bootstrapState?.userSummary?.email }}</strong>
          <small>{{ bootstrapState?.userSummary?.email }} / {{ bootstrapState?.userSummary?.enterpriseName || platformLabel }}</small>
        </div>
        <button class="ghost" type="button" :aria-label="copy.closeAccountPanel" @click="accountPanelOpen = false">X</button>
      </div>
      <p>{{ copy.logoutHint }}</p>
      <div class="office-account-panel__actions">
        <button class="primary" type="button" @click="openAccountSettings('switch')">{{ copy.switchAccount }}</button>
        <button type="button" @click="openAccountSettings('manage')">{{ copy.manageBinding }}</button>
        <button class="danger" type="button" @click="confirmLogout">{{ copy.logout }}</button>
      </div>
    </section>

    <section v-if="loading" class="office-card office-card--center">
      <div class="office-spinner" />
      <strong>{{ copy.checking }}</strong>
    </section>

    <section v-else-if="blocked || entryErrorMessage" class="office-card office-blocked">
      <p class="office-eyebrow">{{ copy.blocked }}</p>
      <h2>{{ bootstrapState?.message || entryErrorMessage || copy.missingEntry }}</h2>
      <p v-if="bootstrapState?.reasonCode" class="muted">{{ bootstrapState.reasonCode }}</p>
      <div class="office-actions">
        <button v-if="showBindAccountAction" class="primary" type="button" @click="openAccountBinding">{{ copy.bindAccount }}</button>
        <button v-else class="primary" type="button" @click="bootstrap">{{ copy.retry }}</button>
        <a class="ghost" :href="webChatHref">{{ copy.openWeb }}</a>
      </div>
    </section>

    <template v-else>
      <section class="office-summary-strip" :aria-label="copy.account">
        <div class="office-summary-item office-summary-item--account">
          <span>{{ copy.account }}</span>
          <strong :title="bootstrapState?.userSummary?.email || ''">
            {{ bootstrapState?.userSummary?.fullName || bootstrapState?.userSummary?.email }}
          </strong>
        </div>
        <div class="office-summary-item" :title="entitlement?.safeMessage || ''">
          <span>{{ copy.package }}</span>
          <strong :class="entitlement?.accessStatus === 'available' ? 'ok' : 'warn'">
            {{ entitlementStatusText(entitlement?.accessStatus) }}
          </strong>
        </div>
        <div class="office-summary-item">
          <span>{{ copy.token }}</span>
          <strong :class="entitlement?.tokenStatus === 'available' ? 'ok' : 'warn'">
            {{ entitlementStatusText(entitlement?.tokenStatus) }}
          </strong>
        </div>
      </section>

      <section v-if="latestGuardMessage || dataErrorMessage" class="office-notice">
        {{ latestGuardMessage || dataErrorMessage }}
      </section>

      <section class="office-toolbar">
        <div class="segmented">
          <button type="button" :class="{ active: activeTab === 'threads' }" @click="activeTab = 'threads'">
            {{ copy.threads }} <b>{{ threads.length }}</b>
          </button>
          <button type="button" :class="{ active: activeTab === 'pending' }" @click="activeTab = 'pending'">
            {{ copy.pending }} <b>{{ pendingItems.length }}</b>
          </button>
        </div>
        <button class="ghost" type="button" :disabled="refreshing" @click="refreshAll()">{{ copy.refresh }}</button>
      </section>

      <section v-if="activeTab === 'threads'" class="office-panel">
        <div class="workspace-row">
          <label>{{ copy.workspace }}</label>
          <select v-if="workspaceOptions.length" v-model="workspaceId" @change="handleWorkspaceChange">
            <option v-for="workspace in workspaceOptions" :key="workspace.id" :value="workspace.id">
              {{ workspace.title || workspace.id }}
            </option>
          </select>
          <input v-else v-model="workspaceId" type="text" :placeholder="copy.workspaceRequired" @change="handleWorkspaceChange" />
        </div>
        <div class="new-thread-row">
          <input v-model="newThreadTitle" type="text" :placeholder="copy.newThreadPlaceholder" />
          <button class="primary" type="button" :disabled="Boolean(actionBusy)" @click="createThread">{{ copy.createThread }}</button>
        </div>

        <div v-if="threads.length === 0" class="empty-state">{{ copy.emptyThreads }}</div>
        <div v-else class="thread-list">
          <article
            v-for="thread in threads"
            :key="thread.id"
            class="thread-card"
            :class="{ selected: selectedThreadId === thread.id }"
            @click="selectThread(thread)"
          >
            <div>
              <strong>{{ thread.title }}</strong>
              <small>{{ thread.engine }} - {{ formatTime(thread.updatedAt) }}</small>
            </div>
            <span :class="threadPillByThreadId[thread.id]?.className ?? 'idle-pill'">{{ threadPillByThreadId[thread.id]?.label ?? copy.idle }}</span>
            <div class="thread-actions">
              <button type="button" @click.stop="renameThread(thread)">{{ copy.rename }}</button>
              <button type="button" @click.stop="archiveThread(thread)">{{ copy.archive }}</button>
              <button type="button" @click.stop="deleteThread(thread)">{{ copy.delete }}</button>
              <button type="button" :disabled="!runningByThreadId[thread.id]" @click.stop="interruptThread(thread)">{{ copy.interrupt }}</button>
            </div>
          </article>
        </div>

        <div class="conversation-card">
          <header class="conversation-card__header">
            <div>
              <span>{{ copy.conversationTitle }}</span>
              <strong>{{ selectedThread?.title || copy.noThreadSelected }}</strong>
            </div>
            <span v-if="selectedThread" :class="conversationAwaitingReply ? 'run-pill' : 'idle-pill'">
              {{ conversationAwaitingReply ? copy.running : copy.idle }}
            </span>
          </header>

          <div ref="conversationListRef" class="conversation-list" aria-live="polite">
            <div v-if="!selectedThread" class="conversation-empty">{{ copy.noThreadSelected }}</div>
            <div v-else-if="conversationLoading && conversationMessages.length === 0" class="conversation-empty">
              {{ copy.conversationLoading }}
            </div>
            <div v-if="conversationErrorMessage" class="conversation-error" role="alert">
              {{ conversationErrorMessage }}
            </div>
            <div
              v-if="selectedThread && !conversationLoading && !conversationErrorMessage && conversationMessages.length === 0 && !conversationAwaitingReply"
              class="conversation-empty"
            >
              {{ copy.conversationEmpty }}
            </div>
            <article
              v-for="message in conversationMessages"
              :key="message.id"
              class="conversation-message"
              :class="'conversation-message--' + message.role"
            >
              <header>
                <b>{{ message.role === 'user' ? copy.userLabel : copy.assistantLabel }}</b>
                <time>{{ formatTime(message.createdAt) }}</time>
              </header>
              <p>{{ message.text }}</p>
              <small v-if="message.streaming">{{ copy.assistantWorking }}</small>
            </article>
            <div v-if="conversationAwaitingReply && !conversationHasStreamingReply" class="conversation-typing">
              <span /><span /><span />
              <b>{{ copy.assistantWorking }}</b>
            </div>
          </div>

          <div class="conversation-composer">
            <textarea v-model="messageDraft" :placeholder="copy.sendPlaceholder" rows="3" />
            <button class="primary" type="button" :disabled="!canSend" @click="sendMessage">{{ copy.send }}</button>
          </div>
        </div>
      </section>

      <section v-else class="office-panel pending-panel">
        <header class="pending-panel__header">
          <div>
            <span>{{ copy.pending }}</span>
            <strong>{{ copy.pendingFocusHint }}</strong>
          </div>
          <b>{{ pendingItems.length }}</b>
        </header>

        <div v-if="pendingItems.length === 0" class="empty-state">{{ copy.pendingEmpty }}</div>
        <article v-for="item in pendingItems" :key="item.reminder.id" class="pending-card">
          <div class="pending-card__topline">
            <span class="pending-status">{{ item.pendingMineStatusLabel || item.reminder.statusLabel }}</span>
            <time>{{ formatTime(item.reminder.updatedAt) }}</time>
          </div>
          <h3>{{ item.reminder.title || item.intake.title }}</h3>
          <p>{{ item.reminder.summary || item.intake.goal }}</p>
          <div v-if="pendingTarget(item).nodeId" class="pending-node">
            <span>{{ copy.currentNode }}</span>
            <strong>{{ pendingTarget(item).nodeId }}</strong>
          </div>
          <textarea
            v-if="pendingActionsFor(item).some((action) => pendingActionNeedsFeedback(action.key))"
            v-model="pendingFeedbackDrafts[item.reminder.id]"
            :placeholder="pendingFeedbackPlaceholder(item)"
            rows="3"
          />
          <div v-if="pendingActionsFor(item).length" class="pending-actions">
            <button
              v-for="action in pendingActionsFor(item)"
              :key="action.key"
              type="button"
              :class="{ primary: action.primary }"
              :disabled="Boolean(actionBusy)"
              @click="handlePendingAction(item, action.key)"
            >
              {{ actionBusy === action.key + '.' + item.reminder.id ? copy.running : action.label }}
            </button>
          </div>
          <div v-else class="pending-receipt">{{ copy.viewOnlyPending }}</div>
        </article>
      </section>

      <footer class="office-footer">
        <a :href="webChatHref">{{ copy.openWeb }} - {{ copy.threads }}</a>
        <a :href="webOrchHref">{{ copy.openWeb }} - {{ copy.pending }}</a>
      </footer>
    </template>
  </main>
</template>

<style scoped>
.office-h5-shell {
  --office-bg: #f4efe3;
  --office-card: rgba(255, 252, 244, 0.94);
  --office-ink: #18221f;
  --office-muted: #6e756d;
  --office-accent: #1f8f75;
  --office-warn: #aa5a15;
  min-height: 100vh;
  padding: max(12px, env(safe-area-inset-top)) 12px max(20px, env(safe-area-inset-bottom));
  color: var(--office-ink);
  background:
    radial-gradient(circle at top left, rgba(31, 143, 117, 0.2), transparent 28rem),
    radial-gradient(circle at 92% 8%, rgba(191, 126, 49, 0.16), transparent 22rem),
    linear-gradient(145deg, #f7f0df 0%, var(--office-bg) 42%, #e9eee7 100%);
  font-family: "Avenir Next", "Segoe UI", sans-serif;
}

.office-h5-shell--dingtalk {
  --office-accent: #1f6feb;
}

.office-hero,
.office-summary-strip,
.office-toolbar,
.office-panel,
.office-footer {
  max-width: 780px;
  margin: 0 auto 10px;
}

.office-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 2px 2px;
}

.office-hero__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  flex-wrap: wrap;
}

.office-hero h1 {
  margin: 0;
  font-size: clamp(24px, 7vw, 34px);
  line-height: 1;
  letter-spacing: -0.045em;
}

.office-hero p {
  margin: 5px 0 0;
  color: var(--office-muted);
  font-size: 13px;
}

.office-eyebrow {
  margin: 0 0 5px;
  color: var(--office-accent);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.office-card,
.office-panel,
.office-notice,
.office-toolbar,
.thread-card,
.pending-card,
.conversation-card {
  border: 1px solid rgba(24, 34, 31, 0.1);
  border-radius: 20px;
  background: var(--office-card);
  box-shadow: 0 14px 34px rgba(36, 34, 28, 0.09);
  backdrop-filter: blur(16px);
}

.office-card {
  padding: 16px;
}

.office-blocked,
.office-card--center {
  max-width: 780px;
  margin: 0 auto 12px;
}

.account-trigger {
  min-height: 38px;
  color: var(--office-accent);
  background: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(31, 143, 117, 0.2);
}

.office-account-panel {
  max-width: 780px;
  display: grid;
  gap: 12px;
  margin: 0 auto 10px;
}

.office-account-panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.office-account-panel__head div {
  display: grid;
  gap: 4px;
}

.office-account-panel__head span,
.office-account-panel__head small,
.office-account-panel p {
  margin: 0;
  color: var(--office-muted);
}

.office-account-panel__actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.office-account-panel__actions .danger {
  color: #9b2c1c;
  background: rgba(190, 67, 37, 0.12);
}

.office-card--center {
  display: grid;
  place-items: center;
  min-height: 220px;
  gap: 14px;
}

.office-spinner {
  width: 34px;
  height: 34px;
  border: 4px solid rgba(31, 143, 117, 0.18);
  border-top-color: var(--office-accent);
  border-radius: 999px;
  animation: office-spin 0.9s linear infinite;
}

.status-pill,
.run-pill,
.workflow-pill,
.idle-pill,
.pending-status {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 800;
  background: rgba(24, 34, 31, 0.08);
}

.status-pill--ready,
.run-pill {
  color: #0f6b54;
  background: rgba(31, 143, 117, 0.14);
}

.status-pill--blocked {
  color: #8c2d18;
  background: rgba(190, 67, 37, 0.14);
}

.idle-pill {
  color: var(--office-muted);
}

.workflow-pill {
  color: var(--office-warn);
  background: rgba(170, 90, 21, 0.14);
}

.office-summary-strip {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) repeat(2, minmax(64px, 0.55fr));
  gap: 0;
  padding: 8px;
  border: 1px solid rgba(24, 34, 31, 0.09);
  border-radius: 16px;
  background: rgba(255, 252, 244, 0.78);
  box-shadow: 0 8px 22px rgba(36, 34, 28, 0.06);
}

.office-summary-item {
  min-width: 0;
  display: grid;
  gap: 2px;
  padding: 3px 10px;
  border-left: 1px solid rgba(24, 34, 31, 0.08);
}

.office-summary-item:first-child {
  border-left: 0;
}

.office-summary-item span {
  color: var(--office-muted);
  font-size: 10px;
}

.office-summary-item strong {
  overflow: hidden;
  font-size: 13px;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ok {
  color: #0f6b54;
}

.warn {
  color: var(--office-warn);
}

.office-notice {
  max-width: 780px;
  margin: 0 auto 10px;
  padding: 10px 12px;
  color: #7b3518;
  background: rgba(255, 235, 205, 0.86);
}

.office-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px;
}

.segmented {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
  flex: 1;
}

button,
a.ghost {
  min-height: 40px;
  border: 0;
  border-radius: 14px;
  padding: 0 12px;
  color: var(--office-ink);
  background: rgba(24, 34, 31, 0.08);
  font: inherit;
  font-weight: 800;
  text-decoration: none;
  cursor: pointer;
}

button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

button.active,
button.primary,
a.ghost.primary {
  color: white;
  background: var(--office-accent);
}

button.ghost,
a.ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.office-panel {
  padding: 10px;
}

.workspace-row,
.new-thread-row {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.new-thread-row {
  grid-template-columns: 1fr auto;
}

input,
textarea,
select {
  width: 100%;
  min-height: 42px;
  border: 1px solid rgba(24, 34, 31, 0.12);
  border-radius: 14px;
  padding: 10px 12px;
  color: var(--office-ink);
  background: rgba(255, 255, 255, 0.76);
  font: inherit;
  outline: none;
}

textarea {
  resize: vertical;
}

.thread-list {
  display: grid;
  gap: 7px;
  max-height: 230px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.thread-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 7px;
  padding: 11px 12px;
  border-radius: 16px;
  box-shadow: none;
  cursor: pointer;
}

.thread-card.selected {
  outline: 2px solid rgba(31, 143, 117, 0.36);
  background: rgba(255, 255, 255, 0.95);
}

.thread-card strong,
.pending-card h3 {
  display: block;
  margin: 0 0 4px;
}

.thread-card small,
.pending-card p,
.muted {
  color: var(--office-muted);
}

.thread-actions,
.pending-actions,
.office-actions,
.office-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}

.thread-actions {
  grid-column: 1 / -1;
}

.thread-actions button {
  min-height: 34px;
  padding: 0 10px;
  font-size: 12px;
}

.conversation-card {
  overflow: hidden;
  margin-top: 10px;
}

.conversation-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(24, 34, 31, 0.08);
}

.conversation-card__header div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.conversation-card__header span:not(.run-pill):not(.idle-pill) {
  color: var(--office-muted);
  font-size: 11px;
}

.conversation-card__header strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-list {
  min-height: 330px;
  max-height: min(56vh, 580px);
  display: grid;
  align-content: start;
  gap: 10px;
  overflow-y: auto;
  padding: 14px;
  background:
    linear-gradient(rgba(255, 255, 255, 0.52), rgba(255, 255, 255, 0.52)),
    radial-gradient(circle at 10% 0%, rgba(31, 143, 117, 0.08), transparent 18rem);
  overscroll-behavior: contain;
}

.conversation-empty,
.conversation-error {
  align-self: center;
  padding: 30px 14px;
  color: var(--office-muted);
  text-align: center;
}

.conversation-error {
  color: #8c2d18;
  border-radius: 14px;
  background: rgba(190, 67, 37, 0.1);
}

.conversation-message {
  width: fit-content;
  max-width: 88%;
  padding: 10px 12px;
  border: 1px solid rgba(24, 34, 31, 0.08);
  border-radius: 17px;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 7px 18px rgba(36, 34, 28, 0.06);
}

.conversation-message--user {
  justify-self: end;
  color: #fff;
  border-bottom-right-radius: 5px;
  background: var(--office-accent);
}

.conversation-message--assistant {
  justify-self: start;
  border-bottom-left-radius: 5px;
}

.conversation-message header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 5px;
  font-size: 11px;
}

.conversation-message time,
.conversation-message small {
  color: var(--office-muted);
  font-size: 10px;
}

.conversation-message--user time {
  color: rgba(255, 255, 255, 0.72);
}

.conversation-message p {
  margin: 0;
  line-height: 1.55;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.conversation-typing {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  padding: 9px 12px;
  color: var(--office-muted);
  border-radius: 16px 16px 16px 5px;
  background: rgba(255, 255, 255, 0.88);
}

.conversation-typing span {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--office-accent);
  animation: office-pulse 1s ease-in-out infinite;
}

.conversation-typing span:nth-child(2) {
  animation-delay: 0.16s;
}

.conversation-typing span:nth-child(3) {
  animation-delay: 0.32s;
}

.conversation-typing b {
  margin-left: 3px;
  font-size: 11px;
}

.conversation-composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 8px;
  padding: 11px;
  border-top: 1px solid rgba(24, 34, 31, 0.08);
  background: rgba(255, 252, 244, 0.96);
}

.conversation-composer textarea {
  min-height: 76px;
}

.conversation-composer button {
  min-width: 72px;
}

.pending-panel {
  display: grid;
  gap: 9px;
}

.pending-panel__header,
.pending-card__topline,
.pending-node {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.pending-panel__header {
  padding: 5px 3px 8px;
}

.pending-panel__header div {
  display: grid;
  gap: 2px;
}

.pending-panel__header span,
.pending-card__topline time,
.pending-node span {
  color: var(--office-muted);
  font-size: 11px;
}

.pending-panel__header > b {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: #fff;
  border-radius: 999px;
  background: var(--office-accent);
}

.pending-card {
  display: grid;
  gap: 10px;
  padding: 13px;
  border-radius: 17px;
  box-shadow: none;
}

.pending-card p {
  margin: 0;
  line-height: 1.5;
}

.pending-node {
  padding: 8px 10px;
  border-radius: 12px;
  background: rgba(24, 34, 31, 0.05);
}

.pending-node strong {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pending-receipt {
  padding: 9px 10px;
  color: var(--office-muted);
  border-radius: 12px;
  background: rgba(24, 34, 31, 0.05);
  font-size: 12px;
}

.empty-state {
  padding: 26px 14px;
  color: var(--office-muted);
  text-align: center;
}

.office-footer {
  justify-content: center;
  padding-bottom: 14px;
}

.office-footer a {
  color: var(--office-accent);
  font-weight: 800;
  text-decoration: none;
}

@keyframes office-spin {
  to { transform: rotate(360deg); }
}

@keyframes office-pulse {
  0%, 100% { opacity: 0.35; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}

@media (max-width: 640px) {
  .office-hero {
    align-items: center;
  }

  .office-hero h1 {
    font-size: 24px;
  }

  .office-hero > div:first-child > p:last-child {
    display: none;
  }

  .office-account-panel__actions {
    grid-template-columns: 1fr;
  }

  .new-thread-row,
  .workspace-row {
    grid-template-columns: 1fr;
  }

  .thread-card {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .conversation-list {
    min-height: 360px;
    max-height: 58vh;
  }
}

@media (max-width: 390px) {
  .office-summary-strip {
    grid-template-columns: minmax(0, 1.35fr) repeat(2, minmax(58px, 0.65fr));
  }

  .office-summary-item {
    padding-inline: 7px;
  }

  .conversation-message {
    max-width: 94%;
  }
}
</style>
