import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeWorkspaceIdFromPathDigest, normalizeWorkspacePathForDerivedId, type WorkspaceId } from "@codeflowai/shared";

import type { TurnTimeoutPolicy } from "./engines/threadSession.js";
import { normalizeWorkspacePathIndexMaxEntries } from "./fs/workspacePathIndexConfig.js";

function readFirstEnv(keys: string[]): string {
  for (const key of keys) {
    const value = String(process.env[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function resolveAppHomeDir(): string {
  return path.join(os.homedir(), ".codeflowai");
}

const BUILT_DEFAULT_SERVER_WS = String(process.env.CODEFLOWAI_BUILD_DEFAULT_SERVER_WS ?? "").trim();
const CLIENT_ID_META_KEY = "client_id";
const CLIENT_API_KEY_TOKEN_PATTERN = /(?<![A-Za-z0-9])codeflowai_[A-Za-z0-9]{16,128}(?![A-Za-z0-9])/g;

type ClientConfigFile = {
  apiKey?: string;
  serverWs?: string;
  clientId?: string;
};

/** 解析 Client 配置路径；开发实例可通过环境变量与安装实例隔离。 */
function resolveConfigPath(): string {
  const explicitPath = String(process.env.CODEFLOWAI_CLIENT_CONFIG_PATH ?? "").trim();
  return explicitPath || path.join(resolveAppHomeDir(), "config.json");
}

/** 桌面配置字段类型错误显式失败，避免把损坏身份当作首次安装重建。 */
function loadConfigFile(desktop = false): ClientConfigFile {
  const data = loadRawConfigFile();
  if (desktop) {
    for (const key of ["apiKey", "serverWs", "clientId"] as const) {
      if (data[key] !== undefined && typeof data[key] !== "string") throw new Error(`DESKTOP_CONFIG_INVALID: ${key}`);
    }
  }
  return {
    apiKey: typeof data.apiKey === "string" ? data.apiKey : undefined,
    serverWs: typeof data.serverWs === "string" ? data.serverWs : undefined,
    clientId: typeof data.clientId === "string" ? data.clientId : undefined,
  };
}

/** 读取 config.json 原始对象，用于保存时保留未知字段。 */
function loadRawConfigFile(): Record<string, unknown> {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8");
  const data = JSON.parse(raw);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Invalid client config file: ${configPath}`);
  }
  return data as Record<string, unknown>;
}

/** 保存稳定 Client ID；仅显式桌面隔离目录允许尚未关联云端 Key。 */
export function saveConfigFile(data: { apiKey: string; serverWs: string; clientId: string }, options?: { desktop?: boolean }): void {
  if (options?.desktop) resolveDesktopStoragePaths();
  const apiKey = normalizeClientApiKeyInput(data.apiKey, "apiKey");
  if (!apiKey && !options?.desktop) throw new Error("Client config apiKey 不能为空");
  const configPath = resolveConfigPath();
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  const existing = loadRawConfigFile();
  const payload = {
    ...existing,
    apiKey,
    serverWs: data.serverWs,
    clientId: data.clientId,
  };
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf8");
}

/** 维护只读已存在配置并核稳定身份，不采纳环境变量或创建替代文件。 */
export function readDesktopConfigForMaintenance(configPath: string, clientId: string): Record<string, unknown> {
  const data: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('DESKTOP_CONFIG_INVALID');
  const config = data as Record<string, unknown>;
  for (const key of ['apiKey', 'serverWs', 'clientId']) {
    if (config[key] !== undefined && typeof config[key] !== 'string') throw new Error(`DESKTOP_CONFIG_INVALID: ${key}`);
  }
  if (!clientId.trim() || config.clientId !== clientId) throw new Error('DESKTOP_CONFIG_CLIENT_ID_MISMATCH');
  return config;
}

/** 卸载仅原子清云端 Key，保稳定身份和其余原始字段；写入失败显式保因。 */
export function clearDesktopConfigApiKey(input: { configPath: string; clientId: string }): void {
  const config = readDesktopConfigForMaintenance(input.configPath, input.clientId);
  const temporary = `${input.configPath}.${crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    let writeError: unknown, writeFailed = false;
    try { fs.writeFileSync(fd, JSON.stringify({ ...config, apiKey: '' }, null, 2), 'utf8'); fs.fsyncSync(fd); }
    catch (error) { writeFailed = true; writeError = error; throw error; }
    finally {
      try { fs.closeSync(fd); }
      catch (error) { throw writeFailed ? new AggregateError([writeError, error], 'DESKTOP_CONFIG_WRITE_CLOSE_FAILED', { cause: writeError }) : error; }
    }
    fs.renameSync(temporary, input.configPath);
    created = false;
  } catch (error) {
    if (created) {
      try { fs.unlinkSync(temporary); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'DESKTOP_CONFIG_CLEANUP_FAILED', { cause: error }); }
    }
    throw error;
  }
}

export type ClientIdSource = "env" | "config" | "db-meta" | "hostname";

export type ClientConfig = {
  serverWsUrl: string;
  apiKey: string;
  apiKeySource: "cli" | "env" | "config";
  clientId: string;
  /** clientId 来源；env 覆盖仅允许用于显式隔离的调试场景。 */
  clientIdSource: ClientIdSource;
  /** 是否允许在默认 DB 上显式使用 CODEFLOWAI_CLIENT_ID。 */
  allowClientIdOverride: boolean;
  /** workspace 列表（workspaceId→path）。 */
  workspaces: Array<{ id: WorkspaceId; path: string; label?: string }>;
  /** 引擎超时策略。 */
  timeoutPolicy: TurnTimeoutPolicy;
  /** 无 active turn 的本地引擎 session 回收策略。 */
  sessionIdleCleanup: {
    enabled: boolean;
    idleMs: number;
    scanMs: number;
  };
  /** 工作区文件路径索引资源保护和全局排除配置。 */
  workspacePathIndex: {
    maxEntries: number;
    excludeDirNames: string[];
    excludePathPrefixes: string[];
  };
};

/** 读取统一配置；显式桌面模式允许未登录，普通 Client 仍要求云端 Key。 */
export function readClientConfig(options?: { apiKeyOverride?: unknown; desktop?: boolean }): ClientConfig {
  if (options?.desktop) resolveDesktopStoragePaths();
  const configFile = loadConfigFile(options?.desktop);

  const hasApiKeyOverride = Boolean(options && Object.prototype.hasOwnProperty.call(options, "apiKeyOverride"));
  const apiKeyFromCli = hasApiKeyOverride
    ? normalizeClientApiKeyInput(options?.apiKeyOverride, "--key")
    : "";
  if (hasApiKeyOverride && !apiKeyFromCli) {
    throw new Error("--key 不能为空");
  }
  const apiKeyFromEnv = hasApiKeyOverride
    ? ""
    : normalizeClientApiKeyInput(readFirstEnv(["CODEFLOWAI_API_KEY"]), "CODEFLOWAI_API_KEY");
  const apiKeyFromConfig = apiKeyFromCli || apiKeyFromEnv
    ? ""
    : normalizeClientApiKeyInput(configFile.apiKey ?? "", "config.json apiKey");
  const apiKey = apiKeyFromCli || apiKeyFromEnv || apiKeyFromConfig;
  const apiKeySource: ClientConfig["apiKeySource"] = apiKeyFromCli ? "cli" : apiKeyFromEnv ? "env" : "config";
  if (!apiKey && !options?.desktop) {
    throw new Error("未配置 API Key。首次启动请使用 --key <value> 或设置环境变量 CODEFLOWAI_API_KEY，连接成功后会自动记住。");
  }
  const serverWsUrl = readClientServerWsUrl(configFile);
  const clientIdFromEnv = readFirstEnv(["CODEFLOWAI_CLIENT_ID"]);
  const clientIdFromConfig = String(configFile.clientId ?? "").trim();
  const clientIdFromDbMeta = clientIdFromEnv || clientIdFromConfig ? "" : readClientIdFromPlainDbMeta(resolveClientDbPathForConfig());
  const clientId = clientIdFromEnv || clientIdFromConfig || clientIdFromDbMeta || (options?.desktop ? `local_${crypto.randomUUID()}` : os.hostname());
  let clientIdSource: ClientConfig["clientIdSource"] = clientIdFromEnv
    ? "env"
    : clientIdFromConfig
      ? "config"
      : clientIdFromDbMeta
        ? "db-meta"
        : "hostname";
  const allowClientIdOverride = readBooleanEnv("CODEFLOWAI_ALLOW_CLIENT_ID_OVERRIDE");

  const timeoutPolicy = readTimeoutPolicyFromEnv();
  const sessionIdleCleanup = readSessionIdleCleanupFromEnv();
  const workspacePathIndex = readWorkspacePathIndexConfigFromEnv();

  const workspaces = readWorkspaces(options?.desktop);

  if (options?.desktop && !clientIdFromEnv && !clientIdFromConfig) {
    saveConfigFile({ apiKey, serverWs: serverWsUrl, clientId }, { desktop: true });
    clientIdSource = "config";
  }

  return {
    serverWsUrl,
    apiKey,
    apiKeySource,
    clientId,
    clientIdSource,
    allowClientIdOverride,
    workspaces,
    timeoutPolicy,
    sessionIdleCleanup,
    workspacePathIndex,
  };
}

/** 桌面只使用壳显式提供的同目录路径，禁止落回已安装 Client 的默认目录。 */
export function resolveDesktopStoragePaths(): { configPath: string; dbPath: string } {
  const configPath = String(process.env.CODEFLOWAI_CLIENT_CONFIG_PATH ?? "").trim();
  const dbPath = String(process.env.CODEFLOWAI_CLIENT_DB_PATH ?? "").trim();
  if (!path.isAbsolute(configPath) || !path.isAbsolute(dbPath)
    || path.dirname(path.resolve(configPath)) !== path.dirname(path.resolve(dbPath))
    || path.resolve(configPath) === path.resolve(dbPath)
    || path.resolve(dbPath) === path.resolve(resolveAppHomeDir(), "codeflowai.db")) {
    throw new Error("DESKTOP_STORAGE_PATH_REQUIRED: desktop config and database must use an explicit isolated directory");
  }
  return { configPath: path.resolve(configPath), dbPath: path.resolve(dbPath) };
}

/** 只解析 Server WS 地址，供不需要 API Key 的 CLI 子命令复用。 */
export function readClientServerWsUrl(configFile = loadConfigFile()): string {
  return readFirstEnv(["CODEFLOWAI_SERVER_WS"])
    || String(configFile.serverWs ?? "").trim()
    || BUILT_DEFAULT_SERVER_WS
    || "ws://127.0.0.1:39280/ws/client";
}

/** 规整用户输入的 Client Key；支持从误粘贴的启动命令中提取真实 `codeflowai_` key。 */
export function normalizeClientApiKeyInput(value: unknown, label = "Client Key"): string {
  const raw = stripWrappingQuotes(String(value ?? "").replace(/^\uFEFF/u, "").trim());
  if (!raw) return "";

  const matchedKeys = Array.from(new Set(Array.from(raw.matchAll(CLIENT_API_KEY_TOKEN_PATTERN), (match) => match[0])));
  const normalized = stripWrappingQuotes(raw);
  const looksLikeCommand = looksLikePastedClientStartCommand(normalized);
  if (matchedKeys.length === 1) {
    if (normalized === matchedKeys[0] || looksLikeCommand) return matchedKeys[0];
    throw new Error(`${label} 格式不正确：请只填写 codeflowai_ 开头的 Client Key，不要混入其他文本`);
  }
  if (matchedKeys.length > 1) {
    throw new Error(`${label} 输入包含多个 Client Key，请只保留一个`);
  }

  if (looksLikeCommand) {
    throw new Error(`${label} 格式不正确：请只填写 codeflowai_ 开头的 Client Key，不要粘贴完整启动命令`);
  }
  if (/codeflowai_/i.test(normalized)) {
    throw new Error(`${label} 格式不正确：Client Key 应为 codeflowai_ 加 16-128 位字母数字`);
  }
  return normalized;
}

/** 去掉常见成对包裹引号，避免把引号持久化到配置。 */
function stripWrappingQuotes(value: string): string {
  let text = value.trim();
  while (
    text.length >= 2 &&
    ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** 判断用户是否误填了启动命令而不是 key；命中时显式失败。 */
function looksLikePastedClientStartCommand(value: string): boolean {
  return /(?:^|\s)(?:\$env:)?CODEFLOWAI_API_KEY\s*=|(?:^|\s)set\s+["']?CODEFLOWAI_API_KEY=|(?:^|\s)export\s+CODEFLOWAI_API_KEY=|[;\r\n]|\bcodeflow\b/i.test(value);
}

/** 读取显式工作区配置；桌面不隐式导入已安装 Client 的旧工作区文件。 */
function readWorkspaces(desktop = false): Array<{ id: WorkspaceId; path: string; label?: string }> {
  const json = readFirstEnv(["CODEFLOWAI_WORKSPACES_JSON"]);
  if (json) return normalizeWorkspaces(safeJson(json));

  const fileFromEnv = readFirstEnv(["CODEFLOWAI_WORKSPACES_FILE"]);
  const defaultFile = path.join(resolveAppHomeDir(), "workspaces.json");
  const file = fileFromEnv || (!desktop && fs.existsSync(defaultFile) ? defaultFile : "");
  if (file) {
    const raw = fs.readFileSync(file, "utf8");
    return normalizeWorkspaces(safeJson(raw));
  }

  // 单 workspace 兜底
  const workspacePath = readFirstEnv(["CODEFLOWAI_WORKSPACE_PATH"]);
  if (workspacePath) {
    const workspaceId = (readFirstEnv(["CODEFLOWAI_WORKSPACE_ID"]) || deriveWorkspaceIdFromPath(workspacePath)) as WorkspaceId;
    return normalizeWorkspaces([{ id: workspaceId, path: workspacePath }]);
  }

  return [];
}

/** 按 Server 创建工作区的路径哈希口径派生单工作区 ID。 */
function deriveWorkspaceIdFromPath(workspacePath: string): WorkspaceId {
  const normalizedPath = normalizeWorkspacePathForDerivedId(workspacePath);
  if (!normalizedPath) throw new Error("CODEFLOWAI_WORKSPACE_PATH 不能为空");
  const digest = crypto.createHash("sha256").update(normalizedPath).digest("hex");
  return makeWorkspaceIdFromPathDigest(digest) as WorkspaceId;
}

/** 解析默认 Client DB 路径，供旧配置迁移读取已绑定 clientId。 */
function resolveClientDbPathForConfig(): string {
  const fromEnv = String(process.env.CODEFLOWAI_CLIENT_DB_PATH ?? "").trim();
  if (fromEnv) return fromEnv;
  return path.join(resolveAppHomeDir(), "codeflowai.db");
}

/** 只读明文 SQLite 的历史 clientId；非明文库交给后续存储边界处理。 */
function readClientIdFromPlainDbMeta(dbPath: string): string {
  if (!dbPath || !fs.existsSync(dbPath) || !hasPlainSqliteHeader(dbPath)) return "";
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get() as { name?: string | null } | undefined;
    if (!table?.name) return "";
    const row = db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(CLIENT_ID_META_KEY) as { value?: string | null } | undefined;
    return String(row?.value ?? "").trim();
  } finally {
    db.close();
  }
}

/** 校验普通 SQLite 文件头，其他格式不进入配置读取。 */
function hasPlainSqliteHeader(dbPath: string): boolean {
  const sqliteHeader = Buffer.from("SQLite format 3\0", "utf8");
  const fd = fs.openSync(dbPath, "r");
  try {
    const header = Buffer.alloc(sqliteHeader.length);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    return read === sqliteHeader.length && header.equals(sqliteHeader);
  } finally {
    fs.closeSync(fd);
  }
}

/** 规范化工作区列表；未显式给出 id 时按路径派生，与 CODEFLOWAI_WORKSPACE_PATH 保持同一口径。 */
function normalizeWorkspaces(input: unknown): Array<{ id: WorkspaceId; path: string; label?: string }> {
  if (!Array.isArray(input)) throw new Error("Invalid workspaces: expected array");
  const out: Array<{ id: WorkspaceId; path: string; label?: string }> = [];
  for (const item of input) {
    const p = String((item as any)?.path ?? "").trim();
    if (!p) continue;
    const id = String((item as any)?.id ?? "").trim() || deriveWorkspaceIdFromPath(p);
    const label = String((item as any)?.label ?? "").trim();
    out.push({ id: id as WorkspaceId, path: p, label: label || undefined });
  }
  return out;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in workspaces config");
  }
}

/** 读取布尔环境变量，只有常见真值才视为开启。 */
function readBooleanEnv(key: string): boolean {
  const value = String(process.env[key] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** 解析 int 环境变量（带默认值与范围）。 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function readTimeoutPolicyFromEnv(): TurnTimeoutPolicy {
  const modeRaw = readFirstEnv(["CODEFLOWAI_TIMEOUT_MODE"]).toLowerCase();
  const startupTimeoutMs = clampInt(readFirstEnv(["CODEFLOWAI_STARTUP_TIMEOUT_MS"]), 90_000, 5_000, 24 * 60 * 60_000);

  if (modeRaw === "legacy-turn") {
    return {
      mode: "legacy-turn",
      timeoutMs: clampInt(readFirstEnv(["CODEFLOWAI_TURN_TIMEOUT_MS"]), 15 * 60_000, 10_000, 24 * 60 * 60_000),
      startupTimeoutMs,
    };
  }

  return {
    mode: "activity",
    startupTimeoutMs,
    engineIdleTimeoutMs: clampInt(readFirstEnv(["CODEFLOWAI_ENGINE_IDLE_TIMEOUT_MS"]), 10 * 60_000, 10_000, 24 * 60 * 60_000),
  };
}

/** 读取本地引擎 session idle 回收策略。 */
function readSessionIdleCleanupFromEnv(): ClientConfig["sessionIdleCleanup"] {
  const disabledRaw = readFirstEnv(["CODEFLOWAI_SESSION_IDLE_CLEANUP_DISABLED"]).toLowerCase();
  const disabled = disabledRaw === "1" || disabledRaw === "true" || disabledRaw === "yes";
  return {
    enabled: !disabled,
    idleMs: clampInt(readFirstEnv(["CODEFLOWAI_SESSION_IDLE_DISPOSE_MS"]), 30 * 60_000, 60_000, 24 * 60 * 60_000),
    scanMs: clampInt(readFirstEnv(["CODEFLOWAI_SESSION_IDLE_SCAN_MS"]), 5 * 60_000, 10_000, 60 * 60_000),
  };
}

/** 读取工作区文件索引配置；只做资源上限和全局排除，不承载 workspace 个性化规则。 */
function readWorkspacePathIndexConfigFromEnv(): ClientConfig["workspacePathIndex"] {
  return {
    maxEntries: normalizeWorkspacePathIndexMaxEntries(readFirstEnv(["CODEFLOWAI_WORKSPACE_PATH_INDEX_MAX_ENTRIES", "CODEFLOWAI_FILE_INDEX_MAX_ENTRIES"])),
    excludeDirNames: readListEnv(["CODEFLOWAI_WORKSPACE_PATH_INDEX_EXCLUDE_DIRS", "CODEFLOWAI_FILE_INDEX_EXCLUDE_DIRS"]),
    excludePathPrefixes: readListEnv(["CODEFLOWAI_WORKSPACE_PATH_INDEX_EXCLUDE_PATHS", "CODEFLOWAI_FILE_INDEX_EXCLUDE_PATHS"]),
  };
}

/** 读取逗号、分号或换行分隔的环境变量列表。 */
function readListEnv(keys: string[]): string[] {
  const raw = readFirstEnv(keys);
  if (!raw) return [];
  return Array.from(new Set(raw.split(/[,;\r\n]+/g).map((item) => item.trim()).filter(Boolean)));
}
