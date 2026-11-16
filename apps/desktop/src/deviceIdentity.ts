import crypto from "node:crypto";
import type { Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export type DeviceIdentity = {
  deviceId: string;
  createdAt: string;
  publicKeyBase64: string;
};
type StoredIdentity = DeviceIdentity & { schemaVersion: 1; privateKeyBase64: string };

const IDENTITY_FILE_NAME = "device-identity.json";

/** 持久授权后捕获并删除精确旧身份；唯一捕获文件承载原字节供同授权重试。 */
export async function removeDesktopDeviceIdentity(dataDir: string, expectedDeviceId: string): Promise<void> {
  if (typeof dataDir !== "string" || !dataDir || dataDir !== dataDir.trim() || !path.isAbsolute(dataDir) || /[\x00-\x1f]/u.test(dataDir)
    || typeof expectedDeviceId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedDeviceId)) {
    throw new Error("DESKTOP_DEVICE_IDENTITY_REMOVE_INVALID");
  }
  const directory = path.resolve(dataDir), directories = await inspectIdentityRemovalDirectories(directory);
  const filePath = path.join(directory, IDENTITY_FILE_NAME), prefix = `${IDENTITY_FILE_NAME}.removing-${expectedDeviceId.toLowerCase()}-`;
  /** 授权缺失只指精确身份已删除，目录祖先仍须是原普通物理目录。 */
  const verifyDirectories = async (): Promise<void> => {
    const current = await inspectIdentityRemovalDirectories(directory);
    if (current.some((entry, index) => entry.dev !== directories[index]!.dev || entry.ino !== directories[index]!.ino)) {
      throw new Error("DESKTOP_DEVICE_IDENTITY_PATH_CHANGED");
    }
  };
  /** ENOENT 是同授权重试的合法缺失；其他文件系统错误保原因。 */
  const readEntry = async (target = filePath): Promise<Stats | null> => {
    try { return await fs.lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null; throw error; }
  };
  /** 只消费本授权的唯一规范捕获名；未知证据、多文件或标准名再现均保留失败。 */
  const readCapture = async (): Promise<string | null> => {
    const names = (await fs.readdir(directory)).filter(name => name.toLowerCase().startsWith(`${IDENTITY_FILE_NAME}.`));
    if (names.length > 1 || names.some(name => !name.startsWith(prefix) || !name.endsWith(".tmp")
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(name.slice(prefix.length, -4)))) {
      throw new Error("DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT");
    }
    return names.length ? path.join(directory, names[0]!) : null;
  };
  let capturePath = await readCapture();
  const standard = await readEntry();
  if (capturePath && standard) throw new Error("DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT");
  const source = capturePath ?? filePath, before = capturePath ? await readEntry(capturePath) : standard;
  if (!before) {
    await verifyDirectories();
    if (capturePath || await readEntry() || await readCapture()) throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    return;
  }
  if (!sameRemovalIdentityFile(before, before)) throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_INVALID");
  const file = await fs.open(source, "r");
  let failure: { cause: unknown } | undefined;
  try {
    if (!sameRemovalIdentityFile(before, await file.stat())) throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    const identity = await readIdentityFile(source, file);
    if (!identity || !("schemaVersion" in identity) || identity.deviceId !== expectedDeviceId) throw new Error("DESKTOP_DEVICE_IDENTITY_REMOVE_CONFLICT");
    if (!sameRemovalIdentityFile(before, await file.stat())) throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    await verifyDirectories();
    const current = await readEntry(source);
    if (!current || !sameRemovalIdentityFile(before, current)) throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    if (!capturePath) {
      if (await readCapture()) throw new Error("DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT");
      capturePath = path.join(directory, `${prefix}${crypto.randomUUID()}.tmp`);
      if (await readEntry(capturePath)) throw new Error("DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT");
      await fs.rename(filePath, capturePath);
    }
    await verifyDirectories();
    const captured = await readEntry(capturePath);
    if (!captured || !sameRemovalIdentityFile(before, captured, false) || !sameRemovalIdentityFile(captured, await file.stat())) {
      throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    }
    const capturedIdentity = await readIdentityFile(capturePath), capturedNow = await readEntry(capturePath);
    if (JSON.stringify(capturedIdentity) !== JSON.stringify(identity) || !capturedNow
      || !sameRemovalIdentityFile(captured, capturedNow) || !sameRemovalIdentityFile(captured, await file.stat())) {
      throw new Error("DESKTOP_DEVICE_IDENTITY_FILE_CHANGED");
    }
    if (await readEntry() || await readCapture() !== capturePath) throw new Error("DESKTOP_DEVICE_IDENTITY_CAPTURE_CONFLICT");
    // 同锁合法写者独占；只删除已捕获对象，标准身份路径始终不执行unlink。
    try { await fs.unlink(capturePath); }
    catch (error) { if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error; }
    await verifyDirectories();
    if (await readEntry(capturePath) || await readEntry() || await readCapture()) throw new Error("DESKTOP_DEVICE_IDENTITY_REMOVE_INCOMPLETE");
  } catch (cause) { failure = { cause }; throw cause; }
  finally {
    try { await file.close(); }
    catch (cause) {
      throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_DEVICE_IDENTITY_CLOSE_FAILED", { cause: failure.cause }) : cause;
    }
  }
}

/** 删除边界逐级核普通目录与真实物理身份，不导入已依赖身份的定位模块。 */
async function inspectIdentityRemovalDirectories(directory: string): Promise<Stats[]> {
  const entries: Stats[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    const entry = await fs.lstat(current), real = await fs.lstat(await fs.realpath(current));
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.dev !== real.dev || entry.ino !== real.ino) {
      throw new Error("DESKTOP_DEVICE_IDENTITY_PATH_INVALID");
    }
    entries.push(entry);
    if (path.dirname(current) === current) return entries;
  }
}

/** 同一单链文件的正文元数据不变；捕获rename可更新ctime，其余阶段严格核验。 */
function sameRemovalIdentityFile(before: Stats, after: Stats, compareChangeTime = true): boolean {
  return before.isFile() && after.isFile() && !before.isSymbolicLink() && !after.isSymbolicLink()
    && before.nlink === 1 && after.nlink === 1 && before.dev === after.dev && before.ino === after.ino
    && before.size === after.size && before.mtimeMs === after.mtimeMs && (!compareChangeTime || before.ctimeMs === after.ctimeMs);
}

/** 网络证明只读取现有签名身份，不创建、升级、修改权限或替换文件。 */
export async function readDeviceIdentity(dataDir: string): Promise<DeviceIdentity> {
  const identity = await readIdentityFile(path.join(path.resolve(dataDir), IDENTITY_FILE_NAME));
  if (!identity || !("schemaVersion" in identity)) throw new Error("DESKTOP_DEVICE_IDENTITY_MISSING");
  return publicIdentity(identity);
}

/** 普通首装拒绝遗留安装/回执事实；仅已授权重装接受固定next，不消费维护记录。 */
export async function loadOrCreateDeviceIdentity(dataDir: string, reinstall?: Pick<DeviceIdentity, "deviceId" | "createdAt">): Promise<DeviceIdentity> {
  const expected = reinstall === undefined ? undefined : readReinstallIdentity(reinstall);
  const directory = path.resolve(dataDir);
  const filePath = path.join(directory, IDENTITY_FILE_NAME);
  if (expected) {
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("DESKTOP_REINSTALL_STORAGE_MISSING");
  } else await fs.mkdir(directory, { recursive: true });
  const parsed = await readIdentityFile(filePath);
  if (parsed) {
    if (expected && (!("schemaVersion" in parsed) || parsed.deviceId !== expected.deviceId || parsed.createdAt !== expected.createdAt)) {
      throw new Error("DESKTOP_REINSTALL_IDENTITY_CONFLICT");
    }
    if (!("schemaVersion" in parsed)) {
      const upgraded = createSigningIdentity(parsed);
      await writeIdentity(filePath, upgraded);
      return publicIdentity(upgraded);
    }
    await fs.chmod(filePath, 0o600);
    return publicIdentity(parsed);
  }
  const entries = await fs.readdir(directory);
  const evidence = new Set(["codeflowai.db", "codeflowai.db.meta.json", "codeflowai.db-wal", "codeflowai.db-shm", "config.json",
    "active-release.json", "previous-release.json", "releases", ".staging", "errors.jsonl", "update-receipts.jsonl"]);
  if (entries.some(entry => entry.toLowerCase().startsWith(`${IDENTITY_FILE_NAME}.`))) throw new Error("DESKTOP_DEVICE_IDENTITY_MISSING");
  if (expected) {
    for (const name of ["config.json", "codeflowai.db", "codeflowai.db.meta.json"]) {
      if (!entries.includes(name)) throw new Error("DESKTOP_REINSTALL_STORAGE_MISSING");
      const entry = await fs.lstat(path.join(directory, name));
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error("DESKTOP_REINSTALL_STORAGE_MISSING");
    }
  } else if (entries.some(entry => evidence.has(entry) || entry.toLowerCase() === "update-receipts.jsonl")) throw new Error("DESKTOP_DEVICE_IDENTITY_MISSING");
  const identity = createSigningIdentity(expected ?? { deviceId: crypto.randomUUID(), createdAt: new Date().toISOString() });
  await writeIdentity(filePath, identity);
  return publicIdentity(identity);
}

/** 首个await前复制预定身份，拒绝未知字段、访问器及非规范时间。 */
function readReinstallIdentity(input: Pick<DeviceIdentity, "deviceId" | "createdAt">): Pick<DeviceIdentity, "deviceId" | "createdAt"> {
  if (!input || typeof input !== "object" || Reflect.ownKeys(input).length !== 2) throw new Error("DESKTOP_REINSTALL_IDENTITY_INVALID");
  const device = Object.getOwnPropertyDescriptor(input, "deviceId"), created = Object.getOwnPropertyDescriptor(input, "createdAt");
  if (!device || !("value" in device) || !created || !("value" in created)
    || typeof device.value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(device.value)
    || typeof created.value !== "string" || !Number.isFinite(Date.parse(created.value)) || new Date(created.value).toISOString() !== created.value) {
    throw new Error("DESKTOP_REINSTALL_IDENTITY_INVALID");
  }
  return { deviceId: device.value, createdAt: created.value };
}

/** 签名只使用已有安装身份，不在网络请求过程中生成或替换设备。 */
export async function signDevicePayload(dataDir: string, payload: Uint8Array): Promise<{ deviceId: string; publicKeyBase64: string; signature: string }> {
  const identity = await readIdentityFile(path.join(path.resolve(dataDir), IDENTITY_FILE_NAME));
  if (!identity || !("schemaVersion" in identity)) throw new Error("DESKTOP_DEVICE_IDENTITY_MISSING");
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(identity.privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return { deviceId: identity.deviceId, publicKeyBase64: identity.publicKeyBase64, signature: crypto.sign(null, payload, privateKey).toString("base64") };
}

/** 严格验证格式及公私钥配对；维护可沿已核句柄读取，解析失败仅返回脱敏错误。 */
async function readIdentityFile(filePath: string, file?: FileHandle): Promise<StoredIdentity | Pick<DeviceIdentity, "deviceId" | "createdAt"> | null> {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(file ? await file.readFile() : await fs.readFile(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
    const deviceId = typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : "";
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : "";
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)
      || deviceId !== parsed.deviceId || !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new Error("invalid identity");
    if (Object.keys(parsed).length === 2 && !Object.prototype.hasOwnProperty.call(parsed, "schemaVersion")) return { deviceId, createdAt };
    if (parsed.schemaVersion !== 1 || Object.keys(parsed).length !== 5
      || typeof parsed.publicKeyBase64 !== "string" || typeof parsed.privateKeyBase64 !== "string") throw new Error("invalid signing format");
    const privateBytes = Buffer.from(parsed.privateKeyBase64, "base64");
    const publicBytes = Buffer.from(parsed.publicKeyBase64, "base64");
    if (privateBytes.toString("base64") !== parsed.privateKeyBase64 || publicBytes.toString("base64") !== parsed.publicKeyBase64) throw new Error("invalid key encoding");
    const privateKey = crypto.createPrivateKey({ key: privateBytes, format: "der", type: "pkcs8" });
    const publicKey = crypto.createPublicKey(privateKey);
    if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.export({ format: "der", type: "spki" }).toString("base64") !== parsed.publicKeyBase64) {
      throw new Error("invalid key pair");
    }
    return { schemaVersion: 1, deviceId, createdAt, publicKeyBase64: parsed.publicKeyBase64, privateKeyBase64: parsed.privateKeyBase64 };
  } catch (error) {
    const cause = new Error(error instanceof SyntaxError ? "DESKTOP_DEVICE_IDENTITY_JSON_INVALID" : "DESKTOP_DEVICE_IDENTITY_FIELDS_INVALID");
    throw new Error(`设备身份文件无效：${filePath}`, { cause });
  }
}

/** 首装或未发版的旧格式升级生成密钥，安装 UUID 与创建时间保持原值。 */
function createSigningIdentity(identity: Pick<DeviceIdentity, "deviceId" | "createdAt">): StoredIdentity {
  const pair = crypto.generateKeyPairSync("ed25519");
  return { schemaVersion: 1, ...identity, publicKeyBase64: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyBase64: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
}

/** 调用方只获得公开身份，私钥不进入状态快照或日志。 */
function publicIdentity(identity: StoredIdentity): DeviceIdentity {
  return { deviceId: identity.deviceId, createdAt: identity.createdAt, publicKeyBase64: identity.publicKeyBase64 };
}

/** 临时文件同步后原子替换；落盘或清理失败均显式传递。 */
async function writeIdentity(filePath: string, identity: StoredIdentity): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(tempPath, "wx", 0o600);
  try {
    let failure: { cause: unknown } | undefined;
    try {
      await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
      await handle.sync();
    } catch (cause) { failure = { cause }; throw cause; }
    finally {
      try { await handle.close(); }
      catch (cause) { throw failure ? new AggregateError([failure.cause, cause], "DESKTOP_DEVICE_IDENTITY_CLOSE_FAILED") : cause; }
    }
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.rm(tempPath, { force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "DESKTOP_DEVICE_IDENTITY_WRITE_FAILED"); }
    throw error;
  }
}
