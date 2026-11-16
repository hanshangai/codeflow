import crypto from 'node:crypto';
import type { EngineModelProviderId, EngineType } from '@codeflowai/shared';

import { runEngineKeyMutationExclusive } from '../app/handlers/engineKeyHandlers.js';
import { assertEngineKeySourceVerified, type EngineKeyRepo, type PersistedEngineKey } from '../db/repos/engineKeyRepo.js';
import type { EngineCredentialConfig } from '../enginesConfig.js';
import type { DesktopCloudAccountOwner } from '../runtime/desktopCloudAccount.js';
import { createCredentialStore, type CredentialStore } from './credentialStore.js';

export type BuiltInRelayEnsureResponse = { providerId: string; keyId: string; ownerUserId: string; rawKey: string; baseUrl: string };
export type EngineCredentialLease = { config: EngineCredentialConfig | null; owner: DesktopCloudAccountOwner | null; assertCurrent: () => void; release: () => void };
export type BuiltInRelayEnsureInput = { engine: EngineType; providerId: string; requestId: string; reset?: boolean; intent?: 'manual' | 'auto' | 'reset'; prepareKeySwitch?: () => Promise<void> };
type Permission = { owner: DesktopCloudAccountOwner; config: EngineCredentialConfig; valid: boolean; leases: Set<() => void>; drained: Set<() => void> };
export type BuiltInRelayCredentialService = ReturnType<typeof createBuiltInRelayCredentialService>;

/** 内置材料和当次账号许可分离；自配仍沿原数据库读取路径。 */
export function createBuiltInRelayCredentialService(input: {
  repo: EngineKeyRepo;
  getOwner: () => DesktopCloudAccountOwner | null;
  assertOwner: (owner: DesktopCloudAccountOwner) => void;
  requestEnsure: (owner: DesktopCloudAccountOwner, request: { providerId: string; reset?: boolean; requestId: string }) => Promise<BuiltInRelayEnsureResponse>;
  releaseOwnerSessions?: (owner: DesktopCloudAccountOwner, keyId?: string) => Promise<void>;
  credentialStore?: CredentialStore;
  withLegacyDatabase?: <T>(requestId: string, operation: () => T) => Promise<T>;
}) {
  const permissions = new Map<string, Permission>();
  const allPermissions = new Set<Permission>();
  const blockedScopes = new Set<string>();
  let store: CredentialStore | undefined = input.credentialStore;

  /** 凭据短段复用数据库准入，网络重验与旧会话排空不持许可。 */
  async function database<T>(requestId: string, operation: () => T): Promise<T> {
    return input.withLegacyDatabase ? input.withLegacyDatabase(requestId, operation) : operation();
  }

  /** 延迟创建且只允许 OS store；测试可显式注入隔离边界。 */
  function credentialStore(): CredentialStore { return store ??= createCredentialStore({ requireOs: true }); }

  /** 稳定错误只携安全定位信息，绝不携带秘密或 HTTP 原文。 */
  function denied(code: string, keyId?: string): Error {
    return Object.assign(new Error(`内置中转凭据不可用：${code}${keyId ? `（keyId=${keyId}）` : ''}`), { code, keyId });
  }

  /** 每个副作用前重新校验可信账号，不把持久元数据当成当前许可。 */
  function owner(): DesktopCloudAccountOwner {
    const current = input.getOwner();
    if (!current) throw denied('BUILT_IN_RELAY_ACCOUNT_REQUIRED');
    input.assertOwner(current); return current;
  }

  /** owner 身份包含 session 与 generation，同账号重登也必须重验。 */
  function sameOwner(left: DesktopCloudAccountOwner, right: DesktopCloudAccountOwner): boolean {
    return left.serverOrigin === right.serverOrigin && left.ownerUserId === right.ownerUserId && left.accountSessionId === right.accountSessionId && left.generation === right.generation;
  }

  /** 只取得仍属于当前 owner 且本次内存授权有效的许可。 */
  function permission(key: PersistedEngineKey): Permission {
    const current = owner(), permit = permissions.get(key.id);
    if (!permit?.valid || !sameOwner(permit.owner, current)) throw denied('BUILT_IN_RELAY_REVALIDATION_REQUIRED', key.id);
    input.assertOwner(permit.owner);
    if (key.serverOrigin !== current.serverOrigin || key.ownerUserId !== current.ownerUserId || !key.keyId || !key.secretRef) throw denied('BUILT_IN_RELAY_OWNER_MISMATCH', key.id);
    let secret: string | null;
    try { secret = credentialStore().get(key.secretRef); }
    catch (cause) { permit.valid = false; throw cause; }
    if (!secret || secret !== permit.config.apiKey) { permit.valid = false; throw denied('BUILT_IN_RELAY_SECRET_MISSING', key.id); }
    return permit;
  }

  /** 锁内重新读取本账号内置条目，禁止跨账号停用或删除材料。 */
  function ownedKey(keyId: string, snapshot: DesktopCloudAccountOwner): PersistedEngineKey {
    input.assertOwner(snapshot);
    const key = input.repo.get(keyId);
    if (!key || key.source !== 'builtin') throw denied('BUILT_IN_RELAY_KEY_REQUIRED', keyId);
    if (key.serverOrigin !== snapshot.serverOrigin || key.ownerUserId !== snapshot.ownerUserId) throw denied('BUILT_IN_RELAY_OWNER_MISMATCH', keyId);
    return key;
  }

  /** 立即阻止目标 Key 新派发，排空旧 lease 前保持其冻结材料。 */
  function revokeKey(key: PersistedEngineKey): Permission[] {
    const previous = [...allPermissions].filter(permit => permit.config.credentialIdentity?.keyId === key.id);
    for (const permit of previous) permit.valid = false;
    blockedScopes.add(`${key.engine}:${key.providerId}`);
    return previous;
  }

  /** 释放一个已接受回合；失效后最后一回合结束才通知外层释放旧进程。 */
  function release(permit: Permission, handle: () => void): void {
    permit.leases.delete(handle);
    if (permit.leases.size === 0) { for (const resolve of permit.drained) resolve(); permit.drained.clear(); if (!permit.valid) allPermissions.delete(permit); }
  }

  /** 启用复用原队列；刷新只排空目标 Key，await 前后重复 owner fence。 */
  async function ensure(request: BuiltInRelayEnsureInput): Promise<PersistedEngineKey> {
    const snapshot = owner();
    return await runEngineKeyMutationExclusive(request.engine, async () => {
      input.assertOwner(snapshot);
      if (request.intent === 'auto' && await database(request.requestId, () => {
        input.assertOwner(snapshot); return input.repo.isNativeFallbackBlocked(request.engine, request.providerId);
      })) throw denied('BUILT_IN_RELAY_REVALIDATION_REQUIRED');
      input.assertOwner(snapshot);
      if (request.prepareKeySwitch) { await request.prepareKeySwitch(); input.assertOwner(snapshot); }
      blockedScopes.add(`${request.engine}:${request.providerId}`);
      const existing = await database(request.requestId, () => {
        input.assertOwner(snapshot);
        return input.repo.list().find(key => key.source === 'builtin' && key.engine === request.engine && key.providerId === request.providerId && key.serverOrigin === snapshot.serverOrigin && key.ownerUserId === snapshot.ownerUserId);
      });
      input.assertOwner(snapshot);
      if (existing) {
        const previous = revokeKey(existing);
        await Promise.all(previous.filter(permit => permit.leases.size > 0).map(permit => new Promise<void>(resolve => permit.drained.add(resolve))));
        input.assertOwner(snapshot);
        if (!input.releaseOwnerSessions) throw denied('BUILT_IN_RELAY_PROCESS_RELEASE_REQUIRED', existing.id);
        await input.releaseOwnerSessions(snapshot, existing.id);
        input.assertOwner(snapshot);
      }
      const response = await input.requestEnsure(snapshot, { providerId: request.providerId, requestId: request.requestId, ...(request.reset || request.intent === 'reset' ? { reset: true } : {}) });
      input.assertOwner(snapshot);
      if (response.ownerUserId !== snapshot.ownerUserId) throw denied('BUILT_IN_RELAY_OWNER_MISMATCH');
      if (response.providerId !== request.providerId || [response.keyId, response.rawKey, response.baseUrl].some(value => typeof value !== 'string' || !value.trim())) throw denied('BUILT_IN_RELAY_RESPONSE_INVALID');
      const ref = `builtin-relay:${crypto.createHash('sha256').update(snapshot.serverOrigin + ':' + snapshot.ownerUserId).digest('hex')}:${response.keyId}:${crypto.randomUUID()}`;
      input.assertOwner(snapshot);
      credentialStore().set(ref, response.rawKey);
      try {
        return await database(request.requestId, () => {
        input.assertOwner(snapshot);
        const key = input.repo.saveBuiltIn({ ...(existing ? { id: existing.id } : {}), label: `CodeFlow 内置中转（${request.engine === 'codex' ? 'Codex' : 'Claude'}）`, engine: request.engine, providerId: request.providerId, baseUrl: response.baseUrl, serverOrigin: snapshot.serverOrigin, ownerUserId: snapshot.ownerUserId, keyId: response.keyId, secretRef: ref });
        input.assertOwner(snapshot);
        const activated = input.repo.activate(key.id);
        input.assertOwner(snapshot);
        if (existing?.secretRef && existing.secretRef !== ref) credentialStore().delete(existing.secretRef);
        input.assertOwner(snapshot);
        input.repo.clearNativeFallbackBlock(request.engine, request.providerId);
        const prior = permissions.get(key.id);
        if (prior) prior.valid = false;
        const permit: Permission = { owner: snapshot, config: { apiKey: response.rawKey, baseUrl: response.baseUrl, credentialIdentity: { keyId: key.id, serverOrigin: snapshot.serverOrigin, ownerUserId: snapshot.ownerUserId, accountSessionId: snapshot.accountSessionId, generation: snapshot.generation } }, valid: true, leases: new Set(), drained: new Set() };
        permissions.set(key.id, permit); allPermissions.add(permit);
        blockedScopes.delete(`${request.engine}:${request.providerId}`);
        return activated;
        });
      } catch (cause) {
        try { credentialStore().delete(ref); }
        catch (cleanupCause) { throw new AggregateError([cause, cleanupCause], '内置凭据持久化失败且秘密清理失败', { cause }); }
        throw cause;
      }
    });
  }

  /** 已知自配保持原值；内置从内存许可取值，永不返回 null 触发认证回落。 */
  function resolveCredentials(key: PersistedEngineKey): EngineCredentialConfig {
    assertEngineKeySourceVerified(key);
    if (key.source !== 'builtin') return { apiKey: key.apiKey, baseUrl: key.baseUrl };
    return permission(key).config;
  }

  /** 新引擎操作取得冻结配置；回合内部连续 HTTP 使用同一份材料。 */
  function acquire(request: { engine: EngineType; providerId?: EngineModelProviderId; keyId?: string; threadId?: string; turnId?: string; requestId?: string }): EngineCredentialLease {
    const key = request.keyId ? input.repo.get(request.keyId) : request.providerId ? input.repo.getActive(request.engine, request.providerId) : input.repo.getFirstActiveForEngine(request.engine);
    if (!key) {
      if (input.repo.isNativeFallbackBlocked(request.engine, request.providerId) || input.repo.list().some(row => row.source !== 'user_configured' && row.engine === request.engine && (!request.providerId || row.providerId === request.providerId)) || [...blockedScopes].some(scope => request.providerId ? scope === `${request.engine}:${request.providerId}` : scope.startsWith(`${request.engine}:`))) throw denied('BUILT_IN_RELAY_REVALIDATION_REQUIRED');
      return { config: null, owner: null, assertCurrent() {}, release() {} };
    }
    if (key.source !== 'builtin') return { config: resolveCredentials(key), owner: null, assertCurrent() {}, release() {} };
    const permit = permission(key); let released = false;
    const handle = () => { if (!released) { released = true; release(permit, handle); } };
    permit.leases.add(handle);
    return { config: permit.config, owner: permit.owner, assertCurrent() { if (!permit.valid || permissions.get(key.id) !== permit) throw denied('BUILT_IN_RELAY_REVALIDATION_REQUIRED', key.id); permission(key); }, release: handle };
  }

  /** 同步撤销全部旧 owner 新操作资格；返回值只等待已接受回合自然释放。 */
  function invalidateOwner(snapshot: DesktopCloudAccountOwner): Promise<void> {
    const waiting: Promise<void>[] = [];
    for (const permit of allPermissions) {
      if (!sameOwner(permit.owner, snapshot)) continue;
      permit.valid = false;
      if (permit.leases.size) waiting.push(new Promise(resolve => permit.drained.add(resolve)));
    }
    return Promise.all(waiting).then(() => { for (const permit of allPermissions) if (!permit.valid && permit.leases.size === 0) allPermissions.delete(permit); });
  }

  /** 激活内置行必须走当前 Server 重验，不能只切 DB active 位。 */
  async function activate(keyId: string, requestId: string, prepareKeySwitch?: () => Promise<void>): Promise<PersistedEngineKey> {
    const snapshot = owner(), key = await database(requestId, () => input.repo.get(keyId));
    input.assertOwner(snapshot);
    if (!key || key.source !== 'builtin' || key.ownerUserId !== snapshot.ownerUserId || key.serverOrigin !== snapshot.serverOrigin) throw denied('BUILT_IN_RELAY_OWNER_MISMATCH', keyId);
    return await ensure({ engine: key.engine as EngineType, providerId: key.providerId, requestId, prepareKeySwitch });
  }

  /** 停用不激活替代 Key，许可同步失效；已有回合仍保留冻结材料。 */
  async function deactivate(keyId: string, requestId: string): Promise<PersistedEngineKey> {
    const snapshot = owner(), key = await database(requestId, () => ownedKey(keyId, snapshot)); revokeKey(key);
    return await runEngineKeyMutationExclusive(key.engine as EngineType, () => database(requestId, () => { revokeKey(ownedKey(keyId, snapshot)); return input.repo.deactivate(keyId); }));
  }

  /** 删除仅清理本服务管理的内置条目，不触碰自配或自动选择替代 Key。 */
  async function deleteKey(keyId: string, requestId: string): Promise<void> {
    const snapshot = owner(), key = await database(requestId, () => {
      const current = ownedKey(keyId, snapshot);
      input.repo.blockNativeFallback(current.engine as EngineType, current.providerId); revokeKey(current); return current;
    });
    await runEngineKeyMutationExclusive(key.engine as EngineType, async () => {
      const { current, previous } = await database(requestId, () => {
        const current = ownedKey(keyId, snapshot);
        input.repo.blockNativeFallback(current.engine as EngineType, current.providerId);
        const previous = revokeKey(current); input.repo.deactivate(keyId); return { current, previous };
      });
      await Promise.all(previous.filter(permit => permit.leases.size).map(permit => new Promise<void>(resolve => permit.drained.add(resolve))));
      await database(requestId, () => {
        ownedKey(keyId, snapshot);
        if (current.secretRef) credentialStore().delete(current.secretRef);
        input.assertOwner(snapshot); input.repo.deleteBuiltIn(keyId); permissions.delete(keyId);
      });
      for (const permit of previous) allPermissions.delete(permit);
    });
  }

  /** 仅供状态投影，当前许可检查失败不允许形成原生认证替代路径。 */
  function isAvailable(key: PersistedEngineKey): boolean {
    if (key.source === 'unknown') return false;
    if (key.source !== 'builtin') return Boolean(key.apiKey);
    const permit = permissions.get(key.id), current = input.getOwner();
    if (!permit?.valid || !current || !sameOwner(permit.owner, current)) return false;
    if (!key.secretRef || credentialStore().get(key.secretRef) !== permit.config.apiKey) { permit.valid = false; return false; }
    return true;
  }

  /** 状态投影复用实际派发范围，未验内置与显式停用都禁止显示原生认证可用。 */
  function isScopeBlocked(engine: EngineType, providerId: EngineModelProviderId): boolean {
    const active = input.repo.getActive(engine, providerId);
    if (active) return active.source === 'unknown' || (active.source === 'builtin' && !isAvailable(active));
    return input.repo.isNativeFallbackBlocked(engine, providerId) || blockedScopes.has(`${engine}:${providerId}`) || input.repo.list().some(key => key.source !== 'user_configured' && key.engine === engine && key.providerId === providerId);
  }

  /** 显式自配已完成 native 同步后才清除本范围禁回落意图。 */
  function confirmUserConfigured(key: PersistedEngineKey): void {
    const current = input.repo.get(key.id);
    if (!current || current.source !== 'user_configured' || !current.isActive || !current.apiKey.trim()) throw denied('BUILT_IN_RELAY_EXPLICIT_CREDENTIAL_REQUIRED', key.id);
    input.repo.clearNativeFallbackBlock(current.engine as EngineType, current.providerId);
    blockedScopes.delete(`${current.engine}:${current.providerId}`);
  }

  return { ensure, activate, deactivate, delete: deleteKey, resolveCredentials, acquire, invalidateOwner, isAvailable, isScopeBlocked, confirmUserConfigured };
}
