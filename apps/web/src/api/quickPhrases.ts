import type { CreateQuickPhraseRequest, DeleteQuickPhraseRequest, QuickPhraseCollection, ReorderQuickPhrasesRequest, UpdateQuickPhraseRequest } from "@codeflowai/shared";
import { createApiResultError, requestJson, type ApiRequestContext } from "./request";
import { requestDesktopApi } from "../services/desktop";

export type QuickPhraseRequestContext = ApiRequestContext & { scope?: "local" | "account" };

/** 仅显式本机范围走桌面桥，失败不回落账号 Server。 */
async function call(ctx: QuickPhraseRequestContext, method: "GET" | "POST" | "PUT" | "DELETE", path: string, action: "list" | "create" | "update" | "delete" | "reorder", body?: Record<string, unknown>): Promise<QuickPhraseCollection> {
  const result = ctx.scope === "local"
    ? await requestDesktopApi<QuickPhraseCollection>({ method: `quickPhrases.${action}`, body })
    : await requestJson<QuickPhraseCollection>(ctx, { method, path, body: body && "id" in body ? Object.fromEntries(Object.entries(body).filter(([key]) => key !== "id")) : body });
  if (!result.ok) throw createApiResultError(result);
  return result;
}

/** 读取所选范围完整集合。 */
export const listQuickPhrases = (ctx: QuickPhraseRequestContext) => call(ctx, "GET", "/api/account/me/quick-phrases", "list");
/** 在所选范围幂等创建。 */
export const createQuickPhrase = (ctx: QuickPhraseRequestContext, body: CreateQuickPhraseRequest) => call(ctx, "POST", "/api/account/me/quick-phrases", "create", body);
/** 在所选范围执行版本校验更新。 */
export const updateQuickPhrase = (ctx: QuickPhraseRequestContext, id: string, body: UpdateQuickPhraseRequest) => call(ctx, "PUT", `/api/account/me/quick-phrases/${encodeURIComponent(id)}`, "update", { ...body, id });
/** 在所选范围执行版本校验删除。 */
export const deleteQuickPhrase = (ctx: QuickPhraseRequestContext, id: string, body: DeleteQuickPhraseRequest) => call(ctx, "DELETE", `/api/account/me/quick-phrases/${encodeURIComponent(id)}`, "delete", { ...body, id });
/** 在所选范围提交完整排序。 */
export const reorderQuickPhrases = (ctx: QuickPhraseRequestContext, body: ReorderQuickPhrasesRequest) => call(ctx, "PUT", "/api/account/me/quick-phrases/order", "reorder", body);
