import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertShellReleasePayload, SHELL_RELEASE_PROTOCOL } from "@codeflowai/shared";
import { resolveSharedShellBuilderCache } from "./shell-build-cache.mjs";

const source = fileURLToPath(new URL("../build/shell-installer.nsi", import.meta.url));
const repository = fileURLToPath(new URL("../../..", import.meta.url));

/** 新路径以最近现存祖先的真实位置参与隔离检查，不创建父目录。 */
async function resolveNew(directory) {
  const tail = [];
  let current = path.resolve(directory);
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.unshift(path.basename(current)); current = parent;
    }
  }
}

/** 输入、输出和工具缓存不得相互包含。 */
function separate(left, right) {
  for (const relative of [path.relative(left, right), path.relative(right, left)]) {
    if (!relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
      throw new Error("DESKTOP_SHELL_INSTALL_BUILD_PATH_OVERLAP");
    }
  }
}

/** 同句柄分块读取物理普通文件，保留读取和关闭双故障。 */
async function hashFile(file) {
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("DESKTOP_SHELL_INSTALL_BUILD_FILE_INVALID");
  }
  const handle = await fs.open(file, "r");
  let failed = false, failure;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!same(before, opened)) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_INPUT_CHANGED");
    const hash = crypto.createHash("sha256"), buffer = Buffer.allocUnsafe(65536);
    let position = 0;
    while (position < Number(opened.size)) {
      const wanted = Math.min(buffer.length, Number(opened.size) - position);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > wanted) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_INPUT_CHANGED");
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (!same(opened, await handle.stat({ bigint: true })) || !same(opened, await fs.lstat(file, { bigint: true }))) {
      throw new Error("DESKTOP_SHELL_INSTALL_BUILD_INPUT_CHANGED");
    }
    return { size: Number(opened.size), sha256: hash.digest("hex") };
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await handle.close(); }
    catch (error) { throw failed ? new AggregateError([failure, error], "DESKTOP_SHELL_INSTALL_BUILD_CLOSE_FAILED") : error; }
  }
}

/** 比较可观察文件身份与内容相关元数据。 */
function same(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** 完整递归库存不跟随内部链接，路径及必需入口沿唯一 ShellRelease 合同。 */
async function inventory(root, shellId) {
  const files = [];
  const visit = async (directory, relative) => {
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_DIRECTORY_INVALID");
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      const filePath = relative ? `${relative}/${name}` : name, target = path.join(directory, name);
      const stat = await fs.lstat(target);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(target, filePath);
      else files.push({ path: filePath, ...await hashFile(target) });
    }
    if (!same(before, await fs.lstat(directory, { bigint: true })) || JSON.stringify(names) !== JSON.stringify((await fs.readdir(directory)).sort())) {
      throw new Error("DESKTOP_SHELL_INSTALL_BUILD_INPUT_CHANGED");
    }
  };
  await visit(root, "");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const payload = assertShellReleasePayload({ schemaVersion: 1, protocol: SHELL_RELEASE_PROTOCOL, shellId, version: "0.0.0-dev",
    platform: "win32", arch: "x64", installerSha256: "0".repeat(64), installerSize: 1, files,
    createdAt: "2026-10-27T00:00:00.000Z", expiresAt: "2026-10-28T00:00:00.000Z", keyId: "local-build" });
  return payload.files;
}

/** 编译期与运行期的字面路径均禁止注入 NSIS 变量、引号和换行。 */
function literal(value, runtime = true) {
  if (/["\r\n\0]/u.test(value)) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_PATH_INVALID");
  return value.replaceAll("$", () => runtime ? "${INSTALL_DOLLAR}${INSTALL_DOLLAR}" : "${INSTALL_DOLLAR}");
}

/** 文件均先落本进程插件临时目录，再以原生独占复制保留真实 Win32 原因。 */
function payloadScript(root, files) {
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join("/"));
  }
  const lines = [];
  for (const directory of [...directories].sort()) {
    lines.push(`StrCpy $checkedPath "$target\\${literal(directory.replaceAll("/", "\\"))}"`, "Call CreatePayloadDirectory", 'StrCmp $failure "" 0 failed');
  }
  for (const file of files) {
    lines.push("ClearErrors", `File /oname=payload.tmp "${literal(path.join(root, file.path), false)}"`, "IfErrors payload_temp_failed",
      `StrCpy $checkedPath "$target\\${literal(file.path.replaceAll("/", "\\"))}"`, "Call CopyPayloadFile", 'StrCmp $failure "" 0 failed');
  }
  return lines.join("\n") + "\n";
}

/** 子进程必须真实 close 成功，stdout 仅用于受控工具路径解析。 */
async function run(executable, args, env, capture = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", diagnostic = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { diagnostic += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(capture ? output : undefined);
      else reject(new Error(`DESKTOP_SHELL_INSTALL_COMPILER_FAILED: exit=${code}, signal=${signal}\n${output}\n${diagnostic}`));
    });
  });
}

/** 只构建嵌入完整壳的候选安装器；不执行安装、签名或发布。 */
export async function buildShellInstaller(input) {
  if (process.platform !== "win32") throw new Error("DESKTOP_SHELL_INSTALL_BUILD_WINDOWS_REQUIRED");
  const candidate = await fs.realpath(path.resolve(input.candidateDirectory));
  const sharedCache = !input.cacheDir;
  const output = await resolveNew(input.outputDir), cache = await resolveNew(input.cacheDir ?? resolveSharedShellBuilderCache());
  const requireBuilder = createRequire(import.meta.resolve("electron-builder"));
  const builderRoot = await fs.realpath(path.dirname(requireBuilder.resolve("app-builder-lib/package.json")));
  separate(candidate, await fs.realpath(repository));
  for (const protectedRoot of [candidate, await fs.realpath(repository), builderRoot]) {
    separate(output, protectedRoot); separate(cache, protectedRoot);
  }
  separate(output, cache);
  const files = await inventory(candidate, input.shellId);
  if (files.some(file => file.path.length > 4096) || candidate.length + Math.max(...files.map(file => file.path.length)) + 1 >= 8192) {
    throw new Error("DESKTOP_SHELL_INSTALL_BUILD_PATH_INVALID");
  }
  const sourceBytes = await fs.readFile(source);
  await fs.mkdir(output);
  if (sharedCache) await fs.mkdir(cache, { recursive: true });
  else await fs.mkdir(cache);
  const temporary = path.join(output, "process-temp");
  await fs.mkdir(temporary);
  const env = { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary, ELECTRON_BUILDER_CACHE: cache };
  delete env.ELECTRON_BUILDER_NSIS_DIR; delete env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR;
  const resolver = 'const{createRequire}=require("node:module");const r=createRequire(process.argv[1]);r("app-builder-lib/out/toolsets/windows.js").getMakeNsisPath().then(c=>console.log("NSIS_COMPILER "+JSON.stringify(c)),e=>{console.error(e);process.exitCode=1;});';
  const resolved = await run(process.execPath, ["-e", resolver, requireBuilder.resolve("electron-builder")], env, true);
  const lines = resolved.split(/\r?\n/u).filter(line => line.startsWith("NSIS_COMPILER "));
  if (lines.length !== 1) throw new Error("DESKTOP_SHELL_INSTALL_COMPILER_RESPONSE_INVALID");
  const compiler = JSON.parse(lines[0].slice("NSIS_COMPILER ".length));
  const compilerPath = await fs.realpath(compiler.path), relative = path.relative(cache, compilerPath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("DESKTOP_SHELL_INSTALL_COMPILER_OUTSIDE_CACHE");
  const payloadFile = path.join(output, "payload.nsh"), executablePath = path.join(output, "CodeFlowAI-shell-installer.exe");
  await fs.writeFile(payloadFile, payloadScript(candidate, files), { encoding: "utf8", flag: "wx" });
  await run(compilerPath, ["/V2", `/DOUTPUT_FILE=${literal(executablePath, false)}`, `/DPAYLOAD_FILE=${literal(payloadFile, false)}`, `/DSHELL_ID=${input.shellId}`,
    `/DMAX_PAYLOAD_PATH=${Math.max(...files.map(file => file.path.length))}`, "/INPUTCHARSET", "UTF8", source], { ...env, ...compiler.env });
  if (!(await fs.lstat(executablePath)).isFile() || !(await fs.readFile(source)).equals(sourceBytes)
    || JSON.stringify(await inventory(candidate, input.shellId)) !== JSON.stringify(files)) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_INPUT_CHANGED");
  return { executablePath, shellId: input.shellId, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const requestId = crypto.randomUUID();
  try {
    const [candidateDirectory, shellId, outputDir, cacheDir, ...extra] = process.argv.slice(2);
    if (!candidateDirectory || !shellId || !outputDir || extra.length) throw new Error("DESKTOP_SHELL_INSTALL_BUILD_ARGUMENTS_INVALID");
    const result = await buildShellInstaller({ candidateDirectory, shellId, outputDir, cacheDir });
    console.log(JSON.stringify({ errorCode: "DESKTOP_SHELL_INSTALLER_BUILT", requestId, ...result, installed: false, published: false }));
  } catch (error) {
    console.error(JSON.stringify({ errorCode: "DESKTOP_SHELL_INSTALL_BUILD_FAILED", requestId, rootCause: error.message }));
    process.exitCode = 1;
  }
}
