import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EngineModelInfo, EngineStatus } from "../../packages/shared/src/types/engine.ts";
import { createEngineCliDetectionLoader, runCli } from "../../apps/desktop/client/src/app/handlers/engineHandlers.ts";
import {
  mergeEngineStatusAfterDetection,
  resolveEngineCliStatusIssue,
  resolveEngineImageInputAllowed,
} from "../../apps/web/src/utils/engineAvailability.ts";

const IMAGE_MODEL: EngineModelInfo = {
  id: "gpt-image",
  displayName: "GPT Image",
  isDefault: true,
  inputModalities: ["text", "image"],
};

const TEXT_MODEL: EngineModelInfo = {
  id: "gpt-text",
  displayName: "GPT Text",
  isDefault: false,
  inputModalities: ["text"],
};

/** 构造测试所需的最小 Codex 状态。 */
function codexStatus(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    engineType: "codex",
    installed: true,
    version: "codex 1.0.0",
    binPath: "codex",
    features: {
      streaming: true,
      reasoning: true,
      toolUse: true,
      imageInput: true,
      sessionContinuation: true,
    },
    models: [IMAGE_MODEL, TEXT_MODEL],
    detectionStatus: "available",
    detectionDurationMs: 20,
    error: null,
    ...overrides,
  };
}

test("runCli 对超时返回结构化失败类别", async () => {
  const result = await runCli({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    timeoutMs: 200,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "timeout");
  assert.match(result.error ?? "", /timeout/);
});

test("Client CLI 探测在并发和调用方放弃等待时保持 singleflight", async () => {
  let detectionCount = 0;
  let releaseDetection!: (value: string) => void;
  const pendingDetection = new Promise<string>((resolve) => {
    releaseDetection = resolve;
  });
  const load = createEngineCliDetectionLoader(async () => {
    detectionCount += 1;
    return await pendingDetection;
  }, { ttlMs: 20_000 });

  const abandonedRequest = load();
  const joinedRequest = load();
  await Promise.resolve();
  assert.equal(detectionCount, 1);
  releaseDetection("available");

  assert.equal(await joinedRequest, "available");
  assert.equal(await abandonedRequest, "available");
  assert.equal(await load(), "available");
  assert.equal(detectionCount, 1);
});

test("Client CLI 探测短 TTL 到期后才重新执行", async () => {
  let now = 100;
  let detectionCount = 0;
  const load = createEngineCliDetectionLoader(async () => `detection-${++detectionCount}`, {
    ttlMs: 20,
    now: () => now,
  });

  assert.equal(await load(), "detection-1");
  now = 119;
  assert.equal(await load(), "detection-1");
  assert.equal(detectionCount, 1);
  now = 120;
  assert.equal(await load(), "detection-2");
  assert.equal(detectionCount, 2);
});

test("Client CLI 探测意外异常不进入短 TTL 缓存", async () => {
  let detectionCount = 0;
  const load = createEngineCliDetectionLoader(async () => {
    detectionCount += 1;
    if (detectionCount === 1) throw new Error("injected detection failure");
    return "recovered";
  }, { ttlMs: 20_000 });

  await assert.rejects(load(), /injected detection failure/);
  assert.equal(await load(), "recovered");
  assert.equal(detectionCount, 2);
});

test("Client CLI 探测显式失败状态原样进入短 TTL 缓存", async () => {
  let detectionCount = 0;
  const timeoutStatus = { detectionStatus: "timeout", installed: false } as const;
  const load = createEngineCliDetectionLoader(async () => {
    detectionCount += 1;
    return timeoutStatus;
  }, { ttlMs: 20_000 });

  assert.deepEqual(await load(), timeoutStatus);
  assert.deepEqual(await load(), timeoutStatus);
  assert.equal(detectionCount, 1);
});

test("runCli 在 Windows 超时后回收完整子进程树", { skip: process.platform !== "win32" }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidt-engine-status-process-tree-"));
  const markerPath = path.join(tempDir, "descendant-heartbeat.txt");
  const descendantScript = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(markerPath)}, "started\\n");`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(markerPath)}, "tick\\n"), 100);`,
  ].join(" ");
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    `spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });`,
    "setTimeout(() => {}, 5000);",
  ].join(" ");

  try {
    const result = await runCli({
      command: process.execPath,
      args: ["-e", parentScript],
      timeoutMs: 800,
    });
    assert.equal(result.failureKind, "timeout");
    assert.doesNotMatch(result.error ?? "", /process tree termination failure/);
    assert.equal(fs.existsSync(markerPath), true);
    const sizeAfterTermination = fs.statSync(markerPath).size;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(fs.statSync(markerPath).size, sizeAfterTermination);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("一次探测超时沿用上次已确认状态并保留失败详情", () => {
  const previous = codexStatus();
  const timeout = codexStatus({
    installed: false,
    version: null,
    features: {
      streaming: false,
      reasoning: false,
      toolUse: false,
      imageInput: false,
      sessionContinuation: false,
    },
    detectionStatus: "timeout",
    detectionDurationMs: 8_001,
    error: "timeout",
  });

  const merged = mergeEngineStatusAfterDetection(previous, timeout);

  assert.equal(merged.installed, true);
  assert.equal(merged.version, previous.version);
  assert.deepEqual(merged.features, previous.features);
  assert.equal(merged.detectionStatus, "timeout");
  assert.equal(merged.error, "timeout");
  assert.match(resolveEngineCliStatusIssue("codex", merged) ?? "", /已沿用上次可用状态/);
});

test("首次探测超时保持未知状态，不伪造成可用", () => {
  const timeout = codexStatus({
    installed: false,
    version: null,
    detectionStatus: "timeout",
    error: "timeout",
  });

  const merged = mergeEngineStatusAfterDetection(null, timeout);

  assert.equal(merged.installed, false);
  assert.match(resolveEngineCliStatusIssue("codex", merged) ?? "", /当前状态未知/);
});

test("明确不可用不会沿用旧状态", () => {
  const unavailable = codexStatus({
    installed: false,
    version: null,
    features: {
      streaming: false,
      reasoning: false,
      toolUse: false,
      imageInput: false,
      sessionContinuation: false,
    },
    detectionStatus: "unavailable",
    error: "command not found",
  });

  const merged = mergeEngineStatusAfterDetection(codexStatus(), unavailable);

  assert.equal(merged.installed, false);
  assert.equal(merged.detectionStatus, "unavailable");
  assert.match(resolveEngineCliStatusIssue("codex", merged) ?? "", /command not found/);
  assert.equal(resolveEngineImageInputAllowed("codex", merged, IMAGE_MODEL), false);
});

test("探测超时时按模型目录判断图片能力", () => {
  const timeout = codexStatus({
    installed: false,
    detectionStatus: "timeout",
    features: {
      streaming: false,
      reasoning: false,
      toolUse: false,
      imageInput: false,
      sessionContinuation: false,
    },
    error: "timeout",
  });

  assert.equal(resolveEngineImageInputAllowed("codex", timeout, IMAGE_MODEL), true);
  assert.equal(resolveEngineImageInputAllowed("codex", timeout, TEXT_MODEL), false);
});

test("旧 Client 的 timeout 文本仍按未知状态兼容", () => {
  const legacyTimeout = codexStatus({
    installed: false,
    detectionStatus: undefined,
    error: "timeout",
  });

  assert.equal(mergeEngineStatusAfterDetection(codexStatus(), legacyTimeout).installed, true);
  assert.equal(resolveEngineImageInputAllowed("codex", legacyTimeout, IMAGE_MODEL), true);
});
