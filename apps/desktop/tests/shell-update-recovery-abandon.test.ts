import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createShellUpdateAttemptStore, type ShellUpdateAttemptV1 } from "../src/shellUpdateAttempt.js";
import { abandonStalledShellUpdateRecovery, shouldAbandonShellUpdateRecovery, SHELL_RECOVERY_ABANDON_THRESHOLD } from "../src/shellUpdateRecoveryAbandon.js";

const original = { activeShellId: "installation", previousShellId: null, baselineShellId: "installation" };
const candidate = { activeShellId: "shell-2026.11.18.02", previousShellId: "installation", baselineShellId: "installation" };
const accepted = { failures: SHELL_RECOVERY_ABANDON_THRESHOLD, admission: null as unknown, ownerReleased: true,
  launchState: original, originalState: original, aliveRecordedProcess: false };

test("recovery fallback requires the bounded failure count", () => {
  assert.equal(shouldAbandonShellUpdateRecovery({ ...accepted, failures: SHELL_RECOVERY_ABANDON_THRESHOLD - 1 }), false);
  assert.equal(shouldAbandonShellUpdateRecovery(accepted), true);
});

for (const variant of ["admission", "owner", "alive", "candidate", "previous", "baseline"] as const)
test(`recovery fallback refuses ${variant} safety violations`, () => {
  const value = variant === "admission" ? { ...accepted, admission: { main: "committed" } }
    : variant === "owner" ? { ...accepted, ownerReleased: false }
      : variant === "alive" ? { ...accepted, aliveRecordedProcess: true }
        : variant === "candidate" ? { ...accepted, launchState: candidate }
          : variant === "previous" ? { ...accepted, launchState: { ...original, previousShellId: "shell-2026.11.18.02" } }
            : { ...accepted, launchState: { ...original, baselineShellId: "shell-2026.11.18.02" } };
  assert.equal(shouldAbandonShellUpdateRecovery(value), false);
});

test("legacy recovery attempt never bypasses the original gate or changes evidence", async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-recovery-abandon-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const installationDir = path.join(dataDir, "install"), userDataDir = path.join(dataDir, "profile"), sessionDataDir = path.join(dataDir, "session");
  const attempt: ShellUpdateAttemptV1 = { schemaVersion: 1, requestId: "legacy-recovery", revision: 0,
    installationDir, dataDir, userDataDir, sessionDataDir, retriesUsed: 0, phase: "failed", originalState: original,
    candidateState: candidate, target: { shellId: candidate.activeShellId, installerSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64), installerSize: 123 },
    binding: { kind: "installation", baselineShellId: original.baselineShellId,
      health: { protocolVersion: 1, clientVersion: "1", dbSchemaVersion: 1, database: "ready" } } };
  const store = createShellUpdateAttemptStore(dataDir);
  const initial = { ...attempt, phase: "preparing" as const };
  await store.replace(null, initial); attempt.revision = 1; await store.replace(initial, attempt);
  for (const ownerReleased of [false, true]) {
    const result = await abandonStalledShellUpdateRecovery({ dataDir, userDataDir, sessionDataDir,
      executablePath: path.join(installationDir, "shells", "installation", "CodeFlowAI.exe"), pid: 101, parentPid: 1,
      ownerReleased, argv: [], snapshot: async () => { throw new Error("must not query processes"); } });
    assert.equal(result.abandoned, false); assert.deepEqual(await store.read(), attempt);
  }
});

test("missing recovery attempt cannot turn a failed controller into successful ordinary startup", async t => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-recovery-empty-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const result = await abandonStalledShellUpdateRecovery({ dataDir, userDataDir: dataDir, sessionDataDir: dataDir,
    executablePath: path.join(dataDir, "CodeFlowAI.exe"), pid: 101, parentPid: 1, ownerReleased: false, argv: [] });
  assert.equal(result.abandoned, false);
});
