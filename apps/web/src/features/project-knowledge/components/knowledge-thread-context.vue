<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import type { KnowledgeAssetsSnapshot, KnowledgeConversationSummary, ThreadSummary, WorkspaceId } from "@codeflowai/shared";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { createApiResultError, isApiResultError } from "../../../api/request";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { isDesktopWorkspace } from "../../../services/desktop";
import { resolveKnowledgeThreadContext, type KnowledgeThreadContext } from "../knowledgeThreadContext";

const props = defineProps<{ workspaceId: WorkspaceId; thread: ThreadSummary; readOnly: boolean }>();
const emit = defineEmits<{ ready: [state: { threadId: string; canContinue: boolean }] }>();
const config = useConfigStore();
const { ctx } = useApiContext();
const router = useRouter();
const context = ref<KnowledgeThreadContext | null>(null);
const snapshot = ref<KnowledgeAssetsSnapshot | null>(null);
const conversations = ref<KnowledgeConversationSummary[]>([]);
const loading = ref(true);
const errorText = ref<string | null>(null);
const resuming = ref(false);
let epoch = 0;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 桌面本机规格库不依赖 Server 连接。 */
const workspaceAvailable = computed(() => config.connected || isDesktopWorkspace(config, props.workspaceId));
const canWrite = computed(() => snapshot.value?.canWrite === true && !props.readOnly && !props.thread.archived);
const canContinue = computed(() => canWrite.value && !loading.value && !resuming.value && !errorText.value && context.value?.active === true && !context.value.busy && context.value.kind !== "知识规划");
const scopeTitle = computed(() => snapshot.value?.tree.nodes.find(node => node.id === context.value?.nodeId)?.title ?? context.value?.title ?? props.thread.title);
const statusText = computed(() => {
  if (!workspaceAvailable.value) return "连接断开，当前仅可查看已加载历史";
  if (loading.value) return "正在核对会话状态…";
  if (errorText.value) return "状态读取失败，暂停续聊";
  if (!canWrite.value) return "当前仅可查看";
  if (context.value?.kind === "知识规划") return context.value.busy ? "知识任务执行中，规划过程仅可查看" : "规划过程仅可查看，请在规格知识库管理或继续任务";
  if (context.value?.busy) return "后台任务执行或采用中，结束后可继续交流";
  if (!context.value?.active) return "协作已结束，恢复后可继续交流";
  return context.value?.kind === "复检" ? "可追问复检依据，修改正文请打开文件工作会话" : "可继续交流，修订版本需确认采用";
});

/** 只有当前线程已核对范围、权限和任务占用时才开放输入。 */
watch([canContinue, () => props.thread.id], () => emit("ready", { threadId: props.thread.id, canContinue: canContinue.value && workspaceAvailable.value }), { immediate: true });

/** 记录拥有完整会话上下文的失败，并在当前面板显式阻止后续写入。 */
function reportFailure(error: unknown): void {
  const details = isApiResultError(error) ? error.details as { requestId?: string } | undefined : undefined;
  const code = isApiResultError(error) ? error.code : "KNOWLEDGE_THREAD_CONTEXT_FAILED";
  const reason = error instanceof Error ? error.message : String(error);
  errorText.value = `${reason}（${code}）`;
  console.error("[knowledge-thread.context.failed]", { code, requestId: details?.requestId ?? `knowledge-thread-context-${props.thread.id}`, workspaceId: props.workspaceId, threadId: props.thread.id, ownerThreadId: context.value?.ownerThreadId, rootCause: reason });
}

/** 取消旧线程的轮询与请求，迟到结果不能影响新选中的会话。 */
function stopRefresh(): void {
  epoch++;
  controller?.abort();
  controller = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** 沿用知识读取接口核对关联；首屏和重试读取范围，轮询只读任务与协作状态。 */
async function refresh(initial = false): Promise<void> {
  stopRefresh();
  const ticket = epoch;
  const scope = props.workspaceId;
  const threadId = props.thread.id;
  const request = new AbortController();
  controller = request;
  const current = () => ticket === epoch && !request.signal.aborted;
  if (initial) loading.value = true;
  try {
    if (!workspaceAvailable.value) throw new Error("需要连接 Server 才能核对规格会话状态");
    if (initial || !snapshot.value) {
      const result = await requestKnowledgeAsset(ctx.value, "snapshot", { workspaceId: scope }, { signal: request.signal });
      if (!result.ok) throw createApiResultError(result);
      if (!current()) return;
      snapshot.value = result.data;
    }
    const runs = await requestKnowledgeAsset(ctx.value, "runs", { workspaceId: scope }, { signal: request.signal });
    if (!runs.ok) throw createApiResultError(runs);
    if (!current()) return;
    if (canWrite.value) {
      const result = await requestKnowledgeAsset(ctx.value, "conversation.list", { workspaceId: scope }, { signal: request.signal });
      if (!result.ok) throw createApiResultError(result);
      if (!current()) return;
      conversations.value = result.data;
    } else conversations.value = [];
    const resolved = resolveKnowledgeThreadContext(threadId, conversations.value, runs.data);
    if (!resolved && canWrite.value) throw new Error("未找到当前会话的规格范围或所属任务，请检查规格库中的任务记录");
    if (resolved && canWrite.value && !conversations.value.some(item => item.threadId === resolved.ownerThreadId)) throw new Error("所属协作会话不可用或无权继续，当前仅可查看历史");
    context.value = resolved;
    errorText.value = null;
  } catch (error) {
    if (!current()) return;
    reportFailure(error);
  } finally {
    if (current()) {
      loading.value = false;
      if (!errorText.value) timer = setTimeout(() => { void refresh(); }, 5000);
    }
  }
}

/** 用户显式恢复可续聊线程的宿主授权；规划过程仍由原任务管理。 */
async function resume(): Promise<void> {
  const ownerId = context.value?.ownerThreadId;
  if (!ownerId || !canWrite.value || context.value?.busy || context.value?.kind === "知识规划" || resuming.value) return;
  stopRefresh();
  const ticket = epoch;
  resuming.value = true;
  try {
    const result = await requestKnowledgeAsset(ctx.value, "conversation.connect", { workspaceId: props.workspaceId, threadId: ownerId }, { method: "POST" });
    if (!result.ok) throw createApiResultError(result);
    if (ticket === epoch) await refresh();
  } catch (error) {
    if (ticket === epoch) reportFailure(error);
  } finally { resuming.value = false; }
}

/** 规划回到原任务的讨论宿主，其余线程沿用对应文档深链。 */
async function openDocument(): Promise<void> {
  try {
    const session = context.value?.kind === "知识规划" ? { threadId: context.value.ownerThreadId }
      : props.thread.threadSubtype === "knowledge-assets" ? { executionThreadId: props.thread.id } : { threadId: props.thread.id };
    await router.push({ path: "/knowledge", query: { workspaceId: props.workspaceId, ...(context.value?.nodeId ? { nodeId: context.value.nodeId } : {}), ...session } });
  } catch (error) { reportFailure(error); }
}

/** 历史复检的正文修改回到已有文件工作会话。 */
async function openGeneration(): Promise<void> {
  if (!context.value?.generationThreadId) return;
  try { await router.push({ path: "/chat", query: { workspaceId: props.workspaceId, threadId: context.value.generationThreadId } }); }
  catch (error) { reportFailure(error); }
}

watch(() => [props.workspaceId, props.thread.id, workspaceAvailable.value, props.readOnly] as const, () => {
  snapshot.value = null; context.value = null; conversations.value = []; errorText.value = null;
  void refresh(true);
}, { immediate: true });
onBeforeUnmount(stopRefresh);
</script>

<template>
  <section class="knowledge-thread-context" aria-label="规格会话状态" data-testid="knowledge-thread-context">
    <div class="knowledge-thread-context__heading">
      <strong>{{ context?.kind ?? '规格会话' }} · {{ scopeTitle }}</strong>
      <a-button size="small" @click="openDocument">{{ context?.nodeId ? '查看对应文档' : '打开规格库' }}</a-button>
      <a-button v-if="context?.kind === '复检' && context.generationThreadId" size="small" @click="openGeneration">打开文件工作会话</a-button>
    </div>
    <div class="knowledge-thread-context__status">
      <span>{{ statusText }}</span>
      <a-button v-if="!loading && !errorText && canWrite && context && !context.active && context.kind !== '知识规划'" size="small" :loading="resuming" :disabled="context.busy" @click="resume">恢复协作</a-button>
    </div>
    <div v-if="errorText" class="knowledge-thread-context__error">
      <a-alert type="error" :message="errorText" show-icon />
      <a-button size="small" @click="refresh(true)">重试</a-button>
    </div>
  </section>
</template>

<style scoped>
.knowledge-thread-context { flex: 0 0 auto; padding: 10px 16px; border-bottom: 1px solid var(--app-divider); }
.knowledge-thread-context__heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.knowledge-thread-context__heading strong { min-width: 0; overflow-wrap: anywhere; }
.knowledge-thread-context__status { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--app-muted); font-size: 12px; }
.knowledge-thread-context__error { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
</style>
