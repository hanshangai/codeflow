<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { CopyOutlined, DeleteOutlined, FolderOpenOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { canMaintainBuiltinSpecAssets, type KnowledgeBundleDefinition, type KnowledgeBundleId, type KnowledgeSourceKind, type KnowledgeSourceRef, type WorkspaceId } from "@codeflowai/shared";

import { getCodeflowaiConfig } from "../../../api/codeflowai";
import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useOrchAssetDirtyState } from "../composables/useOrchAssetDirtyState";
import KnowledgeSourcePickerModal from "./knowledge-source-picker-modal.vue";

defineOptions({ name: "KnowledgeBundleForm" });

type EditableKnowledgeBundle = Omit<KnowledgeBundleDefinition, "createdAt" | "updatedAt">;
type PickerMode = "workspace-file" | "workspace-dir" | "workbench-doc" | "workbench-dir";

const props = defineProps<{
  workspaceId: WorkspaceId;
  bundleId: KnowledgeBundleId;
  sourceDefinition?: KnowledgeBundleDefinition | null;
  saveLabel?: string;
  /** 无工作区只读预览：强制只读，且不触发展示以外的任何请求。 */
  previewReadonly?: boolean;
}>();
const emit = defineEmits<{ (event: "dirty-change", dirty: boolean): void }>();

const orch = useOrchestrationStore();
const config = useConfigStore();
const { ctx } = useApiContext();

const form = ref<EditableKnowledgeBundle | null>(null);
const selectedSourceIndex = ref(0);
const workflowDocsRoot = ref("codeflow-docs");
const pathPickerOpen = ref(false);
const pathPickerMode = ref<PickerMode>("workspace-file");
const editorOpen = ref(false);
const { hasUnsavedChanges, isDirty, markCleanFromCurrentDraft } = useOrchAssetDirtyState(() => form.value);
watch(isDirty, (dirty) => emit("dirty-change", dirty), { immediate: true });
const modalBodyStyle = {
  maxHeight: "calc(100vh - 220px)",
  overflowY: "auto",
  paddingRight: "20px",
} as const;

const sourceKinds: Array<{ value: KnowledgeSourceKind; label: string; mode: "inline" | "runtime" }> = [
  { value: "manual-text", label: "在线正文", mode: "inline" },
  { value: "inline-doc", label: "在线文档", mode: "inline" },
  { value: "workspace-file", label: "项目文件", mode: "runtime" },
  { value: "workspace-dir", label: "项目目录", mode: "runtime" },
  { value: "workbench-doc", label: "工作台文档", mode: "runtime" },
  { value: "workbench-dir", label: "工作台目录", mode: "runtime" },
];

const quickAddKinds: KnowledgeSourceKind[] = [
  "manual-text",
  "workspace-file",
  "workspace-dir",
  "workbench-doc",
  "workbench-dir",
];

const selectedSource = computed(() => {
  if (!form.value?.sourceRefs.length) return null;
  return form.value.sourceRefs[selectedSourceIndex.value] ?? null;
});

const enabledSourceCount = computed(() =>
  form.value?.sourceRefs.filter((source) => source.enabled !== false).length ?? 0,
);
const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
/**
 * 只读红旗：预览态一律只读；服务端权威模式下的内置资产随服务端分发且只读；
 * 其余沿用既有内置资产口径。
 */
const isBuiltinReadonly = computed(() => props.previewReadonly === true
  || orch.isServerAuthoritativeBuiltinAsset("knowledge_bundle", String(props.bundleId ?? ""))
  || (form.value?.kind === "builtin" && !canMaintainBuiltinSpecAssets(permissionInput.value)));

watch(
  [() => props.bundleId, () => props.sourceDefinition],
  async ([bundleId, sourceDefinition]) => {
    const bundle = sourceDefinition ?? orch.knowledgeBundles.find((item) => item.id === bundleId);
    form.value = bundle ? cloneBundle(bundle) : null;
    markCleanFromCurrentDraft();
    selectedSourceIndex.value = 0;
    editorOpen.value = false;
    await loadWorkflowDocsRoot();
  },
  { immediate: true },
);

watch(
  () => form.value?.sourceRefs.length ?? 0,
  (length) => {
    if (length <= 0) {
      selectedSourceIndex.value = 0;
      editorOpen.value = false;
      return;
    }
    if (selectedSourceIndex.value >= length) selectedSourceIndex.value = length - 1;
  },
);

watch(
  () => ({
    sourceId: selectedSource.value?.id ?? "",
    kind: selectedSource.value?.kind ?? null,
  }),
  (next, prev) => {
    if (!selectedSource.value || !next.kind || !prev?.kind) return;
    if (!prev.sourceId || prev.sourceId !== next.sourceId || prev.kind === next.kind) return;
    normalizeSourceForKindChange(selectedSource.value, prev.kind, next.kind);
  },
);

async function loadWorkflowDocsRoot() {
  // 预览态没有工作区，直接使用默认根目录，不发请求。
  if (props.previewReadonly === true) {
    workflowDocsRoot.value = "codeflow-docs";
    return;
  }
  try {
    const res = await getCodeflowaiConfig(ctx.value, props.workspaceId);
    if (!res.ok) return;
    workflowDocsRoot.value = String(res.config?.paths?.workflowDocsRoot ?? "codeflow-docs").trim() || "codeflow-docs";
  } catch {
    workflowDocsRoot.value = "codeflow-docs";
  }
}

function addSource(kind: KnowledgeSourceKind = "manual-text") {
  if (!form.value) return;
  form.value.sourceRefs.push(createSource(kind));
  selectedSourceIndex.value = form.value.sourceRefs.length - 1;
  editorOpen.value = true;
}

function removeSource(index: number) {
  form.value?.sourceRefs.splice(index, 1);
  if (selectedSourceIndex.value > index) selectedSourceIndex.value -= 1;
  if (!(form.value?.sourceRefs.length ?? 0)) editorOpen.value = false;
}

function selectSource(index: number) {
  selectedSourceIndex.value = index;
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
}

function duplicateSelectedSource() {
  if (!form.value || !selectedSource.value) return;
  const source = selectedSource.value;
  const duplicated: KnowledgeSourceRef = {
    ...source,
    id: `source-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: String(source.title ?? "").trim() ? `${String(source.title).trim()}（副本）` : "新来源（副本）",
    description: source.description ?? null,
    ref: source.ref ?? null,
    inlineBody: source.inlineBody ?? null,
    enabled: source.enabled !== false,
  };
  form.value.sourceRefs.splice(selectedSourceIndex.value + 1, 0, duplicated);
  selectedSourceIndex.value += 1;
  editorOpen.value = true;
}

function supportsInlineBody(kind: KnowledgeSourceKind): kind is "manual-text" | "inline-doc" {
  return kind === "manual-text" || kind === "inline-doc";
}

function supportsPathPicker(kind: KnowledgeSourceKind): kind is PickerMode {
  return kind === "workspace-file"
    || kind === "workspace-dir"
    || kind === "workbench-doc"
    || kind === "workbench-dir";
}

function openPathPicker(kind: KnowledgeSourceKind) {
  if (!supportsPathPicker(kind)) return;
  pathPickerMode.value = kind;
  pathPickerOpen.value = true;
}

function onPathPicked(value: string) {
  if (!selectedSource.value) return;
  selectedSource.value.ref = value;
}

/** 保存知识库定义；非超管查看内置知识库时保持只读。 */
async function onSave(): Promise<boolean> {
  if (!form.value) return false;
  if (isBuiltinReadonly.value) {
    message.warning("内置知识库仅超管可修改");
    return false;
  }
  try {
    const normalized = normalizeBundleForSave(form.value);
    await orch.saveKnowledgeBundle(ctx.value, props.workspaceId, normalized);
    markCleanFromCurrentDraft();
    message.success("知识库已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
    return false;
  }
}

async function onSaveAndCloseEditor() {
  const saved = await onSave();
  if (saved) closeEditor();
}

/** 父级资产切换守卫调用的保存入口，失败时返回 false 阻止切换。 */
async function saveCurrentDraft(): Promise<boolean> {
  return onSave();
}

/** 放弃当前未保存知识库草稿，并恢复为 store 中最近保存态。 */
function discardUnsavedChanges(): void {
  const bundle = props.sourceDefinition ?? orch.knowledgeBundles.find((item) => item.id === props.bundleId);
  form.value = bundle ? cloneBundle(bundle) : null;
  selectedSourceIndex.value = 0;
  editorOpen.value = false;
  markCleanFromCurrentDraft();
}

defineExpose({
  hasUnsavedChanges,
  saveCurrentDraft,
  discardUnsavedChanges,
});

function normalizeBundleForSave(bundle: EditableKnowledgeBundle): EditableKnowledgeBundle {
  return {
    ...bundle,
    name: bundle.name.trim(),
    description: bundle.description.trim(),
    sourceRefs: bundle.sourceRefs.map((source) => normalizeSourceForSave(source)),
  };
}

function normalizeSourceForSave(source: KnowledgeSourceRef): KnowledgeSourceRef {
  const kind = source.kind;
  const refText = String(source.ref ?? "").trim();
  const inlineBody = String(source.inlineBody ?? "").replace(/\r\n/g, "\n").trim();
  const isDir = kind === "workspace-dir" || kind === "workbench-dir";
  return {
    ...source,
    title: String(source.title ?? "").trim(),
    description: String(source.description ?? "").trim() || null,
    enabled: source.enabled !== false,
    ref: supportsInlineBody(kind) ? null : (refText || (isDir ? "." : null)),
    inlineBody: supportsInlineBody(kind) ? (inlineBody || null) : null,
  };
}

function normalizeSourceForKindChange(source: KnowledgeSourceRef, prevKind: KnowledgeSourceKind, nextKind: KnowledgeSourceKind) {
  if (supportsInlineBody(nextKind)) {
    source.inlineBody = supportsInlineBody(prevKind) ? source.inlineBody ?? "" : "";
    source.ref = null;
    return;
  }
  source.inlineBody = null;
  if (supportsPathPicker(prevKind) && supportsPathPicker(nextKind)) {
    const switchedScope = isWorkbenchKind(prevKind) !== isWorkbenchKind(nextKind);
    if (switchedScope) {
      source.ref = nextKind === "workspace-dir" || nextKind === "workbench-dir" ? "." : "";
      return;
    }
    if ((prevKind.endsWith("dir") && nextKind.endsWith("file")) || (prevKind.endsWith("file") && nextKind.endsWith("dir"))) {
      source.ref = nextKind.endsWith("dir") ? "." : "";
    }
    return;
  }
  source.ref = nextKind === "workspace-dir" || nextKind === "workbench-dir" ? "." : "";
}

function isWorkbenchKind(kind: KnowledgeSourceKind): boolean {
  return kind === "workbench-doc" || kind === "workbench-dir";
}

function createSource(kind: KnowledgeSourceKind): KnowledgeSourceRef {
  const defaultTitle = sourceKinds.find((item) => item.value === kind)?.label ?? "新来源";
  const isInline = supportsInlineBody(kind);
  const isDir = kind === "workspace-dir" || kind === "workbench-dir";
  return {
    id: `source-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    title: defaultTitle,
    description: null,
    ref: isInline ? null : (isDir ? "." : ""),
    inlineBody: isInline ? "" : null,
    enabled: true,
  };
}

function cloneBundle(bundle: KnowledgeBundleDefinition): EditableKnowledgeBundle {
  return {
    id: bundle.id,
    workspaceId: bundle.workspaceId,
    name: bundle.name,
    scope: bundle.scope,
    description: bundle.description,
    kind: bundle.kind ?? null,
    sourceRefs: bundle.sourceRefs.map((item) => ({
      ...item,
      description: item.description ?? null,
      ref: item.ref ?? null,
      inlineBody: item.inlineBody ?? null,
      enabled: item.enabled !== false,
    })),
  };
}

function scopeLabel(scope: KnowledgeBundleDefinition["scope"]): string {
  if (scope === "workflow") return "流程默认";
  if (scope === "role") return "角色默认";
  return "全局共享";
}

function sourceKindLabel(kind: KnowledgeSourceKind): string {
  return sourceKinds.find((item) => item.value === kind)?.label ?? kind;
}

function sourceModeLabel(kind: KnowledgeSourceKind): string {
  return sourceKinds.find((item) => item.value === kind)?.mode === "inline" ? "直接附带" : "执行时读取";
}

function sourceTitle(source: KnowledgeSourceRef, index: number): string {
  return String(source.title ?? "").trim() || `来源 ${index + 1}`;
}

function sourceSummary(source: KnowledgeSourceRef): string {
  if (supportsInlineBody(source.kind)) {
    const inline = String(source.inlineBody ?? "").trim();
    if (!inline) return "还没有填写正文";
    return inline.length > 64 ? `${inline.slice(0, 64)}...` : inline;
  }
  const ref = String(source.ref ?? "").trim();
  if (!ref) return "还没有填写引用路径";
  return ref.length > 56 ? `${ref.slice(0, 56)}...` : ref;
}

function sourceBodyLabel(kind: KnowledgeSourceKind): string {
  return kind === "inline-doc" ? "文档正文" : "正文内容";
}

function sourceBodyPlaceholder(kind: KnowledgeSourceKind): string {
  if (kind === "inline-doc") {
    return "直接维护一篇在线文档的正文。适合比较长但仍希望随知识库在线维护的说明文档。";
  }
  return "直接填写希望稳定附带给 AI 的正文，例如团队规范、审核口径、交付约束。";
}

function sourcePathLabel(kind: KnowledgeSourceKind): string {
  switch (kind) {
    case "workspace-file":
      return "项目文件路径";
    case "workspace-dir":
      return "项目目录路径";
    case "workbench-doc":
      return "工作台文档路径";
    case "workbench-dir":
      return "工作台目录路径";
    default:
      return "引用路径";
  }
}

function sourcePathPlaceholder(kind: KnowledgeSourceKind): string {
  switch (kind) {
    case "workspace-file":
      return "例如：README.md 或 src/modules/task/service.ts";
    case "workspace-dir":
      return "例如：. / src / tests";
    case "workbench-doc":
      return "例如：项目A/01-需求分析/README.md";
    case "workbench-dir":
      return "例如：项目A/02-方案设计";
    default:
      return "填写相对路径";
  }
}

function sourceHelp(kind: KnowledgeSourceKind): string {
  switch (kind) {
    case "manual-text":
      return "适合短规则、团队约定、审核口径。保存后会作为“已附带知识”直接给模型。";
    case "inline-doc":
      return "适合在线维护较长说明文档。运行时会按正文型来源处理，但仍受注入上限保护。";
    case "workspace-file":
      return "只声明这个项目文件可被读取。AI 在执行时需要自己决定是否打开它。";
    case "workspace-dir":
      return "只声明这个项目目录可被浏览/检索/读取。适合“整个项目都可作为知识库”的场景。";
    case "workbench-doc":
      return "引用工作台文档中的单个正式文档，便于把需求/方案文档纳入知识空间。";
    case "workbench-dir":
      return "引用整个工作台目录，适合让 AI 在设计文档目录里按需查找。";
    default:
      return "";
  }
}

function sourcePathRoot(kind: KnowledgeSourceKind): string | null {
  if (kind === "workspace-file" || kind === "workspace-dir") {
    return "路径基准：当前 workspace 根目录";
  }
  if (kind === "workbench-doc" || kind === "workbench-dir") {
    return `路径基准：工作台文档根目录 ${workflowDocsRoot.value}`;
  }
  return null;
}

function browseButtonLabel(kind: KnowledgeSourceKind): string {
  if (kind === "workspace-dir" || kind === "workbench-dir") return "浏览目录";
  return "浏览文件";
}

function fillBundleDescriptionTemplate() {
  if (!form.value) return;
  form.value.description = [
    `适用场景：这组知识主要服务于${scopeLabel(form.value.scope)}的编排节点，用来补充稳定背景、约束和参考资料。`,
    "覆盖范围：包含团队约定、关键文档以及运行时可浏览的文件/目录范围，帮助 AI 理解项目上下文。",
    "优先关注：先看标题和说明里标出的核心来源，再按需深入具体文件或正文，不要一次性把所有内容都塞进输出。",
  ].join("\n");
}
</script>

<template>
  <div v-if="form" class="kb-form">
    <div class="kb-form__header">
      <div>
        <h3 class="kb-form__title">{{ form.name || "未命名知识库" }}</h3>
        <p class="kb-form__subtitle">知识库可以同时包含“直接附带的正文”和“执行时自己去看的文件/目录范围”。</p>
      </div>
      <button class="kb-form__save-btn" :disabled="isBuiltinReadonly" @click="onSave">
        <SaveOutlined /> {{ props.saveLabel || "保存" }}
      </button>
    </div>

    <section class="kb-form__card">
      <div class="kb-form__overview-line">
        <span class="kb-form__scope-badge">{{ scopeLabel(form.scope) }}</span>
        <span v-if="isBuiltinReadonly" class="kb-form__readonly-badge">内置只读</span>
        <span class="kb-form__overview-meta">共 {{ form.sourceRefs.length }} 条来源，已启用 {{ enabledSourceCount }} 条</span>
      </div>
      <div class="kb-form__field-grid">
        <label class="kb-form__field">
          <span>知识库名称</span>
          <input
            v-model="form.name"
            name="codeflow-knowledge-bundle-name"
            autocomplete="new-password"
            class="kb-form__input"
            :disabled="isBuiltinReadonly"
            placeholder="例如：软件工程共享知识 / 开发角色知识"
          />
        </label>
        <label class="kb-form__field">
          <span>适用范围</span>
          <select v-model="form.scope" class="kb-form__select" :disabled="isBuiltinReadonly">
            <option value="shared">全局共享</option>
            <option value="workflow">流程默认</option>
            <option value="role">角色默认</option>
          </select>
        </label>
        <label class="kb-form__field kb-form__field--full">
          <span>描述</span>
          <textarea v-model="form.description" class="kb-form__textarea" rows="4" :disabled="isBuiltinReadonly" placeholder="说明这组知识主要服务谁、覆盖什么问题，以及 AI 应该优先关注哪些来源。" />
          <div class="kb-form__field-actions">
            <small class="kb-form__field-help">建议写清适用场景、覆盖范围、优先关注的来源，不要只写“项目知识”这类空话。</small>
            <button class="kb-form__ghost-btn" type="button" :disabled="isBuiltinReadonly" @click="fillBundleDescriptionTemplate">插入说明模板</button>
          </div>
        </label>
      </div>
      <div class="kb-form__hint">
        `知识库名称` 是这组来源对人可见的集合名。真正给 AI 看的单条来源标题、说明和路径，在下面逐条维护。
      </div>
    </section>

    <section class="kb-form__card">
      <div class="kb-form__section-header">
        <div>
          <h4>知识来源</h4>
          <p class="kb-form__meta">
            工作台文档根目录：<code>{{ workflowDocsRoot }}</code>。点击来源卡会打开编辑弹框。
          </p>
        </div>
      </div>

      <div class="kb-form__quick-adds">
        <button v-for="kind in quickAddKinds" :key="kind" class="kb-form__quick-btn" type="button" :disabled="isBuiltinReadonly" @click="addSource(kind)">
          + {{ sourceKindLabel(kind) }}
        </button>
      </div>

      <div class="kb-form__workspace">
        <section class="kb-form__navigator">
          <div class="kb-form__navigator-head">
            <div>
              <strong>来源清单</strong>
              <span class="kb-form__count-badge">{{ form.sourceRefs.length }} 条来源</span>
            </div>
            <div class="kb-form__navigator-actions">
              <button class="kb-form__ghost-btn" type="button" :disabled="!selectedSource || isBuiltinReadonly" @click="duplicateSelectedSource">
                <CopyOutlined /> 复制当前来源
              </button>
              <button class="kb-form__add-btn" type="button" :disabled="isBuiltinReadonly" @click="addSource()">
                <PlusOutlined /> 添加来源
              </button>
            </div>
          </div>

          <div class="kb-form__builder-list">
            <button
              v-for="(source, index) in form.sourceRefs"
              :key="source.id"
              class="kb-form__builder-item"
              :class="{ 'kb-form__builder-item--active': selectedSourceIndex === index }"
              @click="selectSource(index)"
            >
              <div class="kb-form__builder-item-head">
                <strong>{{ sourceTitle(source, index) }}</strong>
                <span :class="source.enabled !== false ? 'kb-form__status kb-form__status--on' : 'kb-form__status'">
                  {{ source.enabled !== false ? "启用" : "停用" }}
                </span>
              </div>
              <div class="kb-form__builder-item-meta">
                <span>{{ sourceKindLabel(source.kind) }}</span>
                <span class="kb-form__mode-pill">{{ sourceModeLabel(source.kind) }}</span>
              </div>
              <small>{{ sourceSummary(source) }}</small>
            </button>
            <div v-if="!form.sourceRefs.length" class="kb-form__empty-state">
              当前还没有知识来源。先添加一条来源，再点来源卡进入弹框编辑。
            </div>
          </div>
        </section>

        <div class="kb-form__workspace-note">
          <strong>编辑方式</strong>
          <span>点击来源卡会弹出编辑窗口；新增或复制来源后也会自动进入弹框。真正落库仍以右上角“保存”为准。</span>
        </div>
      </div>
    </section>
  </div>

  <div v-else class="kb-form__empty">从左侧选择一个知识库查看详情，或新建知识库。</div>

  <a-modal
    :open="editorOpen"
    :width="920"
    :body-style="modalBodyStyle"
    wrap-class-name="orch-asset-modal orch-asset-editor-modal kb-form__editor-dialog"
    title="编辑知识来源"
    @cancel="closeEditor"
  >
    <template #footer>
      <div v-if="selectedSource" class="kb-form__dialog-footer">
        <button class="kb-form__delete-btn" type="button" :disabled="isBuiltinReadonly" @click="removeSource(selectedSourceIndex)">
          <DeleteOutlined /> 删除当前来源
        </button>
        <div class="kb-form__dialog-footer-actions">
          <button class="kb-form__ghost-btn" type="button" @click="closeEditor">关闭</button>
          <button class="kb-form__save-btn" type="button" :disabled="isBuiltinReadonly" @click="onSaveAndCloseEditor">
            <SaveOutlined /> 保存知识库
          </button>
        </div>
      </div>
    </template>

    <div v-if="selectedSource" class="kb-form__modal">
      <div class="kb-form__modal-note">
        <strong>当前是草稿编辑</strong>
        <span>这里的修改会先保存在当前知识库草稿里。关闭弹框后，记得再点页面右上角“保存”。</span>
      </div>

      <div class="kb-form__editor-head">
        <div>
          <span class="kb-form__editor-eyebrow">当前来源</span>
          <h4>{{ sourceTitle(selectedSource, selectedSourceIndex) }}</h4>
          <p class="kb-form__meta">{{ sourceKindLabel(selectedSource.kind) }} · {{ sourceModeLabel(selectedSource.kind) }}</p>
        </div>
      </div>

      <div class="kb-form__chips">
        <span>{{ sourceKindLabel(selectedSource.kind) }}</span>
        <span>{{ sourceModeLabel(selectedSource.kind) }}</span>
        <span>{{ selectedSource.enabled !== false ? "已启用" : "已停用" }}</span>
      </div>

      <div class="kb-form__detail-card kb-form__detail-card--modal">
        <div class="kb-form__hint kb-form__hint--soft">
          {{ sourceHelp(selectedSource.kind) }}
        </div>

        <div class="kb-form__field-grid">
          <label class="kb-form__field">
            <span>来源类型</span>
            <select v-model="selectedSource.kind" class="kb-form__select" :disabled="isBuiltinReadonly">
              <option v-for="kind in sourceKinds" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
            </select>
          </label>
          <label class="kb-form__field">
            <span>启用状态</span>
            <a-switch class="app-form-switch" v-model:checked="selectedSource.enabled" :disabled="isBuiltinReadonly" checked-children="启用" un-checked-children="停用" />
          </label>
          <label class="kb-form__field kb-form__field--full">
            <span>来源标题</span>
            <input
              v-model="selectedSource.title"
              name="codeflow-knowledge-source-title"
              autocomplete="new-password"
              class="kb-form__input"
              :disabled="isBuiltinReadonly"
              placeholder="例如：README / 团队约定 / 方案文档目录"
            />
          </label>
          <label class="kb-form__field kb-form__field--full">
            <span>来源说明</span>
            <textarea
              v-model="selectedSource.description"
              class="kb-form__textarea kb-form__textarea--compact"
              rows="3"
              :disabled="isBuiltinReadonly"
              placeholder="告诉 AI 这个来源主要是什么、什么时候该优先看它。"
            />
          </label>

          <label v-if="supportsInlineBody(selectedSource.kind)" class="kb-form__field kb-form__field--full">
            <span>{{ sourceBodyLabel(selectedSource.kind) }}</span>
            <textarea
              v-model="selectedSource.inlineBody"
              class="kb-form__textarea"
              rows="12"
              :disabled="isBuiltinReadonly"
              :placeholder="sourceBodyPlaceholder(selectedSource.kind)"
            />
          </label>

          <label v-else class="kb-form__field kb-form__field--full">
            <span>{{ sourcePathLabel(selectedSource.kind) }}</span>
            <div class="kb-form__path-editor">
              <input
                v-model="selectedSource.ref"
                name="codeflow-knowledge-source-ref"
                autocomplete="off"
                class="kb-form__input kb-form__input--path"
                :disabled="isBuiltinReadonly"
                :placeholder="sourcePathPlaceholder(selectedSource.kind)"
              />
              <button class="kb-form__picker-btn" type="button" :disabled="isBuiltinReadonly" @click="openPathPicker(selectedSource.kind)">
                <FolderOpenOutlined /> {{ browseButtonLabel(selectedSource.kind) }}
              </button>
              <button v-if="selectedSource.ref" class="kb-form__clear-btn" type="button" :disabled="isBuiltinReadonly" @click="selectedSource.ref = ''">清空</button>
            </div>
            <small class="kb-form__field-help">{{ sourceHelp(selectedSource.kind) }}</small>
            <div v-if="sourcePathRoot(selectedSource.kind)" class="kb-form__path-root">
              {{ sourcePathRoot(selectedSource.kind) }}
            </div>
          </label>
        </div>
      </div>
    </div>
  </a-modal>

  <KnowledgeSourcePickerModal
    v-if="selectedSource"
    v-model:open="pathPickerOpen"
    :workspace-id="workspaceId"
    :mode="pathPickerMode"
    :workflow-docs-root="workflowDocsRoot"
    :initial-value="selectedSource.ref ?? ''"
    @pick="onPathPicked"
  />
</template>

<style scoped>
.kb-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
}

.kb-form__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.kb-form__title {
  margin: 0;
  font-size: 18px;
}

.kb-form__subtitle {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #6b7280);
}

.kb-form__save-btn,
.kb-form__ghost-btn,
.kb-form__add-btn,
.kb-form__picker-btn,
.kb-form__clear-btn,
.kb-form__quick-btn {
  min-height: 34px;
  padding: 6px 14px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.kb-form__save-btn {
  border: none;
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-primary, #1677ff) 88%, #fff), color-mix(in srgb, var(--app-primary, #1677ff) 72%, #0f4fbf));
  color: #fff;
  box-shadow: 0 8px 20px color-mix(in srgb, var(--app-primary, #1677ff) 22%, transparent);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}

.kb-form__save-btn:disabled,
.kb-form__ghost-btn:disabled,
.kb-form__add-btn:disabled,
.kb-form__picker-btn:disabled,
.kb-form__clear-btn:disabled,
.kb-form__quick-btn:disabled,
.kb-form__delete-btn:disabled {
  opacity: 0.58;
  cursor: not-allowed;
  transform: none;
}

.kb-form__ghost-btn {
  border: 1px solid var(--app-border, #d9d9d9);
  background: color-mix(in srgb, var(--app-bg, #fff) 90%, #f5f7fb);
  color: var(--app-muted, #666);
}

.kb-form__add-btn {
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  color: var(--app-primary, #1677ff);
}

.kb-form__save-btn:not(:disabled):hover,
.kb-form__ghost-btn:not(:disabled):hover,
.kb-form__add-btn:not(:disabled):hover,
.kb-form__quick-btn:not(:disabled):hover,
.kb-form__picker-btn:not(:disabled):hover {
  transform: translateY(-1px);
}
.kb-form__save-btn:not(:disabled):hover {
  filter: brightness(1.05);
  box-shadow: 0 12px 26px color-mix(in srgb, var(--app-accent, #c96442) 28%, transparent);
}
.kb-form__save-btn:not(:disabled):active {
  transform: translateY(0) scale(0.98);
  filter: brightness(0.94);
  box-shadow: 0 5px 10px color-mix(in srgb, var(--app-accent, #c96442) 18%, transparent);
}
.kb-form__save-btn:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-accent, #c96442) 28%, transparent);
  outline-offset: 2px;
}

.kb-form__quick-adds {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.kb-form__quick-btn {
  border: 1px solid #d7e1ec;
  background: #fff;
  color: var(--app-text, #1f2937);
  padding-inline: 12px;
}

.kb-form__picker-btn {
  border: 1px solid #cfd8e3;
  background: #f5f8fc;
  color: var(--app-text, #1f2937);
  white-space: nowrap;
}

.kb-form__clear-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--app-muted, #6b7280);
  padding-inline: 8px;
}

.kb-form__card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.kb-form__overview-line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.kb-form__scope-badge {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  background: #eef4fb;
  color: #31577e;
  font-size: 12px;
  font-weight: 600;
}

.kb-form__readonly-badge {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  background: #fff4e5;
  color: #9a5b14;
  font-size: 12px;
  font-weight: 600;
}

.kb-form__overview-meta {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.kb-form__section-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.kb-form__section-header h4 {
  margin: 0;
  font-size: 14px;
}

.kb-form__meta {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #6b7280);
}

.kb-form__meta code {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.05);
  color: var(--app-text, #1f2937);
}

.kb-form__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kb-form__field span {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.kb-form__input,
.kb-form__select,
.kb-form__textarea {
  width: 100%;
  padding: 9px 11px;
  border: 1px solid #cfd8e3;
  border-radius: 8px;
  font-size: 13px;
  outline: none;
  background: #fbfdff;
  color: var(--app-text, #1f2937);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
}

.kb-form__input:focus,
.kb-form__select:focus,
.kb-form__textarea:focus {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 45%, #cfd8e3);
}

.kb-form__textarea {
  resize: vertical;
  min-height: 120px;
}

.kb-form__textarea--compact {
  min-height: 84px;
}

.kb-form__field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.kb-form__field--full {
  grid-column: 1 / -1;
}

.kb-form__field-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.kb-form__field-help {
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted, #7a8699);
}

.kb-form__hint {
  padding: 10px 12px;
  border-radius: 10px;
  background: #f5f8fc;
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #6b7280);
}

.kb-form__hint--soft {
  background: rgba(15, 23, 42, 0.03);
}

.kb-form__builder {
  display: block;
}

.kb-form__workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.kb-form__navigator {
  min-height: 0;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-primary, #1677ff) 4%, #fff), var(--app-bg, #fff));
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.04);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}

.kb-form__navigator-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.kb-form__navigator-head > div:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
}

.kb-form__navigator-head strong {
  font-size: 13px;
  color: var(--app-text, #1f2937);
}

.kb-form__navigator-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.kb-form__count-badge {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #1f2937);
  font-size: 12px;
  font-weight: 600;
}

.kb-form__builder-list {
  min-height: 0;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.kb-form__builder-item {
  width: 100%;
  text-align: left;
  border: 1px solid #d7e1ec;
  border-radius: 12px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 92%, #f7f9fc), var(--app-bg, #fff));
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.kb-form__builder-item:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 24%, var(--app-border, #e8e8e8));
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
}

.kb-form__builder-item-head,
.kb-form__builder-item-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kb-form__builder-item strong {
  font-size: 13px;
  color: var(--app-text, #1f2937);
}

.kb-form__builder-item span {
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.kb-form__builder-item small {
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted, #7a8699);
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.kb-form__mode-pill {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(49, 87, 126, 0.08);
  color: #31577e;
}

.kb-form__builder-item--active {
  border-color: var(--app-primary, #1677ff);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-primary, #1677ff) 12%, #fff), var(--app-bg, #fff));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary, #1677ff) 22%, transparent), 0 12px 28px color-mix(in srgb, var(--app-primary, #1677ff) 14%, transparent);
}

.kb-form__detail-card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kb-form__detail-card--modal {
  min-height: 0;
}

.kb-form__workspace-note,
.kb-form__modal-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 14px;
  border-radius: 14px;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.kb-form__workspace-note {
  border: 1px dashed color-mix(in srgb, var(--app-primary, #1677ff) 20%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, #f7f9fc);
}

.kb-form__modal-note {
  border: 1px solid color-mix(in srgb, var(--app-primary, #1677ff) 14%, var(--app-border, #e8e8e8));
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-primary, #1677ff) 6%, #fff), var(--app-bg, #fff));
}

.kb-form__workspace-note strong,
.kb-form__modal-note strong {
  color: var(--app-text, #1f2937);
}

.kb-form__workspace-note span,
.kb-form__modal-note span {
  flex: 1 1 360px;
}

.kb-form__modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.kb-form__editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 80%, transparent);
}

.kb-form__editor-head h4 {
  margin: 0;
}

.kb-form__editor-eyebrow {
  display: inline-flex;
  margin: 0 0 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #1f2937);
  font-size: 12px;
  font-weight: 600;
}

.kb-form__delete-btn {
  min-height: 34px;
  padding: 6px 14px;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, #ff4d4f 35%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 6%, var(--app-bg, #fff));
  color: #ff4d4f;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.kb-form__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.kb-form__chips span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, #fff);
  color: color-mix(in srgb, var(--app-primary, #1677ff) 72%, #1f2937);
  font-size: 12px;
  font-weight: 600;
}

.kb-form__modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--app-muted, #666);
}

:deep(.kb-form__editor-dialog .ant-modal-footer) {
  padding: 14px 24px 18px;
  border-top: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 86%, transparent);
  background: color-mix(in srgb, var(--app-bg, #fff) 94%, #f8fafc);
}

.kb-form__dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.kb-form__dialog-footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

:deep(.kb-form__editor-dialog .ant-modal) {
  max-width: calc(100vw - 32px);
  margin: 24px auto;
  padding-bottom: 0;
}

:deep(.kb-form__editor-dialog .ant-modal-content) {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  overflow: hidden;
}

:deep(.kb-form__editor-dialog .ant-modal-body) {
  min-height: 0;
  overflow: auto;
}

.kb-form__path-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
}

.kb-form__input--path {
  min-width: 0;
}

.kb-form__path-root {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.04);
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.kb-form__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--app-muted, #6b7280);
}

.kb-form__choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.kb-form__choice {
  position: relative;
  cursor: pointer;
}

.kb-form__choice input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.kb-form__choice span {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--kb-form-control-border, #cfd8e3);
  border-radius: 12px;
  background: var(--kb-form-control-bg, #fbfdff);
  box-shadow: var(--kb-form-control-shadow, inset 0 1px 0 rgba(255,255,255,0.75));
  color: color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size: 12px;
  font-weight: 600;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease, color 0.16s ease;
}

.kb-form__choice:hover span {
  border-color: var(--kb-form-control-border-hover, #93a4b8);
  background: var(--kb-form-control-bg-hover, #f2f8ff);
  box-shadow: var(--kb-form-control-shadow-hover, inset 0 1px 2px rgba(15,23,42,0.04));
}

.kb-form__choice input:checked + span {
  border-color: var(--kb-form-control-focus, #3898ec);
  box-shadow: var(--kb-form-control-focus-ring, inset 0 0 0 1px #3898ec, 0 0 0 3px rgba(56,152,236,0.18));
  background: color-mix(in srgb, var(--kb-form-control-bg-hover, #f2f8ff) 86%, #ffffff);
  color: color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}


.kb-form__icon-btn {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--app-muted, #9aa4b2);
  padding: 2px;
}

.kb-form__status {
  padding: 2px 8px;
  border-radius: 999px;
  background: #f0f2f5;
  color: #8c8c8c;
  font-size: 11px;
}

.kb-form__status--on {
  background: #edf9f0;
  color: #2f7d42;
}

.kb-form__empty,
.kb-form__empty-state {
  padding: 18px;
  border: 1px dashed #d7e1ec;
  border-radius: 12px;
  background: #fbfdff;
  color: var(--app-muted, #7a8699);
  font-size: 12px;
  line-height: 1.7;
}

@media (max-width: 1180px) {
  .kb-form__builder { height: auto; min-height: 0; }
}

@media (max-width: 860px) {
  .kb-form__header,
  .kb-form__section-header,
  .kb-form__navigator-head,
  .kb-form__editor-head {
    flex-direction: column;
    align-items: stretch;
  }

  .kb-form__field-grid,
  .kb-form__path-editor {
    grid-template-columns: 1fr;
  }

  .kb-form__field--full {
    grid-column: auto;
  }

  .kb-form__dialog-footer,
  .kb-form__dialog-footer-actions {
    flex-direction: column;
    align-items: stretch;
  }
}

:root[data-theme="dark"] .kb-form__card,
:root[data-theme="dark"] .kb-form__navigator,
:root[data-theme="dark"] .kb-form__detail-card,
:root[data-theme="dark"] .kb-form__builder-item,
:root[data-theme="dark"] .kb-form__empty-state,
:root[data-theme="dark"] .kb-form__empty,
:root[data-theme="dark"] .kb-form__quick-btn {
  border-color: #303030;
}

:root[data-theme="dark"] .kb-form__hint {
  background: #1a2230;
}

:root[data-theme="dark"] .kb-form__scope-badge {
  background: #223047;
  color: #c7d3e1;
}

:root[data-theme="dark"] .kb-form__meta code,
:root[data-theme="dark"] .kb-form__path-root,
:root[data-theme="dark"] .kb-form__quick-btn {
  background: rgba(255, 255, 255, 0.04);
}

:root[data-theme="dark"] .kb-form__builder-item {
  background: #182231;
}

:root[data-theme="dark"] .kb-form__builder-item span,
:root[data-theme="dark"] .kb-form__mode-pill {
  color: #9fb0c2;
}

:root[data-theme="dark"] .kb-form__builder-item small,
:root[data-theme="dark"] .kb-form__overview-meta,
:root[data-theme="dark"] .kb-form__subtitle,
:root[data-theme="dark"] .kb-form__meta,
:root[data-theme="dark"] .kb-form__path-root,
:root[data-theme="dark"] .kb-form__field-help {
  color: #8ea0b5;
}

:root[data-theme="dark"] .kb-form__builder-item--active {
  background: #11243f;
}

:root[data-theme="dark"] .kb-form__status {
  background: #2b3442;
  color: #a8b3c2;
}

:root[data-theme="dark"] .kb-form__status--on {
  background: #143025;
  color: #8fd1a3;
}

:root[data-theme="dark"] .kb-form__input,
:root[data-theme="dark"] .kb-form__select,
:root[data-theme="dark"] .kb-form__textarea,
:root[data-theme="dark"] .kb-form__picker-btn {
  background: #111827;
  border-color: #314055;
  box-shadow: none;
  color: #e5edf7;
}

:root[data-theme="dark"] .kb-form__picker-btn {
  background: #162132;
}

:root[data-theme="dark"] .kb-form__clear-btn,
:root[data-theme="dark"] .kb-form__quick-btn {
  color: #9fb0c2;
}

:root[data-theme="dark"] .kb-form__ghost-btn {
  border-color: #314055;
  background: #16181d;
  color: #d6dbe4;
}

:root[data-theme="dark"] .kb-form__add-btn,
:root[data-theme="dark"] .kb-form__chips span,
:root[data-theme="dark"] .kb-form__count-badge,
:root[data-theme="dark"] .kb-form__editor-eyebrow {
  background: rgba(22, 119, 255, 0.12);
  color: #8eb7ff;
}

:root[data-theme="dark"] .kb-form__workspace-note {
  background: rgba(255, 255, 255, 0.03);
}

:root[data-theme="dark"] .kb-form__modal-note {
  background: #1a2230;
}

:root[data-theme="dark"] :deep(.kb-form__editor-dialog .ant-modal-footer) {
  border-top-color: #303846;
  background: #11161d;
}

.kb-form__field {
  gap: 8px;
}

.kb-form__field span {
  font-weight: 600;
  color: color-mix(in srgb, var(--app-text, #1f2937) 82%, #4b5563);
}

.kb-form__card,
.kb-form__detail-card {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 95%, #f7f9fc), var(--app-bg, #fff));
}

.kb-form__input,
.kb-form__select,
.kb-form__textarea,
.kb-form__picker-btn {
  min-height: 40px;
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 14%, #b9c4d2);
  background: linear-gradient(180deg, #ffffff, #f7fbff);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.05), 0 1px 0 rgba(255, 255, 255, 0.9);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

.kb-form__input:hover,
.kb-form__select:hover,
.kb-form__textarea:hover,
.kb-form__picker-btn:hover {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 28%, #93a4b8);
  background: linear-gradient(180deg, #ffffff, #f2f8ff);
}

.kb-form__input:focus,
.kb-form__select:focus,
.kb-form__textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 45%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-primary, #1677ff) 14%, transparent), inset 0 1px 2px rgba(15, 23, 42, 0.04);
  background: #fff;
}

.kb-form__input::placeholder,
.kb-form__textarea::placeholder {
  color: color-mix(in srgb, var(--app-muted, #666) 76%, #9aa6b2);
}

:root[data-theme="dark"] .kb-form__field span {
  color: #d6dbe4;
}

:root[data-theme="dark"] .kb-form__card,
:root[data-theme="dark"] .kb-form__detail-card {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.02), rgba(255, 255, 255, 0.01));
}

:root[data-theme="dark"] .kb-form__input,
:root[data-theme="dark"] .kb-form__select,
:root[data-theme="dark"] .kb-form__textarea,
:root[data-theme="dark"] .kb-form__picker-btn {
  border-color: #3b4c63;
  background: linear-gradient(180deg, #181d24, #13171d);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(59, 76, 99, 0.14);
}
</style>

<style>
.kb-form {
  --kb-form-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 88%, #f5f0e6);
  --kb-form-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 78%, #f9f5ed);
  --kb-form-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 82%, #d9cfbf);
  --kb-form-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 18%, #d3c7b7);
  --kb-form-control-shadow: 0 0 0 1px color-mix(in srgb, #f0eee6 88%, transparent), inset 0 1px 0 rgba(255,255,255,0.78);
  --kb-form-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d1cfc5 82%, transparent), inset 0 1px 0 rgba(255,255,255,0.86);
  --kb-form-control-focus: #3898ec;
  --kb-form-control-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --kb-form-card-bg: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #f8f3e9), color-mix(in srgb, var(--app-bg,#fff) 96%, #fdfbf6));
  --kb-form-card-bg-hover: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #fff8f0), color-mix(in srgb, var(--app-bg,#fff) 88%, #f7eadc));
  --kb-form-card-border: color-mix(in srgb, var(--app-border,#d9d9d9) 78%, #d8c9b4);
  --kb-form-card-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d2bea6);
  --kb-form-card-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 12px 26px rgba(88,58,32,0.04);
  --kb-form-card-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 16px 30px rgba(88,58,32,0.1);
}

.kb-form .kb-form__card,
.kb-form .kb-form__navigator,
.kb-form .kb-form__detail-card,
.kb-form .kb-form__builder-item,
.kb-form .kb-form__quick-btn {
  border-color: var(--kb-form-card-border);
  background: var(--kb-form-card-bg);
}

.kb-form .kb-form__card,
.kb-form .kb-form__detail-card,
.kb-form .kb-form__navigator {
  box-shadow: var(--kb-form-card-shadow);
}

.kb-form .kb-form__builder-item:hover,
.kb-form .kb-form__quick-btn:not(:disabled):hover,
.kb-form .kb-form__picker-btn:not(:disabled):hover {
  border-color: var(--kb-form-card-border-hover);
  background: var(--kb-form-card-bg-hover);
  box-shadow: var(--kb-form-card-shadow-hover);
}

.kb-form .kb-form__scope-badge,
.kb-form .kb-form__count-badge,
.kb-form .kb-form__chips span,
.kb-form .kb-form__mode-pill,
.kb-form .kb-form__editor-eyebrow {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf3e8), color-mix(in srgb, var(--app-bg,#fff) 94%, #fff8ef));
  color: color-mix(in srgb, var(--app-accent, #c96442) 72%, #5b4633);
}

.kb-form .kb-form__workspace-note {
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 18%, var(--app-border, #d9d9d9));
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 94%, #fbf6ee), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
}

.kb-form .kb-form__modal-note {
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 16%, var(--app-border, #e8e8e8));
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-accent, #c96442) 5%, #fff), color-mix(in srgb, var(--app-bg, #fff) 96%, #fffaf2));
}

.kb-form .kb-form__meta code,
.kb-form .kb-form__path-root {
  background: color-mix(in srgb, var(--app-panel-bg,#fff) 88%, #f2ecdf);
}

.kb-form .kb-form__input,
.kb-form .kb-form__select,
.kb-form .kb-form__textarea,
.kb-form .kb-form__picker-btn,
.kb-form .kb-form__ghost-btn,
.kb-form .kb-form__add-btn {
  border-radius: 12px;
}

.kb-form .kb-form__input,
.kb-form .kb-form__select,
.kb-form .kb-form__textarea {
  padding: 10px 12px;
  border-color: var(--kb-form-control-border);
  background: var(--kb-form-control-bg);
  box-shadow: var(--kb-form-control-shadow);
}

.kb-form .kb-form__input:hover,
.kb-form .kb-form__select:hover,
.kb-form .kb-form__textarea:hover {
  border-color: var(--kb-form-control-border-hover);
  background: var(--kb-form-control-bg-hover);
  box-shadow: var(--kb-form-control-shadow-hover);
}

.kb-form .kb-form__input:focus,
.kb-form .kb-form__select:focus,
.kb-form .kb-form__textarea:focus {
  border-color: var(--kb-form-control-focus);
  box-shadow: var(--kb-form-control-focus-ring);
  background: color-mix(in srgb, var(--kb-form-control-bg-hover) 86%, #ffffff);
}

.kb-form .kb-form__save-btn {
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  box-shadow: 0 12px 24px rgba(201,100,66,0.18);
}

.kb-form .kb-form__ghost-btn {
  border-color: color-mix(in srgb, var(--app-border,#d9d9d9) 74%, #d7c7b0);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf7f0), color-mix(in srgb, var(--app-bg,#fff) 98%, #fffdf9));
  color: color-mix(in srgb, var(--app-text,#1f2937) 80%, #6f553d);
}

.kb-form .kb-form__add-btn,
.kb-form .kb-form__picker-btn {
  border-color: var(--kb-form-card-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 92%, #fff8ef), color-mix(in srgb, var(--app-bg,#fff) 96%, #f9efe2));
  color: color-mix(in srgb, var(--app-accent,#c96442) 78%, #5a4531);
}

.kb-form__editor-dialog {
  --kb-form-modal-surface: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg,#fff) 90%, #fbf6ee), color-mix(in srgb, var(--app-bg,#fff) 97%, #fffaf4));
  --kb-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.76));
  --kb-form-modal-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #ddceb8);
  --kb-form-modal-header-border: color-mix(in srgb, var(--app-border,#d9d9d9) 68%, #eadfce);
  --kb-form-modal-shadow: 0 28px 80px rgba(84,57,34,0.18);
  --kb-form-modal-control-bg: color-mix(in srgb, var(--app-panel-bg,#fff) 82%, #f7f0e5);
  --kb-form-modal-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#fff) 74%, #fbf6ee);
  --kb-form-modal-control-border: color-mix(in srgb, var(--app-border,#d9d9d9) 76%, #d5c5ae);
  --kb-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#c96442) 24%, #d3bea2);
  --kb-form-modal-control-shadow: 0 0 0 1px rgba(255,255,255,0.82) inset, 0 10px 22px rgba(88,58,32,0.04);
  --kb-form-modal-control-shadow-hover: 0 0 0 1px color-mix(in srgb, #d8cec0 74%, transparent), 0 14px 26px rgba(88,58,32,0.09);
  --kb-form-modal-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 16%, transparent);
}

.kb-form__editor-dialog .ant-modal-content {
  border: 1px solid var(--kb-form-modal-border);
  border-radius: 20px;
  overflow: hidden;
  background: var(--kb-form-modal-surface);
  box-shadow: var(--kb-form-modal-shadow);
}

.kb-form__editor-dialog .ant-modal-header {
  margin-bottom: 0;
  padding: 18px 24px 14px;
  border-bottom: 1px solid var(--kb-form-modal-header-border);
  background: var(--kb-form-modal-surface-soft);
}

.kb-form__editor-dialog .ant-modal-title {
  font-size: 15px;
  font-weight: 700;
  color: color-mix(in srgb, var(--app-text,#1f2937) 88%, #5c4630);
}

.kb-form__editor-dialog .ant-modal-body {
  padding: 20px 24px 24px;
  background: transparent;
}

.kb-form__editor-dialog .kb-form__input,
.kb-form__editor-dialog .kb-form__select,
.kb-form__editor-dialog .kb-form__textarea {
  border: 1px solid var(--kb-form-modal-control-border);
  border-radius: 12px;
  background: var(--kb-form-modal-control-bg);
  box-shadow: var(--kb-form-modal-control-shadow);
}

.kb-form__editor-dialog .kb-form__input:hover,
.kb-form__editor-dialog .kb-form__select:hover,
.kb-form__editor-dialog .kb-form__textarea:hover {
  border-color: var(--kb-form-modal-control-border-hover);
  background: var(--kb-form-modal-control-bg-hover);
  box-shadow: var(--kb-form-modal-control-shadow-hover);
}

.kb-form__editor-dialog .kb-form__input:focus,
.kb-form__editor-dialog .kb-form__select:focus,
.kb-form__editor-dialog .kb-form__textarea:focus {
  border-color: #3898ec;
  box-shadow: var(--kb-form-modal-focus-ring);
}

.kb-form__editor-dialog .kb-form__picker-btn,
.kb-form__editor-dialog .kb-form__ghost-btn {
  border-radius: 10px;
}

.kb-form__editor-dialog .kb-form__choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.kb-form__editor-dialog .kb-form__choice {
  position: relative;
  cursor: pointer;
}

.kb-form__editor-dialog .kb-form__choice input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.kb-form__editor-dialog .kb-form__choice span {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: 0 12px;
  border: 1px solid var(--kb-form-modal-control-border);
  border-radius: 12px;
  background: var(--kb-form-modal-control-bg);
  box-shadow: var(--kb-form-modal-control-shadow);
  color: color-mix(in srgb, var(--app-text,#1f2937) 78%, #6f553d);
  font-size: 12px;
  font-weight: 600;
}

.kb-form__editor-dialog .kb-form__choice:hover span {
  border-color: var(--kb-form-modal-control-border-hover);
  background: var(--kb-form-modal-control-bg-hover);
  box-shadow: var(--kb-form-modal-control-shadow-hover);
}

.kb-form__editor-dialog .kb-form__choice input:checked + span {
  border-color: #3898ec;
  box-shadow: var(--kb-form-modal-focus-ring);
  background: color-mix(in srgb, var(--kb-form-modal-control-bg-hover) 84%, #ffffff);
  color: color-mix(in srgb, var(--app-accent,#c96442) 72%, #38404a);
}


:root[data-theme="dark"] .kb-form {
  --kb-form-control-bg: color-mix(in srgb, var(--app-panel-bg,#30302e) 92%, #1e1a16);
  --kb-form-control-bg-hover: color-mix(in srgb, var(--app-panel-bg,#30302e) 84%, #27221c);
  --kb-form-control-border: color-mix(in srgb, var(--app-border,#303030) 95%, #544a40);
  --kb-form-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 22%, #6a5a4b);
  --kb-form-control-shadow: 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 1px rgba(0,0,0,0.24);
  --kb-form-control-shadow-hover: 0 0 0 1px rgba(255,255,255,0.06), inset 0 1px 1px rgba(0,0,0,0.28);
  --kb-form-control-focus-ring: inset 0 0 0 1px #3898ec, 0 0 0 3px color-mix(in srgb, #3898ec 18%, transparent);
  --kb-form-card-bg: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.02));
  --kb-form-card-bg-hover: linear-gradient(180deg, rgba(217,119,87,0.16), rgba(255,255,255,0.03));
  --kb-form-card-border: color-mix(in srgb, var(--app-border,#303030) 92%, #5a4d42);
  --kb-form-card-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 36%, #73604f);
  --kb-form-card-shadow: inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 28px rgba(0,0,0,0.18);
  --kb-form-card-shadow-hover: inset 0 1px 0 rgba(255,255,255,0.06), 0 14px 30px rgba(0,0,0,0.22);
}

:root[data-theme="dark"] .kb-form .kb-form__select {
  color-scheme: dark;
}

:root[data-theme="dark"] .kb-form .kb-form__select option {
  background: #181d24;
  color: #ece7df;
}

:root[data-theme="dark"] .kb-form .kb-form__select option:checked {
  background: color-mix(in srgb, var(--app-accent,#d97757) 28%, #181d24);
  color: #ffffff;
}

:root[data-theme="dark"] .kb-form .kb-form__builder-item--active {
  border-color: color-mix(in srgb, var(--app-accent,#d97757) 52%, #73604f);
  background: linear-gradient(180deg, rgba(217,119,87,0.16), rgba(255,255,255,0.028));
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 0 0 1px rgba(217,119,87,0.18), 0 14px 30px rgba(0,0,0,0.24);
}

:root[data-theme="dark"] .kb-form__editor-dialog {
  --kb-form-modal-surface: linear-gradient(180deg, rgba(27,24,20,0.96), rgba(18,16,14,0.98));
  --kb-form-modal-surface-soft: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
  --kb-form-modal-border: color-mix(in srgb, var(--app-border,#303030) 90%, #594c40);
  --kb-form-modal-header-border: color-mix(in srgb, var(--app-border,#303030) 82%, #4b4036);
  --kb-form-modal-shadow: 0 32px 90px rgba(0,0,0,0.45);
  --kb-form-modal-control-bg: linear-gradient(180deg, rgba(31,27,23,0.98), rgba(24,21,18,0.98));
  --kb-form-modal-control-bg-hover: linear-gradient(180deg, rgba(38,33,28,0.98), rgba(30,26,22,0.98));
  --kb-form-modal-control-border: color-mix(in srgb, var(--app-border,#303030) 86%, #625346);
  --kb-form-modal-control-border-hover: color-mix(in srgb, var(--app-accent,#d97757) 26%, #756152);
  --kb-form-modal-control-shadow: inset 0 1px 1px rgba(255,255,255,0.04), 0 12px 24px rgba(0,0,0,0.22);
  --kb-form-modal-control-shadow-hover: inset 0 1px 1px rgba(255,255,255,0.06), 0 14px 28px rgba(0,0,0,0.28);
}
</style>

