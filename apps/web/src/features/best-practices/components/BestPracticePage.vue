<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type {
  PublicBestPracticeArticleDetail,
  PublicBestPracticeArticleSummary,
} from "@codeflowai/shared";
import { useRoute, useRouter } from "vue-router";

import {
  getPublicBestPracticeArticle,
  getPublicBestPracticeArticles,
} from "@/api/best-practice-articles";
import {
  createCancelledRequestError,
  isCancelledRequestError,
} from "@/api/request";
import { useApiContext } from "@/composables/useApiContext";
import LandingNav from "@/features/landing/components/LandingNav.vue";
import {
  applyBestPracticeArticleSeo,
  applyBestPracticeArticleUnavailableSeo,
} from "@/seo/pageSeo";
import BestPracticeArticle from "./BestPracticeArticle.vue";
import BestPracticeList from "./BestPracticeList.vue";

defineOptions({ name: "BestPracticePage" });

const props = withDefaults(defineProps<{
  embedded?: boolean;
}>(), {
  embedded: false,
});

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

const PAGE_SIZE = 10;
const route = useRoute();
const router = useRouter();
const { ctx } = useApiContext();

const pageRef = ref<HTMLElement | null>(null);
const items = ref<PublicBestPracticeArticleSummary[]>([]);
const total = ref(0);
const offset = ref(0);
const listLoading = ref(false);
const listError = ref("");
const article = ref<PublicBestPracticeArticleDetail | null>(null);
const articleLoading = ref(false);
const articleError = ref("");
const articleNotFound = ref(false);
let activeRequest: AbortController | null = null;
let requestRunId = 0;

const slug = computed(() => {
  const rawSlug = route.params.slug;
  return typeof rawSlug === "string" ? rawSlug.trim() : "";
});
const isDetail = computed(() => Boolean(slug.value));

/** 根据当前路由读取列表或文章详情，并拒绝过期请求回写。 */
async function loadCurrentView(): Promise<void> {
  activeRequest?.abort(createCancelledRequestError("scope-change"));
  const controller = new AbortController();
  activeRequest = controller;
  const runId = ++requestRunId;

  if (isDetail.value) {
    article.value = null;
    articleLoading.value = true;
    articleError.value = "";
    articleNotFound.value = false;
    try {
      const result = await getPublicBestPracticeArticle(ctx.value, slug.value, controller.signal);
      if (runId !== requestRunId) return;
      if (result.ok) {
        article.value = result.article;
        applyBestPracticeArticleSeo(result.article);
      } else if (result.code === "NOT_FOUND") {
        articleNotFound.value = true;
        applyBestPracticeArticleUnavailableSeo(route.path);
      } else {
        articleError.value = result.message || "最佳实践文章加载失败";
        applyBestPracticeArticleUnavailableSeo(route.path);
      }
    } catch (error) {
      if (isCancelledRequestError(error)) return;
      articleError.value = error instanceof Error ? error.message : "最佳实践文章加载失败";
      applyBestPracticeArticleUnavailableSeo(route.path);
    } finally {
      if (runId === requestRunId) articleLoading.value = false;
    }
    return;
  }

  listLoading.value = true;
  listError.value = "";
  try {
    const result = await getPublicBestPracticeArticles(ctx.value, {
      offset: offset.value,
      limit: PAGE_SIZE,
      signal: controller.signal,
    });
    if (runId !== requestRunId) return;
    if (result.ok) {
      const lastOffset = result.total > 0
        ? Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE
        : 0;
      if (offset.value > lastOffset) {
        offset.value = lastOffset;
        return;
      }
      items.value = result.items;
      total.value = result.total;
      return;
    }
    items.value = [];
    total.value = 0;
    listError.value = result.message || "最佳实践文章列表加载失败";
  } catch (error) {
    if (isCancelledRequestError(error)) return;
    items.value = [];
    total.value = 0;
    listError.value = error instanceof Error ? error.message : "最佳实践文章列表加载失败";
  } finally {
    if (runId === requestRunId) listLoading.value = false;
  }
}

/** 返回公开文章列表。 */
function returnToList(): void {
  void router.push("/best-practices");
}

/** 切换列表分页并回到页面内容顶部。 */
function changePage(nextOffset: number): void {
  offset.value = nextOffset;
}

/** 将桌面窗口或移动内层滚动容器复位到页面顶部。 */
function scrollPageToTop(): void {
  pageRef.value?.scrollIntoView({ behavior: "auto", block: "start" });
}

watch(
  () => [ctx.value.serverWsOrigin, slug.value, slug.value ? 0 : offset.value] as const,
  () => {
    scrollPageToTop();
    void loadCurrentView();
  },
  { immediate: true },
);

onUnmounted(() => {
  requestRunId += 1;
  activeRequest?.abort(createCancelledRequestError("component-unmount"));
});
</script>

<template>
  <div ref="pageRef" class="best-practice-page" :class="{ 'best-practice-page--embedded': props.embedded }">
    <LandingNav
      v-if="!props.embedded"
      @open-settings="emit('open-settings')"
      @enter-app="emit('enter-app')"
    />
    <BestPracticeArticle
      v-if="isDetail"
      :article="article"
      :loading="articleLoading"
      :error="articleError"
      :not-found="articleNotFound"
      :show-back="!props.embedded"
      @back="returnToList"
      @retry="loadCurrentView"
    />
    <BestPracticeList
      v-else
      :items="items"
      :total="total"
      :offset="offset"
      :limit="PAGE_SIZE"
      :loading="listLoading"
      :error="listError"
      @page-change="changePage"
      @retry="loadCurrentView"
    />
  </div>
</template>

<style scoped>
.best-practice-page {
  width: 100%;
  min-height: 100dvh;
  overflow-x: clip;
  background: var(--app-bg);
  color: var(--app-text);
}

.best-practice-page--embedded {
  min-height: 100%;
}
</style>
