<script setup lang="ts">
import { computed, ref } from "vue";
import { CopyOutlined, CheckOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import { copyToClipboard } from "@/composables/useClipboard";

defineOptions({ name: "CommandBlock" });

interface Props {
  command: string;
  language?: "powershell" | "cmd" | "bash" | "shell" | "url";
  copyable?: boolean;
  copyLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  language: "shell",
  copyable: true,
  copyLabel: "复制",
});

const copied = ref(false);

const languageLabel = computed(() => {
  const labels: Record<string, string> = {
    powershell: "PowerShell",
    cmd: "CMD",
    bash: "Bash",
    shell: "Shell",
    url: "URL",
  };
  return labels[props.language] || "Shell";
});

/** 转义 HTML 字符，避免 v-html 注入。 */
function escapeHtml(text: unknown): string {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const highlightedCommand = computed(() => {
  return escapeHtml(props.command).replace(
    /\{\{([^}]+)\}\}/g,
    '<span class="cb__placeholder">{{$1}}</span>',
  );
});

async function copyCommand() {
  try {
    await copyToClipboard(props.command);
    copied.value = true;
    message.success("已复制到剪贴板");
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    message.error("复制失败");
  }
}
</script>

<template>
  <div class="cb">
    <div class="cb__header">
      <span class="cb__lang">{{ languageLabel }}</span>
      <button v-if="copyable" class="cb__copy" type="button" :aria-label="copied ? '已复制' : copyLabel" @click="copyCommand">
        <CheckOutlined v-if="copied" style="color: #52c41a" />
        <CopyOutlined v-else />
        {{ copied ? "已复制" : copyLabel }}
      </button>
    </div>
    <div class="cb__body">
      <pre><code v-html="highlightedCommand"></code></pre>
    </div>
  </div>
</template>

<style scoped>
.cb {
  margin: 8px 0;
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e1e;
}

.cb__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 14px;
  background: #2d2d2d;
  border-bottom: 1px solid #3e3e3e;
}

.cb__lang {
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
  font-weight: 600;
  letter-spacing: 0.5px;
}

.cb__copy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  background: rgba(255, 255, 255, 0.12);
  color: #f0f0f0;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s, color 0.2s;
  padding: 4px 10px;
  border-radius: 6px;
}

.cb__copy:hover {
  border-color: rgba(255, 255, 255, 0.38);
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

.cb__body {
  padding: 12px 14px;
}

.cb__body pre {
  margin: 0;
  font-family: "SF Mono", "Fira Code", "Cascadia Code", "Consolas", monospace;
  font-size: 12.5px;
  line-height: 1.65;
  color: #d4d4d4;
  white-space: pre-wrap;
  word-break: break-all;
}

.cb__body code {
  font-family: inherit;
}

.cb__body :deep(.cb__placeholder) {
  color: #4ec9b0;
  background: rgba(78, 201, 176, 0.15);
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
}
</style>
