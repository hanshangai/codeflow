import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/** 定时任务页使用两个 tab 承载任务与运行记录，并保持同一高度链。 */
test("scheduled tasks panel exposes task and run tabs without a separate drawer", () => {
  const source = fs.readFileSync(new URL("../src/features/admin/components/AdminScheduledTasksPanel.vue", import.meta.url), "utf8");
  assert.match(source, /<a-tabs v-model:active-key="activeView" class="scheduled-tasks__tabs" @change="handleViewChange">/u);
  assert.match(source, /<a-tab-pane key="tasks" tab="定时任务">/u);
  assert.match(source, /<a-tab-pane key="runs" tab="运行记录">/u);
  assert.match(source, /class="scheduled-tasks__view"/u);
  assert.match(source, /openRunsView\(/u);
  assert.doesNotMatch(source, /<a-drawer/u);
});
