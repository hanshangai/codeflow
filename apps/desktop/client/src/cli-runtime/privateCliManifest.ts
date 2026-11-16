/** 私有 CLI 目前支持的两个引擎标识，同时作为清单与运行目录的键。 */
export type PrivateCliEngine = "claude" | "codex";

/** 清单中单个引擎的安装信息，版本必须是精确 semver，体积用于估算磁盘占用。 */
export type PrivateCliManifestEntry = {
  npmPackage: string;
  version: string;
  estimatedBytes: number;
};

/** 随桌面端打包的私有 CLI 清单；两个引擎都必须存在，且不允许额外字段。 */
export type PrivateCliManifest = {
  schemaVersion: 1;
  npm: { version: string };
  engines: Record<PrivateCliEngine, PrivateCliManifestEntry>;
};

/** 后续解析器使用的运行时配置视图；本任务只定义类型，不实现读取器。 */
export type PrivateCliRuntimeConfig = {
  root: string;
  npmCliPath: string;
  manifestPath: string;
  manifest: PrivateCliManifest;
};

/** 清单解析失败时的稳定错误码，调用方据此区分非法清单与文件系统故障。 */
export const PRIVATE_CLI_MANIFEST_INVALID = "PRIVATE_CLI_MANIFEST_INVALID";

/** 每个引擎绑定的唯一 npm 包，避免清单把包名与引擎错配。 */
const ENGINE_NPM_PACKAGES: Record<PrivateCliEngine, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

/** 返回指定引擎允许的 npm 包名，供清单与运行时记录共同校验。 */
export function privateCliNpmPackage(engine: PrivateCliEngine): string {
  return ENGINE_NPM_PACKAGES[engine];
}

/** 只接受带数字段的精确 semver（可含预发布/构建元数据），拒绝 latest、范围和标签。 */
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** 统一构造带 code 的清单错误，调用方不依赖错误 message 判断类型。 */
function invalidManifest(message: string, cause?: unknown): Error {
  return Object.assign(
    new Error(`${PRIVATE_CLI_MANIFEST_INVALID}: ${message}`, cause === undefined ? undefined : { cause }),
    { code: PRIVATE_CLI_MANIFEST_INVALID },
  );
}

/** 严格判断字符串是否为精确 semver，供清单及运行时记录复用。 */
export function isExactSemver(value: unknown): value is string {
  return typeof value === "string" && SEMVER_PATTERN.test(value);
}

/**
 * 按白名单读取普通对象：拒绝数组、类实例、Symbol 键、多余/缺失键和访问器属性，
 * 保证解析过程不触发 getter 副作用，且字段集合与清单格式完全一致。
 */
function readStrictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidManifest(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidManifest(`${label} must be a plain object`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== "string")) {
    throw invalidManifest(`${label} must not contain symbol keys`);
  }
  const names = ownKeys as string[];
  if (names.length !== keys.length || keys.some(key => !names.includes(key))) {
    throw invalidManifest(`${label} has unexpected or missing keys`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidManifest(`${label}.${key} must be a data property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

/** 校验单个引擎条目：包名必须与引擎绑定、版本精确、体积为正整数。 */
function parseManifestEntry(value: unknown, engine: PrivateCliEngine): PrivateCliManifestEntry {
  const record = readStrictRecord(value, ["npmPackage", "version", "estimatedBytes"], `engines.${engine}`);
  const { npmPackage, version, estimatedBytes } = record;
  if (npmPackage !== ENGINE_NPM_PACKAGES[engine]) {
    throw invalidManifest(`engines.${engine}.npmPackage is not the expected package`);
  }
  if (!isExactSemver(version)) {
    throw invalidManifest(`engines.${engine}.version must be an exact semver version`);
  }
  if (typeof estimatedBytes !== "number" || !Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw invalidManifest(`engines.${engine}.estimatedBytes must be a positive integer`);
  }
  return { npmPackage, version, estimatedBytes };
}

/**
 * 严格解析私有 CLI 清单。输入非法时抛出 PRIVATE_CLI_MANIFEST_INVALID，
 * 不猜测缺省值，也不回退到系统 CLI 或远端版本。
 */
export function parsePrivateCliManifest(value: unknown): PrivateCliManifest {
  const record = readStrictRecord(value, ["schemaVersion", "npm", "engines"], "manifest");
  if (record.schemaVersion !== 1) {
    throw invalidManifest("schemaVersion must be 1");
  }
  const npm = readStrictRecord(record.npm, ["version"], "npm");
  if (!isExactSemver(npm.version)) {
    throw invalidManifest("npm.version must be an exact semver version");
  }
  const engines = readStrictRecord(record.engines, ["claude", "codex"], "engines");
  return {
    schemaVersion: 1,
    npm: { version: npm.version },
    engines: {
      claude: parseManifestEntry(engines.claude, "claude"),
      codex: parseManifestEntry(engines.codex, "codex"),
    },
  };
}
