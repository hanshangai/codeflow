import { assertReleaseId } from "./desktopReleaseContract.js";

export const SHELL_RELEASE_PROTOCOL = "codeflow-desktop-shell-v1";
export type ShellReleaseFile = { path: string; size: number; sha256: string };
export type ShellReleasePayload = {
  schemaVersion: 1;
  protocol: typeof SHELL_RELEASE_PROTOCOL;
  shellId: string;
  version: string;
  platform: "win32";
  arch: "x64";
  installerSha256: string;
  installerSize: number;
  files: ShellReleaseFile[];
  createdAt: string;
  expiresAt: string;
  keyId: string;
};
export type ShellReleaseManifest = ShellReleasePayload & { signature: string };

const PAYLOAD_FIELDS = ["schemaVersion", "protocol", "shellId", "version", "platform", "arch", "installerSha256",
  "installerSize", "files", "createdAt", "expiresAt", "keyId"];

/** 壳库存使用可移植相对路径，拒绝 Windows 别名、越界和设备名。 */
export function assertShellReleaseFilePath(value: unknown): string {
  if (typeof value !== "string" || /[\\\u0000-\u001f\u007f-\u009f:*?"<>|]/.test(value)) invalid("files.path");
  for (const part of value.split("/")) {
    if (!part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) invalid("files.path");
  }
  return value;
}

/** 未签名输入只能使用独立壳合同，返回不共享调用方对象的快照。 */
export function assertShellReleasePayload(value: unknown): ShellReleasePayload {
  return readPayload(value, false);
}

/** 签名固定为规范 64 字节 Base64，不接受额外字段或访问器。 */
export function assertShellReleaseManifest(value: unknown): ShellReleaseManifest {
  const payload = readPayload(value, true);
  return { ...payload, signature: readSignature(value as Record<string, unknown>) };
}

/** protocol 与固定字段顺序共同确定签名字节，signature 自身不参与签名。 */
export function serializeShellReleasePayload(value: unknown): string {
  const signed = Boolean(value && typeof value === "object" && Object.hasOwn(value, "signature"));
  const payload = readPayload(value, signed);
  if (signed) readSignature(value as Record<string, unknown>);
  return JSON.stringify(payload);
}

/** 验证字段与完整库存后逐字段复制，避免隐式归一化或执行输入访问器。 */
function readPayload(value: unknown, signed: boolean): ShellReleasePayload {
  const input = exactRecord(value, signed ? [...PAYLOAD_FIELDS, "signature"] : PAYLOAD_FIELDS, "");
  if (input.schemaVersion !== 1) invalid("schemaVersion");
  if (input.protocol !== SHELL_RELEASE_PROTOCOL) invalid("protocol");
  if (input.platform !== "win32") invalid("platform");
  if (input.arch !== "x64") invalid("arch");
  const shellId = identifier(input.shellId, "shellId");
  if (shellId.length > 128) invalid("shellId");
  if (!Number.isSafeInteger(input.installerSize) || (input.installerSize as number) <= 0) invalid("installerSize");
  const createdAt = isoTime(input.createdAt, "createdAt");
  const expiresAt = isoTime(input.expiresAt, "expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) invalid("expiresAt");
  const files = readFiles(input.files);
  return { schemaVersion: 1, protocol: SHELL_RELEASE_PROTOCOL, shellId, version: text(input.version, "version"),
    platform: "win32", arch: "x64", installerSha256: digest(input.installerSha256, "installerSha256"),
    installerSize: input.installerSize as number, files, createdAt, expiresAt, keyId: identifier(input.keyId, "keyId") };
}

/** 数组与文件条目均须为自有数据字段，每级目录也保持唯一大小写拼写。 */
function readFiles(value: unknown): ShellReleaseFile[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !value.length
    || Reflect.ownKeys(value).length !== value.length + 1) invalid("files");
  const files: ShellReleaseFile[] = [];
  const paths = new Set<string>();
  const spellings = new Map<string, string>();
  let previous = "";
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) invalid("files");
    const entry = exactRecord(descriptor.value, ["path", "size", "sha256"], "files.");
    const filePath = assertShellReleaseFilePath(entry.path);
    const folded = filePath.toLowerCase();
    if (filePath <= previous || paths.has(folded)) invalid("files.path");
    previous = filePath;
    paths.add(folded);
    const parts = filePath.split("/");
    for (let count = 1; count <= parts.length; count += 1) {
      const prefix = parts.slice(0, count).join("/");
      const existing = spellings.get(prefix.toLowerCase());
      if (existing !== undefined && existing !== prefix) invalid("files.path");
      spellings.set(prefix.toLowerCase(), prefix);
    }
    if (!Number.isSafeInteger(entry.size) || (entry.size as number) < 0) invalid("files.size");
    files.push({ path: filePath, size: entry.size as number, sha256: digest(entry.sha256, "files.sha256") });
  }
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let count = 1; count < parts.length; count += 1) {
      if (paths.has(parts.slice(0, count).join("/"))) invalid("files.path");
    }
  }
  for (const required of ["CodeFlowAI.exe", "resources/app.asar", "resources/release-trust.json"]) {
    if (!files.some(file => file.path === required)) invalid("files.entries");
  }
  return files;
}

/** 仅接受普通或空原型对象，所有必需字段必须是自有数据属性。 */
function exactRecord(value: unknown, fields: readonly string[], prefix: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${prefix}object`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !fields.includes(key)) invalid(`${prefix}${key === "signature" ? "signature" : "fields"}`);
  }
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) invalid(`${prefix}${field}`);
  }
  return value as Record<string, unknown>;
}

/** 复用现有单段发布 ID 规则，并将错误定位到壳合同字段。 */
function identifier(value: unknown, field: string): string {
  try { return assertReleaseId(value); }
  catch (cause) { return invalid(field, cause); }
}

/** 签名文本不裁剪，拒绝会产生隐式归一化的字符串。 */
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) invalid(field);
  return value;
}

/** 摘要必须是规范小写 SHA-256。 */
function digest(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/.test(result)) invalid(field);
  return result;
}

/** 时间只接受标准 UTC ISO 文本，完整性入口不判断当前下载有效期。 */
function isoTime(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) invalid(field);
  return result;
}

/** 末尾有效位受约束，排除可解码但非规范的 Base64 别名。 */
function readSignature(input: Record<string, unknown>): string {
  if (typeof input.signature !== "string" || !/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(input.signature)) invalid("signature");
  return input.signature;
}

/** 对外仅暴露错误码和字段，原始原因保留于内存 cause。 */
function invalid(field: string, cause?: unknown): never {
  const code = "DESKTOP_SHELL_RELEASE_PAYLOAD_INVALID";
  throw Object.assign(new Error(`${code}: ${field}`, cause === undefined ? undefined : { cause }), { code, field });
}
