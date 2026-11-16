<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { CopyOutlined, DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { canMaintainBuiltinSpecAssets, type ToolDefinition, type ToolEnvPolicy, type ToolsetDefinition, type ToolsetId, type WorkspaceId } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useOrchAssetDirtyState } from "../composables/useOrchAssetDirtyState";

defineOptions({ name: "ToolsetForm" });

const props = defineProps<{
  workspaceId: WorkspaceId;
  toolsetId: ToolsetId;
  sourceDefinition?: ToolsetDefinition | null;
  saveLabel?: string;
  /** 无工作区只读预览：强制只读，且不触发展示以外的任何请求。 */
  previewReadonly?: boolean;
}>();
const emit = defineEmits<{ (event: "dirty-change", dirty: boolean): void }>();

const orch = useOrchestrationStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const form = ref<Omit<ToolsetDefinition, "createdAt" | "updatedAt"> | null>(null);
const extraEnvDrafts = ref<Record<string, string>>({});
const toolSearchText = ref("");
const selectedToolId = ref("");
const editorOpen = ref(false);
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
  || orch.isServerAuthoritativeBuiltinAsset("toolset", String(props.toolsetId ?? ""))
  || (form.value?.kind === "builtin" && !canMaintainBuiltinSpecAssets(permissionInput.value)));
const { hasUnsavedChanges, isDirty, markCleanFromCurrentDraft } = useOrchAssetDirtyState(() => ({
  form: form.value,
  extraEnvDrafts: extraEnvDrafts.value,
}));
watch(isDirty, (dirty) => emit("dirty-change", dirty), { immediate: true });
const modalBodyStyle = {
  maxHeight: "calc(100vh - 220px)",
  overflowY: "auto",
  paddingRight: "20px",
} as const;

const filteredTools = computed(() => {
  if (!form.value) return [];
  const keyword = toolSearchText.value.trim().toLowerCase();
  return form.value.tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => {
      if (!keyword) return true;
      return [
        tool.name,
        tool.id,
        tool.description,
        tool.runtime,
        tool.workingDirectory,
      ].some((value) => String(value ?? "").toLowerCase().includes(keyword));
    });
});

const activeToolIndex = computed(() => {
  if (!form.value?.tools.length) return -1;
  const selectedIndex = form.value.tools.findIndex((tool) => tool.id === selectedToolId.value);
  return selectedIndex >= 0 ? selectedIndex : 0;
});

const activeTool = computed(() => {
  if (!form.value || activeToolIndex.value < 0) return null;
  return form.value.tools[activeToolIndex.value] ?? null;
});

watch([() => props.toolsetId, () => props.sourceDefinition], ([toolsetId, sourceDefinition]) => {
  const toolset = sourceDefinition ?? orch.toolsets.find((item) => item.id === toolsetId);
  form.value = toolset ? cloneToolset(toolset) : null;
  toolSearchText.value = "";
  syncExtraEnvDrafts(form.value);
  markCleanFromCurrentDraft();
  ensureSelectedTool();
  editorOpen.value = false;
}, { immediate: true });

watch(() => form.value?.tools.map((tool) => tool.id).join("|") ?? "", () => {
  ensureSelectedTool();
  if (!(form.value?.tools.length ?? 0)) editorOpen.value = false;
});

/** 保存工具集定义；内置资产只允许超管提交变更。 */
async function onSave(): Promise<boolean> {
  if (!form.value) return false;
  if (isBuiltinReadonly.value) {
    message.info("内置工具仅超管可修改");
    return false;
  }
  try {
    const normalized = normalizeToolset(form.value);
    await orch.saveToolset(ctx.value, props.workspaceId, normalized);
    markCleanFromCurrentDraft();
    message.success("工具已保存");
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
    return false;
  }
}

/** 父级资产切换守卫调用的保存入口，失败时返回 false 阻止切换。 */
async function saveCurrentDraft(): Promise<boolean> {
  return onSave();
}

/** 放弃当前未保存工具草稿，并恢复为 store 中最近保存态。 */
function discardUnsavedChanges(): void {
  const toolset = props.sourceDefinition ?? orch.toolsets.find((item) => item.id === props.toolsetId);
  form.value = toolset ? cloneToolset(toolset) : null;
  toolSearchText.value = "";
  syncExtraEnvDrafts(form.value);
  ensureSelectedTool();
  editorOpen.value = false;
  markCleanFromCurrentDraft();
}

defineExpose({
  hasUnsavedChanges,
  saveCurrentDraft,
  discardUnsavedChanges,
});

async function onSaveAndCloseEditor() {
  const saved = await onSave();
  if (saved) closeEditor();
}

function ensureSelectedTool() {
  const tools = form.value?.tools ?? [];
  if (!tools.length) {
    selectedToolId.value = "";
    return;
  }
  if (tools.some((tool) => tool.id === selectedToolId.value)) return;
  selectedToolId.value = tools[0].id;
}

function selectTool(toolId: string) {
  selectedToolId.value = toolId;
  editorOpen.value = true;
}

function closeEditor() {
  editorOpen.value = false;
}

/** 新增工具；内置只读详情不允许改变工具集合。 */
function addTool() {
  if (!form.value || isBuiltinReadonly.value) return;
  const tool = createTool();
  form.value.tools.push(tool);
  extraEnvDrafts.value[tool.id] = "";
  selectedToolId.value = tool.id;
  editorOpen.value = true;
}

/** 复制当前工具；仅自定义工具集允许生成新项。 */
function duplicateActiveTool() {
  if (!form.value || !activeTool.value || isBuiltinReadonly.value) return;
  const source = activeTool.value;
  const duplicated = {
    ...cloneTool(source),
    id: buildDuplicateToolId(source.id),
    name: source.name?.trim() ? `${source.name}（副本）` : "新工具（副本）",
  } satisfies ToolDefinition;
  form.value.tools.splice(activeToolIndex.value + 1, 0, duplicated);
  extraEnvDrafts.value[duplicated.id] = source.id ? envDraftValue(source.id) : "";
  selectedToolId.value = duplicated.id;
  editorOpen.value = true;
}

/** 删除工具项；内置工具集直接拒绝结构变更。 */
function removeTool(index: number) {
  if (!form.value || isBuiltinReadonly.value) return;
  const [removed] = form.value.tools.splice(index, 1);
  if (removed?.id) delete extraEnvDrafts.value[removed.id];
  ensureSelectedTool();
}

/** 删除当前选中工具，并同步关闭空编辑器。 */
function removeActiveTool() {
  if (activeToolIndex.value < 0 || isBuiltinReadonly.value) return;
  removeTool(activeToolIndex.value);
  editorOpen.value = Boolean(form.value?.tools.length);
}

function cloneToolset(toolset: ToolsetDefinition): Omit<ToolsetDefinition, "createdAt" | "updatedAt"> {
  return {
    id: toolset.id,
    workspaceId: toolset.workspaceId,
    name: toolset.name,
    description: toolset.description,
    tools: toolset.tools.map((tool) => cloneTool(tool)),
    kind: toolset.kind,
  };
}

function cloneTool(tool: ToolDefinition): ToolDefinition {
  return {
    id: tool.id,
    name: tool.name,
    description: tool.description,
    runtime: tool.runtime,
    invocationHint: tool.invocationHint,
    code: tool.code,
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    timeoutMs: tool.timeoutMs ?? null,
    workingDirectory: tool.workingDirectory ?? null,
    requiresWrite: Boolean(tool.requiresWrite),
    envPolicy: tool.envPolicy
      ? {
          inheritWorkspaceEnv: tool.envPolicy.inheritWorkspaceEnv !== false,
          extraEnv: tool.envPolicy.extraEnv ? { ...tool.envPolicy.extraEnv } : null,
        }
      : null,
  };
}

function createTool(): ToolDefinition {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id: `tool-${stamp}`,
    name: "新工具",
    description: "",
    runtime: "shell",
    invocationHint: "",
    code: "",
    inputSchema: "",
    outputSchema: "",
    timeoutMs: 15_000,
    workingDirectory: ".",
    requiresWrite: false,
    envPolicy: { inheritWorkspaceEnv: true, extraEnv: null },
  };
}

function buildDuplicateToolId(sourceId: string): string {
  const base = String(sourceId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "tool";
  return `${base}-copy-${Math.random().toString(36).slice(2, 6)}`;
}

/** Normalizes editable tool fields while preserving the definition ownership kind. */
function normalizeToolset(toolset: Omit<ToolsetDefinition, "createdAt" | "updatedAt">): Omit<ToolsetDefinition, "createdAt" | "updatedAt"> {
  return {
    id: toolset.id,
    workspaceId: toolset.workspaceId,
    name: toolset.name.trim() || "未命名工具",
    description: toolset.description.trim(),
    kind: toolset.kind,
    tools: toolset.tools.map((tool, index) => ({
      id: tool.id.trim() || `tool-${index + 1}`,
      name: tool.name.trim() || `工具 ${index + 1}`,
      description: tool.description.trim(),
      runtime: tool.runtime,
      invocationHint: tool.invocationHint.trim(),
      code: tool.code.replace(/\r\n/g, "\n"),
      inputSchema: tool.inputSchema?.trim() || null,
      outputSchema: tool.outputSchema?.trim() || null,
      timeoutMs: Number.isFinite(Number(tool.timeoutMs)) ? Number(tool.timeoutMs) : null,
      workingDirectory: tool.workingDirectory?.trim() || null,
      requiresWrite: Boolean(tool.requiresWrite),
      envPolicy: normalizeToolEnvPolicy(tool),
    })),
  };
}

function syncExtraEnvDrafts(toolset: Omit<ToolsetDefinition, "createdAt" | "updatedAt"> | null) {
  if (!toolset) {
    extraEnvDrafts.value = {};
    return;
  }
  const next: Record<string, string> = {};
  for (const tool of toolset.tools) {
    next[tool.id] = tool.envPolicy?.extraEnv
      ? JSON.stringify(tool.envPolicy.extraEnv, null, 2)
      : "";
  }
  extraEnvDrafts.value = next;
}

function ensureEnvPolicy(tool: ToolDefinition): ToolEnvPolicy {
  if (!tool.envPolicy) {
    tool.envPolicy = {
      inheritWorkspaceEnv: true,
      extraEnv: null,
    };
  }
  if (tool.envPolicy.inheritWorkspaceEnv === undefined) {
    tool.envPolicy.inheritWorkspaceEnv = true;
  }
  return tool.envPolicy;
}

function envDraftValue(toolId: string): string {
  return extraEnvDrafts.value[toolId] ?? "";
}

function onExtraEnvDraftInput(toolId: string, event: Event) {
  extraEnvDrafts.value[toolId] = String((event.target as HTMLTextAreaElement | null)?.value ?? "");
}

function normalizeToolEnvPolicy(tool: ToolDefinition): ToolEnvPolicy | null {
  const policy = tool.envPolicy ?? { inheritWorkspaceEnv: true, extraEnv: null };
  const rawText = String(extraEnvDrafts.value[tool.id] ?? "").trim();
  if (!rawText) {
    return {
      inheritWorkspaceEnv: policy.inheritWorkspaceEnv !== false,
      extraEnv: null,
    };
  }
  try {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("额外环境变量必须是 JSON 对象");
    }
    const extraEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const envKey = String(key ?? "").trim();
      if (!envKey) continue;
      extraEnv[envKey] = String(value ?? "");
    }
    return {
      inheritWorkspaceEnv: policy.inheritWorkspaceEnv !== false,
      extraEnv: Object.keys(extraEnv).length ? extraEnv : null,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? `工具 ${tool.name || tool.id} 的额外环境变量无效：${error.message}` : `工具 ${tool.name || tool.id} 的额外环境变量无效`);
  }
}

/** 填充调用说明模板；只对可维护资产写入草稿。 */
function fillInvocationHintTemplate(tool: ToolDefinition) {
  if (isBuiltinReadonly.value) return;
  tool.invocationHint = buildInvocationHintTemplate(tool);
}

function buildInvocationHintTemplate(tool: ToolDefinition): string {
  const runtime = String(tool.runtime ?? "shell");
  return [
    `适用场景：当需要通过 ${runtime} 能力完成“${tool.name || tool.id}”这类平台补充动作，且引擎原生 Bash/Read/Glob/Edit 本身不具备这项能力时，优先使用该工具。`,
    "不要使用：如果只是读文件、列目录、搜索代码、执行普通命令或跑通用测试，直接用引擎原生能力即可，不要为了走平台工具再包一层。",
    "输入要求：调用前先确认目标、范围和必要参数已经明确；信息不足时先补充上下文，不要盲调。",
    "调用后：成功时先总结结果并进入下一步；失败时先说明原因，再决定重试、降级到原生能力，还是向用户请求更多信息。",
  ].join("\n");
}

function summarizeTool(tool: ToolDefinition): string {
  const parts = [
    String(tool.runtime ?? "").trim(),
    tool.workingDirectory ? `目录 ${tool.workingDirectory}` : "",
    tool.requiresWrite ? "会写工作区" : "默认只读",
    tool.envPolicy?.inheritWorkspaceEnv === false ? "不继承环境变量" : "",
  ].filter(Boolean);
  return parts.join(" · ");
}
</script>

<template>
  <div v-if="form" class="toolset-form">
    <div class="toolset-form__header">
      <div>
        <h3>{{ form.name || "未命名工具" }}</h3>
        <p class="toolset-form__subhead">把一组平台工具集中维护，Agent 只需要多选引用，不用反复在角色页里配置细节。</p>
      </div>
      <button class="toolset-form__save-btn" type="button" :disabled="isBuiltinReadonly" @click="onSave">
        <SaveOutlined /> {{ props.saveLabel || "保存" }}
      </button>
      <span v-if="isBuiltinReadonly" class="toolset-form__readonly-badge">内置只读</span>
    </div>

    <div class="toolset-form__grid">
      <label class="toolset-form__field">
        <span>工具名称</span>
        <input v-model="form.name" class="toolset-form__input" :disabled="isBuiltinReadonly" />
      </label>
      <label class="toolset-form__field toolset-form__field--full">
        <span>描述</span>
        <textarea v-model="form.description" class="toolset-form__textarea" rows="2" :disabled="isBuiltinReadonly" />
      </label>
    </div>

    <div class="toolset-form__hint">
      <strong>维护建议</strong>
      <span>工具只放平台补充能力，不要把引擎原生 Bash / Read / Glob / Edit 能直接完成的动作再包一层。</span>
    </div>

    <div class="toolset-form__workspace">
      <section class="toolset-form__navigator">
        <div class="toolset-form__navigator-head">
          <div>
            <strong>工具清单</strong>
            <span class="toolset-form__count-badge">{{ form.tools.length }} 个工具</span>
          </div>
          <div class="toolset-form__navigator-actions">
            <button class="toolset-form__ghost-btn" type="button" :disabled="!activeTool || isBuiltinReadonly" @click="duplicateActiveTool">
              <CopyOutlined /> 复制当前工具
            </button>
            <button class="toolset-form__add-btn" type="button" :disabled="isBuiltinReadonly" @click="addTool">
              <PlusOutlined /> 添加工具
            </button>
          </div>
        </div>

        <input v-model="toolSearchText" class="toolset-form__input" placeholder="搜索工具名称 / ID / 描述..." />

        <div v-if="filteredTools.length" class="toolset-form__tool-nav-list">
          <button
            v-for="entry in filteredTools"
            :key="entry.tool.id || entry.index"
            class="toolset-form__tool-nav-item"
            :class="{ 'toolset-form__tool-nav-item--active': entry.tool.id === activeTool?.id }"
            type="button"
            @click="selectTool(entry.tool.id)"
          >
            <div class="toolset-form__tool-nav-head">
              <strong>{{ entry.tool.name || `工具 ${entry.index + 1}` }}</strong>
              <span class="toolset-form__tool-nav-runtime">{{ entry.tool.runtime }}</span>
            </div>
            <p>{{ entry.tool.description || "还没有填写用途说明" }}</p>
            <div class="toolset-form__tool-nav-meta">
              <span>{{ entry.tool.timeoutMs ? `${entry.tool.timeoutMs}ms` : "无超时" }}</span>
              <span>{{ entry.tool.requiresWrite ? "可写" : "只读" }}</span>
              <span>{{ entry.tool.workingDirectory ? `目录 ${entry.tool.workingDirectory}` : "默认目录" }}</span>
            </div>
          </button>
        </div>
        <div v-else class="toolset-form__empty toolset-form__empty--compact">没有匹配的工具。</div>
      </section>

      <div class="toolset-form__workspace-note">
        <strong>编辑方式</strong>
        <span>点击上方工具卡会弹出编辑窗口；新增或复制工具后也会自动进入弹框。真正落库仍以右上角“保存”为准。</span>
      </div>
    </div>

    <a-modal
      :open="editorOpen"
      :width="980"
      :body-style="modalBodyStyle"
      wrap-class-name="orch-asset-modal orch-asset-editor-modal toolset-form__editor-dialog"
      title="编辑工具"
      @cancel="closeEditor"
    >
      <template #footer>
        <div v-if="activeTool" class="toolset-form__dialog-footer">
          <button class="toolset-form__delete-btn" type="button" :disabled="isBuiltinReadonly" @click="removeActiveTool">
            <DeleteOutlined /> 删除当前工具
          </button>
          <div class="toolset-form__dialog-footer-actions">
            <button class="toolset-form__ghost-btn" type="button" @click="closeEditor">关闭</button>
            <button class="toolset-form__save-btn" type="button" :disabled="isBuiltinReadonly" @click="onSaveAndCloseEditor">
              <SaveOutlined /> 保存工具
            </button>
          </div>
        </div>
      </template>

      <fieldset v-if="activeTool" :disabled="isBuiltinReadonly" class="toolset-form__readonly-fieldset toolset-form__modal">
        <div class="toolset-form__modal-note">
          <strong>当前是草稿编辑</strong>
          <span>这里的修改会先保存在当前工具草稿里。关闭弹框后，记得再点页面右上角“保存”。</span>
        </div>

        <div class="toolset-form__editor-head">
          <div>
            <span class="toolset-form__editor-eyebrow">当前工具</span>
            <h4>{{ activeTool.name || "未命名工具" }}</h4>
            <p>{{ summarizeTool(activeTool) || "在这里维护当前工具的用途、输入输出和执行源码。" }}</p>
          </div>
        </div>

        <div class="toolset-form__chips">
          <span>{{ activeTool.runtime }}</span>
          <span>{{ activeTool.timeoutMs ? `${activeTool.timeoutMs}ms` : "无超时" }}</span>
          <span>{{ activeTool.requiresWrite ? "需要写入" : "不写工作区" }}</span>
          <span>{{ ensureEnvPolicy(activeTool).inheritWorkspaceEnv ? "继承环境变量" : "独立环境变量" }}</span>
        </div>

        <div class="toolset-form__tool-grid">
          <label class="toolset-form__field">
            <span>工具 ID</span>
            <input v-model="activeTool.id" class="toolset-form__input" placeholder="tool-build-report" />
          </label>
          <label class="toolset-form__field">
            <span>工具名称</span>
            <input v-model="activeTool.name" class="toolset-form__input" placeholder="生成测试报告" />
          </label>
          <label class="toolset-form__field">
            <span>运行时</span>
            <select v-model="activeTool.runtime" class="toolset-form__select">
              <option value="shell">shell</option>
              <option value="python">python</option>
              <option value="node">node</option>
              <option value="java">java</option>
              <option value="prompt">prompt（历史兼容，不可执行）</option>
            </select>
          </label>
          <label class="toolset-form__field">
            <span>超时（毫秒）</span>
            <input v-model.number="activeTool.timeoutMs" type="number" class="toolset-form__input" min="0" />
          </label>
          <label class="toolset-form__field toolset-form__field--full">
            <span>描述</span>
            <textarea v-model="activeTool.description" class="toolset-form__textarea" rows="2" placeholder="一句话说明这个工具在补什么能力。" />
          </label>
        </div>

        <details class="toolset-form__section" open>
          <summary>调用说明</summary>
          <div class="toolset-form__section-body">
            <div class="toolset-form__section-toolbar">
              <span class="toolset-form__section-caption">这里重点写“什么时候该用 / 不该用 / 调用成功后下一步是什么”。</span>
              <button class="toolset-form__ghost-btn" type="button" @click="fillInvocationHintTemplate(activeTool)">填充示例</button>
            </div>
            <label class="toolset-form__field">
              <span>通用使用策略与边界</span>
              <textarea
                v-model="activeTool.invocationHint"
                class="toolset-form__textarea"
                rows="6"
                placeholder="建议直接写自然语言：
1. 什么时候优先使用这个工具
2. 什么时候不要使用，改用引擎原生 Bash/Read/Glob 等能力
3. 输入里至少要提供什么信息
4. 调用成功后模型下一步应该做什么"
              />
              <small class="toolset-form__field-help">这里写工具本身的通用规则。某个角色的特殊限制，请去角色页里的“角色额外要求”填写。</small>
            </label>
          </div>
        </details>

        <details class="toolset-form__section">
          <summary>输入输出</summary>
          <div class="toolset-form__section-body">
            <div class="toolset-form__section-note">
              <strong>什么时候需要填写</strong>
              <span>只有当这个工具必须接收稳定 JSON 参数，或必须返回稳定 JSON 结果时，再写下面两项。否则留空，让模型按自然语言自己组织即可。</span>
            </div>
            <div class="toolset-form__tool-grid">
              <label class="toolset-form__field">
                <span>输入格式(JSON，可选)</span>
                <textarea v-model="activeTool.inputSchema" class="toolset-form__textarea" rows="4" placeholder='{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}' />
                <small class="toolset-form__field-help">定义平台执行器真正要接收的参数结构。留空表示不强制固定参数格式。</small>
              </label>
              <label class="toolset-form__field">
                <span>返回格式(JSON，可选)</span>
                <textarea v-model="activeTool.outputSchema" class="toolset-form__textarea" rows="4" placeholder='{"type":"object","properties":{"summary":{"type":"string"}}}' />
                <small class="toolset-form__field-help">定义平台执行器预期返回的结构，便于角色稳定读取结果。留空表示不强制固定返回格式。</small>
              </label>
            </div>
          </div>
        </details>

        <details class="toolset-form__section" open>
          <summary>运行环境</summary>
          <div class="toolset-form__section-body">
            <div class="toolset-form__section-note">
              <strong>这里决定什么</strong>
              <span>这里只配置执行器实际运行时的目录、环境变量和写入权限。不要把“引擎原生 Bash / Read / Glob 能否做到”混进来。</span>
            </div>
            <div class="toolset-form__tool-grid">
              <label class="toolset-form__field toolset-form__field--full">
                <span>工作目录（相对 workspace，可选）</span>
                <input v-model="activeTool.workingDirectory" class="toolset-form__input" placeholder="例如：. 或 scripts。运行时会真正切换到这里执行。" />
                <small class="toolset-form__field-help">工具执行前会先切到这里。适合脚本、构建目录或子模块项目。</small>
              </label>
              <label class="toolset-form__field toolset-form__field--full">
                <span>额外环境变量（JSON，可选）</span>
                <textarea
                  :value="envDraftValue(activeTool.id)"
                  class="toolset-form__textarea"
                  rows="4"
                  placeholder='{"REPORT_PATH":"codeflowai/reports/latest.json","NODE_ENV":"test"}'
                  @input="onExtraEnvDraftInput(activeTool.id, $event)"
                />
                <small class="toolset-form__field-help">这里补充当前工具独有的环境变量；不适合存放密钥或大量业务配置。</small>
              </label>
            </div>
            <div class="toolset-form__toggles">
              <label><input v-model="activeTool.requiresWrite" type="checkbox" /> 会修改工作区文件</label>
              <label><input :checked="ensureEnvPolicy(activeTool).inheritWorkspaceEnv" type="checkbox" @change="ensureEnvPolicy(activeTool).inheritWorkspaceEnv = Boolean(($event.target as HTMLInputElement).checked)" /> 继承当前环境变量</label>
            </div>
            <div class="toolset-form__toggle-help">
              <span>`会修改工作区文件` 会参与权限校验，并要求角色访问模式至少允许写入。</span>
              <span>`继承当前环境变量` 表示工具进程会继承当前客户端进程里的环境变量；关闭后只保留您在这里显式填写的变量。</span>
            </div>
          </div>
        </details>

        <details class="toolset-form__section" open>
          <summary>工具源码</summary>
          <div class="toolset-form__section-body">
            <label class="toolset-form__field">
              <span>工具源码</span>
              <textarea v-model="activeTool.code" class="toolset-form__textarea toolset-form__textarea--code" rows="14" placeholder="这里填写 shell/python/node/java 源码。编排运行时会按运行时类型实际执行。" />
            </label>
          </div>
        </details>
      </fieldset>
    </a-modal>
  </div>

  <div v-else class="toolset-form__empty">从左侧选择一个工具查看详情，或先新建一个工具。</div>
</template>

<style scoped>
.toolset-form {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  padding-bottom: 12px;
}

.toolset-form__header,
.toolset-form__navigator-head,
.toolset-form__section-toolbar,
.toolset-form__editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toolset-form__header {
  margin-bottom: 14px;
}
.toolset-form__readonly-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.toolset-form__readonly-badge { color: var(--app-muted, #666); font-size: 12px; white-space: nowrap; }

.toolset-form__header h3,
.toolset-form__navigator-head strong,
.toolset-form__editor-head h4 {
  margin: 0;
}

.toolset-form__subhead,
.toolset-form__editor-head p,
.toolset-form__editor-eyebrow {
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__subhead,
.toolset-form__editor-head p {
  margin: 4px 0 0;
}

.toolset-form__editor-eyebrow {
  display: inline-flex;
  margin: 0 0 6px;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent, #c96442) 72%, #1f2937);
  font-weight: 600;
}

.toolset-form__save-btn,
.toolset-form__add-btn,
.toolset-form__ghost-btn,
.toolset-form__delete-btn {
  min-height: 34px;
  padding: 6px 14px;
  border-radius: 10px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease, background-color 0.16s ease;
}

.toolset-form__save-btn:hover,
.toolset-form__add-btn:hover,
.toolset-form__ghost-btn:hover,
.toolset-form__delete-btn:hover {
  transform: translateY(-1px);
}

.toolset-form__save-btn {
  border: none;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent,#c96442) 90%, #d97757), color-mix(in srgb, var(--app-accent,#c96442) 96%, #bb5737));
  color: #fff;
  box-shadow: 0 12px 24px rgba(201,100,66,0.18);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.toolset-form__save-btn:not(:disabled):hover {
  filter: brightness(1.05);
  box-shadow: 0 14px 28px rgba(201,100,66,0.26);
}
.toolset-form__save-btn:not(:disabled):active {
  transform: translateY(0) scale(0.98);
  filter: brightness(0.94);
  box-shadow: 0 6px 12px rgba(201,100,66,0.16);
}
.toolset-form__save-btn:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-accent,#c96442) 28%, transparent);
  outline-offset: 2px;
}

.toolset-form__add-btn {
  border: 1px solid color-mix(in srgb, var(--app-accent, #c96442) 28%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent, #c96442) 8%, #fff);
  color: var(--app-accent, #c96442);
}

.toolset-form__ghost-btn {
  border: 1px solid var(--app-border, #d9d9d9);
  background: color-mix(in srgb, var(--app-bg, #fff) 90%, #f5f7fb);
  color: var(--app-muted, #666);
}

.toolset-form__delete-btn {
  border: 1px solid color-mix(in srgb, #ff4d4f 35%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, #ff4d4f 6%, var(--app-bg, #fff));
  color: #ff4d4f;
}

.toolset-form__grid,
.toolset-form__tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.toolset-form__grid {
  margin-bottom: 16px;
}

.toolset-form__hint {
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent, #c96442) 12%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-accent, #c96442) 6%, #fff), var(--app-bg, #fff));
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.toolset-form__hint strong {
  color: var(--app-text, #1f2937);
}

.toolset-form__hint span {
  flex: 1 1 420px;
}

.toolset-form__section-note {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent, #c96442) 10%, var(--app-border, #e8e8e8));
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 5%, #fff);
  font-size: 12px;
  line-height: 1.7;
  color: var(--app-muted, #666);
}

.toolset-form__section-note strong {
  color: var(--app-text, #1f2937);
}

.toolset-form__section-note span {
  flex: 1 1 420px;
}

.toolset-form__workspace {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.toolset-form__navigator {
  min-height: 0;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  background: var(--app-bg, #fff);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.04);
}

.toolset-form__navigator {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent, #c96442) 4%, #fff), var(--app-bg, #fff));
}

.toolset-form__navigator-head > div:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
}

.toolset-form__navigator-actions {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}

.toolset-form__count-badge {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent, #c96442) 72%, #1f2937);
  font-size: 12px;
  font-weight: 600;
}

.toolset-form__tool-nav-list {
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 10px;
  overflow: auto;
  min-height: 0;
  max-height: 188px;
}

.toolset-form__tool-nav-item {
  flex: 0 1 240px;
  max-width: 280px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 92%, #f7f9fc), var(--app-bg, #fff));
  min-height: 74px;
  padding: 12px 13px;
  text-align: left;
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.toolset-form__tool-nav-item:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 24%, var(--app-border, #e8e8e8));
  box-shadow: 0 10px 22px rgba(15, 23, 42, 0.06);
}

.toolset-form__tool-nav-item--active {
  border-color: var(--app-accent, #c96442);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-accent, #c96442) 12%, #fff), var(--app-bg, #fff));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-accent, #c96442) 22%, transparent), 0 12px 28px color-mix(in srgb, var(--app-accent, #c96442) 14%, transparent);
}

.toolset-form__tool-nav-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.toolset-form__tool-nav-head strong {
  font-size: 13px;
  line-height: 1.35;
}

.toolset-form__tool-nav-runtime {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent, #c96442) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent, #c96442) 72%, #1f2937);
  font-size: 11px;
  font-weight: 600;
}

.toolset-form__tool-nav-item p,
.toolset-form__tool-nav-meta span {
  font-size: 11px;
  color: var(--app-muted, #666);
}

.toolset-form__tool-nav-item p {
  margin: 0;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.toolset-form__tool-nav-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.toolset-form__tool-nav-meta span {
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-bg, #fff) 88%, #eef2f7);
}

.toolset-form__workspace-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 14px;
  border: 1px dashed color-mix(in srgb, var(--app-accent, #c96442) 20%, var(--app-border, #d9d9d9));
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg, #fff) 92%, #f7f9fc);
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__workspace-note strong,
.toolset-form__modal-note strong {
  color: var(--app-text, #1f2937);
}

.toolset-form__workspace-note span,
.toolset-form__modal-note span {
  flex: 1 1 360px;
}

.toolset-form__modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
}

.toolset-form__modal .toolset-form__field {
  gap: 8px;
}

.toolset-form__modal .toolset-form__field span {
  color: color-mix(in srgb, var(--app-text, #1f2937) 76%, #6f553d);
  font-weight: 700;
}

.toolset-form__modal .toolset-form__input,
.toolset-form__modal .toolset-form__select,
.toolset-form__modal .toolset-form__textarea {
  border: 1px solid var(--orch-asset-modal-control-border, var(--app-border, #d9d9d9));
  border-radius: 12px;
  background: var(--orch-asset-modal-control-bg, var(--app-panel-bg, #fff));
  box-shadow: var(--orch-asset-modal-control-shadow, none);
}

.toolset-form__modal .toolset-form__input:hover,
.toolset-form__modal .toolset-form__select:hover,
.toolset-form__modal .toolset-form__textarea:hover {
  border-color: var(--orch-asset-modal-control-border-hover, color-mix(in srgb, var(--app-accent, #c96442) 28%, var(--app-border, #d9d9d9)));
  background: var(--orch-asset-modal-control-bg-hover, var(--app-panel-bg, #fff));
  box-shadow: var(--orch-asset-modal-control-shadow-hover, none);
}

.toolset-form__modal .toolset-form__input::placeholder,
.toolset-form__modal .toolset-form__textarea::placeholder {
  color: color-mix(in srgb, var(--app-muted, #666) 72%, #a49382);
}

.toolset-form__modal-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, var(--app-accent, #c96442) 14%, var(--app-border, #e8e8e8));
  border-radius: 14px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--app-accent, #c96442) 6%, #fff), var(--app-bg, #fff));
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__editor-head {
  align-items: flex-start;
  padding-bottom: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 80%, transparent);
}

.toolset-form__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.toolset-form__chips span {
  padding: 5px 10px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-bg, #fff) 80%, #edf2f7);
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__section {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg, #fff) 82%, #f8fafc);
  overflow: hidden;
}

.toolset-form__section summary {
  cursor: pointer;
  padding: 14px 16px;
  font-weight: 600;
  list-style: none;
  background: color-mix(in srgb, var(--app-bg, #fff) 76%, #f4f7fb);
}

.toolset-form__section summary::-webkit-details-marker {
  display: none;
}

.toolset-form__section-body {
  padding: 14px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.toolset-form__section-caption {
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.toolset-form__field--full {
  grid-column: 1 / -1;
}

.toolset-form__field span {
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__field-help {
  font-size: 11px;
  line-height: 1.6;
  color: var(--app-muted, #7a8699);
}

.toolset-form__input,
.toolset-form__select,
.toolset-form__textarea {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-bg, #fff) 84%, #f5f7fb);
  color: var(--app-text, #333);
  transition: border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease;
}

.toolset-form__input:focus,
.toolset-form__select:focus,
.toolset-form__textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--app-accent, #c96442) 45%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent, #c96442) 14%, transparent);
  background: var(--app-bg, #fff);
}

.toolset-form__textarea {
  resize: vertical;
  min-height: 88px;
}

.toolset-form__textarea--code {
  min-height: 320px;
  font-family: monospace;
}

.toolset-form__toggles {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.toolset-form__toggle-help {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--app-muted, #7a8699);
}

.toolset-form__empty {
  padding: 48px;
  text-align: center;
  color: var(--app-muted, #999);
}

.toolset-form__empty--compact {
  padding: 20px 12px;
}

.toolset-form__modal-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.toolset-form__modal-actions span {
  font-size: 12px;
  color: var(--app-muted, #666);
}

:deep(.toolset-form__editor-dialog .ant-modal-footer) {
  padding: 14px 24px 18px;
  border-top: 1px solid color-mix(in srgb, var(--app-border, #e8e8e8) 86%, transparent);
  background: color-mix(in srgb, var(--app-bg, #fff) 94%, #f8fafc);
}

.toolset-form__dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.toolset-form__dialog-footer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

:deep(.toolset-form__editor-dialog .ant-modal) {
  max-width: calc(100vw - 32px);
  margin: 24px auto;
  padding-bottom: 0;
}

:deep(.toolset-form__editor-dialog .ant-modal-content) {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  overflow: hidden;
}

:deep(.toolset-form__editor-dialog .ant-modal-body) {
  min-height: 0;
  overflow: auto;
}

@media (max-width: 900px) {
  .toolset-form__grid,
  .toolset-form__tool-grid {
    grid-template-columns: 1fr;
  }

  .toolset-form__field--full {
    grid-column: auto;
  }

  .toolset-form__header,
  .toolset-form__navigator-head,
  .toolset-form__section-toolbar,
  .toolset-form__editor-head {
    flex-direction: column;
    align-items: stretch;
  }

  .toolset-form__tool-nav-list {
    max-height: none;
  }

  .toolset-form__tool-nav-item {
    flex-basis: 100%;
    max-width: none;
  }

  .toolset-form__modal-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .toolset-form__dialog-footer,
  .toolset-form__dialog-footer-actions {
    flex-direction: column;
    align-items: stretch;
  }
}

:root[data-theme="dark"] .toolset-form__navigator,
:root[data-theme="dark"] .toolset-form__section,
:root[data-theme="dark"] .toolset-form__tool-nav-item {
  border-color: color-mix(in srgb, var(--app-border, #303030) 92%, #5a4d42);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.02));
}

:root[data-theme="dark"] .toolset-form__hint {
  border-color: color-mix(in srgb, var(--app-border, #303030) 82%, #5d4d40);
  background: linear-gradient(135deg, rgba(217, 119, 87, 0.12), rgba(255, 255, 255, 0.03));
  color: #d3d8df;
}

:root[data-theme="dark"] .toolset-form__section-note {
  border-color: color-mix(in srgb, var(--app-border, #303030) 84%, #5a4b3e);
  background: rgba(217, 119, 87, 0.1);
  color: #d3d8df;
}

:root[data-theme="dark"] .toolset-form__editor-eyebrow,
:root[data-theme="dark"] .toolset-form__count-badge,
:root[data-theme="dark"] .toolset-form__tool-nav-runtime {
  background: rgba(217, 119, 87, 0.16);
  color: #ffd2c2;
}

:root[data-theme="dark"] .toolset-form__add-btn {
  border-color: color-mix(in srgb, var(--app-accent, #d97757) 36%, #73604f);
  background: rgba(217, 119, 87, 0.12);
  color: #ffd2c2;
}

:root[data-theme="dark"] .toolset-form__workspace-note,
:root[data-theme="dark"] .toolset-form__modal-note {
  border-color: color-mix(in srgb, var(--app-border, #303030) 82%, #5d4d40);
  background: linear-gradient(135deg, rgba(217, 119, 87, 0.12), rgba(255, 255, 255, 0.03));
  color: #d3d8df;
}

:root[data-theme="dark"] :deep(.toolset-form__editor-dialog .ant-modal-footer) {
  border-top-color: color-mix(in srgb, var(--app-border, #303030) 88%, #594b3e);
  background: color-mix(in srgb, var(--app-panel-bg, #30302e) 86%, #1f1b17);
}

:root[data-theme="dark"] .toolset-form__modal .toolset-form__field span {
  color: #ece7df;
}

:root[data-theme="dark"] .toolset-form__modal .toolset-form__input,
:root[data-theme="dark"] .toolset-form__modal .toolset-form__select,
:root[data-theme="dark"] .toolset-form__modal .toolset-form__textarea {
  border-color: color-mix(in srgb, var(--app-border, #303030) 84%, #5b4a3d);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg, #30302e) 92%, #1e1a16), color-mix(in srgb, var(--app-panel-bg, #30302e) 86%, #27221c));
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.04);
}

:root[data-theme="dark"] .toolset-form__ghost-btn,
:root[data-theme="dark"] .toolset-form__delete-btn,
:root[data-theme="dark"] .toolset-form__section summary,
:root[data-theme="dark"] .toolset-form__chips span,
:root[data-theme="dark"] .toolset-form__tool-nav-meta span,
:root[data-theme="dark"] .toolset-form__input,
:root[data-theme="dark"] .toolset-form__select,
:root[data-theme="dark"] .toolset-form__textarea {
  background: color-mix(in srgb, var(--app-panel-bg, #30302e) 92%, #1e1a16);
}

:root[data-theme="dark"] .toolset-form__header h3,
:root[data-theme="dark"] .toolset-form__navigator-head strong,
:root[data-theme="dark"] .toolset-form__editor-head h4,
:root[data-theme="dark"] .toolset-form__hint strong,
:root[data-theme="dark"] .toolset-form__section-note strong,
:root[data-theme="dark"] .toolset-form__workspace-note strong,
:root[data-theme="dark"] .toolset-form__modal-note strong {
  color: #f2ede6;
}

:root[data-theme="dark"] .toolset-form__subhead,
:root[data-theme="dark"] .toolset-form__editor-head p,
:root[data-theme="dark"] .toolset-form__field span,
:root[data-theme="dark"] .toolset-form__section-caption,
:root[data-theme="dark"] .toolset-form__field-help,
:root[data-theme="dark"] .toolset-form__toggle-help,
:root[data-theme="dark"] .toolset-form__workspace-note,
:root[data-theme="dark"] .toolset-form__modal-note,
:root[data-theme="dark"] .toolset-form__tool-nav-item p,
:root[data-theme="dark"] .toolset-form__tool-nav-meta span {
  color: #c9d0d8;
}
</style>

