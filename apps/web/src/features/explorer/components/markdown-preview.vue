<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import { renderMarkdown, extractTocHeadings } from "../../markdown/renderMarkdown";
import { useMermaid } from "../../markdown/useMermaid";
import { useMarkdownResources } from "../../markdown/useMarkdownResources";
import { copyToClipboard } from "@/composables/useClipboard";
import { useApiContext } from "../../../composables/useApiContext";
import { useUiStore, type PreviewWindow } from "../../../store/ui";
import { loadWorkspaceFilePreview, type WorkspaceFilePreviewResult } from "../workspaceFilePreview";
import MarkdownToc from "./markdown-toc.vue";

defineOptions({ name: "MarkdownPreview" });

const props = defineProps<{
  content: string;
  filePath: string;
  workspaceId?: WorkspaceId | null;
  resourceFilePath?: string | null;
  showRaw?: boolean;
  fontScale?: number;
  tocVisible?: boolean;
}>();

const emit = defineEmits<{ (e: "update:tocVisible", val: boolean): void }>();

const { ctx } = useApiContext();
const ui = useUiStore();
const contentRef = ref<HTMLElement | null>(null);
const openingWorkspaceLinks = new Set<string>();
const resourceContext = computed(() => ({
  workspaceId: props.workspaceId ?? null,
  filePath: props.resourceFilePath ?? props.filePath,
}));
const html = computed(() => renderMarkdown(props.content, {
  resolveLocalImages: Boolean(resourceContext.value.workspaceId && resourceContext.value.filePath),
}));
useMermaid(contentRef, html);
useMarkdownResources(contentRef, html, resourceContext);
const headings = computed(() => extractTocHeadings(props.content));
const previewStyle = computed(() => ({
  fontSize: `${16 * (props.fontScale ?? 1)}px`,
}));
const rawStyle = computed(() => ({
  fontSize: `${13 * (props.fontScale ?? 1)}px`,
}));

/** 判断 href 是否应由工作区文件预览接管；外链、锚点和协议链接保持默认行为。 */
function shouldOpenWorkspaceLink(href: string): boolean {
  const value = String(href ?? "").trim();
  if (!value || value === "/" || value.startsWith("#") || value.startsWith("//")) return false;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  return !/[<>\\\u0000-\u001f\u007f]/u.test(value);
}

/** 取出 href 的文件路径部分，忽略查询与页内锚点。 */
function extractWorkspaceHrefPath(href: string): string {
  let path = String(href ?? "").trim();
  const hashIndex = path.indexOf("#");
  if (hashIndex >= 0) path = path.slice(0, hashIndex);
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  return decodeURI(path);
}

/** 基于当前 Markdown 文件路径解析相对文件链接，越过工作区根目录时返回 null。 */
function resolveWorkspaceLinkPath(currentFilePath: string, href: string): string | null {
  const targetPath = extractWorkspaceHrefPath(href);
  if (!shouldOpenWorkspaceLink(targetPath)) return null;

  const baseParts = targetPath.startsWith("/")
    ? []
    : String(currentFilePath ?? "")
      .split("/")
      .filter(Boolean)
      .slice(0, -1);
  const parts = [...baseParts];
  for (const part of targetPath.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** 把统一文件预览结果映射为全局预览窗口字段。 */
function previewFields(result: WorkspaceFilePreviewResult): Pick<PreviewWindow, "previewType" | "content" | "base64" | "mimeType" | "spreadsheet"
  | "size" | "mtimeMs" | "truncated" | "encoding"> {
  return {
    previewType: result.previewType,
    content: result.preview?.content ?? null,
    base64: result.preview?.base64 ?? null,
    mimeType: result.preview?.mimeType ?? result.spreadsheet?.mimeType ?? null,
    spreadsheet: result.spreadsheet ?? null,
    size: result.preview?.size ?? null,
    mtimeMs: result.preview?.mtimeMs ?? null,
    truncated: result.preview?.truncated ?? null,
    encoding: result.preview?.encoding ?? null,
  };
}

/** 读取工作区文件并打开独立预览窗口；失败时显式提示用户。 */
async function openWorkspaceLinkPreview(filePath: string): Promise<void> {
  const workspaceId = resourceContext.value.workspaceId;
  if (!workspaceId) return;
  const openKey = `${workspaceId}:${filePath}`;
  if (openingWorkspaceLinks.has(openKey)) return;
  openingWorkspaceLinks.add(openKey);
  try {
    const result = await loadWorkspaceFilePreview(ctx.value, workspaceId, filePath);
    ui.openPreviewWindow({
      id: `md_link_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      workspaceId,
      filePath,
      type: "file",
      ...previewFields(result),
      diffOriginal: null,
      diffModified: null,
      diffStaged: false,
      diffVersionOld: null,
      diffVersionNew: null,
      cascadeIndex: ui.explorerPreviewWindows.length,
      zIndex: 0,
    });
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取链接文件失败");
  } finally {
    openingWorkspaceLinks.delete(openKey);
  }
}

/** 事件委托：优先处理代码复制，其次把工作区相对文件链接打开为预览窗口。 */
async function handleClick(e: MouseEvent): Promise<void> {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const copyBtn = target.closest<HTMLButtonElement>(".code-block__copy");
  if (copyBtn) {
    const block = copyBtn.closest(".code-block");
    const code = block?.querySelector("pre code");
    if (!code) return;

    try {
      await copyToClipboard(code.textContent ?? "");
      copyBtn.textContent = "已复制";
      setTimeout(() => {
        copyBtn.textContent = "复制";
      }, 1500);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "复制失败");
    }
    return;
  }

  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  const href = anchor?.getAttribute("href") ?? "";
  const workspaceId = resourceContext.value.workspaceId;
  if (!anchor || !workspaceId || !shouldOpenWorkspaceLink(href)) return;

  e.preventDefault();
  e.stopPropagation();
  try {
    const filePath = resolveWorkspaceLinkPath(resourceContext.value.filePath, href);
    if (!filePath) return;
    await openWorkspaceLinkPreview(filePath);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "链接路径解析失败");
  }
}
</script>

<template>
  <div class="markdown-preview">
    <div v-if="showRaw" class="markdown-preview__raw">
      <pre class="markdown-preview__raw-pre" :style="rawStyle">{{ content }}</pre>
    </div>
    <div v-else class="markdown-preview__render-area">
      <div ref="contentRef" class="markdown-preview__content markdown" :style="previewStyle" v-html="html" @click="handleClick" />
      <MarkdownToc
        :headings="headings"
        :scroll-container="contentRef"
        :visible="!!tocVisible"
        @close="emit('update:tocVisible', false)"
        @navigate="emit('update:tocVisible', false)"
      />
    </div>
  </div>
</template>

<style scoped>
.markdown-preview {
  height: 100%;
  overflow: hidden;
}

.markdown-preview__render-area {
  display: flex;
  height: 100%;
  overflow: hidden;
}

.markdown-preview__content {
  flex: 1;
  min-width: 0;
  height: 100%;
  overflow: auto;
  padding: 16px 24px;
  line-height: 1.8;
}

.markdown-preview__raw {
  height: 100%;
  overflow: auto;
  padding: 16px 24px;
}

.markdown-preview__raw-pre {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--app-text);
}
</style>
