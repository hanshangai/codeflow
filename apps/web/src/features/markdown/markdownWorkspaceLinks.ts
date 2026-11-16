// 仅用于纠正 linkify 把裸文件名识别为域名；明确的文件引用不受此表限制。
const AUTO_LINK_FILE_EXTS = new Set([
  "bat",
  "bmp",
  "c",
  "cmd",
  "cpp",
  "cs",
  "css",
  "csv",
  "cfg",
  "conf",
  "docx",
  "env",
  "gif",
  "go",
  "h",
  "htm",
  "html",
  "ico",
  "ini",
  "java",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "kt",
  "log",
  "markdown",
  "md",
  "pdf",
  "png",
  "pptx",
  "prc",
  "pck",
  "pkb",
  "pks",
  "properties",
  "ps1",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "tsv",
  "txt",
  "vue",
  "webp",
  "xls",
  "xlsm",
  "xlsx",
  "xml",
  "yaml",
  "yml",
]);

/** 解析文件引用；缺少本地根目录时保留 Windows 绝对路径，由 Host 校验边界。 */
export function resolveMarkdownWorkspaceLinkPath(
  href: string,
  baseFilePath?: string | null,
  workspaceRootPath?: string | null,
): string | null {
  const value = String(href ?? "").trim();
  if (!value) return null;
  const windowsAbsolute = /^\/?[a-z]:(?:[/\\]|%2f|%5c)/iu.test(value);
  if (shouldKeepBrowserLink(value) && !windowsAbsolute) return null;

  const decodedPath = stripWorkspaceFileLineSuffix(decodeWorkspaceLinkPath(stripLinkQueryAndHash(value)));
  if (!decodedPath) return null;
  if (/[\u0000-\u001f\u007f<>|]/u.test(decodedPath)) throw new Error("文件链接包含无效字符");
  const absolutePath = resolveWorkspaceAbsoluteLinkPath(decodedPath, workspaceRootPath);
  if (absolutePath) return absolutePath;

  const normalizedPath = normalizeAbsolutePath(decodedPath);
  if (/^[a-z]:\//iu.test(normalizedPath)) {
    if (isLocalAbsolutePath(normalizeAbsolutePath(workspaceRootPath ?? ""))) {
      throw new Error(`文件链接不属于当前工作区：${decodedPath}`);
    }
    return normalizedPath;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decodedPath)) throw new Error("文件链接不能包含 URL 协议");
  if (decodedPath.startsWith("/") && !hasWorkspaceFileExtension(decodedPath)) return null;

  const basePath = normalizeSlashes(baseFilePath ?? "");
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const candidate = decodedPath.startsWith("/")
    ? decodedPath.replace(/^\/+/u, "")
    : `${baseDir ? `${baseDir}/` : ""}${decodedPath}`;
  const relativePath = normalizeWorkspaceRelativePath(candidate);
  if (!relativePath) throw new Error(`文件链接超出工作区或未指定文件：${decodedPath}`);
  return relativePath;
}

/** 判断链接是否应保留浏览器原生行为。 */
function shouldKeepBrowserLink(href: string): boolean {
  if (href.startsWith("#") || href.startsWith("//")) return true;
  return /^[a-z][a-z0-9+.-]*:/iu.test(href);
}

/** 将当前工作区根目录下的本地绝对路径转换为 workspace 相对路径。 */
function resolveWorkspaceAbsoluteLinkPath(path: string, workspaceRootPath?: string | null): string | null {
  const root = normalizeAbsolutePath(workspaceRootPath ?? "");
  const candidate = normalizeAbsolutePath(path);
  if (!isLocalAbsolutePath(root) || !candidate || !isLocalAbsolutePath(candidate)) return null;
  const rootWithSlash = root.endsWith("/") ? root : `${root}/`;
  const comparisonPath = /^[a-z]:\//iu.test(candidate) ? candidate.toLowerCase() : candidate;
  const comparisonRoot = /^[a-z]:\//iu.test(root) ? root.toLowerCase() : root;
  if (comparisonPath !== comparisonRoot && !comparisonPath.startsWith(`${comparisonRoot.replace(/\/$/u, "")}/`)) return null;
  const relative = candidate === root ? "" : candidate.slice(rootWithSlash.length);
  const relativePath = normalizeWorkspaceRelativePath(relative);
  if (!relativePath) throw new Error(`文件链接超出工作区或未指定文件：${path}`);
  return relativePath;
}

/** 移除查询参数和锚点；文件预览只需要路径部分。 */
function stripLinkQueryAndHash(href: string): string {
  const index = href.search(/[?#]/u);
  return index >= 0 ? href.slice(0, index) : href;
}

/** 移除文件路径的 :line[:column] 后缀，兼容已解码的 #/? 文件名并保留盘符。 */
export function stripWorkspaceFileLineSuffix(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/(^|[/\\])([^/\\:]+)(?::\d+){1,2}$/u, "$1$2");
}

/** 解码 Markdown URL 编码路径；非法编码显式失败，避免继续跳转到无效 URL。 */
function decodeWorkspaceLinkPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch (error) {
    throw new Error(`文档链接编码无效：${path}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 只按文件名形态识别明确引用；文本或二进制交给现有文件读取与预览判断。 */
export function hasWorkspaceFileExtension(path: string): boolean {
  const fileName = normalizeSlashes(path).split("/").pop() ?? "";
  return /\.[^\s./\\:?#]+$/u.test(fileName);
}

/** 裸域名仅按已知文件后缀纠正，避免把 example.com 等真实网址当成文件。 */
export function hasKnownWorkspaceFileExtension(path: string): boolean {
  const ext = normalizeSlashes(path).split(".").pop()?.toLowerCase() ?? "";
  return hasWorkspaceFileExtension(path) && AUTO_LINK_FILE_EXTS.has(ext);
}

/** 归一化路径分隔符，保持 workspace 相对路径使用 POSIX 风格。 */
function normalizeSlashes(path: string): string {
  return String(path ?? "").trim().replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\/+/u, "");
}

/** 归一化本地绝对路径，兼容 /D:/ 引用并保留盘符根目录。 */
function normalizeAbsolutePath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/\\/gu, "/").replace(/\/+/gu, "/")
    .replace(/^\/(?=[a-z]:\/)/iu, "").replace(/^([a-z]):/iu, (drive) => drive.toUpperCase());
  return normalized === "/" || /^[a-z]:\/$/iu.test(normalized) ? normalized : normalized.replace(/\/+$/u, "");
}

/** 判断路径是否是浏览器不应直接处理的本地绝对路径。 */
function isLocalAbsolutePath(path: string): boolean {
  return /^[A-Z]:\//u.test(path) || path.startsWith("/");
}

/** 规整相对路径并阻止越过 workspace 根目录。 */
function normalizeWorkspaceRelativePath(input: string): string | null {
  const segments: string[] = [];
  for (const segment of normalizeSlashes(input).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}
