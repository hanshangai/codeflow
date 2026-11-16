import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("desktop package declares the supported runtime and local build", async () => {
  const pkg = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
  assert.match(pkg.engines?.node ?? "", />=22\.16\.0/);
  assert.match(pkg.scripts?.build ?? "", /tsc -p tsconfig\.build\.json.*esbuild.*preloadEntry\.ts.*--format=cjs/);
});

test("desktop build metadata has Windows and macOS targets without a publish target", async () => {
  const builderConfig = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builderConfig, /win:/);
  assert.match(builderConfig, /mac:/);
  assert.doesNotMatch(builderConfig, /publish:/);
});

test("desktop packages use the CodeFlow application icon", async () => {
  const builderConfig = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
  assert.match(builderConfig, /win:\r?\n {2}icon: build\/icon\.ico/u);
  assert.match(builderConfig, /mac:\r?\n {2}icon: build\/icon\.png/u);
  const ico = await fs.readFile(new URL("../build/icon.ico", import.meta.url));
  const png = await fs.readFile(new URL("../build/icon.png", import.meta.url));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 7);
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
});
