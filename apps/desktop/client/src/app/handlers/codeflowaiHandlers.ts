import type { CodeflowaiConfig, WorkspaceId } from "@codeflowai/shared";

import { ensureCodeflowaiConfig, workflowDocsRootMigration, writeCodeflowaiConfig } from "../../codeflowai/codeflowaiConfig.js";
import { hasActiveKnowledgeGeneration } from "../../knowledge/knowledgeGenerationService.js";
import { hasActiveKnowledgeUpdate } from "../../knowledge/knowledgeUpdateService.js";
import { logger } from "../../logger.js";
import { WorkspaceOperationGateError } from "../../workspace-migration/workspaceOperationGate.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";

/** 处理 `codeflowai.config.get`：读取（必要时创建）`<workspace>/.codeflowai/codeflowai.json`。 */
export function handleCodeflowaiConfigGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  const rep = ensureCodeflowaiConfig(workspacePath);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: rep.path, config: rep.config } });
}

/** 配置保存独占写门禁；文档迁移前检查已有运行事实，成功迁移后才切换配置。 */
export async function handleCodeflowaiConfigSet(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const config = ((req.body as any)?.config ?? null) as CodeflowaiConfig | null;
  if (!workspaceId || !config) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/config" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }

  let release: (() => void) | undefined;
  try {
    // 此入口自行取得独占权，不能同时登记短写操作，否则会等待自身排空。
    release = await ctx.workspaceOperationGate?.acquireMigration(workspaceId, `config:${req.id}`);
    if (workflowDocsRootMigration(workspacePath, config)) {
      if (!release || !ctx.workspaceMigrationActivityInspector) throw new Error("文档迁移缺少工作区活动检查，未修改配置");
      const blockers = ctx.workspaceMigrationActivityInspector.inspect(workspaceId);
      if (blockers.length || hasActiveKnowledgeGeneration(workspacePath) || hasActiveKnowledgeUpdate(workspacePath)) {
        throw new WorkspaceOperationGateError("WORKSPACE_MIGRATION_BUSY", "工作区仍有运行中或排队中的任务，请结束后再修改文档目录", { workspaceId, blockers });
      }
    }
    const rep = writeCodeflowaiConfig(workspacePath, config);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, path: rep.path, config: rep.config } });
  } catch (e) {
    const code = e instanceof WorkspaceOperationGateError ? e.code : "CODEFLOWAI_CONFIG_SAVE_FAILED";
    const message = e instanceof Error ? e.message : String(e);
    logger.error("codeflowai-config", "project config save failed", { code, requestId: req.id, workspaceId, workflowDocsRoot: config.paths?.workflowDocsRoot, rootCause: message, blockers: e instanceof WorkspaceOperationGateError ? e.details.blockers : undefined, causes: e instanceof AggregateError ? e.errors.map(error => error instanceof Error ? error.message : String(error)) : undefined });
    ctx.send({ t: "api.res", id: req.id, status: e instanceof WorkspaceOperationGateError ? 409 : 400, body: { ok: false, code, message, requestId: req.id } });
  } finally { release?.(); }
}


