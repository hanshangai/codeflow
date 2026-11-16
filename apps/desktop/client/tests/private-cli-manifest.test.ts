import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePrivateCliManifest } from "../src/cli-runtime/privateCliManifest.js";
import { readPrivateCliRuntimeEntry, privateCliEngineRoot } from "../src/cli-runtime/privateCliPaths.js";

const manifest = { schemaVersion: 1, npm: { version: "12.2.2" }, engines: {
  claude: { npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", estimatedBytes: 350000000 },
  codex: { npmPackage: "@openai/codex", version: "0.166.0", estimatedBytes: 520000000 },
} };

test("accepts the exact private CLI manifest and rejects unknown keys", () => {
  assert.deepEqual(parsePrivateCliManifest(manifest), manifest);
  assert.throws(() => parsePrivateCliManifest({ ...manifest, extra: true }), /PRIVATE_CLI_MANIFEST_INVALID/u);
  assert.throws(() => parsePrivateCliManifest({ ...manifest, engines: { ...manifest.engines, claude: { ...manifest.engines.claude, version: "latest" } } }),
    /PRIVATE_CLI_MANIFEST_INVALID/u);
});

test("reads runtime.json only when the recorded bin path stays inside the engine root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-entry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const engineRoot = privateCliEngineRoot(root, "codex");
  await fs.mkdir(engineRoot, { recursive: true });
  const entry = { schemaVersion: 1, engine: "codex", npmPackage: "@openai/codex", version: "0.166.0",
    installedAt: "2026-11-05T00:00:00.000Z", verifiedAt: "2026-11-05T00:00:01.000Z",
    binPath: "node_modules/@openai/codex/bin/codex.js" };
  await fs.writeFile(path.join(engineRoot, "runtime.json"), JSON.stringify(entry));
  assert.deepEqual(readPrivateCliRuntimeEntry(root, "codex"), entry);
  await fs.writeFile(path.join(engineRoot, "runtime.json"), JSON.stringify({ ...entry, binPath: "../../escape.js" }));
  assert.throws(() => readPrivateCliRuntimeEntry(root, "codex"), /PRIVATE_CLI_RUNTIME_ENTRY_INVALID/u);
});
