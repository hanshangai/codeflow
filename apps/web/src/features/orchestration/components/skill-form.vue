<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons-vue";
import {
  canMaintainBuiltinSpecAssets,
  type OrchSkillInstallTargetStatus,
  type SkillDefinition,
  type SkillId,
  type SkillTargetEngine,
  type WorkspaceId,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useOrchestrationStore } from "../../../store/orchestration";
import { useOrchAssetDirtyState } from "../composables/useOrchAssetDirtyState";

defineOptions({ name: "SkillForm" });

type EditableSkill = Omit<SkillDefinition, "createdAt" | "updatedAt">;
type SkillFile = NonNullable<SkillDefinition["files"]>[number];
type SkillFileKind = SkillFile["kind"];
type SkillScript = NonNullable<SkillDefinition["scripts"]>[number];
type SkillScriptRuntime = SkillScript["runtime"];
type FormTab = "overview" | "skill-md" | "files" | "scripts" | "install";
type ScriptDialogMode = "create" | "edit";
type ScriptDialogDraft = {
  mode: ScriptDialogMode;
  index: number;
  id: string;
  name: string;
  description: string;
  scriptPath: string;
  runtime: SkillScriptRuntime;
  code: string;
  inputSchema: string;
  outputSchema: string;
  timeoutMs: number;
  requiresWrite: boolean;
  exposeAsTool: boolean;
};

const props = defineProps<{
  workspaceId: WorkspaceId;
  skillId: SkillId;
  sourceDefinition?: SkillDefinition | null;
  saveLabel?: string;
  /** 无工作区只读预览：强制只读，且不触发展示以外的任何请求。 */
  previewReadonly?: boolean;
}>();
const emit = defineEmits<{ (event: "dirty-change", dirty: boolean): void }>();

const orch = useOrchestrationStore();
const config = useConfigStore();
const { ctx } = useApiContext();
const form = ref<EditableSkill | null>(null);
const activeTab = ref<FormTab>("overview");
const saving = ref(false);
const refreshingStatus = ref(false);
const installingTarget = ref<SkillTargetEngine | null>(null);
const uninstallingTarget = ref<SkillTargetEngine | null>(null);
const installStatus = ref<OrchSkillInstallTargetStatus[]>([]);
const selectedFilePath = ref("SKILL.md");
const newFilePath = ref("references/notes.md");
const newScriptPath = ref("scripts/run.py");
const scriptDialogOpen = ref(false);
const scriptDialogDraft = ref<ScriptDialogDraft>(createScriptDialogDraft());
const { hasUnsavedChanges, isDirty, markCleanFromCurrentDraft } = useOrchAssetDirtyState(() => form.value);
watch(isDirty, (dirty) => emit("dirty-change", dirty), { immediate: true });

// 预览态排除「安装」页：安装是写操作且需要真实 workspaceId。
const formTabs = computed<Array<{ value: FormTab; label: string }>>(() => [
  { value: "overview", label: "概览" },
  { value: "skill-md", label: "SKILL.md" },
  { value: "files", label: "文件" },
  { value: "scripts", label: "脚本" },
  ...(props.previewReadonly === true ? [] : [{ value: "install" as const, label: "安装" }]),
]);

const engineOptions: Array<{ value: SkillTargetEngine; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
];

const runtimeOptions: Array<{ value: SkillScriptRuntime; label: string }> = [
  { value: "python", label: "Python" },
  { value: "node", label: "Node.js" },
  { value: "shell", label: "Shell" },
];

const tagDraft = computed({
  get: () => form.value?.tags?.join(", ") ?? "",
  set: (value: string) => {
    if (!form.value) return;
    form.value.tags = normalizeTags(value);
  },
});

const files = computed<SkillFile[]>(() => [...(form.value?.files ?? [])].sort((left, right) => left.relPath.localeCompare(right.relPath)));
const selectedFile = computed(() => files.value.find((file) => file.relPath === selectedFilePath.value) ?? null);
const scripts = computed<SkillScript[]>(() => form.value?.scripts ?? []);
const installStatusMap = computed(() => new Map(installStatus.value.map((item) => [item.targetId, item])));
const scriptDialogTitle = computed(() => scriptDialogDraft.value.mode === "edit" ? "编辑脚本" : "新增脚本");
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
  || orch.isServerAuthoritativeBuiltinAsset("skill", String(props.skillId ?? ""))
  || (form.value?.kind === "builtin" && !canMaintainBuiltinSpecAssets(permissionInput.value)));
const skillMdText = computed({
  get: () => form.value?.skillMd ?? files.value.find((file) => file.relPath === "SKILL.md")?.contentText ?? "",
  set: (value: string) => {
    if (!form.value) return;
    const text = normalizeText(value);
    form.value.skillMd = text;
    upsertPackageFile("SKILL.md", "skill-md", text, "text/markdown");
  },
});

watch([() => props.skillId, () => props.sourceDefinition], ([skillId, sourceDefinition]) => {
  const skill = sourceDefinition ?? orch.skills.find((item) => item.id === skillId);
  form.value = skill ? cloneSkill(skill) : null;
  markCleanFromCurrentDraft();
  selectedFilePath.value = "SKILL.md";
  installStatus.value = [];
  if (skill && props.previewReadonly !== true) void refreshInstallStatus(false);
}, { immediate: true });

async function onSave(): Promise<void> {
  try {
    await saveCurrent(true);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
  }
}

/** 保存 Skill 定义；非超管查看内置 Skill 时只允许安装，不允许改定义。 */
async function saveCurrent(showToast: boolean): Promise<SkillDefinition> {
  if (!form.value) throw new Error("Skill 表单为空");
  if (isBuiltinReadonly.value) throw new Error("内置 Skill 仅超管可修改");
  saving.value = true;
  try {
    const normalized = normalizeSkillForSave(form.value);
    const saved = await orch.saveSkill(ctx.value, props.workspaceId, normalized);
    form.value = cloneSkill(saved as SkillDefinition);
    markCleanFromCurrentDraft();
    if (showToast) message.success("Skill 已保存");
    return saved as SkillDefinition;
  } finally {
    saving.value = false;
  }
}

function toggleEngine(engine: SkillTargetEngine, checked: boolean): void {
  if (!form.value) return;
  const next = new Set(form.value.targetEngines);
  if (checked) next.add(engine);
  else next.delete(engine);
  form.value.targetEngines = Array.from(next);
  form.value.installTargets = normalizeTargets(form.value.installTargets ?? [], form.value.targetEngines);
}

function toggleInstallTarget(engine: SkillTargetEngine, checked: boolean): void {
  if (!form.value) return;
  const next = new Set(form.value.installTargets ?? form.value.targetEngines);
  if (checked) next.add(engine);
  else next.delete(engine);
  form.value.installTargets = normalizeTargets(Array.from(next), form.value.targetEngines);
}

function cloneSkill(skill: SkillDefinition): EditableSkill {
  const name = skill.name || "未命名 Skill";
  const slug = normalizeSkillSlug(skill.slug || name);
  const description = skill.description ?? "";
  const trigger = skill.trigger ?? "";
  const instructions = skill.instructions ?? "";
  const skillMd = normalizeText(skill.skillMd || skill.files?.find((file) => file.relPath === "SKILL.md")?.contentText || buildDefaultSkillMd({
    name,
    slug,
    description,
    trigger,
    instructions,
  }));
  const targetEngines = normalizeTargets(skill.targetEngines, ["codex", "claude"]);
  const files = ensureSkillMdFile(cloneFiles(skill.files), skillMd);
  return {
    id: skill.id,
    workspaceId: skill.workspaceId,
    name,
    slug,
    description,
    trigger,
    instructions,
    targetEngines,
    tags: [...(skill.tags ?? [])],
    kind: skill.kind ?? "custom",
    packageVersion: skill.packageVersion ?? 1,
    skillMd,
    files,
    scripts: cloneScripts(skill.scripts).filter((script) => files.some((file) => file.relPath === script.scriptPath)),
    installTargets: normalizeTargets(skill.installTargets ?? targetEngines, targetEngines),
    packageHash: skill.packageHash ?? null,
  };
}

function normalizeSkillForSave(skill: EditableSkill): EditableSkill {
  const name = skill.name.trim() || "未命名 Skill";
  const slug = normalizeSkillSlug(skill.slug || name);
  const targetEngines = normalizeTargets(skill.targetEngines, ["codex", "claude"]);
  if (!targetEngines.length) throw new Error("Skill 至少需要选择一个适用引擎");
  const skillMd = normalizeText(skill.skillMd || buildDefaultSkillMd({
    name,
    slug,
    description: skill.description,
    trigger: skill.trigger,
    instructions: skill.instructions,
  }));
  const files = ensureSkillMdFile(normalizeFiles(skill.files ?? []), skillMd);
  const scripts = normalizeScripts(skill.scripts ?? [], files);
  validateSchemas(scripts);
  return {
    ...skill,
    workspaceId: props.workspaceId,
    name,
    slug,
    description: skill.description.trim(),
    trigger: skill.trigger.trim(),
    instructions: normalizeText(extractSkillMdBody(skillMd) || skill.instructions),
    targetEngines,
    tags: normalizeTags(skill.tags ?? []),
    packageVersion: 1,
    skillMd,
    files,
    scripts,
    installTargets: normalizeTargets(skill.installTargets ?? targetEngines, targetEngines),
    packageHash: null,
  };
}

function syncSkillMdFromOverview(): void {
  if (!form.value) return;
  skillMdText.value = buildDefaultSkillMd({
    name: form.value.name.trim() || "未命名 Skill",
    slug: normalizeSkillSlug(form.value.slug || form.value.name),
    description: form.value.description.trim(),
    trigger: form.value.trigger.trim(),
    instructions: form.value.instructions.trim(),
  });
  message.success("SKILL.md 已更新");
}

function addPackageFile(): void {
  if (!form.value) return;
  try {
    const relPath = normalizeSkillFilePath(newFilePath.value);
    if (relPath === "SKILL.md") {
      message.warning("SKILL.md 已存在");
      return;
    }
    if (files.value.some((file) => file.relPath === relPath)) {
      message.warning("文件已存在");
      return;
    }
    const kind = inferFileKind(relPath);
    upsertPackageFile(relPath, kind, defaultFileContent(relPath), inferContentType(relPath));
    selectedFilePath.value = relPath;
    newFilePath.value = relPath.startsWith("scripts/") ? "scripts/run.py" : "references/notes.md";
  } catch (error) {
    message.error(error instanceof Error ? error.message : "新增文件失败");
  }
}

function deletePackageFile(relPath: string): void {
  if (!form.value) return;
  if (relPath === "SKILL.md") {
    message.warning("SKILL.md 不能删除");
    return;
  }
  form.value.files = (form.value.files ?? []).filter((file) => file.relPath !== relPath);
  form.value.scripts = (form.value.scripts ?? []).filter((script) => script.scriptPath !== relPath);
  selectedFilePath.value = "SKILL.md";
}

function updateSelectedFileContent(value: string): void {
  const file = selectedFile.value;
  if (!file) return;
  const text = normalizeText(value);
  upsertPackageFile(file.relPath, file.kind, text, file.contentType ?? inferContentType(file.relPath));
  if (file.relPath === "SKILL.md" && form.value) form.value.skillMd = text;
}

function upsertPackageFile(relPath: string, kind: SkillFileKind, content: string, contentType: string): void {
  if (!form.value) return;
  const file = createTextSkillPackageFile(relPath, kind, content, contentType);
  const next = (form.value.files ?? []).filter((item) => item.relPath !== relPath);
  next.push(file);
  form.value.files = next.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function openCreateScriptDialog(): void {
  if (!form.value) return;
  try {
    const scriptPath = normalizeSkillFilePath(newScriptPath.value);
    if (!scriptPath.startsWith("scripts/")) throw new Error("脚本必须位于 scripts/ 目录");
    const runtime = inferScriptRuntime(scriptPath);
    const id = uniqueScriptId(normalizeScriptId(scriptPath), form.value.scripts ?? []);
    scriptDialogDraft.value = createScriptDialogDraft({
      mode: "create",
      index: -1,
      id,
      name: id,
      scriptPath,
      runtime,
      code: readScriptCode(scriptPath) ?? defaultScriptContent(runtime),
    });
    scriptDialogOpen.value = true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "新增脚本失败");
  }
}

function openEditScriptDialog(index: number): void {
  if (!form.value) return;
  const script = scripts.value[index];
  if (!script) return;
  scriptDialogDraft.value = createScriptDialogDraft({
    mode: "edit",
    index,
    id: script.id,
    name: script.name,
    description: script.description,
    scriptPath: script.scriptPath,
    runtime: script.runtime,
    code: readScriptCode(script.scriptPath) ?? defaultScriptContent(script.runtime),
    inputSchema: script.inputSchema ?? "",
    outputSchema: script.outputSchema ?? "",
    timeoutMs: script.timeoutMs ?? 60_000,
    requiresWrite: Boolean(script.requiresWrite),
    exposeAsTool: Boolean(script.exposeAsTool),
  });
  scriptDialogOpen.value = true;
}

function openScriptDialogForFile(scriptPath: string): void {
  if (!form.value) return;
  const index = scripts.value.findIndex((script) => script.scriptPath === scriptPath);
  if (index >= 0) {
    openEditScriptDialog(index);
    return;
  }
  const runtime = inferScriptRuntime(scriptPath);
  const id = uniqueScriptId(normalizeScriptId(scriptPath), form.value.scripts ?? []);
  scriptDialogDraft.value = createScriptDialogDraft({
    mode: "create",
    index: -1,
    id,
    name: id,
    scriptPath,
    runtime,
    code: readScriptCode(scriptPath) ?? defaultScriptContent(runtime),
  });
  scriptDialogOpen.value = true;
}

function submitScriptDialog(): void {
  if (!form.value) return;
  try {
    const draft = scriptDialogDraft.value;
    const scriptPath = normalizeSkillFilePath(draft.scriptPath);
    if (!scriptPath.startsWith("scripts/")) throw new Error("脚本必须位于 scripts/ 目录");
    const id = normalizeScriptId(draft.id || scriptPath);
    const duplicateId = scripts.value.findIndex((script, index) => index !== draft.index && script.id === id);
    if (duplicateId >= 0) throw new Error("脚本 ID 已存在");
    const duplicatePath = scripts.value.findIndex((script, index) => index !== draft.index && script.scriptPath === scriptPath);
    if (duplicatePath >= 0) throw new Error("脚本文件已关联其他入口");
    const runtime = runtimeOptions.some((option) => option.value === draft.runtime) ? draft.runtime : inferScriptRuntime(scriptPath);
    const inputSchema = normalizeText(draft.inputSchema).trim();
    const outputSchema = normalizeText(draft.outputSchema).trim();
    parseOptionalJson(inputSchema, "输入 Schema");
    parseOptionalJson(outputSchema, "输出 Schema");
    const timeoutMs = Number.isFinite(Number(draft.timeoutMs)) ? Math.max(1_000, Number(draft.timeoutMs)) : 60_000;
    const entry: SkillScript = {
      id,
      name: draft.name.trim() || id,
      description: draft.description.trim(),
      scriptPath,
      runtime,
      inputSchema,
      outputSchema,
      timeoutMs,
      requiresWrite: Boolean(draft.requiresWrite),
      exposeAsTool: Boolean(draft.exposeAsTool),
    };
    upsertPackageFile(scriptPath, "script", normalizeText(draft.code), inferContentType(scriptPath));
    const next = [...(form.value.scripts ?? [])];
    if (draft.mode === "edit" && draft.index >= 0 && next[draft.index]) {
      next[draft.index] = entry;
    } else {
      next.push(entry);
    }
    form.value.scripts = next;
    selectedFilePath.value = scriptPath;
    newScriptPath.value = scriptPath;
    activeTab.value = "scripts";
    scriptDialogOpen.value = false;
    message.success("脚本已保存");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存脚本失败");
  }
}

function closeScriptDialog(): void {
  scriptDialogOpen.value = false;
}

function updateScriptDialogPath(value: string): void {
  const runtime = inferScriptRuntime(value);
  scriptDialogDraft.value = {
    ...scriptDialogDraft.value,
    scriptPath: value,
    runtime,
  };
}

function updateScriptDialogRuntime(value: SkillScriptRuntime): void {
  scriptDialogDraft.value = {
    ...scriptDialogDraft.value,
    runtime: value,
  };
}

function deleteScript(index: number): void {
  if (!form.value) return;
  form.value.scripts = (form.value.scripts ?? []).filter((_, itemIndex) => itemIndex !== index);
}

function createScriptDialogDraft(input: Partial<ScriptDialogDraft> = {}): ScriptDialogDraft {
  const scriptPath = input.scriptPath ?? "scripts/run.py";
  const runtime = input.runtime ?? inferScriptRuntime(scriptPath);
  return {
    mode: input.mode ?? "create",
    index: input.index ?? -1,
    id: input.id ?? "run",
    name: input.name ?? input.id ?? "run",
    description: input.description ?? "",
    scriptPath,
    runtime,
    code: input.code ?? defaultScriptContent(runtime),
    inputSchema: input.inputSchema ?? "",
    outputSchema: input.outputSchema ?? "",
    timeoutMs: input.timeoutMs ?? 60_000,
    requiresWrite: input.requiresWrite ?? false,
    exposeAsTool: input.exposeAsTool ?? true,
  };
}

function readScriptCode(scriptPath: string): string | null {
  const file = files.value.find((item) => item.relPath === scriptPath);
  return file?.contentText ?? null;
}

function scriptRuntimeLabel(runtime: SkillScriptRuntime): string {
  return runtimeOptions.find((option) => option.value === runtime)?.label ?? runtime;
}

function installActionLabel(target: SkillTargetEngine): string {
  const status = installStatusMap.value.get(target);
  return status?.installed ? "更新" : "安装";
}

function installingActionLabel(target: SkillTargetEngine): string {
  const status = installStatusMap.value.get(target);
  return status?.installed ? "更新中" : "安装中";
}

function isScriptFilePath(relPath: string): boolean {
  return relPath.startsWith("scripts/");
}

async function refreshInstallStatus(showToast = true): Promise<void> {
  if (!form.value?.id) return;
  refreshingStatus.value = true;
  try {
    installStatus.value = await orch.getSkillInstallStatus(ctx.value, props.workspaceId, form.value.id as SkillId);
    if (showToast) message.success("安装状态已刷新");
  } catch (error) {
    if (showToast) message.error(error instanceof Error ? error.message : "读取安装状态失败");
  } finally {
    refreshingStatus.value = false;
  }
}

/** 安装 Skill 包；只读内置 Skill 直接使用已保存定义，不触发定义保存。 */
async function installTarget(target: SkillTargetEngine): Promise<void> {
  if (!form.value?.id) return;
  installingTarget.value = target;
  try {
    const skillId = isBuiltinReadonly.value ? form.value.id as SkillId : (await saveCurrent(false)).id;
    const res = await orch.installSkillPackage(ctx.value, props.workspaceId, skillId, [target]);
    installStatus.value = res.status ?? [];
    const failed = (res.results ?? []).find((item: { ok: boolean }) => !item.ok);
    if (failed) message.error(failed.message ?? "安装失败");
    else message.success("Skill 已安装");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "安装失败");
  } finally {
    installingTarget.value = null;
  }
}

async function uninstallTarget(target: SkillTargetEngine): Promise<void> {
  if (!form.value?.id) return;
  uninstallingTarget.value = target;
  try {
    const res = await orch.uninstallSkillPackage(ctx.value, props.workspaceId, form.value.id as SkillId, [target]);
    installStatus.value = res.status ?? [];
    const failed = (res.results ?? []).find((item: { ok: boolean }) => !item.ok);
    if (failed) message.error(failed.message ?? "卸载失败");
    else message.success("Skill 已卸载");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "卸载失败");
  } finally {
    uninstallingTarget.value = null;
  }
}

function cloneFiles(value: SkillDefinition["files"]): SkillFile[] {
  return (value ?? []).map((file) => ({ ...file }));
}

function cloneScripts(value: SkillDefinition["scripts"]): SkillScript[] {
  return (value ?? []).map((script) => ({ ...script }));
}

function ensureSkillMdFile(input: SkillFile[], skillMd: string): SkillFile[] {
  const next = input.filter((file) => file.relPath !== "SKILL.md");
  next.push(createTextSkillPackageFile("SKILL.md", "skill-md", skillMd, "text/markdown"));
  return next.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

function normalizeFiles(input: SkillFile[]): SkillFile[] {
  return input.map((file) => {
    const relPath = normalizeSkillFilePath(file.relPath);
    const text = file.contentText == null ? null : normalizeText(file.contentText);
    if (text != null) {
      return createTextSkillPackageFile(relPath, inferFileKind(relPath), text, file.contentType ?? inferContentType(relPath));
    }
    return {
      ...file,
      relPath,
      kind: inferFileKind(relPath),
      contentBase64: file.contentBase64 ?? null,
      contentType: file.contentType ?? inferContentType(relPath),
      sizeBytes: Number(file.sizeBytes ?? 0),
      sha256: file.sha256 ?? "",
    };
  });
}

function normalizeScripts(input: SkillScript[], availableFiles: SkillFile[]): SkillScript[] {
  const availableScriptPaths = new Set(availableFiles.filter((file) => file.relPath.startsWith("scripts/")).map((file) => file.relPath));
  const seen = new Set<string>();
  return input.flatMap((script) => {
    if (!availableScriptPaths.has(script.scriptPath)) return [];
    const id = normalizeScriptId(script.id || script.scriptPath);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{
      id,
      name: script.name.trim() || id,
      description: script.description.trim(),
      scriptPath: script.scriptPath,
      runtime: runtimeOptions.some((option) => option.value === script.runtime) ? script.runtime : inferScriptRuntime(script.scriptPath),
      inputSchema: normalizeText(script.inputSchema ?? "").trim(),
      outputSchema: normalizeText(script.outputSchema ?? "").trim(),
      timeoutMs: Number.isFinite(Number(script.timeoutMs)) ? Math.max(1_000, Number(script.timeoutMs)) : 60_000,
      requiresWrite: Boolean(script.requiresWrite),
      exposeAsTool: Boolean(script.exposeAsTool),
    }];
  });
}

function validateSchemas(scripts: SkillScript[]): void {
  for (const script of scripts) {
    parseOptionalJson(script.inputSchema, `${script.name} 输入 schema`);
    parseOptionalJson(script.outputSchema, `${script.name} 输出 schema`);
  }
}

function parseOptionalJson(value: string | null | undefined, label: string): void {
  const text = String(value ?? "").trim();
  if (!text) return;
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${label} 不是合法 JSON`);
  }
}

function createTextSkillPackageFile(relPath: string, kind: SkillFileKind, content: string, contentType: string): SkillFile {
  const normalized = normalizeText(content);
  return {
    relPath,
    kind,
    contentText: normalized,
    contentBase64: null,
    contentType,
    sizeBytes: new TextEncoder().encode(normalized).length,
    sha256: "",
  };
}

function normalizeTags(value: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return Array.from(new Set(raw.split(/[,，]/).map((item) => item.trim()).filter(Boolean)));
}

function normalizeTargets(value: unknown, fallback: SkillTargetEngine[]): SkillTargetEngine[] {
  const raw = Array.isArray(value) ? value : fallback;
  const fallbackSet = new Set(fallback);
  return Array.from(new Set(raw.map((item) => String(item ?? "").trim())))
    .filter((item): item is SkillTargetEngine => (item === "codex" || item === "claude") && fallbackSet.has(item as SkillTargetEngine));
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

/** 规整 Skill 包内相对路径，并和 Client 仓储白名单保持一致。 */
function normalizeSkillFilePath(value: string): string {
  const rel = String(value ?? "").replace(/\\/g, "/").trim().replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) throw new Error("文件路径非法");
  const normalized = parts.join("/");
  if (!isAllowedSkillPackagePath(normalized)) {
    throw new Error("文件只能位于 SKILL.md、setup.mjs、requirements.txt、manifest.txt、templates/、providers/、scripts/、references/、assets/ 或 agents/openai.yaml");
  }
  return normalized;
}

/** 判断 Skill 包文件路径是否在平台支持的安装包目录内。 */
function isAllowedSkillPackagePath(normalized: string): boolean {
  return normalized === "SKILL.md"
    || normalized === "setup.mjs"
    || normalized === "requirements.txt"
    || normalized === "manifest.txt"
    || normalized === "agents/openai.yaml"
    || normalized.startsWith("templates/")
    || normalized.startsWith("providers/")
    || normalized.startsWith("scripts/")
    || normalized.startsWith("references/")
    || normalized.startsWith("assets/");
}

/** 按路径推断 Skill 包文件类型，供保存前补齐缺省 kind。 */
function inferFileKind(relPath: string): SkillFileKind {
  if (relPath === "SKILL.md") return "skill-md";
  if (relPath === "setup.mjs") return "script";
  if (relPath.startsWith("scripts/")) return "script";
  if (relPath.startsWith("references/")) return "reference";
  if (relPath.startsWith("templates/") || relPath.startsWith("providers/")) return "reference";
  if (relPath.startsWith("assets/")) return "asset";
  return "metadata";
}

function inferContentType(relPath: string): string {
  if (relPath.endsWith(".md")) return "text/markdown";
  if (relPath.endsWith(".yaml") || relPath.endsWith(".yml")) return "text/yaml";
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".py")) return "text/x-python";
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs") || relPath.endsWith(".cjs")) return "text/javascript";
  if (relPath.endsWith(".sh") || relPath.endsWith(".ps1")) return "text/x-shellscript";
  return "text/plain";
}

function inferScriptRuntime(scriptPath: string): SkillScriptRuntime {
  if (scriptPath.endsWith(".py")) return "python";
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs") || scriptPath.endsWith(".cjs")) return "node";
  return "shell";
}

function normalizeScriptId(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^scripts\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "script";
}

function uniqueScriptId(base: string, scripts: SkillScript[]): string {
  const used = new Set(scripts.map((script) => script.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function defaultFileContent(relPath: string): string {
  if (relPath.startsWith("references/")) return "# Notes\n";
  if (relPath === "agents/openai.yaml") return "display_name: \"\"\nshort_description: \"\"\ndefault_prompt: \"\"\n";
  return "";
}

function defaultScriptContent(runtime: SkillScriptRuntime): string {
  if (runtime === "python") return "print_json({\"ok\": True, \"input\": INPUT})\n";
  if (runtime === "node") return "printJson({ ok: true, input: INPUT });\n";
  return "echo '{\"ok\":true}'\n";
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

function extractSkillMdBody(value: string): string {
  const text = normalizeText(value).trim();
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  return text.slice(end + 4).trim();
}

function normalizeText(value: string): string {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function yamlDoubleQuoted(value: string): string {
  return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** 父级资产切换守卫调用的保存入口，失败时返回 false 阻止切换。 */
async function saveCurrentDraft(): Promise<boolean> {
  try {
    await saveCurrent(true);
    return true;
  } catch (error) {
    message.error(error instanceof Error ? error.message : "保存失败");
    return false;
  }
}

/** 放弃当前未保存 Skill 草稿，并恢复为 store 中最近保存态。 */
function discardUnsavedChanges(): void {
  const skill = props.sourceDefinition ?? orch.skills.find((item) => item.id === props.skillId);
  form.value = skill ? cloneSkill(skill) : null;
  markCleanFromCurrentDraft();
}

defineExpose({
  hasUnsavedChanges,
  saveCurrentDraft,
  discardUnsavedChanges,
});
</script>

<template>
  <div v-if="form" class="skill-form">
    <header class="skill-form__header">
      <div class="skill-form__title">
        <h3>{{ form.name || "未命名 Skill" }}</h3>
        <span>{{ form.slug || "skill" }} · {{ form.packageHash ? form.packageHash.slice(0, 12) : "未保存" }}</span>
      </div>
      <span v-if="isBuiltinReadonly" class="skill-form__readonly-badge">内置只读</span>
      <button class="skill-form__save-btn" :disabled="saving || isBuiltinReadonly" @click="onSave">
        <SaveOutlined /> {{ saving ? "保存中" : (props.saveLabel || "保存") }}
      </button>
    </header>

    <nav class="skill-form__tabs">
      <button
        v-for="tab in formTabs"
        :key="tab.value"
        class="skill-form__tab"
        :class="{ 'skill-form__tab--active': activeTab === tab.value }"
        type="button"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </nav>

    <fieldset v-if="activeTab !== 'install'" class="skill-form__fieldset" :disabled="isBuiltinReadonly">
    <section v-if="activeTab === 'overview'" class="skill-form__section">
      <div class="skill-form__grid">
        <label class="skill-form__field">
          <span>名称</span>
          <input v-model="form.name" class="skill-form__input" placeholder="例如：前端页面走查 / 生产问题只读定位" />
        </label>
        <label class="skill-form__field">
          <span>Slug</span>
          <input v-model="form.slug" class="skill-form__input" placeholder="frontend-review" />
        </label>
      </div>

      <label class="skill-form__field">
        <span>标签</span>
        <input v-model="tagDraft" class="skill-form__input" placeholder="frontend, review" />
      </label>

      <label class="skill-form__field">
        <span>描述</span>
        <textarea v-model="form.description" class="skill-form__textarea" rows="3" placeholder="一句话说明这个 Skill 的稳定能力边界。" />
      </label>

      <div class="skill-form__grid">
        <div class="skill-form__field">
          <span>适用引擎</span>
          <div class="skill-form__check-row">
            <label v-for="option in engineOptions" :key="option.value" class="skill-form__check-option">
              <input
                type="checkbox"
                :checked="form.targetEngines.includes(option.value)"
                @change="toggleEngine(option.value, Boolean(($event.target as HTMLInputElement).checked))"
              />
              <strong>{{ option.label }}</strong>
            </label>
          </div>
        </div>
        <div class="skill-form__field">
          <span>安装目标</span>
          <div class="skill-form__check-row">
            <label v-for="option in engineOptions" :key="option.value" class="skill-form__check-option" :class="{ 'skill-form__check-option--disabled': !form.targetEngines.includes(option.value) }">
              <input
                type="checkbox"
                :disabled="!form.targetEngines.includes(option.value)"
                :checked="(form.installTargets ?? []).includes(option.value)"
                @change="toggleInstallTarget(option.value, Boolean(($event.target as HTMLInputElement).checked))"
              />
              <strong>{{ option.label }}</strong>
            </label>
          </div>
        </div>
      </div>

      <label class="skill-form__field">
        <span>触发条件</span>
        <textarea v-model="form.trigger" class="skill-form__textarea" rows="4" placeholder="写清什么时候应该启用这个 Skill，什么时候不应该启用。" />
      </label>

      <label class="skill-form__field">
        <span>摘要指令</span>
        <textarea v-model="form.instructions" class="skill-form__textarea" rows="7" placeholder="写给 Codex / Claude 的稳定执行步骤、边界、检查项和失败处理方式。" />
      </label>
    </section>

    <section v-else-if="activeTab === 'skill-md'" class="skill-form__section">
      <div class="skill-form__toolbar">
        <button class="skill-form__ghost-btn" type="button" @click="syncSkillMdFromOverview">
          <ReloadOutlined /> 从概览生成
        </button>
      </div>
      <label class="skill-form__field skill-form__field--grow">
        <span>SKILL.md</span>
        <textarea v-model="skillMdText" class="skill-form__textarea skill-form__textarea--code" spellcheck="false" />
      </label>
    </section>

    <section v-else-if="activeTab === 'files'" class="skill-form__section skill-form__section--split">
      <div class="skill-form__file-list">
        <div class="skill-form__toolbar">
          <input v-model="newFilePath" class="skill-form__input" placeholder="references/notes.md" />
          <button class="skill-form__icon-btn" type="button" @click="addPackageFile"><PlusOutlined /></button>
        </div>
        <button
          v-for="file in files"
          :key="file.relPath"
          class="skill-form__file-item"
          :class="{ 'skill-form__file-item--active': selectedFilePath === file.relPath }"
          type="button"
          @click="selectedFilePath = file.relPath"
        >
          <span>{{ file.relPath }}</span>
          <small>{{ file.kind }} · {{ file.sizeBytes }}B</small>
        </button>
      </div>
      <div class="skill-form__file-editor">
        <div class="skill-form__toolbar">
          <strong>{{ selectedFile?.relPath || "未选择文件" }}</strong>
          <div class="skill-form__file-actions">
            <button
              v-if="selectedFile && isScriptFilePath(selectedFile.relPath)"
              class="skill-form__ghost-btn"
              type="button"
              @click="openScriptDialogForFile(selectedFile.relPath)"
            >
              <EditOutlined /> 编辑代码
            </button>
            <button
              v-if="selectedFile && selectedFile.relPath !== 'SKILL.md'"
              class="skill-form__icon-btn skill-form__icon-btn--danger"
              type="button"
              @click="deletePackageFile(selectedFile.relPath)"
            >
              <DeleteOutlined />
            </button>
          </div>
        </div>
        <textarea
          v-if="selectedFile?.contentText != null"
          class="skill-form__textarea skill-form__textarea--code"
          :value="selectedFile.contentText"
          spellcheck="false"
          @input="updateSelectedFileContent(($event.target as HTMLTextAreaElement).value)"
        />
        <div v-else class="skill-form__empty">当前文件不是文本内容</div>
      </div>
    </section>

    <section v-else-if="activeTab === 'scripts'" class="skill-form__section">
      <div class="skill-form__toolbar">
        <input v-model="newScriptPath" class="skill-form__input" placeholder="scripts/run.py" />
        <button class="skill-form__ghost-btn" type="button" @click="openCreateScriptDialog">
          <PlusOutlined /> 新增脚本
        </button>
      </div>

      <div v-if="scripts.length" class="skill-form__script-list">
        <article v-for="(script, index) in scripts" :key="script.id" class="skill-form__script-item">
          <div class="skill-form__script-head">
            <div>
              <strong>{{ script.name || script.id }}</strong>
              <span>{{ script.scriptPath }}</span>
            </div>
            <div class="skill-form__script-actions">
              <button class="skill-form__ghost-btn" type="button" @click="openEditScriptDialog(index)">
                <EditOutlined /> 编辑代码
              </button>
              <button class="skill-form__icon-btn skill-form__icon-btn--danger" type="button" @click="deleteScript(index)">
                <DeleteOutlined />
              </button>
            </div>
          </div>
          <div class="skill-form__script-meta">
            <span>{{ script.id }}</span>
            <span>{{ scriptRuntimeLabel(script.runtime) }}</span>
            <span>{{ script.timeoutMs ?? 60000 }}ms</span>
            <span>{{ script.exposeAsTool ? "已暴露工具" : "未暴露工具" }}</span>
            <span>{{ script.requiresWrite ? "需要写入" : "只读脚本" }}</span>
          </div>
          <p v-if="script.description" class="skill-form__script-desc">{{ script.description }}</p>
        </article>
      </div>
      <div v-else class="skill-form__empty">暂无脚本入口</div>
    </section>

    </fieldset>

    <section v-else class="skill-form__section">
      <div class="skill-form__toolbar">
        <button class="skill-form__ghost-btn" type="button" :disabled="refreshingStatus" @click="() => refreshInstallStatus()">
          <ReloadOutlined /> {{ refreshingStatus ? "刷新中" : "刷新" }}
        </button>
      </div>
      <div class="skill-form__install-list">
        <article v-for="option in engineOptions" :key="option.value" class="skill-form__install-item">
          <div>
            <strong>{{ option.label }}</strong>
            <span>{{ installStatusMap.get(option.value)?.message || "未查询" }}</span>
            <small>{{ installStatusMap.get(option.value)?.installedPath || "" }}</small>
          </div>
          <div class="skill-form__install-actions">
            <button
              class="skill-form__ghost-btn"
              type="button"
              :disabled="!form.targetEngines.includes(option.value) || installingTarget === option.value"
              @click="installTarget(option.value)"
            >
              {{ installingTarget === option.value ? installingActionLabel(option.value) : installActionLabel(option.value) }}
            </button>
            <button
              class="skill-form__ghost-btn"
              type="button"
              :disabled="uninstallingTarget === option.value"
              @click="uninstallTarget(option.value)"
            >
              {{ uninstallingTarget === option.value ? "卸载中" : "卸载" }}
            </button>
          </div>
        </article>
      </div>
    </section>

    <a-modal
      v-model:open="scriptDialogOpen"
      :title="scriptDialogTitle"
      :width="960"
      :mask-closable="false"
      ok-text="保存脚本"
      cancel-text="取消"
      :ok-button-props="{ disabled: isBuiltinReadonly }"
      wrap-class-name="orch-asset-modal orch-asset-editor-modal skill-form__script-dialog"
      @ok="submitScriptDialog"
      @cancel="closeScriptDialog"
    >
      <fieldset class="skill-form__fieldset" :disabled="isBuiltinReadonly">
      <div class="skill-form__script-modal">
        <div class="skill-form__grid">
          <label class="skill-form__field">
            <span>脚本 ID</span>
            <input v-model="scriptDialogDraft.id" class="skill-form__input" placeholder="hello" />
          </label>
          <label class="skill-form__field">
            <span>名称</span>
            <input v-model="scriptDialogDraft.name" class="skill-form__input" placeholder="Hello Script" />
          </label>
        </div>
        <div class="skill-form__grid">
          <label class="skill-form__field">
            <span>脚本路径</span>
            <input
              class="skill-form__input"
              :value="scriptDialogDraft.scriptPath"
              placeholder="scripts/hello.py"
              @input="updateScriptDialogPath(($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="skill-form__field">
            <span>运行时</span>
            <select class="skill-form__input" :value="scriptDialogDraft.runtime" @change="updateScriptDialogRuntime(($event.target as HTMLSelectElement).value as SkillScriptRuntime)">
              <option v-for="option in runtimeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>
        <label class="skill-form__field">
          <span>说明</span>
          <textarea v-model="scriptDialogDraft.description" class="skill-form__textarea" rows="2" />
        </label>
        <label class="skill-form__field">
          <span>脚本代码</span>
          <textarea v-model="scriptDialogDraft.code" class="skill-form__textarea skill-form__textarea--script-code" spellcheck="false" />
        </label>
        <div class="skill-form__grid">
          <label class="skill-form__field">
            <span>输入 Schema</span>
            <textarea v-model="scriptDialogDraft.inputSchema" class="skill-form__textarea skill-form__textarea--schema" spellcheck="false" />
          </label>
          <label class="skill-form__field">
            <span>输出 Schema</span>
            <textarea v-model="scriptDialogDraft.outputSchema" class="skill-form__textarea skill-form__textarea--schema" spellcheck="false" />
          </label>
        </div>
        <div class="skill-form__grid">
          <label class="skill-form__field">
            <span>超时 ms</span>
            <input v-model.number="scriptDialogDraft.timeoutMs" class="skill-form__input" type="number" min="1000" step="1000" />
          </label>
          <div class="skill-form__field">
            <span>权限</span>
            <div class="skill-form__check-row">
              <label class="skill-form__check-option">
                <input v-model="scriptDialogDraft.exposeAsTool" type="checkbox" />
                <strong>暴露工具</strong>
              </label>
              <label class="skill-form__check-option">
                <input v-model="scriptDialogDraft.requiresWrite" type="checkbox" />
                <strong>需要写入</strong>
              </label>
            </div>
          </div>
        </div>
      </div>
      </fieldset>
    </a-modal>
  </div>
</template>

<style scoped>
.skill-form {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--app-text, #1f2937);
}
.skill-form__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--app-border, #e5e7eb);
}
.skill-form__title {
  min-width: 0;
  flex: 1;
}
.skill-form__title h3 {
  margin: 0;
  font-size: 18px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.skill-form__title span {
  display: block;
  margin-top: 2px;
  color: var(--app-muted, #64748b);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.skill-form__save-btn,
.skill-form__ghost-btn,
.skill-form__icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  min-height: 34px;
  padding: 7px 12px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-text, #1f2937);
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.skill-form__save-btn {
  border-color: var(--app-accent, #d97757);
  background: var(--app-accent, #d97757);
  color: #fff;
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
.skill-form__save-btn:not(:disabled):hover {
  transform: translateY(-1px);
  filter: brightness(1.05);
  box-shadow: 0 10px 22px color-mix(in srgb, var(--app-accent, #d97757) 30%, transparent);
}
.skill-form__save-btn:not(:disabled):active {
  transform: translateY(0) scale(0.98);
  filter: brightness(0.94);
  box-shadow: 0 5px 10px color-mix(in srgb, var(--app-accent, #d97757) 20%, transparent);
}
.skill-form__save-btn:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--app-accent, #d97757) 28%, transparent);
  outline-offset: 2px;
}
.skill-form__readonly-badge {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: #fff4e5;
  color: #9a5b14;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.skill-form__icon-btn {
  width: 34px;
  padding: 0;
}
.skill-form__icon-btn--danger {
  color: #b42318;
}
.skill-form__save-btn:disabled,
.skill-form__ghost-btn:disabled,
.skill-form__icon-btn:disabled {
  opacity: 0.58;
  cursor: not-allowed;
}
.skill-form__tabs {
  display: flex;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
  margin-bottom: 16px;
  overflow-x: auto;
}
.skill-form__tab {
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 14px;
  background: none;
  color: var(--app-muted, #999);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.skill-form__tab--active {
  border-bottom-color: var(--app-primary, #1677ff);
  color: var(--app-primary, #1677ff);
}
.skill-form__fieldset {
  flex: 1;
  min-width: 0;
  min-height: 0;
  margin: 0;
  padding: 0;
  border: 0;
  display: flex;
  flex-direction: column;
}
.skill-form__section {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px 24px;
}
.skill-form__section--split {
  display: grid;
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
  gap: 16px;
}
.skill-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.skill-form__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skill-form__field span {
  font-size: 12px;
  color: var(--app-muted, #64748b);
  font-weight: 700;
}
.skill-form__field--grow {
  flex: 1;
  min-height: 0;
}
.skill-form__input,
.skill-form__textarea {
  width: 100%;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-text, #1f2937);
  padding: 9px 11px;
  font: inherit;
  outline: none;
}
.skill-form__textarea {
  resize: vertical;
  line-height: 1.58;
}
.skill-form__textarea--code {
  flex: 1;
  min-height: 420px;
  resize: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.skill-form__textarea--schema {
  min-height: 100px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.skill-form__textarea--script-code {
  min-height: 300px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
}
.skill-form__input:focus,
.skill-form__textarea:focus {
  border-color: color-mix(in srgb, var(--app-accent, #d97757) 30%, var(--app-border, #d9d9d9));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-accent, #d97757) 10%, transparent);
}
.skill-form__check-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.skill-form__check-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 9px 11px;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 96%, var(--app-bg, #fff));
}
.skill-form__check-option--disabled {
  opacity: 0.55;
}
.skill-form__check-option strong {
  font-size: 13px;
}
.skill-form__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}
.skill-form__toolbar .skill-form__input {
  max-width: 340px;
}
.skill-form__file-list {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-right: 1px solid var(--app-border, #e5e7eb);
  padding-right: 14px;
}
.skill-form__file-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 8px;
  padding: 9px 10px;
  background: var(--app-panel-bg, #fff);
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.skill-form__file-item span,
.skill-form__file-item small {
  max-width: 100%;
  overflow-wrap: anywhere;
}
.skill-form__file-item small {
  color: var(--app-muted, #64748b);
}
.skill-form__file-item--active {
  border-color: color-mix(in srgb, var(--app-accent, #d97757) 40%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent, #d97757) 8%, var(--app-panel-bg, #fff));
}
.skill-form__file-editor {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.skill-form__file-editor .skill-form__toolbar {
  justify-content: space-between;
}
.skill-form__file-editor strong {
  overflow-wrap: anywhere;
}
.skill-form__file-actions,
.skill-form__script-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.skill-form__script-list,
.skill-form__install-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.skill-form__script-item,
.skill-form__install-item {
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 8px;
  padding: 14px;
  background: color-mix(in srgb, var(--app-panel-bg, #fff) 98%, var(--app-bg, #fff));
}
.skill-form__script-head,
.skill-form__install-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.skill-form__script-head {
  margin-bottom: 12px;
}
.skill-form__script-head > div:first-child {
  min-width: 0;
}
.skill-form__script-head span,
.skill-form__install-item span,
.skill-form__install-item small {
  display: block;
  color: var(--app-muted, #64748b);
  font-size: 12px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.skill-form__script-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.skill-form__script-meta span {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 8px;
  padding: 2px 8px;
  background: var(--app-panel-bg, #fff);
  color: var(--app-muted, #64748b);
  font-size: 12px;
  font-weight: 700;
  overflow-wrap: anywhere;
}
.skill-form__script-desc {
  margin: 10px 0 0;
  color: var(--app-muted, #64748b);
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.skill-form__script-modal {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.skill-form__install-actions {
  display: flex;
  gap: 8px;
}
.skill-form__empty {
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 8px;
  padding: 18px;
  color: var(--app-muted, #64748b);
  text-align: center;
}
@media (max-width: 980px) {
  .skill-form__grid,
  .skill-form__check-row,
  .skill-form__section--split {
    grid-template-columns: 1fr;
  }
  .skill-form__file-list {
    border-right: none;
    border-bottom: 1px solid var(--app-border, #e5e7eb);
    padding-right: 0;
    padding-bottom: 14px;
  }
  .skill-form__script-head,
  .skill-form__install-item,
  .skill-form__toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .skill-form__file-actions,
  .skill-form__script-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .skill-form__toolbar .skill-form__input {
    max-width: none;
  }
}
</style>
