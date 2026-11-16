import assert from "node:assert/strict";
import test from "node:test";

import type { ChatWorkflowActiveStatus, ThreadWorkflowState } from "@codeflowai/shared";
import { resolveChatWorkflowBadge } from "../src/features/threads/threadStatusBadge.ts";

/** 构造活跃工作流态；status 走运行时白名单判定，允许传入非活跃值验证兜底。 */
function workflow(status: string): ThreadWorkflowState {
  return { status: status as ChatWorkflowActiveStatus, instanceId: "instance-1", taskId: "task-1" };
}

test("会话工作流 6 个活跃档位各自映射到会话列表行自己的文案与色调", () => {
  assert.deepEqual(resolveChatWorkflowBadge(workflow("pending")), { label: "等待执行", tone: "neutral" });
  assert.deepEqual(resolveChatWorkflowBadge(workflow("running")), { label: "运行中", tone: "running" });
  assert.deepEqual(resolveChatWorkflowBadge(workflow("paused")), { label: "已暂停", tone: "neutral" });
  assert.deepEqual(resolveChatWorkflowBadge(workflow("waiting-start")), { label: "待启动", tone: "info" });
  assert.deepEqual(resolveChatWorkflowBadge(workflow("waiting-approval")), { label: "待确认", tone: "info" });
  assert.deepEqual(resolveChatWorkflowBadge(workflow("waiting-feedback")), { label: "待补充", tone: "warning" });
});

test("会话行文案用列表自己的词汇，不复用工作流面板词表", () => {
  // 面板里 waiting-approval 叫「待审核」，列表行必须是「待确认」
  assert.equal(resolveChatWorkflowBadge(workflow("waiting-approval"))?.label, "待确认");
  // running 在列表行用专属 running 色调，不能被降级成 info
  assert.equal(resolveChatWorkflowBadge(workflow("running"))?.tone, "running");
});

test("没有工作流或运行时出现非活跃档位时不显示标签", () => {
  assert.equal(resolveChatWorkflowBadge(null), null);
  assert.equal(resolveChatWorkflowBadge(undefined), null);
  for (const status of ["completed", "failed", "cancelled", "", "unknown"]) {
    assert.equal(resolveChatWorkflowBadge(workflow(status)), null, `${status} 不应显示标签`);
  }
});
