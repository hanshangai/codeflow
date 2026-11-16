/**
 * 「一次性机会」标记的读写工具：把默认会话自动创建与内置中转自动启用两条链路
 * 逐行重复的 localStorage 读写、标记键拼接与内存兜底收拢到一处。
 *
 * 标记键格式已发布到用户 localStorage，改动即等于给老用户多发一次机会，必须保持逐字不变。
 */

/** localStorage 不可用（隐私模式/配额）时用内存集合兜底，仍按“已消耗”处理，避免反复重试。 */
const attemptedMarkerKeys = new Set<string>();

/** 读取 localStorage；不可用（无 window、隐私模式、配额）时返回空串。 */
export function safeReadLocalStorage(key: string): string {
  try {
    return String(window.localStorage.getItem(key) ?? "").trim();
  } catch {
    return "";
  }
}

/** 写入 localStorage；失败时忽略，内存集合已记录消耗。 */
export function safeWriteLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 内存集合已记录消耗，此处忽略存储写入失败。
  }
}

/**
 * 生成一次性标记键：`prefix::分段1::分段2…`，各分段做 URI 编码。
 * prefix 为空、没有分段或任一分段为空时返回 null，避免写入无法归属的脏键。
 */
export function buildMarkerKey(prefix: string, parts: readonly string[]): string | null {
  const normalizedPrefix = String(prefix ?? "").trim();
  if (!normalizedPrefix || !parts.length) return null;
  const segments: string[] = [];
  for (const part of parts) {
    const value = String(part ?? "").trim();
    if (!value) return null;
    segments.push(encodeURIComponent(value));
  }
  return [normalizedPrefix, ...segments].join("::");
}

/** 读取一次性标记；内存集合用于存储不可用场景。key 为 null 时按“未消耗”处理。 */
export function hasOneShotMarker(key: string | null): boolean {
  if (!key) return false;
  return attemptedMarkerKeys.has(key) || safeReadLocalStorage(key) === "1";
}

/** 标记一次性机会已被消耗；写失败也必须视作已消耗，避免循环重试。 */
export function markOneShotMarker(key: string | null): void {
  if (!key) return;
  attemptedMarkerKeys.add(key);
  safeWriteLocalStorage(key, "1");
}

/** 清空内存消耗记录；不影响 localStorage。传入 prefix 时只清该前缀下的键。 */
export function clearOneShotMarkerCache(prefix?: string): void {
  const normalizedPrefix = String(prefix ?? "").trim();
  if (!normalizedPrefix) {
    attemptedMarkerKeys.clear();
    return;
  }
  const markerPrefix = `${normalizedPrefix}::`;
  for (const key of attemptedMarkerKeys) {
    if (key.startsWith(markerPrefix)) attemptedMarkerKeys.delete(key);
  }
}
