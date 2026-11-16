import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { loadWeb, loadStartupWeb, updateStartupWeb } from "../src/webLoader.js";

test("启动页仅加载壳内静态内容，不探测或提前报告业务就绪", async () => {
  let entry = "";
  await loadStartupWeb({ loadURL: async url => { entry = url; },
    webContents: { executeJavaScript: async () => { assert.fail("startup must not probe business readiness"); } } });
  assert.ok(entry.startsWith("data:text/html;charset=utf-8,"));
  const html = decodeURIComponent(entry.slice(entry.indexOf(",") + 1));
  assert.ok(html.includes("正在启动"));
  assert.ok(html.includes("default-src 'none'"));
  assert.doesNotMatch(html, /https?:|codeflowReady/iu);
  const failure = new Error("STARTUP_NAVIGATION_FAILED");
  await assert.rejects(loadStartupWeb({ loadURL: async () => { throw failure; } }), error => error === failure);
});

test("未计量启动阶段显示活动指示和真实已用时间，不伪造百分比", async () => {
  let entry = "";
  await loadStartupWeb({ loadURL: async url => { entry = url; } });
  const html = decodeURIComponent(entry.slice(entry.indexOf(",") + 1));
  assert.doesNotMatch(html, /aria-valuenow=/u);
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/u);
  assert.ok(script);
  assert.ok(html.includes(`script-src 'nonce-${script[1]}'`));
  let elapsed = 0, tick!: () => void;
  const label = { textContent: "" };
  vm.runInNewContext(script[2]!, { Date: { now: () => elapsed },
    document: { querySelector: () => label }, setInterval: (callback: () => void) => { tick = callback; } });
  elapsed = 8700; tick();
  assert.equal(label.textContent, "已用时 8 秒");
  let update = "";
  await updateStartupWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async source => { update = source; } } },
    { label: "正在校验当前版本…" });
  assert.match(update, /removeAttribute\('aria-valuenow'\)/u);
});

test("启动页进度只更新固定状态与进度条，并把百分比收敛到 0-100", async () => {
  const scripts: string[] = [];
  const window = { loadURL: async () => {}, webContents: { executeJavaScript: async (source: string) => { scripts.push(source); } } };
  await updateStartupWeb(window, { label: "正在应用更新…", percent: 45 });
  await updateStartupWeb(window, { label: "正在应用更新…", percent: 150 });
  assert.equal(scripts.length, 2);
  assert.match(scripts[0]!, /正在应用更新…/u);
  assert.match(scripts[0]!, /45%/u);
  assert.match(scripts[0]!, /aria-valuenow/u);
  assert.match(scripts[1]!, /100%/u);
});

test("propagates a Web load failure", async () => {
  const expected = new Error("load failed");
  await assert.rejects(
    () => loadWeb({ loadURL: async () => { throw expected; } }, "codeflow://desktop/"),
    expected,
  );
});

test("page navigation alone cannot report application readiness", async () => {
  let reads = 0;
  await loadWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async () => ++reads > 1 } }, "codeflow://desktop/", { requireReady: true, timeoutMs: 1000 });
  assert.equal(reads, 2);
  await assert.rejects(loadWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async () => false } }, "codeflow://desktop/", { requireReady: true, timeoutMs: 1 }), /DESKTOP_WEB_READY_TIMEOUT/);
});

test("application probe errors remain explicit", async () => {
  const failure = new Error("renderer closed");
  await assert.rejects(loadWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async () => { throw failure; } } }, "codeflow://desktop/", { requireReady: true }), failure);
});

test("本地启动完成后才计算页面就绪预算，不提前探测业务页面", async () => {
  let release!: () => void, probes = 0;
  const startup = new Promise<void>(resolve => { release = resolve; });
  const loading = loadWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async () => { probes++; return true; } } },
    "codeflow://desktop/", { requireReady: true, timeoutMs: 20, beforeReady: () => startup });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(probes, 0, "本地启动等待不能占用页面就绪预算");
  } finally { release(); await loading; }
  assert.equal(probes, 1);
});

test("启动等待失败保留原错，不继续探测页面", async () => {
  const failure = new Error("LOCAL_STARTUP_FAILED");
  await assert.rejects(loadWeb({ loadURL: async () => {}, webContents: { executeJavaScript: async () => { assert.fail("failed startup must not probe Web"); } } },
    "codeflow://desktop/", { requireReady: true, beforeReady: async () => { throw failure; } }), error => error === failure);
});

test("导航失败立即停止，不等待本地启动", async () => {
  const failure = new Error("NAVIGATION_FAILED");
  await assert.rejects(loadWeb({ loadURL: async () => { throw failure; } }, "codeflow://desktop/",
    { requireReady: true, beforeReady: async () => { assert.fail("failed navigation must not wait for startup"); } }), error => error === failure);
});

