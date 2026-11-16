import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationEventInput, RawEngineEventInput } from "@codeflowai/shared";

import { applyEngineEventToConversation } from "../../apps/web/src/features/chat/engineEventReducer.ts";
import { createConversationState } from "../support/conversation-fixture.ts";
import {
  sanitizeClientToServerMessage,
  sanitizeConversationEvent,
  sanitizeRawEvent,
} from "../../apps/desktop/client/src/diagnostics/eventOutputPolicy.ts";

/** 构造 Codex 命令终态，覆盖事件裁剪到历史渲染的完整链路。 */
function commandCompletedEvent(output: Record<string, unknown>, status: "completed" | "failed" = "failed"): Extract<ConversationEventInput, { type: "item.tool.completed" }> {
  return {
    ts: 1,
    workspaceId: "ws-command" as any,
    threadId: "thread-command" as any,
    engine: "codex",
    type: "item.tool.completed",
    payload: { itemId: "command-failure" as any, toolName: "commandExecution", status, output },
  };
}

test("命令失败保留退出码、目录和实际原因，历史回放可直接展示且重复裁剪幂等", () => {
  const output = {
    type: "commandExecution", command: "node -e script", exitCode: 1, cwd: "D:/repo/apps/server",
    aggregatedOutput: "SyntaxError: Unexpected identifier 'node'",
  };
  const event = commandCompletedEvent(output);
  const sanitized = sanitizeConversationEvent(event);
  assert.equal(sanitized.type, "item.tool.completed");
  if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  assert.equal(sanitized.payload.status, "failed");
  assert.equal(sanitized.payload.error, "命令执行失败\n退出码：1\n工作目录：D:/repo/apps/server\nSyntaxError: Unexpected identifier 'node'");
  assert.equal((sanitized.payload.output as any).preview, output.aggregatedOutput);
  assert.deepEqual(sanitizeConversationEvent(sanitized), sanitized);
  assert.equal(event.payload.output, output);

  const state = createConversationState();
  applyEngineEventToConversation(state, JSON.parse(JSON.stringify({ ...sanitized, schema: 1, seq: 1 })));
  const tool = state.items.find(item => item.kind === "tool");
  assert.equal(tool?.status, "failed");
  assert.equal(tool?.output, sanitized.payload.error);
});

test("长命令诊断保留首尾原因、限制 UTF-8 字节数并脱敏凭据", () => {
  const event = commandCompletedEvent({
    exit_code: -1,
    cwd: "目录😀".repeat(200),
    aggregated_output: `Error: authentication rejected\npassword=example-password token=example-token api_key=example-key\nAuthorization: Bearer example-auth\npostgresql://user:example-db-password@localhost/test\n${"中😀".repeat(2000)}\nRoot cause: module pg not found`,
  });
  const sanitized = sanitizeConversationEvent(event);
  if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  const error = sanitized.payload.error!;
  assert.ok(Buffer.byteLength(error, "utf8") <= 2048);
  assert.match(error, /退出码：-1/u);
  assert.match(error, /authentication rejected/u);
  assert.match(error, /Root cause: module pg not found/u);
  assert.doesNotMatch(error, /example-(password|token|key|auth|db-password)/u);
  assert.doesNotMatch(JSON.stringify(sanitized.payload.output), /example-(password|token|key|auth|db-password)/u);
  assert.doesNotMatch(error, /\uFFFD/u);
});

test("空输出和 stderr 仍明确失败，不把退出码 1 改为成功", () => {
  for (const output of [
    { exitCode: 1, aggregatedOutput: "" },
    { exitCode: 1, aggregatedOutput: null },
    { exitCode: 1, stderr: "Get-Content: path does not exist", aggregatedOutput: "normal stdout" },
  ]) {
    const sanitized = sanitizeConversationEvent(commandCompletedEvent(output));
    if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
    assert.equal(sanitized.payload.status, "failed");
    assert.match(sanitized.payload.error!, /退出码：1/u);
    assert.match(sanitized.payload.error!, output.stderr ? /path does not exist/u : /引擎未提供命令输出，请结合命令与退出码核对原因/u);
  }
});

test("大量正常输出中间的路径、PowerShell 和类型错误仍保留在失败诊断", () => {
  for (const cause of [
    "rg: src/missing*: path syntax error (os error 123)",
    "Get-Content : Cannot find path src/missing.ts",
    "    + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand",
    "src/page.vue(1,1): error TS2339: Property does not exist",
  ]) {
    const event = commandCompletedEvent({
      exitCode: 1,
      aggregatedOutput: `${"normal output\n".repeat(100)}${cause}\n${"more output\n".repeat(100)}`,
    });
    const sanitized = sanitizeConversationEvent(event);
    if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
    assert.equal(sanitized.payload.status, "failed");
    assert.ok(sanitized.payload.error!.includes(cause));
    assert.ok(Buffer.byteLength(sanitized.payload.error!, "utf8") <= 2048);
    assert.deepEqual(sanitizeConversationEvent(sanitized), sanitized);
  }
});

test("输出含错误文字但退出成功时保持引擎原状态", () => {
  const sanitized = sanitizeConversationEvent(commandCompletedEvent({
    exitCode: 0,
    aggregatedOutput: "Error: quoted source or historical error",
  }, "completed"));
  if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  assert.equal(sanitized.payload.status, "completed");
  assert.equal(sanitized.payload.error, undefined);
});

test("成功、DEBUG 和已省略的历史事件不补造失败原因，已有 error 优先保留", () => {
  const output = { exitCode: 0, cwd: "D:/repo", aggregatedOutput: "completed" };
  const success = sanitizeConversationEvent(commandCompletedEvent(output, "completed"));
  if (success.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  assert.equal(success.payload.error, undefined);

  const failure = commandCompletedEvent({ ...output, exitCode: 1 });
  assert.equal(sanitizeConversationEvent(failure, { keepFullOutput: true }), failure);
  const historical = commandCompletedEvent({ omitted: true, reason: "non-assistant-output", preview: "node script" });
  const sanitizedHistory = sanitizeConversationEvent(historical);
  if (sanitizedHistory.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  assert.equal(sanitizedHistory.payload.error, undefined);
  assert.equal(sanitizedHistory.payload.status, "failed");

  if (failure.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  failure.payload.error = "Permission denied; token=example-existing-secret";
  const sanitized = sanitizeConversationEvent(failure);
  if (sanitized.type !== "item.tool.completed") assert.fail("应保留工具终态事件");
  assert.match(sanitized.payload.error!, /Permission denied/u);
  assert.doesNotMatch(sanitized.payload.error!, /example-existing-secret/u);
});

test("子任务命令的失败诊断与主会话使用同一裁剪入口", () => {
  const completed = commandCompletedEvent({ exitCode: 2, aggregatedOutput: "SyntaxError: child script" });
  const event: ConversationEventInput = {
    ts: 1, workspaceId: "ws-command" as any, threadId: "thread-command" as any, engine: "codex",
    type: "item.subagent.childEvent",
    payload: { itemId: "subagent" as any, taskId: "subagent", innerEventType: completed.type, innerPayload: completed.payload },
  };
  const sanitized = sanitizeConversationEvent(event);
  if (sanitized.type !== "item.subagent.childEvent") assert.fail("应保留子任务事件");
  const payload = sanitized.payload.innerPayload as { status: string; error: string };
  assert.equal(payload.status, "failed");
  assert.match(payload.error, /退出码：2/u);
  assert.match(payload.error, /SyntaxError: child script/u);
});

test("conversation event sanitizer keeps AI text and reasoning, but omits tool output", () => {
  const assistantEvent: ConversationEventInput = {
    ts: 1,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.agentMessage.delta",
    payload: {
      itemId: "msg-1" as any,
      engineMessageId: "engine-msg-1",
      delta: "assistant body",
    },
  };
  const diffEvent: ConversationEventInput = {
    ts: 2,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.diff.created",
    payload: {
      itemId: "diff-1" as any,
      title: "Diff",
      diff: "@@ -1 +1 @@\n-old\n+new",
    },
  };
  const reasoningEvent: ConversationEventInput = {
    ts: 3,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.reasoning.delta",
    payload: {
      itemId: "reasoning-1" as any,
      delta: "private chain of thought",
    },
  };
  const toolDeltaEvent: ConversationEventInput = {
    ts: 4,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.tool.outputDelta",
    payload: {
      itemId: "tool-1" as any,
      toolName: "commandExecution",
      delta: "very large command output",
      mode: "append",
    },
  };
  const toolCompletedEvent: ConversationEventInput = {
    ts: 5,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    type: "item.tool.completed",
    payload: {
      itemId: "tool-1" as any,
      toolName: "commandExecution",
      output: {
        command: "rg foo .",
        stdout: "matched line 1\nmatched line 2\nmatched line 3",
      },
      status: "completed",
    },
  };

  assert.equal((sanitizeConversationEvent(assistantEvent).payload as any).delta, "assistant body");
  assert.equal((sanitizeConversationEvent(diffEvent).payload as any).diff, "@@ -1 +1 @@\n-old\n+new");
  assert.equal((sanitizeConversationEvent(reasoningEvent).payload as any).delta, "private chain of thought");

  const sanitizedToolDelta = sanitizeConversationEvent(toolDeltaEvent);
  assert.equal((sanitizedToolDelta.payload as any).delta, "[工具输出已省略，非 DEBUG 模式不保留全文]");
  assert.equal((sanitizedToolDelta.payload as any).mode, "replace");

  const sanitizedToolCompleted = sanitizeConversationEvent(toolCompletedEvent);
  assert.deepEqual((sanitizedToolCompleted.payload as any).output, {
    omitted: true,
    reason: "non-assistant-output",
    originalType: "object",
    originalBytes: Buffer.byteLength(JSON.stringify((toolCompletedEvent.payload as any).output), "utf8"),
    preview: "matched line 1 matched line 2 matched line 3",
  });
});

test("conversation event sanitizer also sanitizes nested subagent child tool outputs", () => {
  const event: ConversationEventInput = {
    ts: 10,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "claude",
    type: "item.subagent.childEvent",
    payload: {
      itemId: "subagent-1" as any,
      taskId: "task-1",
      innerEventType: "item.tool.completed",
      innerPayload: {
        itemId: "tool-2" as any,
        toolName: "Bash",
        output: { stdout: "subagent tool output" },
        status: "completed",
      },
    },
  };

  const sanitized = sanitizeConversationEvent(event);
  assert.deepEqual((sanitized.payload as any).innerPayload.output, {
    omitted: true,
    reason: "non-assistant-output",
    originalType: "object",
    originalBytes: Buffer.byteLength(JSON.stringify({ stdout: "subagent tool output" }), "utf8"),
    preview: "subagent tool output",
  });
});

test("raw event sanitizer keeps AI body and reasoning, but redacts tool raw payloads", () => {
  const codexToolRaw: RawEngineEventInput = {
    ts: 1,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "item/commandExecution/outputDelta",
      params: {
        itemId: "tool-1",
        delta: "A".repeat(5_000),
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: ["item.tool.outputDelta"],
  };
  const codexDiffRaw: RawEngineEventInput = {
    ts: 2,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "turn/diff/updated",
      params: {
        diff: "@@ -1 +1 @@\n-old\n+new",
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: ["item.diff.created"],
  };
  const codexReasoningRaw: RawEngineEventInput = {
    ts: 2.2,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "item/reasoning/textDelta",
      params: {
        itemId: "reasoning-1",
        delta: "codex reasoning text",
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: ["item.reasoning.delta"],
  };
  const codexPlanCompletedRaw: RawEngineEventInput = {
    ts: 2.5,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: {
      method: "item/completed",
      params: {
        item: {
          id: "plan-1",
          type: "plan",
          text: "- step 1\n- step 2",
        },
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: ["item.tool.completed"],
  };
  const claudeAssistantRaw: RawEngineEventInput = {
    ts: 3,
    workspaceId: "ws-1" as any,
    threadId: "thread-1" as any,
    engine: "claude",
    source: "claude.stream-json.stdout",
    data: {
      type: "assistant",
      message: {
        id: "assistant-1",
        content: [
          { type: "text", text: "assistant body" },
          { type: "thinking", thinking: "internal reasoning" },
          { type: "tool_result", content: "tool stdout" },
        ],
      },
    },
    handled: true,
    action: "mapped",
    emittedTypes: ["item.agentMessage.completed"],
  };

  const sanitizedCodexToolRaw = sanitizeRawEvent(codexToolRaw);
  assert.match(String((sanitizedCodexToolRaw.data as any).params.delta), /^\[原始输出已省略，非 DEBUG 模式不保留全文]/);

  const sanitizedCodexDiffRaw = sanitizeRawEvent(codexDiffRaw);
  assert.match(String((sanitizedCodexDiffRaw.data as any).params.diff), /^\[原始输出已省略，非 DEBUG 模式不保留全文]/);
  assert.equal((sanitizedCodexDiffRaw.data as any).params.diffBytes, Buffer.byteLength("@@ -1 +1 @@\n-old\n+new", "utf8"));
  assert.match(String((sanitizedCodexDiffRaw.data as any).params.diffSha256), /^[a-f0-9]{64}$/);

  const sanitizedCodexReasoningRaw = sanitizeRawEvent(codexReasoningRaw);
  assert.equal((sanitizedCodexReasoningRaw.data as any).params.delta, "codex reasoning text");

  const sanitizedCodexPlanCompletedRaw = sanitizeRawEvent(codexPlanCompletedRaw);
  assert.match(String((sanitizedCodexPlanCompletedRaw.data as any).params.item.text), /^\[原始输出已省略，非 DEBUG 模式不保留全文]/);

  const sanitizedClaudeAssistantRaw = sanitizeRawEvent(claudeAssistantRaw);
  assert.equal((sanitizedClaudeAssistantRaw.data as any).message.content[0].text, "assistant body");
  assert.equal((sanitizedClaudeAssistantRaw.data as any).message.content[1].thinking, "internal reasoning");
  assert.deepEqual((sanitizedClaudeAssistantRaw.data as any).message.content[2].content, {
    omitted: true,
    reason: "non-assistant-output",
    originalType: "string",
    originalBytes: Buffer.byteLength("tool stdout", "utf8"),
    preview: "tool stdout",
  });
});

test("debug full output flag bypasses the sanitizer", () => {
  const message = {
    t: "conversation.event",
    event: {
      ts: 1,
      workspaceId: "ws-1" as any,
      threadId: "thread-1" as any,
      engine: "codex",
      type: "item.tool.outputDelta",
      payload: {
        itemId: "tool-1" as any,
        toolName: "commandExecution",
        delta: "full output",
      },
    },
  } as const;

  const sanitized = sanitizeClientToServerMessage(message as any, { keepFullOutput: true });
  assert.equal((sanitized as any).event.payload.delta, "full output");
});

test("Skill 隐私投影在 debug 与 api.res 历史读取中仍覆盖嵌套事件和完整指令", () => {
  const realPath = "Z:\\Users\\tester\\.codex\\skills\\review\\SKILL.md";
  const instructions = "private skill instructions";
  const message = {
    t: "api.res",
    id: "req-events",
    status: 200,
    body: {
      events: [
        {
          method: "item/started",
          params: { item: { type: "skill", name: "review", path: realPath } },
        },
        {
          method: "item/completed",
          params: { item: { nested: { type: "skill", name: "review", path: realPath } } },
        },
        {
          method: "turn/completed",
          params: { turn: { items: [{ type: "skill", name: "review", path: realPath }] } },
        },
        {
          method: "rawResponseItem/completed",
          params: {
            item: {
              type: "message",
              role: "user",
              content: [{
                type: "input_text",
                text: `before <skill>\n${realPath}\n${instructions}\n</skill> after`,
              }],
            },
          },
        },
      ],
    },
  };

  const sanitized = sanitizeClientToServerMessage(message as any, { keepFullOutput: true }) as any;
  const serialized = JSON.stringify(sanitized);
  assert.doesNotMatch(serialized, /Users\\\\tester/u);
  assert.doesNotMatch(serialized, /private skill instructions/u);
  assert.match(serialized, /Codex Skill path omitted/u);
  assert.match(serialized, /Codex Skill instructions omitted/u);
});
