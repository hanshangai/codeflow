import test from "node:test";
import assert from "node:assert/strict";

import type { ThreadId, TurnId } from "@codeflowai/shared";

import { SendIdempotencyCache } from "../src/app/sendIdempotencyCache.ts";

const THREAD_A = "thread_a" as ThreadId;
const THREAD_B = "thread_b" as ThreadId;

test("SendIdempotencyCache.lookup: 未记录返回 null", () => {
  const cache = new SendIdempotencyCache(30_000);
  assert.equal(cache.lookup(THREAD_A, "cid-1"), null);
});

test("SendIdempotencyCache.remember + lookup: TTL 内同 thread+cid 命中原 turnId", () => {
  const cache = new SendIdempotencyCache(30_000);
  cache.remember(THREAD_A, "cid-1", "turn_1" as TurnId);
  assert.equal(cache.lookup(THREAD_A, "cid-1"), "turn_1");
});

test("SendIdempotencyCache: 不同 thread 隔离", () => {
  const cache = new SendIdempotencyCache(30_000);
  cache.remember(THREAD_A, "cid-shared", "turn_a" as TurnId);
  assert.equal(cache.lookup(THREAD_A, "cid-shared"), "turn_a");
  assert.equal(cache.lookup(THREAD_B, "cid-shared"), null, "另一 thread 同 cid 不应命中");
});

test("SendIdempotencyCache: TTL 过期后命中变 null", async () => {
  const cache = new SendIdempotencyCache(20); // 20ms TTL
  cache.remember(THREAD_A, "cid-1", "turn_1" as TurnId);
  assert.equal(cache.lookup(THREAD_A, "cid-1"), "turn_1");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(cache.lookup(THREAD_A, "cid-1"), null);
});

test("SendIdempotencyCache: 空 / 空白 cid 直接返回 null + remember 不写入", () => {
  const cache = new SendIdempotencyCache();
  cache.remember(THREAD_A, "", "turn_x" as TurnId);
  cache.remember(THREAD_A, "  ", "turn_y" as TurnId);
  assert.equal(cache.lookup(THREAD_A, ""), null);
  assert.equal(cache.lookup(THREAD_A, "   "), null);
});

test("SendIdempotencyCache: clear 清空全部", () => {
  const cache = new SendIdempotencyCache();
  cache.remember(THREAD_A, "cid-1", "turn_1" as TurnId);
  cache.remember(THREAD_B, "cid-2", "turn_2" as TurnId);
  cache.clear();
  assert.equal(cache.lookup(THREAD_A, "cid-1"), null);
  assert.equal(cache.lookup(THREAD_B, "cid-2"), null);
});
