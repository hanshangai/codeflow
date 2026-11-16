import test from "node:test";
import assert from "node:assert/strict";

import { formatClientHelp, parseClientCliArgs, toDaemonChildArgs } from "../../apps/desktop/client/src/cliArgs.ts";

test("parseClientCliArgs defaults to daemon start with no args", () => {
  assert.deepEqual(parseClientCliArgs([]), { kind: "daemon", action: "start" });
});

test("parseClientCliArgs recognizes help flags", () => {
  assert.deepEqual(parseClientCliArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseClientCliArgs(["-h"]), { kind: "help" });
});

test("parseClientCliArgs recognizes version flags", () => {
  assert.deepEqual(parseClientCliArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseClientCliArgs(["-v"]), { kind: "version" });
});

test("parseClientCliArgs recognizes foreground mode", () => {
  assert.deepEqual(parseClientCliArgs(["--foreground"]), { kind: "run" });
});

test("parseClientCliArgs accepts only the long --key value option for startup", () => {
  assert.deepEqual(parseClientCliArgs(["--key", "codeflowai_cli_test_value"]), {
    kind: "daemon",
    action: "start",
    apiKeyOverride: "codeflowai_cli_test_value",
    apiKeyProvided: true,
  });
  assert.deepEqual(parseClientCliArgs(["--foreground", "--key", "codeflowai_cli_test_value"]), {
    kind: "run",
    apiKeyOverride: "codeflowai_cli_test_value",
    apiKeyProvided: true,
  });
  assert.deepEqual(parseClientCliArgs(["-k", "codeflowai_cli_test_value"]).kind, "error");
});

test("parseClientCliArgs rejects unsafe key forms and non-start commands", () => {
  assert.deepEqual(parseClientCliArgs(["--key"]), { kind: "error", message: "--key 缺少值" });
  assert.deepEqual(parseClientCliArgs(["--key", "--foreground"]), { kind: "error", message: "--key 缺少值" });
  assert.deepEqual(parseClientCliArgs(["--key=codeflowai_cli_test_value"]), {
    kind: "error",
    message: "--key 必须使用独立值形式：--key <value>",
  });
  assert.deepEqual(parseClientCliArgs(["--key", "codeflowai_cli_test_value", "--key", "other"]), {
    kind: "error",
    message: "--key 只能传入一次",
  });
  assert.deepEqual(parseClientCliArgs(["--key", "codeflowai_cli_test_value", "--stop"]), {
    kind: "error",
    message: "--key 只能与启动命令组合使用",
  });
});

test("parseClientCliArgs recognizes update flag only", () => {
  assert.deepEqual(parseClientCliArgs(["--update"]), { kind: "update" });
  assert.deepEqual(parseClientCliArgs(["update"]), {
    kind: "error",
    message: "不支持的参数: update",
  });
});

test("parseClientCliArgs recognizes uninstall flag only", () => {
  assert.deepEqual(parseClientCliArgs(["--uninstall"]), { kind: "uninstall" });
  assert.deepEqual(parseClientCliArgs(["uninstall"]), {
    kind: "error",
    message: "不支持的参数: uninstall",
  });
});

test("parseClientCliArgs rejects uninstall flag combinations", () => {
  assert.deepEqual(parseClientCliArgs(["--uninstall", "--key", "codeflowai_cli_test_value"]), {
    kind: "error",
    message: "--key 只能与启动命令组合使用",
  });
  assert.deepEqual(parseClientCliArgs(["--uninstall", "--daemon"]), {
    kind: "error",
    message: "不支持组合参数: --uninstall --daemon",
  });
  assert.deepEqual(parseClientCliArgs(["--uninstall", "--foreground"]), {
    kind: "error",
    message: "不支持组合参数: --uninstall --foreground",
  });
});

test("toDaemonChildArgs never turns uninstall into a daemon child command", () => {
  // 卸载是终结命令，不进入 daemon 派生路径：即使被拼进 child 参数也只能退回前台主循环。
  const childArgs = toDaemonChildArgs(["--uninstall"]);
  assert.deepEqual(childArgs, ["--foreground", "--uninstall"]);
  assert.equal(parseClientCliArgs(childArgs).kind, "error");
});

test("parseClientCliArgs recognizes daemon flags", () => {
  assert.deepEqual(parseClientCliArgs(["--daemon"]), { kind: "daemon", action: "start" });
  assert.deepEqual(parseClientCliArgs(["--background"]), { kind: "daemon", action: "start" });
  assert.deepEqual(parseClientCliArgs(["--stop"]), { kind: "daemon", action: "stop" });
  assert.deepEqual(parseClientCliArgs(["--status"]), { kind: "daemon", action: "status" });
  assert.deepEqual(parseClientCliArgs(["--ready"]), { kind: "daemon", action: "ready" });
  assert.equal(parseClientCliArgs(["--ready", "--key", "test-secret"]).kind, "error");
});

test("parseClientCliArgs rejects daemon flag combinations", () => {
  assert.deepEqual(parseClientCliArgs(["--daemon", "--status"]), {
    kind: "error",
    message: "后台启动参数不能组合使用",
  });
  assert.deepEqual(parseClientCliArgs(["--daemon", "--verbose"]), {
    kind: "error",
    message: "不支持组合参数: --daemon --verbose",
  });
});

test("toDaemonChildArgs strips daemon start flags", () => {
  assert.deepEqual(toDaemonChildArgs([]), ["--foreground"]);
  assert.deepEqual(toDaemonChildArgs(["--daemon"]), ["--foreground"]);
  assert.deepEqual(toDaemonChildArgs(["--background"]), ["--foreground"]);
});

test("toDaemonChildArgs preserves explicit key and its value", () => {
  assert.deepEqual(toDaemonChildArgs(["--daemon", "--key", "codeflowai_cli_test_value"]), [
    "--foreground",
    "--key",
    "codeflowai_cli_test_value",
  ]);
});

test("parseClientCliArgs rejects unknown args", () => {
  assert.deepEqual(parseClientCliArgs(["--verbose"]), {
    kind: "error",
    message: "不支持的参数: --verbose",
  });
  assert.deepEqual(parseClientCliArgs(["workspace-a"]), {
    kind: "error",
    message: "不支持的参数: workspace-a",
  });
});

test("formatClientHelp includes usage and env guidance", () => {
  const help = formatClientHelp("2026.04.17.02");
  assert.match(help, /CodeFlowAI Client CLI 2026\.04\.17\.02/);
  assert.match(help, /codeflow --foreground/);
  assert.match(help, /codeflow --daemon/);
  assert.match(help, /codeflow --status/);
  assert.match(help, /codeflow --stop/);
  assert.match(help, /codeflow --update/);
  assert.match(help, /codeflow --uninstall/);
  assert.match(help, /codeflow --help/);
  assert.match(help, /codeflow --version/);
  assert.match(help, /CODEFLOWAI_API_KEY/);
  assert.match(help, /codeflow --key <value>/);
  assert.match(help, /CODEFLOWAI_SERVER_WS/);
});
