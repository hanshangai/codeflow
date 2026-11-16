import fs from "node:fs";
import path from "node:path";

/** MIME 类型映射（按扩展名） */
const EXT_MIME: Record<string, string> = {
  // 图片
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp",
  // 文本/代码
  txt: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html",
  css: "text/css", js: "text/javascript", ts: "text/typescript",
  jsx: "text/javascript", tsx: "text/typescript",
  json: "application/json", xml: "application/xml",
  yaml: "text/yaml", yml: "text/yaml",
  csv: "text/csv", tsv: "text/tab-separated-values",
  // 文档
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  // 其他
  sh: "text/x-shellscript", bash: "text/x-shellscript",
  py: "text/x-python", java: "text/x-java-source",
  vue: "text/html", sql: "text/x-sql",
  gradle: "text/x-groovy", kt: "text/x-kotlin",
  rs: "text/x-rust", go: "text/x-go", rb: "text/x-ruby",
  c: "text/x-c", cpp: "text/x-c++", h: "text/x-c",
  toml: "text/x-toml", ini: "text/x-ini",
  properties: "text/x-java-properties",
  log: "text/plain",
};

/** 二进制扩展名集合 */
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "pdf", "docx", "xlsx", "xlsm", "ppt", "pptx", "doc", "xls",
  "zip", "gz", "tar", "rar", "7z",
  "exe", "dll", "so", "dylib",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "avi", "mov", "wav", "ogg", "flac",
  "class", "jar", "war",
  "sqlite", "db",
  "wasm",
]);

/** 图片扩展名集合（需要 base64 传输） */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"]);

/** 表格类文件扩展名集合（走结构化预览接口）。 */
const SPREADSHEET_EXTS = new Set(["xlsx", "xlsm", "xls", "csv", "tsv"]);

/** 文档类文件扩展名集合（走结构化文档预览接口）。 */
const DOCUMENT_PREVIEW_EXTS = new Set(["pdf", "docx", "pptx"]);

export function getMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return EXT_MIME[ext] ?? null;
}

export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return BINARY_EXTS.has(ext);
}

export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return IMAGE_EXTS.has(ext);
}

/** 判断文件是否应按表格预览解析。 */
export function isSpreadsheetFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return SPREADSHEET_EXTS.has(ext);
}

/** 判断文件是否应按文档预览解析。 */
export function isDocumentPreviewFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return DOCUMENT_PREVIEW_EXTS.has(ext);
}

/**
 * 安全解析 workspace 内的相对路径。
 * 防止路径越界（traversal attack）。
 */
export function resolveWorkspacePath(workspacePath: string, relPosixPath: string): string {
  const rel = String(relPosixPath ?? "").trim();
  if (!rel && rel !== "") throw new Error("非法路径：空 path");
  // 空路径表示根目录
  const wsResolved = path.resolve(workspacePath);
  if (!rel) return wsResolved;
  const resolved = path.resolve(wsResolved, rel.split(/[\\/]+/).join(path.sep));
  const relative = path.relative(wsResolved, resolved);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw Object.assign(new Error(`非法路径（越界）：${relPosixPath}`), { code: "FILE_TRANSFER_PATH_INVALID" });
  }
  return resolved;
}

/** 解析只读目标的真实路径；允许缺失时仍检查现存父路径，拒绝悬空链接与真实越界。 */
export function resolveWorkspaceReadPath(workspacePath: string, relPath: string, allowMissing = false): string {
  const resolved = resolveWorkspacePath(workspacePath, relPath);
  const realRoot = fs.realpathSync(path.resolve(workspacePath));
  const missingParts: string[] = [];
  let current = resolved;
  while (true) {
    let realPath: string;
    try {
      realPath = fs.realpathSync(current);
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // 已存在但无法解析的链接不能被当作删除文件，避免跳过其实际目标校验。
      if (fs.lstatSync(current, { throwIfNoEntry: false })) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingParts.unshift(path.basename(current));
      current = parent;
      continue;
    }
    const relative = path.relative(realRoot, realPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error(`非法路径（真实目标越界）：${relPath}`), { code: "FILE_TRANSFER_PATH_INVALID" });
    }
    return path.join(realPath, ...missingParts);
  }
}
