import assert from "node:assert/strict";
import test from "node:test";

import { getPublicBestPracticeArticle, getPublicBestPracticeArticles } from "../src/api/best-practice-articles/index.ts";
import { requestJson, type ApiRequestContext } from "../src/api/request.ts";

const originalFetch = globalThis.fetch;

/** 创建会在误触鉴权时立即失败的匿名请求上下文。 */
function createAnonymousApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: null,
    webSessionId: null,
    ensureSession: async () => {
      throw new Error("公开最佳实践接口不应触发 ensureSession");
    },
    clearSession() {},
  };
}

/** 构造统一 JSON API 成功响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("public best-practice list and detail use anonymous GET requests", async () => {
  const ctx = createAnonymousApiContext();
  const capturedRequests: Array<{ url: string; authorization: string | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedRequests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (String(input).includes("?offset=")) {
      return jsonResponse({ ok: true, items: [], total: 0, offset: 0, limit: 10 });
    }
    return jsonResponse({
      ok: true,
      article: {
        slug: "reliable-review",
        title: "可靠的代码评审",
        summary: "建立可追踪的评审闭环。",
        bodyMarkdown: "# 可靠的代码评审",
        publishedAt: 1,
        updatedAt: 1,
      },
    });
  }) as typeof fetch;

  const listResult = await getPublicBestPracticeArticles(ctx, { offset: 0, limit: 10 });
  const detailResult = await getPublicBestPracticeArticle(ctx, "reliable-review");

  assert.equal(listResult.ok, true);
  assert.equal(detailResult.ok, true);
  assert.equal(capturedRequests.length, 2);
  assert.match(capturedRequests[0]!.url, /\/api\/public\/best-practice-articles\?offset=0&limit=10$/u);
  assert.match(capturedRequests[1]!.url, /\/api\/public\/best-practice-articles\/reliable-review$/u);
  assert.deepEqual(capturedRequests.map((request) => request.authorization), [null, null]);
});

test("best-practice prefix does not allow anonymous non-GET requests", async () => {
  let ensureSessionCalls = 0;
  let fetchCalled = false;
  const ctx: ApiRequestContext = {
    ...createAnonymousApiContext(),
    ensureSession: async () => {
      ensureSessionCalls += 1;
      throw new Error("请先登录账号");
    },
  };

  globalThis.fetch = (async () => {
    fetchCalled = true;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await requestJson(ctx, {
    method: "POST",
    path: "/api/public/best-practice-articles/not-a-public-write",
    body: {},
  });

  assert.equal(result.ok, false);
  assert.equal(ensureSessionCalls, 1);
  assert.equal(fetchCalled, false);
  if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
});

test("best-practice anonymous detail whitelist only accepts one slug segment", async () => {
  let ensureSessionCalls = 0;
  let fetchCalled = false;
  const ctx: ApiRequestContext = {
    ...createAnonymousApiContext(),
    ensureSession: async () => {
      ensureSessionCalls += 1;
      throw new Error("请先登录账号");
    },
  };

  globalThis.fetch = (async () => {
    fetchCalled = true;
    return jsonResponse({ ok: true });
  }) as typeof fetch;

  const result = await requestJson(ctx, {
    method: "GET",
    path: "/api/public/best-practice-articles/slug/extra",
  });

  assert.equal(result.ok, false);
  assert.equal(ensureSessionCalls, 1);
  assert.equal(fetchCalled, false);
  if (!result.ok) assert.equal(result.code, "UNAUTHORIZED");
});
