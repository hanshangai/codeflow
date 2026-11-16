import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareCodexImagesForTurn } from "../src/engines/codex/codexImageInput.js";
import { logger } from "../src/logger.js";

const IMAGES = ["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="];
const CONTEXT = { writeWorkspaceLog: testEngineWorkspaceLog, workspaceId: "image-workspace", threadId: "image-thread", clientTurnId: "image-turn", operation: "turn/start" as const };

/** 图片和日志仅留本例工作区；恢复注入后关闭仍未确认的测试 fd。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const workspacePath = fs.mkdtempSync(path.join(tempRoot, "codex-image-preparation-"));
  const root = path.join(workspacePath, ".codeflowai");
  const opened = new Map<number, string>(), logs: Record<string, unknown>[] = [];
  const open = fs.openSync, close = fs.closeSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (path.dirname(String(args[0])) === root) opened.set(fd, String(args[0]));
    return fd;
  });
  t.mock.method(fs, "closeSync", (fd: number) => { close(fd); opened.delete(fd); });
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "warn", () => {});
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { logs.push(data); });
  t.after(() => {
    t.mock.restoreAll();
    for (const fd of opened.keys()) close(fd);
    assert.equal(path.dirname(workspacePath), tempRoot);
    assert.ok(path.basename(workspacePath).startsWith("codex-image-preparation-"));
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  return { root, workspacePath, context: { ...CONTEXT, workspacePath }, opened, logs,
    entries: () => fs.existsSync(root) ? fs.readdirSync(root).sort() : [] };
}

/** 保留包括throw undefined在内的真实失败值，未失败直接使断言失败。 */
function thrown(action: () => unknown): unknown {
  let failed = false, error: unknown;
  try { action(); } catch (cause) { failed = true; error = cause; }
  assert.equal(failed, true, "preparation must fail");
  return error;
}

/** 只注入本例图片写入故障，第一张及第二张部分字节均实际落盘。 */
function failSecondWrite(t: test.TestContext, f: ReturnType<typeof fixture>, primary: unknown) {
  const write = fs.writeFileSync;
  let writes = 0;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    const file = typeof args[0] === "number" ? f.opened.get(args[0]) : String(args[0]);
    if (file && path.dirname(file) === f.root && ++writes === 2) {
      write(args[0], "partial-private-image");
      throw primary;
    }
    return write(...args);
  });
}

test("partial second image failure removes both owned files and retains the original cause", t => {
  const f = fixture(t), primary = Object.assign(new Error("private-write-reason"), { code: "ENOSPC", syscall: "write" });
  failSecondWrite(t, f, primary);
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.deepEqual(f.entries(), []);
  assert.equal(f.opened.size, 0);
  assert.ok(error instanceof Error);
  assert.equal(error.cause, primary);
  assert.equal((error as Error & { code: string }).code, "codex_image_preparation_failed");
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].errorCode, "codex_image_preparation_failed");
  assert.equal(f.logs[0].threadId, CONTEXT.threadId);
  assert.equal(f.logs[0].clientTurnId, CONTEXT.clientTurnId);
  assert.equal(f.logs[0].imageIndex, 1);
  assert.match(String(f.logs[0].requestId), /^codex-image:/);
  assert.deepEqual(f.logs[0].rootCause, { name: "Error", code: "ENOSPC", syscall: "write" });
  assert.doesNotMatch(JSON.stringify(f.logs), /private-write-reason|partial-private-image|YQ==/);
});

for (const stage of ["codex_image_input_received", "codex_image_temp_file_created", "codex_image_input_prepared", "codex_image_data_url_malformed"] as const) {
  test(`${stage} logging failure rolls back all prepared images`, t => {
    const f = fixture(t), primary = new Error("private-log-reason");
    const failLog = (_tag: string, _message: string, data: Record<string, unknown>) => { if (data.code === stage) throw primary; };
    t.mock.method(logger, stage === "codex_image_data_url_malformed" ? "warn" : "info", failLog);
    const error = thrown(() => prepareCodexImagesForTurn([...IMAGES, "data:invalid"], f.context));
    assert.deepEqual(f.entries(), []);
    assert.equal(f.opened.size, 0);
    assert.ok(error instanceof Error);
    assert.equal(error.cause, primary);
  });
}

test("exclusive creation preserves a colliding file and rolls back earlier owned images", t => {
  const f = fixture(t), leaseId = "f64e0895-adc5-4ad2-9e57-e175495d3fda";
  t.mock.method(crypto, "randomUUID", () => leaseId);
  const existing = path.join(f.root, `codeflowai-codex-img-${leaseId}-1.png`);
  fs.mkdirSync(f.root);
  fs.writeFileSync(existing, "someone-else");
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.ok(error instanceof Error);
  assert.equal((error.cause as NodeJS.ErrnoException).code, "EEXIST");
  assert.deepEqual(f.entries(), [path.basename(existing)]);
  assert.equal(fs.readFileSync(existing, "utf8"), "someone-else");
  assert.equal(f.opened.size, 0);
});

test("rollback unlink failure preserves both causes and still releases the other owned image", t => {
  const f = fixture(t), primary = new Error("private-write"), secondary = Object.assign(new Error("private-unlink"), { code: "EACCES", syscall: "unlink" });
  failSecondWrite(t, f, primary);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file).endsWith("-0.png")) throw secondary;
    return unlink(file);
  });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.deepEqual(error.errors, [primary, secondary]);
  assert.equal((error as AggregateError & { code: string }).code, "codex_image_preparation_cleanup_failed");
  assert.equal(f.entries().length, 1);
  assert.ok(f.entries()[0]!.endsWith("-0.png"));
  assert.equal(f.opened.size, 0);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-write|private-unlink|partial-private-image/);
});

test("write and close failures retain both errors and never unlink an unconfirmed open image", t => {
  const f = fixture(t), primary = new Error("private-write"), secondary = Object.assign(new Error("private-close"), { code: "EIO", syscall: "close" });
  failSecondWrite(t, f, primary);
  const close = fs.closeSync, unlink = fs.unlinkSync;
  let closes = 0;
  const deleted: string[] = [];
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (f.opened.get(fd)?.endsWith("-1.png")) { closes += 1; throw secondary; }
    return close(fd);
  });
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { deleted.push(String(file)); return unlink(file); });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.ok(error instanceof Error && error.cause instanceof AggregateError);
  assert.deepEqual(error.cause.errors, [primary, secondary]);
  assert.equal(closes, 1, "a failed close must not be retried implicitly");
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0]!.endsWith("-0.png"));
  assert.equal(f.entries().length, 1);
  assert.ok(f.entries()[0]!.endsWith("-1.png"));
  assert.equal((error as Error & { code: string }).code, "codex_image_preparation_cleanup_failed");
});

test("rollback refuses a replaced file and preserves its foreign bytes", t => {
  const f = fixture(t), primary = new Error("prepare-failed");
  const moved = path.join(f.root, "owned-moved.png");
  t.mock.method(logger, "info", (_tag: string, _message: string, data: Record<string, unknown>) => {
    if (data.code !== "codex_image_input_prepared") return;
    const first = path.join(f.root, f.entries()[0]!);
    fs.renameSync(first, moved);
    fs.writeFileSync(first, "foreign-image");
    throw primary;
  });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  const remaining = f.entries();
  assert.equal(remaining.length, 2);
  assert.equal(fs.readFileSync(path.join(f.root, remaining.find(file => file.endsWith("-0.png"))!), "utf8"), "foreign-image");
  assert.equal(fs.readFileSync(moved, "utf8"), "a");
});

test("error logging failure is aggregated only after image rollback completes", t => {
  const f = fixture(t), primary = new Error("write-failed"), logging = new Error("log-failed");
  failSecondWrite(t, f, primary);
  t.mock.method(logger, "error", () => { throw logging; });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.deepEqual(f.entries(), []);
  assert.equal(f.opened.size, 0);
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[1], logging);
  assert.ok(error.errors[0] instanceof Error);
  assert.equal(error.errors[0].cause, primary);
});

test("non Error preparation failures remain failures with their original cause", t => {
  const f = fixture(t);
  failSecondWrite(t, f, undefined);
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.deepEqual(f.entries(), []);
  assert.ok(error instanceof Error);
  assert.ok(Object.hasOwn(error, "cause"));
  assert.equal(error.cause, undefined);
});

test("identity capture failure closes its descriptor but preserves an unidentifiable file", t => {
  const f = fixture(t), primary = Object.assign(new Error("stat-failed"), { code: "EIO", syscall: "fstat" });
  const stat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (...args: Parameters<typeof fs.fstatSync>) => {
    if (f.opened.has(args[0])) throw primary;
    return stat(...args);
  });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.equal(f.opened.size, 0);
  assert.equal(f.entries().length, 1);
  assert.ok(error instanceof AggregateError);
  assert.equal(error.cause, primary);
  assert.equal((error.errors[1] as NodeJS.ErrnoException).code, "codex_image_temp_identity_changed");
});

test("successful write followed by close failure stops preparation and retains the file", t => {
  const f = fixture(t), primary = Object.assign(new Error("close-failed"), { code: "EIO", syscall: "close" });
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", (fd: number) => { if (f.opened.has(fd)) throw primary; return close(fd); });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.equal(f.opened.size, 1);
  assert.equal(f.entries().length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, f.entries()[0]!), "utf8"), "a");
  assert.ok(error instanceof Error);
  assert.equal(error.cause, primary);
  assert.equal((error as Error & { code: string }).code, "codex_image_preparation_cleanup_failed");
  assert.equal(f.logs[0].unconfirmedCloseCount, 1);
});

test("successful preparation preserves image bytes and normal lease cleanup ownership", t => {
  const f = fixture(t), local = path.join(f.workspacePath, "input.png");
  fs.writeFileSync(local, "local-image");
  const prepared = prepareCodexImagesForTurn([IMAGES[0]!, local, "https://example.com/image.png"], f.context);
  assert.equal(prepared.temporaryImageCount, 1);
  assert.deepEqual(prepared.images.slice(1), [local, "https://example.com/image.png"]);
  assert.equal(fs.readFileSync(prepared.images[0]!, "utf8"), "a");
  assert.equal(f.opened.size, 0);
  prepared.cleanup("test-provider-settled");
  assert.deepEqual(f.entries(), []);
  assert.equal(fs.readFileSync(local, "utf8"), "local-image");
});

test("data URL images are materialized in the trusted workspace runtime directory", t => {
  const f = fixture(t);
  const prepared = prepareCodexImagesForTurn([IMAGES[0]!], f.context);
  try {
    assert.equal(path.dirname(prepared.images[0]!), f.root);
    assert.equal(fs.readFileSync(prepared.images[0]!, "utf8"), "a");
  } finally {
    prepared.cleanup("workspace-path-test");
  }
});

test("empty, local, remote and malformed images do not create or validate a runtime directory", t => {
  const f = fixture(t), local = path.join(f.workspacePath, "local.png");
  fs.writeFileSync(local, "local");
  const missingWorkspace = path.join(f.workspacePath, "not-created");
  for (const images of [[], [local, "https://example.com/image.png", "data:invalid"]]) {
    const prepared = prepareCodexImagesForTurn(images, { ...f.context, workspacePath: missingWorkspace });
    assert.deepEqual(prepared.images, images);
    assert.equal(prepared.temporaryImageCount, 0);
    prepared.cleanup();
  }
  assert.equal(fs.existsSync(missingWorkspace), false);
  assert.deepEqual(fs.readdirSync(f.workspacePath), ["local.png"]);
});

test("workspaces and concurrent image leases stay separate without touching legacy Temp", t => {
  const f = fixture(t), other = path.join(f.workspacePath, "other"), legacy = path.join(f.workspacePath, "legacy-temp");
  fs.mkdirSync(other);
  fs.mkdirSync(legacy);
  const sentinel = path.join(legacy, "codeflowai-codex-img-old-0.png");
  fs.writeFileSync(sentinel, "legacy");
  t.mock.method(os, "tmpdir", () => legacy);
  const first = prepareCodexImagesForTurn([IMAGES[0]!], f.context);
  const second = prepareCodexImagesForTurn([IMAGES[1]!], f.context);
  const third = prepareCodexImagesForTurn([IMAGES[1]!], { ...f.context, workspacePath: other });
  assert.equal(path.dirname(first.images[0]!), f.root);
  assert.equal(path.dirname(third.images[0]!), path.join(other, ".codeflowai"));
  assert.notEqual(first.images[0], second.images[0]);
  first.cleanup();
  assert.equal(fs.readFileSync(second.images[0]!, "utf8"), "b");
  assert.equal(fs.readFileSync(third.images[0]!, "utf8"), "b");
  second.cleanup();
  third.cleanup();
  assert.equal(fs.readFileSync(sentinel, "utf8"), "legacy");
  assert.deepEqual(fs.readdirSync(legacy), [path.basename(sentinel)]);
});

/** Git 仅操作本例新仓库，失败包含完整状态，不执行真实用户仓库命令。 */
function fixtureGit(workspacePath: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd: workspacePath, windowsHide: true, shell: false, encoding: "utf8", input });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("runtime images use real local Git exclude and reject staged runtime data", t => {
  const f = fixture(t);
  fixtureGit(f.workspacePath, ["init", "--quiet"]);
  const prepared = prepareCodexImagesForTurn([IMAGES[0]!], f.context);
  const imageRelative = `.codeflowai/${path.basename(prepared.images[0]!)}`;
  assert.equal(fixtureGit(f.workspacePath, ["check-ignore", "--stdin", "-z"], `${imageRelative}\0`), `${imageRelative}\0`);
  assert.equal(fs.readFileSync(path.join(f.workspacePath, ".git", "info", "exclude"), "utf8").split(/\r?\n/).filter(line => line === "/.codeflowai/").length, 1);
  prepared.cleanup();
  const tracked = path.join(f.root, "tracked.txt");
  fs.writeFileSync(tracked, "user-data");
  fixtureGit(f.workspacePath, ["add", "--force", "--", ".codeflowai/tracked.txt"]);
  const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
  assert.ok(error instanceof Error);
  assert.equal((error.cause as NodeJS.ErrnoException).code, "WORKSPACE_PRIVATE_RUNTIME_GIT_TRACKED");
  assert.deepEqual(f.entries(), ["tracked.txt"]);
  assert.equal(fs.readFileSync(tracked, "utf8"), "user-data");
  assert.equal(fixtureGit(f.workspacePath, ["ls-files", "--", ".codeflowai/tracked.txt"]).trim(), ".codeflowai/tracked.txt");
});

test("Git wrapped exclude write failure records the filesystem root cause without private text", t => {
  const f = fixture(t), primary = Object.assign(new Error("token=private-git-root-cause"), { code: "ENOSPC", syscall: "write" });
  fixtureGit(f.workspacePath, ["init", "--quiet"]);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "number") throw primary;
    return write(...args);
  });
  const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
  assert.ok(error instanceof Error && error.cause instanceof Error);
  assert.equal((error.cause as NodeJS.ErrnoException).code, "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED");
  assert.equal(error.cause.cause, primary);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0]!.rootCause, {
    name: "WorkspacePrivateRuntimeGitError", code: "WORKSPACE_PRIVATE_RUNTIME_GIT_FAILED",
    cause: { name: "Error", code: "ENOSPC", syscall: "write" },
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /private-git-root-cause|token=|data:image|workspacePath/);
  assert.deepEqual(f.entries(), []);
});

test("directory wrapped creation failure records the filesystem root cause without private text", t => {
  const f = fixture(t), primary = Object.assign(new Error("token=private-directory-root-cause"), { code: "EACCES", syscall: "mkdir" });
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]) === f.root) throw primary;
    return mkdir(...args);
  });
  const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
  assert.ok(error instanceof Error && error.cause instanceof Error);
  assert.equal((error.cause as NodeJS.ErrnoException).code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
  assert.equal(error.cause.cause, primary);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0]!.rootCause, {
    name: "WorkspaceCodeflowaiDirectoryError", code: "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE",
    cause: { name: "Error", code: "EACCES", syscall: "mkdir" },
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /private-directory-root-cause|token=|data:image|workspacePath/);
  assert.equal(fs.existsSync(f.root), false);
});

test("wrapped failure and error logging failure preserve both original causes", t => {
  const f = fixture(t), primary = Object.assign(new Error("private-mkdir"), { code: "EIO", syscall: "mkdir" });
  const logError = new Error("private-log"), mkdir = fs.mkdirSync;
  t.mock.method(fs, "mkdirSync", (...args: Parameters<typeof fs.mkdirSync>) => {
    if (String(args[0]) === f.root) throw primary;
    return mkdir(...args);
  });
  t.mock.method(logger, "error", () => { throw logError; });
  const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
  assert.ok(error instanceof AggregateError);
  assert.equal(error.errors[1], logError);
  assert.ok(error.errors[0] instanceof Error && error.errors[0].cause instanceof Error);
  assert.equal(error.errors[0].cause.cause, primary);
  assert.equal(error.cause, error.errors[0]);
});

test("safe cause serialization bounds cycles and preserves existing aggregate children", t => {
  const f = fixture(t), primary = Object.assign(new Error("private-cycle"), { code: "EIO", syscall: "write" });
  primary.cause = primary;
  const secondary = Object.assign(new Error("private-close"), { code: "EACCES", syscall: "close" });
  failSecondWrite(t, f, primary);
  const close = fs.closeSync;
  t.mock.method(fs, "closeSync", (fd: number) => {
    if (f.opened.get(fd)?.endsWith("-1.png")) throw secondary;
    return close(fd);
  });
  const error = thrown(() => prepareCodexImagesForTurn(IMAGES, f.context));
  assert.ok(error instanceof Error && error.cause instanceof AggregateError);
  assert.deepEqual(error.cause.errors, [primary, secondary]);
  assert.equal(f.logs.length, 1);
  assert.deepEqual(f.logs[0]!.rootCause, {
    name: "AggregateError",
    cause: { name: "Error", code: "EIO", syscall: "write", cause: { name: "Error", code: "EIO", syscall: "write" } },
    errors: [
      { name: "Error", code: "EIO", syscall: "write", cause: { name: "Error", code: "EIO", syscall: "write" } },
      { name: "Error", code: "EACCES", syscall: "close" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(f.logs), /private-cycle|private-close|data:image|workspacePath/);
});

for (const unsafe of ["missing-workspace", "runtime-file", "runtime-junction"] as const) {
  test(`unsafe ${unsafe} fails without creating a provider image`, t => {
    const f = fixture(t);
    let workspacePath = f.workspacePath;
    if (unsafe === "missing-workspace") workspacePath = path.join(f.workspacePath, "missing");
    if (unsafe === "runtime-file") fs.writeFileSync(f.root, "foreign");
    if (unsafe === "runtime-junction") {
      const target = path.join(f.workspacePath, "foreign");
      fs.mkdirSync(target);
      fs.symlinkSync(target, f.root, process.platform === "win32" ? "junction" : "dir");
    }
    const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], { ...f.context, workspacePath }));
    assert.ok(error instanceof Error);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
    assert.equal(f.opened.size, 0);
    if (unsafe === "missing-workspace") assert.equal(fs.existsSync(workspacePath), false);
    if (unsafe === "runtime-file") assert.equal(fs.readFileSync(f.root, "utf8"), "foreign");
    if (unsafe === "runtime-junction") assert.deepEqual(fs.readdirSync(f.root), []);
  });
}

test("exclusive image creation uses workspace default permissions instead of an explicit private mode", t => {
  const f = fixture(t), open = fs.openSync;
  let imageMode: fs.Mode | null | undefined = 0o600;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (path.dirname(String(args[0])) === f.root) imageMode = args[2];
    return open(...args);
  });
  const prepared = prepareCodexImagesForTurn([IMAGES[0]!], f.context);
  assert.equal(imageMode, undefined);
  if (process.platform !== "win32") assert.equal(fs.statSync(prepared.images[0]!).mode & 0o777, 0o666 & ~process.umask());
  prepared.cleanup();
});

for (const stage of ["open", "write", "prepared"] as const) {
  test(`runtime directory identity change during ${stage} prevents image delivery and retains owned files`, t => {
    const f = fixture(t), moved = path.join(f.workspacePath, "retained-runtime");
    let replaced = false;
    const lstat = fs.lstatSync;
    if (stage !== "prepared") {
      t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
        const stat = lstat(...args);
        assert.ok(stat);
        if (replaced && String(args[0]) === f.root) Object.assign(stat, { ino: Number(stat.ino) + 1_024 });
        return stat;
      });
    }
    const replace = () => {
      if (replaced) return;
      replaced = true;
      if (stage !== "prepared") return;
      fs.renameSync(f.root, moved);
      fs.mkdirSync(f.root);
      fs.writeFileSync(path.join(f.root, "foreign.txt"), "foreign");
    };
    if (stage === "open") {
      const open = fs.openSync;
      t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
        const fd = open(...args);
        if (path.dirname(String(args[0])) === f.root) replace();
        return fd;
      });
    } else if (stage === "write") {
      const write = fs.writeFileSync;
      t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
        write(...args);
        if (typeof args[0] === "number" && f.opened.has(args[0])) replace();
      });
    } else {
      t.mock.method(logger, "info", (_tag: string, _message: string, data: Record<string, unknown>) => {
        if (data.code === "codex_image_input_prepared") replace();
      });
    }
    const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
    assert.ok(error instanceof AggregateError);
    assert.equal((error.cause as NodeJS.ErrnoException).code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
    assert.equal(f.opened.size, 0);
    if (stage === "prepared") {
      assert.equal(fs.readdirSync(moved).length, 1);
      assert.equal(fs.readFileSync(path.join(f.root, "foreign.txt"), "utf8"), "foreign");
    } else {
      assert.equal(f.entries().length, 1);
      assert.equal(fs.readFileSync(path.join(f.root, f.entries()[0]!), "utf8"), stage === "write" ? "a" : "");
    }
  });
}

test("a created path that no longer points to its open fd is rejected before image bytes are written", t => {
  const f = fixture(t), open = fs.openSync, moved = path.join(f.workspacePath, "owned.png");
  let replacement = "";
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (path.dirname(String(args[0])) === f.root) {
      replacement = String(args[0]);
      fs.renameSync(replacement, moved);
      fs.writeFileSync(replacement, "foreign-image");
    }
    return fd;
  });
  const error = thrown(() => prepareCodexImagesForTurn([IMAGES[0]!], f.context));
  assert.ok(error instanceof AggregateError);
  assert.equal((error.cause as NodeJS.ErrnoException).code, "codex_image_temp_identity_changed");
  assert.equal(fs.readFileSync(moved, "utf8"), "");
  assert.equal(fs.readFileSync(replacement, "utf8"), "foreign-image");
  assert.equal(f.opened.size, 0);
});
