import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { message } from "ant-design-vue";
import type { ChatWorkflowView, DesktopApiRequest, ThreadId, WorkspaceId } from "@codeflowai/shared";
import type { ApiRequestContext } from "../src/api/request.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";

const workspaceId = "desktop:project" as WorkspaceId;
const threadId = "desktop-workflow" as ThreadId;
const ctx: ApiRequestContext = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };

/** 只替换 preload/网络边界，保留真实 store、自然意图预检和 API 路由。 */
function fixture(t: test.TestContext, failure = false) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  const view = { task: { id: "task", version: 2, state: "linked" }, status: "waiting-feedback", todos: [
    { nodeId: "design", version: "v1", actions: [{ action: "resume_with_input" }] },
  ] } as unknown as ChatWorkflowView;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      if (failure) return { status: 409, body: { ok: false, code: "CHAT_WORKFLOW_TODO_EXPIRED", message: "工作流待办已变化" } };
      if (String(request.method) === "orch.chat.natural") return { status: 200, body: { ok: true, handled: true, action: "feedback", view: { ...view, status: "running", todos: [] } } };
      throw new Error(`意外执行普通发送：${request.method}`);
    },
  } } });
  t.after(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机工作流不能请求 Server"); });
  t.mock.method(message, "success", () => {});
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "desktop-process", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "test", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  const chat = useChatStore();
  chat.upsertThreadSummary({ id: threadId, title: "本机流程", engine: "codex", threadType: "chat", threadSubtype: null, archived: false, createdAt: 1, updatedAt: 1 } as never);
  chat.setChatWorkflowSnapshot(threadId, { recommendationEnabled: true, tasks: [view] });
  return { chat, requests, config };
}

test("断云本机的唯一待补充消息交给工作流，不创建普通 AI 回合", async t => {
  const h = fixture(t);
  assert.equal(await h.chat.sendMessage(ctx, { workspaceId, threadId, text: "使用 PostgreSQL 保存服务端数据", workMode: "general" }), null);
  assert.deepEqual(h.requests.map(request => request.method), ["orch.chat.natural"]);
  assert.equal(h.requests[0]?.body?.text, "使用 PostgreSQL 保存服务端数据");
  assert.equal(h.chat.chatWorkflowSnapshotByThreadId[threadId]?.tasks[0]?.status, "running");
  assert.equal(h.config.connected, false);
});

test("本机工作流失败显式抛出，不能继续普通消息副作用", async t => {
  const h = fixture(t, true);
  await assert.rejects(h.chat.sendMessage(ctx, { workspaceId, threadId, text: "补充：使用现有数据库", workMode: "general" }), /工作流待办已变化/u);
  assert.deepEqual(h.requests.map(request => request.method), ["orch.chat.natural"]);
  assert.equal(h.chat.threadHasRealTurnActivityByThreadId[threadId], undefined);
});

test("本机执行端恢复就绪立即解除工作流查询退避，远程会话不受本机通知影响", () => {
  const source = readFileSync(new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url), "utf8");
  const script = source.split("</script>")[0]!.replace(/^<script setup lang="ts">/u, "");
  const ast = ts.createSourceFile("panel.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const watchers = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "watch"
    && ts.isArrowFunction(node.expression.arguments[0]!));
  const registered: Array<{ read: () => unknown; changed: (current: any, previous: any) => void }> = [];
  const config = { localRuntimeReady: false, desktopClient: { clientId: "desktop", connectedAt: 1, workspaceIds: [workspaceId] }, connectionStatus: "disconnected" };
  const polls: number[] = [];
  let invalidations = 0;
  const sandbox = {
    props: { workspaceId, threadId }, config, isDesktopWorkspace,
    presence: { clientForWorkspace: () => null, runtimeStateForWorkspace: () => ({ status: "offline" }) },
    chat: { threadWorkflowByThreadId: {} },
    watch: (read: () => unknown, changed: (current: any, previous: any) => void) => registered.push({ read, changed }),
    poll: (generation: number) => { polls.push(generation); }, invalidateCurrentRefresh: () => { invalidations++; },
    generation: 3, failures: 4, failureCode: "INTERNAL_ERROR",
  };
  vm.runInNewContext(ts.transpileModule(watchers.map(node => node.getText(ast)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, sandbox);
  const previous = registered.map(watcher => watcher.read());
  config.localRuntimeReady = true;
  registered.forEach((watcher, index) => {
    const current = watcher.read();
    if (JSON.stringify(current) !== JSON.stringify(previous[index])) watcher.changed(current, previous[index]);
  });
  assert.deepEqual(polls, [3]);
  assert.equal(invalidations, 1);
  assert.equal(sandbox.failureCode, null);
  assert.equal(sandbox.failures, 0);
  sandbox.props.workspaceId = "remote:project" as WorkspaceId;
  const beforeReconnect = registered.map(watcher => watcher.read());
  config.desktopClient.connectedAt++;
  registered.forEach((watcher, index) => {
    const current = watcher.read();
    if (JSON.stringify(current) !== JSON.stringify(beforeReconnect[index])) watcher.changed(current, beforeReconnect[index]);
  });
  assert.deepEqual(polls, [3]);
});
