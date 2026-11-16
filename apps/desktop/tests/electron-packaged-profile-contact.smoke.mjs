import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import diagnostics from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";
import { assertUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import { preflight as preflightProtocol } from "./electron-packaged-protocol.smoke.mjs";
import { assertUpdatePageCapabilities, assertUpdatePageMainErrors, assertUpdatePageOutputPaths, closeAndVerifyUpdatePage,
  createUpdatePageFixture, createUpdatePageProcessOwner, snapshotUpdatePageRequestFailure, withUpdatePageCleanup } from "./electron-packaged-update-page.smoke.mjs";
import { captureAssetProcesses, stopAssetProcesses, safeFailure } from "./electron-real-provider-assets.smoke.mjs";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";
export { withUpdatePageCleanup };

const prefix = "DESKTOP_PROFILE_CONTACT";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
export const PROFILE_CONTACT_INPUTS = Object.freeze({
  profile: Object.freeze({ name: "apps/web/src/features/office-h5/components/H5SettingsPanel.vue",
    source: "F:/cf-desktop-profile-settings-entry-20261103-root/candidate-01/apps/web/src/features/office-h5/components/H5SettingsPanel.vue",
    sha256: "03156edf6db1af8829a0fa1ed74c4479fdf28603a069d1712bd17cdc23b445f1",
    manifest: "F:/cf-desktop-profile-settings-entry-20261103-root/candidate-01.json", manifestSha256: "90e80337cd837a41b688099dd7a7eaaaa66b7954d3dd9f04d4f86ba8c9d5ebc7",
    review: "F:/cf-desktop-profile-settings-entry-review-20261103-independent/report.json", reviewSha256: "cc57d294a091d811c16934e708f0b6164d11d59ec6289e9d1628b6d375d6171f" }),
  contact: Object.freeze({ name: "apps/web/src/composables/siteContactInfo.ts",
    source: "F:/cf-desktop-public-contact-origin-20261103-root/candidate-01/apps/web/src/composables/siteContactInfo.ts",
    sha256: "645a494258046a425947bc30cf4032035b6a83917bd91a652fa6d0c1fcd726d9",
    manifest: "F:/cf-desktop-public-contact-origin-20261103-root/candidate-01.json", manifestSha256: "977eb1308ae828015f6d3712279e791d6674f13eba3f7fff874a2edde72da6b3",
    review: "F:/cf-desktop-public-contact-origin-review-20261103-independent/report.json", reviewSha256: "2887ae1a09ecae166927458ecad03c31f529bed3186b153a876c5403615fc580" }),
  origin: Object.freeze({ name: "apps/web/src/store/config.ts",
    source: "F:/cf-desktop-server-origin-20261103-root/candidate-01/apps/web/src/store/config.ts",
    sha256: "2a33b9c19ded5beb25cfbca42a353e5038df47f9d44ab5c98618f624df74e446",
    manifest: "F:/cf-desktop-server-origin-20261103-root/candidate-01.json", manifestSha256: "9898872cb95bdc2ea677b52c426b7ff7ed300ff7ebd851533d8b1206355be635",
    review: "F:/cf-desktop-server-origin-review-20261103-independent/report.json", reviewSha256: "d3d0e880ff2d6a3d34745dc7158eae0df71ed8cdf53beb6936e95ed44c18b239" }),
});

/** JSON与JSONL均严格UTF-8解码；坏字节、截断或缺文件显式失败。 */
async function readJson(file, lines = false) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
  if (!lines) return JSON.parse(text);
  assert.ok(text.endsWith("\n"), `${prefix}_LOG_TRUNCATED`);
  return text.slice(0, -1).split("\n").map(line => JSON.parse(line));
}

/** 新工件独审和三项原候选必须逐项绑定，缺源头修复的旧包不得沿用。 */
export function assertProfileContactReview(handoff, review, digest) {
  assert.equal(handoff.status, "ready_for_independent_artifact_review"); assert.equal(handoff.schema, 101);
  assert.deepEqual([review.verdict?.critical, review.verdict?.important, review.verdict?.minor], [0, 0, 0]);
  assert.equal(review.verdict.artifactGatePassed, true);
  assert.equal(path.resolve(review.candidate.root), path.resolve(handoff.root)); assert.equal(review.candidate.handoffSha256, digest);
  const contract = handoff.sourceContract;
  assert.equal(contract.count, 1276); assert.equal(contract.unchangedFromPriorTargets, 1262); assert.equal(contract.overlays.length, 13);
  assert.equal(new Set(contract.overlays.map(item => item.name)).size, 13);
  assert.deepEqual(contract.additions.map(item => item.name), ["apps/web/src/features/settings/components/desktop-update-panel.vue"]);
  assert.deepEqual(contract.reviewBindings.map(item => item.name).sort(), ["bridge", "contact", "key", "origin", "page", "profile"]);
  for (const [name, input] of Object.entries(PROFILE_CONTACT_INPUTS)) {
    const overlays = contract.overlays.filter(item => item.name === input.name), bindings = contract.reviewBindings.filter(item => item.name === name);
    assert.equal(overlays.length, 1); assert.equal(bindings.length, 1);
    assert.equal(overlays[0].sha256, input.sha256); assert.equal(path.resolve(overlays[0].source), path.resolve(input.source)); assert.equal(overlays[0].review, name);
    for (const key of ["manifest", "review"]) assert.equal(path.resolve(bindings[0][key]), path.resolve(input[key]));
    for (const key of ["manifestSha256", "reviewSha256"]) assert.equal(bindings[0][key], input[key]);
  }
}

/** 每项摘要核普通文件及真实包内边界；必需绑定缺失同样拒绝。 */
export async function verifyProfileContactHashes(root, hashes, required) {
  assert.ok(hashes && typeof hashes === "object");
  for (const name of required) assert.ok(Object.hasOwn(hashes, name), `${prefix}_HANDOFF_BINDING_MISSING:${name}`);
  for (const [name, digest] of Object.entries(hashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/u);
    const file = path.resolve(root, name), relative = path.relative(root, file);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${prefix}_HANDOFF_PATH_INVALID`);
    assert.equal((await fs.lstat(file)).isFile(), true); assert.equal(await fs.realpath(file), file);
    assert.equal(sha(await fs.readFile(file)), digest, `${prefix}_HANDOFF_BYTES_CHANGED:${name}`);
  }
}

/** 原库存导出仅负责比较，本片补最小只读初始摘要，不跟随链接。 */
async function inventory(directory, base = directory, result = {}) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) await inventory(file, base, result);
    else { assert.equal(entry.isFile(), true); result[path.relative(base, file)] = sha(await fs.readFile(file)); }
  }
  return result;
}

/** 合同、真实来源、全部handoff摘要和签名能力通过后才返回可启动事实。 */
export async function preflightProfileContact(args) {
  const [executable, output, handoffInput, reviewInput, ...extra] = args;
  assert.ok(executable && output && handoffInput && reviewInput && !extra.length, `${prefix}_ARGUMENTS_INVALID`);
  const selected = await preflightProtocol([executable, output]);
  const handoffFile = await fs.realpath(handoffInput), reviewFile = await fs.realpath(reviewInput), packageRoot = path.dirname(handoffFile);
  assertUpdatePageOutputPaths(packageRoot, [selected.root, selected.actualRoot]);
  const bytes = await fs.readFile(handoffFile), handoff = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertProfileContactReview(handoff, await readJson(reviewFile), sha(bytes));
  assert.equal(await fs.realpath(handoff.root), packageRoot); assert.equal(await fs.realpath(handoff.paths.exe), selected.executable);
  await verifyProfileContactHashes(packageRoot, handoff.hashes, ["source-plan.json", "source-inputs.json", "source-candidates.json", "review-gate.json",
    "verification.json", "verification-final.json", "build-payload-verification.json", "archive-verification.json", "reader-verification.json",
    path.relative(packageRoot, selected.executable).replaceAll(path.sep, "/"), path.relative(packageRoot, selected.files.asar).replaceAll(path.sep, "/")]);
  const plan = await readJson(path.join(packageRoot, "source-plan.json"));
  assert.equal(sha(await fs.readFile(path.join(packageRoot, "source-plan.json"))), handoff.sourceContract.sourcePlanSha256);
  assert.equal(plan.sourceCount, 1276); assert.equal(plan.unchangedSourceCount, 1262); assert.equal(plan.sources.length, 1276);
  assert.deepEqual(plan.overlays, handoff.sourceContract.overlays); assert.deepEqual(plan.additions, handoff.sourceContract.additions);
  assert.equal(new Set(plan.sources.map(item => path.resolve(item.target))).size, 1276);
  for (const item of [...plan.overlays, ...plan.additions]) {
    const frozen = path.join(handoff.paths.frozen, item.name), entries = plan.sources.filter(source => path.resolve(source.target) === path.resolve(frozen));
    assert.equal(entries.length, 1); assert.equal(entries[0].sha256, item.sha256); assert.equal(path.resolve(entries[0].source), path.resolve(item.source));
    assert.equal(sha(await fs.readFile(frozen)), item.sha256);
  }
  for (const input of Object.values(PROFILE_CONTACT_INPUTS)) {
    for (const [file, digest] of [[input.source, input.sha256], [input.manifest, input.manifestSha256], [input.review, input.reviewSha256]]) assert.equal(sha(await fs.readFile(file)), digest);
  }
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder"));
  const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar"), chunks = [];
  /** 编译能力取实际签名资源；目录链接及非普通文件均拒绝。 */
  async function readChunks(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await readChunks(file);
      else { assert.equal(entry.isFile(), true); if (entry.name.endsWith(".js")) chunks.push(await fs.readFile(file, "utf8")); }
    }
  }
  await readChunks(path.join(selected.resources, "web"));
  assertUpdatePageCapabilities(asar.extractFile(selected.files.asar, "dist/preload.cjs").toString("utf8"), chunks);
  for (const marker of ["h5-settings", "打开个人信息", "profile-settings"]) assert.ok(chunks.some(chunk => chunk.includes(marker)), `${prefix}_PROFILE_COMPILED_MISSING:${marker}`);
  const trust = assertTrustedReleaseKeys(await readJson(path.join(selected.resources, "release-trust.json")));
  const manifest = verifyReleaseBundleSignature(await readJson(path.join(selected.resources, "baseline-release-manifest.json")), trust, { platform: "win32", arch: "x64", requireFresh: true });
  await verifyReleaseBundlePayload({ directory: selected.resources, manifest, trustedKeys: trust, platform: "win32", arch: "x64", requireFresh: true, requireHeldStartup: true });
  assert.equal(manifest.dbSchemaVersion, 101);
  await assert.rejects(fs.lstat(path.join(selected.resources, "desktop-update.json")), error => error?.code === "ENOENT");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT; assert.ok(systemRoot, `${prefix}_SYSTEMROOT_REQUIRED`);
  return { ...selected, packageRoot, manifest, hashes: await inventory(selected.artifact), auditHashes: { handoff: sha(bytes), review: sha(await fs.readFile(reviewFile)) },
    shell: path.join(systemRoot, "System32/cmd.exe"), consoleHost: path.join(systemRoot, "System32/conhost.exe"),
    PATH: [path.join(systemRoot, "System32/WindowsPowerShell/v1.0"), path.join(systemRoot, "System32"), systemRoot].join(path.delimiter) };
}

/** 即使请求成功也不能把公共API发给本机静态协议。 */
export function isCodeflowContactRequest(input) {
  const url = new URL(input); return url.protocol === "codeflow:" && url.hostname === "desktop" && url.pathname === "/api/public/contact-info";
}

/** URL只投影定位目标所需三项，空console来源显式记null，不保留凭据或查询。 */
function safeUrl(input) {
  if (input === "") return null;
  const url = new URL(input); return { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname };
}

/** 所有失败仍拒绝；frame读取故障显式记失败态及摘要，不能隐藏为正常frame。 */
export function snapshotProfileContactRequestFailure(request) {
  let frame;
  try { frame = { status: "available", url: safeUrl(request.frame().url()) }; }
  catch (error) { frame = { status: "read_failed", errorSha256: sha(String(error instanceof Error ? error.message : error)) }; }
  return { ...snapshotUpdatePageRequestFailure(request), url: safeUrl(request.url()), method: request.method(), resourceType: request.resourceType(), isNavigationRequest: request.isNavigationRequest(), frame };
}

/** console仅留来源、浏览器短错误码与全文摘要，不输出可能带秘密的正文。 */
export function snapshotProfileContactConsoleError(message) {
  const text = message.text(), location = message.location();
  return { textSha256: sha(text), errorCodes: [...new Set(text.match(/\bnet::ERR_[A-Z0-9_]+\b/gu) ?? [])],
    location: { url: safeUrl(location.url), lineNumber: location.lineNumber, columnNumber: location.columnNumber } };
}

/** 所有业务网络、renderer及console错误严格为空，无新增白名单。 */
export function assertProfileContactRequests(evidence) {
  for (const field of ["forbiddenContact", "requestFailures", "rendererErrors", "consoleErrors"]) assert.deepEqual(evidence[field], [], `${prefix}_${field.toUpperCase()}`);
}

/** 沿真实聊天头像打开个人设置；不访问组件或store。 */
export async function openProfileSettings(page) {
  await page.getByRole("button", { name: "打开个人信息", exact: true }).click();
  await page.locator(".h5-profile-drawer").waitFor({ state: "visible" });
}

/** 头像按钮进入原更新页，等待原面板读取完成。 */
export async function openProfileUpdate(page) {
  await page.locator(".h5-profile-drawer").getByRole("button", { name: "应用更新", exact: true }).click();
  const panel = page.locator('section.desktop-update-panel[aria-label="应用更新"]'); await panel.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector('.desktop-update-panel[aria-busy="false"]') !== null); return panel;
}

/** 当前设置页点击返回文字，避开图标参与按钮名，仍冒泡原页面栈回调。 */
export async function returnToProfileSettings(page) {
  await page.locator(".mobile-page:visible > .mobile-page__header > .mobile-page__back--plain").getByText("返回", { exact: true }).click();
  await page.locator(".h5-profile-drawer").waitFor({ state: "visible" });
}

/** 本机工作区只用公开输入和创建按钮，由产品原回调选中并重载。 */
export async function createProfileWorkspace(page, title, project) {
  await page.locator(".h5-profile-drawer").getByRole("button", { name: /^工作区管理/u }).click();
  await page.getByRole("button", { name: "新建工作区", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "新建工作区", exact: true }); await modal.waitFor({ state: "visible" });
  await modal.locator('input[name="codeflow-workspace-title"]').fill(title); await modal.locator('input[name="codeflow-workspace-path"]').fill(project);
  await modal.getByRole("button", { name: /^创\s*建$/u }).click(); await modal.waitFor({ state: "hidden" });
}

/** 只适配native错误框及测试尺寸；晚建窗口沿同一监听，退出时撤销。 */
export async function installProfileContactBoundary(application) {
  await application.evaluate(({ app, dialog, BrowserWindow }) => {
    const errors = [], unexpected = [], original = dialog.showErrorBox;
    dialog.showErrorBox = (title, content) => {
      errors.push({ title, contentSha256: process.getBuiltinModule("node:crypto").createHash("sha256").update(String(content)).digest("hex") });
      if (title !== "CodeFlow 更新失败") unexpected.push("UNEXPECTED_ERROR_DIALOG");
    };
    /** 窗口可能在Client ready后才创建，不能只枚举安装时的现有窗口。 */
    const resize = (_event, window) => window.setContentSize(640, 900);
    app.on("browser-window-created", resize);
    globalThis.__profileContactBoundary = { errors, unexpected,
      /** 只撤销本片监听及错误框呈现，不改变产品状态。 */
      restore() { app.removeListener("browser-window-created", resize); dialog.showErrorBox = original; } };
    for (const window of BrowserWindow.getAllWindows()) resize(undefined, window);
  });
}

/** firstWindow及运行时ready之后重新固定尺寸，真实innerWidth到640才可操作头像。 */
export async function ensureProfileContactViewport(page, application) {
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(640, 900); });
  await page.waitForFunction(() => innerWidth === 640);
}

/** URL只保协议/主机/路径，viewport读真实页面，不记录查询和凭据。 */
async function snapshotPage(page) {
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), url = new URL(page.url());
  return { viewport, url: { protocol: url.protocol, hostname: url.hostname, pathname: url.pathname } };
}

/** 读取失败也尝试截图，两项诊断失败均由原清理聚合器保因。 */
export async function recordProfileContactFailure(page, root, evidence, reopen) {
  await withUpdatePageCleanup(async () => { evidence.failurePage = await snapshotPage(page); }, async () => {
    const name = reopen ? "failure-reopened.png" : "failure.png";
    await page.screenshot({ path: path.join(root, name), fullPage: true, timeout: 5_000 }); evidence.failureScreenshot = name;
  });
}

/** 保留原diag的宽窗docs完整导航→更新→缩窄顺序，不注入I/O或业务桥。 */
async function docsUpdate(page, application) {
  await page.waitForLoadState("networkidle");
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(1440, 900); });
  await page.goto("codeflow://desktop/docs");
  const modal = page.locator('.settings-modal[role="dialog"]'); await modal.waitFor({ state: "visible" });
  await modal.getByRole("tab", { name: "应用更新", exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(640, 900); });
  await page.waitForFunction(() => document.querySelector('.settings-modal__mobile-pane .desktop-update-panel[aria-busy="false"]') !== null);
  return modal;
}

/** 独立profile按真实UI验头像、创建本机工作区和离线Key准入，不保存Key。 */
async function profileScenario(page, application, root, report) {
  await page.waitForLoadState("networkidle"); await page.goto("codeflow://desktop/chat");
  const initialSettings = page.locator('.settings-modal[role="dialog"]'); await initialSettings.waitFor({ state: "visible" });
  await initialSettings.getByRole("button", { name: "Close", exact: true }).click(); await initialSettings.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "打开个人信息", exact: true }).waitFor();
  await openProfileSettings(page);
  await page.locator(".h5-profile-drawer").getByText("服务未连接", { exact: true }).waitFor();
  const key = page.locator(".h5-profile-drawer").getByRole("button", { name: /^模型与密钥/u }); assert.equal(await key.isDisabled(), true);
  const panel = await openProfileUpdate(page);
  assert.match(await panel.innerText(), /更新源尚未配置/u); assert.equal(await panel.getByRole("button", { name: "立即重试", exact: true }).isDisabled(), true);
  await page.locator(".h5-profile-drawer .ant-drawer-content-wrapper").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(root, "profile-update.png"), fullPage: true, animations: "disabled" }); await returnToProfileSettings(page);
  const project = path.join(root, "project"), title = "头像离线入口验收"; await fs.mkdir(project);
  await Promise.all([page.waitForEvent("domcontentloaded"), createProfileWorkspace(page, title, project)]);
  await page.waitForFunction(async () => (await window.codeflowDesktop.getState()).status === "ready");
  await ensureProfileContactViewport(page, application);
  await page.getByRole("button", { name: "打开个人信息", exact: true }).waitFor();
  const response = await page.evaluate(() => window.codeflowDesktop.request({ method: "workspaces.list", body: {} }));
  assert.equal(response.status, 200); assert.equal(response.body.ok, true);
  const matches = response.body.workspaces.filter(item => pathEquivalent(item.path, project));
  assert.equal(matches.length, 1); assert.ok(matches[0].id);
  await openProfileSettings(page);
  await page.locator(".h5-profile-drawer").getByRole("button", { name: /^工作区管理/u }).click();
  const current = page.getByRole("button", { name: `当前工作区：${title}`, exact: true }); await current.waitFor(); assert.equal(await current.getAttribute("aria-pressed"), "true");
  await page.locator(".h5-profile-drawer .ant-drawer-content-wrapper").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(root, "profile-workspace.png"), fullPage: true, animations: "disabled" }); await returnToProfileSettings(page);
  assert.equal(await key.isDisabled(), false); await key.click(); await page.locator(".ek-panel").waitFor({ state: "visible" });
  await page.getByRole("tablist", { name: "模型与密钥内容", exact: true }).waitFor();
  await page.locator(".ek-panel .ant-spin-spinning").waitFor({ state: "hidden" });
  assert.equal(await page.locator(".ek-panel").getByRole("button", { name: /添加 Key$/u }).isDisabled(), false);
  assert.doesNotMatch(await page.locator(".ek-panel").innerText(), /请先连接 Server|本地运行时尚未就绪/u);
  await page.locator(".h5-profile-drawer .ant-drawer-content-wrapper").waitFor({ state: "hidden" });
  await page.screenshot({ path: path.join(root, "profile-key.png"), fullPage: true, animations: "disabled" }); report.workspaceId = matches[0].id; report.offlineKeyEntry = true;
  await assert.rejects(fs.lstat(path.join(root, "runtime/logs/desktop-errors.jsonl")), error => error?.code === "ENOENT");
}

/** 仅比较Windows公开工作区路径，不参与进程身份判定。 */
function pathEquivalent(left, right) { return typeof left === "string" && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase(); }

/** 有源先复现清单失败和docs重载，重启后验证同journal的精确ACK。 */
async function docsScenario(page, application, root, fixture, report, reopen, deviceId) {
  let modal = await docsUpdate(page, application);
  if (!reopen) {
    fixture.armFailure(); await modal.getByRole("button", { name: "立即重试", exact: true }).click();
    await modal.getByText("本次更新检查失败，后续状态查询已停止。", { exact: true }).waitFor();
    await modal.getByRole("button", { name: "Close", exact: true }).click(); await modal.waitFor({ state: "hidden" });
    modal = await docsUpdate(page, application); await modal.getByText("更新检查故障", { exact: true }).waitFor();
  }
  await modal.getByRole("button", { name: "查看诊断", exact: true }).click(); await modal.getByRole("region", { name: "更新诊断", exact: true }).waitFor();
  const diagnostics = await page.evaluate(() => window.codeflowDesktop.getUpdateDiagnostics());
  assert.equal(diagnostics.deviceId, deviceId); assert.equal(diagnostics.failures.length, 1);
  const failure = diagnostics.failures[0]; assertUpdateFailureRecord(failure.record);
  assert.equal(failure.record.deviceId, deviceId); assert.equal(failure.record.phase, "discovery"); assert.equal(failure.reported, reopen);
  assert.deepEqual(failure.record.rootCause, { name: "Error", code: "DESKTOP_RELEASE_MANIFEST_INVALID" });
  if (!reopen) {
    const state = await page.evaluate(() => window.codeflowDesktop.getUpdateState());
    assert.equal(state.updateCheckFailure?.requestId, failure.record.requestId); assert.match(JSON.stringify(state.updateCheckFailure), /DESKTOP_RELEASE_MANIFEST_INVALID/u);
    report.failure = failure.record; report.failureDeviceId = deviceId;
  }
  else {
    assert.deepEqual(failure.record, report.failure); assert.equal(deviceId, report.failureDeviceId);
    assert.equal(fixture.failures.length, 1); assert.deepEqual(fixture.failures[0], report.failure);
  }
  const expected = [failure.record];
  if (reopen) expected.push({ schemaVersion: 1, kind: "ack", errorId: failure.record.errorId, deviceId, payloadSha256: failure.record.payloadSha256 });
  assert.deepEqual(await readJson(path.join(root, "runtime/errors.jsonl"), true), expected);
  assertUpdatePageMainErrors(await readJson(path.join(root, "runtime/logs/desktop-errors.jsonl"), true), deviceId, failure.record.requestId);
  await modal.getByText(`诊断编号：${failure.record.errorId}`, { exact: true }).waitFor(); await page.waitForLoadState("networkidle");
  fixture.assertHealthy(); await page.screenshot({ path: path.join(root, reopen ? "docs-reopened.png" : "docs-reloaded.png"), fullPage: true });
}

/** owner候选由真实child取得，首次capture严格在getState ready之后。 */
async function runProfile(selected, root, fixture, report, reopen = false) {
  const profile = path.join(root, "profile"), env = await isolatedEnvironment(root, { PATH: selected.PATH, ...(fixture ? { CODEFLOWAI_DESKTOP_SERVER_ORIGIN: fixture.origin } : {}) });
  let application, child, owner, page;
  const evidence = { reopen, forbiddenContact: [], requestFailures: [], rendererErrors: [], consoleErrors: [] };
  const channel = diagnostics.channel("child_process"), launchAfter = Date.now();
  /** 启动失败仍保留候选child，后续清理继续走原身份门禁。 */
  const onSpawn = ({ process: spawned }) => {
    const args = spawned.spawnargs?.join(" ").toLowerCase() ?? "";
    if (!args.includes(selected.executable.toLowerCase()) || !args.includes(profile.toLowerCase())) return;
    child = spawned; spawned.stdout?.resume(); spawned.stderr?.resume();
    spawned.once("spawn", () => { owner = createUpdatePageProcessOwner(selected, profile, report.requestId, launchAfter, spawned); });
  };
  return withUpdatePageCleanup(async () => {
    try {
      channel.subscribe(onSpawn);
      try { const launch = await launchPackagedApp({ executablePath: selected.executable, userDataDir: profile, env, cwd: root }); application = launch.application; child = launch.child; owner = createUpdatePageProcessOwner(selected, profile, report.requestId, launchAfter, child); }
      finally { channel.unsubscribe(onSpawn); }
      await installProfileContactBoundary(application); page = await application.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(30_000);
      await page.waitForURL("codeflow://desktop/**");
      await page.waitForFunction(async () => (await window.codeflowDesktop.getState()).status === "ready", undefined, { timeout: 60_000 });
      await ensureProfileContactViewport(page, application); evidence.page = await snapshotPage(page);
      await captureAssetProcesses(owner);
      await page.waitForLoadState("networkidle");
      page.on("request", request => { if (isCodeflowContactRequest(request.url())) evidence.forbiddenContact.push({ pathname: "/api/public/contact-info" }); });
      page.on("requestfailed", request => evidence.requestFailures.push(snapshotProfileContactRequestFailure(request)));
      page.on("pageerror", error => evidence.rendererErrors.push(safeFailure(error)));
      page.on("console", message => { if (message.type() === "error") evidence.consoleErrors.push(snapshotProfileContactConsoleError(message)); });
      const facts = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, executable: process.execPath, userData: app.getPath("userData"), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
      assert.equal(facts.packaged, true); assert.equal(facts.executable, selected.executable); assert.equal(facts.userData, profile);
      assert.equal(facts.preferences.contextIsolation, true); assert.equal(facts.preferences.sandbox, true); assert.equal(facts.preferences.nodeIntegration, false);
      const runtime = await page.evaluate(() => window.codeflowDesktop.getState()); assert.equal(runtime.health.dbSchemaVersion, 101);
      assert.ok(owner.records.some(item => item.pid === runtime.pid), `${prefix}_CLIENT_OWNER_REQUIRED`);
      await page.waitForFunction(async () => { const state = await window.codeflowDesktop.getUpdateState(); return !state.checking && state.operation === "idle"; });
      const state = await page.evaluate(() => window.codeflowDesktop.getUpdateState()); assert.equal(state.transportConfigured, Boolean(fixture));
      if (fixture) await docsScenario(page, application, root, fixture, report, reopen, state.deviceId);
      else await profileScenario(page, application, root, report);
      evidence.dialogs = await application.evaluate(() => ({ errors: globalThis.__profileContactBoundary.errors, unexpected: globalThis.__profileContactBoundary.unexpected }));
      assert.deepEqual(evidence.dialogs.unexpected, []); assert.equal(evidence.dialogs.errors.length, fixture && !reopen ? 1 : 0);
      evidence.deviceId = state.deviceId; evidence.runtimePid = runtime.pid; evidence.page = await snapshotPage(page);
    } catch (error) {
      return await withUpdatePageCleanup(async () => { throw error; }, async () => { if (page) await recordProfileContactFailure(page, root, evidence, reopen); });
    }
  }, async () => {
    channel.unsubscribe(onSpawn);
    try {
      if (application) await withUpdatePageCleanup(async () => {
        assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await captureAssetProcesses(owner);
        await application.evaluate(() => globalThis.__profileContactBoundary.restore());
        const exited = child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise(resolve => child.once("exit", resolve));
        const [, code] = await Promise.all([application.waitForEvent("close", { timeout: 40_000 }), bounded(exited, 40_000, `${prefix}_EXIT_TIMEOUT`),
          page ? page.evaluate(() => { void window.codeflowDesktop.exit(); }) : application.evaluate(({ app }) => app.quit())]);
        assert.equal(code, 0); evidence.exitCode = code;
        await waitUntil(async () => (await captureAssetProcesses(owner)).length === 0, 10_000, `${prefix}_PROCESSES_REMAIN`); evidence.remaining = 0;
      }, async () => { assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await stopAssetProcesses(owner); });
      else if (child) { assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await stopAssetProcesses(owner); }
    } finally {
      report.launches.push(evidence);
      if (owner) report.processes.push(...owner.records.map(item => ({ pid: item.pid, parentPid: item.parentPid, created: item.created, executableSha256: sha(item.executable), commandLineSha256: sha(item.commandLine) })));
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }
    assertProfileContactRequests(evidence);
  });
}

/** 两个profile三次启动串行执行，任一失败保因、中止后续并复核完整工件。 */
export async function runProfileContact(args) {
  const [exe, output, handoff, review, mode, ...extra] = args;
  assert.ok(!extra.length && ["--preflight", "--run"].includes(mode), `${prefix}_ARGUMENTS_INVALID`);
  const selected = await preflightProfileContact([exe, output, handoff, review]);
  if (mode === "--preflight") return { preflight: true, releaseId: selected.manifest.releaseId, hashes: selected.auditHashes };
  await fs.mkdir(selected.root);
  const report = { status: "running", requestId: crypto.randomUUID(), launches: [], processes: [], auditHashes: selected.auditHashes,
    boundary: "真实头像/工作区/Key公开UI，原loopback清单失败/docs重载及启动ACK；仅native错误框呈现适配，无provider/生产" };
  let fixture, failed = false, cause;
  try {
    const profileRoot = path.join(selected.root, "profile-entry"), docsRoot = path.join(selected.root, "docs-failure");
    await fs.mkdir(profileRoot); await runProfile(selected, profileRoot, null, report);
    fixture = await createUpdatePageFixture(); await fs.mkdir(docsRoot);
    await runProfile(selected, docsRoot, fixture, report); await runProfile(selected, docsRoot, fixture, report, true);
    fixture.assertHealthy(); report.http = fixture.requests; report.status = "passed";
  } catch (error) { failed = true; cause = error; report.status = "failed"; }
  try { await closeAndVerifyUpdatePage(fixture, selected.artifact, selected.hashes); report.artifactUnchanged = true; }
  catch (error) { cause = failed ? new AggregateError([cause, error], `${prefix}_RUN_AND_INPUT_FAILED`) : error; failed = true; report.status = "failed"; }
  if (failed) report.error = safeFailure(cause);
  await fs.writeFile(path.join(selected.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (failed) throw cause; return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProfileContact(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
}
