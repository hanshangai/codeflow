import { isDockerMcpCommand, type McpEnableResponseBody, type McpEnableStage, type McpEnableStageName, type McpServerInfo, type McpServerStatus, type McpTestResponseBody } from "@codeflowai/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { runCli } from "../app/handlers/engineHandlers.js";
import { resolveClaudeCli } from "../engines/claude/claudeCli.js";
import { resolveCodexCli } from "../engines/codex-app-server/codexAppServerCli.js";
import { resolveWindowsNpmCli } from "../engines/utils/windowsNpmCli.js";
import { withCodexConfigWriteLock } from "../enginesConfig.js";
import { buildMcpInstanceId, findMcpServerById, findMcpServerByPackage, listRegisteredMcpServers, normalizeMcpServerInfo, removeCustomMcpServer, upsertCustomMcpServer } from "./mcpRegistry.js";
import { createCredentialStore } from "../security/credentialStore.js";
import type { McpCredentialInput } from "@codeflowai/shared";

const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp";
const CHROME_DEVTOOLS_MCP_SERVER = "chrome-devtools";
const CHROME_DEVTOOLS_MCP_CODEX_WINDOWS_STARTUP_TIMEOUT_MS = 20_000;
const CHROME_DEVTOOLS_MCP_CODEX_WINDOWS_EXTRA_ARGS = ["--isolated=true", "--channel=stable"] as const;

type McpLaunchSpec = {
  command: string;
  args: string[];
  env?: Record<string, string>;
  codexStartupTimeoutMs?: number;
};

type McpCliOptions = Parameters<typeof runCli>[0];

type McpMutationKind = "install" | "enable" | "update" | "uninstall" | "configure" | "unconfigure" | "import" | "test";
export type McpMutation = {
  mcpId?: string;
  instanceId?: string;
  npmPackage: string | null;
  kind: McpMutationKind;
  engine?: "claude" | "codex";
};

export function formatMcpMutationLabel(mutation: McpMutation): string {
  const identity = mutation.mcpId || mutation.npmPackage || "MCP";
  switch (mutation.kind) {
    case "install":
      return `安装 ${identity}`;
    case "uninstall":
      return `卸载 ${identity}`;
    case "enable":
      return `启用 ${identity}`;
    case "update":
      return `更新 ${identity}`;
    case "configure":
      return `配置 ${identity} 到 ${mutation.engine === "claude" ? "Claude" : "Codex"}`;
    case "unconfigure":
      return `从 ${mutation.engine === "claude" ? "Claude" : "Codex"} 移除 ${identity} 配置`;
    case "import":
      return `导入 ${identity} 配置`;
    case "test":
      return `测试 ${identity} 连接`;
  }
  return identity;
}

export function createMcpMutationGuard() {
  let active: McpMutation | null = null;

  return {
    async runExclusive<T>(mutation: McpMutation, task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
      if (active) {
        return { ok: false, error: `当前已有 MCP 操作正在执行：${formatMcpMutationLabel(active)}` };
      }
      active = mutation;
      try {
        return { ok: true, value: await task() };
      } finally {
        active = null;
      }
    },
  };
}

const mcpMutationGuard = createMcpMutationGuard();

/** 复用 MCP 进程内互斥边界，保护导入等注册表写操作不覆盖并发变更。 */
export async function runMcpMutationExclusive<T>(mutation: McpMutation, task: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return await mcpMutationGuard.runExclusive(mutation, task);
}

/** 以参数数组执行 MCP 所需 CLI；Windows 的 npm 使用真实 Node 入口，避免 shell 重解析参数。 */
async function runMcpCli(opts: McpCliOptions): Promise<Awaited<ReturnType<typeof runCli>>> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32" && opts.command === "npm") {
    const resolved = resolveWindowsNpmCli("npm", "node_modules\\npm\\bin\\npm-cli.js");
    return await runCli({
      ...opts,
      command: resolved.command,
      args: [...resolved.argsPrefix, ...opts.args],
      shell: false,
    });
  }
  return await runCli({ ...opts, shell: false });
}

type CustomMcpInstallInput = {
  mcpId?: string | null;
  instanceId?: string | null;
  workspaceScope?: string | null;
  workspacePath?: string | null;
  serverName?: string | null;
  name?: string | null;
  description?: string | null;
  homepage?: string | null;
  installType?: McpServerInfo["installType"];
  transportType?: McpServerInfo["transportType"];
  command?: string | null;
  args?: string[];
  url?: string | null;
  pythonPackage?: string | null;
  runner?: string | null;
  credentialInputs?: McpCredentialInput[];
};

const MCP_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const MCP_CREDENTIAL_MAX_VALUE_LENGTH = 16_384;

function isMcpCredentialNameValid(name: string, kind: McpCredentialInput["kind"]): boolean {
  return kind === "env" ? MCP_ENV_NAME_PATTERN.test(name) : MCP_HEADER_NAME_PATTERN.test(name);
}

/** 校验一次 MCP 凭据输入并拒绝不完整或超长值，避免凭据进入错误的配置参数。 */
export function normalizeMcpCredentialInputs(value: unknown): McpCredentialInput[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("MCP_CREDENTIAL_INPUT_INVALID: credentialInputs 必须是数组");
  const result: McpCredentialInput[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("MCP_CREDENTIAL_INPUT_INVALID: 凭据项格式无效");
    }
    const item = raw as Record<string, unknown>;
    const name = String(item.name ?? "").trim();
    const credentialValue = String(item.value ?? "");
    const kind = item.kind === "header" ? "header" : item.kind === "env" ? "env" : null;
    if (!kind || !isMcpCredentialNameValid(name, kind) || !credentialValue || credentialValue.length > MCP_CREDENTIAL_MAX_VALUE_LENGTH) {
      throw new Error("MCP_CREDENTIAL_INPUT_INVALID: 凭据名称或值无效");
    }
    if (names.has(`${kind}:${name}`)) throw new Error(`MCP_CREDENTIAL_INPUT_INVALID: 凭据重复：${name}`);
    names.add(`${kind}:${name}`);
    result.push({ name, value: credentialValue, kind });
  }
  return result;
}

/** 生成当前 MCP 实例的凭据存储键；仅使用非敏感身份，不把凭据写入注册表。 */
function mcpCredentialStoreKey(mcpId: string, instanceId: string, suffix: string): string {
  return `mcp:${mcpId}:${instanceId}:${suffix}`;
}

/** 读取当前 MCP 实例的本地凭据；存储损坏或缺项必须显式失败。 */
function readMcpCredentialInputs(mcpId: string, instanceId: string): McpCredentialInput[] {
  const store = createCredentialStore();
  const namesRaw = store.get(mcpCredentialStoreKey(mcpId, instanceId, "credential-names"));
  if (!namesRaw) return [];
  let names: Array<{ name: string; kind: "env" | "header" }>;
  try {
    const parsed = JSON.parse(namesRaw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("names 不是数组");
    names = parsed.map((item) => {
      if (!item || typeof item !== "object") throw new Error("name 条目无效");
      const record = item as Record<string, unknown>;
      const name = String(record.name ?? "").trim();
      const kind = record.kind === "header" ? "header" : record.kind === "env" ? "env" : null;
      if (!kind || !isMcpCredentialNameValid(name, kind)) throw new Error("name 条目无效");
      return { name, kind };
    });
  } catch (error) {
    throw new Error(`MCP_CREDENTIAL_STORE_INVALID: 本地 MCP 凭据索引无效：${error instanceof Error ? error.message : String(error)}`);
  }
  return names.map(({ name, kind }) => {
    const value = store.get(mcpCredentialStoreKey(mcpId, instanceId, `${kind}:${name}`));
    if (!value) throw new Error(`MCP_CREDENTIAL_STORE_INVALID: MCP 凭据缺失：${name}`);
    return { name, value, kind };
  });
}

/** 保存本次输入的 MCP 凭据并返回当前完整凭据；没有新输入时仅恢复本地缓存。 */
function saveMcpCredentialInputs(mcpId: string, instanceId: string, value: unknown): McpCredentialInput[] {
  const inputs = normalizeMcpCredentialInputs(value);
  const store = createCredentialStore();
  const current = readMcpCredentialInputs(mcpId, instanceId);
  if (!inputs.length) return current;
  const merged = new Map(current.map((item) => [`${item.kind}:${item.name}`, item]));
  for (const item of inputs) {
    store.set(mcpCredentialStoreKey(mcpId, instanceId, `${item.kind}:${item.name}`), item.value);
    merged.set(`${item.kind}:${item.name}`, item);
  }
  store.set(
    mcpCredentialStoreKey(mcpId, instanceId, "credential-names"),
    JSON.stringify([...merged.values()].map(({ name, kind }) => ({ name, kind }))),
  );
  return readMcpCredentialInputs(mcpId, instanceId);
}

/** 只在 Codex 已接入该实例时恢复远程 Bearer 派生变量；普通凭据不进入 Client 全局环境。 */
function hydrateMcpCredentialEnvironment(mcpId: string, instanceId: string, restoreCodexBearer: boolean): McpCredentialInput[] {
  const inputs = readMcpCredentialInputs(mcpId, instanceId);
  if (restoreCodexBearer) Object.assign(process.env, resolveMcpRuntimeCredentialEnvironment(mcpId, instanceId, inputs));
  return inputs;
}

/** 仅在错误文本中替换已知凭据值，避免 CLI stderr 或远端响应泄露敏感数据。 */
function sanitizeMcpError(error: unknown, credentials: readonly McpCredentialInput[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of credentials) {
    if (credential.value) message = message.split(credential.value).join("[REDACTED]");
  }
  return message.length > 1_000 ? `${message.slice(0, 1_000)}...` : message;
}

/** 生成每个 MCP 实例独立的 Codex Bearer 环境变量名，避免不同工作区共享令牌。 */
export function buildMcpBearerEnvName(mcpId: string, instanceId: string): string {
  const digest = createHash("sha256").update(`${mcpId}\0${instanceId}`, "utf8").digest("hex").slice(0, 24).toUpperCase();
  return `CODEFLOWAI_MCP_BEARER_${digest}`;
}

/** 从本地凭据索引中恢复引擎实际引用的运行时变量，不暴露普通凭据到全局环境。 */
export function resolveMcpRuntimeCredentialEnvironment(
  mcpId: string,
  instanceId: string,
  inputs: readonly McpCredentialInput[],
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const input of inputs) {
    if (input.kind !== "header" || input.name.toLowerCase() !== "authorization") continue;
    const bearer = input.value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer) environment[buildMcpBearerEnvName(mcpId, instanceId)] = bearer;
  }
  return environment;
}

/** 为工作区实例生成稳定的引擎配置名，避免同一 Client 的配置互相覆盖。 */
export function resolveMcpEngineServerName(serverName: string, instanceId: string): string {
  // 导入的 serverName 可能已带 __cf_ 后缀，避免重复追加导致找不到目标。
  if (/__cf_[0-9a-f]{10}$/i.test(serverName)) return serverName;
  const digest = createHash("sha256").update(instanceId, "utf8").digest("hex").slice(0, 10);
  return `${serverName}__cf_${digest}`;
}

/** 解析 MCP 注册条目；自定义包允许通过请求体补充注册信息。 */
async function resolveMcpRegistryEntry(
  npmPackage: string | null,
  customInput?: CustomMcpInstallInput | null,
  options?: { allowCreateCustom?: boolean },
): Promise<{ ok: true; entry: McpServerInfo } | { ok: false; error: string }> {
  const unsupportedType = getUnsupportedMcpInstallType(customInput);
  if (unsupportedType) return { ok: false, error: unsupportedType };
  const requestedMcpId = String(customInput?.mcpId ?? "").trim();
  const workspaceScope = String(customInput?.workspaceScope ?? "").trim() || null;
  const requestedById = requestedMcpId ? findMcpServerById(requestedMcpId, workspaceScope) : null;
  if (requestedById && npmPackage && requestedById.npmPackage && requestedById.npmPackage !== npmPackage) {
    return { ok: false, error: `mcpId 与 npmPackage 不匹配：${requestedMcpId}` };
  }
  const existing = requestedById ?? (npmPackage ? findMcpServerByPackage(npmPackage, workspaceScope) : null);
  if (existing) {
    if (String((existing as Record<string, unknown>).installType ?? "").trim().toLowerCase() === "docker" || isDockerMcpCommand(existing.command)) {
      return { ok: false, error: "当前版本不支持 Docker 类型 MCP" };
    }
    const instanceError = validateMcpInstanceId(existing.mcpId, customInput?.instanceId, workspaceScope);
    return instanceError ? { ok: false, error: instanceError } : { ok: true, entry: existing };
  }
  if (options?.allowCreateCustom === false) {
    return { ok: false, error: "MCP_REGISTRY_ENTRY_INVALID: 未找到当前 MCP 配置" };
  }

  const normalized = normalizeMcpServerInfo({
    mcpId: customInput?.mcpId ?? undefined,
    npmPackage,
    serverName: customInput?.serverName ?? "",
    name: customInput?.name ?? "",
    description: customInput?.description ?? "",
    homepage: customInput?.homepage ?? null,
    installType: customInput?.installType,
    transportType: customInput?.transportType,
    command: customInput?.command,
    args: customInput?.args,
    url: customInput?.url,
    pythonPackage: customInput?.pythonPackage,
    runner: customInput?.runner,
    workspaceScope,
  }, "custom");
  if (!normalized) {
    return { ok: false, error: "MCP 注册信息不完整，请补充名称以及对应安装方式的必要参数" };
  }
  const instanceError = validateMcpInstanceId(normalized.mcpId, customInput?.instanceId, workspaceScope);
  if (instanceError) return { ok: false, error: instanceError };
  await upsertCustomMcpServer(normalized);
  return { ok: true, entry: normalized };
}

/** 拒绝当前版本明确不支持的 Docker MCP 输入，避免现有条目被错误当作可用配置。 */
function getUnsupportedMcpInstallType(input?: CustomMcpInstallInput | null): string | null {
  const installType = String((input as Record<string, unknown> | null | undefined)?.installType ?? "").trim().toLowerCase();
  const command = String((input as Record<string, unknown> | null | undefined)?.command ?? "").trim().toLowerCase();
  if (installType === "docker" || isDockerMcpCommand(command)) {
    return "当前版本不支持 Docker 类型 MCP";
  }
  return null;
}

/** 校验实例必须属于当前工作区作用域，防止跨工作区读取配置或凭据。 */
export function validateMcpInstanceId(mcpId: string, instanceId?: string | null, workspaceScope?: string | null): string | null {
  const normalized = String(instanceId ?? "").trim();
  if (!normalized) return null;
  const expected = buildMcpInstanceId(mcpId, String(workspaceScope ?? "").trim() || "default");
  if (normalized !== expected) return `instanceId 与当前工作区不匹配：${instanceId}`;
  return null;
}

/** 解析请求实例身份；缺省按工作区作用域派生，保证与状态探测口径一致。 */
export function resolveMcpInstanceId(entry: Pick<McpServerInfo, "mcpId">, instanceId?: string | null, workspaceScope?: string | null): string {
  const normalized = String(instanceId ?? "").trim();
  return normalized || buildMcpInstanceId(entry.mcpId, String(workspaceScope ?? "").trim() || "default");
}

function resolveWindowsEnvValue(...candidates: Array<string | undefined>): string | null {
  for (const value of candidates) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return null;
}

function resolveMcpRunnerPackage(npmPackage: string): string {
  if (npmPackage === CHROME_DEVTOOLS_MCP_PACKAGE) {
    return `${npmPackage}@latest`;
  }
  return npmPackage;
}

export function resolveMcpLaunchSpec(
  serverName: string,
  npmPackage: string,
  engine: "claude" | "codex",
  platform: NodeJS.Platform = process.platform,
): McpLaunchSpec {
  const runnerPackage = resolveMcpRunnerPackage(npmPackage);

  if (engine === "codex" && platform === "win32" && npmPackage === CHROME_DEVTOOLS_MCP_PACKAGE && serverName === CHROME_DEVTOOLS_MCP_SERVER) {
    return {
      command: "cmd",
      args: ["/c", "npx", "-y", runnerPackage, ...CHROME_DEVTOOLS_MCP_CODEX_WINDOWS_EXTRA_ARGS],
      env: {
        SystemRoot: resolveWindowsEnvValue(process.env.SystemRoot, process.env.SYSTEMROOT, "C:\\Windows") ?? "C:\\Windows",
        PROGRAMFILES: resolveWindowsEnvValue(process.env.PROGRAMFILES, process.env.ProgramFiles, "C:\\Program Files") ?? "C:\\Program Files",
      },
      codexStartupTimeoutMs: CHROME_DEVTOOLS_MCP_CODEX_WINDOWS_STARTUP_TIMEOUT_MS,
    };
  }

  return {
    command: "npx",
    args: ["-y", runnerPackage],
  };
}

/** 将本地命令、NPM 和 PyPI 条目转换为引擎可执行的 stdio 启动参数。 */
function resolveEntryLaunchSpec(entry: McpServerInfo, engine: "claude" | "codex"): McpLaunchSpec {
  if (entry.installType === "local-command") {
    if (!entry.command || !entry.serverName) throw new Error("本地命令 MCP 缺少 command 或 serverName");
    return { command: entry.command, args: entry.args ?? [] };
  }
  if (entry.installType === "pypi") {
    if (!entry.pythonPackage || !entry.runner || !entry.serverName) throw new Error("PyPI MCP 缺少 package、runner 或 serverName");
    return entry.runner === "uvx"
      ? { command: "uvx", args: [entry.pythonPackage, ...(entry.args ?? [])] }
      : { command: entry.runner, args: ["-m", entry.pythonPackage, ...(entry.args ?? [])] };
  }
  if (entry.installType !== "npm" || !entry.npmPackage || !entry.serverName) {
    throw new Error("当前 MCP 类型不支持本地 stdio 启动");
  }
  return resolveMcpLaunchSpec(entry.serverName, entry.npmPackage, engine);
}

function atomicWriteText(filePath: string, content: string): Promise<void> {
  return mkdir(dirname(filePath), { recursive: true })
    .then(async () => {
      const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, content, "utf-8");
      await rename(tmpPath, filePath);
    });
}

function normalizeTomlLines(lines: string[]): string {
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && result.length > 0 && result[result.length - 1].trim() === "") continue;
    result.push(line);
  }
  return `${result.join("\n").trimEnd()}\n`;
}

function formatTomlInteger(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, "_");
}

export function updateCodexMcpServerConfigText(
  content: string,
  serverName: string,
  patch: { startupTimeoutMs?: number | null },
): string {
  const lines = content ? content.split(/\r?\n/) : [];
  const header = `[mcp_servers.${serverName}]`;
  const startIdx = lines.findIndex((line) => line.trim() === header);
  if (startIdx < 0) return content;

  let endIdx = lines.findIndex((line, index) => index > startIdx && /^\s*\[/.test(line));
  if (endIdx < 0) endIdx = lines.length;

  const before = lines.slice(0, startIdx + 1);
  const section = lines.slice(startIdx + 1, endIdx);
  const after = lines.slice(endIdx);

  if (patch.startupTimeoutMs != null && Number.isFinite(patch.startupTimeoutMs) && patch.startupTimeoutMs > 0) {
    const timeoutLine = `startup_timeout_ms = ${formatTomlInteger(Math.trunc(patch.startupTimeoutMs))}`;
    let replaced = false;
    const nextSection = section.map((line) => {
      if (/^\s*startup_timeout_ms\s*=/.test(line)) {
        replaced = true;
        return timeoutLine;
      }
      return line;
    });
    if (!replaced) {
      while (nextSection.length > 0 && nextSection[nextSection.length - 1].trim() === "") nextSection.pop();
      nextSection.push(timeoutLine);
    }
    return normalizeTomlLines([...before, ...nextSection, ...after]);
  }

  return normalizeTomlLines([...before, ...section, ...after]);
}

async function ensureCodexMcpServerStartupTimeout(serverName: string, startupTimeoutMs: number): Promise<void> {
  const filePath = join(homedir(), ".codex", "config.toml");
  const raw = await readFile(filePath, "utf-8");
  const header = `[mcp_servers.${serverName}]`;
  if (!raw.split(/\r?\n/).some((line) => line.trim() === header)) {
    throw new Error(`Codex 配置中未找到 ${header} 段`);
  }
  const next = updateCodexMcpServerConfigText(raw, serverName, { startupTimeoutMs });
  if (next !== raw) {
    await atomicWriteText(filePath, next);
  }
}

// ── Claude MCP 配置 ──────────────────────────────────────────────

/**
 * 将 MCP Server 注册到 Claude Code 配置中（`claude mcp add`，user scope）。
 * 配置失败直接返回错误，阻断启用流程并保留失败阶段。
 */
async function configureClaudeMcp(entry: McpServerInfo, instanceId: string, credentials: McpCredentialInput[]): Promise<void> {
  const { command, argsPrefix } = resolveClaudeCli();
  if (!entry.serverName) throw new Error("MCP 缺少 serverName");
  const serverName = resolveMcpEngineServerName(entry.serverName, instanceId);
  if ((entry.transportType === "streamable-http" || entry.transportType === "sse") && credentials.some((item) => item.kind !== "header")) {
    throw new Error("MCP_CREDENTIAL_INPUT_INVALID: 远程 MCP 只支持请求头凭据");
  }
  const args = entry.transportType === "streamable-http" || entry.transportType === "sse"
    ? [
      ...argsPrefix,
      "mcp", "add", "--transport", entry.transportType === "sse" ? "sse" : "http",
      serverName, entry.url ?? "", "-s", "user",
      ...credentials.flatMap((item) => item.kind === "header" ? ["--header", `${item.name}: ${item.value}`] : []),
    ]
    : (() => {
      const launch = resolveEntryLaunchSpec(entry, "claude");
      const env = new Map(Object.entries(launch.env ?? {}));
      for (const item of credentials) {
        if (item.kind !== "env") throw new Error("MCP_CREDENTIAL_INPUT_INVALID: stdio MCP 只支持环境变量凭据");
        env.set(item.name, item.value);
      }
      const envArgs = [...env.entries()].flatMap(([key, value]) => ["-e", `${key}=${value}`]);
      return [...argsPrefix, "mcp", "add", serverName, "-s", "user", ...envArgs, "--", launch.command, ...launch.args];
    })();
  const result = await runMcpCli({
    command,
    args,
    timeoutMs: 15_000,
  });
  if (!result.ok) {
    throw new Error(result.error ?? `Claude 写入 MCP 配置失败：${serverName}`);
  }
}

/**
 * 从 Claude Code 配置中移除 MCP Server（`claude mcp remove`，user scope）。
 * 移除失败直接返回错误，避免页面误报配置已移除。
 */
async function unconfigureClaudeMcp(serverName: string): Promise<void> {
  const { command, argsPrefix } = resolveClaudeCli();
  const result = await runMcpCli({
    command,
    args: [...argsPrefix, "mcp", "remove", serverName, "-s", "user"],
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    throw new Error(result.error ?? `Claude 移除 MCP 配置失败：${serverName}`);
  }
}

// ── Codex MCP 配置 ──────────────────────────────────────────────

/**
 * 将 MCP Server 注册到 Codex 配置中（`codex mcp add`）。
 */
async function configureCodexMcp(entry: McpServerInfo, instanceId: string, credentials: McpCredentialInput[]): Promise<void> {
  await withCodexConfigWriteLock(async () => {
    const { command, argsPrefix } = resolveCodexCli();
    if (!entry.serverName) throw new Error("MCP 缺少 serverName");
    const serverName = resolveMcpEngineServerName(entry.serverName, instanceId);
    const args = entry.transportType === "streamable-http" || entry.transportType === "sse"
      ? (() => {
        if (!credentials.length) return [...argsPrefix, "mcp", "add", serverName, "--url", entry.url ?? ""];
        if (credentials.length !== 1 || credentials[0]!.kind !== "header" || credentials[0]!.name.toLowerCase() !== "authorization" || !/^Bearer\s+/i.test(credentials[0]!.value)) {
          throw new Error("MCP_CREDENTIAL_UNSUPPORTED: Codex 远程 MCP 仅支持 Authorization Bearer 凭据");
        }
        const envName = buildMcpBearerEnvName(entry.mcpId, instanceId);
        process.env[envName] = credentials[0]!.value.replace(/^Bearer\s+/i, "");
        return [...argsPrefix, "mcp", "add", serverName, "--url", entry.url ?? "", "--bearer-token-env-var", envName];
      })()
      : (() => {
        const launch = resolveEntryLaunchSpec(entry, "codex");
        const env = new Map(Object.entries(launch.env ?? {}));
        for (const item of credentials) {
          if (item.kind !== "env") throw new Error("MCP_CREDENTIAL_INPUT_INVALID: stdio MCP 只支持环境变量凭据");
          env.set(item.name, item.value);
        }
        const envArgs = [...env.entries()].flatMap(([key, value]) => ["--env", `${key}=${value}`]);
        return [...argsPrefix, "mcp", "add", serverName, ...envArgs, "--", launch.command, ...launch.args];
      })();
    const result = await runMcpCli({
      command,
      args,
      timeoutMs: 15_000,
    });
    if (!result.ok) {
      throw new Error(result.error ?? `Codex 写入 MCP 配置失败：${serverName}`);
    }
    if (entry.installType === "npm" && entry.npmPackage === CHROME_DEVTOOLS_MCP_PACKAGE && entry.serverName === CHROME_DEVTOOLS_MCP_SERVER) {
      const launch = resolveMcpLaunchSpec(entry.serverName, entry.npmPackage, "codex");
      if (launch.codexStartupTimeoutMs) {
        await ensureCodexMcpServerStartupTimeout(serverName, launch.codexStartupTimeoutMs);
      }
    }
  });
}

/**
 * 从 Codex 配置中移除 MCP Server（`codex mcp remove`）。
 */
async function unconfigureCodexMcp(serverName: string): Promise<void> {
  await withCodexConfigWriteLock(async () => {
    const { command, argsPrefix } = resolveCodexCli();
    const result = await runMcpCli({
      command,
      args: [...argsPrefix, "mcp", "remove", serverName],
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      console.warn(`[mcp] codex mcp remove ${serverName} 失败: ${result.error}`);
      throw new Error(result.error ?? `Codex 移除 MCP 配置失败：${serverName}`);
    }
  });
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function probeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 对外：配置 / 取消配置 ───────────────────────────────────────

/**
 * 将指定 MCP Server 配置到目标引擎（不做 npm 全局安装，使用 npx 按需运行）。
 */
export async function configureMcpServer(
  npmPackage: string | null,
  engine: "claude" | "codex",
  customInput?: CustomMcpInstallInput | null,
): Promise<{ success: boolean; error: string | null }> {
  const resolved = await resolveMcpRegistryEntry(npmPackage, customInput);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const entry = resolved.entry;
  const instanceId = resolveMcpInstanceId(entry, customInput?.instanceId, customInput?.workspaceScope);
  const locked = await mcpMutationGuard.runExclusive({
    mcpId: entry.mcpId,
    instanceId,
    npmPackage,
    kind: "configure",
    engine,
  }, async () => configureMcpServerCore(entry, engine, instanceId, customInput?.credentialInputs));
  if (!locked.ok) {
    return { success: false, error: locked.error };
  }
  return locked.value;
}

/**
 * 从目标引擎中移除指定 MCP Server 的配置。
 */
export async function unconfigureMcpServer(
  npmPackage: string | null,
  engine: "claude" | "codex",
  customInput?: CustomMcpInstallInput | null,
): Promise<{ success: boolean; error: string | null }> {
  const resolved = await resolveMcpRegistryEntry(npmPackage, customInput);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const entry = resolved.entry;
  const instanceId = resolveMcpInstanceId(entry, customInput?.instanceId, customInput?.workspaceScope);
  const locked = await mcpMutationGuard.runExclusive({
    mcpId: entry.mcpId,
    instanceId,
    npmPackage,
    kind: "unconfigure",
    engine,
  }, async () => {
    try {
      if (engine === "claude") {
        if (!entry.serverName) throw new Error("MCP 缺少 serverName");
        await unconfigureClaudeMcp(resolveMcpEngineServerName(entry.serverName, instanceId));
      } else {
        if (!entry.serverName) throw new Error("MCP 缺少 serverName");
        await unconfigureCodexMcp(resolveMcpEngineServerName(entry.serverName, instanceId));
      }
      return { success: true, error: null };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  if (!locked.ok) {
    return { success: false, error: locked.error };
  }
  return locked.value;
}

// ── 配置文件扫描 ─────────────────────────────────────────────────

/**
 * 从 JSON 格式的 MCP 配置中提取已配置的 npm 包名集合。
 * 匹配方式：在 command/args 中查找注册表中的 npm 包名。
 */
function extractConfiguredPackages(
  mcpServers: Record<string, { command?: string; args?: string[] }> | undefined,
  workspaceScope?: string | null,
): Set<string> {
  const result = new Set<string>();
  if (!mcpServers || typeof mcpServers !== "object") return result;
  const registry = listRegisteredMcpServers(workspaceScope);

  for (const [_name, config] of Object.entries(mcpServers)) {
    if (!config || typeof config !== "object") continue;
    // 把 command + args 拼成一个字符串去匹配 npm 包名
    const parts: string[] = [];
    if (typeof config.command === "string") parts.push(config.command);
    if (Array.isArray(config.args)) {
      for (const a of config.args) {
        if (typeof a === "string") parts.push(a);
      }
    }
    const haystack = parts.join(" ");
    result.add(_name);
    for (const server of registry) {
      if (server.npmPackage && haystack.includes(server.npmPackage)) {
        result.add(server.npmPackage);
      }
    }
  }
  return result;
}

/**
 * 读取 ~/.claude.json 中的 mcpServers（用户级）。
 */
async function readClaudeUserMcpConfig(workspaceScope?: string | null): Promise<Set<string>> {
  try {
    const filePath = join(homedir(), ".claude.json");
    const raw = await readFile(filePath, "utf-8");
    const json = JSON.parse(raw);
    return extractConfiguredPackages(json?.mcpServers, workspaceScope);
  } catch (error) {
    if (isMissingFileError(error)) return new Set();
    throw new Error(`读取 Claude MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 读取 <workspace>/.mcp.json 中的 mcpServers（项目级，Claude/Codex 共用）。
 */
async function readProjectMcpConfig(workspacePath: string, workspaceScope?: string | null): Promise<Set<string>> {
  try {
    const filePath = join(workspacePath, ".mcp.json");
    const raw = await readFile(filePath, "utf-8");
    const json = JSON.parse(raw);
    return extractConfiguredPackages(json?.mcpServers, workspaceScope);
  } catch (error) {
    if (isMissingFileError(error)) return new Set();
    throw new Error(`读取项目 MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 读取 ~/.codex/config.toml 中的 [mcp_servers.*] 段。
 * 简易 TOML 解析：逐行匹配 section header + args 字段。
 */
async function readCodexUserMcpConfig(workspaceScope?: string | null): Promise<Set<string>> {
  try {
    const filePath = join(homedir(), ".codex", "config.toml");
    const raw = await readFile(filePath, "utf-8");
    const result = new Set<string>();
    const registry = listRegisteredMcpServers(workspaceScope);

    // 简易解析：找出所有 [mcp_servers.*] section 下的 args 行
    let inMcpSection = false;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      // 检测 section header
      if (trimmed.startsWith("[")) {
        const headerMatch = trimmed.match(/^\[mcp_servers\.([^\]]+)\]/i);
        inMcpSection = Boolean(headerMatch);
        if (headerMatch?.[1]) result.add(headerMatch[1]);
        continue;
      }
      if (!inMcpSection) continue;
      // 在 mcp_servers section 内，查找 args 或 command 行中的包名
      for (const server of registry) {
        if (server.npmPackage && trimmed.includes(server.npmPackage)) {
          result.add(server.npmPackage);
        }
      }
    }
    return result;
  } catch (error) {
    if (isMissingFileError(error)) return new Set();
    throw new Error(`读取 Codex MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 通过 `codex mcp list --json` 获取 Codex 已配置的 MCP Server。
 */
async function readCodexMcpListJson(workspaceScope?: string | null): Promise<Set<string>> {
  try {
    const { command, argsPrefix } = resolveCodexCli();
    const result = await runMcpCli({
      command,
      args: [...argsPrefix, "mcp", "list", "--json"],
      timeoutMs: 30_000,
    });
    if (!result.ok) throw new Error(result.error ?? "Codex MCP 配置查询失败");
    if (!result.stdout) return new Set();

    const arr = JSON.parse(result.stdout);
    if (!Array.isArray(arr)) return new Set();

    const configured = new Set<string>();
    const registry = listRegisteredMcpServers(workspaceScope);
    for (const entry of arr) {
      if (typeof entry?.name === "string") configured.add(entry.name);
      // entry.transport.args 中包含 npm 包名
      const transport = entry?.transport;
      if (!transport) continue;
      const parts: string[] = [];
      if (typeof transport.command === "string") parts.push(transport.command);
      if (Array.isArray(transport.args)) {
        for (const a of transport.args) {
          if (typeof a === "string") parts.push(a);
        }
      }
      const haystack = parts.join(" ");
      for (const server of registry) {
        if (server.npmPackage && haystack.includes(server.npmPackage)) {
          configured.add(server.npmPackage);
        }
      }
    }
    return configured;
  } catch (error) {
    throw new Error(`查询 Codex MCP 配置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── 状态检测 ─────────────────────────────────────────────────────

/**
 * 检测所有注册 MCP Server 的状态。
 *
 * 检测策略（全部并行执行）：
 * 1. `npm ls -g --depth=0 --json`  → 全局安装状态 + 版本
 * 2. `~/.claude.json`              → Claude 用户级配置
 * 3. `<workspace>/.mcp.json`       → 项目级配置（Claude/Codex 共用）
 * 4. `~/.codex/config.toml`        → Codex 用户级配置
 * 5. `codex mcp list --json`       → Codex 运行时配置（补充 TOML 解析）
 * 6. 仅对已安装的包执行 `npm view` 检查更新
 */
export async function getMcpServersStatus(workspacePath?: string, instanceScope = "default"): Promise<Record<string, McpServerStatus>> {
  const results: Record<string, McpServerStatus> = {};
  const registry = listRegisteredMcpServers(instanceScope);

  // 并行执行所有探测；单个配置源失败时保留其它来源并把错误写入状态。
  const [globalProbe, claudeProbe, projectProbe, codexTomlProbe, codexCliProbe] = await Promise.allSettled([
    runMcpCli({ command: "npm", args: ["ls", "-g", "--depth=0", "--json"], timeoutMs: 20_000 }),
    readClaudeUserMcpConfig(instanceScope),
    workspacePath ? readProjectMcpConfig(workspacePath, instanceScope) : Promise.resolve(new Set<string>()),
    readCodexUserMcpConfig(instanceScope),
    readCodexMcpListJson(instanceScope),
  ]);
  const globalProbeErrors = [globalProbe]
    .filter((probe): probe is PromiseRejectedResult => probe.status === "rejected")
    .map((probe) => probeReason(probe.reason));
  const configProbeErrors = [claudeProbe, projectProbe, codexTomlProbe, codexCliProbe]
    .filter((probe): probe is PromiseRejectedResult => probe.status === "rejected")
    .map((probe) => probeReason(probe.reason));
  const globalLsResult = globalProbe.status === "fulfilled"
    ? globalProbe.value
    : { ok: false, stdout: "", error: probeReason(globalProbe.reason) };
  const claudeConfigured = claudeProbe.status === "fulfilled" ? claudeProbe.value : new Set<string>();
  const projectConfigured = projectProbe.status === "fulfilled" ? projectProbe.value : new Set<string>();
  const codexTomlConfigured = codexTomlProbe.status === "fulfilled" ? codexTomlProbe.value : new Set<string>();
  const codexCliConfigured = codexCliProbe.status === "fulfilled" ? codexCliProbe.value : new Set<string>();

  // 合并 Codex 配置源（TOML + CLI）
  const codexConfigured = new Set([...codexTomlConfigured, ...codexCliConfigured]);

  // 解析全局安装包列表
  let globalDeps: Record<string, { version?: string }> = {};
  if (globalLsResult.ok && globalLsResult.stdout) {
    try {
      const json = JSON.parse(globalLsResult.stdout);
      globalDeps = json?.dependencies ?? {};
    } catch (error) {
      globalProbeErrors.push(`npm 全局安装状态解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!globalLsResult.ok && !globalLsResult.stdout) {
    globalProbeErrors.push(`npm 全局安装状态查询失败：${globalLsResult.error ?? "未知错误"}`);
  }
  const globalProbeError = globalProbeErrors.length ? `NPM 安装状态探测失败：${globalProbeErrors.join("；")}` : null;
  const configProbeError = configProbeErrors.length ? `配置状态探测部分失败：${configProbeErrors.join("；")}` : null;

  // 初始化所有 server 状态
  const installedServers: Array<{ server: McpServerInfo; npmPackage: string; currentVersion: string }> = [];
  const pypiEntries = registry.filter((server) => server.installType === "pypi" && server.runner && server.runner !== "uvx" && server.pythonPackage);
  const pypiProbeResults = await Promise.all(pypiEntries.map(async (server) => {
    const result = await runMcpCli({ command: server.runner!, args: ["-m", "pip", "show", server.pythonPackage!], timeoutMs: 15_000 });
    if (result.ok) {
      const version = result.stdout.match(/^Version:\s*(.+)$/mi)?.[1]?.trim() || null;
      return { mcpId: server.mcpId, installed: true, version, error: null, unknown: !version };
    }
    const notFound = result.failureKind === "nonzero_exit" && /package\(s\) not found|no matching distribution/i.test(result.error ?? "");
    return { mcpId: server.mcpId, installed: false, version: null, error: notFound ? null : result.error, unknown: !notFound };
  }));
  const pypiStatuses = new Map(pypiProbeResults.map((item) => [item.mcpId, item]));

  for (const server of registry) {
    const pkg = server.npmPackage;
    const entry = pkg ? globalDeps[pkg] : undefined;
    const pypiStatus = pypiStatuses.get(server.mcpId);
    const instanceId = buildMcpInstanceId(server.mcpId, instanceScope);
    const configuredLabels = resolveMcpConfiguredLabels(server, instanceId, {
      claude: claudeConfigured,
      codex: codexConfigured,
      project: projectConfigured,
    });
    const configuredInCodex = configuredLabels.includes("codex");
    const configuredInProject = configuredLabels.includes("project");
    let credentialInputs: McpCredentialInput[] = [];
    let credentialError: string | null = null;
    try {
      credentialInputs = hydrateMcpCredentialEnvironment(server.mcpId, instanceId, configuredInCodex);
    } catch (error) {
      credentialError = sanitizeMcpError(error);
    }
    const installed = pkg ? Boolean(entry?.version) : server.installType === "local-command" || server.installType === "http" || server.installType === "sse" || server.runner === "uvx"
      ? false
      : Boolean(pypiStatus?.installed);
    const currentVersion = pkg ? entry?.version ?? null : pypiStatus?.version ?? null;
    const installationStatus = server.installType === "http" || server.installType === "sse" || server.installType === "local-command" || server.runner === "uvx"
      ? "not-required"
      : pypiStatus?.unknown
        ? "unknown"
        : installed ? "installed" : "not-installed";

    const status: McpServerStatus = {
      mcpId: server.mcpId,
      instanceId,
      npmPackage: pkg,
      installed,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      configuredInClaude: configuredLabels.includes("claude"),
      configuredInCodex,
      configuredInProject,
      installType: server.installType,
      transportType: server.transportType,
      installationStatus,
      credentialConfigured: credentialInputs.length > 0,
      error: [server.npmPackage ? globalProbeError : null, configProbeError, pypiStatus?.error ? `PyPI 状态查询失败：${pypiStatus.error}` : null, credentialError ? `MCP 凭据状态查询失败：${credentialError}` : null].filter(Boolean).join("；") || null,
    };
    // 新接口按 mcpId 读取，旧页面仍按 npmPackage 读取同一份状态对象。
    results[server.mcpId] = status;
    if (pkg) results[pkg] = status;

    if (pkg && installed && currentVersion) {
      installedServers.push({ server, npmPackage: pkg, currentVersion });
    }
  }

  // 仅对已安装的包查询远程最新版本（检查是否有更新）
  if (installedServers.length) {
    await Promise.all(
      installedServers.map(async ({ server, npmPackage, currentVersion }) => {
        const remoteResult = await runMcpCli({
          command: "npm",
          args: ["view", npmPackage, "version"],
          timeoutMs: 15_000,
        });
        if (remoteResult.ok && remoteResult.stdout) {
          const latestVersion = remoteResult.stdout.trim();
          const status = results[server.mcpId];
          if (!status) return;
          status.latestVersion = latestVersion;
          if (currentVersion !== latestVersion) {
            status.updateAvailable = true;
          }
        }
      }),
    );
  }

  return results;
}

// ── 安装 / 卸载 ─────────────────────────────────────────────────

/**
 * 全局安装指定 MCP Server npm 包（仅 npm install -g，不自动配置到任何引擎）。
 * 内置包直接复用注册表；自定义包需要同时补充 serverName 与名称。
 */
export async function installMcpServer(
  npmPackage: string,
  version?: string | null,
  customInput?: CustomMcpInstallInput | null,
): Promise<{ success: boolean; installedVersion: string | null; error: string | null }> {
  const resolved = await resolveMcpRegistryEntry(npmPackage, customInput);
  if (!resolved.ok) {
    return { success: false, installedVersion: null, error: resolved.error };
  }
  const locked = await mcpMutationGuard.runExclusive({
    mcpId: resolved.entry.mcpId,
    instanceId: resolveMcpInstanceId(resolved.entry, customInput?.instanceId, customInput?.workspaceScope),
    npmPackage,
    kind: "install",
  }, async () => installMcpServerCore(npmPackage, version));
  if (!locked.ok) {
    return { success: false, installedVersion: null, error: locked.error };
  }
  return locked.value;
}

/** 在已持有 MCP 互斥锁时写入目标引擎配置，失败直接返回失败态。 */
async function configureMcpServerCore(
  entry: McpServerInfo,
  engine: "claude" | "codex",
  instanceId: string,
  credentialInput?: unknown,
): Promise<{ success: boolean; error: string | null }> {
  let credentials: McpCredentialInput[] = [];
  try {
    credentials = saveMcpCredentialInputs(entry.mcpId, instanceId, credentialInput);
    if (engine === "claude") {
      await configureClaudeMcp(entry, instanceId, credentials);
    } else {
      await configureCodexMcp(entry, instanceId, credentials);
    }
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: sanitizeMcpError(error, credentials) };
  }
}

/** 检查目标引擎已经保存了该 MCP 配置；当前版本不另起 MCP 常驻进程。 */
async function testMcpConnection(
  entry: McpServerInfo,
  engine: "claude" | "codex",
  workspaceScope?: string | null,
  instanceId = buildMcpInstanceId(entry.mcpId, workspaceScope ?? "default"),
  workspacePath?: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const projectConfigured = workspacePath ? await readProjectMcpConfig(workspacePath, workspaceScope) : new Set<string>();
  const configured = engine === "claude"
    ? new Set([...await readClaudeUserMcpConfig(workspaceScope), ...projectConfigured])
    : new Set([
      ...await readCodexUserMcpConfig(workspaceScope),
      ...await readCodexMcpListJson(workspaceScope),
      ...projectConfigured,
    ]);
  const configuredKey = entry.serverName ? resolveMcpEngineServerName(entry.serverName, instanceId) : entry.npmPackage;
  if (!configuredKey || !configured.has(configuredKey) && (!entry.serverName || !configured.has(entry.serverName))) {
    return { ok: false, error: `未在 ${engine === "claude" ? "Claude" : "Codex"} 中发现 MCP 配置` };
  }
  return { ok: true };
}

/** 查找当前 MCP 在受管引擎中的配置，卸载前用于阻止留下悬挂引用。 */
async function findConfiguredMcpEngines(
  entry: McpServerInfo,
  instanceId: string,
  workspaceScope?: string | null,
  workspacePath?: string | null,
): Promise<Array<"claude" | "codex" | "project">> {
  const [claude, codex, project] = await Promise.all([
    readClaudeUserMcpConfig(workspaceScope),
    readCodexUserMcpConfig(workspaceScope),
    workspacePath ? readProjectMcpConfig(workspacePath, workspaceScope) : Promise.resolve(new Set<string>()),
  ]);
  return resolveMcpConfiguredLabels(entry, instanceId, { claude, codex, project });
}

/** 根据已读取的配置名称判断引用当前 MCP 的引擎，供卸载保护与测试共用。 */
export function resolveConfiguredMcpEngineLabels(
  configuredKeys: readonly string[],
  configurations: { claude: Set<string>; codex: Set<string>; project: Set<string> },
): Array<"claude" | "codex" | "project"> {
  const matches = (configured: Set<string>): boolean => configuredKeys.some((key) => configured.has(key));
  return [
    ...(matches(configurations.claude) ? ["claude" as const] : []),
    ...(matches(configurations.codex) ? ["codex" as const] : []),
    ...(matches(configurations.project) ? ["project" as const] : []),
  ];
}

/**
 * 汇总当前 MCP 被哪些引擎/项目引用。
 * 统一按服务名 / 引擎服务名匹配，避免同名 npm 包（不同版本/实例）被误判为已配置。
 */
export function resolveMcpConfiguredLabels(
  entry: Pick<McpServerInfo, "serverName">,
  instanceId: string,
  configurations: { claude: Set<string>; codex: Set<string>; project: Set<string> },
): Array<"claude" | "codex" | "project"> {
  const engineServerName = entry.serverName ? resolveMcpEngineServerName(entry.serverName, instanceId) : null;
  const keys = [entry.serverName, engineServerName].filter((item): item is string => Boolean(item));
  return resolveConfiguredMcpEngineLabels(keys, configurations);
}

/** 按固定阶段完成 MCP 启用，任一阶段失败都返回可追踪的失败结果。 */
export async function enableMcpServer(
  npmPackage: string | null,
  engine: "claude" | "codex",
  version?: string | null,
  customInput?: CustomMcpInstallInput | null,
  operationKind: "enable" | "update" = "enable",
): Promise<McpEnableResponseBody> {
  const operationId = randomUUID();
  const requestedMcpId = String(customInput?.mcpId ?? "").trim();
  const fallbackMcpId = requestedMcpId || `unknown.${npmPackage ?? "server"}`;
  let resolved: Awaited<ReturnType<typeof resolveMcpRegistryEntry>>;
  try {
    resolved = await resolveMcpRegistryEntry(npmPackage, customInput);
  } catch (error) {
    return {
      ok: false,
      operationId,
      mcpId: fallbackMcpId,
      instanceId: resolveMcpInstanceId({ mcpId: fallbackMcpId }, customInput?.instanceId, customInput?.workspaceScope),
      npmPackage,
      engine,
      stage: "resolve_target",
      stages: [{ name: "resolve_target", status: "failed", message: sanitizeMcpError(error) }],
      installedVersion: null,
      enabled: false,
      errorCode: "MCP_REGISTRY_ENTRY_INVALID",
      message: sanitizeMcpError(error),
    };
  }
  if (!resolved.ok) {
    return {
      ok: false,
      operationId,
      mcpId: fallbackMcpId,
      instanceId: resolveMcpInstanceId({ mcpId: fallbackMcpId }, customInput?.instanceId, customInput?.workspaceScope),
      npmPackage,
      engine,
      stage: "resolve_target",
      stages: [
        { name: "resolve_target", status: "failed", message: resolved.error },
        { name: "prepare_install_or_remote_config", status: "pending" },
        { name: "configure_engine", status: "pending" },
        { name: "test_connection", status: "pending" },
      ],
      installedVersion: null,
      enabled: false,
      errorCode: "MCP_REGISTRY_ENTRY_INVALID",
      message: resolved.error,
    };
  }

  const entry = resolved.entry;
  const stages: McpEnableStage[] = [
    { name: "resolve_target", status: "pending" },
    { name: "prepare_install_or_remote_config", status: "pending" },
    { name: "configure_engine", status: "pending" },
    { name: "test_connection", status: "pending" },
  ];
  let currentStage: McpEnableStageName = "resolve_target";
  let installedVersion: string | null = null;
  let credentialConfigured = false;
  const setStage = (name: McpEnableStageName, status: McpEnableStage["status"], message?: string): void => {
    const stage = stages.find((item) => item.name === name);
    if (stage) {
      stage.status = status;
      stage.message = message ?? null;
    }
  };
  const failure = (errorCode: string, message: string): McpEnableResponseBody => ({
    ok: false,
    operationId,
    mcpId: entry.mcpId,
    instanceId: resolveMcpInstanceId(entry, customInput?.instanceId, customInput?.workspaceScope),
    npmPackage,
    engine,
    stage: currentStage,
    stages,
    installedVersion,
    enabled: false,
    errorCode,
    message,
    credentialConfigured,
  });

  const instanceId = resolveMcpInstanceId(entry, customInput?.instanceId, customInput?.workspaceScope);
  const locked = await mcpMutationGuard.runExclusive({ mcpId: entry.mcpId, instanceId, npmPackage, kind: operationKind, engine }, async () => {
    setStage("resolve_target", "running");
    setStage("resolve_target", "succeeded", "目标 Client 已确认");

    currentStage = "prepare_install_or_remote_config";
    setStage(currentStage, "running");
    try {
      const credentials = saveMcpCredentialInputs(entry.mcpId, instanceId, customInput?.credentialInputs);
      credentialConfigured = credentials.length > 0;
    } catch (error) {
      const message = sanitizeMcpError(error);
      setStage(currentStage, "failed", message);
      return failure(message.startsWith("MCP_CREDENTIAL") ? "MCP_CREDENTIAL_SAVE_FAILED" : "MCP_CREDENTIAL_STORE_INVALID", message);
    }
    let installResult: Awaited<ReturnType<typeof prepareMcpInstallCore>>;
    try {
      installResult = await prepareMcpInstallCore(entry, version);
    } catch (error) {
      const message = sanitizeMcpError(error);
      setStage(currentStage, "failed", message);
      return failure("MCP_INSTALL_FAILED", message);
    }
    if (!installResult.success) {
      setStage(currentStage, "failed", installResult.error ?? "MCP 安装失败");
      return failure("MCP_INSTALL_FAILED", installResult.error ?? "MCP 安装失败");
    }
    installedVersion = installResult.installedVersion;
    setStage(currentStage, "succeeded", "本地依赖已准备完成");

    currentStage = "configure_engine";
    setStage(currentStage, "running");
    const configureResult = await configureMcpServerCore(entry, engine, instanceId);
    if (!configureResult.success) {
      setStage(currentStage, "failed", configureResult.error ?? "引擎配置失败");
      return failure("MCP_ENGINE_CONFIGURE_FAILED", configureResult.error ?? "引擎配置失败");
    }
    setStage(currentStage, "succeeded", "引擎配置已写入");

    currentStage = "test_connection";
    setStage(currentStage, "running");
    let testResult: Awaited<ReturnType<typeof testMcpConnection>>;
    try {
      testResult = await testMcpConnection(entry, engine, customInput?.workspaceScope, instanceId, customInput?.workspacePath);
    } catch (error) {
      const message = sanitizeMcpError(error);
      setStage(currentStage, "failed", message);
      return failure("MCP_CONNECTION_TEST_FAILED", message);
    }
    if (!testResult.ok) {
      setStage(currentStage, "failed", testResult.error);
      return failure("MCP_CONNECTION_TEST_FAILED", testResult.error);
    }
    setStage(currentStage, "succeeded", "配置检测通过");
    return {
      ok: true,
      operationId,
      mcpId: entry.mcpId,
      instanceId,
      npmPackage,
      engine,
      stage: null,
      stages,
      installedVersion,
      enabled: true,
      errorCode: null,
      message: operationKind === "update" ? "MCP 已更新并启用" : "MCP 已启用",
      credentialConfigured,
    };
  });
  if (!locked.ok) return failure("MCP_OPERATION_BUSY", locked.error);
  return locked.value;
}

/** 更新指定 MCP 的本地依赖并重新写入引擎配置，复用启用流程的阶段和失败语义。 */
export async function updateMcpServer(
  npmPackage: string | null,
  engine: "claude" | "codex",
  version?: string | null,
  customInput?: CustomMcpInstallInput | null,
): Promise<McpEnableResponseBody> {
  return await enableMcpServer(npmPackage, engine, version, customInput, "update");
}

/** 测试引擎配置是否存在；当前版本不另起 MCP 常驻进程或执行握手。 */
export async function testMcpServer(
  npmPackage: string | null,
  engine: "claude" | "codex",
  customInput?: CustomMcpInstallInput | null,
): Promise<McpTestResponseBody> {
  const requestedMcpId = String(customInput?.mcpId ?? "").trim();
  let resolved: Awaited<ReturnType<typeof resolveMcpRegistryEntry>>;
  try {
    resolved = await resolveMcpRegistryEntry(npmPackage, customInput, { allowCreateCustom: false });
  } catch (error) {
    const mcpId = requestedMcpId || `unknown.${npmPackage ?? "server"}`;
    return {
      ok: false,
      mcpId,
      instanceId: resolveMcpInstanceId({ mcpId }, customInput?.instanceId, customInput?.workspaceScope),
      engine,
      errorCode: "MCP_REGISTRY_ENTRY_INVALID",
      message: sanitizeMcpError(error),
    };
  }
  const mcpId = resolved.ok ? resolved.entry.mcpId : requestedMcpId || `unknown.${npmPackage ?? "server"}`;
  const instanceId = resolveMcpInstanceId({ mcpId }, customInput?.instanceId, customInput?.workspaceScope);
  if (!resolved.ok) {
    return { ok: false, mcpId, instanceId, engine, errorCode: "MCP_REGISTRY_ENTRY_INVALID", message: resolved.error };
  }
  const locked = await mcpMutationGuard.runExclusive({
    mcpId: resolved.entry.mcpId,
    instanceId,
    npmPackage,
    kind: "test",
    engine,
  }, async () => {
    try {
      const result = await testMcpConnection(resolved.entry, engine, customInput?.workspaceScope, instanceId, customInput?.workspacePath);
      return result.ok
        ? { ok: true, mcpId, instanceId, engine, errorCode: null, message: "MCP 配置检测通过" }
        : { ok: false, mcpId, instanceId, engine, errorCode: "MCP_CONNECTION_TEST_FAILED", message: result.error };
    } catch (error) {
      return { ok: false, mcpId, instanceId, engine, errorCode: "MCP_CONNECTION_TEST_FAILED", message: sanitizeMcpError(error) };
    }
  });
  if (!locked.ok) return { ok: false, mcpId, instanceId, engine, errorCode: "MCP_OPERATION_BUSY", message: locked.error };
  return locked.value;
}

/** 按安装方式准备 MCP；远程服务只需保存连接配置，不执行本机安装。 */
async function prepareMcpInstallCore(
  entry: McpServerInfo,
  version?: string | null,
): Promise<{ success: boolean; installedVersion: string | null; error: string | null }> {
  if (entry.installType === "http" || entry.installType === "sse") {
    return entry.url ? { success: true, installedVersion: null, error: null } : { success: false, installedVersion: null, error: "远程 MCP 缺少服务地址" };
  }
  if (entry.installType === "local-command") {
    return entry.command && entry.serverName
      ? { success: true, installedVersion: null, error: null }
      : { success: false, installedVersion: null, error: "本地命令 MCP 缺少 command 或 serverName" };
  }
  if (entry.installType === "pypi") {
    if (!entry.pythonPackage || !entry.runner || !entry.serverName) {
      return { success: false, installedVersion: null, error: "PyPI MCP 缺少 package、runner 或 serverName" };
    }
    if (entry.runner === "uvx") return { success: true, installedVersion: version ?? null, error: null };
    const target = version ? `${entry.pythonPackage}==${version}` : entry.pythonPackage;
    const result = await runMcpCli({ command: entry.runner, args: ["-m", "pip", "install", target], timeoutMs: 120_000 });
    if (!result.ok) return { success: false, installedVersion: null, error: result.error ?? "PyPI 安装失败" };
    const installedVersion = await readPypiPackageVersion(entry.runner, entry.pythonPackage);
    return installedVersion
      ? { success: true, installedVersion, error: null }
      : { success: false, installedVersion: null, error: "PyPI 安装完成但未能确认安装版本" };
  }
  if (!entry.npmPackage) return { success: false, installedVersion: null, error: "NPM MCP 缺少 npmPackage" };
  if (!version) {
    const currentVersion = await readInstalledNpmVersion(entry.npmPackage);
    if (currentVersion) return { success: true, installedVersion: currentVersion, error: null };
  }
  return installMcpServerCore(entry.npmPackage, version);
}

/** 读取当前 Client 的 PyPI 包版本，用于状态展示和安装结果确认。 */
async function readPypiPackageVersion(runner: string, packageName: string): Promise<string | null> {
  const result = await runMcpCli({ command: runner, args: ["-m", "pip", "show", packageName], timeoutMs: 15_000 });
  return result.ok ? result.stdout.match(/^Version:\s*(.+)$/mi)?.[1]?.trim() || null : null;
}

/** 读取全局 NPM 包版本，启用时无版本要求则复用已确认的安装结果。 */
async function readInstalledNpmVersion(npmPackage: string): Promise<string | null> {
  const result = await runMcpCli({ command: "npm", args: ["ls", "-g", npmPackage, "--depth=0", "--json"], timeoutMs: 10_000 });
  if (!result.ok || !result.stdout) return null;
  try {
    const json = JSON.parse(result.stdout);
    return json?.dependencies?.[npmPackage]?.version ?? null;
  } catch (error) {
    throw new Error(`读取 NPM 已安装版本失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 在已持有 MCP 互斥锁时执行 npm 安装，供单步安装和一键启用共同复用。 */
async function installMcpServerCore(
  npmPackage: string,
  version?: string | null,
): Promise<{ success: boolean; installedVersion: string | null; error: string | null }> {
  const target = version ? `${npmPackage}@${version}` : npmPackage;
  const result = await runMcpCli({
    command: "npm",
    args: ["install", "-g", target],
    timeoutMs: 120_000,
  });
  if (!result.ok) return { success: false, installedVersion: null, error: result.error ?? "npm install 失败" };

  const lsResult = await runMcpCli({
    command: "npm",
    args: ["ls", "-g", npmPackage, "--depth=0", "--json"],
    timeoutMs: 10_000,
  });
  let installedVersion: string | null = null;
  if (lsResult.ok && lsResult.stdout) {
    try {
      const json = JSON.parse(lsResult.stdout);
      installedVersion = json?.dependencies?.[npmPackage]?.version ?? null;
    } catch (error) {
      return { success: false, installedVersion: null, error: `读取安装版本失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!installedVersion) return { success: false, installedVersion: null, error: "npm 安装完成但未能确认安装版本" };
  return { success: true, installedVersion, error: null };
}

/**
 * 全局卸载指定 MCP Server npm 包，已被引擎引用时显式拒绝卸载。
 * 若是自定义包，会先校验本地注册信息是否存在。
 */
export async function uninstallMcpServer(
  npmPackage: string | null,
  customInput?: CustomMcpInstallInput | null,
): Promise<{ success: boolean; error: string | null; errorCode?: "MCP_UNINSTALL_BLOCKED_BY_ENGINE_CONFIG" | null }> {
  const resolved = await resolveMcpRegistryEntry(npmPackage, customInput);
  if (!resolved.ok) return { success: false, error: resolved.error };
  const locked = await mcpMutationGuard.runExclusive({
    mcpId: resolved.entry.mcpId,
    instanceId: resolveMcpInstanceId(resolved.entry, customInput?.instanceId, customInput?.workspaceScope),
    npmPackage,
    kind: "uninstall",
  }, async () => {
    try {
      const instanceId = resolveMcpInstanceId(resolved.entry, customInput?.instanceId, customInput?.workspaceScope);
      const configuredEngines = await findConfiguredMcpEngines(
        resolved.entry,
        instanceId,
        customInput?.workspaceScope,
        customInput?.workspacePath,
      );
      // 项目 .mcp.json 是版本化文件，不自动改写，仍要求先手动移除。
      if (configuredEngines.includes("project")) {
        return {
          success: false,
          error: "该 MCP 仍在项目 .mcp.json 中配置，请先从项目配置移除后再卸载",
          errorCode: "MCP_UNINSTALL_BLOCKED_BY_ENGINE_CONFIG" as const,
        };
      }
      // 卸载前自动移除 Claude/Codex 用户级接入，避免残留孤儿配置。
      if (configuredEngines.includes("claude") || configuredEngines.includes("codex")) {
        if (!resolved.entry.serverName) {
          return { success: false, error: "MCP 缺少 serverName，无法移除引擎配置", errorCode: null };
        }
        const engineServerName = resolveMcpEngineServerName(resolved.entry.serverName, instanceId);
        if (configuredEngines.includes("claude")) await unconfigureClaudeMcp(engineServerName);
        if (configuredEngines.includes("codex")) await unconfigureCodexMcp(engineServerName);
      }
    } catch (error) {
      return {
        success: false,
        error: `自动移除引擎配置失败，已取消卸载：${sanitizeMcpError(error)}`,
        errorCode: null,
      };
    }
    // 仅 npm 类型存在全局依赖需要卸载；本地命令/PyPI/HTTP/SSE 直接删除注册条目。
    if (npmPackage) {
      const result = await runMcpCli({
        command: "npm",
        args: ["uninstall", "-g", npmPackage],
        timeoutMs: 60_000,
      });

      if (!result.ok) {
        return { success: false, error: result.error ?? "npm uninstall 失败", errorCode: null };
      }
    }
    // 自定义/导入条目从注册表移除；内置条目保留在目录中，仅卸载依赖。
    if (resolved.entry.source !== "builtin") {
      await removeCustomMcpServer(resolved.entry);
    }

    return { success: true, error: null, errorCode: null };
  });
  if (!locked.ok) {
    return { success: false, error: locked.error, errorCode: null };
  }
  return locked.value;
}

