import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { OrchAssetDefinitionKind } from "@codeflowai/shared";

import { sortBuiltinFirst, type BuiltinFirstSortable } from "../src/features/orchestration/workflow-order.ts";

const workflowSidebarSource = readFileSync(
  new URL("../src/features/orchestration/components/workflow-sidebar.vue", import.meta.url),
  "utf8",
);
const workflowOrderSource = readFileSync(
  new URL("../src/features/orchestration/workflow-order.ts", import.meta.url),
  "utf8",
);

/** 排序夹具：id 用于断言相对顺序，name 与 groupId 用于复现组件里的关键词/分组筛选。 */
type SortItem = {
  id: string;
  name: string;
  groupId?: string | null;
  kind?: OrchAssetDefinitionKind | null;
};

function idOf(items: readonly SortItem[]): string[] {
  return items.map((entry) => entry.id);
}

/** 运行时可能收到历史脏数据，这里显式窄化以覆盖 kind 非合法值的分支。 */
function dirtyKind(raw: string): OrchAssetDefinitionKind {
  return raw as OrchAssetDefinitionKind;
}

test("混合列表把内置流程稳定地排在非内置流程之前", () => {
  const input: SortItem[] = [
    { id: "custom-a", name: "自定义流程 A", kind: "custom" },
    { id: "builtin-a", name: "内置流程 A", kind: "builtin" },
    { id: "custom-b", name: "自定义流程 B", kind: "custom" },
    { id: "builtin-b", name: "内置流程 B", kind: "builtin" },
  ];

  const sorted = sortBuiltinFirst(input);

  assert.deepEqual(idOf(sorted), ["builtin-a", "builtin-b", "custom-a", "custom-b"]);
  assert.deepEqual(sorted.filter((entry) => entry.kind === "builtin").map((entry) => entry.id), ["builtin-a", "builtin-b"]);
  assert.deepEqual(sorted.filter((entry) => entry.kind !== "builtin").map((entry) => entry.id), ["custom-a", "custom-b"]);
});

test("单一类型与空输入保持原样", () => {
  const builtinOnly: SortItem[] = [
    { id: "builtin-a", name: "内置流程 A", kind: "builtin" },
    { id: "builtin-b", name: "内置流程 B", kind: "builtin" },
    { id: "builtin-c", name: "内置流程 C", kind: "builtin" },
  ];
  const customOnly: SortItem[] = [
    { id: "custom-a", name: "自定义流程 A", kind: "custom" },
    { id: "custom-b", name: "自定义流程 B", kind: "custom" },
  ];

  assert.deepEqual(idOf(sortBuiltinFirst(builtinOnly)), ["builtin-a", "builtin-b", "builtin-c"]);
  assert.deepEqual(idOf(sortBuiltinFirst(customOnly)), ["custom-a", "custom-b"]);
  assert.deepEqual(sortBuiltinFirst([] as SortItem[]), []);
});

test("kind 缺失或为未知值时按非内置处理且不抛错", () => {
  const input: SortItem[] = [
    { id: "custom-a", name: "自定义流程 A", kind: "custom" },
    { id: "builtin-a", name: "内置流程 A", kind: "builtin" },
    { id: "legacy-a", name: "历史流程 A" },
    { id: "legacy-b", name: "历史流程 B", kind: null },
    { id: "legacy-c", name: "历史流程 C", kind: dirtyKind("unknown-kind") },
  ];

  const sorted = sortBuiltinFirst(input);

  assert.deepEqual(idOf(sorted), ["builtin-a", "custom-a", "legacy-a", "legacy-b", "legacy-c"]);
});

test("排序不改动入参且返回新数组", () => {
  // 冻结数组与元素：实现若试图原地 push/sort 会直接抛错，而不是静默改坏数据源。
  const input: readonly SortItem[] = Object.freeze([
    Object.freeze({ id: "custom-a", name: "自定义流程 A", kind: "custom" as const }),
    Object.freeze({ id: "builtin-a", name: "内置流程 A", kind: "builtin" as const }),
  ]);
  const snapshot = idOf(input);

  const sorted = sortBuiltinFirst(input);

  assert.notEqual(sorted, input);
  assert.deepEqual(idOf(input), snapshot);
  assert.equal(input.length, 2);
});

test("同一对象重复出现时按输入顺序稳定落位", () => {
  const repeated: SortItem = { id: "builtin-a", name: "内置流程 A", kind: "builtin" };
  const input: SortItem[] = [
    repeated,
    { id: "custom-a", name: "自定义流程 A", kind: "custom" },
    repeated,
  ];

  // 两次出现都归属内置段，段内保持输入顺序，不相对于彼此重排。
  assert.deepEqual(idOf(sortBuiltinFirst(input)), ["builtin-a", "builtin-a", "custom-a"]);
});

test("先排序再筛选时命中集内部仍内置在前", () => {
  const input: SortItem[] = [
    { id: "custom-a", name: "自定义流程 A", groupId: "g1", kind: "custom" },
    { id: "builtin-a", name: "内置流程 A", groupId: "g1", kind: "builtin" },
    { id: "custom-b", name: "自定义流程 B", groupId: "g2", kind: "custom" },
    { id: "builtin-b", name: "内置流程 B", groupId: "g1", kind: "builtin" },
  ];
  const sorted = sortBuiltinFirst(input);

  const matchKeyword = (entry: SortItem, keyword: string): boolean => entry.name.toLowerCase().includes(keyword.toLowerCase());
  const matchGroup = (entry: SortItem, groupId: string): boolean => entry.groupId === groupId;

  assert.deepEqual(idOf(sorted.filter((entry) => matchKeyword(entry, "流程"))), ["builtin-a", "builtin-b", "custom-a", "custom-b"]);
  // 关键词命中的两个条目在数据源里原本交错，筛选后仍保持内置在前。
  assert.deepEqual(idOf(sorted.filter((entry) => matchKeyword(entry, "B"))), ["builtin-b", "custom-b"]);
  assert.deepEqual(idOf(sorted.filter((entry) => matchGroup(entry, "g1"))), ["builtin-a", "builtin-b", "custom-a"]);
  assert.deepEqual(sorted.filter((entry) => matchKeyword(entry, "无命中关键词")), []);
});

test("排序只依赖 kind 字段，不引入次级排序键", () => {
  // 只带 kind 的最小结构即可完成分区，说明排序不读取名称、版本或时间字段。
  const contractOnly: BuiltinFirstSortable[] = [{ kind: "custom" }, { kind: "builtin" }];
  assert.deepEqual(sortBuiltinFirst(contractOnly), [contractOnly[1], contractOnly[0]]);

  // 分区拼接不依赖运行时对 sort 稳定性的承诺，也不引入名称/时间等次级排序键。
  assert.doesNotMatch(workflowOrderSource, /\.sort\(/u);
  assert.doesNotMatch(workflowOrderSource, /localeCompare|updatedAt|createdAt/u);
});

test("流程侧栏主列表与导出清单都渲染排序后的列表", () => {
  assert.match(workflowSidebarSource, /import \{ sortBuiltinFirst \} from "\.\.\/workflow-order";/u);
  assert.match(workflowSidebarSource, /const sortedWorkflows = computed\(\(\) => sortBuiltinFirst\(orch\.workflows\)\);/u);
  assert.match(workflowSidebarSource, /const filteredWorkflows = computed\(\(\) =>\s*sortedWorkflows\.value\.filter\(/u);
  assert.match(workflowSidebarSource, /v-for="wf in sortedWorkflows"/u);
  assert.doesNotMatch(workflowSidebarSource, /v-for="wf in orch\.workflows"/u);
});

test("排序只在视图层生效，不改写 orch.workflows", () => {
  assert.doesNotMatch(workflowSidebarSource, /orch\.workflows\s*=[^=]/u);
});
