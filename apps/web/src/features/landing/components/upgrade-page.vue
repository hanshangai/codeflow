<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";

import LandingNav from "./LandingNav.vue";
import LandingRecords from "./LandingRecords.vue";
import MarkdownContent from "../../markdown/MarkdownContent.vue";
import { useApiContext } from "../../../composables/useApiContext";
import { wsOriginToHttpOrigin } from "../../../api/request";

defineOptions({ name: "UpgradePage" });

defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

type ReleaseNoteSummary = {
  version: string;
  releasedAt: string;
  title: string;
  scope?: "full" | "server" | "client" | "product";
};

type ReleaseNoteDetail = ReleaseNoteSummary & {
  content: string;
};

/** 首屏渲染条数；其余靠滚动加载逐批补齐。 */
const INITIAL_BATCH = 3;
/** 滚动到底部后每次再追加几张卡片（不一次性预拉所有正文）。 */
const PAGE_STEP = 3;

const router = useRouter();
const { ctx } = useApiContext();
const httpBase = computed(() => wsOriginToHttpOrigin(ctx.value.serverWsOrigin));

const summaries = ref<ReleaseNoteSummary[]>([]);
const renderedCount = ref(0);
/** 已加载正文的版本号 → 内容；避免重复请求。 */
const loadedDetails = ref<Map<string, string>>(new Map());
const loadingVersions = ref<Set<string>>(new Set());
/** 单卡详情 fetch 失败的版本号集合，模板上据此渲染"加载失败 · 重试"。 */
const failedVersions = ref<Set<string>>(new Set());
const summariesLoading = ref(true);
const summariesError = ref("");
const sentinelEl = ref<HTMLElement | null>(null);
/** 普通 Map 即可：仅用于 scrollIntoView 时按 version 取 DOM，不需要响应式。 */
const cardRefs = new Map<string, HTMLElement>();

let intersectionObserver: IntersectionObserver | null = null;
let listAbortController: AbortController | null = null;

function setCardRef(version: string, el: Element | null): void {
  if (el instanceof HTMLElement) {
    cardRefs.set(version, el);
  } else {
    cardRefs.delete(version);
  }
}

const visibleSummaries = computed(() => summaries.value.slice(0, renderedCount.value));
const hasMore = computed(() => renderedCount.value < summaries.value.length);
/** 公开页仅以已发布列表判断内容与空态。 */
const isEmpty = computed(() => !summariesLoading.value && !summariesError.value && summaries.value.length === 0);
const hasAnyContent = computed(() => summaries.value.length > 0);

/** 将后端发布范围转换为面向用户的组件名称，兼容没有范围元数据的历史日志。 */
function releaseScopeLabel(scope: ReleaseNoteSummary["scope"]): string {
  if (scope === "full") return "完整发布";
  if (scope === "server") return "Server";
  if (scope === "client") return "Client";
  if (scope === "product") return "产品";
  return "发布";
}

/** 拉取列表（仅元数据），失败给出 error 提示，不静默吞掉。 */
async function loadSummaries(): Promise<void> {
  listAbortController?.abort();
  listAbortController = new AbortController();
  summariesLoading.value = true;
  summariesError.value = "";
  try {
    const base = httpBase.value;
    if (!base) {
      summariesError.value = "尚未连接到服务器，无法加载更新日志";
      summariesLoading.value = false;
      return;
    }
    const res = await fetch(`${base}/api/release-notes`, { method: "GET", signal: listAbortController.signal });
    if (!res.ok) {
      summariesError.value = `加载更新日志失败（HTTP ${res.status}）`;
      summariesLoading.value = false;
      return;
    }
    const json = (await res.json()) as {
      ok: boolean;
      items?: ReleaseNoteSummary[];
      message?: string;
    };
    if (!json.ok || !Array.isArray(json.items)) {
      summariesError.value = json.message || "更新日志响应异常";
      summariesLoading.value = false;
      return;
    }
    summaries.value = json.items;
    renderedCount.value = Math.min(INITIAL_BATCH, json.items.length);
    summariesLoading.value = false;
    await Promise.all(visibleSummaries.value.map((s) => ensureDetailLoaded(s.version)));
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") return;
    summariesError.value = err instanceof Error ? err.message : "加载更新日志失败";
    summariesLoading.value = false;
  }
}

/** 拉取单版本正文；命中缓存或正在加载时短路。失败显式记录，不静默吞掉。 */
async function ensureDetailLoaded(version: string): Promise<void> {
  if (loadedDetails.value.has(version) || loadingVersions.value.has(version)) return;
  const base = httpBase.value;
  if (!base) {
    failedVersions.value.add(version);
    return;
  }
  failedVersions.value.delete(version);
  loadingVersions.value.add(version);
  try {
    const res = await fetch(`${base}/api/release-notes/${encodeURIComponent(version)}`, { method: "GET" });
    if (!res.ok) {
      failedVersions.value.add(version);
      return;
    }
    const json = (await res.json()) as { ok: boolean; note?: ReleaseNoteDetail };
    if (json.ok && json.note) {
      loadedDetails.value.set(version, json.note.content);
    } else {
      failedVersions.value.add(version);
    }
  } catch {
    failedVersions.value.add(version);
  } finally {
    loadingVersions.value.delete(version);
  }
}

/** 失败重试入口；清除失败标记后重新触发 fetch。 */
async function retryDetail(version: string): Promise<void> {
  failedVersions.value.delete(version);
  await ensureDetailLoaded(version);
}

/** 滚动到底部 sentinel 时追加下一批卡片，并预取它们的正文。 */
async function loadMore(): Promise<void> {
  if (!hasMore.value) return;
  const next = Math.min(renderedCount.value + PAGE_STEP, summaries.value.length);
  const newlyVisible = summaries.value.slice(renderedCount.value, next);
  renderedCount.value = next;
  await Promise.all(newlyVisible.map((s) => ensureDetailLoaded(s.version)));
}

/** 左栏点击：若目标卡片尚未渲染，先扩展渲染范围并预取正文，再 scrollIntoView。 */
async function jumpToVersion(version: string): Promise<void> {
  const idx = summaries.value.findIndex((s) => s.version === version);
  if (idx < 0) return;
  if (idx >= renderedCount.value) {
    const need = idx + 1;
    const newlyVisible = summaries.value.slice(renderedCount.value, need);
    renderedCount.value = need;
    await Promise.all(newlyVisible.map((s) => ensureDetailLoaded(s.version)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
  const el = cardRefs.get(version);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindIntersectionObserver(): void {
  if (typeof IntersectionObserver === "undefined") return;
  intersectionObserver?.disconnect();
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          void loadMore();
        }
      }
    },
    { rootMargin: "200px 0px" },
  );
  if (sentinelEl.value) intersectionObserver.observe(sentinelEl.value);
}

watch(sentinelEl, (el) => {
  if (!intersectionObserver) return;
  intersectionObserver.disconnect();
  if (el) intersectionObserver.observe(el);
});

watch(
  () => httpBase.value,
  (next, prev) => {
    if (next && next !== prev) {
      void loadSummaries();
    }
  },
);

onMounted(() => {
  bindIntersectionObserver();
  void loadSummaries();
});

onUnmounted(() => {
  intersectionObserver?.disconnect();
  intersectionObserver = null;
  listAbortController?.abort();
});
</script>

<template>
  <div class="upgrade-page">
    <LandingNav @open-settings="$emit('open-settings')" @enter-app="$emit('enter-app')" />

    <main class="upgrade-page__main">
      <section class="upgrade-page__layout" v-if="!summariesLoading && !summariesError && hasAnyContent">
        <aside class="upgrade-page__sidebar">
          <div class="upgrade-page__sidebar-inner">
            <div class="upgrade-page__sidebar-title">产品版本列表</div>
            <ul v-if="summaries.length > 0" class="upgrade-page__version-list">
              <li
                v-for="item in summaries"
                :key="item.version"
                class="upgrade-page__version-item"
                :class="{ 'upgrade-page__version-item--rendered': loadedDetails.has(item.version) }"
              >
                <button type="button" class="upgrade-page__version-btn" @click="jumpToVersion(item.version)">
                  <span class="upgrade-page__version-num">v{{ item.version }}</span>
                  <span class="upgrade-page__version-date">{{ item.releasedAt }}</span>
                </button>
              </li>
            </ul>
            <div v-else class="upgrade-page__sidebar-empty">暂无已发布版本</div>
          </div>
        </aside>

        <div class="upgrade-page__feed">
          <article
            v-for="item in visibleSummaries"
            :key="item.version"
            class="upgrade-page__card"
            :ref="(el) => setCardRef(item.version, el as Element | null)"
          >
            <header class="upgrade-page__card-header">
              <div class="upgrade-page__card-version">{{ releaseScopeLabel(item.scope) }}版本 v{{ item.version }}</div>
              <div class="upgrade-page__card-meta">
                <span class="upgrade-page__card-date">{{ item.releasedAt }}</span>
                <span class="upgrade-page__card-scope">发布范围：{{ releaseScopeLabel(item.scope) }}</span>
                <span v-if="item.title" class="upgrade-page__card-title">{{ item.title }}</span>
              </div>
            </header>
            <div class="upgrade-page__card-body">
              <MarkdownContent v-if="loadedDetails.has(item.version)" :text="loadedDetails.get(item.version) || ''" />
              <div v-else-if="failedVersions.has(item.version)" class="upgrade-page__card-error">
                <span>该版本说明加载失败</span>
                <button type="button" class="upgrade-page__retry" @click="retryDetail(item.version)">重试</button>
              </div>
              <div v-else class="upgrade-page__card-loading">加载中…</div>
            </div>
          </article>

          <div v-if="hasMore" ref="sentinelEl" class="upgrade-page__sentinel">向下滚动查看更早版本…</div>
          <div v-else class="upgrade-page__footnote">
            更新日志自 v2026.04.29.05 起开始公开记录，更早版本不在此回溯展示。
          </div>
        </div>
      </section>

      <section v-else-if="summariesLoading" class="upgrade-page__placeholder">
        正在加载更新日志…
      </section>

      <section v-else-if="summariesError" class="upgrade-page__placeholder upgrade-page__placeholder--error">
        {{ summariesError }}
      </section>

      <section v-else-if="isEmpty" class="upgrade-page__placeholder">
        暂无更新日志。
      </section>
    </main>

    <LandingRecords />
  </div>
</template>

<style scoped>
.upgrade-page {
  --landing-bg: var(--app-bg);
  --landing-panel: color-mix(in srgb, var(--app-panel-bg) 82%, transparent);
  --landing-panel-solid: var(--app-panel-bg);
  --landing-surface: color-mix(in srgb, var(--app-panel-bg) 78%, var(--app-bg));
  --landing-surface-soft: linear-gradient(135deg, color-mix(in srgb, var(--app-panel-bg) 72%, var(--app-bg)) 0%, color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-bg)) 100%);
  --landing-accent-wash: color-mix(in srgb, var(--app-accent) 12%, transparent);
  --landing-nav-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-bg) 88%, transparent), color-mix(in srgb, var(--app-bg) 52%, transparent) 72%, transparent);
  --landing-border: var(--app-border);
  --landing-border-soft: color-mix(in srgb, var(--app-border) 80%, transparent);
  --landing-card-border: color-mix(in srgb, var(--app-border) 72%, transparent);
  --landing-accent-border: color-mix(in srgb, var(--app-accent) 36%, transparent);
  --landing-text: var(--app-text);
  --landing-muted: var(--app-muted);
  --landing-muted-soft: color-mix(in srgb, var(--app-muted) 76%, transparent);
  --landing-warning: color-mix(in srgb, var(--app-accent) 72%, var(--app-text));
  --landing-shadow-soft: 0 16px 38px color-mix(in srgb, #000 10%, transparent);
  min-height: 100vh;
  overflow-y: auto;
  scrollbar-gutter: stable;
  background:
    radial-gradient(circle at 8% 14%, color-mix(in srgb, var(--app-accent) 13%, transparent), transparent 24%),
    radial-gradient(circle at 94% 12%, color-mix(in srgb, var(--app-warning) 18%, transparent), transparent 30%),
    linear-gradient(180deg, var(--app-bg) 0%, var(--app-bg-secondary) 44%, var(--app-bg) 100%);
  color: var(--landing-text);
}

.upgrade-page__main {
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
  padding: 16px 0 88px;
}

.upgrade-page__layout {
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

.upgrade-page__sidebar {
  position: sticky;
  top: 96px;
  align-self: start;
}

.upgrade-page__sidebar-inner {
  padding: 18px;
  border-radius: 22px;
  border: 1px solid var(--landing-border);
  background: var(--landing-panel);
  box-shadow: var(--landing-shadow-soft);
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

.upgrade-page__sidebar-title {
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--landing-muted);
  text-transform: uppercase;
}

.upgrade-page__version-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.upgrade-page__sidebar-empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--landing-muted-soft);
  line-height: 1.6;
}

.upgrade-page__version-btn {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s ease, color 0.18s ease;
}

.upgrade-page__version-btn:hover {
  background: var(--landing-accent-wash);
  color: var(--landing-warning);
}

.upgrade-page__version-num {
  font-size: 13px;
  font-weight: 700;
  color: var(--landing-text);
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
}

.upgrade-page__version-date {
  font-size: 11px;
  color: var(--landing-muted-soft);
}

.upgrade-page__feed {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.upgrade-page__card {
  padding: 24px;
  border-radius: 22px;
  border: 1px solid var(--landing-border);
  background: var(--landing-surface-soft);
  box-shadow: var(--landing-shadow-soft);
}

.upgrade-page__card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px 16px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--landing-border-soft);
  margin-bottom: 14px;
}

.upgrade-page__card-version {
  font-size: 22px;
  font-weight: 700;
  color: var(--app-accent);
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
}

.upgrade-page__card-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  color: var(--landing-muted);
}

.upgrade-page__card-date {
  font-size: 13px;
  color: var(--landing-muted-soft);
}

.upgrade-page__card-scope {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--landing-accent-wash);
  color: var(--landing-warning);
  font-size: 12px;
  font-weight: 600;
}

.upgrade-page__card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--landing-text);
}

.upgrade-page__card-body :deep(h2) {
  margin-top: 18px;
  margin-bottom: 8px;
  font-size: 16px;
  font-weight: 700;
  color: var(--landing-text);
}

.upgrade-page__card-body :deep(h2):first-child {
  margin-top: 0;
}

.upgrade-page__card-body :deep(ul) {
  padding-left: 20px;
  margin: 6px 0 0;
}

.upgrade-page__card-body :deep(li) {
  margin-bottom: 4px;
  line-height: 1.7;
  color: color-mix(in srgb, var(--landing-text) 86%, transparent);
  font-size: 14px;
}

.upgrade-page__card-body :deep(p) {
  margin: 0 0 8px;
  line-height: 1.7;
  color: color-mix(in srgb, var(--landing-text) 86%, transparent);
  font-size: 14px;
}

.upgrade-page__card-loading {
  padding: 16px 0;
  font-size: 13px;
  color: var(--landing-muted-soft);
}

.upgrade-page__card-error {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  font-size: 13px;
  color: var(--app-danger);
}

.upgrade-page__retry {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--app-danger) 40%, transparent);
  background: transparent;
  color: var(--app-danger);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.upgrade-page__retry:hover {
  background: color-mix(in srgb, var(--app-danger) 8%, transparent);
}

.upgrade-page__sentinel {
  margin: 4px 0 8px;
  padding: 14px;
  text-align: center;
  font-size: 12px;
  color: var(--landing-muted-soft);
}

.upgrade-page__footnote {
  margin-top: 8px;
  padding: 14px 18px;
  border-radius: 14px;
  background: var(--landing-panel);
  border: 1px dashed var(--landing-border-soft);
  font-size: 12px;
  color: var(--landing-muted-soft);
  line-height: 1.7;
}

.upgrade-page__placeholder {
  margin-top: 22px;
  padding: 36px;
  border-radius: 22px;
  border: 1px solid var(--landing-border);
  background: var(--landing-panel);
  text-align: center;
  font-size: 14px;
  color: var(--landing-muted);
}

.upgrade-page__placeholder--error {
  border-color: color-mix(in srgb, var(--app-danger) 30%, transparent);
  color: var(--app-danger);
}

@media (max-width: 900px) {
  .upgrade-page__layout {
    grid-template-columns: 1fr;
  }

  .upgrade-page__sidebar {
    position: static;
  }

  .upgrade-page__sidebar-inner {
    max-height: none;
  }
}

@media (max-width: 767px) {
  .upgrade-page {
    min-height: 100%;
    overflow: visible;
    scrollbar-gutter: auto;
  }

  .upgrade-page__main {
    width: min(100%, calc(100% - 32px));
    padding: 16px 0 52px;
  }

  .upgrade-page__card {
    padding: 18px;
    border-radius: 18px;
  }
}
</style>
