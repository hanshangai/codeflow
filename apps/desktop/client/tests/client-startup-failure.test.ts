import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("startup HTTP failure keeps the Server request ID in the actual fatal log without response secrets", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-startup-failure-"));
  const server = createServer((_request, response) => {
    response.writeHead(403, { "content-type": "application/json", "x-request-id": "server-startup-request-123" });
    response.end(JSON.stringify({ ok: false, message: "secret-response-sentinel" }));
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CODEFLOWAI_")));
    const child = fork(fileURLToPath(new URL("../src/index.ts", import.meta.url)), ["--foreground"], {
      execArgv: ["--conditions=development", "--import", "tsx"],
      env: { ...env, CODEFLOWAI_API_KEY: "startup-test-key", CODEFLOWAI_SERVER_WS: `ws://127.0.0.1:${address.port}/ws/client`,
        CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(directory, "config.json"), CODEFLOWAI_CLIENT_DB_PATH: path.join(directory, "client.db"),
        CODEFLOWAI_CLIENT_LOG_DIR: path.join(directory, "logs") },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", chunk => { output += chunk; });
    child.stderr!.setEncoding("utf8").on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 15_000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
      assert.equal(exit, 1);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill(); }
    const files = await fs.readdir(path.join(directory, "logs"));
    const logs = (await Promise.all(files.filter(name => name.endsWith(".log")).map(name => fs.readFile(path.join(directory, "logs", name), "utf8")))).join("");
    const entries = logs.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const fatal = entries.find(entry => entry.event?.action === "startup.fatal");
    assert.ok(fatal, "startup failure must be recorded at the actual process boundary");
    assert.equal(fatal.error.code, "CLIENT_DB_STARTUP_API_FAILED");
    assert.equal(fatal.error.requestId, "server-startup-request-123");
    assert.doesNotMatch(logs + output, /secret-response-sentinel|startup-test-key/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
