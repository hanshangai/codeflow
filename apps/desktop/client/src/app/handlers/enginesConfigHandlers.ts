import { readEngineConfig, writeEngineConfig } from "../../enginesConfig.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";

/** 处理 `engines.config.get`：读取两个引擎的原生凭据配置。 */
export function handleEnginesConfigGet(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const claude = readEngineConfig("claude");
    const codex = readEngineConfig("codex");
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, claude, codex } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message } });
  }
}

/** 处理 `engines.config.set`：写入指定引擎的原生凭据配置。 */
export async function handleEnginesConfigSet(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as any;
  const engine = String(body?.engine ?? "").trim();
  const config = body?.config ?? null;

  if (engine !== "claude" && engine !== "codex") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：engine 必须为 claude 或 codex" } });
    return;
  }
  if (!config || typeof config !== "object") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：config" } });
    return;
  }

  try {
    await writeEngineConfig(engine, config);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message } });
  }
}
