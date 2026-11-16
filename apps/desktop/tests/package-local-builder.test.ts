import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuilderProject, removeBuilderProject, toBuilderVersion } from "../scripts/package-local-builder.mjs";

test("stages a normalized shell manifest and cleans links without touching source", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "package-builder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const desktop = path.join(root, "desktop");
  for (const [relative, text] of Object.entries({
    "package.json": '{"version":"1.0"}', "dist/main.js": "main", "build/installer.nsh": "nsh",
    "node_modules/dep/package.json": "{}",
  })) {
    const file = path.join(desktop, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  }
  const stage = await createBuilderProject(desktop, "1.0");
  try {
    assert.equal(JSON.parse(await fs.readFile(path.join(stage, "package.json"), "utf8")).version, "1.0.0");
    assert.equal(await fs.readFile(path.join(stage, "dist/main.js"), "utf8"), "main");
    assert.equal(await fs.readFile(path.join(stage, "node_modules/dep/package.json"), "utf8"), "{}");
    await fs.access(path.join(stage, "build/installer.nsh"));
  } finally {
    await removeBuilderProject(stage);
  }
  await assert.rejects(fs.lstat(stage), { code: "ENOENT" });
  assert.equal(JSON.parse(await fs.readFile(path.join(desktop, "package.json"), "utf8")).version, "1.0");
  assert.equal(toBuilderVersion("1.0"), "1.0.0");
  assert.equal(toBuilderVersion("1.0.0"), "1.0.0");
});
