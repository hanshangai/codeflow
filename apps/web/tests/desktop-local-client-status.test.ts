import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  resolveDesktopAppVersionLabel,
  resolveDesktopRuntimeStatusHint,
  shouldShowDesktopLocalClientPopover,
} from "../src/components/app-shell/desktopLocalClientStatus.ts";
import { resolveWorkspaceDisplayTitle } from "../src/utils/workspaceTitle.ts";

test("desktop local popover gate ignores runtime readiness and only checks session/workspace mode", () => {
  const base = { isDesktop: true, hasActiveSession: false, isCurrentSharedWorkspace: false };
  assert.equal(shouldShowDesktopLocalClientPopover(base), true);
  assert.equal(shouldShowDesktopLocalClientPopover({ ...base, isDesktop: false }), false);
  assert.equal(shouldShowDesktopLocalClientPopover({ ...base, hasActiveSession: true }), false);
  assert.equal(shouldShowDesktopLocalClientPopover({ ...base, isCurrentSharedWorkspace: true }), false);
});

test("runtime hint distinguishes transient startup/stop from real failure", () => {
  const ready = { ready: true, status: "ready" as const, error: null };
  assert.equal(resolveDesktopRuntimeStatusHint(ready), null);
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: "starting", error: null }), "本机运行环境正在启动，请稍候。");
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: "running", error: null }), "本机运行环境正在启动，请稍候。");
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: "draining", error: null }), "本机运行环境正在停止或切换，请稍候。");
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: "stopped", error: null }), "本机运行环境已停止，请重新启动 CodeFlow。");
  assert.match(resolveDesktopRuntimeStatusHint({ ready: false, status: "failed", error: "CLIENT_BOOT_FAILED" })!, /启动失败/);
  assert.doesNotMatch(resolveDesktopRuntimeStatusHint({ ready: false, status: "failed", error: "CLIENT_BOOT_FAILED" })!, /CLIENT_BOOT_FAILED/);
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: "failed", error: null }), "本机运行环境启动失败，请重启 CodeFlow 后重试。");
  assert.equal(resolveDesktopRuntimeStatusHint({ ready: false, status: null, error: null }), "本机运行环境未就绪，请稍后重试。");
});

test("desktop app display never borrows a local or remote Client version", () => {
  const source = readFileSync(new URL("../src/components/app-shell/app-topbar.vue", import.meta.url), "utf8");
  assert.doesNotMatch(source, /resolveDesktopClientVersionLabel|desktopClientVersionLabel/u);
  assert.match(source, /desktopAppVersionLabel\.value.*未知/u);
});

test("desktop app version matches the update panel and falls back when shell facts are missing", () => {
  const details = { current: { shellVersion: "1.0.0", bundle: { version: "2026.11.10.01" } } } as never;
  assert.equal(resolveDesktopAppVersionLabel(details), "1.0.1110");
  assert.equal(resolveDesktopAppVersionLabel({ current: { shellVersion: null, bundle: null } } as never), null);
  assert.equal(resolveDesktopAppVersionLabel({ current: { shellVersion: "unknown", bundle: { version: "2026.11.21.01" } } } as never), null);
  assert.equal(resolveDesktopAppVersionLabel({ current: { shellVersion: "1.12", bundle: { version: " unknown " } } } as never), null);
});

test("workspace title fallback stays distinguishable for unloaded local workspaces", () => {
  assert.equal(resolveWorkspaceDisplayTitle("ws-1", () => "项目一"), "项目一");
  assert.equal(resolveWorkspaceDisplayTitle("client-a:/Users/demo/project-a", () => undefined), "project-a");
  assert.equal(resolveWorkspaceDisplayTitle("client-b:C:\\work\\project-b", () => undefined), "project-b");
  assert.equal(resolveWorkspaceDisplayTitle("5c1d7f7e-0000-4000-8000-000000000000", () => undefined), "5c1d7f7e");
});
