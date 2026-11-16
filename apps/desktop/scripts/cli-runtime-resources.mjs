import fs from "node:fs/promises";
import path from "node:path";

/** 复制锁定的 npm 包；包名或版本不符时在写目标前失败。 */
export async function copyNpmPackage({ npmPackageDir, targetDir, expectedVersion }) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(npmPackageDir, "package.json"), "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_NPM_PACKAGE_INVALID: ${error.message}`), { code: "DESKTOP_NPM_PACKAGE_INVALID", cause: error });
  }
  if (manifest?.name !== "npm" || typeof manifest.version !== "string" || typeof expectedVersion !== "string") {
    throw Object.assign(new Error("DESKTOP_NPM_PACKAGE_INVALID: expected package name npm with a string version"), { code: "DESKTOP_NPM_PACKAGE_INVALID" });
  }
  if (manifest.version !== expectedVersion) {
    throw Object.assign(new Error(`DESKTOP_NPM_VERSION_MISMATCH: expected ${expectedVersion}, found ${manifest.version}`), {
      code: "DESKTOP_NPM_VERSION_MISMATCH",
    });
  }
  // 打包只认 npm-cli.js 入口；仅有 package.json 的残缺包必须在复制前失败。
  try {
    await fs.access(path.join(npmPackageDir, "bin", "npm-cli.js"));
  } catch (error) {
    throw Object.assign(new Error(`DESKTOP_NPM_PACKAGE_INVALID: missing bin/npm-cli.js: ${error.message}`), {
      code: "DESKTOP_NPM_PACKAGE_INVALID", cause: error,
    });
  }
  await fs.cp(npmPackageDir, targetDir, { recursive: true, force: false, errorOnExist: true });
}
