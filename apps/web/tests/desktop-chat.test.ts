import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createPinia, setActivePinia } from "pinia";
import { computed, ref } from "vue";
import { CODEX_MODELS, type DesktopApiRequest, type EngineStatus, type ThreadDraftPayload, type ThreadId, type WorkspaceId } from "@codeflowai/shared";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useThreadQueueStore } from "../src/store/threadQueue.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";
import type { ApiRequestContext } from "../src/api/request.ts";

const workspaceId = "desktop:project" as WorkspaceId;
const threadId = "desktop-chat" as ThreadId;
const ctx: ApiRequestContext = { serverWsOrigin: "ws://unused", sessionToken: null, webSessionId: null, desktopClientId: "desktop" };
const status: EngineStatus = {
  engineType: "codex", installed: true, version: "test", binPath: "codex", error: null,
  features: { streaming: true, reasoning: true, toolUse: true, imageInput: true, sessionContinuation: true },
  models: CODEX_MODELS,
  credentialStatus: { available: true, source: "local_oauth", message: null },
  providerCredentialStatus: [{ providerId: "openai", available: true, sources: ["local_oauth"], message: null }],
};

/** 只替换 preload/网络边界，保留真实 Pinia、API 路由与冻结上下文。 */
function fixture(t: test.TestContext, options: { status?: EngineStatus; reject?: DesktopApiRequest["method"] } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  let draft: ThreadDraftPayload | null = null;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => {
      requests.push(request);
      if (request.method === options.reject) return { status: 409, body: { ok: false, code: "CLIENT_ERROR", message: "本机执行端明确失败", details: { requestId: "desktop-failure" } } };
      let body: object;
      switch (request.method) {
        case "engines.status": body = { ok: true, engines: [options.status ?? status] }; break;
        case "engineKeys.list": body = { ok: true, keys: [] }; break;
        case "threads.latestPrefs": body = { ok: true, prefs: null }; break;
        case "orch.chat.natural": body = { ok: true, handled: false }; break;
        case "threads.create": body = { ok: true, threadId }; break;
        case "threads.list": body = { ok: true, threads: [{ id: threadId, title: "本机会话", engine: "codex", threadType: "chat", threadSubtype: null, createdAt: 1, updatedAt: 1 }], nextCursor: null }; break;
        case "threads.updatePrefs": body = { ok: true }; break;
        case "threads.draft.save": draft = request.body?.draft as ThreadDraftPayload; body = { ok: true, version: 1, updatedAt: 1, updatedByWebSessionId: null }; break;
        case "threads.draft.get": body = { ok: true, draft: draft && { ...draft, version: 1, updatedAt: 1, updatedByWebSessionId: null } }; break;
        case "threads.draft.clear": draft = null; body = { ok: true }; break;
        default: throw new Error(`unexpected desktop method ${request.method}`);
      }
      return { status: 200, body };
    },
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("本机聊天不应请求 Server"); });
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.workspaceId = workspaceId;
  config.desktopRuntime = { status: "ready", requestId: "desktop-process", releaseId: null, errorCode: null };
  config.desktopClient = { clientId: "desktop", name: "test", version: "1", platform: "win32", arch: "x64", connectedAt: 1, workspaceIds: [workspaceId] };
  return { config, chat: useChatStore(), requests };
}

test("本机需求分析创建只读取 Client，不要求账号模型偏好", async t => {
  const h = fixture(t);
  assert.equal(await h.chat.createThread(ctx, { workspaceId, engine: "codex", title: "本机需求", threadSubtype: "requirement-analysis" }), threadId);
  assert.equal(h.requests.find(request => request.method === "threads.create")?.body?.threadSubtype, "requirement-analysis");
  assert.equal(h.config.connected, false);
});

test("本机普通会话创建只读取 Client，不要求知识接口或账号模型偏好", async t => {
  const h = fixture(t);
  assert.equal(await h.chat.createThread(ctx, { workspaceId, engine: "codex", title: "本机会话" }), threadId);
  const created = h.requests.find(request => request.method === "threads.create");
  assert.ok(created);
  assert.equal((created.body?.initialPrefs as { knowledgeEnabled?: boolean }).knowledgeEnabled, false);
  assert.equal(h.config.connected, false);
  assert.equal(h.config.webSessionId, null);
  assert.equal(h.config.authMode, null);
});

test("本机缺少凭据时明确拒绝创建，不产生会话写入", async t => {
  for (const unavailable of [
    { ...status, credentialStatus: { available: false, source: "none" as const, message: "本机凭据缺失" }, providerCredentialStatus: [{ providerId: "openai" as const, available: false, sources: [], message: "本机凭据缺失" }] },
  ]) {
    const h = fixture(t, { status: unavailable });
    await assert.rejects(h.chat.createThread(ctx, { workspaceId, engine: "codex", title: "不应创建" }));
    assert.equal(h.requests.some(request => request.method === "threads.create"), false);
  }
});

test("本机 Key 读取失败即停止创建，不借已有引擎凭据继续副作用", async t => {
  const h = fixture(t, { reject: "engineKeys.list" });
  await assert.rejects(h.chat.createThread(ctx, { workspaceId, engine: "codex", title: "不应创建" }), /本机执行端明确失败/u);
  assert.equal(h.requests.some(request => request.method === "threads.create"), false);
});

test("本机发送、入队和终止失败沿原 store 显式抛出，不伪造完成或队列项", async t => {
  for (const method of ["threads.sendMessage", "threads.queue.append", "turns.interrupt"] as const) {
    const h = fixture(t, { reject: method });
    h.chat.threads = [{ id: threadId, title: "本机会话", engine: "codex", threadType: "chat", threadSubtype: null, archived: false, pinnedAt: null, groupId: null, createdAt: 1, updatedAt: 1 }];
    const queue = useThreadQueueStore();
    const pending = method === "threads.sendMessage"
      ? h.chat.sendMessage(ctx, { workspaceId, threadId, text: "继续", workMode: "general" })
      : method === "turns.interrupt"
        ? h.chat.interruptTurn(ctx, { workspaceId, threadId, turnId: "local-turn" })
        : queue.append(ctx, workspaceId, threadId, { text: "排队消息", images: [], files: [], pathReferences: [], sendOptions: {
          workMode: "general", planMode: false, accessMode: "read-only", model: CODEX_MODELS[0]!.id,
          effort: null, contextWindow: null, autoCompactPct: null, serviceTier: null,
        } });
    await assert.rejects(pending, /本机执行端明确失败/u);
    assert.equal(h.requests.at(-1)?.method, method);
    assert.equal(queue.itemCountFor(threadId), 0);
    assert.equal(h.chat.threadHasRealTurnActivityByThreadId[threadId], undefined);
  }
});

test("本机 composer 冻结配置上下文后仍保留 Client 路由身份", () => {
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  const start = source.indexOf("function freezeThreadPrefsApiContext(");
  const end = source.indexOf("\n/**", start);
  assert.ok(start >= 0 && end > start);
  const sandbox: Record<string, any> = {};
  vm.runInNewContext(ts.transpileModule(source.slice(start, end) + "\nglobalThis.freeze = freezeThreadPrefsApiContext;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, sandbox);
  const frozen = sandbox.freeze(ctx);
  assert.equal(frozen.desktopClientId, "desktop");
  assert.equal(frozen.sessionToken, null);
  assert.equal(frozen.webSessionId, null);
});

test("本机草稿和模型偏好串行保存保留 Client 身份，成功后可从同一入口回读", async t => {
  const h = fixture(t);
  h.chat.threads = [{ id: threadId, title: "本机会话", engine: "codex", threadType: "chat", threadSubtype: null, archived: false, pinnedAt: null, groupId: null, createdAt: 1, updatedAt: 1 }];
  const draft: ThreadDraftPayload = { text: "离线草稿", images: [], files: [], pathReferences: [] };
  await h.chat.saveThreadDraft(ctx, workspaceId, threadId, draft);
  assert.equal((await h.chat.getThreadDraft(ctx, workspaceId, threadId, { force: true }))?.text, "离线草稿");
  h.chat.patchThreadPrefs(threadId, { model: CODEX_MODELS[0]!.id }, workspaceId, { apiContext: ctx });
  await h.chat.saveThreadPrefs(ctx, workspaceId, threadId);
  await h.chat.clearThreadDraft(ctx, workspaceId, threadId);
  assert.ok(h.requests.some(request => request.method === "threads.updatePrefs"));
  assert.ok(h.requests.some(request => request.method === "threads.draft.clear"));
  assert.equal(h.config.connected, false);
});

/** 执行源码中的单个计算值，验证真实本机范围与普通会话边界。 */
function computedFromSource(path: string, names: string[], context: Record<string, unknown>): Record<string, { value: unknown }> {
  const source = readFileSync(new URL(path, import.meta.url), "utf8").replace(/^<script setup lang="ts">/u, "").split("</script>")[0]!;
  const ast = ts.createSourceFile("component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statements = names.map(name => {
    const node = ast.statements.find(item => ts.isVariableStatement(item) && item.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name));
    assert.ok(node, `missing computation ${name}`);
    return node.getText(ast);
  }).join("\n");
  const sandbox = { ...context, computed, ref, isDesktopWorkspace };
  vm.runInNewContext(ts.transpileModule(`${statements}\nglobalThis.result = { ${names.join(",")} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, sandbox);
  return (sandbox as typeof sandbox & { result: Record<string, { value: unknown }> }).result;
}

test("本机聊天就绪只放行已接入的普通、需求分析和节点线程", t => {
  const h = fixture(t);
  for (const [target, type, subtype, expected] of [
    [workspaceId, "chat", null, true], ["other:project", "chat", null, false], ["shared:project", "chat", null, false],
    [workspaceId, "chat", "requirement-analysis", true], [workspaceId, "chat", "node-discussion", true],
    [workspaceId, "orchestration", "node", true], [workspaceId, "chat", "node", false],
    [workspaceId, "chat", "knowledge-assets", false], [workspaceId, "orchestration", null, false],
  ] as const) {
    const values = computedFromSource("../src/features/composer/components/chat-composer.vue", ["localChatReady", "composerConnected"], {
      config: h.config, props: { workspaceId: target }, thread: ref({ threadType: type, threadSubtype: subtype }),
    });
    assert.equal(values.localChatReady!.value, expected, `${target}:${type}:${subtype}`);
    assert.equal(values.composerConnected!.value, expected);
  }
});

test("本机目录就绪使用 Client 成功快照，失败或未读取不能借云端版本放行", t => {
  const h = fixture(t);
  for (const [snapshot, expected] of [
    [{ localModels: true, lastUpdatedAt: 1, lastError: null, catalogVersion: null }, true],
    [{ localModels: true, lastUpdatedAt: null, lastError: null, catalogVersion: null }, false],
    [{ localModels: true, lastUpdatedAt: 1, lastError: "本机读取失败", catalogVersion: 3 }, false],
    [{ localModels: false, lastUpdatedAt: 1, lastError: null, catalogVersion: 3 }, false],
  ] as const) {
    const values = computedFromSource("../src/features/composer/components/chat-composer.vue", ["localChatReady", "modelCatalogLoaded"], {
      config: h.config, props: { workspaceId }, thread: ref({ threadType: "chat", threadSubtype: null }), engines: { byWorkspaceId: { [workspaceId]: snapshot } },
    });
    assert.equal(values.modelCatalogLoaded!.value, expected);
  }
});
