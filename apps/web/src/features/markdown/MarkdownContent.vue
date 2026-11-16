<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import type { WorkspaceId } from "@codeflowai/shared";
import { renderMarkdown } from "./renderMarkdown";
import { resolveMarkdownWorkspaceLinkPath } from "./markdownWorkspaceLinks";
import { useMermaid } from "./useMermaid";
import { useMarkdownResources } from "./useMarkdownResources";
import { copyToClipboard } from "@/composables/useClipboard";

defineOptions({ name: "MarkdownContent" });

const props = defineProps<{
  text: string;
  workspaceId?: WorkspaceId | null;
  filePath?: string | null;
  resourceFilePath?: string | null;
  workspaceRootPath?: string | null;
}>();
const emit = defineEmits<{ (e: "open-workspace-file", path: string): void }>();

const contentRef = ref<HTMLElement | null>(null);
const resourceContext = computed(() => ({
  workspaceId: props.workspaceId ?? null,
  filePath: props.resourceFilePath ?? props.filePath ?? null,
}));
const html = computed(() => renderMarkdown(props.text, {
  resolveLocalImages: Boolean(resourceContext.value.workspaceId && resourceContext.value.filePath),
}));
useMermaid(contentRef, html);
useMarkdownResources(contentRef, html, resourceContext);

/** 处理代码复制；仅在工作区内接管文件链接，公共页面保留浏览器跳转。 */
async function handleClick(e: MouseEvent): Promise<void> {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const copyBtn = target.closest<HTMLButtonElement>(".code-block__copy");
  if (copyBtn) {
    await copyCodeBlock(copyBtn);
    return;
  }

  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (!link || !props.workspaceId) return;
  const href = link.getAttribute("href") ?? "";
  try {
    const filePath = resolveMarkdownWorkspaceLinkPath(
      href,
      resourceContext.value.filePath,
      props.workspaceRootPath,
    );
    if (!filePath) return;
    e.preventDefault();
    emit("open-workspace-file", filePath);
  } catch (error) {
    e.preventDefault();
    const rootCause = error instanceof Error ? error.message : String(error);
    console.error("[MarkdownContent] workspace file link rejected", {
      code: "MARKDOWN_WORKSPACE_LINK_INVALID", requestId: crypto.randomUUID(),
      workspaceId: props.workspaceId ?? null, filePath: href.split(/[?#]/u)[0], rootCause,
    });
    message.error(rootCause);
  }
}

/** 复制当前代码块文本，失败时给出可见提示。 */
async function copyCodeBlock(copyBtn: HTMLButtonElement): Promise<void> {
  const block = copyBtn.closest(".code-block");
  const code = block?.querySelector("pre code");
  if (!code) return;

  try {
    await copyToClipboard(code.textContent ?? "");
    copyBtn.textContent = "已复制";
    setTimeout(() => {
      copyBtn.textContent = "复制";
    }, 1500);
  } catch {
    message.error("复制失败");
  }
}
</script>

<template>
  <div ref="contentRef" class="msg__content markdown" v-html="html" @click="handleClick" />
</template>
