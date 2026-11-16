"use strict";

/** 将现有日期版本解析为数值段；保持公开构建与服务端发布使用同一口径。 */
function parseReleaseVersionParts(value, label = "Release version") {
  const normalized = String(value || "").trim();
  const match = /^(\d{4})\.(\d{2})\.(\d{2})\.(\d+)$/.exec(normalized);
  if (!match) throw new Error(`${label} does not match YYYY.MM.DD.NN: ${normalized || "<empty>"}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("RELEASE_VERSION_SEQUENCE_INVALID");
  return { normalized, parts };
}

/** 返回较新的版本基线；无已部署版本时保留本地版本。 */
function resolveReleaseVersionBaseline(localVersion, deployedVersion) {
  const local = parseReleaseVersionParts(localVersion, "Local package version");
  if (!String(deployedVersion || "").trim()) return local.normalized;
  const deployed = parseReleaseVersionParts(deployedVersion, "Deployed release version");
  for (let index = 0; index < local.parts.length; index += 1) {
    if (local.parts[index] === deployed.parts[index]) continue;
    return local.parts[index] > deployed.parts[index] ? local.normalized : deployed.normalized;
  }
  return local.normalized;
}

/** 分配当天序号；时钟倒退或非法输入直接抛出，由调用入口记录失败。 */
function computeNextReleaseVersion(currentVersion, now = new Date()) {
  const current = parseReleaseVersionParts(currentVersion, "Current release version");
  const prefix = formatDateVersionPrefix(now);
  if (current.normalized.slice(0, 10) !== prefix) {
    const next = `${prefix}.01`;
    if (resolveReleaseVersionBaseline(current.normalized, next) !== next) {
      throw new Error(`RELEASE_CLOCK_BEHIND: 按当前日期生成的版本 ${next} 不大于版本基线 ${current.normalized}，请检查执行机时间。`);
    }
    return next;
  }
  const sequence = current.parts[3] + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error("RELEASE_VERSION_SEQUENCE_INVALID");
  return `${prefix}.${String(sequence).padStart(Math.max(current.normalized.slice(11).length, 2), "0")}`;
}

/** 以构建机本地日期生成现有版本前缀，非法日期不得产生 NaN 版本。 */
function formatDateVersionPrefix(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("RELEASE_DATE_INVALID");
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join(".");
}

module.exports = { parseReleaseVersionParts, resolveReleaseVersionBaseline, computeNextReleaseVersion, formatDateVersionPrefix };
