import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";

import { logger } from "../../logger.js";

const projectDirCache = new Map<string, string>();

/**
 * 解析 Claude Code 的项目目录（`~/.claude/projects/<projectKey>`）。
 * 1. 优先通过 `sessions-index.json.originalPath` 与 workspacePath 匹配（精确）。
 * 2. Fallback：按目录名约定匹配（路径中非字母数字非连字符字符替换为 `-`）。
 */
export function resolveClaudeProjectDir(workspacePath: string): string | null {
  const ws = normalizeFsPath(workspacePath);
  if (!ws) return null;

  const cached = projectDirCache.get(ws);
  if (cached && fs.existsSync(cached)) return cached;

  const projectsRoot = path.join(os.homedir(), ".claude", "projects");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  // 1) 优先：通过 sessions-index.json 精确匹配
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(projectsRoot, ent.name);
    const indexFile = path.join(dir, "sessions-index.json");
    if (!fs.existsSync(indexFile)) continue;
    try {
      const raw = fs.readFileSync(indexFile, "utf8");
      const parsed = JSON.parse(raw) as any;
      const originalPath = normalizeFsPath(String(parsed?.originalPath ?? ""));
      if (originalPath && samePath(originalPath, ws)) {
        projectDirCache.set(ws, dir);
        return dir;
      }
    } catch {
      // ignore broken index
    }
  }

  // 2) Fallback：按目录名约定匹配（sessions-index.json 缺失时）
  const expectedKey = ws.replace(/[^a-zA-Z0-9\-]/g, "-");
  const fallbackDir = path.join(projectsRoot, expectedKey);
  try {
    if (fs.existsSync(fallbackDir) && fs.statSync(fallbackDir).isDirectory()) {
      projectDirCache.set(ws, fallbackDir);
      return fallbackDir;
    }
  } catch {
    // ignore
  }

  return null;
}

/** 解析某 Claude session 的 jsonl 存档路径（不存在返回 null）。 */
export function resolveClaudeSessionFilePath(opts: { workspacePath: string; sessionId: string }): string | null {
  const sid = String(opts.sessionId ?? "").trim();
  if (!sid) return null;
  const projectDir = resolveClaudeProjectDir(opts.workspacePath);
  if (!projectDir) return null;
  const file = path.join(projectDir, `${sid}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

/**
 * 读取 Claude session jsonl 的当前文件长度（byteLen）。
 * - 用于 turn.completed 时记录 checkpoint（回滚时可直接截断到该长度）。
 */
export function readClaudeSessionFileByteLen(sessionFilePath: string): number | null {
  const file = String(sessionFilePath ?? "").trim();
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const size = Number(st.size ?? 0);
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/**
 * 通过 turnOrdinal（第 N 条 user 消息）推导 Claude session 的 checkpoint byteLen。
 * - 只统计 `type:"user"` 且 `isSidechain=false` 的 user 消息；找到对应的 assistant（parentUuid=user.uuid）后返回该行结尾 byteLen。
 */
export async function deriveClaudeSessionCheckpointByteLen(opts: { workspacePath: string; sessionId: string; turnOrdinal: number }): Promise<
  { ok: true; byteLen: number } | { ok: false; message: string }
> {
  const sid = String(opts.sessionId ?? "").trim();
  const ordinal = Math.floor(Number(opts.turnOrdinal ?? 0));
  if (!sid || !Number.isFinite(ordinal) || ordinal <= 0) return { ok: false, message: "参数错误：sessionId/turnOrdinal" };

  const projectDir = resolveClaudeProjectDir(opts.workspacePath);
  if (!projectDir) return { ok: false, message: "未找到 Claude project 目录（~/.claude/projects/*）" };

  const sessionFile = path.join(projectDir, `${sid}.jsonl`);
  if (!fs.existsSync(sessionFile)) return { ok: false, message: "Claude session 存档不存在" };

  const byteLen = await findByteLenAfterNthUserTurn(sessionFile, ordinal);
  if (!byteLen) return { ok: false, message: "未能从 Claude session 存档推导 checkpoint" };
  return { ok: true, byteLen };
}

/**
 * 通过"从末尾丢弃 N 个 user turn"推导 Claude session 的 checkpoint byteLen。
 *
 * 此方法不依赖预存的 sessionFileByteLen，直接从当前 session 文件内容推算，
 * 因此在 Claude 自动压缩（compaction）重写 session 文件后仍然正确。
 *
 * 原理：
 *   1. 统计当前文件中非 sidechain 的 user 消息总数 K
 *   2. keepCount = K - numTurnsToDrop
 *   3. 找到第 keepCount 个 user turn 对应 assistant 回复的行尾偏移量
 */
export async function deriveClaudeCheckpointByteLenByDropping(opts: {
  workspacePath: string;
  sessionId: string;
  numTurnsToDrop: number;
}): Promise<{ ok: true; byteLen: number } | { ok: false; message: string }> {
  const sid = String(opts.sessionId ?? "").trim();
  const numDrop = Math.floor(Number(opts.numTurnsToDrop ?? 0));
  if (!sid || !Number.isFinite(numDrop) || numDrop <= 0) {
    return { ok: false, message: "参数错误：sessionId/numTurnsToDrop" };
  }

  const projectDir = resolveClaudeProjectDir(opts.workspacePath);
  if (!projectDir) return { ok: false, message: "未找到 Claude project 目录（~/.claude/projects/*）" };

  const sessionFile = path.join(projectDir, `${sid}.jsonl`);
  if (!fs.existsSync(sessionFile)) return { ok: false, message: "Claude session 存档不存在" };

  // 1) 统计当前文件中非 sidechain 的 user 消息总数
  const totalUsers = await countNonSidechainUsers(sessionFile);
  if (totalUsers <= 0) return { ok: true, byteLen: 0 };

  // 2) 计算需要保留的 user turn 数
  const keepCount = totalUsers - numDrop;
  if (keepCount <= 0) return { ok: true, byteLen: 0 };

  // 3) 使用现有方法找到第 keepCount 个 user turn 对应的 assistant 结尾偏移
  const byteLen = await findByteLenAfterNthUserTurn(sessionFile, keepCount);
  if (byteLen == null) {
    return { ok: false, message: `未能在 session 存档中定位第 ${keepCount} 个 user turn 的结尾（totalUsers=${totalUsers}, drop=${numDrop}）` };
  }
  return { ok: true, byteLen };
}

/**
 * 将 Claude session 存档裁剪到指定 byteLen，并更新 sessions-index.json。
 * - 只裁剪本 session 的 jsonl；不删除 `~/.claude/file-history/**`。
 * - 会生成备份；边界读取失败时保留现场、记录日志并拒绝，不执行裁剪。
 */
export async function truncateClaudeSessionToByteLen(opts: { workspacePath: string; sessionId: string; byteLen: number }): Promise<
  | { ok: true; backupPath: string; messageCount: number; truncatedToByteLen: number }
  | { ok: false; message: string; backupPath?: string }
> {
  const sid = String(opts.sessionId ?? "").trim();
  const target = Math.floor(Number(opts.byteLen ?? 0));
  if (!sid || !Number.isFinite(target) || target < 0) return { ok: false, message: "参数错误：sessionId/byteLen" };

  const projectDir = resolveClaudeProjectDir(opts.workspacePath);
  if (!projectDir) return { ok: false, message: "未找到 Claude project 目录（~/.claude/projects/*）" };

  const sessionFile = path.join(projectDir, `${sid}.jsonl`);
  if (!fs.existsSync(sessionFile)) return { ok: false, message: "Claude session 存档不存在", backupPath: sessionFile };

  const backupPath = `${sessionFile}.bak.${Date.now()}`;
  try {
    fs.copyFileSync(sessionFile, backupPath);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "创建备份失败" };
  }

  let truncatedTo: number;
  try {
    truncatedTo = clampByteLenToJsonlBoundary(sessionFile, target);
  } catch (error) {
    const code = "CLAUDE_SESSION_BOUNDARY_READ_FAILED", requestId = `claude-rollback-boundary:${randomUUID()}`;
    try {
      logger.error("claude-session-store", "Claude session rollback boundary read failed", {
        code, errorCode: code, requestId, sessionId: sid, workspacePath: opts.workspacePath,
        sessionFile, backupPath, requestedByteLen: target, providerMutationStarted: false,
        event: { category: "engine", action: "session_boundary_read", outcome: "fail" },
        rootCause: describeClaudeBoundaryReadFailure(error),
      });
    } catch (loggingError) {
      throw Object.assign(new AggregateError([error, loggingError], "Claude 回滚边界读取及日志记录均失败", { cause: error }), { code, requestId });
    }
    throw error;
  }
  try {
    fs.truncateSync(sessionFile, truncatedTo);
  } catch (e) {
    try { fs.copyFileSync(backupPath, sessionFile); } catch {}
    return { ok: false, message: e instanceof Error ? e.message : "裁剪失败", backupPath };
  }

  let messageCount = 0;
  try {
    messageCount = await countClaudeMessages(sessionFile);
  } catch {
    // ignore
  }

  try {
    updateSessionsIndex(projectDir, sid, { messageCount });
  } catch {
    // index 更新失败不影响 resume
  }

  return { ok: true, backupPath, messageCount, truncatedToByteLen: truncatedTo };
}

/** 只记录有限系统字段及聚合根因，不把存档内容和异常私文写入日志。 */
function describeClaudeBoundaryReadFailure(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) return { kind: typeof error };
  const source = error as NodeJS.ErrnoException;
  return {
    kind: "Error",
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(typeof source.syscall === "string" ? { syscall: source.syscall } : {}),
    ...(error instanceof AggregateError && depth < 2 ? { errors: error.errors.slice(0, 10).map(cause => describeClaudeBoundaryReadFailure(cause, depth + 1)) } : {}),
  };
}

function safeJson(line: string): any | null {
  try {
    const v = JSON.parse(String(line ?? ""));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** 分窗向前找完整行、补齐短读；读取/关闭失败向上传播，禁止将故障当作零位置。 */
function clampByteLenToJsonlBoundary(file: string, byteLen: number): number {
  const st = fs.statSync(file);
  const size = Number(st.size ?? 0);
  const max = Number.isFinite(size) && size > 0 ? size : 0;
  const target = Math.min(max, Math.max(0, Math.floor(Number(byteLen ?? 0))));
  if (target <= 0) return 0;
  if (target >= max) return max;

  const fd = fs.openSync(file, "r");
  let readFailed = false, readError: unknown;
  try {
    let end = target;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024), len = end - start;
      const buf = Buffer.allocUnsafe(len);
      let filled = 0;
      while (filled < len) {
        const bytesRead = fs.readSync(fd, buf, filled, len - filled, start + filled);
        if (bytesRead === 0) throw Object.assign(new Error("Claude 回滚边界读取提前结束"), { code: "CLAUDE_SESSION_BOUNDARY_INCOMPLETE_READ" });
        filled += bytesRead;
      }
      const idx = buf.lastIndexOf(10); // '\n'
      if (idx >= 0) return start + idx + 1;
      end = start;
    }
    return 0;
  } catch (error) {
    readFailed = true;
    readError = error;
    throw error;
  } finally {
    try {
      fs.closeSync(fd);
    } catch (closeError) {
      if (readFailed) throw new AggregateError([readError, closeError], "Claude 回滚边界读取及关闭均失败", { cause: readError });
      throw closeError;
    }
  }
}

async function countClaudeMessages(sessionFilePath: string): Promise<number> {
  let messageCount = 0;
  const input = fs.createReadStream(sessionFilePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const parsed = safeJson(String(line ?? ""));
    if (!parsed) continue;
    if (parsed.type === "user" && parsed.isSidechain === false) messageCount += 1;
    if (parsed.type === "assistant" && parsed.isSidechain === false) messageCount += 1;
  }
  rl.close();
  return messageCount;
}

async function findByteLenAfterNthUserTurn(sessionFilePath: string, n: number): Promise<number | null> {
  const target = Math.floor(Number(n ?? 0));
  if (!Number.isFinite(target) || target <= 0) return null;

  return new Promise((resolve) => {
    let done = false;
    let buf: Buffer = Buffer.alloc(0);
    let absOffset = 0;
    let userCount = 0;
    let targetUserUuid: string | null = null;

    const stream = fs.createReadStream(sessionFilePath);

    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      try { stream.destroy(); } catch {}
      resolve(v);
    };

    const handleLine = (lineBuf: Buffer, lineEndOffset: number) => {
      if (done) return;
      if (!lineBuf.length) return;
      // 兼容 CRLF：去掉末尾 '\r'
      const end = lineBuf[lineBuf.length - 1] === 13 ? lineBuf.subarray(0, lineBuf.length - 1) : lineBuf;
      let obj: any;
      try {
        obj = JSON.parse(end.toString("utf8"));
      } catch {
        return;
      }
      if (!obj || typeof obj !== "object") return;
      if (obj.isSidechain === true) return;
      const type = String(obj.type ?? "").trim();
      if (type === "user") {
        userCount += 1;
        if (userCount === target) {
          const uuid = String(obj.uuid ?? "").trim();
          if (uuid) targetUserUuid = uuid;
        }
        return;
      }
      if (targetUserUuid && type === "assistant") {
        const parentUuid = String(obj.parentUuid ?? "").trim();
        if (parentUuid && parentUuid === targetUserUuid) {
          finish(lineEndOffset);
        }
      }
    };

    stream.on("data", (chunk: Buffer) => {
      if (done) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (true) {
        const idx = buf.indexOf(10); // '\n'
        if (idx < 0) break;
        const lineBuf = buf.subarray(0, idx);
        const lineEndOffset = absOffset + idx + 1;
        buf = buf.subarray(idx + 1);
        absOffset = lineEndOffset;
        handleLine(lineBuf, lineEndOffset);
        if (done) return;
      }
    });

    stream.on("error", () => finish(null));
    stream.on("end", () => finish(null));
  });
}

function updateSessionsIndex(projectDir: string, sessionId: string, patch: { messageCount: number }): void {
  const indexFile = path.join(projectDir, "sessions-index.json");
  if (!fs.existsSync(indexFile)) return;
  const raw = fs.readFileSync(indexFile, "utf8");
  const parsed = JSON.parse(raw) as any;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) return;
  const now = Date.now();
  let changed = false;
  for (const ent of parsed.entries) {
    if (!ent || typeof ent !== "object") continue;
    if (String(ent.sessionId ?? "") !== sessionId) continue;
    ent.fileMtime = now;
    ent.modified = new Date(now).toISOString();
    ent.messageCount = Math.max(0, Math.floor(Number(patch.messageCount ?? 0)));
    changed = true;
    break;
  }
  if (!changed) return;
  fs.writeFileSync(indexFile, JSON.stringify(parsed, null, 2), "utf8");
}

async function countNonSidechainUsers(sessionFilePath: string): Promise<number> {
  let count = 0;
  const input = fs.createReadStream(sessionFilePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const parsed = safeJson(String(line ?? ""));
    if (!parsed) continue;
    // 与 findByteLenAfterNthUserTurn 保持一致：isSidechain !== true（包含 false 与 undefined）
    if (parsed.type === "user" && parsed.isSidechain !== true) count += 1;
  }
  rl.close();
  return count;
}

function normalizeFsPath(p: string): string | null {
  const s = String(p ?? "").trim();
  if (!s) return null;
  try {
    return path.resolve(s);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  if (process.platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
