import { normalizeKnowledgeCategoryNode, type ApiResult, type KnowledgeAssetAction, type KnowledgeAssetResponses, type KnowledgeAssetNode, type KnowledgeAssetTree } from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

export type KnowledgeAssetInput<A extends KnowledgeAssetAction> = { workspaceId: string } & Record<string, unknown>;
export type KnowledgeAssetResult<A extends KnowledgeAssetAction> = ApiResult<{ data: KnowledgeAssetResponses[A] }>;

/** 读取或维护知识，旧 Client 的分类名只在响应中统一，保留服务端冲突指纹。 */
export async function requestKnowledgeAsset<A extends KnowledgeAssetAction>(
  ctx: ApiRequestContext,
  action: A,
  input: KnowledgeAssetInput<A>,
  options: { method?: "GET" | "POST"; signal?: AbortSignal } = {},
): Promise<KnowledgeAssetResult<A>> {
  const method = options.method ?? "GET";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    // GET 的可选 null 表示“不限定范围”；不能序列化成字符串 "null" 交给 Client 当作节点 ID。
    if (value === undefined || (method === "GET" && value === null)) continue;
    if (Array.isArray(value) || (value && typeof value === "object")) params.set(key, JSON.stringify(value));
    else params.set(key, String(value));
  }
  const result = await requestJson<{ data: KnowledgeAssetResponses[A] }>(ctx, {
    method,
    path: method === "GET" ? buildQueryPath(`/api/knowledge/assets/${encodeURIComponent(action)}`, params) : `/api/knowledge/assets/${encodeURIComponent(action)}`,
    body: method === "POST" ? input : undefined,
    signal: options.signal,
  });
  return result.ok ? { ...result, data: normalizeCategoryNames(result.data) } : result;
}

/** 只投影协议中的节点和树，任务快照与更新状态沿用同一分类名称。 */
function normalizeCategoryNames<T>(value: T): T {
  if (Array.isArray(value)) return value.map(normalizeCategoryNames) as T;
  if (!value || typeof value !== "object") return value;
  const data = value as Record<string, unknown>, result = { ...data };
  for (const key of ["tree", "baseTree", "proposedTree"]) {
    const tree = data[key] as KnowledgeAssetTree | null | undefined;
    if (tree) result[key] = { ...tree, nodes: tree.nodes.map(normalizeKnowledgeCategoryNode) };
  }
  if (data.node) result.node = normalizeKnowledgeCategoryNode(data.node as KnowledgeAssetNode);
  if (data.run) result.run = normalizeCategoryNames(data.run);
  return result as T;
}

/** 构造项目知识 GET 地址，并忽略未提供的可选筛选项。 */
function buildQueryPath(basePath: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}
