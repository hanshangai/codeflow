import test from "node:test";
import assert from "node:assert/strict";

import type { Artifact, ArtifactFileEntry } from "../../packages/shared/src/types/orchestration.ts";
import {
  buildArtifactPresentation,
  inferArtifactRenderMode,
  isDocumentArtifactPath,
  isImageArtifactPath,
} from "../../apps/web/src/features/orchestration/components/artifact-preview-utils.ts";

test("artifact preview recognizes PPTX as a document but keeps legacy PPT unsupported", () => {
  assert.equal(inferArtifactRenderMode("slides/demo.pptx"), "document");
  assert.equal(isDocumentArtifactPath("slides/demo.PPTX"), true);
  assert.equal(inferArtifactRenderMode("slides/legacy.ppt"), "raw");
  assert.equal(isDocumentArtifactPath("slides/legacy.ppt"), false);
});

test("buildArtifactPresentation resolves workspace preview path for image file-set artifacts", () => {
  const artifact = {
    id: "artifact-1",
    instanceId: "instance-1",
    nodeId: "ui",
    kind: "ui-spec",
    version: 1,
    title: "UI 输出",
    status: "draft",
    contentJson: JSON.stringify({
      mode: "file-set",
      files: [
        {
          path: "screenshots/01-overview.png",
          content: "",
        },
      ],
    }),
    payloadMode: "file-set",
    workspaceBaseDir: "codeflow-docs/示例/原型设计/UI-示例-20260411",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;

  const artifactFiles = [
    {
      id: "artifact-file-1",
      artifactId: artifact.id,
      relPath: "screenshots/01-overview.png",
      publishedPath: "codeflow-docs/示例/原型设计/UI-示例-20260411/screenshots/01-overview.png",
      status: "published",
      contentHash: "hash",
      sizeBytes: 128,
      createdAt: 1,
      updatedAt: 1,
    },
  ] satisfies ArtifactFileEntry[];

  const presentation = buildArtifactPresentation(artifact, artifactFiles);

  assert.equal(presentation.files.length, 1);
  assert.equal(presentation.files[0]?.filePath, "screenshots/01-overview.png");
  assert.equal(
    presentation.files[0]?.workspacePreviewPath,
    "codeflow-docs/示例/原型设计/UI-示例-20260411/screenshots/01-overview.png",
  );
  assert.equal(isImageArtifactPath(presentation.files[0]?.filePath ?? ""), true);
});

test("buildArtifactPresentation keeps actual path for single file artifacts", () => {
  const artifact = {
    id: "artifact-2",
    instanceId: "instance-1",
    nodeId: "prd",
    kind: "prd-doc",
    version: 2,
    title: "PRD 输出",
    status: "draft",
    contentJson: JSON.stringify({
      mode: "file",
      file: {
        path: "codeflow-docs/示例/需求分析/PRD-示例-20260411.md",
        content: "# PRD",
      },
    }),
    payloadMode: "file",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;

  const presentation = buildArtifactPresentation(artifact);

  assert.equal(presentation.filePath, "codeflow-docs/示例/需求分析/PRD-示例-20260411.md");
  assert.equal(presentation.renderMode, "markdown");
  assert.equal(presentation.content, "# PRD");
});

test("buildArtifactPresentation fails closed when rooted file-set path lacks artifact file metadata", () => {
  const artifact = {
    id: "artifact-3",
    instanceId: "instance-1",
    nodeId: "ui",
    kind: "ui-spec",
    version: 1,
    title: "UI 输出",
    status: "draft",
    contentJson: JSON.stringify({
      mode: "file-set",
      files: [
        {
          path: "codeflow-docs/统一报送/原型设计/UI-web前端原型初始化-20260414/screenshots/06-dialog-routing.png",
          content: null,
        },
      ],
    }),
    payloadMode: "file-set",
    workspaceBaseDir: "codeflow-docs/功能/前端原型初始化（基于原项目）--c198656c/UI-UX设计师（UI）",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;

  const presentation = buildArtifactPresentation(artifact, []);

  assert.equal(
    presentation.files[0]?.workspacePreviewPath,
    null,
  );
});

test("buildArtifactPresentation does not guess workspace path when file-set artifacts have no artifact file metadata", () => {
  const artifact = {
    id: "artifact-4",
    instanceId: "instance-1",
    nodeId: "ui",
    kind: "ui-spec",
    version: 1,
    title: "UI 输出",
    status: "draft",
    contentJson: JSON.stringify({
      mode: "file-set",
      files: [
        {
          path: "docs/other/screenshots/overview.png",
          content: null,
        },
      ],
    }),
    payloadMode: "file-set",
    workspaceBaseDir: "docs/workflow/功能/前端原型初始化--c198656c/UI-UX设计师（UI）",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;

  const presentation = buildArtifactPresentation(artifact, []);

  assert.equal(
    presentation.files[0]?.workspacePreviewPath,
    null,
  );
});

test("buildArtifactPresentation separates contract files and dynamic attachments", () => {
  const artifact = {
    id: "artifact-5",
    instanceId: "instance-1",
    nodeId: "dgn",
    kind: "dgn-doc",
    version: 1,
    title: "DGN 输出",
    status: "draft",
    contentJson: JSON.stringify({
      mode: "file-set",
      files: [
        {
          key: "dgn",
          path: "codeflow-docs/demo/DGN-demo.md",
          content: "# DGN",
          summary: "主设计卡",
        },
      ],
      attachments: [
        {
          key: "ddl",
          path: "codeflow-docs/demo/schema.sql",
          content: "CREATE TABLE demo(id bigint);",
          summary: "补充 DDL",
          format: "sql",
        },
      ],
    }),
    payloadMode: "file-set",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;

  const presentation = buildArtifactPresentation(artifact, []);

  assert.equal(presentation.files.length, 2);
  assert.equal(presentation.files[0]?.fileRole, "contract");
  assert.equal(presentation.files[0]?.fileKey, "dgn");
  assert.equal(presentation.files[1]?.fileRole, "attachment");
  assert.equal(presentation.files[1]?.fileKey, "ddl");
  assert.equal(presentation.files[1]?.summary, "补充 DDL");
  assert.equal(presentation.files[1]?.renderMode, "raw");
});
