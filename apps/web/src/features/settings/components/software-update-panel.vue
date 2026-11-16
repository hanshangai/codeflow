<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import type {
  EngineType,
  NpmInstallAttempt,
  NpmInstallNetworkOptions,
  NpmInstallSourceMode,
  SoftwareInstallEnvironment,
  SoftwareInstallPlatform,
  SoftwareUpdateStatus,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { isCancelledRequestError } from "../../../api/request";
import { useConfigStore } from "../../../store/config";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { useEngineStore } from "../../../store/engine";
import { useWorkspacesStore } from "../../../store/workspaces";
import { getSoftwareUpdateStatus, npmInstall } from "../../../api/software";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { softwareUpdateSnapshots } from "./softwareUpdateCache";
import { isCliAutoUpdateEnabled, setCliAutoUpdateEnabled } from "../cliAutoUpdate";
import { canLoadSoftwareUpdateStatus, resolveSoftwareUpdateWorkspaceId, type SoftwareUpdateScope } from "../softwareUpdateScope";
import { isDesktopWorkspace } from "../../../services/desktop";
import { copyToClipboard } from "../../../composables/useClipboard";
import CommandBlock from "../../landing/components/CommandBlock.vue";
import {
  formatCliInstallSize,
  isPrivateInstallMode,
  privateInstallActionLabel,
  privateInstallUpdateAvailable,
} from "../softwareInstallPresentation";
import {
  ANTHROPIC_RELAY_TARGET,
  CODEX_RELAY_TARGET,
  type BuiltInRelayAvailability,
  type BuiltInRelayTarget,
  useBuiltInRelayKey,
} from "../composables/useBuiltInRelayKey";

/** 接口返回前的引擎卡片骨架；只让版本等探测结果等待加载。 */
const DEFAULT_ENGINE_ITEMS: SoftwareUpdateStatus[] = [
  { engineType: "claude", installed: false, currentVersion: null, latestVersion: null, binPath: null,
    npmPackage: "@anthropic-ai/claude-code", updateAvailable: false, error: null },
  { engineType: "codex", installed: false, currentVersion: null, latestVersion: null, binPath: null,
    npmPackage: "@openai/codex", updateAvailable: false, error: null },
];

defineOptions({ name: "SoftwareUpdatePanel" });

const props = withDefaults(defineProps<{
  active?: boolean;
  autoEnableBuiltInRelayOnFreshInstall?: boolean;
  /** 嵌入基础设置时隐藏刷新/安装源说明，并将引擎卡片横向排布。 */
  compact?: boolean;
}>(), {
  active: true,
  autoEnableBuiltInRelayOnFreshInstall: true,
  compact: false,
});

const configStore = useConfigStore();
/** 本机 Client 就绪即可检测和安装 CLI，不依赖 Server 登录或工作区选择。 */
const updateScope = computed<SoftwareUpdateScope>(() => {
  const workspaceId = String(configStore.workspaceId ?? "").trim();
  return {
    connected: configStore.connected,
    isDesktop: configStore.isDesktop,
    localRuntimeReady: configStore.localRuntimeReady,
    workspaceId,
    workspaceIsLocal: isDesktopWorkspace(configStore, workspaceId),
  };
});
const canLoadSoftwareStatus = computed(() => canLoadSoftwareUpdateStatus(updateScope.value));
const softwareWorkspaceId = computed(() => resolveSoftwareUpdateWorkspaceId(updateScope.value));
const engineKeys = useEngineKeysStore();
const engineStore = useEngineStore();
const workspaces = useWorkspacesStore();
const builtInRelay = useBuiltInRelayKey();
const { ctx } = useApiContext();

/** 本机 CLI 状态是全局能力；连接 Server 时仍按原工作区快照隔离。 */
const cachedSnapshot = softwareUpdateSnapshots.get(softwareWorkspaceId.value) ?? null;
const loading = ref(false);
const statusReady = ref(Boolean(cachedSnapshot));
const items = ref<SoftwareUpdateStatus[]>(cachedSnapshot?.items ?? []);
const installEnvironment = ref<SoftwareInstallEnvironment | null>(cachedSnapshot?.environment ?? null);
/** 正在执行 npm install 的包名（null 表示未执行） */
const installingPackage = ref<string | null>(null);
const relaySyncingEngine = ref<EngineType | null>(null);
const relayAvailabilityLoading = ref(false);
const relayAvailability = ref<BuiltInRelayAvailability>({ available: false, message: "" });
const RELAY_IMPLEMENTATION_NAME_PATTERN = new RegExp(["sub2", "api"].join(""), "gi");
const lastResult = ref<{
  npmPackage: string;
  success: boolean;
  output: string;
  error: string | null;
  message?: string | null;
  noUpgradeNeeded?: boolean;
  attempts?: NpmInstallAttempt[];
} | null>(null);
const privilegeDialogOpen = ref(false);
const privilegeDialogItem = ref<SoftwareUpdateStatus | null>(null);
const installSourceMode = ref<NpmInstallSourceMode>("auto");
const installProxyUrl = ref("");
const autoUpdateCli = ref(isCliAutoUpdateEnabled());
watch(autoUpdateCli, value => setCliAutoUpdateEnabled(value));
const installInProgress = computed(() => Boolean(installingPackage.value));
const relaySyncInProgress = computed(() => Boolean(relaySyncingEngine.value));
const canUseBuiltInRelay = computed(() => relayAvailability.value.available && !relayAvailabilityLoading.value);

/** 安装和中转请求捕获原所有者；账号、Server 或工作区改变后不续写。 */
function captureRelayScope(): () => boolean {
  const scope = [configStore.serverWsOrigin, configStore.sessionToken, configStore.userSummary?.userId, configStore.workspaceId, configStore.desktopCloudAccount?.generation];
  return () => !configStore.logoutInProgress && scope.every((value, index) => value === [configStore.serverWsOrigin, configStore.sessionToken, configStore.userSummary?.userId, configStore.workspaceId, configStore.desktopCloudAccount?.generation][index]);
}
/** 私有安装模式不依赖 npm 全局目录，也不展示 sudo 引导。 */
const isPrivateMode = computed(() => isPrivateInstallMode(installEnvironment.value));
const needsPrivilegePrompt = computed(() => !isPrivateMode.value && isPrivilegeEnvironment(installEnvironment.value));
const privilegeDialogCommand = computed(() =>
  privilegeDialogItem.value ? buildPrivilegeInstallCommand(privilegeDialogItem.value) : "",
);
const privilegePlatformLabel = computed(() => platformLabel(installEnvironment.value?.platform ?? "unknown"));
const installSourceOptions = [
  { label: "自动推荐：国内镜像 -> 官方源 -> 代理", value: "auto" },
  { label: "国内镜像", value: "npmmirror" },
  { label: "官方源", value: "official" },
  { label: "官方源 + 代理", value: "proxyOfficial" },
  { label: "继承本机 npm 配置", value: "inherit" },
];
const proxyInputVisible = computed(() => installSourceMode.value === "auto" || installSourceMode.value === "proxyOfficial");
const proxyInputRequired = computed(() => installSourceMode.value === "proxyOfficial");

const isCurrentSharedWorkspace = computed(() => {
  const workspaceId = String(configStore.workspaceId ?? "").trim();
  const workspace = workspaces.byId.get(workspaceId as any) ?? null;
  return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
});

type DisplayEngineItem = SoftwareUpdateStatus & { pending?: boolean };
/** 可读取本机状态时先渲染两张骨架卡片，避免整块区域先空白再跳出。 */
const showEngineCards = computed(() => !isCurrentSharedWorkspace.value && canLoadSoftwareStatus.value);
const displayItems = computed<DisplayEngineItem[]>(() => {
  if (items.value.length) return items.value;
  if (!showEngineCards.value || statusReady.value) return [];
  return DEFAULT_ENGINE_ITEMS.map((item) => ({ ...item, pending: true }));
});

/** 映射 CLI 引擎到默认内置中转供应商。 */
function builtInRelayTargetForEngine(engine: EngineType): BuiltInRelayTarget {
  return engine === "codex" ? CODEX_RELAY_TARGET : ANTHROPIC_RELAY_TARGET;
}

/** 规整内置中转错误文案，避免实现名透出到安装向导。 */
function toBuiltInRelayDisplayText(value: unknown): string {
  return String(value ?? "")
    .replace(RELAY_IMPLEMENTATION_NAME_PATTERN, "内置中转")
    .replace(/Relay|RELAY|relay/g, "内置中转");
}

/** 判断该引擎是否已有任意本地 Key，避免新安装自动覆盖历史配置。 */
function hasAnyEngineKey(engine: EngineType): boolean {
  return engineKeys.hasKeysForEngine(engine);
}

/** 判断该引擎是否已有已启用默认 Key。 */
function hasActiveEngineKey(engine: EngineType): boolean {
  return engineKeys.providerIdsForEngine(engine).length > 0;
}

/** 清空安装页中转运行态，避免离线/退出登录后继续展示旧入口。 */
function resetBuiltInRelayAvailability(): void {
  relayAvailabilityLoading.value = false;
  relayAvailability.value = { available: false, message: "" };
}

/** 为安装卡片生成 Key 状态标签。 */
function engineKeyStatusLabel(item: SoftwareUpdateStatus): string {
  if (!item.installed) {
    if (hasAnyEngineKey(item.engineType)) return "保留已有 Key";
    return props.autoEnableBuiltInRelayOnFreshInstall && configStore.isAccountSession
      && Boolean(softwareWorkspaceId.value) && canUseBuiltInRelay.value ? "安装后自动配置" : "需配置 Key";
  }
  if (hasActiveEngineKey(item.engineType)) return "Key 已启用";
  if (hasAnyEngineKey(item.engineType)) return "Key 待切换";
  return "Key 未配置";
}

/** 为安装卡片生成 Key 状态颜色。 */
function engineKeyStatusColor(item: SoftwareUpdateStatus): string {
  if (!item.installed) return hasAnyEngineKey(item.engineType) ? "gold" : canUseBuiltInRelay.value ? "blue" : "default";
  if (hasActiveEngineKey(item.engineType)) return "green";
  if (hasAnyEngineKey(item.engineType)) return "gold";
  return "default";
}

/** 已安装引擎缺少默认 Key 时给出明确处理入口。 */
function engineKeyNotice(item: SoftwareUpdateStatus): string {
  if (!item.installed) return "";
  if (hasActiveEngineKey(item.engineType)) return "";
  if (hasAnyEngineKey(item.engineType)) return "已检测到本地 Key，但当前引擎没有启用默认 Key，请到大模型 KEY 设置中切换。";
  if (!canUseBuiltInRelay.value) return "已安装该引擎，但尚未配置 Key。请到大模型 KEY 设置中添加自备凭证。";
  return "已安装该引擎，但尚未配置 Key。为避免覆盖历史用户配置，请手动启用内置中转。";
}

/** 只有已安装且无任意本地 Key 时，才在 CLI 设置里提供手动启用入口。 */
function canOfferBuiltInRelayAction(item: SoftwareUpdateStatus): boolean {
  return item.installed && !hasAnyEngineKey(item.engineType) && configStore.isAccountSession
    && Boolean(softwareWorkspaceId.value) && canUseBuiltInRelay.value;
}

/** 判断当前环境是否应切换为终端 sudo 引导。 */
function isPrivilegeEnvironment(environment: SoftwareInstallEnvironment | null): boolean {
  if (!environment) return false;
  return (environment.platform === "mac" || environment.platform === "linux") && environment.requiresPrivilege;
}

/** 将平台枚举转换为界面可读文案。 */
function platformLabel(platform: SoftwareInstallPlatform): string {
  if (platform === "mac") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "windows") return "Windows";
  return "当前系统";
}

/** 构造 npm 安装请求的网络选项。 */
function buildInstallNetworkOptions(): NpmInstallNetworkOptions {
  const proxyUrl = installProxyUrl.value.trim();
  return { mode: installSourceMode.value, proxyUrl: proxyUrl || null };
}

/** 校验当前安装网络配置，避免生成不可用安装命令。 */
function validateInstallNetworkOptions(network: NpmInstallNetworkOptions): boolean {
  if (network.mode === "proxyOfficial" && !network.proxyUrl) {
    message.warning("请选择“官方源 + 代理”时需要填写代理地址");
    return false;
  }
  return true;
}

/** 生成安装源展示文案。 */
function installSourceLabel(source: NpmInstallSourceMode): string {
  if (source === "auto") return "自动推荐";
  if (source === "npmmirror") return "国内镜像";
  if (source === "official") return "官方源";
  if (source === "proxyOfficial") return "官方源 + 代理";
  return "继承本机 npm 配置";
}

/** Shell 单引号转义，用于生成可复制的 sudo env 命令。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 生成指定安装源的 sudo npm 命令。 */
function buildPrivilegeInstallCommandForSource(
  item: SoftwareUpdateStatus,
  source: Exclude<NpmInstallSourceMode, "auto">,
): string {
  const env: Record<string, string> = {
    npm_config_optional: "true",
    npm_config_include: "optional",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  if (source === "npmmirror") {
    env.npm_config_registry = "https://registry.npmmirror.com";
    env.npm_config_replace_registry_host = "always";
  }
  if (source === "official" || source === "proxyOfficial") {
    env.npm_config_registry = "https://registry.npmjs.org/";
    env.npm_config_replace_registry_host = "never";
  }
  if (source === "proxyOfficial") {
    const proxyUrl = installProxyUrl.value.trim();
    if (proxyUrl) {
      env.HTTP_PROXY = proxyUrl;
      env.HTTPS_PROXY = proxyUrl;
      env.NO_PROXY = "localhost,127.0.0.1,::1";
      env.npm_config_proxy = proxyUrl;
      env.npm_config_https_proxy = proxyUrl;
    }
  }
  const envArgs = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ");
  return `sudo env ${envArgs} npm install -g ${shellQuote(item.npmPackage)} --include=optional --no-audit --no-fund`;
}

/** 构造当前引擎的终端提权安装命令。 */
function buildPrivilegeInstallCommand(item: SoftwareUpdateStatus): string {
  const mode = installSourceMode.value;
  if (mode !== "auto") return buildPrivilegeInstallCommandForSource(item, mode);
  const commands = [
    buildPrivilegeInstallCommandForSource(item, "npmmirror"),
    buildPrivilegeInstallCommandForSource(item, "official"),
  ];
  if (installProxyUrl.value.trim()) commands.push(buildPrivilegeInstallCommandForSource(item, "proxyOfficial"));
  return commands.join("\n\n# 如果上一步失败，再执行：\n");
}

/** 打开 sudo 引导弹框，让用户在本机终端完成安装。 */
function openPrivilegeDialog(item: SoftwareUpdateStatus): void {
  privilegeDialogItem.value = item;
  privilegeDialogOpen.value = true;
}

/** 关闭 sudo 引导弹框并清空当前命令上下文。 */
function closePrivilegeDialog(): void {
  privilegeDialogOpen.value = false;
  privilegeDialogItem.value = null;
}

/** 复制 sudo 命令，减少用户手工输入。 */
async function copyPrivilegeCommand(): Promise<void> {
  if (!privilegeDialogCommand.value) return;
  try {
    await copyToClipboard(privilegeDialogCommand.value);
    message.success("已复制终端命令");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "复制命令失败");
  }
}

/** 用户在终端执行完命令后，重新检测本机安装状态。 */
async function reloadAfterPrivilegeInstall(): Promise<void> {
  const loaded = await load({ forceRefresh: true });
  if (loaded) closePrivilegeDialog();
}

/** 判断当前卡片是否应走终端 sudo 引导，而不是静默安装。 */
function installRequiresPrivilege(item: SoftwareUpdateStatus): boolean {
  return !isPrivateMode.value && needsPrivilegePrompt.value && (!item.installed || item.updateAvailable);
}

/** 从失败信息中识别权限错误，兜底切回 sudo 引导。 */
function looksLikePrivilegeError(errorText: string | null | undefined): boolean {
  const normalized = String(errorText ?? "").toLowerCase();
  if (!normalized) return false;
  return normalized.includes("eacces")
    || normalized.includes("permission denied")
    || normalized.includes("operation not permitted")
    || normalized.includes("sudo");
}

/** 刷新本地 Engine Key 状态，供自动启用和提示文案使用。 */
async function refreshEngineKeys(workspaceId: string): Promise<void> {
  await engineKeys.refresh(ctx.value, workspaceId, captureRelayScope());
}

/** 读取网页端中转配置运行态，CLI 安装页只在可用时提供内置中转动作。 */
async function loadBuiltInRelayAvailability(options: { notifyOnError?: boolean } = {}): Promise<void> {
  const isCurrent = captureRelayScope();
  if (!props.active || !(configStore.isDesktop ? configStore.desktopCloudAccountLinked : configStore.connected) || !configStore.isAccountSession) {
    resetBuiltInRelayAvailability();
    return;
  }
  relayAvailabilityLoading.value = true;
  relayAvailability.value = { available: false, message: relayAvailability.value.message };
  try {
    const availability = await builtInRelay.getBuiltInRelayAvailability();
    if (isCurrent()) relayAvailability.value = availability;
  } catch (error) {
    if (!isCurrent() || isCancelledRequestError(error)) return;
    const text = toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)) || "内置中转状态读取失败";
    relayAvailability.value = { available: false, message: text };
    if (options.notifyOnError) message.warning(text);
  } finally {
    if (isCurrent()) relayAvailabilityLoading.value = false;
  }
}

/** 新安装前判定是否允许安装成功后自动启用内置中转。 */
async function resolveAutoRelayTargetBeforeInstall(item: SoftwareUpdateStatus): Promise<BuiltInRelayTarget | null> {
  const isCurrent = captureRelayScope();
  if (!props.autoEnableBuiltInRelayOnFreshInstall) return null;
  if (item.installed) return null;
  if (!configStore.isAccountSession) return null;
  const workspaceId = softwareWorkspaceId.value;
  if (!workspaceId) return null;
  await refreshEngineKeys(workspaceId);
  if (!isCurrent()) return null;
  if (hasAnyEngineKey(item.engineType)) return null;
  await loadBuiltInRelayAvailability({ notifyOnError: true });
  if (!isCurrent()) return null;
  if (!canUseBuiltInRelay.value) return null;
  return builtInRelayTargetForEngine(item.engineType);
}

/** 为已安装但未配置 Key 的引擎手动同步内置中转。 */
async function syncBuiltInRelayForInstalledEngine(item: SoftwareUpdateStatus): Promise<void> {
  const isCurrent = captureRelayScope();
  const workspaceId = softwareWorkspaceId.value;
  if (!canOfferBuiltInRelayAction(item)) return;
  if (!canUseBuiltInRelay.value) {
    await loadBuiltInRelayAvailability({ notifyOnError: true });
    if (!isCurrent()) return;
    if (!canUseBuiltInRelay.value) return;
  }
  const target = builtInRelayTargetForEngine(item.engineType);
  relaySyncingEngine.value = item.engineType;
  try {
    await builtInRelay.syncBuiltInRelayKey(target, workspaceId, isCurrent);
    if (isCurrent()) message.success(`${engineLabel(item)} 内置中转 Key 已启用`);
  } catch (error) {
    if (isCurrent() && !isCancelledRequestError(error)) message.error(toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)));
  } finally {
    relaySyncingEngine.value = null;
  }
}

/** 新装引擎成功后自动启用内置中转，但只处理安装前无 Key 的场景。 */
async function syncBuiltInRelayAfterFreshInstall(item: SoftwareUpdateStatus, target: BuiltInRelayTarget | null, workspaceId: string, isCurrent: () => boolean): Promise<void> {
  if (!target || !isCurrent()) return;
  relaySyncingEngine.value = item.engineType;
  try {
    await builtInRelay.syncBuiltInRelayKey(target, workspaceId, isCurrent, { intent: "auto" });
    if (isCurrent()) message.success(`${engineLabel(item)} 已自动启用内置中转 Key`);
  } finally {
    relaySyncingEngine.value = null;
  }
}

/** 加载软件更新状态，并同步聊天区依赖的引擎状态缓存。 */
async function load(options: { forceRefresh?: boolean } = {}): Promise<boolean> {
  if (!props.active) return false;
  if (!canLoadSoftwareStatus.value) {
    statusReady.value = false;
    resetBuiltInRelayAvailability();
    return false;
  }
  if (isCurrentSharedWorkspace.value) {
    items.value = [];
    installEnvironment.value = null;
    statusReady.value = false;
    resetBuiltInRelayAvailability();
    return false;
  }
  loading.value = true;
  // 无缓存时先展示骨架卡片，只有探测结果等待返回。
  if (!items.value.length) statusReady.value = false;
  const targetWorkspaceId = softwareWorkspaceId.value;
  try {
    const res = await getSoftwareUpdateStatus(
      ctx.value,
      { network: buildInstallNetworkOptions(), forceRefresh: options.forceRefresh },
      targetWorkspaceId,
    );
    if (softwareWorkspaceId.value !== targetWorkspaceId) return false;
    if (!res.ok) throw new Error(res.message);
    items.value = res.items;
    installEnvironment.value = res.environment;
    statusReady.value = true;
    softwareUpdateSnapshots.set(targetWorkspaceId, { items: res.items, environment: res.environment });
    // Key、内置中转和引擎状态属于账号/工作区能力，不能阻塞本机 CLI 检测与安装。
    // 无工作区时显式清空 Key 作用域，避免复用上一个工作区的标签。
    await refreshEngineKeys(targetWorkspaceId);
    await loadBuiltInRelayAvailability();
    if (targetWorkspaceId) {
      await engineStore.refresh(ctx.value, targetWorkspaceId);
      if (engineStore.lastError) throw new Error(engineStore.lastError);
    }
    return true;
  } catch (e) {
    statusReady.value = true;
    message.error(e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    loading.value = false;
  }
}

/** 执行 CLI 安装/更新；新安装且无本地 Key 时串联启用内置中转。 */
async function doInstall(item: SoftwareUpdateStatus): Promise<void> {
  const isCurrent = captureRelayScope();
  const workspaceId = softwareWorkspaceId.value;
  const requestContext = { ...ctx.value };
  if (installInProgress.value) return;
  if (isCurrentSharedWorkspace.value) {
    message.warning("共享工作区不支持大模型 CLI 更新，请在 Host 本地工作区或 Client 管理入口操作");
    return;
  }
  const network = buildInstallNetworkOptions();
  if (!validateInstallNetworkOptions(network)) return;
  lastResult.value = null;
  try {
    const autoRelayTarget = await resolveAutoRelayTargetBeforeInstall(item);
    if (!isCurrent()) return;
    installingPackage.value = item.npmPackage;
    const res = await npmInstall(requestContext, { npmPackage: item.npmPackage, network }, workspaceId);
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(res.message);
    lastResult.value = {
      npmPackage: res.npmPackage,
      success: res.success,
      output: res.output,
      error: res.error,
      message: res.message ?? null,
      noUpgradeNeeded: res.noUpgradeNeeded,
      attempts: res.attempts,
    };
    if (res.noUpgradeNeeded) {
      message.info(res.message ?? `${item.npmPackage} 已是最新，无需升级`);
      const loaded = await load({ forceRefresh: true });
      if (!loaded) return;
      return;
    }
    if (res.success) {
      message.success(`${item.npmPackage} 安装/更新成功`);
      const loaded = await load({ forceRefresh: true });
      if (!loaded) return;
      await syncBuiltInRelayAfterFreshInstall(item, autoRelayTarget, workspaceId, isCurrent);
    } else if (res.requiresPrivilege) {
      openPrivilegeDialog(item);
      message.warning(`${item.npmPackage} 需要管理员权限，请在终端执行 sudo 命令`);
      await load();
    } else {
      message.error(`${item.npmPackage} 安装/更新失败：${res.error ?? "未知错误"}`);
      await load();
    }
  } catch (e) {
    if (!isCurrent() || isCancelledRequestError(e)) return;
    const errorText = toBuiltInRelayDisplayText(e instanceof Error ? e.message : String(e));
    if (!isPrivateMode.value && looksLikePrivilegeError(errorText) && (installEnvironment.value?.platform === "mac" || installEnvironment.value?.platform === "linux")) {
      openPrivilegeDialog(item);
      message.warning(`${item.npmPackage} 需要管理员权限，请在终端执行 sudo 命令`);
    } else {
      message.error(errorText);
    }
  } finally {
    installingPackage.value = null;
  }
}

/** 根据当前环境在静默安装和 sudo 引导之间分流。 */
function handleInstallAction(item: SoftwareUpdateStatus): void {
  if (!validateInstallNetworkOptions(buildInstallNetworkOptions())) return;
  if (installRequiresPrivilege(item)) {
    openPrivilegeDialog(item);
    return;
  }
  void doInstall(item);
}

function engineLabel(item: SoftwareUpdateStatus): string {
  return item.engineType === "claude" ? "Claude Code" : "Codex CLI";
}

function actionLabel(item: SoftwareUpdateStatus): string {
  if (isPrivateMode.value) return privateInstallActionLabel(item, true);
  if (installRequiresPrivilege(item)) {
    return !item.installed ? "sudo 安装" : "sudo 更新";
  }
  if (!item.installed) return "安装";
  if (item.updateAvailable) return "更新";
  return "已是最新";
}

watch(
  () => [props.active, canLoadSoftwareStatus.value, softwareWorkspaceId.value, configStore.isAccountSession, isCurrentSharedWorkspace.value] as const,
  ([active, connected, workspaceId, accountSession, sharedWorkspace], previous) => {
    const [prevActive, prevConnected, prevWorkspaceId, prevAccountSession, prevSharedWorkspace] = previous ?? [undefined, undefined, undefined, undefined, undefined];
    if (!active || !connected) {
      statusReady.value = false;
      resetBuiltInRelayAvailability();
      return;
    }
    if (sharedWorkspace) {
      items.value = [];
      installEnvironment.value = null;
      statusReady.value = false;
      resetBuiltInRelayAvailability();
      return;
    }
    if (
      prevActive === active
      && prevConnected === connected
      && prevWorkspaceId === workspaceId
      && prevAccountSession === accountSession
      && prevSharedWorkspace === sharedWorkspace
    ) return;
    const mergeCached = (): boolean => {
      const cached = softwareUpdateSnapshots.get(String(workspaceId ?? ""));
      if (!cached) return false;
      items.value = cached.items;
      installEnvironment.value = cached.environment;
      statusReady.value = true;
      return true;
    };
    // 仅重新进入面板且作用域未变化时直接复用快照，避免标签闪烁；手动刷新仍强制检测。
    const scopeUnchanged = prevWorkspaceId === undefined
      || (prevWorkspaceId === workspaceId && prevConnected === connected
        && prevAccountSession === accountSession && prevSharedWorkspace === sharedWorkspace);
    if (scopeUnchanged && mergeCached()) return;
    if (prevWorkspaceId !== undefined && prevWorkspaceId !== workspaceId && mergeCached()) return;
    void load();
  },
  { immediate: true },
);

watch(() => [configStore.serverWsOrigin, configStore.sessionToken, configStore.userSummary?.userId, configStore.desktopCloudAccountLinked, configStore.desktopCloudAccount?.generation] as const, () => {
  resetBuiltInRelayAvailability();
  void loadBuiltInRelayAvailability();
});
</script>

<template>
  <div class="swupd" :class="{ 'swupd--compact': compact }">
    <a-alert
      v-if="isCurrentSharedWorkspace"
      class="swupd__notice"
      type="info"
      show-icon
      message="共享工作区不支持大模型 CLI 更新"
      description="CLI 安装、更新和 Client 维护属于 Host 本机能力，请切换到 Host 本地工作区或使用 Client 管理入口操作。"
    />

    <template v-else>
    <div v-if="!compact" style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap">
      <a-button :disabled="!canLoadSoftwareStatus || installInProgress || relaySyncInProgress" :loading="loading" @click="load({ forceRefresh: true })">刷新</a-button>
      <a-tag v-if="isPrivateMode" color="blue">应用私有</a-tag>
      <span style="font-size: 12px; color: var(--app-muted)">
        {{ isPrivateMode ? "检测应用私有 CLI 安装状态与固定版本" : "检测本机 CLI 安装状态与 npm 最新版本" }}
      </span>
    </div>

    <div v-if="!compact" class="swupd__network">
      <div class="swupd__network-item">
        <span class="swupd__network-label">安装源</span>
        <a-select
          v-model:value="installSourceMode"
          :options="installSourceOptions"
          style="min-width: 260px"
          :disabled="installInProgress || relaySyncInProgress"
        />
      </div>
      <div v-if="proxyInputVisible" class="swupd__network-item swupd__network-proxy">
        <span class="swupd__network-label">代理</span>
        <a-input
          v-model:value="installProxyUrl"
          :placeholder="proxyInputRequired ? '必填，例如 http://127.0.0.1:7890' : '可选，例如 http://127.0.0.1:7890'"
          allow-clear
          :disabled="installInProgress || relaySyncInProgress"
        />
      </div>
      <div class="swupd__network-tip">
        安装时只对本次 npm 子进程临时设置 registry / proxy，不会修改客户机器的全局 npm 配置。
      </div>
    </div>

    <a-alert
      v-if="needsPrivilegePrompt"
      type="warning"
      show-icon
      message="当前 npm 全局目录不可写，浏览器无法代替终端输入 sudo 密码。"
      :description="`请点击对应 CLI 的“sudo 安装/更新”，在 ${privilegePlatformLabel} 终端执行命令后再回到这里重新检测。`"
    />

    <a-alert
      v-if="installingPackage"
      type="info"
      show-icon
      :message="`正在安装/更新 ${installingPackage}，其它 CLI 更新已暂时禁用。`"
    />

    <a-alert
      v-if="relaySyncingEngine"
      type="info"
      show-icon
      :message="`正在同步 ${relaySyncingEngine === 'codex' ? 'Codex CLI' : 'Claude Code'} 内置中转 Key。`"
    />

    <a-spin :spinning="loading && displayItems.length === 0" style="min-height: 120px">
      <div class="swupd__items">
        <div
          v-for="item in displayItems"
          :key="item.engineType"
          style="border: 1px solid var(--app-border); border-radius: 12px; padding: 12px; background: var(--app-panel-bg); display: grid; gap: 8px"
        >
          <div style="display: flex; align-items: flex-start; gap: 8px">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0">
              <div style="font-weight: 600; font-size: 14px">{{ engineLabel(item) }}</div>
              <a-tag v-if="item.pending" color="default">检测中</a-tag>
              <template v-else>
                <a-tag :color="item.installed ? 'green' : 'default'">{{ item.installed ? "已安装" : "未安装" }}</a-tag>
                <a-tag v-if="item.updateAvailable || privateInstallUpdateAvailable(item, isPrivateMode)" color="orange">有更新</a-tag>
                <a-tag v-if="installRequiresPrivilege(item)" color="gold">需要管理员权限</a-tag>
                <a-tag :color="engineKeyStatusColor(item)">{{ engineKeyStatusLabel(item) }}</a-tag>
              </template>
            </div>
            <a-button
              style="margin-left: auto; flex-shrink: 0"
              :type="item.pending ? 'default' : (!item.installed || item.updateAvailable || isPrivateMode ? 'primary' : 'default')"
              :disabled="item.pending || !canLoadSoftwareStatus || installInProgress || relaySyncInProgress || (!isPrivateMode && item.installed && !item.updateAvailable)"
              :loading="installingPackage === item.npmPackage"
              @click="handleInstallAction(item)"
            >
              {{ item.pending ? "检测中" : actionLabel(item) }}
            </a-button>
          </div>

          <div v-if="compact" style="display: grid; gap: 2px; font-size: 12px; color: var(--app-muted)">
            <div v-if="item.pending">当前版本：检测中… · 最新版本：检测中…</div>
            <div v-else>
              当前版本：<span class="mono">{{ item.currentVersion ?? "-" }}</span>
              · 最新版本：<span class="mono">{{ item.latestVersion ?? "-" }}</span>
            </div>
            <div>npm 包：<span class="mono">{{ item.npmPackage }}</span></div>
            <div v-if="item.pending && isPrivateMode">预计占用：检测中…</div>
            <div v-else-if="isPrivateMode && formatCliInstallSize(item.installSizeBytes)">
              预计占用：<span class="mono">{{ formatCliInstallSize(item.installSizeBytes) }}</span>
            </div>
            <div v-if="!item.pending && item.binPath" class="swupd__path" :title="item.binPath">路径：<span class="mono">{{ item.binPath }}</span></div>
          </div>
          <div v-else style="display: grid; gap: 4px; font-size: 12px; color: var(--app-muted)">
            <div>npm 包：<span class="mono">{{ item.npmPackage }}</span></div>
            <div v-if="item.pending">当前版本：检测中… · 最新版本：检测中…</div>
            <template v-else>
              <div>当前版本：<span class="mono">{{ item.currentVersion ?? "-" }}</span></div>
              <div>最新版本：<span class="mono">{{ item.latestVersion ?? "-" }}</span></div>
              <div v-if="isPrivateMode && formatCliInstallSize(item.installSizeBytes)">
                预计占用：<span class="mono">{{ formatCliInstallSize(item.installSizeBytes) }}</span>
              </div>
              <div v-if="item.binPath" class="swupd__path">路径：<span class="mono">{{ item.binPath }}</span></div>
            </template>
          </div>

          <a-alert v-if="!item.pending && item.error" type="warning" show-icon :message="item.error" />

          <div v-if="!item.pending && engineKeyNotice(item) && (!compact || canOfferBuiltInRelayAction(item))" class="swupd__key-notice">
            <span v-if="!compact">{{ engineKeyNotice(item) }}</span>
            <a-button
              v-if="canOfferBuiltInRelayAction(item)"
              size="small"
              :loading="relaySyncingEngine === item.engineType"
              :disabled="installInProgress || relaySyncInProgress"
              @click="syncBuiltInRelayForInstalledEngine(item)"
            >
              启用内置中转
            </a-button>
          </div>
        </div>
      </div>
    </a-spin>

    <div v-if="configStore.isDesktop" class="swupd__auto-update">
      <a-checkbox v-model:checked="autoUpdateCli">自动更新</a-checkbox>
      <span>桌面启动时后台检查并更新已安装的 CLI</span>
    </div>

    <div v-if="!loading && displayItems.length === 0" style="font-size: 12px; color: var(--app-muted); text-align: center; padding: 20px 0">
      {{ compact ? "暂无可检测的引擎" : '暂无数据，请点击"刷新"检测' }}
    </div>

    <div v-if="lastResult" style="border-top: 1px solid var(--app-divider); padding-top: 10px; display: grid; gap: 6px">
      <div style="font-size: 12px; color: var(--app-muted)">
        最近操作：{{ lastResult.npmPackage }}
        <a-tag :color="lastResult.noUpgradeNeeded ? 'blue' : (lastResult.success ? 'green' : 'red')" style="margin-left: 6px">
          {{ lastResult.noUpgradeNeeded ? "无需升级" : (lastResult.success ? "成功" : "失败") }}
        </a-tag>
      </div>
      <div v-if="lastResult.message" style="font-size: 12px; color: var(--app-muted)">提示：{{ lastResult.message }}</div>
      <div v-if="lastResult.error" style="font-size: 12px; color: var(--app-muted)">错误：{{ lastResult.error }}</div>
      <div v-if="lastResult.attempts?.length" class="swupd__attempts">
        <div v-for="attempt in lastResult.attempts" :key="`${attempt.source}-${attempt.durationMs}`" class="swupd__attempt">
          <a-tag :color="attempt.success ? 'green' : 'red'">{{ attempt.success ? "成功" : "失败" }}</a-tag>
          <span>{{ installSourceLabel(attempt.source) }}</span>
          <span v-if="attempt.registry" class="mono">{{ attempt.registry }}</span>
          <span>{{ Math.round(attempt.durationMs / 1000) }}s</span>
          <span v-if="attempt.error" class="swupd__attempt-error">{{ attempt.error }}</span>
        </div>
      </div>
      <div v-if="lastResult.output" style="font-size: 11px; color: var(--app-muted); white-space: pre-wrap; max-height: 120px; overflow: auto; background: var(--app-panel-bg); border-radius: 6px; padding: 8px; font-family: monospace">{{ lastResult.output }}</div>
    </div>
    </template>

    <a-modal
      v-model:open="privilegeDialogOpen"
      title="需要管理员权限"
      :footer="null"
      width="560px"
      @cancel="closePrivilegeDialog"
    >
      <div class="swupd__privilege">
        <div class="swupd__privilege-text">
          当前 npm 全局目录不可写，Web 无法代替终端输入 sudo 密码。请在 {{ privilegePlatformLabel }} 终端执行下面的命令。
        </div>
        <div v-if="installEnvironment?.npmGlobalPrefix" class="swupd__privilege-meta">
          npm 全局目录：<span class="mono">{{ installEnvironment.npmGlobalPrefix }}</span>
        </div>
        <div v-if="privilegeDialogItem" class="swupd__privilege-meta">
          目标 CLI：<span class="mono">{{ engineLabel(privilegeDialogItem) }}</span>
        </div>
        <div class="swupd__privilege-meta">
          当前安装源：<span class="mono">{{ installSourceLabel(installSourceMode) }}</span>
        </div>
        <CommandBlock v-if="privilegeDialogItem" :command="privilegeDialogCommand" language="bash" />
        <div class="swupd__privilege-tip">
          如果你使用的是 `nvm` 或用户目录 npm，全局目录通常可写，这种情况下可以先修正 npm 前缀配置，再回到这里重新检测。
        </div>
        <div class="swupd__privilege-actions">
          <a-button @click="copyPrivilegeCommand">复制命令</a-button>
          <a-button type="primary" :loading="loading" @click="reloadAfterPrivilegeInstall">我已执行，重新检测</a-button>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.swupd {
  display: grid;
  gap: 12px;
  height: 100%;
  min-height: 100%;
  align-content: start;
}

/* 嵌入基础设置时只占内容高度，两个引擎卡片横向排布。 */
.swupd--compact {
  height: auto;
  min-height: 0;
}

.swupd__auto-update {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 4%, var(--app-panel-bg));
  font-size: 12px;
  color: var(--app-muted);
}

.swupd__items {
  display: grid;
  gap: 10px;
}

.swupd--compact .swupd__items {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (max-width: 900px) {
  .swupd--compact .swupd__items {
    grid-template-columns: minmax(0, 1fr);
  }
}

.swupd__notice {
  justify-self: start;
  width: fit-content;
  max-width: min(100%, 640px);
  padding: 8px 12px;
}

.swupd__notice :deep(.ant-alert-message),
.swupd__notice :deep(.ant-alert-description) {
  line-height: 1.5;
}

.swupd__path {
  overflow-wrap: anywhere;
  word-break: break-word;
  white-space: normal;
}

.swupd--compact .swupd__path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  overflow-wrap: normal;
  word-break: normal;
}

.swupd__path .mono {
  white-space: inherit;
}

.swupd__network {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel-bg);
}

.swupd__network-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swupd__network-label {
  font-size: 12px;
  color: var(--app-muted);
  white-space: nowrap;
}

.swupd__network-proxy {
  flex: 1;
  min-width: 260px;
}

.swupd__network-proxy :deep(.ant-input-affix-wrapper) {
  width: 100%;
}

.swupd__network-tip {
  width: 100%;
  font-size: 12px;
  color: var(--app-muted);
}

.swupd__key-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--app-border) 80%, #f59e0b);
  border-radius: 8px;
  background: color-mix(in srgb, var(--app-panel-bg) 92%, #f59e0b);
  color: var(--app-muted);
  font-size: 12px;
}

.swupd__key-notice span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.swupd__attempts {
  display: grid;
  gap: 6px;
}

.swupd__attempt {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--app-muted);
}

.swupd__attempt-error {
  overflow-wrap: anywhere;
}

.swupd__privilege {
  display: grid;
  gap: 12px;
}

.swupd__privilege-text,
.swupd__privilege-meta,
.swupd__privilege-tip {
  font-size: 13px;
  line-height: 1.7;
  color: var(--app-muted);
}

.swupd__privilege-tip {
  padding-left: 12px;
  border-left: 2px solid color-mix(in srgb, var(--app-primary, #1677ff) 22%, transparent);
}

.swupd__privilege-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .swupd__notice {
    width: 100%;
    max-width: 100%;
  }
}
</style>

