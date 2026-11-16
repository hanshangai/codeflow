import type { SubmitFeedbackRequestBody, SubmitFeedbackResponseBody } from "@codeflowai/shared";

import { wsOriginToHttpOrigin, type ApiRequestContext } from "./request";

/** 公开反馈提交允许匿名；有账号会话时附带 Bearer。 */
export async function submitFeedback(ctx: ApiRequestContext, body: SubmitFeedbackRequestBody,
  authenticated = true): Promise<SubmitFeedbackResponseBody> {
  const response = await fetch(`${wsOriginToHttpOrigin(ctx.serverWsOrigin)}/api/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(authenticated && ctx.sessionToken ? { authorization: `Bearer ${ctx.sessionToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as {
    ok?: boolean; message?: string; ticketNo?: string; id?: string; details?: { requestId?: string };
  } | null;
  if (!response.ok || payload?.ok !== true || typeof payload.ticketNo !== "string" || typeof payload.id !== "string") {
    const requestId = payload?.details?.requestId ? `（请求 ${payload.details.requestId}）` : "";
    throw new Error(`${payload?.message || "反馈提交失败，请稍后重试"}${requestId}`);
  }
  return { ticketNo: payload.ticketNo, id: payload.id };
}
