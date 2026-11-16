type GuidanceStorage = Pick<Storage, "getItem" | "setItem">;
export type DesktopMigrationEntry = {
  serverOrigin: string; userId: string; desktop: boolean; mobile: boolean; userAgent: string;
  to: string; from: string; now: Date;
};

/** 仅允许同源研发入口，保留原始查询与锚点，拒绝路径归一化绕过。 */
export function getDesktopMigrationRedirect(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020]/u.test(value)) return "/chat";
  const pathname = value.split(/[?#]/u, 1)[0]!;
  const url = new URL(value, "https://migration.invalid");
  if (url.pathname !== pathname || !isResearchPath(pathname)) return "/chat";
  return value;
}

/** 路径白名单与导航排除共用，研发区内切换不重新拦截。 */
function isResearchPath(path: string): boolean {
  const pathname = path.split(/[?#]/u, 1)[0];
  return pathname === "/chat" || pathname === "/knowledge" || pathname === "/orchestration" || pathname?.startsWith("/orchestration/") === true;
}

/** 账号与 Server 分开存储本地日期，避免浏览器时区与 UTC 日期错位。 */
function guidanceRecord(input: Pick<DesktopMigrationEntry, "serverOrigin" | "userId" | "now">) {
  const origin = new URL(input.serverOrigin);
  origin.protocol = origin.protocol === "wss:" ? "https:" : origin.protocol === "ws:" ? "http:" : origin.protocol;
  if (!["https:", "http:"].includes(origin.protocol) || !input.userId || !Number.isFinite(input.now.getTime())) throw new Error("迁移引导账号、服务地址或日期无效");
  const date = `${input.now.getFullYear()}-${String(input.now.getMonth() + 1).padStart(2, "0")}-${String(input.now.getDate()).padStart(2, "0")}`;
  return { key: `codeflow.desktop-migration.v1:${encodeURIComponent(origin.origin)}:${encodeURIComponent(input.userId)}`, date };
}

/** 只在电脑浏览器从研发区外进入时检查按日记录，存储故障交给调用边界显式处理。 */
export function shouldShowDesktopMigration(input: DesktopMigrationEntry, storage: Pick<GuidanceStorage, "getItem">): boolean {
  if (!input.userId || input.desktop || input.mobile || /Android|iPhone|iPad|Mobile|MicroMessenger|wxwork|DingTalk/iu.test(input.userAgent)
    || !isResearchPath(input.to) || isResearchPath(input.from) || input.from.split("?", 1)[0] === "/desktop-migration") return false;
  const record = guidanceRecord(input);
  return storage.getItem(record.key) !== record.date;
}

/** 成功记录后才进入引导，写入失败不得伪造当天已提示。 */
export function markDesktopMigrationShown(input: Pick<DesktopMigrationEntry, "serverOrigin" | "userId" | "now">, storage: GuidanceStorage): void {
  const record = guidanceRecord(input);
  storage.setItem(record.key, record.date);
}
