import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import test from "node:test";
import { assertDesktopStartupCapability } from "@codeflowai/shared";

const sourceRoot = path.resolve(import.meta.dirname, "../../../..");
const entries = ["index.cjs", "clientDaemonSupervisor.cjs", "workspacePathIndexWorker.cjs", "documentAttachmentWorker.cjs",
  "clientDbReaderWorker.cjs", "workspaceMigrationFileWorker.cjs", "orchAssetBundleValidation.cjs"];
type InputFile = { path: string; sha256: string };
type BuildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/** 摘要只读取明确输入，用于证明快照来源和构建后原仓库未变。 */
async function digest(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

/** 逐个复制真实普通文件，不遍历依赖、旧 dist 或源码内部链接。 */
async function copyInput(relative: string, root: string, inputs: InputFile[]): Promise<void> {
  const source = path.join(sourceRoot, relative), stat = await fs.lstat(source);
  assert.equal(stat.isSymbolicLink(), false, relative);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(source)).sort()) await copyInput(`${relative}/${name}`, root, inputs);
    return;
  }
  assert.ok(stat.isFile(), relative);
  const bytes = await fs.readFile(source), target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: "wx" });
  inputs.push({ path: relative, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
}

/** 依赖只作只读链接；当前 shared 入口固定指向独占快照，绝不替换原依赖目录。 */
async function linkDependencies(root: string): Promise<void> {
  await fs.symlink(await fs.realpath(path.join(sourceRoot, "node_modules")), path.join(root, "node_modules"), "junction");
  await fs.symlink(await fs.realpath(path.join(sourceRoot, "packages/shared/node_modules")), path.join(root, "packages/shared/node_modules"), "junction");
  const original = path.join(sourceRoot, "apps/desktop/client/node_modules"), target = path.join(root, "apps/desktop/client/node_modules");
  await fs.mkdir(target);
  for (const name of await fs.readdir(original)) {
    if (name === "@codeflowai") {
      await fs.mkdir(path.join(target, name));
      for (const scoped of await fs.readdir(path.join(original, name))) {
        const selected = scoped === "shared" ? path.join(root, "packages/shared") : await fs.realpath(path.join(original, name, scoped));
        await fs.symlink(selected, path.join(target, name, scoped), "junction");
      }
    } else {
      const selected = await fs.realpath(path.join(original, name));
      assert.ok((await fs.stat(selected)).isDirectory(), selected);
      await fs.symlink(selected, path.join(target, name), "junction");
    }
  }
}

/** 所有构建进程等待真实 close，保存原始日志与身份，超时显式失败。 */
async function runBuild(root: string, label: string, cwd: string, args: string[]): Promise<BuildResult> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && !key.startsWith("CODEFLOWAI_")
    && !/(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY)/iu.test(key)));
  const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  child.stdout.on("data", bytes => stdout.push(bytes)); child.stderr.on("data", bytes => stderr.push(bytes));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
  let result: BuildResult;
  try {
    result = await new Promise<BuildResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    });
  } finally { clearTimeout(timer); }
  await fs.writeFile(path.join(root, `${label}.stdout.log`), result.stdout, "utf8");
  await fs.writeFile(path.join(root, `${label}.stderr.log`), result.stderr, "utf8");
  await fs.writeFile(path.join(root, `${label}.json`), `${JSON.stringify({ command: [process.execPath, ...args], cwd, pid: child.pid,
    code: result.code, signal: result.signal, timedOut, closed: true, owned: 0 }, null, 2)}\n`, "utf8");
  assert.equal(timedOut, false, `build timed out: ${root}`);
  return result;
}

/** 原构建脚本与完整 Client/shared 源码在独占目录执行，现 TypeScript 只输出快照 dist。 */
async function fixture(): Promise<{ root: string; inputs: InputFile[]; dist: string; build(): Promise<BuildResult> }> {
  const evidence = process.env.CF_STARTUP_CAPABILITY_EVIDENCE_ROOT ?? path.join(os.tmpdir(), "cf-startup-capability");
  await fs.mkdir(evidence, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidence, "real-build-")), inputs: InputFile[] = [];
  for (const relative of ["package.json", "tsconfig.base.json", "apps/desktop/client/package.json", "apps/desktop/client/tsconfig.json",
    "apps/desktop/client/scripts/build-bundle.mjs", "apps/desktop/client/src", "packages/shared/package.json", "packages/shared/tsconfig.json", "packages/shared/src"]) {
    await copyInput(relative, root, inputs);
  }
  for (const entry of await fs.readdir(path.join(sourceRoot, "apps/desktop/client/assets/orchestration-builtin"), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) await copyInput(`apps/desktop/client/assets/orchestration-builtin/${entry.name}`, root, inputs);
  }
  await fs.writeFile(path.join(root, "inputs.json"), `${JSON.stringify(inputs, null, 2)}\n`, "utf8");
  await linkDependencies(root);
  const tsc = createRequire(path.join(sourceRoot, "package.json")).resolve("typescript/bin/tsc");
  const compiled = await runBuild(root, "shared", path.join(root, "packages/shared"), [tsc, "-p", "tsconfig.json"]);
  assert.equal(compiled.code, 0, compiled.stderr + compiled.stdout);
  assert.equal(compiled.signal, null);
  const client = path.join(root, "apps/desktop/client");
  return { root, inputs, dist: path.join(client, "dist"), build: () => runBuild(root, "client", client, [path.join(client, "scripts/build-bundle.mjs")]) };
}

/** 原源码在快照编译前后逐项相等，失败现场与全部构建输出保留供独审。 */
async function assertInputsUnchanged(inputs: InputFile[]): Promise<void> {
  for (const input of inputs) assert.equal(await digest(path.join(sourceRoot, input.path)), input.sha256, input.path);
}

test("the real current Client build declares held startup only after all original entries succeed", { timeout: 180_000 }, async () => {
  const f = await fixture(), built = await f.build();
  assert.equal(built.code, 0, built.stderr + built.stdout); assert.equal(built.signal, null);
  for (const entry of entries) assert.ok((await fs.stat(path.join(f.dist, entry))).isFile(), entry);
  const marker = assertDesktopStartupCapability(JSON.parse(await fs.readFile(path.join(f.dist, "desktop-startup-capability.json"), "utf8")));
  assert.equal(marker.clientEntrySha256, await digest(path.join(f.dist, "index.cjs")));
  for (const input of f.inputs.filter(input => input.path.startsWith("apps/desktop/client/assets/orchestration-builtin/"))) {
    assert.equal(await digest(path.join(f.dist, "orchestration-builtin", path.basename(input.path))), input.sha256);
  }
  await assertInputsUnchanged(f.inputs);
});

test("a final worker build failure publishes no startup capability for the earlier successful Client entry", { timeout: 180_000 }, async () => {
  const f = await fixture();
  await fs.mkdir(f.dist);
  await fs.writeFile(path.join(f.dist, "desktop-startup-capability.json"), '{"schemaVersion":1,"heldStartupProtocol":1,"clientEntrySha256":"' + "a".repeat(64) + '"}\n', "utf8");
  await fs.writeFile(path.join(f.root, "apps/desktop/client/src/workspace-migration/workspaceMigrationFileWorker.ts"), "export const invalid = ;\n", "utf8");
  const built = await f.build();
  assert.notEqual(built.code, 0); assert.equal(built.signal, null);
  assert.match(built.stderr, /workspaceMigrationFileWorker\.ts/u);
  assert.ok((await fs.stat(path.join(f.dist, "index.cjs"))).isFile());
  await assert.rejects(fs.access(path.join(f.dist, "desktop-startup-capability.json")), { code: "ENOENT" });
  await assertInputsUnchanged(f.inputs);
});
