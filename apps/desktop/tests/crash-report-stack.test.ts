import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertDesktopCrashReport, digestDesktopCrashReport, type DesktopCrashReport } from "@codeflowai/shared/desktop-crash-report";
import { createDesktopCrashCapture } from "../src/crashReportCapture.js";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";

/** 构造主进程异常报告；摘要覆盖实际字段，用于验证旧报告与堆栈合同。 */
function report(overrides: Partial<Omit<DesktopCrashReport, "payloadSha256">> = {}): DesktopCrashReport {
  const payload = {
    schemaVersion: 1 as const, kind: "crash" as const, reportId: crypto.randomUUID(), deviceId,
    sessionId: "ad0f2a9e-3d9b-4f1a-8f7c-2b0e7e1f8c11", sessionStartedAt: "2026-01-01T00:00:00.000Z",
    event: "main_uncaught_exception" as const, processType: "main" as const, reason: "exception" as const, exitCode: null,
    occurredAt: "2026-01-01T00:00:10.000Z", detectedAt: "2026-01-01T00:00:10.000Z", phase: null,
    errorCode: "DESKTOP_TEST_FAILED", requestId: null, causeCodes: [], recentErrors: [],
    versions: { shellVersion: "1.0.0", webVersion: "1.0.0", clientVersion: "1.0.0", releaseId: null, shellId: null },
    platform: "win32" as const, arch: "x64" as const, ...overrides,
  };
  return { ...payload, payloadSha256: digestDesktopCrashReport(payload) };
}

test("旧报告不带 stack 仍然通过合同校验", () => {
  assert.doesNotThrow(() => assertDesktopCrashReport(report()));
});

test("堆栈只接受调用帧，异常消息会被拒绝", () => {
  assert.doesNotThrow(() => assertDesktopCrashReport(report({
    stack: "at run (file:///app/main.js:1:1)\nat boot (file:///app/boot.js:2:2)",
  })));
  assert.throws(() => assertDesktopCrashReport(report({
    stack: "Error: secret\nat run (file:///app/main.js:1:1)",
  })), /invalid crash stack frame/u);
});

test("采集主进程异常时移除消息和用户目录，只保留调用帧", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-crash-stack-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "device-identity.json"), JSON.stringify({ deviceId }));
  const capture = createDesktopCrashCapture({ dataDir: directory, app: new EventEmitter() as never, shellVersion: "1.0.0" });
  t.after(() => capture.dispose());
  capture.initialize();
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const error = new Error("secret-message");
  error.stack = `Error: secret-message\n    at run (${home}/app/main.js:1:1)\n    at boot (${home}/app/boot.js:2:2)`;
  process.emit("uncaughtExceptionMonitor", error);

  const pending = capture.journal.pending(deviceId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.stack, "at run (~/app/main.js:1:1)\nat boot (~/app/boot.js:2:2)");
  assert.doesNotMatch(JSON.stringify(pending[0]), /secret-message/u);
});
