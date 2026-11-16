import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ClaudeThreadSession } from "../src/engines/claude/claudeThreadSession.js";
import type { SendMessageInput } from "../src/engines/threadSession.js";
import { logger } from "../src/logger.js";

/** 只注入提示写入/删除故障，真实发送入口和工具桥继续运行。 */
async function fixture(t: TestContext, primary: unknown, cleanupError?: unknown) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-prompt-prepare-"));
  const open = fsp.open, unlink = fsp.unlink, createServer = http.createServer;
  const servers: http.Server[] = [];
  const logs: Record<string, unknown>[] = [];
  let providerEffects = 0, cleanupAttempts = 0;
  t.after(async () => {
    t.mock.restoreAll();
    for (const server of servers) {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await session.dispose();
    await fsp.rmdir(root);
  });
  t.mock.method(os, "tmpdir", () => root);
  t.mock.method(http, "createServer", (...args: Parameters<typeof http.createServer>) => {
    const server = createServer(...args);
    servers.push(server);
    return server;
  });
  t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args);
    if (path.basename(String(args[0])) === "append-system-prompt.txt") {
      const writeFile = handle.writeFile.bind(handle);
      t.mock.method(handle, "writeFile", async () => { await writeFile("partial-private-prompt", "utf8"); throw primary; });
    }
    return handle;
  });
  t.mock.method(fsp, "unlink", async (...args: Parameters<typeof fsp.unlink>) => {
    if (path.basename(String(args[0])) === "append-system-prompt.txt") {
      cleanupAttempts += 1;
      if (cleanupError !== undefined) throw cleanupError;
    }
    return unlink(...args);
  });
  t.mock.method(logger, "error", (_tag: string, _message: string, data?: unknown) => {
    logs.push(data as Record<string, unknown>);
  });
  const session = new ClaudeThreadSession({
    writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath: root, workspaceId: "ws_prompt_prepare", threadId: "th_prompt_prepare", initialSessionId: null,
    onSessionId: () => { providerEffects += 1; },
    onEngineProcessSnapshot: () => { providerEffects += 1; return false; },
  });
  const input: SendMessageInput = {
    turnId: "turn_prompt_prepare", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "private-user-text", images: [], systemMessage: "private-system-prompt",
    toolRegistry: { tools: [{ toolsetId: "tools", toolsetName: "Tools", toolId: "test", name: "Test",
      description: "test", runtime: "node", code: "", permissions: { requiresWrite: false } }] },
    executeHostTool: async () => { providerEffects += 1; throw new Error("must not execute provider tools"); },
  };
  return {
    root, logs, servers, session,
    send: () => session.sendMessage(input, {
      conversation: () => { providerEffects += 1; }, raw: () => { providerEffects += 1; },
    }),
    effects: () => ({ providerEffects, cleanupAttempts }),
  };
}

/** 用模型门禁停止真实发送，在已准备文件上注入释放边界故障。 */
async function releaseFixture(t: TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cf-claude-prompt-identity-"));
  t.mock.method(os, "tmpdir", () => root);
  const session = new ClaudeThreadSession({ writeWorkspaceLog: testEngineWorkspaceLog,  workspacePath: root, workspaceId: "ws_identity", threadId: "th_identity", initialSessionId: null,
    onEngineProcessSnapshot: () => { throw new Error("must not spawn"); }, onSessionId() {},
  });
  t.after(async () => {
    t.mock.restoreAll();
    await session.dispose();
    await fsp.rmdir(root);
  });
  const send = () => session.sendMessage({ turnId: "turn_identity", userItemId: "user", assistantItemId: "assistant", reasoningItemId: "reasoning",
    text: "test", images: [], model: "unavailable-model", systemMessage: "private-identity-prompt",
  }, { conversation() {}, raw() {} });
  return { root, session, send };
}

test("prompt rmdir retry completes only the remaining owned step and preserves sibling files", async t => {
  const f = await releaseFixture(t);
  const rmdir = fsp.rmdir;
  let retained = "", attempts = 0, unlinkCount = 0;
  const unlink = fsp.unlink;
  const deleting = t.mock.method(fsp, "unlink", async (...args: Parameters<typeof fsp.unlink>) => { unlinkCount++; return unlink(...args); });
  const removal = t.mock.method(fsp, "rmdir", async (...args: Parameters<typeof fsp.rmdir>) => {
    retained = String(args[0]); attempts++;
    throw Object.assign(new Error("rmdir-private-cause"), { code: "EPERM" });
  });
  const failure = await rejection(f.send());
  assert.ok(failure instanceof AggregateError);
  assert.equal(unlinkCount, 1);
  assert.deepEqual(await fsp.readdir(retained), []);
  assert.equal(f.session.canIdleDispose(), false);
  const sibling = path.join(f.root, "foreign-sibling.txt");
  await fsp.writeFile(sibling, "foreign");
  removal.mock.restore();
  await f.session.dispose();
  assert.equal(unlinkCount, 1);
  assert.equal(attempts, 1);
  assert.equal(await fsp.readFile(sibling, "utf8"), "foreign");
  assert.equal(f.session.canIdleDispose(), true);
  deleting.mock.restore();
  await fsp.unlink(sibling);
  assert.deepEqual(await fsp.readdir(f.root), []);
});

test("unexpected foreign file prevents directory removal and survives prompt release", async t => {
  const f = await releaseFixture(t);
  const unlink = fsp.unlink;
  let foreign = "";
  const mock = t.mock.method(fsp, "unlink", async (...args: Parameters<typeof fsp.unlink>) => {
    foreign = path.join(path.dirname(String(args[0])), "foreign.txt");
    await fsp.writeFile(foreign, "foreign");
    return unlink(...args);
  });
  const failure = await rejection(f.send());
  assert.ok(failure instanceof AggregateError);
  assert.equal((failure.errors[1] as NodeJS.ErrnoException).code, "ENOTEMPTY");
  assert.equal(await fsp.readFile(foreign, "utf8"), "foreign");
  assert.equal(f.session.canIdleDispose(), false);
  mock.mock.restore();
  await fsp.unlink(foreign);
  await f.session.dispose();
  assert.deepEqual(await fsp.readdir(f.root), []);
});

for (const kind of ["replacement", "hardlink", "wx-collision"] as const) {
  test(`prompt release rejects ${kind} and leaves foreign bytes untouched`, async t => {
    const f = await releaseFixture(t);
    const open = fsp.open, mkdtemp = fsp.mkdtemp;
    let prompt = "", saved = "", foreign = "";
    if (kind === "wx-collision") {
      t.mock.method(fsp, "mkdtemp", async (...args: Parameters<typeof fsp.mkdtemp>) => {
        const value = await mkdtemp(...args);
        prompt = path.join(String(value), "append-system-prompt.txt");
        await fsp.writeFile(prompt, "foreign");
        return value;
      });
    } else {
      t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
        const handle = await open(...args);
        prompt = String(args[0]);
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          if (kind === "replacement") {
            saved = path.join(f.root, "owned-saved.txt");
            await fsp.rename(prompt, saved);
            await fsp.writeFile(prompt, "foreign");
          } else {
            foreign = path.join(f.root, "foreign-hardlink.txt");
            await fsp.link(prompt, foreign);
          }
        });
        return handle;
      });
    }
    const failure = await rejection(f.send());
    assert.ok(failure instanceof AggregateError);
    assert.equal(f.session.canIdleDispose(), false);
    assert.equal(await fsp.readFile(prompt, "utf8"), kind === "hardlink" ? "private-identity-prompt" : "foreign");
    t.mock.restoreAll();
    if (kind === "replacement") {
      await fsp.unlink(prompt);
      await fsp.rename(saved, prompt);
    } else if (kind === "hardlink") {
      await fsp.unlink(foreign);
    } else {
      await fsp.unlink(prompt);
    }
    await f.session.dispose();
    assert.deepEqual(await fsp.readdir(f.root), []);
  });
}

test("prompt release rejects symlink identity reported at the lstat boundary", async t => {
  const f = await releaseFixture(t);
  const lstat = fsp.lstat;
  let prompt = "";
  const mock = t.mock.method(fsp, "lstat", async (...args: Parameters<typeof fsp.lstat>) => {
    const stat = await lstat(...args);
    if (path.basename(String(args[0])) === "append-system-prompt.txt") {
      prompt = String(args[0]);
      // 本机创建文件 symlink 返回 EPERM；只替换明确的元数据边界，保留真实正文验证拒删。
      stat.isSymbolicLink = () => true;
    }
    return stat;
  });
  const failure = await rejection(f.send());
  assert.ok(failure instanceof AggregateError);
  assert.equal((failure.errors[1] as { code: string }).code, "CLAUDE_PROMPT_IDENTITY_CHANGED");
  assert.equal(await fsp.readFile(prompt, "utf8"), "private-identity-prompt");
  assert.equal(f.session.canIdleDispose(), false);
  mock.mock.restore();
  await f.session.dispose();
  assert.deepEqual(await fsp.readdir(f.root), []);
});

for (const target of ["directory", "missing-file"] as const) {
  test(`prompt release retains an unexpected ${target} identity until the owner is restored`, async t => {
    const f = await releaseFixture(t);
    const open = fsp.open;
    let original = "", saved = "";
    t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        await close();
        original = target === "directory" ? path.dirname(String(args[0])) : String(args[0]);
        saved = path.join(f.root, "saved-owner");
        await fsp.rename(original, saved);
        if (target === "directory") {
          await fsp.mkdir(original);
          await fsp.writeFile(path.join(original, "foreign.txt"), "foreign");
        }
      });
      return handle;
    });
    const failure = await rejection(f.send());
    assert.ok(failure instanceof AggregateError);
    assert.equal(f.session.canIdleDispose(), false);
    t.mock.restoreAll();
    if (target === "directory") {
      assert.equal(await fsp.readFile(path.join(original, "foreign.txt"), "utf8"), "foreign");
      await fsp.unlink(path.join(original, "foreign.txt"));
      await fsp.rmdir(original);
    }
    await fsp.rename(saved, original);
    await f.session.dispose();
    assert.deepEqual(await fsp.readdir(f.root), []);
  });
}

test("unconfirmed fd close prevents unlink until explicit disposal confirms the handle", async t => {
  const f = await releaseFixture(t);
  const open = fsp.open, unlink = fsp.unlink;
  const closeCause = Object.freeze(new Error("close-private-cause"));
  let closeMock: { mock: { restore(): void } } | undefined;
  let unlinks = 0;
  t.mock.method(fsp, "open", async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args);
    closeMock = t.mock.method(handle, "close", async () => { throw closeCause; });
    return handle;
  });
  t.mock.method(fsp, "unlink", async (...args: Parameters<typeof fsp.unlink>) => { unlinks++; return unlink(...args); });
  const failure = await rejection(f.send());
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [closeCause, closeCause]);
  assert.equal(unlinks, 0);
  assert.equal(f.session.canIdleDispose(), false);
  closeMock!.mock.restore();
  await f.session.dispose();
  assert.equal(unlinks, 1);
  assert.deepEqual(await fsp.readdir(f.root), []);
});

/** 返回真实拒绝对象，禁止把未拒绝的发送当作预期失败。 */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try { await operation; }
  catch (error) { return error; }
  assert.fail("prompt preparation must reject");
}

test("prompt write failure cleans its partial file and closes the real bridge before returning the original error", async t => {
  const primary = Object.freeze(Object.assign(new Error("private-write-cause"), { code: "ENOSPC" }));
  const f = await fixture(t, primary);
  assert.equal(await rejection(f.send()), primary);
  assert.deepEqual(await fsp.readdir(f.root), []);
  assert.equal(f.servers.length, 1);
  assert.equal(f.servers[0]!.listening, false);
  assert.deepEqual(f.effects(), { providerEffects: 0, cleanupAttempts: 1 });
});

for (const [kind, primary] of [
  ["Error", Object.assign(new Error("private-write-cause"), { code: "ENOSPC" })],
  ["frozen Error", Object.freeze(Object.assign(new Error("private-frozen-cause"), { code: "ENOSPC" }))],
  ["non-Error", "private-non-error-cause"],
] as const) {
  test(`prompt write and cleanup failure preserve both original causes for ${kind}`, async t => {
    const cleanupError = Object.assign(new Error("private-delete-cause"), { code: "EPERM" });
    const f = await fixture(t, primary, cleanupError);
    const failure = await rejection(f.send());
    assert.ok(failure instanceof AggregateError);
    assert.deepEqual(failure.errors, [primary, cleanupError]);
    assert.equal(failure.errors[0], primary);
    assert.equal(failure.errors[1], cleanupError);
    assert.equal(failure.cause, primary);
    assert.equal((failure as AggregateError & { code: string }).code, "CLAUDE_PROMPT_PREPARATION_CLEANUP_FAILED");
    const retained = await fsp.readdir(f.root);
    assert.equal(retained.length, 1);
    assert.equal(await fsp.readFile(path.join(f.root, retained[0]!, "append-system-prompt.txt"), "utf8"), "partial-private-prompt");
    assert.equal(f.servers.length, 1);
    assert.equal(f.servers[0]!.listening, false);
    assert.deepEqual(f.effects(), { providerEffects: 0, cleanupAttempts: 1 });
    if (primary instanceof Error) assert.equal(Object.hasOwn(primary, "cleanupError"), false);
  });
}

test("prompt cleanup failure records correlated context without private prompts or error messages", async t => {
  const primary = Object.assign(new Error("private-write-cause"), { code: "ENOSPC", syscall: "write" });
  const cleanupError = Object.assign(new Error("private-delete-cause"), { code: "EPERM", syscall: "unlink" });
  const f = await fixture(t, primary, cleanupError);
  const failure = await rejection(f.send()) as Error & { requestId: string };
  assert.equal(f.logs.length, 1);
  const log = f.logs[0]!;
  assert.equal(log.code, "CLAUDE_PROMPT_PREPARATION_CLEANUP_FAILED");
  assert.equal(log.requestId, failure.requestId);
  assert.match(failure.requestId, /^claude-prompt:/);
  assert.equal(log.workspaceId, "ws_prompt_prepare");
  assert.equal(log.threadId, "th_prompt_prepare");
  assert.equal(log.turnId, "turn_prompt_prepare");
  assert.equal(log.providerStarted, false);
  assert.deepEqual(log.event, { category: "engine", action: "prompt_prepare_cleanup", outcome: "fail" });
  assert.equal((log.rootCause as Record<string, unknown>).code, "ENOSPC");
  assert.equal((log.cleanupCause as Record<string, unknown>).code, "EPERM");
  assert.equal(path.dirname(String(log.retainedDirectory)), f.root);
  assert.equal(await fsp.readFile(path.join(String(log.retainedDirectory), "append-system-prompt.txt"), "utf8"), "partial-private-prompt");
  assert.doesNotMatch(JSON.stringify(log), /private-|partial-private/);
  assert.doesNotMatch(failure.message, /private-|partial-private/);
});

test("prompt cleanup logging failure preserves preparation, cleanup and logging errors without retry", async t => {
  const primary = Object.freeze(new Error("private-write-cause"));
  const cleanupError = new Error("private-delete-cause"), loggingError = new Error("private-log-cause");
  const f = await fixture(t, primary, cleanupError);
  t.mock.method(logger, "error", () => { throw loggingError; });
  const failure = await rejection(f.send());
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors[1], loggingError);
  const preparationFailure = failure.errors[0];
  assert.ok(preparationFailure instanceof AggregateError);
  assert.deepEqual(preparationFailure.errors, [primary, cleanupError]);
  assert.equal(preparationFailure.errors[0], primary);
  assert.equal(preparationFailure.errors[1], cleanupError);
  assert.equal(failure.cause, preparationFailure);
  assert.equal(preparationFailure.cause, primary);
  assert.equal((failure as AggregateError & { requestId: string }).requestId, (preparationFailure as AggregateError & { requestId: string }).requestId);
  assert.equal(f.servers[0]!.listening, false);
  assert.deepEqual(f.effects(), { providerEffects: 0, cleanupAttempts: 1 });
});
