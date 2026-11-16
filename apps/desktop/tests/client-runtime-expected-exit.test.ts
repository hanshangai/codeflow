import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createClientRuntime } from "../src/clientRuntime.js";

/** 仅在父进程停止请求后按预期退出的假 Client。 */
class FakeChild extends EventEmitter {
  constructor(private readonly autoExit: boolean) {
    super();
    queueMicrotask(() => this.emit("spawn"));
  }

  /** 与 Node 子进程一致：exit 之后紧跟 close，drain 才可能完成。 */
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    const result = super.emit(event, ...args);
    if (event === "exit") super.emit("close", ...args);
    return result;
  }

  send(_message: unknown, callback: (error: Error | null) => void): boolean {
    callback(null);
    if (this.autoExit) queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
}

/** 独立临时目录只承载运行日志，不接触真实 Client 数据。 */
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "client-runtime-exit-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a successful drain reports the client exit as expected", async t => {
  const dataDir = await fixture(t), exits: Array<{ exitCode: number | null; expected: boolean }> = [];
  const child = new FakeChild(true);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child as never,
    onExit: facts => exits.push({ exitCode: facts.exitCode, expected: facts.expected }) });
  await runtime.start();
  await runtime.drain(100);
  assert.deepEqual(exits, [{ exitCode: 0, expected: true }]);
});

test("a failed drain does not mask a later real client crash", async t => {
  const dataDir = await fixture(t), exits: Array<{ exitCode: number | null; expected: boolean }> = [];
  const child = new FakeChild(false);
  const runtime = createClientRuntime({ entry: "fixture.cjs", dataDir, spawn: () => child as never,
    onExit: facts => exits.push({ exitCode: facts.exitCode, expected: facts.expected }) });
  await runtime.start();
  await assert.rejects(runtime.drain(10), /CLIENT_DRAIN_TIMEOUT/u);
  child.emit("exit", 1, null);
  assert.deepEqual(exits, [{ exitCode: 1, expected: false }]);
});
