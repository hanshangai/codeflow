<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined, CheckCircleFilled, SyncOutlined } from "@ant-design/icons-vue";
import type { ConversationReview } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "ReviewItem" });

type Props = {
  item: ConversationReview;
};

const props = defineProps<Props>();
const ui = useUiStore();

/** summary 行预览：取审查文本前 45 字符。 */
const reviewPreview = computed(() => {
  const text = (props.item.text ?? "").replace(/\n+/g, " ").trim();
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
  <details class="msg msg--review msg--collapsible">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">审查</span>
        <span v-if="reviewPreview" class="msg__summary-preview">{{ reviewPreview }}</span>
      </div>
      <div class="msg__summary-right">
        <CheckCircleFilled v-if="item.state === 'completed'" class="msg__status-icon msg__status-icon--done" />
        <SyncOutlined v-else class="msg__status-icon msg__status-icon--running" :spin="true" />
      </div>
    </summary>

    <div class="msg__body">
      <div class="msg__content">{{ item.text }}</div>

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

