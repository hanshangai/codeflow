import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceIdAfterScopedRestore, resolveWorkspaceSwitchReloadUrl } from "../src/store/config.ts";
import { pickInitialWorkspaceIdByCreatedAt } from "../src/store/workspaces.ts";
import { resolveStickyWorkspaceSelection, resolveWorkspaceSelectionAfterRefresh } from "../src/utils/workspaceId.ts";

test("知识页切项目后刷新固定新项目并清除旧会话和审批", () => {
  const url = new URL(resolveWorkspaceSwitchReloadUrl("http://localhost:39281/knowledge?workspaceId=project-a&threadId=old&executionThreadId=execution&changeId=change&view=assets", "project-b"));
  assert.equal(url.searchParams.get("workspaceId"), "project-b");
  assert.equal(url.searchParams.get("view"), "assets");
  for (const key of ["threadId", "executionThreadId", "changeId"]) assert.equal(url.searchParams.has(key), false);
  assert.equal(resolveWorkspaceSwitchReloadUrl(url.href, "project-b"), url.href);
  const cleared = new URL(resolveWorkspaceSwitchReloadUrl(url.href, ""));
  assert.equal(cleared.searchParams.has("workspaceId"), false);
  const publicUrl = "http://localhost:39281/best-practices?threadId=development";
  assert.equal(resolveWorkspaceSwitchReloadUrl(publicUrl, "project-b"), publicUrl);
});

test("聊天页切工作区后同步地址并清除旧会话和待办目标", () => {
  const url = new URL(resolveWorkspaceSwitchReloadUrl("http://localhost:39281/chat?workspaceId=main&threadId=old&targetId=old-target&tab=pending#details", "client:monitor"));
  assert.equal(url.pathname, "/chat");
  assert.equal(url.searchParams.get("workspaceId"), "client:monitor");
  assert.equal(url.searchParams.has("threadId"), false);
  assert.equal(url.searchParams.has("targetId"), false);
  assert.equal(url.searchParams.get("tab"), "pending");
  assert.equal(url.hash, "#details");
  assert.equal(resolveWorkspaceSwitchReloadUrl(url.href, "client:monitor"), url.href);
  const cleared = new URL(resolveWorkspaceSwitchReloadUrl(url.href, ""));
  assert.equal(cleared.searchParams.has("workspaceId"), false);
});

test("聊天页没有工作区参数时，主动切换也写入新工作区", () => {
  const url = new URL(resolveWorkspaceSwitchReloadUrl("http://localhost:39281/chat", "shared:monitor"));
  assert.equal(url.searchParams.get("workspaceId"), "shared:monitor");
});

test("account-scoped workspace restore does not fall back to build default without history", () => {
  assert.equal(resolveWorkspaceIdAfterScopedRestore({
    restoredWorkspaceId: "",
    hasAccountWorkspaceScope: true,
    defaultWorkspaceId: "ws-demo",
  }), "");

  assert.equal(resolveWorkspaceIdAfterScopedRestore({
    restoredWorkspaceId: "",
    hasAccountWorkspaceScope: false,
    defaultWorkspaceId: "ws-demo",
  }), "ws-demo");

  assert.equal(resolveWorkspaceIdAfterScopedRestore({
    restoredWorkspaceId: "client-a:real-workspace",
    hasAccountWorkspaceScope: true,
    defaultWorkspaceId: "ws-demo",
  }), "client-a:real-workspace");
});

test("initial workspace selection uses newest created workspace", () => {
  assert.equal(pickInitialWorkspaceIdByCreatedAt([
    { id: "client-a:old", createdAt: 100 },
    { id: "client-a:new", createdAt: 300 },
    { id: "client-a:middle", createdAt: 200 },
  ] as any), "client-a:new");
});

test("initial workspace selection keeps response order for equal createdAt", () => {
  assert.equal(pickInitialWorkspaceIdByCreatedAt([
    { id: "client-a:first", createdAt: 100 },
    { id: "client-a:second", createdAt: 100 },
  ] as any), "client-a:first");
});

test("authoritative empty workspace refresh clears stale selection", () => {
  assert.equal(resolveWorkspaceSelectionAfterRefresh("client-a:ws-demo", [], { authoritativeEmpty: true }), null);
});

test("non-authoritative empty workspace refresh keeps current selection", () => {
  assert.equal(resolveWorkspaceSelectionAfterRefresh("client-a:ws-demo", [], { authoritativeEmpty: false }), "client-a:ws-demo");
});

test("authoritative workspace refresh clears stale local selection when candidates exist", () => {
  assert.equal(resolveWorkspaceSelectionAfterRefresh("client-a:ws-demo", ["shared:one"], { authoritativeCandidates: true }), null);
});

test("non-authoritative workspace refresh keeps stale local selection while clients recover", () => {
  assert.equal(resolveWorkspaceSelectionAfterRefresh("client-a:ws-demo", ["shared:one"], { authoritativeCandidates: false }), "client-a:ws-demo");
});

test("authoritative workspace refresh keeps shared selection for shared-only lists", () => {
  assert.equal(resolveWorkspaceSelectionAfterRefresh("shared:one", ["shared:two"], { authoritativeCandidates: true }), "shared:one");
});

test("stale workspace selection falls back to an online candidate when current selection is missing", () => {
  assert.equal(resolveStickyWorkspaceSelection({
    currentWorkspaceId: "client-a:stale",
    candidates: ["client-b:online", "client-c:offline"],
    onlineWorkspaceIds: ["client-b:online"],
  }), "client-b:online");
});

test("current workspace stays put when it is still in the candidate list", () => {
  assert.equal(resolveStickyWorkspaceSelection({
    currentWorkspaceId: "client-a:current",
    candidates: ["client-a:current", "client-b:online"],
    onlineWorkspaceIds: ["client-b:online"],
  }), "client-a:current");
});
