

export type PaymentProductKind = "VALIDATION_FIXED" | "BILLING_PLAN";

export type PaymentOrderStatus =
  | "CREATED"
  | "QR_READY"
  | "PAYING"
  | "PAID"
  | "CANCELLED"
  | "TIMEOUT"
  | "FAILED";

export type PaymentFinalSource =
  | "CALLBACK"
  | "QUERY"
  | "MANUAL_CANCEL"
  | "TIMEOUT_SWEEP"
  | "CREATE_FAIL";

export type PaymentOrderKind = "PACKAGE" | "TOKEN";

export type PaymentOrderRelayTopUpEventType =
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

export type PaymentOrderRelayTopUpStatus = "PENDING" | "SUCCEEDED" | "FAILED";

export type PaymentOrderRelayTopUpSummary = {
  ledgerId: string;
  eventType: PaymentOrderRelayTopUpEventType;
  status: PaymentOrderRelayTopUpStatus;
  paidAmountFen: number;
  currency: string;
  quotaBeforeUsd: number;
  quotaDeltaUsd: number;
  quotaAfterUsd: number;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
};

export type PaymentOrderTriggerSource =
  | "CREATE"
  | "CALLBACK"
  | "PAGE_REFRESH"
  | "DETAIL_DRAWER"
  | "SCHEDULER"
  | "USER_CANCEL"
  | "TIMEOUT_SWEEP"
  | "CREATE_FAIL";

export type PaymentQueryTriggerSource =
  | "PAGE_REFRESH"
  | "DETAIL_DRAWER"
  | "SCHEDULER"
  | "USER_CANCEL"
  | "TIMEOUT_SWEEP";

export type PaymentCloseReason = "USER_CANCELLED" | "VERIFY_TIMEOUT";

export type PaymentTradeState =
  | "SUCCESS"
  | "NOTPAY"
  | "USERPAYING"
  | "CLOSED"
  | "PAYERROR"
  | "REFUND"
  | "UNKNOWN";

export type PaymentCallbackVerifyStatus = "VERIFIED" | "INVALID" | "MISSING_HEADERS";
export type PaymentCallbackDecryptStatus = "DECRYPTED" | "DECRYPT_FAILED" | "NOT_REQUIRED";
export type PaymentCallbackProcessStatus =
  | "RECEIVED"
  | "PROCESSED"
  | "QUERY_REQUIRED"
  | "IGNORED"
  | "ERROR";

export type PaymentQueryResult = "CONFIRMED" | "PENDING" | "UPSTREAM_ERROR" | "NOT_FOUND";
export type PaymentEvidenceCompletenessStatus = "COMPLETE" | "PARTIAL";

export type VerificationProductView = {
  paymentEnabled: boolean;
  productCode: string;
  name: string;
  description: string;
  amountFen: number;
  currency: string;
  expireSeconds: number;
  pageScopeLabel: string;
};

export type PaymentStatusLogItem = {
  id: string;
  fromStatus: PaymentOrderStatus | null;
  toStatus: PaymentOrderStatus;
  triggerSource: PaymentOrderTriggerSource;
  triggerRef: string | null;
  reasonCode: string | null;
  reasonText: string | null;
  createdAt: number;
};

export type PaymentCallbackSummary = {
  callbackRecordId: string;
  notificationId: string;
  verifyStatus: PaymentCallbackVerifyStatus;
  decryptStatus: PaymentCallbackDecryptStatus;
  processStatus: PaymentCallbackProcessStatus;
  deliveryCount: number;
  tradeState: string | null;
  receivedAt: number;
  lastReceivedAt: number;
};

export type PaymentQueryCheckSummary = {
  queryCheckId: string;
  triggerSource: PaymentQueryTriggerSource;
  queryResult: PaymentQueryResult;
  tradeState: string | null;
  tradeStateDesc: string | null;
  confirmedStatus: PaymentOrderStatus | null;
  nextAction: string | null;
  verifiedAt: number;
};

export type PaymentEvidenceSummary = {
  evidenceId: string;
  terminalStatus: PaymentOrderStatus;
  confirmedBy: PaymentFinalSource;
  completenessStatus: PaymentEvidenceCompletenessStatus;
  generatedAt: number;
  summaryJson: Record<string, unknown>;
};

export type PaymentOrderListItemView = {
  orderId: string;
  outTradeNo: string;
  productCode: string;
  status: PaymentOrderStatus;
  amountFen: number;
  currency: string;
  finalSource: PaymentFinalSource | null;
  qrExpiresAt: number | null;
  finalizedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PaymentOrderDetailView = PaymentOrderListItemView & {
  title: string;
  description: string;
  orderScene: string;
  bizRefType: string;
  bizRefId: string;
  codeUrl: string | null;
  closeReason: string | null;
  wechatTransactionIdMasked: string | null;
  verifyAttemptCount: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  latestCallback: PaymentCallbackSummary | null;
  latestQueryCheck: PaymentQueryCheckSummary | null;
  evidence: PaymentEvidenceSummary | null;
  statusLogs: PaymentStatusLogItem[];
};

export type PaymentOrderFilterView = {
  status: "ALL" | PaymentOrderStatus;
  confirmedBy: "ALL" | PaymentFinalSource;
  keyword: string;
  page: number;
  pageSize: number;
};

export type VerificationProductResponseBody = VerificationProductView;

export type CreateVerificationOrderRequestBody = {
  productCode: string;
  reuseActiveOrder?: boolean;
  orderScene?: string;
  remark?: string;
};

export type VerificationOrderCreateResponseBody = {
  reused: boolean;
  order: PaymentOrderDetailView;
  pollIntervalMs: number;
};

export type ListVerificationOrdersParams = {
  status?: "ALL" | PaymentOrderStatus;
  confirmedBy?: "ALL" | PaymentFinalSource;
  keyword?: string;
  page?: number;
  pageSize?: number;
};

export type ListVerificationOrdersResponseBody = {
  items: PaymentOrderListItemView[];
  total: number;
  page: number;
  pageSize: number;
};

export type GetPaymentOrderDetailResponseBody = {
  order: PaymentOrderDetailView;
};

export type VerifyPaymentOrderRequestBody = {
  triggerSource: Extract<PaymentQueryTriggerSource, "PAGE_REFRESH" | "DETAIL_DRAWER">;
};

export type VerifyPaymentOrderResponseBody = {
  order: PaymentOrderDetailView;
  queryCheckId: string;
  nextVerifyAt: number | null;
};

export type CancelPaymentOrderRequestBody = {
  reason?: PaymentCloseReason;
};

export type CancelPaymentOrderResponseBody = {
  order: PaymentOrderDetailView;
  closeAccepted: boolean;
};
