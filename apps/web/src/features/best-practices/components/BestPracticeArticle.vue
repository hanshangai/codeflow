<script setup lang="ts">
import { computed, ref } from "vue";
import type { PublicBestPracticeArticleDetail } from "@codeflowai/shared";
import {
  ArrowLeftOutlined,
  CalendarOutlined,
  FileSearchOutlined,
  ReloadOutlined,
} from "@ant-design/icons-vue";

import MarkdownContent from "@/features/markdown/MarkdownContent.vue";
import {
  extractTocHeadings,
  stripMatchingFirstMarkdownH1,
} from "@/features/markdown/renderMarkdown";

defineOptions({ name: "BestPracticeArticle" });

const props = withDefaults(defineProps<{
  article: PublicBestPracticeArticleDetail | null;
  loading: boolean;
  error: string;
  notFound: boolean;
  showBack?: boolean;
}>(), {
  showBack: true,
});

const emit = defineEmits<{
  (e: "back"): void;
  (e: "retry"): void;
}>();

const articleRoot = ref<HTMLElement | null>(null);
const articleBodyMarkdown = computed(() => props.article
  ? stripMatchingFirstMarkdownH1(props.article.bodyMarkdown, props.article.title)
  : "");
const tocHeadings = computed(() => extractTocHeadings(articleBodyMarkdown.value));

/** 使用固定中文格式展示文章时间。 */
function formatArticleDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** 滚动到 Markdown 渲染后的指定标题。 */
function scrollToHeading(slug: string): void {
  const target = articleRoot.value?.querySelector(`#${CSS.escape(slug)}`);
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** 生成目录标题对应的层级类名。 */
function headingLevelClass(level: number): string {
  return `best-practice-article__toc-link--h${level}`;
}
</script>

<template>
  <main ref="articleRoot" class="best-practice-article">
    <div v-if="loading" class="best-practice-article__loading" aria-live="polite" aria-busy="true">
      <a-skeleton active :title="{ width: '62%' }" :paragraph="{ rows: 8 }" />
    </div>

    <section v-else-if="notFound" class="best-practice-article__state">
      <FileSearchOutlined />
      <h1>文章不存在</h1>
      <p>这篇最佳实践可能已下架，或链接地址有误。</p>
      <button type="button" class="best-practice-article__button" @click="emit('back')">
        <ArrowLeftOutlined />
        <span>返回文章列表</span>
      </button>
    </section>

    <section v-else-if="error" class="best-practice-article__state" role="alert">
      <ReloadOutlined />
      <h1>文章加载失败</h1>
      <p>{{ error }}</p>
      <div class="best-practice-article__state-actions">
        <button type="button" class="best-practice-article__button" @click="emit('retry')">
          <ReloadOutlined />
          <span>重新加载</span>
        </button>
        <button type="button" class="best-practice-article__button best-practice-article__button--quiet" @click="emit('back')">
          <ArrowLeftOutlined />
          <span>返回列表</span>
        </button>
      </div>
    </section>

    <div v-else-if="article" class="best-practice-article__layout">
      <article class="best-practice-article__main">
        <button v-if="showBack" type="button" class="best-practice-article__back" @click="emit('back')">
          <ArrowLeftOutlined />
          <span>返回最佳实践</span>
        </button>

        <header class="best-practice-article__header">
          <span class="best-practice-article__eyebrow">最佳实践</span>
          <h1>{{ article.title }}</h1>
          <p>{{ article.summary }}</p>
          <div class="best-practice-article__meta">
            <span><CalendarOutlined /> 发布于 {{ formatArticleDate(article.publishedAt) }}</span>
            <span v-if="article.updatedAt !== article.publishedAt">更新于 {{ formatArticleDate(article.updatedAt) }}</span>
          </div>
        </header>

        <div class="best-practice-article__body">
          <MarkdownContent :key="article.slug" :text="articleBodyMarkdown" />
        </div>
      </article>

      <aside v-if="tocHeadings.length > 0" class="best-practice-article__toc" aria-label="当前文章目录">
        <strong>本文目录</strong>
        <button
          v-for="heading in tocHeadings"
          :key="heading.slug"
          type="button"
          class="best-practice-article__toc-link"
          :class="headingLevelClass(heading.level)"
          @click="scrollToHeading(heading.slug)"
        >
          {{ heading.text }}
        </button>
      </aside>
    </div>
  </main>
</template>

<style scoped>
.best-practice-article {
  min-height: 640px;
  color: var(--app-text);
}

.best-practice-article__layout {
  display: grid;
  grid-template-columns: minmax(0, 820px) 220px;
  justify-content: center;
  gap: 72px;
  width: min(1160px, calc(100% - 48px));
  margin: 0 auto;
  padding: 16px 0 96px;
}

.best-practice-article__main {
  min-width: 0;
}

.best-practice-article__back,
.best-practice-article__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  cursor: pointer;
}

.best-practice-article__back {
  min-height: 38px;
  padding: 0 12px;
  color: var(--app-muted);
  font-size: 13px;
}

.best-practice-article__back:hover,
.best-practice-article__button:hover {
  border-color: color-mix(in srgb, var(--app-accent) 36%, var(--app-border) 64%);
  color: var(--app-accent);
}

.best-practice-article__back:focus-visible,
.best-practice-article__button:focus-visible,
.best-practice-article__toc-link:focus-visible {
  outline: none;
  box-shadow: var(--app-ring);
}

.best-practice-article__header {
  padding: 34px 0 30px;
  border-bottom: 1px solid var(--app-divider);
}

.best-practice-article__eyebrow {
  color: var(--app-accent);
  font-size: 12px;
  font-weight: 700;
}

.best-practice-article__header h1 {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
  font-size: 34px;
  line-height: 1.28;
  letter-spacing: 0;
}

.best-practice-article__header p {
  margin: 16px 0 0;
  color: var(--app-muted);
  font-size: 16px;
  line-height: 1.75;
}

.best-practice-article__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 18px;
  color: var(--app-muted);
  font-size: 12px;
}

.best-practice-article__meta span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.best-practice-article__body {
  padding-top: 32px;
}

.best-practice-article__body :deep(.msg__content.markdown) {
  max-width: none;
  padding: 0;
  background: transparent;
  color: var(--app-text);
  line-height: 1.86;
}

.best-practice-article__body :deep(.markdown h1:first-child) {
  margin-top: 0;
}

.best-practice-article__body :deep(.markdown img) {
  max-width: 100%;
  height: auto;
}

.best-practice-article__toc {
  position: sticky;
  top: 112px;
  align-self: start;
  display: grid;
  gap: 2px;
  max-height: calc(100dvh - 140px);
  overflow-y: auto;
  padding: 12px 0 12px 16px;
  border-left: 1px solid var(--app-divider);
}

.best-practice-article__toc strong {
  margin: 0 8px 8px;
  font-size: 13px;
}

.best-practice-article__toc-link {
  width: 100%;
  padding: 6px 8px;
  border: none;
  background: transparent;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
  overflow-wrap: anywhere;
  cursor: pointer;
}

.best-practice-article__toc-link:hover {
  color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 7%, transparent);
}

.best-practice-article__toc-link--h1 { padding-left: 8px; }
.best-practice-article__toc-link--h2 { padding-left: 18px; }
.best-practice-article__toc-link--h3 { padding-left: 28px; }
.best-practice-article__toc-link--h4 { padding-left: 38px; }

.best-practice-article__loading {
  width: min(820px, calc(100% - 48px));
  margin: 0 auto;
  padding: 84px 0;
}

.best-practice-article__state {
  display: grid;
  justify-items: center;
  gap: 10px;
  width: min(640px, calc(100% - 48px));
  margin: 0 auto;
  padding: 128px 0;
  color: var(--app-muted);
  text-align: center;
}

.best-practice-article__state > .anticon {
  color: var(--app-accent);
  font-size: 30px;
}

.best-practice-article__state h1,
.best-practice-article__state p {
  margin: 0;
}

.best-practice-article__state h1 {
  color: var(--app-text);
  font-size: 24px;
}

.best-practice-article__state p {
  line-height: 1.65;
  overflow-wrap: anywhere;
}

.best-practice-article__state-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  margin-top: 8px;
}

.best-practice-article__button {
  min-height: 40px;
  margin-top: 8px;
  padding: 0 14px;
}

.best-practice-article__button--quiet {
  background: transparent;
}

@media (max-width: 1023px) {
  .best-practice-article__layout {
    grid-template-columns: minmax(0, 820px);
  }

  .best-practice-article__toc {
    display: none;
  }
}

@media (max-width: 767px) {
  .best-practice-article__layout {
    width: min(calc(100% - 32px), 820px);
    padding: 16px 0 64px;
  }

  .best-practice-article__header {
    padding-top: 4px;
  }

  .best-practice-article__header h1 {
    font-size: 28px;
  }

  .best-practice-article__header p {
    font-size: 15px;
  }

  .best-practice-article__body {
    padding-top: 24px;
  }

  .best-practice-article__loading,
  .best-practice-article__state {
    width: min(calc(100% - 32px), 820px);
  }
}
</style>
