/**
 * 从剪贴板里提取文件引用 URL；浏览器可能因安全策略不暴露本地完整路径。
 */
export function collectClipboardFileReferenceUrls(data: Pick<DataTransfer, "getData"> | null | undefined): string[] {
  if (!data) return [];
  const candidates = [
    ...parseUriList(readClipboardText(data, "text/uri-list")),
    ...parsePlainTextReferences(readClipboardText(data, "text/plain")),
  ];
  return uniqueReferences(candidates);
}

/**
 * 为超限文件选择可追加到输入框的完整 URL；拿不到真实地址时返回 null。
 */
export function resolveOversizedFileReferenceUrl(
  file: Pick<File, "name">,
  candidateUrls: readonly string[],
  index: number,
): string | null {
  const fileUrl = extractKnownFileUrl(file);
  if (fileUrl) return fileUrl;

  const indexed = normalizeReference(candidateUrls[index] ?? "");
  if (indexed) return indexed;

  const fileBaseName = normalizeBaseName(String(file.name ?? ""));
  if (!fileBaseName) return null;
  for (const candidate of candidateUrls) {
    const normalized = normalizeReference(candidate);
    if (normalized && normalizeBaseName(referenceBaseName(normalized)) === fileBaseName) return normalized;
  }
  return null;
}

/** 读取剪贴板文本类型；浏览器拒绝读取时由调用链显式失败。 */
function readClipboardText(data: Pick<DataTransfer, "getData">, type: string): string {
  return String(data.getData(type) ?? "");
}

/** 解析 text/uri-list，忽略注释行。 */
function parseUriList(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((line) => normalizeReference(line))
    .filter((line): line is string => Boolean(line));
}

/** 从纯文本中解析 URL 或绝对路径；普通正文不会被当成文件地址。 */
function parsePlainTextReferences(value: string): string[] {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((line) => normalizeReference(line))
    .filter((line): line is string => Boolean(line));
}

/** 从 File 对象的非标准字段中提取路径；标准浏览器通常不会提供。 */
function extractKnownFileUrl(file: Pick<File, "name">): string | null {
  const record = file as unknown as Record<string, unknown>;
  const values = [record.path, record.fullPath, record.mozFullPath, record.webkitRelativePath];
  for (const value of values) {
    const normalized = normalizeReference(String(value ?? ""));
    if (normalized) return normalized;
  }
  return null;
}

/** 归一化 URL/绝对路径为可粘贴 URL。 */
function normalizeReference(raw: string): string | null {
  const value = stripWrappingQuotes(String(raw ?? "").trim());
  if (!value || value.startsWith("#")) return null;
  if (/^(?:https?|file):\/\//iu.test(value)) return normalizeUrl(value);
  return absolutePathToFileUrl(value);
}

/** 规范化已存在的 URL 文本；只接受可直接粘贴的 URL 协议。 */
function normalizeUrl(value: string): string | null {
  if (!/^(?:https?|file):\/\//iu.test(value) || /[\r\n\t]/u.test(value)) return null;
  return value.replace(/ /gu, "%20");
}

/** 将 Windows/Unix 绝对路径转换为 file URL。 */
function absolutePathToFileUrl(value: string): string | null {
  if (/^[a-zA-Z]:[\\/]/u.test(value)) {
    return `file:///${encodePath(value.replace(/\\/g, "/"))}`;
  }
  if (/^\\\\[^\\]+\\[^\\]+/u.test(value)) {
    const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
    const [host, ...parts] = normalized.split("/");
    if (!host || !parts.length) return null;
    return `file://${host}/${parts.map(encodeURIComponent).join("/")}`;
  }
  if (value.startsWith("/")) {
    return `file://${encodePath(value)}`;
  }
  return null;
}

/** 编码路径片段，同时保留 Windows 盘符冒号。 */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => (/^[a-zA-Z]:$/u.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
}

/** 去除常见外层引号。 */
function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 基于 URL/path 提取文件名用于多文件匹配。 */
function referenceBaseName(value: string): string {
  const withoutQuery = String(value ?? "").split(/[?#]/u)[0] ?? "";
  const normalized = withoutQuery.replace(/\\/g, "/").replace(/^file:\/\/[^/]*\/?/iu, "/").replace(/^https?:\/\/[^/]*\/?/iu, "/");
  const basename = normalized.split("/").filter(Boolean).pop() ?? "";
  return basename.replace(/%20/giu, " ");
}

/** 文件名比较统一为小写。 */
function normalizeBaseName(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

/** 引用去重并保持原顺序。 */
function uniqueReferences(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeReference(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
