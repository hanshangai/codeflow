import crypto from "node:crypto";
import {
  cloneEngineModelCatalogSnapshot,
  engineModelCatalogRowsToModelInfo,
  getDefaultReasoningEffortForModel,
  getEngineModelInfo,
  getEngineModels,
  mergeEngineModelsWithCustomModels,
  toEngineModelInfoFromCustomModel,
  resolveCatalogDefaultThreadPrefs,
  resolveRoleExecutionConfigForEngine,
  resolveRoleExecutionConfigForStrategy,
  resolveThreadPrefsWithCatalogDefaults,
  serializeEngineModelCatalogDigestPayload,
  type EngineModelCatalogAppliedAck,
  type EngineModelCatalogDispatchPauseAck,
  type EngineCustomModelEntry,
  type EngineModelCatalogItem,
  type EngineModelCatalogSnapshot,
  type EngineModelInfo,
  type EngineModelProviderId,
  type EngineType,
  type OrchestrationExecutionEngineStrategy,
  type ResolvedRoleExecutionConfig,
  type ResolvedThreadPrefs,
  type RoleExecutionConfig,
  type ThreadPrefs,
} from "@codeflowai/shared";

type ActiveEngineModelCatalog = {
  snapshot: EngineModelCatalogSnapshot;
  digest: string;
  models: Record<EngineType, EngineModelInfo[]>;
};

let activeCatalog: ActiveEngineModelCatalog | null = null;
let localCatalogEnabled = false;
let customModelsByEngine: Record<EngineType, EngineModelInfo[]> = { claude: [], codex: [] };
let dispatchPause: {
  operationId: string;
  configVersion: number;
  digest: string;
  resumed: Promise<void>;
  resume: () => void;
  drained: Promise<void>;
  markDrained: () => void;
} | null = null;
let activeDispatchLeases = 0;

/** 桌面在配置与数据库初始化前启用本地目录；不伪造 Server 快照或确认。 */
export function initializeLocalEngineModelCatalog(): void {
  localCatalogEnabled = true;
}

/** 桌面撤销云端 owner 时只清 Server 补充，保留本机目录与自配模型。 */
export function clearDesktopCloudEngineModelCatalog(): void {
  if (!localCatalogEnabled) throw catalogRuntimeError("ENGINE_MODEL_CATALOG_SCOPE_INVALID", "仅桌面本地目录可撤销云端补充");
  activeCatalog = null;
  resumeEngineModelCatalogDispatch();
}

/** 单调、原子应用 Server 模型目录；旧版本或同版本异内容会显式失败。 */
export function applyEngineModelCatalogSnapshot(
  value: unknown,
  appliedAt = Date.now(),
  operationId?: string,
): EngineModelCatalogAppliedAck {
  const snapshot = cloneEngineModelCatalogSnapshot(value);
  const digest = crypto
    .createHash("sha256")
    .update(serializeEngineModelCatalogDigestPayload(snapshot), "utf8")
    .digest("hex");
  if (activeCatalog) {
    if (snapshot.configVersion < activeCatalog.snapshot.configVersion) {
      throw catalogRuntimeError(
        "ENGINE_MODEL_CATALOG_STALE",
        `收到旧模型目录版本：current=${activeCatalog.snapshot.configVersion}, received=${snapshot.configVersion}`,
      );
    }
    if (snapshot.configVersion === activeCatalog.snapshot.configVersion) {
      if (digest !== activeCatalog.digest) {
        throw catalogRuntimeError(
          "ENGINE_MODEL_CATALOG_VERSION_COLLISION",
          `同一模型目录版本内容不一致：version=${snapshot.configVersion}`,
        );
      }
      const confirmationOperationId = ensureCatalogApplyConfirmationPause(operationId, snapshot.configVersion, digest);
      return {
        configVersion: snapshot.configVersion,
        digest,
        appliedAt,
        ...(confirmationOperationId ? { operationId: confirmationOperationId } : {}),
      };
    }
  }

  const confirmationOperationId = ensureCatalogApplyConfirmationPause(operationId, snapshot.configVersion, digest);
  const models = buildCatalogModels(snapshot);
  activeCatalog = { snapshot, digest, models };
  return {
    configVersion: snapshot.configVersion,
    digest,
    appliedAt,
    ...(confirmationOperationId ? { operationId: confirmationOperationId } : {}),
  };
}

/** 更新本地自定义模型；桌面离线首装同样可读，远程模式重建 Server 覆盖层。 */
export function setEngineModelCatalogCustomModels(entries: EngineCustomModelEntry[]): void {
  customModelsByEngine = {
    claude: entries.filter((entry) => entry.enabled && entry.engine === "claude").map(toEngineModelInfoFromCustomModel),
    codex: entries.filter((entry) => entry.enabled && entry.engine === "codex").map(toEngineModelInfoFromCustomModel),
  };
  if (!activeCatalog) return;
  activeCatalog = { ...activeCatalog, models: buildCatalogModels(activeCatalog.snapshot) };
}

/** 发布前收口目录读租约；桌面只暂停云端补充，不阻断本地模型派发。 */
export async function pauseEngineModelCatalogDispatch(input: {
  operationId: string;
  configVersion: number;
  digest: string;
}, pausedAt = Date.now()): Promise<EngineModelCatalogDispatchPauseAck> {
  const catalog = requireActiveEngineModelCatalog();
  const operationId = String(input.operationId ?? "").trim();
  if (!operationId) throw catalogRuntimeError("ENGINE_MODEL_CATALOG_PAUSE_INVALID", "模型目录派发暂停操作缺少 operationId");
  if (!Number.isSafeInteger(input.configVersion) || input.configVersion < catalog.snapshot.configVersion) {
    throw catalogRuntimeError(
      "ENGINE_MODEL_CATALOG_PAUSE_MISMATCH",
      `模型目录派发暂停版本落后：current=${catalog.snapshot.configVersion}, received=${input.configVersion}`,
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(String(input.digest ?? ""))) {
    throw catalogRuntimeError("ENGINE_MODEL_CATALOG_PAUSE_MISMATCH", "模型目录派发暂停摘要无效");
  }
  if (input.configVersion === catalog.snapshot.configVersion && input.digest !== catalog.digest) {
    throw catalogRuntimeError("ENGINE_MODEL_CATALOG_PAUSE_MISMATCH", "模型目录派发暂停摘要与当前目录不一致");
  }
  if (dispatchPause && dispatchPause.operationId !== operationId) {
    throw catalogRuntimeError(
      "ENGINE_MODEL_CATALOG_PAUSE_CONFLICT",
      `模型目录派发已被另一发布操作暂停：operationId=${dispatchPause.operationId}`,
    );
  }
  if (!dispatchPause) {
    let resume!: () => void;
    let markDrained!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const drained = new Promise<void>((resolve) => {
      markDrained = resolve;
    });
    dispatchPause = {
      operationId,
      configVersion: input.configVersion,
      digest: input.digest,
      resumed,
      resume,
      drained,
      markDrained,
    };
    if (activeDispatchLeases === 0) markDrained();
  }
  await dispatchPause.drained;
  return { operationId, configVersion: input.configVersion, digest: input.digest, pausedAt };
}

/** 目录发布取消时，仅释放匹配操作建立的暂停态。 */
export function cancelEngineModelCatalogDispatchPause(operationId: string): void {
  if (dispatchPause?.operationId !== String(operationId ?? "").trim()) return;
  resumeEngineModelCatalogDispatch();
}

/** 连接中断冻结 Server 目录；桌面的本地目录不随连接关闭。 */
export function pauseEngineModelCatalogDispatchForReconnect(operationId: string): string | null {
  if (!activeCatalog) return null;
  if (dispatchPause) return dispatchPause.operationId;
  const normalizedOperationId = String(operationId ?? "").trim();
  if (!normalizedOperationId) {
    throw catalogRuntimeError("ENGINE_MODEL_CATALOG_PAUSE_INVALID", "模型目录重连暂停操作缺少 operationId");
  }
  return ensureCatalogApplyConfirmationPause(
    normalizedOperationId,
    activeCatalog.snapshot.configVersion,
    activeCatalog.digest,
  );
}

/** 远程派发等待发布确认，桌面继续使用本地目录。 */
export async function waitForEngineModelCatalogDispatchReady(): Promise<void> {
  while (!localCatalogEnabled && dispatchPause) await dispatchPause.resumed;
  getRuntimeModels();
}

/** 短租约绑定实际模型表；桌面租约不被 Server 的发布或重连等待阻塞。 */
export async function acquireEngineModelCatalogDispatchLease(selection?: { engine: EngineType; model?: string | null }): Promise<{
  configVersion: number;
  digest: string;
  release: () => void;
}> {
  while (!localCatalogEnabled && dispatchPause) await dispatchPause.resumed;
  const identity = localCatalogEnabled
    ? { configVersion: 0, digest: getLocalDispatchDigest(selection) }
    : requireActiveEngineModelCatalog();
  activeDispatchLeases += 1;
  let released = false;
  return {
    configVersion: "snapshot" in identity ? identity.snapshot.configVersion : identity.configVersion,
    digest: identity.digest,
    release: () => {
      if (released) return;
      released = true;
      activeDispatchLeases -= 1;
      if (activeDispatchLeases === 0) dispatchPause?.markDrained();
    },
  };
}

/** 防止同一 provider 启动链的 setup 与 mutation 跨越两版目录。 */
export function assertEngineModelCatalogDispatchLeaseCurrent(
  expected: { configVersion: number; digest: string },
  current: { configVersion: number; digest: string },
): void {
  if (expected.configVersion === current.configVersion && expected.digest === current.digest) return;
  throw catalogRuntimeError(
    "ENGINE_MODEL_CATALOG_CHANGED_DURING_DISPATCH",
    `模型目录在 provider 启动期间已更新：setup=${expected.configVersion}, current=${current.configVersion}`,
  );
}

/** Server 已登记 applied ACK 后释放本地写锁，允许自主调度继续。 */
export function confirmEngineModelCatalogApplied(input: {
  operationId?: string | null;
  configVersion: number;
  digest: string;
}): void {
  const catalog = requireActiveEngineModelCatalog();
  if (input.configVersion !== catalog.snapshot.configVersion || input.digest !== catalog.digest) {
    throw catalogRuntimeError(
      "ENGINE_MODEL_CATALOG_CONFIRMATION_MISMATCH",
      `Server 模型目录确认与当前目录不一致：current=${catalog.snapshot.configVersion}, confirmed=${input.configVersion}`,
    );
  }
  if (!dispatchPause) return;
  const operationId = String(input.operationId ?? "").trim();
  if (!operationId || operationId !== dispatchPause.operationId) {
    throw catalogRuntimeError(
      "ENGINE_MODEL_CATALOG_CONFIRMATION_OPERATION_MISMATCH",
      `Server 模型目录确认操作不一致：expected=${dispatchPause.operationId}, confirmed=${operationId || "missing"}`,
    );
  }
  resumeEngineModelCatalogDispatch();
}

/** 仅云端补充使用 Server 档案；本地模型沿现有引擎原生映射运行。 */
export function getRuntimeEngineModelCatalogItem(
  engine: EngineType,
  modelId: string | null | undefined,
): EngineModelCatalogItem | null {
  const normalized = String(modelId ?? "").trim();
  if (!normalized || !activeCatalog) return null;
  if (localCatalogEnabled && (dispatchPause || isLocalEngineModel(engine, normalized))) return null;
  const rows = localCatalogEnabled
    ? activeCatalog.snapshot.rows.filter((row) => row.engine === engine && !isLocalEngineModel(engine, row.modelId))
    : activeCatalog.snapshot.rows;
  const direct = rows.find((row) => row.engine === engine && row.modelId === normalized);
  if (direct) return direct;
  const transport = rows.find((row) =>
    row.engine === engine
    && (row.transportModelId === normalized || row.fastTaskModelId === normalized || row.subagentModelId === normalized),
  );
  if (transport) return transport;
  if (normalized.endsWith("[1m]")) {
    const base = rows.find(
      (row) => row.engine === engine && row.modelId === normalized.slice(0, -4),
    );
    if (
      base
      && (base.supports1MContext || base.contextWindow === 1_000_000 || base.maxContextWindow === 1_000_000)
    ) return base;
  }
  return null;
}

/** 从同一有效模型表解析 provider；本地模型不被 Server 同 ID 档案替换。 */
export function resolveRuntimeEngineModelProviderId(
  engine: EngineType,
  modelId: string | null | undefined,
): EngineModelProviderId {
  const models = getRuntimeModels()[engine];
  const normalized = String(modelId ?? "").trim();
  const row = normalized
    ? getRuntimeEngineModelCatalogItem(engine, normalized)
    : null;
  if (row) return row.providerId;
  const modelInfo = normalized ? getRuntimeEngineModelInfo(engine, normalized) : models.find((model) => model.isDefault) ?? null;
  if (modelInfo?.providerId) return modelInfo.providerId;
  throw catalogRuntimeError(
    normalized ? "ENGINE_MODEL_NOT_AVAILABLE" : "ENGINE_MODEL_CATALOG_INVALID",
    normalized
      ? `模型「${normalized}」已从当前目录移除，请重新选择模型`
      : `当前 ${engine} 模型目录缺少默认模型`,
  );
}

/** 发送、偏好保存和编排共用有效目录，未确认云端补充保持不可执行。 */
export function assertRuntimeEngineModelAvailable(engine: EngineType, modelId: string | null | undefined): void {
  const models = getRuntimeModels()[engine];
  const normalized = String(modelId ?? "").trim();
  if (!normalized) return;
  if (getEngineModelInfo(engine, normalized, models)) return;
  // 本地自定义模型不在 Server 全局行中，1M 别名统一复用运行时模型解析。
  if (normalized.endsWith("[1m]") && getRuntimeEngineModelInfo(engine, normalized)) return;
  throw catalogRuntimeError("ENGINE_MODEL_NOT_AVAILABLE", `模型「${normalized}」已从当前目录移除，请重新选择模型`);
}

/** 返回同一本地优先或 Server 权威模型表，模式在启动时显式确定。 */
export function getRuntimeEngineModels(engine: EngineType): EngineModelInfo[] {
  return getRuntimeModels()[engine].map(cloneEngineModelInfo);
}

/** 桌面启动期已有内置目录；远程 Client 仍等待 Server 首次同步。 */
export function getRuntimeEngineModelsIfReady(engine: EngineType): EngineModelInfo[] | null {
  return localCatalogEnabled || activeCatalog ? getRuntimeEngineModels(engine) : null;
}

/** 从当前动态目录解析模型元数据；目录未就绪时显式失败。 */
export function getRuntimeEngineModelInfo(
  engine: EngineType,
  modelId: string | null | undefined,
): EngineModelInfo | null {
  const normalized = String(modelId ?? "").trim();
  const models = getRuntimeEngineModels(engine);
  const direct = getEngineModelInfo(engine, normalized, models);
  if (direct || !normalized.endsWith("[1m]")) return direct;
  const runtimeItem = getRuntimeEngineModelCatalogItem(engine, normalized);
  if (runtimeItem) {
    const baseModel = models.find((model) => model.id === runtimeItem.modelId);
    if (baseModel) return {
      ...baseModel,
      id: normalized,
      contextWindow: baseModel.maxContextWindow ?? baseModel.contextWindow,
    };
  }
  const base = models.find((model) => model.id === normalized.slice(0, -4));
  if (!base?.supports1MContext) return null;
  return {
    ...base,
    id: normalized,
    contextWindow: base.maxContextWindow ?? 1_000_000,
    maxContextWindow: base.maxContextWindow ?? 1_000_000,
  };
}

/** 会话默认项、effort、窗口和 Fast 档位统一从当前动态目录派生。 */
export function resolveRuntimeThreadPrefsWithCatalogDefaults(
  engine: EngineType,
  prefs?: ThreadPrefs | null,
): ResolvedThreadPrefs {
  const models = getRuntimeEngineModels(engine);
  return resolveThreadPrefsWithCatalogDefaults(engine, prefs, models);
}

/** 编排 auto 档案按当前动态目录解析，避免沿用模块加载时的静态默认项。 */
export function resolveRuntimeRoleExecutionConfigForEngine(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  engine: EngineType,
  fallbackPreferredEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  return applyRuntimeAutoDefaults(
    resolveRoleExecutionConfigForEngine(raw, engine, fallbackPreferredEngine),
  );
}

/** 按编排策略选择引擎后，再从当前动态目录解析 auto 默认项。 */
export function resolveRuntimeRoleExecutionConfigForStrategy(
  raw: Partial<RoleExecutionConfig> | RoleExecutionConfig | null | undefined,
  strategy: OrchestrationExecutionEngineStrategy | null | undefined,
  fallbackEngine: EngineType = "codex",
): ResolvedRoleExecutionConfig {
  return applyRuntimeAutoDefaults(
    resolveRoleExecutionConfigForStrategy(raw, strategy, fallbackEngine),
  );
}

function applyRuntimeAutoDefaults(config: ResolvedRoleExecutionConfig): ResolvedRoleExecutionConfig {
  if (config.sourceMode !== "auto") {
    assertRuntimeEngineModelAvailable(config.engine, config.model);
    return config;
  }
  const models = getRuntimeEngineModels(config.engine);
  const defaults = resolveCatalogDefaultThreadPrefs(config.engine, models);
  if (!defaults.model) {
    throw catalogRuntimeError("ENGINE_MODEL_CATALOG_INVALID", `当前 ${config.engine} 模型目录缺少默认模型`);
  }
  return {
    ...config,
    model: defaults.model,
    effort: getDefaultReasoningEffortForModel(config.engine, defaults.model, models) ?? "",
  };
}

export function getActiveEngineModelCatalogSnapshot(): EngineModelCatalogSnapshot | null {
  return activeCatalog ? cloneEngineModelCatalogSnapshot(activeCatalog.snapshot) : null;
}

export function getEngineModelCatalogDispatchPauseOperationId(): string | null {
  return dispatchPause?.operationId ?? null;
}

/** 仅供单元测试隔离全局 Client 运行时。 */
export function resetEngineModelCatalogRuntimeForTest(): void {
  resumeEngineModelCatalogDispatch();
  activeCatalog = null;
  localCatalogEnabled = false;
  customModelsByEngine = { claude: [], codex: [] };
}

/** 桌面优先内置与自配模型，Server 仅追加；远程保持原覆盖层合并顺序。 */
function buildCatalogModels(snapshot?: EngineModelCatalogSnapshot): Record<EngineType, EngineModelInfo[]> {
  if (localCatalogEnabled) return {
    claude: mergeEngineModelsWithCustomModels("claude", getLocalEngineModels("claude"), snapshot
      ? engineModelCatalogRowsToModelInfo(snapshot.rows, "claude").filter((model) => !isLocalEngineModel("claude", model.id)) : []),
    codex: mergeEngineModelsWithCustomModels("codex", getLocalEngineModels("codex"), snapshot
      ? engineModelCatalogRowsToModelInfo(snapshot.rows, "codex").filter((model) => !isLocalEngineModel("codex", model.id)) : []),
  };
  return {
    claude: mergeEngineModelsWithCustomModels("claude", engineModelCatalogRowsToModelInfo(snapshot!.rows, "claude"), customModelsByEngine.claude),
    codex: mergeEngineModelsWithCustomModels("codex", engineModelCatalogRowsToModelInfo(snapshot!.rows, "codex"), customModelsByEngine.codex),
  };
}

/** 沿既有内置优先规则合并本机自定义模型，不另建运行档案。 */
function getLocalEngineModels(engine: EngineType): EngineModelInfo[] {
  return mergeEngineModelsWithCustomModels(engine, getEngineModels(engine), customModelsByEngine[engine]);
}

/** 本地可用的 1M 别名与原模型属于同一来源，不能被云端 transport 行覆盖。 */
function isLocalEngineModel(engine: EngineType, modelId: string): boolean {
  const models = getLocalEngineModels(engine);
  if (getEngineModelInfo(engine, modelId, models)) return true;
  return modelId.endsWith("[1m]") && getEngineModelInfo(engine, modelId.slice(0, -4), models)?.supports1MContext === true;
}

/** Server 未确认或重连期间仅撤下云端补充，个人本地目录持续可用。 */
function getRuntimeModels(): Record<EngineType, EngineModelInfo[]> {
  return localCatalogEnabled ? buildCatalogModels(dispatchPause ? undefined : activeCatalog?.snapshot) : requireActiveEngineModelCatalog().models;
}

/** 显式模型绑定自身档案；历史会话模型未知时校验完整有效目录和云端档案。 */
function getLocalDispatchDigest(selection?: { engine: EngineType; model?: string | null }): string {
  let value: unknown = {
    models: getRuntimeModels(),
    profiles: dispatchPause ? [] : activeCatalog?.snapshot.rows.filter((row) => !isLocalEngineModel(row.engine, row.modelId)) ?? [],
  };
  if (selection?.model) {
    const model = getRuntimeEngineModelInfo(selection.engine, selection.model);
    if (!model) throw catalogRuntimeError("ENGINE_MODEL_NOT_AVAILABLE", "所选模型当前不可用");
    value = { engine: selection.engine, model, profile: getRuntimeEngineModelCatalogItem(selection.engine, model.id) };
  }
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireActiveEngineModelCatalog(): ActiveEngineModelCatalog {
  if (activeCatalog) return activeCatalog;
  throw catalogRuntimeError("ENGINE_MODEL_CATALOG_NOT_READY", "动态模型目录尚未同步完成，请等待 Client 重新连接");
}

function ensureCatalogApplyConfirmationPause(
  requestedOperationId: string | undefined,
  configVersion: number,
  digest: string,
): string | null {
  const operationId = String(requestedOperationId ?? dispatchPause?.operationId ?? "").trim();
  if (!operationId) return null;
  if (dispatchPause) {
    if (dispatchPause.operationId !== operationId) {
      throw catalogRuntimeError(
        "ENGINE_MODEL_CATALOG_APPLY_OPERATION_MISMATCH",
        `模型目录应用操作不一致：expected=${dispatchPause.operationId}, received=${operationId}`,
      );
    }
    dispatchPause.configVersion = configVersion;
    dispatchPause.digest = digest;
    return operationId;
  }
  let resume!: () => void;
  let markDrained!: () => void;
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const drained = new Promise<void>((resolve) => {
    markDrained = resolve;
  });
  dispatchPause = { operationId, configVersion, digest, resumed, resume, drained, markDrained };
  if (activeDispatchLeases === 0) markDrained();
  return operationId;
}

function resumeEngineModelCatalogDispatch(): void {
  const paused = dispatchPause;
  dispatchPause = null;
  paused?.resume();
}

function cloneEngineModelInfo(model: EngineModelInfo): EngineModelInfo {
  return {
    ...model,
    inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
    supportedReasoningEfforts: model.supportedReasoningEfforts?.map((option) => ({ ...option })),
  };
}

function catalogRuntimeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
