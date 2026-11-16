import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

import type { EngineCredentialSource } from "@codeflowai/shared";

export type EngineCredentialConfig = {
  apiKey?: string | null;
  baseUrl?: string | null;
  credentialIdentity?: { keyId: string; serverOrigin: string; ownerUserId: string; accountSessionId: string; generation: number };
};

export type NativeEngineAuthState = {
  available: boolean;
  source: Extract<EngineCredentialSource, "local_oauth" | "local_api_key" | "none">;
  issue: string | null;
};

export type CodexNativeAuthState = NativeEngineAuthState;
export type ClaudeNativeAuthState = NativeEngineAuthState;

const CLAUDE_CONFIG_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_CONFIG_TOML_PATH = path.join(os.homedir(), ".codex", "config.toml");
const CODEX_NATIVE_CONFIG_BACKUP_ROOT = path.join(os.homedir(), ".codex", "codeflow-backups");
/** Codex 原生配置历史快照最多保留的版本数。 */
export const CODEX_NATIVE_CONFIG_BACKUP_LIMIT = 5;
const CODEX_NATIVE_CONFIG_BACKUP_PREFIX = "snapshot-";
const CODEX_NATIVE_CONFIG_BACKUP_DIR_PATTERN = /^snapshot-\d{8}T\d{6}\.\d{3}Z-[0-9a-f-]{36}$/i;
/** Codex 原生 auth.json 的 API Key 字段；与进程环境变量完全无关。 */
const CODEX_NATIVE_AUTH_API_KEY_FIELD = "OPENAI_API_KEY";

const NATIVE_AUTH_NONE: NativeEngineAuthState = { available: false, source: "none", issue: null };

// ---------------------------------------------------------------------------
// 共享工具函数
// ---------------------------------------------------------------------------

/** 安全读取 JSON 文件，失败返回 {} */
function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 文件不存在或解析失败
  }
  return {};
}

/** 确保目录存在，写唯一临时文件后 rename（atomic write）。 */
function atomicWriteJson(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = createAtomicTempPath(filePath);
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/** 确保目录存在，写唯一临时文件后 rename（atomic write，文本内容）。 */
function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = createAtomicTempPath(filePath);
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
}

/** 生成不会被并发写入者复用的临时文件名。 */
function createAtomicTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export type CodexNativeConfigBackupOptions = {
  /** 覆盖默认 auth.json 路径，供隔离测试使用。 */
  authPath?: string;
  /** 覆盖默认 config.toml 路径，供隔离测试使用。 */
  configPath?: string;
  /** 覆盖默认历史快照目录，供隔离测试使用。 */
  backupRoot?: string;
  /** 覆盖快照时间，供隔离测试使用。 */
  now?: Date;
};

/** 在原生配置写入前创建成对的时间戳快照，并只保留最近五份。 */
export function backupCodexNativeConfigFiles(options: CodexNativeConfigBackupOptions = {}): string {
  const authPath = options.authPath ?? CODEX_AUTH_PATH;
  const configPath = options.configPath ?? CODEX_CONFIG_TOML_PATH;
  const backupRoot = options.backupRoot ?? CODEX_NATIVE_CONFIG_BACKUP_ROOT;
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("创建 Codex 配置备份失败：时间无效");

  const timestamp = now.toISOString().replace(/[-:]/g, "");
  const snapshotName = `${CODEX_NATIVE_CONFIG_BACKUP_PREFIX}${timestamp}-${randomUUID()}`;
  const resolvedRoot = path.resolve(backupRoot);
  const finalPath = path.join(resolvedRoot, snapshotName);
  const stagingPath = path.join(resolvedRoot, `.${snapshotName}.tmp`);
  const authExists = isRegularFileForBackup(authPath);
  const configExists = isRegularFileForBackup(configPath);

  fs.mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(stagingPath, { mode: 0o700 });
    if (authExists) copyCodexBackupFile(authPath, path.join(stagingPath, "auth.json"));
    if (configExists) copyCodexBackupFile(configPath, path.join(stagingPath, "config.toml"));
    fs.writeFileSync(
      path.join(stagingPath, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: now.toISOString(),
        files: { authJson: authExists, configToml: configExists },
      }, null, 2) + "\n",
      { encoding: "utf-8", flag: "wx", mode: 0o600 },
    );
    fs.renameSync(stagingPath, finalPath);
    pruneCodexNativeConfigBackups(resolvedRoot);
    return finalPath;
  } catch (cause) {
    try {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    } catch (cleanupCause) {
      throw new AggregateError([cause, cleanupCause], "创建 Codex 配置备份失败，且临时目录清理失败", { cause });
    }
    throw cause;
  }
}

/** 只接受普通文件；文件不存在时由 manifest 记录为缺失。 */
function isRegularFileForBackup(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    throw new Error(`读取待备份的 Codex 文件失败：${filePath}`, { cause });
  }
}

/** 复制单个原生配置文件，并把源路径附在可追踪错误中。 */
function copyCodexBackupFile(sourcePath: string, targetPath: string): void {
  try {
    fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  } catch (cause) {
    throw new Error(`备份 Codex 文件失败：${sourcePath}`, { cause });
  }
}

/** 清理超出保留上限的历史快照；仅删除本模块生成的严格命名目录。 */
function pruneCodexNativeConfigBackups(backupRoot: string): void {
  const resolvedRoot = path.resolve(backupRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw new Error(`读取 Codex 配置备份目录失败：${resolvedRoot}`, { cause });
  }

  const snapshots = entries
    .filter((entry) => entry.isDirectory() && CODEX_NATIVE_CONFIG_BACKUP_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const snapshotName of snapshots.slice(CODEX_NATIVE_CONFIG_BACKUP_LIMIT)) {
    const target = path.resolve(resolvedRoot, snapshotName);
    const relative = path.relative(resolvedRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`拒绝清理越界的 Codex 配置备份：${target}`);
    }
    fs.rmSync(target, { recursive: true, force: false });
  }
}

/** 读取文本；仅文件不存在视为空配置，其它读取错误必须显式失败。 */
function readTextFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | null)?.code === "ENOENT") return "";
    throw new Error(`读取 Codex 配置失败：${filePath}`, { cause });
  }
}

/** 从对象取 string 值，否则返回 null */
function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v !== "" ? v : null;
}

/** 读取本机 Codex 原生认证状态；只返回来源和错误摘要，不暴露令牌值。 */
export function readCodexNativeAuthState(): CodexNativeAuthState {
  if (!fs.existsSync(CODEX_AUTH_PATH)) return NATIVE_AUTH_NONE;
  try {
    return readCodexNativeAuthStateFromText(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
  } catch (error) {
    return {
      available: false,
      source: "none",
      issue: error instanceof Error ? `读取 auth.json 失败：${error.message}` : "读取 auth.json 失败",
    };
  }
}

/** 从 auth.json 文本解析 Codex 原生认证状态，供运行态和单测共用。 */
export function readCodexNativeAuthStateFromText(content: string): CodexNativeAuthState {
  if (!content.trim()) return NATIVE_AUTH_NONE;
  try {
    return readCodexNativeAuthStateFromData(JSON.parse(content));
  } catch {
    return { available: false, source: "none", issue: "auth.json 不是有效 JSON" };
  }
}

/** 从已解析对象判断 Codex 原生认证是否可用。 */
export function readCodexNativeAuthStateFromData(input: unknown): CodexNativeAuthState {
  if (!isPlainRecord(input)) {
    return { available: false, source: "none", issue: "auth.json 顶层不是对象" };
  }
  const authMode = readStringValue(input, "auth_mode")?.toLowerCase() ?? null;
  const apiKey = readStringValue(input, CODEX_NATIVE_AUTH_API_KEY_FIELD) ?? readStringValue(input, "apiKey");
  const refreshToken = readCodexOauthRefreshToken(input);
  if (authMode === "chatgpt") {
    if (refreshToken) return { available: true, source: "local_oauth", issue: null };
    return { available: false, source: "none", issue: "本机 Codex OAuth 缺少 refresh_token" };
  }
  if (apiKey) {
    return { available: true, source: "local_api_key", issue: null };
  }
  if (refreshToken) {
    return { available: true, source: "local_oauth", issue: null };
  }
  return NATIVE_AUTH_NONE;
}

/** 读取 Codex OAuth refresh token，兼容历史 snake/camel 字段。 */
function readCodexOauthRefreshToken(input: Record<string, unknown>): string | null {
  return readNestedStringValue(input, ["tokens", "refresh_token"]) ??
    readNestedStringValue(input, ["tokens", "refreshToken"]) ??
    readStringValue(input, "refresh_token") ??
    readStringValue(input, "refreshToken");
}

/** 读取本机 Claude 原生认证状态；API Key 和 OAuth 只返回来源，不暴露值。 */
export function readClaudeNativeAuthState(): ClaudeNativeAuthState {
  const apiKey = readClaudeConfig().apiKey;
  if (apiKey) return { available: true, source: "local_api_key", issue: null };
  if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return NATIVE_AUTH_NONE;
  try {
    return readClaudeNativeAuthStateFromText(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, "utf-8"));
  } catch (error) {
    return {
      available: false,
      source: "none",
      issue: error instanceof Error ? `读取 .credentials.json 失败：${error.message}` : "读取 .credentials.json 失败",
    };
  }
}

/** 从 .credentials.json 文本解析 Claude 原生认证状态，供运行态和单测共用。 */
export function readClaudeNativeAuthStateFromText(content: string): ClaudeNativeAuthState {
  if (!content.trim()) return NATIVE_AUTH_NONE;
  try {
    return readClaudeNativeAuthStateFromData(JSON.parse(content));
  } catch {
    return { available: false, source: "none", issue: ".credentials.json 不是有效 JSON" };
  }
}

/** 从已解析对象判断 Claude 原生 OAuth 是否可用。 */
export function readClaudeNativeAuthStateFromData(input: unknown): ClaudeNativeAuthState {
  if (!isPlainRecord(input)) {
    return { available: false, source: "none", issue: ".credentials.json 顶层不是对象" };
  }
  const refreshToken =
    readNestedStringValue(input, ["claudeAiOauth", "refreshToken"]) ??
    readNestedStringValue(input, ["claudeAiOauth", "refresh_token"]) ??
    readStringValue(input, "refreshToken") ??
    readStringValue(input, "refresh_token");
  if (refreshToken) {
    return { available: true, source: "local_oauth", issue: null };
  }
  if (isPlainRecord(input.claudeAiOauth)) {
    return { available: false, source: "none", issue: "本机 Claude OAuth 缺少 refreshToken" };
  }
  return NATIVE_AUTH_NONE;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readStringValue(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNestedStringValue(obj: Record<string, unknown>, pathParts: string[]): string | null {
  let current: unknown = obj;
  for (const part of pathParts) {
    if (!isPlainRecord(current)) return null;
    current = current[part];
  }
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

// ---------------------------------------------------------------------------
// Claude — ~/.claude/settings.json
// 正确格式: { "env": { "ANTHROPIC_AUTH_TOKEN": "...", "ANTHROPIC_BASE_URL": "..." }, ...其他 }
// Claude Code CLI 读取密钥的变量名是 ANTHROPIC_AUTH_TOKEN（非 ANTHROPIC_API_KEY）。
// Windows 上额外通过 setx 写入用户级系统环境变量，以确保 CLI 子进程能读到。
// ---------------------------------------------------------------------------

function readClaudeConfig(): EngineCredentialConfig {
  const data = readJsonFile(CLAUDE_CONFIG_PATH);
  const env = (typeof data.env === "object" && data.env !== null && !Array.isArray(data.env)
    ? data.env
    : {}) as Record<string, unknown>;

  return {
    // 优先 ANTHROPIC_AUTH_TOKEN → 兼容旧 ANTHROPIC_API_KEY → 兜底根级 apiKey
    apiKey: str(env, "ANTHROPIC_AUTH_TOKEN") ?? str(env, "ANTHROPIC_API_KEY") ?? str(data, "apiKey"),
    baseUrl: str(env, "ANTHROPIC_BASE_URL") ?? str(data, "baseUrl"),
  };
}

async function writeClaudeConfig(config: EngineCredentialConfig): Promise<void> {
  const data = readJsonFile(CLAUDE_CONFIG_PATH);

  // 确保 env 是普通对象（数组的 typeof 也是 "object"，需排除）
  if (typeof data.env !== "object" || data.env === null || Array.isArray(data.env)) {
    data.env = {};
  }
  const env = data.env as Record<string, unknown>;

  // 写入 / 删除 ANTHROPIC_AUTH_TOKEN
  if (config.apiKey !== undefined) {
    if (config.apiKey === null || config.apiKey === "") {
      delete env.ANTHROPIC_AUTH_TOKEN;
    } else {
      env.ANTHROPIC_AUTH_TOKEN = config.apiKey;
    }
  }

  // 写入 / 删除 ANTHROPIC_BASE_URL
  if (config.baseUrl !== undefined) {
    if (config.baseUrl === null || config.baseUrl === "") {
      delete env.ANTHROPIC_BASE_URL;
    } else {
      env.ANTHROPIC_BASE_URL = config.baseUrl;
    }
  }

  // 清理遗留的旧字段（根级 + env 内旧变量名）
  delete data.apiKey;
  delete data.baseUrl;
  delete env.ANTHROPIC_API_KEY;

  atomicWriteJson(CLAUDE_CONFIG_PATH, data);

  // Windows: 异步写入用户级系统环境变量（并行执行，不阻塞事件循环）
  if (process.platform === "win32") {
    const tasks: Promise<void>[] = [];
    if (config.apiKey !== undefined) {
      tasks.push(setWindowsUserEnvAsync("ANTHROPIC_AUTH_TOKEN", config.apiKey || null));
    }
    if (config.baseUrl !== undefined) {
      tasks.push(setWindowsUserEnvAsync("ANTHROPIC_BASE_URL", config.baseUrl || null));
    }
    await Promise.all(tasks);
  }
}

/** Windows: 通过 setx 异步设置/清除用户级环境变量（不阻塞事件循环） */
function setWindowsUserEnvAsync(name: string, value: string | null): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    console.warn(`[enginesConfig] Invalid env var name: ${name}`);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const cmd = value ? "setx" : "reg";
    const args = value
      ? [name, value]
      : ["delete", "HKCU\\Environment", "/F", "/V", name];
    execFile(cmd, args, { timeout: 15_000 }, (err) => {
      if (err) console.warn(`[enginesConfig] Failed to set Windows env var: ${name}`, err.message);
      resolve(); // 不论成败都 resolve，注册表写入失败不阻止主流程
    });
  });
}

// ---------------------------------------------------------------------------
// Codex — 密钥与配置分离（对齐 Codex CLI 官方结构）
//   密钥: ~/.codex/auth.json          → { "OPENAI_API_KEY": "sk-..." }
//   配置: ~/.codex/config.toml        → model_provider + [model_providers.codeflowai]
// 参考:
//   https://developers.openai.com/codex/auth/
//   https://developers.openai.com/codex/config-advanced/
// ---------------------------------------------------------------------------

// ---- config.toml 中 codeflowai 托管段落的标记 ----
const CODEFLOWAI_MP_SELECT_BEGIN = "# [codeflowai:model-provider-select:begin]";
const CODEFLOWAI_MP_SELECT_END = "# [codeflowai:model-provider-select:end]";
const CODEFLOWAI_MP_BEGIN = "# [codeflowai:model-provider:begin]";
const CODEFLOWAI_MP_END = "# [codeflowai:model-provider:end]";
const CODEFLOWAI_CODEX_STREAM_IDLE_TIMEOUT_MS = 3 * 60_000;
const CODEFLOWAI_CODEX_STREAM_MAX_RETRIES = 5;
/** CodeFlow app-server 专用运行时 Key 环境变量，不占用 Codex 公共环境变量。 */
export const CODEFLOWAI_CODEX_API_KEY_ENV = "CODEFLOWAI_CODEX_API_KEY";

/** Codex 运行时覆盖所需的最小配置；Key 由调用方通过环境变量注入。 */
export type CodexRuntimeConfig = EngineCredentialConfig;

export type WriteEngineConfigOptions = {
  /** 在写入 Codex 原生文件前创建一份时间戳快照。 */
  backupCodexNativeFiles?: boolean;
};

/** 同一 Client 内所有 Codex 配置写入共用一个串行队列。 */
let codexConfigWriteTail: Promise<void> = Promise.resolve();

/** 串行化 Codex 配置写入，避免 auth/config 的 read-modify-write 互相覆盖。 */
export function withCodexConfigWriteLock<T>(action: () => T | Promise<T>): Promise<T> {
  const previous = codexConfigWriteTail;
  const operation = previous.then(action);
  codexConfigWriteTail = operation.then(() => undefined, () => undefined);
  return operation;
}

/** 为单个 app-server 生成命令行 provider 覆盖，避免启动时改写共享 config.toml。 */
export function buildCodexAppServerConfigArgs(config: CodexRuntimeConfig | null | undefined): string[] {
  const baseUrl = typeof config?.baseUrl === "string" ? config.baseUrl.trim() : "";
  if (!baseUrl) return [];
  return [
    "-c", 'model_provider="codeflowai"',
    "-c", 'model_providers.codeflowai.name="CodeFlowAI Managed"',
    "-c", `model_providers.codeflowai.base_url="${escapeTomlString(baseUrl)}"`,
    "-c", `model_providers.codeflowai.env_key="${CODEFLOWAI_CODEX_API_KEY_ENV}"`,
    "-c", "model_providers.codeflowai.requires_openai_auth=false",
    "-c", `model_providers.codeflowai.stream_idle_timeout_ms=${CODEFLOWAI_CODEX_STREAM_IDLE_TIMEOUT_MS}`,
    "-c", `model_providers.codeflowai.stream_max_retries=${CODEFLOWAI_CODEX_STREAM_MAX_RETRIES}`,
  ];
}

function readCodexConfig(): EngineCredentialConfig {
  // API Key: 从 auth.json 读取
  const authData = readJsonFile(CODEX_AUTH_PATH);
  const apiKey = str(authData, CODEX_NATIVE_AUTH_API_KEY_FIELD) ?? str(authData, "apiKey");

  // Base URL: 从 config.toml 的 [model_providers.codeflowai] 段读取
  const baseUrl = readCodexModelProviderBaseUrl();

  return { apiKey, baseUrl };
}

function writeCodexConfig(config: EngineCredentialConfig): void {
  // ---- 1. API Key → auth.json（原文件备份后写入独立密钥文件）----
  if (config.apiKey !== undefined) {
    switchCodexAuthFile(CODEX_AUTH_PATH, config.apiKey);
  }

  // ---- 2. Base URL → config.toml（model_providers 段）----
  if (config.baseUrl !== undefined) {
    writeCodexModelProvider(config.baseUrl);
  }
}

/** 切换 Codex 认证文件：首次写入 Key 时原样备份，清除 Key 时恢复原文件。 */
export function switchCodexAuthFile(authPath: string, apiKey: string | null): void {
  const backupPath = `${authPath}.codeflow-backup`;
  const normalizedApiKey = typeof apiKey === "string" ? apiKey.trim() : "";
  if (normalizedApiKey) {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    if (!fs.existsSync(backupPath)) {
      if (fs.existsSync(authPath)) {
        fs.copyFileSync(authPath, backupPath, fs.constants.COPYFILE_EXCL);
      } else {
        fs.writeFileSync(backupPath, "{}\n", { encoding: "utf-8", flag: "wx" });
      }
    }
    atomicWriteJson(authPath, { [CODEX_NATIVE_AUTH_API_KEY_FIELD]: normalizedApiKey });
    return;
  }

  if (fs.existsSync(backupPath)) {
    const tmpPath = createAtomicTempPath(authPath);
    fs.copyFileSync(backupPath, tmpPath);
    fs.renameSync(tmpPath, authPath);
    fs.unlinkSync(backupPath);
    return;
  }

  if (!fs.existsSync(authPath)) return;
  const data = clearLegacyCodexAuthJsonData(JSON.parse(fs.readFileSync(authPath, "utf-8")));
  atomicWriteJson(authPath, data);
}

/** 清理升级前无备份 auth.json 中的旧 Key 字段，保留其余认证内容。 */
function clearLegacyCodexAuthJsonData(input: unknown): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new Error("Codex auth.json 顶层不是对象，无法清理旧 Key");
  }
  const data: Record<string, unknown> = { ...input };
  delete data[CODEX_NATIVE_AUTH_API_KEY_FIELD];
  delete data.apiKey;
  delete data.baseUrl;
  delete data.OPENAI_BASE_URL;
  return data;
}

// ---------------------------------------------------------------------------
// config.toml — model_provider 段落管理
//
// 当用户设置自定义 Base URL 时，写入:
//   model_provider = "codeflowai"
//   [model_providers.codeflowai]
//   name = "CodeFlowAI Managed"
//   base_url = "https://proxy.example.com/v1"
//   requires_openai_auth = true
//
// 当用户清除 Base URL 时，移除上述内容（回退到 Codex 内置 openai 提供商）。
//
// 注: 持久化配置依赖原生 auth.json；app-server 启动时再用 -c 覆盖为专用运行时 env_key。
// ---------------------------------------------------------------------------

/** 从 config.toml 读取 CodeFlowAI 托管的 base_url（无则返回 null）。 */
export function readCodexModelProviderStateFromText(content: string): {
  activeProvider: string | null;
  managedBaseUrl: string | null;
  managedPreviousProvider: string | null;
} {
  const activeProvider = readTopLevelModelProviderFromText(content);
  const managedPreviousProvider = readManagedPreviousModelProviderFromText(content);
  if (activeProvider !== "codeflowai") {
    return { activeProvider, managedBaseUrl: null, managedPreviousProvider };
  }

  const section = extractManagedBlock(content, CODEFLOWAI_MP_BEGIN, CODEFLOWAI_MP_END);
  if (!section) {
    return { activeProvider, managedBaseUrl: null, managedPreviousProvider };
  }
  const match = section.match(/^\s*base_url\s*=\s*"([^"]*)"/m);
  return {
    activeProvider,
    managedBaseUrl: match?.[1] || null,
    managedPreviousProvider,
  };
}

function readCodexModelProviderBaseUrl(): string | null {
  const content = readTextFile(CODEX_CONFIG_TOML_PATH);
  if (!content) return null;
  return readCodexModelProviderStateFromText(content).managedBaseUrl;
}

/** 写入/移除 config.toml 的 CodeFlowAI model_provider 段落。 */
function writeCodexModelProvider(baseUrl: string | null | undefined): void {
  const content = readTextFile(CODEX_CONFIG_TOML_PATH);
  const output = updateCodexModelProviderConfigText(content, baseUrl);
  atomicWriteText(CODEX_CONFIG_TOML_PATH, output);
}

/** 启动 Codex 前幂等刷新托管 provider 的鉴权与流重试配置；非托管 provider 不写文件。 */
export function ensureCodexManagedProviderRuntimeConfig(): void {
  const content = readTextFile(CODEX_CONFIG_TOML_PATH);
  const state = readCodexModelProviderStateFromText(content);
  if (state.activeProvider !== "codeflowai" || !state.managedBaseUrl) return;
  const output = updateCodexModelProviderConfigText(content, state.managedBaseUrl);
  if (output === content) return;
  atomicWriteText(CODEX_CONFIG_TOML_PATH, output);
}

/** 生成 CodeFlow 托管 provider 配置；保留其他配置并重建托管选择与 provider 段。 */
export function updateCodexModelProviderConfigText(content: string, baseUrl: string | null | undefined): string {
  let lines = content ? content.split("\n") : [];
  const currentProvider = readTopLevelModelProviderFromText(content);
  const existingState = readCodexModelProviderStateFromText(content);
  const previousProvider =
    existingState.managedPreviousProvider ??
    (currentProvider && currentProvider !== "codeflowai" ? currentProvider : null);

  lines = removeManagedBlock(lines, CODEFLOWAI_MP_SELECT_BEGIN, CODEFLOWAI_MP_SELECT_END);
  lines = removeManagedBlock(lines, CODEFLOWAI_MP_BEGIN, CODEFLOWAI_MP_END);
  lines = lines.filter((l) => !/^\s*model_provider\s*=\s*"([^"]*)"\s*$/.test(l));

  const trimmedBaseUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (trimmedBaseUrl) {
    const selectBlock = [
      CODEFLOWAI_MP_SELECT_BEGIN,
      previousProvider
        ? `# previous_model_provider = "${escapeTomlString(previousProvider)}"`
        : "# previous_model_provider = \"\"",
      'model_provider = "codeflowai"',
      CODEFLOWAI_MP_SELECT_END,
      "",
    ];
    lines = insertBeforeFirstSection(lines, selectBlock);

    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push(
      "",
      CODEFLOWAI_MP_BEGIN,
      "[model_providers.codeflowai]",
      'name = "CodeFlowAI Managed"',
      `base_url = "${escapeTomlString(trimmedBaseUrl)}"`,
      "requires_openai_auth = true",
      `stream_idle_timeout_ms = ${CODEFLOWAI_CODEX_STREAM_IDLE_TIMEOUT_MS}`,
      `stream_max_retries = ${CODEFLOWAI_CODEX_STREAM_MAX_RETRIES}`,
      CODEFLOWAI_MP_END,
      "",
    );
  } else if (previousProvider) {
    lines = insertBeforeFirstSection(lines, [`model_provider = "${escapeTomlString(previousProvider)}"`, ""]);
  }

  return normalizeTomlLines(lines);
}

function readTopLevelModelProviderFromText(content: string): string | null {
  let provider: string | null = null;
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*model_provider\s*=\s*"([^"]*)"\s*$/);
    if (match) provider = match[1] || null;
  }
  return provider;
}

function readManagedPreviousModelProviderFromText(content: string): string | null {
  const section = extractManagedBlock(content, CODEFLOWAI_MP_SELECT_BEGIN, CODEFLOWAI_MP_SELECT_END);
  if (!section) return null;
  const match = section.match(/^\s*#\s*previous_model_provider\s*=\s*"([^"]*)"\s*$/m);
  return match?.[1] ? match[1] : null;
}

function extractManagedBlock(content: string, beginMarker: string, endMarker: string): string | null {
  const beginIdx = content.indexOf(beginMarker);
  const endIdx = content.indexOf(endMarker);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) return null;
  return content.slice(beginIdx, endIdx + endMarker.length);
}

function removeManagedBlock(lines: string[], beginMarker: string, endMarker: string): string[] {
  const result = [...lines];
  while (true) {
    const beginIdx = result.findIndex((l) => l.includes(beginMarker));
    if (beginIdx < 0) return result;
    let endIdx = result.findIndex((l, i) => i > beginIdx && l.includes(endMarker));
    if (endIdx < 0) endIdx = result.length - 1;
    result.splice(beginIdx, endIdx - beginIdx + 1);
  }
}

function insertBeforeFirstSection(lines: string[], insertLines: string[]): string[] {
  const result = [...lines];
  const firstSectionIdx = result.findIndex((l) => /^\s*\[/.test(l));
  if (firstSectionIdx >= 0) {
    result.splice(firstSectionIdx, 0, ...insertLines);
  } else {
    result.push(...insertLines);
  }
  return result;
}

function normalizeTomlLines(lines: string[]): string {
  const result: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && result.length > 0 && result[result.length - 1].trim() === "") continue;
    result.push(line);
  }
  return result.join("\n").trimEnd() + "\n";
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// 公共 API（签名不变）
// ---------------------------------------------------------------------------

/** 读取引擎凭据配置（从原生配置文件）。文件不存在返回空对象。 */
export function readEngineConfig(engine: "claude" | "codex"): EngineCredentialConfig {
  return engine === "claude" ? readClaudeConfig() : readCodexConfig();
}

/** 写入引擎凭据配置；Codex 可选在写入前保留历史快照。 */
export async function writeEngineConfig(
  engine: "claude" | "codex",
  config: EngineCredentialConfig,
  options: WriteEngineConfigOptions = {},
): Promise<void> {
  if (engine === "claude") {
    await writeClaudeConfig(config);
  } else {
    await withCodexConfigWriteLock(() => {
      if (options.backupCodexNativeFiles) backupCodexNativeConfigFiles();
      writeCodexConfig(config);
    });
  }
}

