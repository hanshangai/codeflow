import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultRoleExecutionConfig,
  createTaskAcceptanceCriteriaFromLines,
  type KnowledgeCatalogSnapshot,
  type NodeArtifactInput,
  type NodeRuntimePolicy,
  type RoleDefinition,
  type SkillPromptSnapshot,
} from "../../packages/shared/src/index.ts";
import { MANAGED_SERVICE_TOOL_ID } from "../../apps/desktop/client/src/orchestration/managedServiceRuntime.ts";
import { NodePromptBuilder } from "../../apps/desktop/client/src/orchestration/nodePromptBuilder.ts";

function createRole(): RoleDefinition {
  return {
    id: "role-dev" as any,
    workspaceId: "ws" as any,
    name: "开发工程师",
    description: "负责实现方案",
    responsibility: "修改代码并验证",
    systemPrompt: "必须真实修改文件并给出验证结果。",
    inputDefinition: {
      instructions: "根据需求完成开发",
      requiredFields: [],
    },
    outputDefinition: {
      instructions: "输出必须包含修改文件与验证结果",
      deliveryMode: "file-set",
      format: "markdown",
      resultKey: "unit-self-test-report",
      filePathRule: null,
      files: [
        {
          key: "main",
          name: "主交付文档",
          format: "markdown",
          pathRule: "codeflow-docs/功能/demo/开发工程师/implementation-report.md",
          description: "交付本轮正式实现报告，要求覆盖修改文件、验证结果和风险。",
          required: true,
        },
      ],
      requiredFields: [],
    },
    gateCriteria: [],
    executionConfig: createDefaultRoleExecutionConfig("claude"),
    defaultKnowledgeBundleIds: [],
    toolRefs: [],
    kind: "custom",
    createdAt: 1,
    updatedAt: 1,
  };
}

test("NodePromptBuilder renders xml prompt layers and keeps task content out of system message", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  role.outputDefinition.filePathRule = "{{workflowDocsRoot}}/<功能目录>/开发实现/DEV-<功能>.md";
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-1",
    workflowName: "软件工程流程",
    nodeId: "impl",
    nodeLabel: "开发实现",
    approvalMode: "manual",
    executionEngine: "claude",
    accessMode: "full-access",
    autoCompactPct: 81,
    contextWindow: 300000,
    toolRuntimePolicy: {
      allowedToolIds: ["run-tests"],
      requiresWorkspaceWrite: true,
    },
    artifactPolicy: {
      persistenceMode: "dual-write",
      outputMode: "file-set",
      primaryKind: "code/patch",
    },
  };
  const artifactInput: NodeArtifactInput = {
    artifacts: [
      {
        artifactId: "artifact-plan",
        kind: "solution-plan",
        nodeId: "design",
        title: "方案设计",
        version: 1,
        summaryText: "需要新增人工审核门禁",
        textContent: "需要新增人工审核门禁",
        workspaceFiles: ["docs/plan.md"],
        fields: [
          {
            key: "verificationSummary",
            label: "验证摘要",
            valueType: "markdown",
            valueText: "上游已完成方案验证。",
            valuePreview: "上游已完成方案验证。",
            required: true,
            validationStatus: "valid",
          },
        ],
        workspaceFileRefs: [
          {
            fileKey: "main",
            path: "docs/plan.md",
            summary: "方案文档",
            format: "markdown",
            validationStatus: "valid",
          },
        ],
        workspaceAttachmentRefs: [
          {
            key: "ddl",
            path: "docs/supporting.sql",
            summary: "补充 DDL",
            kind: "data",
            format: "sql",
            validationStatus: "valid",
          },
        ],
      },
    ],
    fieldBindings: { specDoc: "docs/plan.md" },
  };
  const knowledgeCatalogs: KnowledgeCatalogSnapshot[] = [{
    bundleId: "kb-1" as any,
    bundleName: "软件工程共享知识",
    scope: "shared",
    createdAt: 1,
    inlineItems: [
      {
        bundleId: "kb-1" as any,
        bundleName: "软件工程共享知识",
        sourceId: "source-inline",
        sourceKey: "kb-1:source-inline",
        sourceKind: "manual-text",
        title: "团队规范",
        description: "实现前先补测试",
        bodyText: "这里描述了项目约束",
        injectedAt: 1,
        contentHash: "hash-1",
        truncated: false,
      },
    ],
    runtimeSources: [
      {
        bundleId: "kb-1" as any,
        bundleName: "软件工程共享知识",
        sourceId: "source-runtime",
        sourceKey: "kb-1:source-runtime",
        sourceKind: "workspace-dir",
        title: "项目源码",
        description: "优先查看 src 和 tests",
        originRef: "src",
        workspaceRelPath: "src",
        targetType: "directory",
      },
    ],
    warnings: [],
  }];
  const skills: SkillPromptSnapshot[] = [{
    id: "skill-review" as any,
    name: "前端走查 Skill",
    description: "用于前端页面修改后的结构化走查",
    trigger: "涉及前端页面或交互变更时使用",
    instructions: "完成实现后，检查布局、状态、权限和可访问性，不要只看代码。",
    targetEngines: ["codex", "claude"],
    tags: ["frontend"],
    updatedAt: 1,
  }];

  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-1" as any,
    role,
    node: { id: "impl", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    taskTitle: "共享工作区一期：创建、邀请、Web 远程接入 host 与资料共享",
    taskTitlePathSegment: "共享工作区一期：创建、邀请、Web-远程接入-host-与资料共享",
    taskGoal: "给测试项目新增人工审核流程",
    acceptanceCriteria: createTaskAcceptanceCriteriaFromLines(["- 类型检查通过", "2. 执行过程可回放"]),
    renderedTaskInput: "请根据上游方案完成实现，并运行测试。",
    feedbackPatch: "每个阶段都要暂停等待审核",
    latestFeedbackPatch: "每个阶段都要暂停等待审核",
    latestFeedbackAction: "retry",
    runtimePolicy,
    toolRegistry: {
      tools: [
        {
          toolsetId: "ts-1" as any,
          toolsetName: "工程工具",
          toolId: "run-tests" as any,
          name: "运行测试",
          alias: null,
          description: "执行 npm test",
          runtime: "shell",
          usageGuidance: "实现后执行",
          invocationHint: "npm test",
          code: "__internal_tool_implementation__",
          inputSchema: "{\"type\":\"object\"}",
          outputSchema: "{\"type\":\"object\"}",
          timeoutMs: 1000,
          workingDirectory: ".",
          permissions: {
            requiresWrite: false,
          },
          envPolicy: null,
          required: false,
        },
      ],
    },
    knowledgeCatalogs,
    knowledgeWarnings: [],
    skills,
    artifactInput,
  });

  assert.match(built.systemMessage, /<system_prompt>/);
  assert.match(built.systemMessage, /<layer name="system">/);
  assert.match(built.systemMessage, /<layer name="developer">/);
  assert.match(built.systemMessage, /<tag name="delivery_contract">/);
  assert.match(built.systemMessage, /<tag name="human_feedback">/);
  assert.match(built.systemMessage, /<role_identity name="开发工程师" template="单元自测报告模板（结果标识：unit-self-test-report）">修改代码并验证<\/role_identity>/);
  assert.match(built.systemMessage, /<role_rules>必须真实修改文件并给出验证结果。<\/role_rules>/);
  assert.match(built.systemMessage, /<skills>/);
  assert.match(built.systemMessage, /<skill id="skill-review" name="前端走查 Skill" target_engines="codex,claude" trigger="涉及前端页面或交互变更时使用">/);
  assert.match(built.systemMessage, /<instructions>完成实现后，检查布局、状态、权限和可访问性，不要只看代码。<\/instructions>/);
  assert.doesNotMatch(built.userMessage, /前端走查 Skill/);
  assert.match(built.systemMessage, /<access_discipline>当前节点具备完整访问能力，但仍只允许围绕本节点目标做最小必要操作/);
  assert.match(built.systemMessage, /不要主动套用其他项目、历史任务、全局 MEMORY\.md/);
  assert.match(built.systemMessage, /不要主动切换到引擎自己的内部规划模式/);
  assert.match(built.systemMessage, /所有面向用户的说明/);
  assert.match(built.systemMessage, /不要把错误码、字段名、状态值、工具名/);
  assert.match(built.systemMessage, /先调用已有工具读取最新状态/);
  assert.match(built.systemMessage, /不要把这类内部错误写成 ask_human/);
  assert.doesNotMatch(built.systemMessage, /请联系系统管理员或开发人员/);
  assert.match(built.systemMessage, /不要发送过程性 commentary/);
  assert.match(built.systemMessage, /优先使用当前引擎提供的原生文件编辑能力做最小差异修改/);
  assert.match(built.systemMessage, /不得把终端乱码当成源码事实/);
  assert.match(built.systemMessage, /必须先用 UTF-8 方式读取文件/);
  assert.match(built.systemMessage, /如果当前仓库存在 `scripts\/check-utf8\.mjs`，优先执行/);
  assert.match(built.systemMessage, /不得因缺少该脚本直接判定验证失败/);
  assert.match(built.systemMessage, new RegExp("\u951F\u65A4\u62F7"));
  assert.doesNotMatch(built.systemMessage, /请根据上游方案完成实现，并运行测试。/);
  assert.doesNotMatch(built.systemMessage, /输出必须包含修改文件与验证结果/);
  assert.doesNotMatch(built.systemMessage, /正式交付文件必须先直接写入工作区目标目录/);
  assert.doesNotMatch(built.systemMessage, /给测试项目新增人工审核流程/);

  assert.match(built.developerMessage ?? "", /<developer_prompt>/);
  assert.match(built.developerMessage ?? "", /<execution_brief>请根据上游方案完成实现，并运行测试。<\/execution_brief>/);
  assert.match(built.developerMessage ?? "", /<delivery_files>/);
  assert.match(built.developerMessage ?? "", /<file name="主交付文档" required="true" format="markdown" key="main" pathRule="codeflow-docs\/功能\/demo\/开发工程师\/implementation-report\.md">/);
  assert.match(built.developerMessage ?? "", /交付本轮正式实现报告，要求覆盖修改文件、验证结果和风险。/);
  assert.doesNotMatch(built.developerMessage ?? "", /<delivery_template format="markdown">/);
  assert.doesNotMatch(built.developerMessage ?? "", /输出必须包含修改文件与验证结果/);
  assert.match(built.developerMessage ?? "", /<execution_principles>/);
  assert.match(built.developerMessage ?? "", /本轮属于当前节点重做；沿用本线程已有上下文/);
  assert.match(built.developerMessage ?? "", /<delivery_contract outputMode="file-set">/);
  assert.match(built.developerMessage ?? "", /runtime\.submitNodeResult/);
  assert.match(built.developerMessage ?? "", /路径占位符约定/);
  assert.match(built.developerMessage ?? "", /&lt;task_title_path_segment&gt; \/ &lt;task_title&gt;/);
  assert.match(built.developerMessage ?? "", /不要只按 task_goal 摘要另起短名/);
  assert.doesNotMatch(built.developerMessage ?? "", /共享工作区一期：创建、邀请、Web/);
  assert.match(built.developerMessage ?? "", /不要通过 assistant 文本输出任何 JSON 协议/);
  assert.match(built.developerMessage ?? "", /<tool_registry>/);
  assert.match(built.developerMessage ?? "", /<tool toolId="run-tests" name="运行测试" required="false">/);
  assert.match(built.developerMessage ?? "", /<runtime_policy>/);
  assert.match(built.developerMessage ?? "", /<knowledge_contract>/);
  assert.match(built.developerMessage ?? "", /已采用项目规格按适用范围遵守；其他知识作为参考资料/);
  assert.match(built.developerMessage ?? "", /文件和目录型知识会以标题、用途和路径形式列出/);
  assert.match(built.developerMessage ?? "", /直接使用引擎原生 Read\/Glob\/Bash/);
  assert.match(built.developerMessage ?? "", /不要搜索全局 MEMORY\.md、其他仓库 AGENTS\.md/);
  assert.match(built.developerMessage ?? "", /原生工具保持可用/);
  assert.match(built.developerMessage ?? "", /<item key="auto_compact_pct">81%<\/item>/);
  assert.match(built.developerMessage ?? "", /<item key="context_window">300000<\/item>/);
  assert.match(built.developerMessage ?? "", /<platform_capabilities>/);
  assert.match(built.developerMessage ?? "", /<item key="invocation_hint">npm test<\/item>/);
  assert.match(built.developerMessage ?? "", /<item key="usage_guidance">实现后执行<\/item>/);
  assert.match(built.developerMessage ?? "", /<item key="input_schema">对象<\/item>/);
  assert.match(built.developerMessage ?? "", /<item key="output_schema">对象<\/item>/);
  assert.match(built.developerMessage ?? "", /control\.nextAction/);
  assert.match(built.developerMessage ?? "", /review\.verdict/);
  assert.match(built.developerMessage ?? "", /criterionId 只能引用本轮需求里已经出现过的验收项 ID/);
  assert.match(built.developerMessage ?? "", /acceptanceChecks\[\]\.verdict 只能填写 pass \/ fail \/ not_evaluated/);
  assert.match(built.developerMessage ?? "", /先直接写入工作区目标目录/);
  assert.match(built.developerMessage ?? "", /不要把文件正文内联进工具入参/);
  assert.match(built.developerMessage ?? "", /优先直接修改原文件并沿用原路径/);
  assert.match(built.developerMessage ?? "", /已配置 1 个交付项/);
  assert.match(built.developerMessage ?? "", /answer\.files\[\]\.key 必须填写 delivery_files 中的 key；key 是交付物编号，不是文件名，文件名和目录只写在 path/);
  assert.match(built.developerMessage ?? "", /动态材料放 answer\.attachments/);
  assert.match(built.developerMessage ?? "", /&quot;key&quot;: &quot;main&quot;/);
  assert.match(built.developerMessage ?? "", /codeflow-docs\/功能\/demo\/开发工程师\/implementation-report\.md/);
  assert.doesNotMatch(built.developerMessage ?? "", /&quot;key&quot;: &quot;appendix&quot;/);
  assert.match(built.developerMessage ?? "", /&quot;attachments&quot;/);
  assert.doesNotMatch(built.developerMessage ?? "", /工具集：/);
  assert.doesNotMatch(built.developerMessage ?? "", /runtime：/);
  assert.doesNotMatch(built.developerMessage ?? "", /toolsetId/);
  assert.doesNotMatch(built.developerMessage ?? "", /bundleId:/);
  assert.doesNotMatch(built.developerMessage ?? "", /sourceId:/);
  assert.doesNotMatch(built.developerMessage ?? "", /__internal_tool_implementation__/);

  assert.match(built.userMessage, /<user_prompt>/);
  assert.match(built.userMessage, /<task_title>共享工作区一期：创建、邀请、Web 远程接入 host 与资料共享<\/task_title>/);
  assert.match(built.userMessage, /<task_title_path_segment>共享工作区一期：创建、邀请、Web-远程接入-host-与资料共享<\/task_title_path_segment>/);
  assert.match(built.userMessage, /<task_goal>给测试项目新增人工审核流程<\/task_goal>/);
  assert.match(built.userMessage, /<execution_intent mode="rework-current-node">/);
  assert.match(built.userMessage, /当前轮次是当前节点重做/);
  assert.equal(built.promptEnvelope.schemaVersion, "node-prompt-envelope/v1");
  assert.equal(built.promptEnvelope.meta.intent, "rework-current-node");
  assert.equal(built.promptEnvelope.meta.instanceId, "orch-1");
  assert.equal(built.promptEnvelope.role.name, "开发工程师");
  assert.equal(built.promptEnvelope.task.title, "共享工作区一期：创建、邀请、Web 远程接入 host 与资料共享");
  assert.equal(built.promptEnvelope.task.titlePathSegment, "共享工作区一期：创建、邀请、Web-远程接入-host-与资料共享");
  assert.equal(built.promptEnvelope.task.goal, "给测试项目新增人工审核流程");
  assert.deepEqual(built.promptEnvelope.task.fieldBindings, { specDoc: "docs/plan.md" });
  assert.equal(built.promptEnvelope.artifacts.upstreamArtifacts[0]?.artifactId, "artifact-plan");
  assert.equal(built.promptEnvelope.review.feedbackPatch, "每个阶段都要暂停等待审核");
  assert.equal(built.promptEnvelope.review.latestFeedbackPatch, "每个阶段都要暂停等待审核");
  assert.equal(built.promptEnvelope.review.latestAction, "retry");
  assert.match(built.userMessage, /<acceptance_criteria>/);
  assert.match(built.userMessage, /<criterion id="ac_1" blocking="true">类型检查通过<\/criterion>/);
  assert.match(built.userMessage, /<criterion id="ac_2" blocking="true">执行过程可回放<\/criterion>/);
  assert.match(built.userMessage, /<artifact_ref artifactId="artifact-plan" kind="solution-plan" sourceNodeId="design" version="1">/);
  assert.match(built.userMessage, /<output_fields>/);
  assert.match(built.userMessage, /<output_field key="verificationSummary" label="验证摘要" type="markdown" required="true" status="valid">上游已完成方案验证。<\/output_field>/);
  assert.match(built.userMessage, /<file_ref key="main" format="markdown" status="valid">/);
  assert.match(built.userMessage, /<path>docs\/plan\.md<\/path>/);
  assert.match(built.userMessage, /<item key="summary">方案文档<\/item>/);
  assert.match(built.userMessage, /<attachments>/);
  assert.match(built.userMessage, /<attachment key="ddl" kind="data" status="valid">/);
  assert.match(built.userMessage, /<path>docs\/supporting\.sql<\/path>/);
  assert.match(built.userMessage, /<item key="summary">补充 DDL<\/item>/);
  assert.match(built.userMessage, /<field_bindings>/);
  assert.match(built.userMessage, /<field key="specDoc">docs\/plan\.md<\/field>/);
  assert.match(built.userMessage, /<inline_knowledge>/);
  assert.match(built.userMessage, /<knowledge_item title="团队规范" kind="手写正文" description="实现前先补测试">/);
  assert.match(built.userMessage, /这里描述了项目约束/);
  assert.match(built.userMessage, /<reference_paths>/);
  assert.match(built.userMessage, /<source_ref kind="项目目录" path="src" usage="项目源码">/);
  assert.match(built.userMessage, /查看方式：直接使用引擎原生 Read\/Glob\/Bash 等能力/);
  assert.match(built.userMessage, /<human_feedback>每个阶段都要暂停等待审核<\/human_feedback>/);
  assert.match(built.userMessage, /<item key="summary">需要新增人工审核门禁<\/item>/);
  assert.match(built.userMessage, /如需正文或细节，请直接使用引擎原生 Read\/Glob\/Bash 读取上述文件/);
  assert.doesNotMatch(built.userMessage, /请根据上游方案完成实现，并运行测试。/);
  assert.doesNotMatch(built.userMessage, /输出必须包含修改文件与验证结果/);
  assert.doesNotMatch(built.userMessage, /不要把文件正文内联进 JSON/);
  assert.doesNotMatch(built.userMessage, /toolsetId/);
  assert.doesNotMatch(built.userMessage, /__internal_tool_implementation__/);
  assert.match(built.continuationUserMessage ?? "", /当前节点进入重做/);
  assert.match(built.continuationUserMessage ?? "", /<artifact_ref artifactId="artifact-plan"/);
  assert.doesNotMatch(built.continuationUserMessage ?? "", /<acceptance_criteria>/);
  assert.doesNotMatch(built.continuationUserMessage ?? "", /<inline_knowledge>/);

  assert.match(built.renderedInputPreview, /\[SYSTEM\]/);
  assert.match(built.renderedInputPreview, /\[DEVELOPER\]/);
  assert.match(built.renderedInputPreview, /\[USER\]/);
  assert.match(built.renderedInputPreview, /<system_prompt>/);
  assert.match(built.renderedInputPreview, /<developer_prompt>/);
  assert.match(built.renderedInputPreview, /<user_prompt>/);
});

test("NodePromptBuilder renders interrupted execution resume as a minimal continuation prompt", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-interrupted-resume",
    workflowName: "异常恢复流程",
    nodeId: "impl",
    nodeLabel: "开发实现",
    approvalMode: "manual",
    executionEngine: "codex",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: true,
    },
    artifactPolicy: {
      persistenceMode: "dual-write",
      outputMode: "file-set",
      primaryKind: "implementation-report",
    },
  };
  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-interrupted-resume" as any,
    role,
    node: { id: "impl", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    taskTitle: "批次每人限次",
    taskTitlePathSegment: "批次每人限次",
    taskGoal: "继续完成兑换限次设计",
    taskBackground: "完整需求背景不应进入异常恢复 continuation。",
    acceptanceCriteria: createTaskAcceptanceCriteriaFromLines(["必须产出设计文档"]),
    renderedTaskInput: "完整任务说明不应进入异常恢复 continuation。",
    feedbackPatch: "- 人工补充后继续\n继续",
    latestFeedbackPatch: "- 人工补充后继续\n继续",
    latestFeedbackText: "继续",
    latestFeedbackAction: "resume_with_input",
    latestFeedbackSource: "execution",
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [
        {
          artifactId: "artifact-req",
          kind: "requirement-analysis-doc",
          nodeId: "req",
          title: "需求分析",
          version: 1,
          summaryText: "上游摘要不应进入异常恢复 continuation。",
          textContent: "",
          workspaceFiles: ["docs/REQ.md"],
          fields: null,
          workspaceFileRefs: null,
          workspaceAttachmentRefs: null,
        },
      ],
      fieldBindings: {},
    },
  });

  const continuation = built.continuationUserMessage ?? "";
  assert.equal(built.promptEnvelope.meta.intent, "resume-interrupted-node");
  assert.match(continuation, /<execution_intent mode="resume-interrupted-node">/);
  assert.match(continuation, /上一轮因异常终止或人工停止中断。复用本线程已有上下文继续执行。/);
  assert.match(continuation, /<human_feedback>继续<\/human_feedback>/);
  assert.doesNotMatch(continuation, /<task_title>/);
  assert.doesNotMatch(continuation, /<task_goal>/);
  assert.doesNotMatch(continuation, /<upstream_artifacts>/);
  assert.doesNotMatch(continuation, /artifact-req/);
  assert.doesNotMatch(continuation, /<acceptance_criteria>/);
  assert.doesNotMatch(continuation, /人工补充后继续/);
});

test("NodePromptBuilder keeps ordinary human-input resume compact without replaying upstream artifacts", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-human-input-resume",
    workflowName: "人工补充流程",
    nodeId: "impl",
    nodeLabel: "开发实现",
    approvalMode: "manual",
    executionEngine: "codex",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: true,
    },
    artifactPolicy: {
      persistenceMode: "dual-write",
      outputMode: "file-set",
      primaryKind: "implementation-report",
    },
  };
  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-human-input-resume" as any,
    role,
    node: { id: "impl", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    taskTitle: "人工补充恢复",
    taskTitlePathSegment: "人工补充恢复",
    taskGoal: "吸收人工补充后继续执行",
    taskBackground: null,
    acceptanceCriteria: null,
    renderedTaskInput: "处理人工补充。",
    feedbackPatch: "- 人工补充后继续\n补充字段映射",
    latestFeedbackPatch: "- 人工补充后继续\n补充字段映射",
    latestFeedbackText: "补充字段映射",
    latestFeedbackAction: "resume_with_input",
    latestFeedbackSource: "human_input",
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [
        {
          artifactId: "artifact-plan",
          kind: "solution-plan",
          nodeId: "plan",
          title: "开发计划",
          version: 1,
          summaryText: "计划摘要需要保留。",
          textContent: "",
          workspaceFiles: ["docs/PLAN.md"],
          fields: null,
          workspaceFileRefs: null,
          workspaceAttachmentRefs: null,
        },
      ],
      fieldBindings: {},
    },
  });

  const continuation = built.continuationUserMessage ?? "";
  assert.equal(built.promptEnvelope.meta.intent, "resume-current-node");
  assert.match(continuation, /<task_title>人工补充恢复<\/task_title>/);
  assert.doesNotMatch(continuation, /<upstream_artifacts>/);
  assert.doesNotMatch(continuation, /artifact-plan/);
  assert.match(continuation, /人工补充后继续/);
});

test("NodePromptBuilder renders feedback evidence artifacts on rework continuation prompt", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-rework-feedback-artifact",
    workflowName: "返工证据流程",
    nodeId: "dgn",
    nodeLabel: "技术设计",
    approvalMode: "manual",
    executionEngine: "codex",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: true,
    },
    artifactPolicy: {
      persistenceMode: "dual-write",
      outputMode: "file",
      primaryKind: "dgn-doc",
    },
  };
  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-rework-feedback-artifact" as any,
    role,
    node: { id: "dgn", type: "role", roleId: role.id, label: "技术设计", position: { x: 0, y: 0 } },
    taskTitle: "推广配额奖励发放",
    taskTitlePathSegment: "推广配额奖励发放",
    taskGoal: "修正推广奖励设计",
    taskBackground: null,
    acceptanceCriteria: null,
    renderedTaskInput: "重新设计推广奖励。",
    feedbackPatch: "- 上一轮返工记录\n先前已定位超时语义\n\n- 退回修改要求\n根据测试报告修正设计\n相关产出物：测试验证 输出 v3",
    latestFeedbackPatch: "- 退回修改要求\n根据测试报告修正设计\n相关产出物：测试验证 输出 v3",
    latestFeedbackText: "根据测试报告修正设计",
    latestFeedbackAction: "system_rework",
    latestFeedbackSource: null,
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [
        {
          artifactId: "artifact-req",
          kind: "requirement-analysis-doc",
          nodeId: "req",
          title: "需求分析",
          version: 1,
          status: "approved",
          summaryText: "REQ 摘要。",
          textContent: "",
          workspaceFiles: ["docs/REQ.md"],
          fields: null,
          workspaceFileRefs: null,
          workspaceAttachmentRefs: null,
        },
      ],
      fieldBindings: {},
    },
    feedbackArtifactInput: {
      artifacts: [
        {
          artifactId: "artifact-e2e-v3",
          kind: "e2e-report",
          nodeId: "e2e",
          title: "测试验证 输出 v3",
          version: 3,
          status: "superseded",
          summaryText: "E2E 阻塞报告：需要退回 DGN 并输出问题与修正方式附件。",
          textContent: "",
          workspaceFiles: ["codeflow-docs/推广配额奖励发放/集成测试/TEST-E2E.md"],
          fields: null,
          workspaceFileRefs: [
            {
              fileKey: "e2e",
              path: "codeflow-docs/推广配额奖励发放/集成测试/TEST-E2E.md",
              summary: "测试验证返工报告",
              format: "markdown",
              validationStatus: "valid",
            },
          ],
          workspaceAttachmentRefs: null,
        },
      ],
      fieldBindings: {},
    },
  });

  const continuation = built.continuationUserMessage ?? "";
  assert.equal(built.promptEnvelope.meta.intent, "rework-upstream-node");
  assert.match(continuation, /<feedback_artifacts>/);
  assert.match(continuation, /artifactId="artifact-e2e-v3"/);
  assert.match(continuation, /kind="e2e-report"/);
  assert.match(continuation, /status="superseded"/);
  assert.match(continuation, /<path>codeflow-docs\/推广配额奖励发放\/集成测试\/TEST-E2E\.md<\/path>/);
  assert.match(continuation, /E2E 阻塞报告/);
  assert.match(continuation, /<upstream_artifacts>/);
  assert.match(continuation, /artifact-req/);
  assert.match(continuation, /先前已定位超时语义/);
  assert.match(continuation, /反馈列举项是已知最小范围/);
  assert.doesNotMatch(continuation, /只根据本轮最新反馈/);
});

test("NodePromptBuilder marks model rework follow-up as a current-node recheck", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-rework-followup",
    workflowName: "返工后复审流程",
    nodeId: "review",
    nodeLabel: "综合评审",
    approvalMode: "manual",
    executionEngine: "codex",
    accessMode: "read-only",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "dual-write",
      outputMode: "file-set",
      primaryKind: "review-report",
    },
  };
  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-rework-followup" as any,
    role,
    node: { id: "review", type: "role", roleId: role.id, label: "综合评审", position: { x: 0, y: 0 } },
    taskTitle: "知识库复审",
    taskTitlePathSegment: "知识库复审",
    taskGoal: "验证返工结果并完成全量复审",
    taskBackground: null,
    acceptanceCriteria: null,
    renderedTaskInput: "重新评审当前领域。",
    feedbackPatch: "- 返工后复审要求\n读取上一轮评审报告并完成全部范围",
    latestFeedbackPatch: "- 返工后复审要求\n读取上一轮评审报告并完成全部范围",
    latestFeedbackText: "读取上一轮评审报告并完成全部范围",
    latestFeedbackAction: "system_rework_followup",
    latestFeedbackSource: null,
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: { artifacts: [], fieldBindings: {} },
  });

  assert.equal(built.promptEnvelope.meta.intent, "rework-current-node");
  assert.match(built.continuationUserMessage ?? "", /返工后复审要求/);
  assert.match(built.continuationUserMessage ?? "", /角色契约要求全量覆盖时/);
});

test("NodePromptBuilder marks read-only nodes as strict soft-read discipline in system message", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    workflowId: "wf-2",
    workflowName: "验证流程",
    nodeId: "verify",
    nodeLabel: "测试验证",
    approvalMode: "manual",
    executionEngine: "claude",
    accessMode: "read-only",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "db-only",
      outputMode: "text",
      primaryKind: "verification-report",
    },
  };

  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-2" as any,
    role,
    node: { id: "verify", type: "role", roleId: role.id, label: "测试验证", position: { x: 0, y: 0 } },
    taskTitle: "实现验证需求",
    taskTitlePathSegment: "实现验证需求",
    taskGoal: "验证当前实现是否满足需求",
    acceptanceCriteria: null,
    renderedTaskInput: "读取现有代码和测试，完成验证结论。",
    feedbackPatch: null,
    latestFeedbackPatch: null,
    latestFeedbackAction: null,
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [],
      fieldBindings: {},
    },
  });

  assert.match(built.systemMessage, /<access_discipline>当前节点访问模式为只读/);
  assert.equal(built.promptEnvelope.meta.intent, "execute");
  assert.equal(built.continuationUserMessage, null);
  assert.match(built.systemMessage, /不要修改工作区文件，也不要执行会写入文件、安装依赖或改变环境状态的命令/);
  assert.match(built.systemMessage, /即使当前引擎没有提供原生只读沙箱，也必须把这条当成严格执行纪律/);
  assert.match(built.systemMessage, /不要主动切换到引擎自己的内部规划模式/);
});

test("NodePromptBuilder tells orchestration nodes to use runtime managed services for long-running local servers", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  const runtimePolicy: NodeRuntimePolicy = {
    executionEngine: "claude",
    workflowId: "wf-managed-service",
    workflowName: "支付联调",
    nodeId: "e2e",
    nodeLabel: "端到端验证",
    approvalMode: "auto",
    accessMode: "current",
    toolRuntimePolicy: {
      allowedToolIds: [MANAGED_SERVICE_TOOL_ID as any],
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "db-only",
      outputMode: "text",
      primaryKind: "verification-report",
    },
  };

  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-managed-service" as any,
    role,
    node: { id: "e2e", type: "role", roleId: role.id, label: "端到端验证", position: { x: 0, y: 0 } },
    taskTitle: "支付联调验证",
    taskTitlePathSegment: "支付联调验证",
    taskGoal: "启动联调所需的本地服务并完成验证",
    acceptanceCriteria: null,
    renderedTaskInput: "需要拉起 mock server 和本地页面后继续执行验证。",
    feedbackPatch: null,
    latestFeedbackPatch: null,
    latestFeedbackAction: null,
    runtimePolicy,
    toolRegistry: {
      tools: [
        {
          toolsetId: "__runtime_managed_service__" as any,
          toolsetName: "内建后台服务",
          toolId: MANAGED_SERVICE_TOOL_ID as any,
          name: "管理后台本地服务",
          alias: null,
          description: "启动或停止需要持续存活的本地服务。",
          runtime: "builtin",
          usageGuidance: "mock server、dev server、watcher 一律走这里。",
          invocationHint: "action=ensure/status/stop",
          code: "",
          inputSchema: "{\"type\":\"object\"}",
          outputSchema: "{\"type\":\"object\"}",
          timeoutMs: null,
          workingDirectory: null,
          permissions: {
            requiresWrite: false,
          },
          envPolicy: null,
          required: false,
        },
      ],
    },
    knowledgeCatalogs: [],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [],
      fieldBindings: {},
    },
  });

  assert.match(built.developerMessage ?? "", /短生命周期的一次性命令继续优先使用引擎原生 Bash\/Read\/Glob/);
  assert.match(built.developerMessage ?? "", /runtime\.manageBackgroundService/);
  assert.match(built.developerMessage ?? "", /需要被页面里的“进程”区统一查看、停止、跨刷新保留/);
});

test("NodePromptBuilder escapes xml-sensitive dynamic content", () => {
  const builder = new NodePromptBuilder();
  const role = createRole();
  role.systemPrompt = "必须处理 <tag> & \"quote\"";
  const runtimePolicy: NodeRuntimePolicy = {
    executionEngine: "claude",
    workflowId: "wf-3",
    workflowName: "转义流程",
    nodeId: "impl",
    nodeLabel: "开发实现",
    approvalMode: "manual",
    accessMode: "full-access",
    toolRuntimePolicy: {
      allowedToolIds: [],
      requiresWorkspaceWrite: false,
    },
    artifactPolicy: {
      persistenceMode: "db-only",
      outputMode: "text",
      primaryKind: "text-result",
    },
  };

  const built = builder.build({
    billingContext: { providerId: runtimePolicy.executionEngine === "claude" ? "anthropic" : "openai", credentialSource: "none", capturedAt: 1 },
    instanceId: "orch-3" as any,
    role,
    node: { id: "impl", type: "role", roleId: role.id, label: "开发实现", position: { x: 0, y: 0 } },
    taskTitle: "标题 <title> & \"quotes\"",
    taskTitlePathSegment: "标题-title-quotes",
    taskGoal: "处理 <flow> & \"quotes\"",
    acceptanceCriteria: createTaskAcceptanceCriteriaFromLines(["- 支持 <xml> & 特殊字符"]),
    renderedTaskInput: "读取 <spec> & 输出",
    feedbackPatch: "反馈 <again> & \"later\"",
    latestFeedbackPatch: "反馈 <again> & \"later\"",
    latestFeedbackAction: "retry",
    runtimePolicy,
    toolRegistry: null,
    knowledgeCatalogs: [{
      bundleId: "kb-2" as any,
      bundleName: "转义知识",
      scope: "shared",
      createdAt: 1,
      inlineItems: [{
        bundleId: "kb-2" as any,
        bundleName: "转义知识",
        sourceId: "source-inline-2",
        sourceKey: "kb-2:source-inline-2",
        sourceKind: "manual-text",
        title: "XML 说明",
        description: "包含 <tag>",
        bodyText: "1 < 2 & 3 > 1",
        injectedAt: 1,
        contentHash: "hash-2",
        truncated: false,
      }],
      runtimeSources: [],
      warnings: [],
    }],
    knowledgeWarnings: [],
    artifactInput: {
      artifacts: [],
      fieldBindings: { xmlPath: "docs/<spec>.md" },
    },
  });

  assert.match(built.systemMessage, /必须处理 &lt;tag&gt; &amp; &quot;quote&quot;/);
  assert.match(built.developerMessage ?? "", /读取 &lt;spec&gt; &amp; 输出/);
  assert.match(built.userMessage, /处理 &lt;flow&gt; &amp; &quot;quotes&quot;/);
  assert.match(built.userMessage, /标题 &lt;title&gt; &amp; &quot;quotes&quot;/);
  assert.match(built.userMessage, /支持 &lt;xml&gt; &amp; 特殊字符/);
  assert.match(built.userMessage, /1 &lt; 2 &amp; 3 &gt; 1/);
  assert.match(built.userMessage, /docs\/&lt;spec&gt;\.md/);
  assert.match(built.userMessage, /反馈 &lt;again&gt; &amp; &quot;later&quot;/);
  assert.match(built.continuationUserMessage ?? "", /反馈 &lt;again&gt; &amp; &quot;later&quot;/);
});
