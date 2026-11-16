import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyzeUnifiedDiffPaths } from "../../apps/desktop/client/src/engines/toolFilePaths.ts";

/** 在独立临时目录运行 Git 只读 diff 路径分析。 */
function withWorkspace(run: (workspacePath: string) => void): void {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-diff-paths-"));
  try {
    run(workspacePath);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

test("analyzeUnifiedDiffPaths 支持空格和中文路径", () => {
  withWorkspace((workspacePath) => {
    const result = analyzeUnifiedDiffPaths(workspacePath, [
      'diff --git "a/docs/中文 name.txt" "b/docs/中文 name.txt"',
      '--- "a/docs/中文 name.txt"',
      '+++ "b/docs/中文 name.txt"',
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"));

    assert.deepEqual(result, {
      valid: true,
      paths: ["docs/中文 name.txt"],
      error: null,
    });
  });
});

test("analyzeUnifiedDiffPaths 正反解析 rename 的旧路径和新路径", () => {
  withWorkspace((workspacePath) => {
    const result = analyzeUnifiedDiffPaths(workspacePath, [
      'diff --git "a/old name.txt" "b/新 name.txt"',
      "similarity index 100%",
      "rename from old name.txt",
      "rename to 新 name.txt",
      "",
    ].join("\n"));

    assert.deepEqual(result, {
      valid: true,
      paths: ["old name.txt", "新 name.txt"],
      error: null,
    });
  });
});

test("analyzeUnifiedDiffPaths 接受空 aggregate diff", () => {
  withWorkspace((workspacePath) => {
    assert.deepEqual(analyzeUnifiedDiffPaths(workspacePath, ""), {
      valid: true,
      paths: [],
      error: null,
    });
  });
});

test("analyzeUnifiedDiffPaths 对非法 patch 显式返回 invalid", () => {
  withWorkspace((workspacePath) => {
    const result = analyzeUnifiedDiffPaths(workspacePath, "not a unified diff\n");
    assert.equal(result.valid, false);
    assert.deepEqual(result.paths, []);
    assert.match(String(result.error ?? ""), /Git 正向解析失败/);
  });
});
