import type { KnowledgeUpdateView, WorkspaceId } from "@codeflowai/shared";
import type { ApiHandlerContext } from "../app/handleApiRequest.js";
import { executeDesktopApiRequest } from "../app/executeDesktopApiRequest.js";
import { KnowledgeAssetStore } from "./knowledgeAssetStore.js";
import { KnowledgeUpdateService, knowledgeUpdateFailure } from "./knowledgeUpdateService.js";
import { combineKnowledgeGenerationFailure, describeKnowledgeGenerationFailure, writeKnowledgeGenerationLog } from "./knowledgeGenerationEngine.js";

/** 复用分钟 tick；派发到结算期间登记工作区活动，避免目录迁移后迟到写回旧路径。 */
export async function tickKnowledgeUpdates(input: {
  context: Pick<ApiHandlerContext, "db" | "workspaces" | "clientId" | "workspaceOperationGate" | "scheduledTaskScheduler" | "withDatabase">;
  dispatch: (workspaceId: string, scheduledAt: number) => Promise<KnowledgeUpdateView>;
}): Promise<void> {
  const errors: unknown[] = [];
  for (const [workspaceId, workspacePath] of input.context.workspaces) {
    input.context.scheduledTaskScheduler?.assertProjectTasksAccepting();
    if (input.context.workspaceOperationGate?.getMigrationOperationId(workspaceId as WorkspaceId)) continue;
    let scheduledAt: number | null = null;
    let updates: KnowledgeUpdateService | null = null;
    let releaseActivity: (() => void) | undefined;
    let failure: { reason: unknown } | undefined;
    try {
      updates = new KnowledgeUpdateService(new KnowledgeAssetStore(workspacePath), input.context.clientId, workspaceId, input.context.db, input.context.withDatabase);
      scheduledAt = updates.dueAt();
      if (scheduledAt !== null) {
        releaseActivity = input.context.workspaceOperationGate?.beginActivity(workspaceId as WorkspaceId, { type: "knowledge_update_dispatch", resourceId: `${updates.schedule()!.id}:${scheduledAt}` });
        await input.dispatch(updates.schedule()!.selectedWorkspaceId, scheduledAt);
      }
    } catch (error) {
      failure = { reason: error };
      let projection!: { code: string; message: string };
      let diagnosed = false;
      try {
        const diagnose = () => writeKnowledgeGenerationLog(input.context.db, workspaceId, () => {
          projection = knowledgeUpdateFailure(error);
          return { level: "error", tag: "knowledge-updates", message: "knowledge update dispatch failed", data: {
            code: projection.code, requestId: `knowledge-update-${workspaceId}-${scheduledAt ?? "read"}`, workspaceId,
            scheduledAt, clientId: input.context.clientId, rootCause: describeKnowledgeGenerationFailure(error),
          } };
        }, { reason: error });
        if (input.context.withDatabase) await input.context.withDatabase(`knowledge-update-${workspaceId}-${scheduledAt ?? "read"}`, diagnose);
        else diagnose();
        diagnosed = true;
      } catch (diagnosticError) { failure = { reason: diagnosticError }; }
      if (diagnosed && updates && scheduledAt !== null) {
        try { updates.recordDispatchFailure(scheduledAt, projection); }
        catch (stateError) { failure = { reason: combineKnowledgeGenerationFailure(error, stateError) }; }
      }
    } finally {
      try { releaseActivity?.(); }
      catch (releaseError) { failure = { reason: failure ? combineKnowledgeGenerationFailure(failure.reason, releaseError) : releaseError }; }
    }
    if (failure) errors.push(failure.reason);
  }
  if (errors.length) throw new AggregateError(errors, "定时知识更新失败，请查看知识库的定时更新记录");
}

/** Client API key 只发给当前 Server；HTTP 返回表示已领取检查，不等待模型完成。 */
export async function dispatchKnowledgeUpdate(input: { serverWsUrl: string; apiKey: string; clientId: string; workspaceId: string; scheduledAt: number }): Promise<KnowledgeUpdateView> {
  const url = new URL(input.serverWsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/api/client/knowledge-updates/run";
  url.search = ""; url.hash = "";
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({ clientId: input.clientId, workspaceId: input.workspaceId, scheduledAt: input.scheduledAt }), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json() as { ok?: boolean; data?: KnowledgeUpdateView; code?: string; message?: string; requestId?: string };
  if (!response.ok || body.ok !== true || !body.data) throw Object.assign(new Error(body.message || `定时更新请求失败（HTTP ${response.status}）`), { code: body.code, requestId: body.requestId });
  return body.data;
}

/** 桌面定时检查复用本机知识 API 的身份及工作区校验，不建立 Server 连接。 */
export async function dispatchDesktopKnowledgeUpdate(context: ApiHandlerContext, workspaceId: string, scheduledAt: number): Promise<KnowledgeUpdateView> {
  const requestId = `knowledge-update-${workspaceId}-${scheduledAt}`;
  const response = await executeDesktopApiRequest(context, { method: "knowledge.assets.update.run", body: { workspaceId } }, { requestId, clientVersion: null, startedAt: Date.now() });
  const body = response.body as { ok?: boolean; data?: KnowledgeUpdateView; code?: string; message?: string; details?: unknown };
  if (response.status !== 200 || body.ok !== true || !body.data) throw Object.assign(new Error(body.message || "本机规格定时检查失败"), { code: body.code, requestId, details: body.details });
  return body.data;
}
