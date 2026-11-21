import assert from "node:assert/strict";
import test from "node:test";

import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

import type { OrchAssetGroup, WorkspaceId } from "@codeflowai/shared";

import {
  copyAssetGroupAssignments,
  hasAssetGroupAssignment,
  isCurrentAssetGroupWorkspace,
  useAssetGroups,
} from "../src/features/orchestration/composables/useAssetGroups.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useOrchestrationStore } from "../src/store/orchestration.ts";

const WORKSPACE_A = "workspace-a" as WorkspaceId;
const WORKSPACE_B = "workspace-b" as WorkspaceId;

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** 构造统一 JSON API 响应。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 装配带账号会话的 pinia 上下文，供组合式函数直接使用。 */
function setupStores(): void {
  setActivePinia(createPinia());
  const config = useConfigStore();
  config.serverWsOrigin = "ws://127.0.0.1:39280";
  config.webSessionId = "web-demo";
  config.ensureSession = async () => "session-demo";
}

/** 构造一条工作区分组记录。 */
function makeGroup(id: string, name: string): OrchAssetGroup {
  return { id, workspaceId: WORKSPACE_A, assetType: "workflow", name, createdAt: 1, updatedAt: 1 };
}

test("asset group async results require the exact workspace generation", () => {
  assert.equal(isCurrentAssetGroupWorkspace(WORKSPACE_A, WORKSPACE_A, 2, 2), true);
  assert.equal(isCurrentAssetGroupWorkspace(WORKSPACE_A, WORKSPACE_B, 2, 2), false);
  assert.equal(isCurrentAssetGroupWorkspace(WORKSPACE_A, WORKSPACE_A, 1, 2), false);
});

test("Client原件不能被移动到Server分组，同ID账号资产仍可正常移动", async () => {
  setupStores();
  const orch = useOrchestrationStore();
  const workspaceId = "remote:asset-group-guard" as WorkspaceId;
  orch.resetForWorkspace(workspaceId);
  orch.assetListHostIds.workflow = ["host-workflow"];
  const groups = useAssetGroups({ workspaceId: ref(workspaceId), assetType: "workflow" });
  let writes = 0;
  globalThis.fetch = (async () => { writes++; return jsonResponse({ ok: true, groupId: "group-1" }); }) as typeof fetch;
  await assert.rejects(groups.assign("host-workflow", "group-1"), /Host.*只读/u);
  assert.equal(writes, 0);
  await groups.assign("server-workflow", "group-1");
  assert.equal(writes, 1);
});

test("asset group assignments preserve special asset IDs without prototype inheritance", () => {
  const source = JSON.parse('{"toString":"group-1","constructor":"group-1","__proto__":"group-2"}') as Record<string, string>;
  const assignments = copyAssetGroupAssignments(source);

  assert.equal(Object.getPrototypeOf(assignments), null);
  assert.equal(hasAssetGroupAssignment(assignments, "toString"), true);
  assert.equal(hasAssetGroupAssignment(assignments, "constructor"), true);
  assert.equal(hasAssetGroupAssignment(assignments, "__proto__"), true);
  assert.equal(assignments.__proto__, "group-2");

  const filtered = copyAssetGroupAssignments(assignments, "group-1");
  assert.equal(hasAssetGroupAssignment(filtered, "toString"), false);
  assert.equal(hasAssetGroupAssignment(filtered, "constructor"), false);
  assert.equal(hasAssetGroupAssignment(filtered, "__proto__"), true);
  assert.equal(hasAssetGroupAssignment(copyAssetGroupAssignments({}), "toString"), false);
});

// 本用例不挂载组件，组件的 onMounted 注册会打印 Vue warn，属预期噪音。
test("资产分组命中跨挂载缓存，且本地新建的分组写回缓存", async () => {
  setupStores();
  let listCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/orch/asset-groups/create")) return jsonResponse({ ok: true, group: makeGroup("group-b", "分组 B") });
    if (url.includes("/api/orch/asset-groups?")) {
      listCalls += 1;
      return jsonResponse({ ok: true, groups: [makeGroup("group-a", "分组 A")], assignments: { "wf-1": "group-a" } });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const workspaceId = ref(WORKSPACE_A);
  const first = useAssetGroups({ workspaceId, assetType: "workflow" });

  await first.load();
  assert.equal(listCalls, 1);
  assert.deepEqual(first.groups.value.map((group) => group.name), ["分组 A"]);

  await first.create("分组 B");

  // 模拟切换资产 Tab 后组件重建：应复用缓存且不再请求，新建分组与归属关系仍在。
  const second = useAssetGroups({ workspaceId, assetType: "workflow" });
  await second.load();

  assert.equal(listCalls, 1);
  assert.deepEqual(second.groups.value.map((group) => group.name), ["分组 A", "分组 B"]);
  assert.equal(hasAssetGroupAssignment(second.assignments.value, "wf-1"), true);
});
