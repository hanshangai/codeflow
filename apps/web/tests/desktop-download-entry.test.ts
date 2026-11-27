import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  detectDesktopDownloadPlatform,
  resolveDesktopDownloadTarget,
} from "../src/features/desktop/desktopDownloadEntry.ts";

const installer = {
  version: "1.2.3",
  platform: "win32" as const,
  arch: "x64" as const,
  publishedAt: 1,
  size: 1024,
  sha256: "a".repeat(64),
  downloadPath: "/api/public/desktop-download/windows-x64",
};
const info = { packages: [installer] };

test("detects the desktop download platform from browser facts", () => {
  assert.equal(detectDesktopDownloadPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32"), "win32");
  assert.equal(detectDesktopDownloadPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel"), "darwin");
  assert.equal(detectDesktopDownloadPlatform("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64"), "linux");
  assert.equal(detectDesktopDownloadPlatform("Mozilla/5.0", ""), "unknown");
});

test("windows downloads the registered installer while other systems open the download page", async () => {
  const direct = await resolveDesktopDownloadTarget({
    platform: "win32",
    origin: "wss://codeflow.example",
    load: async () => info,
  });
  assert.deepEqual(direct, { kind: "direct", url: "https://codeflow.example/api/public/desktop-download/windows-x64" });

  // 仅登记 macOS 包时 Windows 入口回到下载页，避免下发错误平台安装包。
  const macOnly = await resolveDesktopDownloadTarget({ platform: "win32", origin: "wss://codeflow.example",
    load: async () => ({ packages: [{ ...installer, platform: "darwin" as const, arch: "arm64" as const,
      downloadPath: "/api/public/desktop-download/darwin-arm64" }] }) });
  assert.deepEqual(macOnly, { kind: "page" });

  for (const platform of ["darwin", "linux", "unknown"] as const) {
    const target = await resolveDesktopDownloadTarget({ platform, origin: "wss://codeflow.example", load: async () => info });
    assert.deepEqual(target, { kind: "page" });
  }

  let reported: unknown = null;
  const failed = await resolveDesktopDownloadTarget({
    platform: "win32",
    origin: "wss://codeflow.example",
    load: async () => { throw new Error("installer missing"); },
    onError: (error) => { reported = error; },
  });
  assert.deepEqual(failed, { kind: "page" });
  assert.match(String(reported), /installer missing/u);
});

test("桌面入口使用配置 Server，网页入口保持页面同源", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true,
    value: { location: { protocol: "https:", origin: "https://site.test" } } });
  try {
    const desktop = await resolveDesktopDownloadTarget({ platform: "win32", origin: "wss://codeflow.example", desktop: true, load: async () => info });
    assert.deepEqual(desktop, { kind: "direct", url: "https://codeflow.example/api/public/desktop-download/windows-x64" });
    const web = await resolveDesktopDownloadTarget({ platform: "win32", origin: "wss://codeflow.example", load: async () => info });
    assert.deepEqual(web, { kind: "direct", url: "https://site.test/api/public/desktop-download/windows-x64" });
  } finally {
    descriptor ? Object.defineProperty(globalThis, "window", descriptor) : Reflect.deleteProperty(globalThis, "window");
  }
});

test("landing entry points use the platform-aware download helper", () => {
  const nav = readFileSync(new URL("../src/features/landing/components/LandingNav.vue", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/features/landing/components/landing-page.vue", import.meta.url), "utf8");
  assert.match(nav, /useDesktopDownloadEntry\("landing_nav"\)/u);
  assert.match(nav, /@click\.prevent="download"/u);
  assert.match(page, /useDesktopDownloadEntry\("homepage"\)/u);
  assert.match(page, /void download\(\)/u);
});
