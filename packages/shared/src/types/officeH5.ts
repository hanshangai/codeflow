import type { AccessContext, AccountLoginResponseBody, AccountUserSummary, EffectiveAccessScope } from "./account.js";
import type { KeyHash, WebSessionId, WorkspaceId } from "./ids.js";

export type OfficePlatform = "wecom" | "dingtalk";
export type OfficeH5ClientKind = "mobile" | "desktop" | "unknown";
export type OfficeH5BootstrapStatus =
  | "checking"
  | "ready"
  | "unbound"
  | "member_disabled"
  | "enterprise_limited"
  | "token_unavailable"
  | "forbidden"
  | "platform_error";

export type OfficeH5ReasonCode =
  | "OFFICE_H5_UNBOUND"
  | "OFFICE_H5_MEMBER_DISABLED"
  | "OFFICE_H5_ENTERPRISE_LIMITED"
  | "OFFICE_H5_TOKEN_UNAVAILABLE"
  | "OFFICE_H5_FORBIDDEN"
  | "OFFICE_H5_PLATFORM_ERROR"
  | "OFFICE_H5_STATE_CHANGED";

export type OfficeH5RecoveryAction =
  | "retry"
  | "bind_account"
  | "contact_admin"
  | "open_web"
  | "back_to_office"
  | "refresh";

export type OfficeH5Action =
  | "thread.create"
  | "thread.rename"
  | "thread.archive"
  | "thread.delete"
  | "thread.send"
  | "turn.interrupt"
  | "orch.feedback"
  | "orch.clarify"
  | "orch.approve"
  | "orch.reject"
  | "orch.request_changes"
  | "orch.resume"
  | "orch.node_start"
  | "orch.node_skip"
  | "open_web";

export type OfficeH5PlatformContext = {
  platform: OfficePlatform;
  corpId: string;
  enterpriseId: string | null;
  clientKind: OfficeH5ClientKind;
  entryChannel: "office_h5";
  requestId: string;
};

export type OfficeH5EntitlementSummary = {
  effectiveAccessScope: EffectiveAccessScope;
  accessStatus: "available" | "limited" | "unknown";
  tokenStatus: "available" | "unavailable" | "unknown";
  canExecute: boolean;
  safeMessage: string;
};

export type AccountH5BootstrapStatus = "ready" | "forbidden" | "member_disabled" | "enterprise_limited" | "token_unavailable";

export type AccountH5ReasonCode =
  | "H5_FORBIDDEN"
  | "H5_MEMBER_DISABLED"
  | "H5_ENTERPRISE_LIMITED"
  | "H5_TOKEN_UNAVAILABLE";

export type AccountH5BootstrapRequest = {
  clientKind?: OfficeH5ClientKind | null;
};

export type AccountH5BootstrapResponse = {
  status: AccountH5BootstrapStatus;
  serverNow: number;
  requestId: string;
  userSummary: AccountUserSummary | null;
  accessContext: AccessContext | null;
  entitlement: OfficeH5EntitlementSummary | null;
  reasonCode?: AccountH5ReasonCode | null;
  message?: string | null;
  recoveryActions: OfficeH5RecoveryAction[];
};

export type OfficeH5UserSummary = AccountUserSummary;

export type OfficeH5BootstrapRequest = {
  platform: OfficePlatform;
  authCode: string;
  corpId: string;
  state: string;
  redirectUri: string;
  enterpriseId?: string | null;
  clientKind?: OfficeH5ClientKind | null;
};

export type OfficeH5ResumeRequest = {
  platform: OfficePlatform;
  corpId: string;
  credential: string;
  enterpriseId?: string | null;
  clientKind?: OfficeH5ClientKind | null;
};

export type OfficeH5StateIssueRequest = {
  platform: OfficePlatform;
  corpId: string;
  redirectUri: string;
  enterpriseId?: string | null;
};

export type OfficeH5StateIssueResponse = {
  state: string;
  expiresAt: number;
  serverNow: number;
};

export type OfficeH5OAuthStartRequest = {
  platform: OfficePlatform;
  corpId: string;
  redirectUri: string;
  enterpriseId?: string | null;
  clientKind?: OfficeH5ClientKind | null;
};

export type OfficeH5OAuthStartResponse = {
  platform: OfficePlatform;
  corpId: string;
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  expiresAt: number;
  serverNow: number;
};

export type OfficeH5LoginOption = {
  platform: OfficePlatform;
  available: boolean;
  corpId: string | null;
  message: string | null;
};

export type OfficeH5LoginOptionsResponse = {
  options: OfficeH5LoginOption[];
  serverNow: number;
};

export type OfficeH5EnterpriseAppView = {
  platform: OfficePlatform;
  enterpriseId: string;
  corpId: string;
  appId: string;
  agentId: string | null;
  appKey: string | null;
  enabled: boolean;
  secretConfigured: boolean;
  allowedRedirectHost: string | null;
  entryUrl: string | null;
  callbackUrl: string | null;
  updatedAt: number | null;
};

export type OfficeH5EnterpriseAppsResponse = {
  enterpriseId: string;
  h5PublicBaseUrl: string | null;
  apps: OfficeH5EnterpriseAppView[];
  serverNow: number;
};

export type UpsertOfficeH5EnterpriseAppRequest = {
  platform: OfficePlatform;
  corpId: string;
  agentId?: string | null;
  appKey?: string | null;
  secret?: string | null;
  enabled?: boolean;
};

export type OfficeH5BindingView = {
  platform: OfficePlatform;
  corpId: string | null;
  bound: boolean;
  lastSeenAt: number | null;
  message: string | null;
};

export type OfficeH5MyBindingsResponse = {
  bindings: OfficeH5BindingView[];
  serverNow: number;
};

export type OfficeH5BindingStartRequest = {
  platform: OfficePlatform;
  corpId: string;
  redirectUri: string;
  clientKind?: OfficeH5ClientKind | null;
};

export type OfficeH5BindingCompleteRequest = {
  platform: OfficePlatform;
  authCode: string;
  corpId: string;
  state: string;
  redirectUri: string;
  clientKind?: OfficeH5ClientKind | null;
};

export type OfficeH5BindingCompleteResponse = {
  platform: OfficePlatform;
  corpId: string;
  boundAt: number;
};

export type OfficeH5BindingRevokeRequest = {
  platform: OfficePlatform;
};

export type OfficeH5BindingRevokeResponse = {
  platform: OfficePlatform;
  revokedCount: number;
  revokedAt: number;
};

export type OfficeH5BootstrapResponse = {
  status: OfficeH5BootstrapStatus;
  serverNow: number;
  sessionToken?: AccountLoginResponseBody["sessionToken"] | null;
  sessionExpiresAt?: number | null;
  authMode?: "account" | null;
  accountRole?: AccountLoginResponseBody["accountRole"] | null;
  homePath?: string | null;
  userSummary?: OfficeH5UserSummary | null;
  accessContext?: AccessContext | null;
  entitlement?: OfficeH5EntitlementSummary | null;
  platformContext: OfficeH5PlatformContext;
  reasonCode?: OfficeH5ReasonCode | null;
  message?: string | null;
  recoveryActions: OfficeH5RecoveryAction[];
  resumeCredential?: string | null;
  resumeExpiresAt?: number | null;
};

export type OfficeH5ResumeResponse =
  | { resumed: true; bootstrap: OfficeH5BootstrapResponse }
  | { resumed: false; message: string };

export type OfficeH5ActionGuardRequest = {
  action: OfficeH5Action;
  platform?: OfficePlatform | null;
  corpId?: string | null;
  requestId?: string | null;
  workspaceId?: WorkspaceId | null;
  webSessionId?: WebSessionId | null;
  threadId?: string | null;
  turnId?: string | null;
  instanceId?: string | null;
  nodeId?: string | null;
  requirementId?: string | null;
  clientItemId?: string | null;
};

export type OfficeH5ActionGuardResponse = {
  allowed: boolean;
  reasonCode?: OfficeH5ReasonCode | null;
  message?: string | null;
  requestId: string;
  latestStateHint?: string | null;
  entitlement?: OfficeH5EntitlementSummary | null;
  recoveryActions?: OfficeH5RecoveryAction[] | null;
};

export type OfficeH5JsSdkSignatureRequest = {
  platform: OfficePlatform;
  corpId: string;
  url: string;
};

export type OfficeH5JsSdkSignatureResponse = {
  platform: OfficePlatform;
  corpId: string;
  appId: string;
  agentId?: string | null;
  nonceStr: string;
  timestamp: number;
  signature: string;
  jsApiList: string[];
};

export type OfficeH5RequestMeta = {
  platform?: OfficePlatform | null;
  corpId?: string | null;
  requestId?: string | null;
  entryChannel?: "office_h5" | null;
};

export type OfficeH5SessionGrant = {
  keyHash: KeyHash;
  userSummary: AccountUserSummary;
  accessContext: AccessContext;
};
