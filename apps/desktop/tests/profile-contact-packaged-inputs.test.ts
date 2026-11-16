import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";

/** 导入本片公开合同，不启动应用、进程枚举或构建。 */
async function driver(): Promise<any> { return import(new URL("./electron-packaged-profile-contact.smoke.mjs", import.meta.url).href); }

/** 构造与已定新handoff一致的最小来源合同，供逐项拒绝反例。 */
function contract(d: any) {
  const overlays = Object.entries(d.PROFILE_CONTACT_INPUTS).map(([name, value]: [string, any]) => ({ name: value.name, source: value.source, sha256: value.sha256, review: name }));
  return { root: "F:/profile-contact-fixture", status: "ready_for_independent_artifact_review", schema: 101,
    sourceContract: { count: 1276, unchangedFromPriorTargets: 1262, overlays: [...overlays, ...Array.from({ length: 10 }, (_, index) => ({ name: `existing-${index}` }))],
      additions: [{ name: "apps/web/src/features/settings/components/desktop-update-panel.vue" }],
      reviewBindings: [...Object.entries(d.PROFILE_CONTACT_INPUTS).map(([name, value]: [string, any]) => ({ name, manifest: value.manifest, manifestSha256: value.manifestSha256, review: value.review, reviewSha256: value.reviewSha256 })), ...["bridge", "page", "key"].map(name => ({ name }))] } };
}

test("新包门槛绑定1276来源、三冻结补片及已审证据，拒绝原12覆盖包和缺失字段", async () => {
  const d = await driver(), handoff = contract(d), digest = "a".repeat(64);
  const review = { verdict: { critical: 0, important: 0, minor: 0, artifactGatePassed: true }, candidate: { root: handoff.root, handoffSha256: digest } };
  d.assertProfileContactReview(handoff, review, digest);
  const origin = d.PROFILE_CONTACT_INPUTS.origin;
  assert.ok(origin, "必须绑定已审config来源");
  const old = structuredClone(handoff); old.sourceContract.unchangedFromPriorTargets = 1263;
  old.sourceContract.overlays = old.sourceContract.overlays.filter((item: any) => item.name !== origin.name);
  old.sourceContract.reviewBindings = old.sourceContract.reviewBindings.filter((item: any) => item.name !== "origin");
  assert.throws(() => d.assertProfileContactReview(old, review, digest));
  const mutations = [
    (h: any) => { h.schema = 100; },
    (h: any) => { h.sourceContract.unchangedFromPriorTargets = 1265; },
    (h: any) => { h.sourceContract.count = 1275; },
    (h: any) => { h.sourceContract.overlays.pop(); },
    (h: any) => { h.sourceContract.overlays[0].sha256 = "b".repeat(64); },
    (h: any) => { h.sourceContract.overlays[1].source = "D:/cf/live-dirty.ts"; },
    (h: any) => { h.sourceContract.reviewBindings[1].reviewSha256 = "b".repeat(64); },
    (h: any) => { h.sourceContract.reviewBindings = []; },
    (h: any) => { h.sourceContract.additions = []; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(handoff); mutate(changed); assert.throws(() => d.assertProfileContactReview(changed, review, digest)); }
  for (const field of ["sha256", "source", "review"] as const) {
    const changed = structuredClone(handoff), item = changed.sourceContract.overlays.find((entry: any) => entry.name === origin.name) as Record<string, unknown>;
    item[field] = field === "sha256" ? "b".repeat(64) : field === "source" ? "D:/cf/live-config.ts" : "page";
    assert.throws(() => d.assertProfileContactReview(changed, review, digest));
  }
  for (const field of ["manifestSha256", "reviewSha256", "manifest", "review"] as const) {
    const changed = structuredClone(handoff), item = changed.sourceContract.reviewBindings.find((entry: any) => entry.name === "origin") as Record<string, unknown>;
    item[field] = field.endsWith("Sha256") ? "b".repeat(64) : "F:/other-origin.json";
    assert.throws(() => d.assertProfileContactReview(changed, review, digest));
  }
  for (const changed of [
    { ...review, verdict: { ...review.verdict, important: 1 } },
    { ...review, verdict: { ...review.verdict, artifactGatePassed: false } },
    { ...review, candidate: { ...review.candidate, handoffSha256: "b".repeat(64) } },
    { ...review, candidate: { ...review.candidate, root: "F:/other" } },
  ]) assert.throws(() => d.assertProfileContactReview(handoff, changed, digest));
});

test("全部handoff摘要逐个验真，拒绝越界路径、缺绑定、字节变更和缺文件", async t => {
  const d = await driver(), root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-contact-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source-plan.json"), "{}");
  const hash = crypto.createHash("sha256").update("{}").digest("hex");
  await d.verifyProfileContactHashes(root, { "source-plan.json": hash }, ["source-plan.json"]);
  for (const hashes of [{}, { "../outside": hash }, { "source-plan.json": "a".repeat(64) }, { missing: hash }]) {
    await assert.rejects(d.verifyProfileContactHashes(root, hashes, ["source-plan.json"]));
  }
});

test("CLI坏模式和多余参数在读取包或创建profile前拒绝", async () => {
  const d = await driver();
  for (const args of [[], ["missing.exe", "out", "handoff", "review", "--unknown"], ["missing.exe", "out", "handoff", "review", "--run", "extra"]]) {
    await assert.rejects(d.runProfileContact(args), /DESKTOP_PROFILE_CONTACT_ARGUMENTS_INVALID/u);
  }
});

test("公共联系方式错误协议请求即使成功也拒绝，报告不保留查询凭据", async () => {
  const d = await driver();
  assert.equal(d.isCodeflowContactRequest("codeflow://desktop/api/public/contact-info?token=PRIVATE"), true);
  for (const url of ["https://example.invalid/api/public/contact-info", "codeflow://desktop/docs", "codeflow://other/api/public/contact-info"]) assert.equal(d.isCodeflowContactRequest(url), false);
  d.assertProfileContactRequests({ forbiddenContact: [], requestFailures: [], rendererErrors: [], consoleErrors: [] });
  for (const field of ["forbiddenContact", "requestFailures", "rendererErrors", "consoleErrors"]) {
    assert.throws(() => d.assertProfileContactRequests({ forbiddenContact: [], requestFailures: [], rendererErrors: [], consoleErrors: [], [field]: [field] }));
  }
  const request = { url: () => "http://user:password@desktop/api/public/contact-info?token=PRIVATE#SECRET", failure: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
    method: () => "GET", resourceType: () => "fetch", isNavigationRequest: () => false, frame: () => ({ url: () => "codeflow://desktop/docs?token=PRIVATE" }) };
  const failed = d.snapshotProfileContactRequestFailure(request);
  assert.deepEqual(failed.url, { protocol: "http:", hostname: "desktop", pathname: "/api/public/contact-info" });
  assert.deepEqual(failed.frame, { status: "available", url: { protocol: "codeflow:", hostname: "desktop", pathname: "/docs" } });
  assert.equal(failed.method, "GET"); assert.equal(failed.resourceType, "fetch"); assert.equal(failed.isNavigationRequest, false);
  assert.equal(failed.errorText, "net::ERR_NAME_NOT_RESOLVED"); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE|SECRET|password|user/u);
  const unreadable = d.snapshotProfileContactRequestFailure({ ...request, frame() { throw new Error("PRIVATE frame unavailable"); } });
  assert.equal(unreadable.frame.status, "read_failed"); assert.match(unreadable.frame.errorSha256, /^[a-f0-9]{64}$/u); assert.doesNotMatch(JSON.stringify(unreadable), /PRIVATE/u);
  const consoleError = d.snapshotProfileContactConsoleError({ text: () => "Failed resource PRIVATE net::ERR_NAME_NOT_RESOLVED",
    location: () => ({ url: request.url(), lineNumber: 2, columnNumber: 3 }) });
  assert.deepEqual(consoleError.errorCodes, ["net::ERR_NAME_NOT_RESOLVED"]); assert.deepEqual(consoleError.location.url, failed.url);
  assert.match(consoleError.textSha256, /^[a-f0-9]{64}$/u); assert.doesNotMatch(JSON.stringify(consoleError), /PRIVATE|SECRET|password|user/u);
});

test("原清理入口保留falsy业务拒绝，副清理错误按原顺序聚合", async () => {
  const d = await driver(), cleanup = new Error("CLEANUP_FAILED"); let cleaned = false;
  await assert.rejects(d.withUpdatePageCleanup(async () => { throw false; }, async () => { cleaned = true; throw cleanup; }),
    error => error instanceof AggregateError && error.errors[0] === false && error.errors[1] === cleanup);
  assert.equal(cleaned, true);
});

test("头像更新沿公开按钮进入并用返回恢复原drawer，工作区创建沿公开表单", async () => {
  const d = await driver(), events: any[] = [];
  const node = (label: string): any => ({
    async click() { events.push(["click", label]); }, async fill(value: string) { events.push(["fill", label, value]); },
    async waitFor(value: any) { events.push(["wait", label, value.state]); },
    getByRole(role: string, options: any) { return node(`${label}/${role}:${options.name}`); },
    getByText(text: string, options: any) { assert.deepEqual(options, { exact: true }); return node(`${label}/text:${text}`); },
    locator(selector: string) { return node(`${label}/${selector}`); },
  });
  const page = { getByRole(role: string, options: any) { assert.notEqual(options.name, "返回", "图标left参与按钮名，精确返回只能定位内部文字"); return node(`${role}:${options.name}`); }, locator(selector: string) { return node(selector); },
    async waitForFunction() { events.push(["ready"]); } };
  await d.openProfileSettings(page);
  await d.openProfileUpdate(page);
  await d.returnToProfileSettings(page);
  await d.createProfileWorkspace(page, "隔离验收", "F:/isolated/project");
  const clicks = events.filter(item => item[0] === "click").map(item => item[1]);
  assert.deepEqual(clicks, ["button:打开个人信息", '.h5-profile-drawer/button:应用更新', ".mobile-page:visible > .mobile-page__header > .mobile-page__back--plain/text:返回", '.h5-profile-drawer/button:/^工作区管理/u', "button:新建工作区", "dialog:新建工作区/button:/^创\\s*建$/u"]);
  assert.deepEqual(events.filter(item => item[0] === "fill"), [["fill", 'dialog:新建工作区/input[name="codeflow-workspace-title"]', "隔离验收"], ["fill", 'dialog:新建工作区/input[name="codeflow-workspace-path"]', "F:/isolated/project"]]);
});

test("晚建真实窗口也固定窄窗，ready后再次核640且restore撤销监听", async () => {
  const d = await driver(), listeners = new Map<string, any>(), sizes: number[][] = [], dialog = { showErrorBox() {} }, original = dialog.showErrorBox;
  const windows: any[] = [], application = { async evaluate(callback: any) { return callback({ app: {
    on(name: string, listener: any) { listeners.set(name, listener); }, removeListener(name: string, listener: any) { assert.equal(listeners.get(name), listener); listeners.delete(name); },
  }, dialog, BrowserWindow: { getAllWindows: () => windows } }); } };
  await d.installProfileContactBoundary(application);
  const window = { setContentSize(width: number, height: number) { sizes.push([width, height]); } }; windows.push(window);
  assert.equal(listeners.size, 1); listeners.get("browser-window-created")(undefined, window);
  let waited = false;
  await d.ensureProfileContactViewport({ async waitForFunction(callback: () => boolean) { assert.match(callback.toString(), /innerWidth === 640/u); waited = true; } }, application);
  assert.equal(waited, true); assert.deepEqual(sizes, [[640, 900], [640, 900]]);
  const boundary = (globalThis as any).__profileContactBoundary; boundary.restore(); delete (globalThis as any).__profileContactBoundary;
  assert.equal(listeners.size, 0); assert.equal(dialog.showErrorBox, original);
});

test("失败证据仅保安全URL和viewport，读取及截图失败均保因", async () => {
  const d = await driver(), evidence: any = {}, root = "F:/isolated/profile", screenshots: any[] = [];
  const page = { url: () => "codeflow://user:secret@desktop/chat?token=PRIVATE#SECRET", async evaluate() { return { width: 1440, height: 900 }; },
    async screenshot(options: any) { screenshots.push(options); } };
  await d.recordProfileContactFailure(page, root, evidence, false);
  assert.deepEqual(evidence.failurePage, { viewport: { width: 1440, height: 900 }, url: { protocol: "codeflow:", hostname: "desktop", pathname: "/chat" } });
  assert.equal(screenshots.length, 1); assert.equal(evidence.failureScreenshot, "failure.png"); assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|SECRET|secret|user/u);
  const original = new Error("ORIGINAL"), read = new Error("PAGE_READ_FAILED"), capture = new Error("SCREENSHOT_FAILED"); let attempted = false;
  await assert.rejects(d.withUpdatePageCleanup(async () => { throw original; }, () => d.recordProfileContactFailure({
    url: page.url, async evaluate() { throw read; }, async screenshot() { attempted = true; throw capture; },
  }, root, {}, true)), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] instanceof AggregateError && error.errors[1].errors[0] === read && error.errors[1].errors[1] === capture);
  assert.equal(attempted, true);
});
