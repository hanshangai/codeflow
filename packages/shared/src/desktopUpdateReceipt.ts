import crypto from "node:crypto";

export const DESKTOP_UPDATE_RECEIPT_STAGES = ["received", "verified", "prepared", "switched", "healthy", "rolled_back", "unavailable"] as const;
export type DesktopUpdateReceiptStage = typeof DESKTOP_UPDATE_RECEIPT_STAGES[number];
export type DesktopUpdateReceiptErrorCode = "DESKTOP_RELEASE_FAILED";

export type DesktopUpdateReceipt = {
  schemaVersion: 1;
  deviceId: string;
  requestId: string;
  releaseId: string;
  archiveSha256: string;
  stage: DesktopUpdateReceiptStage;
  at: string;
  errorCode: DesktopUpdateReceiptErrorCode | null;
  errorId: string | null;
  payloadSha256: string;
};

export type DesktopUpdateReceiptAck = Pick<DesktopUpdateReceipt,
  "deviceId" | "requestId" | "releaseId" | "archiveSha256" | "stage" | "at" | "payloadSha256">;

export type DesktopUpdateReceiptTarget = Pick<DesktopUpdateReceipt, "releaseId" | "archiveSha256">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^(?!con(?:\.|$)|prn(?:\.|$)|aux(?:\.|$)|nul(?:\.|$)|com[1-9](?:\.|$)|lpt[1-9](?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/iu;
const DIGEST = /^[a-f0-9]{64}$/u;
const FIELDS = ["schemaVersion", "deviceId", "requestId", "releaseId", "archiveSha256", "stage", "at", "errorCode", "errorId", "payloadSha256"] as const;

/** 严格校验阶段回执，拒绝未知字段和不完整终态信息。 */
export function assertDesktopUpdateReceipt(value: unknown): asserts value is DesktopUpdateReceipt {
  if (!isRecord(value) || Object.keys(value).length !== FIELDS.length || Object.keys(value).some(key => !FIELDS.includes(key as typeof FIELDS[number]))) {
    throw new Error("DESKTOP_UPDATE_RECEIPT_INVALID");
  }
  const receipt = value as DesktopUpdateReceipt;
  if (receipt.schemaVersion !== 1 || !isText(receipt.deviceId) || !isText(receipt.requestId)
    || !isText(receipt.releaseId) || !isText(receipt.archiveSha256) || !isText(receipt.payloadSha256)
    || !UUID.test(receipt.deviceId) || !UUID.test(receipt.requestId)
    || !ID.test(receipt.releaseId) || /[. ]$/u.test(receipt.releaseId)
    || !DIGEST.test(receipt.archiveSha256) || !DIGEST.test(receipt.payloadSha256)
    || !DESKTOP_UPDATE_RECEIPT_STAGES.includes(receipt.stage)
    || !isIsoTime(receipt.at)) throw new Error("DESKTOP_UPDATE_RECEIPT_INVALID");
  const terminal = receipt.stage === "rolled_back" || receipt.stage === "unavailable";
  if (terminal) {
    if (receipt.errorCode !== "DESKTOP_RELEASE_FAILED" || !isText(receipt.errorId) || !UUID.test(receipt.errorId)) throw new Error("DESKTOP_UPDATE_RECEIPT_INVALID");
  } else if (receipt.errorCode !== null || receipt.errorId !== null) throw new Error("DESKTOP_UPDATE_RECEIPT_INVALID");
  if (receipt.payloadSha256 !== digestPayload(receipt)) throw new Error("DESKTOP_UPDATE_RECEIPT_INVALID");
}

/** 计算稳定回执摘要，摘要不包含自身。 */
export function digestDesktopUpdateReceipt(value: unknown): string {
  assertDesktopUpdateReceipt(value);
  return digestPayload(value);
}

/** 校验并返回带摘要的完整回执，避免调用方忘记绑定原始证据。 */
export function createDesktopUpdateReceipt(value: Omit<DesktopUpdateReceipt, "payloadSha256">): DesktopUpdateReceipt {
  const payload = { ...value, payloadSha256: "0".repeat(64) };
  const digest = digestPayload({ ...value, payloadSha256: "0".repeat(64) } as DesktopUpdateReceipt);
  const receipt = { ...payload, payloadSha256: digest };
  assertDesktopUpdateReceipt(receipt);
  return receipt;
}

/** 将已校验回执转换为不含错误正文的精确确认。 */
export function toDesktopUpdateReceiptAck(value: DesktopUpdateReceipt): DesktopUpdateReceiptAck {
  assertDesktopUpdateReceipt(value);
  return {
    deviceId: value.deviceId, requestId: value.requestId, releaseId: value.releaseId,
    archiveSha256: value.archiveSha256, stage: value.stage, at: value.at, payloadSha256: value.payloadSha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

function isIsoTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** 正则校验前先确认文本类型，拒绝数组等可被隐式转字符串的值。 */
function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** 固定字段顺序生成摘要，避免 JSON 属性排列改变幂等身份。 */
function digestPayload(value: DesktopUpdateReceipt): string {
  const payload = FIELDS.filter(field => field !== "payloadSha256").map(field => [field, value[field]]);
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
