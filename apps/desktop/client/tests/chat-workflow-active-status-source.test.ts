import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHAT_WORKFLOW_ACTIVE_STATUSES, CHAT_WORKFLOW_ACTIVE_STATUS_LIST } from "@codeflowai/shared";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const threadRepoSource = fs.readFileSync(path.join(repoRoot, "apps/desktop/client/src/db/repos/threadRepo.ts"), "utf8");
const sharedSource = fs.readFileSync(path.join(repoRoot, "packages/shared/src/types/chatWorkflow.ts"), "utf8");

/** 按函数名截取源码片段，把断言限制在目标函数内，避免误伤其他域的同类状态字面量。 */
function functionSource(name: string): string {
  const start = threadRepoSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `threadRepo.ts 应保留 ${name}`);
  const end = /\r?\n\}\r?\n/u.exec(threadRepoSource.slice(start));
  assert.ok(end, `${name} 源码未闭合`);
  return threadRepoSource.slice(start, start + end.index);
}

test("活跃态枚举只在共享包定义一处，集合由有序数组构造", () => {
  assert.match(sharedSource, /CHAT_WORKFLOW_ACTIVE_STATUSES = new Set<string>\(CHAT_WORKFLOW_ACTIVE_STATUS_LIST\)/u);
  assert.equal(new Set(CHAT_WORKFLOW_ACTIVE_STATUS_LIST).size, CHAT_WORKFLOW_ACTIVE_STATUS_LIST.length, "有序数组不应有重复档位");
  assert.deepEqual([...CHAT_WORKFLOW_ACTIVE_STATUSES].sort(), [...CHAT_WORKFLOW_ACTIVE_STATUS_LIST].sort());
});

test("threadRepo 的活跃判定片段不再硬编码状态字面量", () => {
  const filterSource = functionSource("buildActiveChatWorkflowFilter");
  for (const status of CHAT_WORKFLOW_ACTIVE_STATUS_LIST) {
    assert.ok(!filterSource.includes(`'${status}'`) && !filterSource.includes(`"${status}"`), `判定片段不应出现状态字面量 ${status}`);
  }
  assert.match(filterSource, /CHAT_WORKFLOW_ACTIVE_STATUS_LIST\.map/u);
});

test("删除门禁与列表徽标共用同一判定片段", () => {
  assert.equal(
    threadRepoSource.match(/AND \$\{activeChatWorkflow\.sql\}/gu)?.length,
    2,
    "清理门禁与 listActiveChatWorkflows 都必须拼同一片段，避免「列表显示空闲却删不掉」",
  );
});
