import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** 缓存留在用户目录或显式指定位置，避免污染源码检出。 */
export function defaultDesktopBuildCacheDir(env = process.env) {
  return env.CODEFLOWAI_DESKTOP_BUILD_CACHE_DIR ?? path.join(
    process.platform === "win32" ? env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local")
      : process.platform === "darwin" ? path.join(os.homedir(), "Library/Caches") : env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "codeflow-desktop-build");
}

/** 仅选对应构建输入；部署不绑定 Client 业务源码及每轮发布版本。 */
export function selectDesktopBuildInputs(files, kind) {
  if (!["web", "dependencies"].includes(kind)) throw new Error("DESKTOP_BUILD_CACHE_KIND_INVALID");
  return files.filter(file => {
    if (!file.includes("/")) return true;
    if (file.startsWith("tools/release/") || file === "apps/desktop/scripts/desktop-build-cache.mjs") return true;
    if (kind === "web") return ["apps/web/", "packages/shared/", "scripts/"].some(prefix => file.startsWith(prefix));
    return file === "apps/desktop/client/package.json" || file === "apps/desktop/package.json"
      || file.startsWith("apps/desktop/client/scripts/") || file.startsWith("apps/desktop/client/bin/")
      || /^packages\/[^/]+\/package\.json$/u.test(file);
  }).sort();
}

/** 内容键绑定源码和有效环境；Windows 按子进程的排序去重规则处理变量名。 */
export async function hashDesktopBuildInputs({ root, kind, files, context, env = process.env }) {
  const hash = crypto.createHash("sha256");
  const deployOptions = new Set(["node_env", ...["ignore_scripts", "optional", "omit", "include", "production", "arch", "platform", "target", "runtime", "libc", "node_linker"].map(name => `npm_config_${name}`)]);
  const deploymentSettings = new Set(["CODEFLOWAI_RELEASE_EDITION", "CODEFLOWAI_EDITION", "AIDT_EDITION"]);
  const buildEnv = {};
  for (const name of Object.keys(env).sort()) {
    const key = process.platform === "win32" ? name.toUpperCase() : name;
    const relevant = kind === "web"
      ? key.startsWith("VITE_") || key.startsWith("CODEFLOWAI_SEO_") && key !== "CODEFLOWAI_SEO_OUTPUT_DIR" || key === "NODE_ENV" || deploymentSettings.has(key)
      : deployOptions.has(key.toLowerCase());
    if (relevant && !Object.hasOwn(buildEnv, key)) buildEnv[key] = env[name];
  }
  hash.update(JSON.stringify({ schemaVersion: 1, kind, context,
    env: Object.fromEntries(Object.keys(buildEnv).sort().map(name => [name, buildEnv[name]])) }));
  for (const relative of [...files].sort()) {
    const file = path.join(root, relative), stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`DESKTOP_BUILD_CACHE_INPUT_INVALID: ${relative}`);
    let bytes = await fs.readFile(file);
    if (kind === "dependencies" && relative === "package.json") {
      const manifest = JSON.parse(bytes.toString("utf8"));
      bytes = Buffer.from(JSON.stringify({ packageManager: manifest.packageManager, engines: manifest.engines, pnpm: manifest.pnpm }));
    }
    if (kind === "dependencies" && relative === "apps/desktop/package.json") {
      const manifest = JSON.parse(bytes.toString("utf8"));
      bytes = Buffer.from(JSON.stringify({ electron: manifest.devDependencies?.electron ?? manifest.dependencies?.electron }));
    }
    hash.update(JSON.stringify([relative, bytes.byteLength]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

/** Git 只枚举已跟踪路径，键读取工作树字节；读取失败不能伪装成缓存命中。 */
export async function desktopBuildCacheKey({ root, kind, context, env }) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`DESKTOP_BUILD_CACHE_GIT_FAILED: exit=${result.status}`);
  const files = selectDesktopBuildInputs(result.stdout.split("\0").filter(Boolean), kind);
  if (kind === "web") {
    for (const name of await fs.readdir(path.join(root, "apps/web"))) {
      const relative = `apps/web/${name}`;
      if (/^\.env(?:\.|$)/u.test(name) && !files.includes(relative)) files.push(relative);
    }
  }
  if (!files.length) throw new Error("DESKTOP_BUILD_CACHE_INPUTS_EMPTY");
  return hashDesktopBuildInputs({ root, kind, files, context, env });
}

/** 缺失是唯一允许的 miss；权限或文件系统错误必须向上传递。 */
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** 枚举普通文件并保留执行位；禁止链接、设备或越界路径。 */
async function inventory(directory) {
  const files = [];
  /** 不跟随链接，按相对路径递归计算每个文件的内容证明。 */
  const visit = async relative => {
    const target = path.join(directory, relative), stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`DESKTOP_BUILD_CACHE_FILE_TYPE_INVALID: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile() && relative) {
      const bytes = await fs.readFile(target);
      files.push({ path: relative, size: bytes.byteLength, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), mode: stat.mode & 0o777 });
    } else throw new Error(`DESKTOP_BUILD_CACHE_FILE_TYPE_INVALID: ${relative}`);
  };
  await visit("");
  if (!files.length) throw new Error("DESKTOP_BUILD_CACHE_PAYLOAD_EMPTY");
  return files;
}

/** 任何已存在缓存的不完整清单或内容变化均显式报损坏，不自动重建。 */
async function verifyEntry(entry, namespace, key) {
  try {
    const stat = await fs.lstat(entry);
    const manifestFile = path.join(entry, "manifest.json"), manifestStat = await fs.lstat(manifestFile);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error("CACHE_MANIFEST_TYPE_INVALID");
    const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.namespace !== namespace || manifest.key !== key
      || JSON.stringify(await inventory(path.join(entry, "payload"))) !== JSON.stringify(manifest.files)) throw new Error("CACHE_MANIFEST_MISMATCH");
    return manifest;
  } catch (cause) {
    throw new Error(`DESKTOP_BUILD_CACHE_CORRUPT: ${namespace}/${key}: ${cause.message}`, { cause });
  }
}

/** 完整验证后复制本轮文件；写锁冲突立即失败，临时生成完成后原子发布。 */
export async function materializeDesktopBuildCache({ cacheDir, namespace, key, destination, build }) {
  if (!/^[a-z][a-z0-9-]*$/u.test(namespace) || !/^[a-f0-9]{64}$/u.test(key)) throw new Error("DESKTOP_BUILD_CACHE_ID_INVALID");
  const parent = path.join(cacheDir, namespace), entry = path.join(parent, key), lockFile = `${entry}.lock`;
  await fs.mkdir(parent, { recursive: true });
  let hit = await exists(entry);
  if (!hit) {
    let lock;
    try { lock = await fs.open(lockFile, "wx"); }
    catch (cause) {
      if (cause.code === "EEXIST") throw new Error(`DESKTOP_BUILD_CACHE_LOCKED: ${namespace}/${key}`, { cause });
      throw cause;
    }
    let temporary, failure;
    try {
      hit = await exists(entry);
      if (!hit) {
        temporary = await fs.mkdtemp(path.join(parent, `.${key}-`));
        const payload = path.join(temporary, "payload");
        await build(payload);
        const files = await inventory(payload);
        await fs.writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify({ schemaVersion: 1, namespace, key, files })}\n`, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporary, entry);
        temporary = undefined;
      }
    } catch (error) {
      failure = { error };
    }
    // 仅继续清理本次临时文件和锁，随后保留构建与清理的全部失败原因。
    const cleanupFailures = [];
    try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
    catch (error) { cleanupFailures.push(error); }
    try { await lock.close(); await fs.unlink(lockFile); }
    catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) throw new AggregateError([...(failure ? [failure.error] : []), ...cleanupFailures], "DESKTOP_BUILD_CACHE_CLEANUP_FAILED");
    if (failure) throw failure.error;
  }
  const manifest = await verifyEntry(entry, namespace, key);
  if (await exists(destination)) throw new Error(`DESKTOP_BUILD_CACHE_DESTINATION_EXISTS: ${destination}`);
  await fs.cp(path.join(entry, "payload"), destination, { recursive: true, errorOnExist: true, force: false });
  if (JSON.stringify(await inventory(destination)) !== JSON.stringify(manifest.files)) throw new Error("DESKTOP_BUILD_CACHE_COPY_MISMATCH");
  return { hit, key };
}
