import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopApiRequest, WorkspaceId } from "@codeflowai/shared";
import {
  applyAssetAssistantDraft, deleteAssetAssistantJob, getAssetAssistantJob, getAssetAssistantResult,
  listAssetAssistantJobs, resumeAssetAssistantJob, startAssetAssistantJob,
} from "../src/api/orchestration/index.ts";
import { requestJson } from "../src/api/request.ts";
import { resolveDesktopApiRequest } from "../src/services/desktop.ts";

const actions = {
  "generate": "orch.assetDrafts.generate", "get": "orch.assetDrafts.get",
  "apply": "orch.assetDrafts.apply", "reject": "orch.assetDrafts.reject",
  "jobs/list": "orch.assetDraftJobs.list", "jobs/get": "orch.assetDraftJobs.get",
  "jobs/delete": "orch.assetDraftJobs.delete", "jobs/resume": "orch.assetDraftJobs.resume",
} as const;

test("asset assistant uses the local bridge without a login or Server connection", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const requests: DesktopApiRequest[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({ status: "ready" }),
    request: async (request: DesktopApiRequest) => { requests.push(request); return { status: 200, body: { ok: true } }; },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("asset assistant must not contact Server"); });
  const ctx = { serverWsOrigin: "", sessionToken: null, webSessionId: null, desktopClientId: "local",
    ensureSession: async () => { throw new Error("asset assistant must not require login"); } };
  const workspaceId = "local:workspace" as WorkspaceId;
  await listAssetAssistantJobs(ctx, { workspaceId });
  await startAssetAssistantJob(ctx, { workspaceId, assetKind: "role", mode: "create", prompt: "创建本机 Agent" });
  await getAssetAssistantJob(ctx, { workspaceId, jobId: "job" });
  await resumeAssetAssistantJob(ctx, { workspaceId, jobId: "job", prompt: "补充边界" });
  await getAssetAssistantResult(ctx, { workspaceId, draftId: "draft" });
  await applyAssetAssistantDraft(ctx, { workspaceId, draftId: "draft" });
  await requestJson(ctx, { method: "POST", path: "/api/orch/asset-drafts/reject", body: { workspaceId, draftId: "draft" } });
  await deleteAssetAssistantJob(ctx, { workspaceId, jobId: "job" });
  assert.deepEqual(requests.map(request => request.method), [
    "orch.assetDraftJobs.list", "orch.assetDrafts.generate", "orch.assetDraftJobs.get", "orch.assetDraftJobs.resume",
    "orch.assetDrafts.get", "orch.assetDrafts.apply", "orch.assetDrafts.reject", "orch.assetDraftJobs.delete",
  ]);
  assert.ok(requests.every(request => request.body?.workspaceId === workspaceId));
});

test("shared and remote asset assistants keep the authenticated Server route", () => {
  for (const [action, method] of Object.entries(actions)) {
    const path = `/api/orch/asset-drafts/${action}`;
    assert.deepEqual(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId: "local:workspace" } }, "local"),
      { method, body: { workspaceId: "local:workspace" } });
    for (const workspaceId of ["shared:team", "remote:workspace"]) {
      assert.equal(resolveDesktopApiRequest({ method: "POST", path, body: { workspaceId } }, "local"), null);
    }
  }
});
