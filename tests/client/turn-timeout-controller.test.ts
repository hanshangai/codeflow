import test from "node:test";
import assert from "node:assert/strict";

import type { ConversationEventInput, RawEngineEventInput } from "@codeflowai/shared";

import { TurnTimeoutController } from "../../apps/desktop/client/src/engines/turnTimeoutController.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createActivityController(options?: {
  engineIdleTimeoutMs?: number;
  onTimeout?: (error: Error & { code?: string; detail?: unknown }) => void;
  conversation?: ConversationEventInput[];
  raw?: RawEngineEventInput[];
}) {
  const conversation = options?.conversation ?? [];
  const raw = options?.raw ?? [];
  const controller = new TurnTimeoutController({
    workspaceId: "ws-demo",
    threadId: "thread-demo",
    engine: "codex",
    turnId: "turn-demo",
    policy: {
      mode: "activity",
      startupTimeoutMs: 1_000,
      engineIdleTimeoutMs: options?.engineIdleTimeoutMs ?? 40,
    },
    emitConversation(event) {
      conversation.push(event);
    },
    emitRaw(event) {
      raw.push(event);
    },
    onTimeout(error) {
      options?.onTimeout?.(error as Error & { code?: string; detail?: unknown });
    },
  });
  return { controller, conversation, raw };
}

test("TurnTimeoutController still fires engine idle timeout when the engine has no active tool", async () => {
  const state: { timeout: (Error & { code?: string; detail?: unknown }) | null } = { timeout: null };
  const { controller, conversation, raw } = createActivityController({
    engineIdleTimeoutMs: 40,
    onTimeout(error) {
      state.timeout = error;
    },
  });

  controller.start();
  await delay(80);
  controller.stop();

  assert.equal(state.timeout?.code, "engine_idle_timeout");
  assert.equal(conversation.length, 0);
  assert.equal(raw.length, 1);
  assert.equal((raw[0] as any)?.source, "timeout.controller");
  assert.equal((raw[0] as any)?.data?.code, "engine_idle_timeout");
  assert.equal((raw[0] as any)?.data?.timeoutSequence, 1);
  assert.equal((state.timeout?.detail as any)?.timeoutSequence, 1);
  assert.equal((raw[0] as any)?.data?.engineIdleTimeoutMs, 40);
  assert.equal((raw[0] as any)?.data?.lastActivitySource, "timeout.controller");
  assert.equal((raw[0] as any)?.data?.lastActivityType, "monitoring_started");
  assert.equal((raw[0] as any)?.data?.activeToolCount, 0);
  assert.equal((raw[0] as any)?.data?.activeSubagentCount, 0);
  assert.equal((raw[0] as any)?.data?.waitingApprovalCount, 0);
  assert.equal((raw[0] as any)?.data?.waitingUserInputCount, 0);
});

test("TurnTimeoutController re-arms activity monitoring after provider state confirms the turn is still running", async () => {
  const timeouts: Array<Error & { code?: string; detail?: unknown }> = [];
  const { controller, raw } = createActivityController({
    engineIdleTimeoutMs: 30,
    onTimeout(error) {
      timeouts.push(error);
    },
  });

  controller.start();
  await delay(60);

  assert.equal(timeouts.length, 1);
  assert.equal((timeouts[0]?.detail as any)?.timeoutSequence, 1);
  assert.equal((raw[0] as any)?.data?.timeoutSequence, 1);
  assert.equal(controller.resumeAfterTimeout("provider_turn_in_progress"), true);
  assert.equal((raw[1] as any)?.source, "timeout.controller");
  assert.equal((raw[1] as any)?.data?.recovery, "monitoring_resumed");
  assert.equal((raw[1] as any)?.data?.reason, "provider_turn_in_progress");
  assert.equal((raw[1] as any)?.data?.timeoutSequence, 1);
  assert.equal((raw[1] as any)?.data?.lastActivityType, "monitoring_resumed");

  await delay(60);
  assert.equal(timeouts.length, 2);
  assert.equal((timeouts[1]?.detail as any)?.timeoutSequence, 2);
  assert.equal((raw[2] as any)?.data?.timeoutSequence, 2);
  assert.equal((raw[2] as any)?.data?.lastActivitySource, "timeout.controller");
  assert.equal((raw[2] as any)?.data?.lastActivityType, "monitoring_resumed");
  controller.stop();
  assert.equal(controller.resumeAfterTimeout("stopped"), false);
});

test("TurnTimeoutController no longer kills a quiet commandExecution while the provider-native tool is still active", async () => {
  const state: { timeout: (Error & { code?: string; detail?: unknown }) | null } = { timeout: null };
  const { controller, raw } = createActivityController({
    engineIdleTimeoutMs: 40,
    onTimeout(error) {
      state.timeout = error;
    },
  });

  controller.start();
  controller.onConversationEvent({
    ts: Date.now(),
    workspaceId: "ws-demo" as any,
    threadId: "thread-demo" as any,
    engine: "codex",
    type: "item.tool.started",
    payload: {
      itemId: "cmd-quiet" as any,
      toolName: "commandExecution",
    },
  });

  await delay(80);
  assert.equal((() => state.timeout)(), null);

  controller.onConversationEvent({
    ts: Date.now(),
    workspaceId: "ws-demo" as any,
    threadId: "thread-demo" as any,
    engine: "codex",
    type: "item.tool.completed",
    payload: {
      itemId: "cmd-quiet" as any,
      toolName: "commandExecution",
      status: "completed",
    },
  });

  await delay(80);
  controller.stop();

  assert.equal(state.timeout?.code, "engine_idle_timeout");
  assert.equal((raw[0] as any)?.data?.lastActivitySource, "conversation.event");
  assert.equal((raw[0] as any)?.data?.lastActivityType, "item.tool.completed");
  assert.equal((raw[0] as any)?.data?.activeToolCount, 0);
});

test("TurnTimeoutController records the last raw method without copying its payload", async () => {
  const { controller, raw } = createActivityController({ engineIdleTimeoutMs: 30 });

  controller.start();
  controller.onRawEvent({
    ts: Date.now(),
    workspaceId: "ws-demo" as any,
    threadId: "thread-demo" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: { method: "thread/tokenUsage/updated", secretPayload: "must-not-be-copied" },
    handled: true,
    action: "mapped",
    emittedTypes: [],
  });

  await delay(60);
  controller.stop();

  assert.equal((raw[0] as any)?.data?.lastActivitySource, "codex.app-server.msg");
  assert.equal((raw[0] as any)?.data?.lastActivityType, "thread/tokenUsage/updated");
  assert.equal(JSON.stringify((raw[0] as any)?.data).includes("must-not-be-copied"), false);
});

test("TurnTimeoutController rejects free text in raw method diagnostics", async () => {
  const { controller, raw } = createActivityController({ engineIdleTimeoutMs: 30 });

  controller.start();
  controller.onRawEvent({
    ts: Date.now(),
    workspaceId: "ws-demo" as any,
    threadId: "thread-demo" as any,
    engine: "codex",
    source: "codex.app-server.msg",
    data: { method: "secret token value must not be copied" },
    handled: false,
    action: "unhandled",
    emittedTypes: [],
  });

  await delay(60);
  controller.stop();

  assert.equal((raw[0] as any)?.data?.lastActivityType, "raw");
  assert.equal(JSON.stringify((raw[0] as any)?.data).includes("secret token value"), false);
});

test("TurnTimeoutController legacy hard timeout remains available as a compatibility fallback", async () => {
  const state: { timeout: (Error & { code?: string; detail?: unknown }) | null } = { timeout: null };
  const controller = new TurnTimeoutController({
    workspaceId: "ws-demo",
    threadId: "thread-demo",
    engine: "codex",
    turnId: "turn-demo",
    policy: {
      mode: "legacy-turn",
      timeoutMs: 40,
      startupTimeoutMs: 1_000,
    },
    emitConversation() {},
    emitRaw() {},
    onTimeout(error) {
      state.timeout = error as Error & { code?: string; detail?: unknown };
    },
  });

  controller.start();
  await delay(80);

  assert.equal(state.timeout?.code, "legacy_turn_timeout");
  assert.equal((state.timeout?.detail as any)?.timeoutSequence, 1);
  assert.match(state.timeout?.message ?? "", /单轮硬超时/);
  assert.equal(controller.resumeAfterTimeout("legacy_timeout"), false);
  controller.stop();
});


