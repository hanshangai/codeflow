import fs from "node:fs";

import {
  handleClientDaemonCommand,
  markCurrentClientDaemonInitialConnection,
  markCurrentClientDaemonStartup,
  refreshCurrentClientDaemonState,
  spawnClientDaemonReplacementFromCurrentProcess,
} from "../../apps/desktop/client/src/clientDaemon.ts";
import { CLIENT_PROCESS_EXIT_CODE_BLOCKED } from "../../apps/desktop/client/src/processExitCodes.ts";

if (process.env.CODEFLOWAI_DAEMON_TEST_STOP === "1") {
  const exitCode = await handleClientDaemonCommand({ kind: "daemon", action: "stop" });
  process.exit(exitCode);
}

const startMode = String(process.env.CODEFLOWAI_DAEMON_TEST_START_MODE ?? "").trim();
if (process.env.CODEFLOWAI_DAEMON_CHILD !== "1" && (startMode === "plain" || startMode === "key")) {
  const explicitKey = String(process.env.CODEFLOWAI_DAEMON_TEST_EXPLICIT_KEY ?? "").trim();
  if (startMode === "key" && !explicitKey) throw new Error("missing CODEFLOWAI_DAEMON_TEST_EXPLICIT_KEY");
  const exitCode = await handleClientDaemonCommand(startMode === "key"
    ? { kind: "daemon", action: "start", apiKeyOverride: explicitKey, apiKeyProvided: true }
    : { kind: "daemon", action: "start" });
  process.exit(exitCode);
}

const statusLoops = Number(process.env.CODEFLOWAI_DAEMON_TEST_STATUS_LOOPS ?? 0);
if (Number.isInteger(statusLoops) && statusLoops > 0) {
  const readyPath = String(process.env.CODEFLOWAI_DAEMON_TEST_STATUS_READY_PATH ?? "").trim();
  if (readyPath) fs.writeFileSync(readyPath, "ready", "utf8");
  for (let index = 0; index < statusLoops; index += 1) {
    await handleClientDaemonCommand({ kind: "daemon", action: "status" });
  }
  process.exit(0);
}

await refreshCurrentClientDaemonState();

const counterPath = String(process.env.CODEFLOWAI_DAEMON_TEST_COUNTER_PATH ?? "").trim();
if (!counterPath) throw new Error("missing CODEFLOWAI_DAEMON_TEST_COUNTER_PATH");
const previousAttempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
const attempt = Number.isInteger(previousAttempt) && previousAttempt >= 0 ? previousAttempt + 1 : 1;
fs.writeFileSync(counterPath, String(attempt), "utf8");

const initialConnectionOutcome = String(process.env.CODEFLOWAI_DAEMON_TEST_INITIAL_CONNECTION_OUTCOME ?? "").trim();
if (initialConnectionOutcome === "succeeded" || initialConnectionOutcome === "failed") {
  markCurrentClientDaemonInitialConnection(initialConnectionOutcome);
  if (initialConnectionOutcome === "failed") process.exit(1);
}

const blockedAttempt = Number(process.env.CODEFLOWAI_DAEMON_TEST_BLOCKED_ATTEMPT ?? 0);
if (process.env.CODEFLOWAI_DAEMON_TEST_BLOCKED === "1" || attempt === blockedAttempt) {
  process.exit(CLIENT_PROCESS_EXIT_CODE_BLOCKED);
}

const stayRunning = process.env.CODEFLOWAI_DAEMON_TEST_STAY_RUNNING === "1";
if (!stayRunning && attempt === 1) {
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  process.exit(1);
}

if (initialConnectionOutcome !== "pending") {
  markCurrentClientDaemonInitialConnection("succeeded");
  markCurrentClientDaemonStartup("ready", { clientId: "fixture-client", serverUrl: "ws://127.0.0.1:1/ws/client" });
}

const restartAttempt = Number(process.env.CODEFLOWAI_DAEMON_TEST_RESTART_ATTEMPT ?? 0);
if (attempt === restartAttempt) {
  spawnClientDaemonReplacementFromCurrentProcess();
  process.exit(0);
}

let stopScheduled = false;
const stop = () => {
  if (stopScheduled) return;
  const delayedAttempt = Number(process.env.CODEFLOWAI_DAEMON_TEST_STOP_DELAY_ATTEMPT ?? 0);
  const delayMs = Number(process.env.CODEFLOWAI_DAEMON_TEST_STOP_DELAY_MS ?? 0);
  if (attempt === delayedAttempt && Number.isFinite(delayMs) && delayMs > 0) {
    stopScheduled = true;
    setTimeout(() => process.exit(0), delayMs);
    return;
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1_000);
await new Promise(() => {});
