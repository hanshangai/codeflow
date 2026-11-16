import type { ApiResult, GetPublicContactInfoResponseBody, SiteContactInfo } from "@codeflowai/shared";

import { wsOriginToHttpOrigin, type ApiRequestContext } from "../api/request";

const PUBLIC_CONTACT_INFO_TIMEOUT_MS = 5_000;
const PUBLIC_CONTACT_INFO_PROBE_TIMEOUT_MS = 800;
let cachedPublicSiteContactInfo: SiteContactInfo | null = null;

export function createDefaultSiteContactInfo(): SiteContactInfo {
  return {
    phone: "",
    email: "codeflow@hanshangai.com",
    wechatContacts: ["codeflow@hanshangai.com"],
    wechatGroupQrImage: "",
    officialAccountQrImage: "",
    address: "",
  };
}

export function parseContactLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toContactLines(values: string[]): string {
  return values.join("\n");
}

function cloneSiteContactInfo(contactInfo: SiteContactInfo): SiteContactInfo {
  return {
    phone: typeof contactInfo.phone === "string" ? contactInfo.phone : "",
    email: typeof contactInfo.email === "string" ? contactInfo.email : "",
    wechatContacts: Array.isArray(contactInfo.wechatContacts) ? [...contactInfo.wechatContacts] : [],
    wechatGroupQrImage: typeof contactInfo.wechatGroupQrImage === "string" ? contactInfo.wechatGroupQrImage : "",
    officialAccountQrImage: typeof contactInfo.officialAccountQrImage === "string" ? contactInfo.officialAccountQrImage : "",
    address: typeof contactInfo.address === "string" ? contactInfo.address : "",
  };
}

export function getCachedPublicSiteContactInfo(): SiteContactInfo | null {
  return cachedPublicSiteContactInfo ? cloneSiteContactInfo(cachedPublicSiteContactInfo) : null;
}

export function setCachedPublicSiteContactInfo(contactInfo: SiteContactInfo): SiteContactInfo {
  const cloned = cloneSiteContactInfo(contactInfo);
  cachedPublicSiteContactInfo = cloned;
  return cloneSiteContactInfo(cloned);
}

type PublicContactInfoCandidate = {
  url: string;
  timeoutMs: number;
};

function buildPublicContactInfoCandidates(ctx: ApiRequestContext): PublicContactInfoCandidate[] {
  const candidates = new Map<string, PublicContactInfoCandidate>();
  const configuredBase = wsOriginToHttpOrigin(ctx.serverWsOrigin);

  function addCandidate(base: string, timeoutMs: number): void {
    const normalized = String(base ?? "").trim().replace(/\/$/, "");
    if (!normalized) return;
    const url = `${normalized}/api/public/contact-info`;
    if (candidates.has(url)) return;
    candidates.set(url, { url, timeoutMs });
  }

  addCandidate(configuredBase, PUBLIC_CONTACT_INFO_TIMEOUT_MS);

  // 页面同源只承载 HTTP 服务，桌面静态协议不能作为公共接口候选。
  if (typeof window !== "undefined" && ["http:", "https:"].includes(window.location.protocol)) {
    if (window.location.port === "39281") {
      addCandidate(`${window.location.protocol}//${window.location.hostname}:39280`, PUBLIC_CONTACT_INFO_TIMEOUT_MS);
      addCandidate(window.location.origin, PUBLIC_CONTACT_INFO_PROBE_TIMEOUT_MS);
    } else if (window.location.origin === configuredBase) {
      addCandidate(window.location.origin, PUBLIC_CONTACT_INFO_TIMEOUT_MS);
    } else {
      addCandidate(window.location.origin, PUBLIC_CONTACT_INFO_PROBE_TIMEOUT_MS);
    }
  }

  return [...candidates.values()];
}

async function requestPublicSiteContactInfo(url: string, timeoutMs: number): Promise<SiteContactInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("timeout"), timeoutMs);

  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (!response.ok) return null;

    const text = await response.text();
    const res = JSON.parse(text) as ApiResult<GetPublicContactInfoResponseBody>;
    if (!res.ok) return null;
    return res.contactInfo;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchPublicSiteContactInfo(ctx: ApiRequestContext): Promise<SiteContactInfo> {
  const candidates = buildPublicContactInfoCandidates(ctx);

  for (const { url, timeoutMs } of candidates) {
    const result = await requestPublicSiteContactInfo(url, timeoutMs);
    if (result) {
      return setCachedPublicSiteContactInfo(result);
    }
  }

  if (cachedPublicSiteContactInfo) {
    return cloneSiteContactInfo(cachedPublicSiteContactInfo);
  }
  return createDefaultSiteContactInfo();
}
