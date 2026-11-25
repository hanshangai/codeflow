<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { useRouter } from "vue-router";
import {
  BankOutlined,
  CopyOutlined,
  LinkOutlined,
  LeftOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
} from "@ant-design/icons-vue";
import {
  DEFAULT_RELAY_USD_TO_CNY_RATE,
  type AccountCancellationReason,
  type AccountMeSummaryResponseBody,
  type CancelMyAccountRequestBody,
  type RelayUsageItem,
} from "@codeflowai/shared";

import {
  formatAccountRole,
  formatTimestamp,
  maskEmail,
} from "../accountDisplay";
import { createMyEnterprise, getEnterpriseRelayBalancePool, getMyRelayBalances, getMyRelayUsage } from "../../../api/account";
import { createCancelledRequestError, isCancelledRequestError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { APP_MODALS_KEY } from "../../../services/appModals";
import { useConfigStore } from "../../../store/config";
import { captureAccountSession, useAccountStore, type AccountDrawerSurface, type AccountDrawerTab } from "../../../store/account";
import RelayBalancePackPurchaseButton from "../../admin/components/relay-balance-pack-purchase-button.vue";
import { formatRelayUsdUnitsAsYuan, parseRelayUsdUnits } from "../relayUsdUnits";
import AccountAvatar from "./account-avatar.vue";
import MyInvitationsModal from "./my-invitations-modal.vue";

defineOptions({ name: "AccountDrawer" });

const MAX_AVATAR_BYTES = 512 * 1024;
const HERO_AVATAR_SIZE = 112;
const MODAL_AVATAR_SIZE = 120;
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;
const AVATAR_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";

type SaveAvatarPayload = {
  avatarUrl: string | null;
  onSuccess?: () => void;
  onError?: () => void;
};

const CANCEL_COPY = {
  tab: "账户注销",
  action: "注销账号",
  modalTitle: "确认注销账号",
  modalIntro: "请再次确认注销操作。注销后你将无法再使用当前账号登录，且已有套餐权益将按规则处理。",
  reasonLabel: "注销原因",
  otherPlaceholder: "可填写其他原因说明（非必填）",
  reasonRequired: "请选择注销原因",
  okText: "确认注销",
  cancelText: "取消",
} as const;

type CancellationReasonOption = {
  value: AccountCancellationReason;
  label: string;
};

const CANCELLATION_REASON_OPTIONS: CancellationReasonOption[] = [
  { value: "profile_error_reregister", label: "用户信息填写错误，注销后重新注册" },
  { value: "other", label: "其他" },
];

const props = withDefaults(defineProps<{
  open: boolean;
  initialTab?: AccountDrawerTab;
  surface?: AccountDrawerSurface;
  summary: AccountMeSummaryResponseBody | null;
  loading?: boolean;
  savingProfile?: boolean;
  savingEnterpriseProfile?: boolean;
  sendingKey?: boolean;
  rotatingKey?: boolean;
  changingPassword?: boolean;
  loggingOut?: boolean;
  cancellingAccount?: boolean;
  respondingEnterpriseInvitation?: boolean;
}>(), {
  initialTab: "overview",
  surface: "default",
});

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "send-key"): void;
  (e: "rotate-key"): void;
  (e: "save-avatar", payload: SaveAvatarPayload): void;
  (e: "save-profile", payload: { fullName: string; phone: string; avatarUrl: string | null }): void;
  (e: "save-enterprise", payload: { name?: string; contactName?: string; contactEmail?: string; contactPhone?: string }): void;
  (e: "change-password", payload: { oldPassword: string; newPassword: string; confirmPassword: string }): void;
  (e: "logout"): void;
  (e: "cancel-account", payload: CancelMyAccountRequestBody): void;
  (e: "respond-enterprise-invitation", payload: { invitationId: string; action: "accept" | "decline" }): void;
}>();

const router = useRouter();
const appModals = inject(APP_MODALS_KEY, null);
const config = useConfigStore();
const account = useAccountStore();
const { ctx } = useApiContext();
/** 邀请码入口暂时隐藏，恢复时改为 true。 */
const showInviteSection = false;
const createEnterpriseOpen = ref(false);
const creatingEnterprise = ref(false);
const newEnterpriseName = ref("");
const createEnterpriseError = ref("");
let enterpriseCreationRevision = 0;
const canCreateEnterprise = computed(() => props.summary?.accountRole === "personal_normal"
  && config.userSummary?.status === "active" && !props.summary.accessContext.enterpriseId);

/** 免费建企后刷新服务端身份，再进入企业管理；失败保留明确错误态。 */
async function submitCreateEnterprise(): Promise<void> {
  if (creatingEnterprise.value) return;
  const name = newEnterpriseName.value.trim();
  if (!name || name.length > 100) {
    createEnterpriseError.value = "请输入 1 至 100 个字符的企业名称";
    return;
  }
  const owner = captureAccountSession(config);
  const revision = ++enterpriseCreationRevision;
  const requestId = `enterprise-create-${Date.now()}`;
  creatingEnterprise.value = true;
  createEnterpriseError.value = "";
  try {
    const result = await createMyEnterprise(owner.requestContext, { name });
    owner.assertResponseCurrent();
    if (revision !== enterpriseCreationRevision) return;
    if (!result.ok) throw new Error(result.message || "创建企业失败");
    const summary = await account.loadMeSummary(true, { owner });
    owner.assertResponseCurrent();
    if (revision !== enterpriseCreationRevision) return;
    if (!summary || summary.enterpriseSummary?.enterpriseId !== result.enterpriseId) throw new Error("企业已创建，但账号信息刷新失败，请重新打开个人信息查看");
    createEnterpriseOpen.value = false;
    emit("update:open", false);
    await router.push({ path: "/admin", query: { panel: "enterprise-member-management" } });
    message.success("企业已创建");
  } catch (error) {
    if (!owner.isCurrentResponse() || revision !== enterpriseCreationRevision || isCancelledRequestError(error)) return;
    createEnterpriseError.value = error instanceof Error ? error.message : "创建企业失败";
    console.error("[ENTERPRISE_CREATE_FAILED]", { errorCode: "ENTERPRISE_CREATE_FAILED", requestId,
      userId: owner.userId, cause: createEnterpriseError.value });
  } finally {
    if (revision === enterpriseCreationRevision) creatingEnterprise.value = false;
  }
}

/** 关闭或切换账号时取消本地建企表单归属，旧请求不得回写。 */
function resetEnterpriseCreation(): void {
  enterpriseCreationRevision++;
  createEnterpriseOpen.value = false;
  creatingEnterprise.value = false;
  newEnterpriseName.value = "";
  createEnterpriseError.value = "";
}
type AccountDrawerActiveTab = AccountDrawerTab | "enterprise-profile";
const activeTab = ref<AccountDrawerActiveTab>(props.initialTab);
const isH5Surface = computed(() => props.surface === "h5");
const activeTabTitle = computed(() => "个人信息");
const passwordSectionRef = ref<HTMLElement | null>(null);
const cancelSectionRef = ref<HTMLElement | null>(null);

/** 单页布局下，H5 的密码/注销入口滚动到对应分区而不是切换 Tab。 */
async function scrollToAccountSection(tab: AccountDrawerActiveTab): Promise<void> {
  if (tab !== "password" && tab !== "account-cancel") return;
  await nextTick();
  const target = tab === "password" ? passwordSectionRef.value : cancelSectionRef.value;
  if (!target) return;
  window.setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 180);
}

const profileForm = reactive({
  fullName: "",
  phone: "",
  avatarUrl: null as string | null,
});

const enterpriseProfileForm = reactive({
  name: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
});

const passwordForm = reactive({
  oldPassword: "",
  newPassword: "",
  confirmPassword: "",
});

const avatarModalOpen = ref(false);
const myInvitationsOpen = ref(false);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarDraftUrl = ref<string | null>(null);
const cancellationModalOpen = ref(false);
const tokenBalance = ref<RelayUsageItem | null>(null);
const exactTokenBalanceText = ref<string | null>(null);
const enterpriseTokenBalanceText = ref<string | null>(null);
const tokenBalanceLoading = ref(false);
const tokenBalanceError = ref("");
const enterpriseTokenBalanceError = ref("");
let tokenBalanceRequestController: AbortController | null = null;
const cancellationForm = reactive<{ reason: AccountCancellationReason | null; reasonText: string }>({
  reason: null,
  reasonText: "",
});

function syncProfileForm(summary: AccountMeSummaryResponseBody | null) {
  profileForm.fullName = summary?.fullName ?? "";
  profileForm.phone = summary?.phone ?? "";
  profileForm.avatarUrl = summary?.avatarUrl ?? null;
}

/** 将企业管理员可编辑资料同步到个人信息抽屉。 */
function syncEnterpriseProfileForm(summary: AccountMeSummaryResponseBody | null): void {
  enterpriseProfileForm.name = summary?.enterpriseSummary?.name ?? "";
  enterpriseProfileForm.contactName = summary?.enterpriseSummary?.contactName ?? "";
  enterpriseProfileForm.contactEmail = summary?.enterpriseSummary?.contactEmail ?? "";
  enterpriseProfileForm.contactPhone = summary?.enterpriseSummary?.contactPhone ?? "";
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取头像失败"));
    reader.readAsDataURL(file);
  });
}

const enterpriseName = computed(() => props.summary?.enterpriseSummary?.name || "未加入企业");
const accessContext = computed(() => props.summary?.accessContext ?? null);
const isEnterpriseAdminIdentity = computed(() => accessContext.value?.identityType === "ENTERPRISE_ADMIN");
const isEnterpriseIdentity = computed(() =>
  accessContext.value?.identityType === "ENTERPRISE_ADMIN" || accessContext.value?.identityType === "ENTERPRISE_MEMBER",
);
const identityLabel = computed(() => formatAccountRole(props.summary?.accountRole, accessContext.value));
const identityTone = computed(() => resolveAccountIdentityTone(props.summary?.accountRole ?? null, accessContext.value));
const identityTagColor = computed(() => toneToTagColor(identityTone.value));
const tokenBalanceText = computed(() => {
  if (tokenBalanceLoading.value && exactTokenBalanceText.value === null && !tokenBalance.value) return "加载中";
  if (tokenBalanceError.value) return "加载失败";
  if (exactTokenBalanceText.value !== null) return exactTokenBalanceText.value;
  if (!tokenBalance.value) return "--";
  const balanceUsd = Number(tokenBalance.value.quota ?? 0);
  if (!Number.isFinite(balanceUsd)) return "--";
  const balanceYuan = Math.round(balanceUsd * DEFAULT_RELAY_USD_TO_CNY_RATE * 100) / 100;
  return `￥${balanceYuan.toFixed(2)}`;
});
const enterpriseTokenBalanceDisplayText = computed(() => {
  if (!isEnterpriseIdentity.value) return "";
  if (tokenBalanceLoading.value && enterpriseTokenBalanceText.value === null) return "加载中";
  if (enterpriseTokenBalanceError.value) return "加载失败";
  return enterpriseTokenBalanceText.value ?? "--";
});
const enterpriseTokenBalanceTitle = computed(() => isEnterpriseAdminIdentity.value
  ? "企业当前剩余 Token 总额，包含可分配余额与成员可用余额"
  : "当前账号获分配的企业 Token 余额");
const tokenBalanceCardTitle = computed(() => [tokenBalanceError.value, enterpriseTokenBalanceError.value]
  .filter(Boolean)
  .join("；") || "当前账号 Token 余额");
const pendingInvitations = computed(() => props.summary?.pendingEnterpriseInvitations ?? []);
const profileBusy = computed(() => Boolean(props.loading || props.savingProfile));
const cancellingBusy = computed(() => Boolean(props.cancellingAccount));
const hasAvatarDraft = computed(() => Boolean(avatarDraftUrl.value));
const profileDisplayName = computed(() => profileForm.fullName.trim() || props.summary?.fullName || props.summary?.email || "用户");
const profileDirty = computed(() => {
  const summary = props.summary;
  return profileForm.fullName !== (summary?.fullName ?? "")
    || profileForm.phone !== (summary?.phone ?? "")
    || (profileForm.avatarUrl ?? null) !== (summary?.avatarUrl ?? null);
});
const enterpriseProfileDirty = computed(() => {
  const enterprise = props.summary?.enterpriseSummary;
  return enterpriseProfileForm.name !== (enterprise?.name ?? "")
    || enterpriseProfileForm.contactName !== (enterprise?.contactName ?? "")
    || enterpriseProfileForm.contactEmail !== (enterprise?.contactEmail ?? "")
    || enterpriseProfileForm.contactPhone !== (enterprise?.contactPhone ?? "");
});

const keyState = computed(() => {
  const status = props.summary?.keySummary?.status;
  if (!props.summary?.keySummary) {
    return {
      label: "未绑定 Key",
      color: "default",
      description: "当前账号还没有可发送的 Key",
    };
  }
  if (status === "disabled") {
    return {
      label: "Key 已禁用",
      color: "red",
      description: "当前 Key 已被禁用，无法继续发送",
    };
  }
  if (status === "revoked") {
    return {
      label: "Key 已撤销",
      color: "red",
      description: "当前 Key 已撤销，需要重新分配",
    };
  }
  return {
    label: "Key 可用",
    color: "green",
    description: "可以直接将 Key 发送到注册邮箱",
  };
});

/** 个人信息页的身份标签颜色按套餐状态统一为绿/灰。 */
function resolveAccountIdentityTone(role: AccountMeSummaryResponseBody["accountRole"] | null, accessCtx: typeof accessContext.value): "success" | "default" | "danger" {
  if (accessCtx?.identityType === "SUPER_ADMIN" || role === "super_admin") return "danger";
  if (accessCtx?.identityType === "ENTERPRISE_ADMIN" || accessCtx?.identityType === "ENTERPRISE_MEMBER" || accessCtx?.identityType === "PERSONAL_USER") {
    return isAccessEditionActive(accessCtx) ? "success" : "default";
  }
  if (role === "enterprise_admin") {
    return isAccessEditionActive(accessCtx) ? "success" : "default";
  }
  return "default";
}

/** 仅 ACTIVE / EXPIRING 视为未到期。 */
function isAccessEditionActive(accessCtx: typeof accessContext.value): boolean {
  return accessCtx?.editionStatus === "ACTIVE" || accessCtx?.editionStatus === "EXPIRING";
}

/** 页面内统一把状态色映射到 Ant Tag 颜色。 */
function toneToTagColor(tone: "success" | "default" | "danger"): string {
  if (tone === "success") return "green";
  if (tone === "danger") return "red";
  return "default";
}

const keyValueLabel = computed(() => props.summary?.keySummary?.rawKey || props.summary?.keySummary?.keyPrefix || "--");
const invitationLink = computed(() => {
  const code = props.summary?.inviteCode?.trim();
  if (!code || typeof window === "undefined") return "";
  const url = new URL("/auth/register", window.location.origin);
  url.searchParams.set("invite", code);
  return url.toString();
});

/** 复制邀请码或注册链接，失败时向当前用户显式反馈。 */
async function copyInvitationValue(value: string, successText: string): Promise<void> {
  if (!value) {
    message.error("邀请码暂不可用");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    message.success(successText);
  } catch (error) {
    message.error(error instanceof Error ? `复制失败：${error.message}` : "复制失败，请稍后重试");
  }
}
const riskMessage = computed(() => {
  const security = props.summary?.securitySummary;
  if (!security) return "";
  if (security.lockedUntil > Date.now()) {
    return `当前账号已锁定至 ${formatTimestamp(security.lockedUntil)}。`;
  }
  if (security.forceReset) {
    return "账号被标记为需要尽快修改密码。";
  }
  if (security.failedAttempts > 0) {
    return `最近存在 ${security.failedAttempts} 次失败登录，请确认账号安全。`;
  }
  return "";
});

/** 清除当前余额真值，避免刷新或账号切换期间展示旧资金数据。 */
function clearTokenBalanceTruth(): void {
  tokenBalance.value = null;
  exactTokenBalanceText.value = null;
  enterpriseTokenBalanceText.value = null;
}

/** 取消当前余额请求，使关闭抽屉或账号切换后的迟到结果失效。 */
function cancelTokenBalanceRequest(kind: "scope-change" | "component-unmount" = "scope-change"): void {
  tokenBalanceRequestController?.abort(createCancelledRequestError(kind));
  tokenBalanceRequestController = null;
  tokenBalanceLoading.value = false;
}

/** 判断余额响应是否仍属于当前打开的账号抽屉。 */
function isCurrentTokenBalanceRequest(controller: AbortController): boolean {
  return props.open && tokenBalanceRequestController === controller && !controller.signal.aborted;
}

/** 读取个人及身份对应的企业余额；个人精确态缺失时兼容历史用量快照。 */
async function loadTokenBalance(): Promise<void> {
  cancelTokenBalanceRequest();
  clearTokenBalanceTruth();
  tokenBalanceError.value = "";
  enterpriseTokenBalanceError.value = "";
  if (!props.open || !props.summary?.userId) return;
  const controller = new AbortController();
  tokenBalanceRequestController = controller;
  tokenBalanceLoading.value = true;
  try {
    const enterprisePoolTask = isEnterpriseAdminIdentity.value
      ? getEnterpriseRelayBalancePool(ctx.value, {
        signal: controller.signal,
        enterpriseId: props.summary.enterpriseSummary?.enterpriseId ?? null,
      })
      : Promise.resolve(null);
    const [balancesResult, enterprisePoolResult] = await Promise.all([
      getMyRelayBalances(ctx.value, { signal: controller.signal }),
      enterprisePoolTask,
    ]);
    if (!isCurrentTokenBalanceRequest(controller)) return;
    if (!balancesResult.ok) {
      tokenBalanceError.value = balancesResult.message || "Token余额加载失败";
      if (isEnterpriseIdentity.value && !isEnterpriseAdminIdentity.value) {
        enterpriseTokenBalanceError.value = balancesResult.message || "企业 Token 余额加载失败";
      }
    } else {
      if (isEnterpriseIdentity.value && !isEnterpriseAdminIdentity.value) {
        enterpriseTokenBalanceText.value = formatRelayUsdUnitsAsYuan(balancesResult.enterprise?.remainingUsdUnits ?? "0");
      }
      if (balancesResult.personal) {
        exactTokenBalanceText.value = formatRelayUsdUnitsAsYuan(balancesResult.personal.availableUsdUnits);
      }
    }
    if (isEnterpriseAdminIdentity.value) {
      if (!enterprisePoolResult?.ok) {
        enterpriseTokenBalanceError.value = enterprisePoolResult?.message || "企业 Token 余额加载失败";
      } else {
        const remainingUnits = parseRelayUsdUnits(enterprisePoolResult.availableUsdUnits)
          + parseRelayUsdUnits(enterprisePoolResult.allocatedAvailableUsdUnits);
        enterpriseTokenBalanceText.value = formatRelayUsdUnitsAsYuan(remainingUnits);
      }
    }
    if (!balancesResult.ok || balancesResult.personal) return;
    const usageResult = await getMyRelayUsage(
      ctx.value,
      { includeCosts: false, snapshotOnly: true },
      { signal: controller.signal },
    );
    if (!isCurrentTokenBalanceRequest(controller)) return;
    if (!usageResult.ok) {
      tokenBalanceError.value = usageResult.message || "历史 Token 余额加载失败";
      return;
    }
    tokenBalance.value = usageResult.item;
  } catch (error) {
    if (isCancelledRequestError(error) || !isCurrentTokenBalanceRequest(controller)) return;
    const errorMessage = error instanceof Error ? error.message : "Token余额加载失败";
    tokenBalanceError.value = errorMessage;
    if (isEnterpriseIdentity.value) enterpriseTokenBalanceError.value = errorMessage;
  } finally {
    if (tokenBalanceRequestController === controller) {
      tokenBalanceRequestController = null;
      tokenBalanceLoading.value = false;
    }
  }
}

/** 充值到账后回读精确个人余额，刷新顶部概览。 */
function refreshTokenBalanceAfterRecharge(): void {
  void loadTokenBalance();
}

watch(
  () => props.summary,
  (summary, previousSummary) => {
    const previousFullName = previousSummary?.fullName ?? "";
    const previousPhone = previousSummary?.phone ?? "";
    const previousAvatarUrl = previousSummary?.avatarUrl ?? null;
    const formDirty = profileForm.fullName !== previousFullName
      || profileForm.phone !== previousPhone
      || (profileForm.avatarUrl ?? null) !== previousAvatarUrl;
    if (formDirty) {
      return;
    }
    syncProfileForm(summary ?? null);
  },
  { immediate: true },
);

watch(
  () => props.summary,
  (summary, previousSummary) => {
    const previousEnterprise = previousSummary?.enterpriseSummary;
    const formDirty = enterpriseProfileForm.name !== (previousEnterprise?.name ?? "")
      || enterpriseProfileForm.contactName !== (previousEnterprise?.contactName ?? "")
      || enterpriseProfileForm.contactEmail !== (previousEnterprise?.contactEmail ?? "")
      || enterpriseProfileForm.contactPhone !== (previousEnterprise?.contactPhone ?? "");
    if (!formDirty) syncEnterpriseProfileForm(summary ?? null);
  },
  { immediate: true },
);

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeTab.value = props.initialTab;
      void scrollToAccountSection(props.initialTab);
      void loadTokenBalance();
      return;
    }
    cancelTokenBalanceRequest();
    resetEnterpriseCreation();
    clearTokenBalanceTruth();
    tokenBalanceError.value = "";
    enterpriseTokenBalanceError.value = "";
    syncProfileForm(props.summary ?? null);
    syncEnterpriseProfileForm(props.summary ?? null);
    passwordForm.oldPassword = "";
    passwordForm.newPassword = "";
    passwordForm.confirmPassword = "";
    avatarModalOpen.value = false;
    myInvitationsOpen.value = false;
    avatarDraftUrl.value = null;
    if (avatarInput.value) avatarInput.value.value = "";
    resetCancellationForm();
    cancellationModalOpen.value = false;
  },
);

watch(
  () => props.initialTab,
  (tab) => {
    if (!props.open) return;
    activeTab.value = tab;
    void scrollToAccountSection(tab);
  },
);

watch(
  () => [
    props.summary?.userId ?? "",
    props.summary?.accessContext?.identityType ?? "",
    props.summary?.enterpriseSummary?.enterpriseId ?? "",
  ] as const,
  (scope, previousScope) => {
    if (scope[0] !== previousScope[0]) resetEnterpriseCreation();
    if (props.open && scope[0] && scope.some((value, index) => value !== previousScope[index])) void loadTokenBalance();
  },
);

onBeforeUnmount(() => {
  cancelTokenBalanceRequest("component-unmount");
});

function close() {
  emit("update:open", false);
}

function openAvatarModal() {
  avatarDraftUrl.value = profileForm.avatarUrl ?? null;
  avatarModalOpen.value = true;
}

function closeAvatarModal() {
  avatarModalOpen.value = false;
  avatarDraftUrl.value = null;
  if (avatarInput.value) avatarInput.value.value = "";
}

function confirmAvatarModal() {
  if (profileBusy.value) {
    return;
  }

  const nextAvatarUrl = avatarDraftUrl.value ?? null;
  if (nextAvatarUrl === (profileForm.avatarUrl ?? null)) {
    closeAvatarModal();
    return;
  }

  emit("save-avatar", {
    avatarUrl: nextAvatarUrl,
    onSuccess: () => {
      profileForm.avatarUrl = nextAvatarUrl;
      closeAvatarModal();
    },
  });
}

function pickAvatar() {
  avatarInput.value?.click();
}

function clearAvatar() {
  avatarDraftUrl.value = null;
  if (avatarInput.value) avatarInput.value.value = "";
}

async function handleAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  if (!file) return;

  try {
    const type = String(file.type ?? "").toLowerCase();
    if (!ALLOWED_AVATAR_TYPES.has(type)) {
      message.error("头像仅支持 JPG、PNG、WEBP、GIF 格式");
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      message.error("头像图片请控制在 512KB 以内");
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    if (!AVATAR_DATA_URL_RE.test(dataUrl)) {
      message.error("头像图片格式不受支持");
      return;
    }

    avatarDraftUrl.value = dataUrl;
    message.success("头像已载入");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取头像失败");
  } finally {
    if (input) input.value = "";
  }
}

function submitPasswordChange() {
  emit("change-password", {
    oldPassword: passwordForm.oldPassword,
    newPassword: passwordForm.newPassword,
    confirmPassword: passwordForm.confirmPassword,
  });
}

/** Resets the account cancellation form to its initial state. */
function resetCancellationForm() {
  cancellationForm.reason = null;
  cancellationForm.reasonText = "";
}

/** Opens the cancellation confirmation modal with a clean reason form. */
function openCancellationModal() {
  resetCancellationForm();
  cancellationModalOpen.value = true;
}

/** Closes the cancellation modal unless a cancellation request is in flight. */
function closeCancellationModal() {
  if (cancellingBusy.value) return;
  cancellationModalOpen.value = false;
  resetCancellationForm();
}

/** Emits the confirmed cancellation request after validating a reason was selected. */
function submitAccountCancellation() {
  if (!cancellationForm.reason) {
    message.error(CANCEL_COPY.reasonRequired);
    return;
  }
  emit("cancel-account", {
    reason: cancellationForm.reason,
    reasonText: cancellationForm.reason === "other" ? cancellationForm.reasonText.trim() || undefined : undefined,
  });
}

function saveProfile() {
  emit("save-profile", {
    fullName: profileForm.fullName.trim(),
    phone: profileForm.phone.trim(),
    avatarUrl: profileForm.avatarUrl ?? null,
  });
}

/** 提交企业管理员当前编辑的企业资料。 */
function saveEnterpriseProfile(): void {
  emit("save-enterprise", {
    name: enterpriseProfileForm.name.trim(),
    contactName: enterpriseProfileForm.contactName.trim(),
    contactEmail: enterpriseProfileForm.contactEmail.trim(),
    contactPhone: enterpriseProfileForm.contactPhone.trim(),
  });
}

</script>

<template>
  <a-drawer
    :open="open"
    :width="isH5Surface ? '100%' : 'min(760px, 100vw)'"
    :height="isH5Surface ? '100dvh' : undefined"
    :placement="isH5Surface ? 'bottom' : 'right'"
    :title="isH5Surface ? undefined : '个人信息'"
    :closable="!isH5Surface"
    :root-class-name="isH5Surface ? 'account-drawer-host account-drawer-host--h5' : 'account-drawer-host'"
    destroy-on-close
    @close="close"
  >
    <template v-if="isH5Surface" #title>
      <div class="account-drawer__h5-title">
        <button type="button" aria-label="返回个人中心" @click="close"><LeftOutlined /></button>
        <strong>{{ activeTabTitle }}</strong>
        <span aria-hidden="true" />
      </div>
    </template>
    <a-spin :spinning="loading">
      <template v-if="summary">
        <div class="account-drawer">
          <section v-if="!isH5Surface" class="account-drawer__hero">
            <div class="account-drawer__hero-avatar-panel">
              <button type="button" class="account-drawer__hero-avatar-button" :disabled="profileBusy" @click="openAvatarModal">
                <AccountAvatar
                  class="account-drawer__hero-avatar"
                  :display-name="profileDisplayName"
                  :avatar-url="profileForm.avatarUrl"
                  :size="HERO_AVATAR_SIZE"
                  shape="rounded"
                />
              </button>
              <div class="account-drawer__hero-avatar-copy">
                <span class="account-drawer__hero-avatar-tip">点击头像修改</span>
              </div>
            </div>
            <div class="account-drawer__hero-main">
              <div class="account-drawer__hero-top">
                <div class="account-drawer__hero-identity">
                  <h2>{{ profileDisplayName }}</h2>
                  <p>{{ summary.email }}</p>
                </div>
                <div class="account-drawer__hero-tags">
                  <a-tag :color="identityTagColor" :bordered="false">
                    {{ identityLabel }}
                  </a-tag>
                </div>
              </div>

              <div class="account-drawer__hero-meta">
                <div class="account-drawer__hero-meta-item">
                  <span class="account-drawer__hero-meta-icon"><BankOutlined /></span>
                  <div class="account-drawer__hero-meta-copy">
                    <small>企业归属</small>
                    <div class="account-drawer__enterprise-line">
                      <strong>{{ enterpriseName }}</strong>
                      <a-button
                        v-if="canCreateEnterprise"
                        size="small"
                        class="account-drawer__enterprise-create"
                        @click="createEnterpriseOpen = true"
                      >
                        <template #icon><PlusOutlined /></template>
                        创建企业
                      </a-button>
                    </div>
                  </div>
                </div>
                <div
                  class="account-drawer__hero-meta-item account-drawer__hero-meta-item--token"
                  :title="tokenBalanceCardTitle"
                >
                  <div class="account-drawer__hero-token-head">
                    <div class="account-drawer__hero-token-title">
                      <span class="account-drawer__hero-meta-icon account-drawer__hero-meta-icon--currency">￥</span>
                      <strong>Token余额</strong>
                    </div>
                    <div class="account-drawer__hero-meta-action">
                      <RelayBalancePackPurchaseButton
                        label="充值"
                        size="small"
                        entry-source="ACCOUNT_DRAWER"
                        @succeeded="refreshTokenBalanceAfterRecharge"
                      />
                    </div>
                  </div>
                  <div class="account-drawer__hero-token-balances" aria-live="polite">
                    <div class="account-drawer__hero-token-balance-row" aria-label="个人Token余额">
                      <small>个人余额</small>
                      <strong>{{ tokenBalanceText }}</strong>
                    </div>
                    <div
                      v-if="isEnterpriseIdentity"
                      class="account-drawer__hero-token-balance-row account-drawer__hero-token-balance-row--enterprise"
                      aria-label="企业Token余额"
                      :title="enterpriseTokenBalanceTitle"
                    >
                      <small>企业余额</small>
                      <strong>{{ enterpriseTokenBalanceDisplayText }}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

          </section>

          <a-alert v-if="!isH5Surface && riskMessage" type="warning" show-icon :message="riskMessage" />

          <section v-if="!isH5Surface && pendingInvitations.length" class="account-drawer__panel account-drawer__panel--notice">
            <header class="account-drawer__panel-head">
              <div>
                <strong>待确认企业邀请</strong>
                <small>企业管理员发起邀请后，需要您确认才能正式加入企业。</small>
              </div>
              <a-tag color="gold" :bordered="false">{{ pendingInvitations.length }} 条待处理</a-tag>
            </header>

            <div class="account-drawer__invitation-list">
              <div v-for="item in pendingInvitations" :key="item.invitationId" class="account-drawer__invitation-card">
                <div class="account-drawer__invitation-copy">
                  <strong>{{ item.enterpriseName }}</strong>
                  <p>{{ item.invitedByName }}（{{ item.invitedByEmail }}）邀请您加入企业。</p>
                  <small>邀请时间：{{ formatTimestamp(item.createdAt) }}</small>
                </div>
                <a-space wrap>
                  <a-button
                    type="primary"
                    :loading="respondingEnterpriseInvitation"
                    :disabled="respondingEnterpriseInvitation"
                    @click="emit('respond-enterprise-invitation', { invitationId: item.invitationId, action: 'accept' })"
                  >
                    确认加入
                  </a-button>
                  <a-button
                    :loading="respondingEnterpriseInvitation"
                    :disabled="respondingEnterpriseInvitation"
                    @click="emit('respond-enterprise-invitation', { invitationId: item.invitationId, action: 'decline' })"
                  >
                    暂不加入
                  </a-button>
                </a-space>
              </div>
            </div>
          </section>

          <div class="account-drawer__account-page">
            <div class="account-drawer__account-grid">
              <section class="account-drawer__panel">
                  <header class="account-drawer__panel-head">
                    <div>
                      <strong>个人资料</strong>
                    </div>
                  </header>

                  <a-form layout="vertical" class="account-drawer__profile-form" autocomplete="off">
                    <a-form-item label="登录邮箱">
                      <a-input :value="summary.email" disabled />
                    </a-form-item>
                    <a-form-item label="姓名">
                      <a-input
                        v-model:value="profileForm.fullName"
                        name="codeflow-account-profile-full-name"
                        autocomplete="new-password"
                        placeholder="请输入姓名"
                      />
                    </a-form-item>
                    <a-form-item label="手机号">
                      <a-input
                        v-model:value="profileForm.phone"
                        name="codeflow-account-profile-phone"
                        autocomplete="off"
                        placeholder="请输入手机号"
                      />
                    </a-form-item>
                  </a-form>

                  <div class="account-drawer__profile-actions">
                    <a-button
                      type="primary"
                      block
                      :loading="savingProfile"
                      :disabled="!profileForm.fullName.trim() || !profileForm.phone.trim() || !profileDirty"
                      @click="saveProfile"
                    >
                      保存
                    </a-button>
                  </div>
                </section>

                <section ref="passwordSectionRef" class="account-drawer__panel">
                  <header class="account-drawer__panel-head">
                    <div>
                      <strong>修改密码</strong>
                    </div>
                  </header>

                  <a-form layout="vertical">
                    <a-form-item label="旧密码">
                      <a-input-password v-model:value="passwordForm.oldPassword" placeholder="请输入旧密码" />
                    </a-form-item>
                    <a-form-item label="新密码">
                      <a-input-password v-model:value="passwordForm.newPassword" placeholder="至少 6 位" />
                    </a-form-item>
                    <a-form-item label="确认新密码">
                      <a-input-password v-model:value="passwordForm.confirmPassword" placeholder="请再次输入新密码" />
                    </a-form-item>
                  </a-form>

                  <a-button
                    type="primary"
                    block
                    :loading="changingPassword"
                    :disabled="!passwordForm.oldPassword || !passwordForm.newPassword || !passwordForm.confirmPassword"
                    @click="submitPasswordChange"
                  >
                    确认修改密码
                  </a-button>
                </section>

                <section v-if="!config.isDesktop" class="account-drawer__panel account-drawer__key-panel">
                  <header class="account-drawer__panel-head">
                    <div>
                      <strong>账号KEY</strong>
                    </div>
                    <a-tag :color="keyState.color" :bordered="false">{{ keyState.label }}</a-tag>
                  </header>

                  <template v-if="summary.keySummary">
                    <div class="account-drawer__key-strip">
                      <strong class="account-drawer__key-value">{{ keyValueLabel }}</strong>
                    </div>

                    <div class="account-drawer__key-actions">
                      <div class="account-drawer__key-action-copy">
                        <strong>发送到邮箱</strong>
                        <span>把当前 Key 投递到注册邮箱，不会生成新的 Key。</span>
                      </div>
                      <a-button type="primary" :loading="sendingKey" @click="emit('send-key')">
                        发送 Key
                      </a-button>
                      <div class="account-drawer__key-action-copy">
                        <strong>更换 Key</strong>
                        <span>旧 Key 会立即失效，Client需要使用新 Key 重新登录。</span>
                      </div>
                      <a-popconfirm
                        title="确认更换 Key？"
                        description="更换后旧 Key 将立即失效，当前在线 Client 会被断开。"
                        ok-text="确认更换"
                        cancel-text="取消"
                        @confirm="emit('rotate-key')"
                      >
                        <a-button :loading="rotatingKey">更换 Key</a-button>
                      </a-popconfirm>
                    </div>

                    <div class="account-drawer__notes account-drawer__notes--compact">
                      <div class="account-drawer__note-item">
                        <SafetyCertificateOutlined />
                        <span>怀疑泄露时请立即更换！</span>
                      </div>
                    </div>
                  </template>

                  <div v-else class="account-drawer__empty-panel">
                    <strong>当前账号没有 Key</strong>
                    <p>请先联系管理员为账号分配 Key。</p>
                  </div>
                </section>
              </div>

              <section v-if="!isH5Surface && isEnterpriseAdminIdentity" class="account-drawer__panel">
                <header class="account-drawer__panel-head">
                  <div>
                    <strong>企业信息</strong>
                  </div>
                </header>

                <a-form layout="vertical" class="account-drawer__profile-form" autocomplete="off">
                  <a-form-item label="企业名称">
                    <a-input
                      v-model:value="enterpriseProfileForm.name"
                      name="codeflow-enterprise-profile-name"
                      autocomplete="new-password"
                      placeholder="请输入企业名称"
                    />
                  </a-form-item>
                  <a-form-item label="联系人">
                    <a-input
                      v-model:value="enterpriseProfileForm.contactName"
                      name="codeflow-enterprise-contact-name"
                      autocomplete="off"
                      placeholder="请输入联系人姓名"
                    />
                  </a-form-item>
                  <a-form-item label="联系手机号">
                    <a-input
                      v-model:value="enterpriseProfileForm.contactPhone"
                      name="codeflow-enterprise-contact-phone"
                      autocomplete="off"
                      placeholder="请输入联系人手机号"
                    />
                  </a-form-item>
                  <a-form-item label="联系邮箱">
                    <a-input
                      v-model:value="enterpriseProfileForm.contactEmail"
                      name="codeflow-enterprise-contact-email"
                      autocomplete="off"
                      placeholder="请输入联系邮箱"
                    />
                  </a-form-item>
                </a-form>

                <div class="account-drawer__profile-actions">
                  <a-button
                    type="primary"
                    block
                    :loading="savingEnterpriseProfile"
                    :disabled="!enterpriseProfileForm.name.trim() || !enterpriseProfileDirty"
                    @click="saveEnterpriseProfile"
                  >
                    保存企业信息
                  </a-button>
                </div>
              </section>

              <section v-if="showInviteSection" class="account-drawer__panel account-drawer__invite-panel">
                  <header class="account-drawer__panel-head">
                    <div>
                      <strong>我的邀请码</strong>
                      <small>邀请码与当前账号永久绑定，不支持修改。</small>
                    </div>
                  </header>
                  <div class="account-drawer__invite-code" role="status">
                    {{ summary.inviteCode || "暂不可用" }}
                  </div>
                  <div class="account-drawer__invite-actions">
                    <a-button v-if="summary.accountRole !== 'super_admin'" @click="myInvitationsOpen = true">
                      <template #icon><TeamOutlined /></template>
                      邀请记录
                    </a-button>
                    <a-button :disabled="!summary.inviteCode" @click="copyInvitationValue(summary.inviteCode, '邀请码已复制')">
                      <template #icon><CopyOutlined /></template>
                      复制邀请码
                    </a-button>
                    <a-button type="primary" :disabled="!invitationLink" @click="copyInvitationValue(invitationLink, '注册链接已复制')">
                      <template #icon><LinkOutlined /></template>
                      复制注册链接
                    </a-button>
                  </div>
              </section>

              <section class="account-drawer__panel">
                <header class="account-drawer__panel-head">
                  <div>
                    <strong>获取帮助</strong>
                  </div>
                </header>
                <div class="account-drawer__qr-grid">
                  <article class="account-drawer__qr-card">
                    <span class="account-drawer__qr-label">微信群</span>
                    <img src="/images/contact/wechat-group-qr.png" alt="微信群二维码" class="account-drawer__qr-image" />
                    <p class="account-drawer__qr-caption">扫码加入微信群</p>
                  </article>
                  <article class="account-drawer__qr-card">
                    <span class="account-drawer__qr-label">客服微信</span>
                    <img src="/images/landing/customer-service-qr.png" alt="客服微信二维码" class="account-drawer__qr-image" />
                    <p class="account-drawer__qr-caption">扫码添加客服微信</p>
                  </article>
                  <article class="account-drawer__qr-card">
                    <span class="account-drawer__qr-label">公众号</span>
                    <img src="/images/contact/official-account-qr.jpg" alt="公众号二维码" class="account-drawer__qr-image" />
                    <p class="account-drawer__qr-caption">扫码关注公众号</p>
                  </article>
                </div>
              </section>

              <section v-if="!isH5Surface" ref="cancelSectionRef" class="account-drawer__panel">
                <div class="account-drawer__account-actions">
                  <a-button :loading="loggingOut" @click="emit('logout')">退出登录</a-button>
                  <a-button type="primary" danger :loading="cancellingAccount" @click="openCancellationModal">
                    {{ CANCEL_COPY.action }}
                  </a-button>
                </div>
              </section>
          </div>
        </div>
      </template>
      <a-empty v-else description="暂无个人中心数据" />
    </a-spin>

    <MyInvitationsModal :open="myInvitationsOpen" @close="myInvitationsOpen = false" />

    <a-modal :open="createEnterpriseOpen" title="创建企业" :confirm-loading="creatingEnterprise"
      :closable="!creatingEnterprise" :mask-closable="false" ok-text="创建企业"
      @ok="submitCreateEnterprise" @cancel="resetEnterpriseCreation">
      <a-form layout="vertical" @submit.prevent="submitCreateEnterprise">
        <a-form-item label="企业名称" extra="免费创建企业，成员人数不限。Token 按实际用量另计。">
          <a-input v-model:value="newEnterpriseName" :maxlength="100" :disabled="creatingEnterprise"
            placeholder="请输入企业名称" @press-enter="submitCreateEnterprise" />
        </a-form-item>
        <a-alert v-if="createEnterpriseError" type="error" show-icon :message="createEnterpriseError" />
      </a-form>
    </a-modal>

    <a-modal
      :open="cancellationModalOpen"
      :title="CANCEL_COPY.modalTitle"
      :ok-text="CANCEL_COPY.okText"
      :cancel-text="CANCEL_COPY.cancelText"
      :confirm-loading="cancellingBusy"
      :closable="!cancellingBusy"
      :mask-closable="!cancellingBusy"
      :keyboard="!cancellingBusy"
      :cancel-button-props="{ disabled: cancellingBusy }"
      :ok-button-props="{ danger: true, disabled: !cancellationForm.reason }"
      @ok="submitAccountCancellation"
      @cancel="closeCancellationModal"
    >
      <div class="account-drawer__cancel-modal">
        <a-alert type="warning" show-icon :message="CANCEL_COPY.modalIntro" />
        <a-form layout="vertical">
          <a-form-item :label="CANCEL_COPY.reasonLabel" required>
            <a-radio-group v-model:value="cancellationForm.reason" class="account-drawer__cancel-reasons">
              <a-radio v-for="item in CANCELLATION_REASON_OPTIONS" :key="item.value" :value="item.value">
                {{ item.label }}
              </a-radio>
            </a-radio-group>
          </a-form-item>
          <a-form-item v-if="cancellationForm.reason === 'other'">
            <a-textarea
              v-model:value="cancellationForm.reasonText"
              :placeholder="CANCEL_COPY.otherPlaceholder"
              :maxlength="500"
              :rows="3"
              show-count
            />
          </a-form-item>
        </a-form>
      </div>
    </a-modal>

    <a-modal
      :open="avatarModalOpen"
      title="修改头像"
      ok-text="完成"
      cancel-text="取消"
      :confirm-loading="savingProfile"
      :closable="!profileBusy"
      :mask-closable="!profileBusy"
      :keyboard="!profileBusy"
      :cancel-button-props="{ disabled: profileBusy }"
      @ok="confirmAvatarModal"
      @cancel="closeAvatarModal"
    >
      <div class="account-drawer__avatar-modal">
        <input
          ref="avatarInput"
          class="account-drawer__file-input"
          type="file"
          :accept="AVATAR_ACCEPT"
          @change="handleAvatarChange"
        />
        <div class="account-drawer__avatar-preview">
          <AccountAvatar
            class="account-drawer__avatar-preview-image"
            :display-name="profileDisplayName"
            :avatar-url="avatarDraftUrl"
            :size="MODAL_AVATAR_SIZE"
            shape="rounded"
          />
        </div>
        <div class="account-drawer__avatar-copy">
          <strong>{{ hasAvatarDraft ? "当前头像预览" : "未设置头像" }}</strong>
          <p>支持 JPG、PNG、WEBP、GIF，大小不超过 512KB。点击“完成”后会自动保存头像，无需再保存个人信息。</p>
          <div class="account-drawer__avatar-editor-actions">
            <a-button :disabled="profileBusy" @click="pickAvatar">上传头像</a-button>
            <a-button v-if="hasAvatarDraft" danger :disabled="profileBusy" @click="clearAvatar">清除头像</a-button>
          </div>
          <span class="account-drawer__avatar-editor-hint">取消会放弃本次头像改动。</span>
        </div>
      </div>
    </a-modal>
  </a-drawer>
</template>

<style scoped>
.account-drawer {
  display: grid;
  gap: 12px;
}

.account-drawer__hero {
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr);
  gap: 14px;
  align-items: stretch;
  padding: 14px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 14%, var(--app-border));
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--app-panel-bg) 94%, #fffaf4), color-mix(in srgb, var(--app-bg) 100%, #ffffff));
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.05);
}

.account-drawer__hero-avatar-panel {
  display: grid;
  gap: 12px;
  align-content: start;
  justify-items: start;
  min-width: 0;
}

.account-drawer__hero-avatar-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: auto;
  min-width: auto;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  transition: transform 0.16s ease;
}

.account-drawer__hero-avatar-button:disabled {
  cursor: default;
  opacity: 0.72;
}

.account-drawer__hero-avatar {
  display: block;
  max-width: 100%;
  max-height: 100%;
  transition: transform 0.16s ease, box-shadow 0.16s ease;
}

.account-drawer__hero-avatar-button:hover {
  transform: translateY(-1px);
}

.account-drawer__hero-avatar-button:hover .account-drawer__hero-avatar {
  transform: translateY(-1px);
}

.account-drawer__hero-avatar-copy {
  display: grid;
  gap: 4px;
  width: 112px;
  min-width: 112px;
  text-align: center;
}

.account-drawer__hero-avatar-tip {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
}

.account-drawer__hero-main {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.account-drawer__hero-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.account-drawer__hero-identity {
  min-width: 0;
}

.account-drawer__hero-top h2 {
  margin: 0;
  font-size: 24px;
  line-height: 1.18;
  color: var(--app-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.account-drawer__hero-top p {
  margin: 8px 0 0;
  color: var(--app-muted);
  font-size: 13px;
}

.account-drawer__hero-tags {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  width: max-content;
  max-width: 100%;
  gap: 6px;
}

.account-drawer__hero-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.account-drawer__hero-meta-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 62px;
  padding: 10px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 96%, #ffffff);
}

.account-drawer__hero-meta-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  color: color-mix(in srgb, var(--app-accent) 86%, #7f1d1d);
  background: color-mix(in srgb, var(--app-accent) 16%, #fff7f0);
  border: 1px solid color-mix(in srgb, var(--app-accent) 26%, #f3d2b6);
}

.account-drawer__hero-meta-item--token {
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  gap: 7px;
  padding: 9px 12px;
}

.account-drawer__hero-meta-action :deep(.ant-btn-sm) {
  height: 26px;
  padding-inline: 8px;
  font-size: 11px;
}

.account-drawer__hero-meta-icon--currency {
  color: var(--app-accent);
  font-size: 15px;
  font-weight: 700;
}

.account-drawer__hero-token-head,
.account-drawer__hero-token-title {
  display: flex;
  align-items: center;
}

.account-drawer__hero-token-head {
  justify-content: space-between;
  gap: 10px;
}

.account-drawer__hero-token-title {
  gap: 8px;
  min-width: 0;
}

.account-drawer__hero-token-title .account-drawer__hero-meta-icon {
  width: 26px;
  height: 26px;
  font-size: 13px;
}

.account-drawer__hero-token-title > strong {
  color: var(--app-text);
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
}

.account-drawer__hero-meta-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.account-drawer__hero-meta-copy small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.2;
}

.account-drawer__hero-meta-copy strong {
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.35;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.account-drawer__enterprise-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.account-drawer__enterprise-create.ant-btn {
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border-color: color-mix(in srgb, var(--app-accent) 22%, var(--app-divider));
  background: color-mix(in srgb, var(--app-accent) 8%, var(--app-panel-bg));
  color: var(--app-accent);
  font-size: 11px;
  box-shadow: none;
}

.account-drawer__enterprise-create.ant-btn:hover {
  border-color: color-mix(in srgb, var(--app-accent) 40%, var(--app-divider));
  background: color-mix(in srgb, var(--app-accent) 14%, var(--app-panel-bg));
  color: var(--app-accent);
}

.account-drawer__hero-token-balances {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr));
  gap: 8px 12px;
  min-width: 0;
  padding-top: 7px;
  border-top: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
}

.account-drawer__hero-token-balance-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.account-drawer__hero-token-balance-row small {
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
}

.account-drawer__hero-token-balance-row strong {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  min-width: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: end;
}

.account-drawer__hero-token-balance-row--enterprise strong {
  color: color-mix(in srgb, var(--app-accent) 84%, var(--app-text));
}

.account-drawer__account-page {
  display: grid;
  gap: 12px;
}

.account-drawer__account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: stretch;
}

.account-drawer__panel {
  display: grid;
  align-content: start;
  gap: 12px;
  height: 100%;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 10%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 98%, #ffffff);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.035);
}

.account-drawer__panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.account-drawer__panel-head strong {
  display: block;
  color: var(--app-text);
  font-size: 16px;
}

.account-drawer__panel-head small {
  display: block;
  margin-top: 2px;
  color: var(--app-muted);
  font-size: 12px;
}

/* 表单沿用 antd 默认 24px 行距会显著撑高抽屉，统一收紧到 14px。 */
.account-drawer :deep(.ant-form-item) {
  margin-bottom: 14px;
}

.account-drawer__profile-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 14px;
}

.account-drawer__account-grid .account-drawer__profile-form {
  grid-template-columns: 1fr;
}

.account-drawer__file-input {
  display: none;
}

.account-drawer__account-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.account-drawer__cancel-modal {
  display: grid;
  gap: 14px;
}

.account-drawer__cancel-reasons {
  display: grid;
  gap: 10px;
}

.account-drawer__avatar-modal {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  align-items: start;
  gap: 16px;
  min-width: 0;
}

.account-drawer__avatar-preview {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 120px;
  min-width: 120px;
  min-height: 120px;
  border-radius: 20px;
  background: color-mix(in srgb, var(--app-panel-bg) 90%, #fff);
  border: 1px solid color-mix(in srgb, var(--app-accent) 8%, var(--app-border));
}

.account-drawer__avatar-preview-image {
  display: block;
}

.account-drawer__avatar-copy {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.account-drawer__avatar-copy strong {
  color: var(--app-text);
  font-size: 15px;
  overflow-wrap: anywhere;
}

.account-drawer__avatar-copy p {
  margin: 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.account-drawer__avatar-editor-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}

.account-drawer__avatar-editor-actions :deep(.ant-btn) {
  flex: 0 1 auto;
  min-width: 0;
}

.account-drawer__avatar-editor-hint {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.account-drawer__profile-actions {
  display: grid;
  gap: 16px;
}

.account-drawer__key-panel {
  gap: 14px;
}

.account-drawer__key-strip {
  display: grid;
  gap: 6px;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 12%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 7%, var(--app-panel-bg));
}

.account-drawer__key-strip span,
.account-drawer__key-strip small {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.45;
}

.account-drawer__key-value {
  font-family: Consolas, "SFMono-Regular", monospace;
  color: var(--app-text);
  font-size: 16px;
  line-height: 1.45;
  word-break: break-all;
}

.account-drawer__key-action-copy span {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.account-drawer__key-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 14px;
  align-items: center;
  padding: 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 8%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 96%, #fffaf5);
}

.account-drawer__key-action-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.account-drawer__key-action-copy strong {
  color: var(--app-text);
  font-size: 14px;
}

.account-drawer__detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.account-drawer__detail-card {
  display: grid;
  gap: 6px;
  padding: 14px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--app-panel-bg) 94%, transparent);
  border: 1px solid color-mix(in srgb, var(--app-accent) 8%, var(--app-border));
}

.account-drawer__detail-card span {
  color: var(--app-muted);
  font-size: 12px;
}

.account-drawer__detail-card strong {
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.45;
  word-break: break-word;
}

.account-drawer__empty-panel {
  display: grid;
  gap: 6px;
  padding: 18px;
  border-radius: 18px;
  border: 1px dashed color-mix(in srgb, var(--app-accent) 16%, var(--app-border));
  background: color-mix(in srgb, var(--app-panel-bg) 96%, transparent);
}

.account-drawer__empty-panel strong {
  color: var(--app-text);
  font-size: 14px;
}

.account-drawer__empty-panel p {
  margin: 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.55;
}

.account-drawer__notes {
  display: grid;
  gap: 8px;
}

.account-drawer__notes--compact {
  padding-top: 2px;
}

.account-drawer__note-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: flex-start;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.account-drawer__note-item :deep(svg) {
  margin-top: 2px;
  color: var(--app-accent);
}

.account-drawer__panel--notice {
  gap: 14px;
}

.account-drawer__invitation-list {
  display: grid;
  gap: 12px;
}

.account-drawer__invitation-card {
  display: grid;
  gap: 12px;
  padding: 16px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, #d97757 18%, var(--app-border));
  background: linear-gradient(180deg, color-mix(in srgb, #fff6e8 88%, var(--app-panel-bg)), color-mix(in srgb, var(--app-panel-bg) 98%, #ffffff));
}

.account-drawer__invitation-copy {
  display: grid;
  gap: 6px;
}

.account-drawer__invitation-copy strong {
  color: var(--app-text);
  font-size: 15px;
}

.account-drawer__invitation-copy p,
.account-drawer__invitation-copy small {
  margin: 0;
  color: var(--app-muted);
  line-height: 1.6;
}

.account-drawer__qr-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}

.account-drawer__qr-card {
  display: grid;
  justify-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-bg);
  text-align: center;
}

.account-drawer__qr-label {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
}

.account-drawer__qr-image {
  display: block;
  width: 132px;
  height: 132px;
  object-fit: contain;
  border-radius: 8px;
  background: #fff;
}

.account-drawer__qr-caption {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.account-drawer__invite-panel {
  grid-column: 1 / -1;
}

.account-drawer__invite-code {
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-bg);
  color: var(--app-text);
  font-family: Consolas, "SFMono-Regular", monospace;
  font-size: 18px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.account-drawer__invite-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.account-drawer__h5-title {
  width: 100%;
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 8px;
}

.account-drawer__h5-title button {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 14px;
  color: var(--app-accent);
  background: transparent;
  font-size: 18px;
}

.account-drawer__h5-title strong {
  overflow: hidden;
  font-size: 16px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}



/* 桌面无边框窗口：抽屉覆盖标题栏拖拽区，须显式清除才能接收鼠标事件。 */
:global(.account-drawer-host) {
  -webkit-app-region: no-drag;
}

:global(.account-drawer-host .ant-drawer-body) {
  padding: 16px 18px;
}

:global(.account-drawer-host--h5 .ant-drawer-content-wrapper),
:global(.account-drawer-host--h5 .ant-drawer-content) {
  width: 100% !important;
  height: 100dvh !important;
  border-radius: 0;
}

:global(.account-drawer-host--h5 .ant-drawer-header) {
  min-height: calc(56px + env(safe-area-inset-top, 0px));
  padding: env(safe-area-inset-top, 0px) 6px 0;
  border-bottom: 1px solid var(--app-divider);
  background: color-mix(in srgb, var(--app-panel-bg) 88%, transparent);
  backdrop-filter: blur(22px) saturate(1.3);
}

:global(.account-drawer-host--h5 .ant-drawer-title) {
  width: 100%;
}

:global(.account-drawer-host--h5 .ant-drawer-body) {
  min-height: 0;
  overflow-y: auto;
  padding: 12px 12px max(12px, min(env(safe-area-inset-bottom, 0px), 8px));
  background: color-mix(in srgb, var(--app-bg) 94%, var(--app-surface));
}

:global(.account-drawer-host--h5 .account-drawer) {
  min-height: 100%;
}

@media (max-width: 640px) {
  .account-drawer__hero {
    grid-template-columns: 1fr;
  }

  .account-drawer__hero-avatar-panel {
    width: min(100%, 260px);
    justify-self: start;
  }

  .account-drawer__avatar-modal {
    grid-template-columns: 1fr;
  }

  .account-drawer__avatar-preview {
    width: 120px;
    min-width: 120px;
    min-height: 120px;
    justify-self: center;
  }

  .account-drawer__hero-top {
    flex-direction: column;
  }

  .account-drawer__profile-form {
    grid-template-columns: 1fr;
  }

  .account-drawer__key-actions {
    grid-template-columns: 1fr;
  }

  .account-drawer__key-actions :deep(.ant-btn) {
    width: 100%;
  }

  .account-drawer__detail-grid {
    grid-template-columns: 1fr;
  }

  .account-drawer__hero-meta {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 520px) {
  .account-drawer__account-grid {
    grid-template-columns: 1fr;
  }
}

</style>

