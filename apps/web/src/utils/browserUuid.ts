type BrowserCryptoSource = {
  randomUUID?: Crypto["randomUUID"];
  getRandomValues?: Crypto["getRandomValues"];
};

/** 使用 Web Crypto 生成 UUID；缺少安全随机能力时显式失败。 */
export function createBrowserUuid(
  source: BrowserCryptoSource | null = typeof globalThis.crypto === "object" ? globalThis.crypto : null,
): string {
  if (typeof source?.randomUUID === "function") return source.randomUUID();

  if (typeof source?.getRandomValues !== "function") {
    throw new Error("当前浏览器不支持安全的随机标识生成");
  }
  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
