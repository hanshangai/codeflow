import path from "node:path";
import { runMacOSUninstall, type MacOSUninstallPlan } from "./macosUninstall.js";

/** 只接受固定参数名；重复、缺值与未知项立即失败，避免删除范围被外部覆盖。 */
function parseArguments(argv: string[]): MacOSUninstallPlan {
  const values = new Map<string, string>();
  const names = new Set(["--app-root", "--data-dir", "--user-data-dir", "--log-file", "--wait-pid", "--session-data-dir", "--request-id"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!name || !names.has(name) || value === undefined || values.has(name)) {
      throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_ARGUMENTS_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_ARGUMENTS_INVALID" });
    }
    values.set(name, value);
  }
  const required = ["--app-root", "--data-dir", "--user-data-dir", "--log-file"];
  if (required.some(name => !values.get(name))) {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_ARGUMENTS_INVALID"), { code: "DESKTOP_MACOS_UNINSTALL_ARGUMENTS_INVALID" });
  }
  const pidValue = values.get("--wait-pid");
  const parentPid = pidValue === undefined ? undefined : Number(pidValue);
  return {
    applicationRoot: values.get("--app-root")!,
    dataDir: values.get("--data-dir")!,
    userDataDir: values.get("--user-data-dir")!,
    sessionDataDir: values.get("--session-data-dir"),
    logFile: values.get("--log-file")!,
    parentPid,
    requestId: values.get("--request-id"),
  };
}

/** 子进程以 ELECTRON_RUN_AS_NODE 启动；父应用退出后才执行清理。 */
async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    throw Object.assign(new Error("DESKTOP_MACOS_UNINSTALL_PLATFORM_REQUIRED"), { code: "DESKTOP_MACOS_UNINSTALL_PLATFORM_REQUIRED" });
  }
  const plan = parseArguments(process.argv.slice(2));
  await runMacOSUninstall({ ...plan, logFile: path.resolve(plan.logFile) });
}

main().catch(error => {
  console.error(JSON.stringify({ code: "DESKTOP_MACOS_UNINSTALL_FAILED", rootCause: error instanceof Error ? error.message : String(error),
    errorCode: error && typeof error === "object" && "code" in error ? error.code : null }));
  process.exitCode = 1;
});
