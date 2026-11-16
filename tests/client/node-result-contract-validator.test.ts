import test from "node:test";
import assert from "node:assert/strict";

import type {
  NodeExecutionEnvelope,
  RoleDefinition,
} from "../../packages/shared/src/index.ts";
import { validateNodeResultContract } from "../../apps/desktop/client/src/orchestration/nodeResultContractValidator.ts";

function createRole(outputDefinition: RoleDefinition["outputDefinition"]): Pick<RoleDefinition, "outputDefinition"> {
  return { outputDefinition };
}

test("validateNodeResultContract accepts required fields from answer.fields", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "direct",
    format: "markdown",
    resultKey: "analysis-report",
    filePathRule: null,
    files: null,
    requiredFields: [
      {
        key: "verificationSummary",
        label: "验证摘要",
        valueType: "markdown",
        required: true,
      },
    ],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "analysis",
    resultName: "analysis-report",
    role,
    answer: {
      mode: "text",
      text: "分析完成",
      fields: {
        verificationSummary: "已通过本地验证。",
      },
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.consumable, true);
  assert.equal(result.normalizedFields.length, 1);
  assert.equal(result.normalizedFields[0]?.fieldKey, "verificationSummary");
  assert.equal(JSON.parse(result.normalizedFields[0]?.valueJson ?? "null"), "已通过本地验证。");
});

test("validateNodeResultContract can read configured fields from structured data", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "direct",
    format: "json",
    resultKey: "analysis-json",
    filePathRule: null,
    files: null,
    requiredFields: [
      {
        key: "riskCount",
        label: "风险数",
        valueType: "json",
        required: true,
      },
    ],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "analysis",
    resultName: "analysis-json",
    role,
    answer: {
      mode: "structured",
      data: {
        riskCount: 3,
      },
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedFields[0]?.fieldKey, "riskCount");
  assert.equal(JSON.parse(result.normalizedFields[0]?.valueJson ?? "null"), 3);
});

test("validateNodeResultContract rejects missing required fields and wrong file suffix", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file",
    format: "markdown",
    resultKey: "design-doc",
    filePathRule: null,
    files: [
      {
        key: "main",
        name: "主文档",
        format: "markdown",
        allowedExtensions: null,
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [
      {
        key: "reviewSummary",
        label: "评审摘要",
        valueType: "text",
        required: true,
      },
    ],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "design",
    resultName: "design-doc",
    role,
    answer: {
      mode: "file",
      file: {
        key: "main",
        path: "codeflow-docs/design.txt",
        summary: "设计文档",
      },
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.consumable, false);
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_FIELD_MISSING"));
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_FILE_EXTENSION_INVALID"));
});

test("validateNodeResultContract rejects missing key for single file contract outputs", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file",
    format: "markdown",
    resultKey: "design-doc",
    filePathRule: null,
    files: [
      {
        key: "main",
        name: "主文档",
        format: "markdown",
        allowedExtensions: null,
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "design",
    resultName: "design-doc",
    role,
    answer: {
      mode: "file",
      file: {
        path: "codeflow-docs/design.md",
        summary: "设计文档",
      },
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, false);
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_FILE_KEY_MISSING"));
});

test("validateNodeResultContract rejects unknown file keys and missing required delivery items", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "markdown",
    resultKey: "delivery-pack",
    filePathRule: null,
    files: [
      {
        key: "main-report",
        name: "主报告",
        format: "markdown",
        allowedExtensions: null,
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [],
  });
  const answer: NodeExecutionEnvelope = {
    mode: "file-set",
    files: [
      {
        key: "unknown",
        path: "codeflow-docs/unknown.md",
      },
    ],
  };

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "delivery",
    resultName: "delivery-pack",
    role,
    answer,
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, false);
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_FILE_KEY_UNKNOWN"));
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_FILE_REQUIRED_MISSING"));
  assert.match(result.blockingIssues.find((item) => item.code === "OUTPUT_FILE_KEY_UNKNOWN")?.message ?? "", /当前角色允许的文件 key（交付物编号）：main-report（主报告，格式 markdown，必填/);
  assert.match(result.blockingIssues.find((item) => item.code === "OUTPUT_FILE_KEY_UNKNOWN")?.message ?? "", /不能临时自造业务名/);
  assert.match(result.blockingIssues.find((item) => item.code === "OUTPUT_FILE_KEY_UNKNOWN")?.message ?? "", /如果只是文件名不同，请保留上面列出的 key，只修改 path/);
  assert.match(result.blockingIssues.find((item) => item.code === "OUTPUT_FILE_REQUIRED_MISSING")?.message ?? "", /请在 answer\.files 中增加 key="main-report"/);
});

test("validateNodeResultContract explains duplicate file keys with configured key list", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "sql",
    resultKey: "ddl-pack",
    filePathRule: null,
    files: [
      {
        key: "ddl",
        name: "DDL 脚本",
        format: "sql",
        allowedExtensions: [".sql"],
        pathRule: null,
        description: null,
        required: true,
      },
      {
        key: "rollback",
        name: "回滚脚本",
        format: "sql",
        allowedExtensions: [".sql"],
        pathRule: null,
        description: null,
        required: false,
      },
    ],
    requiredFields: [],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "database",
    resultName: "ddl-pack",
    role,
    answer: {
      mode: "file-set",
      files: [
        {
          key: "ddl",
          path: "codeflow-docs/schema.sql",
        },
        {
          key: "ddl",
          path: "codeflow-docs/referral-code.sql",
        },
      ],
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  const duplicateIssue = result.blockingIssues.find((item) => item.code === "OUTPUT_FILE_KEY_DUPLICATED");
  assert.equal(result.accepted, false);
  assert.match(duplicateIssue?.message ?? "", /answer\.files\[1\]\.key="ddl" 与前面的文件 key 重复/);
  assert.match(duplicateIssue?.message ?? "", /当前角色允许的文件 key（交付物编号）：ddl（DDL 脚本，格式 sql，必填，后缀 \.sql）；rollback（回滚脚本，格式 sql，可选，后缀 \.sql）/);
  assert.match(duplicateIssue?.message ?? "", /如果确实要拆成多个交付文件，请先在角色输出配置里新增不同 key/);
});

test("validateNodeResultContract accepts contract files plus dynamic attachments", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "markdown",
    resultKey: "dgn",
    filePathRule: null,
    files: [
      {
        key: "dgn",
        name: "DGN 设计卡",
        format: "markdown",
        allowedExtensions: [".md"],
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [
      {
        key: "verificationSummary",
        label: "验证摘要",
        valueType: "markdown",
        required: true,
      },
    ],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "dgn",
    resultName: "dgn",
    role,
    answer: {
      mode: "file-set",
      files: [
        {
          key: "dgn",
          path: "codeflow-docs/第2期-推荐码生成管理/设计卡/DGN-S02D01-第2期-推荐码生成管理-20260513.md",
          summary: "DGN 主设计卡",
        },
      ],
      attachments: [
        {
          path: "codeflow-docs/代码知识库/数据库设计/AIHUBX_PROMOTION_REFERRAL_CODE.sql",
          summary: "推荐码主表 PostgreSQL DDL 草案。",
          format: "sql",
        },
        {
          key: "audit-ddl",
          path: "codeflow-docs/代码知识库/数据库设计/AIHUBX_PROMOTION_REF_AUDIT.sql",
          summary: "推荐码审计表 PostgreSQL DDL 草案。",
          format: "sql",
        },
      ],
      fields: {
        verificationSummary: "已完成设计自检。",
      },
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedFiles.length, 3);
  assert.equal(result.normalizedFiles[0]?.source, "contract");
  assert.equal(result.normalizedFiles[0]?.fileKey, "dgn");
  assert.equal(result.normalizedFiles[0]?.contractKey, "dgn");
  assert.equal(result.normalizedFiles[1]?.source, "attachment");
  assert.equal(result.normalizedFiles[1]?.fileKey, null);
  assert.equal(result.normalizedFiles[1]?.contractKey, null);
  assert.equal(result.normalizedFiles[1]?.kind, "data");
  assert.equal(result.normalizedFiles[1]?.format, "sql");
  assert.equal(result.normalizedFiles[2]?.source, "attachment");
  assert.equal(result.normalizedFiles[2]?.fileKey, "audit-ddl");
  assert.equal(result.fileResults.every((item) => item.status === "valid"), true);
});

test("validateNodeResultContract normalizes source attachments without weakening contract files", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "markdown",
    resultKey: "ui",
    filePathRule: null,
    files: [
      {
        key: "ui",
        name: "UI 主文档",
        format: "markdown",
        allowedExtensions: [".md"],
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "ui",
    resultName: "ui",
    role,
    answer: {
      mode: "file-set",
      files: [
        {
          key: "ui",
          path: "codeflow-docs/ui.md",
        },
      ],
      attachments: [
        {
          key: "prototype-vue",
          path: "apps/web/src/prototypes/demo/index.vue",
          summary: "原型页面源码",
          format: "text",
        },
        {
          key: "prototype-store",
          path: "apps/web/src/prototypes/demo/store.ts",
          summary: "原型状态源码",
        },
        {
          key: "prototype-style",
          path: "apps/web/src/prototypes/demo/style.scss",
          summary: "原型样式源码",
          format: "text",
        },
      ],
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings[0]?.code, "OUTPUT_ATTACHMENT_KIND_INFERRED");
  assert.equal(result.warnings[1]?.code, "OUTPUT_ATTACHMENT_KIND_INFERRED");
  assert.equal(result.normalizedFiles[0]?.source, "contract");
  assert.equal(result.normalizedFiles[0]?.format, "markdown");
  assert.equal(result.normalizedFiles[1]?.source, "attachment");
  assert.equal(result.normalizedFiles[1]?.kind, "source");
  assert.equal(result.normalizedFiles[2]?.kind, "source");
  assert.equal(result.normalizedFiles[3]?.kind, "source");
  assert.equal(result.fileResults.find((item) => item.fileKey === "prototype-vue")?.status, "warning");
  assert.equal(result.fileResults.find((item) => item.fileKey === "prototype-store")?.status, "valid");
  assert.equal(result.fileResults.find((item) => item.fileKey === "prototype-style")?.status, "warning");
  assert.equal(result.normalizedAnswer.attachments?.[0]?.kind, "source");
  assert.equal(result.normalizedAnswer.attachments?.[0]?.format, "text");
  assert.equal(result.normalizedAnswer.attachments?.[0]?.language, "vue");
  assert.equal(result.normalizedAnswer.attachments?.[1]?.kind, "source");
  assert.equal(result.normalizedAnswer.attachments?.[1]?.language, "typescript");
  assert.equal(result.normalizedAnswer.attachments?.[2]?.kind, "source");
  assert.equal(result.normalizedAnswer.attachments?.[2]?.format, "text");
  assert.equal(result.normalizedAnswer.attachments?.[2]?.language, "scss");
});

test("validateNodeResultContract rejects invalid dynamic attachments", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "markdown",
    resultKey: "dgn",
    filePathRule: null,
    files: [
      {
        key: "dgn",
        name: "DGN 设计卡",
        format: "markdown",
        allowedExtensions: [".md"],
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "dgn",
    resultName: "dgn",
    role,
    answer: {
      mode: "file-set",
      files: [
        {
          key: "dgn",
          path: "codeflow-docs/dgn.md",
        },
      ],
      attachments: [
        {
          key: "ddl",
          path: "codeflow-docs/schema.md",
          format: "sql",
        },
        {
          key: "ddl",
          path: "codeflow-docs/schema-copy.sql",
          format: "sql",
        },
        {
          path: "codeflow-docs/schema.unknown",
        },
      ],
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, false);
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_ATTACHMENT_FORMAT_MISMATCH"));
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_ATTACHMENT_KEY_DUPLICATED"));
  assert.ok(result.blockingIssues.some((item) => item.code === "OUTPUT_ATTACHMENT_KIND_UNKNOWN"));
  assert.equal(result.fileResults.filter((item) => item.source === "attachment" && item.status === "invalid").length, 3);
});

test("validateNodeResultContract reports allowed attachment format values", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file-set",
    format: "markdown",
    resultKey: "dgn",
    filePathRule: null,
    files: [
      {
        key: "dgn",
        name: "DGN 设计卡",
        format: "markdown",
        allowedExtensions: [".md"],
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "dgn",
    resultName: "dgn",
    role,
    answer: {
      mode: "file-set",
      files: [
        {
          key: "dgn",
          path: "codeflow-docs/dgn.md",
        },
      ],
      attachments: [
        {
          path: "evidence/img1.png",
          kind: "image",
          format: "png" as any,
        },
      ],
    },
    nextAction: "continue",
    reviewVerdict: "pass",
  });

  assert.equal(result.accepted, false);
  const issue = result.blockingIssues.find((item) => item.code === "OUTPUT_ATTACHMENT_FORMAT_INVALID");
  assert.match(issue?.message ?? "", /合法值：.*image/);
  assert.match(issue?.message ?? "", /不是文件扩展名/);
  assert.match(issue?.message ?? "", /不要填 png/);
});

test("validateNodeResultContract marks ask_human result as non-consumable decision", () => {
  const role = createRole({
    instructions: "",
    deliveryMode: "file",
    format: "markdown",
    resultKey: "analysis-report",
    filePathRule: null,
    files: [
      {
        key: "main",
        name: "主文档",
        format: "markdown",
        allowedExtensions: null,
        pathRule: null,
        description: null,
        required: true,
      },
    ],
    requiredFields: [
      {
        key: "reviewSummary",
        label: "评审摘要",
        valueType: "text",
        required: true,
      },
    ],
  });

  const result = validateNodeResultContract({
    instanceId: "orch-1" as any,
    nodeId: "analysis",
    resultName: "analysis-report",
    role,
    answer: {
      mode: "text",
      text: "需要用户补充业务目录。",
    },
    nextAction: "ask_human",
    reviewVerdict: "partial",
  });

  assert.equal(result.accepted, true);
  assert.equal(result.completion, "decision");
  assert.equal(result.consumable, false);
  assert.equal(result.normalizedFields.length, 0);
  assert.equal(result.normalizedFiles.length, 0);
});
