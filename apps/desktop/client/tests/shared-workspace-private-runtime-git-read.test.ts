import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSharedWorkspaceEffectiveOperationPolicy } from "@codeflowai/shared";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.ts";
import { logger } from "../src/logger.ts";

/** Git 写入只发生在本测试独占的临时仓库。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-private-git-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "CodeFlow Test");
  git("config", "user.email", "test@codeflow.local");
  git("config", "core.autocrlf", "false");
  fs.mkdirSync(path.join(root, ".codeflow"));
  fs.writeFileSync(path.join(root, ".codeflow/secret.txt"), "PRIVATE-ORIGINAL\n");
  fs.writeFileSync(path.join(root, "public.txt"), "PUBLIC-ORIGINAL\n");
  git("add", "."); git("commit", "-qm", "initial");
  fs.writeFileSync(path.join(root, ".codeflow/secret.txt"), "PRIVATE-MODIFIED\n");
  fs.writeFileSync(path.join(root, "public.txt"), "PUBLIC-MODIFIED\n");
  git("add", "."); git("commit", "-qm", "mixed changes");
  const mixed = git("rev-parse", "HEAD");
  return { root, git, mixed };
}

/** 读取和写入均经过原共享封套；写入携带既有写锁合同。 */
async function execute(root: string, payload: Record<string, unknown>, owner = false, locked = true) {
  const messages: any[] = [];
  const writeMethods = ["git.stage", "git.unstage", "git.discard", "git.commit", "git.branch.create", "git.branch.switch", "git.branch.delete"];
  const operationKey = writeMethods.includes(String(payload.method)) ? "workspace.git.write" : "workspace.git.status";
  await handleSharedWorkspaceCommand({ clientId: "git-host", workspaces: new Map([["git-workspace", root]]),
    /** Git边界夹具不读SQL，显式提供统一Host工作区装配合同。 */
    db: { forWorkspace() { return this; },
      writeWorkspaceLog(_workspaceId: string, entry: any) { logger[entry.level as "warn" | "error"](entry.tag, entry.message, entry.data); } },
    send: (message: unknown) => { messages.push(message); } } as any, {
    sharedWorkspaceId: "git-shared", localWorkspaceId: "git-workspace", actorUserId: owner ? "host-user" : "member-user",
    hostUserId: "host-user", actorRemoteSessionId: null, hostBindingId: "git-binding", routeEventId: "git-route",
    operationId: "git-operation", operationKey, policy: resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload)!,
    ...(locked ? { lockToken: "git-test-lock", lockVersion: 1 } : {}),
    authorization: { actorAssetRole: owner ? "enterprise_admin" : "member", authorizationResult: "allowed", authorizationReason: "test",
      assetType: "unknown", assetId: "", assetAction: "update" },
    payload: { actorUserId: "host-user", ...payload }, createdAt: Date.now(),
  } as any);
  const results = messages.filter(message => message.t === "sharedWorkspace.route.result");
  assert.equal(results.length, 1);
  return results[0].message;
}

test("member and owner status both expose codeflow changes and metadata", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".codeflow/secret.txt"), "PRIVATE-WORKTREE\n");
  fs.writeFileSync(path.join(f.root, "public.txt"), "PUBLIC-WORKTREE\n");
  fs.writeFileSync(path.join(f.root, ".codeflow/untracked.txt"), "PRIVATE-UNTRACKED\n");
  const [owner, member] = await Promise.all([execute(f.root, { method: "git.status" }, true), execute(f.root, { method: "git.status" })]);
  assert.equal(member.status, "succeeded");
  assert.equal(owner.status, "succeeded");
  assert.equal(member.result.unstaged.some((file: any) => file.path === ".codeflow/secret.txt"), true);
  assert.equal(member.result.untracked.includes(".codeflow/untracked.txt"), true);
  assert.equal(member.result.fileStats[".codeflow/secret.txt"].size, Buffer.byteLength("PRIVATE-WORKTREE\n"));
  assert.equal(JSON.stringify(owner.result).includes(".codeflow/secret.txt"), true);
  assert.deepEqual(member.result, owner.result);
});

test("members read codeflow content through direct paths and real aliases", async t => {
  const f = fixture(t);
  fs.symlinkSync(path.join(f.root, ".codeflow"), path.join(f.root, "public-alias"), process.platform === "win32" ? "junction" : "dir");
  for (const method of ["git.diff", "git.diffFiles", "git.showFileDiff"]) {
    for (const target of [".codeflow/secret.txt", "public-alias/secret.txt"]) {
      const result = await execute(f.root, { method, path: target, hash: f.mixed });
      assert.equal(result.status, "succeeded", `${method}:${target}`);
      if (method === "git.diffFiles") assert.equal(result.result.modified, "PRIVATE-MODIFIED\n");
    }
    assert.equal((await execute(f.root, { method, path: ".codeflow/secret.txt", hash: f.mixed }, true)).status, "succeeded");
  }
  fs.unlinkSync(path.join(f.root, ".codeflow/secret.txt"));
  const historical = await execute(f.root, { method: "git.showFileDiff", path: ".codeflow/secret.txt", hash: f.mixed });
  assert.equal(historical.status, "succeeded");
  assert.equal(historical.result.original, "PRIVATE-ORIGINAL\n");
  assert.equal(historical.result.modified, "PRIVATE-MODIFIED\n");
});

test("mixed historical patches include codeflow content for members and owners", async t => {
  const f = fixture(t);
  for (const owner of [false, true]) {
    const member = await execute(f.root, { method: "git.show", hash: f.mixed }, owner);
    assert.equal(member.status, "succeeded");
    assert.equal(member.result.files.some((file: any) => file.path === ".codeflow/secret.txt"), true);
    assert.equal(member.result.files.some((file: any) => file.path === "public.txt"), true);
    assert.match(member.result.diff, /PRIVATE-MODIFIED/);
    assert.match(member.result.diff, /PUBLIC-/);
  }
});

test("codeflow renames remain available in status and content views", async t => {
  const f = fixture(t);
  f.git("mv", ".codeflow/secret.txt", "renamed.txt");
  let member = await execute(f.root, { method: "git.status" });
  assert.equal(member.status, "succeeded");
  assert.equal(member.result.staged.some((file: any) => file.path === "renamed.txt"), true);
  for (const method of ["git.diff", "git.diffFiles"]) {
    for (const staged of [true, false]) {
      const result = await execute(f.root, { method, path: "renamed.txt", staged });
      assert.equal(result.status, "succeeded", `${method}:${staged}`);
      if (method === "git.diffFiles") assert.equal(result.result.modified, "PRIVATE-MODIFIED\n");
    }
  }
  f.git("commit", "-qm", "rename");
  member = await execute(f.root, { method: "git.show", hash: "HEAD" });
  assert.equal(member.status, "succeeded");
  assert.match(member.result.diff, /renamed.txt/);
  const single = await execute(f.root, { method: "git.showFileDiff", hash: "HEAD", path: "renamed.txt" });
  assert.equal(single.status, "succeeded");
  assert.equal(single.result.modified, "PRIVATE-MODIFIED\n");
});

test("members discover and select repositories inside codeflow", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, ".codeflow/repo"));
  execFileSync("git", ["init", "-q"], { cwd: path.join(f.root, ".codeflow/repo") });
  /** 初始化真实嵌套仓库，使各读取接口都有有效提交。 */
  const nestedGit = (...args: string[]) => execFileSync("git", args, { cwd: path.join(f.root, ".codeflow/repo"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  nestedGit("config", "user.name", "CodeFlow Test");
  nestedGit("config", "user.email", "test@codeflow.local");
  fs.writeFileSync(path.join(f.root, ".codeflow/repo/file.txt"), "NESTED-CONTENT\n");
  nestedGit("add", "file.txt"); nestedGit("commit", "-qm", "nested");
  await execute(f.root, { method: "git.status" }, true);
  const member = await execute(f.root, { method: "git.status" });
  assert.equal(member.result.repositories.some((repo: any) => repo.path === ".codeflow/repo"), true);
  for (const method of ["git.status", "git.log", "git.branch.list", "git.show"]) {
    const result = await execute(f.root, { method, repositoryPath: ".codeflow/repo", hash: "HEAD" });
    assert.equal(result.status, "succeeded", method);
  }
});

test("workspace boundary failures keep one correlated error and later reads work", async t => {
  const f = fixture(t);
  const warnings = t.mock.method(logger, "warn", () => {});
  const errors = t.mock.method(logger, "error", () => {});
  const denied = await execute(f.root, { method: "git.diffFiles", path: "../outside.txt" });
  assert.equal(denied.status, "failed");
  assert.equal(denied.result, undefined);
  assert.equal(warnings.mock.calls.length + errors.mock.calls.length, 1);
  const fields = warnings.mock.calls[0].arguments[2] as any;
  assert.equal(fields.requestId, "git-operation");
  assert.equal(fields.actorUserId, "member-user");
  assert.equal(fields.sharedWorkspaceId, "git-shared");
  assert.equal((await execute(f.root, { method: "git.log" })).status, "succeeded");
});

test("literal special filenames preserve ordinary historical patch behavior", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "[s]pecial.txt"), "VISIBLE-LITERAL\n");
  f.git("--literal-pathspecs", "add", "[s]pecial.txt"); f.git("commit", "-qm", "literal");
  const result = await execute(f.root, { method: "git.show", hash: "HEAD" });
  assert.equal(result.status, "succeeded");
  assert.match(result.result.diff, /VISIBLE-LITERAL/);
  assert.doesNotMatch(result.result.diff, /PRIVATE-/);
  assert.equal(result.result.files[0].path, "[s]pecial.txt");
});

test("cached repository selections can point to an in-workspace codeflow target", async t => {
  const f = fixture(t);
  const nested = path.join(f.root, "nested");
  fs.mkdirSync(nested);
  execFileSync("git", ["init", "-q"], { cwd: nested });
  await execute(f.root, { method: "git.status" }, true);
  fs.mkdirSync(path.join(f.root, ".codeflow/repo"));
  execFileSync("git", ["init", "-q"], { cwd: path.join(f.root, ".codeflow/repo") });
  fs.rmSync(nested, { recursive: true });
  fs.symlinkSync(path.join(f.root, ".codeflow/repo"), nested, process.platform === "win32" ? "junction" : "dir");
  const result = await execute(f.root, { method: "git.status", repositoryPath: "nested" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.repositoryPath, "nested");
});

test("directory diffs include an in-workspace codeflow target", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, "container"));
  fs.renameSync(path.join(f.root, ".codeflow"), path.join(f.root, "container/runtime"));
  fs.symlinkSync(path.join(f.root, "container/runtime"), path.join(f.root, ".codeflow"), process.platform === "win32" ? "junction" : "dir");
  f.git("add", "container");
  const result = await execute(f.root, { method: "git.diff", path: "container", staged: true });
  assert.equal(result.status, "succeeded");
  assert.match(result.result.diff, /PRIVATE-MODIFIED/);
});

test("member reads preserve workspace-root junctions and nested public repositories", async t => {
  const f = fixture(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-private-git-alias-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.symlinkSync(f.root, path.join(base, "workspace"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(f.root, "public.txt"), "VISIBLE-WORKTREE\n");
  for (const method of ["git.status", "git.diffFiles", "git.showFileDiff"]) {
    const result = await execute(path.join(base, "workspace"), { method, path: "public.txt", hash: f.mixed });
    assert.equal(result.status, "succeeded", method);
  }
  fs.mkdirSync(path.join(f.root, "nested"));
  execFileSync("git", ["init", "-q"], { cwd: path.join(f.root, "nested") });
  const result = await execute(f.root, { method: "git.status", repositoryPath: "nested" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.repositoryPath, "nested");
});

test("Git I/O failures log once and recover without successful content", async t => {
  const f = fixture(t);
  const original = fs.promises.readFile;
  const errors = t.mock.method(logger, "error", () => {});
  const injected = t.mock.method(fs.promises, "readFile", (...args: any[]) => {
    if (String(args[0]).endsWith("public.txt")) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
    return Reflect.apply(original, fs.promises, args);
  });
  const result = await execute(f.root, { method: "git.diffFiles", path: "public.txt" });
  assert.equal(result.status, "failed");
  assert.equal(result.result, undefined);
  assert.equal(errors.mock.calls.length, 1);
  const fields = errors.mock.calls[0].arguments[2] as any;
  assert.equal(fields.code, "INTERNAL_ERROR");
  assert.match(fields.rootCause, /injected EIO/);
  assert.equal(fields.requestId, "git-operation");
  injected.mock.restore();
  assert.equal((await execute(f.root, { method: "git.diffFiles", path: "public.txt" })).status, "succeeded");
});

test("member codeflow writes keep stage, unstage, discard, commit and branch operations", async t => {
  const f = fixture(t);
  const baseBranch = f.git("branch", "--show-current");
  const filePath = path.join(f.root, ".codeflow/secret.txt");
  fs.writeFileSync(filePath, "MEMBER-CHANGE\n");
  assert.equal((await execute(f.root, { method: "git.stage", paths: [".codeflow/secret.txt"] })).status, "succeeded");
  assert.equal(f.git("diff", "--cached", "--name-only"), ".codeflow/secret.txt");
  assert.equal((await execute(f.root, { method: "git.unstage", paths: [".codeflow/secret.txt"] })).status, "succeeded");
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
  assert.equal((await execute(f.root, { method: "git.discard", paths: [".codeflow/secret.txt"] })).status, "succeeded");
  assert.equal(fs.readFileSync(filePath, "utf8"), "PRIVATE-MODIFIED\n");
  assert.equal((await execute(f.root, { method: "git.branch.create", name: "member-codeflow" })).status, "succeeded");
  assert.equal((await execute(f.root, { method: "git.branch.switch", name: "member-codeflow" })).status, "succeeded");
  fs.writeFileSync(filePath, "MEMBER-COMMITTED\n");
  assert.equal((await execute(f.root, { method: "git.stage", paths: [".codeflow/secret.txt"] })).status, "succeeded");
  assert.equal((await execute(f.root, { method: "git.commit", message: "成员修改运行目录" })).status, "succeeded");
  assert.equal(f.git("show", "HEAD:.codeflow/secret.txt"), "MEMBER-COMMITTED");
  assert.equal((await execute(f.root, { method: "git.branch.switch", name: baseBranch })).status, "succeeded");
  assert.equal(fs.readFileSync(filePath, "utf8"), "PRIVATE-MODIFIED\n");
  assert.equal((await execute(f.root, { method: "git.branch.delete", name: "member-codeflow", force: true })).status, "succeeded");
  assert.equal(f.git("branch", "--list", "member-codeflow"), "");
});

test("member Git writes still require the original shared write lock", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".codeflow/secret.txt"), "UNSTAGED-CONTENT\n");
  const result = await execute(f.root, { method: "git.stage", paths: [".codeflow/secret.txt"] }, false, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "SHARED_WORKSPACE_LOCK_REQUIRED");
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("member content reads still reject aliases outside the workspace", async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-git-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.txt"), "OUTSIDE-CONTENT\n");
  fs.symlinkSync(outside, path.join(f.root, "outside-alias"), process.platform === "win32" ? "junction" : "dir");
  for (const method of ["git.diff", "git.diffFiles"]) {
    const result = await execute(f.root, { method, path: "outside-alias/outside.txt" });
    assert.equal(result.status, "failed", method);
    assert.equal(result.result, undefined, method);
    assert.equal(JSON.stringify(result).includes("OUTSIDE-CONTENT"), false, method);
  }
});

test("member content views retain new and deleted public file behavior", async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "new.txt"), "VISIBLE-NEW\n");
  const working = await execute(f.root, { method: "git.diffFiles", path: "new.txt", staged: false });
  assert.equal(working.status, "succeeded");
  assert.deepEqual({ original: working.result.original, modified: working.result.modified }, { original: "", modified: "VISIBLE-NEW\n" });
  f.git("add", "new.txt"); f.git("commit", "-qm", "new file");
  const added = await execute(f.root, { method: "git.showFileDiff", path: "new.txt", hash: "HEAD" });
  assert.equal(added.status, "succeeded");
  assert.equal(added.result.original, "");
  assert.equal(added.result.modified, "VISIBLE-NEW\n");
  fs.unlinkSync(path.join(f.root, "public.txt"));
  const deleted = await execute(f.root, { method: "git.diffFiles", path: "public.txt" });
  assert.equal(deleted.status, "succeeded");
  assert.equal(deleted.result.modified, "");
});
