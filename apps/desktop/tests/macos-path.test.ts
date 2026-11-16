import assert from "node:assert/strict";
import test from "node:test";

import { augmentMacOSGuiPath } from "../src/macosPath.js";

test("macOS GUI PATH 补齐 Homebrew 与用户级工具目录且去重", () => {
  const existing = new Set(["/opt/homebrew/bin", "/usr/local/bin", "/Users/dev/.local/bin", "/Users/dev/.npm-global/bin"]);
  const result = augmentMacOSGuiPath(
    { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: "/Users/dev" },
    { exists: target => existing.has(target), readdir: () => [] },
  );
  assert.deepEqual(result.split(":"), ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/dev/.local/bin", "/Users/dev/.npm-global/bin"]);
});

test("macOS GUI PATH 按版本倒序补齐 nvm/fnm Node 目录", () => {
  const existing = new Set([
    "/Users/dev/.nvm/versions/node/v22.1.0/bin",
    "/Users/dev/.nvm/versions/node/v20.9.0/bin",
    "/Users/dev/.local/share/fnm/node-versions/v21.0.0/installation/bin",
  ]);
  const result = augmentMacOSGuiPath(
    { PATH: "/usr/bin", HOME: "/Users/dev" },
    {
      exists: target => existing.has(target),
      readdir: directory => {
        if (directory === "/Users/dev/.nvm/versions/node") return ["v20.9.0", "v22.1.0"];
        if (directory === "/Users/dev/.local/share/fnm/node-versions") return ["v21.0.0"];
        return [];
      },
    },
  );
  assert.deepEqual(result.split(":"), [
    "/usr/bin",
    "/Users/dev/.nvm/versions/node/v22.1.0/bin",
    "/Users/dev/.nvm/versions/node/v20.9.0/bin",
    "/Users/dev/.local/share/fnm/node-versions/v21.0.0/installation/bin",
  ]);
});
