<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SnippetsOutlined } from "@ant-design/icons-vue";
import type { QuickPhrase } from "@codeflowai/shared";
import { trackProductEvent } from "../../../analytics/analytics";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { QuickPhraseCacheWriteError, quickPhraseAccountScope, useQuickPhrasesStore } from "../../../store/quickPhrases";
import type { QuickPhraseRequestContext } from "../../../api/quickPhrases";
import { createBrowserUuid } from "../../../utils/browserUuid";
import { syncQuickPhrasesToAccount } from "../quickPhraseSync";

const props = defineProps<{ disabled?: boolean; disabledReason?: string }>();
const emit = defineEmits<{ insert: [content: string] }>();
const config = useConfigStore();
const store = useQuickPhrasesStore();
const { ctx } = useApiContext();
const accountAvailable = computed(() => config.isAccountSession && config.hasActiveSession && Boolean(config.userSummary?.userId)
  && (!config.isDesktop || config.connected));
/** 登录后统一使用账号提示词，未登录的本机提示词在登录后自动合并。 */
const scope = computed<"local" | "account">(() => accountAvailable.value || !config.isDesktop ? "account" : "local");
const requestContext = computed<QuickPhraseRequestContext>(() => ({ ...ctx.value, scope: scope.value }));
const accountScopeKey = computed(() => quickPhraseAccountScope(config.serverWsOrigin, config.userSummary?.userId ?? ""));
const selectedScopeKey = computed(() => scope.value === "local" ? "local" : `${accountScopeKey.value}::${accountAvailable.value}`);
const collectionScopeKey = computed(() => scope.value === "local" ? "local" : accountScopeKey.value);
const scopeMatches = computed(() => store.scopeKey === collectionScopeKey.value);
const collectionError = computed(() => scopeMatches.value ? store.error : "常用提示词范围已切换，请重新加载");
const open = ref(false);
const query = ref("");
const editorOpen = ref(false);
const editing = ref<QuickPhrase | null>(null);
const title = ref("");
const content = ref("");
const saving = ref(false);
const mobile = ref(false);
let mediaQuery: MediaQueryList | null = null;
let loadEpoch = 0;
type FailureContext = { scope: "local" | "account"; userId?: string; phraseId?: string };

const filtered = computed(() => {
  if (!scopeMatches.value) return [];
  const term = query.value.trim().toLocaleLowerCase();
  return term ? store.items.filter((item) => `${item.title}\n${item.content}`.toLocaleLowerCase().includes(term)) : store.items;
});

/** 打开所选集合；本机默认不依赖账号和 Server。 */
async function setOpen(value: boolean): Promise<void> {
  open.value = value;
  if (!value) return;
  trackProductEvent("quick_phrase_open");
  await loadCollection();
}

/** 加载失败保留失败态；旧范围结果不能改变当前面板。 */
async function loadCollection(): Promise<void> {
  const epoch = ++loadEpoch;
  const context = captureFailureContext();
  try {
    if (scope.value === "account" && accountAvailable.value) {
      // 合并失败只影响迁移，不阻断账号提示词读取；下次打开会重试合并。
      try { await syncQuickPhrasesToAccount(ctx.value, config.serverWsOrigin, config.userSummary?.userId ?? ""); }
      catch (error) { reportFailure("merge", error, captureFailureContext()); }
    }
    await store.initialize(requestContext.value, config.serverWsOrigin, config.userSummary?.userId ?? "");
  } catch (error) { reportFailure("load", error, context, epoch === loadEpoch); }
}

/** 异步操作先冻结所属范围，避免迟到错误标记到新账号。 */
function captureFailureContext(phraseId?: string): FailureContext {
  return { scope: scope.value, userId: scope.value === "account" ? config.userSummary?.userId : undefined, phraseId };
}

/** 展示边界记录可检索上下文，业务失败保留表单或错误态。 */
function reportFailure(action: string, error: unknown, context = captureFailureContext(), showMessage = true): void {
  const requestId = `quick-phrases-${createBrowserUuid()}`;
  console.error("[quick-phrases.operation-failed]", { code: "QUICK_PHRASES_OPERATION_FAILED", requestId, action, ...context,
    rootCause: error instanceof Error ? { message: error.message, cause: String(error.cause ?? "") } : String(error) });
  if (showMessage) message.error(error instanceof Error ? error.message : "常用提示词操作失败");
}

watch(selectedScopeKey, () => {
  editorOpen.value = false;
  query.value = "";
  loadEpoch += 1;
  if (open.value) void loadCollection();
});
/** Inserts plain text without sending it. */
function insert(item: QuickPhrase): void {
  if (!scopeMatches.value) { reportFailure("insert", new Error("常用提示词范围已切换，请重新加载"), captureFailureContext(item.id)); return; }
  if (props.disabled) { message.info(props.disabledReason || "当前会话不可编辑"); return; }
  emit("insert", item.content);
  open.value = false;
  trackProductEvent("quick_phrase_insert");
}

/** Opens a clean create form or an existing phrase editor. */
function edit(item: QuickPhrase | null): void {
  if (!scopeMatches.value) { reportFailure("edit", new Error("常用提示词范围已切换，请重新加载"), captureFailureContext(item?.id)); return; }
  editing.value = item;
  title.value = item?.title ?? "";
  content.value = item?.content ?? "";
  editorOpen.value = true;
}

/** 保存当前范围，切换范围后不关闭新范围的编辑器。 */
async function save(): Promise<void> {
  const selected = selectedScopeKey.value;
  const epoch = loadEpoch;
  const context = captureFailureContext(editing.value?.id);
  saving.value = true;
  try {
    if (editing.value) { await store.update(requestContext.value, editing.value, title.value, content.value); trackProductEvent("quick_phrase_update"); }
    else { await store.create(requestContext.value, title.value, content.value); trackProductEvent("quick_phrase_create"); }
    if (selectedScopeKey.value === selected && epoch === loadEpoch) editorOpen.value = false;
  } catch (error) {
    if (error instanceof QuickPhraseCacheWriteError && selectedScopeKey.value === selected && epoch === loadEpoch) editorOpen.value = false;
    reportFailure("save", error, context);
  }
  finally { saving.value = false; }
}

/** Confirms and removes one phrase. */
function remove(item: QuickPhrase): void {
  const selected = selectedScopeKey.value;
  const epoch = loadEpoch;
  const context = captureFailureContext(item.id);
  const modal = Modal.confirm({ title: "删除常用提示词", content: `确认删除“${item.title}”吗？`, okText: "删除", okType: "danger", cancelText: "取消", onOk: async () => {
    try {
      if (selectedScopeKey.value !== selected || epoch !== loadEpoch) throw new Error("常用提示词范围已切换，请重新选择");
      await store.remove(requestContext.value, item); trackProductEvent("quick_phrase_delete");
    } catch (error) {
      if (error instanceof QuickPhraseCacheWriteError) modal.destroy();
      reportFailure("delete", error, context);
      throw error;
    }
  } });
}

/** Moves one item by one position while preserving complete ordering. */
async function move(item: QuickPhrase, delta: number): Promise<void> {
  const index = store.items.findIndex((candidate) => candidate.id === item.id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= store.items.length) return;
  const ids = store.items.map((candidate) => candidate.id);
  const context = captureFailureContext(item.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  try { await store.reorder(requestContext.value, ids); trackProductEvent("quick_phrase_reorder"); }
  catch (error) { reportFailure("reorder", error, context); }
}

/** Tracks the compact layout breakpoint for the mobile bottom drawer. */
function syncMobile(): void { mobile.value = Boolean(mediaQuery?.matches); }
onMounted(() => { mediaQuery = window.matchMedia("(max-width: 767px)"); syncMobile(); mediaQuery.addEventListener("change", syncMobile); });
onUnmounted(() => mediaQuery?.removeEventListener("change", syncMobile));
</script>

<template>
  <a-popover v-if="!mobile" :open="open" trigger="click" placement="topRight" overlay-class-name="quick-phrase-overlay" @open-change="setOpen">
    <template #content>
      <div class="quick-phrase-panel">
        <div class="quick-phrase-head"><a-input v-model:value="query" allow-clear size="small" placeholder="搜索常用提示词..." /><a-tooltip title="新增常用提示词"><a-button size="small" type="text" @click="edit(null)"><PlusOutlined /></a-button></a-tooltip></div>
        <a-alert v-if="collectionError" type="error" show-icon :message="collectionError"><template #action><a-button size="small" @click="setOpen(true)">重试</a-button></template></a-alert>
        <a-spin :spinning="store.loading || store.refreshing"><div class="quick-phrase-list">
          <a-empty v-if="!filtered.length && !collectionError" description="暂无常用提示词" />
          <div v-for="(item, index) in filtered" :key="item.id" class="quick-phrase-item" :class="{ 'quick-phrase-item--disabled': disabled }" @click="insert(item)">
            <div class="quick-phrase-copy"><strong>{{ item.title }}</strong><span>{{ item.content }}</span></div>
            <div class="quick-phrase-actions" @click.stop><a-button size="small" type="text" :disabled="index === 0 || filtered.length !== store.items.length" @click="move(item, -1)"><ArrowUpOutlined /></a-button><a-button size="small" type="text" :disabled="index === filtered.length - 1 || filtered.length !== store.items.length" @click="move(item, 1)"><ArrowDownOutlined /></a-button><a-button size="small" type="text" @click="edit(item)"><EditOutlined /></a-button><a-button size="small" type="text" danger @click="remove(item)"><DeleteOutlined /></a-button></div>
          </div>
        </div></a-spin>
      </div>
    </template>
    <a-button size="small" type="text" aria-label="常用提示词" title="常用提示词"><SnippetsOutlined /></a-button>
  </a-popover>
  <a-button v-else size="small" type="text" aria-label="常用提示词" title="常用提示词" @click="setOpen(true)"><SnippetsOutlined /></a-button>
  <a-drawer v-if="mobile" :open="open" title="常用提示词" placement="bottom" height="70vh" @close="setOpen(false)">
    <div class="quick-phrase-panel quick-phrase-panel--mobile">
      <div class="quick-phrase-head"><a-input v-model:value="query" allow-clear size="small" placeholder="搜索常用提示词..." /><a-tooltip title="新增常用提示词"><a-button size="small" type="text" @click="edit(null)"><PlusOutlined /></a-button></a-tooltip></div>
      <a-alert v-if="collectionError" type="error" show-icon :message="collectionError"><template #action><a-button size="small" @click="setOpen(true)">重试</a-button></template></a-alert>
      <a-spin :spinning="store.loading || store.refreshing"><div class="quick-phrase-list">
        <a-empty v-if="!filtered.length && !collectionError" description="暂无常用提示词" />
        <div v-for="(item, index) in filtered" :key="item.id" class="quick-phrase-item" :class="{ 'quick-phrase-item--disabled': disabled }" @click="insert(item)">
          <div class="quick-phrase-copy"><strong>{{ item.title }}</strong><span>{{ item.content }}</span></div>
          <div class="quick-phrase-actions" @click.stop><a-button size="small" type="text" :disabled="index === 0 || filtered.length !== store.items.length" @click="move(item, -1)"><ArrowUpOutlined /></a-button><a-button size="small" type="text" :disabled="index === filtered.length - 1 || filtered.length !== store.items.length" @click="move(item, 1)"><ArrowDownOutlined /></a-button><a-button size="small" type="text" @click="edit(item)"><EditOutlined /></a-button><a-button size="small" type="text" danger @click="remove(item)"><DeleteOutlined /></a-button></div>
        </div>
      </div></a-spin>
    </div>
  </a-drawer>
  <a-modal v-model:open="editorOpen" :title="editing ? '编辑常用提示词' : '新增常用提示词'" :confirm-loading="saving" ok-text="保存" cancel-text="取消" @ok="save">
    <a-form layout="vertical"><a-form-item label="名称" required><a-input v-model:value="title" :maxlength="50" show-count /></a-form-item><a-form-item label="内容" required><a-textarea v-model:value="content" :maxlength="8000" show-count :auto-size="{ minRows: 5, maxRows: 12 }" /></a-form-item></a-form>
  </a-modal>
</template>

<style scoped>
.quick-phrase-panel { width: min(420px, calc(100vw - 32px)); }
.quick-phrase-head { display: flex; gap: 8px; margin-bottom: 8px; }
.quick-phrase-list { max-height: 420px; overflow-y: auto; }
.quick-phrase-item { display: flex; align-items: center; gap: 8px; min-height: 58px; padding: 8px; border-bottom: 1px solid var(--app-border); cursor: pointer; }
.quick-phrase-item:hover { background: var(--app-hover-bg); }
.quick-phrase-item--disabled { cursor: not-allowed; }
.quick-phrase-copy { min-width: 0; flex: 1; }
.quick-phrase-copy strong, .quick-phrase-copy span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quick-phrase-copy span { margin-top: 4px; color: var(--app-muted); font-size: 12px; }
.quick-phrase-actions { display: flex; flex: none; }
.quick-phrase-panel--mobile { width: 100%; }
</style>
