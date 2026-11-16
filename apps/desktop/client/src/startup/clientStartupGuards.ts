import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";

const CLIENT_ID_META_KEY = "client_id";

export type ClientProcessLock = {
  lockPath: string;
  release: () => void;
};

export type MissingStartupWorkspace = {
  workspaceId: WorkspaceId;
  workspacePath: string;
  cause: NodeJS.ErrnoException;
};

type LockFilePayload = {
  token: string;
  pid: number;
  clientId: string;
  dbPath: string;
  startedAt: number;
};

/** 异步确认启动工作区；仅排除明确不存在的根，其他文件系统错误继续阻断启动。 */
export async function selectStartupWorkspaces(
  candidates: ReadonlyArray<{ id: WorkspaceId; path: string }>,
): Promise<{ workspaces: Map<WorkspaceId, string>; missingWorkspaces: MissingStartupWorkspace[] }> {
  const inspections = await Promise.all(candidates.map(async (candidate) => {
    const workspacePath = String(candidate.path ?? "").trim();
    if (!workspacePath) throw new Error(`工作区路径为空：${String(candidate.id)}`);
    let workspaceStat: fs.Stats;
    try {
      workspaceStat = await fs.promises.stat(workspacePath);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
      return {
        kind: "missing" as const,
        missingWorkspace: {
          workspaceId: candidate.id,
          workspacePath,
          cause: error as NodeJS.ErrnoException,
        },
      };
    }
    if (!workspaceStat.isDirectory()) {
      throw Object.assign(new Error(`工作区路径不是目录：${workspacePath}`), { code: "ENOTDIR" });
    }
    return { kind: "available" as const, workspaceId: candidate.id, workspacePath };
  }));

  const workspaces = new Map<WorkspaceId, string>();
  const missingWorkspaces: MissingStartupWorkspace[] = [];
  for (const inspection of inspections) {
    if (inspection.kind === "missing") missingWorkspaces.push(inspection.missingWorkspace);
    else workspaces.set(inspection.workspaceId, inspection.workspacePath);
  }
  return { workspaces, missingWorkspaces };
}

/** 禁止默认用户 DB 被临时 CODEFLOWAI_CLIENT_ID 覆盖污染。 */
export function assertClientIdOverrideAllowed(input: {
  dbPath: string;
  clientIdSource: "env" | "config" | "db-meta" | "hostname";
  allowOverride: boolean;
}): void {
  if (input.clientIdSource !== "env") return;
  if (input.allowOverride) return;
  if (!isDefaultClientDbPath(input.dbPath)) return;
  throw new Error(
    "默认 CodeFlow DB 不允许直接覆盖 CODEFLOWAI_CLIENT_ID；如需调试临时 client，请同时使用独立 CODEFLOWAI_CLIENT_DB_PATH，或显式设置 CODEFLOWAI_ALLOW_CLIENT_ID_OVERRIDE=1。",
  );
}

/** 确保同一个 Client DB 绑定的 clientId 不会在后续启动中漂移。 */
export function ensureStableClientId(db: Pick<ClientDb, "db">, clientId: string): void {
  const normalizedClientId = String(clientId ?? "").trim();
  if (!normalizedClientId) throw new Error("clientId 不能为空");

  const storedClientId = readBoundClientId(db);
  if (!storedClientId) {
    db.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)").run(CLIENT_ID_META_KEY, normalizedClientId);
    return;
  }
  if (storedClientId !== normalizedClientId) {
    throw new Error(
      `本地 DB 已绑定 clientId=${storedClientId}，当前启动 clientId=${normalizedClientId}；同一个 DB 不允许更换 clientId。`,
    );
  }
}

/** 读取本地 DB 已绑定的 clientId；未绑定时返回空字符串。 */
export function readBoundClientId(db: Pick<ClientDb, "db">): string {
  const row = db.db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(CLIENT_ID_META_KEY) as { value?: string | null } | undefined;
  return String(row?.value ?? "").trim();
}

/** 获取当前 DB 的单实例写入锁，避免多个 client 进程同时写同一个 SQLite。 */
export function acquireClientProcessLock(input: { dbPath: string; clientId: string }): ClientProcessLock {
  const lockPath = buildClientProcessLockPath(input.dbPath);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const payload: LockFilePayload = {
    token: crypto.randomUUID(),
    pid: process.pid,
    clientId: String(input.clientId ?? "").trim(),
    dbPath: normalizePath(input.dbPath),
    startedAt: Date.now(),
  };

  while (true) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { encoding: "utf8", flag: "wx" });
      return createClientProcessLock(lockPath, payload);
    } catch (error) {
      if (!isNodeErrorCode(error, "EEXIST")) throw error;
      const existing = readLockFile(lockPath);
      if (isClientProcessRunning(existing.pid)) {
        throw new Error(
          `已有 CodeFlow client 正在使用同一个 DB：pid=${existing.pid}, clientId=${existing.clientId}, dbPath=${existing.dbPath}`,
        );
      }
      fs.unlinkSync(lockPath);
    }
  }
}

/** 构造与 DB 路径一一对应的 lock 文件路径。 */
export function buildClientProcessLockPath(dbPath: string): string {
  const normalizedDbPath = normalizePath(dbPath);
  const digest = crypto.createHash("sha1").update(normalizedDbPath).digest("hex").slice(0, 12);
  return path.join(path.dirname(normalizedDbPath), `client.${digest}.lock`);
}

/** 创建可释放的进程锁句柄，释放时只删除自己创建的锁文件。 */
function createClientProcessLock(lockPath: string, payload: LockFilePayload): ClientProcessLock {
  let released = false;
  return {
    lockPath,
    release() {
      if (released) return;
      released = true;
      if (!fs.existsSync(lockPath)) return;
      const existing = readLockFile(lockPath);
      if (existing.token === payload.token && existing.pid === payload.pid) {
        fs.unlinkSync(lockPath);
      }
    },
  };
}

/** 读取并校验已有 lock 文件，无法确认归属时交给人工处理。 */
function readLockFile(lockPath: string): LockFilePayload {
  const raw = fs.readFileSync(lockPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`CodeFlow client lock 文件无法解析，请人工检查：${lockPath}`, { cause: error });
  }

  const pid = Number((parsed as any)?.pid ?? 0);
  const token = String((parsed as any)?.token ?? "").trim();
  const clientId = String((parsed as any)?.clientId ?? "").trim();
  const dbPath = String((parsed as any)?.dbPath ?? "").trim();
  const startedAt = Number((parsed as any)?.startedAt ?? 0);
  if (!Number.isInteger(pid) || pid <= 0 || !token || !clientId || !dbPath) {
    throw new Error(`CodeFlow client lock 文件内容无效，请人工检查：${lockPath}`);
  }
  return { token, pid, clientId, dbPath, startedAt };
}

/** 判断 PID 是否仍存活；权限不足说明进程存在但当前用户不可探测。 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    if (isNodeErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

/** 检查 Client 进程是否仍存在；Windows 复核镜像，探测错误继续向调用边界抛出。 */
export function isClientProcessRunning(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!isProcessRunning(pid)) return false;
  if (process.platform !== "win32") return true;
  return readWindowsProcessImageName(pid) === path.basename(process.execPath).toLowerCase();
}

/** 从完整 CSV 列表核对 PID，避免把本地化的无匹配提示或异常输出当作进程退出。 */
function readWindowsProcessImageName(pid: number): string | null {
  const output = childProcess.execFileSync("tasklist", ["/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 2000,
  }).trim();
  const lines = output.split(/\r?\n/u).filter(line => line.trim());
  if (!lines.length) throw new Error(`无法核验 Client 进程：tasklist 返回空列表，pid=${pid}`);
  let image: string | null = null;
  for (const line of lines) {
    const match = /^"((?:[^"]|"")*)","(\d+)",/u.exec(line);
    if (!match) throw new Error(`无法核验 Client 进程：tasklist 返回无效 CSV，pid=${pid}`);
    if (Number(match[2]) === pid) image = match[1].replace(/""/gu, "\"").trim().toLowerCase();
  }
  return image;
}
/** 判断当前 DB 是否为默认用户级 CodeFlow DB。 */
function isDefaultClientDbPath(dbPath: string): boolean {
  const defaultDbPath = path.join(os.homedir(), ".codeflowai", "codeflowai.db");
  return normalizePath(dbPath) === normalizePath(defaultDbPath);
}

/** 规范化路径用于跨平台比较和锁文件 hash。 */
function normalizePath(value: string): string {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 判断 Node 系统异常的 code，避免按 message 文本分支。 */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error != null && (error as NodeJS.ErrnoException).code === code;
}
