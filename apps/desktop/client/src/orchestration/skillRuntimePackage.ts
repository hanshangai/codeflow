import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { SkillDefinition, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import {
  assertWorkspaceCodeflowaiDirectory, ensureWorkspaceCodeflowaiDirectory,
  inspectExistingWorkspaceCodeflowaiDirectory, isWorkspaceCodeflowaiFileDeviceMatch,
  type WorkspaceCodeflowaiDirectoryIdentity,
} from "../codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude } from "../git/workspacePrivateRuntimeGitExclude.js";
import { logger } from "../logger.js";
import { redactClientStartupText } from "../startup/clientStartupStatus.js";

const RUNTIME_DIRECTORY = ".codeflowai/skill-runtime";
const METADATA_FILE = ".codeflowai-skill.json";
type Manifest = { skillId: string; folder: string; packageHash: string | null; files: Array<{ relPath: string; sha256: string }> };
type Guard = { root: WorkspaceCodeflowaiDirectoryIdentity; directories: Map<string, fs.Stats> };
export type SkillRuntimeExecutionContext = { skillId: string | null; toolId?: string; instanceId?: string | null; threadId?: string | null;
  db: Pick<ClientDb, "writeWorkspaceLog">; workspaceId: WorkspaceId; requestId: string; parentRequestId?: string | null;
  turnId?: string | null; nodeId?: string | null; attemptId?: string | null };
export type SkillRuntimeMaterializationContext = {
  db: Pick<ClientDb, "workspaces" | "writeWorkspaceLog">;
  workspaceId: WorkspaceId;
  requestId: string;
  threadId?: string | null;
  turnId?: string | null;
  instanceId?: string | null;
  nodeId?: string | null;
  attemptId?: string | null;
};
type RuntimeContext = Omit<SkillRuntimeExecutionContext, "db"> & { runtimeDirectory?: string };

/** 按 Skill 身份及实际字节发布新副本；同版本只读复核，旧版本永不覆盖或清理。 */
export function materializeSkillRuntimePackage(workspacePath: string, folder: string, skill: SkillDefinition, input: SkillRuntimeMaterializationContext): string {
  if (!input || typeof input.requestId !== "string" || !input.requestId.trim() || !input.db
    || typeof input.db.workspaces?.get !== "function" || typeof input.db.writeWorkspaceLog !== "function") throw unsafe("Skill 运行副本缺少工作区日志上下文");
  const workspace = input.db.workspaces.get(input.workspaceId);
  if (!workspace || skill.workspaceId !== workspace.id || pathKey(path.resolve(workspace.path)) !== pathKey(path.resolve(workspacePath))
    || pathKey(fs.realpathSync.native(workspace.path)) !== pathKey(path.resolve(workspacePath))) throw unsafe("Skill 运行副本工作区与注册物理路径不一致");
  const context: RuntimeContext = { skillId: String(skill.id), workspaceId: input.workspaceId, requestId: input.requestId,
    threadId: input.threadId, turnId: input.turnId, instanceId: input.instanceId, nodeId: input.nodeId, attemptId: input.attemptId };
  return atRuntimeBoundary(workspacePath, "materialize", context, () => {
    const contents = new Map<string, Buffer>();
    for (const file of skill.files ?? []) {
      const relative = packagePath(file.relPath);
      if (file.contentText == null && file.contentBase64 == null) throw unsafe(`包文件缺少内容：${relative}`);
      contents.set(relative, file.contentText != null ? Buffer.from(file.contentText, "utf8") : Buffer.from(file.contentBase64!, "base64"));
    }
    if (![...contents.keys()].some(name => process.platform === "win32" || process.platform === "darwin" ? name.toLowerCase() === "skill.md" : name === "SKILL.md")) {
      contents.set("SKILL.md", Buffer.from(String(skill.skillMd ?? ""), "utf8"));
    }
    const manifest: Manifest = {
      skillId: String(skill.id), folder, packageHash: skill.packageHash ?? null,
      files: [...contents].map(([relPath, bytes]) => ({ relPath, sha256: digest(bytes) })).sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
    };
    const relative = `${RUNTIME_DIRECTORY}/${identityName(manifest)}/${digest(JSON.stringify(manifest))}`;
    context.runtimeDirectory = relative;
    protectGit(workspacePath, relative, manifest);
    const guard = directoryGuard(workspacePath, relative.split("/").slice(1, -1), true);
    const destination = path.join(guard.root.workspaceRoot, relative);
    if (lstatOptional(destination)) {
      verifyPackage(guard, destination, manifest);
      return relative;
    }
    assertGuard(guard);
    const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".building-"));
    rememberDirectory(guard, staging);
    let unpublished = true;
    try {
      protectGit(workspacePath, path.relative(guard.root.workspaceRoot, staging).split(path.sep).join("/"), manifest);
      for (const [name, bytes] of contents) {
        const absolute = path.join(staging, name);
        ensureParents(guard, staging, path.dirname(name));
        assertGuard(guard);
        fs.writeFileSync(absolute, bytes, { flag: "wx" });
      }
      assertGuard(guard);
      fs.writeFileSync(path.join(staging, METADATA_FILE), JSON.stringify({ ...manifest, runtimeVersion: 1, targetId: "runtime" }), { flag: "wx" });
      verifyPackage(guard, staging, manifest);
      assertGuard(guard);
      // 非空版本目录的 rename 不覆盖既有包；其他进程先发布时必须复核其完整内容。
      try {
        fs.renameSync(staging, destination);
        unpublished = false;
      } catch (error) {
        const code = String((error as NodeJS.ErrnoException).code);
        if (!["EEXIST", "ENOTEMPTY"].includes(code) && !(process.platform === "win32" && code === "EPERM" && lstatOptional(destination))) throw error;
        const existing = directoryGuard(workspacePath, relative.split("/").slice(1, -1), false);
        verifyPackage(existing, destination, manifest);
      }
    } catch (error) {
      if (unpublished) {
        try { removeStaging(guard, staging); } catch (cleanup) {
          throw new AggregateError([error, cleanup], "运行副本生成与临时副本清理均失败", { cause: error });
        }
      }
      throw error;
    }
    if (unpublished) removeStaging(guard, staging);
    const published = directoryGuard(workspacePath, relative.split("/").slice(1, -1), false);
    verifyPackage(published, destination, manifest);
    return relative;
  }, input.db);
}

/** 执行前复核保留版本及 Git 状态；普通工具返回 null，缺失 Skill 目录绝不重建。 */
export function assertSkillRuntimeWorkingDirectory(workspacePath: string, workingDirectory: string | null | undefined, executionContext: SkillRuntimeExecutionContext): string | null {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(workspacePath, String(workingDirectory ?? "").trim())).split(path.sep).join("/");
  const key = process.platform === "win32" || process.platform === "darwin" ? relative.toLowerCase() : relative;
  const isRuntime = key === RUNTIME_DIRECTORY || key.startsWith(`${RUNTIME_DIRECTORY}/`);
  if (!isRuntime && executionContext.skillId === null) return null;
  const { db, ...executionIdentity } = executionContext;
  const context: RuntimeContext = { ...executionIdentity, runtimeDirectory: relative };
  return atRuntimeBoundary(workspacePath, "execute", context, () => {
    if (!isRuntime) throw unsafe("Skill 工具未绑定有效运行副本目录");
    const parts = relative.split("/");
    if (parts.length !== 4 || !/^[a-f0-9]{64}$/.test(parts[3]!)) throw unsafe("运行副本版本路径无效");
    const guard = directoryGuard(workspacePath, parts.slice(1, -1), false);
    const directory = path.join(guard.root.workspaceRoot, relative);
    rememberDirectory(guard, directory);
    const metadata = JSON.parse(readRegularFile(guard, path.join(directory, METADATA_FILE)).toString("utf8"));
    if (!metadata || metadata.runtimeVersion !== 1 || metadata.targetId !== "runtime" || typeof metadata.skillId !== "string" || typeof metadata.folder !== "string" || (metadata.packageHash !== null && typeof metadata.packageHash !== "string") || !Array.isArray(metadata.files) || !metadata.files.length) throw unsafe("运行副本元数据无效");
    if (context.skillId !== null && context.skillId !== metadata.skillId) throw unsafe("工具绑定的 Skill 身份与运行副本不一致");
    const manifest: Manifest = { skillId: metadata.skillId, folder: metadata.folder, packageHash: metadata.packageHash, files: metadata.files.map((file: { relPath: string; sha256: string }) => {
      if (!file || typeof file.relPath !== "string" || packagePath(file.relPath) !== file.relPath || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw unsafe("运行副本文件清单无效");
      return { relPath: file.relPath, sha256: file.sha256 };
    }) };
    if (identityName(manifest) !== parts[2] || digest(JSON.stringify(manifest)) !== parts[3]) throw unsafe("运行副本身份或版本摘要不一致");
    protectGit(workspacePath, relative, manifest);
    verifyPackage(guard, directory, manifest);
    return directory;
  }, db);
}

/** 文件名只允许包内正常路径分量，避免跨平台归一别名与 Windows ADS。 */
function packagePath(value: string): string {
  const relative = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === ".." || /[\0:<>"|?*\x01-\x1f]|[. ]$/.test(part)) || relative === METADATA_FILE) throw unsafe("运行副本包文件路径无效");
  return relative;
}

/** 根身份复用既有入口，嵌套目录逐层建立或只读检查，拒绝 junction 和替换。 */
function directoryGuard(workspacePath: string, segments: string[], create: boolean): Guard {
  const root = create ? ensureWorkspaceCodeflowaiDirectory(workspacePath) : inspectExistingWorkspaceCodeflowaiDirectory(workspacePath);
  if (!root) throw unsafe("运行副本根目录缺失");
  const guard: Guard = { root, directories: new Map() };
  let parent = root.directoryPath;
  for (const segment of segments) {
    parent = path.join(parent, segment);
    if (create) createDirectory(guard, parent);
    else rememberDirectory(guard, parent);
  }
  return guard;
}

/** 只接受不存在或已存在的真实目录，不将访问失败当成缺失。 */
function createDirectory(guard: Guard, directory: string): void {
  assertGuard(guard);
  try { fs.mkdirSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  rememberDirectory(guard, directory);
}

/** 写文件前逐层创建本次副本的父目录，不递归穿过未知链接。 */
function ensureParents(guard: Guard, base: string, relative: string): void {
  if (relative === ".") return;
  let parent = base;
  for (const part of relative.split(/[\\/]/)) {
    parent = path.join(parent, part);
    createDirectory(guard, parent);
  }
}

/** 保存物理目录身份；路径必须与 realpath 一致。 */
function rememberDirectory(guard: Guard, directory: string): void {
  assertGuard(guard);
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || pathKey(fs.realpathSync.native(directory)) !== pathKey(directory)) throw unsafe("运行副本包含非物理目录");
  guard.directories.set(directory, stat);
}

/** 每个读写边界复核已捕获的目录，阻止已观察到的目录替换。 */
function assertGuard(guard: Guard): void {
  assertWorkspaceCodeflowaiDirectory(guard.root);
  for (const [directory, expected] of guard.directories) {
    const current = fs.lstatSync(directory);
    if (current.isSymbolicLink() || !current.isDirectory() || current.ino !== expected.ino || !isWorkspaceCodeflowaiFileDeviceMatch(expected.dev, current.dev) || pathKey(fs.realpathSync.native(directory)) !== pathKey(directory)) throw unsafe("运行副本目录已被替换");
  }
}

/** 包树拒绝链接与共享 inode；声明文件逐字节校验，额外普通输出文件不改变包版本。 */
function verifyPackage(guard: Guard, directory: string, manifest: Manifest): void {
  rememberDirectory(guard, directory);
  const actualFiles = inspectTree(guard, directory);
  const metadata = JSON.parse(readRegularFile(guard, path.join(directory, METADATA_FILE)).toString("utf8"));
  if (metadata.runtimeVersion !== 1 || metadata.targetId !== "runtime" || JSON.stringify({ skillId: metadata.skillId, folder: metadata.folder, packageHash: metadata.packageHash, files: metadata.files }) !== JSON.stringify(manifest)) throw unsafe("运行副本元数据与请求版本不一致");
  for (const file of manifest.files) {
    if (digest(readRegularFile(guard, path.join(directory, file.relPath))) !== file.sha256) throw unsafe(`运行副本包文件内容不一致：${file.relPath}`);
  }
  ensureWorkspacePrivateRuntimeGitExclude(guard.root.workspaceRoot, actualFiles.map(absolute => path.relative(guard.root.directoryPath, absolute).split(path.sep).join("/")));
}

/** 遍历实际树以拒绝声明外注入的链接，目录身份在后续读取时继续复核。 */
function inspectTree(guard: Guard, directory: string): string[] {
  const files: string[] = [];
  assertGuard(guard);
  for (const name of fs.readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw unsafe("运行副本包含链接");
    if (stat.isDirectory()) { rememberDirectory(guard, absolute); files.push(...inspectTree(guard, absolute)); }
    else if (!stat.isFile() || stat.nlink !== 1) throw unsafe("运行副本包含非独占普通文件");
    else files.push(absolute);
  }
  assertGuard(guard);
  return files;
}

/** fd 与路径身份前后复核；不跟随硬链接或符号链接读取包内容。 */
function readRegularFile(guard: Guard, absolute: string): Buffer {
  assertGuard(guard);
  const before = fs.lstatSync(absolute);
  const check = (current: fs.Stats) => {
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1 || current.ino !== before.ino || !isWorkspaceCodeflowaiFileDeviceMatch(before.dev, current.dev) || pathKey(fs.realpathSync.native(absolute)) !== pathKey(absolute)) throw unsafe("运行副本文件身份不一致");
  };
  check(before);
  const fd = fs.openSync(absolute, "r");
  try {
    check(fs.fstatSync(fd));
    assertGuard(guard);
    const bytes = fs.readFileSync(fd);
    check(fs.fstatSync(fd));
    check(fs.lstatSync(absolute));
    assertGuard(guard);
    return bytes;
  } finally { fs.closeSync(fd); }
}

/** 仅清理本次未发布且身份未变的临时副本，异常由调用方保留双因。 */
function removeStaging(guard: Guard, staging: string): void {
  assertGuard(guard);
  fs.rmSync(staging, { recursive: true, force: false });
}

/** 实际清单同时覆盖正文、脚本、资源和 marker，不借用数据库探针。 */
function protectGit(workspacePath: string, relative: string, manifest: Manifest): void {
  const base = relative.slice(".codeflowai/".length);
  ensureWorkspacePrivateRuntimeGitExclude(workspacePath, [...manifest.files.map(file => `${base}/${file.relPath}`), `${base}/${METADATA_FILE}`]);
}

/** 同名不同 Skill 使用不同身份目录，限制可读前缀长度以保留 Windows 路径预算。 */
function identityName(manifest: Manifest): string { return `${manifest.folder.slice(0, 32)}-${digest(manifest.skillId).slice(0, 16)}`; }

/** 内容摘要只取实际字节或固定序列化清单，不信任声明中的文件 hash。 */
function digest(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }

/** 只有 ENOENT 表示不存在，权限和 I/O 异常保持失败。 */
function lstatOptional(target: string): fs.Stats | null {
  try { return fs.lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Windows 大小写不影响路径身份，其他系统使用真实路径比较。 */
function pathKey(value: string): string { return process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value); }

/** 本模块生成的诊断不含文件正文，允许进入结构化根因日志。 */
function unsafe(message: string): Error { return Object.assign(new Error(message), { code: "SKILL_RUNTIME_UNSAFE" }); }

/** 在副本 owner 记录一次安全上下文并显式抛出，保留根因且不自动重建。 */
function atRuntimeBoundary<T>(workspacePath: string, phase: string, context: RuntimeContext, action: () => T,
  db?: Pick<ClientDb, "writeWorkspaceLog">): T {
  try { return action(); } catch (cause) {
    const requestId = context.requestId ?? `skill-runtime:${crypto.randomUUID()}`;
    const business = Object.assign(new Error(`Skill 运行副本不可用 [requestId=${requestId}]`, { cause }), {
      ...context, code: "SKILL_RUNTIME_PACKAGE_INVALID", requestId, workspacePath, phase, retryable: false });
    try {
      const data = { ...context, code: "SKILL_RUNTIME_PACKAGE_INVALID", errorCode: "SKILL_RUNTIME_PACKAGE_INVALID", requestId, workspacePath, phase,
        event: { category: "skill", action: phase, outcome: "fail" }, rootCause: failureDiagnostic(cause) };
      const message = "Skill 运行副本校验或生成失败，已停止执行并保留现有版本";
      if (db) db.writeWorkspaceLog(context.workspaceId!, { level: "error", tag: "skill-runtime", message, data });
      else logger.error("skill-runtime", message, data);
    } catch (logging) {
      throw Object.assign(new AggregateError([business, logging], "SKILL_RUNTIME_FAILURE_LOG_FAILED", { cause: business }), {
        ...context, code: "SKILL_RUNTIME_FAILURE_LOG_FAILED", requestId, workspacePath, phase, retryable: false });
    }
    throw business;
  }
}

/** 有界记录系统诊断及双故障，不记录原始异常文案或包内容。 */
function failureDiagnostic(cause: unknown, depth = 0, budget = { remaining: 32 }): Record<string, unknown> {
  budget.remaining--;
  /** 仅读取自有 data descriptor；访问器和未知正文不参与日志。 */
  const data = (key: string): PropertyDescriptor | undefined => {
    if (cause === null || typeof cause !== "object" && typeof cause !== "function") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(cause, key);
    return descriptor && "value" in descriptor ? descriptor : undefined;
  };
  /** 仅已知系统诊断值进入日志，未知标量可能夹带包正文。 */
  const text = (value: unknown, allowed: readonly string[]): string | undefined => typeof value === "string" && allowed.includes(value)
    ? redactClientStartupText(value).slice(0, 1000) : undefined;
  const code = text(data("code")?.value, ["SKILL_RUNTIME_UNSAFE", "EACCES", "EPERM", "ENOENT", "ENOSPC", "EBUSY", "EIO", "EEXIST", "ENOTEMPTY", "EINVAL", "EMFILE", "ENFILE",
    "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE", "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED", "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED"]);
  const nested = data("cause"), aggregate = data("errors")?.value;
  const errors: Record<string, unknown>[] = [];
  if (depth < 3 && budget.remaining > 0 && Array.isArray(aggregate)) {
    const length = Object.getOwnPropertyDescriptor(aggregate, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) throw unsafe("运行副本错误数组长度无效");
    for (let index = 0; index < Math.min(8, length.value) && budget.remaining > 0; index++) {
      const item = Object.getOwnPropertyDescriptor(aggregate, String(index));
      errors.push(failureDiagnostic(item && "value" in item ? item.value : undefined, depth + 1, budget));
    }
  }
  const phase = text(data("phase")?.value, ["materialize", "execute", "locate", "tracked", "exclude", "verify", "marker"]);
  return { name: text(data("name")?.value, ["Error", "AggregateError", "TypeError", "RangeError", "SystemError", "WorkspaceCodeflowaiDirectoryError", "WorkspacePrivateRuntimeGitError"])
      ?? (cause instanceof Error ? "Error" : cause === null ? "null" : typeof cause),
    code, syscall: text(data("syscall")?.value, ["open", "close", "read", "write", "stat", "lstat", "fstat", "mkdir", "rmdir", "rename", "realpath", "unlink", "scandir", "link", "symlink"]),
    ...(phase !== undefined ? { phase } : {}),
    ...(Array.isArray(aggregate) && depth < 3 ? { errors } : {}),
    ...(depth < 3 && budget.remaining > 0 && nested ? { cause: failureDiagnostic(nested.value, depth + 1, budget) } : {}),
  };
}
