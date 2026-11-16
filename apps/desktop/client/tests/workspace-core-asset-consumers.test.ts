import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openClientDb } from "../src/db/clientDb.js";
import { handleOrchWorkflowsDelete } from "../src/app/handlers/orchestrationHandlers.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { installDesktopBuiltinAssets } from "../src/orchestration/desktopBuiltinAssetService.js";

test("真实流程删除先选择资产外层事务，关联清理失败时完整回滚", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-asset-consumers-"));
  const root = openClientDb({ dbPath: path.join(directory, "app.db") });
  t.after(() => { root.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const workspaceId = "asset-consumer";
  root.workspaces.upsert({ id: workspaceId, path: directory, title: "资产工作区" });
  const db = root.forWorkspace(workspaceId);
  const workflow = db.orchWorkflows.upsert({ workspaceId, name: "流程", description: "", version: 1, nodes: [], edges: [] });
  const ctx = { db, workspaces: new Map([[workspaceId, directory]]), send() {} } as unknown as ApiHandlerContext;
  const request = { t: "api.req" as const, id: "delete-workflow", method: "orch.workflows.delete", path: "/test", body: { workspaceId, workflowId: workflow.id } };
  const failure = new Error("injected-group-cleanup-failure");
  const original = db.orchAssetGroups.deleteAssignment;
  db.orchAssetGroups.deleteAssignment = () => { throw failure; };
  assert.throws(() => handleOrchWorkflowsDelete(ctx, request), error => error === failure);
  assert.ok(db.orchWorkflows.get(workflow.id));
  db.orchAssetGroups.deleteAssignment = original;
  handleOrchWorkflowsDelete(ctx, request);
  assert.equal(db.orchWorkflows.get(workflow.id), null);
});

test("普通 Client 内置包准备保持同一工作区整组原子性", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-bundle-group-"));
  const root = openClientDb({ dbPath: path.join(directory, "app.db") });
  t.after(() => { root.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  root.workspaces.upsert({ id: "bundle-group", path: directory, title: "内置包" });
  const scoped = root.forWorkspace("bundle-group");
  const bundles = ["first", "second"].map(bundleId => ({ schemaVersion: "orch-asset-bundle/v1" as const,
    bundleId, bundleVersion: 1, title: bundleId, generatedAt: 1, source: { kind: "server-default" as const },
    roles: [], workflows: [], knowledgeBundles: [], toolsets: [], skills: [] }));
  scoped.orchRoles.upsert = () => { throw new Error("injected-second-bundle-failure"); };
  bundles[1]!.roles = [{ sourceId: "role", role: { name: "角色", description: "", systemPrompt: "执行", kind: "builtin", inputDefinition: { instructions: "", requiredFields: [] }, outputDefinition: { deliveryMode: "direct", format: "markdown", instructions: "", requiredFields: [] }, executionConfig: { preferredEngine: "codex" }, gateCriteria: [] } } as never];
  assert.throws(() => installDesktopBuiltinAssets({ db: root, workspaces: new Map([["bundle-group", directory]]), bundles }), /injected-second-bundle-failure/);
  assert.deepEqual(scoped.orchRoles.listByWorkspace("bundle-group"), []);
});
