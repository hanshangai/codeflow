import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

import type { ClientToServerMessage, ClientLogFileListResponseBody, ClientLogTailResponseBody, ClientLogDownloadResponseBody } from "@codeflowai/shared";

import type { ApiHandlerContext, ApiRequestMessage } from "../../apps/desktop/client/src/app/handleApiRequest.ts";
import { handleClientLogsDownload, handleClientLogsFiles, handleClientLogsTail } from "../../apps/desktop/client/src/app/handlers/clientLogHandlers.ts";

test("client log handlers list, tail and download allowed log files", (t) => {
  withFakeDate(t, "2026-06-23T10:05:00.000Z");
  const logDir = createTempDir(t);
  writeLogFile(path.join(logDir, "client-20260623.log"), [
    { level: "INFO", time: "2026-06-23 10:00:00.000", module: "client", message: "client ready" },
    { level: "ERROR", time: "2026-06-23 10:01:00.000", module: "client", message: "client failed" },
  ]);
  writeLogFile(path.join(logDir, "client-daemon-20260623.err.log"), [
    { level: "WARN", time: "2026-06-23 10:02:00.000", module: "daemon", message: "daemon warning" },
  ]);
  fs.writeFileSync(path.join(logDir, "server.log"), "must not be listed\n", "utf8");

  withLogEnv(t, logDir);
  const listResponse = invokeClientLogHandler<ClientLogFileListResponseBody>(handleClientLogsFiles, { clientId: "client-a" });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.ok, true);
  assert.deepEqual(
    listResponse.body.files.map((file: { fileName: string }) => file.fileName).sort(),
    ["client-20260623.log", "client-daemon-20260623.err.log"],
  );

  const tailResponse = invokeClientLogHandler<ClientLogTailResponseBody>(handleClientLogsTail, {
    clientId: "client-a",
    fileName: "client-20260623.log",
    lines: 20,
  });
  assert.equal(tailResponse.status, 200);
  assert.equal(tailResponse.body.ok, true);
  assert.equal(tailResponse.body.logFileName, "client-20260623.log");
  assert.equal(tailResponse.body.lines.length, 2);
  assert.equal(tailResponse.body.lines[1].message, "client failed");

  const downloadResponse = invokeClientLogHandler<ClientLogDownloadResponseBody>(handleClientLogsDownload, {
    clientId: "client-a",
    fileName: "client-daemon-20260623.err.log",
  });
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.body.ok, true);
  assert.equal(downloadResponse.body.fileName, "client-daemon-20260623.err.log");
  const downloaded = Buffer.from(downloadResponse.body.contentBase64, "base64").toString("utf8");
  assert.match(downloaded, /daemon warning/);
});

test("client log handlers prune logs older than retention window before listing", (t) => {
  const logDir = createTempDir(t);
  writeLogFile(path.join(logDir, "client-20260616.log"), [
    { level: "INFO", time: "2026-06-16 10:00:00.000", module: "client", message: "old client" },
  ]);
  writeLogFile(path.join(logDir, "client-daemon-20260616.err.log"), [
    { level: "WARN", time: "2026-06-16 10:01:00.000", module: "daemon", message: "old daemon" },
  ]);
  writeLogFile(path.join(logDir, "client-20260616.log.1"), [
    { level: "INFO", time: "2026-06-16 10:02:00.000", module: "client", message: "old rotated client" },
  ]);
  writeLogFile(path.join(logDir, "client-20260617.log"), [
    { level: "INFO", time: "2026-06-17 10:00:00.000", module: "client", message: "retained client" },
  ]);

  withLogEnv(t, logDir);
  withFakeDate(t, "2026-06-23T12:00:00+08:00");
  const listResponse = invokeClientLogHandler<ClientLogFileListResponseBody>(handleClientLogsFiles, { clientId: "client-a" });

  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.ok, true);
  assert.deepEqual(
    listResponse.body.files.map((file: { fileName: string }) => file.fileName).sort(),
    ["client-20260617.log"],
  );
  assert.equal(fs.existsSync(path.join(logDir, "client-20260616.log")), false);
  assert.equal(fs.existsSync(path.join(logDir, "client-20260616.log.1")), false);
  assert.equal(fs.existsSync(path.join(logDir, "client-daemon-20260616.err.log")), false);
});

test("client log download rejects path traversal", (t) => {
  const logDir = createTempDir(t);
  writeLogFile(path.join(logDir, "client-20260623.log"), [
    { level: "INFO", time: "2026-06-23 10:00:00.000", module: "client", message: "client ready" },
  ]);

  withLogEnv(t, logDir);
  const response = invokeClientLogHandler(handleClientLogsDownload, {
    clientId: "client-a",
    fileName: "../client-20260623.log",
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.match(response.body.message, /不存在或不允许下载/);
});

/** 创建临时目录，并在测试结束后清理。 */
function createTempDir(t: TestContext): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-logs-"));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

/** 写入单行 JSON 日志，模拟 Client 当前日志格式。 */
function writeLogFile(filePath: string, entries: Array<Record<string, unknown>>): void {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

/** 临时切换 Client 日志目录相关环境变量。 */
function withLogEnv(t: TestContext, logDir: string): void {
  const previousLogDir = process.env.CODEFLOWAI_CLIENT_LOG_DIR;
  const previousLogFile = process.env.CODEFLOWAI_CLIENT_LOG_FILE;
  const previousRetentionDays = process.env.CODEFLOWAI_CLIENT_LOG_RETENTION_DAYS;
  process.env.CODEFLOWAI_CLIENT_LOG_DIR = logDir;
  process.env.CODEFLOWAI_CLIENT_LOG_FILE = "client.log";
  process.env.CODEFLOWAI_CLIENT_LOG_RETENTION_DAYS = "7";
  t.after(() => {
    restoreEnv("CODEFLOWAI_CLIENT_LOG_DIR", previousLogDir);
    restoreEnv("CODEFLOWAI_CLIENT_LOG_FILE", previousLogFile);
    restoreEnv("CODEFLOWAI_CLIENT_LOG_RETENTION_DAYS", previousRetentionDays);
  });
}

/** 固定 Date，便于验证按自然日计算的日志保留策略。 */
function withFakeDate(t: TestContext, isoNow: string): void {
  const realDate = globalThis.Date;
  const fixedNow = new realDate(isoNow).getTime();
  class FixedDate extends realDate {
    constructor(...args: any[]) {
      if (arguments.length === 0) super(fixedNow);
      else super(...(args as [any]));
    }

    static now(): number {
      return fixedNow;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  t.after(() => {
    globalThis.Date = realDate;
  });
}

/** 恢复测试前的环境变量状态。 */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

/** 调用日志 handler，返回同步发送的响应消息。 */
function invokeClientLogHandler<T = { message: string }>(
  handler: (ctx: ApiHandlerContext, req: ApiRequestMessage) => void,
  body: Record<string, unknown>,
): Omit<Extract<ClientToServerMessage, { t: "api.res" }>, "body"> & { body: T & { ok: boolean } } {
  let response: Extract<ClientToServerMessage, { t: "api.res" }> | null = null;
  const ctx = {
    clientId: "client-a",
    send: (msg: ClientToServerMessage) => {
      if (msg.t === "api.res") response = msg;
    },
  } as ApiHandlerContext;
  const req = { t: "api.req", id: "req-test", method: "client.logs.test", path: "/client/logs/test", body } as ApiRequestMessage;
  handler(ctx, req);
  assert.ok(response);
  // API 消息的 body 是传输层 unknown；每个用例继续对实际字段和值做断言。
  const message: Extract<ClientToServerMessage, { t: "api.res" }> = response;
  assert.ok(message.body && typeof message.body === "object");
  return { ...message, body: message.body as T & { ok: boolean } };
}
