import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/features/chat/components/chat-workflow-panel.vue", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../src/api/chatWorkflow.ts", import.meta.url), "utf8");

/** 三个互斥顶层区块的起始标记，按出现顺序排列。 */
const BLOCK_MARKERS = [
  `<template v-if="view.task.state === 'dismissed'">`,
  `<template v-else-if="view.task.state === 'recommended'">`,
  "<template v-else>",
];

/** 截取区块片段：到下一个顶层区块标记为止（区块内还有嵌套的 <template v-for>，不能按第一个 <template 截断）。 */
function blockAfter(marker: string): string {
  const index = BLOCK_MARKERS.indexOf(marker);
  const start = source.indexOf(marker);
  assert.ok(start >= 0 && index >= 0, `未找到区块标记：${marker}`);
  const end = source.indexOf(BLOCK_MARKERS[index + 1]!, start);
  assert.ok(end > start, `区块未闭合：${marker}`);
  return source.slice(start, end);
}

test("未启动的两个区块各有删除入口，且都以 readonly 与发起人身份双守卫", () => {
  for (const marker of BLOCK_MARKERS.slice(0, 2)) {
    const block = blockAfter(marker);
    assert.match(block, /<a-popconfirm v-if="!readOnly && view\.canAccept"[^>]*@confirm="removeCard\(view\)"/u, marker);
    assert.match(block, /<a-button size="small" danger/u, marker);
  }
  // 共享会话里未启动卡对全体协作者可见，只用 readOnly 会让非发起人点到必然 403 的按钮。
  assert.equal(source.match(/@confirm="removeCard\(view\)"/gu)?.length, 2);
  assert.equal(source.match(/<a-popconfirm v-if="!readOnly && view\.canAccept"/gu)?.length, 2);
});

test("删除确认文案写明不可恢复与关联记录范围", () => {
  const titles = [...source.matchAll(/title="(删除此工作流卡片？[^"]*)"/gu)].map(match => match[1]!);
  assert.deepEqual(titles, [
    "删除此工作流卡片？删除后不可恢复，关联的需求与提案一并删除。",
    "删除此工作流卡片？删除后不可恢复，关联的需求与提案一并删除。",
  ]);
});

test("删除调用带 expectedVersion 与 requestId，成功与失败都刷新面板", () => {
  assert.match(source, /import \{ actOnChatWorkflow, deleteChatWorkflow, getChatWorkflow, planChatWorkflowRework \} from "\.\.\/\.\.\/\.\.\/api\/chatWorkflow";/u);
  assert.match(source, /async function removeCard\(view: ChatWorkflowView\): Promise<void> \{\s*if \(busy\.value \|\| props\.readOnly\) return;/u);
  // 缺 expectedVersion 时 Server 侧 Number(undefined) 为 NaN，会一律 409，因此必须显式携带。
  assert.match(source, /await deleteChatWorkflow\(ctx\.value, \{ workspaceId: props\.workspaceId, threadId: props\.threadId, taskId: view\.task\.id, expectedVersion: view\.task\.version, requestId: createBrowserUuid\(\) \}\);/u);
  assert.match(source, /if \(!result\.ok\) throw new Error\(result\.message\);\s*await refresh\(scope\);/u);
  assert.match(source, /catch \(cause\) \{ if \(scope === generation\) \{ message\.error\(cause instanceof Error \? cause\.message : String\(cause\)\); await refresh\(scope\); \} \}/u);
});

test("删除入口不改变既有动作计数与保留类名", () => {
  assert.equal(source.match(/@click="startRework\(view\)"/gu)?.length, 3);
  assert.equal(source.match(/class="chat-workflow__todo-hint"/gu)?.length, 2);
  assert.doesNotMatch(source, /chat-workflow__toggle|chat-workflow__toolbar|chat-workflow__icon|刷新工作流状态/u);
  assert.deepEqual([...source.matchAll(/@media[^{]*/gu)].map(match => match[0].trim()), [
    "@media (prefers-reduced-motion: reduce)",
    "@media (max-width: 767px)",
  ]);
});

test("删除请求经统一 API 模块下发到独立 operation", () => {
  assert.match(apiSource, /export const deleteChatWorkflow = \(ctx: ApiRequestContext, body: \{ workspaceId: string; threadId: string; taskId: string; expectedVersion: number; requestId: string \}\) =>/u);
  assert.match(apiSource, /requestJson<\{ removed: \{ taskId: string \} \}>\(ctx, \{ method: "POST", path: "\/api\/orch\/chat\/delete", body \}\)/u);
});
