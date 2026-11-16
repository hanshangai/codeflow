import type { DesktopUpdateFailureRecord, UpdateFailureAck } from "@codeflowai/shared/desktop-update-failure";
import type { createUpdateFailureJournal } from "./updateFailureJournal.js";

type FailureTransport = {
  register(options?: { signal?: AbortSignal }): Promise<unknown>;
  requestJson(input: { method: "POST"; path: string; body: DesktopUpdateFailureRecord; requestId: string; signal?: AbortSignal }): Promise<unknown>;
};

/** 沿原单日志补报；签名复用证据 UUID，原更新 requestId 留在正文及失败上下文。 */
export async function deliverDesktopUpdateFailures(input: {
  journal: ReturnType<typeof createUpdateFailureJournal>;
  deviceId: string;
  transport: FailureTransport;
  signal?: AbortSignal;
}): Promise<void> {
  const pending = input.journal.pending(input.deviceId);
  if (!pending.length) return;
  let requestId = pending[0]!.requestId;
  try {
    await input.transport.register({ signal: input.signal });
    await input.journal.flush(input.deviceId, async record => {
      requestId = record.requestId;
      const response = await input.transport.requestJson({
        method: "POST", path: "/api/software/desktop/update-failures", body: record, requestId: record.errorId, signal: input.signal,
      });
      return extractFailureAck(response);
    });
  } catch (error) {
    throw withFailureDeliveryContext(error, requestId);
  }
}

/** 在发送边界补齐固定诊断上下文，避免主进程丢失失败条目的 requestId。 */
function withFailureDeliveryContext(error: unknown, requestId: string): Error & { code: string; requestId: string } {
  const message = error instanceof Error ? error.message : "DESKTOP_UPDATE_FAILURE_DELIVERY_FAILED";
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : (message.startsWith("DESKTOP_UPDATE_ACK_MISMATCH") || message.startsWith("DESKTOP_UPDATE_FAILURE_ACK_INVALID"))
      ? "DESKTOP_UPDATE_FAILURE_ACK_INVALID" : "DESKTOP_UPDATE_FAILURE_DELIVERY_FAILED";
  return Object.assign(new Error(message, { cause: error }), { code, requestId });
}

/** 严格解析错误补报确认 envelope，拒绝 ok 以外的未知字段。 */
function extractFailureAck(value: unknown): UpdateFailureAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DESKTOP_UPDATE_FAILURE_ACK_INVALID");
  const response = value as Record<string, unknown>;
  const fields = ["ok", "errorId", "deviceId", "payloadSha256"];
  if (Object.keys(response).length !== fields.length || fields.some(field => !Object.hasOwn(response, field)) || response.ok !== true
    || typeof response.errorId !== "string" || typeof response.deviceId !== "string" || typeof response.payloadSha256 !== "string") {
    throw new Error("DESKTOP_UPDATE_FAILURE_ACK_INVALID");
  }
  return { errorId: response.errorId, deviceId: response.deviceId, payloadSha256: response.payloadSha256 };
}
