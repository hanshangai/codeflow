import assert from "node:assert/strict";
import test from "node:test";
import { compareNumericVersion, formatDesktopVersion } from "../src/index.js";

test("desktop display combines the actual shell with a dated resource and same-day patch", () => {
  assert.equal(formatDesktopVersion("1.0.0", "2026.11.09.01"), "1.0.1109");
  assert.equal(formatDesktopVersion("1.0.0", "2026.11.09.02"), "1.0.1109.2");
  assert.equal(formatDesktopVersion("2.3.0", "2026.01.02.103"), "2.3.0102.103");
});

test("two-segment shell versions keep the same public display version", () => {
  assert.equal(formatDesktopVersion("1.0", "2026.11.09.01"), "1.0.1109");
  assert.equal(formatDesktopVersion("1.0", "2026.11.09.02"), "1.0.1109.2");
  assert.equal(formatDesktopVersion("2.3", "2026.01.02.103"), "2.3.0102.103");
});

test("four-segment Windows shells keep current and upgrade displays on the actual shell major version", () => {
  assert.equal(formatDesktopVersion("1.0.1117.9", "2026.11.17.09"), "1.0.1117.9");
  assert.equal(formatDesktopVersion("1.0.1117.9", "2026.11.18.01"), "1.0.1118");
  assert.equal(formatDesktopVersion("2.1.1117.9", "2026.11.17.09"), "2.1.1117.9");
  assert.equal(formatDesktopVersion("2.1.1118.1", "2026.11.18.02"), "2.1.1118.2");
  assert.equal(formatDesktopVersion("2.1.1117.9-preview", "2026.11.17.09"), "2.1.1117.9");
});

test("display dates do not replace internal cross-year and legacy comparisons", () => {
  assert.equal(formatDesktopVersion("1.0.0", "2026.12.31.99"), "1.0.1231.99");
  assert.equal(formatDesktopVersion("1.0.0", "2027.01.01.01"), "1.0.0101");
  assert.equal(compareNumericVersion("2027.01.01.01", "2026.12.31.99"), 1);
  assert.equal(compareNumericVersion("2026.11.09.01", "2.3.0"), 1);
});

test("missing and legacy version facts remain truthful instead of inventing a date", () => {
  assert.equal(formatDesktopVersion(null, null), null);
  assert.equal(formatDesktopVersion("1.0.0", null), "1.0.0");
  assert.equal(formatDesktopVersion(null, "2026.11.09.01"), "2026.11.09.01");
  assert.equal(formatDesktopVersion("1.0.0", "2.3.0"), "2.3.0");
  assert.equal(formatDesktopVersion("1.0.0", "2026.02.30.01"), "2026.02.30.01");
  assert.equal(formatDesktopVersion("1.0.0", "2026.11.09.00"), "2026.11.09.00");
  assert.equal(formatDesktopVersion("1.0.1117.9", null), "1.0.1117.9");
  assert.equal(formatDesktopVersion("1.0.1117.9", "legacy-version"), "legacy-version");
  assert.equal(formatDesktopVersion("1.0.1117.9", "2026.02.30.01"), "2026.02.30.01");
  assert.equal(formatDesktopVersion("1.0.1117.9.1", "2026.11.17.09"), "2026.11.17.09");
});
