import type { AccountSessionToken, KeyHash, WorkspaceId } from "./ids.js";
import type { DeploymentInfo } from "./deployment.js";
import type { EngineModelProviderId, EngineType } from "./engine.js";
import type { PaymentFinalSource, PaymentOrderKind, PaymentOrderRelayTopUpSummary, PaymentOrderStatus } from "./payment.js";

export type AccountRole = "super_admin" | "enterprise_admin" | "personal_normal";
export type AccountStatus = "active" | "locked" | "disabled" | "cancelled";
export type AuthMode = "account";
export type UserKeyStatus = "active" | "disabled" | "revoked";
export type EnterpriseStatus = "active" | "disabled";
/** 历史已兑企业资格快照，仅用于只读记录。 */
export type HistoricalEnterpriseEntitlement = {
  openedAt: number;
  source: "PAYMENT" | "REDEMPTION" | "ADMIN" | "LEGACY";
  sourceId: string;
};
export type MembershipStatus = "active" | "removed";
export type MemberRole = "owner" | "member";
export type EnterpriseMemberDisplayRole = "enterprise_admin" | "shared_workspace_admin" | "team_member";
export type EnterpriseMemberInvitationStatus = "pending" | "accepted" | "declined" | "cancelled";
export type PackageLedgerSourceType = "init" | "renew" | "manual_adjust";
export type PackageScopeType = "ENTERPRISE" | "NONE";
export type PackageStatus = "NONE" | "ACTIVE" | "EXPIRING" | "EXPIRED";
export type AccessIdentityType = "SUPER_ADMIN" | "ENTERPRISE_ADMIN" | "ENTERPRISE_MEMBER" | "PERSONAL_USER";
export type AccessEditionType = "NONE" | "COMMUNITY" | "ENTERPRISE";
export type AccessEditionStatus = "NONE" | "ACTIVE" | "EXPIRING" | "EXPIRED";
export type EffectiveAccessScope =
  | "SUPER_ADMIN"
  | "ENTERPRISE_ACTIVE"
  | "ENTERPRISE_LIMITED"
  | "COMMUNITY";
export type VerificationPurpose = "register" | "forgot_password";
export type VerificationStatus = "pending" | "used" | "expired" | "failed";
export type NotificationChannel = "email";
export type MessageNotificationChannel = "dingtalk" | "wecom";
export type MessageNotificationReminderSourceType = "orchestration" | "chat";

export type MessageNotificationChannelConfigView = {
  channel: MessageNotificationChannel;
  enabled: boolean;
  webhookConfigured: boolean;
  webhookPreview: string;
  secretConfigured: boolean;
  keyword: string;
  atMobiles: string[];
  atUserIds: string[];
  atAll: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MyMessageNotificationChannelConfigView = MessageNotificationChannelConfigView & {
  webhook: string;
  secret: string;
};

export type UpdateMessageNotificationChannelConfigInput = {
  enabled: boolean;
  webhook?: string;
  clearWebhook?: boolean;
  secret?: string;
  clearSecret?: boolean;
  keyword?: string;
  atMobiles?: string[];
  atUserIds?: string[];
  atAll?: boolean;
};

export type MyMessageNotificationConfigResponseBody = {
  channels: Record<MessageNotificationChannel, MyMessageNotificationChannelConfigView>;
};

export type UpdateMyMessageNotificationConfigRequestBody = {
  dingtalk: UpdateMessageNotificationChannelConfigInput;
  wecom: UpdateMessageNotificationChannelConfigInput;
};

export type UpdateMyMessageNotificationConfigResponseBody = MyMessageNotificationConfigResponseBody;

/** Client 指定外部通知收件人；共享区场景由 Server 校验成员身份。 */
export type ReminderNotificationRecipientRouting = {
  sharedWorkspaceId?: string | null;
  recipientUserIds?: string[] | null;
};

export type ReminderCompletionNotificationPayload = ReminderNotificationRecipientRouting & {
  notificationKey: string;
  sourceType: MessageNotificationReminderSourceType;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  title: string;
  summary: string;
  targetId: string;
  completedAt: number;
};

export type ReminderActionNotificationPayload = ReminderNotificationRecipientRouting & {
  notificationKey: string;
  sourceType: MessageNotificationReminderSourceType;
  workspaceId: WorkspaceId;
  workspaceTitle: string;
  title: string;
  summary: string;
  targetId: string;
  statusLabel: string;
  actionLabel?: string | null;
  occurredAt: number;
};
export type AuditOperationType =
  | "package_purchase"
  | "package_adjustment"
  | "password_change"
  | "member_management"
  | "user_profile_change"
  | "enterprise_profile_change"
  | "account_management"
  | "enterprise_management"
  | "authentication"
  | "credential_delivery"
  | "system_management"
  | "shared_workspace"
  | "unknown";

export type AccountUserSummary = {
  userId: string;
  email: string;
  fullName: string;
  phone: string;
  avatarUrl: string | null;
  accountRole: AccountRole;
  status: AccountStatus;
  enterpriseId: string | null;
  enterpriseName: string | null;
};

export type PackageSummary = {
  purchasedPersonMonths: number;
  allocatedPersonMonths: number;
  availablePersonMonths: number;
  expiresAt: number;
  sourceType?: PackageLedgerSourceType | null;
  isEnterprise: boolean;
  scopeType?: PackageScopeType;
  planCode?: string | null;
  planName?: string | null;
  status?: PackageStatus;
  sourceOrderId?: string | null;
  sourcePaymentOrderId?: string | null;
};

export type AccessContext = {
  identityType: AccessIdentityType;
  editionType: AccessEditionType;
  editionStatus: AccessEditionStatus;
  effectiveAccessScope: EffectiveAccessScope;
  enterpriseId: string | null;
  enterpriseName: string | null;
};

export type AccountKeySummary = {
  userKeyId: string;
  apiKeyId: string;
  keyHash: KeyHash;
  keyPrefix: string;
  rawKey: string | null;
  status: UserKeyStatus;
  lastSentAt: number;
};

export type AccountSecuritySummary = {
  lastPasswordChangedAt: number;
  failedAttempts: number;
  lockedUntil: number;
  forceReset: boolean;
};

export type AccountLoginRequestBody = {
  email: string;
  password: string;
  captchaToken: string;
};

export type AccountLoginResponseBody = {
  sessionToken: AccountSessionToken;
  sessionExpiresAt: number;
  serverNow: number;
  authMode: "account";
  accountRole: AccountRole;
  homePath: string;
  userSummary: AccountUserSummary;
  accessContext: AccessContext;
  deployment?: DeploymentInfo;
};

export type CaptchaChallengeResponseBody = {
  challengeId: string;
  type: "puzzle";
  backgroundImage: string;
  pieceImage: string;
  imageWidth: number;
  imageHeight: number;
  pieceSize: number;
  pieceTop: number;
  slotLeft: number;
  tolerance: number;
  expiresAt: number;
};

/** 桌面弹框使用的四位图形数字验证码；token 与滑块 challenge 互不兼容。 */
export type NumericCaptchaChallengeResponseBody = {
  challengeId: string;
  type: "numeric";
  image: string;
  imageWidth: number;
  imageHeight: number;
  expiresAt: number;
};

export type SendVerificationCodeRequestBody = {
  purpose: VerificationPurpose;
  email: string;
  captchaToken: string;
};

export type VerificationEmailCheckRequestBody = {
  purpose: VerificationPurpose;
  email: string;
};

export type VerificationEmailCheckResponseBody = {
  purpose: VerificationPurpose;
  email: string;
};

export type CheckEnterpriseNameRequestBody = {
  enterpriseName: string;
};

export type CheckEnterpriseNameResponseBody = {
  enterpriseName: string;
  available: boolean;
};

export type SendVerificationCodeResponseBody = {
  ticketId: string;
  purpose: VerificationPurpose;
  sentAt: number;
  cooldownSec: number;
  delivered: boolean;
};

export type AccountRegisterRequestBody = {
  email: string;
  verificationCode: string;
  phone: string;
  fullName: string;
  password: string;
  confirmPassword: string;
  agreementAccepted: boolean;
  registerAsEnterpriseAdmin?: boolean;
  enterpriseName?: string;
  inviteCode?: string;
  inviteSource?: InviteSource;
};

export type AccountRegisterResponseBody = {
  userId: string;
  email: string;
  registeredAt: number;
  relayProvision?: {
    attempted: boolean;
    ok: boolean;
    code?: string;
    message?: string;
  };
};

export type ForgotPasswordRequestBody = {
  email: string;
  verificationCode: string;
  newPassword: string;
  confirmPassword: string;
};

export type ForgotPasswordResponseBody = {
  resetAt: number;
  nextAction: "go_login";
};

export type ChangePasswordRequestBody = {
  oldPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type ChangePasswordResponseBody = {
  changedAt: number;
};

export type AccountCancellationReason = "profile_error_reregister" | "other";

export type CancelMyAccountRequestBody = {
  reason: AccountCancellationReason;
  reasonText?: string;
};

export type CancelMyAccountResponseBody = {
  userId: string;
  cancelledAt: number;
};

export type UpdateMyProfileRequestBody = {
  fullName: string;
  phone: string;
  avatarUrl: string | null;
};

export type UpdateMyProfileResponseBody = AccountMeSummaryResponseBody;

/** 用户配置中保存的个人默认值和最大值；空值跟随后台配置。 */
export type AccountModelContextWindowOverrides = {
  contextWindow: number | null;
  maxContextWindow: number | null;
};

/** 历史账号窗口偏好的存储兼容类型，不再应用于运行时。 */
export type AccountModelContextPreference = {
  engine: EngineType;
  modelId: string;
  contextWindow: number;
  maxContextWindow?: number;
};

export type AccountMeSummaryResponseBody = {
  userId: string;
  email: string;
  fullName: string;
  phone: string;
  avatarUrl: string | null;
  accountRole: AccountRole;
  accessContext: AccessContext;
  enterpriseStatus: EnterpriseStatus | null;
  enterpriseSummary: EnterpriseSummary | null;
  pendingEnterpriseInvitations: EnterpriseMemberInvitationItem[];
  keySummary: AccountKeySummary | null;
  securitySummary: AccountSecuritySummary;
  inviteCode: string;
};

export type InviteSource = "manual" | "link";
export type MyInvitationListQuery = {
  page?: number;
  pageSize?: number;
};

export type MyInvitationInviteeItem = {
  fullName: string;
  maskedEmail: string;
  registeredAt: number;
};

export type MyInvitationInviteesResponseBody = {
  items: MyInvitationInviteeItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type SendDefaultKeyResponseBody = {
  sentAt: number;
  recipient: string;
  cooldownSec: number;
};

export type AccountWebSocketBridgeResponseBody = {
  bridgeToken: string;
  expiresAt: number;
  serverNow: number;
};

export type RotateDefaultKeyResponseBody = {
  sessionToken: AccountSessionToken;
  sessionExpiresAt: number;
  serverNow: number;
  authMode: "account";
  accountRole: AccountRole;
  homePath: string;
  userSummary: AccountUserSummary;
  accessContext: AccessContext;
  summary: AccountMeSummaryResponseBody;
};

export type EnterpriseSummary = {
  enterpriseId: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  ownerUserId: string;
  status: EnterpriseStatus;
  keyOverview: {
    active: number;
    disabled: number;
    missing: number;
  };
};

export type EnterpriseSummaryResponseBody = EnterpriseSummary;

export type EnterpriseMemberItem = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  joinedAt: number;
  memberRole: MemberRole;
  displayMemberRole?: EnterpriseMemberDisplayRole;
  membershipStatus: MembershipStatus | "pending_invitation";
  invitationStatus: EnterpriseMemberInvitationStatus | null;
  statusRemark: string;
  accountRole: AccountRole;
  accountStatus: AccountStatus;
  keyStatus: "active" | "disabled" | "missing";
  apiKeyId: string | null;
  keyPrefix: string | null;
  rawKey: string | null;
};

export type EnterpriseMembersResponseBody = {
  items: EnterpriseMemberItem[];
  total: number;
};

export type EnterpriseMemberSortBy = "joinedAt" | "email";
export type EnterpriseMemberSortDirection = "asc" | "desc";

export type EnterpriseMembersQuery = EnterpriseScopeRequestBody & {
  search?: string;
  status?: string;
  offset?: number;
  limit?: number;
  sortBy?: EnterpriseMemberSortBy;
  sortDirection?: EnterpriseMemberSortDirection;
};

export type EnterpriseCandidateItem = {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
  canAdd: boolean;
  reason: string | null;
};

export type EnterpriseCandidatesResponseBody = {
  items: EnterpriseCandidateItem[];
  total: number;
};

export type EnterpriseMemberInvitationItem = {
  invitationId: string;
  enterpriseId: string;
  enterpriseName: string;
  invitedByUserId: string;
  invitedByName: string;
  invitedByEmail: string;
  invitedEmail: string;
  memberRole: MemberRole;
  status: EnterpriseMemberInvitationStatus;
  createdAt: number;
  respondedAt: number;
};

export type EnterpriseScopeRequestBody = {
  enterpriseId?: string;
};

export type AddEnterpriseMemberRequestBody = EnterpriseScopeRequestBody & {
  email: string;
  memberRole?: MemberRole;
};

export type AddEnterpriseMemberResponseBody = {
  invitationId: string;
  enterpriseId: string;
  invitedUserId: string;
  invitedEmail: string;
  memberRole: MemberRole;
  status: EnterpriseMemberInvitationStatus;
};

export type RespondEnterpriseInvitationRequestBody = {
  action: "accept" | "decline";
};

export type RespondEnterpriseInvitationResponseBody = {
  invitationId: string;
  enterpriseId: string;
  status: EnterpriseMemberInvitationStatus;
  respondedAt: number;
  membershipId: string | null;
};

export type EnterpriseResetPasswordRequestBody = {
  newPassword: string;
  confirmPassword: string;
};

export type EnterpriseResetPasswordResponseBody = {
  resetAt: number;
  targetUserId: string;
};

export type UpdateEnterpriseMemberStatusRequestBody = {
  status: "active" | "disabled";
};

export type UpdateEnterpriseMemberStatusResponseBody = {
  membershipId: string;
  userId: string;
  accountStatus: AccountStatus;
  updatedAt: number;
};

export type RemoveEnterpriseMemberResponseBody = {
  membershipId: string;
  userId: string;
  removedAt: number;
};

export type PreviewRemoveEnterpriseMemberResponseBody = {
  membershipId: string;
  enterpriseId: string;
  userId: string;
};

export type UpdateEnterpriseProfileRequestBody = EnterpriseScopeRequestBody & {
  name?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
};

export type UpdateEnterpriseProfileResponseBody = EnterpriseSummary;

/** 自助建企仅接收名称，Owner 始终取当前账号。 */
export type CreateMyEnterpriseRequestBody = { name: string };

export type CreateEnterpriseResponseBody = {
  enterpriseId: string;
  ownerUserId: string;
  accountRoleUpdated: boolean;
};

/** 企业、套餐及通用类型只读，新码仅允许 Token。 */
export type RedemptionCodeKind = "ENTERPRISE" | "PACKAGE" | "TOKEN" | "UNIVERSAL";
export type RedemptionCodeBenefitScope = "PERSONAL" | "ENTERPRISE";
export type RedemptionCodeStoredBenefitScope = RedemptionCodeBenefitScope | "LEGACY";
export type RedemptionBenefitChoice = "ENTERPRISE" | "PACKAGE" | "TOKEN";

export type RedemptionBalanceSnapshot = {
  entitlement?: HistoricalEnterpriseEntitlement | null;
  packageExpiresAt: number;
  packageStatus: PackageStatus;
  tokenQuotaUsd: number;
};

export type RedemptionContentView = {
  kind: RedemptionCodeKind;
  packagePersonMonths: number;
  tokenAmountYuan: number;
  tokenQuotaUsd: number;
  exchangeRateSnapshot: number;
};

export type RedemptionRecordItem = RedemptionContentView & {
  id: string;
  codeId: string;
  codeMasked: string;
  userId: string;
  userEmail: string;
  userName: string;
  benefitScope: RedemptionCodeStoredBenefitScope;
  enterpriseId: string | null;
  enterpriseName: string | null;
  redeemedChoice: RedemptionBenefitChoice;
  before: RedemptionBalanceSnapshot;
  after: RedemptionBalanceSnapshot;
  packageDeltaPersonMonths: number;
  tokenDeltaAmountYuan: number;
  tokenDeltaQuotaUsd: number;
  relayLedgerId: string | null;
  packageBusinessOrderId: string | null;
  packagePaymentOrderId: string | null;
  redeemedAt: number;
  notificationSentAt: number | null;
  notificationErrorMessage: string;
};

export type RedeemCodeRequestBody = {
  code: string;
};

export type RedeemCodeResponseBody = {
  record: RedemptionRecordItem;
};

export type MyRedemptionRecordsResponseBody = {
  items: RedemptionRecordItem[];
  total: number;
};
export type InAppNoticeLinkType = "internal" | "external";

export type ActiveInAppNoticeItem = {
  noticeId: string;
  content: string;
  linkType: InAppNoticeLinkType;
  linkTarget: string;
};

export type ActiveInAppNoticesResponseBody = {
  items: ActiveInAppNoticeItem[];
  serverNow: number;
};

export type RelayIntegrationState = "disabled" | "misconfigured" | "enabled" | "unhealthy";
export type RelayLinkStatus = "active" | "inactive" | "deleted";
export type RelaySyncStatus = "synced" | "pending" | "failed";
export type RelayQuotaIntegrationStatus = "missing" | "synced" | "failed" | "inactive" | "instance_mismatch";
export type RelayRuntimeKeyStatus = "active" | "inactive" | "quota_exhausted" | "expired" | "unknown";
export type RelayProviderId = EngineModelProviderId;

export type RelayIntegrationStatusResponseBody = {
  enabled: boolean;
  state: RelayIntegrationState;
  managementState: RelayIntegrationState;
  publicBaseUrl: string;
  managementBaseUrlConfigured: boolean;
  publicBaseUrlConfigured: boolean;
  technicalUserConfigured: boolean;
  defaultGroupConfigured: boolean;
  providerGroupsConfigured: Record<RelayProviderId, boolean>;
  defaultKeyQuota: number;
  missingConfigKeys: string[];
  lastHealthCheckAt: number;
  lastErrorCode: string;
};

export type RelayQuotaItem = {
  userId: string;
  fullName: string;
  email: string;
  enterpriseId: string | null;
  enterpriseName: string | null;
  accountStatus: AccountStatus;
  memberRole: MemberRole | null;
  membershipStatus: MembershipStatus | null;
  codeflowApiKeyId: string | null;
  codeflowKeyPrefix: string | null;
  codeflowKeyStatus: "active" | "disabled" | "missing";
  providerId: RelayProviderId | null;
  linkId: string | null;
  upstreamKeyId: string | null;
  upstreamKeyPrefix: string | null;
  upstreamKeyName: string | null;
  linkStatus: RelayLinkStatus | null;
  syncStatus: RelaySyncStatus | null;
  integrationStatus: RelayQuotaIntegrationStatus;
  upstreamStatus: RelayRuntimeKeyStatus;
  upstreamUserBalance: number;
  upstreamKeyQuota: number;
  upstreamKeyQuotaUsed: number;
  allocatedQuota: number;
  quota: number;
  quotaUsed: number;
  usage5h: number;
  usage1d: number;
  usage7d: number;
  lastUsedAt: number;
  lastSyncedAt: number;
  lastErrorCode: string;
  lastErrorMessage: string;
};

export type RelayEnsureKeyRequestBody = {
  providerId?: RelayProviderId;
};

export type RelayEnsureKeyResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  item: RelayQuotaItem;
  key: {
    providerId: RelayProviderId;
    apiKeyId: string;
    rawKey: string;
    keyPrefix: string;
  };
};

/** Client 首次启动自动启用内置中转 Key 的响应体：只返回 Client 落地所需的凭证与地址。 */
export type ClientRelayEnsureKeyResponseBody = {
  key: {
    providerId: RelayProviderId;
    /** 桌面关联请求必须返回可信归属，旧 API Key 消费者可省略。 */
    keyId?: string;
    ownerUserId?: string;
    rawKey: string;
    baseUrl: string;
  };
};

export type RelaySelfKeyStatusResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  item: RelayQuotaItem | null;
};

export type RelayMemberQuotaAdjustType = "INCREASE" | "RECLAIM";

export type RelayMemberQuotaOperationStatus =
  | "PENDING"
  | "SYNCING"
  | "SUCCEEDED"
  | "REJECTED"
  | "RESULT_UNKNOWN"
  | "RECONCILING";

export type RelayAllocateMemberQuotaRequestBody = {
  adjustType?: RelayMemberQuotaAdjustType;
  amountUsdUnits?: string;
  version?: string;
  idempotencyKey?: string;
  note?: string | null;
};

export type RelayAllocateMemberQuotaResponseBody = {
  operationId: string;
  operationStatus: RelayMemberQuotaOperationStatus;
  adjustType: RelayMemberQuotaAdjustType;
  amountUsdUnits: string;
  enterpriseId: string;
  memberUserId: string;
  version: string;
};

export type RelayEnterpriseBalanceOperationView = {
  operationId: string;
  operationType: string;
  operationStatus: RelayMemberQuotaOperationStatus;
  adjustType: RelayMemberQuotaAdjustType;
  amountUsdUnits: string;
  memberUserId: string;
  errorCode: string | null;
  publicMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type RelayEnterpriseBalancePoolResponseBody = {
  enterpriseId: string;
  purchasedUsdUnits: string;
  availableUsdUnits: string;
  allocatedAvailableUsdUnits: string;
  consumedUsdUnits: string;
  availableFrozenUsdUnits: string;
  allocatedFrozenUsdUnits: string;
  refundedUsdUnits: string;
  expiredUsdUnits: string;
  version: string;
  updatedAt: number;
};

export type RelayEnterpriseMemberAllocationItem = {
  membershipId: string;
  userId: string;
  fullName: string;
  email: string;
  accountStatus: AccountStatus;
  memberRole: MemberRole;
  membershipStatus: MembershipStatus | "removing";
  grantedUsdUnits: string;
  consumedUsdUnits: string;
  remainingUsdUnits: string;
  frozenUsdUnits: string;
  returnedUsdUnits: string;
  expiredUsdUnits: string;
  allocationStatus: "active" | "frozen" | "inactive" | "exception";
  syncStatus: "pending" | "syncing" | "succeeded" | "failed";
  version: string;
  updatedAt: number;
  operation: RelayEnterpriseBalanceOperationView | null;
};

export type RelayEnterpriseMemberAllocationListResponseBody = {
  items: RelayEnterpriseMemberAllocationItem[];
  total: number;
  offset: number;
  limit: number;
};

export type RelayEnterpriseQuotaAdjustmentRecordStatusFilter =
  | "PROCESSING"
  | "SUCCEEDED"
  | "REJECTED"
  | "RESULT_UNKNOWN";

export type RelayEnterpriseQuotaAdjustmentRecordItem = {
  operationId: string;
  operationType: RelayBalanceOperationType;
  operationStatus: RelayMemberQuotaOperationStatus;
  adjustType: RelayMemberQuotaAdjustType;
  amountUsdUnits: string;
  memberBeforeUsdUnits: string | null;
  memberAfterUsdUnits: string | null;
  memberUserId: string;
  membershipId: string | null;
  memberFullName: string;
  memberEmail: string;
  actorUserId: string | null;
  actorFullName: string;
  actorEmail: string;
  note: string;
  requestId: string | null;
  errorCode: string | null;
  publicMessage: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type RelayEnterpriseQuotaAdjustmentRecordListQuery = {
  enterpriseId?: string | null;
  search?: string;
  adjustType?: RelayMemberQuotaAdjustType;
  status?: RelayEnterpriseQuotaAdjustmentRecordStatusFilter;
  createdFrom?: number;
  createdTo?: number;
  offset?: number;
  limit?: number;
};

export type RelayEnterpriseQuotaAdjustmentRecordListResponseBody = {
  items: RelayEnterpriseQuotaAdjustmentRecordItem[];
  total: number;
  offset: number;
  limit: number;
};

export type RelaySelfPersonalBalanceView = {
  availableUsdUnits: string;
  frozenUsdUnits: string;
  consumedUsdUnits: string;
  status: "INITIALIZING" | "ACTIVE" | "FROZEN" | "RECONCILING";
  version: string;
  updatedAt: number;
};

export type RelaySelfEnterpriseBalanceView = {
  enterpriseId: string;
  enterpriseName: string;
  membershipId: string;
  grantedUsdUnits: string;
  consumedUsdUnits: string;
  remainingUsdUnits: string;
  frozenUsdUnits: string;
  status: "active" | "frozen" | "inactive" | "exception";
  syncStatus: "pending" | "syncing" | "succeeded" | "failed";
  version: string;
  updatedAt: number;
};

export type RelaySelfBalancesResponseBody = {
  personal: RelaySelfPersonalBalanceView | null;
  enterprise: RelaySelfEnterpriseBalanceView | null;
  effective: {
    enterpriseAvailableUsdUnits: string;
    personalAvailableUsdUnits: string;
    totalAvailableUsdUnits: string;
    primaryScope: "enterprise" | "personal" | "none";
  };
};

export type RelayBalanceOperationType =
  | "PERSONAL_BALANCE_INITIALIZATION"
  | "PERSONAL_TOP_UP"
  | "KEY_CREATE"
  | "KEY_RESTORE"
  | "ENTERPRISE_ALLOCATION"
  | "ENTERPRISE_INCREASE"
  | "ADMIN_RECLAIM"
  | "MEMBERSHIP_RECLAIM"
  | "EXPIRY_RECLAIM"
  | "ACCOUNT_REVOKE"
  | "ENTERPRISE_REVOKE"
  | "REFUND"
  | "REPAIR";

export type RelayUsageItem = RelayQuotaItem & {
  todayActualCost: number;
  totalActualCost: number;
};

export type RelaySelfUsageQuery = {
  providerId?: RelayProviderId;
  includeCosts?: boolean;
  snapshotOnly?: boolean;
};

export type RelaySelfUsageResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  item: RelayUsageItem | null;
};

export type RelayUsageLogApiKeyView = {
  id: number;
  name: string;
};

export type RelayUsageLogItem = {
  id: number;
  user_id: number;
  api_key_id: number;
  account_id: number | null;
  request_id: string;
  model: string;
  service_tier?: string | null;
  reasoning_effort?: string | null;
  inbound_endpoint?: string | null;
  upstream_endpoint?: string | null;
  group_id: number | null;
  subscription_id: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cache_creation_5m_tokens: number;
  cache_creation_1h_tokens: number;
  input_cost: number;
  output_cost: number;
  cache_creation_cost: number;
  cache_read_cost: number;
  total_cost: number;
  actual_cost: number;
  rate_multiplier: number;
  billing_type: number;
  request_type?: string | null;
  stream: boolean;
  openai_ws_mode?: boolean;
  duration_ms: number | null;
  first_token_ms: number | null;
  image_count: number;
  image_size: string | null;
  image_input_size: string | null;
  image_output_size: string | null;
  image_size_source: string | null;
  image_size_breakdown: Record<string, number> | null;
  media_type?: string | null;
  user_agent: string | null;
  cache_ttl_overridden: boolean;
  billing_mode?: string | null;
  created_at: string;
  api_key?: RelayUsageLogApiKeyView | null;
};

export type RelaySelfUsageLogsQuery = {
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  timezone?: string;
  model?: string;
  requestType?: string;
  stream?: boolean;
  billingType?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
};

export type RelayUsageLogStats = {
  total_requests: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_tokens: number;
  total_tokens: number;
  total_cost: number;
  total_actual_cost: number;
  average_duration_ms: number;
};

export type RelaySelfUsageLogsResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  item: RelayQuotaItem | null;
  items: RelayUsageLogItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type RelaySelfUsageLogStatsResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  item: RelayQuotaItem | null;
  stats: RelayUsageLogStats;
};

export type RelaySelfUsageSummaryQuery = {
  startDate: string;
  endDate: string;
  timezone: string;
  apiKeyId?: number;
};

export type RelayUsageSummaryMetric = {
  requests: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  actualCost: number;
  averageDurationMs: number;
};

export type RelayUsageSummarySeriesItem = RelayUsageSummaryMetric & {
  date: string;
  dimensionKey: string;
  dimensionLabel: string;
};

export type RelayUsageSummaryDimensionItem = RelayUsageSummaryMetric & {
  key: string;
  label: string;
  costRatio: number;
};

export type RelayUsageSummaryDimension = {
  series: RelayUsageSummarySeriesItem[];
  dimensions: RelayUsageSummaryDimensionItem[];
};

export type RelaySelfUsageSummaryResponseBody = {
  status: RelayIntegrationStatusResponseBody;
  range: { startDate: string; endDate: string; timezone: string };
  total: RelayUsageSummaryMetric;
  byModel: RelayUsageSummaryDimension;
  byApiKey: RelayUsageSummaryDimension;
  apiKeys: Array<{ id: number; name: string; status?: string | null }>;
};

export type RelayQuotaLedgerEventType =
  | "PURCHASE_GRANT"
  | "FULFILL_RETRY"
  | "PERSONAL_OPENING_BALANCE"
  | "PERSONAL_PURCHASE_GRANT"
  | "ENTERPRISE_PURCHASE_GRANT"
  | "ENTERPRISE_ALLOCATION"
  | "ENTERPRISE_CONSUMPTION"
  | "PERSONAL_CONSUMPTION"
  | "ENTERPRISE_RECLAIM"
  | "MEMBERSHIP_RECLAIM"
  | "EXPIRY_RECLAIM"
  | "ENTERPRISE_REFUND"
  | "USAGE_REVERSAL"
  | "SYNC_REPAIR"
  | "MANUAL_ADJUST";

export type RelayQuotaLedgerStatus = "PENDING" | "SUCCEEDED" | "FAILED";
export type RelayLedgerScopeType = "USER" | "ENTERPRISE";

export type RelayQuotaLedgerItem = {
  id: string;
  eventType: RelayQuotaLedgerEventType;
  scopeType: RelayLedgerScopeType;
  codeflowUserId: string;
  enterpriseId: string | null;
  businessOrderId: string | null;
  paymentOrderId: string | null;
  skuCode: string | null;
  paidAmountFen: number;
  currency: string;
  exchangeRateSnapshot: number;
  quotaUnit: "USD";
  quotaBeforeUsd: number;
  quotaDeltaUsd: number;
  quotaAfterUsd: number;
  relayLinkId: string | null;
  upstreamKeyId: string | null;
  upstreamInstanceHash: string;
  upstreamTechUserHash: string;
  status: RelayQuotaLedgerStatus;
  idempotencyKey: string;
  errorCode: string;
  errorMessage: string;
  metadataJson: string;
  createdAt: number;
};

export type RelayQuotaLedgerListResponseBody = {
  items: RelayQuotaLedgerItem[];
  total: number;
};
export type RelaySelfQuotaLedgerResponseBody = RelayQuotaLedgerListResponseBody;

export type RelayUsageSnapshotItem = {
  id: string;
  syncRunId: string;
  scopeType: RelayLedgerScopeType;
  codeflowUserId: string;
  enterpriseId: string | null;
  relayLinkId: string;
  upstreamKeyId: string;
  upstreamStatus: string;
  quotaUsd: number;
  quotaUsedUsd: number;
  usage5hUsd: number;
  usage1dUsd: number;
  usage7dUsd: number;
  todayActualCostUsd: number;
  totalActualCostUsd: number;
  upstreamLastUsedAt: number;
  upstreamInstanceHash: string;
  upstreamTechUserHash: string;
  metadataJson: string;
  capturedAt: number;
  createdAt: number;
};

export type RelayUsageSnapshotSummary = {
  keyCount: number;
  totalQuotaUsd: number;
  totalQuotaUsedUsd: number;
  todayActualCostUsd: number;
  totalActualCostUsd: number;
  latestCapturedAt: number;
};

export type RelayUsageSnapshotListResponseBody = {
  items: RelayUsageSnapshotItem[];
  total: number;
};
export type RelaySelfUsageSnapshotResponseBody = RelayUsageSnapshotListResponseBody;

export type RelayUsageSyncResponseBody = {
  syncRunId: string;
  capturedAt: number;
  createdCount: number;
  skippedCount: number;
  summary: RelayUsageSnapshotSummary;
};

export type InvoiceType = "GENERAL" | "SPECIAL";
export type InvoiceApplicationStatus = "PENDING" | "APPLIED" | "FAILED";
export type InvoiceApplicationOrderStatus = "NONE" | InvoiceApplicationStatus;
export type InvoiceApplicationSource = "USER" | "ADMIN_MANUAL";
export type InvoiceIssueStatus = "PENDING" | "ISSUED";
export type InvoiceOrderKind = "PACKAGE" | "TOKEN";

export type InvoiceProfileView = {
  userId: string;
  invoiceType: InvoiceType;
  invoiceTitle: string;
  taxpayerId: string;
  recipientEmail: string;
  companyAddress: string;
  companyPhone: string;
  bankName: string;
  bankAccount: string;
  createdAt: number;
  updatedAt: number;
};

export type InvoiceApplicationSummary = {
  applicationId: string;
  status: InvoiceApplicationStatus;
  issueStatus: InvoiceIssueStatus;
  invoiceType: InvoiceType;
  requestedAt: number;
  updatedAt: number;
};

export type InvoiceApplicationView = {
  applicationId: string;
  businessOrderId: string;
  paymentOrderId: string | null;
  applicantUserId: string;
  applicantName: string | null;
  applicantEmail: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  invoiceType: InvoiceType;
  invoiceTitle: string;
  taxpayerId: string;
  recipientEmail: string;
  companyAddress: string;
  companyPhone: string;
  bankName: string;
  bankAccount: string;
  amountFen: number;
  currency: string;
  orderTitle: string;
  orderKind: InvoiceOrderKind;
  status: InvoiceApplicationStatus;
  issueStatus: InvoiceIssueStatus;
  source: InvoiceApplicationSource;
  notificationJobId: string | null;
  manualMarkedByUserId: string | null;
  manualMarkedAt: number | null;
  manualNote: string;
  issuedAt: number | null;
  issuedByUserId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type GetInvoiceProfileResponseBody = {
  profile: InvoiceProfileView | null;
  defaultRecipientEmail: string;
};

export type UpdateInvoiceProfileRequestBody = {
  invoiceType?: InvoiceType;
  invoiceTitle: string;
  taxpayerId?: string;
  recipientEmail?: string;
  companyAddress?: string;
  companyPhone?: string;
  bankName?: string;
  bankAccount?: string;
};

export type UpdateInvoiceProfileResponseBody = {
  profile: InvoiceProfileView;
};

export type CreateInvoiceApplicationRequestBody = {
  /** 用户在申请时确认的发票资料；缺省时兼容旧客户端使用已保存资料。 */
  invoiceProfile?: UpdateInvoiceProfileRequestBody;
};

export type CreateInvoiceApplicationResponseBody = {
  application: InvoiceApplicationView;
};

export type AccountOrderInfoScope = "PERSONAL" | "ENTERPRISE";

export type AccountOrderInfoRenewalMode =
  | "NONE"
  | "PERSONAL_CHECKOUT"
  | "ENTERPRISE_CHECKOUT"
  | "CONTACT_ENTERPRISE_ADMIN";

export type AccountOrderInfoPackageItem = {
  itemId: string;
  scope: AccountOrderInfoScope;
  displayName: string;
  enterpriseId: string | null;
  enterpriseName: string | null;
  purchasedPersonMonths: number;
  allocatedPersonMonths: number;
  availablePersonMonths: number;
  expiresAt: number;
  sourceType: PackageLedgerSourceType | null;
  planCode: string | null;
  planName: string | null;
  status: PackageStatus;
  renewalMode: AccountOrderInfoRenewalMode;
};

export type AccountOrderInfoPackagesResponseBody = {
  items: AccountOrderInfoPackageItem[];
  total: number;
};

export type AccountOrderInfoPaymentOrdersQuery = {
  page?: number;
  pageSize?: number;
  orderKind?: "ALL" | PaymentOrderKind;
  paidFrom?: number;
  paidTo?: number;
};

export type AccountOrderInfoPaymentOrderItem = {
  paymentOrderId: string | null;
  businessOrderId: string;
  scope: AccountOrderInfoScope;
  enterpriseId: string | null;
  enterpriseName: string | null;
  buyerUserId: string;
  buyerName: string | null;
  targetUserId: string;
  targetName: string | null;
  orderScene: string;
  orderKind: PaymentOrderKind;
  title: string;
  planCode: string;
  skuCode: string;
  billingCycle: string;
  durationMonths: number;
  paymentStatus: PaymentOrderStatus | null;
  orderStatus: string;
  fulfillmentStatus: string;
  amountFen: number;
  currency: string;
  finalSource: PaymentFinalSource | null;
  createdAt: number;
  paidAt: number | null;
  finalizedAt: number | null;
  relayTopUp: PaymentOrderRelayTopUpSummary | null;
  invoiceEligible: boolean;
  invoiceApplication: InvoiceApplicationSummary | null;
};

export type AccountOrderInfoPaymentOrdersResponseBody = {
  items: AccountOrderInfoPaymentOrderItem[];
  total: number;
  page: number;
  pageSize: number;
  serverNow: number;
};

export type AuditLogActorView = {
  userId: string | null;
  fullName: string | null;
  email: string | null;
  role: string;
};

export type AuditLogTargetView = {
  type: string;
  id: string;
  label: string;
  userId: string | null;
  fullName: string | null;
  email: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
};

export type AuditLogItem = {
  auditId: string;
  action: string;
  actionLabel: string;
  operationType: AuditOperationType;
  operationTypeLabel: string;
  result: string;
  createdAt: number;
  summary: string;
  actor: AuditLogActorView;
  target: AuditLogTargetView;
  enterprise: {
    enterpriseId: string | null;
    name: string | null;
  };
  beforeData: Record<string, unknown> | null;
  afterData: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
};

export type AuditLogFilters = {
  userId?: string;
  userKeyword?: string;
  enterpriseId?: string;
  enterpriseKeyword?: string;
  operationType?: AuditOperationType;
  result?: string;
  dateFrom?: number;
  dateTo?: number;
  offset?: number;
  limit?: number;
};

export type AuditLogsResponseBody = {
  items: AuditLogItem[];
  total: number;
};
