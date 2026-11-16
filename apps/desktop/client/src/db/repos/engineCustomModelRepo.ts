import crypto from "node:crypto";

import {
  getEngineModelInfo,
  getSupportedReasoningEffortsForProvider,
  normalizeEngineKeyProviderId,
  type EngineCustomModelEntry,
  type EngineModelProviderId,
  type EngineType,
  type InputModality,
  type ReasoningEffort,
  type ReasoningEffortOption,
} from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type EngineCustomModelUpsertData = {
  engine: EngineType;
  providerId: EngineModelProviderId;
  modelId: string;
  displayName?: string | null;
  inputModalities?: InputModality[] | null;
  supportedReasoningEfforts?: Array<ReasoningEffort | ReasoningEffortOption> | null;
  defaultReasoningEffort?: ReasoningEffort | null;
  contextWindow?: number | null;
  maxContextWindow?: number | null;
  supportsFastMode?: boolean | null;
  supports1MContext?: boolean | null;
  enabled?: boolean | null;
};

type Row = {
  id: string;
  engine: string;
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window: number | null;
  max_context_window: number | null;
  input_modalities_json: string | null;
  reasoning_efforts_json: string | null;
  default_reasoning_effort: string | null;
  supports_fast_mode: number;
  supports_1m_context: number;
  enabled: number;
  created_at: number;
  updated_at: number;
};

/** Client 自定义模型仓储：只维护本机模型目录元数据，不存放凭据。 */
export class EngineCustomModelRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 列出所有自定义模型，按引擎和更新时间排序。 */
  list(): EngineCustomModelEntry[] {
    const rows = this.db.prepare(`
      SELECT id, engine, provider_id, model_id, display_name, context_window, max_context_window,
             input_modalities_json, reasoning_efforts_json, default_reasoning_effort,
             supports_fast_mode, supports_1m_context, enabled, created_at, updated_at
        FROM engine_custom_models
       ORDER BY engine ASC, updated_at DESC, created_at DESC, id DESC
    `).all() as Row[];
    return rows.map(toEntry);
  }

  /** 列出指定引擎已启用模型，用于引擎状态目录合并。 */
  listEnabledByEngine(engine: EngineType): EngineCustomModelEntry[] {
    const rows = this.db.prepare(`
      SELECT id, engine, provider_id, model_id, display_name, context_window, max_context_window,
             input_modalities_json, reasoning_efforts_json, default_reasoning_effort,
             supports_fast_mode, supports_1m_context, enabled, created_at, updated_at
        FROM engine_custom_models
       WHERE engine = ? AND enabled = 1
       ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all(engine) as Row[];
    return rows.map(toEntry);
  }

  /** 按 id 获取自定义模型。 */
  get(id: string): EngineCustomModelEntry | null {
    const row = this.db.prepare(`
      SELECT id, engine, provider_id, model_id, display_name, context_window, max_context_window,
             input_modalities_json, reasoning_efforts_json, default_reasoning_effort,
             supports_fast_mode, supports_1m_context, enabled, created_at, updated_at
        FROM engine_custom_models
       WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 按 engine/modelId 获取自定义模型，用于运行时解析 provider。 */
  getByEngineModel(engine: EngineType, modelId: string): EngineCustomModelEntry | null {
    const row = this.db.prepare(`
      SELECT id, engine, provider_id, model_id, display_name, context_window, max_context_window,
             input_modalities_json, reasoning_efforts_json, default_reasoning_effort,
             supports_fast_mode, supports_1m_context, enabled, created_at, updated_at
        FROM engine_custom_models
       WHERE engine = ? AND model_id = ?
       LIMIT 1
    `).get(engine, modelId) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 新增自定义模型；拒绝覆盖内置模型 ID 和重复自定义模型 ID。 */
  insert(input: EngineCustomModelUpsertData): EngineCustomModelEntry {
    const normalized = normalizeUpsertData(input);
    this.assertModelIdAvailable(normalized.engine, normalized.modelId, null);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO engine_custom_models (
        id, engine, provider_id, model_id, display_name, context_window, max_context_window,
        input_modalities_json, reasoning_efforts_json, default_reasoning_effort,
        supports_fast_mode, supports_1m_context, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalized.engine,
      normalized.providerId,
      normalized.modelId,
      normalized.displayName,
      normalized.contextWindow,
      normalized.maxContextWindow,
      JSON.stringify(normalized.inputModalities),
      JSON.stringify(normalized.supportedReasoningEfforts),
      normalized.defaultReasoningEffort,
      normalized.supportsFastMode ? 1 : 0,
      normalized.supports1MContext ? 1 : 0,
      normalized.enabled ? 1 : 0,
      now,
      now,
    );
    const created = this.get(id);
    if (!created) throw new Error("自定义模型写入后读取失败");
    return created;
  }

  /** 更新自定义模型；模型 ID 变更时仍按 engine/modelId 唯一约束校验。 */
  update(id: string, input: Partial<EngineCustomModelUpsertData>): EngineCustomModelEntry {
    const existing = this.get(id);
    if (!existing) throw new Error(`自定义模型不存在：${id}`);
    const normalized = normalizeUpsertData({ ...existing, ...input });
    this.assertModelIdAvailable(normalized.engine, normalized.modelId, id);
    const now = Date.now();
    this.db.prepare(`
      UPDATE engine_custom_models
         SET engine = ?,
             provider_id = ?,
             model_id = ?,
             display_name = ?,
             context_window = ?,
             max_context_window = ?,
             input_modalities_json = ?,
             reasoning_efforts_json = ?,
             default_reasoning_effort = ?,
             supports_fast_mode = ?,
             supports_1m_context = ?,
             enabled = ?,
             updated_at = ?
       WHERE id = ?
    `).run(
      normalized.engine,
      normalized.providerId,
      normalized.modelId,
      normalized.displayName,
      normalized.contextWindow,
      normalized.maxContextWindow,
      JSON.stringify(normalized.inputModalities),
      JSON.stringify(normalized.supportedReasoningEfforts),
      normalized.defaultReasoningEffort,
      normalized.supportsFastMode ? 1 : 0,
      normalized.supports1MContext ? 1 : 0,
      normalized.enabled ? 1 : 0,
      now,
      id,
    );
    const updated = this.get(id);
    if (!updated) throw new Error("自定义模型更新后读取失败");
    return updated;
  }

  /** 新增或更新自定义模型；id 为空时新增。 */
  upsert(input: EngineCustomModelUpsertData & { id?: string | null }): EngineCustomModelEntry {
    const id = String(input.id ?? "").trim();
    return id ? this.update(id, input) : this.insert(input);
  }

  /** 删除自定义模型；不存在时返回 false。 */
  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM engine_custom_models WHERE id = ?").run(id);
    return Number(result.changes ?? 0) > 0;
  }

  private assertModelIdAvailable(engine: EngineType, modelId: string, currentId: string | null): void {
    if (getEngineModelInfo(engine, modelId)) {
      throw new Error(`模型 ID 已由内置目录维护：${modelId}`);
    }
    const row = this.db.prepare(`
      SELECT id
        FROM engine_custom_models
       WHERE engine = ? AND model_id = ? AND id <> ?
       LIMIT 1
    `).get(engine, modelId, currentId ?? "") as { id?: string } | undefined;
    if (row?.id) throw new Error(`自定义模型 ID 已存在：${modelId}`);
  }
}

function toEntry(row: Row): EngineCustomModelEntry {
  const engine = row.engine === "codex" ? "codex" : "claude";
  const providerId = normalizeEngineKeyProviderId(engine, row.provider_id);
  if (!providerId) throw new Error(`自定义模型供应商不支持当前引擎：${row.provider_id}`);
  return {
    id: row.id,
    engine,
    providerId,
    modelId: row.model_id,
    displayName: row.display_name,
    inputModalities: normalizeInputModalitiesForRepo(parseJsonField<unknown[]>(row.input_modalities_json, "input_modalities_json")),
    supportedReasoningEfforts: normalizeReasoningEffortOptionsForRepo(parseJsonField<unknown[]>(row.reasoning_efforts_json, "reasoning_efforts_json")),
    defaultReasoningEffort: normalizeNullableEffort(row.default_reasoning_effort),
    contextWindow: normalizeNullablePositiveInteger(row.context_window),
    maxContextWindow: normalizeNullablePositiveInteger(row.max_context_window),
    supportsFastMode: row.supports_fast_mode === 1,
    supports1MContext: row.supports_1m_context === 1,
    enabled: row.enabled === 1,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function normalizeUpsertData(input: EngineCustomModelUpsertData): EngineCustomModelEntry {
  const engine = input.engine === "claude" || input.engine === "codex" ? input.engine : null;
  if (!engine) throw new Error("参数错误：engine 必须为 claude 或 codex");
  const providerId = normalizeEngineKeyProviderId(engine, input.providerId);
  if (!providerId) throw new Error("参数错误：供应商不支持当前引擎");
  const modelId = String(input.modelId ?? "").trim();
  if (!modelId) throw new Error("参数错误：modelId 不能为空");
  const supportedReasoningEfforts = normalizeReasoningEffortOptionsForRepo(input.supportedReasoningEfforts);
  assertReasoningEffortsSupportedForProvider(engine, providerId, supportedReasoningEfforts);
  const defaultReasoningEffort = normalizeDefaultReasoningEffort(input.defaultReasoningEffort, supportedReasoningEfforts);
  const contextWindow = normalizeNullablePositiveInteger(input.contextWindow);
  const maxContextWindow = normalizeNullablePositiveInteger(input.maxContextWindow);
  const supports1MContext = Boolean(
    input.supports1MContext
    && contextWindow != null
    && maxContextWindow != null
    && maxContextWindow > contextWindow,
  );
  return {
    id: "",
    engine,
    providerId,
    modelId,
    displayName: String(input.displayName ?? "").trim() || modelId,
    inputModalities: normalizeInputModalitiesForRepo(input.inputModalities),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    contextWindow,
    maxContextWindow,
    supportsFastMode: engine === "codex" && input.supportsFastMode === true,
    supports1MContext,
    enabled: input.enabled !== false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 校验自定义模型的 effort 不超过当前 engine/provider 可兑现的范围。 */
function assertReasoningEffortsSupportedForProvider(
  engine: EngineType,
  providerId: EngineModelProviderId,
  supported: ReasoningEffortOption[],
): void {
  const allowed = new Set(
    getSupportedReasoningEffortsForProvider(engine, providerId)
      .map((item) => item.reasoningEffort),
  );
  for (const item of supported) {
    if (!allowed.has(item.reasoningEffort)) {
      throw new Error(`参数错误：${providerId} 不支持思考强度 ${item.reasoningEffort}`);
    }
  }
}

function normalizeDefaultReasoningEffort(
  value: unknown,
  supported: ReasoningEffortOption[],
): ReasoningEffort | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeReasoningEffortForRepo(raw);
  if (!normalized) throw new Error(`参数错误：不支持的默认思考强度 ${raw}`);
  if (!supported.some((item) => item.reasoningEffort === normalized)) {
    throw new Error("参数错误：默认思考强度必须包含在支持列表中");
  }
  return normalized;
}

function normalizeNullableEffort(value: unknown): ReasoningEffort | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = normalizeReasoningEffortForRepo(raw);
  if (!normalized) throw new Error(`自定义模型默认思考强度非法：${raw}`);
  return normalized;
}

/** 归一化 repo 入库/出库的输入模态，空值默认 text。 */
function normalizeInputModalitiesForRepo(values: unknown): InputModality[] {
  const rawValues = Array.isArray(values) ? values : [];
  const normalized = new Set<InputModality>();
  for (const value of rawValues) {
    const item = String(value ?? "").trim();
    if (item === "text" || item === "image") normalized.add(item);
  }
  if (!normalized.size) normalized.add("text");
  return [...normalized];
}

/** 归一化 repo 入库/出库的 effort 列表，空数组表示运行时不发送。 */
function normalizeReasoningEffortOptionsForRepo(values: unknown): ReasoningEffortOption[] {
  const rawValues = Array.isArray(values) ? values : [];
  const seen = new Set<ReasoningEffort>();
  const normalized: ReasoningEffortOption[] = [];
  for (const value of rawValues) {
    const rawEffort = typeof value === "object" && value !== null
      ? (value as { reasoningEffort?: unknown }).reasoningEffort
      : value;
    const effort = normalizeReasoningEffortForRepo(rawEffort);
    if (!effort) throw new Error(`参数错误：不支持的思考强度 ${String(rawEffort ?? "")}`);
    if (seen.has(effort)) continue;
    const description = typeof value === "object" && value !== null
      ? String((value as { description?: unknown }).description ?? "").trim()
      : "";
    seen.add(effort);
    normalized.push({ reasoningEffort: effort, description: description || effort });
  }
  return normalized;
}

/** 校验 repo 接收的 effort 值，非法值返回 null。 */
function normalizeReasoningEffortForRepo(value: unknown): ReasoningEffort | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "none"
    || normalized === "minimal"
    || normalized === "low"
    || normalized === "medium"
    || normalized === "high"
    || normalized === "xhigh"
    || normalized === "max"
    || normalized === "ultra"
  ) {
    return normalized;
  }
  return null;
}

function normalizeNullablePositiveInteger(value: unknown): number | null {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error("参数错误：上下文窗口必须是正整数");
  }
  return Math.round(numberValue);
}

function parseJsonField<T>(raw: string | null, field: string): T {
  if (!raw) return [] as T;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`自定义模型字段 ${field} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
