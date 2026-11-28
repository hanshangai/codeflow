import assert from "node:assert/strict";
import test from "node:test";

import { handleEngineKeysTest } from "../src/app/handlers/engineKeyHandlers.js";
import {
  buildProviderKeyTestRequest,
  describeProviderTestError,
  readProviderTestResponseText,
  resolveProviderTestModel,
  summarizeProviderTestFailure,
} from "../src/engines/providerKeyTest.js";

test("Claude 供应商使用 Anthropic Messages 端点并带 Bearer 凭据", () => {
  const request = buildProviderKeyTestRequest({
    engine: "claude",
    providerId: "deepseek",
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com/anthropic/",
  });
  assert.equal(request.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(request.model, resolveProviderTestModel("claude", "deepseek"));
  assert.equal(request.headers.authorization, "Bearer sk-test");
  assert.equal(request.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.headers["x-api-key"], undefined);
  const body = JSON.parse(request.body) as { max_tokens: number };
  assert.equal(body.max_tokens, 1);
});

test("Claude 各供应商都按运行时 Bearer 约定发送鉴权头", () => {
  const official = buildProviderKeyTestRequest({
    engine: "claude", providerId: "anthropic", apiKey: "sk-ant-test", baseUrl: null,
  });
  assert.equal(official.url, "https://api.anthropic.com/v1/messages");
  assert.equal(official.headers.authorization, "Bearer sk-ant-test");
  assert.equal(official.headers["x-api-key"], undefined);
  const compatible = buildProviderKeyTestRequest({
    engine: "claude", providerId: "moonshot", apiKey: "sk-test", baseUrl: null,
  });
  assert.equal(compatible.headers.authorization, "Bearer sk-test");
});

test("测试路径与 Claude Code SDK 一致：在 Base URL 后追加 /v1/messages", () => {
  const request = buildProviderKeyTestRequest({
    engine: "claude",
    providerId: "qwen",
    apiKey: "sk-test",
    baseUrl: null,
  });
  assert.equal(request.url, "https://token-plan.maas.qwencloudapi.com/apps/anthropic/v1/messages");
  assert.equal(request.model, "qwen4-max");
});

test("Codex 供应商使用真实 Responses 端点并带 Bearer", () => {
  const request = buildProviderKeyTestRequest({
    engine: "codex",
    providerId: "openai",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
  });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.authorization, "Bearer sk-test");
  assert.equal(request.headers["x-api-key"], undefined);
  assert.equal((JSON.parse(request.body ?? "{}") as { model?: string }).model, "gpt-6.2-sol");
});

test("失败详情提取供应商错误并隐藏完整 API Key", () => {
  const message = summarizeProviderTestFailure(
    401,
    JSON.stringify({ error: { message: "Invalid key sk-secret-123" } }),
    "sk-secret-123",
  );
  assert.equal(message, "HTTP 401: Invalid key ***");
  assert.equal(summarizeProviderTestFailure(500, "", "sk-secret-123"), "HTTP 500 请求失败");
});

test("失败详情压缩换行并限制长度", () => {
  const message = summarizeProviderTestFailure(400, `line1\n\nline2 ${"x".repeat(600)}`, "sk-test");
  assert.match(message, /^HTTP 400: line1 line2 /u);
  assert.ok(message.endsWith("..."));
  assert.ok(message.length < 540);
});

test("网络错误保留 cause 链中的 DNS/TLS 根因", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), { code: "ENOTFOUND" }),
  });
  assert.equal(describeProviderTestError(error), "fetch failed：getaddrinfo ENOTFOUND api.example.com");
});

test("测试响应读取有字节上限", async () => {
  const text = await readProviderTestResponseText(new Response("x".repeat(1000)), 16);
  assert.equal(text.length, 16);
});

async function runEngineKeyTest(
  providerResponse: Response,
  body: Record<string, unknown> = {
    engine: "claude",
    providerId: "deepseek",
    apiKey: "sk-secret",
    baseUrl: "https://api.deepseek.com/anthropic",
  },
): Promise<{ sent: any[]; request: { url: string; init: any } | null }> {
  const sent: any[] = [];
  let request: { url: string; init: any } | null = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), init };
    return providerResponse;
  }) as typeof fetch;
  try {
    await handleEngineKeysTest(
      { send: (message: unknown) => sent.push(message) } as never,
      { t: "api.req", id: "test-request", method: "engineKeys.test", path: "/engine-keys/test", body } as never,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { sent, request };
}

test("engineKeys.test 成功时返回模型和耗时，且不回显 Key", async () => {
  const { sent, request } = await runEngineKeyTest(new Response(JSON.stringify({ content: [] }), { status: 200 }));
  assert.equal(request?.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.ok, true);
  assert.equal(sent[0].body.model, "deepseek-flash");
  assert.equal(typeof sent[0].body.latencyMs, "number");
  assert.equal(JSON.stringify(sent[0]).includes("sk-secret"), false);
});

test("engineKeys.test 供应商拒绝时返回脱敏失败原因", async () => {
  const { sent } = await runEngineKeyTest(new Response(
    JSON.stringify({ error: { message: "Invalid key sk-secret" } }),
    { status: 401 },
  ));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.ok, false);
  assert.equal(sent[0].body.message, "HTTP 401: Invalid key ***");
  assert.equal(JSON.stringify(sent[0]).includes("sk-secret"), false);
});
