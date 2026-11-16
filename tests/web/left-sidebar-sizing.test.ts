import assert from "node:assert/strict";
import test from "node:test";

import {
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  normalizeLeftSidebarWidth,
  resolveDesktopPanelSizing,
} from "../../apps/web/src/layouts/desktop/desktop-panel-sizing.js";

test("左栏宽度只接受 300 至 520 的有限值", () => {
  assert.equal(normalizeLeftSidebarWidth("420"), LEFT_SIDEBAR_DEFAULT_WIDTH);
  assert.equal(normalizeLeftSidebarWidth(420), 420);
  assert.equal(normalizeLeftSidebarWidth(Number.NaN), LEFT_SIDEBAR_DEFAULT_WIDTH);
  assert.equal(normalizeLeftSidebarWidth(299), LEFT_SIDEBAR_DEFAULT_WIDTH);
  assert.equal(normalizeLeftSidebarWidth(521), LEFT_SIDEBAR_DEFAULT_WIDTH);
  assert.equal(LEFT_SIDEBAR_MIN_WIDTH, 300);
  assert.equal(LEFT_SIDEBAR_MAX_WIDTH, 520);
});

test("文件面板打开时先收敛右栏，再保护主区和左栏最小宽度", () => {
  const sizing = resolveDesktopPanelSizing({
    containerWidth: 1200,
    leftPreference: 520,
    rightMode: "explorer",
    rightPreference: 700,
  });
  assert.equal(sizing.effectiveLeftWidth, 460);
  assert.equal(sizing.effectiveRightWidth, 300);
  assert.equal(sizing.mainWidth, 440);
  assert.equal(sizing.effectiveLeftMaxWidth, 460);
});

test("终端组合在临界桌面视口保持主区可用", () => {
  const sizing = resolveDesktopPanelSizing({
    containerWidth: 1200,
    leftPreference: 360,
    rightMode: "terminal",
    rightPreference: 560,
  });
  assert.equal(sizing.effectiveLeftWidth, 320);
  assert.equal(sizing.effectiveRightWidth, 480);
  assert.equal(sizing.mainWidth, 400);
});
