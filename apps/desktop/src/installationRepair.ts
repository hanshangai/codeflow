import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertDesktopStoragePath, readDesktopJsonFile } from "./desktopStorageLocation.js";
import { acquireShellUpdateFileOwner, coordinateShellUpdateFile, type ShellUpdateFileRequest } from "./shellUpdateFileCoordinator.js";

type RepairInput = { installationDir: string; userDataDir: string; requestId: string };
export type InstallationRepairResult = { outcome: "no-attempt" | "superseded"; archive?: string; sha256?: string };

/** 新壳确认旧执行者退出后接管记录；原始字节归档，不伪造更新终态。 */
export async function supersedeDesktopInstallationAttempt(input: RepairInput): Promise<InstallationRepairResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(input.requestId)) throw new Error("DESKTOP_INSTALL_REQUEST_INVALID");
  const installationDir = path.resolve(input.installationDir), userDataDir = path.resolve(input.userDataDir);
  await assertDesktopStoragePath(installationDir); await assertDesktopStoragePath(userDataDir);
  const locator = await readDesktopJsonFile(path.join(userDataDir, "desktop-data-location.json"));
  let dataDir = path.join(userDataDir, "runtime");
  if (locator !== null) {
    const value = locator as Record<string, unknown>;
    if (value.appId !== "ai.codeflow.codeflowai" || typeof value.installRoot !== "string" || typeof value.dataDir !== "string"
      || !path.isAbsolute(value.installRoot) || !path.isAbsolute(value.dataDir)
      || path.relative(installationDir.toLowerCase(), path.resolve(value.installRoot).toLowerCase()) !== "") {
      throw new Error("DESKTOP_INSTALL_LOCATION_CONFLICT");
    }
    dataDir = path.resolve(value.dataDir);
  }
  await assertDesktopStoragePath(dataDir);
  const target = path.join(dataDir, "shell-update-attempt.json");
  try { await fs.lstat(target); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "no-attempt" }; throw cause; }
  const root = await fs.realpath(dataDir), identity = await fs.lstat(root, { bigint: true });
  const bound = { root, dev: identity.dev.toString(), ino: identity.ino.toString() };
  const logDirectory = path.join(root, "logs");
  const request: ShellUpdateFileRequest = { kind: "retire", expected: { installationRequestId: input.requestId }, facts: { installationRequestId: input.requestId } };
  /** 维护归档仍由原物理 owner 执行；拒绝接收其他进程的写入请求。 */
  async function execute(operation: ShellUpdateFileRequest): Promise<InstallationRepairResult> {
    if (JSON.stringify(operation) !== JSON.stringify(request)) throw new Error("DESKTOP_INSTALL_MAINTENANCE_BUSY");
    await assertDesktopStoragePath(target);
    const before = await fs.lstat(target, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) throw new Error("DESKTOP_INSTALL_ATTEMPT_FILE_INVALID");
    const bytes = await fs.readFile(target);
    const after = await fs.lstat(target, { bigint: true }), currentRoot = await fs.lstat(root, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || currentRoot.dev !== identity.dev || currentRoot.ino !== identity.ino) throw new Error("DESKTOP_INSTALL_ATTEMPT_CHANGED");
    await assertDesktopStoragePath(logDirectory);
    try { await fs.mkdir(logDirectory); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; }
    await assertDesktopStoragePath(logDirectory);
    const logStat = await fs.lstat(logDirectory);
    if (!logStat.isDirectory() || logStat.isSymbolicLink()) throw new Error("DESKTOP_INSTALL_LOG_DIRECTORY_INVALID");
    const archive = `shell-update-retired-install-${input.requestId}-${crypto.randomUUID()}.json`;
    // 固定请求的归档不可覆盖，失败和断电后原始证据仍可追踪。
    try { await fs.lstat(path.join(logDirectory, archive)); throw new Error("DESKTOP_INSTALL_ARCHIVE_EXISTS"); }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    await fs.rename(target, path.join(logDirectory, archive));
    return { outcome: "superseded", archive, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }
  const owner = await acquireShellUpdateFileOwner(bound, execute, 60_000);
  let failed: { cause: unknown } | undefined;
  try { return await coordinateShellUpdateFile(bound, request, execute); }
  catch (cause) { failed = { cause }; throw cause; }
  finally {
    try { await owner.release(); }
    catch (cause) { throw failed ? new AggregateError([failed.cause, cause], "DESKTOP_INSTALL_OWNER_RELEASE_FAILED") : cause; }
  }
}
