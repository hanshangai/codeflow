import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as tar from "tar";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { isolatedEnvironment, launchPackagedApp, bounded, waitUntil } from "./support/packaged-app.mjs";
import { queryProcesses, stopOwned } from "./electron-packaged-storage-failure.smoke.mjs";

const repository = fileURLToPath(new URL("../../..", import.meta.url)), prefix = "DESKTOP_TITLEBAR";
const require = createRequire(import.meta.url), builder = createRequire(require.resolve("electron-builder"));
const asar = createRequire(builder.resolve("app-builder-lib"))("@electron/asar");

/** 任一方向包含都拒绝，避免输入被输出覆盖（含解析后的 junction）。 */
function separate(a, b) {
  for (const relative of [path.relative(a, b), path.relative(b, a)]) {
    assert.ok(relative && (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)), prefix + "_PATH_OVERLAP");
  }
}

/** 流式摘要适用于完整归档，不把大包整体载入内存。 */
async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

/** 冻结输入必须是普通文件/目录；库存保留大小及内容，拒绝链接。 */
async function inventory(directory) {
  const result = {};
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, prefix + "_INPUT_LINK");
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await inventory(file))) result[entry.name + "/" + name] = value;
    } else {
      assert.equal(entry.isFile(), true, prefix + "_INPUT_FILE_REQUIRED");
      result[entry.name] = { size: (await fs.stat(file)).size, sha256: await digest(file) };
    }
  }
  return result;
}

/** 先证明真实启动根，再扩展子链；已退出根不按相同 PID 接管陌生进程。 */
export function collectOwnedProcesses(all, { pid, driverPid, executable, profile, launchAfter }) {
  const roots = pid ? all.filter(item => item.pid === pid) : all.filter(item => item.commandLine?.includes(profile)
    && path.resolve(item.executable ?? "").toLowerCase() === path.resolve(executable).toLowerCase());
  const ids = new Set();
  for (const root of roots) {
    const parent = all.find(item => item.pid === root.parentPid);
    const packaged = item => item.executable && path.resolve(item.executable).toLowerCase() === path.resolve(executable).toLowerCase()
      && item.commandLine?.includes(profile) && Date.parse(item.created) >= launchAfter - 1_000;
    const wrapper = root.executable && path.resolve(root.executable).toLowerCase() === path.resolve(process.env.ComSpec).toLowerCase()
      && root.commandLine?.toLowerCase().includes(executable.toLowerCase()) && all.some(item => item.parentPid === root.pid && packaged(item));
    assert.ok((packaged(root) || wrapper) && root.commandLine?.includes(profile)
      && Date.parse(root.created) >= launchAfter - 1_000
      && (root.parentPid === driverPid || parent?.parentPid === driverPid && Date.parse(parent.created) >= launchAfter - 1_000), prefix + "_PROCESS_OWNERSHIP_UNKNOWN");
    ids.add(root.pid);
  }
  let added;
  do {
    added = false;
    for (const item of all) if (ids.has(item.parentPid) && !ids.has(item.pid)) {
      const parent = all.find(candidate => candidate.pid === item.parentPid);
      // 旧进程可能保留已复用的 parent PID；早于本次父进程的记录不属于此链。
      if (Date.parse(item.created) < Date.parse(parent.created)) continue;
      assert.ok(item.executable && item.commandLine && Date.parse(item.created) >= launchAfter - 1_000, prefix + "_PROCESS_OWNERSHIP_UNKNOWN");
      ids.add(item.pid); added = true;
    }
  } while (added);
  return all.filter(item => ids.has(item.pid));
}

/** 先核显式冻结编译、ASAR、完整签名业务包和只读基线，成功也不写输出。 */
export async function preflight(args) {
  assert.equal(process.platform, "win32", prefix + "_WINDOWS_REQUIRED");
  assert.ok(args.length === 4 && args.every(value => typeof value === "string" && value.trim() && !value.startsWith("--")),
    "用法：electron-packaged-titlebar.smoke.mjs <实包exe> <冻结desktop-dist> <签名完整包目录> <新输出目录>");
  const executable = await fs.realpath(path.resolve(args[0])), artifact = path.dirname(executable);
  assert.equal(path.basename(executable).toLowerCase(), "codeflowai.exe", prefix + "_EXE_REQUIRED");
  const compiled = await fs.realpath(path.resolve(args[1])), bundle = await fs.realpath(path.resolve(args[2]));
  const requested = path.resolve(args[3]), root = path.join(await fs.realpath(path.dirname(requested)), path.basename(requested));
  for (const source of [artifact, compiled, bundle]) {
    separate(await fs.realpath(repository), source); separate(source, root); separate(source, requested);
  }
  separate(repository, root); separate(repository, requested);
  try { await fs.lstat(root); throw new Error(prefix + "_OUTPUT_EXISTS"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const resources = path.join(artifact, "resources"), archive = path.join(bundle, "bundle.tar.gz");
  const source = await inventory(compiled);
  const scripts = Object.keys(source).filter(name => name.endsWith(".js") || name.endsWith(".cjs")).sort();
  const packagedScripts = asar.listPackage(path.join(resources, "app.asar")).map(name => name.replaceAll("\\", "/").replace(/^\//u, ""))
    .filter(name => name.startsWith("dist/") && /\.(?:c?js)$/u.test(name)).map(name => name.slice(5)).sort();
  assert.deepEqual(packagedScripts, scripts, prefix + "_ASAR_MISMATCH");
  for (const name of scripts) {
    assert.deepEqual(asar.extractFile(path.join(resources, "app.asar"), "dist/" + name), await fs.readFile(path.join(compiled, name)), prefix + "_ASAR_MISMATCH");
  }
  const main = await fs.readFile(path.join(compiled, "main.js"), "utf8"), preload = await fs.readFile(path.join(compiled, "preload.cjs"), "utf8");
  assert.ok(/frame:\s*false/u.test(main) && main.includes("desktop:windowControl") && preload.includes("windowControls"), prefix + "_TITLEBAR_REQUIRED");
  const trustedKeys = assertTrustedReleaseKeys(JSON.parse(await fs.readFile(path.join(resources, "release-trust.json"), "utf8")));
  const manifest = await verifyReleaseBundlePayload({ directory: bundle, manifest: JSON.parse(await fs.readFile(path.join(bundle, "manifest.json"), "utf8")),
    trustedKeys, platform: "win32", arch: "x64", requireFresh: true });
  const baseline = await verifyReleaseBundlePayload({ directory: resources,
    manifest: JSON.parse(await fs.readFile(path.join(resources, "baseline-release-manifest.json"), "utf8")), trustedKeys, platform: "win32", arch: "x64" });
  assert.deepEqual(baseline, manifest, prefix + "_BASELINE_MISMATCH");
  assert.equal(await digest(archive), manifest.archiveSha256, prefix + "_ARCHIVE_MISMATCH");
  assert.equal((await fs.stat(archive)).size, manifest.archiveSize, prefix + "_ARCHIVE_MISMATCH");
  const assets = (await inventory(path.join(resources, "web")));
  let web = "";
  for (const name of Object.keys(assets).filter(name => name.endsWith(".js"))) web += await fs.readFile(path.join(resources, "web", name), "utf8");
  for (const marker of ["desktop-window-bar", "window-minimize", "window-maximize", "window-close"]) assert.ok(web.includes(marker), prefix + "_WEB_TITLEBAR_REQUIRED");
  return { executable, artifact, resources, compiled, bundle, manifest, trustedKeys, root };
}

/** 空工作区每次挂载都会打开原设置引导；正常关闭后再验收页面。 */
async function navigate(page, route) {
  await page.goto("codeflow://desktop/" + route);
  const settings = page.locator('.settings-modal[role="dialog"]');
  await settings.waitFor({ state: "visible", timeout: 30_000 });
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await settings.waitFor({ state: "hidden" });
}

/** 页面真实按钮逐次切换主题，不注入 store、DOM 或伪造 bridge。 */
async function selectTheme(page, theme) {
  await navigate(page, "chat");
  const label = { light: "亮色", dark: "暗色", auto: "自动" }[theme];
  const button = page.locator(".app-topbar__view-tab").filter({ hasText: /^\s*(亮色|暗色|自动)\s*$/u });
  for (let attempt = 0; attempt < 3; attempt++) {
    if ((await button.innerText()).trim() === label) return;
    await button.click();
  }
  assert.equal((await button.innerText()).trim(), label, prefix + "_THEME_SELECTION_FAILED");
}

/** 使用实际窗口属性核动作结果；恢复、退出只走已有入口。 */
async function controls(page, application) {
  const windowState = () => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { minimized: window.isMinimized(), maximized: window.isMaximized(), visible: window.isVisible() };
  });
  const maximize = page.locator('[data-testid="window-maximize"]:visible');
  await maximize.click(); await waitUntil(async () => (await windowState()).maximized, 5_000, prefix + "_MAXIMIZE_FAILED");
  await maximize.click(); await waitUntil(async () => !(await windowState()).maximized, 5_000, prefix + "_RESTORE_FAILED");
  await page.locator('[data-testid="window-minimize"]:visible').click();
  await waitUntil(async () => (await windowState()).minimized, 5_000, prefix + "_MINIMIZE_FAILED");
  await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.show(); });
  await page.locator('[data-testid="window-close"]:visible').click();
  await waitUntil(async () => !(await windowState()).visible, 5_000, prefix + "_CLOSE_FAILED");
  await page.evaluate(() => window.codeflowDesktop.openWindow());
  await waitUntil(async () => (await windowState()).visible, 5_000, prefix + "_REOPEN_FAILED");
  return { maximize: true, restore: true, minimize: true, closeHides: true, reopen: true };
}

/** 保存主题/路由/宽度各格事实与截图；auto 通过应用级 nativeTheme 模拟系统偏好。 */
async function matrix(page, application, root, result) {
  for (const theme of ["light", "dark", "auto"]) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await selectTheme(page, theme);
    for (const nativeTheme of theme === "auto" ? ["light", "dark"] : [theme]) {
      await application.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value; }, nativeTheme);
      for (const width of [1440, 700]) for (const route of ["chat", "docs"]) {
        await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900), width);
        await navigate(page, route);
        await page.locator('[data-testid="window-close"]:visible').waitFor({ state: "visible" });
        const cell = { status: "running", theme, nativeTheme, width, route,
          observedTheme: await page.evaluate(() => ({ attribute: document.documentElement.dataset.theme ?? null,
            prefersDark: matchMedia("(prefers-color-scheme: dark)").matches })) };
        result.push(cell);
        await waitUntil(async () => await page.evaluate(({ theme, nativeTheme }) =>
          (theme === "auto" ? !document.documentElement.hasAttribute("data-theme") : document.documentElement.dataset.theme === theme)
          && matchMedia("(prefers-color-scheme: dark)").matches === (nativeTheme === "dark"), { theme, nativeTheme }), 5_000, prefix + "_THEME_MISMATCH");
        const facts = await page.evaluate(() => {
          const visible = selector => [...document.querySelectorAll(selector)].filter(element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden");
          const drag = visible(".app-topbar--desktop, .desktop-window-bar__drag")[0];
          const bar = drag?.closest(".desktop-window-bar") ?? drag;
          const buttons = ["minimize", "maximize", "close"].map(action => visible(`[data-testid="window-${action}"]`));
          return { width: innerWidth, route: location.pathname, theme: document.documentElement.dataset.theme,
            drag: drag ? { region: getComputedStyle(bar).getPropertyValue("-webkit-app-region"), width: drag.getBoundingClientRect().width } : null,
            buttons: buttons.map(elements => ({ count: elements.length, region: elements[0] ? getComputedStyle(elements[0].closest(".app-titlebar__controls")).getPropertyValue("-webkit-app-region") : null })),
            barHeight: drag?.getBoundingClientRect().height,
            background: bar ? getComputedStyle(bar).background : null, color: bar ? getComputedStyle(bar).color : null };
        });
        assert.equal(facts.route, "/" + route); assert.equal(facts.drag?.region, "drag"); assert.ok(facts.drag.width > 0);
        assert.ok(facts.barHeight > 0); for (const button of facts.buttons) { assert.equal(button.count, 1); assert.equal(button.region, "no-drag"); }
        if (width < 768) assert.ok(facts.width < 768, prefix + "_NARROW_WINDOW_REQUIRED");
        if (theme === "auto") {
          const explicit = result.find(item => item.theme === nativeTheme && item.width === width && item.route === route);
          assert.ok(explicit, prefix + "_EXPLICIT_THEME_REQUIRED");
          assert.equal(facts.background, explicit.facts.background, prefix + "_AUTO_BACKGROUND_MISMATCH");
          assert.equal(facts.color, explicit.facts.color, prefix + "_AUTO_COLOR_MISMATCH");
        }
        const actions = await controls(page, application);
        const name = `${theme}-${nativeTheme}-${width}-${route}.png`;
        await page.screenshot({ path: path.join(root, name) });
        Object.assign(cell, { status: "passed", facts, actions, screenshot: name });
      }
    }
  }
  return result;
}

/** 同一身份先基线首装，后签名 active 业务包重启；失败与清理双因均保留。 */
export async function run(args) {
  const paths = await preflight(args);
  const before = { artifact: await inventory(paths.artifact), compiled: await inventory(paths.compiled), bundle: await inventory(paths.bundle) };
  await fs.mkdir(paths.root);
  const report = { requestId: crypto.randomUUID(), status: "running", scope: "local portable baseline and existing-profile active bundle restart; nativeTheme emulated; no OS installation or production; CSS drag region only, no physical drag proof",
    inputs: { executable: paths.executable, resources: paths.resources, compiled: paths.compiled, bundle: paths.bundle }, scenarios: [], inputBefore: before };
  let error, hasError = false;
  try {
    const data = path.join(paths.root, "runtime"), profile = path.join(paths.root, "profile");
    let identity;
    for (const mode of ["fresh", "existing-profile-active"]) {
      const root = path.join(paths.root, mode); await fs.mkdir(root);
      if (mode !== "fresh") {
        const active = path.join(data, "releases", paths.manifest.releaseId); await fs.mkdir(active, { recursive: true });
        await tar.x({ file: path.join(paths.bundle, "bundle.tar.gz"), cwd: active, strict: true });
        await verifyReleaseBundlePayload({ directory: active, manifest: paths.manifest, trustedKeys: paths.trustedKeys, platform: "win32", arch: "x64" });
        await fs.copyFile(path.join(paths.bundle, "manifest.json"), path.join(active, "manifest.json"));
        await fs.writeFile(path.join(data, "active-release.json"), JSON.stringify({ releaseId: paths.manifest.releaseId }), { flag: "wx" });
      }
      const env = await isolatedEnvironment(root, { CODEFLOWAI_DESKTOP_DATA_DIR: data });
      let session, sceneError, hasSceneError = false; const observed = new Map(), launchAfter = Date.now();
      const scene = { mode, status: "running", matrix: [] };
      /** 仅登记本次主进程及真实子链，清理前仍核创建时间与可执行路径。 */
      async function discover() {
        const all = await queryProcesses();
        const owned = collectOwnedProcesses(all, { pid: session?.child.pid, driverPid: process.pid, executable: paths.executable, profile, launchAfter });
        for (const item of owned) { const prior = observed.get(item.pid); if (prior) assert.deepEqual(prior, item, prefix + "_PID_CHANGED"); else observed.set(item.pid, item); }
      }
      try {
        session = await launchPackagedApp({ executablePath: paths.executable, userDataDir: profile, env, cwd: root });
        await discover();
        const page = await session.application.firstWindow({ timeout: 60_000 });
        page.setDefaultTimeout(15_000);
        // Playwright 默认覆盖为light；移除覆盖才能核Electron nativeTheme实际传给页面的偏好。
        await page.emulateMedia({ colorScheme: null });
        await page.waitForURL("codeflow://desktop/**", { timeout: 60_000 });
        await waitUntil(async () => (await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, prefix + "_STATE_TIMEOUT")).status === "ready", 60_000, prefix + "_CLIENT_NOT_READY");
        scene.state = await bounded(page.evaluate(() => window.codeflowDesktop.getState()), 10_000, prefix + "_STATE_TIMEOUT");
        assert.equal(scene.state.health.database, "ready", prefix + "_DATABASE_NOT_READY");
        assert.equal(scene.state.releaseId, mode === "fresh" ? null : paths.manifest.releaseId);
        await discover(); assert.ok(observed.has(scene.state.pid), prefix + "_CLIENT_NOT_OWNED");
        const clientRoot = mode === "fresh" ? paths.resources : path.join(data, "releases", paths.manifest.releaseId);
        assert.ok(observed.get(scene.state.pid).commandLine.includes(path.join(clientRoot, "client/dist/index.cjs")), prefix + "_CLIENT_SOURCE_MISMATCH");
        assert.equal(await bounded(page.evaluate(async () => { const response = await fetch("codeflow://desktop/index.html"); if (!response.ok) throw new Error("WEB_READ_FAILED"); return await response.text(); }), 10_000, prefix + "_WEB_TIMEOUT"), await fs.readFile(path.join(clientRoot, "web/index.html"), "utf8"));
        scene.shell = await bounded(session.application.evaluate(({ app }) => ({ packaged: app.isPackaged, exe: process.execPath, userData: app.getPath("userData") })), 10_000, prefix + "_SHELL_TIMEOUT");
        assert.equal(scene.shell.packaged, true); assert.equal(path.resolve(scene.shell.exe), paths.executable);
        assert.equal(path.resolve(scene.shell.userData), path.resolve(profile));
        if (mode === "fresh") {
          const settings = page.getByRole("dialog", { name: "设置", exact: true });
          await settings.waitFor({ state: "visible", timeout: 30_000 }); await settings.getByRole("button", { name: "Close", exact: true }).click();
        }
        await bounded(matrix(page, session.application, root, scene.matrix), 300_000, prefix + "_MATRIX_TIMEOUT");
        await discover();
        await bounded(Promise.all([session.application.waitForEvent("close", { timeout: 40_000 }), page.evaluate(() => { void window.codeflowDesktop.exit(); })]), 42_000, prefix + "_EXIT_TIMEOUT");
        assert.equal(session.child.exitCode, 0); scene.exitCode = session.child.exitCode;
        await waitUntil(async () => (await queryProcesses([...observed.keys()])).length === 0, 10_000, prefix + "_PROCESSES_REMAIN");
        const identityHash = await digest(path.join(data, "device-identity.json"));
        if (identity) assert.equal(identityHash, identity, prefix + "_IDENTITY_CHANGED"); else identity = identityHash;
        scene.identitySha256 = identityHash;
      } catch (cause) { hasSceneError = true; sceneError = cause; }
      if (hasSceneError) {
        const failures = [sceneError];
        try { await discover(); } catch (cause) { failures.push(cause); }
        try { await stopOwned([...observed.values()]); } catch (cause) { failures.push(cause); }
        if (session) try { await bounded(session.application.close(), 5_000, prefix + "_CONNECTION_CLOSE_TIMEOUT"); } catch (cause) { failures.push(cause); }
        sceneError = new AggregateError(failures, prefix + "_SCENE_FAILED");
      }
      if (session) { scene.output = session.run; session.child.stdout?.destroy(); session.child.stderr?.destroy(); session.child.unref(); }
      try {
        scene.remainingProcesses = await queryProcesses([...observed.keys()]);
        assert.equal(scene.remainingProcesses.length, 0, prefix + "_FINAL_PROCESSES_REMAIN");
      } catch (cause) {
        sceneError = new AggregateError(hasSceneError ? [sceneError, cause] : [cause], prefix + "_RESOURCE_CHECK_FAILED"); hasSceneError = true;
      }
      scene.processes = [...observed.values()]; scene.status = hasSceneError ? "failed" : "passed";
      if (hasSceneError) scene.failure = failure(sceneError);
      report.scenarios.push(scene);
      if (hasSceneError) throw sceneError;
    }
  } catch (cause) { hasError = true; error = cause; }
  try {
    report.inputAfter = { artifact: await inventory(paths.artifact), compiled: await inventory(paths.compiled), bundle: await inventory(paths.bundle) };
    assert.deepEqual(report.inputAfter, before, prefix + "_INPUT_CHANGED");
  } catch (cause) { error = new AggregateError(hasError ? [error, cause] : [cause], prefix + "_FINAL_CHECK_FAILED"); hasError = true; }
  report.status = hasError ? "failed" : "passed"; if (hasError) report.failure = failure(error);
  await fs.writeFile(path.join(paths.root, "verification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (hasError) throw error;
  return report;
}

/** 失败保留每个根因，不把清理异常覆盖成成功或单一消息。 */
function failure(error) {
  return { name: error?.name ?? typeof error, message: error?.message ?? String(error), stack: error?.stack,
    ...(error instanceof AggregateError ? { errors: error.errors.map(failure) } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const report = await run(process.argv.slice(2)); console.log(JSON.stringify({ code: prefix, status: report.status })); }
  catch (error) { console.error(JSON.stringify({ code: prefix + "_FAILED", ...failure(error) })); process.exitCode = 1; }
}
