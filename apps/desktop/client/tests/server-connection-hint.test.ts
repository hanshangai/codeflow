import assert from "node:assert/strict";
import test from "node:test";

import { resolveServerConnectionHint } from "../src/transport/serverConnectionHint.ts";
import { resolveClientWsCloseDisposition } from "../src/transport/wsCloseCodes.ts";

test("removed account quota close code uses ordinary reconnect behavior", () => {
  const hint = resolveServerConnectionHint({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    message: null,
    code: 4012,
    reason: "Account client limit exceeded: active 2, max 2 online clients",
    hasConnectedBefore: false,
  });

  assert.equal(hint, null);
  assert.equal(resolveClientWsCloseDisposition(4012), "reconnect");
});

test("authorization failure keeps its normal handling", () => {
  const hint = resolveServerConnectionHint({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    message: "authorization failed after account client limit exceeded",
    code: 1008,
    reason: "Account client limit exceeded: active 2, max 2 online clients",
    hasConnectedBefore: false,
  });

  assert.ok(hint);
  assert.match(hint, /鉴权失败/);
  assert.match(hint, /CODEFLOWAI_API_KEY/);
});

test("network interruption still explains automatic reconnect", () => {
  const hint = resolveServerConnectionHint({
    serverWsUrl: "ws://127.0.0.1:39280/ws/client",
    message: null,
    code: 1006,
    reason: "",
    hasConnectedBefore: true,
  });

  assert.ok(hint);
  assert.match(hint, /自动重连/);
});
