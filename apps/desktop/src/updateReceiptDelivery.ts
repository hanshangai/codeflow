import type { DesktopUpdateReceiptAck } from "@codeflowai/shared/desktop-update-receipt";
import type { createUpdateReceiptJournal } from "./updateReceiptJournal.js";

type ReceiptTransport = { register(options?: { signal?: AbortSignal; requestId?: string }): Promise<unknown>; requestJson(input: { method: "POST"; path: string; body: unknown; requestId: string; signal?: AbortSignal }): Promise<unknown> };

/** 复用设备传输串行补报阶段回执；无待报时不联网，失败保留本地证据。 */
export function createUpdateReceiptDelivery(input: { journal: ReturnType<typeof createUpdateReceiptJournal>; deviceId: string; transport: ReceiptTransport; signal?: AbortSignal }) {
  return {
    /** 登记失败绑定首条待报身份；登记成功后逐条发送并校验精确确认。 */
    async flush(): Promise<void> {
      const [first] = await input.journal.pending(input.deviceId);
      if (!first) return;
      try { await input.transport.register({ signal: input.signal }); }
      catch (cause) {
        const code = "DESKTOP_UPDATE_RECEIPT_SEND_FAILED";
        throw Object.assign(new Error(cause instanceof Error ? cause.message : code, { cause }), { code, requestId: first.requestId });
      }
      await input.journal.flush(input.deviceId, async receipt => {
        const response = await input.transport.requestJson({ method: "POST", path: "/api/software/desktop/update-receipts", body: receipt, requestId: receipt.requestId, signal: input.signal });
        return extractAck(response);
      });
    },
  };
}

/** 提取统一 API 的 ok 包装，明确丢弃协议元字段后再交 Journal 精确核对。 */
function extractAck(value: unknown): DesktopUpdateReceiptAck {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).ok !== true) {
    throw new Error("DESKTOP_UPDATE_RECEIPT_ACK_INVALID");
  }
  const response = value as Record<string, unknown>;
  const fields = ["ok", "deviceId", "requestId", "releaseId", "archiveSha256", "stage", "at", "payloadSha256"];
  if (Object.keys(response).length !== fields.length || Object.keys(response).some(field => !fields.includes(field))) {
    throw new Error("DESKTOP_UPDATE_RECEIPT_ACK_INVALID");
  }
  return {
    deviceId: response.deviceId as string, requestId: response.requestId as string, releaseId: response.releaseId as string,
    archiveSha256: response.archiveSha256 as string, stage: response.stage as DesktopUpdateReceiptAck["stage"],
    at: response.at as string, payloadSha256: response.payloadSha256 as string,
  };
}
