import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import * as vue from "vue";
import ts from "typescript";
import * as shared from "@codeflowai/shared";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { useAccountStore } from "../src/store/account.ts";
import { useConfigStore } from "../src/store/config.ts";

const panelSource = readFileSync(
  new URL("../src/features/admin/components/shared-workspace-panel.vue", import.meta.url),
  "utf8",
);

test("shared workspace panel keeps grid rows at their content height", () => {
  assert.match(
    panelSource,
    /\.shared-workspace-panel\s*\{[^}]*align-content:\s*start;/s,
  );
});

test("shared workspace panel keeps membership status without the retired usage column", () => {
  assert.match(panelSource, /成员状态/);
  assert.doesNotMatch(panelSource, /用量状态/);
  assert.doesNotMatch(panelSource, /usageEligibilityLabel/);
  assert.match(panelSource, /member\.usageEligibility\?\.eligible === true/);
});

/** 执行真实组件 setup，仅替换 Store 和 UI 边界以控制摘要请求。 */
function setupPanel(t: test.TestContext, role = "enterprise_admin") {
  const require = createRequire(import.meta.url);
  const { parse, compileScript } = require("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = compileScript(parse(panelSource).descriptor, { id: "shared-workspace-summary" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let resolveSummary!: (summary: unknown) => void;
  let rejectSummary!: (error: Error) => void;
  const pending = new Promise((resolve, reject) => { resolveSummary = resolve; rejectSummary = reject; });
  const calls: Array<unknown> = [], errors: string[] = [], memberCalls: unknown[] = [], listCalls: unknown[] = [];
  const account = vue.reactive({ enterpriseSummary: null as any, enterpriseMembers: [
    { userId: "member", fullName: "Member", email: "member@example.test", accountStatus: "active", keyStatus: "active" },
  ], async loadEnterpriseSummary(force: boolean, options: object) {
    calls.push({ force, options });
    const summary = await pending;
    account.enterpriseSummary = summary;
    return summary;
  }, async loadEnterpriseMembers(...args: unknown[]) { memberCalls.push(args); return account.enterpriseMembers; } });
  const config = vue.reactive({ accountRole: role, userSummary: { enterpriseId: "enterprise" } });
  const stores: Record<string, unknown> = { account, config, admin: { enterprises: [] },
    sharedWorkspaces: { items: [], total: 0, setSelectedWorkspace() {}, async loadList(query: unknown) { listCalls.push(query); return { ok: true }; } },
    presence: { online: { onlineClients: [] } }, workspaces: { workspaces: [] } };
  const load = (id: string) => {
    if (id === "vue") return { ...vue, onMounted() {}, onBeforeUnmount() {} };
    if (id === "ant-design-vue") return { Modal: {}, message: { error: (text: string) => errors.push(text) } };
    if (id === "@codeflowai/shared") return shared;
    if (id.endsWith("/workspaceDisplay")) return { getWorkspaceDisplayTitle: () => "fixture" };
    const name = id.split("/").at(-1)!;
    assert.ok(name in stores, `unexpected import ${id}`);
    return { [`use${name[0].toUpperCase()}${name.slice(1)}Store`]: () => stores[name] };
  };
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", compiled)(load, module, module.exports);
  const scope = vue.effectScope();
  const panel = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  t.after(() => scope.stop());
  return { panel, account, config, calls, memberCalls, listCalls, errors, resolveSummary, rejectSummary };
}

/** 排空组件 watcher 的有限异步续体。 */
async function settle(): Promise<void> {
  await vue.nextTick();
  await new Promise<void>(resolve => setImmediate(resolve));
}

for (const role of ["personal_normal", "personal_pro"]) test(`非企业管理员 ${role} 读取与刷新共享列表不请求企业管理接口`, async t => {
  const f = setupPanel(t, role);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(f.memberCalls.length, 0);
  assert.equal(f.listCalls.length, 1);
  assert.equal(f.panel.canCreate.value, false);
  assert.deepEqual(f.panel.workspaceAdminOptions.value, [], "不能展示以前缓存的企业管理员候选");
  await f.panel.refreshPanel();
  assert.equal(f.calls.length, 0);
  assert.equal(f.memberCalls.length, 0);
  assert.equal(f.listCalls.length, 2);
  assert.deepEqual(f.errors, []);
});

test("同企业权限降级后丢弃旧摘要失败，恢复管理员权限才重新请求候选", async t => {
  const f = setupPanel(t);
  await settle();
  assert.equal(f.calls.length, 1);
  f.config.accountRole = "personal_normal";
  await settle();
  assert.equal(f.panel.enterpriseSummaryLoading.value, false);
  assert.deepEqual(f.panel.workspaceAdminOptions.value, []);
  f.rejectSummary(new Error("旧管理员请求失败"));
  await settle();
  assert.equal(f.panel.enterpriseSummaryError.value, "");
  assert.deepEqual(f.errors, []);
  t.mock.method(f.account, "loadEnterpriseSummary", async () => {
    f.calls.push("new-admin");
    f.account.enterpriseSummary = { enterpriseId: "enterprise", status: "active" };
    return f.account.enterpriseSummary;
  });
  f.config.accountRole = "enterprise_admin";
  await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, false);
  assert.equal(f.panel.createForm.workspaceAdminUserId, "member");
});

test("共享空间首次进入加载企业摘要，正常企业成员无需人月即可选", async t => {
  const f = setupPanel(t);
  await settle();
  assert.equal(f.calls.length, 1);
  assert.equal(f.panel.workspaceAdminOptions.value[0].hint, "企业资格加载中");
  f.resolveSummary({ enterpriseId: "enterprise", status: "active", entitlement: { openedAt: 1 } });
  await settle();
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, false);
  assert.equal(f.panel.createForm.workspaceAdminUserId, "member");
});

test("共享空间企业摘要失败明确显示失败，不能显示成未开通", async t => {
  const f = setupPanel(t);
  await settle();
  assert.equal(f.calls.length, 1);
  f.rejectSummary(new Error("fixture summary unavailable"));
  await settle();
  assert.equal(f.panel.workspaceAdminOptions.value[0].hint, "企业资格加载失败，请重试");
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, true);
  assert.equal(f.errors.length, 1);
  t.mock.method(f.account, "loadEnterpriseSummary", async () => {
    f.account.enterpriseSummary = { enterpriseId: "enterprise", status: "active", entitlement: { openedAt: 1 } };
    return f.account.enterpriseSummary;
  });
  await f.panel.refreshPanel();
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, false);
  assert.equal(f.panel.createForm.workspaceAdminUserId, "member");
});

test("切换企业后旧摘要失败不能覆盖当前企业的有效候选", async t => {
  const f = setupPanel(t);
  await settle();
  t.mock.method(f.account, "loadEnterpriseSummary", async (_force: boolean, options: object) => {
    f.account.enterpriseSummary = { enterpriseId: (options as { enterpriseId: string }).enterpriseId,
      status: "active", entitlement: { openedAt: 1 } };
    return f.account.enterpriseSummary;
  });
  f.config.userSummary.enterpriseId = "other";
  await settle();
  f.config.userSummary.enterpriseId = "enterprise";
  await settle();
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, false);
  f.rejectSummary(new Error("stale summary failed"));
  await settle();
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, false);
  assert.deepEqual(f.errors, []);
});

for (const status of ["active", "disabled"]) test(`共享空间无历史付费权益的${status}企业按状态确定候选资格`, async t => {
  const f = setupPanel(t);
  await settle();
  assert.equal(f.calls.length, 1);
  f.resolveSummary({ enterpriseId: "enterprise", status, entitlement: null });
  await settle();
  assert.equal(f.panel.workspaceAdminOptions.value[0].disabled, status === "disabled");
  assert.equal(f.panel.workspaceAdminOptions.value[0].hint, status === "disabled" ? "企业已停用" : "");
  assert.equal(f.panel.createForm.workspaceAdminUserId, status === "disabled" ? "" : "member");
});

for (const outcome of ["api", "network"] as const) test(`企业摘要${outcome}失败必须拒绝请求并记录关联ID`, async t => {
  const pinia = createPinia();
  setActivePinia(pinia);
  const config = useConfigStore(), account = useAccountStore();
  account.resetRuntimeState();
  config.$patch({ authMode: "account", accountRole: "enterprise_admin", serverWsOrigin: "wss://cloud.example",
    sessionToken: "session-fixture", sessionExpiresAt: Date.now() + 60_000,
    userSummary: { userId: "owner", enterpriseId: "enterprise" } as any });
  t.after(() => { account.resetRuntimeState(); disposePinia(pinia); });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () => {
    if (outcome === "network") throw new TypeError("fixture-network-secret");
    return new Response(JSON.stringify({ ok: false, code: "CONFLICT", message: "fixture-private-message",
      details: { requestId: "summary-request-1" } }), { status: 409 });
  });
  await assert.rejects(account.loadEnterpriseSummary(true), /企业资格加载失败/);
  assert.equal(account.enterpriseSummary, null);
  assert.equal(account.enterpriseLoading, false);
  assert.equal(logs.length, 1);
  const detail = logs[0][1] as Record<string, unknown>;
  assert.equal(detail.code, "ACCOUNT_ENTERPRISE_SUMMARY_FAILED");
  assert.equal(detail.enterpriseId, "enterprise");
  assert.equal(typeof detail.requestId, "string");
  if (outcome === "api") assert.equal(detail.requestId, "summary-request-1");
  assert.doesNotMatch(JSON.stringify(logs), /session-fixture|fixture-network-secret|fixture-private-message/);
});
