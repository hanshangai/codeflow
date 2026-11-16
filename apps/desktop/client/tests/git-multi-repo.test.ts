import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { diff, diffFiles, listRepositories, log, stage, status } from "../src/git/gitService.ts";

test("GITW status singleflight isolates caller warning failures and retains all ordered stat reasons", async t => {
  const fixture = createMultiRepoFixture(), trace = path.join(fixture.workspace, "status.trace"), native = fsPromises.stat;
  const reasons = Array.from({ length: 10 }, (_, index) => Object.assign(new Error(`PRIVATE_${index}`), { code: "EACCES" }));
  const logging = false, calls: any[] = [], previous = process.env.GIT_TRACE2_EVENT;
  for (let index = 0; index < reasons.length; index++) fs.writeFileSync(path.join(fixture.workspace, "beta", `bad-${index}.txt`), "body");
  t.mock.method(fsPromises, "stat", (async (...args: Parameters<typeof fsPromises.stat>) => {
    const match = /bad-(\d+)\.txt$/.exec(String(args[0])); if (match) throw reasons[Number(match[1])]; return native(...args);
  }) as typeof fsPromises.stat);
  process.env.GIT_TRACE2_EVENT = trace;
  try {
    const context = (requestId: string) => ({ workspaceId: requestId, requestId, clientId: "client", method: "git.status",
      async writeWorkspaceLog(entry: unknown) { await Promise.resolve(); calls.push({ requestId, entry }); if (requestId === "A") throw logging; } });
    const result = await Promise.allSettled([status(fixture.workspace, "beta", context("A")), status(fixture.workspace, "beta", context("B"))]);
    assert.equal(result[0]!.status, "rejected"); assert.equal(result[1]!.status, "fulfilled"); assert.equal(countGitStatusProcesses(trace), 1);
    const error = (result[0] as PromiseRejectedResult).reason; assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[1], logging); assert.deepEqual(error.errors[0].errors, reasons);
    assert.equal(calls.length, 2); assert.deepEqual(calls.map(row => row.requestId), ["A", "B"]);
    assert.equal(calls[1].entry.data.workspaceId, "B"); assert.equal(calls[1].entry.data.requestId, "B"); assert.equal(calls[1].entry.data.failedSample.length, 8);
    const value = (result[1] as PromiseFulfilledResult<Awaited<ReturnType<typeof status>>>).value;
    assert.ok(value.fileStats?.["beta/beta.txt"]); assert.equal(Object.hasOwn(value, "metadataFailures"), false);
    await status(fixture.workspace, "beta", context("B")); assert.equal(countGitStatusProcesses(trace), 2);
  } finally { if (previous === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = previous; fixture.cleanup(); }
});

/** 创建含多个子 Git 仓库的临时 workspace。 */
function createMultiRepoFixture(): { workspace: string; cleanup: () => void } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-git-multi-"));
  for (const repoName of ["alpha", "beta"]) {
    const repoPath = path.join(workspace, repoName);
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, `${repoName}.txt`), `${repoName} content`, "utf8");
  }
  return {
    workspace,
    cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }),
  };
}

/** 统计 Git Trace2 中真实启动的 status 子进程数。 */
function countGitStatusProcesses(tracePath: string): number {
  if (!fs.existsSync(tracePath)) return 0;
  const content = fs.readFileSync(tracePath, "utf8").trim();
  if (!content) return 0;
  return content
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { event?: string; argv?: unknown[] })
    .filter((event) => event.event === "start" && event.argv?.[1] === "status")
    .length;
}

/** 创建足够多的未跟踪文件，让状态读取稳定覆盖并发写测试窗口。 */
function createUntrackedFiles(repoPath: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(repoPath, `untracked-${index}.txt`), String(index), "utf8");
  }
}

for (const staged of [false, true]) for (const filePath of ["*", "?ecret.txt", "[s]ecret.txt"]) test(`Git diff 不展开缺失字面路径：${filePath} staged=${staged}`, async () => {
  const fixture = createMultiRepoFixture();
  const repoPath = path.join(fixture.workspace, "beta");
  try {
    fs.writeFileSync(path.join(repoPath, "secret.txt"), "before", "utf8");
    execFileSync("git", ["add", "secret.txt"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "initial"], { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "secret.txt"), "unvalidated secret content", "utf8");
    if (staged) execFileSync("git", ["add", "secret.txt"], { cwd: repoPath, stdio: "ignore" });

    assert.equal(await diff(fixture.workspace, filePath, staged, "beta"), "");
    assert.deepEqual(await diffFiles(fixture.workspace, filePath, staged, "beta"), { original: "", modified: "" });
  } finally {
    fixture.cleanup();
  }
});

for (const staged of [false, true]) test(`Git 单文件读取保留合法方括号文件名：staged=${staged}`, async () => {
  const fixture = createMultiRepoFixture();
  const repoPath = path.join(fixture.workspace, "beta");
  try {
    fs.writeFileSync(path.join(repoPath, "[s]pecial.txt"), "literal before", "utf8");
    fs.writeFileSync(path.join(repoPath, "special.txt"), "sibling before", "utf8");
    execFileSync("git", ["--literal-pathspecs", "add", "[s]pecial.txt", "special.txt"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "initial"], { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "[s]pecial.txt"), "literal after", "utf8");
    fs.writeFileSync(path.join(repoPath, "special.txt"), "unrequested sibling content", "utf8");
    if (staged) execFileSync("git", ["--literal-pathspecs", "add", "[s]pecial.txt", "special.txt"], { cwd: repoPath, stdio: "ignore" });

    const patch = await diff(fixture.workspace, "[s]pecial.txt", staged, "beta");
    assert.match(patch, /\+literal after/);
    assert.doesNotMatch(patch, /unrequested sibling content/);
    assert.deepEqual(await diffFiles(fixture.workspace, "[s]pecial.txt", staged, "beta"), { original: "literal before", modified: "literal after" });
  } finally {
    fixture.cleanup();
  }
});

for (const method of ["status", "diff", "diffFiles"]) test(`Git 只读方法拒绝缓存仓库根被外部目录链接替换：${method}`, async () => {
  const fixture = createMultiRepoFixture();
  const outside = createMultiRepoFixture();
  try {
    await listRepositories(fixture.workspace);
    const replaced = path.join(fixture.workspace, "beta");
    fs.rmSync(replaced, { recursive: true, force: true });
    fs.symlinkSync(path.join(outside.workspace, "beta"), replaced, process.platform === "win32" ? "junction" : "dir");

    const result = method === "status" ? status(fixture.workspace, "beta")
      : method === "diff" ? diff(fixture.workspace, "beta/beta.txt", false, "beta")
      : diffFiles(fixture.workspace, "beta/beta.txt", false, "beta");
    await assert.rejects(result, { code: "FILE_TRANSFER_PATH_INVALID" });
  } finally {
    fixture.cleanup();
    outside.cleanup();
  }
});

for (const method of ["diff", "diffFiles"]) test(`Git diff 只读方法拒绝工作树文件经目录链接越界：${method}`, async () => {
  const fixture = createMultiRepoFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-git-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret", "utf8");
    fs.symlinkSync(outside, path.join(fixture.workspace, "beta", "external"), process.platform === "win32" ? "junction" : "dir");

    const result = method === "diff" ? diff(fixture.workspace, "beta/external/secret.txt", false, "beta")
      : diffFiles(fixture.workspace, "beta/external/secret.txt", false, "beta");
    await assert.rejects(result, { code: "FILE_TRANSFER_PATH_INVALID" });
    await assert.rejects(diffFiles(fixture.workspace, "external/missing/deleted.txt", false, "beta"), { code: "FILE_TRANSFER_PATH_INVALID" });
  } finally {
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Git diffFiles 允许真实根链接与已删除父目录，保留删除文件空内容", async () => {
  const fixture = createMultiRepoFixture();
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-git-links-"));
  try {
    const repoPath = path.join(fixture.workspace, "beta");
    fs.mkdirSync(path.join(repoPath, "nested"));
    fs.writeFileSync(path.join(repoPath, "nested", "deleted.txt"), "before deletion", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "initial"], { cwd: repoPath, stdio: "ignore" });
    fs.rmSync(path.join(repoPath, "nested"), { recursive: true });
    fs.symlinkSync(fixture.workspace, path.join(links, "workspace"), process.platform === "win32" ? "junction" : "dir");

    const result = await diffFiles(path.join(links, "workspace"), "nested/deleted.txt", false, "beta");

    assert.deepEqual(result, { original: "before deletion", modified: "" });
    assert.match(await diff(fixture.workspace, "nested/deleted.txt", false, "beta"), /deleted file mode/);
  } finally {
    fs.rmSync(links, { recursive: true, force: true });
    fixture.cleanup();
  }
});

for (const code of ["EACCES", "EIO"]) test(`Git 删除文件校验不会把 ${code} 当作不存在`, async () => {
  const fixture = createMultiRepoFixture();
  const originalRealpath = fs.realpathSync;
  const failure = Object.assign(new Error("real target unavailable"), { code });
  const target = path.join(fixture.workspace, "beta", "missing.txt");
  try {
    fs.realpathSync = ((filePath: fs.PathLike) => {
      if (String(filePath) === target) throw failure;
      return originalRealpath(filePath);
    }) as typeof fs.realpathSync;

    await assert.rejects(diffFiles(fixture.workspace, "missing.txt", false, "beta"), (error: unknown) => error === failure);
  } finally {
    fs.realpathSync = originalRealpath;
    fixture.cleanup();
  }
});

test("Git diffFiles 不把悬空外部目录链接当作删除文件", async () => {
  const fixture = createMultiRepoFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-git-dangling-"));
  try {
    fs.symlinkSync(path.join(outside, "missing"), path.join(fixture.workspace, "beta", "external"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(diffFiles(fixture.workspace, "external/deleted.txt", false, "beta"), { code: "ENOENT" });
  } finally {
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Git status 的路径安全错误不会进入元信息降级", async () => {
  const fixture = createMultiRepoFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-git-status-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret", "utf8");
    fs.symlinkSync(outside, path.join(fixture.workspace, "beta", "external"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(status(fixture.workspace, "beta"), { code: "FILE_TRANSFER_PATH_INVALID" });
  } finally {
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("status discovers child Git repositories when workspace root is not a repo", async () => {
  const fixture = createMultiRepoFixture();
  try {
    const result = await status(fixture.workspace);

    assert.equal(result.isRepo, true);
    assert.deepEqual(result.repositories.map((repo) => repo.path), ["alpha", "beta"]);
    assert.equal(result.repositoryPath, "alpha");
    assert.deepEqual(result.untracked, ["alpha/alpha.txt"]);
  } finally {
    fixture.cleanup();
  }
});

test("status and diffFiles use the selected child Git repository", async () => {
  const fixture = createMultiRepoFixture();
  try {
    const result = await status(fixture.workspace, "beta");
    const diff = await diffFiles(fixture.workspace, "beta/beta.txt", false, "beta");
    const repoRelativeDiff = await diffFiles(fixture.workspace, "beta.txt", false, "beta");

    assert.equal(result.repositoryPath, "beta");
    assert.deepEqual(result.untracked, ["beta/beta.txt"]);
    assert.equal(diff.modified, "beta content");
    assert.equal(repoRelativeDiff.modified, "beta content");
  } finally {
    fixture.cleanup();
  }
});

test("status preserves staged, unstaged, untracked and HEAD fields with direct Git execution", async () => {
  const fixture = createMultiRepoFixture();
  try {
    const repoPath = path.join(fixture.workspace, "beta");
    execFileSync("git", ["add", "beta.txt"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "initial"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    fs.appendFileSync(path.join(repoPath, "beta.txt"), "\nchanged", "utf8");
    fs.writeFileSync(path.join(repoPath, "staged.txt"), "staged", "utf8");
    fs.writeFileSync(path.join(repoPath, "untracked.txt"), "untracked", "utf8");
    execFileSync("git", ["add", "staged.txt"], { cwd: repoPath, stdio: "ignore" });

    const result = await status(fixture.workspace, "beta");

    assert.deepEqual(result.staged.map((file) => file.path), ["beta/staged.txt"]);
    assert.deepEqual(result.unstaged.map((file) => file.path), ["beta/beta.txt"]);
    assert.deepEqual(result.untracked, ["beta/untracked.txt"]);
    assert.match(result.headCommit ?? "", /^[0-9a-f]{40}$/);
  } finally {
    fixture.cleanup();
  }
});

test("status 为变更列表返回磁盘元信息，已删除文件不产生键", async () => {
  const fixture = createMultiRepoFixture();
  try {
    const repoPath = path.join(fixture.workspace, "beta");
    execFileSync("git", ["add", "beta.txt"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "initial"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(repoPath, "staged.txt"), "staged content", "utf8");
    execFileSync("git", ["add", "staged.txt"], { cwd: repoPath, stdio: "ignore" });
    fs.writeFileSync(path.join(repoPath, "untracked.txt"), "untracked content", "utf8");
    execFileSync("git", ["rm", "-q", "beta.txt"], { cwd: repoPath, stdio: "ignore" });

    const result = await status(fixture.workspace, "beta");
    const fileStats = result.fileStats ?? {};

    for (const [relPath, fileName] of [["beta/staged.txt", "staged.txt"], ["beta/untracked.txt", "untracked.txt"]] as const) {
      const real = fs.statSync(path.join(repoPath, fileName));
      assert.equal(fileStats[relPath]?.size, real.size);
      assert.equal(fileStats[relPath]?.mtime, real.mtime.toISOString());
    }
    assert.ok(result.staged.some((file) => file.path === "beta/beta.txt" && file.index === "D"));
    assert.equal(Object.hasOwn(fileStats, "beta/beta.txt"), false);
  } finally {
    fixture.cleanup();
  }
});

test("仓库发现并发读取有上限并合并同工作区请求", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  for (let index = 0; index < 24; index++) fs.mkdirSync(path.join(fixture.workspace, `source-${index}`));
  const readdir = fsPromises.readdir.bind(fsPromises);
  let active = 0, peak = 0;
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      return await readdir(...args);
    } finally { active--; }
  }) as typeof fsPromises.readdir);
  const [first, joined] = await Promise.all([listRepositories(fixture.workspace), listRepositories(fixture.workspace)]);
  assert.deepEqual(first.map(repo => repo.path), ["alpha", "beta"]);
  assert.deepEqual(joined, first);
  assert.ok(peak > 1 && peak <= 8, `扫描并发应在 2..8，实际 ${peak}`);
  assert.equal(active, 0);
});

test("发现子仓库后不要求枚举其目录，权限边界沿用旧扫描", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  const native = fsPromises.readdir.bind(fsPromises);
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    if (["alpha", "beta"].includes(path.basename(String(args[0])))) throw Object.assign(new Error("repository enumeration denied"), { code: "EACCES" });
    return await native(...args);
  }) as typeof fsPromises.readdir);
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta"]);
});

test("Windows 仓库 marker 沿文件系统保持大小写匹配", { skip: process.platform !== "win32" }, async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  fs.renameSync(path.join(fixture.workspace, "alpha", ".git"), path.join(fixture.workspace, "alpha", ".GIT"));
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta"]);
});

test("仓库发现失败等待同批读取收口，不缓存部分结果且可重试", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  fs.mkdirSync(path.join(fixture.workspace, "broken"));
  fs.mkdirSync(path.join(fixture.workspace, "slow"));
  const native = fsPromises.readdir.bind(fsPromises), failure = Object.assign(new Error("discovery read denied"), { code: "EACCES" });
  let failing = true, active = 0;
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    active++;
    try {
      if (path.basename(String(args[0])) === "slow") await new Promise<void>(resolve => setImmediate(resolve));
      if (failing && path.basename(String(args[0])) === "broken") throw failure;
      return await native(...args);
    } finally { active--; }
  }) as typeof fsPromises.readdir);
  await assert.rejects(listRepositories(fixture.workspace), error => error === failure);
  assert.equal(active, 0);
  failing = false;
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta"]);
});

test("仓库发现保留根仓库、四层边界和子仓库停止下探规则", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  fs.mkdirSync(path.join(fixture.workspace, ".git"));
  fs.mkdirSync(path.join(fixture.workspace, "alpha", "nested", ".git"), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspace, "one", "two", "three", "four", ".git"), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspace, "deep", "two", "three", "four", "five", ".git"), { recursive: true });
  fs.mkdirSync(path.join(fixture.workspace, "node_modules", "hidden", ".git"), { recursive: true });
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["", "alpha", "beta", "one/two/three/four"]);
});

test("仓库发现保留 gitfile 与链接 marker，不跟随子目录链接", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  fs.mkdirSync(path.join(fixture.workspace, "gitfile"));
  fs.writeFileSync(path.join(fixture.workspace, "gitfile", ".git"), "gitdir: ../alpha/.git\n");
  fs.mkdirSync(path.join(fixture.workspace, "linked-marker"));
  fs.symlinkSync(path.join(fixture.workspace, "alpha", ".git"), path.join(fixture.workspace, "linked-marker", ".git"), process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(path.join(fixture.workspace, "alpha"), path.join(fixture.workspace, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta", "gitfile", "linked-marker"]);
});

test("仓库发现同批多个失败保留全部原因且不留下部分缓存", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  for (const name of ["broken-a", "broken-b"]) fs.mkdirSync(path.join(fixture.workspace, name));
  const native = fsPromises.readdir.bind(fsPromises);
  const failures = [Object.assign(new Error("read a failed"), { code: "EIO" }), Object.assign(new Error("read b failed"), { code: "EACCES" })];
  let failing = true;
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    const index = ["broken-a", "broken-b"].indexOf(path.basename(String(args[0])));
    if (failing && index >= 0) throw failures[index];
    return await native(...args);
  }) as typeof fsPromises.readdir);
  await assert.rejects(listRepositories(fixture.workspace), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    assert.equal(error.cause, failures[0]);
    return true;
  });
  failing = false;
  assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta"]);
});

test("冷扫描期间并发状态与历史读取保留真实结果，缓存过期后发现新仓库", async t => {
  const fixture = createMultiRepoFixture();
  t.after(fixture.cleanup);
  const repoPath = path.join(fixture.workspace, "beta");
  execFileSync("git", ["add", "beta.txt"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=CodeFlow Test", "-c", "user.email=test@codeflow.local", "commit", "-qm", "history probe"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "beta.txt"), "changed content");
  for (let index = 0; index < 40; index++) fs.mkdirSync(path.join(fixture.workspace, `source-${index}`, "nested"), { recursive: true });
  let ticks = 0, stopped = false;
  /** 模拟输出占用每轮 check，验证 Git 读取不会依赖停止输出才完成。 */
  const pulse = (): void => { if (!stopped) { ticks++; setImmediate(pulse); } };
  const keepAlive = setInterval(() => undefined, 1000);
  pulse();
  try {
    const [snapshot, history] = await Promise.all([status(fixture.workspace, "beta"), log(fixture.workspace, 20, 0, "beta")]);
    assert.ok(ticks > 1);
    assert.equal(snapshot.branch !== null, true);
    assert.deepEqual(snapshot.unstaged.map(file => file.path), ["beta/beta.txt"]);
    assert.equal(history.total, 1);
    assert.equal(history.entries[0]?.message, "history probe");
    fs.mkdirSync(path.join(fixture.workspace, "gamma", ".git"), { recursive: true });
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 30_001);
    assert.deepEqual((await listRepositories(fixture.workspace)).map(repo => repo.path), ["alpha", "beta", "gamma"]);
  } finally { stopped = true; clearInterval(keepAlive); }
});

test("repository discovery reuses the four-level scan result within its short TTL", async () => {
  const fixture = createMultiRepoFixture();
  try {
    const first = await listRepositories(fixture.workspace);
    const addedRepo = path.join(fixture.workspace, "gamma");
    fs.mkdirSync(addedRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: addedRepo, stdio: "ignore" });

    const cached = await listRepositories(path.join(fixture.workspace, "."));

    assert.deepEqual(first.map((repo) => repo.path), ["alpha", "beta"]);
    assert.deepEqual(cached.map((repo) => repo.path), ["alpha", "beta"]);
  } finally {
    fixture.cleanup();
  }
});

test("status 按规范化 workspace 和 repository 复用同代次在途请求", async () => {
  const fixture = createMultiRepoFixture();
  const tracePath = path.join(fixture.workspace, "git-status-singleflight.trace");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    const results = await Promise.all([
      status(fixture.workspace, "beta"),
      status(path.join(fixture.workspace, "."), "beta/."),
      status(`${fixture.workspace}${path.sep}`, "beta"),
    ]);

    assert.deepEqual(results.map((result) => result.repositoryPath), ["beta", "beta", "beta"]);
    assert.equal(countGitStatusProcesses(tracePath), 1);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    fixture.cleanup();
  }
});

test("status 失败会清理 pending 并允许下一次请求重试", async () => {
  const fixture = createMultiRepoFixture();
  const tracePath = path.join(fixture.workspace, "git-status-retry.trace");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  const previousIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_TRACE2_EVENT = tracePath;
  process.env.GIT_INDEX_FILE = fixture.workspace;
  try {
    await assert.rejects(status(fixture.workspace, "beta"));
    await assert.rejects(status(fixture.workspace, "beta"));
    assert.equal(countGitStatusProcesses(tracePath), 2);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    if (previousIndexFile === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previousIndexFile;
    fixture.cleanup();
  }
});

test("Git 写失败不推进代次，跨仓库写成功会隔离写前 status", async () => {
  const fixture = createMultiRepoFixture();
  const tracePath = path.join(fixture.workspace, "git-status-generation.trace");
  const previousTrace = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = tracePath;
  try {
    createUntrackedFiles(path.join(fixture.workspace, "alpha"), 3_000);
    let firstSettled = false;
    const beforeFailedWrite = status(fixture.workspace).finally(() => {
      firstSettled = true;
    });
    await assert.rejects(stage(fixture.workspace, ["../outside.txt"], "beta"));
    assert.equal(firstSettled, false);
    const joinedAfterFailure = status(fixture.workspace);
    await Promise.all([beforeFailedWrite, joinedAfterFailure]);
    assert.equal(countGitStatusProcesses(tracePath), 1);

    let statusBeforeSuccessSettled = false;
    const beforeSuccessfulWrite = status(fixture.workspace).finally(() => {
      statusBeforeSuccessSettled = true;
    });
    await stage(fixture.workspace, ["beta/beta.txt"], "beta");
    assert.equal(statusBeforeSuccessSettled, false);
    const isolatedAfterSuccess = status(fixture.workspace);
    await Promise.all([beforeSuccessfulWrite, isolatedAfterSuccess]);
    assert.equal(countGitStatusProcesses(tracePath), 3);
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT;
    else process.env.GIT_TRACE2_EVENT = previousTrace;
    fixture.cleanup();
  }
});
