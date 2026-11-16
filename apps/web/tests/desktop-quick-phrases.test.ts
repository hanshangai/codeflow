import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import * as vue from "vue";
import ts from "typescript";
import type { DesktopApiRequest, QuickPhraseCollection } from "@codeflowai/shared";
import { createQuickPhrase, deleteQuickPhrase, listQuickPhrases, reorderQuickPhrases, updateQuickPhrase } from "../src/api/quickPhrases.ts";
import { QuickPhraseCacheWriteError, useQuickPhrasesStore } from "../src/store/quickPhrases.ts";
import * as phrases from "../src/store/quickPhrases.ts";
import * as browserUuid from "../src/utils/browserUuid.ts";

const local = { scope: "local" as const, serverWsOrigin: "", sessionToken: null, webSessionId: null };
const account = { serverWsOrigin: "ws://server.test", sessionToken: "session", webSessionId: "web" };
const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
const pickerPath = new URL("../src/features/composer/components/quick-phrase-picker.vue", import.meta.url);
const script = compileScript(parse(fs.readFileSync(pickerPath, "utf8")).descriptor, { id: "quick-phrase-picker-test" }).content;
const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

/** 提供可辨认范围的集合，便于验证迟到请求不会污染当前数据。 */
function collection(id: string, revision = 1): QuickPhraseCollection {
  return { revision, items: [{ id, title: id, content: id, sortOrder: 0, version: 1, createdAt: 1, updatedAt: 1 }] };
}

/** 仅替换传输边界，实际运行 API 与 Pinia store。 */
function setup(t: test.TestContext, request: (value: DesktopApiRequest) => Promise<unknown>) {
  setActivePinia(createPinia());
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  globalThis.window = { codeflowDesktop: { getState() {}, request: async (value: DesktopApiRequest) => ({ status: 200, body: await request(value) }) } } as never;
  globalThis.fetch = async () => { throw new Error("UNEXPECTED_SERVER_REQUEST"); };
  t.after(() => { globalThis.window = previousWindow; globalThis.fetch = previousFetch; });
  return useQuickPhrasesStore();
}

/** 账号缓存仅模拟 IndexedDB 传输契约，键和值仍由真实 store 生成。 */
function accountCache(t: test.TestContext): Map<string, unknown> {
  const previous = globalThis.indexedDB;
  const values = new Map<string, unknown>();
  const database = {
    close() {},
    transaction() {
      const tx = { oncomplete: undefined as (() => void) | undefined, objectStore: () => ({
        get(key: string) {
          const request = { result: values.get(key), onsuccess: undefined as (() => void) | undefined };
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
        put(value: unknown, key: string) { values.set(key, value); queueMicrotask(() => tx.oncomplete?.()); },
      }) };
      return tx;
    },
  };
  globalThis.indexedDB = { open() {
    const request = { result: database, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } as never;
  t.after(() => { globalThis.indexedDB = previous; });
  return values;
}

/** 执行真实 picker setup，只替换组件库、账号上下文和传输边界。 */
function pickerFixture(t: test.TestContext, request: (value: DesktopApiRequest) => Promise<unknown>) {
  const store = setup(t, request);
  accountCache(t);
  const config = vue.reactive({ isDesktop: true, isAccountSession: true, hasActiveSession: true, connected: true, serverWsOrigin: account.serverWsOrigin, userSummary: { userId: "a" } });
  const errors: string[] = [], logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onMounted() {}, onUnmounted() {} };
    if (id === "ant-design-vue") return { message: { error: (value: string) => errors.push(value), info() {} }, Modal: { confirm() { throw new Error("UNEXPECTED_CONFIRM"); } } };
    if (id === "@ant-design/icons-vue") return {};
    if (id === "../../../analytics/analytics") return { trackProductEvent() {} };
    if (id === "../../../composables/useApiContext") return { useApiContext: () => ({ ctx: vue.computed(() => account) }) };
    if (id === "../../../store/config") return { useConfigStore: () => config };
    if (id === "../../../store/quickPhrases") return phrases;
    if (id === "../../../utils/browserUuid") return browserUuid;
    if (id === "../quickPhraseSync") return { syncQuickPhrasesToAccount: async () => {} };
    throw new Error(`UNEXPECTED_PICKER_IMPORT:${id}`);
  }, module, module.exports);
  const scope = vue.effectScope();
  t.after(() => { scope.stop(); });
  return { store, config, errors, logs, mount: () => scope.run(() => module.exports.default.setup({}, { expose() {}, emit() {} }))! };
}

/** 排空 Vue watcher 和有限 Promise 续体，不等待外部服务。 */
async function settle(): Promise<void> { await vue.nextTick(); await new Promise<void>(resolve => setImmediate(resolve)); await vue.nextTick(); }

test("本机 API 不要求账号或认证，不访问 Server", async t => {
  const methods: string[] = [];
  setup(t, async request => { methods.push(request.method); return { ok: true, ...collection("local") }; });
  assert.equal((await listQuickPhrases(local)).items[0]!.id, "local");
  await createQuickPhrase(local, { clientRequestId: "request", title: "名称", content: "正文" });
  await updateQuickPhrase(local, "id", { title: "名称", content: "正文", version: 1 });
  await deleteQuickPhrase(local, "id", { version: 1 });
  await reorderQuickPhrases(local, { revision: 1, ids: ["id"] });
  assert.deepEqual(methods, ["quickPhrases.list", "quickPhrases.create", "quickPhrases.update", "quickPhrases.delete", "quickPhrases.reorder"]);
});

test("未登录本机初始化不使用账号 IndexedDB，退出与云端修订不清空本机", async t => {
  let calls = 0;
  const store = setup(t, async () => { calls += 1; return { ok: true, ...collection("local") }; });
  await store.initialize(local, "", "");
  assert.equal(store.scopeKey, "local");
  assert.equal(store.items[0]!.id, "local");
  store.resetRuntimeState();
  await store.handleRemoteRevision(account, 100);
  assert.equal(store.items[0]!.id, "local");
  assert.equal(calls, 1);
});

test("旧本机请求迟到不能覆盖切换后的新请求状态", async t => {
  let resolveOld!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveOld = resolve; });
  let calls = 0;
  const store = setup(t, async () => ++calls === 1 ? await pending : { ok: true, ...collection("new", 2) });
  const older = store.initialize(local, "", "");
  await store.initialize(local, "", "");
  resolveOld({ ok: true, ...collection("old") });
  await older;
  assert.equal(store.items[0]!.id, "new");
  assert.equal(store.loading, false);
  assert.equal(store.refreshing, false);
});

test("旧读取失败不能清除新请求的加载状态或写入错误", async t => {
  let rejectOld!: (error: Error) => void, resolveNew!: (value: unknown) => void;
  const first = new Promise((_resolve, reject) => { rejectOld = reject; });
  const second = new Promise(resolve => { resolveNew = resolve; });
  let calls = 0;
  const store = setup(t, async () => ++calls === 1 ? await first : await second);
  const old = assert.rejects(store.initialize(local, "", ""), /旧请求失败/u);
  const newer = store.initialize(local, "", "");
  rejectOld(new Error("旧请求失败"));
  await old;
  assert.equal(store.refreshing, true);
  assert.equal(store.error, null);
  resolveNew({ ok: true, ...collection("new") });
  await newer;
  assert.equal(store.refreshing, false);
});

test("本机加载失败保留明确错误且不回退云端，重试可恢复", async t => {
  let fail = true;
  const store = setup(t, async () => { if (fail) throw new Error("本机数据库不可用"); return { ok: true, ...collection("recovered") }; });
  await assert.rejects(store.initialize(local, "", ""), /本机数据库不可用/u);
  assert.equal(store.error, "本机数据库不可用");
  assert.equal(store.loading, false);
  fail = false;
  await store.initialize(local, "", "");
  assert.equal(store.error, null);
  assert.equal(store.items[0]!.id, "recovered");
});

test("账号 A/B 缓存与本机集合互不混用，账号请求仍走 Server", async t => {
  const store = setup(t, async () => ({ ok: true, ...collection("local") }));
  const cache = accountCache(t);
  let requests = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection(++requests === 1 ? "account-a" : "account-b") }), { headers: { "content-type": "application/json" } });
  await store.initialize(account, account.serverWsOrigin, "a");
  assert.equal(store.items[0]!.id, "account-a");
  await store.initialize(local, "", "");
  assert.equal(store.items[0]!.id, "local");
  await store.initialize(account, account.serverWsOrigin, "b");
  assert.equal(store.items[0]!.id, "account-b");
  assert.equal(cache.size, 2);
  assert.equal(cache.has("local"), false);
  assert.equal(requests, 2);
});

test("账号缓存初始化失败显式结束加载，不向 Server 发请求", async t => {
  const store = setup(t, async () => { throw new Error("UNEXPECTED_LOCAL_REQUEST"); });
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error("缓存读取失败"); } } as never;
  t.after(() => { globalThis.indexedDB = previous; });
  await assert.rejects(store.initialize(account, account.serverWsOrigin, "account"), /缓存读取失败/u);
  assert.equal(store.loading, false);
  assert.equal(store.error, "缓存读取失败");
});

test("Server 写入成功后缓存失败有独立错误并保留真实集合", async t => {
  const store = setup(t, async () => { throw new Error("UNEXPECTED_LOCAL_REQUEST"); });
  accountCache(t);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("account") }), { headers: { "content-type": "application/json" } });
  await store.initialize(account, account.serverWsOrigin, "account");
  globalThis.indexedDB = { open() { throw new Error("缓存写入失败"); } } as never;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("saved", 2) }), { headers: { "content-type": "application/json" } });
  await assert.rejects(store.create(account, "名称", "正文"), error => error instanceof QuickPhraseCacheWriteError && error.message.includes("Server 确认"));
  assert.equal(store.items[0]!.id, "saved");
  assert.equal(store.revision, 2);
});

test("账号刷新拒绝其他 Server 上下文，避免把远端集合写入当前缓存", async t => {
  const store = setup(t, async () => { throw new Error("UNEXPECTED_LOCAL_REQUEST"); });
  accountCache(t);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("account") }), { headers: { "content-type": "application/json" } });
  await store.initialize(account, account.serverWsOrigin, "account");
  await assert.rejects(store.refresh({ ...account, serverWsOrigin: "ws://other-server.test" }), /范围已变化/u);
  assert.equal(store.items[0]!.id, "account");
});

test("切离再回本机时，旧写入结果不得覆盖新集合", async t => {
  let resolveWrite!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveWrite = resolve; });
  const store = setup(t, async request => request.method === "quickPhrases.create" ? await pending : { ok: true, ...collection("local") });
  await store.initialize(local, "", "");
  const writing = store.create(local, "名称", "内容");
  const rejected = assert.rejects(writing, /范围已切换/u);
  store.invalidateScope();
  await store.initialize(local, "", "");
  resolveWrite({ ok: true, ...collection("stale-write", 10) });
  await rejected;
  assert.equal(store.items[0]!.id, "local");
});

test("写入成功使旧读取失效后，加载状态仍能结束", async t => {
  let resolveRead!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveRead = resolve; });
  let reads = 0;
  const store = setup(t, async request => request.method === "quickPhrases.create" ? { ok: true, ...collection("created", 2) }
    : ++reads === 1 ? { ok: true, ...collection("local") } : await pending);
  await store.initialize(local, "", "");
  const reading = store.refresh(local);
  await store.create(local, "名称", "内容");
  resolveRead({ ok: true, ...collection("old-read") });
  await reading;
  assert.equal(store.items[0]!.id, "created");
  assert.equal(store.refreshing, false);
});

test("桌面入口按登录状态自动选择范围，不再提供本机/账号切换", () => {
  const picker = fs.readFileSync(new URL("../src/features/composer/components/quick-phrase-picker.vue", import.meta.url), "utf8");
  const composer = fs.readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  assert.doesNotMatch(picker, /账号常用提示词/u);
  assert.doesNotMatch(picker, /a-segmented/u);
  assert.match(picker, /accountAvailable\.value \|\| !config\.isDesktop \? "account" : "local"/u);
  assert.match(picker, /syncQuickPhrasesToAccount/u);
  assert.match(composer, /quickPhrasesAvailable[\s\S]{0,250}config\.isDesktop/u);
});

test("真实 picker 登录后使用账号，退出后自动回到本机且不混数据", async t => {
  const f = pickerFixture(t, async () => ({ ok: true, ...collection("local") }));
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("account") }), { headers: { "content-type": "application/json" } });
  f.config.hasActiveSession = false;
  const panel = f.mount();
  assert.equal(panel.scope.value, "local");
  await panel.setOpen(true);
  assert.equal(panel.filtered.value[0].id, "local");
  f.config.hasActiveSession = true;
  await settle();
  await settle();
  assert.equal(panel.scope.value, "account");
  assert.equal(panel.filtered.value[0].id, "account");
  f.config.hasActiveSession = false;
  await settle();
  assert.equal(panel.scope.value, "local");
  assert.equal(panel.filtered.value[0].id, "local");
  assert.deepEqual(f.errors, []);
});

test("其他 picker 切换集合后，原 picker 不显示或插入错误范围正文", async t => {
  const f = pickerFixture(t, async () => ({ ok: true, ...collection("local") }));
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("account") }), { headers: { "content-type": "application/json" } });
  f.config.hasActiveSession = false;
  const first = f.mount();
  await first.setOpen(true);
  await f.store.initialize({ ...account }, account.serverWsOrigin, "a");
  assert.deepEqual(first.filtered.value, []);
  assert.match(first.collectionError.value, /范围已切换/u);
  first.insert(collection("account").items[0]);
  assert.match(f.errors[0]!, /范围已切换/u);
  assert.equal(f.logs.length, 1);
});

test("真实 picker 本机初始化失败保留错误并记录请求上下文", async t => {
  const f = pickerFixture(t, async () => { throw new Error("本机数据库故障"); });
  f.config.hasActiveSession = false;
  const panel = f.mount();
  await panel.setOpen(true);
  assert.equal(panel.collectionError.value, "本机数据库故障");
  assert.equal(f.store.loading, false);
  assert.deepEqual(f.errors, ["本机数据库故障"]);
  assert.equal((f.logs[0]![1] as { scope: string }).scope, "local");
  assert.match((f.logs[0]![1] as { requestId: string }).requestId, /^quick-phrases-/u);
});

test("切换账号后的旧本机读取失败只记原范围日志，不污染当前错误提示", async t => {
  let rejectLocal!: (error: Error) => void;
  const pending = new Promise((_resolve, reject) => { rejectLocal = reject; });
  const f = pickerFixture(t, async () => await pending);
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, ...collection("account") }), { headers: { "content-type": "application/json" } });
  f.config.hasActiveSession = false;
  const panel = f.mount();
  const loading = panel.setOpen(true);
  f.config.hasActiveSession = true;
  await settle();
  rejectLocal(new Error("旧本机请求故障"));
  await loading;
  assert.equal(panel.filtered.value[0].id, "account");
  assert.deepEqual(f.errors, []);
  assert.equal((f.logs[0]?.[1] as { scope: string } | undefined)?.scope, "local");
});
