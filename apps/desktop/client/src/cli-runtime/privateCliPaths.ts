import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  isExactSemver,
  privateCliNpmPackage,
  type PrivateCliEngine,
} from "./privateCliManifest.js";

/** 运行时记录缺失以外的非法情况统一使用该错误码，禁止静默回退系统 CLI。 */
export const PRIVATE_CLI_RUNTIME_ENTRY_INVALID = "PRIVATE_CLI_RUNTIME_ENTRY_INVALID";

/** 热路径只按文件时间戳复用解析结果，安装写入新文件后自然失效。 */
const RUNTIME_ENTRY_CACHE = new Map<string, { mtimeMs: number; size: number; entry: PrivateCliRuntimeEntry }>();

/** `<engineRoot>/runtime.json` 的严格记录结构，binPath 必须是引擎目录内的相对路径。 */
export type PrivateCliRuntimeEntry = {
  schemaVersion: 1;
  engine: PrivateCliEngine;
  npmPackage: string;
  version: string;
  installedAt: string;
  verifiedAt: string;
  binPath: string;
};

/** 记录必须给出的全部字段；缺一或多一都视为非法。 */
const RUNTIME_ENTRY_KEYS = [
  "schemaVersion",
  "engine",
  "npmPackage",
  "version",
  "installedAt",
  "verifiedAt",
  "binPath",
] as const;

/** 严格 UTF-8 解码器：遇到非法字节直接抛错，避免替换字符掩盖损坏内容。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** 统一构造带 code 的运行时记录错误，保留 cause 便于定位 JSON/解码根因。 */
function invalidRuntimeEntry(message: string, cause?: unknown): Error {
  return Object.assign(
    new Error(`${PRIVATE_CLI_RUNTIME_ENTRY_INVALID}: ${message}`, cause === undefined ? undefined : { cause }),
    { code: PRIVATE_CLI_RUNTIME_ENTRY_INVALID },
  );
}

/** 判断未知值是否为受支持的引擎标识。 */
function isPrivateCliEngine(value: unknown): value is PrivateCliEngine {
  return value === "claude" || value === "codex";
}

/**
 * 按白名单读取普通对象：拒绝数组、类实例、Symbol 键、多余/缺失键和访问器属性，
 * 保证解析不触发 getter 副作用，字段集合与运行时记录完全一致。
 */
function readStrictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRuntimeEntry(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidRuntimeEntry(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string")) {
    throw invalidRuntimeEntry(`${label} must not contain symbol keys`);
  }
  const names = ownKeys as string[];
  if (names.length !== keys.length || keys.some(key => !names.includes(key))) {
    throw invalidRuntimeEntry(`${label} has unexpected or missing keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidRuntimeEntry(`${label}.${key} must be a data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** 只接受可无损回写为 ISO 字符串的规范时间，拒绝时区偏移、缺毫秒等非规范形式。 */
function parseCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw invalidRuntimeEntry(`${label} must be a canonical ISO timestamp`);
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw invalidRuntimeEntry(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

/**
 * 校验 binPath 为非空相对路径并确保解析后仍位于引擎目录内。
 * 这里只做路径约束，不检查文件是否存在（存在性由后续解析器负责）。
 */
function parseRelativeBinPath(value: unknown, engineRoot: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw invalidRuntimeEntry("binPath must be a non-empty relative path");
  }
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("/") || value.startsWith("\\")) {
    throw invalidRuntimeEntry("binPath must be a relative path");
  }
  const resolved = path.resolve(engineRoot, value);
  const relative = path.relative(engineRoot, resolved);
  if (relative.length === 0 || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw invalidRuntimeEntry("binPath must stay inside the engine root");
  }
  return value;
}

/** 返回引擎根目录的绝对路径，是所有私有 CLI 路径拼接的唯一入口。 */
export function privateCliEngineRoot(root: string, engine: PrivateCliEngine): string {
  return path.join(path.resolve(root), engine);
}

/**
 * 严格解析运行时记录：校验字段集合、引擎匹配、包名、版本、规范时间和相对 binPath。
 * 非法输入抛出 PRIVATE_CLI_RUNTIME_ENTRY_INVALID，不做任何缺省补全。
 */
export function parsePrivateCliRuntimeEntry(value: unknown, engine: PrivateCliEngine): PrivateCliRuntimeEntry {
  const record = readStrictRecord(value, RUNTIME_ENTRY_KEYS, "runtime entry");
  if (record.schemaVersion !== 1) {
    throw invalidRuntimeEntry("schemaVersion must be 1");
  }
  if (!isPrivateCliEngine(record.engine) || record.engine !== engine) {
    throw invalidRuntimeEntry(`engine must be ${engine}`);
  }
  if (record.npmPackage !== privateCliNpmPackage(engine)) {
    throw invalidRuntimeEntry("npmPackage is not the expected package");
  }
  if (!isExactSemver(record.version)) {
    throw invalidRuntimeEntry("version must be an exact semver version");
  }
  const installedAt = parseCanonicalTimestamp(record.installedAt, "installedAt");
  const verifiedAt = parseCanonicalTimestamp(record.verifiedAt, "verifiedAt");
  const binPath = parseRelativeBinPath(record.binPath, privateCliEngineRoot("/", engine));
  return {
    schemaVersion: 1,
    engine,
    npmPackage: record.npmPackage,
    version: record.version,
    installedAt,
    verifiedAt,
    binPath,
  };
}

/**
 * 读取 `<engineRoot>/runtime.json`。仅 ENOENT 表示尚未安装并返回 null；
 * 其他文件系统错误原样上抛，UTF-8/JSON/字段非法则抛
 * PRIVATE_CLI_RUNTIME_ENTRY_INVALID，让调用方显式失败而不是回退系统 CLI。
 */
export function readPrivateCliRuntimeEntry(
  root: string,
  engine: PrivateCliEngine,
): PrivateCliRuntimeEntry | null {
  const engineRoot = privateCliEngineRoot(root, engine), filePath = path.join(engineRoot, "runtime.json");
  let stat: ReturnType<typeof fs.statSync>;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      RUNTIME_ENTRY_CACHE.delete(filePath);
      return null;
    }
    throw error;
  }
  const cached = RUNTIME_ENTRY_CACHE.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entry;
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      RUNTIME_ENTRY_CACHE.delete(filePath);
      return null;
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(UTF8_DECODER.decode(buffer));
  } catch (error) {
    RUNTIME_ENTRY_CACHE.delete(filePath);
    throw invalidRuntimeEntry("runtime.json is not valid UTF-8 JSON", error);
  }
  const entry = parsePrivateCliRuntimeEntry(raw, engine);
  RUNTIME_ENTRY_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
  return entry;
}
