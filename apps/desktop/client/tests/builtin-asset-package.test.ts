import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetDir = path.join(clientDir, "assets", "orchestration-builtin");

/** 读取 Client 自带内置资产清单并校验版本与内容摘要一致；manifest 放在资产目录同级，避免被资产加载器当包解析。 */
function readManifest(): { schemaVersion: number; bundleVersion: number; files: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(clientDir, "assets", "orchestration-builtin.manifest.json"), "utf8"));
}

test("client builtin assets carry a versioned manifest", () => {
  const manifest = readManifest();
  const bytes = fs.readFileSync(path.join(assetDir, "defaultAssetBundle.v1.json"));
  const bundle = JSON.parse(bytes.toString("utf8")) as { bundleVersion: number };

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.bundleVersion, bundle.bundleVersion);
  assert.equal(
    manifest.files["defaultAssetBundle.v1.json"],
    crypto.createHash("sha256").update(bytes).digest("hex"),
  );
});

test("client build and source runtime read client-owned builtin assets", () => {
  const build = fs.readFileSync(path.join(clientDir, "scripts", "build-bundle.mjs"), "utf8");
  const source = fs.readFileSync(path.join(clientDir, "src", "index.ts"), "utf8");

  assert.match(build, /"assets"[\s\S]*"orchestration-builtin"/u);
  assert.doesNotMatch(build, /apps[\/\\]server[\/\\]src[\/\\]orchestration/u);
  assert.match(source, /orchestration-builtin/u);
  assert.doesNotMatch(source, /server[\/\\]src[\/\\]orchestration/u);
});
