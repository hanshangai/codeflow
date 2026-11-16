<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, SyncOutlined } from "@ant-design/icons-vue";
import type { ConversationProcess, ThreadId, WorkspaceId } from "@codeflowai/shared";
import { createApiResultError, type ApiRequestContext } from "../../../api/request";
import { getThreadProcess } from "../../../api/threads";
import { createProcessDetailsLoader } from "../../chat/processDetails";
import { buildAssistantRenderNodes } from "../assistantRenderNodes";
import { prepareConversationItemsForDisplay } from "../prepareConversationItems";
import ReasoningItem from "./items/reasoning-item.vue";
import ToolItem from "./items/tool-item.vue";
import DiffItem from "./items/diff-item.vue";
import ReviewItem from "./items/review-item.vue";
import ExploreItem from "./items/explore-item.vue";
import SubagentItem from "./items/subagent-item.vue";

const props = defineProps<{ item: ConversationProcess; workspaceId?: WorkspaceId; threadId?: ThreadId; apiContext?: ApiRequestContext; toolsOnly?: boolean }>();
const opened = ref(false);
const loader = createProcessDetailsLoader(async (page, signal) => {
  if (!props.workspaceId || !props.threadId || !props.apiContext) throw new Error("过程详情缺少会话读取上下文");
  const result = await getThreadProcess(props.apiContext, { workspaceId: props.workspaceId, threadId: props.threadId, processId: props.item.id, ...page }, { signal });
  if (!result.ok) throw createApiResultError(result);
  return result;
});
/** 调试工具页保留原始工具，聊天区沿既有探索与 diff 合并规则展示。 */
const entries = computed(() => props.toolsOnly
  ? loader.state.items.filter(item => item.kind === "tool").map(item => ({ key: `tool:${item.id}`, item, diff: null }))
  : buildAssistantRenderNodes(prepareConversationItemsForDisplay(loader.state.items))
  .flatMap(node => node.kind === "process-batch" ? node.entries : [{ key: node.key, item: node.item, diff: node.diff }]));

/** 读取失败由本组件显式展示并允许重试，记录所属过程及请求关联。 */
function reportFailure(error: unknown): void {
  const failure = error as { code?: string; details?: { requestId?: string; serverRequestId?: string } };
  console.error("[THREAD_PROCESS_LOAD_FAILED]", { code: failure?.code ?? "THREAD_PROCESS_LOAD_FAILED",
    requestId: failure?.details?.requestId ?? failure?.details?.serverRequestId ?? null,
    workspaceId: props.workspaceId, threadId: props.threadId, processId: props.item.id,
    cause: error instanceof Error ? error.message : String(error) });
}

/** 展开触发首次读取，收起立即撤销；不依赖子组件是否已经挂载。 */
function onToggle(event: Event): void {
  opened.value = Boolean((event.target as HTMLDetailsElement).open);
  void loader.setOpen(opened.value, props.item.version).catch(reportFailure);
}

/** 使用当前摘要版本重试失败的详情读取。 */
function retry(): void {
  loader.dispose();
  void loader.setOpen(opened.value, props.item.version).catch(reportFailure);
}

/** 大过程由用户继续读取，避免首次展开加载全部正文。 */
function loadMore(): void {
  void loader.loadMore().catch(reportFailure);
}

watch(() => props.item.version, version => { void loader.refresh(version).catch(reportFailure); });
// 逐项比较读取身份；相同上下文的新对象不能清空详情和内部展开状态。
watch([() => props.workspaceId, () => props.threadId, () => props.apiContext?.serverWsOrigin,
  () => props.apiContext?.sessionToken, () => props.apiContext?.webSessionId, () => props.apiContext?.desktopClientId], () => {
  loader.dispose();
  void loader.setOpen(opened.value, props.item.version).catch(reportFailure);
});
onBeforeUnmount(loader.dispose);
</script>

<template>
  <details class="msg msg--explore msg--collapsible msg--batch" @toggle="onToggle">
    <summary class="msg__summary-row">
      <div class="msg__summary-left">
        <span class="msg__role">过程</span>
        <span v-if="item.preview" class="msg__summary-preview">{{ item.preview }}</span>
      </div>
      <div class="msg__summary-right process-statuses">
        <span class="msg__hint-inline">{{ item.itemCount }} 条</span>
        <span v-if="item.statusCounts.done" class="msg__hint-inline"><CheckCircleFilled class="msg__status-icon msg__status-icon--done" /> 成功 {{ item.statusCounts.done }}</span>
        <span v-if="item.statusCounts.failed" class="msg__hint-inline"><CloseCircleFilled class="msg__status-icon msg__status-icon--failed" /> 失败 {{ item.statusCounts.failed }}</span>
        <span v-if="item.statusCounts.running" class="msg__hint-inline"><SyncOutlined class="msg__status-icon msg__status-icon--running" :spin="true" /> 进行中 {{ item.statusCounts.running }}</span>
        <span v-if="item.statusCounts.warning" class="msg__hint-inline"><ClockCircleOutlined class="msg__status-icon msg__status-icon--warning" /> 收尾缺失 {{ item.statusCounts.warning }}</span>
      </div>
    </summary>
    <div class="msg__body msg__batch-list">
      <a-alert v-if="loader.state.error" type="error" :message="loader.state.error" show-icon>
        <template #action><a-button size="small" :loading="loader.state.loading" @click="retry">重试</a-button></template>
      </a-alert>
      <template v-for="entry in entries" :key="entry.key">
        <ReasoningItem v-if="entry.item.kind === 'reasoning'" :item="entry.item" />
        <ToolItem v-else-if="entry.item.kind === 'tool'" :item="entry.item" :diff="entry.diff" />
        <DiffItem v-else-if="entry.item.kind === 'diff'" :item="entry.item" />
        <ReviewItem v-else-if="entry.item.kind === 'review'" :item="entry.item" />
        <ExploreItem v-else-if="entry.item.kind === 'explore'" :item="entry.item" />
        <SubagentItem v-else-if="entry.item.kind === 'subagent'" :item="entry.item" :workspace-id="workspaceId ?? null" />
      </template>
      <a-button v-if="loader.state.hasMore" size="small" :loading="loader.state.loading" @click="loadMore">加载更多过程</a-button>
    </div>
  </details>
</template>

<style scoped>
.process-statuses { flex-shrink: 1; flex-wrap: wrap; justify-content: flex-end; row-gap: 4px; }
.process-statuses > span { white-space: nowrap; }
</style>
