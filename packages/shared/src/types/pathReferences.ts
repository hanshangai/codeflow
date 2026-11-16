export type WorkspacePathReferenceKind = "file" | "directory";

export type WorkspacePathReferenceSource = "mention" | "manual" | "external";

export type WorkspacePathReference = {
  id: string;
  /** workspace 相对 POSIX 路径，不含前导 @，不允许绝对路径或 .. 越界。 */
  path: string;
  kind: WorkspacePathReferenceKind;
  /** 展示名；为空时由 path basename 推导。 */
  displayName?: string | null;
  source?: WorkspacePathReferenceSource;
};

export type WorkspacePathMention = {
  raw: string;
  path: string;
  start: number;
  end: number;
  quoted: boolean;
  lineSuffix?: string | null;
};

export const WORKSPACE_PATH_REFERENCE_LIMITS = {
  maxCount: 20,
  maxPathLength: 600,
} as const;

/**
 * 规范化 workspace 相对路径；只做字符串层校验，真实越界仍由 Client fs 解析兜底。
 */
export function normalizeWorkspacePathReferencePath(rawPath: unknown): string {
  const original = String(rawPath ?? "").trim();
  if (!original) throw new Error("路径引用不能为空");
  if (original.length > WORKSPACE_PATH_REFERENCE_LIMITS.maxPathLength) {
    throw new Error(`路径引用过长：${original.slice(0, 80)}`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(original) || original.startsWith("/") || original.startsWith("\\")) {
    throw new Error(`路径引用必须是工作区相对路径：${original}`);
  }
  const normalized = original.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (!parts.length) throw new Error("路径引用不能指向工作区根目录");
  if (parts.some((part) => part === "..")) {
    throw new Error(`路径引用不能包含越界片段：${original}`);
  }
  return parts.join("/");
}

/**
 * 构造稳定的路径引用 DTO；调用方负责在写入前用真实 fs stat 修正 kind。
 */
export function createWorkspacePathReference(input: {
  path: unknown;
  kind?: unknown;
  id?: unknown;
  displayName?: unknown;
  source?: unknown;
}): WorkspacePathReference {
  const path = normalizeWorkspacePathReferencePath(input.path);
  const kind: WorkspacePathReferenceKind = input.kind === "directory" ? "directory" : "file";
  const displayName = nullableString(input.displayName) ?? basenameFromWorkspacePath(path);
  const id = nullableString(input.id) ?? `pathref_${kind}_${path}`;
  const source = input.source === "manual" || input.source === "external" ? input.source : "mention";
  return { id, path, kind, displayName, source };
}

/**
 * 规范化路径引用数组并按 path 去重；非法输入直接抛错，避免静默丢引用。
 */
export function normalizeWorkspacePathReferenceList(raw: unknown): WorkspacePathReference[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("路径引用必须是数组");
  if (raw.length > WORKSPACE_PATH_REFERENCE_LIMITS.maxCount) {
    throw new Error(`最多只能引用 ${WORKSPACE_PATH_REFERENCE_LIMITS.maxCount} 个工作区路径`);
  }
  const byPath = new Map<string, WorkspacePathReference>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 个路径引用格式错误`);
    const ref = createWorkspacePathReference(item as { path: unknown; kind?: unknown; id?: unknown; displayName?: unknown; source?: unknown });
    if (!byPath.has(ref.path)) byPath.set(ref.path, ref);
  });
  return Array.from(byPath.values());
}

/**
 * 从用户输入中提取 @ 路径 token；支持 @foo、@"path with space" 和 Claude 风格 #L 行号后缀。
 */
export function parseWorkspacePathMentions(content: string): WorkspacePathMention[] {
  const text = String(content ?? "");
  const out: WorkspacePathMention[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@") continue;
    if (!isWorkspacePathMentionStart(text, index)) continue;

    if (text[index + 1] === "\"") {
      const parsed = parseQuotedMention(text, index);
      if (!parsed) continue;
      out.push(parsed);
      index = parsed.end - 1;
      continue;
    }

    const parsed = parseBareMention(text, index);
    if (!parsed) continue;
    out.push(parsed);
    index = parsed.end - 1;
  }
  return out;
}

/**
 * 判断某个 @ 是否可作为 workspace 路径引用起点；允许中文/标点后直接 @，但避开邮箱和路径片段内的 @。
 */
export function isWorkspacePathMentionStart(content: string, index: number): boolean {
  const text = String(content ?? "");
  if (index < 0 || index >= text.length || text[index] !== "@") return false;
  if (index === 0) return true;
  const prev = text[index - 1] ?? "";
  if (/\s/u.test(prev)) return true;
  return !/[A-Za-z0-9_./\\+@-]/u.test(prev);
}

/** 格式化可插入输入框的 @ 路径 token，路径含空白时自动加引号。 */
export function formatWorkspacePathMention(path: unknown): string {
  const normalized = normalizeWorkspacePathReferencePath(path);
  if (/[\s"]/u.test(normalized)) {
    return `@"${normalized.replace(/"/g, "\\\"")}"`;
  }
  return `@${normalized}`;
}

function parseQuotedMention(text: string, start: number): WorkspacePathMention | null {
  let cursor = start + 2;
  let pathText = "";
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === "\\" && text[cursor + 1] === "\"") {
      pathText += "\"";
      cursor += 2;
      continue;
    }
    if (ch === "\"") break;
    if (ch === "\n" || ch === "\r") return null;
    pathText += ch;
    cursor += 1;
  }
  if (cursor >= text.length || text[cursor] !== "\"") return null;
  let end = cursor + 1;
  const line = readLineSuffix(text, end);
  if (line) end = line.end;
  let path: string;
  try {
    path = normalizeWorkspacePathReferencePath(pathText);
  } catch {
    return null;
  }
  return { raw: text.slice(start, end), path, start, end, quoted: true, lineSuffix: line?.suffix ?? null };
}

function parseBareMention(text: string, start: number): WorkspacePathMention | null {
  let end = start + 1;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const rawBody = text.slice(start + 1, end);
  if (!rawBody || rawBody.startsWith("@") || rawBody.startsWith("\"")) return null;
  const { pathText, lineSuffix } = splitLineSuffix(rawBody);
  let path: string;
  try {
    path = normalizeWorkspacePathReferencePath(pathText);
  } catch {
    return null;
  }
  return { raw: text.slice(start, end), path, start, end, quoted: false, lineSuffix };
}

function readLineSuffix(text: string, start: number): { suffix: string; end: number } | null {
  const match = text.slice(start).match(/^#L\d+(?:-L?\d+)?/);
  if (!match) return null;
  const suffix = match[0] ?? "";
  return suffix ? { suffix, end: start + suffix.length } : null;
}

function splitLineSuffix(value: string): { pathText: string; lineSuffix: string | null } {
  const match = value.match(/^(.*?)(#L\d+(?:-L?\d+)?)$/);
  if (!match) return { pathText: value, lineSuffix: null };
  return { pathText: match[1] ?? "", lineSuffix: match[2] ?? null };
}

function basenameFromWorkspacePath(path: string): string {
  const parts = String(path ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}
