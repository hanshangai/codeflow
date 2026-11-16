<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined, CheckCircleFilled, SyncOutlined } from "@ant-design/icons-vue";
import type { ConversationExplore } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";

defineOptions({ name: "ExploreItem" });

type Props = {
  item: ConversationExplore;
};

const props = defineProps<Props>();
const ui = useUiStore();

/** summary 行预览：取前 3 个 entry 的 label，逗号拼接，超出截断。 */
const explorePreview = computed(() => {
  const entries = props.item.entries;
  if (!entries?.length) return "";
  const labels = entries.slice(0, 3).map((e) => e.label).filter(Boolean);
  const text = labels.join("、");
  return entries.length > 3 ? `${text}…` : text;
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
  <details class="msg msg--explore msg--collapsible">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">探索</span>
        <span v-if="explorePreview" class="msg__summary-preview">{{ explorePreview }}</span>
      </div>
      <div class="msg__summary-right">
        <span class="msg__hint-inline">{{ item.entries.length }} 步</span>
        <CheckCircleFilled v-if="item.status === 'explored'" class="msg__status-icon msg__status-icon--done" />
        <SyncOutlined v-else class="msg__status-icon msg__status-icon--running" :spin="true" />
      </div>
    </summary>

    <div class="msg__body">
      <div class="msg__content">
        <div v-for="(e, idx) in item.entries" :key="`${item.id}_${idx}`" class="msg__entry">
          <span class="msg__entry-kind">{{ e.kind }}</span>
          <span class="msg__entry-label">{{ e.label }}</span>
          <span v-if="e.detail" class="msg__entry-detail">- {{ e.detail }}</span>
        </div>
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

