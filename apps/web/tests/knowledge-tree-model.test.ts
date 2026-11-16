import assert from "node:assert/strict";
import test from "node:test";
import type { KnowledgeAssetNode } from "@codeflowai/shared";
import { knowledgeAdoptionSelection, knowledgeNodeHasBody, knowledgeSelectedNodes, knowledgeTreeRows } from "../src/features/project-knowledge/knowledgeTreeModel.js";
const node = (id: string, parentId: string | null = null, archived = false): KnowledgeAssetNode => ({ id, parentId, title: id, orderKey: id, summary: "", instructions: "", sourceScope: [], tags: [], archived });
const nodes = [node("a"), node("b", "a"), node("c", "b"), node("d")];
test("目录展开与浏览选择独立，折叠后只保留可见行", () => {
  assert.deepEqual(knowledgeTreeRows(nodes, new Set()).map(r => r.node.id), ["a", "d"]);
  assert.deepEqual(knowledgeTreeRows(nodes, new Set(["a"])).map(r => r.node.id), ["a", "b", "d"]);
});
test("搜索临时展开命中路径，不修改用户展开集合", () => {
  const expanded = new Set<string>();
  assert.deepEqual(knowledgeTreeRows(nodes, expanded, "c").map(r => [r.node.id, r.depth]), [["a", 0], ["b", 1], ["c", 2]]);
  assert.equal(expanded.size, 0);
  assert.deepEqual(knowledgeTreeRows(nodes, expanded).map(r => r.node.id), ["a", "d"]);
});
test("多选目录默认只选自身，明确包含后代时去重", () => {
  assert.deepEqual(knowledgeSelectedNodes(nodes, ["a", "c"], false).map(n => n.id), ["a", "c"]);
  assert.deepEqual(knowledgeSelectedNodes(nodes, ["a", "b"], true).map(n => n.id), ["a", "b", "c"]);
});
test("归档目录的后代不可穿透选入批任务", () => {
  const archived = [node("a", null, true), node("b", "a"), node("c")];
  assert.deepEqual(knowledgeSelectedNodes(archived, ["b", "c"], true).map(n => n.id), ["c"]);
  assert.deepEqual(knowledgeTreeRows(archived, new Set(["a"])).map(r => r.node.id), ["c"]);
});
test("大量节点只展开可见层，循环和孤立节点不会无限遍历", () => {
  const large = [node("root"), ...Array.from({ length: 10000 }, (_, i) => node(String(i), "root")), node("loop", "loop")];
  assert.equal(knowledgeTreeRows(large, new Set()).length, 1);
  assert.equal(knowledgeTreeRows(large, new Set(["root"])).length, 10001);
});

test("目录与实时引用不作为空白正文，旧节点和解释性专题保留正文语义", () => {
  assert.equal(knowledgeNodeHasBody({ ...node("directory"), contentMode: "directory" }), false);
  assert.equal(knowledgeNodeHasBody({ ...node("reference"), contentMode: "reference" }), false);
  assert.equal(knowledgeNodeHasBody({ ...node("topic"), contentMode: "generated" }), true);
  assert.equal(knowledgeNodeHasBody(node("legacy")), true);
});

test("统一采用勾选子项补齐必要祖先，取消目录同步取消后代且保留其他分支", () => {
  const allowed = new Set(nodes.map(node => node.id));
  assert.deepEqual(new Set(knowledgeAdoptionSelection(nodes, ["d"], "c", true, allowed)), new Set(["a", "b", "c", "d"]));
  assert.deepEqual(knowledgeAdoptionSelection(nodes, ["a", "b", "c", "d"], "b", false, allowed), ["a", "d"]);
  assert.deepEqual(knowledgeAdoptionSelection(nodes, [], "c", true, new Set(["c"])), ["c"]);
});
