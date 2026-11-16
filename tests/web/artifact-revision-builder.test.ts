import test from "node:test";
import assert from "node:assert/strict";

import {
  buildArtifactRevisionSubmission,
  buildEditableArtifactDraft,
  type EditableArtifactDraft,
} from "../../apps/web/src/features/orchestration/artifact-revision.ts";
import type { Artifact } from "../../packages/shared/src/types/orchestration.ts";

test("buildArtifactRevisionSubmission keeps file revisions path-only and moves正文到 workspaceFiles", () => {
  const draft: EditableArtifactDraft = {
    mode: "file",
    summary: "交付说明",
    file: {
      id: "file_1",
      path: "codeflow-docs/demo/delivery-note.md",
      content: "# revised\n",
      summary: "最终说明",
    },
  };

  const submission = buildArtifactRevisionSubmission(draft);

  assert.deepEqual(submission.answer, {
    mode: "file",
    file: {
      path: "codeflow-docs/demo/delivery-note.md",
      summary: "最终说明",
    },
    summary: "交付说明",
    changedFiles: ["codeflow-docs/demo/delivery-note.md"],
  });
  assert.deepEqual(submission.workspaceFiles, [{
    path: "codeflow-docs/demo/delivery-note.md",
    content: "# revised\n",
  }]);
});

test("buildArtifactRevisionSubmission keeps file-set revisions path-only and preserves summaries", () => {
  const draft: EditableArtifactDraft = {
    mode: "file-set",
    summary: "交付包",
    files: [
      {
        id: "file_1",
        path: "docs/a.md",
        content: "# A\n",
        summary: "A 摘要",
      },
      {
        id: "file_2",
        path: "docs/b.md",
        content: "# B\n",
        summary: "B 摘要",
      },
    ],
  };

  const submission = buildArtifactRevisionSubmission(draft);

  assert.deepEqual(submission.answer, {
    mode: "file-set",
    files: [
      { path: "docs/a.md", summary: "A 摘要" },
      { path: "docs/b.md", summary: "B 摘要" },
    ],
    summary: "交付包",
    changedFiles: ["docs/a.md", "docs/b.md"],
  });
  assert.deepEqual(submission.workspaceFiles, [
    { path: "docs/a.md", content: "# A\n" },
    { path: "docs/b.md", content: "# B\n" },
  ]);
});

test("buildArtifactRevisionSubmission preserves dynamic attachments outside files", () => {
  const artifact = {
    id: "artifact-1",
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
          path: "docs/dgn.md",
          content: "# revised\n",
          summary: "主设计卡",
        },
      ],
      attachments: [
        {
          key: "ddl",
          path: "docs/schema.sql",
          content: "CREATE TABLE demo(id bigint);\n",
          summary: "补充 DDL",
          format: "sql",
        },
      ],
    }),
    payloadMode: "file-set",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Artifact;
  const draft = buildEditableArtifactDraft(artifact);
  assert.equal(draft.mode, "file-set");

  const submission = buildArtifactRevisionSubmission(draft);

  assert.deepEqual(submission.answer, {
    mode: "file-set",
    files: [
      { key: "dgn", path: "docs/dgn.md", summary: "主设计卡" },
    ],
    summary: null,
    changedFiles: ["docs/dgn.md"],
    attachments: [
      { key: "ddl", path: "docs/schema.sql", summary: "补充 DDL", format: "sql", kind: null, language: null },
    ],
  });
  assert.deepEqual(submission.workspaceFiles, [
    { path: "docs/dgn.md", content: "# revised\n" },
  ]);
});
