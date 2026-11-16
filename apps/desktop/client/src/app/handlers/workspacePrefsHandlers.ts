import type { WorkspaceId } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { describeWorkspaceProfileFailure } from "../../db/clientDb.js";
import type { PersistedWorkspacePref } from "../../db/repos/workspacePrefsRepo.js";
import { WorkspaceOperationGateError } from "../../workspace-migration/workspaceOperationGate.js";

/** 处理 `workspacePrefs.get`：读取工作区级偏好（workMode 等）。 */
export function handleWorkspacePrefsGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  let rows: PersistedWorkspacePref[];
  try { rows = ctx.db.withWorkspacePrefs(workspaceId, repo => repo.listByWorkspace(workspaceId)); }
  catch (error) {
    recordStorageFailure(ctx, req, workspaceId, error);
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "工作区偏好存储失败" } });
    return;
  }
  const prefs = rows.map((r) => ({
    engine: r.engine,
    workMode: "general" as const,
    contextWindow: r.contextWindow,
    autoCompactPct: r.autoCompactPct,
  }));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, prefs } });
}

/** 处理 `workspacePrefs.save`：保存工作区级偏好。 */
export function handleWorkspacePrefsSave(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const prefs = (req.body as any)?.prefs;
  if (!workspaceId || !Array.isArray(prefs)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/prefs" } });
    return;
  }
  if (!ctx.workspaces.has(workspaceId)) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const inputs = prefs
    .filter((p: any) => typeof p?.engine === "string" && typeof p?.workMode === "string")
    .map((p: any) => ({
      workspaceId,
      engine: String(p.engine),
      workMode: "general",
      contextWindow: typeof p.contextWindow === "number" ? p.contextWindow : null,
      autoCompactPct: typeof p.autoCompactPct === "number" ? p.autoCompactPct : null,
    }));

  let saved: PersistedWorkspacePref[];
  try { saved = ctx.db.withWorkspacePrefs(workspaceId, repo => repo.upsertMany(inputs)); }
  catch (error) {
    recordStorageFailure(ctx, req, workspaceId, error);
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, code: "INTERNAL_ERROR", message: "工作区偏好存储失败" } });
    return;
  }
  const result = saved.map((r) => ({
    engine: r.engine,
    workMode: "general" as const,
    contextWindow: r.contextWindow,
    autoCompactPct: r.autoCompactPct,
  }));
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, prefs: result } });
}

/** 只翻译存储失败；gate 交中央 409，日志双错用内部标识保双因向上传播。 */
function recordStorageFailure(ctx: ApiHandlerContext, req: ApiRequestMessage, workspaceId: WorkspaceId, error: unknown): void {
  if (error instanceof WorkspaceOperationGateError) throw error;
  try {
    ctx.db.writeWorkspaceLog(workspaceId, { level: "error", tag: "workspace-prefs", message: "workspace prefs storage failed", data: {
      errorCode: "WORKSPACE_PREFS_STORAGE_FAILED", requestId: req.id, method: req.method, workspaceId,
      event: { category: "database", action: req.method, outcome: "fail" },
      rootCause: describeWorkspaceProfileFailure(error),
    } });
  } catch (logError) {
    throw Object.assign(new AggregateError([error, logError], "WORKSPACE_PREFS_FAILURE_LOG_FAILED", { cause: error }), {
      code: "WORKSPACE_PREFS_FAILURE_LOG_FAILED",
    });
  }
  ctx.onApiFailureLogged?.();
}

