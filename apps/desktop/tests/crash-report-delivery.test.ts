import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { DesktopCrashReport } from "@codeflowai/shared/desktop-crash-report";
import { createCrashReportJournal } from "../src/crashReportJournal.js";
import { deliverDesktopCrashReports } from "../src/crashReportDelivery.js";

const deviceId = "868683b1-e79b-4509-9ca1-97b7786e5344";

/** 独立临时目录保存待报证据。 */
async function fixture(t: test.TestContext) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "desktop-crash-delivery-"));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 生成最小有效报告并返回日志写入后的权威副本。 */
function record(journal: ReturnType<typeof createCrashReportJournal>, requestId: string | null = null): DesktopCrashReport {
  const sessionId = crypto.randomUUID(), at = new Date().toISOString();
  const payload = {
    schemaVersion: 1 as const, kind: "crash" as const, reportId: crypto.randomUUID(), deviceId, sessionId,
    sessionStartedAt: at, event: "main_uncaught_exception" as const, processType: "main" as const, reason: "exception" as const,
    exitCode: null, occurredAt: at, detectedAt: at, phase: null, errorCode: "DESKTOP_TEST_FAILED", requestId,
    causeCodes: [], recentErrors: [],
    versions: { shellVersion: "1.0.0", webVersion: null, clientVersion: null, releaseId: null, shellId: null },
    platform: "win32" as const, arch: "x64" as const,
  };
  return journal.record(payload);
}

test("crash delivery registers once and acknowledges the exact evidence", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const first = record(journal), second = record(journal, "request-2");
  const sent: string[] = [];
  let registrations = 0;
  await deliverDesktopCrashReports({ journal, deviceId, transport: {
    async register() { registrations++; },
    async requestJson(input) {
      assert.equal(input.path, "/api/software/desktop/crash-reports");
      assert.equal(input.requestId, input.body.reportId);
      sent.push(input.body.reportId);
      return { ok: true, reportId: input.body.reportId, deviceId, payloadSha256: input.body.payloadSha256 };
    },
  } });
  assert.equal(registrations, 1);
  assert.deepEqual(sent, [first.reportId, second.reportId]);
  assert.deepEqual(journal.pending(deviceId), []);
});

test("wrong crash acknowledgement stops the batch and keeps evidence pending", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const first = record(journal), second = record(journal);
  let sends = 0;
  await assert.rejects(() => deliverDesktopCrashReports({ journal, deviceId, transport: {
    async register() {},
    async requestJson(input) {
      sends++;
      return { ok: true, reportId: input.body.reportId, deviceId, payloadSha256: "0".repeat(64) };
    },
  } }), { code: "DESKTOP_CRASH_ACK_INVALID", requestId: first.reportId });
  assert.equal(sends, 1);
  assert.deepEqual(journal.pending(deviceId), [first, second]);
});

test("lost acknowledgement replays the same evidence on the next startup", async t => {
  const directory = await fixture(t), journal = createCrashReportJournal(directory);
  const first = record(journal);
  let lose = true, sends = 0;
  const transport = {
    async register() {},
    async requestJson(input: { body: DesktopCrashReport }) {
      sends++;
      assert.equal(JSON.stringify(input.body), JSON.stringify(first));
      if (lose) throw Object.assign(new Error("connection lost"), { code: "DESKTOP_UPDATE_TRANSPORT_FAILED" });
      return { ok: true, reportId: input.body.reportId, deviceId, payloadSha256: input.body.payloadSha256 };
    },
  };
  await assert.rejects(() => deliverDesktopCrashReports({ journal, deviceId, transport }),
    { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: first.reportId });
  assert.deepEqual(createCrashReportJournal(directory).pending(deviceId), [first]);
  lose = false;
  await deliverDesktopCrashReports({ journal: createCrashReportJournal(directory), deviceId, transport });
  assert.equal(sends, 2);
  assert.deepEqual(journal.pending(deviceId), []);
});
