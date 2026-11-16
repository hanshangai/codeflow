import { spawnSync } from "node:child_process";
import path from "node:path";
import type { EngineType } from "@codeflowai/shared";

export type ToolChangePresentation = {
  path: string;
  kind?: string;
  diff?: string;
};

type RawChangeLike = { path?: unknown; kind?: unknown; diff?: unknown };
type ToolPathMode = "display" | "mutation";

export function extractToolChanges(opts: {
  engine: EngineType;
  toolName: string;
  input?: unknown;
  workspacePath: string | null;
  mode: ToolPathMode;
}): ToolChangePresentation[] {
  const toolKey = normalizeToolNameKey(opts.toolName);

  if (!supportsPathExtraction(opts.engine, toolKey, opts.mode)) return [];

  const rawChanges = pickChangesArray(opts.input);
  if (rawChanges.length) return normalizeChanges(rawChanges, opts.workspacePath);

  const patchPaths = pickPatchPathsFromInput(opts.input, opts.workspacePath);
  if (patchPaths.length) {
    return patchPaths.map((path) => ({ path }));
  }

  const filePaths = pickFilePathsFromInput(opts.input);
  if (!filePaths.length) return [];

  return dedupeByPath(
    filePaths
      .map((rawPath) => normalizeWorkspaceRelativePosixPath({ workspacePath: opts.workspacePath, rawPath }))
      .filter((p): p is string => Boolean(p))
      .map((p) => ({ path: p })),
  );
}

export function extractToolPaths(opts: {
  engine: EngineType;
  toolName: string;
  input?: unknown;
  workspacePath: string | null;
  mode: ToolPathMode;
}): string[] {
  return extractToolChanges(opts).map((change) => change.path);
}

export function normalizeChanges(rawChanges: RawChangeLike[], workspacePath: string | null): ToolChangePresentation[] {
  const out: ToolChangePresentation[] = [];
  for (const change of rawChanges) {
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath: change.path });
    if (!normalizedPath) continue;
    out.push({
      path: normalizedPath,
      kind: normalizeKind(change.kind),
      diff: typeof change.diff === "string" ? change.diff : undefined,
    });
  }
  return dedupeByPath(out);
}

export function normalizeWorkspaceRelativePosixPath(opts: { workspacePath: string | null; rawPath: unknown }): string | null {
  const trimmed = String(opts.rawPath ?? "").trim();
  if (!trimmed) return null;

  if (!opts.workspacePath) {
    const posix = trimmed.replace(/\\/g, "/");
    if (looksLikeAbsolutePath(posix)) return null;
    const normalized = path.posix.normalize(posix).replace(/^(\.\/)+/g, "");
    if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.includes("/../")) return null;
    return normalized;
  }

  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(opts.workspacePath, trimmed);
  const rel = path.relative(opts.workspacePath, abs);
  const relPosix = rel.replace(/\\/g, "/");
  const normalized = path.posix.normalize(relPosix).replace(/^(\.\/)+/g, "");
  if (!normalized || normalized === "." || normalized.startsWith("..") || normalized.includes("/../")) return null;
  return normalized;
}

export function extractPathsFromPatchText(workspacePath: string, patchText: string): string[] {
  const text = String(patchText ?? "");
  if (!text) return [];
  const out: string[] = [];

  for (const match of text.matchAll(/^\*{3}\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/gim)) {
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath: String(match[1] ?? "") });
    if (normalizedPath) out.push(normalizedPath);
  }

  for (const match of text.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gim)) {
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath: String(match[2] ?? match[1] ?? "") });
    if (normalizedPath) out.push(normalizedPath);
  }

  return dedupe(out);
}

/** 使用 Git 正反向 numstat 解析 aggregate diff；任一方向失败都返回 invalid。 */
export function analyzeUnifiedDiffPaths(
  workspacePath: string,
  diffText: string,
): { valid: boolean; paths: string[]; error: string | null } {
  const cwd = String(workspacePath ?? "");
  const diff = String(diffText ?? "");
  if (!cwd.trim()) return { valid: false, paths: [], error: "workspacePath 不能为空" };
  if (!diff) return { valid: true, paths: [], error: null };

  const forward = runGitNumstat(cwd, diff, false);
  if (!forward.valid) return forward;
  const reverse = runGitNumstat(cwd, diff, true);
  if (!reverse.valid) return reverse;
  return {
    valid: true,
    paths: dedupe([...forward.paths, ...reverse.paths]).sort(),
    error: null,
  };
}

/** 调用一次只读 git apply --numstat，并校验 NUL 分隔输出。 */
function runGitNumstat(
  workspacePath: string,
  diffText: string,
  reverse: boolean,
): { valid: boolean; paths: string[]; error: string | null } {
  const direction = reverse ? "反向" : "正向";
  try {
    const result = spawnSync(
      "git",
      ["apply", ...(reverse ? ["--reverse"] : []), "--numstat", "-z", "--no-index", "-"],
      {
        cwd: workspacePath,
        input: Buffer.from(diffText, "utf8"),
        encoding: null,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error) {
      return { valid: false, paths: [], error: `Git ${direction}解析失败：${result.error.message}` };
    }
    if (result.status !== 0) {
      const detail = summarizeGitError(result.stderr);
      return {
        valid: false,
        paths: [],
        error: `Git ${direction}解析失败${detail ? `：${detail}` : `（exit=${String(result.status)}）`}`,
      };
    }
    return parseGitNumstatOutput(workspacePath, result.stdout, direction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, paths: [], error: `Git ${direction}解析失败：${message}` };
  }
}

/** 解析 Git 的 NUL 分隔 numstat 输出，并拒绝工作区外路径。 */
function parseGitNumstatOutput(
  workspacePath: string,
  stdout: Buffer | string | null,
  direction: string,
): { valid: boolean; paths: string[]; error: string | null } {
  const output = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
  if (!output) return { valid: true, paths: [], error: null };
  if (!output.endsWith("\0")) {
    return { valid: false, paths: [], error: `Git ${direction} numstat 输出缺少 NUL 终止符` };
  }

  const paths: string[] = [];
  for (const record of output.slice(0, -1).split("\0")) {
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      return { valid: false, paths: [], error: `Git ${direction} numstat 输出格式无效` };
    }
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    if (!isNumstatCount(added) || !isNumstatCount(deleted)) {
      return { valid: false, paths: [], error: `Git ${direction} numstat 计数无效` };
    }
    const rawPath = record.slice(secondTab + 1);
    const normalizedPath = normalizeWorkspaceRelativePosixPath({ workspacePath, rawPath });
    if (!normalizedPath) {
      return { valid: false, paths: [], error: `Git ${direction}返回非法或越界路径：${rawPath || "<empty>"}` };
    }
    paths.push(normalizedPath);
  }
  return { valid: true, paths: dedupe(paths), error: null };
}

/** numstat 的文本计数为非负整数，二进制文件使用 `-`。 */
function isNumstatCount(value: string): boolean {
  return value === "-" || /^\d+$/.test(value);
}

/** 压缩 Git stderr，避免把大段补丁诊断写入业务错误。 */
function summarizeGitError(stderr: Buffer | string | null): string {
  const text = (Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "")).trim();
  if (!text) return "";
  return text.length > 800 ? `${text.slice(0, 797)}...` : text;
}

function supportsPathExtraction(engine: EngineType, toolKey: string, mode: ToolPathMode): boolean {
  if (mode === "display") {
    return (
      isFileChangeLikeTool(engine, toolKey) ||
      toolKey === "read" ||
      toolKey === "read_file" ||
      toolKey === "readfile"
    );
  }

  return isFileChangeLikeTool(engine, toolKey);
}

/** 判断工具是否为文件写入类工具（edit/write/delete 等）。用于区分 Read 等只读工具。 */
export function isFileChangeLikeTool(engine: EngineType, toolKey: string): boolean {
  if (engine === "codex") {
    return toolKey === "filechange" || toolKey === "file_change";
  }

  return (
    toolKey === "edit" ||
    toolKey === "multi_edit" ||
    toolKey === "multiedit" ||
    toolKey === "write" ||
    toolKey === "write_file" ||
    toolKey === "writefile" ||
    toolKey === "delete"
  );
}

export function normalizeToolNameKey(toolNameRaw: string): string {
  return String(toolNameRaw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function pickChangesArray(input: unknown): RawChangeLike[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const raw = obj.changes;
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is RawChangeLike => Boolean(c) && typeof c === "object");
}

function pickFilePathsFromInput(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;

  const direct = pickFirstNonEmptyString(obj, ["file_path", "filePath", "filepath", "path"]);
  if (direct) return [direct];

  const changes = Array.isArray(obj.changes) ? normalizeChanges(obj.changes as RawChangeLike[], null).map((change) => change.path) : [];
  if (changes.length) return changes;

  const edits = obj.edits;
  if (Array.isArray(edits)) {
    return edits
      .map((edit) => (edit && typeof edit === "object" ? pickFirstNonEmptyString(edit as Record<string, unknown>, ["file_path", "filePath", "filepath", "path"]) : ""))
      .filter(Boolean);
  }

  return [];
}

function pickPatchPathsFromInput(input: unknown, workspacePath: string | null): string[] {
  if (!workspacePath || !input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const patches: string[] = [];

  if (typeof obj.patch === "string") patches.push(obj.patch);
  if (typeof obj.input === "string") patches.push(obj.input);
  if (typeof obj.input === "object" && obj.input) {
    const nested = obj.input as Record<string, unknown>;
    if (typeof nested.patch === "string") patches.push(nested.patch);
    if (typeof nested.input === "string") patches.push(nested.input);
  }

  return dedupe(patches.flatMap((patch) => extractPathsFromPatchText(workspacePath, patch)));
}

function normalizeKind(kind: unknown): string | undefined {
  if (!kind) return undefined;
  if (typeof kind === "string") {
    const normalized = kind.trim();
    return normalized || undefined;
  }
  if (typeof kind === "object") {
    const normalized = String((kind as any).type ?? "").trim();
    return normalized || undefined;
  }
  return undefined;
}

function pickFirstNonEmptyString(input: unknown, keys: string[]): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function looksLikeAbsolutePath(posixPath: string): boolean {
  if (posixPath.startsWith("/")) return true;
  if (/^[a-zA-Z]:\//.test(posixPath)) return true;
  if (posixPath.startsWith("//")) return true;
  return false;
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function dedupeByPath(changes: ToolChangePresentation[]): ToolChangePresentation[] {
  const out: ToolChangePresentation[] = [];
  const seen = new Set<string>();
  for (const change of changes) {
    const normalizedPath = String(change.path ?? "").trim();
    if (!normalizedPath || seen.has(normalizedPath)) continue;
    seen.add(normalizedPath);
    out.push(change);
  }
  return out;
}

