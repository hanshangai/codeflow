import test from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_WS_CLOSE_CODE_ACCESS_CHANGED,
  CLIENT_WS_CLOSE_CODE_HEARTBEAT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_PREEMPT_DECLINED,
  CLIENT_WS_CLOSE_CODE_PREEMPT_TIMEOUT,
  CLIENT_WS_CLOSE_CODE_REPLACED,
  CLIENT_WS_CLOSE_CODE_STOP_REQUESTED,
  CLIENT_WS_CLOSE_CODE_TRY_AGAIN_LATER,
  isFatalClientCloseCode,
  resolveClientWsCloseDisposition,
} from "../../apps/desktop/client/src/transport/wsCloseCodes.ts";

test("temporary and unknown close codes remain reconnectable", () => {
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_HEARTBEAT_TIMEOUT), "reconnect");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_TRY_AGAIN_LATER), "reconnect");
  assert.equal(resolveClientWsCloseDisposition(4999), "reconnect");
  assert.equal(resolveClientWsCloseDisposition(4012), "reconnect");
  assert.equal(isFatalClientCloseCode(4999), false);
});

test("access, policy, and preempt failures enter blocked retry", () => {
  assert.equal(resolveClientWsCloseDisposition(1008), "blocked");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_ACCESS_CHANGED), "blocked");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_PREEMPT_DECLINED), "blocked");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_PREEMPT_TIMEOUT), "blocked");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_REPLACED, "API key rotated"), "blocked");
  assert.equal(isFatalClientCloseCode(1008), true);
});

test("only explicit stop and legacy replacement reasons stop the daemon", () => {
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_STOP_REQUESTED), "stop");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_REPLACED, "Kicked by admin"), "stop");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_REPLACED, "Kicked by enterprise admin"), "stop");
  assert.equal(resolveClientWsCloseDisposition(CLIENT_WS_CLOSE_CODE_REPLACED, "Replaced by another client"), "stop");
});
