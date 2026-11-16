import assert from "node:assert/strict";
import test from "node:test";
import { assertValidTimeZone, computeNextCronTimeMs, computeNextCronTimeMsList, parseCronExpression } from "../../packages/shared/src/types/scheduledTasks.js";

const MINUTE = 60_000;
const YEAR_MINUTES = 366 * 24 * 60;

test("时区校验原样抛出未知 Intl 故障，不误报输入无效", t => {
  const original = Intl.DateTimeFormat;
  for (const failure of [new TypeError("Intl unavailable"), null, false, 0]) {
    t.mock.method(Intl, "DateTimeFormat", function () { throw failure; });
    let rejected = false;
    try { assertValidTimeZone("UTC"); }
    catch (error) { rejected = true; assert.equal(error, failure); }
    assert.equal(rejected, true);
    t.mock.restoreAll();
  }
  assert.doesNotThrow(() => assertValidTimeZone("UTC"));
  assert.equal(Intl.DateTimeFormat, original);
});

test("非法时区与输入时间越界有固定错误码，未知扫描 RangeError 不冒充输入错误", t => {
  assert.throws(() => assertValidTimeZone("Invalid/Timezone"), { code: "SCHEDULED_TASK_CRON_TIMEZONE_INVALID" });
  assert.throws(() => computeNextCronTimeMs("* * * * *", 8_640_000_000_000_000, "UTC"),
    { name: "RangeError", code: "SCHEDULED_TASK_CRON_TIME_INVALID" });
  const failure = new RangeError("unexpected scan failure");
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", () => { throw failure; });
  assert.throws(() => computeNextCronTimeMs("* * * * *", 1_800_000_000_000, "UTC"), error => error === failure);
});

/** 保留优化前的分钟扫描，独立比较跳日后的触发时间和无执行点边界。 */
function minuteScan(cron: string, after: number, timezone: string): number {
  const parsed = parseCronExpression(cron);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  let cursor = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < YEAR_MINUTES; i += 1, cursor += MINUTE) {
    const parts = new Map(formatter.formatToParts(cursor).map(part => [part.type, part.value]));
    const month = Number(parts.get("month")), day = Number(parts.get("day"));
    const dow = new Date(Date.UTC(Number(parts.get("year")), month - 1, day)).getUTCDay();
    const domMatch = parsed.dayOfMonth.values.has(day), dowMatch = parsed.dayOfWeek.values.has(dow);
    const dayMatch = parsed.dayOfMonth.any && parsed.dayOfWeek.any ? true : parsed.dayOfMonth.any ? dowMatch
      : parsed.dayOfWeek.any ? domMatch : domMatch || dowMatch;
    if (parsed.minute.values.has(Number(parts.get("minute"))) && parsed.hour.values.has(Number(parts.get("hour")))
      && parsed.month.values.has(month) && dayMatch) return cursor;
  }
  throw new Error("cron 未来一年内没有可执行时间");
}

test("年度计划排除无关日期，不逐分钟格式化全年", (t) => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (this: Intl.DateTimeFormat, value?: number | Date) {
    calls += 1;
    return original.call(this, value);
  });
  assert.equal(computeNextCronTimeMs("0 0 1 1 *", Date.UTC(2026, 0, 2), "UTC"), Date.UTC(2027, 0, 1));
  assert.ok(calls < 5_000, `年度计划格式化次数 ${calls}`);
});

test("没有执行点的计划仍显式失败且不扫描全年分钟", (t) => {
  const original = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  t.mock.method(Intl.DateTimeFormat.prototype, "formatToParts", function (this: Intl.DateTimeFormat, value?: number | Date) {
    calls += 1;
    return original.call(this, value);
  });
  assert.throws(() => computeNextCronTimeMs("0 0 31 2 *", Date.UTC(2026, 0, 2), "UTC"), /未来一年内没有可执行时间/);
  assert.ok(calls < 5_000, `无执行点计划格式化次数 ${calls}`);
});

test("时区跳转和日界保留真实时间轴顺序", () => {
  const cases: Array<[string, string, string, string]> = [
    ["30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York", "2026-11-01T06:30:00Z"],
    ["30 2 * * *", "2026-03-08T00:00:00Z", "America/New_York", "2026-03-09T06:30:00Z"],
    ["45 1 * * *", "2026-04-04T14:45:00Z", "Australia/Lord_Howe", "2026-04-04T15:15:00Z"],
    ["0 0 30 12 *", "2011-12-29T10:00:00Z", "Pacific/Apia", "2012-12-29T10:00:00Z"],
    ["0 0 1 1 *", "2026-01-01T00:00:00Z", "Pacific/Kiritimati", "2026-12-31T10:00:00Z"],
    ["0 0 1 1 *", "2026-01-01T00:00:00Z", "Etc/GMT+12", "2026-01-01T12:00:00Z"],
    ["0 0 1 1 *", "2026-01-01T00:00:00Z", "Asia/Kathmandu", "2026-12-31T18:15:00Z"],
  ];
  for (const [cron, after, timezone, expected] of cases) {
    assert.equal(computeNextCronTimeMs(cron, Date.parse(after), timezone), Date.parse(expected), `${cron} ${timezone}`);
  }
});

test("保留严格下一分钟、日周OR、闰年和366天排他终点", () => {
  assert.equal(computeNextCronTimeMs("* * * * *", Date.UTC(2026, 0, 1, 0, 0, 59, 999), "UTC"), Date.UTC(2026, 0, 1, 0, 1));
  assert.equal(computeNextCronTimeMs("0 0 31 2 1", Date.UTC(2026, 0, 31), "UTC"), Date.UTC(2026, 1, 2));
  assert.equal(computeNextCronTimeMs("0 0 29 2 *", Date.UTC(2027, 2, 1), "UTC"), Date.UTC(2028, 1, 29));
  assert.equal(computeNextCronTimeMs("0 0 1 1 *", Date.UTC(2024, 0, 1), "UTC"), Date.UTC(2025, 0, 1));
  assert.throws(() => computeNextCronTimeMs("0 0 29 2 *", Date.UTC(2028, 1, 29), "UTC"), /未来一年内没有可执行时间/);
  assert.throws(() => computeNextCronTimeMs("0 0 1 1 *", Date.now(), "Invalid/Timezone"), /timezone 无效/);
  assert.throws(() => computeNextCronTimeMs("bad", Date.now(), "UTC"), /五段格式/);
});

test("超出 Date 范围仍保留原 Intl 显式失败", () => {
  assert.throws(() => computeNextCronTimeMs("0 0 31 2 *", 8_640_000_000_000_000, "UTC"), RangeError);
  assert.throws(() => computeNextCronTimeMs("0 0 31 2 *", 1e308, "UTC"), RangeError);
});

test("原分钟扫描差分覆盖稀疏日期及确定性组合", () => {
  const cases: Array<[string, number, string]> = [
    ["0 0 1 1 *", Date.UTC(2026, 0, 2), "UTC"],
    ["0 0 29 2 *", Date.UTC(2027, 2, 1), "Asia/Kathmandu"],
    ["0 0 30 12 *", Date.UTC(2011, 11, 29, 10), "Pacific/Apia"],
    ["0 0 31 2 1", Date.UTC(2026, 0, 31), "America/New_York"],
    ["0 0 * 1 0", Date.UTC(1972, 0, 1), "Africa/Monrovia"],
  ];
  const timezones = ["UTC", "America/New_York", "Australia/Lord_Howe", "Pacific/Kiritimati", "Etc/GMT+12", "Asia/Kathmandu"];
  for (let i = 0; i < 18; i += 1) cases.push([
    `${i % 5},${30 + i % 7} ${i % 24},${(i + 12) % 24} ${1 + i % 28} * ${i % 7}`,
    Date.UTC(2026, i % 12, 1 + i % 20, i % 24, i % 60, 37), timezones[i % timezones.length]!,
  ]);
  for (const [cron, after, timezone] of cases) {
    assert.equal(computeNextCronTimeMs(cron, after, timezone), minuteScan(cron, after, timezone), `${cron} ${timezone}`);
  }
  assert.deepEqual(computeNextCronTimeMsList("0 0 1 1 *", Date.UTC(2026, 0, 2), "UTC", 3),
    [Date.UTC(2027, 0, 1), Date.UTC(2028, 0, 1), Date.UTC(2029, 0, 1)]);
});
