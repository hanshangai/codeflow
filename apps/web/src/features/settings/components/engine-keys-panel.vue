<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { CheckCircleFilled, DeleteOutlined, EditOutlined, KeyOutlined, PlusOutlined, SyncOutlined } from "@ant-design/icons-vue";
import {
  CODEX_KEY_SWITCH_CONFLICT_REASONS,
  ENGINE_MODEL_PROVIDERS,
  ENGINE_PROVIDER_BASE_URLS,
  getDefaultEngineProviderId,
  type EngineKeyEntry,
  type EngineModelProviderId,
  type EngineType,
  type UpsertEngineKeyRequestBody,
} from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { createCancelledRequestError, isCancelledRequestError, type ApiRequestContext } from "../../../api/request";
import { isDesktopWorkspace } from "../../../services/desktop";
import { useConfigStore } from "../../../store/config";
import { useEngineKeysStore } from "../../../store/engineKeys";
import { usePresenceStore } from "../../../store/presence";
import { useWorkspacesStore } from "../../../store/workspaces";
import {
  resolveBuiltInRelayAutoEnableScopeKey,
  useBuiltInRelayAutoEnableStore,
} from "../../../store/builtInRelayAutoEnable";
import { upsertEngineKey, deleteEngineKey, activateEngineKey, deactivateEngineKey, testEngineKey } from "../../../api/engineKeys";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { trackProductEvent } from "../../../analytics/analytics";
import EngineCustomModelsPanel from "./EngineCustomModelsPanel.vue";
import {
  ANTHROPIC_RELAY_TARGET,
  CODEX_RELAY_TARGET,
  DEEPSEEK_RELAY_TARGET,
  MOONSHOT_RELAY_TARGET,
  QWEN_RELAY_TARGET,
  ZAI_RELAY_TARGET,
  type BuiltInRelayAvailability,
  type BuiltInRelayTarget,
  useBuiltInRelayKey,
} from "../composables/useBuiltInRelayKey";

defineOptions({ name: "EngineKeysPanel" });

const props = withDefaults(defineProps<{
  active?: boolean;
  surface?: "default" | "h5";
  engineScope?: EngineType | null;
  providerScope?: EngineModelProviderId | null;
  workspaceId?: string;
  /** 整页设置使用固定外框，内容交由内部列表滚动。 */
  fillHeight?: boolean;
  /** 外层页面已展示禁用原因时，隐藏面板内重复提示。 */
  hideDisabledReasonAlert?: boolean;
}>(), {
  active: true,
  surface: "default",
  engineScope: null,
  providerScope: null,
  hideDisabledReasonAlert: false,
});

const { ctx } = useApiContext();
const config = useConfigStore();
const engineKeys = useEngineKeysStore();
const presence = usePresenceStore();
const workspaces = useWorkspacesStore();
const builtInRelay = useBuiltInRelayKey();
const autoEnable = useBuiltInRelayAutoEnableStore();

const effectiveWorkspaceId = computed(() => String(props.workspaceId ?? config.workspaceId ?? "").trim());
const scopeSnapshot = computed(() => engineKeys.scopeSnapshotForWorkspace(effectiveWorkspaceId.value));
const loading = computed(() => scopeSnapshot.value.phase === "loading");
const keys = computed(() => scopeSnapshot.value.keys);
const submitting = ref(false);
const customModelsInitialLoading = ref(false);
const mobileSection = ref<"keys" | "models">("keys");
/** 聚合 Key 与自定义模型首次请求，避免页面提前显示空状态。 */
const initialLoading = computed(() => (loading.value && !keys.value.length && scopeSnapshot.value.lastUpdatedAt == null)
  || ((props.surface !== "h5" || mobileSection.value === "models") && customModelsInitialLoading.value));
const switchingId = ref<string | null>(null);
const deactivatingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const relaySyncingProvider = ref<EngineModelProviderId | null>(null);
const cachedRelayAvailability = builtInRelay.getCachedBuiltInRelayAvailability();
const relayAvailabilityLoading = ref<boolean>(false);
const relayAvailabilityLoaded = ref<boolean>(Boolean(cachedRelayAvailability));
const relayAvailability = ref<BuiltInRelayAvailability>(cachedRelayAvailability ?? { available: false, message: "", publicBaseUrl: "" });
let relayAvailabilityRequestSeq = 0;
const currentWorkspace = computed(() => effectiveWorkspaceId.value
  ? workspaces.byId.get(effectiveWorkspaceId.value as any) ?? null
  : null);
const isSharedWorkspace = computed(() =>
  Boolean(currentWorkspace.value?.kind === "shared" || isSharedWorkspaceSelectionId(effectiveWorkspaceId.value)),
);
const effectiveWorkspaceRuntimeState = computed(() => presence.runtimeStateForWorkspace(effectiveWorkspaceId.value));
const isEffectiveWorkspaceClientOnline = computed(() =>
  effectiveWorkspaceRuntimeState.value.kind === "local" && effectiveWorkspaceRuntimeState.value.status === "online",
);
const canMaintainSharedHostKeys = computed(() =>
  Boolean(
    isSharedWorkspace.value
    && currentWorkspace.value?.shared?.isHostOwner === true
    && currentWorkspace.value?.capabilities?.canMaintainAssets === true,
  ),
);
/** 自动启用内置中转的结果提示：与向导模型步骤共用同一份作用域状态。 */
const autoEnableNotice = computed(() => autoEnable.noticeForWorkspace(effectiveWorkspaceId.value));
/** 桌面首次自动 Key 的失败单独展示，不覆盖真实账号关联。 */
const desktopAutoKeyFailed = computed(() => isDesktopWorkspace(config, effectiveWorkspaceId.value)
  && config.desktopCloudAccountLinked && Boolean(config.desktopCloudAccount?.builtInRelayErrorCode));
const desktopAutoKeyFailureMessage = computed(() => config.desktopCloudAccount?.builtInRelayErrorCode === "DESKTOP_BUILTIN_AUTO_ENABLE_MARKER_FAILED"
  ? "账号已关联，自动启用记录写入失败，本次未自动签发 Key；请检查本地存储后重连。手动启用结果独立展示。"
  : "账号已关联，内置 Key 自动启用失败；请手动启用内置中转或添加自配 Key。");
function dismissAutoEnableNotice(): void {
  const scopeKey = resolveBuiltInRelayAutoEnableScopeKey({
    serverWsOrigin: config.serverWsOrigin,
    userId: config.userSummary?.userId,
    workspaceId: effectiveWorkspaceId.value,
  });
  if (scopeKey) autoEnable.dismissNotice(scopeKey);
}
const canUseEngineKeyRoute = computed(() =>
  Boolean(effectiveWorkspaceId.value)
  && (isDesktopWorkspace(config, effectiveWorkspaceId.value) || config.connected)
  && (isSharedWorkspace.value ? canMaintainSharedHostKeys.value : isEffectiveWorkspaceClientOnline.value),
);
const disabledReason = computed(() => {
  if (!effectiveWorkspaceId.value) return "请先选择工作区后再管理大模型 Key。";
  if (!isDesktopWorkspace(config, effectiveWorkspaceId.value) && !config.connected) return "请先连接 Server 后再管理大模型 Key。";
  if (isSharedWorkspace.value && !canMaintainSharedHostKeys.value) return "共享工作区成员不可维护大模型 Key，请由共享工作区 Host 处理。";
  if (!isSharedWorkspace.value && !isEffectiveWorkspaceClientOnline.value) return "请先启动当前工作区的 Client，Key 配置保存在本地 Client。";
  return "";
});

/* 表单：弹框 + 编辑模式 */
const modalVisible = ref(false);
const editingId = ref<string | null>(null);
const formEngine = ref<EngineType>("claude");
const formProviderId = ref<EngineModelProviderId>("anthropic");
const formLabel = ref("");
const formApiKey = ref("");
const formBaseUrl = ref("");
const labelInputReadonly = ref(true);
const apiKeyInputReadonly = ref(true);
const testingKey = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);
const operating = computed(() => submitting.value || testingKey.value || !!switchingId.value || !!deactivatingId.value || !!deletingId.value || !!relaySyncingProvider.value);
const actionsDisabled = computed(() => operating.value || !canUseEngineKeyRoute.value);
const canUseBuiltInRelay = computed(() => relayAvailability.value.available);
const builtInRelayDisabled = computed(() => actionsDisabled.value || relayAvailabilityLoading.value || !config.isAccountSession
  || (config.isDesktop && !config.desktopCloudAccountLinked) || !canUseBuiltInRelay.value);

/** 固定本轮账号、Server、会话与关联代际，禁止迟到结果覆盖另一登录态。 */
function captureRelayScope(): () => boolean {
  const scope = [config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.desktopCloudAccount?.generation, effectiveWorkspaceId.value];
  return () => !config.logoutInProgress && scope.every((value, index) => value === [config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.desktopCloudAccount?.generation, effectiveWorkspaceId.value][index]);
}

/** 冻结原凭据，并在鉴权和 401 清理边界拒绝旧账号继续操作。 */
function captureKeyRequestContext(shouldApply: () => boolean): ApiRequestContext {
  const context = { ...ctx.value };
  return { ...context, ensureSession: async signal => {
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    await context.ensureSession?.(signal);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    return context.sessionToken ?? "";
  }, clearSession: () => {
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    context.clearSession?.();
  } };
}
const LEGACY_BUILT_IN_RELAY_PATH_MARKER = ["/api/", "sub2", "api"].join("");
const RELAY_IMPLEMENTATION_NAME_PATTERN = new RegExp(["sub2", "api"].join(""), "gi");

/** 判断 Key 是否落在当前页面限定的引擎与供应商范围内。 */
function isKeyInScope(key: EngineKeyEntry): boolean {
  if (props.engineScope && key.engine !== props.engineScope) return false;
  if (props.providerScope && key.providerId !== props.providerScope) return false;
  return true;
}

/** 按当前作用域选择新增 Key 的默认供应商。 */
function resolveDefaultProviderId(engine: EngineType): EngineModelProviderId {
  if (props.providerScope && ENGINE_MODEL_PROVIDERS[props.providerScope]?.engines.includes(engine)) {
    return props.providerScope;
  }
  return getDefaultEngineProviderId(engine);
}

/** 同供应商内按 createdAt 升序，避免激活后行跳到顶部造成误触。 */
function byCreated(a: EngineKeyEntry, b: EngineKeyEntry): number {
  return a.createdAt - b.createdAt;
}
const scopedKeys = computed(() => keys.value.filter(isKeyInScope));

/** 左侧 provider 导航项静态描述：每个 (engine, providerId) 对应一个 sidebar 入口及对应的内置中转目标。 */
type ProviderDescriptor = {
  engine: EngineType;
  providerId: EngineModelProviderId;
  label: string;
  engineLabel: string;
  builtInTarget: BuiltInRelayTarget | null;
};

const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  { engine: "codex", providerId: "openai", label: "OpenAI Codex", engineLabel: "Codex 引擎", builtInTarget: CODEX_RELAY_TARGET },
  { engine: "claude", providerId: "anthropic", label: "Anthropic Claude", engineLabel: "Claude 引擎", builtInTarget: ANTHROPIC_RELAY_TARGET },
  { engine: "claude", providerId: "deepseek", label: "DeepSeek", engineLabel: "DeepSeek 兼容引擎", builtInTarget: DEEPSEEK_RELAY_TARGET },
  { engine: "claude", providerId: "moonshot", label: "Moonshot / Kimi", engineLabel: "Moonshot 兼容引擎", builtInTarget: MOONSHOT_RELAY_TARGET },
  { engine: "claude", providerId: "zai", label: "Z.AI / 智谱", engineLabel: "Z.AI 兼容引擎", builtInTarget: ZAI_RELAY_TARGET },
  { engine: "claude", providerId: "qwen", label: "Qwen Cloud", engineLabel: "Qwen 兼容引擎", builtInTarget: QWEN_RELAY_TARGET },
];

/** 按 props 上的 scope 过滤左侧 sidebar 中可见的 provider 集合。 */
const sidebarProviders = computed<ProviderDescriptor[]>(() =>
  PROVIDER_DESCRIPTORS
    .filter((p) => !props.engineScope || p.engine === props.engineScope)
    .filter((p) => !props.providerScope || p.providerId === props.providerScope),
);

const selectedProviderId = ref<EngineModelProviderId | null>(sidebarProviders.value[0]?.providerId ?? null);
const selectedProvider = computed<ProviderDescriptor | null>(
  () => sidebarProviders.value.find((p) => p.providerId === selectedProviderId.value) ?? null,
);
/** sidebar 只有 1 项时（admin 单 tab 场景）隐藏导航列，detail 全宽。 */
const showSidebar = computed<boolean>(() => sidebarProviders.value.length > 1);

/** 当前选中 provider 下的 Key 列表（含可能的内置中转 Key），按 createdAt 升序。 */
const selectedKeys = computed<EngineKeyEntry[]>(() => {
  const p = selectedProvider.value;
  if (!p) return [];
  return scopedKeys.value
    .filter((k) => k.engine === p.engine && k.providerId === p.providerId)
    .slice()
    .sort(byCreated);
});

/** sidebar 项的 key 计数。 */
function providerKeyCount(p: ProviderDescriptor): number {
  return scopedKeys.value.filter((k) => k.engine === p.engine && k.providerId === p.providerId).length;
}

/** sidebar 项是否存在已激活的默认 Key。 */
function providerHasActive(p: ProviderDescriptor): boolean {
  return scopedKeys.value.some((k) => k.engine === p.engine && k.providerId === p.providerId && k.isActive);
}

/** 当前选中 provider 静态支持的内置中转 target，用于识别历史本地 Key。 */
const selectedRelayTarget = computed<BuiltInRelayTarget | null>(() => selectedProvider.value?.builtInTarget ?? null);

/** 判断 provider 是否具备可操作的内置中转分组配置。 */
function canOperateBuiltInRelayTarget(target: BuiltInRelayTarget | null): boolean {
  return Boolean(
    target
    && canUseBuiltInRelay.value
    && relayAvailability.value.providerGroupsConfigured?.[target.providerId],
  );
}

/** 当前选中 provider 可操作的内置中转 target，必须以后端动态配置和 provider 分组为准。 */
const currentRelayTarget = computed<BuiltInRelayTarget | null>(() =>
  canOperateBuiltInRelayTarget(selectedRelayTarget.value) ? selectedRelayTarget.value : null,
);

/** 当前 provider 空列表时展示的提示，区分普通无 Key 和中转未配置。 */
const emptyStateHint = computed<string>(() => {
  const target = selectedRelayTarget.value;
  if (!target) return "密钥仅用于当前 Client 的模型连接。";
  if (!config.isAccountSession) return "登录账号后，也可使用内置中转服务。";
  if (relayAvailabilityLoading.value) return "正在读取内置中转配置。";
  if (!relayAvailability.value.available) return relayAvailability.value.message || "内置中转未启用。";
  if (!relayAvailability.value.providerGroupsConfigured?.[target.providerId]) return "该供应商暂未提供内置中转，可使用自配密钥连接。";
  return "密钥仅用于当前 Client 的模型连接。";
});

/** 判断一把 Key 是否为内置中转生成（用于在卡片上加 badge 区分）。 */
function isKeyBuiltInRelay(k: EngineKeyEntry): boolean {
  const target = PROVIDER_DESCRIPTORS.find((p) => p.engine === k.engine && p.providerId === k.providerId)?.builtInTarget;
  if (!target) return false;
  return builtInRelay.isBuiltInRelayKey(k, target);
}

/** 返回当前 Key 对应的内置中转目标，普通 Key 返回 null。 */
function getKeyRelayTarget(k: EngineKeyEntry): BuiltInRelayTarget | null {
  const target = PROVIDER_DESCRIPTORS.find((p) => p.engine === k.engine && p.providerId === k.providerId)?.builtInTarget ?? null;
  return target && builtInRelay.isBuiltInRelayKey(k, target) ? target : null;
}

/** 判断已存在的本地内置中转 Key 是否仍允许 Token 充值。 */
function canOperateBuiltInRelayKey(k: EngineKeyEntry): boolean {
  return canOperateBuiltInRelayTarget(getKeyRelayTarget(k));
}

/** 判断本地内置中转 Key 是否落后于当前公开中转地址。 */
function isBuiltInRelayKeyOutdated(k: EngineKeyEntry): boolean {
  const target = getKeyRelayTarget(k);
  if (!target || !relayAvailability.value.available) return false;
  const publicBaseUrl = String(relayAvailability.value.publicBaseUrl ?? "").trim();
  if (!publicBaseUrl) return false;
  return String(k.baseUrl ?? "").trim() !== builtInRelay.resolveBuiltInRelayBaseUrl(target.engine, publicBaseUrl);
}

/** 在线状态未确认前保留本地内置中转 Key，确认不可用后再隐藏历史项。 */
function shouldDisplayEngineKey(k: EngineKeyEntry): boolean {
  const target = getKeyRelayTarget(k);
  if (!target) return true;
  if (!relayAvailabilityLoaded.value) return true;
  return canOperateBuiltInRelayTarget(target);
}

/** 历史内置中转 Key 可能还保存旧代理路径，页面不再展示实现名。 */
function displayBaseUrl(k: EngineKeyEntry): string {
  const value = String(k.baseUrl ?? "").trim();
  if (!value) return "";
  if (getKeyRelayTarget(k) && value.toLowerCase().includes(LEGACY_BUILT_IN_RELAY_PATH_MARKER)) {
    return "旧内置中转地址，需要修复内置中转";
  }
  return value;
}

/** 规整内置中转错误文案，避免实现名透出到设置页。 */
function toBuiltInRelayDisplayText(value: unknown): string {
  return String(value ?? "")
    .replace(RELAY_IMPLEMENTATION_NAME_PATTERN, "内置中转")
    .replace(/Relay|RELAY|relay/g, "内置中转");
}

watch(sidebarProviders, (list) => {
  if (!list.some((p) => p.providerId === selectedProviderId.value)) {
    selectedProviderId.value = list[0]?.providerId ?? null;
  }
}, { immediate: true });

const providerOptions = computed(() =>
  Object.values(ENGINE_MODEL_PROVIDERS)
    .filter((provider) => provider.engines.includes(formEngine.value))
    .filter((provider) => !props.providerScope || provider.providerId === props.providerScope)
    .map((provider) => ({ value: provider.providerId, label: provider.providerLabel })),
);

/** Claude 兼容第三方 provider 必须填写 Base URL。 */
function requiresClaudeCompatibleBaseUrl(engine: EngineType, providerId: EngineModelProviderId): boolean {
  return engine === "claude" && providerId !== "anthropic";
}

/** 当前 provider 的展示名，未知时保留原始 id 便于排障。 */
function getProviderDisplayLabel(providerId: EngineModelProviderId): string {
  return ENGINE_MODEL_PROVIDERS[providerId]?.providerLabel ?? providerId;
}

/** API Key 占位提示按 provider 类型收窄，避免误导 Anthropic key 格式。 */
function getApiKeyPlaceholder(): string {
  return formEngine.value === "claude" && formProviderId.value === "anthropic" ? "sk-ant-xxx" : "sk-xxx";
}

/** Base URL 标签展示必填状态。 */
function getBaseUrlLabel(): string {
  const label = getProviderDisplayLabel(formProviderId.value);
  return requiresClaudeCompatibleBaseUrl(formEngine.value, formProviderId.value)
    ? `Base URL（${label} 必填）`
    : "Base URL（可选）";
}

/** 供应商的官方默认 Base URL：Claude 引擎按供应商取值，Codex 引擎使用 OpenAI 端点。 */
function resolveDefaultBaseUrl(engine: EngineType, providerId: EngineModelProviderId | undefined): string {
  const targetProvider = providerId ?? getDefaultEngineProviderId(engine);
  return ENGINE_PROVIDER_BASE_URLS[targetProvider] ?? ENGINE_PROVIDER_BASE_URLS[engine === "claude" ? "anthropic" : "openai"];
}

/** Base URL 输入框清空后的兜底提示复用同一默认值。 */
function getBaseUrlPlaceholder(): string {
  return resolveDefaultBaseUrl(formEngine.value, formProviderId.value);
}

/** 当前选中 provider 的内置中转 Key 实体（若已在本地同步过）。 */
const currentRelayKey = computed<EngineKeyEntry | null>(() => {
  const target = selectedRelayTarget.value;
  return target ? builtInRelay.findBuiltInRelayKey(target, effectiveWorkspaceId.value) : null;
});

/** 当前选中 provider 的内置中转是否正在同步中。 */
const currentRelaySyncing = computed<boolean>(() =>
  Boolean(selectedRelayTarget.value && relaySyncingProvider.value === selectedRelayTarget.value.providerId),
);

/** 用于渲染的 Key 列表：内置中转 Key 置顶，其它按 createdAt 升序。 */
const displayedKeys = computed<EngineKeyEntry[]>(() => {
  const relay = currentRelayKey.value && shouldDisplayEngineKey(currentRelayKey.value)
    ? currentRelayKey.value
    : null;
  const rest = selectedKeys.value.filter((k) => (!relay || k.id !== relay.id) && shouldDisplayEngineKey(k));
  return relay ? [relay, ...rest] : rest;
});

/** 读取网页端中转配置运行态；未启用时用户侧不展示内置中转入口。 */
async function loadBuiltInRelayAvailability(options: { notifyOnError?: boolean } = {}): Promise<void> {
  const requestSeq = ++relayAvailabilityRequestSeq;
  const isCurrent = captureRelayScope();
  if (!(config.isDesktop ? config.desktopCloudAccountLinked : config.connected) || !config.isAccountSession) {
    relayAvailabilityLoading.value = false;
    relayAvailabilityLoaded.value = false;
    relayAvailability.value = { available: false, message: "", publicBaseUrl: "" };
    return;
  }
  const cached = builtInRelay.getCachedBuiltInRelayAvailability();
  if (cached && !relayAvailabilityLoaded.value) {
    relayAvailability.value = cached;
    relayAvailabilityLoaded.value = true;
  }
  relayAvailabilityLoading.value = true;
  try {
    const availability = await builtInRelay.getBuiltInRelayAvailability();
    if (requestSeq !== relayAvailabilityRequestSeq || !isCurrent()) return;
    relayAvailability.value = availability;
    relayAvailabilityLoaded.value = true;
  } catch (error) {
    if (requestSeq !== relayAvailabilityRequestSeq || !isCurrent() || isCancelledRequestError(error)) return;
    const text = toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)) || "内置中转状态读取失败";
    relayAvailability.value = relayAvailabilityLoaded.value
      ? { ...relayAvailability.value, available: false, message: text }
      : { available: false, message: text, publicBaseUrl: "" };
    if (options.notifyOnError) message.warning(text);
  } finally {
    if (requestSeq === relayAvailabilityRequestSeq) {
      relayAvailabilityLoading.value = false;
    }
  }
}

/** 仅识别 Server 登记的普通 Codex running-turn 确认冲突，禁止按文案模糊匹配。 */
function readRunningCodexTurnConflict(failure: unknown): { message: string; runningCount: number } | null {
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
  const record = failure as { code?: unknown; message?: unknown; details?: unknown };
  if (record.code !== "CONFLICT" || !record.details || typeof record.details !== "object" || Array.isArray(record.details)) {
    return null;
  }
  const details = record.details as Record<string, unknown>;
  if (details.reason !== CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired) return null;
  const runningCount = Number(details.runningCount);
  return {
    message: String(record.message ?? "").trim() || "当前有 Codex 回合运行中",
    runningCount: Number.isSafeInteger(runningCount) && runningCount > 0 ? runningCount : 0,
  };
}

/** 等待用户确认正式停止普通回合；取消时不发起第二次切换请求。 */
function confirmRunningCodexTurnStop(conflict: { message: string; runningCount: number }): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: "停止运行中的 Codex 回合并切换 Key？",
      content: `${conflict.message}\n停止后普通回合会以手动中断结束，编排节点会进入待反馈。`,
      okText: conflict.runningCount > 0 ? `停止 ${conflict.runningCount} 个回合并切换` : "停止并切换",
      cancelText: "取消",
      okType: "danger",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

/** 同步 Server 侧内置中转 key，并把当前 provider 的内置中转 Key 写入本地 Engine Key。 */
async function syncBuiltInRelay(target: BuiltInRelayTarget): Promise<void> {
  const workspaceId = effectiveWorkspaceId.value;
  const shouldApply = captureRelayScope();
  if (!canUseEngineKeyRoute.value || !workspaceId) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  if (!config.isAccountSession) {
    message.info("请先登录账号后再启用内置中转");
    return;
  }
  if (!canOperateBuiltInRelayTarget(target)) {
    await loadBuiltInRelayAvailability({ notifyOnError: true });
    if (!shouldApply()) return;
    if (!canOperateBuiltInRelayTarget(target)) {
      if (effectiveWorkspaceId.value === workspaceId) {
        message.info(relayAvailability.value.message || "当前供应商未配置内置中转分组");
      }
      return;
    }
  }
  relaySyncingProvider.value = target.providerId;
  try {
    try {
      await builtInRelay.syncBuiltInRelayKey(target, workspaceId, shouldApply);
    } catch (error) {
      const conflict = readRunningCodexTurnConflict(error);
      if (!conflict) throw error;
      if (!shouldApply()) return;
      const confirmed = await confirmRunningCodexTurnStop(conflict);
      if (!confirmed || !shouldApply()) return;
      await builtInRelay.syncBuiltInRelayKey(target, workspaceId, shouldApply, { stopRunningTurns: true });
    }
    if (shouldApply()) message.success("内置中转 Key 已启用");
  } catch (error) {
    if (shouldApply() && !isCancelledRequestError(error)) {
      message.error(toBuiltInRelayDisplayText(error instanceof Error ? error.message : String(error)));
    }
  } finally {
    relaySyncingProvider.value = null;
  }
}

/** 聚焦后解除标签只读，避免浏览器把站点登录账号自动填入。 */
function enableLabelInput() {
  labelInputReadonly.value = false;
}

/** 聚焦后解除 API Key 只读，避免密码管理器把站点登录密码自动填入。 */
function enableApiKeyInput() {
  apiKeyInputReadonly.value = false;
}

/** 重置表单，并按当前作用域预选引擎与供应商。 */
function resetForm() {
  editingId.value = null;
  formEngine.value = props.engineScope ?? "claude";
  formProviderId.value = resolveDefaultProviderId(formEngine.value);
  formLabel.value = "";
  formApiKey.value = "";
  formBaseUrl.value = "";
  labelInputReadonly.value = true;
  apiKeyInputReadonly.value = true;
  testingKey.value = false;
  testResult.value = null;
}

/** 打开新增弹框：可指定预选引擎与供应商（用于 sidebar 当前 provider 的「添加 Key」按钮）。 */
function openAddModal(engine?: EngineType, providerId?: EngineModelProviderId) {
  resetForm();
  if (engine) {
    formEngine.value = engine;
    formProviderId.value = providerId ?? resolveDefaultProviderId(engine);
  }
  // 新建时按当前供应商预填默认 Base URL，用户可直接采用或覆盖。
  formBaseUrl.value = resolveDefaultBaseUrl(formEngine.value, formProviderId.value);
  modalVisible.value = true;
}

/** 打开编辑弹框；来源不明的历史项必须重新录入秘密。 */
function startEdit(k: EngineKeyEntry) {
  resetForm();
  editingId.value = k.id;
  formEngine.value = k.engine;
  formProviderId.value = k.providerId;
  formLabel.value = k.label;
  formApiKey.value = k.source === "unknown" ? "" : k.apiKey;
  formBaseUrl.value = k.baseUrl ?? "";
  modalVisible.value = true;
}

/** 关闭弹框（取消或保存成功后调用）。 */
function closeModal() {
  modalVisible.value = false;
  resetForm();
}

/** 刷新仅提交当前账号所有者的列表，旧 owner 的迟到结果按作用域取消。 */
async function refresh(workspaceId: string = effectiveWorkspaceId.value) {
  if (!props.active || !workspaceId || workspaceId !== effectiveWorkspaceId.value) return;
  if (!canUseEngineKeyRoute.value) return;
  const shouldApply = captureRelayScope();
  try {
    await engineKeys.refresh(captureKeyRequestContext(shouldApply), workspaceId, shouldApply);
  } catch (error) {
    const failure = shouldApply() ? error : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    if (effectiveWorkspaceId.value === workspaceId) {
      message.error(failure instanceof Error ? failure.message : String(failure));
    }
  }
}

/** 保存 Key；确认重试与后续提示始终绑定发起时的账号所有者。 */
async function doSubmit() {
  if (!canUseEngineKeyRoute.value) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  const isEdit = !!editingId.value;
  const label = formLabel.value.trim();
  const apiKey = formApiKey.value.trim();
  const baseUrl = formBaseUrl.value.trim() || null;
  if (!label) { message.warning("请输入标签"); return; }
  if (!apiKey) { message.warning("请输入 API Key"); return; }
  if (props.engineScope && formEngine.value !== props.engineScope) { message.warning("当前页签不支持该引擎"); return; }
  if (props.providerScope && formProviderId.value !== props.providerScope) { message.warning("当前页签不支持该供应商"); return; }
  if (requiresClaudeCompatibleBaseUrl(formEngine.value, formProviderId.value) && !baseUrl) {
    message.warning(`${getProviderDisplayLabel(formProviderId.value)} 供应商需要填写 Base URL`);
    return;
  }
  const workspaceId = effectiveWorkspaceId.value;
  if (!workspaceId) return;
  const shouldApply = captureRelayScope();
  const requestContext = captureKeyRequestContext(shouldApply);
  submitting.value = true;
  try {
    const payload: UpsertEngineKeyRequestBody = { label, engine: formEngine.value, providerId: formProviderId.value, apiKey, baseUrl };
    if (editingId.value) payload.id = editingId.value;
    let res = await upsertEngineKey(requestContext, payload, workspaceId);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    const conflict = !res.ok ? readRunningCodexTurnConflict(res) : null;
    if (conflict) {
      const confirmed = await confirmRunningCodexTurnStop(conflict);
      if (!confirmed) return;
      if (!shouldApply()) throw createCancelledRequestError("scope-change");
      res = await upsertEngineKey(requestContext, { ...payload, stopRunningTurns: true }, workspaceId);
    }
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    if (res.ok) {
      message.success(isEdit ? "Key 已更新" : "Key 已添加");
      trackProductEvent("settings_save_success", { settings_panel: "engine_keys", settings_action: isEdit ? "update_key" : "add_key", source: "settings" });
      closeModal();
      await refresh(workspaceId);
    } else {
      trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: isEdit ? "update_key" : "add_key", source: "settings", error_code_group: "request_rejected" });
      message.error((res as any).message ?? (isEdit ? "更新失败" : "添加失败"));
    }
  } catch (e) {
    const failure = shouldApply() ? e : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: isEdit ? "update_key" : "add_key", source: "settings", error_code_group: "request_error" });
    message.error(failure instanceof Error ? failure.message : String(failure));
  } finally {
    submitting.value = false;
  }
}

/** 当前待测配置签名；请求返回时用它拒绝已过期表单的结果。 */
function currentTestSignature(): string {
  return JSON.stringify([formEngine.value, formProviderId.value, formApiKey.value.trim(), formBaseUrl.value.trim()]);
}

/** 测试弹框内未保存的 Key 配置；结果保留在弹框内，失败不改变表单。 */
async function doTestKey() {
  if (testingKey.value || submitting.value) return;
  if (!canUseEngineKeyRoute.value) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  const apiKey = formApiKey.value.trim();
  const baseUrl = formBaseUrl.value.trim() || null;
  if (!apiKey) { message.warning("请输入 API Key"); return; }
  if (requiresClaudeCompatibleBaseUrl(formEngine.value, formProviderId.value) && !baseUrl) {
    message.warning(`${getProviderDisplayLabel(formProviderId.value)} 供应商需要填写 Base URL`);
    return;
  }
  const workspaceId = effectiveWorkspaceId.value;
  if (!workspaceId) return;
  const shouldApply = captureRelayScope();
  const requestContext = captureKeyRequestContext(shouldApply);
  const signature = currentTestSignature();
  testingKey.value = true;
  testResult.value = null;
  try {
    const res = await testEngineKey(requestContext, {
      engine: formEngine.value,
      providerId: formProviderId.value,
      apiKey,
      baseUrl,
    }, workspaceId);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    if (signature !== currentTestSignature()) {
      testResult.value = { ok: false, message: "测试期间配置已变更，请重新测试。" };
      return;
    }
    if (res.ok) {
      const detail = [res.model, res.latencyMs != null ? `${res.latencyMs}ms` : ""].filter(Boolean).join(" · ");
      testResult.value = { ok: true, message: detail || "供应商已接受测试请求" };
    } else {
      testResult.value = { ok: false, message: res.message ?? "连接失败，请检查 Key 和 Base URL" };
    }
  } catch (error) {
    const failure = shouldApply() ? error : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    testResult.value = signature !== currentTestSignature()
      ? { ok: false, message: "测试期间配置已变更，请重新测试。" }
      : { ok: false, message: failure instanceof Error ? failure.message : String(failure) };
  } finally {
    testingKey.value = false;
  }
}

/** 空自配 Key 先要求重录；跨账号的旧确认不得停止新账号的 Codex 回合。 */
async function doActivate(id: string) {
  const workspaceId = effectiveWorkspaceId.value;
  if (!canUseEngineKeyRoute.value || !workspaceId) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  const key = keys.value.find((item) => item.id === id) ?? null;
  const target = key ? getKeyRelayTarget(key) : null;
  if (target) {
    await syncBuiltInRelay(target);
    return;
  }
  if (key && key.source !== "builtin" && !key.apiKey.trim()) {
    message.warning("请先编辑并重新录入 API Key，再启用。");
    return;
  }
  const shouldApply = captureRelayScope();
  const requestContext = captureKeyRequestContext(shouldApply);
  switchingId.value = id;
  try {
    let res = await activateEngineKey(requestContext, { id }, workspaceId);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    const conflict = !res.ok ? readRunningCodexTurnConflict(res) : null;
    if (conflict) {
      const confirmed = await confirmRunningCodexTurnStop(conflict);
      if (!confirmed) return;
      if (!shouldApply()) throw createCancelledRequestError("scope-change");
      res = await activateEngineKey(requestContext, { id, stopRunningTurns: true }, workspaceId);
    }
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    if (res.ok) {
      message.success("已启用");
      trackProductEvent("settings_save_success", { settings_panel: "engine_keys", settings_action: "activate_key", source: "settings" });
      await refresh(workspaceId);
    } else {
      trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "activate_key", source: "settings", error_code_group: "request_rejected" });
      message.error((res as any).message ?? "切换失败");
    }
  } catch (e) {
    const failure = shouldApply() ? e : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "activate_key", source: "settings", error_code_group: "request_error" });
    message.error(failure instanceof Error ? failure.message : String(failure));
  } finally {
    switchingId.value = null;
  }
}

/** 取消启用当前 Key；迟到响应只影响发起时的账号所有者。 */
async function doDeactivate(id: string) {
  const workspaceId = effectiveWorkspaceId.value;
  if (!canUseEngineKeyRoute.value || !workspaceId) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  const shouldApply = captureRelayScope();
  const requestContext = captureKeyRequestContext(shouldApply);
  deactivatingId.value = id;
  try {
    const res = await deactivateEngineKey(requestContext, { id }, workspaceId);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    if (res.ok) {
      message.success("已取消启用");
      trackProductEvent("settings_save_success", { settings_panel: "engine_keys", settings_action: "deactivate_key", source: "settings" });
      await refresh(workspaceId);
    } else {
      trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "deactivate_key", source: "settings", error_code_group: "request_rejected" });
      message.error((res as any).message ?? "取消启用失败");
    }
  } catch (e) {
    const failure = shouldApply() ? e : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "deactivate_key", source: "settings", error_code_group: "request_error" });
    message.error(failure instanceof Error ? failure.message : String(failure));
  } finally {
    deactivatingId.value = null;
  }
}

/** 删除指定 Key；仅向仍有效的账号所有者提示并刷新列表。 */
async function doDelete(id: string) {
  const workspaceId = effectiveWorkspaceId.value;
  if (!canUseEngineKeyRoute.value || !workspaceId) {
    message.info(disabledReason.value || "当前工作区暂不能维护大模型 Key");
    return;
  }
  const shouldApply = captureRelayScope();
  const requestContext = captureKeyRequestContext(shouldApply);
  deletingId.value = id;
  try {
    const res = await deleteEngineKey(requestContext, { id }, workspaceId);
    if (!shouldApply()) throw createCancelledRequestError("scope-change");
    if (res.ok) {
      message.success("已删除");
      trackProductEvent("settings_save_success", { settings_panel: "engine_keys", settings_action: "delete_key", source: "settings" });
      await refresh(workspaceId);
    } else {
      trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "delete_key", source: "settings", error_code_group: "request_rejected" });
      message.error((res as any).message ?? "删除失败");
    }
  } catch (e) {
    const failure = shouldApply() ? e : createCancelledRequestError("scope-change");
    if (isCancelledRequestError(failure)) return;
    trackProductEvent("settings_save_failed", { settings_panel: "engine_keys", settings_action: "delete_key", source: "settings", error_code_group: "request_error" });
    message.error(failure instanceof Error ? failure.message : String(failure));
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => {
  void refresh();
  void loadBuiltInRelayAvailability();
});

watch(() => [props.active, effectiveWorkspaceId.value] as const, ([active, workspaceId], previous) => {
  const [prevActive, prevWorkspaceId] = previous ?? [undefined, undefined];
  if (!active) return;
  if (prevActive === active && prevWorkspaceId === workspaceId) return;
  void refresh(workspaceId);
  void loadBuiltInRelayAvailability();
});

watch(() => [props.active, config.connected, config.isAccountSession, config.serverWsOrigin, config.sessionToken, config.userSummary?.userId, config.desktopCloudAccountLinked, config.desktopCloudAccount?.generation] as const, () => {
  if (!props.active) return;
  void loadBuiltInRelayAvailability();
});

watch(isEffectiveWorkspaceClientOnline, (online) => {
  if (props.active && (online || isSharedWorkspace.value)) void refresh();
});

watch(() => canUseEngineKeyRoute.value, (ready, previous) => {
  if (props.active && ready && ready !== previous) void refresh();
});

watch(formEngine, (engine) => {
  const allowed = providerOptions.value.some((option) => option.value === formProviderId.value);
  if (!allowed) formProviderId.value = resolveDefaultProviderId(engine);
});

/** 切换供应商时跟随默认 Base URL；编辑既有 Key、或用户已自定义过（值不再是旧默认值）时保留原值。 */
watch(formProviderId, (providerId, previousProviderId) => {
  if (editingId.value) return;
  const current = formBaseUrl.value.trim();
  if (current && current !== resolveDefaultBaseUrl(formEngine.value, previousProviderId)) return;
  formBaseUrl.value = resolveDefaultBaseUrl(formEngine.value, providerId);
});
// 修改任一连接参数后旧测试结果不再可信，必须重新测试。
watch([formEngine, formProviderId, formApiKey, formBaseUrl], () => {
  testResult.value = null;
});
</script>

<template>
  <div class="ek-panel" :class="{ 'ek-panel--h5': props.surface === 'h5', 'ek-panel--fill': props.fillHeight }">
    <a-alert
      v-if="disabledReason && !props.hideDisabledReasonAlert"
      class="ek-panel__notice"
      type="info"
      show-icon
      :message="disabledReason"
    />
    <a-alert
      v-else-if="isSharedWorkspace && canMaintainSharedHostKeys"
      class="ek-panel__notice"
      type="success"
      show-icon
      message="正在维护共享工作区 Host 的大模型 Key"
    />
    <a-alert
      v-if="desktopAutoKeyFailed"
      class="ek-panel__notice"
      type="error"
      show-icon
      :message="desktopAutoKeyFailureMessage"
    />
    <a-alert
      v-if="autoEnableNotice"
      class="ek-panel__notice"
      :type="autoEnableNotice.kind === 'success' ? 'success' : 'warning'"
      show-icon
      closable
      :message="autoEnableNotice.message"
      @close="dismissAutoEnableNotice"
    />
    <a-spin
      :spinning="initialLoading"
      wrapper-class-name="ek-panel__initial-loading"
    >
      <div class="ek-panel__body">
      <div class="ek-panel__layout" :class="{ 'is-single': !showSidebar, 'is-models': props.surface === 'h5' && mobileSection === 'models' }">
      <!-- 左侧 provider 列表（单 scope 场景下隐藏） -->
      <aside v-if="showSidebar" class="ek-panel__sidebar">
        <button
          v-for="p in sidebarProviders"
          :key="p.providerId"
          type="button"
          class="ek-panel__sidebar-item"
          :class="{ 'is-selected': selectedProviderId === p.providerId }"
          @click="selectedProviderId = p.providerId"
        >
          <div class="ek-panel__sidebar-item-header">
            <span class="ek-panel__sidebar-item-dot" :class="{ 'is-active': providerHasActive(p) }" />
            <span class="ek-panel__sidebar-item-label">{{ p.label }}</span>
          </div>
          <div class="ek-panel__sidebar-item-meta">
            <span>{{ p.engineLabel }}</span>
            <span class="ek-panel__sidebar-item-count">{{ providerKeyCount(p) }} {{ props.surface === 'h5' ? '个密钥' : 'keys' }}</span>
          </div>
        </button>
      </aside>

      <div v-if="props.surface === 'h5'" class="ek-panel__mobile-tabs" role="tablist" aria-label="模型与密钥内容">
        <button type="button" role="tab" :aria-selected="mobileSection === 'keys'" @click="mobileSection = 'keys'">密钥管理</button>
        <button type="button" role="tab" :aria-selected="mobileSection === 'models'" @click="mobileSection = 'models'">自定义模型</button>
      </div>

      <!-- 右侧 provider 详情 -->
      <section v-if="selectedProvider" v-show="props.surface !== 'h5' || mobileSection === 'keys'" class="ek-panel__detail">
        <header class="ek-panel__detail-header">
          <div class="ek-panel__detail-title-wrap">
            <div class="ek-panel__detail-title">连接密钥 <span v-if="displayedKeys.length" class="ek-panel__key-count">{{ displayedKeys.length }}</span></div>
            <div class="ek-panel__detail-subtitle">{{ selectedProvider.label }} · 管理访问凭证与服务地址</div>
          </div>
          <div v-if="displayedKeys.length || currentRelayTarget" class="ek-panel__detail-actions">
            <a-button
              type="primary"
              :disabled="!canUseEngineKeyRoute"
              @click="openAddModal(selectedProvider.engine, selectedProvider.providerId)"
            >
              <template #icon><PlusOutlined /></template>
              添加密钥
            </a-button>
          </div>
        </header>

        <div v-if="!currentRelayTarget && !displayedKeys.length" class="ek-panel__empty">
          <div class="ek-panel__empty-icon"><KeyOutlined /></div>
          <h3>连接你的模型服务</h3>
          <p>添加 {{ selectedProvider.label }} API Key，即可在会话中选择模型。</p>
          <a-button type="primary" :disabled="!canUseEngineKeyRoute" @click="openAddModal(selectedProvider.engine, selectedProvider.providerId)">
            <template #icon><PlusOutlined /></template>
            添加密钥
          </a-button>
          <p class="ek-panel__empty-hint">{{ emptyStateHint }}</p>
        </div>

        <div v-else class="ek-panel__item-list">
          <!-- 内置中转引导卡：仅当本地还未同步过该 provider 的内置中转 Key 时显示 -->
          <div
            v-if="currentRelayTarget && !currentRelayKey"
            class="ek-panel__item"
          >
            <div class="ek-panel__item-main">
              <div class="ek-panel__item-row">
                <span class="ek-panel__item-label">CodeFlow 内置中转</span>
                <span class="ek-panel__item-tag">内置中转</span>
              </div>
              <div class="ek-panel__item-row">
                <span class="ek-panel__item-hint">使用当前账号内置中转 Key，通过公开中转地址访问，无需自备凭证。</span>
              </div>
            </div>
            <div class="ek-panel__item-actions">
              <a-button
                type="primary"
                size="small"
                :loading="currentRelaySyncing"
                :disabled="builtInRelayDisabled && !currentRelaySyncing"
                @click="syncBuiltInRelay(currentRelayTarget)"
              >
                启用
              </a-button>
            </div>
          </div>

          <div
            v-for="k in displayedKeys"
            :key="k.id"
            class="ek-panel__item"
            :class="{ 'ek-panel__item--active': k.isActive }"
          >
            <div class="ek-panel__item-main">
              <div class="ek-panel__item-row ek-panel__item-title-row">
                <span class="ek-panel__item-label" :title="k.label">{{ k.label }}</span>
                <span v-if="isKeyBuiltInRelay(k)" class="ek-panel__item-tag">内置中转</span>
                <span v-if="k.isActive" class="ek-panel__item-badge">
                  <CheckCircleFilled />当前默认
                </span>
              </div>
              <div class="ek-panel__item-row ek-panel__item-key-row">
                <span class="ek-panel__item-key mono">{{ k.apiKey.trim() ? k.apiKey : (k.source !== 'builtin' ? '需重新录入' : '') }}</span>
              </div>
              <div v-if="k.baseUrl" class="ek-panel__item-row ek-panel__item-url-row">
                <span class="ek-panel__item-url-label">URL</span>
                <span class="ek-panel__item-url">{{ displayBaseUrl(k) }}</span>
              </div>
            </div>
            <div class="ek-panel__item-actions">
              <a-button
                v-if="isBuiltInRelayKeyOutdated(k)"
                type="primary"
                size="small"
                :loading="currentRelaySyncing"
                :disabled="actionsDisabled && !currentRelaySyncing"
                @click="doActivate(k.id)"
              >
                <template #icon><SyncOutlined /></template>
                启用
              </a-button>
              <a-popconfirm
                v-else-if="k.isActive"
                title="取消后该供应商将没有已启用的 Key，是否继续？"
                ok-text="取消启用"
                cancel-text="保留"
                @confirm="doDeactivate(k.id)"
              >
                <a-button size="small" type="primary" ghost :loading="deactivatingId === k.id" :disabled="actionsDisabled">
                  <template #icon><CheckCircleFilled /></template>
                  已启用
                </a-button>
              </a-popconfirm>
              <a-button
                v-else
                size="small"
                :loading="switchingId === k.id"
                :disabled="actionsDisabled || (k.source !== 'builtin' && !k.apiKey.trim())"
                @click="doActivate(k.id)"
              >
                启用
              </a-button>
              <a-button
                v-if="!isKeyBuiltInRelay(k)"
                size="small"
                :disabled="actionsDisabled"
                @click="startEdit(k)"
              >
                <template #icon><EditOutlined /></template>
                {{ k.apiKey.trim() ? '编辑' : '重新录入' }}
              </a-button>
              <a-popconfirm
                v-if="!isKeyBuiltInRelay(k)"
                :title="k.isActive ? '确认删除该供应商已启用的 Key？删除后会自动启用同供应商的其它 Key。' : '确认删除此 Key？'"
                ok-text="删除"
                cancel-text="取消"
                @confirm="doDelete(k.id)"
              >
                <a-button size="small" danger :loading="deletingId === k.id" :disabled="actionsDisabled">
                  <template #icon><DeleteOutlined /></template>
                  删除
                </a-button>
              </a-popconfirm>
            </div>
          </div>
        </div>
      </section>
      </div>

      <EngineCustomModelsPanel
        class="ek-panel__custom-models"
        v-show="props.surface !== 'h5' || mobileSection === 'models'"
        :active="props.active && (props.surface !== 'h5' || mobileSection === 'models')"
        :surface="props.surface"
        :engine-scope="selectedProvider?.engine ?? props.engineScope"
        :provider-scope="selectedProviderId ?? props.providerScope"
        hide-disabled-reason-alert
        external-initial-loading-indicator
        @initial-loading-change="customModelsInitialLoading = $event"
      />
      </div>
    </a-spin>


    <!-- 添加 / 编辑 弹框 -->
    <a-modal
      v-model:open="modalVisible"
      :title="editingId ? '编辑 Key' : '添加 Key'"
      :mask-closable="!operating"
      :keyboard="!operating"
      :closable="!operating"
      :wrap-class-name="props.surface === 'h5' ? 'h5-engine-key-modal' : undefined"
      :width="props.surface === 'h5' ? '100%' : 480"
      @cancel="closeModal"
    >
      <a-form layout="vertical" :colon="false" class="ek-panel__form" autocomplete="off">
        <a-form-item label="引擎">
          <a-select v-model:value="formEngine" :disabled="!!editingId || !!props.engineScope" style="width: 160px">
            <a-select-option value="claude">Claude</a-select-option>
            <a-select-option value="codex">Codex</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="供应商">
          <a-select v-model:value="formProviderId" :options="providerOptions" :disabled="!!props.providerScope" style="width: 220px" />
        </a-form-item>
        <a-form-item label="标签">
          <a-input
            v-model:value="formLabel"
            name="codeflow-engine-key-label"
            autocomplete="off"
            :readonly="labelInputReadonly"
            placeholder="例如：生产 Key、测试 Key"
            @focus="enableLabelInput"
          />
        </a-form-item>
        <a-form-item label="API Key" :extra="editingId && keys.some(key => key.id === editingId && key.source === 'unknown') ? '历史 Key 来源未核验，请重新录入自配 API Key。' : undefined">
          <a-input-password
            v-model:value="formApiKey"
            name="codeflow-engine-api-key"
            autocomplete="new-password"
            :readonly="apiKeyInputReadonly"
            :placeholder="getApiKeyPlaceholder()"
            @focus="enableApiKeyInput"
          />
        </a-form-item>
        <a-form-item
          :label="getBaseUrlLabel()"
          style="margin-bottom: 0"
        >
          <a-input
            v-model:value="formBaseUrl"
            name="codeflow-engine-base-url"
            autocomplete="off"
            :placeholder="getBaseUrlPlaceholder()"
          />
        </a-form-item>
      </a-form>
      <a-alert
        v-if="testResult"
        class="ek-panel__test-result"
        :type="testResult.ok ? 'success' : 'error'"
        show-icon
        :message="testResult.ok ? '连接成功' : '连接失败'"
        :description="testResult.message"
      />
      <template #footer>
        <div class="ek-panel__modal-footer">
          <a-button :loading="testingKey" :disabled="submitting || !canUseEngineKeyRoute" @click="doTestKey">
            测试连接
          </a-button>
          <div class="ek-panel__modal-footer-actions">
            <a-button :disabled="operating" @click="closeModal">取消</a-button>
            <a-button
              type="primary"
              :loading="submitting"
              :disabled="(operating && !submitting) || !canUseEngineKeyRoute"
              @click="doSubmit"
            >
              {{ editingId ? '更新' : '添加' }}
            </a-button>
          </div>
        </div>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.ek-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ek-panel__notice {
  align-self: flex-start;
  width: fit-content;
  max-width: min(100%, 560px);
  height: fit-content;
  padding: 8px 12px;
}

.ek-panel__notice :deep(.ant-alert-message) {
  line-height: 1.5;
}

.ek-panel__test-result {
  margin-top: 12px;
}

.ek-panel__modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ek-panel__modal-footer-actions {
  display: flex;
  gap: 8px;
}

.ek-panel__initial-loading {
  width: 100%;
  min-height: 240px;
}

.ek-panel__initial-loading :deep(.ant-spin-container) {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 240px;
}

.ek-panel__initial-loading :deep(.ant-spin-container.ant-spin-blur) {
  visibility: hidden;
}

.ek-panel--fill { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; height: 100%; overflow: hidden; }
.ek-panel--fill .ek-panel__initial-loading,
.ek-panel--fill .ek-panel__initial-loading :deep(.ant-spin-container) { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; overflow: hidden; }
.ek-panel__body { display: flex; flex-direction: column; gap: 20px; min-width: 0; min-height: 0; }
.ek-panel--fill .ek-panel__body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(280px, 340px); grid-template-rows: minmax(0, 1fr); flex: 1 1 0; overflow: hidden; }
.ek-panel--fill .ek-panel__layout { min-height: 0; overflow: hidden; padding: 24px; border: 1px solid var(--app-border); border-radius: 16px; background: var(--app-panel-bg); align-items: stretch; }
.ek-panel--fill .ek-panel__detail { min-height: 0; overflow: hidden; }
.ek-panel--fill .ek-panel__item-list { flex: 1 1 0; min-height: 0; overflow-y: auto; padding: 2px; }
.ek-panel--fill .ek-panel__sidebar { min-height: 0; overflow-y: auto; }

@media (min-width: 768px) and (max-width: 1099px) {
  .ek-panel--fill .ek-panel__body { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; }
  .ek-panel--fill .ek-panel__layout { padding: 20px; }
}

/* master-detail 主体 */
.ek-panel__layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 16px;
  width: 100%;
  align-items: stretch;
}

.ek-panel__layout.is-single {
  grid-template-columns: 1fr;
}

/* 左侧 provider 列表 */
.ek-panel__sidebar {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.ek-panel__sidebar-item {
  text-align: left;
  background: transparent;
  border: 1px solid var(--app-border);
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color 0.18s ease, background-color 0.18s ease;
  color: inherit;
  font: inherit;
}

.ek-panel__sidebar-item:hover {
  border-color: color-mix(in srgb, var(--app-accent) 45%, var(--app-border));
}

.ek-panel__sidebar-item.is-selected {
  border-color: var(--app-accent);
  background: color-mix(in srgb, var(--app-accent) 6%, transparent);
}

.ek-panel__sidebar-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ek-panel__sidebar-item-dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--app-border);
}

.ek-panel__sidebar-item-dot.is-active {
  background: #52c41a;
  box-shadow: 0 0 0 3px rgba(82, 196, 26, 0.18);
}

.ek-panel__sidebar-item-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text);
}

.ek-panel__sidebar-item-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--app-muted);
}

.ek-panel__sidebar-item-count {
  color: var(--app-muted);
}

/* 右侧详情 */
.ek-panel__detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.ek-panel__detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--app-divider);
}

.ek-panel__detail-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ek-panel__detail-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--app-text);
}
.ek-panel__key-count { margin-left: 6px; font-size: 12px; font-weight: 400; color: var(--app-muted); }

.ek-panel__detail-subtitle {
  font-size: 12px;
  color: var(--app-muted);
}

.ek-panel__detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.ek-panel__empty {
  font-size: 12px;
  color: var(--app-muted);
  padding: 28px 20px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
}
.ek-panel__empty-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 6px; border-radius: 18px; background: color-mix(in srgb, var(--app-accent) 9%, transparent); color: var(--app-accent); font-size: 25px; }
.ek-panel__empty h3 { margin: 0; font-size: 17px; font-weight: 600; color: var(--app-text); }
.ek-panel__empty > .ant-btn { margin-top: 8px; }

.ek-panel__empty p {
  margin: 0;
}

.ek-panel__empty-hint {
  margin-top: 6px !important;
  opacity: 0.85;
}

.ek-panel__item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

/* Key 行卡片 */
.ek-panel__item {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  background: var(--app-panel-bg);
  border: 1px solid var(--app-border);
  border-radius: 10px;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.ek-panel__item:hover {
  border-color: color-mix(in srgb, var(--app-accent) 35%, var(--app-border));
}

.ek-panel__item--active {
  border-color: color-mix(in srgb, var(--app-accent) 55%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 2%, var(--app-panel-bg));
}

.ek-panel__item--active::before {
  content: "";
  position: absolute;
  left: -1px;
  top: -1px;
  bottom: -1px;
  width: 3px;
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
  background: var(--app-accent);
}

.ek-panel__item-hint {
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.5;
}

.ek-panel__item-main {
  /* 右侧动作行空间不足时整体换行，避免把标题行的「当前默认」压成竖排。 */
  flex: 1 1 220px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ek-panel__item-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ek-panel__item-title-row {
  flex-wrap: wrap;
}

.ek-panel__item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13px;
}

.ek-panel__item-tag {
  display: inline-flex;
  flex-shrink: 0;
  white-space: nowrap;
  align-items: center;
  font-size: 11px;
  color: #722ed1;
  font-weight: 600;
  border: 1px solid #722ed1;
  border-radius: 4px;
  padding: 0 6px;
  line-height: 1.7;
}

.ek-panel__item-badge {
  display: inline-flex;
  flex-shrink: 0;
  white-space: nowrap;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--app-accent);
  font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--app-accent) 40%, var(--app-border));
  border-radius: 4px;
  padding: 0 6px;
  line-height: 1.7;
}

.ek-panel__item-key-row {
  align-items: baseline;
}

.ek-panel__item-key {
  min-width: 0;
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1.45;
  overflow-wrap: anywhere;
  word-break: break-all;
}

.ek-panel__item-url-row {
  align-items: baseline;
  gap: 6px;
}

.ek-panel__item-url-label {
  font-size: 11px;
  color: var(--app-muted);
  flex-shrink: 0;
}

.ek-panel__item-url {
  font-size: 12px;
  color: var(--app-muted);
  opacity: 0.85;
  overflow-wrap: anywhere;
  min-width: 0;
}

.ek-panel__item-actions {
  display: flex;
  margin-left: auto;
  gap: 6px;
  flex-shrink: 0;
  align-items: center;
}

/* Modal 内表单的紧凑微调 */
.ek-panel__form :deep(.ant-form-item) {
  margin-bottom: 14px;
}

/* 深色模式 */
:root[data-theme="dark"] .ek-panel__item-badge {
  color: #93c5fd;
  border-color: rgba(147, 197, 253, 0.4);
}

:root[data-theme="dark"] .ek-panel__item-tag {
  color: #d3adf7;
  border-color: rgba(211, 173, 247, 0.5);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ek-panel__item-badge {
    color: #93c5fd;
    border-color: rgba(147, 197, 253, 0.4);
  }
  :root:not([data-theme]) .ek-panel__item-tag {
    color: #d3adf7;
    border-color: rgba(211, 173, 247, 0.5);
  }
}

/* 移动端：sidebar 折成顶部横向滚动 chip 列表 */
@media (max-width: 720px) {
  .ek-panel__notice {
    width: 100%;
    max-width: 100%;
  }

  .ek-panel__layout {
    grid-template-columns: 1fr;
  }

  .ek-panel__sidebar {
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .ek-panel__sidebar-item {
    flex-shrink: 0;
    min-width: 160px;
  }

  .ek-panel__item {
    flex-direction: column;
    align-items: stretch;
  }

  .ek-panel__item-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .ek-panel__detail-header {
    flex-direction: column;
    align-items: stretch;
  }

  .ek-panel__detail-actions {
    justify-content: flex-start;
  }
}

/* H5 将 provider、Key 和自定义模型收敛为纵向卡片，保留原有 Store/API 动作。 */
.ek-panel--h5 {
  height: 100%;
  min-height: 0;
  gap: 10px;
  overflow-y: auto;
  padding: 2px 0 calc(18px + var(--safe-bottom, 0px));
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ek-panel--h5::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

.ek-panel--h5 > * { flex-shrink: 0; }
.ek-panel--h5 .ek-panel__initial-loading { display: flex; flex-direction: column; flex: 1 1 0; min-height: 0; overflow: hidden; }
.ek-panel__mobile-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 4px; gap: 4px; border-radius: 14px; background: var(--app-bg-secondary); }
.ek-panel__mobile-tabs button { min-height: 42px; border: 0; border-radius: 10px; color: var(--app-muted); background: transparent; font-weight: 600; }
.ek-panel__mobile-tabs button[aria-selected="true"] { color: var(--app-accent); background: var(--app-panel-bg); box-shadow: var(--app-shadow-sm); }

.ek-panel--h5 .ek-panel__notice {
  width: 100%;
  max-width: none;
  margin: 0;
  border-radius: 14px;
}

.ek-panel--h5 .ek-panel__initial-loading :deep(.ant-spin-container) {
  gap: 12px;
  flex: 1 1 0;
  min-height: 0;
  overflow: hidden;
}

/* 基础样式是 grid + align-items: stretch；改成 flex column 后该属性会转到水平轴，
   必须显式 stretch，否则 detail 会收缩到内容宽度（连带密钥卡片不铺满）。 */
.ek-panel--h5 .ek-panel__layout {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
}
.ek-panel--h5 .ek-panel__body { flex: 1 1 0; overflow: hidden; gap: 12px; }
.ek-panel--h5 .ek-panel__layout.is-models { flex: 0 0 auto; }
.ek-panel--h5 .ek-panel__detail { flex: 1 1 0; min-height: 0; }
.ek-panel--h5 .ek-panel__empty { flex-shrink: 0; }

.ek-panel--h5 .ek-panel__sidebar {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  overflow-x: auto;
  padding: 2px 1px 5px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.ek-panel--h5 .ek-panel__sidebar::-webkit-scrollbar {
  display: none;
}

.ek-panel--h5 .ek-panel__sidebar-item {
  min-width: 0;
  flex: 0 0 auto;
  padding: 10px 11px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-surface) 94%, transparent);
}

.ek-panel--h5 .ek-panel__sidebar-item.is-selected {
  border-color: color-mix(in srgb, var(--app-accent) 62%, var(--app-divider));
  background: color-mix(in srgb, var(--app-accent) 9%, var(--app-surface));
}

.ek-panel--h5 .ek-panel__detail {
  gap: 10px;
}

.ek-panel--h5 .ek-panel__detail-header {
  align-items: stretch;
  flex-direction: column;
  padding: 2px 1px 10px;
  border-bottom-color: color-mix(in srgb, var(--app-divider) 78%, transparent);
}

.ek-panel--h5 .ek-panel__detail-title {
  font-size: 17px;
  font-weight: 720;
}

.ek-panel--h5 .ek-panel__detail-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.ek-panel--h5 .ek-panel__detail-actions :deep(.ant-btn) {
  min-height: 40px;
  border-radius: 12px;
  padding-inline: 11px;
}

.ek-panel--h5 .ek-panel__item-list {
  gap: 10px;
}

/* 同 layout：column 化后基础样式的 align-items: flex-start 会让子元素收缩，
   卡片内的主信息区与动作行都需要撑满。 */
.ek-panel--h5 .ek-panel__item {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 14px;
  border-radius: 17px;
  border-color: color-mix(in srgb, var(--app-divider) 82%, transparent);
  background: color-mix(in srgb, var(--app-surface) 96%, transparent);
  box-shadow: 0 10px 24px color-mix(in srgb, #000 5%, transparent);
}

.ek-panel--h5 .ek-panel__item-actions {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(76px, 1fr));
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--app-divider) 70%, transparent);
}

.ek-panel--h5 .ek-panel__item-actions :deep(.ant-btn) {
  min-height: 40px;
  border-radius: 11px;
}

.ek-panel--h5 .ek-panel__empty {
  padding: 28px 14px;
  border-radius: 17px;
  background: color-mix(in srgb, var(--app-surface) 88%, transparent);
}

.ek-panel--h5 :deep(.custom-models) {
  margin-top: 2px;
  padding-top: 12px;
  border-top-color: color-mix(in srgb, var(--app-divider) 78%, transparent);
}

.ek-panel--h5 :deep(.custom-models__header),
.ek-panel--h5 :deep(.custom-models__item) {
  border-radius: 16px;
}

.ek-panel--h5 :deep(.custom-models__header) {
  align-items: stretch;
  gap: 10px;
  flex-direction: column;
}

.ek-panel--h5 .ek-panel__sidebar-item-meta { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; font-size: 10px; }
.ek-panel--h5 .ek-panel__sidebar-item-meta span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ek-panel--h5 .ek-panel__sidebar-item-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }

.ek-panel--h5 :deep(.custom-models__header .ant-btn) { min-height: 44px; border-radius: 12px; }
.ek-panel--h5 .ek-panel__item-key { white-space: normal; overflow-wrap: anywhere; }
:global(.h5-engine-key-modal .ant-select) { width: 100% !important; }
:global(.h5-engine-key-modal .ant-input), :global(.h5-engine-key-modal .ant-input-number-input) { min-height: 40px; font-size: 16px; }
:global(.h5-engine-key-modal .ant-select-selector) { min-height: 40px; align-items: center; }

.ek-panel--h5 :deep(.custom-models__subtitle) {
  max-width: 220px;
  line-height: 1.45;
}

.ek-panel--h5 :deep(.custom-models__item) {
  flex-direction: column;
  gap: 10px;
  padding: 13px;
  background: color-mix(in srgb, var(--app-surface) 96%, transparent);
}

.ek-panel--h5 :deep(.custom-models__actions) {
  width: 100%;
  justify-content: stretch;
}

.ek-panel--h5 :deep(.custom-models__actions .ant-btn) {
  flex: 1 1 0;
  min-height: 40px;
  border-radius: 11px;
}

:global(.h5-engine-key-modal) {
  display: flex;
  align-items: flex-end;
}

:global(.h5-engine-key-modal .ant-modal) {
  top: 0;
  width: 100% !important;
  max-width: 100%;
  margin: 0;
  padding: 0;
}

:global(.h5-engine-key-modal .ant-modal-content) {
  max-height: min(86dvh, 720px);
  overflow: hidden;
  border-radius: 24px 24px 0 0;
  padding: 0;
}

:global(.h5-engine-key-modal .ant-modal-header) {
  margin: 0;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--app-divider);
}

:global(.h5-engine-key-modal .ant-modal-body) {
  max-height: min(66dvh, 520px);
  overflow-y: auto;
  padding: 14px 16px 4px;
}

:global(.h5-engine-key-modal .ant-modal-footer) {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
  gap: 8px;
  margin: 0;
  padding: 10px 14px max(12px, min(env(safe-area-inset-bottom, 0px), 8px));
}

:global(.h5-engine-key-modal .ant-modal-footer .ant-btn) {
  min-height: 48px;
  margin: 0;
  border-radius: 14px;
}

/* 自定义页脚包含测试/取消/添加三个操作，H5 下改为整行单列避免挤在左列。 */
:global(.h5-engine-key-modal .ant-modal-footer) {
  grid-template-columns: minmax(0, 1fr);
}
</style>

