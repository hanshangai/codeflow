import test from "node:test";
import assert from "node:assert/strict";
import { shouldAbandonShellUpdateRecovery, SHELL_RECOVERY_ABANDON_THRESHOLD } from "../src/shellUpdateRecoveryAbandon.js";

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
