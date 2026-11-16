import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  SkillDefinition,
  SkillId,
  SkillPackageFile,
  SkillScriptEntrypoint,
  SkillTargetEngine,
  ToolDefinition,
  ToolRef,
  ToolsetDefinition,
  WorkspaceId,
} from "@codeflowai/shared";

import { findSkillsTarget, SKILLS_TARGETS } from "../skills/skillsTargets.js";
import { materializeSkillRuntimePackage, type SkillRuntimeMaterializationContext } from "./skillRuntimePackage.js";

export type SkillPackageInstallResult = {
  targetId: SkillTargetEngine;
  ok: boolean;
  skillsRoot: string;
  installedPath: string;
  message: string;
};

export type SkillPackageInstallStatus = {
  targetId: SkillTargetEngine;
  label: string;
  skillsRoot: string;
  installedPath: string;
  installed: boolean;
  ready: boolean;
  packageHash: string | null;
  message: string;
};

export type SkillPackageEnsureResult = {
  skillId: SkillId;
  skillName: string;
  skipped: boolean;
  results: SkillPackageInstallResult[];
  status: SkillPackageInstallStatus[];
};

export type BuiltinSkillPackageEnsureSummary = {
  installed: Array<{ skillId: string; skillName: string; targets: SkillTargetEngine[] }>;
  skipped: Array<{ skillId: string; skillName: string; targets: SkillTargetEngine[] }>;
};

export type BoundSkillPackageInstallResult = {
  skillId: SkillId;
  skillName: string;
  slug: string;
  packageHash: string | null;
  skipped: boolean;
  status: SkillPackageInstallStatus[];
};

type SkillInstallMetadata = { skillId?: string; packageHash?: string; targetId?: string };

const SKILL_PACKAGE_METADATA_FILE = ".codeflowai-skill.json";

export const SKILL_PACKAGE_INSTALL_TOOL_ID = "runtime.installSkillPackage";

/** 查询 Skill 包在 Codex/Claude 目标目录中的安装状态。 */
export function getSkillPackageInstallStatus(
  workspacePath: string,
  skill: SkillDefinition,
): SkillPackageInstallStatus[] {
  return SKILLS_TARGETS.map((target) => buildSkillPackageInstallStatus(workspacePath, skill, target.targetId));
}

/** 全包路径预检后安装到声明目标，写入完整 SKILL.md/scripts/references/assets 文件树。 */
export async function installSkillPackage(input: {
  workspacePath: string;
  skill: SkillDefinition;
  targets: SkillTargetEngine[];
}): Promise<SkillPackageInstallResult[]> {
  const results: SkillPackageInstallResult[] = [];
  for (const targetId of input.targets) {
    const target = findSkillsTarget(targetId);
    if (!target) continue;
    const skillsRoot = path.resolve(target.resolveSkillsRoot(input.workspacePath));
    const installedPath = path.join(skillsRoot, resolveSkillFolderName(input.skill));
    try {
      assertSkillPackagePaths(installedPath, input.skill);
      await fs.promises.rm(installedPath, { recursive: true, force: true });
      await writeSkillPackageDirectory(installedPath, input.skill);
      await fs.promises.writeFile(
        path.join(installedPath, SKILL_PACKAGE_METADATA_FILE),
        JSON.stringify({
          skillId: input.skill.id,
          skillName: input.skill.name,
          packageHash: input.skill.packageHash ?? hashSkillPackageFiles(input.skill.files ?? []),
          installedAt: Date.now(),
          targetId,
        }, null, 2),
        "utf8",
      );
      results.push({ targetId, ok: true, skillsRoot, installedPath, message: `已安装到 ${target.label}` });
    } catch (error) {
      results.push({
        targetId,
        ok: false,
        skillsRoot,
        installedPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** 幂等安装必需 Skill 包；已就绪目标保持不动，缺失或版本不一致时重写包目录。 */
export async function ensureSkillPackageInstalled(input: {
  workspacePath: string;
  skill: SkillDefinition;
  targets?: SkillTargetEngine[] | null;
}): Promise<SkillPackageEnsureResult> {
  const targets = resolveInstallTargets(input.skill, input.targets);
  const currentStatus = targets.map((targetId) => buildSkillPackageInstallStatus(input.workspacePath, input.skill, targetId));
  const staleTargets = currentStatus
    .filter((item) => !item.ready)
    .map((item) => item.targetId);
  if (!staleTargets.length) {
    return {
      skillId: input.skill.id,
      skillName: input.skill.name,
      skipped: true,
      results: [],
      status: currentStatus,
    };
  }

  const results = await installSkillPackage({
    workspacePath: input.workspacePath,
    skill: input.skill,
    targets: staleTargets,
  });
  const failed = results.filter((item) => !item.ok);
  if (failed.length) {
    throw new Error(`Skill 包自动安装失败：${failed.map((item) => `${item.targetId}:${item.message}`).join("；")}`);
  }
  return {
    skillId: input.skill.id,
    skillName: input.skill.name,
    skipped: false,
    results,
    status: targets.map((targetId) => buildSkillPackageInstallStatus(input.workspacePath, input.skill, targetId)),
  };
}

/** 安装当前角色已绑定的指定 Skill；目标目录始终取 Skill 自身声明。 */
export async function installBoundSkillPackage(input: {
  workspacePath: string;
  skills: SkillDefinition[];
  toolInput: unknown;
}): Promise<BoundSkillPackageInstallResult> {
  const slug = readSkillInstallSlug(input.toolInput);
  const matches = input.skills.filter((skill) => String(skill.slug ?? "").trim() === slug);
  if (!matches.length) {
    throw new Error(`当前节点未绑定 Skill：${slug}`);
  }
  if (matches.length > 1) {
    throw new Error(`当前节点存在重复 Skill slug，无法安全安装：${slug}`);
  }
  const skill = matches[0]!;
  const result = await ensureSkillPackageInstalled({
    workspacePath: input.workspacePath,
    skill,
  });
  return {
    skillId: result.skillId,
    skillName: result.skillName,
    slug,
    packageHash: skill.packageHash ?? null,
    skipped: result.skipped,
    status: result.status,
  };
}

/** 确保当前工作区标记为自动安装的内置 Skill 包已安装到声明目标。 */
export async function ensureBuiltinSkillPackagesInstalled(input: {
  workspacePath: string;
  skills: SkillDefinition[];
}): Promise<BuiltinSkillPackageEnsureSummary> {
  const summary: BuiltinSkillPackageEnsureSummary = { installed: [], skipped: [] };
  const builtinSkills = input.skills.filter((skill) => skill.kind === "builtin" && skill.autoInstall === true);
  for (const skill of builtinSkills) {
    const result = await ensureSkillPackageInstalled({
      workspacePath: input.workspacePath,
      skill,
    });
    const targets = result.status.map((item) => item.targetId);
    const row = { skillId: String(result.skillId), skillName: result.skillName, targets };
    if (result.skipped) summary.skipped.push(row);
    else summary.installed.push(row);
  }
  return summary;
}

/** 读取平台安装工具输入中的 Skill slug，并拒绝空值或额外协议猜测。 */
function readSkillInstallSlug(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Skill 安装工具输入必须是对象");
  }
  const slug = String((input as Record<string, unknown>).slug ?? "").trim();
  if (!slug) throw new Error("Skill 安装工具缺少 slug");
  return slug;
}

/** 从指定目标目录卸载 Skill 包。 */
export async function uninstallSkillPackage(input: {
  workspacePath: string;
  skill: SkillDefinition;
  targets: SkillTargetEngine[];
}): Promise<SkillPackageInstallResult[]> {
  const results: SkillPackageInstallResult[] = [];
  for (const targetId of input.targets) {
    const target = findSkillsTarget(targetId);
    if (!target) continue;
    const skillsRoot = path.resolve(target.resolveSkillsRoot(input.workspacePath));
    const installedPath = path.join(skillsRoot, resolveSkillFolderName(input.skill));
    try {
      const metadata = readInstallMetadata(installedPath);
      if (metadata && metadata.skillId !== input.skill.id) {
        throw new Error(`目标目录已被其他 Skill 占用：${installedPath}`);
      }
      await fs.promises.rm(installedPath, { recursive: true, force: true });
      results.push({ targetId, ok: true, skillsRoot, installedPath, message: "已卸载" });
    } catch (error) {
      results.push({
        targetId,
        ok: false,
        skillsRoot,
        installedPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** 解析 Skill 包安装目标，默认跟随定义中的 installTargets。 */
function resolveInstallTargets(
  skill: SkillDefinition,
  targets: SkillTargetEngine[] | null | undefined,
): SkillTargetEngine[] {
  const requested = Array.isArray(targets) && targets.length
    ? targets
    : (skill.installTargets?.length ? skill.installTargets : skill.targetEngines);
  const allowed = new Set(skill.targetEngines);
  const resolved = [...new Set(requested.map((item) => String(item ?? "").trim()))]
    .filter((item): item is SkillTargetEngine => (item === "codex" || item === "claude") && allowed.has(item as SkillTargetEngine));
  if (!resolved.length) throw new Error(`Skill「${skill.name}」没有可安装目标`);
  return resolved;
}

/** 查询单个目标目录的 Skill 包状态，供自动安装只检查声明目标。 */
function buildSkillPackageInstallStatus(
  workspacePath: string,
  skill: SkillDefinition,
  targetId: SkillTargetEngine,
): SkillPackageInstallStatus {
  const target = findSkillsTarget(targetId);
  if (!target) throw new Error(`未知 Skill 安装目标：${targetId}`);
  const skillsRoot = path.resolve(target.resolveSkillsRoot(workspacePath));
  const installedPath = path.join(skillsRoot, resolveSkillFolderName(skill));
  const metadata = readInstallMetadata(installedPath);
  const hasSkillMd = fs.existsSync(path.join(installedPath, "SKILL.md"));
  const installed = hasSkillMd && metadata?.skillId === skill.id;
  const expectedPackageHash = skill.packageHash ?? hashSkillPackageFiles(skill.files ?? []);
  const hashMatches = installed && metadata?.packageHash === expectedPackageHash;
  const contentIssue = hashMatches ? findInstalledPackageContentIssue(installedPath, skill) : null;
  return {
    targetId: target.targetId,
    label: target.label,
    skillsRoot,
    installedPath,
    installed,
    ready: installed && hashMatches && contentIssue == null,
    packageHash: metadata?.packageHash ?? null,
    message: !installed
      ? "未安装"
      : !hashMatches
        ? "已安装但版本不同"
        : contentIssue ?? "已安装",
  };
}

/** 校验安装目录中的包文件内容，避免仅凭可伪旧的 marker 误判 ready。 */
function findInstalledPackageContentIssue(installedPath: string, skill: SkillDefinition): string | null {
  const expectedFiles = skill.files?.length
    ? skill.files.map((file) => ({ relPath: file.relPath, sha256: file.sha256 }))
    : [{
        relPath: "SKILL.md",
        sha256: crypto.createHash("sha256").update(String(skill.skillMd ?? ""), "utf8").digest("hex"),
      }];
  for (const file of expectedFiles) {
    const absolutePath = resolvePackageFilePath(installedPath, file.relPath);
    try {
      const stat = fs.statSync(absolutePath);
      if (!stat.isFile()) return `已安装但包文件不是普通文件：${file.relPath}`;
      const actualHash = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
      if (actualHash.toLowerCase() !== String(file.sha256 ?? "").trim().toLowerCase()) {
        return `已安装但包文件内容不一致：${file.relPath}`;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return `已安装但缺少包文件：${file.relPath}`;
      }
      return `已安装但包文件不可读：${file.relPath}：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return null;
}

/** 将 Skill 脚本入口转换为编排运行时可审计的工具条目。 */
export function buildSkillScriptToolEntries(input: SkillRuntimeMaterializationContext & {
  workspacePath: string;
  workspaceId: WorkspaceId;
  skills: SkillDefinition[];
}): Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> {
  const entries: Array<{ toolset: ToolsetDefinition; tool: ToolDefinition; ref: ToolRef }> = [];
  for (const skill of input.skills) {
    const scripts = (skill.scripts ?? []).filter((script) => script.exposeAsTool);
    if (!scripts.length) continue;
    const materialized = materializeRuntimeSkillPackage(input.workspacePath, skill, input);
    const toolset: ToolsetDefinition = {
      id: (`skill-toolset:${skill.id}`) as any,
      workspaceId: input.workspaceId,
      name: `${skill.name} scripts`,
      description: `Skill「${skill.name}」声明的可调用脚本。`,
      tools: [],
      kind: "custom",
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
    const tools: ToolDefinition[] = [];
    for (const script of scripts) {
      const scriptFile = (skill.files ?? []).find((file) => file.relPath === script.scriptPath);
      if (!scriptFile?.contentText) {
        throw new Error(`Skill「${skill.name}」脚本缺少文本内容：${script.scriptPath}`);
      }
      const tool: ToolDefinition = {
        id: buildSkillToolId(skill, script) as any,
        name: script.name,
        description: script.description || `执行 Skill「${skill.name}」中的 ${script.scriptPath}`,
        runtime: script.runtime,
        invocationHint: `仅当 Skill「${skill.name}」触发且确实需要运行 ${script.scriptPath} 时调用。`,
        code: scriptFile.contentText,
        inputSchema: script.inputSchema ?? null,
        outputSchema: script.outputSchema ?? null,
        timeoutMs: script.timeoutMs ?? null,
        workingDirectory: materialized.workspaceRelativeDir,
        requiresWrite: Boolean(script.requiresWrite),
        envPolicy: { inheritWorkspaceEnv: true },
      };
      tools.push(tool);
    }
    toolset.tools = tools;
    for (const tool of tools) {
      const script = scripts.find((item) => buildSkillToolId(skill, item) === tool.id) ?? null;
      entries.push({
        toolset,
        tool,
        ref: {
          toolsetId: toolset.id,
          toolId: tool.id,
          alias: `${skill.name} / ${script?.name ?? tool.name}`,
          usageGuidance: script?.description ?? tool.description,
          required: false,
        },
      });
    }
  }
  return entries;
}

/** 沿原路径预检入口生成按身份及内容保留的运行副本。 */
function materializeRuntimeSkillPackage(workspacePath: string, skill: SkillDefinition, context: SkillRuntimeMaterializationContext): { workspaceRelativeDir: string } {
  const folder = resolveSkillFolderName(skill);
  assertSkillPackagePaths(path.resolve(workspacePath, ".codeflowai/skill-runtime", folder), skill);
  return { workspaceRelativeDir: materializeSkillRuntimePackage(workspacePath, folder, skill, context) };
}

/** 写入 Skill 包目录。 */
async function writeSkillPackageDirectory(targetDir: string, skill: SkillDefinition): Promise<void> {
  for (const file of skill.files ?? []) {
    const abs = resolvePackageFilePath(targetDir, file.relPath);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    if (file.contentText != null) {
      await fs.promises.writeFile(abs, file.contentText, "utf8");
    } else if (file.contentBase64 != null) {
      await fs.promises.writeFile(abs, Buffer.from(file.contentBase64, "base64"));
    }
  }
  if (!fs.existsSync(path.join(targetDir, "SKILL.md"))) {
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, "SKILL.md"), String(skill.skillMd ?? ""), "utf8");
  }
}

/** 文件必须为包内非空相对后代路径，拒绝主目录、绝对路径和 NUL。 */
function resolvePackageFilePath(targetDir: string, relPath: string): string {
  const abs = path.resolve(targetDir, relPath);
  const relative = path.relative(path.resolve(targetDir), abs);
  if (!relative || path.isAbsolute(relPath) || relPath.includes("\0") || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Skill 包文件路径越界：${relPath}`);
  }
  return abs;
}

/** 删除或复用旧包前检查全部路径和文件/目录冲突，保留原包及平台元数据。 */
function assertSkillPackagePaths(targetDir: string, skill: SkillDefinition): void {
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const paths = new Set<string>();
  for (const file of skill.files ?? []) {
    const relative = path.relative(targetDir, resolvePackageFilePath(targetDir, file.relPath));
    const key = caseInsensitive ? relative.toLowerCase() : relative;
    if (paths.has(key) || key === SKILL_PACKAGE_METADATA_FILE) {
      throw Object.assign(new Error(`Skill 包文件路径冲突：${file.relPath}`), { code: "SKILL_PACKAGE_PATH_INVALID", skillId: skill.id });
    }
    paths.add(key);
  }
  paths.add(caseInsensitive ? "skill.md" : "SKILL.md");
  paths.add(SKILL_PACKAGE_METADATA_FILE);
  for (const file of paths) {
    let parent = path.dirname(file);
    while (parent !== ".") {
      if (paths.has(parent)) {
        throw Object.assign(new Error(`Skill 包文件与目录冲突：${file}`), { code: "SKILL_PACKAGE_PATH_INVALID", skillId: skill.id });
      }
      parent = path.dirname(parent);
    }
  }
}

/** 读取安装元数据。 */
function readInstallMetadata(installedPath: string): SkillInstallMetadata | null {
  const metadataPath = path.join(installedPath, SKILL_PACKAGE_METADATA_FILE);
  if (!fs.existsSync(metadataPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as any;
    if (!raw || typeof raw !== "object") throw new Error("元数据不是对象");
    return raw && typeof raw === "object" ? raw : null;
  } catch (error) {
    throw new Error(`Skill 安装元数据读取失败：${metadataPath}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 解析包自身的直接子目录名；拒绝点路径及 Windows 会归一到其他目录的尾点。 */
function resolveSkillFolderName(skill: Pick<SkillDefinition, "slug" | "name" | "id">): string {
  const folder = sanitizeFolderName(skill.slug || skill.name || String(skill.id));
  if (folder.endsWith(".")) {
    throw Object.assign(new Error("Skill 包目录名不能以点结尾"), { code: "SKILL_PACKAGE_PATH_INVALID", skillId: skill.id });
  }
  return folder;
}

/** 文件夹名只保留跨平台安全字符。 */
function sanitizeFolderName(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "skill";
}

/** 生成 Skill 脚本工具 ID。 */
function buildSkillToolId(skill: Pick<SkillDefinition, "slug" | "id">, script: Pick<SkillScriptEntrypoint, "id">): string {
  return `skill.${sanitizeToolId(skill.slug || String(skill.id))}.${sanitizeToolId(script.id)}`;
}

/** 工具 ID 片段只保留 ASCII，避免 provider 工具名不兼容。 */
function sanitizeToolId(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "tool";
}

/** 没有 packageHash 时按文件哈希兜底。 */
function hashSkillPackageFiles(files: SkillPackageFile[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(files.map((file) => ({
    relPath: file.relPath,
    kind: file.kind,
    sha256: file.sha256,
  })))).digest("hex");
}
