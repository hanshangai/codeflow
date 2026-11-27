<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { KNOWLEDGE_MAX_REVIEW_ROUNDS, validateCronExpression, type KnowledgeAssetsSnapshot, type KnowledgeGenerationRunView, type KnowledgeUpdateSchedule, type KnowledgeUpdateView } from "@codeflowai/shared";
import { requestKnowledgeAsset } from "../../../api/projectKnowledge";
import { createApiResultError, isApiResultError, type ApiRequestContext } from "../../../api/request";
import { useEngineStore } from "../../../store/engine";
import { useEngineExecutionOptions } from "../../../composables/useEngineExecutionOptions";

const props = defineProps<{ open: boolean; workspaceId: string; context: ApiRequestContext; snapshot: KnowledgeAssetsSnapshot | null; selectedNodeIds: string[]; initialEngine?: "codex" | "claude"; initialModel?: string | null; initialEffort?: string | null }>();
const emit = defineEmits<{ "update:open": [open: boolean]; "view-run": [run: KnowledgeGenerationRunView] }>();
const engines = useEngineStore();
const view = ref<KnowledgeUpdateView | null>(null);
const loading = ref(false), saving = ref(false), checking = ref(false), errorText = ref("");
const form = reactive({ enabled: false, frequency: "daily", time: "03:00", weekday: 1, cronExpr: "0 3 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, selectedNodeIds: [] as string[], includeDescendants: true, engine: "codex" as "codex" | "claude", model: "", effort: "", concurrency: 5, prompt: "", reviewModel: "", reviewEffort: "", maxRounds: KNOWLEDGE_MAX_REVIEW_ROUNDS });
const options = useEngineExecutionOptions({ engine: () => form.engine, model: () => form.model, effort: () => form.effort, workspaceId: () => props.workspaceId });
const reviewOptions = useEngineExecutionOptions({ engine: () => form.engine, model: () => form.reviewModel, effort: () => form.reviewEffort, workspaceId: () => props.workspaceId });
const treeData = computed(() => props.snapshot?.tree.nodes.filter(node => !node.archived).map(node => ({ id: node.id, pId: node.parentId, value: node.id, title: node.title })) ?? []);
const cronExpr = computed(() => {
  if (form.frequency === "custom") return form.cronExpr.trim();
  const [hour, minute] = form.time.split(":").map(Number);
  return `${minute} ${hour} * * ${form.frequency === "weekly" ? form.weekday : "*"}`;
});
const busy = computed(() => view.value?.lastCheck?.outcome === "checking" || Boolean(view.value?.run?.active));
/** 空计划只展示核对结论；目录或正文候选仍走统一采用入口。 */
const checkOnly = computed(() => {
  const run = view.value?.run;
  if (!run?.maintenance || run.phase !== "completed" || run.items.length || !run.proposedTree || !run.baseTree
    || run.proposedTree.schemaVersion !== run.baseTree.schemaVersion || run.proposedTree.nodes.length !== run.baseTree.nodes.length) return false;
  const baseline = new Map(run.baseTree.nodes.map(node => [node.id, JSON.stringify(node)]));
  return run.proposedTree.nodes.every(node => JSON.stringify(node) === baseline.get(node.id));
});
const statusText = computed(() => {
  const state = view.value?.lastCheck, run = view.value?.run;
  if (!state) return "尚未检查";
  if (state.outcome === "failed") return "检查失败";
  if (state.outcome === "checking") return "正在比较来源与要求";
  if (state.outcome === "unchanged") return "没有需要更新的资产";
  if (state.outcome === "busy") return "资产正在其他任务中处理，本次暂缓";
  if (run?.active) return run.maintenance && !run.proposedTree ? "正在核对规格与项目变化" : "正在生成与复检";
  if (checkOnly.value) return run?.gaps.length ? "检查完成，有事项待核对" : "检查完成，无需更新";
  return run?.phase === "completed" ? "已完成，请查看结果并采用" : "部分任务未完成，请查看结果";
});
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

/** 只在面板打开且检查运行时同步摘要，不刷新页面或覆盖表单。 */
function queueRefresh(): void {
  if (timer) clearTimeout(timer);
  if (props.open && busy.value) timer = setTimeout(() => { void load(false); }, 5_000);
}

/** 面板及工作区拥有请求生命周期，切换后旧响应不能覆盖新配置。 */
async function load(fillForm: boolean): Promise<void> {
  const current = ++generation;
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal;
  loading.value = true; errorText.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "update.schedule", { workspaceId: props.workspaceId }, { signal });
    if (!result.ok) throw createApiResultError(result);
    if (signal.aborted || current !== generation) return;
    view.value = result.data;
    if (fillForm) fill(result.data.schedule);
    queueRefresh();
  } catch (error) { if (!signal.aborted && current === generation) fail(error, "KNOWLEDGE_UPDATE_READ_FAILED"); }
  finally { if (current === generation) loading.value = false; }
}

/** 首次配置使用当前选区；聊天历史和引擎 session 不进入项目计划。 */
function fill(schedule: KnowledgeUpdateSchedule | null): void {
  Object.assign(form, { enabled: schedule?.enabled ?? false, frequency: "custom", cronExpr: schedule?.cronExpr ?? "0 3 * * *", timezone: schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    selectedNodeIds: schedule ? [...schedule.selectedNodeIds] : [...props.selectedNodeIds], includeDescendants: schedule?.includeDescendants ?? true,
    engine: schedule?.engine ?? props.initialEngine ?? "codex", model: schedule ? schedule.model ?? "" : props.initialModel ?? "", effort: schedule ? schedule.effort ?? "" : props.initialEffort ?? "", concurrency: schedule?.concurrency ?? 5, prompt: schedule?.prompt ?? "",
    reviewModel: schedule ? schedule.reviewConfig.model ?? "" : props.initialModel ?? "", reviewEffort: schedule ? schedule.reviewConfig.effort ?? "" : props.initialEffort ?? "", maxRounds: schedule?.reviewConfig.maxRounds ?? KNOWLEDGE_MAX_REVIEW_ROUNDS });
  const match = /^(\d+) (\d+) \* \* (\*|[0-6])$/.exec(form.cronExpr);
  if (match) { form.frequency = match[3] === "*" ? "daily" : "weekly"; form.time = `${match[2].padStart(2, "0")}:${match[1].padStart(2, "0")}`; form.weekday = match[3] === "*" ? 1 : Number(match[3]); }
}

/** 保存后才改变实际调度，运行中的批次保留原配置。 */
async function save(): Promise<void> {
  if (saving.value || loading.value) return;
  const validation = validateCronExpression(cronExpr.value);
  if (!validation.ok) { errorText.value = validation.message; return; }
  const current = generation, workspaceId = props.workspaceId;
  if (timer) clearTimeout(timer); timer = null;
  saving.value = true; errorText.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "update.save", { workspaceId, expectedHash: view.value?.hash ?? null,
      schedule: { enabled: form.enabled, cronExpr: cronExpr.value, timezone: form.timezone, selectedNodeIds: form.selectedNodeIds, includeDescendants: form.includeDescendants, engine: form.engine, model: form.model || null, effort: form.effort || null, concurrency: form.concurrency, prompt: form.prompt,
        reviewConfig: { enabled: true, model: form.reviewModel || null, effort: form.reviewEffort || null, autoRepair: true, maxRounds: form.maxRounds } } }, { method: "POST", signal: controller?.signal });
    if (!result.ok) throw createApiResultError(result);
    if (current !== generation || workspaceId !== props.workspaceId) return;
    view.value = result.data; fill(result.data.schedule);
  } catch (error) { if (current === generation) fail(error, "KNOWLEDGE_UPDATE_SAVE_FAILED"); }
  finally { if (current === generation) { saving.value = false; queueRefresh(); } }
}

/** 立即检查使用已保存计划，新版本始终等待人工采用。 */
async function checkNow(): Promise<void> {
  if (!view.value?.schedule || checking.value || busy.value) return;
  const current = generation, workspaceId = props.workspaceId;
  if (timer) clearTimeout(timer); timer = null;
  checking.value = true; errorText.value = "";
  try {
    const result = await requestKnowledgeAsset(props.context, "update.run", { workspaceId }, { method: "POST", signal: controller?.signal });
    if (!result.ok) throw createApiResultError(result);
    if (current !== generation || workspaceId !== props.workspaceId) return;
    view.value = result.data; queueRefresh();
  } catch (error) { if (current === generation) fail(error, "KNOWLEDGE_UPDATE_START_FAILED"); }
  finally { if (current === generation) { checking.value = false; queueRefresh(); } }
}

/** 引擎切换后清空不适用的模型参数，沿用会话模型目录。 */
function changeEngine(): void { form.model = ""; form.effort = ""; form.reviewModel = ""; form.reviewEffort = ""; }

/** 当前处理边界记录诊断，并把请求 ID 随失败展示。 */
function fail(error: unknown, code: string): void {
  const details = isApiResultError(error) ? error.details as Record<string, unknown> | undefined : undefined;
  const requestId = String(details?.requestId ?? (error && typeof error === "object" && "requestId" in error ? error.requestId : "") ?? ""), rootCause = error instanceof Error ? error.message : String(error);
  errorText.value = requestId ? `${rootCause}（请求 ID：${requestId}）` : rootCause;
  console.error("[knowledge-updates]", { code, requestId, workspaceId: props.workspaceId, rootCause });
}

/** 释放面板请求和定时器，并清除旧工作区的操作状态。 */
function release(): void { generation += 1; controller?.abort(); controller = null; if (timer) clearTimeout(timer); timer = null; loading.value = false; saving.value = false; checking.value = false; }
/** 当前打开周期拥有模型读取失败；关闭或重开后忽略旧请求结果。 */
watch(() => [props.open, props.workspaceId] as const, ([open]) => {
  release(); view.value = null; errorText.value = "";
  if (open) {
    void load(true);
    const scope = props.workspaceId, current = generation;
    void engines.refresh(props.context, scope, { shouldApply: () => current === generation && props.open && props.workspaceId === scope })
      .catch(error => { if (current === generation && props.open && props.workspaceId === scope) fail(error, "KNOWLEDGE_MODEL_CATALOG_FAILED"); });
  }
}, { immediate: true });
onBeforeUnmount(release);
</script>

<template>
  <a-modal :open="open" title="定时更新规格库" width="min(720px, calc(100vw - 24px))" :style="{ top: '56px' }" :body-style="{ maxHeight: 'calc(100dvh - 200px)', overflowY: 'auto' }" :closable="!saving && !checking" :mask-closable="!saving && !checking" :keyboard="!saving && !checking" @cancel="emit('update:open', false)">
    <div class="update-settings" data-testid="knowledge-update-settings">
      <p class="update-note">设置检查时间与范围，来源或要求变化时生成更新草稿，确认采用后才生效。</p>
      <a-alert v-if="errorText" type="error" show-icon :message="errorText" />
      <a-spin v-if="loading && !view" />
      <template v-else>
        <div class="update-toggle"><span>启用定时更新</span><a-switch v-model:checked="form.enabled" aria-label="启用定时更新" /></div>
        <a-form layout="vertical">
          <h3>检查时间</h3>
          <div class="setting-row">
            <a-form-item class="setting-field" label="执行频率"><a-select v-model:value="form.frequency" aria-label="执行频率" :options="[{ value: 'daily', label: '每天' }, { value: 'weekly', label: '每周' }, { value: 'custom', label: '自定义 cron' }]" /></a-form-item>
            <a-form-item v-if="form.frequency !== 'custom'" class="setting-field" label="执行时间"><a-input v-model:value="form.time" type="time" aria-label="执行时间" /></a-form-item>
            <a-form-item v-if="form.frequency === 'weekly'" class="setting-field" label="星期"><a-select v-model:value="form.weekday" aria-label="星期" :options="['日','一','二','三','四','五','六'].map((day, value) => ({ value, label: `星期${day}` }))" /></a-form-item>
          </div>
          <a-form-item v-if="form.frequency === 'custom'" label="cron（分 时 日 月 星期）"><a-input v-model:value="form.cronExpr" aria-label="更新 cron" /></a-form-item>
          <a-form-item label="时区"><a-input v-model:value="form.timezone" aria-label="更新时区" /></a-form-item>
          <h3>更新范围</h3>
          <a-form-item label="更新范围" extra="留空表示整个项目；已有待采用版本的资产暂缓更新。"><a-tree-select v-model:value="form.selectedNodeIds" aria-label="定时更新范围" :tree-data="treeData" tree-data-simple-mode tree-checkable show-checked-strategy="SHOW_PARENT" allow-clear placeholder="整个项目" :max-tag-count="2" /></a-form-item>
          <a-form-item label="包含所选目录的后代"><a-switch v-model:checked="form.includeDescendants" aria-label="定时更新包含后代" /></a-form-item>
          <h3>执行设置</h3>
          <div class="setting-row">
            <a-form-item class="setting-field" label="引擎"><a-select v-model:value="form.engine" aria-label="定时更新引擎" :options="[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]" @change="changeEngine" /></a-form-item>
            <a-form-item class="setting-field" label="并发数"><a-input-number v-model:value="form.concurrency" aria-label="定时更新并发" :min="1" :max="16" :precision="0" /></a-form-item>
          </div>
          <a-form-item label="生成模型"><a-select v-model:value="form.model" aria-label="定时生成模型" :options="[{ value: '', label: '引擎默认' }, ...options.modelOptions.value]" show-search option-filter-prop="label" @change="form.effort = ''" /></a-form-item>
          <a-form-item label="生成思考强度"><a-select v-model:value="form.effort" aria-label="定时生成思考强度" :options="[{ value: '', label: '模型默认' }, ...options.effortOptions.value]" /></a-form-item>
          <a-form-item label="复检模型"><a-select v-model:value="form.reviewModel" aria-label="定时复检模型" :options="[{ value: '', label: '引擎默认' }, ...reviewOptions.modelOptions.value]" show-search option-filter-prop="label" @change="form.reviewEffort = ''" /></a-form-item>
          <div class="setting-row">
            <a-form-item class="setting-field" label="复检思考强度"><a-select v-model:value="form.reviewEffort" aria-label="定时复检思考强度" :options="[{ value: '', label: '模型默认' }, ...reviewOptions.effortOptions.value]" /></a-form-item>
            <a-form-item class="setting-field" label="最多复检轮数"><a-input-number v-model:value="form.maxRounds" aria-label="定时复检轮数" :min="1" :max="KNOWLEDGE_MAX_REVIEW_ROUNDS" :precision="0" /></a-form-item>
          </div>
          <a-form-item label="补充要求"><a-textarea v-model:value="form.prompt" :rows="3" :maxlength="16000" placeholder="按目录要求自动判断生成或修改，可补充关注重点" aria-label="定时更新要求" /></a-form-item>
        </a-form>
        <p class="update-note">只补齐空资产、更新来源或要求变化的资产。自动复检与修订后，新版本仍需人工采用。</p>
        <p class="update-note">执行 Client：{{ view?.schedule?.executorClientId ?? view?.currentClientId }}。保存后绑定当前 Client，并使用其账号权限执行；离线周期在恢复后合并检查一次。</p>
        <section v-if="view?.schedule" class="update-status" aria-live="polite">
          <strong>{{ statusText }}</strong>
          <span v-if="view.nextRunAt">下次执行：{{ new Date(view.nextRunAt).toLocaleString() }}</span>
          <span v-if="view.lastCheck">最近检查：{{ new Date(view.lastCheck.checkedAt).toLocaleString() }} · 选中 {{ view.lastCheck.selectedCount }} 项 · 暂缓 {{ view.lastCheck.deferredCount }} 项</span>
          <a-alert v-if="view.lastCheck?.error" type="error" show-icon :message="view.lastCheck.error.message" />
          <span v-if="view.run && checkOnly">{{ view.run.rationale }}</span>
          <template v-if="view.run?.maintenance && view.run.gaps.length">
            <span v-if="view.lastCheck?.outcome !== 'started'">上一次核对发现的问题</span>
            <ul><li v-for="(gap, index) in view.run.gaps" :key="index">{{ gap }}</li></ul>
          </template>
          <a-button v-if="view.run && view.lastCheck?.outcome === 'started' && !checkOnly" @click="emit('view-run', view.run); emit('update:open', false)">查看生成结果</a-button>
        </section>
      </template>
    </div>
    <template #footer>
      <a-space wrap><a-button :disabled="saving || checking" @click="emit('update:open', false)">关闭</a-button><a-button :disabled="saving || checking" :loading="loading" @click="load(false)">刷新状态</a-button><a-button :disabled="!view?.schedule || loading || busy || saving || !snapshot?.canWrite" :loading="checking" @click="checkNow">立即检查</a-button><a-button type="primary" :disabled="loading || !view || !snapshot?.canWrite" :loading="saving" @click="save">保存计划</a-button></a-space>
    </template>
  </a-modal>
</template>

<style scoped>
.update-settings { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.update-settings :deep(.ant-form-item) { margin-bottom: 12px; }
.update-settings h3 { margin: 16px 0 12px; padding-top: 12px; border-top: 1px solid var(--app-divider); font-size: 14px; }
.update-toggle { display: flex; align-items: center; justify-content: space-between; }
.setting-row { display: flex; flex-wrap: wrap; gap: 12px; }
.setting-field { flex: 1; min-width: 120px; }
.update-note { color: var(--app-muted); font-size: 12px; margin: 0; }
.update-status { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding-top: 16px; border-top: 1px solid var(--app-border); font-size: 12px; }
</style>
