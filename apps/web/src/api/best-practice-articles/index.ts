import type { ApiResult, PublicBestPracticeArticleDetailResponseBody, PublicBestPracticeArticleListResponseBody } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

export type PublicBestPracticeArticleListInput = {
  offset: number;
  limit: number;
  signal?: AbortSignal;
};

/** 读取已发布的最佳实践文章摘要列表。 */
export function getPublicBestPracticeArticles(
  ctx: ApiRequestContext,
  input: PublicBestPracticeArticleListInput,
): Promise<ApiResult<PublicBestPracticeArticleListResponseBody>> {
  const params = new URLSearchParams({
    offset: String(input.offset),
    limit: String(input.limit),
  });
  return requestJson(ctx, {
    method: "GET",
    path: `/api/public/best-practice-articles?${params.toString()}`,
    signal: input.signal,
  });
}

/** 按 slug 读取一篇已发布的最佳实践文章正文。 */
export function getPublicBestPracticeArticle(
  ctx: ApiRequestContext,
  slug: string,
  signal?: AbortSignal,
): Promise<ApiResult<PublicBestPracticeArticleDetailResponseBody>> {
  return requestJson(ctx, {
    method: "GET",
    path: `/api/public/best-practice-articles/${encodeURIComponent(slug)}`,
    signal,
  });
}
