import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { McpInstallType, McpServerInfo, McpTransportType } from "@codeflowai/shared";
import { isDockerMcpCommand, MCP_SERVERS_REGISTRY as SHARED_MCP_SERVERS_REGISTRY } from "@codeflowai/shared";

const CUSTOM_MCP_REGISTRY_PATH = join(homedir(), ".codeflowai", "custom-mcp-servers.json");
let customRegistryWriteTail = Promise.resolve();

type CustomMcpRegistryFile = {
  servers: McpServerInfo[];
};

export const MCP_SERVERS_REGISTRY = SHARED_MCP_SERVERS_REGISTRY;

/** 生成当前 MCP 的稳定默认实例身份，后续不同配置可在此基础上扩展 scope。 */
export function buildMcpInstanceId(mcpId: string, scope = "default"): string {
  const normalizedMcpId = String(mcpId ?? "").trim();
  const normalizedScope = String(scope ?? "").trim() || "default";
  if (!normalizedMcpId) throw new Error("mcpId 不能为空");
  return `${normalizedMcpId}::${normalizedScope}`;
}

/** 判断 npm 包是否属于内置 MCP 注册表。 */
export function isBuiltinMcpPackage(npmPackage: string): boolean {
  return SHARED_MCP_SERVERS_REGISTRY.some((server) => server.npmPackage === npmPackage);
}

/** 读取当前机器上保存的自定义 MCP 注册表。 */
export function listCustomMcpServers(workspaceScope?: string | null): McpServerInfo[] {
  try {
    if (!fs.existsSync(CUSTOM_MCP_REGISTRY_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(CUSTOM_MCP_REGISTRY_PATH, "utf8")) as Partial<CustomMcpRegistryFile>;
    const servers = Array.isArray(raw.servers) ? raw.servers : [];
    const scope = String(workspaceScope ?? "").trim();
    const normalized = servers.map((server) => {
      const entry = normalizeMcpServerInfo(server, server.source === "imported" ? "imported" : "custom");
      if (!entry) throw new Error("MCP 注册表包含无效条目");
      return entry;
    });
    return selectCustomMcpServersForWorkspace(normalized, scope || null);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new Error(`读取 MCP 注册表失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 合并内置与自定义 MCP 条目，供市场列表与状态探测复用。 */
export function listRegisteredMcpServers(workspaceScope?: string | null): McpServerInfo[] {
  const merged = new Map<string, McpServerInfo>();
  for (const server of SHARED_MCP_SERVERS_REGISTRY) {
    merged.set(server.mcpId, { ...server, source: "builtin" });
  }
  for (const server of listCustomMcpServers(workspaceScope)) {
    if (merged.has(server.mcpId)) continue;
    merged.set(server.mcpId, server);
  }
  return [...merged.values()];
}

/** 按 npm 包查找 MCP 注册信息，优先返回内置条目。 */
export function findMcpServerByPackage(npmPackage: string, workspaceScope?: string | null): McpServerInfo | null {
  return listRegisteredMcpServers(workspaceScope).find((server) => server.npmPackage === npmPackage) ?? null;
}

/** 按稳定目录身份查找 MCP，避免新接口继续把 npm 包名当作主键。 */
export function findMcpServerById(mcpId: string, workspaceScope?: string | null): McpServerInfo | null {
  return listRegisteredMcpServers(workspaceScope).find((server) => server.mcpId === mcpId) ?? null;
}

/** 写入或更新一条自定义 MCP 注册信息。 */
export async function upsertCustomMcpServer(server: McpServerInfo): Promise<void> {
  await upsertCustomMcpServers([server]);
}

/** 批量原子写入自定义 MCP，避免导入中途失败留下部分注册条目。 */
export async function upsertCustomMcpServers(servers: McpServerInfo[]): Promise<void> {
  const previous = customRegistryWriteTail;
  let release!: () => void;
  customRegistryWriteTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const normalizedByKey = new Map<string, McpServerInfo>();
    for (const server of servers) {
      const entry = normalizeMcpServerInfo(server, server.source === "imported" ? "imported" : "custom");
      if (!entry) throw new Error("自定义 MCP 信息不完整：npmPackage/serverName/name");
      normalizedByKey.set(buildMcpRegistryEntryKey(entry), entry);
    }
    const normalized = [...normalizedByKey.values()];
    if (!normalized.length) return;

    const replacingKeys = new Set(normalized.map((server) => buildMcpRegistryEntryKey(server)));
    const current = listCustomMcpServers().filter((item) => !replacingKeys.has(buildMcpRegistryEntryKey(item)));
    const next: CustomMcpRegistryFile = {
      servers: [...current, ...normalized].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    };
    await mkdir(dirname(CUSTOM_MCP_REGISTRY_PATH), { recursive: true });
    const tempPath = `${CUSTOM_MCP_REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tempPath, CUSTOM_MCP_REGISTRY_PATH);
  } finally {
    release();
  }
}

/** 删除一条自定义 MCP 注册信息。 */
export async function removeCustomMcpServer(server: Pick<McpServerInfo, "mcpId" | "workspaceScope">): Promise<void> {
  await removeCustomMcpServers([server]);
}

/** 批量原子删除自定义 MCP，按 mcpId + workspaceScope 定位条目。 */
export async function removeCustomMcpServers(servers: Array<Pick<McpServerInfo, "mcpId" | "workspaceScope">>): Promise<void> {
  const removingKeys = new Set(servers.map((server) => buildMcpRegistryEntryKey(server)));
  if (!removingKeys.size) return;
  const previous = customRegistryWriteTail;
  let release!: () => void;
  customRegistryWriteTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const remaining = listCustomMcpServers().filter((item) => !removingKeys.has(buildMcpRegistryEntryKey(item)));
    const next: CustomMcpRegistryFile = { servers: remaining.sort((left, right) => left.name.localeCompare(right.name, "zh-CN")) };
    await mkdir(dirname(CUSTOM_MCP_REGISTRY_PATH), { recursive: true });
    const tempPath = `${CUSTOM_MCP_REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
    await rename(tempPath, CUSTOM_MCP_REGISTRY_PATH);
  } finally {
    release();
  }
}

/** 生成注册表的持久化唯一键，工作区作用域相同才视为同一自定义 MCP。 */
export function buildMcpRegistryEntryKey(server: Pick<McpServerInfo, "mcpId" | "workspaceScope">): string {
  const mcpId = String(server.mcpId ?? "").trim();
  const workspaceScope = String(server.workspaceScope ?? "").trim();
  if (!mcpId) {
    throw new Error("MCP 注册表条目缺少 mcpId");
  }
  return `${mcpId}\u0000${workspaceScope}`;
}

/** 返回当前工作区可见的自定义 MCP；同名工作区条目覆盖旧的全局条目。 */
export function selectCustomMcpServersForWorkspace(servers: McpServerInfo[], workspaceScope?: string | null): McpServerInfo[] {
  const scope = String(workspaceScope ?? "").trim();
  if (!scope) return servers;
  const scoped = servers.filter((server) => server.workspaceScope === scope);
  const scopedIds = new Set(scoped.map((server) => server.mcpId));
  return [
    ...servers.filter((server) => !server.workspaceScope && !scopedIds.has(server.mcpId)),
    ...scoped,
  ];
}

/** 规整 MCP 条目，避免把空值写进本地注册表。 */
export function normalizeMcpServerInfo(
  input: Partial<McpServerInfo> | null | undefined,
  source: "builtin" | "custom" | "imported",
): McpServerInfo | null {
  const npmPackage = String(input?.npmPackage ?? "").trim() || null;
  const serverName = String(input?.serverName ?? "").trim();
  const name = String(input?.name ?? "").trim();
  const command = String(input?.command ?? "").trim() || null;
  const url = String(input?.url ?? "").trim() || null;
  const pythonPackage = String(input?.pythonPackage ?? "").trim() || null;
  const runner = String(input?.runner ?? "").trim() || null;
  const args = Array.isArray(input?.args) ? input.args.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  if (String((input as Record<string, unknown> | null | undefined)?.installType ?? "").trim().toLowerCase() === "docker" || isDockerMcpCommand(command)) return null;
  if (containsMcpCredentialText(command) || containsMcpCredentialArgs(args)) return null;
  if (url && containsMcpCredentialUrl(url)) return null;
  if (!name) return null;
  const installType = normalizeInstallType(input?.installType);
  const transportType = normalizeTransportType(input?.transportType);
  if ((input?.installType !== undefined && installType === null) || (input?.transportType !== undefined && transportType === null)) return null;
  const resolvedInstallType = installType ?? (npmPackage ? "npm" : command ? "local-command" : url ? "http" : pythonPackage ? "pypi" : "imported");
  const resolvedTransportType = transportType ?? (resolvedInstallType === "http" ? "streamable-http" : resolvedInstallType === "sse" ? "sse" : "stdio");
  if (resolvedInstallType === "npm" && (!npmPackage || !serverName)) return null;
  if (resolvedInstallType === "local-command" && (!command || !serverName)) return null;
  if ((resolvedInstallType === "http" || resolvedInstallType === "sse") && !url) return null;
  if (resolvedInstallType === "pypi" && (!pythonPackage || !runner || !serverName)) return null;
  if (resolvedInstallType === "imported" && !serverName && !url && !command && !npmPackage && !pythonPackage) return null;
  const mcpId = String(input?.mcpId ?? "").trim() || `${source}.${buildMcpIdentitySlug(npmPackage ?? url ?? command ?? pythonPackage ?? name)}`;
  return {
    mcpId,
    npmPackage,
    serverName: serverName || null,
    name,
    description: String(input?.description ?? "").trim(),
    homepage: String(input?.homepage ?? "").trim() || null,
    source,
    workspaceScope: String(input?.workspaceScope ?? "").trim() || null,
    installType: resolvedInstallType,
    transportType: resolvedTransportType,
    installSpecSummary: String(input?.installSpecSummary ?? "").trim() || (npmPackage ? `npm 包：${npmPackage}` : url ? `远程地址：${url}` : command ? `本地命令：${command}` : pythonPackage ? `PyPI 包：${pythonPackage}` : "导入配置"),
    prerequisites: Array.isArray(input?.prerequisites)
      ? input.prerequisites.map((item) => String(item ?? "").trim()).filter(Boolean)
      : ["当前 Client 可运行 Node.js 和 npm"],
    securityLevel: input?.securityLevel === "low" || input?.securityLevel === "high" ? input.securityLevel : "medium",
    recommended: Boolean(input?.recommended),
    recommendedRank: typeof input?.recommendedRank === "number" ? input.recommendedRank : null,
    categories: Array.isArray(input?.categories)
      ? input.categories.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [],
    command,
    args,
    url,
    pythonPackage,
    runner,
  };
}

function normalizeInstallType(value: unknown): McpInstallType | null {
  return value === "local-command" || value === "http" || value === "sse" || value === "npm" || value === "pypi" || value === "imported"
    ? value
    : null;
}

function normalizeTransportType(value: unknown): McpTransportType | null {
  return value === "stdio" || value === "streamable-http" || value === "sse" ? value : null;
}

function buildMcpIdentitySlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/** 拒绝把明显的命令行凭据写入本地 MCP 注册表，要求改用凭据配置。 */
function containsMcpCredentialText(value: string | null): boolean {
  if (!value) return false;
  return /(?:^|\s|[-_])(?:api[-_]?key|access[-_]?token|authorization|bearer|password|passwd|secret|token|credential)(?:\s*[:=]|\s+)[^\s]+/iu.test(value);
}

/** 拒绝成对命令参数中的明显凭据，保留普通参数和运行时名称。 */
function containsMcpCredentialArgs(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index] ?? "";
    if (containsMcpCredentialText(item)) return true;
    const key = item.replace(/^-+/, "").split("=", 1)[0] ?? "";
    if (!isMcpCredentialKey(key)) continue;
    if (item.includes("=")) return true;
    const next = args[index + 1] ?? "";
    if (next && !next.startsWith("-")) return true;
  }
  return false;
}

/** 判断命令参数名是否具有凭据语义，不扩大到普通业务参数。 */
function isMcpCredentialKey(value: string): boolean {
  return /^(?:api[-_]?key|access[-_]?token|authorization|bearer|password|passwd|secret|token|credential|key|sig|signature|jwt)$/iu.test(value);
}

/** 拒绝带用户信息或常见凭据查询参数的自定义远程地址。 */
function containsMcpCredentialUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    return [...parsed.searchParams.keys()].some((key) => /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|password|passwd|secret|token|credential|key|sig|signature|jwt)$/iu.test(key));
  } catch {
    return containsMcpCredentialText(value);
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && typeof (value as NodeJS.ErrnoException).code === "string";
}
