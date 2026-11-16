import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import type { ClientDb } from "../db/clientDb.js";
import { isBinaryFile } from "../fs/fsHelpers.js";
import { guessTextSnapshotEncoding, type FileSnapshotEncoding } from "../fs/textEncoding.js";

type SnapshotInput = {
  db: Pick<ClientDb, "fileChanges" | "blobs" | "writeWorkspaceLog">;
  workspacePath: string;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  turnId: TurnId;
  path: string;
  capturedAt: number;
  stepKey?: string | null;
  eventSeq?: number;
  itemId?: string;
};

type FileSnapshot = { exists: boolean; data: Buffer | null; encoding: FileSnapshotEncoding };
type SnapshotResult = { ok: true; snapshot: FileSnapshot } | { ok: false; error: unknown };
export type FrozenFileBeforeSnapshot = { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId;
  path: string; capturedAt: number; stepKey?: string | null;
  result: { ok: true; snapshot: { exists: boolean; data: string | null; encoding: FileSnapshotEncoding } } | { ok: false; code: string; fingerprint: string } };
export type FrozenFileAfterSnapshot = FrozenFileBeforeSnapshot & {
  itemId: string; changeKind: string | null; diffText: string | null; toolStatus?: string;
};

/** 在事件最早可观察时点冻结文件，不能等数据库许可后再读取工具已修改的内容。 */
export function freezeFileBeforeSnapshot(input: Omit<SnapshotInput, "db">): FrozenFileBeforeSnapshot {
  const result = readSnapshot(input.workspacePath, input.path);
  return { workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId, path: input.path,
    capturedAt: input.capturedAt, ...(input.stepKey !== undefined ? { stepKey: input.stepKey } : {}),
    result: result.ok ? { ok: true, snapshot: { ...result.snapshot, data: result.snapshot.data?.toString("base64") ?? null } } : { ok: false, code: typeof (result.error as { code?: unknown })?.code === "string"
      ? (result.error as { code: string }).code : "FILE_SNAPSHOT_READ_FAILED",
      fingerprint: crypto.createHash("sha256").update(result.error instanceof Error ? result.error.message : typeof result.error).digest("hex") } };
}

/** 完成事件发出时冻结after，重启恢复只消费此证据，不再读取可变化的工作区文件。 */
export function freezeFileAfterSnapshot(input: Omit<SnapshotInput, "db"> & {
  itemId: string; changeKind: string | null; diffText: string | null; toolStatus?: string;
}): FrozenFileAfterSnapshot {
  return { ...freezeFileBeforeSnapshot(input), itemId: input.itemId,
    changeKind: input.changeKind, diffText: input.diffText, ...(input.toolStatus !== undefined ? { toolStatus: input.toolStatus } : {}) };
}

/** 仅保存有真实before与完成时after的同一turn证据；缺失时保留未确认批次并显式失败。 */
export function persistFrozenFileAfterSnapshot(db: SnapshotInput["db"], frozen: FrozenFileAfterSnapshot): void {
  const before = db.fileChanges.get(frozen.threadId, frozen.turnId, frozen.path);
  if (!before || before.beforeExists && (!before.beforeBlobId || !db.blobs.get(before.beforeBlobId))) {
    throw new Error("LOCAL_EVENT_FILE_BEFORE_EVIDENCE_MISSING", { cause: {
      workspaceId: frozen.workspaceId, threadId: frozen.threadId, turnId: frozen.turnId, itemId: frozen.itemId, path: frozen.path,
    } });
  }
  if (!frozen.result.ok || frozen.result.snapshot.exists && frozen.result.snapshot.data === null) {
    throw new Error("LOCAL_EVENT_FILE_AFTER_EVIDENCE_UNAVAILABLE", { cause: {
      workspaceId: frozen.workspaceId, threadId: frozen.threadId, turnId: frozen.turnId, itemId: frozen.itemId, path: frozen.path,
      ...(!frozen.result.ok ? { rootCause: frozen.result } : { rootCause: "FILE_SNAPSHOT_CONTENT_UNAVAILABLE" }),
    } });
  }
  const snapshot = frozen.result.snapshot;
  const data = snapshot.data !== null ? Buffer.from(snapshot.data, "base64") : null;
  const afterBlobId = snapshot.exists && data ? db.blobs.put(data, snapshot.encoding) : null;
  db.fileChanges.captureAfter({ ...frozen, afterExists: snapshot.exists, afterBlobId,
    diffText: frozen.toolStatus === "failed" ? null : frozen.diffText });
}

/** 原首次before规则保存冻结证据；失败哨兵保留，不能用重试时文件状态补造。 */
export function persistFrozenFileBeforeSnapshot(db: SnapshotInput["db"], frozen: FrozenFileBeforeSnapshot): void {
  if (db.fileChanges.get(frozen.threadId, frozen.turnId, frozen.path)) return;
  if (!frozen.result.ok) {
    persistUnavailableSnapshot({ ...frozen, db, workspacePath: "" }, "before", Object.assign(new Error("Frozen file snapshot unavailable"), frozen.result));
    return;
  }
  const snapshot = frozen.result.snapshot;
  const data = snapshot.data !== null ? Buffer.from(snapshot.data, "base64") : null;
  const blobId = snapshot.exists && data ? db.blobs.put(data, snapshot.encoding) : null;
  db.fileChanges.captureBefore({ ...frozen, beforeExists: snapshot.exists, beforeBlobId: blobId });
}

/** 只隔离工作区读取失败；blob/索引持久化必须在此边界之外，不能被误判成普通文件故障。 */
function readSnapshot(workspacePath: string, relativePath: string): SnapshotResult {
  const absolutePath = path.resolve(workspacePath, relativePath.split("/").join(path.sep));
  try {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { ok: true, snapshot: { exists: false, data: null, encoding: "binary" } };
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw Object.assign(new Error("路径不是普通文件，无法获取回滚快照"), {
        code: "FILE_SNAPSHOT_NOT_REGULAR_FILE", mode: stat.mode,
        fileType: stat.isDirectory() ? "directory" : "other",
      });
    }
    // 与现有快照上限一致；无 blob 的大文件仍由回滚校验显式拒绝。
    if (stat.size > 2_000_000) {
      return { ok: true, snapshot: { exists: true, data: null, encoding: "binary" } };
    }
    const data = fs.readFileSync(absolutePath);
    return { ok: true, snapshot: {
      exists: true, data, encoding: isBinaryFile(relativePath) ? "binary" : guessTextSnapshotEncoding(data),
    } };
  } catch (error) {
    // stat 后消失也不能当作已确认删除：读取期间存在竞争，保留缺失证据状态。
    return { ok: false, error };
  }
}

/** 每个 turn/path 只记录首次 before；失败哨兵与有效基线一样不可被后续磁盘状态覆盖。 */
export function captureFileChangeBeforeSnapshot(input: SnapshotInput): "captured" | "unavailable" | "existing" {
  if (input.db.fileChanges.get(input.threadId, input.turnId, input.path)) return "existing";
  const result = readSnapshot(input.workspacePath, input.path);
  if (!result.ok) {
    persistUnavailableSnapshot(input, "before", result.error);
    return "unavailable";
  }
  const snap = result.snapshot;
  const blobId = snap.exists && snap.data ? input.db.blobs.put(snap.data, snap.encoding) : null;
  input.db.fileChanges.captureBefore({ ...input, beforeExists: snap.exists, beforeBlobId: blobId });
  return "captured";
}

/** 完成事件只按磁盘实况记录 after；失败工具也可能部分写入，不能仅凭状态丢掉变更证据。 */
export function captureFileChangeAfterSnapshot(input: SnapshotInput & {
  changeKind: string | null;
  diffText: string | null;
  toolStatus?: string;
}): "captured" | "unavailable" {
  const result = readSnapshot(input.workspacePath, input.path);
  if (!result.ok) {
    persistUnavailableSnapshot(input, "after", result.error);
    return "unavailable";
  }
  const snap = result.snapshot;
  if (!input.db.fileChanges.get(input.threadId, input.turnId, input.path)) {
    // failed 的 add 只是写入意图，不能据此认定原文件不存在并允许自动删除。
    const beforeExists = input.toolStatus === "failed"
      ? true
      : inferBeforeExists(input.changeKind, snap.exists);
    input.db.fileChanges.captureBefore({ ...input, beforeExists, beforeBlobId: null });
  }
  const blobId = snap.exists && snap.data ? input.db.blobs.put(snap.data, snap.encoding) : null;
  input.db.fileChanges.captureAfter({
    ...input, afterExists: snap.exists, afterBlobId: blobId,
    diffText: input.toolStatus === "failed" ? null : input.diffText,
  });
  return "captured";
}

/** 持久保存保守的缺快照哨兵，使重启后的撤销/回滚仍拒绝推测文件状态。 */
function persistUnavailableSnapshot(input: SnapshotInput, phase: "before" | "after", cause: unknown): void {
  try {
    if (!input.db.fileChanges.get(input.threadId, input.turnId, input.path)) {
      input.db.fileChanges.captureBefore({ ...input, beforeExists: true, beforeBlobId: null });
    }
    if (phase === "after") {
      // 必须清除上一次成功的 after，不能让旧快照伪装成本次操作后的状态。
      input.db.fileChanges.captureAfter({ ...input, afterExists: true, afterBlobId: null });
    }
  } catch (error) {
    throw new AggregateError([cause, error], "文件快照失败且无法持久化回滚保护", { cause: error });
  }
  try {
    const descriptor = (key: string): unknown => {
      if (cause === null || typeof cause !== "object" && typeof cause !== "function") return undefined;
      const own = Object.getOwnPropertyDescriptor(cause, key);
      return own && "value" in own ? own.value : undefined;
    };
    const code = descriptor("code"), message = descriptor("message");
    input.db.writeWorkspaceLog(input.workspaceId, { level: "error", tag: "file-change-snapshot",
      message: "file snapshot unavailable; automatic rollback blocked", data: {
        code: "FILE_CHANGE_SNAPSHOT_UNAVAILABLE", requestId: `file-snapshot:${input.itemId ?? input.turnId}:${phase}`,
        workspaceId: input.workspaceId, threadId: input.threadId, turnId: input.turnId,
        itemId: input.itemId ?? null, eventSeq: input.eventSeq ?? null, path: input.path, phase, disposition: "file_snapshot_unavailable",
        rootCause: { type: typeof cause, ...(typeof code === "string" && /^[A-Z0-9_]{1,96}$/u.test(code) ? { code } : {}),
          ...(typeof message === "string" ? { fingerprint: crypto.createHash("sha256").update(message).digest("hex") } : {}) },
      } });
  } catch (diagnosticError) {
    throw new AggregateError([cause, diagnosticError], "文件快照保护已保存，但诊断失败", { cause });
  }
}

function inferBeforeExists(kind: string | null, afterExists: boolean): boolean {
  const value = String(kind ?? "").trim().toLowerCase();
  if (["create", "created", "add", "added"].includes(value)) return false;
  if (["delete", "deleted", "remove", "removed", "modify", "modified", "edit", "edited"].includes(value)) return true;
  return afterExists;
}
