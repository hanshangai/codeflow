<script setup lang="ts">
import { computed, ref, toRef, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CopyOutlined, DeleteOutlined, ExportOutlined, ImportOutlined, Loading3QuartersOutlined, PlusOutlined, ReloadOutlined, SearchOutlined, SwapOutlined, ThunderboltOutlined } from "@ant-design/icons-vue";
import {
  canExportBuiltinSpecKnowledgeBundle,
  canExportSpecWorkflowRoleAssets,
  canImportRuleAssets,
  type OrchAssetBundle,
  type SkillDefinition,
  type SkillId,
  type SkillTargetEngine,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { showAssetBundleWarningMessage, useOrchAssetBundleImport } from "../composables/useOrchAssetBundleImport";
import { useAssetGroups } from "../composables/useAssetGroups";
import AssetGroupBar from "./asset-group-bar.vue";

defineOptions({ name: "SkillList" });

const props = withDefaults(defineProps<{
  workspaceId: WorkspaceId;
  locked?: boolean;
  maintenanceForbidden?: boolean;
  beforeAssetChange?: () => Promise<boolean>;
  toolbarTeleportTarget?: string;
  /** 桌面本机工作区允许把内置资产复制为个人资产。 */
  canCopyBuiltin?: boolean;
  copyingBuiltinAssetId?: string | null;
}>(), {
  locked: false,
  maintenanceForbidden: false,
  beforeAssetChange: async () => true,
  toolbarTeleportTarget: "",
  canCopyBuiltin: false,
  copyingBuiltinAssetId: null,
});
const emit = defineEmits<{ (e: "copy-builtin", assetId: string): void }>();
const orch = useOrchestrationStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const searchText = ref("");
const exportModalOpen = ref(false);
const exportSkillIds = ref<SkillId[]>([]);
const exporting = ref(false);
const createModalOpen = ref(false);
const createSaving = ref(false);

type CreateSkillDraft = {
  name: string;
  tagsText: string;
  description: string;
  targetEngines: SkillTargetEngine[];
  trigger: string;
  instructions: string;
};

const createEngineOptions: Array<{ value: SkillTargetEngine; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

const createDraft = ref<CreateSkillDraft>(createDefaultSkillDraft());

const permissionInput = computed(() => ({
  accountRole: config.accountRole,
  enterpriseId: config.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: config.accessContext?.effectiveAccessScope ?? null,
  accessContext: config.accessContext ?? null,
}));
const canImportBundles = computed(() => canImportRuleAssets(permissionInput.value));
const showCreateButton = computed(() => !props.maintenanceForbidden);
const showImportButton = computed(() => !props.maintenanceForbidden && (canImportBundles.value || props.locked));
const canExportBundles = computed(() => canExportSpecWorkflowRoleAssets(permissionInput.value));
const showExportButton = computed(() => !props.maintenanceForbidden && (canExportBundles.value || props.locked));
const canExportBuiltinSkill = computed(() => canExportBuiltinSpecKnowledgeBundle(permissionInput.value));
const exportableSkillIdSet = computed(() =>
  new Set(
    orch.skills
      .filter((skill) => (canExportBuiltinSkill.value || skill.kind !== "builtin"))
      .map((skill) => skill.id),
  ),
);
const exportableSkillCount = computed(() => exportableSkillIdSet.value.size);
const allExportableSkillSelected = computed(() => exportableSkillCount.value > 0 && exportSkillIds.value.length === exportableSkillCount.value);
const assetGroups = useAssetGroups({ workspaceId: toRef(props, "workspaceId"), assetType: "skill" });
const assetGroupBarRef = ref<InstanceType<typeof AssetGroupBar> | null>(null);
const filteredSkills = computed(() => {
  const q = searchText.value.trim().toLowerCase();
  return orch.skills.filter((skill) => {
    if (!assetGroups.matches(skill)) return false;
    if (!q) return true;
    return [
      skill.name,
      skill.description,
      skill.trigger,
      ...(skill.tags ?? []),
    ].some((value) => String(value ?? "").toLowerCase().includes(q));
  });
});

const { importInputRef, importing, triggerImport: triggerBundleImport, onImportFile } = useOrchAssetBundleImport({
  workspaceId: () => props.workspaceId,
  async onImported(imported) {
    if (imported.skills[0]) {
      await selectSkill(imported.skills[0].id);
      return;
    }
    if (imported.workflows[0]) {
      if (!(await props.beforeAssetChange())) return;
      orch.selectedWorkflowId = imported.workflows[0].id;
      orch.setActiveTab("workflows");
    }
  },
});

watch(exportModalOpen, (open) => {
  if (!open) return;
  if (orch.selectedSkillId && isSkillExportable(orch.selectedSkillId)) {
    exportSkillIds.value = sanitizeExportSkillIds([orch.selectedSkillId]);
    return;
  }
  exportSkillIds.value = sanitizeExportSkillIds(orch.skills.map((item) => item.id));
});

/** 触发 Skill 资产包导入前执行权限和套餐校验。 */
async function triggerImport(): Promise<void> {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能导入 Skill");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canImportBundles.value) {
    message.warning("当前账号暂无规则资产导入权限");
    return;
  }
  if (!(await props.beforeAssetChange())) return;
  triggerBundleImport();
}

/** 打开 Skill 导出弹窗，默认选中当前 Skill 或全部可导出 Skill。 */
function openExportModal() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  if (!orch.skills.length) {
    message.info("当前还没有 Skill 可导出");
    return;
  }
  if (!exportableSkillCount.value) {
    message.info("当前账号仅可导出自定义 Skill，当前工作区没有可导出的自定义 Skill");
    return;
  }
  exportModalOpen.value = true;
}

/** 切换 Skill 导出选择，非超管遇到内置 Skill 时直接阻止。 */
function onExportSkillToggle(event: Event, skillId: SkillId) {
  if (!isSkillExportable(skillId)) {
    message.warning("内置 Skill 仅超管可导出");
    return;
  }
  const checked = (event.target as HTMLInputElement | null)?.checked === true;
  const next = new Set(exportSkillIds.value);
  if (checked) next.add(skillId);
  else next.delete(skillId);
  exportSkillIds.value = sanitizeExportSkillIds(orch.skills.map((item) => item.id).filter((id) => next.has(id)));
}

/** 在当前账号权限范围内全选或清空 Skill 导出项。 */
function toggleAllExportSkills(): void {
  exportSkillIds.value = allExportableSkillSelected.value
    ? []
    : sanitizeExportSkillIds(orch.skills.map((item) => item.id));
}

/** 导出选中的 Skill 资产包。 */
async function onExportBundle() {
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  if (!canExportBundles.value) {
    message.warning("当前账号暂无资产导出权限");
    return;
  }
  const exportIds = sanitizeExportSkillIds(exportSkillIds.value);
  if (!exportIds.length) {
    message.warning("请至少选择一个 Skill");
    return;
  }
  exporting.value = true;
  try {
    const bundle = await orch.exportSkillAssetBundle(ctx.value, props.workspaceId, exportIds);
    downloadBundle(bundle);
    exportModalOpen.value = false;
    message.success("Skill 资产包已导出");
    showAssetBundleWarningMessage(bundle.warnings);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "导出失败");
  } finally {
    exporting.value = false;
  }
}

/** 打开 Skill 新建弹窗；取消时不会产生空资产。 */
function openCreateModal() {
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能维护 Skill 定义");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  void openCreateModalAfterGuard();
}

/** 刷新进行中：图标转圈展示过程，同时挡住重复点击。 */
const refreshing = ref(false);

/** 手动刷新 Skill 列表：草稿与版本可能被其它入口改动，这里给一个显式重取入口。 */
async function refreshSkillList(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  const startedAt = Date.now();
  try {
    await orch.refreshSkills(ctx.value, props.workspaceId);
  } catch (cause) {
    message.error(cause instanceof Error ? cause.message : "刷新 Skill 列表失败");
    return;
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshing.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  message.success("Skill 列表已刷新");
}

/** 新建 Skill 弹框打开前先确认当前编辑草稿。 */
async function openCreateModalAfterGuard(): Promise<void> {
  if (!(await props.beforeAssetChange())) return;
  createDraft.value = createDefaultSkillDraft();
  createModalOpen.value = true;
}

/** 提交新建弹窗，创建成功后选中新 Skill。 */
async function submitCreateSkill() {
  const draft = normalizeCreateSkillDraft(createDraft.value);
  if (!draft.name) {
    message.warning("请填写 Skill 名称");
    return;
  }
  if (!draft.targetEngines.length) {
    message.warning("请至少选择一个适用引擎");
    return;
  }
  if (!draft.instructions) {
    message.warning("请填写执行指令");
    return;
  }
  createSaving.value = true;
  try {
    const base = orch.createDefaultSkill(props.workspaceId);
    const slug = normalizeSkillSlug(draft.name);
    const skillMd = buildDefaultSkillMd({
      name: draft.name,
      slug,
      description: draft.description,
      trigger: draft.trigger,
      instructions: draft.instructions,
    });
    const saved = await orch.saveSkill(ctx.value, props.workspaceId, {
      ...base,
      name: draft.name,
      slug,
      description: draft.description,
      trigger: draft.trigger,
      instructions: draft.instructions,
      targetEngines: draft.targetEngines,
      installTargets: draft.targetEngines,
      skillMd,
      files: [createTextSkillPackageFile("SKILL.md", "skill-md", skillMd)],
      scripts: [],
      tags: draft.tags,
    });
    orch.selectedSkillId = saved.id;
    createModalOpen.value = false;
    message.success("Skill 已创建");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "新建 Skill 失败");
  } finally {
    createSaving.value = false;
  }
}

/** 选中 Skill 前先交由父级处理未保存草稿。 */
async function selectSkill(skillId: SkillId): Promise<void> {
  if (orch.selectedSkillId === skillId) return;
  if (!(await props.beforeAssetChange())) return;
  orch.selectedSkillId = skillId;
  orch.setActiveTab("skills");
}

/** 下载导出的 Skill 资产包。 */
function downloadBundle(bundle: OrchAssetBundle) {
  const payload = JSON.stringify(bundle, null, 2);
  const blob = new Blob([payload], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFileName(bundle.title || "skill-bundle") + ".json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 规整下载文件名，避免浏览器保存时报非法字符。 */
function safeFileName(raw: string): string {
  return String(raw ?? "").trim().replace(/[<>:"/\\|?*\s]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "skill-bundle";
}

/** 判断当前 Skill 是否允许被当前账号导出。 */
function isSkillExportable(skillId: SkillId): boolean {
  return exportableSkillIdSet.value.has(skillId);
}

/** 清理导出列表，避免非超管误带出内置 Skill。 */
function sanitizeExportSkillIds(skillIds: SkillId[]): SkillId[] {
  return skillIds.filter((skillId) => isSkillExportable(skillId));
}

/** 打开 Skill 删除确认，列表按钮和更多菜单共用。 */
function confirmDelete(skillId: SkillId, name: string, event?: Event) {
  event?.stopPropagation();
  if (props.maintenanceForbidden) {
    message.warning("当前账号只能使用共享工作区资产，不能删除 Skill");
    return;
  }
  if (props.locked) {
    message.warning("当前企业访问受限，请联系管理员检查企业及成员状态。");
    return;
  }
  const skill = orch.skills.find((item) => item.id === skillId) ?? null;
  if (skill?.kind === "builtin") {
    message.warning("内置 Skill 不可删除");
    return;
  }
  Modal.confirm({
    title: "删除 Skill",
    content: `确认删除 Skill「${name}」？`,
    okText: "删除",
    cancelText: "取消",
    okButtonProps: { danger: true },
    onOk: async () => {
      try {
        await orch.removeSkill(ctx.value, props.workspaceId, skillId);
        message.success("Skill 已删除");
      } catch (error) {
        message.error(error instanceof Error ? error.message : "删除失败");
      }
    },
  });
}

function targetEnginesLabel(values: readonly string[]): string {
  return values.map((value) => value === "claude" ? "Claude" : "Codex").join(" / ");
}

/** 新建弹窗默认值只存在前端草稿，避免未确认就写库。 */
function createDefaultSkillDraft(): CreateSkillDraft {
  return {
    name: "",
    tagsText: "",
    description: "",
    targetEngines: ["codex", "claude"],
    trigger: "",
    instructions: "",
  };
}

/** 切换新建弹窗中的目标引擎，提交时再做非空校验。 */
function toggleCreateEngine(engine: SkillTargetEngine, checked: boolean): void {
  const next = new Set(createDraft.value.targetEngines);
  if (checked) next.add(engine);
  else next.delete(engine);
  createDraft.value.targetEngines = Array.from(next);
}

/** 归一化新建弹窗草稿，输出可直接保存的字段。 */
function normalizeCreateSkillDraft(draft: CreateSkillDraft): CreateSkillDraft & { tags: string[] } {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    trigger: draft.trigger.trim(),
    instructions: draft.instructions.replace(/\r\n/g, "\n").trim(),
    targetEngines: Array.from(new Set(draft.targetEngines)).filter((item) => item === "codex" || item === "claude"),
    tags: normalizeTags(draft.tagsText),
  };
}

/** 解析逗号分隔标签，空值会被丢弃。 */
function normalizeTags(value: string): string[] {
  return Array.from(new Set(String(value ?? "").split(/[,，]/).map((item) => item.trim()).filter(Boolean)));
}

function normalizeSkillSlug(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "skill";
}

function buildDefaultSkillMd(input: { name: string; slug: string; description: string; trigger: string; instructions: string }): string {
  return [
    "---",
    `name: ${yamlDoubleQuoted(input.slug)}`,
    `description: ${yamlDoubleQuoted(input.description || input.trigger || input.name)}`,
    "---",
    "",
    `# ${input.name}`,
    "",
    input.description,
    "",
    "## Trigger",
    "",
    input.trigger,
    "",
    "## Instructions",
    "",
    input.instructions,
  ].join("\n");
}

function createTextSkillPackageFile(
  relPath: string,
  kind: NonNullable<SkillDefinition["files"]>[number]["kind"],
  content: string,
): NonNullable<SkillDefinition["files"]>[number] {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n");
  return {
    relPath,
    kind,
    contentText: normalized,
    contentBase64: null,
    contentType: relPath.endsWith(".md") ? "text/markdown" : "text/plain",
    sizeBytes: new TextEncoder().encode(normalized).length,
    sha256: "",
  };
}

function yamlDoubleQuoted(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
</script>

<template>
  <div class="skill-sidebar">
    <input ref="importInputRef" type="file" accept=".json,application/json" class="skill-sidebar__hidden-input" @change="onImportFile" />

    <a-modal
      :open="createModalOpen"
      title="新建 Skill"
      :width="760"
      :confirm-loading="createSaving"
      ok-text="创建"
      cancel-text="取消"
      wrap-class-name="orch-asset-modal orch-asset-editor-modal skill-sidebar__create-dialog"
      @ok="submitCreateSkill"
      @cancel="createModalOpen = false"
    >
      <div class="skill-sidebar__create-modal">
        <div class="skill-sidebar__create-grid">
          <label class="skill-sidebar__create-field">
            <span>名称</span>
            <input v-model="createDraft.name" class="skill-sidebar__create-input" placeholder="例如：前端页面走查" />
          </label>
          <label class="skill-sidebar__create-field">
            <span>标签</span>
            <input v-model="createDraft.tagsText" class="skill-sidebar__create-input" placeholder="例如：frontend, review" />
          </label>
        </div>

        <label class="skill-sidebar__create-field">
          <span>描述</span>
          <textarea v-model="createDraft.description" class="skill-sidebar__create-textarea" rows="3" placeholder="一句话说明这个 Skill 的稳定能力边界。" />
        </label>

        <div class="skill-sidebar__create-field">
          <span>适用引擎</span>
          <div class="skill-sidebar__create-engine-row">
            <label v-for="option in createEngineOptions" :key="option.value" class="skill-sidebar__create-engine-option">
              <input
                type="checkbox"
                :checked="createDraft.targetEngines.includes(option.value)"
                @change="toggleCreateEngine(option.value, Boolean(($event.target as HTMLInputElement).checked))"
              />
              <strong>{{ option.label }}</strong>
            </label>
          </div>
        </div>

        <label class="skill-sidebar__create-field">
          <span>触发条件</span>
          <textarea v-model="createDraft.trigger" class="skill-sidebar__create-textarea" rows="3" placeholder="写清什么时候应该启用这个 Skill。" />
        </label>

        <label class="skill-sidebar__create-field">
          <span>执行指令</span>
          <textarea v-model="createDraft.instructions" class="skill-sidebar__create-textarea skill-sidebar__create-textarea--main" rows="8" placeholder="写给 Codex / Claude 的稳定执行步骤、边界、检查项和失败处理方式。" />
        </label>
      </div>
    </a-modal>

    <Teleport defer :to="props.toolbarTeleportTarget || 'body'" :disabled="!props.toolbarTeleportTarget">
      <div class="skill-sidebar__search">
        <SearchOutlined class="skill-sidebar__search-icon" />
        <input v-model="searchText" placeholder="搜索 Skill..." class="skill-sidebar__search-input" />
        <div class="skill-sidebar__search-actions" aria-label="Skill 操作">
          <a-tooltip v-if="showCreateButton" title="新建自定义 Skill">
            <span class="skill-sidebar__tooltip-wrap">
              <button class="skill-sidebar__icon-action skill-sidebar__icon-action--primary" type="button" aria-label="新建自定义 Skill" :disabled="props.locked" @click="openCreateModal">
                <PlusOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showImportButton" :title="importing ? '导入中' : '导入 Skill 资产'">
            <span class="skill-sidebar__tooltip-wrap">
              <button
                class="skill-sidebar__icon-action"
                type="button"
                :aria-label="importing ? '导入中' : '导入 Skill 资产'"
                :disabled="props.locked || importing"
                @click="triggerImport"
              >
                <ImportOutlined />
              </button>
            </span>
          </a-tooltip>
          <a-tooltip v-if="showExportButton" title="导出 Skill 资产">
            <span class="skill-sidebar__tooltip-wrap">
              <button
                class="skill-sidebar__icon-action"
                type="button"
                aria-label="导出 Skill 资产"
                :disabled="props.locked"
                @click="openExportModal"
              >
                <ExportOutlined />
              </button>
            </span>
          </a-tooltip>
          <span class="skill-sidebar__tooltip-wrap">
            <button class="skill-sidebar__icon-action" type="button" aria-label="刷新 Skill 列表" @click="refreshSkillList">
              <!-- 刷新中换成 3/4 圆弧 loading：4 段均匀弧与圆环箭头自转在小尺寸下都看不出转动。 -->
              <Loading3QuartersOutlined v-if="refreshing" spin />
              <ReloadOutlined v-else />
            </button>
          </span>
        </div>
      </div>
    </Teleport>

    <AssetGroupBar ref="assetGroupBarRef" v-model="assetGroups.selectedGroup.value" :groups="assetGroups.groups.value" :loading="assetGroups.loading.value" :can-manage="!props.maintenanceForbidden" :load-groups="assetGroups.load" :create-group="assetGroups.create" :rename-group="assetGroups.rename" :delete-group="assetGroups.remove" :assign-group="assetGroups.assign" />

    <div class="skill-sidebar__items">
      <div v-if="orch.skillsLoading" class="skill-sidebar__empty">加载中...</div>
      <div
        v-for="skill in filteredSkills"
        :key="skill.id"
        class="skill-sidebar__item"
        :class="{ 'skill-sidebar__item--selected': orch.selectedSkillId === skill.id }"
        @click="selectSkill(skill.id)"
      >
        <span class="skill-sidebar__item-icon" aria-hidden="true"><ThunderboltOutlined /></span>
        <div class="skill-sidebar__item-body">
          <div class="skill-sidebar__item-name">
            <span class="skill-sidebar__item-name-text">{{ skill.name }}</span>
            <span
              class="skill-sidebar__item-kind"
              :class="{ 'skill-sidebar__item-kind--builtin': skill.kind === 'builtin' }"
            >{{ skill.kind === 'builtin' ? '内置' : '自定义' }}</span>
          </div>
          <div class="skill-sidebar__item-meta">{{ targetEnginesLabel(skill.targetEngines) }} · {{ skill.trigger || "未填写触发条件" }}</div>
        </div>
        <button
          v-if="props.canCopyBuiltin && skill.kind === 'builtin'"
          type="button"
          class="skill-sidebar__item-menu skill-sidebar__item-copy"
          :disabled="props.copyingBuiltinAssetId === skill.id"
          title="复制为个人资产"
          :aria-label="`复制 ${skill.name} 为个人资产`"
          @click.stop="emit('copy-builtin', skill.id)"
        >
          <Loading3QuartersOutlined v-if="props.copyingBuiltinAssetId === skill.id" spin />
          <CopyOutlined v-else />
        </button>
        <a-dropdown v-if="!props.maintenanceForbidden && skill.kind !== 'builtin'" :trigger="['click']">
          <button type="button" class="skill-sidebar__item-menu" aria-label="更多" @click.stop>⋯</button>
          <template #overlay>
            <a-menu>
              <a-menu-item @click="assetGroupBarRef?.openMoveGroup(skill)"><template #icon><SwapOutlined /></template>切换分组</a-menu-item>
              <a-menu-divider />
              <a-menu-item :disabled="props.locked" danger @click="confirmDelete(skill.id, skill.name)"><template #icon><DeleteOutlined /></template>删除</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
      <div v-if="!orch.skillsLoading && filteredSkills.length === 0" class="skill-sidebar__empty">
        当前分组暂无 Skill
      </div>
    </div>

    <a-modal
      :open="exportModalOpen"
      title="导出 Skill 资产包"
      :width="720"
      :footer="null"
      wrap-class-name="orch-asset-modal orch-asset-bundle-modal"
      @cancel="exportModalOpen = false"
    >
      <div class="skill-sidebar__bundle-modal">
        <div class="skill-sidebar__bundle-intro">
          <strong>批量导出 Skill</strong>
          <p>导出的 JSON 会带上所选 Skill 定义，后续可在其他工作区一键导入。</p>
          <p v-if="!canExportBuiltinSkill" class="skill-sidebar__bundle-note">当前账号仅可导出自定义 Skill，内置 Skill 仅超管可导出。</p>
        </div>

        <div class="skill-sidebar__bundle-toolbar">
          <button class="skill-sidebar__ghost-btn orch-action-btn" type="button" :disabled="!exportableSkillCount" @click="toggleAllExportSkills">
            {{ allExportableSkillSelected ? "取消全选" : "全选" }}
          </button>
          <span>已选 {{ exportSkillIds.length }} / {{ exportableSkillCount }}</span>
        </div>

        <div class="skill-sidebar__bundle-list">
          <label
            v-for="skill in orch.skills"
            :key="skill.id"
            class="skill-sidebar__bundle-item"
            :class="{ 'skill-sidebar__bundle-item--disabled': !isSkillExportable(skill.id) }"
          >
            <input
              :checked="exportSkillIds.includes(skill.id)"
              type="checkbox"
              :disabled="!isSkillExportable(skill.id)"
              @change="onExportSkillToggle($event, skill.id)"
            />
            <div>
              <strong>
                {{ skill.name }}
                <span v-if="skill.kind === 'builtin'" class="skill-sidebar__bundle-tag">内置</span>
                <span v-if="skill.kind === 'builtin' && !canExportBuiltinSkill" class="skill-sidebar__bundle-tag skill-sidebar__bundle-tag--warn">
                  仅超管可导出
                </span>
              </strong>
              <p>{{ targetEnginesLabel(skill.targetEngines) }} · {{ skill.description || "无描述" }}</p>
            </div>
          </label>
        </div>

        <div class="skill-sidebar__bundle-footer">
          <button class="skill-sidebar__ghost-btn orch-action-btn" :disabled="exporting" @click="exportModalOpen = false">取消</button>
          <button class="orch-action-btn orch-action-btn--primary" :disabled="exporting" @click="onExportBundle">
            {{ exporting ? "导出中..." : "开始导出" }}
          </button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.skill-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.skill-sidebar__hidden-input { display:none; }
.skill-sidebar__search { padding: 12px 14px 0; }
.skill-sidebar__search-input {
  width: 100%;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  border-radius: 12px;
  font-size: 12px;
  outline: none;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #333);
  box-shadow: inset 0 1px 2px rgba(15, 23, 42, 0.03);
}
.skill-sidebar__search-input:focus {
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}
.skill-sidebar__items {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  padding: 10px 10px;
}
.skill-sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 40px 7px 12px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  margin-bottom: 2px;
  overflow: hidden;
  transition: background 100ms ease, border-color 100ms ease;
}
.skill-sidebar__item:hover {
  border-color: transparent;
  background: var(--app-sidebar-hover-bg);
}
.skill-sidebar__item--selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.skill-sidebar__item.skill-sidebar__item--selected:hover {
  border-color: transparent;
  background: color-mix(in srgb, var(--app-accent) 11%, transparent);
  box-shadow: none;
}

.skill-sidebar__item--selected .skill-sidebar__item-name {
  color: var(--app-accent);
  font-weight: 600;
}
.skill-sidebar__item-icon {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--app-accent);
  color: #fff;
  font-size: 13px;
}
.skill-sidebar__item-body {
  flex: 1 1 auto;
  min-width: 0;
}
.skill-sidebar__item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
}
.skill-sidebar__item-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-sidebar__item-meta {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--app-muted, #667085);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-sidebar__item-delete {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
}
.skill-sidebar__item-menu { position: absolute; top: 6px; right: 8px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--app-muted); cursor: pointer; font-size: 18px; line-height: 1; opacity: 0; }
.skill-sidebar__item:hover .skill-sidebar__item-menu, .skill-sidebar__item--selected .skill-sidebar__item-menu { opacity: 1; }
.skill-sidebar__item-menu:hover { color: var(--app-primary); background: color-mix(in srgb, var(--app-primary) 10%, transparent); }
/* 内置资产的复制入口常驻显示。 */
.skill-sidebar__item-copy { opacity: 1; font-size: 13px; }
.skill-sidebar__item-copy:disabled { cursor: not-allowed; opacity: .5; }
.skill-sidebar__item:hover .skill-sidebar__item-delete,
.skill-sidebar__item--selected .skill-sidebar__item-delete { opacity: 1; }
.skill-sidebar__item-delete:hover {
  background: color-mix(in srgb, #ff4d4f 10%, transparent);
  color: #ff4d4f;
}
.skill-sidebar__item-delete:disabled {
  opacity: 0.45 !important;
  cursor: not-allowed;
  background: transparent;
  color: var(--app-muted, #8c8c8c);
}
.skill-sidebar__item-kind {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--app-accent) 10%, #fff);
  color: color-mix(in srgb, var(--app-accent) 68%, #1f2937);
  font-size: 10.5px;
  font-weight: 500;
  pointer-events: none;
}
.skill-sidebar__item-kind--builtin { background: color-mix(in srgb, var(--app-muted) 12%, transparent); color: var(--app-muted, #667085); }
.skill-sidebar__empty {
  padding: 18px 14px;
  color: var(--app-muted, #8c8c8c);
  font-size: 12px;
}
.skill-sidebar__ghost-btn {
  border-color: color-mix(in srgb, var(--app-border, #d9d9d9) 92%, transparent);
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 95%, var(--app-bg, #fff));
  color: var(--app-text, #334155);
}
.skill-sidebar__bundle-modal { display:flex; flex-direction:column; gap:16px; }
.skill-sidebar__bundle-intro {
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
  padding:12px 14px;
  background:linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 94%, #f7f9fc), var(--app-bg, #fff));
}
.skill-sidebar__bundle-intro strong { display:block; margin-bottom:4px; }
.skill-sidebar__bundle-intro p { margin:0; font-size:12px; line-height:1.7; color:var(--app-muted, #666); }
.skill-sidebar__bundle-note { color: color-mix(in srgb, var(--app-accent, #d97757) 72%, #7c2d12) !important; }
.skill-sidebar__bundle-toolbar {
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  font-size:12px;
  color:var(--app-muted, #666);
}
.skill-sidebar__bundle-list {
  display:flex;
  flex-direction:column;
  gap:8px;
  max-height:min(46vh, 420px);
  overflow:auto;
}
.skill-sidebar__bundle-item {
  display:flex;
  gap:10px;
  align-items:flex-start;
  padding:10px 12px;
  border:1px solid var(--app-border, #e8e8e8);
  border-radius:12px;
}
.skill-sidebar__bundle-item p {
  margin:3px 0 0;
  font-size:12px;
  line-height:1.5;
  color:var(--app-muted, #666);
}
.skill-sidebar__bundle-item--disabled { opacity:0.58; }
.skill-sidebar__bundle-tag {
  margin-left:6px;
  padding:2px 6px;
  border-radius:999px;
  background:color-mix(in srgb, #94a3b8 12%, #fff);
  color:#475569;
  font-size:10px;
}
.skill-sidebar__bundle-tag--warn {
  background:color-mix(in srgb, #f59e0b 16%, #fff);
  color:#92400e;
}
.skill-sidebar__bundle-footer {
  display:flex;
  justify-content:flex-end;
  gap:8px;
}
.skill-sidebar__create-modal {
  display:flex;
  flex-direction:column;
  gap:14px;
}
.skill-sidebar__create-grid {
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:14px;
}
.skill-sidebar__create-field {
  display:flex;
  flex-direction:column;
  gap:6px;
}
.skill-sidebar__create-field span {
  font-size:12px;
  color:var(--app-muted, #64748b);
  font-weight:700;
}
.skill-sidebar__create-input,
.skill-sidebar__create-textarea {
  width:100%;
  border:1px solid var(--app-border, #d9d9d9);
  border-radius:10px;
  background:var(--app-panel-bg, #fff);
  color:var(--app-text, #1f2937);
  padding:10px 12px;
  font:inherit;
  outline:none;
}
.skill-sidebar__create-textarea {
  resize:vertical;
  line-height:1.62;
}
.skill-sidebar__create-textarea--main {
  min-height:160px;
}
.skill-sidebar__create-input:focus,
.skill-sidebar__create-textarea:focus {
  border-color:color-mix(in srgb, var(--app-accent) 28%, var(--app-border, #d9d9d9));
  box-shadow:0 0 0 3px color-mix(in srgb, var(--app-accent) 10%, transparent);
}
.skill-sidebar__create-engine-row {
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:10px;
}
.skill-sidebar__create-engine-option {
  display:flex;
  align-items:center;
  gap:8px;
  min-height:42px;
  padding:10px 12px;
  border:1px solid var(--app-border, #e5e7eb);
  border-radius:10px;
  background:color-mix(in srgb, var(--app-panel-bg, #fff) 96%, var(--app-bg, #fff));
}
.skill-sidebar__create-engine-option strong {
  font-size:13px;
}

:root[data-theme="dark"] .skill-sidebar__item {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

:root[data-theme="dark"] .skill-sidebar__item:hover {
  background: var(--app-sidebar-hover-bg);
}

:root[data-theme="dark"] .skill-sidebar__item--selected,
:root[data-theme="dark"] .skill-sidebar__item.skill-sidebar__item--selected:hover {
  background: color-mix(in srgb, var(--app-accent) 16%, transparent);
  box-shadow: none;
}

:root[data-theme="dark"] .skill-sidebar__item-kind {
  background: rgba(148, 163, 184, 0.16);
  color: #cbd5e1;
}

:root[data-theme="dark"] .skill-sidebar__item-delete:hover {
  background: rgba(255, 77, 79, 0.14);
}

:root[data-theme="dark"] .skill-sidebar__search-input {
  border-color: rgba(255, 255, 255, 0.08);
  background: #16181d;
}

@media (max-width: 900px) {
  .skill-sidebar__create-grid,
  .skill-sidebar__create-engine-row {
    grid-template-columns:1fr;
  }
}
</style>
