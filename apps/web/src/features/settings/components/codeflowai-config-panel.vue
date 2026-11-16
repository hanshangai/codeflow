<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { DownOutlined, UpOutlined } from "@ant-design/icons-vue";
import {
  WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS,
  type CodeflowaiConfig,
  type WorkspaceId,
  type WorkspacePathIndexExclusionGroup,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { getCodeflowaiConfig, setCodeflowaiConfig } from "../../../api/codeflowai";
import { isCancelledRequestError } from "../../../api/request";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "CodeflowaiConfigPanel" });

const DEFAULT_FILE_INDEX_MAX_ENTRIES = 300_000;

type Props = {
  workspaceId: WorkspaceId;
  active?: boolean;
};
const props = withDefaults(defineProps<Props>(), {
  active: true,
});

const configStore = useConfigStore();
const workspacesStore = useWorkspacesStore();
const { ctx } = useApiContext();

const loading = ref(false);
const saving = ref(false);
const defaultExclusionsExpanded = ref(false);
const filePath = ref<string>("");
const CONFIG_LOAD_ERROR_MESSAGE_KEY = "codeflowai-config-load-error";
const CONFIG_UNAVAILABLE_MESSAGE = "基础配置需要连接 Server 或选择本机工作区后再维护";
/** 桌面本机工作区未登录也可读写 codeflowai.json；共享与其他 Client 仍走 Server 门禁。 */
const canAccessConfig = computed(() => configStore.connected || isDesktopWorkspace(configStore, props.workspaceId));
const isSharedWorkspace = computed(() => isSharedWorkspaceSelectionId(props.workspaceId));
const currentWorkspace = computed(() => workspacesStore.byId.get(props.workspaceId) ?? null);
const canMaintainSharedHostConfig = computed(() =>
  Boolean(
    isSharedWorkspace.value
    && currentWorkspace.value?.shared?.isHostOwner === true
    && currentWorkspace.value?.capabilities?.canMaintainAssets === true,
  ),
);
const canEditConfig = computed(() => !isSharedWorkspace.value || canMaintainSharedHostConfig.value);
const sharedConfigDescription = computed(() =>
  canMaintainSharedHostConfig.value
    ? "当前账号是该共享工作区的 Host，可通过统一共享工作区路由读取和维护 Host 本机 codeflowai.json。"
    : "这里不会读取或写入成员本机的 codeflowai.json。",
);

const form = reactive({
  workflowDocsRoot: "codeflow-docs",
  fileIndexMaxEntries: DEFAULT_FILE_INDEX_MAX_ENTRIES as number | null,
});
const loadedConfig = ref<CodeflowaiConfig>({});
const defaultExclusionRuleCount = computed(() => WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS.reduce(
  (count, group) => count + exclusionEntries(group).length,
  0,
));
const defaultExclusionPreview = computed(() => WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS
  .flatMap((group) => exclusionEntries(group).slice(0, 2))
  .slice(0, 6));

/** 合并一个默认排除分类下的全部匹配值，仅用于只读展示。 */
function exclusionEntries(group: WorkspacePathIndexExclusionGroup): string[] {
  return [
    ...(group.directoryNames ?? []),
    ...(group.rootDirectoryNames ?? []),
    ...(group.paths ?? []),
    ...(group.pathPrefixes ?? []),
  ];
}

/** 从表单构造 CodeFlowAI 配置（用于写入 codeflowai.json）。 */
function buildConfigFromForm(): CodeflowaiConfig {
  const workflowDocsRoot = String(form.workflowDocsRoot ?? "").trim();
  if (!workflowDocsRoot) throw new Error("参数错误：工作区文档目录不能为空");

  const maxEntries = normalizeFileIndexMaxEntriesInput(form.fileIndexMaxEntries);

  const next: CodeflowaiConfig & { execution?: unknown } = {
    ...loadedConfig.value,
    paths: { workflowDocsRoot },
    fileIndex: { ...(loadedConfig.value.fileIndex ?? {}), maxEntries },
  };
  // 已废弃的执行偏好不参与运行时，保存时一并清除旧文件残留。
  delete next.execution;
  return next;
}

/** 加载 codeflowai.json 配置并映射到可视化表单。 */
async function load(): Promise<void> {
  if (!props.active) return;
  if (!canAccessConfig.value) return;
  if (!canEditConfig.value) {
    filePath.value = "";
    return;
  }
  loading.value = true;
  try {
    const res = await getCodeflowaiConfig(ctx.value, props.workspaceId);
    if (!res.ok) throw new Error(res.message);
    filePath.value = res.path;
    const cfg = (res.config ?? {}) as CodeflowaiConfig;
    loadedConfig.value = cfg;
    form.workflowDocsRoot = String(cfg.paths?.workflowDocsRoot ?? "codeflow-docs").trim() || "codeflow-docs";
    form.fileIndexMaxEntries = normalizeFileIndexMaxEntriesInput(cfg.fileIndex?.maxEntries ?? null);
  } catch (e) {
    message.error({
      content: e instanceof Error ? e.message : String(e),
      key: CONFIG_LOAD_ERROR_MESSAGE_KEY,
      duration: 3,
    });
  } finally {
    loading.value = false;
  }
}

/** 保存表单配置到 codeflowai.json（由 Client 归一化写入）。 */
async function save(): Promise<void> {
  if (!canAccessConfig.value) return;
  if (!canEditConfig.value) {
    message.info("共享工作区基础配置由 Host 工作区维护，成员入口不写入本地配置");
    return;
  }
  try {
    const next = buildConfigFromForm();
    saving.value = true;
    const res = await setCodeflowaiConfig(ctx.value, { workspaceId: props.workspaceId, config: next });
    if (!res.ok) throw new Error(res.message);
    filePath.value = res.path;
    message.success("已保存");
    trackProductEvent("settings_save_success", { settings_panel: "codeflowai_config", settings_action: "save", source: "settings" });
  } catch (e) {
    if (isCancelledRequestError(e)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "codeflowai_config", settings_action: "save", source: "settings", error_code_group: "request_error" });
    message.error(e instanceof Error ? e.message : String(e));
    return;
  } finally {
    saving.value = false;
  }
  await load();
}

/** 归一化文件索引上限表单值；空值直接使用内置默认值。 */
function normalizeFileIndexMaxEntriesInput(value: unknown): number {
  if (value == null || value === "") return DEFAULT_FILE_INDEX_MAX_ENTRIES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("参数错误：最大索引路径数必须是正整数");
  const normalized = Math.floor(parsed);
  if (normalized < 1000 || normalized > 500000) throw new Error("参数错误：最大索引路径数必须在 1000 到 500000 之间");
  return normalized;
}

watch(
  () => [props.active, props.workspaceId, canAccessConfig.value, canEditConfig.value] as const,
  ([active, workspaceId, accessible, canEdit], previous) => {
    const [prevActive, prevWorkspaceId, prevAccessible, prevCanEdit] = previous ?? [undefined, undefined, undefined, undefined];
    if (!active || !workspaceId || !accessible) return;
    if (prevActive === active && prevWorkspaceId === workspaceId && prevAccessible === accessible && prevCanEdit === canEdit) return;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <div class="codeflowai-cfg">
    <a-alert
      v-if="!canAccessConfig"
      class="codeflowai-cfg__notice"
      type="info"
      show-icon
      :message="CONFIG_UNAVAILABLE_MESSAGE"
    />
    <a-alert
      v-else-if="isSharedWorkspace"
      class="codeflowai-cfg__notice"
      :type="canMaintainSharedHostConfig ? 'success' : 'info'"
      show-icon
      :message="canMaintainSharedHostConfig ? '正在维护共享工作区 Host 配置' : '共享工作区的基础配置由 Host 管理员维护'"
      :description="sharedConfigDescription"
    />
      <a-form layout="vertical" :colon="false" class="codeflowai-cfg__form" :disabled="!canAccessConfig || !canEditConfig">
        <div class="codeflowai-cfg__group">
          <a-form-item label="工作区文档目录">
            <a-input v-model:value="form.workflowDocsRoot" placeholder="codeflow-docs" />
            <div class="codeflowai-cfg__hint">
              工作区文档和规格库共用此目录。修改后先迁移已有文档，成功后才保存配置；工作区有运行或排队任务时暂不允许改名，目标目录须不存在。
            </div>
          </a-form-item>
        </div>

        <div class="codeflowai-cfg__group">
          <div class="codeflowai-cfg__group-title">工作区文件索引</div>
          <div class="codeflowai-cfg__file-index-layout">
            <a-form-item label="最大索引路径数">
              <a-input-number
                v-model:value="form.fileIndexMaxEntries"
                :min="1000"
                :max="500000"
                :step="10000"
                :precision="0"
                style="width: 240px"
              />
              <div class="codeflowai-cfg__hint">
                默认值为 300000；保存后会在下次搜索或索引重建时生效。
              </div>
            </a-form-item>
            <div class="codeflowai-cfg__default-exclusions">
              <div class="codeflowai-cfg__default-exclusions-heading">
                <div>
                  <strong>默认排除规则</strong>
                  <span>系统内置 · {{ defaultExclusionRuleCount }} 项</span>
                </div>
                <a-button type="link" size="small" @click="defaultExclusionsExpanded = !defaultExclusionsExpanded">
                  {{ defaultExclusionsExpanded ? "收起" : "查看全部" }}
                  <template #icon><UpOutlined v-if="defaultExclusionsExpanded" /><DownOutlined v-else /></template>
                </a-button>
              </div>
              <div class="codeflowai-cfg__rule-tokens">
                <code v-for="rule in defaultExclusionPreview" :key="rule">{{ rule }}</code>
                <span v-if="defaultExclusionRuleCount > defaultExclusionPreview.length">等 {{ defaultExclusionRuleCount }} 项</span>
              </div>
              <div class="codeflowai-cfg__custom-exclusion-path">
                <span>工作区自定义排除</span>
                <code>./codeflowai/file-index-ignore.txt</code>
              </div>
            </div>
          </div>
          <div v-if="defaultExclusionsExpanded" class="codeflowai-cfg__exclusion-groups">
            <div v-for="group in WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS" :key="group.key" class="codeflowai-cfg__exclusion-group">
              <strong>{{ group.label }}</strong>
              <div class="codeflowai-cfg__rule-tokens">
                <code v-for="rule in exclusionEntries(group)" :key="rule">{{ rule }}</code>
              </div>
            </div>
          </div>
        </div>
      </a-form>

    <div class="codeflowai-cfg__actions">
      <span v-if="filePath" class="codeflowai-cfg__path">保存路径：<span class="mono">{{ filePath }}</span></span>
      <span v-else class="codeflowai-cfg__path">{{ isSharedWorkspace && !canMaintainSharedHostConfig ? "保存路径：共享工作区不在成员本机写入基础配置" : "保存路径：加载配置后显示" }}</span>
      <div class="codeflowai-cfg__action-buttons">
        <a-button :disabled="!canAccessConfig || !canEditConfig" :loading="loading" @click="load">刷新</a-button>
        <a-button type="primary" :disabled="!canAccessConfig || !canEditConfig" :loading="saving" @click="save">保存</a-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.codeflowai-cfg {
  display: grid;
  gap: 8px;
  height: 100%;
  min-height: 100%;
  align-content: start;
}

.codeflowai-cfg__notice {
  justify-self: stretch;
  width: 100%;
  padding: 8px 12px;
}

.codeflowai-cfg__notice :deep(.ant-alert-message),
.codeflowai-cfg__notice :deep(.ant-alert-description) {
  line-height: 1.5;
}

.codeflowai-cfg__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 2px 0 4px;
}

.codeflowai-cfg__action-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.codeflowai-cfg__path {
  font-size: 12px;
  color: var(--app-muted);
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
}

.codeflowai-cfg__path .mono {
  white-space: inherit;
}

.codeflowai-cfg__form {
  display: grid;
  gap: 0;
}

.codeflowai-cfg__group {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 10px 14px 0;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.012);
}

.codeflowai-cfg__group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-muted);
  letter-spacing: 0.3px;
  margin-bottom: 4px;
  text-transform: uppercase;
}

.codeflowai-cfg__hint {
  font-size: 12px;
  color: var(--app-muted);
  margin-top: 4px;
  line-height: 1.5;
}

.codeflowai-cfg__form :deep(.ant-form-item) {
  margin-bottom: 12px;
}

.codeflowai-cfg__form :deep(.ant-form-item-label) {
  padding-bottom: 4px;
}

.codeflowai-cfg__file-index-layout {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.4fr);
  gap: 24px;
}

.codeflowai-cfg__default-exclusions {
  min-width: 0;
  padding-left: 24px;
  border-left: 1px solid var(--app-border);
}

.codeflowai-cfg__default-exclusions-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.codeflowai-cfg__default-exclusions-heading > div {
  display: grid;
  gap: 3px;
}

.codeflowai-cfg__default-exclusions-heading strong,
.codeflowai-cfg__exclusion-group > strong {
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
}

.codeflowai-cfg__default-exclusions-heading span {
  color: var(--app-muted);
  font-size: 12px;
}

.codeflowai-cfg__rule-tokens {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.codeflowai-cfg__rule-tokens code {
  padding: 2px 6px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  font-family: var(--app-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  line-height: 1.5;
}

.codeflowai-cfg__rule-tokens > span {
  color: var(--app-muted);
  font-size: 12px;
}

.codeflowai-cfg__custom-exclusion-path {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 5px 8px;
  margin-top: 10px;
  color: var(--app-muted);
  font-size: 12px;
}

.codeflowai-cfg__custom-exclusion-path code {
  color: var(--app-text);
  font-family: var(--app-mono-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.codeflowai-cfg__exclusion-groups {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
  padding: 14px 0 12px;
  border-top: 1px solid var(--app-border);
}

.codeflowai-cfg__exclusion-group {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}

/* ── Dark mode ── */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .codeflowai-cfg__group {
    background: rgba(255, 255, 255, 0.02);
    border-color: rgba(255, 255, 255, 0.08);
  }
}

:root[data-theme="dark"] .codeflowai-cfg__group {
  background: rgba(255, 255, 255, 0.02);
  border-color: rgba(255, 255, 255, 0.08);
}

@media (max-width: 640px) {
  .codeflowai-cfg__actions {
    align-items: stretch;
  }

  .codeflowai-cfg__action-buttons {
    width: 100%;
  }

  .codeflowai-cfg__file-index-layout,
  .codeflowai-cfg__exclusion-groups {
    grid-template-columns: 1fr;
  }

  .codeflowai-cfg__notice {
    width: 100%;
    max-width: 100%;
  }

  .codeflowai-cfg__default-exclusions {
    padding-top: 12px;
    padding-left: 0;
    border-top: 1px solid var(--app-border);
    border-left: 0;
  }
}
</style>


