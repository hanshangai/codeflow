import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspacePathReference } from "../../packages/shared/src/index.ts";
import { resolveSubmitPathReferences, type SubmitPathReferenceStat } from "../../apps/web/src/features/composer/path-reference-submit.ts";

/** 构造可观测的 statPath，用于验证普通 @ 文本不会触发路径查询。 */
function createStatSpy(result: SubmitPathReferenceStat): {
  calls: string[];
  statPath: (path: string) => Promise<SubmitPathReferenceStat>;
} {
  const calls: string[] = [];
  return {
    calls,
    statPath: async (path: string) => {
      calls.push(path);
      return result;
    },
  };
}

test("submit path references ignore ordinary @ identifiers", async () => {
  const spy = createStatSpy({ ok: true, exists: false, isDir: false });

  const refs = await resolveSubmitPathReferences({
    text: "@ 引用路径不存在：RateLimiter。从职责边界看，控制器就在 @RateLimiter",
    existingReferences: [],
    statPath: spy.statPath,
  });

  assert.deepEqual(refs, []);
  assert.deepEqual(spy.calls, []);
});

test("submit path references keep selected extensionless paths without stat", async () => {
  const spy = createStatSpy({ ok: true, exists: false, isDir: false });
  const selected = createWorkspacePathReference({ path: "Makefile", kind: "file" });

  const refs = await resolveSubmitPathReferences({
    text: "参考 @Makefile",
    existingReferences: [selected],
    statPath: spy.statPath,
  });

  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.path, "Makefile");
  assert.deepEqual(spy.calls, []);
});

test("submit path references resolve typed path-like mentions when they exist", async () => {
  const spy = createStatSpy({ ok: true, exists: true, isDir: false });

  const refs = await resolveSubmitPathReferences({
    text: "看下 @apps/web/src/main.ts",
    existingReferences: [],
    statPath: spy.statPath,
  });

  assert.deepEqual(spy.calls, ["apps/web/src/main.ts"]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]?.path, "apps/web/src/main.ts");
  assert.equal(refs[0]?.kind, "file");
});

test("submit path references skip missing typed path-like mentions", async () => {
  const spy = createStatSpy({ ok: true, exists: false, isDir: false });

  const refs = await resolveSubmitPathReferences({
    text: "看下 @apps/web/src/not-found.ts",
    existingReferences: [],
    statPath: spy.statPath,
  });

  assert.deepEqual(spy.calls, ["apps/web/src/not-found.ts"]);
  assert.deepEqual(refs, []);
});
