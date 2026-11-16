import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

import { KNOWLEDGE_ASSETS_ROOT, type CodeflowaiConfig } from "@codeflowai/shared";
import { logger } from "../logger.js";
import {
  normalizeOptionalWorkspacePathIndexMaxEntries,
  normalizeWorkspacePathIndexMaxEntries,
} from "../fs/workspacePathIndexConfig.js";
import {
  ensureWorkspaceCodeflowaiDirectory,
  inspectExistingWorkspaceCodeflowaiDirectory,
  inspectWorkspaceCodeflowaiFile,
  LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY,
  cleanupLegacyWorkspaceCodeflowaiDirectory,
  readWorkspaceCodeflowaiFile,
  WorkspaceCodeflowaiDirectoryError,
  writeWorkspaceCodeflowaiFile,
} from "./workspaceCodeflowaiDirectory.js";

const DOCS_MIGRATION_FILE = "docs-root-migration.json";
const KNOWLEDGE_DIRECTORY_NAME = path.posix.basename(KNOWLEDGE_ASSETS_ROOT);
const LEGACY_KNOWLEDGE_DIRECTORY_NAME = "知识库";

/** 默认 CodeFlowAI 配置（首次创建 `<workspace>/codeflowai/codeflowai.json` 使用）。 */
export function defaultCodeflowaiConfig(): CodeflowaiConfig {
  return {
    paths: { workflowDocsRoot: "codeflow-docs" },
    fileIndex: { maxEntries: null },
    workflow: {
      dirs: {
        prd: { dirName: "需求分析" },
        ui: { dirName: "原型设计" },
        arc: { dirName: "架构设计" },
        design: { dirName: "设计卡" },
        dev: { dirName: "任务与开发" },
        test: { dirName: "集成测试" },
      },
    },
  };
}

/** codeflowai.json 路径：`<workspace>/.codeflowai/codeflowai.json`（唯一配置源）。 */
export function codeflowaiConfigPath(workspacePath: string): string {
  const ws = path.resolve(String(workspacePath ?? "").trim());
  return path.join(ws, ".codeflowai", "codeflowai.json");
}

/** 确保 `<workspace>/.codeflowai/codeflowai.json` 存在；首次迁移历史配置或创建默认配置。 */
export function ensureCodeflowaiConfig(workspacePath: string): { path: string; config: CodeflowaiConfig } {
  const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
  const configFileName = "codeflowai.json";
  const configPath = path.join(directory.directoryPath, configFileName);
  if (!inspectWorkspaceCodeflowaiFile(directory, configFileName)) {
    const legacy = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath, LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY);
    const legacyConfig = legacy && inspectWorkspaceCodeflowaiFile(legacy, configFileName);
    // 历史 `codeflowai/` 配置只复制到新目录，旧文件保留，避免迁移失败丢配置。
    const content = legacyConfig
      ? readWorkspaceCodeflowaiFile(legacy!, configFileName)
      : JSON.stringify(defaultCodeflowaiConfig(), null, 2);
    writeWorkspaceCodeflowaiFile(directory, configFileName, content, { onlyIfMissing: true });
  }
  const raw = ((): CodeflowaiConfig => {
    try {
      return readJsonFile<CodeflowaiConfig>(readWorkspaceCodeflowaiFile(directory, configFileName), configPath);
    } catch (err) {
      // 自愈：配置文件被写坏/清零时（比如出现大量 \u0000），备份后重建默认配置，避免 client 直接崩溃。
      // 注意：这里不吞异常；如果重建也失败，会把原始错误带上抛出，便于定位。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFileName = `${configFileName}.bad.${stamp}`;
      try {
        const damaged = readWorkspaceCodeflowaiFile(directory, configFileName);
        writeWorkspaceCodeflowaiFile(directory, backupFileName, damaged, { onlyIfMissing: true });
      } catch (backupError) {
        if (backupError instanceof WorkspaceCodeflowaiDirectoryError) throw backupError;
        // 备份失败不覆盖原始解析错误；重建失败时会同时返回两段根因。
      }
      try {
        writeWorkspaceCodeflowaiFile(directory, configFileName, JSON.stringify(defaultCodeflowaiConfig(), null, 2));
        return readJsonFile<CodeflowaiConfig>(readWorkspaceCodeflowaiFile(directory, configFileName), configPath);
      } catch (err2) {
        const msg1 = err instanceof Error ? err.message : String(err);
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        throw new Error(`自愈重建 codeflowai.json 失败：${configPath}（原始错误：${msg1}；重建错误：${msg2}）`);
      }
    }
  })();
  const normalized = normalizeCodeflowaiConfig(raw);
  // 自愈：补齐新增字段，避免配置缺失导致 client 启动失败。
  writeJsonFileIfChanged(directory, configFileName, raw, normalized);
  // 配置已完整复制到新目录后清理旧 control 目录；未知文件保留。
  cleanupLegacyWorkspaceCodeflowaiDirectory(workspacePath, error => logger.warn("codeflowai-config", "legacy control directory cleanup deferred", {
    code: "workspace_legacy_control_directory_cleanup_deferred",
    workspacePath,
    rootCause: (error as NodeJS.ErrnoException | null)?.code ?? "unknown",
  }));
  return { path: configPath, config: normalized };
}

/** 只读打开现有配置；新目录优先，历史 `codeflowai/` 回退读取，且不会创建或自愈任何文件。 */
export function readExistingCodeflowaiConfig(workspacePath: string): { path: string; config: CodeflowaiConfig } | null {
  const configFileName = "codeflowai.json";
  const readFrom = (directoryName?: "codeflowai") => {
    const directory = directoryName
      ? inspectExistingWorkspaceCodeflowaiDirectory(workspacePath, directoryName)
      : inspectExistingWorkspaceCodeflowaiDirectory(workspacePath);
    if (!directory || !inspectWorkspaceCodeflowaiFile(directory, configFileName)) return null;
    const configPath = path.join(directory.directoryPath, configFileName);
    const raw = readJsonFile<CodeflowaiConfig>(readWorkspaceCodeflowaiFile(directory, configFileName), configPath);
    return { path: configPath, config: normalizeCodeflowaiConfig(raw) };
  };
  return readFrom() ?? readFrom(LEGACY_WORKSPACE_CODEFLOWAI_DIRECTORY);
}

/** 文档根迁移识别新旧知识目录，沿用真实路径口径并兼容 Windows 短路径。 */
export function workflowDocsRootMigration(workspacePath: string, input: CodeflowaiConfig): { from: string; to: string } | null {
  const pending = readDocsRootMigration(workspacePath);
  if (pending) return pending;
  const workspaceRoot = fs.realpathSync.native(workspacePath);
  const current = readExistingCodeflowaiConfig(workspacePath)?.config ?? defaultCodeflowaiConfig();
  const next = normalizeCodeflowaiConfig(input);
  let from = resolveWorkflowDocsRoot(workspaceRoot, current);
  const to = resolveWorkflowDocsRoot(workspaceRoot, next);
  const legacy = resolveWorkflowDocsRoot(workspaceRoot, defaultCodeflowaiConfig());
  // 文档根改名须识别两种库名，不能遗漏旧项目或新建项目。
  const hasKnowledge = (root: string) => [KNOWLEDGE_DIRECTORY_NAME, LEGACY_KNOWLEDGE_DIRECTORY_NAME].some(name => fs.existsSync(path.join(root, name)));
  if (path.relative(from, legacy) !== "" && hasKnowledge(legacy)) {
    if (hasKnowledge(from)) throw new Error("配置目录和默认目录中存在两套知识库，请先确认并整理，避免读取或覆盖错误的数据");
    if (fs.existsSync(from)) throw new Error("配置目录与旧知识库目录同时存在，请先整理文档，避免覆盖已有文件");
    from = legacy;
  }
  return path.relative(from, to) === "" ? null : { from, to };
}

/** 新库默认使用规格知识库，已有旧目录保持可读；两套目录并存时显式阻断。 */
export function resolveKnowledgeAssetsRoot(workspacePath: string): string {
  if (readDocsRootMigration(workspacePath)) throw new Error("上次文档目录迁移尚未完成，请在项目配置中重新保存目录设置以恢复；知识写入已阻止");
  const config = readExistingCodeflowaiConfig(workspacePath)?.config ?? defaultCodeflowaiConfig();
  const docsRoot = resolveWorkflowDocsRoot(workspacePath, config);
  if (workflowDocsRootMigration(workspacePath, config)) throw new Error("知识库仍在旧文档目录，请在项目配置中保存目录设置以完成迁移");
  const existing = [KNOWLEDGE_DIRECTORY_NAME, LEGACY_KNOWLEDGE_DIRECTORY_NAME].filter(name => fs.existsSync(path.join(docsRoot, name)));
  if (existing.length > 1) throw new Error("规格知识库与旧知识库目录同时存在，请先确认并整理，避免读取或覆盖错误的数据");
  return `${path.relative(path.resolve(workspacePath), docsRoot).split(path.sep).join("/")}/${existing[0] ?? KNOWLEDGE_DIRECTORY_NAME}`;
}

/** 同步迁移完整文档根后原子切换配置；切换失败恢复旧目录，禁止覆盖现有目标。 */
export function writeCodeflowaiConfig(workspacePath: string, input: CodeflowaiConfig): { path: string; config: CodeflowaiConfig } {
  const normalized = normalizeCodeflowaiConfig(input);
  recoverDocsRootMigration(workspacePath);
  const migration = workflowDocsRootMigration(workspacePath, normalized);
  const directory = ensureWorkspaceCodeflowaiDirectory(workspacePath);
  const configFileName = "codeflowai.json";
  const configPath = path.join(directory.directoryPath, configFileName);
  const temporaryName = `codeflowai.${crypto.randomUUID()}.tmp`;
  const temporaryPath = path.join(directory.directoryPath, temporaryName);
  const migrationPath = path.join(directory.directoryPath, DOCS_MIGRATION_FILE);
  let moved = false;
  let prepared = false;
  try {
    if (migration) {
      assertDocsMigrationPath(directory.workspaceRoot, migration.from);
      assertDocsMigrationPath(directory.workspaceRoot, migration.to);
      const relative = path.relative(migration.from, migration.to);
      const reverse = path.relative(migration.to, migration.from);
      if (!relative.startsWith(`..${path.sep}`) || !reverse.startsWith(`..${path.sep}`)) throw new Error("文档根目录不能相互嵌套");
      if (fs.existsSync(migration.to)) throw new Error("目标文档目录已存在，请选择不存在的目录，避免覆盖已有文件");
      if (fs.existsSync(migration.from)) {
        if (!fs.statSync(migration.from).isDirectory()) throw new Error("原文档根不是目录，无法迁移");
        fs.mkdirSync(path.dirname(migration.to), { recursive: true });
        const record = writeWorkspaceCodeflowaiFile(directory, DOCS_MIGRATION_FILE, JSON.stringify(migration), { onlyIfMissing: true });
        if (!record.created) throw new Error("工作区已有文档迁移记录，请重新读取配置后重试");
        prepared = true;
        fs.renameSync(migration.from, migration.to);
        moved = true;
      }
    }
    writeWorkspaceCodeflowaiFile(directory, temporaryName, JSON.stringify(normalized, null, 2), { onlyIfMissing: true });
    inspectWorkspaceCodeflowaiFile(directory, configFileName);
    fs.renameSync(temporaryPath, configPath);
  } catch (error) {
    if (moved && migration) {
      try { fs.renameSync(migration.to, migration.from); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], `配置切换及目录恢复失败，文档保留在 ${migration.to}；请解除文件占用后重新保存配置以恢复`); }
    }
    if (prepared) fs.unlinkSync(migrationPath);
    throw error;
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  if (prepared) fs.unlinkSync(migrationPath);
  return { path: configPath, config: normalized };
}

/** 读取同一配置边界的未完成迁移记录，所有记录路径须重新通过工作区安全检查。 */
function readDocsRootMigration(workspacePath: string): { from: string; to: string } | null {
  const directory = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath);
  if (!directory || !inspectWorkspaceCodeflowaiFile(directory, DOCS_MIGRATION_FILE)) return null;
  const pending = readJsonFile<{ from: string; to: string }>(readWorkspaceCodeflowaiFile(directory, DOCS_MIGRATION_FILE), DOCS_MIGRATION_FILE);
  if (typeof pending?.from !== "string" || typeof pending.to !== "string" || !path.isAbsolute(pending.from) || !path.isAbsolute(pending.to)) throw new Error("文档迁移记录无效，请检查项目配置目录");
  assertDocsMigrationPath(directory.workspaceRoot, pending.from);
  assertDocsMigrationPath(directory.workspaceRoot, pending.to);
  if (path.relative(pending.from, pending.to) === "") throw new Error("文档迁移记录的起止目录相同");
  return pending;
}

/** 重试保存时按已提交配置恢复迁移；不合并、不覆盖任何目录，歧义状态明确失败。 */
function recoverDocsRootMigration(workspacePath: string): void {
  const pending = readDocsRootMigration(workspacePath);
  if (!pending) return;
  const config = readExistingCodeflowaiConfig(workspacePath)?.config ?? defaultCodeflowaiConfig();
  const configured = resolveWorkflowDocsRoot(fs.realpathSync(workspacePath), config);
  const fromExists = fs.existsSync(pending.from), toExists = fs.existsSync(pending.to);
  if ((fromExists && !fs.statSync(pending.from).isDirectory()) || (toExists && !fs.statSync(pending.to).isDirectory())) throw new Error("文档迁移记录指向非目录，未执行恢复");
  if (path.relative(configured, pending.from) === "" && fromExists !== toExists) {
    if (toExists) fs.renameSync(pending.to, pending.from);
  } else if (!(path.relative(configured, pending.to) === "" && toExists && !fromExists)) {
    throw new Error("文档迁移状态存在冲突，请检查原目录、目标目录与项目配置；未覆盖任何文件");
  }
  const directory = inspectExistingWorkspaceCodeflowaiDirectory(workspacePath)!;
  fs.unlinkSync(path.join(directory.directoryPath, DOCS_MIGRATION_FILE));
}

/** 迁移只接受工作区内的普通目录链，拒绝根目录、含私有运行目录的控制目录和符号链接。 */
function assertDocsMigrationPath(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("文档目录必须位于工作区内部");
  if (/^(?:codeflowai|\.codeflowai|\.codeflow|\.git|node_modules)$/i.test(relative.split(path.sep)[0]!)) throw new Error("文档目录不能使用项目控制目录");
  let cursor = workspaceRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error("文档迁移路径不能包含符号链接");
  }
}

/** 按当前配置解析文档根，兼容平台路径分隔符。 */
export function resolveWorkflowDocsRoot(workspacePath: string, config: CodeflowaiConfig): string {
  const ws = path.resolve(String(workspacePath ?? "").trim());
  const rel = String(config?.paths?.workflowDocsRoot ?? "").trim() || "codeflow-docs";
  return path.resolve(ws, rel.replace(/\\/g, "/"));
}

/** 解析工作区文件索引上限；未配置时使用 Client 级默认。 */
export function resolveWorkspaceFileIndexMaxEntries(config: CodeflowaiConfig, fallback: number): number {
  const configured = normalizeOptionalWorkspacePathIndexMaxEntries(config?.fileIndex?.maxEntries);
  return configured ?? normalizeWorkspacePathIndexMaxEntries(fallback);
}

/** 补齐已知配置并规范相对文档路径，拒绝含私有运行目录的控制目录和不安全名称。 */
function normalizeCodeflowaiConfig(input: CodeflowaiConfig): CodeflowaiConfig {
  const raw = (input && typeof input === "object" ? input : {}) as CodeflowaiConfig;
  const base = defaultCodeflowaiConfig();

  // 保留未知字段（KISS：仅对已知字段做“补齐 + 最小归一化”）。
  const cfg: CodeflowaiConfig & { execution?: unknown } = { ...raw };
  // execution 配置无运行时消费者，已废弃；旧文件中的残留字段在下次写回时清除。
  delete cfg.execution;
  cfg.paths = { ...(base.paths ?? {}), ...(raw.paths ?? {}) };
  cfg.fileIndex = { ...(base.fileIndex ?? {}), ...(raw.fileIndex ?? {}) };
  cfg.workflow = { ...(base.workflow ?? {}), ...(raw.workflow ?? {}) };
  cfg.workflow.dirs = { ...(base.workflow?.dirs ?? {}), ...(raw.workflow?.dirs ?? {}) };
  cfg.workflow.dirs.prd = { ...(base.workflow?.dirs?.prd ?? {}), ...(raw.workflow?.dirs?.prd ?? {}) };
  cfg.workflow.dirs.ui = { ...(base.workflow?.dirs?.ui ?? {}), ...(raw.workflow?.dirs?.ui ?? {}) };
  cfg.workflow.dirs.arc = { ...(base.workflow?.dirs?.arc ?? {}), ...(raw.workflow?.dirs?.arc ?? {}) };
  cfg.workflow.dirs.design = { ...(base.workflow?.dirs?.design ?? {}), ...(raw.workflow?.dirs?.design ?? {}) };
  cfg.workflow.dirs.dev = { ...(base.workflow?.dirs?.dev ?? {}), ...(raw.workflow?.dirs?.dev ?? {}) };
  cfg.workflow.dirs.test = { ...(base.workflow?.dirs?.test ?? {}), ...(raw.workflow?.dirs?.test ?? {}) };

  const workflowDocsRoot = String(cfg.paths?.workflowDocsRoot ?? "").trim();
  if (!workflowDocsRoot) {
    throw new Error("参数错误：paths.workflowDocsRoot 不能为空");
  }
  if (path.isAbsolute(workflowDocsRoot) || /^[a-zA-Z]:/.test(workflowDocsRoot)) {
    throw new Error("参数错误：paths.workflowDocsRoot 不允许绝对路径（必须相对 workspace）");
  }
  if (workflowDocsRoot.split(/[\\/]/).some((p) => p === "..")) {
    throw new Error("参数错误：paths.workflowDocsRoot 不允许包含 ..");
  }
  const normalizedRoot = path.posix.normalize(workflowDocsRoot.replace(/\\/g, "/")).replace(/\/$/, "");
  if (!normalizedRoot || normalizedRoot === "." || /^(?:codeflowai|\.codeflowai|\.codeflow|\.git|node_modules)(?:\/|$)/i.test(normalizedRoot)) throw new Error("参数错误：文档根不能使用工作区根或控制目录");
  if (normalizedRoot.split("/").some(part => /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error("参数错误：文档目录名称包含不支持的字符");
  cfg.paths.workflowDocsRoot = normalizedRoot;

  cfg.fileIndex.maxEntries = normalizeOptionalWorkspacePathIndexMaxEntries(cfg.fileIndex.maxEntries);

  cfg.workflow = cfg.workflow ?? {};
  cfg.workflow.dirs = cfg.workflow.dirs ?? {};
  cfg.workflow.dirs.prd = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.prd?.dirName, base.workflow?.dirs?.prd?.dirName) };
  cfg.workflow.dirs.ui = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.ui?.dirName, base.workflow?.dirs?.ui?.dirName) };
  cfg.workflow.dirs.arc = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.arc?.dirName, base.workflow?.dirs?.arc?.dirName) };
  cfg.workflow.dirs.design = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.design?.dirName, base.workflow?.dirs?.design?.dirName) };
  cfg.workflow.dirs.dev = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.dev?.dirName, base.workflow?.dirs?.dev?.dirName) };
  cfg.workflow.dirs.test = { dirName: normalizeWorkflowDirName(cfg.workflow.dirs.test?.dirName, base.workflow?.dirs?.test?.dirName) };

  return cfg;
}

/** 仅在对象内容变化时写回 JSON，避免查询配置时反复更新 mtime。 */
function writeJsonFileIfChanged(
  directory: ReturnType<typeof ensureWorkspaceCodeflowaiDirectory>,
  fileName: string,
  raw: CodeflowaiConfig,
  normalized: CodeflowaiConfig,
): void {
  if (JSON.stringify(raw, null, 2) === JSON.stringify(normalized, null, 2)) return;
  writeWorkspaceCodeflowaiFile(directory, fileName, JSON.stringify(normalized, null, 2));
}

function readJsonFile<T>(buf: Buffer, filePath: string): T {
  if (!buf.length) {
    throw new Error(`JSON 文件为空：${filePath}`);
  }
  // 典型坏文件：内容被“清零”导致全是 \u0000（Windows 下常见于异常写入/中断）。
  let allZero = true;
  for (const b of buf) {
    if (b !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    throw new Error(`JSON 文件已被清零（全为 0x00）：${filePath}`);
  }

  const raw = buf.toString("utf8").replace(/^\uFEFF/, "");
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`JSON 文件仅包含空白：${filePath}`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    throw new Error(`解析 JSON 失败：${filePath}（${e.message}）`);
  }
}

/** 归一化工作流阶段目录名（仅保留“阶段名”，不包含数字前缀）。 */
function normalizeWorkflowDirName(raw: unknown, fallback: unknown): string {
  const s = String(raw ?? "").trim() || String(fallback ?? "").trim();
  if (!s) throw new Error("参数错误：workflow.dirs.*.dirName 不能为空");
  // 兼容旧配置：允许写成 `1-需求分析`，统一归一为“阶段名”（不含数字前缀）。
  const noPrefix = s.replace(/^\d+\s*-\s*/, "").trim();
  if (!noPrefix) throw new Error("参数错误：workflow.dirs.*.dirName 不能为空");
  if (/[<>:"/\\|?*]/.test(noPrefix)) throw new Error(`参数错误：workflow.dirs.*.dirName 含非法字符：${noPrefix}`);
  return noPrefix;
}

