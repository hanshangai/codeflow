<script setup lang="ts">
import { computed } from "vue";
import type { PublicBestPracticeArticleSummary } from "@codeflowai/shared";
import {
  ArrowRightOutlined,
  FileTextOutlined,
  LeftOutlined,
  ReloadOutlined,
  RightOutlined,
} from "@ant-design/icons-vue";
import { RouterLink } from "vue-router";

defineOptions({ name: "BestPracticeList" });

const props = defineProps<{
  items: PublicBestPracticeArticleSummary[];
  total: number;
  offset: number;
  limit: number;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  (e: "page-change", offset: number): void;
  (e: "retry"): void;
}>();

const currentPage = computed(() => Math.floor(props.offset / props.limit) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.limit)));
const canGoPrevious = computed(() => props.offset > 0 && !props.loading);
const canGoNext = computed(() => props.offset + props.limit < props.total && !props.loading);

/** 使用固定中文格式展示文章发布日期。 */
function formatPublishedDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 切换到相邻分页，并由父组件执行数据加载。 */
function changePage(direction: -1 | 1): void {
  const nextOffset = Math.max(0, props.offset + direction * props.limit);
  emit("page-change", nextOffset);
}
</script>

<template>
  <main class="best-practice-list">
    <header class="best-practice-list__header">
      <div>
        <span class="best-practice-list__eyebrow">CodeFlow 实践库</span>
        <h1>最佳实践</h1>
        <p>可复用的工程经验、协作方法与落地案例。</p>
      </div>
      <span v-if="!loading && !error" class="best-practice-list__count">已发布 {{ total }} 篇</span>
    </header>

    <section aria-live="polite" :aria-busy="loading" class="best-practice-list__content">
      <div v-if="loading" class="best-practice-list__loading" aria-label="正在加载最佳实践文章">
        <div v-for="index in 4" :key="index" class="best-practice-list__skeleton">
          <a-skeleton active :title="{ width: '46%' }" :paragraph="{ rows: 2, width: ['92%', '68%'] }" />
        </div>
      </div>

      <div v-else-if="error" class="best-practice-list__state" role="alert">
        <ReloadOutlined />
        <h2>文章列表加载失败</h2>
        <p>{{ error }}</p>
        <button type="button" class="best-practice-list__retry" @click="emit('retry')">
          <ReloadOutlined />
          <span>重新加载</span>
        </button>
      </div>

      <div v-else-if="items.length === 0" class="best-practice-list__state">
        <FileTextOutlined />
        <h2>暂无最佳实践文章</h2>
        <p>文章发布后会在这里展示。</p>
      </div>

      <div v-else class="best-practice-list__items">
        <article v-for="item in items" :key="item.slug" class="best-practice-list__item">
          <RouterLink
            class="best-practice-list__article"
            :to="{ name: 'best-practice-detail', params: { slug: item.slug } }"
          >
            <span class="best-practice-list__article-main">
              <span class="best-practice-list__date">{{ formatPublishedDate(item.publishedAt) }}</span>
              <strong>{{ item.title }}</strong>
              <span class="best-practice-list__summary">{{ item.summary }}</span>
            </span>
            <ArrowRightOutlined class="best-practice-list__arrow" />
          </RouterLink>
        </article>
      </div>
    </section>

    <nav v-if="!loading && !error && total > limit" class="best-practice-list__pagination" aria-label="文章分页">
      <button
        type="button"
        class="best-practice-list__page-button"
        :disabled="!canGoPrevious"
        title="上一页"
        aria-label="上一页"
        @click="changePage(-1)"
      >
        <LeftOutlined />
      </button>
      <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
      <button
        type="button"
        class="best-practice-list__page-button"
        :disabled="!canGoNext"
        title="下一页"
        aria-label="下一页"
        @click="changePage(1)"
      >
        <RightOutlined />
      </button>
    </nav>
  </main>
</template>

<style scoped>
.best-practice-list {
  width: min(980px, calc(100% - 48px));
  margin: 0 auto;
  padding: 16px 0 88px;
  color: var(--app-text);
}

.best-practice-list__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 32px;
  padding-bottom: 28px;
  border-bottom: 1px solid var(--app-divider);
}

.best-practice-list__eyebrow {
  display: block;
  margin-bottom: 10px;
  color: var(--app-accent);
  font-size: 12px;
  font-weight: 700;
}

.best-practice-list__header h1 {
  margin: 0;
  font-size: 36px;
  line-height: 1.2;
  letter-spacing: 0;
}

.best-practice-list__header p {
  margin: 12px 0 0;
  color: var(--app-muted);
  font-size: 15px;
  line-height: 1.7;
}

.best-practice-list__count {
  flex-shrink: 0;
  color: var(--app-muted);
  font-size: 13px;
}

.best-practice-list__content {
  min-height: 360px;
}

.best-practice-list__loading,
.best-practice-list__items {
  display: grid;
}

.best-practice-list__skeleton,
.best-practice-list__item {
  border-bottom: 1px solid var(--app-divider);
}

.best-practice-list__skeleton {
  padding: 28px 8px 24px;
}

.best-practice-list__article {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 36px;
  align-items: center;
  gap: 24px;
  width: 100%;
  padding: 28px 8px;
  border: none;
  background: transparent;
  color: inherit;
  text-decoration: none;
  text-align: left;
  cursor: pointer;
}

.best-practice-list__article:hover {
  background: color-mix(in srgb, var(--app-accent) 5%, transparent);
}

.best-practice-list__article:focus-visible,
.best-practice-list__page-button:focus-visible,
.best-practice-list__retry:focus-visible {
  outline: none;
  box-shadow: var(--app-ring);
}

.best-practice-list__article-main {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.best-practice-list__date {
  color: var(--app-muted);
  font-size: 12px;
}

.best-practice-list__article strong {
  overflow-wrap: anywhere;
  font-size: 20px;
  line-height: 1.4;
}

.best-practice-list__summary {
  display: -webkit-box;
  overflow: hidden;
  color: var(--app-muted);
  font-size: 14px;
  line-height: 1.7;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.best-practice-list__arrow {
  color: var(--app-accent);
  font-size: 17px;
  transition: transform 0.18s ease;
}

.best-practice-list__article:hover .best-practice-list__arrow {
  transform: translateX(3px);
}

.best-practice-list__state {
  display: grid;
  justify-items: center;
  gap: 10px;
  padding: 108px 24px;
  color: var(--app-muted);
  text-align: center;
}

.best-practice-list__state > .anticon {
  color: var(--app-accent);
  font-size: 28px;
}

.best-practice-list__state h2,
.best-practice-list__state p {
  margin: 0;
}

.best-practice-list__state h2 {
  color: var(--app-text);
  font-size: 20px;
}

.best-practice-list__state p {
  max-width: 560px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.best-practice-list__retry,
.best-practice-list__page-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--app-border);
  background: var(--app-panel-bg);
  color: var(--app-text);
  cursor: pointer;
}

.best-practice-list__retry {
  gap: 8px;
  min-height: 40px;
  margin-top: 8px;
  padding: 0 14px;
  border-radius: 8px;
}

.best-practice-list__pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding-top: 28px;
  color: var(--app-muted);
  font-size: 13px;
}

.best-practice-list__page-button {
  width: 40px;
  height: 40px;
  border-radius: 8px;
}

.best-practice-list__page-button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 767px) {
  .best-practice-list {
    width: min(calc(100% - 32px), 980px);
    padding: 16px 0 56px;
  }

  .best-practice-list__header {
    display: grid;
    gap: 12px;
    padding-bottom: 22px;
  }

  .best-practice-list__header h1 {
    font-size: 28px;
  }

  .best-practice-list__article {
    grid-template-columns: minmax(0, 1fr) 28px;
    gap: 12px;
    padding: 22px 2px;
  }

  .best-practice-list__article strong {
    font-size: 18px;
  }

  .best-practice-list__state {
    padding: 72px 12px;
  }
}
</style>
