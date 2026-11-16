import type { EngineType, RelayProviderId } from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import type { EngineKeyRepo } from "../db/repos/engineKeyRepo.js";

/** 一次性机会标记键；Client 用本地 meta 表，与 Web 侧 localStorage 标记各自独立。 */
export const BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY = "built_in_relay_auto_enable_v1";
/** 只自动启用 Codex（openai 分组），与 Web 侧 BUILT_IN_RELAY_AUTO_ENABLE_PROVIDER_ID 同口径。 */
export const BUILT_IN_RELAY_PROVIDER_ID: RelayProviderId = "openai";
export const BUILT_IN_RELAY_ENGINE: EngineType = "codex";
/** 内置中转显示标签，不作为可信来源判据。 */
const BUILT_IN_RELAY_LABEL_PREFIX = "CodeFlow 内置中转";
export const BUILT_IN_RELAY_KEY_LABEL = `${BUILT_IN_RELAY_LABEL_PREFIX}（Codex）`;
/** 失败日志 code 契约：本次机会已消耗、不会重试，必须可检索。 */
export const BUILT_IN_RELAY_AUTO_ENABLE_FAILED_CODE = "relay_auto_enable_failed";
export const BUILT_IN_RELAY_AUTO_ENABLE_MARKER_FAILED_CODE = "relay_auto_enable_marker_write_failed";
export const BUILT_IN_RELAY_AUTO_ENABLE_NOTIFY_FAILED_CODE = "relay_auto_enable_notify_failed";
const ENSURE_KEY_PATH = "/api/client/relay/key/ensure";
const ENSURE_TIMEOUT_MS = 15_000;
const ERROR_MESSAGE_LIMIT = 300;

export type BuiltInRelayEnsureResult = { providerId: string; rawKey: string; baseUrl: string };

/** 门禁输入：全部来自本地状态，读取不产生副作用。 */
export type BuiltInRelayAutoEnableGate = {
  codexActiveKeyExists: boolean;
  claudeActiveKeyExists: boolean;
  builtInRelayKeyExists: boolean;
  alreadyAttempted: boolean;
};

export type BuiltInRelayAutoEnableSkipReason = "already-attempted" | "active-key-exists" | "built-in-key-exists" | "explicitly-disabled";

export type BuiltInRelayAutoEnableOutcome =
  | { outcome: "skipped"; reason: BuiltInRelayAutoEnableSkipReason }
  /** 只有标记已持久化且凭据与通知均成功才返回 success。 */
  | { outcome: "success"; markerPersisted: boolean }
  | { outcome: "failed"; message: string; markerPersisted: boolean; stage: "gate" | "marker" | "ensure" | "notify"; cause: unknown };

/** 启动自动启用所需的最小本地 DB 能力；便于单测注入，不依赖完整 ClientDb。 */
export type BuiltInRelayAutoEnableDb = {
  db: ClientDb["db"];
  engineKeys: Pick<EngineKeyRepo, "hasActiveKeysForEngine" | "list" | "insert" | "activate" | "isNativeFallbackBlocked">;
};

/** 判断本地 Key 行是否为内置中转 Codex 项；口径与 Web 侧 isBuiltInRelayKey 一致。 */
export function isBuiltInRelayCodexKeyRow(row: { engine: string; providerId: string; source?: string; label?: string }): boolean {
  return row.engine === BUILT_IN_RELAY_ENGINE
    && row.providerId === BUILT_IN_RELAY_PROVIDER_ID
    && row.source === 'builtin';
}

/**
 * 判定是否具备自动启用条件：本地没有任何启用中的 Key、且不存在内置中转 Codex 行、且机会未消耗。
 * 返回 null 表示可以尝试，否则返回跳过原因；任一条件不满足都只跳过，不得消耗一次性机会。
 */
export function resolveBuiltInRelayAutoEnableSkipReason(
  gate: BuiltInRelayAutoEnableGate,
): BuiltInRelayAutoEnableSkipReason | null {
  if (gate.alreadyAttempted) return "already-attempted";
  if (gate.codexActiveKeyExists || gate.claudeActiveKeyExists) return "active-key-exists";
  if (gate.builtInRelayKeyExists) return "built-in-key-exists";
  return null;
}

/** 读取一次性机会标记；缺行或值非 "1" 都视为未消耗。 */
export function hasBuiltInRelayAutoEnableAttempted(db: Pick<ClientDb, "db">): boolean {
  const row = db.db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY) as { value?: string | null } | undefined;
  return String(row?.value ?? "").trim() === "1";
}

/** 持久化一次性机会；写入失败原样抛出，由启用边界中止后续副作用。 */
export function markBuiltInRelayAutoEnableAttempted(db: Pick<ClientDb, "db">): void {
  db.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY);
}

/** 发起 Client 专用内置中转 Key 签发请求；超时、非 2xx 或响应缺字段一律显式抛错。 */
export async function requestBuiltInRelayKey(input: {
  httpBase: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<BuiltInRelayEnsureResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? ENSURE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${input.httpBase}${ENSURE_KEY_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${input.apiKey}`,
      },
      body: "{}",
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应（例如反向代理错误页）按失败处理，正文只用于消息，不参与解析。
      parsed = null;
    }
    if (!response.ok || parsed?.ok !== true) {
      const reason = String(parsed?.code ?? parsed?.message ?? text ?? "").trim().slice(0, ERROR_MESSAGE_LIMIT);
      throw new Error(`内置中转 Key 签发失败：HTTP ${response.status}${reason ? ` ${reason}` : ""}`);
    }
    const providerId = String(parsed?.key?.providerId ?? "").trim();
    const rawKey = String(parsed?.key?.rawKey ?? "").trim();
    const baseUrl = String(parsed?.key?.baseUrl ?? "").trim();
    if (!providerId || !rawKey || !baseUrl) {
      throw new Error("内置中转 Key 签发响应缺少必要字段");
    }
    return { providerId, rawKey, baseUrl };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 执行一次启动期自动启用：门禁 → 消耗机会 → 请求签发 → 写入并启用。
 * 门禁不满足只跳过；机会一旦消耗，失败不回滚、不重试。返回体不含 rawKey。
 */
export async function enableBuiltInRelayOnStartup(input: {
  target: BuiltInRelayAutoEnableDb;
  ensureCredential?: () => Promise<void>;
  /** 仅非桌面旧 Client 显式传入；与可信桌面回调互斥。 */
  requestKey?: () => Promise<BuiltInRelayEnsureResult>;
  /** 本地写入成功后通知 Web 刷新引擎 Key 列表；跳过与失败都不调用。 */
  notifyKeysChanged: () => void;
  withDatabase?: <T>(operation: () => T) => Promise<T>;
}): Promise<BuiltInRelayAutoEnableOutcome> {
  const { target } = input;
  /** 只协调同步条件/持久标记与Key写入，签发请求保持许可外执行。 */
  const database = async <T>(operation: () => T): Promise<T> => input.withDatabase ? input.withDatabase(operation) : operation();
  if (Boolean(input.ensureCredential) === Boolean(input.requestKey)) throw new Error('自动启用必须且只能指定一个凭据入口');
  try {
    const skipReason = await database(() => {
      if (target.engineKeys.isNativeFallbackBlocked(BUILT_IN_RELAY_ENGINE, BUILT_IN_RELAY_PROVIDER_ID)) return "explicitly-disabled" as const;
      return resolveBuiltInRelayAutoEnableSkipReason({
      codexActiveKeyExists: target.engineKeys.hasActiveKeysForEngine("codex"),
      claudeActiveKeyExists: target.engineKeys.hasActiveKeysForEngine("claude"),
      builtInRelayKeyExists: hasBuiltInRelayKeyRow(target),
      alreadyAttempted: hasBuiltInRelayAutoEnableAttempted(target),
      });
    });
    if (skipReason) return { outcome: "skipped", reason: skipReason };
  } catch (cause) { return { outcome: "failed", markerPersisted: false, stage: "gate", message: "内置中转自动启用条件读取失败", cause }; }

  try { await database(() => markBuiltInRelayAutoEnableAttempted(target)); }
  catch (cause) { return { outcome: "failed", markerPersisted: false, stage: "marker", message: "内置中转自动启用标记写入失败", cause }; }
  let stage: "ensure" | "notify" = "ensure";
  try {
    if (input.ensureCredential) await input.ensureCredential();
    else {
      const key = await input.requestKey!();
      await database(() => {
        const row = target.engineKeys.insert({ label: BUILT_IN_RELAY_KEY_LABEL, engine: BUILT_IN_RELAY_ENGINE, providerId: key.providerId, apiKey: key.rawKey, baseUrl: key.baseUrl });
        if (!row.isActive) target.engineKeys.activate(row.id);
      });
    }
    // 已开着的页面不会有别的渠道知道这把 Key：必须主动通知，否则默认会话等链路要等到下次刷新才生效。
    stage = "notify"; input.notifyKeysChanged();
    return { outcome: "success", markerPersisted: true };
  } catch (cause) {
    return {
      outcome: "failed",
      message: stage === "notify" ? "内置中转 Key 变更通知失败" : "内置中转 Key 自动启用失败",
      markerPersisted: true, stage, cause,
    };
  }
}

/** 判断本地是否已存在内置中转 Codex 行（无论启用与否）。 */
function hasBuiltInRelayKeyRow(target: BuiltInRelayAutoEnableDb): boolean {
  return target.engineKeys.list().some((row) => isBuiltInRelayCodexKeyRow(row));
}
