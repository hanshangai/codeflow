import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DESKTOP_WEB_ENTRY = "codeflow://desktop/";

/** 桌面窗口直接进入主程序；仅根入口改写，显式业务路径保持不变。 */
export function resolveDesktopInitialEntry(entry: string): string {
  const url = new URL(entry);
  if (!url.pathname || url.pathname === "/") url.pathname = "/chat";
  return url.href;
}
const WEB_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
};

/** 协议资源失败必须拒绝加载，避免错误页面被当作已就绪的 Web。 */
export function createDesktopWebHandler(input: {
  getWebDir(): string;
  fetchFile?(url: string): Promise<Response>;
  onError(error: unknown): void;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") throw new Error("DESKTOP_WEB_METHOD_INVALID");
      const documentNavigation = request.destination === "document" || request.mode === "navigate"
        || request.headers.get("sec-fetch-dest") === "document"
        || request.headers.get("accept")?.split(",").some((part) => part.trim().split(";")[0] === "text/html") === true;
      const target = await resolveDesktopWebFile(input.getWebDir(), request.url, documentNavigation);
      const response = input.fetchFile ? await input.fetchFile(pathToFileURL(target).toString()) : await readDesktopWebResponse(target, request.method);
      if (!response.ok) throw new Error(`DESKTOP_WEB_HTTP_${response.status}`);
      return response;
    } catch (error) {
      try {
        input.onError(error);
      } catch (logError) {
        throw new AggregateError([error, logError], "DESKTOP_WEB_ERROR_LOG_FAILED");
      }
      throw error;
    }
  };
}

/** 已校验本地文件沿 Node 读取，避免 Chromium file 传输的 Windows 长路径限制。 */
async function readDesktopWebResponse(target: string, method: string): Promise<Response> {
  const bytes = await fs.readFile(target);
  const extension = path.extname(target).toLowerCase();
  return new Response(method === "HEAD" ? null : new Uint8Array(bytes), { headers: {
    "Content-Type": WEB_MIME_TYPES[extension] ?? "application/octet-stream", "Content-Length": String(bytes.length),
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
  } });
}

/** 固定桌面来源；开发环境仅信任配置的 Vite 来源。 */
export function isTrustedDesktopUrl(url: string, entry: string): boolean {
  if (typeof url !== "string" || !url) return false;
  let actual: URL, expected: URL;
  try {
    actual = new URL(url);
    expected = new URL(entry);
  } catch {
    // 窗口尚未导航时 mainFrame.url 为空；非法入口同样不能视为可信。
    return false;
  }
  return actual.protocol === expected.protocol && actual.host === expected.host
    && actual.username === "" && actual.password === "";
}

/** IPC 只接受当前窗口的主 frame，避免外部页面继承壳能力。 */
export function assertTrustedDesktopSender(sender: { mainFrame: boolean; url: string }, entry: string): void {
  if (!sender.mainFrame || !isTrustedDesktopUrl(sender.url, entry)) throw new Error("DESKTOP_IPC_FORBIDDEN");
}

/** 将 Web 资源和 SPA 导航映射到发布根；缺失静态资源显式失败。 */
export async function resolveDesktopWebFile(webDir: string, url: string, documentNavigation: boolean): Promise<string> {
  if (!isTrustedDesktopUrl(url, DESKTOP_WEB_ENTRY)) throw new Error("DESKTOP_WEB_ORIGIN_INVALID");
  const pathname = decodeURIComponent(new URL(url).pathname);
  const segments = pathname.split("/");
  if (segments.some((segment) => segment === ".." || segment.includes("\\") || segment.includes(":")) || pathname.includes("\0")) {
    throw new Error("DESKTOP_WEB_PATH_INVALID");
  }
  const root = await fs.realpath(webDir);
  const filePath = path.join(root, ...segments);
  let target: string;
  try {
    const stat = await fs.stat(filePath);
    target = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !documentNavigation) throw error;
    target = path.join(root, "index.html");
  }
  const realTarget = await fs.realpath(target);
  const relative = path.relative(root, realTarget);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("DESKTOP_WEB_PATH_INVALID");
  return realTarget;
}
