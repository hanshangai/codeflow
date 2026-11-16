import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const previewWindowSource = readFileSync(
  new URL("../src/features/explorer/components/explorer-preview-window.vue", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const fileChangesSource = readFileSync(
  new URL("../src/features/chat/components/file-changes-panel.vue", import.meta.url),
  "utf8",
);
const chatWorkflowSource = readFileSync(
  new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url),
  "utf8",
);

test("desktop fullscreen preview leaves the 44px app topbar uncovered and reaches the bottom", () => {
  assert.match(previewWindowSource, /explorer-preview-modal--desktop-fullscreen/u);
  assert.match(previewWindowSource, /top: 44px !important/u);
  assert.match(previewWindowSource, /bottom: 0 !important/u);
  assert.doesNotMatch(previewWindowSource, /calc\(100dvh - 44px\)/u);
});

test("preview window renders title actions without the default modal close button", () => {
  assert.match(previewWindowSource, /closable: false/u);
  assert.match(previewWindowSource, /aria-label="关闭预览"/u);
});

test("file changes fullscreen modals also start below the desktop topbar", () => {
  assert.match(fileChangesSource, /file-changes-diff-modal--desktop-fullscreen/u);
  assert.match(fileChangesSource, /file-changes-preview-modal--desktop-fullscreen/u);
  assert.match(fileChangesSource, /top: 44px !important/u);
  assert.match(fileChangesSource, /calc\(100dvh - 44px\)/u);
});

test("workflow artifact and node detail fullscreen modals stay below the desktop topbar", () => {
  assert.match(chatWorkflowSource, /chat-workflow__preview-modal--desktop-fullscreen/u);
  assert.match(chatWorkflowSource, /chat-workflow__node-detail-modal--desktop-fullscreen/u);
  assert.match(chatWorkflowSource, /top: 44px !important/u);
  assert.match(chatWorkflowSource, /calc\(100dvh - 44px\)/u);
});

test("keeps desktop preview windows above the global preview taskbar layer", () => {
  const baseZ = Number(previewWindowSource.match(/const BASE_Z = (\d+);/u)?.[1]);
  const fullscreenBaseZ = Number(previewWindowSource.match(/const FULLSCREEN_BASE_Z = (\d+);/u)?.[1]);
  const taskbarZ = Number(appSource.match(/\.preview-taskbar\s*\{[\s\S]*?z-index:\s*(\d+);/u)?.[1]);

  assert.ok(Number.isFinite(baseZ));
  assert.ok(Number.isFinite(fullscreenBaseZ));
  assert.ok(Number.isFinite(taskbarZ));
  assert.ok(baseZ > taskbarZ);
  assert.ok(fullscreenBaseZ > baseZ);
});
