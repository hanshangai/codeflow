import { nextTick, watch, type Ref } from "vue";
import type { WorkspaceId } from "@codeflowai/shared";

import { fetchFsReadFile } from "../../api/fs";
import { useApiContext } from "../../composables/useApiContext";

export type MarkdownResourceContext = {
  workspaceId?: WorkspaceId | null;
  filePath?: string | null;
};

/** 解析 Markdown 渲染后的工作区相对图片，并把图片内容替换成 data URL。 */
export function useMarkdownResources(
  containerRef: Ref<HTMLElement | null>,
  htmlRef: Ref<string>,
  contextRef: Ref<MarkdownResourceContext>,
): void {
  const { ctx } = useApiContext();
  let runId = 0;

  watch(
    () => [htmlRef.value, contextRef.value.workspaceId, contextRef.value.filePath, containerRef.value] as const,
    () => {
      const currentRunId = ++runId;
      void nextTick(async () => {
        const container = containerRef.value;
        const workspaceId = contextRef.value.workspaceId ?? null;
        const filePath = contextRef.value.filePath ?? null;
        if (!container || !workspaceId || !filePath) return;

        const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[data-markdown-resource="image"][data-markdown-src]'));
        for (const image of images) {
          if (currentRunId !== runId) return;
          await loadWorkspaceImage(image, workspaceId, filePath);
        }
      });
    },
    { immediate: true },
  );

  /** 加载单张工作区图片；失败时替换为可见错误，不隐藏问题。 */
  async function loadWorkspaceImage(image: HTMLImageElement, workspaceId: WorkspaceId, markdownFilePath: string): Promise<void> {
    try {
      const source = image.dataset.markdownSrc ?? "";
      const resourcePath = resolveMarkdownResourcePath(markdownFilePath, source);
      if (!resourcePath) throw new Error(`图片路径越界或为空：${source}`);

      const res = await fetchFsReadFile(ctx.value, { workspaceId, path: resourcePath });
      if (!res.ok) throw new Error(res.message || "读取图片失败");
      if (!res.base64 || !res.mimeType?.startsWith("image/")) {
        throw new Error(`目标不是可渲染图片：${resourcePath}`);
      }

      image.src = `data:${res.mimeType};base64,${res.base64}`;
      image.classList.remove("markdown-image--loading");
      image.removeAttribute("data-markdown-resource");
    } catch (error) {
      showImageError(image, error instanceof Error ? error.message : String(error));
    }
  }
}

/** 根据当前 Markdown 文件路径解析图片相对路径，返回 workspace 相对 POSIX 路径。 */
export function resolveMarkdownResourcePath(markdownFilePath: string, source: string): string | null {
  const pathOnly = stripResourceQueryAndHash(String(source ?? "").trim());
  if (!pathOnly) return null;
  const decodedSource = decodeMarkdownResourcePath(pathOnly);
  const filePath = normalizeSlashes(markdownFilePath);
  const baseDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
  const candidate = decodedSource.startsWith("/")
    ? decodedSource.replace(/^\/+/u, "")
    : `${baseDir ? `${baseDir}/` : ""}${decodedSource}`;
  return normalizeWorkspaceRelativePath(candidate);
}

/** 移除 URL 查询和 hash；文件读取只需要路径部分。 */
function stripResourceQueryAndHash(source: string): string {
  const index = source.search(/[?#]/u);
  return index >= 0 ? source.slice(0, index) : source;
}

/** 解码 Markdown URL 编码路径；非法编码需要显式反馈给用户。 */
function decodeMarkdownResourcePath(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch (error) {
    throw new Error(`图片路径编码无效：${source}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/** 归一化路径分隔符，保持 workspace 相对路径使用 POSIX 风格。 */
function normalizeSlashes(path: string): string {
  return String(path ?? "").trim().replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\/+/u, "");
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

/** 将图片加载错误替换成可读提示，避免 broken image 静默留在页面中。 */
function showImageError(image: HTMLImageElement, message: string): void {
  const errorNode = document.createElement("span");
  errorNode.className = "markdown-image-error";
  errorNode.textContent = `图片加载失败：${message}`;
  image.replaceWith(errorNode);
}
