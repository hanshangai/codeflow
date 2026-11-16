import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptUrl = new URL("../scripts/build-shell-launcher.mjs", import.meta.url);
const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** 为构建边界建立独占临时目录，退出只清理本测试拥有的目录。 */
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-launcher-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { root, outputDir: path.join(root, "output"), cacheDir: path.join(root, "cache") };
}

/** 动态读取新增入口，让缺失实现表现为明确的功能断言。 */
async function builder() {
  const exists = await fs.access(scriptUrl).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  assert.equal(exists, true, "固定启动器构建入口尚未实现");
  return await import(scriptUrl.href) as typeof import("../scripts/build-shell-launcher.mjs");
}

test("shared shell builder cache stays outside the repository", async () => {
  const { resolveSharedShellBuilderCache } = await import("../scripts/shell-build-cache.mjs") as {
    resolveSharedShellBuilderCache: () => string;
  };
  const cache = resolveSharedShellBuilderCache();
  assert.equal(path.isAbsolute(cache), true);
  const relative = path.relative(repository, cache);
  assert.equal(path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`), true);
});

/** 等待真实子进程关闭，保留退出码和诊断，不启动 shell。 */
async function execute(file: string, args: string[], env = process.env) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

test("rejects output inside the repository before creating output or compiler cache", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  const outputDir = path.join(repository, "apps/desktop/build/forbidden-output");
  await assert.rejects(buildShellLauncher({ outputDir, cacheDir: f.cacheDir }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(outputDir), { code: "ENOENT" });
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

test("rejects output containing the repository before any write", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await assert.rejects(buildShellLauncher({ outputDir: path.dirname(repository), cacheDir: f.cacheDir }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

test("rejects cache nested in output before creating either directory", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await assert.rejects(buildShellLauncher({ outputDir: f.outputDir, cacheDir: path.join(f.outputDir, "cache") }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

test("rejects output nested in cache before creating either directory", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await assert.rejects(buildShellLauncher({ outputDir: path.join(f.cacheDir, "output"), cacheDir: f.cacheDir }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

test("rejects a cache alias into source before any output write", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder(), alias = path.join(f.root, "cache-alias");
  await fs.symlink(repository, alias, "junction");
  await assert.rejects(buildShellLauncher({ outputDir: f.outputDir, cacheDir: path.join(alias, "forbidden-cache") }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

test("rejects an existing cache without changing its files", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await fs.mkdir(f.cacheDir);
  await fs.writeFile(path.join(f.cacheDir, "marker"), "keep", "ascii");
  await assert.rejects(buildShellLauncher(f), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(f.cacheDir, "marker"), "ascii"), "keep");
  assert.deepEqual(await fs.readdir(f.outputDir), []);
});

test("rejects an existing output and preserves its contents", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await fs.mkdir(f.outputDir);
  await fs.writeFile(path.join(f.outputDir, "marker"), "keep", "utf8");
  await assert.rejects(buildShellLauncher(f), { code: "EEXIST" });
  assert.equal(await fs.readFile(path.join(f.outputDir, "marker"), "utf8"), "keep");
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

test("resolves a parent junction before protecting source inputs", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  const alias = path.join(f.root, "source-alias");
  await fs.symlink(repository, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildShellLauncher({ outputDir: path.join(alias, "forbidden-output"), cacheDir: f.cacheDir }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

test("rejects a compiler cache inside the repository before creating output", async t => {
  const f = await fixture(t), { buildShellLauncher } = await builder();
  await assert.rejects(buildShellLauncher({ outputDir: f.outputDir, cacheDir: path.join(repository, "forbidden-cache") }), /DESKTOP_SHELL_BUILD_PATH_OVERLAP/u);
  await assert.rejects(fs.access(f.outputDir), { code: "ENOENT" });
});

test("the public CLI cannot bypass its write guard through an internal compiler mode", async t => {
  const f = await fixture(t);
  const result = await execute(process.execPath, [fileURLToPath(scriptUrl), "--compiler", f.root], { ...process.env, ELECTRON_BUILDER_CACHE: f.cacheDir });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /DESKTOP_SHELL_BUILD_PATH_OVERLAP|用法/u);
  await assert.rejects(fs.access(f.cacheDir), { code: "ENOENT" });
});

const launcher = process.env.CF_DESKTOP_SHELL_LAUNCHER_EXE;
if (launcher) {
  /** 建立真实 launcher、Node 目标与最低基线资源，全部位于独占目录。 */
  async function launchFixture(t: TestContext) {
    const f = await fixture(t), root = path.join(f.root, "安装 空间 $"), target = path.join(root, "shells/current/CodeFlowAI.exe");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(launcher!, path.join(root, "CodeFlowAI.exe"));
    await fs.copyFile(process.execPath, target);
    for (const file of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
      const output = path.join(root, "shells/current/resources", file);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, "fixture", "utf8");
    }
    const state = Buffer.from("[shell]\r\nschema=1\r\nactive=current\r\nprevious=\r\nbaseline=current\r\n", "ascii");
    await fs.writeFile(path.join(root, "shell-launch.ini"), state);
    const capture = path.join(root, "capture.cjs"), marker = path.join(root, "argv.json");
    await fs.writeFile(capture, 'const f=require("node:fs"),p=process.env.CF_LAUNCH_MARKER;f.writeFileSync(p+".tmp",JSON.stringify({pid:process.pid,args:process.argv.slice(2)}),"utf8");f.renameSync(p+".tmp",p);', "utf8");
    return { root, state, capture, marker, executable: path.join(root, "CodeFlowAI.exe"), env: { ...process.env, CF_LAUNCH_MARKER: marker } };
  }

  /** 等待原子参数证据及对应进程退出，随后才允许清理夹具。 */
  async function capturedArguments(marker: string) {
    const deadline = Date.now() + 10_000;
    while (!(await fs.access(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))) {
      assert.ok(Date.now() < deadline, "目标进程未写入参数证据");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const captured = JSON.parse(await fs.readFile(marker, "utf8")) as { pid: number; args: string[] };
    for (;;) {
      try { process.kill(captured.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return captured.args; throw error; }
      assert.ok(Date.now() < deadline, "目标进程未退出");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  /** 核对失败的结构化证据及原状态保持，禁止启动目标进程。 */
  async function assertLaunchFailure(f: Awaited<ReturnType<typeof launchFixture>>, args: string[] = []) {
    const before = await fs.readFile(path.join(f.root, "shell-launch.ini"));
    const result = await execute(f.executable, [f.capture, ...args], f.env);
    assert.equal(result.code, 1, result.stderr);
    assert.deepEqual(await fs.readFile(path.join(f.root, "shell-launch.ini")), before);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
    const lines = (await fs.readFile(path.join(f.root, "shell-launch-errors.jsonl"), "utf8")).trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.errorCode, "DESKTOP_SHELL_LAUNCH_FAILED");
    assert.match(record.requestId, /^[0-9a-f-]{36}$/iu);
    assert.match(record.activeId, /^(?:|current)$/u);
    assert.equal(typeof record.rootCause, "string");
    return record;
  }

  test("real launcher preserves empty, quoted, Unicode and trailing-slash arguments near its native limit", async t => {
    const f = await launchFixture(t), args = ["", "hello world", 'quote"inside', "尾部\\", "$value", "back\\\"quote", "x".repeat(7500)];
    assert.equal((await execute(f.executable, [f.capture, ...args], f.env)).code, 0);
    assert.deepEqual(await capturedArguments(f.marker), args);
    assert.deepEqual(await fs.readFile(path.join(f.root, "shell-launch.ini")), f.state);
  });

  for (const [name, change] of [
    ["BOM", (s: Buffer) => Buffer.concat([Buffer.from([239, 187, 191]), s])],
    ["extra bytes", (s: Buffer) => Buffer.concat([s, Buffer.from("extra")])],
    ["duplicate key", (s: Buffer) => Buffer.concat([s, Buffer.from("active=current\r\n")])],
    ["LF", (s: Buffer) => Buffer.from(s.toString().replaceAll("\r\n", "\n"))],
    ["non ASCII", (s: Buffer) => Buffer.from(s.toString().replace("previous=", "previous=版本"))],
    ["reserved previous", (s: Buffer) => Buffer.from(s.toString().replace("previous=", "previous=CoM1.exe"))],
    ["reserved baseline", (s: Buffer) => Buffer.from(s.toString().replace("baseline=current", "baseline=nul.any"))],
    ["long ID", (s: Buffer) => Buffer.from(s.toString().replace("active=current", `active=${"x".repeat(129)}`))],
  ] as const) {
    test(`real launcher rejects ${name}`, async t => {
      const f = await launchFixture(t);
      await fs.writeFile(path.join(f.root, "shell-launch.ini"), change(f.state));
      await assertLaunchFailure(f);
    });
  }

  for (const relative of ["shells/current/resources/web/index.html", "shells/current/resources/client/dist/index.cjs", "shells/current/resources/release-trust.json"]) {
    test(`real launcher rejects missing baseline ${relative}`, async t => {
      const f = await launchFixture(t);
      await fs.unlink(path.join(f.root, relative));
      const record = await assertLaunchFailure(f);
      assert.equal(record.win32Error, 2);
      assert.equal(typeof record.relativeEntity, "string");
    });
  }

  test("real launcher rejects missing previous shell", async t => {
    const f = await launchFixture(t);
    await fs.writeFile(path.join(f.root, "shell-launch.ini"), f.state.toString().replace("previous=", "previous=old"));
    await assertLaunchFailure(f);
  });

  test("real launcher preserves sharing violation when opening state fails", async t => {
    const f = await launchFixture(t), lockMarker = path.join(f.root, "locked"), releaseMarker = path.join(f.root, "release");
    const source = '$ErrorActionPreference="Stop"\n$handle=[System.IO.File]::Open($env:CF_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)\ntry {[System.IO.File]::WriteAllText($env:CF_LOCK_READY,"ready");while (-not [System.IO.File]::Exists($env:CF_LOCK_RELEASE)){Start-Sleep -Milliseconds 25}} finally {$handle.Dispose()}';
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const held = execute(path.join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
      { ...process.env, CF_LOCK_PATH: path.join(f.root, "shell-launch.ini"), CF_LOCK_READY: lockMarker, CF_LOCK_RELEASE: releaseMarker });
    try {
      const deadline = Date.now() + 10_000;
      while (!(await fs.access(lockMarker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }))) {
        assert.ok(Date.now() < deadline, "文件独占锁未建立");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal((await execute(f.executable, [f.capture], f.env)).code, 1);
    } finally {
      await fs.writeFile(releaseMarker, "release", "ascii");
      assert.equal((await held).code, 0);
    }
    const record = JSON.parse((await fs.readFile(path.join(f.root, "shell-launch-errors.jsonl"), "utf8")).trim());
    assert.equal(record.rootCause, "STATE_OPEN_FAILED");
    assert.equal(record.win32Error, 32);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  });

  for (const id of ["COM10", "LPT0", "COMa"]) {
    test(`real launcher accepts portable previous ID ${id}`, async t => {
      const f = await launchFixture(t), previous = path.join(f.root, "shells", id);
      await fs.mkdir(previous);
      await fs.writeFile(path.join(previous, "CodeFlowAI.exe"), "previous", "ascii");
      await fs.writeFile(path.join(f.root, "shell-launch.ini"), f.state.toString().replace("previous=", `previous=${id}`));
      assert.equal((await execute(f.executable, [f.capture], f.env)).code, 0);
      assert.deepEqual(await capturedArguments(f.marker), []);
    });
  }

  test("real launcher rejects a target directory junction", async t => {
    const f = await launchFixture(t), original = path.join(f.root, "shells/current"), actual = path.join(f.root, "actual");
    await fs.rename(original, actual);
    await fs.symlink(actual, original, "junction");
    await assertLaunchFailure(f);
  });

  test("real launcher rejects an executable directory", async t => {
    const f = await launchFixture(t), file = path.join(f.root, "shells/current/CodeFlowAI.exe");
    await fs.unlink(file);
    await fs.mkdir(file);
    await assertLaunchFailure(f);
  });

  test("real launcher preserves the Windows error for an invalid executable", async t => {
    const f = await launchFixture(t);
    await fs.writeFile(path.join(f.root, "shells/current/CodeFlowAI.exe"), "not a PE fixture", "ascii");
    const record = await assertLaunchFailure(f);
    assert.equal(record.rootCause, "SHELL_EXEC_FAILED");
    assert.equal(record.win32Error, 216);
    assert.equal(record.processCreated, false);
  });

  test("real launcher rejects arguments beyond its native string capacity", async t => {
    const f = await launchFixture(t);
    const record = await assertLaunchFailure(f, ["x".repeat(9000)]);
    assert.equal(record.rootCause, "COMMAND_LINE_TOO_LONG");
  });

  test("real launcher reports a distinct nonzero result when failure logging cannot open", async t => {
    const f = await launchFixture(t);
    await fs.appendFile(path.join(f.root, "shell-launch.ini"), "extra", "ascii");
    await fs.mkdir(path.join(f.root, "shell-launch-errors.jsonl"));
    assert.equal((await execute(f.executable, [f.capture], f.env)).code, 2);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
  });
}
