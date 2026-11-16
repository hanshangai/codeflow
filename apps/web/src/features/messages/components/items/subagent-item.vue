<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined, CheckCircleFilled, SyncOutlined, CloseCircleFilled } from "@ant-design/icons-vue";
import type { ConversationSubagent, WorkspaceId } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useUiStore } from "../../../../store/ui";
import MessagesList from "../messages-list.vue";

defineOptions({ name: "SubagentItem" });

type Props = { item: ConversationSubagent; workspaceId?: WorkspaceId | null };
const props = defineProps<Props>();
const ui = useUiStore();

const preview = computed(() => {
  if (props.item.status === "running" && props.item.lastToolName) {
    return `${props.item.description} - ${props.item.lastToolName}`;
  }
  // summary 行只显示 description（短文本），完整 summary 在展开后的 body 里查看
  return props.item.description;
});

const usageText = computed(() => {
  const u = props.item.usage;
  if (!u) return "";
  const parts: string[] = [];
  if (u.totalTokens) parts.push(`${u.totalTokens} tokens`);
  if (u.toolUses) parts.push(`${u.toolUses} 次工具调用`);
  if (u.durationMs) parts.push(`${(u.durationMs / 1000).toFixed(1)}s`);
  return parts.join(" / ");
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

/* ---- 子任务详情 Popover ---- */
const detailPopOpen = ref(false);
const detailTitle = computed(() => props.item.description || props.item.taskId || "子任务详情");

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth <= 767;
}
</script>

<template>
  <details class="msg msg--subagent msg--collapsible">
    <summary class="msg__summary-row subagent-item__summary">
      <div class="msg__summary-left subagent-item__summary-left">
        <span class="msg__role">子任务</span>
        <span v-if="item.taskType" class="msg__title" style="margin: 0">{{ item.taskType }}</span>
        <span v-if="preview" class="msg__summary-preview subagent-item__summary-preview">{{ preview }}</span>
      </div>
      <div class="msg__summary-right subagent-item__summary-right">
        <a-button
          v-if="isMobileViewport() && item.children?.length"
          size="small"
          type="link"
          @click.stop="detailPopOpen = true"
        >查看 ({{ item.children.length }})</a-button>
        <a-popover
          v-else-if="item.children?.length"
          :open="detailPopOpen"
          trigger="click"
          placement="leftTop"
          :overlay-style="{ maxWidth: '620px', minWidth: '400px', maxHeight: '65vh' }"
          @open-change="(v: boolean) => (detailPopOpen = v)"
        >
          <template #content>
            <div class="subagent-pop">
              <div class="subagent-pop__header">
                <span class="subagent-pop__title">{{ detailTitle }}</span>
                <span v-if="usageText" class="subagent-pop__usage">{{ usageText }}</span>
              </div>
              <div class="subagent-pop__body">
                <MessagesList :items="item.children" engine="claude" :workspace-id="props.workspaceId ?? undefined" />
              </div>
            </div>
          </template>
          <a-button size="small" type="link" @click.stop>查看 ({{ item.children.length }})</a-button>
        </a-popover>
        <span v-if="usageText" class="msg__hint-inline subagent-item__usage-inline">{{ usageText }}</span>
        <CheckCircleFilled v-if="item.status === 'completed'" class="msg__status-icon msg__status-icon--done" />
        <SyncOutlined v-else-if="item.status === 'running'" class="msg__status-icon msg__status-icon--running" :spin="true" />
        <CloseCircleFilled v-else-if="item.status === 'failed' || item.status === 'stopped'" class="msg__status-icon msg__status-icon--failed" />
      </div>
    </summary>

    <div class="msg__body">
      <pre v-if="item.summary" class="msg__pre">{{ item.summary }}</pre>

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

  <a-drawer
    v-if="isMobileViewport() && item.children?.length"
    :open="detailPopOpen"
    :title="detailTitle"
    placement="bottom"
    height="85vh"
    :body-style="{
      padding: '12px 12px 8px',
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      minHeight: '0',
    }"
    @close="detailPopOpen = false"
  >
    <div class="subagent-modal">
      <div v-if="usageText" class="subagent-modal__usage">{{ usageText }}</div>
      <div class="subagent-modal__body">
        <MessagesList :items="item.children" engine="claude" :workspace-id="props.workspaceId ?? undefined" />
      </div>
    </div>
  </a-drawer>

</template>

<style scoped>
.subagent-pop {
  display: flex;
  flex-direction: column;
  max-height: 60vh;
}

.subagent-pop__header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding-bottom: 8px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--app-border, #f0f0f0);
}

.subagent-pop__title {
  font-weight: 600;
  font-size: 13px;
  flex: 1 1 auto;
  min-width: 0;
  white-space: normal;
  word-break: break-word;
}

.subagent-pop__usage {
  flex: 1 1 100%;
  font-size: 12px;
  color: var(--app-muted, #999);
  white-space: normal;
  word-break: break-word;
}

.subagent-pop__body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding-top: 4px;
}

.subagent-modal {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

.subagent-modal__usage {
  font-size: 12px;
  color: var(--app-muted, #999);
  word-break: break-word;
  flex: 0 0 auto;
}

.subagent-modal__body {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.subagent-modal__body :deep(.messages),
.subagent-modal__body :deep(.virtual-group),
.subagent-modal__body :deep(.msg-row),
.subagent-modal__body :deep(.msg-row__content),
.subagent-modal__body :deep(.msg) {
  min-width: 0;
}

/*
 * 子任务详情内复用 message-item。
 * 其底部操作条默认用负 margin 拉满卡片宽度，在 drawer 窄容器里会把内容撑出 4px 左右，
 * 触发横向滚动条。这里改为常规内边距，不影响主聊天区的展示。
 */
.subagent-modal__body :deep(.msg__actions) {
  margin-left: 0;
  margin-right: 0;
  padding-left: 0;
  padding-right: 0;
}

@media (max-width: 767px) {
  .subagent-item__summary {
    align-items: flex-start;
    gap: 8px;
    line-height: 1.35;
  }

  .subagent-item__summary-left {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    gap: 4px 8px;
    align-items: flex-start;
    flex-wrap: nowrap;
  }

  .subagent-item__summary-right {
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    min-height: 24px;
  }

  .subagent-item__summary-preview {
    flex: 1 1 auto;
    min-width: 0;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subagent-item__usage-inline {
    display: none;
  }
}
</style>

