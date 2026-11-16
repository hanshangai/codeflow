import type { DesktopApiResponse } from "@codeflowai/shared";
import type { SqliteDb } from "../../db/sqliteTypes.js";
import { LocalQuickPhraseError, LocalQuickPhraseRepo } from "../../db/repos/localQuickPhraseRepo.js";

/** 本机常用提示词复用原 API 信封；未知异常由统一桌面边界记录和失败。 */
export function executeLocalQuickPhraseRequest(applicationDb: SqliteDb, method: string, body: unknown): DesktopApiResponse {
  try {
    if (body !== undefined && (!body || typeof body !== "object" || Array.isArray(body))) throw new LocalQuickPhraseError(400, "常用提示词请求参数无效");
    const input = (body ?? {}) as Record<string, unknown>;
    const repo = new LocalQuickPhraseRepo(applicationDb);
    const collection = method === "quickPhrases.list" ? repo.list()
      : method === "quickPhrases.create" ? repo.create(input)
      : method === "quickPhrases.update" ? repo.update(input)
      : method === "quickPhrases.delete" ? repo.delete(input)
      : method === "quickPhrases.reorder" ? repo.reorder(input)
      : undefined;
    if (!collection) throw new LocalQuickPhraseError(400, "不支持的本机常用提示词方法");
    return { status: 200, body: { ok: true, ...collection } };
  } catch (error) {
    if (!(error instanceof LocalQuickPhraseError)) throw error;
    return { status: error.status, body: { ok: false, code: error.status === 409 ? "CONFLICT" : "BAD_REQUEST", message: error.message } };
  }
}
