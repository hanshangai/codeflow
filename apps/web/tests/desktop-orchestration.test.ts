import test from "node:test";
import assert from "node:assert/strict";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";
import { createPinia, setActivePinia } from "pinia";
import { useOrchestrationStore } from "../src/store/orchestration.ts";

test("desktop maps actual orchestration consumers without opening unused methods", () => {
  const body = { workspaceId: "local:workspace" };
  for (const [path, method] of [
    ["requirement-analysis/sessions/create", "requirementAnalysis.sessions.create"],
    ["requirement-analysis/sessions/get", "requirementAnalysis.sessions.get"],
    ["requirement-analysis/create-intakes", "requirementAnalysis.createIntakes"],
    ["intakes/create", "intakes.create"], ["proposals/confirm", "proposals.confirm"],
    ["instances/runtime-patch", "instances.runtimePatch"], ["instances/start", "instances.start"],
    ["instances/rerun-from-node", "instances.rerunFromNode"], ["nodes/skip", "nodes.skip"],
    ["artifact-files/list", "artifactFiles.list"], ["prompt-snapshots/get", "promptSnapshots.get"],
    ["node-work-items/list", "nodeWorkItems.list"], ["node-work-item-events/list", "nodeWorkItemEvents.list"],
    ["workflow-execution-default/upsert", "workflowExecutionDefaults.upsert"],
    ["runtime-evidence/get", "runtimeEvidence.get"],
  ]) assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/orch/${path}`, body }, "local"), { method: `orch.${method}`, body });
  assert.deepEqual(resolveDesktopApiRequest({ method: "GET", path: "/api/orch/intakes?workspaceId=local%3Aworkspace&limit=20&onlyRelatedToMe=false&statuses=running,completed" }, "local"),
    { method: "orch.intakes.list", body: { ...body, limit: 20, onlyRelatedToMe: false, statuses: ["running", "completed"] } });
  for (const path of ["pending-mine", "requirement-analysis/messages/send", "requirement-analysis/sessions/archive", "instances/discussion-thread/ensure", "instances/reassign-node"])
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: `/api/orch/${path}`, body }, "local"), null, path);
  assert.equal(resolveDesktopApiRequest({ method: "GET", path: "/api/orch/instances?workspaceId=other%3Aworkspace" }, "local"), null);
  for (const workspaceId of ["shared:one", "other:workspace"]) {
    assert.equal(resolveDesktopApiRequest({ method: "POST", path: "/api/orch/runtime-evidence/get",
      body: { workspaceId, instanceId: "instance" } }, "local"), null);
  }
});

test("desktop maps provider replies and exact read-only file/git consumers", () => {
  const body = { workspaceId: "local:workspace", threadId: "thread", requestId: 7 };
  for (const [path, method] of [["approvals/respond", "approvals.respond"], ["user-input/respond", "userInput.respond"], ["threads/rename", "threads.rename"], ["threads/archive", "threads.archive"], ["threads/delete", "threads.delete"],
    ["fs/readFile", "fs.readFile"], ["fs/spreadsheetPreview", "fs.spreadsheetPreview"], ["fs/documentPreview", "fs.documentPreview"], ["git/status", "git.status"], ["git/diff", "git.diff"], ["git/diffFiles", "git.diffFiles"]])
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/${path}`, body }, "local"), { method, body });
});

test("desktop Git mutations preserve payloads and keep shared or remote targets on Server", () => {
  for (const [action, payload] of [
    ["stage", { repositoryPath: "repo", paths: ["src/app.ts"] }],
    ["unstage", { repositoryPath: "repo", paths: ["src/app.ts"] }],
    ["discard", { repositoryPath: "repo", paths: ["src/app.ts"] }],
    ["commit", { repositoryPath: "repo", message: "更新测试", amend: false }],
  ] as const) {
    const body = { workspaceId: "local:workspace", ...payload };
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path: `/api/git/${action}`, body }, "local"),
      { method: `git.${action}`, body });
    for (const workspaceId of ["shared:one", "other:workspace"]) {
      assert.equal(resolveDesktopApiRequest({ method: "POST", path: `/api/git/${action}`,
        body: { ...body, workspaceId } }, "local"), null);
    }
  }
});

test("late orchestration hydration cannot apply an old event after returning to the same workspace", async t => {
  setActivePinia(createPinia());
  const store = useOrchestrationStore(), workspaceId = "local:workspace" as any;
  store.resetForWorkspace(workspaceId);
  let deliver!: (value: any) => void;
  const response = new Promise<any>(resolve => { deliver = resolve; });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: { getState: async () => ({}), request: async () => response } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "window", original); else Reflect.deleteProperty(globalThis, "window"); });
  const instance = { id: "instance", workspaceId, workflowId: "flow", status: "running", nodeStates: {}, updatedAt: 1,
    intakeSnapshot: { id: "intake", workspaceId, title: "需求", goal: "目标" }, workflowSnapshot: { name: "Flow", nodes: [], edges: [] } } as any;
  const pending = store.onOrchestrationEvent({ serverWsOrigin: "ws://unused", desktopClientId: "local", sessionToken: null, webSessionId: null }, workspaceId,
    { id: "old-event" as any, instanceId: instance.id, nodeId: null, type: "orchestration.paused", payloadJson: "{}", createdAt: 2 });
  await Promise.resolve();
  store.resetForWorkspace("local:other" as any);
  store.resetForWorkspace(workspaceId);
  store.instances = [instance];
  deliver({ status: 200, body: { ok: true, instance: { ...instance, status: "pending" } } });
  await pending;
  assert.equal(store.instances[0]?.status, "running");
});
