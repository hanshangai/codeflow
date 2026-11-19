import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveDesktopWebFile, isTrustedDesktopUrl, assertTrustedDesktopSender, createDesktopWebHandler, resolveDesktopInitialEntry } from "../src/webProtocol.js";

test("desktop initial entry skips the public landing page without rewriting explicit paths", () => {
  assert.equal(resolveDesktopInitialEntry("codeflow://desktop/"), "codeflow://desktop/chat");
  assert.equal(resolveDesktopInitialEntry("http://localhost:39281"), "http://localhost:39281/chat");
  assert.equal(resolveDesktopInitialEntry("http://localhost:39281/"), "http://localhost:39281/chat");
  assert.equal(resolveDesktopInitialEntry("codeflow://desktop/knowledge"), "codeflow://desktop/knowledge");
});

test("serves absolute Web assets and falls back to index only for document navigation", async (t) => {
  const webDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-")));
  t.after(() => fs.rm(webDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(webDir, "assets"));
  await fs.writeFile(path.join(webDir, "assets", "app.js"), "export {};", "utf8");
  await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html>", "utf8");
  assert.equal(await resolveDesktopWebFile(webDir, "codeflow://desktop/assets/app.js", false), path.join(webDir, "assets", "app.js"));
  assert.equal(await resolveDesktopWebFile(webDir, "codeflow://desktop/workspace/chat", true), path.join(webDir, "index.html"));
  await assert.rejects(() => resolveDesktopWebFile(webDir, "codeflow://desktop/assets/missing.js", false), { code: "ENOENT" });
  await assert.rejects(() => resolveDesktopWebFile(webDir, "codeflow://desktop/%2e%2e%2fsecret", false), /DESKTOP_WEB_PATH_INVALID/);
});

test("only the configured top-level Web origin receives desktop IPC", () => {
  assert.equal(isTrustedDesktopUrl("codeflow://desktop/chat", "codeflow://desktop/"), true);
  assert.equal(isTrustedDesktopUrl("codeflow://other/chat", "codeflow://desktop/"), false);
  assert.equal(isTrustedDesktopUrl("https://example.com", "codeflow://desktop/"), false);
  assert.equal(isTrustedDesktopUrl("http://localhost:39281/chat", "http://localhost:39281"), true);
  assert.equal(isTrustedDesktopUrl("", "codeflow://desktop/"), false);
  assert.equal(isTrustedDesktopUrl("not a url", "codeflow://desktop/"), false);
  assert.throws(() => assertTrustedDesktopSender({ mainFrame: false, url: "codeflow://desktop/" }, "codeflow://desktop/"), /DESKTOP_IPC_FORBIDDEN/);
});

test("resource and fetch failures reject protocol loading instead of returning an error document", async (t) => {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-"));
  t.after(() => fs.rm(webDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html>", "utf8");
  const failures: unknown[] = [];
  const handler = createDesktopWebHandler({
    getWebDir: () => webDir,
    fetchFile: async () => new Response("failed", { status: 500 }),
    onError: (error) => { failures.push(error); },
  });
  await assert.rejects(() => handler(new Request("codeflow://desktop/assets/missing.js")), { code: "ENOENT" });
  await assert.rejects(() => handler(new Request("codeflow://desktop/index.html")), /DESKTOP_WEB_HTTP_500/);
  assert.equal(failures.length, 2);
});

test("Electron navigation with only an HTML Accept header resolves the SPA route", async (t) => {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-"));
  t.after(() => fs.rm(webDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html>", "utf8");
  const handler = createDesktopWebHandler({ getWebDir: () => webDir,
    fetchFile: async () => new Response("<!doctype html>"), onError: () => {},
  });
  const response = await handler(new Request("codeflow://desktop/workspace/chat", {
    headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
  }));
  assert.equal(await response.text(), "<!doctype html>");
});

test("default file responses preserve long-path module bytes and static MIME types", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-long-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let webDir = root;
  while (path.join(webDir, "web", "app.js").length <= 300) webDir = path.join(webDir, "release-resources-".repeat(2));
  webDir = path.join(webDir, "web");
  await fs.mkdir(webDir, { recursive: true });
  const failures: unknown[] = [];
  const handler = createDesktopWebHandler({ getWebDir: () => webDir, onError: error => { failures.push(error); } });
  const cases = [
    ["app.js", "text/javascript; charset=utf-8"], ["worker.mjs", "text/javascript; charset=utf-8"],
    ["style.css", "text/css; charset=utf-8"], ["index.html", "text/html; charset=utf-8"],
    ["data.json", "application/json; charset=utf-8"], ["image.png", "image/png"], ["image.svg", "image/svg+xml"],
    ["font.ttf", "font/ttf"], ["font.woff2", "font/woff2"], ["worker.wasm", "application/wasm"],
    ["plain.txt", "text/plain; charset=utf-8"], ["map.xml", "application/xml; charset=utf-8"], ["opaque.bin", "application/octet-stream"],
  ];
  for (const [filename, mime] of cases) {
    const bytes = Buffer.from(`long-path:${filename}:中文`);
    const target = path.join(webDir, filename!);
    assert.ok(target.length > 260);
    await fs.writeFile(target, bytes);
    const response = await handler(new Request(`codeflow://desktop/${filename}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), mime);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  assert.deepEqual(failures, []);
});

test("GET and HEAD share safe resolution while other methods fail before file transport", async (t) => {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-"));
  t.after(() => fs.rm(webDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html>中文", "utf8");
  const failures: unknown[] = [];
  const handler = createDesktopWebHandler({ getWebDir: () => webDir, onError: error => { failures.push(error); } });
  const get = await handler(new Request("codeflow://desktop/"));
  const head = await handler(new Request("codeflow://desktop/", { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), get.headers.get("content-type"));
  assert.equal(head.headers.get("content-length"), get.headers.get("content-length"));
  assert.equal(head.body, null);
  assert.equal(await head.text(), "");
  assert.equal(get.headers.get("cache-control"), "no-store");
  const range = await handler(new Request("codeflow://desktop/", { headers: { range: "bytes=1-3" } }));
  assert.equal(range.status, 200);
  assert.equal(range.headers.get("content-range"), null);
  assert.equal(await range.text(), "<!doctype html>中文");
  let calls = 0;
  const injected = createDesktopWebHandler({ getWebDir: () => webDir, fetchFile: async () => { calls++; return new Response("unexpected"); },
    onError: error => { failures.push(error); } });
  await assert.rejects(() => injected(new Request("codeflow://desktop/", { method: "POST" })), /DESKTOP_WEB_METHOD_INVALID/);
  assert.equal(calls, 0);
  assert.equal(failures.length, 1);
});

test("default response retains SPA-only fallback and rejects static absence and external junctions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const webDir = path.join(root, "web"), outside = path.join(root, "outside");
  await fs.mkdir(webDir); await fs.mkdir(outside);
  await fs.writeFile(path.join(webDir, "index.html"), "<!doctype html>SPA");
  await fs.writeFile(path.join(outside, "secret.js"), "secret");
  await fs.mkdir(path.join(webDir, "assets"));
  await fs.writeFile(path.join(webDir, "assets", "app.js"), "export {};");
  await fs.symlink(outside, path.join(webDir, "escape"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(path.join(webDir, "assets"), path.join(webDir, "alias"), process.platform === "win32" ? "junction" : "dir");
  const failures: unknown[] = [];
  const handler = createDesktopWebHandler({ getWebDir: () => webDir, onError: error => { failures.push(error); } });
  assert.equal(await (await handler(new Request("codeflow://desktop/alias/app.js"))).text(), "export {};");
  assert.equal(await (await handler(new Request("codeflow://desktop/workspace/chat", { headers: { accept: "text/html" } }))).text(), "<!doctype html>SPA");
  await assert.rejects(() => handler(new Request("codeflow://desktop/assets/missing.js")), { code: "ENOENT" });
  await assert.rejects(() => handler(new Request("codeflow://desktop/escape/secret.js")), /DESKTOP_WEB_PATH_INVALID/);
  await assert.rejects(() => handler(new Request("codeflow://desktop/%2e%2e%2foutside/secret.js")), /DESKTOP_WEB_PATH_INVALID/);
  assert.equal(failures.length, 3);
});

test("file read and error-log failures preserve both original error objects", async (t) => {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-desktop-web-read-"));
  t.after(() => fs.rm(webDir, { recursive: true, force: true }));
  const target = path.join(webDir, "app.js");
  await fs.writeFile(target, "export {};");
  const realTarget = await fs.realpath(target);
  const expected = Object.assign(new Error("read failed"), { code: "EIO" });
  const logError = new Error("log failed"), failures: unknown[] = [];
  const original = fs.readFile;
  t.mock.method(fs, "readFile", (filename: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
    if (String(filename) === realTarget) return Promise.reject(expected);
    return Reflect.apply(original, fs, [filename, ...args]);
  });
  const readFailure = createDesktopWebHandler({ getWebDir: () => webDir, onError: error => { failures.push(error); } });
  await assert.rejects(() => readFailure(new Request("codeflow://desktop/app.js")), error => error === expected);
  const handler = createDesktopWebHandler({ getWebDir: () => webDir, onError: error => { failures.push(error); throw logError; } });
  await assert.rejects(() => handler(new Request("codeflow://desktop/app.js")), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "DESKTOP_WEB_ERROR_LOG_FAILED");
    assert.deepEqual(error.errors, [expected, logError]);
    return true;
  });
  assert.deepEqual(failures, [expected, expected]);
});
