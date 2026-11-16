import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  ENGINE_PROVIDER_BASE_URLS,
  getEngineProviderLabel,
  type EngineModelProviderId,
} from "@codeflowai/shared";

const MAX_ERROR_DETAIL_LENGTH = 500;
export const PROVIDER_KEY_TEST_TIMEOUT_MS = 15_000;
export const PROVIDER_KEY_TEST_MAX_RESPONSE_BYTES = 64 * 1024;

export type ProviderKeyTestConfig = {
  engine: "claude" | "codex";
  providerId: EngineModelProviderId;
  apiKey: string;
  baseUrl: string | null;
};

export type ProviderKeyTestHttpRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  model?: string;
};

/** 选择该供应商的目录默认模型；测试不依赖用户当前会话模型。 */
export function resolveProviderTestModel(engine: "claude" | "codex", providerId: EngineModelProviderId): string | null {
  const models = engine === "claude" ? CLAUDE_MODELS : CODEX_MODELS;
  return (models.find((model) => model.providerId === providerId && model.isDefault)
    ?? models.find((model) => model.providerId === providerId))?.id ?? null;
}

/** 构造一次最小请求，验证 Key、Base URL 与供应商连通性；路径与真实 SDK 追加规则一致。 */
export function buildProviderKeyTestRequest(config: ProviderKeyTestConfig): ProviderKeyTestHttpRequest {
  const baseUrl = (config.baseUrl?.trim() || ENGINE_PROVIDER_BASE_URLS[config.providerId]).replace(/\/+$/u, "");
  if (!baseUrl) throw new Error("缺少 Base URL，无法测试连接");
  const model = resolveProviderTestModel(config.engine, config.providerId);
  if (!model) throw new Error(`供应商 ${getEngineProviderLabel(config.providerId)} 没有可用于测试的模型`);
  if (config.engine === "claude") {
    // 运行时把 Key 注入 ANTHROPIC_AUTH_TOKEN，SDK 固定追加 /v1/messages 并使用 Bearer。
    return {
      url: `${baseUrl}/v1/messages`,
      model,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    };
  }
  // Codex 运行时使用 Responses API；用最小请求验证真实端点，不猜测模型列表能力。
  return {
    url: `${baseUrl}/responses`,
    model,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model, input: "ping" }),
  };
}

/** 有界读取测试响应，避免错误 Base URL 返回超大响应体占满内存。 */
export async function readProviderTestResponseText(
  response: Response,
  maxBytes = PROVIDER_KEY_TEST_MAX_RESPONSE_BYTES,
): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const remaining = maxBytes - total;
      const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.length;
      if (value.length > remaining) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* 读取结束或取消失败不影响已读内容。 */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

/** 汇总 fetch 错误链，保留 DNS、TLS、连接拒绝等真实原因。 */
export function describeProviderTestError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (!(current instanceof Error)) {
      messages.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const text = current.message.trim();
    messages.push(`${text}${typeof code === "string" && !text.includes(code) ? ` (${code})` : ""}`.trim());
    current = (current as { cause?: unknown }).cause;
  }
  return [...new Set(messages.filter(Boolean))].join("：") || "未知网络错误";
}

/** 提取供应商错误详情并确保不回显完整 API Key。 */
export function summarizeProviderTestFailure(status: number, responseText: string, apiKey: string): string {
  const text = responseText.trim();
  let detail = "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown; message?: unknown };
    const errorValue = parsed?.error;
    detail = String(
      (errorValue && typeof errorValue === "object" ? (errorValue as { message?: unknown }).message : errorValue)
      ?? parsed?.message ?? "",
    ).trim();
  } catch {
    detail = text;
  }
  detail = detail.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  if (apiKey) detail = detail.split(apiKey).join("***");
  if (detail.length > MAX_ERROR_DETAIL_LENGTH) detail = `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH)}...`;
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status} 请求失败`;
}
