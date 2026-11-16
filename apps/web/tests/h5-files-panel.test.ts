import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const panelSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5FilesPanel.vue", "utf8");
const explorerPanelSource = fs.readFileSync("apps/web/src/features/explorer/components/explorer-panel.vue", "utf8");
const explorerSidebarSource = fs.readFileSync("apps/web/src/features/explorer/components/explorer-sidebar.vue", "utf8");
const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");

test("H5 files wraps the canonical explorer instead of duplicating file state", () => {
  assert.match(panelSource, /import\("\.\.\/\.\.\/explorer\/components\/explorer-panel\.vue"\)/u);
  assert.match(panelSource, /useConfigStore\(\)/u);
  assert.match(panelSource, /usePresenceStore\(\)/u);
  assert.match(panelSource, /<ExplorerPanel v-if="workspaceReady && workspaceId"/u);
  assert.match(panelSource, /surface="h5"/u);
  assert.match(explorerPanelSource, /explorer-panel--h5/u);
});

test("H5 files header keeps only the title", () => {
  const header = panelSource.slice(
    panelSource.indexOf('<header class="h5-files__header">'),
    panelSource.indexOf("</header>"),
  );
  assert.match(header, /<h1>文件<\/h1>/u);
  assert.doesNotMatch(header, /<button|workspaceTitle|CloudServerOutlined|RightOutlined/u);
});

test("H5 files keeps stable offline and empty recovery states", () => {
  assert.match(panelSource, /工作区暂时离线/u);
  assert.match(panelSource, /还没有可浏览的工作区/u);
  assert.match(panelSource, /前往工作区设置/u);
  assert.match(panelSource, /height: 100%/u);
  assert.match(panelSource, /min-height: 0/u);
  assert.match(panelSource, /overflow: hidden/u);
});

test("H5 files toolbar and view switch follow the H5 conversation header", () => {
  // 分类 tab 与会话页 `.thread-list__segmented` 同一口径：block 提供等宽与文字居中，
  // 尺寸逐条对齐 layout.css，选中态颜色与阴影沿用 base.css 全局适配。
  assert.match(explorerSidebarSource, /class="explorer-sidebar__view-switch"[\s\S]{0,40}?\bblock\b/u);
  assert.match(explorerSidebarSource, /--h5 \.explorer-sidebar__view-switch :deep\(\.ant-segmented\) \{[\s\S]*?padding: 3px;[\s\S]*?border-radius: 8px;/u);
  assert.match(explorerSidebarSource, /--h5 \.explorer-sidebar__view-switch :deep\(\.ant-segmented-item-label\) \{[\s\S]*?min-height: 32px;[\s\S]*?line-height: 32px;[\s\S]*?padding: 0 10px;/u);
  assert.doesNotMatch(explorerSidebarSource, /--h5-brand|font-weight: 650/u);
  assert.match(explorerSidebarSource, /grid-template-columns: minmax\(0, 1fr\) repeat\(2, 40px\)/u);
  // 「显示隐藏文件」在移动版保留；文件索引自动构建，不再提供手动重建按钮。
  assert.doesNotMatch(explorerSidebarSource, /--h5 \.explorer-sidebar__hidden-toggle/u);
  assert.doesNotMatch(explorerSidebarSource, /重建文件索引/u);
  assert.match(explorerSidebarSource, /toolbar-icon-btn\.explorer-sidebar__hidden-toggle--active/u);
});

test("H5 file search follows the active color theme", () => {
  assert.match(
    explorerSidebarSource,
    /\.explorer-sidebar--h5 \.explorer-sidebar__search :deep\(\.ant-input-affix-wrapper \.ant-input\) \{[\s\S]*color: var\(--app-text\);[\s\S]*background: transparent;/u,
  );
  assert.match(explorerSidebarSource, /background: color-mix\(in srgb, var\(--app-panel-bg\) 94%, var\(--app-bg\)\);/u);
  assert.match(explorerSidebarSource, /\.ant-input::placeholder\)[\s\S]*color: var\(--app-muted\);/u);
  assert.match(explorerSidebarSource, /\.ant-input-affix-wrapper-focused\)[\s\S]*box-shadow: var\(--app-ring\);/u);
});

test("mobile layout isolates the H5 files shell from standard mobile", () => {
  assert.match(layoutSource, /<H5FilesPanel[\s\S]+v-if="isH5Surface"/u);
  assert.match(layoutSource, /v-if="!hasWorkspace"[\s\S]+<ExplorerPanel v-else/u);
  assert.match(layoutSource, /tab: 'workspaces'/u);
});
