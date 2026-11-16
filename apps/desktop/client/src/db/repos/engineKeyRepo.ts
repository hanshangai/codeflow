import crypto from "node:crypto";

import { getDefaultEngineProviderId, isEngineProviderAllowed, normalizeEngineKeyProviderId, type EngineModelProviderId, type EngineType } from "@codeflowai/shared";

import type { SqliteDb } from "../sqliteTypes.js";

export type EngineKeySource = 'unknown' | 'user_configured' | 'builtin';
export type BuiltInEngineKeyMetadata = { serverOrigin: string; ownerUserId: string; keyId: string; secretRef: string };
const NATIVE_FALLBACK_BLOCK_PREFIX = 'engine_native_fallback_block:';

export type PersistedEngineKey = {
  id: string;
  label: string;
  engine: string;
  providerId: EngineModelProviderId;
  apiKey: string;
  baseUrl: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  source: EngineKeySource;
  serverOrigin: string | null;
  ownerUserId: string | null;
  keyId: string | null;
  secretRef: string | null;
};

type Row = {
  id: string;
  label: string;
  engine: string;
  provider_id: string | null;
  api_key: string;
  base_url: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  source: EngineKeySource;
  server_origin: string | null;
  owner_user_id: string | null;
  server_key_id: string | null;
  secret_ref: string | null;
};

/** 按已落盘来源原样投影，不通过标签推断可信 owner。 */
function toEntry(r: Row): PersistedEngineKey {
  return {
    id: r.id,
    label: r.label,
    engine: r.engine,
    providerId: normalizeRowProviderId(r.engine, r.provider_id),
    apiKey: r.api_key,
    baseUrl: r.base_url ?? null,
    isActive: r.is_active === 1,
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    source: r.source, serverOrigin: r.server_origin, ownerUserId: r.owner_user_id, keyId: r.server_key_id, secretRef: r.secret_ref,
  };
}

/** 引擎 Key 仓储：管理多引擎 API Key 的持久化与激活切换。 */
export class EngineKeyRepo {
  constructor(private readonly db: SqliteDb) {}

  /** 列出所有 Key（按 engine/provider + is_active DESC 排序）。 */
  list(): PersistedEngineKey[] {
    const rows = this.db
      .prepare("SELECT * FROM engine_keys ORDER BY engine, provider_id, is_active DESC, created_at DESC")
      .all() as Row[];
    return rows.map(toEntry);
  }

  /** 按 id 获取单条。 */
  get(id: string): PersistedEngineKey | null {
    const row = this.db
      .prepare("SELECT * FROM engine_keys WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 获取指定 engine/provider 的默认 active Key。 */
  getActive(engine: EngineType, providerId: string): PersistedEngineKey | null {
    const normalizedProviderId = normalizeProviderIdOrThrow(engine, providerId);
    const row = this.db
      .prepare("SELECT * FROM engine_keys WHERE engine = ? AND provider_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1")
      .get(engine, normalizedProviderId) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 获取指定 engine 当前任一默认 Key，用于同步引擎原生配置。 */
  getFirstActiveForEngine(engine: EngineType): PersistedEngineKey | null {
    const row = this.db
      .prepare("SELECT * FROM engine_keys WHERE engine = ? AND is_active = 1 ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1")
      .get(engine) as Row | undefined;
    return row ? toEntry(row) : null;
  }

  /** 是否存在指定引擎的已维护 Key。 */
  hasKeysForEngine(engine: EngineType): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM engine_keys WHERE engine = ? LIMIT 1").get(engine) as { found?: number } | undefined;
    return Boolean(row);
  }

  /** 是否存在指定引擎已启用的默认 Key。 */
  hasActiveKeysForEngine(engine: EngineType): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM engine_keys WHERE engine = ? AND is_active = 1 LIMIT 1").get(engine) as { found?: number } | undefined;
    return Boolean(row);
  }

  /** 删除内置后的禁回落意图复用 meta 持久化，失败时禁止继续删除。 */
  blockNativeFallback(engine: EngineType, providerId: string): void {
    const provider = normalizeProviderIdOrThrow(engine, providerId);
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`${NATIVE_FALLBACK_BLOCK_PREFIX}${engine}:${provider}`);
  }

  /** 仅在明确选择自配或可信内置成功后清除对应供应商的禁用意图。 */
  clearNativeFallbackBlock(engine: EngineType, providerId: string): void {
    const provider = normalizeProviderIdOrThrow(engine, providerId);
    this.db.prepare('DELETE FROM meta WHERE key = ?').run(`${NATIVE_FALLBACK_BLOCK_PREFIX}${engine}:${provider}`);
  }

  /** 重启后仍按相同 engine/provider 范围阻断 native，不依赖内存许可。 */
  isNativeFallbackBlocked(engine: EngineType, providerId?: string): boolean {
    if (providerId) {
      const provider = normalizeProviderIdOrThrow(engine, providerId);
      return Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key = ? AND value = '1'").get(`${NATIVE_FALLBACK_BLOCK_PREFIX}${engine}:${provider}`));
    }
    return Boolean(this.db.prepare("SELECT 1 FROM meta WHERE key LIKE ? AND value = '1' LIMIT 1").get(`${NATIVE_FALLBACK_BLOCK_PREFIX}${engine}:%`));
  }

  /** 卸载先持久禁回落并停用全部 Key；独立同步事务不跨凭据存储调用。 */
  beginDesktopUninstallCredentialCleanup(): void {
    this.db.transaction(() => {
      const scopes = new Set<string>();
      for (const key of this.list()) {
        const scope = `${key.engine}:${key.providerId}`;
        if (scopes.has(scope)) continue;
        this.blockNativeFallback(key.engine as EngineType, key.providerId);
        scopes.add(scope);
      }
      this.db.prepare('UPDATE engine_keys SET is_active = 0').run();
    })();
  }

  /** 仅在所有非空引用已精确删除后清库内秘密，失败保留引用供同范围重试。 */
  finishDesktopUninstallCredentialCleanup(deletedRefs: readonly string[]): void {
    this.db.transaction(() => {
      const deleted = new Set(deletedRefs);
      for (const key of this.list()) {
        if (key.secretRef !== null && (key.source !== 'builtin' || !deleted.has(key.secretRef))) {
          throw new Error('DESKTOP_UNINSTALL_SECRET_REF_NOT_CLEARED');
        }
      }
      this.db.prepare("UPDATE engine_keys SET api_key = '', secret_ref = NULL, is_active = 0").run();
    })();
  }

  /** 新增 Key；同 engine/provider 首个 Key 自动成为该供应商默认。 */
  insert(input: { label: string; engine: EngineType; providerId?: string | null; apiKey: string; baseUrl?: string | null }): PersistedEngineKey {
    const id = crypto.randomUUID();
    const now = Date.now();
    const providerId = normalizeProviderIdOrThrow(input.engine, input.providerId);
    const activeExists = Boolean(this.getActive(input.engine, providerId));
    const isActive = activeExists ? 0 : 1;
    this.db
      .prepare("INSERT INTO engine_keys (id, label, engine, provider_id, api_key, base_url, is_active, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_configured')")
      .run(id, input.label, input.engine, providerId, input.apiKey, input.baseUrl ?? null, isActive, now, now);
    return {
      id,
      label: input.label,
      engine: input.engine,
      providerId,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl ?? null,
      isActive: isActive === 1,
      createdAt: now,
      updatedAt: now,
      source: 'user_configured', serverOrigin: null, ownerUserId: null, keyId: null, secretRef: null,
    };
  }

  /** 更新 Key；供应商变更时同步修正 old/new provider 默认 Key。 */
  update(id: string, input: { label?: string; providerId?: string | null; apiKey?: string; baseUrl?: string | null }): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`engine_key 不存在：${id}`);
    if (existing.source === 'builtin') throw new Error(`内置 Key 只能通过可信凭据入口更新：${id}`);
    const now = Date.now();
    const label = input.label ?? existing.label;
    const apiKey = input.apiKey ?? existing.apiKey;
    if (input.apiKey !== undefined && !input.apiKey.trim()) throw new Error('apiKey 不能为空');
    const source: EngineKeySource = input.apiKey !== undefined ? 'user_configured' : existing.source;
    const baseUrl = input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl;
    const engine = existing.engine as EngineType;
    const nextProviderId = input.providerId !== undefined
      ? normalizeProviderIdOrThrow(engine, input.providerId)
      : existing.providerId;

    const tx = this.db.transaction(() => {
      if (nextProviderId === existing.providerId) {
        this.db
          .prepare("UPDATE engine_keys SET label = ?, api_key = ?, base_url = ?, updated_at = ?, source = ? WHERE id = ?")
          .run(label, apiKey, baseUrl, now, source, id);
        return;
      }

      const targetActiveExists = Boolean(this.db
        .prepare("SELECT 1 AS found FROM engine_keys WHERE engine = ? AND provider_id = ? AND is_active = 1 AND id <> ? LIMIT 1")
        .get(engine, nextProviderId, id) as { found?: number } | undefined);
      const shouldActivateInTargetProvider = Boolean(apiKey.trim()) && (existing.isActive || !targetActiveExists);
      if (shouldActivateInTargetProvider) {
        this.db
          .prepare("UPDATE engine_keys SET is_active = 0, updated_at = ? WHERE engine = ? AND provider_id = ?")
          .run(now, engine, nextProviderId);
      }
      this.db
        .prepare("UPDATE engine_keys SET label = ?, provider_id = ?, api_key = ?, base_url = ?, is_active = ?, updated_at = ?, source = ? WHERE id = ?")
        .run(label, nextProviderId, apiKey, baseUrl, shouldActivateInTargetProvider ? 1 : 0, now, source, id);
      if (existing.isActive) {
        this.ensureProviderHasActiveKey(engine, existing.providerId);
      }
    });
    tx();
  }

  /** 删除自配才补选默认；删除未知来源先持久禁回落，不把旧 native 材料当确认。 */
  delete(id: string): void {
    const existing = this.get(id);
    const tx = this.db.transaction(() => {
      if (existing?.source === 'unknown') this.blockNativeFallback(existing.engine as EngineType, existing.providerId);
      this.db.prepare("DELETE FROM engine_keys WHERE id = ?").run(id);
      if (existing?.isActive && existing.source === 'user_configured') {
        this.ensureProviderHasActiveKey(existing.engine as EngineType, existing.providerId);
      }
    });
    tx();
  }

  /** 仅可信签发入口写内置元数据；secret 已存 OS，SQLite 永远不接收原文。 */
  saveBuiltIn(input: { id?: string; label: string; engine: EngineType; providerId: string; baseUrl: string } & BuiltInEngineKeyMetadata): PersistedEngineKey {
    const providerId = normalizeProviderIdOrThrow(input.engine, input.providerId);
    for (const value of [input.serverOrigin, input.ownerUserId, input.keyId, input.secretRef]) if (!value.trim()) throw new Error('内置 Key 可信元数据缺失');
    const id = input.id ?? crypto.randomUUID(), now = Date.now();
    const existing = input.id ? this.get(input.id) : null;
    if (existing && existing.source !== 'builtin') throw new Error(`不能认领非内置 Key：${id}`);
    if (existing) this.db.prepare("UPDATE engine_keys SET label=?, provider_id=?, api_key='', base_url=?, server_origin=?, owner_user_id=?, server_key_id=?, secret_ref=?, updated_at=? WHERE id=?").run(input.label, providerId, input.baseUrl, input.serverOrigin, input.ownerUserId, input.keyId, input.secretRef, now, id);
    else this.db.prepare("INSERT INTO engine_keys (id,label,engine,provider_id,api_key,base_url,is_active,created_at,updated_at,source,server_origin,owner_user_id,server_key_id,secret_ref) VALUES (?,?,?,?,'',?,0,?,?,'builtin',?,?,?,?)").run(id,input.label,input.engine,providerId,input.baseUrl,now,now,input.serverOrigin,input.ownerUserId,input.keyId,input.secretRef);
    return this.get(id)!;
  }

  /** 删除内置材料时不自动激活其它 Key，避免失效回落。 */
  deleteBuiltIn(id: string): void {
    if (this.get(id)?.source !== 'builtin') throw new Error(`非内置 Key：${id}`);
    this.db.prepare('DELETE FROM engine_keys WHERE id = ?').run(id);
  }

  /** 激活指定 Key：只切换同 engine/provider 的默认 Key。 */
  activate(id: string): PersistedEngineKey {
    const entry = this.get(id);
    if (!entry) throw new Error(`engine_key 不存在：${id}`);
    assertEngineKeySourceVerified(entry);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE engine_keys SET is_active = 0, updated_at = ? WHERE engine = ? AND provider_id = ?").run(now, entry.engine, entry.providerId);
      this.db.prepare("UPDATE engine_keys SET is_active = 1, updated_at = ? WHERE id = ?").run(now, id);
    });
    tx();
    return { ...entry, isActive: true, updatedAt: now };
  }

  /** 停用指定 Key；不会自动为同 provider 选择替代默认。 */
  deactivate(id: string): PersistedEngineKey {
    const entry = this.get(id);
    if (!entry) throw new Error(`engine_key 不存在：${id}`);
    if (!entry.isActive) return entry;
    const now = Date.now();
    this.db.prepare("UPDATE engine_keys SET is_active = 0, updated_at = ? WHERE id = ?").run(now, id);
    return { ...entry, isActive: false, updatedAt: now };
  }

  /** 在单个事务内恢复某引擎的完整 Key 快照，供 native 配置同步失败时补偿。 */
  restoreEngineSnapshot(engine: EngineType, entries: PersistedEngineKey[]): void {
    const normalized = entries.map((entry) => {
      if (entry.engine !== engine) throw new Error(`engine key snapshot scope mismatch: ${entry.id}`);
      const providerId = normalizeProviderIdOrThrow(engine, entry.providerId);
      if (!entry.id || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.updatedAt)) {
        throw new Error(`invalid engine key snapshot entry: ${entry.id || "missing"}`);
      }
      return { ...entry, providerId };
    });
    if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
      throw new Error(`duplicate engine key snapshot id for ${engine}`);
    }

    const restore = this.db.transaction(() => {
      this.db.prepare("DELETE FROM engine_keys WHERE engine = ?").run(engine);
      const insert = this.db.prepare(
        "INSERT INTO engine_keys (id, label, engine, provider_id, api_key, base_url, is_active, created_at, updated_at, source, server_origin, owner_user_id, server_key_id, secret_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const entry of normalized) {
        insert.run(
          entry.id,
          entry.label,
          engine,
          entry.providerId,
          entry.apiKey,
          entry.baseUrl,
          entry.isActive ? 1 : 0,
          entry.createdAt,
          entry.updatedAt,
          entry.source, entry.serverOrigin, entry.ownerUserId, entry.keyId, entry.secretRef,
        );
      }
    });
    restore();
  }

  /** 普通变更按原序补选非空自配；内置仍须经可信签发入口显式激活。 */
  private ensureProviderHasActiveKey(engine: EngineType, providerId: EngineModelProviderId): void {
    const candidates = this.db
      .prepare("SELECT id, api_key FROM engine_keys WHERE engine = ? AND provider_id = ? AND source = 'user_configured' ORDER BY updated_at DESC, created_at DESC, id DESC")
      .all(engine, providerId) as { id: string; api_key: string }[];
    const next = candidates.find(candidate => candidate.api_key.trim());
    if (!next?.id) return;
    const now = Date.now();
    this.db.prepare("UPDATE engine_keys SET is_active = 1, updated_at = ? WHERE id = ?").run(now, next.id);
  }
}

/** 来源或秘密未核验时拒绝启用和派发，重新录入或可信签发后恢复。 */
export function assertEngineKeySourceVerified(key: PersistedEngineKey): void {
  if (key.source === 'unknown') throw Object.assign(new Error('历史 Key 来源未确认，请重新录入自配凭据或启用内置中转'), { code: 'CONFLICT', details: { reason: 'ENGINE_KEY_SOURCE_REVALIDATION_REQUIRED', keyId: key.id } });
  if (key.source === 'user_configured' && !key.apiKey.trim()) throw Object.assign(new Error('Key 已清除，请重新录入凭据，不能为空'), { code: 'CONFLICT', details: { reason: 'ENGINE_KEY_SOURCE_REVALIDATION_REQUIRED', keyId: key.id } });
}

function normalizeProviderIdOrThrow(engine: EngineType, providerId: string | null | undefined): EngineModelProviderId {
  const normalized = normalizeEngineKeyProviderId(engine, providerId);
  if (!normalized) throw new Error(`供应商 ${String(providerId ?? "") || "(默认)"} 不支持 ${engine} 引擎`);
  return normalized;
}

function normalizeRowProviderId(engine: string, providerId: string | null | undefined): EngineModelProviderId {
  const typedEngine = engine === "codex" ? "codex" : "claude";
  const normalized = String(providerId ?? "").trim();
  if (isEngineProviderAllowed(typedEngine, normalized)) return normalized;
  return getDefaultEngineProviderId(typedEngine);
}
