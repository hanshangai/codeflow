import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getShellInitScript, getShellLaunchArgs } from "../../apps/desktop/client/src/terminal/shellIntegration.js";

test("PowerShell 集成使用可解码的单行命令注入", () => {
  const command = getShellInitScript("powershell");
  assert.ok(command);
  assert.equal(command.includes("\n"), false);

  const encoded = command.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encoded);
  const decoded = Buffer.from(encoded, "base64").toString("utf16le");
  assert.match(decoded, /Set-PSReadLineKeyHandler/);
  assert.match(decoded, /PSConsoleReadLine\]::AcceptLine/);
  assert.match(decoded, /__CODEFLOWAI_SHELL_INTEGRATION/);
});

test("PowerShell 与 pwsh 使用相同的安全单行注入", () => {
  assert.equal(getShellInitScript("powershell"), getShellInitScript("pwsh"));
});

test("PowerShell 在进入交互模式前静默初始化", () => {
  const args = getShellLaunchArgs("powershell");
  assert.deepEqual(args.slice(0, 3), ["-NoLogo", "-NoExit", "-Command"]);
  assert.equal(args[3], getShellInitScript("powershell"));
  assert.deepEqual(getShellLaunchArgs("bash"), []);
});

test("Windows PowerShell 真实 PTY 启动后可直接执行命令", { skip: process.platform !== "win32" }, () => {
  const nodePtyPath = fileURLToPath(new URL("../../apps/desktop/client/node_modules/node-pty/lib/index.js", import.meta.url));
  const probe = String.raw`
const pty = require(process.env.CF_NODE_PTY_PATH);
const output = [];
let commandSent = false;
const shell = pty.spawn("powershell.exe", JSON.parse(process.env.CF_POWERSHELL_ARGS), {
  name: "xterm-256color", cols: 100, rows: 30, cwd: process.cwd(), env: process.env,
});
const timeout = setTimeout(() => {
  console.error("PowerShell PTY 初始化超时", output.join("").slice(-1000));
  shell.kill();
  process.exit(2);
}, 15000);
shell.onData((data) => {
  output.push(data);
  const current = output.join("");
  if (!commandSent && current.includes("\x1b]133;B\x07")) {
    commandSent = true;
    shell.write("Write-Output '__CODEFLOWAI_PTY_READY__'; exit\r");
  }
});
shell.onExit(({ exitCode }) => {
  clearTimeout(timeout);
  const current = output.join("");
  const valid = exitCode === 0
    && current.includes("__CODEFLOWAI_PTY_READY__")
    && current.includes("\x1b]133;C\x07")
    && !current.includes("Set-PSReadLineKeyHandler")
    && !current.includes(">>");
  if (!valid) console.error(current.slice(-2000));
  process.exit(valid ? 0 : 3);
});`;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      CF_NODE_PTY_PATH: nodePtyPath,
      CF_POWERSHELL_ARGS: JSON.stringify(getShellLaunchArgs("powershell")),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
});
