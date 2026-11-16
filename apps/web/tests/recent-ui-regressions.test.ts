import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("new conversation defaults to Codex and keeps Codex first", () => {
  const modalSource = fs.readFileSync("apps/web/src/features/threads/components/create-thread-modal.vue", "utf8");
  const listSource = fs.readFileSync("apps/web/src/features/threads/components/thread-list.vue", "utf8");

  assert.match(modalSource, /const ENGINE_CREATE_ORDER: EngineType\[\] = \["codex", "claude"\]/u);
  assert.match(modalSource, /const engine = ref<EngineType>\("codex"\)/u);
  assert.match(modalSource, /resolveInitialEngine\(props\.defaultEngine \?\? "codex"\)/u);
  assert.ok(
    modalSource.indexOf('<a-radio value="codex"') < modalSource.indexOf('<a-radio value="claude"'),
    "Codex should be listed before Claude in the create conversation modal",
  );
  assert.match(listSource, /<CreateThreadModal[\s\S]*?default-engine="codex"/u);
});

test("composer settings uses an accessible icon button", () => {
  const source = fs.readFileSync("apps/web/src/features/composer/components/chat-composer.vue", "utf8");

  assert.match(source, /SettingOutlined/u);
  assert.match(source, /<a-button[^>]*aria-label="设置"[^>]*title="设置"[\s\S]*?<SettingOutlined/u);
  assert.doesNotMatch(source, />⚙<\/a-button>/u);
});

// 会话面板顶部标题栏已移除，重启 Codex 入口自此只由会话列表菜单提供。
test("Codex app-server restart is exposed only from the thread list menus", () => {
  const listSource = fs.readFileSync("apps/web/src/features/threads/components/thread-list.vue", "utf8");

  assert.match(listSource, /function confirmRestartCodexAppServer\(item: ThreadSummary\)/u);
  assert.match(listSource, /function isLocalCodexThread\(item: ThreadSummary\)/u);
  assert.match(listSource, /重启 Codex（CodeFlow 未连接）/u);
  assert.match(listSource, /<a-menu-item[^>]*@click="confirmRestartCodexAppServer\(item\)"[^>]*>[\s\S]*?restartCodexMenuLabel\(\)[\s\S]*?<\/a-menu-item>/u);

  const actionMenus = [...listSource.matchAll(/<a-menu>[\s\S]*?@click="confirmClear\(item\)"[\s\S]*?<\/a-menu>/gu)].map((match) => match[0]);
  assert.equal(actionMenus.length, 2, "both thread-list layouts should expose the action menu");
  for (const menuSource of actionMenus) {
    const clearIndex = menuSource.indexOf('@click="confirmClear(item)"');
    const inspectorIndex = menuSource.indexOf('@click="toggleInspector"');
    const restartIndex = menuSource.indexOf('@click="confirmRestartCodexAppServer(item)"');
    const deleteIndex = menuSource.indexOf('@click="confirmDelete(item)"');
    assert.ok(clearIndex < inspectorIndex, "debug should follow clear history");
    assert.ok(inspectorIndex < restartIndex, "restart Codex should follow debug");
    assert.ok(restartIndex < deleteIndex, "delete should remain after restart Codex");
  }
});

test("thread load 回放不会用空 binding 覆盖已有引擎会话 ID", () => {
  const source = fs.readFileSync("apps/web/src/store/chat.ts", "utf8");

  assert.match(source, /assignLoadedConversationState\(state, replayed\.state\);/u);
  assert.match(source, /assignLoadedConversationState\(currentState, replayed\.state\);/u);
  assert.match(source, /const previousEngineSessionId = String\(target\.engineSessionId \?\? ""\)\.trim\(\);[\s\S]*?const replayedEngineSessionId = String\(target\.engineSessionId \?\? ""\)\.trim\(\);[\s\S]*?target\.engineSessionId = replayedEngineSessionId \|\| previousEngineSessionId \|\| null;/u);
  assert.match(source, /assignConversationState\(state, createEmptyConversationState\(threadId\)\);/u);
});

test("engine key list renders the complete key with wrapping", () => {
  const source = fs.readFileSync("apps/web/src/features/settings/components/engine-keys-panel.vue", "utf8");

  assert.match(source, /<span class="ek-panel__item-key mono">\{\{ k\.apiKey\.trim\(\) \? k\.apiKey :/u);
  assert.doesNotMatch(source, /function maskKey\(/u);
  assert.match(source, /\.ek-panel__item-key \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?word-break: break-all;/u);
});
