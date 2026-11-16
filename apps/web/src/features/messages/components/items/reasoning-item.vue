<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined } from "@ant-design/icons-vue";
import type { ConversationReasoning } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "ReasoningItem" });

type Props = {
  item: ConversationReasoning;
};

const props = defineProps<Props>();
const ui = useUiStore();

const isPlaceholderOnly = computed(() => Boolean(
  props.item.placeholder
  && !String(props.item.content ?? "").trim()
  && !String(props.item.summary ?? "").trim(),
));

// Claude CLI 只发 summaryDelta（content 为空），Codex 发 delta（content 有值）
// 若只有 placeholder，则显示临时文案，不把它当作真实 reasoning 文本持久化。
const displayContent = computed(() => {
  if (isPlaceholderOnly.value) return "思考中...";
  return props.item.content || props.item.summary || "";
});

/** summary 行预览：替换换行为空格，取前 45 字符。 */
const reasoningPreview = computed(() => {
  const text = displayContent.value.replace(/\n+/g, " ").trim();
  return text.length > 45 ? text.slice(0, 45) + "…" : text;
});

/* ---- 完整参数 ---- */
const detailsOpen = ref(false);
const copyingDetails = ref(false);

async function copyDetails(): Promise<void> {
  if (copyingDetails.value) return;
  copyingDetails.value = true;
  try {
    await copyToClipboard(JSON.stringify(props.item, null, 2));
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingDetails.value = false;
  }
}
</script>

<template>
  <details class="msg msg--reasoning msg--collapsible">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">推理</span>
        <span v-if="reasoningPreview" class="msg__summary-preview">{{ reasoningPreview }}</span>
      </div>
      <div class="msg__summary-right">
        <span class="msg__hint-inline">{{ isPlaceholderOnly ? "等待内容" : `${displayContent.length} 字符` }}</span>
      </div>
    </summary>

    <div class="msg__body">
      <pre class="msg__pre">{{ displayContent }}</pre>

      <!-- 完整参数（仅在调试侧栏开启时显示） -->
      <div v-if="ui.inspectorVisible" class="msg__approval-details">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <button type="button" class="msg__approval-details-toggle" @click="detailsOpen = !detailsOpen">
            <RightOutlined v-if="!detailsOpen" style="font-size: 10px" />
            <DownOutlined v-else style="font-size: 10px" />
            完整参数
          </button>
          <button v-show="detailsOpen" type="button" class="msg__mini-btn" @click.stop="copyDetails">
            {{ copyingDetails ? "..." : "复制 JSON" }}
          </button>
        </div>
        <pre v-show="detailsOpen" class="msg__approval-details-body">{{ JSON.stringify(item, null, 2) }}</pre>
      </div>
    </div>
  </details>
</template>

