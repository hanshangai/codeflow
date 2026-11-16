import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readPendingRelease, savePendingRelease, clearPendingRelease } from "../src/pendingRelease.js";

test("prepared release survives restart and resolves a directory moved before a crash", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-pending-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, ".staging", "next-123");
  await fs.mkdir(stagingDir, { recursive: true });
  await savePendingRelease(root, { requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3", releaseId: "next", stagingDir });
  assert.equal((await readPendingRelease(root))?.stagingDir, stagingDir);
  await fs.mkdir(path.join(root, "releases"));
  await fs.rename(stagingDir, path.join(root, "releases", "next"));
  assert.equal((await readPendingRelease(root))?.stagingDir, path.join(root, "releases", "next"));
  await clearPendingRelease(root);
  assert.equal(await readPendingRelease(root), null);
});

test("pending state rejects path traversal and damaged JSON", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-pending-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(savePendingRelease(root, { requestId: "a795cc4e-2c1f-4a3f-8611-31c54f0943d3", releaseId: "next", stagingDir: path.dirname(root) }), /INVALID/);
  await fs.writeFile(path.join(root, "pending-release.json"), "{");
  await assert.rejects(readPendingRelease(root));
});
