import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWindowsNpmCli } from "../src/engines/utils/windowsNpmCli.ts";

const isWindows = process.platform === "win32";

/** 隔离 CLI 文件及相关进程环境，验证后恢复调用方环境。 */
function withTempWindowsCliFixture(run: (tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-windows-npm-cli-"));
  const envKeys = ["PATH", "APPDATA", "npm_config_prefix", "NPM_CONFIG_PREFIX"] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    fs.writeFileSync(path.join(tempDir, "claude.cmd"), "@echo off\r\n", "ascii");
    process.env.PATH = tempDir;
    run(tempDir);
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("resolveWindowsNpmCli 优先使用存在的 JS 入口", { skip: !isWindows }, () => {
  withTempWindowsCliFixture((tempDir) => {
    const scriptPath = path.join(tempDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "console.log('ok')\n", "utf8");

    const resolved = resolveWindowsNpmCli("claude", [
      "node_modules\\@anthropic-ai\\claude-code\\cli.js",
      "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    ]);

    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.argsPrefix, [scriptPath]);
  });
});

test("PATH 缺少用户 npm 目录时仍定位已安装 Codex", { skip: !isWindows }, () => {
  withTempWindowsCliFixture(tempDir => {
    const appData = path.join(tempDir, "user-appdata");
    const prefix = path.join(appData, "npm");
    const scriptPath = path.join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(path.join(prefix, "codex.cmd"), "@echo off\r\n", "ascii");
    fs.writeFileSync(scriptPath, "console.log('codex fixture')\n", "utf8");
    process.env.APPDATA = appData;
    process.env.npm_config_prefix = path.join(tempDir, "client-npm");
    delete process.env.NPM_CONFIG_PREFIX;
    const resolved = resolveWindowsNpmCli("codex", "node_modules\\@openai\\codex\\bin\\codex.js");
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.argsPrefix, [scriptPath]);
    assert.equal(process.env.PATH, tempDir);
  });
});

test("PATH 优先于显式 npm prefix，裸命令缺失仍由调用边界显式失败", { skip: !isWindows }, () => {
  withTempWindowsCliFixture(tempDir => {
    const prefix = path.join(tempDir, "explicit-prefix");
    const relative = path.join("node_modules", "@openai", "codex", "bin", "codex.js");
    for (const root of [tempDir, prefix]) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, "codex.cmd"), "@echo off\r\n", "ascii");
      fs.writeFileSync(path.join(root, relative), "console.log('fixture')\n", "utf8");
    }
    process.env.npm_config_prefix = prefix;
    const fromPath = resolveWindowsNpmCli("codex", relative);
    assert.deepEqual(fromPath.argsPrefix, [path.join(tempDir, relative)]);
    process.env.PATH = path.join(tempDir, "no-shims");
    const fromPrefix = resolveWindowsNpmCli("codex", relative);
    assert.deepEqual(fromPrefix.argsPrefix, [path.join(prefix, relative)]);
    const missing = resolveWindowsNpmCli("acceptance-cli-not-installed", relative);
    assert.equal(missing.command, "acceptance-cli-not-installed");
  });
});

test("resolveWindowsNpmCli 在 JS 入口缺失时改用可执行文件", { skip: !isWindows }, () => {
  withTempWindowsCliFixture((tempDir) => {
    const exePath = path.join(tempDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "", "binary");

    const resolved = resolveWindowsNpmCli("claude", [
      "node_modules\\@anthropic-ai\\claude-code\\cli.js",
      "node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    ]);

    assert.equal(resolved.command, exePath);
    assert.deepEqual(resolved.argsPrefix, []);
  });
});
