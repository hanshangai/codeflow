import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const requireDesktop = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const { load } = createRequire(createRequire(requireDesktop.resolve("electron-builder")).resolve("app-builder-lib"))("js-yaml");
const buildDependencies = new Set(["electron", "electron-builder", "typescript", "esbuild"]);
const shellScripts = new Set(["package-local-win.mjs", "package-local-mac.mjs", "package-local-builder.mjs", "windows-install-layout.mjs", "build-shell-installer.mjs"]);

/** 稳定对象键序，避免 JSON/YAML 排版变化制造版本。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** 壳号只接受两到三段安全整数，末段递增且不重排段数。 */
export function assertShellVersion(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))?$/u.test(value)
    || value.split(".").some(part => !Number.isSafeInteger(Number(part)))) throw new Error("DESKTOP_SHELL_VERSION_INVALID");
  return value;
}

/** 数字比较允许旧两段和 builder 补零三段使用同一排序。 */
function compare(left, right) {
  const a = assertShellVersion(left).split(".").map(Number), b = assertShellVersion(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  return 0;
}

/** 只遍历运行时 import/export/require；类型引用不会改变实际壳输入。 */
function runtimeImports(source, file) {
  const imports = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly || ts.isExportDeclaration(node) && !node.isTypeOnly)
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText() === "require")
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return imports;
}

/** 锁定壳的依赖闭包；Client/Web importer 和无关包变动不参与壳指纹。 */
function dependencyInputs(lock, shared) {
  const importers = {}, packages = {}, snapshots = {};
  const visit = (name, version) => {
    if (typeof version !== "string") throw new Error(`DESKTOP_SHELL_LOCK_DEPENDENCY_INVALID: ${name}`);
    if (version.startsWith("link:")) return;
    const key = `${name}@${version}`;
    if (Object.hasOwn(snapshots, key)) return;
    const snapshot = lock.snapshots?.[key];
    if (!snapshot) throw new Error(`DESKTOP_SHELL_LOCK_DEPENDENCY_MISSING: ${key}`);
    snapshots[key] = snapshot;
    const packageKey = key.replace(/\(.+$/u, "");
    if (lock.packages?.[packageKey]) packages[packageKey] = lock.packages[packageKey];
    for (const [dependency, resolved] of Object.entries({ ...snapshot.dependencies, ...snapshot.optionalDependencies })) visit(dependency, resolved);
  };
  for (const name of ["apps/desktop", "packages/shared"]) {
    const importer = lock.importers?.[name];
    if (!importer) {
      if (name === "packages/shared" && !Object.keys(shared.dependencies ?? {}).length) continue;
      throw new Error(`DESKTOP_SHELL_LOCK_IMPORTER_MISSING: ${name}`);
    }
    const dependencies = { ...importer.dependencies };
    if (name === "apps/desktop") for (const [dependency, value] of Object.entries(importer.devDependencies ?? {})) {
      if (buildDependencies.has(dependency)) dependencies[dependency] = value;
    }
    importers[name] = dependencies;
    for (const [dependency, value] of Object.entries(dependencies)) visit(dependency, value.version);
  }
  return { importers, packages, snapshots, settings: lock.settings, overrides: lock.overrides };
}

/** 从工作区实际壳文件和依赖闭包取摘要，资源、测试和输出目录不进入版本分配。 */
export async function readDesktopShellInputs(root) {
  const readJson = async file => JSON.parse(await fs.readFile(path.join(root, file), "utf8"));
  const desktop = await readJson("apps/desktop/package.json"), shared = await readJson("packages/shared/package.json");
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const selected = new Set(listed.filter(file => /^apps\/desktop\/(?:src|build)\//u.test(file) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file)
    || /^apps\/desktop\/tsconfig[^/]*\.json$/u.test(file) || file === "apps/desktop/electron-builder.yml"
    || file.startsWith("apps/desktop/scripts/") && shellScripts.has(path.posix.basename(file))
    || ["tsconfig.base.json", "packages/shared/tsconfig.json", "tools/release/clean-dist.cjs"].includes(file)));
  const visited = new Set(), sharedExports = {};
  const visit = async file => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await fs.readFile(path.join(root, file), "utf8");
    for (const specifier of runtimeImports(source, file)) {
      let target;
      if (specifier === "@codeflowai/shared" || specifier.startsWith("@codeflowai/shared/")) {
        const entry = shared.exports?.[specifier === "@codeflowai/shared" ? "." : `.${specifier.slice("@codeflowai/shared".length)}`];
        target = typeof entry === "string" ? entry : entry?.types;
        if (!target) throw new Error(`DESKTOP_SHELL_SHARED_EXPORT_MISSING: ${specifier}`);
        sharedExports[specifier] = entry;
        target = path.posix.join("packages/shared", target);
      } else if (specifier.startsWith(".")) {
        const local = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        if (["packages/shared/", "apps/desktop/src/", "apps/desktop/scripts/", "tools/release/"].some(directory => local.startsWith(directory))) target = local;
      }
      if (!target) continue;
      if (target.startsWith("packages/shared/") || target.startsWith("apps/desktop/src/")) target = target.replace(/\.js$/u, ".ts");
      selected.add(target);
      await visit(target);
    }
  };
  for (const file of [...selected]) if (/\.[cm]?[jt]sx?$/u.test(file)) await visit(file);
  const files = [];
  for (const file of [...selected].sort()) {
    const stat = await fs.lstat(path.join(root, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`DESKTOP_SHELL_INPUT_FILE_INVALID: ${file}`);
    const bytes = await fs.readFile(path.join(root, file));
    // Git 在 Windows/macOS 的换行转换不属于壳输入变化；二进制保持原始字节。
    const input = /\.(?:[cm]?[jt]sx?|json|ya?ml|nsh|nsi|ps1|plist|md|html|css)$/u.test(file)
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n") : bytes;
    files.push({ path: file, sha256: crypto.createHash("sha256").update(input).digest("hex") });
  }
  const lock = load(await fs.readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
  const packageInput = { ...desktop, version: undefined, devDependencies: Object.fromEntries(Object.entries(desktop.devDependencies ?? {}).filter(([name]) => buildDependencies.has(name))),
    scripts: { build: desktop.scripts?.build } };
  const shellInputFingerprint = crypto.createHash("sha256").update(JSON.stringify(canonical({ files, desktop: packageInput,
    shared: { type: shared.type, main: shared.main, exports: sharedExports, scripts: shared.scripts, dependencies: shared.dependencies },
    dependencies: dependencyInputs(lock, shared) }))).digest("hex");
  const electronVersion = lock.importers?.["apps/desktop"]?.devDependencies?.electron?.version;
  if (typeof electronVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(electronVersion)) throw new Error("DESKTOP_SHELL_ELECTRON_LOCK_INVALID");
  return { shellInputFingerprint, baselineVersion: assertShellVersion(desktop.version), electronVersion };
}

/** 历史计划是唯一占号事实；同号不同内容失败，旧无指纹基线保守递增。 */
export function allocateDesktopShellVersion({ baselineVersion, shellInputFingerprint, plans }) {
  let latest = { shellVersion: assertShellVersion(baselineVersion) };
  const bindings = new Map();
  for (const plan of plans) {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("DESKTOP_SHELL_HISTORY_INVALID");
    if (plan.shellVersion === undefined && plan.shellInputFingerprint === undefined) continue;
    assertShellVersion(plan.shellVersion);
    if (plan.shellInputFingerprint === undefined) {
      if (compare(plan.shellVersion, latest.shellVersion) > 0) latest = { shellVersion: plan.shellVersion };
      continue;
    }
    if (!/^[a-f0-9]{64}$/u.test(plan.shellInputFingerprint)) throw new Error("DESKTOP_SHELL_HISTORY_INVALID");
    const key = plan.shellVersion.split(".").map(Number); while (key.length < 3) key.push(0);
    const binding = bindings.get(key.join("."));
    if (binding && binding !== plan.shellInputFingerprint) throw new Error("DESKTOP_SHELL_VERSION_CONTENT_CONFLICT");
    bindings.set(key.join("."), plan.shellInputFingerprint);
    if (compare(plan.shellVersion, latest.shellVersion) > 0 || compare(plan.shellVersion, latest.shellVersion) === 0 && !latest.shellInputFingerprint) latest = plan;
  }
  if (latest.shellInputFingerprint === shellInputFingerprint) return latest.shellVersion;
  const parts = latest.shellVersion.split(".").map(Number);
  if (!Number.isSafeInteger(++parts[parts.length - 1])) throw new Error("DESKTOP_SHELL_VERSION_EXHAUSTED");
  return parts.join(".");
}
