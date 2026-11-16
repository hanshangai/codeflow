import { testEngineWorkspaceLog } from "./engine-workspace-log-fixture.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareCodexImagesForTurn } from "../src/engines/codex/codexImageInput.js";
import { logger } from "../src/logger.js";

/** 图片与故障只作用于本例工作区，日志替换防止诊断写入用户目录。 */
function fixture(t: test.TestContext) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const workspacePath = fs.mkdtempSync(path.join(parent, "codex-image-release-"));
  const root = path.join(workspacePath, ".codeflowai");
  const errors: Record<string, unknown>[] = [];
  t.mock.method(logger, "info", () => {});
  t.mock.method(logger, "error", (_tag: string, _message: string, data: Record<string, unknown>) => { errors.push(data); });
  const prepared = prepareCodexImagesForTurn(["data:image/png;base64,YQ==", "data:image/png;base64,Yg=="], { writeWorkspaceLog: testEngineWorkspaceLog,
    workspacePath, workspaceId: "ws-release", threadId: "thread-release", clientTurnId: "turn-release", operation: "turn/steer",
  });
  t.after(() => {
    t.mock.restoreAll();
    assert.equal(path.dirname(workspacePath), parent);
    assert.ok(path.basename(workspacePath).startsWith("codex-image-release-"));
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });
  return { root, workspacePath, prepared, errors };
}

test("image release failure is explicit, safe and still releases the other owned image", t => {
  const f = fixture(t), unlink = fs.unlinkSync;
  const primary = Object.assign(new Error("private-image-diagnostic"), { code: "EACCES", syscall: "unlink" });
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === f.prepared.images[0]) throw primary;
    return unlink(file);
  });
  assert.throws(() => f.prepared.cleanup("provider_turn_terminal"), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, "codex_image_cleanup_failed");
    assert.equal(error.cause, primary);
    return true;
  });
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(f.prepared.images[0]!)]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].errorCode, "codex_image_cleanup_failed");
  assert.equal(f.errors[0].threadId, "thread-release");
  assert.equal(f.errors[0].cleanupReason, "provider_turn_terminal");
  assert.match(String(f.errors[0].requestId), /^codex-image:/);
  assert.doesNotMatch(JSON.stringify(f.errors), /private-image-diagnostic|base64|YQ==/);
});

test("image release retains a replacement and preserves all deletion causes", t => {
  const f = fixture(t), moved = path.join(f.root, "moved.png");
  fs.renameSync(f.prepared.images[0]!, moved);
  fs.writeFileSync(f.prepared.images[0]!, "foreign-image");
  const unlink = fs.unlinkSync, secondary = new Error("unlink-second");
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => {
    if (String(file) === f.prepared.images[1]) throw secondary;
    return unlink(file);
  });
  assert.throws(() => f.prepared.cleanup(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal((error.errors[0] as NodeJS.ErrnoException).code, "codex_image_temp_identity_changed");
    assert.equal(error.errors[1], secondary);
    return true;
  });
  assert.equal(fs.readFileSync(f.prepared.images[0]!, "utf8"), "foreign-image");
  assert.equal(fs.readFileSync(moved, "utf8"), "a");
});

test("repeated failed release returns its original failure without retrying deletion", t => {
  const f = fixture(t);
  let removals = 0, first: unknown;
  t.mock.method(fs, "unlinkSync", (file: fs.PathLike) => { removals += 1; throw Object.assign(new Error("delete-failed"), { code: "EIO" }); });
  assert.throws(() => f.prepared.cleanup(), error => { first = error; return true; });
  assert.equal(removals, 2);
  assert.throws(() => f.prepared.cleanup(), error => error === first);
  assert.equal(removals, 2);
  assert.equal(f.errors.length, 1);
});

test("successful image release is idempotent and leaves local input files alone", t => {
  const f = fixture(t);
  f.prepared.cleanup();
  f.prepared.cleanup();
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.equal(f.errors.length, 0);
});

test("image release keeps both deletion errors when diagnostic logging only warns", t => {
  const f = fixture(t), primary = new Error("unlink-failed"), logError = new Error("log-failed");
  let attempts = 0;
  t.mock.method(fs, "unlinkSync", () => { attempts += 1; throw primary; });
  t.mock.method(logger, "error", () => { throw logError; });
  assert.throws(() => f.prepared.cleanup(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, primary]);
    return true;
  });
  assert.equal(attempts, 2);
});

for (const replaceRoot of [false, true]) {
  test(`image cleanup refuses a replaced ${replaceRoot ? "workspace root" : "runtime directory"}`, t => {
    const f = fixture(t);
    const original = replaceRoot ? f.workspacePath : f.root;
    const moved = `${original}-retained`;
    fs.renameSync(original, moved);
    fs.mkdirSync(original);
    if (replaceRoot) fs.mkdirSync(f.root);
    t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
    for (const image of f.prepared.images) fs.writeFileSync(image, "foreign");
    assert.throws(() => f.prepared.cleanup(), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.equal((error.errors[0] as NodeJS.ErrnoException).code, "WORKSPACE_CODEFLOWAI_DIRECTORY_UNSAFE");
      return true;
    });
    for (const image of f.prepared.images) assert.equal(fs.readFileSync(image, "utf8"), "foreign");
    assert.equal(fs.readFileSync(path.join(replaceRoot ? path.join(moved, ".codeflowai") : moved, path.basename(f.prepared.images[0]!)), "utf8"), "a");
  });
}

test("image cleanup retains hardlinked bytes and continues releasing independent images", t => {
  const f = fixture(t), alias = path.join(f.workspacePath, "linked.png");
  fs.linkSync(f.prepared.images[0]!, alias);
  assert.throws(() => f.prepared.cleanup(), error => {
    assert.ok(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, "codex_image_cleanup_failed");
    return true;
  });
  assert.equal(fs.readFileSync(alias, "utf8"), "a");
  assert.equal(fs.readFileSync(f.prepared.images[0]!, "utf8"), "a");
  assert.equal(fs.existsSync(f.prepared.images[1]!), false);
});
