import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { KnowledgeBundleDefinition } from "../../packages/shared/src/index.ts";
import { KnowledgeRuntimeService } from "../../apps/desktop/client/src/orchestration/knowledgeRuntimeService.ts";

function withTempWorkspace(run: (workspacePath: string) => Promise<void> | void): Promise<void> {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-kb-runtime-"));
  return Promise.resolve(run(workspacePath)).finally(() => {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
}

test("KnowledgeRuntimeService builds inline knowledge and file or directory references for prompt rendering", async () => {
  await withTempWorkspace(async (workspacePath) => {
    fs.mkdirSync(path.join(workspacePath, "src"), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs", "feature"), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflowai", "codeflowai.json"), JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }), "utf8");
    fs.writeFileSync(path.join(workspacePath, "README.md"), "# demo\nproject overview", "utf8");
    fs.writeFileSync(path.join(workspacePath, "src", "task.ts"), "export function listTasks() { return ['task']; }\n", "utf8");
    fs.writeFileSync(path.join(workspacePath, "codeflow-docs", "feature", "design.md"), "方案正文 design", "utf8");

    const service = new KnowledgeRuntimeService(workspacePath);
    const bundle: KnowledgeBundleDefinition = {
      id: "kb-demo" as any,
      workspaceId: "ws" as any,
      name: "演示知识库",
      scope: "shared",
      description: "mixed bundle",
      sourceRefs: [
        { id: "s1", kind: "manual-text", title: "团队约定", inlineBody: "先写测试，再改实现", enabled: true },
        { id: "s2", kind: "inline-doc", title: "交付说明", inlineBody: "输出要包含修改文件和验证结果", enabled: true },
        { id: "s3", kind: "workspace-file", title: "README", ref: "README.md", enabled: true },
        { id: "s4", kind: "workspace-dir", title: "源码目录", ref: "src", enabled: true },
        { id: "s5", kind: "workbench-doc", title: "方案文档", ref: "feature/design.md", enabled: true },
        { id: "s6", kind: "workbench-dir", title: "工作台目录", ref: "feature", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
    };

    const catalog = service.buildCatalog(bundle);

    assert.equal(catalog.inlineItems.length, 2);
    assert.equal(catalog.runtimeSources.length, 4);
    assert.match(catalog.inlineItems.map((item) => item.bodyText).join("\n"), /先写测试/);
    assert.match(catalog.runtimeSources.map((item) => item.workspaceRelPath).join("\n"), /README\.md/);
    assert.equal(catalog.warnings?.length ?? 0, 0);

    assert.deepEqual(
      catalog.runtimeSources.map((item) => ({
        title: item.title,
        kind: item.sourceKind,
        path: item.workspaceRelPath,
        targetType: item.targetType,
      })),
      [
        { title: "README", kind: "workspace-file", path: "README.md", targetType: "file" },
        { title: "源码目录", kind: "workspace-dir", path: "src", targetType: "directory" },
        { title: "方案文档", kind: "workbench-doc", path: "codeflow-docs/feature/design.md", targetType: "file" },
        { title: "工作台目录", kind: "workbench-dir", path: "codeflow-docs/feature", targetType: "directory" },
      ],
    );
  });
});

test("KnowledgeRuntimeService truncates long inline bodies and reports invalid or missing references", async () => {
  await withTempWorkspace(async (workspacePath) => {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflowai", "codeflowai.json"), JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }), "utf8");
    const service = new KnowledgeRuntimeService(workspacePath);
    const bundle: KnowledgeBundleDefinition = {
      id: "kb-boundary" as any,
      workspaceId: "ws" as any,
      name: "边界知识库",
      scope: "shared",
      description: "",
      sourceRefs: [
        { id: "long", kind: "manual-text", title: "超长正文", inlineBody: "A".repeat(8_000), enabled: true },
        { id: "outside", kind: "workspace-file", title: "越界文件", ref: "../outside.txt", enabled: true },
        { id: "missing", kind: "workbench-dir", title: "缺失目录", ref: "feature", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
    };

    const catalog = service.buildCatalog(bundle);

    assert.equal(catalog.inlineItems.length, 1);
    assert.equal(catalog.inlineItems[0]?.truncated, true);
    assert.ok(catalog.inlineItems[0]?.bodyText.includes("...(已截断)"));
    assert.ok((catalog.warnings ?? []).some((warning) => warning.code === "SOURCE_PATH_INVALID" && warning.sourceId === "outside"));
    assert.ok((catalog.warnings ?? []).some((warning) => warning.code === "SOURCE_NOT_FOUND" && warning.sourceId === "missing"));
  });
});

test("KnowledgeRuntimeService trims inline knowledge for prompt without changing reference sources", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new KnowledgeRuntimeService(workspacePath);
    const selected = service.trimInlineItemsForPrompt([
      {
        bundleId: "kb" as any,
        bundleName: "知识库",
        sourceId: "doc-1",
        sourceKey: "kb:doc-1",
        sourceKind: "manual-text",
        title: "正文一",
        description: null,
        bodyText: "A".repeat(9_000),
        injectedAt: 1,
        contentHash: "hash-1",
        truncated: false,
      },
      {
        bundleId: "kb" as any,
        bundleName: "知识库",
        sourceId: "doc-2",
        sourceKey: "kb:doc-2",
        sourceKind: "inline-doc",
        title: "正文二",
        description: null,
        bodyText: "B".repeat(8_000),
        injectedAt: 1,
        contentHash: "hash-2",
        truncated: false,
      },
    ]);

    assert.equal(selected.length, 2);
    assert.ok(selected[0]?.bodyText.length <= 12_000);
    assert.equal(selected[0]?.truncated, false);
    assert.equal(selected[1]?.truncated, true);
  });
});

test("KnowledgeRuntimeService skips disabled sources and resolves blank directory refs to workspace or workflow root", async () => {
  await withTempWorkspace(async (workspacePath) => {
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs", "feature"), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflowai", "codeflowai.json"), JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }), "utf8");

    const service = new KnowledgeRuntimeService(workspacePath);
    const bundle: KnowledgeBundleDefinition = {
      id: "kb-root" as any,
      workspaceId: "ws" as any,
      name: "根目录知识库",
      scope: "shared",
      description: "",
      sourceRefs: [
        { id: "disabled-inline", kind: "manual-text", title: "停用正文", inlineBody: "不应进入 prompt", enabled: false },
        { id: "empty-inline", kind: "inline-doc", title: "空正文", inlineBody: "   ", enabled: true },
        { id: "workspace-root", kind: "workspace-dir", title: "项目根目录", ref: "", enabled: true },
        { id: "workbench-root", kind: "workbench-dir", title: "工作流文档根目录", ref: "", enabled: true },
      ],
      createdAt: 1,
      updatedAt: 1,
    };

    const catalog = service.buildCatalog(bundle);

    assert.equal(catalog.inlineItems.length, 0);
    assert.deepEqual(
      catalog.runtimeSources.map((item) => ({
        title: item.title,
        kind: item.sourceKind,
        originRef: item.originRef,
        path: item.workspaceRelPath,
        targetType: item.targetType,
      })),
      [
        { title: "项目根目录", kind: "workspace-dir", originRef: ".", path: "", targetType: "directory" },
        { title: "工作流文档根目录", kind: "workbench-dir", originRef: ".", path: "codeflow-docs", targetType: "directory" },
      ],
    );
    assert.ok((catalog.warnings ?? []).some((warning) => warning.code === "SOURCE_EMPTY" && warning.sourceId === "empty-inline"));
    assert.ok(!(catalog.warnings ?? []).some((warning) => warning.sourceId === "disabled-inline"));
  });
});

test("KnowledgeRuntimeService reports unsupported source kinds instead of crashing", async () => {
  await withTempWorkspace(async (workspacePath) => {
    const service = new KnowledgeRuntimeService(workspacePath);
    const bundle: KnowledgeBundleDefinition = {
      id: "kb-unsupported" as any,
      workspaceId: "ws" as any,
      name: "异常知识库",
      scope: "shared",
      description: "",
      sourceRefs: [
        {
          id: "unsupported",
          kind: "remote-url" as any,
          title: "未知来源",
          enabled: true,
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };

    const catalog = service.buildCatalog(bundle);

    assert.equal(catalog.inlineItems.length, 0);
    assert.equal(catalog.runtimeSources.length, 0);
    assert.ok((catalog.warnings ?? []).some((warning) => warning.code === "SOURCE_UNSUPPORTED" && warning.sourceId === "unsupported"));
  });
});

