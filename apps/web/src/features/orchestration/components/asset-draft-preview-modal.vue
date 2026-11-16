<script lang="ts">
/** 预览弹框标签页标识；候选卡各区块点击后定位到对应标签。 */
export type DraftPreviewTabKey = "definition" | "bindings" | "diff" | "rationale";
</script>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { CheckCircleOutlined } from "@ant-design/icons-vue";
import {
  type AssetValidationIssue,
  type EngineType,
  type ResolvedRoleExecutionConfig,
  type RoleDraftComparison,
  type RoleDraftDiffItem,
  type RoleDraftPayload,
  type SkillDraftComparison,
  type SkillDraftPayload,
  type RoleExecutionEngineProfile,
  type WorkspaceId,
} from "@codeflowai/shared";

import { resolveCatalogRoleExecutionConfigForEngine } from "../../../composables/runtimeRoleExecutionConfig";
import { useEngineStore } from "../../../store/engine";
import { useOrchestrationStore } from "../../../store/orchestration";

defineOptions({ name: "AssetDraftPreviewModal" });

const props = withDefaults(defineProps<{
  open: boolean;
  workspaceId: WorkspaceId;
  /** 弹框打开时定位到的标签页。 */
  initialTab?: DraftPreviewTabKey;
  payload: RoleDraftPayload | SkillDraftPayload | null;
  comparison: RoleDraftComparison | SkillDraftComparison | null;
  validationIssues: AssetValidationIssue[];
  draftState: "ready" | "applying" | "applied" | null;
  /** 与候选卡“确认应用”按钮保持一致的禁用条件。 */
  applyDisabled?: boolean;
}>(), {
  initialTab: "definition",
  applyDisabled: false,
});

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "apply"): void;
  (e: "open-asset"): void;
}>();

const orch = useOrchestrationStore();
const engines = useEngineStore();
const activeTab = ref<DraftPreviewTabKey>(props.initialTab);

watch(() => props.open, (value) => {
  if (value) activeTab.value = props.initialTab;
});

const SCOPE_LABELS: Record<string, string> = { workflow: "流程级", role: "角色级", shared: "共享" };
const DELIVERY_LABELS: Record<string, string> = { direct: "直接回复", file: "单文件", "file-set": "文件集合" };
const FIELD_TYPE_LABELS: Record<string, string> = { text: "文本", markdown: "Markdown", json: "JSON", "file-path": "文件路径" };
const GATE_TYPE_LABELS: Record<string, string> = { ai: "AI 评估", regex: "正则匹配", "json-schema": "结构校验" };
/** 门禁 config 字段按类型给出可读标题，让用户知道这段内容是正则/提示词/Schema。 */
const GATE_CONFIG_LABELS: Record<string, string> = { ai: "评估提示词", regex: "匹配模式（正则）", "json-schema": "校验 Schema" };
const CHANGE_TYPE_LABELS: Record<string, string> = { added: "新增", removed: "移除", modified: "修改", unchanged: "未变更" };
const PROFILE_MODE_LABELS: Record<string, string> = { auto: "自动配置", custom: "自定义" };
const ACCESS_MODE_LABELS: Record<string, string> = { current: "需确认", "read-only": "只读", "full-access": "自动执行" };

const draft = computed(() => props.payload?.draft ?? null);
const roleDraft = computed(() => props.payload?.assetKind === "role" ? props.payload.draft : null);
const skillDraft = computed(() => props.payload?.assetKind === "skill" ? props.payload.draft : null);
const rationale = computed(() => props.payload?.rationale ?? null);
const referenceSummary = computed(() => props.payload?.referenceSummary ?? null);
const assetLabel = computed(() => props.payload?.assetKind === "skill" ? "Skill" : "Agent");

const stateLabel = computed(() => {
  if (props.draftState === "applied") return "已应用";
  if (props.draftState === "applying") return "应用中";
  if (props.draftState === "ready") return "待确认";
  return "";
});

/** 草案绑定的默认知识库；解析不到名称时保留 ID 并标记缺失。 */
const knowledgeBindings = computed(() =>
  (roleDraft.value?.defaultKnowledgeBundleIds ?? []).map((id) => ({
    id,
    bundle: orch.knowledgeBundles.find((item) => item.id === id) ?? null,
  })),
);

/** 草案引用的工具；逐项解析所属工具与工具定义。 */
const toolBindings = computed(() =>
  (roleDraft.value?.toolRefs ?? []).map((toolRef) => {
    const toolset = orch.toolsets.find((item) => item.id === toolRef.toolsetId) ?? null;
    const tool = toolset?.tools.find((item) => item.id === toolRef.toolId) ?? null;
    return { ref: toolRef, toolset, tool };
  }),
);

/**
 * 执行配置按引擎展开，标出偏好引擎并解析实际生效值。
 * auto 模式同样解析出引擎默认 model/effort/accessMode，避免“自动配置”看不出选了什么；
 * 解析器仅在引擎未启用时抛错，这里先按 enabled 过滤，未启用则置空展示。
 */
const engineProfiles = computed(() => {
  const config = roleDraft.value?.executionConfig ?? null;
  if (!config) return [];
  return (Object.entries(config.engineProfiles) as [EngineType, RoleExecutionEngineProfile][]).map(([engine, profile]) => {
    const resolved: ResolvedRoleExecutionConfig | null = profile.enabled
      ? resolveCatalogRoleExecutionConfigForEngine(
          config,
          engine,
          engines.byTypeForWorkspace(props.workspaceId).get(engine)?.models ?? [],
          config.preferredEngine,
        )
      : null;
    return {
      engine,
      preferred: engine === config.preferredEngine,
      profile,
      resolved,
    };
  });
});

/** 仅保留有实际变更的 diff 项，避免预览被未变更字段淹没。 */
const diffSections = computed(() =>
  (props.comparison?.sections ?? [])
    .map((section) => ({
      ...section,
      changedItems: section.items.filter((item) => item.changeType !== "unchanged"),
    }))
    .filter((section) => section.changedItems.length > 0),
);

const changeCount = computed(() => {
  const summary = props.comparison?.summary;
  if (!summary) return 0;
  return summary.added + summary.modified + summary.removed;
});

const bindingCount = computed(() => props.payload?.assetKind === "skill"
  ? (skillDraft.value?.files?.length ?? 0) + (skillDraft.value?.scripts?.length ?? 0)
  : knowledgeBindings.value.length + toolBindings.value.length);

const referenceRoleNames = computed(() => {
  if (props.payload?.assetKind !== "role") return [];
  return props.payload.referenceSummary.roleIds.map((id) => orch.roles.find((role) => role.id === id)?.name ?? id);
});
const referenceBundleNames = computed(() => {
  if (props.payload?.assetKind !== "role") return [];
  return props.payload.referenceSummary.knowledgeBundleIds.map((id) => orch.knowledgeBundles.find((item) => item.id === id)?.name ?? id);
});
const referenceToolsetNames = computed(() => {
  if (props.payload?.assetKind !== "role") return [];
  return props.payload.referenceSummary.toolsetIds.map((id) => orch.toolsets.find((item) => item.id === id)?.name ?? id);
});
const referenceSkillNames = computed(() => {
  if (props.payload?.assetKind !== "skill") return [];
  return props.payload.referenceSummary.skillIds.map((id) => orch.skills.find((skill) => skill.id === id)?.name ?? id);
});

const errorCount = computed(() => props.validationIssues.filter((issue) => issue.severity === "error").length);
const warningCount = computed(() => props.validationIssues.filter((issue) => issue.severity === "warning").length);
const bindingIssues = computed(() => props.validationIssues.filter((issue) => issue.source === "reference" || issue.code.startsWith("UNKNOWN_")));

const tabs = computed<Array<{ key: DraftPreviewTabKey; label: string; count: number | null }>>(() => [
  { key: "definition", label: props.payload?.assetKind === "skill" ? "Skill 定义" : "Agent 定义", count: null },
  { key: "bindings", label: props.payload?.assetKind === "skill" ? "文件与脚本" : "知识库与工具", count: bindingCount.value },
  { key: "diff", label: "变更对比", count: changeCount.value },
  { key: "rationale", label: "生成说明", count: null },
]);

/** 关闭弹框；开关状态由父组件 v-model 持有。 */
function close(): void {
  emit("update:open", false);
}

/** 透传应用动作；二次确认与请求仍由助手面板统一处理。 */
function requestApply(): void {
  if (props.applyDisabled) return;
  emit("apply");
}

/** 把 diff 值转成可读文本；语义标签优先，结构值走 JSON 序列化。 */
function formatDiffValue(value: unknown, label?: string | null): string {
  if (label) return label;
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 变更值块标题；新建草案没有原值，统一显示“内容”。 */
function diffValueTitle(item: RoleDraftDiffItem, side: "before" | "after"): string {
  if (item.changeType === "added") return "内容";
  if (item.changeType === "removed") return "原值";
  return side === "before" ? "原值" : "新值";
}
</script>

<template>
  <a-modal
    :open="open"
    :footer="null"
    :width="'min(1040px, 94vw)'"
    :body-style="{ padding: 0 }"
    @cancel="close"
  >
    <template #title>
      <div class="draft-preview__title">
        <strong>{{ draft?.name || "候选草案" }}</strong>
        <span class="draft-preview__title-badge">{{ payload?.mode === "revise" ? `优化 ${assetLabel}` : `创建 ${assetLabel}` }}</span>
        <span v-if="stateLabel" class="draft-preview__title-badge draft-preview__title-badge--state">{{ stateLabel }}</span>
      </div>
    </template>

    <div v-if="!payload || !draft" class="draft-preview__missing">候选草案数据不存在或已失效。</div>

    <div v-else class="draft-preview">
      <nav class="draft-preview__tabs" aria-label="草案预览标签">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          type="button"
          class="draft-preview__tab"
          :class="{ 'draft-preview__tab--active': activeTab === tab.key }"
          @click="activeTab = tab.key"
        >
          <span>{{ tab.label }}</span>
          <span v-if="tab.count != null" class="draft-preview__tab-count">{{ tab.count }}</span>
        </button>
      </nav>

      <div class="draft-preview__body">
        <template v-if="activeTab === 'definition' && payload.assetKind === 'skill'">
          <section class="draft-preview__section">
            <h4>基本信息</h4>
            <div class="draft-preview__kv-grid">
              <div class="draft-preview__kv">
                <span>名称</span>
                <p>{{ skillDraft?.name || "—" }}</p>
              </div>
              <div class="draft-preview__kv">
                <span>slug</span>
                <p>{{ skillDraft?.slug || "—" }}</p>
              </div>
              <div class="draft-preview__kv draft-preview__kv--wide">
                <span>描述</span>
                <p>{{ skillDraft?.description || "—" }}</p>
              </div>
              <div class="draft-preview__kv draft-preview__kv--wide">
                <span>触发条件</span>
                <p>{{ skillDraft?.trigger || "—" }}</p>
              </div>
            </div>
          </section>

          <section class="draft-preview__section">
            <h4>执行说明</h4>
            <pre class="draft-preview__pre">{{ skillDraft?.instructions || "—" }}</pre>
          </section>

          <section class="draft-preview__section">
            <h4>SKILL.md</h4>
            <pre class="draft-preview__pre">{{ skillDraft?.skillMd || "—" }}</pre>
          </section>

          <section class="draft-preview__section">
            <h4>目标</h4>
            <div class="draft-preview__chip-row">
              <span v-for="engine in skillDraft?.targetEngines ?? []" :key="engine" class="draft-preview__badge">{{ engine }}</span>
              <span v-for="tag in skillDraft?.tags ?? []" :key="tag" class="draft-preview__badge">{{ tag }}</span>
            </div>
          </section>
        </template>

        <template v-else-if="activeTab === 'definition'">
          <section class="draft-preview__section">
            <h4>基本信息</h4>
            <div class="draft-preview__kv-grid">
              <div class="draft-preview__kv">
                <span>名称</span>
                <p>{{ roleDraft?.name || "—" }}</p>
              </div>
              <div class="draft-preview__kv">
                <span>描述</span>
                <p>{{ roleDraft?.description || "—" }}</p>
              </div>
              <div class="draft-preview__kv draft-preview__kv--wide">
                <span>职责</span>
                <p>{{ roleDraft?.responsibility || "—" }}</p>
              </div>
            </div>
          </section>

          <section class="draft-preview__section">
            <h4>系统提示词</h4>
            <pre class="draft-preview__pre">{{ roleDraft?.systemPrompt || "—" }}</pre>
          </section>

          <section class="draft-preview__section">
            <h4>输入定义</h4>
            <pre v-if="roleDraft?.inputDefinition.instructions" class="draft-preview__pre">{{ roleDraft.inputDefinition.instructions }}</pre>
            <ul v-if="roleDraft?.inputDefinition.requiredFields.length" class="draft-preview__field-list">
              <li v-for="field in roleDraft.inputDefinition.requiredFields" :key="field.key">
                <div class="draft-preview__field-head">
                  <strong>{{ field.label }}</strong>
                  <code>{{ field.key }}</code>
                  <span class="draft-preview__badge">{{ FIELD_TYPE_LABELS[field.valueType] ?? field.valueType }}</span>
                  <span v-if="field.required" class="draft-preview__badge draft-preview__badge--accent">必填</span>
                </div>
                <p v-if="field.description">{{ field.description }}</p>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">未声明必需输入字段。</p>
          </section>

          <section class="draft-preview__section">
            <h4>输出定义</h4>
            <div class="draft-preview__chip-row">
              <span class="draft-preview__badge">{{ DELIVERY_LABELS[roleDraft?.outputDefinition.deliveryMode ?? ""] ?? roleDraft?.outputDefinition.deliveryMode }}</span>
              <span class="draft-preview__badge">{{ roleDraft?.outputDefinition.format }}</span>
              <span v-if="roleDraft?.outputDefinition.resultKey" class="draft-preview__badge">结果键 {{ roleDraft.outputDefinition.resultKey }}</span>
            </div>
            <pre v-if="roleDraft?.outputDefinition.instructions" class="draft-preview__pre">{{ roleDraft.outputDefinition.instructions }}</pre>
            <ul v-if="roleDraft?.outputDefinition.files?.length" class="draft-preview__field-list">
              <li v-for="(file, index) in roleDraft.outputDefinition.files" :key="file.key ?? index">
                <div class="draft-preview__field-head">
                  <strong>{{ file.name }}</strong>
                  <span v-if="file.format" class="draft-preview__badge">{{ file.format }}</span>
                  <span v-if="file.required" class="draft-preview__badge draft-preview__badge--accent">必交付</span>
                </div>
                <p v-if="file.pathRule"><code>{{ file.pathRule }}</code></p>
                <p v-if="file.description">{{ file.description }}</p>
              </li>
            </ul>
            <ul v-if="roleDraft?.outputDefinition.requiredFields.length" class="draft-preview__field-list">
              <li v-for="field in roleDraft.outputDefinition.requiredFields" :key="field.key">
                <div class="draft-preview__field-head">
                  <strong>{{ field.label }}</strong>
                  <code>{{ field.key }}</code>
                  <span class="draft-preview__badge">{{ FIELD_TYPE_LABELS[field.valueType] ?? field.valueType }}</span>
                  <span v-if="field.required" class="draft-preview__badge draft-preview__badge--accent">必填</span>
                </div>
                <p v-if="field.description">{{ field.description }}</p>
              </li>
            </ul>
          </section>

          <section class="draft-preview__section">
            <h4>门禁标准 <small>{{ roleDraft?.gateCriteria.length ?? 0 }}</small></h4>
            <ul v-if="roleDraft?.gateCriteria.length" class="draft-preview__field-list">
              <li v-for="gate in roleDraft.gateCriteria" :key="gate.id">
                <div class="draft-preview__field-head">
                  <strong>{{ gate.label }}</strong>
                  <span class="draft-preview__badge">{{ GATE_TYPE_LABELS[gate.type] ?? gate.type }}</span>
                  <span class="draft-preview__badge" :class="{ 'draft-preview__badge--accent': gate.blocking }">
                    {{ gate.blocking ? "阻断" : "仅警告" }}
                  </span>
                </div>
                <div class="draft-preview__sub-field">
                  <span class="draft-preview__sub-label">{{ GATE_CONFIG_LABELS[gate.type] ?? "规则内容" }}</span>
                  <pre v-if="gate.config" class="draft-preview__pre draft-preview__pre--compact">{{ gate.config }}</pre>
                  <span v-else class="draft-preview__empty-line">未配置规则内容</span>
                </div>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">未配置门禁标准。</p>
          </section>

          <section class="draft-preview__section">
            <h4>执行配置</h4>
            <ul class="draft-preview__field-list">
              <li v-for="item in engineProfiles" :key="item.engine">
                <div class="draft-preview__field-head">
                  <strong>{{ item.engine === "claude" ? "Claude" : "Codex" }}</strong>
                  <span v-if="item.preferred" class="draft-preview__badge draft-preview__badge--accent">偏好引擎</span>
                  <span class="draft-preview__badge">{{ item.profile.enabled ? "启用" : "停用" }}</span>
                  <span class="draft-preview__badge">{{ PROFILE_MODE_LABELS[item.profile.mode] ?? item.profile.mode }}</span>
                </div>
                <dl v-if="item.resolved" class="draft-preview__spec-grid">
                  <div><dt>{{ item.profile.mode === "auto" ? "默认模型" : "模型" }}</dt><dd>{{ item.resolved.model || "—" }}</dd></div>
                  <div><dt>推理强度</dt><dd>{{ item.resolved.effort || "未配置" }}</dd></div>
                  <div><dt>访问模式</dt><dd>{{ ACCESS_MODE_LABELS[item.resolved.accessMode] ?? item.resolved.accessMode }}</dd></div>
                  <div><dt>最大重试</dt><dd>{{ item.resolved.maxRetries }}</dd></div>
                </dl>
                <p v-else class="draft-preview__empty-line">该引擎未启用，运行时不会调度。</p>
              </li>
            </ul>
          </section>
        </template>

        <template v-else-if="activeTab === 'bindings' && payload.assetKind === 'skill'">
          <section class="draft-preview__section">
            <h4>包文件 <small>{{ skillDraft?.files?.length ?? 0 }}</small></h4>
            <ul v-if="skillDraft?.files?.length" class="draft-preview__field-list">
              <li v-for="file in skillDraft.files" :key="file.relPath">
                <div class="draft-preview__field-head">
                  <strong>{{ file.relPath }}</strong>
                  <span class="draft-preview__badge">{{ file.kind }}</span>
                  <span class="draft-preview__badge">{{ file.contentType || "unknown" }}</span>
                  <span class="draft-preview__badge">{{ file.sizeBytes }} B</span>
                </div>
                <pre v-if="file.contentText" class="draft-preview__pre draft-preview__pre--compact">{{ file.contentText }}</pre>
                <p v-else class="draft-preview__meta-line">非文本内容或仅保存摘要。</p>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">未配置包文件。</p>
          </section>

          <section class="draft-preview__section">
            <h4>脚本入口 <small>{{ skillDraft?.scripts?.length ?? 0 }}</small></h4>
            <ul v-if="skillDraft?.scripts?.length" class="draft-preview__field-list">
              <li v-for="script in skillDraft.scripts" :key="script.id">
                <div class="draft-preview__field-head">
                  <strong>{{ script.name }}</strong>
                  <code>{{ script.id }}</code>
                  <span class="draft-preview__badge">{{ script.runtime }}</span>
                  <span v-if="script.exposeAsTool" class="draft-preview__badge draft-preview__badge--accent">工具</span>
                  <span v-if="script.requiresWrite" class="draft-preview__badge draft-preview__badge--missing">写入</span>
                </div>
                <p class="draft-preview__meta-line">{{ script.scriptPath }}</p>
                <p v-if="script.description">{{ script.description }}</p>
                <div v-if="script.inputSchema" class="draft-preview__sub-field">
                  <span class="draft-preview__sub-label">输入 Schema</span>
                  <pre class="draft-preview__pre draft-preview__pre--compact">{{ script.inputSchema }}</pre>
                </div>
                <div v-if="script.outputSchema" class="draft-preview__sub-field">
                  <span class="draft-preview__sub-label">输出 Schema</span>
                  <pre class="draft-preview__pre draft-preview__pre--compact">{{ script.outputSchema }}</pre>
                </div>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">未配置脚本入口。</p>
          </section>
        </template>

        <template v-else-if="activeTab === 'bindings'">
          <section v-if="bindingIssues.length" class="draft-preview__section">
            <h4>绑定校验 <small>{{ bindingIssues.length }}</small></h4>
            <ul class="draft-preview__field-list">
              <li v-for="issue in bindingIssues" :key="`${issue.code}-${issue.fieldPath}-${issue.message}`">
                <div class="draft-preview__field-head">
                  <strong>{{ issue.message }}</strong>
                  <span class="draft-preview__badge draft-preview__badge--missing">阻断</span>
                </div>
                <p v-if="issue.suggestion">{{ issue.suggestion }}</p>
              </li>
            </ul>
          </section>

          <section class="draft-preview__section">
            <h4>默认知识库 <small>{{ knowledgeBindings.length }}</small></h4>
            <ul v-if="knowledgeBindings.length" class="draft-preview__field-list">
              <li v-for="item in knowledgeBindings" :key="item.id">
                <div class="draft-preview__field-head">
                  <strong>{{ item.bundle?.name ?? item.id }}</strong>
                  <span v-if="item.bundle" class="draft-preview__badge">{{ SCOPE_LABELS[item.bundle.scope] ?? item.bundle.scope }}</span>
                  <span v-else class="draft-preview__badge draft-preview__badge--missing">未找到</span>
                </div>
                <p v-if="item.bundle?.description">{{ item.bundle.description }}</p>
                <p v-if="item.bundle" class="draft-preview__meta-line">{{ item.bundle.sourceRefs.length }} 个知识来源</p>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">草案未绑定默认知识库。</p>
          </section>

          <section class="draft-preview__section">
            <h4>工具引用 <small>{{ toolBindings.length }}</small></h4>
            <ul v-if="toolBindings.length" class="draft-preview__field-list">
              <li v-for="item in toolBindings" :key="`${item.ref.toolsetId}-${item.ref.toolId}`">
                <div class="draft-preview__field-head">
                  <strong>{{ item.tool?.name ?? item.ref.toolId }}</strong>
                  <span v-if="item.ref.alias" class="draft-preview__badge">别名 {{ item.ref.alias }}</span>
                  <span v-if="item.ref.required" class="draft-preview__badge draft-preview__badge--accent">必需</span>
                  <span v-if="!item.tool" class="draft-preview__badge draft-preview__badge--missing">未找到</span>
                </div>
                <p class="draft-preview__meta-line">所属工具：{{ item.toolset?.name ?? item.ref.toolsetId }}</p>
                <p v-if="item.tool?.description">{{ item.tool.description }}</p>
                <p v-if="item.ref.usageGuidance">使用指引：{{ item.ref.usageGuidance }}</p>
              </li>
            </ul>
            <p v-else class="draft-preview__empty-line">草案未引用工具。</p>
          </section>
        </template>

        <template v-else-if="activeTab === 'diff'">
          <section class="draft-preview__section">
            <h4>变更统计</h4>
            <div class="draft-preview__chip-row">
              <span class="draft-preview__badge draft-preview__badge--added">新增 {{ comparison?.summary.added ?? 0 }}</span>
              <span class="draft-preview__badge draft-preview__badge--modified">修改 {{ comparison?.summary.modified ?? 0 }}</span>
              <span class="draft-preview__badge draft-preview__badge--removed">移除 {{ comparison?.summary.removed ?? 0 }}</span>
              <span class="draft-preview__badge">警告 {{ comparison?.summary.warnings ?? 0 }}</span>
            </div>
          </section>

          <p v-if="!diffSections.length" class="draft-preview__empty-line">本次草案没有字段级变更。</p>

          <section v-for="section in diffSections" :key="section.key" class="draft-preview__section">
            <h4>{{ section.label }} <small>{{ section.changedItems.length }}</small></h4>
            <div class="draft-preview__diff-list">
              <article v-for="item in section.changedItems" :key="item.path" class="draft-preview__diff-item">
                <div class="draft-preview__field-head">
                  <span class="draft-preview__badge" :class="`draft-preview__badge--${item.changeType}`">
                    {{ CHANGE_TYPE_LABELS[item.changeType] ?? item.changeType }}
                  </span>
                  <strong>{{ item.label }}</strong>
                  <code>{{ item.path }}</code>
                </div>
                <p v-if="item.note" class="draft-preview__meta-line">{{ item.note }}</p>
                <div v-if="item.changeType !== 'added'" class="draft-preview__diff-value draft-preview__diff-value--before">
                  <span>{{ diffValueTitle(item, "before") }}</span>
                  <pre>{{ formatDiffValue(item.beforeValue, item.beforeLabel) }}</pre>
                </div>
                <div v-if="item.changeType !== 'removed'" class="draft-preview__diff-value draft-preview__diff-value--after">
                  <span>{{ diffValueTitle(item, "after") }}</span>
                  <pre>{{ formatDiffValue(item.afterValue, item.afterLabel) }}</pre>
                </div>
              </article>
            </div>
          </section>
        </template>

        <template v-else>
          <section class="draft-preview__section">
            <h4>决策摘要</h4>
            <p class="draft-preview__paragraph">{{ rationale?.summary || "—" }}</p>
          </section>

          <section v-if="rationale?.keyDecisions?.length" class="draft-preview__section">
            <h4>关键决策</h4>
            <ul class="draft-preview__bullet-list">
              <li v-for="(decision, index) in rationale.keyDecisions" :key="index">{{ decision }}</li>
            </ul>
          </section>

          <section v-if="rationale?.assumptions?.length" class="draft-preview__section">
            <h4>假设</h4>
            <ul class="draft-preview__bullet-list">
              <li v-for="(assumption, index) in rationale.assumptions" :key="index">{{ assumption }}</li>
            </ul>
          </section>

          <section v-if="rationale?.risks?.length" class="draft-preview__section">
            <h4>风险</h4>
            <ul class="draft-preview__bullet-list">
              <li v-for="(risk, index) in rationale.risks" :key="index">{{ risk }}</li>
            </ul>
          </section>

          <section class="draft-preview__section">
            <h4>生成依据</h4>
            <div class="draft-preview__reference-group">
              <span class="draft-preview__reference-label">参考 Agent</span>
              <div class="draft-preview__chip-row">
                <span v-for="name in referenceRoleNames" :key="name" class="draft-preview__badge">{{ name }}</span>
                <span v-if="!referenceRoleNames.length" class="draft-preview__empty-line">无</span>
              </div>
            </div>
            <div v-if="payload.assetKind === 'skill'" class="draft-preview__reference-group">
              <span class="draft-preview__reference-label">参考 Skill</span>
              <div class="draft-preview__chip-row">
                <span v-for="name in referenceSkillNames" :key="name" class="draft-preview__badge">{{ name }}</span>
                <span v-if="!referenceSkillNames.length" class="draft-preview__empty-line">无</span>
              </div>
            </div>
            <div class="draft-preview__reference-group">
              <span class="draft-preview__reference-label">参考知识库</span>
              <div class="draft-preview__chip-row">
                <span v-for="name in referenceBundleNames" :key="name" class="draft-preview__badge">{{ name }}</span>
                <span v-if="!referenceBundleNames.length" class="draft-preview__empty-line">无</span>
              </div>
            </div>
            <div class="draft-preview__reference-group">
              <span class="draft-preview__reference-label">参考工具</span>
              <div class="draft-preview__chip-row">
                <span v-for="name in referenceToolsetNames" :key="name" class="draft-preview__badge">{{ name }}</span>
                <span v-if="!referenceToolsetNames.length" class="draft-preview__empty-line">无</span>
              </div>
            </div>
            <div class="draft-preview__reference-group">
              <span class="draft-preview__reference-label">参考文件 <small>{{ referenceSummary?.selectedPaths.length ?? 0 }}</small></span>
              <ul v-if="referenceSummary?.selectedPaths.length" class="draft-preview__path-list">
                <li v-for="path in referenceSummary.selectedPaths" :key="path"><code>{{ path }}</code></li>
              </ul>
              <span v-else class="draft-preview__empty-line">无</span>
            </div>
          </section>
        </template>
      </div>

      <footer class="draft-preview__footer">
        <div class="draft-preview__footer-meta">
          <span v-if="errorCount" class="draft-preview__footer-issue draft-preview__footer-issue--error">{{ errorCount }} 个错误</span>
          <span v-if="warningCount" class="draft-preview__footer-issue">{{ warningCount }} 个警告</span>
        </div>
        <div class="draft-preview__footer-actions">
          <button class="draft-preview__btn" type="button" @click="close">关闭</button>
          <button
            v-if="draftState === 'applied'"
            class="draft-preview__btn draft-preview__btn--primary"
            type="button"
            @click="emit('open-asset')"
          >
            查看 {{ assetLabel }}
          </button>
          <button
            v-else
            class="draft-preview__btn draft-preview__btn--primary"
            type="button"
            :disabled="applyDisabled"
            @click="requestApply"
          >
            <CheckCircleOutlined />
            <span>{{ draftState === "applying" ? "应用中..." : "确认应用" }}</span>
          </button>
        </div>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.draft-preview__title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding-right: 24px;
}

.draft-preview__title strong {
  overflow: hidden;
  color: var(--app-text);
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.draft-preview__title-badge {
  flex: 0 0 auto;
  border-radius: 999px;
  padding: 2px 9px;
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  color: var(--app-accent);
  font-size: 12px;
  font-weight: 600;
}

.draft-preview__title-badge--state {
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
}

.draft-preview__missing {
  padding: 36px 20px;
  color: var(--app-muted);
  font-size: 13px;
  text-align: center;
}

.draft-preview {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.draft-preview__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--app-border);
  padding: 8px 20px 0;
}

.draft-preview__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  border-bottom: 2px solid transparent;
  border-radius: 6px 6px 0 0;
  padding: 8px 12px;
  background: transparent;
  color: var(--app-muted);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.draft-preview__tab:hover {
  background: color-mix(in srgb, var(--app-text) 6%, transparent);
  color: var(--app-text);
}

.draft-preview__tab--active {
  border-bottom-color: var(--app-accent);
  color: var(--app-accent);
}

.draft-preview__tab-count {
  border-radius: 999px;
  padding: 0 7px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
  font-size: 11px;
  line-height: 18px;
}

.draft-preview__tab--active .draft-preview__tab-count {
  background: color-mix(in srgb, var(--app-accent) 18%, transparent);
  color: var(--app-accent);
}

.draft-preview__body {
  display: grid;
  gap: 18px;
  max-height: min(76vh, 820px);
  overflow: auto;
  padding: 16px 20px;
}

.draft-preview__section {
  display: grid;
  gap: 8px;
}

.draft-preview__section h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  color: var(--app-text);
  font-size: 13px;
  font-weight: 700;
}

.draft-preview__section h4 small,
.draft-preview__reference-label small {
  border-radius: 999px;
  padding: 0 7px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
}

.draft-preview__kv-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.draft-preview__kv {
  display: grid;
  gap: 4px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 9px 11px;
  background: var(--app-panel-bg);
}

.draft-preview__kv--wide {
  grid-column: 1 / -1;
}

.draft-preview__kv span {
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}

.draft-preview__kv p {
  margin: 0;
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}

.draft-preview__pre {
  margin: 0;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 10px 12px;
  max-height: 460px;
  overflow: auto;
  background: color-mix(in srgb, var(--app-text) 4%, var(--app-panel-bg));
  color: var(--app-text);
  font: inherit;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.draft-preview__pre--compact {
  max-height: 360px;
}

.draft-preview__field-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.draft-preview__field-list li {
  display: grid;
  gap: 5px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 9px 11px;
  background: var(--app-panel-bg);
}

.draft-preview__field-list p {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.draft-preview__sub-field {
  display: grid;
  gap: 4px;
}

.draft-preview__sub-label {
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}

.draft-preview__spec-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px 16px;
  margin: 0;
}

.draft-preview__spec-grid > div {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.draft-preview__spec-grid dt {
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}

.draft-preview__spec-grid dd {
  margin: 0;
  color: var(--app-text);
  font-size: 12px;
  font-weight: 600;
  word-break: break-word;
}

.draft-preview__field-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.draft-preview__field-head strong {
  color: var(--app-text);
  font-size: 12px;
}

.draft-preview__field-head code,
.draft-preview__path-list code,
.draft-preview__field-list code {
  border-radius: 5px;
  padding: 1px 6px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
  font-size: 11px;
  word-break: break-all;
}

.draft-preview__badge {
  border-radius: 999px;
  padding: 2px 8px;
  background: color-mix(in srgb, var(--app-text) 8%, transparent);
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}

.draft-preview__badge--accent {
  background: color-mix(in srgb, var(--app-accent) 14%, transparent);
  color: var(--app-accent);
}

.draft-preview__badge--missing {
  background: color-mix(in srgb, var(--app-danger) 15%, transparent);
  color: var(--app-danger);
}

.draft-preview__badge--added {
  background: color-mix(in srgb, var(--app-success) 15%, transparent);
  color: var(--app-success);
}

.draft-preview__badge--modified {
  background: color-mix(in srgb, var(--app-warning) 16%, transparent);
  color: var(--app-warning);
}

.draft-preview__badge--removed {
  background: color-mix(in srgb, var(--app-danger) 15%, transparent);
  color: var(--app-danger);
}

.draft-preview__chip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.draft-preview__empty-line {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.draft-preview__meta-line {
  margin: 0;
  color: var(--app-muted);
  font-size: 12px;
}

.draft-preview__paragraph {
  margin: 0;
  color: var(--app-text);
  font-size: 13px;
  line-height: 1.7;
  word-break: break-word;
}

.draft-preview__bullet-list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.draft-preview__diff-list {
  display: grid;
  gap: 10px;
}

.draft-preview__diff-item {
  display: grid;
  gap: 7px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--app-panel-bg);
}

.draft-preview__diff-value {
  display: grid;
  gap: 4px;
}

.draft-preview__diff-value > span {
  color: var(--app-muted);
  font-size: 11px;
  font-weight: 600;
}

.draft-preview__diff-value pre {
  margin: 0;
  border-radius: 7px;
  padding: 8px 10px;
  max-height: 340px;
  overflow: auto;
  font: inherit;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.draft-preview__diff-value--before pre {
  border: 1px solid color-mix(in srgb, var(--app-danger) 38%, transparent);
  background: color-mix(in srgb, var(--app-danger) 10%, transparent);
  color: var(--app-text);
}

.draft-preview__diff-value--after pre {
  border: 1px solid color-mix(in srgb, var(--app-success) 38%, transparent);
  background: color-mix(in srgb, var(--app-success) 10%, transparent);
  color: var(--app-text);
}

.draft-preview__reference-group {
  display: grid;
  gap: 6px;
}

.draft-preview__reference-group + .draft-preview__reference-group {
  margin-top: 4px;
}

.draft-preview__reference-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--app-muted);
  font-size: 12px;
  font-weight: 600;
}

.draft-preview__path-list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.draft-preview__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--app-border);
  padding: 12px 20px;
}

.draft-preview__footer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.draft-preview__footer-issue {
  border-radius: 999px;
  padding: 2px 9px;
  background: color-mix(in srgb, var(--app-warning) 16%, transparent);
  color: var(--app-warning);
  font-size: 12px;
  font-weight: 600;
}

.draft-preview__footer-issue--error {
  background: color-mix(in srgb, var(--app-danger) 15%, transparent);
  color: var(--app-danger);
}

.draft-preview__footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.draft-preview__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 0 14px;
  background: var(--app-panel-bg);
  color: var(--app-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.draft-preview__btn--primary {
  border-color: var(--app-accent);
  background: var(--app-accent);
  color: #fff;
}

.draft-preview__btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
