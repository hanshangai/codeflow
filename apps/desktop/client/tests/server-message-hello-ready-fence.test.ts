import test from "node:test";
import assert from "node:assert/strict";

import { ServerMessageHelloReadyFence } from "../src/transport/serverMessageHelloReadyFence.ts";

test("当前连接的消息等待 hello 完成后放行", async () => {
  const fence = new ServerMessageHelloReadyFence();
  const generation = fence.beginConnection();
  const waiting = fence.waitUntilReady(generation);

  assert.equal(fence.markReady(generation), true);
  assert.equal(await waiting, true);
  assert.equal(await fence.waitUntilReady(generation), true);
});

test("断线释放等待消息但不授权执行", async () => {
  const fence = new ServerMessageHelloReadyFence();
  const generation = fence.beginConnection();
  const waiting = fence.waitUntilReady(generation);

  fence.closeConnection(generation);

  assert.equal(await waiting, false);
  assert.equal(fence.isCurrent(generation), false);
  assert.equal(await fence.waitUntilReady(generation), false);
});

test("旧连接完成不能放行重连后的消息", async () => {
  const fence = new ServerMessageHelloReadyFence();
  const staleGeneration = fence.beginConnection();
  const staleWaiting = fence.waitUntilReady(staleGeneration);
  const currentGeneration = fence.beginConnection();
  const currentWaiting = fence.waitUntilReady(currentGeneration);

  assert.equal(await staleWaiting, false);
  assert.equal(fence.isCurrent(staleGeneration), false);
  assert.equal(fence.markReady(staleGeneration), false);
  assert.equal(fence.markReady(currentGeneration), true);
  assert.equal(await currentWaiting, true);
});
