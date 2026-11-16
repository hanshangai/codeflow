import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { setEngineModelCatalogCustomModels } from "../../engines/engineModelCatalogRuntime.js";
import { logger } from "../../logger.js";

/** 处理 `engineCustomModels.list`：列出当前 Client 的自定义模型目录。 */
export function handleEngineCustomModelsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const models = ctx.db.engineCustomModels.list();
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, models } });
  } catch (error) {
    sendModelError(ctx, req, error);
  }
}

/** 处理 `engineCustomModels.upsert`：新增或更新 Client 级自定义模型。 */
export function handleEngineCustomModelsUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const model = ctx.db.engineCustomModels.upsert(req.body as any);
    refreshRuntimeCustomModels(ctx);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, model } });
  } catch (error) {
    sendModelError(ctx, req, error);
  }
}

/** 处理 `engineCustomModels.delete`：删除 Client 级自定义模型。 */
export function handleEngineCustomModelsDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const id = String((req.body as any)?.id ?? "").trim();
  if (!id) {
    sendModelError(ctx, req, new Error("参数错误：id"));
    return;
  }

  try {
    const deleted = ctx.db.engineCustomModels.delete(id);
    if (!deleted) {
      sendModelError(ctx, req, new Error("自定义模型不存在"));
      return;
    }
    refreshRuntimeCustomModels(ctx);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (error) {
    sendModelError(ctx, req, error);
  }
}

/** 将本地目录变更同步到当前运行时，避免保存后模型列表仍使用旧快照。 */
function refreshRuntimeCustomModels(ctx: ApiHandlerContext): void {
  setEngineModelCatalogCustomModels([
    ...ctx.db.engineCustomModels.listEnabledByEngine("claude"),
    ...ctx.db.engineCustomModels.listEnabledByEngine("codex"),
  ]);
}

/** 将自定义模型错误转换为明确 HTTP 状态，避免静默成功。 */
function sendModelError(ctx: ApiHandlerContext, req: ApiRequestMessage, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = message.startsWith("参数错误")
    ? 400
    : message.includes("不存在")
      ? 404
      : message.includes("已存在") || message.includes("内置目录")
        ? 409
        : 500;
  const errorCode = status === 400
    ? "BAD_REQUEST"
    : status === 404
      ? "ENGINE_CUSTOM_MODEL_NOT_FOUND"
      : status === 409
        ? "ENGINE_CUSTOM_MODEL_CONFLICT"
        : "ENGINE_CUSTOM_MODEL_REQUEST_FAILED";
  const body = req.body as Record<string, unknown> | null;
  const logContext = {
    requestId: req.id,
    method: req.method,
    engine: String(body?.engine ?? "").trim() || null,
    modelId: String(body?.modelId ?? "").trim() || null,
    customModelId: String(body?.id ?? "").trim() || null,
    errorCode,
    rootCause: { name: error instanceof Error ? error.name : typeof error, message },
  };
  if (status >= 500) logger.error("engine-custom-model", "custom model request failed", logContext);
  else logger.warn("engine-custom-model", "custom model request rejected", logContext);
  ctx.send({ t: "api.res", id: req.id, status, body: { ok: false, code: errorCode, message } });
}
