import assert from "node:assert/strict";
import test from "node:test";
import { readOrchAssetExecutionAuthorization } from "../../packages/shared/src/index.ts";

const history = {
  serverOrigin: "https://example.com", userId: "user", deviceId: "device", clientId: "client",
  hostBindingId: "binding", hostScopeEpoch: 1, sharedWorkspaceId: "shared", runtimeWorkspaceId: "workspace",
  contextKey: "context", authorityEpoch: 1, appliedChangeSeq: 10,
  revisionSetHash: "a".repeat(64), snapshotHash: "b".repeat(64),
};

test("历史缓存来源可读取且返回独立快照", () => {
  const parsed = readOrchAssetExecutionAuthorization(history);
  assert.deepEqual(parsed, history);
  assert.notEqual(parsed, history);
});

test("历史来源拒绝访问器、额外授权字段、非法范围和摘要", () => {
  let invoked = false;
  const accessor = { ...history };
  Object.defineProperty(accessor, "userId", { enumerable: true, get() { invoked = true; return "user"; } });
  assert.throws(() => readOrchAssetExecutionAuthorization(accessor));
  assert.equal(invoked, false);
  for (const invalid of [
    { ...history, signature: "unused" }, { ...history, authorityEpoch: -1 },
    { ...history, serverOrigin: "https://example.com/path" }, { ...history, snapshotHash: "invalid" },
    { ...history, userId: " user" }, Object.create(history),
  ]) assert.throws(() => readOrchAssetExecutionAuthorization(invalid));
});
