import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyTurnErrorSemantics,
  extractTurnErrorMetadata,
  humanizeTurnErrorMessage,
  isTransientTurnError,
  isTransientTurnErrorCode,
  MANUAL_TURN_INTERRUPT_CODE,
  MANUAL_TURN_INTERRUPT_USER_MESSAGE,
} from "../../packages/shared/src/index.ts";
import { createTurnErrorEventInputFromError } from "../../apps/desktop/client/src/errors/turnErrors.ts";

test("isTransientTurnErrorCode only matches confirmed terminal cleanup codes", () => {
  assert.equal(isTransientTurnErrorCode("codex_cancelled"), true);
  assert.equal(isTransientTurnErrorCode("codex_interrupted"), true);
  assert.equal(isTransientTurnErrorCode("client_restarted"), true);
  assert.equal(isTransientTurnErrorCode("client_restart_reconcile_timeout"), false);
  assert.equal(isTransientTurnErrorCode("reconcile_failed"), false);
  assert.equal(isTransientTurnErrorCode("startup_reconcile_missing_codex_context"), false);
  assert.equal(isTransientTurnErrorCode("codex_turn_missing_after_restart"), false);
  assert.equal(isTransientTurnErrorCode("codex_thread_idle_without_terminal"), false);
  assert.equal(isTransientTurnErrorCode("session_invalidated"), false);
});

test("classifyTurnErrorSemantics distinguishes manual interrupt from restart cleanup", () => {
  assert.equal(classifyTurnErrorSemantics({ error: "turn interrupted" }), "error");
  assert.equal(classifyTurnErrorSemantics({ code: MANUAL_TURN_INTERRUPT_CODE, error: "request cancelled by user" }), "manual_interrupt");
  assert.equal(classifyTurnErrorSemantics({ code: "codex_interrupted", error: "request interrupted upstream" }), "transient_cleanup");
  assert.equal(classifyTurnErrorSemantics({ code: "client_restarted", error: "restart cleanup" }), "transient_cleanup");
  assert.equal(classifyTurnErrorSemantics({ code: "session_invalidated", error: "session invalidated" }), "error");
});

test("isTransientTurnError keeps manual interrupt and restart cleanup in warning lane", () => {
  assert.equal(isTransientTurnError({ error: "turn interrupted" }), false);
  assert.equal(isTransientTurnError({ code: MANUAL_TURN_INTERRUPT_CODE, error: "turn interrupted" }), true);
  assert.equal(isTransientTurnError({ code: "codex_interrupted", error: "request interrupted upstream" }), true);
  assert.equal(isTransientTurnError({ code: "session_invalidated", error: "session invalidated" }), false);
});

test("humanizeTurnErrorMessage maps manual interrupt to Chinese and keeps other diagnostics", () => {
  assert.equal(humanizeTurnErrorMessage("turn interrupted"), MANUAL_TURN_INTERRUPT_USER_MESSAGE);
  assert.equal(humanizeTurnErrorMessage(" Turn Interrupted "), MANUAL_TURN_INTERRUPT_USER_MESSAGE);
  assert.equal(humanizeTurnErrorMessage("TURN INTERRUPTED"), MANUAL_TURN_INTERRUPT_USER_MESSAGE);
  assert.equal(humanizeTurnErrorMessage(null), null);
  assert.equal(humanizeTurnErrorMessage(undefined), null);
  assert.equal(humanizeTurnErrorMessage("   "), null);
  assert.equal(humanizeTurnErrorMessage(""), null);
  assert.equal(humanizeTurnErrorMessage("boom"), "boom");
  assert.equal(humanizeTurnErrorMessage("turn interrupted by operator"), "turn interrupted by operator");
});

test("extractTurnErrorMetadata keeps additionalDetails and providerErrorInfo on enriched errors", () => {
  const error = new Error("") as Error & {
    method?: string;
    additionalDetails?: string;
    providerErrorInfo?: string;
  };
  error.method = "thread/start";
  error.additionalDetails = "relay rejected request";
  error.providerErrorInfo = "other";

  const metadata = extractTurnErrorMetadata(error);
  assert.equal(metadata.message, "");
  assert.equal(metadata.requestMethod, "thread/start");
  assert.equal(metadata.additionalDetails, "relay rejected request");
  assert.equal(metadata.providerErrorInfo, "other");
});

test("extractTurnErrorMetadata strictly preserves provider thread recovery choices", () => {
  const error = Object.assign(new Error("原会话明确不可恢复"), {
    code: "codex_thread_resume_unrecoverable",
    providerThreadId: " provider-thread-demo ",
    reason: " resume_unavailable_and_read_failed ",
    preserveBinding: true,
    userChoiceRequired: true,
    recoveryStrategies: ["retry-existing", "unknown", "new-thread", "new-thread"],
  });

  const metadata = extractTurnErrorMetadata(error);
  assert.equal(metadata.providerThreadId, "provider-thread-demo");
  assert.equal(metadata.recoveryReason, "resume_unavailable_and_read_failed");
  assert.equal(metadata.preserveBinding, true);
  assert.equal(metadata.userChoiceRequired, true);
  assert.deepEqual(metadata.recoveryStrategies, ["retry-existing", "new-thread"]);
});

test("extractTurnErrorMetadata rejects truthy recovery flags and unknown strategies", () => {
  const metadata = extractTurnErrorMetadata({
    message: "恢复状态未确认",
    providerThreadId: 42,
    reason: { code: "unexpected" },
    preserveBinding: "true",
    userChoiceRequired: 1,
    recoveryStrategies: ["new_thread", "fork"],
  });

  assert.equal(metadata.providerThreadId, undefined);
  assert.equal(metadata.recoveryReason, undefined);
  assert.equal(metadata.preserveBinding, undefined);
  assert.equal(metadata.userChoiceRequired, undefined);
  assert.equal(metadata.recoveryStrategies, undefined);
});

test("createTurnErrorEventInputFromError serializes enriched turn error metadata into payload", () => {
  const error = new Error("") as Error & {
    method?: string;
    additionalDetails?: string;
    providerErrorInfo?: string;
    code?: string;
    providerThreadId?: string;
    reason?: string;
    preserveBinding?: boolean;
    userChoiceRequired?: boolean;
    recoveryStrategies?: string[];
  };
  error.method = "thread/start";
  error.additionalDetails = "relay rejected request";
  error.providerErrorInfo = "other";
  error.code = "codex_thread_resume_unrecoverable";
  error.providerThreadId = "provider-thread-event";
  error.reason = "resume_unavailable_and_read_failed";
  error.preserveBinding = true;
  error.userChoiceRequired = true;
  error.recoveryStrategies = ["retry-existing", "new-thread"];

  const event = createTurnErrorEventInputFromError({
    workspaceId: "client-a:ws-demo" as any,
    threadId: "thread-demo" as any,
    engine: "codex",
    turnId: "turn-demo" as any,
    error,
  });

  assert.equal(event.payload.error, "");
  assert.equal(event.payload.requestMethod, "thread/start");
  assert.equal(event.payload.additionalDetails, "relay rejected request");
  assert.equal(event.payload.providerErrorInfo, "other");
  assert.equal(event.payload.providerThreadId, "provider-thread-event");
  assert.equal(event.payload.recoveryReason, "resume_unavailable_and_read_failed");
  assert.equal(event.payload.preserveBinding, true);
  assert.equal(event.payload.userChoiceRequired, true);
  assert.deepEqual(event.payload.recoveryStrategies, ["retry-existing", "new-thread"]);
  assert.equal(event.payload.terminationKind, "error");
});
