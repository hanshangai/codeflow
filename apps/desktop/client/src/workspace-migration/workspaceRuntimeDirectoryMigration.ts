import fs from "node:fs";
import path from "node:path";

const LEGACY_RUNTIME_DIRECTORY = ".codeflow";
const CONTROL_DIRECTORY = ".codeflowai";

/** 将旧工作区 `.codeflow` 运行目录合并到 `.codeflowai`；冲突保留旧文件，不覆盖新数据。 */
export function migrateLegacyWorkspaceRuntimeDirectories(workspacePaths: Iterable<string>): void {
  for (const workspacePath of workspacePaths) {
    const value = String(workspacePath ?? "").trim();
    if (!value) continue;
    migrateLegacyWorkspaceRuntimeDirectory(path.resolve(value));
  }
}

/** 单工作区合并：数据、索引、日志和私有运行目录都平移到新控制目录。 */
export function migrateLegacyWorkspaceRuntimeDirectory(workspacePath: string): void {
  const root = path.resolve(workspacePath);
  const legacy = path.join(root, LEGACY_RUNTIME_DIRECTORY);
  if (!fs.existsSync(legacy)) return;
  const target = path.join(root, CONTROL_DIRECTORY);
  fs.mkdirSync(target, { recursive: true });
  mergeDirectory(legacy, target);
  if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
}

/** 递归合并目录；同名冲突保留旧内容为 legacy 文件，绝不覆盖新目录数据。 */
function mergeDirectory(source: string, target: string): void {
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name), to = path.join(target, name);
    const sourceStat = fs.lstatSync(from);
    if (sourceStat.isSymbolicLink()) throw new Error(`WORKSPACE_RUNTIME_MIGRATION_UNSAFE: ${from}`);
    let targetStat: fs.Stats | null = null;
    try { targetStat = fs.lstatSync(to); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!targetStat) { fs.renameSync(from, to); continue; }
    if (targetStat.isSymbolicLink()) throw new Error(`WORKSPACE_RUNTIME_MIGRATION_UNSAFE: ${to}`);
    if (targetStat.isDirectory() && sourceStat.isDirectory()) {
      mergeDirectory(from, to);
      if (fs.readdirSync(from).length === 0) fs.rmdirSync(from);
      continue;
    }
    if (targetStat.isFile() && sourceStat.isFile() && fs.readFileSync(from).equals(fs.readFileSync(to))) {
      fs.unlinkSync(from);
      continue;
    }
    fs.renameSync(from, `${to}.legacy-${Date.now()}-${process.pid}`);
  }
}
