import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClientRuntime } from "../src/clientRuntime.js";

class FakeChild extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit("spawn")); }
  send(_message: unknown, callback: (error: Error | null) => void) { callback(null); return true; }
}

test("client runtime passes the private CLI runtime contract to the child", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "client-cli-env-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const child = new FakeChild();
  let env: NodeJS.ProcessEnv = {};
  const runtime = createClientRuntime({
    entry: "fixture.cjs", dataDir,
    cliRuntime: { root: path.join(dataDir, "cli-runtime"), npmCliPath: "/resources/npm/bin/npm-cli.js", manifestPath: "/resources/cli-runtime.json" },
    spawn: (_file, _args, options) => { env = options.env; return child as never; },
  });
  await runtime.start();
  assert.equal(env.CODEFLOWAI_CLI_RUNTIME_ROOT, path.join(dataDir, "cli-runtime"));
  assert.equal(env.CODEFLOWAI_CLI_NPM_CLI, "/resources/npm/bin/npm-cli.js");
  assert.equal(env.CODEFLOWAI_CLI_RUNTIME_MANIFEST, "/resources/cli-runtime.json");
  child.emit("exit", 0, null);
});

test("client runtime strips inherited private CLI env when no runtime is configured", async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "client-cli-env-absent-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const keys = ["CODEFLOWAI_CLI_RUNTIME_ROOT", "CODEFLOWAI_CLI_NPM_CLI", "CODEFLOWAI_CLI_RUNTIME_MANIFEST"] as const;
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]])) as Record<string, string | undefined>;
  for (const key of keys) process.env[key] = `/inherited/${key}`;
  try {
    const child = new FakeChild();
    let env: NodeJS.ProcessEnv = {};
    const runtime = createClientRuntime({
      entry: "fixture.cjs", dataDir,
      spawn: (_file, _args, options) => { env = options.env; return child as never; },
    });
    await runtime.start();
    for (const key of keys) assert.equal(key in env, false, `${key} must not leak into the child env`);
    child.emit("exit", 0, null);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
