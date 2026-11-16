#!/usr/bin/env node
// 测试用假 npm：只解析 --prefix，按 staging package.json 的 dependencies 生成最小包结构。
// 不访问网络、不执行 lifecycle scripts，保证安装流程测试可离线且确定。
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
if (prefixIndex === -1 || !args[prefixIndex + 1]) fail("fake npm: missing --prefix");
const prefix = path.resolve(args[prefixIndex + 1]);

if (process.env.FAKE_NPM_FAIL === "1") fail("fake npm: forced failure");

let stagingPackage;
try {
  stagingPackage = JSON.parse(fs.readFileSync(path.join(prefix, "package.json"), "utf8"));
} catch (error) {
  fail(`fake npm: cannot read staging package.json: ${error.message}`);
}

const dependencies = stagingPackage.dependencies && typeof stagingPackage.dependencies === "object"
  ? stagingPackage.dependencies
  : {};

// 记录实际 argv/env/固定依赖，测试据此防住去掉 --ignore-scripts 或改用 latest 的回归。
fs.writeFileSync(path.join(prefix, "fake-npm-record.json"), JSON.stringify({
  argv: args,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  dependencies,
}));

for (const [name, version] of Object.entries(dependencies)) {
  const packageDir = path.join(prefix, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(packageDir, "bin", "codex.js"), "process.stdout.write(\"0.166.0\\n\");\n");
  // Claude 的显式 postinstall 记录实际 env 与 cwd，供测试断言 Electron Node 模式。
  if (name === "@anthropic-ai/claude-code") {
    fs.writeFileSync(path.join(packageDir, "install.cjs"), [
      "\"use strict\";",
      "const fs = require(\"node:fs\");",
      "const path = require(\"node:path\");",
      "fs.writeFileSync(path.join(__dirname, \"install-record.json\"), JSON.stringify({",
      "  cwd: process.cwd(),",
      "  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,",
      "  npmConfigOmit: process.env.npm_config_omit ?? null,",
      "}));",
      "",
    ].join("\n"));
  }
}

// 测试多平台原生包冲突时额外生成指定包目录。
for (const extra of String(process.env.FAKE_NPM_EXTRA_PACKAGE || "").split(",").map((item) => item.trim()).filter(Boolean)) {
  const packageDir = path.join(prefix, "node_modules", ...extra.split("/"));
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: extra, version: "0.0.0" }));
}

process.stdout.write(`fake npm installed ${Object.keys(dependencies).join(", ")} into ${prefix}\n`);
