import type { ApiResult, RespondApprovalRequestBody, RespondUserInputRequestBody } from "@codeflowai/shared";

import type { ApiRequestContext } from "../request";
import { requestJson } from "../request";

/** 响应 approval 请求。 */
export function respondApproval(ctx: ApiRequestContext, body: RespondApprovalRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/approvals/respond", body, requireWebSession: true });
}

/** 响应 userInput 请求。 */
export function respondUserInput(ctx: ApiRequestContext, body: RespondUserInputRequestBody): Promise<ApiResult<{}>> {
  return requestJson<{}>(ctx, { method: "POST", path: "/api/user-input/respond", body, requireWebSession: true });
}


