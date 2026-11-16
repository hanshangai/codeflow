import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPinia, setActivePinia } from "pinia";
import * as vue from "vue";
import { useConfigStore } from "../src/store/config.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";
import { deleteEngineKey, listEngineKeys, upsertEngineKey } from "../src/api/engineKeys.ts";
import type { ApiRequestContext } from "../src/api/request.ts";
import type { DesktopApiRequest, EngineKeyEntry } from "@codeflowai/shared";

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
type TemplateNode = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>["children"][number];
type Surface = "narrow" | "wide" | "profile";

/** 从真实模板AST定位入口，仅按可见标签/key选择，不复制禁用或导航公式。 */
function entryNode(nodes: TemplateNode[], surface: Surface): TemplateNode | undefined {
  for (const node of nodes) {
    if (node.type !== 1) continue;
    const matches = surface === "wide"
      ? node.tag === "a-tab-pane" && node.props.some(prop => prop.type === 6 && prop.name === "key" && prop.value?.content === "engine-keys")
      : surface === "profile"
        ? node.tag === "button" && node.loc.source.includes("<strong>模型与密钥</strong>")
        : node.tag === "button" && node.children.some(child => child.type === 1 && child.children.some(text => text.type === 2 && text.content.trim() === "大模型 KEY 设置"));
    if (matches) return node;
    const nested = entryNode(node.children, surface);
    if (nested) return nested;
  }
}

/** 编译实际SFC入口子树，覆盖聊天头像及原宽窄入口，不复制准入公式。 */
function compileEntry(surface: Surface) {
  const files: Record<Surface, string> = { narrow: "../src/layouts/mobile/mobile-settings-tab.vue", wide: "../src/components/app-shell/app-shell-modals.vue",
    profile: "../src/features/office-h5/components/H5SettingsPanel.vue" };
  const file = files[surface];
  const filename = new URL(file, import.meta.url), parsed = parse(readFileSync(filename, "utf8"));
  assert.deepEqual(parsed.errors, []);
  const node = entryNode(parsed.descriptor.template!.ast!.children, surface);
  assert.ok(node, `${surface} Key入口必须存在`);
  const result = compileTemplate({ source: node.loc.source, filename: filename.pathname, id: `key-entry-${surface}`,
    compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: () => true } });
  assert.deepEqual(result.errors, []);
  return new Function("Vue", result.code)(vue) as (context: Record<string, unknown>, cache: unknown[]) => vue.VNode;
}

const renders = { narrow: compileEntry("narrow"), wide: compileEntry("wide"), profile: compileEntry("profile") };
const localClient = { clientId: "local", version: "1", connectedAt: 1, workspaceIds: ["local:ws"] };

/** 真实store/helper驱动入口，preload仅作为隔离传输，不请求云端或真实凭据。 */
function fixture(t: test.TestContext, surface: Surface, desktop = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const bridge = { getState: async () => ({ status: "ready" }), request: async (_request: DesktopApiRequest) => ({ status: 200, body: { ok: true } }) };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: desktop ? bridge : undefined } });
  setActivePinia(createPinia());
  const config = useConfigStore(), events: unknown[][] = [];
  const shell = vue.reactive({ config, settingsOpen: true, settingsActiveTab: "engine-keys" });
  const context = { config, shell, isDesktopWorkspace, emit: (...args: unknown[]) => events.push(args) };
  const entry = vue.computed(() => renders[surface](context, []));
  t.after(() => {
    config.$dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  return { config, shell, events, bridge, entry };
}

for (const surface of ["narrow", "wide", "profile"] as const) {
  for (const scenario of [
    { label: "本机ready离线", desktop: true, status: "ready", client: localClient, workspaceId: "local:ws", connected: false, disabled: false },
    { label: "本机ready在线", desktop: true, status: "ready", client: localClient, workspaceId: "local:ws", connected: true, disabled: false },
    { label: "starting离线", desktop: true, status: "starting", client: localClient, workspaceId: "local:ws", connected: false, disabled: true },
    { label: "failed离线", desktop: true, status: "failed", client: localClient, workspaceId: "local:ws", connected: false, disabled: true },
    { label: "无本机Client离线", desktop: true, status: "ready", client: null, workspaceId: "local:ws", connected: false, disabled: true },
    { label: "其他Client离线", desktop: true, status: "ready", client: localClient, workspaceId: "other:ws", connected: false, disabled: true },
    { label: "shared离线", desktop: true, status: "ready", client: localClient, workspaceId: "shared:ws", connected: false, disabled: true },
    { label: "空工作区离线", desktop: true, status: "ready", client: localClient, workspaceId: "", connected: false, disabled: true },
    { label: "非实际清单离线", desktop: true, status: "ready", client: localClient, workspaceId: "local:unknown", connected: false, disabled: true },
    { label: "空工作区在线保持可进", desktop: true, status: "ready", client: localClient, workspaceId: "", connected: true, disabled: false },
    { label: "其他Client在线", desktop: true, status: "ready", client: localClient, workspaceId: "other:ws", connected: true, disabled: false },
    { label: "浏览器离线", desktop: false, status: "starting", client: null, workspaceId: "local:ws", connected: false, disabled: true },
    { label: "浏览器在线", desktop: false, status: "starting", client: null, workspaceId: "local:ws", connected: true, disabled: false },
  ] as const) test(`${surface} Key入口：${scenario.label}`, t => {
    const f = fixture(t, surface, scenario.desktop);
    f.config.desktopRuntime = { status: scenario.status, requestId: "entry", releaseId: null, errorCode: null };
    f.config.desktopClient = scenario.client;
    f.config.workspaceId = scenario.workspaceId;
    f.config.setConnected(scenario.connected);
    assert.equal(f.entry.value.props?.disabled, scenario.disabled);
  });

  test(`${surface} Key入口响应式切区和就绪变化不扩大范围`, t => {
    const f = fixture(t, surface);
    f.config.desktopRuntime = { status: "ready", requestId: "reactive", releaseId: null, errorCode: null };
    f.config.desktopClient = localClient;
    f.config.workspaceId = "local:ws";
    assert.equal(f.entry.value.props?.disabled, false);
    for (const workspaceId of ["other:ws", "shared:ws", ""]) {
      f.config.workspaceId = workspaceId;
      assert.equal(f.entry.value.props?.disabled, true);
    }
    f.config.workspaceId = "local:ws";
    assert.equal(f.entry.value.props?.disabled, false);
    f.config.desktopClient = null;
    assert.equal(f.entry.value.props?.disabled, true);
    f.config.setConnected(true);
    assert.equal(f.entry.value.props?.disabled, false);
    f.config.setConnected(false);
    assert.equal(f.entry.value.props?.disabled, true);
  });
}

test("窄入口保原Key导航，宽页签保原key及面板激活", t => {
  const narrow = fixture(t, "narrow"), wide = fixture(t, "wide");
  for (const f of [narrow, wide]) {
    f.config.desktopRuntime = { status: "ready", requestId: "open", releaseId: null, errorCode: null };
    f.config.desktopClient = localClient;
    f.config.workspaceId = "local:ws";
    assert.equal(f.entry.value.props?.disabled, false);
  }
  narrow.entry.value.props!.onClick();
  assert.deepEqual(narrow.events, [["navigate", { type: "settings", context: { tab: "engine-keys" } }]]);
  assert.equal(wide.entry.value.key, "engine-keys");
  const children = wide.entry.value.children as vue.VNode[];
  assert.equal(children[0].type, "EngineKeysPanel");
  assert.equal(children[0].props?.active, true);
  wide.shell.settingsOpen = false;
  assert.equal((wide.entry.value.children as vue.VNode[])[0].props?.active, false);
});

test("离线自配Key CRUD沿原API和requestJson只走本机桥", async t => {
  const f = fixture(t, "narrow"), requests: DesktopApiRequest[] = [];
  f.config.desktopRuntime = { status: "ready", requestId: "crud", releaseId: null, errorCode: null };
  f.config.desktopClient = localClient;
  f.config.workspaceId = "local:ws";
  const key: EngineKeyEntry = { id: "own-key", label: "本机自配", engine: "codex", providerId: "openai", apiKey: "", baseUrl: null, isActive: false, createdAt: 1, updatedAt: 1 };
  f.bridge.request = async request => {
    requests.push(request);
    return { status: 200, body: request.method === "engineKeys.list" ? { ok: true, keys: [key] } : { ok: true, key } };
  };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("离线自配Key不能请求Server"); });
  const context: ApiRequestContext = { serverWsOrigin: "", sessionToken: null, webSessionId: null, desktopClientId: "local",
    ensureSession: async () => { throw new Error("离线自配Key不能要求登录"); } };
  assert.equal(f.entry.value.props?.disabled, false);
  assert.equal((await listEngineKeys(context, "local:ws")).ok, true);
  const body = { id: key.id, label: key.label, engine: key.engine, providerId: key.providerId, apiKey: "fixture-only" };
  assert.equal((await upsertEngineKey(context, body, "local:ws")).ok, true);
  assert.equal((await deleteEngineKey(context, { id: key.id }, "local:ws")).ok, true);
  assert.deepEqual(requests.map(request => request.method), ["engineKeys.list", "engineKeys.upsert", "engineKeys.delete"]);
  assert.deepEqual(requests.map(request => request.body?.workspaceId), ["local:ws", "local:ws", "local:ws"]);
});
