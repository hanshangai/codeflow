import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import * as vue from "vue";

import {
  resolveDesktopTabletPrimaryPane,
  shouldRenderEmptyWorkspacePane,
} from "../src/layouts/main-view-keepalive.ts";

/** 读取仓库内的源码文本（路径相对仓库根，与既有源码断言测试一致），并归一化换行以便断言。 */
function readSource(relativePath: string): string {
  return fs.readFileSync(relativePath, "utf8").replace(/\r\n/g, "\n");
}

const { parse, compileTemplate } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");
type TemplateNode = NonNullable<NonNullable<ReturnType<typeof parse>["descriptor"]["template"]>["ast"]>["children"][number];

/** 定位真实侧栏子树，保留列表与预览分支的原始渲染条件。 */
function findSidebar(nodes: TemplateNode[], id: string): TemplateNode | undefined {
  for (const node of nodes) {
    if (node.type !== 1) continue;
    if (node.props.some(prop => prop.type === 6 && prop.name === "id" && prop.value?.content === id)) return node;
    const nested = findSidebar(node.children, id);
    if (nested) return nested;
  }
}

/** 编译实际模板并展开 VNode，隔离子组件但不复制可见性公式。 */
function renderSidebar(id: string, context: Record<string, unknown>): vue.VNode[] {
  const filename = "apps/web/src/features/orchestration/components/orchestration-layout.vue";
  const parsed = parse(readSource(filename));
  assert.deepEqual(parsed.errors, []);
  const node = findSidebar(parsed.descriptor.template!.ast!.children, id);
  assert.ok(node, `缺少侧栏 ${id}`);
  const compiled = compileTemplate({ source: node.loc.source, filename, id: "preview-sidebar",
    compilerOptions: { mode: "function", prefixIdentifiers: true, isCustomElement: () => true } });
  assert.deepEqual(compiled.errors, []);
  const render = new Function("Vue", compiled.code)(vue) as (context: Record<string, unknown>, cache: unknown[]) => vue.VNode;
  const nodes: vue.VNode[] = [];
  /** 收集元素和 Fragment 的子节点，供断言实际挂载入口。 */
  function visit(value: unknown): void {
    if (!vue.isVNode(value)) return;
    nodes.push(value);
    if (Array.isArray(value.children)) value.children.forEach(visit);
  }
  visit(render(context, []));
  return nodes;
}

const EMPTY_WORKSPACE_TEXT = "工作区创建后，会话、文件和需求编排会自动进入可用状态。";

test("empty workspace pane stays exclusive to the chat pane", () => {
  // 真值表：只有「无工作区 + 会话 pane」才保留整块空态。
  assert.equal(
    shouldRenderEmptyWorkspacePane({ hasWorkspace: false, primaryPane: "chat" }),
    true,
  );
  assert.equal(
    shouldRenderEmptyWorkspacePane({ hasWorkspace: false, primaryPane: "orchestration" }),
    false,
  );
  assert.equal(
    shouldRenderEmptyWorkspacePane({ hasWorkspace: true, primaryPane: "chat" }),
    false,
  );
  assert.equal(
    shouldRenderEmptyWorkspacePane({ hasWorkspace: true, primaryPane: "orchestration" }),
    false,
  );
});

test("desktop and tablet layouts mount the orchestration pane without a workspace", () => {
  for (const layoutPath of [
    "apps/web/src/layouts/desktop/desktop-layout.vue",
    "apps/web/src/layouts/tablet/tablet-layout.vue",
  ]) {
    const source = readSource(layoutPath);
    assert.match(source, /import \{[\s\S]*?shouldRenderEmptyWorkspacePane,[\s\S]*?\} from "\.\.\/main-view-keepalive";/u, layoutPath);
    assert.match(source, /const showEmptyWorkspacePane = computed\(\(\) => shouldRenderEmptyWorkspacePane\(\{/u, layoutPath);
    // 空态改由纯函数驱动，不能再裸判 !hasWorkspace。
    assert.doesNotMatch(source, /v-if="!hasWorkspace"/u, layoutPath);
    assert.match(source, /<div v-if="showEmptyWorkspacePane" class="layout__empty-workspace">/u, layoutPath);
    // 空态文案必须逐字保留。
    assert.ok(source.includes(EMPTY_WORKSPACE_TEXT), layoutPath);
    // workspaceId 必须归一化为字符串，否则 undefined 会经 String() 变成真值 "undefined" 让预览判定失效。
    assert.match(source, /const workspaceId = String\(config\.workspaceId \?\? ""\);/u, layoutPath);
    assert.doesNotMatch(source, /workspaceId: config\.workspaceId/u, layoutPath);
  }
});

test("orchestration layout derives preview mode from a missing workspace only", () => {
  const source = readSource("apps/web/src/features/orchestration/components/orchestration-layout.vue");

  assert.match(
    source,
    /const normalizedWorkspaceId = computed\(\(\) => String\(props\.workspaceId \?\? ""\)\.trim\(\)\);/u,
  );
  assert.match(source, /const previewReadonly = computed\(\(\) => normalizedWorkspaceId\.value === ""\);/u);
  // 预览分支不读 store 选中态，改用自身选中项。
  assert.match(source, /const previewSelectedId = ref\(""\);/u);
  assert.match(source, /useBuiltinAssetLibrary\(\)/u);
  // 无工作区时客户端在线态会回落到账号级，加载态必须排除预览态。
  assert.match(source, /const assetPageLoading = computed\(\(\) => \(\n\s*activeAssetView\.value === "assets"\n\s*&& !previewReadonly\.value/u);
  // 进入预览态时清掉上一个工作区的水合状态。
  assert.match(source, /orch\.resetForWorkspace\(null\);/u);
});

test("preview assets panel mounts read-only forms and nothing else", () => {
  const source = readSource("apps/web/src/features/orchestration/components/orchestration-layout.vue");
  const previewPanelStart = source.indexOf('<div v-if="previewReadonly" class="orch-layout__panel orch-layout__panel--asset">');
  const previewPanelEnd = source.indexOf('<div v-else class="orch-layout__panel orch-layout__panel--asset">');
  assert.ok(previewPanelStart > -1, "预览资产面板未找到");
  assert.ok(previewPanelEnd > previewPanelStart, "预览资产面板边界未找到");
  const previewPanel = source.slice(previewPanelStart, previewPanelEnd);

  for (const mounted of [
    "RoleDefinitionForm",
    "WorkflowEditor",
    "KnowledgeBundleForm",
    "ToolsetForm",
    "SkillForm",
  ]) {
    assert.ok(previewPanel.includes(`<${mounted}`), `预览详情缺少 ${mounted}`);
  }
  assert.equal(previewPanel.split(':workspace-id="\'\'"').length - 1, 5);
  assert.equal(previewPanel.split(':preview-readonly="true"').length - 1, 5);

  // 所有写入口都定义在这些组件内部：不挂载即不存在。
  for (const forbidden of [
    "AssetAssistantPanel",
    "McpManagementPanel",
    "SkillMarketplacePanel",
    "KnowledgeBundleList",
    "ToolsetList",
    "SkillList",
    "RoleList",
    "WorkflowSidebar",
  ]) {
    assert.ok(!previewPanel.includes(forbidden), `预览详情不得挂载 ${forbidden}`);
  }
});

test("preview left column replaces every list and assistant entrypoint", () => {
  const source = readSource("apps/web/src/features/orchestration/components/orchestration-layout.vue");

  // 需求栏：预览态不挂载 TaskEntrySidebar，改为静态标签栏 + 引导文案。
  const sidebarContext = { workspaceId: "workspace", desktopSidebarCollapsed: false,
    previewWorkspaceTabs: ["原始需求", "需求编排", "定时任务"] };
  const preview = renderSidebar("orch-workspace-left-sidebar-content", { ...sidebarContext, previewReadonly: true });
  assert.equal(preview.some(node => node.type === "TaskEntrySidebar"), false);
  const tabs = preview.filter(node => node.props?.role === "tab");
  assert.deepEqual(tabs.map(node => String(node.children).trim()), sidebarContext.previewWorkspaceTabs);
  assert.ok(tabs.every(node => node.props?.disabled !== undefined && node.props?.onClick === undefined));
  const workspace = renderSidebar("orch-workspace-left-sidebar-content", { ...sidebarContext, previewReadonly: false });
  assert.equal(workspace.find(node => node.type === "TaskEntrySidebar")?.props?.["workspace-id"], "workspace");
  assert.match(source, /const previewWorkspaceTabs = \["原始需求", "需求编排", "定时任务"\] as const;/u);
  assert.ok(source.includes("创建工作区后可查看需求列表"));
  // 助手入口与内置资产管理入口在预览态不渲染。
  assert.match(source, /<template v-if="!previewReadonly">\n\s*<a-tooltip :title="plannedAssetNavMeta\.assistant\.label">/u);
  assert.doesNotMatch(source, /title="内置资产管理"/u);
  // 资产列表改为预览专用只读列表。
  assert.match(source, /<section v-if="previewReadonly" class="orch-layout__asset-sidebar-card">/u);
  assert.match(source, /class="orch-layout__asset-preview-item"/u);
  assert.ok(source.includes("暂无内置资产可预览"));
  assert.ok(source.includes("内置资产暂不可用"));
  // 左栏助手搜索块与助手侧栏段都必须带预览守卫：这两块曾漏守卫，
  // 工作区在会话内被清空后仍会渲染上一工作区的助手会话，其删除按钮会发出写请求。
  assert.equal(
    source.split(`v-if="!previewReadonly && activeAssetView === 'assistant'"`).length - 1,
    2,
  );
});

test("preview mode zeroes workspace-scoped assistant state when the workspace disappears", () => {
  const source = readSource("apps/web/src/features/orchestration/components/orchestration-layout.vue");

  // 工作区可在会话内被清空（无需刷新页面），此时 !wsId 分支必须把助手子视图与助手会话
  // 一起归零：assistantSessions 是组件本地 ref，orch.resetForWorkspace(null) 清不到它。
  // 用单条有界正则跨越该分支，保证三步归零同处一个分支且顺序正确。
  // 不用 source.indexOf("visibleHydrationRevision += 1;") 做切片终点：retryAssetPageLoad 里更早出现同一句，会切出空串。
  assert.match(
    source,
    /if \(!wsId\) \{[\s\S]{0,600}?activeAssetView\.value = "assets";[\s\S]{0,300}?assistantSessions\.value = \[\];[\s\S]{0,600}?orch\.resetForWorkspace\(null\);/u,
  );
});

test("preview banner renders only inside the two preview content areas", () => {
  const source = readSource("apps/web/src/features/orchestration/components/orchestration-layout.vue");
  const banner = "当前为预览模式，内容只读；创建或选择工作区后即可使用完整功能。";

  assert.equal(source.split(banner).length - 1, 2);
  assert.equal(source.split('<div v-if="previewReadonly" class="orch-layout__preview-banner">').length - 1, 2);
  // 纯文本提示条：不带 CTA，也不进全局顶栏。
  assert.doesNotMatch(source, /class="orch-layout__preview-banner"[\s\S]{0,300}<a-button/u);
  assert.ok(source.includes(".orch-layout__preview-banner {"));
});

test("every orchestration asset form supports forced read-only preview", () => {
  const forms: Array<{ file: string; extra: RegExp }> = [
    {
      file: "role-definition-form.vue",
      // 预览态跳过超管跨工作区工具集查询。
      extra: /props\.previewReadonly === true \|\| formTab\.value !== "tools"/u,
    },
    {
      file: "knowledge-bundle-form.vue",
      // 预览态不请求工作台文档根目录。
      extra: /async function loadWorkflowDocsRoot\(\) \{\n\s*\/\/[^\n]*\n\s*if \(props\.previewReadonly === true\) \{/u,
    },
    {
      file: "skill-form.vue",
      // 预览态不刷新安装状态，并排除「安装」页。
      extra: /props\.previewReadonly === true \? \[\] : \[\{ value: "install" as const, label: "安装" \}\]/u,
    },
    { file: "toolset-form.vue", extra: /const props = defineProps<\{\n\s*workspaceId: WorkspaceId;\n\s*toolsetId: ToolsetId;/u },
    { file: "workflow-editor.vue", extra: /const props = defineProps<\{\n\s*workspaceId: WorkspaceId;\n\s*workflowId: WorkflowId;/u },
  ];

  for (const { file, extra } of forms) {
    const source = readSource(`apps/web/src/features/orchestration/components/${file}`);
    assert.match(source, /previewReadonly\?: boolean;/u, file);
    // 强制只读必须并入既有只读红旗，否则超管在预览态仍可提交写操作。
    const readonlyDeclaration = source.match(
      /const isBuiltinReadonly = computed\(\(\) => props\.previewReadonly === true[\s\S]*?\)\);/u,
    )?.[0] ?? "";
    assert.notEqual(readonlyDeclaration, "", `${file} 未把 previewReadonly 并入 isBuiltinReadonly`);
    assert.ok(
      readonlyDeclaration.includes("canMaintainBuiltinSpecAssets(permissionInput.value)"),
      `${file} 覆盖了既有内置资产只读口径`,
    );
    assert.match(source, extra, file);
  }

  const skillSource = readSource("apps/web/src/features/orchestration/components/skill-form.vue");
  assert.match(skillSource, /props\.previewReadonly !== true\) void refreshInstallStatus\(false\);/u);
});

test("builtin asset library uses local bridge and shows a browser message without a workspace", () => {
  const apiSource = readSource("apps/web/src/api/orchestration/index.ts");
  assert.match(
    apiSource,
    /export function listBuiltinOrchAssets\(ctx: ApiRequestContext, assetType: OrchAssetType\) \{/u,
  );
  assert.match(apiSource, /path: `\/api\/orch\/builtin-assets\?assetType=\$\{encodeURIComponent\(assetType\)\}`/u);

  const composable = readSource("apps/web/src/features/orchestration/composables/useBuiltinAssetLibrary.ts");
  assert.ok(composable.includes("listBuiltinOrchAssets"));
  assert.ok(composable.includes("没有在线工作区，无法查看内置资产"));
  // 硬约束：不接触编排 store，不触发任何写接口。
  assert.doesNotMatch(composable, /useOrchestrationStore/u);
  assert.doesNotMatch(composable, /orch\./u);
  // 失败必须显式暴露给预览面板，不能静默吞掉。
  assert.match(composable, /errorByType\.value = \{/u);
});
