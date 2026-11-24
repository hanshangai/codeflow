import crypto, { type KeyObject } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { assertReleaseBundleManifest, assertReleaseBundlePayload, assertReleaseFilePath, assertReleaseId, serializeReleaseBundlePayload,
  assertDesktopStartupCapability, DESKTOP_STARTUP_CAPABILITY_PATH,
  type ReleaseBundleFile, type ReleaseBundleManifest } from "./desktopReleaseContract.js";

export type TrustedReleaseKeys = Readonly<Record<string, string | KeyObject>>;

/** 只使用显式传入的 Ed25519 私钥；不读取环境、生成密钥或打印材料。 */
export function signReleaseBundleManifest(input: unknown, privateKey: string | Buffer | KeyObject): ReleaseBundleManifest {
  const payload = assertReleaseBundlePayload(input);
  const key = typeof privateKey === "object" && "type" in privateKey ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_INVALID");
  return { ...payload, signature: crypto.sign(null, Buffer.from(serializeReleaseBundlePayload(payload)), key).toString("base64") };
}

/** 验签只读显式信任根；可选平台与期限门禁供工件读取共用，旧纯验签调用不变。 */
export function verifyReleaseBundleSignature(input: unknown, trustedKeys: TrustedReleaseKeys,
  options?: { platform?: string; arch?: string; now?: () => number; requireFresh?: boolean }): ReleaseBundleManifest {
  const manifest = assertReleaseBundleManifest(input);
  if (!Object.hasOwn(trustedKeys, manifest.keyId)) throw new Error(`DESKTOP_RELEASE_UNTRUSTED_KEY: ${manifest.keyId}`);
  const configured = trustedKeys[manifest.keyId]!;
  const key = typeof configured === "string" ? crypto.createPublicKey(configured) : configured;
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("DESKTOP_RELEASE_PUBLIC_KEY_INVALID");
  if (!crypto.verify(null, Buffer.from(serializeReleaseBundlePayload(manifest)), key, Buffer.from(manifest.signature, "base64"))) {
    throw new Error(`DESKTOP_RELEASE_SIGNATURE_INVALID: ${manifest.releaseId}`);
  }
  if (options && (manifest.platform !== (options.platform ?? process.platform) || manifest.arch !== (options.arch ?? process.arch))) {
    throw new Error("DESKTOP_RELEASE_PLATFORM_MISMATCH");
  }
  if (options?.requireFresh && Date.parse(manifest.expiresAt) <= (options.now?.() ?? Date.now())) throw new Error("DESKTOP_RELEASE_EXPIRED");
  return manifest;
}

/** 默认核完整库存；运行时 installed 只核入口类型和 held 绑定，期限门禁独立生效。 */
export async function verifyReleaseBundlePayload(input: {
  directory: string; manifest: unknown; trustedKeys: TrustedReleaseKeys; platform?: string; arch?: string;
  now?: () => number; requireFresh?: boolean; requireHeldStartup?: boolean;
  verification?: "full" | "startup" | "installed";
}): Promise<ReleaseBundleManifest> {
  const manifest = verifyReleaseBundleSignature(input.manifest, input.trustedKeys, input);
  let startupEntry: string | undefined;
  if (input.requireHeldStartup) {
    const marker = manifest.files.find(file => file.path === DESKTOP_STARTUP_CAPABILITY_PATH);
    startupEntry = manifest.files.find(file => file.path === "client/dist/index.cjs")?.sha256;
    if (!marker || marker.size > 1024 || !startupEntry) throw new Error("DESKTOP_STARTUP_CAPABILITY_REQUIRED");
  }
  if (input.verification === "installed") {
    await verifyInstalledFiles(input.directory, manifest, startupEntry);
    return manifest;
  }
  if (input.verification === "startup" && !input.requireFresh) {
    await verifyStartupFiles(input.directory, manifest, startupEntry);
    return manifest;
  }
  const files = await readReleaseBundleFiles(input.directory, startupEntry);
  const webSha256 = computeReleaseDirectorySha256(files, "web"), clientSha256 = computeReleaseDirectorySha256(files, "client");
  if (webSha256 !== manifest.webSha256) throw new Error("Web payload SHA-256 不匹配");
  if (clientSha256 !== manifest.clientSha256) throw new Error("Client payload SHA-256 不匹配");
  if (computeReleasePackageSha256(webSha256, clientSha256) !== manifest.packageSha256) throw new Error("绑定包 SHA-256 不匹配");
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error("DESKTOP_RELEASE_FILES_MISMATCH");
  return manifest;
}

/** 仅 lstat 固定入口及清单声明的核心文件；不枚举目录、不读取入口或依赖正文。 */
async function verifyInstalledFiles(directory: string, manifest: ReleaseBundleManifest, heldStartupEntrySha256?: string): Promise<void> {
  const core = new Set(["client/dist/index.cjs", "web/index.html", ...manifest.files
    .filter(file => file.path.startsWith("client/dist/") || file.path.startsWith("client/") && file.path.split("/").length === 2)
    .map(file => file.path)]);
  const checkedDirectories = new Set<string>();
  for (const relative of core) {
    const parts = relative.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const ancestor = parts.slice(0, depth).join("/");
      if (checkedDirectories.has(ancestor)) continue;
      const stat = await fs.lstat(path.join(directory, ancestor));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${ancestor}`);
      checkedDirectories.add(ancestor);
    }
    const target = path.join(directory, relative), stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${relative}`);
    if (relative === DESKTOP_STARTUP_CAPABILITY_PATH && heldStartupEntrySha256 !== undefined) {
      const marker = manifest.files.find(file => file.path === relative)!;
      const content = await readStartupCapability(target, stat, heldStartupEntrySha256);
      if (content.length !== marker.size || crypto.createHash("sha256").update(content).digest("hex") !== marker.sha256) {
        throw new Error(`DESKTOP_RELEASE_STARTUP_FILE_MISMATCH: ${relative}`);
      }
    }
  }
}

/** 保留旧 startup 语义：枚举并核入口、worker、配置摘要及可选 held 能力。 */
async function verifyStartupFiles(directory: string, manifest: ReleaseBundleManifest, heldStartupEntrySha256?: string): Promise<void> {
  const checkedDirectories = new Set<string>();
  const core = manifest.files.filter(file => file.path.startsWith("client/dist/")
    || file.path.startsWith("client/") && file.path.split("/").length === 2 || file.path === "web/index.html");
  /** 只枚举核心目录，不扫描依赖；新增未签名 worker 或配置同样必须拒绝。 */
  const inspect = async (relative: string): Promise<void> => {
    const target = path.join(directory, relative), stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${relative}`);
    checkedDirectories.add(relative);
    const actual: string[] = [];
    for (const entry of await fs.readdir(target, { withFileTypes: true })) {
      const filePath = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (relative !== "client") await inspect(filePath);
      } else {
        if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${filePath}`);
        actual.push(filePath);
      }
    }
    const expected = core.filter(file => path.posix.dirname(file.path) === relative).map(file => file.path);
    if (JSON.stringify(actual.sort()) !== JSON.stringify(expected.sort())) throw new Error(`DESKTOP_RELEASE_STARTUP_FILES_MISMATCH: ${relative}`);
  };
  await inspect("client");
  await inspect("client/dist");
  for (const file of core) {
    const parts = file.path.split("/");
    for (let depth = 0; depth < parts.length; depth++) {
      const relative = parts.slice(0, depth).join("/");
      if (checkedDirectories.has(relative)) continue;
      const stat = await fs.lstat(path.join(directory, relative));
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${relative}`);
      checkedDirectories.add(relative);
    }
    const target = path.join(directory, file.path), stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${file.path}`);
    const content = heldStartupEntrySha256 !== undefined && file.path === DESKTOP_STARTUP_CAPABILITY_PATH
      ? await readStartupCapability(target, stat, heldStartupEntrySha256) : await fs.readFile(target);
    if (content.byteLength !== file.size || crypto.createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new Error(`DESKTOP_RELEASE_STARTUP_FILE_MISMATCH: ${file.path}`);
    }
  }
}

/** 安装资源中的信任文件是 keyId 到 PEM 公钥的映射，非法配置必须失败。 */
export function assertTrustedReleaseKeys(input: unknown): TrustedReleaseKeys {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("DESKTOP_RELEASE_TRUST_INVALID");
  const keys: Record<string, KeyObject> = Object.create(null);
  for (const [keyId, value] of Object.entries(input)) {
    assertReleaseId(keyId);
    if (typeof value !== "string" || !value.startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error("DESKTOP_RELEASE_TRUST_INVALID");
    const key = crypto.createPublicKey(value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new Error("DESKTOP_RELEASE_TRUST_INVALID");
    keys[keyId] = key;
  }
  return keys;
}

/** 枚举真实普通文件；held 校验将同份 marker 绑定指定的已签名入口摘要。 */
export async function readReleaseBundleFiles(directory: string, heldStartupEntrySha256?: string): Promise<ReleaseBundleFile[]> {
  const files: ReleaseBundleFile[] = [];
  /** 从固定资源根递归读取，不跟随链接。 */
  const visit = async (relative: string): Promise<void> => {
    if (relative.includes("/")) assertReleaseFilePath(relative);
    const target = path.join(directory, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(target)) await visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      const filePath = assertReleaseFilePath(relative);
      const content = heldStartupEntrySha256 !== undefined && filePath === DESKTOP_STARTUP_CAPABILITY_PATH
        ? await readStartupCapability(target, stat, heldStartupEntrySha256) : await fs.readFile(target);
      files.push({ path: filePath, size: content.byteLength, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    } else throw new Error(`DESKTOP_RELEASE_FILE_TYPE_INVALID: ${relative}`);
  };
  for (const root of ["client", "web"]) {
    if (!(await fs.lstat(path.join(directory, root))).isDirectory()) throw new Error(`DESKTOP_RELEASE_DIRECTORY_INVALID: ${root}`);
    await visit(root);
  }
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** 同一普通文件句柄限量读取 marker，短读、身份变化及 close 失败均不可放行。 */
async function readStartupCapability(target: string, before: Stats, clientEntrySha256: string): Promise<Buffer> {
  const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let failed = false, failure: unknown;
  try {
    const opened = await file.stat();
    if (!sameStartupFile(before, opened) || opened.size > 1024) throw new Error("DESKTOP_STARTUP_CAPABILITY_FILE_INVALID");
    const bytes = Buffer.alloc(1025);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - length) throw new Error("DESKTOP_STARTUP_CAPABILITY_FILE_INVALID");
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 1024 || length !== opened.size || !sameStartupFile(opened, await file.stat())
      || !sameStartupFile(opened, await fs.lstat(target))) throw new Error("DESKTOP_STARTUP_CAPABILITY_FILE_INVALID");
    const content = bytes.subarray(0, length);
    const capability = assertDesktopStartupCapability(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)));
    if (capability.clientEntrySha256 !== clientEntrySha256) throw new Error("DESKTOP_STARTUP_CAPABILITY_ENTRY_MISMATCH");
    return content;
  } catch (error) { failed = true; failure = error; throw error; }
  finally {
    try { await file.close(); }
    catch (error) { throw failed ? new AggregateError([failure, error], "DESKTOP_STARTUP_CAPABILITY_CLOSE_FAILED") : error; }
  }
}

/** 前后身份与长度一致；拒绝目录、链接及读取期间替换或改写。 */
function sameStartupFile(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** 延续原有相对路径加文件摘要的稳定目录组合算法。 */
export function computeReleaseDirectorySha256(files: readonly ReleaseBundleFile[], root: "client" | "web"): string {
  return crypto.createHash("sha256").update(files.filter(file => file.path.startsWith(`${root}/`))
    .map(file => `${file.path.slice(root.length + 1)}\0${file.sha256}\n`).join("")).digest("hex");
}

/** 整组摘要只组合两个资源摘要，避免清单与归档自引用。 */
export function computeReleasePackageSha256(webSha256: string, clientSha256: string): string {
  return crypto.createHash("sha256").update(`client\0${clientSha256}\nweb\0${webSha256}\n`).digest("hex");
}
