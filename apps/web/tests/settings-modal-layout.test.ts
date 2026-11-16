import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("desktop settings modal keeps only model config while browser keeps side tabs", () => {
  const source = read("../src/components/app-shell/app-shell-modals.vue");
  assert.match(source, /settings-modal__single/u);
  assert.match(source, /<EngineKeysPanel :active="shell\.settingsOpen" \/>/u);
  assert.doesNotMatch(source, /key="app-update"/u);
  assert.match(source, /tab-position="left"/u);
  assert.match(source, /key="workspaces"/u);
  assert.match(source, /key="engine-keys"/u);
  for (const removed of ["scheduled-tasks", "codeflowai-config", "software-update"]) {
    assert.doesNotMatch(source, new RegExp(`key="${removed}"`, "u"), removed);
  }
});

test("desktop workspace import opens the independent workspace manager", () => {
  const source = read("../src/composables/useAppShell.ts");
  assert.match(source, /config\.isDesktop && String\(tab \?\? ""\)\.trim\(\) === "workspaces"[\s\S]{0,160}workspaceManagerOpen\.value = true/u);
  const modals = read("../src/components/app-shell/app-shell-modals.vue");
  assert.match(modals, /v-if="shell\.mode === 'mobile' \|\| shell\.config\.isDesktop"[\s\S]{0,120}:open="shell\.workspaceManagerOpen"/u);
});

test("desktop app update entry reuses the tray check-update modal", () => {
  const topbar = read("../src/components/app-shell/app-topbar.vue");
  assert.match(topbar, /requestDesktopUpdateCheck\(\)/u);
  assert.doesNotMatch(topbar, /settingsActiveTab = "app-update"/u);
  const checkModal = read("../src/features/settings/components/desktop-update-check-modal.vue");
  assert.match(checkModal, /desktopUpdateCheckRequestTick/u);
  assert.match(checkModal, /void startCheck\(\)/u);
});

test("key panel keeps detail height and skips the spinner after the first load", () => {
  const panel = read("../src/features/settings/components/engine-keys-panel.vue");
  assert.match(panel, /align-items: stretch;/u);
  assert.match(panel, /loading\.value && !keys\.value\.length && scopeSnapshot\.value\.lastUpdatedAt == null/u);
});

test("system settings keeps desktop scheduled tasks available without the modal", () => {
  const source = read("../src/features/admin/components/admin-layout.vue");
  assert.match(source, /admin\.activePanel === 'scheduled-tasks' && config\.isDesktop/u);
  const tasks = read("../src/features/settings/components/desktop-scheduled-tasks-panel.vue");
  assert.match(tasks, /authMode === "account" && config\.hasActiveSession/u);
});

test("app update panel keeps only the primary action and hides internals behind advanced", () => {
  const source = read("../src/features/settings/components/desktop-update-panel.vue");
  assert.match(source, /检查并准备更新/u);
  assert.match(source, /刷新版本/u);
  assert.match(source, /高级信息与诊断/u);
  assert.match(source, /showAdvanced/u);
  assert.match(source, /:disabled="!capabilities\.diagnostics"/u);
  assert.doesNotMatch(source, /立即重试|刷新详情/u);
});

test("codex settings slash commands route the removed config tab to system settings", () => {
  const source = read("../src/features/composer/components/chat-composer.vue");
  assert.match(source, /tab === "codeflowai-config"[\s\S]{0,200}path: "\/admin", query: \{ panel: "settings" \}/u);
});
