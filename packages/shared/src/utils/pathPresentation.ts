export type PathDisplayInfo = {
  originalPath: string;
  normalizedPath: string;
  fileName: string;
  dirPath: string;
};

export function getPathDisplayInfo(rawPath: string): PathDisplayInfo {
  const originalPath = String(rawPath ?? "").trim();
  const normalizedPath = normalizeDisplayPath(originalPath);
  if (!normalizedPath) {
    return { originalPath, normalizedPath: "", fileName: "", dirPath: "" };
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  const fileName = segments.length ? segments[segments.length - 1]! : normalizedPath;
  const dirPath = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
  return { originalPath, normalizedPath, fileName, dirPath };
}

export function formatPathListSummary(paths: string[], opts?: { preferBaseName?: boolean }): string {
  const uniq = dedupeNonEmpty(paths).map((p) => getPathDisplayInfo(p));
  const display = opts?.preferBaseName ? uniq.map((p) => p.fileName || p.normalizedPath).filter(Boolean) : uniq.map((p) => p.normalizedPath).filter(Boolean);
  if (!display.length) return "";
  if (display.length === 1) return display[0]!;
  return `${display[0]} 等 ${display.length}个文件`;
}

export function normalizeDisplayPath(rawPath: string): string {
  const trimmed = String(rawPath ?? "").trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/g, "");
}

function dedupeNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeDisplayPath(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
