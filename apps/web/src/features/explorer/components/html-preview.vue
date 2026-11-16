<script setup lang="ts">
import { computed } from "vue";

defineOptions({ name: "HtmlPreview" });

const props = defineProps<{
  content: string;
  filePath: string;
  /** 预览内容要求固定桌面视口时，允许外层横向查看完整页面。 */
  minViewportWidth?: number;
}>();

const srcdoc = computed(() => buildSandboxHtml(props.content));
const title = computed(() => props.filePath.split("/").pop() || props.filePath || "HTML 预览");
const minViewportWidth = computed(() => {
  const value = Number(props.minViewportWidth ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
});
const frameStyle = computed(() => minViewportWidth.value > 0
  ? {
      minWidth: `${minViewportWidth.value}px`,
      width: `max(100%, ${minViewportWidth.value}px)`,
    }
  : undefined);

/** 构造 iframe srcdoc；脚本由 sandbox 与 CSP 同时禁止，只保留静态 HTML/CSS 预览。 */
function buildSandboxHtml(content: string): string {
  const source = String(content ?? "");
  const guard = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">',
    "<style>html{background:#fff;color:#1f2937;}body{box-sizing:border-box;margin:0;padding:20px;font:14px/1.6 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}img,svg,video,canvas{max-width:100%;height:auto;}table{border-collapse:collapse;}pre{white-space:pre-wrap;overflow:auto;}</style>",
  ].join("");

  if (/<head[\s>]/iu.test(source)) {
    return source.replace(/<head([^>]*)>/iu, `<head$1>${guard}`);
  }
  if (/<html[\s>]/iu.test(source)) {
    return source.replace(/<html([^>]*)>/iu, `<html$1><head>${guard}</head>`);
  }
  return `<!doctype html><html><head>${guard}</head><body>${source}</body></html>`;
}
</script>

<template>
  <div class="html-preview" :class="{ 'html-preview--wide-viewport': minViewportWidth > 0 }">
    <iframe class="html-preview__frame" :style="frameStyle" :title="title" :srcdoc="srcdoc" sandbox="" />
  </div>
</template>

<style scoped>
.html-preview {
  height: 100%;
  min-height: 300px;
  background: var(--app-panel-bg, #fff);
}

.html-preview--wide-viewport {
  overflow: auto;
  overscroll-behavior: contain;
}

.html-preview__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
