import type {
  GetSkillSuitesResponseBody,
  McpEnableRequestBody,
  McpEnableResponseBody,
  InstallSkillsRequestBody,
  McpConfigureRequestBody,
  McpInstallRequestBody,
  McpInstallResponseBody,
  McpImportRequestBody,
  McpImportResponseBody,
  McpTestRequestBody,
  McpTestResponseBody,
  McpUpdateRequestBody,
  McpUnconfigureRequestBody,
  McpUninstallRequestBody,
  McpUninstallResponseBody,
  SkillsOperateResponseBody,
  UninstallSkillsRequestBody,
  WorkspaceId,
} from "@codeflowai/shared";

import { requestJson, type ApiRequestContext } from "../request";

function withWorkspaceQuery(path: string, workspaceId?: WorkspaceId | null): string {
  const wid = String(workspaceId ?? "").trim();
  if (!wid) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}workspaceId=${encodeURIComponent(wid)}`;
}

function withSkillsSuitesQuery(workspaceId?: WorkspaceId | null, opts?: { includeMcpStatus?: boolean }): string {
  const params = new URLSearchParams();
  const wid = String(workspaceId ?? "").trim();
  if (wid) {
    params.set("workspaceId", wid);
  }
  if (opts?.includeMcpStatus) {
    params.set("includeMcpStatus", "true");
  }
  const query = params.toString();
  return query ? `/api/skills/suites?${query}` : "/api/skills/suites";
}

/** 查询社区技能套件列表（含各 target 安装状态）。 */
export function getSkillSuites(ctx: ApiRequestContext, workspaceId?: WorkspaceId | null, opts?: { includeMcpStatus?: boolean }) {
  return requestJson<GetSkillSuitesResponseBody>(ctx, { method: "GET", path: withSkillsSuitesQuery(workspaceId, opts) });
}

/** 安装社区技能套件（按 targets）。 */
export function installSkills(ctx: ApiRequestContext, body: InstallSkillsRequestBody) {
  return requestJson<SkillsOperateResponseBody>(ctx, { method: "POST", path: "/api/skills/install", body });
}

/** 卸载社区技能套件（按 targets）。 */
export function uninstallSkills(ctx: ApiRequestContext, body: UninstallSkillsRequestBody) {
  return requestJson<SkillsOperateResponseBody>(ctx, { method: "POST", path: "/api/skills/uninstall", body });
}

/** 安装 MCP Server（全局 npm）。 */
export function installMcpServer(ctx: ApiRequestContext, body: McpInstallRequestBody) {
  return requestJson<McpInstallResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/install", body.workspaceId),
    body,
  });
}

/** 一键完成 MCP 安装、引擎配置和配置检测。 */
export function enableMcpServer(ctx: ApiRequestContext, body: McpEnableRequestBody) {
  return requestJson<McpEnableResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/enable", body.workspaceId),
    body,
  });
}

/** 更新 MCP 本地依赖并重新接入目标引擎。 */
export function updateMcpServer(ctx: ApiRequestContext, body: McpUpdateRequestBody) {
  return requestJson<McpEnableResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/update", body.workspaceId),
    body,
  });
}

/** 检测目标引擎是否保存了 MCP 配置。 */
export function testMcpServer(ctx: ApiRequestContext, body: McpTestRequestBody) {
  return requestJson<McpTestResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/test", body.workspaceId),
    body,
  });
}

/** 从当前工作区 Client 导入 Claude、Codex、VS Code、Cursor MCP 定义。 */
export function importMcpServers(ctx: ApiRequestContext, body: McpImportRequestBody) {
  return requestJson<McpImportResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/import", body.workspaceId),
    body,
  });
}

/** 卸载 MCP Server（全局 npm）。 */
export function uninstallMcpServer(ctx: ApiRequestContext, body: McpUninstallRequestBody) {
  return requestJson<McpUninstallResponseBody>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/uninstall", body.workspaceId),
    body,
  });
}

/** 将 MCP Server 配置到指定引擎（不做 npm 安装）。 */
export function configureMcpServer(ctx: ApiRequestContext, body: McpConfigureRequestBody) {
  return requestJson<{ ok: boolean; npmPackage: string; engine: string; error?: string | null }>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/configure", body.workspaceId),
    body,
  });
}

/** 从指定引擎移除 MCP Server 配置。 */
export function unconfigureMcpServer(ctx: ApiRequestContext, body: McpUnconfigureRequestBody) {
  return requestJson<{ ok: boolean; npmPackage: string; engine: string; error?: string | null }>(ctx, {
    method: "POST",
    path: withWorkspaceQuery("/api/mcp/unconfigure", body.workspaceId),
    body,
  });
}

