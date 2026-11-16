import assert from "node:assert/strict";
import test from "node:test";

import {
  isNamespacedLocalWorkspaceId,
  prefixLocalWorkspaceId,
  workspaceIdAliasChain,
} from "../../packages/shared/src/utils/workspaceId.ts";

import {
  isSharedWorkspaceSelectionId,
  makeSharedWorkspaceSelectionId,
  pickPreferredWorkspaceId,
  parseSharedWorkspaceSelectionId,
  resolveStickyWorkspaceSelection,
  resolveWorkspaceSelectionAfterRefresh,
  resolveWorkspaceIdAlias,
  workspaceIdMatchesCurrentSelection,
  workspaceIdsContainMatch,
  workspaceIdsReferToSameWorkspace,
} from "../../apps/web/src/utils/workspaceId.ts";

test("workspace ids match across legacy and client-prefixed formats", () => {
  assert.equal(workspaceIdsReferToSameWorkspace("SUNNY:ws-demo", "ws-demo"), true);
  assert.equal(workspaceIdsReferToSameWorkspace("SUNNY:ws-demo", "SUNNY:ws-demo"), true);
  assert.equal(workspaceIdsReferToSameWorkspace("SUNNY:ws-demo", "SUNNY:ws-other"), false);
});

test("workspace ids match across nested namespace prefixes", () => {
  assert.equal(
    workspaceIdsReferToSameWorkspace("DESKTOP-UUA69CE:devlocal:DESKTOP-UUA69CE:ws-local", "DESKTOP-UUA69CE:ws-local"),
    true,
  );
  assert.equal(
    workspaceIdsReferToSameWorkspace("DESKTOP-UUA69CE:devlocal:DESKTOP-UUA69CE:ws-local", "ws-local"),
    true,
  );
});

test("workspace id prefixing only migrates true legacy local ids", () => {
  assert.equal(prefixLocalWorkspaceId("DESKTOP", "ws-local"), "DESKTOP:ws-local");
  assert.equal(prefixLocalWorkspaceId("DESKTOP", "DESKTOP:ws-local"), "DESKTOP:ws-local");
  assert.equal(prefixLocalWorkspaceId("DESKTOP", "OTHER:ws-local"), "OTHER:ws-local");
  assert.equal(prefixLocalWorkspaceId("DESKTOP", "DESKTOP:codex:DESKTOP:ws-local"), "DESKTOP:codex:DESKTOP:ws-local");
  assert.equal(prefixLocalWorkspaceId("DESKTOP", "shared:sw-demo"), "shared:sw-demo");
});

test("workspace id namespace helpers expose nested aliases without collapsing shared selections", () => {
  assert.equal(isNamespacedLocalWorkspaceId("DESKTOP:ws-local"), true);
  assert.equal(isNamespacedLocalWorkspaceId("ws-local"), false);
  assert.equal(isNamespacedLocalWorkspaceId("shared:sw-demo"), false);
  assert.deepEqual(
    workspaceIdAliasChain("DESKTOP:codex:DESKTOP:ws-local"),
    ["DESKTOP:codex:DESKTOP:ws-local", "codex:DESKTOP:ws-local", "DESKTOP:ws-local", "ws-local"],
  );
  assert.deepEqual(workspaceIdAliasChain("shared:sw-demo"), ["shared:sw-demo"]);
});

test("shared workspace selection ids are not treated as client-prefixed local aliases", () => {
  const sharedId = makeSharedWorkspaceSelectionId("sw-demo");
  assert.equal(sharedId, "shared:sw-demo");
  assert.equal(isSharedWorkspaceSelectionId(sharedId), true);
  assert.equal(parseSharedWorkspaceSelectionId(sharedId), "sw-demo");
  assert.equal(workspaceIdsReferToSameWorkspace(sharedId, "sw-demo"), false);
  assert.equal(resolveWorkspaceIdAlias(sharedId, ["sw-demo"]), null);
});

test("workspace id alias resolves to a unique canonical workspace id", () => {
  assert.equal(
    resolveWorkspaceIdAlias("ws-demo", ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"]),
    "SUNNY:ws-demo",
  );
  assert.equal(
    resolveWorkspaceIdAlias(
      "DESKTOP-UUA69CE:ws-local",
      ["DESKTOP-UUA69CE:devlocal:DESKTOP-UUA69CE:ws-local"],
    ),
    "DESKTOP-UUA69CE:devlocal:DESKTOP-UUA69CE:ws-local",
  );
});

test("workspace id alias does not resolve when multiple clients share the same local id", () => {
  assert.equal(
    resolveWorkspaceIdAlias("ws-demo", ["SUNNY:ws-demo", "OTHER:ws-demo"]),
    null,
  );
  assert.equal(
    resolveWorkspaceIdAlias(
      "ws-local",
      [
        "DESKTOP-UUA69CE:devlocal:DESKTOP-UUA69CE:ws-local",
        "LAPTOP-02:devlocal:LAPTOP-02:ws-local",
      ],
    ),
    null,
  );
});

test("workspace id matching works against online client workspace lists", () => {
  assert.equal(
    workspaceIdsContainMatch(["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"], "ws-demo"),
    true,
  );
  assert.equal(
    workspaceIdsContainMatch(["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"], "ws-missing"),
    false,
  );
});

test("preferred workspace keeps current selection when it is still valid", () => {
  assert.equal(
    pickPreferredWorkspaceId(
      ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"],
      ["SUNNY:ws_d941c4da6b"],
      "ws-demo",
    ),
    "SUNNY:ws-demo",
  );
});

test("preferred workspace falls back to an online workspace when current selection is missing", () => {
  assert.equal(
    pickPreferredWorkspaceId(
      ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"],
      ["SUNNY:ws_d941c4da6b"],
      "ws-missing",
    ),
    "SUNNY:ws_d941c4da6b",
  );
});

test("sticky workspace selection falls back to another client owning the same local id", () => {
  assert.equal(
    resolveStickyWorkspaceSelection({
      currentWorkspaceId: "SUNNY:ws-demo",
      candidates: ["OTHER:ws-demo"],
      onlineWorkspaceIds: ["OTHER:ws-demo"],
    }),
    "OTHER:ws-demo",
  );
});

test("current workspace matching does not collapse same local id across clients", () => {
  assert.equal(workspaceIdMatchesCurrentSelection("SUNNY:ws-demo", "OTHER:ws-demo"), false);
  assert.equal(workspaceIdMatchesCurrentSelection("ws-demo", "SUNNY:ws-demo"), true);
  assert.equal(
    workspaceIdMatchesCurrentSelection("DESKTOP:ws-local", "DESKTOP:devlocal:DESKTOP:ws-local"),
    true,
  );
});

test("sticky workspace selection falls back only when explicit deletion allows it", () => {
  assert.equal(
    resolveStickyWorkspaceSelection({
      currentWorkspaceId: "SUNNY:ws-demo",
      candidates: ["OTHER:ws-other"],
      onlineWorkspaceIds: ["OTHER:ws-other"],
      allowFallbackForMissingCurrent: true,
    }),
    "OTHER:ws-other",
  );
});

test("sticky workspace selection still picks an online workspace when there is no current selection", () => {
  assert.equal(
    resolveStickyWorkspaceSelection({
      currentWorkspaceId: "",
      candidates: ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"],
      onlineWorkspaceIds: ["SUNNY:ws-demo"],
    }),
    "SUNNY:ws-demo",
  );
});

test("preferred workspace falls back to the first workspace when none are online", () => {
  assert.equal(
    pickPreferredWorkspaceId(
      ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"],
      [],
      "",
    ),
    "SUNNY:ws_d941c4da6b",
  );
});

test("refresh keeps current workspace when the refreshed list is temporarily empty", () => {
  assert.equal(
    resolveWorkspaceSelectionAfterRefresh("SUNNY:ws-demo", []),
    "SUNNY:ws-demo",
  );
});

test("refresh resolves the current workspace to a canonical alias when available", () => {
  assert.equal(
    resolveWorkspaceSelectionAfterRefresh("ws-demo", ["SUNNY:ws_d941c4da6b", "SUNNY:ws-demo"]),
    "SUNNY:ws-demo",
  );
});
