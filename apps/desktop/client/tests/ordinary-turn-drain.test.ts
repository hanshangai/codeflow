import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadId, TurnId, WorkspaceId } from "@codeflowai/shared";
import * as owners from "../src/app/ordinaryTurnExecution.js";

/** 控制真实回合尾链，不以provider状态或固定延时推断完成。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** 同thread/turn在不同W仍由各自原record持有。 */
function scope(workspaceId = "drain:a") {
  return { workspaceId: workspaceId as WorkspaceId, threadId: "thread" as ThreadId, turnId: "turn" as TurnId };
}

test("普通关闭排空真实尾链，provider结束不代表资源已释放", async () => {
  const sessions = {}, tail = deferred(), entered = deferred();
  let released = false, drained = false;
  owners.trackOrdinaryTurnExecution(sessions, scope(), async control => {
    control.markProviderDispatch();
    entered.resolve();
    await tail.promise;
    released = true;
  });
  await entered.promise;
  const running = owners.drainOrdinaryTurnExecutions(sessions).then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  assert.equal(released, false);
  tail.resolve();
  await running;
  assert.equal(released, true);
  assert.equal(owners.hasOrdinaryTurnExecutions(sessions), false);
});

test("普通关闭不重放已结束回合失败，精确等待仍可查询原失败", async () => {
  const sessions = {}, identity = scope();
  owners.trackOrdinaryTurnExecution(sessions, identity, async () => { throw undefined; });
  await assert.rejects(owners.waitForOrdinaryTurnExecution(sessions, identity), error => error === undefined);
  assert.equal(owners.listOrdinaryTurnExecutions(sessions).length, 0);
  await owners.drainOrdinaryTurnExecutions(sessions);
  await assert.rejects(owners.waitForOrdinaryTurnExecution(sessions, identity), error => error === undefined);
});

test("普通关闭首错仍等待其余W并按登记顺序保留全部原值", async () => {
  const sessions = {}, tail = deferred(), first = new Error("first-tail-failed");
  owners.trackOrdinaryTurnExecution(sessions, scope(), async () => { throw first; });
  owners.trackOrdinaryTurnExecution(sessions, scope("drain:b"), async () => { await tail.promise; throw 0; });
  let settled = false;
  const running = owners.drainOrdinaryTurnExecutions(sessions);
  const checked = assert.rejects(running, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [first, 0]);
    assert.equal(error.cause, first);
    return true;
  }).then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  tail.resolve();
  await checked;
});

test("普通关闭收齐等待期间原owner创建的后继尾链", async () => {
  const sessions = {}, parent = deferred(), child = deferred(), childStarted = deferred();
  owners.trackOrdinaryTurnExecution(sessions, scope(), async () => {
    await parent.promise;
    owners.trackOrdinaryTurnExecution(sessions, scope("drain:b"), async () => {
      childStarted.resolve();
      await child.promise;
    });
  });
  let settled = false;
  const running = owners.drainOrdinaryTurnExecutions(sessions).then(() => { settled = true; });
  parent.resolve();
  await childStarted.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  child.resolve();
  await running;
});

test("普通关闭隔离session owner且空集合正常完成", async () => {
  const failed = {}, healthy = {}, original = { failure: "tail-failed" };
  owners.trackOrdinaryTurnExecution(failed, scope(), async () => { throw original; });
  await owners.drainOrdinaryTurnExecutions(healthy);
  await assert.rejects(owners.waitForOrdinaryTurnExecution(failed, scope()), error => error === original);
  await owners.drainOrdinaryTurnExecutions(failed);
  await owners.drainOrdinaryTurnExecutions(healthy);
});
