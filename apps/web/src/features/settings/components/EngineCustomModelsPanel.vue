<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { AppstoreOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons-vue";
import {
  ENGINE_MODEL_PROVIDERS,
  getSupportedReasoningEffortsForProvider,
  getModelContextWindowBounds,
  toEngineModelInfoFromCustomModel,
  type EngineCustomModelEntry,
  type EngineModelProviderId,
  type EngineType,
  type InputModality,
  type ReasoningEffort,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { createCancelledRequestError, isCancelledRequestError } from "../../../api/request";
import { deleteEngineCustomModel, listEngineCustomModels, upsertEngineCustomModel } from "../../../api/engineModels";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { isDesktopWorkspace } from "../../../services/desktop";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "EngineCustomModelsPanel" });

const props = withDefaults(defineProps<{
  active?: boolean;
  surface?: "default" | "h5";
  engineScope?: EngineType | null;
  providerScope?: EngineModelProviderId | null;
  hideDisabledReasonAlert?: boolean;
  /** 由组合页面统一展示首次加载状态时，隐藏本组件的加载指示。 */
  externalInitialLoadingIndicator?: boolean;
}>(), {
  active: true,
  surface: "default",
  engineScope: null,
  providerScope: null,
  hideDisabledReasonAlert: false,
  externalInitialLoadingIndicator: false,
});

const emit = defineEmits<{
  (event: "initial-loading-change", loading: boolean): void;
}>();

type ModelForm = {
  engine: EngineType;
  providerId: EngineModelProviderId;
  modelId: string;
  displayName: string;
  inputModalities: InputModality[];
  supportedReasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort | "";
  maxContextWindow: number | null;
  supportsFastMode: boolean;
  enabled: boolean;
};

const { ctx } = useApiContext();
const config = useConfigStore();
const engines = useEngineStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();

const loading = ref(false);
const submitting = ref(false);
const deletingId = ref<string | null>(null);
const models = ref<EngineCustomModelEntry[]>([]);
const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const loadError = ref("");
let loadGeneration = 0;

const form = reactive<ModelForm>({
  engine: props.engineScope ?? "claude",
  providerId: resolveDefaultProviderId(props.engineScope ?? "claude"),
  modelId: "",
  displayName: "",
  inputModalities: ["text"],
  supportedReasoningEfforts: [],
  defaultReasoningEffort: "",
  maxContextWindow: null,
  supportsFastMode: false,
  enabled: true,
});

const currentWorkspace = computed(() => config.workspaceId ? workspaces.byId.get(config.workspaceId as any) ?? null : null);
const isSharedWorkspace = computed(() =>
  Boolean(currentWorkspace.value?.kind === "shared" || isSharedWorkspaceSelectionId(config.workspaceId)),
);
const canMaintainSharedHostKeys = computed(() =>
  Boolean(
    isSharedWorkspace.value
    && currentWorkspace.value?.shared?.isHostOwner === true
    && currentWorkspace.value?.capabilities?.canMaintainAssets === true,
  ),
);
/** 桌面本机工作区走本地桥，未登录 Server 也可管理自定义模型。 */
const workspaceReady = computed(() => Boolean(
  config.workspaceId && (config.connected || isDesktopWorkspace(config, config.workspaceId)),
));
const canUseRoute = computed(() =>
  workspaceReady.value
  && (isSharedWorkspace.value ? canMaintainSharedHostKeys.value : presence.isCurrentWorkspaceClientOnline),
);
const disabledReason = computed(() => {
  if (!config.workspaceId) return "请先选择工作区后再管理自定义模型。";
  if (!workspaceReady.value) return "请先连接 Server 后再管理自定义模型。";
  if (isSharedWorkspace.value && !canMaintainSharedHostKeys.value) return "共享工作区成员不可维护自定义模型，请由共享工作区 Host 处理。";
  if (!isSharedWorkspace.value && !presence.isCurrentWorkspaceClientOnline) return "请先启动当前工作区的 Client，自定义模型保存在本地 Client。";
  return "";
});
const operating = computed(() => loading.value || submitting.value || Boolean(deletingId.value));
/** 仅空列表首次读取需要占位；已有数据刷新不阻断浏览和操作。 */
const initialLoading = computed(() => props.active && loading.value && !models.value.length);
const scopedModels = computed(() =>
  models.value
    .filter((model) => !props.engineScope || model.engine === props.engineScope)
    .filter((model) => !props.providerScope || model.providerId === props.providerScope)
    .sort((left, right) => right.updatedAt - left.updatedAt),
);
/** 仅展示当前供应商的自定义模型，内置模型由会话选择器提供。 */
const modelRows = computed(() => scopedModels.value.map(custom => ({
  engine: custom.engine, info: toEngineModelInfoFromCustomModel(custom), custom,
})));

/** 紧凑展示窗口容量；精确 token 数通过 title 保留。 */
function formatWindow(value: number): string {
  return value >= 1_000_000 ? `${Number((value / 1_000_000).toFixed(2))}M`
    : value >= 1000 ? `${Number((value / 1000).toFixed(2))}K` : String(value);
}

const engineOptions = computed(() =>
  (["claude", "codex"] as EngineType[])
    .filter((engine) => !props.engineScope || engine === props.engineScope)
    .map((engine) => ({ value: engine, label: engine === "claude" ? "Claude" : "Codex" })),
);
const providerOptions = computed(() =>
  Object.values(ENGINE_MODEL_PROVIDERS)
    .filter((provider) => provider.engines.includes(form.engine))
    .filter((provider) => !props.providerScope || provider.providerId === props.providerScope)
    .map((provider) => ({ value: provider.providerId, label: provider.providerLabel })),
);
const reasoningEffortOptions = computed<Array<{ value: ReasoningEffort; label: string }>>(() =>
  getSupportedReasoningEffortsForProvider(form.engine, form.providerId)
    .map((item) => ({ value: item.reasoningEffort, label: item.reasoningEffort })),
);
const defaultEffortOptions = computed(() => [
  ...(form.supportedReasoningEfforts.length
    ? form.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort }))
    : [{ value: "", label: "不发送" }]),
]);

/** 按当前作用域选择新增模型的默认供应商。 */
function resolveDefaultProviderId(engine: EngineType): EngineModelProviderId {
  if (props.providerScope && ENGINE_MODEL_PROVIDERS[props.providerScope]?.engines.includes(engine)) return props.providerScope;
  return engine === "codex" ? "openai" : "anthropic";
}

/** 重置表单并按当前页面作用域补齐默认引擎/供应商。 */
function resetForm(): void {
  form.engine = props.engineScope ?? "claude";
  form.providerId = resolveDefaultProviderId(form.engine);
  form.modelId = "";
  form.displayName = "";
  form.inputModalities = ["text"];
  form.supportedReasoningEfforts = [];
  form.defaultReasoningEffort = "";
  form.maxContextWindow = null;
  form.supportsFastMode = false;
  form.enabled = true;
  editingId.value = null;
}

/** 按当前 engine/provider 清理不可配置的 effort，避免保留无效旧选择。 */
function pruneUnsupportedEfforts(): void {
  const allowed = new Set(reasoningEffortOptions.value.map((option) => option.value));
  form.supportedReasoningEfforts = form.supportedReasoningEfforts.filter((effort) => allowed.has(effort));
  if (form.defaultReasoningEffort && !allowed.has(form.defaultReasoningEffort)) {
    form.defaultReasoningEffort = form.supportedReasoningEfforts[0] ?? "";
  }
}

/** 仅读取自定义模型，失败向调用方显式抛出。 */
async function refresh(): Promise<void> {
  const generation = ++loadGeneration;
  if (!props.active) return;
  loading.value = true;
  loadError.value = "";
  const workspaceId = config.workspaceId;
  const accountScope = `${config.serverWsOrigin}|${config.userSummary?.userId ?? ''}`;
  const isCurrent = () => generation === loadGeneration && workspaceId === config.workspaceId
    && accountScope === `${config.serverWsOrigin}|${config.userSummary?.userId ?? ''}`;
  try {
    if (canUseRoute.value) {
      const res = await listEngineCustomModels(ctx.value, workspaceId);
      if (!isCurrent()) throw createCancelledRequestError("scope-change");
      if (!res.ok) throw new Error((res as any).message ?? "读取自定义模型失败");
      models.value = res.models;
    } else models.value = [];
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

/** 自动加载在组件边界记录并显示失败，停止后续操作并提供重试。 */
async function loadModels(): Promise<void> {
  const workspaceId = config.workspaceId;
  const generation = loadGeneration + 1;
  try { await refresh(); }
  catch (error) {
    if (isCancelledRequestError(error) || generation !== loadGeneration) return;
    loadError.value = error instanceof Error ? error.message : String(error);
    console.error("[model_settings.load_failed]", { code: "MODEL_SETTINGS_LOAD_FAILED", requestId: `model-settings-${Date.now()}`,
      workspaceId, userId: config.userSummary?.userId, rootCause: loadError.value });
  }
}

/** 刷新模型目录，使聊天和编排模型下拉立即使用最新自定义模型。 */
async function refreshCatalog(): Promise<void> {
  await engines.refresh(ctx.value, config.workspaceId);
}

/** 打开新增模型弹窗。 */
function openAddModal(): void {
  resetForm();
  modalOpen.value = true;
}

/** 打开编辑模型弹窗并回填当前配置。 */
function openEditModal(model: EngineCustomModelEntry): void {
  resetForm();
  editingId.value = model.id;
  form.engine = model.engine;
  form.providerId = model.providerId;
  form.modelId = model.modelId;
  form.displayName = model.displayName;
  form.inputModalities = model.inputModalities.length ? [...model.inputModalities] : ["text"];
  form.supportedReasoningEfforts = model.supportedReasoningEfforts.map((item) => item.reasoningEffort);
  form.defaultReasoningEffort = model.defaultReasoningEffort ?? form.supportedReasoningEfforts[0] ?? "";
  form.maxContextWindow = model.maxContextWindow ?? model.contextWindow;
  form.supportsFastMode = model.supportsFastMode;
  form.enabled = model.enabled;
  pruneUnsupportedEfforts();
  modalOpen.value = true;
}

/** 关闭弹窗并清理编辑状态。 */
function closeModal(): void {
  modalOpen.value = false;
  resetForm();
}

/** 保存自定义模型；provider、effort、上下文窗口在提交前做一致性校验。 */
async function submitModel(): Promise<void> {
  if (!canUseRoute.value) {
    message.info(disabledReason.value || "当前工作区暂不能维护自定义模型");
    return;
  }
  const modelId = form.modelId.trim();
  const displayName = form.displayName.trim() || modelId;
  if (!modelId) { message.warning("请输入模型 ID"); return; }
  if (props.engineScope && form.engine !== props.engineScope) { message.warning("当前页签不支持该引擎"); return; }
  if (props.providerScope && form.providerId !== props.providerScope) { message.warning("当前页签不支持该供应商"); return; }
  if (!form.inputModalities.length) { message.warning("请至少选择一种输入模态"); return; }
  if (form.defaultReasoningEffort && !form.supportedReasoningEfforts.includes(form.defaultReasoningEffort)) {
    message.warning("默认思考强度必须包含在支持列表中");
    return;
  }
  if (form.maxContextWindow != null && (!Number.isSafeInteger(form.maxContextWindow) || form.maxContextWindow <= 0)) {
    message.warning("模型最大容量必须是正整数");
    return;
  }
  submitting.value = true;
  const settingsAction = editingId.value ? "update_model" : "add_model";
  let mutationSucceeded = false;
  try {
    const res = await upsertEngineCustomModel(ctx.value, {
      id: editingId.value,
      engine: form.engine,
      providerId: form.providerId,
      modelId,
      displayName,
      inputModalities: form.inputModalities,
      supportedReasoningEfforts: form.supportedReasoningEfforts,
      defaultReasoningEffort: form.defaultReasoningEffort || null,
      contextWindow: form.maxContextWindow,
      maxContextWindow: form.maxContextWindow,
      supportsFastMode: form.supportsFastMode,
      supports1MContext: false,
      enabled: form.enabled,
    }, config.workspaceId);
    if (!res.ok) throw new Error((res as any).message ?? "保存自定义模型失败");
    message.success(editingId.value ? "自定义模型已更新" : "自定义模型已添加");
    mutationSucceeded = true;
    trackProductEvent("settings_save_success", { settings_panel: "custom_models", settings_action: settingsAction, source: "settings" });
    closeModal();
    await refresh();
    await refreshCatalog();
  } catch (error) {
    if (!mutationSucceeded && !isCancelledRequestError(error)) {
      trackProductEvent("settings_save_failed", { settings_panel: "custom_models", settings_action: settingsAction, source: "settings", error_code_group: "request_error" });
    }
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    submitting.value = false;
  }
}

/** 删除自定义模型并刷新统一模型目录。 */
async function removeModel(id: string): Promise<void> {
  if (!canUseRoute.value) {
    message.info(disabledReason.value || "当前工作区暂不能维护自定义模型");
    return;
  }
  deletingId.value = id;
  let mutationSucceeded = false;
  try {
    const res = await deleteEngineCustomModel(ctx.value, { id }, config.workspaceId);
    if (!res.ok) throw new Error((res as any).message ?? "删除自定义模型失败");
    message.success("自定义模型已删除");
    mutationSucceeded = true;
    trackProductEvent("settings_save_success", { settings_panel: "custom_models", settings_action: "delete_model", source: "settings" });
    await refresh();
    await refreshCatalog();
  } catch (error) {
    if (!mutationSucceeded && !isCancelledRequestError(error)) {
      trackProductEvent("settings_save_failed", { settings_panel: "custom_models", settings_action: "delete_model", source: "settings", error_code_group: "request_error" });
    }
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => { void loadModels(); });

watch(() => [props.active, config.workspaceId] as const, ([active, workspaceId], previous) => {
  if (workspaceId !== previous?.[1]) models.value = [];
  if (active) void loadModels();
});

watch(() => canUseRoute.value, (ready, previous) => {
  if (props.active && ready && ready !== previous) void loadModels();
});

watch(initialLoading, (value) => {
  emit("initial-loading-change", value);
}, { immediate: true });

watch(() => form.engine, (engine) => {
  const allowed = providerOptions.value.some((option) => option.value === form.providerId);
  if (!allowed) form.providerId = resolveDefaultProviderId(engine);
  if (engine !== "codex") form.supportsFastMode = false;
  pruneUnsupportedEfforts();
});

watch(() => form.providerId, () => {
  pruneUnsupportedEfforts();
});

watch(() => form.supportedReasoningEfforts.slice(), (efforts) => {
  if (!efforts.length) {
    form.defaultReasoningEffort = "";
    return;
  }
  if (!form.defaultReasoningEffort || !efforts.includes(form.defaultReasoningEffort)) {
    form.defaultReasoningEffort = efforts[0] ?? "";
  }
});
</script>

<template>
  <section class="custom-models">
    <a-alert
      v-if="disabledReason && !props.hideDisabledReasonAlert"
      class="custom-models__notice"
      type="info"
      show-icon
      :message="disabledReason"
    />
    <header class="custom-models__header">
      <div>
        <div class="custom-models__title">自定义模型 <span class="custom-models__count">{{ modelRows.length }}</span></div>
        <div class="custom-models__subtitle">接入内置目录以外的模型</div>
      </div>
      <a-button size="small" :disabled="!canUseRoute" aria-label="添加自定义模型" @click="openAddModal">
        <template #icon><PlusOutlined /></template>
        添加
      </a-button>
    </header>

    <template v-if="initialLoading">
      <a-spin
        v-if="!props.externalInitialLoadingIndicator"
        style="display: block; text-align: center; padding: 20px"
      />
    </template>
    <a-alert v-if="loadError" type="error" :message="loadError" show-icon>
      <template #action><a-button size="small" :loading="loading" @click="loadModels">重试</a-button></template>
    </a-alert>
    <div v-else-if="!loading && !modelRows.length" class="custom-models__empty">
      <AppstoreOutlined class="custom-models__empty-icon" />
      <strong>暂无自定义模型</strong>
      <span>内置模型已可直接选择。<br />需要其他模型时，再按需添加。</span>
    </div>
    <div v-else class="custom-models__list" aria-label="自定义模型列表" :aria-busy="loading">
      <div v-for="row in modelRows" :key="`${row.engine}:${row.info.id}`" class="custom-models__item" :class="{ 'is-disabled': !row.custom.enabled }">
        <div class="custom-models__item-main">
          <div class="custom-models__item-row">
            <span class="custom-models__item-title">{{ row.info.displayName }}</span>
            <span v-if="!row.custom.enabled" class="custom-models__tag is-muted">停用</span>
          </div>
          <div class="custom-models__item-row custom-models__meta">
            <span class="mono">{{ row.info.id }}</span>
          </div>
          <div class="custom-models__item-row custom-models__meta">
            <span class="custom-models__window" :title="`${getModelContextWindowBounds(row.engine, row.info).maxContextWindow.toLocaleString()} tokens`">上下文 {{ formatWindow(getModelContextWindowBounds(row.engine, row.info).maxContextWindow) }}</span>
            <span v-if="row.info.defaultReasoningEffort">思考 {{ row.info.defaultReasoningEffort }}</span>
          </div>
        </div>
        <div class="custom-models__actions">
          <a-button size="small" type="text" :disabled="operating || !canUseRoute" aria-label="编辑自定义模型" @click="openEditModal(row.custom)">
            <template #icon><EditOutlined /></template>
          </a-button>
          <a-popconfirm title="确认删除该自定义模型？" ok-text="删除" cancel-text="取消" @confirm="removeModel(row.custom.id)">
            <a-button size="small" type="text" danger :loading="deletingId === row.custom.id" :disabled="operating || !canUseRoute" aria-label="删除自定义模型">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-popconfirm>
        </div>
      </div>
    </div>

    <a-modal
      v-model:open="modalOpen"
      :title="editingId ? '编辑自定义模型' : '添加自定义模型'"
      :ok-text="editingId ? '更新' : '添加'"
      cancel-text="取消"
      :confirm-loading="submitting"
      :mask-closable="!submitting"
      :keyboard="!submitting"
      :closable="!submitting"
      :width="props.surface === 'h5' ? '100%' : 560"
      :wrap-class-name="props.surface === 'h5' ? 'h5-engine-key-modal' : undefined"
      @ok="submitModel"
      @cancel="closeModal"
    >
      <a-form layout="vertical" :colon="false" class="custom-models__form">
        <div class="custom-models__form-grid">
          <a-form-item label="引擎">
            <a-select v-model:value="form.engine" :options="engineOptions" :disabled="!!editingId || !!props.engineScope" />
          </a-form-item>
          <a-form-item label="供应商">
            <a-select v-model:value="form.providerId" :options="providerOptions" :disabled="!!props.providerScope" />
          </a-form-item>
        </div>
        <a-form-item label="模型 ID">
          <a-input v-model:value="form.modelId" :disabled="!!editingId" placeholder="例如：moonshot-k2-0711、provider/custom-model" />
        </a-form-item>
        <a-form-item label="展示名称">
          <a-input v-model:value="form.displayName" placeholder="留空时使用模型 ID" />
        </a-form-item>
        <a-form-item label="模型最大容量（tokens）" help="声明供应商支持的最大上下文容量，会话自动使用此容量。">
          <a-input-number v-model:value="form.maxContextWindow" :min="1" :precision="0" style="width: 100%" placeholder="可选，未填写使用 200,000" />
        </a-form-item>
        <a-form-item label="输入模态">
          <a-checkbox-group v-model:value="form.inputModalities">
            <a-checkbox value="text">text</a-checkbox>
            <a-checkbox value="image">image</a-checkbox>
          </a-checkbox-group>
        </a-form-item>
        <a-form-item label="支持的思考强度">
          <a-select
            v-model:value="form.supportedReasoningEfforts"
            mode="multiple"
            :options="reasoningEffortOptions"
            placeholder="不选择则运行时不发送 effort"
          />
        </a-form-item>
        <a-form-item label="默认思考强度">
          <a-select
            v-model:value="form.defaultReasoningEffort"
            :options="defaultEffortOptions"
            :disabled="!form.supportedReasoningEfforts.length"
          />
        </a-form-item>
        <div class="custom-models__switches">
          <a-switch v-model:checked="form.enabled" />
          <span>启用</span>
          <a-switch v-if="form.engine === 'codex'" v-model:checked="form.supportsFastMode" />
          <span v-if="form.engine === 'codex'">Codex Fast</span>
        </div>
      </a-form>
    </a-modal>
  </section>
</template>

<style scoped>
.custom-models {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--app-border);
  border-radius: 16px;
  background: var(--app-panel-bg);
  padding: 20px;
  min-width: 0;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
}

.custom-models__notice {
  align-self: flex-start;
  width: fit-content;
  max-width: min(100%, 560px);
  padding: 8px 12px;
}

.custom-models__notice :deep(.ant-alert-message) {
  line-height: 1.5;
}

.custom-models__header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.custom-models__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text);
}

.custom-models__subtitle {
  font-size: 12px;
  color: var(--app-muted);
  margin-top: 2px;
}

.custom-models__empty {
  color: var(--app-muted);
  font-size: 12px;
  padding: 32px 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  line-height: 1.8;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
}
.custom-models__empty-icon { font-size: 28px; color: var(--app-border); margin-bottom: 8px; }
.custom-models__empty strong { color: var(--app-muted); font-size: 13px; font-weight: 500; }

.custom-models__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.custom-models__count { margin-left: 6px; color: var(--app-muted); font-size: 12px; font-weight: 400; }
.custom-models__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 18px 0;
  border-bottom: 1px solid var(--app-border);
}
.custom-models__item:last-child { border-bottom: 0; }
.custom-models__window { font-variant-numeric: tabular-nums; }

.custom-models__item.is-disabled {
  opacity: 0.65;
}

.custom-models__item-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  flex: 1 1 0;
}

.custom-models__item-row {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.custom-models__item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.custom-models__meta {
  color: var(--app-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.custom-models__tag {
  border: 1px solid var(--app-border);
  border-radius: 4px;
  color: var(--app-muted);
  font-size: 11px;
  line-height: 1.7;
  padding: 0 6px;
}

.custom-models__tag.is-muted {
  opacity: 0.8;
}

.custom-models__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.custom-models__form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.custom-models__form :deep(.ant-form-item) {
  margin-bottom: 14px;
}

.custom-models__switches {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 767px) {
  .custom-models__notice {
    width: 100%;
    max-width: 100%;
  }

  .custom-models__header {
    flex-direction: column;
    align-items: stretch;
  }

  .custom-models__actions {
    flex-wrap: wrap;
  }

  .custom-models__form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
