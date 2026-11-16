import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const handleApiRequestSource = fs.readFileSync(path.join(repoRoot, "apps/desktop/client/src/app/handleApiRequest.ts"), "utf8");

/** 截取会话工作流协作提示词片段，把断言限制在这段提示内，避免误伤同文件其它文案。 */
function workflowCollabPrompt(): string {
  const marker = "当前会话支持工作流协作。";
  const start = handleApiRequestSource.indexOf(marker);
  assert.ok(start >= 0, "handleApiRequest.ts 应保留会话工作流协作提示词");
  const end = handleApiRequestSource.indexOf("\n", start);
  assert.ok(end > start, "会话工作流协作提示词应位于单行字符串内");
  return handleApiRequestSource.slice(start, end);
}

/** 可用流程是运行时视图（自定义流程随时增删），模型必须现查，不得凭记忆或内置资产清单下结论。 */
test("会话工作流提示词要求以工具查询结果为准", () => {
  const prompt = workflowCollabPrompt();
  assert.ok(prompt.includes("以真实会话工作流工具的查询结果为准"), "应明确可用流程以工具查询结果为准");
  assert.ok(prompt.includes("不要凭记忆、历史上下文或内置资产清单断定某个流程不存在"), "应禁止凭旧信息断言某流程不存在");
  assert.ok(prompt.includes("用户点名了流程时先查询再回应"), "用户点名流程时应先查询再回应");
});

/** 回归护栏：改写这句时不得丢掉该提示词原有的约束。 */
test("会话工作流提示词保留既有约束", () => {
  const prompt = workflowCollabPrompt();
  assert.ok(prompt.includes("在开始修改前判断是否适合工作流"), "应保留推荐时机约束");
  assert.ok(prompt.includes("简单问答正常回答"), "应保留简单问答不推荐的约束");
  assert.ok(prompt.includes("不要伪造启动成功"), "应保留不得伪造启动成功的约束");
});
