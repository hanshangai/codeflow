import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientDbStartupContextResponseBody } from "@codeflowai/shared";

import { resolveDesktopStoragePaths, type ClientConfig } from "../config.js";
import { hasExplicitClientDbPath, hasPlainSqliteHeader, resolveClientDbPath } from "../db/clientDb.js";
import { openSqliteDb } from "../db/sqliteDb.js";
import { CLIENT_DB_SCHEMA_VERSION } from '../db/migrateClientDb.js';

type PlainClientDbMeta = {
  schemaVersion: 2;
  storageMode: "plain_sqlite";
  accountNamespace: string;
  initializationState: "pending" | "ready";
  deviceAuthMode: "runtime";
  deviceId: string | null;
};

type DesktopClientDbMeta = {
  schemaVersion: 3;
  storageMode: "plain_sqlite";
  ownership: "local_os_user";
  initializationState: "pending" | "ready";
};

export type ClientDeviceIdentityRegistration = {
  deviceId: string;
  authMode: "runtime" | "local";
};

export type ClientDbStartupContext = {
  storageScope?: "local_user";
  accountNamespace: string | null;
  dbPath: string;
  explicitDbPath: boolean;
};

/** 桌面使用壳目录；远程 Client 只向 Server 解析账号目录，不读取旧数据。 */
export async function resolveClientDbStartupContext(input: {
  config: ClientConfig;
  clientVersion: string | null;
  desktop?: boolean;
}): Promise<ClientDbStartupContext> {
  if (input.desktop) return {
    storageScope: "local_user", accountNamespace: null, dbPath: resolveDesktopStoragePaths().dbPath,
    explicitDbPath: true,
  };
  const explicitDbPath = hasExplicitClientDbPath();
  const startupContext = await fetchStartupContext({
    config: input.config, httpBase: toHttpBaseFromWsUrl(input.config.serverWsUrl), clientVersion: input.clientVersion,
  });
  const accountNamespace = normalizeAccountNamespace(startupContext.accountNamespace);
  return { accountNamespace, dbPath: resolveClientDbPath(explicitDbPath ? null : accountNamespace), explicitDbPath };
}

/** 准备普通 SQLite 的本地所有权或账号绑定，不导入旧库。 */
export async function prepareClientDbSecurity(input: {
  config: ClientConfig;
  dbPath: string;
  startupContext: ClientDbStartupContext;
  clientVersion: string | null;
}): Promise<void> {
  if (input.startupContext.storageScope === "local_user") {
    prepareDesktopClientDbStorage(input.dbPath);
    return;
  }
  preparePlainClientDbStorage(input);
}

/** 本地新库先记 pending；中断遗留空库可重试，其余已有库校验归属和完整性。 */
function prepareDesktopClientDbStorage(dbPath: string): void {
  if (path.resolve(dbPath) !== resolveDesktopStoragePaths().dbPath) {
    throw storageError("CLIENT_DB_STORAGE_OWNERSHIP_MISMATCH", "桌面数据库路径与壳配置不一致");
  }
  const metaPath = resolveMetaPath(dbPath);
  const meta = readDesktopStorageMeta(metaPath);
  const exists = fs.existsSync(dbPath);
  if (!meta && exists) throw storageError("CLIENT_DB_STORAGE_OWNERSHIP_UNKNOWN", "桌面数据库缺少本地所有权元数据");
  if (!exists) {
    if (meta?.initializationState === "ready" || fs.existsSync(`${dbPath}-wal`) || fs.existsSync(`${dbPath}-shm`) || fs.existsSync(`${dbPath}-journal`)) {
      throw storageError("CLIENT_DB_STORAGE_FILE_MISSING", "桌面数据库文件缺失，不能创建空库替代");
    }
    if (!meta) {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      writePlainMeta(metaPath, { schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: "pending" });
    }
    return;
  }
  if (meta?.initializationState === "pending" && isUninitializedEmptySqliteFile(dbPath)) return;
  if (!hasPlainSqliteHeader(dbPath)) throw storageError("CLIENT_DB_STORAGE_FORMAT_MISMATCH", "桌面数据库不是普通 SQLite");
  const db = openSqliteDb(dbPath, { readonly: true, fileMustExist: true });
  try { assertIntegrity(db, dbPath); }
  finally { db.close(); }
}

/** 本地所有权与账号归属元数据互不认领，格式异常保留原文件并失败。 */
function readDesktopStorageMeta(metaPath: string): DesktopClientDbMeta | null {
  if (!fs.existsSync(metaPath)) return null;
  const parsed = parseJsonObject(fs.readFileSync(metaPath, "utf8"), metaPath);
  if (parsed.schemaVersion !== 3 || parsed.storageMode !== "plain_sqlite" || parsed.ownership !== "local_os_user"
    || parsed.accountNamespace !== undefined) {
    throw storageError("CLIENT_DB_STORAGE_OWNERSHIP_MISMATCH", "桌面数据库本地所有权元数据不匹配");
  }
  if (parsed.initializationState !== "pending" && parsed.initializationState !== "ready") {
    throw storageError("CLIENT_DB_STORAGE_META_UNSUPPORTED", "桌面数据库初始化状态无效");
  }
  return { schemaVersion: 3, storageMode: "plain_sqlite", ownership: "local_os_user", initializationState: parsed.initializationState };
}

/** 维护只验本机 ready 既有库，不建库、不迁移，也不接管账号或 pending 数据。 */
export function assertExistingDesktopClientDbStorage(dbPath: string): void {
  const meta = readDesktopStorageMeta(resolveMetaPath(dbPath));
  if (!meta || meta.initializationState !== 'ready') throw storageError('CLIENT_DB_STORAGE_NOT_READY', '桌面数据库尚未就绪');
  if (!fs.existsSync(dbPath)) throw storageError('CLIENT_DB_STORAGE_FILE_MISSING', '桌面数据库文件缺失');
  if (!hasPlainSqliteHeader(dbPath)) throw storageError('CLIENT_DB_STORAGE_FORMAT_MISMATCH', '桌面数据库不是普通 SQLite');
  const db = openSqliteDb(dbPath, { readonly: true, fileMustExist: true });
  let failure: unknown, failed = false;
  try {
    assertIntegrity(db, dbPath);
    if (db.pragma('application_id', { simple: true }) !== 0 || db.pragma('user_version', { simple: true }) !== CLIENT_DB_SCHEMA_VERSION) {
      throw storageError('DESKTOP_UNINSTALL_SCHEMA_UNSUPPORTED', '维护只支持当前应用数据库');
    }
    db.prepare('SELECT key, value FROM meta LIMIT 0').all();
    db.prepare('SELECT id, label, engine, provider_id, api_key, base_url, is_active, created_at, updated_at, source, server_origin, owner_user_id, server_key_id, secret_ref FROM engine_keys LIMIT 0').all();
  }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { db.close(); }
    catch (error) { throw failed ? new AggregateError([failure, error], 'CLIENT_DB_STORAGE_VERIFY_CLOSE_FAILED', { cause: failure }) : error; }
  }
}

/** 账号库匹配原归属；仅未登记设备的 pending 空库允许沿首次初始化重试。 */
function preparePlainClientDbStorage(input: { dbPath: string; startupContext: ClientDbStartupContext }): void {
  const accountNamespace = requireAccountNamespace(input.startupContext);
  const metaPath = resolveMetaPath(input.dbPath);
  const meta = readStorageMetaIfExists(metaPath);
  const exists = fs.existsSync(input.dbPath);
  if (meta) assertPlainMetaAccount(meta, accountNamespace, metaPath);
  if (!meta && exists) throw storageError("CLIENT_DB_STORAGE_OWNERSHIP_UNKNOWN", "普通数据库缺少账号归属元数据");
  if (!exists) {
    if (meta?.initializationState === "ready" || meta?.deviceId || fs.existsSync(`${input.dbPath}-wal`) || fs.existsSync(`${input.dbPath}-shm`) || fs.existsSync(`${input.dbPath}-journal`)) {
      throw storageError("CLIENT_DB_STORAGE_FILE_MISSING", "普通数据库文件缺失，不能创建空库替代");
    }
    if (!meta) {
      fs.mkdirSync(path.dirname(input.dbPath), { recursive: true });
      writePlainMeta(metaPath, createNewPlainMeta(accountNamespace));
    }
    return;
  }
  if (meta?.initializationState === "pending" && !meta.deviceId && isUninitializedEmptySqliteFile(input.dbPath)) return;
  if (!hasPlainSqliteHeader(input.dbPath)) throw storageError("CLIENT_DB_STORAGE_FORMAT_MISMATCH", "数据库不是普通 SQLite");
  const db = openSqliteDb(input.dbPath, { readonly: true, fileMustExist: true });
  try { assertIntegrity(db, input.dbPath); }
  finally { db.close(); }
}

/** 仅识别独立普通空文件且无事务工件，不沿链接初始化或修复已有数据。 */
function isUninitializedEmptySqliteFile(dbPath: string): boolean {
  const stat = fs.lstatSync(dbPath);
  return stat.isFile() && stat.nlink === 1 && stat.size === 0
    && !fs.existsSync(`${dbPath}-wal`) && !fs.existsSync(`${dbPath}-shm`) && !fs.existsSync(`${dbPath}-journal`);
}

/** 桌面读取壳身份；普通 Client 只登记不含私钥的 runtime 设备。 */
export async function prepareClientDeviceIdentity(input: {
  config: ClientConfig;
  clientVersion: string | null;
  startupContext: ClientDbStartupContext;
}): Promise<ClientDeviceIdentityRegistration> {
  if (input.startupContext.storageScope === "local_user") {
    const identityPath = path.join(path.dirname(input.startupContext.dbPath), "device-identity.json");
    const identity = parseJsonObject(fs.readFileSync(identityPath, "utf8"), identityPath);
    if (typeof identity.deviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.deviceId)
      || typeof identity.createdAt !== "string" || !Number.isFinite(Date.parse(identity.createdAt))
      || new Date(identity.createdAt).toISOString() !== identity.createdAt) {
      throw storageError("DESKTOP_DEVICE_IDENTITY_INVALID", "桌面设备身份文件字段无效");
    }
    return { deviceId: identity.deviceId, authMode: "local" };
  }
  const accountNamespace = requireAccountNamespace(input.startupContext);
  const meta = readStorageMetaIfExists(resolveMetaPath(input.startupContext.dbPath));
  if (!meta) throw storageError("CLIENT_DB_STORAGE_META_MISSING", "设备登记缺少普通数据库元数据");
  assertPlainMetaAccount(meta, accountNamespace, resolveMetaPath(input.startupContext.dbPath));
  const deviceId = meta.deviceId ?? `runtime_${crypto.randomUUID()}`;
  if (!meta.deviceId) updatePlainMetaDeviceId(input.startupContext.dbPath, accountNamespace, deviceId);
  await registerRuntimeDevice({ config: input.config, httpBase: toHttpBaseFromWsUrl(input.config.serverWsUrl), deviceId, clientVersion: input.clientVersion });
  return { deviceId, authMode: "runtime" };
}

/** 登记不持有设备私钥的普通 SQLite 运行设备。 */
async function registerRuntimeDevice(input: {
  config: ClientConfig;
  httpBase: string;
  deviceId: string;
  clientVersion: string | null;
}): Promise<void> {
  await postJson(input.httpBase, "/api/client-db/device/register", input.config.apiKey, {
    clientId: input.config.clientId,
    clientVersion: input.clientVersion,
    deviceId: input.deviceId,
    deviceFingerprintHash: buildDeviceFingerprintHash(input.config.clientId),
    deviceAuthMode: "runtime",
    platform: process.platform,
    arch: process.arch,
  });
}

/** 使用当前 API Key 获取账号命名空间。 */
async function fetchStartupContext(input: {
  config: ClientConfig;
  httpBase: string;
  clientVersion: string | null;
}): Promise<ClientDbStartupContextResponseBody> {
  return await postJson<ClientDbStartupContextResponseBody>(input.httpBase, "/api/client-db/startup-context", input.config.apiKey, {
    clientVersion: input.clientVersion, platform: process.platform, arch: process.arch,
  });
}

/** 执行 SQLite integrity_check，失败则阻止切换。 */
function assertIntegrity(db: ReturnType<typeof openSqliteDb>, dbPath: string): void {
  const result = String(db.pragma("integrity_check", { simple: true }) ?? "");
  if (result.toLowerCase() !== "ok") {
    throw new Error(`SQLite integrity_check failed for ${dbPath}: ${result}`);
  }
}

/** 发送启动请求并显式失败；错误不携带远端正文，避免凭据回显进入日志。 */
async function postJson<T extends object>(httpBase: string, pathName: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(`${httpBase}${pathName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const failure = Object.assign(storageError("CLIENT_DB_STARTUP_API_FAILED", `Client startup API failed ${pathName}: HTTP ${res.status}`), {
    requestId: res.headers.get("x-request-id") ?? undefined,
  });
  if (!res.ok) throw failure;
  let parsed: unknown;
  try { parsed = await res.json(); }
  catch { throw failure; }
  if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || parsed.ok !== true) throw failure;
  return parsed as T;
}

/** 创建账号普通库元数据，pending 表示尚未完成首次 schema 初始化。 */
function createNewPlainMeta(accountNamespace: string): PlainClientDbMeta {
  return { schemaVersion: 2, storageMode: "plain_sqlite", accountNamespace, initializationState: "pending", deviceAuthMode: "runtime", deviceId: null };
}

/** 原子写入普通 DB 元数据，不额外改变用户目录或文件权限。 */
function writePlainMeta(metaPath: string, meta: PlainClientDbMeta | DesktopClientDbMeta): void {
  writeJsonAtomic(metaPath, meta);
  syncPath(metaPath);
}

/** 数据库完成首次 open/schema 后固化 ready，本地所有权和账号归属分别校验。 */
export function confirmPlainClientDbInitialized(input: { dbPath: string; accountNamespace: string | null; storageScope?: "local_user" }): void {
  const metaPath = resolveMetaPath(input.dbPath);
  if (input.storageScope === "local_user") {
    const meta = readDesktopStorageMeta(metaPath);
    if (!meta) throw storageError("CLIENT_DB_STORAGE_META_MISSING", "桌面数据库所有权元数据缺失");
    if (!fs.existsSync(input.dbPath) || !hasPlainSqliteHeader(input.dbPath)) {
      throw storageError("CLIENT_DB_STORAGE_FORMAT_MISMATCH", "桌面数据库尚未完成初始化");
    }
    if (meta.initializationState !== "ready") writePlainMeta(metaPath, { ...meta, initializationState: "ready" });
    return;
  }
  const meta = readStorageMetaIfExists(metaPath);
  if (!meta) throw storageError("CLIENT_DB_STORAGE_META_MISSING", `普通 DB 元数据缺失：${metaPath}`);
  assertPlainMetaAccount(meta, normalizeAccountNamespace(input.accountNamespace), metaPath);
  if (!fs.existsSync(input.dbPath) || !hasPlainSqliteHeader(input.dbPath)) {
    throw storageError("CLIENT_DB_STORAGE_FORMAT_MISMATCH", `普通 DB 尚未完成初始化：${input.dbPath}`);
  }
  if (meta.initializationState === "ready") return;
  writePlainMeta(metaPath, { ...meta, initializationState: "ready" });
}

/** 普通 DB 设备首次登记后更新非敏感 deviceId 快照。 */
function updatePlainMetaDeviceId(dbPath: string, accountNamespace: string, deviceId: string): void {
  const metaPath = resolveMetaPath(dbPath);
  const meta = readStorageMetaIfExists(metaPath);
  if (!meta) throw storageError("CLIENT_DB_STORAGE_META_MISSING", "设备登记缺少数据库元数据");
  assertPlainMetaAccount(meta, accountNamespace, metaPath);
  if (meta.deviceId === deviceId) return;
  writePlainMeta(metaPath, { ...meta, deviceId });
}

/** 校验普通 DB 的账号绑定；任何不一致都显式阻断串库。 */
function assertPlainMetaAccount(meta: PlainClientDbMeta, accountNamespace: string, metaPath: string): void {
  if (meta.accountNamespace !== accountNamespace) {
    throw storageError("CLIENT_DB_STORAGE_ACCOUNT_MISMATCH", `普通 DB 账号绑定不一致：${metaPath}`);
  }
}

/** 普通库只接受当前 runtime 身份，未知结构保留文件并显式失败。 */
function readStorageMetaIfExists(metaPath: string): PlainClientDbMeta | null {
  if (!fs.existsSync(metaPath)) return null;
  const parsed = parseJsonObject(fs.readFileSync(metaPath, "utf8"), metaPath);
  if (parsed.schemaVersion !== 2 || parsed.storageMode !== "plain_sqlite" || parsed.deviceAuthMode !== "runtime"
    || (parsed.initializationState !== "pending" && parsed.initializationState !== "ready")) {
    throw storageError("CLIENT_DB_STORAGE_META_UNSUPPORTED", "普通数据库元数据版本或状态无效");
  }
  return { schemaVersion: 2, storageMode: "plain_sqlite", accountNamespace: normalizeAccountNamespace(parsed.accountNamespace),
    initializationState: parsed.initializationState, deviceAuthMode: "runtime",
    deviceId: parsed.deviceId == null ? null : requiredString(parsed.deviceId, "deviceId") };
}

/** 原子替换元数据，避免启动时读取半截 JSON。 */
function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

/** 持久化元数据文件内容。 */
function syncPath(filePath: string): void {
  const fd = fs.openSync(filePath, process.platform === "win32" ? "r+" : "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** 创建带稳定错误码的本地存储错误，供启动和日志边界识别。 */
function storageError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

/** 元数据与对应数据库同目录保存。 */
function resolveMetaPath(dbPath: string): string {
  return `${dbPath}.meta.json`;
}

/** 元数据只接受 JSON 对象，格式错误向上传播。 */
function parseJsonObject(text: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 不是 JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** 必填标识必须是非空字符串。 */
function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw storageError("CLIENT_DB_STORAGE_META_UNSUPPORTED", `${field} 必须为字符串`);
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${field} 缺失`);
  return text;
}

/** 校验服务端返回的账号命名空间只能作为路径段使用。 */
function normalizeAccountNamespace(value: unknown): string {
  const text = requiredString(value, "accountNamespace");
  if (!/^acct_[A-Za-z0-9_-]{8,80}$/.test(text)) {
    throw new Error(`accountNamespace 格式无效：${text}`);
  }
  return text;
}

/** 账号数据库必须先取得有效命名空间。 */
function requireAccountNamespace(context: ClientDbStartupContext): string {
  return normalizeAccountNamespace(context.accountNamespace);
}

/** 生成非秘密设备指纹，保持 Server 登记口径。 */
function buildDeviceFingerprintHash(clientId: string): string {
  const payload = JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    clientId,
  });
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/** 将同一 Server 的 WebSocket 地址转换为 HTTP 根地址。 */
function toHttpBaseFromWsUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
