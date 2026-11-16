import test from "node:test";
import assert from "node:assert/strict";

import { ClaudeThreadSession } from "../../apps/desktop/client/src/engines/claude/claudeThreadSession.ts";
import { testEngineWorkspaceLog } from "../../apps/desktop/client/tests/engine-workspace-log-fixture.ts";

test("ClaudeThreadSession prepareAssistantTerminalEvents 会在 turn 收尾时补齐 pending assistant", async () => {
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: null,
    onEngineProcessSnapshot() {
      return false;
    },
    onSessionId() {},
  });

  (session as any).assistantLifecycle.startTurn("turn-client" as any);
  (session as any).assistantLifecycle.ensureStarted({
    itemId: "assistant_1",
    engineMessageId: "engine-assistant-1",
    turnId: "turn-client",
    phase: "commentary",
  });
  (session as any).assistantLifecycle.appendDelta("assistant_1", "partial commentary");

  const reconciled = await session.prepareAssistantTerminalEvents({
    turnId: "turn-client" as any,
    outcome: "error",
  });

  assert.equal(reconciled.events.length, 1);
  assert.deepEqual((reconciled.events[0] as any)?.payload, {
    itemId: "assistant_1",
    engineMessageId: "engine-assistant-1",
    turnId: "turn-client",
    text: "partial commentary",
    revision: 1,
    phase: "commentary",
    completionSource: "runtime_close_reconcile",
    structuredPayloadJson: null,
  });
  assert.equal(reconciled.latestAssistantText, "partial commentary");
});
test("ClaudeThreadSession required 平台工具使用 native dynamic bridge", () => {
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: null,
    onEngineProcessSnapshot() {
      return false;
    },
    onSessionId() {},
  });

  const toolRegistry = {
    tools: [{
      toolsetId: "__runtime_submit__" as any,
      toolsetName: "内建编排提交",
      toolId: "runtime.submitNodeResult" as any,
      name: "提交节点结果",
      alias: null,
      description: "提交节点结果",
      runtime: "builtin",
      usageGuidance: null,
      invocationHint: null,
      code: "",
      inputSchema: "{\"type\":\"object\"}",
      outputSchema: "{\"type\":\"object\"}",
      timeoutMs: null,
      workingDirectory: null,
      permissions: { requiresWrite: false },
      envPolicy: null,
      required: true,
    }],
  };

  assert.equal(session.resolvePlatformToolTransport(toolRegistry as any, "required"), "native-dynamic");
  assert.equal(session.resolvePlatformToolTransport(null, "required"), "native-dynamic");
});

test("ClaudeThreadSession 只暴露当前 session 与 generation 的 Slash 目录", async () => {
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: null,
    onEngineProcessSnapshot() {
      return false;
    },
    onSessionId() {},
  });
  const internal = session as any;
  internal.lifecycleToken = 4;
  internal.setSessionId("session-a", () => {});
  internal.observeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["help"],
    skills: [],
  }, 4);

  assert.deepEqual((await session.listInputActions("/")).actions.map((action) => action.token), ["/help"]);

  internal.observeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["late"],
    skills: [],
  }, 3);
  assert.deepEqual((await session.listInputActions("/")).actions.map((action) => action.token), ["/help"]);

  internal.setSessionId("session-b", () => {});
  const afterSessionChange = await session.listInputActions("/");
  assert.equal(afterSessionChange.providerCatalog.state, "unavailable");
  assert.deepEqual(afterSessionChange.actions, []);
});

test("ClaudeThreadSession 非法 init 清空目录，后续合法 init 可恢复", async () => {
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: "Z:/code/codeflowai",
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    initialSessionId: "session-a" as any,
    onEngineProcessSnapshot() {
      return false;
    },
    onSessionId() {},
  });
  const internal = session as any;
  internal.lifecycleToken = 2;
  internal.observeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["help"],
    skills: [],
  }, 2);
  assert.equal((await session.listInputActions("/")).providerCatalog.state, "ready");

  internal.observeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["help"],
  }, 2);
  assert.equal((await session.listInputActions("/")).providerCatalog.state, "unavailable");

  internal.observeInputActionCatalog({
    type: "system",
    subtype: "init",
    session_id: "session-a",
    slash_commands: ["review"],
    skills: ["review"],
  }, 2);
  const recovered = await session.listInputActions("/");
  assert.equal(recovered.providerCatalog.state, "ready");
  assert.deepEqual(recovered.actions.map((action) => ({
    token: action.kind === "slash" ? action.token : null,
    isSkill: action.kind === "slash" && action.source === "claude" ? action.isSkill : null,
  })), [{ token: "/review", isSkill: true }]);

  assert.deepEqual((await session.listInputActions("$")).actions, []);
  await session.dispose();
  assert.equal((await session.listInputActions("/")).providerCatalog.state, "unavailable");
});
