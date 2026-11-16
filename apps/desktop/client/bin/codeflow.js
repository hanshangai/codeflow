#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR_FOR_SQLITE = 16;
const SQLITE_WARNING_FLAG = "--disable-warning=ExperimentalWarning";
const SQLITE_BOOTSTRAP_ENV = "CODEFLOWAI_SQLITE_BOOTSTRAPPED";

/** 确保当前 Node 版本达到 node:sqlite/FTS5 的最低补丁线。 */
function assertNodeSqliteSupported() {
  const [majorRaw, minorRaw] = process.versions.node.split(".");
  const major = Number(majorRaw);
  const minor = Number(minorRaw);
  const supported = (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR_FOR_SQLITE) || major === 24;
  if (supported) return;
  console.error(`[CLIENT_NODE_VERSION_UNSUPPORTED] 当前 Node.js ${process.version} 不满足要求，请使用 Node.js >=22.16.0 且 <23（推荐 22.17.1），或 Node.js 24.x。`);
  process.exit(1);
}

/** 实际探测 FTS5，拒绝版本号满足但 SQLite 构建缺少 FTS5 的自定义 Node。 */
function assertNodeSqliteFts5Supported() {
  let probeDb = null;
  let failure = null;
  try {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    probeDb = new DatabaseSync(":memory:");
    probeDb.exec("CREATE VIRTUAL TABLE codeflowai_fts5_probe USING fts5(content)");
  } catch (error) {
    failure = error;
  }
  try {
    probeDb?.close();
  } catch (error) {
    failure ??= error;
  }
  if (!failure) return;
  const detail = failure instanceof Error ? failure.message : String(failure);
  console.error(`[CLIENT_SQLITE_FTS5_UNSUPPORTED] 当前 Node.js ${process.version} 的 node:sqlite 不可用或缺少 SQLite FTS5：${detail}。请使用 Node.js >=22.16.0 且 <23（推荐 22.17.1），或 Node.js 24.x。`);
  process.exit(1);
}

/** node:sqlite 仍可能打印 ExperimentalWarning，重启一次只屏蔽该类告警。 */
function relaunchWithSqliteWarningDisabled() {
  if (process.env[SQLITE_BOOTSTRAP_ENV] === "1") return;
  if (!process.allowedNodeEnvironmentFlags.has(SQLITE_WARNING_FLAG)) return;

  const binPath = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [SQLITE_WARNING_FLAG, binPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [SQLITE_BOOTSTRAP_ENV]: "1" },
  });
  if (typeof result.status === "number") process.exit(result.status);
  if (result.error) throw result.error;
  process.exit(1);
}

assertNodeSqliteSupported();
relaunchWithSqliteWarningDisabled();
assertNodeSqliteFts5Supported();
createRequire(import.meta.url)("../dist/index.cjs");
