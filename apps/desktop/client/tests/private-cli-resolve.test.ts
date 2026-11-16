import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeCli } from "../src/engines/claude/claudeCli.js";
import { resolveCodexCli } from "../src/engines/codex-app-server/codexAppServerCli.js";
import { privateCliEngineRoot } from "../src/cli-runtime/privateCliPaths.js";

test("resolvers prefer a recorded private runtime and surface a broken private binary", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-cli-resolve-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { CODEFLOWAI_CLI_RUNTIME_ROOT: path.join(root, "cli-runtime") } as NodeJS.ProcessEnv;
  const claudeRoot = privateCliEngineRoot(env.CODEFLOWAI_CLI_RUNTIME_ROOT!, "claude");
  const codexRoot = privateCliEngineRoot(env.CODEFLOWAI_CLI_RUNTIME_ROOT!, "codex");
  await fs.mkdir(claudeRoot, { recursive: true });
  await fs.mkdir(codexRoot, { recursive: true });
  const claudeBin = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  const codexBin = path.join("node_modules", "@openai", "codex", "bin", "codex.js");
  await fs.mkdir(path.dirname(path.join(claudeRoot, claudeBin)), { recursive: true });
  await fs.mkdir(path.dirname(path.join(codexRoot, codexBin)), { recursive: true });
  await fs.writeFile(path.join(claudeRoot, claudeBin), "claude");
  await fs.writeFile(path.join(codexRoot, codexBin), "codex");
  await fs.writeFile(path.join(claudeRoot, "runtime.json"), JSON.stringify({ schemaVersion: 1, engine: "claude",
    npmPackage: "@anthropic-ai/claude-code", version: "2.1.318", installedAt: "2026-11-05T00:00:00.000Z",
    verifiedAt: "2026-11-05T00:00:01.000Z", binPath: claudeBin }));
  await fs.writeFile(path.join(codexRoot, "runtime.json"), JSON.stringify({ schemaVersion: 1, engine: "codex",
    npmPackage: "@openai/codex", version: "0.166.0", installedAt: "2026-11-05T00:00:00.000Z",
    verifiedAt: "2026-11-05T00:00:01.000Z", binPath: codexBin }));
  assert.deepEqual(resolveClaudeCli(env), { command: path.join(claudeRoot, claudeBin), argsPrefix: [], label: "claude (private)" });
  const codex = resolveCodexCli(env);
  assert.equal(codex.command, process.execPath);
  assert.equal(codex.argsPrefix.at(-1), path.join(codexRoot, codexBin));
  assert.equal(codex.label, "codex (private)");
  await fs.rm(path.join(claudeRoot, claudeBin));
  assert.equal(resolveClaudeCli(env).command, path.join(claudeRoot, claudeBin));
  await fs.writeFile(path.join(claudeRoot, "runtime.json"), "{bad");
  assert.throws(() => resolveClaudeCli(env), /PRIVATE_CLI_RUNTIME_ENTRY_INVALID/u);
  assert.equal(resolveClaudeCli({} as NodeJS.ProcessEnv).label, "claude");
});
