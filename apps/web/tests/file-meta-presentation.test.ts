import test from "node:test";
import assert from "node:assert/strict";
import { formatFileSizeLabel, formatMtimeLabel, formatMtimeTitle } from "../src/utils/fileMetaPresentation";

test("formatFileSizeLabel 覆盖 B/KB/MB 分界并对非法输入返回空串", () => {
  assert.equal(formatFileSizeLabel(0), "0 B");
  assert.equal(formatFileSizeLabel(1023), "1023 B");
  assert.equal(formatFileSizeLabel(1024), "1.0 KB");
  assert.equal(formatFileSizeLabel(1024 * 1024 - 1), "1024.0 KB");
  assert.equal(formatFileSizeLabel(1024 * 1024), "1.0 MB");
  assert.equal(formatFileSizeLabel(null), "");
  assert.equal(formatFileSizeLabel(undefined), "");
  assert.equal(formatFileSizeLabel(Number.NaN), "");
});

test("formatMtimeLabel 按今天/今年/跨年切换精度并对非法输入返回空串", () => {
  const now = new Date(2026, 8, 28, 15, 30, 0);
  assert.equal(formatMtimeLabel(new Date(2026, 8, 28, 9, 5, 0).toISOString(), now), "09:05");
  assert.equal(formatMtimeLabel(new Date(2026, 4, 3, 9, 5, 0).toISOString(), now), "05-03");
  assert.equal(formatMtimeLabel(new Date(2025, 11, 31, 23, 59, 0).toISOString(), now), "25-12-31");
  assert.equal(formatMtimeLabel(null, now), "");
  assert.equal(formatMtimeLabel("not-a-date", now), "");
});

test("formatMtimeTitle 输出完整本地时间并对非法输入返回空串", () => {
  assert.equal(formatMtimeTitle(new Date(2026, 0, 2, 3, 4, 5).toISOString()), "2026-01-02 03:04:05");
  assert.equal(formatMtimeTitle(undefined), "");
});
