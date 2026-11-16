import assert from "node:assert/strict";
import test from "node:test";
import { logger } from "../src/logger.js";
import { writeEngineWorkspaceLog } from "../src/engines/threadSession.js";

test("普通引擎日志失败只向应用告警，保留关联且不暴露正文", t => {
  const warnings: unknown[][] = [];
  t.mock.method(logger, "warn", (...args: unknown[]) => { warnings.push(args); });
  assert.doesNotThrow(() => writeEngineWorkspaceLog(() => { throw new Error("PRIVATE_LOG_PATH"); }, "workspace", () => ({
    level: "info", tag: "codex", message: "diagnostic", data: { requestId: "request", threadId: "thread", turnId: "turn", prompt: "PRIVATE_PROMPT" },
  }), { reason: new Error("PRIVATE_BUSINESS_MESSAGE") }));
  assert.equal(warnings.length, 1);
  const data = warnings[0]![2] as Record<string, unknown>;
  assert.equal(data.code, "ENGINE_WORKSPACE_LOG_DEGRADED");
  assert.equal(data.requestId, "request");
  assert.equal(data.workspaceId, "workspace");
  assert.equal(data.threadId, "thread");
  assert.equal(data.turnId, "turn");
  assert.equal(JSON.stringify(warnings).includes("PRIVATE_"), false);
});

test("工作区日志与应用告警双失败必须显式保留原始原因", t => {
  const primary = new Error("workspace-log"), fallback = new Error("application-log");
  t.mock.method(logger, "warn", () => { throw fallback; });
  assert.throws(() => writeEngineWorkspaceLog(() => { throw primary; }, "workspace", () => ({
    level: "info", tag: "codex", message: "diagnostic",
  })), error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(fallback));
});
