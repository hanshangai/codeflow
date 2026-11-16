import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  listAllowedTerminalShellOptions,
  listLaunchableTerminalShellOptions,
  resolveTerminalCwd,
  resolveTerminalShell,
  validateTerminalActionDefinition,
} from "../src/terminal/terminalSecurityPolicy.ts";

const ALLOWED_SHELLS_ENV = "CODEFLOWAI_TERMINAL_ALLOWED_SHELLS";

/** 创建带 sibling 目录的临时 workspace，用于验证终端 cwd 边界。 */
function createWorkspaceFixture(): { root: string; workspace: string; sibling: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-terminal-policy-"));
  const workspace = path.join(root, "work");
  const sibling = path.join(root, "work2");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  return {
    root,
    workspace,
    sibling,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** 临时覆盖环境变量，测试结束后恢复原值。 */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const before = process.env[name];
  try {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
    fn();
  } finally {
    if (before === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = before;
    }
  }
}

test("terminal cwd defaults to workspace and rejects sibling prefix escape", () => {
  const fixture = createWorkspaceFixture();
  try {
    assert.equal(resolveTerminalCwd(fixture.workspace, null), path.resolve(fixture.workspace));
    assert.equal(resolveTerminalCwd(fixture.workspace, "src"), path.join(fixture.workspace, "src"));
    assert.throws(
      () => resolveTerminalCwd(fixture.workspace, "missing"),
      /终端工作目录不存在/,
    );
    assert.throws(
      () => resolveTerminalCwd(fixture.workspace, "../work2"),
      /非法终端工作目录/,
    );
    assert.throws(
      () => resolveTerminalCwd(fixture.workspace, path.join(fixture.sibling, "secret")),
      /非法终端工作目录/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("terminal cwd rejects unknown workspace", () => {
  assert.throws(
    () => resolveTerminalCwd(null, "."),
    /未知 workspaceId/,
  );
});

test("terminal shell only accepts client allow-list entries", () => {
  const fixture = createWorkspaceFixture();
  try {
    const suffix = os.platform() === "win32" ? ".cmd" : "";
    const allowed = path.join(fixture.root, `allowed-shell${suffix}`);
    const denied = path.join(fixture.root, `denied-shell${suffix}`);
    fs.writeFileSync(allowed, "", "utf8");
    fs.writeFileSync(denied, "", "utf8");
    fs.chmodSync(allowed, 0o755);
    fs.chmodSync(denied, 0o755);

    withEnv(ALLOWED_SHELLS_ENV, allowed, () => {
      assert.equal(resolveTerminalShell(allowed), path.resolve(allowed));
      assert.equal(resolveTerminalShell(path.basename(allowed)), path.resolve(allowed));
      assert.deepEqual(listAllowedTerminalShellOptions().filter((option) => option.value === path.resolve(allowed)), [
        { value: path.resolve(allowed), label: path.basename(allowed).replace(/\.exe$/i, "") },
      ]);
      assert.throws(
        () => resolveTerminalShell(denied),
        /非法终端 Shell/,
      );
    });
  } finally {
    fixture.cleanup();
  }
});

test("terminal shell options hide entries that fail pty spawn probe", () => {
  const fixture = createWorkspaceFixture();
  try {
    const suffix = os.platform() === "win32" ? ".cmd" : "";
    const allowed = path.join(fixture.root, `launchable-shell${suffix}`);
    const denied = path.join(fixture.root, `blocked-shell${suffix}`);
    fs.writeFileSync(allowed, "", "utf8");
    fs.writeFileSync(denied, "", "utf8");
    fs.chmodSync(allowed, 0o755);
    fs.chmodSync(denied, 0o755);

    withEnv(ALLOWED_SHELLS_ENV, [allowed, denied].join(path.delimiter), () => {
      const result = listLaunchableTerminalShellOptions({
        cwd: fixture.workspace,
        probe: (shell) => shell === path.resolve(allowed)
          ? { ok: true }
          : { ok: false, reason: "posix_spawnp failed" },
      });
      assert.deepEqual(result.shells, [
        { value: path.resolve(allowed), label: path.basename(allowed).replace(/\.exe$/i, "") },
      ]);
      assert.deepEqual(result.unavailableShells.filter((item) => item.shell === path.resolve(denied)), [
        { shell: path.resolve(denied), reason: "posix_spawnp failed" },
      ]);
    });
  } finally {
    fixture.cleanup();
  }
});

test("terminal action validation reports unsafe cwd with action index", () => {
  const fixture = createWorkspaceFixture();
  try {
    assert.throws(
      () => validateTerminalActionDefinition(fixture.workspace, { label: "bad", cwd: "../work2" }, 0),
      /终端操作 #1 配置不合法/,
    );
  } finally {
    fixture.cleanup();
  }
});
