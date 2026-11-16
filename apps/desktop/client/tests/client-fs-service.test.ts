import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import * as XLSX from "xlsx";

import { listClientDirectoryTree, listClientDirectoryTreeAsync, normalizeSearchCursor, readFile, readFileAsync, listTree, listTreeAsync, readSpreadsheetPreview, searchPaths } from "../src/fs/fsService.ts";
import { handleFsTree, handleFsReadFile, handleFsDownloadStat, handleClientDirectoryTree } from "../src/app/handlers/fsHandlers.ts";

/** 创建临时目录夹具，用于验证 Client 本机目录树只暴露目录节点。 */
function createDirectoryFixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-fs-"));
  fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "beta"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes.txt"), "not a directory", "utf8");
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** 统一路径比较格式，避免 Windows 大小写差异影响测试。 */
function normalizeForCompare(value: string): string {
  return path.resolve(value).toLowerCase();
}

for (const fileName of ["secret.txt", "secret.png", "secret.csv"]) test(`只读入口拒绝目录链接越界：${fileName}`, () => {
  const fixture = createDirectoryFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "outside text", "utf8");
    fs.writeFileSync(path.join(outside, "secret.png"), Buffer.from("outside image"));
    fs.writeFileSync(path.join(outside, "secret.csv"), "name,value\nsecret,42", "utf8");
    fs.symlinkSync(outside, path.join(fixture.root, "external"), process.platform === "win32" ? "junction" : "dir");

    if (fileName === "secret.csv") {
      assert.throws(() => readSpreadsheetPreview(fixture.root, `external/${fileName}`), { code: "FILE_TRANSFER_PATH_INVALID" });
    } else {
      assert.throws(() => readFile(fixture.root, `external/${fileName}`), { code: "FILE_TRANSFER_PATH_INVALID" });
    }
  } finally {
    fixture.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("只读文件与切换工作表支持工作区根链接及内部目录链接", () => {
  const fixture = createDirectoryFixture();
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-links-"));
  try {
    const dataPath = path.join(fixture.root, "alpha");
    fs.writeFileSync(path.join(dataPath, "note.txt"), "内部文本", "utf8");
    fs.writeFileSync(path.join(dataPath, "image.png"), Buffer.from("internal image"));
    fs.writeFileSync(path.join(dataPath, "table.csv"), "name,value\ninternal,42", "utf8");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["first"]]), "first");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["second"]]), "second");
    XLSX.writeFile(workbook, path.join(dataPath, "table.xlsx"));
    fs.symlinkSync(dataPath, path.join(fixture.root, "internal"), process.platform === "win32" ? "junction" : "dir");
    const linkedRoot = path.join(links, "workspace");
    fs.symlinkSync(fixture.root, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    assert.equal(readFile(linkedRoot, "internal/note.txt").content, "内部文本");
    assert.equal(readFile(linkedRoot, "internal/image.png").base64, Buffer.from("internal image").toString("base64"));
    assert.deepEqual(readSpreadsheetPreview(linkedRoot, "internal/table.csv").rows, [["name", "value"], ["internal", "42"]]);
    assert.deepEqual(readSpreadsheetPreview(linkedRoot, "internal/table.xlsx", { sheetName: "second" }).rows, [["second"]]);
    assert.throws(() => readFile(linkedRoot, "../outside.txt"), { code: "FILE_TRANSFER_PATH_INVALID" });
  } finally {
    fs.rmSync(links, { recursive: true, force: true });
    fixture.cleanup();
  }
});

for (const kind of ["text", "spreadsheet"]) test(`只读入口保留非缺失文件信息错误的原因：${kind}`, () => {
  const fixture = createDirectoryFixture();
  const originalStatSync = fs.statSync;
  const failure = Object.assign(new Error("read metadata failed"), { code: "EIO" });
  try {
    fs.writeFileSync(path.join(fixture.root, "table.csv"), "name,value", "utf8");
    fs.statSync = (() => { throw failure; }) as typeof fs.statSync;
    assert.throws(() => kind === "text" ? readFile(fixture.root, "notes.txt") : readSpreadsheetPreview(fixture.root, "table.csv"), { code: "EIO", cause: failure });
  } finally {
    fs.statSync = originalStatSync;
    fixture.cleanup();
  }
});

test("目录查询明确区分文件、缺失路径和越界，成功仍返回目录节点", async () => {
  const fixture = createDirectoryFixture();
  const replies: any[] = [];
  const logs: unknown[] = [];
  const ctx = { db: { workspaceId: null, writeWorkspaceLog: (_workspaceId: string, entry: unknown) => { logs.push(entry); } },
    clientId: "client-test", workspaces: new Map([["ws", fixture.root]]), send: (message: unknown) => replies.push(message) } as any;
  try {
    for (const [dirPath, status, code] of [["notes.txt", 400, "BAD_REQUEST"], ["missing", 404, "NOT_FOUND"], ["../outside", 400, "FILE_TRANSFER_PATH_INVALID"]] as const) {
      await handleFsTree(ctx, { id: "fs-test", method: "fs.tree", body: { workspaceId: "ws", dirPath } } as any);
      assert.equal(replies.at(-1).status, status);
      assert.equal(replies.at(-1).body.code, code);
      assert.equal(replies.at(-1).body.ok, false);
    }
    await handleFsTree(ctx, { id: "fs-test", method: "fs.tree", body: { workspaceId: "ws", dirPath: "" } } as any);
    assert.equal(replies.at(-1).status, 200);
    assert.ok(replies.at(-1).body.nodes.length > 0);
    await handleFsReadFile(ctx, { id: "fs-read", method: "fs.readFile", body: { workspaceId: "ws", path: "../outside" } } as any);
    assert.equal(replies.at(-1).status, 400);
    assert.equal(replies.at(-1).body.code, "FILE_TRANSFER_PATH_INVALID");
    await handleClientDirectoryTree(ctx, { id: "fs-directory", method: "clientFs.directoryTree", body: { dirPath: path.join(fixture.root, "notes.txt") } } as any);
    assert.equal(replies.at(-1).status, 400);
    await handleClientDirectoryTree(ctx, { id: "fs-directory-missing", method: "clientFs.directoryTree", body: { dirPath: path.join(fixture.root, "missing") } } as any);
    assert.equal(replies.at(-1).status, 404);
    handleFsDownloadStat(ctx, { id: "fs-download-missing", method: "fs.downloadStat", body: { workspaceId: "ws", path: "missing" } } as any);
    assert.equal(replies.at(-1).status, 404);
  } finally { fixture.cleanup(); }
});

test("文件树RPC在大目录读取期间让出事件循环，完整节点保持一致", async t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  for (let index = 0; index < 80; index++) fs.writeFileSync(path.join(fixture.root, `file-${index}.txt`), "body");
  let now = 0, completed = false;
  t.mock.method(performance, "now", () => { now += 2; return now; });
  const replies: any[] = [];
  const ctx = { db: { workspaceId: null, writeWorkspaceLog() {} }, clientId: "client-test",
    workspaces: new Map([["ws", fixture.root]]), send: (message: unknown) => replies.push(message) } as any;
  const pending = Promise.resolve(handleFsTree(ctx, { id: "tree-yield", method: "fs.tree", body: { workspaceId: "ws" } } as any)).then(() => { completed = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(completed, false, "不能在一轮内同步处理整个目录");
  await pending;
  assert.equal(replies[0]?.status, 200);
  assert.equal(replies[0]?.body.nodes.length, 83);
});

test("文件树本次遍历复用固定真实根，不为每个文件重复解析根目录", t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(fixture.root, `file-${index}.txt`), "body");
  const native = fs.realpathSync.native;
  let rootReads = 0;
  t.mock.method(fs.realpathSync, "native", ((target: fs.PathLike, ...args: any[]) => {
    if (path.resolve(String(target)) === fixture.root) rootReads++;
    return (native as any)(target, ...args);
  }) as typeof native);
  assert.equal(listTree(fixture.root, "", 2).length, 43);
  assert.ok(rootReads <= 4, `单次同步遍历反复解析根：${rootReads}`);
});

test("目录选择器根盘符使用有界异步探测，不阻塞其他请求", async t => {
  t.mock.method(fs, "existsSync", () => false);
  t.mock.method(fs, "exists", (_path: fs.PathLike, callback: (exists: boolean) => void) => { setImmediate(() => callback(true)); });
  let active = 0, peak = 0, completed = false;
  t.mock.method(fsp, "stat", (async () => {
    active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => setImmediate(resolve));
    active--;
    return { isDirectory: () => true };
  }) as any);
  const replies: any[] = [];
  const ctx = { clientId: "client-test", send: (value: unknown) => replies.push(value) } as any;
  const pending = Promise.resolve(handleClientDirectoryTree(ctx, { id: "roots", method: "clientFs.directoryTree", body: {} } as any)).then(() => { completed = true; });
  assert.equal(completed, false);
  assert.equal(replies.length, 0);
  await pending;
  assert.equal(replies[0]?.status, 200);
  assert.ok(replies[0]?.body.nodes.length > 0);
  assert.ok(peak > 0 && peak <= 8);
});

test("根目录批次读取多错保留全部原因且不返回部分列表", async t => {
  t.mock.method(fs, "exists", (_path: fs.PathLike, callback: (exists: boolean) => void) => { setImmediate(() => callback(true)); });
  const failures = [new Error("root stat failed"), new Error("drive stat failed")];
  let count = 0, active = 0;
  t.mock.method(fsp, "stat", (async () => {
    const index = count++;
    active++;
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      if (index < 2) throw failures[index];
      return { isDirectory: () => true };
    } finally { active--; }
  }) as any);
  await assert.rejects(listClientDirectoryTreeAsync("", 1), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, failures);
    assert.equal(active, 0);
    return true;
  });
});

test("分段文件树恢复时拒绝工作区根被外部链接替换", async t => {
  const fixture = createDirectoryFixture();
  const moved = `${fixture.root}-original`;
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fs-tree-root-outside-"));
  t.after(() => { fixture.cleanup(); fs.rmSync(moved, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(outside, "alpha"));
  fs.mkdirSync(path.join(outside, "beta"));
  fs.writeFileSync(path.join(outside, "notes.txt"), "outside");
  fs.writeFileSync(path.join(outside, "alpha", "secret.txt"), "outside");
  let now = 0;
  t.mock.method(performance, "now", () => { now += 40; return now; });
  const pending = listTreeAsync(fixture.root, "", 2);
  fs.renameSync(fixture.root, moved);
  fs.symlinkSync(outside, fixture.root, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(pending, { code: "FILE_TRANSFER_PATH_INVALID" });
});

test("异步文件预览和树保留中文编码、截断、二进制和链接边界", async t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  for (const [name, bytes] of [
    ["utf8.txt", Buffer.from("中文正文")], ["gbk.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4])],
    ["large.txt", Buffer.from("正文".repeat(1200))], ["image.png", Buffer.from("image bytes")],
    ["archive.zip", Buffer.from("binary bytes")], ["empty.txt", Buffer.alloc(0)],
  ] as const) {
    fs.writeFileSync(path.join(fixture.root, name), bytes);
    assert.deepEqual(await readFileAsync(fixture.root, name, 1024), readFile(fixture.root, name, 1024));
  }
  assert.deepEqual(await listTreeAsync(fixture.root, "", 2), listTree(fixture.root, "", 2));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fs-async-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.symlinkSync(outside, path.join(fixture.root, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readFileAsync(fixture.root, "external/secret.txt"), { code: "FILE_TRANSFER_PATH_INVALID" });
  await assert.rejects(listTreeAsync(fixture.root, "", 1), { code: "FILE_TRANSFER_PATH_INVALID" });
});

test("异步预览读取失败必须关闭句柄，关闭副错保留首因", async t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(path.join(fixture.root, "large.txt"), "x".repeat(128 * 1024));
  const readFailure = new Error("preview read failed"), closeFailure = new Error("preview close failed");
  let closes = 0, failClose = false;
  t.mock.method(fsp, "open", (async () => ({
    stat: async () => fs.statSync(path.join(fixture.root, "large.txt")),
    read: async () => { throw readFailure; },
    close: async () => { closes++; if (failClose) throw closeFailure; },
  })) as any);
  await assert.rejects(readFileAsync(fixture.root, "large.txt"), error => error === readFailure);
  assert.equal(closes, 1);
  failClose = true;
  await assert.rejects(readFileAsync(fixture.root, "large.txt"), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [readFailure, closeFailure]);
    assert.equal(error.cause, readFailure);
    return true;
  });
  assert.equal(closes, 2);
});

test("小文件预览不增加多轮线程池等待，大文件仍有界异步读取", async t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  const native = fsp.open.bind(fsp);
  let opens = 0;
  t.mock.method(fsp, "open", (async (...args: Parameters<typeof fsp.open>) => { opens++; return native(...args); }) as typeof fsp.open);
  assert.equal((await readFileAsync(fixture.root, "notes.txt")).content, "not a directory");
  assert.equal(opens, 0);
  fs.writeFileSync(path.join(fixture.root, "large.txt"), "a".repeat(128 * 1024));
  const result = await readFileAsync(fixture.root, "large.txt", 1024);
  assert.ok(result.content?.endsWith("\n…(文件过大，已截断)"));
  assert.equal(opens, 1);
});

test("大文件异步打开期间目录被替换时拒绝读取已打开的其他文件", async t => {
  const fixture = createDirectoryFixture();
  t.after(fixture.cleanup);
  fs.writeFileSync(path.join(fixture.root, "large.txt"), "x".repeat(128 * 1024));
  const before = fs.statSync(path.join(fixture.root, "large.txt"));
  let reads = 0, closes = 0;
  t.mock.method(fsp, "open", (async () => ({
    stat: async () => ({ ...before, ino: 0, isFile: () => true }),
    read: async () => { reads++; return { bytesRead: 0 }; },
    close: async () => { closes++; },
  })) as any);
  await assert.rejects(readFileAsync(fixture.root, "large.txt"), { code: "FILE_TRANSFER_PATH_INVALID" });
  assert.equal(reads, 0);
  assert.equal(closes, 1);
});

test("listClientDirectoryTree returns directories only", () => {
  const fixture = createDirectoryFixture();
  try {
    const nodes = listClientDirectoryTree(fixture.root, 1);
    const names = nodes.map((node) => node.name).sort();

    assert.deepEqual(names, ["alpha", "beta"]);
    assert.ok(nodes.every((node) => node.isDir === true));
    assert.ok(nodes.every((node) => path.isAbsolute(node.path)));
  } finally {
    fixture.cleanup();
  }
});

test("listClientDirectoryTree hides protected and hidden directories", () => {
  const fixture = createDirectoryFixture();
  try {
    fs.mkdirSync(path.join(fixture.root, ".secret"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "AppData"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "$RECYCLE.BIN"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "$WINDOWS.~BT"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "$WinREAgent"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "Config.Msi"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "System Volume Information"), { recursive: true });

    const names = listClientDirectoryTree(fixture.root, 1).map((node) => node.name);

    assert.ok(!names.includes(".secret"));
    assert.ok(!names.includes("AppData"));
    assert.ok(!names.includes("$RECYCLE.BIN"));
    assert.ok(!names.includes("$WINDOWS.~BT"));
    assert.ok(!names.includes("$WinREAgent"));
    assert.ok(!names.includes("Config.Msi"));
    assert.ok(!names.includes("System Volume Information"));
  } finally {
    fixture.cleanup();
  }
});

test("listClientDirectoryTree stays one-level even when caller requests deeper depth", () => {
  const fixture = createDirectoryFixture();
  try {
    fs.mkdirSync(path.join(fixture.root, "alpha", "nested"), { recursive: true });

    const nodes = listClientDirectoryTree(fixture.root, 3);
    const alpha = nodes.find((node) => node.name === "alpha");

    assert.ok(alpha);
    assert.equal(alpha.children, undefined);
  } finally {
    fixture.cleanup();
  }
});

test("listClientDirectoryTree rejects directories with too many direct child directories", () => {
  const fixture = createDirectoryFixture();
  try {
    for (let index = 0; index <= 1000; index += 1) {
      fs.mkdirSync(path.join(fixture.root, `dir-${String(index).padStart(4, "0")}`), { recursive: true });
    }

    assert.throws(
      () => listClientDirectoryTree(fixture.root, 1),
      /目录子目录过多/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("listClientDirectoryTree ignores directory symlinks when the platform allows creating them", (t) => {
  const fixture = createDirectoryFixture();
  try {
    const linkPath = path.join(fixture.root, "self-link");
    try {
      fs.symlinkSync(fixture.root, linkPath, process.platform === "win32" ? "junction" : "dir");
    } catch {
      t.skip("当前环境不允许创建目录 symlink");
      return;
    }

    const names = listClientDirectoryTree(fixture.root, 1).map((node) => node.name);

    assert.ok(!names.includes("self-link"));
  } finally {
    fixture.cleanup();
  }
});

test("listClientDirectoryTree rejects relative paths", () => {
  assert.throws(
    () => listClientDirectoryTree("relative/path", 1),
    /必须是目标 Client 上的绝对路径/,
  );
});

test("listClientDirectoryTree returns local root entries for empty path", () => {
  const roots = listClientDirectoryTree("", 1);
  const rootNames = new Set(roots.map((node) => node.name));
  const rootPaths = new Set(roots.map((node) => normalizeForCompare(node.path)));
  const expectedHome = normalizeForCompare(os.homedir());

  assert.ok(roots.length >= 1);
  assert.ok(rootPaths.has(expectedHome));
  assert.ok(!rootNames.has("当前目录"));
  assert.ok(roots.every((node) => node.isDir === true));

  if (process.platform === "win32") {
    const driveRoots = roots.filter((node) => /^[A-Z]:\\$/.test(node.name));
    const expectedCwdDrive = normalizeForCompare(path.parse(process.cwd()).root);

    assert.ok(driveRoots.length >= 1);
    assert.ok(rootPaths.has(expectedCwdDrive));
    assert.ok(driveRoots.every((node) => normalizeForCompare(node.name) === normalizeForCompare(node.path)));
    assert.ok(!rootNames.has("系统盘"));
    assert.ok(!rootNames.has("当前盘"));
  } else {
    assert.ok(rootNames.has("根目录"));
    assert.ok(rootPaths.has(normalizeForCompare("/")));
  }
});

test("searchPaths returns workspace-relative paths for duplicate filenames", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-search-"));
  try {
    fs.mkdirSync(path.join(root, "apps", "web", "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "apps", "desktop", "client", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "apps", "web", "src", "chat.ts"), "web", "utf8");
    fs.writeFileSync(path.join(root, "apps", "desktop", "client", "src", "chat.ts"), "client", "utf8");

    const paths = searchPaths(root, "chat.ts", { limit: 10 }).results.map((item) => item.path).sort();

    assert.deepEqual(paths, [
      "apps/desktop/client/src/chat.ts",
      "apps/web/src/chat.ts",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("searchPaths reaches specific filename matches after large shallow prefixes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-search-wide-"));
  try {
    const noisyDir = path.join(root, "noisy");
    fs.mkdirSync(noisyDir, { recursive: true });
    for (let index = 0; index < 8100; index += 1) {
      fs.writeFileSync(path.join(noisyDir, `aa-${String(index).padStart(4, "0")}.tmp`), "x", "utf8");
    }
    fs.writeFileSync(path.join(noisyDir, "zz-cc-latest-vs-aihubx-latest-events-checklist.md"), "target", "utf8");

    const paths = searchPaths(root, "cc-latest-vs-aihubx-latest-events-checklist", { limit: 10 }).results.map((item) => item.path);

    assert.ok(paths.includes("noisy/zz-cc-latest-vs-aihubx-latest-events-checklist.md"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("searchPaths returns root candidates for empty mention query", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-search-"));
  try {
    fs.mkdirSync(path.join(root, "apps"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "readme", "utf8");

    const paths = searchPaths(root, "", { limit: 10 }).results.map((item) => item.path).sort();

    assert.deepEqual(paths, ["README.md", "apps", "packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("searchPaths returns paged candidates with next cursor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-search-"));
  try {
    fs.writeFileSync(path.join(root, "alpha.txt"), "alpha", "utf8");
    fs.writeFileSync(path.join(root, "beta.txt"), "beta", "utf8");
    fs.writeFileSync(path.join(root, "gamma.txt"), "gamma", "utf8");

    const first = searchPaths(root, "txt", { limit: 2 });
    const second = searchPaths(root, "txt", { limit: 2, cursor: first.nextCursor });

    assert.equal(first.results.length, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "2");
    assert.deepEqual(second.results.map((item) => item.path), ["gamma.txt"]);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextCursor, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normalizeSearchCursor bounds unsafe offsets and rejects non-decimal cursors", () => {
  assert.equal(normalizeSearchCursor("9".repeat(100)), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeSearchCursor(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(normalizeSearchCursor("1e3"), 0);
  assert.equal(normalizeSearchCursor("-1"), 0);
  assert.equal(normalizeSearchCursor("not-a-cursor"), 0);
});

test("searchPaths pages a large directory without statting every file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-fs-search-large-"));
  const originalStatSync = fs.statSync;
  let statCalls = 0;
  try {
    fs.mkdirSync(path.join(root, "large"), { recursive: true });
    for (let index = 0; index < 1200; index += 1) {
      fs.writeFileSync(path.join(root, "large", `item-${String(index).padStart(4, "0")}.txt`), "x", "utf8");
    }
    (fs as unknown as { statSync: (...args: unknown[]) => unknown }).statSync = (...args: unknown[]) => {
      statCalls += 1;
      return (originalStatSync as unknown as (...innerArgs: unknown[]) => unknown)(...args);
    };

    const first = searchPaths(root, "large/", { limit: 30 });
    const firstPaths = new Set(first.results.map((item) => item.path));
    const second = searchPaths(root, "large/", { limit: 30, cursor: first.nextCursor });
    const secondPaths = new Set(second.results.map((item) => item.path));

    assert.equal(first.results.length, 30);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextCursor, "30");
    assert.equal(second.results.length, 30);
    assert.ok(second.results.every((item) => item.path.startsWith("large/")));
    assert.equal([...secondPaths].some((item) => firstPaths.has(item)), false);
    assert.ok(statCalls <= 60, `expected paged stat calls <= 60, got ${statCalls}`);
  } finally {
    (fs as unknown as { statSync: typeof originalStatSync }).statSync = originalStatSync;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
