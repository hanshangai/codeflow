import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * 解析本机可用的 tar。
 *
 * Windows 上优先使用系统自带 bsdtar（System32\tar.exe）：Git Bash 里的 GNU tar
 * 会把 "C:\..." 解释成远端主机（tar: Cannot connect to C: resolve failed）。
 * 系统 tar 缺失时退回 PATH，并为 GNU tar 追加 --force-local 解除同一歧义。
 * 返回 { command, prefixArgs }；非 Windows 保持原样直接调用 tar。
 */
export function resolveTar() {
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(systemTar)) return { command: systemTar, prefixArgs: [] };
    return { command: "tar", prefixArgs: ["--force-local"] };
  }
  return { command: "tar", prefixArgs: [] };
}

/** 用解析后的 tar 执行一次同步调用；调用方参数与选项原样透传。 */
export function runTar(args, options = {}) {
  const { command, prefixArgs } = resolveTar();
  return execFileSync(command, [...prefixArgs, ...args], options);
}
