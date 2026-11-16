import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "../support/web-pinia.ts";
import { terminalKey, useTerminalStore } from "../../apps/web/src/store/terminal.js";

function terminal(clientId: string, workspaceId: string, id: string, createdAt: number) {
  return {
    clientId,
    workspaceId,
    id,
    label: `${workspaceId}/${id}`,
    shell: "pwsh",
    cwd: `D:/${workspaceId}`,
    status: "running" as const,
    exitCode: null,
    createdAt,
    foregroundProcess: null,
  };
}

function createStore() {
  setActivePinia(createPinia());
  return useTerminalStore();
}

test("账号级 Store 使用复合键保留不同 Client 的同名终端", () => {
  const store = createStore();
  const first = terminal("client-a", "workspace-a", "terminal-1", 1);
  const second = terminal("client-b", "workspace-b", "terminal-1", 2);
  store.onTerminalCreated(first);
  store.onTerminalCreated(second);

  assert.equal(store.terminals.length, 2);
  assert.notEqual(terminalKey(first), terminalKey(second));
  assert.equal(store.activeTerminalKey, terminalKey(first));
});

test("账号级列表只替换成功目标，失败目标保留缓存", () => {
  const store = createStore();
  const cachedA = terminal("client-a", "workspace-a", "terminal-old-a", 1);
  const cachedB = terminal("client-b", "workspace-b", "terminal-old-b", 2);
  store.onTerminalCreated(cachedA);
  store.onTerminalCreated(cachedB);
  store.beginListAll("request-1");
  store.onTerminalListAllResult({
    t: "terminal.listAll.result",
    requestId: "request-1",
    targets: [
      { clientId: "client-a", workspaceId: "workspace-a" },
      { clientId: "client-b", workspaceId: "workspace-b" },
    ],
    terminals: [terminal("client-a", "workspace-a", "terminal-new-a", 3)],
    failures: [{ clientId: "client-b", workspaceId: "workspace-b", message: "Client 已离线" }],
  });

  assert.deepEqual(store.terminals.map((item) => item.id), ["terminal-old-b", "terminal-new-a"]);
  assert.equal(store.listFailures.length, 1);
  assert.equal(store.listLoading, false);
});

test("迟到的旧 requestId 结果不会覆盖最新终端列表", () => {
  const store = createStore();
  store.beginListAll("request-new");
  store.onTerminalListAllResult({
    t: "terminal.listAll.result",
    requestId: "request-old",
    targets: [{ clientId: "client-a", workspaceId: "workspace-a" }],
    terminals: [terminal("client-a", "workspace-a", "terminal-old", 1)],
    failures: [],
  });

  assert.equal(store.terminals.length, 0);
  assert.equal(store.listLoading, true);
  assert.equal(store.listRequestId, "request-new");
});

test("没有活动请求或 Store reset 后均拒绝迟到聚合结果", () => {
  const store = createStore();
  const lateResult = {
    t: "terminal.listAll.result" as const,
    requestId: "request-late",
    targets: [{ clientId: "client-a", workspaceId: "workspace-a" }],
    terminals: [terminal("client-a", "workspace-a", "terminal-late", 1)],
    failures: [],
  };

  store.onTerminalListAllResult(lateResult);
  assert.equal(store.terminals.length, 0);

  store.beginListAll("request-late");
  store.$reset();
  store.onTerminalListAllResult(lateResult);
  assert.equal(store.terminals.length, 0);
  assert.equal(store.listLoading, false);
});

test("旧账号列表超时不会覆盖后续请求状态", () => {
  const store = createStore();
  store.beginListAll("request-old");
  store.beginListAll("request-new");
  store.failListAll("request-old", "旧请求超时");
  assert.equal(store.listLoading, true);
  assert.equal(store.listRequestId, "request-new");
  assert.deepEqual(store.listFailures, []);
});

test("Client 离线仅改变可操作状态，不删除缓存终端", () => {
  const store = createStore();
  const item = terminal("client-a", "workspace-a", "terminal-1", 1);
  store.onTerminalCreated(item);
  store.syncOnlineClients(["client-a"]);
  assert.equal(store.isTerminalOnline(item), true);
  assert.equal(store.hasOnlineRunningTerminal, true);

  store.syncOnlineClients([]);
  assert.equal(store.terminals.length, 1);
  assert.equal(store.isTerminalOnline(item), false);
  assert.equal(store.hasOnlineRunningTerminal, false);
  assert.equal(store.hasOfflineCachedTerminal, true);
});

test("部分 Client 离线时保留灰点条件，在线运行绿点优先由视图决定", () => {
  const store = createStore();
  store.onTerminalCreated(terminal("client-a", "workspace-a", "terminal-a", 1));
  store.onTerminalCreated(terminal("client-b", "workspace-b", "terminal-b", 2));
  store.syncOnlineClients(["client-a"]);
  assert.equal(store.hasOnlineRunningTerminal, true);
  assert.equal(store.hasOfflineCachedTerminal, true);
});

test("关闭活动终端后优先选择右侧相邻终端", () => {
  const store = createStore();
  const first = terminal("client-a", "workspace-a", "terminal-1", 1);
  const second = terminal("client-a", "workspace-a", "terminal-2", 2);
  const third = terminal("client-a", "workspace-a", "terminal-3", 3);
  store.onTerminalCreated(first);
  store.onTerminalCreated(second);
  store.onTerminalCreated(third);
  store.selectTerminal(second);
  store.onTerminalClosed(second.clientId, second.workspaceId, second.id);

  assert.equal(store.activeTerminalKey, terminalKey(third));
});

test("当前工作区过滤只影响展示，不删除其他终端", () => {
  const store = createStore();
  store.onTerminalCreated(terminal("client-a", "workspace-a", "terminal-a", 1));
  store.onTerminalCreated(terminal("client-a", "workspace-b", "terminal-b", 2));
  store.setFilterMode("currentWorkspace");

  assert.deepEqual(store.visibleTerminals("workspace-a").map((item) => item.id), ["terminal-a"]);
  assert.equal(store.terminals.length, 2);
});

test("相同 workspaceId 在不同 Client 下分别恢复活动终端", () => {
  const store = createStore();
  const first = terminal("client-a", "workspace-same", "terminal-a", 1);
  const second = terminal("client-b", "workspace-same", "terminal-b", 2);
  store.onTerminalCreated(first);
  store.onTerminalCreated(second);
  store.selectTerminal(second);
  store.selectTerminal(first);

  assert.equal(store.restoreWorkspaceActiveTerminal("workspace-same", "client-a"), true);
  assert.equal(store.activeTerminalKey, terminalKey(first));
  assert.equal(store.restoreWorkspaceActiveTerminal("workspace-same", "client-b"), true);
  assert.equal(store.activeTerminalKey, terminalKey(second));
});

test("权威目标移除后清理终端缓存和失效活动记忆", () => {
  const store = createStore();
  const removed = terminal("client-a", "workspace-a", "terminal-a", 1);
  const retained = terminal("client-b", "workspace-b", "terminal-b", 2);
  store.onTerminalCreated(removed);
  store.onTerminalCreated(retained);
  store.reconcileKnownTargets([{ clientId: "client-b", workspaceId: "workspace-b" }]);

  assert.deepEqual(store.terminals.map((item) => item.id), ["terminal-b"]);
  assert.equal(store.restoreWorkspaceActiveTerminal("workspace-a", "client-a"), false);
});

test("单工作区列表只接受最新 requestId", () => {
  const store = createStore();
  store.beginWorkspaceList("client-a", "workspace-a", "request-new");
  store.onTerminalListed("client-a", "workspace-a", "request-old", [
    { ...terminal("client-a", "workspace-a", "terminal-old", 1), scrollback: "old" },
  ]);
  assert.equal(store.terminals.length, 0);

  store.onTerminalListed("client-a", "workspace-a", "request-new", [
    { ...terminal("client-a", "workspace-a", "terminal-new", 2), scrollback: "new" },
  ]);
  assert.deepEqual(store.terminals.map((item) => item.id), ["terminal-new"]);

  store.onTerminalListed("client-a", "workspace-a", "request-new", [
    { ...terminal("client-a", "workspace-a", "terminal-duplicate", 3), scrollback: "duplicate" },
  ]);
  assert.deepEqual(store.terminals.map((item) => item.id), ["terminal-new"]);
});

test("旧 Client 无 requestId 仅在本窗口存在目标等待时兼容", () => {
  const store = createStore();
  store.onTerminalListed("client-a", "workspace-a", undefined, [
    terminal("client-a", "workspace-a", "terminal-foreign", 1),
  ]);
  assert.equal(store.terminals.length, 0);

  store.beginWorkspaceList("client-a", "workspace-a", "request-local");
  store.onTerminalListed("client-a", "workspace-a", undefined, [
    terminal("client-a", "workspace-a", "terminal-legacy", 2),
  ]);
  assert.deepEqual(store.terminals.map((item) => item.id), ["terminal-legacy"]);
});

test("scrollback 按复合终端缓存并限制为 Client 相同上限", () => {
  const store = createStore();
  const item = terminal("client-a", "workspace-a", "terminal-a", 1);
  store.beginWorkspaceList(item.clientId, item.workspaceId, "request-1");
  store.onTerminalListed(item.clientId, item.workspaceId, "request-1", [
    { ...item, scrollback: "initial" },
  ]);
  store.onTerminalOutput(item.clientId, item.workspaceId, item.id, "-output");
  assert.equal(store.terminalScrollback(item), "initial-output");

  store.onTerminalOutput(item.clientId, item.workspaceId, item.id, "x".repeat(60 * 1024));
  assert.equal(store.terminalScrollback(item).length, 50 * 1024);
});

test("其他 Web 创建终端只合并列表，不抢占当前活动项", () => {
  const store = createStore();
  const active = terminal("client-a", "workspace-a", "terminal-active", 1);
  const remoteCreated = terminal("client-a", "workspace-a", "terminal-remote", 2);
  store.onTerminalCreated(active);
  store.onTerminalCreated(remoteCreated);
  assert.equal(store.activeTerminalKey, terminalKey(active));
});

test("创建事件缺少可信 Client 或工作区归属时拒绝脏终端", () => {
  const store = createStore();
  store.onTerminalCreated({
    ...terminal("client-a", "workspace-a", "terminal-a", 1),
    clientId: "",
  });
  assert.equal(store.terminals.length, 0);
});

test("当前工作区过滤可按 ownerClientId 隔离同名 workspaceId", () => {
  const store = createStore();
  store.onTerminalCreated(terminal("client-a", "workspace-same", "terminal-a", 1));
  store.onTerminalCreated(terminal("client-b", "workspace-same", "terminal-b", 2));
  store.setFilterMode("currentWorkspace");
  assert.deepEqual(store.visibleTerminals("workspace-same", "client-b").map((item) => item.id), ["terminal-b"]);
});
