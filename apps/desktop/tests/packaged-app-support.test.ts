import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error Test support is native ESM executed under the same Node loader as production.
import { alive, assertPackagedExecutable, bounded, isolatedEnvironment } from "./support/packaged-app.mjs";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("isolated environment drops inherited CodeFlow and Node injection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-packaged-env-"));
  const previous = { CODEFLOWAI_SERVER_WS: process.env.CODEFLOWAI_SERVER_WS, NODE_OPTIONS: process.env.NODE_OPTIONS };
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.CODEFLOWAI_SERVER_WS = "ws://example.invalid/ws/client";
  process.env.NODE_OPTIONS = "--require=injected";

  const env = await isolatedEnvironment(root);
  assert.equal(env.CODEFLOWAI_SERVER_WS, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.CODEFLOWAI_DESKTOP_DATA_DIR, path.join(root, "runtime"));
  assert.equal(env.HOME, path.join(root, "home"));
  await fs.access(env.HOME);
});

test("bounded rejects with the fixed diagnostic code", async () => {
  await assert.rejects(bounded(new Promise(() => {}), 20, "TEST_TIMEOUT"), /TEST_TIMEOUT/);
});

test("alive distinguishes current and exited pids", async () => {
  assert.equal(alive(process.pid), true);
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise(resolve => child.once("close", resolve));
  assert.equal(alive(child.pid), false);
});

test("packaged executable must stay outside the repository", { skip: process.platform !== "win32" }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-packaged-exe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "CodeFlowAI.exe");
  await fs.writeFile(executable, "");
  assert.equal(await assertPackagedExecutable(executable, repositoryRoot), await fs.realpath(executable));
  const textFile = path.join(root, "CodeFlowAI.txt");
  await fs.writeFile(textFile, "");
  await assert.rejects(() => assertPackagedExecutable(textFile, repositoryRoot), /DESKTOP_PACKAGED_EXE_REQUIRED/u);
});
