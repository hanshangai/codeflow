import test from "node:test";
import assert from "node:assert/strict";

import { collectPresenceWorkspaceIds, shouldRefreshWorkspacesForPresence } from "../src/services/workspaceRefreshPolicy.ts";

test("collectPresenceWorkspaceIds unions workspace ids across multiple clients", () => {
  const workspaceIds = collectPresenceWorkspaceIds([
    { workspaceIds: ["client-a:ws-1", "client-a:ws-2"] },
    { workspaceIds: ["client-b:ws-9", "client-a:ws-2"] },
  ] as any);

  assert.deepEqual(workspaceIds, [
    "client-a:ws-1",
    "client-a:ws-2",
    "client-b:ws-9",
  ]);
});

test("presence refresh is skipped when baseline already matches current online workspace union", () => {
  const decision = shouldRefreshWorkspacesForPresence({
    loading: false,
    lastLoadedAt: 1,
    knownWorkspaceIds: ["client-a:ws-1", "client-b:ws-9"],
    onlineClients: [
      { workspaceIds: ["client-b:ws-9"] },
      { workspaceIds: ["client-a:ws-1"] },
    ] as any,
  });

  assert.deepEqual(decision, {
    shouldRefresh: false,
    reason: "unchanged",
  });
});

test("presence refresh is required when a second client contributes a new workspace", () => {
  const decision = shouldRefreshWorkspacesForPresence({
    loading: false,
    lastLoadedAt: 1,
    knownWorkspaceIds: ["client-a:ws-1"],
    onlineClients: [
      { workspaceIds: ["client-a:ws-1"] },
      { workspaceIds: ["client-b:ws-9"] },
    ] as any,
  });

  assert.deepEqual(decision, {
    shouldRefresh: true,
    reason: "workspace-set-changed",
  });
});

test("presence refresh is required when baseline is still missing", () => {
  const decision = shouldRefreshWorkspacesForPresence({
    loading: false,
    lastLoadedAt: 0,
    knownWorkspaceIds: [],
    onlineClients: [
      { workspaceIds: ["client-a:ws-1"] },
    ] as any,
  });

  assert.deepEqual(decision, {
    shouldRefresh: true,
    reason: "baseline-missing",
  });
});
