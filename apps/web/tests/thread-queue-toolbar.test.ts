import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/features/chat/components/thread-queue-bar.vue", import.meta.url),
  "utf8",
);
const chatPanelSource = readFileSync(
  new URL("../src/features/chat/components/chat-panel.vue", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

test("队列工具栏入口只显示图标、数量和展开状态", () => {
  assert.doesNotMatch(source, /class="fc-bar__chip-title"/);
  assert.match(source, /aria-label="切换队列"/);
  assert.match(source, /class="fc-bar__chip-count">\{\{ items\.length \}\}/);
});

test("入队成功后在输入框上方右侧轻提示，不自动展开队列浮层", () => {
  assert.doesNotMatch(chatPanelSource, /shouldAutoExpandThreadQueue|threadQueueAutoCollapseTimer/);
  assert.doesNotMatch(chatPanelSource, /threadQueueExpanded\.value = true/);
  assert.match(composerSource, /class="composer-queue-toast"/);
  assert.match(composerSource, /已加入队列/);
  const composerStyle = composerSource.match(/\.composer \{([^}]+)\}/)?.[1];
  const toastStyle = composerSource.match(/\.composer-queue-toast \{([^}]+)\}/)?.[1];
  assert.ok(composerStyle && toastStyle, "输入框与轻提示应有明确定位范围");
  assert.match(composerStyle, /position: relative;/);
  assert.match(toastStyle, /position: absolute;/);
  assert.match(toastStyle, /right: 0;/);
  assert.match(toastStyle, /bottom: calc\(100% \+ 10px\);/);
  assert.match(composerSource, /v-if="queueAppendedToast" class="composer-queue-toast" role="status" aria-live="polite"/);
  assert.match(composerSource, /queueAppendedToastTimer = setTimeout\(\(\) => \{\s*queueAppendedToastTimer = null;\s*queueAppendedToast\.value = null;/);
});

test("节点会话隐藏通用队列控制面板", () => {
  assert.match(
    chatPanelSource,
    /threadQueueCount\.value > 0 && thread\.value\?\.threadSubtype !== "node"/,
  );
});

test("历史会话暂停不伪装成永久失效并允许继续投递", () => {
  assert.match(source, /case "session_invalidated": return "会话发送已暂停"/);
  assert.match(source, /v-if="paused && pendingItems\.length > 0"/);
  assert.doesNotMatch(source, /请新建会话/);
  assert.doesNotMatch(source, /pausedReason !== 'session_invalidated'/);
});
