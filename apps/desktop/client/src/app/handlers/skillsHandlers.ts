import { isDockerMcpCommand, type McpImportSource, type McpServerStatus, type SkillSuiteInfo, type WorkspaceId } from "@codeflowai/shared";

import {
  getCommunitySkillsStatus,
  installCommunitySkills,
  listInstalledCustomSkillSuites,
  normalizeSkillSuiteInfo,
  uninstallCommunitySkills,
} from "../../skills/communitySkillsInstaller.js";
import { configureMcpServer, enableMcpServer, getMcpServersStatus, installMcpServer, testMcpServer, unconfigureMcpServer, uninstallMcpServer, updateMcpServer } from "../../skills/mcpInstaller.js";
import { listRegisteredMcpServers } from "../../skills/mcpRegistry.js";
import { importMcpConfigurations } from "../../skills/mcpImporter.js";
import { SKILL_SUITES_REGISTRY } from "../../skills/skillsRegistry.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { logger } from "../../logger.js";

export async function handleSkillsInstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const targets = normalizeTargets((req.body as any)?.targets);
  const suite = resolveSkillSuite((req.body as any)?.suiteId, (req.body as any)?.suite);
  if (!workspaceId || !targets.length || !suite) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/targets/suiteId|suite" } });
    return;
  }

  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  for (const dep of suite.mcpDeps ?? []) {
    const depInstall = await installMcpServer(dep);
    if (!depInstall.success) {
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 500,
        body: { ok: false, message: `安装 ${suite.name} 前自动安装 MCP ${dep} 失败：${depInstall.error ?? "未知错误"}` },
      });
      return;
    }
  }

  const results = await installCommunitySkills({ suite, workspacePath, targets });
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    logger.error("skills", "社区技能安装失败", {
      event: { category: "skills", action: "skills.install", outcome: "fail" },
      requestId: req.id,
      workspaceId,
      suiteId: suite.suiteId,
      installType: suite.installType ?? "github",
      failedCount: failed.length,
      failedTargets: failed.map((item) => ({ targetId: item.targetId, message: item.message ?? null })),
    });
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, results } });
}

export async function handleSkillsUninstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const targets = normalizeTargets((req.body as any)?.targets);
  const suiteId = String((req.body as any)?.suiteId ?? "").trim();
  if (!workspaceId || !targets.length || !suiteId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/targets/suiteId" } });
    return;
  }

  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const suite = resolveSkillSuite(suiteId, null, workspacePath);
  if (!suite) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知技能套件：${suiteId}` } });
    return;
  }

  const results = await uninstallCommunitySkills({ suiteId, workspacePath, targets });
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    logger.error("skills", "社区技能卸载失败", {
      event: { category: "skills", action: "skills.uninstall", outcome: "fail" },
      requestId: req.id,
      workspaceId,
      suiteId,
      failedCount: failed.length,
      failedTargets: failed.map((item) => ({ targetId: item.targetId, message: item.message ?? null })),
    });
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, results } });
}

export async function handleSkillsSuites(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }

  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const suites = resolveSkillSuitesRegistry(workspacePath);
  const targetStatus = Object.fromEntries(
    suites.map((suite) => [suite.suiteId, getCommunitySkillsStatus(suite, workspacePath)]),
  );

  let mcpStatus: Record<string, McpServerStatus> | undefined;
  if (Boolean((req.body as any)?.includeMcpStatus)) {
    mcpStatus = await getMcpServersStatus(workspacePath, workspaceId);
  }

  ctx.send({
    t: "api.res",
    id: req.id,
    status: 200,
    body: { ok: true, suites, targetStatus, mcpServers: listRegisteredMcpServers(workspaceId), mcpStatus },
  });
}

export async function handleMcpInstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectUnsupportedDockerMcp(ctx, req)) return;
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim();
  const version = typeof (req.body as any)?.version === "string" ? String((req.body as any).version).trim() : null;
  if (!npmPackage) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：npmPackage" } });
    return;
  }

  const result = await installMcpServer(npmPackage, version, {
    mcpId: String((req.body as any)?.mcpId ?? "").trim() || null,
    workspaceScope: String((req.body as any)?.workspaceId ?? "").trim() || null,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
    name: String((req.body as any)?.name ?? "").trim() || null,
    description: String((req.body as any)?.description ?? "").trim() || null,
    homepage: String((req.body as any)?.homepage ?? "").trim() || null,
  });
  logMcpFailure(req, result.success ? 200 : 500, result.error, null);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: result.success ? 200 : 500,
    body: { ok: result.success, npmPackage, installedVersion: result.installedVersion, error: result.error },
  });
}

/** 处理 MCP 一键启用请求，先确认工作区再执行 Client 的四阶段流程。 */
export async function handleMcpEnable(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectUnsupportedDockerMcp(ctx, req)) return;
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  const engine = String((req.body as any)?.engine ?? "").trim();
  const hasInstallSource = Boolean(mcpId || npmPackage || String((req.body as any)?.command ?? "").trim() || String((req.body as any)?.url ?? "").trim() || String((req.body as any)?.pythonPackage ?? "").trim());
  if (!workspaceId || !hasInstallSource || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/npmPackage/engine" } });
    return;
  }
  if (!ctx.workspaces.get(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const result = await enableMcpServer(npmPackage, engine, typeof (req.body as any)?.version === "string" ? String((req.body as any).version).trim() : null, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: workspaceId,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
    name: String((req.body as any)?.name ?? "").trim() || null,
    description: String((req.body as any)?.description ?? "").trim() || null,
    homepage: String((req.body as any)?.homepage ?? "").trim() || null,
    installType: (req.body as any)?.installType,
    transportType: (req.body as any)?.transportType,
    command: String((req.body as any)?.command ?? "").trim() || null,
    args: Array.isArray((req.body as any)?.args) ? (req.body as any).args.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    url: String((req.body as any)?.url ?? "").trim() || null,
    pythonPackage: String((req.body as any)?.pythonPackage ?? "").trim() || null,
    runner: String((req.body as any)?.runner ?? "").trim() || null,
    credentialInputs: Array.isArray((req.body as any)?.credentialInputs) ? (req.body as any).credentialInputs : [],
  });
  logMcpFailure(req, result.ok ? 200 : 500, result.message, result.errorCode);
  ctx.send({ t: "api.res", id: req.id, status: result.ok ? 200 : 500, body: result });
}

/** 处理 MCP 更新请求，复用启用流程但在 Client 互斥记录中标记为更新。 */
export async function handleMcpUpdate(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectUnsupportedDockerMcp(ctx, req)) return;
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  const engine = String((req.body as any)?.engine ?? "").trim();
  const hasInstallSource = Boolean(mcpId || npmPackage || String((req.body as any)?.command ?? "").trim() || String((req.body as any)?.url ?? "").trim() || String((req.body as any)?.pythonPackage ?? "").trim());
  if (!workspaceId || !hasInstallSource || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/mcpId|npmPackage/engine" } });
    return;
  }
  if (!ctx.workspaces.get(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const result = await updateMcpServer(npmPackage, engine, typeof (req.body as any)?.version === "string" ? String((req.body as any).version).trim() : null, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: workspaceId,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
    name: String((req.body as any)?.name ?? "").trim() || null,
    description: String((req.body as any)?.description ?? "").trim() || null,
    homepage: String((req.body as any)?.homepage ?? "").trim() || null,
    installType: (req.body as any)?.installType,
    transportType: (req.body as any)?.transportType,
    command: String((req.body as any)?.command ?? "").trim() || null,
    args: Array.isArray((req.body as any)?.args) ? (req.body as any).args.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    url: String((req.body as any)?.url ?? "").trim() || null,
    pythonPackage: String((req.body as any)?.pythonPackage ?? "").trim() || null,
    runner: String((req.body as any)?.runner ?? "").trim() || null,
    credentialInputs: Array.isArray((req.body as any)?.credentialInputs) ? (req.body as any).credentialInputs : [],
  });
  logMcpFailure(req, result.ok ? 200 : 500, result.message, result.errorCode);
  ctx.send({ t: "api.res", id: req.id, status: result.ok ? 200 : 500, body: result });
}

/** 处理 MCP 配置检测请求，不启动 MCP 常驻进程。 */
export async function handleMcpTest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectUnsupportedDockerMcp(ctx, req)) return;
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  const engine = String((req.body as any)?.engine ?? "").trim();
  const hasInstallSource = Boolean(mcpId || npmPackage || String((req.body as any)?.command ?? "").trim() || String((req.body as any)?.url ?? "").trim() || String((req.body as any)?.pythonPackage ?? "").trim());
  if (!workspaceId || !hasInstallSource || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/mcpId|npmPackage/engine" } });
    return;
  }
  if (!ctx.workspaces.get(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const result = await testMcpServer(npmPackage, engine, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: workspaceId,
    workspacePath: ctx.workspaces.get(workspaceId) ?? null,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
    name: String((req.body as any)?.name ?? "").trim() || null,
    description: String((req.body as any)?.description ?? "").trim() || null,
    homepage: String((req.body as any)?.homepage ?? "").trim() || null,
  });
  logMcpFailure(req, result.ok ? 200 : 502, result.message, result.errorCode);
  ctx.send({ t: "api.res", id: req.id, status: result.ok ? 200 : 502, body: result });
}

/** 处理 MCP 配置导入，仅返回脱敏定义和逐来源错误。 */
export async function handleMcpImport(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId || !ctx.workspaces.get(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：有效 workspaceId" } });
    return;
  }
  const rawSources = Array.isArray((req.body as any)?.sources) ? (req.body as any).sources : ["claude", "codex", "vscode", "cursor"];
  const sources = rawSources.filter((item: unknown): item is McpImportSource => item === "claude" || item === "codex" || item === "vscode" || item === "cursor");
  if (!sources.length) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "没有可导入的配置来源" } });
    return;
  }
  const result = await importMcpConfigurations(ctx.workspaces.get(workspaceId) ?? undefined, sources, workspaceId);
  if (result.errors.length) {
    logger.warn("mcp", "MCP 配置导入部分失败", {
      event: { category: "mcp", action: "mcp.import", outcome: "partial" },
      requestId: req.id,
      workspaceId,
      failedCount: result.errors.length,
      importedCount: result.items.length,
    });
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, ...result } });
}

export async function handleMcpUninstall(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  if (!npmPackage && !mcpId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：npmPackage/mcpId" } });
    return;
  }

  const result = await uninstallMcpServer(npmPackage, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: String((req.body as any)?.workspaceId ?? "").trim() || null,
    workspacePath: ctx.workspaces.get(String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId) ?? null,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
  });
  logMcpFailure(req, result.success ? 200 : 500, result.error, null);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: result.success ? 200 : 500,
    body: { ok: result.success, npmPackage, error: result.error, errorCode: result.errorCode ?? null },
  });
}

export async function handleMcpConfigure(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  if (rejectUnsupportedDockerMcp(ctx, req)) return;
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  const engine = String((req.body as any)?.engine ?? "").trim();
  if ((!npmPackage && !mcpId) || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：npmPackage/engine" } });
    return;
  }

  const result = await configureMcpServer(npmPackage, engine, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: String((req.body as any)?.workspaceId ?? "").trim() || null,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
    name: String((req.body as any)?.name ?? "").trim() || null,
    description: String((req.body as any)?.description ?? "").trim() || null,
    homepage: String((req.body as any)?.homepage ?? "").trim() || null,
    installType: (req.body as any)?.installType,
    transportType: (req.body as any)?.transportType,
    command: String((req.body as any)?.command ?? "").trim() || null,
    args: Array.isArray((req.body as any)?.args) ? (req.body as any).args.map((item: unknown) => String(item ?? "").trim()).filter(Boolean) : [],
    url: String((req.body as any)?.url ?? "").trim() || null,
    pythonPackage: String((req.body as any)?.pythonPackage ?? "").trim() || null,
    runner: String((req.body as any)?.runner ?? "").trim() || null,
    credentialInputs: Array.isArray((req.body as any)?.credentialInputs) ? (req.body as any).credentialInputs : [],
  });
  logMcpFailure(req, result.success ? 200 : 500, result.error, null);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: result.success ? 200 : 500,
    body: { ok: result.success, npmPackage, engine, error: result.error },
  });
}

export async function handleMcpUnconfigure(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const npmPackage = String((req.body as any)?.npmPackage ?? "").trim() || null;
  const mcpId = String((req.body as any)?.mcpId ?? "").trim() || null;
  const engine = String((req.body as any)?.engine ?? "").trim();
  if ((!npmPackage && !mcpId) || (engine !== "claude" && engine !== "codex")) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：npmPackage/engine" } });
    return;
  }

  const result = await unconfigureMcpServer(npmPackage, engine, {
    mcpId,
    instanceId: String((req.body as any)?.instanceId ?? "").trim() || null,
    workspaceScope: String((req.body as any)?.workspaceId ?? "").trim() || null,
    serverName: String((req.body as any)?.serverName ?? "").trim() || null,
  });
  logMcpFailure(req, result.success ? 200 : 500, result.error, null);
  ctx.send({
    t: "api.res",
    id: req.id,
    status: result.success ? 200 : 500,
    body: { ok: result.success, npmPackage, engine, error: result.error },
  });
}

function normalizeTargets(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const it of arr) {
    const s = String(it ?? "").trim();
    if (s) out.push(s);
  }
  return Array.from(new Set(out));
}

/** 在 Client MCP 边界记录可检索失败上下文，严格排除凭据值和完整命令。 */
function logMcpFailure(req: ApiRequestMessage, status: number, message: string | null, errorCode: string | null): void {
  if (status < 400) return;
  const body = req.body as Record<string, unknown> | undefined;
  logger.error("mcp", "MCP 操作失败", {
    event: { category: "mcp", action: req.method, outcome: "fail" },
    requestId: req.id,
    method: req.method,
    workspaceId: String(body?.workspaceId ?? "").trim() || null,
    mcpId: String(body?.mcpId ?? "").trim() || null,
    instanceId: String(body?.instanceId ?? "").trim() || null,
    engine: String(body?.engine ?? "").trim() || null,
    errorCode: errorCode || "MCP_OPERATION_FAILED",
    rootCause: String(message ?? "MCP 操作失败").slice(0, 1_000),
  });
}

/** 在 Client API 边界拒绝 Docker 配置，保持与 Server 的不支持语义一致。 */
function rejectUnsupportedDockerMcp(ctx: ApiHandlerContext, req: ApiRequestMessage): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  const installType = String(body?.installType ?? "").trim().toLowerCase();
  const command = String(body?.command ?? "").trim().toLowerCase();
  if (installType !== "docker" && !isDockerMcpCommand(command)) return false;
  logMcpFailure(req, 400, "当前版本不支持 Docker 类型 MCP", "MCP_UNSUPPORTED_INSTALL_TYPE");
  ctx.send({
    t: "api.res",
    id: req.id,
    status: 400,
    body: { ok: false, code: "MCP_UNSUPPORTED_INSTALL_TYPE", message: "当前版本不支持 Docker 类型 MCP" },
  });
  return true;
}

/** 合并内置与当前工作区自定义套件，供市场列表统一展示。 */
function resolveSkillSuitesRegistry(workspacePath: string): SkillSuiteInfo[] {
  const merged = new Map<string, SkillSuiteInfo>();
  for (const suite of SKILL_SUITES_REGISTRY) {
    merged.set(suite.suiteId, { ...suite, source: "builtin" });
  }
  for (const suite of listInstalledCustomSkillSuites(workspacePath)) {
    if (merged.has(suite.suiteId)) continue;
    merged.set(suite.suiteId, suite);
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

/** 解析当前请求命中的 Skills 套件，兼容预置套件与自定义接入。 */
function resolveSkillSuite(suiteIdRaw: unknown, suiteRaw: unknown, workspacePath?: string): SkillSuiteInfo | null {
  const suiteId = String(suiteIdRaw ?? "").trim();
  if (suiteRaw) {
    const normalized = normalizeSkillSuiteInfo(suiteRaw as Partial<SkillSuiteInfo>);
    if (normalized) return normalized;
  }
  if (!suiteId) return null;
  const registry = workspacePath ? resolveSkillSuitesRegistry(workspacePath) : SKILL_SUITES_REGISTRY;
  return registry.find((item) => item.suiteId === suiteId) ?? null;
}

