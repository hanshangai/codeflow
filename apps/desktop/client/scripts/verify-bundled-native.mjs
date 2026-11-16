#!/usr/bin/env node
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const platformKeys = manifest.codeflowai?.clientBundle?.platformKeys;
const platformKey = `${process.platform}-${process.arch}`;
const requestId = crypto.randomUUID();
const ptyFiles = {
  "win32-x64": ["pty.node", "conpty.node", "conpty_console_list.node", "winpty-agent.exe", "winpty.dll", "conpty/conpty.dll", "conpty/OpenConsole.exe"],
  "darwin-x64": ["pty.node", "spawn-helper"],
  "darwin-arm64": ["pty.node", "spawn-helper"],
  "linux-x64": ["pty.node"],
};
if (Array.isArray(platformKeys) && !platformKeys.includes(`${process.platform}-${process.arch}`)) {
  console.error(`[CLIENT_PLATFORM_UNSUPPORTED] 当前系统不在本包支持范围：${process.platform}-${process.arch}；支持 ${platformKeys.join(", ")}`);
  process.exit(1);
}

/** 校验平台 Client 包内置的运行时 native 依赖可直接加载。 */
async function verifyDependency(dep) {
  try {
    require(require.resolve(dep, { paths: [process.cwd()] }));
    if (dep === "node-pty") {
      const root = path.dirname(require.resolve("node-pty/package.json", { paths: [process.cwd()] }));
      if (Array.isArray(platformKeys)) {
        for (const file of ptyFiles[platformKey] || []) {
          const target = path.join(root, "prebuilds", platformKey, file);
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`缺少 PTY 原生文件：${platformKey}/${file}`);
        }
      }
      if (process.platform === "darwin") {
        // Windows 汇总的 tgz 可能丢失执行位；无论是否声明 platformKeys 都先修复再自检。
        const helper = path.join(root, "prebuilds", platformKey, "spawn-helper");
        fs.chmodSync(helper, fs.statSync(helper).mode | 0o755);
      }
      await verifyPtyRuntime();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ code: "CLIENT_NATIVE_LOAD_FAILED", requestId, platformKey, dependency: dep, rootCause: reason }));
    console.error(`[CLIENT_NATIVE_LOAD_FAILED] 内置依赖 ${dep} 无法在当前环境加载。`);
    console.error(`[codeflowai/client] 请确认安装包匹配当前系统与架构：${process.platform}-${process.arch}。`);
    console.error("[codeflowai/client] 本安装包不会在客户机回退到本机编译。");
    console.error(`[codeflowai/client] 原始错误：${reason}`);
    process.exit(1);
  }
}

/** 独立进程真实创建 PTY，避免 require 的延迟加载和 Windows conout worker 掩盖故障。 */
function verifyPtyRuntime() {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = execFile(process.execPath, [fileURLToPath(import.meta.url), "--pty-smoke"], {
      cwd: process.cwd(), encoding: "utf8", windowsHide: true, detached: process.platform !== "win32", maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (error || !stdout.includes("CODEFLOW_PTY_VERIFY_OK")) reject(new Error(timedOut
        ? "PTY 自检超时，已停止自检进程"
        : `PTY 自检失败：${stderr.trim() || error?.message || "终端未返回预期输出"}`));
      else resolve();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        execFile(path.join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, 12000);
  });
}

if (process.argv[2] === "--pty-smoke") {
  try {
    const pty = require(require.resolve("node-pty", { paths: [process.cwd()] }));
    const windows = process.platform === "win32";
    const terminal = pty.spawn(windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
      windows ? ["/d", "/c", "echo CODEFLOW_PTY_VERIFY_OK"] : ["-c", "printf CODEFLOW_PTY_VERIFY_OK"],
      { cwd: os.tmpdir(), env: process.env });
    let output = "";
    terminal.onData(data => { output += data; });
    terminal.onExit(({ exitCode }) => {
      const ok = exitCode === 0 && output.includes("CODEFLOW_PTY_VERIFY_OK");
      process.stdout.write(ok ? "CODEFLOW_PTY_VERIFY_OK\n" : "PTY_EXIT_INVALID\n", () => process.exit(ok ? 0 : 1));
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else {

const deps = process.argv.slice(2).map((item) => String(item ?? "").trim()).filter(Boolean);
if (deps.length === 0) {
  console.error("[codeflowai/client] 缺少需要校验的 native 依赖名称。");
  process.exit(1);
}

for (const dep of deps) await verifyDependency(dep);
}
