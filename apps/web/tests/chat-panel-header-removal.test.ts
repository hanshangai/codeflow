import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), "utf8");

const chatPanelSource = read("../src/features/chat/components/chat-panel.vue");
const chatPanelStyles = read("../src/styles/chat-panel.css");
const threadListSource = read("../src/features/threads/components/thread-list.vue");

const SCANNABLE_EXTENSIONS = new Set([".vue", ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".css", ".scss"]);
/** 活源码扫描根：只覆盖 Web 源码，排除构建产物与文档目录。 */
const WEB_SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

/** 递归收集扫描根下的活源码文件。 */
function collectSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(full));
    else if (SCANNABLE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

/** 判定一份源码是否仍在引用已移除的标题栏。 */
function findHeaderReferences(source: string): string[] {
  return [...source.matchAll(/chat-header|ChatHeader|hide-header|hideHeader|chat-panel__header|chat-panel__title|chat-panel__spacer|loading-shimmer/gu)].map((match) => match[0]);
}

/**
 * 会话面板顶部标题栏已按需求整条移除。
 * 本文件取代 chat-header-menu-items.test.ts：护栏方向从「标题栏菜单完整」反转为「标题栏不存在 + 列表入口完整」。
 */

test("标题栏组件文件已删除，会话面板不再导入或渲染 ChatHeader", () => {
  const headerUrl = new URL("../src/features/chat/components/chat-header.vue", import.meta.url);
  assert.ok(!existsSync(headerUrl), "chat-header.vue 应整文件删除，不保留空壳或兼容分支");

  assert.ok(!chatPanelSource.includes("ChatHeader"), "chat-panel.vue 不应再导入或渲染 ChatHeader");
  assert.ok(!chatPanelSource.includes("hideHeader"), "hideHeader 是只服务标题栏的公共 prop，应一并移除");
  assert.ok(!chatPanelSource.includes("chat-panel__header"), "chat-panel.vue 不应再引用标题栏类名");
});

test("v-else 分支中消息区成为面板首个可视子节点", () => {
  const branchIndex = chatPanelSource.indexOf("<template v-else>");
  assert.ok(branchIndex >= 0, "chat-panel.vue 应保留 v-else 分支");

  const bodyIndex = chatPanelSource.indexOf('class="chat-panel__body"', branchIndex);
  const headerIndex = chatPanelSource.indexOf("<ChatHeader", branchIndex);

  assert.ok(bodyIndex > branchIndex, "v-else 分支中应渲染 .chat-panel__body");
  assert.ok(
    headerIndex === -1 || headerIndex > bodyIndex,
    "标题栏移除后 .chat-panel__body 必须是 v-else 分支首个可视元素，面板顶部直接进入消息区",
  );
});

test("活源码与全局样式不再残留标题栏引用与专属样式", () => {
  const offenders: string[] = [];
  for (const file of collectSources(WEB_SRC_ROOT)) {
    const hits = findHeaderReferences(readFileSync(file, "utf8"));
    if (hits.length > 0) offenders.push(`${path.relative(WEB_SRC_ROOT, file)}: ${[...new Set(hits)].join(", ")}`);
  }
  assert.deepEqual(offenders, [], "标题栏组件、hideHeader prop 与传参、专属样式都必须清理干净");
});

test("测试与端到端代码不再引用已移除的标题栏", () => {
  const selfPath = fileURLToPath(import.meta.url);
  const roots = ["../tests", "../e2e"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of collectSources(root)) {
      if (path.resolve(file) === path.resolve(selfPath)) continue;
      const hits = findHeaderReferences(readFileSync(file, "utf8"));
      if (hits.length > 0) offenders.push(`${path.relative(WEB_SRC_ROOT, file)}: ${[...new Set(hits)].join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [], "过期护栏测试必须按新契约改写，不能只删断言或保留读已删文件的用例");
});

test("chat-panel.css 不再保留标题栏与回放进度条规则", () => {
  assert.doesNotMatch(chatPanelStyles, /chat-panel__header/u, "标题栏容器样式应删除");
  assert.doesNotMatch(chatPanelStyles, /chat-header__/u, "回放进度条样式应删除");
  assert.doesNotMatch(chatPanelStyles, /chat-panel__title|chat-panel__spacer/u, "标题栏内部样式应删除");
  assert.doesNotMatch(chatPanelStyles, /loading-shimmer/u, "只服务进度条闪动动画的关键帧应删除");

  // 删除边界不能越过既存的孤儿样式：__usage/__meta/__details 与本次无关，必须原样保留。
  assert.match(chatPanelStyles, /\.chat-panel__usage \{/u);
  assert.match(chatPanelStyles, /\.chat-panel__meta \{/u);
  assert.match(chatPanelStyles, /\.chat-panel__details \{/u);
});

test("会话级操作入口完整保留在会话列表的两套菜单中", () => {
  const menus = [...threadListSource.matchAll(/<a-menu>[\s\S]*?@click="confirmClear\(item\)"[\s\S]*?<\/a-menu>/gu)].map((match) => match[0]);
  assert.equal(menus.length, 2, "两种列表布局都应提供会话操作菜单");

  for (const menuSource of menus) {
    for (const binding of ["openRename(item)", "toggleArchive(item)", "confirmClear(item)", "confirmDelete(item)", "toggleInspector", "confirmRestartCodexAppServer(item)"]) {
      assert.ok(
        menuSource.includes(`@click="${binding}"`),
        `列表菜单应保留 ${binding}，标题栏移除后不能丢失任何会话级操作`,
      );
    }
  }
});
