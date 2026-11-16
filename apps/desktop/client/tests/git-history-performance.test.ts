import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadStore } from "../src/threads/threadStore.js";
import { openClientDb } from "../src/db/clientDb.js";
import { executeDesktopApiRequest } from "../src/app/executeDesktopApiRequest.js";
import type { ApiHandlerContext } from "../src/app/handleApiRequest.js";
import type { DesktopApiRequest, WorkspaceId } from "@codeflowai/shared";
import { log, show, status } from "../src/git/gitService.js";

/** 仅在临时仓库建立测试提交，不触碰用户仓库。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-history-performance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => childProcess.execFileSync("git", args, { cwd: root, windowsHide: true });
  git(["init", "-q"]);
  git(["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(root, "file.txt"), "first\n");
  git(["add", "file.txt"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "first"]);
  fs.appendFileSync(path.join(root, "file.txt"), "second\n");
  git(["add", "file.txt"]);
  git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-qm", "second"]);
  const commands: string[][] = [], original = childProcess.spawn;
  let failCount = false;
  t.mock.method(childProcess, "spawn", (...args: Parameters<typeof original>) => {
    commands.push(args[1] as string[]);
    if (failCount && Array.isArray(args[1]) && args[1][0] === "rev-list") {
      failCount = false;
      return original(args[0], ["rev-list", "--invalid-count-test-option"], args[2]);
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(syncBuiltinESMExports);
  return { root, git, commands, failNextCount: () => { failCount = true; } };
}

/** 仅覆盖本用例的 Git 环境，结束后恢复调用进程原值。 */
function setGitEnv(t: test.TestContext, key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
}

test("绝对全局配置覆盖允许复用计数，配置内容或路径变化后重新统计", async t => {
  const f = fixture(t), config = path.join(f.root, "global.gitconfig"), other = path.join(f.root, "other.gitconfig");
  fs.writeFileSync(config, "[core]\n\tautocrlf = false\n");
  setGitEnv(t, "GIT_CONFIG_GLOBAL", config);
  assert.equal((await status(f.root)).historyCacheable, true);
  await log(f.root, 1, 0);
  await log(f.root, 1, 1);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 1);
  fs.appendFileSync(config, "[log]\n\tdate = iso\n");
  await log(f.root, 1, 0);
  await log(f.root, 1, 1);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 2);
  fs.copyFileSync(config, other);
  process.env.GIT_CONFIG_GLOBAL = other;
  await log(f.root, 1, 0);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 3);
});

test("绝对全局配置不放宽浅库与替换历史的不可缓存边界", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim(), config = path.join(f.root, "global.gitconfig");
  fs.writeFileSync(config, "[core]\n\tautocrlf = false\n");
  setGitEnv(t, "GIT_CONFIG_GLOBAL", config);
  assert.equal((await status(f.root)).historyCacheable, true);
  fs.writeFileSync(path.join(f.root, ".git", "shallow"), `${head}\n`);
  assert.equal((await status(f.root)).historyCacheable, false);
  assert.equal((await log(f.root, 20, 0)).total, 1);
  fs.unlinkSync(path.join(f.root, ".git", "shallow"));
  f.git(["-c", "user.name=Test", "-c", "user.email=test@local", "replace", "--graft", head]);
  assert.equal((await status(f.root)).historyCacheable, false);
  assert.equal((await log(f.root, 20, 0)).total, 1);
});

test("相对或间接全局配置与其他 Git 环境覆盖仍不缓存计数", async t => {
  const f = fixture(t), config = path.join(f.root, "global.gitconfig"), include = path.join(f.root, "included.gitconfig");
  fs.writeFileSync(config, "[core]\n\tautocrlf = false\n");
  setGitEnv(t, "GIT_CONFIG_GLOBAL", "global.gitconfig");
  assert.equal((await status(f.root)).historyCacheable, false);
  process.env.GIT_CONFIG_GLOBAL = config;
  fs.writeFileSync(include, "[log]\n\tdate = iso\n");
  fs.appendFileSync(config, `[include]\n\tpath = ${include.replaceAll("\\", "/")}\n`);
  assert.equal((await status(f.root)).historyCacheable, false);
  fs.writeFileSync(config, "[core]\n\tautocrlf = false\n");
  setGitEnv(t, "GIT_REPLACE_REF_BASE", "refs/custom-replace/");
  assert.equal((await status(f.root)).historyCacheable, false);
  await log(f.root, 1, 0);
  await log(f.root, 1, 1);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 2);
});

test("同一 HEAD 的分页复用提交总数，HEAD 变化后重新统计", async t => {
  const f = fixture(t);
  assert.equal((await log(f.root, 1, 0)).total, 2);
  assert.equal((await log(f.root, 1, 1)).total, 2);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 1);
  f.git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-qm", "third"]);
  assert.equal((await log(f.root, 1, 0)).total, 3);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 2);
});

test("仅请求提交元数据时不生成 patch，旧入口仍返回完整 diff", async t => {
  const f = fixture(t);
  const metadata = await show(f.root, "HEAD", "", false);
  assert.equal(metadata.files.length, 1);
  assert.equal(metadata.diffLoaded, false);
  assert.ok(!f.commands.some(args => args.includes("-p")));
  const full = await show(f.root, "HEAD");
  assert.equal(full.diffLoaded, true);
  assert.match(full.diff, /\+second/);
});

test("固定 HEAD 分页不混入新提交，同 HEAD 并发只统计一次", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim();
  const [first, second] = await Promise.all([log(f.root, 1, 0, "", head), log(f.root, 1, 1, "", head)]);
  assert.equal(first.entries[0]!.hash, head);
  assert.equal(first.total, 2);
  assert.equal(second.total, 2);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 1);
  f.git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-qm", "third"]);
  const fixed = await log(f.root, 2, 0, "", head);
  assert.equal(fixed.total, 2);
  assert.equal(fixed.entries[0]!.hash, head);
  assert.ok(!f.commands.some(args => args[0] === "rev-parse" && args.includes("HEAD")), "已知 HEAD 不再重复启动 rev-parse");
});

test("统计失败明确拒绝且重试重新统计，不缓存失败", async t => {
  const f = fixture(t);
  f.failNextCount();
  await assert.rejects(log(f.root, 1, 0));
  assert.equal((await log(f.root, 1, 0)).total, 2);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 2);
});

test("浅库边界变化且 HEAD 不变时重新统计提交总数", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim();
  assert.equal((await log(f.root, 20, 0, "", head)).total, 2);
  fs.writeFileSync(path.join(f.root, ".git", "shallow"), `${head}\n`);
  const shallow = await log(f.root, 20, 0, "", head);
  assert.equal(shallow.entries.length, 1);
  assert.equal(shallow.total, 1);
  fs.unlinkSync(path.join(f.root, ".git", "shallow"));
  assert.equal((await log(f.root, 20, 0, "", head)).total, 2);
});

test("替换提交历史时不复用同 HEAD 的原总数", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim();
  assert.equal((await log(f.root, 20, 0, "", head)).total, 2);
  f.git(["-c", "user.name=Test", "-c", "user.email=test@local", "replace", "--graft", head]);
  const replaced = await log(f.root, 20, 0, "", head);
  assert.equal(replaced.entries.length, 1);
  assert.equal(replaced.total, 1);
});

test("历史只接受完整 SHA，不将非法 HEAD 交给 Git", async t => {
  const f = fixture(t);
  for (const head of ["a".repeat(41), 123, "--all"]) {
    await assert.rejects(log(f.root, 1, 0, "", head as never), /GIT_HISTORY_HEAD_INVALID/);
  }
  assert.ok(!f.commands.some(args => args[0] === "log"));
});

test("子目录工作区和 bare 仓库无本地 marker 时仍可读取历史", async t => {
  const f = fixture(t), child = path.join(f.root, "project"), bare = path.join(f.root, "bare.git");
  fs.mkdirSync(child);
  fs.cpSync(path.join(f.root, ".git"), bare, { recursive: true });
  f.git(["--git-dir", bare, "config", "core.bare", "true"]);
  for (const directory of [child, bare]) {
    const history = await log(directory, 20, 0);
    assert.equal(history.total, 2);
    assert.equal(history.entries.length, 2);
  }
});

test("完整 SHA 同名目录不影响固定提交历史和计数", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim();
  fs.mkdirSync(path.join(f.root, head));
  const history = await log(f.root, 20, 0, "", head);
  assert.equal(history.total, 2);
  assert.equal(history.entries[0]!.hash, head);
});

test("Git marker 权限错误显式失败，不当作合法缺失继续计数", async t => {
  const f = fixture(t), lstat = fsPromises.lstat;
  const failure = Object.assign(new Error("marker denied"), { code: "EACCES" });
  t.mock.method(fsPromises, "lstat", (async (...args: Parameters<typeof lstat>) => {
    if (String(args[0]) === path.join(f.root, ".git")) throw failure;
    return lstat(...args);
  }) as typeof lstat);
  await assert.rejects(log(f.root, 20, 0), error => error === failure);
  assert.equal(f.commands.filter(args => args[0] === "rev-list").length, 0);
});

test("Git 状态只允许普通完整历史被前端按 HEAD 复用", async t => {
  const f = fixture(t), head = f.git(["rev-parse", "HEAD"]).toString().trim();
  assert.equal((await status(f.root)).historyCacheable, true);
  fs.writeFileSync(path.join(f.root, ".git", "shallow"), `${head}\n`);
  assert.equal((await status(f.root)).historyCacheable, false);
  fs.unlinkSync(path.join(f.root, ".git", "shallow"));
  assert.equal((await status(f.root)).historyCacheable, true);
});

test("离线桌面 API 保留固定 HEAD 与按需差异参数，旧调用兼容完整 diff", async t => {
  const f = fixture(t), db = openClientDb({ dbPath: path.join(f.root, "client.db") });
  const ctx = { db, clientId: "local-client", workspaces: new Map<WorkspaceId, string>(), threads: new ThreadStore(), send() {} } as unknown as ApiHandlerContext;
  let sequence = 0;
  /** 经真实桌面白名单、工作区绑定和 Git handler 读取，不连接 Server。 */
  const call = (request: DesktopApiRequest) => executeDesktopApiRequest(ctx, request,
    { requestId: `history-${++sequence}`, clientVersion: "1.0.0", startedAt: Date.now() });
  try {
    const registered = await call({ method: "workspaces.upsert", body: { title: "Git", path: f.root } });
    assert.equal(registered.status, 200);
    const workspaceId = (registered.body as any).workspace.id as WorkspaceId;
    const head = f.git(["rev-parse", "HEAD"]).toString().trim();
    f.git(["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "--allow-empty", "-qm", "third"]);
    const history = await call({ method: "git.log", body: { workspaceId, maxCount: 1, skip: 0, headCommit: head } });
    assert.equal(history.status, 200);
    assert.equal((history.body as any).entries[0].hash, head);
    const metadata = await call({ method: "git.show", body: { workspaceId, hash: head, includeDiff: false } });
    assert.equal(metadata.status, 200);
    assert.equal((metadata.body as any).diffLoaded, false);
    const full = await call({ method: "git.show", body: { workspaceId, hash: head } });
    assert.equal(full.status, 200);
    assert.equal((full.body as any).diffLoaded, true);
    assert.match((full.body as any).diff, /\+second/);
  } finally { db.close(); }
});
