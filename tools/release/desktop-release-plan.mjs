import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { allocateDesktopShellVersion, assertShellVersion, readDesktopShellInputs } from "./desktop-shell-version.mjs";

const requireRelease = createRequire(import.meta.url);
const releaseVersioning = requireRelease("./release-versioning.cjs");
const PLAN_SCHEMA_VERSION = 1;
export const DESKTOP_PLAN_PLATFORMS = Object.freeze(["win32/x64", "darwin/arm64"]);

/** 读取当前源码事实；计划必须绑定同一提交和同一数据库 schema。 */
export async function readDesktopPlanFacts(root, { allowDirty = false } = {}) {
  const versionSource = await fs.readFile(path.join(root, "apps/desktop/client/src/db/clientDbSchemaVersion.ts"), "utf8");
  const schemaMatch = /CLIENT_DB_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(versionSource);
  if (!schemaMatch) throw new Error("DESKTOP_PLAN_SCHEMA_VERSION_MISSING");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("DESKTOP_PLAN_COMMIT_INVALID");
  /** 两个平台必须从同一干净提交构建；脏工作区会制造同版本不同内容。 */
  if (!allowDirty && execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) {
    throw new Error("DESKTOP_PLAN_WORKTREE_DIRTY");
  }
  return { sourceCommit: commit, dbSchemaVersion: Number(schemaMatch[1]) };
}

/** 计划只允许当前实际支持的平台；arm64-only 阶段不生成 darwin/x64。 */
function normalizePlatforms(platforms) {
  if (!Array.isArray(platforms) || !platforms.length || new Set(platforms).size !== platforms.length
    || platforms.some(item => !DESKTOP_PLAN_PLATFORMS.includes(item))) throw new Error("DESKTOP_PLAN_PLATFORMS_INVALID");
  return DESKTOP_PLAN_PLATFORMS.filter(item => platforms.includes(item));
}

/** 只允许单次分配；已存在的计划文件必须由同一 plan 复用，不能覆盖。 */
async function writeExclusive(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

/** 读取计划目录中的版本，避免同一天重复分配同一序号。 */
async function existingPlanVersions(directory) {
  try { return (await fs.readdir(directory)).filter(name => /^\d{4}\.\d{2}\.\d{2}\.\d+\.json$/u.test(name)).map(name => name.slice(0, -5)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** 生成一次可共享的桌面发布计划；Windows 协调机负责分配，Mac 只消费。 */
export async function createDesktopReleasePlan({ root, platforms, keyId, expiresAt, environment = "test", now = new Date(), planDir = null, allowDirty = false }) {
  if (typeof keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(keyId)) throw new Error("DESKTOP_PLAN_KEY_ID_INVALID");
  if (!["test", "production"].includes(environment)) throw new Error("DESKTOP_PLAN_ENVIRONMENT_INVALID");
  /** 当前 Server 生产发布仍要求 win32/x64 + darwin/x64 + darwin/arm64；先阻止误建 arm64-only 生产计划。 */
  if (environment === "production") throw new Error("DESKTOP_PLAN_PRODUCTION_ARM64_ONLY_UNSUPPORTED");
  const expiry = new Date(expiresAt ?? new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString());
  if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) throw new Error("DESKTOP_PLAN_EXPIRY_INVALID");
  const facts = await readDesktopPlanFacts(root, { allowDirty });
  const directory = planDir ?? path.join(root, "release", "desktop-plans");
  await fs.mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, ".allocation.lock");
  const lock = await fs.open(lockPath, "wx");
  let failure;
  try {
    const inputs = await readDesktopShellInputs(root);
    const versions = await existingPlanVersions(directory);
    const history = await Promise.all(versions.map(async version => JSON.parse(await fs.readFile(path.join(directory, `${version}.json`), "utf8"))));
    const shellVersion = allocateDesktopShellVersion({ ...inputs, plans: history });
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    let version = releaseVersioning.computeNextReleaseVersion(packageJson.version, now);
    const used = new Set(versions);
    for (let attempt = 0; attempt < 1000 && used.has(version); attempt++) version = releaseVersioning.computeNextReleaseVersion(version, now);
    if (used.has(version)) throw new Error("DESKTOP_PLAN_VERSION_EXHAUSTED");
    const plan = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      environment,
      releaseId: `desktop-${version}`,
      version,
      webVersion: version,
      clientVersion: version,
      protocolVersion: 1,
      capabilityVersion: 1,
      dbSchemaVersion: facts.dbSchemaVersion,
      platformSet: normalizePlatforms(platforms),
      sourceCommit: facts.sourceCommit,
      shellVersion,
      shellInputFingerprint: inputs.shellInputFingerprint,
      keyId,
      createdAt: now.toISOString(),
      expiresAt: expiry.toISOString(),
    };
    const file = path.join(directory, `${version}.json`);
    await writeExclusive(file, plan);
    return { file, plan };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await lock.close(); await fs.unlink(lockPath); }
    catch (cleanup) { throw failure ? new AggregateError([failure, cleanup], "DESKTOP_PLAN_LOCK_CLEANUP_FAILED") : cleanup; }
  }
}

/** 读取并校验计划；Mac 构建必须和 Windows 分配时处于同一提交、同一 schema。 */
export async function readDesktopReleasePlan({ root, file, allowDirty = false }) {
  const plan = JSON.parse(await fs.readFile(file, "utf8"));
  const facts = await readDesktopPlanFacts(root, { allowDirty });
  if (!plan || typeof plan !== "object" || plan.schemaVersion !== PLAN_SCHEMA_VERSION
    || !["test", "production"].includes(plan.environment)
    || typeof plan.releaseId !== "string" || !/^desktop-\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(plan.releaseId)
    || typeof plan.version !== "string" || !/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(plan.version)
    || plan.releaseId !== `desktop-${plan.version}`
    || typeof plan.webVersion !== "string" || typeof plan.clientVersion !== "string"
    || plan.protocolVersion !== 1 || plan.capabilityVersion !== 1
    || !Number.isSafeInteger(plan.dbSchemaVersion) || plan.dbSchemaVersion <= 0
    || typeof plan.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(plan.keyId)
    || typeof plan.createdAt !== "string" || typeof plan.expiresAt !== "string"
    || Date.parse(plan.expiresAt) <= Date.now()
    || !Array.isArray(plan.platformSet) || !plan.platformSet.length
    || new Set(plan.platformSet).size !== plan.platformSet.length
    || plan.platformSet.some(item => !DESKTOP_PLAN_PLATFORMS.includes(item))) throw new Error("DESKTOP_PLAN_INVALID");
  if (plan.sourceCommit !== facts.sourceCommit) throw new Error("DESKTOP_PLAN_COMMIT_MISMATCH");
  if (plan.dbSchemaVersion !== facts.dbSchemaVersion) throw new Error("DESKTOP_PLAN_SCHEMA_MISMATCH");
  if (plan.shellVersion === undefined && plan.shellInputFingerprint === undefined) throw new Error("DESKTOP_PLAN_LEGACY_SHELL_BASELINE_ONLY");
  assertShellVersion(plan.shellVersion);
  if (!/^[a-f0-9]{64}$/u.test(plan.shellInputFingerprint)) throw new Error("DESKTOP_PLAN_SHELL_INPUT_INVALID");
  if ((await readDesktopShellInputs(root)).shellInputFingerprint !== plan.shellInputFingerprint) throw new Error("DESKTOP_PLAN_SHELL_INPUT_MISMATCH");
  return plan;
}
