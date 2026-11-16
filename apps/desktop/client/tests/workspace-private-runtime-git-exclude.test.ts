import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureWorkspacePrivateRuntimeGitExclude, WorkspacePrivateRuntimeGitError } from "../src/git/workspacePrivateRuntimeGitExclude.js";

/** 所有 Git 写仅落入独占 Temp，不对真实用户仓库建立提交或更改 index。 */
function fixture(t: test.TestContext, git = true): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "runtime-git-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (git) command(root, ["init", "--quiet"]);
  return root;
}

/** 使用真实 Git 和完整参数数组验证索引可观察效果。 */
function command(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, windowsHide: true, timeout: 15_000 });
}

/** 从公开入口精确注入自有 exclude fd 故障；关闭先真实执行，再抛指定副错。 */
function excludeFault(t: test.TestContext, fault: { stage?: "open" | "write" | "verify"; primary?: unknown; failClose?: boolean; secondary?: unknown; unsafeVerify?: boolean; missing?: boolean; notify?: (error: unknown) => void }) {
  const root = fixture(t), exclude = path.join(root, ".git", "info", "exclude");
  if (fault.missing) fs.unlinkSync(exclude);
  const original = fault.missing ? Buffer.alloc(0) : fs.readFileSync(exclude);
  const open = fs.openSync, write = fs.writeFileSync, stat = fs.fstatSync, close = fs.closeSync, spawn = childProcess.spawnSync;
  let fd: number | undefined, owned = false, fdChecks = 0, closeCalls = 0, failed = false, failure: unknown;
  const events: string[] = [], gitCalls: string[][] = [];
  const mocks = [
    t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) !== exclude || args[1] !== (fault.missing ? "ax+" : "a+")) return open(...args);
      events.push("open");
      if (fault.stage === "open") throw fault.primary;
      fd = open(...args);
      owned = true;
      return fd;
    }),
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (fd !== undefined && args[0] === fd) {
        events.push("write");
        if (fault.stage === "write") throw fault.primary;
      }
      return write(...args);
    }),
    t.mock.method(fs, "fstatSync", ((...args: Parameters<typeof fs.fstatSync>) => {
      const result = stat(...args);
      if (fd !== undefined && args[0] === fd && ++fdChecks === 2) {
        events.push("verify");
        if (fault.stage === "verify") {
          if (fault.unsafeVerify) return Object.assign(Object.create(result), { nlink: 2 });
          throw fault.primary;
        }
      }
      return result;
    }) as typeof fs.fstatSync),
    t.mock.method(fs, "closeSync", (...args: Parameters<typeof fs.closeSync>) => {
      if (fd === undefined || args[0] !== fd) return close(...args);
      closeCalls += 1;
      events.push("close");
      owned = false;
      close(...args);
      if (fault.failClose) throw fault.secondary;
    }),
    t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof childProcess.spawnSync>) => {
      if (args[0] === "git" && Array.isArray(args[1]) && args[2]?.cwd === root) gitCalls.push([...args[1]]);
      return spawn(...args);
    }) as typeof childProcess.spawnSync),
  ];
  try {
    syncBuiltinESMExports();
    ensureWorkspacePrivateRuntimeGitExclude(root, ["client-20261029.1.log"], fault.notify);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const mock of mocks.reverse()) {
      try { mock.mock.restore(); } catch (error) { cleanupFailures.push(error); }
    }
    try { syncBuiltinESMExports(); } catch (error) { cleanupFailures.push(error); }
    if (owned && fd !== undefined) {
      owned = false;
      try { close(fd); } catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length) throw new AggregateError(failed ? [failure, ...cleanupFailures] : cleanupFailures, "exclude 故障夹具收尾失败", failed ? { cause: failure } : undefined);
  }
  assert.equal(owned, false);
  assert.equal(fs.openSync, open);
  assert.equal(fs.writeFileSync, write);
  assert.equal(fs.fstatSync, stat);
  assert.equal(fs.closeSync, close);
  assert.equal(childProcess.spawnSync, spawn);
  return { root, exclude, original, updated: fs.readFileSync(exclude), events, gitCalls, closeCalls, opened: fd !== undefined, failed, failure };
}

for (const stage of [undefined, "write"] as const) {
  test(`日志调用的 Git close 未确认只通知一次并保原主副因：${stage ?? "close"}`, t => {
    const primary = false, secondary = undefined, notification = new Error("notify failed"), observed: unknown[] = [];
    const result = excludeFault(t, { stage, primary, failClose: true, secondary, notify(error) { observed.push(error); throw notification; } });
    const error = excludeFailure(result);
    assert.equal(observed.length, 1);
    assert.ok(error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, stage ? [primary, secondary, notification] : [secondary, notification]);
    assert.equal(error.cause.cause, stage ? primary : secondary);
    if (stage) { assert.ok(observed[0] instanceof AggregateError); assert.deepEqual(observed[0].errors, [primary, secondary]); }
    else assert.equal(observed[0], secondary);
  });
}

test("Git 正常关闭和开写失败均不误报 close 未确认", t => {
  let notifications = 0;
  const notify = () => { notifications++; };
  const healthy = excludeFault(t, { notify }); assert.equal(healthy.failed, false);
  const primary = new Error("write-only");
  const failed = excludeFault(t, { stage: "write", primary, notify });
  assert.equal(excludeFailure(failed).cause, primary); assert.equal(notifications, 0);
});

/** 失败必须保留领域上下文并阻止后续 check-ignore。 */
function excludeFailure(result: ReturnType<typeof excludeFault>): WorkspacePrivateRuntimeGitError {
  assert.equal(result.failed, true);
  assert.ok(result.failure instanceof WorkspacePrivateRuntimeGitError);
  assert.equal(result.failure.code, "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED");
  assert.equal(result.failure.phase, "exclude");
  assert.deepEqual(result.failure.context, { workspaceRoot: result.root, repositoryRoot: result.root, excludePath: result.exclude });
  assert.equal(result.gitCalls.filter(args => args[0] === "check-ignore").length, 0);
  assert.equal(result.closeCalls, result.opened ? 1 : 0);
  return result.failure;
}

for (const missing of [false, true]) {
  test(`写入和关闭双错按原对象顺序保留：${missing ? "ax+" : "a+"}`, t => {
    const primary = Object.freeze(new Error("write failed")), secondary = Object.freeze(new Error("close failed"));
    const result = excludeFault(t, { stage: "write", primary, failClose: true, secondary, missing });
    const error = excludeFailure(result);
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.cause, primary);
    assert.equal(error.cause.errors[0], primary);
    assert.equal(error.cause.errors[1], secondary);
    assert.equal(error.cause.errors.length, 2);
    assert.deepEqual(result.events, ["open", "write", "close"]);
    assert.deepEqual(result.updated, result.original);
  });
}

for (const stage of ["write", "verify", "close"] as const) {
  test(`原生 ${stage} 单错由领域错误保留原 cause`, t => {
    const primary = Object.freeze(new Error(`${stage} failed`));
    const result = excludeFault(t, { stage: stage === "close" ? undefined : stage, primary, failClose: stage === "close", secondary: primary });
    assert.equal(excludeFailure(result).cause, primary);
    assert.deepEqual(result.events, stage === "write" ? ["open", "write", "close"] : ["open", "write", "verify", "close"]);
  });
}

for (const value of [undefined, null, false, 0, "", NaN, 0n]) {
  for (const kind of ["write", "close", "both"] as const) {
    test(`NonError ${typeof value}:${String(value)} 在 ${kind} 失败时保留原值与 cause presence`, t => {
      const result = excludeFault(t, { stage: kind === "close" ? undefined : "write", primary: value, failClose: kind !== "write", secondary: value });
      const error = excludeFailure(result);
      assert.equal(Object.hasOwn(error, "cause"), true);
      if (kind === "both") {
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(Object.hasOwn(error.cause, "cause"), true);
        assert.ok(Object.is(error.cause.cause, value));
        assert.equal(error.cause.errors.length, 2);
        assert.ok(error.cause.errors.every(cause => Object.is(cause, value)));
      } else assert.ok(Object.is(error.cause, value));
      assert.deepEqual(result.events, kind === "close" ? ["open", "write", "verify", "close"] : ["open", "write", "close"]);
      if (kind === "close") assert.equal(result.updated.toString("utf8").endsWith("/.codeflowai/\n"), true);
      else assert.deepEqual(result.updated, result.original);
    });
  }
}

for (const failClose of [false, true]) {
  test(`写后身份校验领域错误保留且已写字节不回滚：close=${failClose}`, t => {
    const secondary = Object.freeze(new Error("verify close failed"));
    const result = excludeFault(t, { stage: "verify", unsafeVerify: true, failClose, secondary });
    const error = excludeFailure(result);
    const primary = failClose ? (assert.ok(error.cause instanceof AggregateError), error.cause.errors[0]) : error;
    assert.ok(primary instanceof WorkspacePrivateRuntimeGitError);
    assert.equal(primary.phase, "exclude");
    assert.match(primary.message, /不是普通独占文件/);
    assert.equal(Object.hasOwn(primary, "cause"), false);
    if (failClose) {
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.cause, primary);
      assert.equal(error.cause.errors[1], secondary);
      assert.equal(error.cause.errors.length, 2);
    }
    assert.deepEqual(result.events, ["open", "write", "verify", "close"]);
    assert.equal(result.updated.toString("utf8").endsWith("/.codeflowai/\n"), true);
  });

  test(`已有领域错误以原对象保留：close=${failClose}`, t => {
    const primary = Object.freeze(new WorkspacePrivateRuntimeGitError("WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED", "exclude", { workspaceRoot: "fault-context" }, "identity failed"));
    const secondary = Object.freeze(new Error("close failed"));
    const result = excludeFault(t, { stage: "verify", primary, failClose, secondary });
    assert.equal(result.failed, true);
    assert.equal(result.closeCalls, 1);
    assert.equal(result.gitCalls.filter(args => args[0] === "check-ignore").length, 0);
    if (!failClose) assert.equal(result.failure, primary);
    else {
      const error = excludeFailure(result);
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.cause, primary);
      assert.equal(error.cause.errors[0], primary);
      assert.equal(error.cause.errors[1], secondary);
    }
  });
}

test("打开失败不关闭 fd 且保留原生根因", t => {
  const primary = Object.freeze(new Error("open failed"));
  const result = excludeFault(t, { stage: "open", primary });
  assert.equal(excludeFailure(result).cause, primary);
  assert.deepEqual(result.events, ["open"]);
  assert.equal(result.closeCalls, 0);
  assert.deepEqual(result.updated, result.original);
});

test("正常追加关闭一次并继续真实 check-ignore", t => {
  const result = excludeFault(t, {});
  assert.equal(result.failed, false);
  assert.equal(result.closeCalls, 1);
  assert.deepEqual(result.events, ["open", "write", "verify", "close"]);
  assert.equal(result.gitCalls.filter(args => args[0] === "check-ignore").length, 1);
  command(result.root, ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"]);
});

test("根仓库最小追加规则且保留原字节与换行，重复访问幂等", t => {
  const root = fixture(t);
  const exclude = path.join(root, ".git", "info", "exclude");
  const original = Buffer.from("# 原规则\r\nkeep\r\nlast");
  fs.writeFileSync(exclude, original);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  const updated = fs.readFileSync(exclude);
  assert.deepEqual(updated.subarray(0, original.length), original);
  assert.equal(updated.subarray(original.length).toString(), "\r\n/.codeflowai/\r\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.deepEqual(fs.readFileSync(exclude), updated);
  command(root, ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"]);
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
  assert.equal(fs.existsSync(path.join(root, ".codeflowai")), false);
});

test("普通根仓库保护输入未变时不重复启动 Git，index 改变后仍拒绝已跟踪数据", t => {
  const root = fixture(t);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  const original = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof original>) => { calls++; return original(...args); });
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(calls, 0);
  fs.mkdirSync(path.join(root, ".codeflowai"));
  fs.writeFileSync(path.join(root, ".codeflowai", "private.txt"), "private");
  command(root, ["add", "-f", ".codeflowai/private.txt"]);
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.ok(calls > 0);
});

test("显式全局配置路径复用保护证明，配置及路径变化后重新验证", t => {
  const root = fixture(t), configs = fixture(t, false);
  const first = path.join(configs, "global-first"), second = path.join(configs, "global-second");
  fs.writeFileSync(first, "[core]\n  autocrlf = false\n", "utf8");
  fs.writeFileSync(second, "[core]\n  autocrlf = false\n", "utf8");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = first;
  t.after(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  const spawn = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => { calls++; return spawn(...args); }) as typeof spawn);
  syncBuiltinESMExports(); t.after(syncBuiltinESMExports);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  calls = 0;
  const startedAt = performance.now();
  for (let index = 0; index < 12; index++) ensureWorkspacePrivateRuntimeGitExclude(root);
  t.diagnostic(`显式全局配置下 12 次热校验：${calls} 次 Git，${Math.round(performance.now() - startedAt)}ms`);
  assert.equal(calls, 0);
  fs.writeFileSync(first, "[core]\n  autocrlf = false\n  filemode = false\n", "utf8");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.ok(calls > 0, "原配置变化必须失效");
  calls = 0; process.env.GIT_CONFIG_GLOBAL = second;
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.ok(calls > 0, "切换配置路径必须失效");
  calls = 0;
  fs.writeFileSync(second, "[include]\n  path = optional-config\n", "utf8");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.ok(calls >= 6, "include 配置继续逐次完整校验");
  calls = 0; delete process.env.GIT_CONFIG_GLOBAL;
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.ok(calls > 0, "移除配置覆盖必须按默认配置重新核验");
  process.env.GIT_CONFIG_GLOBAL = first;
  ensureWorkspacePrivateRuntimeGitExclude(root); ensureWorkspacePrivateRuntimeGitExclude(root);
  fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "# 外部修改\n", "utf8");
  calls = 0; ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.ok(calls > 0, "显式配置下 exclude 修改仍必须失效");
  fs.mkdirSync(path.join(root, ".codeflowai"));
  fs.writeFileSync(path.join(root, ".codeflowai", "private.txt"), "private", "utf8");
  command(root, ["add", "-f", ".codeflowai/private.txt"]);
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
});

for (const mode of ["relative", "unknown"] as const) test(`全局配置覆盖 ${mode} 不复用未追踪环境`, t => {
  const root = fixture(t), config = path.join(root, "test.gitconfig");
  fs.writeFileSync(config, "[core]\n  autocrlf = false\n", "utf8");
  const overrides = { GIT_CONFIG_GLOBAL: mode === "relative" ? "test.gitconfig" : config,
    ...(mode === "unknown" ? { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.filemode", GIT_CONFIG_VALUE_0: "false" } : {}) };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const spawn = childProcess.spawnSync;
  let verifications = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => {
    if (Array.isArray(args[1]) && args[1][0] === "check-ignore") verifications++;
    return spawn(...args);
  }) as typeof spawn);
  syncBuiltinESMExports(); t.after(syncBuiltinESMExports);
  for (let index = 0; index < 3; index++) ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(verifications, 3);
});

test("以 Git 报告的系统配置路径失效保护证明，不从 PATH 猜测", t => {
  const root = fixture(t), home = fixture(t, false), previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const systemConfig = path.join(home, "system-config"), spawn = childProcess.spawnSync;
  let verifications = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => {
    const result = spawn(...args);
    if (Array.isArray(args[1]) && args[1][0] === "var" && args[1][1] === "GIT_CONFIG_SYSTEM") result.stdout = Buffer.from(`${systemConfig}\n`);
    if (Array.isArray(args[1]) && args[1][0] === "check-ignore") verifications++;
    return result;
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  verifications = 0;
  fs.writeFileSync(systemConfig, "[include]\npath = optional-config\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(verifications, 1);
});

test("HOME 配置新增 include 后不复用原保护证明", t => {
  const root = fixture(t), home = fixture(t, false), previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  ensureWorkspacePrivateRuntimeGitExclude(root);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  const spawn = childProcess.spawnSync;
  let calls = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => { calls++; return spawn(...args); }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  fs.writeFileSync(path.join(home, ".gitconfig"), "[include]\npath = optional-config\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(calls, 3);
});

test("旧 Git 无法确认配置位置时仍逐次完整校验", t => {
  const root = fixture(t), spawn = childProcess.spawnSync;
  let verifications = 0;
  t.mock.method(childProcess, "spawnSync", ((...args: Parameters<typeof spawn>) => {
    const result = spawn(...args);
    if (Array.isArray(args[1]) && args[1][0] === "--version") result.stdout = Buffer.from("git version 2.42.0\n");
    if (Array.isArray(args[1]) && args[1][0] === "var") assert.fail("旧 Git 不读取尚未提供的配置位置变量");
    if (Array.isArray(args[1]) && args[1][0] === "check-ignore") verifications++;
    return result;
  }) as typeof spawn);
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  for (let index = 0; index < 3; index++) ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(verifications, 3);
});

test("已保护仓库新建反向忽略规则后明确失败，修正后可重试", t => {
  const root = fixture(t);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  fs.writeFileSync(path.join(root, ".gitignore"), "!.codeflowai/\n!.codeflowai/**\n");
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "verify");
  fs.writeFileSync(path.join(root, ".gitignore"), "");
  ensureWorkspacePrivateRuntimeGitExclude(root);
});

test("已保护仓库的 exclude 被删除规则时重新修复，Git marker 损坏时显式失败", t => {
  const root = fixture(t);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  const exclude = path.join(root, ".git", "info", "exclude");
  fs.writeFileSync(exclude, "# changed\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.match(fs.readFileSync(exclude, "utf8"), /\/\.codeflowai\//);
  fs.renameSync(path.join(root, ".git"), path.join(root, "old-git"));
  fs.writeFileSync(path.join(root, ".git"), "invalid marker");
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), WorkspacePrivateRuntimeGitError);
});

test("子工作区含中文空格和 glob 字符时精确排除自己的运行目录", t => {
  const root = fixture(t), name = "子目录 [cache] 空格";
  const workspace = path.join(root, name);
  fs.mkdirSync(workspace);
  ensureWorkspacePrivateRuntimeGitExclude(workspace);
  command(root, ["check-ignore", "--no-index", "-q", "--", `${name}/.codeflowai/knowledge-search.sqlite`]);
  assert.equal(fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8").includes("/子目录\\ \\[cache\\]\\ 空格/.codeflowai/"), true);
  assert.throws(() => command(root, ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"]), (error: unknown) => (error as { status: number }).status === 1);
});

test("非 Git 和仅含嵌套仓库的工作区不要求 Git 且不修改嵌套 exclude", t => {
  const root = fixture(t, false), nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  command(nested, ["init", "--quiet"]);
  const exclude = path.join(nested, ".git", "info", "exclude"), original = fs.readFileSync(exclude);
  const previous = process.env.PATH;
  process.env.PATH = path.join(root, "missing-bin");
  try { ensureWorkspacePrivateRuntimeGitExclude(root); } finally { process.env.PATH = previous; }
  assert.deepEqual(fs.readFileSync(exclude), original);
});

test("发现 Git marker 但 Git 不可执行时显式失败", t => {
  const root = fixture(t), previous = process.env.PATH;
  process.env.PATH = path.join(root, "missing-bin");
  try {
    assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "locate" && error.cause instanceof Error);
  } finally { process.env.PATH = previous; }
});

test("损坏 marker 不作为非 Git 降级处理", t => {
  const root = fixture(t, false);
  fs.writeFileSync(path.join(root, ".git"), "gitdir: missing");
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), WorkspacePrivateRuntimeGitError);
});

test("非 Git 后新建仓库仍重新保护，不永久缓存已检查状态", t => {
  const root = fixture(t, false);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  command(root, ["init", "--quiet"]);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  command(root, ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"]);
});

test("marker 权限失败保留根因且不降级", t => {
  const root = fixture(t), lstat = fs.lstatSync;
  const failure = Object.assign(new Error("marker access denied"), { code: "EACCES" });
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === path.join(root, ".git")) throw failure;
    return lstat(...args);
  });
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "marker" && error.cause === failure);
});

test("exclude 写入失败显式上抛且保留原字节", t => {
  const root = fixture(t), exclude = path.join(root, ".git", "info", "exclude"), original = fs.readFileSync(exclude), open = fs.openSync;
  const failure = Object.assign(new Error("exclude write denied"), { code: "EACCES" });
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === exclude && args[1] === "a+") throw failure;
    return open(...args);
  });
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "exclude" && error.cause === failure);
  assert.deepEqual(fs.readFileSync(exclude), original);
});

test("exclude 文件符号链接显式失败（系统调用故障夹具）", t => {
  const root = fixture(t), exclude = path.join(root, ".git", "info", "exclude"), lstat = fs.lstatSync;
  let rawChecks = 0;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    const result = lstat(...args);
    if (String(args[0]) === exclude) {
      rawChecks += 1;
      if (rawChecks === 1) {
        assert.ok(result);
        return Object.assign(Object.create(result), { isSymbolicLink: () => true });
      }
    }
    return result;
  });
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), WorkspacePrivateRuntimeGitError);
});

test("已暂存 .codeflow 时不写 exclude 且不自动取消跟踪", t => {
  const root = fixture(t), exclude = path.join(root, ".git", "info", "exclude");
  fs.mkdirSync(path.join(root, ".codeflowai"));
  fs.writeFileSync(path.join(root, ".codeflowai", "keep"), "tracked");
  command(root, ["add", "--", ".codeflowai/keep"]);
  const before = fs.readFileSync(exclude);
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.deepEqual(fs.readFileSync(exclude), before);
  assert.equal(command(root, ["ls-files", "--cached", "-z", "--", ".codeflowai"]).toString(), ".codeflowai/keep\0");
});

for (const subdirectory of [false, true]) {
  test(`大小写别名已暂存时拒绝且不改 index/exclude：${subdirectory ? "子工作区祖先" : "根工作区"}`, { skip: process.platform !== "win32" && process.platform !== "darwin" }, t => {
    const root = fixture(t), relative = subdirectory ? "PROJECT/.CODEFLOWAI" : ".CODEFLOWAI";
    command(root, ["config", "core.ignorecase", "true"]);
    fs.mkdirSync(path.join(root, relative), { recursive: true });
    fs.writeFileSync(path.join(root, relative, "tracked"), "keep");
    command(root, ["add", "--", `${relative}/tracked`]);
    const exclude = path.join(root, ".git", "info", "exclude"), index = path.join(root, ".git", "index");
    const beforeExclude = fs.readFileSync(exclude), beforeIndex = fs.readFileSync(index);
    const workspace = subdirectory ? path.join(root, "project") : root;
    assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(workspace), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.code === "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
    assert.deepEqual(fs.readFileSync(exclude), beforeExclude);
    assert.deepEqual(fs.readFileSync(index), beforeIndex);
    assert.equal(fs.existsSync(path.join(workspace, ".codeflowai", "knowledge-search.sqlite")), false);
  });
}

test("大小写敏感文件系统保留不同目录的精确语义", { skip: process.platform === "win32" || process.platform === "darwin" }, t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, ".CODEFLOW"));
  fs.writeFileSync(path.join(root, ".CODEFLOW", "tracked"), "keep");
  command(root, ["add", "--", ".CODEFLOW/tracked"]);
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.equal(fs.existsSync(path.join(root, ".codeflowai")), false);
});

for (const cacheName of ["knowledge-search.sqlite", "file-index.db"] as const) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    test(`逐个工件反向规则均须开库前拒绝：${cacheName}${suffix}`, t => {
      const root = fixture(t);
      const ignore = `!.codeflowai/\n.codeflowai/*\n!.codeflowai/${cacheName}${suffix}\n`;
      fs.writeFileSync(path.join(root, ".gitignore"), ignore);
      assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root, cacheName), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "verify");
      assert.equal(fs.existsSync(path.join(root, ".codeflowai")), false);
      assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ignore);
      assert.equal(command(root, ["ls-files", "--cached", "-z"]).length, 0);
    });
  }
}

test("项目反向规则覆盖 exclude 时显式失败", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "!.codeflowai/\n!.codeflowai/**\n");
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "verify");
});

test("文件索引特定否定规则必须按实际缓存名验证", t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "!.codeflowai/\n.codeflowai/*\n!.codeflowai/file-index.db\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root, "file-index.db"), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "verify");
});

for (const kind of ["directory", "hardlink", "junction-parent"] as const) {
  test(`拒绝不安全 exclude 工件：${kind}`, t => {
    const root = fixture(t), outside = fixture(t, false), exclude = path.join(root, ".git", "info", "exclude");
    const target = path.join(outside, "target");
    fs.writeFileSync(target, "untouched");
    fs.unlinkSync(exclude);
    if (kind === "directory") fs.mkdirSync(exclude);
    else if (kind === "hardlink") fs.linkSync(target, exclude);
    else { fs.rmdirSync(path.dirname(exclude)); fs.symlinkSync(outside, path.dirname(exclude), "junction"); }
    assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root), WorkspacePrivateRuntimeGitError);
    assert.equal(fs.readFileSync(target, "utf8"), "untouched");
  });
}

test("linked worktree 使用 Git 返回的公共 exclude", t => {
  const root = fixture(t), linked = path.join(root, "linked");
  command(root, ["worktree", "add", "--orphan", linked]);
  ensureWorkspacePrivateRuntimeGitExclude(linked);
  const exclude = command(linked, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).toString().trim();
  assert.equal(path.resolve(exclude), path.join(root, ".git", "info", "exclude"));
  assert.equal(fs.readFileSync(exclude, "utf8").includes("/.codeflowai/"), true);
  command(linked, ["check-ignore", "--no-index", "-q", "--", ".codeflowai/knowledge-search.sqlite"]);
});

test("按实际 Skill 文件清单验证，不能用数据库探针代替嵌套资源", t => {
  const root = fixture(t);
  const files = ["skill-runtime/identity/version/SKILL.md", "skill-runtime/identity/version/references/read me.txt"];
  ensureWorkspacePrivateRuntimeGitExclude(root, files);
  command(root, ["check-ignore", "--no-index", "-q", "--", `.codeflowai/${files[1]}`]);
  fs.writeFileSync(path.join(root, ".gitignore"), "!.codeflowai/\n.codeflowai/*\n!.codeflowai/skill-runtime/\n!.codeflowai/skill-runtime/identity/\n!.codeflowai/skill-runtime/identity/version/\n.codeflowai/skill-runtime/identity/version/*\n!.codeflowai/skill-runtime/identity/version/references/\n!.codeflowai/skill-runtime/identity/version/references/read me.txt\n");
  ensureWorkspacePrivateRuntimeGitExclude(root);
  assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root, files), (error: unknown) => error instanceof WorkspacePrivateRuntimeGitError && error.phase === "verify");
});

for (const files of [[], ["../outside"], ["/absolute"], ["nul\0path"], ["skill-runtime/../file"]]) {
  test(`非法运行工件清单在修改 exclude 前失败：${JSON.stringify(files)}`, t => {
    const root = fixture(t), exclude = path.join(root, ".git", "info", "exclude"), before = fs.readFileSync(exclude);
    assert.throws(() => ensureWorkspacePrivateRuntimeGitExclude(root, files), WorkspacePrivateRuntimeGitError);
    assert.deepEqual(fs.readFileSync(exclude), before);
  });
}
