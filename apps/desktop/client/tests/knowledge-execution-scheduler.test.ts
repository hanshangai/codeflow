import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeExecutionScheduler, resolveKnowledgeExecutionConcurrency } from "../src/knowledge/knowledgeExecutionScheduler.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function options() { return { signal: new AbortController().signal }; }

test("生成与复检共享 Client 总额度，跨目录和工作区 FIFO 排队，排队期间不调用 work", async () => {
  const scheduler = new KnowledgeExecutionScheduler(2);
  const calls: string[] = [];
  const firstGate = deferred(), secondGate = deferred(), thirdGate = deferred();
  const states: string[] = [];
  const first = scheduler.run(options(), async () => { calls.push("ws-a/generation"); await firstGate.promise; });
  const second = scheduler.run(options(), async () => { calls.push("ws-b/generation"); await secondGate.promise; });
  const third = scheduler.run({ ...options(), onState: state => states.push(state) }, async () => { calls.push("ws-a/review"); await thirdGate.promise; });
  const fourth = scheduler.run(options(), async () => { calls.push("ws-c/generation"); return "完成"; });
  assert.deepEqual(calls, ["ws-a/generation", "ws-b/generation"]);
  assert.deepEqual(states, ["queued"]);
  assert.deepEqual(scheduler.snapshot(), { limit: 2, running: 2, queued: 2 });
  secondGate.resolve();
  await second;
  assert.deepEqual(calls, ["ws-a/generation", "ws-b/generation", "ws-a/review"]);
  assert.deepEqual(states, ["queued", "running"]);
  assert.deepEqual(scheduler.snapshot(), { limit: 2, running: 2, queued: 1 });
  firstGate.resolve();
  await first;
  assert.equal(await fourth, "完成");
  thirdGate.resolve();
  await third;
  assert.deepEqual(calls, ["ws-a/generation", "ws-b/generation", "ws-a/review", "ws-c/generation"]);
  assert.deepEqual(scheduler.snapshot(), { limit: 2, running: 0, queued: 0 });
});

test("排队取消立即移除，不创建执行会话，不阻挡后续任务", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), gate = deferred(), controller = new AbortController();
  const first = scheduler.run(options(), () => gate.promise);
  let cancelledCalls = 0, nextCalls = 0;
  const cancelled = scheduler.run({ signal: controller.signal }, async () => { cancelledCalls++; });
  const rejected = assert.rejects(cancelled, { code: "KNOWLEDGE_ASSET_INTERRUPTED" });
  const next = scheduler.run(options(), async () => { nextCalls++; });
  controller.abort();
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 1, queued: 1 });
  await rejected;
  assert.equal(cancelledCalls, 0);
  assert.equal(nextCalls, 0);
  gate.resolve();
  await Promise.all([first, next]);
  assert.equal(nextCalls, 1);
});

test("取消运行任务必须等待引擎及清理真正结束才释放额度", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), gate = deferred(), controller = new AbortController();
  let nextStarted = false;
  const first = scheduler.run({ signal: controller.signal }, () => gate.promise);
  const rejected = assert.rejects(first, /引擎已退出/);
  const next = scheduler.run(options(), async () => { nextStarted = true; });
  controller.abort();
  await Promise.resolve();
  assert.equal(nextStarted, false);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 1, queued: 1 });
  gate.reject(new Error("引擎已退出"));
  await Promise.all([rejected, next]);
  assert.equal(nextStarted, true);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 0, queued: 0 });
});

test("异常释放额度，原始错误透传且 FIFO 后续任务继续", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), gate = deferred();
  const failure = new Error("复检失败");
  const first = scheduler.run(options(), () => gate.promise);
  const rejected = assert.rejects(first, error => error === failure);
  let calls = 0;
  const next = scheduler.run(options(), async () => ++calls);
  gate.reject(failure);
  await rejected;
  assert.equal(await next, 1);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 0, queued: 0 });
});

test("进入队列前已取消的任务不运行，也不发送状态通知", async () => {
  const scheduler = new KnowledgeExecutionScheduler(2), controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(scheduler.run({ signal: controller.signal, onState: () => { calls++; } }, async () => { calls++; }), { code: "KNOWLEDGE_ASSET_INTERRUPTED" });
  assert.equal(calls, 0);
  assert.deepEqual(scheduler.snapshot(), { limit: 2, running: 0, queued: 0 });
});

test("排队状态通知内取消能即时清理等待项", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), gate = deferred(), controller = new AbortController();
  const first = scheduler.run(options(), () => gate.promise);
  let calls = 0;
  await assert.rejects(scheduler.run({ signal: controller.signal, onState: state => { if (state === "queued") controller.abort(); } }, async () => { calls++; }), { code: "KNOWLEDGE_ASSET_INTERRUPTED" });
  assert.equal(calls, 0);
  assert.equal(scheduler.snapshot().queued, 0);
  gate.resolve();
  await first;
});

test("运行状态通知内取消不得创建引擎，额度立即回收", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), controller = new AbortController();
  let calls = 0;
  await assert.rejects(scheduler.run({ signal: controller.signal, onState: () => controller.abort() }, async () => { calls++; }), { code: "KNOWLEDGE_ASSET_INTERRUPTED" });
  assert.equal(calls, 0);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 0, queued: 0 });
});

test("状态通知异常不会泄漏运行额度或排队项", async () => {
  const scheduler = new KnowledgeExecutionScheduler(1), gate = deferred();
  const first = scheduler.run(options(), () => gate.promise);
  let calls = 0;
  await assert.rejects(scheduler.run({ ...options(), onState: () => { throw new Error("排队保存失败"); } }, async () => { calls++; }), /排队保存失败/);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 1, queued: 0 });
  gate.resolve();
  await first;
  await assert.rejects(scheduler.run({ ...options(), onState: () => { throw new Error("运行保存失败"); } }, async () => { calls++; }), /运行保存失败/);
  assert.equal(calls, 0);
  assert.deepEqual(scheduler.snapshot(), { limit: 1, running: 0, queued: 0 });
});

test("并发预算默认允许 5，接受本地 1..16 整数，非法环境配置回退为 5", () => {
  for (const value of [undefined, "", "0", "17", "-1", "NaN", "2.5", "Infinity", "20threads", "1e0"]) {
    assert.equal(resolveKnowledgeExecutionConcurrency(value), 5);
  }
  for (const value of [1, 2, 3, 4, 5, 8, 16]) assert.equal(resolveKnowledgeExecutionConcurrency(` ${value} `), value);
  for (const value of [0, 17, -1, 2.5, NaN, Infinity]) assert.throws(() => new KnowledgeExecutionScheduler(value), RangeError);
});
