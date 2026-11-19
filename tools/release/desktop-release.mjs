import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDesktopReleasePlan, readDesktopReleasePlan } from "./desktop-release-plan.mjs";
import { buildDesktopResources, currentDesktopPlatform } from "./desktop-resources.mjs";
import { prepareResourcePublication, verifyResourcePublication } from "./desktop-publish.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const valueOptions = new Set(["--platforms", "--platform", "--key-id", "--expires-at", "--plan", "--private-key", "--trust",
  "--mode", "--output", "--publication-output", "--update-origin", "--artifacts", "--shared-dir", "--npm-package", "--client-archive"]);
const flagOptions = new Set(["--test", "--prod", "--publish", "--allow-dirty"]);

/** 解析简单 CLI；未知项直接失败，避免静默忽略发布参数。 */
function parse(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (valueOptions.has(arg)) {
      const value = rest[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`参数缺少值：${arg}`);
      options[arg.slice(2)] = value;
    } else if (flagOptions.has(arg)) options[arg.slice(2)] = true;
    else {
      const name = /^--[a-z][a-z0-9-]{0,63}(?:=|$)/iu.exec(arg)?.[0].replace(/=$/u, "") ?? "<value>";
      throw new Error(`未知参数：${name}`);
    }
  }
  return options;
}

function platformKey(value) {
  if (value === "win") return "win32/x64";
  if (value === "mac-arm64" || value === "mac") return "darwin/arm64";
  throw new Error(`不支持的平台：${value}`);
}

function resolveTarget(options) {
  if (options.test && options.prod) throw new Error("--test 与 --prod 不能同时使用");
  return options.prod ? "production" : "test";
}

async function planNew(options) {
  const environment = resolveTarget(options);
  const platforms = String(options.platforms ?? "win,mac-arm64").split(",").filter(Boolean).map(platformKey);
  if (!options["key-id"]) throw new Error("plan:new 需要 --key-id");
  // --allow-dirty 跳过干净工作区校验；计划仍绑定当前 HEAD，产物会携带未提交内容。
  const { file, plan } = await createDesktopReleasePlan({ root, platforms, keyId: options["key-id"], expiresAt: options["expires-at"], environment,
    allowDirty: Boolean(options["allow-dirty"]) });
  console.log(JSON.stringify({ code: "DESKTOP_PLAN_READY", file, plan }));
}

async function readPlan(options) {
  if (!options.plan) throw new Error("需要 --plan");
  return { file: path.resolve(options.plan), plan: await readDesktopReleasePlan({ root, file: path.resolve(options.plan), allowDirty: Boolean(options["allow-dirty"]) }) };
}

/** 资源与完整包共用计划；完整包显式传递精确壳号的唯一来源。 */
async function build(options) {
  const { plan, file } = await readPlan(options);
  if (!options["private-key"] || !options.trust) throw new Error("build 需要 --private-key 与 --trust");
  const target = currentDesktopPlatform();
  if (options.platform && platformKey(options.platform) !== target.key) throw new Error(`构建机平台不匹配：${options.platform}`);
  const outputDir = path.resolve(options.output ?? path.join(root, "release", "desktop", plan.version, target.key.replace("/", "-")));
  const mode = options.mode ?? "resources";
  if (!["resources", "installer", "dmg"].includes(mode)) throw new Error(`不支持的 mode：${mode}`);
  if (mode === "installer" && target.platform !== "win32") throw new Error("installer 只能由 Windows 构建");
  if (mode === "dmg" && target.platform !== "darwin") throw new Error("dmg 只能由 macOS 构建");
  if (mode !== "resources" && !options["update-origin"]) throw new Error("installer/dmg 模式需要 --update-origin");
  const result = await buildDesktopResources({ root, plan, outputDir, privateKeyFile: path.resolve(options["private-key"]),
    trustedReleaseKeysFile: path.resolve(options.trust), updateServerOrigin: options["update-origin"],
    npmPackageDir: options["npm-package"], clientArchive: options["client-archive"] });
  if (mode === "installer") {
    const installerDir = path.join(outputDir, "installer");
    runNode(path.join(root, "apps/desktop/scripts/package-local-win.mjs"),
      [result.resourcesDir, installerDir, "--require-baseline-proof", "--target", "nsis", "--plan", file, ...(options["allow-dirty"] ? ["--allow-dirty"] : [])]);
  } else if (mode === "dmg") {
    const dmgDir = path.join(outputDir, "dmg");
    runNode(path.join(root, "apps/desktop/scripts/package-local-mac.mjs"),
      [result.resourcesDir, dmgDir, "--require-baseline-proof", "--target", "dmg", "--plan", file, ...(options["allow-dirty"] ? ["--allow-dirty"] : [])]);
  }
  if (options["shared-dir"]) {
    const sharedDir = path.resolve(options["shared-dir"]);
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.cp(outputDir, path.join(sharedDir, target.key.replace("/", "-")), { recursive: true, errorOnExist: true, force: false });
  }
  console.log(JSON.stringify({ code: "DESKTOP_BUILD_READY", mode, outputDir, plan: plan.version, target: target.key }));
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DESKTOP_COMMAND_FAILED: ${path.basename(script)} exit=${result.status}`);
}

async function release(options) {
  await build(options);
  if (options.publish) {
    const publishOptions = { ...options, output: undefined };
    if (options["shared-dir"] && !options.artifacts) publishOptions.artifacts = options["shared-dir"];
    await publish(publishOptions);
  }
}

/** 仅在本地汇总并复验发布材料；上传和登记由私有发布入口负责。 */
async function publish(options) {
  const { plan } = await readPlan(options);
  if (!options.trust) throw new Error("publish 需要 --trust");
  const artifactsRoot = path.resolve(options.artifacts ?? path.join(root, "release", "desktop", plan.version));
  const outputDir = path.resolve(options["publication-output"] ?? options.output ?? path.join(root, "release", "desktop-publication", plan.version));
  let result;
  try {
    await fs.access(outputDir);
    result = await verifyResourcePublication({ outputDir, trustFile: path.resolve(options.trust), plan });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    result = await prepareResourcePublication({ plan, artifactsRoot, outputDir, trustFile: path.resolve(options.trust) });
  }
  console.log(JSON.stringify({ code: "DESKTOP_PUBLICATION_READY", outputDir, plan: plan.version, releaseId: result.publishInput.releaseId }));
}

const requestId = randomUUID();
let operation = "parse";
try {
  const options = parse(process.argv.slice(2));
  operation = ["plan:new", "build", "publish", "release"].includes(options.command) ? options.command : "unknown";
  if (options.command === "plan:new") await planNew(options);
  else if (options.command === "build") await build(options);
  else if (options.command === "publish") await publish(options);
  else if (options.command === "release") await release(options);
  else throw new Error("用法：desktop-release.mjs plan:new|build|publish|release ...");
} catch (error) {
  console.error(JSON.stringify({ code: "DESKTOP_RELEASE_FAILED", requestId, operation,
    rootCause: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }));
  process.exitCode = 1;
}
