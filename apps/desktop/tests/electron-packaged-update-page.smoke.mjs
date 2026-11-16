import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import diagnostics from "node:diagnostics_channel";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertDesktopDeviceRequestTime, buildDesktopDevicePayload, readDesktopDeviceHeaders, verifyDesktopDeviceSignature } from "@codeflowai/shared/desktop-device-auth";
import { assertUpdateFailureRecord } from "@codeflowai/shared/desktop-update-failure";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";
import { preflight as preflightProtocol } from "./electron-packaged-protocol.smoke.mjs";
import { captureAssetProcesses, stopAssetProcesses, safeFailure } from "./electron-real-provider-assets.smoke.mjs";
import { bounded, isolatedEnvironment, launchPackagedApp, waitUntil } from "./support/packaged-app.mjs";

const prefix = "DESKTOP_UPDATE_PAGE";
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

/** 严格UTF-8读事实，文件缺失或格式错误不作默认成功。 */
async function readJson(file) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file))); }

/** 日志必须是完整UTF-8 JSONL；缺文件、截断或空记录均使验收失败。 */
async function readJsonLines(file) {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
  assert.ok(value.endsWith("\n"), `${prefix}_LOG_TRUNCATED`);
  return value.slice(0, -1).split("\n").map(line => JSON.parse(line));
}

/** 工件独审只接受本次真实handoff及固定来源合同，不兼容旧包。 */
export function assertUpdatePageReview(handoff, review, handoffSha256) {
  assert.deepEqual(Object.fromEntries(["critical", "important", "minor"].map(key => [key, review.verdict?.[key]])), { critical: 0, important: 0, minor: 0 }, `${prefix}_ARTIFACT_REVIEW_FAILED`);
  assert.equal(review.verdict.artifactGatePassed, true, `${prefix}_ARTIFACT_REVIEW_REQUIRED`);
  assert.equal(path.resolve(review.candidate.root), path.resolve(handoff.root), `${prefix}_REVIEW_ROOT_MISMATCH`);
  assert.equal(review.candidate.handoffSha256, handoffSha256, `${prefix}_HANDOFF_REVIEW_MISMATCH`);
  const contract = handoff.sourceContract;
  assert.equal(contract?.count, 1276); assert.equal(contract.unchangedFromPriorTargets, 1265);
  assert.equal(contract.overlays.length, 10);
  assert.deepEqual(contract.additions.map(item => item.name), ["apps/web/src/features/settings/components/desktop-update-panel.vue"]);
}

/** 必须实际包含三个固定IPC和新页面编译产物，旧preload不得启动。 */
export function assertUpdatePageCapabilities(preload, webChunks) {
  for (const marker of ["desktop:getUpdateState", "desktop:checkForUpdates", "desktop:getUpdateDiagnostics"]) assert.ok(preload.includes(marker), `${prefix}_BRIDGE_MISSING:${marker}`);
  assert.ok(webChunks.some(text => text.includes("desktop-update-panel") && text.includes("应用更新") && text.includes("本次更新检查失败")), `${prefix}_PAGE_MISSING`);
}

/** 对请求路径及解析后的真实路径双向核边界，相似目录前缀不算父子。 */
export function assertUpdatePageOutputPaths(packageRoot, evidencePaths) {
  const outside = (parent, target) => {
    const relative = path.relative(parent, target);
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  for (const target of evidencePaths) assert.ok(outside(packageRoot, target) && outside(target, packageRoot), `${prefix}_OUTPUT_PACKAGE_OVERLAP`);
}

/** 核主边界安全投影与独立请求关联；无源裸Error只投影ERROR，业务根因由状态和journal核验。 */
export function assertUpdatePageMainErrors(records, deviceId, updateRequestId) {
  assert.equal(records.length, updateRequestId ? 2 : 1, `${prefix}_MAIN_ERROR_COUNT`);
  const ipc = records.filter(item => item.channel === "desktop:checkForUpdates");
  assert.equal(ipc.length, 1); assert.equal(ipc[0].errorCode, "DESKTOP_UPDATE_CHECK_FAILED");
  assert.equal(ipc[0].deviceId, deviceId); assert.match(ipc[0].requestId, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(ipc[0].causeCodes, ["DESKTOP_UPDATE_CHECK_FAILED", updateRequestId ? "DESKTOP_RELEASE_MANIFEST_INVALID" : "ERROR"]);
  if (updateRequestId) {
    assert.equal(ipc[0].updateRequestId, updateRequestId);
    const original = records.filter(item => item.requestId === updateRequestId);
    assert.equal(original.length, 1); assert.equal(original[0].deviceId, deviceId);
    assert.equal(original[0].errorCode, "DESKTOP_RELEASE_MANIFEST_INVALID");
    assert.deepEqual(original[0].causeCodes, ["DESKTOP_RELEASE_MANIFEST_INVALID"]);
  }
}

/** 任意原始拒绝值均失败；清理副因按业务、清理顺序保留。 */
export async function withUpdatePageCleanup(operation, cleanup) {
  let result, failed = false, cause;
  try { result = await operation(); } catch (error) { failed = true; cause = error; }
  try { await cleanup(); } catch (error) { if (failed) throw new AggregateError([cause, error], `${prefix}_RUN_AND_CLEANUP_FAILED`); throw error; }
  if (failed) throw cause;
  return result;
}

/** 真实签名loopback只实现本片发现/精确错误ACK，未知路由明确失败。 */
export async function createUpdatePageFixture() {
  const requests = [], failures = [], errors = [], keys = new Map(), acceptedFailures = new Map();
  let failNext = false;
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 1024 * 1024, `${prefix}_BODY_LIMIT`); chunks.push(chunk); }
      const bytes = Buffer.concat(chunks), value = bytes.length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : undefined;
      const meta = readDesktopDeviceHeaders(request.rawHeaders), target = new URL(request.url, "http://fixture.invalid");
      assertDesktopDeviceRequestTime(meta.timestamp, Date.now());
      const publicKey = target.pathname === "/api/software/desktop/devices/register" ? value?.publicKeyBase64 : keys.get(meta.deviceId);
      verifyDesktopDeviceSignature(publicKey, buildDesktopDevicePayload({ ...meta, method: request.method, url: request.url, body: bytes }), meta.signature);
      assert.equal(target.search, "", `${prefix}_UNEXPECTED_QUERY`);
      requests.push({ method: request.method, path: target.pathname, requestId: meta.requestId, deviceId: meta.deviceId });
      let result;
      if (request.method === "POST" && target.pathname === "/api/software/desktop/devices/register") {
        assert.equal(value.deviceId, meta.deviceId);
        if (keys.has(meta.deviceId)) assert.equal(keys.get(meta.deviceId), publicKey);
        keys.set(meta.deviceId, publicKey);
        result = { ok: true, deviceId: meta.deviceId, publicKeySha256: sha(Buffer.from(publicKey, "base64")) };
      } else if (request.method === "GET" && ["/api/software/desktop/release-availability", "/api/software/desktop/shell-release-availability"].includes(target.pathname)) {
        const invalid = failNext && target.pathname === "/api/software/desktop/release-availability";
        if (invalid) failNext = false;
        result = { ok: true, available: invalid, deviceId: meta.deviceId, requestId: meta.requestId, ...(invalid ? { manifest: {} } : {}) };
      } else if (request.method === "POST" && target.pathname === "/api/software/desktop/update-failures") {
        assertUpdateFailureRecord(value); assert.equal(value.deviceId, meta.deviceId); assert.equal(value.errorId, meta.requestId);
        if (acceptedFailures.has(value.errorId)) assert.equal(acceptedFailures.get(value.errorId), sha(bytes), `${prefix}_FAILURE_REPLAY_CHANGED`);
        else acceptedFailures.set(value.errorId, sha(bytes));
        failures.push(value);
        result = { ok: true, errorId: value.errorId, deviceId: value.deviceId, payloadSha256: value.payloadSha256 };
      } else throw new Error(`${prefix}_UNEXPECTED_HTTP`);
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result));
    })().catch(error => {
      errors.push(error);
      if (!response.headersSent) { response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, code: `${prefix}_HTTP_FIXTURE_FAILED` })); }
      else response.destroy(error instanceof Error ? error : new Error(`${prefix}_HTTP_FIXTURE_FAILED`));
    });
  });
  server.on("error", error => errors.push(error));
  await new Promise((resolve, reject) => {
    const failure = error => { server.removeListener("listening", listening); reject(error); };
    const listening = () => { server.removeListener("error", failure); resolve(); };
    server.once("error", failure); server.once("listening", listening); server.listen(0, "127.0.0.1");
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, failures,
    /** 只改变下一次资源发现响应，不注入产品内部状态或异常。 */
    armFailure() { failNext = true; },
    /** 所有HTTP/连接错误在场景边界失败，不能靠默认空响应继续。 */
    assertHealthy() { if (errors.length) throw new AggregateError(errors, `${prefix}_FIXTURE_FAILED`); },
    /** 有界关闭本片HTTP服务及空闲连接，不保留监听。 */
    async close() { server.closeIdleConnections(); await bounded(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 5_000, `${prefix}_FIXTURE_CLOSE_TIMEOUT`); },
  };
}

/** 全目录只读摘要核 ordinary files，拒绝链接，供原件前后比对。 */
async function inventory(directory) {
  const result = {};
  /** 只读取当前工件目录内普通文件，不跟随任何链接。 */
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false, `${prefix}_ARTIFACT_LINK`);
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else { assert.equal(entry.isFile(), true); result[path.relative(directory, file)] = sha(await fs.readFile(file)); }
    }
  }
  await walk(directory); return result;
}

/** 关闭失败仍完整复核原工件，双失败按关闭、库存顺序保因。 */
export async function closeAndVerifyUpdatePage(fixture, artifact, expected) {
  await withUpdatePageCleanup(async () => { if (fixture) await fixture.close(); },
    async () => assert.deepEqual(await inventory(artifact), expected));
}

/** 参数/报告/签名/完整来源及编译能力全部只读验证后才允许创建profile。 */
export async function preflightUpdatePage(args) {
  const [executable, output, handoffInput, reviewInput, ...extra] = args;
  assert.ok(handoffInput && reviewInput && !extra.length, `${prefix}_ARGUMENTS_INVALID`);
  const selected = await preflightProtocol([executable, output]);
  const handoffFile = await fs.realpath(handoffInput), reviewFile = await fs.realpath(reviewInput), packageRoot = path.dirname(handoffFile);
  assertUpdatePageOutputPaths(packageRoot, [selected.root, selected.actualRoot]);
  const handoffBytes = await fs.readFile(handoffFile), handoff = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(handoffBytes)), review = await readJson(reviewFile);
  assertUpdatePageReview(handoff, review, sha(handoffBytes));
  assert.equal(await fs.realpath(handoff.root), packageRoot);
  assert.equal(await fs.realpath(handoff.paths.exe), selected.executable);
  for (const [relative, digest] of Object.entries(handoff.hashes)) {
    const file = path.resolve(packageRoot, relative), relativeToRoot = path.relative(packageRoot, file);
    assert.ok(relativeToRoot && !relativeToRoot.startsWith("..") && !path.isAbsolute(relativeToRoot), `${prefix}_HANDOFF_PATH_INVALID`);
    assert.equal(sha(await fs.readFile(file)), digest, `${prefix}_HANDOFF_BYTES_CHANGED`);
  }
  const sourcePlan = await readJson(path.join(packageRoot, "source-plan.json"));
  assert.equal(sourcePlan.sourceCount, 1276);
  const panelSource = path.join(handoff.paths.frozen, "apps/web/src/features/settings/components/desktop-update-panel.vue");
  const panelEntry = sourcePlan.sources.find(item => path.resolve(item.target) === path.resolve(panelSource));
  assert.ok(panelEntry, `${prefix}_SOURCE_PAGE_MISSING`);
  assert.equal(sha(await fs.readFile(panelSource)), panelEntry.sha256);
  const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder"));
  const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");
  const preload = asar.extractFile(selected.files.asar, "dist/preload.cjs").toString("utf8"), chunks = [];
  /** 页面能力取实际签名资源中的编译块，不借用工作区源码。 */
  async function readChunks(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await readChunks(file); else if (entry.name.endsWith(".js")) chunks.push(await fs.readFile(file, "utf8"));
    }
  }
  await readChunks(path.join(selected.resources, "web")); assertUpdatePageCapabilities(preload, chunks);
  const trust = assertTrustedReleaseKeys(await readJson(path.join(selected.resources, "release-trust.json")));
  const manifest = verifyReleaseBundleSignature(await readJson(path.join(selected.resources, "baseline-release-manifest.json")), trust, { platform: "win32", arch: "x64", requireFresh: true });
  await verifyReleaseBundlePayload({ directory: selected.resources, manifest, trustedKeys: trust, platform: "win32", arch: "x64", requireFresh: true, requireHeldStartup: true });
  assert.equal(manifest.dbSchemaVersion, 101);
  await assert.rejects(fs.lstat(path.join(selected.resources, "desktop-update.json")), error => error?.code === "ENOENT");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot, `${prefix}_SYSTEMROOT_REQUIRED`);
  return { ...selected, packageRoot, handoffFile, reviewFile, manifest, trust, shell: path.join(systemRoot, "System32/cmd.exe"), consoleHost: path.join(systemRoot, "System32/conhost.exe"),
    PATH: [path.join(systemRoot, "System32/WindowsPowerShell/v1.0"), path.join(systemRoot, "System32"), systemRoot].join(path.delimiter),
    hashes: await inventory(selected.artifact), auditHashes: { handoff: sha(handoffBytes), review: sha(await fs.readFile(reviewFile)) } };
}

/** 沿宽窗原定时任务入口点更新页签，再缩窄等待同面板重挂；不重载路由或调用组件私有方法。 */
export async function openUpdatePage(page, application) {
  const settings = page.locator('.settings-modal[role="dialog"]');
  await application.evaluate(({ BrowserWindow }, width) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(width, 900); }, 1440);
  await page.waitForFunction(() => innerWidth === 1440);
  const tasks = page.getByRole("button", { name: "定时任务", exact: true });
  await tasks.waitFor({ state: "visible" });
  if (await settings.isVisible()) {
    await settings.getByRole("button", { name: "Close", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
  }
  await tasks.click();
  await settings.waitFor({ state: "visible" });
  await settings.getByRole("tab", { name: "应用更新", exact: true }).click();
  await application.evaluate(({ BrowserWindow }, width) => { for (const window of BrowserWindow.getAllWindows()) window.setContentSize(width, 900); }, 640);
  const panel = page.locator('section.desktop-update-panel[aria-label="应用更新"]');
  await panel.waitFor({ state: "visible" });
  await page.waitForFunction(() => innerWidth === 640 && document.querySelector('.settings-modal__mobile-pane .desktop-update-panel[aria-busy="false"]') !== null);
  return panel;
}

/** 请求失败只留本机资源路径和网络短码；未知正文保摘要，所有失败仍由验收明确拒绝。 */
export function snapshotUpdatePageRequestFailure(request) {
  const url = new URL(request.url()), errorText = request.failure()?.errorText;
  const pathname = url.protocol === "codeflow:" && url.hostname === "desktop" ? url.pathname : null;
  return { pathname, ...(typeof errorText === "string" && /^net::[A-Z0-9_]+$/u.test(errorText)
    ? { errorText } : { errorText: "UNCLASSIFIED_REQUEST_FAILURE", errorTextSha256: sha(String(errorText)) }) };
}

/** 固定宽度先于实际页面挂载；dialog适配仅记录呈现摘要，不改变失败链。 */
async function installWindowBoundary(application) {
  await application.evaluate(({ app, BrowserWindow, dialog }) => {
    const hash = value => process.getBuiltinModule("node:crypto").createHash("sha256").update(String(value)).digest("hex");
    const errors = [], unexpected = [];
    const originalError = dialog.showErrorBox, originalMessage = dialog.showMessageBox;
    dialog.showErrorBox = (title, content) => {
      errors.push({ title, contentSha256: hash(content) });
      if (!["CodeFlow 更新失败", "CodeFlow 操作失败"].includes(title)) unexpected.push("UNEXPECTED_ERROR_DIALOG");
    };
    dialog.showMessageBox = async () => { unexpected.push("UNEXPECTED_CONFIRMATION_DIALOG"); throw new Error("UNEXPECTED_CONFIRMATION_DIALOG"); };
    /** 新窗口在加载页面前固定窄窗，已存在窗口沿相同尺寸。 */
    const resize = (_event, window) => window.setContentSize(640, 900);
    app.on("browser-window-created", resize);
    globalThis.__updatePageBoundary = { errors, unexpected,
      /** 只撤销本片呈现适配及监听，不调用产品操作。 */
      restore() {
        app.removeListener("browser-window-created", resize); dialog.showErrorBox = originalError; dialog.showMessageBox = originalMessage;
      } };
    for (const window of BrowserWindow.getAllWindows()) resize(undefined, window);
  });
}

/** 返回child的PID只作为候选根，真实身份仍由原captureAssetProcesses逐项确认。 */
export function createUpdatePageProcessOwner(selected, profile, requestId, launchAfter, child) {
  assert.ok(Number.isSafeInteger(child?.pid) && child.pid > 0, `${prefix}_LAUNCH_PID_REQUIRED`);
  return { requestId, anchorPid: child.pid, observerPid: process.pid, launchAfter, executable: selected.executable,
    clientFile: selected.files.client, shell: selected.shell, consoleHost: selected.consoleHost, profile, records: [] };
}

/** 返回PID仅建候选owner，页面ready后沿原门禁核归属；失败清理仍严格核身份。 */
async function runProfile(selected, root, fixture, report, reopen = false) {
  const profile = path.join(root, "profile"), env = await isolatedEnvironment(root, { PATH: selected.PATH, ...(fixture ? { CODEFLOWAI_DESKTOP_SERVER_ORIGIN: fixture.origin } : {}) });
  let application, page, child, owner, boundaryResult;
  const requestFailures = [];
  const channel = diagnostics.channel("child_process"), launchAfter = Date.now();
  const onSpawn = ({ process: spawned }) => {
    const args = spawned.spawnargs?.join(" ").toLowerCase() ?? "";
    if (!args.includes(selected.executable.toLowerCase()) || !args.includes(profile.toLowerCase())) return;
    child = spawned; spawned.stdout?.resume(); spawned.stderr?.resume();
    spawned.once("spawn", () => { owner = createUpdatePageProcessOwner(selected, profile, report.requestId, launchAfter, spawned); });
  };
  return withUpdatePageCleanup(async () => {
    channel.subscribe(onSpawn);
    try {
      const launch = await launchPackagedApp({ executablePath: selected.executable, userDataDir: profile, env, cwd: root });
      application = launch.application; child = launch.child;
      owner = createUpdatePageProcessOwner(selected, profile, report.requestId, launchAfter, child);
    } finally { channel.unsubscribe(onSpawn); }
    assert.ok(owner, `${prefix}_LAUNCH_OWNER_MISSING`);
    await installWindowBoundary(application);
    page = await application.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(30_000);
    page.on("requestfailed", request => requestFailures.push(snapshotUpdatePageRequestFailure(request)));
    const rendererErrors = [];
    page.on("pageerror", error => rendererErrors.push(safeFailure(error)));
    await page.waitForURL("codeflow://desktop/**");
    await page.waitForFunction(async () => (await window.codeflowDesktop.getState()).status === "ready", undefined, { timeout: 60_000 });
    await captureAssetProcesses(owner);
    const facts = await application.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, executable: process.execPath,
      userData: app.getPath("userData"), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
    assert.equal(facts.packaged, true); assert.equal(facts.executable, selected.executable); assert.equal(facts.userData, profile);
    assert.equal(facts.preferences.contextIsolation, true); assert.equal(facts.preferences.sandbox, true); assert.equal(facts.preferences.nodeIntegration, false);
    const runtime = await page.evaluate(() => window.codeflowDesktop.getState()); assert.equal(runtime.health.dbSchemaVersion, 101);
    assert.ok(owner.records.some(item => item.pid === runtime.pid), `${prefix}_CLIENT_OWNER_REQUIRED`);
    await page.waitForFunction(async () => { const state = await window.codeflowDesktop.getUpdateState(); return !state.checking && state.operation === "idle"; });
    let panel = await openUpdatePage(page, application);
    const check = panel.getByRole("button", { name: "立即重试", exact: true });
    const state = await page.evaluate(() => window.codeflowDesktop.getUpdateState());
    assert.equal(state.transportConfigured, Boolean(fixture));
    assert.equal(await panel.getByRole("region", { name: "更新诊断", exact: true }).count(), 0);
    if (!fixture) {
      assert.equal(await check.isDisabled(), true); assert.match(await panel.innerText(), /更新源尚未配置/u);
      const rejection = await page.evaluate(async () => {
        try { await window.codeflowDesktop.checkForUpdates(); return { rejected: false }; }
        catch (error) { return { rejected: true, message: error instanceof Error ? error.message : "NON_ERROR_REJECTION" }; }
      });
      assert.equal(rejection.rejected, true); assert.match(rejection.message, /DESKTOP_UPDATE_CHECK_FAILED$/u);
      assertUpdatePageMainErrors(await readJsonLines(path.join(root, "runtime/logs/desktop-errors.jsonl")), state.deviceId);
      report.unconfiguredBridgeRejection = { publicCode: "DESKTOP_UPDATE_CHECK_FAILED", mainCauseCodes: ["DESKTOP_UPDATE_CHECK_FAILED", "ERROR"] };
      await panel.getByRole("button", { name: "查看诊断", exact: true }).click();
      await panel.getByText("暂无已记录的失败诊断。", { exact: true }).waitFor();
      const diagnostics = await page.evaluate(() => window.codeflowDesktop.getUpdateDiagnostics());
      assert.equal(diagnostics.deviceId, state.deviceId); assert.deepEqual(diagnostics.failures, []);
      await assert.rejects(fs.lstat(path.join(root, "runtime/errors.jsonl")), error => error?.code === "ENOENT");
    } else if (!reopen) {
      fixture.assertHealthy(); assert.ok(fixture.requests.some(item => item.path === "/api/software/desktop/release-availability"));
      const cursor = fixture.requests.length;
      fixture.armFailure(); assert.equal(await check.isDisabled(), false); await check.click();
      await panel.getByText("本次更新检查失败，后续状态查询已停止。", { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.desktop-update-panel[aria-busy="false"]') !== null);
      assert.ok(fixture.requests.slice(cursor).some(item => item.path === "/api/software/desktop/release-availability"));
      assert.doesNotMatch(await panel.innerText(), /更新检查故障/u);
      panel = await openUpdatePage(page, application); await panel.getByText("更新检查故障", { exact: true }).waitFor();
      const failedState = await page.evaluate(() => window.codeflowDesktop.getUpdateState());
      assert.ok(failedState.updateCheckFailure?.requestId); assert.match(JSON.stringify(failedState.updateCheckFailure), /DESKTOP_RELEASE_MANIFEST_INVALID/u);
      await panel.getByRole("button", { name: "查看诊断", exact: true }).click();
      await panel.getByRole("region", { name: "更新诊断", exact: true }).waitFor();
      const diagnostics = await page.evaluate(() => window.codeflowDesktop.getUpdateDiagnostics());
      assert.equal(diagnostics.failures.length, 1); assert.equal(diagnostics.failures[0].reported, false);
      assert.equal(diagnostics.failures[0].record.requestId, failedState.updateCheckFailure.requestId);
      assert.equal(diagnostics.failures[0].record.phase, "discovery");
      assertUpdateFailureRecord(diagnostics.failures[0].record);
      assert.equal(diagnostics.deviceId, state.deviceId); assert.equal(diagnostics.failures[0].record.deviceId, state.deviceId);
      assert.deepEqual(diagnostics.failures[0].record.rootCause, { name: "Error", code: "DESKTOP_RELEASE_MANIFEST_INVALID" });
      assert.deepEqual(await readJsonLines(path.join(root, "runtime/errors.jsonl")), [diagnostics.failures[0].record]);
      assertUpdatePageMainErrors(await readJsonLines(path.join(root, "runtime/logs/desktop-errors.jsonl")), state.deviceId, failedState.updateCheckFailure.requestId);
      report.failure = { requestId: failedState.updateCheckFailure.requestId, errorId: diagnostics.failures[0].record.errorId, payloadSha256: diagnostics.failures[0].record.payloadSha256 };
      await panel.getByText(`诊断编号：${report.failure.errorId}`, { exact: true }).waitFor();
    } else {
      fixture.assertHealthy(); assert.ok(fixture.failures.some(item => item.errorId === report.failure.errorId && item.payloadSha256 === report.failure.payloadSha256));
      await panel.getByRole("button", { name: "查看诊断", exact: true }).click();
      await panel.getByText(`诊断编号：${report.failure.errorId}`, { exact: true }).waitFor();
      const diagnostics = await page.evaluate(() => window.codeflowDesktop.getUpdateDiagnostics());
      assert.equal(diagnostics.failures.length, 1); assert.equal(diagnostics.failures[0].record.errorId, report.failure.errorId); assert.equal(diagnostics.failures[0].reported, true);
      assert.equal(diagnostics.deviceId, state.deviceId); assert.equal(report.launches.at(-1).deviceId, state.deviceId);
      assert.deepEqual(await readJsonLines(path.join(root, "runtime/errors.jsonl")), [diagnostics.failures[0].record,
        { schemaVersion: 1, kind: "ack", errorId: report.failure.errorId, deviceId: state.deviceId, payloadSha256: report.failure.payloadSha256 }]);
      assertUpdatePageMainErrors(await readJsonLines(path.join(root, "runtime/logs/desktop-errors.jsonl")), state.deviceId, report.failure.requestId);
      report.reopenedHistoryConfirmed = true;
    }
    await page.screenshot({ path: path.join(root, reopen ? "update-page-reopened.png" : "update-page.png"), fullPage: true });
    assert.deepEqual(rendererErrors, []); fixture?.assertHealthy();
    boundaryResult = await application.evaluate(() => ({ errors: globalThis.__updatePageBoundary.errors, unexpected: globalThis.__updatePageBoundary.unexpected }));
    assert.deepEqual(boundaryResult.unexpected, []);
    if (fixture && !reopen) assert.ok(boundaryResult.errors.some(item => item.title === "CodeFlow 更新失败"));
    report.launches.push({ reopen, rendererErrors, dialogs: boundaryResult, runtimePid: runtime.pid, deviceId: state.deviceId,
      viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), route: page.url() });
  }, async () => {
    channel.unsubscribe(onSpawn);
    report.requestFailures.push({ reopen, failures: requestFailures });
    try {
      if (application) {
        await withUpdatePageCleanup(async () => {
          assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await captureAssetProcesses(owner);
          await application.evaluate(() => globalThis.__updatePageBoundary?.restore());
          const exited = child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise(resolve => child.once("exit", code => resolve(code)));
          const [, exitCode] = await Promise.all([application.waitForEvent("close", { timeout: 40_000 }), bounded(exited, 40_000, `${prefix}_EXIT_TIMEOUT`),
            page ? page.evaluate(() => { void window.codeflowDesktop.exit(); }) : application.evaluate(({ app }) => app.quit())]);
          assert.equal(exitCode, 0);
          await waitUntil(async () => (await captureAssetProcesses(owner)).length === 0, 10_000, `${prefix}_PROCESSES_REMAIN`);
        }, () => withUpdatePageCleanup(async () => {
          assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await stopAssetProcesses(owner);
        }, async () => { assert.deepEqual(requestFailures, [], `${prefix}_REQUEST_FAILED`); }));
      } else if (child) { assert.ok(owner, `${prefix}_PROCESS_OWNER_REQUIRED`); await stopAssetProcesses(owner); }
    } finally {
      if (owner) report.processes.push(...owner.records.map(item => ({ pid: item.pid, parentPid: item.parentPid, created: item.created, executableSha256: sha(item.executable), commandLineSha256: sha(item.commandLine) })));
      child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
    }
  });
}

/** 只运行两个隔离profile及原失败历史重开，任何失败保因后中止后续场景。 */
export async function runUpdatePage(args) {
  const [executable, output, handoff, review, mode, ...extra] = args;
  assert.ok(!extra.length && ["--preflight", "--run"].includes(mode), `${prefix}_ARGUMENTS_INVALID`);
  const selected = await preflightUpdatePage([executable, output, handoff, review]);
  if (mode === "--preflight") return { preflight: true, releaseId: selected.manifest.releaseId, hashes: selected.auditHashes };
  await fs.mkdir(selected.root);
  const report = { requestId: crypto.randomUUID(), status: "running", launches: [], processes: [], requestFailures: [], boundary: "真实打包Web/preload/main/application，loopback网络夹具和原生错误框呈现适配；无下载切换/PG/provider/生产" };
  let fixture, failed = false, cause;
  try {
    await fs.mkdir(path.join(selected.root, "unconfigured")); await runProfile(selected, path.join(selected.root, "unconfigured"), null, report);
    fixture = await createUpdatePageFixture(); await fs.mkdir(path.join(selected.root, "discovery-failure"));
    await runProfile(selected, path.join(selected.root, "discovery-failure"), fixture, report);
    await runProfile(selected, path.join(selected.root, "discovery-failure"), fixture, report, true);
    fixture.assertHealthy(); report.http = fixture.requests; report.status = "passed";
  } catch (error) { failed = true; cause = error; report.status = "failed"; }
  try { await closeAndVerifyUpdatePage(fixture, selected.artifact, selected.hashes); }
  catch (error) { cause = failed ? new AggregateError([cause, error], `${prefix}_RUN_AND_INPUT_CHECK_FAILED`) : error; failed = true; report.status = "failed"; }
  if (failed) report.error = safeFailure(cause);
  await fs.writeFile(path.join(selected.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (failed) throw cause;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpdatePage(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => { console.error(JSON.stringify(safeFailure(error))); process.exitCode = 1; });
}
