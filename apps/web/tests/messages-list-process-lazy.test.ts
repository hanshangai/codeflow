import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { computed, isReactive, reactive, ref, shallowReactive } from "vue";
import { buildAssistantRenderNodes } from "../src/features/messages/assistantRenderNodes.ts";
import { prepareConversationItemsForDisplay } from "../src/features/messages/prepareConversationItems.ts";
import { prepareConversationItemsForDisplay as prepareShared } from "@codeflowai/shared";

import { markProcessBatchRendered } from "../src/features/messages/processBatchRendering.ts";

const listSource = readFileSync(
  new URL("../src/features/messages/components/messages-list.vue", import.meta.url),
  "utf8",
);

/** 执行真实 SFC setup 派生链；props仅浅层响应式，成员沿用调用方的真实响应性。 */
function createList(items: any[], builds: string[][]) {
  const source = listSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/u)![1]!;
  const ast = ts.createSourceFile("messages-list.ts", source, ts.ScriptTarget.Latest, true);
  const code = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getFullText(ast)).join("\n");
  const compiled = ts.transpileModule(`${code}\nreturn { groupedItems, getAssistantRenderNodes };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const props = shallowReactive({ items });
  const setup = new Function("computed", "isReactive", "ref", "provide", "defineProps", "defineEmits", "defineOptions", "buildAssistantRenderNodes", "markProcessBatchRendered", compiled);
  const list = setup(computed, isReactive, ref, () => {}, () => props, () => () => {}, () => {}, (group: any[]) => {
    builds.push(group.map(item => String(item.id)));
    return buildAssistantRenderNodes(group);
  }, markProcessBatchRendered);
  return { props, ...list };
}

test("尾部原地流式更新复用历史节点，当前正文与过程状态立即重新派生", () => {
  const items = reactive([
    { kind: "message", id: "u1", role: "user", text: "old" },
    { kind: "message", id: "a1", role: "assistant", text: "history" },
    { kind: "message", id: "u2", role: "user", text: "new" },
    { kind: "message", id: "a2", role: "assistant", text: "" },
    { kind: "tool", id: "t2", toolType: "exec", status: "started", title: "run" },
    { kind: "reasoning", id: "r2", content: "thinking" },
  ] as any[]);
  const builds: string[][] = [];
  const list = createList(items, builds);
  const historicalKey = "assistant-group:message:a1";
  const currentKey = "assistant-group:message:a2";
  const old = list.getAssistantRenderNodes(historicalKey);
  assert.equal(list.getAssistantRenderNodes(currentKey).some((node: any) => node.item?.id === "a2"), false);
  builds.length = 0;
  items[3]!.text = "streaming";
  const nodes = list.getAssistantRenderNodes(currentKey);
  assert.equal(nodes[0]?.item?.text, "streaming");
  assert.equal(list.getAssistantRenderNodes(historicalKey), old);
  assert.deepEqual(builds, [["a2", "t2", "r2"]]);
  items[4]!.status = "completed";
  const batch = list.getAssistantRenderNodes(currentKey).find((node: any) => node.kind === "process-batch");
  assert.equal(batch.statusCounts.done, 1);
  assert.equal(batch.statusCounts.running, 0);
  list.props.items = items.slice();
  list.getAssistantRenderNodes(currentKey);
  assert.equal(list.getAssistantRenderNodes(historicalKey), old);
});

for (const mixed of [false, true]) {
  test(`普通成员收到正文或完成状态后，新数组触发重新派生，mixed=${mixed}`, () => {
    const message = { kind: "message", id: "answer", role: "assistant", text: "" };
    const tool = { kind: "tool", id: "tool", toolType: "exec", status: "started", title: "run" };
    const reason = { kind: "reasoning", id: "reason", content: "thinking" };
    const items = [message, tool, mixed ? reactive(reason) : reason];
    const list = createList(items, []);
    const key = "assistant-group:message:answer";
    assert.equal(list.getAssistantRenderNodes(key).some((node: any) => node.item?.id === "answer"), false);
    message.text = "streamed";
    tool.status = "completed";
    list.props.items = items.slice();
    const nodes = list.getAssistantRenderNodes(key);
    assert.equal(nodes[0]?.item?.text, "streamed");
    const batch = nodes.find((node: any) => node.kind === "process-batch");
    assert.equal(batch.statusCounts.done, 1);
    assert.equal(batch.statusCounts.running, 0);
  });
}

test("展示转换仅重新读取变更组，原地正文和工具完成仍与shared转换相同", () => {
  let historicalReads = 0;
  const items = reactive([
    { kind: "message", id: "u1", role: "user", text: "old" },
    { kind: "message", id: "a1", role: "assistant", get text() { historicalReads++; return "history"; } },
    { kind: "message", id: "u2", role: "user", text: "new" },
    { kind: "message", id: "a2", role: "assistant", text: "stream" },
    { kind: "tool", id: "t2", toolType: "read", status: "started", detail: '{"path":"file.ts"}' },
  ] as any[]);
  const display = computed(() => prepareConversationItemsForDisplay(items));
  assert.deepEqual(display.value, prepareShared(items));
  historicalReads = 0;
  items[3]!.text = "updated";
  items[4]!.status = "completed";
  const actual = display.value;
  assert.equal(historicalReads, 0);
  assert.deepEqual(actual, prepareShared(items));
  assert.equal(actual.at(-1)?.kind, "explore");
  assert.equal((actual.at(-1) as any).status, "explored");
  items[3]!.structuredPayloadJson = '{"schemaVersion":"requirement-analysis-assistant/v1"}';
  assert.equal(display.value[3]?.kind, "requirementAnalysis");
});

test("组内替换、回滚截断和迟到历史完成均刷新对应节点", () => {
  const items = reactive([
    { kind: "message", id: "u1", role: "user", text: "old" },
    { kind: "tool", id: "t1", toolType: "exec", status: "started", title: "run" },
    { kind: "reasoning", id: "r1", content: "thinking" },
    { kind: "message", id: "u2", role: "user", text: "new" },
    { kind: "message", id: "a2", role: "assistant", text: "stream" },
  ] as any[]);
  const list = createList(items, []);
  const historyKey = "assistant-group:tool:t1";
  const currentKey = "assistant-group:message:a2";
  const current = list.getAssistantRenderNodes(currentKey);
  assert.equal(list.getAssistantRenderNodes(historyKey)[0].statusCounts.running, 1);
  items[1]!.status = "completed";
  assert.equal(list.getAssistantRenderNodes(historyKey)[0].statusCounts.done, 1);
  assert.equal(list.getAssistantRenderNodes(currentKey), current);
  items[2] = { ...items[2], content: "replacement" };
  assert.equal(list.getAssistantRenderNodes(historyKey)[0].entries[1].item.content, "replacement");
  items.splice(2);
  assert.equal(list.getAssistantRenderNodes(currentKey).length, 0);
  assert.equal(list.getAssistantRenderNodes(historyKey)[0].item.status, "completed");
});

test("普通对象重复转换不缓存旧值，相邻探索合并保持原shared结果", () => {
  const items: any[] = [
    { kind: "tool", id: "t1", toolType: "read", status: "started", detail: '{"path":"a.ts"}' },
    { kind: "tool", id: "t2", toolType: "read", status: "started", detail: '{"path":"b.ts"}' },
    { kind: "message", id: "u1", role: "user", text: "next" },
    { kind: "tool", id: "t3", toolType: "read", status: "completed", detail: '{"path":"b.ts"}' },
  ];
  assert.deepEqual(prepareConversationItemsForDisplay(items), prepareShared(items));
  items[0].status = "completed";
  assert.deepEqual(prepareConversationItemsForDisplay(items), prepareShared(items));
});

test("过程块首次展开才加入渲染集合，收起与重复展开都不改动集合", () => {
  const empty: ReadonlySet<string> = new Set();
  // 折叠状态（含收起事件）不加入：这就是「不展开不加载」的判据。
  assert.equal(markProcessBatchRendered(empty, "batch-a", false), empty);

  const opened = markProcessBatchRendered(empty, "batch-a", true);
  assert.deepEqual([...opened], ["batch-a"]);

  // 重复展开（集合已有该 key）返回原集合：Vue 不会因同一引用而重新渲染。
  assert.equal(markProcessBatchRendered(opened, "batch-a", true), opened);
  // 收起时只增不减：已渲染内容保留，避免再次展开时重新挂载。
  assert.equal(markProcessBatchRendered(opened, "batch-a", false), opened);
  assert.deepEqual([...markProcessBatchRendered(opened, "batch-b", true)], ["batch-a", "batch-b"]);
});

test("过程块折叠时只渲染摘要，展开后才渲染条目", () => {
  assert.match(listSource, /<details v-else-if="node\.kind === 'process-batch'" class="msg msg--explore msg--collapsible msg--batch" @toggle="onProcessBatchToggle\(node\.key, \$event\)">/u);
  assert.match(listSource, /<div v-if="renderedProcessBatches\.has\(node\.key\)" class="msg__body msg__batch-list">/u);
  // 摘要（条数与预览）不能被门控：折叠时必须照常显示。
  assert.match(listSource, /<span class="msg__role">过程<\/span>/u);
  assert.match(listSource, /<span v-if="node\.preview" class="msg__summary-preview">\{\{ node\.preview \}\}<\/span>/u);
  assert.match(listSource, /<span class="msg__hint-inline">\{\{ node\.entries\.length \}\} 条<\/span>/u);
  assert.match(listSource, /renderedProcessBatches\.value = markProcessBatchRendered\(/u);
});
