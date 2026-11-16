<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { AimOutlined, DownOutlined, MessageOutlined, MinusOutlined, UpOutlined } from "@ant-design/icons-vue";

import AccountAvatar from "../../account/components/account-avatar.vue";
import MessageImageThumbs from "../../messages/components/message-image-thumbs.vue";
import { useConfigStore } from "../../../store/config";

/**
 * 会话流顶部的用户消息浮窗：展示当前选中的用户消息，
 * 并提供「定位 / 上一条 / 下一条 / 收起」四个动作。本身不持有状态，全部由父组件驱动。
 */
const props = defineProps<{
  text: string;
  images?: string[];
  /** 当前是第几条用户消息（1-based）与总数，用于收起态角标。 */
  index: number;
  total: number;
  collapsed: boolean;
  /** 正在向更早的历史补载以找到最近一条用户消息；此期间只展示占位。 */
  loading?: boolean;
}>();

const emit = defineEmits<{
  locate: [];
  prev: [];
  next: [];
  toggleCollapse: [];
}>();

const config = useConfigStore();
// 与消息气泡取同一份用户资料，保证两处头像一致。
const userDisplayName = computed(() => config.userSummary?.fullName?.trim() || "用户");
const userAvatarUrl = computed(() => config.userSummary?.avatarUrl ?? null);

const textEl = ref<HTMLElement | null>(null);
/** 正文只有一行，被截断时才挂 title 提示全文；没截断就不要平白弹提示。 */
const textTruncated = ref(false);

function syncTextTruncated(): void {
  const el = textEl.value;
  textTruncated.value = Boolean(el && el.scrollHeight > el.clientHeight + 1);
}

let textResizeObserver: ResizeObserver | null = null;
onMounted(() => {
  syncTextTruncated();
  if (typeof ResizeObserver !== "undefined" && textEl.value) {
    textResizeObserver = new ResizeObserver(syncTextTruncated);
    textResizeObserver.observe(textEl.value);
  }
});
onBeforeUnmount(() => {
  textResizeObserver?.disconnect();
  textResizeObserver = null;
});
// 换消息或改窗口宽度都会改变可容纳的字数，重新判定一次。
watch(() => props.text, () => { void nextTick(syncTextTruncated); }, { flush: "post" });

/** 最多展示三张缩略图，其余折叠成 +N，避免浮窗被图片撑高。 */
const MAX_THUMBS = 3;
const visibleImages = computed(() => (props.images ?? []).slice(0, MAX_THUMBS));
const hiddenImageCount = computed(() => Math.max(0, (props.images?.length ?? 0) - MAX_THUMBS));

</script>

<template>
  <button
    v-if="collapsed"
    type="button"
    class="chat-user-msg-float chat-user-msg-float--collapsed"
    :aria-label="`展开用户消息浮窗（第 ${index} / ${total} 条）`"
    @click="emit('toggleCollapse')"
  >
    <MessageOutlined />
    <span class="chat-user-msg-float__badge">{{ index }}/{{ total }}</span>
    <DownOutlined class="chat-user-msg-float__caret" />
  </button>

  <section v-else class="chat-user-msg-float" aria-label="用户消息浮窗">
    <div class="chat-user-msg-float__avatar">
      <AccountAvatar :display-name="userDisplayName" :avatar-url="userAvatarUrl" :size="28" />
    </div>

    <MessageImageThumbs
      v-if="visibleImages.length"
      :images="visibleImages"
      alt-prefix="user"
      class="chat-user-msg-float__thumbs"
    />
    <span v-if="hiddenImageCount" class="chat-user-msg-float__thumb-more">+{{ hiddenImageCount }}</span>

    <div class="chat-user-msg-float__body">
      <p v-if="text" ref="textEl" class="chat-user-msg-float__text" :title="textTruncated ? text : undefined">{{ text }}</p>
      <p v-else class="chat-user-msg-float__text chat-user-msg-float__text--placeholder">
        {{ loading ? "正在定位最近的消息…" : "当前会话还没有您的消息" }}
      </p>
    </div>

    <div class="chat-user-msg-float__actions">
      <button
        type="button"
        class="chat-user-msg-float__action"
        title="定位到该消息"
        aria-label="定位到该消息"
        :disabled="!text"
        @click="emit('locate')"
      >
        <AimOutlined />
      </button>
      <button
        type="button"
        class="chat-user-msg-float__action"
        title="上一条用户消息"
        aria-label="上一条用户消息"
        :disabled="!text"
        @click="emit('prev')"
      >
        <UpOutlined />
      </button>
      <button
        type="button"
        class="chat-user-msg-float__action"
        title="下一条用户消息"
        aria-label="下一条用户消息"
        :disabled="!text"
        @click="emit('next')"
      >
        <DownOutlined />
      </button>
      <button
        type="button"
        class="chat-user-msg-float__action"
        title="收起浮窗"
        aria-label="收起浮窗"
        @click="emit('toggleCollapse')"
      >
        <MinusOutlined />
      </button>
    </div>
  </section>
</template>

<style scoped>
/* 占位在消息区顶部、左右通栏的一行：不覆盖任何消息内容；缩略图通过变量收窄到紧凑规格 */
.chat-user-msg-float {
  flex: none;
  height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  /* 左内边距对齐消息区的 padding-left，让头像与消息流里的头像同一条竖线 */
  padding: 0 10px 0 16px;
  border: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 60%, transparent);
  border-radius: 0;
  /* 浮窗独占消息区上方一行，背后没有可模糊的内容，磨玻璃看不出效果，直接用纯透明底。 */
  background: transparent;
  --msg-image-thumb-size: 36px;
}

.chat-user-msg-float__avatar {
  flex: none;
  display: inline-flex;
  align-items: center;
}

/* 缩略图沿用消息气泡的全局类，这里显式压掉它的间距与按钮默认样式，
   确保 48px 缩略图在这 56px 行里垂直居中。 */
.chat-user-msg-float :deep(.msg__images) {
  flex: none;
  margin: 0;
  align-items: center;
  flex-wrap: nowrap;
}

.chat-user-msg-float :deep(.msg__image-link) {
  display: block;
  padding: 0;
  background: none;
  line-height: 0;
  /* 细边框勾出边界：浮窗背景是透明的，缩略图不描边会和消息内容糊在一起 */
  border: 1px solid var(--app-border, #e8e8e8);
}

.chat-user-msg-float__thumb-more {
  flex: none;
  align-self: center;
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.chat-user-msg-float__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.chat-user-msg-float__text {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--app-text, #1f2937);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chat-user-msg-float__text--placeholder {
  color: var(--app-muted, #6b7280);
}

.chat-user-msg-float__action:disabled {
  cursor: default;
  color: color-mix(in srgb, var(--app-muted, #6b7280) 45%, transparent);
}

.chat-user-msg-float__action:disabled:hover {
  border-color: transparent;
  background: transparent;
  color: color-mix(in srgb, var(--app-muted, #6b7280) 45%, transparent);
}

.chat-user-msg-float__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

.chat-user-msg-float__action {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--app-muted, #6b7280);
  cursor: pointer;
  font-size: 13px;
}

.chat-user-msg-float__action:hover {
  border-color: var(--app-border, #e8e8e8);
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 8%, transparent);
}

/* 收起态：脱离文档流浮在消息区右上角，把顶部整行高度还给消息；只保留序号与展开入口。 */
.chat-user-msg-float--collapsed {
  position: absolute;
  /* 与 .chat-panel__messages 的水平内边距对齐，浮标右边缘与消息内容右边界齐平。 */
  top: 16px;
  right: 16px;
  z-index: 2;
  height: auto;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--app-muted, #6b7280);
  /* 浮在消息之上，需要不透明底色兜底，避免与下方消息文字互相干扰。 */
  background: var(--app-panel-bg, #fff);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.08);
}

.chat-user-msg-float--collapsed:hover {
  color: var(--app-accent);
}

.chat-user-msg-float__badge {
  font-variant-numeric: tabular-nums;
}

.chat-user-msg-float__caret {
  font-size: 10px;
}
</style>
