import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { buildDesktopDevicePayload } from "@codeflowai/shared/desktop-device-auth";
import { assertUpdateFailureRecord, digestUpdateFailureRecord, toUpdateDiagnosticCause } from "@codeflowai/shared/desktop-update-failure";
import { createUpdateFailureJournal } from "../src/updateFailureJournal.js";
import { snapshotShellHandoffErrorContext } from "../src/shellHandoff.js";

/** 动态导入不得启动应用或网络，缺失工具直接失败。 */
async function driver(): Promise<any> { return import(new URL("./electron-packaged-update-page.smoke.mjs", import.meta.url).href); }

test("更新入口沿宽窗定时任务按钮和原Modal更新页签，缩窄重开均不重载路由", async () => {
  const d = await driver(), events: unknown[] = [];
  let open = true;
  const settings = {
    async isVisible() { return open; },
    async waitFor(value: unknown) { events.push(["modal", value]); },
    getByRole(role: string, options: { name: string; exact: boolean }) {
      return { async click() { events.push([role, options.name]); if (options.name === "Close") open = false; } };
    },
  };
  const panel = { async waitFor(value: unknown) { events.push(["panel", value]); } };
  const page = {
    locator(selector: string) { return selector === '.settings-modal[role="dialog"]' ? settings : selector === 'section.desktop-update-panel[aria-label="应用更新"]' ? panel : assert.fail(`意外选择器：${selector}`); },
    getByRole(role: string, options: { name: string; exact: boolean }) { return {
      async waitFor(value: unknown) { events.push(["entry", value]); },
      async click() { events.push([role, options.name]); open = true; },
    }; },
    async waitForFunction() { events.push(["idle"]); },
  };
  const application = { async evaluate(callback: any, width: number) {
    return callback({ BrowserWindow: { getAllWindows: () => [{ setContentSize: (w: number, h: number) => events.push(["size", w, h]) }] } }, width);
  } };
  assert.equal(await d.openUpdatePage(page, application), panel);
  assert.deepEqual(events, [["size", 1440, 900], ["idle"], ["entry", { state: "visible" }], ["button", "Close"], ["modal", { state: "hidden" }], ["button", "定时任务"],
    ["modal", { state: "visible" }], ["tab", "应用更新"], ["size", 640, 900], ["panel", { state: "visible" }], ["idle"]]);
});

test("请求失败证据只保codeflow路径和安全网络错误码，查询凭据不进入报告", async () => {
  const d = await driver();
  const failure = (url: string, errorText: string) => d.snapshotUpdatePageRequestFailure({ url: () => url, failure: () => ({ errorText }) });
  assert.deepEqual(failure("codeflow://desktop/assets/missing.png?token=PRIVATE#SECRET", "net::ERR_FILE_NOT_FOUND"),
    { pathname: "/assets/missing.png", errorText: "net::ERR_FILE_NOT_FOUND" });
  const unsafe = failure("https://user:password@example.invalid/private?token=PRIVATE", "failed https://example.invalid/?token=PRIVATE");
  assert.equal(unsafe.pathname, null); assert.equal(unsafe.errorText, "UNCLASSIFIED_REQUEST_FAILURE");
  assert.match(unsafe.errorTextSha256, /^[a-f0-9]{64}$/u); assert.doesNotMatch(JSON.stringify(unsafe), /PRIVATE|password|example/u);
});

test("实际编译独立更新弹框保留开关、重启禁用和下载进度语义", async () => {
  const requireWeb = createRequire(new URL("../../web/package.json", import.meta.url)), vue = requireWeb("vue"), { parse, compileTemplate } = requireWeb("vue/compiler-sfc");
  const filename = new URL("../../web/src/features/settings/components/desktop-update-check-modal.vue", import.meta.url), parsed = parse(await fs.readFile(filename, "utf8"));
  assert.deepEqual(parsed.errors, []);
  /** 定位当前独立更新弹框，编译原模板分支和事件。 */
  function findModal(nodes: any[]): any {
    for (const node of nodes) {
      if (node.type !== 1) continue;
      if (node.tag === "a-modal" && node.props.some((prop: any) => prop.type === 7 && prop.arg?.content === "open" && prop.exp?.content === "open")) return node;
      const found = findModal(node.children); if (found) return found;
    }
  }
  const modal = findModal(parsed.descriptor.template.ast.children); assert.ok(modal);
  const compiled = compileTemplate({ source: modal.loc.source, filename: filename.pathname, id: "update-page-modal", compilerOptions: { mode: "function", prefixIdentifiers: true,
    isCustomElement: (tag: string) => !["a-modal", "a-button"].includes(tag), bindingMetadata: { AModal: "setup-const", AButton: "setup-const" } } });
  assert.deepEqual(compiled.errors, []);
  const compiledRender = new Function("Vue", compiled.code)(vue);
  /** 仅为有slot的UI容器提供标签，仍执行原模板绑定和事件。 */
  const render = (context: unknown, cache: unknown[]) => compiledRender(context, cache, {}, { AModal: "a-modal", AButton: "a-button" });
  const context = { open: true, restarting: false, checking: false, prepared: false, capabilities: { check: true, restart: true },
    presentation: { tone: "success", title: "当前已是最新版本", detail: "无需更新" }, versionRows: [], downloadPercent: null as number | null,
    downloadSize: "1 MB", primaryAction: { kind: "close", label: "关闭", disabled: false },
    close() { context.open = false; }, openNotes() {}, startCheck() {}, performPrimaryAction() {} };
  /** 遍历编译结果的实际 VNode 和默认插槽，不替换产品分支。 */
  function nodes(node: any): any[] {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(typeof node.children?.default === "function" ? node.children.default() : node.children)];
  }
  let tree = render(context, []);
  assert.equal(tree.props.open, true);
  assert.equal(tree.props.title, "软件更新");
  assert.equal(tree.props.closable, true);
  tree.props.onCancel(); assert.equal(context.open, false);
  assert.equal(render(context, []).props.open, false);
  context.open = true; context.restarting = true;
  tree = render(context, []);
  assert.equal(tree.props.closable, false);
  assert.equal(tree.props.keyboard, false);
  assert.equal(nodes(tree).find(node => node.type === "a-button" && node.props?.type === "link")?.props.disabled, true);
  assert.equal(nodes(tree).some(node => node.props?.["aria-label"] === "下载进度"), false);
  context.downloadPercent = 25;
  assert.equal(nodes(render(context, [])).find(node => node.type === "a-progress")?.props.percent, 25);
});

test("工件门槛要求真实handoff、独审绑定和完整新页面来源", async () => {
  const d = await driver(), digest = "a".repeat(64), root = "F:/fixture-package";
  const handoff = { root, sourceContract: { count: 1276, unchangedFromPriorTargets: 1265, overlays: Array(10).fill({}), additions: [{ name: "apps/web/src/features/settings/components/desktop-update-panel.vue" }] } };
  const review = { verdict: { critical: 0, important: 0, minor: 0, artifactGatePassed: true }, candidate: { root, handoffSha256: digest } };
  d.assertUpdatePageReview(handoff, review, digest);
  for (const changed of [
    { ...review, verdict: { ...review.verdict, important: 1 } },
    { ...review, verdict: { ...review.verdict, artifactGatePassed: false } },
    { ...review, candidate: { ...review.candidate, handoffSha256: "b".repeat(64) } },
    { ...review, candidate: { ...review.candidate, root: "F:/other" } },
  ]) assert.throws(() => d.assertUpdatePageReview(handoff, changed, digest));
  assert.throws(() => d.assertUpdatePageReview({ ...handoff, sourceContract: { ...handoff.sourceContract, count: 1275 } }, review, digest));
  assert.throws(() => d.assertUpdatePageReview({ ...handoff, sourceContract: { ...handoff.sourceContract, additions: [] } }, review, digest));
});

test("旧壳缺状态或动作IPC、新Web缺页面必须在启动前拒绝", async () => {
  const d = await driver(), preload = "desktop:getUpdateState desktop:checkForUpdates desktop:getUpdateDiagnostics";
  d.assertUpdatePageCapabilities(preload, ["desktop-update-panel 应用更新 本次更新检查失败"]);
  for (const token of ["desktop:getUpdateState", "desktop:checkForUpdates", "desktop:getUpdateDiagnostics"]) assert.throws(() => d.assertUpdatePageCapabilities(preload.replace(token, ""), ["desktop-update-panel 应用更新 本次更新检查失败"]));
  assert.throws(() => d.assertUpdatePageCapabilities(preload, ["old web"]));
});

for (const cause of [undefined, null, false, 0, ""]) test(`清理不掩盖原falsy拒绝：${String(cause)}`, async () => {
  const d = await driver(); let cleanups = 0;
  await assert.rejects(d.withUpdatePageCleanup(async () => { throw cause; }, async () => { cleanups++; }), error => Object.is(error, cause));
  assert.equal(cleanups, 1);
  const cleanup = new Error("cleanup");
  await assert.rejects(d.withUpdatePageCleanup(async () => { throw cause; }, async () => { throw cleanup; }), error => error instanceof AggregateError && Object.is(error.errors[0], cause) && error.errors[1] === cleanup);
});

test("清理失败使原成功显式失败，正常双成功才返回结果", async () => {
  const d = await driver(), cleanup = new Error("cleanup");
  await assert.rejects(d.withUpdatePageCleanup(async () => 1, async () => { throw cleanup; }), error => error === cleanup);
  assert.equal(await d.withUpdatePageCleanup(async () => 1, async () => {}), 1);
});

/** 只创建隔离公钥/签名，测试原认证信封而不读真实凭据。 */
function signed(keys: { privateKey: crypto.KeyObject }, deviceId: string, url: string, value?: unknown, metadata: { requestId?: string; timestamp?: number } = {}) {
  const body = value === undefined ? new Uint8Array() : Buffer.from(JSON.stringify(value)), method = value === undefined ? "GET" : "POST", requestId = metadata.requestId ?? crypto.randomUUID(), timestamp = metadata.timestamp ?? Date.now();
  const signature = crypto.sign(null, buildDesktopDevicePayload({ deviceId, requestId, timestamp, method, url, body }), keys.privateKey).toString("base64");
  return { method, ...(value === undefined ? {} : { body }), headers: { "x-codeflow-device-auth": "v1", "x-codeflow-device-id": deviceId, "x-codeflow-request-id": requestId,
    "x-codeflow-timestamp": String(timestamp), "x-codeflow-signature": signature, "content-type": "application/json" } };
}

test("真实loopback仅允许签名登记和发现，不构造下载或切换", async t => {
  const d = await driver(), fixture = await d.createUpdatePageFixture(), keys = crypto.generateKeyPairSync("ed25519"), deviceId = crypto.randomUUID();
  t.after(() => fixture.close());
  const registration = { deviceId, publicKeyBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  const registered = await fetch(fixture.origin + "/api/software/desktop/devices/register", signed(keys, deviceId, "/api/software/desktop/devices/register", registration));
  assert.equal(registered.status, 200);
  const available = await fetch(fixture.origin + "/api/software/desktop/release-availability", signed(keys, deviceId, "/api/software/desktop/release-availability"));
  assert.equal((await available.json() as any).available, false);
  fixture.armFailure();
  const failed = await fetch(fixture.origin + "/api/software/desktop/release-availability", signed(keys, deviceId, "/api/software/desktop/release-availability"));
  assert.deepEqual((await failed.json() as any).manifest, {});
  assert.equal(fixture.requests.filter((item: any) => item.path.includes("release-availability")).length, 2);
  fixture.assertHealthy();
});

for (const mode of ["unsigned", "wrong-key", "unexpected-download", "unknown-query", "expired"]) test(`fixture异常必须显式失败：${mode}`, async t => {
  const d = await driver(), fixture = await d.createUpdatePageFixture(), keys = crypto.generateKeyPairSync("ed25519"), deviceId = crypto.randomUUID();
  t.after(() => fixture.close());
  const registerPath = "/api/software/desktop/devices/register", registration = { deviceId, publicKeyBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  assert.equal((await fetch(fixture.origin + registerPath, signed(keys, deviceId, registerPath, registration))).status, 200);
  const url = mode === "unexpected-download" ? "/api/software/desktop/releases/test/archive" : "/api/software/desktop/release-availability" + (mode === "unknown-query" ? "?unknown=1" : "");
  const request = mode === "unsigned" ? {} : signed(mode === "wrong-key" ? crypto.generateKeyPairSync("ed25519") : keys, deviceId, url, undefined, mode === "expired" ? { timestamp: 0 } : {});
  assert.equal((await fetch(fixture.origin + url, request)).status, 500);
  assert.throws(() => fixture.assertHealthy());
});

test("包根与证据根双向互斥，同级相似前缀不能误拒绝", async () => {
  const d = await driver(), root = path.resolve("F:/fixture-package");
  for (const output of [root, path.join(root, "nested"), path.join(root, "..cache"), path.dirname(root)]) {
    assert.throws(() => d.assertUpdatePageOutputPaths(root, [output]), /DESKTOP_UPDATE_PAGE_OUTPUT_PACKAGE_OVERLAP/u);
  }
  for (const output of [root + "-output", path.resolve("D:/separate-output")]) d.assertUpdatePageOutputPaths(root, [output]);
});

test("路径预检拒绝仓库内、双向重叠、已有输出与junction且不创建输出", async t => {
  const d = await driver(), root = await fs.mkdtemp(path.join(os.tmpdir(), "update-page-inputs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "output"), exe = path.join(root, "artifact/CodeFlowAI.exe");
  await fs.mkdir(path.join(path.dirname(exe), "resources/client/dist"), { recursive: true });
  await fs.mkdir(path.join(path.dirname(exe), "resources/web"));
  for (const file of [exe, path.join(path.dirname(exe), "resources/app.asar"), path.join(path.dirname(exe), "resources/client/dist/index.cjs"), path.join(path.dirname(exe), "resources/web/index.html")]) await fs.writeFile(file, "placeholder");
  for (const target of ["D:/cf/update-page-forbidden-output", path.dirname(exe), path.join(path.dirname(exe), "nested"), root]) {
    await assert.rejects(d.preflightUpdatePage([exe, target, path.join(root, "missing-handoff.json"), path.join(root, "missing-review.json")]));
  }
  await fs.mkdir(output);
  await assert.rejects(d.preflightUpdatePage([exe, output, path.join(root, "missing-handoff.json"), path.join(root, "missing-review.json")]), /DESKTOP_PROTOCOL_OUTPUT_ALREADY_EXISTS/u);
  const linked = path.join(root, "linked"); await fs.symlink(path.dirname(exe), linked, "junction");
  await assert.rejects(d.preflightUpdatePage([exe, path.join(linked, "nested"), path.join(root, "missing-handoff.json"), path.join(root, "missing-review.json")]), /DESKTOP_PROTOCOL_ARTIFACT_OUTPUT_OVERLAP/u);
  const absent = path.join(root, "artifact-output");
  await assert.rejects(d.preflightUpdatePage([exe, absent, path.join(root, "missing-handoff.json"), path.join(root, "missing-review.json")]), { code: "ENOENT" });
  await assert.rejects(fs.access(absent));
});

for (const mode of ["exact", "wrong-device", "wrong-request", "wrong-digest", "changed-replay"]) test(`真实签名失败补报严格匹配并只返回精确ACK：${mode}`, async t => {
  const d = await driver(), root = await fs.mkdtemp(path.join(os.tmpdir(), "update-page-ack-")), fixture = await d.createUpdatePageFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true })); t.after(() => fixture.close());
  const keys = crypto.generateKeyPairSync("ed25519"), deviceId = crypto.randomUUID(), endpoint = "/api/software/desktop/update-failures";
  const registration = { deviceId, publicKeyBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64") };
  assert.equal((await fetch(fixture.origin + "/api/software/desktop/devices/register", signed(keys, deviceId, "/api/software/desktop/devices/register", registration))).status, 200);
  const journal = createUpdateFailureJournal(root);
  const record = journal.record({ deviceId: mode === "wrong-device" ? crypto.randomUUID() : deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1",
    requestId: "original-update-request", releaseId: "unknown", phase: "discovery", recovery: "not_needed", error: new Error("DESKTOP_RELEASE_MANIFEST_INVALID") });
  const payload = mode === "wrong-digest" ? { ...record, payloadSha256: "0".repeat(64) } : record;
  const request = signed(keys, deviceId, endpoint, payload, { requestId: mode === "wrong-request" ? crypto.randomUUID() : record.errorId });
  const response = await fetch(fixture.origin + endpoint, request);
  if (["exact", "changed-replay"].includes(mode)) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, errorId: record.errorId, deviceId, payloadSha256: record.payloadSha256 });
    assert.equal((await fetch(fixture.origin + endpoint, request)).status, 200);
    if (mode === "exact") fixture.assertHealthy();
    else {
      const changed = journal.record({ deviceId, shellVersion: "1", currentReleaseId: "installation", webVersion: "1", clientVersion: "1", requestId: "another-request", releaseId: "unknown", phase: "discovery", recovery: "not_needed", error: new Error("EIO") });
      const conflicting = { ...changed, errorId: record.errorId };
      const { payloadSha256: _digest, ...body } = conflicting;
      conflicting.payloadSha256 = digestUpdateFailureRecord(body); assertUpdateFailureRecord(conflicting);
      assert.equal((await fetch(fixture.origin + endpoint, signed(keys, deviceId, endpoint, conflicting, { requestId: record.errorId }))).status, 500);
      assert.throws(() => fixture.assertHealthy());
    }
  } else { assert.equal(response.status, 500); assert.throws(() => fixture.assertHealthy()); }
});

test("CLI坏模式或额外参数必须在读工件或创建输出之前失败", async () => {
  const d = await driver();
  for (const args of [[], ["missing.exe", "output", "handoff", "review", "--unknown"], ["missing.exe", "output", "handoff", "review", "--run", "extra"]]) {
    await assert.rejects(d.runUpdatePage(args), /DESKTOP_UPDATE_PAGE_ARGUMENTS_INVALID/u);
  }
});

test("主日志必须关联固定IPC拒绝和真实安全投影；发现失败保原请求和结构化根因", async () => {
  const d = await driver(), deviceId = crypto.randomUUID(), updateRequestId = crypto.randomUUID();
  const ipc = { requestId: crypto.randomUUID(), deviceId, channel: "desktop:checkForUpdates", errorCode: "DESKTOP_UPDATE_CHECK_FAILED", causeCodes: ["DESKTOP_UPDATE_CHECK_FAILED", "ERROR"] };
  d.assertUpdatePageMainErrors([ipc], deviceId);
  const failed = { ...ipc, updateRequestId, causeCodes: ["DESKTOP_UPDATE_CHECK_FAILED", "DESKTOP_RELEASE_MANIFEST_INVALID"] };
  const original = { requestId: updateRequestId, deviceId, errorCode: "DESKTOP_RELEASE_MANIFEST_INVALID", causeCodes: ["DESKTOP_RELEASE_MANIFEST_INVALID"] };
  d.assertUpdatePageMainErrors([original, failed], deviceId, updateRequestId);
  for (const records of [[], [original], [original, { ...failed, updateRequestId: "other" }], [original, { ...failed, deviceId: crypto.randomUUID() }], [{ ...original, causeCodes: [] }, failed], [original, failed, { errorCode: "UNEXPECTED_FAILURE" }]]) {
    assert.throws(() => d.assertUpdatePageMainErrors(records, deviceId, updateRequestId));
  }
});

test("真实主日志投影区分无源裸Error和清单结构化错误；业务诊断仍保公开根因", async () => {
  const d = await driver(), deviceId = crypto.randomUUID(), updateRequestId = crypto.randomUUID();
  for (const configured of [false, true]) {
    const code = configured ? "DESKTOP_RELEASE_MANIFEST_INVALID" : "DESKTOP_UPDATE_UNAVAILABLE";
    const cause = configured ? Object.assign(new Error(code), { code, requestId: updateRequestId }) : new Error(code);
    const original = snapshotShellHandoffErrorContext(cause);
    assert.deepEqual(original.causeCodes, [configured ? code : "ERROR"]);
    assert.deepEqual(toUpdateDiagnosticCause(cause), { name: "Error", code });
    const failure = Object.assign(new Error("DESKTOP_UPDATE_CHECK_FAILED", { cause }), { code: "DESKTOP_UPDATE_CHECK_FAILED" });
    const ipc = { requestId: crypto.randomUUID(), deviceId, channel: "desktop:checkForUpdates", errorCode: failure.code,
      causeCodes: snapshotShellHandoffErrorContext(failure).causeCodes, ...(configured ? { updateRequestId } : {}) };
    assert.deepEqual(ipc.causeCodes, ["DESKTOP_UPDATE_CHECK_FAILED", configured ? code : "ERROR"]);
    d.assertUpdatePageMainErrors(configured ? [{ requestId: updateRequestId, deviceId, errorCode: code, causeCodes: original.causeCodes }, ipc] : [ipc],
      deviceId, configured ? updateRequestId : undefined);
  }
});

test("夹具关闭失败仍复核工件，并按业务、关闭、库存顺序保留原因", async t => {
  const d = await driver(), root = await fs.mkdtemp(path.join(os.tmpdir(), "update-page-finalize-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "artifact.bin"), original = Buffer.from("original"), closeError = new Error("close-failed"), business = new Error("business-failed");
  const hashes = { "artifact.bin": crypto.createHash("sha256").update(original).digest("hex") };
  await fs.writeFile(file, original);
  await assert.rejects(d.closeAndVerifyUpdatePage({ async close() { throw closeError; } }, root, hashes), error => error === closeError);
  const fixture = { async close() { await fs.writeFile(file, "changed"); throw closeError; } };
  await assert.rejects(d.closeAndVerifyUpdatePage(fixture, root, hashes), error => error instanceof AggregateError && error.errors[0] === closeError && error.errors[1]?.code === "ERR_ASSERTION");
  await assert.rejects(d.withUpdatePageCleanup(async () => { throw business; }, () => d.closeAndVerifyUpdatePage(fixture, root, hashes)),
    error => error instanceof AggregateError && error.errors[0] === business && error.errors[1] instanceof AggregateError && error.errors[1].errors[0] === closeError && error.errors[1].errors[1]?.code === "ERR_ASSERTION");
  await assert.rejects(d.closeAndVerifyUpdatePage(null, root, hashes), { code: "ERR_ASSERTION" });
  await fs.writeFile(file, original); await d.closeAndVerifyUpdatePage(null, root, hashes);
});

test("真实启动函数在页面ready后首次严格核进程，不在launch候选PID返回后提前扫描", async () => {
  const d = await driver(), ts = createRequire(import.meta.url)("typescript"), events: string[] = [], firstCapture = new Error("FIRST_CAPTURE");
  const source = await fs.readFile(new URL("./electron-packaged-update-page.smoke.mjs", import.meta.url), "utf8");
  const ast = ts.createSourceFile("driver.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = ast.statements.find((item: any) => ts.isFunctionDeclaration(item) && item.name?.text === "runProfile"); assert.ok(node);
  const page = { setDefaultTimeout() {}, on() {}, async waitForURL() { events.push("page-url"); },
    async waitForFunction(callback: Function) {
      const result = await new Function("window", `return (${callback.toString()})()`)(
        { codeflowDesktop: { getState: async () => { events.push("runtime-ready"); return { status: "ready" }; } } });
      assert.equal(result, true); events.push("ready-confirmed");
    } };
  const selected = { executable: path.resolve("owned/CodeFlowAI.exe"), PATH: "isolated", files: { client: path.resolve("client/index.cjs") } };
  /** 只运行原启动体至首次capture；其后的场景和清理由既有独立项覆盖。 */
  const run = new Function("deps", `const {path, isolatedEnvironment, diagnostics, withUpdatePageCleanup, launchPackagedApp, createUpdatePageProcessOwner,
    assert, prefix, captureAssetProcesses, installWindowBoundary, snapshotUpdatePageRequestFailure, safeFailure} = deps; return (${node.getText(ast)});`)({
    path, assert, prefix: "DESKTOP_UPDATE_PAGE", isolatedEnvironment: async () => ({}),
    diagnostics: { channel: () => ({ subscribe() {}, unsubscribe() {} }) },
    withUpdatePageCleanup: async (operation: Function) => operation(), createUpdatePageProcessOwner: d.createUpdatePageProcessOwner,
    launchPackagedApp: async () => { events.push("launch-returned"); return { child: { pid: 123 }, application: { firstWindow: async () => page } }; },
    installWindowBoundary: async () => { events.push("window-boundary"); },
    captureAssetProcesses: async (owner: { anchorPid: number; records: unknown[] }) => {
      events.push("capture"); assert.equal(owner.anchorPid, 123); assert.deepEqual(owner.records, []); throw firstCapture;
    },
    snapshotUpdatePageRequestFailure: d.snapshotUpdatePageRequestFailure, safeFailure: (error: unknown) => { throw error; },
  });
  await assert.rejects(run(selected, path.resolve("offline-launch-sequence"), null, { requestId: "offline-launch-sequence" }), error => error === firstCapture);
  assert.deepEqual(events, ["launch-returned", "window-boundary", "page-url", "runtime-ready", "ready-confirmed", "capture"]);
});

test("成功launch返回真实child且未接收诊断事件时，仍沿返回PID建立owner", async () => {
  const d = await driver(), selected = { executable: process.execPath, files: { client: path.resolve("client/index.cjs") }, shell: path.resolve("cmd.exe"), consoleHost: path.resolve("conhost.exe") };
  const launchAfter = Date.now(), child = spawn(process.execPath, ["--eval", ""], { windowsHide: true, stdio: "ignore" });
  const closed = once(child, "close");
  try {
    const returned = await Promise.resolve({ child });
    const owner = d.createUpdatePageProcessOwner(selected, path.resolve("offline-profile"), "offline-returned-child", launchAfter, returned.child);
    assert.equal(owner.anchorPid, child.pid); assert.equal(owner.observerPid, process.pid);
    assert.equal(owner.launchAfter, launchAfter); assert.equal(owner.executable, selected.executable);
    assert.equal(owner.clientFile, selected.files.client); assert.deepEqual(owner.records, []);
  } finally { assert.deepEqual(await closed, [0, null]); }
});

test("返回child缺失或PID无效不能构造进程owner", async () => {
  const d = await driver(), selected = { executable: path.resolve("owned.exe"), files: { client: path.resolve("client/index.cjs") } };
  for (const child of [undefined, {}, { pid: undefined }, { pid: 0 }, { pid: -1 }, { pid: 1.5 }, { pid: "123" }]) {
    assert.throws(() => d.createUpdatePageProcessOwner(selected, path.resolve("offline-profile"), "invalid-child", 999, child), /DESKTOP_UPDATE_PAGE_LAUNCH_PID_REQUIRED/u);
  }
});

test("返回PID仅是候选入口，未知路径、父链或命令仍被原进程校验拒绝且不停止", async () => {
  const d = await driver(), processes = await import(new URL("./electron-real-provider-assets.smoke.mjs", import.meta.url).href);
  const executable = path.resolve("owned/CodeFlowAI.exe"), profile = path.resolve("offline-profile"), clientFile = path.resolve("client/index.cjs");
  const selected = { executable, files: { client: clientFile }, shell: path.resolve("cmd.exe"), consoleHost: path.resolve("conhost.exe") };
  const observer = { pid: process.pid, parentPid: 50, created: 900, executable: process.execPath, commandLine: "node offline-driver.mjs" };
  const anchor = { pid: 101, parentPid: process.pid, created: 1000, executable, commandLine: `${executable} --user-data-dir=${profile}` };
  const client = { pid: 102, parentPid: 101, created: 1001, executable, commandLine: `${executable} ${clientFile} --foreground` };
  const base = d.createUpdatePageProcessOwner(selected, profile, "returned-child-validation", 999, { pid: 101 });
  await processes.captureAssetProcesses(base, { snapshot: async () => [observer, anchor, client] });
  assert.deepEqual(base.records.map((item: { pid: number }) => item.pid), [101, 102]);
  for (const changed of [{ ...anchor, executable: path.resolve("unknown.exe") }, { ...anchor, parentPid: 777 }, { ...anchor, commandLine: "other-profile" }, { ...anchor, created: 998 }]) {
    const owner = d.createUpdatePageProcessOwner(selected, profile, "unknown-returned-child", 999, { pid: 101 }), stopped: number[] = [];
    await assert.rejects(processes.stopAssetProcesses(owner, { snapshot: async () => [observer, changed, client], stop: async (item: { pid: number }) => { stopped.push(item.pid); } }));
    assert.deepEqual(stopped, []);
  }
});
