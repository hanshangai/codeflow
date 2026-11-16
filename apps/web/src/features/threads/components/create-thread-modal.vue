<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type { EngineType, ThreadGroupId } from "@codeflowai/shared";

defineOptions({ name: "CreateThreadModal" });

const UNGROUPED_GROUP_VALUE = "__ungrouped";

type ThreadGroupOption = {
  label: string;
  value: string;
};

type Props = {
  open: boolean;
  creating: boolean;
  defaultEngine?: EngineType;
  defaultGroupId?: ThreadGroupId | null;
  groupOptions?: ThreadGroupOption[];
  showGroupSelect?: boolean;
  modalTitle?: string;
  titleLabel?: string;
  titlePlaceholder?: string;
  disabledEngines?: Partial<Record<EngineType, string>>;
  surface?: "default" | "h5";
};

const props = withDefaults(defineProps<Props>(), {
  surface: "default",
});
const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  (e: "confirm", payload: { engine: EngineType; title: string; groupId?: ThreadGroupId | null }): void;
}>();

const ENGINE_CREATE_ORDER: EngineType[] = ["codex", "claude"];

const engine = ref<EngineType>("codex");
const title = ref("");
const selectedGroupValue = ref<string>(UNGROUPED_GROUP_VALUE);
const groupTouched = ref(false);
const selectedEngineDisabledReason = computed(() => getEngineDisabledReason(engine.value));
const groupSelectOptions = computed<ThreadGroupOption[]>(() => {
  return props.groupOptions?.length ? props.groupOptions : [{ label: "未分组", value: UNGROUPED_GROUP_VALUE }];
});

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    engine.value = resolveInitialEngine(props.defaultEngine ?? "codex");
    selectedGroupValue.value = resolveInitialGroupValue(props.defaultGroupId ?? null);
    groupTouched.value = false;
    title.value = "";
  },
);

watch(
  () => [props.defaultEngine, props.disabledEngines] as const,
  () => {
    if (!props.open || !selectedEngineDisabledReason.value) return;
    engine.value = resolveInitialEngine(engine.value);
  },
  { deep: true },
);

watch(
  () => [props.defaultGroupId, props.groupOptions, props.showGroupSelect] as const,
  () => {
    if (!props.open || !props.showGroupSelect || groupTouched.value) return;
    selectedGroupValue.value = resolveInitialGroupValue(props.defaultGroupId ?? null);
  },
  { deep: true },
);

/** 校验标题后提交创建参数，保持不同入口可复用同一个弹框。 */
const onOk = () => {
  if (props.creating) return;
  const disabledReason = selectedEngineDisabledReason.value;
  if (disabledReason) {
    message.warning(disabledReason);
    return;
  }
  const trimmed = title.value.trim();
  if (!trimmed) {
    message.error(`请输入${props.titleLabel || "会话名称"}`);
    return;
  }
  const payload: { engine: EngineType; title: string; groupId?: ThreadGroupId | null } = { engine: engine.value, title: trimmed };
  if (props.showGroupSelect) payload.groupId = selectedGroupValue.value === UNGROUPED_GROUP_VALUE ? null : (selectedGroupValue.value as ThreadGroupId);
  emit("confirm", payload);
};
/** 创建中不允许关闭，避免失败后丢失用户已输入的标题和引擎选择。 */
const onCancel = () => {
  if (props.creating) return;
  emit("update:open", false);
};

/** 读取指定引擎禁用原因；空值表示可选。 */
function getEngineDisabledReason(value: EngineType): string | null {
  return props.disabledEngines?.[value] ?? null;
}

/** 弹框打开时优先选择可用引擎，避免默认值落在 disabled 项上。 */
function resolveInitialEngine(preferred: EngineType): EngineType {
  if (!getEngineDisabledReason(preferred)) return preferred;
  return ENGINE_CREATE_ORDER.find((item) => !getEngineDisabledReason(item)) ?? preferred;
}

/** 弹框打开时按调用方默认分组落位；选项异步加载时仍保留默认值。 */
function resolveInitialGroupValue(defaultGroupId: ThreadGroupId | null): string {
  const value = String(defaultGroupId ?? "").trim();
  if (value) return value;
  return UNGROUPED_GROUP_VALUE;
}

/** 标记用户已手动选择分组，避免后续异步刷新覆盖选择。 */
function markGroupTouched(): void {
  groupTouched.value = true;
}
</script>

<template>
  <a-modal
    :open="open"
    :title="modalTitle || '新建会话'"
    :wrap-class-name="props.surface === 'h5' ? 'create-thread-modal create-thread-modal--h5' : 'create-thread-modal'"
    :width="props.surface === 'h5' ? '100%' : undefined"
    :footer="props.surface === 'h5' ? null : undefined"
    :confirm-loading="creating"
    :closable="!creating"
    :keyboard="!creating"
    :mask-closable="false"
    :cancel-button-props="{ disabled: creating }"
    :ok-button-props="{ disabled: creating || Boolean(selectedEngineDisabledReason) }"
    ok-text="确定"
    cancel-text="取消"
    @ok="onOk"
    @cancel="onCancel"
  >
    <div v-if="props.surface === 'h5'" class="create-thread-modal__intro">选择运行引擎并为会话命名</div>
    <a-form layout="vertical" autocomplete="off" :class="{ 'create-thread-modal__form--h5': props.surface === 'h5' }">
      <div class="create-thread-modal__engine-field">
        <div class="create-thread-modal__engine-row">
          <span class="create-thread-modal__engine-label">模型引擎</span>
          <a-radio-group v-model:value="engine" aria-label="模型引擎">
            <a-radio value="codex" :disabled="Boolean(getEngineDisabledReason('codex'))">Codex</a-radio>
            <a-radio value="claude" :disabled="Boolean(getEngineDisabledReason('claude'))">Claude</a-radio>
          </a-radio-group>
        </div>
        <a-alert
          v-if="selectedEngineDisabledReason"
          type="warning"
          show-icon
          :message="selectedEngineDisabledReason"
        />
      </div>
      <a-form-item :label="titleLabel || '会话名称'">
        <a-input
          v-model:value="title"
          name="codeflow-thread-title"
          autocomplete="new-password"
          :placeholder="titlePlaceholder || '请输入会话名称'"
        />
      </a-form-item>
      <a-form-item v-if="showGroupSelect" label="会话分组">
        <a-select
          v-model:value="selectedGroupValue"
          :options="groupSelectOptions"
          :disabled="creating"
          placeholder="请选择分组"
          @change="markGroupTouched"
        />
      </a-form-item>
    </a-form>
    <div v-if="props.surface === 'h5'" class="create-thread-modal__actions">
      <button type="button" :disabled="creating" @click="onCancel">取消</button>
      <button type="button" class="primary" :disabled="creating || Boolean(selectedEngineDisabledReason)" @click="onOk">
        {{ creating ? "创建中" : "创建会话" }}
      </button>
    </div>
  </a-modal>
</template>

<style>
/* 引擎 label 与单选项同排展示，保持其余字段的纵向标签布局不变。 */
.create-thread-modal__engine-field {
  display: grid;
  gap: 8px;
  margin-bottom: 24px;
}

.create-thread-modal__engine-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 22px;
}

.create-thread-modal__engine-label {
  flex: 0 0 auto;
  color: var(--app-text);
  font-size: 14px;
}

.create-thread-modal__form--h5 .create-thread-modal__engine-field {
  margin-bottom: 16px;
}

.create-thread-modal--h5 {
  display: flex;
  align-items: flex-end;
  overflow: hidden;
}

.create-thread-modal--h5 .ant-modal {
  top: 0;
  width: 100% !important;
  max-width: 100%;
  margin: 0;
  padding: 0;
}

.create-thread-modal--h5 .ant-modal-content {
  max-height: min(72dvh, 620px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  border-radius: 24px 24px 0 0;
  background: color-mix(in srgb, var(--app-panel-bg) 96%, transparent);
  box-shadow: 0 -18px 48px rgba(20, 28, 26, 0.16);
  backdrop-filter: blur(28px) saturate(1.28);
}

.create-thread-modal--h5 .ant-modal-header {
  margin: 0;
  padding: 20px 20px 4px;
  background: transparent;
}

.create-thread-modal--h5 .ant-modal-title {
  font-size: 19px;
  font-weight: 720;
  letter-spacing: 0;
}

.create-thread-modal--h5 .ant-modal-close {
  top: 10px;
  right: 10px;
  width: 44px;
  height: 44px;
}

.create-thread-modal--h5 .ant-modal-body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px max(12px, min(env(safe-area-inset-bottom, 0px), 8px));
}

.create-thread-modal__intro {
  margin: 0 4px 14px;
  color: var(--app-muted);
  font-size: 12px;
}

.create-thread-modal__form--h5 .ant-form-item {
  margin-bottom: 16px;
}

.create-thread-modal__form--h5 .ant-form-item-label > label {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 650;
}

.create-thread-modal__form--h5 .ant-radio-group {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.create-thread-modal__form--h5 .ant-radio-wrapper {
  min-height: 48px;
  margin: 0;
  padding: 0 13px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary) 80%, var(--app-panel-bg));
}

.create-thread-modal__form--h5 .ant-input,
.create-thread-modal__form--h5 .ant-select-selector {
  min-height: 48px !important;
  border-radius: 14px !important;
}

.create-thread-modal__actions {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 10px;
  padding-top: 4px;
}

.create-thread-modal__actions button {
  min-height: 50px;
  border: 1px solid var(--app-border);
  border-radius: 15px;
  color: var(--app-text);
  background: var(--app-bg-secondary);
  font-size: 15px;
  font-weight: 680;
}

.create-thread-modal__actions button.primary {
  border-color: #16825d;
  color: #fff;
  background: #16825d;
}

.create-thread-modal__actions button:disabled {
  opacity: 0.5;
}
</style>

