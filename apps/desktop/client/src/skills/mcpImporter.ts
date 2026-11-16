import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { isDockerMcpCommand, type McpImportError, type McpImportSource, type McpServerInfo } from "@codeflowai/shared";

import { normalizeMcpServerInfo, upsertCustomMcpServers } from "./mcpRegistry.js";
import { runMcpMutationExclusive } from "./mcpInstaller.js";

type ImportCandidate = { source: McpImportSource; path: string; name: string; config: Record<string, unknown> };

/** 解析单个来源配置内容，供导入预览和单元测试复用，不执行持久化。 */
export function parseMcpImportSourceContent(source: McpImportSource, filePath: string, content: string, workspaceScope?: string | null): { items: McpServerInfo[]; errors: McpImportError[] } {
  const errors: McpImportError[] = [];
  const candidates = source === "codex"
    ? parseCodexConfig(source, filePath, content, errors)
    : parseJsonConfig(source, filePath, content, errors);
  const items = candidates
    .map((candidate) => normalizeImportedCandidate(candidate, errors, workspaceScope))
    .filter((item): item is McpServerInfo => item !== null);
  return { items, errors };
}

/** 从常见客户端配置读取 MCP 定义，只返回非敏感元数据并持久化到 Client 注册表。 */
export async function importMcpConfigurations(workspacePath?: string, sources?: McpImportSource[], workspaceScope?: string | null): Promise<{ items: McpServerInfo[]; errors: McpImportError[] }> {
  const candidates: ImportCandidate[] = [];
  const errors: McpImportError[] = [];
  for (const source of sources?.length ? sources : ["claude", "codex", "vscode", "cursor"] as McpImportSource[]) {
    for (const filePath of resolveSourcePaths(source, workspacePath)) {
      const content = await readSourceFile(source, filePath, errors);
      if (!content) continue;
      if (source === "codex") {
        candidates.push(...parseCodexConfig(source, filePath, content, errors));
        continue;
      }
      candidates.push(...parseJsonConfig(source, filePath, content, errors));
    }
  }

  const items: McpServerInfo[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeImportedCandidate(candidate, errors, workspaceScope);
    if (!normalized || seen.has(normalized.mcpId)) continue;
    seen.add(normalized.mcpId);
    items.push(normalized);
  }
  const persisted = await runMcpMutationExclusive({
    mcpId: "mcp-registry",
    instanceId: String(workspaceScope ?? "").trim() || "global",
    npmPackage: null,
    kind: "import",
  }, async () => {
    await upsertCustomMcpServers(items);
    return items;
  });
  if (!persisted.ok) throw new Error(persisted.error);
  return { items: persisted.value, errors };
}

/** 只读取存在的配置文件；权限或读取错误保留为可检索的导入错误。 */
async function readSourceFile(source: McpImportSource, filePath: string, errors: McpImportError[]): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    errors.push({ source, path: filePath, message: `读取配置失败：${error instanceof Error ? error.message : String(error)}` });
    return null;
  }
}

/** 解析 Claude、VS Code、Cursor 的 JSON MCP 配置结构。 */
function parseJsonConfig(source: McpImportSource, filePath: string, content: string, errors: McpImportError[]): ImportCandidate[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    errors.push({ source, path: filePath, message: `JSON 配置格式错误：${error instanceof Error ? error.message : String(error)}` });
    return [];
  }
  const root = asRecord(json);
  const nestedVscodeServers = asRecord(asRecord(root.mcp).servers);
  const flatVscodeServers = asRecord(root["mcp.servers"]);
  const rootVscodeServers = asRecord(root.servers);
  const servers = source === "vscode"
    ? Object.keys(nestedVscodeServers).length ? nestedVscodeServers : Object.keys(flatVscodeServers).length ? flatVscodeServers : Object.keys(rootVscodeServers).length ? rootVscodeServers : asRecord(root.mcpServers)
    : asRecord(root.mcpServers);
  return Object.entries(servers).flatMap(([name, config]) => {
    const normalized = asRecord(config);
    return normalized ? [{ source, path: filePath, name, config: normalized }] : [];
  });
}

/** 解析 Codex 的 mcp_servers TOML 段，只提取命令、参数、地址和 server 名。 */
function parseCodexConfig(source: McpImportSource, filePath: string, content: string, errors: McpImportError[]): ImportCandidate[] {
  const candidates: ImportCandidate[] = [];
  let current: ImportCandidate | null = null;
  let pendingArgs: string | null = null;
  const flush = (): void => {
    if (current && pendingArgs !== null) {
      current.config.__invalidArgs = true;
      errors.push({ source, path: filePath, message: `Codex MCP「${current.name}」参数列表格式暂不支持` });
      pendingArgs = null;
    }
    if (current) candidates.push(current);
    current = null;
  };
  for (const line of content.split(/\r?\n/)) {
    const header = line.trim().match(/^\[mcp_servers\.([^\]]+)\]$/i);
    if (header?.[1]) {
      flush();
      current = { source, path: filePath, name: header[1], config: {} };
      continue;
    }
    if (!current) continue;
    if (pendingArgs !== null) {
      pendingArgs += `\n${line.trim()}`;
      if (/\]\s*(?:#.*)?$/u.test(line.trim())) {
        current.config.args = parseTomlStringArray(pendingArgs);
        pendingArgs = null;
      }
      continue;
    }
    const command = line.match(/^\s*command\s*=\s*"([^"]*)"/i)?.[1];
    const url = line.match(/^\s*(?:url|server_url)\s*=\s*"([^"]*)"/i)?.[1];
    const args = line.match(/^\s*args\s*=\s*\[(.*)$/i)?.[1];
    if (command !== undefined) current.config.command = command;
    if (url !== undefined) current.config.url = url;
    if (args !== undefined) {
      if (/\]\s*(?:#.*)?$/u.test(args)) current.config.args = parseTomlStringArray(args);
      else pendingArgs = args;
    }
    if (/^\s*(?:bearer_token_env_var|http_headers)\s*=/iu.test(line)) current.config.__credentialReference = true;
  }
  flush();
  if (!candidates.length && content.includes("[mcp_servers.")) {
    errors.push({ source, path: filePath, message: "未能解析 Codex MCP 配置段" });
  }
  return candidates;
}

/** 从导入条目生成稳定身份，并明确拒绝 Docker 配置。 */
function normalizeImportedCandidate(candidate: ImportCandidate, errors: McpImportError[], workspaceScope?: string | null): McpServerInfo | null {
  const config = candidate.config;
  if (config.__invalidArgs) return null;
  const rawCommand = stringValue(config.command);
  const rawUrl = stringValue(config.url ?? config.serverUrl);
  const rawArgs = Array.isArray(config.args) ? config.args.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  const commandHasCredential = Boolean(rawCommand && containsCredentialText(rawCommand));
  const command = commandHasCredential ? "[请在高级配置中补充本地命令]" : rawCommand;
  const safeUrl = sanitizeImportedUrl(rawUrl);
  const safeArgs = sanitizeImportedArgs(rawArgs);
  const url = safeUrl.value;
  const args = safeArgs.args;
  const type = (stringValue(config.type) ?? "").toLowerCase();
  if (type === "docker" || isDockerMcpCommand(rawCommand)) {
    errors.push({ source: candidate.source, path: candidate.path, message: `MCP「${candidate.name}」使用 Docker，当前版本不支持导入` });
    return null;
  }
  const transportType = url && (type === "sse" || type === "server-sent-events") ? "sse" : url ? "streamable-http" : "stdio";
  const installType = url ? (transportType === "sse" ? "sse" : "http") : command ? "local-command" : "imported";
  if (!url && !command) {
    errors.push({ source: candidate.source, path: candidate.path, message: `MCP「${candidate.name}」缺少可识别的启动命令或服务地址` });
    return null;
  }
  const mcpId = `imported.${candidate.source}.${slug(candidate.name)}.${slug(basename(candidate.path))}`;
  const prerequisites: string[] = [];
  if (Object.keys(asRecord(config.env)).length || config.envFile) prerequisites.push("导入配置中的环境变量需在高级配置中补充");
  if (config.__credentialReference || Object.keys(asRecord(config.headers ?? config.http_headers)).length || safeUrl.redacted || safeArgs.redacted || commandHasCredential) {
    prerequisites.push("导入配置中的认证信息已隐藏，请在高级配置中补充");
  }
  const scope = String(workspaceScope ?? "").trim() || null;
  const identitySuffix = scope ? `.${sha256(`${scope}|${candidate.path}`)}` : "";
  const normalized = normalizeMcpServerInfo({
    mcpId: `${mcpId}${identitySuffix}`,
    name: candidate.name,
    serverName: candidate.name,
    command,
    args,
    url,
    installType,
    transportType,
    description: `从 ${candidate.source} 导入的 MCP 配置`,
    prerequisites,
    installSpecSummary: url ? `远程地址：${url}` : command ? `本地命令：${command}` : "导入配置",
    workspaceScope: scope,
  }, "imported");
  if (!normalized) {
    errors.push({ source: candidate.source, path: candidate.path, message: `MCP「${candidate.name}」缺少可识别的启动命令或服务地址` });
  }
  return normalized;
}

function resolveSourcePaths(source: McpImportSource, workspacePath?: string): string[] {
  const appData = String(process.env.APPDATA ?? "").trim();
  const xdgConfig = String(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")).trim();
  const platform = process.platform;
  const workspace = workspacePath ? [
    source === "vscode" ? join(workspacePath, ".vscode", "mcp.json") : "",
    source === "cursor" ? join(workspacePath, ".cursor", "mcp.json") : "",
  ] : [];
  const macApplicationSupport = join(homedir(), "Library", "Application Support");
  const vscodeGlobal = platform === "darwin"
    ? join(macApplicationSupport, "Code", "User")
    : platform === "win32" && isAbsolute(appData)
      ? join(appData, "Code", "User")
      : join(xdgConfig, "Code", "User");
  const cursorGlobal = platform === "darwin"
    ? join(macApplicationSupport, "Cursor", "User")
    : platform === "win32" && isAbsolute(appData)
      ? join(appData, "Cursor", "User")
      : join(xdgConfig, "Cursor", "User");
  const global = source === "claude"
    ? [join(homedir(), ".claude.json")]
    : source === "codex"
      ? [join(homedir(), ".codex", "config.toml")]
      : source === "vscode"
        ? [join(vscodeGlobal, "mcp.json"), join(vscodeGlobal, "settings.json")]
        : [join(homedir(), ".cursor", "mcp.json"), join(cursorGlobal, "mcp.json"), join(cursorGlobal, "settings.json")];
  return Array.from(new Set([...workspace, ...global].filter((filePath) => Boolean(filePath) && isAbsolute(filePath))));
}

function parseTomlStringArray(value: string): string[] {
  return Array.from(value.matchAll(/"((?:\\.|[^"])*)"/g)).map((match) => match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

/** 只保留可继续编辑的远程地址，移除 URL 用户信息和明显的凭据查询参数。 */
function sanitizeImportedUrl(value: string | null): { value: string | null; redacted: boolean } {
  if (!value) return { value: null, redacted: false };
  try {
    const parsed = new URL(value);
    let redacted = Boolean(parsed.username || parsed.password);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (!isCredentialKey(key)) continue;
      parsed.searchParams.delete(key);
      redacted = true;
    }
    return { value: parsed.toString(), redacted };
  } catch {
    return { value: containsCredentialText(value) ? "[请在高级配置中补充远程地址]" : value, redacted: containsCredentialText(value) };
  }
}

/** 移除带有 Token/Key/密码语义的命令参数及其紧邻值，避免导入响应泄露凭据。 */
function sanitizeImportedArgs(args: string[]): { args: string[]; redacted: boolean } {
  const safe: string[] = [];
  let redacted = false;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index] ?? "";
    const key = item.replace(/^[-]+/, "").split("=", 1)[0] ?? "";
    if (isCredentialKey(key) || /^bearer\s+/iu.test(item) || containsCredentialText(item)) {
      redacted = true;
      if (!item.includes("=") && index + 1 < args.length) index += 1;
      continue;
    }
    safe.push(item);
  }
  return { args: safe, redacted };
}

function isCredentialKey(value: string): boolean {
  return /^(?:api[-_]?key|access[-_]?token|auth(?:orization)?|bearer|password|passwd|secret|token|credential|key|sig|signature|jwt|[a-z0-9]+[-_](?:api[-_]?key|access[-_]?token|password|passwd|secret|token|credential|key|sig|signature|jwt))$/iu.test(value);
}

function containsCredentialText(value: string): boolean {
  return /(?:api[-_]?key|access[-_]?token|authorization|bearer|password|passwd|secret|token)\s*[:=]/iu.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
