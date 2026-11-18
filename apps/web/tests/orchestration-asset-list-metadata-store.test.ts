import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

import { createPinia, setActivePinia } from "pinia";
import { computed } from "vue";
import {
  ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
  createDefaultRoleExecutionConfig,
  createDefaultRoleInputDefinition,
  createDefaultRoleOutputDefinition,
  type OrchAssetBundle,
  type OrchAssetListMetadata,
  type OrchAssetType,
  type RoleId,
  type RoleDefinition,
  type WorkflowDefinition,
  type WorkspaceId,
} from "@codeflowai/shared";

import type { ApiRequestContext } from "../src/api/request.ts";
import { ApiResultError, CancelledRequestError } from "../src/api/request.ts";
import { useOrchestrationStore } from "../src/store/orchestration.ts";

const originalFetch = globalThis.fetch;
const originalCrypto = globalThis.crypto;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const WORKSPACE_ID = "workspace-a" as WorkspaceId;
const OTHER_WORKSPACE_ID = "workspace-b" as WorkspaceId;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

/** 创建由测试显式控制完成时机的 Promise。 */
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 创建具备账号会话的测试请求上下文。 */
function createApiContext(): ApiRequestContext {
  return {
    serverWsOrigin: "ws://127.0.0.1:39280",
    sessionToken: "session-demo",
    webSessionId: "web-demo",
    ensureSession: async () => "session-demo",
    clearSession() {},
  };
}

/** 构造统一 JSON API 响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 读取测试 fetch 收到的 JSON 请求体。 */
function requestBody(init?: RequestInit): Record<string, any> {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("请求体必须是 JSON 字符串");
  return JSON.parse(body) as Record<string, any>;
}

/** 构造一条列表修订元数据。 */
function metadata<T extends OrchAssetType>(
  assetType: T,
  assetId: string,
  revision = 1,
  contentHash = HASH_A,
): OrchAssetListMetadata<T> {
  return {
    assetType,
    assetId,
    revision,
    scopeType: "user",
    contentHash,
  };
}

/** 提供角色与流程的完整定义，验证列表来源而不绕过真实 store 处理。 */
function executionAssetFixture(assetType: "role" | "workflow", assetId: string): RoleDefinition | WorkflowDefinition {
  const base = {
    id: assetId, workspaceId: WORKSPACE_ID, name: assetId, description: "",
    kind: "custom" as const, createdAt: 1, updatedAt: 1,
  };
  return assetType === "role"
    ? { ...base, inputDefinition: createDefaultRoleInputDefinition(), outputDefinition: createDefaultRoleOutputDefinition(),
        systemPrompt: "", gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex") }
    : { ...base, version: 1, nodes: [], edges: [] };
}

/** 构造不携带资产的合法导入包。 */
function emptyAssetBundle(): OrchAssetBundle {
  return {
    schemaVersion: ORCH_ASSET_BUNDLE_SCHEMA_VERSION,
    bundleId: "bundle-a",
    bundleVersion: 1,
    title: "bundle-a",
    generatedAt: 1,
    source: { kind: "workspace-export", workspaceId: String(WORKSPACE_ID) },
    roles: [],
    knowledgeBundles: [],
    skills: [],
    toolsets: [],
    workflows: [],
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
});

test("five asset refreshes retain typed metadata and align it to definition order", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    const responses: Record<string, unknown> = {
      "/api/orch/roles": {
        ok: true,
        roles: [{ id: "role-a" }, { id: "role-b" }],
        assetMetadata: [metadata("role", "role-b", 2, HASH_B), metadata("role", "role-a")],
      },
      "/api/orch/workflows": {
        ok: true,
        workflows: [{ id: "workflow-a" }],
        assetMetadata: [metadata("workflow", "workflow-a")],
      },
      "/api/orch/toolsets": {
        ok: true,
        toolsets: [{ id: "toolset-a" }],
        assetMetadata: [metadata("toolset", "toolset-a")],
      },
      "/api/orch/skills": {
        ok: true,
        skills: [{ id: "skill-a" }],
        assetMetadata: [metadata("skill", "skill-a")],
      },
      "/api/orch/knowledge-bundles": {
        ok: true,
        bundles: [{ id: "knowledge-a" }],
        assetMetadata: [metadata("knowledge_bundle", "knowledge-a")],
      },
    };
    const response = responses[pathname];
    if (!response) throw new Error(`unexpected request: ${pathname}`);
    return jsonResponse(response);
  }) as typeof fetch;

  await Promise.all([
    store.refreshRoles(ctx, WORKSPACE_ID),
    store.refreshWorkflows(ctx, WORKSPACE_ID),
    store.refreshToolsets(ctx, WORKSPACE_ID),
    store.refreshSkills(ctx, WORKSPACE_ID),
    store.refreshKnowledgeBundles(ctx, WORKSPACE_ID),
  ]);

  assert.deepEqual(store.assetListMetadata.role?.map((item) => item.assetId), ["role-a", "role-b"]);
  assert.equal(store.assetListMetadata.workflow?.[0]?.assetType, "workflow");
  assert.equal(store.assetListMetadata.toolset?.[0]?.assetType, "toolset");
  assert.equal(store.assetListMetadata.skill?.[0]?.assetType, "skill");
  assert.equal(store.assetListMetadata.knowledge_bundle?.[0]?.assetType, "knowledge_bundle");
  assert.deepEqual(store.assetListLoaded, {
    role: true,
    workflow: true,
    knowledge_bundle: true,
    toolset: true,
    skill: true,
  });
});

test("asset list cache reuses an empty successful list and resets on workspace change", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    assert.equal(pathname, "/api/orch/roles");
    requestCount += 1;
    return jsonResponse({ ok: true, roles: [], assetMetadata: [] });
  }) as typeof fetch;

  await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, "role");
  await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, "role");
  assert.equal(requestCount, 1);
  assert.equal(store.assetListLoaded.role, true);

  store.resetForWorkspace(OTHER_WORKSPACE_ID);
  assert.equal(store.assetListLoaded.role, false);
  await store.ensureAssetListLoaded(ctx, OTHER_WORKSPACE_ID, "role");
  assert.equal(requestCount, 2);
});

test("asset list cache merges concurrent first reads and releases a failed request for retry", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const firstResponse = createDeferred<Response>();
  let requestCount = 0;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.equal(new URL(String(input)).pathname, "/api/orch/roles");
    requestCount += 1;
    if (requestCount === 1) return firstResponse.promise;
    return jsonResponse({ ok: true, roles: [], assetMetadata: [] });
  }) as typeof fetch;

  const firstLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, "role");
  const secondLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, "role");
  await Promise.resolve();
  assert.equal(requestCount, 1);
  firstResponse.resolve(jsonResponse({ ok: false, code: "INTERNAL_ERROR", message: "load failed" }));
  await assert.rejects(firstLoad, ApiResultError);
  await assert.rejects(secondLoad, ApiResultError);
  assert.equal(store.assetListLoadPromises.role, null);

  await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, "role");
  assert.equal(requestCount, 2);
  assert.equal(store.assetListLoaded.role, true);
});

for (const { assetType, path, listKey } of [
  { assetType: "role", path: "/api/orch/roles", listKey: "roles" },
  { assetType: "workflow", path: "/api/orch/workflows", listKey: "workflows" },
  { assetType: "knowledge_bundle", path: "/api/orch/knowledge-bundles", listKey: "bundles" },
  { assetType: "skill", path: "/api/orch/skills", listKey: "skills" },
  { assetType: "toolset", path: "/api/orch/toolsets", listKey: "toolsets" },
] as const) {
  test(`共享资产库保留 Host 内置及共享自定义 ${assetType}，区分 Server 修订与 Host 只读来源`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore(), workspaceId = "shared:project" as WorkspaceId;
    const purposes: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, path);
      assert.equal(url.searchParams.get("workspaceId"), workspaceId);
      const purpose = url.searchParams.get("purpose"); purposes.push(purpose);
      return jsonResponse(purpose === "execution"
        ? { ok: true, [listKey]: [{ id: "builtin-host", name: "Host builtin", kind: "builtin" }, { id: "shared-host", kind: "custom" }] }
        : { ok: true, [listKey]: [{ id: "server-asset", kind: "custom" }], assetMetadata: [metadata(assetType, "server-asset", 3)] });
    }) as typeof fetch;
    await store.ensureAssetListLoaded(createApiContext(), workspaceId, assetType);
    const collection = assetType === "knowledge_bundle" ? store.knowledgeBundles : store[listKey];
    assert.deepEqual(collection.map(item => item.id), ["server-asset", "builtin-host", "shared-host"]);
    assert.deepEqual(store.assetListHostIds[assetType], ["builtin-host", "shared-host"]);
    assert.deepEqual(store.assetListMetadata[assetType]?.map(item => [item.assetId, item.revision]), [["server-asset", 3]]);
    assert.deepEqual(purposes, [null, "execution"]);
  });
}

test("共享 Host 内置列表读取失败明确拒绝，不把不完整列表缓存为成功", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  globalThis.fetch = (async (input: RequestInfo | URL) => jsonResponse(new URL(String(input)).searchParams.has("purpose")
    ? { ok: false, code: "CLIENT_OFFLINE", message: "Host offline" }
    : { ok: true, roles: [{ id: "server-role", kind: "custom" }], assetMetadata: [metadata("role", "server-role")] })) as typeof fetch;
  await assert.rejects(store.ensureAssetListLoaded(createApiContext(), "shared:project" as WorkspaceId, "role"), ApiResultError);
  assert.equal(store.assetListLoaded.role, false);
  assert.deepEqual(store.roles.map(item => item.id), ["server-role"]);
  assert.equal(store.assetListMetadata.role?.[0]?.assetId, "server-role");
});

for (const hostRoles of [null, [{ id: "bad", kind: "unknown" }], [{ id: "duplicate", kind: "custom" }, { id: "duplicate", kind: "custom" }]])
test("Host 非法定义仍显式失败，Server 有效资产继续可见", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  globalThis.fetch = (async (input: RequestInfo | URL) => jsonResponse(new URL(String(input)).searchParams.has("purpose")
    ? { ok: true, roles: hostRoles }
    : { ok: true, roles: [{ id: "server-role", kind: "custom" }], assetMetadata: [metadata("role", "server-role")] })) as typeof fetch;
  await assert.rejects(store.ensureAssetListLoaded(createApiContext(), "shared:project" as WorkspaceId, "role"), /Host/u);
  assert.deepEqual(store.roles.map(item => item.id), ["server-role"]);
  assert.equal(store.assetListLoaded.role, false);
});

test("Host 重试恢复共享自定义原件，同 ID 以 Server 修订为准且工作区切换清除来源", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), workspaceId = "shared:project" as WorkspaceId;
  let hostAttempts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!new URL(String(input)).searchParams.has("purpose")) return jsonResponse({ ok: true,
      roles: [{ id: "same-id", kind: "custom", name: "Server" }], assetMetadata: [metadata("role", "same-id", 7)] });
    hostAttempts++;
    return jsonResponse(hostAttempts === 1 ? { ok: false, code: "CLIENT_OFFLINE", message: "Host offline" }
      : { ok: true, roles: [{ id: "same-id", kind: "custom", name: "Host" }, { id: "host-custom", kind: "custom" }] });
  }) as typeof fetch;
  await assert.rejects(store.ensureAssetListLoaded(createApiContext(), workspaceId, "role"), ApiResultError);
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "role");
  assert.equal(store.assetListLoaded.role, true);
  assert.deepEqual(store.roles.map(item => item.id), ["same-id", "host-custom"]);
  assert.equal(store.roles[0].name, "Server");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 7);
  assert.deepEqual(store.assetListHostIds.role, ["host-custom"]);
  store.resetForWorkspace(WORKSPACE_ID);
  assert.deepEqual(store.assetListHostIds.role, []);
});

test("Host 自定义资产只读，不能将其误创建到 Server 或发送缺少修订的删除", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), workspaceId = "shared:project" as WorkspaceId;
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") { writes++; throw new Error("Unexpected mutation"); }
    return jsonResponse(new URL(String(input)).searchParams.has("purpose")
      ? { ok: true, roles: [executionAssetFixture("role", "host-custom")] }
      : { ok: true, roles: [], assetMetadata: [] });
  }) as typeof fetch;
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "role");
  assert.equal(store.roles[0]?.id, "host-custom");
  await assert.rejects(store.saveRole(createApiContext(), workspaceId, store.roles[0]), /Host.*只读/u);
  await assert.rejects(store.removeRole(createApiContext(), workspaceId, "host-custom" as RoleId), /Host.*只读/u);
  assert.equal(writes, 0);
});

/** 提取真实组件 computed 声明，不启动页面或复制 UI 准入逻辑。 */
function componentComputed(file: string, names: string[], dependencies: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/features/orchestration/components/${file}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source.slice(source.indexOf(">") + 1, source.indexOf("</script>")), ts.ScriptTarget.Latest, true);
  const statements = tree.statements.filter(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && names.includes(item.name.text)));
  assert.equal(statements.length, names.length);
  return vm.runInNewContext(ts.transpileModule(statements.map(node => node.getText(tree)).join("\n")
    + `\n({${names.join(",")}})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
  { computed, ...dependencies });
}

test("共享成员可打开 Host 只读详情，部分加载失败不遮挡已取得的 Server 资产", () => {
  const view = componentComputed("orchestration-layout.vue", ["activeAssetDataAvailable", "selectedHostAsset", "selectedAssetReadonly", "assetPageLocked"], {
    previewAssetType: { value: "role" }, orch: { roles: [{ id: "host-custom" }], selectedRoleId: "host-custom", assetListHostIds: { role: ["host-custom"] } },
    selectedBuiltinAsset: { value: false }, assetMaintenanceLocked: { value: true }, activeAssetTab: { value: "roles" },
    isSkillMarketView: { value: false }, activeAssetView: { value: "assets" }, activeAssetDataLoaded: { value: false },
  });
  assert.equal(view.activeAssetDataAvailable.value, true);
  assert.equal(view.selectedAssetReadonly.value, true);
  assert.equal(view.assetPageLocked.value, false);
});

test("Server 编辑器不提供无法保存的 Host 自定义依赖，Host 只读详情仍可解析其引用", () => {
  const entries = [{ id: "server", kind: "custom" }, { id: "host-custom", kind: "custom" }, { id: "host-builtin", kind: "builtin" }];
  const orch = { roles: entries, knowledgeBundles: entries, skills: entries, toolsets: entries,
    assetListHostIds: { role: ["host-custom", "host-builtin"], knowledge_bundle: ["host-custom", "host-builtin"],
      skill: ["host-custom", "host-builtin"], toolset: ["host-custom", "host-builtin"] } };
  for (const previewReadonly of [false, true]) {
    const workflow = componentComputed("workflow-editor.vue", ["visibleRoles", "visibleKnowledgeBundles"], { orch,
      props: { previewReadonly }, isBuiltinReadonly: { value: previewReadonly } });
    const role = componentComputed("role-definition-form.vue", ["visibleToolsets", "visibleKnowledgeBundles", "visibleSkills"], { orch,
      props: { previewReadonly }, isBuiltinReadonly: { value: previewReadonly }, superAdminExtraCustomToolsets: { value: [] } });
    for (const view of [workflow.visibleRoles, workflow.visibleKnowledgeBundles, role.visibleToolsets, role.visibleKnowledgeBundles, role.visibleSkills]) {
      assert.deepEqual(Array.from(view.value, (item: { id: string }) => item.id), previewReadonly
        ? ["server", "host-custom", "host-builtin"] : ["server", "host-builtin"]);
    }
  }
});

for (const { file, collection, type, variable, permission } of [
  { file: "role-list.vue", collection: "roles", type: "role", variable: "exportableRoleIdSet", permission: "canExportBuiltinRole" },
  { file: "workflow-sidebar.vue", collection: "workflows", type: "workflow", variable: "exportableWorkflowIdSet", permission: "canExportBuiltinWorkflow" },
  { file: "knowledge-bundle-list.vue", collection: "knowledgeBundles", type: "knowledge_bundle", variable: "exportableKnowledgeBundleIdSet", permission: "canExportBuiltinKnowledgeBundle" },
  { file: "skill-list.vue", collection: "skills", type: "skill", variable: "exportableSkillIdSet", permission: "canExportBuiltinSkill" },
  { file: "toolset-list.vue", collection: "toolsets", type: "toolset", variable: "exportableToolsetIdSet", permission: "canExportBuiltinToolset" },
]) test(`Server 导出 ${type} 不混入 Host 只读原件`, () => {
  const view = componentComputed(file, [variable], { orch: { [collection]: [{ id: "server", kind: "custom" }, { id: "host", kind: "custom" }],
    assetListHostIds: { [type]: ["host"] } }, [permission]: { value: true } });
  assert.deepEqual(Array.from(view[variable].value), ["server"]);
});

test("共享 Server 空列表仍加载内置流程，legacy 与执行列表不重复读取 Host", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), workspaceId = "shared:project" as WorkspaceId;
  const purposes: Array<string | null> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const purpose = new URL(String(input)).searchParams.get("purpose"); purposes.push(purpose);
    return jsonResponse(purpose === "execution"
      ? { ok: true, workflows: [{ id: "builtin-host", kind: "builtin" }] }
      : { ok: true, workflows: [], assetMetadata: [] });
  }) as typeof fetch;
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "workflow");
  assert.deepEqual(store.workflows.map(item => item.id), ["builtin-host"]);
  assert.deepEqual(store.assetListMetadata.workflow, []);
  store.resetForWorkspace(workspaceId);
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "workflow", "execution");
  assert.deepEqual(purposes, [null, "execution", "execution"]);
  store.resetForWorkspace(workspaceId);
  globalThis.fetch = (async () => {
    purposes.push(null);
    return jsonResponse({ ok: true, workflows: [{ id: "legacy-builtin", kind: "builtin" }] });
  }) as typeof fetch;
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "workflow");
  assert.equal(purposes.length, 4);
  assert.equal(store.assetListMetadata.workflow, null);
});

test("共享内置请求迟到不能覆盖新工作区或污染其修订信息", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), hostResponse = createDeferred<Response>();
  const hostRequested = createDeferred<void>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.searchParams.has("purpose")) { hostRequested.resolve(); return hostResponse.promise; }
    const id = url.searchParams.get("workspaceId") === "shared:old" ? "old" : "current";
    return jsonResponse({ ok: true, roles: [{ id, kind: "custom" }], assetMetadata: [metadata("role", id)] });
  }) as typeof fetch;
  const previous = store.ensureAssetListLoaded(createApiContext(), "shared:old" as WorkspaceId, "role");
  await hostRequested.promise;
  store.resetForWorkspace(WORKSPACE_ID);
  await store.ensureAssetListLoaded(createApiContext(), WORKSPACE_ID, "role");
  hostResponse.resolve(jsonResponse({ ok: true, roles: [{ id: "old-builtin", kind: "builtin" }] }));
  await previous;
  assert.deepEqual(store.roles.map(item => item.id), ["current"]);
  assert.equal(store.assetListMetadata.role?.[0]?.assetId, "current");
});

test("共享列表中的 Host 内置资产不使 Server 保存和删除丢失乐观修订", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), workspaceId = "shared:project" as WorkspaceId;
  const role = executionAssetFixture("role", "server-role") as RoleDefinition;
  const revisions: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = requestBody(init); revisions.push(body.expectedRevision);
      return jsonResponse(url.pathname.endsWith("/delete") ? { ok: true, changeSeq: 5, cacheStatus: "pending" }
        : { ok: true, role, changeSeq: 4, cacheStatus: "pending", assetMetadata: metadata("role", role.id, 4) });
    }
    return jsonResponse(url.searchParams.has("purpose")
      ? { ok: true, roles: [{ id: "host-builtin", kind: "builtin" }] }
      : { ok: true, roles: [role], assetMetadata: [metadata("role", role.id, 3)] });
  }) as typeof fetch;
  await store.ensureAssetListLoaded(createApiContext(), workspaceId, "role");
  await store.saveRole(createApiContext(), workspaceId, role);
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 4);
  await store.removeRole(createApiContext(), workspaceId, role.id);
  assert.deepEqual(revisions, [3, 4]);
  assert.deepEqual(store.roles.map(item => item.id), ["host-builtin"]);
  assert.deepEqual(store.assetListMetadata.role, []);
});

for (const { assetType, path, listKey } of [
  { assetType: "role", path: "/api/orch/roles", listKey: "roles" },
  { assetType: "workflow", path: "/api/orch/workflows", listKey: "workflows" },
] as const) {
  test(`${assetType} 管理与执行列表切换清除旧快照并分别请求来源`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const purposes: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, path);
      const purpose = url.searchParams.get("purpose");
      purposes.push(purpose);
      const assetId = `${purpose ?? "catalog"}-${purposes.length}`;
      return jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, assetId)],
        ...(purpose === "execution" ? {} : { assetMetadata: [metadata(assetType, assetId)] }) });
    }) as typeof fetch;

    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    const executionLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
    assert.equal(store[listKey].length, 0);
    assert.deepEqual(store.assetListMetadata[assetType]?.map(item => item.assetId) ?? null, null);
    assert.equal(store.assetListLoaded[assetType], false);
    await executionLoad;
    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
    assert.deepEqual(store[listKey].map(asset => asset.id), ["execution-2"]);
    assert.deepEqual(store.assetListMetadata[assetType]?.map(item => item.assetId) ?? null, null);

    const catalogLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    assert.equal(store[listKey].length, 0);
    assert.equal(store.assetListLoaded[assetType], false);
    await catalogLoad;
    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    assert.deepEqual(store[listKey].map(asset => asset.id), ["catalog-3"]);
    assert.equal(store.assetListMetadata[assetType]?.[0]?.assetId, "catalog-3");
    assert.deepEqual(purposes, [null, "execution", null]);
  });

  test(`${assetType} 切换列表来源不复用在途请求且迟到结果不覆盖当前来源`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const requests: Array<{ purpose: string | null; response: Deferred<Response> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, path);
      const response = createDeferred<Response>();
      requests.push({ purpose: url.searchParams.get("purpose"), response });
      return response.promise;
    }) as typeof fetch;

    const firstCatalogLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    const executionLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
    const latestCatalogLoad = store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    await Promise.resolve();
    assert.deepEqual(requests.map(request => request.purpose), [null, "execution", null]);

    requests[1]!.response.resolve(jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, "client-old")] }));
    await executionLoad;
    assert.equal(store[listKey].length, 0);
    assert.equal(store.assetListLoaded[assetType], false);
    requests[2]!.response.resolve(jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, "catalog-current")],
      assetMetadata: [metadata(assetType, "catalog-current", 2)] }));
    await latestCatalogLoad;
    requests[0]!.response.resolve(jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, "catalog-old")],
      assetMetadata: [metadata(assetType, "catalog-old")] }));
    await firstCatalogLoad;
    assert.deepEqual(store[listKey].map(asset => asset.id), ["catalog-current"]);
    assert.equal(store.assetListMetadata[assetType]?.[0]?.revision, 2);
    assert.equal(store.assetListLoaded[assetType], true);
    assert.equal(store.assetListLoadPromises[assetType], null);
  });

  test(`${assetType} 执行列表失败清空管理候选并显式拒绝，重试仍请求执行来源`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const purposes: Array<string | null> = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, path);
      purposes.push(url.searchParams.get("purpose"));
      if (purposes.length === 2) return jsonResponse({ ok: false, code: "INTERNAL_ERROR",
        message: "Client 列表不可用", details: { requestId: "execution-failed" } });
      const assetId = purposes.length === 1 ? "catalog-role" : "client-role";
      return jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, assetId)] });
    }) as typeof fetch;

    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    await assert.rejects(store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution"),
      (error: unknown) => error instanceof ApiResultError && error.code === "INTERNAL_ERROR"
        && (error.details as { requestId?: unknown })?.requestId === "execution-failed");
    assert.equal(store[listKey].length, 0);
    assert.equal(store.assetListMetadata[assetType], null);
    assert.equal(store.assetListLoaded[assetType], false);
    assert.equal(store.assetListLoadPromises[assetType], null);
    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
    assert.deepEqual(store[listKey].map(asset => asset.id), ["client-role"]);
    assert.deepEqual(purposes, [null, "execution", "execution"]);
  });

  for (const serverMetadata of [false, true]) {
    test(`${assetType} 迟到${serverMetadata ? "Server" : "Client"}保存不改写执行候选或切回管理列表`, async () => {
      setActivePinia(createPinia());
      const store = useOrchestrationStore();
      const ctx = createApiContext();
      const response = createDeferred<Response>();
      const saved = { ...executionAssetFixture(assetType, "asset-a"), name: "管理资产" };
      const purposes: Array<string | null> = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === `${path}/upsert` && init?.method === "POST") return response.promise;
        assert.equal(url.pathname, path);
        purposes.push(url.searchParams.get("purpose"));
        return jsonResponse({ ok: true, [listKey]: [{ ...saved, name: purposes.at(-1) ? "执行资产" : "管理资产" }],
          ...(purposes.at(-1) ? {} : { assetMetadata: [metadata(assetType, "asset-a")] }) });
      }) as typeof fetch;
      await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
      const saving = assetType === "role"
        ? store.saveRole(ctx, WORKSPACE_ID, saved as RoleDefinition)
        : store.saveWorkflow(ctx, WORKSPACE_ID, saved as WorkflowDefinition);
      await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
      response.resolve(jsonResponse({ ok: true, [assetType]: saved,
        ...(serverMetadata ? { changeSeq: 2, cacheStatus: "pending", assetMetadata: metadata(assetType, "asset-a", 2) } : {}) }));
      assert.equal((await saving).name, "管理资产");
      assert.deepEqual(store[listKey].map(asset => asset.name), ["执行资产"]);
      assert.equal(store.assetListPurposes[assetType], "execution");
      assert.deepEqual(store.assetListMetadata[assetType]?.map(item => item.assetId) ?? null, null);
      assert.deepEqual(purposes, [null, "execution"]);
    });

    test(`${assetType} 迟到${serverMetadata ? "Server" : "Client"}删除不移除执行来源的同 ID 候选`, async () => {
      setActivePinia(createPinia());
      const store = useOrchestrationStore();
      const ctx = createApiContext();
      const response = createDeferred<Response>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === `${path}/delete` && init?.method === "POST") return response.promise;
        assert.equal(url.pathname, path);
        return jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, "asset-a")],
          ...(url.searchParams.get("purpose") ? {} : { assetMetadata: [metadata(assetType, "asset-a")] }) });
      }) as typeof fetch;
      await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
      const removing = assetType === "role"
        ? store.removeRole(ctx, WORKSPACE_ID, "asset-a")
        : store.removeWorkflow(ctx, WORKSPACE_ID, "asset-a");
      await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
      response.resolve(jsonResponse({ ok: true,
        ...(serverMetadata ? { changeSeq: 2, cacheStatus: "pending" } : {}) }));
      await removing;
      assert.deepEqual(store[listKey].map(asset => asset.id), ["asset-a"]);
      assert.equal(store.assetListPurposes[assetType], "execution");
      assert.equal(store.assetListLoaded[assetType], true);
    });
  }

  test(`${assetType} 保存补偿刷新期间切至执行列表仍保留执行候选`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const response = createDeferred<Response>();
    const reconciliation = createDeferred<Response>();
    const reconciliationStarted = createDeferred<void>();
    const saved = executionAssetFixture(assetType, "asset-a");
    let catalogReads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === `${path}/upsert` && init?.method === "POST") return response.promise;
      assert.equal(url.pathname, path);
      if (url.searchParams.get("purpose") === "execution") return jsonResponse({ ok: true,
        [listKey]: [executionAssetFixture(assetType, "client-asset")] });
      if (++catalogReads === 3) { reconciliationStarted.resolve(); return reconciliation.promise; }
      return jsonResponse({ ok: true, [listKey]: [saved] });
    }) as typeof fetch;
    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType);
    const saving = assetType === "role"
      ? store.saveRole(ctx, WORKSPACE_ID, saved as RoleDefinition)
      : store.saveWorkflow(ctx, WORKSPACE_ID, saved as WorkflowDefinition);
    await (assetType === "role" ? store.refreshRoles(ctx, WORKSPACE_ID) : store.refreshWorkflows(ctx, WORKSPACE_ID));
    response.resolve(jsonResponse({ ok: true, [assetType]: saved,
      changeSeq: 2, cacheStatus: "pending", assetMetadata: metadata(assetType, "asset-a", 2) }));
    await reconciliationStarted.promise;
    await store.ensureAssetListLoaded(ctx, WORKSPACE_ID, assetType, "execution");
    reconciliation.resolve(jsonResponse({ ok: true, [listKey]: [saved], assetMetadata: [metadata(assetType, "asset-a", 2)] }));
    await saving;
    assert.deepEqual(store[listKey].map(asset => asset.id), ["client-asset"]);
    assert.equal(store.assetListPurposes[assetType], "execution");
  });
}

for (const serverMetadata of [false, true]) {
  test(`迟到${serverMetadata ? "Server" : "Client"}导入仅更新仍处于管理来源的资产类型`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const ctx = createApiContext();
    const response = createDeferred<Response>();
    const role = executionAssetFixture("role", "server-role");
    const workflow = executionAssetFixture("workflow", "server-workflow");
    const skill = { ...store.createDefaultSkill(WORKSPACE_ID), id: "server-skill", createdAt: 1, updatedAt: 1 };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/orch/asset-bundles/import" && init?.method === "POST") return response.promise;
      assert.equal(url.pathname, "/api/orch/roles");
      return jsonResponse({ ok: true, roles: [executionAssetFixture("role", url.searchParams.get("purpose") ? "client-role" : "server-role")] });
    }) as typeof fetch;
    const importing = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
    await store.refreshRoles(ctx, WORKSPACE_ID, "execution");
    response.resolve(jsonResponse({ ok: true, imported: { roles: [role], workflows: [workflow], skills: [skill] },
      ...(serverMetadata ? { changeSeq: 2, cacheStatus: "pending", assetMetadata: [
        metadata("role", "server-role", 2), metadata("workflow", "server-workflow", 2), metadata("skill", "server-skill", 2),
      ] } : {}) }));
    const imported = await importing;
    assert.equal(imported.roles[0]?.id, "server-role");
    assert.deepEqual(store.roles.map(asset => asset.id), ["client-role"]);
    assert.deepEqual(store.workflows.map(asset => asset.id), ["server-workflow"]);
    assert.deepEqual(store.skills.map(asset => asset.id), ["server-skill"]);
    assert.equal(store.assetListPurposes.role, "execution");
    assert.equal(store.assetListPurposes.workflow, "catalog");
  });
}

test("已水合规划在访问资产库后恢复 Client 执行候选", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const assetType = url.pathname === "/api/orch/roles" ? "role" : "workflow";
    assert.ok(url.pathname === "/api/orch/roles" || url.pathname === "/api/orch/workflows");
    const listKey = assetType === "role" ? "roles" : "workflows";
    const source = url.searchParams.get("purpose") === "execution" ? "client" : "catalog";
    return jsonResponse({ ok: true, [listKey]: [executionAssetFixture(assetType, `${source}-${assetType}`)] });
  }) as typeof fetch;
  await Promise.all([store.refreshRoles(ctx, WORKSPACE_ID, "execution"), store.refreshWorkflows(ctx, WORKSPACE_ID, "execution")]);
  await Promise.all([store.refreshRoles(ctx, WORKSPACE_ID), store.refreshWorkflows(ctx, WORKSPACE_ID)]);
  const appliedAssets: Array<{ roleIds: string[]; workflowIds: string[] }> = [];
  const source = readFileSync(new URL("../src/features/orchestration/components/task-intake-panel.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function ensurePlannerDataForSelectedIntake()");
  const end = source.indexOf("/** 调度 planner 数据加载", start);
  assert.ok(start >= 0 && end > start);
  const ensurePlannerData = vm.runInNewContext(ts.transpileModule(
    `${source.slice(start, end)}\nensurePlannerDataForSelectedIntake`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText, {
    orch: store, ctx: { value: ctx }, props: { workspaceId: WORKSPACE_ID },
    selectedIntake: { value: { id: "intake-a" } }, isOrchestrationViewActive: () => true,
    buildPlannerDataHydrationKey: () => "hydrated", plannerDataHydratedKey: "hydrated",
    capturePlannerHydrationFence: () => null,
    /** 观察真实规划水合方法向后续步骤暴露的资产 ID。 */
    applyHydratedExecutionPlanForSelectedIntake: async () => {
      appliedAssets.push({ roleIds: store.roles.map(role => role.id), workflowIds: store.workflows.map(workflow => workflow.id) });
    },
  }) as () => Promise<void>;

  await ensurePlannerData();

  assert.deepEqual(appliedAssets, [{ roleIds: ["client-role"], workflowIds: ["client-workflow"] }]);
});

/** 执行真实草案应用方法，HTTP 列表与 store 保持真实以观察来源和选择回写。 */
function assistantApplyHarness(store: ReturnType<typeof useOrchestrationStore>, ctx: ApiRequestContext, response: Promise<unknown>) {
  const source = readFileSync(new URL("../src/features/orchestration/components/AssetAssistantPanel.vue", import.meta.url), "utf8");
  const start = source.indexOf("async function applyDraft()");
  const end = source.indexOf("/** 切到正式资产表单", start);
  assert.ok(start >= 0 && end > start);
  const context = {
    orch: store, ctx: { value: ctx }, props: { workspaceId: WORKSPACE_ID }, assistantUnmounted: false,
    activeDraft: { value: { draftId: "draft-a", jobId: "job-a", state: "ready", payload: { assetKind: "role", baseVersionId: null } } },
    applying: { value: false }, errorText: { value: "" }, candidateWarnings: { value: [] },
    jobStatus: { value: "ready" }, statusText: { value: "" },
    applyAssetAssistantDraft: async () => response, stopPolling() {}, emit() {},
    message: { success() {}, error() {} }, console,
  };
  const apply = vm.runInNewContext(ts.transpileModule(`${source.slice(start, end)}\napplyDraft`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context) as () => Promise<void>;
  return { apply, context };
}

test("资产助手迟到应用回执不把执行角色切回管理列表", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const response = createDeferred<unknown>();
  const purposes: Array<string | null> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    purposes.push(url.searchParams.get("purpose"));
    return jsonResponse({ ok: true, roles: [executionAssetFixture("role", purposes.at(-1) ? "client-role" : "server-role")] });
  }) as typeof fetch;
  const h = assistantApplyHarness(store, ctx, response.promise);
  const applying = h.apply();
  await store.refreshRoles(ctx, WORKSPACE_ID, "execution");
  response.resolve({ ok: true, assetKind: "role", roleId: "server-role", versionId: "version-a" });
  await applying;
  assert.deepEqual(store.roles.map(role => role.id), ["client-role"]);
  assert.equal(store.selectedRoleId, null);
  assert.equal(h.context.activeDraft.value.state, "applied");
  assert.deepEqual(purposes, ["execution"]);
});

test("资产助手应用后的刷新期间切至执行来源不回写管理角色选择", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const catalogResponse = createDeferred<Response>();
  const catalogStarted = createDeferred<void>();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.searchParams.get("purpose") === "execution") return jsonResponse({ ok: true, roles: [executionAssetFixture("role", "client-role")] });
    catalogStarted.resolve();
    return catalogResponse.promise;
  }) as typeof fetch;
  const h = assistantApplyHarness(store, ctx, Promise.resolve({ ok: true, assetKind: "role", roleId: "server-role", versionId: "version-a" }));
  const applying = h.apply();
  await catalogStarted.promise;
  await store.refreshRoles(ctx, WORKSPACE_ID, "execution");
  catalogResponse.resolve(jsonResponse({ ok: true, roles: [executionAssetFixture("role", "server-role")] }));
  await applying;
  assert.deepEqual(store.roles.map(role => role.id), ["client-role"]);
  assert.equal(store.selectedRoleId, null);
});

for (const change of ["workspace", "draft", "unmount"] as const) {
  test(`资产助手迟到应用回执不覆盖已变更的 ${change} 页面`, async () => {
    setActivePinia(createPinia());
    const store = useOrchestrationStore();
    const response = createDeferred<unknown>();
    const h = assistantApplyHarness(store, createApiContext(), response.promise);
    let listReads = 0;
    globalThis.fetch = (async () => { listReads += 1; return jsonResponse({ ok: true, roles: [] }); }) as typeof fetch;
    const applying = h.apply();
    if (change === "workspace") h.context.props.workspaceId = OTHER_WORKSPACE_ID;
    if (change === "unmount") h.context.assistantUnmounted = true;
    h.context.activeDraft.value = { ...h.context.activeDraft.value, draftId: "draft-b", state: "ready" };
    response.resolve({ ok: true, assetKind: "role", roleId: "server-role", versionId: "version-a" });
    await applying;
    assert.equal(h.context.activeDraft.value.draftId, "draft-b");
    assert.equal(h.context.activeDraft.value.state, "ready");
    assert.equal(listReads, 0);
    if (change !== "unmount") assert.equal(h.context.applying.value, false);
  });
}

test("资产页刷新排队期间先同步移除执行候选，避免误入管理编辑", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let listReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    listReads += 1;
    const isRole = new URL(String(input)).pathname === "/api/orch/roles";
    return jsonResponse({ ok: true, [isRole ? "roles" : "workflows"]: [executionAssetFixture(isRole ? "role" : "workflow", "client-asset")] });
  }) as typeof fetch;
  await Promise.all([store.refreshRoles(ctx, WORKSPACE_ID, "execution"), store.refreshWorkflows(ctx, WORKSPACE_ID, "execution")]);
  const source = readFileSync(new URL("../src/features/orchestration/components/orchestration-layout.vue", import.meta.url), "utf8");
  const start = source.indexOf("function scheduleVisibleOrchestrationHydration()");
  const end = source.indexOf("watch([() => props.workspaceId", start);
  assert.ok(start >= 0 && end > start);
  const schedule = vm.runInNewContext(ts.transpileModule(`${source.slice(start, end)}\nscheduleVisibleOrchestrationHydration`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    orch: store, canHydrateOrchestrationView: () => true, routeSection: { value: "assets" }, activeAssetView: { value: "assets" },
    activeAssetTypes: { value: ["role", "workflow"] }, buildVisibleHydrationKey: () => "assets",
    visibleHydrationInFlight: Promise.resolve(), visibleHydrationInFlightKey: "workspace", visibleHydrationQueued: false,
  }) as () => void;

  schedule();

  assert.equal(store.roles.length, 0);
  assert.equal(store.workflows.length, 0);
  assert.deepEqual(store.assetListPurposes, { role: "catalog", workflow: "catalog" });
  assert.equal(listReads, 2);
});

test("legacy response clears prior metadata without rejecting definitions", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    return jsonResponse(requestCount === 1
      ? { ok: true, roles: [{ id: "role-a" }], assetMetadata: [metadata("role", "role-a")] }
      : { ok: true, roles: [{ id: "role-legacy" }] });
  }) as typeof fetch;

  await store.refreshRoles(ctx, WORKSPACE_ID);
  assert.equal(store.assetListMetadata.role?.length, 1);

  await store.refreshRoles(ctx, WORKSPACE_ID);
  assert.deepEqual(store.roles.map((role) => role.id), ["role-legacy"]);
  assert.equal(store.assetListMetadata.role, null);
});

test("inconsistent metadata rejects the refresh and preserves the previous snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    return jsonResponse(requestCount === 1
      ? { ok: true, roles: [{ id: "role-a" }], assetMetadata: [metadata("role", "role-a")] }
      : { ok: true, roles: [{ id: "role-b" }], assetMetadata: [metadata("role", "other-role")] });
  }) as typeof fetch;

  await store.refreshRoles(ctx, WORKSPACE_ID);
  await assert.rejects(
    store.refreshRoles(ctx, WORKSPACE_ID),
    (error: unknown) => error instanceof Error
      && error.name === "OrchestrationAssetListResponseError"
      && !error.message.includes("other-role"),
  );
  assert.deepEqual(store.roles.map((role) => role.id), ["role-a"]);
  assert.equal(store.assetListMetadata.role?.[0]?.assetId, "role-a");
  assert.equal(store.rolesLoading, false);
});

test("API failures remain typed and do not clear the active snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    return jsonResponse(requestCount === 1
      ? { ok: true, skills: [{ id: "skill-a" }], assetMetadata: [metadata("skill", "skill-a")] }
      : { ok: false, code: "INTERNAL_ERROR", message: "load failed", details: { requestId: "request-a" } });
  }) as typeof fetch;

  await store.refreshSkills(ctx, WORKSPACE_ID);
  await assert.rejects(
    store.refreshSkills(ctx, WORKSPACE_ID),
    (error: unknown) => error instanceof ApiResultError
      && error.code === "INTERNAL_ERROR"
      && (error.details as { requestId?: unknown })?.requestId === "request-a",
  );
  assert.deepEqual(store.skills.map((skill) => skill.id), ["skill-a"]);
  assert.equal(store.assetListMetadata.skill?.[0]?.assetId, "skill-a");
});

test("successful local mutation invalidates metadata and workspace reset clears every type", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let deletionBody!: Record<string, any>;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/roles" && init?.method === "GET") {
      return jsonResponse({ ok: true, roles: [{ id: "role-a" }], assetMetadata: [metadata("role", "role-a")] });
    }
    if (pathname === "/api/orch/roles/delete" && init?.method === "POST") {
      deletionBody = requestBody(init);
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  await store.refreshRoles(ctx, WORKSPACE_ID);
  await store.removeRole(ctx, WORKSPACE_ID, "role-a" as RoleId);
  assert.deepEqual(store.roles, []);
  assert.equal(store.assetListMetadata.role, null);
  assert.equal(deletionBody?.expectedRevision, 1);
  assert.match(deletionBody?.clientRequestId ?? "", /^web_[0-9a-f-]{36}$/);

  store.assetListMetadata.workflow = [metadata("workflow", "workflow-a")];
  store.assetListMetadata.skill = [metadata("skill", "skill-a")];
  store.resetForWorkspace();
  assert.deepEqual(store.assetListMetadata, {
    role: null,
    workflow: null,
    knowledge_bundle: null,
    toolset: null,
    skill: null,
  });
  assert.deepEqual(store.assetListLoaded, {
    role: false,
    workflow: false,
    knowledge_bundle: false,
    toolset: false,
    skill: false,
  });
  assert.equal(store.rolesLoading, false);
  assert.equal(store.workflowsLoading, false);
  assert.equal(store.knowledgeBundlesLoading, false);
  assert.equal(store.skillsLoading, false);
  assert.equal(store.toolsetsLoading, false);
});

test("new Server asset creation assigns an id and sends an explicit null revision", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let capturedBody!: Record<string, any>;

  store.skills = [];
  store.assetListMetadata.skill = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = requestBody(init);
    const skill = capturedBody.skill as Record<string, any>;
    return jsonResponse({
      ok: true,
      skill: { ...skill, createdAt: 10, updatedAt: 10 },
      changeSeq: 3,
      cacheStatus: "pending",
      assetMetadata: metadata("skill", String(skill.id), 1),
    });
  }) as typeof fetch;

  const saved = await store.saveSkill(ctx, WORKSPACE_ID, store.createDefaultSkill(WORKSPACE_ID));
  assert.match(String(capturedBody?.skill?.id ?? ""), /^[0-9a-f-]{36}$/);
  assert.equal(saved.id, capturedBody?.skill?.id);
  assert.equal(capturedBody?.expectedRevision, null);
  assert.match(capturedBody?.clientRequestId ?? "", /^web_[0-9a-f-]{36}$/);
  assert.equal(store.assetListMetadata.skill?.[0]?.revision, 1);
});

test("new Server asset creation works when HTTP origin exposes getRandomValues without randomUUID", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  let capturedBody!: Record<string, any>;

  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: {
      getRandomValues<T extends ArrayBufferView>(bytes: T): T {
        new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).fill(0);
        return bytes;
      },
    },
  });
  store.skills = [];
  store.assetListMetadata.skill = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedBody = requestBody(init);
    const skill = capturedBody.skill as Record<string, any>;
    return jsonResponse({
      ok: true,
      skill: { ...skill, createdAt: 10, updatedAt: 10 },
      changeSeq: 3,
      cacheStatus: "pending",
      assetMetadata: metadata("skill", String(skill.id), 1),
    });
  }) as typeof fetch;

  await store.saveSkill(ctx, WORKSPACE_ID, store.createDefaultSkill(WORKSPACE_ID));

  assert.equal(capturedBody?.skill?.id, "00000000-0000-4000-8000-000000000000");
  assert.equal(capturedBody?.clientRequestId, "web_00000000-0000-4000-8000-000000000000");
});

test("Server update and delete carry current revisions and maintain metadata locally", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const requests: Record<string, any>[] = [];
  const existing = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [existing];
  store.assetListMetadata.role = [metadata("role", "role-a", 4)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    const body = requestBody(init);
    requests.push(body);
    if (pathname.endsWith("/upsert")) {
      return jsonResponse({
        ok: true,
        role: { ...body.role, name: "After", createdAt: 1, updatedAt: 2 },
        changeSeq: 8,
        cacheStatus: "pending",
        assetMetadata: metadata("role", "role-a", 5, HASH_B),
      });
    }
    return jsonResponse({ ok: true, changeSeq: 9, cacheStatus: "pending" });
  }) as typeof fetch;

  await store.saveRole(ctx, WORKSPACE_ID, { ...existing, name: "After" });
  assert.equal(requests[0]?.expectedRevision, 4);
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 5);
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);

  await store.removeRole(ctx, WORKSPACE_ID, "role-a" as RoleId);
  assert.equal(requests[1]?.expectedRevision, 5);
  assert.notEqual(requests[0]?.clientRequestId, requests[1]?.clientRequestId);
  assert.deepEqual(store.roles, []);
  assert.deepEqual(store.assetListMetadata.role, []);
});

test("partial Server upsert metadata fails before changing the local definition", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const existing = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [existing];
  store.assetListMetadata.role = [metadata("role", "role-a", 2)];
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    role: { ...existing, name: "After" },
    changeSeq: 7,
  })) as typeof fetch;

  await assert.rejects(
    store.saveRole(ctx, WORKSPACE_ID, { ...existing, name: "After" }),
    (error: unknown) => error instanceof Error && error.name === "OrchestrationAssetListResponseError",
  );
  assert.equal(store.roles[0]?.name, "Before");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 2);
});

test("Server upsert response identity must match the requested asset", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const existing = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [existing];
  store.assetListMetadata.role = [metadata("role", "role-a", 2)];
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    role: { ...existing, id: "role-other", name: "Other" },
    changeSeq: 8,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-other", 1),
  })) as typeof fetch;

  await assert.rejects(
    store.saveRole(ctx, WORKSPACE_ID, { ...existing, name: "After" }),
    (error: unknown) => error instanceof Error && error.name === "OrchestrationAssetListResponseError",
  );
  assert.deepEqual(store.roles, [existing]);
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 2);
});

test("invalid Server delete metadata fails before removing the local definition", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const existing = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [existing];
  store.assetListMetadata.role = [metadata("role", "role-a", 2)];
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    changeSeq: 8,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-a", 3),
  })) as typeof fetch;

  await assert.rejects(
    store.removeRole(ctx, WORKSPACE_ID, "role-a" as RoleId),
    (error: unknown) => error instanceof Error && error.name === "OrchestrationAssetListResponseError",
  );
  assert.deepEqual(store.roles, [existing]);
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 2);
});

test("workspace switch rejects stale refresh results without clearing the new loading state", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const oldResponse = createDeferred<Response>();
  const newResponse = createDeferred<Response>();

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const workspaceId = new URL(String(input)).searchParams.get("workspaceId");
    if (workspaceId === String(WORKSPACE_ID)) return await oldResponse.promise;
    if (workspaceId === String(OTHER_WORKSPACE_ID)) return await newResponse.promise;
    throw new Error(`unexpected workspace: ${workspaceId}`);
  }) as typeof fetch;

  const oldRefresh = store.refreshRoles(ctx, WORKSPACE_ID);
  store.resetForWorkspace();
  const newRefresh = store.refreshRoles(ctx, OTHER_WORKSPACE_ID);
  oldResponse.resolve(jsonResponse({
    ok: true,
    roles: [{ id: "role-old" }],
    assetMetadata: [metadata("role", "role-old")],
  }));
  await oldRefresh;
  assert.equal(store.rolesLoading, true);

  newResponse.resolve(jsonResponse({
    ok: true,
    roles: [{ id: "role-new" }],
    assetMetadata: [metadata("role", "role-new")],
  }));
  await newRefresh;
  assert.deepEqual(store.roles.map((role) => role.id), ["role-new"]);
  assert.equal(store.assetListMetadata.role?.[0]?.assetId, "role-new");
  assert.equal(store.rolesLoading, false);
});

test("successful save keeps its metadata invalidation when an older refresh finishes later", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const oldRefreshResponse = createDeferred<Response>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/skills" && init?.method === "GET") return await oldRefreshResponse.promise;
    if (pathname === "/api/orch/skills/upsert" && init?.method === "POST") {
      return jsonResponse({ ok: true, skill: { id: "skill-saved" } });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  store.skills = [{ id: "skill-before" }] as typeof store.skills;
  store.assetListMetadata.skill = [metadata("skill", "skill-before")];
  const oldRefresh = store.refreshSkills(ctx, WORKSPACE_ID);
  await store.saveSkill(ctx, WORKSPACE_ID, store.createDefaultSkill(WORKSPACE_ID));
  assert.equal(store.assetListMetadata.skill, null);

  oldRefreshResponse.resolve(jsonResponse({
    ok: true,
    skills: [{ id: "skill-stale" }],
    assetMetadata: [metadata("skill", "skill-stale")],
  }));
  await oldRefresh;
  assert.deepEqual(store.skills.map((skill) => skill.id), ["skill-saved", "skill-before"]);
  assert.equal(store.assetListMetadata.skill, null);
  assert.equal(store.skillsLoading, false);
});

test("delayed upsert response cannot overwrite a newer refreshed revision", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();
  const before = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [before];
  store.assetListMetadata.role = [metadata("role", "role-a", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/upsert") && init?.method === "POST") return await saveResponse.promise;
    return jsonResponse({
      ok: true,
      roles: [{ ...before, name: "Newest" }],
      assetMetadata: [metadata("role", "role-a", 3, HASH_B)],
    });
  }) as typeof fetch;

  const saving = store.saveRole(ctx, WORKSPACE_ID, { ...before, name: "Saved" });
  await store.refreshRoles(ctx, WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({
    ok: true,
    role: { ...before, name: "Saved" },
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-a", 2),
  }));

  const saved = await saving;
  assert.equal(saved.name, "Newest");
  assert.equal(store.roles[0]?.name, "Newest");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 3);
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);
});

test("delayed upsert rejects a refreshed equal revision with a different hash", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();
  const before = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [before];
  store.assetListMetadata.role = [metadata("role", "role-a", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/upsert") && init?.method === "POST") return await saveResponse.promise;
    return jsonResponse({
      ok: true,
      roles: [{ ...before, name: "Conflicting" }],
      assetMetadata: [metadata("role", "role-a", 2, HASH_B)],
    });
  }) as typeof fetch;

  const saving = store.saveRole(ctx, WORKSPACE_ID, { ...before, name: "Saved" });
  await store.refreshRoles(ctx, WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({
    ok: true,
    role: { ...before, name: "Saved" },
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-a", 2, HASH_A),
  }));

  await assert.rejects(
    saving,
    (error: unknown) => error instanceof Error && error.name === "OrchestrationAssetListResponseError",
  );
  assert.equal(store.roles[0]?.name, "Conflicting");
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);
});

test("delayed upsert compensates after a refresh with unknown legacy metadata", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();
  const before = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];
  const savedRole = { ...before, name: "Saved" };
  let refreshCalls = 0;

  store.roles = [before];
  store.assetListMetadata.role = [metadata("role", "role-a", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/upsert") && init?.method === "POST") return await saveResponse.promise;
    refreshCalls += 1;
    return refreshCalls === 1
      ? jsonResponse({ ok: true, roles: [{ ...before, name: "Legacy snapshot" }] })
      : jsonResponse({
        ok: true,
        roles: [savedRole],
        assetMetadata: [metadata("role", "role-a", 2)],
      });
  }) as typeof fetch;

  const saving = store.saveRole(ctx, WORKSPACE_ID, savedRole);
  await store.refreshRoles(ctx, WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({
    ok: true,
    role: savedRole,
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-a", 2),
  }));

  const saved = await saving;
  assert.equal(refreshCalls, 2);
  assert.equal(saved.name, "Saved");
  assert.equal(store.roles[0]?.name, "Saved");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 2);
});

test("delayed upsert cannot restore an asset removed by a later authoritative refresh", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();
  const before = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];
  let refreshCalls = 0;

  store.roles = [before];
  store.assetListMetadata.role = [metadata("role", "role-a", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/upsert") && init?.method === "POST") return await saveResponse.promise;
    refreshCalls += 1;
    return jsonResponse({ ok: true, roles: [], assetMetadata: [] });
  }) as typeof fetch;

  const saving = store.saveRole(ctx, WORKSPACE_ID, { ...before, name: "Saved" });
  await store.refreshRoles(ctx, WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({
    ok: true,
    role: { ...before, name: "Saved" },
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-a", 2),
  }));

  await assert.rejects(
    saving,
    (error: unknown) => error instanceof Error && error.name === "OrchestrationAssetListResponseError",
  );
  assert.equal(refreshCalls, 2);
  assert.deepEqual(store.roles, []);
  assert.deepEqual(store.assetListMetadata.role, []);
});

test("new asset upsert compensates when an earlier refresh still saw absence", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();
  const created = { id: "role-new", workspaceId: WORKSPACE_ID, name: "Created" } as typeof store.roles[number];
  let refreshCalls = 0;

  store.roles = [];
  store.assetListMetadata.role = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/upsert") && init?.method === "POST") return await saveResponse.promise;
    refreshCalls += 1;
    return refreshCalls === 1
      ? jsonResponse({ ok: true, roles: [], assetMetadata: [] })
      : jsonResponse({
        ok: true,
        roles: [created],
        assetMetadata: [metadata("role", "role-new", 1)],
      });
  }) as typeof fetch;

  const saving = store.saveRole(ctx, WORKSPACE_ID, created);
  await store.refreshRoles(ctx, WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({
    ok: true,
    role: created,
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: metadata("role", "role-new", 1),
  }));

  const saved = await saving;
  assert.equal(refreshCalls, 2);
  assert.equal(saved.name, "Created");
  assert.deepEqual(store.roles, [created]);
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 1);
});

test("delayed delete response cannot remove an asset refreshed at a newer revision", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const deleteResponse = createDeferred<Response>();
  const before = { id: "role-a", workspaceId: WORKSPACE_ID, name: "Before" } as typeof store.roles[number];

  store.roles = [before];
  store.assetListMetadata.role = [metadata("role", "role-a", 2)];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith("/delete") && init?.method === "POST") return await deleteResponse.promise;
    return jsonResponse({
      ok: true,
      roles: [{ ...before, name: "Restored" }],
      assetMetadata: [metadata("role", "role-a", 3, HASH_B)],
    });
  }) as typeof fetch;

  const deleting = store.removeRole(ctx, WORKSPACE_ID, "role-a" as RoleId);
  await store.refreshRoles(ctx, WORKSPACE_ID);
  deleteResponse.resolve(jsonResponse({ ok: true, changeSeq: 4, cacheStatus: "pending" }));
  await deleting;

  assert.equal(store.roles[0]?.name, "Restored");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 3);
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);
});

test("workspace switch rejects stale mutation results before they alter the new snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const saveResponse = createDeferred<Response>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/skills/upsert" && init?.method === "POST") return await saveResponse.promise;
    if (pathname === "/api/orch/skills" && init?.method === "GET") {
      return jsonResponse({
        ok: true,
        skills: [{ id: "skill-current" }],
        assetMetadata: [metadata("skill", "skill-current")],
      });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  const staleSave = store.saveSkill(ctx, WORKSPACE_ID, store.createDefaultSkill(WORKSPACE_ID));
  store.resetForWorkspace();
  await store.refreshSkills(ctx, OTHER_WORKSPACE_ID);
  saveResponse.resolve(jsonResponse({ ok: true, skill: { id: "skill-old-workspace" } }));

  await assert.rejects(staleSave, (error: unknown) => error instanceof CancelledRequestError && error.kind === "workspace-switch");
  assert.deepEqual(store.skills.map((skill) => skill.id), ["skill-current"]);
  assert.equal(store.assetListMetadata.skill?.[0]?.assetId, "skill-current");
});

test("bundle import invalidates metadata only for asset types returned as changed", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();

  store.assetListMetadata.role = [metadata("role", "role-before")];
  store.assetListMetadata.workflow = [metadata("workflow", "workflow-before")];
  store.assetListMetadata.knowledge_bundle = [metadata("knowledge_bundle", "knowledge-before")];
  store.assetListMetadata.toolset = [metadata("toolset", "toolset-before")];
  store.assetListMetadata.skill = [metadata("skill", "skill-before")];
  let importRequest!: Record<string, unknown>;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    importRequest = requestBody(init);
    return jsonResponse({
      ok: true,
      imported: {
        roles: [{ id: "role-imported" }],
        knowledgeBundles: [],
        skills: [{ id: "skill-imported" }],
        toolsets: [],
        workflows: [],
        warnings: [],
        overwritten: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
        skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
        copied: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      },
    });
  }) as typeof fetch;

  await store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  assert.equal(store.assetListMetadata.role, null);
  assert.equal(store.assetListMetadata.skill, null);
  assert.equal(store.assetListMetadata.workflow?.[0]?.assetId, "workflow-before");
  assert.equal(store.assetListMetadata.knowledge_bundle?.[0]?.assetId, "knowledge-before");
  assert.equal(store.assetListMetadata.toolset?.[0]?.assetId, "toolset-before");
  assert.match(String(importRequest?.clientRequestId ?? ""), /^web_[0-9a-f-]{36}$/);
});

test("bundle import merges complete Server metadata into the current list snapshot", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  store.roles = [{ id: "role-before", name: "Before" }] as typeof store.roles;
  store.assetListMetadata.role = [metadata("role", "role-before", 2)];
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    imported: {
      roles: [{ id: "role-imported", name: "Imported" }],
      knowledgeBundles: [],
      skills: [],
      toolsets: [],
      workflows: [],
      warnings: [],
      overwritten: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      copied: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    },
    changeSeq: 8,
    cacheStatus: "pending",
    assetMetadata: [metadata("role", "role-imported", 1, HASH_B)],
  })) as typeof fetch;

  await store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  assert.deepEqual(store.roles.map((role) => role.id), ["role-imported", "role-before"]);
  assert.deepEqual(store.assetListMetadata.role?.map((item) => [item.assetId, item.revision, item.contentHash]), [
    ["role-imported", 1, HASH_B],
    ["role-before", 2, HASH_A],
  ]);
});

test("bundle import rejects damaged Server metadata before changing local definitions", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  store.roles = [{ id: "role-before", name: "Before" }] as typeof store.roles;
  store.assetListMetadata.role = [metadata("role", "role-before", 2)];
  globalThis.fetch = (async () => jsonResponse({
    ok: true,
    imported: {
      roles: [{ id: "role-imported", name: "Imported" }],
      knowledgeBundles: [],
      skills: [],
      toolsets: [],
      workflows: [],
      warnings: [],
      overwritten: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      copied: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    },
    changeSeq: 8,
    cacheStatus: "pending",
    assetMetadata: [metadata("role", "other-role", 1, HASH_B)],
  })) as typeof fetch;

  await assert.rejects(
    store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle()),
    /资产列表响应无效.*定义缺少对应元数据/,
  );
  assert.deepEqual(store.roles.map((role) => role.id), ["role-before"]);
  assert.deepEqual(store.assetListMetadata.role, [metadata("role", "role-before", 2)]);
});

test("delayed bundle import preserves a higher revision loaded while the import was pending", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const importResponse = createDeferred<Response>();
  let refreshCalls = 0;
  store.roles = [{ id: "role-1", name: "Before" }] as typeof store.roles;
  store.assetListMetadata.role = [metadata("role", "role-1", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/asset-bundles/import") return await importResponse.promise;
    if (pathname === "/api/orch/roles") {
      refreshCalls += 1;
      return jsonResponse({
        ok: true,
        roles: [{ id: "role-1", name: "Newer" }],
        assetMetadata: [metadata("role", "role-1", 3, HASH_B)],
      });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  const importing = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  await store.refreshRoles(ctx, WORKSPACE_ID);
  importResponse.resolve(serverRoleImportResponse("Older import", 2, HASH_A));
  await importing;

  assert.equal(refreshCalls, 2);
  assert.equal(store.roles[0]?.name, "Newer");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 3);
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);
});

test("reversed bundle import responses cannot roll back a newer import", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const firstResponse = createDeferred<Response>();
  const secondResponse = createDeferred<Response>();
  let importCalls = 0;
  let refreshCalls = 0;
  store.roles = [{ id: "role-1", name: "Before" }] as typeof store.roles;
  store.assetListMetadata.role = [metadata("role", "role-1", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/asset-bundles/import") {
      importCalls += 1;
      return await (importCalls === 1 ? firstResponse.promise : secondResponse.promise);
    }
    if (pathname === "/api/orch/roles") {
      refreshCalls += 1;
      return jsonResponse({
        ok: true,
        roles: [{ id: "role-1", name: "Newest import" }],
        assetMetadata: [metadata("role", "role-1", 3, HASH_B)],
      });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  const firstImport = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  const secondImport = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  secondResponse.resolve(serverRoleImportResponse("Newest import", 3, HASH_B));
  await secondImport;
  firstResponse.resolve(serverRoleImportResponse("Older import", 2, HASH_A));
  await firstImport;

  assert.equal(refreshCalls, 1);
  assert.equal(store.roles[0]?.name, "Newest import");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 3);
  assert.equal(store.assetListMetadata.role?.[0]?.contentHash, HASH_B);
});

test("bundle reconciliation rejects a workspace switch while its refresh is pending", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const importResponse = createDeferred<Response>();
  const reconcileRefresh = createDeferred<Response>();
  const reconcileStarted = createDeferred<void>();
  let refreshCalls = 0;
  store.roles = [{ id: "role-1", name: "Before" }] as typeof store.roles;
  store.assetListMetadata.role = [metadata("role", "role-1", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/asset-bundles/import") return await importResponse.promise;
    if (pathname === "/api/orch/roles") {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return jsonResponse({
          ok: true,
          roles: [{ id: "role-1", name: "Before" }],
          assetMetadata: [metadata("role", "role-1", 1)],
        });
      }
      reconcileStarted.resolve();
      return await reconcileRefresh.promise;
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  const importing = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  await store.refreshRoles(ctx, WORKSPACE_ID);
  importResponse.resolve(serverRoleImportResponse("Imported", 2, HASH_B));
  await reconcileStarted.promise;
  store.resetForWorkspace();
  reconcileRefresh.resolve(jsonResponse({
    ok: true,
    roles: [{ id: "role-1", name: "Imported" }],
    assetMetadata: [metadata("role", "role-1", 2, HASH_B)],
  }));

  await assert.rejects(
    importing,
    (error: unknown) => error instanceof CancelledRequestError && error.kind === "workspace-switch",
  );
  assert.deepEqual(store.roles, []);
  assert.equal(store.assetListMetadata.role, null);
});

test("bundle reconciliation includes another asset type changed during a pending refresh", async () => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore();
  const ctx = createApiContext();
  const importResponse = createDeferred<Response>();
  const roleReconcile = createDeferred<Response>();
  const roleReconcileStarted = createDeferred<void>();
  let roleRefreshCalls = 0;
  let skillRefreshCalls = 0;
  store.roles = [{ id: "role-1", name: "Before" }] as typeof store.roles;
  store.skills = [{ id: "skill-1", name: "Before" }] as typeof store.skills;
  store.assetListMetadata.role = [metadata("role", "role-1", 1)];
  store.assetListMetadata.skill = [metadata("skill", "skill-1", 1)];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/api/orch/asset-bundles/import") return await importResponse.promise;
    if (pathname === "/api/orch/roles") {
      roleRefreshCalls += 1;
      if (roleRefreshCalls === 1) {
        return jsonResponse({
          ok: true,
          roles: [{ id: "role-1", name: "Before" }],
          assetMetadata: [metadata("role", "role-1", 1)],
        });
      }
      roleReconcileStarted.resolve();
      return await roleReconcile.promise;
    }
    if (pathname === "/api/orch/skills") {
      skillRefreshCalls += 1;
      return jsonResponse({
        ok: true,
        skills: [{ id: "skill-1", name: "Newer skill" }],
        assetMetadata: [metadata("skill", "skill-1", 3, HASH_A)],
      });
    }
    throw new Error(`unexpected request: ${pathname}`);
  }) as typeof fetch;

  const importing = store.importWorkflowBundle(ctx, WORKSPACE_ID, emptyAssetBundle());
  await store.refreshRoles(ctx, WORKSPACE_ID);
  importResponse.resolve(serverRoleAndSkillImportResponse());
  await roleReconcileStarted.promise;
  await store.refreshSkills(ctx, WORKSPACE_ID);
  roleReconcile.resolve(jsonResponse({
    ok: true,
    roles: [{ id: "role-1", name: "Imported role" }],
    assetMetadata: [metadata("role", "role-1", 2, HASH_B)],
  }));
  await importing;

  assert.equal(roleRefreshCalls, 2);
  assert.equal(skillRefreshCalls, 2);
  assert.equal(store.roles[0]?.name, "Imported role");
  assert.equal(store.skills[0]?.name, "Newer skill");
  assert.equal(store.assetListMetadata.role?.[0]?.revision, 2);
  assert.equal(store.assetListMetadata.skill?.[0]?.revision, 3);
});

/** 构造一个只写入角色的 Server 资产包导入响应。 */
function serverRoleImportResponse(name: string, revision: number, contentHash: string): Response {
  return jsonResponse({
    ok: true,
    imported: {
      roles: [{ id: "role-1", name }],
      knowledgeBundles: [],
      skills: [],
      toolsets: [],
      workflows: [],
      warnings: [],
      overwritten: { roles: 1, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      copied: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    },
    changeSeq: revision,
    cacheStatus: "pending",
    assetMetadata: [metadata("role", "role-1", revision, contentHash)],
  });
}

/** 构造一个同时写入角色和 Skill 的 Server 资产包导入响应。 */
function serverRoleAndSkillImportResponse(): Response {
  return jsonResponse({
    ok: true,
    imported: {
      roles: [{ id: "role-1", name: "Imported role" }],
      knowledgeBundles: [],
      skills: [{ id: "skill-1", name: "Imported skill" }],
      toolsets: [],
      workflows: [],
      warnings: [],
      overwritten: { roles: 1, knowledgeBundles: 0, skills: 1, toolsets: 0, workflows: 0 },
      skipped: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
      copied: { roles: 0, knowledgeBundles: 0, skills: 0, toolsets: 0, workflows: 0 },
    },
    changeSeq: 2,
    cacheStatus: "pending",
    assetMetadata: [
      metadata("role", "role-1", 2, HASH_B),
      metadata("skill", "skill-1", 2, HASH_B),
    ],
  });
}
