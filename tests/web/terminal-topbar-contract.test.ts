import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  calculateTerminalTabCapacity,
  formatTerminalListFailures,
  selectDisplayedTerminalKeys,
  shouldClearPendingCreate,
} from "../../apps/web/src/features/terminal/terminal-workbench-logic.js";

const topbarPath = new URL("../../apps/web/src/components/app-shell/app-topbar.vue", import.meta.url);

test("顶部终端按钮不恢复 Hover 列表和数量徽标", async () => {
  const source = await readFile(topbarPath, "utf8");
  const terminalStart = source.indexOf('class="app-topbar__view-tab app-topbar__terminal-btn"');
  const terminalBlock = source.slice(terminalStart, source.indexOf("</button>", terminalStart));
  assert.ok(terminalBlock.includes("shell.ui.rightPanelMode === 'terminal'"));
  assert.ok(terminalBlock.includes("app-topbar__terminal-state--running"));
  assert.ok(terminalBlock.includes("app-topbar__terminal-state--offline"));
  assert.equal(terminalBlock.includes("app-topbar__terminal-badge"), false);
  assert.equal(source.includes("topbar-term-popover"), false);
});

test("终端工作台展示账号级加载失败并提供重试", async () => {
  const source = await readFile(resolve("apps/web/src/features/terminal/components/terminal-modal.vue"), "utf8");
  assert.match(source, /terminal\.listFailures\.length/);
  assert.match(source, /retryAccountTerminalList/);
  assert.match(source, /终端输入发送失败/);
  assert.match(source, /shouldClearPendingCreate/);
});

test("终端 Tab 溢出时使用更多菜单且不展示滚动条", async () => {
  const source = await readFile(resolve("apps/web/src/features/terminal/components/terminal-modal.vue"), "utf8");
  assert.match(source, /terminalTabsOverflow/);
  assert.match(source, /displayedTerminals/);
  assert.match(source, /terminalTabsCapacity/);
  assert.match(source, /MoreOutlined/);
  assert.match(source, /selectOverflowTerminal/);
  assert.match(source, /overflow-x: hidden/);
  assert.doesNotMatch(source, /scrollbar-width: thin/);
});

test("终端 Tab 容量预留工具和更多按钮且当前项始终可见", () => {
  assert.equal(calculateTerminalTabCapacity(560, 140, 3), 3);
  assert.equal(calculateTerminalTabCapacity(560, 140, 4), 2);
  assert.equal(calculateTerminalTabCapacity(700, 140, 4), 4);
  assert.deepEqual(selectDisplayedTerminalKeys(["a", "b", "c"], "c", 2), ["a", "c"]);
  assert.deepEqual(selectDisplayedTerminalKeys(["a", "b", "c"], "b", 2), ["a", "b"]);
});

test("终端工作台保留失败归属并隔离无关创建错误", () => {
  assert.equal(formatTerminalListFailures([
    { clientId: "client-a", workspaceId: "workspace-a", message: "Client 离线" },
    { clientId: "", workspaceId: "", message: "请求超时" },
  ]), "client-a/workspace-a：Client 离线\n未知 Client/未知工作区：请求超时");
  assert.equal(shouldClearPendingCreate("create-a", "create-a"), true);
  assert.equal(shouldClearPendingCreate("create-a", "create-b"), false);
  assert.equal(shouldClearPendingCreate("create-a", undefined), false);
});
