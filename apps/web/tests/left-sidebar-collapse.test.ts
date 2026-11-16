import assert from "node:assert/strict";
import test from "node:test";

import {
  LEFT_SIDEBAR_COLLAPSED_RAIL_WIDTH,
  resolveLeftSidebarTrackWidth,
} from "../src/layouts/desktop/desktop-panel-sizing.ts";
import { migrateUiRightPanelState } from "../src/store/ui.ts";

function createStorage(initial: Record<string, unknown>): Storage {
  let value = JSON.stringify(initial);
  return {
    getItem: () => value,
    setItem: (_key, nextValue) => { value = nextValue; },
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    get length() { return 1; },
  } as Storage;
}

test("left sidebar track collapses to zero without changing width preference", () => {
  assert.equal(LEFT_SIDEBAR_COLLAPSED_RAIL_WIDTH, 0);
  assert.equal(resolveLeftSidebarTrackWidth({ collapsed: true, effectiveLeftWidth: 520 }), 0);
  assert.equal(resolveLeftSidebarTrackWidth({ collapsed: false, effectiveLeftWidth: 487 }), 487);
  assert.equal(resolveLeftSidebarTrackWidth({ collapsed: false, effectiveLeftWidth: Number.NaN }), 360);
});

test("UI migration keeps the phase 1 width and strictly normalizes the shared collapse preference", () => {
  const storage = createStorage({
    leftSidebarWidth: 480,
    leftSidebarCollapsed: true,
    inspectorWidth: 420,
  });
  migrateUiRightPanelState(storage);
  const migrated = JSON.parse(storage.getItem("ui") ?? "{}") as Record<string, unknown>;
  assert.equal(migrated.leftSidebarWidth, 480);
  assert.equal(migrated.leftSidebarCollapsed, true);

  const invalidStorage = createStorage({
    leftSidebarWidth: 490,
    leftSidebarCollapsed: "true",
  });
  migrateUiRightPanelState(invalidStorage);
  const normalized = JSON.parse(invalidStorage.getItem("ui") ?? "{}") as Record<string, unknown>;
  assert.equal(normalized.leftSidebarWidth, 490);
  assert.equal(normalized.leftSidebarCollapsed, false);
});
