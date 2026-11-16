import assert from "node:assert/strict";

export const PERFORMANCE_LIMITS = Object.freeze({ uiActionableMs: 5000, localReadP95Ms: 500 });
const READ_METHODS = ["runtime.info", "workspaces.list"];

/** 原始样本按 nearest-rank 汇总，不改输入，不把缺失或非法值变成零。 */
export function summarizePerformanceSamples(samples) {
  assert.ok(Array.isArray(samples) && samples.length > 0 && [...samples].every(value =>
    typeof value === "number" && Number.isFinite(value) && value >= 0), "DESKTOP_PERF_INVALID_SAMPLES");
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

/** 只接受原三轮完整采样；冷启动与各读取方法分别核预算，摘要不能替代原值。 */
export function assessPerformance(runs) {
  assert.ok(Array.isArray(runs) && runs.length === 3, "DESKTOP_PERF_INVALID_EVIDENCE: runs");
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    assert.ok(run?.attempt === index + 1 && run.profile === (index === 0 ? "fresh" : "reused"),
      "DESKTOP_PERF_INVALID_EVIDENCE: run identity");
    assert.ok(typeof run.uiActionableMs === "number" && Number.isFinite(run.uiActionableMs) && run.uiActionableMs >= 0,
      "DESKTOP_PERF_INVALID_EVIDENCE: UI timing");
    for (const method of READ_METHODS) {
      const samples = run.samples?.[method];
      assert.ok(Array.isArray(samples) && samples.length === 5 && [...samples].every(value =>
        typeof value === "number" && Number.isFinite(value) && value >= 0),
      `DESKTOP_PERF_INVALID_EVIDENCE: ${method} samples`);
    }
  }
  const startup = { attempt: 1, profile: "fresh", uiActionableMs: runs[0].uiActionableMs,
    limitMs: PERFORMANCE_LIMITS.uiActionableMs, passed: runs[0].uiActionableMs <= PERFORMANCE_LIMITS.uiActionableMs };
  const reads = Object.fromEntries(READ_METHODS.map(method => {
    const summary = summarizePerformanceSamples(runs.flatMap(run => run.samples[method]));
    return [method, { ...summary, limitMs: PERFORMANCE_LIMITS.localReadP95Ms, passed: summary.p95 <= PERFORMANCE_LIMITS.localReadP95Ms }];
  }));
  const violations = [];
  if (!startup.passed) violations.push({ metric: "fresh.uiActionableMs", actualMs: startup.uiActionableMs, limitMs: startup.limitMs });
  for (const method of READ_METHODS) {
    if (!reads[method].passed) violations.push({ metric: `${method}.p95`, actualMs: reads[method].p95, limitMs: reads[method].limitMs });
  }
  return { status: violations.length ? "failed" : "passed", limits: PERFORMANCE_LIMITS, startup, reads, violations };
}

/** 沿真实工作区界面验证输入和创建动作，trial 不提交，最后取消；异常由原 smoke 处理。 */
export async function probeWorkspaceUi(page, project) {
  await page.getByRole("button", { name: /^切换工作区(?:，当前 .+)?$/ }).click();
  await page.locator(".ws-compact-panel").getByRole("button", { name: "新建工作区", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建工作区", exact: true });
  const title = dialog.locator('input[name="codeflow-workspace-title"]');
  const directory = dialog.locator('input[name="codeflow-workspace-path"]');
  await title.fill("性能验收");
  await directory.fill(project);
  assert.equal(await title.inputValue(), "性能验收", "DESKTOP_PERF_UI_TITLE_NOT_EDITABLE");
  assert.equal(await directory.inputValue(), project, "DESKTOP_PERF_UI_PATH_NOT_EDITABLE");
  await dialog.getByRole("button", { name: /^创\s*建$/ }).click({ trial: true });
  await dialog.getByRole("button", { name: /^取\s*消$/ }).click();
  await dialog.waitFor({ state: "hidden" });
}
