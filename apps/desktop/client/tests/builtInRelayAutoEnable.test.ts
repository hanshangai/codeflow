import assert from "node:assert/strict";
import test from "node:test";

import type { ClientDb } from "../src/db/clientDb.ts";
import type { PersistedEngineKey } from "../src/db/repos/engineKeyRepo.ts";
import {
  BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY,
  BUILT_IN_RELAY_KEY_LABEL,
  enableBuiltInRelayOnStartup,
  hasBuiltInRelayAutoEnableAttempted,
  isBuiltInRelayCodexKeyRow,
  requestBuiltInRelayKey,
  resolveBuiltInRelayAutoEnableSkipReason,
  type BuiltInRelayAutoEnableDb,
  type BuiltInRelayEnsureResult,
} from "../src/startup/builtInRelayAutoEnable.ts";

const VALID_KEY: BuiltInRelayEnsureResult = {
  providerId: "openai",
  rawKey: "codeflowai_relay_raw_key",
  baseUrl: "https://relay.test/v1",
};

/** 内存 meta 表替身：只实现本能力用到的 get/run，并支持模拟写入失败。 */
function createFakeMeta(options: { writeFails?: boolean } = {}) {
  const values = new Map<string, string>();
  const db = {
    prepare() {
      return {
        get: (key: string) => (values.has(key) ? { value: values.get(key) } : undefined),
        run: (key: string) => {
          if (options.writeFails) throw new Error("disk I/O error");
          values.set(key, "1");
        },
      };
    },
  } as unknown as ClientDb["db"];
  return { db, values };
}

/** 引擎 Key 仓储替身：记录 insert/activate 调用，便于断言只写一次。 */
function createFakeEngineKeys(options: { rows?: PersistedEngineKey[]; insertReturnsInactive?: boolean; nativeFallbackBlocked?: boolean } = {}) {
  const rows = options.rows ?? [];
  const activatedIds: string[] = [];
  const insertedKeys: string[] = [];
  const repo = {
    list: () => rows,
    hasActiveKeysForEngine: (engine: string) => rows.some((row) => row.engine === engine && row.isActive),
    isNativeFallbackBlocked: () => options.nativeFallbackBlocked === true,
    insert: (input: { label: string; engine: string; providerId?: string | null; apiKey: string; baseUrl?: string | null }) => {
      const row: PersistedEngineKey = {
        id: `key-${rows.length + 1}`,
        label: input.label,
        engine: input.engine,
        providerId: (input.providerId ?? null) as PersistedEngineKey["providerId"],
        apiKey: input.apiKey,
        baseUrl: input.baseUrl ?? null,
        isActive: !options.insertReturnsInactive,
        createdAt: 1,
        updatedAt: 1,
        source: 'user_configured', serverOrigin: null, ownerUserId: null, keyId: null, secretRef: null,
      };
      rows.push(row);
      insertedKeys.push(input.apiKey);
      return row;
    },
    activate: (id: string) => {
      activatedIds.push(id);
      return rows.find((row) => row.id === id)!;
    },
  } as unknown as BuiltInRelayAutoEnableDb["engineKeys"];
  return { repo, rows, activatedIds, insertedKeys };
}

function engineKeyRow(overrides: Partial<PersistedEngineKey>): PersistedEngineKey {
  return {
    id: "existing-key",
    label: "自定义 Key",
    engine: "codex",
    providerId: "openai",
    apiKey: "existing",
    baseUrl: null,
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
    source: 'user_configured', serverOrigin: null, ownerUserId: null, keyId: null, secretRef: null,
    ...overrides,
  };
}

/** 编排调用封装：通知默认为空实现，只有需要断言通知的用例才传 onNotify。 */
function startAutoEnable(
  input: Omit<Parameters<typeof enableBuiltInRelayOnStartup>[0], "notifyKeysChanged"> & { onNotify?: () => void },
) {
  const { onNotify, ...rest } = input;
  return enableBuiltInRelayOnStartup({ ...rest, notifyKeysChanged: onNotify ?? (() => {}) });
}

test("门禁：本地已有启用中的 Key 时跳过且不消耗一次性机会", async () => {
  const meta = createFakeMeta();
  for (const engine of ["codex", "claude"] as const) {
    const engineKeys = createFakeEngineKeys({ rows: [engineKeyRow({ engine, isActive: true })] });
    let requests = 0;
    let notified = 0;
    const result = await startAutoEnable({
      target: { db: meta.db, engineKeys: engineKeys.repo },
      ensureCredential: async () => { requests += 1; return; },
      onNotify: () => { notified += 1; },
    });
    assert.deepEqual(result, { outcome: "skipped", reason: "active-key-exists" });
    assert.equal(requests, 0);
    assert.equal(notified, 0);
    assert.equal(meta.values.has(BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY), false);
    assert.equal(engineKeys.rows.length, 1);
  }
});

test("门禁：本地已存在内置中转 Codex 行时跳过（含被用户停用的行）", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys({
    rows: [engineKeyRow({ label: BUILT_IN_RELAY_KEY_LABEL, isActive: false, source: 'builtin' })],
  });
  const result = await startAutoEnable({
    target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => {},
  });
  assert.deepEqual(result, { outcome: "skipped", reason: "built-in-key-exists" });
  assert.equal(meta.values.has(BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY), false);
});

test("门禁：一次性机会已消耗时不再尝试", async () => {
  const meta = createFakeMeta();
  meta.values.set(BUILT_IN_RELAY_AUTO_ENABLE_MARKER_KEY, "1");
  const engineKeys = createFakeEngineKeys();
  let requests = 0;
  const result = await startAutoEnable({
    target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => { requests += 1; return; },
  });
  assert.deepEqual(result, { outcome: "skipped", reason: "already-attempted" });
  assert.equal(requests, 0);
});

test("门禁：持久删除意图禁止启动期自动重新启用内置 Key", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys({ nativeFallbackBlocked: true });
  let requests = 0; let notified = 0;
  const result = await startAutoEnable({ target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => { requests += 1; }, onNotify: () => { notified += 1; } });
  assert.deepEqual(result, { outcome: "skipped", reason: "explicitly-disabled" });
  assert.equal(requests, 0); assert.equal(notified, 0); assert.equal(meta.values.size, 0);
});

test("全新账号：可信凭据入口恰调用一次，startup 不再直接写入秘密", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys();
  let requests = 0;
  let notified = 0;
  const target = { db: meta.db, engineKeys: engineKeys.repo };
  const result = await startAutoEnable({
    target,
    ensureCredential: async () => { requests += 1; return; },
    onNotify: () => { notified += 1; },
  });

  assert.deepEqual(result, { outcome: "success", markerPersisted: true });
  assert.equal(requests, 1);
  // 写入成功必须通知 Web 刷新引擎 Key：否则已开着的页面在 Key 落库前评估过就再也收不到信号。
  assert.equal(notified, 1);
  assert.deepEqual(engineKeys.insertedKeys, []);
  assert.equal(hasBuiltInRelayAutoEnableAttempted(target), true);
  assert.equal(engineKeys.activatedIds.length, 0);

  // 同进程再次求值：机会已消耗，不得重复写入。
  const second = await startAutoEnable({ target, ensureCredential: async () => { requests += 1; return; } });
  assert.deepEqual(second, { outcome: "skipped", reason: "already-attempted" });
  assert.equal(requests, 1);
  assert.equal(engineKeys.rows.length, 0);
});

test("自动启用不再通过普通 insert 或 activate 认领内置材料", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys({ insertReturnsInactive: true });
  const result = await startAutoEnable({
    target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => {},
  });
  assert.deepEqual(result, { outcome: "success", markerPersisted: true });
  assert.deepEqual(engineKeys.activatedIds, []);
});

test("签发失败：返回失败、机会已消耗且不重试", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys();
  let requests = 0;
  const target = { db: meta.db, engineKeys: engineKeys.repo };
  const cause = new Error("内置中转 Key 签发失败：HTTP 503 RELAY_DISABLED");
  const result = await startAutoEnable({ target, ensureCredential: async () => { requests += 1; throw cause; } });

  assert.deepEqual(result, {
    outcome: "failed",
    message: "内置中转 Key 自动启用失败",
    markerPersisted: true,
    stage: "ensure", cause,
  });
  assert.equal(engineKeys.rows.length, 0);
  assert.equal(hasBuiltInRelayAutoEnableAttempted(target), true);

  const second = await startAutoEnable({ target, ensureCredential: async () => { requests += 1; return; } });
  assert.deepEqual(second, { outcome: "skipped", reason: "already-attempted" });
  assert.equal(requests, 1);
});

test("标记写失败显式中止，不签发、不通知并保留根因", async () => {
  const meta = createFakeMeta({ writeFails: true });
  const engineKeys = createFakeEngineKeys();
  let requests = 0;
  let notified = 0;
  const target = { db: meta.db, engineKeys: engineKeys.repo };
  const result = await startAutoEnable({
    target,
    ensureCredential: async () => { requests += 1; return; },
    onNotify: () => { notified += 1; },
  });

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") assert.fail("marker failure must be explicit");
  assert.equal(result.markerPersisted, false);
  assert.equal(result.message, "内置中转自动启用标记写入失败");
  assert.equal(result.stage, "marker");
  assert.ok(result.cause instanceof Error);
  assert.equal(result.cause.message, "disk I/O error");
  assert.equal(requests, 0);
  assert.equal(meta.values.size, 0);
  assert.equal(notified, 0);
});

test("门禁读取失败作为独立 Key 失败返回，禁止继续签发和通知", async () => {
  const cause = new Error("isolated gate read failure");
  const meta = createFakeMeta(), engineKeys = createFakeEngineKeys();
  engineKeys.repo.hasActiveKeysForEngine = () => { throw cause; };
  let requests = 0; let notified = 0;
  const result = await startAutoEnable({ target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => { requests += 1; }, onNotify: () => { notified += 1; } });
  assert.deepEqual(result, { outcome: "failed", markerPersisted: false, stage: "gate", message: "内置中转自动启用条件读取失败", cause });
  assert.equal(requests, 0); assert.equal(notified, 0); assert.equal(meta.values.size, 0);
});

test("可信凭据回调已写元数据后只通知，不重复插入或激活", async () => {
  const meta = createFakeMeta();
  const engineKeys = createFakeEngineKeys();
  let notified = 0;
  const result = await startAutoEnable({
    target: { db: meta.db, engineKeys: engineKeys.repo },
    ensureCredential: async () => {
      engineKeys.rows.push(engineKeyRow({ id: "page-key", label: BUILT_IN_RELAY_KEY_LABEL, isActive: true }));
      return;
    },
    onNotify: () => { notified += 1; },
  });

  assert.deepEqual(result, { outcome: "success", markerPersisted: true });
  assert.equal(engineKeys.rows.length, 1);
  assert.deepEqual(engineKeys.insertedKeys, []);
  assert.equal(engineKeys.activatedIds.length, 0);
  assert.equal(notified, 1);
});

test("内置中转行只用可信 source 判断，可编辑 label 不认领旧 Key", () => {
  assert.equal(isBuiltInRelayCodexKeyRow(engineKeyRow({ source: 'builtin', label: 'renamed' })), true);
  assert.equal(isBuiltInRelayCodexKeyRow(engineKeyRow({ label: "CodeFlow 内置中转（Claude）", engine: "claude" })), false);
  assert.equal(isBuiltInRelayCodexKeyRow(engineKeyRow({ label: "内置中转" })), false);
  assert.equal(isBuiltInRelayCodexKeyRow(engineKeyRow({ label: BUILT_IN_RELAY_KEY_LABEL, source: 'unknown' })), false);
  assert.equal(isBuiltInRelayCodexKeyRow(engineKeyRow({ providerId: "anthropic" })), false);
});

test('非桌面旧请求入口保持兼容，桌面不能同时传两套凭据回调', async () => {
  const meta = createFakeMeta(), keys = createFakeEngineKeys();
  const result = await startAutoEnable({ target: { db: meta.db, engineKeys: keys.repo }, requestKey: async () => VALID_KEY });
  assert.deepEqual(result, { outcome: 'success', markerPersisted: true });
  assert.deepEqual(keys.insertedKeys, [VALID_KEY.rawKey]);
  await assert.rejects(startAutoEnable({ target: { db: createFakeMeta().db, engineKeys: createFakeEngineKeys().repo }, requestKey: async () => VALID_KEY, ensureCredential: async () => {} }), /只能指定一个/);
});

test("门禁判定只依赖四项输入，且跳过原因与判定同源", () => {
  const allowed = {
    codexActiveKeyExists: false,
    claudeActiveKeyExists: false,
    builtInRelayKeyExists: false,
    alreadyAttempted: false,
  };
  assert.equal(resolveBuiltInRelayAutoEnableSkipReason(allowed), null);
  assert.equal(resolveBuiltInRelayAutoEnableSkipReason({ ...allowed, alreadyAttempted: true }), "already-attempted");
  assert.equal(resolveBuiltInRelayAutoEnableSkipReason({ ...allowed, claudeActiveKeyExists: true }), "active-key-exists");
  assert.equal(resolveBuiltInRelayAutoEnableSkipReason({ ...allowed, codexActiveKeyExists: true }), "active-key-exists");
  assert.equal(resolveBuiltInRelayAutoEnableSkipReason({ ...allowed, builtInRelayKeyExists: true }), "built-in-key-exists");
});

/** 构造最小 fetch 替身，用于断言请求形状与响应解析。 */
function createFakeFetch(response: { status: number; body: unknown; raw?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => response.raw ?? JSON.stringify(response.body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("签发请求带 Bearer 凭证并解析出新 Key", async () => {
  const fake = createFakeFetch({ status: 200, body: { ok: true, key: VALID_KEY } });
  const result = await requestBuiltInRelayKey({
    httpBase: "https://server.test",
    apiKey: "client-api-key",
    fetchImpl: fake.fetchImpl,
  });

  assert.deepEqual(result, VALID_KEY);
  assert.equal(fake.calls[0]?.url, "https://server.test/api/client/relay/key/ensure");
  assert.equal(fake.calls[0]?.init.method, "POST");
  assert.equal((fake.calls[0]?.init.headers as Record<string, string>).Authorization, "Bearer client-api-key");
});

test("签发失败时显式抛错，错误消息只保留状态码与错误码", async () => {
  const fake = createFakeFetch({ status: 503, body: { ok: false, code: "RELAY_DISABLED", message: "内置中转未启用" } });
  await assert.rejects(
    () => requestBuiltInRelayKey({ httpBase: "https://server.test", apiKey: "k", fetchImpl: fake.fetchImpl }),
    (error: unknown) => {
      assert.match((error as Error).message, /HTTP 503 RELAY_DISABLED/u);
      return true;
    },
  );
});

test("响应缺少必要字段时显式抛错", async () => {
  const fake = createFakeFetch({ status: 200, body: { ok: true, key: { providerId: "openai", rawKey: "", baseUrl: "" } } });
  await assert.rejects(
    () => requestBuiltInRelayKey({ httpBase: "https://server.test", apiKey: "k", fetchImpl: fake.fetchImpl }),
    /缺少必要字段/u,
  );
});

test("非 JSON 响应按失败处理，不把代理错误页当成功", async () => {
  const fake = createFakeFetch({ status: 502, body: null, raw: "<html>bad gateway</html>" });
  await assert.rejects(
    () => requestBuiltInRelayKey({ httpBase: "https://server.test", apiKey: "k", fetchImpl: fake.fetchImpl }),
    /HTTP 502/u,
  );
});
