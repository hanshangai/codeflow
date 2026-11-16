import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createPinia, setActivePinia } from "pinia";
import * as vue from "vue";
import { useConfigStore } from "../src/store/config.ts";
import { isDesktopWorkspace } from "../src/services/desktop.ts";

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const filename = new URL("../src/layouts/mobile/mobile-settings-tab.vue", import.meta.url);
const parsed = parse(readFileSync(filename, "utf8"));
assert.deepEqual(parsed.errors, []);
const compiled = compileTemplate({ source: parsed.descriptor.template!.content, filename: filename.pathname, id: "mobile-workspace-entry",
  compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: () => true } });
assert.deepEqual(compiled.errors, []);
const render = new Function("Vue", compiled.code)(vue) as (context: Record<string, unknown>, cache: unknown[]) => vue.VNode;
const client = { clientId: "local-client", version: "1", workspaceIds: [], connectedAt: 1 };

/** 从真实模板生成的节点读取可见文字，不依赖源字符串或编译器内部结构。 */
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textContent).join("");
  return vue.isVNode(value) ? textContent(value.children) : "";
}

/** 定位真实模板工作区按钮，其他设置入口不参与本片断言。 */
function workspaceButton(value: unknown): vue.VNode | undefined {
  if (Array.isArray(value)) return value.map(workspaceButton).find(Boolean);
  if (!vue.isVNode(value)) return undefined;
  if (value.type === "button" && textContent(value).includes("工作区管理")) return value;
  return workspaceButton(value.children);
}

/** 真实 Pinia getter 驱动完整 SFC 模板；只提供无关展示上下文及导航出口。 */
function fixture(t: test.TestContext, desktop = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: desktop ? { getState() {}, request() {} } : undefined } });
  const pinia = createPinia();
  setActivePinia(pinia);
  const config = useConfigStore(), events: unknown[][] = [];
  const context = { config, isDesktopWorkspace, emit: (...args: unknown[]) => events.push(args), connectionStatusText: "未连接", connectError: null,
    workspaceRuntimeDisplay: { tone: "offline", label: "未连接" }, isAccountLoggedIn: false, isH5Surface: false, hasWorkspace: false,
    isCurrentSharedWorkspace: false, systemEntryDescription: "", ThemeIcon: "i", themeLabel: "自动", account: {}, appModals: null };
  const rendered = vue.computed(() => render(context, []));
  t.after(() => {
    config.$dispose();
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  /** 每次读取经过真实响应式渲染，不缓存旧按钮的门禁结果。 */
  function button(): vue.VNode {
    const value = workspaceButton(rendered.value);
    assert.ok(value, "工作区管理按钮必须存在");
    return value;
  }
  return { config, events, button };
}

test("桌面离线 ready 仍可从窄窗工作区按钮发出原导航", t => {
  const f = fixture(t);
  f.config.desktopRuntime = { status: "ready", requestId: "local-ready", releaseId: null, errorCode: null };
  f.config.desktopClient = client;
  assert.equal(f.config.connected, false);
  assert.equal(f.button().props?.disabled, false);
  f.button().props!.onClick();
  assert.deepEqual(f.events, [["navigate", { type: "settings", context: { tab: "workspaces" } }]]);
});

for (const status of ["starting", "failed"] as const) test(`桌面离线 ${status} 时工作区按钮仍禁用`, t => {
  const f = fixture(t);
  f.config.desktopRuntime = { status, requestId: "not-ready", releaseId: null, errorCode: status === "failed" ? "CLIENT_EXIT_1" : null };
  f.config.desktopClient = client;
  assert.equal(f.button().props?.disabled, true);
  assert.deepEqual(f.events, []);
});

test("桌面 ready 但缺本机 Client 时工作区按钮仍禁用", t => {
  const f = fixture(t);
  f.config.desktopRuntime = { status: "ready", requestId: "missing-client", releaseId: null, errorCode: null };
  assert.equal(f.config.desktopClient, null);
  assert.equal(f.button().props?.disabled, true);
});

for (const connected of [false, true]) test(`浏览器云连接 ${connected} 保持原工作区准入`, t => {
  const f = fixture(t, false);
  f.config.setConnected(connected);
  assert.equal(f.config.isDesktop, false);
  assert.equal(f.button().props?.disabled, !connected);
  if (connected) {
    f.button().props!.onClick();
    assert.deepEqual(f.events, [["navigate", { type: "settings", context: { tab: "workspaces" } }]]);
  }
});

test("同一窄窗模板随本机与云端就绪变化响应式更新准入", t => {
  const f = fixture(t);
  assert.equal(f.button().props?.disabled, true);
  f.config.desktopRuntime = { status: "ready", requestId: "reactive", releaseId: null, errorCode: null };
  f.config.desktopClient = client;
  assert.equal(f.button().props?.disabled, false);
  f.config.desktopClient = null;
  assert.equal(f.button().props?.disabled, true);
  f.config.setConnected(true);
  assert.equal(f.button().props?.disabled, false);
  f.config.setConnected(false);
  assert.equal(f.button().props?.disabled, true);
});
