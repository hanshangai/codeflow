import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeNextReleaseVersion, resolveReleaseVersionBaseline, formatDateVersionPrefix } = require("../../tools/release/release-versioning.cjs");

test("desktop version allocation has no Server dependency and preserves date sequence", () => {
  assert.equal(computeNextReleaseVersion("2026.11.13.07", new Date(2026, 10, 13, 12)), "2026.11.13.08");
  assert.equal(computeNextReleaseVersion("2026.11.12.99", new Date(2026, 10, 13, 12)), "2026.11.13.01");
  assert.equal(computeNextReleaseVersion("2026.11.13.999", new Date(2026, 10, 13, 12)), "2026.11.13.1000");
  assert.equal(formatDateVersionPrefix(new Date(2026, 0, 2, 12)), "2026.01.02");
});

test("version baseline uses numeric sequence rather than string ordering", () => {
  assert.equal(resolveReleaseVersionBaseline("2026.11.13.09", "2026.11.13.100"), "2026.11.13.100");
  assert.equal(resolveReleaseVersionBaseline("2026.11.13.100", "2026.11.13.09"), "2026.11.13.100");
  assert.equal(resolveReleaseVersionBaseline("2026.11.13.01", ""), "2026.11.13.01");
});

test("invalid versions and backwards clocks fail without terminating the caller", () => {
  assert.throws(() => computeNextReleaseVersion("invalid"), /YYYY.MM.DD.NN/);
  assert.throws(() => computeNextReleaseVersion("2026.11.14.01", new Date(2026, 10, 13, 12)), /RELEASE_CLOCK_BEHIND/);
  assert.throws(() => computeNextReleaseVersion("2026.11.13.01", new Date("invalid")), /RELEASE_DATE_INVALID/);
});
