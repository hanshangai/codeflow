import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveSharedShellBuilderCache } from "./shell-build-cache.mjs";

const sourcePath = fileURLToPath(new URL("../build/shell-launcher.nsi", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** 解析尚不存在的输出，先识别其最近祖先的真实链接目标。 */
async function resolveNewPath(directory) {
  const tail = [];
  let ancestor = path.resolve(directory);
  for (;;) {
    try { return path.join(await fs.realpath(ancestor), ...tail); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** 两目录相交即拒绝，避免工具准备或编译写入源码和输入。 */
function assertSeparate(left, right) {
  for (const relative of [path.relative(left, right), path.relative(right, left)]) {
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error("DESKTOP_SHELL_BUILD_PATH_OVERLAP");
    }
  }
}

/** 运行受控子进程，失败保留真实退出结果和编译器诊断。 */
async function run(file, args, env, capture = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], windowsHide: true });
    let output = "";
    child.stdout?.on("data", chunk => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`DESKTOP_SHELL_COMPILER_FAILED: exit=${code}, signal=${signal}`));
    });
  });
}

/** 在新独占输出及缓存目录中构建固定启动器，不执行安装或发布。 */
export async function buildShellLauncher(input) {
  if (process.platform !== "win32") throw new Error("DESKTOP_SHELL_BUILD_WINDOWS_REQUIRED");
  const sharedCache = !input.cacheDir;
  const outputDir = await resolveNewPath(input.outputDir), cacheDir = await resolveNewPath(input.cacheDir ?? resolveSharedShellBuilderCache());
  const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
  const builderDirectory = path.dirname(requireBuilder.resolve("app-builder-lib/package.json"));
  for (const protectedDir of [await fs.realpath(repository), await fs.realpath(path.dirname(sourcePath)), await fs.realpath(builderDirectory)]) {
    assertSeparate(outputDir, protectedDir);
    assertSeparate(cacheDir, protectedDir);
  }
  assertSeparate(outputDir, cacheDir);
  await fs.access(sourcePath);
  await fs.mkdir(outputDir);
  if (sharedCache) await fs.mkdir(cacheDir, { recursive: true });
  else await fs.mkdir(cacheDir);
  const env = { ...process.env, ELECTRON_BUILDER_CACHE: cacheDir };
  delete env.ELECTRON_BUILDER_NSIS_DIR;
  delete env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR;
  const resolver = 'const {createRequire}=require("node:module");const r=createRequire(process.argv[1]);r("app-builder-lib/out/toolsets/windows.js").getMakeNsisPath().then(c=>console.log("NSIS_COMPILER "+JSON.stringify(c)),e=>{console.error(e);process.exitCode=1;});';
  const resolved = await run(process.execPath, ["-e", resolver, requireBuilder.resolve("electron-builder")], env, true);
  const lines = resolved.split(/\r?\n/u).filter(line => line.startsWith("NSIS_COMPILER "));
  if (lines.length !== 1) throw new Error("DESKTOP_SHELL_COMPILER_RESPONSE_INVALID");
  const compiler = JSON.parse(lines[0].slice("NSIS_COMPILER ".length));
  const compilerPath = await fs.realpath(compiler.path);
  const relative = path.relative(cacheDir, compilerPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("DESKTOP_SHELL_COMPILER_OUTSIDE_CACHE");
  assertSeparate(outputDir, path.dirname(compilerPath));
  const output = path.join(outputDir, "CodeFlowAI.exe");
  await run(compilerPath, ["/V2", `/DOUTPUT_FILE=${output}`, "/INPUTCHARSET", "UTF8", sourcePath], { ...env, ...compiler.env });
  const executable = path.join(outputDir, "CodeFlowAI.exe");
  if (!(await fs.lstat(executable)).isFile()) throw new Error("DESKTOP_SHELL_LAUNCHER_OUTPUT_INVALID");
  return executable;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const requestId = crypto.randomUUID();
  try {
    const [first, second, third, ...extra] = process.argv.slice(2);
    if (extra.length || !first || third || first.startsWith("--")) {
      throw new Error("用法：build-shell-launcher.mjs <新输出目录> [缓存目录]");
    }
    const executable = await buildShellLauncher({ outputDir: first, cacheDir: second });
    console.log(JSON.stringify({ errorCode: "DESKTOP_SHELL_LAUNCHER_BUILT", requestId, executable, installed: false, published: false }));
  } catch (error) {
    console.error(JSON.stringify({ errorCode: "DESKTOP_SHELL_LAUNCHER_BUILD_FAILED", requestId, rootCause: error.message }));
    process.exitCode = 1;
  }
}
