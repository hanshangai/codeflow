import type { OfficeH5LoginOption, OfficePlatform } from "@codeflowai/shared";

export type OfficeH5CorpIdResolution = {
  corpId: string;
  source: "route" | "login-options";
};

/** 优先使用路由里的 corpId；缺失时只在当前平台恰好一个可用登录入口时回填。 */
export function resolveOfficeH5CorpId(input: {
  routeCorpId?: string | null;
  platform: OfficePlatform;
  loginOptions: readonly OfficeH5LoginOption[];
}): OfficeH5CorpIdResolution | null {
  const routeCorpId = String(input.routeCorpId ?? "").trim();
  if (routeCorpId) return { corpId: routeCorpId, source: "route" };
  const availableOptions = input.loginOptions.filter((item) => item.platform === input.platform && item.available && item.corpId);
  if (availableOptions.length !== 1) return null;
  const availableOption = availableOptions[0];
  if (!availableOption?.corpId) return null;
  return { corpId: availableOption.corpId, source: "login-options" };
}
