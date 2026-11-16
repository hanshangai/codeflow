import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");
const historySource = fs.readFileSync("apps/web/src/features/office-h5/components/H5ThreadHistoryPanel.vue", "utf8");
const preferencesSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5ThreadPreferencesPanel.vue", "utf8");
const chatPanelSource = fs.readFileSync("apps/web/src/features/chat/components/chat-panel.vue", "utf8");
const composerSource = fs.readFileSync("apps/web/src/features/composer/components/chat-composer.vue", "utf8");
const messageItemSource = fs.readFileSync("apps/web/src/features/messages/components/items/message-item.vue", "utf8");

test("H5 chat menu exposes history search and conversation preferences", () => {
  assert.match(layoutSource, /搜索会话历史/u);
  assert.match(layoutSource, /会话设置/u);
  assert.match(layoutSource, /openH5ThreadTool\('thread-history'\)/u);
  assert.match(layoutSource, /openH5ThreadTool\('thread-preferences'\)/u);
  assert.match(layoutSource, /<H5ThreadHistoryPanel/u);
  assert.match(layoutSource, /<H5ThreadPreferencesPanel/u);
});

test("history search supports keyword, date scopes, pagination and message location", () => {
  for (const label of ["全部时间", "今天", "近 7 天", "近 30 天", "自定义", "加载更早消息"]) {
    assert.match(historySource, new RegExp(label, "u"));
  }
  assert.match(historySource, /chat\.loadThreadPage/u);
  assert.match(layoutSource, /locateThreadMessage/u);
  // 暴露项可随会话切换需要扩展，但 locateMessage 必须保留，否则历史搜索无法定位消息。
  assert.match(chatPanelSource, /defineExpose\(\{[^}]*\blocateMessage\b[^}]*\}\)/u);
  assert.match(messageItemSource, /:data-message-id="String\(item\.id\)"/u);
});

test("conversation preferences reuse model, Agent and thread preference owners", () => {
  for (const label of ["Agent", "模型", "推理强度", "计划模式"]) {
    assert.match(preferencesSource, new RegExp(label, "u"));
  }
  assert.match(preferencesSource, /engines\.refresh/u);
  assert.match(preferencesSource, /orchestration\.refreshRoles/u);
  assert.match(preferencesSource, /chat\.patchThreadPrefs/u);
  assert.match(preferencesSource, /chat\.saveThreadPrefs/u);
  assert.match(preferencesSource, /finally\s*\{/u);
});

test("H5 thread subpages keep a fixed back header and internal scrolling", () => {
  assert.match(layoutSource, /mobile-page__header--centered/u);
  assert.match(layoutSource, /mobile-page__back mobile-page__back--plain/u);
  assert.match(historySource, /height: 100%; min-height: 0/u);
  assert.match(historySource, /overflow-y: auto/u);
  assert.match(preferencesSource, /height: 100%; min-height: 0; overflow-y: auto/u);
});

test("H5 thread detail uses its dedicated header, action sheet and compact composer", () => {
  assert.match(layoutSource, /mobile-page--h5-chat/u);
  assert.match(layoutSource, /h5-thread-menu-drawer/u);
  assert.match(layoutSource, /Agent、模型、强度与计划模式/u);
  assert.match(layoutSource, /:surface="isH5Surface \? 'h5' : 'default'"/u);
  assert.match(chatPanelSource, /chat-panel--h5/u);
  assert.match(chatPanelSource, /:surface="props\.surface"/u);
  assert.match(composerSource, /composer--h5/u);
  assert.match(composerSource, /props\.surface !== 'h5'/u);
  assert.match(composerSource, /PaperClipOutlined/u);
  assert.match(composerSource, /SendOutlined/u);
});
