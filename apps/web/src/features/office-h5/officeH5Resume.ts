import type { AccountH5BootstrapResponse, OfficeH5BootstrapResponse } from "@codeflowai/shared";

let pendingBootstrap: { value: AccountH5BootstrapResponse; userId: string; expiresAt: number } | null = null;

/** 暂存刚完成的办公入口校验结果，供同一次 SPA 跳转复用。 */
export function stageOfficeH5BootstrapHandoff(value: OfficeH5BootstrapResponse): void {
  const userId = String(value.userSummary?.userId ?? "").trim();
  if (!userId) throw new Error("办公 H5 校验结果缺少用户标识");
  pendingBootstrap = {
    value: {
      status: value.status === "ready" ? "ready" : "forbidden",
      serverNow: value.serverNow,
      requestId: value.platformContext.requestId,
      userSummary: value.userSummary ?? null,
      accessContext: value.accessContext ?? null,
      entitlement: value.entitlement ?? null,
      reasonCode: value.status === "ready" ? null : "H5_FORBIDDEN",
      message: value.message ?? null,
      recoveryActions: value.recoveryActions,
    },
    userId,
    expiresAt: Date.now() + 30_000,
  };
}

/** 一次性读取仍在有效期内的办公入口校验结果。 */
export function consumeOfficeH5BootstrapHandoff(expectedUserId: string, now = Date.now()): AccountH5BootstrapResponse | null {
  const staged = pendingBootstrap;
  pendingBootstrap = null;
  return staged && staged.expiresAt > now && staged.userId === expectedUserId ? staged.value : null;
}
