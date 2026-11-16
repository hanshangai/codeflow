import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const needle = ["server", "src", "engine-model-catalog"].join("/");
const scannedRoots = ["src", "scripts", "tests"];
const skippedDirectories = new Set(["node_modules", "dist"]);

/** 递归列出待扫描文本文件，跳过依赖和构建产物目录。 */
function* walk(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) yield* walk(path.join(directory, entry.name));
      continue;
    }
    if (entry.isFile()) yield path.join(directory, entry.name);
  }
}

test("client sources do not reference server engine model catalog sources", () => {
  const hits: string[] = [];
  const self = path.resolve(fileURLToPath(import.meta.url));
  for (const root of scannedRoots) {
    for (const file of walk(path.join(clientDir, root))) {
      if (path.resolve(file) === self) continue;
      if (fs.readFileSync(file, "utf8").includes(needle)) hits.push(path.relative(clientDir, file));
    }
  }
  assert.deepEqual(hits, []);
});
