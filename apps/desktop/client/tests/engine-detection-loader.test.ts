import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createEngineCliDetectionLoader,
  runCli,
  terminateCliProcessTree,
} from "../src/app/handlers/engineHandlers.ts";

test("forceRefresh bypasses cached engine CLI detection and refreshes the cache", async () => {
  let calls = 0;
  let now = 1_000;
  const loader = createEngineCliDetectionLoader(async () => ({ value: ++calls }), {
    ttlMs: 20_000,
    now: () => now,
  });

  assert.deepEqual(await loader(), { value: 1 });
  assert.deepEqual(await loader(), { value: 1 });
  assert.equal(calls, 1);

  assert.deepEqual(await loader({ forceRefresh: true }), { value: 2 });
  assert.deepEqual(await loader(), { value: 2 });
  assert.equal(calls, 2);

  now += 20_001;
  assert.deepEqual(await loader(), { value: 3 });
  assert.equal(calls, 3);
});

test("forceRefresh 与普通请求共享同一个在途 CLI 探测", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const loader = createEngineCliDetectionLoader(async () => {
    calls += 1;
    await gate;
    return { value: calls };
  }, { ttlMs: 20_000 });

  const first = loader();
  const refreshed = loader({ forceRefresh: true });
  assert.equal(calls, 0);
  release();
  assert.equal(await first, await refreshed);
  assert.equal(calls, 1);
});

test("非 Windows CLI 探测进程使用独立进程组", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.pid = 1240;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let spawnOptions: Record<string, unknown> | undefined;
  const resultPromise = runCli({
    command: "claude",
    args: ["--version"],
    timeoutMs: 100,
    platform: "darwin",
    spawnProcess: ((_command, _args, options) => {
      spawnOptions = options as Record<string, unknown>;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child as any;
    }) as any,
  });

  assert.equal((await resultPromise).ok, true);
  assert.equal(spawnOptions?.detached, true);
});

test("Windows CLI 探测目标已退出时不再启动 taskkill", async () => {
  const child = { pid: 1234, exitCode: 0, signalCode: null, kill: () => false };
  let spawnCalls = 0;
  const result = await terminateCliProcessTree(child as any, {
    platform: "win32",
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error("taskkill must not start");
    }) as any,
  });
  assert.equal(result, null);
  assert.equal(spawnCalls, 0);
});

test("taskkill 非零退出但 CLI 根进程已退出时按成功处理", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.pid = 1235;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  const taskkill = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  taskkill.stdout = new EventEmitter();
  taskkill.stderr = new EventEmitter();
  const resultPromise = terminateCliProcessTree(child as any, {
    platform: "win32",
    spawnProcess: (() => taskkill) as any,
    timeoutMs: 100,
  });
  queueMicrotask(() => {
    taskkill.emit("close", 128);
    setTimeout(() => child.emit("exit", 0, null), 10);
  });
  assert.equal(await resultPromise, null);
});

test("Windows taskkill 超时显式失败且不会无限等待辅助进程", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.pid = 1236;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => false;
  const taskkill = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  taskkill.stdout = new EventEmitter();
  taskkill.stderr = new EventEmitter();
  let killCalls = 0;
  taskkill.kill = () => {
    killCalls += 1;
    return false;
  };
  const startedAt = Date.now();
  const result = await terminateCliProcessTree(child as any, {
    platform: "win32",
    spawnProcess: (() => taskkill) as any,
    timeoutMs: 100,
  });
  assert.match(result ?? "", /taskkill timed out after 100ms/);
  assert.match(result ?? "", /taskkill stop returned false/);
  assert.equal(killCalls, 1);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("Windows taskkill 超时后辅助进程未退出会明确标记生命周期未确认", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = 1238;
  child.exitCode = null;
  child.signalCode = null;
  const taskkill = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  taskkill.stdout = new EventEmitter();
  taskkill.stderr = new EventEmitter();
  taskkill.kill = () => true;

  const result = await terminateCliProcessTree(child as any, {
    platform: "win32",
    spawnProcess: (() => taskkill) as any,
    timeoutMs: 100,
  });

  assert.match(result ?? "", /taskkill timed out after 100ms/);
  assert.match(result ?? "", /taskkillHelperLifecycle=unconfirmed/);
});

test("Windows taskkill 超时后辅助进程和根进程在宽限期内退出按成功处理", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = 1239;
  child.exitCode = null;
  child.signalCode = null;
  const taskkill = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => boolean;
  };
  taskkill.stdout = new EventEmitter();
  taskkill.stderr = new EventEmitter();
  taskkill.kill = () => {
    queueMicrotask(() => taskkill.emit("close", null));
    queueMicrotask(() => {
      child.exitCode = 1;
      child.emit("exit", 1, null);
    });
    return true;
  };

  const result = await terminateCliProcessTree(child as any, {
    platform: "win32",
    spawnProcess: (() => taskkill) as any,
    timeoutMs: 100,
  });

  assert.equal(result, null);
});

test("非 Windows CLI 终止按负 PID 回收独立进程组并等待目标进程退出", async () => {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.pid = 1237;
  child.exitCode = null;
  child.signalCode = null;
  let killPid: number | null = null;
  let killSignal: NodeJS.Signals | number | undefined;
  const killProcess = (pid: number, signal?: NodeJS.Signals | number): boolean => {
    killPid = pid;
    killSignal = signal;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  assert.equal(await terminateCliProcessTree(child as any, {
    platform: "darwin",
    killProcess,
    timeoutMs: 100,
  }), null);
  assert.equal(killPid, -1237);
  assert.equal(killSignal, "SIGKILL");
});

for (const failure of ["nonzero", "error", "timeout"] as const) test(`严格树确认拒绝${failure}，即使根进程已经关闭`, async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1241, exitCode: null as number | null, signalCode: null });
  const helper = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => { queueMicrotask(() => helper.emit("close", null)); return true; },
  });
  const result = terminateCliProcessTree(child as any, {
    platform: "win32", strictTreeConfirmation: true, timeoutMs: 100,
    spawnProcess: (() => {
      queueMicrotask(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
        if (failure === "nonzero") helper.emit("close", 128);
        if (failure === "error") helper.emit("error", new Error("spawn denied"));
      });
      return helper;
    }) as any,
  });
  assert.notEqual(await result, null);
});

test("严格树确认必须等目标 close，不能仅凭 taskkill 成功或 exit 放行", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1242, exitCode: null as number | null, signalCode: null });
  const helper = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const result = terminateCliProcessTree(child as any, {
    platform: "win32", strictTreeConfirmation: true, timeoutMs: 100,
    spawnProcess: (() => helper) as any,
  });
  let done = false;
  void result.then(() => { done = true; });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  helper.emit("close", 0);
  await new Promise(setImmediate);
  assert.equal(done, false);
  child.emit("close", 1, null);
  assert.equal(await result, null);
});

test("严格树确认拒绝仅有已退出根 PID 的未知子树", async () => {
  let spawned = false;
  const result = await terminateCliProcessTree({ pid: 1243, exitCode: 0, signalCode: null } as any, {
    platform: "win32", strictTreeConfirmation: true,
    spawnProcess: (() => { spawned = true; throw new Error("must not kill recycled PID"); }) as any,
  });
  assert.notEqual(result, null);
  assert.equal(spawned, false);
});

for (const failure of ["false", "throw"] as const) test(`非 Windows 严格树确认在 kill ${failure} 后不得按根退出放行`, async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1244, exitCode: null as number | null, signalCode: null });
  let target: number | undefined;
  const result = await terminateCliProcessTree(child as any, {
    platform: "darwin", strictTreeConfirmation: true, timeoutMs: 100,
    killProcess: pid => {
      target = pid;
      child.exitCode = 1;
      child.emit("close", 1, null);
      if (failure === "throw") throw new Error("kill denied");
      return false;
    },
  });
  assert.equal(target, -1244);
  assert.notEqual(result, null);
});

test("非 Windows 严格树确认在进程组已停止后仍等待真实 close", async () => {
  const child = Object.assign(new EventEmitter(), { pid: 1245, exitCode: null as number | null, signalCode: null });
  const result = terminateCliProcessTree(child as any, {
    platform: "darwin", strictTreeConfirmation: true, timeoutMs: 100, killProcess: () => true,
  });
  let done = false;
  void result.then(() => { done = true; });
  child.exitCode = 1;
  child.emit("exit", 1, null);
  await new Promise(setImmediate);
  assert.equal(done, false);
  child.emit("close", 1, null);
  assert.equal(await result, null);
});

for (const failure of ["spawn", "async-error", "kill", "helper-kill"] as const) test(`严格停止${failure}通过回调保留同一原异常且返回脱敏失败`, async () => {
  const cause = Object.assign(new Error("termination-secret-sentinel"), { code: "EACCES" });
  const failures: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 1246, exitCode: null, signalCode: null });
  const helper = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { throw cause; },
  });
  const result = await terminateCliProcessTree(child as any, {
    platform: failure === "kill" ? "darwin" : "win32", strictTreeConfirmation: true, timeoutMs: 100,
    onFailure: error => { failures.push(error); },
    killProcess: () => { throw cause; },
    spawnProcess: (() => {
      if (failure === "spawn") throw cause;
      if (failure === "async-error") queueMicrotask(() => helper.emit("error", cause));
      return helper;
    }) as any,
  });
  assert.notEqual(result, null);
  assert.doesNotMatch(result!, /termination-secret-sentinel/);
  assert.ok(failures.some(error => Object.is(error, cause)));
});
