import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { KnowledgeAssetActorContext } from "@codeflowai/shared";
import { isClientProcessRunning } from "../startup/clientStartupGuards.js";
import { isWorkspaceCodeflowaiFileDeviceMatch } from "../codeflowai/workspaceCodeflowaiDirectory.js";
import { logger } from "../logger.js";

export class KnowledgeAssetError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = "KnowledgeAssetError";
  }
}

/** Provider 的 429/速率限制必须进入知识任务的可重试路径，不能被包装成普通 IO 错误。 */
export function isKnowledgeRateLimitError(value: unknown): boolean {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const status = [record?.status, record?.statusCode, record?.httpStatus, record?.upstreamStatus]
    .map(item => Number(item)).find(item => Number.isInteger(item) && item === 429);
  if (status === 429) return true;
  const code = String(record?.code ?? record?.errorCode ?? "").toLowerCase();
  const message = value instanceof Error ? value.message : String(record?.message ?? record?.error ?? value ?? "");
  return /(?:^|[^0-9])429(?:[^0-9]|$)|too\s+many\s+requests|rate[_ -]?limit|throttl(?:e|ed|ing)/i.test(`${code} ${message}`);
}
export function knowledgeHash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function knowledgeJson(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
/**
 * 知识资产文本的规范换行是 LF；Windows 检出（core.autocrlf）或编辑器可能写成 CRLF，行尾不属于内容。
 * 输入任意文本，输出把所有 CRLF 折叠为 LF 的文本；仅用于本模块自写的知识资产文件。
 */
export function knowledgeLf(value: string): string { return value.replace(/\r\n/g, "\n"); }
/** knowledgeLf 的字节版本：在 Buffer 上折叠 0x0D0A，避免 UTF-8 解码/重编码改变非文本字节，使哈希与外部 sha256 对齐。 */
export function knowledgeLfBytes(value: Buffer): Buffer {
  if (value.indexOf(0x0d) === -1) return value;
  const folded = Buffer.allocUnsafe(value.length);
  let size = 0;
  for (let index = 0; index < value.length; index += 1) {
    const byte = value[index]!;
    if (byte === 0x0d && value[index + 1] === 0x0a) continue;
    folded[size] = byte; size += 1;
  }
  return folded.subarray(0, size);
}
export function knowledgeId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "知识标识无效", 400);
  }
  return value;
}
export function knowledgeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 1000 || /[\\:\x00-\x1f]/.test(value)
    || value.split("/").some(s => !s || s === "." || s === ".." || /[. ]$/.test(s))) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PATH_INVALID", "必须使用项目内的相对路径", 400);
  }
  return value.normalize("NFC");
}
export function knowledgeText(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (required && !value.trim())) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "文本为空、过长或格式无效", 400);
  }
  return value;
}
export function knowledgeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new KnowledgeAssetError("KNOWLEDGE_ASSET_INPUT_INVALID", "需要 JSON 对象", 400);
  }
  return value as Record<string, unknown>;
}

/** 校验 Server 覆盖写入的身份，并把缺失身份转换为资产权限错误。 */
export function requireKnowledgeAssetActorContext(value: unknown): KnowledgeAssetActorContext {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const keys = record ? Object.keys(record).sort() : [];
  const expected = ["accountRole", "enterpriseId", "permissionScope", "requestId", "userId"];
  const validKeys = keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  const validRole = record?.accountRole === "super_admin" || record?.accountRole === "enterprise_admin" || record?.accountRole === "personal_normal";
  const validScope = record?.permissionScope === "account" || record?.permissionScope === "shared_member" || record?.permissionScope === "shared_asset_admin";
  const validEnterprise = record?.enterpriseId === null || (typeof record?.enterpriseId === "string" && record.enterpriseId.trim().length <= 200);
  const valid = validKeys && typeof record?.userId === "string" && record.userId.trim().length > 0 && record.userId.length <= 200
    && validRole && validEnterprise && typeof record?.requestId === "string" && record.requestId.trim().length > 0 && record.requestId.length <= 300 && validScope;
  if (!valid) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PERMISSION_DENIED", "缺少 Server 覆盖写入的合法 actorContext", 403);
  return record as unknown as KnowledgeAssetActorContext;
}

/** 所有知识文件访问都从真实项目根解析；写入链禁止符号链接。 */
export class KnowledgeAssetFiles {
  readonly root: string;
  private readCache: { paths: Map<string, string>; bodies: Map<string, Buffer>; bytes: number } | null = null;
  constructor(workspacePath: string) { this.root = fs.realpathSync(path.resolve(workspacePath)); }

  /** 仅在一次同步只读检查内复用安全路径及文件字节，退出或失败立即释放。 */
  withReadCache<T>(read: () => T): T {
    if (this.readCache) return read();
    this.readCache = { paths: new Map(), bodies: new Map(), bytes: 0 };
    try { return read(); }
    finally { this.readCache = null; }
  }

  /** 缓存命中仍核对最终真实目标；首次读取逐层校验，写入始终重新解析。 */
  resolve(relative: string, write = false): string {
    if (write && this.readCache) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "只读检查期间不能写入知识文件");
    const normalized = knowledgeRelativePath(relative);
    const target = path.join(this.root, ...normalized.split("/"));
    const cached = this.readCache?.paths.get(target);
    if (!write && cached) {
      if (fs.realpathSync(target) !== cached) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PATH_INVALID", `路径真实目标在检查期间变化，请重新读取：${relative}`);
      return target;
    }
    let cursor = this.root;
    for (const segment of normalized.split("/")) {
      cursor = path.join(cursor, segment);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(cursor); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (write && stat.isSymbolicLink()) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PATH_INVALID", "知识写入路径不能包含符号链接");
      const actual = fs.realpathSync(cursor);
      const rel = path.relative(this.root, actual);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PATH_INVALID", "路径指向项目范围之外");
      }
      this.readCache?.paths.set(cursor, actual);
    }
    return cursor;
  }

  /** 返回真实目标；边界比较可保留尚未创建的路径，读取默认拒绝缺失文件。 */
  realpath(relative: string, allowMissing = false): string {
    const file = this.resolve(relative);
    const cached = this.readCache?.paths.get(file);
    if (cached) return cached;
    return allowMissing && !fs.existsSync(file) ? file : fs.realpathSync(file);
  }

  exists(relative: string): boolean {
    try { fs.lstatSync(this.resolve(relative)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  }
  /** 轻量文件版本标记；用于读取缓存时识别外部编辑，不读取正文。 */
  signature(relative: string): string | null {
    try {
      const stat = fs.statSync(this.resolve(relative));
      return `${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  /** 本次检查最多缓存 32 MiB 字节，每次仍校验调用方的读取上限。 */
  read(relative: string, maxBytes = 4 * 1024 * 1024): Buffer {
    const file = this.resolve(relative);
    const cached = this.readCache?.bodies.get(file);
    if (cached) {
      if (cached.length > maxBytes) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", `文件超过读取限制：${relative}`);
      return cached;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", `文件类型或大小不支持：${relative}`);
    const body = fs.readFileSync(file);
    if (body.length > maxBytes) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", `文件超过读取限制：${relative}`);
    if (this.readCache && this.readCache.bytes + body.length <= 32 * 1024 * 1024) {
      this.readCache.bodies.set(file, body);
      this.readCache.bytes += body.length;
    }
    return body;
  }
  json<T>(relative: string): T {
    try { return JSON.parse(this.read(relative).toString("utf8")) as T; }
    catch (error) {
      if (error instanceof SyntaxError) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_FILE_INVALID", `JSON 无效或尚有合并冲突：${relative}`);
      throw error;
    }
  }
  /** 先关闭再发布或清理本次临时文件；资源失败保留双因，身份变化时保全现场。 */
  write(relative: string, value: string): void {
    const target = this.resolve(relative, true);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.resolve(relative, true);
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    let identity: fs.Stats | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      identity = fs.fstatSync(fd);
      fs.writeFileSync(fd, value, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try { fs.closeSync(fd); }
    catch (closeError) { this.failWriteCleanup(relative, temp, operationFailed, operationError, closeError); }

    /** 已关闭临时文件仍须是本次独占 inode，不能发布或删除替换者。 */
    const assertTemporaryIdentity = () => {
      this.resolve(relative, true);
      const current = fs.lstatSync(temp);
      if (!identity || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
        || current.ino !== identity.ino || !isWorkspaceCodeflowaiFileDeviceMatch(identity.dev, current.dev)) {
        throw new KnowledgeAssetError("KNOWLEDGE_ASSET_PATH_INVALID", "知识写入临时文件身份已变化，请保留现场后检查");
      }
    };
    if (!operationFailed) {
      try {
        assertTemporaryIdentity();
        fs.renameSync(temp, target);
        return;
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
    }
    try { assertTemporaryIdentity(); fs.unlinkSync(temp); }
    catch (cleanupError) { this.failWriteCleanup(relative, temp, operationFailed, operationError, cleanupError); }
    throw operationError;
  }

  /** 清理 owner 补资源诊断；普通写失败仍交原业务边界记录，不输出正文或私有异常文案。 */
  private failWriteCleanup(relative: string, temp: string, operationFailed: boolean, operationError: unknown, cleanupError: unknown): never {
    const requestId = `knowledge-write:${crypto.randomUUID()}`;
    const message = `KNOWLEDGE_ASSET_WRITE_CLEANUP_FAILED [requestId=${requestId}]`;
    const failure = operationFailed
      ? new AggregateError([operationError, cleanupError], message, { cause: operationError })
      : new Error(message, { cause: cleanupError });
    const context = { requestId, workspacePath: this.root, relativePath: relative, temporaryPath: temp, retryable: false };
    logger.error("knowledge-assets", "知识文件写入清理失败，已停止发布并保留临时文件现场", {
      ...context, errorCode: "KNOWLEDGE_ASSET_WRITE_CLEANUP_FAILED",
      event: { category: "knowledge", action: "write_cleanup", outcome: "fail" },
      ...(operationFailed ? { operationCause: writeFailureDiagnostic(operationError) } : {}),
      cleanupCause: writeFailureDiagnostic(cleanupError),
    });
    throw Object.assign(failure, { code: "KNOWLEDGE_ASSET_WRITE_CLEANUP_FAILED", ...context });
  }
  directories(relative: string): string[] {
    if (!this.exists(relative)) return [];
    return fs.readdirSync(this.resolve(relative), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();
  }

  /** 同项目短同步写事务；释放仅限本次锁，资源失败保业务原错并停止后续副作用。 */
  mutate<T>(action: () => T): T {
    if (this.readCache) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_CONFLICT", "只读检查期间不能更新知识文件");
    const relative = ".codeflowai/knowledge-cache/execution/write.lock";
    const lock = this.resolve(relative, true);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 复核 Client 进程，避免 Windows 将遗留 PID 复用给其他程序后永久占锁。
      const owner = this.json<{ pid: number }>(relative);
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new KnowledgeAssetError("KNOWLEDGE_ASSET_LOCKED", "知识写锁无效，需要检查本地执行缓存");
      if (!isClientProcessRunning(owner.pid)) { fs.unlinkSync(lock); return this.mutate(action); }
      throw new KnowledgeAssetError("KNOWLEDGE_ASSET_LOCKED", "另一个进程正在更新项目知识，请稍后重试");
    }
    let identity: fs.Stats | undefined;
    let operationFailed = false;
    let operationError: unknown;
    let businessActionStarted = false;
    let result!: T;
    /** 复核原写路径与本次领取inode，拒绝删除后继或外部锁。 */
    const assertOwnedLock = () => {
      this.resolve(relative, true);
      const current = fs.lstatSync(lock);
      if (!identity || current.isSymbolicLink() || !current.isFile() || current.nlink !== 1
        || current.ino !== identity.ino || !isWorkspaceCodeflowaiFileDeviceMatch(identity.dev, current.dev)) {
        throw new KnowledgeAssetError("KNOWLEDGE_ASSET_LOCKED", "知识写锁身份已变化，请保留现场后检查");
      }
    };
    try {
      identity = fs.fstatSync(fd);
      assertOwnedLock();
      fs.writeFileSync(fd, knowledgeJson({ pid: process.pid }));
      businessActionStarted = true;
      result = action();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try { fs.closeSync(fd); }
    catch (closeError) { this.failLockCleanup(relative, lock, businessActionStarted, operationFailed, operationError, closeError); }
    try { assertOwnedLock(); fs.unlinkSync(lock); }
    catch (cleanupError) { this.failLockCleanup(relative, lock, businessActionStarted, operationFailed, operationError, cleanupError); }
    if (operationFailed) throw operationError;
    return result;
  }

  /** 锁释放失败可能发生在业务已生效后；保根因与锁现场，明确禁止自动重跑。 */
  private failLockCleanup(relative: string, lock: string, businessActionStarted: boolean, operationFailed: boolean, operationError: unknown, cleanupError: unknown): never {
    const requestId = `knowledge-lock:${crypto.randomUUID()}`;
    const message = `KNOWLEDGE_ASSET_LOCK_CLEANUP_FAILED [requestId=${requestId}]`;
    const failure = operationFailed
      ? new AggregateError([operationError, cleanupError], message, { cause: operationError })
      : new Error(message, { cause: cleanupError });
    const context = { requestId, workspacePath: this.root, relativePath: relative, lockPath: lock, businessActionStarted, retryable: false };
    logger.error("knowledge-assets", "知识写锁释放失败，业务可能已生效；已保留现场，请勿自动重跑", {
      ...context, errorCode: "KNOWLEDGE_ASSET_LOCK_CLEANUP_FAILED",
      event: { category: "knowledge", action: "lock_cleanup", outcome: "fail" },
      ...(operationFailed ? { operationCause: writeFailureDiagnostic(operationError) } : {}),
      cleanupCause: writeFailureDiagnostic(cleanupError),
    });
    throw Object.assign(failure, { code: "KNOWLEDGE_ASSET_LOCK_CLEANUP_FAILED", ...context });
  }
}

/** 只记录系统错误名、码和调用，不将文本内容或异常原文写入清理日志。 */
function writeFailureDiagnostic(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "NonError" };
  const source = error as NodeJS.ErrnoException;
  return { name: error.name, ...(typeof source.code === "string" ? { code: source.code } : {}), ...(typeof source.syscall === "string" ? { syscall: source.syscall } : {}) };
}

export function knowledgeFailure(error: unknown): { code: string; message: string } {
  return error instanceof KnowledgeAssetError
    ? { code: error.code, message: error.message }
    : {
      code: "KNOWLEDGE_ASSET_IO_FAILED",
      // 错误会落在资产状态、任务记录和工具结果中；只给固定提示无法定位问题。
      // 保留有限长度的异常消息，结构化日志仍记录完整上下文，避免把凭据写入项目文件。
      message: (() => {
        const cause = (error instanceof Error ? error.message : String(error ?? "")).trim().slice(0, 2000);
        return cause ? `项目知识操作失败：${cause}` : "项目知识操作失败，请查看对应请求的 Client 日志";
      })(),
    };
}
