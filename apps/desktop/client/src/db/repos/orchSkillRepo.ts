import crypto from "node:crypto";

import {
  normalizeOrchAssetDefinitionKind,
  type SkillDefinition,
  type SkillId,
  type SkillPackageFile,
  type SkillPackageFileKind,
  type SkillScriptEntrypoint,
  type SkillScriptRuntime,
  type SkillTargetEngine,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

type OrchSkillRow = {
  id: string;
  workspace_id: string;
  name: string | null;
  description: string | null;
  definition_json: string;
  created_at: number | null;
  updated_at: number | null;
};

type OrchSkillFileRow = {
  skill_id: string;
  rel_path: string;
  kind: string | null;
  content_text: string | null;
  content_base64: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  updated_at: number | null;
};

/** 编排 Skills 仓储。 */
export class OrchSkillRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 按工作区列出平台自定义 Skills，供资产库和运行时解析使用。 */
  listByWorkspace(workspaceId: WorkspaceId): SkillDefinition[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, definition_json, created_at, updated_at
         FROM orch_skills WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(String(workspaceId)) as OrchSkillRow[];
    const filesBySkillId = this.listFilesBySkillIds(rows.map((row) => row.id));
    return rows.map((row) => rowToSkill(row, filesBySkillId.get(row.id) ?? []));
  }

  /** 默认兼容旧 Skill；完整复制在规范化前校验原始包，禁止补文件掩盖损坏。 */
  get(id: SkillId, options?: { requireCompletePackage?: boolean }): SkillDefinition | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace_id, name, description, definition_json, created_at, updated_at
         FROM orch_skills WHERE id = ?`,
      )
      .get(String(id)) as OrchSkillRow | undefined;
    if (!row) return null;
    const files = this.listFiles(String(id), options?.requireCompletePackage);
    return options?.requireCompletePackage ? rowToCompleteSkill(row, files) : rowToSkill(row, files);
  }

  /** 新增或更新 Skill，并在仓储边界规范化资产 kind 与目标引擎。 */
  upsert(input: Omit<SkillDefinition, "createdAt" | "updatedAt">): SkillDefinition {
    return this.db.transaction(() => {
      const now = Date.now();
      const existing = input.id ? this.get(input.id) : null;
      const id = input.id || (crypto.randomUUID() as SkillId);
      const createdAt = existing?.createdAt ?? now;
      const normalizedInput = normalizeSkillInput(input, existing);
      const definitionForJson = stripSkillFilesForJson({ ...normalizedInput, id, createdAt, updatedAt: now });

      this.db
        .prepare(
          `INSERT INTO orch_skills (id, workspace_id, name, description, definition_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             definition_json = excluded.definition_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          id,
          String(normalizedInput.workspaceId),
          normalizedInput.name,
          normalizedInput.description,
          JSON.stringify(definitionForJson),
          createdAt,
          now,
        );
      this.replaceFiles(id, normalizedInput.files ?? [], now);

      return { ...normalizedInput, id, createdAt, updatedAt: now };
    })();
  }

  /** 删除 Skill；引用关系由角色保存时和运行时解析时校验。 */
  delete(id: SkillId): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM orch_skill_files WHERE skill_id = ?").run(String(id));
      this.db.prepare("DELETE FROM orch_skills WHERE id = ?").run(String(id));
    })();
  }

  /** 按 Skill ID 批量读取包文件，避免列表页 N+1 查询。 */
  private listFilesBySkillIds(skillIds: string[]): Map<string, SkillPackageFile[]> {
    const result = new Map<string, SkillPackageFile[]>();
    const ids = skillIds.map((id) => String(id ?? "").trim()).filter(Boolean);
    if (!ids.length) return result;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT skill_id, rel_path, kind, content_text, content_base64, content_type, size_bytes, sha256, updated_at
         FROM orch_skill_files WHERE skill_id IN (${placeholders}) ORDER BY rel_path ASC`,
      )
      .all(...ids) as OrchSkillFileRow[];
    for (const row of rows) {
      const list = result.get(row.skill_id) ?? [];
      list.push(rowToSkillFile(row));
      result.set(row.skill_id, list);
    }
    return result;
  }

  /** 严格读取保留持久化元数据；默认读取仍按原有兼容规则恢复。 */
  private listFiles(skillId: string, strict = false): SkillPackageFile[] {
    const rows = this.db
      .prepare(
        `SELECT skill_id, rel_path, kind, content_text, content_base64, content_type, size_bytes, sha256, updated_at
         FROM orch_skill_files WHERE skill_id = ? ORDER BY rel_path ASC`,
      )
      .all(skillId) as OrchSkillFileRow[];
    return strict ? rows.map(row => ({ relPath: row.rel_path, kind: row.kind as SkillPackageFileKind,
      contentText: row.content_text, contentBase64: row.content_base64, contentType: row.content_type,
      sizeBytes: row.size_bytes as number, sha256: row.sha256 as string })) : rows.map(rowToSkillFile);
  }

  /** 用规范化后的包文件替换当前 Skill 文件树。 */
  private replaceFiles(skillId: SkillId, files: SkillPackageFile[], updatedAt: number): void {
    this.db.prepare("DELETE FROM orch_skill_files WHERE skill_id = ?").run(String(skillId));
    const stmt = this.db.prepare(
      `INSERT INTO orch_skill_files (skill_id, rel_path, kind, content_text, content_base64, content_type, size_bytes, sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const file of files) {
      stmt.run(
        String(skillId),
        file.relPath,
        file.kind,
        file.contentText ?? null,
        file.contentBase64 ?? null,
        file.contentType ?? null,
        file.sizeBytes,
        file.sha256,
        updatedAt,
      );
    }
  }
}

/** 原始行与文件清单须一致，不能借旧读取的补齐、过滤或重算修复证据。 */
function rowToCompleteSkill(row: OrchSkillRow, files: SkillPackageFile[]): SkillDefinition {
  const parsed = JSON.parse(row.definition_json) as SkillDefinition;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed.id != null && parsed.id !== row.id) || (parsed.workspaceId != null && parsed.workspaceId !== row.workspace_id)) {
    throw new Error(`Skill 原始定义身份非法：${row.id}`);
  }
  if (!Array.isArray(parsed.files) || parsed.files.length !== files.length) throw new Error(`Skill 包文件清单不完整：${row.id}`);
  const actualFiles = new Map(files.map(file => [file.relPath, file]));
  const expectedPaths = new Set<string>();
  for (const expected of parsed.files) {
    const actual = actualFiles.get(expected.relPath);
    if (expectedPaths.has(expected.relPath) || !actual || expected.kind !== actual.kind || expected.sha256 !== actual.sha256
      || expected.sizeBytes !== actual.sizeBytes || expected.contentType !== actual.contentType) {
      throw new Error(`Skill 包文件清单不一致：${row.id}/${expected.relPath}`);
    }
    expectedPaths.add(expected.relPath);
  }
  const skill = { ...parsed, id: row.id as SkillId, workspaceId: row.workspace_id as WorkspaceId,
    createdAt: row.created_at as number, updatedAt: row.updated_at as number,
    files: [...files].sort((left, right) => left.relPath.localeCompare(right.relPath)) };
  assertCompleteSkillPackage(skill);
  return skill;
}

/** 完整本地包复用仓储路径及摘要口径；任何缺失、损坏或悬空脚本显式失败。 */
export function assertCompleteSkillPackage(skill: Omit<SkillDefinition, "id" | "workspaceId" | "createdAt" | "updatedAt">): void {
  if (!Array.isArray(skill.files) || !skill.files.length) throw new Error("Skill 包缺少文件");
  const paths = new Set<string>();
  for (const file of skill.files) {
    if (!file || typeof file.relPath !== "string" || normalizeSkillFilePath(file.relPath) !== file.relPath
      || normalizeSkillFileKind(file.kind, file.relPath) !== file.kind || paths.has(file.relPath.toLowerCase())) {
      throw new Error("Skill 包文件路径或类型非法");
    }
    paths.add(file.relPath.toLowerCase());
    const text = typeof file.contentText === "string";
    const binary = typeof file.contentBase64 === "string";
    if (text === binary || (text && file.contentBase64 != null) || (binary && file.contentText != null)
      || (binary && Buffer.from(file.contentBase64!, "base64").toString("base64") !== file.contentBase64)
      || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || typeof file.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(file.sha256) || typeof file.contentType !== "string" || !file.contentType) {
      throw new Error(`Skill 包文件元数据非法：${file.relPath}`);
    }
    const bytes = text ? Buffer.from(file.contentText!, "utf8") : Buffer.from(file.contentBase64!, "base64");
    if ((text && bytes.toString("utf8") !== file.contentText) || bytes.length !== file.sizeBytes
      || hashFileContent(file.contentText, file.contentBase64) !== file.sha256) {
      throw new Error(`Skill 包文件正文或摘要不一致：${file.relPath}`);
    }
  }
  const skillMd = skill.files.filter(file => file.relPath === "SKILL.md");
  if (skillMd.length !== 1 || skillMd[0]!.kind !== "skill-md" || typeof skillMd[0]!.contentText !== "string"
    || skillMd[0]!.contentText !== skill.skillMd) throw new Error("Skill 包缺少完整 SKILL.md");
  if (skill.scripts != null && !Array.isArray(skill.scripts)) throw new Error("Skill 脚本声明非法");
  for (const script of skill.scripts ?? []) {
    const file = skill.files.find(item => item.relPath === script?.scriptPath);
    if (!file || file.kind !== "script" || typeof file.contentText !== "string" || !file.contentText.length) {
      throw new Error(`Skill 脚本依赖不存在：${script?.scriptPath}`);
    }
  }
  if (typeof skill.packageHash !== "string" || skill.packageHash !== hashSkillPackage(skill)) throw new Error("Skill 包摘要不一致");
}

/** 把写入输入收敛为稳定的 Skill 定义。 */
function normalizeSkillInput(
  input: Omit<SkillDefinition, "createdAt" | "updatedAt">,
  existing: SkillDefinition | null,
): Omit<SkillDefinition, "createdAt" | "updatedAt"> {
  const name = String(input.name ?? "").trim();
  const description = String(input.description ?? "").trim();
  const trigger = String(input.trigger ?? "").trim();
  const instructions = String(input.instructions ?? "").trim();
  const slug = normalizeSkillSlug(input.slug ?? existing?.slug ?? name);
  const targetEngines = normalizeSkillTargetEngines(input.targetEngines);
  const files = normalizeSkillFiles(input.files, existing?.files, {
    name,
    slug,
    description,
    trigger,
    instructions,
    skillMd: input.skillMd ?? existing?.skillMd ?? null,
  });
  const skillMd = readSkillMd(files);
  const scripts = normalizeSkillScripts(input.scripts ?? existing?.scripts, files);
  const normalized = {
    ...input,
    name,
    slug,
    description,
    trigger,
    instructions,
    targetEngines,
    tags: normalizeSkillTags(input.tags),
    packageVersion: 1,
    skillMd,
    files,
    scripts,
    installTargets: normalizeSkillInstallTargets(input.installTargets ?? existing?.installTargets, targetEngines),
    autoInstall: normalizeSkillAutoInstall(input.autoInstall ?? existing?.autoInstall),
    kind: normalizeOrchAssetDefinitionKind(input.kind ?? existing?.kind),
  };
  return {
    ...normalized,
    packageHash: hashSkillPackage(normalized),
  };
}

/** 将数据库行恢复为共享 Skill 类型。 */
function rowToSkill(row: OrchSkillRow, filesFromTable: SkillPackageFile[]): SkillDefinition {
  const parsed = JSON.parse(row.definition_json) as Partial<SkillDefinition>;
  const name = String(parsed.name ?? row.name ?? "").trim();
  const description = String(parsed.description ?? row.description ?? "").trim();
  const trigger = String(parsed.trigger ?? "").trim();
  const instructions = String(parsed.instructions ?? "").trim();
  const slug = normalizeSkillSlug(parsed.slug ?? name);
  const targetEngines = normalizeSkillTargetEngines(parsed.targetEngines);
  const files = normalizeSkillFiles(filesFromTable.length ? filesFromTable : parsed.files, null, {
    name,
    slug,
    description,
    trigger,
    instructions,
    skillMd: parsed.skillMd ?? null,
  });
  const skillMd = readSkillMd(files);
  const scripts = normalizeSkillScripts(parsed.scripts, files);
  const restored = {
    ...parsed,
    id: row.id as SkillId,
    workspaceId: row.workspace_id as WorkspaceId,
    name,
    slug,
    description,
    trigger,
    instructions,
    targetEngines,
    tags: normalizeSkillTags(parsed.tags),
    packageVersion: 1,
    skillMd,
    files,
    scripts,
    installTargets: normalizeSkillInstallTargets(parsed.installTargets, targetEngines),
    autoInstall: normalizeSkillAutoInstall(parsed.autoInstall),
    kind: normalizeOrchAssetDefinitionKind(parsed.kind),
    createdAt: Number(row.created_at ?? parsed.createdAt ?? 0),
    updatedAt: Number(row.updated_at ?? parsed.updatedAt ?? 0),
  };
  return {
    ...restored,
    packageHash: String(parsed.packageHash ?? "").trim() || hashSkillPackage(restored),
  };
}

/** 只接受 Codex/Claude 两类目标引擎，避免注入到未知 provider。 */
function normalizeSkillTargetEngines(value: unknown): SkillTargetEngine[] {
  if (!Array.isArray(value)) throw new Error("Skill targetEngines 必须是数组");
  const normalized = [...new Set(value.map((item) => String(item).trim()).filter((item) => item === "codex" || item === "claude"))] as SkillTargetEngine[];
  if (!normalized.length) throw new Error("Skill targetEngines 至少需要包含 codex 或 claude");
  return normalized;
}

/** 规范化标签，空标签直接丢弃。 */
function normalizeSkillTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

/** 规范化可安装目标，默认跟随适用引擎。 */
function normalizeSkillInstallTargets(value: unknown, targetEngines: SkillTargetEngine[]): SkillTargetEngine[] {
  const raw = Array.isArray(value) ? value : targetEngines;
  const normalized = [...new Set(raw.map((item) => String(item).trim()).filter((item) => item === "codex" || item === "claude"))] as SkillTargetEngine[];
  return normalized.length ? normalized : targetEngines;
}

/** 规范化启动自动安装开关，默认不自动安装。 */
function normalizeSkillAutoInstall(value: unknown): boolean {
  return value === true;
}

/** 生成稳定 slug，作为 Skill 文件夹名和脚本工具 ID 的来源。 */
function normalizeSkillSlug(value: unknown): string {
  const base = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "skill";
}

/** 规范化 Skill 包文件，保证始终存在 SKILL.md。 */
function normalizeSkillFiles(
  inputFiles: unknown,
  existingFiles: SkillPackageFile[] | null | undefined,
  fallback: { name: string; slug: string; description: string; trigger: string; instructions: string; skillMd?: string | null },
): SkillPackageFile[] {
  const rawFiles = Array.isArray(inputFiles)
    ? inputFiles
    : Array.isArray(existingFiles)
      ? existingFiles
      : [];
  const files = new Map<string, SkillPackageFile>();
  for (const raw of rawFiles) {
    const file = normalizeSkillFile(raw);
    if (!file) continue;
    files.set(file.relPath, file);
  }
  const skillMd = files.get("SKILL.md") ?? createTextSkillFile("SKILL.md", "skill-md", fallback.skillMd || buildDefaultSkillMd(fallback));
  files.set("SKILL.md", {
    ...skillMd,
    kind: "skill-md",
    contentText: String(skillMd.contentText ?? fallback.skillMd ?? buildDefaultSkillMd(fallback)),
    contentBase64: null,
    contentType: "text/markdown",
  });
  return Array.from(files.values()).sort((left, right) => left.relPath.localeCompare(right.relPath));
}

/** 规范化单个文件，越界路径会被拒绝。 */
function normalizeSkillFile(raw: unknown): SkillPackageFile | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<SkillPackageFile>;
  const relPath = normalizeSkillFilePath(record.relPath);
  if (!relPath) return null;
  const text = typeof record.contentText === "string" ? record.contentText.replace(/\r\n/g, "\n") : null;
  const base64 = typeof record.contentBase64 === "string" && record.contentBase64.trim() ? record.contentBase64.trim() : null;
  const sizeBytes = text != null ? Buffer.byteLength(text, "utf8") : Buffer.byteLength(base64 ?? "", "base64");
  const normalized: SkillPackageFile = {
    relPath,
    kind: normalizeSkillFileKind(record.kind, relPath),
    contentText: text,
    contentBase64: text == null ? base64 : null,
    contentType: String(record.contentType ?? inferContentType(relPath)).trim() || inferContentType(relPath),
    sizeBytes,
    sha256: hashFileContent(text, base64),
  };
  return normalized;
}

/** 规范化文件相对路径，只允许标准 Skill 包目录。 */
function normalizeSkillFilePath(value: unknown): string | null {
  const rel = String(value ?? "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Skill 文件路径非法：${rel}`);
  }
  const normalized = parts.join("/");
  const allowed = isAllowedSkillPackagePath(normalized);
  if (!allowed) throw new Error(`Skill 文件只能位于 SKILL.md、setup.mjs、requirements.txt、manifest.txt、templates/、providers/、scripts/、references/、assets/ 或 agents/openai.yaml：${normalized}`);
  return normalized;
}

/** 允许资产化 Skill 包携带安装 helper、依赖清单和配置模板。 */
function isAllowedSkillPackagePath(normalized: string): boolean {
  return normalized === "SKILL.md"
    || normalized === "setup.mjs"
    || normalized === "requirements.txt"
    || normalized === "manifest.txt"
    || normalized === "agents/openai.yaml"
    || normalized.startsWith("templates/")
    || normalized.startsWith("providers/")
    || normalized.startsWith("scripts/")
    || normalized.startsWith("references/")
    || normalized.startsWith("assets/");
}

/** 根据路径推断 Skill 包文件类型。 */
function normalizeSkillFileKind(value: unknown, relPath: string): SkillPackageFileKind {
  const kind = String(value ?? "").trim();
  if (kind === "skill-md" || kind === "script" || kind === "reference" || kind === "asset" || kind === "metadata") return kind;
  if (relPath === "SKILL.md") return "skill-md";
  if (relPath === "setup.mjs") return "script";
  if (relPath.startsWith("scripts/")) return "script";
  if (relPath.startsWith("references/")) return "reference";
  if (relPath.startsWith("templates/") || relPath.startsWith("providers/")) return "reference";
  if (relPath.startsWith("assets/")) return "asset";
  return "metadata";
}

/** 解析脚本入口，入口必须指向 scripts/ 下存在的文件。 */
function normalizeSkillScripts(value: unknown, files: SkillPackageFile[]): SkillScriptEntrypoint[] {
  const existingScripts = new Set(files.filter((file) => file.kind === "script").map((file) => file.relPath));
  const raw = Array.isArray(value) ? value : [];
  const scripts: SkillScriptEntrypoint[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<SkillScriptEntrypoint>;
    const scriptPath = normalizeSkillFilePath(record.scriptPath);
    if (!scriptPath || !scriptPath.startsWith("scripts/") || !existingScripts.has(scriptPath)) continue;
    const id = normalizeScriptId(record.id ?? scriptPath);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    scripts.push({
      id,
      name: String(record.name ?? id).trim() || id,
      description: String(record.description ?? "").trim(),
      scriptPath,
      runtime: normalizeScriptRuntime(record.runtime, scriptPath),
      inputSchema: typeof record.inputSchema === "string" ? record.inputSchema.trim() || null : null,
      outputSchema: typeof record.outputSchema === "string" ? record.outputSchema.trim() || null : null,
      timeoutMs: record.timeoutMs != null && Number.isFinite(Number(record.timeoutMs)) ? Math.max(1_000, Number(record.timeoutMs)) : null,
      requiresWrite: Boolean(record.requiresWrite),
      exposeAsTool: Boolean(record.exposeAsTool),
    });
  }
  return scripts;
}

/** 根据脚本扩展名推断运行时。 */
function normalizeScriptRuntime(value: unknown, scriptPath: string): SkillScriptRuntime {
  const raw = String(value ?? "").trim();
  if (raw === "python" || raw === "node" || raw === "shell") return raw;
  if (scriptPath.endsWith(".py")) return "python";
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs") || scriptPath.endsWith(".cjs")) return "node";
  return "shell";
}

/** 规范化脚本工具 ID 片段。 */
function normalizeScriptId(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^scripts\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 从文件集合读取 SKILL.md 正文。 */
function readSkillMd(files: SkillPackageFile[]): string {
  const file = files.find((item) => item.relPath === "SKILL.md");
  return String(file?.contentText ?? "").replace(/\r\n/g, "\n");
}

/** 生成默认 SKILL.md，兼容旧表单 Skill。 */
function buildDefaultSkillMd(input: { name: string; slug: string; description: string; trigger: string; instructions: string }): string {
  return [
    "---",
    `name: ${yamlDoubleQuoted(input.slug)}`,
    `description: ${yamlDoubleQuoted(input.description || input.trigger || input.name)}`,
    "---",
    "",
    `# ${input.name || input.slug}`,
    "",
    input.description ? input.description : "",
    input.trigger ? `## Trigger\n\n${input.trigger}` : "",
    input.instructions ? `## Instructions\n\n${input.instructions}` : "",
  ].filter((part) => part !== "").join("\n");
}

/** 构造文本型 Skill 包文件并计算内容哈希。 */
function createTextSkillFile(relPath: string, kind: SkillPackageFileKind, content: string): SkillPackageFile {
  const text = String(content ?? "").replace(/\r\n/g, "\n");
  return {
    relPath,
    kind,
    contentText: text,
    contentBase64: null,
    contentType: inferContentType(relPath),
    sizeBytes: Buffer.byteLength(text, "utf8"),
    sha256: hashFileContent(text, null),
  };
}

/** 将数据库文件行恢复成 Skill 包文件。 */
function rowToSkillFile(row: OrchSkillFileRow): SkillPackageFile {
  return {
    relPath: row.rel_path,
    kind: normalizeSkillFileKind(row.kind, row.rel_path),
    contentText: row.content_text,
    contentBase64: row.content_base64,
    contentType: row.content_type ?? inferContentType(row.rel_path),
    sizeBytes: Number(row.size_bytes ?? 0),
    sha256: String(row.sha256 ?? "").trim() || hashFileContent(row.content_text, row.content_base64),
  };
}

/** 计算文件内容哈希。 */
function hashFileContent(text: string | null | undefined, base64: string | null | undefined): string {
  const hash = crypto.createHash("sha256");
  if (text != null) hash.update(text, "utf8");
  else if (base64) hash.update(Buffer.from(base64, "base64"));
  return hash.digest("hex");
}

/** 计算 Skill 包哈希，排除时间戳和数据库 ID。 */
function hashSkillPackage(skill: Omit<SkillDefinition, "createdAt" | "updatedAt" | "id" | "workspaceId">): string {
  const payload = {
    name: skill.name,
    slug: skill.slug,
    description: skill.description,
    trigger: skill.trigger,
    instructions: skill.instructions,
    targetEngines: skill.targetEngines,
    tags: skill.tags ?? [],
    skillMd: skill.skillMd ?? "",
    scripts: skill.scripts ?? [],
    autoInstall: skill.autoInstall === true,
    files: (skill.files ?? []).map((file) => ({
      relPath: file.relPath,
      kind: file.kind,
      contentType: file.contentType ?? null,
      sha256: file.sha256,
    })),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** definition_json 不重复存包文件正文，避免大 JSON 膨胀。 */
function stripSkillFilesForJson(skill: SkillDefinition): SkillDefinition {
  return {
    ...skill,
    files: (skill.files ?? []).map((file) => ({
      relPath: file.relPath,
      kind: file.kind,
      contentType: file.contentType ?? null,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  };
}

/** 推断常见文件 MIME。 */
function inferContentType(relPath: string): string {
  if (relPath.endsWith(".md")) return "text/markdown";
  if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) return "text/yaml";
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".py")) return "text/x-python";
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")) return "text/javascript";
  if (relPath.endsWith(".sh") || relPath.endsWith(".ps1")) return "text/x-shellscript";
  return "application/octet-stream";
}

/** YAML 双引号转义。 */
function yamlDoubleQuoted(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
