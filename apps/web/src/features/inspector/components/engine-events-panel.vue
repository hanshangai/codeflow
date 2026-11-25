<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { RawEngineEventEnvelope, ThreadId, WorkspaceId } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useApiContext } from "../../../composables/useApiContext";
import { listThreadEvents } from "../../../api/threads";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";

defineOptions({ name: "EngineEventsPanel" });

type Props = {
  threadId: ThreadId | null;
};

const props = defineProps<Props>();

const chat = useChatStore();
const config = useConfigStore();
const { ctx } = useApiContext();

const typeFilter = ref<string>("all");
const query = ref("");

const events = ref<RawEngineEventEnvelope[]>([]);
const nextBeforeSeq = ref<number | null>(null);
const loading = ref(false);
const exporting = ref(false);
const loadedSeq = ref(new Set<number>());

const PAGE_SIZE = 200;
const EXPORT_PAGE_SIZE = 2_000;

/** 加载最新一页事件（按 seq 倒序）。 */
async function loadLatest(): Promise<void> {
  // 直接读 store 而非 props：props 在父组件 re-render 后才更新，
  // 而 watcher 在 render 之前执行，此时 props.threadId 可能是旧值。
  const threadId = chat.selectedThreadId as ThreadId | null;
  if (!threadId) {
    events.value = [];
    nextBeforeSeq.value = null;
    loadedSeq.value = new Set();
    return;
  }

  loading.value = true;
  try {
    const res = await listThreadEvents(ctx.value, {
      workspaceId: config.workspaceId as WorkspaceId,
      threadId,
      beforeSeq: null,
      limit: PAGE_SIZE,
    });
    if (!res.ok) throw new Error(res.message);
    events.value = Array.isArray(res.events) ? (res.events as RawEngineEventEnvelope[]) : [];
    nextBeforeSeq.value = typeof res.nextBeforeSeq === "number" ? res.nextBeforeSeq : null;
    loadedSeq.value = new Set(events.value.map((e) => Number(e.seq)));
  } catch (e) {
    message.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

/** 继续加载更早一页事件（使用 `nextBeforeSeq` 作为游标）。 */
async function loadMore(): Promise<void> {
  const threadId = chat.selectedThreadId as ThreadId | null;
  const beforeSeq = nextBeforeSeq.value;
  if (!threadId || !beforeSeq || loading.value) return;

  loading.value = true;
  try {
    const res = await listThreadEvents(ctx.value, {
      workspaceId: config.workspaceId as WorkspaceId,
      threadId,
      beforeSeq,
      limit: PAGE_SIZE,
    });
    if (!res.ok) throw new Error(res.message);

    const page = Array.isArray(res.events) ? (res.events as RawEngineEventEnvelope[]) : [];
    for (const e of page) {
      const seq = Number(e.seq);
      if (!Number.isFinite(seq) || loadedSeq.value.has(seq)) continue;
      events.value.push(e);
      loadedSeq.value.add(seq);
    }
    nextBeforeSeq.value = typeof res.nextBeforeSeq === "number" ? res.nextBeforeSeq : null;
  } catch (e) {
    message.error(e instanceof Error ? e.message : "加载失败");
  } finally {
    loading.value = false;
  }
}

const typeOptions = computed<string[]>(() => {
  const set = new Set<string>();
  for (const e of events.value) set.add(eventTitle(e));
  return Array.from(set).sort();
});

function matchQuery(e: RawEngineEventEnvelope, q: string): boolean {
  if (!q) return true;
  const qq = q.toLowerCase();
  if (eventTitle(e).toLowerCase().includes(qq)) return true;
  try {
    return JSON.stringify(e).toLowerCase().includes(qq);
  } catch {
    return false;
  }
}

/** 判断值是否为普通对象（Record），用于安全读取 payload。 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function rawInfo(e: RawEngineEventEnvelope): { source: string; hint: string } {
  const source = String(e.source ?? "").trim();
  const data = e.data;
  const hint = isRecord(data) ? String(data.type ?? data.method ?? "").trim() : "";
  return { source, hint };
}

/** 事件标题：优先显示 `<source> · <data.type|data.method>`。 */
function eventTitle(e: RawEngineEventEnvelope): string {
  const info = rawInfo(e);
  return info.hint ? `${info.source} · ${info.hint}` : info.source;
}

function rawSource(e: RawEngineEventEnvelope): string {
  const info = rawInfo(e);
  return info?.source ?? "";
}

/** 确保导出文件名包含指定后缀（用于 `.jsonl` 导出）。 */
function ensureFilenameSuffix(filename: string, suffix: string): string {
  const name = String(filename ?? "").trim();
  if (!name) return `engine-events${suffix}`;
  return name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name}${suffix}`;
}

/** 触发浏览器下载文本内容（Blob + download）。 */
function downloadText(opts: { filename: string; text: string; mime?: string }): void {
  const mime = opts.mime ?? "text/plain;charset=utf-8";
  const blob = new Blob([opts.text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = ensureFilenameSuffix(opts.filename, ".jsonl");
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildExportFilename(threadId: ThreadId): string {
  const tid = String(threadId).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `engine-events_${tid}_${stamp}.jsonl`;
}

/** 导出：全量分页拉取 thread 事件，按当前筛选条件输出 jsonl。 */
async function exportAllFiltered(): Promise<void> {
  const threadId = props.threadId;
  const workspaceId = config.workspaceId as WorkspaceId;
  if (!threadId) return;
  if (!workspaceId) {
    message.error("缺少 workspaceId");
    return;
  }
  if (exporting.value) return;

  const key = "events-export";
  exporting.value = true;
  message.loading({ content: "导出中：准备拉取…", key, duration: 0 });
  try {
    const lines: string[] = [];
    const q = query.value;
    const tf = typeFilter.value;
    let scanned = 0;
    let matched = 0;

    let beforeSeq: number | null = null;
    // 接口按 seq 倒序分页（最新在前），这里保持导出顺序与接口一致。
    for (;;) {
      const res = await listThreadEvents(ctx.value, {
        workspaceId,
        threadId,
        beforeSeq,
        limit: EXPORT_PAGE_SIZE,
      });
      if (!res.ok) throw new Error(res.message);

      const page = Array.isArray(res.events) ? (res.events as RawEngineEventEnvelope[]) : [];
      scanned += page.length;
      for (const e of page) {
        if (tf !== "all" && eventTitle(e) !== tf) continue;
        if (!matchQuery(e, q)) continue;
        lines.push(JSON.stringify(e));
        matched += 1;
      }

      message.loading({ content: `导出中：已扫描 ${scanned} 条，已匹配 ${matched} 条`, key, duration: 0 });

      beforeSeq = typeof res.nextBeforeSeq === "number" ? res.nextBeforeSeq : null;
      if (!beforeSeq || page.length === 0) break;
    }

    if (!lines.length) {
      message.warning({ content: "无匹配事件可导出", key, duration: 2 });
      return;
    }

    const filename = buildExportFilename(threadId);
    downloadText({
      filename,
      text: `${lines.join("\n")}\n`,
      mime: "application/x-ndjson;charset=utf-8",
    });
    message.success({ content: `导出完成：${lines.length} 条（${filename}）`, key, duration: 2 });
  } catch (e) {
    message.error({ content: e instanceof Error ? e.message : "导出失败", key, duration: 3 });
  } finally {
    exporting.value = false;
  }
}

const filtered = computed<RawEngineEventEnvelope[]>(() => {
  const out: RawEngineEventEnvelope[] = [];
  for (const e of events.value) {
    if (typeFilter.value !== "all" && eventTitle(e) !== typeFilter.value) continue;
    if (!matchQuery(e, query.value)) continue;
    out.push(e);
  }
  return out; // 最新在前（接口返回倒序）
});

const modalOpen = ref(false);
const selected = ref<RawEngineEventEnvelope | null>(null);

function openEvent(e: RawEngineEventEnvelope): void {
  selected.value = e;
  modalOpen.value = true;
}

function closeModal(): void {
  modalOpen.value = false;
  selected.value = null;
}

async function copyJson(): Promise<void> {
  if (!selected.value) return;
  try {
    await copyToClipboard(JSON.stringify(selected.value, null, 2));
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  }
}

/** raw 事件快速标记：已处理/未处理/解析失败等。 */
function rawBadge(e: RawEngineEventEnvelope): { label: string; color?: string } {
  const action = String(e.action ?? "");
  if (action === "mapped") return { label: "已映射", color: "green" };
  if (action === "ignored") return { label: "已忽略", color: "blue" };
  if (action === "parseError") return { label: "解析失败", color: "red" };
  if (action === "unhandled") return { label: "未处理", color: "red" };
  return { label: action || "raw" };
}

function eventBadge(e: RawEngineEventEnvelope): { label: string; color?: string } {
  return rawBadge(e);
}

watch(
  () => [props.threadId, config.workspaceId] as const,
  () => {
    void loadLatest();
  },
  { immediate: true },
);
</script>

<template>
  <div class="event-panel">
    <!-- 固定头部区域 -->
    <div class="event-panel__fixed">
      <div class="event-panel__header">
        <div class="inspector__section-title">事件（已加载 {{ events.length }} 条）</div>
      </div>

      <div class="event-filter">
        <div class="event-filter__row1">
          <a-select v-model:value="typeFilter" size="small" class="event-filter__select">
            <a-select-option value="all">全部类型</a-select-option>
            <a-select-option v-for="t in typeOptions" :key="t" :value="t">{{ t }}</a-select-option>
          </a-select>
          <div class="event-filter__actions">
            <a-button size="small" :loading="loading" @click="loadLatest" class="event-filter__btn">刷新</a-button>
            <a-button size="small" :disabled="!nextBeforeSeq || loading" @click="loadMore" class="event-filter__btn">更多</a-button>
            <a-button size="small" :loading="exporting" :disabled="!props.threadId || exporting" @click="exportAllFiltered" class="event-filter__btn">导出</a-button>
          </div>
        </div>
        <a-input
          v-model:value="query"
          size="small"
          allow-clear
          placeholder="搜索 type/payload"
          class="event-filter__input"
        />
      </div>
    </div>

    <!-- 可滚动列表区域 -->
    <div class="event-panel__scroll">
      <a-empty v-if="!filtered.length" description="暂无事件" />

      <div v-else class="event-list">
          <div
            v-for="e in filtered"
            :key="String(e.seq)"
            class="event-item"
            @click="openEvent(e)"
          >
            <div class="event-item__header">
              <span class="event-item__seq" :title="String(e.seq)">#{{ String(e.seq).slice(-5) }}</span>
              <span class="event-item__type">{{ eventTitle(e) }}</span>
            </div>
            <div v-if="e.ts || eventBadge(e)" class="event-item__time" style="display: flex; gap: 8px; align-items: center">
              <span v-if="e.ts">
                {{ new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) }}
              </span>
              <a-tag :color="eventBadge(e).color">
                {{ eventBadge(e).label }}
              </a-tag>
              <span v-if="rawSource(e)" class="inspector__muted">{{ rawSource(e) }}</span>
            </div>
          </div>
        </div>
    </div>
  </div>

  <a-modal
    :open="modalOpen"
    title="事件详情"
    :footer="null"
    @cancel="closeModal"
    width="70%"
    :style="{ top: 'max(56px, 10%)' }"
    :body-style="{ maxHeight: '70vh', overflow: 'auto' }"
  >
    <div v-if="selected" style="display: grid; gap: 10px">
      <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center">
        <div style="display: flex; gap: 8px; align-items: center">
          <div class="inspector__muted">#{{ selected.seq }} · {{ eventTitle(selected) }}</div>
          <a-tag :color="eventBadge(selected).color">
            {{ eventBadge(selected).label }}
          </a-tag>
        </div>
        <a-button size="small" @click="copyJson">复制 JSON</a-button>
      </div>
      <pre class="msg__pre">{{ JSON.stringify(selected, null, 2) }}</pre>
    </div>
  </a-modal>
</template>

