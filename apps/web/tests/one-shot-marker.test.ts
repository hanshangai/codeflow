import test from "node:test";
import assert from "node:assert/strict";

import { resolveBuiltInRelayAutoEnableMarkerKey } from "../src/store/builtInRelayAutoEnable.ts";
import {
  DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX,
  resolveDefaultThreadAutoCreateMarkerKey,
} from "../src/store/defaultThreadAutoCreate.ts";
import {
  buildMarkerKey,
  clearOneShotMarkerCache,
  hasOneShotMarker,
  markOneShotMarker,
  safeReadLocalStorage,
  safeWriteLocalStorage,
} from "../src/utils/oneShotMarker.ts";

const RELAY_PREFIX = "codeflowai.relay.auto-enable";

/** 用最小 window 替身驱动 localStorage 分支，返回还原函数。 */
function installFakeWindow(storage: { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void }): () => void {
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  return () => {
    (globalThis as { window?: unknown }).window = original;
  };
}

test("marker keys keep the published format of both one-shot chains", () => {
  const serverWsOrigin = "ws://example.test";
  const userId = "user-1";
  const workspaceId = "client-a:repo";
  const parts = [serverWsOrigin, userId, workspaceId];
  assert.equal(
    buildMarkerKey(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX, parts),
    "codeflowai.default-thread.auto-create::ws%3A%2F%2Fexample.test::user-1::client-a%3Arepo",
  );
  assert.equal(
    buildMarkerKey(RELAY_PREFIX, [...parts, "openai"]),
    "codeflowai.relay.auto-enable::ws%3A%2F%2Fexample.test::user-1::client-a%3Arepo::openai",
  );
  // 两个 store 必须委托到同一实现，否则键格式会再次漂移。
  assert.equal(
    resolveDefaultThreadAutoCreateMarkerKey({ serverWsOrigin, userId, workspaceId }),
    buildMarkerKey(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX, parts),
  );
  assert.equal(
    resolveBuiltInRelayAutoEnableMarkerKey({ serverWsOrigin, userId, workspaceId, providerId: "openai" }),
    buildMarkerKey(RELAY_PREFIX, [...parts, "openai"]),
  );
});

test("marker key requires a prefix and every segment", () => {
  assert.equal(buildMarkerKey("", ["a"]), null);
  assert.equal(buildMarkerKey("   ", ["a"]), null);
  assert.equal(buildMarkerKey("prefix", []), null);
  assert.equal(buildMarkerKey("prefix", ["a", "", "c"]), null);
  assert.equal(buildMarkerKey("prefix", ["a", "   "]), null);
  assert.equal(buildMarkerKey("prefix", ["a", "  b  "]), "prefix::a::b");
});

test("marker read and write use localStorage while memory cache covers broken storage", () => {
  clearOneShotMarkerCache();
  const stored = new Map<string, string>();
  const restore = installFakeWindow({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value); },
  });
  try {
    const key = buildMarkerKey(RELAY_PREFIX, ["ws://example.test", "user-1", "client-a:repo", "openai"]);
    assert.equal(hasOneShotMarker(key), false);
    markOneShotMarker(key);
    assert.equal(stored.get(key ?? ""), "1");
    clearOneShotMarkerCache();
    assert.equal(hasOneShotMarker(key), true);
  } finally {
    restore();
    clearOneShotMarkerCache();
  }
});

test("marker stays consumed when localStorage is unavailable or the write fails", () => {
  clearOneShotMarkerCache();
  const key = buildMarkerKey(RELAY_PREFIX, ["ws://example.test", "user-1", "client-a:repo", "openai"]);
  // 无 window：读写都会抛错，内存集合必须兜住。
  assert.equal(safeReadLocalStorage(key ?? ""), "");
  safeWriteLocalStorage(key ?? "", "1");
  // 只写存储、未经 markOneShotMarker：本条不成立，mark 才是消耗。
  assert.equal(hasOneShotMarker(key), false);
  markOneShotMarker(key);
  assert.equal(hasOneShotMarker(key), true);

  clearOneShotMarkerCache();
  const restore = installFakeWindow({
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("quota exceeded"); },
  });
  try {
    assert.equal(safeReadLocalStorage(key ?? ""), "");
    markOneShotMarker(key);
    assert.equal(hasOneShotMarker(key), true);
  } finally {
    restore();
    clearOneShotMarkerCache();
  }
});

test("clearing the memory cache can be limited to one chain", () => {
  clearOneShotMarkerCache();
  const threadKey = buildMarkerKey(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX, ["ws://example.test", "user-1", "client-a:repo"]);
  const relayKey = buildMarkerKey(RELAY_PREFIX, ["ws://example.test", "user-1", "client-a:repo", "openai"]);
  markOneShotMarker(threadKey);
  markOneShotMarker(relayKey);

  clearOneShotMarkerCache(DEFAULT_THREAD_AUTO_CREATE_STORAGE_PREFIX);
  assert.equal(hasOneShotMarker(threadKey), false);
  assert.equal(hasOneShotMarker(relayKey), true);

  clearOneShotMarkerCache();
  assert.equal(hasOneShotMarker(relayKey), false);
});
