import type { GetSkillSuitesResponseBody } from "@codeflowai/shared";

export const MCP_SUITES_CACHE_TTL_MS = 30_000;
export type McpSuitesCacheEntry = { response: GetSkillSuitesResponseBody; updatedAt: number };

/**
 * 模块级缓存：跨组件实例（tab 切换卸载/重挂）复用。
 * 若声明在 <script setup> 内会成为实例级 Map，每次切回 MCP tab 都会重新请求并出现加载态。
 */
export const mcpSuitesCache = new Map<string, McpSuitesCacheEntry>();

let pendingSearchQuery = "";

/** /mcp 命令把筛选参数带到 MCP 面板搜索框（一次性消费）。 */
export function setPendingMcpSearchQuery(query: string): void {
  pendingSearchQuery = String(query ?? "").trim();
}

export function consumePendingMcpSearchQuery(): string {
  const query = pendingSearchQuery;
  pendingSearchQuery = "";
  return query;
}
