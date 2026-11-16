import { DEFAULT_RELAY_USD_TO_CNY_RATE } from "@codeflowai/shared";

const RELAY_USD_UNIT_SCALE = 100_000_000n;
const RELAY_EXCHANGE_RATE_SCALE = 10_000n;
const RELAY_EXCHANGE_RATE_SCALED = BigInt(Math.round(DEFAULT_RELAY_USD_TO_CNY_RATE * Number(RELAY_EXCHANGE_RATE_SCALE)));

/** 严格解析服务端十进制整数 units，非法值直接失败。 */
export function parseRelayUsdUnits(value: string): bigint {
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/u.test(text)) throw new Error("Token 额度数据格式不正确");
  return BigInt(text);
}

/** 将最多八位小数的 USD 输入精确转换为整数 units。 */
export function relayUsdTextToUnits(value: string): bigint {
  const text = String(value ?? "").trim();
  const matched = /^(\d+)(?:\.(\d{1,8}))?$/u.exec(text);
  if (!matched) throw new Error("请输入最多八位小数的正 USD 额度");
  const integerPart = BigInt(matched[1] ?? "0");
  const fractionUnits = BigInt((matched[2] ?? "").padEnd(8, "0") || "0");
  const units = integerPart * RELAY_USD_UNIT_SCALE + fractionUnits;
  if (units <= 0n) throw new Error("调整金额必须大于 0");
  return units;
}

/** 将最多两位小数的人民币输入按固定汇率转换为内部精确 USD units。 */
export function relayYuanTextToUsdUnits(value: string): bigint {
  const text = String(value ?? "").trim();
  const matched = /^(\d+)(?:\.(\d{1,2}))?$/u.exec(text);
  if (!matched) throw new Error("请输入最多两位小数的人民币额度");
  const yuanFen = BigInt(matched[1] ?? "0") * 100n + BigInt((matched[2] ?? "").padEnd(2, "0") || "0");
  if (yuanFen <= 0n) throw new Error("调整金额必须大于 0");
  const denominator = 100n * RELAY_EXCHANGE_RATE_SCALED;
  return (
    yuanFen * RELAY_USD_UNIT_SCALE * RELAY_EXCHANGE_RATE_SCALE + denominator / 2n
  ) / denominator;
}

/** 将精确 USD units 格式化为最多八位小数的 USD 文本。 */
export function formatRelayUsdUnitsAsUsd(value: string | bigint): string {
  const units = typeof value === "bigint" ? value : parseRelayUsdUnits(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const integer = absolute / RELAY_USD_UNIT_SCALE;
  const fraction = String(absolute % RELAY_USD_UNIT_SCALE).padStart(8, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}US$${integer.toLocaleString("zh-CN")}${fraction ? `.${fraction}` : ".00"}`;
}

/** 将精确 USD units 按 shared 固定汇率四舍五入为人民币分展示。 */
export function formatRelayUsdUnitsAsYuan(value: string | bigint): string {
  const units = typeof value === "bigint" ? value : parseRelayUsdUnits(value);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const denominator = RELAY_USD_UNIT_SCALE * RELAY_EXCHANGE_RATE_SCALE;
  const roundedCents = (
    absolute * RELAY_EXCHANGE_RATE_SCALED * 100n + denominator / 2n
  ) / denominator;
  const yuan = roundedCents / 100n;
  const cents = String(roundedCents % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}￥${yuan.toLocaleString("zh-CN")}.${cents}`;
}
