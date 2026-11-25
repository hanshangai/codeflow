import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeAssetRequest } from "../../packages/shared/src/knowledgeAssetContract.ts";

test("来源更新任务的确切版本字段通过共享generate请求契约", () => {
  const request = {
    workspaceId: "local:workspace", requestId: "refresh-1", mode: "batch", ownerThreadId: "thread-owner",
    selectedNodeIds: ["spec"], includeDescendants: false, strategy: "all", prompt: "更新来源", treeHash: null,
    engine: "claude", model: "deepseek-flash", effort: "high", concurrency: 1,
    reviewConfig: { enabled: true, model: "deepseek-flash", effort: "high", autoRepair: true, maxRounds: 2 },
    sourceRevisions: [{ nodeId: "spec", revisionId: "revision-old" }],
  };
  assert.deepEqual(parseKnowledgeAssetRequest("generate", request), request);
  assert.equal(parseKnowledgeAssetRequest("generate", { ...request, sourceRevision: request.sourceRevisions[0] }), null);
});
