import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopDownload } from "../src/api/desktopDownload.ts";

const metadata = { ok: true, platform: "win32", arch: "x64", version: "1.0.0", publishedAt: 1,
  size: 1234, sha256: "a".repeat(64), downloadPath: "/api/public/desktop-download/windows-x64" };

test("公开下载元信息无需凭据并只接受固定同源完整安装包地址", async t => {
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, "https://downloads.test/api/public/desktop-download");
    assert.equal((init?.headers as Record<string, string>).authorization, undefined);
    return Response.json(metadata);
  });
  assert.equal((await getDesktopDownload("wss://downloads.test")).version, "1.0.0");
});

test("无发布、网络失败、错误字段和外站下载地址均明确拒绝", async t => {
  const probe = t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, message: "暂无可用安装包" }, { status: 404 }));
  await assert.rejects(getDesktopDownload("wss://downloads.test"), /暂无可用安装包/u);
  for (const body of [{ ...metadata, downloadPath: "https://evil.test/setup.exe" }, { ...metadata, size: 0 }, { ...metadata, platform: "darwin" }]) {
    probe.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(getDesktopDownload("wss://downloads.test"), /格式无效/u);
  }
  probe.mock.mockImplementation(async () => { throw new Error("network failed"); });
  await assert.rejects(getDesktopDownload("wss://downloads.test"), /network failed/u);
});

test("公开下载保留服务端真实展示号，缺少事实不构造壳号", async t => {
  const probe = t.mock.method(globalThis, "fetch", async () => Response.json({ ...metadata, version: "2026.11.21.02", displayVersion: "1.13.1121.2" }));
  assert.equal((await getDesktopDownload("wss://downloads.test")).displayVersion, "1.13.1121.2");
  for (const displayVersion of ["", "unknown", 123, null, "2026.11.21.02"]) {
    probe.mock.mockImplementation(async () => Response.json({ ...metadata, displayVersion }));
    await assert.rejects(getDesktopDownload("wss://downloads.test"), /格式无效/u);
  }
});
