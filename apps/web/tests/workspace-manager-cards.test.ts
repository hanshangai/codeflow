import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const managerSource = readFileSync(new URL("../src/features/workspaces/components/workspace-manager.vue", import.meta.url), "utf8");

test("WorkspaceManager keeps the selection contract and no wizard-only props", () => {
  assert.match(managerSource, /\(e:\s*"selected",\s*workspaceId:\s*WorkspaceId\)/u);
  assert.match(managerSource, /isSharedWorkspaceSelectionId\(workspace\.id\)/u);
  assert.match(managerSource, /flushDrafts:\s*true/u);
  assert.match(managerSource, /workspaces\.refresh\(ctx\.value, \{ silent: true \}\)/u);
  // 向导步骤已删除，这三个 props 不再有任何调用方传非默认值。
  assert.doesNotMatch(managerSource, /kindScope/u);
  assert.doesNotMatch(managerSource, /reloadOnSelect/u);
  assert.doesNotMatch(managerSource, /showMaintenanceActions/u);
});

test("WorkspaceManager card actions use native button semantics without nested interactive controls", () => {
  assert.match(managerSource, /<button\s+class="ws-manager__card-select"[\s\S]*?:aria-pressed="w\.id === config\.workspaceId"/u);
  assert.match(managerSource, /<button class="ws-manager__card ws-manager__card--add" type="button" aria-label=/u);
  assert.match(managerSource, /<\/button>\s*<div class="ws-manager__card-actions">/u);
  assert.doesNotMatch(managerSource, /<div[^>]*class="ws-manager__card"[^>]*@click=/u);
});
