<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import { ImportOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons-vue";
import type {
  GetSkillSuitesResponseBody,
  McpCredentialInput,
  McpEnableRequestBody,
  McpInstallType,
  McpServerInfo,
  McpServerStatus,
  McpTestRequestBody,
  WorkspaceId,
} from "@codeflowai/shared";
import { canManageCustomSkillsAndMcp } from "@codeflowai/shared";

import { isCancelledRequestError } from "../../../api/request";
import {
  configureMcpServer,
  enableMcpServer,
  getSkillSuites,
  importMcpServers,
  testMcpServer,
  unconfigureMcpServer,
  uninstallMcpServer,
  updateMcpServer,
} from "../../../api/skills";
import { trackProductEvent } from "../../../analytics/analytics";
import { useApiContext } from "../../../composables/useApiContext";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { useEngineStore } from "../../../store/engine";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import { holdRefreshFeedback } from "../../../utils/refreshFeedback";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { consumePendingMcpSearchQuery, MCP_SUITES_CACHE_TTL_MS, mcpSuitesCache, type McpSuitesCacheEntry } from "./mcp-suites-cache";

defineOptions({ name: "McpManagementPanel" });

const props = withDefaults(defineProps<{ open?: boolean }>(), { open: true });

const configStore = useConfigStore();
const engineStore = useEngineStore();
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
const sharedWorkspaceMaintenanceLockedMessage = "共享工作区成员不可维护 Skills / MCP";
const sharedWorkspaceMaintenanceLockedDescription = "你仍可在流程中使用共享 Skills 和工具；安装、卸载、配置和自定义接入由企业管理员或工作区管理员统一维护，维护动作会写入审计。";
const permissionInput = computed(() => ({
  accountRole: configStore.accountRole,
  enterpriseId: configStore.userSummary?.enterpriseId ?? null,
  effectiveAccessScope: configStore.accessContext?.effectiveAccessScope ?? null,
  accessContext: configStore.accessContext ?? null,
}));
const canManageCustomMarketplace = computed(() => desktopLocalWorkspace.value || canManageCustomSkillsAndMcp(permissionInput.value));

const loading = ref(false);
const mcpLoadError = ref<string | null>(null);
const suitesData = ref<GetSkillSuitesResponseBody | null>(null);
const searchQuery = ref("");
type McpListFilter = "recommended" | "all" | "installed";

const listFilter = ref<McpListFilter>("all");
const mcpGroupOptions: Array<{ label: string; value: McpListFilter }> = [
  { label: "推荐", value: "recommended" },
  { label: "全部", value: "all" },
  { label: "已安装", value: "installed" },
];
const selectedMcpId = ref<string | null>(null);
const operating = ref<McpUiOperation | null>(null);
const importing = ref(false);

const customModalOpen = ref(false);
const customSaving = ref(false);
const customPackage = ref("");
const customInstallType = ref<McpInstallType>("local-command");
const customCommand = ref("");
const customUrl = ref("");
const customPythonPackage = ref("");
const customRunner = ref("uvx");
const customCredentials = ref<McpCredentialInput[]>([]);
const credentialName = ref("");
const credentialValue = ref("");
const credentialValueLocked = ref(true);
const credentialKind = ref<McpCredentialInput["kind"]>("env");

const credentialModalOpen = ref(false);
const credentialSaving = ref(false);
const credentialMcpId = ref<string | null>(null);
const credentialEngine = ref<"claude" | "codex">("codex");
const credentialInputs = ref<McpCredentialInput[]>([]);
let loadSequence = 0;

type McpUiOperationKind = "enable" | "update" | "test" | "uninstall" | "configure" | "unconfigure";
type McpUiOperation = { mcpId: string; kind: McpUiOperationKind; engine?: "claude" | "codex" };
const CATALOG_ONLY_MCP_ERROR = "catalog_only_marketplace";

const mcpServers = computed<McpServerInfo[]>(() => suitesData.value?.mcpServers ?? []);
const mcpStatus = computed<Record<string, McpServerStatus>>(() => suitesData.value?.mcpStatus ?? {});
const catalogOnly = computed(() => Boolean(suitesData.value?.catalogOnly));
const isBusy = computed(() => Boolean(operating.value) || importing.value);
const availableEngines = computed(() => {
  const map = engineStore.byTypeForWorkspace(workspaceId.value);
  return (["codex", "claude"] as const).filter((engine) => map.get(engine)?.installed === true);
});
const defaultEngine = computed<"claude" | "codex">(() => availableEngines.value[0] ?? "codex");
const mcpCacheScope = computed(() => {
  const current = currentWorkspace.value;
  const sharedHostClientId = current?.shared?.hostClientId ?? current?.hostedShared?.hostClientId ?? null;
  const localClientId = presenceStore.clientForWorkspace(String(workspaceId.value ?? ""))?.clientId ?? current?.ownerClientId ?? null;
  const targetClientId = String(sharedHostClientId ?? localClientId ?? "unknown").trim() || "unknown";
  const accountScope = String(configStore.webInstanceId ?? "anonymous").trim() || "anonymous";
  return {
    baseKey: ["mcp-suites", configStore.serverWsOrigin, accountScope, String(workspaceId.value ?? "").trim()].join("::"),
    targetClientId,
  };
});
const mcpCacheKey = computed(() => `${mcpCacheScope.value.baseKey}::${mcpCacheScope.value.targetClientId}`);

/** 目标 Client 尚未被 presence 解析时，允许已知 Client 复用同工作区的临时缓存。 */
function getMcpCacheEntry(cacheKey: string): McpSuitesCacheEntry | undefined {
  const direct = mcpSuitesCache.get(cacheKey);
  if (direct || mcpCacheScope.value.targetClientId === "unknown") return direct;
  return mcpSuitesCache.get(`${mcpCacheScope.value.baseKey}::unknown`);
}
const selectedServer = computed<McpServerInfo | null>(() => {
  if (!selectedMcpId.value) return null;
  return mcpServers.value.find((server) => server.mcpId === selectedMcpId.value) ?? null;
});
const selectedStatus = computed<McpServerStatus | null>(() => selectedServer.value ? getStatus(selectedServer.value.mcpId) : null);
const filteredServers = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const source = listFilter.value === "recommended"
    ? mcpServers.value.filter((server) => server.recommended === true)
    : listFilter.value === "installed"
      ? mcpServers.value.filter((server) => isMcpInstalled(server.mcpId))
      : mcpServers.value;
  const result = query
    ? source.filter((server) => [server.name, server.description, server.npmPackage, server.url]
      .some((value) => String(value ?? "").toLowerCase().includes(query)))
    : source.slice();
  return result.sort((left, right) => {
    if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
    const leftRank = left.recommended ? (left.recommendedRank ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rightRank = right.recommended ? (right.recommendedRank ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftStatus = getStatus(left.mcpId);
    const rightStatus = getStatus(right.mcpId);
    const leftConfigured = Boolean(leftStatus?.configuredInClaude || leftStatus?.configuredInCodex);
    const rightConfigured = Boolean(rightStatus?.configuredInClaude || rightStatus?.configuredInCodex);
    if (leftConfigured !== rightConfigured) return leftConfigured ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
});

/** 将本机已安装或已接入的 MCP 归入“已安装”分组。 */
function isMcpInstalled(mcpId: string): boolean {
  const status = getStatus(mcpId);
  return Boolean(status?.installed || status?.configuredInClaude || status?.configuredInCodex || status?.configuredInProject);
}

/** 读取当前 MCP 状态；无专属 Client 时只构造明确的目录浏览状态。 */
function getStatus(mcpId: string): McpServerStatus | null {
  const status = mcpStatus.value[mcpId];
  if (status) return status;
  if (!catalogOnly.value) return null;
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server) return null;
  return {
    mcpId,
    instanceId: `${mcpId}::default`,
    npmPackage: server.npmPackage,
    installed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    configuredInClaude: false,
    configuredInCodex: false,
    configuredInProject: false,
    installType: server.installType,
    transportType: server.transportType,
    installationStatus: "unknown",
    credentialConfigured: false,
    error: CATALOG_ONLY_MCP_ERROR,
  };
}

function isCatalogOnlyStatus(status: McpServerStatus | null | undefined): boolean {
  return status?.error === CATALOG_ONLY_MCP_ERROR;
}

function configuredEngines(mcpId: string): string[] {
  const status = getStatus(mcpId);
  if (!status) return [];
  return [status.configuredInClaude ? "Claude" : "", status.configuredInCodex ? "Codex" : "", status.configuredInProject ? "项目配置" : ""].filter(Boolean);
}

function statusSummary(mcpId: string): string {
  const status = getStatus(mcpId);
  if (!status) return "正在读取状态...";
  if (isCatalogOnlyStatus(status)) return "仅展示目录";
  const engines = configuredEngines(mcpId);
  if (status.installationStatus === "not-required") return engines.length ? `已接入 ${engines.join(" / ")}` : "无需本机安装";
  if (!status.installed) return "未安装到本机";
  if (!engines.length) return "已安装，尚未接入 AI";
  return `已接入 ${engines.join(" / ")}`;
}

function statusHint(mcpId: string): string {
  const status = getStatus(mcpId);
  if (!status) return "等待 Client 返回安装与接入状态。";
  if (isCatalogOnlyStatus(status)) return "当前没有可用的专属 Client 或工作区上下文，只能浏览公共 MCP 目录。";
  const engines = configuredEngines(mcpId);
  if (status.installationStatus === "not-required") return engines.length ? `当前已可在 ${engines.join(" / ")} 中使用。` : "保存远程地址后即可接入 AI 引擎。";
  if (!status.installed) return "点击启用后，系统会准备依赖、写入引擎配置并执行检测。";
  if (!engines.length) return "已安装完成，下一步可接入 Claude 或 Codex。";
  return `当前已可在 ${engines.join(" / ")} 中使用。`;
}

function installTypeLabel(type: McpServerInfo["installType"]): string {
  return { "local-command": "本地命令", http: "远程 HTTP", sse: "远程 SSE", npm: "NPM 包", pypi: "PyPI 包", imported: "导入配置" }[type];
}

function transportLabel(type: McpServerInfo["transportType"]): string {
  return { stdio: "stdio", "streamable-http": "Streamable HTTP", sse: "SSE" }[type];
}

function securityLabel(level: NonNullable<McpServerInfo["securityLevel"]>): string {
  return { low: "低", medium: "中", high: "高" }[level];
}

function operationText(operation: McpUiOperation): string {
  const name = mcpServers.value.find((server) => server.mcpId === operation.mcpId)?.name ?? "当前 MCP";
  if (operation.kind === "enable") return `正在启用 ${name}`;
  if (operation.kind === "update") return `正在更新 ${name}`;
  if (operation.kind === "test") return `正在检测 ${name}`;
  if (operation.kind === "uninstall") return `正在卸载 ${name}`;
  return operation.kind === "configure" ? `正在接入 ${name}` : `正在移除 ${name} 配置`;
}

function isPending(kind: McpUiOperationKind, mcpId: string, engine?: "claude" | "codex"): boolean {
  return operating.value?.kind === kind && operating.value.mcpId === mcpId && (engine === undefined || operating.value.engine === engine);
}

/** 开始一次 MCP 操作；同一面板只允许一个操作并复用共享工作区维护门禁。 */
function beginOperation(operation: McpUiOperation): boolean {
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return false;
  }
  if (operating.value) {
    message.warning(`${operationText(operating.value)}，请等待完成后再操作其他 MCP`);
    return false;
  }
  operating.value = operation;
  return true;
}

function endOperation(operation: McpUiOperation): void {
  if (operating.value?.kind === operation.kind && operating.value.mcpId === operation.mcpId && operating.value.engine === operation.engine) operating.value = null;
}

function selectMcp(mcpId: string): void {
  selectedMcpId.value = mcpId;
}

/** 组装目录条目和当前工作区，凭据只在有值时进入本次请求。 */
function buildMutationBody(server: McpServerInfo, engine: "claude" | "codex", credentials?: McpCredentialInput[]): McpEnableRequestBody {
  return {
    workspaceId: workspaceId.value ?? undefined,
    mcpId: server.mcpId,
    instanceId: getStatus(server.mcpId)?.instanceId ?? null,
    npmPackage: server.npmPackage,
    engine,
    installType: server.installType,
    transportType: server.transportType,
    serverName: server.serverName,
    name: server.name,
    description: server.description,
    homepage: server.homepage,
    command: server.command ?? null,
    args: server.args ?? [],
    url: server.url ?? null,
    pythonPackage: server.pythonPackage ?? null,
    runner: server.runner ?? null,
    ...(credentials ? { credentialInputs: credentials } : {}),
  };
}

/** 应用 MCP 目录和状态响应，并保持当前选中项仍属于最新列表。 */
function applySuitesResponse(response: GetSkillSuitesResponseBody): void {
  suitesData.value = response;
  if (selectedMcpId.value && !response.mcpServers?.some((server) => server.mcpId === selectedMcpId.value)) selectedMcpId.value = null;
  if (!selectedMcpId.value && response.mcpServers?.length) selectedMcpId.value = response.mcpServers.find((server) => server.featuredRecommended)?.mcpId ?? response.mcpServers[0]!.mcpId;
}

/** 本机就绪或 Server 已连接时读取 MCP 状态；复用同工作区、同 Client 的有效缓存。 */
async function load(options: { force?: boolean } = {}): Promise<boolean> {
  if (!clientAvailable.value || !props.open) return false;
  const cacheKey = mcpCacheKey.value;
  const cached = getMcpCacheEntry(cacheKey);
  const hasCachedData = Boolean(cached);
  const force = options.force === true;
  if (cached && !force) {
    applySuitesResponse(cached.response);
    mcpLoadError.value = null;
    loading.value = false;
    if (Date.now() - cached.updatedAt < MCP_SUITES_CACHE_TTL_MS) return true;
  }
  const sequence = ++loadSequence;
  const requestWorkspaceId = workspaceId.value;
  const isCurrentRequest = (): boolean => sequence === loadSequence
    && requestWorkspaceId === workspaceId.value
    && cacheKey === mcpCacheKey.value
    && props.open
    && clientAvailable.value;
  loading.value = !hasCachedData;
  mcpLoadError.value = null;
  try {
    const response = await getSkillSuites(ctx.value, workspaceId.value, { includeMcpStatus: true });
    if (!response.ok) throw new Error(response.message);
    if (!isCurrentRequest()) return false;
    mcpSuitesCache.set(cacheKey, { response, updatedAt: Date.now() });
    applySuitesResponse(response);
    return true;
  } catch (error) {
    if (!isCurrentRequest()) return false;
    mcpLoadError.value = error instanceof Error ? error.message : String(error);
    if (!hasCachedData) message.error(mcpLoadError.value);
    return false;
  } finally {
    if (isCurrentRequest()) loading.value = false;
  }
}

/** 手动刷新期间额外撑住按钮的 loading，让转圈有可见时长。 */
const refreshHolding = ref(false);

/** 手动刷新 MCP 状态：只提示这一次点击的结果，失败提示由 load 内部按有无缓存给出。 */
async function refreshMcpState(): Promise<void> {
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
  if (ok) message.success("MCP 状态已刷新");
}

/** 添加一项临时凭据，重复名称在提交前明确拒绝。 */
function addCredential(target: McpCredentialInput[]): void {
  const name = credentialName.value.trim();
  const value = credentialValue.value;
  if (!name || !value) {
    message.warning("请填写凭据名称和值");
    return;
  }
  if (target.some((item) => item.name === name && item.kind === credentialKind.value)) {
    message.warning("凭据名称已添加");
    return;
  }
  target.push({ name, value, kind: credentialKind.value });
  credentialName.value = "";
  credentialValue.value = "";
}

function resetCustomForm(): void {
  customPackage.value = "";
  customInstallType.value = "local-command";
  customCommand.value = "";
  customUrl.value = "";
  customPythonPackage.value = "";
  customRunner.value = "uvx";
  customCredentials.value = [];
  credentialName.value = "";
  credentialValue.value = "";
  credentialValueLocked.value = true;
  credentialKind.value = "env";
}

/** 打开自定义接入，只在具备既有市场维护权限时允许提交。 */
function openCustomModal(): void {
  if (sharedWorkspaceMaintenanceLocked.value) {
    message.warning(sharedWorkspaceMaintenanceLockedMessage);
    return;
  }
  if (!canManageCustomMarketplace.value) {
    message.warning("当前账号暂无自定义 Skills / MCP 接入权限");
    return;
  }
  resetCustomForm();
  customModalOpen.value = true;
}

/** 打开已有 MCP 的凭据编辑，明文只保留在当前页面内存。 */
function openCredentialModal(mcpId: string): void {
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server) return;
  credentialMcpId.value = mcpId;
  credentialEngine.value = defaultEngine.value;
  credentialInputs.value = [];
  credentialName.value = "";
  credentialValue.value = "";
  credentialValueLocked.value = true;
  credentialKind.value = server.installType === "http" || server.installType === "sse" ? "header" : "env";
  credentialModalOpen.value = true;
}

/** 保存凭据并复用启用流程，保存或配置失败都会保留失败结果。 */
async function submitCredentials(): Promise<void> {
  const server = mcpServers.value.find((item) => item.mcpId === credentialMcpId.value);
  if (!server || !credentialInputs.value.length) {
    message.warning("请至少添加一项凭据");
    return;
  }
  credentialSaving.value = true;
  try {
    const response = await enableMcpServer(ctx.value, buildMutationBody(server, credentialEngine.value, credentialInputs.value));
    if (!response.ok) {
      throw new Error(response.message ?? "凭据配置失败");
    }
    credentialModalOpen.value = false;
    message.success("凭据已保存并完成配置检测");
    await load({ force: true });
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error));
  } finally {
    credentialSaving.value = false;
  }
}

/** 从常见应用导入非敏感 MCP 定义，并展示部分导入结果。 */
async function importConfigurations(): Promise<void> {
  if (!workspaceId.value || !clientAvailable.value || isBusy.value) return;
  importing.value = true;
  try {
    const response = await importMcpServers(ctx.value, { workspaceId: workspaceId.value, sources: ["claude", "codex", "vscode", "cursor"] });
    if (!response.ok) throw new Error(response.message ?? "导入 MCP 配置失败");
    trackProductEvent("mcp_import", { status: response.errors.length ? "partial" : "success", source: "asset_library", imported_count: response.items.length, failed_count: response.errors.length });
    if (response.errors.length) message.warning(`已导入 ${response.items.length} 项，${response.errors.length} 个来源或条目未导入`);
    else message.success(response.items.length ? `已导入 ${response.items.length} 项 MCP 配置` : "未发现可导入的 MCP 配置");
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent("mcp_import", { status: "failed", source: "asset_library", error_code_group: "request_error" });
      message.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    importing.value = false;
  }
}

/** 创建自定义 MCP；字段校验严格匹配当前安装方式。 */
/** 从安装源推导自定义 MCP 的名字（展示名 name 与引擎配置名 serverName 共用）。 */
function deriveCustomServerName(): string {
  const type = customInstallType.value;
  if (type === "npm") {
    const pkg = customPackage.value.trim();
    return (pkg.split("/").pop() ?? pkg).replace(/^@/, "") || "mcp";
  }
  if (type === "local-command") return deriveLocalCommandName(customCommand.value.trim());
  if (type === "pypi") return customPythonPackage.value.trim() || "mcp";
  // http / sse：取 URL hostname 首段作为名字
  try {
    return new URL(customUrl.value.trim()).hostname.replace(/^www\./, "").split(".")[0] || "mcp";
  } catch {
    return "mcp";
  }
}

/** 从本地命令推导名字：跳过 npx/uvx/node 等 runner 与 flag，取最后一个有意义的包名/脚本名。 */
function deriveLocalCommandName(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  if (!tokens.length) return "mcp";
  const runners = new Set(["npx", "uvx", "node", "python", "python3", "deno", "bun", "pnpm", "pnpx", "yarn"]);
  const meaningful = tokens.filter((token) => !token.startsWith("-") && !runners.has(token));
  const candidate = meaningful.length ? meaningful[meaningful.length - 1]! : tokens[tokens.length - 1]!;
  const last = candidate.split(/[\\/]/).pop() ?? candidate;
  return last.replace(/^@/, "").replace(/\.(exe|cmd|bat|js|mjs|cjs|ts|py)$/i, "") || "mcp";
}

async function submitCustom(): Promise<void> {
  if (!workspaceId.value || sharedWorkspaceMaintenanceLocked.value || !canManageCustomMarketplace.value) {
    message.warning(sharedWorkspaceMaintenanceLocked.value ? sharedWorkspaceMaintenanceLockedMessage : "当前账号暂无自定义 Skills / MCP 接入权限");
    return;
  }
  const installType = customInstallType.value;
  const npmPackage = customPackage.value.trim();
  const command = customCommand.value.trim();
  const url = customUrl.value.trim();
  const pythonPackage = customPythonPackage.value.trim();
  const runner = customRunner.value.trim();
  if ((installType === "npm" && !npmPackage) || (installType === "local-command" && !command) || ((installType === "http" || installType === "sse") && !url) || (installType === "pypi" && (!pythonPackage || !runner))) {
    message.warning("请补全当前安装方式所需信息");
    return;
  }
  const serverName = deriveCustomServerName();
  customSaving.value = true;
  try {
    const response = await enableMcpServer(ctx.value, {
      workspaceId: workspaceId.value,
      mcpId: null,
      instanceId: null,
      engine: defaultEngine.value,
      installType,
      transportType: installType === "http" ? "streamable-http" : installType === "sse" ? "sse" : "stdio",
      npmPackage: npmPackage || null,
      command: command || null,
      url: url || null,
      pythonPackage: pythonPackage || null,
      runner: runner || null,
      serverName,
      name: serverName,
      credentialInputs: customCredentials.value,
    });
    if (!response.ok) throw new Error(response.message ?? "启用失败");
    trackProductEvent("mcp_enable", { status: "success", source: "asset_library", engine: defaultEngine.value });
    selectedMcpId.value = response.mcpId;
    customModalOpen.value = false;
    message.success("自定义 MCP 已启用");
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent("mcp_enable", { status: "failed", source: "asset_library", engine: defaultEngine.value, error_code_group: "request_error" });
      message.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    customSaving.value = false;
  }
}

/** 按当前状态选择启用、更新或检测主操作。 */
async function runPrimary(mcpId: string): Promise<void> {
  const status = getStatus(mcpId);
  if (!status) return;
  if (status.updateAvailable) return await runUpdate(mcpId, status.configuredInCodex ? "codex" : "claude");
  if (status.configuredInClaude || status.configuredInCodex || status.configuredInProject) return await runTest(mcpId, status.configuredInCodex ? "codex" : status.configuredInClaude ? "claude" : defaultEngine.value);
  return await runEnable(mcpId, defaultEngine.value);
}

/** 启用目录 MCP，并保留四阶段结果用于页面展示。 */
async function runEnable(mcpId: string, engine: "claude" | "codex"): Promise<void> {
  if (!clientAvailable.value || !workspaceId.value) return;
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server) return;
  const operation: McpUiOperation = { mcpId, kind: "enable", engine };
  if (!beginOperation(operation)) return;
  try {
    const response = await enableMcpServer(ctx.value, buildMutationBody(server, engine));
    if (!response.ok) {
      throw new Error(response.message ?? "启用失败");
    }
    trackProductEvent("mcp_enable", { status: "success", source: "asset_library", engine });
    message.success(`${server.name} 已启用并接入 ${engine === "claude" ? "Claude" : "Codex"}`);
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent("mcp_enable", { status: "failed", source: "asset_library", engine, error_code_group: "request_error" });
      message.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    endOperation(operation);
  }
}

/** 更新 MCP 依赖并重新接入目标引擎。 */
async function runUpdate(mcpId: string, engine: "claude" | "codex"): Promise<void> {
  if (!clientAvailable.value || !workspaceId.value) return;
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  const status = getStatus(mcpId);
  if (!server || !status) return;
  const latestVersion = status.latestVersion?.trim() || null;
  if (!latestVersion) {
    message.error("未能确认最新版本，请刷新 MCP 状态后重试");
    return;
  }
  const operation: McpUiOperation = { mcpId, kind: "update", engine };
  if (!beginOperation(operation)) return;
  try {
    const body = buildMutationBody(server, engine);
    body.version = latestVersion;
    const response = await updateMcpServer(ctx.value, body);
    if (!response.ok) {
      throw new Error(response.message ?? "更新失败");
    }
    message.success(`${server.name} 已更新并完成配置检测`);
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    endOperation(operation);
  }
}

/** 检测已保存的引擎配置，不修改本地依赖或配置文件。 */
async function runTest(mcpId: string, engine: "claude" | "codex"): Promise<void> {
  if (!clientAvailable.value || !workspaceId.value) return;
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server) return;
  const operation: McpUiOperation = { mcpId, kind: "test", engine };
  if (!beginOperation(operation)) return;
  const body: McpTestRequestBody = {
    workspaceId: workspaceId.value,
    mcpId: server.mcpId,
    instanceId: getStatus(mcpId)?.instanceId ?? null,
    npmPackage: server.npmPackage,
    engine,
    serverName: server.serverName,
    name: server.name,
    description: server.description,
    homepage: server.homepage,
  };
  try {
    const response = await testMcpServer(ctx.value, body);
    if (!response.ok) {
      throw new Error(response.message);
    }
    endOperation(operation);
    message.success(`${server.name} 配置检测通过`);
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    endOperation(operation);
  }
}

function toggleEngine(mcpId: string, engine: "claude" | "codex", checked: boolean): void {
  if (checked) void configure(mcpId, engine);
  else void unconfigure(mcpId, engine);
}

/** 将已准备好的 MCP 配置写入指定引擎。 */
async function configure(mcpId: string, engine: "claude" | "codex"): Promise<void> {
  if (!clientAvailable.value || !workspaceId.value) return;
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server) return;
  const operation: McpUiOperation = { mcpId, kind: "configure", engine };
  if (!beginOperation(operation)) return;
  try {
    const response = await configureMcpServer(ctx.value, buildMutationBody(server, engine));
    if (!response.ok) throw new Error(response.message ?? "配置失败");
    trackProductEvent("mcp_config_save", { status: "success", source: "asset_library", engine });
    message.success(`${server.name} 已接入 ${engine === "claude" ? "Claude" : "Codex"}`);
    await load({ force: true });
  } catch (error) {
    if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
  } finally {
    endOperation(operation);
  }
}

/** 移除指定引擎配置前要求确认，避免误删正在使用的接入。 */
async function unconfigure(mcpId: string, engine: "claude" | "codex"): Promise<void> {
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  if (!server || !clientAvailable.value) return;
  Modal.confirm({
    title: `移除 ${engine === "claude" ? "Claude" : "Codex"} 配置`,
    content: `确定移除 ${server.name} 的引擎配置？`,
    okText: "移除",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      const operation: McpUiOperation = { mcpId, kind: "unconfigure", engine };
      if (!beginOperation(operation)) return;
      try {
        const response = await unconfigureMcpServer(ctx.value, {
          workspaceId: workspaceId.value ?? undefined,
          mcpId,
          instanceId: getStatus(mcpId)?.instanceId ?? null,
          npmPackage: server.npmPackage,
          engine,
          serverName: server.serverName,
        });
        if (!response.ok) throw new Error(response.message ?? "移除配置失败");
        trackProductEvent("mcp_config_save", { status: "success", source: "asset_library", settings_action: "unconfigure", engine });
        message.success(`${server.name} 已取消接入`);
        await load({ force: true });
      } catch (error) {
        if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
      } finally {
        endOperation(operation);
      }
    },
  });
}

/** 卸载前要求确认；npm 类型卸载全局依赖，自定义条目同时从注册表移除。 */
async function uninstall(mcpId: string): Promise<void> {
  const server = mcpServers.value.find((item) => item.mcpId === mcpId);
  const status = getStatus(mcpId);
  if (!server || !status || !clientAvailable.value) return;
  const isRemote = status.installationStatus === "not-required";
  if (isRemote && server.source === "builtin") {
    Modal.warning({
      title: "无需卸载",
      content: "该 MCP 为远程服务，无本机依赖需要卸载。",
      okText: "知道了",
    });
    return;
  }
  if (!isRemote && !status.installed && server.source === "builtin") {
    Modal.warning({
      title: "尚未安装",
      content: "该 MCP 尚未安装到本机，无需卸载。",
      okText: "知道了",
    });
    return;
  }
  if (status.configuredInProject) {
    Modal.warning({
      title: "请先移除项目配置",
      content: `${server.name} 仍在项目 .mcp.json 中配置。请先从项目配置移除后再卸载。`,
      okText: "知道了",
    });
    return;
  }
  const willRemoveEngines = status.configuredInClaude || status.configuredInCodex;
  Modal.confirm({
    title: "卸载 MCP",
    content: willRemoveEngines
      ? `将自动移除 Claude/Codex 接入，并从当前 Client 卸载 ${server.name}？`
      : `确定从当前 Client 卸载 ${server.name}？`,
    okText: "卸载",
    okType: "danger",
    cancelText: "取消",
    onOk: async () => {
      const operation: McpUiOperation = { mcpId, kind: "uninstall" };
      if (!beginOperation(operation)) return;
      try {
        const response = await uninstallMcpServer(ctx.value, {
          workspaceId: workspaceId.value ?? undefined,
          mcpId,
          instanceId: status.instanceId,
          npmPackage: server.npmPackage,
          serverName: server.serverName,
        });
        if (!response.ok) throw new Error(response.message ?? "卸载失败");
        trackProductEvent("mcp_uninstall", { status: "success", source: "asset_library" });
        message.success(`${server.name} 已从当前 Client 卸载`);
        await load({ force: true });
      } catch (error) {
        if (!isCancelledRequestError(error)) message.error(error instanceof Error ? error.message : String(error));
      } finally {
        endOperation(operation);
      }
    },
  });
}

watch(() => [props.open, workspaceId.value, clientAvailable.value, mcpCacheKey.value] as const, ([open, _workspace, connected]) => {
  loadSequence += 1;
  const cached = getMcpCacheEntry(mcpCacheKey.value);
  suitesData.value = cached?.response ?? null;
  selectedMcpId.value = null;
  mcpLoadError.value = null;
  loading.value = !cached;
  if (open && connected) void load();
}, { immediate: true });

/** 账号身份切换时清空当前浏览器实例的 MCP 缓存，避免不同账号复用旧状态。 */
watch(() => [configStore.authMode, configStore.userSummary?.userId] as const, ([authMode, userId], previous) => {
  if (!previous) return;
  const accountChanged = authMode !== previous[0]
    || (Boolean(previous[1]) && Boolean(userId) && userId !== previous[1])
    || (Boolean(previous[1]) && !userId);
  if (!accountChanged) return;
  mcpSuitesCache.clear();
  loadSequence += 1;
  suitesData.value = null;
  selectedMcpId.value = null;
  mcpLoadError.value = null;
  if (props.open && clientAvailable.value) void load({ force: true });
});

/** 消费 /mcp 命令带入的筛选参数，注入搜索框。 */
onMounted(() => {
  const pending = consumePendingMcpSearchQuery();
  if (pending) searchQuery.value = pending;
});

watch(customInstallType, (type) => {
  credentialKind.value = type === "http" || type === "sse" ? "header" : "env";
});

watch([filteredServers, listFilter], ([servers]) => {
  if (selectedMcpId.value && servers.some((server) => server.mcpId === selectedMcpId.value)) return;
  selectedMcpId.value = servers[0]?.mcpId ?? null;
});
</script>

<template>
  <div class="mcp-panel">
    <Teleport defer to="#orch-asset-toolbar-host">
      <div class="mcp-panel__toolbar">
        <a-input v-model:value="searchQuery" class="thread-list__search-input" placeholder="搜索 MCP 工具..." allow-clear>
          <template #prefix><SearchOutlined /></template>
        </a-input>
        <a-tooltip title="导入 MCP 配置">
          <a-button
            size="small"
            aria-label="导入 MCP 配置"
            :disabled="catalogOnly || !clientAvailable || !workspaceId || isBusy || !canManageCustomMarketplace || sharedWorkspaceMaintenanceLocked"
            :loading="importing"
            @click="importConfigurations"
          >
            <template #icon><ImportOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-tooltip title="添加 MCP">
          <a-button
            size="small"
            aria-label="添加 MCP"
            :disabled="catalogOnly || !clientAvailable || !workspaceId || isBusy || !canManageCustomMarketplace || sharedWorkspaceMaintenanceLocked"
            @click="openCustomModal"
          >
            <template #icon><PlusOutlined /></template>
          </a-button>
        </a-tooltip>
        <a-button
          size="small"
          aria-label="刷新 MCP 状态"
          :disabled="!clientAvailable || isBusy"
          :loading="loading || refreshHolding"
          @click="refreshMcpState"
        >
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </div>
    </Teleport>

    <Teleport defer to="#orch-mcp-sidebar-host">
      <div class="mcp-panel__sidebar">
        <div class="mcp-panel__group-bar">
          <a-select v-model:value="listFilter" size="small" :options="mcpGroupOptions" aria-label="MCP 分组" />
        </div>
        <div v-if="loading && !mcpServers.length" class="mcp-panel__list-state">
          <a-spin size="small" />
          <span>加载中...</span>
        </div>
        <div v-else-if="mcpLoadError && !mcpServers.length" class="mcp-panel__list-state mcp-panel__list-state--error">
          <span>加载失败，请点击上方刷新</span>
        </div>
        <div v-else class="mcp-panel__list">
          <button
            v-for="server in filteredServers"
            :key="server.mcpId"
            type="button"
            class="mcp-panel__list-item"
            :class="{ 'mcp-panel__list-item--active': selectedMcpId === server.mcpId }"
            @click="selectMcp(server.mcpId)"
          >
            <span class="mcp-panel__list-title">
              <strong>{{ server.name }}</strong>
              <span class="mcp-panel__tags">
                <a-tag v-if="server.source === 'custom'" color="gold">自定义</a-tag>
                <a-tag v-if="isCatalogOnlyStatus(getStatus(server.mcpId))">仅目录</a-tag>
                <a-tag v-else-if="getStatus(server.mcpId)?.updateAvailable" color="orange">可更新</a-tag>
                <a-tag v-else-if="getStatus(server.mcpId)?.installationStatus === 'not-required'" color="blue">远程</a-tag>
                <a-tag v-else-if="getStatus(server.mcpId)?.installed" color="green">已安装</a-tag>
              </span>
            </span>
            <span class="mcp-panel__list-description">{{ server.description }}</span>
            <span class="mcp-panel__list-meta">{{ server.npmPackage ?? server.url ?? server.command }} · {{ statusSummary(server.mcpId) }}</span>
          </button>
          <div v-if="!filteredServers.length" class="mcp-panel__empty">
            {{ searchQuery.trim() ? "无匹配结果" : "当前分组暂无 MCP 工具" }}
          </div>
        </div>
      </div>
    </Teleport>

    <a-alert v-if="mcpLoadError && mcpServers.length" class="mcp-panel__notice" type="warning" show-icon message="MCP 状态刷新失败" :description="`${mcpLoadError} 当前显示上次成功加载的数据，可点击刷新重试。`" />
    <a-alert v-if="catalogOnly" class="mcp-panel__notice" type="info" show-icon message="当前仅展示公共市场目录" description="当前没有可用的专属 Client 或工作区上下文，安装、配置和操作已禁用。" />
    <a-alert v-if="sharedWorkspaceMaintenanceLocked" class="mcp-panel__notice" type="warning" show-icon :message="sharedWorkspaceMaintenanceLockedMessage" :description="sharedWorkspaceMaintenanceLockedDescription" />

    <section v-if="loading && !mcpServers.length" class="mcp-panel__loading"><a-spin size="small" /> <span>正在加载 MCP 工具...</span></section>
    <section v-else-if="mcpLoadError && !mcpServers.length" class="mcp-panel__load-error"><span>MCP 工具加载失败：{{ mcpLoadError }}</span><a-button size="small" @click="load({ force: true })">重新加载</a-button></section>
    <template v-else>
      <section class="mcp-panel__detail">
          <template v-if="selectedServer && selectedStatus">
            <header class="mcp-panel__detail-header"><div class="mcp-panel__detail-title-row"><h2>{{ selectedServer.name }}</h2><a-tag v-if="selectedServer.recommended" color="blue">推荐</a-tag></div><p>{{ selectedServer.description }}</p><div class="mcp-panel__detail-meta"><span>{{ selectedServer.npmPackage ?? selectedServer.url ?? selectedServer.command }}</span><span v-if="selectedStatus.currentVersion">当前版本 v{{ selectedStatus.currentVersion }}</span><a v-if="selectedServer.homepage" :href="selectedServer.homepage" target="_blank" rel="noopener noreferrer">项目主页</a></div></header>
            <section class="mcp-panel__section"><div class="mcp-panel__section-title">状态</div><div class="mcp-panel__status-box"><strong>{{ statusSummary(selectedServer.mcpId) }}</strong><p>{{ statusHint(selectedServer.mcpId) }}</p><div class="mcp-panel__metadata"><span>类型：{{ installTypeLabel(selectedServer.installType) }}</span><span>连接：{{ transportLabel(selectedServer.transportType) }}</span><span v-if="selectedServer.securityLevel">安全提示：{{ securityLabel(selectedServer.securityLevel) }}</span><span>凭据：{{ selectedStatus.credentialConfigured ? "已配置（仅保存在当前 Client）" : "未配置" }}</span><span v-if="selectedStatus.configuredInProject">项目配置：已检测</span></div><div v-if="selectedServer.categories?.length" class="mcp-panel__metadata">分类：{{ selectedServer.categories.join('、') }}</div><div v-if="selectedServer.prerequisites?.length" class="mcp-panel__metadata">前置条件：{{ selectedServer.prerequisites.join('；') }}</div></div></section>
            <section class="mcp-panel__actions"><div class="mcp-panel__action-row"><div><strong>启用与检测</strong><p>{{ selectedStatus.installationStatus === 'not-required' ? '远程 MCP 无需安装到当前 Client。' : selectedStatus.installed ? '依赖已准备，可更新或检测配置。' : '系统会准备依赖、写入默认引擎配置并执行检测。' }}</p></div><a-button type="primary" :disabled="!clientAvailable || isBusy || catalogOnly || sharedWorkspaceMaintenanceLocked" :loading="isPending('enable', selectedServer.mcpId) || isPending('update', selectedServer.mcpId) || isPending('test', selectedServer.mcpId)" @click="runPrimary(selectedServer.mcpId)">{{ selectedStatus.updateAvailable ? '更新并检测' : selectedStatus.configuredInClaude || selectedStatus.configuredInCodex || selectedStatus.configuredInProject ? '检测连接' : '启用' }}</a-button></div><div class="mcp-panel__action-row"><div><strong>Claude</strong><p>{{ selectedStatus.configuredInClaude ? '已接入 Claude，可直接使用。' : '未接入 Claude。' }}</p></div><a-switch :checked="selectedStatus.configuredInClaude" :disabled="!clientAvailable || isBusy || (!selectedStatus.installed && selectedStatus.installationStatus !== 'not-required') || catalogOnly || sharedWorkspaceMaintenanceLocked" :loading="isPending(selectedStatus.configuredInClaude ? 'unconfigure' : 'configure', selectedServer.mcpId, 'claude')" @change="toggleEngine(selectedServer.mcpId, 'claude', Boolean($event))" /></div><div class="mcp-panel__action-row"><div><strong>Codex</strong><p>{{ selectedStatus.configuredInCodex ? '已接入 Codex，可直接使用。' : '未接入 Codex。' }}</p></div><a-switch :checked="selectedStatus.configuredInCodex" :disabled="!clientAvailable || isBusy || (!selectedStatus.installed && selectedStatus.installationStatus !== 'not-required') || catalogOnly || sharedWorkspaceMaintenanceLocked" :loading="isPending(selectedStatus.configuredInCodex ? 'unconfigure' : 'configure', selectedServer.mcpId, 'codex')" @change="toggleEngine(selectedServer.mcpId, 'codex', Boolean($event))" /></div><div class="mcp-panel__action-buttons"><a-button :disabled="!clientAvailable || isBusy || catalogOnly || sharedWorkspaceMaintenanceLocked" @click="openCredentialModal(selectedServer.mcpId)">{{ selectedStatus.credentialConfigured ? "修改凭据" : "配置凭据" }}</a-button><a-button danger :disabled="!clientAvailable || isBusy || catalogOnly || sharedWorkspaceMaintenanceLocked" :loading="isPending('uninstall', selectedServer.mcpId)" @click="uninstall(selectedServer.mcpId)">卸载</a-button></div></section>
          </template>
          <div v-else class="mcp-panel__empty">{{ filteredServers.length ? "请在左侧选择一个 MCP 工具" : "当前分组暂无 MCP 工具" }}</div>
        </section>
    </template>

    <a-modal v-model:open="customModalOpen" title="添加自定义 MCP" :confirm-loading="customSaving" ok-text="启用" cancel-text="取消" @ok="submitCustom"><div class="mcp-panel__form"><label><span>安装方式</span><a-select v-model:value="customInstallType" style="width: 100%"><a-select-option value="local-command">本地命令（stdio）</a-select-option><a-select-option value="http">远程 HTTP</a-select-option><a-select-option value="sse">远程 SSE</a-select-option><a-select-option value="npm">NPM 包</a-select-option><a-select-option value="pypi">PyPI 包</a-select-option></a-select></label><label><span>{{ customInstallType === 'npm' ? 'NPM 包名' : customInstallType === 'local-command' ? '启动命令' : customInstallType === 'pypi' ? 'PyPI 包名' : '服务地址' }}</span><a-input v-if="customInstallType === 'npm'" v-model:value="customPackage" placeholder="@scope/package-name" /><a-input v-else-if="customInstallType === 'local-command'" v-model:value="customCommand" placeholder="例如：team-docs-mcp" /><a-input v-else-if="customInstallType === 'pypi'" v-model:value="customPythonPackage" placeholder="例如：mcp-server-fetch" /><a-input v-else v-model:value="customUrl" placeholder="https://example.com/mcp" /></label><label v-if="customInstallType === 'pypi'"><span>运行器</span><a-input v-model:value="customRunner" placeholder="uvx 或 python" /></label><div class="mcp-panel__form-field"><span>凭据（可选）</span><div class="mcp-panel__credential-editor"><a-select v-model:value="credentialKind"><a-select-option value="env">环境变量</a-select-option><a-select-option value="header">请求头</a-select-option></a-select><a-input v-model:value="credentialName" name="codeflow-mcp-credential-name" autocomplete="off" placeholder="名称，如 API_KEY" /><a-input-password v-model:value="credentialValue" name="codeflow-mcp-credential-value" autocomplete="new-password" :readonly="credentialValueLocked" @focus="credentialValueLocked = false" placeholder="值，仅本机保存" /><a-button type="dashed" @click="addCredential(customCredentials)">添加</a-button></div><div v-if="customCredentials.length" class="mcp-panel__credential-list"><span v-for="(item, index) in customCredentials" :key="`${item.kind}:${item.name}`">{{ item.kind === 'env' ? '环境变量' : '请求头' }}：{{ item.name }} <button type="button" @click="customCredentials.splice(index, 1)">×</button></span></div></div></div></a-modal>
    <a-modal v-model:open="credentialModalOpen" title="配置 MCP 凭据" :confirm-loading="credentialSaving" ok-text="保存并检测" cancel-text="取消" @ok="submitCredentials"><div class="mcp-panel__form"><a-alert type="info" show-icon message="凭据只保存在当前 Client" description="Server 不保存、不回显凭据明文；保存后会重新配置当前引擎并执行检测。" /><label><span>目标引擎</span><a-select v-model:value="credentialEngine" style="width: 100%"><a-select-option value="codex">Codex</a-select-option><a-select-option value="claude">Claude</a-select-option></a-select></label><div class="mcp-panel__form-field"><span>凭据</span><div class="mcp-panel__credential-editor"><a-select v-model:value="credentialKind"><a-select-option value="env">环境变量</a-select-option><a-select-option value="header">请求头</a-select-option></a-select><a-input v-model:value="credentialName" name="codeflow-mcp-credential-name" autocomplete="off" placeholder="名称，如 API_KEY" /><a-input-password v-model:value="credentialValue" name="codeflow-mcp-credential-value" autocomplete="new-password" :readonly="credentialValueLocked" @focus="credentialValueLocked = false" placeholder="值" /><a-button type="dashed" @click="addCredential(credentialInputs)">添加</a-button></div><div v-if="credentialInputs.length" class="mcp-panel__credential-list"><span v-for="(item, index) in credentialInputs" :key="`${item.kind}:${item.name}`">{{ item.kind === 'env' ? '环境变量' : '请求头' }}：{{ item.name }} <button type="button" @click="credentialInputs.splice(index, 1)">×</button></span></div></div></div></a-modal>
  </div>
</template>

<style scoped>
.mcp-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; color: var(--app-text, #1f2937); }
.mcp-panel__notice { flex: 0 0 auto; width: fit-content; max-width: min(100%, 760px); margin-bottom: 10px; }
.mcp-panel__loading, .mcp-panel__load-error { flex: 1; min-height: 240px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--app-muted, #667085); }
.mcp-panel__load-error { flex-direction: column; }
.mcp-panel__toolbar { display: grid; flex: 1 1 auto; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 8px; min-width: 0; }
.mcp-panel__toolbar :deep(.ant-btn) {
  width: 30px;
  min-width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid color-mix(in srgb, var(--app-accent, #d97757) 22%, var(--app-border, #d9d9d9));
  border-radius: 9px;
  background: color-mix(in srgb, var(--app-accent, #d97757) 5%, var(--app-panel-bg, #fff));
  color: color-mix(in srgb, var(--app-accent, #d97757) 82%, var(--app-text, #334155));
  box-shadow: 0 2px 8px color-mix(in srgb, var(--app-accent, #d97757) 8%, transparent);
}
.mcp-panel__toolbar :deep(.ant-btn:hover),
.mcp-panel__toolbar :deep(.ant-btn:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent, #d97757) 34%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-accent, #d97757) 9%, var(--app-panel-bg, #fff));
  color: var(--app-accent, #d97757);
  box-shadow: 0 4px 12px color-mix(in srgb, var(--app-accent, #d97757) 12%, transparent);
  outline: none;
}
.mcp-panel__toolbar :deep(.ant-btn:disabled) { cursor: not-allowed; opacity: 0.4; }
:root[data-theme="dark"] .mcp-panel__toolbar :deep(.ant-btn) {
  border-color: #303030;
  background: #16181d;
  color: #d6dbe4;
}
:root[data-theme="dark"] .mcp-panel__toolbar :deep(.ant-btn:hover),
:root[data-theme="dark"] .mcp-panel__toolbar :deep(.ant-btn:focus-visible) {
  border-color: color-mix(in srgb, var(--app-accent) 24%, #303030);
  background: color-mix(in srgb, var(--app-accent) 10%, #16181d);
  color: #ffd2c2;
}
.mcp-panel__sidebar { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }
.mcp-panel__group-bar { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 7px 10px; }
.mcp-panel__group-bar :deep(.ant-select-selector) { height: 26px; align-items: center; }
.mcp-panel__list { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
.mcp-panel__list-item { display: grid; width: 100%; min-width: 0; gap: 5px; padding: 10px; margin-bottom: 6px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.mcp-panel__list-item:hover { background: color-mix(in srgb, var(--app-accent, #d97757) 4%, transparent); }
.mcp-panel__list-item--active { border-color: var(--app-accent, #d97757); background: color-mix(in srgb, var(--app-accent, #d97757) 6%, transparent); }
.mcp-panel__list-title { display: flex; align-items: center; justify-content: space-between; min-width: 0; gap: 8px; }
.mcp-panel__list-title strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.mcp-panel__tags { display: flex; flex: 0 0 auto; gap: 3px; }
.mcp-panel__tags :deep(.ant-tag) { margin: 0; font-size: 10px; line-height: 17px; }
.mcp-panel__list-description, .mcp-panel__list-meta { overflow: hidden; color: var(--app-muted, #667085); font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.mcp-panel__list-meta { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mcp-panel__list-state { display: flex; flex: 1; min-height: 180px; align-items: center; justify-content: center; gap: 7px; color: var(--app-muted, #667085); font-size: 12px; }
.mcp-panel__list-state--error { text-align: center; }
.mcp-panel__empty { display: flex; min-height: 180px; height: 100%; align-items: center; justify-content: center; color: var(--app-muted, #667085); font-size: 13px; text-align: center; }
.mcp-panel__detail { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; overflow-y: auto; padding: 14px 16px 20px; }
.mcp-panel__detail-header { margin-bottom: 14px; }
.mcp-panel__detail-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mcp-panel__detail-title-row h2 { min-width: 0; margin: 0; overflow-wrap: anywhere; font-size: 18px; line-height: 1.35; }
.mcp-panel__detail-header p, .mcp-panel__status-box p, .mcp-panel__action-row p { margin: 4px 0 0; color: var(--app-muted, #667085); font-size: 12px; line-height: 1.5; }
.mcp-panel__detail-meta, .mcp-panel__metadata { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 7px; color: var(--app-muted, #667085); font-size: 11px; overflow-wrap: anywhere; }
.mcp-panel__detail-meta span:first-child { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
.mcp-panel__section { margin-bottom: 12px; }
.mcp-panel__section-title { margin-bottom: 7px; font-size: 13px; font-weight: 700; }
.mcp-panel__status-box, .mcp-panel__actions { padding: 11px 12px; border: 1px solid var(--app-border, #e5e7eb); border-radius: 8px; background: color-mix(in srgb, var(--app-panel-bg, #fff) 82%, var(--app-bg, #fff)); }
.mcp-panel__status-box > strong { font-size: 13px; }
.mcp-panel__metadata { margin-top: 8px; }
.mcp-panel__actions { display: grid; gap: 0; }
.mcp-panel__action-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--app-divider, var(--app-border, #e5e7eb)); }
.mcp-panel__action-row:first-child { padding-top: 0; }
.mcp-panel__action-row:last-of-type { border-bottom: 0; }
.mcp-panel__action-row > div { min-width: 0; }
.mcp-panel__action-row strong { font-size: 13px; }
.mcp-panel__action-buttons { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 10px; }
.mcp-panel__form { display: grid; gap: 12px; }
.mcp-panel__form label, .mcp-panel__form-field { display: grid; gap: 6px; }
.mcp-panel__form label > span, .mcp-panel__form-field > span { color: var(--app-muted, #667085); font-size: 12px; font-weight: 600; }
.mcp-panel__credential-editor { display: grid; grid-template-columns: 110px minmax(110px, .8fr) minmax(140px, 1.2fr) auto; gap: 6px; align-items: center; }
.mcp-panel__credential-editor :deep(.ant-input) { font-size: 12px; }
.mcp-panel__credential-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.mcp-panel__credential-list span { display: inline-flex; align-items: center; gap: 4px; padding: 3px 7px; border: 1px solid var(--app-border, #e5e7eb); border-radius: 4px; color: var(--app-muted, #667085); font-size: 11px; }
.mcp-panel__credential-list button { padding: 0 2px; border: 0; background: transparent; color: inherit; cursor: pointer; }
@media (max-width: 720px) { .mcp-panel { height: auto; min-height: 0; overflow: visible; } .mcp-panel__detail { min-height: 360px; padding: 16px 0 0; } .mcp-panel__credential-editor { grid-template-columns: 1fr 1fr; } .mcp-panel__credential-editor > :nth-child(3), .mcp-panel__credential-editor > :nth-child(4) { grid-column: 1 / -1; } }
</style>
