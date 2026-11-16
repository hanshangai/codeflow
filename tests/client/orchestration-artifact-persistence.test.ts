import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createDefaultRoleExecutionConfig,
  getArtifactRevisionMetadata,
  type Artifact,
  type ArtifactFileEntry,
  type NodeExecutionEnvelope,
  type NodeResultContractValidationResult,
} from "../../packages/shared/src/index.ts";
import { buildDefaultArtifactBaseDir, buildTaskTitlePathSegment } from "../../apps/desktop/client/src/orchestration/artifactPathPolicy.ts";
import {
  ArtifactPersistenceService,
  validateArtifactWorkspaceOutput,
} from "../../apps/desktop/client/src/orchestration/artifactPersistenceService.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

function createHarness(workspacePath: string) {
  const artifacts: Artifact[] = [];
  const artifactFiles: ArtifactFileEntry[] = [];

  return {
    service: new ArtifactPersistenceService({
      workspacePath,
      db: {
        orchArtifacts: {
          create(input: Omit<Artifact, "id" | "createdAt" | "updatedAt">) {
            const artifact: Artifact = {
              ...input,
              id: `artifact-${artifacts.length + 1}` as any,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
            artifacts.push(artifact);
            return artifact;
          },
          get(id: string) {
            return artifacts.find((item) => item.id === id) ?? null;
          },
          updateWorkspace(id: string, input: Partial<Artifact>) {
            const artifact = artifacts.find((item) => item.id === id);
            if (!artifact) return;
            Object.assign(artifact, input, { updatedAt: Date.now() });
          },
        },
        orchArtifactFiles: {
          replaceForArtifact(artifactId: string, entries: Array<Omit<ArtifactFileEntry, "id" | "createdAt" | "updatedAt" | "artifactId">>) {
            for (let index = artifactFiles.length - 1; index >= 0; index -= 1) {
              if (artifactFiles[index].artifactId === artifactId) artifactFiles.splice(index, 1);
            }
            const created = entries.map((entry, index) => ({
              ...entry,
              id: `file-${artifactFiles.length + index + 1}`,
              artifactId: artifactId as any,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            }));
            artifactFiles.push(...created);
            return created;
          },
          listByArtifact(artifactId: string) {
            return artifactFiles.filter((item) => item.artifactId === artifactId);
          },
          updatePublishedPaths(
            artifactId: string,
            entries: Array<Pick<ArtifactFileEntry, "id" | "publishedPath" | "status"> & { stagingPath?: string | null }>,
          ) {
            for (const entry of entries) {
              const file = artifactFiles.find((item) => item.artifactId === artifactId && item.id === entry.id);
              if (file) {
                file.publishedPath = entry.publishedPath ?? null;
                if ("stagingPath" in entry) {
                  file.stagingPath = entry.stagingPath ?? null;
                }
                file.status = entry.status;
                file.updatedAt = Date.now();
              }
            }
          },
          updateStatusByArtifact(artifactId: string, status: ArtifactFileEntry["status"]) {
            for (const file of artifactFiles) {
              if (file.artifactId === artifactId) {
                file.status = status;
                file.updatedAt = Date.now();
              }
            }
          },
        },
      } as any,
    }),
    artifacts,
    artifactFiles,
  };
}

test("ArtifactPersistenceService dual-writes file-set artifacts and can publish them", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-"));
  try {
    const { service, artifacts, artifactFiles } = createHarness(workspacePath);
    const envelope: NodeExecutionEnvelope = {
      mode: "file-set",
      files: [
        { path: "src/new.ts", content: "export const answer = 42;\n", summary: "新增源码" },
        { path: "tests/new.test.ts", content: "console.log('ok');\n", summary: "新增测试" },
      ],
      summary: "写入两个文件",
      changedFiles: ["src/new.ts", "tests/new.test.ts"],
    };

    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "impl",
      nodeLabel: "开发实现",
      kind: "code/patch",
      schemaRef: null,
      version: 1,
      threadId: "thread-1",
      roleId: "role-dev",
      node: {
        id: "impl",
        type: "role",
        roleId: "role-dev" as any,
        label: "开发实现",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope,
    });

    assert.equal(artifact.persistenceMode, "dual-write");
    assert.equal(artifact.workspaceStatus, "staging");
    assert.equal(artifact.stagingPath, null);
    assert.equal(artifact.publishedPath, "codeflowai/artifacts/orch-1/impl");
    assert.equal(artifactFiles.length, 2);
    assert.equal(artifactFiles[0].stagingPath, null);
    assert.ok(fs.existsSync(path.join(workspacePath, artifactFiles[0].publishedPath ?? "")));

    const published = service.approveArtifact(artifact.id);
    assert.equal(published?.status, "approved");
    assert.equal(published?.workspaceStatus, "published");
    assert.equal(published?.stagingPath, null);
    assert.equal(artifactFiles[0].stagingPath, null);
    assert.ok(fs.existsSync(path.join(workspacePath, artifactFiles[0].publishedPath ?? "")));
    assert.doesNotMatch(artifactFiles[0].publishedPath ?? "", /\/published\//);

    const rejected = service.discardArtifact(artifact.id);
    assert.equal(rejected?.status, "rejected");
    assert.equal(rejected?.workspaceStatus, "discarded");
    assert.ok(fs.existsSync(path.join(workspacePath, artifactFiles[0].publishedPath ?? "")));
    assert.equal(artifacts.length, 1);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService keeps a single visible published path and lets DB retain versions", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-versioned-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);
    const node = {
      id: "impl",
      type: "role" as const,
      roleId: "role-dev" as any,
      label: "开发实现",
      position: { x: 0, y: 0 },
      outputArtifactMode: "file" as const,
      outputWritePolicy: {
        persistenceMode: "dual-write" as const,
        overwritePolicy: "create-versioned-copy" as const,
        baseDir: "codeflowai/custom-output",
      },
    };
    const firstArtifact = service.persist({
      instanceId: "orch-1",
      nodeId: "impl",
      nodeLabel: "开发实现",
      kind: "code/patch",
      schemaRef: null,
      version: 1,
      threadId: "thread-1",
      roleId: "role-dev",
      node,
      envelope: {
        mode: "file",
        file: { path: "src/index.ts", content: "export const version = 1;\n" },
      },
    });
    service.approveArtifact(firstArtifact.id);

    const secondArtifact = service.persist({
      instanceId: "orch-1",
      nodeId: "impl",
      nodeLabel: "开发实现",
      kind: "code/patch",
      schemaRef: null,
      version: 2,
      threadId: "thread-2",
      roleId: "role-dev",
      node,
      envelope: {
        mode: "file",
        file: { path: "src/index.ts", content: "export const version = 2;\n" },
      },
    });
    service.approveArtifact(secondArtifact.id);

    const publishedPaths = artifactFiles
      .filter((entry) => entry.status === "published")
      .map((entry) => entry.publishedPath)
      .filter((value): value is string => Boolean(value))
      .sort();
    assert.equal(publishedPaths.length, 2);
    assert.equal(new Set(publishedPaths).size, 1);
    assert.match(publishedPaths[0], /codeflowai\/custom-output\/src\/index\.ts$/);
    assert.ok(fs.existsSync(path.join(workspacePath, publishedPaths[0])));
    assert.equal(
      fs.readFileSync(path.join(workspacePath, publishedPaths[0]), "utf8"),
      "export const version = 2;\n",
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService stores file artifact snapshots from the actual workspace file after overwrite", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-overwrite-"));
  try {
    const targetPath = path.join(workspacePath, "codeflowai", "delivery", "result.md");
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "old content\n", "utf8");

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "delivery",
      nodeLabel: "交付整理",
      kind: "delivery/final",
      schemaRef: null,
      version: 2,
      threadId: "thread-2",
      roleId: "role-delivery",
      node: {
        id: "delivery",
        type: "role",
        roleId: "role-delivery" as any,
        label: "交付整理",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file",
        outputWritePolicy: {
          persistenceMode: "dual-write",
          overwritePolicy: "overwrite",
          baseDir: "codeflowai/delivery",
        },
      },
      envelope: {
        mode: "file",
        file: { path: "result.md", content: "new final content\n" },
      },
    });

    const workspaceContent = fs.readFileSync(targetPath, "utf8");
    const persistedEnvelope = JSON.parse(artifact.contentJson) as NodeExecutionEnvelope & {
      file?: { content?: string | null };
    };
    const fileEntry = artifactFiles.find((entry) => entry.artifactId === artifact.id) ?? null;

    assert.equal(workspaceContent, "new final content\n");
    assert.equal(persistedEnvelope.file?.content, workspaceContent);
    assert.equal(fileEntry?.sizeBytes, Buffer.byteLength(workspaceContent, "utf8"));
    assert.equal(fileEntry?.publishedPath, "codeflowai/delivery/result.md");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService reject policy blocks collisions in final workspace path", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-reject-"));
  try {
    const publishedPath = path.join(workspacePath, "codeflowai", "reject-output", "result.md");
    fs.mkdirSync(path.dirname(publishedPath), { recursive: true });
    fs.writeFileSync(publishedPath, "already exists\n", "utf8");

    const { service } = createHarness(workspacePath);
    assert.throws(() =>
      service.approveArtifact(service.persist({
        instanceId: "orch-1",
        nodeId: "analysis",
        nodeLabel: "需求分析",
        kind: "analysis/report",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-analyst",
        node: {
          id: "analysis",
          type: "role",
          roleId: "role-analyst" as any,
          label: "需求分析",
          position: { x: 0, y: 0 },
          outputArtifactMode: "text",
          outputWritePolicy: {
            persistenceMode: "dual-write",
            overwritePolicy: "reject",
            baseDir: "codeflowai/reject-output",
          },
        },
        envelope: {
          mode: "text",
          text: "新的分析结果",
        },
      }).id),
    /目标已存在/);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService supports db-only and workspace-only text outputs", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-modes-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);

    const dbOnly = service.persist({
      instanceId: "orch-1",
      nodeId: "analysis",
      nodeLabel: "需求分析",
      kind: "analysis/report",
      schemaRef: null,
      version: 1,
      threadId: "thread-analysis",
      roleId: "role-analysis",
      node: {
        id: "analysis",
        type: "role",
        roleId: "role-analysis" as any,
        label: "需求分析",
        position: { x: 0, y: 0 },
        outputArtifactMode: "text",
      },
      envelope: {
        mode: "text",
        text: "仅写 DB 的分析报告",
      },
    });
    assert.equal(dbOnly.persistenceMode, "db-only");
    assert.equal(dbOnly.workspaceStatus, "none");
    assert.equal(artifactFiles.length, 0);

    const workspaceOnly = service.persist({
      instanceId: "orch-1",
      nodeId: "report",
      nodeLabel: "结果整理",
      kind: "report/final",
      schemaRef: null,
      version: 1,
      threadId: "thread-report",
      roleId: "role-report",
      node: {
        id: "report",
        type: "role",
        roleId: "role-report" as any,
        label: "结果整理",
        position: { x: 0, y: 0 },
        outputArtifactMode: "text",
        outputWritePolicy: {
          persistenceMode: "workspace-only",
          overwritePolicy: "create-versioned-copy",
          baseDir: "codeflowai/workspace-only-output",
        },
      },
      envelope: {
        mode: "text",
        text: "需要发布到工作区的结果正文",
      },
    });

    assert.equal(workspaceOnly.persistenceMode, "workspace-only");
    assert.equal(workspaceOnly.workspaceStatus, "staging");
    assert.equal(workspaceOnly.stagingPath, null);
    const stagedFile = artifactFiles.find((entry) => entry.artifactId === workspaceOnly.id);
    assert.equal(stagedFile?.stagingPath, null);
    assert.equal(stagedFile?.publishedPath, "codeflowai/workspace-only-output/result.md");
    assert.ok(fs.existsSync(path.join(workspacePath, stagedFile?.publishedPath ?? "")));

    const published = service.approveArtifact(workspaceOnly.id);
    assert.equal(published?.workspaceStatus, "published");
    const publishedFile = artifactFiles.find((entry) => entry.artifactId === workspaceOnly.id);
    assert.ok(publishedFile?.publishedPath);
    assert.ok(fs.existsSync(path.join(workspacePath, publishedFile?.publishedPath ?? "")));
    assert.equal(publishedFile?.publishedPath, "codeflowai/workspace-only-output/result.md");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService indexes db-only attachments for downstream refs", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-db-attachments-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);
    const attachmentPath = "codeflow-docs/supporting.sql";
    fs.mkdirSync(path.join(workspacePath, path.dirname(attachmentPath)), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, attachmentPath), "CREATE TABLE demo(id bigint);\n", "utf8");

    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "analysis",
      nodeLabel: "需求分析",
      kind: "analysis/report",
      schemaRef: null,
      version: 1,
      threadId: "thread-analysis",
      roleId: "role-analysis",
      node: {
        id: "analysis",
        type: "role",
        roleId: "role-analysis" as any,
        label: "需求分析",
        position: { x: 0, y: 0 },
        outputArtifactMode: "text",
      },
      envelope: {
        mode: "text",
        text: "正文只写 DB",
        attachments: [
          { key: "ddl", path: attachmentPath, summary: "补充 DDL", format: "sql" },
        ],
      },
    });

    assert.equal(artifact.persistenceMode, "db-only");
    assert.equal(artifact.workspaceStatus, "staging");
    assert.equal(artifactFiles.length, 1);
    assert.equal(artifactFiles[0]?.fileRole, "attachment");
    assert.equal(artifactFiles[0]?.fileKey, "ddl");
    assert.equal(artifactFiles[0]?.publishedPath, attachmentPath);
    assert.equal(artifact.manifest?.files?.[0]?.fileRole, "attachment");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService supports structured outputs in db-only and workspace-only modes", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-structured-"));
  try {
    const { service, artifacts, artifactFiles } = createHarness(workspacePath);

    const dbOnly = service.persist({
      instanceId: "orch-1",
      nodeId: "design",
      nodeLabel: "方案设计",
      kind: "solution-plan",
      schemaRef: null,
      version: 1,
      threadId: "thread-design",
      roleId: "role-design",
      node: {
        id: "design",
        type: "role",
        roleId: "role-design" as any,
        label: "方案设计",
        position: { x: 0, y: 0 },
        outputArtifactMode: "structured",
      },
      envelope: {
        mode: "structured",
        data: { files: ["src/index.ts"], risks: ["待验证"] },
        summary: "结构化方案摘要",
        changedFiles: ["src/index.ts"],
      },
    });

    assert.equal(dbOnly.persistenceMode, "db-only");
    assert.equal(dbOnly.workspaceStatus, "none");
    assert.equal(dbOnly.payloadMode, "structured");
    assert.equal(dbOnly.manifest?.summary, "结构化方案摘要");
    assert.deepEqual(dbOnly.manifest?.changedFiles, ["src/index.ts"]);
    assert.equal(artifactFiles.length, 0);

    const workspaceOnly = service.persist({
      instanceId: "orch-1",
      nodeId: "verification",
      nodeLabel: "测试验证",
      kind: "verification-report",
      schemaRef: null,
      version: 1,
      threadId: "thread-verification",
      roleId: "role-verification",
      node: {
        id: "verification",
        type: "role",
        roleId: "role-verification" as any,
        label: "测试验证",
        position: { x: 0, y: 0 },
        outputArtifactMode: "structured",
        outputWritePolicy: {
          persistenceMode: "workspace-only",
          overwritePolicy: "create-versioned-copy",
          baseDir: "codeflowai/structured-output",
        },
      },
      envelope: {
        mode: "structured",
        data: { passed: true, checks: ["smoke", "e2e"] },
        changedFiles: [],
      },
    });

    assert.equal(workspaceOnly.persistenceMode, "workspace-only");
    assert.equal(workspaceOnly.workspaceStatus, "staging");
    const stagedFile = artifactFiles.find((entry) => entry.artifactId === workspaceOnly.id);
    assert.equal(stagedFile?.stagingPath, null);
    assert.equal(stagedFile?.publishedPath, "codeflowai/structured-output/result.json");
    assert.ok(fs.existsSync(path.join(workspacePath, stagedFile?.publishedPath ?? "")));
    const stagedJson = JSON.parse(fs.readFileSync(path.join(workspacePath, stagedFile?.publishedPath ?? ""), "utf8"));
    assert.deepEqual(stagedJson, { passed: true, checks: ["smoke", "e2e"] });

    const published = service.approveArtifact(workspaceOnly.id);
    assert.equal(published?.workspaceStatus, "published");
    const publishedFile = artifactFiles.find((entry) => entry.artifactId === workspaceOnly.id);
    assert.equal(publishedFile?.publishedPath, "codeflowai/structured-output/result.json");
    assert.ok(fs.existsSync(path.join(workspacePath, publishedFile?.publishedPath ?? "")));

    assert.equal(artifacts.length, 2);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("buildDefaultArtifactBaseDir nests outputs under workflow docs root, feature, intake, and role name", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifact-policy-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "项目文档" } }),
      "utf8",
    );

    const baseDir = buildDefaultArtifactBaseDir({
      workspacePath,
      intake: {
        id: "12345678-abcd-efgh-ijkl" as any,
        workspaceId: "ws" as any,
        triggerMode: "manual",
        taskType: "feature",
        title: "首页改版与导航整理",
        goal: "首页改版与导航整理",
        createdAt: 1,
        updatedAt: 1,
      },
      workflow: {
        id: "wf" as any,
        workspaceId: "ws" as any,
        family: "feature-dev",
        name: "功能流程",
        version: 1,
        description: "",
        workflowKnowledgeBundleIds: [],
        nodes: [
          { id: "design", type: "role", roleId: "role-design" as any, label: "方案设计", position: { x: 0, y: 0 } },
        ],
        edges: [],
      },
      node: { id: "design", type: "role", roleId: "role-design" as any, label: "方案设计", position: { x: 0, y: 0 } },
      role: {
        id: "role-design" as any,
        workspaceId: "ws" as any,
        name: "方案设计师",
        description: "",
        responsibility: "",
        systemPrompt: "",
        inputDefinition: { instructions: "", requiredFields: [] },
        outputDefinition: { instructions: "", deliveryMode: "direct", format: "markdown", resultKey: null, filePathRule: null, requiredFields: [] },
        gateCriteria: [],
        executionConfig: createDefaultRoleExecutionConfig("claude"),
        defaultKnowledgeBundleIds: [],
        toolRefs: [],
        kind: "custom",
        createdAt: 1,
        updatedAt: 1,
      },
    });

    assert.equal(baseDir, "项目文档/功能/首页改版与导航整理--12345678/方案设计师");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("buildTaskTitlePathSegment keeps requirement title traceable in feature paths", () => {
  const segment = buildTaskTitlePathSegment({
    id: "ba33615e-e9b7-4508-97b6-a7ed00197a3e" as any,
    workspaceId: "ws" as any,
    triggerMode: "manual",
    taskType: "feature",
    title: "共享工作区一期：创建、邀请、Web 远程接入 host 与资料共享",
    goal: "实现共享工作区的核心闭环",
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(segment, "共享工作区一期：创建、邀请、Web-远程接入-host-与资料共享");
});

test("buildTaskTitlePathSegment sanitizes path-only special cases without changing the title", () => {
  const unsafeSegment = buildTaskTitlePathSegment({
    id: "intake-unsafe" as any,
    workspaceId: "ws" as any,
    triggerMode: "manual",
    taskType: "feature",
    title: "CON",
    goal: "保留需求标题原文，只安全化路径片段",
    createdAt: 1,
    updatedAt: 1,
  });
  const symbolSegment = buildTaskTitlePathSegment({
    id: "intake-symbol" as any,
    workspaceId: "ws" as any,
    triggerMode: "manual",
    taskType: "feature",
    title: "共享<工作区>: 远程/接入? *资料.",
    goal: "替换路径非法字符",
    createdAt: 1,
    updatedAt: 1,
  });

  assert.equal(unsafeSegment, "CON-safe");
  assert.equal(symbolSegment, "共享-工作区-远程-接入-资料");
});

test("buildDefaultArtifactBaseDir falls back to codeflow-docs when codeflowai.json is missing", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifact-policy-default-"));
  try {
    const baseDir = buildDefaultArtifactBaseDir({
      workspacePath,
      intake: {
        id: "12345678-abcd-efgh-ijkl" as any,
        workspaceId: "ws" as any,
        triggerMode: "manual",
        taskType: "feature",
        title: "首页改版与导航整理",
        goal: "首页改版与导航整理",
        createdAt: 1,
        updatedAt: 1,
      },
      workflow: {
        id: "wf" as any,
        workspaceId: "ws" as any,
        family: "feature-dev",
        name: "功能流程",
        version: 1,
        description: "",
        workflowKnowledgeBundleIds: [],
        nodes: [{ id: "design", type: "role", roleId: "role-design" as any, label: "设计", position: { x: 0, y: 0 } }],
        edges: [],
      },
      node: { id: "design", type: "role", roleId: "role-design" as any, label: "设计", position: { x: 0, y: 0 } },
      role: {
        id: "role-design" as any, workspaceId: "ws" as any, name: "设计师", description: "", systemPrompt: "",
        inputDefinition: { instructions: "", requiredFields: [] },
        outputDefinition: { instructions: "", deliveryMode: "direct", format: "markdown", requiredFields: [] },
        gateCriteria: [], executionConfig: createDefaultRoleExecutionConfig("codex"),
        defaultKnowledgeBundleIds: [], toolRefs: [], kind: "custom", createdAt: 1, updatedAt: 1,
      },
    });

    const config = JSON.parse(fs.readFileSync(path.join(workspacePath, ".codeflowai", "codeflowai.json"), "utf8")) as { paths?: { workflowDocsRoot?: string } };
    assert.equal(config.paths?.workflowDocsRoot, "codeflow-docs");
    assert.match(baseDir, /^codeflow-docs\/功能\/首页改版与导航整理--12345678\/设计师$/);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService uses provided defaultBaseDir when node does not override baseDir", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-default-dir-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "analysis",
      nodeLabel: "需求分析",
      kind: "analysis/report",
      schemaRef: null,
      version: 1,
      threadId: "thread-analysis",
      roleId: "role-analysis",
      node: {
        id: "analysis",
        type: "role",
        roleId: "role-analysis" as any,
        label: "需求分析",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file",
      },
      envelope: {
        mode: "file",
        file: {
          path: "report.md",
          content: "默认目录测试",
        },
      },
      defaultBaseDir: "项目文档/功能/需求一--12345678/需求分析师",
    });
    service.approveArtifact(artifact.id);

    const file = artifactFiles.find((entry) => entry.artifactId === artifact.id);
    assert.equal(file?.stagingPath, null);
    assert.equal(file?.publishedPath, "项目文档/功能/需求一--12345678/需求分析师/report.md");
    assert.ok(fs.existsSync(path.join(workspacePath, file?.publishedPath ?? "")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService strips duplicated baseDir prefix from file outputs", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-path-normalize-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);
    const node = {
      id: "analysis",
      type: "role" as const,
      roleId: "role-analysis" as any,
      label: "分析",
      position: { x: 0, y: 0 },
      outputArtifactMode: "file" as const,
      outputWritePolicy: {
        persistenceMode: "dual-write" as const,
        overwritePolicy: "create-versioned-copy" as const,
        baseDir: "codeflowai/e2e-output",
      },
    };

    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "analysis",
      nodeLabel: "分析",
      kind: "analysis/report",
      schemaRef: null,
      version: 1,
      threadId: "thread-analysis",
      roleId: "role-analysis",
      node,
      envelope: {
        mode: "file",
        file: {
          path: "codeflowai/e2e-output/report.md",
          content: "# report\n",
        },
      },
    });
    service.approveArtifact(artifact.id);

    const file = artifactFiles.find((entry) => entry.artifactId === artifact.id);
    assert.equal(file?.stagingPath, null);
    assert.equal(file?.publishedPath, "codeflowai/e2e-output/report.md");
    assert.ok(fs.existsSync(path.join(workspacePath, file?.publishedPath ?? "")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService prefers rooted workflow-doc file paths over generated defaultBaseDir", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-default-rooted-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }),
      "utf8",
    );

    const { service, artifactFiles } = createHarness(workspacePath);
    const publishedPath = "codeflow-docs/功能/组合测试-优先级筛选与导出增强--20260325-223414/需求分析师/analysis-report.md";
    fs.mkdirSync(path.join(workspacePath, path.dirname(publishedPath)), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, publishedPath), "# analysis\n", "utf8");
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "analysis",
      nodeLabel: "需求分析",
      kind: "analysis-report",
      schemaRef: null,
      version: 1,
      threadId: "thread-analysis",
      roleId: "role-analysis",
      node: {
        id: "analysis",
        type: "role",
        roleId: "role-analysis" as any,
        label: "需求分析",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file",
      },
      envelope: {
        mode: "file",
        file: {
          path: publishedPath,
          summary: "分析文档",
        },
      },
      defaultBaseDir: "codeflow-docs/功能/组合测试：优先级筛选与导出增强-20260325-223414--7be836d9/组合测试需求分析师",
    });
    service.approveArtifact(artifact.id);

    const file = artifactFiles.find((entry) => entry.artifactId === artifact.id);
    assert.equal(artifact.workspaceBaseDir, "codeflow-docs/功能/组合测试-优先级筛选与导出增强--20260325-223414/需求分析师");
    assert.equal(file?.stagingPath, null);
    assert.equal(file?.publishedPath, publishedPath);
    assert.ok(fs.existsSync(path.join(workspacePath, file?.publishedPath ?? "")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService keeps workflow-doc-root file-set outputs at workflowDocsRoot without duplicating the root segment", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-rooted-fileset-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }),
      "utf8",
    );

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "role",
      nodeLabel: "基线工程师（INIT）",
      kind: "baseline-docs",
      schemaRef: null,
      version: 1,
      threadId: "thread-init",
      roleId: "role-init",
      node: {
        id: "role",
        type: "role",
        roleId: "role-init" as any,
        label: "基线工程师（INIT）",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope: {
        mode: "file-set",
        files: [
          {
            path: "codeflow-docs/代码知识库/全局架构/架构总览.md",
            content: "# 架构总览\n",
            summary: "架构总览",
          },
          {
            path: "codeflow-docs/代码知识库/数据库设计/数据库设计规范.md",
            content: "# 数据库设计规范\n",
            summary: "数据库设计规范",
          },
        ],
      },
      defaultBaseDir: "codeflow-docs/功能/aidt-code-项目基线初始化--85a9ce3d/基线工程师（INIT）",
    });
    service.approveArtifact(artifact.id);

    const files = artifactFiles
      .filter((entry) => entry.artifactId === artifact.id)
      .sort((a, b) => String(a.relPath).localeCompare(String(b.relPath), "zh-CN"));

    assert.equal(artifact.workspaceBaseDir, "codeflow-docs/代码知识库");
    assert.deepEqual(
      files.map((entry) => entry.stagingPath),
      [
        null,
        null,
      ],
    );
    assert.deepEqual(
      files.map((entry) => entry.publishedPath),
      [
        "codeflow-docs/代码知识库/全局架构/架构总览.md",
        "codeflow-docs/代码知识库/数据库设计/数据库设计规范.md",
      ],
    );
    assert.ok(fs.existsSync(path.join(workspacePath, "codeflow-docs/代码知识库/全局架构/架构总览.md")));
    assert.ok(fs.existsSync(path.join(workspacePath, "codeflow-docs/代码知识库/数据库设计/数据库设计规范.md")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService stores contract metadata for file outputs", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifact-contract-"));
  try {
    const { service, artifacts, artifactFiles } = createHarness(workspacePath);
    const envelope: NodeExecutionEnvelope = {
      mode: "file-set",
      files: [
        { key: "main-report", path: "docs/report.md", content: "# 报告\n", summary: "主报告" },
        { key: "patch-preview", path: "docs/changes.diff", content: "diff --git a/a b/a\n", summary: "补丁预览" },
      ],
      attachments: [
        { path: "docs/schema.sql", content: "CREATE TABLE demo(id bigint);\n", summary: "补充 DDL", format: "sql" },
      ],
      summary: "交付两个文件",
      changedFiles: ["docs/report.md", "docs/changes.diff", "docs/schema.sql"],
    };
    const contractValidation: NodeResultContractValidationResult = {
      accepted: true,
      completion: "complete",
      consumable: true,
      contractVersion: "node-result-contract/v1",
      normalizedAnswer: envelope,
      normalizedFields: [],
      normalizedFiles: [
        {
          artifactId: "" as any,
          fileKey: "main-report",
          source: "contract",
          contractKey: "main-report",
          relPath: "docs/report.md",
          workspacePath: "docs/report.md",
          summary: "主报告",
          format: "markdown",
          readRequired: true,
        },
        {
          artifactId: "" as any,
          fileKey: "patch-preview",
          source: "contract",
          contractKey: "patch-preview",
          relPath: "docs/changes.diff",
          workspacePath: "docs/changes.diff",
          summary: "补丁预览",
          format: "text",
          readRequired: true,
        },
        {
          artifactId: "" as any,
          fileKey: null,
          source: "attachment",
          contractKey: null,
          relPath: "docs/schema.sql",
          workspacePath: "docs/schema.sql",
          summary: "补充 DDL",
          format: "sql",
          readRequired: true,
        },
      ],
      fieldResults: [],
      fileResults: [
        { fileKey: "main-report", source: "contract", path: "docs/report.md", status: "valid" },
        { fileKey: "patch-preview", source: "contract", path: "docs/changes.diff", status: "valid" },
        { fileKey: null, source: "attachment", path: "docs/schema.sql", status: "valid" },
      ],
      blockingIssues: [],
      recoverableIssues: [],
      warnings: [],
    };

    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "delivery",
      nodeLabel: "交付整理",
      kind: "delivery-pack",
      schemaRef: null,
      version: 1,
      threadId: "thread-1",
      roleId: "role-delivery",
      node: {
        id: "delivery",
        type: "role",
        roleId: "role-delivery" as any,
        label: "交付整理",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope,
      contractValidation,
    });

    assert.equal(artifacts.length, 1);
    assert.equal(artifactFiles.length, 3);
    assert.equal(artifactFiles[0]?.fileKey, "main-report");
    assert.equal(artifactFiles[0]?.fileRole, "contract");
    assert.equal(artifactFiles[0]?.format, "markdown");
    assert.equal(artifactFiles[0]?.contractKey, "main-report");
    assert.equal(artifactFiles[0]?.validationStatus, "valid");
    assert.equal(artifactFiles[1]?.fileKey, "patch-preview");
    assert.equal(artifactFiles[1]?.fileRole, "contract");
    assert.equal(artifactFiles[1]?.format, "text");
    assert.equal(artifactFiles[2]?.fileKey, null);
    assert.equal(artifactFiles[2]?.fileRole, "attachment");
    assert.equal(artifactFiles[2]?.format, "sql");
    assert.equal(artifactFiles[2]?.contractKey, null);
    assert.equal(artifactFiles[2]?.summary, "补充 DDL");
    assert.equal(artifact.manifest?.files?.[0]?.fileKey, "main-report");
    assert.equal(artifact.manifest?.files?.[0]?.fileRole, "contract");
    assert.equal(artifact.manifest?.files?.[0]?.format, "markdown");
    assert.equal(artifact.manifest?.files?.[1]?.fileKey, "patch-preview");
    assert.equal(artifact.manifest?.files?.[1]?.summary, "补丁预览");
    assert.equal(artifact.manifest?.files?.[2]?.fileRole, "attachment");
    assert.equal(artifact.manifest?.files?.[2]?.contractKey, null);
    assert.equal(artifact.manifest?.files?.[2]?.summary, "补充 DDL");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService preserves mixed workspace-rooted file-set outputs instead of nesting them under artifact archive directories", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-mixed-rooted-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "hsurp-platform-web"), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs"), { recursive: true });

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "ui",
      nodeLabel: "UI/UX设计师（UI）",
      kind: "ui-spec",
      schemaRef: null,
      version: 1,
      threadId: "thread-ui",
      roleId: "role-ui",
      node: {
        id: "ui",
        type: "role",
        roleId: "role-ui" as any,
        label: "UI/UX设计师（UI）",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope: {
        mode: "file-set",
        files: [
          {
            path: "hsurp-platform-web/src/biz/urp3/prototypes/init/index.vue",
            content: "<template><div>prototype</div></template>\n",
            summary: "项目内原型页",
          },
          {
            path: "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414.md",
            content: "# UI 文档\n",
            summary: "UI 主文档",
          },
        ],
      },
      defaultBaseDir: "codeflow-docs/功能/前端原型初始化（基于原项目）--c198656c/UI-UX设计师（UI）",
    });
    service.approveArtifact(artifact.id);

    const publishedPaths = artifactFiles
      .filter((entry) => entry.artifactId === artifact.id)
      .map((entry) => entry.publishedPath);

    assert.deepEqual(publishedPaths, [
      "hsurp-platform-web/src/biz/urp3/prototypes/init/index.vue",
      "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414.md",
    ]);
    assert.equal(artifact.publishedPath, null);
    assert.equal(artifact.workspaceBaseDir, "");
    assert.ok(fs.existsSync(path.join(workspacePath, "hsurp-platform-web/src/biz/urp3/prototypes/init/index.vue")));
    assert.ok(fs.existsSync(path.join(workspacePath, "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414.md")));
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService keeps workflow-doc-root files direct in mixed outputs even before workflowDocsRoot exists on disk", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-mixed-rooted-configured-docs-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, "hsurp-platform-web"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }),
      "utf8",
    );

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "ui",
      nodeLabel: "UI/UX设计师（UI）",
      kind: "ui-spec",
      schemaRef: null,
      version: 1,
      threadId: "thread-ui",
      roleId: "role-ui",
      node: {
        id: "ui",
        type: "role",
        roleId: "role-ui" as any,
        label: "UI/UX设计师（UI）",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope: {
        mode: "file-set",
        files: [
          {
            path: "hsurp-platform-web/src/biz/urp3/prototypes/init/index.vue",
            content: "<template><div>prototype</div></template>\n",
            summary: "项目内原型页",
          },
          {
            path: "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414.md",
            content: "# UI 文档\n",
            summary: "UI 主文档",
          },
        ],
      },
      defaultBaseDir: "codeflow-docs/功能/前端原型初始化（基于原项目）--c198656c/UI-UX设计师（UI）",
    });
    service.approveArtifact(artifact.id);

    const publishedPaths = artifactFiles
      .filter((entry) => entry.artifactId === artifact.id)
      .map((entry) => entry.publishedPath);

    assert.deepEqual(publishedPaths, [
      "hsurp-platform-web/src/biz/urp3/prototypes/init/index.vue",
      "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414.md",
    ]);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService does not treat sibling paths as rooted when workflowDocsRoot has multiple segments", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-nested-doc-root-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "docs/workflow" } }),
      "utf8",
    );

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "prd",
      nodeLabel: "需求分析",
      kind: "prd-doc",
      schemaRef: null,
      version: 1,
      threadId: "thread-prd",
      roleId: "role-prd",
      node: {
        id: "prd",
        type: "role",
        roleId: "role-prd" as any,
        label: "需求分析",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file",
      },
      envelope: {
        mode: "file",
        file: {
          path: "docs/other/summary.md",
          content: "# summary\n",
        },
      },
      defaultBaseDir: "docs/workflow/功能/多段根目录需求--12345678/需求分析",
    });
    service.approveArtifact(artifact.id);

    const file = artifactFiles.find((entry) => entry.artifactId === artifact.id);
    assert.equal(artifact.workspaceBaseDir, "docs/workflow/功能/多段根目录需求--12345678/需求分析");
    assert.equal(
      file?.publishedPath,
      "docs/workflow/功能/多段根目录需求--12345678/需求分析/docs/other/summary.md",
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService preserves binary workspace-backed image files without UTF-8 corruption", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-binary-image-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflowai"), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, "codeflowai", "codeflowai.json"),
      JSON.stringify({ paths: { workflowDocsRoot: "codeflow-docs" } }),
      "utf8",
    );

    const imageRelPath = "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414/screenshots/06-dialog-routing.png";
    const imageAbsPath = path.join(workspacePath, imageRelPath);
    const imageBuffer = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8/5+hHgAHggJ/P3VvWQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.mkdirSync(path.dirname(imageAbsPath), { recursive: true });
    fs.writeFileSync(imageAbsPath, imageBuffer);

    const { service, artifactFiles } = createHarness(workspacePath);
    const artifact = service.persist({
      instanceId: "orch-1",
      nodeId: "ui",
      nodeLabel: "UI/UX设计师（UI）",
      kind: "ui-spec",
      schemaRef: null,
      version: 1,
      threadId: "thread-ui",
      roleId: "role-ui",
      node: {
        id: "ui",
        type: "role",
        roleId: "role-ui" as any,
        label: "UI/UX设计师（UI）",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope: {
        mode: "file-set",
        files: [
          {
            path: imageRelPath,
            summary: "截图",
          },
        ],
      },
      defaultBaseDir: "codeflow-docs/功能/前端原型初始化（基于原项目）--c198656c/UI-UX设计师（UI）",
    });
    service.approveArtifact(artifact.id);

    const parsed = JSON.parse(artifact.contentJson) as NodeExecutionEnvelope & {
      files?: Array<{ content?: string | null }>;
    };
    const file = artifactFiles.find((entry) => entry.artifactId === artifact.id);

    assert.equal(file?.publishedPath, imageRelPath);
    assert.equal(file?.sizeBytes, imageBuffer.byteLength);
    assert.deepEqual(fs.readFileSync(imageAbsPath), imageBuffer);
    assert.equal(parsed.files?.[0]?.content ?? null, null);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService rejects duplicate file-set paths after normalization", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-duplicate-"));
  try {
    const { service } = createHarness(workspacePath);

    assert.throws(() =>
      service.persist({
        instanceId: "orch-1",
        nodeId: "impl",
        nodeLabel: "开发实现",
        kind: "code/patch",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-dev",
        node: {
          id: "impl",
          type: "role",
          roleId: "role-dev" as any,
          label: "开发实现",
          position: { x: 0, y: 0 },
          outputArtifactMode: "file-set",
          outputWritePolicy: {
            persistenceMode: "dual-write",
            baseDir: "codeflowai/e2e-output",
          },
        },
        envelope: {
          mode: "file-set",
          files: [
            { path: "report.md", content: "A" },
            { path: "codeflowai/e2e-output/report.md", content: "B" },
          ],
        },
      }),
    /工件输出包含重复路径/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService rejects duplicate paths between contract files and attachments", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-attachment-duplicate-"));
  try {
    const { service } = createHarness(workspacePath);

    assert.throws(() =>
      service.persist({
        instanceId: "orch-1",
        nodeId: "design",
        nodeLabel: "方案设计",
        kind: "design-doc",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-design",
        node: {
          id: "design",
          type: "role",
          roleId: "role-design" as any,
          label: "方案设计",
          position: { x: 0, y: 0 },
          outputArtifactMode: "file-set",
          outputWritePolicy: {
            persistenceMode: "dual-write",
            baseDir: "codeflowai/e2e-output",
          },
        },
        envelope: {
          mode: "file-set",
          files: [
            { key: "dgn", path: "design.md", content: "正式交付物" },
          ],
          attachments: [
            { key: "support", path: "design.md", content: "附件", format: "markdown" },
          ],
        },
      }),
    /工件输出包含重复路径/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService rejects path traversal in artifact outputs", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-invalid-path-"));
  try {
    const { service } = createHarness(workspacePath);

    assert.throws(() =>
      service.persist({
        instanceId: "orch-1",
        nodeId: "report",
        nodeLabel: "结果整理",
        kind: "report/final",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-report",
        node: {
          id: "report",
          type: "role",
          roleId: "role-report" as any,
          label: "结果整理",
          position: { x: 0, y: 0 },
          outputArtifactMode: "file",
          outputWritePolicy: {
            persistenceMode: "workspace-only",
            baseDir: "codeflowai/e2e-output",
          },
        },
        envelope: {
          mode: "file",
          file: {
            path: "../outside.md",
            content: "bad",
          },
        },
      }),
    /工件路径非法/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService rejects filesystem-incompatible artifact path segments", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-invalid-segment-"));
  try {
    const { service } = createHarness(workspacePath);
    const node = {
      id: "report",
      type: "role" as const,
      roleId: "role-report" as any,
      label: "结果整理",
      position: { x: 0, y: 0 },
      outputArtifactMode: "file" as const,
      outputWritePolicy: {
        persistenceMode: "workspace-only" as const,
        baseDir: "codeflowai/e2e-output",
      },
    };

    assert.throws(() =>
      service.persist({
        instanceId: "orch-1",
        nodeId: "report",
        nodeLabel: "结果整理",
        kind: "report/final",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-report",
        node,
        envelope: {
          mode: "file",
          file: {
            path: "codeflow-docs/功能/CON/report.md",
            content: "bad",
          },
        },
      }),
    /Windows 保留名称/,
    );

    const validation = validateArtifactWorkspaceOutput({
      workspacePath,
      node,
      defaultBaseDir: "codeflow-docs/功能/共享工作区",
      envelope: {
        mode: "file",
        file: {
          path: "codeflow-docs/功能/共享:工作区/report.md",
        },
      },
    });

    assert.equal(validation.issues[0]?.code, "ARTIFACT_PATH_INVALID");
    assert.match(validation.issues[0]?.message ?? "", /文件系统不兼容字符/);
    assert.match(validation.issues[0]?.message ?? "", /task_title_path_segment/);

    const edgeCases = [
      { path: "", pattern: /工件路径非法/ },
      { path: "codeflow-docs/功能/COM1.txt/report.md", pattern: /Windows 保留名称/ },
      { path: "codeflow-docs/功能/trailing./report.md", pattern: /不能以空格或点结尾/ },
      { path: `codeflow-docs/功能/${"测".repeat(90)}/report.md`, pattern: /超过 255 字节/ },
    ];
    for (const item of edgeCases) {
      const result = validateArtifactWorkspaceOutput({
        workspacePath,
        node,
        defaultBaseDir: "codeflow-docs/功能/共享工作区",
        envelope: {
          mode: "file",
          file: {
            path: item.path,
          },
        },
      });
      assert.equal(result.issues[0]?.code, "ARTIFACT_PATH_INVALID");
      assert.match(result.issues[0]?.message ?? "", item.pattern);
    }

    const invalidBaseDir = validateArtifactWorkspaceOutput({
      workspacePath,
      node: {
        ...node,
        outputWritePolicy: {
          persistenceMode: "workspace-only",
          baseDir: "codeflow-docs/功能/NUL",
        },
      },
      envelope: {
        mode: "file",
        file: {
          path: "report.md",
        },
      },
    });
    assert.equal(invalidBaseDir.issues[0]?.code, "ARTIFACT_PATH_INVALID");
    assert.match(invalidBaseDir.issues[0]?.message ?? "", /Windows 保留名称/);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService rejects portable duplicate artifact paths", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-case-duplicate-"));
  try {
    const { service } = createHarness(workspacePath);

    assert.throws(() =>
      service.persist({
        instanceId: "orch-1",
        nodeId: "report",
        nodeLabel: "结果整理",
        kind: "report/final",
        schemaRef: null,
        version: 1,
        threadId: "thread-1",
        roleId: "role-report",
        node: {
          id: "report",
          type: "role",
          roleId: "role-report" as any,
          label: "结果整理",
          position: { x: 0, y: 0 },
          outputArtifactMode: "file-set",
          outputWritePolicy: {
            persistenceMode: "workspace-only",
            baseDir: "codeflowai/e2e-output",
          },
        },
        envelope: {
          mode: "file-set",
          files: [
            { path: "Report.md", content: "first" },
            { path: "report.md", content: "second" },
          ],
        },
      }),
    /大小写冲突路径/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService createRevision keeps write policy and records human revision metadata", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-revision-"));
  try {
    const { service, artifacts, artifactFiles } = createHarness(workspacePath);
    const baseArtifact = service.persist({
      instanceId: "orch-1",
      nodeId: "delivery",
      nodeLabel: "交付整理",
      kind: "delivery-pack",
      schemaRef: null,
      version: 1,
      threadId: "thread-delivery",
      roleId: "role-delivery",
      node: {
        id: "delivery",
        type: "role",
        roleId: "role-delivery" as any,
        label: "交付整理",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file",
        outputWritePolicy: {
          persistenceMode: "dual-write",
          overwritePolicy: "create-versioned-copy",
          baseDir: "codeflowai/delivery-output",
        },
      },
      envelope: {
        mode: "file",
        file: {
          path: "docs/delivery.md",
          content: "# 初版交付\n",
          summary: "初版",
        },
      },
    });

    const revised = service.createRevision({
      basedOn: baseArtifact,
      nodeLabel: "交付整理",
      version: 2,
      threadId: "thread-delivery",
      roleId: "role-delivery",
      note: "人工补充了验收范围和交付边界",
      envelope: {
        mode: "file",
        file: {
          path: "docs/delivery.md",
          content: "# 人工修订版交付\n",
          summary: "人工修订版",
        },
      },
    });

    const revision = getArtifactRevisionMetadata(revised);
    assert.equal(revised.version, 2);
    assert.equal(revised.persistenceMode, "dual-write");
    assert.equal(revised.workspaceBaseDir, "codeflowai/delivery-output");
    assert.equal(revised.workspaceStatus, "staging");
    assert.equal(revision?.source, "human");
    assert.equal(revision?.basedOnArtifactId, baseArtifact.id);
    assert.equal(revision?.basedOnVersion, 1);
    assert.equal(revision?.note, "人工补充了验收范围和交付边界");

    const revisedFile = artifactFiles.find((entry) => entry.artifactId === revised.id);
    assert.equal(revisedFile?.stagingPath, null);
    assert.equal(revisedFile?.publishedPath, "codeflowai/delivery-output/docs/delivery.md");
    assert.ok(fs.existsSync(path.join(workspacePath, revisedFile?.publishedPath ?? "")));
    assert.equal(artifacts.length, 2);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService creates a human revision without reusing the source node Attempt identity", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-revision-attempt-"));
  const db = openClientDb({ dbPath: ":memory:" });
  try {
    const workspaceId = "client-a:ws-revision-attempt";
    const instanceId = "orch-revision-attempt";
    db.db.prepare(`
      INSERT INTO workspaces (id, title, path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(workspaceId, "人工修订 Attempt 验证", workspacePath, 1, 1);
    db.db.prepare(`
      INSERT INTO orch_instances (
        id, workspace_id, workflow_id, workflow_snapshot_json,
        intake_snapshot_json, node_states_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(instanceId, workspaceId, "wf-revision-attempt", "{}", "{}", "{}", 1, 1);

    const service = new ArtifactPersistenceService({ db, workspacePath, workspaceId: workspaceId as any });
    const baseArtifact = service.persist({
      instanceId,
      nodeId: "delivery",
      nodeLabel: "交付整理",
      kind: "delivery-pack",
      schemaRef: null,
      version: 1,
      threadId: "thread-delivery",
      roleId: "role-delivery",
      node: {
        id: "delivery",
        type: "role",
        roleId: "role-delivery" as any,
        label: "交付整理",
        position: { x: 0, y: 0 },
        outputArtifactMode: "text",
        outputWritePolicy: { persistenceMode: "db-only" },
      },
      envelope: { mode: "text", text: "初版交付" },
      metadata: { nodeAttemptId: "attempt-delivery-1" },
    });

    const revised = service.createRevision({
      basedOn: baseArtifact,
      nodeLabel: "交付整理",
      version: 2,
      threadId: "thread-delivery",
      roleId: "role-delivery",
      note: "人工补充验收说明",
      envelope: { mode: "text", text: "人工修订后的交付" },
    });

    assert.equal(baseArtifact.metadata?.nodeAttemptId, "attempt-delivery-1");
    assert.equal(revised.metadata?.nodeAttemptId, undefined);
    assert.equal(db.orchArtifacts.getByNodeAttempt(instanceId as any, "attempt-delivery-1")?.id, baseArtifact.id);
    assert.deepEqual(db.orchArtifacts.listByNode(instanceId as any, "delivery").map((artifact) => artifact.version), [1, 2]);
  } finally {
    db.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("ArtifactPersistenceService createRevision preserves contract and attachment metadata", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-artifacts-revision-contract-"));
  try {
    const { service, artifactFiles } = createHarness(workspacePath);
    const baseEnvelope: NodeExecutionEnvelope = {
      mode: "file-set",
      files: [
        { key: "dgn", path: "docs/dgn.md", content: "# 初版\n", summary: "设计卡" },
      ],
      attachments: [
        { key: "ddl", path: "docs/schema.sql", content: "CREATE TABLE demo(id bigint);\n", summary: "补充 DDL", format: "sql" },
      ],
      summary: "初版交付",
    };
    const baseArtifact = service.persist({
      instanceId: "orch-1",
      nodeId: "design",
      nodeLabel: "方案设计",
      kind: "design-pack",
      schemaRef: null,
      version: 1,
      threadId: "thread-design",
      roleId: "role-design",
      node: {
        id: "design",
        type: "role",
        roleId: "role-design" as any,
        label: "方案设计",
        position: { x: 0, y: 0 },
        outputArtifactMode: "file-set",
      },
      envelope: baseEnvelope,
    });

    const revisionEnvelope: NodeExecutionEnvelope = {
      mode: "file-set",
      files: [
        { key: "dgn", path: "docs/dgn.md", content: "# 人工修订\n", summary: "修订设计卡" },
      ],
      attachments: [
        { key: "ddl", path: "docs/schema.sql", content: "CREATE TABLE demo(id bigint);\n", summary: "补充 DDL", format: "sql" },
      ],
      summary: "修订交付",
    };
    const contractValidation: NodeResultContractValidationResult = {
      accepted: true,
      completion: "complete",
      consumable: true,
      contractVersion: "node-result-contract/v1",
      normalizedAnswer: revisionEnvelope,
      normalizedFields: [],
      normalizedFiles: [
        {
          artifactId: "" as any,
          fileKey: "dgn",
          source: "contract",
          contractKey: "dgn",
          relPath: "docs/dgn.md",
          workspacePath: "docs/dgn.md",
          summary: "修订设计卡",
          format: "markdown",
          readRequired: true,
        },
        {
          artifactId: "" as any,
          fileKey: "ddl",
          source: "attachment",
          contractKey: null,
          relPath: "docs/schema.sql",
          workspacePath: "docs/schema.sql",
          summary: "补充 DDL",
          format: "sql",
          readRequired: true,
        },
      ],
      fieldResults: [],
      fileResults: [
        { fileKey: "dgn", source: "contract", path: "docs/dgn.md", status: "valid" },
        { fileKey: "ddl", source: "attachment", path: "docs/schema.sql", status: "valid" },
      ],
      blockingIssues: [],
      recoverableIssues: [],
      warnings: [],
    };

    const revised = service.createRevision({
      basedOn: baseArtifact,
      nodeLabel: "方案设计",
      version: 2,
      threadId: "thread-design",
      roleId: "role-design",
      note: "人工修订设计卡",
      envelope: revisionEnvelope,
      contractValidation,
    });

    const revisedFiles = artifactFiles.filter((entry) => entry.artifactId === revised.id);
    assert.equal(revisedFiles.length, 2);
    assert.equal(revisedFiles[0]?.fileRole, "contract");
    assert.equal(revisedFiles[0]?.fileKey, "dgn");
    assert.equal(revisedFiles[1]?.fileRole, "attachment");
    assert.equal(revisedFiles[1]?.fileKey, "ddl");
    assert.equal(revised.manifest?.files?.[1]?.fileRole, "attachment");
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("产物直接写在 workflowDocsRoot 根目录时校验失败并给出期望业务路径", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-root-guard-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflow-docs", "dev-review.md"), "# 评审");

    const validation = validateArtifactWorkspaceOutput({
      workspacePath,
      node: { id: "code-review", type: "role", label: "代码评审" } as never,
      defaultBaseDir: "codeflow-docs/功能/修复示例/Loop代码评审员",
      envelope: { mode: "file", file: { path: "codeflow-docs/dev-review.md" } } as never,
      enableRootedPathGuard: true,
    });

    assert.equal(validation.issues[0]?.code, "ARTIFACT_PATH_RESOLUTION_MISMATCH");
    assert.match(validation.issues[0]?.message ?? "", /缺少业务目录/);
    assert.equal(
      validation.issues[0]?.expectedPath,
      "codeflow-docs/功能/修复示例/Loop代码评审员/dev-review.md",
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("落盘前拒绝直接写入 workflowDocsRoot 根目录的产物", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-root-persist-guard-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflow-docs", "e2e.md"), "# e2e");
    const harness = createHarness(workspacePath);

    assert.throws(
      () => harness.service.persist({
        instanceId: "instance-root-guard",
        nodeId: "e2e",
        nodeLabel: "E2E 集成测试",
        kind: "e2e-report",
        schemaRef: null,
        version: 1,
        node: { id: "e2e", type: "role", label: "E2E 集成测试" } as never,
        envelope: { mode: "file", file: { path: "codeflow-docs/e2e.md", content: "# e2e" } } as never,
        defaultBaseDir: "codeflow-docs/功能/修复示例/E2E 集成测试工程师",
        enableRootedPathGuard: true,
      }),
      /缺少业务目录/,
    );
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test("路径规则未解析时不启用根目录守卫，保持既有落盘行为", () => {
  // 旧资产包（规则仍含尖括号）下若启用守卫，升级后的 Client 会陷入"拒绝-重试"，比升级前更差。
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-root-guard-off-"));
  try {
    fs.mkdirSync(path.join(workspacePath, "codeflow-docs"), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, "codeflow-docs", "dev-review.md"), "# 评审");

    const validation = validateArtifactWorkspaceOutput({
      workspacePath,
      node: { id: "code-review", type: "role", label: "代码评审" } as never,
      defaultBaseDir: "codeflow-docs/功能/修复示例/Loop代码评审员",
      envelope: { mode: "file", file: { path: "codeflow-docs/dev-review.md" } } as never,
    });

    assert.deepEqual(validation.issues, []);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
