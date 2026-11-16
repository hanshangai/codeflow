import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { HostRpcHttpTask } from "@codeflowai/shared";

import { HostRpcHttpTransport } from "../src/transport/hostRpcHttpTransport.ts";

type DiagnosticEntry = {
  level: "info" | "warn" | "error";
  message: string;
  data?: Record<string, unknown>;
};

/** 等待异步 transport 达到测试条件，超时显式失败。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 Host RPC transport 条件超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 断言日志、fatal 或 shutdown 观察值中不包含敏感原文。 */
function assertSensitiveTextAbsent(value: unknown, sentinels: string[]): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const sentinel of sentinels) {
    assert.equal(text.includes(sentinel), false, `unexpected sensitive text: ${sentinel}`);
  }
}

/** 构造只暴露当前测试所需状态与 cancel 行为的响应。 */
function createCancelableResponse(status: number, cancel: () => Promise<void>): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    body: { cancel },
  } as unknown as Response;
}

test("HostRpcHttpTransport retries result submission without executing the command twice", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-1",
    message: {
      t: "api.req",
      id: "request-1",
      method: "git.status",
      path: "/git",
      body: { workspaceId: "workspace-a" },
    },
    queueMs: 12,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  let executeCalls = 0;
  let serializationCalls = 0;
  let fatal: Error | null = null;
  const postedBodies: string[] = [];
  const diagnostics: DiagnosticEntry[] = [];
  const fetchFailureMessage = "FETCH_SECRET api-key-fetch Bearer fetch-token https://internal-fetch.invalid/path?token=query-secret";

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session"), "session-1");
    if (url.includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    postedBodies.push(String(init?.body ?? ""));
    if (resultCalls === 1) throw Object.assign(new Error(fetchFailureMessage), { code: "ECONNRESET" });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async (received) => {
      executeCalls += 1;
      assert.deepEqual(received, task);
      return [{
        t: "api.res",
        id: "request-1",
        status: 200,
        body: {
          toJSON: () => {
            serializationCalls += 1;
            return { ok: true, message: "完成🚀" };
          },
        },
      }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-1");
  await waitFor(() => resultCalls === 2 && nextCalls >= 2);
  transport.stop();
  await waitFor(() => !transport.isRunning());
  assert.equal(executeCalls, 1);
  assert.equal(resultCalls, 2);
  assert.equal(serializationCalls, 1);
  assert.equal(fatal, null);
  const expectedBody = JSON.stringify({
    messages: [{ t: "api.res", id: "request-1", status: 200, body: { ok: true, message: "完成🚀" } }],
  });
  assert.deepEqual(postedBodies, [expectedBody, expectedBody]);

  const retry = diagnostics.find((entry) => entry.data?.phase === "post" && entry.data?.outcome === "retrying");
  assert.ok(retry);
  assert.equal(retry.level, "warn");
  assert.equal(retry.data?.hostRpcOperationId, "operation-1");
  assert.equal(retry.data?.requestId, "request-1");
  assert.equal(retry.data?.method, "git.status");
  assert.equal(retry.data?.workspaceId, "workspace-a");
  assert.equal(retry.data?.queueMs, 12);
  assert.equal(retry.data?.postAttempts, 1);
  assert.equal(retry.data?.errorCode, "HOST_RPC_HTTP_RESULT_POST_FAILED");
  assert.equal(retry.data?.error, undefined);
  assert.equal(retry.data?.errorName, "Error");
  assert.equal(retry.data?.externalErrorCode, "ECONNRESET");
  assert.equal(retry.data?.messageHash, crypto.createHash("sha256").update(fetchFailureMessage, "utf8").digest("hex"));
  assertSensitiveTextAbsent(JSON.stringify(diagnostics), [
    "FETCH_SECRET",
    "api-key-fetch",
    "Bearer fetch-token",
    "internal-fetch.invalid",
    "query-secret",
  ]);

  const completed = diagnostics.find((entry) => entry.message === "Host RPC task completed");
  assert.ok(completed);
  assert.equal(completed.data?.outcome, "accepted");
  assert.equal(completed.data?.postAttempts, 2);
  assert.equal(completed.data?.resultBytes, Buffer.byteLength(expectedBody, "utf8"));
  assert.equal(typeof completed.data?.handlerMs, "number");
  assert.equal(typeof completed.data?.serializeMs, "number");
  assert.equal(typeof completed.data?.postMs, "number");
});

test("HostRpcHttpTransport records a separate warning for slow completed tasks", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-slow-task",
    message: {
      t: "api.req",
      id: "request-slow-task",
      method: "fs.tree",
      path: "/fs/tree",
      body: { workspaceId: "workspace-slow" },
    },
    queueMs: 120,
  };
  let nextCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    slowTaskThresholdMs: 100,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return [{ t: "api.res", id: "request-slow-task", status: 200, body: { ok: true } }];
    },
    events: { onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
  });

  transport.start("session-slow-task");
  await waitFor(() => diagnostics.some((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "in_progress"));
  await waitFor(() => diagnostics.some((entry) => entry.message === "Host RPC task completed"));
  transport.stop();
  await waitFor(() => !transport.isRunning());

  const completed = diagnostics.find((entry) => entry.message === "Host RPC task completed");
  assert.ok(completed);
  assert.equal(completed.data?.outcome, "accepted");
  const inProgressSlow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "in_progress");
  assert.ok(inProgressSlow);
  assert.equal(inProgressSlow.data?.outcome, "in_progress");
  assert.equal(inProgressSlow.data?.activePhase, "handler");
  const slow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "slow");
  assert.ok(slow);
  assert.equal(slow.level, "warn");
  assert.equal(slow.data?.errorCode, "HOST_RPC_HTTP_SLOW_TASK");
  assert.deepEqual(slow.data?.slowStages, ["queue", "handler", "total"]);
  assert.equal(slow.data?.outcome, "accepted");
  assert.equal(slow.data?.diagnosticOutcome, "slow");
  assert.equal(typeof slow.data?.clientTotalMs, "number");
  assert.equal(typeof slow.data?.totalMs, "number");
  assert.ok(Number(slow.data?.totalMs) >= Number(slow.data?.clientTotalMs));
  assert.equal(slow.data?.slowTaskThresholdMs, 100);
});

test("HostRpcHttpTransport calculates totalMs from queue and client time", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-total-time",
    message: { t: "api.req", id: "request-total-time", method: "fs.tree", path: "/fs/tree", body: {} },
    queueMs: 60,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    slowTaskThresholdMs: 100,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return [{ t: "api.res", id: "request-total-time", status: 200, body: { ok: true } }];
    },
    events: { onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
  });

  transport.start("session-total-time");
  await waitFor(() => diagnostics.some((entry) => entry.message === "Host RPC task completed"));
  transport.stop();
  await waitFor(() => !transport.isRunning());

  const slow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "slow");
  assert.ok(slow);
  assert.deepEqual(slow.data?.slowStages, ["total"]);
  assert.equal(slow.data?.queueMs, 60);
  assert.ok(Number(slow.data?.handlerMs) < 100);
  assert.ok(Number(slow.data?.clientTotalMs) < 100);
  assert.ok(Number(slow.data?.totalMs) >= 100);
  assert.equal(resultCalls, 1);
});

test("HostRpcHttpTransport reports a slow task while result submission is retrying", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-post-slow",
    message: { t: "api.req", id: "request-post-slow", method: "orch.roles.list", path: "/roles", body: {} },
    queueMs: 0,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    if (resultCalls === 1) throw Object.assign(new Error("temporary failure"), { code: "ECONNRESET" });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 150,
    slowTaskThresholdMs: 100,
    execute: async () => [{ t: "api.res", id: "request-post-slow", status: 200, body: { ok: true } }],
    events: { onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
  });

  transport.start("session-post-slow");
  await waitFor(() => diagnostics.some((entry) => entry.message === "Host RPC task completed"));
  transport.stop();
  await waitFor(() => !transport.isRunning());

  const inProgressSlow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "in_progress");
  assert.ok(inProgressSlow);
  assert.equal(inProgressSlow.data?.activePhase, "post");
  assert.equal(inProgressSlow.data?.outcome, "in_progress");
  assert.equal(inProgressSlow.data?.slowStages.includes("total"), true);
  const completedSlow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "slow");
  assert.ok(completedSlow);
  assert.equal(completedSlow.data?.outcome, "accepted");
  assert.equal(resultCalls, 2);
});

test("HostRpcHttpTransport reports slow handler failure before transport fatal", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-handler-slow",
    message: { t: "api.req", id: "request-handler-slow", method: "orch.roles.list", path: "/roles", body: {} },
    queueMs: 0,
  };
  let nextCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    slowTaskThresholdMs: 100,
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      throw new Error("slow handler failure");
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-handler-slow");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  const inProgressSlow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "in_progress");
  assert.ok(inProgressSlow);
  assert.equal(inProgressSlow.data?.activePhase, "handler");
  const failedSlow = diagnostics.find((entry) => entry.message === "Host RPC task slow" && entry.data?.phase === "slow");
  assert.ok(failedSlow);
  assert.equal(failedSlow.data?.outcome, "failed");
  assert.equal(fatal?.message, "Host RPC handler failed");
});

test("HostRpcHttpTransport stop clears a pending slow-task timer", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-stop-slow-monitor",
    message: { t: "api.req", id: "request-stop-slow-monitor", method: "fs.tree", path: "/fs/tree", body: {} },
    queueMs: 0,
  };
  let nextCalls = 0;
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    throw new Error("stop test must not submit a result");
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    slowTaskThresholdMs: 100,
    execute: async () => {
      await handlerGate;
      return [{ t: "api.res", id: "request-stop-slow-monitor", status: 200, body: { ok: true } }];
    },
    events: { onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
  });

  transport.start("session-stop-slow-monitor");
  await waitFor(() => nextCalls === 1);
  transport.stop();
  releaseHandler();
  await waitFor(() => !transport.isRunning());
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(diagnostics.some((entry) => entry.message === "Host RPC task slow"), false);
});

test("HostRpcHttpTransport retries a timed-out result submission without re-executing", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-timeout-retry",
    message: {
      t: "api.req",
      id: "request-timeout-retry",
      method: "orch.intakes.list",
      path: "/orch/intakes",
      body: { workspaceId: "workspace-timeout" },
    },
    queueMs: 1,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  let executeCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    resultCalls += 1;
    if (resultCalls === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    resultRequestTimeoutMs: 30,
    execute: async () => {
      executeCalls += 1;
      return [{ t: "api.res", id: "request-timeout-retry", status: 200, body: { ok: true } }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
    },
  });

  transport.start("session-timeout-retry");
  await waitFor(() => resultCalls === 2 && nextCalls >= 2);
  transport.stop();
  await waitFor(() => !transport.isRunning());

  assert.equal(executeCalls, 1);
  const retry = diagnostics.find((entry) => entry.data?.phase === "post" && entry.data?.outcome === "retrying");
  assert.ok(retry);
  assert.equal(retry.data?.errorCode, "HOST_RPC_HTTP_RESULT_POST_FAILED");
  assert.equal(retry.data?.errorName, "TimeoutError");
  assert.equal(retry.data?.postAttempts, 1);
  const completed = diagnostics.find((entry) => entry.message === "Host RPC task completed");
  assert.ok(completed);
  assert.equal(completed.data?.outcome, "accepted");
  assert.equal(completed.data?.postAttempts, 2);
});

test("HostRpcHttpTransport logs only safe metadata for error responses", async () => {
  const secretSentinel = "SECRET_RESPONSE_SENTINEL_9f2c";
  const internalUrl = "https://internal-host.invalid/private/path";
  const apiKey = "secret-api-key-sentinel";
  const errorBody = JSON.stringify({
    ok: false,
    code: "INTERNAL_ERROR",
    message: `${secretSentinel} ${internalUrl}`,
  });
  const nestedErrorBody = JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR" } });
  const task: HostRpcHttpTask = {
    operationId: "operation-safe-error",
    message: { t: "api.req", id: "request-safe-error", method: "orch.roles.list", path: "/roles", body: {} },
    queueMs: 6,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    if (resultCalls === 1) {
      return new Response(errorBody, {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    if (resultCalls === 2) {
      return new Response(nestedErrorBody, {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://internal-host.invalid/ws/client",
    apiKey,
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async () => ([{
      t: "api.res",
      id: "request-safe-error",
      status: 200,
      body: { ok: true },
    }]),
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
    },
  });

  transport.start("session-safe-error");
  await waitFor(() => resultCalls === 3 && nextCalls >= 2);
  transport.stop();
  await waitFor(() => !transport.isRunning());

  const retry = diagnostics.find((entry) => entry.data?.phase === "post" && entry.data?.outcome === "retrying");
  assert.ok(retry);
  assert.equal(retry.data?.status, 500);
  assert.equal(retry.data?.responseErrorCode, "INTERNAL_ERROR");
  assert.equal(retry.data?.contentType, "application/json");
  assert.equal(retry.data?.bodyBytesRead, Buffer.byteLength(errorBody, "utf8"));
  assert.equal(retry.data?.bodyTruncated, false);
  assert.equal(retry.data?.bodyPrefixHash, crypto.createHash("sha256").update(errorBody, "utf8").digest("hex"));
  assert.equal(retry.data?.error, undefined);
  const nestedRetry = diagnostics.find((entry) => entry.data?.phase === "post" && entry.data?.postAttempts === 2);
  assert.ok(nestedRetry);
  assert.equal(nestedRetry.data?.responseErrorCode, null);
  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.equal(serializedDiagnostics.includes(secretSentinel), false);
  assert.equal(serializedDiagnostics.includes(internalUrl), false);
  assert.equal(serializedDiagnostics.includes("internal-host.invalid"), false);
  assert.equal(serializedDiagnostics.includes(apiKey), false);
});

test("HostRpcHttpTransport truncates oversized error responses at 64KiB", async () => {
  const bodyLimit = 64 * 1024;
  const bodySecret = "LARGE_BODY_SECRET Bearer large-token https://internal-large.invalid/path?key=large-query";
  const largeBody = Buffer.alloc(bodyLimit + 32 * 1024, 0x61);
  Buffer.from(bodySecret, "utf8").copy(largeBody, 0);
  const task: HostRpcHttpTask = {
    operationId: "operation-large-error",
    message: { t: "api.req", id: "request-large-error", method: "orch.instances.list", path: "/instances", body: {} },
    queueMs: 2,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  let executeCalls = 0;
  let streamCancelled = false;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    if (resultCalls === 1) {
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const end = Math.min(offset + 8 * 1024, largeBody.byteLength);
          controller.enqueue(new Uint8Array(largeBody.buffer, largeBody.byteOffset + offset, end - offset));
          offset = end;
          if (offset >= largeBody.byteLength) controller.close();
        },
        cancel() {
          streamCancelled = true;
        },
      });
      return new Response(body, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async () => {
      executeCalls += 1;
      return [{ t: "api.res", id: "request-large-error", status: 200, body: { ok: true } }];
    },
    events: { onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
  });

  transport.start("session-large-error");
  await waitFor(() => resultCalls === 2 && nextCalls >= 2);
  transport.stop();
  await waitFor(() => !transport.isRunning());

  assert.equal(executeCalls, 1);
  assert.equal(streamCancelled, true);
  const retry = diagnostics.find((entry) => entry.data?.phase === "post" && entry.data?.outcome === "retrying");
  assert.ok(retry);
  assert.equal(retry.data?.status, 500);
  assert.equal(retry.data?.bodyBytesRead, bodyLimit);
  assert.equal(retry.data?.bodyTruncated, true);
  assert.equal(
    retry.data?.bodyPrefixHash,
    crypto.createHash("sha256").update(largeBody.subarray(0, bodyLimit)).digest("hex"),
  );
  assertSensitiveTextAbsent(JSON.stringify(diagnostics), [
    "LARGE_BODY_SECRET",
    "Bearer large-token",
    "internal-large.invalid",
    "large-query",
  ]);
});

test("HostRpcHttpTransport bounds an endless authentication body with the total deadline", async () => {
  const bodyPrefix = "AUTH_BODY_SECRET Bearer auth-token https://internal-auth.invalid/path?key=auth-query";
  let requestSignalAborted = false;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { requestSignalAborted = true; }, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(bodyPrefix, "utf8"));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    return new Response(body, { status: 401, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 30,
    execute: async () => {
      throw new Error("authentication response must not execute");
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-auth-deadline");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  assert.equal(requestSignalAborted, true);
  assert.equal(fatal?.message, "Host RPC poll authentication failed (401)");
  const pollFailure = diagnostics.find((entry) => entry.data?.phase === "poll");
  assert.ok(pollFailure);
  assert.equal(pollFailure.data?.status, 401);
  assert.equal(pollFailure.data?.bodyBytesRead, Buffer.byteLength(bodyPrefix, "utf8"));
  assert.equal(pollFailure.data?.bodyTruncated, true);
  assert.equal(pollFailure.data?.responseErrorCode, null);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "AUTH_BODY_SECRET",
    "Bearer auth-token",
    "internal-auth.invalid",
    "auth-query",
  ]);
});

test("HostRpcHttpTransport preserves authentication fatal when error body cancellation fails", async () => {
  const bodyLimit = 64 * 1024;
  const bodySecret = "AUTH_CANCEL_BODY_SECRET Bearer auth-cancel-token https://internal-auth-cancel.invalid/path?key=auth-cancel-query";
  const cancelFailureMessage = "AUTH_CANCEL_ERROR_SECRET api-key-auth-cancel https://internal-cancel-error.invalid/?token=cancel-error-query";
  const oversizedBody = Buffer.alloc(bodyLimit + 8 * 1024, 0x62);
  Buffer.from(bodySecret, "utf8").copy(oversizedBody, 0);
  let fetchCalls = 0;
  let executeCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async () => {
    fetchCalls += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(oversizedBody));
      },
      cancel() {
        return Promise.reject(new Error(cancelFailureMessage));
      },
    });
    return new Response(body, { status: 401, headers: { "Content-Type": "text/plain" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 1_000,
    retryBaseMs: 10,
    execute: async () => {
      executeCalls += 1;
      return [];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-auth-cancel-failure");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  assert.equal(fetchCalls, 1);
  assert.equal(executeCalls, 0);
  assert.equal(fatal?.message, "Host RPC poll authentication failed (401)");
  const pollFailure = diagnostics.find((entry) => entry.data?.phase === "poll");
  assert.ok(pollFailure);
  assert.equal(pollFailure.data?.status, 401);
  assert.equal(pollFailure.data?.bodyBytesRead, bodyLimit);
  assert.equal(pollFailure.data?.bodyTruncated, true);
  assert.equal(
    pollFailure.data?.bodyPrefixHash,
    crypto.createHash("sha256").update(oversizedBody.subarray(0, bodyLimit)).digest("hex"),
  );
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "AUTH_CANCEL_BODY_SECRET",
    "Bearer auth-cancel-token",
    "internal-auth-cancel.invalid",
    "auth-cancel-query",
    "AUTH_CANCEL_ERROR_SECRET",
    "api-key-auth-cancel",
    "internal-cancel-error.invalid",
    "cancel-error-query",
  ]);
});

test("HostRpcHttpTransport treats 204 body cleanup rejection as a fixed fatal", async () => {
  const cleanupFailureMessage = "NO_CONTENT_CLEANUP_SECRET Bearer no-content-token https://internal-no-content.invalid/?token=no-content-query";
  let fetchCalls = 0;
  let cancelCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return createCancelableResponse(204, async () => {
      cancelCalls += 1;
      throw new Error(cleanupFailureMessage);
    });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async () => {
      throw new Error("204 cleanup test must not execute");
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-no-content-cleanup");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  assert.equal(fetchCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(fatal?.message, "Host RPC response body cleanup failed");
  assert.equal(diagnostics.some((entry) => entry.data?.phase === "poll"), true);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "NO_CONTENT_CLEANUP_SECRET",
    "Bearer no-content-token",
    "internal-no-content.invalid",
    "no-content-query",
  ]);
});

test("HostRpcHttpTransport treats a 204 cleanup deadline as fatal", async () => {
  let fetchCalls = 0;
  let cancelStarted = false;
  let requestSignalAborted = false;
  let releaseCancel!: () => void;
  let fatal: Error | null = null;
  const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    init?.signal?.addEventListener("abort", () => { requestSignalAborted = true; }, { once: true });
    return createCancelableResponse(204, () => {
      cancelStarted = true;
      return cancelGate;
    });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 30,
    retryBaseMs: 10,
    execute: async () => {
      throw new Error("204 cleanup deadline test must not execute");
    },
    events: { onFatal: (error) => { fatal = error; } },
  });

  transport.start("session-no-content-deadline");
  try {
    await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);
    assert.equal(fetchCalls, 1);
    assert.equal(cancelStarted, true);
    assert.equal(requestSignalAborted, true);
    assert.equal(fatal?.message, "Host RPC response body cleanup failed");
  } finally {
    releaseCancel();
  }
});

test("HostRpcHttpTransport stop interrupts 204 body cleanup without fatal", async () => {
  let fetchCalls = 0;
  let cancelStarted = false;
  let requestSignalAborted = false;
  let releaseCancel!: () => void;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const cancelGate = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    init?.signal?.addEventListener("abort", () => { requestSignalAborted = true; }, { once: true });
    return createCancelableResponse(204, () => {
      cancelStarted = true;
      return cancelGate;
    });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 5_000,
    execute: async () => {
      throw new Error("204 cleanup stop test must not execute");
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-no-content-stop");
  try {
    await waitFor(() => cancelStarted);
    transport.stop();
    await waitFor(() => !transport.isRunning(), 1_000);
    assert.equal(fetchCalls, 1);
    assert.equal(requestSignalAborted, true);
    assert.equal(fatal, null);
    assert.equal(diagnostics.some((entry) => entry.data?.phase === "poll"), false);
  } finally {
    releaseCancel();
  }
});

test("HostRpcHttpTransport stop interrupts an endless successful poll body", async () => {
  const bodyPrefix = "STOP_BODY_SECRET Bearer stop-token https://internal-stop.invalid/path?key=stop-query";
  let bodyReadStarted = false;
  let requestSignalAborted = false;
  let executeCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.addEventListener("abort", () => { requestSignalAborted = true; }, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(bodyPrefix, "utf8"));
      },
      pull() {
        bodyReadStarted = true;
        return new Promise<void>(() => undefined);
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 5_000,
    execute: async () => {
      executeCalls += 1;
      return [];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-stop-body");
  await waitFor(() => bodyReadStarted);
  transport.stop();
  await waitFor(() => !transport.isRunning(), 1_000);

  assert.equal(requestSignalAborted, true);
  assert.equal(executeCalls, 0);
  assert.equal(fatal, null);
  assertSensitiveTextAbsent(JSON.stringify(diagnostics), [
    "STOP_BODY_SECRET",
    "Bearer stop-token",
    "internal-stop.invalid",
    "stop-query",
  ]);
});

test("HostRpcHttpTransport treats result serialization failure as fatal without POST retry", async () => {
  const serializationFailureMessage = "TOJSON_SECRET api-key-tojson Bearer serialize-token https://internal-serialize.invalid/path?token=serialize-query";
  const task: HostRpcHttpTask = {
    operationId: "operation-serialize-failure",
    message: {
      t: "api.req",
      id: "request-serialize-failure",
      method: "orch.roles.list",
      path: "/orchestration/roles",
      body: { workspaceId: "workspace-a" },
    },
    queueMs: 4,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  let executeCalls = 0;
  let serializationCalls = 0;
  let fatalMessage: string | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async () => {
      executeCalls += 1;
      return [{
        t: "api.res",
        id: "request-serialize-failure",
        status: 200,
        body: {
          toJSON: () => {
            serializationCalls += 1;
            throw new Error(serializationFailureMessage);
          },
        },
      }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatalMessage = error.message; },
    },
  });

  transport.start("session-serialize-failure");
  await waitFor(() => fatalMessage !== null && !transport.isRunning());

  assert.equal(executeCalls, 1);
  assert.equal(serializationCalls, 1);
  assert.equal(resultCalls, 0);
  assert.equal(fatalMessage, "Host RPC result serialization failed");
  const failure = diagnostics.find((entry) => entry.data?.phase === "serialize");
  assert.ok(failure);
  assert.equal(failure.level, "error");
  assert.equal(failure.data?.hostRpcOperationId, "operation-serialize-failure");
  assert.equal(failure.data?.requestId, "request-serialize-failure");
  assert.equal(failure.data?.method, "orch.roles.list");
  assert.equal(failure.data?.workspaceId, "workspace-a");
  assert.equal(failure.data?.queueMs, 4);
  assert.equal(failure.data?.errorCode, "HOST_RPC_HTTP_RESULT_SERIALIZATION_FAILED");
  assert.equal(failure.data?.outcome, "failed");
  assert.equal(failure.data?.error, undefined);
  assert.equal(failure.data?.messageHash, crypto.createHash("sha256").update(serializationFailureMessage, "utf8").digest("hex"));
  assert.equal(diagnostics.some((entry) => entry.data?.phase === "post"), false);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatalMessage}`, [
    "TOJSON_SECRET",
    "api-key-tojson",
    "Bearer serialize-token",
    "internal-serialize.invalid",
    "serialize-query",
  ]);
});

test("HostRpcHttpTransport converts invalid poll JSON to a fixed safe fatal", async () => {
  const invalidJson = "{\"operationId\":\"INVALID_JSON_SECRET api-key-json Bearer json-token https://internal-json.invalid/path?token=json-query\"";
  let executeCalls = 0;
  let resultCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    if (String(input).includes("/next")) {
      return new Response(invalidJson, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    resultCalls += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    execute: async () => {
      executeCalls += 1;
      return [];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-invalid-json");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  assert.equal(executeCalls, 0);
  assert.equal(resultCalls, 0);
  assert.equal(fatal?.message, "Host RPC poll returned invalid JSON");
  assert.equal(diagnostics.some((entry) => entry.data?.phase === "poll"), true);
  assert.equal(diagnostics.some((entry) => entry.data?.phase === "transport"), true);
  assert.equal(diagnostics.some((entry) => Object.prototype.hasOwnProperty.call(entry.data ?? {}, "error")), false);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "INVALID_JSON_SECRET",
    "api-key-json",
    "Bearer json-token",
    "internal-json.invalid",
    "json-query",
  ]);
});

test("HostRpcHttpTransport keeps the poll size-limit fatal when body cancellation rejects", async () => {
  const chunkBytes = 4 * 1024 * 1024;
  const bodySecret = "OVERSIZE_POLL_BODY_SECRET Bearer oversize-token https://internal-oversize.invalid/?token=oversize-query";
  const cancelFailureMessage = "OVERSIZE_CANCEL_SECRET api-key-oversize-cancel https://internal-oversize-cancel.invalid/?token=cancel-query";
  let pullCalls = 0;
  let cancelCalls = 0;
  let executeCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = Buffer.alloc(chunkBytes, 0x63);
        if (pullCalls === 0) Buffer.from(bodySecret, "utf8").copy(chunk, 0);
        pullCalls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelCalls += 1;
        return Promise.reject(new Error(cancelFailureMessage));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    pollRequestTimeoutMs: 20_000,
    execute: async () => {
      executeCalls += 1;
      return [];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-oversize-poll-cancel");
  await waitFor(() => fatal !== null && !transport.isRunning(), 10_000);

  assert.ok(pullCalls >= 16);
  assert.equal(cancelCalls, 1);
  assert.equal(executeCalls, 0);
  assert.equal(fatal?.message, "Host RPC poll response body exceeded the size limit");
  const pollFailure = diagnostics.find((entry) => entry.data?.phase === "poll");
  assert.ok(pollFailure);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "OVERSIZE_POLL_BODY_SECRET",
    "Bearer oversize-token",
    "internal-oversize.invalid",
    "oversize-query",
    "OVERSIZE_CANCEL_SECRET",
    "api-key-oversize-cancel",
    "internal-oversize-cancel.invalid",
    "cancel-query",
  ]);
});

test("HostRpcHttpTransport contains handler error text at the handler boundary", async () => {
  const handlerFailureMessage = `${"x".repeat(20_000)} HANDLER_SECRET api-key-handler Bearer handler-token https://internal-handler.invalid/path?token=handler-query`;
  const task: HostRpcHttpTask = {
    operationId: "operation-handler-failure",
    message: { t: "api.req", id: "request-handler-failure", method: "orch.roles.list", path: "/roles", body: {} },
    queueMs: 5,
  };
  let nextCalls = 0;
  let executeCalls = 0;
  let resultCalls = 0;
  let fatal: Error | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    maxConcurrency: 2,
    execute: async () => {
      executeCalls += 1;
      throw new Error(handlerFailureMessage);
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatal = error; },
    },
  });

  transport.start("session-handler-failure");
  await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

  assert.equal(executeCalls, 1);
  assert.equal(resultCalls, 0);
  assert.equal(fatal?.message, "Host RPC handler failed");
  const handlerFailure = diagnostics.find((entry) => entry.data?.phase === "handler");
  assert.ok(handlerFailure);
  assert.equal(handlerFailure.data?.error, undefined);
  assert.equal(handlerFailure.data?.messageHash, undefined);
  assert.equal(
    handlerFailure.data?.messagePrefixHash,
    crypto.createHash("sha256").update(handlerFailureMessage.slice(0, 16 * 1024), "utf8").digest("hex"),
  );
  assert.equal(handlerFailure.data?.messageTruncated, true);
  assert.equal(handlerFailure.data?.messageCodeUnits, handlerFailureMessage.length);
  assert.equal(diagnostics.some((entry) => entry.data?.phase === "transport"), true);
  assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
    "HANDLER_SECRET",
    "api-key-handler",
    "Bearer handler-token",
    "internal-handler.invalid",
    "handler-query",
  ]);
});

test("HostRpcHttpTransport reports worker fatal without waiting for a hanging sibling", async () => {
  const tasks: HostRpcHttpTask[] = [
    {
      operationId: "operation-hanging",
      message: { t: "api.req", id: "request-hanging", method: "orch.instances.list", path: "/instances", body: {} },
      queueMs: 1,
    },
    {
      operationId: "operation-fatal",
      message: { t: "api.req", id: "request-fatal", method: "orch.roles.list", path: "/roles", body: {} },
      queueMs: 2,
    },
  ];
  let nextIndex = 0;
  let resultCalls = 0;
  let releaseHanging!: () => void;
  let hangingFinished = false;
  let stoppedHandlerSerializationCalls = 0;
  let fatalMessage: string | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const hangingGate = new Promise<void>((resolve) => {
    releaseHanging = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/next")) {
      const task = tasks[nextIndex++];
      if (task) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    maxConcurrency: 2,
    execute: async (task) => {
      if (task.operationId === "operation-hanging") {
        await hangingGate;
        hangingFinished = true;
        return [{
          t: "api.res",
          id: "request-hanging",
          status: 200,
          body: {
            toJSON: () => {
              stoppedHandlerSerializationCalls += 1;
              return { message: "挂起任务已释放🧵" };
            },
          },
        }];
      }
      return [{ t: "api.res", id: "request-fatal", status: 200, body: { unsupported: 1n } }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatalMessage = error.message; },
    },
  });

  transport.start("session-worker-fatal");
  try {
    await waitFor(() => fatalMessage !== null && !transport.isRunning(), 1_000);
    assert.equal(hangingFinished, false);
    assert.equal(resultCalls, 0);
    assert.match(fatalMessage ?? "", /Host RPC result serialization failed/);
    const transportFailure = diagnostics.find((entry) => entry.data?.phase === "transport");
    assert.ok(transportFailure);
    assert.equal(transportFailure.data?.errorCode, "HOST_RPC_HTTP_TRANSPORT_STOPPED");
  } finally {
    releaseHanging();
  }
  await waitFor(() => hangingFinished);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resultCalls, 0);
  assert.equal(stoppedHandlerSerializationCalls, 0);
});

test("HostRpcHttpTransport reports poll fatal without waiting for a hanging worker", async () => {
  const hangingTask: HostRpcHttpTask = {
    operationId: "operation-hanging-before-poll-fatal",
    message: { t: "api.req", id: "request-hanging-before-poll-fatal", method: "orch.instances.list", path: "/instances", body: {} },
    queueMs: 1,
  };
  let nextCalls = 0;
  let resultCalls = 0;
  let stoppedHandlerSerializationCalls = 0;
  let hangingStarted = false;
  let hangingFinished = false;
  let releaseHanging!: () => void;
  let fatalMessage: string | null = null;
  const diagnostics: DiagnosticEntry[] = [];
  const hangingGate = new Promise<void>((resolve) => {
    releaseHanging = resolve;
  });
  const fetchImpl = (async (input: string | URL | Request) => {
    if (!String(input).includes("/next")) {
      resultCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    nextCalls += 1;
    if (nextCalls === 1) {
      return new Response(JSON.stringify(hangingTask), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ operationId: "invalid-task", queueMs: 0, message: { t: "sharedWorkspace.command" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    maxConcurrency: 2,
    execute: async () => {
      hangingStarted = true;
      await hangingGate;
      hangingFinished = true;
      return [{
        t: "api.res",
        id: "request-hanging-before-poll-fatal",
        status: 200,
        body: {
          toJSON: () => {
            stoppedHandlerSerializationCalls += 1;
            return { message: "轮询失败后释放挂起任务🛟" };
          },
        },
      }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
      onFatal: (error) => { fatalMessage = error.message; },
    },
  });

  transport.start("session-poll-fatal");
  try {
    await waitFor(() => fatalMessage !== null && !transport.isRunning(), 1_000);
    assert.equal(hangingStarted, true);
    assert.equal(hangingFinished, false);
    assert.equal(resultCalls, 0);
    assert.match(fatalMessage ?? "", /invalid task/);
    const pollFailure = diagnostics.find((entry) => entry.data?.phase === "poll");
    assert.ok(pollFailure);
    assert.equal(pollFailure.level, "error");
    assert.equal(pollFailure.data?.errorCode, "HOST_RPC_HTTP_POLL_FAILED");
  } finally {
    releaseHanging();
  }
  await waitFor(() => hangingFinished);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resultCalls, 0);
  assert.equal(stoppedHandlerSerializationCalls, 0);
});

test("HostRpcHttpTransport accepts legacy shared tasks without queueMs and logs safe identifiers", async () => {
  const task: HostRpcHttpTask = {
    operationId: "host-operation-legacy",
    message: {
      t: "sharedWorkspace.command",
      envelope: {
        localWorkspaceId: "workspace-local",
        operationId: "shared-operation-1",
        operationKey: "orch.workflow.use",
        routeEventId: "route-event-1",
        payload: { method: "orch.roles.list", body: { ignored: true } },
      } as any,
    },
  };
  let nextCalls = 0;
  let resultCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) {
        return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    resultCalls += 1;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    execute: async () => ([{
      t: "sharedWorkspace.route.result",
      message: {
        routeEventId: "route-event-1",
        operationId: "shared-operation-1",
        status: "succeeded",
        completedAt: Date.now(),
        result: { ok: true },
      },
    }] as any),
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
    },
  });

  transport.start("session-legacy-shared");
  await waitFor(() => resultCalls === 1);
  transport.stop();
  await waitFor(() => !transport.isRunning());

  const completed = diagnostics.find((entry) => entry.message === "Host RPC task completed");
  assert.ok(completed);
  assert.equal(completed.data?.hostRpcOperationId, "host-operation-legacy");
  assert.equal(completed.data?.requestId, null);
  assert.equal(completed.data?.sharedWorkspaceOperationId, "shared-operation-1");
  assert.equal(completed.data?.routeEventId, "route-event-1");
  assert.equal(completed.data?.method, "orch.roles.list");
  assert.equal(completed.data?.operationKey, "orch.workflow.use");
  assert.equal(completed.data?.workspaceId, "workspace-local");
  assert.equal(completed.data?.queueMs, null);
});

test("HostRpcHttpTransport executes leased reads with bounded concurrency", async () => {
  const tasks = Array.from({ length: 4 }, (_value, index): HostRpcHttpTask => ({
    operationId: `operation-${index}`,
    message: { t: "api.req", id: `request-${index}`, method: "git.status", path: "/git", body: {} },
    queueMs: index,
  }));
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  const completedResults: string[] = [];
  let nextIndex = 0;
  let activeExecutions = 0;
  let maxActiveExecutions = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/next")) {
      const task = tasks[nextIndex++];
      if (task) return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    const operationId = /\/rpc\/([^/]+)\/result/.exec(url)?.[1] ?? "";
    completedResults.push(decodeURIComponent(operationId));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    maxConcurrency: 2,
    execute: async (task) => {
      activeExecutions += 1;
      maxActiveExecutions = Math.max(maxActiveExecutions, activeExecutions);
      started.push(task.operationId);
      try {
        await new Promise<void>((resolve) => releases.set(task.operationId, resolve));
      } finally {
        activeExecutions -= 1;
      }
      const request = task.message.t === "api.req" ? task.message : null;
      if (!request) throw new Error("并发测试只接受 api.req");
      return [{ t: "api.res", id: request.id, status: 200, body: { ok: true } }];
    },
  });

  transport.start("session-concurrent");
  await waitFor(() => started.length === 2);
  assert.equal(maxActiveExecutions, 2);
  releases.get("operation-0")?.();
  await waitFor(() => started.length === 3);
  releases.get("operation-1")?.();
  await waitFor(() => started.length === 4);
  releases.get("operation-2")?.();
  releases.get("operation-3")?.();
  await waitFor(() => completedResults.length === 4);
  transport.stop();
  await waitFor(() => !transport.isRunning());

  assert.equal(maxActiveExecutions, 2);
  assert.deepEqual(new Set(completedResults), new Set(tasks.map((task) => task.operationId)));
});

test("HostRpcHttpTransport makes 410 and accepted response cleanup rejection fatal without retry", async () => {
  for (const scenario of [
    { label: "gone", status: 410 },
    { label: "accepted", status: 200 },
  ]) {
    const cleanupFailureMessage = `POST_CLEANUP_SECRET_${scenario.label} Bearer post-${scenario.label}-token https://internal-post-${scenario.label}.invalid/?token=post-query`;
    const task: HostRpcHttpTask = {
      operationId: `operation-cleanup-${scenario.label}`,
      message: {
        t: "api.req",
        id: `request-cleanup-${scenario.label}`,
        method: "engines.status",
        path: "/engines/status",
        body: {},
      },
      queueMs: 1,
    };
    let nextCalls = 0;
    let executeCalls = 0;
    let resultCalls = 0;
    let cancelCalls = 0;
    let fatal: Error | null = null;
    const diagnostics: DiagnosticEntry[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/next")) {
        nextCalls += 1;
        if (nextCalls === 1) {
          return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      resultCalls += 1;
      return createCancelableResponse(scenario.status, async () => {
        cancelCalls += 1;
        throw new Error(cleanupFailureMessage);
      });
    }) as typeof fetch;
    const transport = new HostRpcHttpTransport({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client",
      apiKey: "test-key",
      clientId: "host-a",
      fetchImpl,
      retryBaseMs: 10,
      maxConcurrency: 2,
      execute: async () => {
        executeCalls += 1;
        return [{ t: "api.res", id: `request-cleanup-${scenario.label}`, status: 200, body: { ok: true } }];
      },
      events: {
        onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
        onFatal: (error) => { fatal = error; },
      },
    });

    transport.start(`session-post-cleanup-${scenario.label}`);
    await waitFor(() => fatal !== null && !transport.isRunning(), 1_000);

    assert.equal(executeCalls, 1, scenario.label);
    assert.equal(resultCalls, 1, scenario.label);
    assert.equal(cancelCalls, 1, scenario.label);
    assert.equal(fatal?.message, "Host RPC response body cleanup failed", scenario.label);
    const postFailure = diagnostics.find((entry) => entry.data?.phase === "post");
    assert.ok(postFailure, scenario.label);
    assert.equal(postFailure.data?.outcome, "failed", scenario.label);
    assertSensitiveTextAbsent(`${JSON.stringify(diagnostics)}\n${fatal?.name}\n${fatal?.message}`, [
      `POST_CLEANUP_SECRET_${scenario.label}`,
      `Bearer post-${scenario.label}-token`,
      `internal-post-${scenario.label}.invalid`,
      "post-query",
    ]);
  }
});

test("HostRpcHttpTransport treats 410 as final cancellation and does not replay execution", async () => {
  const task: HostRpcHttpTask = {
    operationId: "operation-cancelled",
    message: { t: "api.req", id: "request-cancelled", method: "engines.status", path: "/engines", body: {} },
    queueMs: 3,
  };
  let nextCalls = 0;
  let executeCalls = 0;
  const diagnostics: DiagnosticEntry[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session"), "session-cancelled");
    if (url.includes("/next")) {
      nextCalls += 1;
      if (nextCalls === 1) return new Response(JSON.stringify(task), { status: 200, headers: { "Content-Type": "application/json" } });
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 410, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "wss://example.test/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    execute: async () => {
      executeCalls += 1;
      return [{ t: "api.res", id: "request-cancelled", status: 200, body: { ok: true } }];
    },
    events: {
      onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }),
    },
  });

  transport.start("session-cancelled");
  await waitFor(() => nextCalls >= 2);
  transport.stop();
  await waitFor(() => !transport.isRunning());
  assert.equal(executeCalls, 1);
  const completed = diagnostics.find((entry) => entry.message === "Host RPC task completed");
  assert.ok(completed);
  assert.equal(completed.data?.outcome, "gone");
  assert.equal(completed.data?.hostRpcOperationId, "operation-cancelled");
});

test("HostRpcHttpTransport switches the connection session without starting a second poll loop", async () => {
  const seenSessions: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seenSessions.push(String(new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session") ?? ""));
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  }) as typeof fetch;
  let fatal: Error | null = null;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    apiKey: "test-key",
    clientId: "host-a",
    fetchImpl,
    retryBaseMs: 10,
    execute: async () => {
      throw new Error("poll-only test must not execute a task");
    },
    events: { onFatal: (error) => { fatal = error; } },
  });

  transport.start("session-old");
  await waitFor(() => seenSessions.length === 1);
  transport.start("session-new");
  await waitFor(() => seenSessions.includes("session-new"));
  transport.stop();
  await waitFor(() => !transport.isRunning());

  assert.deepEqual(seenSessions.slice(0, 2), ["session-old", "session-new"]);
  assert.equal(fatal, null);
});

test("RPC 领取/提交连接失效仅通知一次，等待新握手且不重放旧任务", async () => {
  for (const phase of ["poll", "result"] as const) {
    for (const code of ["HOST_RPC_SESSION_MISMATCH", "HOST_RPC_CLIENT_UNAVAILABLE"]) {
      const sessions: string[] = [];
      let posts = 0;
      let executes = 0;
      let invalidations = 0;
      let fatal: Error | null = null;
      const task: HostRpcHttpTask = { operationId: "old-op", message: { t: "api.req", id: "old-request", method: "fs.tree", path: "/fs/tree", body: {} } };
      const transport = new HostRpcHttpTransport({
        serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
        fetchImpl: (async (url, init) => {
          const session = new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session")!;
          const poll = String(url).includes("/next");
          if (poll) sessions.push(session);
          else posts++;
          if (session === "old" && ((phase === "poll" && poll) || (phase === "result" && !poll))) {
            return new Response(JSON.stringify({ ok: false, code }), { status: 409, headers: { "Content-Type": "application/json" } });
          }
          if (session === "old" && phase === "result" && sessions.length === 1) return new Response(JSON.stringify(task));
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }) as typeof fetch,
        execute: async () => { executes++; return [{ t: "api.res", id: "old-request", status: 200, body: { ok: true } }]; },
        events: { onSessionInvalidated: () => { invalidations++; }, onFatal: error => { fatal = error; } },
      });
      try {
        transport.start("old");
        await waitFor(() => invalidations === 1);
        const oldPolls = sessions.length;
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.equal(sessions.length, oldPolls);
        assert.equal(invalidations, 1);
        transport.start("new");
        await waitFor(() => sessions.includes("new"));
        assert.equal(executes, phase === "result" ? 1 : 0);
        assert.equal(posts, phase === "result" ? 1 : 0);
        assert.equal(fatal, null);
      } finally { await transport.stopAndDrain(); }
    }
  }
});

test("RPC 能力拒绝和缺少连接恢复 owner 必须显式失败，不能无限重试", async () => {
  for (const code of ["HOST_RPC_CAPABILITY_REQUIRED", "HOST_RPC_SESSION_MISMATCH"]) {
    let requests = 0;
    let fatal: Error | null = null;
    const transport = new HostRpcHttpTransport({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
      fetchImpl: async () => { requests++; return new Response(JSON.stringify({ ok: false, code }), { status: 409, headers: { "Content-Type": "application/json" } }); },
      execute: async () => { assert.fail("拒绝后不得执行任务"); },
      events: { onFatal: error => { fatal = error; } },
    });
    try {
      transport.start("session");
      await waitFor(() => fatal !== null);
      assert.match(String(fatal), code === "HOST_RPC_CAPABILITY_REQUIRED" ? /capability rejected/ : /without recovery owner/);
      assert.equal(requests, 1);
    } finally { await transport.stopAndDrain(); }
  }
});

test("RPC 重连时正在执行的旧任务自然收口，不把结果提交到新 session", async () => {
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const sessions: string[] = [];
  let executions = 0;
  let posts = 0;
  let completed = false;
  let fatal: Error | null = null;
  const task: HostRpcHttpTask = { operationId: "old-op", message: { t: "api.req", id: "old-request", method: "fs.tree", path: "/fs/tree", body: {} } };
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
    fetchImpl: (async (url, init) => {
      if (!String(url).includes("/next")) { posts++; throw new Error("旧结果不应发起提交"); }
      sessions.push(new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session")!);
      if (sessions.length === 1) return new Response(JSON.stringify(task));
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }) as typeof fetch,
    execute: async () => { executions++; await blocked; return [{ t: "api.res", id: "old-request", status: 200, body: { ok: true } }]; },
    events: { onFatal: error => { fatal = error; }, onDiagnostic: (_level, message, data) => { if (message === "Host RPC task completed") completed = data?.outcome === "gone"; } },
  });
  try {
    transport.start("old");
    await waitFor(() => executions === 1);
    transport.start("new");
    await waitFor(() => sessions.includes("new"));
    finish();
    await waitFor(() => completed);
    assert.equal(executions, 1);
    assert.equal(posts, 0);
    assert.equal(fatal, null);
  } finally { finish(); await transport.stopAndDrain(); }
});

test("旧请求中断后不重新建立退避，单个处理名额也能立即切换连接", async () => {
  for (const phase of ["poll", "result"] as const) {
    const sessions: string[] = [];
    let posts = 0;
    let executes = 0;
    let fatal: Error | null = null;
    const task: HostRpcHttpTask = { operationId: "old-op", message: { t: "api.req", id: "old-request", method: "fs.tree", path: "/fs/tree", body: {} } };
    const transport = new HostRpcHttpTransport({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a",
      retryBaseMs: 10_000, maxConcurrency: 1,
      fetchImpl: (async (url, init) => {
        const session = new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session")!;
        if (String(url).includes("/next")) {
          sessions.push(session);
          if (phase === "result" && session === "old" && sessions.length === 1) return new Response(JSON.stringify(task));
        } else posts++;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }) as typeof fetch,
      execute: async () => { executes++; return [{ t: "api.res", id: "old-request", status: 200, body: { ok: true } }]; },
      events: { onFatal: error => { fatal = error; } },
    });
    try {
      transport.start("old");
      await waitFor(() => phase === "poll" ? sessions.length === 1 : posts === 1);
      transport.start("new");
      await waitFor(() => sessions.includes("new"), 500);
      assert.equal(posts, phase === "result" ? 1 : 0);
      assert.equal(executes, phase === "result" ? 1 : 0);
      assert.equal(fatal, null);
    } finally { await transport.stopAndDrain(); }
  }
});

test("旧版 Server 连续通用 409 后重新握手，明确的 poll 冲突保持退避", async () => {
  for (const code of [null, "CONFLICT", "HOST_RPC_POLL_CONFLICT"] as const) {
    let oldPolls = 0;
    let newPolls = 0;
    let invalidations = 0;
    let fatal: Error | null = null;
    const diagnostics: DiagnosticEntry[] = [];
    const transport = new HostRpcHttpTransport({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
      fetchImpl: (async (_url, init) => {
        if (new Headers(init?.headers).get("X-Codeflow-Host-Rpc-Session") === "old") {
          oldPolls++;
          if (oldPolls <= 3) return code
            ? new Response(JSON.stringify({ ok: false, code }), { status: 409, headers: { "Content-Type": "application/json" } })
            : new Response(null, { status: 409 });
        } else newPolls++;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }) as typeof fetch,
      execute: async () => { assert.fail("冲突响应不得执行任务"); },
      events: { onSessionInvalidated: () => { invalidations++; }, onFatal: error => { fatal = error; },
        onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
    });
    try {
      transport.start("old");
      if (code === "HOST_RPC_POLL_CONFLICT") {
        await waitFor(() => oldPolls === 4);
        assert.equal(invalidations, 0);
      } else {
        await waitFor(() => invalidations === 1);
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.equal(oldPolls, 3);
        assert.equal(invalidations, 1);
        const recovery = diagnostics.find(entry => entry.message === "Host RPC session invalidated; waiting for WS handshake");
        assert.equal(recovery?.data?.clientId, "host-a");
        transport.start("new");
        await waitFor(() => newPolls === 1);
      }
      assert.equal(fatal, null);
    } finally { await transport.stopAndDrain(); }
  }
});

test("旧版 409 连续计数遇到成功或其它失败即清零", async () => {
  const statuses = [409, 409, 204, 409, 409, 500, 409, 409, 409];
  let polls = 0;
  let invalidations = 0;
  let fatal: Error | null = null;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
    fetchImpl: async () => {
      assert.equal(invalidations, 0, "请求恢复后必须等待新握手");
      assert.ok(polls < statuses.length, "第三次连续冲突后不得继续领取");
      return new Response(null, { status: statuses[polls++]! });
    },
    execute: async () => { assert.fail("无任务响应不得执行 handler"); },
    events: { onSessionInvalidated: () => { invalidations++; }, onFatal: error => { fatal = error; } },
  });
  try {
    transport.start("session");
    await waitFor(() => invalidations === 1);
    assert.equal(polls, statuses.length);
    assert.equal(fatal, null);
  } finally { await transport.stopAndDrain(); }
});

test("旧版 409 缺少恢复 owner 时必须显式失败", async () => {
  let polls = 0;
  let fatal: Error | null = null;
  const transport = new HostRpcHttpTransport({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10,
    fetchImpl: async () => { polls++; return new Response(null, { status: 409 }); },
    execute: async () => { assert.fail("冲突响应不得执行 handler"); },
    events: { onFatal: error => { fatal = error; } },
  });
  try {
    transport.start("session");
    await waitFor(() => fatal !== null);
    assert.match(String(fatal), /without recovery owner/);
    assert.equal(polls, 3);
  } finally { await transport.stopAndDrain(); }
});

test("旧版结果提交 409 触发恢复并释放名额，不重复执行或提交旧任务", async () => {
  for (const code of [null, "CONFLICT"] as const) {
    let polls = 0;
    let posts = 0;
    let executes = 0;
    let invalidations = 0;
    let fatal: Error | null = null;
    const diagnostics: DiagnosticEntry[] = [];
    const task: HostRpcHttpTask = { operationId: "old-op", message: { t: "api.req", id: "old-request", method: "fs.tree", path: "/fs/tree", body: {} } };
    const transport = new HostRpcHttpTransport({
      serverWsUrl: "ws://127.0.0.1:39280/ws/client", apiKey: "test-key", clientId: "host-a", retryBaseMs: 10, maxConcurrency: 1,
      fetchImpl: (async (url, init) => {
        if (String(url).includes("/next")) {
          polls++;
          if (polls === 1) return new Response(JSON.stringify(task));
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
          });
        }
        posts++;
        return code ? new Response(JSON.stringify({ ok: false, code }), { status: 409, headers: { "Content-Type": "application/json" } })
          : new Response(null, { status: 409 });
      }) as typeof fetch,
      execute: async () => { executes++; return [{ t: "api.res", id: "old-request", status: 200, body: { ok: true } }]; },
      events: { onSessionInvalidated: () => { invalidations++; }, onFatal: error => { fatal = error; },
        onDiagnostic: (level, message, data) => diagnostics.push({ level, message, data }) },
    });
    try {
      transport.start("old");
      await waitFor(() => invalidations === 1);
      transport.start("new");
      await waitFor(() => polls === 2);
      assert.equal(executes, 1);
      assert.equal(posts, 1);
      const recovery = diagnostics.find(entry => entry.message === "Host RPC session invalidated; waiting for WS handshake");
      assert.equal(recovery?.data?.hostRpcOperationId, "old-op");
      assert.equal(fatal, null);
    } finally { await transport.stopAndDrain(); }
  }
});

test("Client uses a fixed shutdown reason for Host RPC fatal errors", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /onFatal:\s*\(\)\s*=>\s*shutdown\("host_rpc_http_failed",\s*1\)/);
  assert.equal(source.includes("host_rpc_http_failed:${error.message}"), false);
});

test("HostRpcHttpTransport rejects credential-bearing Server URLs before fetch", () => {
  const urlCredential = "URL_CREDENTIAL_SECRET";
  let fetchCalls = 0;
  assert.throws(
    () => new HostRpcHttpTransport({
      serverWsUrl: `wss://host-user:${urlCredential}@internal-url.invalid/ws/client?token=url-query`,
      apiKey: "api-key-url",
      clientId: "host-a",
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      execute: async () => [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "Host RPC Server URL must not include credentials");
      assertSensitiveTextAbsent(`${error.name}\n${error.message}`, [
        urlCredential,
        "host-user",
        "internal-url.invalid",
        "url-query",
        "api-key-url",
      ]);
      return true;
    },
  );
  assert.equal(fetchCalls, 0);
});
