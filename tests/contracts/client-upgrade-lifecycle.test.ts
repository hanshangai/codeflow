import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runPosixClientUpgrade, ClientUpgradeLifecycleError,
  type ClientUpgradeCommandResult,
} from "../../apps/desktop/client/src/update/clientUpgradeLifecycle.ts";
import { readClientDaemonProcessSnapshot } from "../../apps/desktop/client/src/clientDaemon.ts";

const previous = { running: true, supervisorPid: 100, clientPid: 101 };
const connected = { schemaVersion: 1, connected: true, clientRunning: true, supervisorRunning: true, clientPid: 202, stage: "ready" };
function fixture(options: {
  running?: boolean; installError?: Error; preparationError?: Error; overrides?: Record<string, ClientUpgradeCommandResult>;
} = {}) {
  const calls: string[] = [];
  const invoke = () => runPosixClientUpgrade({
    previous: options.running === false ? { running: false, supervisorPid: null, clientPid: null } : previous,
    expectedVersion: "2026.09.12.04",
    verifyPackage: () => { calls.push("verify-package"); if (options.preparationError) throw options.preparationError; },
    run: args => {
      const command = args.join(" "); calls.push(command);
      assert.notEqual(command, "--status", "不得把就绪检查当作存活检测");
      return options.overrides?.[command] ?? { status: 0,
        stdout: command === "--version" ? "2026.09.12.04\n" : command === "--connected" ? JSON.stringify(connected) : "" };
    },
    install: () => { calls.push("npm"); if (options.installError) throw options.installError; },
  });
  return { calls, invoke };
}

test("旧版无 startup、连接断开或资产受限的运行进程均在安装前停止、安装后重启", () => {
  const f = fixture();
  assert.deepEqual(f.invoke(), { restarted: true, degraded: false });
  assert.deepEqual(f.calls, ["verify-package", "--stop", "npm", "--version", "--daemon", "--connected"]);
});
test("原本没有运行的 Client 只更新和校验版本，不意外启动", () => {
  const f = fixture({ running: false });
  assert.deepEqual(f.invoke(), { restarted: false, degraded: false });
  assert.deepEqual(f.calls, ["verify-package", "npm", "--version"]);
});
test("停止失败禁止 npm 覆盖文件，也不启动第二个 Client", () => {
  const f = fixture({ overrides: { "--stop": { status: 1 } } });
  assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "stop");
  assert.deepEqual(f.calls, ["verify-package", "--stop"]);
});
test("安装失败尝试恢复 Client，恢复成功也必须保留升级失败", () => {
  const cause = new Error("npm failed");
  const f = fixture({ installError: cause });
  assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "install" && error.cause === cause);
  assert.deepEqual(f.calls, ["verify-package", "--stop", "npm", "--daemon"]);
});
test("停机前本地包复核失败，不停止、安装或重启任何 Client", () => {
  const f = fixture({ preparationError: new Error("package changed") });
  assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "prepare");
  assert.deepEqual(f.calls, ["verify-package"]);
});
test("安装与恢复同时失败保留两层根因", () => {
  const f = fixture({ installError: new Error("npm failed"), overrides: { "--daemon": { status: 7 } } });
  assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.recoveryError instanceof Error);
});
test("npm 返回成功但实际版本没有更新不能通过", () => {
  const f = fixture({ overrides: { "--version": { status: 0, stdout: "2026.08.30.01" } } });
  assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "version");
});
test("启动命令失败、超时不能被打印成升级成功", () => {
  for (const result of [{ status: 1 }, { status: null, error: new Error("ETIMEDOUT") }]) {
    const f = fixture({ overrides: { "--daemon": result } });
    assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "restart");
    assert.ok(!f.calls.includes("--connected"));
  }
});
test("实时连接有效但资产受限时保留受限标志，不重新阻断启动", () => {
  const f = fixture({ overrides: { "--connected": { status: 0, stdout: JSON.stringify({ ...connected, stage: "degraded" }) } } });
  assert.deepEqual(f.invoke(), { restarted: true, degraded: true });
});
for (const [name, result] of Object.entries({
  offline: { status: 1, stdout: JSON.stringify(connected) },
  malformed: { status: 0, stdout: "not-json" },
  empty: { status: 0, stdout: "{}" },
  deadWorker: { status: 0, stdout: JSON.stringify({ ...connected, clientRunning: false }) },
  supervisorOnly: { status: 0, stdout: JSON.stringify({ ...connected, clientPid: null }) },
  oldWorker: { status: 0, stdout: JSON.stringify({ ...connected, clientPid: previous.clientPid }) },
  falseConnection: { status: 0, stdout: JSON.stringify({ ...connected, connected: false }) },
  stringConnection: { status: 0, stdout: JSON.stringify({ ...connected, connected: "true" }) },
  incompleteHandshake: { status: 0, stdout: JSON.stringify({ ...connected, stage: "authenticating" }) },
})) {
  test("连接验收拒绝假成功：" + name, () => {
    const f = fixture({ overrides: { "--connected": result } });
    assert.throws(f.invoke, error => error instanceof ClientUpgradeLifecycleError && error.stage === "connection");
  });
}
test("进程快照兼容 legacy/blocked/starting；不依赖 startup 或连接状态", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-upgrade-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  const base = { pid: process.pid, startedAt: new Date().toISOString(), cwd: root, stdoutPath: path.join(root, "out"), stderrPath: path.join(root, "err") };
  assert.deepEqual(readClientDaemonProcessSnapshot(file), { running: false, clientPid: null, supervisorPid: null });
  fs.writeFileSync(file, JSON.stringify(base));
  assert.equal(readClientDaemonProcessSnapshot(file).clientPid, process.pid);
  for (const status of ["running", "blocked", "starting"]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, schemaVersion: 2, supervisorPid: process.pid, clientPid: null, status }));
    assert.deepEqual(readClientDaemonProcessSnapshot(file), { running: true, clientPid: null, supervisorPid: process.pid });
  }
  fs.writeFileSync(file, "{bad");
  assert.throws(() => readClientDaemonProcessSnapshot(file), /无法解析/);
});
test("生产 CLI 在换包之前捕获进程状态，Windows/交互升级也不再调用 --status 判断存活", () => {
  const source = fs.readFileSync(new URL("../../apps/desktop/client/src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /runCurrentClientCommand\(\["--status"\]\)/);
  const update = source.slice(source.indexOf("async function handleClientUpdateCommand()"));
  assert.ok(update.indexOf("await prepareClientUpgradePackage(") < update.indexOf("previous = readClientDaemonProcessSnapshot()"));
  assert.ok(update.indexOf("prepareClientUpgradePrivilege(upgradeCommand)") < update.indexOf("previous = readClientDaemonProcessSnapshot()"));
  assert.ok(update.indexOf("previous = readClientDaemonProcessSnapshot()") < update.indexOf("runPosixClientUpgrade({"));
  assert.match(update, /daemonWasRunning: previous\.running/);
  assert.match(update, /preparedPackage: prepared/);
  assert.match(update, /buildClientOfflineUpgradeCommand\(prepared.archivePath\)/);
  assert.match(update, /finally \{\s+if \(prepared && !packageHandedOff\) await releaseClientUpgradePackage/);
  const prompt = source.slice(source.indexOf("async function checkClientUpdateOrPrompt("), source.indexOf("function formatCliCommand("));
  assert.ok(prompt.indexOf("await prepareClientUpgradePackage(") < prompt.indexOf("const previous = readClientDaemonProcessSnapshot()"));
  assert.match(prompt, /preparedPackage: prepared/);
  assert.match(prompt, /runPosixClientUpgrade\(\{/);
  assert.ok(prompt.indexOf("await releaseClientUpgradePackage(prepared, requestId); prepared = null;") < prompt.indexOf("restartCurrentClientAfterUpdate()"), "交互入口退出前也必须释放包");
});
