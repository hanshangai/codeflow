import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserUuid } from "../src/utils/browserUuid.js";

test("浏览器请求 ID 优先使用原生 randomUUID", () => {
  let calls = 0;
  const id = createBrowserUuid({
    randomUUID: () => {
      calls += 1;
      return "11111111-1111-4111-8111-111111111111";
    },
  });

  assert.equal(id, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls, 1);
});

test("浏览器请求 ID 在缺少 randomUUID 时生成 UUID v4", () => {
  const id = createBrowserUuid({
    getRandomValues: (bytes) => {
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0);
      return bytes;
    },
  });

  assert.equal(id, "00000000-0000-4000-8000-000000000000");
});

test("浏览器请求 ID 在 Web Crypto 缺失时显式失败", () => {
  assert.throws(
    () => createBrowserUuid(null),
    /当前浏览器不支持安全的随机标识生成/u,
  );
});
