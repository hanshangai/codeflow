import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import ts from "typescript";
import * as vue from "vue";
import { useAccountStore } from "../src/store/account.ts";
import { useChatStore } from "../src/store/chat.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useUiStore } from "../src/store/ui.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";
import { useReminderStore } from "../src/store/reminders.ts";

const homeSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5WorkbenchHome.vue", "utf8");
const layoutSource = fs.readFileSync("apps/web/src/layouts/mobile/mobile-layout.vue", "utf8");

test("H5 workbench keeps the confirmed information architecture", () => {
  // 分类与桌面侧对齐：下线「全部」，保留移动端独有的「待办」。
  for (const label of ["自建会话", "编排会话", "归档会话", "待办"]) {
    assert.match(homeSource, new RegExp(`label: "${label}"`, "u"));
  }
  assert.doesNotMatch(homeSource, /label: "全部"/u);
  assert.match(homeSource, /搜索会话与流程/u);
  assert.match(homeSource, /切换工作区/u);
  assert.match(homeSource, /新建会话/u);
  assert.match(homeSource, /surface="h5"/u);
});

test("H5 workbench reuses the shared thread scope and the desktop engine icon", () => {
  assert.match(homeSource, /matchesThreadListScope\(thread, filter\)/u);
  assert.doesNotMatch(homeSource, /resolveThreadScope|matchesHomeFilter/u);
  assert.match(homeSource, /h5-thread-row__icon--\$\{thread\.engine \?\? 'codex'\}/u);
  assert.match(homeSource, /<IconClaude v-if="\(thread\.engine \?\? 'codex'\) === 'claude'" :size="26" \/>/u);
  assert.match(homeSource, /<IconCodex v-else :size="24" \/>/u);
  assert.doesNotMatch(homeSource, /MessageOutlined|ApartmentOutlined/u);
  assert.match(homeSource, /\.h5-thread-row__icon--claude \{[\s\S]*background: var\(--app-accent\)/u);
});

/** 运行真实工作台 setup 和账号 Store，只隔离账号摘要网络读取与组件生命周期。 */
function accountNavigationFixture(t: test.TestContext) {
  setActivePinia(createPinia());
  const account = useAccountStore();
  t.mock.method(account, "loadMeSummary", async () => {});
  const sourceRequire = createRequire(new URL("../src/features/office-h5/components/H5WorkbenchHome.vue", import.meta.url));
  const { parse, compileScript } = sourceRequire("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
  const script = ts.transpileModule(compileScript(parse(homeSource).descriptor, { id: "h5-account-navigation" }).content,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} as { default: { setup: (props: object, context: object) => {
    openAccountSection: (tab: "overview" | "password") => Promise<void>;
    profileOpen: vue.Ref<boolean>;
    accountSubPageOpen: vue.Ref<boolean>;
    restoreProfileSettings: () => void;
  } } } };
  new Function("require", "module", "exports", script)((id: string) => {
    if (id === "vue") return { ...vue, onBeforeUnmount() {} };
    if (id === "vue-router") return { useRoute: () => ({ query: {} }), useRouter: () => ({}) };
    if (id === "../../../store/account") return { useAccountStore };
    if (id === "../../../store/chat") return { useChatStore };
    if (id === "../../../store/config") return { useConfigStore };
    if (id === "../../../store/ui") return { useUiStore };
    if (id === "../../../store/workspaces") return { useWorkspacesStore };
    if (id === "../../../store/reminders") return { useReminderStore };
    if (id === "../../../composables/useApiContext") return { useApiContext: () => ({ ctx: vue.ref({}) }) };
    if (id.endsWith(".vue")) return {};
    return sourceRequire(id);
  }, module, module.exports);
  const scope = vue.effectScope();
  const home = scope.run(() => module.exports.default.setup({}, { expose() {}, emit() {} }))!;
  t.after(() => { scope.stop(); account.closeAccountDrawer(); account.$dispose(); });
  return { account, home };
}

test("H5 account pages preserve the selected destination and restore the avatar settings on return", async t => {
  const { account, home } = accountNavigationFixture(t);
  for (const tab of ["overview", "password"] as const) {
    home.restoreProfileSettings();
    await home.openAccountSection(tab);
    await vue.nextTick();
    assert.equal(account.accountDrawerOpen, true);
    assert.equal(account.accountDrawerTab, tab);
    assert.equal(account.accountDrawerSurface, "h5");
    assert.equal(home.profileOpen.value, false);
    account.closeAccountDrawer();
    await vue.nextTick();
    assert.equal(home.profileOpen.value, true);
    assert.equal(home.accountSubPageOpen.value, false);
  }
  assert.match(homeSource, /@account="openAccountSection"/u);
  assert.match(homeSource, /defineExpose\(\{ restoreProfileSettings \}\)/u);
  assert.match(layoutSource, /restoreSettingsParent\(popped\)/u);
  assert.match(layoutSource, /restoreSettingsParent\(top\)/u);
  assert.match(layoutSource, /ref="h5WorkbenchHomeRef"/u);
  assert.doesNotMatch(homeSource, /所属企业/u);
});

test("mobile header owns the only group switch and orders workspace, groups and creation", () => {
  const header = homeSource.slice(homeSource.indexOf('<div class="h5-workbench-home__actions">'), homeSource.indexOf('</header>'));
  assert.deepEqual([...header.matchAll(/aria-label="([^"]+)"/gu)].map(match => match[1]), ['切换工作区', '分组管理与切换', '新建会话']);
  assert.match(header, /<Layers2/u);
  assert.match(header, /selectedGroupLabel/u);
  assert.doesNotMatch(homeSource, /h5-workbench-home__group-filter|FolderOutlined/u);
});

test("H5 workbench reuses the canonical stores and full-screen mobile chat stack", () => {
  assert.match(homeSource, /useChatStore\(\)/u);
  assert.match(homeSource, /chat\.refreshThreads/u);
  assert.match(homeSource, /chat\.createThread/u);
  assert.match(homeSource, /chat\.selectPrimaryThread\(thread, \{ route: "ignore" \}\)/u);
  assert.match(homeSource, /<H5PendingPanel/u);
  assert.match(layoutSource, /<H5WorkbenchHome/u);
  assert.match(layoutSource, /ui\.currentMobilePage\.type === 'chat'/u);
  assert.match(layoutSource, /<ChatPanel :workspace-id="config\.workspaceId"/u);
});

test("H5 workbench opens the pending filter for notification deep links", () => {
  assert.match(homeSource, /resolveAccountH5DeepLink\(route\.query as Record<string, unknown>\)\.tab === "pending" \? "pending" : "current"/u);
  assert.match(homeSource, /route\.query\.targetId/u);
  assert.match(homeSource, /selectFilter\("pending"\)/u);
});

test("standard mobile keeps the existing thread list", () => {
  assert.match(layoutSource, /<H5WorkbenchHome v-if="isH5Surface"/u);
  assert.match(layoutSource, /v-else[\s\S]+<ThreadList/u);
});
