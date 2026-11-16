import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { SkillDefinition, SkillPackageFile } from "@codeflowai/shared";
import { buildSkillScriptToolEntries, installSkillPackage, uninstallSkillPackage } from "../src/orchestration/skillPackageService.js";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";

const fixtureDbs = new Map<string, ClientDb>();

/** 所有安装和递归删除探针仅在本例独占目录，不读写用户 Skill 或真实工作区。 */
function fixture(t: test.TestContext) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const workspacePath = fs.mkdtempSync(path.join(tempRoot, "codeflow-skill-preflight-"));
  const db = openClientDb({ dbPath: path.join(workspacePath, "application.db") });
  db.workspaces.upsert({ id: skill().workspaceId, title: "预检", path: workspacePath });
  fixtureDbs.set(workspacePath, db);
  t.after(() => {
    fixtureDbs.delete(workspacePath); db.close();
    assert.equal(path.dirname(workspacePath), tempRoot);
    assert.ok(path.basename(workspacePath).startsWith("codeflow-skill-preflight-"));
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  for (const directory of [".codex/skills", ".codeflowai/skill-runtime"]) {
    fs.mkdirSync(path.join(workspacePath, directory), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, directory, "keep.txt"), "unrelated-skill-marker", "utf8");
  }
  return workspacePath;
}

/** 构造完整本地 Skill 定义，以真实公开安装和工具注册入口消费。 */
function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "preflight-skill" as any, workspaceId: "preflight-workspace" as any,
    name: "预检 Skill", slug: "preflight", description: "测试", trigger: "测试", instructions: "测试",
    targetEngines: ["codex"], tags: [], packageVersion: 1, skillMd: "# Skill\n", packageHash: "package-v1",
    files: [file("SKILL.md", "# Skill\n"), file("scripts/run.mjs", "printJson({ ok: true });")],
    scripts: [{ id: "run", name: "运行", description: "测试", scriptPath: "scripts/run.mjs", runtime: "node", inputSchema: null, outputSchema: null, timeoutMs: 1_000, requiresWrite: false, exposeAsTool: true }],
    installTargets: ["codex"], kind: "custom", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

/** 使用实际文本内容构造包文件，摘要不参与本片路径预检。 */
function file(relPath: string, contentText: string): SkillPackageFile {
  return { relPath, kind: relPath === "SKILL.md" ? "skill-md" : "script", contentText, contentBase64: null, contentType: "text/plain", sizeBytes: Buffer.byteLength(contentText), sha256: "" };
}

/** 返回所有文件相对路径及字节，用于核对失败前后完整夹具未变。 */
function snapshot(directory: string, prefix = ""): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(entries, snapshot(absolute, relative));
    else entries[relative] = fs.readFileSync(absolute).toString("base64");
  }
  return entries;
}

for (const slug of [".", "..", "...", "preflight."]) {
  for (const operation of ["install", "uninstall", "runtime"] as const) {
    test(`${operation} rejects folder ${slug} before touching any sibling or parent content`, async (t) => {
      const workspacePath = fixture(t);
      const definition = skill({ slug });
      const before = snapshot(workspacePath);
      if (operation === "runtime") {
        assert.throws(() => buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [definition] }));
      } else {
        const execute = operation === "install" ? installSkillPackage : uninstallSkillPackage;
        await assert.rejects(execute({ workspacePath, skill: definition, targets: ["codex"] }));
      }
      assert.deepEqual(snapshot(workspacePath), before);
    });
  }
}

test("installation checks every package path before deleting the currently installed package", async (t) => {
  const workspacePath = fixture(t);
  const definition = skill();
  const installed = await installSkillPackage({ workspacePath, skill: definition, targets: ["codex"] });
  assert.equal(installed[0].ok, true);
  const before = snapshot(workspacePath);
  const invalid = skill({ files: [file("SKILL.md", "changed-before-error"), file("../outside.txt", "invalid")] });
  const result = await installSkillPackage({ workspacePath, skill: invalid, targets: ["codex"] });
  assert.equal(result[0].ok, false);
  assert.deepEqual(snapshot(workspacePath), before);
});

test("runtime materialization checks every package path before replacing a prior runtime copy", (t) => {
  const workspacePath = fixture(t);
  const definition = skill();
  buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [definition] });
  const before = snapshot(workspacePath);
  const invalid = skill({ packageHash: "package-v2", files: [file("SKILL.md", "changed-before-error"), file("../outside.txt", "invalid")] });
  assert.throws(() => buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [invalid] }));
  assert.deepEqual(snapshot(workspacePath), before);
});

for (const invalidPath of ["", ".", "nul\0path", "absolute"]) {
  test(`invalid package file path leaves both installed targets and runtime copy unchanged (${invalidPath.replace("\0", "NUL")})`, async (t) => {
    const workspacePath = fixture(t);
    const definition = skill({ targetEngines: ["codex", "claude"] });
    const installed = await installSkillPackage({ workspacePath, skill: definition, targets: ["codex", "claude"] });
    assert.deepEqual(installed.map(item => item.ok), [true, true]);
    buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [definition] });
    const before = snapshot(workspacePath);
    const relPath = invalidPath === "absolute" ? path.join(installed[0].installedPath, "absolute.txt") : invalidPath;
    const invalid = { ...definition, packageHash: "package-v2", files: [file("SKILL.md", "changed-before-error"), file(relPath, "invalid")] };
    const result = await installSkillPackage({ workspacePath, skill: invalid, targets: ["codex", "claude"] });
    assert.deepEqual(result.map(item => item.ok), [false, false]);
    assert.throws(() => buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [invalid] }));
    assert.deepEqual(snapshot(workspacePath), before);
  });
}

test("valid nested files still install, materialize and uninstall only their own package", async (t) => {
  const workspacePath = fixture(t);
  const definition = skill({ files: [...skill().files!, file("references/readme.txt", "reference-content")] });
  const installed = await installSkillPackage({ workspacePath, skill: definition, targets: ["codex"] });
  assert.equal(installed[0].ok, true);
  assert.equal(fs.readFileSync(path.join(installed[0].installedPath, "references/readme.txt"), "utf8"), "reference-content");
  const [entry] = buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [definition] });
  assert.equal(fs.readFileSync(path.join(workspacePath, entry.tool.workingDirectory!, "references/readme.txt"), "utf8"), "reference-content");
  const result = await uninstallSkillPackage({ workspacePath, skill: definition, targets: ["codex"] });
  assert.equal(result[0].ok, true);
  assert.equal(fs.existsSync(installed[0].installedPath), false);
  assert.equal(fs.readFileSync(path.join(workspacePath, ".codex/skills/keep.txt"), "utf8"), "unrelated-skill-marker");
  assert.equal(fs.readFileSync(path.join(workspacePath, ".codeflowai/skill-runtime/keep.txt"), "utf8"), "unrelated-skill-marker");
});

for (const paths of [
  ["scripts/run.mjs", "scripts/run.mjs/child.txt"],
  ["references/child.txt", "references"],
  ["references/one.txt", "references/./one.txt"],
  ["SKILL.md/child.txt"],
  [".codeflowai-skill.json"],
]) {
  test(`conflicting package paths leave installed and runtime copies intact (${paths.join(", ")})`, async (t) => {
    const workspacePath = fixture(t);
    const definition = skill();
    const [installed] = await installSkillPackage({ workspacePath, skill: definition, targets: ["codex"] });
    assert.equal(installed.ok, true);
    buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [definition] });
    const before = snapshot(workspacePath);
    const invalid = skill({ packageHash: "package-v2", files: paths.map(relPath => file(relPath, "conflicting-content")) });
    const [result] = await installSkillPackage({ workspacePath, skill: invalid, targets: ["codex"] });
    assert.equal(result.ok, false);
    assert.deepEqual(snapshot(workspacePath), before);
    assert.throws(() => buildSkillScriptToolEntries({ db: fixtureDbs.get(workspacePath)!, requestId: "preflight", workspacePath, workspaceId: definition.workspaceId, skills: [invalid] }));
    assert.deepEqual(snapshot(workspacePath), before);
  });
}
