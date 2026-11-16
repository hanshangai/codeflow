import test from "node:test";
import assert from "node:assert/strict";

import { loadWeb, loadStartupWeb } from "../src/webLoader.js";

test("启动页仅加载壳内静态内容，不探测或提前报告业务就绪", async () => {
  let entry = "";
  await loadStartupWeb({ loadURL: async url => { entry = url; },
    webContents: { executeJavaScript: async () => { assert.fail("startup must not probe business readiness"); } } });
  assert.ok(entry.startsWith("data:text/html;charset=utf-8,"));
  const html = decodeURIComponent(entry.slice(entry.indexOf(",") + 1));
  assert.ok(html.includes("正在启动"));
  assert.ok(html.includes("default-src 'none'"));
  assert.doesNotMatch(html, /<script|https?:|codeflowReady/iu);
  const failure = new Error("STARTUP_NAVIGATION_FAILED");
  await assert.rejects(loadStartupWeb({ loadURL: async () => { throw failure; } }), error => error === failure);
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

