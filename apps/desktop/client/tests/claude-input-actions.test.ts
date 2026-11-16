import test from "node:test";
import assert from "node:assert/strict";

import {
  extractClaudeLocalCommandOutput,
  extractSafeClaudeSlashCommandName,
  inspectClaudeProviderSlashFinalResult,
  parseClaudeInputActionCatalog,
} from "../src/engines/claude/claudeInputActions.ts";
import { buildClaudeStreamJsonInput } from "../src/engines/claude/claudeStreamJsonInput.ts";

test("Claude init 目录精确去重、区分大小写并标记 Skill 交集", () => {
  const snapshot = parseClaudeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["help", "/review", "Review", "help", "/review"],
    skills: ["review", "/Review", "unused"],
    claude_code_version: "2.1.0",
  }, 7, 1234);

  assert.equal(snapshot?.sessionId, "session-a");
  assert.equal(snapshot?.generation, 7);
  assert.deepEqual(snapshot?.response.providerCatalog, {
    state: "ready",
    observedAt: 1234,
    providerVersion: "2.1.0",
    message: null,
  });
  assert.deepEqual(snapshot?.response.actions.map((action) => ({
    token: action.kind === "slash" ? action.token : null,
    providerName: action.kind === "slash" ? action.providerName : null,
    isSkill: action.kind === "slash" ? action.isSkill : null,
  })), [
    { token: "/help", providerName: "help", isSkill: false },
    { token: "/review", providerName: "review", isSkill: true },
    { token: "/Review", providerName: "Review", isSkill: true },
  ]);
});

test("Claude init 目录要求 slash_commands 与 skills 都是完整合法数组", () => {
  const base = {
    type: "system",
    subtype: "init",
    session_id: "session-a",
  };
  const invalid = [
    { ...base, slash_commands: ["help"] },
    { ...base, skills: ["review"] },
    { ...base, slash_commands: "help", skills: [] },
    { ...base, slash_commands: [], skills: ["bad name"] },
    { ...base, slash_commands: ["/bad/name"], skills: [] },
    { ...base, slash_commands: [], skills: [], session_id: "" },
  ];

  for (const value of invalid) {
    assert.equal(parseClaudeInputActionCatalog(value, 1), null);
  }
  assert.equal(parseClaudeInputActionCatalog({ ...base, slash_commands: [], skills: [] }, -1), null);
  assert.equal(parseClaudeInputActionCatalog({
    ...base,
    slash_commands: [],
    skills: [],
    claude_code_version: { invalid: true },
  }, 1)?.response.providerCatalog.providerVersion, null);
});

test("Claude 显式 message 不把 /foo 编码为字符串 Slash", () => {
  const line = buildClaudeStreamJsonInput({
    text: "/foo --bar",
    images: [],
    inputKind: "message",
  });
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: "/foo --bar" }],
    },
  });
});

test("Claude 显式 provider-slash 保留原始参数并使用字符串 content", () => {
  const line = buildClaudeStreamJsonInput({
    text: "/review  src/a.ts --focus=types  ",
    images: [],
    inputKind: "provider-slash",
  });
  assert.deepEqual(JSON.parse(line), {
    type: "user",
    message: {
      role: "user",
      content: "/review  src/a.ts --focus=types  ",
    },
  });
  assert.throws(
    () => buildClaudeStreamJsonInput({ text: " /review", images: [], inputKind: "provider-slash" }),
    (error: any) => error?.code === "PROVIDER_SLASH_CONFLICT",
  );
  assert.throws(
    () => buildClaudeStreamJsonInput({ text: "/review", images: ["data:image/png;base64,AA=="], inputKind: "provider-slash" }),
    (error: any) => error?.code === "PROVIDER_SLASH_CONFLICT",
  );
});

test("Claude Provider Slash final result 只接受明确 success 且 is_error=false", () => {
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({
    type: "result",
    subtype: "success",
    is_error: false,
    result: " done ",
  }, 0), { kind: "success", resultText: "done" });
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({
    type: "result",
    subtype: "success",
    is_error: true,
  }, 0), { kind: "failure", subtype: "success", reason: "success_is_error_conflict" });
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({
    type: "result",
    subtype: "error_during_execution",
    is_error: false,
  }, 0), {
    kind: "failure",
    subtype: "error_during_execution",
    reason: "subtype_is_error_conflict",
  });
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
  }, 0), {
    kind: "failure",
    subtype: "error_during_execution",
    reason: "provider_reported_error",
  });
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({ type: "result" }, 0), {
    kind: "failure",
    subtype: "invalid",
    reason: "invalid_result_shape",
  });
  assert.deepEqual(inspectClaudeProviderSlashFinalResult({ type: "result" }, 1), { kind: "pending" });
  assert.equal(inspectClaudeProviderSlashFinalResult({ type: "assistant" }, 0), null);
});

test("Claude local command output 兼容 system 与 tagged user 形状", () => {
  assert.equal(extractClaudeLocalCommandOutput({
    type: "system",
    subtype: "local_command_output",
    content: "\u001b[31mfailed\u001b[0m",
  }), "failed");
  assert.equal(extractClaudeLocalCommandOutput({
    type: "user",
    message: {
      content: "<local-command-stdout>one</local-command-stdout>\n<local-command-stderr>two</local-command-stderr>",
    },
  }), "one\ntwo");
  assert.equal(extractClaudeLocalCommandOutput({ type: "user", message: { content: "ordinary" } }), null);
  assert.equal(extractSafeClaudeSlashCommandName("/review secret args"), "review");
  assert.equal(extractSafeClaudeSlashCommandName("/不安全 args"), "invalid");
});
