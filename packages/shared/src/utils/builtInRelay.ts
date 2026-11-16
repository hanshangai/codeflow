import type { EngineType } from "../types/engine.js";

/**
 * 基于公开中转地址生成写入 Engine Key 的 Base URL。
 * Codex 走 OpenAI 兼容协议需要 `/v1` 后缀，其余引擎直接用公开根地址；
 * 公开地址为空时抛错，不允许调用方落一个不可用的 Key。
 */
export function resolveBuiltInRelayBaseUrl(engine: EngineType, publicBaseUrl: string): string {
  const normalized = String(publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("内置中转公开地址未配置");
  }
  return engine === "codex" ? `${normalized}/v1` : normalized;
}
