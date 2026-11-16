import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));

for (const flag of ["--upload", "--register", "--apply", "--database-url", "--confirm-production"]) {
  test(`public desktop command rejects remote operation ${flag} before reading a plan`, () => {
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx",
      "tools/release/desktop-release.mjs", "publish", flag, "--plan", "not-a-plan.json"], { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stderr.trim());
    assert.equal(failure.code, "DESKTOP_RELEASE_FAILED");
    assert.match(failure.requestId, /^[a-f0-9-]{36}$/u);
    assert.match(failure.rootCause, /未知参数/u);
    assert.ok(failure.rootCause.includes(flag));
  });
}

test("public desktop command has no installer upload command", () => {
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx",
    "tools/release/desktop-release.mjs", "publish-installer"], { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr.trim()).rootCause, /用法/u);
});

test("retired inline database arguments never expose credentials in failure diagnostics", () => {
  const secret = "fixture-password-must-stay-private";
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx",
    "tools/release/desktop-release.mjs", "publish", `--database-url=postgresql://fixture:${secret}@localhost/test`],
  { cwd: root, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 1);
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes("postgresql://"));
  assert.match(JSON.parse(result.stderr.trim()).rootCause, /--database-url/u);
});
