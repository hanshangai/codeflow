import type { DesktopCrashReport, DesktopCrashReportAck } from "@codeflowai/shared/desktop-crash-report";
import type { CrashReportJournal } from "./crashReportJournal.js";

type CrashTransport = {
  register(options?: { signal?: AbortSignal }): Promise<unknown>;
  requestJson(input: { method: "POST"; path: string; body: DesktopCrashReport; requestId: string; signal?: AbortSignal }): Promise<unknown>;
};

/** 仅补报当前设备待报证据；签名请求 ID 复用报告 ID，原设备上下文留在正文。 */
export async function deliverDesktopCrashReports(input: {
  journal: CrashReportJournal;
  deviceId: string;
  transport: CrashTransport;
  signal?: AbortSignal;
}): Promise<void> {
  const pending = input.journal.pending(input.deviceId);
  if (!pending.length) return;
  let reportId = pending[0]!.reportId;
  try {
    await input.transport.register({ signal: input.signal });
    await input.journal.flush(input.deviceId, async report => {
      reportId = report.reportId;
      const response = await input.transport.requestJson({
        method: "POST", path: "/api/software/desktop/crash-reports", body: report, requestId: report.reportId, signal: input.signal,
      });
      return extractCrashAck(response);
    });
  } catch (error) {
    throw withCrashDeliveryContext(error, reportId);
  }
}

/** 发送边界补齐报告 ID，避免主进程丢失失败条目上下文。 */
function withCrashDeliveryContext(error: unknown, reportId: string): Error & { code: string; requestId: string } {
  const message = error instanceof Error ? error.message : "DESKTOP_CRASH_DELIVERY_FAILED";
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : message.startsWith("DESKTOP_CRASH_ACK") || message.startsWith("DESKTOP_CRASH_REPORT_ACK") ? "DESKTOP_CRASH_ACK_INVALID" : "DESKTOP_CRASH_DELIVERY_FAILED";
  return Object.assign(new Error(message, { cause: error }), { code, requestId: reportId });
}

/** 严格解析确认 envelope，拒绝 ok 以外的未知字段。 */
function extractCrashAck(value: unknown): DesktopCrashReportAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("DESKTOP_CRASH_ACK_INVALID");
  const response = value as Record<string, unknown>;
  const fields = ["ok", "reportId", "deviceId", "payloadSha256"];
  if (Object.keys(response).length !== fields.length || fields.some(field => !Object.hasOwn(response, field)) || response.ok !== true
    || typeof response.reportId !== "string" || typeof response.deviceId !== "string" || typeof response.payloadSha256 !== "string") {
    throw new Error("DESKTOP_CRASH_ACK_INVALID");
  }
  return { reportId: response.reportId, deviceId: response.deviceId, payloadSha256: response.payloadSha256 };
}
