import assert from "node:assert/strict";
import test from "node:test";

import { resolveCliDisplayPath } from "../src/engines/cliDisplayPath.js";

/** Codex 的 Windows 启动参数以 -e 引导开头，展示路径必须指向真实入口脚本。 */
test("node -e bootstrap shows the real entry script", () => {
  assert.equal(
    resolveCliDisplayPath({ command: "node.exe", argsPrefix: ["-e", "bootstrap", "C:\\npm\\codex.js"] }),
    "C:\\npm\\codex.js",
  );
});

/** 普通 node 脚本与直接命令保持原有展示口径。 */
test("node script and direct command keep their display path", () => {
  assert.equal(resolveCliDisplayPath({ command: "node.exe", argsPrefix: ["C:\\npm\\cli.js"] }), "C:\\npm\\cli.js");
  assert.equal(resolveCliDisplayPath({ command: "codex", argsPrefix: [] }), "codex");
});

/** 不完整的 -e 参数不能把引导标记当路径展示。 */
test("incomplete node -e falls back to the command", () => {
  assert.equal(resolveCliDisplayPath({ command: "node.exe", argsPrefix: ["-e", "bootstrap"] }), "node.exe");
});
