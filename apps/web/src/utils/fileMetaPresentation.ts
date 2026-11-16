/** 文件元信息展示口径：文件大小与修改时间，供文件列表与 Git 变更列表共用，避免第二套格式化规则。 */

/** 将字节数格式化为 B/KB/MB 标签；非法或缺失返回空串。 */
export function formatFileSizeLabel(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size)) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 将 ISO 时间格式化为适合窄侧栏的短标签：今天 HH:mm，今年 MM-DD，跨年 YY-MM-DD；非法或缺失返回空串。 */
export function formatMtimeLabel(mtime: string | null | undefined, now: Date = new Date()): string {
  const date = parseMtime(mtime);
  return date ? formatCompactMtime(date, now) : "";
}

/** 将 ISO 时间格式化为完整本地时间，用于 hover 提示；非法或缺失返回空串。 */
export function formatMtimeTitle(mtime: string | null | undefined): string {
  const date = parseMtime(mtime);
  return date ? formatFullMtime(date) : "";
}

/** 解析 ISO 时间；非法输入返回 null。 */
function parseMtime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 判断两个时间是否处于同一个本地日期。 */
function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/** 按今天/今年/跨年切换修改时间精度。 */
function formatCompactMtime(date: Date, now: Date): string {
  if (isSameLocalDay(date, now)) return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  if (date.getFullYear() === now.getFullYear()) return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${String(date.getFullYear()).slice(-2)}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 格式化完整本地时间。 */
function formatFullMtime(date: Date): string {
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(" ");
}

/** 补齐两位数字。 */
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
