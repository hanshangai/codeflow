import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { computed, effectScope, nextTick, reactive, ref, watch } from "vue";

import {
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type RoleDefinition,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import { ApiResultError } from "../src/api/request.ts";
import { loadComposerRoleOptions, type ComposerRoleListLoader } from "../src/features/composer/composer-role-options.ts";

const ctx: ApiRequestContext = {
  serverWsOrigin: "ws://example.test",
  sessionToken: "session-demo",
  webSessionId: "web-demo",
};
const composerSource = readFileSync(
  new URL("../src/features/composer/components/chat-composer.vue", import.meta.url),
  "utf8",
);

/** availability 由服务端下发但未进 RoleDefinition，与 composer-role-options 的读取口径一致。 */
type RoleFixture = RoleDefinition & { availability?: { available?: boolean; message?: string | null } };

/** 完整角色定义 fixture：避免用残缺伪数据强转绕过响应类型。 */
function roleFixture(overrides: Partial<RoleFixture> & Pick<RoleFixture, "id">): RoleFixture {
  return {
    workspaceId: "workspace-a",
    name: overrides.id,
    description: "",
    systemPrompt: "",
    inputDefinition: createDefaultRoleInputDefinition(),
    outputDefinition: createDefaultRoleOutputDefinition(),
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("codex"),
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("会话 Agent 选项只保留可用角色并保留检索字段", async () => {
  const loader: ComposerRoleListLoader = async () => ({
    ok: true,
    roles: [
      roleFixture({ id: "role-visible", name: "可用 Agent", description: "用于测试" }),
      roleFixture({ id: "role-hidden", name: "不可用 Agent", availability: { available: false, message: "不可用" } }),
    ],
  });

  const options = await loadComposerRoleOptions(ctx, "workspace-a", loader);

  assert.deepEqual(options, [{ label: "可用 Agent", value: "role-visible", title: "用于测试" }]);
});

test("会话 Agent 读取失败必须向调用方返回 API 错误", async () => {
  const loader: ComposerRoleListLoader = async () => ({
    ok: false,
    code: "INTERNAL_ERROR",
    message: "角色服务不可用",
  });

  await assert.rejects(
    () => loadComposerRoleOptions(ctx, "workspace-a", loader),
    (error: unknown) => error instanceof ApiResultError && error.code === "INTERNAL_ERROR",
  );
});

test("Web 会话 Agent 通过执行用途 HTTP 列表选择 Client 角色", async t => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const url = new URL(request.url ?? "/", "http://localhost");
    const role = url.searchParams.get("purpose") === "execution"
      ? roleFixture({ id: "client-role", name: "本机 Agent" })
      : roleFixture({ id: "server-role", name: "资产库 Agent" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, roles: [role] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const options = await loadComposerRoleOptions({
    ...ctx, serverWsOrigin: `ws://127.0.0.1:${address.port}`,
  }, "workspace-a");

  assert.deepEqual(requests, ["/api/orch/roles?workspaceId=workspace-a&purpose=execution"]);
  assert.deepEqual(options, [{ label: "本机 Agent", value: "client-role", title: "本机 Agent" }]);
});

/** 执行真实 watcher，以可替换的在线快照和可控响应验证刷新边界。 */
function composerRolesHarness() {
  const start = composerSource.indexOf("async function refreshComposerRoles(");
  const end = composerSource.indexOf("const recommendationEnabled = ref(false)", start);
  assert.ok(start >= 0 && end > start);
  const requests: Array<{ workspaceId: string; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  let unmounted!: () => void;
  const context = {
    watch, props: reactive({ workspaceId: "workspace-a", threadId: "thread-a" }), config: reactive({ connected: true,
      userSummary: null as null | { userId: string }, serverWsOrigin: "ws://test", sessionToken: null as string | null,
      desktopRuntime: null as null | { requestId: string }, desktopCloudAccount: null as null | { generation: number; status: string } }),
    roleOptionsScopeEpoch: ref(0),
    localReady: ref(false), roleSelectorVisible: ref(true), roleOptions: ref<unknown[]>([]), roleOptionsLoading: ref(false), ctx: { value: ctx },
    presence: reactive({
      online: { onlineClients: [{ connectedAt: 1, workspaceIds: ["workspace-a", "workspace-b"] }] },
      /** 与真实 store 一样读取在线数组，快照替换会重新求值。 */
      clientForWorkspace(workspaceId: string) { return this.online.onlineClients.find(client => client.workspaceIds.includes(workspaceId)) ?? null; } }),
    loadComposerRoleOptions: (_ctx: unknown, workspaceId: string) => new Promise((resolve, reject) => requests.push({ workspaceId, resolve, reject })),
    message: { error: (value: unknown) => errors.push(value) },
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    onUnmounted: (callback: () => void) => { unmounted = callback; },
  };
  const composerConnected = computed(() => context.config.connected || context.localReady.value);
  const scope = effectScope();
  scope.run(() => vm.runInNewContext(ts.transpileModule("let roleOptionsRefreshVersion = 0;\n" + composerSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...context, composerConnected }));
  return { context, requests, errors, warnings,
    /** 等待 watcher 与已完成请求的回写。 */
    async flush() { await nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); },
    /** 模拟组件卸载并释放真实 Vue watcher。 */
    dispose() { unmounted(); scope.stop(); },
  };
}

test("本机角色入口在无云端连接时读取原列表，运行时失效后清空候选", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  h.requests[0]!.resolve([{ value: "cloud-old" }]);
  await h.flush();
  h.context.config.connected = false;
  await h.flush();
  h.context.localReady.value = true;
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve([{ value: "local-role" }]);
  await h.flush();
  assert.deepEqual(h.context.roleOptions.value, [{ value: "local-role" }]);
  h.context.localReady.value = false;
  await h.flush();
  assert.equal(h.context.roleOptions.value.length, 0);
});

test("首次 Agent 加载失败后，连接恢复通过原列表入口重新读取", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  h.requests[0]!.reject(new ApiResultError({ ok: false, code: "INTERNAL_ERROR", message: "角色服务不可用", details: { requestId: "request-1" } }));
  await h.flush();
  assert.equal(h.errors.length, 1);
  assert.match(JSON.stringify(h.warnings), /request-1/);
  h.context.config.connected = false;
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.context.config.connected = true;
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve([{ value: "role-restored" }]);
  await h.flush();
  assert.deepEqual(h.context.roleOptions.value, [{ value: "role-restored" }]);
  assert.equal(h.context.roleOptionsLoading.value, false);
  assert.equal(h.errors.length, 1);
});

test("普通在线快照不重载 Agent，也不作废在途结果", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  for (let count = 0; count < 2; count++) {
    h.context.presence.online = { onlineClients: [{ connectedAt: count + 2, workspaceIds: ["workspace-a", "workspace-b"] }] };
    await h.flush();
    assert.equal(h.requests.length, 1);
    assert.equal(h.context.roleOptionsLoading.value, true);
  }
  h.requests[0]!.resolve([{ value: "initial" }]);
  await h.flush();
  const options = h.context.roleOptions.value;
  h.context.presence.online = { onlineClients: [{ connectedAt: 4, workspaceIds: ["workspace-a", "workspace-b"] }] };
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.context.roleOptions.value, options);
  assert.equal(h.context.roleOptionsLoading.value, false);
  assert.equal(h.errors.length, 0);
});

test("账号和工作区切换隔离迟到响应，卸载后的失败不再提示", async () => {
  const h = composerRolesHarness();
  try {
    h.context.config.userSummary = { userId: "B" };
    await h.flush();
    assert.equal(h.requests.length, 2);
    h.requests[0]!.reject(new Error("旧失败"));
    await h.flush();
    assert.equal(h.errors.length, 0);
    h.context.props.workspaceId = "workspace-b";
    await h.flush();
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2]!.workspaceId, "workspace-b");
    assert.equal(h.context.roleOptions.value.length, 0);
    h.requests[1]!.resolve([{ value: "旧成功" }]);
    await h.flush();
    assert.equal(h.context.roleOptions.value.length, 0);
  } finally { h.dispose(); }
  h.requests[2]!.reject(new Error("卸载后的失败"));
  await h.flush();
  assert.equal(h.errors.length, 0);
  assert.equal(h.warnings.length, 0);
});

test("断线或 Agent 入口隐藏期间不刷新，恢复可见后重新读取", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  h.context.config.connected = false;
  await h.flush();
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.context.roleSelectorVisible.value = false;
  h.context.config.connected = true;
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.context.roleSelectorVisible.value = true;
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[0]!.resolve([{ value: "旧选项" }]);
  h.requests[1]!.resolve([]);
  await h.flush();
  assert.equal(h.context.roleOptions.value.length, 0);
});

test("账号切换后的 Agent 列表失败保持空候选并明确提示", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  h.requests[0]!.resolve([{ value: "owner-a" }]);
  await h.flush();
  h.context.config.userSummary = { userId: "B" };
  assert.equal(h.context.roleOptions.value.length, 0);
  await h.flush();
  h.requests[1]!.reject(new Error("refresh failed"));
  await h.flush();
  assert.equal(h.context.roleOptions.value.length, 0);
  assert.equal(h.errors.length, 1);
});

test("同 tick 账号切出并切回仍清空选项并阻止原 owner 的迟到列表", async t => {
  const h = composerRolesHarness();
  t.after(() => h.dispose());
  h.context.config.userSummary = { userId: "B" };
  h.context.config.userSummary = null;
  assert.equal(h.context.roleOptions.value.length, 0);
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[0]!.resolve([{ value: "old-owner" }]);
  await h.flush();
  assert.equal(h.context.roleOptions.value.length, 0);
  h.requests[1]!.resolve([{ value: "current-owner" }]);
  await h.flush();
  assert.deepEqual(h.context.roleOptions.value, [{ value: "current-owner" }]);
});
