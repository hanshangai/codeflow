import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";

/** 挂载真实会话 SFC；仅替换账号上下文及无 DOM 展示，保留 API 与请求实现。 */
async function mountSessions(t: TestContext, role = "enterprise_admin") {
  const pinia = createPinia(); setActivePinia(pinia);
  const requests: string[] = [], errors: unknown[] = [], logs: unknown[][] = [];
  let failed = false;
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    const path = new URL(String(input)).pathname; requests.push(path);
    return Response.json(failed ? { ok: false, code: "INTERNAL_ERROR", message: "sessions unavailable", details: { requestId: "enterprise-session-503" } }
      : { ok: true, sessions: [{ id: "session-1", userId: "member-1" }], items: [], total: 0,
        activeSessions: 1, totalKeys: 2, activeKeys: 2, todayLogins: 3, todayMessages: 4 }, { status: failed ? 503 : 200 });
  });
  const filename = fileURLToPath(new URL("../src/features/admin/components/admin-sessions-panel.vue", import.meta.url));
  const { descriptor } = parse(readFileSync(filename, "utf8"), { filename });
  let source = compileScript(descriptor, { id: "enterprise-sessions" }).content;
  source = source.replace(/from\s*["']([^"']+)["']/g, (match, specifier: string) => {
    let substitute: string | undefined;
    if (specifier.endsWith("/useApiContext")) substitute = 'export function useApiContext(){return {ctx:{value:{serverWsOrigin:"ws://127.0.0.1:39280",sessionToken:"session",webSessionId:null}}}}';
    if (specifier.endsWith("/store/config")) substitute = `export function useConfigStore(){return {accountRole:${JSON.stringify(role)},userSummary:{userId:"owner-1",enterpriseId:"enterprise-1"}}}`;
    if (specifier === "ant-design-vue" || specifier === "@ant-design/icons-vue") {
      const names = source.slice(0, source.indexOf(match)).match(/import\s*\{([^}]+)\}\s*$/)?.[1]?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
      substitute = names.map((name) => `export const ${name}=${name === "message" ? "{error(){},success(){},warning(){}}" : "{}"};`).join("");
    }
    if (substitute) return `from "data:text/javascript,${encodeURIComponent(substitute)}"`;
    if (specifier.startsWith(".")) {
      const base = resolve(dirname(filename), specifier);
      return `from ${JSON.stringify(pathToFileURL(existsSync(base + ".ts") ? base + ".ts" : resolve(base, "index.ts")).href)}`;
    }
    return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
  });
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const component = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${role}`)).default;
  component.render = () => null;
  const renderer = createRenderer({ createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp(component); app.use(pinia); app.config.errorHandler = (error) => { errors.push(error); };
  app.mount({}); t.after(() => app.unmount());
  await new Promise<void>((done) => setImmediate(done)); await nextTick();
  return { state: app._instance!.setupState as Record<string, any>, requests, errors, logs, fail: () => { failed = true; } };
}

test("企业会话卡片、审计、用量和踢出始终通过企业接口", async (t) => {
  const f = await mountSessions(t);
  assert.equal(f.state.scopedSessions[0].id, "session-1");
  for (const mode of ["totalKeys", "todayLogins", "todayMessages"]) await f.state.selectDetail(mode);
  await f.state.handleKick("session-1");
  for (const suffix of ["overview", "sessions", "keys", "audit-logs", "usage-logs", "kick"]) {
    assert.ok(f.requests.some((path) => path.endsWith("/" + suffix)), suffix);
  }
  assert.ok(f.requests.every((path) => path.startsWith("/api/account/enterprise/")));
  assert.equal(f.errors.length, 0);
});

test("公开组件被超管旧入口直接挂载时也不发平台管理请求", async (t) => {
  const f = await mountSessions(t, "super_admin");
  assert.deepEqual(f.requests, []);
  assert.equal(f.errors.length, 1);
});

test("企业会话读取失败明确拒绝刷新，保留requestId并停止明细请求", async (t) => {
  const f = await mountSessions(t); f.fail();
  const before = f.requests.length;
  await assert.rejects(f.state.loadSessionManagement(), /sessions unavailable/);
  assert.ok(f.requests.slice(before).every((path) => /overview$|sessions$/.test(path)));
  assert.ok(f.logs.some((args) => JSON.stringify(args).includes("enterprise-session-503")));
});
