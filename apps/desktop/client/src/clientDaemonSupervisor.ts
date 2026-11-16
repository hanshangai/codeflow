import { runClientDaemonSupervisor } from "./clientDaemon.js";

/** 启动轻量 supervisor，并把失败明确映射为非零退出码。 */
async function main(): Promise<void> {
  process.exitCode = await runClientDaemonSupervisor();
}

void main().catch((error) => {
  console.error("[codeflowai] supervisor startup failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
