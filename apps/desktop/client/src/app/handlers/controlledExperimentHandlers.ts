import type {
  ControlledExperimentFreezeRpcRequest,
  ControlledExperimentRunStartRpcRequest,
  ControlledExperimentRunStatusRpcRequest,
  WorkspaceId,
} from "@codeflowai/shared";

import {
  ControlledExperimentExecutorError,
} from "../../experiments/controlledExperimentExecutor.js";
import { logger } from "../../logger.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { redactClientStartupText } from "../../startup/clientStartupStatus.js";

/** 固定workspace owner和诊断使用短许可，实验异步执行在许可外等待。 */
function withExperimentDatabase<T>(ctx: Pick<ApiHandlerContext, "withDatabase">, requestId: string, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase(requestId, operation) : Promise.resolve(operation());
}

/** 处理整批受控实验冻结，并把业务失败作为结构化 RPC 返回。 */
export async function handleControlledExperimentFreeze(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  await execute(ctx, req, () => withExperimentDatabase(ctx, req.id, () => requestExecutor(ctx, req).freeze(req.body as ControlledExperimentFreezeRpcRequest)));
}

/** 处理幂等 Run dispatch，响应前只保证本地证据已经落库。 */
export async function handleControlledExperimentRunStart(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  await execute(ctx, req, () => withExperimentDatabase(ctx, req.id, () => requestExecutor(ctx, req).start(req.body as ControlledExperimentRunStartRpcRequest)));
}

/** 查询 token 绑定的本地 Run 状态并触发必要的重启对账。 */
export async function handleControlledExperimentRunStatus(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  await execute(ctx, req, async () => (await withExperimentDatabase(ctx, req.id, () => requestExecutor(ctx, req))).status(req.body as ControlledExperimentRunStatusRpcRequest));
}

/** 请求取消 token 绑定的本地 Run。 */
export async function handleControlledExperimentRunCancel(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  await execute(ctx, req, async () => (await withExperimentDatabase(ctx, req.id, () => requestExecutor(ctx, req))).cancel(req.body as ControlledExperimentRunStatusRpcRequest));
}

/** Server 请求沿已冻结且本机承载的工作区选择原执行 owner；裸 Run ID 不授予定位资格。 */
function requestExecutor(ctx: ApiHandlerContext, req: ApiRequestMessage): ApiHandlerContext["controlledExperiments"] {
  const workspaceId = normalizeOptionalText(asRecord(req.body).workspaceId) ?? ctx.db.workspaceId;
  if (!workspaceId || !ctx.workspaces.has(workspaceId as WorkspaceId)) {
    throw new ControlledExperimentExecutorError(400, "LOCAL_EVIDENCE_MISSING", "受控实验工作区不存在或未指定");
  }
  if (ctx.db.workspaceId && ctx.db.workspaceId !== workspaceId) {
    throw new ControlledExperimentExecutorError(409, "CONTROLLED_EXPERIMENT_CONFLICT", "受控实验工作区与请求作用域不一致");
  }
  return ctx.controlledExperiments.forWorkspace(workspaceId as WorkspaceId);
}

/** 统一发送受控实验 RPC 响应，内部异常只进入带主键日志。 */
async function execute(
  ctx: ApiHandlerContext,
  req: ApiRequestMessage,
  operation: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    const body = await operation();
    ctx.send({ t: "api.res", id: req.id, status: 200, body });
  } catch (error) {
    const request = asRecord(req.body);
    const experimentId = normalizeOptionalText(request.experimentId);
    const runId = normalizeOptionalText(request.runId);
    const workspaceId = normalizeOptionalText(request.workspaceId) ?? ctx.db.workspaceId;
    const data = {
      code: error instanceof ControlledExperimentExecutorError ? error.code : "CONTROLLED_EXPERIMENT_RPC_FAILED",
      requestId: req.id,
      method: req.method,
      experimentId,
      runId,
      workspaceId,
      rootCause: redactClientStartupText(error instanceof Error ? error.message : String(error)),
    };
    if (workspaceId && ctx.workspaces.has(workspaceId as WorkspaceId)) {
      try { await withExperimentDatabase(ctx, req.id, () => ctx.db.writeWorkspaceLog(workspaceId as WorkspaceId, { level: "error", tag: "controlled-experiment", message: "client RPC failed", data })); }
      catch (logError) { throw new AggregateError([error, logError], "受控实验请求与错误日志均失败", { cause: error }); }
    } else logger.error("controlled-experiment", "client RPC failed", data);
    if (error instanceof ControlledExperimentExecutorError) {
      const body = (error.code === "LOCAL_EVIDENCE_MISSING" && experimentId && runId)
        ? { ok: false, experimentId, runId, code: error.code }
        : { ok: false, code: error.code, message: error.message };
      ctx.send({ t: "api.res", id: req.id, status: error.status, body });
      return;
    }
    ctx.send({
      t: "api.res",
      id: req.id,
      status: 500,
      body: { ok: false, code: "INTERNAL_ERROR", message: "受控实验 Client 内部错误" },
    });
  }
}

/** 将未知请求体收窄为普通记录。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 读取日志与失败合同所需的可空文本身份。 */
function normalizeOptionalText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}
