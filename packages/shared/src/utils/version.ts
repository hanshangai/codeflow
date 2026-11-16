type ParsedNumericVersion = {
  coreParts: number[];
  prerelease: string | null;
};

/**
 * 解析 3 段及以上的数字版本号，例如：
 * - 1.2.3
 * - 2026.03.30.01
 * - 2026.03.30.01-beta.1
 */
function parseNumericVersion(value: string): ParsedNumericVersion | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const [core, prerelease] = raw.split("-", 2);
  const partStrings = String(core ?? "").split(".");
  if (partStrings.length < 3) return null;
  if (partStrings.some((part) => !/^\d+$/.test(part))) return null;

  return {
    coreParts: partStrings.map((part) => Number(part)),
    prerelease: prerelease ?? null,
  };
}

/**
 * 比较 3 段及以上的数字版本号。
 * - 数字段逐段比较，缺失段按 0 处理
 * - 无 prerelease 高于有 prerelease
 */
export function compareNumericVersion(a: string, b: string): number {
  const pa = parseNumericVersion(a);
  const pb = parseNumericVersion(b);

  if (!pa && !pb) return String(a).localeCompare(String(b));
  if (!pa) return -1;
  if (!pb) return 1;

  const len = Math.max(pa.coreParts.length, pb.coreParts.length);
  for (let i = 0; i < len; i += 1) {
    const av = pa.coreParts[i] ?? 0;
    const bv = pb.coreParts[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }

  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0;
}
