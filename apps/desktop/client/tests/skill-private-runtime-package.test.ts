import assert from "node:assert/strict";
import crypto from "node:crypto";
import childProcess, { execFile, execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { ExecutableToolDescriptor, SkillDefinition, SkillPackageFile } from "@codeflowai/shared";
import { buildSkillScriptToolEntries } from "../src/orchestration/skillPackageService.js";
import { ToolRuntimeService } from "../src/orchestration/toolRuntimeService.js";
import { logger } from "../src/logger.js";
import { openClientDb, type ClientDb } from "../src/db/clientDb.js";
import { WorkspaceOperationGate } from "../src/workspace-migration/workspaceOperationGate.js";

const fixtureDbs = new Map<string, ClientDb>();
const closedFixtureDbs = new Set<ClientDb>();

/** 复用本例真实注册 W 能力，不为执行另开数据库。 */
function runtime(workspacePath: string): ToolRuntimeService {
  const db = fixtureDbs.get(workspacePath); assert.ok(db);
  return new ToolRuntimeService(workspacePath, { db, workspaceId: skill().workspaceId });
}

test("execute damaged retained Skill preserves its owned log failure before allocating runtime files", async t => {
  const { workspacePath, db, errors, applicationErrors } = fixture(t), execution = register(workspacePath);
  const retained = path.join(workspacePath, execution.workingDirectory!), resource = path.join(retained, "references/value.txt");
  fs.writeFileSync(resource, "damaged"); const retainedBefore = fs.readFileSync(resource);
  const logging = new Error("execute-log-root");
  const log = t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  const spawn = t.mock.method(childProcess, "spawn", () => assert.fail("invalid retained Skill must not spawn")); syncBuiltinESMExports();
  await assert.rejects(runtime(workspacePath).execute(execution, {}, "current", { requestId: "Skill执行😀", turnId: "skill-turn" }), (error: any) => {
    assert.equal(error.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED");
    assert.equal(error.errors[0].code, "SKILL_RUNTIME_PACKAGE_INVALID"); assert.equal(error.errors[1], logging);
    assert.equal(error.cause, error.errors[0]); assert.equal(error.parentRequestId, "Skill执行😀");
    return true;
  });
  const parent = path.join(workspacePath, ".codeflowai", "tool-runtime");
  assert.equal(log.mock.callCount(), 1); assert.equal(spawn.mock.callCount(), 0);
  assert.equal(applicationErrors.length, 0); assert.equal(errors.length, 0); assert.equal(fs.existsSync(parent), false);
  assert.deepEqual(fs.readFileSync(resource), retainedBefore);
});

/** 所有文件、链接和 Git 工件只在本例独占 Temp 下创建。 */
function fixture(t: test.TestContext, git = false) {
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempRoot, "codeflow-skill-runtime-"));
  const workspacePath = path.join(root, "workspace");
  fs.mkdirSync(workspacePath);
  const gate = new WorkspaceOperationGate(), db = openClientDb({ dbPath: path.join(root, "application.db"), workspaceOperationGate: gate });
  db.workspaces.upsert({ id: skill().workspaceId, title: "副本😀", path: workspacePath });
  fixtureDbs.set(workspacePath, db);
  if (git) command(workspacePath, ["init", "--quiet"]);
  const errors: Record<string, unknown>[] = [];
  const applicationErrors: Record<string, unknown>[] = [];
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); applicationErrors.push(data); });
  const write = db.writeWorkspaceLog.bind(db);
  t.mock.method(db, "writeWorkspaceLog", ((workspaceId, entry) => { errors.push(entry.data as Record<string, unknown>); write(workspaceId, entry); }) as typeof db.writeWorkspaceLog);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fixtureDbs.delete(workspacePath);
    if (!closedFixtureDbs.delete(db)) db.close();
    assert.equal(path.dirname(root), tempRoot);
    assert.ok(path.basename(root).startsWith("codeflow-skill-runtime-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspacePath, errors, applicationErrors, db, gate };
}

/** 使用真实 Git，参数数组不经 shell。 */
function command(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, windowsHide: true, timeout: 15_000 });
}

/** 摘要与真实字节一致，运行脚本从版本目录读取相对资源。 */
function file(relPath: string, contentText: string): SkillPackageFile {
  return { relPath, contentText, contentBase64: null, kind: relPath === "SKILL.md" ? "skill-md" : "reference", contentType: "text/plain", sizeBytes: Buffer.byteLength(contentText), sha256: crypto.createHash("sha256").update(contentText).digest("hex") };
}

/** 同 slug、同声明 hash 也必须根据实际包字节分版本。 */
function skill(value = "old", overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: "runtime-skill" as any, workspaceId: "runtime-workspace" as any,
    name: "运行副本", slug: "runtime-skill", description: "测试", trigger: "测试", instructions: "测试",
    targetEngines: ["codex"], tags: [], packageVersion: 1, skillMd: "# Skill\n", packageHash: "declared-package",
    files: [file("SKILL.md", "# Skill\n"), file("scripts/run.mjs", "import fs from 'node:fs'; printJson({ value: fs.readFileSync('references/value.txt', 'utf8') });"), file("references/value.txt", value)],
    scripts: [{ id: "run", name: "运行", description: "测试", scriptPath: "scripts/run.mjs", runtime: "node", inputSchema: null, outputSchema: null, timeoutMs: 5_000, requiresWrite: false, exposeAsTool: true }],
    installTargets: ["codex"], kind: "custom", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

/** 经公开注册结果构造真实工具描述符，保持与编排消费字段一致。 */
function register(workspacePath: string, definition = skill()): ExecutableToolDescriptor {
  const db = fixtureDbs.get(workspacePath);
  assert.ok(db);
  const [{ tool, toolset, ref }] = buildSkillScriptToolEntries({ db, requestId: "skill-runtime:test", workspacePath, workspaceId: definition.workspaceId, skills: [definition] });
  return {
    ...tool, toolId: tool.id, toolsetId: toolset.id, toolsetName: toolset.name,
    alias: ref.alias ?? null, usageGuidance: ref.usageGuidance ?? null, invocationHint: tool.invocationHint ?? null,
    permissions: { requiresWrite: Boolean(tool.requiresWrite) }, required: false,
  } as ExecutableToolDescriptor;
}

/** 失败必须保有可检索码、请求关联和根因，日志不含包正文。 */
function runtimeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.equal((error as Error & { code: string }).code, "SKILL_RUNTIME_PACKAGE_INVALID");
  assert.match(error.message, /requestId=(?:skill-runtime|tool-runtime):/);
  assert.ok(error.cause instanceof Error);
  return true;
}

/** 根或 Git 保护同时拒绝 W 日志时，保留生成失败与固定日志失败。 */
function runtimeLogFailure(error: unknown): boolean {
  assert.ok(error instanceof AggregateError);
  assert.equal(Object.getOwnPropertyDescriptor(error, "code")?.value, "SKILL_RUNTIME_FAILURE_LOG_FAILED");
  assert.equal(error.errors.length, 2); assert.equal(error.cause, error.errors[0]);
  return runtimeFailure(error.errors[0]);
}

test("new and old versions execute concurrently from independent private copies", async t => {
  const { workspacePath } = fixture(t);
  const old = register(workspacePath);
  const oldDir = path.join(workspacePath, old.workingDirectory!);
  const marker = fs.readFileSync(path.join(oldDir, ".codeflowai-skill.json"));
  const current = register(workspacePath, skill("new"));
  assert.notEqual(current.workingDirectory, old.workingDirectory);
  assert.match(old.workingDirectory!, /^\.codeflowai\/skill-runtime\//);
  assert.equal(fs.existsSync(path.join(workspacePath, ".codeflow")), false);
  const service = runtime(workspacePath);
  const results = await Promise.all([service.execute(old, {}, "current"), service.execute(current, {}, "current")]);
  assert.deepEqual(results.map(result => result.ok && result.output), [{ value: "old" }, { value: "new" }]);
  assert.deepEqual(fs.readFileSync(path.join(oldDir, ".codeflowai-skill.json")), marker);
  assert.equal(fs.readFileSync(path.join(oldDir, "references/value.txt"), "utf8"), "old");
  const runs = path.join(workspacePath, ".codeflowai", "tool-runtime");
  const directories = fs.readdirSync(runs);
  assert.equal(directories.length, 2);
  for (const directory of directories) {
    assert.equal(fs.existsSync(path.join(runs, directory, "input.json")), true);
    assert.equal(fs.existsSync(path.join(runs, directory, "tool.mjs")), true);
  }
});

test("identical content is reused without rewriting and different skill identities cannot collide", t => {
  const { workspacePath } = fixture(t);
  const first = register(workspacePath);
  const markerPath = path.join(workspacePath, first.workingDirectory!, ".codeflowai-skill.json");
  const before = fs.statSync(markerPath);
  const reordered = skill();
  reordered.files = [...reordered.files!].reverse();
  assert.equal(register(workspacePath, reordered).workingDirectory, first.workingDirectory);
  assert.equal(fs.statSync(markerPath).mtimeMs, before.mtimeMs);
  assert.notEqual(register(workspacePath, skill("old", { id: "another-skill" as any })).workingDirectory, first.workingDirectory);
});

test("missing declared hash still versions implicit SKILL.md and preserves legacy runtime copies", t => {
  const { workspacePath } = fixture(t);
  const legacy = path.join(workspacePath, ".codeflowai/skill-runtime/runtime-skill");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "keep.txt"), "legacy");
  const base = skill("old", { packageHash: null });
  base.files = base.files!.filter(item => item.relPath !== "SKILL.md");
  const first = register(workspacePath, base);
  const second = register(workspacePath, { ...base, skillMd: "# Changed\n" });
  assert.notEqual(first.workingDirectory, second.workingDirectory);
  assert.equal(fs.readFileSync(path.join(workspacePath, first.workingDirectory!, "SKILL.md"), "utf8"), "# Skill\n");
  assert.equal(fs.readFileSync(path.join(legacy, "keep.txt"), "utf8"), "legacy");
});

for (const corruption of ["content", "missing", "identity", "metadata", "hardlink", "extra-junction"] as const) {
  test(`corrupt existing version fails registration and execution without repair (${corruption})`, async t => {
    const { root, workspacePath, errors } = fixture(t);
    const tool = register(workspacePath);
    const directory = path.join(workspacePath, tool.workingDirectory!);
    const resource = path.join(directory, "references/value.txt");
    const metadata = path.join(directory, ".codeflowai-skill.json");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "value.txt"), "external");
    if (corruption === "content") fs.writeFileSync(resource, "tampered");
    if (corruption === "missing") fs.unlinkSync(resource);
    if (corruption === "identity") {
      const data = JSON.parse(fs.readFileSync(metadata, "utf8"));
      fs.writeFileSync(metadata, JSON.stringify({ ...data, skillId: "other" }));
    }
    if (corruption === "metadata") fs.writeFileSync(metadata, "{broken");
    if (corruption === "hardlink") { fs.unlinkSync(resource); fs.linkSync(path.join(outside, "value.txt"), resource); }
    if (corruption === "extra-junction") fs.symlinkSync(outside, path.join(directory, "injected"), "junction");
    assert.throws(() => register(workspacePath), runtimeFailure);
    const execution = { ...tool, code: "import fs from 'node:fs'; fs.writeFileSync('executed.txt', 'bad'); printJson({ ok: true });" };
    await assert.rejects(runtime(workspacePath).execute(execution, {}, "current"), runtimeFailure);
    assert.equal(fs.existsSync(path.join(directory, "executed.txt")), false);
    assert.equal(fs.readFileSync(path.join(outside, "value.txt"), "utf8"), "external");
    assert.equal(errors.length, 2);
    assert.equal(errors[0].errorCode, "SKILL_RUNTIME_PACKAGE_INVALID");
    assert.equal(typeof errors[0].requestId, "string");
    assert.equal(errors[1].toolId, tool.toolId);
    assert.equal(errors[1].skillId, "runtime-skill");
    assert.equal(errors[1].runtimeDirectory, tool.workingDirectory);
    assert.deepEqual(errors[1].event, { category: "skill", action: "execute", outcome: "fail" });
    assert.equal(JSON.stringify(errors).includes("# Skill"), false);
  });
}

for (const level of [".codeflowai", "skill-runtime", "identity", "version", "references"] as const) {
  test(`junction replacement fails before writing or executing outside workspace (${level})`, async t => {
    const { root, workspacePath } = fixture(t);
    const tool = register(workspacePath);
    assert.match(tool.workingDirectory!, /^\.codeflowai\/skill-runtime\//);
    const version = path.join(workspacePath, tool.workingDirectory!);
    const target = level === ".codeflowai" ? path.join(workspacePath, ".codeflowai")
      : level === "skill-runtime" ? path.join(workspacePath, ".codeflowai/skill-runtime")
      : level === "identity" ? path.dirname(version) : level === "version" ? version : path.join(version, "references");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "untouched");
    fs.renameSync(target, path.join(root, "saved"));
    fs.symlinkSync(outside, target, "junction");
    assert.throws(() => register(workspacePath), level === ".codeflowai" ? runtimeLogFailure : runtimeFailure);
    await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), level === ".codeflowai" ? runtimeLogFailure : runtimeFailure);
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
  });
}

test("deleted version fails execution without recreating an empty working directory", async t => {
  const { root, workspacePath } = fixture(t);
  const tool = register(workspacePath);
  const version = path.join(workspacePath, tool.workingDirectory!);
  fs.renameSync(version, path.join(root, "saved"));
  await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeFailure);
  assert.equal(fs.existsSync(version), false);
});

test("real Git ignores all package files while normal project files remain visible", t => {
  const { workspacePath } = fixture(t, true);
  const tool = register(workspacePath);
  const files = ["SKILL.md", "scripts/run.mjs", "references/value.txt", ".codeflowai-skill.json"].map(name => `${tool.workingDirectory}/${name}`);
  assert.equal(command(workspacePath, ["check-ignore", "--no-index", "--", ...files]).toString().trim().split(/\r?\n/).length, 4);
  fs.writeFileSync(path.join(workspacePath, "visible.txt"), "project");
  assert.match(command(workspacePath, ["status", "--porcelain", "--untracked-files=all"]).toString(), /visible.txt/);
  assert.doesNotMatch(command(workspacePath, ["status", "--porcelain", "--untracked-files=all"]).toString(), /skill-runtime/);
});

for (const leaf of ["references/value.txt", ".codeflowai-skill.json"]) {
  test(`Git negation of actual runtime artifact rejects registration and later execution (${leaf})`, async t => {
    const { workspacePath } = fixture(t, true);
    const tool = register(workspacePath);
    const relative = tool.workingDirectory!;
    const parents = relative.split("/");
    const rules = parents.map((_part, index) => `!/${parents.slice(0, index + 1).join("/")}/`);
    rules.push(`/${relative}/**`, `!/${relative}/references/`, `!/${relative}/${leaf}`);
    fs.writeFileSync(path.join(workspacePath, ".gitignore"), rules.join("\n") + "\n");
    assert.throws(() => register(workspacePath), runtimeLogFailure);
    await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeLogFailure);
    assert.equal(fs.readFileSync(path.join(workspacePath, relative, "references/value.txt"), "utf8"), "old");
  });
}

test("package I/O failure keeps older ready version executable and never publishes partial version", async t => {
  const { workspacePath } = fixture(t);
  const old = register(workspacePath);
  const original = fs.writeFileSync;
  const injected = Object.assign(new Error("injected disk failure"), { code: "EIO" });
  const mock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith(`${path.sep}value.txt`) && String(args[1]) === "new") throw injected;
    return original(...args);
  });
  assert.throws(() => register(workspacePath, skill("new")), runtimeFailure);
  mock.mock.restore();
  const result = await runtime(workspacePath).execute(old, {}, "current");
  assert.deepEqual(result.ok && result.output, { value: "old" });
  assert.equal(register(workspacePath, skill("new")).workingDirectory === old.workingDirectory, false);
});

test("deep nested binary resources preserve exact bytes", t => {
  const { workspacePath } = fixture(t);
  const definition = skill();
  definition.files!.push({ ...file("assets/one/two/data.bin", ""), contentText: null, contentBase64: "AAEC//4=" });
  const tool = register(workspacePath, definition);
  assert.deepEqual(fs.readFileSync(path.join(workspacePath, tool.workingDirectory!, "assets/one/two/data.bin")), Buffer.from([0, 1, 2, 255, 254]));
});

test("ordinary relative outputs remain usable but Git must also exclude actual extra files", async t => {
  const { workspacePath } = fixture(t, true);
  const tool = register(workspacePath);
  const execution = { ...tool, code: "import fs from 'node:fs'; fs.mkdirSync('outputs', { recursive: true }); fs.writeFileSync('outputs/result.txt', 'output'); printJson({ ok: true });" };
  assert.equal((await runtime(workspacePath).execute(execution, {}, "current")).ok, true);
  assert.equal(register(workspacePath).workingDirectory, tool.workingDirectory);
  const relative = tool.workingDirectory!;
  const parents = relative.split("/");
  const rules = parents.map((_part, index) => `!/${parents.slice(0, index + 1).join("/")}/`);
  rules.push(`/${relative}/**`, `!/${relative}/outputs/`, `!/${relative}/outputs/result.txt`);
  fs.writeFileSync(path.join(workspacePath, ".gitignore"), rules.join("\n") + "\n");
  assert.throws(() => register(workspacePath), runtimeLogFailure);
  await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeLogFailure);
});

test("write and staging cleanup failures preserve both causes and existing ready versions", t => {
  const { workspacePath, errors } = fixture(t);
  const tool = register(workspacePath);
  const write = fs.writeFileSync, rm = fs.rmSync;
  const primary = Object.assign(new Error("write failure"), { code: "EIO" });
  const cleanup = Object.assign(new Error("cleanup failure"), { code: "EACCES" });
  const writeMock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).endsWith(`${path.sep}value.txt`) && String(args[1]) === "new") throw primary;
    return write(...args);
  });
  const rmMock = t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => {
    if (path.basename(String(args[0])).startsWith(".building-")) throw cleanup;
    return rm(...args);
  });
  assert.throws(() => register(workspacePath, skill("new")), (error: unknown) => {
    runtimeFailure(error);
    assert.ok((error as Error).cause instanceof AggregateError);
    assert.deepEqual(((error as Error).cause as AggregateError).errors, [primary, cleanup]);
    return true;
  });
  writeMock.mock.restore();
  rmMock.mock.restore();
  assert.equal(register(workspacePath).workingDirectory, tool.workingDirectory);
  assert.deepEqual((errors[0].rootCause as { errors: unknown[] }).errors, [
    { name: "Error", code: "EIO", syscall: undefined }, { name: "Error", code: "EACCES", syscall: undefined },
  ]);
});

test("two real Client processes publish or reuse a complete identical version", async t => {
  const { workspacePath } = fixture(t);
  const source = `import { buildSkillScriptToolEntries } from ${JSON.stringify(pathToFileURL(path.resolve("src/orchestration/skillPackageService.ts")).href)};
import { openClientDb } from ${JSON.stringify(pathToFileURL(path.resolve("src/db/clientDb.ts")).href)};
import path from 'node:path';
const skill = JSON.parse(process.env.TEST_SKILL_DEFINITION);
const workspacePath = process.env.TEST_SKILL_WORKSPACE;
const db = openClientDb({ dbPath: path.join(path.dirname(workspacePath), 'second-client-' + process.pid + '.db') });
try {
  db.workspaces.upsert({ id: skill.workspaceId, title: 'Second Client', path: workspacePath });
  const entries = buildSkillScriptToolEntries({ db, requestId: 'skill-runtime:second-client', workspacePath, workspaceId: skill.workspaceId, skills: [skill] });
  process.stdout.write(JSON.stringify(entries[0].tool.workingDirectory));
} finally { db.close(); }`;
  const run = () => promisify(execFile)(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(), env: { ...process.env, TEST_SKILL_DEFINITION: JSON.stringify(skill()), TEST_SKILL_WORKSPACE: workspacePath }, windowsHide: true, timeout: 20_000,
  });
  const results = await Promise.all([run(), run()]);
  assert.equal(JSON.parse(results[0].stdout), JSON.parse(results[1].stdout));
  const tool = register(workspacePath);
  assert.equal(tool.workingDirectory, JSON.parse(results[0].stdout));
  assert.equal((await runtime(workspacePath).execute(tool, {}, "current")).ok, true);
  assert.equal(fs.readdirSync(path.dirname(path.join(workspacePath, tool.workingDirectory!))).some(name => name.startsWith(".building-")), false);
});

test("execution refuses a different Skill identity even when its version tree is complete", async t => {
  const { workspacePath } = fixture(t);
  const original = register(workspacePath);
  const other = register(workspacePath, skill("old", { id: "other-skill" as any }));
  await assert.rejects(runtime(workspacePath).execute({ ...original, workingDirectory: other.workingDirectory }, {}, "current"), runtimeFailure);
});

for (const alias of ["whitespace", "case", "ordinary-directory"] as const) {
  test(`Skill execution cannot bypass version checks through cwd aliases (${alias})`, { skip: alias === "case" && process.platform !== "win32" }, async t => {
    const { workspacePath } = fixture(t);
    const original = register(workspacePath);
    fs.writeFileSync(path.join(workspacePath, original.workingDirectory!, "references/value.txt"), "tampered");
    const workingDirectory = alias === "whitespace" ? `  ${original.workingDirectory}  ` : alias === "case" ? original.workingDirectory!.replace(".codeflowai", ".CODEFLOWAI") : ".";
    await assert.rejects(runtime(workspacePath).execute({ ...original, workingDirectory }, {}, "current"), runtimeFailure);
    assert.equal(fs.readFileSync(path.join(workspacePath, original.workingDirectory!, "references/value.txt"), "utf8"), "tampered");
  });
}

test("metadata cannot shrink its own file manifest to approve a tampered resource", async t => {
  const { workspacePath } = fixture(t);
  const tool = register(workspacePath);
  const directory = path.join(workspacePath, tool.workingDirectory!);
  const metadataPath = path.join(directory, ".codeflowai-skill.json");
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  metadata.files = metadata.files.filter((item: { relPath: string }) => item.relPath !== "references/value.txt");
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));
  fs.writeFileSync(path.join(directory, "references/value.txt"), "tampered");
  await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeFailure);
});

test("fd file replacement fails before using swapped package bytes", async t => {
  const { workspacePath } = fixture(t);
  const tool = register(workspacePath);
  const target = path.join(workspacePath, tool.workingDirectory!, "references/value.txt");
  const open = fs.openSync;
  let replaced = false;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]) === target && !replaced) {
      replaced = true;
      fs.renameSync(target, `${target}.saved`);
      fs.writeFileSync(target, "old");
    }
    return open(...args);
  });
  await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeFailure);
  assert.equal(replaced, true);
});

test("staging-specific Git negation fails before writing package bytes", t => {
  const { workspacePath } = fixture(t, true);
  const tool = register(workspacePath);
  const identity = tool.workingDirectory!.split("/")[2];
  fs.writeFileSync(path.join(workspacePath, ".gitignore"), `!/.codeflowai/\n/.codeflowai/*\n!/.codeflowai/skill-runtime/\n/.codeflowai/skill-runtime/*\n!/.codeflowai/skill-runtime/${identity}/\n/.codeflowai/skill-runtime/${identity}/*\n!/.codeflowai/skill-runtime/${identity}/.building-*/\n!/.codeflowai/skill-runtime/${identity}/.building-*/**\n`);
  assert.throws(() => register(workspacePath, skill("new")), runtimeFailure);
  assert.equal(fs.readdirSync(path.join(workspacePath, ".codeflowai/skill-runtime", identity)).some(name => name.startsWith(".building-")), false);
  assert.equal(fs.readFileSync(path.join(workspacePath, tool.workingDirectory!, "references/value.txt"), "utf8"), "old");
});

test("directory helper wrapped I/O cause remains searchable without private exception text", async t => {
  const { workspacePath, errors } = fixture(t);
  const tool = register(workspacePath);
  const root = path.join(workspacePath, ".codeflowai");
  const lstat = fs.lstatSync;
  const injected = Object.assign(new Error("private-error-do-not-log"), { code: "EACCES", syscall: "lstat" });
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (String(args[0]) === root) throw injected;
    return lstat(...args);
  });
  await assert.rejects(runtime(workspacePath).execute(tool, {}, "current"), runtimeLogFailure);
  const diagnostic = errors[0].rootCause as { cause: { code: string; syscall: string } };
  assert.equal(diagnostic.cause.code, "EACCES");
  assert.equal(diagnostic.cause.syscall, "lstat");
  assert.equal(JSON.stringify(errors).includes("private-error-do-not-log"), false);
});

/** 读取实际 W 日志文件；不以应用 logger mock 代替物理落点证据。 */
function workspaceLogs(workspacePath: string): Record<string, any>[] {
  const directory = path.join(workspacePath, ".codeflowai");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith(".log")).flatMap(name => fs.readFileSync(path.join(directory, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

test("materialize 中文😀 failure writes only registered physical A with exact identities", t => {
  const { root, workspacePath, db, applicationErrors } = fixture(t);
  const other = path.join(root, "B"); fs.mkdirSync(other);
  db.workspaces.upsert({ id: "other" as any, title: "B", path: other });
  const original = fs.writeFileSync, business = Object.assign(new Error("SECRET_SKILL_BODY token=private-token"), { code: "EIO" });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof original>) => {
    if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business;
    return original(...args);
  });
  const definition = skill();
  assert.throws(() => buildSkillScriptToolEntries({ db, requestId: "副本请求😀", workspaceId: definition.workspaceId, workspacePath,
    threadId: "thread-A", turnId: "turn-A", skills: [definition] }), (error: any) => error.cause === business && error.code === "SKILL_RUNTIME_PACKAGE_INVALID");
  const logs = workspaceLogs(workspacePath);
  assert.equal(logs.length, 1, "materialize 必须落物理 A");
  assert.equal(logs[0].requestId, "副本请求😀");
  assert.equal(logs[0].workspaceId, definition.workspaceId);
  assert.equal(logs[0].threadId, "thread-A"); assert.equal(logs[0].turnId, "turn-A");
  assert.deepEqual(logs[0].event, { category: "skill", action: "materialize", outcome: "fail" });
  assert.equal(logs[0].code, "SKILL_RUNTIME_PACKAGE_INVALID");
  assert.equal(logs[0].rootCause.code, "EIO");
  assert.equal(JSON.stringify(logs).includes("SECRET_SKILL_BODY"), false);
  assert.equal(JSON.stringify(logs).includes("private-token"), false);
  assert.equal(applicationErrors.length, 0); assert.equal(workspaceLogs(other).length, 0);
});

for (const primary of [undefined, null, false, 0, "", NaN, new Error("write-root")]) test(`materialize write cleanup log preserves all original values ${String(primary)}`, t => {
  const { workspacePath, db, applicationErrors } = fixture(t), old = register(workspacePath);
  const write = fs.writeFileSync, rm = fs.rmSync, cleanup = new Error("cleanup-root"), logging = new Error("log-root");
  const writes = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => {
    if (String(args[0]).endsWith(`${path.sep}value.txt`) && String(args[1]) === "new") throw primary;
    return write(...args);
  });
  const removals = t.mock.method(fs, "rmSync", (...args: Parameters<typeof rm>) => {
    if (path.basename(String(args[0])).startsWith(".building-")) throw cleanup;
    return rm(...args);
  });
  t.mock.method(db, "writeWorkspaceLog", () => { throw logging; });
  assert.throws(() => register(workspacePath, skill("new")), (error: any) => {
    assert.equal(error.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED"); assert.equal(error.retryable, false);
    assert.equal(error.errors[1], logging); assert.equal(error.cause, error.errors[0]);
    assert.equal(error.errors[0].code, "SKILL_RUNTIME_PACKAGE_INVALID");
    const failed = error.errors[0].cause;
    assert.ok(failed instanceof AggregateError); assert.equal(failed.errors.length, 2);
    assert.ok(Object.is(failed.errors[0], primary)); assert.equal(failed.errors[1], cleanup); assert.ok(Object.is(failed.cause, primary));
    return true;
  });
  assert.equal(applicationErrors.length, 0);
  writes.mock.restore(); removals.mock.restore();
  assert.equal(register(workspacePath).workingDirectory, old.workingDirectory);
  const identity = path.dirname(path.join(workspacePath, old.workingDirectory!));
  for (const name of fs.readdirSync(identity).filter(name => name.startsWith(".building-"))) fs.rmSync(path.join(identity, name), { recursive: true });
});

test("materialize safe descriptors never execute getters or toString", t => {
  const { workspacePath, applicationErrors } = fixture(t);
  let reads = 0, strings = 0;
  const business = Object.defineProperties({ toString() { strings++; throw new Error("toString ran"); } }, {
    code: { get() { reads++; throw new Error("code getter ran"); } }, errors: { get() { reads++; throw new Error("errors getter ran"); } },
  });
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business; return write(...args); });
  assert.throws(() => register(workspacePath), (error: any) => error.cause === business);
  assert.equal(reads, 0); assert.equal(strings, 0); assert.equal(applicationErrors.length, 0);
  assert.equal(workspaceLogs(workspacePath).length, 1);
});

test("materialize unknown diagnostic scalar values cannot smuggle package body", t => {
  const { workspacePath } = fixture(t), write = fs.writeFileSync;
  const business = Object.assign(new Error("SECRET_SKILL_BODY"), { name: "SECRET_SKILL_BODY", code: "SKILL_RUNTIME_UNSAFE", syscall: "SECRET_SKILL_BODY", phase: "SECRET_SKILL_BODY" });
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business; return write(...args); });
  assert.throws(() => register(workspacePath), (error: any) => error.cause === business);
  assert.equal(JSON.stringify(workspaceLogs(workspacePath)).includes("SECRET_SKILL_BODY"), false);
});

for (const mode of ["object", "array"] as const) test(`materialize descriptor reflection ${mode} failure preserves business then diagnostic`, t => {
  const { workspacePath, db } = fixture(t), diagnostic = new Error("reflection-root");
  const business = mode === "object" ? new Proxy({}, { getOwnPropertyDescriptor() { throw diagnostic; } })
    : Object.defineProperty(new AggregateError([], "secret"), "errors", { value: new Proxy([], { getOwnPropertyDescriptor() { throw diagnostic; } }) });
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business; return write(...args); });
  const log = t.mock.method(db, "writeWorkspaceLog", () => assert.fail("描述失败不可写不完整摘要"));
  assert.throws(() => register(workspacePath), (error: any) => {
    assert.equal(error.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED"); assert.equal(error.errors[0].cause, business);
    assert.equal(error.cause, error.errors[0]); assert.equal(error.errors[1], diagnostic); return true;
  });
  assert.equal(log.mock.callCount(), 0);
});

test("materialize missing capability unknown workspace and mismatched declarations reject before any copy writes", t => {
  const { root, workspacePath, db } = fixture(t), definition = skill(), other = path.join(root, "other"); fs.mkdirSync(other);
  const input = { db, requestId: "identity-check", workspacePath, workspaceId: definition.workspaceId, skills: [definition] };
  for (const invalid of [{ ...input, db: undefined }, { ...input, requestId: " " }, { ...input, workspaceId: "unknown" },
    { ...input, workspacePath: other }, { ...input, skills: [{ ...definition, workspaceId: "other" }] }]) {
    assert.throws(() => buildSkillScriptToolEntries(invalid as unknown as Parameters<typeof buildSkillScriptToolEntries>[0]));
    assert.equal(fs.existsSync(path.join(workspacePath, ".codeflowai/skill-runtime")), false);
    assert.equal(fs.existsSync(path.join(other, ".codeflowai")), false);
  }
});

test("materialize fixed workspace gate rejects logging without backfill and other W remains usable", async t => {
  const { root, workspacePath, db, gate, applicationErrors } = fixture(t), definition = skill(), other = path.join(root, "other"); fs.mkdirSync(other);
  db.workspaces.upsert({ id: "other" as any, title: "other", path: other });
  const release = await gate.acquireMigration(definition.workspaceId, "skill-migration");
  const write = fs.writeFileSync, business = new Error("write-root");
  const injected = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business; return write(...args); });
  assert.throws(() => register(workspacePath), (error: any) => {
    assert.equal(error.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED"); assert.equal(error.errors[0].cause, business);
    assert.equal(error.errors[1].code, "WORKSPACE_MIGRATION_IN_PROGRESS"); return true;
  });
  injected.mock.restore();
  assert.equal(workspaceLogs(workspacePath).length, 0); assert.equal(applicationErrors.length, 0);
  const otherDefinition = { ...definition, workspaceId: "other" as any };
  assert.equal(buildSkillScriptToolEntries({ db, requestId: "other-request", workspacePath: other, workspaceId: otherDefinition.workspaceId, skills: [otherDefinition] }).length, 1);
  release(); assert.equal(register(workspacePath).toolId, "skill.runtime-skill.run");
  assert.equal(workspaceLogs(workspacePath).length, 0);
});

test("materialize runtime log close failure stays isolated until actual resource release", t => {
  const { workspacePath, db } = fixture(t), write = fs.writeFileSync, close = fs.closeSync;
  const business = new Error("write-root"), logging = new Error("close-root");
  const failedWrite = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof write>) => { if (String(args[0]).endsWith(`${path.sep}value.txt`)) throw business; return write(...args); });
  let fd: number | undefined;
  const opened = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof opened>) => { const value = opened(...args); if (String(args[0]).endsWith(".log")) fd = value; return value; });
  const failedClose = t.mock.method(fs, "closeSync", (value: number) => { if (value === fd) throw logging; close(value); });
  assert.throws(() => register(workspacePath), (error: any) => {
    assert.equal(error.code, "SKILL_RUNTIME_FAILURE_LOG_FAILED"); assert.equal(error.errors[0].cause, business); assert.equal(error.errors[1], logging); return true;
  });
  failedClose.mock.restore(); failedWrite.mock.restore(); assert.notEqual(fd, undefined);
  close(fd!);
  assert.throws(() => db.writeWorkspaceLog(skill().workspaceId, { level: "error", tag: "probe", message: "must fail" }));
  assert.throws(() => db.close(), (error: any) => error.message === "CLIENT_DB_CLOSE_FAILED" && error.errors[0].cause === logging);
  closedFixtureDbs.add(db);
});
