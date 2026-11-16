import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { openClientDb } from "../src/db/clientDb.js";
import { OrchInstanceScopeError } from "../src/db/repos/orchInstanceRepo.js";
import { OrchAssetLaunchSnapshotError } from "../src/orchestration/orchAssetLaunchSnapshotService.js";
import { shouldRecoverPersistedOrchestrationInstance } from "../src/orchestration/orchestrationEngine.js";
import { isDesktopLocalAssetExecution } from "../src/orchestration/orchAssetAuthorityRuntimeReadService.js";

test("startup recovery isolates a retired shared instance and still recovers its local peer", async t => {
  const workspaceId = "client:workspace", root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-asset-cold-recovery-"));
  const application = openClientDb({ dbPath: path.join(root, "client.sqlite") });
  t.after(() => { application.close(); fs.rmSync(root, { recursive: true, force: true }); });
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: root });
  const db = application.forWorkspace(workspaceId), workspaces = new Map([[workspaceId, root]]);
  const workflow = db.orchWorkflows.upsert({ id: "flow", workspaceId: workspaceId, name: "Flow", description: "Flow", nodes: [], edges: [], version: 1 });
  const intake = db.orchIntakes.create({ workspaceId: workspaceId, title: "Local", goal: "Goal", triggerMode: "manual", taskType: "feature",
    workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  const cached = db.orchInstances.create({ workspaceId: workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  const personal = db.orchInstances.create({ workspaceId: workspaceId, workflowId: workflow.id, workflowSnapshot: workflow, intakeSnapshot: intake });
  db.orchInstances.updateStatus(cached.id, "running"); db.orchInstances.updateStatus(personal.id, "running");
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"), tree = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
  const names = ["isolatePersistedInstanceFailure", "recoverRunningOrchestrations"], declarations = new Map<string, ts.VariableDeclaration>();
  /** Extracts the existing startup loop and owning transactional isolation boundary together. */
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(tree))) declarations.set(node.name.getText(tree), node);
    ts.forEachChild(node, visit);
  };
  visit(tree); for (const name of names) assert.ok(declarations.has(name));
  const code = ts.transpileModule(names.map(name => `const ${declarations.get(name)!.getText(tree)};`).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const recovered: string[] = [], logs: unknown[][] = [];
  const recover = new Function("env", `with(env) { ${code}; return recoverRunningOrchestrations; }`)({ db: application, workspaces,
    orchRecoveryStarted: new Set(), desktopLifecycle: {}, config: { clientId: "client" }, deviceIdentity: { deviceId: "device" }, desktopRequestId: "cold-recovery",
    OrchInstanceScopeError, OrchAssetLaunchSnapshotError,
    isDesktopLocalAssetExecution, shouldRecoverPersistedOrchestrationInstance,
    logger: { info() {} }, logClientStep(...args: unknown[]) { logs.push(args); },
    orchEngine: { forWorkspace() { return {
      /** 历史共享执行失败必须局部暂停，不影响本地同伴。 */
      async recover(instanceId: string) { if (instanceId === cached.id) throw new OrchAssetLaunchSnapshotError("ASSET_CACHE_EXECUTION_REMOVED", "历史缓存执行已停用"); recovered.push(instanceId); },
    }; } },
  }) as (scope: string) => Promise<void>;
  await recover("desktop");
  assert.deepEqual(recovered, [personal.id]); assert.equal(db.orchInstances.get(cached.id)!.status, "paused");
  assert.equal(db.orchInstances.get(personal.id)!.status, "running");
  const events = db.orchEvents.listByInstance(cached.id); assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "orchestration.error");
  assert.equal(JSON.parse(events[0]!.payloadJson).code, "ORCHESTRATION_RECOVERY_FAILED");
  assert.equal(logs.filter(row => row[0] === "error").length, 1);
});

test("instance snapshot persistence rejects an authorization accessor without invoking or persisting it", async t => {
  const workspaceId = "client:workspace", root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-asset-snapshot-accessor-"));
  const application = openClientDb({ dbPath: path.join(root, "client.sqlite") });
  t.after(() => { application.close(); fs.rmSync(root, { recursive: true, force: true }); });
  application.workspaces.upsert({ id: workspaceId, title: "Local", path: root });
  const db = application.forWorkspace(workspaceId);
  const workflow = db.orchWorkflows.upsert({ id: "flow", workspaceId: workspaceId, name: "Flow", description: "Flow", nodes: [], edges: [], version: 1 });
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = workflow;
  let reads = 0;
  const snapshot = { authorityMode: "server", workflow: { assetType: "workflow", assetId: "flow", definition, source: null },
    roles: {}, knowledgeBundles: {}, toolsets: {}, skills: {},
    get executionAuthorization() { reads++; return {}; },
  };
  const intake = db.orchIntakes.create({ workspaceId: workspaceId, title: "Local", goal: "Goal", triggerMode: "manual", taskType: "feature",
    workspaceScope: { scopeType: "local_workspace", scopeId: workspaceId } });
  assert.throws(() => db.orchInstances.create({ workspaceId: workspaceId, workflowId: workflow.id,
    workflowSnapshot: definition, intakeSnapshot: intake, assetRuntimeSnapshot: snapshot as never }));
  assert.equal(reads, 0);
  assert.deepEqual(db.db.prepare("SELECT id FROM orch_instances").all(), []);
});
