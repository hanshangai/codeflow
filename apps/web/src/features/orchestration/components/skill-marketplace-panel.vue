<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { FolderOpenOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type {
  GetSkillSuitesResponseBody,
  SkillInstallType,
  SkillSuiteInfo,
  SkillSuiteTargetStatus,
  SkillsOperateResult,
  WorkspaceId,
} from "@codeflowai/shared";
import { canManageCustomSkillsAndMcp } from "@codeflowai/shared";

import { isCancelledRequestError } from "../../../api/request";
import { getSkillSuites, installSkills, uninstallSkills } from "../../../api/skills";
import { trackProductEvent } from "../../../analytics/analytics";
import { useApiContext } from "../../../composables/useApiContext";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { usePresenceStore } from "../../../store/presence";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { useWorkspacesStore } from "../../../store/workspaces";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { SKILL_SUITES_CACHE_TTL_MS, skillSuitesCache } from "./skill-suites-cache";
import ClientDirectoryPickerModal from "../../workspaces/components/client-directory-picker-modal.vue";

defineOptions({ name: "SkillMarketplacePanel" });

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: true });

const configStore = useConfigStore();
const presenceStore = usePresenceStore();
const workspacesStore = useWorkspacesStore();
const { ctx } = useApiContext();

const workspaceId = computed(() => configStore.workspaceId as WorkspaceId | null);
const desktopLocalWorkspace = computed(() => isDesktopWorkspace(configStore, workspaceId.value ?? ""));
const clientAvailable = computed(() => desktopLocalWorkspace.value || configStore.connected);
const currentWorkspace = computed(() => workspaceId.value ? workspacesStore.byId.get(workspaceId.value) ?? null : null);
const sharedWorkspaceMaintenanceLocked = computed(() => Boolean(
  workspaceId.value
  && (currentWorkspace.value?.kind === "shared" || isSharedWorkspaceSelectionId(workspaceId.value))
  && currentWorkspace.value?.capabilities?.canMaintainAssets !== true,
));
const sharedWorkspaceMaintenanceLockedMessage = "共享工作区成员不可维护 Skills";
const sharedWorkspaceMaintenanceLockedDescription = "你仍可在流程中使用共享 Skills；安装、卸载和自定义接入由企业管理员或工作区管理员统一维护，维护动作会写入审计。";
const isSharedHostTarget = computed(() => Boolean(
  currentWorkspace.value?.shared?.hostClientId
  || currentWorkspace.value?.hostedShared?.hostClientId
  || isSharedWorkspaceSelectionId(workspaceId.value),
));
const permissionInput = computed(() => ({
  accountRole: configStore.accountRole,
  enterpriseId: configStore.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: configStore.accessContext?.effectiveAccessScope ?? null,
  accessContext: configStore.accessContext ?? null,
}));
const canManageCustomMarketplace = computed(() => desktopLocalWorkspace.value || canManageCustomSkillsAndMcp(permissionInput.value));

const loading = ref(false);
const loadError = ref<string | null>(null);
const suitesData = ref<GetSkillSuitesResponseBody | null>(null);
const searchQuery = ref("");
type SkillListFilter = "recommended" | "all" | "installed";
const listFilter = ref<SkillListFilter>("all");
const filterOptions: Array<{ label: string; value: SkillListFilter }> = [
  { label: "推荐", value: "recommended" },
  { label: "全部", value: "all" },
  { label: "已安装", value: "installed" },
];
const selectedSuiteId = ref<string | null>(null);
const operating = ref(false);
const operatingKind = ref<"install" | "uninstall" | null>(null);
const selectedTargets = ref<string[]>([]);
const lastOp = ref<{ kind: "install" | "uninstall"; at: number; results: SkillsOperateResult[] } | null>(null);

const customModalOpen = ref(false);
const customSaving = ref(false);
const customInstallType = ref<SkillInstallType>("github");
const customName = ref("");
const customRepoUrl = ref("");
const customGitUrl = ref("");
const customLocalPath = ref("");
const customArchiveUrl = ref("");
const customSkillsPath = ref("");
const customTargets = ref<string[]>(["codex", "claude"]);
const directoryPickerOpen = ref(false);

const cacheScope = computed(() => {
  const current = currentWorkspace.value;
  const sharedHostClientId = current?.shared?.hostClientId ?? current?.hostedShared?.hostClientId ?? null;
  const localClientId = presenceStore.clientForWorkspace(String(workspaceId.value ?? ""))?.clientId ?? current?.ownerClientId ?? null;
  const targetClientId = String(sharedHostClientId ?? localClientId ?? "unknown").trim() || "unknown";
  const accountScope = String(configStore.webInstanceId ?? "anonymous").trim() || "anonymous";
  return {
    baseKey: ["skill-suites", configStore.serverWsOrigin, accountScope, String(workspaceId.value ?? "").trim()].join("::"),
    targetClientId,
  };
});
const cacheKey = computed(() => `${cacheScope.value.baseKey}::${cacheScope.value.targetClientId}`);
/** 本地目录选择器的目标 Client（仅个人工作区；共享 Host 已禁用 local）。 */
const directoryClientId = computed(() => {
  const current = currentWorkspace.value;
  return presenceStore.clientForWorkspace(String(workspaceId.value ?? ""))?.clientId ?? current?.ownerClientId ?? "";
});
let loadSequence = 0;

const suites = computed<SkillSuiteInfo[]>(() => suitesData.value?.suites ?? []);
const targetStatus = computed<Record<string, SkillSuiteTargetStatus[]>>(() => suitesData.value?.targetStatus ?? {});
const catalogOnly = computed(() => Boolean(suitesData.value?.catalogOnly));

const fallbackSkillTargets = [
  { label: "Codex", value: "codex" },
  { label: "Claude", value: "claude" },
] as const;

const selectedSuite = computed<SkillSuiteInfo | null>(() =>
  suites.value.find((suite) => suite.suiteId === selectedSuiteId.value) ?? null,
);

function suiteTargets(suiteId: string): SkillSuiteTargetStatus[] {
  return targetStatus.value[suiteId] ?? [];
}

function suiteHasInstalled(suiteId: string): boolean {
  return suiteTargets(suiteId).some((target) => target.installed !== null);
}

function suiteTagLabel(suite: SkillSuiteInfo): string {
  return suite.source === "custom" ? "自定义" : "社区";
}

function installTypeLabel(type?: SkillInstallType): string {
  return { github: "GitHub 仓库", git: "Git 仓库", local: "本地目录", url: "下载链接" }[type ?? "github"];
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "-";
  }
}

/** 推荐优先（按 rank）、再已安装优先，最后按名称排序。 */
const filteredSuites = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const source = listFilter.value === "recommended"
    ? suites.value.filter((suite) => suite.recommended === true)
    : listFilter.value === "installed"
      ? suites.value.filter((suite) => suiteHasInstalled(suite.suiteId))
      : suites.value;
  const result = query
    ? source.filter((suite) => [suite.name, suite.description, suite.author]
      .some((value) => String(value ?? "").toLowerCase().includes(query)))
    : source.slice();
  return result.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    const leftRank = left.recommended ? (left.recommendedRank ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rightRank = right.recommended ? (right.recommendedRank ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftInstalled = suiteHasInstalled(left.suiteId) ? 0 : 1;
    const rightInstalled = suiteHasInstalled(right.suiteId) ? 0 : 1;
    if (leftInstalled !== rightInstalled) return leftInstalled - rightInstalled;
    return left.name.localeCompare(right.name, "zh-CN");
  });
});

const canOperate = computed(() =>
  clientAvailable.value
  && !catalogOnly.value
  && Boolean(workspaceId.value)
  && !sharedWorkspaceMaintenanceLocked.value
  && !operating.value
  && selectedTargets.value.length > 0
  && Boolean(selectedSuiteId.value),
);

function selectSuite(suiteId: string): void {
  selectedSuiteId.value = suiteId;
  selectedTargets.value = suiteTargets(suiteId).map((target) => target.targetId);
}

/** 应用目录与状态响应，并保持当前选中项仍属于最新列表。 */
function applySuitesResponse(response: GetSkillSuitesResponseBody): void {
  suitesData.value = response;
  if (selectedSuiteId.value && !response.suites?.some((suite) => suite.suiteId === selectedSuiteId.value)) selectedSuiteId.value = null;
  if (!selectedSuiteId.value && response.suites?.length) {
    selectedSuiteId.value = response.suites.find((suite) => suite.featuredRecommended)?.suiteId ?? response.suites[0]!.suiteId;
  }
  if (selectedSuiteId.value) {
    const targets = suiteTargets(selectedSuiteId.value);
    const existingIds = new Set(targets.map((target) => target.targetId));
    selectedTargets.value = selectedTargets.value.filter((id) => existingIds.has(id));
    if (!selectedTargets.value.length) selectedTargets.value = targets.map((target) => target.targetId);
  }
}

/** 本机就绪或 Server 已连接时读取技能状态；复用同工作区、同 Client 的有效缓存。 */
async function load(options: { force?: boolean } = {}): Promise<boolean> {
  if (!clientAvailable.value || !props.open) return false;
  const force = options.force === true;
  const cached = skillSuitesCache.get(cacheKey.value);
  const hasCachedData = Boolean(cached);
  if (cached && !force) {
    applySuitesResponse(cached.response);
    loadError.value = null;
    loading.value = false;
    if (Date.now() - cached.updatedAt < SKILL_SUITES_CACHE_TTL_MS) return true;
  }
  const sequence = ++loadSequence;
  const requestWorkspaceId = workspaceId.value;
  const requestCacheKey = cacheKey.value;
  const isCurrentRequest = (): boolean => sequence === loadSequence
    && requestWorkspaceId === workspaceId.value
    && requestCacheKey === cacheKey.value
    && props.open
    && clientAvailable.value;
  loading.value = !hasCachedData;
  loadError.value = null;
  try {
    const response = await getSkillSuites(ctx.value, workspaceId.value);
    if (!response.ok) throw new Error(response.message);
    if (!isCurrentRequest()) return false;
    skillSuitesCache.set(cacheKey.value, { response, updatedAt: Date.now() });
    applySuitesResponse(response);
    return true;
  } catch (error) {
    if (!isCurrentRequest()) return false;
    loadError.value = error instanceof Error ? error.message : String(error);
    if (!hasCachedData) message.error(loadError.value);
    return false;
  } finally {
    if (isCurrentRequest()) loading.value = false;
  }
}

/** 手动刷新期间额外撑住按钮的 loading，让转圈有可见时长。 */
const refreshHolding = ref(false);

/** 手动刷新技能状态：只提示这一次点击的结果，失败提示由 load 内部按有无缓存给出。 */
async function refreshSkillState(): Promise<void> {
  if (refreshHolding.value) return;
  refreshHolding.value = true;
  const startedAt = Date.now();
  let ok = false;
  try {
    ok = await load({ force: true });
  } finally {
    // 请求常在几十毫秒内返回，补足最短时长让转圈看得见。
    await holdRefreshFeedback(startedAt);
    refreshHolding.value = false;
  }
  // 刷新通常瞬间完成，列表看不出变化，用提示告诉用户这次点击确实生效了。
  if (ok) message.success("技能状态已刷新");
}

/** 对选定目标执行内置 Skill 套件安装或卸载，并按逐目标结果上报。 */
async function runOp(kind: "install" | "uninstall"): Promise<void> {
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return;
  }
  if (!canOperate.value || !workspaceId.value || !selectedSuiteId.value) return;

  operating.value = true;
  operatingKind.value = kind;
  const targets = selectedTargets.value.slice();
  let operationCompleted = false;
  try {
    const res = kind === "install"
      ? await installSkills(ctx.value, { workspaceId: workspaceId.value, targets, suiteId: selectedSuiteId.value })
      : await uninstallSkills(ctx.value, { workspaceId: workspaceId.value, targets, suiteId: selectedSuiteId.value });
    if (!res.ok) throw new Error(res.message);

    lastOp.value = { kind, at: Date.now(), results: res.results };
    const failed = res.results.filter((item) => !item.ok);
    operationCompleted = true;
    trackProductEvent(kind === "install" ? "skill_install" : "skill_uninstall", {
      status: resolveSkillOperationStatus(res.results),
      source: "asset_library",
      target_count: targets.length,
      failed_count: failed.length,
    });
    if (failed.length) {
      message.error(`${failed.length === res.results.length ? "全部失败" : "部分失败"}：${failed.map((item) => item.targetId).join(", ")}`);
    } else {
      message.success(kind === "install" ? "安装完成" : "卸载完成");
    }
    await load({ force: true });
  } catch (error) {
    if (!operationCompleted && !isCancelledRequestError(error)) {
      trackProductEvent(kind === "install" ? "skill_install" : "skill_uninstall", { status: "failed", source: "asset_library", error_code_group: "request_error" });
    }
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    operating.value = false;
    operatingKind.value = null;
  }
}

/** 按逐目标结果区分全部成功、部分失败和全部失败。 */
function resolveSkillOperationStatus(results: SkillsOperateResult[]): "success" | "partial" | "failed" {
  const failedCount = results.filter((item) => !item.ok).length;
  if (!failedCount) return "success";
  return failedCount === results.length ? "failed" : "partial";
}

function confirmUninstall(): void {
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return;
  }
  Modal.confirm({
    title: "卸载社区技能",
    content: "将删除该套件写入的技能目录，不会影响其它社区套件。",
    okText: "卸载",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => await runOp("uninstall"),
  });
}

/** 约束自定义接入 github 类型仅接收 GitHub 仓库 URL。 */
function isValidGithubRepoUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?\/?$/i.test(value.trim());
}

/** 生成稳定的自定义套件 ID：custom-<installType>-<归一化来源>，便于重装/卸载命中同一套件。 */
function buildCustomSkillSuiteId(installType: SkillInstallType, source: string, skillsPath?: string): string {
  const norm = (v: string) => v.trim()
    .replace(/\.git$/i, "")
    .replace(/[^a-z0-9/-]+/gi, "-")
    .replace(/[\\/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  const sourcePart = norm(source);
  const pathPart = skillsPath && skillsPath.trim() ? `-${norm(skillsPath)}` : "";
  return `custom-${installType}-${sourcePart}${pathPart}`;
}

function openCustomModal(): void {
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return;
  }
  if (!canManageCustomMarketplace.value) {
    message.warning("当前账号暂无自定义 Skills 接入权限");
    return;
  }
  customInstallType.value = "github";
  customName.value = "";
  customRepoUrl.value = "";
  customGitUrl.value = "";
  customLocalPath.value = "";
  customArchiveUrl.value = "";
  customSkillsPath.value = "";
  customTargets.value = ["codex", "claude"];
  customModalOpen.value = true;
}

/** 打开目标 Client 本机目录选择器；没有目标 Client 时先提示。 */
function openDirectoryPicker(): void {
  if (!directoryClientId.value) {
    message.warning("请先连接目标 Client");
    return;
  }
  directoryPickerOpen.value = true;
}

/** 接收目录选择结果，写回本地目录输入框。 */
function onDirectoryPicked(value: string): void {
  customLocalPath.value = value;
}

/** 按安装类型读取当前来源字段。 */
function currentSource(): string {
  const type = customInstallType.value;
  if (type === "git") return customGitUrl.value.trim();
  if (type === "local") return customLocalPath.value.trim();
  if (type === "url") return customArchiveUrl.value.trim();
  return customRepoUrl.value.trim();
}

/** 安装一套自定义 Skills，并在成功后刷新当前列表。 */
async function submitCustom(): Promise<void> {
  if (!workspaceId.value) {
    message.warning("请先选择工作区");
    return;
  }
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return;
  }
  if (!canManageCustomMarketplace.value) {
    message.warning("当前账号暂无自定义 Skills 接入权限");
    return;
  }
  const installType = customInstallType.value;
  const source = currentSource();
  if (!customName.value.trim() || !source || !customTargets.value.length) {
    message.warning("请补全 Skills 名称、安装来源和安装目标");
    return;
  }
  if (installType === "github" && !isValidGithubRepoUrl(source)) {
    message.warning("当前仅支持接入 GitHub 仓库 URL");
    return;
  }

  customSaving.value = true;
  const suiteId = buildCustomSkillSuiteId(installType, source, installType === "local" ? undefined : customSkillsPath.value);
  let operationCompleted = false;
  try {
    const suite: SkillSuiteInfo = {
      suiteId,
      name: customName.value.trim(),
      description: "",
      author: "自定义",
      homepage: installType === "local" ? null : source,
      kind: "external",
      repoUrl: installType === "github" ? source : undefined,
      gitUrl: installType === "git" ? source : undefined,
      localPath: installType === "local" ? source : undefined,
      archiveUrl: installType === "url" ? source : undefined,
      skillsPath: installType === "local" ? undefined : (customSkillsPath.value.trim() || undefined),
      source: "custom",
      installType,
    };
    const res = await installSkills(ctx.value, {
      workspaceId: workspaceId.value,
      targets: [...customTargets.value],
      suite,
    });
    if (!res.ok) throw new Error(res.message);
    const failed = res.results.filter((item) => !item.ok);
    operationCompleted = true;
    trackProductEvent("skill_install", {
      status: resolveSkillOperationStatus(res.results),
      source: "asset_library",
      target_count: customTargets.value.length,
      failed_count: failed.length,
    });
    customModalOpen.value = false;
    selectedSuiteId.value = suiteId;
    if (failed.length) {
      message.error(`${failed.length === res.results.length ? "自定义 Skills 安装失败" : "自定义 Skills 部分安装失败"}：${failed.map((item) => item.targetId).join(", ")}`);
    } else {
      message.success("自定义 Skills 已安装");
    }
    await load({ force: true });
  } catch (error) {
    if (!operationCompleted && !isCancelledRequestError(error)) {
      trackProductEvent("skill_install", { status: "failed", source: "asset_library", error_code_group: "request_error" });
    }
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    customSaving.value = false;
  }
}

watch(() => [props.open, workspaceId.value, clientAvailable.value, cacheKey.value] as const, ([open, _workspace, connected]) => {
  loadSequence += 1;
  const cached = skillSuitesCache.get(cacheKey.value);
  suitesData.value = cached?.response ?? null;
  selectedSuiteId.value = null;
  loadError.value = null;
  loading.value = !cached;
  if (open && connected) void load();
}, { immediate: true });

/** 账号身份切换时清空当前浏览器实例的技能市场缓存，避免不同账号复用旧状态。 */
watch(() => [configStore.authMode, configStore.userSummary?.userId] as const, ([authMode, userId], previous) => {
  if (!previous) return;
  const accountChanged = authMode !== previous[0]
    || (Boolean(previous[1]) && Boolean(userId) && userId !== previous[1])
    || (Boolean(previous[1]) && !userId);
  if (!accountChanged) return;
  skillSuitesCache.clear();
  loadSequence += 1;
  suitesData.value = null;
  selectedSuiteId.value = null;
  loadError.value = null;
  if (props.open && clientAvailable.value) void load({ force: true });
});

watch([filteredSuites, listFilter], ([list]) => {
  if (selectedSuiteId.value && list.some((suite) => suite.suiteId === selectedSuiteId.value)) return;
  selectedSuiteId.value = list[0]?.suiteId ?? null;
  if (selectedSuiteId.value) selectedTargets.value = suiteTargets(selectedSuiteId.value).map((target) => target.targetId);
});
</script>

<template>
  <div class="skill-market-panel">
    <Teleport defer to="#orch-asset-toolbar-host">
      <div class="skill-market-panel__toolbar">
        <a-input v-model:value="searchQuery" class="thread-list__search-input" placeholder="搜索技能..." allow-clear>
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-tooltip title="自定义接入">
          <a-button
            size="small"
            aria-label="自定义接入"
            :disabled="catalogOnly || !clientAvailable || !workspaceId || !canManageCustomMarketplace || sharedWorkspaceMaintenanceLocked"
            @click="openCustomModal"
          >
            <template #icon><PlusOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-button
          size="small"
          aria-label="刷新技能状态"
          :disabled="!clientAvailable || operating"
          :loading="loading || refreshHolding"
          @click="refreshSkillState"
        >
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </div>
    </Teleport>

    <Teleport defer to="#orch-skill-market-sidebar-host">
      <div class="skill-market-panel__sidebar">
        <div class="skill-market-panel__group-bar">
          <a-select v-model:value="listFilter" size="small" :options="filterOptions" aria-label="技能分组" />
        </div>
        <div v-if="loading && !suites.length" class="skill-market-panel__list-state">
          <a-spin size="small" />
          <span>加载中...</span>
        </div>
        <div v-else-if="loadError && !suites.length" class="skill-market-panel__list-state skill-market-panel__list-state--error">
          <span>加载失败，请点击上方刷新</span>
        </div>
        <div v-else class="skill-market-panel__list">
          <button
            v-for="suite in filteredSuites"
            :key="suite.suiteId"
            type="button"
            class="skill-market-panel__list-item"
            :class="{ 'skill-market-panel__list-item--active': selectedSuiteId === suite.suiteId }"
            @click="selectSuite(suite.suiteId)"
          >
            <span class="skill-market-panel__list-title">
              <strong>{{ suite.name }}</strong>
              <span class="skill-market-panel__tags">
                <a-tag v-if="suite.source === 'custom'" color="gold">自定义</a-tag>
                <a-tag v-else-if="suiteHasInstalled(suite.suiteId)" color="green">已安装</a-tag>
                <a-tag v-if="suite.recommended" color="blue">推荐</a-tag>
              </span>
            </span>
            <span class="skill-market-panel__list-description">{{ suite.description }}</span>
            <span class="skill-market-panel__list-meta">{{ suite.author }} · {{ installTypeLabel(suite.installType) }}</span>
          </button>
          <div v-if="!filteredSuites.length" class="skill-market-panel__empty">
            {{ searchQuery.trim() ? "无匹配结果" : "当前分组暂无技能" }}
          </div>
        </div>
      </div>
    </Teleport>

    <a-alert v-if="loadError && suites.length" class="skill-market-panel__notice" type="warning" show-icon message="技能状态刷新失败" :description="`${loadError} 当前显示上次成功加载的数据，可点击刷新重试。`" />
    <a-alert v-if="catalogOnly" class="skill-market-panel__notice" type="info" show-icon message="当前仅展示公共市场目录" description="当前没有可用的专属 Client 或工作区上下文，安装和操作已禁用。" />
    <a-alert v-if="sharedWorkspaceMaintenanceLocked" class="skill-market-panel__notice" type="warning" show-icon :message="sharedWorkspaceMaintenanceLockedMessage" :description="sharedWorkspaceMaintenanceLockedDescription" />

    <section v-if="loading && !suites.length" class="skill-market-panel__loading"><a-spin size="small" /> <span>正在加载技能...</span></section>
    <section v-else-if="loadError && !suites.length" class="skill-market-panel__load-error"><span>技能加载失败：{{ loadError }}</span><a-button size="small" @click="load({ force: true })">重新加载</a-button></section>
    <template v-else>
      <section class="skill-market-panel__detail">
        <template v-if="selectedSuite">
          <header class="skill-market-panel__detail-header">
            <div class="skill-market-panel__detail-title-row">
              <h2>{{ selectedSuite.name }}</h2>
              <a-tag v-if="selectedSuite.recommended" color="blue">推荐</a-tag>
              <a-tag v-if="selectedSuite.source === 'custom'" color="gold">自定义</a-tag>
            </div>
            <p>{{ selectedSuite.description }}</p>
            <div class="skill-market-panel__detail-meta">
              <span>作者：{{ selectedSuite.author }}</span>
              <span>类型：{{ installTypeLabel(selectedSuite.installType) }}</span>
              <a v-if="selectedSuite.homepage" :href="selectedSuite.homepage" target="_blank" rel="noopener noreferrer">项目主页</a>
            </div>
          </header>

          <section class="skill-market-panel__section">
            <div class="skill-market-panel__section-title">目标引擎</div>
            <div class="skill-market-panel__targets">
              <div v-for="target in suiteTargets(selectedSuite.suiteId)" :key="target.targetId" class="skill-market-panel__target-row">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                  <span style="font-weight: 600">{{ target.label }}</span>
                  <a-tag :color="target.ready ? 'green' : 'default'" style="margin: 0">{{ target.ready ? "Ready" : "Not Ready" }}</a-tag>
                </div>
                <div v-if="target.installed" style="font-size: 11px; color: var(--app-muted)">
                  {{ formatTime(target.installed.installedAt) }} · {{ target.installed.source }}
                </div>
                <div v-if="target.message" class="skill-market-panel__target-message">
                  {{ target.message }}
                </div>
              </div>
            </div>
          </section>

          <section class="skill-market-panel__actions">
            <div class="skill-market-panel__ops-form">
              <div class="skill-market-panel__ops-row">
                <span class="skill-market-panel__ops-label">安装目标</span>
                <a-checkbox-group
                  v-model:value="selectedTargets"
                  :disabled="sharedWorkspaceMaintenanceLocked"
                  :options="suiteTargets(selectedSuite.suiteId).map((target) => ({ label: target.label, value: target.targetId }))"
                />
              </div>
            </div>
            <div class="skill-market-panel__ops-actions">
              <a-button
                type="primary"
                :disabled="!canOperate"
                :loading="operating && operatingKind === 'install'"
                :title="suiteHasInstalled(selectedSuite.suiteId) ? '重新拉取来源最新内容并覆盖当前安装' : undefined"
                @click="runOp('install')"
              >{{ suiteHasInstalled(selectedSuite.suiteId) ? '更新' : '安装' }}</a-button>
              <a-button
                v-if="suiteHasInstalled(selectedSuite.suiteId)"
                danger
                :disabled="!canOperate"
                :loading="operating && operatingKind === 'uninstall'"
                @click="confirmUninstall"
              >卸载</a-button>
            </div>
          </section>

          <div v-if="lastOp" class="skill-market-panel__ops-result">
            <span class="skill-market-panel__ops-result-label">最近操作：{{ lastOp.kind === 'install' ? 'install' : 'uninstall' }} · {{ formatTime(lastOp.at) }}</span>
            <div class="skill-market-panel__ops-result-tags">
              <span v-for="item in lastOp.results" :key="item.targetId" class="skill-market-panel__ops-result-item">
                <a-tag :color="item.ok ? 'green' : 'red'" style="margin: 0">{{ item.targetId }}</a-tag>
                <span class="skill-market-panel__ops-result-msg">{{ item.ok ? "成功" : item.message ?? "失败" }}</span>
              </span>
            </div>
          </div>
        </template>

        <div v-else class="skill-market-panel__empty">{{ filteredSuites.length ? "请在左侧选择一个技能" : "当前分组暂无技能" }}</div>
      </section>
    </template>

    <a-modal v-model:open="customModalOpen" title="自定义 Skills 接入" :confirm-loading="customSaving" ok-text="安装" cancel-text="取消" @ok="submitCustom" @cancel="customModalOpen = false">
      <div class="skill-market-panel__form">
        <a-alert
          v-if="isSharedHostTarget"
          type="warning"
          show-icon
          message="共享工作区不支持本地目录安装源"
          description="安装会写入共享 Host Client，本机目录路径不可用，请改用 Git 仓库或下载链接。"
        />
        <label>
          <span>安装方式</span>
          <a-select v-model:value="customInstallType" style="width: 100%">
            <a-select-option value="github">GitHub 仓库</a-select-option>
            <a-select-option value="git">Git 仓库</a-select-option>
            <a-select-option value="local" :disabled="isSharedHostTarget">本地目录</a-select-option>
            <a-select-option value="url">下载链接</a-select-option>
          </a-select>
        </label>
        <label>
          <span>名称</span>
          <a-input v-model:value="customName" name="codeflow-custom-skill-name" autocomplete="new-password" placeholder="例如：团队内部 Skills" />
        </label>
        <label>
          <span>{{ customInstallType === 'github' ? 'GitHub 仓库' : customInstallType === 'git' ? 'Git 仓库 URL' : customInstallType === 'local' ? '本机目录路径' : '下载地址' }}</span>
          <a-input v-if="customInstallType === 'github'" v-model:value="customRepoUrl" autocomplete="off" placeholder="https://github.com/org/repo" />
          <a-input v-else-if="customInstallType === 'git'" v-model:value="customGitUrl" autocomplete="off" placeholder="https://gitlab.example.com/org/repo" />
          <div v-else-if="customInstallType === 'local'" class="skill-market-panel__local-path">
            <a-input v-model:value="customLocalPath" autocomplete="off" placeholder="/path/to/skills 或 ~/skills/team" />
            <a-button @click="openDirectoryPicker">
              <template #icon><FolderOpenOutlined /></template>
              浏览目录
            </a-button>
          </div>
          <a-input v-else v-model:value="customArchiveUrl" autocomplete="off" placeholder="https://example.com/skills.zip" />
        </label>
        <label v-if="customInstallType !== 'local'">
          <span>仓库/包内路径</span>
          <a-input v-model:value="customSkillsPath" autocomplete="off" placeholder="默认根目录，可选 skills" />
        </label>
        <label>
          <span>安装目标</span>
          <a-checkbox-group v-model:value="customTargets" :options="fallbackSkillTargets" />
        </label>
      </div>
    </a-modal>

    <ClientDirectoryPickerModal
      v-model:open="directoryPickerOpen"
      :client-id="directoryClientId"
      :initial-value="customLocalPath"
      @pick="onDirectoryPicked"
    />
  </div>
</template>

<style scoped>
.skill-market-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; color: var(--app-text, #1f2937); }
.skill-market-panel__notice { flex: 0 0 auto; width: fit-content; max-width: min(100%, 760px); margin-bottom: 10px; }
.skill-market-panel__loading, .skill-market-panel__load-error { flex: 1; min-height: 240px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--app-muted, #667085); }
.skill-market-panel__load-error { flex-direction: column; }
.skill-market-panel__toolbar { display: grid; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; min-width: 0; }
.skill-market-panel__toolbar :deep(.ant-btn) {
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--app-accent, #d97757) 22%, var(--app-border, #d9d9d9));
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-accent, #d97757) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent, #d97757) 82%, var(--app-text, #334155));
}
.skill-market-panel__toolbar :deep(.ant-btn:hover),
.skill-market-panel__toolbar :deep(.ant-btn:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent, #d97757) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent, #d97757) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
  outline: none;
}
.skill-market-panel__toolbar :deep(.ant-btn:disabled) { cursor: not-allowed; opacity: 0.4; }
.skill-market-panel__sidebar { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.skill-market-panel__group-bar { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 7px 10px; }
.skill-market-panel__group-bar :deep(.ant-select-selector) { height: 26px; align-items: center; }
.skill-market-panel__list { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.skill-market-panel__list-item { display: grid; width: 100%; min-width: 0; gap: 5px; padding: 10px; margin-bottom: 6px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.skill-market-panel__list-item:hover { background: color-mix(in srgb, var(--app-accent, #d97757) 4%, transparent); }
.skill-market-panel__list-item--active { border-color: var(--app-accent, #d97757); background: color-mix(in srgb, var(--app-accent, #d97757) 6%, transparent); }
.skill-market-panel__list-title { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: 8px; }
.skill-market-panel__list-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.skill-market-panel__tags { display: flex; flex: 0 0 auto; gap: 3px; }
.skill-market-panel__tags :deep(.ant-tag) { margin: 0; font-size: 10px; line-height: 17px; }
.skill-market-panel__list-description, .skill-market-panel__list-meta { overflow: hidden; color: var(--app-muted, #667085); font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.skill-market-panel__list-state { display: flex; flex: 1; min-height: 180px; align-items: center; justify-content: center; gap: 7px; color: var(--app-muted, #667085); font-size: 12px; }
.skill-market-panel__list-state--error { text-align: center; }
.skill-market-panel__empty { display: flex; min-height: 180px; height: 100%; align-items: center; justify-content: center; color: var(--app-muted, #667085); font-size: 13px; text-align: center; }
.skill-market-panel__detail { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 16px 20px; }
.skill-market-panel__detail-header { margin-bottom: 14px; }
.skill-market-panel__detail-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.skill-market-panel__detail-title-row h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 18px; line-height: 1.35; }
.skill-market-panel__detail-header p { margin: 4px 0 0; color: var(--app-muted, #667085); font-size: 12px; line-height: 1.5; }
.skill-market-panel__detail-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 7px; color: var(--app-muted, #667085); font-size: 11px; overflow-wrap: anywhere; }
.skill-market-panel__section { margin-bottom: 12px; }
.skill-market-panel__section-title { margin-bottom: 7px; font-size: 13px; font-weight: 700; }
.skill-market-panel__targets { display: grid; gap: 8px; }
.skill-market-panel__target-row { border: 1px solid var(--app-border, #e5e7eb); border-radius: 8px; padding: 8px 10px; display: grid; gap: 3px; }
.skill-market-panel__target-message { margin-top: 4px; color: var(--app-muted, #667085); font-size: 12px; line-height: 1.5; }
.skill-market-panel__actions { padding: 11px 12px; border: 1px solid var(--app-border, #e5e7eb); border-radius: 8px; background: color-mix(in srgb, var(--app-panel-bg, #fff) 82%, var(--app-bg, #fff)); margin-bottom: 14px; }
.skill-market-panel__ops-form { display: grid; gap: 12px; margin-bottom: 12px; }
.skill-market-panel__ops-row { display: flex; align-items: center; gap: 12px; }
.skill-market-panel__ops-label { font-size: 13px; font-weight: 500; color: var(--app-muted, #667085); min-width: 64px; flex-shrink: 0; }
.skill-market-panel__ops-actions { display: flex; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--app-divider, var(--app-border, #e5e7eb)); }
.skill-market-panel__ops-result { margin-bottom: 14px; padding: 10px 14px; border-radius: 8px; background: color-mix(in srgb, var(--app-muted) 5%, transparent); }
.skill-market-panel__ops-result-label { font-size: 12px; color: var(--app-muted, #667085); display: block; margin-bottom: 6px; }
.skill-market-panel__ops-result-tags { display: flex; gap: 8px; flex-wrap: wrap; }
.skill-market-panel__ops-result-item { display: inline-flex; align-items: center; gap: 4px; }
.skill-market-panel__ops-result-msg { font-size: 12px; color: var(--app-muted, #667085); }
.skill-market-panel__form { display: grid; gap: 12px; }
.skill-market-panel__form label { display: grid; gap: 6px; }
.skill-market-panel__form label > span { font-size: 12px; font-weight: 600; color: var(--app-muted, #667085); }
.skill-market-panel__local-path { display: flex; gap: 8px; align-items: center; }
.skill-market-panel__local-path .ant-input { flex: 1; min-width: 0; }
@media (max-width: 720px) { .skill-market-panel { height: auto; min-height: 0; overflow: visible; } .skill-market-panel__detail { min-height: 360px; padding: 16px 0 0; } }
</style>
