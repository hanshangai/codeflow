"use strict";

const fs = require("fs");
const path = require("path");

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("[clean-dist] missing target directory");
  process.exit(1);
}

for (const target of targets) {
  const resolved = path.resolve(process.cwd(), target);
  if (fs.existsSync(resolved)) {
    fs.rmSync(resolved, { recursive: true, force: true });
    console.log(`[clean-dist] removed ${path.relative(process.cwd(), resolved) || target}`);
  }
}
