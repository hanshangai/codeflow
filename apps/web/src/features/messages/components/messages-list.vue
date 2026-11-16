<script setup lang="ts">
import { computed, isReactive, provide, ref, type ComputedRef } from "vue";
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, SyncOutlined } from "@ant-design/icons-vue";
import type {
  ConversationMessage,
  ConversationSystemMessage,
  EngineType,
  TurnId,
  WorkspaceId,
  ThreadId,
} from "@codeflowai/shared";

import MessageItem from "./items/message-item.vue";
import ProcessDetails from "./process-details.vue";
import type { ApiRequestContext } from "../../../api/request";
import SystemMessageItem from "./items/system-message-item.vue";
import ReasoningItem from "./items/reasoning-item.vue";
import ToolItem from "./items/tool-item.vue";
import DiffItem from "./items/diff-item.vue";
import ReviewItem from "./items/review-item.vue";
import ExploreItem from "./items/explore-item.vue";
import ApprovalRequestItem from "./items/approval-request-item.vue";
import UserInputRequestItem from "./items/user-input-request-item.vue";
import SubagentItem from "./items/subagent-item.vue";
import RequirementAnalysisItem from "./items/requirement-analysis-item.vue";
import VirtualGroup from "./virtual-group.vue";
import IconClaude from "@/shared/icons/IconClaude.vue";
import IconCodex from "@/shared/icons/IconCodex.vue";
import { buildAssistantRenderNodes, type AssistantRenderNode } from "../assistantRenderNodes";
import { markProcessBatchRendered } from "../processBatchRendering";
import type { DisplayConversationItem } from "../prepareConversationItems";

defineOptions({ name: "MessagesList" });

type Props = {
  items: DisplayConversationItem[];
  engine?: EngineType;
  workspaceId?: WorkspaceId;
  threadId?: ThreadId;
  apiContext?: ApiRequestContext;
  processCacheEpoch?: number;
  /** 已完成的 turnId 集合：用于控制“回滚”按钮仅对 completed turn 生效。 */
  completedTurnIds?: Record<string, true>;
  /** 操作中：禁用回滚等写操作按钮。 */
  busy?: boolean;
  canDelete?: boolean;
  deletingMessageId?: string | null;
};

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "rollback", turnId: TurnId): void;
  (e: "closeSystemMessage", id: string): void;
  (e: "deleteMessage", itemId: string): void;
}>();

const heightCache = new Map<string, number>();
provide("virtualHeightCache", heightCache);

/** 已展开过（因而需要渲染内容）的过程块 key：折叠时只渲染摘要，避免挂载大量子组件及其挂载期请求。 */
const renderedProcessBatches = ref<ReadonlySet<string>>(new Set());
/** 记录过程块首次展开；只增不减，收起后保留内容以免反复挂载。 */
function onProcessBatchToggle(key: string, event: Event): void {
  renderedProcessBatches.value = markProcessBatchRendered(
    renderedProcessBatches.value,
    key,
    Boolean((event.target as HTMLDetailsElement | null)?.open),
  );
}

const engineLabel = computed(() => {
  const eng = props.engine ?? "codex";
  return eng === "claude" ? "CC" : "CX";
});

/**
 * 将平铺的 ConversationItem[] 按“用户消息分隔”分组：
 * - 用户消息单独一行（独立 avatar）
 * - 系统消息独立一行（无 avatar）
 * - 连续的 assistant 相关 item（tool / diff / explore / reasoning / review / approvalRequest / userInputRequest / assistant message）
 *   合并为一个 assistant-group，共享一个 CX avatar（避免 tool 在 assistant 文本之后出现时被拆成两条聊天）。
 */
type DisplayGroup =
  | { type: "user"; key: string; item: ConversationMessage }
  | { type: "system"; key: string; item: ConversationSystemMessage }
  | { type: "assistant-group"; key: string; items: DisplayConversationItem[] };

/** 为同级消息组生成带类型命名空间的 Vue key，避免不同 item 类型 id 碰撞。 */
function groupKeyForItem(item: DisplayConversationItem, groupType: DisplayGroup["type"]): string {
  return `${groupType}:${String(item.kind)}:${String(item.id)}`;
}

const groupedItems = computed<DisplayGroup[]>(() => {
  const groups: DisplayGroup[] = [];
  let pending: DisplayConversationItem[] = [];

  function flush(): void {
    if (pending.length > 0) {
      // 用首个 itemId 作为稳定 key：避免流式过程中追加 tool/diff 导致整组被 Vue 当作新节点重建。
      const key = groupKeyForItem(pending[0]!, "assistant-group");
      groups.push({ type: "assistant-group", key, items: [...pending] });
      pending = [];
    }
  }

  for (const item of props.items) {
    if (item.kind === "message" && item.role === "user") {
      flush();
      groups.push({ type: "user", key: groupKeyForItem(item, "user"), item });
    } else if (item.kind === "systemMessage") {
      flush();
      groups.push({ type: "system", key: groupKeyForItem(item, "system"), item });
    } else {
      pending.push(item);
    }
  }

  flush();
  return groups;
});

/** 最后 N 个 group 始终渲染（streaming 底部区域不虚拟化）。 */
const ALWAYS_RENDER_TAIL = 20;
const alwaysRenderIndex = computed(() => Math.max(0, groupedItems.value.length - ALWAYS_RENDER_TAIL));

const assistantNodesByFirstItem = new WeakMap<DisplayConversationItem, {
  items: DisplayConversationItem[];
  nodes: ComputedRef<AssistantRenderNode[]>;
}>();

/** 响应式成员按组缓存；普通或混合输入随父级更新即时派生，避免引用相同而展示过期。 */
function assistantNodesForItems(items: DisplayConversationItem[]): AssistantRenderNode[] {
  if (!items.every(item => isReactive(item))) return buildAssistantRenderNodes(items);
  const first = items[0]!;
  let cached = assistantNodesByFirstItem.get(first);
  if (!cached || cached.items.length !== items.length || items.some((item, index) => item !== cached!.items[index])) {
    cached = { items, nodes: computed(() => buildAssistantRenderNodes(items)) };
    assistantNodesByFirstItem.set(first, cached);
  }
  return cached.nodes.value;
}

const assistantRenderNodesMap = computed(() => {
  const map = new Map<string, AssistantRenderNode[]>();
  for (const group of groupedItems.value) {
    if (group.type !== "assistant-group") continue;
    map.set(group.key, assistantNodesForItems(group.items));
  }
  return map;
});

function getAssistantRenderNodes(groupKey: string): AssistantRenderNode[] {
  return assistantRenderNodesMap.value.get(groupKey) ?? [];
}
</script>

<template>
  <div class="messages">
    <VirtualGroup
      v-for="(group, gIdx) in groupedItems"
      :key="group.key"
      :group-key="group.key"
      :always-render="gIdx >= alwaysRenderIndex"
    >
      <!-- 用户消息：独立行 -->
      <MessageItem
        v-if="group.type === 'user'"
        :item="group.item"
        :engine="engine"
        :workspace-id="props.workspaceId ?? null"
        :can-rollback="Boolean(group.item.turnId && props.completedTurnIds?.[String(group.item.turnId)])"
        :busy="props.busy"
        :can-delete="props.canDelete"
        :delete-busy="props.deletingMessageId === String(group.item.id)"
        @rollback="(id) => emit('rollback', id)"
        @delete-message="(id) => emit('deleteMessage', id)"
      />

      <!-- 系统消息：独立行 -->
      <SystemMessageItem
        v-else-if="group.type === 'system'"
        :item="group.item"
        @close="(id) => emit('closeSystemMessage', id)"
      />

      <!-- Assistant 分组：共享 avatar -->
      <div v-else class="msg-row msg-row--assistant">
        <div class="msg-avatar msg-avatar--assistant" :class="`msg-avatar--${engine ?? 'codex'}`">
          <IconClaude v-if="engine === 'claude'" :size="18" />
          <IconCodex v-else :size="16" />
        </div>
        <div class="msg-row__content">
          <template v-for="node in getAssistantRenderNodes(group.key)" :key="node.key">
            <MessageItem
              v-if="node.kind === 'item' && node.item.kind === 'message'"
              :item="node.item"
              :engine="engine"
              :workspace-id="props.workspaceId ?? null"
              :busy="props.busy"
              :can-delete="props.canDelete"
              :delete-busy="props.deletingMessageId === String(node.item.id)"
              @delete-message="(id) => emit('deleteMessage', id)"
              bare
            />
            <ReasoningItem v-else-if="node.kind === 'item' && node.item.kind === 'reasoning'" :item="node.item" />
            <ProcessDetails
              v-else-if="node.kind === 'item' && node.item.kind === 'process'"
              :key="`${props.workspaceId}:${props.threadId}:${props.processCacheEpoch ?? 0}:${node.item.id}`"
              :item="node.item"
              :workspace-id="props.workspaceId"
              :thread-id="props.threadId"
              :api-context="props.apiContext"
            />
            <details v-else-if="node.kind === 'process-batch'" class="msg msg--explore msg--collapsible msg--batch" @toggle="onProcessBatchToggle(node.key, $event)">
              <summary class="msg__summary-row">
                <div class="msg__summary-left">
                  <span class="msg__role">过程</span>
                  <span v-if="node.preview" class="msg__summary-preview">{{ node.preview }}</span>
                </div>
                <div class="msg__summary-right msg__batch-statuses">
                  <span class="msg__hint-inline">{{ node.entries.length }} 条</span>
                  <span v-if="node.statusCounts.done" class="msg__hint-inline">
                    <CheckCircleFilled class="msg__status-icon msg__status-icon--done" /> 成功 {{ node.statusCounts.done }}
                  </span>
                  <span v-if="node.statusCounts.failed" class="msg__hint-inline">
                    <CloseCircleFilled class="msg__status-icon msg__status-icon--failed" /> 失败 {{ node.statusCounts.failed }}
                  </span>
                  <span v-if="node.statusCounts.running" class="msg__hint-inline">
                    <SyncOutlined class="msg__status-icon msg__status-icon--running" :spin="true" /> 进行中 {{ node.statusCounts.running }}
                  </span>
                  <span v-if="node.statusCounts.warning" class="msg__hint-inline">
                    <ClockCircleOutlined class="msg__status-icon msg__status-icon--warning" /> 收尾缺失 {{ node.statusCounts.warning }}
                  </span>
                </div>
              </summary>
              <div v-if="renderedProcessBatches.has(node.key)" class="msg__body msg__batch-list">
                <template
                  v-for="entry in node.entries"
                  :key="entry.key"
                >
                  <ReasoningItem v-if="entry.item.kind === 'reasoning'" :item="entry.item" />
                  <ToolItem v-else-if="entry.item.kind === 'tool'" :item="entry.item" :diff="entry.diff ?? null" />
                  <DiffItem v-else-if="entry.item.kind === 'diff'" :item="entry.item" />
                  <ReviewItem v-else-if="entry.item.kind === 'review'" :item="entry.item" />
                  <ExploreItem v-else-if="entry.item.kind === 'explore'" :item="entry.item" />
                  <SubagentItem v-else-if="entry.item.kind === 'subagent'" :item="entry.item" :workspace-id="props.workspaceId ?? null" />
                  <ApprovalRequestItem v-else-if="entry.item.kind === 'approvalRequest'" :item="entry.item" :workspace-id="props.workspaceId" />
                  <UserInputRequestItem v-else-if="entry.item.kind === 'userInputRequest'" :item="entry.item" :workspace-id="props.workspaceId" />
                </template>
              </div>
            </details>
            <ToolItem
              v-else-if="node.kind === 'item' && node.item.kind === 'tool'"
              :item="node.item"
              :diff="node.diff ?? null"
            />
            <DiffItem v-else-if="node.kind === 'item' && node.item.kind === 'diff'" :item="node.item" />
            <ReviewItem v-else-if="node.kind === 'item' && node.item.kind === 'review'" :item="node.item" />
            <ExploreItem v-else-if="node.kind === 'item' && node.item.kind === 'explore'" :item="node.item" />
            <SubagentItem v-else-if="node.kind === 'item' && node.item.kind === 'subagent'" :item="node.item" :workspace-id="props.workspaceId ?? null" />
            <ApprovalRequestItem v-else-if="node.kind === 'item' && node.item.kind === 'approvalRequest'" :item="node.item" :workspace-id="props.workspaceId" />
            <UserInputRequestItem v-else-if="node.kind === 'item' && node.item.kind === 'userInputRequest'" :item="node.item" :workspace-id="props.workspaceId" />
            <RequirementAnalysisItem v-else-if="node.kind === 'item' && node.item.kind === 'requirementAnalysis'" :item="node.item" />
          </template>
        </div>
      </div>
    </VirtualGroup>
  </div>
</template>

<style scoped>
.msg__batch-statuses {
  flex-shrink: 1;
  flex-wrap: wrap;
  justify-content: flex-end;
  row-gap: 4px;
}

.msg__batch-statuses > span {
  white-space: nowrap;
}
</style>

