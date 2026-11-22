import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as vue from "vue";
import { resolveWorkspaceClientInfo } from "../src/composables/useAppShell.ts";
import * as policy from "../src/features/settings/clientUpgradePolicy.ts";
import * as labels from "../src/components/app-shell/desktopLocalClientStatus.ts";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

/** 执行真实组件 setup，仅替换外部请求和生命周期，计时器由测试手动驱动。 */
function setup(t: test.TestContext, path: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(compileScript(parse(source).descriptor, { id: "version-boundaries" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", "setInterval", "setTimeout", "clearInterval", "clearTimeout", compiled)(
    (id: string) => {
      if (id === "vue") return { ...vue, onMounted() {}, onUnmounted() {} };
      if (id in modules) return modules[id];
      if (id === "ant-design-vue" || id === "@ant-design/icons-vue") return {};
      throw new Error(`unexpected version test import: ${id}`);
    }, module, module.exports, () => 1, () => 2, () => {}, () => {});
  const scope = vue.effectScope();
  const props = vue.reactive({ open: false });
  const actions = scope.run(() => module.exports.default.setup(props, { expose() {}, emit() {} }))!;
  actions.testProps = props;
  t.after(() => scope.stop());
  return actions;
}

/** 建立两台 Client 在线的升级场景，聚合版本故意取另一台电脑。 */
function upgradeFixture(t: test.TestContext) {
  const config = vue.reactive({ workspaceId: "client-a:main", serverWsOrigin: "wss://test", sessionToken: "session-a",
    clientVersion: "2026.11.20.01", latestClientVersion: "2026.11.21.01", setClientVersionInfo(value: any) { Object.assign(config, value); } });
  const client = { clientId: "client-a", version: "2026.11.20.01", workspaceIds: ["client-a:main"], platform: "win32", arch: "x64" };
  let response: any = { ok: true, clientConnected: true, clientVersion: "2026.11.21.01", latestClientVersion: "2026.11.21.01",
    clients: [{ ...client, version: "2026.11.20.01" }, { clientId: "client-b", version: "2026.11.21.01", workspaceIds: ["client-b:main"] }] };
  let requestFailure: Error | null = null;
  let startUpgrade: () => Promise<unknown> = async () => ({ ok: true, upgradeStarted: true });
  let latest: () => Promise<unknown> = async () => ({ ok: true, version: "2026.11.21.01", url: "/client-a.tgz" });
  const modules = {
    "../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.computed(() => ({ serverWsOrigin: config.serverWsOrigin, sessionToken: config.sessionToken })) }) },
    "../../../store/config": { useConfigStore: () => config },
    "../../../store/presence": { usePresenceStore: () => ({ availableClients: [client], clientForWorkspace: () => client }) },
    "../../../store/workspaces": { useWorkspacesStore: () => ({ byId: new Map([[config.workspaceId, { ownerClientId: "client-a" }]]) }) },
    "../../../composables/useAppShell": { resolveWorkspaceClientInfo },
    "../../../api/request": { isCancelledRequestError: () => false, wsOriginToHttpOrigin: (value: string) => value,
      requestJson: async () => { if (requestFailure) throw requestFailure; return typeof response === "function" ? await response() : response; } },
    "../../../api/software": { upgradeClient: async () => await startUpgrade(), getClientLatest: async () => await latest(),
      getClientUpgradeStatus: async () => ({ ok: true, phase: "pending" }) },
    "../clientUpgradePolicy": policy,
    "../../../analytics/analytics": { trackProductEvent() {} },
  };
  const actions = setup(t, "features/settings/components/client-upgrade-modal.vue", modules);
  actions.latestVersion.value = "2026.11.21.01";
  return { actions, config, client, setResponse(value: any) { response = value; }, setFailure(error: Error) { requestFailure = error; },
    setUpgrade(fn: () => Promise<unknown>) { startUpgrade = fn; }, setLatest(fn: () => Promise<unknown>) { latest = fn; } };
}

/** 排空升级启动后的首次轮询。 */
async function settle() { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); }

test("升级不能借另一台 Client 的聚合版本成功", async t => {
  const f = upgradeFixture(t);
  await f.actions.doUpgrade(); await settle();
  assert.equal(f.actions.phase.value, "restarting");
  assert.equal(f.config.clientVersion, "2026.11.20.01");
});

test("升级成功使用原目标 Client 实际确认版本", async t => {
  const f = upgradeFixture(t);
  f.setResponse({ ok: true, clientConnected: true, clientVersion: "2026.11.21.01", latestClientVersion: "2026.11.21.01",
    clients: [{ ...f.client, version: "2026.11.22.02" }] });
  await f.actions.doUpgrade(); await settle();
  assert.equal(f.actions.phase.value, "success");
  assert.equal(f.config.clientVersion, "2026.11.22.02");
  assert.equal(f.actions.confirmedVersion.value, "2026.11.22.02");
});

test("等待重连期间切换工作区后不写回版本", async t => {
  const f = upgradeFixture(t);
  await f.actions.doUpgrade(); await settle();
  f.config.workspaceId = "client-b:main";
  await f.actions.pollReconnectStatus();
  assert.notEqual(f.actions.phase.value, "success");
  assert.equal(f.config.clientVersion, "2026.11.20.01");
  assert.ok(f.actions.upgradeError.value);
});

test("重连查询异常显式失败并停止等待", async t => {
  const f = upgradeFixture(t);
  f.setFailure(new Error("status unavailable"));
  await f.actions.doUpgrade(); await settle();
  assert.equal(f.actions.phase.value, "idle");
  assert.match(f.actions.upgradeError.value, /status unavailable/u);
});

test("上次升级迟到的重连结果不能完成下一次升级", async t => {
  const f = upgradeFixture(t);
  let release!: (value: unknown) => void;
  f.setResponse(() => new Promise(resolve => { release = resolve; }));
  await f.actions.doUpgrade(); await settle();
  // 模拟旧请求仍在途时新的升级轮次；相同账号和工作区也必须区分请求代次。
  await f.actions.doUpgrade();
  release({ ok: true, latestClientVersion: "2026.11.21.01", clients: [{ ...f.client, version: "2026.11.22.02" }] });
  await settle();
  assert.notEqual(f.actions.phase.value, "success");
  assert.equal(f.config.clientVersion, "2026.11.20.01");
});

test("上次升级启动请求迟到失败不能清除新轮次的成功版本", async t => {
  const f = upgradeFixture(t);
  let rejectFirst!: (reason: unknown) => void;
  f.setUpgrade(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
  const first = f.actions.doUpgrade();
  f.setUpgrade(async () => ({ ok: true, upgradeStarted: true }));
  f.setResponse({ ok: true, clients: [{ ...f.client, version: "2026.11.22.02" }] });
  await f.actions.doUpgrade(); await settle();
  assert.equal(f.actions.phase.value, "success");
  rejectFirst(new Error("OLD_REQUEST_FAILED")); await first;
  assert.equal(f.actions.phase.value, "success");
  assert.equal(f.actions.upgradeError.value, null);
  assert.equal(f.actions.confirmedVersion.value, "2026.11.22.02");
});

for (const outcome of ["success", "failure"] as const)
test(`旧工作区最新版本查询迟到${outcome}不能覆盖新目标`, async t => {
  const f = upgradeFixture(t);
  let complete!: (value: unknown) => void, rejectFirst!: (reason: unknown) => void;
  f.setLatest(() => new Promise((resolve, reject) => { complete = resolve; rejectFirst = reject; }));
  const first = f.actions.fetchLatest();
  f.config.workspaceId = "client-b:main";
  f.setLatest(async () => ({ ok: true, version: "2026.11.23.01", url: "/client-b.tgz" }));
  await f.actions.fetchLatest();
  if (outcome === "success") complete({ ok: true, version: "2026.11.21.01", url: "/client-a.tgz" });
  else rejectFirst(new Error("OLD_LATEST_FAILED"));
  await first;
  assert.equal(f.actions.latestVersion.value, "2026.11.23.01");
  assert.equal(f.actions.downloadUrl.value, "/client-b.tgz");
  assert.equal(f.actions.upgradeError.value, null);
});

test("关闭升级弹框后迟到的最新版本不恢复旧数据", async t => {
  const f = upgradeFixture(t);
  let release!: (value: unknown) => void;
  f.actions.testProps.open = true; await settle();
  f.setLatest(() => new Promise(resolve => { release = resolve; }));
  const pending = f.actions.fetchLatest();
  f.actions.testProps.open = false; await settle();
  release({ ok: true, version: "2026.11.25.01", url: "/old.tgz" }); await pending;
  assert.notEqual(f.actions.latestVersion.value, "2026.11.25.01");
});

/** 反馈以真实组件组合本机应用与目标工作区事实，允许控制慢宿主响应。 */
function feedbackFixture(t: test.TestContext) {
  const config = vue.reactive({ isDesktop: true, authMode: "account", hasActiveSession: true, workspaceId: "remote:main",
    clientVersion: "2026.11.18.01", desktopClient: { version: "2026.11.20.01", platform: "win32" } });
  let submitted: any, readDetails: () => Promise<unknown> = async () => ({ current: { shellVersion: "1.12", bundle: { version: "2026.11.20.02" } } });
  let detailsAvailable = true;
  const actions = setup(t, "features/feedback/components/feedback-modal.vue", {
    "../../../composables/useApiContext": { useApiContext: () => ({ ctx: vue.ref({}) }) },
    "../../../store/config": { useConfigStore: () => config },
    "../../../store/ui": { useUiStore: () => ({ mainView: "chat" }) },
    "../../../store/presence": { usePresenceStore: () => ({ availableClients: [{ clientId: "remote", workspaceIds: ["remote:main"], version: "2026.11.19.02" }] }) },
    "../../../store/workspaces": { useWorkspacesStore: () => ({ byId: new Map([["remote:main", { ownerClientId: "remote" }]]) }) },
    "../../../composables/useAppShell": { resolveWorkspaceClientInfo },
    "../../../components/app-shell/desktopLocalClientStatus": labels,
    "../../../api/feedback": { submitFeedback: async (_ctx: unknown, body: unknown) => { submitted = body; return { ticketNo: "FB1" }; } },
    "../../../services/desktop": { getDesktopUpdateCapabilities: () => ({ details: detailsAvailable }), getDesktopUpdateDetails: async () => await readDetails() },
    "../../composer/useComposerAttachments": {},
  });
  actions.content.value = "反馈内容超过十个字用于验证版本";
  return { actions, config, submitted: () => submitted, setDetails(fn: () => Promise<unknown>) { readDetails = fn; },
    setDetailsAvailable(value: boolean) { detailsAvailable = value; } };
}

test("反馈应用版本来自本机壳和资源，Client 版本来自目标工作区", async t => {
  const f = feedbackFixture(t);
  await f.actions.submit();
  assert.equal(f.submitted()?.environment.appVersion, "1.12.1120.2");
  assert.equal(f.submitted()?.environment.clientVersion, "2026.11.19.02");
  assert.equal(f.submitted()?.environment.workspaceId, "remote:main");
});

test("反馈缺应用事实不借Client号，真实读取失败显式中止提交", async t => {
  const f = feedbackFixture(t);
  f.setDetailsAvailable(false);
  await f.actions.submit();
  assert.equal(f.submitted()?.environment.appVersion, null);
  f.actions.content.value = "重新提交反馈用于验证明确失败";
  f.setDetailsAvailable(true); f.setDetails(async () => { throw new Error("VERSION_READ_FAILED"); });
  const previous = f.submitted();
  await f.actions.submit();
  assert.equal(f.submitted(), previous);
  assert.equal(f.actions.errorText.value, "VERSION_READ_FAILED");
});

test("读取版本期间切换工作区不能混合反馈环境", async t => {
  const f = feedbackFixture(t);
  let release!: (value: unknown) => void;
  f.setDetails(() => new Promise(resolve => { release = resolve; }));
  const pending = f.actions.submit();
  f.config.workspaceId = "another:workspace";
  release({ current: { shellVersion: "1.12", bundle: { version: "2026.11.20.02" } } });
  await pending;
  assert.equal(f.submitted(), undefined);
  assert.match(f.actions.errorText.value, /工作区已变化/u);
});

test("发布日志按scope显示标签，公开会话不暴露unknown占位", () => {
  /** 执行真实纯标签方法，不替换其判断规则。 */
  const extract = (file: string, names: string[]) => {
    const script = parse(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8")).descriptor.scriptSetup!.content;
    const tree = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    const declarations = tree.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name!.text));
    return new Function(ts.transpile(declarations.map(node => node.getText(tree)).join("\n"), { target: ts.ScriptTarget.ES2022 }) + `; return {${names.join(",")}};`)();
  };
  const scope = extract("features/landing/components/upgrade-page.vue", ["releaseScopeLabel"]);
  assert.deepEqual(["full", "server", "client", "product", undefined].map(value => scope.releaseScopeLabel(value)), ["完整发布", "Server", "Client", "产品", "发布"]);
  const sessions = extract("features/admin/components/admin-sessions-panel.vue", ["formatSessionClientVersion", "resolveUnknownVersionHint"]);
  for (const clientVersion of [null, "", " unknown ", "UNKNOWN"]) {
    assert.equal(sessions.formatSessionClientVersion({ clientVersion }), "未知版本");
    assert.ok(sessions.resolveUnknownVersionHint({ clientVersion, sessionKind: "client" }));
  }
});
