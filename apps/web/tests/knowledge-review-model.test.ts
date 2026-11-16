import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeGenerationItem, KnowledgeGenerationRunView } from "@codeflowai/shared";
import { knowledgeDocumentReviewActivity } from "../src/features/project-knowledge/knowledgeReviewModel.js";

/** 仅提供状态判定使用的真实任务字段，默认模拟已生成并进入独立复检。 */
function run(overrides: Partial<KnowledgeGenerationRunView> = {}): KnowledgeGenerationRunView {
  const item: KnowledgeGenerationItem = { id: "item", nodeId: "data", title: "数据规范", status: "completed", revisionId: "v1", expectedHash: null, instructions: "", inheritedInstructions: "", error: null, review: { status: "pending", reportId: null, error: null } };
  return { schemaVersion: 1, id: "review", createdAt: "2026-10-23", mode: "review", nodeId: null, prompt: "", engine: "codex", model: null, effort: null, treeHash: null, proposedTree: null, rationale: "", gaps: [], items: [item], phase: "generating", error: null, active: true, activeItemId: "item", activeItemStages: [{ itemId: "item", stage: "reviewing" }], ...overrides };
}

test("独立复检按确切节点和版本显示，其他文件、旧版本和终态不转圈", () => {
  const reviewing = run();
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "正在复检，请稍候…");
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "other", "v1"), null);
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v0"), null);
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", null), null);
  assert.equal(knowledgeDocumentReviewActivity([{ ...reviewing, active: false }], "data", "v1"), null);
});

test("并发任务使用每项阶段，排队、复检与修订互不混淆", () => {
  const reviewing = run({ activeStage: "generating", activeItemStages: [{ itemId: "item", stage: "queued" }] });
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "等待复检…");
  reviewing.items[0]!.review!.status = "repairing";
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "等待修订…");
  reviewing.activeItemStages = [{ itemId: "item", stage: "generating" }];
  reviewing.items[0]!.repairRevisionId = "v1";
  reviewing.items[0]!.revisionId = null;
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "正在根据问题修订…");
  reviewing.items[0]!.review!.status = "pending";
  reviewing.items[0]!.revisionId = "v2";
  reviewing.activeItemStages = [{ itemId: "item", stage: "reviewing" }];
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), null, "新版本开始复检后，旧修订依据不显示复检中");
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v2"), "正在复检，请稍候…");
});

test("历史活动摘要沿用单项阶段，同批未执行的文件不显示活动", () => {
  const reviewing = run({ activeItemStages: undefined, activeStage: "reviewing" });
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "正在复检，请稍候…");
  reviewing.activeItemId = "other";
  reviewing.items.push({ ...reviewing.items[0]!, id: "other", nodeId: "other-data" });
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), null);
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "other-data", "v1"), "正在复检，请稍候…");
  reviewing.items[0]!.review!.status = "repairing";
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), null);
  reviewing.activeItemId = "item";
  reviewing.activeStage = undefined;
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), "等待修订…");
  reviewing.items[0]!.review!.status = "passed";
  assert.equal(knowledgeDocumentReviewActivity([reviewing], "data", "v1"), null);
});
