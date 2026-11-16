import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const packageRoot = process.cwd();
const nestedNodeModules = path.join(packageRoot, "node_modules");
const require = createRequire(import.meta.url);

let removedMaps = 0;
let repairedSpawnHelpers = 0;

if (fs.existsSync(nestedNodeModules)) {
  walkAndPrune(nestedNodeModules);
}
repairNodePtySpawnHelperExecutable();

if (removedMaps > 0) {
  console.log(`[codeflowai/client] postinstall pruned ${removedMaps} source map file(s)`);
}
if (repairedSpawnHelpers > 0) {
  console.log(`[codeflowai/client] postinstall repaired ${repairedSpawnHelpers} node-pty spawn-helper file(s)`);
}

function walkAndPrune(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndPrune(fullPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".map")) {
      try {
        fs.unlinkSync(fullPath);
        removedMaps += 1;
      } catch {
        // ignore prune failures; install should remain usable
      }
    }
  }
}

/** 修复 macOS node-pty spawn-helper 执行位；Linux 使用 forkpty，不需要该文件。 */
function repairNodePtySpawnHelperExecutable() {
  if (process.platform !== "darwin") return;
  const helperPaths = resolveNodePtySpawnHelperPaths();
  if (helperPaths.length === 0) {
    throw new Error(`[codeflowai/client] 未找到 node-pty ${process.platform} spawn-helper，终端功能不可用。`);
  }
  for (const helperPath of helperPaths) {
    if (ensureExecutableFile(helperPath)) repairedSpawnHelpers += 1;
  }
}

/** 查找当前平台的 node-pty spawn-helper，不处理其他平台的文件。 */
function resolveNodePtySpawnHelperPaths() {
  const packageJsonPath = require.resolve("node-pty/package.json", { paths: [packageRoot] });
  const nodePtyRoot = path.dirname(packageJsonPath);
  const candidates = [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
  ];
  return [...new Set(candidates)].filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** 确保文件对当前安装用户可执行，必要时补齐执行位。 */
function ensureExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return false;
  } catch {
    // continue with chmod
  }
  const stat = fs.statSync(filePath);
  fs.chmodSync(filePath, stat.mode | 0o755);
  fs.accessSync(filePath, fs.constants.X_OK);
  return true;
}
