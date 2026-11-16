import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "../support/web-pinia.ts";
import { migrateUiRightPanelState, useUiStore } from "../../apps/web/src/store/ui.js";

function createStore() {
  setActivePinia(createPinia());
  return useUiStore();
}

test("右侧面板使用单一模式互斥切换并支持再次点击关闭", () => {
  const store = createStore();
  store.openRightPanel("explorer");
  assert.equal(store.explorerPanelVisible, true);
  assert.equal(store.inspectorVisible, false);

  store.toggleRightPanel("inspector");
  assert.equal(store.rightPanelMode, "inspector");
  assert.equal(store.explorerPanelVisible, false);
  assert.equal(store.inspectorVisible, true);

  store.toggleRightPanel("inspector");
  assert.equal(store.rightPanelMode, null);
});

test("文件、终端和 Inspector 分别记忆并限制宽度", () => {
  const store = createStore();
  store.setRightPanelWidth("explorer", 500);
  store.setRightPanelWidth("terminal", 300);
  store.setRightPanelWidth("inspector", 900);

  assert.equal(store.explorerPanelWidth, 500);
  assert.equal(store.terminalPanelWidth, 480);
  assert.equal(store.inspectorPanelWidth, 700);
});

test("旧 Inspector 优先迁移为统一模式并删除旧字段", () => {
  let value = JSON.stringify({ inspectorVisible: true, explorerPanelVisible: true, inspectorWidth: 320, themeMode: "dark" });
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  const migrated = JSON.parse(value);
  assert.equal(migrated.rightPanelMode, "inspector");
  assert.equal(migrated.inspectorPanelWidth, 320);
  assert.equal(migrated.explorerPanelWidth, 320);
  assert.equal(migrated.terminalPanelWidth, 560);
  assert.equal("inspectorVisible" in migrated, false);
  assert.equal("explorerPanelVisible" in migrated, false);
  assert.equal("inspectorWidth" in migrated, false);
  assert.equal(migrated.themeMode, "dark");
});

test("已有新右侧面板状态会保留并归一化异常宽度", () => {
  let value = JSON.stringify({ rightPanelMode: "terminal", terminalPanelWidth: "620", explorerPanelWidth: 9999 });
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  const migrated = JSON.parse(value);
  assert.equal(migrated.rightPanelMode, "terminal");
  assert.equal(migrated.terminalPanelWidth, 620);
  assert.equal(migrated.explorerPanelWidth, 700);
});

test("非法新模式和宽度回落到有效状态", () => {
  let value = JSON.stringify({ rightPanelMode: "unknown", inspectorPanelWidth: "bad" });
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  const migrated = JSON.parse(value);
  assert.equal(migrated.rightPanelMode, null);
  assert.equal(migrated.inspectorPanelWidth, 400);
});

test("左栏偏好跨入口使用同一字段，非法历史值回到默认宽度", () => {
  let value = JSON.stringify({ leftSidebarWidth: 999, rightPanelMode: null });
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  assert.equal(JSON.parse(value).leftSidebarWidth, 360);

  const store = createStore();
  store.setLeftSidebarWidth(500);
  assert.equal(store.leftSidebarWidth, 500);
});

test("损坏的 UI 持久化状态不会阻断启动并会写回规范化状态", () => {
  let value = "{broken";
  const storage = {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  assert.equal(JSON.parse(value).leftSidebarWidth, 360);
});

test("首次安装缺少 UI 持久化值时保留 Pinia 默认右侧面板", () => {
  let writes = 0;
  const storage = {
    getItem: () => null,
    setItem: () => { writes += 1; },
  } satisfies Pick<Storage, "getItem" | "setItem">;

  migrateUiRightPanelState(storage);
  assert.equal(writes, 0);
  const store = createStore();
  assert.equal(store.rightPanelMode, "explorer");
  assert.equal(store.leftSidebarWidth, 360);
});

test("UI 持久化根值为 null 或原始类型时也能安全回退", () => {
  for (const invalid of ["null", "42", "[]"]) {
    let value = invalid;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next; },
    } satisfies Pick<Storage, "getItem" | "setItem">;
    migrateUiRightPanelState(storage);
    assert.equal(JSON.parse(value).leftSidebarWidth, 360);
  }
});
