import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertTrustedReleaseKeys, verifyReleaseBundlePayload, verifyReleaseBundleSignature } from "@codeflowai/shared/desktop-release-signing";

const prefix = "D07_REAL_ASSETS";
const model = "deepseek-v4-pro", effort = "high";

/** SHA 只用于本次工件、依赖与正式产物的稳定比对。 */
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

/** 仅把不存在作为已知状态，其他文件系统错误显式失败。 */
async function exists(filename) {
  try { await fs.lstat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** UTF-8 读取拒绝替换字符，配置文件从不经 shell 求值。 */
async function readText(filename) { return new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(filename)); }

/** 只解析当前已验证 DeepSeek 配置，拒绝本机受控 endpoint。 */
export function parseProviderEnv(text, env = {}) {
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/u.exec(line.trim());
    assert.ok(match, `${prefix}_PROVIDER_ENV_INVALID`);
    assert.ok(!Object.hasOwn(values, match[1]), `${prefix}_PROVIDER_ENV_DUPLICATE`);
    const value = match[2];
    values[match[1]] = /^(?:".*"|'.*')$/u.test(value) ? value.slice(1, -1) : value;
  }
  const apiKey = String(env.D06_PROVIDER_API_KEY ?? values.DEEPSEEK_API_KEY ?? "").trim();
  const baseUrl = String(env.D06_PROVIDER_BASE_URL ?? values.DEEPSEEK_BASE_URL ?? "").trim();
  assert.ok(apiKey && baseUrl, `${prefix}_PROVIDER_CREDENTIALS_REQUIRED`);
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error(`${prefix}_REMOTE_PROVIDER_REQUIRED`); }
  assert.ok(url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.username && !url.password && !url.search && !url.hash, `${prefix}_REMOTE_PROVIDER_REQUIRED`);
  for (const [key, value] of [["ID", "deepseek"], ["ENGINE", "claude"], ["MODEL", model], ["EFFORT", effort]]) {
    assert.ok(!env[`D06_PROVIDER_${key}`] || env[`D06_PROVIDER_${key}`] === value, `${prefix}_PROVIDER_SELECTION_MISMATCH`);
  }
  return { apiKey, baseUrl, providerId: "deepseek", engine: "claude", model, effort };
}

/** 已知凭据和可识别凭据文本统一脱敏，不截断原始验收事实。 */
function redactText(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/https?:\/\/[^\s"']+/giu, "[URL]").replace(/Bearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/giu, "credential=[REDACTED]");
}

/** 完整持久JSON先解析再逐值脱敏；原生流片段保留文本，坏文档显式失败。 */
export function safeEvidenceJson(value, secrets = []) {
  /** 仅原快照五字段与产物正文是完整JSON，不按后缀推断原生流内容。 */
  function redactField(key, item) {
    if (/^(?:api[_-]?key|authorization|password|token|secret|credentials)$/iu.test(key)) return "[REDACTED]";
    if (typeof item !== "string") return item;
    if (/^(?:prompt_envelope_json|runtime_policy_json|tool_registry_json|knowledge_catalogs_json|artifact_input_json|contentJson)$/u.test(key)) return JSON.stringify(JSON.parse(item), redactField);
    return redactText(item, secrets);
  }
  return JSON.stringify(value, redactField, 2);
}

/** 所有错误输出先脱敏；cause 与清理聚合错误仍保留。 */
export function safeFailure(error, secrets = [], depth = 0) {
  const redact = value => redactText(value, secrets).slice(0, 4000);
  if (error === undefined) return { type: "undefined" };
  if (error === null) return { type: "null", value: null };
  if (typeof error !== "object" && typeof error !== "function") return { type: typeof error, value: typeof error === "string" ? redact(error) : typeof error === "boolean" || typeof error === "number" && Number.isFinite(error) ? error : String(error) };
  const cause = Object.getOwnPropertyDescriptor(error, "cause");
  return { name: redact(error?.name ?? "Error"), message: redact(error?.message ?? error), ...(error?.code ? { code: redact(error.code) } : {}),
    ...(cause && depth < 5 ? { cause: "value" in cause ? safeFailure(cause.value, secrets, depth + 1) : { type: "accessor" } } : {}),
    ...(error instanceof AggregateError && depth < 5 ? { errors: [...error.errors].map(item => safeFailure(item, secrets, depth + 1)) } : {}) };
}

/** CLI 仅发现 shim；真实执行入口由生产 resolver 解析。 */
async function resolveCli(explicit, env) {
  if (explicit) {
    assert.ok(/^claude(?:\.cmd|\.exe)?$/iu.test(path.basename(explicit)) && !/controlled|fixture|mock|smoke/iu.test(explicit), `${prefix}_REAL_CLI_REQUIRED`);
    return fs.realpath(explicit);
  }
  for (const directory of String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["claude.cmd", "claude.exe"]) {
      const candidate = path.join(directory, name);
      if (await exists(candidate)) return resolveCli(candidate, env);
    }
  }
  throw new Error(`${prefix}_REAL_CLI_REQUIRED`);
}

/** 只读调用原 resolver，隔离 npm 搜索范围并保留任务临时目录，不执行 Claude。 */
export async function resolveProviderCli(shim, nodeCommand) {
  const actualShim = await fs.realpath(shim), directory = path.dirname(actualShim);
  assert.equal(path.basename(actualShim).toLowerCase(), "claude.cmd", `${prefix}_REAL_CLI_REQUIRED`);
  const source = new URL("../client/src/engines/claude/claudeCli.ts", import.meta.url).href;
  const script = `const {resolveClaudeCli}=await import(${JSON.stringify(source)}); const value=resolveClaudeCli(); console.log(JSON.stringify({...value,nodeCommand:value.command===process.execPath}));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|comspec|pathext|temp|tmp|tmpdir)$/iu.test(key)));
  env.PATH = directory;
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", script],
    { env, cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}_CLI_RESOLUTION_FAILED: ${result.stderr}`);
  const resolved = JSON.parse(result.stdout);
  assert.ok(resolved.command !== "claude", `${prefix}_CLI_ENTRY_REQUIRED`);
  const command = resolved.nodeCommand ? nodeCommand : await fs.realpath(resolved.command), argsPrefix = resolved.argsPrefix;
  const entry = argsPrefix[0] ?? command, packageRoot = path.join(directory, "node_modules/@anthropic-ai/claude-code"), packageFile = path.join(packageRoot, "package.json");
  const metadata = JSON.parse(await readText(packageFile));
  assert.equal(metadata.name, "@anthropic-ai/claude-code", `${prefix}_CLI_PACKAGE_INVALID`);
  const files = { shim: actualShim, entry, package: packageFile, command };
  let nativeTarget;
  if (path.basename(entry) === "cli-wrapper.cjs") {
    const name = `@anthropic-ai/claude-code-win32-${process.arch}`;
    assert.ok(metadata.optionalDependencies?.[name], `${prefix}_CLI_NATIVE_PACKAGE_REQUIRED`);
    const nativePackage = createRequire(packageFile).resolve(`${name}/package.json`), nativeMetadata = JSON.parse(await readText(nativePackage));
    assert.equal(nativeMetadata.name, name); assert.equal(nativeMetadata.version, metadata.optionalDependencies[name]);
    nativeTarget = await fs.realpath(path.join(path.dirname(nativePackage), "claude.exe"));
    Object.assign(files, { nativePackage, nativeTarget });
  }
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, sha(await fs.readFile(file))])));
  return { shim: actualShim, directory, command, argsPrefix, entry, nativeTarget, files, hashes };
}

/** 冻结Node、Git及固定系统辅助程序，不把原PATH整体传给产品。 */
async function pinnedLaunchInputs(cli) {
  let git;
  for (const directory of String(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "git.exe");
    if (await exists(candidate)) { git = await fs.realpath(candidate); break; }
  }
  assert.ok(git, `${prefix}_GIT_REQUIRED`);
  const node = await fs.realpath(process.execPath), system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(system, `${prefix}_SYSTEM_ROOT_REQUIRED`);
  const directories = [...new Set([path.dirname(node), cli.directory, path.dirname(git), path.join(system, "System32"), system, path.join(system, "System32/WindowsPowerShell/v1.0")])];
  for (const directory of directories) {
    const shim = path.join(directory, "claude.cmd");
    if (await exists(shim)) assert.equal(await fs.realpath(shim), cli.shim, `${prefix}_CLI_PATH_CONFLICT`);
  }
  return { PATH: directories.join(path.delimiter), node, git, shell: await fs.realpath(path.join(system, "System32/cmd.exe")),
    consoleHost: await fs.realpath(path.join(system, "System32/conhost.exe")), where: await fs.realpath(path.join(system, "System32/where.exe")),
    taskkill: await fs.realpath(path.join(system, "System32/taskkill.exe")) };
}

/** shim 不变也必须重核真实入口、包清单和 wrapper 的最终 native 目标。 */
export async function assertProviderCliUnchanged(selected) {
  const actual = await resolveProviderCli(selected.shim, selected.argsPrefix.length ? selected.command : process.execPath);
  assert.deepEqual(actual, selected, `${prefix}_CLI_INPUT_CHANGED`);
}

/** 仅引用已冻结的 Windows 文件路径，按 Node spawn 的空格规则构造固定命令。 */
function fixedProcessPath(filename) {
  assert.ok(!/["\r\n\0]/u.test(filename), `${prefix}_PROCESS_PATH_INVALID`);
  return /[ \t]/u.test(filename) ? `"${filename}"` : filename;
}

/** 脚本入口必须按生产启动顺序占据命令起始；尾部附加的路径不授予所有权。 */
function startsFixedProcessEntry(command, executable, argsPrefix) {
  const entry = [executable, ...argsPrefix].map(fixedProcessPath).join(" ").toLowerCase();
  return command === entry || command.startsWith(`${entry} `);
}

/** 原 resolver 只读解析钉住的 PATH 并保留任务临时目录；缺少入口即失败，不执行 Codex。 */
export async function resolveCodexVersionProbe(PATH, nodeCommand) {
  const source = new URL("../client/src/engines/codex-app-server/codexAppServerCli.ts", import.meta.url).href;
  const script = `const {resolveCodexCli}=await import(${JSON.stringify(source)}); const value=resolveCodexCli(); console.log(JSON.stringify({...value,nodeCommand:value.command===process.execPath}));`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:systemroot|windir|comspec|pathext|temp|tmp|tmpdir)$/iu.test(key)));
  env.PATH = PATH;
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "--eval", script],
    { env, cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${prefix}_CODEX_RESOLUTION_FAILED: ${result.stderr}`);
  const resolved = JSON.parse(result.stdout);
  assert.ok(resolved.nodeCommand && resolved.argsPrefix.length === 1, `${prefix}_CODEX_ENTRY_REQUIRED`);
  let shimPath;
  for (const directory of PATH.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "codex.cmd");
    if (await exists(candidate)) { shimPath = candidate; break; }
  }
  assert.ok(shimPath, `${prefix}_CODEX_ENTRY_REQUIRED`);
  const directory = path.dirname(shimPath), argsPrefix = resolved.argsPrefix;
  assert.ok(argsPrefix[0] === path.join(directory, "node_modules/@openai/codex/bin/codex.js"), `${prefix}_CODEX_ENTRY_REQUIRED`);
  const shim = await fs.realpath(shimPath), entry = await fs.realpath(argsPrefix[0]), command = await fs.realpath(nodeCommand);
  const packageFile = await fs.realpath(path.join(directory, "node_modules/@openai/codex/package.json")), metadata = JSON.parse(await readText(packageFile));
  assert.ok(metadata.name === "@openai/codex" && metadata.version && metadata.bin?.codex === "bin/codex.js", `${prefix}_CODEX_PACKAGE_INVALID`);
  assert.ok(["x64", "arm64"].includes(process.arch), `${prefix}_CODEX_PLATFORM_UNSUPPORTED`);
  const name = `@openai/codex-win32-${process.arch}`, version = `${metadata.version}-win32-${process.arch}`;
  assert.ok(metadata.optionalDependencies?.[name] === `npm:@openai/codex@${version}`, `${prefix}_CODEX_NATIVE_PACKAGE_INVALID`);
  const nativePackage = await fs.realpath(createRequire(entry).resolve(`${name}/package.json`)), nativeMetadata = JSON.parse(await readText(nativePackage));
  assert.ok(nativeMetadata.name === "@openai/codex" && nativeMetadata.version === version && nativeMetadata.os?.includes("win32")
    && nativeMetadata.cpu?.includes(process.arch), `${prefix}_CODEX_NATIVE_PACKAGE_INVALID`);
  const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const nativeCommand = path.join(path.dirname(nativePackage), "vendor", target, "bin/codex.exe"), nativeTarget = await fs.realpath(nativeCommand);
  const files = { shim, entry, package: packageFile, nativePackage, nativeTarget };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, sha(await fs.readFile(file))])));
  const jsCommandLine = `${[command, ...argsPrefix].map(fixedProcessPath).join(" ")} --version`.toLowerCase();
  const nativeCommandLine = `${fixedProcessPath(nativeCommand)} --version`.toLowerCase();
  return { PATH, shim, directory, command, argsPrefix, entry, nativeCommand, nativeTarget, jsCommandLine, nativeCommandLine, files, hashes };
}

/** 重走同一生产搜索范围，核实版本探针的路径、元数据与全部字节未变化。 */
export async function assertCodexVersionProbeUnchanged(selected) {
  const actual = await resolveCodexVersionProbe(selected.PATH, selected.command);
  assert.deepEqual(actual, selected, `${prefix}_CODEX_INPUT_CHANGED`);
}

/** 本片仅接受完整五字段身份，拒绝裸 PID 与不完整采样。 */
function assertProcessIdentity(identity) {
  assert.ok(identity && Number.isSafeInteger(identity.pid) && identity.pid > 0 && Number.isSafeInteger(identity.parentPid) && identity.parentPid >= 0
    && Number.isSafeInteger(identity.created) && identity.created > 0 && path.isAbsolute(identity.executable) && identity.commandLine, `${prefix}_PROCESS_IDENTITY_INCOMPLETE`);
}

/** 诊断只公开身份数值、已知类别及摘要，绝不输出原路径或命令参数。 */
export function assetProcessEvidence(owner, identities) {
  const inputs = { product: owner.executable, shell: owner.shell, profile: owner.profile, client: owner.clientFile, mcp: owner.mcpFile,
    cliEntry: owner.cli?.entry, cliCommand: owner.cli?.command, cliNative: owner.cli?.nativeTarget, node: owner.node, git: owner.git, consoleHost: owner.consoleHost, where: owner.where, taskkill: owner.taskkill,
    codexEntry: owner.codex?.entry, codexNative: owner.codex?.nativeTarget,
    toolRuntime: owner.project ? path.join(owner.project, ".codeflow/tool-runtime") : undefined };
  const references = Object.entries(inputs).filter(([, value]) => value).map(([role, value]) => [role, value.toLowerCase()]);
  return { requestId: owner.requestId ?? "unassigned", anchorPid: owner.anchorPid, observerPid: owner.observerPid, mainPid: owner.mainPid, launchAfter: owner.launchAfter,
    inputs: Object.fromEntries(references.map(([role, value]) => [role, sha(value)])),
    processes: identities.map(identity => {
      const executable = String(identity.executable ?? "").toLowerCase(), command = String(identity.commandLine ?? "").toLowerCase();
      const basename = path.win32.basename(executable);
      return { pid: identity.pid, parentPid: identity.parentPid, created: identity.created,
        publicRole: ["codeflowai.exe", "cmd.exe", "node.exe", "claude.exe", "codex.exe", "git.exe", "conhost.exe", "where.exe", "taskkill.exe", "powershell.exe"].includes(basename) ? basename : "unknown",
        executableSha256: sha(executable), commandLineSha256: sha(command), commandLineLength: command.length,
        executableMatches: references.filter(([, value]) => executable === value).map(([role]) => role),
        commandReferences: references.filter(([, value]) => command.includes(value)).map(([role]) => role) };
    }) };
}

/** 同片父链与固定入口才登记；Git查询仅限Claude直系的固定where命令。 */
export async function captureAssetProcesses(owner, boundary = {}) {
  const production = await import("../src/windowsProcessIdentity.ts");
  const select = values => {
    const ids = new Set([owner.anchorPid, ...owner.records.map(item => item.pid)]);
    let added = true;
    while (added) { added = false; for (const item of values) if (ids.has(item.parentPid) && !ids.has(item.pid)) { ids.add(item.pid); added = true; } }
    return values.filter(item => ids.has(item.pid));
  };
  const values = await (boundary.snapshot ?? production.processSnapshot)({ known: [...owner.records, ...(owner.observer ? [owner.observer] : [])],
    preflight: items => [...select(items), ...items.filter(item => item.pid === owner.observerPid)] });
  const observer = values.find(item => item.pid === owner.observerPid);
  assertProcessIdentity(observer);
  assert.equal(observer.executable, process.execPath, `${prefix}_PROCESS_OBSERVER_UNCONFIRMED`);
  if (owner.observer) assert.deepEqual(observer, owner.observer, `${prefix}_PROCESS_OBSERVER_CHANGED`);
  const related = select(values), known = new Map(owner.records.map(item => [item.pid, item]));
  let mainPid = owner.mainPid;
  const clientCommand = owner.clientFile && `${[owner.executable, owner.clientFile].map(fixedProcessPath).join(" ")} --foreground`.toLowerCase();
  /** JS 探针只能来自本轮主进程直系、完整固定入口的已确认 Client。 */
  const codexJs = identity => {
    const client = known.get(identity.parentPid);
    return owner.codex && identity.executable.toLowerCase() === owner.executable.toLowerCase() && identity.commandLine.toLowerCase() === owner.codex.jsCommandLine
      && client?.parentPid === mainPid && client.executable.toLowerCase() === owner.executable.toLowerCase()
      && client.commandLine.toLowerCase() === clientCommand && identity.created >= client.created;
  };
  /** native 探针必须是已确认 JS 版本探针的直系，不放行 app-server。 */
  const codexNative = identity => {
    const parent = known.get(identity.parentPid);
    return owner.codex && identity.executable.toLowerCase() === owner.codex.nativeTarget.toLowerCase()
      && identity.commandLine.toLowerCase() === owner.codex.nativeCommandLine && parent && codexJs(parent) && identity.created >= parent.created;
  };
  /** 固定Git查询仍只来自已确认Claude入口；其系统控制台复用同一父链判定。 */
  const gitLocator = identity => {
    const parent = known.get(identity.parentPid);
    return owner.where && identity.executable.toLowerCase() === owner.where.toLowerCase()
      && identity.commandLine.toLowerCase() === `${fixedProcessPath(owner.where).toLowerCase()} git` && parent && owner.cli
      && (parent.executable.toLowerCase() === owner.cli.command.toLowerCase()
        && (!owner.cli.argsPrefix.length || startsFixedProcessEntry(parent.commandLine.toLowerCase(), owner.cli.command, owner.cli.argsPrefix))
        || parent.executable.toLowerCase() === owner.cli.nativeTarget?.toLowerCase()) && identity.created >= parent.created;
  };
  /** 只识别Claude清理此前已确认的同父MCP；PID仍存活时必须保持完整身份。 */
  const mcpStop = identity => {
    if (!owner.taskkill || !owner.mcpFile || !owner.cli || identity.executable.toLowerCase() !== owner.taskkill.toLowerCase()) return false;
    const parent = known.get(identity.parentPid), parentCommand = parent?.commandLine.toLowerCase();
    if (!parent || !(parent.executable.toLowerCase() === owner.cli.command.toLowerCase()
      && (!owner.cli.argsPrefix.length || startsFixedProcessEntry(parentCommand, owner.cli.command, owner.cli.argsPrefix))
      || parent.executable.toLowerCase() === owner.cli.nativeTarget?.toLowerCase())) return false;
    return owner.records.some(target => target.parentPid === parent.pid && target.executable.toLowerCase() === owner.executable.toLowerCase()
      && target.commandLine.toLowerCase() === [owner.executable, owner.mcpFile].map(fixedProcessPath).join(" ").toLowerCase()
      && target.created >= parent.created && identity.created >= target.created
      && identity.commandLine.toLowerCase() === `${fixedProcessPath(owner.taskkill).toLowerCase()} /pid ${target.pid} /t /f`
      && (!values.some(item => item.pid === target.pid) || values.some(item => item.pid === target.pid && item.parentPid === target.parentPid
        && item.created === target.created && item.executable === target.executable && item.commandLine === target.commandLine)));
  };
  for (const item of related) {
    assertProcessIdentity(item);
    if (known.has(item.pid)) assert.deepEqual(item, known.get(item.pid), `${prefix}_PROCESS_IDENTITY_CHANGED`);
  }
  const pending = related.filter(item => !known.has(item.pid));
  while (pending.length) {
    const index = pending.findIndex(item => item.pid === owner.anchorPid || known.has(item.parentPid));
    assert.ok(index >= 0, `${prefix}_PROCESS_PARENT_UNCONFIRMED`);
    const item = pending.splice(index, 1)[0], command = item.commandLine.toLowerCase(), executable = item.executable.toLowerCase();
    if (item.pid === owner.anchorPid) {
      assert.equal(item.parentPid, owner.observerPid);
      assert.ok(item.created >= observer.created && item.created >= owner.launchAfter, `${prefix}_PROCESS_CREATION_UNCONFIRMED`);
      assert.ok(command.includes(owner.profile.toLowerCase()), `${prefix}_PROCESS_PROFILE_REQUIRED`);
      assert.ok(command.includes(owner.executable.toLowerCase()), `${prefix}_PROCESS_ENTRY_UNCONFIRMED: ${JSON.stringify(assetProcessEvidence(owner, [item, observer]))}`);
      if (executable === owner.executable.toLowerCase()) mainPid = item.pid;
      else {
        assert.equal(executable, owner.shell?.toLowerCase(), `${prefix}_PROCESS_WRAPPER_UNCONFIRMED`);
        const children = related.filter(child => child.parentPid === item.pid && child.executable.toLowerCase() === owner.executable.toLowerCase()
          && child.commandLine.toLowerCase().includes(owner.executable.toLowerCase()) && child.commandLine.toLowerCase().includes(owner.profile.toLowerCase()));
        assert.equal(children.length, 1, `${prefix}_PROCESS_WRAPPER_CHILD_REQUIRED`);
        assert.ok(children[0].created >= item.created, `${prefix}_PROCESS_CREATION_UNCONFIRMED`);
        mainPid = children[0].pid;
      }
    } else {
      const parent = known.get(item.parentPid);
      assert.ok(related.some(value => value.pid === parent.pid) && item.created >= parent.created, `${prefix}_PROCESS_PARENT_UNCONFIRMED`);
      const codexEntry = owner.codex && [owner.codex.entry, ...owner.codex.argsPrefix].some(file => command.replaceAll("/", "\\").includes(file.toLowerCase().replaceAll("/", "\\")));
      const productPrefixes = [fixedProcessPath(owner.executable).toLowerCase(), `"${owner.executable.toLowerCase()}"`];
      const profile = command.includes(owner.profile.toLowerCase()) && productPrefixes.some(entry => item.parentPid === mainPid
        && ["gpu-process", "utility", "renderer"].some(type => command.startsWith(`${entry} --type=${type} `))
        || item.pid === mainPid && command.startsWith(entry) && /^ +"?--/u.test(command.slice(entry.length)));
      const product = !codexEntry && executable === owner.executable.toLowerCase() && (profile || [owner.clientFile, owner.mcpFile].filter(Boolean)
        .some(file => startsFixedProcessEntry(command, owner.executable, [file])));
      const provider = !codexEntry && owner.cli && executable === owner.cli.command.toLowerCase()
        && (!owner.cli.argsPrefix.length || startsFixedProcessEntry(command, owner.cli.command, owner.cli.argsPrefix));
      const native = owner.cli?.nativeTarget && executable === owner.cli.nativeTarget.toLowerCase();
      const tool = owner.node && executable === owner.node.toLowerCase() && command.includes(path.join(owner.project, ".codeflow/tool-runtime").toLowerCase());
      const git = owner.git && executable === owner.git.toLowerCase();
      const parentExecutable = parent.executable.toLowerCase(), parentCommand = parent.commandLine.toLowerCase();
      const cliParent = owner.cli && (parentExecutable === owner.cli.command.toLowerCase()
        && (!owner.cli.argsPrefix.length || startsFixedProcessEntry(parentCommand, owner.cli.command, owner.cli.argsPrefix))
        || parentExecutable === owner.cli.nativeTarget?.toLowerCase());
      const consoleCommand = owner.consoleHost && `\\??\\${owner.consoleHost.toLowerCase()} `;
      const console = (cliParent || codexJs(parent) || codexNative(parent) || gitLocator(parent) || mcpStop(parent)) && executable === owner.consoleHost?.toLowerCase() && command.startsWith(consoleCommand)
        && /^0x[0-9a-f]+$/u.test(command.slice(consoleCommand.length));
      assert.ok(product || provider || native || tool || git || codexJs(item) || codexNative(item) || console || gitLocator(item) || mcpStop(item), `${prefix}_PROCESS_ENTRY_UNCONFIRMED: ${JSON.stringify(assetProcessEvidence(owner, [item, parent]))}`);
    }
    known.set(item.pid, item);
  }
  owner.records = [...known.values()];
  owner.observer = observer; owner.mainPid = mainPid;
  assert.ok(known.has(owner.anchorPid), `${prefix}_PROCESS_ROOT_UNCONFIRMED`);
  return related;
}

/** 先校验全体所有权，再逐次重采与精确停止；任一复用或未知身份均零猜测。 */
export async function stopAssetProcesses(owner, boundary = {}) {
  const { stopIdentity } = await import("../src/windowsProcessIdentity.ts");
  let active = await captureAssetProcesses(owner, boundary);
  const pending = [...owner.records].reverse();
  for (const identity of pending) {
    active = await captureAssetProcesses(owner, boundary);
    if (active.some(item => item.pid === identity.pid)) await (boundary.stop ?? stopIdentity)(identity);
  }
  assert.equal((await captureAssetProcesses(owner, boundary)).length, 0, `${prefix}_PROCESSES_REMAIN`);
}

/** 全部只读门禁完成后才允许建目录、启动或消耗模型费用。 */
export async function preflightAssets(args, options = {}) {
  const { preflight } = await import("./electron-packaged-protocol.smoke.mjs");
  const paths = await preflight(args);
  const mcp = path.join(paths.resources, "client/scripts/claude-platform-tools-mcp.cjs");
  assert.ok(await exists(mcp), `${prefix}_PACKAGED_MCP_REQUIRED`);
  const trustedKeys = assertTrustedReleaseKeys(JSON.parse(await readText(path.join(paths.resources, "release-trust.json"))));
  const manifestInput = JSON.parse(await readText(path.join(paths.resources, "baseline-release-manifest.json")));
  const manifest = verifyReleaseBundleSignature(manifestInput, trustedKeys, { platform: "win32", arch: "x64", requireFresh: true });
  assert.ok(manifest.files.some(file => file.path === "client/scripts/claude-platform-tools-mcp.cjs"), `${prefix}_PACKAGED_MCP_REQUIRED`);
  await verifyReleaseBundlePayload({ directory: paths.resources, manifest, trustedKeys, platform: "win32", arch: "x64", requireFresh: true, requireHeldStartup: true });
  const clientText = await readText(paths.files.client);
  for (const marker of ["native-dynamic", "runtime.submitNodeResult", "skill-runtime"]) assert.ok(clientText.includes(marker), `${prefix}_CLIENT_CAPABILITY_REQUIRED: ${marker}`);
  const env = options.env ?? process.env;
  const cli = await resolveProviderCli(await resolveCli(options.cli, env), paths.executable);
  const credentialFile = await fs.realpath(options.credentialFile ?? "D:/cf-temp/d06-env/provider.env");
  const provider = parseProviderEnv(await readText(credentialFile), env), launch = await pinnedLaunchInputs(cli);
  const codex = await resolveCodexVersionProbe(launch.PATH, paths.executable);
  const files = { ...paths.files, mcp, manifest: path.join(paths.resources, "baseline-release-manifest.json"), trust: path.join(paths.resources, "release-trust.json"),
    ...Object.fromEntries(Object.entries(cli.files).map(([name, file]) => [`cli-${name}`, file])),
    ...Object.fromEntries(Object.entries(codex.files).map(([name, file]) => [`codex-${name}`, file])), node: launch.node, git: launch.git, shell: launch.shell, consoleHost: launch.consoleHost, where: launch.where, taskkill: launch.taskkill };
  const hashes = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, file]) => [name, sha(await fs.readFile(file))])));
  return { ...paths, files, hashes, manifest, provider, cli, codex, launch, credentialFile };
}

/** 运行定义去掉展示时间后必须逐字段等于原冻结定义。 */
function assertFrozen(entry, asset, type, allowDetached = false) {
  assert.ok(entry, `${prefix}_DEPENDENCY_MISSING: ${type}`);
  assert.equal(entry.assetType, type); assert.equal(entry.assetId, asset.id);
  const { createdAt, updatedAt, ...definition } = asset;
  assert.deepEqual(entry.definition, definition, `${prefix}_FROZEN_DEFINITION_CHANGED: ${type}`);
  if (allowDetached && entry.source === null) return;
  assert.deepEqual(entry.source, { authorityMode: "legacy", createdAt, updatedAt }, `${prefix}_FROZEN_SOURCE_INVALID: ${type}`);
}

/** 遍历真实 raw JSON，仅提取原生工具块而不凭正文关键词判断调用。 */
function rawBlocks(value, output = []) {
  if (!value || typeof value !== "object") return output;
  if (value.type === "tool_use" || value.type === "tool_result") output.push(value);
  for (const child of Object.values(value)) if (child && typeof child === "object") rawBlocks(child, output);
  return output;
}

/** 每个调用须有同ID成功终态与stdout原生调用/结果，stderr不能充当工具证明。 */
function requireTool(evidence, toolId, outputText) {
  const expectedName = toolId === "Read" ? "Read" : `aidt_${toolId.replace(/[^a-zA-Z0-9_-]+/gu, "_")}`;
  const matches = name => name === expectedName || name === `mcp__aidt_runtime__${expectedName}`;
  const starts = evidence.canonical.filter(event => event.type === "item.tool.started" && matches(event.payload?.toolName));
  const blocks = evidence.raw.filter(value => value.source === "claude.stream-json.stdout").flatMap(value => rawBlocks(value));
  assert.ok(starts.length, `${prefix}_TOOL_CALL_MISSING: ${toolId}`);
  const paired = starts.some(start => {
    const id = start.payload.itemId;
    const completed = evidence.canonical.find(event => event.type === "item.tool.completed" && event.payload?.itemId === id && matches(event.payload?.toolName)
      && event.payload.status === "completed" && !event.payload.error);
    const inputs = evidence.canonical.filter(event => event.type === "item.tool.inputUpdated" && event.payload?.itemId === id && matches(event.payload?.toolName));
    const input = inputs.length ? inputs.at(-1).payload.input : start.payload.input;
    const use = blocks.find(block => block.type === "tool_use" && block.id === id && matches(block.name)
      && (toolId !== "Read" || block.input?.file_path === input?.file_path));
    const result = blocks.find(block => block.type === "tool_result" && block.tool_use_id === id && !block.is_error);
    if (!completed || !use || !result) return false;
    if (toolId === "Read" && path.basename(String(input?.file_path ?? "")) !== "knowledge.txt") return false;
    if (outputText && (!JSON.stringify(completed.payload.output).includes(outputText) || !JSON.stringify(result.content).includes(outputText))) return false;
    return true;
  });
  assert.ok(paired, `${prefix}_TOOL_EVIDENCE_INCOMPLETE: ${toolId}`);
}

/** 只接受同实例冻结图、同节点线程、真实工具链和正式持久结果的联合证据。 */
export function assertAssetEvidence(evidence) {
  const { instance, assets, expected, canonical, raw, turns, prompts, artifacts, events, retainedTools } = evidence;
  assert.equal(instance.id, expected.instanceId); assert.equal(instance.workspaceId, expected.workspaceId); assert.equal(instance.status, "completed");
  assert.deepEqual(instance.intakeSnapshot.workspaceScope, { scopeType: "local_workspace", scopeId: expected.workspaceId });
  assert.equal(instance.nodeStates.verify.status, "completed"); assert.equal(instance.nodeStates.verify.threadId, expected.threadId);
  const graph = instance.assetRuntimeSnapshot; assert.equal(graph.authorityMode, "legacy");
  assertFrozen(graph.workflow, assets.workflow, "workflow", true);
  for (const [map, name, type] of [["roles", "role", "role"], ["knowledgeBundles", "knowledge", "knowledge_bundle"], ["toolsets", "toolset", "toolset"], ["skills", "skill", "skill"]]) {
    assert.deepEqual(Object.keys(graph[map]), [assets[name].id]); assertFrozen(graph[map][assets[name].id], assets[name], type);
  }
  assert.ok(canonical.length && raw.length && turns.length && prompts.length && artifacts.length, `${prefix}_DURABLE_EVIDENCE_REQUIRED`);
  for (const event of canonical) {
    assert.equal(event.workspaceId, expected.workspaceId); assert.equal(event.threadId, expected.threadId); assert.equal(event.engine, "claude");
    assert.ok(!["turn.error", "error", "approval.requested", "userInput.requested"].includes(event.type), `${prefix}_UNEXPECTED_INTERACTION_OR_ERROR`);
  }
  const turnIds = new Set(turns.map(turn => { assert.equal(turn.status, "completed"); assert.equal(turn.engine, "claude"); return turn.id; }));
  for (const id of turnIds) {
    assert.ok(canonical.some(event => event.type === "turn.started" && event.payload.turnId === id), `${prefix}_TURN_START_MISSING`);
    assert.ok(canonical.some(event => event.type === "turn.completed" && event.payload.turnId === id), `${prefix}_TURN_COMPLETION_MISSING`);
  }
  for (const event of raw) {
    assert.equal(event.workspaceId, expected.workspaceId); assert.equal(event.threadId, expected.threadId); assert.equal(event.engine, "claude");
    assert.ok(["claude.stream-json.stdout", "claude.stderr"].includes(event.source)); assert.ok(event.data && typeof event.data === "object");
    if (event.source === "claude.stderr") {
      assert.deepEqual(Object.keys(event.data), ["line"]);
      assert.ok(typeof event.data.line === "string" && event.data.line.trim());
    }
  }
  for (const prompt of prompts) {
    assert.equal(prompt.thread_id, expected.threadId); assert.equal(prompt.node_id, "verify"); assert.ok(turnIds.has(prompt.turn_id));
    assert.equal(prompt.engine, "claude"); assert.equal(prompt.model, model); assert.equal(prompt.effort, effort);
    assert.ok(prompt.system_message.trim() && prompt.developer_message.includes("runtime.submitNodeResult") && prompt.user_message.trim());
    assert.ok(JSON.parse(prompt.prompt_envelope_json));
    const tools = JSON.parse(prompt.tool_registry_json).tools.map(tool => tool.toolId);
    for (const id of ["inspect-project", expected.skillToolId, "runtime.submitNodeResult"]) assert.ok(tools.includes(id), `${prefix}_REGISTRY_DEPENDENCY_MISSING: ${id}`);
    const knowledge = JSON.parse(prompt.knowledge_catalogs_json);
    assert.ok(knowledge && Array.isArray(knowledge.catalogs) && Array.isArray(knowledge.warnings));
    assert.deepEqual(knowledge.warnings, []);
    assert.ok(knowledge.catalogs.some(catalog => catalog.bundleId === assets.knowledge.id));
  }
  requireTool(evidence, "Read", expected.knowledgeNonce);
  requireTool(evidence, "inspect-project", expected.toolDigest);
  requireTool(evidence, expected.skillToolId, expected.skillDigest);
  requireTool(evidence, "runtime.submitNodeResult");
  for (const id of ["inspect-project", expected.skillToolId]) assert.ok(retainedTools.includes(id), `${prefix}_RETAINED_TOOL_REQUIRED: ${id}`);
  const files = assets.skill.files.map(file => ({ relPath: file.relPath, sizeBytes: file.sizeBytes, sha256: file.sha256 })).sort((a, b) => a.relPath.localeCompare(b.relPath));
  assert.ok(files.length, `${prefix}_SKILL_FILES_REQUIRED`);
  assert.deepEqual(evidence.materializedSkillFiles, files, `${prefix}_SKILL_MATERIALIZATION_CHANGED`);
  const content = artifacts.filter(item => item.nodeId === "verify").map(item => item.contentJson).join("\n");
  for (const proof of [expected.knowledgeNonce, expected.toolDigest, expected.skillDigest]) assert.ok(content.includes(proof), `${prefix}_ARTIFACT_PROOF_MISSING`);
  assert.ok(events.some(event => event.type === "orchestration.completed"));
}

/** 仅经产品 bridge 建完整的个人依赖图，脚本实际读取并计算本次输入。 */
export async function createAssets(request, application, workspaceId, project, runId) {
  const knowledgeNonce = crypto.randomUUID(), projectBytes = crypto.randomBytes(32), reference = crypto.randomBytes(24), binary = crypto.randomBytes(16);
  await fs.writeFile(path.join(project, "knowledge.txt"), `knowledge-proof=${knowledgeNonce}\n`, "utf8");
  await fs.writeFile(path.join(project, "proof.bin"), projectBytes);
  const toolDigest = sha(projectBytes);
  const knowledge = (await request("orch.knowledgeBundles.upsert", { workspaceId, bundle: { name: `D07-${runId}-knowledge`, description: "本次实际项目知识", scope: "role", content: "读取导航中的 knowledge.txt", sourceRefs: [
    { id: "proof", kind: "workspace-file", title: "本次知识证明", ref: "knowledge.txt", enabled: true },
  ] } })).bundle;
  const toolCode = 'const fs = await import("node:fs/promises"); const path = await import("node:path"); const crypto = await import("node:crypto"); const bytes = await fs.readFile(path.join(process.env.CODEFLOWAI_TOOL_WORKSPACE_PATH, "proof.bin")); printJson({sha256:crypto.createHash("sha256").update(bytes).digest("hex")});';
  const schema = JSON.stringify({ type: "object", properties: {}, additionalProperties: false });
  const outputSchema = JSON.stringify({ type: "object", properties: { sha256: { type: "string" } }, required: ["sha256"], additionalProperties: false });
  const toolset = (await request("orch.toolsets.upsert", { workspaceId, toolset: { name: `D07-${runId}-toolset`, description: "只读实际文件摘要", tools: [
    { id: "inspect-project", name: "Inspect project", description: "读取 proof.bin 并返回真实 SHA256", runtime: "node", code: toolCode, invocationHint: "本次验收必须调用一次", inputSchema: schema, outputSchema, requiresWrite: false, timeoutMs: 10_000 },
  ] } })).toolset;
  const slug = `d07-${runId}`;
  const skillCode = 'const fs = await import("node:fs/promises"); const crypto = await import("node:crypto"); const bytes = Buffer.concat([await fs.readFile("references/proof.txt"), await fs.readFile("assets/proof.bin")]); printJson({sha256:crypto.createHash("sha256").update(bytes).digest("hex")});';
  const skillMd = `# 本次资产验收技能\n调用平台已实体化的 Skill 脚本工具 skill.${slug}.check，记录真实返回的 sha256。\n`;
  const files = [{ relPath: "SKILL.md", kind: "skill-md", contentText: skillMd }, { relPath: "scripts/check.mjs", kind: "script", contentText: skillCode },
    { relPath: "references/proof.txt", kind: "reference", contentText: reference.toString("hex") }, { relPath: "assets/proof.bin", kind: "asset", contentBase64: binary.toString("base64") }]
    .map(file => { const bytes = file.contentText != null ? Buffer.from(file.contentText, "utf8") : Buffer.from(file.contentBase64, "base64"); return { ...file, sizeBytes: bytes.length, sha256: sha(bytes) }; });
  const actualSkillDigest = sha(Buffer.concat([Buffer.from(reference.toString("hex"), "utf8"), binary]));
  const skill = (await request("orch.skills.upsert", { workspaceId, skill: { name: `D07-${runId}-skill`, slug, description: "完整技能包真实执行", trigger: "本次资产验收", instructions: skillMd, targetEngines: ["claude"], skillMd, files,
    scripts: [{ id: "check", name: "Check Skill package", description: "读取完整包的 reference 与 binary 返回 SHA256", scriptPath: "scripts/check.mjs", runtime: "node", exposeAsTool: true, requiresWrite: false, inputSchema: schema, outputSchema, timeoutMs: 10_000 }] } })).skill;
  const defaults = await application.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule("module"), shared = createRequire(`${app.getAppPath()}/package.json`)("@codeflowai/shared");
    const executionConfig = shared.createDefaultRoleExecutionConfig("claude");
    executionConfig.engineProfiles.claude = { enabled: true, mode: "custom", customConfig: { ...shared.createDefaultRoleExecutionCustomConfig("claude"), model: "deepseek-v4-pro", effort: "high", maxRetries: 0 } };
    executionConfig.engineProfiles.codex.enabled = false;
    return { executionConfig, inputDefinition: shared.createDefaultRoleInputDefinition(), outputDefinition: shared.createDefaultRoleOutputDefinition() };
  });
  const systemPrompt = `完成一个只读验收任务：用原生 Read 读取知识目录指向的 knowledge.txt；调用平台工具 inspect-project；调用绑定 Skill 的脚本工具 skill.${slug}.check。必须实际执行，不猜测、不用 shell 替代平台工具。最后调用 runtime.submitNodeResult，以 text 正式结果提交 knowledge-proof 的值与两个工具返回的 SHA256。不要请求审批、提问、委派、修改项目或调用外网。提交结构遵循平台当前合同。`;
  const role = (await request("orch.roles.upsert", { workspaceId, role: { ...defaults, name: `D07-${runId}-role`, description: "单节点真实资产执行", systemPrompt, gateCriteria: [], defaultKnowledgeBundleIds: [knowledge.id], defaultSkillIds: [skill.id], toolRefs: [{ toolsetId: toolset.id, toolId: "inspect-project", required: true }] } })).role;
  const workflow = (await request("orch.workflows.upsert", { workspaceId, workflow: { name: `D07-${runId}-workflow`, description: "单角色真实 provider 闭环", family: "analysis", version: 1, workflowKnowledgeBundleIds: [knowledge.id], nodes: [
    { id: "start", type: "start", label: "开始", position: { x: 0, y: 0 } }, { id: "verify", type: "role", label: "真实资产验收", roleId: role.id, approvalMode: "auto", outputArtifactMode: "text", knowledgeOverrideBundleIds: [knowledge.id], position: { x: 250, y: 0 } },
    { id: "end", type: "end", label: "完成", position: { x: 500, y: 0 } },
  ], edges: [{ id: "start-verify", sourceNodeId: "start", targetNodeId: "verify", dataMappings: [] }, { id: "verify-end", sourceNodeId: "verify", targetNodeId: "end", dataMappings: [] }] } })).workflow;
  return { assets: { knowledge, toolset, skill, role, workflow }, expected: { knowledgeNonce, toolDigest, skillDigest: actualSkillDigest, skillToolId: `skill.${slug}.check` } };
}

/** 正常退出后只读物理库；不回写实例、事件或模型结果。 */
export async function persistedEvidence(root, assets, expected) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(root, "project/.codeflow/workspace.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT * FROM orch_instances WHERE id = ? AND workspace_id = ?").get(expected.instanceId, expected.workspaceId);
    assert.ok(row, `${prefix}_INSTANCE_MISSING`);
    const instance = { id: row.id, workspaceId: row.workspace_id, status: row.status, assetRuntimeSnapshot: JSON.parse(row.asset_runtime_snapshot_json), intakeSnapshot: JSON.parse(row.intake_snapshot_json), nodeStates: JSON.parse(row.node_states_json) };
    const eventsFor = table => db.prepare(`SELECT event_json FROM ${table} WHERE thread_id = ? AND workspace_id = ? ORDER BY seq`).all(expected.threadId, expected.workspaceId).map(item => JSON.parse(item.event_json));
    const retainedTools = [], toolRoot = path.join(root, "project/.codeflow/tool-runtime");
    for (const directory of await fs.readdir(toolRoot, { withFileTypes: true })) {
      assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), `${prefix}_TOOL_DIRECTORY_INVALID`);
      const source = await readText(path.join(toolRoot, directory.name, "tool.mjs"));
      JSON.parse(await readText(path.join(toolRoot, directory.name, "input.json")));
      if (source.includes(assets.toolset.tools[0].code)) retainedTools.push("inspect-project");
      if (source.includes(assets.skill.files.find(file => file.relPath === "scripts/check.mjs").contentText)) retainedTools.push(expected.skillToolId);
    }
    const skillDirectories = [], skillRoot = path.join(root, "project/.codeflow/skill-runtime");
    for (const identity of await fs.readdir(skillRoot, { withFileTypes: true })) {
      assert.ok(identity.isDirectory() && !identity.isSymbolicLink(), `${prefix}_SKILL_DIRECTORY_INVALID`);
      for (const version of await fs.readdir(path.join(skillRoot, identity.name), { withFileTypes: true })) {
        assert.ok(version.isDirectory() && !version.isSymbolicLink(), `${prefix}_SKILL_DIRECTORY_INVALID`);
        const directory = path.join(skillRoot, identity.name, version.name);
        const metadata = JSON.parse(await readText(path.join(directory, ".codeflowai-skill.json")));
        if (metadata.skillId === assets.skill.id) skillDirectories.push(directory);
      }
    }
    assert.equal(skillDirectories.length, 1, `${prefix}_SKILL_RUNTIME_PACKAGE_REQUIRED`);
    const materializedSkillFiles = [];
    for (const file of assets.skill.files) {
      const filename = path.join(skillDirectories[0], file.relPath), actual = await fs.realpath(filename);
      assert.ok(actual.startsWith(`${skillDirectories[0]}${path.sep}`), `${prefix}_SKILL_FILE_OUTSIDE_PACKAGE`);
      assert.equal((await fs.lstat(filename)).isFile(), true);
      const bytes = await fs.readFile(filename);
      materializedSkillFiles.push({ relPath: file.relPath, sizeBytes: bytes.length, sha256: sha(bytes) });
    }
    materializedSkillFiles.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return { assets, expected, instance, canonical: eventsFor("conversation_events"), raw: eventsFor("raw_engine_events"),
      turns: db.prepare("SELECT turn_id AS id, status, engine FROM thread_turns WHERE thread_id = ? AND workspace_id = ? ORDER BY started_at").all(expected.threadId, expected.workspaceId),
      prompts: db.prepare("SELECT * FROM orch_prompt_snapshots WHERE instance_id = ? ORDER BY created_at").all(expected.instanceId),
      artifacts: db.prepare("SELECT id, node_id AS nodeId, content_json AS contentJson FROM orch_artifacts WHERE instance_id = ?").all(expected.instanceId),
      events: db.prepare("SELECT type FROM orch_events WHERE instance_id = ?").all(expected.instanceId), retainedTools, materializedSkillFiles };
  } finally { db.close(); }
}

/** 失败清理先读取同实例事实；保终态，不因验收错误覆盖已完成结果。 */
export async function cancelUnfinishedInstance(request, scope) {
  const { instance } = await request("orch.instances.get", scope);
  assert.ok(instance && instance.id === scope.instanceId && instance.workspaceId === scope.workspaceId, `${prefix}_CLEANUP_INSTANCE_MISMATCH`);
  if (["completed", "failed", "cancelled"].includes(instance.status)) return;
  assert.ok(["pending", "running", "paused", "waiting-start", "waiting-approval", "waiting-feedback"].includes(instance.status), `${prefix}_CLEANUP_INSTANCE_STATUS_INVALID`);
  await request("orch.instances.cancel", scope);
}

/** 仅显式 --run 才启动实包；预检模式不建证据目录也不消费模型。 */
export async function runAssets(args, options = {}) {
  const [executable, output, mode, ...extra] = args;
  assert.ok(!extra.length && ["--preflight", "--run"].includes(mode), `用法：electron-real-provider-assets.smoke.mjs <exe> <不存在的仓库外输出目录> <--preflight|--run>`);
  let selected, application, child, page, root, request, owner, phase = "preflight", operationError, hasError = false;
  const report = { requestId: crypto.randomUUID(), completed: false, paidProviderExercised: false, rendererErrors: [] };
  try {
    selected = await (options.preflight ?? preflightAssets)([executable, output]);
    if (mode === "--preflight") { console.log(JSON.stringify({ preflight: true, releaseId: selected.manifest.releaseId, hashes: selected.hashes, providerId: "deepseek", engine: "claude", model, effort })); return; }
    const support = await import("./support/packaged-app.mjs");
    const webRequire = createRequire(new URL("../../web/package.json", import.meta.url)), { expect } = webRequire("@playwright/test");
    root = selected.root; await fs.mkdir(root); const project = path.join(root, "project"); await fs.mkdir(project);
    report.frozen = { hashes: selected.hashes, releaseId: selected.manifest.releaseId };
    const env = await support.isolatedEnvironment(root, { PATH: selected.launch.PATH }); phase = "launch";
    await assertProviderCliUnchanged(selected.cli); await assertCodexVersionProbeUnchanged(selected.codex);
    const launchAfter = Date.now();
    const launched = await support.launchPackagedApp({ executablePath: selected.executable, userDataDir: path.join(root, "profile"), env, cwd: root });
    application = launched.application; child = launched.child;
    owner = { requestId: report.requestId, anchorPid: child.pid, observerPid: process.pid, launchAfter, shell: selected.launch.shell, profile: path.join(root, "profile"), executable: selected.executable, clientFile: selected.files.client,
      mcpFile: selected.files.mcp, cli: selected.cli, codex: selected.codex, node: selected.launch.node, git: selected.launch.git, consoleHost: selected.launch.consoleHost, where: selected.launch.where, taskkill: selected.launch.taskkill, project, records: [] };
    await captureAssetProcesses(owner);
    page = await application.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(30_000);
    page.on("pageerror", error => report.rendererErrors.push(safeFailure(error, [selected.provider.apiKey, selected.provider.baseUrl])));
    const facts = await application.evaluate(({ app, BrowserWindow }) => ({ isPackaged: app.isPackaged, exe: process.execPath, resources: process.resourcesPath,
      userData: app.getPath("userData"), preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }));
    assert.equal(facts.isPackaged, true); assert.equal(facts.exe, selected.executable); assert.equal(facts.resources, selected.resources); assert.equal(facts.userData, path.join(root, "profile"));
    assert.equal(facts.preferences.sandbox, true); assert.equal(facts.preferences.contextIsolation, true); assert.equal(facts.preferences.nodeIntegration, false);
    await page.waitForURL("codeflow://desktop/**");
    await expect.poll(async () => (await page.evaluate(() => window.codeflowDesktop.getState())).status, { timeout: 60_000 }).toBe("ready");
    const state = await page.evaluate(() => window.codeflowDesktop.getState()); assert.equal(state.health.database, "ready");
    await captureAssetProcesses(owner); assert.ok(owner.records.some(item => item.pid === state.pid), `${prefix}_CLIENT_OWNER_UNCONFIRMED`);
    /** 请求失败只报告方法、状态和可检索原因，不打印请求正文。 */
    request = async (method, body = {}) => {
      const response = await support.bounded(page.evaluate(input => window.codeflowDesktop.request(input), { method, body }), 15_000, `${prefix}_REQUEST_TIMEOUT: ${method}`);
      if (response.status !== 200 || !response.body?.ok) throw new Error(`${prefix}_REQUEST_FAILED: ${method} status=${response.status} code=${response.body?.code ?? "unknown"} message=${response.body?.message ?? "unknown"}`);
      return response.body;
    };
    phase = "workspace";
    await page.getByRole("button", { name: "新建工作区", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建工作区", exact: true });
    await dialog.locator('input[name="codeflow-workspace-title"]').fill("D07真实资产"); await dialog.locator('input[name="codeflow-workspace-path"]').fill(project);
    await dialog.getByRole("button", { name: /^创\s*建$/u }).click(); await expect(dialog).toBeHidden();
    const workspaceId = (await request("workspaces.list")).workspaces.find(item => item.path === project)?.id; assert.ok(workspaceId);
    await request("engineKeys.upsert", { workspaceId, label: "D07 real provider", engine: "claude", providerId: "deepseek", apiKey: selected.provider.apiKey, baseUrl: selected.provider.baseUrl });
    phase = "assets";
    const { assets, expected } = await createAssets(request, application, workspaceId, project, report.requestId);
    report.entities = { workspaceId, roleId: assets.role.id, workflowId: assets.workflow.id };
    const title = `D07 ${report.requestId}`;
    const { intake } = await request("orch.intakes.create", { workspaceId, intake: { title, taskType: "analysis", goal: "执行绑定完整依赖的单角色流程并正式提交真实证明", background: "真实 provider 本机资产验收", acceptanceCriteria: [{ text: "提交知识值与两个实际脚本摘要" }] } });
    report.entities.intakeId = intake.id;
    await page.goto("codeflow://desktop/orchestration/workspace");
    await page.locator(".ant-segmented-item").filter({ hasText: "需求编排" }).click();
    const card = page.locator(".task-sidebar__card").filter({ hasText: title }); await expect(card).toBeVisible(); await card.click();
    await page.locator(".task-detail__planner-field").filter({ has: page.locator("span", { hasText: /^流程模板$/u }) }).locator("select").selectOption(assets.workflow.id);
    await page.evaluate(() => {
      window.d07RealAssetEvents = [];
      window.codeflowDesktop.onEvent(value => { if (value.t === "orchestration.event") window.d07RealAssetEvents.push(value.event); });
    });
    phase = "real-provider"; report.realProviderExecutionRequested = true;
    await assertProviderCliUnchanged(selected.cli); await assertCodexVersionProbeUnchanged(selected.codex); await captureAssetProcesses(owner);
    await page.getByRole("button", { name: "立即执行", exact: true }).click();
    await expect.poll(async () => (await request("orch.instances.list", { workspaceId })).instances.length).toBe(1);
    const instanceId = (await request("orch.instances.list", { workspaceId })).instances[0].id;
    report.entities.instanceId = instanceId;
    let lastProcessObservation = 0;
    await support.waitUntil(async () => {
      if (Date.now() - lastProcessObservation >= 2_000) { await captureAssetProcesses(owner); lastProcessObservation = Date.now(); }
      const { instance } = await request("orch.instances.get", { workspaceId, instanceId });
      if (["failed", "cancelled", "paused"].includes(instance.status)) throw new Error(`${prefix}_INSTANCE_TERMINAL_FAILURE: ${instance.status} instanceId=${instanceId}`);
      if (Object.values(instance.nodeStates).some(node => ["failed", "waiting-feedback", "waiting-approval"].includes(node.status))) throw new Error(`${prefix}_NODE_FAILURE_OR_INTERACTION: instanceId=${instanceId}`);
      return instance.status === "completed";
    }, 240_000, `${prefix}_REAL_PROVIDER_TIMEOUT: instanceId=${instanceId}`);
    const { instance } = await request("orch.instances.get", { workspaceId, instanceId }), threadId = instance.nodeStates.verify.threadId;
    Object.assign(expected, { workspaceId, instanceId, threadId }); report.entities.threadId = threadId;
    await captureAssetProcesses(owner);
    assert.ok(owner.records.some(item => item.executable.toLowerCase() === selected.cli.command.toLowerCase()
      && (!selected.cli.argsPrefix.length || item.commandLine.toLowerCase().includes(selected.cli.entry.toLowerCase()))), `${prefix}_CLI_EXECUTION_UNOBSERVED`);
    if (selected.cli.nativeTarget) assert.ok(owner.records.some(item => item.executable.toLowerCase() === selected.cli.nativeTarget.toLowerCase()), `${prefix}_CLI_NATIVE_EXECUTION_UNOBSERVED`);
    await expect.poll(() => page.evaluate(id => window.d07RealAssetEvents.some(event => event.instanceId === id && event.type === "orchestration.completed"), instanceId)).toBe(true);
    await expect(page.locator('.task-detail__monitor .vue-flow__node[data-id="verify"] .wf-graph-node__status')).toHaveText("已完成");
    report.observedCompletion = true;
    const liveArtifacts = (await request("orch.artifacts.list", { workspaceId, instanceId, includeContent: true })).artifacts;
    report.liveArtifacts = liveArtifacts.map(item => ({ id: item.id, sha256: sha(item.contentJson) }));
    phase = "exit";
    await captureAssetProcesses(owner);
    await Promise.all([application.waitForEvent("close", { timeout: 40_000 }), page.evaluate(() => { void window.codeflowDesktop.exit(); })]);
    await support.waitUntil(async () => (await captureAssetProcesses(owner)).length === 0, 10_000, `${prefix}_PROCESSES_REMAIN`);
    assert.equal(child.exitCode, 0); application = undefined;
    phase = "physical-evidence";
    const evidence = await persistedEvidence(root, assets, expected); assertAssetEvidence(evidence);
    report.paidProviderExercised = true;
    assert.deepEqual(evidence.artifacts.map(item => ({ id: item.id, sha256: sha(item.contentJson) })).sort((a, b) => a.id.localeCompare(b.id)), report.liveArtifacts.sort((a, b) => a.id.localeCompare(b.id)));
    assert.deepEqual(report.rendererErrors, []);
    for (const [name, filename] of Object.entries(selected.files)) assert.equal(sha(await fs.readFile(filename)), selected.hashes[name], `${prefix}_FROZEN_INPUT_CHANGED: ${name}`);
    await assertProviderCliUnchanged(selected.cli); await assertCodexVersionProbeUnchanged(selected.codex);
    await verifyReleaseBundlePayload({ directory: selected.resources, manifest: selected.manifest,
      trustedKeys: assertTrustedReleaseKeys(JSON.parse(await readText(selected.files.trust))), platform: "win32", arch: "x64", requireHeldStartup: true });
    await fs.writeFile(path.join(root, "evidence.json"), safeEvidenceJson(evidence, [selected.provider.apiKey, selected.provider.baseUrl]), "utf8");
    report.counts = { canonical: evidence.canonical.length, raw: evidence.raw.length, turns: evidence.turns.length, prompts: evidence.prompts.length, artifacts: evidence.artifacts.length };
    report.completed = true;
  } catch (error) { hasError = true; operationError = error; }
  if (application) {
    if (report.entities?.instanceId && request) {
      try { assert.ok(owner, `${prefix}_PROCESS_ROOT_UNCONFIRMED`); await captureAssetProcesses(owner); await cancelUnfinishedInstance(request, { workspaceId: report.entities.workspaceId, instanceId: report.entities.instanceId }); }
      catch (error) { operationError = hasError ? new AggregateError([operationError, error], `${prefix}_RUN_AND_CANCEL_FAILED`) : error; hasError = true; }
    }
    try {
      assert.ok(owner, `${prefix}_PROCESS_ROOT_UNCONFIRMED`);
      const active = await captureAssetProcesses(owner);
      if (active.some(item => item.pid === owner.mainPid)) {
        const { bounded } = await import("./support/packaged-app.mjs");
        await bounded(Promise.all([application.waitForEvent("close", { timeout: 8_000 }),
          page ? page.evaluate(() => { void window.codeflowDesktop.exit(); }) : application.evaluate(({ app }) => app.quit())]), 8_000, `${prefix}_CLEANUP_EXIT_TIMEOUT`);
      }
    } catch (error) { operationError = hasError ? new AggregateError([operationError, error], `${prefix}_RUN_AND_EXIT_FAILED`) : error; hasError = true; }
    try { assert.ok(owner, `${prefix}_PROCESS_ROOT_UNCONFIRMED`); await stopAssetProcesses(owner); }
    catch (error) { operationError = hasError ? new AggregateError([operationError, error], `${prefix}_RUN_AND_CLEANUP_FAILED`) : error; hasError = true; }
  }
  if (owner) report.processes = owner.records.map(item => ({ pid: item.pid, parentPid: item.parentPid, created: item.created, executableSha256: sha(item.executable), commandLineSha256: sha(item.commandLine) }));
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  if (hasError) { report.completed = false; report.failure = safeFailure(operationError, [selected?.provider.apiKey, selected?.provider.baseUrl]); }
  report.phase = phase;
  if (root) {
    try { await fs.writeFile(path.join(root, "verification.json"), safeEvidenceJson(report, [selected?.provider.apiKey, selected?.provider.baseUrl]), "utf8"); }
    catch (error) {
      operationError = hasError ? new AggregateError([operationError, error], `${prefix}_RUN_AND_REPORT_FAILED`) : error;
      hasError = true; report.completed = false; report.failure = safeFailure(operationError, [selected?.provider.apiKey, selected?.provider.baseUrl]);
    }
  }
  if (hasError) { console.error(JSON.stringify(report)); process.exitCode = 1; }
  else console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runAssets(process.argv.slice(2));
