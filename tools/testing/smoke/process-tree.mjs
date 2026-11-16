import { execFile } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

/** 结束整个进程树；无效 pid 返回 false，强杀后未退出则显式抛出。 */
export async function killProcessTree(pid, timeoutMs = 10_000) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    await new Promise((resolve) => execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch { /* 已退出 */ } }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(100);
  }
  throw new Error(`PROCESS_TREE_KILL_TIMEOUT: ${pid}`);
}
