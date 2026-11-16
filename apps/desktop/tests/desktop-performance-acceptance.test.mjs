import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./electron-packaged-performance.smoke.mjs", import.meta.url), "utf8");

/** 固定三轮原始事实；预期预算与分位数在各测试中独立写明。 */
function runs() {
  return ["fresh", "reused", "reused"].map((profile, index) => ({
    attempt: index + 1, profile, firstWindowMs: 1, bridgeReadyMs: 2, uiActionableMs: 1000,
    samples: { "runtime.info": [1, 2, 3, 4, 5], "workspaces.list": [6, 7, 8, 9, 10] },
  }));
}

/** 延迟载入新能力，使旧脚本 RED 由实际成功/失败行为触发，而非缺模块。 */
function support() {
  return require("./support/desktop-performance-acceptance.mjs");
}

/** 执行原 smoke 的实际终结边界，保留真实 JSON 落盘；仅替代已结束的 Electron/工件边界。 */
async function finish(t, input, { cleanupError, reportWriteFailure = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-perf-gates-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "verification.json");
  if (reportWriteFailure) await fs.mkdir(reportPath);
  const report = { requestId: "offline-performance-test", status: "running", runs: input, artifactBefore: { exe: "frozen" } };
  const processState = { exitCode: 0 };
  let cleanupCalls = 0;
  const start = source.indexOf("  report.summary = Object.fromEntries(");
  assert.ok(start > 0, "actual smoke finalization boundary missing");
  const failureStart = source.indexOf("function failure(error) {");
  const failureEnd = source.indexOf("\n}", failureStart) + 2;
  const failure = vm.compileFunction(`return (${source.slice(failureStart, failureEnd)});`)();
  const legacySummaryStart = source.indexOf("function summarize(samples) {");
  const summarize = legacySummaryStart < 0
    ? samples => support().summarizePerformanceSamples(samples)
    : vm.compileFunction(`return (${source.slice(legacySummaryStart, source.indexOf("\n}", legacySummaryStart) + 2)});`, ["assert"])(assert);
  const execute = vm.compileFunction(`return (async () => { try {\n${source.slice(start)}\n})();`,
    ["assert", "report", "artifactHashes", "executablePath", "cleanup", "failure", "process", "fs", "reportPath", "console", "summarize", "assessPerformance"]);
  await execute(assert, report, async () => ({ exe: "frozen" }), "fixture.exe", async () => {
    cleanupCalls++;
    if (cleanupError) throw cleanupError;
  }, failure, processState, fs, reportPath, { log() {}, error() {} }, summarize,
  inputRuns => support().assessPerformance(inputRuns));
  return { report: JSON.parse(await fs.readFile(reportPath, "utf8")), exitCode: processState.exitCode, cleanupCalls };
}

test("script rejects fresh UI above 5000ms even when bridge and window were ready", async t => {
  const input = runs();
  input[0].uiActionableMs = 5000.01;
  const result = await finish(t, input);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.equal(result.report.acceptance.status, "failed");
  assert.deepEqual(result.report.acceptance.violations, [
    { metric: "fresh.uiActionableMs", actualMs: 5000.01, limitMs: 5000 },
  ]);
  assert.deepEqual(result.report.runs, input);
  assert.deepEqual(result.report.artifactAfter, { exe: "frozen" });
  assert.equal(result.cleanupCalls, 1);
});

for (const method of ["runtime.info", "workspaces.list"]) {
  test(`script rejects ${method} P95 above 500ms without averaging the tail away`, async t => {
    const input = runs();
    input[2].samples[method][4] = 500.01;
    const result = await finish(t, input);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.status, "failed");
    assert.deepEqual(result.report.acceptance.violations, [
      { metric: `${method}.p95`, actualMs: 500.01, limitMs: 500 },
    ]);
    assert.equal(result.report.acceptance.reads[method].count, 15);
    assert.equal(result.report.acceptance.reads[method].p95, 500.01);
  });
}

test("script accepts exact budgets and reports each method from raw samples", async t => {
  const input = runs();
  input[0].uiActionableMs = 5000;
  input[1].uiActionableMs = 6000;
  input[2].samples["workspaces.list"][4] = 500;
  input[0].summary = { "workspaces.list": { p95: 999999 } };
  const result = await finish(t, input);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, "measured");
  assert.equal(result.report.acceptance.status, "passed");
  assert.deepEqual(result.report.acceptance.violations, []);
  assert.equal(result.report.acceptance.startup.uiActionableMs, 5000);
  assert.equal(result.report.acceptance.reads["runtime.info"].p95, 5);
  assert.equal(result.report.acceptance.reads["workspaces.list"].p95, 500);
  assert.equal(result.cleanupCalls, 0);
});

test("script rejects legacy evidence that never proved UI actionable", async t => {
  const input = runs();
  delete input[0].uiActionableMs;
  const result = await finish(t, input);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.status, "failed");
  assert.match(result.report.failure.message, /DESKTOP_PERF_INVALID_EVIDENCE/);
});

test("script preserves budget failure together with cleanup failure", async t => {
  const input = runs();
  input[0].uiActionableMs = 6000;
  const result = await finish(t, input, { cleanupError: new Error("CLEANUP_TEST_FAILURE") });
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.acceptance.status, "failed");
  assert.equal(result.report.failure.message, "DESKTOP_PERF_MEASUREMENT_AND_CLEANUP_FAILED");
  assert.match(result.report.failure.errors[0].message, /DESKTOP_PERF_BUDGET_EXCEEDED/);
  assert.equal(result.report.failure.errors[1].message, "CLEANUP_TEST_FAILURE");
});

test("script propagates report write failure together with the original budget failure", async t => {
  const input = runs();
  input[0].uiActionableMs = 6000;
  await assert.rejects(finish(t, input, { reportWriteFailure: true }), error => {
    assert.equal(error.message, "DESKTOP_PERF_REPORT_WRITE_FAILED");
    assert.match(error.errors[0].message, /DESKTOP_PERF_BUDGET_EXCEEDED/);
    assert.equal(error.errors[1].code, "EISDIR");
    return true;
  });
});

test("nearest-rank P95 keeps the 19th of 20 values and preserves the input", () => {
  const input = [1000, ...Array.from({ length: 19 }, (_, i) => 19 - i)];
  assert.deepEqual(support().summarizePerformanceSamples(input), { count: 20, min: 1, p50: 10, p95: 19, max: 1000 });
  assert.equal(input[0], 1000);
});

test("invalid or incomplete measurements fail explicitly", () => {
  const invalid = [
    input => { input.pop(); },
    input => { input[0].profile = "reused"; },
    input => { input[1].attempt = 1; },
    input => { input[2].samples["runtime.info"].pop(); },
    input => { input[1].samples["workspaces.list"].push(1); },
    input => { input[0].samples["runtime.info"][0] = NaN; },
    input => { input[0].samples["runtime.info"][0] = -1; },
    input => { input[0].samples["workspaces.list"][0] = Infinity; },
    input => { input[0].uiActionableMs = null; },
    input => { input[1].uiActionableMs = "1000"; },
  ];
  for (const mutate of invalid) {
    const input = runs();
    mutate(input);
    assert.throws(() => support().assessPerformance(input), /DESKTOP_PERF_INVALID_EVIDENCE/);
  }
  assert.throws(() => support().summarizePerformanceSamples([]), /DESKTOP_PERF_INVALID/);
});

/** 真实DOM保留首装弹层时序和表单副作用，确认trial与取消不会提交。 */
async function workspacePage(t, { disabled = false, settings = false, settingsDelayMs = 0, closeDisabled = false } = {}) {
  const webRequire = createRequire(new URL("../../web/package.json", import.meta.url));
  const browser = await webRequire("@playwright/test").chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(500);
  await page.setContent(`<button aria-label="切换工作区，当前 既有工作区" onclick="document.querySelector('.ws-compact-panel').hidden=false">工作区</button>
    <div class="ws-compact-panel" hidden><button onclick="document.querySelector('.ws-compact-panel').hidden=true;document.querySelector('dialog').showModal()">新建工作区</button></div>
    <dialog aria-label="新建工作区"><form>
      <input name="codeflow-workspace-title"><input name="codeflow-workspace-path">
      <button type="submit" ${disabled ? "disabled" : ""}>创建</button>
      <button type="button" onclick="document.querySelector('dialog').close()">取消</button>
    </form></dialog>
    ${settings ? `<dialog id="settings" aria-label="设置"><button type="button" aria-label="Close" ${closeDisabled ? "disabled" : ""} onclick="window.settingsDismissals++;document.getElementById('settings').close()">Close</button></dialog>` : ""}
    <script>window.submissions=0;window.settingsDismissals=0;document.querySelector('form').onsubmit=event=>{event.preventDefault();window.submissions++;};
    ${settings ? `setTimeout(()=>document.getElementById('settings').showModal(),${settingsDelayMs});` : ""}</script>`);
  return page;
}

/** 执行原smoke从runtime读取到UI计时的边界，保留真实弹窗、表单和原计时起点。 */
async function probeScriptUi(page, project, attempt, run = {}) {
  const start = source.indexOf('    const runtime = await request(page, "runtime.info");');
  const end = source.indexOf("    const currentId = runtime.response.body.client.clientId;", start);
  assert.ok(start > 0 && end > start, "actual smoke UI timing boundary missing");
  const execute = vm.compileFunction(`return (async () => {\n${source.slice(start, end)}\n})();`,
    ["request", "page", "project", "attempt", "run", "performance", "started", "probeWorkspaceUi", "closeInitialSettings"]);
  await execute(async () => ({}), page, project, attempt, run, performance, performance.now() - 10_000,
    support().probeWorkspaceUi, require("./support/desktop-ui-smoke.mjs").closeInitialSettings);
  return run;
}

test("UI probe opens and edits the real dialog, verifies the create action, then cancels without submitting", async t => {
  const page = await workspacePage(t);
  await support().probeWorkspaceUi(page, "C:/isolated/performance-project");
  assert.equal(await page.evaluate(() => document.querySelector("dialog").open), false);
  assert.equal(await page.evaluate(() => window.submissions), 0);
  assert.equal(await page.locator('input[name="codeflow-workspace-path"]').inputValue(), "C:/isolated/performance-project");
});

test("UI probe fails when the create action is disabled instead of accepting visible controls", async t => {
  const page = await workspacePage(t, { disabled: true });
  await assert.rejects(support().probeWorkspaceUi(page, "C:/isolated/performance-project"), /Timeout/);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("fresh script closes initial settings before probing and preserves launch timing", async t => {
  const page = await workspacePage(t, { settings: true });
  const run = await probeScriptUi(page, "C:/isolated/performance-project", 1);
  assert.equal(await page.evaluate(() => window.settingsDismissals), 1);
  assert.equal(await page.locator("#settings").isVisible(), false);
  assert.equal(await page.evaluate(() => window.submissions), 0);
  assert.ok(run.uiActionableMs >= 10_000);
});

test("fresh script waits for delayed initial settings before workspace navigation", async t => {
  const page = await workspacePage(t, { settings: true, settingsDelayMs: 700 });
  await probeScriptUi(page, "C:/isolated/performance-project", 1);
  assert.equal(await page.evaluate(() => window.settingsDismissals), 1);
  assert.equal(await page.locator("#settings").isVisible(), false);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("reused script probes without expecting an initial settings dialog", { timeout: 5000 }, async t => {
  const page = await workspacePage(t);
  await probeScriptUi(page, "C:/isolated/performance-project", 2);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});

test("disabled initial close fails without recording UI readiness or submitting", async t => {
  const page = await workspacePage(t, { settings: true, closeDisabled: true });
  const run = {};
  await assert.rejects(probeScriptUi(page, "C:/isolated/performance-project", 1, run), /Timeout/);
  assert.equal(run.uiActionableMs, undefined);
  assert.equal(await page.locator("#settings").isVisible(), true);
  assert.equal(await page.evaluate(() => window.submissions), 0);
});
