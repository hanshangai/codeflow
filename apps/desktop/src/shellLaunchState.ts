import { constants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { assertReleaseId } from "@codeflowai/shared";

export type ShellLaunchState = { activeShellId: string; previousShellId: string | null; baselineShellId: string };
export type ShellLaunchRestoreOriginal = { originalState: ShellLaunchState; candidateState: ShellLaunchState; admission: null };
type LaunchErrorCode = "DESKTOP_SHELL_LAUNCH_STATE_INVALID" | "DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID";
const STATE_FILE = "shell-launch.ini";
const FIELDS = ["activeShellId", "previousShellId", "baselineShellId"] as const;
const MAX_STATE_BYTES = Buffer.byteLength("[shell]\r\nschema=1\r\nactive=\r\nprevious=\r\nbaseline=\r\n", "ascii") + 3 * 128;

/** 将三个精确选择序列化为唯一 ASCII、无 BOM、CRLF 格式，不写文件。 */
export function serializeShellLaunchState(input: unknown): string {
  const state = readState(input);
  return `[shell]\r\nschema=1\r\nactive=${state.activeShellId}\r\nprevious=${state.previousShellId ?? ""}\r\nbaseline=${state.baselineShellId}\r\n`;
}

/** 严格解析原字节，不修正编码、顺序、字段或换行。 */
export function parseShellLaunchState(bytes: Uint8Array): ShellLaunchState {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_STATE_BYTES || bytes.some(byte => byte > 0x7f)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
  const text = Buffer.from(bytes).toString("ascii");
  const match = /^\[shell\]\r\nschema=1\r\nactive=([A-Za-z0-9._-]{1,128})\r\nprevious=([A-Za-z0-9._-]{0,128})\r\nbaseline=([A-Za-z0-9._-]{1,128})\r\n$/.exec(text);
  if (!match || match[0] !== text) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
  return readState({ activeShellId: match[1], previousShellId: match[2] || null, baselineShellId: match[3] });
}

/** 读取真实INI及最低布局；显式无准入恢复只核完整S0，签名和owner仍由调用边界负责。 */
export async function readShellLaunchState(installationDir: string, options?: { restoreOriginal: unknown }): Promise<{ state: ShellLaunchState; executablePath: string; initialReleaseDir: string }> {
  try {
    const restore = options === undefined ? undefined : readRestoreOriginal(dataValues(options, ["restoreOriginal"])[0]);
    const root = await fs.realpath(installationDir);
    const statePath = path.join(root, STATE_FILE);
    const before = await assertEntry(root, [STATE_FILE]);
    const file = await fs.open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let failure: { cause: unknown } | undefined;
    let state: ShellLaunchState;
    try {
      const opened = await file.stat();
      if (!sameFile(before, opened)) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
      if (opened.size > MAX_STATE_BYTES) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
      state = parseShellLaunchState(await readStateBytes(file));
      if (!sameFile(opened, await assertEntry(root, [STATE_FILE]))) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    } catch (error) { failure = { cause: error }; throw error; }
    finally {
      try { await file.close(); }
      catch (error) { throw failure ? new AggregateError([failure.cause, error], "DESKTOP_SHELL_LAUNCH_STATE_CLOSE_FAILED") : error; }
    }
    if (restore && !sameState(state, restore.originalState) && !sameState(state, restore.candidateState)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    await assertLayout(root, restore?.originalState ?? state);
    return { state, executablePath: path.join(root, "shells", state.activeShellId, "CodeFlowAI.exe"),
      initialReleaseDir: path.join(root, "shells", state.baselineShellId, "resources") };
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && (cause.code === "DESKTOP_SHELL_LAUNCH_STATE_INVALID" || cause.code === "DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID")) throw cause;
    fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID", cause);
  }
}

/** 单owner按预期原子替换INI；恢复选项仅允许完整S1→S0，不提供跨进程CAS或进程交接。 */
export async function replaceShellLaunchState(input: { installationDir: string; expectedState: unknown; nextState: unknown; restoreOriginal?: unknown }): Promise<Awaited<ReturnType<typeof readShellLaunchState>>> {
  let phase = "input", stateReplaced = false;
  let root: string | undefined, rootIdentity: Stats | undefined, observedState: ShellLaunchState | undefined;
  let temporary: { path: string; identity?: Stats; closed: boolean } | undefined;
  try {
    const expected = readState(input.expectedState), next = readState(input.nextState);
    const descriptor = Object.getOwnPropertyDescriptor(input, "restoreOriginal");
    if (descriptor && !Object.hasOwn(descriptor, "value")) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    const restore = descriptor ? readRestoreOriginal(descriptor.value) : undefined;
    if (expected.baselineShellId !== next.baselineShellId || sameState(expected, next)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    if (restore && (!sameState(expected, restore.candidateState) || !sameState(next, restore.originalState))) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    const options = restore ? { restoreOriginal: restore } : undefined;
    const bytes = Buffer.from(serializeShellLaunchState(next), "ascii");
    phase = "read-current";
    root = await fs.realpath(input.installationDir);
    rootIdentity = await assertEntry(root, []);
    const current = await readShellLaunchState(root, options);
    observedState = { ...current.state };
    if (!sameState(current.state, expected)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    phase = "validate-next";
    await assertLayout(root, next);
    phase = "create-temp";
    await assertRootIdentity(root, rootIdentity);
    const temporaryPath = path.join(root, `${STATE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const file = await fs.open(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    temporary = { path: temporaryPath, closed: false };
    let writeFailure: { error: unknown; phase: string } | undefined, written: Stats | undefined;
    try {
      temporary.identity = await file.stat();
      if (!sameOwnedFile(temporary.identity, temporary.identity)) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
      phase = "write-temp";
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.length - offset) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
        offset += bytesWritten;
      }
      phase = "sync-temp";
      await file.sync();
      phase = "verify-temp";
      written = await file.stat();
      if (!sameOwnedFile(temporary.identity, written) || written.size !== bytes.length
        || !(await readStateBytes(file)).equals(bytes) || !sameTemporaryFile(written, await file.stat())) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    } catch (error) { writeFailure = { error, phase }; }
    try { await file.close(); temporary.closed = true; }
    catch (error) {
      phase = writeFailure?.phase ?? "close-temp";
      throw writeFailure ? new AggregateError([writeFailure.error, error], "DESKTOP_SHELL_LAUNCH_TEMP_CLOSE_FAILED") : error;
    }
    if (writeFailure) { phase = writeFailure.phase; throw writeFailure.error; }
    phase = "verify-temp";
    if (!written || !sameTemporaryFile(written, await assertEntry(root, [path.basename(temporaryPath)]))) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    phase = "check-expected";
    await assertRootIdentity(root, rootIdentity);
    const confirmed = await readShellLaunchState(root, options);
    observedState = { ...confirmed.state };
    if (!sameState(confirmed.state, expected)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    await assertLayout(root, next);
    phase = "replace";
    await assertRootIdentity(root, rootIdentity);
    if (!sameTemporaryFile(written, await assertEntry(root, [path.basename(temporaryPath)]))) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    await fs.rename(temporaryPath, path.join(root, STATE_FILE));
    stateReplaced = true; temporary = undefined; observedState = undefined;
    phase = "verify-replaced";
    await assertRootIdentity(root, rootIdentity);
    const result = await readShellLaunchState(root);
    observedState = { ...result.state };
    if (!sameState(result.state, next)) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    return result;
  } catch (cause) {
    let failure = cause;
    if (temporary) {
      try {
        if (!temporary.closed || !temporary.identity || !root || !rootIdentity) throw new Error("DESKTOP_SHELL_LAUNCH_TEMP_CLEANUP_UNSAFE");
        await assertRootIdentity(root, rootIdentity);
        const current = await assertEntry(root, [path.basename(temporary.path)]);
        if (!sameOwnedFile(temporary.identity, current)) throw new Error("DESKTOP_SHELL_LAUNCH_TEMP_CLEANUP_UNSAFE");
        await fs.unlink(temporary.path);
      } catch (cleanup) { failure = new AggregateError([cause, cleanup], "DESKTOP_SHELL_LAUNCH_TEMP_CLEANUP_FAILED"); }
    }
    const code = "DESKTOP_SHELL_LAUNCH_STATE_REPLACE_FAILED";
    throw Object.assign(new Error(code, { cause: failure }), { code, phase, stateReplaced,
      ...(observedState ? { observedState: { ...observedState } } : {}) });
  }
}

/** 版本布局必须命中唯一活动壳；只有旧安装或开发布局不参与壳状态解析。 */
export async function resolveVersionedShellStartup(executablePath: string): Promise<Awaited<ReturnType<typeof readShellLaunchState>> | null> {
  const shellDirectory = path.dirname(executablePath);
  const shellsDirectory = path.dirname(shellDirectory);
  const executable = path.basename(executablePath);
  const matches = (actual: string, expected: string): boolean => process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  if (!matches(executable, "CodeFlowAI.exe") || !matches(path.basename(shellsDirectory), "shells")) return null;
  const shellId = readId(path.basename(shellDirectory));
  const startup = await readShellLaunchState(path.dirname(shellsDirectory));
  const selectedExecutable = path.join(path.dirname(path.dirname(startup.executablePath)), shellId, executable);
  if (path.relative(startup.executablePath, selectedExecutable) !== "") fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
  return startup;
}

/** 未知字段、访问器和继承值均不参与启动选择。 */
function readState(input: unknown): ShellLaunchState {
  const values = dataValues(input, FIELDS);
  return { activeShellId: readId(values[0]), previousShellId: values[1] === null ? null : readId(values[1]), baselineShellId: readId(values[2]) };
}

/** 恢复范围只接受完整S0/S1与明确null准入，首个await前复制且不求值访问器。 */
function readRestoreOriginal(input: unknown): ShellLaunchRestoreOriginal {
  const [originalInput, candidateInput, admission] = dataValues(input, ["originalState", "candidateState", "admission"]);
  const originalState = readState(originalInput), candidateState = readState(candidateInput);
  if (admission !== null || candidateState.activeShellId === originalState.activeShellId
    || candidateState.previousShellId !== originalState.activeShellId || candidateState.baselineShellId !== originalState.baselineShellId) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
  return { originalState, candidateState, admission: null };
}

/** 精确自有数据字段共用同一边界，拒绝额外键、继承值和访问器。 */
function dataValues(input: unknown, fields: readonly string[]): unknown[] {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) {
    fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
  }
  return fields.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    return descriptor.value;
  });
}

/** 沿 shared 可移植 ID 规则，加上固定启动器的 128 字符上限。 */
function readId(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 128) fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID");
    return assertReleaseId(value);
  } catch { fail("DESKTOP_SHELL_LAUNCH_STATE_INVALID"); }
}

/** 所有状态读取共用最多 435 字节的短读循环，不对临时文件放宽容量。 */
async function readStateBytes(file: FileHandle): Promise<Buffer> {
  const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
  let length = 0;
  while (length < bytes.byteLength) {
    const { bytesRead } = await file.read(bytes, length, bytes.byteLength - length, length);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.byteLength - length) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return bytes.subarray(0, length);
}

/** 当前与候选选择使用同一最低布局，不代替完整库存或签名健康检查。 */
async function assertLayout(root: string, state: ShellLaunchState): Promise<void> {
  for (const id of new Set([state.activeShellId, state.previousShellId, state.baselineShellId])) {
    if (id !== null) await assertEntry(root, ["shells", id, "CodeFlowAI.exe"]);
  }
  for (const entry of [["web", "index.html"], ["client", "dist", "index.cjs"], ["release-trust.json"]]) {
    await assertEntry(root, ["shells", state.baselineShellId, "resources", ...entry]);
  }
}

/** 只比较复制后的三个数据字段，恢复时不会丢失原 previous。 */
function sameState(left: ShellLaunchState, right: ShellLaunchState): boolean {
  return FIELDS.every(field => left[field] === right[field]);
}

/** 写入和清理前安装根必须仍是已解析的普通目录，不重新解析替换后的别名。 */
async function assertRootIdentity(root: string, expected: Stats): Promise<void> {
  const current = await assertEntry(root, []);
  if (current.dev !== expected.dev || current.ino !== expected.ino) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
}

/** 本次独占临时 inode 不允许链接共享；部分自写内容不影响失败清理的所有权判断。 */
function sameOwnedFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && !right.isSymbolicLink() && left.nlink === 1 && right.nlink === 1
    && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

/** 成功写入后元数据和单链接身份都必须保持，防止关闭后发布被替换的临时路径。 */
function sameTemporaryFile(left: Stats, right: Stats): boolean {
  return sameOwnedFile(left, right) && sameFile(left, right) && left.ctimeMs === right.ctimeMs;
}

/** 从已解析根逐段 lstat，根内任何链接或错误类型都拒绝。 */
async function assertEntry(root: string, segments: string[]): Promise<Stats> {
  let current = root;
  let stat = await fs.lstat(current);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (index < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      fail("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID");
    }
  }
  return stat;
}

/** 状态读取前后必须仍是同一普通文件，不把路径替换当作成功。 */
function sameFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/** 固定错误不回显INI；显式undefined根因仍保留，日志由实际启动owner负责。 */
function fail(code: LaunchErrorCode, ...cause: [] | [unknown]): never {
  throw Object.assign(new Error(code, cause.length ? { cause: cause[0] } : undefined), { code });
}
