<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined } from "@ant-design/icons-vue";
import type { ConversationDiff } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "DiffItem" });

type Props = {
  item: ConversationDiff;
};

const props = defineProps<Props>();
const ui = useUiStore();

const lines = computed(() => String(props.item.diff ?? "").split(/\r?\n/g));

const copying = ref(false);

/** 复制 diff 到剪贴板（仅浏览器端）。 */
async function copyDiff(): Promise<void> {
  if (copying.value) return;
  copying.value = true;
  try {
    await copyToClipboard(props.item.diff ?? "");
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copying.value = false;
  }
}

function lineClass(line: string): string {
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff ")) return "diff-line--meta";
  if (line.startsWith("@@")) return "diff-line--hunk";
  if (line.startsWith("+")) return "diff-line--add";
  if (line.startsWith("-")) return "diff-line--del";
  return "";
}

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
  <details class="msg msg--diff msg--collapsible">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">变更</span>
        <span class="msg__title" style="margin: 0">{{ item.title }}</span>
      </div>
      <div class="msg__summary-right">
        <a-button size="small" type="text" :loading="copying" @click.stop="copyDiff">复制</a-button>
      </div>
    </summary>

    <div class="msg__body">
      <div class="diff-view">
        <div v-for="(line, idx) in lines" :key="`${idx}_${line}`" class="diff-line" :class="lineClass(line)">{{ line }}</div>
      </div>

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

