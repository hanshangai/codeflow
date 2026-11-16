import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveSharedWorkspaceEffectiveOperationPolicy, type SharedWorkspaceCommandEnvelope } from "@codeflowai/shared";
import { handleSharedWorkspaceCommand } from "../src/app/handlers/sharedWorkspaceHandlers.ts";
import { logger } from "../src/logger.ts";

/** Exercise the real shared command and filesystem handlers against an isolated workspace. */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-private-read-"));
  fs.mkdirSync(path.join(root, ".codeflow"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, ".codeflow", "secret.txt"), "private-runtime-bytes");
  fs.writeFileSync(path.join(root, ".codeflow", "secret.csv"), "key,value\nsecret,private-runtime-bytes\n");
  fs.writeFileSync(path.join(root, ".codeflow", "secret.pdf"), "%PDF-1.4\nprivate-runtime-bytes\n%%EOF");
  fs.writeFileSync(path.join(root, "docs", "public.txt"), "public-source");
  fs.symlinkSync(path.join(root, ".codeflow"), path.join(root, "public-alias"), process.platform === "win32" ? "junction" : "dir");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Use a Server-shaped envelope; payload identity fields remain untrusted. */
async function execute(root: string, payload: Record<string, unknown>, owner = false, includeOwner = true, includeLock = true) {
  const messages: any[] = [];
  const operationKey = payload.action ? "workspace.fs.write" : payload.method === "fs.tree" ? "workspace.fs.tree" : "workspace.fs.read";
  const policy = resolveSharedWorkspaceEffectiveOperationPolicy(operationKey, payload)!;
  const envelope = {
    sharedWorkspaceId: "shared-test", actorUserId: owner ? "host-user" : "member-user",
    ...(includeOwner ? { hostUserId: "host-user" } : {}),
    actorRemoteSessionId: null, hostBindingId: "binding-test", routeEventId: "route-test",
    localWorkspaceId: "host-workspace", operationId: "operation-test", operationKey, policy,
    authorization: { actorAssetRole: "enterprise_admin", authorizationResult: "allowed", authorizationReason: "test",
      assetType: "unknown", assetId: "", assetAction: "update" },
    ...(includeLock ? { lockToken: "test-lock", lockVersion: 1 } : {}),
    payload: { workspaceId: "attacker-workspace", actorUserId: "host-user", hostUserId: "member-user", ...payload }, createdAt: Date.now(),
  } as SharedWorkspaceCommandEnvelope;
  await handleSharedWorkspaceCommand({ clientId: "test-host", workspaces: new Map([["host-workspace", root]]),
    /** 文件边界夹具不读SQL，显式提供统一Host工作区装配合同。 */
    db: { forWorkspace() { return this; },
      writeWorkspaceLog(_workspaceId: string, entry: any) { logger[entry.level as "warn" | "error"](entry.tag, entry.message, entry.data); } },
    send: (message: unknown) => { messages.push(message); } } as any, envelope);
  const results = messages.filter((message) => message.t === "sharedWorkspace.route.result");
  assert.equal(results.length, 1);
  return results[0].message;
}

test("members read runtime files through direct paths and internal aliases", async (t) => {
  const root = fixture(t);
  for (const target of [".codeflow/secret.txt", "./.codeflow/secret.txt", ".codeflow\\secret.txt", "public-alias/secret.txt",
    ...(process.platform === "win32" ? [".CODEFLOW/secret.txt"] : [])]) {
    const result = await execute(root, { method: "fs.readFile", path: target });
    assert.equal(result.status, "succeeded", target);
    assert.equal(result.result.content, "private-runtime-bytes", target);
  }
});

test("members use runtime preview, stat and every download method", async (t) => {
  const root = fixture(t);
  for (const method of ["fs.stat", "fs.readFile", "fs.downloadFile", "fs.downloadStat", "fs.downloadChunk", "fs.spreadsheetPreview", "fs.documentPreview"]) {
    const result = await execute(root, { method, path: method === "fs.documentPreview" ? "public-alias/secret.pdf" : "public-alias/secret.csv", offset: 0, length: 4 });
    assert.equal(result.status, "succeeded", method);
    if (method === "fs.readFile") assert.match(result.result.content, /private-runtime-bytes/);
    if (method === "fs.downloadFile") assert.match(Buffer.from(result.result.base64, "base64").toString("utf8"), /private-runtime-bytes/);
    if (method === "fs.downloadChunk") assert.equal(Buffer.from(result.result.base64, "base64").toString("utf8"), "key,");
    if (method === "fs.spreadsheetPreview") assert.deepEqual(result.result.rows, [["key", "value"], ["secret", "private-runtime-bytes"]]);
    if (method === "fs.documentPreview") assert.match(Buffer.from(result.result.base64, "base64").toString("utf8"), /private-runtime-bytes/);
  }
});

test("member trees show runtime directories when hidden files are requested", async (t) => {
  const root = fixture(t);
  const result = await execute(root, { method: "fs.tree", dirPath: "", depth: 3, showHidden: true });
  assert.equal(result.status, "succeeded");
  assert.ok(result.result.nodes.some((node: any) => node.path === ".codeflow"));
  assert.ok(result.result.nodes.some((node: any) => node.path === "public-alias"));
  for (const dirPath of [".codeflow", "public-alias"]) {
    const tree = await execute(root, { method: "fs.tree", dirPath, showHidden: true });
    assert.equal(tree.status, "succeeded");
    assert.equal(tree.result.nodes.length, 3);
  }
  const ordinary = await execute(root, { method: "fs.tree", dirPath: "", showHidden: false });
  assert.equal(ordinary.result.nodes.some((node: any) => node.path === ".codeflow"), false);
});

test("owner and envelopes without owner metadata retain runtime access", async (t) => {
  const root = fixture(t);
  const tree = await execute(root, { method: "fs.tree", dirPath: ".codeflow", depth: 1, showHidden: true }, true);
  assert.equal(tree.status, "succeeded");
  assert.equal(tree.result.nodes.length, 3);
  for (const method of ["fs.readFile", "fs.downloadFile", "fs.downloadStat", "fs.downloadChunk", "fs.spreadsheetPreview"]) {
    const result = await execute(root, { method, path: ".codeflow/secret.csv", offset: 0, length: 8 }, true);
    assert.equal(result.status, "succeeded", method);
  }
  assert.equal((await execute(root, { method: "fs.readFile", path: ".codeflow/secret.txt" }, false, false)).result.content, "private-runtime-bytes");
  assert.equal((await execute(root, { method: "fs.readFile", path: "docs/public.txt" })).status, "succeeded");
  assert.equal((await execute(root, { method: "fs.documentPreview", path: ".codeflow/secret.pdf" }, true)).status, "succeeded");
});

test("runtime access succeeds without emitting a permission failure", async (t) => {
  const root = fixture(t);
  const warnings = t.mock.method(logger, "warn", () => {});
  const errors = t.mock.method(logger, "error", () => {});
  const result = await execute(root, { method: "fs.readFile", path: ".codeflow/secret.txt" });
  assert.equal(result.status, "succeeded");
  assert.equal(result.result.content, "private-runtime-bytes");
  assert.equal(warnings.mock.calls.length + errors.mock.calls.length, 0);
  assert.equal((await execute(root, { method: "fs.readFile", path: "docs/public.txt" })).status, "succeeded");
});

test("member trees preserve exact alias names when checking leading or trailing spaces", async (t) => {
  const root = fixture(t);
  for (const alias of [" leading-alias", "trailing-alias ", " both-alias "]) {
    const aliasPath = path.join(root, alias);
    fs.symlinkSync(path.join(root, ".codeflow"), process.platform === "win32" ? path.toNamespacedPath(aliasPath) : aliasPath,
      process.platform === "win32" ? "junction" : "dir");
  }
  const result = await execute(root, { method: "fs.tree", dirPath: "", depth: 3, showHidden: true });
  assert.equal(result.status, "succeeded");
  for (const name of [" leading-alias", "trailing-alias ", " both-alias "]) {
    assert.ok(result.result.nodes.some((node: any) => node.path === name), name);
  }
});

test("path identity failure fails once without serving content and recovers on the next request", async (t) => {
  const root = fixture(t);
  const original = fs.realpathSync;
  const errors = t.mock.method(logger, "error", () => {});
  const injected = t.mock.method(fs, "realpathSync", (...args: any[]) => {
    if (String(args[0]).endsWith("public.txt")) throw Object.assign(new Error("injected identity failure"), { code: "EIO" });
    return Reflect.apply(original, fs.realpathSync, args);
  });
  Object.assign(injected, { native: original.native });
  const failed = await execute(root, { method: "fs.readFile", path: "docs/public.txt" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.status, 500);
  assert.equal(failed.result, undefined);
  assert.equal(errors.mock.calls.length, 1);
  const entry = errors.mock.calls[0].arguments[2] as any;
  assert.equal(entry.code, "EIO");
  assert.match(entry.rootCause, /injected identity failure/);
  assert.equal(entry.actorUserId, "member-user");
  injected.mock.restore();
  assert.equal((await execute(root, { method: "fs.readFile", path: "docs/public.txt" })).status, "succeeded");
});

test("members can read runtime files through workspace and runtime-root junctions", async (t) => {
  const root = fixture(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-root-alias-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.symlinkSync(root, path.join(base, "workspace"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await execute(path.join(base, "workspace"), { method: "fs.readFile", path: "public-alias/secret.txt" })).result.content, "private-runtime-bytes");
  fs.unlinkSync(path.join(root, "public-alias"));
  fs.renameSync(path.join(root, ".codeflow"), path.join(root, "private-target"));
  fs.symlinkSync(path.join(root, "private-target"), path.join(root, ".codeflow"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await execute(root, { method: "fs.readFile", path: "private-target/secret.txt" })).result.content, "private-runtime-bytes");
  assert.equal((await execute(root, { method: "fs.readFile", path: "private-target/secret.txt" }, true)).status, "succeeded");
});

for (const method of ["fs.stat", "fs.readFile", "fs.downloadFile", "fs.downloadStat", "fs.downloadChunk", "fs.spreadsheetPreview", "fs.documentPreview"]) {
  test(`workspace traversal remains forbidden for ${method}`, async (t) => {
    const root = fixture(t);
    const errors = t.mock.method(logger, "error", () => {});
    const warnings = t.mock.method(logger, "warn", () => {});
    const result = await execute(root, { method, path: "../outside.txt", offset: 0, length: 4 });
    assert.equal(result.status, "failed");
    assert.equal(result.error.status, 400);
    assert.equal(result.result, undefined);
    assert.equal(errors.mock.calls.length + warnings.mock.calls.length, 1);
    const entry = warnings.mock.calls[0].arguments[2] as any;
    assert.equal(entry.requestId, "operation-test");
    assert.equal(entry.actorUserId, "member-user");
    assert.equal(entry.routeEventId, "route-test");
  });
}

test("invalid shared file paths fail explicitly with one correlated diagnostic", async (t) => {
  const root = fixture(t);
  const warnings = t.mock.method(logger, "warn", () => {});
  const errors = t.mock.method(logger, "error", () => {});
  const result = await execute(root, { method: "fs.readFile", path: "../outside.txt" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.status, 400);
  assert.equal(warnings.mock.calls.length + errors.mock.calls.length, 1);
  assert.equal((warnings.mock.calls[0].arguments[2] as any).requestId, "operation-test");
});

test("ordinary aliases and similar directory names remain visible to members", async (t) => {
  const root = fixture(t);
  for (const dir of [".codeflow-notes", "nested/.codeflow"]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "normal.txt"), "normal");
    assert.equal((await execute(root, { method: "fs.readFile", path: `${dir}/normal.txt` })).status, "succeeded");
  }
  fs.symlinkSync(path.join(root, "docs"), path.join(root, "docs-alias"), process.platform === "win32" ? "junction" : "dir");
  assert.equal((await execute(root, { method: "fs.readFile", path: "docs-alias/public.txt" })).status, "succeeded");
  const tree = await execute(root, { method: "fs.tree", dirPath: "docs-alias", depth: 1, showHidden: true });
  assert.equal(tree.status, "succeeded");
  assert.equal(tree.result.nodes[0].path, "docs-alias/public.txt");
});

test("stat I/O errors fail with shared diagnostic context while missing files retain exists=false", async (t) => {
  const root = fixture(t);
  const original = fs.statSync;
  const errors = t.mock.method(logger, "error", () => {});
  const injected = t.mock.method(fs, "statSync", (...args: any[]) => {
    if (String(args[0]).endsWith("public.txt")) throw Object.assign(new Error("injected stat failure"), { code: "EIO" });
    return Reflect.apply(original, fs, args);
  });
  const failed = await execute(root, { method: "fs.stat", path: "docs/public.txt" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.status, 500);
  assert.equal(errors.mock.calls.length, 1);
  const entry = errors.mock.calls[0].arguments[2] as any;
  assert.equal(entry.requestId, "operation-test");
  assert.equal(entry.actorUserId, "member-user");
  assert.equal(entry.hostBindingId, "binding-test");
  injected.mock.restore();
  const missing = await execute(root, { method: "fs.stat", path: "docs/missing.txt" });
  assert.equal(missing.status, "succeeded");
  assert.equal(missing.result.exists, false);
});

test("members create, edit, rename and delete runtime files through existing write operations", async (t) => {
  const root = fixture(t);
  assert.equal((await execute(root, { action: "write", path: ".codeflow/new.txt", content: "created" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/new.txt"), "utf8"), "created");
  assert.equal((await execute(root, { action: "write", path: " .codeflow/secret.txt ", content: "overwrite" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/secret.txt"), "utf8"), "overwrite");
  assert.equal((await execute(root, { action: "rename", path: "docs/public.txt", newPath: ".codeflow/replaced.txt" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/replaced.txt"), "utf8"), "public-source");
  assert.equal((await execute(root, { action: "delete", path: "public-alias/secret.txt" })).status, "succeeded");
  assert.equal(fs.existsSync(path.join(root, ".codeflow/secret.txt")), false);
  assert.equal((await execute(root, { action: "rename", path: ".codeflow", newPath: "renamed-runtime" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, "renamed-runtime/new.txt"), "utf8"), "created");
  assert.equal((await execute(root, { action: "write", path: "docs/new.txt", content: "normal" })).status, "succeeded");
  assert.equal((await execute(root, { action: "write", path: ".codeflow/owner.txt", content: "owner" }, true)).status, "succeeded");
});

test("member trees preserve normal filenames and directories containing spaces", async (t) => {
  const root = fixture(t);
  for (const name of [" leading.txt", "trailing.txt "]) {
    fs.writeFileSync(process.platform === "win32" ? path.toNamespacedPath(path.join(root, name)) : path.join(root, name), "normal");
  }
  fs.mkdirSync(path.join(root, " normal-dir"));
  fs.writeFileSync(path.join(root, " normal-dir", " child.txt"), "normal");
  const result = await execute(root, { method: "fs.tree", dirPath: "", depth: 3, showHidden: true });
  assert.equal(result.status, "succeeded");
  const nodes = result.result.nodes;
  assert.ok(nodes.some((node: any) => node.path === " leading.txt"));
  assert.ok(nodes.some((node: any) => node.path === "trailing.txt "));
  assert.equal(nodes.find((node: any) => node.path === " normal-dir").children[0].path, " normal-dir/ child.txt");
});

test("runtime file writes still require the original shared write lock", async (t) => {
  const root = fixture(t);
  const payload = { action: "write", path: ".codeflow/secret.txt", content: "changed" };
  const denied = await execute(root, payload, false, true, false);
  assert.equal(denied.status, "failed");
  assert.equal(denied.error.code, "SHARED_WORKSPACE_LOCK_REQUIRED");
  assert.equal(denied.error.status, 409);
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/secret.txt"), "utf8"), "private-runtime-bytes");
  assert.equal((await execute(root, payload)).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/secret.txt"), "utf8"), "changed");
});

test("runtime access keeps external directory links outside every file read boundary", async (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-outside-read-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "outside.csv"), "key,value\nexternal,OUTSIDE-BYTES\n", "utf8");
  fs.writeFileSync(path.join(outside, "outside.pdf"), "%PDF-1.4\nOUTSIDE-BYTES\n%%EOF", "utf8");
  fs.symlinkSync(outside, path.join(root, "external"), process.platform === "win32" ? "junction" : "dir");
  for (const method of ["fs.stat", "fs.readFile", "fs.downloadFile", "fs.downloadStat", "fs.downloadChunk", "fs.spreadsheetPreview", "fs.documentPreview", "fs.tree"]) {
    const result = await execute(root, { method, path: method === "fs.documentPreview" ? "external/outside.pdf" : "external/outside.csv", dirPath: "external", offset: 0, length: 4 });
    assert.equal(result.status, "failed", method);
    assert.equal(result.error.status, 400, method);
    assert.equal(result.result, undefined, method);
    assert.equal(JSON.stringify(result).includes("OUTSIDE-BYTES"), false, method);
  }
  const tree = await execute(root, { method: "fs.tree", dirPath: "", depth: 3, showHidden: true });
  assert.equal(tree.status, "failed");
  assert.equal(tree.error.status, 400);
});

test("runtime file writes reject external links before changing either rename endpoint", async (t) => {
  const root = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-outside-write-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "retained.txt"), "OUTSIDE-ORIGINAL", "utf8");
  fs.unlinkSync(path.join(root, "public-alias"));
  fs.rmSync(path.join(root, ".codeflow"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".codeflow"), process.platform === "win32" ? "junction" : "dir");
  for (const payload of [
    { action: "write", path: ".codeflow/retained.txt", content: "MEMBER-WROTE-OUTSIDE" },
    { action: "write", path: ".codeflow/new/deep.txt", content: "NEW-OUTSIDE" },
    { action: "delete", path: ".codeflow/retained.txt" },
    { action: "rename", path: ".codeflow/retained.txt", newPath: "docs/stolen.txt" },
    { action: "rename", path: "docs/public.txt", newPath: ".codeflow/moved.txt" },
  ]) {
    const result = await execute(root, payload);
    assert.equal(result.status, "failed", JSON.stringify(payload));
    assert.equal(result.error.status, 400);
    assert.equal(fs.readFileSync(path.join(outside, "retained.txt"), "utf8"), "OUTSIDE-ORIGINAL");
    assert.deepEqual(fs.readdirSync(outside), ["retained.txt"]);
    assert.equal(fs.readFileSync(path.join(root, "docs/public.txt"), "utf8"), "public-source");
    assert.equal(fs.existsSync(path.join(root, "docs/stolen.txt")), false);
  }
});

test("runtime writes retain internal aliases and workspace-root junctions", async (t) => {
  const root = fixture(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-shared-write-root-alias-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const linkedRoot = path.join(base, "workspace");
  fs.symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await execute(linkedRoot, { action: "write", path: "public-alias/new/deep.txt", content: "internal" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, ".codeflow/new/deep.txt"), "utf8"), "internal");
  assert.equal((await execute(linkedRoot, { action: "rename", path: "public-alias/new/deep.txt", newPath: "docs/moved.txt" })).status, "succeeded");
  assert.equal(fs.readFileSync(path.join(root, "docs/moved.txt"), "utf8"), "internal");
  assert.equal((await execute(linkedRoot, { action: "delete", path: ".codeflow/new" })).status, "succeeded");
  assert.equal(fs.existsSync(path.join(root, ".codeflow/new")), false);
});
