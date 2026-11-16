import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodexCli } from "../src/engines/codex-app-server/codexAppServerCli.js";
import { defaultPrivateCliProbe } from "../src/app/handlers/privateCliRuntime.js";

const isWindows = process.platform === "win32";

/** 用真实 ESM 包装器及子进程覆盖两个入口，在系统调用边界记录隐藏选项。 */
function fixture(t: test.TestContext, source: "private" | "global") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-window-中文 "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, source === "private" ? "codex" : "npm");
  const entry = path.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
  const observer = path.join(root, "observe-spawn.cjs");
  const spawnOptions = path.join(root, "spawn-options.json");
  fs.writeFileSync(observer, `
    const cp = require('node:child_process');
    const spawn = cp.spawn;
    cp.spawn = (command, args, options) => {
      require('node:fs').writeFileSync(process.env.CODEFLOW_TEST_SPAWN_OPTIONS,
        JSON.stringify({ windowsHide: options?.windowsHide }));
      return spawn(command, args, options);
    };
    require('node:module').syncBuiltinESMExports();
  `, "utf8");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(entry), "package.json"), '{"type":"module"}', "utf8");
  fs.writeFileSync(entry, `
    import { spawn } from 'node:child_process';
    process.env.CODEX_MANAGED_PACKAGE_ROOT = process.argv[1];
    const child = spawn(process.execPath,
      ['-e', 'console.log(process.argv.includes("--version")?"codex-cli 0.166.0":JSON.stringify({argv:process.argv.slice(1),managedRoot:process.env.CODEX_MANAGED_PACKAGE_ROOT}));if(process.argv.includes("--fail"))process.exit(7)',
        '--', ...process.argv.slice(1)], {
        stdio: 'inherit',
        env: process.env,
      });
    child.on('error', error => { throw error; });
    child.on('exit', code => process.exit(code ?? 1));
  `, "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, CODEFLOW_TEST_SPAWN_OPTIONS: spawnOptions };
  if (source === "private") {
    env.CODEFLOWAI_CLI_RUNTIME_ROOT = root;
    fs.writeFileSync(path.join(prefix, "runtime.json"), JSON.stringify({
      schemaVersion: 1, engine: "codex", npmPackage: "@openai/codex", version: "0.166.0",
      installedAt: "2026-11-05T00:00:00.000Z", verifiedAt: "2026-11-05T00:00:01.000Z",
      binPath: path.relative(prefix, entry),
    }), "utf8");
  } else {
    delete env.CODEFLOWAI_CLI_RUNTIME_ROOT;
    fs.writeFileSync(path.join(prefix, "codex.cmd"), "@echo off\r\n", "ascii");
  }
  const previousPath = process.env.PATH;
  let cli: ReturnType<typeof resolveCodexCli>;
  try {
    process.env.PATH = prefix;
    cli = resolveCodexCli(env);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
  return { entry, env, cli, observer, spawnOptions, engineRoot: prefix };
}

/** 观察器只记录系统调用参数，包装器和子进程仍按真实启动链执行。 */
function runCli(f: ReturnType<typeof fixture>, args: string[]) {
  const result = spawnSync(f.cli.command, ["--require", f.observer, ...f.cli.argsPrefix, ...args], {
    env: f.env, encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  assert.ifError(result.error);
  return result;
}

for (const source of ["private", "global"] as const) {
  test(`Windows Codex ${source} 包装器隐藏子进程且保留启动上下文`, { skip: !isWindows }, t => {
    const f = fixture(t, source);
    const result = runCli(f, ["app-server", "-c", "测试 space"]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.argv, [f.entry, "app-server", "-c", "测试 space"]);
    assert.equal(report.managedRoot, f.entry);
    const options = JSON.parse(fs.readFileSync(f.spawnOptions, "utf8"));
    assert.equal(options.windowsHide, true, "隐藏选项必须传递到包装器的子进程创建边界");
  });

  test(`Windows Codex ${source} 包装器保留子进程失败退出码`, { skip: !isWindows }, t => {
    const f = fixture(t, source);
    const result = runCli(f, ["--fail"]);
    assert.equal(result.status, 7, result.stderr);
  });
}

test("Windows Codex 私有入口丢失时不受 Promise 告警模式影响，仍显式失败", { skip: !isWindows }, t => {
  const f = fixture(t, "private");
  f.env.NODE_OPTIONS = `${f.env.NODE_OPTIONS ?? ""} --unhandled-rejections=warn`;
  fs.unlinkSync(f.entry);
  const result = runCli(f, ["--version"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODULE_NOT_FOUND/u);
});

test("Windows Codex 安装后的版本探测也隐藏包装器的子进程", { skip: !isWindows }, async t => {
  const f = fixture(t, "private");
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, "spawn", (command: string, args: string[], options: childProcess.SpawnOptions) =>
    spawn(command, ["--require", f.observer, ...args], { ...options, env: { ...options.env, ...f.env } }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.deepEqual(await defaultPrivateCliProbe({ engine: "codex", engineRoot: f.engineRoot }), {
    version: "0.166.0", binPath: "node_modules/@openai/codex/bin/codex.js",
  });
  const options = JSON.parse(fs.readFileSync(f.spawnOptions, "utf8"));
  assert.equal(options.windowsHide, true);
});
