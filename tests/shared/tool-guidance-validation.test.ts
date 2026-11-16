import test from "node:test";
import assert from "node:assert/strict";

import {
  validateKnowledgeBundleDescription,
  validateRoleDefinitionSemantics,
  validateRoleSystemPrompt,
  validateToolInvocationHint,
} from "../../packages/shared/src/index.ts";

test("validateToolInvocationHint allows empty guidance", () => {
  const issues = validateToolInvocationHint("");
  assert.equal(issues.length, 0);
});

test("validateToolInvocationHint allows bare command guidance", () => {
  const issues = validateToolInvocationHint("npm test");
  assert.equal(issues.length, 0);
});

test("validateToolInvocationHint accepts concrete strategy and boundary guidance", () => {
  const issues = validateToolInvocationHint(
    [
      "适用场景：当需要稳定输出测试汇总时优先使用该工具。",
      "不要使用：如果只是看某个文件是否存在，直接用原生 Read/Bash 即可。",
      "调用后：先总结结果，再决定是否进入下一步修复。",
    ].join("\n"),
  );
  assert.equal(issues.length, 0);
});

test("validateRoleSystemPrompt allows vague identity-only prompt", () => {
  const issues = validateRoleSystemPrompt("您是开发工程师");
  assert.equal(issues.length, 0);
});

test("validateRoleSystemPrompt accepts prompt with identity rules and boundary", () => {
  const issues = validateRoleSystemPrompt(
    [
      "您是软件工程编排中的开发工程师，负责根据上游方案修改代码并说明验证结果。",
      "不要假装完成未验证的工作，遇到风险要直接说明。",
      "输出时先总结改动，再说明测试和遗留问题。",
    ].join("\n"),
  );
  assert.equal(issues.length, 0);
});

test("validateRoleDefinitionSemantics allows testing engineer without E2E expectation", () => {
  const issues = validateRoleDefinitionSemantics({
    name: "测试工程师",
    description: "负责验证当前交付结果",
    responsibility: "检查实现是否满足要求",
    systemPrompt: "您是测试工程师，负责验证结果并说明结论。",
    inputDefinition: { instructions: "阅读上游结果后开始验证。", requiredFields: [] },
    outputDefinition: { instructions: "输出验证结论。", deliveryMode: "direct", format: "markdown", resultKey: "verification-report", filePathRule: null, requiredFields: [] },
  });
  assert.equal(issues.length, 0);
});

test("validateRoleDefinitionSemantics accepts testing engineer with real-user E2E requirement", () => {
  const issues = validateRoleDefinitionSemantics({
    name: "测试工程师",
    description: "负责验证当前交付结果",
    responsibility: "至少执行一条真实用户路径的端到端验证",
    systemPrompt: [
      "您是测试工程师，必须执行至少一条真实用户路径的 E2E 验证。",
      "如果环境不支持浏览器自动化，要说明降级 smoke test 和限制。",
    ].join("\n"),
    inputDefinition: { instructions: "结合实现结果执行端到端验证。", requiredFields: [] },
    outputDefinition: { instructions: "输出 E2E 路径、结果和风险。", deliveryMode: "direct", format: "markdown", resultKey: "verification-report", filePathRule: null, requiredFields: [] },
  });
  assert.equal(issues.length, 0);
});

test("validateKnowledgeBundleDescription allows empty description", () => {
  const issues = validateKnowledgeBundleDescription("");
  assert.equal(issues.length, 0);
});

test("validateKnowledgeBundleDescription accepts scoped bundle description", () => {
  const issues = validateKnowledgeBundleDescription(
    [
      "这组知识主要服务于软件工程编排里的开发和测试节点。",
      "覆盖团队规范、关键文档和项目目录说明，帮助 AI 先看 README、src、tests，再按需深入具体文件。",
    ].join("\n"),
  );
  assert.equal(issues.length, 0);
});
