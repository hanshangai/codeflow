<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { CalendarOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type { ConversationMessage, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { getConversationItemsForMessageList } from "../../chat/chatTypes";
import { useApiContext } from "../../../composables/useApiContext";
import { useChatStore } from "../../../store/chat";

defineOptions({ name: "H5ThreadHistoryPanel" });

type DateScope = "all" | "today" | "7" | "30" | "custom";

const DATE_SCOPE_OPTIONS: Array<{ key: DateScope; label: string }> = [
  { key: "all", label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "7", label: "近 7 天" },
  { key: "30", label: "近 30 天" },
  { key: "custom", label: "自定义" },
];

const props = defineProps<{ workspaceId: WorkspaceId; threadId: ThreadId }>();
const emit = defineEmits<{ (event: "locate", messageId: string): void }>();
const { ctx } = useApiContext();
const chat = useChatStore();
const query = ref("");
const dateScope = ref<DateScope>("all");
const startDate = ref("");
const endDate = ref("");
const loadError = ref("");

const loadMeta = computed(() => chat.threadLoadMetaByThreadId[String(props.threadId)] ?? null);
const hasMore = computed(() => Boolean(loadMeta.value?.hasMore));
const loadingMore = computed(() => Boolean(loadMeta.value?.loadingMore));

const messages = computed<ConversationMessage[]>(() => {
  const conversation = chat.threadDisplayConversationForThread(props.threadId);
  return getConversationItemsForMessageList(conversation)
    .filter((item): item is ConversationMessage => item.kind === "message" && Boolean(item.text.trim()))
    .slice()
    .reverse();
});

/** 按当前日期范围判断消息是否应进入搜索结果。 */
function matchesDate(message: ConversationMessage): boolean {
  if (dateScope.value === "all") return true;
  const createdAt = Number(message.createdAt ?? 0);
  if (!createdAt) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (dateScope.value === "today") return createdAt >= startOfToday;
  if (dateScope.value === "7" || dateScope.value === "30") {
    return createdAt >= startOfToday - (Number(dateScope.value) - 1) * 86_400_000;
  }
  const start = startDate.value ? new Date(`${startDate.value}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = endDate.value ? new Date(`${endDate.value}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  return createdAt >= start && createdAt <= end;
}

const results = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return messages.value.filter((message) => matchesDate(message) && (!keyword || message.text.toLowerCase().includes(keyword)));
});

/** 格式化消息时间，缺少历史时间时明确显示未知。 */
function formatMessageTime(createdAt?: number): string {
  if (!createdAt) return "时间未知";
  return new Date(createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** 选择日期范围并保留自定义日期输入，便于用户来回比较结果。 */
function selectDateScope(scope: DateScope): void {
  dateScope.value = scope;
}

/** 通过会话 Store 加载更早一页历史，搜索范围随已加载内容同步扩展。 */
async function loadEarlierMessages(): Promise<void> {
  if (!hasMore.value || loadingMore.value) return;
  loadError.value = "";
  try {
    await chat.loadThreadPage(ctx.value, { workspaceId: props.workspaceId, threadId: props.threadId });
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
    message.error(`更早历史加载失败：${loadError.value}`);
  }
}
</script>

<template>
  <section class="h5-thread-history" aria-label="搜索会话历史">
    <div class="h5-thread-history__tools">
      <label class="h5-thread-history__search">
        <SearchOutlined />
        <input v-model="query" type="search" autocomplete="off" placeholder="搜索当前会话中的消息" />
        <button v-if="query" type="button" @click="query = ''">清除</button>
      </label>
      <div class="h5-thread-history__scopes" role="group" aria-label="历史消息日期范围">
        <button v-for="item in DATE_SCOPE_OPTIONS" :key="item.key" type="button" :class="{ active: dateScope === item.key }" @click="selectDateScope(item.key)">
          <CalendarOutlined v-if="item.key === 'custom'" />{{ item.label }}
        </button>
      </div>
      <div v-if="dateScope === 'custom'" class="h5-thread-history__dates">
        <input v-model="startDate" type="date" aria-label="开始日期" />
        <span>至</span>
        <input v-model="endDate" type="date" aria-label="结束日期" />
      </div>
    </div>

    <div class="h5-thread-history__results">
      <div v-if="hasMore || loadError" class="h5-thread-history__range">
        <span>{{ loadError || "当前搜索已加载的消息" }}</span>
        <button v-if="hasMore" type="button" :disabled="loadingMore" @click="loadEarlierMessages">
          {{ loadingMore ? "加载中" : "加载更早消息" }}
        </button>
      </div>
      <button v-for="item in results" :key="String(item.id)" type="button" @click="emit('locate', String(item.id))">
        <span class="h5-thread-history__avatar" :class="{ user: item.role === 'user' }">{{ item.role === 'user' ? '我' : 'CF' }}</span>
        <span><strong>{{ item.role === 'user' ? '我' : 'CodeFlow' }}</strong><small>{{ formatMessageTime(item.createdAt) }}</small><p>{{ item.text }}</p></span>
      </button>
      <a-empty v-if="results.length === 0" description="没有符合条件的历史消息" />
    </div>
  </section>
</template>

<style scoped>
.h5-thread-history { height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: color-mix(in srgb, var(--app-bg) 94%, var(--app-surface)); }
.h5-thread-history__tools { flex: 0 0 auto; display: grid; gap: 10px; padding: 12px; border-bottom: 1px solid var(--app-divider); }
.h5-thread-history__search { min-height: 46px; display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--app-border); border-radius: 15px; background: var(--app-panel-bg); }
.h5-thread-history__search input { min-width: 0; border: 0; outline: 0; color: var(--app-text); background: transparent; font-size: 14px; }
.h5-thread-history__search button { min-height: 44px; border: 0; color: var(--app-accent); background: transparent; }
.h5-thread-history__scopes { display: flex; gap: 7px; overflow-x: auto; scrollbar-width: none; }
.h5-thread-history__scopes button { flex: 0 0 auto; min-height: 40px; padding: 0 12px; border: 1px solid var(--app-border); border-radius: 12px; color: var(--app-muted); background: var(--app-panel-bg); }
.h5-thread-history__scopes button.active { color: var(--app-accent); border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border)); background: color-mix(in srgb, var(--app-accent) 9%, var(--app-panel-bg)); font-weight: 650; }
.h5-thread-history__dates { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 8px; }
.h5-thread-history__dates input { min-width: 0; min-height: 44px; padding: 0 8px; border: 1px solid var(--app-border); border-radius: 12px; color: var(--app-text); background: var(--app-panel-bg); }
.h5-thread-history__results { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; }
.h5-thread-history__range { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 4px 8px; color: var(--app-muted); font-size: 12px; }
.h5-thread-history__range button { flex: 0 0 auto; min-height: 40px; padding: 0 10px; border: 0; border-radius: 11px; color: var(--app-accent); background: color-mix(in srgb, var(--app-accent) 9%, transparent); font-weight: 650; }
.h5-thread-history__range button:disabled { opacity: 0.55; }
.h5-thread-history__results > button { width: 100%; min-height: 92px; display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 10px; padding: 12px 4px; border: 0; border-bottom: 1px solid var(--app-divider); color: var(--app-text); background: transparent; text-align: left; }
.h5-thread-history__avatar { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; color: #fff; background: #258466; font-size: 12px; font-weight: 700; }
.h5-thread-history__avatar.user { background: var(--app-accent); }
.h5-thread-history__results strong, .h5-thread-history__results small { display: block; }
.h5-thread-history__results small { margin-top: 2px; color: var(--app-muted); font-size: 11px; }
.h5-thread-history__results p { display: -webkit-box; overflow: hidden; margin: 7px 0 0; color: var(--app-text); font-size: 13px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
</style>
