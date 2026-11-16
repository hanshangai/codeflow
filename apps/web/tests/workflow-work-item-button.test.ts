import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const graphSource = readFileSync(
  new URL("../src/features/orchestration/components/workflow-graph-view.vue", import.meta.url),
  "utf8",
);
const monitorSource = readFileSync(
  new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
  "utf8",
);
const nodeDetailSource = readFileSync(
  new URL("../src/features/orchestration/components/node-execution-detail.vue", import.meta.url),
  "utf8",
);

test("工作项进度以可访问按钮展示，并在 Popover 中打开节点清单", () => {
  assert.match(graphSource, /\(event: "work-items-click", nodeId: string\): void;/u);
  assert.match(graphSource, /v-if="metric\.key === 'workItems'"[\s\S]*?type="button"/u);
  assert.match(graphSource, /:aria-label="`\$\{nodeProps\.data\.label\}工作项，已完成 \$\{metric\.value\}，点击查看`"/u);
  assert.match(graphSource, /@click\.stop="emit\('work-items-click', nodeProps\.id\)"/u);
  assert.match(graphSource, /<strong>\{\{ metric\.value \}\}<\/strong>/u);
  assert.match(monitorSource, /@work-items-click="openNodeDetail"/u);
  assert.match(nodeDetailSource, /const workItemsPopoverOpen = ref\(false\);/u);
  assert.match(nodeDetailSource, /<a-popover\s+v-if="workItemsEnabled"[\s\S]*?:open="workItemsPopoverOpen"[\s\S]*?trigger="click"[\s\S]*?placement="bottomRight"/u);
  assert.match(nodeDetailSource, /@open-change="handleWorkItemsPopoverOpenChange"/u);
  assert.match(nodeDetailSource, /class="node-detail__header-toggle node-detail__work-items-toggle"/u);
  assert.match(nodeDetailSource, /<strong>\{\{ workItemProgressLabel \}\}<\/strong>/u);
  assert.match(nodeDetailSource, /<template #content>[\s\S]*?<section[\s\S]*?class="node-detail__work-items node-detail__work-items-popover"/u);
  assert.doesNotMatch(nodeDetailSource, /v-if="workItemsEnabled && workItemsExpanded"/u);
});

test("工作项 Popover 支持服务端搜索和独立滚动", () => {
  assert.match(nodeDetailSource, /const workItemSearchDraft = ref\(""\);/u);
  assert.match(nodeDetailSource, /const workItemSearch = ref\(""\);/u);
  assert.match(nodeDetailSource, /<a-input-search[\s\S]*?aria-label="搜索工作项"[\s\S]*?@search="applyWorkItemSearch"/u);
  assert.match(nodeDetailSource, /v-if="workItemsLoading && !workItems\.length"/u);
  assert.match(nodeDetailSource, /aria-label="刷新工作项"[\s\S]*?@click="refreshNodeWorkItems"/u);
  assert.match(nodeDetailSource, /watch\(\[\(\) => props\.workspaceId, \(\) => props\.instanceId, \(\) => props\.nodeState\.nodeId\],/u);
  assert.doesNotMatch(nodeDetailSource, /props\.nodeState\.workItemSummary\?\.boardVersion/u);
  assert.match(nodeDetailSource, /search: workItemSearch\.value \|\| null,/u);
  assert.match(
    nodeDetailSource,
    /\.node-detail__work-items-layout \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\);[\s\S]*?height: 390px;[\s\S]*?overflow: hidden;/u,
  );
  assert.match(
    nodeDetailSource,
    /\.node-detail__work-items-list,[\s\S]*?\.node-detail__work-item-detail \{[\s\S]*?min-height: 0;[\s\S]*?overflow: auto;/u,
  );
});

test("节点详情元信息标签使用亮暗主题共享 token", () => {
  assert.match(
    nodeDetailSource,
    /\.node-detail__headline-meta span \{[\s\S]*?var\(--app-accent, #c96442\)[\s\S]*?var\(--app-panel-bg, #fff\)[\s\S]*?color: var\(--app-text, #1f2937\);/u,
  );
  assert.match(
    nodeDetailSource,
    /\.node-detail__meta-line span \{[\s\S]*?border: 1px solid var\(--app-border, #d9d9d9\);[\s\S]*?var\(--app-muted, #666\) 8%[\s\S]*?var\(--app-panel-bg, #fff\)/u,
  );
  assert.doesNotMatch(
    nodeDetailSource,
    /background: color-mix\(in srgb, var\(--app-primary, #1677ff\) 6%, #fff\);/u,
  );
  assert.doesNotMatch(
    nodeDetailSource,
    /\.node-detail__meta-line span \{[^}]*background: var\(--app-hover-bg/u,
  );
});

test("结论弹层标签使用亮暗主题共享 token", () => {
  assert.match(
    nodeDetailSource,
    /\.node-detail__conclusion-panel-head span,[\s\S]*?\.node-detail__conclusion-meta span \{[\s\S]*?border: 1px solid color-mix\(in srgb, var\(--app-primary, #1677ff\) 16%, var\(--app-border, #e8e8e8\)\);[\s\S]*?background: color-mix\(in srgb, var\(--app-primary, #1677ff\) 8%, var\(--app-bg, #fff\)\);/u,
  );
  assert.doesNotMatch(
    nodeDetailSource,
    /\.node-detail__conclusion-panel-head span,[\s\S]*?\.node-detail__conclusion-meta span \{[^}]*background: color-mix\(in srgb, var\(--app-primary, #1677ff\) 8%, #fff\);/u,
  );
});

test("节点详情不依赖未定义的浅色 hover token", () => {
  assert.doesNotMatch(nodeDetailSource, /--app-hover-bg/u);
  assert.match(nodeDetailSource, /\.node-detail__help-btn \{[\s\S]*?var\(--app-bg, #fff\)/u);
  assert.match(nodeDetailSource, /:root\[data-theme="dark"\] \.node-detail__conclusion-button--success,[\s\S]*?color: #b7eb8f;/u);
  assert.match(nodeDetailSource, /:root\[data-theme="dark"\] \.node-detail__conclusion-button--danger,[\s\S]*?color: #ff9c9c;/u);
});

test("控制节点结果空态说明调度职责", () => {
  assert.match(nodeDetailSource, /const emptyResultMessage = computed\(\(\) => \{/u);
  assert.match(nodeDetailSource, /case "parallel-fork":[\s\S]*?并行分叉节点用于启动多条并行分支，本身不产生交付结果。/u);
  assert.match(nodeDetailSource, /case "parallel-join":[\s\S]*?并行汇合节点用于等待并汇合并行分支，本身不产生交付结果。/u);
  assert.match(nodeDetailSource, /<div v-else class="node-detail__empty">\s*\{\{ emptyResultMessage \}\}/u);
});
