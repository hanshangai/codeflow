export type ReleaseBundleFile = { path: string; size: number; sha256: string };
export type ReleaseBundlePayload = {
  schemaVersion: 2;
  releaseId: string;
  version: string;
  webVersion: string;
  clientVersion: string;
  protocolVersion: 1;
  capabilityVersion: 1;
  dbSchemaVersion: number;
  platform: "win32" | "darwin";
  arch: "x64" | "arm64";
  webSha256: string;
  clientSha256: string;
  packageSha256: string;
  files: ReleaseBundleFile[];
  archiveSha256: string;
  archiveSize: number;
  createdAt: string;
  expiresAt: string;
  keyId: string;
};
export type ReleaseBundleManifest = ReleaseBundlePayload & { signature: string };

export type DesktopReleaseEnvironment = "production" | "test";
export const DESKTOP_RELEASE_PLATFORMS: readonly string[] = Object.freeze(["win32/x64", "darwin/x64", "darwin/arm64"]);

/** 环境必须显式有效；未配置时保持正式发布规则。 */
export function readDesktopReleaseEnvironment(value: unknown): DesktopReleaseEnvironment {
  if (value === undefined || value === "production") return "production";
  if (value === "test") return "test";
  throw new Error("DESKTOP_PUBLICATION_ENVIRONMENT_INVALID");
}

/** 测试只允许实际非空平台集合；正式发布仍要求完整三平台，Linux 不属于桌面平台。 */
export function assertDesktopReleasePlatforms(platforms: readonly string[], environment: DesktopReleaseEnvironment): void {
  environment = readDesktopReleaseEnvironment(environment);
  if (!Array.isArray(platforms) || !platforms.length || platforms.length > DESKTOP_RELEASE_PLATFORMS.length
    || Array.from(platforms).some(platform => !DESKTOP_RELEASE_PLATFORMS.includes(platform)) || new Set(platforms).size !== platforms.length) {
    throw new Error("DESKTOP_PUBLICATION_PLATFORMS_INVALID");
  }
  if (environment === "production" && platforms.length !== DESKTOP_RELEASE_PLATFORMS.length) throw new Error("DESKTOP_PUBLICATION_THREE_PLATFORMS_REQUIRED");
}

export const DESKTOP_STARTUP_CAPABILITY_PATH = "client/dist/desktop-startup-capability.json";
export type DesktopStartupCapability = { schemaVersion: 1; heldStartupProtocol: 1; clientEntrySha256: string };

/** 只声明当前 Client 工件的 held 协议与入口摘要，不授予运行期准入。 */
export function assertDesktopStartupCapability(input: unknown): DesktopStartupCapability {
  const fields = ["schemaVersion", "heldStartupProtocol", "clientEntrySha256"];
  if (!isRecord(input) || Reflect.ownKeys(input).length !== fields.length || Reflect.ownKeys(input).some(key => typeof key !== "string" || !fields.includes(key))) {
    throw new Error("DESKTOP_STARTUP_CAPABILITY_INVALID");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (fields.some(key => !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) throw new Error("DESKTOP_STARTUP_CAPABILITY_INVALID");
  const schemaVersion = descriptors.schemaVersion!.value, heldStartupProtocol = descriptors.heldStartupProtocol!.value;
  const clientEntrySha256 = descriptors.clientEntrySha256!.value;
  if (schemaVersion !== 1 || heldStartupProtocol !== 1 || typeof clientEntrySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(clientEntrySha256)) {
    throw new Error("DESKTOP_STARTUP_CAPABILITY_INVALID");
  }
  return { schemaVersion, heldStartupProtocol, clientEntrySha256 };
}

const PAYLOAD_FIELDS = ["schemaVersion", "releaseId", "version", "webVersion", "clientVersion", "protocolVersion", "capabilityVersion",
  "dbSchemaVersion", "platform", "arch", "webSha256", "clientSha256", "packageSha256", "files", "archiveSha256", "archiveSize", "createdAt", "expiresAt", "keyId"];

/** 版本目录只允许单个可移植路径段。 */
export function assertReleaseId(input: unknown): string {
  if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input) || /[. ]$/.test(input)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(input)) invalid("releaseId");
  return input;
}

/** 清单文件必须位于两种资源根内，禁止跨平台路径别名或设备名。 */
export function assertReleaseFilePath(input: unknown): string {
  if (typeof input !== "string" || !/^(web|client)\//.test(input) || /[\\\u0000-\u001f\u007f:*?"<>|]/.test(input)) invalid("files.path");
  for (const part of input.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) invalid("files.path");
  }
  return input;
}

/** 校验唯一 schema 2 签名清单；未知字段和不完整资源清单均显式失败。 */
export function assertReleaseBundleManifest(input: unknown): ReleaseBundleManifest {
  const payload = readPayload(input, true);
  const signature = (input as Record<string, unknown>).signature;
  if (typeof signature !== "string" || !/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(signature)) invalid("signature");
  return { ...payload, signature };
}

/** 签名和验签共用此固定字段顺序，signature 自身不进入 payload。 */
export function serializeReleaseBundlePayload(input: unknown): string {
  return JSON.stringify(readPayload(input, isRecord(input) && Object.hasOwn(input, "signature")));
}

/** 仅供签名方校验未签名输入；不接受第二套清单形状。 */
export function assertReleaseBundlePayload(input: unknown): ReleaseBundlePayload {
  return readPayload(input, false);
}

/** 逐字段构造独立快照，保持所有调用方的签名序列化口径一致。 */
function readPayload(input: unknown, signed: boolean): ReleaseBundlePayload {
  if (!isRecord(input)) invalid("必须是对象");
  const fields = signed ? [...PAYLOAD_FIELDS, "signature"] : PAYLOAD_FIELDS;
  for (const field of Object.keys(input)) if (!fields.includes(field)) invalid(field);
  if (input.schemaVersion !== 2) invalid("schemaVersion");
  if (input.protocolVersion !== 1) invalid("protocolVersion");
  if (input.capabilityVersion !== 1) invalid("capabilityVersion");
  if (input.platform !== "win32" && input.platform !== "darwin") invalid("platform");
  if (input.arch !== "x64" && !(input.platform === "darwin" && input.arch === "arm64")) invalid("arch");
  if (!Number.isSafeInteger(input.dbSchemaVersion) || (input.dbSchemaVersion as number) <= 0) invalid("dbSchemaVersion");
  if (!Number.isSafeInteger(input.archiveSize) || (input.archiveSize as number) <= 0) invalid("archiveSize");
  const createdAt = isoTime(input.createdAt, "createdAt");
  const expiresAt = isoTime(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalid("expiresAt");
  if (!Array.isArray(input.files) || !input.files.length) invalid("files");
  const paths = new Set<string>();
  let previous = "";
  const files = input.files.map((entry): ReleaseBundleFile => {
    if (!isRecord(entry) || Object.keys(entry).some(key => !["path", "size", "sha256"].includes(key))) invalid("files");
    const filePath = assertReleaseFilePath(entry.path);
    const folded = filePath.toLowerCase();
    if (filePath <= previous || paths.has(folded)) invalid("files.path");
    previous = filePath;
    paths.add(folded);
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) invalid("files.size");
    return { path: filePath, size: entry.size as number, sha256: digest(entry.sha256, "files.sha256") };
  });
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) if (paths.has(parts.slice(0, index).join("/"))) invalid("files.path");
  }
  if (!files.some(file => file.path === "web/index.html") || !files.some(file => file.path === "client/dist/index.cjs")) invalid("files.entries");
  return { schemaVersion: 2, releaseId: assertReleaseId(input.releaseId), version: text(input.version, "version"),
    webVersion: text(input.webVersion, "webVersion"), clientVersion: text(input.clientVersion, "clientVersion"),
    protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: input.dbSchemaVersion as number, platform: input.platform, arch: input.arch,
    webSha256: digest(input.webSha256, "webSha256"), clientSha256: digest(input.clientSha256, "clientSha256"), packageSha256: digest(input.packageSha256, "packageSha256"),
    files, archiveSha256: digest(input.archiveSha256, "archiveSha256"), archiveSize: input.archiveSize as number,
    createdAt, expiresAt, keyId: assertReleaseId(input.keyId) };
}

/** 只接受 JSON 普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
}

/** 不裁剪或转换签名字段，防止不同输入被静默归一化。 */
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) invalid(field);
  return value;
}

/** 摘要固定为小写 SHA-256。 */
function digest(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(`${field} SHA-256`);
  return result;
}

/** 时间固定为 UTC ISO 格式，避免多种等价文本进入签名。 */
function isoTime(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field);
  return result;
}

/** 错误只报告字段，不回显包内容。 */
function invalid(field: string): never { throw new Error(`完整绑定包清单无效：${field}`); }
