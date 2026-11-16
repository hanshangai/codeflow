import fs from "node:fs";
import path from "node:path";

export type ResolvedCli = {
  command: string;
  argsPrefix: string[];
  label: string;
};

/** 依次定位 PATH、显式 npm prefix 和用户 npm 目录中的真实 shim，不改系统 PATH。 */
function findNpmShim(filename: string): string | null {
  const pathEnv = String(process.env.PATH ?? "");
  const parts = [...new Set([
    ...pathEnv.split(path.delimiter),
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
    process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
  ].filter((dir): dir is string => Boolean(dir)))];
  for (const dir of parts) {
    const full = path.join(dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Windows 下的 npm 全局安装 CLI 通常是 `xxx.cmd`，无法直接 spawn。
 * 这里优先解析 npm 包内的真实入口：
 * - JS/CJS/MJS 脚本：spawn 当前 Node + 脚本路径
 * - 其他可执行文件：直接 spawn 该可执行文件
 * 若所有候选入口都缺失，再回退为裸命令名。
 */
export function resolveWindowsNpmCli(cmdName: string, scriptRelativePath: string | string[]): ResolvedCli {
  const cmdPath = findNpmShim(`${cmdName}.cmd`);
  if (!cmdPath) {
    return { command: cmdName, argsPrefix: [], label: cmdName };
  }
  const dp0 = path.dirname(cmdPath);
  const candidates = Array.isArray(scriptRelativePath) ? scriptRelativePath : [scriptRelativePath];
  for (const candidate of candidates) {
    const scriptPath = path.join(dp0, candidate);
    if (!fs.existsSync(scriptPath)) {
      continue;
    }
    const ext = path.extname(scriptPath).toLowerCase();
    if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
      return { command: process.execPath, argsPrefix: [scriptPath], label: `${cmdName} (node entry)` };
    }
    return { command: scriptPath, argsPrefix: [], label: `${cmdName} (${path.basename(scriptPath)})` };
  }
  return { command: cmdName, argsPrefix: [], label: cmdName };
}

