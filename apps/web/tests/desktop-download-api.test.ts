import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopDownload, resolveDesktopDownloadBase } from "../src/api/desktopDownload.ts";

const windows = { platform: "win32", arch: "x64", version: "1.0.0", publishedAt: 1,
  size: 1234, sha256: "a".repeat(64), downloadPath: "/api/public/desktop-download/windows-x64" };
const macArm = { ...windows, platform: "darwin", arch: "arm64", downloadPath: "/api/public/desktop-download/darwin-arm64" };
const responseBody = { ok: true, ...windows, packages: [windows, macArm] };

test("公开下载元信息无需凭据并只接受固定同源平台包地址", async t => {
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, "https://downloads.test/api/public/desktop-download");
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    return Response.json(responseBody);
  });
  const info = await getDesktopDownload("wss://downloads.test");
  assert.deepEqual(info.packages.map(item => `${item.platform}-${item.arch}`), ["win32-x64", "darwin-arm64"]);
  assert.equal(info.packages[0]!.version, "1.0.0");
});

test("旧服务端单包响应继续兼容并归一为新列表结构", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: true, ...windows }));
  const info = await getDesktopDownload("wss://downloads.test");
  assert.deepEqual(info.packages, [windows]);
});

test("无发布、网络失败、错误字段和外站下载地址均明确拒绝", async t => {
  const probe = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, message: "暂无可用安装包" }, { status: 404 }));
  await assert.rejects(getDesktopDownload("wss://downloads.test"), /暂无可用安装包/u);
  for (const body of [
    { ...responseBody, packages: [{ ...windows, downloadPath: "https://evil.test/setup.exe" }] },
    { ...responseBody, packages: [{ ...windows, size: 0 }] },
    { ...responseBody, packages: [{ ...macArm, downloadPath: "/api/public/desktop-download/windows-x64" }] },
    { ...responseBody, packages: [{ ...windows, platform: "darwin", arch: "x64" }] },
    { ...responseBody, packages: [windows, windows] },
    { ...responseBody, packages: [] },
    { ok: true, ...windows, platform: "darwin" },
  ]) {
    probe.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(getDesktopDownload("wss://downloads.test"), /格式无效/u);
  }
  probe.mock.mockImplementation(async () => { throw new Error("network failed"); });
  await assert.rejects(getDesktopDownload("wss://downloads.test"), /network failed/u);
});

test("浏览器下载使用页面同源，桌面继续使用配置 Server", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: { location: { protocol: "https:", origin: "https://site.test" } } });
  try {
    assert.equal(resolveDesktopDownloadBase("wss://api.test"), "https://site.test");
    assert.equal(resolveDesktopDownloadBase("wss://api.test", true), "https://api.test");
  } finally {
    descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window");
  }
});

test("公开下载保留服务端真实展示号，缺少事实不构造壳号", async t => {
  const probe = t.mock.method(globalThis, "fetch", async () => Response.json({ ...responseBody,
    packages: [{ ...windows, version: "2026.11.21.02", displayVersion: "1.13.1121.2" }] }));
  assert.equal((await getDesktopDownload("wss://downloads.test")).packages[0]!.displayVersion, "1.13.1121.2");
  for (const displayVersion of ["", "unknown", 123, null, "2026.11.21.02"]) {
    probe.mock.mockImplementation(async () => Response.json({ ...responseBody, packages: [{ ...windows, displayVersion }] }));
    await assert.rejects(getDesktopDownload("wss://downloads.test"), /格式无效/u);
  }
});
