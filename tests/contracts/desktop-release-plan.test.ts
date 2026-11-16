import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopReleasePlan, readDesktopReleasePlan } from "../../tools/release/desktop-release-plan.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("allocates one shared desktop plan and rejects platform drift", async t => {
  const planDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-plans-"));
  t.after(() => fs.rm(planDir, { recursive: true, force: true }));
  const first = await createDesktopReleasePlan({ root, platforms: ["win32/x64", "darwin/arm64"], keyId: "test-key",
    expiresAt: "2099-01-01T00:00:00.000Z", environment: "test", planDir, allowDirty: true });
  assert.match(first.plan.version, /^\d{4}\.\d{2}\.\d{2}\.\d+$/u);
  assert.equal(first.plan.releaseId, `desktop-${first.plan.version}`);
  assert.ok(Number.isSafeInteger(first.plan.dbSchemaVersion) && first.plan.dbSchemaVersion > 0);
  assert.deepEqual(first.plan.platformSet, ["win32/x64", "darwin/arm64"]);
  assert.equal((await readDesktopReleasePlan({ root, file: first.file, allowDirty: true })).releaseId, first.plan.releaseId);
  const second = await createDesktopReleasePlan({ root, platforms: ["win32/x64"], keyId: "test-key",
    expiresAt: "2099-01-01T00:00:00.000Z", environment: "test", planDir, allowDirty: true });
  assert.notEqual(second.plan.version, first.plan.version);
  await assert.rejects(() => createDesktopReleasePlan({ root, platforms: ["darwin/x64"], keyId: "test-key",
    expiresAt: "2099-01-01T00:00:00.000Z", environment: "test", planDir, allowDirty: true }), /DESKTOP_PLAN_PLATFORMS_INVALID/u);
  await assert.rejects(() => createDesktopReleasePlan({ root, platforms: ["win32/x64", "darwin/arm64"], keyId: "test-key",
    expiresAt: "2099-01-01T00:00:00.000Z", environment: "production", planDir }), /PRODUCTION_ARM64_ONLY_UNSUPPORTED/u);
});
