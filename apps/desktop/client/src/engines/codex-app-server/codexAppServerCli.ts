import path from "node:path";
import { resolveWindowsNpmCli } from "../utils/windowsNpmCli.js";
import { privateCliEngineRoot, readPrivateCliRuntimeEntry } from "../../cli-runtime/privateCliPaths.js";

/** 仅在 Codex 包装器进程内隐藏子进程，保留原包装器的环境和信号处理。 */
const WINDOWS_CODEX_BOOTSTRAP = [
  "const cp=require('node:child_process');const spawn=cp.spawn;",
  "cp.spawn=(command,args,options)=>Array.isArray(args)",
  "?spawn(command,args,{...options,windowsHide:true})",
  ":spawn(command,{...args,windowsHide:true});",
  "require('node:module').syncBuiltinESMExports();",
  "import(require('node:url').pathToFileURL(process.argv[1]).href)",
  ".catch(error=>{console.error(error);process.exitCode=1;});",
].join("");

/** Windows 先约束包装器的子进程创建；eval 模式仍保留原始 argv 与入口路径。 */
export function buildCodexNodeArgs(entryPath: string): string[] {
  return process.platform === "win32" ? ["-e", WINDOWS_CODEX_BOOTSTRAP, entryPath] : [entryPath];
}

/**
 * 解析 Codex CLI（app-server）启动命令。
 *
 * 应用私有运行时记录存在时优先使用其中的 JS 入口，由 process.execPath 启动
 * （Client 环境已设置 ELECTRON_RUN_AS_NODE=1）；即使入口文件缺失也照常返回，
 * 让后续检测边界显式失败而不是静默回退系统 CLI。runtime.json 非法时错误向上抛出。
 * 未安装私有运行时时保持 Windows 包内 codex.js / 非 Windows 裸命令的既有行为。
 */
export function resolveCodexCli(env: NodeJS.ProcessEnv = process.env): { command: string; argsPrefix: string[]; label: string } {
  const runtimeRoot = String(env.CODEFLOWAI_CLI_RUNTIME_ROOT ?? "").trim();
  if (runtimeRoot) {
    const entry = readPrivateCliRuntimeEntry(runtimeRoot, "codex");
    if (entry) {
      return {
        command: process.execPath,
        argsPrefix: buildCodexNodeArgs(path.resolve(privateCliEngineRoot(runtimeRoot, "codex"), entry.binPath)),
        label: "codex (private)",
      };
    }
  }
  if (process.platform === "win32") {
    const resolved = resolveWindowsNpmCli("codex", "node_modules\\@openai\\codex\\bin\\codex.js");
    if (resolved.command === process.execPath && resolved.argsPrefix.length === 1) {
      return { ...resolved, argsPrefix: buildCodexNodeArgs(resolved.argsPrefix[0]!) };
    }
    return resolved;
  }
  return { command: "codex", argsPrefix: [], label: "codex" };
}

