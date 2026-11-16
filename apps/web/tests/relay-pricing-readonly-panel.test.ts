import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, compileScript } from "vue/compiler-sfc";
import ts from "typescript";
import { createRenderer, defineComponent, h, nextTick, type VNode } from "vue";

type HostNode = { tag: string; text: string; props: Record<string, unknown>; children: HostNode[]; parent: HostNode | null };

/** 创建无 DOM 节点，保留真实模板生成的文本、属性和事件。 */
function node(tag: string, text = ""): HostNode { return { tag, text, props: {}, children: [], parent: null }; }

/** 提取可见渲染文本，不读取 SFC 源码来断言业务行为。 */
function visibleText(root: HostNode): string { return root.text + root.children.map(visibleText).join(" "); }

/** 查找真实渲染节点，例如刷新按钮和错误提示。 */
function findNode(root: HostNode, predicate: (item: HostNode) => boolean): HostNode | undefined {
  if (predicate(root)) return root;
  for (const child of root.children) { const found = findNode(child, predicate); if (found) return found; }
  return undefined;
}

/** 等待实际 HTTP 与 Vue 更新，超时明确失败。 */
async function until(predicate: () => boolean, diagnostics?: () => unknown): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`HTTP/render did not settle: ${JSON.stringify(diagnostics?.())}`);
    await new Promise((done) => setTimeout(done, 10)); await nextTick();
  }
}

/** 测试只替换账号上下文和 Antd 展示外壳，SFC、公共 API、requestJson 和 HTTP 均使用真实实现。 */
async function fixture(t: TestContext, initialStatus = 200) {
  let status = initialStatus, model = "model-before";
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url!, authorization: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { ok: true, rows: [{ id: "row1", providerId: "openai", supplier: "relay-channel",
      modelVendor: "OpenAI", modelVersion: model, currency: "CNY", multimodal: true,
      inputCachedPriceMilliYuanPerMillionTokens: 1250, inputUncachedPriceMilliYuanPerMillionTokens: 7500,
      outputPriceMilliYuanPerMillionTokens: 12000, remark: "price-note", sortOrder: 1 }], serverNow: 1 }
      : { ok: false, code: "INTERNAL_ERROR", message: "price unavailable", details: { requestId: "pricing-request-503" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const context = { serverWsOrigin: `ws://127.0.0.1:${address.port}`, sessionToken: null, webSessionId: null };
  const filename = fileURLToPath(new URL("../src/features/admin/components/relay-pricing-readonly-panel.vue", import.meta.url));
  const { descriptor } = parse(readFileSync(filename, "utf8"), { filename });
  let source = compileScript(descriptor, { id: "pricing-test", inlineTemplate: true }).content;
  source = source.replace(/from\s*["']([^"']+)["']/g, (_match, specifier: string) => {
    if (specifier.endsWith("/useApiContext")) {
      const contextModule = `export function useApiContext(){return {ctx:{value:${JSON.stringify(context)}}}}`;
      return `from "data:text/javascript,${encodeURIComponent(contextModule)}"`;
    }
    if (specifier.startsWith(".")) {
      const base = resolve(dirname(filename), specifier);
      return `from ${JSON.stringify(pathToFileURL(existsSync(base + ".ts") ? base + ".ts" : resolve(base, "index.ts")).href)}`;
    }
    return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
  });
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const component = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${address.port}`)).default;
  const renderer = createRenderer<HostNode, HostNode>({
    createElement: (tag) => node(tag), createText: (text) => node("text", text), createComment: () => node("comment"),
    setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.text = text; item.children = []; },
    patchProp: (item, key, _old, value) => { item.props[key] = value; },
    parentNode: (item) => item.parent, nextSibling: () => null,
    insert(item, parent, anchor) {
      if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1);
      item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
      parent.children.splice(index < 0 ? parent.children.length : index, 0, item);
    },
    remove(item) { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); },
  });
  const app = renderer.createApp(component), errors: unknown[] = [], logs: unknown[][] = [], root = node("root");
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  app.config.errorHandler = (error) => { errors.push(error); };
  app.component("a-button", defineComponent({ emits: ["click"], setup(_props, { slots, emit }) {
    return () => h("button", { onClick: () => emit("click") }, slots.default?.());
  } }));
  app.component("a-alert", defineComponent({ props: ["message"], setup(props) { return () => h("div", { role: "alert" }, props.message); } }));
  app.component("a-table-column", defineComponent({ setup() { return () => null; } }));
  app.component("a-table", defineComponent({ props: ["dataSource"], setup(props, { slots }) {
    return () => {
      const columns = (slots.default?.() ?? []).filter((vnode) => typeof vnode.type !== "symbol");
      return h("table", [h("thead", columns.map((column) => h("th", column.props?.title))),
        ...(props.dataSource ?? []).map((record: Record<string, unknown>) => h("tr", columns.map((column: VNode) => {
          const cell = column.children as { default?: (args: { record: Record<string, unknown> }) => unknown } | null;
          const dataIndex = column.props?.dataIndex ?? column.props?.["data-index"];
          return h("td", cell?.default ? cell.default({ record }) as never : String(record[dataIndex] ?? ""));
        }))) ]);
    };
  } }));
  app.mount(root); t.after(() => app.unmount());
  /** 通过真实模板绑定的刷新事件重试，拒绝交由 Vue errorHandler 捕获。 */
  const refresh = () => { const button = findNode(root, (item) => item.tag === "button"); assert.ok(button); (button.props.onClick as () => void)(); };
  return { root, errors, logs, requests, refresh, setStatus: (next: number) => { status = next; }, setModel: (next: string) => { model = next; } };
}

test("匿名价格页通过公共HTTP接口读取，无Bearer且完整展示只读字段", async (t) => {
  const f = await fixture(t);
  await until(() => visibleText(f.root).includes("model-before") || f.errors.length > 0, () => ({ requests: f.requests, text: visibleText(f.root), logs: f.logs }));
  assert.deepEqual(f.requests, [{ path: "/api/public/relay/pricing/current", authorization: undefined }]);
  const text = visibleText(f.root);
  for (const field of ["OpenAI", "relay-channel", "model-before", "多模态", "是", "命中缓存", "未命中缓存", "1.250", "7.500", "12.000", "备注", "price-note"]) assert.ok(text.includes(field), field);
  assert.equal(f.errors.length, 0);
});

test("503刷新保留可见失败、清除旧价、显式失败到Vue边界，恢复后可重试", async (t) => {
  const f = await fixture(t);
  await until(() => visibleText(f.root).includes("model-before"), () => ({ requests: f.requests, text: visibleText(f.root), errors: f.errors.map(String), logs: f.logs }));
  f.setStatus(503); f.refresh();
  await until(() => f.errors.length > 0);
  assert.ok(findNode(f.root, (item) => item.props.role === "alert"));
  assert.match(visibleText(f.root), /price unavailable/u);
  assert.doesNotMatch(visibleText(f.root), /model-before|relay-channel/u);
  assert.ok(f.logs.some((args) => JSON.stringify(args).includes("pricing-request-503")), "失败日志应保留 requestId");
  f.setStatus(200); f.setModel("model-recovered"); f.refresh();
  await until(() => visibleText(f.root).includes("model-recovered"));
  assert.equal(findNode(f.root, (item) => item.props.role === "alert"), undefined);
  assert.equal(f.errors.length, 1); assert.equal(f.requests.length, 3);
});

test("首次加载503同样进入Vue生命周期错误边界并允许恢复", async (t) => {
  const f = await fixture(t, 503);
  await until(() => f.errors.length > 0);
  assert.match(visibleText(f.root), /price unavailable/u);
  assert.equal(findNode(f.root, (item) => item.tag === "table"), undefined);
  f.setStatus(200); f.refresh();
  await until(() => visibleText(f.root).includes("model-before"));
  assert.equal(f.errors.length, 1); assert.equal(f.requests.length, 2);
});
