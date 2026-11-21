import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as vue from "vue";

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
type TemplateNode = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>["children"][number];
type ElementNode = Extract<TemplateNode, { type: 1 }>;

/** 定位真实模板入口，并返回同级节点以保留 v-if / v-else-if 的关系。 */
function findEntry(nodes: TemplateNode[], predicate: (node: ElementNode) => boolean): { node: ElementNode; siblings: TemplateNode[] } | undefined {
  for (const node of nodes) {
    if (node.type !== 1) continue;
    if (predicate(node)) return { node, siblings: nodes };
    const child = findEntry(node.children, predicate);
    if (child) return child;
  }
}

/** 编译生产模板片段，读取实际 VNode；不复制可见性表达式。 */
function renderEntry(file: string, context: Record<string, unknown>, banner = false): vue.VNode[] {
  const filename = new URL(`../src/features/orchestration/components/${file}`, import.meta.url);
  const descriptor = parse(readFileSync(filename, "utf8")).descriptor;
  const entry = findEntry(descriptor.template!.ast!.children, node => banner
    ? node.tag === "a-alert" && node.props.some(prop => prop.type === 7 && prop.name === "if" && prop.exp?.loc.source.includes("selectedHostAsset"))
    : node.tag === "a-dropdown");
  assert.ok(entry);
  const next = entry.siblings.slice(entry.siblings.indexOf(entry.node) + 1).find(node => node.type === 1);
  const fallback = next?.type === 1 && next.props.some(prop => prop.type === 7 && prop.name === "else-if") ? next.loc.source : "";
  const compiled = compileTemplate({ source: `<div>${entry.node.loc.source}${fallback}</div>`, filename: filename.pathname, id: "readonly-asset-ui",
    compilerOptions: { mode: "function", prefixIdentifiers: true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)({ ...vue, resolveComponent: (name: string) => name }) as (ctx: Record<string, unknown>, cache: unknown[]) => vue.VNode;
  const result: vue.VNode[] = [];
  /** 展开真实元素和 Fragment，保留组件入口及其公开 props。 */
  function visit(value: unknown): void {
    if (!vue.isVNode(value)) return;
    result.push(value);
    if (Array.isArray(value.children)) value.children.forEach(visit);
  }
  visit(render(context, []));
  return result;
}

for (const { file, type, variable } of [
  { file: "workflow-sidebar.vue", type: "workflow", variable: "wf" },
  { file: "role-list.vue", type: "role", variable: "role" },
  { file: "knowledge-bundle-list.vue", type: "knowledge_bundle", variable: "bundle" },
  { file: "skill-list.vue", type: "skill", variable: "skill" },
  { file: "toolset-list.vue", type: "toolset", variable: "toolset" },
]) test(`${type} 只读Client原件不显示维护菜单，账号资产保留菜单`, () => {
  const context = { props: { maintenanceForbidden: false, locked: false }, orch: { assetListHostIds: { [type]: ["client-original"] } },
    [variable]: { id: "client-original", kind: "custom", name: "原件" }, isSuperAdmin: true, confirmDelete() {}, assetGroupBarRef: null };
  const readonly = renderEntry(file, context);
  assert.equal(readonly.some(node => node.type === "a-dropdown" || node.type === "button"), false, "超管也不能通过兜底删除按钮维护Client原件");
  context[variable] = { id: "server-asset", kind: "custom", name: "账号资产" };
  assert.equal(renderEntry(file, context).some(node => node.type === "a-dropdown"), true);
  context.props.maintenanceForbidden = true;
  assert.equal(renderEntry(file, context).some(node => node.type === "a-dropdown" || node.type === "button"), false);
});

test("超管内置流程删除入口不显示Client原件，仍保留账号资产的原权限", () => {
  const context = { props: { maintenanceForbidden: false, locked: false }, orch: { assetListHostIds: { workflow: ["client-builtin"] } },
    wf: { id: "client-builtin", kind: "builtin" }, isSuperAdmin: true, confirmDelete() {} };
  assert.equal(renderEntry("workflow-sidebar.vue", context).some(node => node.type === "button"), false);
  context.wf.id = "server-builtin";
  assert.equal(renderEntry("workflow-sidebar.vue", context).some(node => node.type === "button"), true);
});

test("Client原件只读提示不误称为共享资产", () => {
  const nodes = renderEntry("orchestration-layout.vue", { selectedHostAsset: true, selectedBuiltinAsset: false }, true);
  assert.equal(nodes.find(node => node.type === "a-alert")?.props?.message, "此资产来自工作区所在电脑，仅供查看；请在该电脑上维护原定义。");
});
