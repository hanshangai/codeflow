import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("源码启动从公开新仓及旧monorepo根读取同一版本，不接受Server包身份", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-version-root-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/version.ts")).href;
  const env = { ...process.env }; delete env.CODEFLOWAI_VERSION;
  for (const name of ["codeflow", "codeflowai", "codeflow-server"]) {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "2026.11.13.07" }));
    const result = spawnSync(process.execPath, ["--conditions=development", "--import", pathToFileURL(path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs")).href,
      "--input-type=module", "-e", `const { readSelfVersion } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(readSelfVersion()));`], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), name === "codeflow-server" ? null : "2026.11.13.07");
  }
});
