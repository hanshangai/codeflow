import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { SkillInstallType, SkillSuiteInfo, SkillSuiteTargetStatus } from "@codeflowai/shared";

import { findSkillsTarget, SKILLS_TARGETS } from "./skillsTargets.js";

// ── 类型 ────────────────────────────────────────────────────────────

type CommunityInstallState = {
  suiteId: string;
  installedAt: number;
  /** 安装到 skillsRoot 下的技能文件夹名列表 */
  entries: string[];
  suite?: SkillSuiteInfo;
};

// ── 常量 ────────────────────────────────────────────────────────────

const COMMUNITY_STATE_DIR = "_community";

function stateFilePath(skillsRoot: string, suiteId: string): string {
  return path.join(skillsRoot, COMMUNITY_STATE_DIR, `${suiteId}.json`);
}

// ── 状态读写 ─────────────────────────────────────────────────────────

function readState(skillsRoot: string, suiteId: string): CommunityInstallState | null {
  const p = stateFilePath(skillsRoot, suiteId);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as any;
    if (!raw || raw.suiteId !== suiteId || !Array.isArray(raw.entries)) return null;
    return raw as CommunityInstallState;
  } catch {
    return null;
  }
}

function writeState(skillsRoot: string, state: CommunityInstallState): void {
  const dir = path.join(skillsRoot, COMMUNITY_STATE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(skillsRoot, state.suiteId), JSON.stringify(state, null, 2), "utf8");
}

function removeStateFile(skillsRoot: string, suiteId: string): void {
  try {
    fs.unlinkSync(stateFilePath(skillsRoot, suiteId));
  } catch {
    // ignore
  }
}

/** 规整 Skills 套件定义，按安装类型校验来源字段并保留来源信息用于状态回读。 */
export function normalizeSkillSuiteInfo(input: Partial<SkillSuiteInfo> | null | undefined): SkillSuiteInfo | null {
  const suiteId = String(input?.suiteId ?? "").trim();
  const name = String(input?.name ?? "").trim();
  if (!suiteId || !name) return null;
  const installType: SkillInstallType = input?.installType === "git" || input?.installType === "local" || input?.installType === "url"
    ? input.installType
    : "github";
  const sourceField = installType === "github"
    ? String(input?.repoUrl ?? "").trim()
    : installType === "git"
      ? String(input?.gitUrl ?? "").trim()
      : installType === "local"
        ? String(input?.localPath ?? "").trim()
        : String(input?.archiveUrl ?? "").trim();
  if (!sourceField) return null;
  return {
    suiteId,
    name,
    description: String(input?.description ?? "").trim(),
    author: String(input?.author ?? "").trim() || "自定义",
    homepage: String(input?.homepage ?? "").trim() || null,
    kind: "external",
    mcpDeps: Array.isArray(input?.mcpDeps)
      ? input.mcpDeps.map((item) => String(item ?? "").trim()).filter(Boolean)
      : undefined,
    repoUrl: String(input?.repoUrl ?? "").trim() || undefined,
    skillsPath: String(input?.skillsPath ?? "").trim() || undefined,
    source: input?.source === "custom" ? "custom" : "builtin",
    installType,
    gitUrl: String(input?.gitUrl ?? "").trim() || undefined,
    localPath: String(input?.localPath ?? "").trim() || undefined,
    archiveUrl: String(input?.archiveUrl ?? "").trim() || undefined,
  };
}

/** 枚举某个 target 下的技能安装状态文件，供自定义套件恢复列表使用。 */
function listStateFiles(skillsRoot: string): CommunityInstallState[] {
  const stateDir = path.join(skillsRoot, COMMUNITY_STATE_DIR);
  try {
    if (!fs.existsSync(stateDir)) return [];
    return fs.readdirSync(stateDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const raw = JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf8")) as CommunityInstallState;
        return raw;
      })
      .filter((state) => Boolean(state?.suiteId) && Array.isArray(state?.entries));
  } catch {
    return [];
  }
}

// ── 辅助 ─────────────────────────────────────────────────────────────

/** 递归查找所有包含 SKILL.md 的目录（返回相对于 searchRoot 的路径）。 */
function findSkillDirs(searchRoot: string): string[] {
  const results: string[] = [];

  function walk(dir: string, rel: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // 检查当前目录是否包含 SKILL.md（不区分大小写）
    const hasSkillMd = entries.some(
      (e) => e.isFile() && e.name.toLowerCase() === "skill.md",
    );
    if (hasSkillMd) {
      results.push(rel);
      return; // 找到 SKILL.md 后不再递归子目录（skill 是原子的）
    }

    // 递归子目录（跳过隐藏目录和 node_modules）
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  }

  walk(searchRoot, "");
  return results;
}

/** 从 GitHub 下载仓库 tarball 并解压到指定目录。 */
async function downloadAndExtractRepo(repoUrl: string, destDir: string): Promise<string> {
  // 解析 owner/repo
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`无法解析 GitHub 仓库 URL：${repoUrl}`);
  const owner = match[1];
  const repo = match[2]!.replace(/\.git$/, "");

  const tarballUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/main.tar.gz`;

  // 下载
  const resp = await fetch(tarballUrl, { signal: AbortSignal.timeout(5 * 60_000) }).catch((e) => {
    throw new Error(`下载失败（${tarballUrl}）：${e instanceof Error ? e.message : String(e)}`);
  });
  if (!resp.ok) {
    // 尝试 master 分支
    const masterUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.tar.gz`;
    const resp2 = await fetch(masterUrl, { signal: AbortSignal.timeout(5 * 60_000) }).catch((e) => {
      throw new Error(`下载失败（${masterUrl}）：${e instanceof Error ? e.message : String(e)}`);
    });
    if (!resp2.ok) {
      throw new Error(`GitHub 仓库下载失败：${resp.status}（已尝试 main 和 master 分支）`);
    }
    return await extractTarball(resp2, destDir);
  }
  return await extractTarball(resp, destDir);
}

async function extractTarball(resp: Response, destDir: string): Promise<string> {
  if (!resp.body) throw new Error("下载失败：无响应体");

  const archivePath = path.join(destDir, "repo.tar.gz");
  fs.mkdirSync(destDir, { recursive: true });

  // 写入文件
  const arrayBuf = await resp.arrayBuffer();
  fs.writeFileSync(archivePath, Buffer.from(arrayBuf));

  // 解压
  const extractDir = path.join(destDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const p = spawn(tarBinary(), ["-xzf", archivePath, "-C", extractDir], { stdio: "ignore", windowsHide: true });
    p.on("error", (e) => reject(e));
    p.on("exit", (code) => {
      if (code === 0 || hasExtractedContent(extractDir)) resolve();
      else reject(new Error(`tar 解压失败：exit=${code ?? -1}`));
    });
  });

  // tarball 通常会解压到 <repo>-<branch>/ 子目录
  const topEntries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (topEntries.length === 1 && topEntries[0]!.isDirectory()) {
    return path.join(extractDir, topEntries[0]!.name);
  }
  return extractDir;
}

/** 判断解压目录是否已有内容，用于忽略 Windows 上 tar 解压 symlink 失败的软错误。 */
function hasExtractedContent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** 解析 tar 可执行文件：Windows 上优先 System32 的 bsdtar，避免 Git 自带 GNU tar 通过 spawn 解压 gzip 失败。 */
function tarBinary(): string {
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const systemTar = path.join(systemRoot, "System32", "tar.exe");
  return fs.existsSync(systemTar) ? systemTar : "tar";
}

type CommandResult = { ok: true } | { ok: false; notFound: boolean; message: string };

/** 运行外部命令；命令不存在或非零退出时不抛异常，由调用方决定错误语义。 */
function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const p = spawn(command, args, { stdio: "ignore", windowsHide: true });
    p.on("error", (e) => resolve({ ok: false, notFound: (e as NodeJS.ErrnoException).code === "ENOENT", message: e instanceof Error ? e.message : String(e) }));
    p.on("exit", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, notFound: false, message: `${command} 退出码 ${code ?? -1}` });
    });
  });
}

/** git 类型：克隆仓库默认分支到临时目录，返回克隆根目录。 */
async function cloneGitRepo(gitUrl: string, destDir: string): Promise<string> {
  const cloneDir = path.join(destDir, "repo");
  const result = await runCommand("git", ["clone", gitUrl, cloneDir]);
  if (result.ok) return cloneDir;
  if (result.notFound) throw new Error("未找到 git，无法克隆仓库；请先安装 git");
  throw new Error(`git clone 失败：${result.message}`);
}

/** local 类型：解析本机目录（支持 ~ 与相对路径），返回绝对路径。 */
function resolveLocalPath(localPath: string): string {
  const isHomePath = localPath === "~" || localPath.startsWith("~/") || localPath.startsWith("~\\");
  const expanded = isHomePath
    ? path.join(os.homedir(), localPath.slice(1))
    : localPath;
  return path.resolve(expanded);
}

/** url 类型：下载压缩包并按 zip/tar/tgz 自动探测解压，返回解压根目录。 */
async function downloadAndExtractArchive(archiveUrl: string, destDir: string): Promise<string> {
  const resp = await fetch(archiveUrl, { signal: AbortSignal.timeout(5 * 60_000) }).catch((e) => {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new Error(`下载超时：${archiveUrl}`);
    throw new Error(`下载失败（${archiveUrl}）：${e instanceof Error ? e.message : String(e)}`);
  });
  if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
  const arrayBuf = await resp.arrayBuffer();
  if (!arrayBuf.byteLength) throw new Error("下载失败：响应为空");

  const bytes = Buffer.from(arrayBuf);
  const kind = detectArchiveKind(bytes);
  const archivePath = path.join(destDir, kind === "zip" ? "archive.zip" : "archive.tar");
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(archivePath, bytes);

  const extractDir = path.join(destDir, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  await extractArchive(archivePath, extractDir, kind);

  const topEntries = fs.readdirSync(extractDir, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
  if (topEntries.length === 1 && topEntries[0]!.isDirectory()) {
    return path.join(extractDir, topEntries[0]!.name);
  }
  return extractDir;
}

/** 通过魔数探测压缩包类型：zip（PK）或 tar/tgz。 */
function detectArchiveKind(bytes: Buffer): "zip" | "tar" {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "zip";
  return "tar";
}

/** 解压压缩包；zip 优先 unzip、缺失时回退 bsdtar，tar/tgz 用 tar 自动解压。 */
async function extractArchive(archivePath: string, extractDir: string, kind: "zip" | "tar"): Promise<void> {
  if (kind === "zip") {
    const unzip = await runCommand("unzip", ["-o", "-q", archivePath, "-d", extractDir]);
    if (unzip.ok) return;
    if (!unzip.notFound) throw new Error(`解压 zip 失败：${unzip.message}`);
    const tarZip = await runCommand(tarBinary(), ["-xf", archivePath, "-C", extractDir]);
    if (tarZip.ok) return;
    throw new Error(`解压 zip 失败：需要 unzip 或支持 zip 的 tar（${tarZip.message}）`);
  }
  const tar = await runCommand(tarBinary(), ["-xaf", archivePath, "-C", extractDir]);
  if (tar.ok) return;
  if (tar.notFound) throw new Error("未找到 tar，无法解压压缩包");
  if (hasExtractedContent(extractDir)) return;
  throw new Error(`解压失败：${tar.message}`);
}

/** 按安装类型解析套件来源根目录（含 skillsPath 子路径）。 */
async function resolveSourceRoot(suite: SkillSuiteInfo, tmpRoot: string): Promise<string> {
  const type = suite.installType ?? "github";
  const skillsPath = suite.skillsPath?.trim() || undefined;
  let repoRoot: string;
  if (type === "local") {
    if (!suite.localPath) throw new Error("local 安装类型缺少 localPath");
    return resolveLocalPath(suite.localPath);
  }
  if (type === "git") {
    if (!suite.gitUrl) throw new Error("git 安装类型缺少 gitUrl");
    repoRoot = await cloneGitRepo(suite.gitUrl, tmpRoot);
  } else if (type === "url") {
    if (!suite.archiveUrl) throw new Error("url 安装类型缺少 archiveUrl");
    repoRoot = await downloadAndExtractArchive(suite.archiveUrl, tmpRoot);
  } else {
    if (!suite.repoUrl) throw new Error("github 安装类型缺少 repoUrl");
    repoRoot = await downloadAndExtractRepo(suite.repoUrl, tmpRoot);
  }
  return skillsPath ? path.join(repoRoot, skillsPath) : repoRoot;
}

// ── 公开 API ─────────────────────────────────────────────────────────

/**
 * 获取社区套件在各 target 上的安装状态。
 */
export function getCommunitySkillsStatus(
  suite: SkillSuiteInfo,
  workspacePath: string,
): SkillSuiteTargetStatus[] {
  const results: SkillSuiteTargetStatus[] = [];
  for (const t of SKILLS_TARGETS) {
    const skillsRoot = path.resolve(t.resolveSkillsRoot(workspacePath));
    const state = readState(skillsRoot, suite.suiteId);
    results.push({
      suiteId: suite.suiteId,
      targetId: t.targetId,
      label: t.label,
      skillsRoot,
      installed: state
        ? { installedAt: state.installedAt, source: "community" as const }
        : null,
      ready: state !== null && state.entries.length > 0,
      message: state ? `${state.entries.length} 项技能已安装` : "未安装",
    });
  }
  return results;
}

/** 汇总当前工作区中已经安装过的自定义 Skills 套件。 */
export function listInstalledCustomSkillSuites(workspacePath: string): SkillSuiteInfo[] {
  const suites = new Map<string, SkillSuiteInfo>();
  for (const target of SKILLS_TARGETS) {
    const skillsRoot = path.resolve(target.resolveSkillsRoot(workspacePath));
    for (const state of listStateFiles(skillsRoot)) {
      const suite = normalizeSkillSuiteInfo(state.suite ?? null);
      if (!suite || suite.source !== "custom") continue;
      suites.set(suite.suiteId, suite);
    }
  }
  return [...suites.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

/**
 * 从 GitHub 下载并安装社区技能套件到指定 targets。
 */
export async function installCommunitySkills(args: {
  suite: SkillSuiteInfo;
  workspacePath: string;
  targets: string[];
}): Promise<{ targetId: string; ok: boolean; message?: string }[]> {
  const normalizedSuite = normalizeSkillSuiteInfo(args.suite);
  const { workspacePath, targets } = args;
  const results: { targetId: string; ok: boolean; message?: string }[] = [];

  if (!normalizedSuite) {
    for (const targetId of targets) results.push({ targetId, ok: false, message: "套件定义不完整：缺少 suiteId/name 或对应安装来源" });
    return results;
  }

  // 下载到临时目录
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), `codeflowai-community-${normalizedSuite.suiteId}-`));

  try {
    const searchRoot = await resolveSourceRoot(normalizedSuite, tmpRoot);

    if (!fs.existsSync(searchRoot)) {
      for (const t of targets) results.push({ targetId: t, ok: false, message: `安装源路径不存在：${normalizedSuite.skillsPath ?? "."}` });
      return results;
    }

    // 查找所有 skill 目录
    const skillDirs = findSkillDirs(searchRoot);
    if (!skillDirs.length) {
      for (const t of targets) results.push({ targetId: t, ok: false, message: "仓库中未找到包含 SKILL.md 的目录" });
      return results;
    }

    // 逐 target 安装
    for (const targetId of targets) {
      const target = findSkillsTarget(targetId);
      if (!target) {
        results.push({ targetId, ok: false, message: `不支持的安装目标：${targetId}` });
        continue;
      }

      const skillsRoot = path.resolve(target.resolveSkillsRoot(workspacePath));

      try {
        // 先清理旧安装
        const prevState = readState(skillsRoot, normalizedSuite.suiteId);
        if (prevState) {
          for (const entry of prevState.entries) {
            if (!entry || entry === "." || entry === "..") continue;
            const entryPath = path.join(skillsRoot, entry);
            await fs.promises.rm(entryPath, { recursive: true, force: true });
          }
        }

        // 复制 skill 目录
        const installedEntries: string[] = [];
        for (const relDir of skillDirs) {
          const src = path.join(searchRoot, relDir);
          // 使用 skill 文件夹名（最后一段路径）作为安装目录名；来源本身即单技能目录时回退为来源目录名
          const folderName = relDir ? (relDir.includes("/") ? relDir.split("/").pop()! : relDir) : path.basename(searchRoot);
          const dest = path.join(skillsRoot, folderName);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          await fs.promises.cp(src, dest, { recursive: true, force: true });
          installedEntries.push(folderName);
        }

        // 写入安装状态
        writeState(skillsRoot, {
          suiteId: normalizedSuite.suiteId,
          installedAt: Date.now(),
          entries: installedEntries,
          suite: normalizedSuite,
        });

        results.push({ targetId, ok: true, message: `已安装 ${installedEntries.length} 项技能` });
      } catch (e) {
        results.push({ targetId, ok: false, message: e instanceof Error ? e.message : String(e) });
      }
    }
  } catch (e) {
    // 下载/解压失败
    const msg = e instanceof Error ? e.message : String(e);
    for (const t of targets) results.push({ targetId: t, ok: false, message: msg });
  } finally {
    try {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return results;
}

/**
 * 卸载社区技能套件。
 */
export async function uninstallCommunitySkills(args: {
  suiteId: string;
  workspacePath: string;
  targets: string[];
}): Promise<{ targetId: string; ok: boolean; message?: string }[]> {
  const { suiteId, workspacePath, targets } = args;
  const results: { targetId: string; ok: boolean; message?: string }[] = [];

  for (const targetId of targets) {
    const target = findSkillsTarget(targetId);
    if (!target) {
      results.push({ targetId, ok: false, message: `不支持的安装目标：${targetId}` });
      continue;
    }

    const skillsRoot = path.resolve(target.resolveSkillsRoot(workspacePath));
    const state = readState(skillsRoot, suiteId);
    if (!state) {
      results.push({ targetId, ok: true, message: "未安装" });
      continue;
    }

    try {
      for (const entry of state.entries) {
        if (!entry || entry === "." || entry === "..") continue;
        const entryPath = path.join(skillsRoot, entry);
        await fs.promises.rm(entryPath, { recursive: true, force: true });
      }
      removeStateFile(skillsRoot, suiteId);
      results.push({ targetId, ok: true });
    } catch (e) {
      results.push({ targetId, ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return results;
}


