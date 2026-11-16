<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { message } from "ant-design-vue";
import {
  CheckOutlined,
  DeploymentUnitOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons-vue";
import {
  getDefaultReasoningEffortForModel,
  resolveThreadPrefsWithCatalogDefaults,
  type EngineType,
  type RoleDefinition,
  type RoleId,
  type ThreadId,
  type ThreadPrefs,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";
import { isDesktopWorkspace } from "../../../services/desktop";

defineOptions({ name: "H5ThreadPreferencesPanel" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  engine: EngineType;
}>();

const { ctx } = useApiContext();
const chat = useChatStore();
const config = useConfigStore();
const engines = useEngineStore();
const orchestration = useOrchestrationStore();
const loading = ref(false);
const savingField = ref<"agent" | "model" | "effort" | "plan" | null>(null);
const loadError = ref("");
const saveError = ref("");

const threadPrefs = computed(() => chat.threadPrefsByThreadId[String(props.threadId)] ?? {});
const engineStatus = computed(() => engines.byTypeForWorkspace(props.workspaceId).get(props.engine) ?? null);
const workspaceEngineState = computed(() => engines.byWorkspaceId[String(props.workspaceId)] ?? null);
const models = computed(() => engineStatus.value?.models ?? []);
const catalogReady = computed(() => (
  workspaceEngineState.value?.catalogVersion != null
  && engineStatus.value != null
  && models.value.length > 0
));
const effectivePrefs = computed(() => catalogReady.value
  ? resolveThreadPrefsWithCatalogDefaults(props.engine, threadPrefs.value, models.value)
  : null);
const selectedModel = computed(() => String(effectivePrefs.value?.model ?? threadPrefs.value.model ?? ""));
const selectedModelInfo = computed(() => models.value.find((item) => item.id === selectedModel.value) ?? null);
const selectedModelRemoved = computed(() => Boolean(
  catalogReady.value && selectedModel.value && !selectedModelInfo.value,
));
const effortOptions = computed(() => selectedModelInfo.value?.supportedReasoningEfforts ?? []);
const selectedEffort = computed(() => String(effectivePrefs.value?.effort ?? threadPrefs.value.effort ?? ""));
const selectedRoleId = computed(() => String(threadPrefs.value.roleId ?? ""));
const roleOptions = computed(() => (
  orchestration.roles as Array<RoleDefinition & { availability?: { available?: boolean; message?: string | null } }>
).filter((role) => role.availability?.available !== false));
const planMode = computed(() => Boolean(effectivePrefs.value?.planMode ?? threadPrefs.value.planMode));

/** 加载模型目录和目标 Client 的 Agent，任一失败都在页面内显式呈现。 */
async function loadOptions(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    await Promise.all([
      engines.refresh(ctx.value, props.workspaceId),
      orchestration.refreshRoles(ctx.value, props.workspaceId, "execution"),
    ]);
    if (engines.lastError) throw new Error(engines.lastError);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
    message.error(`会话设置加载失败：${loadError.value}`);
  } finally {
    loading.value = false;
  }
}

/** 合并会话偏好并立即持久化，避免离开子页时丢失最后一次调整。 */
async function savePreference(field: "agent" | "model" | "effort" | "plan", patch: ThreadPrefs): Promise<void> {
  if (savingField.value) return;
  if ((field === "model" || field === "effort") && !catalogReady.value) {
    saveError.value = "模型目录尚未加载完成，请刷新后重试";
    message.error(saveError.value);
    return;
  }
  savingField.value = field;
  saveError.value = "";
  chat.patchThreadPrefs(props.threadId, patch, props.workspaceId, { apiContext: ctx.value });
  try {
    await chat.saveThreadPrefs(ctx.value, props.workspaceId, props.threadId);
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
    message.error(`会话设置保存失败：${saveError.value}`);
  } finally {
    savingField.value = null;
  }
}

/** 切换模型时同步最大窗口、默认推理强度和 Fast 档位。 */
function changeModel(value: string): void {
  const model = String(value ?? "").trim() || null;
  const { contextWindow, serviceTier } = resolveThreadPrefsWithCatalogDefaults(props.engine, { model }, models.value);
  void savePreference("model", {
    model,
    effort: getDefaultReasoningEffortForModel(props.engine, model, models.value),
    contextWindow: contextWindow > 0 ? contextWindow : null,
    serviceTier,
  });
}

/** 更新当前模型允许的推理强度。 */
function changeEffort(value: string): void {
  void savePreference("effort", { effort: String(value ?? "").trim() || null });
}

/** 更新普通会话绑定的 Agent；空值表示恢复无 Agent。 */
function changeAgent(value: string | undefined): void {
  const roleId = String(value ?? "").trim();
  void savePreference("agent", { roleId: roleId ? roleId as RoleId : null });
}

/** 更新计划模式，并用 null 表示产品默认关闭态。 */
function changePlanMode(enabled: boolean): void {
  void savePreference("plan", { planMode: enabled ? true : null });
}

/** Agent 下拉按名称、描述和 ID 搜索。 */
function filterRoleOption(input: string, option: unknown): boolean {
  const keyword = String(input ?? "").trim().toLowerCase();
  if (!keyword) return true;
  const item = option as { label?: string; value?: string; title?: string };
  return [item.label, item.value, item.title]
    .some((value) => String(value ?? "").toLowerCase().includes(keyword));
}

onMounted(() => {
  if (!config.connected && !isDesktopWorkspace(config, config.workspaceId)) {
    loadError.value = "当前工作区不可用，暂时无法刷新模型和 Agent 列表";
    return;
  }
  void loadOptions();
});
</script>

<template>
  <section class="h5-thread-prefs" aria-label="会话设置">
    <div class="h5-thread-prefs__summary">
      <span class="h5-thread-prefs__summary-icon"><DeploymentUnitOutlined /></span>
      <span><small>{{ engine === 'claude' ? 'Claude' : 'Codex' }} 会话</small><strong>{{ selectedModelInfo?.displayName || (selectedModelRemoved ? `${selectedModel}（已移除）` : selectedModel) || (catalogReady ? '请选择模型' : '模型目录加载中') }}</strong></span>
      <span v-if="savingField" class="h5-thread-prefs__state">保存中</span>
      <span v-else-if="saveError" class="h5-thread-prefs__state error">同步失败</span>
      <span v-else-if="selectedModelRemoved" class="h5-thread-prefs__state error">需重新选择</span>
      <span v-else class="h5-thread-prefs__state saved"><CheckOutlined /> 已同步</span>
    </div>

    <a-alert v-if="loadError" type="error" :message="loadError" show-icon>
      <template #action><a-button size="small" :loading="loading" @click="loadOptions">重试</a-button></template>
    </a-alert>
    <a-alert v-if="saveError" type="error" :message="saveError" show-icon />
    <a-alert
      v-if="selectedModelRemoved"
      type="error"
      :message="`当前模型 ${selectedModel} 已从模型目录移除，请重新选择模型`"
      show-icon
    />

    <div class="h5-thread-prefs__group">
      <span class="h5-thread-prefs__group-title">运行配置</span>
      <label class="h5-thread-prefs__row">
        <span class="h5-thread-prefs__row-icon agent"><RobotOutlined /></span>
        <span class="h5-thread-prefs__copy"><strong>Agent</strong><small>当前会话角色</small></span>
        <a-select
          :value="selectedRoleId || undefined"
          :loading="loading || orchestration.rolesLoading"
          :disabled="Boolean(savingField)"
          :filter-option="filterRoleOption"
          allow-clear
          show-search
          placeholder="不使用 Agent"
          popup-class-name="h5-thread-prefs__dropdown"
          @update:value="changeAgent"
        >
          <a-select-option v-for="role in roleOptions" :key="String(role.id)" :value="String(role.id)" :label="role.name" :title="role.description">
            {{ role.name || role.id }}
          </a-select-option>
        </a-select>
      </label>

      <label class="h5-thread-prefs__row">
        <span class="h5-thread-prefs__row-icon model"><DeploymentUnitOutlined /></span>
        <span class="h5-thread-prefs__copy"><strong>模型</strong><small>生成与理解能力</small></span>
        <a-select
          :value="selectedModel || undefined"
          :loading="loading"
          :disabled="Boolean(savingField) || !catalogReady || models.length === 0"
          show-search
          option-filter-prop="label"
          placeholder="选择模型"
          popup-class-name="h5-thread-prefs__dropdown"
          @update:value="changeModel"
        >
          <a-select-option v-for="item in models" :key="item.id" :value="item.id" :label="item.displayName || item.id">
            {{ item.displayName || item.id }}<small v-if="item.isDefault"> 默认</small>
          </a-select-option>
        </a-select>
      </label>

      <label class="h5-thread-prefs__row">
        <span class="h5-thread-prefs__row-icon effort"><ThunderboltOutlined /></span>
        <span class="h5-thread-prefs__copy"><strong>推理强度</strong><small>当前模型档位</small></span>
        <a-select
          :value="selectedEffort || undefined"
          :disabled="Boolean(savingField) || !catalogReady || effortOptions.length === 0"
          placeholder="模型默认"
          popup-class-name="h5-thread-prefs__dropdown"
          @update:value="changeEffort"
        >
          <a-select-option v-for="item in effortOptions" :key="item.reasoningEffort" :value="item.reasoningEffort">
            {{ item.reasoningEffort }}
          </a-select-option>
        </a-select>
      </label>

      <div class="h5-thread-prefs__row">
        <span class="h5-thread-prefs__row-icon plan"><CheckOutlined /></span>
        <span class="h5-thread-prefs__copy"><strong>计划模式</strong><small>{{ planMode ? '已开启' : '已关闭' }}</small></span>
        <a-switch :checked="planMode" :loading="savingField === 'plan'" :disabled="Boolean(savingField)" aria-label="计划模式" @change="changePlanMode" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.h5-thread-prefs { height: 100%; min-height: 0; overflow-y: auto; padding: 14px 12px 28px; color: var(--app-text); background: color-mix(in srgb, var(--app-bg) 94%, var(--app-surface)); }
.h5-thread-prefs__summary { min-height: 78px; display: grid; grid-template-columns: 46px minmax(0, 1fr) auto; align-items: center; gap: 11px; margin-bottom: 14px; padding: 12px; border: 1px solid color-mix(in srgb, var(--app-accent) 18%, var(--app-border)); border-radius: 18px; background: color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-accent) 8%); box-shadow: 0 10px 24px rgba(20, 20, 19, 0.06); }
.h5-thread-prefs__summary-icon { width: 46px; height: 46px; display: grid; place-items: center; border-radius: 15px; color: #fff; background: #258466; font-size: 21px; }
.h5-thread-prefs__summary small, .h5-thread-prefs__summary strong { display: block; }
.h5-thread-prefs__summary small { color: var(--app-muted); font-size: 11px; }
.h5-thread-prefs__summary strong { margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
.h5-thread-prefs__state { color: var(--app-muted); font-size: 11px; white-space: nowrap; }
.h5-thread-prefs__state.saved { color: #258466; }
.h5-thread-prefs__state.error { color: var(--app-danger); }
.h5-thread-prefs :deep(.ant-alert) { margin-bottom: 12px; border-radius: 14px; }
.h5-thread-prefs__group { overflow: hidden; border: 1px solid var(--app-border); border-radius: 18px; background: var(--app-panel-bg); box-shadow: 0 10px 24px rgba(20, 20, 19, 0.045); }
.h5-thread-prefs__group-title { display: block; padding: 12px 14px 7px; color: var(--app-muted); font-size: 12px; font-weight: 650; }
.h5-thread-prefs__row { min-height: 70px; display: grid; grid-template-columns: 38px minmax(78px, 1fr) minmax(112px, 42%); align-items: center; gap: 10px; margin: 0 12px; border-bottom: 1px solid var(--app-divider); }
.h5-thread-prefs__row:last-child { border-bottom: 0; }
.h5-thread-prefs__row-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; color: #fff; font-size: 17px; }
.h5-thread-prefs__row-icon.agent { background: #258466; }
.h5-thread-prefs__row-icon.model { background: #3977c6; }
.h5-thread-prefs__row-icon.effort { background: #a66b1f; }
.h5-thread-prefs__row-icon.plan { background: #6864ad; }
.h5-thread-prefs__copy { min-width: 0; }
.h5-thread-prefs__copy strong, .h5-thread-prefs__copy small { display: block; }
.h5-thread-prefs__copy strong { font-size: 14px; }
.h5-thread-prefs__copy small { margin-top: 2px; color: var(--app-muted); font-size: 11px; }
.h5-thread-prefs__row :deep(.ant-select) { width: 100%; min-width: 0; }
.h5-thread-prefs__row :deep(.ant-select-selector) { min-height: 44px !important; align-items: center; border-radius: 13px !important; background: color-mix(in srgb, var(--app-bg) 72%, var(--app-panel-bg)) !important; }
.h5-thread-prefs__row :deep(.ant-switch) { justify-self: end; min-width: 50px; min-height: 28px; }
@media (max-width: 350px) {
  .h5-thread-prefs__row { grid-template-columns: 34px minmax(68px, 1fr) minmax(100px, 40%); gap: 7px; margin: 0 9px; }
  .h5-thread-prefs__row-icon { width: 34px; height: 34px; }
  .h5-thread-prefs__copy strong { font-size: 13px; }
}
</style>
