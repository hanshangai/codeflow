import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSkillSuiteInfo } from "../src/skills/communitySkillsInstaller.ts";

test("normalizeSkillSuiteInfo 按安装类型校验来源字段", () => {
  // github（默认类型）
  const github = normalizeSkillSuiteInfo({ suiteId: "a", name: "A", repoUrl: "https://github.com/org/repo", source: "custom" });
  assert.equal(github?.installType, "github");
  assert.equal(github?.repoUrl, "https://github.com/org/repo");
  assert.equal(github?.gitUrl, undefined);
  assert.equal(github?.localPath, undefined);
  assert.equal(github?.archiveUrl, undefined);

  // git 类型
  const git = normalizeSkillSuiteInfo({ suiteId: "b", name: "B", installType: "git", gitUrl: "https://gitlab.example.com/org/repo", source: "custom" });
  assert.equal(git?.installType, "git");
  assert.equal(git?.gitUrl, "https://gitlab.example.com/org/repo");
  assert.equal(git?.repoUrl, undefined);

  // local 类型
  const local = normalizeSkillSuiteInfo({ suiteId: "c", name: "C", installType: "local", localPath: "/tmp/skills", source: "custom" });
  assert.equal(local?.installType, "local");
  assert.equal(local?.localPath, "/tmp/skills");

  // url 类型
  const url = normalizeSkillSuiteInfo({ suiteId: "d", name: "D", installType: "url", archiveUrl: "https://example.com/skills.zip", source: "custom" });
  assert.equal(url?.installType, "url");
  assert.equal(url?.archiveUrl, "https://example.com/skills.zip");
});

test("normalizeSkillSuiteInfo 缺少对应来源字段时返回 null", () => {
  assert.equal(normalizeSkillSuiteInfo({ suiteId: "e", name: "E", installType: "git" }), null);
  assert.equal(normalizeSkillSuiteInfo({ suiteId: "f", name: "F", installType: "local" }), null);
  assert.equal(normalizeSkillSuiteInfo({ suiteId: "g", name: "G", installType: "url" }), null);
  // 缺 name
  assert.equal(normalizeSkillSuiteInfo({ suiteId: "h", repoUrl: "https://github.com/org/repo" }), null);
  // 缺 suiteId
  assert.equal(normalizeSkillSuiteInfo({ name: "I", repoUrl: "https://github.com/org/repo" }), null);
});

test("normalizeSkillSuiteInfo 保留来源字段用于状态往返回读", () => {
  const normalized = normalizeSkillSuiteInfo({ suiteId: "x", name: "X", installType: "git", gitUrl: "https://g/org", source: "custom" });
  assert.ok(normalized);
  // 模拟 writeState 后 listInstalledCustomSkillSuites 回读
  const roundtrip = normalizeSkillSuiteInfo(normalized);
  assert.equal(roundtrip?.installType, "git");
  assert.equal(roundtrip?.gitUrl, "https://g/org");
  assert.equal(roundtrip?.source, "custom");
});
