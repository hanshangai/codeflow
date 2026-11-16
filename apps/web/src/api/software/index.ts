import type {
  ClientExitRequestBody,
  ClientExitResponseBody,
  ClientLatestResponse,
  GetSoftwareUpdateStatusRequestBody,
  GetSoftwareUpdateStatusResponseBody,
  NpmInstallRequestBody,
  NpmInstallResponseBody,
} from "@codeflowai/shared";

import { requestJson, wsOriginToHttpOrigin, type ApiRequestContext } from "../request";

export type ClientPackageTarget = { platform?: string | null; arch?: string | null };
export type ClientUpgradeResponseBody = {
  upgraded?: boolean;
  upgradeStarted?: boolean;
  upgradeId?: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  targetVersion?: string | null;
  message?: string;
  error?: string;
  requiresPrivilege?: boolean;
};

export type ClientUpgradeStatusResponseBody = {
  upgradeId: string;
  phase: "pending" | "success" | "failed";
  targetVersion: string;
  workspaceId: string | null;
  message: string | null;
  payload?: ClientUpgradeResponseBody | null;
  updatedAt: number;
};

/** 查询各引擎的安装/版本/npm 最新版本。 */
export function getSoftwareUpdateStatus(ctx: ApiRequestContext, body: GetSoftwareUpdateStatusRequestBody = {}, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<GetSoftwareUpdateStatusResponseBody>(ctx, { method: "POST", path: `/api/software/update-status${qs}`, body });
}

/** npm install -g 安装/更新指定包。 */
export function npmInstall(ctx: ApiRequestContext, body: NpmInstallRequestBody, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<NpmInstallResponseBody>(ctx, { method: "POST", path: `/api/software/npm-install${qs}`, body });
}

/** 查询最新 client 安装包版本（无需鉴权）。 */
export async function getClientLatest(ctx: ApiRequestContext, target?: ClientPackageTarget | null): Promise<ClientLatestResponse> {
  const httpBase = wsOriginToHttpOrigin(ctx.serverWsOrigin);
  try {
    const res = await fetch(`${httpBase}/api/client/latest${buildClientPackageQuery(target)}`);
    const data = (await res.json()) as ClientLatestResponse;
    if (data.ok && !clientLatestMatchesTarget(data, target)) {
      return { ok: false, message: `未找到匹配当前平台的 Client 安装包：${clientPackageTargetKey(target)}` };
    }
    return data;
  } catch {
    return { ok: false, message: "请求失败" };
  }
}

/** 构造 client latest 查询串，缺少平台或架构时交给后端回退通用包。 */
export function buildClientPackageQuery(target?: ClientPackageTarget | null): string {
  const platform = String(target?.platform ?? "").trim();
  const arch = String(target?.arch ?? "").trim();
  if (!platform || !arch) return "";
  const params = new URLSearchParams({ platform, arch });
  return `?${params.toString()}`;
}

/** 生成平台包 key；目标不完整时返回 null。 */
export function clientPackageTargetKey(target?: ClientPackageTarget | null): string | null {
  const platform = String(target?.platform ?? "").trim().toLowerCase();
  const arch = String(target?.arch ?? "").trim().toLowerCase();
  return platform && arch ? `${platform}-${arch}` : null;
}

/** 全依赖通用包适用于所有已支持目标；旧平台包仍检查平台匹配。 */
export function clientLatestMatchesTarget(
  latest: ClientLatestResponse,
  target?: ClientPackageTarget | null,
): boolean {
  const key = clientPackageTargetKey(target);
  if (!latest.ok || !key || latest.platformKey == null) return true;
  return latest.platformKey === key;
}

/** 所有平台共用一个下载入口；架构由安装脚本在目标机器识别。 */
export function clientLatestDownloadPath(_target?: ClientPackageTarget | null): string {
  return "/downloads/codeflowai-latest.tgz";
}

/** Resolve the browser system to a supported client package target. */
export function resolveBrowserClientPackageTarget(): ClientPackageTarget | null {
  if (typeof navigator === "undefined") return null;
  const uaDataPlatform = String((navigator as any).userAgentData?.platform ?? "");
  const source = `${uaDataPlatform} ${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (source.includes("win")) return { platform: "win32", arch: "x64" };
  return null;
}

/** 一键升级 client：server 查找最新 tgz → RPC 让 client npm install → 重启。 */
export function upgradeClient(ctx: ApiRequestContext, workspaceId?: string) {
  const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return requestJson<ClientUpgradeResponseBody>(
    ctx, { method: "POST", path: `/api/client/upgrade${qs}`, body: {} },
  );
}

/** 查询已转异步的 client 升级状态。 */
export function getClientUpgradeStatus(ctx: ApiRequestContext, upgradeId: string) {
  return requestJson<ClientUpgradeStatusResponseBody>(
    ctx,
    { method: "GET", path: `/api/client/upgrade-status?upgradeId=${encodeURIComponent(upgradeId)}` },
  );
}

/** 按 clientId 退出指定客户端实例。 */
export function exitClient(ctx: ApiRequestContext, body: ClientExitRequestBody) {
  return requestJson<ClientExitResponseBody>(
    ctx,
    { method: "POST", path: "/api/client/exit", body },
  );
}

