import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("client build typechecks before cleaning dist", () => {
  const pkg = JSON.parse(readFileSync(new URL("../client/package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };
  const build = pkg.scripts.build;
  const typecheckIndex = build.indexOf("tsc -p tsconfig.json --noEmit");
  const cleanIndex = build.indexOf("clean-dist.cjs dist");
  assert.ok(typecheckIndex >= 0 && cleanIndex >= 0, `unexpected client build script: ${build}`);
  assert.ok(typecheckIndex < cleanIndex, "clean-dist must not run before typecheck");
});

