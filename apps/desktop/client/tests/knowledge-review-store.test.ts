import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { KnowledgeAssetSource, KnowledgeReviewIssue } from "@codeflowai/shared";
import { KnowledgeAssetError, knowledgeHash, knowledgeJson } from "../src/knowledge/knowledgeAssetFiles.js";
import { KnowledgeAssetStore } from "../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeReviewStore, type KnowledgeReviewSubmission } from "../src/knowledge/knowledgeReviewStore.js";

function project(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-knowledge-review-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "permissions.ts"), "export function allowed(role: string) {\n  return role === 'owner';\n}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# 权限\n只有所有者可写。\n");
  const store = new KnowledgeAssetStore(root);
  store.saveTree({ schemaVersion: 1, instructions: "依据实现说明权限", nodes: [
    { id: "standards", parentId: null, title: "规范", orderKey: "1", summary: "", tags: [], instructions: "列出禁止行为", sourceScope: ["src"] },
    { id: "permissions", parentId: "standards", title: "权限", orderKey: "1", summary: "", tags: [], instructions: "覆盖角色", sourceScope: ["README.md"] },
  ] }, null);
  const source: KnowledgeAssetSource = { kind: "code", path: "src/permissions.ts", contentHash: store.readSource("src/permissions.ts").contentHash, startLine: 1, endLine: 3, relation: "权限实现" };
  const revision = store.saveDocument({ nodeId: "permissions", content: "# 权限\n\n所有者可以写。\n其他角色不能写。", sources: [source], expectedHash: null, origin: "ai", adopt: false });
  const reviews = new KnowledgeReviewStore(store);
  const snapshot = reviews.snapshot("permissions", revision.id);
  const input: KnowledgeReviewSubmission = { runId: "run_review", engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", outcome: "passed", summary: "权限说明与角色判断一致。", issues: [], sources: [source] };
  const issue: KnowledgeReviewIssue = { id: "issue_permission", severity: "error", category: "factual", title: "权限说明不符", detail: "代码只允许所有者。", documentStartLine: 3, documentEndLine: 4, sources: [source], suggestion: "修正角色范围。" };
  return { root, store, reviews, source, revision, snapshot, input, issue };
}

function isCode(code: string) { return (error: unknown) => error instanceof KnowledgeAssetError && error.code === code; }

test("复检报告跟随项目共享，首份正文可先作为草稿复检，采用同版本不使结论过期", t => {
  const { root, store, reviews, snapshot, input, revision } = project(t);
  assert.equal(store.detail("permissions").current, null);
  assert.equal(store.detail("permissions").drafts[0]?.id, revision.id);
  const report = reviews.save(snapshot, input);
  assert.equal(report.contentHash, revision.contentHash);
  assert.equal(report.sourcesHash, revision.sourcesHash);
  assert.equal(report.instructionsHash, knowledgeHash(knowledgeJson(["依据实现说明权限\n\n列出禁止行为\n\n覆盖角色", revision.instructions])));
  assert.equal(report.sourceHashes[0]?.path, "src/permissions.ts");
  const secondClient = new KnowledgeReviewStore(new KnowledgeAssetStore(root));
  assert.equal(secondClient.list("permissions")[0]?.stale, false);
  store.adopt("permissions", revision.id, null);
  assert.equal(secondClient.list("permissions")[0]?.stale, false);
  assert.equal(secondClient.list("permissions")[0]?.id, report.id);
  assert.deepEqual(secondClient.list("standards"), []);
});

test("只有 warning 的复检视为通过并保留提醒，旧 issues 报告读取时归一化", t => {
  const { store, reviews, snapshot, input, source } = project(t);
  const warning: KnowledgeReviewIssue = {
    id: "issue_style", severity: "warning", category: "coverage", title: "可补充示例",
    detail: "当前正文没有示例，但不影响已确认行为。", documentStartLine: 1, documentEndLine: 2,
    sources: [source], suggestion: "有需要时再补充一个简短示例。",
  };
  const report = reviews.save(snapshot, { ...input, outcome: "passed_with_warnings", issues: [warning] });
  assert.equal(report.outcome, "passed_with_warnings");
  assert.equal(reviews.list("permissions")[0]?.outcome, "passed_with_warnings");
  store.files.write(`${store.root}/assets/permissions/reviews/${report.id}.json`, knowledgeJson({ ...report, outcome: "issues" }));
  assert.equal(reviews.list("permissions")[0]?.outcome, "passed_with_warnings");
});

test("采用正在被复检的同一版本允许提交，后续新版本使旧报告过期且保留历史", t => {
  const { store, reviews, snapshot, input, revision, source } = project(t);
  store.adopt("permissions", revision.id, null);
  reviews.save(snapshot, input);
  const next = store.saveDocument({ nodeId: "permissions", content: "# 权限\n更新后的文档", sources: [source], expectedHash: store.currentHash("permissions"), origin: "ai" });
  const old = reviews.list("permissions")[0]!;
  assert.equal(old.stale, true);
  assert.match(old.staleReasons.join(" "), /新.*版本/);
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_CONFLICT"));
  reviews.save(reviews.snapshot("permissions", next.id), input);
  const history = reviews.list("permissions");
  assert.equal(history.length, 2);
  assert.equal(history.find(item => item.revisionId === next.id)?.stale, false);
  assert.equal(history.find(item => item.revisionId === revision.id)?.stale, true);
});

test("继承要求改变使报告过期，并拒绝复检中途的配置漂移", t => {
  const { store, reviews, snapshot, input } = project(t);
  reviews.save(snapshot, input);
  const tree = store.readTree();
  tree.tree.nodes[0]!.instructions = "新增失败反馈要求";
  store.saveTree(tree.tree, tree.hash);
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_CONFLICT"));
  assert.match(reviews.list("permissions")[0]!.staleReasons.join(" "), /有效要求/);
});

test("来源范围配置改变使报告过期，无关节点标题调整不会过期", t => {
  const { store, reviews, snapshot, input } = project(t);
  reviews.save(snapshot, input);
  let tree = store.readTree();
  tree.tree.nodes[0]!.title = "研发规范";
  store.saveTree(tree.tree, tree.hash);
  assert.equal(reviews.list("permissions")[0]!.stale, false);
  tree = store.readTree();
  tree.tree.nodes[0]!.sourceScope = ["src/permissions.ts"];
  store.saveTree(tree.tree, tree.hash);
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_CONFLICT"));
  assert.match(reviews.list("permissions")[0]!.staleReasons.join(" "), /来源范围/);
});

test("源码变化拒绝旧快照；重新读取现行源码后可记录有依据的问题", t => {
  const { root, store, reviews, snapshot, input, revision, issue } = project(t);
  reviews.save(snapshot, input);
  fs.writeFileSync(path.join(root, "src", "permissions.ts"), "export function allowed(role: string) {\n  return role === 'owner' || role === 'admin';\n}\n");
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_SOURCE_CHANGED"));
  assert.match(reviews.list("permissions")[0]!.staleReasons.join(" "), /来源已变化/);
  const source = { ...input.sources[0]!, contentHash: store.readSource("src/permissions.ts").contentHash };
  reviews.save(reviews.snapshot("permissions", revision.id), { ...input, outcome: "issues", sources: [source], issues: [{ ...issue, sources: [source] }] });
  const current = reviews.list("permissions").find(report => report.outcome === "issues")!;
  assert.equal(current.stale, false);
  assert.equal(current.sourceHashes[0]!.contentHash, source.contentHash);
});

test("额外核对文档的变更也会使复检结论过期", t => {
  const { root, store, reviews, snapshot, input } = project(t);
  const other = { kind: "document" as const, path: "README.md", contentHash: store.readSource("README.md").contentHash, startLine: 1, endLine: 2, relation: "跨文档权限说明" };
  reviews.save(snapshot, { ...input, sources: [...input.sources, other] });
  fs.appendFileSync(path.join(root, "README.md"), "管理员也可写。\n");
  assert.match(reviews.list("permissions")[0]!.staleReasons.join(" "), /README\.md/);
});

test("缺失来源会记录缺失状态，来源恢复后需重新复检", t => {
  const { root, store, reviews, input, revision, issue } = project(t);
  fs.unlinkSync(path.join(root, "src", "permissions.ts"));
  const snapshot = reviews.snapshot("permissions", revision.id);
  assert.equal(snapshot.sourceHashes[0]!.contentHash, null);
  const other = { kind: "document" as const, path: "README.md", contentHash: store.readSource("README.md").contentHash, startLine: 1, endLine: 2, relation: "原实现已缺失，仅保留规范证据" };
  reviews.save(snapshot, { ...input, outcome: "issues", sources: [other], issues: [{ ...issue, sources: [other] }] });
  assert.equal(reviews.list("permissions")[0]!.stale, false);
  fs.writeFileSync(path.join(root, "src", "permissions.ts"), "export const allowed = false;\n");
  assert.equal(reviews.list("permissions")[0]!.stale, true);
});

test("正文在文件系统被修改时拒绝提交，并将历史报告显示为过期", t => {
  const { store, reviews, snapshot, input } = project(t);
  reviews.save(snapshot, input);
  store.files.write(snapshot.document.path, "# 外部修改\n");
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_CONFLICT"));
  assert.equal(reviews.list("permissions")[0]!.stale, true);
});

test("复检结论与问题、正文定位、依据行号和来源指纹必须一致", t => {
  const { reviews, snapshot, input, issue } = project(t);
  const invalid: KnowledgeReviewSubmission[] = [
    { ...input, issues: [issue] },
    { ...input, outcome: "issues" },
    { ...input, sources: [] },
    { ...input, sources: [{ ...input.sources[0]!, contentHash: "fake" }] },
    { ...input, sources: [{ ...input.sources[0]!, endLine: 200 }] },
    { ...input, sources: [{ ...input.sources[0]!, startLine: undefined }] },
    { ...input, outcome: "issues", issues: [{ ...issue, documentStartLine: 0 }] },
    { ...input, outcome: "issues", issues: [{ ...issue, documentEndLine: 200 }] },
    { ...input, outcome: "issues", issues: [{ ...issue, sources: [] }] },
    { ...input, outcome: "issues", issues: [{ ...issue, suggestion: "" }] },
    { ...input, outcome: "issues", issues: [issue, issue] },
    { ...input, outcome: "issues", sources: [{ ...input.sources[0]!, startLine: 1, endLine: 1 }], issues: [issue] },
  ];
  for (const submission of invalid) assert.throws(() => reviews.save(snapshot, submission), isCode("KNOWLEDGE_ASSET_INPUT_INVALID"));
  assert.throws(() => reviews.save(snapshot, { ...input, sources: [{ ...input.sources[0]!, contentHash: "0".repeat(64) }] }), isCode("KNOWLEDGE_ASSET_SOURCE_CHANGED"));
  assert.deepEqual(reviews.list("permissions"), []);
});

test("复检证据禁止敏感路径及项目外路径", t => {
  const { reviews, snapshot, input } = project(t);
  for (const sourcePath of ["env/.env", ".ssh/id_rsa", "cert.key", "../outside.ts", "C:/outside.ts"]) {
    assert.throws(() => reviews.save(snapshot, { ...input, sources: [{ ...input.sources[0]!, path: sourcePath }] }), isCode("KNOWLEDGE_ASSET_PATH_INVALID"));
  }
  assert.deepEqual(reviews.list("permissions"), []);
});

test("损坏的复检报告不能被当成有效通过结论", t => {
  const { store, reviews, snapshot, input, issue } = project(t);
  const report = reviews.save(snapshot, input);
  for (const invalid of [
    { ...report, contentHash: "broken" },
    { ...report, issues: [issue] },
    { ...report, sources: [] },
    { ...report, sources: [null] },
    { ...report, sources: [{ ...report.sources[0]!, endLine: 0 }] },
    { ...report, sources: [{ ...report.sources[0]!, path: "env/.env" }] },
  ]) {
    store.files.write(`${store.root}/assets/permissions/reviews/${report.id}.json`, knowledgeJson(invalid));
    assert.throws(() => reviews.list("permissions"), isCode("KNOWLEDGE_ASSET_FILE_INVALID"));
  }
});

test("证据不再是可读文本时，历史报告显示过期而非沿用通过结论", t => {
  const { root, reviews, snapshot, input } = project(t);
  reviews.save(snapshot, input);
  fs.writeFileSync(path.join(root, "src", "permissions.ts"), Buffer.from([0, 1, 2]));
  const report = reviews.list("permissions")[0]!;
  assert.equal(report.stale, true);
  assert.match(report.staleReasons.join(" "), /无法读取/);
});

test("归档资产保留已有报告，但拒绝新报告", t => {
  const { store, reviews, snapshot, input } = project(t);
  reviews.save(snapshot, input);
  const tree = store.readTree();
  tree.tree.nodes[0]!.archived = true;
  store.saveTree(tree.tree, tree.hash);
  assert.throws(() => reviews.save(snapshot, input), isCode("KNOWLEDGE_ASSET_CONFLICT"));
  assert.equal(reviews.list("permissions").length, 1);
});
