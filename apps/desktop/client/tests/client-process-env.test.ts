import test from "node:test";
import assert from "node:assert/strict";

import { buildClientChildProcessEnv } from "../src/runtime/clientProcessEnv.js";
import { buildClientRestartEnv } from "../src/clientDaemon.js";
import { runCli } from "../src/app/handlers/engineHandlers.js";

test("ordinary child processes do not inherit desktop lifecycle or Electron Node mode", () => {
  const source = { CODEFLOWAI_DESKTOP_REQUEST_ID: "parent-request", CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION: "88", PATH: "tools", ELECTRON_RUN_AS_NODE: "1" };
  assert.deepEqual(buildClientChildProcessEnv(source), { PATH: "tools" });
  assert.equal(source.CODEFLOWAI_DESKTOP_REQUEST_ID, "parent-request");
  assert.equal(source.ELECTRON_RUN_AS_NODE, "1");
});

test("only the current executable retains inherited Electron Node mode", () => {
  const source = { ELECTRON_RUN_AS_NODE: "1", CODEFLOWAI_DESKTOP_REQUEST_ID: "parent-request" };
  assert.deepEqual(buildClientChildProcessEnv(source, "another-electron"), {});
  assert.deepEqual(buildClientChildProcessEnv(source, process.execPath), { ELECTRON_RUN_AS_NODE: "1" });
  assert.deepEqual(buildClientChildProcessEnv({}, process.execPath), {});
});

test("Client restarts retain Electron Node mode without inheriting desktop ownership", () => {
  assert.deepEqual(buildClientRestartEnv({ ELECTRON_RUN_AS_NODE: "1", CODEFLOWAI_DESKTOP_REQUEST_ID: "parent-request", CODEFLOWAI_DESKTOP_DB_SCHEMA_VERSION: "88" }, 123), {
    ELECTRON_RUN_AS_NODE: "1", CODEFLOWAI_RESTART_PARENT_PID: "123",
  });
});

test("CLI probes preserve Node mode when invoking the current executable", async () => {
  const result = await runCli({
    command: process.execPath,
    args: ["-p", "process.env.ELECTRON_RUN_AS_NODE"],
    timeoutMs: 3000,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  assert.equal(result.ok, true, result.error ?? undefined);
  assert.equal(result.stdout.trim(), "1");
});
