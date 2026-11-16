import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ThreadFileChangeSummary, ThreadId, WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { resolveThreadRunningState } from "../threadRunningState.js";
import { decodeSnapshotText } from "../../fs/textEncoding.js";

/** 处理 `threads.fileChanges.list`：列出某 thread 的聚合文件变更。 */
export function handleThreadsFileChangesList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  const aggregated = ctx.db.fileChanges.listAggregatedByThread(threadId);
  const items: ThreadFileChangeSummary[] = aggregated.map((c) => ({
    path: c.path,
    status: c.status,
    lastTurnId: c.lastTurnId,
    lastChangedAt: c.lastChangedAt,
    canUndo: !c.baseBeforeExists || Boolean(c.baseBeforeBlobId),
    stepKey: c.stepKey,
    isAccepted: c.isAccepted,
    acceptedBlobId: c.acceptedBlobId,
  }));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, items } });
}

/** 处理 `threads.fileChanges.diff`：读取指定文件的基线/当前快照，用于展示差异。 */
export function handleThreadsFileChangesDiff(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const filePath = String((req.body as any)?.path ?? "").trim();
  if (!workspaceId || !threadId || !filePath) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/path" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  const records = ctx.db.fileChanges.listByThreadAndPath(threadId, filePath);
  if (!records.length) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "未找到文件变更记录" } });
    return;
  }
  const first = records[0]!;
  const last = records[records.length - 1]!;

  const maxTextBytes = 200 * 1024;

  // 基线优先用 accepted（用户手动推进的 diff 基准），fallback 到会话起点。
  const acceptedBlobId = ctx.db.fileChanges.getAcceptedBlobId(threadId, filePath);
  const baselineExists = acceptedBlobId ? true : first.beforeExists;
  const baselineBlobId = acceptedBlobId ?? first.beforeBlobId;

  const before = baselineExists && baselineBlobId ? ctx.db.blobs.get(baselineBlobId) : null;
  const after = last.afterExists && last.afterBlobId ? ctx.db.blobs.get(last.afterBlobId) : null;

  const beforeText = before ? decodeSnapshotText(before.data, before.encoding, maxTextBytes) : null;
  const afterText = after ? decodeSnapshotText(after.data, after.encoding, maxTextBytes) : null;
  const isBinary = Boolean((before && beforeText == null) || (after && afterText == null));

  const diffText = typeof last.diffText === "string" && last.diffText.trim() ? last.diffText : null;
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: filePath, isBinary, beforeText, afterText, diffText } });
}

/** 处理 `threads.fileChanges.undo`：撤销指定文件（或全部文件）的会话变更。 */
export function handleThreadsFileChangesUndo(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const paths = Array.isArray((req.body as any)?.paths) ? ((req.body as any).paths as unknown[]) : null;
  const requested = paths ? paths.map((p) => String(p ?? "").trim()).filter(Boolean) : null;
  if (!workspaceId || !threadId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  // 运行中禁止撤销，避免与引擎写文件冲突。
  const running = resolveThreadRunningState(ctx, { workspaceId, threadId });
  if (running) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "thread 运行中，禁止撤销（请先停止/等待完成）" } });
    return;
  }

  const aggregated = ctx.db.fileChanges.listAggregatedByThread(threadId);
  const aggregatedByPath = new Map(aggregated.map((change) => [change.path, change]));
  const requestedPaths = requested?.length ? Array.from(new Set(requested)) : aggregated.map((change) => change.path);
  const unknownPaths = requestedPaths.filter((filePath) => !aggregatedByPath.has(filePath));
  if (unknownPaths.length > 0) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `paths 包含未知文件：${unknownPaths.join(", ")}` } });
    return;
  }

  const plans: Array<{ path: string; beforeExists: boolean; beforeBlobId: string | null }> = [];
  const preSnapshots = new Map<string, { exists: boolean; data: Buffer | null }>();
  try {
    for (const filePath of requestedPaths) {
      const current = aggregatedByPath.get(filePath)!;
      const records = ctx.db.fileChanges.listByThreadAndPath(threadId, filePath);
      if (!records.length) throw new Error(`文件变更记录不存在：${filePath}`);
      const firstRecord = records[0]!;
      const acceptedBlobId = ctx.db.fileChanges.getAcceptedBlobId(threadId, filePath);
      const baselineExists = acceptedBlobId ? true : firstRecord.beforeExists;
      const baselineBlobId = acceptedBlobId ?? firstRecord.beforeBlobId;
      if (baselineExists && !baselineBlobId) throw new Error(`缺少快照，无法撤销：${filePath}`);
      if (baselineBlobId && !ctx.db.blobs.get(baselineBlobId)) throw new Error(`快照不存在（blobId=${baselineBlobId}）：${filePath}`);

      const snapshot = readCurrentFileSnapshot(resolveWorkspaceAbsPath(workspacePath, filePath));
      assertCurrentFileMatchesSnapshot(ctx, filePath, current.currentAfterExists, current.currentAfterBlobId, snapshot);
      preSnapshots.set(filePath, snapshot);
      plans.push({ path: filePath, beforeExists: baselineExists, beforeBlobId: baselineBlobId });
    }
  } catch (cause) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: formatUndoError(cause, "撤销证据校验失败") } });
    return;
  }

  try {
    for (const plan of plans) {
      applyBaselineSnapshot(ctx, {
        workspacePath,
        relPosixPath: plan.path,
        beforeExists: plan.beforeExists,
        beforeBlobId: plan.beforeBlobId,
      });
    }
    const deleteChanges = ctx.db.db.transaction(() => {
      for (const plan of plans) ctx.db.fileChanges.deleteByThreadAndPath(threadId, plan.path);
      ctx.db.threads.touch(threadId);
    });
    deleteChanges();
  } catch (cause) {
    const failure = restoreUndoSnapshotsOrCombine(workspacePath, preSnapshots, cause);
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: failure.message } });
    return;
  }

  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, undonePaths: plans.map((plan) => plan.path), skippedPaths: [] } });
}

/** 处理 `threads.fileChanges.accept`：接受指定文件的当前变更（推进 diff 基准）。 */
export function handleThreadsFileChangesAccept(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const threadId = String((req.body as any)?.threadId ?? "").trim() as ThreadId;
  const paths = Array.isArray((req.body as any)?.paths) ? ((req.body as any).paths as unknown[]) : [];
  const requested = paths.map((p) => String(p ?? "").trim()).filter(Boolean);
  if (!workspaceId || !threadId || !requested.length) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/threadId/paths" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const thread = ctx.db.threads.get(threadId);
  if (!thread) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "thread 不存在" } });
    return;
  }
  if (thread.workspaceId !== workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 409, body: { ok: false, message: "workspace 不匹配" } });
    return;
  }

  const acceptedPaths: string[] = [];
  for (const p of requested) {
    const result = ctx.db.fileChanges.acceptFileChange(threadId, p);
    if (result.accepted) acceptedPaths.push(p);
  }
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, acceptedPaths } });
}

function applyBaselineSnapshot(
  ctx: Pick<ApiHandlerContext, "db">,
  input: { workspacePath: string; relPosixPath: string; beforeExists: boolean; beforeBlobId: string | null },
): void {
  const abs = resolveWorkspaceAbsPath(input.workspacePath, input.relPosixPath);
  if (!input.beforeExists) {
    removeUndoFileIfExists(abs, input.relPosixPath);
    return;
  }

  if (!input.beforeBlobId) throw new Error(`缺少快照，无法撤销：${input.relPosixPath}`);
  const blob = ctx.db.blobs.get(input.beforeBlobId);
  if (!blob) throw new Error(`快照不存在（blobId=${input.beforeBlobId}）：${input.relPosixPath}`);

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, blob.data);
}

/** 严格读取撤销前磁盘内容，仅 ENOENT 视为不存在。 */
function readCurrentFileSnapshot(absPath: string): { exists: boolean; data: Buffer | null } {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error(`撤销路径不是普通文件：${absPath}`);
    if (stat.size > 2_000_000) throw new Error(`文件过大，无法安全撤销：${absPath}`);
    return { exists: true, data: fs.readFileSync(absPath) };
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, data: null };
    throw cause;
  }
}

/** 验证当前磁盘仍等于最后 after 快照，避免覆盖会话外修改。 */
function assertCurrentFileMatchesSnapshot(
  ctx: Pick<ApiHandlerContext, "db">,
  filePath: string,
  expectedExists: boolean,
  expectedBlobId: string | null,
  current: { exists: boolean; data: Buffer | null },
): void {
  if (!expectedExists) {
    if (current.exists) throw new Error(`文件在会话外被重新创建：${filePath}`);
    return;
  }
  if (!current.exists) throw new Error(`文件在会话外被删除：${filePath}`);
  if (!expectedBlobId) throw new Error(`缺少修改后快照：${filePath}`);
  const expected = ctx.db.blobs.get(expectedBlobId);
  if (!expected) throw new Error(`修改后快照不存在（blobId=${expectedBlobId}）：${filePath}`);
  if (!current.data || hashFileBytes(current.data) !== hashFileBytes(expected.data)) {
    throw new Error(`文件在会话外被修改：${filePath}`);
  }
}

/** 补偿批量撤销涉及的全部文件，补偿失败与原错误一起返回。 */
function restoreUndoSnapshotsOrCombine(
  workspacePath: string,
  snapshots: Map<string, { exists: boolean; data: Buffer | null }>,
  cause: unknown,
): Error {
  const original = cause instanceof Error ? cause : new Error(formatUndoError(cause, "撤销失败"));
  const failures: Error[] = [];
  for (const [filePath, snapshot] of snapshots) {
    const abs = resolveWorkspaceAbsPath(workspacePath, filePath);
    try {
      if (!snapshot.exists) {
        removeUndoFileIfExists(abs, filePath);
      } else {
        if (!snapshot.data) throw new Error(`补偿快照内容缺失：${filePath}`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, snapshot.data);
      }
    } catch (restoreCause) {
      failures.push(restoreCause instanceof Error ? restoreCause : new Error(String(restoreCause)));
    }
  }
  return failures.length > 0
    ? new Error(`${original.message}；文件补偿失败：${failures.map((failure) => failure.message).join("；")}`, { cause: failures[0] })
    : original;
}

/** 仅删除普通文件；不存在表示目标状态已满足。 */
function removeUndoFileIfExists(absPath: string, relPath: string): void {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) throw new Error(`撤销路径不是普通文件：${relPath}`);
    fs.unlinkSync(absPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw cause;
  }
}

/** 计算文件内容 hash，用于提交前冲突检测。 */
function hashFileBytes(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** 规整撤销错误文本。 */
function formatUndoError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message) return cause.message;
  const text = String(cause ?? "").trim();
  return text || fallback;
}

function resolveWorkspaceAbsPath(workspacePath: string, relPosixPath: string): string {
  const rel = String(relPosixPath ?? "").trim();
  if (!rel) throw new Error("非法路径：空 path");
  const abs = path.resolve(workspacePath, rel.split("/").join(path.sep));
  const safeRel = path.relative(workspacePath, abs);
  if (!safeRel || safeRel === "." || safeRel.startsWith("..") || path.isAbsolute(safeRel)) {
    throw new Error(`非法路径（越界）：${relPosixPath}`);
  }
  return abs;
}

