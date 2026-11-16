const fs = require("node:fs");
const path = require("node:path");

/** 使用Node入口或原生二进制执行pnpm，Windows也不把目录参数拼进shell。 */
function resolvePnpmCommand() {
  const entry = process.env.npm_execpath;
  if (entry && /(?:^|[/\\])pnpm\.(?:c?js|exe)$/iu.test(entry) && fs.statSync(entry).isFile()) {
    return entry.endsWith(".exe") ? { command: entry, prefixArgs: [] } : { command: process.execPath, prefixArgs: [entry] };
  }
  if (process.platform !== "win32") return { command: "pnpm", prefixArgs: [] };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const relative of ["pnpm.exe", "node_modules/pnpm/pnpm.exe", "node_modules/pnpm/bin/pnpm.cjs", "node_modules/corepack/dist/pnpm.js"]) {
      const file = path.join(directory, relative);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file.endsWith(".exe")
        ? { command: file, prefixArgs: [] } : { command: process.execPath, prefixArgs: [file] };
    }
  }
  throw new Error("PNPM_EXECUTABLE_REQUIRED: use pnpm exec node or install a Node/native pnpm entry");
}

module.exports = { resolvePnpmCommand };
