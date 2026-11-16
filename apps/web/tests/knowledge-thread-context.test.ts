import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeConversationSummary, KnowledgeGenerationRunView } from "@codeflowai/shared";
import { resolveKnowledgeThreadContext } from "../src/features/project-knowledge/knowledgeThreadContext.ts";

const owner: KnowledgeConversationSummary = {
  threadId: "owner", nodeId: null, createdByUserId: "user", title: "项目讨论", engine: "codex",
  model: "gpt-test", effort: "high", active: true, createdAt: 1, updatedAt: 1,
};
/** 任务夹具保留真实父子关系，覆盖旧独立复检和当前子任务。 */
function run(active = false): KnowledgeGenerationRunView {
  return {
    schemaVersion: 1, id: "run", createdAt: "2026-10-22T00:00:00Z", mode: "batch", nodeId: null,
    ownerThreadId: owner.threadId, engine: "codex", model: "gpt-test", effort: "high", prompt: "",
    treeHash: null, proposedTree: null, rationale: "", gaps: [], phase: active ? "generating" : "completed",
    error: null, active, activeItemId: active ? "item" : null,
    items: [{ id: "item", nodeId: "spec", title: "界面规范", status: "completed", revisionId: "revision",
      expectedHash: null, inheritedInstructions: "", instructions: "", error: null,
      executionThreadId: "generation", review: { status: "issues", reportId: "report", executionThreadId: "review", error: null } }],
  };
}

test("规格讨论与文件工作沿用原宿主、节点及授权；无关任务不会锁定输入", () => {
  assert.deepEqual(resolveKnowledgeThreadContext("owner", [owner], []), {
    ownerThreadId: "owner", nodeId: null, title: "项目讨论", kind: "规格讨论", active: true, busy: false, generationThreadId: null,
  });
  const unrelated = { ...run(true), ownerThreadId: "other", items: [] };
  assert.deepEqual(resolveKnowledgeThreadContext("generation", [owner], [run(), unrelated]), {
    ownerThreadId: "owner", nodeId: "spec", title: "界面规范", kind: "文件工作", active: true, busy: false, generationThreadId: "generation",
  });
  assert.equal(resolveKnowledgeThreadContext("ordinary", [owner], [run()]), null);
});

test("批任务和本线程续聊都锁定修订，结束或缺失授权不会自动恢复", () => {
  assert.equal(resolveKnowledgeThreadContext("generation", [owner], [run(true)])?.busy, true);
  assert.equal(resolveKnowledgeThreadContext("owner", [owner], [run(true)])?.busy, true);
  const followUp = { ...run(true), mode: "conversation" as const, threadId: "generation", ownerThreadId: "generation", items: [] };
  assert.equal(resolveKnowledgeThreadContext("generation", [owner], [followUp, run()])?.busy, true);
  assert.equal(resolveKnowledgeThreadContext("generation", [{ ...owner, active: false }], [run()])?.active, false);
  assert.equal(resolveKnowledgeThreadContext("generation", [], [run()])?.active, false);
  const adopting: KnowledgeGenerationRunView = { ...run(), ownerThreadId: "other", items: [], adoptions: [{
    requestId: "adopt", treeHash: null, planHash: "plan", selections: [], completed: false, error: null,
    targetTree: { schemaVersion: 3, instructions: "", nodes: [] }, targetTreeHash: "target",
  }] };
  assert.equal(resolveKnowledgeThreadContext("generation", [owner], [run(), adopting])?.busy, true);
});

test("历史复检可定位文件工作会话，内部复检不会误认为项目讨论", () => {
  const result = resolveKnowledgeThreadContext("review", [owner], [run()]);
  assert.equal(result?.kind, "复检");
  assert.equal(result?.generationThreadId, "generation");
  assert.equal(result?.nodeId, "spec");
  const nested = run();
  nested.items[0].review!.parentThreadId = "generation";
  assert.equal(resolveKnowledgeThreadContext("generation", [owner], [nested])?.kind, "文件工作");
});

test("一键生成的规划线程在尚无正文任务时也能找到原宿主，并跟随整个任务占用状态", () => {
  const planning = { ...run(true), mode: "build" as const, planningThreadId: "planning", phase: "planning" as const, items: [] };
  assert.deepEqual(resolveKnowledgeThreadContext("planning", [owner], [planning]), {
    ownerThreadId: "owner", nodeId: null, title: "筛选与组织项目知识", kind: "知识规划", active: true, busy: true, generationThreadId: null,
  });
  assert.equal(resolveKnowledgeThreadContext("planning", [owner], [{ ...planning, phase: "generating", items: run().items }])?.busy, true);
  const completed = { ...planning, active: false, phase: "completed" as const };
  assert.equal(resolveKnowledgeThreadContext("planning", [owner], [completed])?.busy, false);
  assert.equal(resolveKnowledgeThreadContext("planning", [{ ...owner, active: false }], [completed])?.active, false);
  assert.equal(resolveKnowledgeThreadContext("planning", [], [completed])?.active, false);
});
