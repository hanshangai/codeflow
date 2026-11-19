import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { testShellProcess } from "../src/shellSwitchProcess.js";

/** 独占自检父目录，测试只核对该目录内的清理结果。 */
async function fixture(t: test.TestContext) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shell-process-test-")));
  const profiles = path.join(root, "profiles"); await fs.mkdir(profiles);
  t.after(() => fs.rm(root, { recursive: true }));
  return { root, profiles };
}

for (const executable of ["missing", "invalid"] as const) test(`shell self-test explicitly rejects ${executable} executable and removes its own temporary profile`, { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t), executablePath = path.join(f.root, "CodeFlowAI.exe");
  if (executable === "invalid") await fs.writeFile(executablePath, "not a portable executable", "ascii");
  await assert.rejects(testShellProcess({ executablePath, temporaryParentDir: f.profiles, timeoutMs: 5000 }), cause => {
    assert.ok(cause instanceof Error);
    if (executable === "missing") assert.equal((cause as NodeJS.ErrnoException).code, "ENOENT");
    return true;
  });
  assert.deepEqual(await fs.readdir(f.profiles), []);
});

test("packaged shell self-test runs with an isolated temporary profile", {
  skip: process.platform !== "win32" || !process.env.CF_SHELL_SELF_TEST_EXE ? "Set CF_SHELL_SELF_TEST_EXE to an isolated packaged candidate" : false,
}, async t => {
  const f = await fixture(t), executablePath = process.env.CF_SHELL_SELF_TEST_EXE!;
  assert.equal(path.isAbsolute(executablePath), true);
  await testShellProcess({ executablePath, temporaryParentDir: f.profiles, timeoutMs: 30_000 });
  assert.deepEqual(await fs.readdir(f.profiles), []);
});
