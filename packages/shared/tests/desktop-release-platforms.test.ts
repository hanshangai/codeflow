import assert from "node:assert/strict";
import test from "node:test";
import { assertDesktopReleasePlatforms, readDesktopReleaseEnvironment } from "../src/desktopReleaseContract.ts";

test("production requires all supported platforms while test accepts actual nonempty subsets", () => {
  const platforms = ["win32/x64", "darwin/x64", "darwin/arm64"];
  assert.equal(readDesktopReleaseEnvironment(undefined), "production");
  assert.equal(readDesktopReleaseEnvironment("test"), "test");
  assert.doesNotThrow(() => assertDesktopReleasePlatforms(platforms, "production"));
  for (const selected of [[platforms[0]], [platforms[2]], platforms.slice(1)]) {
    assert.doesNotThrow(() => assertDesktopReleasePlatforms(selected, "test"));
    assert.throws(() => assertDesktopReleasePlatforms(selected, "production"), /THREE_PLATFORMS_REQUIRED/);
  }
  for (const value of ["", "staging", "TEST", null]) assert.throws(() => readDesktopReleaseEnvironment(value), /ENVIRONMENT_INVALID/);
  const sparse = new Array<string>(3); sparse[0] = "win32/x64"; sparse[2] = "darwin/arm64";
  for (const selected of [[], sparse, ["linux/x64"], ["win32/arm64"], ["win32/x64", "win32/x64"], [...platforms, "win32/x64"]]) {
    assert.throws(() => assertDesktopReleasePlatforms(selected, "test"), /PLATFORMS_INVALID/);
  }
});
