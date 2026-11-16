import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Artifact, OrchestrationId, ResolvedNodeContext } from "../../packages/shared/src/index.ts";
import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { OrchArtifactRepo } from "../../apps/desktop/client/src/db/repos/orchArtifactRepo.ts";
import { OrchArtifactFileRepo } from "../../apps/desktop/client/src/db/repos/orchArtifactFileRepo.ts";
import { OrchArtifactFieldRepo } from "../../apps/desktop/client/src/db/repos/orchArtifactFieldRepo.ts";
import { OrchNodeContextResolutionRepo } from "../../apps/desktop/client/src/db/repos/orchNodeContextResolutionRepo.ts";

/** 创建带最小编排外键数据的本地测试库。 */
function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-contract-storage-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);
  migrateClientDb(db as any);
  db.prepare(
    "INSERT INTO workspaces(id, title, path, is_deleted, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
  ).run("ws-1", "Workspace", tempDir, 1, 1);
  db.prepare(
    `INSERT INTO orch_instances (
      id, workspace_id, workflow_id, workflow_snapshot_json, intake_snapshot_json,
      role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
      master_thread_id, status, node_states_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "orch-1",
    "ws-1",
    "wf-1",
    "{}",
    "{}",
    null,
    null,
    null,
    null,
    null,
    "running",
    "{}",
    1,
    1,
  );
  return { db, tempDir };
}

test("node result contract repos persist file keys, fields, and context resolutions", () => {
  const { db, tempDir } = createHarness();

  try {
    const artifacts = new OrchArtifactRepo(db as any);
    const files = new OrchArtifactFileRepo(db as any);
    const fields = new OrchArtifactFieldRepo(db as any);
    const contexts = new OrchNodeContextResolutionRepo(db as any);

    const artifact = artifacts.create({
      instanceId: "orch-1" as OrchestrationId,
      nodeId: "prd",
      kind: "prd-doc",
      version: 1,
      title: "PRD 输出 v1",
      schemaRef: null,
      status: "approved",
      contentJson: JSON.stringify({ mode: "file", file: { key: "main", path: "docs/prd.md" } }),
      metadata: {
        nodeResult: {
          completion: "complete",
          nextAction: "continue",
          validationStatus: "valid",
          consumable: true,
          contractVersion: "node-result-contract/v1",
        },
      },
      persistenceMode: "dual-write",
      payloadMode: "file",
      workspaceStatus: "published",
      workspaceBaseDir: "docs",
      stagingPath: null,
      publishedPath: "docs/prd.md",
      contentHash: "hash-artifact",
      manifest: null,
    } satisfies Omit<Artifact, "id" | "createdAt" | "updatedAt">);

    const fileRows = files.replaceForArtifact(artifact.id, [{
      fileKey: "main",
      format: "markdown",
      contractKey: "main",
      validationStatus: "valid",
      relPath: "docs/prd.md",
      stagingPath: null,
      publishedPath: "docs/prd.md",
      status: "published",
      contentHash: "hash-file",
      sizeBytes: 123,
    }]);
    assert.equal(fileRows[0]?.fileKey, "main");
    assert.equal(files.listByArtifact(artifact.id)[0]?.format, "markdown");

    const fieldRows = fields.replaceForArtifact(artifact.id, [{
      instanceId: artifact.instanceId,
      nodeId: artifact.nodeId,
      resultName: artifact.kind,
      fieldKey: "scopeSummary",
      label: "范围摘要",
      valueType: "text",
      valueJson: JSON.stringify("只处理节点上下文"),
      valuePreview: "只处理节点上下文",
      required: true,
      source: "model",
      validationStatus: "valid",
    }]);
    assert.equal(fieldRows[0]?.fieldKey, "scopeSummary");
    assert.equal(fields.listByArtifact(artifact.id)[0]?.valuePreview, "只处理节点上下文");

    const context: ResolvedNodeContext = {
      schemaVersion: "node-context/v1",
      contextId: "ctx-1",
      instanceId: artifact.instanceId,
      nodeId: "dgn",
      attemptNo: 1,
      status: "resolved",
      createdAt: 2,
      task: { title: "设计", titlePathSegment: "设计", goal: "基于 PRD 设计" },
      inputs: [{
        inputId: "input-1",
        targetKey: "prdDoc",
        required: true,
        status: "resolved",
        config: {
          id: "ref-1",
          targetKey: "prdDoc",
          sourceNodeId: "prd",
          sourceResultName: "prd-doc",
          sourceSelector: { type: "file", fileKey: "main" },
          required: true,
          promptMode: "reference-only",
        },
        source: {
          nodeId: "prd",
          artifactId: artifact.id,
          resultName: "prd-doc",
          version: 1,
          status: "approved",
        },
        value: {
          type: "file",
          fileKey: "main",
          artifactFileId: fileRows[0]?.id ?? null,
          relPath: "docs/prd.md",
          workspacePath: "docs/prd.md",
          summary: "PRD 主文档",
          format: "markdown",
          sizeBytes: 123,
          contentHash: "hash-file",
          readRequired: true,
        },
        promptText: "<input key=\"prdDoc\" type=\"file\"><path>docs/prd.md</path></input>",
      }],
      upstreamResults: [{
        nodeId: "prd",
        artifactId: artifact.id,
        resultName: "prd-doc",
        version: 1,
        status: "approved",
      }],
    };
    contexts.create({
      instanceId: artifact.instanceId,
      nodeId: "dgn",
      attemptNo: 1,
      status: "resolved",
      context,
      error: null,
    });

    const latest = contexts.getLatest(artifact.instanceId, "dgn");
    assert.equal(latest?.context.inputs[0]?.targetKey, "prdDoc");
    assert.equal(latest?.context.inputs[0]?.value?.type, "file");
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
