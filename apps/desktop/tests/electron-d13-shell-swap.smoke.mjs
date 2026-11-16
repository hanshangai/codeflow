import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { killProcessTree } from "../../../tools/testing/smoke/process-tree.mjs";

/**
 * D13 换壳编排：先用同一工件跑健康矩阵，再执行候选安装，核对 baseline/active 双壳与启动配置。
 * 前置：D13_SWAP_CANDIDATE_DIR、D13_SWAP_BASELINE_RESOURCES、D13_SWAP_BUNDLE_DIR、
 * D13_SWAP_LAUNCHER、D13_SWAP_OUTPUT_ROOT；缺失时显式 SKIP。
 */
const env = {
  candidateDir: String(process.env.D13_SWAP_CANDIDATE_DIR ?? "").trim(),
  baseline: String(process.env.D13_SWAP_BASELINE_RESOURCES ?? "").trim(),
  bundle: String(process.env.D13_SWAP_BUNDLE_DIR ?? "").trim(),
  launcher: String(process.env.D13_SWAP_LAUNCHER ?? "").trim(),
  outputRoot: String(process.env.D13_SWAP_OUTPUT_ROOT ?? "").trim(),
};
if (Object.values(env).some((value) => !value)) {
  console.log("SKIP D13 shell swap smoke: 缺少 D13_SWAP_* 工件环境变量");
  process.exit(0);
}

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const healthScript = path.join(testsDir, "electron-candidate-shell-health.smoke.mjs");
const installScript = path.join(testsDir, "electron-candidate-shell-install.smoke.mjs");
const candidateExe = path.join(path.resolve(env.candidateDir), "CodeFlowAI.exe");
const outputRoot = path.resolve(env.outputRoot);
const healthOutput = path.join(outputRoot, "health");
const installOutput = path.join(outputRoot, "install");

async function runScript(script, args) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => { killProcessTree(child.pid).catch(() => {}); }, 30 * 60_000);
  const code = await new Promise((resolve) => child.once("exit", (value) => resolve(value ?? 1)));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${path.basename(script)} failed (${code}): ${stderr.slice(-500)}`);
  return stdout;
}

let exists = true;
try { await fs.lstat(outputRoot); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
assert.equal(exists, false, "D13_SWAP_OUTPUT_ROOT 必须是全新目录");
// 子脚本要求父目录已存在（realpath dirname），但输出子目录必须尚不存在。
await fs.mkdir(outputRoot);

await runScript(healthScript, [candidateExe, path.resolve(env.baseline), path.resolve(env.bundle), healthOutput]);
await runScript(installScript, [path.resolve(env.candidateDir), path.resolve(env.baseline), path.resolve(env.bundle),
  path.resolve(env.launcher), installOutput]);

const installation = path.join(installOutput, "healthy-installation");
const activeExe = path.join(installation, "shells/active/CodeFlowAI.exe");
const baselineExe = path.join(installation, "shells/baseline/CodeFlowAI.exe");
const launchIni = path.join(installation, "shell-launch.ini");
const verificationPath = path.join(installOutput, "verification.json");
for (const file of [activeExe, baselineExe, launchIni, verificationPath]) {
  assert.equal((await fs.lstat(file)).isFile(), true, `缺少 ${file}`);
}
const verification = JSON.parse(await fs.readFile(verificationPath, "utf8"));
assert.equal(verification.status, "passed", `candidate install status: ${verification.status}`);
const installedScenario = (verification.scenarios ?? []).find((entry) => entry.name === "healthy-installed-candidate");
assert.equal(installedScenario?.status, "passed", "healthy-installed-candidate 未通过");
// shell-launch.ini 由安装 smoke 夹具预写；这里只核对布局，不把它当作换壳/回滚证明。
const ini = await fs.readFile(launchIni, "utf8");
const summary = {
  at: new Date().toISOString(), candidateExe, healthOutput, installOutput, verification: verification.status,
  shells: { active: activeExe, baseline: baselineExe }, launchIni: ini.trim(),
};
if (process.env.D13_SWAP_REPORT_FILE) {
  await fs.mkdir(path.dirname(path.resolve(process.env.D13_SWAP_REPORT_FILE)), { recursive: true });
  await fs.writeFile(path.resolve(process.env.D13_SWAP_REPORT_FILE), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}
console.log("D13 shell health + install orchestration passed (no real swap/rollback assertion)");
process.exit(0);
